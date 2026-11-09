import type { Note } from '../score/notes';
import type { ScaleId } from '../share/codec';
import { Voices, type VoiceKey } from './voices';

const DAY = 1440;
const TICK_MINUTES = 180;
const LOOKAHEAD = 0.2;
const LOOKAHEAD_HIDDEN = 1.5; // background tabs throttle setInterval to about once a second
const TICK_MS = 40;

export interface SeqItem {
  at: number;
  key: VoiceKey;
  note?: Note;
  down?: boolean;
  /** AudioContext time this item last sounded, for the score's flash. */
  when?: number;
}

export function buildSeq(notes: readonly Note[], dayCount: number): SeqItem[] {
  const seq: SeqItem[] = notes.map((note) => ({ at: note.day * DAY + note.minute, key: note.kind, note }));
  for (let at = 0; at < dayCount * DAY; at += TICK_MINUTES) {
    seq.push({ at, key: 'tick', down: at % DAY === 0 });
  }
  const rank = (s: SeqItem) => (s.key === 'tick' ? 0 : 1);
  return seq
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.at - b.s.at || rank(a.s) - rank(b.s) || a.i - b.i)
    .map(({ s }) => s);
}

/** Plays one item through the given voices, honouring mutes. Shared by live playback and WAV export. */
export function playItem(v: Voices, item: SeqItem, t: number, rate: number, on: Readonly<Record<VoiceKey, boolean>>): void {
  if (item.key === 'tick') {
    if (on.tick) v.block(t, !!item.down);
    if (on.bass) v.autoBass(item.at, t);
  } else if (item.note && on[item.key]) {
    v.note(item.note, t, rate);
  }
}

export class Engine {
  ctx: AudioContext | null = null;
  playing = false;
  seq: SeqItem[] = [];
  rate = DAY / 6;

  private voices: Voices | null = null;
  private bus: GainNode | null = null;
  private startT = 0;
  private startPos = 0;
  private ptr = 0;
  private dayCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private scale: ScaleId, readonly on: Record<VoiceKey, boolean>) {}

  setSong(notes: readonly Note[], dayCount: number): void {
    this.seq = buildSeq(notes, dayCount);
    this.dayCount = dayCount;
  }

  setScale(scale: ScaleId): void {
    this.scale = scale;
    if (this.voices) this.voices.scale = scale;
  }

  setSecondsPerDay(seconds: number): void {
    if (this.playing && this.ctx) {
      this.startPos = this.posAt(this.ctx.currentTime);
      this.startT = this.ctx.currentTime;
    }
    this.rate = DAY / seconds;
  }

  /** Must run synchronously inside a tap: iOS only lets a gesture start audio. */
  unlock(): void {
    if (!this.ctx) {
      // On iOS this keeps web audio playing with the ringer switch on silent (Safari 16.4+).
      const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
      if (session) session.type = 'playback';
      this.ctx = new AudioContext();
      this.voices = new Voices(this.ctx, this.scale);
      this.bus = this.newBus();
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.playing) void this.ctx?.resume();
      });
    }
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  private newBus(): GainNode {
    const bus = this.ctx!.createGain();
    bus.connect(this.voices!.master);
    this.voices!.dest = bus;
    return bus;
  }

  /** Fades out what is already scheduled, which can be seconds of sleep pad. */
  private silence(): void {
    const bus = this.bus;
    const ctx = this.ctx;
    if (!bus || !ctx) return;
    const t = ctx.currentTime;
    bus.gain.setValueAtTime(bus.gain.value, t);
    bus.gain.linearRampToValueAtTime(0, t + 0.04);
    setTimeout(() => bus.disconnect(), 200);
    this.bus = this.newBus();
  }

  play(from = 0): void {
    this.unlock();
    this.playing = true;
    this.seek(from);
    if (this.timer === null) this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  stop(): void {
    this.playing = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.silence();
    for (const s of this.seq) s.when = undefined;
  }

  seek(at: number): void {
    this.silence();
    const ctx = this.ctx!;
    this.startPos = at;
    this.startT = ctx.currentTime + 0.05;
    const i = this.seq.findIndex((s) => s.at >= at);
    this.ptr = i < 0 ? this.seq.length : i;
    for (const s of this.seq) s.when = undefined;
    // Landing inside a sleep: sound the rest of it.
    for (const s of this.seq) {
      if (s.key !== 'sleep' || !s.note || !this.on.sleep || s.at >= at) continue;
      const left = s.at + (s.note.len ?? 0) - at;
      if (left <= 0) continue;
      s.when = this.startT;
      this.voices!.note({ ...s.note, len: left }, this.startT, this.rate);
    }
  }

  posAt(t: number): number {
    return this.startPos + (t - this.startT) * this.rate;
  }

  private timeAt(at: number): number {
    return this.startT + (at - this.startPos) / this.rate;
  }

  private schedule(): void {
    if (!this.playing || !this.ctx || !this.voices) return;
    const now = this.ctx.currentTime;
    const horizon = now + (document.hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD);
    const end = this.dayCount * DAY;
    for (;;) {
      if (this.ptr >= this.seq.length) {
        const endT = this.timeAt(end);
        if (endT >= horizon) break;
        this.startPos = 0;
        this.startT = endT;
        this.ptr = 0;
        for (const s of this.seq) s.when = undefined;
        continue;
      }
      const item = this.seq[this.ptr]!;
      const t = this.timeAt(item.at);
      if (t > horizon) break;
      if (t >= now - 0.05) {
        const tt = Math.max(t, now);
        item.when = tt;
        playItem(this.voices, item, tt, this.rate, this.on);
      }
      this.ptr++;
    }
  }

  preview(k: VoiceKey): void {
    this.unlock();
    if (!this.ctx || !this.voices) return;
    this.voices.preview(k, this.ctx.currentTime + 0.05, this.rate);
  }
}
