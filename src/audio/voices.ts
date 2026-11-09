import type { Kind } from '../parse/piyolog-text';
import { Side, type Note } from '../score/notes';
import type { ScaleId } from '../share/codec';

export type VoiceKey = Kind | 'tick' | 'bass';

const SCALES: Record<ScaleId, readonly number[]> = {
  penta: [0, 2, 4, 7, 9],
  ryukyu: [0, 4, 5, 7, 11],
  miyako: [0, 1, 5, 7, 8],
  lydian: [0, 2, 4, 6, 7, 9, 11],
};
const CHORDS = [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14]] as const; // I vi IV V
const BASS_PATTERN = [0, 0, 7, 0, 0, 7, 5, 7] as const;

export const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
export const chordOf = (day: number) => CHORDS[day % 4]!;

export function scaleNote(scale: ScaleId, base: number, deg: number): number {
  const s = SCALES[scale];
  const o = Math.floor(deg / s.length);
  const r = ((deg % s.length) + s.length) % s.length;
  return base + 12 * o + s[r]!;
}

interface Hardness {
  d: number;
  p: number;
  n: number;
}
const HARD: readonly Hardness[] = [
  { d: 0.55, p: 1.12, n: 0 },
  { d: 1, p: 1, n: 0 },
  { d: 1.4, p: 0.94, n: 0 },
  { d: 1.5, p: 0.9, n: 1 },
];
const HARD_NORMAL = HARD[1]!;

/** Seeded so that noise, and a WAV export of the same song, come out the same everywhere. */
function fillNoise(d: Float32Array): void {
  let s = 0x2f6e2b1;
  for (let i = 0; i < d.length; i++) {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    d[i] = ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1;
  }
}

/** Every instrument, against either a live AudioContext or an OfflineAudioContext. */
export class Voices {
  readonly master: GainNode;
  private readonly noise: AudioBuffer;
  /** Scheduled notes connect here; replacing it lets a stop or a seek silence them. */
  dest: AudioNode;

  constructor(private readonly ctx: BaseAudioContext, public scale: ScaleId) {
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.dest = this.master;
    this.noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    fillNoise(this.noise.getChannelData(0));
  }

  private out(pan: number): AudioNode {
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.dest);
    return p;
  }

  private env(g: GainNode, t: number, peak: number, a: number, dcy: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dcy);
  }

  private osc(type: OscillatorType, f: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    return o;
  }

  private filter(type: BiquadFilterType, f: number, q?: number): BiquadFilterNode {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    if (q !== undefined) b.Q.value = q;
    return b;
  }

  private noiseSource(): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    return s;
  }

  marimba(f: number, t: number, vel = 0.5, pan = 0): void {
    const g = this.ctx.createGain();
    g.connect(this.out(pan));
    this.env(g, t, vel * 0.5, 0.005, 0.9);
    const o = this.osc('sine', f);
    o.connect(g);
    const g2 = this.ctx.createGain();
    g2.connect(this.out(pan));
    this.env(g2, t, vel * 0.12, 0.002, 0.12);
    const o2 = this.osc('sine', f * 3.98);
    o2.connect(g2);
    for (const x of [o, o2]) {
      x.start(t);
      x.stop(t + 1.1);
    }
  }

  bass(f: number, t: number, vel = 0.6): void {
    const g = this.ctx.createGain();
    g.connect(this.dest);
    this.env(g, t, vel * 0.55, 0.01, 0.7);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.5);
    lp.connect(g);
    const o = this.osc('sawtooth', f);
    o.connect(lp);
    o.start(t);
    o.stop(t + 0.8);
  }

  hat(t: number, pan: number, vel = 0.35): void {
    const s = this.noiseSource();
    const g = this.ctx.createGain();
    this.env(g, t, vel * 0.63, 0.001, 0.07);
    s.connect(this.filter('highpass', 7500)).connect(g).connect(this.out(pan));
    s.start(t);
    s.stop(t + 0.12);
  }

  private grit(t: number, dur: number, vel: number, f: number): void {
    const s = this.noiseSource();
    const g = this.ctx.createGain();
    this.env(g, t, vel, 0.005, dur);
    s.connect(this.filter('bandpass', f, 0.7)).connect(g).connect(this.dest);
    s.start(t);
    s.stop(t + dur + 0.05);
  }

  private kick(t: number, vel: number, h: Hardness): void {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.connect(g).connect(this.dest);
    o.frequency.setValueAtTime(150 * h.p, t);
    o.frequency.exponentialRampToValueAtTime(42 * h.p, t + 0.14);
    this.env(g, t, vel, 0.003, 0.32 * h.d);
    o.start(t);
    o.stop(t + 0.32 * h.d + 0.1);
    if (h.n) this.grit(t, 0.22 * h.d, vel * 0.35, 500);
  }

  private rim(t: number, vel: number, h: Hardness): void {
    const o = this.osc('square', 1700 * h.p);
    const g = this.ctx.createGain();
    this.env(g, t, vel * 0.35, 0.001, 0.035 * h.d);
    o.connect(this.filter('bandpass', 1700 * h.p, 4)).connect(g).connect(this.out(0.25));
    o.start(t);
    o.stop(t + 0.1);
    this.grit(t, 0.02 * h.d, vel * (0.25 + h.n * 0.3), 3500);
  }

  private tom(t: number, vel: number, h: Hardness): void {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.connect(g).connect(this.out(-0.25));
    o.frequency.setValueAtTime(260 * h.p, t);
    o.frequency.exponentialRampToValueAtTime(150 * h.p, t + 0.18);
    this.env(g, t, vel * 0.75, 0.002, 0.28 * h.d);
    o.start(t);
    o.stop(t + 0.28 * h.d + 0.1);
    this.grit(t, 0.04 * h.d, vel * (0.12 + h.n * 0.25), 1200);
  }

  private crash(t: number, vel: number, h: Hardness): void {
    const s = this.noiseSource();
    s.loop = true;
    const pk = this.filter('peaking', 7000);
    pk.gain.value = 6;
    const g = this.ctx.createGain();
    this.env(g, t, vel * 0.32, 0.004, 1.6 * h.d);
    s.connect(this.filter('highpass', 4500 * h.p)).connect(pk).connect(g).connect(this.out(0.35));
    s.start(t);
    s.stop(t + 1.6 * h.d + 0.1);
    // A few inharmonic partials for the metallic shimmer
    for (const f of [3150, 4720, 6230]) {
      const o = this.osc('square', f * h.p);
      const og = this.ctx.createGain();
      this.env(og, t, vel * 0.015, 0.002, 0.9 * h.d);
      o.connect(og).connect(this.out(0.35));
      o.start(t);
      o.stop(t + 1);
    }
  }

  poop(t: number, amount?: number, hardness?: number): void {
    const h = hardness === undefined ? HARD_NORMAL : HARD[hardness]!;
    switch (amount) {
      case 0:
        this.rim(t, 0.9, h);
        break;
      case 1:
        this.tom(t, 0.9, h);
        break;
      case 3:
        this.kick(t, 1, h);
        this.crash(t + 0.01, 0.85, h);
        break;
      default:
        this.kick(t, 0.9, h);
    }
  }

  block(t: number, down: boolean): void {
    const o = this.osc('triangle', down ? 1180 : 880);
    const g = this.ctx.createGain();
    o.connect(g).connect(this.dest);
    this.env(g, t, down ? 0.12 : 0.06, 0.001, 0.04);
    o.start(t);
    o.stop(t + 0.08);
  }

  pad(chord: readonly number[], t: number, dur: number): void {
    const g = this.ctx.createGain();
    const lp = this.filter('lowpass', 700, 0.4);
    lp.connect(g).connect(this.dest);
    const a = Math.min(0.8, dur * 0.3);
    const r = Math.min(1.2, dur * 0.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + a);
    g.gain.setValueAtTime(0.07, Math.max(t + a, t + dur - r));
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    for (const s of chord) {
      for (const det of [-6, 6]) {
        const o = this.osc('triangle', midi(48 + s));
        o.detune.value = det;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 0.05);
      }
    }
  }

  /** Sine + soft 2nd harmonic, delayed vibrato, breath noise. */
  flute(f: number, t: number, vel = 0.5, dur = 0.55): void {
    const g = this.ctx.createGain();
    g.connect(this.out(0.15));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vel * 0.32, t + 0.05);
    g.gain.setValueAtTime(vel * 0.32, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.35);
    const o = this.osc('sine', f);
    const o2 = this.osc('sine', f * 2);
    const g2 = this.ctx.createGain();
    g2.gain.value = 0.12;
    o2.connect(g2).connect(g);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 5.2;
    const lg = this.ctx.createGain();
    lg.gain.setValueAtTime(0, t);
    lg.gain.linearRampToValueAtTime(f * 0.006, t + 0.25);
    lfo.connect(lg);
    lg.connect(o.frequency);
    lg.connect(o2.frequency);
    o.connect(g);
    const n = this.noiseSource();
    const ng = this.ctx.createGain();
    this.env(ng, t, vel * 0.06, 0.02, 0.12);
    n.connect(this.filter('bandpass', f * 1.5, 2)).connect(ng).connect(g);
    for (const x of [o, o2, lfo]) {
      x.start(t);
      x.stop(t + dur + 0.4);
    }
    n.start(t);
    n.stop(t + 0.3);
  }

  /** FM bell. */
  glock(f: number, t: number, vel = 0.5): void {
    const car = this.osc('sine', f);
    const mod = this.osc('sine', f * 3.5);
    const mg = this.ctx.createGain();
    mg.gain.setValueAtTime(f * 1.2, t);
    mg.gain.exponentialRampToValueAtTime(1, t + 0.8);
    mod.connect(mg).connect(car.frequency);
    const g = this.ctx.createGain();
    g.connect(this.out(-0.2));
    this.env(g, t, vel * 0.28, 0.002, 1.4);
    car.connect(g);
    for (const x of [car, mod]) {
      x.start(t);
      x.stop(t + 1.5);
    }
  }

  /** "Shu-pok", 4 cycles. */
  pump(t: number, vel = 0.6): void {
    for (let i = 0; i < 4; i++) {
      const ti = t + i * 0.16;
      const n = this.noiseSource();
      const ng = this.ctx.createGain();
      this.env(ng, ti, vel * 0.12, 0.03, 0.07);
      n.connect(this.filter('bandpass', 1800, 1.2)).connect(ng).connect(this.out(0.4));
      n.start(ti);
      n.stop(ti + 0.12);
      const o = this.ctx.createOscillator();
      o.frequency.setValueAtTime(320, ti + 0.08);
      o.frequency.exponentialRampToValueAtTime(180, ti + 0.14);
      const og = this.ctx.createGain();
      this.env(og, ti + 0.08, vel * 0.25, 0.002, 0.07);
      o.connect(og).connect(this.out(0.4));
      o.start(ti + 0.08);
      o.stop(ti + 0.18);
    }
  }

  bathGliss(t: number): void {
    [72, 76, 79, 84].forEach((n, i) => this.marimba(midi(n), t + i * 0.06, 0.35, 0.3));
  }

  /** Every feed is a melody note on the same scale; more intake = lower note. */
  note(n: Note, t: number, rate: number): void {
    const deg = 7 - n.level;
    switch (n.kind) {
      case 'breast': {
        const pan = n.side === Side.Left ? -0.6 : n.side === Side.Right ? 0.6 : 0;
        this.marimba(midi(scaleNote(this.scale, 72, deg)), t, 0.55, pan);
        break;
      }
      case 'formula':
        this.flute(midi(scaleNote(this.scale, 72, deg)), t, 0.6, Math.min(1.2, 0.3 + (n.level * 25) / 200));
        break;
      case 'expressed':
        this.glock(midi(scaleNote(this.scale, 84, deg)), t, 0.55);
        break;
      case 'pump':
        this.pump(t);
        break;
      case 'pee':
        // Position-derived pan, in place of the prototype's Math.random, keeps renders repeatable.
        this.hat(t, (((n.day * 1440 + n.minute) * 2654435761) % 1000) / 1000 * 0.6 - 0.3);
        break;
      case 'poop':
        this.poop(t, n.amount, n.hardness);
        break;
      case 'sleep':
        this.pad(chordOf(n.day), t, Math.max(0.3, (n.len ?? 0) / rate));
        break;
      case 'bath':
        this.bathGliss(t);
        break;
    }
  }

  /** The 3-hour floor: root, root, fifth, root… so a bassline exists whatever was recorded. */
  autoBass(at: number, t: number): void {
    const day = Math.floor(at / 1440);
    const slot = Math.floor((at % 1440) / 180);
    this.bass(midi(36 + chordOf(day)[0] + BASS_PATTERN[slot]!), t, 0.55);
  }

  /** A short audition when a voice is switched on. */
  preview(k: VoiceKey, t: number, rate: number): void {
    const base = { day: 0, minute: 0, level: 3, side: Side.Both as Side };
    switch (k) {
      case 'poop':
        [0, 1, 2, 3].forEach((amount, i) => this.poop(t + i * 0.45, amount, 1));
        break;
      case 'bass':
        [0, 7, 5].forEach((iv, i) => this.bass(midi(36 + iv), t + i * 0.3, 0.55));
        break;
      case 'tick':
        this.block(t, true);
        break;
      case 'sleep':
        this.note({ ...base, kind: k, len: rate * 1.2 }, t, rate);
        break;
      default:
        this.note({ ...base, kind: k }, t, rate);
    }
  }
}
