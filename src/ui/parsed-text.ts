import type { Event } from '../parse/piyolog-text';

const AMOUNT = ['ちょこっと', '少なめ', 'ふつう', '多め'] as const;
const HARDNESS = ['かため', 'ふつう', 'やわらかめ', '下痢'] as const;

function describe(e: Event): string {
  switch (e.kind) {
    case 'breast': {
      const last = e.last ? ` 最後=${e.last === 'L' ? '左' : '右'}` : '';
      const ml = e.ml !== undefined ? ` ${e.ml}ml` : '';
      return `母乳 左${e.left ?? 0}分 右${e.right ?? 0}分${last}${ml}`;
    }
    case 'formula':
      return `ミルク ${e.ml ?? 0}ml`;
    case 'expressed':
      return `搾母乳 ${e.ml ?? 0}ml`;
    case 'pump':
      return `搾乳 ${e.ml ?? 0}ml`;
    case 'pee':
      return 'おしっこ';
    case 'poop': {
      const amount = e.amount !== undefined ? ` 量=${AMOUNT[e.amount]}` : '';
      const hardness = e.hardness !== undefined ? ` かたさ=${HARDNESS[e.hardness]}` : '';
      return `うんち${amount}${hardness}`;
    }
    case 'bath':
      return 'お風呂';
    case 'sleep':
      return `睡眠 ${e.len ?? 0}分`;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * What the parser kept, one event per line. Built from Event fields only, so it cannot show text the
 * parser dropped, and it numbers days instead of dating them, so it is safe to paste into a bug report.
 */
export function formatParsedEvents(events: readonly Event[]): string {
  return events.map((e) => `${e.day + 1}日目 ${pad(Math.floor(e.minute / 60))}:${pad(e.minute % 60)} ${describe(e)}`).join('\n');
}
