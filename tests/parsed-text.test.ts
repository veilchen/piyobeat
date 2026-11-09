import { describe, expect, it } from 'vitest';
import { parsePiyologText } from '../src/parse/piyolog-text';
import { formatParsedEvents } from '../src/ui/parsed-text';

const lines = (records: string[]) =>
  formatParsedEvents(parsePiyologText(['----------', '2026/1/10(土)', 'テスト (1か月10日)', '', ...records, '', 'おしっこ合計   0回', ''].join('\n')).events).split('\n');

describe('formatParsedEvents', () => {
  it.each([
    ['母乳 左 10分 → 右 12分', '母乳 左10分 右12分 最後=右'],
    ['母乳 左 8分 ← 右 7分 (85ml)', '母乳 左8分 右7分 最後=左 85ml'],
    ['母乳 母乳', '母乳 左0分 右0分'],
    ['ミルク 80ml', 'ミルク 80ml'],
    ['搾母乳 30ml', '搾母乳 30ml'],
    ['搾乳 30ml', '搾乳 30ml'],
    ['おしっこ', 'おしっこ'],
    ['お風呂', 'お風呂'],
    ['うんち', 'うんち'],
    ['うんち (多め/下痢/茶色)   メモ', 'うんち 量=多め かたさ=下痢'],
  ])('%s', (body, expected) => {
    expect(lines([`07:05   ${body}   `])).toEqual([`1日目 07:05 ${expected}`]);
  });

  it('shows sleep as an interval', () => {
    expect(lines(['01:00   寝る   ', '03:30   起きる (2時間30分)   '])).toEqual(['1日目 01:00 睡眠 150分']);
  });
});
