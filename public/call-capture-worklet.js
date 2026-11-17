// AudioWorklet processor for Veyra voice calls.
// Captures the mic stream, downsamples to 16 kHz mono, and emits 20 ms
// PCM16 frames (320 samples = 640 bytes) to the main thread, which forwards
// them over the call WebSocket.

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 320;

class CallCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE;
    this.pending = [];
    this.outPos = 0;
    this.out = new Float32Array(FRAME_SAMPLES);
    this.outLen = 0;
  }

  emit() {
    const pcm = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const s = Math.max(-1, Math.min(1, this.out[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    this.outLen = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      for (let i = 0; i < channel.length; i++) this.pending.push(channel[i]);

      while (this.outPos + this.step <= this.pending.length) {
        const i0 = Math.floor(this.outPos);
        const frac = this.outPos - i0;
        const a = this.pending[i0];
        const b = this.pending[i0 + 1] || a;
        this.out[this.outLen++] = a + (b - a) * frac;
        this.outPos += this.step;
        if (this.outLen === FRAME_SAMPLES) this.emit();
      }

      const consumed = Math.floor(this.outPos);
      if (consumed > 0) {
        this.pending.splice(0, consumed);
        this.outPos -= consumed;
      }
      // Safety valve: never let the backlog grow unboundedly.
      if (this.pending.length > sampleRate) this.pending.splice(0, this.pending.length - sampleRate);
    }
    return true;
  }
}

registerProcessor('call-capture', CallCaptureProcessor);
