import type { Engine, SeqItem } from '../audio/engine';
import type { VoiceKey } from '../audio/voices';

const TOP = 18;
const VOICE_COLOR: Partial<Record<VoiceKey, string>> = {
  breast: '--feed',
  formula: '--formula',
  expressed: '--expressed',
  pump: '--pump',
  pee: '--pee',
  poop: '--poop',
  bath: '--bath',
};
const LANE: Partial<Record<VoiceKey, number>> = {
  breast: 0.3,
  formula: 0.3,
  expressed: 0.3,
  pump: 0.85,
  pee: 0.62,
  poop: 0.62,
  bath: 0.85,
};
const POOP_SIZE = [0.6, 0.8, 1.05, 1.4];

/** The 24h × days canvas. Reads the seq and playhead from the engine each frame. */
export class ScoreView {
  private readonly g: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private rowH = 14;
  private dpr = 1;
  private left = 44;
  private dayCount = 0;

  constructor(
    private readonly cv: HTMLCanvasElement,
    private readonly engine: Engine,
    private readonly labelOf: (dayIndex: number) => string,
    private readonly onNow: (text: string) => void,
  ) {
    this.g = cv.getContext('2d')!;
  }

  setDayCount(n: number): void {
    this.dayCount = n;
    this.left = n >= 100 ? 58 : 48;
    this.resize();
  }

  resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    this.width = this.cv.clientWidth;
    const n = this.dayCount;
    this.rowH = n <= 7 ? 30 : n <= 14 ? 20 : 13;
    this.height = TOP + n * this.rowH + 4;
    this.cv.style.height = `${this.height}px`;
    this.cv.width = this.width * this.dpr;
    this.cv.height = this.height * this.dpr;
    this.draw();
  }

  /** The row under a click, or null above the first day or below the last. */
  rowAt(offsetY: number): number | null {
    const r = Math.floor((offsetY - TOP) / this.rowH);
    return r >= 0 && r < this.dayCount ? r : null;
  }

  draw(): void {
    if (this.width === 0) return;
    const c = this.g;
    const { left: L, rowH, height: H, dayCount } = this;
    const style = getComputedStyle(document.documentElement);
    const css = (v: string) => style.getPropertyValue(v).trim();
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.width, H);
    const gw = this.width - L - 6;
    const x = (m: number) => L + (m / 1440) * gw;
    c.font = `11px ${css('--mono')}`;
    c.textBaseline = 'middle';

    c.strokeStyle = css('--line');
    c.fillStyle = css('--muted');
    c.lineWidth = 1;
    for (let h = 0; h <= 24; h += 3) {
      const X = Math.round(x(h * 60)) + 0.5;
      c.beginPath();
      c.moveTo(X, TOP - 2);
      c.lineTo(X, H - 4);
      c.stroke();
      if (h % 6 === 0) {
        c.textAlign = h === 0 ? 'left' : h === 24 ? 'right' : 'center';
        c.fillText(String(h), X, 7);
      }
    }

    const { engine } = this;
    const now = engine.ctx ? engine.ctx.currentTime : 0;
    const pos = engine.playing ? Math.max(0, engine.posAt(now)) : null;
    for (let r = 0; r < dayCount; r++) {
      const y = TOP + r * rowH;
      if (pos !== null && Math.floor(pos / 1440) === r) {
        c.fillStyle = css('--line');
        c.globalAlpha = 0.5;
        c.fillRect(L, y, gw, rowH);
        c.globalAlpha = 1;
      }
      c.fillStyle = css('--muted');
      c.textAlign = 'right';
      c.fillText(this.labelOf(r), L - 6, y + rowH / 2);
    }

    this.drawSleeps(x, now, pos, css('--sleep'));
    for (const s of engine.seq) this.drawItem(s, x, now, css(VOICE_COLOR[s.key] ?? '--tick'));
    c.globalAlpha = 1;

    if (pos !== null) {
      const r = Math.floor(pos / 1440);
      if (r >= 0 && r < dayCount) {
        const X = x(pos % 1440);
        c.strokeStyle = css('--accent');
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(X, TOP + r * rowH - 2);
        c.lineTo(X, TOP + (r + 1) * rowH + 2);
        c.stroke();
        const m = Math.floor(pos % 1440);
        this.onNow(`${this.labelOf(r)} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
      }
    }
  }

  private drawSleeps(x: (m: number) => number, now: number, pos: number | null, color: string): void {
    const c = this.g;
    const { rowH, dayCount, engine } = this;
    c.fillStyle = color;
    for (const s of engine.seq) {
      if (s.key !== 'sleep') continue;
      const end = s.at + (s.note?.len ?? 0);
      const lit = s.when !== undefined && now >= s.when && pos !== null && pos < end;
      c.globalAlpha = engine.on.sleep ? (lit ? 0.95 : 0.6) : 0.2;
      // Split at midnight
      let a = s.at;
      while (a < end) {
        const d = Math.floor(a / 1440);
        const seg = Math.min(end, (d + 1) * 1440);
        if (d < dayCount) {
          const X = x(a - d * 1440);
          roundRect(c, X, TOP + d * rowH + 2, Math.max(2, x(seg - d * 1440) - X), rowH - 4, 3);
          c.fill();
        }
        a = seg;
      }
    }
    c.globalAlpha = 1;
  }

  private drawItem(s: SeqItem, x: (m: number) => number, now: number, color: string): void {
    const lane = LANE[s.key];
    if (lane === undefined) return;
    const c = this.g;
    const { rowH, engine } = this;
    const d = Math.floor(s.at / 1440);
    const y = TOP + d * rowH + rowH * lane;
    const X = x(s.at % 1440);
    const age = s.when !== undefined ? now - s.when : 9;
    const flash = engine.playing && age >= 0 && age < 0.35;
    const amount = s.key === 'poop' ? (s.note?.amount !== undefined ? POOP_SIZE[s.note.amount]! : 1) : 1;
    const size = Math.max(2.5, rowH * 0.16) * amount * (flash ? 1.9 - age * 2.5 : 1);
    c.globalAlpha = engine.on[s.key] ? 1 : 0.2;
    c.fillStyle = color;
    if (s.key === 'pee' || s.key === 'poop') {
      c.fillRect(X - size, y - size, size * 2, size * 2);
    } else if (s.key === 'pump') {
      c.beginPath();
      c.moveTo(X, y - size * 1.2);
      c.lineTo(X + size * 1.1, y + size * 0.8);
      c.lineTo(X - size * 1.1, y + size * 0.8);
      c.closePath();
      c.fill();
    } else {
      c.beginPath();
      c.arc(X, y, size, 0, 7);
      c.fill();
    }
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.min(radius, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
