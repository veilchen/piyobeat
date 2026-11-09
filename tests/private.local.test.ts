import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePiyologText } from '../src/parse/piyolog-text';

/**
 * Local only: compares the parser with the summary lines of the real exports in private/.
 * Skipped when private/ has no files, so it never runs in CI.
 * Reports counts of mismatching days and nothing else: no dates, values or line text, in passing or failing output.
 */
const DIR = new URL('../private/', import.meta.url);
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.txt')) : [];

interface Totals {
  pee: number;
  poop: number;
  formula: number;
  formulaMl: number;
  left: number;
  right: number;
}

/** Summary lines per calendar day number. A day exported more than once has one entry per copy. */
function readSummaries(text: string): Map<number, Totals[]> {
  const out = new Map<number, Totals[]>();
  let current: Totals | null = null;
  let afterSeparator = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^-{5,}\s*$/.test(line)) {
      afterSeparator = true;
      continue;
    }
    const date = afterSeparator ? /^(\d{4})\/(\d+)\/(\d+)\(.\)$/.exec(line.trimEnd()) : null;
    if (line.trim()) afterSeparator = false;
    if (date) {
      current = { pee: 0, poop: 0, formula: 0, formulaMl: 0, left: 0, right: 0 };
      const n = Date.UTC(+date[1]!, +date[2]! - 1, +date[3]!) / 864e5;
      out.set(n, [...(out.get(n) ?? []), current]);
    }
    if (!current) continue;
    let m;
    if ((m = /^おしっこ合計\s+(\d+)回/.exec(line))) current.pee = +m[1]!;
    if ((m = /^うんち合計\s+(\d+)回/.exec(line))) current.poop = +m[1]!;
    if ((m = /^ミルク合計\s+(\d+)回(?:\s+(\d+)ml)?/.exec(line))) {
      current.formula = +m[1]!;
      current.formulaMl = +(m[2] ?? 0);
    }
    if (/^母乳合計/.test(line)) {
      current.left = +(/左\s*(\d+)分/.exec(line)?.[1] ?? 0);
      current.right = +(/右\s*(\d+)分/.exec(line)?.[1] ?? 0);
    }
  }
  return out;
}

describe.skipIf(files.length === 0)('real exports (private/)', () => {
  const texts = files.map((f) => readFileSync(new URL(f, DIR), 'utf8'));
  const all = texts.join('\n');
  const parsed = parsePiyologText(all);
  const summaries = readSummaries(all);
  const start = parsed.startDate;
  const firstDay = start ? Date.UTC(start.y, start.m - 1, start.d) / 864e5 : 0;

  const tallied = (d: number): Totals => {
    const t: Totals = { pee: 0, poop: 0, formula: 0, formulaMl: 0, left: 0, right: 0 };
    for (const e of parsed.events) {
      if (e.day !== d) continue;
      if (e.kind === 'pee') t.pee++;
      if (e.kind === 'poop') t.poop++;
      if (e.kind === 'formula') {
        t.formula++;
        t.formulaMl += e.ml ?? 0;
      }
      if (e.kind === 'breast') {
        t.left += e.left ?? 0;
        t.right += e.right ?? 0;
      }
    }
    return t;
  };

  it('reads every record of a known kind', () => {
    expect(parsed.unreadable).toBe(0);
  });

  it('has a summary for every day', () => {
    expect(summaries.size).toBe(parsed.dayCount);
  });

  // The kept copy of a day is the fullest one, so a day passes if it matches any copy's summary.
  // The app rounds breast minutes per record and again for the day, so totals may differ by up to one minute per record.
  it.each(['left', 'right'] as const)('%s is within rounding on every day', (field) => {
    let mismatchedDays = 0;
    for (const [n, copies] of summaries) {
      const records = parsed.events.filter((e) => e.day === n - firstDay && e.kind === 'breast').length;
      const value = tallied(n - firstDay)[field];
      if (!copies.some((c) => Math.abs(c[field] - value) <= records)) mismatchedDays++;
    }
    expect(mismatchedDays).toBe(0);
  });

  it.each(['pee', 'poop', 'formula', 'formulaMl'] as const)('%s matches on every day', (field) => {
    let mismatchedDays = 0;
    for (const [n, copies] of summaries) {
      const value = tallied(n - firstDay)[field];
      if (!copies.some((c) => c[field] === value)) mismatchedDays++;
    }
    expect(mismatchedDays).toBe(0);
  });
});
