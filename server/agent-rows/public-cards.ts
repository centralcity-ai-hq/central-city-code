/*
 * The backfill of agent_public_cards (migration 280, public-cards-schema.ts): the agents that
 * existed before the migration, filled in by a cron a few workspaces per run. Every write since
 * the migration keeps the table itself (its triggers).
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../database.js';
import { cronAuthorized } from '../wake/cron.js';

export const PUBLIC_CARDS_BACKFILL_PATH = '/api/cron/public-cards';
/**
 * Workspaces one backfill run rebuilds at most, and the time it may spend (one cron minute).
 * Measured in production with a cap of 200: every run rebuilt its 200 in 2.3 to 6.1 s (worst
 * 6.107 s, about 30.5 ms per workspace). 400 at that worst rate is about 12.2 s, well inside the
 * 30 s budget; 1000 would be about 30.5 s and overrun it. That rate was measured over every
 * workspace in order, empty ones included; with the skip below only workspaces with something to
 * rebuild count, which may cost more each, and then the budget ends a run before the cap. The
 * budget is checked between steps only: one slow step (each statement is bounded by the 8 s
 * statement timeout, a lock wait by the 5 s lock timeout) can still end a run past it, within
 * the function's 300 s limit.
 */
export const PUBLIC_CARDS_BACKFILL_WORKSPACES = 400;
export const PUBLIC_CARDS_BACKFILL_BUDGET_MS = 30_000;
/**
 * Workspaces one step reads ahead of the cursor for the fast skip: a contiguous leading run of
 * empty workspaces (EMPTY_WORKSPACE) up to this many is passed in one cursor update. One ordered
 * index scan with this LIMIT, stopped at the first workspace that is not empty.
 */
export const PUBLIC_CARDS_SKIP_WINDOW = 5_000;
/** Empty workspaces one run passes at most (50 windows); the time budget also ends it. */
export const PUBLIC_CARDS_SKIP_MAX = 250_000;

/**
 * The cursor's position in operator id order (0 to 1), read from its first two hex digits, for the
 * run log only; 0 before the first workspace, null for a cursor that is not a UUID. An ordering
 * position (prefix), not a measured completion: as a share of workspaces walked it holds only if
 * operator ids are uniformly random (randomUUID()). It names no id (8 bits of one).
 */
export function cursorPosition(afterOperator: string | null): number | null {
  if (afterOperator === null) return 0;
  const head = /^([0-9a-f]{2})[0-9a-f]{6}-/i.exec(afterOperator)?.[1];
  return head === undefined ? null : parseInt(head, 16) / 256;
}

/**
 * A workspace whose rebuild would write nothing: in document mode (no rows-mode storage row), no
 * agent record in its document by workspace_agents()'s own reading (agents missing, JSON null or
 * anything but an array is no agents; an array must be empty, so even a record without an id is
 * rebuilt), and no card row with its operator_id (a stale card is rebuilt, which removes it). The
 * rebuild refreshes the union of exactly those two sets, here empty: agent_public_cards_refresh
 * of no ids returns at once. Tested only for the rows it reaches, in order (the agents test first);
 * OFFSET 0 keeps each probe a per-row index lookup (workspace_storage's key,
 * agent_public_cards_operator), never a hash of the whole table built before the first row.
 */
const EMPTY_WORKSPACE = `NOT EXISTS (SELECT 1 FROM workspace_agents(w.operator_id, w.data) OFFSET 0)
  AND NOT EXISTS (SELECT 1 FROM workspace_storage st
                   WHERE st.operator_id = w.operator_id AND st.mode = 'rows' OFFSET 0)
  AND NOT EXISTS (SELECT 1 FROM agent_public_cards c
                   WHERE c.operator_id = w.operator_id OFFSET 0)`;

/**
 * One statement (one snapshot), bounded by LIMIT $2: in operator id order after the cursor, the
 * first workspace that is not empty, or else the window's last workspace (all empty); `n` is its
 * place in the window, no row means no workspace is left. Rows are tested in order and the outer
 * LIMIT 1 ends the scan at the first match, so a workspace with agents right after the cursor
 * costs one row (and one read ahead for lead()).
 */
const SKIP_SCAN = `SELECT s.operator_id, s.n::int AS n, s.empty FROM (
    SELECT w.operator_id, row_number() OVER (ORDER BY w.operator_id) AS n,
           lead(w.operator_id) OVER (ORDER BY w.operator_id) IS NULL AS last,
           w.empty
      FROM (SELECT w.operator_id, ${EMPTY_WORKSPACE} AS empty FROM workspaces w
             WHERE $1::text IS NULL OR w.operator_id > $1::text
             ORDER BY w.operator_id LIMIT $2) w) s
  WHERE NOT s.empty OR s.last
  ORDER BY s.operator_id LIMIT 1`;

/** The cursor was not where this step read it: the step is rolled back and the run ends. */
class CursorMoved extends Error {}

/**
 * One backfill run, in steps of one transaction each. A step holds the cursor row (FOR UPDATE SKIP
 * LOCKED: a second run at the same time ends instead of repeating the work) and reads ahead of the
 * cursor without locking any workspace (SKIP_SCAN):
 * - the contiguous empty workspaces before the first one that is not are passed (skipped): their
 *   rebuild would write nothing, and any later write that gives one an agent refreshes that
 *   agent's card itself (the workspaces and agents triggers), as it would after a rebuild;
 * - that first workspace, if any, is rebuilt while its row is held FOR SHARE (a concurrent
 *   workspace write waits for it, then its trigger refreshes what it changed);
 * - the cursor then moves to it (or to the window's last empty workspace) in one compare-and-set
 *   update from the cursor the step read; if that finds the cursor moved, the step rolls back.
 * Workspaces created after the migration were filled by their insert trigger already; rebuilding
 * them is harmless. Once no workspace is left the backfill is ready and every later run is one
 * read. `workspaces` counts the rebuilt ones (capped), `skipped` the passed ones (capped too).
 */
export async function backfillPublicCards(
  db: Pick<Database, 'query' | 'transaction'>,
  options: {
    now?: () => number;
    budgetMs?: number;
    maxWorkspaces?: number;
    skipWindow?: number;
    maxSkipped?: number;
  } = {},
): Promise<{ ready: boolean; workspaces: number; skipped: number }> {
  const now = options.now ?? Date.now;
  const started = now();
  const budget = options.budgetMs ?? PUBLIC_CARDS_BACKFILL_BUDGET_MS;
  const max = options.maxWorkspaces ?? PUBLIC_CARDS_BACKFILL_WORKSPACES;
  const maxSkipped = options.maxSkipped ?? PUBLIC_CARDS_SKIP_MAX;
  let workspaces = 0;
  let skipped = 0;
  for (;;) {
    const ready = (
      await db.query<{ ready: boolean }>(
        'SELECT ready FROM agent_public_cards_backfill WHERE id = 1',
      )
    ).rows[0]?.ready;
    if (ready !== false) return { ready: Boolean(ready), workspaces, skipped };
    if (workspaces >= max || skipped >= maxSkipped || now() - started >= budget)
      return { ready: false, workspaces, skipped };
    // Never more ahead than the run may still pass (at least one, the step's own workspace).
    const window = Math.max(
      1,
      Math.min(Math.floor(options.skipWindow ?? PUBLIC_CARDS_SKIP_WINDOW), maxSkipped - skipped),
    );
    let step: { rebuilt: number; passed: number } | null;
    try {
      step = await db.transaction(async (tx) => {
        const state = (
          await tx.query<{ after_operator: string | null; ready: boolean }>(
            `SELECT after_operator, ready FROM agent_public_cards_backfill
             WHERE id = 1 FOR UPDATE SKIP LOCKED`,
          )
        ).rows[0];
        // Another run holds the cursor (or it is gone): this run ends.
        if (!state || state.ready) return null;
        const after = state.after_operator;
        const scan = (
          await tx.query<{ operator_id: string; n: number; empty: boolean }>(SKIP_SCAN, [
            after,
            window,
          ])
        ).rows[0];
        const rebuild = scan && !scan.empty ? scan.operator_id : null;
        if (rebuild !== null) {
          await tx.query('SELECT 1 FROM workspaces WHERE operator_id = $1 FOR SHARE', [rebuild]);
          await tx.query(
            `SELECT agent_public_cards_refresh(ARRAY(
               SELECT wa.agent->>'id' FROM workspaces w
               CROSS JOIN LATERAL workspace_agents(w.operator_id, w.data) wa
               WHERE w.operator_id = $1 AND wa.agent->>'id' IS NOT NULL
               UNION SELECT agent_id FROM agent_public_cards WHERE operator_id = $1))`,
            [rebuild],
          );
        }
        // Only from the cursor this step read: two runs at once never skip a workspace. No
        // workspace left after the cursor: ready.
        const moved = await tx.query(
          `UPDATE agent_public_cards_backfill SET after_operator = $2, ready = $3, updated_at = $4
           WHERE id = 1 AND after_operator IS NOT DISTINCT FROM $1 RETURNING id`,
          [after, scan?.operator_id ?? after, !scan, now()],
        );
        if (moved.rows.length === 0) throw new CursorMoved();
        return {
          rebuilt: rebuild === null ? 0 : 1,
          passed: !scan ? 0 : scan.n - (rebuild ? 1 : 0),
        };
      });
    } catch (error) {
      if (error instanceof CursorMoved) return { ready: false, workspaces, skipped };
      throw error;
    }
    if (!step) return { ready: false, workspaces, skipped };
    workspaces += step.rebuilt;
    skipped += step.passed;
  }
}

/** The backfill's cron (vercel.json crons, every minute); without the secret the route is absent. */
export function registerPublicCardsCron(
  app: FastifyInstance,
  deps: { db: Database; cronSecret?: string; now?: () => number },
): void {
  const cronSecret = deps.cronSecret;
  if (!cronSecret) return;
  app.get(PUBLIC_CARDS_BACKFILL_PATH, async (request, reply) => {
    if (!cronAuthorized(request.headers.authorization, cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    const clock = deps.now ?? Date.now;
    const started = clock();
    const result = await backfillPublicCards(deps.db, deps.now ? { now: deps.now } : {});
    // The log only (the answer is unchanged): the run's own cost, the workspaces it rebuilt and
    // skipped (counts), and the cursor's ordering position (cursorPosition), never an id.
    if (result.workspaces > 0 || result.skipped > 0 || !result.ready) {
      const ms = clock() - started;
      const { rows } = await deps.db.query<{ after_operator: string | null }>(
        'SELECT after_operator FROM agent_public_cards_backfill WHERE id = 1',
      );
      const position = rows[0] ? cursorPosition(rows[0].after_operator) : null;
      console.info(
        JSON.stringify({ event: 'public_cards_backfill', ...result, ms, cursorPosition: position }),
      );
    }
    return reply.header('Cache-Control', 'no-store').send(result);
  });
}
