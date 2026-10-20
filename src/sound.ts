/**
 * Sound effects synthesized with Web Audio (no audio files to download).
 * Browsers only allow audio after a user gesture, so the context is created on first use
 * from a click or key press.
 */

const MUTE_KEY = 'overdrive.muted';

let ctx: AudioContext | undefined;
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
})();

function audio(): AudioContext | undefined {
  if (muted || typeof AudioContext === 'undefined') return undefined;
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  /** Seconds from now. */
  at?: number;
  /** Glide to this frequency by the end. */
  to?: number;
}

function tone(freq: number, dur: number, { type = 'sine', gain = 0.18, at = 0, to }: ToneOpts = {}): void {
  const a = audio();
  if (!a) return;
  const t0 = a.currentTime + at;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(dur: number, { gain = 0.2, at = 0, from = 2000, to = 200 } = {}): void {
  const a = audio();
  if (!a) return;
  const t0 = a.currentTime + at;
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  const filter = a.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(from, t0);
  filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(a.destination);
  src.start(t0);
}

export const sound = {
  get muted(): boolean {
    return muted;
  },
  setMuted(on: boolean): void {
    muted = on;
    try {
      localStorage.setItem(MUTE_KEY, on ? '1' : '0');
    } catch {
      /* private mode */
    }
  },
  /** Call from a click so later sounds are allowed to play. */
  unlock(): void {
    audio();
  },

  // Race
  light: () => tone(440, 0.25, { type: 'square', gain: 0.12 }),
  go: () => tone(880, 0.7, { type: 'square', gain: 0.14 }),
  lap: () => {
    tone(784, 0.12, { type: 'triangle' });
    tone(1047, 0.18, { type: 'triangle', at: 0.1 });
  },
  finalLap: () => [0, 0.18, 0.36].forEach((at) => tone(1319, 0.15, { type: 'triangle', at, gain: 0.2 })),
  win: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, i === 5 ? 0.6 : 0.16, { type: 'square', gain: 0.1, at: i * 0.15 })),
  finish: () => tone(659, 0.3, { type: 'triangle' }),

  // Weapons
  laser: () => tone(1800, 0.12, { type: 'sawtooth', gain: 0.08, to: 300 }),
  missile: () => {
    noise(0.5, { gain: 0.25, from: 400, to: 3000 });
    tone(200, 0.5, { type: 'sawtooth', gain: 0.05, to: 900 });
  },
  pulse: () => {
    tone(120, 0.6, { type: 'sine', gain: 0.3, to: 40 });
    tone(2400, 0.4, { type: 'sine', gain: 0.05, to: 600 });
  },
  shield: () => tone(300, 0.5, { type: 'sine', gain: 0.15, to: 1200 }),
  hit: () => noise(0.25, { gain: 0.3, from: 3000, to: 300 }),
  blocked: () => tone(1500, 0.15, { type: 'triangle', gain: 0.1, to: 2500 }),
  knockout: () => {
    noise(0.9, { gain: 0.4, from: 1500, to: 60 });
    tone(90, 0.8, { type: 'sine', gain: 0.3, to: 30 });
  },
  empty: () => tone(180, 0.1, { type: 'square', gain: 0.06 }),
};

export type SoundName = Exclude<keyof typeof sound, 'muted' | 'setMuted' | 'unlock'>;
