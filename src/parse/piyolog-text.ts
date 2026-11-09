import { buildSleepIntervals, type SleepMark } from './sleep';

export type Kind = 'breast' | 'formula' | 'expressed' | 'pump' | 'pee' | 'poop' | 'bath' | 'sleep';
export const KINDS: readonly Kind[] = ['breast', 'formula', 'expressed', 'pump', 'pee', 'poop', 'bath', 'sleep'];

/** Numbers and enums only, so free text has no path past the parser. */
export interface Event {
  day: number;
  minute: number;
  kind: Kind;
  left?: number;
  right?: number;
  last?: 'L' | 'R';
  ml?: number;
  amount?: 0 | 1 | 2 | 3;
  hardness?: 0 | 1 | 2 | 3;
  len?: number;
}

export interface CalendarDate {
  y: number;
  m: number;
  d: number;
}

export interface ParseResult {
  events: Event[];
  /** For on-screen labels only. Never goes into a share link. */
  startDate: CalendarDate | null;
  dayCount: number;
  /** Records of a known kind whose body could not be read. A count only, never the lines. */
  unreadable: number;
}

const SEPARATOR = /^-{5,}$/;
const DATE_LINE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\(.\)$/;
const RECORD_LINE = /^(\d{2}):(\d{2}) {3}(.+)$/;
const SUMMARY_LINE = /^(母乳|ミルク|睡眠|おしっこ|うんち)合計/;

const AMOUNT: Readonly<Record<string, 0 | 1 | 2 | 3>> = { ちょこっと: 0, 少なめ: 1, ふつう: 2, 多め: 3 };
const HARDNESS: Readonly<Record<string, 0 | 1 | 2 | 3>> = {
  かため: 0,
  ふつう: 1,
  '(ふつう)': 1,
  やわらかめ: 2,
  下痢: 3,
};

/** Without the time and day, which the caller adds. null = known kind but unreadable. */
type Body = Omit<Event, 'day' | 'minute'>;
type SleepBody = Pick<SleepMark, 'type' | 'bang' | 'len'>;
type BodyReader = (body: string) => Body | SleepBody | null;

function int(s: string | undefined): number | undefined {
  return s === undefined ? undefined : Number(s);
}

function readBreast(body: string): Body | null {
  const ml = '(?: \\((\\d+)ml\\))?$';
  let m = new RegExp('^母乳 母乳' + ml).exec(body);
  if (m) return withMl({ kind: 'breast', left: 0, right: 0 }, m[1]);
  m = new RegExp('^母乳 左 (\\d+)分 (→|←|/) 右 (\\d+)分' + ml).exec(body);
  if (m) {
    const e: Body = { kind: 'breast', left: Number(m[1]), right: Number(m[3]) };
    // The arrowhead points at the side fed last.
    if (m[2] === '→') e.last = 'R';
    if (m[2] === '←') e.last = 'L';
    return withMl(e, m[4]);
  }
  m = new RegExp('^母乳 (左|右) (\\d+)分' + ml).exec(body);
  if (m) {
    const min = Number(m[2]);
    const e: Body = m[1] === '左'
      ? { kind: 'breast', left: min, right: 0, last: 'L' }
      : { kind: 'breast', left: 0, right: min, last: 'R' };
    return withMl(e, m[3]);
  }
  return null;
}

function withMl(e: Body, ml: string | undefined): Body {
  if (ml !== undefined) e.ml = Number(ml);
  return e;
}

function readMl(kind: Kind): BodyReader {
  return (body) => {
    const m = /^\S+ (\d+)ml$/.exec(body);
    return m ? { kind, ml: Number(m[1]) } : null;
  };
}

function readPoop(body: string): Body | null {
  if (body === 'うんち') return { kind: 'poop' };
  // Greedy, because qualifiers can nest: うんち (ふつう/(ふつう)/橙)
  const m = /^うんち \((.*)\)$/.exec(body);
  if (!m) return null;
  const e: Body = { kind: 'poop' };
  m[1]!.split('/').forEach((token, i) => {
    // ふつう is both an amount and a hardness; it is an amount only in first position.
    if (i === 0 && token in AMOUNT) e.amount = AMOUNT[token];
    else if (token in HARDNESS) e.hardness = HARDNESS[token];
  });
  return e;
}

function readSleep(body: string): SleepBody | null {
  return /^寝る(?: \( ! \))?$/.test(body) ? { type: 'sleep' } : null;
}

function readWake(body: string): SleepBody | null {
  if (body === '起きる') return { type: 'wake' };
  if (body === '起きる ( ! )') return { type: 'wake', bang: true };
  const m = /^起きる \((?:(\d+)時間)?(?:(\d+)分)?\)$/.exec(body);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  return { type: 'wake', len: (int(m[1]) ?? 0) * 60 + (int(m[2]) ?? 0) };
}

function exact(text: string, kind: Kind): BodyReader {
  return (body) => (body === text ? { kind } : null);
}

/** The allowlist. Matched on the exact first token, so 搾母乳 is not 母乳 and custom items never match. */
const READERS: ReadonlyMap<string, BodyReader> = new Map<string, BodyReader>([
  ['母乳', readBreast],
  ['ミルク', readMl('formula')],
  ['搾母乳', readMl('expressed')],
  ['搾乳', readMl('pump')],
  ['おしっこ', exact('おしっこ', 'pee')],
  ['うんち', readPoop],
  ['お風呂', exact('お風呂', 'bath')],
  ['寝る', readSleep],
  ['起きる', readWake],
]);

function dayNumber(y: number, m: number, d: number): number | null {
  const ms = Date.UTC(y, m - 1, d);
  const t = new Date(ms);
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.floor(ms / 864e5);
}

interface DayBlock {
  number: number;
  date: CalendarDate;
  items: { minute: number; body: Body | SleepBody }[];
  unreadable: number;
}

/**
 * One or more exports, pasted together or in any order. A day seen twice keeps the copy with the most
 * records, because an export made partway through a day or month stops short of a later one.
 */
export function parsePiyologText(text: string): ParseResult {
  const blocks: DayBlock[] = [];
  let current: DayBlock | null = null;
  let afterSeparator = true; // a date line only counts right after a separator (or at the start of a file)
  let inRecords = false;

  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (SEPARATOR.test(line)) {
      afterSeparator = true;
      inRecords = false;
      current = null;
      continue;
    }
    if (afterSeparator) {
      if (line === '') continue;
      afterSeparator = false;
      const dm = DATE_LINE.exec(line);
      if (dm) {
        const [y, m, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
        const n = dayNumber(y, m, d);
        if (n !== null) {
          current = { number: n, date: { y, m, d }, items: [], unreadable: 0 };
          blocks.push(current);
          inRecords = true;
        }
      }
      continue;
    }
    if (!inRecords || !current) continue;
    // Everything from the summary lines on is discarded, so a diary line shaped like a record cannot count.
    // A blank line does not end the records: a memo can contain line breaks.
    if (SUMMARY_LINE.test(line)) {
      inRecords = false;
      continue;
    }
    const rec = RECORD_LINE.exec(rawLine.replace(/\r$/, ''));
    if (!rec) continue;
    const hh = Number(rec[1]);
    const mm = Number(rec[2]);
    if (hh > 23 || mm > 59) continue;
    // parts[1..] is the memo: dropped here and never read.
    const body = rec[3]!.split('   ')[0]!.trimEnd();
    const reader = READERS.get(body.split(' ')[0]!);
    if (!reader) continue; // custom and discarded items: not even counted
    const parsed = reader(body);
    if (parsed === null) current.unreadable++;
    else current.items.push({ minute: hh * 60 + mm, body: parsed });
  }

  const best = new Map<number, DayBlock>();
  for (const block of blocks) {
    const kept = best.get(block.number);
    if (!kept || recordCount(block) > recordCount(kept)) best.set(block.number, block);
  }
  return assemble([...best.values()]);
}

const recordCount = (block: DayBlock) => block.items.length + block.unreadable;

function assemble(blocks: DayBlock[]): ParseResult {
  const unreadable = blocks.reduce((sum, b) => sum + b.unreadable, 0);
  if (blocks.length === 0) return { events: [], startDate: null, dayCount: 0, unreadable };
  blocks.sort((a, b) => a.number - b.number);
  const first = blocks[0]!;
  const events: Event[] = [];
  const marks: SleepMark[] = [];
  for (const block of blocks) {
    const day = block.number - first.number;
    const items = block.items
      .map((item, i) => ({ item, i }))
      .sort((a, b) => a.item.minute - b.item.minute || a.i - b.i);
    for (const { item } of items) {
      if ('type' in item.body) marks.push({ at: day * 1440 + item.minute, ...item.body });
      else events.push({ day, minute: item.minute, ...item.body });
    }
  }
  for (const s of buildSleepIntervals(marks)) {
    events.push({ day: Math.floor(s.start / 1440), minute: s.start % 1440, kind: 'sleep', len: s.len });
  }
  events.sort((a, b) => a.day - b.day || a.minute - b.minute);
  return {
    events,
    startDate: first.date,
    dayCount: blocks[blocks.length - 1]!.number - first.number + 1,
    unreadable,
  };
}
