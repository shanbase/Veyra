import { apiFetch, getNativeSessionToken, isNativeVeyraApp } from "@/lib/nativeSession";

// Voice calls: PCM16 16 kHz mono, 20 ms frames (640 bytes) over
// /api/calls/ws. The server mixes all speakers and returns one stream per
// listener. Signalling (invite/accept/decline/end) travels separately over
// Supabase Realtime 'call-signal' events — see CallProvider.

export const CALL_FRAME_SAMPLES = 320;
export const CALL_SAMPLE_RATE = 16000;

export type CallParticipant = { userId: string; name: string; muted: boolean };

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
  onPeerJoin?: (userId: string, name: string) => void;
  onPeerLeave?: (userId: string) => void;
  onPeerMute?: (userId: string, muted: boolean) => void;
  onParticipants?: (participants: CallParticipant[]) => void;
  onEnded?: (reason: string) => void;
  onError?: (message: string) => void;
};

async function callApi(path: string, init: RequestInit = {}) {
  const response = await apiFetch(`/api/calls${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
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

function wsUrl() {
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
  private muted = false;
  private closed = false;
  readonly callId: string;
  readonly conversationId: string;
  participants: CallParticipant[] = [];

  constructor(callId: string, conversationId: string, private events: SessionEvents = {}) {
    this.callId = callId;
    this.conversationId = conversationId;
  }

  get isMuted() { return this.muted; }
  get isOpen() { return !this.closed && this.ws?.readyState === WebSocket.OPEN; }

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

    await this.startMic();
    this.ws.send(JSON.stringify({ type: "join", callId: this.callId }));
  }

  private async startMic() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this.audioCtx = new AudioContext();
    await this.audioCtx.audioWorklet.addModule("/call-capture-worklet.js");
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.audioCtx, "call-capture");
    this.worklet.port.onmessage = (event) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.muted) {
        this.ws.send(event.data as ArrayBuffer);
      }
    };
    source.connect(this.worklet);
    // The worklet only feeds the socket — never connect it to destination or
    // the user hears their own mic back.
  }

  private handleSignal(msg: Record<string, unknown>) {
    switch (msg.type) {
      case "welcome":
        this.participants = (msg.participants as CallParticipant[]) || [];
        this.events.onParticipants?.(this.participants);
        break;
      case "peer-joined":
        this.events.onPeerJoin?.(String(msg.userId), String(msg.name || ""));
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
    if (!this.audioCtx || buffer.byteLength < CALL_FRAME_SAMPLES * 2) return;
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
    this.muted = muted;
    for (const track of this.stream?.getAudioTracks() || []) track.enabled = !muted;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "mute", muted }));
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
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }
}
