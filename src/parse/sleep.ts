/** A 寝る / 起きる record, in absolute minutes from the first day of the input. */
export interface SleepMark {
  at: number;
  type: 'sleep' | 'wake';
  /** 起きる ( ! ) */
  bang?: boolean;
  /** 起きる (N時間N分), in minutes */
  len?: number;
}

export interface SleepInterval {
  start: number;
  len: number;
}

const MAX_SLEEP_MINUTES = 14 * 60;

/**
 * Whether 起きる ( ! ) that follows an open 寝る yields an interval.
 * true: the pair becomes an interval, as in the prototype. false: it only closes the open 寝る.
 * Either way it must close it: otherwise rule 2 chains on into the next night and rule 4 drops it.
 */
export const WAKE_BANG_EMITS_INTERVAL = true;

/** Rules from SPEC §2-3. Marks must be in time order; marks at the same minute keep file order. */
export function buildSleepIntervals(marks: readonly SleepMark[]): SleepInterval[] {
  const out: SleepInterval[] = [];
  let open: number | null = null;
  for (const m of marks) {
    if (m.type === 'sleep') {
      // Rule 2: a repeated 寝る continues the sleep that is still open.
      if (open === null) open = m.at;
      continue;
    }
    if (open !== null) {
      const len = m.at - open;
      if (len > 0 && len <= MAX_SLEEP_MINUTES && (!m.bang || WAKE_BANG_EMITS_INTERVAL)) {
        out.push({ start: open, len });
      }
      open = null;
    } else if (m.len !== undefined && m.len <= MAX_SLEEP_MINUTES) {
      // Rule 3: back-compute the start, clipped to day 0 because relative days are unsigned.
      const start = Math.max(0, m.at - m.len);
      if (m.at > start) out.push({ start, len: m.at - start });
    }
  }
  return out;
}
