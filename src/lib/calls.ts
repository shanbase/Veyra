import { apiFetch, getNativeSessionToken, isNativeVeyraApp } from "@/lib/nativeSession";

// Voice calls: PCM16 16 kHz mono, 20 ms frames (640 bytes) over
// /api/calls/ws. The server mixes all speakers and returns one stream per
// listener. Signalling (invite/accept/decline/end) travels separately over
// Supabase Realtime 'call-signal' events — see CallProvider.

export const CALL_FRAME_SAMPLES = 320;
export const CALL_SAMPLE_RATE = 16000;

// Opus transport: WebCodecs AudioEncoder/Decoder at 48 kHz (the only rate
// Opus supports there), resampled from our 16 kHz mix rate. Packets are
// ~12x smaller than PCM and conceal small losses. The server tags Opus
// frames with a 0x01 prefix byte; raw 640-byte frames stay PCM for
// backward compatibility with older clients/servers.
const OPUS_TAG = 0x01;
const OPUS_RATE = 48000;
const OPUS_FRAME = 960; // 20 ms @ 48 kHz

let opusSupportPromise: Promise<boolean> | null = null;
function opusSupported(): Promise<boolean> {
  if (!opusSupportPromise) {
    opusSupportPromise = (async () => {
      try {
        if (typeof AudioEncoder === "undefined" || typeof AudioDecoder === "undefined") return false;
        const [enc, dec] = await Promise.all([
          AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: OPUS_RATE, numberOfChannels: 1, bitrate: 24000 } as AudioEncoderConfig),
          AudioDecoder.isConfigSupported({ codec: "opus", sampleRate: OPUS_RATE, numberOfChannels: 1 } as AudioDecoderConfig),
        ]);
        return Boolean(enc.supported && dec.supported);
      } catch {
        return false;
      }
    })();
  }
  return opusSupportPromise;
}

// 16 kHz Int16 -> 48 kHz Float32, linear interpolation (960 samples).
function upsampleTo48k(pcm: Int16Array): Float32Array {
  const out = new Float32Array(OPUS_FRAME);
  const step = (CALL_FRAME_SAMPLES - 1) / (OPUS_FRAME - 1);
  for (let i = 0; i < OPUS_FRAME; i++) {
    const p = i * step;
    const i0 = Math.min(Math.floor(p), CALL_FRAME_SAMPLES - 1);
    const frac = p - i0;
    const a = pcm[i0] / 0x8000;
    const b = pcm[Math.min(i0 + 1, CALL_FRAME_SAMPLES - 1)] / 0x8000;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

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
  from?: { id: string; username?: string; display_name?: string; avatar_url?: string };
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

// Call rooms are in-memory per server process, so every client MUST use the
// same backend. Resolution order:
//   1. VITE_CALL_SERVER_URL (build-time override)
//   2. GET /api/calls/config → CALL_SERVER_URL env on the API (runtime —
//      works on Vercel/Altare/native without a rebuild)
//   3. "" → same-origin embedded endpoints (single-server self-host only)
const CALL_API_BASE_ENV = String(import.meta.env.VITE_CALL_SERVER_URL || "").replace(/\/+$/, "");
let serverUrlCache: string | null | undefined;

async function callServerBase(): Promise<string> {
  if (CALL_API_BASE_ENV) return CALL_API_BASE_ENV;
  if (serverUrlCache === undefined) {
    try {
      const response = await apiFetch("/api/calls/config");
      const body = await response.json().catch(() => ({}));
      serverUrlCache = body?.url ? String(body.url).replace(/\/+$/, "") : null;
    } catch {
      serverUrlCache = null;
    }
  }
  return serverUrlCache || "";
}

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
  const base = await callServerBase();
  if (!base) {
    const response = await apiFetch(`/api/calls${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Call request failed (${response.status}).`);
    return body;
  }
  const ticket = await getCallTicket();
  const response = await fetch(`${base}/api/calls${path}`, {
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
  const base = await callServerBase();
  if (base) {
    // Remote call server: wss(s)://<call-host>/api/calls/ws?ticket=<ticket>
    const ticket = await getCallTicket();
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/calls/ws";
    url.search = `ticket=${encodeURIComponent(ticket)}`;
    return url.toString();
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const sameOrigin = `${proto}//${window.location.host}/api/calls/ws`;
  // Native apps authenticate API calls with a Bearer token, not cookies —
  // pass it as a query param for the WS handshake.
  if (isNativeVeyraApp()) {
    return getNativeSessionToken().then((token) => (token ? `${sameOrigin}?token=${encodeURIComponent(token)}` : sameOrigin));
  }
  return Promise.resolve(sameOrigin);
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
  private opusCapable = false;
  private opusActive = false;
  private opusEncoder: AudioEncoder | null = null;
  private opusDecoder: AudioDecoder | null = null;
  private opusTxTs = 0;
  private opusRxTs = 0;
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

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private attachSocket(ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        this.handleSignal(JSON.parse(event.data));
      } else {
        this.playFrame(event.data as ArrayBuffer);
      }
    };
    ws.onclose = () => {
      if (this.closed) return;
      // Auto-reconnect: the server keeps the call room alive, so a dropped
      // socket (wifi blip, proxy timeout) shouldn't end the call for us.
      if (this.reconnectAttempts < 3) {
        this.reconnectAttempts += 1;
        this.reconnectTimer = setTimeout(() => { void this.reconnect(); }, 1200 * this.reconnectAttempts);
        return;
      }
      this.events.onEnded?.("disconnected");
      this.cleanup();
    };
    ws.onerror = () => this.events.onError?.("Connection to the call server failed.");
  }

  private waitOpen(ws: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to the call.")), 10000);
      const onOpen = () => { clearTimeout(timer); cleanup(); resolve(); };
      const onFail = () => { clearTimeout(timer); cleanup(); reject(new Error("Could not connect to the call server.")); };
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onFail);
        ws.removeEventListener("close", onFail);
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onFail, { once: true });
      ws.addEventListener("close", onFail, { once: true });
    });
  }

  private sendJoin() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Claim Opus only when encoder AND decoder were actually created —
      // the server mirrors this in `welcome.codec` and will send Opus frames
      // back, which we cannot decode without a live AudioDecoder.
      const opusReady = Boolean(this.opusEncoder && this.opusDecoder);
      this.ws.send(JSON.stringify({ type: "join", callId: this.callId, codec: opusReady ? "opus" : "pcm" }));
    }
  }

  private async ensureOpus() {
    if (this.opusEncoder || this.opusDecoder) return;
    try {
      const encoder = new AudioEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          const tagged = new Uint8Array(1 + data.length);
          tagged[0] = OPUS_TAG;
          tagged.set(data, 1);
          if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.muted) {
            this.ws.send(tagged.buffer);
          }
        },
        error: () => { this.opusActive = false; },
      });
      await encoder.configure({ codec: "opus", sampleRate: OPUS_RATE, numberOfChannels: 1, bitrate: 24000 } as AudioEncoderConfig);
      const decoder = new AudioDecoder({
        output: (audioData) => this.playOpusData(audioData),
        error: () => {},
      });
      await decoder.configure({ codec: "opus", sampleRate: OPUS_RATE, numberOfChannels: 1 } as AudioDecoderConfig);
      this.opusEncoder = encoder;
      this.opusDecoder = decoder;
    } catch {
      this.opusActive = false;
    }
  }

  private async reconnect() {
    if (this.closed) return;
    try {
      const url = await wsUrl();
      const ws = new WebSocket(url);
      this.attachSocket(ws);
      this.ws = ws;
      await this.waitOpen(ws);
      this.sendJoin();
      // Re-apply mute/deafen — the server registers a fresh socket as unmuted.
      this.applyEffectiveMute();
    } catch {
      // Failed attempt — onclose/onerror will schedule the next retry.
      if (this.ws) this.ws.close();
    }
  }

  async start(): Promise<void> {
    const url = await wsUrl();
    this.ws = new WebSocket(url);
    this.attachSocket(this.ws);
    await this.waitOpen(this.ws);

    // AudioContext is created up-front for PLAYBACK even when the mic fails —
    // mic-less users must still hear the call. It starts 'suspended' under
    // autoplay policy; playFrame() keeps retrying resume() until it runs.
    this.audioCtx = new AudioContext();
    void this.audioCtx.resume().catch(() => {});

    // Opus support check is cheap and cached — do it before join so the
    // codec preference reaches the server in the join message. ensureOpus()
    // must run BEFORE sendJoin: the codec we claim must reflect a decoder
    // that actually exists, or the server sends Opus we can't play (total
    // silence — this was the 1.2.10 audio outage).
    this.opusCapable = await opusSupported();
    if (this.opusCapable) await this.ensureOpus();

    // Mic is optional: users without one (or who deny permission) still join
    // and hear the call — the server simply receives no frames from them.
    await this.startMic().catch(() => {
      this.micDenied = true;
      this.events.onMicDenied?.();
    });
    this.sendJoin();
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
        this.sendAudioFrame(new Int16Array(event.data as ArrayBuffer));
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
          const pcm = new Int16Array(CALL_FRAME_SAMPLES);
          for (let i = 0; i < CALL_FRAME_SAMPLES; i++) {
            const s = Math.max(-1, Math.min(1, out[i]));
            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          this.sendAudioFrame(pcm);
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

  private sendAudioFrame(pcm: Int16Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.muted) return;
    if (this.opusActive && this.opusEncoder) {
      // Backpressure: if the encoder is backed up, drop the frame rather
      // than queueing seconds of stale audio.
      if (this.opusEncoder.encodeQueueSize > 12) return;
      const audioData = new AudioData({
        format: "f32",
        sampleRate: OPUS_RATE,
        numberOfFrames: OPUS_FRAME,
        numberOfChannels: 1,
        timestamp: this.opusTxTs,
        data: upsampleTo48k(pcm).buffer as ArrayBuffer,
      });
      this.opusTxTs += 20000;
      try { this.opusEncoder.encode(audioData); } catch { /* encoder resetting */ }
      audioData.close();
      return;
    }
    this.ws.send(pcm.buffer);
  }

  private handleSignal(msg: Record<string, unknown>) {
    switch (msg.type) {
      case "welcome":
        this.reconnectAttempts = 0;
        // Server echoes the codec it will use; only trust it if our codec
        // objects exist (guaranteed by the honest join above).
        this.opusActive = msg.codec === "opus" && Boolean(this.opusEncoder && this.opusDecoder);
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
      case "error": {
        const message = String(msg.message || "Call error.");
        this.events.onError?.(message);
        // A rejected join means the room is gone — don't sit in a dead call.
        if (/no longer active|not allowed/i.test(message)) {
          this.events.onEnded?.("ended");
          this.cleanup();
          this.ws?.close();
        }
        break;
      }
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
    // Opus frames are tagged 0x01 and are never exactly 640 bytes; raw PCM
    // frames are exactly FRAME_SAMPLES*2 with no tag.
    if (buffer.byteLength !== CALL_FRAME_SAMPLES * 2) {
      const view = new Uint8Array(buffer);
      if (view.length > 1 && view[0] === OPUS_TAG && this.opusDecoder) {
        const chunk = new EncodedAudioChunk({ type: "key", timestamp: this.opusRxTs, data: view.subarray(1) });
        this.opusRxTs += 20000;
        try { this.opusDecoder.decode(chunk); } catch { /* undecodable packet */ }
      }
      return;
    }
    if (buffer.byteLength < CALL_FRAME_SAMPLES * 2) return;
    const pcm = new Int16Array(buffer);
    const audioBuffer = this.audioCtx.createBuffer(1, CALL_FRAME_SAMPLES, CALL_SAMPLE_RATE);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < CALL_FRAME_SAMPLES; i++) channel[i] = pcm[i] / 0x8000;
    this.scheduleBuffer(audioBuffer);
  }

  private scheduleBuffer(audioBuffer: AudioBuffer) {
    const source = this.audioCtx!.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioCtx!.destination);
    // Jitter buffer: schedule ~180 ms ahead so network bursts don't cause
    // underruns (that was the choppy/cut-out sound). Two resync rules:
    //  - fell behind → restart the cushion
    //  - got too far ahead (>400 ms) → pull back, otherwise delay grows forever
    const now = this.audioCtx!.currentTime;
    if (this.nextPlayTime < now + 0.05 || this.nextPlayTime > now + 0.4) this.nextPlayTime = now + 0.18;
    source.start(this.nextPlayTime);
    this.nextPlayTime += audioBuffer.duration;
  }

  private playOpusData(audioData: AudioData) {
    if (!this.audioCtx || this.deafened) {
      audioData.close();
      return;
    }
    if (this.audioCtx.state === "suspended") void this.audioCtx.resume().catch(() => {});
    const frames = audioData.numberOfFrames;
    const rate = audioData.sampleRate || OPUS_RATE;
    // Copy in the AudioData's NATIVE sample format, then convert ourselves —
    // copyTo's format conversion is inconsistent across browsers and produced
    // garbage (static) on some WebViews.
    const fmt = String(audioData.format || "f32");
    const bytesPer = fmt === "s16" ? 2 : fmt === "u8" ? 1 : 4;
    const raw = new Uint8Array(frames * bytesPer);
    try {
      audioData.copyTo(raw, { planeIndex: 0 });
    } catch {
      audioData.close();
      return;
    }
    audioData.close();
    const samples = new Float32Array(frames);
    if (fmt === "f32") {
      samples.set(new Float32Array(raw.buffer, raw.byteOffset, frames));
    } else if (fmt === "s16") {
      const v = new Int16Array(raw.buffer, raw.byteOffset, frames);
      for (let i = 0; i < frames; i++) samples[i] = v[i] / 0x8000;
    } else if (fmt === "s32") {
      const v = new Int32Array(raw.buffer, raw.byteOffset, frames);
      for (let i = 0; i < frames; i++) samples[i] = v[i] / 0x80000000;
    } else if (fmt === "u8") {
      for (let i = 0; i < frames; i++) samples[i] = (raw[i] - 128) / 128;
    } else {
      return;
    }
    const audioBuffer = this.audioCtx.createBuffer(1, frames, rate);
    audioBuffer.getChannelData(0).set(samples);
    this.scheduleBuffer(audioBuffer);
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: "leave" })); } catch { /* ignore */ }
    }
    this.closed = true;
    this.cleanup();
    this.ws?.close();
  }

  private cleanup() {
    this.closed = true;
    try { void this.opusEncoder?.close(); } catch { /* ignore */ }
    try { void this.opusDecoder?.close(); } catch { /* ignore */ }
    this.opusEncoder = null;
    this.opusDecoder = null;
    this.opusActive = false;
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
