import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePiyologText, type Event, type Kind } from '../src/parse/piyolog-text';

const FIXTURE = readFileSync(new URL('./fixtures/synthetic_export_2026-01.txt', import.meta.url), 'utf8');

function day(lines: string[], date = '2026/1/10(土)'): string {
  return ['----------', date, 'テスト (1か月10日)', '', ...lines, '', 'おしっこ合計   0回', '', '日記', '----------'].join('\n');
}
function one(body: string): Event {
  const { events } = parsePiyologText(day([`10:00   ${body}   `]));
  expect(events).toHaveLength(1);
  return events[0]!;
}
function strip(e: Event) {
  const { day: _d, minute: _m, ...rest } = e;
  return rest;
}

describe('record patterns (SPEC §2-2)', () => {
  it.each<[string, Partial<Event>]>([
    ['母乳 左 10分 → 右 12分', { kind: 'breast', left: 10, right: 12, last: 'R' }],
    ['母乳 左 11分 ← 右 10分', { kind: 'breast', left: 11, right: 10, last: 'L' }],
    ['母乳 左 1分 / 右 1分', { kind: 'breast', left: 1, right: 1 }],
    ['母乳 左 25分', { kind: 'breast', left: 25, right: 0, last: 'L' }],
    ['母乳 右 7分', { kind: 'breast', left: 0, right: 7, last: 'R' }],
    ['母乳 左 8分 → 右 7分 (85ml)', { kind: 'breast', left: 8, right: 7, last: 'R', ml: 85 }],
    ['母乳 母乳', { kind: 'breast', left: 0, right: 0 }],
    ['母乳 母乳 (5ml)', { kind: 'breast', left: 0, right: 0, ml: 5 }],
    ['ミルク 80ml', { kind: 'formula', ml: 80 }],
    ['搾母乳 30ml', { kind: 'expressed', ml: 30 }],
    ['搾乳 30ml', { kind: 'pump', ml: 30 }],
    ['おしっこ', { kind: 'pee' }],
    ['お風呂', { kind: 'bath' }],
    ['うんち', { kind: 'poop' }],
    ['うんち (多め/やわらかめ/茶色)', { kind: 'poop', amount: 3, hardness: 2 }],
    ['うんち (少なめ/ふつう/黄色)', { kind: 'poop', amount: 1, hardness: 1 }],
    ['うんち (ちょこっと)', { kind: 'poop', amount: 0 }],
    ['うんち (かため/橙)', { kind: 'poop', hardness: 0 }],
    ['うんち (ふつう/(ふつう))', { kind: 'poop', amount: 2, hardness: 1 }],
    ['うんち (ふつう/(ふつう)/橙)', { kind: 'poop', amount: 2, hardness: 1 }],
    ['うんち ((ふつう))', { kind: 'poop', hardness: 1 }],
    ['うんち (ふつう)', { kind: 'poop', amount: 2 }],
    ['うんち (下痢)', { kind: 'poop', hardness: 3 }],
    ['うんち (茶色)', { kind: 'poop' }],
  ])('%s', (body, expected) => {
    expect(strip(one(body))).toEqual(expected);
  });

  it('drops the memo after the second triple space', () => {
    expect(strip(one('ミルク 80ml   メモ 120ml 左 3分'))).toEqual({ kind: 'formula', ml: 80 });
  });

  it('keeps time and day from the line', () => {
    const { events } = parsePiyologText(day(['23:59   おしっこ   ']));
    expect(events[0]).toMatchObject({ day: 0, minute: 1439 });
  });
});

describe('allowlist', () => {
  it.each(['体重 4.52kg', '体温 36.8°C', 'メモ', 'くすり', '病院', '予防接種', '吐く', 'さんぽ', 'できた', 'その他', 'ママ睡眠', '母乳メモ', '搾母乳メモ 30ml', '寝る前の絵本'])(
    '%s is discarded and not counted as unreadable',
    (body) => {
      const r = parsePiyologText(day([`10:00   ${body}   `]));
      expect(r.events).toEqual([]);
      expect(r.unreadable).toBe(0);
    },
  );

  it('counts known kinds it cannot read, without keeping them', () => {
    const r = parsePiyologText(day(['10:00   ミルク たくさん   ', '11:00   母乳 ???   ', '12:00   おしっこ たくさん   ']));
    expect(r.events).toEqual([]);
    expect(r.unreadable).toBe(3);
  });

  it('ignores a diary line shaped like a record', () => {
    const text = ['----------', '2026/1/10(土)', 'テスト (1か月10日)', '', '10:00   おしっこ   ', '', 'おしっこ合計   1回', '', '12:00   おしっこ', '2026/1/11(日)', '13:00   ミルク 100ml', '----------'].join('\n');
    const r = parsePiyologText(text);
    expect(r.events.map((e) => e.minute)).toEqual([600]);
    expect(r.dayCount).toBe(1);
  });

  it('never throws on arbitrary input', () => {
    for (const s of ['', '\n\n', 'hello', '----------', '----------\n2026/13/99(木)\n10:00   おしっこ', '25:00   おしっこ']) {
      expect(parsePiyologText(s).events).toEqual([]);
    }
  });
});

describe('multiple months', () => {
  const a = day(['10:00   おしっこ   '], '2026/1/31(土)');
  const b = day(['11:00   おしっこ   '], '2026/2/2(月)');

  it('counts days across a month boundary, including empty days', () => {
    const r = parsePiyologText(a + '\n' + b);
    expect(r.dayCount).toBe(3);
    expect(r.startDate).toEqual({ y: 2026, m: 1, d: 31 });
    expect(r.events.map((e) => e.day)).toEqual([0, 2]);
  });

  it('accepts files in any order', () => {
    expect(parsePiyologText(b + '\n' + a)).toEqual(parsePiyologText(a + '\n' + b));
  });

  it('keeps one copy of a day pasted twice', () => {
    expect(parsePiyologText(a + '\n' + a)).toEqual(parsePiyologText(a));
  });

  it('handles CRLF and a BOM', () => {
    expect(parsePiyologText('﻿' + a.replace(/\n/g, '\r\n'))).toEqual(parsePiyologText(a));
  });
});

describe('synthetic export', () => {
  const r = parsePiyologText(FIXTURE);
  const count = (k: Kind) => r.events.filter((e) => e.kind === k).length;

  it('reads every record', () => {
    expect(r.startDate).toEqual({ y: 2026, m: 1, d: 10 });
    expect(r.dayCount).toBe(5);
    expect(r.unreadable).toBe(0);
    expect(count('breast')).toBe(54);
    expect(count('formula')).toBe(18);
    expect(count('expressed')).toBe(5);
    expect(count('pee')).toBe(44);
    expect(count('poop')).toBe(9);
    expect(count('bath')).toBe(5);
  });

  // The fixture's summary lines are fixed placeholders, so per-day counts compare with the raw lines.
  it('matches an independent per-day tally of the raw lines', () => {
    const blocks = FIXTURE.split(/^-{10}$/m).filter((b) => /^\d{4}\//m.test(b));
    const tally = (block: string, head: string) => block.split('\n').filter((l) => l.slice(5).startsWith(`   ${head} `)).length;
    blocks.forEach((block, i) => {
      const onDay = (k: Kind) => r.events.filter((e) => e.day === i && e.kind === k).length;
      expect(onDay('pee')).toBe(tally(block, 'おしっこ'));
      expect(onDay('poop')).toBe(tally(block, 'うんち'));
      expect(onDay('breast')).toBe(tally(block, '母乳'));
      expect(onDay('formula')).toBe(tally(block, 'ミルク'));
    });
  });
});
