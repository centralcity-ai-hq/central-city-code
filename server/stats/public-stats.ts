import type { FastifyInstance } from 'fastify';
import type { Database } from '../database.js';
import { clientAddressKey } from '../rate-limit.js';
import { paidCallsTickerOn, type PaidCallsField } from '../../shared/paid-calls.js';
import {
  PAID_CALLS_LAST_GOOD_MS,
  PAID_CALLS_READ_BUDGET_MS,
  paidCallsField,
  type PaidCallsReader,
} from './paid-calls.js';
import { baseAgentsForResponse, type BaseAgentsReader } from './base-agents.js';
import './schema.js'; // migrations 28 public_stats and 59 counted_agent_ids (side-effect registration)

/**
 * Public, unauthenticated homepage statistics: the number of AI agents
 * that have ever joined Central City, however they arrived.
 *
 * Definition of `ai_agents_total`: the number of distinct agent ids stored in any workspace
 * document (`workspaces.data->'agents'`), across every kind of workspace:
 *   - owner accounts (agents created in the app, by an assistant connection or by a manifest),
 *   - AI-owned workspaces,
 *   - unclaimed partitions: agents created anonymously and room-invite guests,
 * including revoked and paused agents, excluding:
 *   - the sample agents seeded by the console's demo (POST /api/demo/start),
 *     recognized by `demoKey`, which only that seed sets, and
 *   - agents in operator ids listed in CITY_STATS_EXCLUDED_OPERATORS (synthetic accounts such as
 *     the production canary's), when set.
 *
 * Not `isDemo`: that flag means "hosted mode" (the platform executes this agent's jobs with a
 * zero-cost deterministic executor), set for every hosted agent by app.ts, assistant-access.ts and
 * autonomy/service.ts. Every built-in template is hosted, so agents that AIs create through
 * /mcp/open, /api/public/agents or OAuth from a template are isDemo, yet they are real arrivals
 * that can message and join rooms like any other agent. Only `demoKey` marks seed data.
 *
 * Why this is an "ever" count without a ledger: agents are never removed from a workspace
 * document. Revoking stamps `revokedAt` (server/agent-lifecycle.ts), there is no age-based removal
 * (server/autonomy/expiry.ts is a no-op), a claim moves an agent between documents in one
 * transaction with its id preserved, and bucket eviction only removes partitions with zero
 * agents. The one exception is the manual abuse purge (scripts/unclaimed-admin.ts purge), which
 * deletes an unclaimed partition with its agents; those are deliberately not counted.
 *
 * Cost: the count reads `counted_agent_ids` (migration 59, server/stats/schema.ts), one narrow row
 * per counted (workspace, agent id) kept by triggers on `workspaces`, so it never reads workspace
 * documents: an index-only scan instead of unpacking every document's JSON (about 100 ms at 30k
 * agents and growing with document size). AI_AGENTS_TOTAL_SCAN_SQL is the same definition as a
 * scan over the documents; tests/public-stats.test.ts keeps the two equal.
 *
 * `paid_calls` (optional): the paid service calls on Base mainnet (server/stats/paid-calls.ts,
 * shared/paid-calls.ts), from one primary-key read per server every 5 s.
 *
 * `base_agents` (optional): the Agent Explorer's "On Base now" total (server/stats/base-agents.ts),
 * shared through its own public_stats row under the same lease; left out until it is counted.
 *
 * The count is shared through one `public_stats` row (migration 28). Every instance reads
 * the row (a primary-key lookup) at most once per TTL; when it is older than the TTL, exactly one
 * instance wins a short refresh lease (one conditional UPDATE), counts outside any transaction and
 * writes the row back. So the database runs about one aggregate per TTL globally, however many
 * instances or edge regions serve the homepage. The response is cacheable at the edge as well.
 */
export const PUBLIC_STATS_TTL_MS = 15_000;
/** Edge cache lifetime (seconds) and how long the edge may serve it stale while refreshing. */
export const PUBLIC_STATS_CACHE_CONTROL =
  'public, max-age=0, s-maxage=15, stale-while-revalidate=45';
/**
 * Vercel's edge only (never forwarded to browsers): fresh for 15 s, then served stale for up to a
 * day while one background request refreshes it. A visitor never waits for the function and the
 * database (a cold start, a refresh) unless the edge has no copy at all; the browser keeps the
 * Cache-Control above, so the ticker's 15 s poll still asks the edge each time.
 */
export const PUBLIC_STATS_EDGE_CACHE_CONTROL = 'public, max-age=15, stale-while-revalidate=86400';
/** Per client address; the homepage polls every 15 s, so this leaves room for a shared NAT. */
export const PUBLIC_STATS_RATE = { max: 60, windowMs: 60_000 } as const;

/**
 * The definition as a scan over every workspace document (not run by the public route; the daily
 * check in fast-count-check.ts compares it with the fast count). A document whose `agents` is
 * missing or not an array (JSON null, an object) contributes nothing, as in the fast path.
 */
export const AI_AGENTS_TOTAL_SCAN_SQL = `SELECT count(DISTINCT a.value->>'id')::bigint AS n
  FROM workspaces w
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(w.data->'agents') = 'array'
                                               THEN w.data->'agents' ELSE '[]'::jsonb END) AS a(value)
  WHERE a.value->>'demoKey' IS NULL
    AND NOT (w.operator_id = ANY($1::text[]))`;

/** The same number from the trigger-kept id table (migration 59). */
export const AI_AGENTS_TOTAL_SQL = `SELECT count(DISTINCT agent_id)::bigint AS n
  FROM counted_agent_ids
  WHERE NOT (operator_id = ANY($1::text[]))`;

export interface PublicStats {
  ai_agents_total: number;
  updated_at: string;
}

/** Parses CITY_STATS_EXCLUDED_OPERATORS: comma-separated operator ids; anything else is refused. */
export function parseExcludedOperators(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const ids = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const id of ids)
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
      throw new Error('CITY_STATS_EXCLUDED_OPERATORS must be comma-separated operator ids.');
  return [...new Set(ids)];
}

export async function countAiAgentsTotal(
  db: Pick<Database, 'query'>,
  excludedOperators: readonly string[] = [],
): Promise<number> {
  const row = (
    await db.query<{ n: string | number }>(AI_AGENTS_TOTAL_SQL, [[...excludedOperators]])
  ).rows[0];
  return Number(row?.n ?? 0);
}

export interface PublicStatsService {
  get(): Promise<PublicStats>;
}

/**
 * How long a refresh lease lasts, on the database clock; a crashed winner's lease expires and
 * another instance takes it.
 */
export const PUBLIC_STATS_LEASE_MS = 10_000;
/** How soon an instance that lost the lease, and served the stored value, looks again. */
export const PUBLIC_STATS_RETRY_MS = 1_000;
const AI_AGENTS_TOTAL_KEY = 'ai_agents_total';

export interface StoredStat {
  value: number;
  refreshedAt: number;
}
/** The shared row (migration 28); an interface so tests can observe or replace it. */
export interface PublicStatsStore {
  read(key: string): Promise<StoredStat | null>;
  /**
   * True for exactly one caller while the row is stale (by `now`, the caller's claim time) and no
   * live lease exists. The lease itself runs on the database clock, never an instance clock.
   */
  claim(key: string, now: number, ttlMs: number, leaseMs: number): Promise<boolean>;
  /**
   * Stores `value` stamped with the claim time `at`. Refused (false) when the stored value comes
   * from a later claim, so a slow count can never overwrite a newer total.
   */
  write(key: string, value: number, at: number): Promise<boolean>;
  /**
   * The lease holder whose count failed keeps the lease `forMs` more (database clock), so every
   * instance backs off together instead of the next one running the same count.
   */
  hold(key: string, forMs: number): Promise<void>;
}

/** The database clock in epoch milliseconds (clock_timestamp: real time even inside a statement). */
const DB_NOW_MS = `(extract(epoch from clock_timestamp()) * 1000)::bigint`;

/** The SQL store. No statement runs inside a transaction, so no pool client is held while counting. */
export function sqlPublicStatsStore(db: Pick<Database, 'query'>): PublicStatsStore {
  return {
    async read(key) {
      const row = (
        await db.query<{ value: string | number; refreshed_at: string | number }>(
          'SELECT value, refreshed_at FROM public_stats WHERE key=$1',
          [key],
        )
      ).rows[0];
      return row && Number(row.refreshed_at) > 0
        ? { value: Number(row.value), refreshedAt: Number(row.refreshed_at) }
        : null;
    },
    async claim(key, now, ttlMs, leaseMs) {
      await db.query('INSERT INTO public_stats(key) VALUES($1) ON CONFLICT (key) DO NOTHING', [
        key,
      ]);
      const won = await db.query(
        `UPDATE public_stats SET refreshing_until=${DB_NOW_MS} + $4::bigint
         WHERE key=$1 AND refreshed_at <= $2::bigint - $3::bigint AND refreshing_until <= ${DB_NOW_MS}
         RETURNING key`,
        [key, now, ttlMs, leaseMs],
      );
      return won.rows.length === 1;
    },
    async write(key, value, at) {
      // Stamped with the claim time: a writer whose claim is older than the stored value's claim
      // (a slow count whose lease expired while a newer one finished) changes nothing.
      const written = await db.query(
        'UPDATE public_stats SET value=$2, refreshed_at=$3, refreshing_until=0 WHERE key=$1 AND refreshed_at < $3 RETURNING key',
        [key, value, at],
      );
      return written.rows.length === 1;
    },
    async hold(key, forMs) {
      await db.query(
        `UPDATE public_stats SET refreshing_until=GREATEST(refreshing_until, ${DB_NOW_MS} + $2::bigint)
         WHERE key=$1`,
        [key, forMs],
      );
    },
  };
}

/** A public_stats key (the table's own CHECK). */
const STAT_KEY = /^[a-z_]{1,64}$/;

/** One shared count: its last value and when it was counted. */
export interface SharedStat {
  get(): Promise<StoredStat>;
}

/** No value exists anywhere yet and another instance holds the lease (countWithoutLease false). */
export class NotCountedYet extends Error {
  constructor(key: string) {
    super(`${key} is not counted yet`);
  }
}

/**
 * Any count shared through one `public_stats` row, `key`: lease-refreshed (about one `count()` per
 * TTL globally, however many instances ask) with a per-instance memory cache. Concurrent requests
 * on one instance share one refresh (single flight).
 * - A failed refresh serves the newest value it has (its own last one, or the row it just read)
 *   rather than an error.
 * - `failureBackoffMs`: after a failed count, this instance serves that value (or the failure,
 *   without one) for that long before it asks the database again, and the winner keeps the
 *   shared lease that long, so no other instance runs the failing count meanwhile. Without it,
 *   the next request tries at once.
 * - `countWithoutLease` (default true): with no stored value anywhere yet, an instance that lost
 *   the claim counts by itself, without writing. False: it answers NotCountedYet and looks again
 *   after PUBLIC_STATS_RETRY_MS; only the lease holder ever counts.
 * - `staleWhileRevalidate`: once any value is known (in memory, or the stored row), get() answers
 *   with it at once and the refresh, and its count, run without the caller waiting.
 */
export function createSharedStat(deps: {
  key: string;
  count: () => Promise<number>;
  clock: () => number;
  ttlMs: number;
  store: PublicStatsStore;
  failureBackoffMs?: number;
  countWithoutLease?: boolean;
  staleWhileRevalidate?: boolean;
}): SharedStat {
  if (!STAT_KEY.test(deps.key)) throw new Error(`Not a public_stats key: ${deps.key}`);
  const { key, store } = deps;
  const ttl = deps.ttlMs;
  const countWithoutLease = deps.countWithoutLease ?? true;
  let cached: { value: StoredStat; until: number } | null = null;
  let inflight: { run: Promise<StoredStat>; first: Promise<StoredStat> } | null = null;
  let failed: { error: unknown; until: number } | null = null;
  const remember = (stat: StoredStat, until: number) => {
    cached = { value: stat, until };
    failed = null;
    return stat;
  };
  /** `known` is told the stored value as soon as it is read, before any count. */
  async function refresh(known: (stat: StoredStat) => void): Promise<StoredStat> {
    const now = deps.clock();
    let row: StoredStat | null = null;
    let claimed = false;
    try {
      row = await store.read(key);
      if (row && now - row.refreshedAt < ttl) return remember(row, row.refreshedAt + ttl);
      if (row) known(row);
      if (await store.claim(key, now, ttl, PUBLIC_STATS_LEASE_MS)) {
        claimed = true;
        const total = await deps.count();
        // The value is stamped with the claim time, not the finish time.
        if (await store.write(key, total, now))
          return remember({ value: total, refreshedAt: now }, now + ttl);
        // A newer claim already stored a value: serve that one.
        const newer = await store.read(key);
        if (newer) return remember(newer, newer.refreshedAt + ttl);
        return remember({ value: total, refreshedAt: now }, now + PUBLIC_STATS_RETRY_MS);
      }
      // Another instance is refreshing: serve the stored value and look again shortly.
      if (row) return remember(row, now + PUBLIC_STATS_RETRY_MS);
      if (!countWithoutLease) throw new NotCountedYet(key);
      // No value exists yet anywhere (the very first requests): count here, without writing.
      const total = await deps.count();
      return remember({ value: total, refreshedAt: now }, now + PUBLIC_STATS_RETRY_MS);
    } catch (error) {
      const backoff =
        error instanceof NotCountedYet ? PUBLIC_STATS_RETRY_MS : (deps.failureBackoffMs ?? 0);
      // The failed count keeps the shared lease for the back-off: no other instance retries it.
      if (claimed && backoff > 0) await store.hold(key, backoff).catch(() => undefined);
      const mine = cached?.value ?? null;
      const last = mine && (!row || mine.refreshedAt >= row.refreshedAt) ? mine : row;
      const until = deps.clock() + backoff;
      if (last) {
        cached = { value: last, until };
        return last;
      }
      if (backoff > 0) failed = { error, until };
      throw error;
    }
  }
  return {
    get() {
      const now = deps.clock();
      if (cached && now < cached.until) return Promise.resolve(cached.value);
      if (failed && now < failed.until)
        return cached ? Promise.resolve(cached.value) : Promise.reject(failed.error);
      if (!inflight) {
        let known: (stat: StoredStat) => void = () => undefined;
        const stored = new Promise<StoredStat>((resolve) => (known = resolve));
        const run = refresh(known).finally(() => {
          if (inflight?.run === run) inflight = null;
        });
        const first = Promise.race([run, stored]);
        // Only a stale-while-revalidate caller awaits it; its failure is the refresh's own.
        first.catch(() => undefined);
        inflight = { run, first };
      }
      if (!deps.staleWhileRevalidate) return inflight.run;
      // The refresh goes on without this caller; its failure is handled inside it.
      inflight.run.catch(() => undefined);
      return cached ? Promise.resolve(cached.value) : inflight.first;
    },
  };
}

/**
 * The homepage count (`ai_agents_total`) through createSharedStat: the shared, lease-refreshed
 * count with a per-instance memory cache.
 */
export function createPublicStats(deps: {
  db: Pick<Database, 'query'>;
  clock: () => number;
  ttlMs?: number;
  excludedOperators?: readonly string[];
  store?: PublicStatsStore;
}): PublicStatsService {
  const excluded = deps.excludedOperators ?? [];
  const shared = createSharedStat({
    key: AI_AGENTS_TOTAL_KEY,
    count: () => countAiAgentsTotal(deps.db, excluded),
    clock: deps.clock,
    ttlMs: deps.ttlMs ?? PUBLIC_STATS_TTL_MS,
    store: deps.store ?? sqlPublicStatsStore(deps.db),
  });
  // One answer object per stored value, as before the count was shared.
  let shown: { stat: StoredStat; value: PublicStats } | null = null;
  return {
    async get() {
      const stat = await shared.get();
      if (shown?.stat !== stat)
        shown = {
          stat,
          value: {
            ai_agents_total: stat.value,
            updated_at: new Date(stat.refreshedAt).toISOString(),
          },
        };
      return shown.value;
    },
  };
}

/**
 * The optional `paid_calls` field (server/stats/paid-calls.ts): the paid service calls on Base
 * mainnet. Left out while CITY_PAID_CALLS_TICKER is '0' (read per request) and before the
 * counter's Base mainnet row exists; the agent count is served either way.
 *
 * The response waits at most PAID_CALLS_READ_BUDGET_MS for the read, so a slow database never
 * holds up the agent count. When the read is slower or fails, the last good row is served with
 * the `as_of` of its own read (so it never looks newer than it is) while it is at most
 * PAID_CALLS_LAST_GOOD_MS old; otherwise the field is left out. A slow read carries on and fills
 * the cache for the next request.
 */
async function paidCalls(deps: {
  paidCalls?: PaidCallsReader;
  env?: Readonly<Record<string, string | undefined>>;
  clock?: () => number;
  paidCallsBudgetMs?: number;
}): Promise<PaidCallsField | null> {
  const reader = deps.paidCalls;
  if (!reader || !paidCallsTickerOn(deps.env ?? process.env)) return null;
  const clock = deps.clock ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    reader.read().then(
      (snapshot) => ({ snapshot }),
      () => null,
    ),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deps.paidCallsBudgetMs ?? PAID_CALLS_READ_BUDGET_MS);
    }),
  ]);
  clearTimeout(timer);
  const now = clock();
  if (outcome) return outcome.snapshot ? paidCallsField(outcome.snapshot, now) : null;
  const last = reader.lastGood?.() ?? null;
  if (!last || now - last.readAt > PAID_CALLS_LAST_GOOD_MS) return null;
  return paidCallsField(last, last.readAt);
}

export function registerPublicStatsRoutes(
  app: FastifyInstance,
  deps: {
    stats: PublicStatsService;
    limit: (key: string, max: number, windowMs: number) => Promise<void>;
    /** The paid service calls count; without it the field is never sent. */
    paidCalls?: PaidCallsReader;
    /** Where CITY_PAID_CALLS_TICKER is read (default: process.env). */
    env?: Readonly<Record<string, string | undefined>>;
    clock?: () => number;
    /** How long the response waits for the paid read (default PAID_CALLS_READ_BUDGET_MS). */
    paidCallsBudgetMs?: number;
    /** The Base agents count; without it the field is never sent. */
    baseAgents?: BaseAgentsReader;
    /** How long the response waits for it (default BASE_AGENTS_READ_BUDGET_MS). */
    baseAgentsBudgetMs?: number;
  },
): void {
  app.get('/api/public/stats', async (request, reply) => {
    // Under the degraded 'ip' prefix (server/rate-limit.ts): a public read keeps working at a
    // reduced per-instance budget if the shared limiter is down. The key never collides with the
    // global `ip:<address>` bucket, whose address keys never start with "stats:".
    await deps.limit(
      `ip:stats:${clientAddressKey(request.ip)}`,
      PUBLIC_STATS_RATE.max,
      PUBLIC_STATS_RATE.windowMs,
    );
    const stats = await deps.stats.get();
    // Read after the agent count's read has finished, never alongside it (a small pool).
    const paid = await paidCalls(deps);
    // Then the Base agents number (one read at a time on the small pool).
    const baseAgents = await baseAgentsForResponse(
      deps.baseAgents,
      deps.clock ?? Date.now,
      deps.baseAgentsBudgetMs,
    );
    // Only the numbers and their times; nothing about agents, owners, payers, services or amounts.
    return reply
      .header('Cache-Control', PUBLIC_STATS_CACHE_CONTROL)
      .header('Vercel-CDN-Cache-Control', PUBLIC_STATS_EDGE_CACHE_CONTROL)
      .send({
        ai_agents_total: stats.ai_agents_total,
        updated_at: stats.updated_at,
        ...(paid ? { paid_calls: paid } : {}),
        ...(baseAgents ? { base_agents: baseAgents } : {}),
      });
  });
}
