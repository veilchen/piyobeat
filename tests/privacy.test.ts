import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePiyologText } from '../src/parse/piyolog-text';
import { toNotes } from '../src/score/notes';
import { formatParsedEvents } from '../src/ui/parsed-text';
import { decodeSong, encodeSong, packSong } from '../src/share/codec';

const FIXTURE = readFileSync(new URL('./fixtures/synthetic_export_2026-01.txt', import.meta.url), 'utf8');
const ALLOWED_HEADS = new Set(['母乳', 'ミルク', '搾母乳', '搾乳', 'おしっこ', 'うんち', 'お風呂', '寝る', '起きる']);

/** Derived from the fixture, so a new free-text line in it is covered without touching this test. */
function forbiddenStrings(text: string): string[] {
  const found = new Set<string>();
  const lines = text.split('\n');
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const rec = /^\d{2}:\d{2} {3}(.+)$/.exec(line);
    if (rec) {
      const [body, ...memo] = rec[1]!.split('   ');
      memo.forEach((m) => m && found.add(m));
      if (!ALLOWED_HEADS.has(body!.split(' ')[0]!)) found.add(body!);
      return;
    }
    if (/^\d{4}\/\d+\/\d+\(.\)$/.test(lines[i - 1]?.trimEnd() ?? '')) found.add(line); // the name line
    else if (line && !/^-+$/.test(line) && !/^\d{4}\//.test(line) && !/合計/.test(line) && !/^【/.test(line)) found.add(line); // diary
  });
  return [...found];
}

function song(text: string) {
  const r = parsePiyologText(text);
  return { dayCount: r.dayCount, tempo: 6, scale: 'penta' as const, notes: toNotes(r.events, { startDay: 0, endDay: r.dayCount - 1, snap: true }) };
}

describe('free text does not survive', () => {
  const forbidden = forbiddenStrings(FIXTURE);

  it('the check has something to look for', () => {
    expect(forbidden).toEqual(expect.arrayContaining(['（自由記述メモ：破棄されるべき）', 'ママ睡眠', 'テスト (1か月10日)', '人名や病名が入りうる行。', '体重 4.52kg']));
  });

  it('parse result contains none of it', () => {
    const json = JSON.stringify(parsePiyologText(FIXTURE));
    expect(forbidden.filter((s) => json.includes(s))).toEqual([]);
  });

  it('decoded share link contains none of it', async () => {
    const json = JSON.stringify(await decodeSong(await encodeSong(song(FIXTURE))));
    expect(forbidden.filter((s) => json.includes(s))).toEqual([]);
  });

  it('debug view contains none of it, and no calendar date', () => {
    const text = formatParsedEvents(parsePiyologText(FIXTURE).events);
    expect(forbidden.filter((s) => text.includes(s))).toEqual([]);
    expect(text).not.toMatch(/2026|1\/1\d/);
    expect(text.split('\n')).toHaveLength(parsePiyologText(FIXTURE).events.length);
  });

  it('events hold numbers and enums only', () => {
    const enums = new Set(['breast', 'formula', 'expressed', 'pump', 'pee', 'poop', 'bath', 'sleep', 'L', 'R']);
    for (const e of parsePiyologText(FIXTURE).events) {
      for (const v of Object.values(e)) {
        if (typeof v === 'string') expect(enums.has(v)).toBe(true);
        else expect(typeof v).toBe('number');
      }
    }
  });
});

describe('share link hides the calendar', () => {
  /** Rewrites every date in the export by a fixed number of days, weekday letters included. */
  function shiftDates(text: string, days: number): string {
    const W = '日月火水木金土';
    return text.replace(/^(\d{4})\/(\d+)\/(\d+)\(.\)$/gm, (_m, y, mo, d) => {
      const t = new Date(Date.UTC(+y, +mo - 1, +d + days));
      return `${t.getUTCFullYear()}/${t.getUTCMonth() + 1}/${t.getUTCDate()}(${W[t.getUTCDay()]})`;
    });
  }

  it('moving the records to another date gives a byte-identical link', async () => {
    const original = await encodeSong(song(FIXTURE));
    expect(await encodeSong(song(shiftDates(FIXTURE, 300)))).toBe(original);
    expect(await encodeSong(song(shiftDates(FIXTURE, -1)))).toBe(original);
  });

  it('changing the name line or a memo gives a byte-identical link', async () => {
    const original = await encodeSong(song(FIXTURE));
    const edited = FIXTURE.replace(/テスト \(\d+か月\d+日\)/g, '別の名前 (9か月9日)').replace(/（自由記述メモ：破棄されるべき）/g, '別のメモ');
    expect(await encodeSong(song(edited))).toBe(original);
  });

  it('decoded notes carry no raw minutes or ml', () => {
    const packed = packSong(song(FIXTURE));
    expect(packed.length).toBeLessThan(4 + song(FIXTURE).notes.length * 4);
    for (const n of song(FIXTURE).notes) {
      expect(n).not.toHaveProperty('ml');
      expect(n).not.toHaveProperty('left');
      expect(n).not.toHaveProperty('right');
      expect(n).not.toHaveProperty('last');
      expect(n.minute % 15).toBe(0);
    }
  });
});
