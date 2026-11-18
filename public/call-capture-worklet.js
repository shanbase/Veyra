// AudioWorklet processor for Veyra voice calls.
// Captures the mic stream, downsamples to 16 kHz mono, applies lightweight
// noise suppression (DC/high-pass + adaptive noise gate for wind, room tone,
// and distant background voices), and emits 20 ms PCM16 frames (320 samples =
// 640 bytes) to the main thread, which forwards them over the call WebSocket.
//
// This is deliberately simple DSP — no ML models, zero cost. The browser's
// own RNNoise pipeline (echoCancellation/noiseSuppression constraints) does
// the heavy lifting; this cleans up what leaks through.
//
// The input side is a Float32Array ring buffer — the previous JS-array +
// splice() version did O(n) work per 128-sample quantum (~375x/sec) and was
// a measurable source of capture glitches on slower devices.

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 320;

class CallCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE;
    this.out = new Float32Array(FRAME_SAMPLES);
    this.outLen = 0;

    // Ring buffer holding up to ~2 s of input at the device rate.
    this.cap = Math.ceil(sampleRate * 2);
    this.buf = new Float32Array(this.cap);
    this.head = 0;   // index of oldest sample
    this.count = 0;  // samples currently buffered
    this.outPos = 0; // fractional read position within buffered input

    // --- noise suppression state (all at 16 kHz output rate) ---
    // One-pole high-pass ~120 Hz: kills wind rumble, desk thumps, DC offset.
    this.hpX1 = 0;
    this.hpY1 = 0;
    this.HP_COEF = 0.95;
    // Adaptive noise gate: tracks a noise floor from frame RMS. The floor
    // drops instantly on quiet frames and creeps up slowly, so sustained
    // background noise (wind, distant voices, fans) gets gated while speech
    // bursts pass through. Hysteresis (open/close thresholds) stops the gate
    // fluttering on borderline speech — that flutter is what made voices
    // sound choppy and "repeat" syllables.
    this.noiseFloor = 0.01;
    this.gate = 1;
    this.gateOpen = true;
  }

  at(i) {
    return this.buf[(this.head + i) % this.cap];
  }

  emit() {
    // Measure this frame's level before filtering.
    let sumSq = 0;
    for (let i = 0; i < FRAME_SAMPLES; i++) sumSq += this.out[i] * this.out[i];
    const rms = Math.sqrt(sumSq / FRAME_SAMPLES);

    if (rms < this.noiseFloor) this.noiseFloor = rms;
    else this.noiseFloor += (rms - this.noiseFloor) * 0.002;

    // Adaptive gate disabled: its open/close flutter produced audible
    // volume pumping ("zzz" stutter). The browser's own noiseSuppression
    // constraint already handles background noise — keep the high-pass only.
    const pcm = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const x = this.out[i];
      const y = x - this.hpX1 + this.HP_COEF * this.hpY1;
      this.hpX1 = x;
      this.hpY1 = y;
      // Mild makeup gain for quiet mics, soft-clipped above ~0.7 so loud
      // speech compresses instead of distorting.
      let v = y * 1.35;
      if (v > 0.7) v = 0.7 + (v - 0.7) * 0.25;
      else if (v < -0.7) v = -0.7 + (v + 0.7) * 0.25;
      const s = Math.max(-1, Math.min(1, v));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    this.outLen = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || !channel.length) return true;

    // Push this quantum into the ring, dropping the oldest samples if full
    // (never happens in practice — the consumer keeps up).
    for (let i = 0; i < channel.length; i++) {
      if (this.count === this.cap) {
        this.head = (this.head + 1) % this.cap;
        this.count--;
      }
      this.buf[(this.head + this.count) % this.cap] = channel[i];
      this.count++;
    }

    while (this.outPos + this.step <= this.count) {
      const i0 = Math.floor(this.outPos);
      const frac = this.outPos - i0;
      const a = this.at(i0);
      const b = i0 + 1 < this.count ? this.at(i0 + 1) : a;
      this.out[this.outLen++] = a + (b - a) * frac;
      this.outPos += this.step;
      if (this.outLen === FRAME_SAMPLES) this.emit();
    }

    const consumed = Math.floor(this.outPos);
    if (consumed > 0) {
      this.head = (this.head + consumed) % this.cap;
      this.count -= consumed;
      this.outPos -= consumed;
    }
    return true;
  }
}

registerProcessor('call-capture', CallCaptureProcessor);
