// Call ringtones/ringback â€” synthesized with WebAudio, no audio assets needed.
// Ringtone: classic cadence (2s ring, 3s pause) with layered harmonics + vibrato.
// Ringback: soft dual-tone the caller hears while the invite is unanswered.

const RING_ON_MS = 2000;
const RING_GAP_MS = 3000;
const RINGBACK_HZ = [440, 480];

function makeContext(): AudioContext | null {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  const ctx = new Ctor();
  void ctx.resume();
  return ctx;
}

// A pleasant dual-oscillator "brrring" voice with vibrato and a soft envelope.
function ringVoice(ctx: AudioContext, at: number, durationMs: number, gainValue: number): void {
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);

  const oscs: OscillatorNode[] = [];
  const vibrato = ctx.createOscillator();
  const vibratoGain = ctx.createGain();
  vibrato.frequency.value = 6; // 6 Hz warble
  vibratoGain.gain.value = 8; // Â±8 cents-ish depth on the voices
  vibrato.connect(vibratoGain);

  for (const [freq, type, level] of [
    [440, 'sine', 0.5],
    [554.37, 'sine', 0.28], // C#5 â€” consonant fifth-ish color
    [880, 'triangle', 0.08], // faint octave sparkle
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = type as OscillatorType;
    osc.frequency.value = freq;
    vibratoGain.connect(osc.frequency);
    const g = ctx.createGain();
    g.gain.value = level;
    osc.connect(g).connect(master);
    osc.start(at);
    osc.stop(at + durationMs / 1000 + 0.05);
    oscs.push(osc);
  }
  vibrato.start(at);
  vibrato.stop(at + durationMs / 1000 + 0.05);

  const end = at + durationMs / 1000;
  const attack = 0.04;
  master.gain.setValueAtTime(0, at);
  master.gain.linearRampToValueAtTime(gainValue, at + attack);
  master.gain.setValueAtTime(gainValue, end - 0.12);
  master.gain.linearRampToValueAtTime(0, end);
}

export function startRingtone(): () => void {
  const ctx = makeContext();
  if (!ctx) return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    const now = ctx.currentTime;
    ringVoice(ctx, now + 0.02, RING_ON_MS, 0.22);
    timer = setTimeout(schedule, RING_ON_MS + RING_GAP_MS);
  };
  schedule();

  // Gentle haptics on mobile while the call is ringing.
  const vibratePattern = [700, 400, 700, 400, 700, 1200];
  let vibrateTimer: ReturnType<typeof setInterval> | null = null;
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(vibratePattern);
    vibrateTimer = setInterval(() => navigator.vibrate(vibratePattern), 3200);
  }

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (vibrateTimer) clearInterval(vibrateTimer);
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(0);
    void ctx.close();
  };
}

// Quiet dual-tone the caller hears until the other side answers.
export function startRingback(): () => void {
  const ctx = makeContext();
  if (!ctx) return () => {};

  const master = ctx.createGain();
  master.gain.value = 0.06;
  master.connect(ctx.destination);

  const oscs = RINGBACK_HZ.map((freq) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(master);
    osc.start();
    return osc;
  });

  return () => {
    for (const osc of oscs) {
      try { osc.stop(); } catch { /* already stopped */ }
    }
    void ctx.close();
  };
}

export { RING_ON_MS, RING_GAP_MS };
