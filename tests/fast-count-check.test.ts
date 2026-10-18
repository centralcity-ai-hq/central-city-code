import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import { createApp } from '../server/app.js';
import {
  checkFastCount,
  registerFastCountCheckRoute,
  type FastCountLog,
} from '../server/stats/fast-count-check.js';
import { AI_AGENTS_TOTAL_SCAN_SQL, AI_AGENTS_TOTAL_SQL } from '../server/stats/public-stats.js';
import { COUNTED_AGENT_IDS_SQL, COUNTED_AGENT_IDS_SYNC_SQL } from '../server/stats/schema.js';
import type { Database, Transaction } from '../server/database.js';
import {
  checkPaidCalls,
  checkPaidCallsAllChains,
  PAID_CALLS_CHECK_LOCK_SQL,
  PAID_CALLS_REPAIR_SQL,
  PAID_CALLS_CHECK_SQL,
  PAID_CALLS_CHECK_TIMEOUT_MS,
} from '../server/stats/paid-calls.js';
import { base, call, counts, migrated, settle } from './paid-calls-fixtures.js';

const SECRET = 'fast-count-cron-secret-0123456789';

async function seeded(t: { after: (fn: () => Promise<unknown>) => void }) {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec('CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL)');
  await db.exec(COUNTED_AGENT_IDS_SQL);
  // The trigger function as migration 111 replaced it.
  await db.exec(COUNTED_AGENT_IDS_SYNC_SQL);
  const put = (operatorId: string, ids: string[], extra: unknown[] = []) =>
    db.query('INSERT INTO workspaces(operator_id,data) VALUES($1,$2::jsonb)', [
      operatorId,
      JSON.stringify({ agents: [...ids.map((id) => ({ id, name: id })), ...extra], jobs: [] }),
    ]);
  await put('owner-1', ['a1', 'a2', 'a3'], [{ id: 'd1', demoKey: 'Scout' }]);
  await put('bucket-1', ['u1', 'u2']);
  await put('canary', ['c1']);
  const rows = async () =>
    (
      await db.query<{ operator_id: string; agent_id: string }>(
        'SELECT operator_id, agent_id FROM counted_agent_ids ORDER BY 1, 2',
      )
    ).rows;
  const counts = async (excluded: string[] = []) => ({
    fast: Number((await db.query<{ n: string }>(AI_AGENTS_TOTAL_SQL, [excluded])).rows[0]!.n),
    scan: Number((await db.query<{ n: string }>(AI_AGENTS_TOTAL_SCAN_SQL, [excluded])).rows[0]!.n),
  });
  return { db, rows, counts };
}

function recorder() {
  const lines: { level: string; fields: Record<string, unknown> }[] = [];
  const log: FastCountLog = (level, fields) => lines.push({ level, fields });
  return { lines, log };
}

/** Wraps db.transaction to record every statement and run hooks after chosen ones. */
function spied(
  db: PGlite,
  after: (sql: string, tx: Transaction, txIndex: number) => Promise<void> = async () => {},
) {
  const seen: string[] = [];
  let txIndex = 0;
  const wrapped: Pick<Database, 'transaction'> = {
    transaction: (action) => {
      const index = txIndex++;
      return db.transaction(async (raw) => {
        const tx: Transaction = {
          query: async (sql, params) => {
            seen.push(sql);
            const result = await raw.query(sql, params as never);
            await after(sql, tx, index);
            return result as never;
          },
          exec: (sql) => raw.exec(sql),
        };
        return action(tx);
      });
    },
  };
  return { wrapped, seen };
}

test('fast count check: a match changes nothing and logs one info line', async (t) => {
  const { db, rows, counts } = await seeded(t);
  const before = await rows();
  const { lines, log } = recorder();
  const result = await checkFastCount(db, { excludedOperators: ['canary'], log });
  assert.deepEqual(result, {
    fast: 5,
    scan: 5,
    drift: false,
    operators: 0,
    repaired: 0,
    removed: 0,
    added: 0,
    complete: true,
    stopped: null,
    fast_after: 5,
  });
  assert.deepEqual(await rows(), before);
  assert.deepEqual(lines, [{ level: 'info', fields: { event: 'fast_count_ok', count: 5 } }]);
  assert.deepEqual(await counts(['canary']), { fast: 5, scan: 5 });
});

test('fast count check: missing and bogus rows are detected, logged without ids, and reconciled per operator', async (t) => {
  const { db, rows, counts } = await seeded(t);
  const before = await rows();
  // Corrupt the kept table: drop two real ids, add three that no document holds.
  await db.query(`DELETE FROM counted_agent_ids WHERE agent_id IN ('a2','u1')`);
  await db.query(
    `INSERT INTO counted_agent_ids VALUES ('owner-1','ghost-1'), ('nobody','ghost-2'), ('owner-1','ghost-3')`,
  );
  assert.deepEqual(await counts(['canary']), { fast: 6, scan: 5 });
  const { lines, log } = recorder();
  const result = await checkFastCount(db, { excludedOperators: ['canary'], log });
  assert.deepEqual(result, {
    fast: 6,
    scan: 5,
    drift: true,
    operators: 3,
    repaired: 3,
    removed: 3,
    added: 2,
    complete: true,
    stopped: null,
    fast_after: 5,
  });
  assert.deepEqual(lines[0], {
    level: 'error',
    fields: { event: 'fast_count_drift', fast: 6, scan: 5, diff: 1, operators: 3 },
  });
  assert.equal(lines[1]?.fields.event, 'fast_count_reconciled');
  const logged = JSON.stringify(lines);
  for (const id of ['ghost', 'owner-1', 'bucket-1', 'nobody'])
    assert.ok(!logged.includes(id), `no ids in the log: ${id}`);
  assert.deepEqual(await rows(), before);
  assert.deepEqual(await counts(['canary']), { fast: 5, scan: 5 });
  // The next run finds no drift.
  assert.equal((await checkFastCount(db, { log: () => {} })).drift, false);
  // A drift that only removes rows (the count runs low) is caught too.
  await db.query(`DELETE FROM counted_agent_ids WHERE operator_id = 'bucket-1'`);
  const low = await checkFastCount(db, { log: () => {} });
  assert.deepEqual([low.fast, low.scan, low.operators, low.added, low.fast_after], [4, 6, 1, 2, 6]);
  // So is one that swaps an id for a bogus one: equal totals, wrong rows.
  await db.query(`UPDATE counted_agent_ids SET agent_id = 'swapped' WHERE agent_id = 'a1'`);
  const swapped = await checkFastCount(db, { log: () => {} });
  assert.deepEqual([swapped.fast, swapped.scan, swapped.drift, swapped.operators], [6, 6, true, 1]);
  assert.deepEqual(await rows(), before);
});

test('fast count check: detection reads one snapshot, read only; a repair locks one workspace row and other writes go on', async (t) => {
  const { db, rows, counts } = await seeded(t);
  await db.query(`DELETE FROM counted_agent_ids WHERE agent_id IN ('a1','u1')`);
  const modes: string[] = [];
  const { wrapped, seen } = spied(db, async (sql, tx) => {
    if (sql.includes('FOR UPDATE')) {
      // Inside a repair: the only lock on workspaces is the row-level one (RowShareLock), which
      // conflicts with no workspace write; never a table lock (Share or stronger).
      modes.push(
        ...(
          await tx.query<{ mode: string }>(
            `SELECT mode FROM pg_locks WHERE relation = 'workspaces'::regclass`,
          )
        ).rows.map((row) => row.mode),
      );
    }
  });
  const result = await checkFastCount(wrapped, { log: () => {} });
  assert.equal(result.repaired, 2);
  assert.match(seen[0]!, /^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY$/);
  // Every statement gets its own timeout from the budget left at that moment.
  assert.deepEqual(
    seen.slice(1, 6).map((sql) => sql.replace(/\d+$/, 'N')),
    [
      'SET LOCAL statement_timeout = N',
      AI_AGENTS_TOTAL_SQL,
      'SET LOCAL statement_timeout = N',
      AI_AGENTS_TOTAL_SCAN_SQL,
      'SET LOCAL statement_timeout = N',
    ],
  );
  for (let i = 1; i < seen.length; i++)
    if (!seen[i]!.startsWith('SET ') && !seen[i]!.includes('pg_locks'))
      assert.match(seen[i - 1]!, /^SET LOCAL statement_timeout = \d+$/, seen[i]);
  assert.ok(!seen.some((sql) => /LOCK TABLE/i.test(sql)), 'no table lock');
  assert.ok(modes.length > 0);
  for (const mode of modes) assert.ok(['RowShareLock', 'AccessShareLock'].includes(mode), mode);
  assert.equal(
    seen.filter((sql) => sql.includes('FOR UPDATE')).length,
    2,
    'one row lock per operator',
  );
  assert.deepEqual(await counts(), { fast: 6, scan: 6 });

  // A concurrent write to another operator between repairs succeeds and is kept by its trigger.
  await db.query(`DELETE FROM counted_agent_ids WHERE agent_id IN ('a1','u1')`);
  const interleaved = spied(db);
  let n = 0;
  const between: Pick<Database, 'transaction'> = {
    transaction: async (action) => {
      if (n++ === 2)
        await db.query(
          `UPDATE workspaces SET data = jsonb_set(data, '{agents}', data->'agents' || '[{"id":"c2"}]')
            WHERE operator_id = 'canary'`,
        );
      return interleaved.wrapped.transaction(action);
    },
  };
  const again = await checkFastCount(between, { log: () => {} });
  assert.equal(again.repaired, 2);
  assert.ok((await rows()).some((row) => row.agent_id === 'c2'));
  assert.deepEqual(await counts(), { fast: 7, scan: 7 });
  assert.equal((await checkFastCount(db, { log: () => {} })).drift, false);
});

test('fast count check: one time budget; a partial repair is logged and the next run completes it', async (t) => {
  const { db, rows } = await seeded(t);
  const before = await rows();
  await db.query(`DELETE FROM counted_agent_ids WHERE agent_id IN ('a1','u1','c1')`);
  // A clock that advances 1 s per reading (one reading per statement): the start, detection's
  // three statements and operator 1's three fit a 6.5 s budget; operator 2's first does not.
  let clock = 0;
  const now = () => (clock += 1_000) - 1_000;
  const { lines, log } = recorder();
  const partial = await checkFastCount(db, { log, now, budgetMs: 6_500 });
  assert.deepEqual(
    [partial.drift, partial.operators, partial.repaired, partial.complete, partial.stopped],
    [true, 3, 1, false, 'budget_exhausted'],
  );
  assert.deepEqual(lines.at(-1), {
    level: 'error',
    fields: {
      event: 'fast_count_repair_partial',
      repaired: 1,
      removed: 0,
      added: 1,
      remaining_operators: 2,
      error: 'budget_exhausted',
    },
  });
  assert.notDeepEqual(await rows(), before);
  const next = await checkFastCount(db, { log: () => {} });
  assert.deepEqual([next.operators, next.repaired, next.complete], [2, 2, true]);
  assert.deepEqual(await rows(), before);
  // A budget exhausted before detection runs nothing.
  await assert.rejects(
    checkFastCount(db, { log: () => {}, now: () => (clock += 60_000), budgetMs: 1 }),
  );
});

/** A database error with a SQLSTATE, as pg raises it. */
const sqlError = (code: string) => Object.assign(new Error('canceled'), { code });

test('fast count check: a statement timeout under a tiny budget stops the repair with a partial summary', async (t) => {
  const { db, rows } = await seeded(t);
  const before = await rows();
  await db.query(`DELETE FROM counted_agent_ids WHERE agent_id IN ('a1','u1','c1')`);
  // Postgres cancels a statement that outlives statement_timeout (57014); PGlite does not enforce
  // the timeout, so the spy plays that part. Operator 1's repair is slow (about 40 s, within its
  // timeout); operator 2's statement then needs 100 ms with only about 10 ms of budget left.
  let clock = 0;
  let timeoutMs = Infinity;
  let repairs = 0;
  const { wrapped } = spied(db, async (sql) => {
    const set = /^SET LOCAL statement_timeout = (\d+)$/.exec(sql);
    if (set) timeoutMs = Number(set[1]);
    if (!sql.includes('FOR UPDATE')) return;
    const took = ++repairs === 1 ? 39_990 : 100;
    if (took > timeoutMs) throw sqlError('57014');
    clock += took;
  });
  const { lines, log } = recorder();
  const result = await checkFastCount(wrapped, { log, now: () => clock, budgetMs: 40_000 });
  assert.deepEqual(
    [result.operators, result.repaired, result.complete, result.stopped, result.fast_after],
    [3, 1, false, '57014', 4],
  );
  assert.deepEqual(lines.at(-1)?.fields, {
    event: 'fast_count_repair_partial',
    repaired: 1,
    removed: 0,
    added: 1,
    remaining_operators: 2,
    error: '57014',
  });
  // The timed-out operator's transaction rolled back; the next run finishes the rest.
  const next = await checkFastCount(db, { log: () => {} });
  assert.deepEqual([next.repaired, next.complete], [2, true]);
  assert.deepEqual(await rows(), before);
});

test('fast count check: a lock timeout on one busy row stops the repair; the route answers 200 with the partial summary', async (t) => {
  const { db, rows } = await seeded(t);
  const before = await rows();
  await db.query(`DELETE FROM counted_agent_ids WHERE agent_id IN ('a1','u1')`);
  // The pool's lock_timeout (55P03) on the busy 'owner-1' row; 'bucket-1' (first in order) is fixed.
  const { wrapped } = spied(db, async (sql) => {
    if (sql.includes('FOR UPDATE') && busy) throw sqlError('55P03');
  });
  let busy = false;
  const busyOnOwner: Pick<Database, 'transaction'> = {
    transaction: (action) =>
      wrapped.transaction((tx) =>
        action({
          ...tx,
          query: (sql, params) => {
            busy = sql.includes('FOR UPDATE') && (params as string[])[0] === 'owner-1';
            return tx.query(sql, params);
          },
        }),
      ),
  };
  const app = Fastify();
  t.after(() => app.close());
  const { lines, log } = recorder();
  registerFastCountCheckRoute(app, {
    db: busyOnOwner as never,
    excludedOperators: [],
    cronSecret: SECRET,
    log,
  });
  const response = await app.inject({
    url: '/api/cron/fast-count-check',
    headers: { authorization: `Bearer ${SECRET}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    fast: 4,
    scan: 6,
    drift: true,
    operators: 2,
    repaired: 1,
    removed: 0,
    added: 1,
    complete: false,
    stopped: '55P03',
    fast_after: 5,
  });
  assert.deepEqual(lines.at(-1)?.fields, {
    event: 'fast_count_repair_partial',
    repaired: 1,
    removed: 0,
    added: 1,
    remaining_operators: 1,
    error: '55P03',
  });
  assert.ok(!JSON.stringify(lines).includes('owner-1'));
  const next = await checkFastCount(db, { log: () => {} });
  assert.deepEqual([next.repaired, next.complete], [1, true]);
  assert.deepEqual(await rows(), before);
});

test('the scan and the check treat a non-array agents value (null, object, text) as empty', async (t) => {
  const { db, counts } = await seeded(t);
  await db.query(
    `INSERT INTO workspaces VALUES ('null-agents', '{"agents":null}'::jsonb),
      ('object-agents', '{"agents":{"id":"x"}}'::jsonb), ('text-agents', '{"agents":"x"}'::jsonb),
      ('no-agents', '{"jobs":[]}'::jsonb)`,
  );
  assert.deepEqual(await counts(), { fast: 6, scan: 6 });
  assert.equal((await checkFastCount(db, { log: () => {} })).drift, false);
});

test('GET /api/cron/fast-count-check: 404 without the cron bearer, JSON summary with it', async (t) => {
  const { db } = await seeded(t);
  const app = Fastify();
  t.after(() => app.close());
  registerFastCountCheckRoute(app, {
    db,
    excludedOperators: ['canary'],
    cronSecret: SECRET,
    log: () => {},
  });
  for (const authorization of [undefined, 'Bearer wrong', `Bearer ${SECRET}x`, SECRET])
    assert.equal(
      (
        await app.inject({
          url: '/api/cron/fast-count-check',
          headers: authorization ? { authorization } : {},
        })
      ).statusCode,
      404,
    );
  await db.query(`DELETE FROM counted_agent_ids WHERE agent_id = 'a1'`);
  const response = await app.inject({
    url: '/api/cron/fast-count-check',
    headers: { authorization: `Bearer ${SECRET}` },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    fast: 4,
    scan: 5,
    drift: true,
    operators: 1,
    repaired: 1,
    removed: 0,
    added: 1,
    complete: true,
    stopped: null,
    fast_after: 5,
  });
  // Without a configured secret the route always answers 404.
  const bare = Fastify();
  t.after(() => bare.close());
  registerFastCountCheckRoute(bare, { db, excludedOperators: [] });
  assert.equal(
    (
      await bare.inject({
        url: '/api/cron/fast-count-check',
        headers: { authorization: 'Bearer ' },
      })
    ).statusCode,
    404,
  );
});

test('wired into the app behind CRON_SECRET and scheduled after the checkpoint window', async (t) => {
  const saved = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  t.after(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/api/cron/fast-count-check' })).statusCode, 404);
  const response = await app.inject({
    url: '/api/cron/fast-count-check',
    headers: { authorization: `Bearer ${SECRET}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().drift, false);
  const { readFile } = await import('node:fs/promises');
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    crons?: { path: string; schedule: string }[];
  };
  assert.ok(
    config.crons?.some(
      (cron) => cron.path === '/api/cron/fast-count-check' && cron.schedule === '30 12 * * *',
    ),
  );
});

test('cron: the agent count and the room counts check are wrapped separately', async (t) => {
  const { db } = await seeded(t);
  // 1) The agent count throws: the room counts check still runs; the route reports the failure.
  {
    const seen: string[] = [];
    let first = true;
    const failingFirst: Pick<Database, 'transaction'> = {
      transaction: (action) => {
        if (first) {
          first = false;
          return Promise.reject(Object.assign(new Error('boom'), { code: 'XX000' }));
        }
        return db.transaction((tx) =>
          action({
            ...tx,
            query: (sql: string, params?: unknown[]) => {
              seen.push(sql);
              return tx.query(sql, params);
            },
          } as Transaction),
        );
      },
    };
    const app = Fastify();
    t.after(() => app.close());
    const { lines, log } = recorder();
    registerFastCountCheckRoute(app, {
      db: failingFirst as never,
      excludedOperators: [],
      cronSecret: SECRET,
      log,
    });
    const response = await app.inject({
      url: '/api/cron/fast-count-check',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.equal(response.statusCode, 500);
    assert.ok(seen.some((sql) => sql.includes("to_regclass('room_counts')")));
    assert.deepEqual(lines[0]?.fields, { event: 'fast_count_check_failed', error: 'XX000' });
  }
  // 2) The room counts check throws: the agent count's summary is still answered.
  {
    const app = Fastify();
    t.after(() => app.close());
    const { lines, log: base } = recorder();
    const log: FastCountLog = (level, fields) => {
      if (
        String(fields.event).startsWith('room_counts_') &&
        fields.event !== 'room_counts_check_threw'
      )
        throw new Error('room counts failed');
      base(level, fields);
    };
    const roomsPresent: Pick<Database, 'transaction'> = {
      transaction: (action) =>
        db.transaction((tx) =>
          action({
            ...tx,
            query: (sql: string, params?: unknown[]) =>
              sql.includes("to_regclass('room_counts')")
                ? Promise.resolve({ rows: [{ t: 'room_counts' }] })
                : tx.query(sql, params),
          } as Transaction),
        ),
    };
    registerFastCountCheckRoute(app, {
      db: roomsPresent as never,
      excludedOperators: [],
      cronSecret: SECRET,
      log,
    });
    const response = await app.inject({
      url: '/api/cron/fast-count-check',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().drift, false);
    assert.deepEqual(lines.at(-1)?.fields, { event: 'room_counts_check_threw', error: 'error' });
  }
});

// ---------------------------------------------------------------------------------------------
// The paid service calls count (migration 125, server/stats/paid-calls.ts checkPaidCalls), in the
// same daily run.

/** Wraps db.transaction: `before` runs ahead of each transaction (by index), `query` may throw. */
function paidSpied(
  db: Pick<Database, 'transaction'>,
  hooks: {
    before?: (index: number) => Promise<void>;
    query?: (sql: string, tx: Transaction) => void | Promise<void>;
    /** Rows to answer instead of running the statement. */
    answer?: (sql: string) => Record<string, unknown>[] | undefined;
  } = {},
) {
  const seen: string[] = [];
  let index = 0;
  const wrapped: Pick<Database, 'transaction'> = {
    transaction: async (action) => {
      await hooks.before?.(index++);
      return db.transaction((tx) =>
        action({
          ...tx,
          query: async (sql: string, params?: unknown[]) => {
            seen.push(sql);
            await hooks.query?.(sql, tx);
            const rows = hooks.answer?.(sql);
            if (rows) return { rows } as never;
            return tx.query(sql, params);
          },
        } as Transaction),
      );
    },
  };
  return { wrapped, seen };
}

test('paid calls check: a match logs counts only and changes nothing', async (t) => {
  const db = await migrated(t);
  for (let i = 0; i < 3; i++) await settle(db, await call(db));
  const { lines, log } = recorder();
  const { wrapped, seen } = paidSpied(db);
  assert.deepEqual(await checkPaidCalls(wrapped, { log }), {
    counter: 3,
    scan: 3,
    drift: 0,
    repaired: false,
  });
  assert.deepEqual(lines, [
    {
      level: 'info',
      fields: {
        event: 'paid_calls_check',
        paid_calls_counter: 3,
        paid_calls_scan: 3,
        paid_calls_drift: 0,
      },
    },
  ]);
  // One read transaction; both numbers from one statement, each statement under the 3 s limit.
  assert.equal(seen.filter((sql) => sql === PAID_CALLS_CHECK_SQL).length, 1);
  assert.equal(PAID_CALLS_CHECK_TIMEOUT_MS, 3_000);
  for (const sql of seen.filter((item) => item.startsWith('SET LOCAL statement_timeout')))
    assert.ok(Number(/= (\d+)/.exec(sql)![1]) <= 3_000, sql);
  assert.equal(await base(db), 3);
});

test('paid calls check: repairs a counter that is too low, too high or missing; other chains stay', async (t) => {
  const db = await migrated(t);
  for (let i = 0; i < 3; i++) await settle(db, await call(db));
  await settle(db, await call(db, { chainId: 84532 }));
  const cases: Array<[string, string, number | null]> = [
    ['too low', 'UPDATE paid_call_count SET total = 1 WHERE chain_id = 8453', 1],
    ['too high', 'UPDATE paid_call_count SET total = 10 WHERE chain_id = 8453', 10],
    ['missing', 'DELETE FROM paid_call_count WHERE chain_id = 8453', null],
  ];
  for (const [label, sql, counter] of cases) {
    await db.query(sql);
    const { lines, log } = recorder();
    const result = await checkPaidCalls(db, { log });
    assert.deepEqual(
      result,
      { counter, scan: 3, drift: (counter ?? 0) - 3, repaired: true },
      label,
    );
    assert.deepEqual(await counts(db), { 8453: 3, 84532: 1 }, label);
    assert.deepEqual(
      lines.map((line) => [line.level, line.fields]),
      [
        [
          'error',
          {
            event: 'paid_calls_check',
            paid_calls_counter: counter,
            paid_calls_scan: 3,
            paid_calls_drift: (counter ?? 0) - 3,
            repaired: true,
          },
        ],
      ],
      label,
    );
  }
  // Repaired, the next settle counts on top.
  await settle(db, await call(db));
  assert.equal(await base(db), 4);
});

test('paid calls check: a settle during the check is counted once', async (t) => {
  const db = await migrated(t);
  for (let i = 0; i < 3; i++) await settle(db, await call(db));
  await db.query('UPDATE paid_call_count SET total = 1 WHERE chain_id = 8453');
  // After the read and before the repair, one more payment settles; its +1 lands at its commit.
  const inside = (tx: Transaction) =>
    ({ transaction: async (fn: never) => (fn as (tx: Transaction) => unknown)(tx) }) as never;
  const late = await call(db);
  const { wrapped } = paidSpied(db, {
    query: async (sql, tx) => {
      if (sql === PAID_CALLS_REPAIR_SQL) assert.equal(await settle(inside(tx), late), true);
    },
  });
  const result = await checkPaidCalls(wrapped, { log: () => {} });
  assert.deepEqual(result, { counter: 1, scan: 3, drift: -2, repaired: true });
  assert.equal(await base(db), 4);
  // The same when the row was missing and the settle creates it meanwhile.
  await db.query('DELETE FROM paid_call_count');
  const later = await call(db);
  const { wrapped: again } = paidSpied(db, {
    query: async (sql, tx) => {
      if (sql === PAID_CALLS_REPAIR_SQL) assert.equal(await settle(inside(tx), later), true);
    },
  });
  assert.deepEqual(await checkPaidCalls(again, { log: () => {} }), {
    counter: null,
    scan: 4,
    drift: -4,
    repaired: true,
  });
  assert.equal(await base(db), 5);
  assert.equal((await checkPaidCalls(db, { log: () => {} }))?.drift, 0);
});

test('paid calls check: overlapping runs add the difference once (read and repair under one lock)', async (t) => {
  const db = await migrated(t);
  for (let i = 0; i < 3; i++) await settle(db, await call(db));
  await db.query('UPDATE paid_call_count SET total = 1 WHERE chain_id = 8453');
  // A doubled cron delivery, or a manual run during the scheduled one.
  const { wrapped, seen } = paidSpied(db);
  const [a, b] = await Promise.all([
    checkPaidCalls(wrapped, { log: () => {} }),
    checkPaidCalls(wrapped, { log: () => {} }),
  ]);
  assert.equal(await base(db), 3, 'never above the settled calls');
  assert.deepEqual([a, b].map((result) => result?.drift ?? null).sort(), [-2, 0].sort());
  // The lock, the read and the repair run in one transaction, the lock first.
  const order = seen.filter((sql) =>
    [PAID_CALLS_CHECK_LOCK_SQL, PAID_CALLS_CHECK_SQL, PAID_CALLS_REPAIR_SQL].includes(sql),
  );
  assert.deepEqual(order.slice(0, 3), [
    PAID_CALLS_CHECK_LOCK_SQL,
    PAID_CALLS_CHECK_SQL,
    PAID_CALLS_REPAIR_SQL,
  ]);
  // A run that finds the lock taken does nothing and says so.
  const busy = paidSpied(db, {
    answer: (sql) => (sql === PAID_CALLS_CHECK_LOCK_SQL ? [{ ok: false }] : undefined),
  });
  await db.query('UPDATE paid_call_count SET total = 1 WHERE chain_id = 8453');
  const { lines, log } = recorder();
  assert.equal(await checkPaidCalls(busy.wrapped, { log }), null);
  assert.ok(!busy.seen.includes(PAID_CALLS_CHECK_SQL));
  assert.ok(!busy.seen.includes(PAID_CALLS_REPAIR_SQL));
  assert.deepEqual(lines, [{ level: 'info', fields: { event: 'paid_calls_check_skipped' } }]);
  assert.equal(await base(db), 1);
});

test('paid calls check: every chain row is checked, Base mainnet first, in one budget', async (t) => {
  const db = await migrated(t);
  for (let i = 0; i < 3; i++) await settle(db, await call(db));
  for (let i = 0; i < 2; i++) await settle(db, await call(db, { chainId: 84532 }));
  // A skipped +1 on the Sepolia row, and a Base mainnet row too high.
  await db.query('UPDATE paid_call_count SET total = 1 WHERE chain_id = 84532');
  await db.query('UPDATE paid_call_count SET total = 4 WHERE chain_id = 8453');
  const { lines, log } = recorder();
  assert.deepEqual(await checkPaidCallsAllChains(db, { log }), [
    { counter: 4, scan: 3, drift: 1, repaired: true },
    { counter: 1, scan: 2, drift: -1, repaired: true, chain_id: 84532 },
  ]);
  assert.deepEqual(await counts(db), { 8453: 3, 84532: 2 });
  assert.deepEqual(
    lines.map((line) => line.fields.chain_id ?? 8453),
    [8453, 84532],
  );
  // A chain with settled calls and no row at all gets its row.
  await db.query('DELETE FROM paid_call_count WHERE chain_id = 84532');
  assert.deepEqual(
    (await checkPaidCallsAllChains(db, { log: () => {} })).map((result) => result.drift),
    [0, -2],
  );
  assert.deepEqual(await counts(db), { 8453: 3, 84532: 2 });
  // No budget left: nothing checked, logged as a timeout; never thrown.
  const spent = recorder();
  assert.deepEqual(await checkPaidCallsAllChains(db, { log: spent.log, timeoutMs: 0 }), []);
  assert.equal(spent.lines.at(-1)?.fields.paid_calls_check_timeout, 1);
});

test('paid calls check: a timeout is logged, not thrown; nothing changes', async (t) => {
  const db = await migrated(t);
  for (let i = 0; i < 2; i++) await settle(db, await call(db));
  await db.query('UPDATE paid_call_count SET total = 1 WHERE chain_id = 8453');
  // The scan hits its statement timeout (57014).
  const { wrapped } = paidSpied(db, {
    query: (sql) => {
      if (sql === PAID_CALLS_CHECK_SQL) throw sqlError('57014');
    },
  });
  const { lines, log } = recorder();
  assert.equal(await checkPaidCalls(wrapped, { log }), null);
  assert.deepEqual(lines, [
    {
      level: 'error',
      fields: { event: 'paid_calls_check_failed', paid_calls_check_timeout: 1, error: '57014' },
    },
  ]);
  // A spent budget is a timeout too; any other failure is logged with its code.
  const spent = recorder();
  assert.equal(await checkPaidCalls(db, { log: spent.log, timeoutMs: 0 }), null);
  assert.deepEqual(spent.lines.at(-1)?.fields, {
    event: 'paid_calls_check_failed',
    paid_calls_check_timeout: 1,
    error: 'budget_exhausted',
  });
  const broken = paidSpied(db, {
    query: (sql) => {
      if (sql === PAID_CALLS_CHECK_SQL) throw sqlError('XX000');
    },
  });
  const other = recorder();
  assert.equal(await checkPaidCalls(broken.wrapped, { log: other.log }), null);
  assert.deepEqual(other.lines.at(-1)?.fields, {
    event: 'paid_calls_check_failed',
    paid_calls_check_timeout: 0,
    error: 'XX000',
  });
  assert.equal(await base(db), 1);
  // Before migration 125 (or without Feed pay) there is nothing to check and nothing is logged.
  const { db: bare } = await seeded(t);
  const none = recorder();
  assert.equal(await checkPaidCalls(bare, { log: none.log }), null);
  assert.deepEqual(none.lines, []);
});

test('cron: the paid calls check runs after the others, and its failure never stops them', async (t) => {
  const db = await migrated(t);
  for (let i = 0; i < 2; i++) await settle(db, await call(db));
  await db.query('UPDATE paid_call_count SET total = 1 WHERE chain_id = 8453');
  // 1) The paid calls check fails: the agent count is still answered, the room counts checked.
  {
    const { wrapped } = paidSpied(db, {
      query: (sql) => {
        if (sql === PAID_CALLS_CHECK_SQL) throw sqlError('57014');
      },
    });
    const app = Fastify();
    t.after(() => app.close());
    const { lines, log } = recorder();
    registerFastCountCheckRoute(app, {
      db: wrapped as never,
      excludedOperators: [],
      cronSecret: SECRET,
      log,
    });
    const response = await app.inject({
      url: '/api/cron/fast-count-check',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().drift, false);
    const events = lines.map((line) => line.fields.event);
    assert.deepEqual(
      [events[0], events.includes('room_counts_ok'), events.at(-1)],
      ['fast_count_ok', true, 'paid_calls_check_failed'],
    );
    assert.equal(await base(db), 1);
  }
  // 2) The agent count check throws: the paid calls check still runs and repairs.
  {
    let first = true;
    const failingFirst: Pick<Database, 'transaction'> = {
      transaction: (action) => {
        if (first) {
          first = false;
          return Promise.reject(Object.assign(new Error('boom'), { code: 'XX000' }));
        }
        return db.transaction(action);
      },
    };
    const app = Fastify();
    t.after(() => app.close());
    const { lines, log } = recorder();
    registerFastCountCheckRoute(app, {
      db: failingFirst as never,
      excludedOperators: [],
      cronSecret: SECRET,
      log,
    });
    const response = await app.inject({
      url: '/api/cron/fast-count-check',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(lines.at(-1)?.fields, {
      event: 'paid_calls_check',
      paid_calls_counter: 1,
      paid_calls_scan: 2,
      paid_calls_drift: -1,
      repaired: true,
    });
    assert.equal(await base(db), 2);
  }
});
