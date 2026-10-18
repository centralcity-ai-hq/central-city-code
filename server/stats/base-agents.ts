import type { Database } from '../database.js';
import { BASE_MAINNET, BASE_NETWORKS } from '../../shared/base/chains.js';
import { AGENT_URI_ORIGIN } from '../../shared/base/on-base.js';
import type { BaseAgentsField } from '../../shared/paid-calls.js';
import { FROM, LISTED } from '../base/explorer/store.js';
import {
  PUBLIC_STATS_LEASE_MS,
  PUBLIC_STATS_RETRY_MS,
  PUBLIC_STATS_TTL_MS,
  type PublicStatsStore,
  type StoredStat,
} from './public-stats.js';

/*
 * The Base agents number of the homepage and Feed live line: the optional `base_agents` field of
 * GET /api/public/stats. The same count as the Agent Explorer's "On Base now" total
 * (server/base/explorer/store.ts totals().onBase): the agents Central City registered on Base
 * mainnet that the explorer lists (final, or finalizing with a safe mint and hand-over).
 *
 * Never one count per request: the number is shared through its own `public_stats` row
 * (migration 28), refreshed under the same lease as the agent count (about one count per
 * PUBLIC_STATS_TTL_MS globally, outside any transaction), and kept in memory per instance. Only
 * the lease holder ever counts: an instance that loses the lease before any value exists answers
 * without the field. A failed count backs off BASE_AGENTS_FAILURE_BACKOFF_MS on every instance (the
 * holder keeps the lease that long). Never reads workspace documents.
 */

/** The public_stats row (the table's CHECK allows [a-z_]). */
export const BASE_AGENTS_KEY = 'base_agents_total';
/** After a failed count, nobody counts again for this long; the last value is served meanwhile. */
export const BASE_AGENTS_FAILURE_BACKOFF_MS = 60_000;
/** The stats response waits at most this long for the number; then the last value or nothing. */
export const BASE_AGENTS_READ_BUDGET_MS = 250;
/**
 * The last value is served after a slow or failed read while it is at most this old: a count that
 * is slow for a while keeps the number on the page (a little old) instead of hiding it.
 */
export const BASE_AGENTS_LAST_GOOD_MS = 60 * 60_000;

/** The explorer's On Base total as one count (store.ts LISTED; its params $1 to $3). */
export const BASE_AGENTS_COUNT_SQL = `SELECT count(*)::bigint AS n ${FROM} WHERE ${LISTED}`;

export async function countBaseAgents(db: Pick<Database, 'query'>): Promise<number> {
  const registry = BASE_NETWORKS[BASE_MAINNET].contracts.identityRegistry ?? '';
  const row = (
    await db.query<{ n: string | number }>(BASE_AGENTS_COUNT_SQL, [
      BASE_MAINNET,
      registry,
      AGENT_URI_ORIGIN,
    ])
  ).rows[0];
  return Number(row?.n ?? 0);
}

/** Extends a row's refresh lease to `forMs` from now on the database clock (never shortens it). */
export async function holdLease(
  db: Pick<Database, 'query'>,
  key: string,
  forMs: number,
): Promise<void> {
  await db.query(
    `UPDATE public_stats SET refreshing_until = GREATEST(refreshing_until,
       (extract(epoch from clock_timestamp()) * 1000)::bigint + $2::bigint)
     WHERE key = $1`,
    [key, forMs],
  );
}

export interface BaseAgentsReader {
  /** The shared value, or null while none exists yet. Rejects when it could not be read. */
  read(): Promise<StoredStat | null>;
  /** The newest value this instance has (kept through failures), or null. */
  lastGood(): StoredStat | null;
}

/** The shared, lease-refreshed Base agents count with a per-instance memory cache (single flight). */
export function createBaseAgentsReader(deps: {
  db: Pick<Database, 'query'>;
  store: PublicStatsStore;
  clock: () => number;
  ttlMs?: number;
  /** The count itself (tests); defaults to countBaseAgents. */
  count?: () => Promise<number>;
  /** Keeps the shared lease `forMs` more (database clock); defaults to holdLease on `db`. */
  hold?: (forMs: number) => Promise<void>;
}): BaseAgentsReader {
  const ttl = deps.ttlMs ?? PUBLIC_STATS_TTL_MS;
  const count = deps.count ?? (() => countBaseAgents(deps.db));
  const { store } = deps;
  const hold = deps.hold ?? ((forMs: number) => holdLease(deps.db, BASE_AGENTS_KEY, forMs));
  let last: StoredStat | null = null;
  let until = 0;
  let failure: unknown = null;
  let inflight: Promise<StoredStat | null> | null = null;
  const keep = (stat: StoredStat | null, nextAt: number) => {
    if (stat && (!last || stat.refreshedAt >= last.refreshedAt)) last = stat;
    until = nextAt;
    failure = null;
    return last;
  };
  async function refresh(): Promise<StoredStat | null> {
    const now = deps.clock();
    let claimed = false;
    try {
      const row = await store.read(BASE_AGENTS_KEY);
      if (row && now - row.refreshedAt < ttl) return keep(row, row.refreshedAt + ttl);
      // The stored value stays the last good one while this instance counts, so a response that
      // cannot wait for the count still has a number.
      if (row && (!last || row.refreshedAt >= last.refreshedAt)) last = row;
      if (await store.claim(BASE_AGENTS_KEY, now, ttl, PUBLIC_STATS_LEASE_MS)) {
        claimed = true;
        const total = await count();
        // Stamped with the claim time; a newer claim's value is never overwritten.
        if (await store.write(BASE_AGENTS_KEY, total, now))
          return keep({ value: total, refreshedAt: now }, now + ttl);
        const newer = await store.read(BASE_AGENTS_KEY);
        return keep(newer ?? { value: total, refreshedAt: now }, now + PUBLIC_STATS_RETRY_MS);
      }
      // Another instance is counting: serve the stored value (none yet: no field) and look again.
      return keep(row, now + PUBLIC_STATS_RETRY_MS);
    } catch (error) {
      // Keep the shared lease through the back-off, so no other instance runs the failing count.
      if (claimed) await hold(BASE_AGENTS_FAILURE_BACKOFF_MS).catch(() => undefined);
      until = deps.clock() + BASE_AGENTS_FAILURE_BACKOFF_MS;
      if (last) return last;
      failure = error;
      throw error;
    } finally {
      inflight = null;
    }
  }
  return {
    read() {
      if (deps.clock() < until)
        return failure && !last ? Promise.reject(failure) : Promise.resolve(last);
      return (inflight ??= refresh());
    },
    lastGood: () => last,
  };
}

/** Runs a promise past the response on Vercel Fluid (waitUntil), else just in the background. */
function background(work: Promise<unknown>): void {
  const settled = work.catch(() => {});
  const context = (
    globalThis as { [key: symbol]: { get?: () => { waitUntil?: (p: Promise<unknown>) => void } } }
  )[Symbol.for('@vercel/request-context')];
  context?.get?.()?.waitUntil?.(settled);
}

/** The public field: the number and when it was counted. */
export function baseAgentsField(stat: StoredStat): BaseAgentsField {
  return { total: stat.value, as_of: new Date(stat.refreshedAt).toISOString() };
}

/**
 * The field for one response: waits at most `budgetMs` for the read, so a slow database never
 * holds up the agent count; then the last value (while at most BASE_AGENTS_LAST_GOOD_MS old) or
 * nothing. A slow read carries on past the response (waitUntil) and fills the cache for the next
 * request.
 */
export async function baseAgentsForResponse(
  reader: BaseAgentsReader | undefined,
  clock: () => number,
  budgetMs = BASE_AGENTS_READ_BUDGET_MS,
): Promise<BaseAgentsField | null> {
  if (!reader) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = reader.read();
  // On serverless, a read that outlives the response is frozen with it: keep it running there
  // (Vercel waitUntil), so the count finishes and fills the shared row for the next request.
  background(read);
  const outcome = await Promise.race([
    read.then(
      (stat) => ({ stat }),
      () => null,
    ),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), budgetMs);
    }),
  ]);
  clearTimeout(timer);
  const stat = outcome ? outcome.stat : reader.lastGood();
  if (!stat || clock() - stat.refreshedAt > BASE_AGENTS_LAST_GOOD_MS) return null;
  return baseAgentsField(stat);
}
