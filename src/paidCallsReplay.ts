import { PAID_CALLS_SHOW_DELAY_MS } from '../shared/paid-calls';

/*
 * Each paid service call at its own moment (src/PaidCallsTicker.tsx). Pure: a function of the
 * latest response, when it arrived, its Age, the value last shown and now, so it is tested with a
 * fake clock (tests/paid-calls-replay.test.ts).
 *
 * - Each recent payment is due at `arrived - Age*1000 - recent_ms[i] + 45 000` (this browser's
 *   clock): the moment the copy was made, back to the payment's block, plus the delay that covers
 *   the edge's 15 s freshness, the 15 s poll and the settle check. Payments closer together than
 *   PAID_CALLS_STEP_GAP_MS (several in one Base block) are spaced that far apart, so each is its
 *   own +1 with its own roll and ring.
 * - The value now is the total minus the listed payments not yet due. Payments outside the window,
 *   and those beyond the 64 listed when `recent_complete` is false, are already due: they are in
 *   the total and show at once.
 * - Shown = the larger of that value and the last value shown, so the number never steps back on
 *   clock jitter between copies. A response with an older `as_of` (another edge's copy) is
 *   ignored, and so is one with the same `as_of` (the same read served again, for example the
 *   server's last good row while its database is slow): the copy held keeps its arrival time, so
 *   it greys once it is old. A lower total than the copy before is a repair: shown at once, even if lower.
 * - The first value is shown at once: no count from 0.
 *
 * So the number shown is the real total as it stood 45 s earlier, one +1 per payment.
 */

export interface ReplayCopy {
  total: number;
  /** `as_of`, epoch ms on the server's clock (only compared with other copies). */
  asOf: number;
  /** Milliseconds from each recent payment's block to `as_of`. */
  recentMs: readonly number[];
  /** The edge's Age header, seconds (0 when missing). */
  ageS: number;
  /** When the response arrived, epoch ms on this browser's clock. */
  arrived: number;
}

export interface ReplayState {
  copy: ReplayCopy;
  shown: number;
}

/**
 * Payments due closer together than this (several in one 2 s Base block) are spaced this far
 * apart: longer than the 300 ms roll, so each shows as its own +1.
 */
export const PAID_CALLS_STEP_GAP_MS = 400;

/**
 * When each listed payment is due on this browser's clock, earliest first, at least
 * PAID_CALLS_STEP_GAP_MS apart.
 */
export function dueTimes(copy: ReplayCopy, delayMs = PAID_CALLS_SHOW_DELAY_MS): number[] {
  const made = copy.arrived - copy.ageS * 1000;
  const due = copy.recentMs.map((ms) => made - ms + delayMs).sort((a, b) => a - b);
  for (let i = 1; i < due.length; i++)
    due[i] = Math.max(due[i]!, due[i - 1]! + PAID_CALLS_STEP_GAP_MS);
  return due;
}

/** The copy's value at `now`: its total minus the listed payments not yet due. */
export function valueAt(copy: ReplayCopy, now: number): number {
  const waiting = dueTimes(copy).filter((at) => at > now).length;
  return Math.max(0, copy.total - waiting);
}

/**
 * A new response: the next state, or `previous` unchanged when the copy is older than the one
 * held, or the same read again (never steps back).
 */
export function accept(previous: ReplayState | null, copy: ReplayCopy, now: number): ReplayState {
  if (previous && copy.asOf <= previous.copy.asOf) return previous;
  const value = valueAt(copy, now);
  const repair = previous !== null && copy.total < previous.copy.total;
  return {
    copy,
    shown: previous === null || repair ? value : Math.max(previous.shown, value),
  };
}

/** Time has passed with the same copy: the payments due by now show. */
export function advance(state: ReplayState, now: number): ReplayState {
  const value = valueAt(state.copy, now);
  return value > state.shown ? { copy: state.copy, shown: value } : state;
}

/** The next moment a listed payment becomes due after `now`, or null when none is waiting. */
export function nextDue(state: ReplayState, now: number): number | null {
  return dueTimes(state.copy).find((at) => at > now) ?? null;
}
