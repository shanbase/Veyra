// AudioWorklet processor for Veyra voice calls.
// Captures the mic stream, downsamples to 16 kHz mono, applies lightweight
// noise suppression (DC/high-pass + adaptive noise gate for wind, room tone,
// and distant background voices), and emits 20 ms PCM16 frames (320 samples =
// 640 bytes) to the main thread, which forwards them over the call WebSocket.
//
// This is deliberately simple DSP — no ML models, zero cost. The browser's
// own RNNoise pipeline (echoCancellation/noiseSuppression constraints) does
// the heavy lifting; this cleans up what leaks through.

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

    // --- noise suppression state (all at 16 kHz output rate) ---
    // One-pole high-pass ~120 Hz: kills wind rumble, desk thumps, DC offset.
    this.hpX1 = 0;
    this.hpY1 = 0;
    this.HP_COEF = 0.95;
    // Adaptive noise gate: tracks a noise floor from frame RMS. The floor
    // drops instantly on quiet frames and creeps up slowly, so sustained
    // background noise (wind, distant voices, fans) gets gated while speech
    // bursts pass through.
    this.noiseFloor = 0.015;
    this.gate = 1;
  }

  emit() {
    // Measure this frame's level before filtering.
    let sumSq = 0;
    for (let i = 0; i < FRAME_SAMPLES; i++) sumSq += this.out[i] * this.out[i];
    const rms = Math.sqrt(sumSq / FRAME_SAMPLES);

    if (rms < this.noiseFloor) this.noiseFloor = rms;
    else this.noiseFloor += (rms - this.noiseFloor) * 0.002;

    const threshold = Math.max(this.noiseFloor * 3, 0.005);
    const gateTarget = rms > threshold ? 1 : 0.1;
    // Attack fast (open immediately on speech), release slow (no chopping).
    this.gate += (gateTarget - this.gate) * (gateTarget > this.gate ? 0.6 : 0.015);

    const pcm = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const x = this.out[i];
      const y = x - this.hpX1 + this.HP_COEF * this.hpY1;
      this.hpX1 = x;
      this.hpY1 = y;
      const s = Math.max(-1, Math.min(1, y * this.gate));
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
