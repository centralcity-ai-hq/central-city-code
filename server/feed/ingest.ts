/*
 * The Feed's ingestion (Operation Central City Feed, release 1): sweeps the x402 Bazaar catalog
 * into feed_services (server/feed/store.ts), one cron run at a time (server/feed/cron.ts, every 15
 * minutes).
 *
 * A sweep reads the catalog from offset 0 in pages of FEED_PAGE_LIMIT, one request at a time, and
 * may span several runs: the cursor lives in feed_sources and the next run resumes where the last
 * one stopped. A run starts no new page after FEED_SYNC_BUDGET_MS. A sweep is complete when a
 * page's end reaches the total that page reported, or when a page returns fewer items than asked
 * and its end is within one page of that total (the total moves while a sweep runs). A short page
 * that ends further from the total is a failure ('short'): the source truncated or filtered it,
 * and completing there would count every record past it as missed. Only a complete sweep counts
 * the listings it missed and withdraws (store.ts).
 *
 * - A new sweep starts only when none is in progress and the last complete one is older than
 *   FEED_LIMITS.syncEveryMs (or none ever completed). In between, a run reads one row and stops.
 * - A page that fails (rate limited, unavailable, unreadable, an empty catalog at offset 0, or a
 *   short page far from the total) records its code and ends the run; the cursor stays, so the
 *   next run (15 minutes later: the back-off) reads the same page again. A failed page never
 *   completes a sweep or withdraws. A total under half the last complete one fails as 'short'
 *   only until the sweep is staleAfterMs old; after that a catalog that really shrank completes.
 * - The noon checkpoint (12:00 Europe/Berlin) runs undisturbed: no page is fetched from 11:30 to
 *   12:30 Berlin time (daylight saving included). A run in that window does nothing at all, not
 *   even a database read; a run that reaches it stops, and the sweep resumes after.
 * - Two runs at once are harmless: the cursor moves only by a compare-and-set (store.ts), so the
 *   slower run writes nothing and stops ('busy').
 *
 * Every item is normalized by server/feed/bazaar.ts (provider text cut and kept as plain text,
 * the Base mainnet USDC offer, the risk check); an item the normalizer cannot read counts as
 * 'malformed'. The run's answer carries counts and codes only, never provider text or a URL.
 */
import type { Database } from '../database.js';
import { FEED_LIMITS } from '../../shared/feed.js';
import {
  FeedSourceError,
  fetchBazaarPage,
  normalizeBazaarItem,
  type NormalizedService,
} from './bazaar.js';
import { createFeedStore, type FeedExcludedRecord } from './store.js';
import { BAZAAR_SOURCE, type FeedServiceRow } from './types.js';

/** Items per page (the Bazaar's maximum). */
export const FEED_PAGE_LIMIT = 1_000;
/**
 * A run starts no new page after this long: well inside the function's maxDuration of 300 s, with
 * room for the last page's request and its write.
 */
export const FEED_SYNC_BUDGET_MS = 120_000;
/** No page is fetched from 11:30 to 12:30 Europe/Berlin (minutes of the Berlin day). */
export const FEED_NOON_PAUSE = { from: 11 * 60 + 30, until: 12 * 60 + 30 } as const;

/**
 * Failure codes a run records (feed_sources.last_error). 'empty': no items at offset 0. 'short':
 * fewer items than asked on a page that ends more than a page before the total it reports.
 */
export const FEED_SYNC_ERRORS = [
  'rate_limited',
  'unavailable',
  'malformed',
  'empty',
  'short',
] as const;
export type FeedSyncError = (typeof FEED_SYNC_ERRORS)[number];

export type FeedSyncOutcome =
  /** The noon window: nothing fetched (a run that reached it mid-way keeps what it saved). */
  | 'paused'
  /** No sweep in progress and none due. */
  | 'idle'
  /** Another run moved the cursor (or started the sweep) first; this one wrote nothing more. */
  | 'busy'
  /** Pages saved within the budget; the sweep goes on in the next run. */
  | 'partial'
  /** This run completed the sweep. */
  | 'complete'
  /** A page failed: its code is recorded and the next run reads it again. */
  | 'failed';

export interface FeedSyncRun {
  outcome: FeedSyncOutcome;
  /** The sweep this run worked on; null when it worked on none. */
  sweepId: number | null;
  pages: number;
  /** Listings upserted, and records excluded, by this run. */
  services: number;
  excluded: number;
  /** Listings withdrawn by the sweep this run completed. */
  withdrawn: number;
  /** Where the sweep's next page is read after this run; null when it worked on none. */
  offset: number | null;
  error: FeedSyncError | null;
}

export interface BazaarPage {
  items: unknown[];
  total: number;
}

export interface FeedSyncDeps {
  db: Database;
  /** The fetch the Bazaar client uses (server/feed/bazaar.ts); the global fetch by default. */
  fetch?: typeof fetch;
  /** Reads one page; fetchBazaarPage with `fetch` by default. */
  fetchPage?: (offset: number, limit: number) => Promise<BazaarPage>;
  /** Normalizes one item; normalizeBazaarItem (with hostedHost) by default. */
  normalize?: (item: unknown, fetchedAt: number) => NormalizedService;
  /**
   * The host Central City serves its own offers from (the configured public origin's host): a
   * Bazaar record on it is the exclusion 'hosted_here' (bazaar.ts). Null or absent: no such check.
   */
  hostedHost?: string | null;
  now?: () => number;
  budgetMs?: number;
  pageLimit?: number;
  syncEveryMs?: number;
}

// Built once, on first use: a DateTimeFormat is expensive. The server runs with full time zone
// data, so daylight saving comes from the zone itself.
let berlinClock: Intl.DateTimeFormat | undefined;

/** The minute of the day (0-1439) that `instant` has in Europe/Berlin. */
export function berlinMinuteOfDay(instant: number): number {
  berlinClock ??= new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = berlinClock.formatToParts(instant);
  const part = (type: 'hour' | 'minute') =>
    Number(parts.find((item) => item.type === type)?.value ?? 0);
  return (part('hour') % 24) * 60 + part('minute');
}

/** True from 11:30 to 12:29 Europe/Berlin: the noon checkpoint's window, when nothing is fetched. */
export function inNoonPause(instant: number): boolean {
  const minute = berlinMinuteOfDay(instant);
  return minute >= FEED_NOON_PAUSE.from && minute < FEED_NOON_PAUSE.until;
}

/** The code a failed page records: the source error's own, else 'unavailable'. */
function errorCode(error: unknown): FeedSyncError {
  const code =
    error instanceof FeedSourceError ? error.code : (error as { code?: unknown } | null)?.code;
  return FEED_SYNC_ERRORS.find((known) => known === code) ?? 'unavailable';
}

/** A readable page, or null: items an array, the total a non-negative integer. */
function readPage(page: unknown): BazaarPage | null {
  const value = page as Partial<BazaarPage> | null;
  return value &&
    Array.isArray(value.items) &&
    typeof value.total === 'number' &&
    Number.isSafeInteger(value.total) &&
    value.total >= 0
    ? { items: value.items, total: value.total }
    : null;
}

/** One page and whether it completes the sweep, or the code it failed with. */
async function readOne(
  fetchPage: (offset: number, limit: number) => Promise<BazaarPage>,
  offset: number,
  limit: number,
  lastTotal: number | null,
): Promise<{ page: BazaarPage; complete: boolean } | FeedSyncError> {
  let page: BazaarPage | null;
  try {
    page = readPage(await fetchPage(offset, limit));
  } catch (error) {
    return errorCode(error);
  }
  if (!page) return 'malformed';
  // A catalog of tens of thousands never lists nothing: an empty first page is a failure, never
  // a complete sweep that would count every listing as missed.
  if (offset === 0 && !page.items.length) return 'empty';
  // A catalog that collapsed to under half the last complete sweep's total (a junk or truncated
  // answer) never completes a sweep: completing would count most listings as missed. The caller
  // passes null once the sweep is older than staleAfterMs: a catalog that really shrank.
  if (lastTotal !== null && page.total * 2 < lastTotal) return 'short';
  const end = offset + page.items.length;
  if (end >= page.total) return { page, complete: true };
  if (page.items.length >= limit) return { page, complete: false };
  // Fewer than asked: the end of the catalog only within a page of the total it reports (it
  // moves while the sweep runs). Further away, the page was cut short: read it again next run.
  return end >= page.total - limit ? { page, complete: true } : 'short';
}

/** Runs one cron run of the Bazaar sweep (see the header). Throws only on a database error. */
export async function runFeedSync(deps: FeedSyncDeps): Promise<FeedSyncRun> {
  const clock = deps.now ?? Date.now;
  const started = clock();
  const run: FeedSyncRun = {
    outcome: 'idle',
    sweepId: null,
    pages: 0,
    services: 0,
    excluded: 0,
    withdrawn: 0,
    offset: null,
    error: null,
  };
  if (inNoonPause(started)) return { ...run, outcome: 'paused' };

  const store = createFeedStore(deps.db);
  const fetchPage =
    deps.fetchPage ??
    ((offset: number, limit: number) => fetchBazaarPage({ fetch: deps.fetch }, offset, limit));
  const normalize =
    deps.normalize ??
    ((item: unknown, fetchedAt: number) =>
      normalizeBazaarItem(item, fetchedAt, { hostedHost: deps.hostedHost ?? null }));
  const limit = deps.pageLimit ?? FEED_PAGE_LIMIT;
  const budget = deps.budgetMs ?? FEED_SYNC_BUDGET_MS;

  const source = await store.source(BAZAAR_SOURCE);
  let sweepId = source.sweepId;
  let offset = source.sweepOffset;
  let sweepStartedAt = source.sweepStartedAt ?? started;
  if (source.sweepStartedAt === null || sweepId === null) {
    const due =
      source.lastSuccessAt === null ||
      started - source.lastSuccessAt >= (deps.syncEveryMs ?? FEED_LIMITS.syncEveryMs);
    if (!due) return run;
    sweepId = await store.startSweep(BAZAAR_SOURCE, source.sweepId, started);
    if (sweepId === null) return { ...run, outcome: 'busy' };
    offset = 0;
    sweepStartedAt = started;
  }
  // The halving guard holds a sweep back for staleAfterMs at most: by then its listings show as
  // stale anyway, and a catalog that really shrank would otherwise stall the sweep for good.
  const lastTotal = started - sweepStartedAt >= FEED_LIMITS.staleAfterMs ? null : source.lastTotal;
  run.sweepId = sweepId;
  run.offset = offset;
  run.outcome = 'partial';

  while (clock() - started < budget) {
    if (inNoonPause(clock())) return { ...run, outcome: 'paused' };
    const read = await readOne(fetchPage, offset, limit, lastTotal);
    if (typeof read === 'string') {
      await store.failed(BAZAAR_SOURCE, read, clock());
      return { ...run, outcome: 'failed', error: read };
    }
    const { page, complete } = read;
    const fetchedAt = clock();
    const services: FeedServiceRow[] = [];
    const excluded: FeedExcludedRecord[] = [];
    let unreadable = 0;
    for (const item of page.items) {
      let normalized: NormalizedService;
      try {
        normalized = normalize(item, fetchedAt);
      } catch {
        normalized = { ok: false, recordId: null, excluded: 'malformed' };
      }
      if (normalized.ok) services.push(normalized.row);
      else if (normalized.recordId !== null)
        excluded.push({ recordId: normalized.recordId, reason: normalized.excluded });
      else unreadable++;
    }
    const next = offset + page.items.length;
    const saved = await store.savePage({
      source: BAZAAR_SOURCE,
      sweepId,
      offset,
      next,
      total: page.total,
      services,
      excluded,
      complete,
      now: fetchedAt,
    });
    if (!saved.advanced) return { ...run, outcome: 'busy' };
    run.pages++;
    // Another spelling of a listed URL is kept as an exclusion, not as a listing (store.ts).
    run.services += services.length - saved.duplicates;
    run.excluded += excluded.length + unreadable + saved.duplicates;
    run.offset = offset = next;
    if (complete) return { ...run, outcome: 'complete', withdrawn: saved.withdrawn };
  }
  return run;
}
