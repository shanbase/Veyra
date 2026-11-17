import { apiFetch, getNativeSessionToken, isNativeVeyraApp } from "@/lib/nativeSession";

// Voice calls: PCM16 16 kHz mono, 20 ms frames (640 bytes) over
// /api/calls/ws. The server mixes all speakers and returns one stream per
// listener. Signalling (invite/accept/decline/end) travels separately over
// Supabase Realtime 'call-signal' events — see CallProvider.

export const CALL_FRAME_SAMPLES = 320;
export const CALL_SAMPLE_RATE = 16000;

export type CallParticipant = { userId: string; name: string; avatarUrl?: string; muted: boolean };

export type CallSignal = {
  type:
    | "call.invite"
    | "call.accepted"
    | "call.declined"
    | "call.active"
    | "call.ended";
  callId: string;
  conversationId: string;
  title?: string;
  from?: { id: string; username?: string; display_name?: string };
  userId?: string;
  reason?: string;
};

export type CallInfo = {
  callId: string;
  conversationId: string;
  title: string;
  state: "ringing" | "active";
};

type SessionEvents = {
  onPeerJoin?: (userId: string, name: string, avatarUrl?: string) => void;
  onPeerLeave?: (userId: string) => void;
  onPeerMute?: (userId: string, muted: boolean) => void;
  onParticipants?: (participants: CallParticipant[]) => void;
  onEnded?: (reason: string) => void;
  onError?: (message: string) => void;
  onMicDenied?: () => void;
};

// When VITE_CALL_SERVER_URL points at the dedicated call server (e.g. the
// Altare veyra-calls app), REST calls go there cross-origin with a 60 s HMAC
// ticket minted by the main API. Without it, calls stay on the same-origin
// embedded endpoints (session cookie / native Bearer token).
const CALL_API_BASE = String(import.meta.env.VITE_CALL_SERVER_URL || "").replace(/\/+$/, "");

let ticketCache: { token: string; expiresAt: number } | null = null;

async function getCallTicket() {
  if (ticketCache && ticketCache.expiresAt > Date.now() + 5000) return ticketCache.token;
  const response = await apiFetch("/api/calls/ticket", { method: "POST" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ticket) {
    throw new Error(body.error || "Voice calls are not available on this server.");
  }
  ticketCache = { token: body.ticket, expiresAt: Date.now() + 45_000 };
  return body.ticket as string;
}

async function callApi(path: string, init: RequestInit = {}) {
  if (!CALL_API_BASE) {
    const response = await apiFetch(`/api/calls${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Call request failed (${response.status}).`);
    return body;
  }
  const ticket = await getCallTicket();
  const response = await fetch(`${CALL_API_BASE}/api/calls${path}`, {
    ...init,
    credentials: "omit",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ticket}`,
      ...(init.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) ticketCache = null; // ticket expired mid-flight — refetch next time
  if (!response.ok) throw new Error(body.error || `Call request failed (${response.status}).`);
  return body;
}

export function startCall(conversationId: string) {
  return callApi("/start", { method: "POST", body: JSON.stringify({ conversation_id: conversationId }) }) as Promise<{
    callId: string; conversationId: string; state: string; title?: string; existing?: boolean;
  }>;
}

export function acceptCall(callId: string) {
  return callApi(`/${callId}/accept`, { method: "POST" }) as Promise<{ ok: boolean; callId: string; conversationId: string; title?: string }>;
}

export function declineCall(callId: string) {
  return callApi(`/${callId}/decline`, { method: "POST" }).catch(() => ({}));
}

export function endCall(callId: string) {
  return callApi(`/${callId}/end`, { method: "POST" }).catch(() => ({}));
}

export function callState(conversationId: string) {
  return callApi(`/state?conversation_id=${encodeURIComponent(conversationId)}`) as Promise<{
    call?: { callId: string; conversationId: string; state: string; title?: string; participants?: CallParticipant[] } | null;
  }>;
}

async function wsUrl() {
  if (CALL_API_BASE) {
    // Remote call server: wss(s)://<call-host>/api/calls/ws?ticket=<ticket>
    const ticket = await getCallTicket();
    const url = new URL(CALL_API_BASE);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/calls/ws";
    url.search = `ticket=${encodeURIComponent(ticket)}`;
    return url.toString();
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${proto}//${window.location.host}/api/calls/ws`;
  // Native apps authenticate API calls with a Bearer token, not cookies —
  // pass it as a query param for the WS handshake.
  if (isNativeVeyraApp()) {
    return getNativeSessionToken().then((token) => (token ? `${base}?token=${encodeURIComponent(token)}` : base));
  }
  return Promise.resolve(base);
}

export class CallSession {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private nextPlayTime = 0;
  private muted = false;      // effective mute sent to the server/others
  private userMuted = false;  // the user's own mute toggle
  private deafened = false;   // deafen = self-mute + local playback mute
  private closed = false;
  private micDenied = false;
  readonly callId: string;
  readonly conversationId: string;
  participants: CallParticipant[] = [];

  constructor(callId: string, conversationId: string, private events: SessionEvents = {}) {
    this.callId = callId;
    this.conversationId = conversationId;
  }

  get isMuted() { return this.muted; }
  get isUserMuted() { return this.userMuted; }
  get isDeafened() { return this.deafened; }
  get isOpen() { return !this.closed && this.ws?.readyState === WebSocket.OPEN; }
  get hasMic() { return !this.micDenied; }

  async start(): Promise<void> {
    const url = await wsUrl();
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        this.handleSignal(JSON.parse(event.data));
      } else {
        this.playFrame(event.data as ArrayBuffer);
      }
    };
    this.ws.onclose = () => {
      if (!this.closed) this.events.onEnded?.("disconnected");
      this.cleanup();
    };
    this.ws.onerror = () => this.events.onError?.("Connection to the call server failed.");

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to the call.")), 10000);
      const ws = this.ws!;
      const onOpen = () => { clearTimeout(timer); ws.removeEventListener("error", onFail); ws.removeEventListener("close", onFail); resolve(); };
      const onFail = () => { clearTimeout(timer); ws.removeEventListener("open", onOpen); reject(new Error("Could not connect to the call server.")); };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onFail, { once: true });
      ws.addEventListener("close", onFail, { once: true });
    });

    // AudioContext is created up-front for PLAYBACK even when the mic fails —
    // mic-less users must still hear the call. It starts 'suspended' under
    // autoplay policy; playFrame() keeps retrying resume() until it runs.
    this.audioCtx = new AudioContext();
    void this.audioCtx.resume().catch(() => {});

    // Mic is optional: users without one (or who deny permission) still join
    // and hear the call — the server simply receives no frames from them.
    await this.startMic().catch(() => {
      this.micDenied = true;
      this.events.onMicDenied?.();
    });
    this.ws.send(JSON.stringify({ type: "join", callId: this.callId }));
  }

  private scriptProcessor: ScriptProcessorNode | null = null;

  private async startMic() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone API unavailable.");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        // Chrome/Edge expose stronger RNNoise-based processing through the
        // non-standard goog* constraints — ignored harmlessly elsewhere.
        googEchoCancellation: true,
        googNoiseSuppression: true,
        googAutoGainControl: true,
        googHighpassFilter: true,
        googTypingNoiseDetection: true,
      } as MediaTrackConstraints,
      video: false,
    });
    const source = this.audioCtx!.createMediaStreamSource(this.stream);

    let workletReady = false;
    if (this.audioCtx.audioWorklet) {
      try {
        await this.audioCtx.audioWorklet.addModule("/call-capture-worklet.js");
        workletReady = true;
      } catch {
        // Worklet failed to load — fall through to the ScriptProcessor path
        // instead of giving up on the mic entirely.
      }
    }
    if (workletReady) {
      this.worklet = new AudioWorkletNode(this.audioCtx!, "call-capture");
      this.worklet.port.onmessage = (event) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.muted) {
          this.ws.send(event.data as ArrayBuffer);
        }
      };
      source.connect(this.worklet);
      // The worklet only feeds the socket — never connect it to destination or
      // the user hears their own mic back.
      return;
    }

    // Fallback for WebViews without AudioWorklet: ScriptProcessorNode is
    // deprecated but universally supported. It must stay connected to pull
    // audio, so route it through a zero-gain node to avoid feedback.
    const step = this.audioCtx.sampleRate / CALL_SAMPLE_RATE;
    const pending: number[] = [];
    const out = new Float32Array(CALL_FRAME_SAMPLES);
    let outPos = 0;
    let outLen = 0;
    const processor = this.audioCtx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i++) pending.push(input[i]);
      while (outPos + step <= pending.length) {
        const i0 = Math.floor(outPos);
        const frac = outPos - i0;
        const a = pending[i0];
        const b = pending[i0 + 1] || a;
        out[outLen++] = a + (b - a) * frac;
        outPos += step;
        if (outLen === CALL_FRAME_SAMPLES) {
          outLen = 0;
          this.sendPcmChunk(out);
        }
      }
      const consumed = Math.floor(outPos);
      if (consumed > 0) {
        pending.splice(0, consumed);
        outPos -= consumed;
      }
      if (pending.length > this.audioCtx!.sampleRate) pending.splice(0, pending.length - this.audioCtx!.sampleRate);
    };
    const muteGain = this.audioCtx.createGain();
    muteGain.gain.value = 0;
    source.connect(processor);
    processor.connect(muteGain);
    muteGain.connect(this.audioCtx.destination);
    this.scriptProcessor = processor;
  }

  private sendPcmChunk(samples: Float32Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.muted) return;
    const pcm = new Int16Array(CALL_FRAME_SAMPLES);
    for (let i = 0; i < CALL_FRAME_SAMPLES; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.ws.send(pcm.buffer);
  }

  private handleSignal(msg: Record<string, unknown>) {
    switch (msg.type) {
      case "welcome":
        this.participants = (msg.participants as CallParticipant[]) || [];
        this.events.onParticipants?.(this.participants);
        break;
      case "peer-joined":
        this.events.onPeerJoin?.(String(msg.userId), String(msg.name || ""), String(msg.avatarUrl || ""));
        break;
      case "peer-left":
        this.events.onPeerLeave?.(String(msg.userId));
        break;
      case "muted":
        this.events.onPeerMute?.(String(msg.userId), Boolean(msg.muted));
        break;
      case "error":
        this.events.onError?.(String(msg.message || "Call error."));
        break;
    }
  }

  private playFrame(buffer: ArrayBuffer) {
    // Deafen mutes all remote audio for THIS listener only — frames are
    // dropped client-side; other participants are unaffected.
    if (this.deafened) return;
    if (!this.audioCtx) {
      // Playback context was never created (shouldn't happen) — skip.
      return;
    }
    // Autoplay policy keeps the context 'suspended' until a user gesture;
    // keep retrying on every frame — once it unblocks, audio starts flowing.
    if (this.audioCtx.state === "suspended") void this.audioCtx.resume().catch(() => {});
    if (buffer.byteLength < CALL_FRAME_SAMPLES * 2) return;
    const pcm = new Int16Array(buffer);
    const audioBuffer = this.audioCtx.createBuffer(1, CALL_FRAME_SAMPLES, CALL_SAMPLE_RATE);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < CALL_FRAME_SAMPLES; i++) channel[i] = pcm[i] / 0x8000;
    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioCtx.destination);
    // Jitter buffer: schedule ~120 ms ahead; if we fall behind, resync.
    const now = this.audioCtx.currentTime;
    if (this.nextPlayTime < now + 0.05) this.nextPlayTime = now + 0.12;
    source.start(this.nextPlayTime);
    this.nextPlayTime += CALL_FRAME_SAMPLES / CALL_SAMPLE_RATE;
  }

  setMuted(muted: boolean) {
    this.userMuted = muted;
    this.applyEffectiveMute();
  }

  setDeafened(deafened: boolean) {
    this.deafened = deafened;
    this.applyEffectiveMute();
  }

  private applyEffectiveMute() {
    const effective = this.userMuted || this.deafened;
    this.muted = effective;
    for (const track of this.stream?.getAudioTracks() || []) track.enabled = !effective;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "mute", muted: effective }));
    }
  }

  leave() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: "leave" })); } catch { /* ignore */ }
    }
    this.closed = true;
    this.cleanup();
    this.ws?.close();
  }

  private cleanup() {
    this.closed = true;
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.stream = null;
    void this.worklet?.disconnect();
    this.worklet = null;
    this.scriptProcessor?.disconnect();
    this.scriptProcessor = null;
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }
}
