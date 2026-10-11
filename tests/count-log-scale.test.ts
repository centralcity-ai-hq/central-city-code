import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.js';
import { generateSigningKey } from '../server/manifest/keys.js';
import { CheckpointInProgress, createCountLog } from '../server/count-log/index.js';
import { rootAndConsistency } from '../server/count-log/tree.js';
import type { Database } from '../server/database.js';
import {
  consistencyProof,
  merkleRoot,
  toHex,
  verifyChain,
  verifyConsistency,
  fromHex,
} from '../shared/count-log/index.js';
import { legacyCheckpoint } from './count-log-legacy.js';

/*
 * The batched, resumable checkpoint must publish exactly what the original single-transaction
 * algorithm (tests/count-log-legacy.ts) publishes for the same data: same leaves (idx, salt, day,
 * hash), same withdrawals, same checkpoint bytes (root, sub-counts, hash, signature, proof).
 */

const DAY = 86_400_000;
type App = Awaited<ReturnType<typeof createApp>>;

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  return { app, db: app.city.db as Database };
}

/** Deterministic salts for agents missing from the pending feed. */
function salts() {
  let n = 0;
  return () => new Uint8Array(createHash('sha256').update(`salt-${n++}`).digest());
}

/** count operators with one agent each, created `start` + 2 s apart. */
async function seed(
  db: Database,
  from: number,
  count: number,
  start: string,
  options: { kind?: string; recorded?: boolean } = {},
) {
  if (options.recorded === false)
    await db.query('ALTER TABLE workspaces DISABLE TRIGGER count_log_pending_on_insert');
  await db.query(
    `INSERT INTO operators(id,name,name_key,password_hash,salt,kind)
      SELECT 'op'||g, 'Op '||g, 'op'||g, 'x', 'x', $3 FROM generate_series($1::int,$2::int) g`,
    [from, from + count - 1, options.kind ?? 'unclaimed'],
  );
  await db.query(
    `INSERT INTO workspaces(operator_id,data)
      SELECT 'op'||g, jsonb_build_object('agents', jsonb_build_array(jsonb_build_object(
        'id', 'agent-'||lpad(g::text,8,'0'), 'name', 'A'||g,
        'createdAt', to_char(($3::timestamptz + (g-$1) * interval '2 second') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))))
      FROM generate_series($1::int,$2::int) g`,
    [from, from + count - 1, start],
  );
  if (options.recorded === false)
    await db.query('ALTER TABLE workspaces ENABLE TRIGGER count_log_pending_on_insert');
}

async function logState(db: Database) {
  const leaves = (
    await db.query<{
      idx: number;
      agent_id: string;
      salt: Buffer;
      created_day: string;
      leaf_hash: Buffer;
    }>('SELECT idx, agent_id, salt, created_day, leaf_hash FROM count_log_leaves ORDER BY idx')
  ).rows.map((row) => [
    Number(row.idx),
    row.agent_id,
    Buffer.from(row.salt).toString('hex'),
    row.created_day,
    Buffer.from(row.leaf_hash).toString('hex'),
  ]);
  const withdrawn = (
    await db.query<{ idx: number; reason: string; day: string }>(
      'SELECT idx, reason, day FROM count_log_withdrawn ORDER BY idx',
    )
  ).rows.map((row) => [Number(row.idx), row.reason, row.day]);
  return { leaves, withdrawn };
}

/** Runs the original algorithm on the current data and rolls it back. */
async function legacyResult(
  db: Database,
  deps: Omit<Parameters<typeof legacyCheckpoint>[0], 'db'>,
) {
  const rollback = new Error('rollback');
  let result: { checkpoint: unknown; state: Awaited<ReturnType<typeof logState>> } | null = null;
  await db
    .transaction(async (tx) => {
      const inner: Database = {
        ...tx,
        transaction: (action) => action(tx),
        close: async () => {},
      };
      const { checkpoint } = await legacyCheckpoint({ ...deps, db: inner });
      result = { checkpoint, state: await logState(inner) };
      throw rollback;
    })
    .catch((error) => {
      if (error !== rollback) throw error;
    });
  return result!;
}

test('streamed root and consistency proofs equal the shared RFC 6962 helpers', async () => {
  const leaves = Array.from(
    { length: 70 },
    (_, i) => new Uint8Array(createHash('sha256').update(`leaf-${i}`).digest()),
  );
  async function* pages(n: number, size: number) {
    for (let i = 0; i < n; i += size) yield leaves.slice(i, Math.min(i + size, n));
  }
  for (let n = 0; n <= leaves.length; n++) {
    const subset = leaves.slice(0, n);
    const expectedRoot = toHex(await merkleRoot(subset));
    for (let m = 0; m <= n; m++) {
      const { root, consistency } = await rootAndConsistency(n, m, pages(n, 7));
      assert.equal(toHex(root), expectedRoot, `root n=${n}`);
      assert.deepEqual(
        consistency.map(toHex),
        (await consistencyProof(subset, m)).map(toHex),
        `proof ${m}->${n}`,
      );
    }
    const { root, consistency } = await rootAndConsistency(n, null, pages(n, 3));
    assert.equal(toHex(root), expectedRoot);
    assert.deepEqual(consistency, []);
  }
});

test('batched checkpoints are byte-identical to the original algorithm over several days', async (t) => {
  const { app, db } = await fixture(t);
  const key = generateSigningKey('count-scale-test');
  let now = Date.parse('2026-10-01T00:10:00Z');
  const excludedOperators = ['op9000'];
  const deps = () => ({ clock: () => now, signingKey: key, excludedOperators, salt: salts() });
  const check = async (budgetMs?: number) => {
    const expected = await legacyResult(db, deps());
    const log = createCountLog({ ...deps(), db, budgetMs });
    let result;
    for (;;)
      try {
        result = await log.checkpoint();
        break;
      } catch (error) {
        if (!(error instanceof CheckpointInProgress)) throw error;
      }
    assert.equal(result.created, true);
    assert.deepEqual(result.checkpoint, expected.checkpoint);
    assert.deepEqual(await logState(db), expected.state);
    // Idempotent: the same day returns the stored checkpoint.
    const again = await log.checkpoint();
    assert.equal(again.created, false);
    assert.deepEqual(again.checkpoint, expected.checkpoint);
    return result.checkpoint;
  };

  // Day 1: empty log.
  await check();
  // Day 2: pending-feed agents, agents the feed missed (fresh salts), owners and unclaimed,
  // an excluded operator, a demo seed, a revoked agent, an unparsable creation time.
  now += DAY;
  await seed(db, 1, 1500, '2026-09-30T23:00:00Z');
  await seed(db, 2001, 300, '2026-10-01T12:00:00Z', { recorded: false, kind: 'owner' });
  await seed(db, 9000, 3, '2026-10-01T12:00:00Z');
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', data->'agents' || jsonb_build_array(
       jsonb_build_object('id','demo-1','name','Demo','demoKey','k'),
       jsonb_build_object('id','bad-time','name','Bad','createdAt','not a time'),
       jsonb_build_object('id','revoked-1','name','R','createdAt','2026-10-01T03:00:00Z','revokedAt','2026-10-01T04:00:00Z')))
     WHERE operator_id='op1'`,
  );
  await check(0);
  // Day 3: more agents, and two counted agents removed (withdrawn, never erased).
  now += DAY;
  await seed(db, 3001, 2200, '2026-10-02T08:00:00Z');
  await seed(db, 6001, 40, '2026-10-02T09:00:00Z', { recorded: false });
  await db.query(
    `UPDATE workspaces SET data='{"agents":[]}'::jsonb WHERE operator_id IN ('op5','op2002')`,
  );
  await check(0);
  // Day 4: nothing new.
  now += DAY;
  await check();

  const chain = await createCountLog({ db, clock: () => now }).checkpoints();
  assert.deepEqual(await verifyChain(chain), []);
  assert.equal(chain.at(-1)!.withdrawn, 2);
  const log = createCountLog({ db, clock: () => now });
  assert.equal((await log.subcountsOn(chain.at(-1)!.date))!.subcounts.revoked, 1);
});

test('30k agents (25k new) finish in one run within the time budget', async (t) => {
  const { db } = await fixture(t);
  let now = Date.parse('2026-10-02T00:10:00Z');
  const log = createCountLog({ db, clock: () => now });
  await seed(db, 1, 5_000, '2026-10-01T00:00:00Z');
  const first = await log.checkpoint();
  assert.equal(first.checkpoint.tree_size, 5_000);
  await seed(db, 5_001, 25_000, '2026-10-02T00:20:00Z');
  now = Date.parse('2026-10-03T10:00:00Z');
  const started = performance.now();
  const { checkpoint, created } = await log.checkpoint();
  const elapsed = performance.now() - started;
  t.diagnostic(`checkpoint of 25,000 new agents (30,000 total): ${Math.round(elapsed)} ms`);
  assert.equal(created, true);
  assert.equal(checkpoint.date, '2026-10-03');
  assert.equal(checkpoint.tree_size, 30_000);
  assert.ok(elapsed < 20_000, `took ${elapsed} ms`);
  const leaves = (
    await db.query<{ leaf_hash: Buffer }>('SELECT leaf_hash FROM count_log_leaves ORDER BY idx')
  ).rows.map((row) => new Uint8Array(row.leaf_hash));
  assert.equal(checkpoint.root, toHex(await merkleRoot(leaves)));
  assert.ok(
    await verifyConsistency(
      5_000,
      30_000,
      fromHex(first.checkpoint.root),
      fromHex(checkpoint.root),
      checkpoint.consistency.map(fromHex),
    ),
  );
});

test('an interrupted run resumes from the committed batches and signs the same checkpoint', async (t) => {
  const { db } = await fixture(t);
  const key = generateSigningKey('count-resume-test');
  const now = Date.parse('2026-10-03T10:00:00Z');
  await seed(db, 1, 3_500, '2026-10-02T00:00:00Z');
  await seed(db, 4_001, 200, '2026-10-02T06:00:00Z', { recorded: false });
  const expected = await legacyResult(db, { clock: () => now, signingKey: key, salt: salts() });

  const feedBefore = await createCountLog({ db, clock: () => now }).feed({});
  assert.equal(feedBefore.total_now, 3_500);

  // The third batch's INSERT fails (a crashed or timed-out invocation): two batches stay committed.
  let inserts = 0;
  const failing: Database = {
    ...db,
    transaction: (action) =>
      db.transaction((tx) =>
        action({
          ...tx,
          query: async (sql, params) => {
            if (sql.startsWith('INSERT INTO count_log_leaves') && ++inserts === 3)
              throw new Error('simulated timeout');
            return tx.query(sql, params);
          },
        }),
      ),
  };
  const salt = salts();
  await assert.rejects(
    createCountLog({ db: failing, clock: () => now, signingKey: key, salt }).checkpoint(),
    /simulated timeout/,
  );
  assert.equal((await logState(db)).leaves.length, 2_000);
  assert.equal(
    (await db.query('SELECT 1 FROM count_log_checkpoints')).rows.length,
    0,
    'no checkpoint before every leaf is in',
  );
  // Appended but not yet in a checkpoint: the feed still shows them as pending, with their numbers.
  const feedDuring = await createCountLog({ db, clock: () => now }).feed({});
  assert.equal(feedDuring.total_now, feedBefore.total_now);
  assert.deepEqual(feedDuring.entries, feedBefore.entries);

  // The retry stops at its budget once, then finishes. Salts continue from the same source, as a
  // real retry draws fresh random salts for agents not yet appended.
  const log = createCountLog({ db, clock: () => now, signingKey: key, salt, budgetMs: 0 });
  await assert.rejects(log.checkpoint(), CheckpointInProgress);
  assert.equal((await logState(db)).leaves.length, 3_000);
  const { checkpoint, created } = await log.checkpoint();
  assert.equal(created, true);
  // Pending-feed agents (salt from the feed) and the order are identical; the 200 agents the
  // feed missed get salts from the source in the same order, so the whole state matches.
  assert.deepEqual(checkpoint, expected.checkpoint);
  assert.deepEqual(await logState(db), expected.state);
  assert.deepEqual((await log.checkpoint()).checkpoint, expected.checkpoint);
});

test('checkpoint() reports each phase with its timing (for the production function logs)', async (t) => {
  const { db } = await fixture(t);
  const events: { event: string; fields: Record<string, number> }[] = [];
  const now = Date.parse('2026-10-03T10:00:00Z');
  const log = createCountLog({
    db,
    clock: () => now,
    log: (event, fields) => events.push({ event, fields }),
  });
  await seed(db, 1, 2_000, '2026-10-02T00:00:00Z');
  const { checkpoint } = await log.checkpoint();
  assert.equal(checkpoint.tree_size, 2_000);
  const names = events.map((e) => e.event.replace('count_log.checkpoint.', ''));
  // Listing with work to do, the batches, then listing again (nothing left) and finalizing.
  assert.deepEqual(names, [
    'locked',
    'listed',
    'locked',
    'listed',
    'tail',
    'withdraw',
    'subcounts',
    'tree_hash',
  ]);
  assert.equal(events[1]!.fields.fresh, 2_000);
  assert.equal(events[3]!.fields.fresh, 0);
  assert.equal(events[7]!.fields.size, 2_000);
  for (const { fields } of events) assert.ok(fields.ms >= 0);
});

/** A database whose every checkpoint transaction is followed by one newly created agent, as in production while agents are created all the time. */
function withArrivals(db: Database, counter: { tx: number; next: number }): Database {
  return {
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
    transaction: async (action) => {
      counter.tx++;
      if (counter.tx > 200) throw new Error(`livelock: ${counter.tx} transactions`);
      const result = await db.transaction(action);
      await seed(db, counter.next++, 1, '2026-10-03T09:00:00Z');
      return result;
    },
  };
}

test('while agents keep arriving, the last batch is signed in the same run instead of listing forever', async (t) => {
  const { db } = await fixture(t);
  const now = Date.parse('2026-10-03T10:00:00Z');
  await seed(db, 1, 500, '2026-10-02T00:00:00Z');
  const counter = { tx: 0, next: 100_000 };
  const log = createCountLog({ db: withArrivals(db, counter), clock: () => now, budgetMs: 1 });
  const { checkpoint, created } = await log.checkpoint();
  assert.equal(created, true);
  // Everything listed is in; agents created afterwards wait for tomorrow.
  assert.ok(checkpoint.tree_size >= 500, String(checkpoint.tree_size));
  assert.ok(counter.tx <= 2, `${counter.tx} transactions`);
});

test('while agents keep arriving, a large backlog hands over at its budget and a later run signs', async (t) => {
  const { db } = await fixture(t);
  const now = Date.parse('2026-10-03T10:00:00Z');
  await seed(db, 1, 2_500, '2026-10-02T00:00:00Z');
  const counter = { tx: 0, next: 100_000 };
  const log = createCountLog({ db: withArrivals(db, counter), clock: () => now, budgetMs: 1 });
  let handedOver = 0;
  let result: Awaited<ReturnType<typeof log.checkpoint>> | null = null;
  for (let call = 0; call < 6 && !result; call++) {
    try {
      result = await log.checkpoint();
    } catch (error) {
      assert.ok(error instanceof CheckpointInProgress, String(error));
      handedOver++;
    }
  }
  assert.ok(result, 'signed within six runs');
  assert.equal(result!.created, true);
  assert.ok(handedOver >= 1, 'the backlog is larger than one budget');
  assert.ok(result!.checkpoint.tree_size >= 2_500);
});

test('a run that finds the count-log lock held stops at once as busy, without waiting', async (t) => {
  const { db } = await fixture(t);
  await seed(db, 1, 1_000, '2026-10-02T00:00:00Z');
  let held = true;
  // Another run (or a stopped run whose statement still executes) holds the lock.
  const contended: Database = {
    ...db,
    transaction: (action) =>
      db.transaction((tx) =>
        action({
          ...tx,
          query: (async (sql: string, params?: unknown[]) =>
            held && sql.includes('pg_try_advisory_xact_lock')
              ? { rows: [{ ok: false }] }
              : tx.query(sql, params as never)) as typeof tx.query,
        }),
      ),
  };
  const log = createCountLog({ db: contended, clock: () => Date.parse('2026-10-03T10:00:00Z') });
  const busy = await log.checkpoint().catch((error: unknown) => error);
  assert.ok(busy instanceof CheckpointInProgress);
  assert.equal(busy.busy, true);
  assert.equal(busy.appended, 0);
  assert.equal(
    Number(
      (await db.query<{ n: string }>('SELECT count(*) AS n FROM count_log_leaves')).rows[0]!.n,
    ),
    0,
  );
  // Once the lock is free, the next run does the whole checkpoint.
  held = false;
  const { checkpoint, created } = await log.checkpoint();
  assert.equal(created, true);
  assert.equal(checkpoint.tree_size, 1_000);
});
