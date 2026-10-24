import type { OnBaseTotals } from './onBaseData';

/*
 * The On Base view's numbers (On Base now, New in the last 24 h, Finalizing now, Rated agents,
 * Read from Base block), as last known in this browser. The page shows them at once on its next
 * visit, while the list loads (a cold first read can take seconds) and after a failed load, so
 * the numbers never empty out. A fresh answer replaces them; an answer that could not count one
 * (ratedAgents or readAtBlock null) keeps the last known one. Only these public numbers and their
 * times are stored, under ON_BASE_TOTALS_STORAGE_KEY; any storage failure (private mode, blocked
 * site data) simply means nothing stored.
 */

export const ON_BASE_TOTALS_STORAGE_KEY = 'cc-on-base-totals';
/** After a failed load the list is read again after this, doubling up to the page's refresh. */
export const ON_BASE_FIRST_RETRY_MS = 1_000;

/** The Base block the numbers were read at, with how far the read lagged when it was answered. */
export interface KnownRead {
  block: number;
  /** The server's read lag behind its answer, ms (both the server's clock). */
  lagMs: number;
  /** When this browser got the answer (its own clock): the shown age adds the time since. */
  fetchedAt: number;
}

export interface KnownTotals {
  onBase: number;
  new24h: number;
  finalizingNow: number;
  /** null: no answer has counted it yet. */
  ratedAgents: number | null;
  /** null: no answer has named a block yet. */
  read: KnownRead | null;
}

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * The last known numbers after a fresh answer: its counts replace the known ones, and a count it
 * could not give (null or absent) keeps the known one.
 */
export function mergeTotals(
  known: KnownTotals | null,
  fresh: OnBaseTotals,
  fetchedAt: number,
  /** The answer was for a search: its read block is that page's, not the list's. */
  searched = false,
): KnownTotals {
  // The read block is the oldest owner read among the answer's rows, so a search answer can name
  // an older block than the list: it never replaces a known read, and a read never goes back.
  const keepKnown =
    known?.read != null &&
    (searched || !count(fresh.readAtBlock) || fresh.readAtBlock < known.read.block);
  const read: KnownRead | null =
    !keepKnown && count(fresh.readAtBlock) && typeof fresh.readAt === 'number'
      ? {
          block: fresh.readAtBlock,
          lagMs: Math.max(0, fresh.servedAt - fresh.readAt),
          fetchedAt,
        }
      : (known?.read ?? null);
  return {
    onBase: fresh.onBase,
    new24h: fresh.new24h,
    finalizingNow: fresh.finalizingNow,
    ratedAgents: count(fresh.ratedAgents) ? fresh.ratedAgents : (known?.ratedAgents ?? null),
    read,
  };
}

function readOf(value: unknown): KnownRead | null {
  if (!value || typeof value !== 'object') return null;
  const { block, lagMs, fetchedAt } = value as Record<string, unknown>;
  if (!count(block) || !count(lagMs)) return null;
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return null;
  return { block, lagMs, fetchedAt };
}

export function readStoredOnBaseTotals(): KnownTotals | null {
  try {
    const raw = window.localStorage.getItem(ON_BASE_TOTALS_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== 'object') return null;
    const { onBase, new24h, finalizingNow, ratedAgents } = value;
    if (!count(onBase) || !count(new24h) || !count(finalizingNow)) return null;
    return {
      onBase,
      new24h,
      finalizingNow,
      ratedAgents: count(ratedAgents) ? ratedAgents : null,
      read: readOf(value.read),
    };
  } catch {
    return null;
  }
}

export function storeOnBaseTotals(totals: KnownTotals): void {
  try {
    window.localStorage.setItem(ON_BASE_TOTALS_STORAGE_KEY, JSON.stringify(totals));
  } catch {
    // Storage unavailable: the next visit waits for the list's answer.
  }
}

/** The wait before retry number `attempt` (0 first) after failed loads in a row. */
export function onBaseRetryMs(attempt: number, refreshMs: number): number {
  return Math.min(refreshMs, ON_BASE_FIRST_RETRY_MS * 2 ** Math.max(0, Math.min(attempt, 30)));
}
