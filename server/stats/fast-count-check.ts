import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database, Transaction } from '../database.js';
import { checkRoomCounts } from '../rooms/overview.js';
import { AI_AGENTS_TOTAL_SCAN_SQL, AI_AGENTS_TOTAL_SQL } from './public-stats.js';

/**
 * Daily guard that the fast public count (`counted_agent_ids`, kept by triggers, migration 59)
 * still equals the published definition (AI_AGENTS_TOTAL_SCAN_SQL, a scan over every workspace
 * document).
 *
 * Detection: one READ ONLY, REPEATABLE READ transaction (one snapshot, so a workspace write in
 * between cannot look like drift) computes the fast count, the scan, and the operators whose kept
 * rows differ from their document (a full join of kept pairs and expected pairs, grouped by
 * operator). Expected pairs follow the triggers' row rule, `counted_agent_ids_of`.
 *
 * Repair: one short transaction per differing operator, which locks only that operator's
 * workspace row (SELECT ... FOR UPDATE, as a workspace write does) and fixes only that operator's
 * kept rows. No table-wide lock: every other operator's writes go on.
 *
 * Budget: the whole run (detection and repair) gets one time budget, well inside the function's
 * 60 s limit. Before every statement, statement_timeout is set to the budget left at that moment.
 * When the budget runs out, a statement times out, or a busy workspace row hits lock_timeout, the
 * repair stops, logs `fast_count_repair_partial` (operators repaired and left, the error code)
 * and returns the partial summary; the next daily run continues.
 *
 * Log lines carry counts only: no agent ids, operator ids or names.
 */

/** The whole run's time budget: well inside the function's 60 s limit. */
export const FAST_COUNT_CHECK_BUDGET_MS = 45_000;
/** At most this many differing operators are listed (and repaired) per run. */
export const FAST_COUNT_REPAIR_MAX_OPERATORS = 10_000;
/** The closing fast count (an index-only scan) runs outside the budget, with its own short limit. */
export const FAST_COUNT_AFTER_TIMEOUT_MS = 5_000;

export interface FastCountCheckResult {
  fast: number;
  scan: number;
  /** True when the counts differ or any operator's kept rows differ from its document. */
  drift: boolean;
  /** Operators whose kept rows differed, and how many of them this run repaired. */
  operators: number;
  repaired: number;
  /** Rows the repair removed from and added to counted_agent_ids. */
  removed: number;
  added: number;
  /** False when the budget ran out before every differing operator was repaired. */
  complete: boolean;
  /**
   * Why the repair stopped early: a SQLSTATE such as 57014 (statement timeout) or 55P03 (lock
   * timeout), `budget_exhausted`, or `error`; null when it did not stop early.
   */
  stopped: string | null;
  /** The fast count after the repair (equals `scan` unless workspaces changed meanwhile); null if it could not be read. */
  fast_after: number | null;
}

export type FastCountLog = (level: 'info' | 'error', fields: Record<string, unknown>) => void;

const defaultLog: FastCountLog = (level, fields) =>
  (level === 'error' ? console.error : console.info)(JSON.stringify(fields));

export const DIFFERING_OPERATORS_SQL = `WITH expected AS MATERIALIZED (
    SELECT w.operator_id, n.agent_id
      FROM workspaces w CROSS JOIN LATERAL counted_agent_ids_of(w.data) n
  )
  SELECT COALESCE(e.operator_id, c.operator_id) AS operator_id
    FROM expected e
    FULL JOIN counted_agent_ids c ON c.operator_id = e.operator_id AND c.agent_id = e.agent_id
   WHERE e.agent_id IS NULL OR c.agent_id IS NULL
   GROUP BY 1
   ORDER BY 1
   LIMIT $1`;
/** Locks the one workspace row, exactly as a workspace write would. */
const LOCK_OPERATOR_SQL = 'SELECT 1 FROM workspaces WHERE operator_id = $1 FOR UPDATE';
const REMOVE_STALE_SQL = `DELETE FROM counted_agent_ids c
   WHERE c.operator_id = $1
     AND NOT EXISTS (
       SELECT 1 FROM workspaces w CROSS JOIN LATERAL counted_agent_ids_of(w.data) n
        WHERE w.operator_id = $1 AND n.agent_id = c.agent_id)
  RETURNING 1`;
const ADD_MISSING_SQL = `INSERT INTO counted_agent_ids(operator_id, agent_id)
    SELECT w.operator_id, n.agent_id
      FROM workspaces w CROSS JOIN LATERAL counted_agent_ids_of(w.data) n
     WHERE w.operator_id = $1
    ON CONFLICT DO NOTHING
  RETURNING 1`;

async function count(
  tx: Pick<Transaction, 'query'>,
  sql: string,
  excluded: readonly string[],
): Promise<number> {
  const row = (await tx.query<{ n: string | number }>(sql, [[...excluded]])).rows[0];
  return Number(row?.n ?? 0);
}

/** statement_timeout for the remaining budget (an integer of milliseconds, at least 1). */
const timeoutSql = (ms: number) => `SET LOCAL statement_timeout = ${Math.max(1, Math.floor(ms))}`;

export interface FastCountCheckOptions {
  excludedOperators?: readonly string[];
  log?: FastCountLog;
  budgetMs?: number;
  /** Milliseconds; injectable for tests. */
  now?: () => number;
}

export async function checkFastCount(
  db: Pick<Database, 'transaction'>,
  options: FastCountCheckOptions = {},
): Promise<FastCountCheckResult> {
  const excluded = options.excludedOperators ?? [];
  const log = options.log ?? defaultLog;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? FAST_COUNT_CHECK_BUDGET_MS);
  const remaining = () => deadline - now();

  /**
   * Runs one statement with statement_timeout set from the budget left right now, so the
   * statements of one transaction together never exceed the run's budget.
   */
  const bounded = async <T = Record<string, unknown>>(
    tx: Pick<Transaction, 'query'>,
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> => {
    const left = remaining();
    if (left <= 0) throw new BudgetExhausted();
    await tx.query(timeoutSql(left));
    return tx.query<T>(sql, params);
  };
  const countIn = async (tx: Pick<Transaction, 'query'>, sql: string) =>
    Number((await bounded<{ n: string | number }>(tx, sql, [[...excluded]])).rows[0]?.n ?? 0);

  const detected = await db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return {
      fast: await countIn(tx, AI_AGENTS_TOTAL_SQL),
      scan: await countIn(tx, AI_AGENTS_TOTAL_SCAN_SQL),
      operators: (
        await bounded<{ operator_id: string }>(tx, DIFFERING_OPERATORS_SQL, [
          FAST_COUNT_REPAIR_MAX_OPERATORS,
        ])
      ).rows.map((row) => row.operator_id),
    };
  });
  const { fast, scan, operators } = detected;
  if (fast === scan && operators.length === 0) {
    log('info', { event: 'fast_count_ok', count: fast });
    return {
      fast,
      scan,
      drift: false,
      operators: 0,
      repaired: 0,
      removed: 0,
      added: 0,
      complete: true,
      stopped: null,
      fast_after: fast,
    };
  }
  log('error', {
    event: 'fast_count_drift',
    fast,
    scan,
    diff: fast - scan,
    operators: operators.length,
  });

  let repaired = 0;
  let removed = 0;
  let added = 0;
  let stopped: string | null = null;
  for (const operatorId of operators) {
    try {
      const fixed = await db.transaction(async (tx) => {
        await bounded(tx, LOCK_OPERATOR_SQL, [operatorId]);
        return {
          removed: (await bounded(tx, REMOVE_STALE_SQL, [operatorId])).rows.length,
          added: (await bounded(tx, ADD_MISSING_SQL, [operatorId])).rows.length,
        };
      });
      repaired++;
      removed += fixed.removed;
      added += fixed.added;
    } catch (error) {
      // The budget ran out, a statement timed out (57014), a busy row hit lock_timeout (55P03),
      // or anything else: this operator's transaction rolled back; stop and report what is done.
      stopped = errorCode(error);
      break;
    }
  }
  // The list itself is capped; a longer list continues on the next run as well.
  const complete =
    stopped === null &&
    repaired === operators.length &&
    operators.length < FAST_COUNT_REPAIR_MAX_OPERATORS;
  let fastAfter: number | null = null;
  try {
    fastAfter = await db.transaction(async (tx) => {
      await tx.query(timeoutSql(FAST_COUNT_AFTER_TIMEOUT_MS));
      return count(tx, AI_AGENTS_TOTAL_SQL, excluded);
    });
  } catch {
    // Reported as null; the repair itself is already committed.
  }
  if (complete) log('info', { event: 'fast_count_reconciled', repaired, removed, added });
  else
    log('error', {
      event: 'fast_count_repair_partial',
      repaired,
      removed,
      added,
      remaining_operators: operators.length - repaired,
      ...(stopped ? { error: stopped } : {}),
    });
  return {
    fast,
    scan,
    drift: true,
    operators: operators.length,
    repaired,
    removed,
    added,
    complete,
    stopped,
    fast_after: fastAfter,
  };
}

class BudgetExhausted extends Error {
  readonly code = 'budget_exhausted';
  constructor() {
    super('The fast count check has no time budget left.');
  }
}

/** A short code for the log: the SQLSTATE when there is one, never a message (no ids). */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : 'error';
}

function bearerMatches(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Vercel Cron (GET with Authorization: Bearer CRON_SECRET), daily at 12:30 UTC. Also checks the
 * room overview counters (server/rooms/overview.ts checkRoomCounts) in the same run.
 */
export function registerFastCountCheckRoute(
  app: FastifyInstance,
  d: {
    db: Pick<Database, 'transaction'>;
    excludedOperators: readonly string[];
    /** Without it the route answers 404, like the other cron routes. */
    cronSecret?: string;
    log?: FastCountLog;
  },
): void {
  app.get('/api/cron/fast-count-check', async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, d.cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    const log = d.log ?? defaultLog;
    // The two checks are wrapped separately: one throwing never skips the other.
    let result: FastCountCheckResult | null = null;
    let failure: unknown = null;
    try {
      result = await checkFastCount(d.db, { excludedOperators: d.excludedOperators, log: d.log });
    } catch (error) {
      failure = error;
      log('error', { event: 'fast_count_check_failed', error: errorCode(error) });
    }
    // Room overview counters (migration 64): same daily run, own small budget, so the whole
    // function stays inside its 60 s limit (45 s + 5 s + 5 s).
    // Its outcome goes to the log only (counts, never ids); the response stays the agent count's.
    try {
      await checkRoomCounts(d.db, { repair: true, log });
    } catch (error) {
      log('error', { event: 'room_counts_check_threw', error: errorCode(error) });
    }
    if (!result) throw failure;
    return reply.header('Cache-Control', 'no-store').send(result);
  });
}
