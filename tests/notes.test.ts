import { describe, expect, it } from 'vitest';
import type { Event } from '../src/parse/piyolog-text';
import { applyJitter, levelOf, Side, toNotes } from '../src/score/notes';

const opts = { startDay: 0, endDay: 1, snap: true };
const pee = (day: number, minute: number): Event => ({ day, minute, kind: 'pee' });

describe('toNotes', () => {
  it('snaps to the nearest slot', () => {
    expect(toNotes([pee(0, 607)], opts)[0]).toMatchObject({ day: 0, minute: 600 });
    expect(toNotes([pee(0, 608)], opts)[0]).toMatchObject({ day: 0, minute: 615 });
  });

  it('rolls 23:53 into the next day', () => {
    expect(toNotes([pee(0, 1433)], opts)[0]).toMatchObject({ day: 1, minute: 0 });
  });

  it('keeps 23:53 on the last day of the range', () => {
    expect(toNotes([pee(1, 1433)], opts)[0]).toMatchObject({ day: 1, minute: 1425 });
  });

  it('keeps exact minutes when snap is off', () => {
    expect(toNotes([pee(0, 607)], { ...opts, snap: false })[0]).toMatchObject({ minute: 607 });
  });

  it('re-zeros days and drops events outside the range', () => {
    const notes = toNotes([pee(4, 0), pee(5, 0), pee(6, 0), pee(7, 0)], { startDay: 5, endDay: 6, snap: true });
    expect(notes.map((n) => n.day)).toEqual([0, 1]);
  });

  it('clips a sleep that starts before the range', () => {
    const s: Event = { day: 4, minute: 1380, kind: 'sleep', len: 120 };
    expect(toNotes([s], { startDay: 5, endDay: 6, snap: true })[0]).toMatchObject({ day: 0, minute: 0, len: 60 });
  });

  it('drops a sleep that ended before the range', () => {
    const s: Event = { day: 4, minute: 1380, kind: 'sleep', len: 30 };
    expect(toNotes([s], { startDay: 5, endDay: 6, snap: true })).toEqual([]);
  });

  it('clips a sleep at the end of the range', () => {
    const s: Event = { day: 1, minute: 1380, kind: 'sleep', len: 240 };
    expect(toNotes([s], opts)[0]).toMatchObject({ day: 1, minute: 1380, len: 60 });
  });

  it('gives short sleeps at least one slot', () => {
    const s: Event = { day: 0, minute: 0, kind: 'sleep', len: 3 };
    expect(toNotes([s], opts)[0]).toMatchObject({ len: 15 });
  });

  it('pans by side and keeps pooled feeds centred', () => {
    const b = (left: number, right: number): Event => ({ day: 0, minute: 0, kind: 'breast', left, right });
    expect(toNotes([b(5, 0)], opts)[0]!.side).toBe(Side.Left);
    expect(toNotes([b(0, 5)], opts)[0]!.side).toBe(Side.Right);
    expect(toNotes([b(5, 5)], opts)[0]!.side).toBe(Side.Both);
    expect(toNotes([b(0, 0)], opts)[0]!.side).toBe(Side.Both);
  });
});

describe('levelOf', () => {
  it('stays within 8 levels and rises with intake', () => {
    expect(levelOf({ day: 0, minute: 0, kind: 'breast', left: 0, right: 0 })).toBe(0);
    expect(levelOf({ day: 0, minute: 0, kind: 'breast', left: 90, right: 90 })).toBe(7);
    expect(levelOf({ day: 0, minute: 0, kind: 'formula', ml: 100 })).toBe(4);
    expect(levelOf({ day: 0, minute: 0, kind: 'expressed', ml: 400 })).toBe(7);
    expect(levelOf({ day: 0, minute: 0, kind: 'pump', ml: 400 })).toBe(0);
  });
});

describe('applyJitter', () => {
  const notes = toNotes([pee(0, 0), pee(1, 1425), pee(0, 720)], opts);

  it('moves by at most one slot and stays in range', () => {
    for (const r of [0, 0.5, 0.999]) {
      const moved = applyJitter(notes, 2, () => r);
      for (const n of moved) {
        expect(n.day).toBeGreaterThanOrEqual(0);
        expect(n.day * 1440 + n.minute).toBeLessThan(2 * 1440);
        expect(n.minute % 15).toBe(0);
      }
    }
    expect(applyJitter(notes, 2, () => 0).map((n) => n.day * 1440 + n.minute)).toEqual([0, 705, 2 * 1440 - 30]);
    expect(applyJitter(notes, 2, () => 0.999).map((n) => n.day * 1440 + n.minute)).toEqual([15, 735, 2 * 1440 - 15]);
  });
});
