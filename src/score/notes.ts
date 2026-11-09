import type { Event, Kind } from '../parse/piyolog-text';

export const SLOT_MINUTES = 15;
export const SLOTS_PER_DAY = 96;
const DAY = 1440;

export const enum Side {
  Both = 0,
  Left = 1,
  Right = 2,
}

/**
 * What the score and the audio read. Raw minutes and ml stop here: playback and share links both
 * use these binned values, so a link plays the same song as the sharer heard.
 */
export interface Note {
  /** Relative to the start of the selected range. */
  day: number;
  minute: number;
  kind: Kind;
  /** Feeds: 0 (little) .. 7 (a lot). */
  level: number;
  /** Breast only: which side is panned. */
  side: Side;
  amount?: 0 | 1 | 2 | 3;
  hardness?: 0 | 1 | 2 | 3;
  /** Sleep only: length in minutes. */
  len?: number;
}

export interface NoteOptions {
  /** First and last day to include (inclusive), in the parser's day numbering. */
  startDay: number;
  endDay: number;
  snap: boolean;
}

const clampLevel = (n: number) => Math.min(7, Math.max(0, n));

export function levelOf(e: Event): number {
  switch (e.kind) {
    case 'breast':
      return clampLevel(Math.round(((e.left ?? 0) + (e.right ?? 0)) / 4));
    case 'formula':
    case 'expressed':
      return clampLevel(Math.round((e.ml ?? 0) / 25));
    default:
      return 0;
  }
}

function sideOf(e: Event): Side {
  if (e.kind !== 'breast') return Side.Both;
  if (e.left && !e.right) return Side.Left;
  if (e.right && !e.left) return Side.Right;
  return Side.Both;
}

export function toNotes(events: readonly Event[], opts: NoteOptions): Note[] {
  const rangeEnd = (opts.endDay - opts.startDay + 1) * DAY;
  const lastSlotStart = rangeEnd - SLOT_MINUTES;
  const notes: Note[] = [];
  for (const e of events) {
    let at = (e.day - opts.startDay) * DAY + e.minute;
    let len = e.len;
    if (e.kind === 'sleep' && len !== undefined) {
      // A sleep that began before the range still sounds for the part inside it.
      if (at < 0) {
        len += at;
        at = 0;
        if (len <= 0) continue;
      }
    } else if (at < 0) {
      continue;
    }
    if (at >= rangeEnd) continue;
    if (opts.snap) {
      // Rounding 23:53 gives 24:00, which rolls into the next day; the very last day has no next day.
      at = Math.min(Math.round(at / SLOT_MINUTES) * SLOT_MINUTES, lastSlotStart);
      if (len !== undefined) len = Math.max(1, Math.round(len / SLOT_MINUTES)) * SLOT_MINUTES;
    }
    if (len !== undefined) len = Math.min(len, rangeEnd - at);
    const note: Note = { day: Math.floor(at / DAY), minute: at % DAY, kind: e.kind, level: levelOf(e), side: sideOf(e) };
    if (e.amount !== undefined) note.amount = e.amount;
    if (e.hardness !== undefined) note.hardness = e.hardness;
    if (len !== undefined) note.len = len;
    notes.push(note);
  }
  return sortNotes(notes);
}

export function sortNotes(notes: Note[]): Note[] {
  return notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => a.n.day - b.n.day || a.n.minute - b.n.minute || a.i - b.i)
    .map(({ n }) => n);
}

/** Moves each snapped note by -1, 0 or +1 slot. Applied once when a link is made, so every listener hears the same song. */
export function applyJitter(notes: readonly Note[], dayCount: number, random: () => number = Math.random): Note[] {
  const rangeEnd = dayCount * DAY;
  return sortNotes(
    notes.map((n) => {
      const shift = (Math.floor(random() * 3) - 1) * SLOT_MINUTES;
      const at = Math.min(Math.max(0, n.day * DAY + n.minute + shift), rangeEnd - SLOT_MINUTES);
      const moved: Note = { ...n, day: Math.floor(at / DAY), minute: at % DAY };
      if (moved.len !== undefined) moved.len = Math.min(moved.len, rangeEnd - at);
      return moved;
    }),
  );
}
