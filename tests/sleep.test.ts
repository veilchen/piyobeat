import { describe, expect, it } from 'vitest';
import { parsePiyologText } from '../src/parse/piyolog-text';
import { buildSleepIntervals, WAKE_BANG_EMITS_INTERVAL, type SleepMark } from '../src/parse/sleep';

const hm = (h: number, m = 0, day = 0) => day * 1440 + h * 60 + m;
const sleep = (at: number): SleepMark => ({ at, type: 'sleep' });
const wake = (at: number, len?: number): SleepMark => (len === undefined ? { at, type: 'wake' } : { at, type: 'wake', len });
const bangWake = (at: number): SleepMark => ({ at, type: 'wake', bang: true });

describe('buildSleepIntervals (SPEC §2-3)', () => {
  it('rule 1: pairs 寝る with the next 起きる', () => {
    expect(buildSleepIntervals([sleep(hm(1)), wake(hm(3))])).toEqual([{ start: hm(1), len: 120 }]);
  });

  it('rule 2: chains repeated 寝る (22:35, 07:00, 08:40 → 22:35-08:40)', () => {
    expect(buildSleepIntervals([sleep(hm(22, 35)), sleep(hm(7, 0, 1)), wake(hm(8, 40, 1))])).toEqual([
      { start: hm(22, 35), len: 605 },
    ]);
  });

  it('rule 2 beats an explicit length when a chain is open', () => {
    expect(buildSleepIntervals([sleep(hm(20)), sleep(hm(0, 20, 1)), wake(hm(3, 10, 1), 170)])).toEqual([
      { start: hm(20), len: 430 },
    ]);
  });

  it('rule 3: back-computes from 起きる (N時間N分) with no open 寝る', () => {
    expect(buildSleepIntervals([wake(hm(10), 90)])).toEqual([{ start: hm(8, 30), len: 90 }]);
  });

  it('rule 3: clips a start before day 0', () => {
    expect(buildSleepIntervals([wake(hm(1), 180)])).toEqual([{ start: 0, len: 60 }]);
  });

  it('rule 4: drops intervals over 14 hours and accepts exactly 14', () => {
    expect(buildSleepIntervals([sleep(0), wake(841)])).toEqual([]);
    expect(buildSleepIntervals([sleep(0), wake(840)])).toEqual([{ start: 0, len: 840 }]);
    expect(buildSleepIntervals([wake(1000, 841)])).toEqual([]);
  });

  it('起きる ( ! ) alone makes no interval', () => {
    expect(buildSleepIntervals([bangWake(hm(10))])).toEqual([]);
  });

  it('起きる ( ! ) closes an open 寝る so the next night survives', () => {
    const marks = [sleep(hm(9)), bangWake(hm(10, 30)), sleep(hm(20)), sleep(hm(0, 20, 1)), wake(hm(3, 10, 1), 170)];
    const night = { start: hm(20), len: 430 };
    expect(buildSleepIntervals(marks)).toEqual(
      WAKE_BANG_EMITS_INTERVAL ? [{ start: hm(9), len: 90 }, night] : [night],
    );
  });

  it('discards a 寝る that never closes and a zero-length pair', () => {
    expect(buildSleepIntervals([sleep(hm(1)), wake(hm(1)), sleep(hm(2))])).toEqual([]);
  });
});

describe('through the parser', () => {
  const block = (date: string, lines: string[]) => ['----------', date, 'テスト (1か月10日)', '', ...lines, ''].join('\n');

  it('builds a sleep crossing midnight on its starting day', () => {
    const r = parsePiyologText(block('2026/1/10(土)', ['22:00   寝る   ']) + block('2026/1/11(日)', ['06:00   起きる (8時間0分)   ']));
    expect(r.events).toEqual([{ day: 0, minute: 1320, kind: 'sleep', len: 480 }]);
  });

  it('reads 寝る ( ! ) as a continuation', () => {
    const r = parsePiyologText(block('2026/1/10(土)', ['22:35   寝る   ']) + block('2026/1/11(日)', ['07:00   寝る ( ! )   ', '08:40   起きる   ']));
    expect(r.events).toEqual([{ day: 0, minute: 1355, kind: 'sleep', len: 605 }]);
  });
});
