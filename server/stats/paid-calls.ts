import type { Database, Transaction } from '../database.js';
import {
  PAID_CALLS_CHAIN_ID,
  PAID_CALLS_RECENT_MAX,
  PAID_CALLS_RECENT_WINDOW_MS,
  type PaidCallsField,
} from '../../shared/paid-calls.js';

export { PAID_CALLS_CHAIN_ID };

/*
 * The paid service calls count (migration 125, server/feed/pay/count-schema.ts): its reader for the
 * public stats and its daily check.
 *
 * Only Base mainnet (8453) is ever read for the public field or shown; other chains keep their own
 * rows, and the daily check repairs every chain's row (checkPaidCallsAllChains).
 */

/** Each server keeps the row this long in memory (one shared refresh). */
export const PAID_CALLS_CACHE_MS = 5_000;

/**
 * The stats response waits at most this long for the paid read (server/stats/public-stats.ts):
 * when it is slower or fails, the last good row is served, or the field is left out, so a slow
 * database never holds up the agent count. The read itself carries on and fills the cache.
 */
export const PAID_CALLS_READ_BUDGET_MS = 250;

/**
 * After a slow or failed read, the last good row is served while it is at most this old (its
 * `as_of` stays at its own read, so it never looks newer than it is); after that the field is left
 * out. Same as the client's old copy limit (shared/paid-calls.ts PAID_CALLS_OLD_COPY_MS).
 */
export const PAID_CALLS_LAST_GOOD_MS = 120_000;

/** One primary-key read, with the database clock so ages are measured on one clock. */
export const PAID_CALLS_READ_SQL = `SELECT total, recent,
  (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
  FROM paid_call_count WHERE chain_id = $1`;

export interface PaidCallsSnapshot {
  total: number;
  /** Base block times (epoch ms) of the latest payments, newest first, at most 64. */
  recent: number[];
  /** The database clock when the row was read (epoch ms). */
  dbNowMs: number;
  /** This server's clock when the row arrived (epoch ms). */
  readAt: number;
}

export interface PaidCallsReader {
  /** The row, or null when it does not exist yet. Rejects when the read failed. */
  read(): Promise<PaidCallsSnapshot | null>;
  /**
   * The row of the last read that succeeded (null before one, or when it found no row), kept
   * through later failures, so a database blip does not hide the count.
   */
  lastGood?(): PaidCallsSnapshot | null;
}

/** int8 values arrive as strings (pg) or numbers (PGlite); an array may arrive as text too. */
function toNumbers(value: unknown): number[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.replace(/[{}]/g, '').split(',').filter(Boolean)
      : [];
  return items.map(Number).filter((item) => Number.isFinite(item));
}

/**
 * The Base mainnet row, kept PAID_CALLS_CACHE_MS in memory per server. Concurrent callers share
 * one read; a failed read is remembered for the same time, so a database problem never turns into
 * one read per request. The last good row stays available (`lastGood`) through failures.
 */
export function createPaidCallsReader(deps: {
  db: Pick<Database, 'query'>;
  clock: () => number;
  ttlMs?: number;
  chainId?: number;
}): PaidCallsReader {
  const ttl = deps.ttlMs ?? PAID_CALLS_CACHE_MS;
  const chainId = deps.chainId ?? PAID_CALLS_CHAIN_ID;
  let cached: { value: PaidCallsSnapshot | null; failed: boolean; until: number } | null = null;
  let inflight: Promise<PaidCallsSnapshot | null> | null = null;
  let good: PaidCallsSnapshot | null = null;
  async function refresh(): Promise<PaidCallsSnapshot | null> {
    const started = deps.clock();
    try {
      const row = (
        await deps.db.query<{ total: unknown; recent: unknown; now_ms: unknown }>(
          PAID_CALLS_READ_SQL,
          [chainId],
        )
      ).rows[0];
      const value = row
        ? {
            total: Number(row.total),
            recent: toNumbers(row.recent),
            dbNowMs: Number(row.now_ms),
            readAt: deps.clock(),
          }
        : null;
      if (value && (!Number.isSafeInteger(value.total) || !Number.isFinite(value.dbNowMs)))
        throw new Error('paid_call_count: unreadable row');
      cached = { value, failed: false, until: started + ttl };
      good = value;
      return value;
    } catch (error) {
      cached = { value: null, failed: true, until: started + ttl };
      throw error;
    } finally {
      inflight = null;
    }
  }
  return {
    read() {
      if (cached && deps.clock() < cached.until)
        return cached.failed
          ? Promise.reject(new Error('paid_call_count: read failed recently'))
          : Promise.resolve(cached.value);
      return (inflight ??= refresh());
    },
    lastGood: () => good,
  };
}

/**
 * The public field, worked out when the response is built (`now`, this server's clock), so the
 * time the row spent in this server's memory is part of every age:
 * - `as_of`: the database clock at the read, plus the time since the read;
 * - `recent_ms`: from each payment's block to `as_of`, only those within the window, newest first,
 *   never below 0 (a block stamped a little ahead of the database clock), never more than `total`;
 * - `recent_complete`: false when all of the kept block times fall inside the window, so more may
 *   exist than are listed.
 */
export function paidCallsField(snapshot: PaidCallsSnapshot, now: number): PaidCallsField {
  const asOf = snapshot.dbNowMs + Math.max(0, now - snapshot.readAt);
  const ages = snapshot.recent.map((at) => asOf - at).sort((a, b) => a - b);
  const inWindow = ages.filter((age) => age <= PAID_CALLS_RECENT_WINDOW_MS);
  return {
    total: snapshot.total,
    as_of: new Date(asOf).toISOString(),
    recent_ms: inWindow
      .slice(0, Math.max(0, Math.min(snapshot.total, PAID_CALLS_RECENT_MAX)))
      .map((age) => Math.max(0, Math.round(age))),
    recent_complete: !(
      snapshot.recent.length >= PAID_CALLS_RECENT_MAX && inWindow.length === snapshot.recent.length
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// The daily check (in the 12:30 UTC cron, server/stats/fast-count-check.ts)

/** The check's own time limit: the cron function stays at 58 s of its 60 s (45 + 5 + 5 + 3). */
export const PAID_CALLS_CHECK_TIMEOUT_MS = 3_000;

/** One statement, so both numbers come from the same moment. */
export const PAID_CALLS_CHECK_SQL = `SELECT
  (SELECT total FROM paid_call_count WHERE chain_id = $1) AS counter,
  (SELECT count(*) FROM feed_pay_calls WHERE chain_id = $1 AND payment_state = 'settled') AS scan`;

/**
 * Adds the difference found (scan minus the counter as read), so payments that settle meanwhile
 * (each already +1) stay counted exactly once. One short statement on one row, in the same
 * transaction as the read and under the check's own lock (PAID_CALLS_CHECK_LOCK_SQL), so two runs
 * never both add the same difference.
 */
export const PAID_CALLS_REPAIR_SQL = `INSERT INTO paid_call_count AS c (chain_id, total, recent, updated_at)
  VALUES ($1, $2::bigint, '{}', (extract(epoch FROM clock_timestamp()) * 1000)::bigint)
  ON CONFLICT (chain_id) DO UPDATE SET
    total = GREATEST(0, c.total + ($2::bigint - $3::bigint)),
    updated_at = EXCLUDED.updated_at`;

/**
 * One check per chain at a time: a transaction-scoped advisory lock, tried, never waited for. A
 * run that finds it taken (a doubled cron delivery, a manual run during the scheduled one) does
 * nothing; the run holding it reads and repairs in one transaction. The payment path never takes
 * this lock.
 */
export const PAID_CALLS_CHECK_LOCK_SQL = `SELECT pg_try_advisory_xact_lock(hashtextextended('paid_call_count:check:' || $1::text, 0)) AS ok`;

/** Every chain with a counter row or a settled call, Base mainnet first. */
export const PAID_CALLS_CHAINS_SQL = `SELECT chain_id FROM (
    SELECT chain_id FROM paid_call_count
    UNION SELECT chain_id FROM feed_pay_calls WHERE payment_state = 'settled'
  ) chains ORDER BY chain_id <> $1, chain_id`;

export interface PaidCallsCheckResult {
  /** The counter before the check (null: no row). */
  counter: number | null;
  /** Settled Base mainnet calls, scanned. */
  scan: number;
  /** counter minus scan (a missing counter counts as 0). */
  drift: number;
  repaired: boolean;
  /** The chain checked (absent: Base mainnet, the default). */
  chain_id?: number;
}

export type PaidCallsCheckLog = (level: 'info' | 'error', fields: Record<string, unknown>) => void;

/** A short code for the log: the SQLSTATE when there is one, never a message. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : 'error';
}

/**
 * Compares the counter with a scan of the settled calls of one chain (Base mainnet by default)
 * and, when they differ, adds the difference. The read and the repair are one transaction under
 * the check's own advisory lock, so overlapping runs never both add the same difference: a run
 * that finds the lock taken returns null and logs `paid_calls_check_skipped`. Never throws: a
 * timeout or any other failure is logged (counts and a code only) and returns null, so the other
 * daily checks still run. Before migration 125 (or in a database without Feed pay) there is
 * nothing to check and nothing is logged.
 */
export async function checkPaidCalls(
  db: Pick<Database, 'transaction'>,
  options: {
    log?: PaidCallsCheckLog;
    timeoutMs?: number;
    now?: () => number;
    chainId?: number;
  } = {},
): Promise<PaidCallsCheckResult | null> {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const chainId = options.chainId ?? PAID_CALLS_CHAIN_ID;
  const deadline = now() + (options.timeoutMs ?? PAID_CALLS_CHECK_TIMEOUT_MS);
  // Base mainnet's lines stay as they were; another chain's carry its id.
  const chain = chainId === PAID_CALLS_CHAIN_ID ? {} : { chain_id: chainId };
  try {
    const outcome = await db.transaction(async (tx) => {
      const bounded = boundedBy(deadline, now);
      const present = (
        await bounded<{ ok: boolean }>(
          tx,
          "SELECT to_regclass('paid_call_count') IS NOT NULL AND to_regclass('feed_pay_calls') IS NOT NULL AS ok",
        )
      ).rows[0]?.ok;
      if (!present) return null;
      const locked = (await bounded<{ ok: boolean }>(tx, PAID_CALLS_CHECK_LOCK_SQL, [chainId]))
        .rows[0]?.ok;
      if (!locked) return 'busy' as const;
      const row = (
        await bounded<{ counter: unknown; scan: unknown }>(tx, PAID_CALLS_CHECK_SQL, [chainId])
      ).rows[0];
      const counter =
        row?.counter === null || row?.counter === undefined ? null : Number(row.counter);
      const scan = Number(row?.scan ?? 0);
      const drift = (counter ?? 0) - scan;
      // In step, or nothing settled yet and no row: nothing to add.
      const repair = !(drift === 0 && (counter !== null || scan === 0));
      if (repair) await bounded(tx, PAID_CALLS_REPAIR_SQL, [chainId, scan, counter ?? 0]);
      return { counter, scan, drift, repaired: repair };
    });
    if (outcome === null) return null;
    if (outcome === 'busy') {
      log('info', { event: 'paid_calls_check_skipped', ...chain });
      return null;
    }
    const { counter, scan, drift, repaired } = outcome;
    if (!repaired) {
      log('info', {
        event: 'paid_calls_check',
        ...chain,
        paid_calls_counter: counter,
        paid_calls_scan: scan,
        paid_calls_drift: 0,
      });
      return { counter, scan, drift: 0, repaired: false, ...chain };
    }
    log('error', {
      event: 'paid_calls_check',
      ...chain,
      paid_calls_counter: counter,
      paid_calls_scan: scan,
      paid_calls_drift: drift,
      repaired: true,
    });
    return { counter, scan, drift, repaired: true, ...chain };
  } catch (error) {
    const code = errorCode(error);
    const timeout = code === '57014' || code === 'budget_exhausted';
    log('error', {
      event: 'paid_calls_check_failed',
      ...chain,
      paid_calls_check_timeout: timeout ? 1 : 0,
      error: code,
    });
    return null;
  }
}

/** Runs each statement with statement_timeout set to the time left before `deadline`. */
function boundedBy(deadline: number, now: () => number) {
  return async <T>(tx: Pick<Transaction, 'query'>, sql: string, params?: unknown[]) => {
    const left = deadline - now();
    if (left <= 0) throw Object.assign(new Error('budget'), { code: 'budget_exhausted' });
    await tx.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(left))}`);
    return tx.query<T>(sql, params);
  };
}

/**
 * The daily check for every chain that has a counter row or a settled call: Base mainnet first,
 * then the others (each keeps its own row; only Base mainnet is shown). One time budget for all
 * of them; what is left over waits for the next day. Never throws.
 */
export async function checkPaidCallsAllChains(
  db: Pick<Database, 'transaction'>,
  options: { log?: PaidCallsCheckLog; timeoutMs?: number; now?: () => number } = {},
): Promise<PaidCallsCheckResult[]> {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? PAID_CALLS_CHECK_TIMEOUT_MS);
  let chains: number[];
  try {
    chains = await db.transaction(async (tx) => {
      const bounded = boundedBy(deadline, now);
      const present = (
        await bounded<{ ok: boolean }>(
          tx,
          "SELECT to_regclass('paid_call_count') IS NOT NULL AND to_regclass('feed_pay_calls') IS NOT NULL AS ok",
        )
      ).rows[0]?.ok;
      if (!present) return [];
      return (
        await bounded<{ chain_id: unknown }>(tx, PAID_CALLS_CHAINS_SQL, [PAID_CALLS_CHAIN_ID])
      ).rows.map((row) => Number(row.chain_id));
    });
  } catch (error) {
    const code = errorCode(error);
    log('error', {
      event: 'paid_calls_check_failed',
      paid_calls_check_timeout: code === '57014' || code === 'budget_exhausted' ? 1 : 0,
      error: code,
    });
    return [];
  }
  const results: PaidCallsCheckResult[] = [];
  for (const chainId of chains) {
    const left = deadline - now();
    if (left <= 0) {
      log('error', {
        event: 'paid_calls_check_failed',
        paid_calls_check_timeout: 1,
        error: 'budget_exhausted',
        paid_calls_chains_left: chains.length - results.length,
      });
      break;
    }
    const result = await checkPaidCalls(db, { log, now, chainId, timeoutMs: left });
    if (result) results.push(result);
  }
  return results;
}
