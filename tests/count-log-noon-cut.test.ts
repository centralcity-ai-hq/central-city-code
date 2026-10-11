import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { createApp } from '../server/app.js';
import { generateSigningKey } from '../server/manifest/keys.js';
import {
  CheckpointInProgress,
  createCountLog,
  registerCountLogRoutes,
  type CountLog,
} from '../server/count-log/index.js';
import { SEAL_SETTLE_MS } from '../server/count-log/routes.js';
import { CHECKPOINT_TX_LIMITS } from '../server/count-log/service.js';
import type { Database, Transaction } from '../server/database.js';
import { cutInstant, isCheckpointDue, verifyChain } from '../shared/count-log/index.js';
import { legacyCheckpoint } from './count-log-legacy.js';

/*
 * The noon cut. The noon checkpoint seals the agents the pending feed recorded before 12:00
 * Europe/Berlin, plus agents the feed missed that were created before it (or have no usable
 * creation time), as each listing sees them, so agents arriving after noon cannot keep the seal
 * running (tests/count-log-legacy.ts with the cut is the oracle).
 *
 * Pending rows get their record time from the database clock; the tests pin it on the injected
 * timeline (recordAt) so the cut of the injected day means what it means in production.
 */

const DAY = 86_400_000;
const SECRET = 'a-sufficiently-long-cron-secret';
const quiet = () => {};

// 2026-10-03 is a CEST day: 08:00 Berlin = 06:00 UTC, the cut (12:00 Berlin) = 10:00 UTC.
const TODAY = '2026-10-03';
const CUT = cutInstant(TODAY);
const MORNING = Date.parse('2026-10-03T07:30:00Z'); // 09:30 Berlin
const NOON = Date.parse('2026-10-03T10:05:00Z'); // 12:05 Berlin

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  return app.city.db as Database;
}

/** Deterministic salts for agents missing from the pending feed. */
function salts() {
  let n = 0;
  return () => new Uint8Array(createHash('sha256').update(`salt-${n++}`).digest());
}

const agentId = (g: number) => `agent-${String(g).padStart(8, '0')}`;

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

/**
 * Sets the pending feed's record time of these agents (the table is append-only, so the guard is
 * lifted for the update only): the trigger stamps the real time, the tests run on an injected day.
 */
async function recordAt(db: Database, ids: string[], at: number) {
  await db.query('ALTER TABLE count_log_pending DISABLE TRIGGER count_log_pending_append_only');
  await db.query('UPDATE count_log_pending SET recorded_at = $2 WHERE agent_id = ANY($1::text[])', [
    ids,
    at,
  ]);
  await db.query('ALTER TABLE count_log_pending ENABLE TRIGGER count_log_pending_append_only');
}

/** The seeded agent ids from `from` to `to`, inclusive. */
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => agentId(from + i));

async function logState(db: Pick<Database, 'query'>) {
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

/**
 * Runs the original single-transaction algorithm (with the cut) on the current data and rolls it
 */
async function legacyResult(
  db: Database,
  deps: Omit<Parameters<typeof legacyCheckpoint>[0], 'db'>,
) {
  const rollback = new Error('rollback');
  let result: { checkpoint: unknown; state: Awaited<ReturnType<typeof logState>> } | null = null;
  await db
    .transaction(async (tx) => {
      const inner: Database = { ...tx, transaction: (action) => action(tx), close: async () => {} };
      const { checkpoint } = await legacyCheckpoint({ ...deps, db: inner });
      result = { checkpoint, state: await logState(inner) };
      throw rollback;
    })
    .catch((error) => {
      if (error !== rollback) throw error;
    });
  return result!;
}

async function seal(log: CountLog, cut: number | undefined) {
  for (;;)
    try {
      return await log.checkpoint({ cut });
    } catch (error) {
      if (!(error instanceof CheckpointInProgress)) throw error;
    }
}

const leafCount = async (db: Database) =>
  Number(
    (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM count_log_leaves')).rows[0]!.n,
  );
const checkpointCount = async (db: Database) =>
  Number(
    (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM count_log_checkpoints')).rows[0]!
      .n,
  );

/** Yesterday's checkpoint (2026-10-02) over the agents seeded so far. */
async function yesterday(db: Database) {
  return seal(
    createCountLog({ db, clock: () => NOON - DAY, log: quiet }),
    cutInstant('2026-10-02'),
  );
}

test('the noon seal leaves agents recorded at or after the cut for the next day', async (t) => {
  const db = await fixture(t);
  const key = generateSigningKey('noon-cut-seal');
  await yesterday(db);
  await seed(db, 1, 300, '2026-10-02T13:00:00Z');
  await recordAt(db, range(1, 300), CUT - 3_600_000);
  // Missed by the feed (no record time): always in.
  await seed(db, 301, 20, '2026-10-03T08:00:00Z', { recorded: false });
  // Recorded exactly at the cut, and after it: tomorrow's.
  await seed(db, 321, 40, '2026-10-03T09:59:00Z');
  await recordAt(db, range(321, 360), CUT);
  await seed(db, 361, 40, '2026-10-03T10:01:00Z');
  await recordAt(db, range(361, 400), CUT + 60_000);
  const deps = () => ({ clock: () => NOON, signingKey: key, salt: salts(), log: quiet });

  const expected = await legacyResult(db, { ...deps(), cut: CUT });
  const { checkpoint, created } = await seal(createCountLog({ db, ...deps() }), CUT);
  assert.equal(created, true);
  assert.equal(checkpoint.tree_size, 320);
  assert.deepEqual(checkpoint, expected.checkpoint);
  assert.deepEqual(await logState(db), expected.state);
  const inLog = new Set((await logState(db)).leaves.map((leaf) => leaf[1]));
  for (let g = 321; g <= 400; g++) assert.ok(!inLog.has(agentId(g)), agentId(g));

  // Still pending in the public feed, numbered after today's checkpoint, counted in the total.
  const reader = createCountLog({ db, clock: () => NOON, log: quiet });
  const feed = await reader.feed({ limit: 100 });
  const pending = feed.entries.filter((entry) => entry.status === 'pending');
  assert.equal(pending.length, 80);
  assert.deepEqual(
    pending.map((entry) => entry.n).sort((a, b) => a! - b!),
    Array.from({ length: 80 }, (_, i) => 320 + i),
  );
  assert.equal(feed.total_now, 400);

  // Tomorrow's checkpoint includes them (recorded before its cut), at their provisional numbers.
  const nextDeps = () => ({ clock: () => NOON + DAY, signingKey: key, salt: salts(), log: quiet });
  const nextCut = cutInstant('2026-10-04');
  const expectedNext = await legacyResult(db, { ...nextDeps(), cut: nextCut });
  const next = await seal(createCountLog({ db, ...nextDeps() }), nextCut);
  assert.equal(next.checkpoint.tree_size, 400);
  assert.deepEqual(next.checkpoint, expectedNext.checkpoint);
  const idxOf = new Map(
    (await reader.feed({ limit: 100 })).entries.map((entry) => [entry.fingerprint, entry.idx]),
  );
  for (const entry of pending) assert.equal(idxOf.get(entry.fingerprint), entry.n);
  assert.deepEqual(await verifyChain(await reader.checkpoints()), []);
});

/** A database whose every transaction is followed by one newly created agent (recorded now). */
function withArrivals(db: Database, counter: { tx: number; next: number }): Database {
  return {
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
    transaction: async (action) => {
      counter.tx++;
      if (counter.tx > 200) throw new Error(`livelock: ${counter.tx} transactions`);
      const result = await db.transaction(action);
      await seed(db, counter.next++, 1, '2026-10-03T10:01:00Z');
      return result;
    },
  };
}

test('agents created during the seal, after the cut, never block it and wait for the next day', async (t) => {
  const db = await fixture(t);
  await seed(db, 1, 2_500, '2026-10-02T00:00:00Z');
  await recordAt(db, range(1, 2_500), CUT - 3_600_000);
  const counter = { tx: 0, next: 100_000 };
  const log = createCountLog({
    db: withArrivals(db, counter),
    clock: () => NOON,
    budgetMs: 1,
    log: quiet,
  });
  let result: Awaited<ReturnType<CountLog['checkpoint']>> | null = null;
  let handedOver = 0;
  for (let call = 0; call < 6 && !result; call++)
    try {
      result = await log.checkpoint({ cut: CUT });
    } catch (error) {
      assert.ok(error instanceof CheckpointInProgress, String(error));
      handedOver++;
    }
  assert.ok(result, 'signed within six runs');
  assert.equal(result!.created, true);
  assert.equal(handedOver, 2, 'the backlog is larger than one budget');
  // Exactly the agents recorded before the cut; the ones created meanwhile (stamped with the
  // real time, after the cut) are not in it.
  assert.equal(result!.checkpoint.tree_size, 2_500);
  const arrivals = counter.next - 100_000;
  assert.equal(arrivals, counter.tx);
  assert.ok(arrivals >= 5, String(arrivals));

  // Tomorrow's checkpoint includes them.
  await recordAt(db, range(100_000, counter.next - 1), CUT + 3_600_000);
  const next = await seal(
    createCountLog({ db, clock: () => NOON + DAY, log: quiet }),
    cutInstant('2026-10-04'),
  );
  assert.equal(next.checkpoint.tree_size, 2_500 + arrivals);
});

test('an agent the feed missed counts by its own createdAt: after the cut it waits, also across a retry', async (t) => {
  const db = await fixture(t);
  const key = generateSigningKey('noon-cut-missed');
  await yesterday(db);
  await seed(db, 1, 1_500, '2026-10-02T13:00:00Z');
  await recordAt(db, range(1, 1_500), CUT - 3_600_000);
  // Missed by the feed, created before the cut: in today's checkpoint.
  await seed(db, 2_001, 3, '2026-10-03T09:59:50Z', { recorded: false });
  const deps = () => ({ clock: () => NOON, signingKey: key, salt: salts(), log: quiet });
  const expected = await legacyResult(db, { ...deps(), cut: CUT });

  // The first run hands over after one batch (a restart in the middle of the seal) ...
  const log = createCountLog({ db, ...deps(), budgetMs: 0 });
  await assert.rejects(log.checkpoint({ cut: CUT }), CheckpointInProgress);
  // ... and meanwhile agents the feed missed arrive, created at and after the cut.
  await seed(db, 3_001, 4, new Date(CUT).toISOString(), { recorded: false });
  const { checkpoint, created } = await seal(log, CUT);
  assert.equal(created, true);
  assert.equal(checkpoint.tree_size, 1_503);
  assert.deepEqual(checkpoint, expected.checkpoint);
  const inLog = new Set((await logState(db)).leaves.map((leaf) => leaf[1]));
  for (const g of [2_001, 2_002, 2_003]) assert.ok(inLog.has(agentId(g)), agentId(g));
  for (const g of [3_001, 3_004]) assert.ok(!inLog.has(agentId(g)), agentId(g));
  // Another call the same day (a retry) returns the same checkpoint and appends nothing.
  const again = await createCountLog({ db, clock: () => NOON + 60_000, log: quiet }).checkpoint({
    cut: CUT,
  });
  assert.equal(again.created, false);
  assert.deepEqual(again.checkpoint, checkpoint);
  assert.equal(await leafCount(db), 1_503);

  // The next day's checkpoint includes them, as the oracle does.
  const nextDeps = () => ({ clock: () => NOON + DAY, signingKey: key, salt: salts(), log: quiet });
  const nextCut = cutInstant('2026-10-04');
  const expectedNext = await legacyResult(db, { ...nextDeps(), cut: nextCut });
  const next = await seal(createCountLog({ db, ...nextDeps() }), nextCut);
  assert.equal(next.checkpoint.tree_size, 1_507);
  assert.deepEqual(next.checkpoint, expectedNext.checkpoint);
  const reader = createCountLog({ db, clock: () => NOON + DAY, log: quiet });
  assert.deepEqual(await verifyChain(await reader.checkpoints()), []);
});

test('an agent the feed missed without a usable createdAt stays in (legacy rows)', async (t) => {
  const db = await fixture(t);
  await yesterday(db);
  await db.query('ALTER TABLE workspaces DISABLE TRIGGER count_log_pending_on_insert');
  await db.query(
    `INSERT INTO operators(id,name,name_key,password_hash,salt,kind)
       VALUES ('opx','Op x','opx','x','x','unclaimed')`,
  );
  await db.query(
    `INSERT INTO workspaces(operator_id,data) VALUES ('opx', jsonb_build_object('agents', jsonb_build_array(
       jsonb_build_object('id','no-time','name','N'),
       jsonb_build_object('id','bad-time','name','B','createdAt','not a time'),
       jsonb_build_object('id','feb-31','name','F','createdAt','2026-02-31T00:00:00Z'),
       jsonb_build_object('id','no-zone','name','Z','createdAt','2026-10-03T23:00:00'),
       jsonb_build_object('id','late-offset','name','L','createdAt','2026-10-03T12:00:00+02:00'),
       jsonb_build_object('id','early-offset','name','E','createdAt','2026-10-03T11:59:59.999+02:00'),
       jsonb_build_object('id','offset-plus-16','name','P','createdAt','2026-10-03T11:00:00+16:00'),
       jsonb_build_object('id','offset-minus-16','name','M','createdAt','2026-10-02T11:00:00-16:00'),
       jsonb_build_object('id','offset-plus-1559-late','name','Q','createdAt','2026-10-04T01:59:00+15:59'),
       jsonb_build_object('id','offset-minus-1559-early','name','R','createdAt','2026-10-02T18:00:00-15:59'))))`,
  );
  await db.query('ALTER TABLE workspaces ENABLE TRIGGER count_log_pending_on_insert');
  const expected = await legacyResult(db, { clock: () => NOON, salt: salts(), cut: CUT });
  const { checkpoint } = await seal(
    createCountLog({ db, clock: () => NOON, salt: salts(), log: quiet }),
    CUT,
  );
  assert.deepEqual(checkpoint, expected.checkpoint);
  const inLog = (await logState(db)).leaves.map((leaf) => String(leaf[1])).sort();
  // Offsets beyond PostgreSQL's +-15:59 are unusable (included); +-15:59 is read and cut normally.
  assert.deepEqual(inLog, [
    'bad-time',
    'early-offset',
    'feb-31',
    'no-time',
    'no-zone',
    'offset-minus-1559-early',
    'offset-minus-16',
    'offset-plus-16',
  ]);
});

test('every checkpoint transaction sets its own statement, lock and idle-in-transaction timeouts', async (t) => {
  const db = await fixture(t);
  // 2,200 agents before the cut: the listing, three batches, then the listing that signs.
  await seed(db, 1, 2_200, '2026-10-02T12:00:00Z');
  await recordAt(db, range(1, 2_200), CUT - 3_600_000);
  const transactions: string[][] = [];
  const spied: Database = {
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
    transaction: (action) =>
      db.transaction((tx) => {
        const seen: string[] = [];
        transactions.push(seen);
        const wrapped: Transaction = {
          query: (sql, params) => {
            seen.push(sql);
            return tx.query(sql, params);
          },
          exec: (sql) => tx.exec(sql),
        };
        return action(wrapped);
      }),
  };
  const log = createCountLog({ db: spied, clock: () => NOON, log: quiet });
  const { checkpoint } = await log.checkpoint({ cut: CUT });
  assert.equal(checkpoint.tree_size, 2_200);
  const limits = (kind: keyof typeof CHECKPOINT_TX_LIMITS) => [
    `SET LOCAL statement_timeout = '${CHECKPOINT_TX_LIMITS[kind].statement}'`,
    `SET LOCAL lock_timeout = '${CHECKPOINT_TX_LIMITS[kind].lock}'`,
    `SET LOCAL idle_in_transaction_session_timeout = '${CHECKPOINT_TX_LIMITS[kind].idle}'`,
  ];
  const kinds = transactions.map((statements) => {
    const head = statements.slice(0, 3);
    // The limits come first, before the lock wait they bound.
    assert.match(statements[3] ?? '', /pg_(try_)?advisory_xact_lock/);
    if (head.join() === limits('listing').join()) return 'listing';
    assert.deepEqual(head, limits('batch'));
    return 'batch';
  });
  assert.deepEqual(kinds, ['listing', 'batch', 'batch', 'batch', 'listing']);
});

function cronRoute(
  t: { after: (fn: () => Promise<unknown>) => void },
  log: CountLog,
  now: () => number,
  extra: { noonCut?: boolean; sleeps?: number[] } = {},
) {
  const api = Fastify();
  t.after(() => api.close());
  const sleeps = extra.sleeps ?? [];
  registerCountLogRoutes(api, {
    log,
    cronSecret: SECRET,
    now,
    owner: async () => {
      throw Object.assign(new Error('no'), { statusCode: 401 });
    },
    noonCut: extra.noonCut,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return () =>
    api.inject({
      url: '/api/cron/count-checkpoint',
      headers: { authorization: `Bearer ${SECRET}` },
    });
}

/** A stand-in log that records the cut the route asked it to seal with. */
function fakeLog() {
  const calls: { cut: number | undefined }[] = [];
  const signed = {
    v: 2 as const,
    date: TODAY,
    tree_size: 7,
    withdrawn: 0,
    root: '00'.repeat(32),
    prev_hash: null,
    subcounts_commitment: '11'.repeat(32),
    hash: '22'.repeat(32),
    signature: null,
    consistency: [],
  };
  let stored: typeof signed | null = null;
  const log = {
    async checkpoint(opts: { cut?: number } = {}) {
      calls.push({ cut: opts.cut });
      const created = !stored;
      stored = signed;
      return { checkpoint: signed, created };
    },
    async checkpointOn() {
      return stored;
    },
  } as unknown as CountLog;
  return { log, calls };
}

test('the cron route skips before Berlin noon and seals with the cut from noon, on both DST sides', async (t) => {
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'error', () => {});
  const days: [string, number][] = [
    ['2026-07-15', 2], // CEST
    ['2026-12-02', 1], // CET
    ['2026-10-25', 1], // fall back at 01:00 UTC: CET by noon
    ['2027-03-28', 2], // spring forward at 01:00 UTC: CEST by noon
  ];
  for (const [date, offset] of days) {
    const at = (berlin: string) => {
      const [h, m] = berlin.split(':').map(Number);
      return Date.parse(`${date}T00:00:00Z`) + ((h! - offset) * 60 + m!) * 60_000;
    };
    for (const [berlin, due] of [
      ['08:00', false],
      ['11:59', false],
      ['12:00', true],
      ['23:59', true],
      ['24:00', false],
    ] as const) {
      const now = at(berlin);
      const { log, calls } = fakeLog();
      const res = await cronRoute(t, log, () => now)();
      const label = `${date} ${berlin} Berlin (${new Date(now).toISOString()})`;
      assert.equal(res.statusCode, 200, label);
      if (!due) {
        assert.deepEqual(res.json(), { skipped: true, reason: 'not_berlin_noon_hour' }, label);
        assert.deepEqual(calls, [], label);
      } else {
        assert.equal(res.json().created, true, label);
        assert.deepEqual(calls, [{ cut: cutInstant(date) }], label);
      }
    }
  }
  // A pinned test gate (noonCut false) passes no cut and never waits.
  const pinned = fakeLog();
  const sleeps: number[] = [];
  await cronRoute(t, pinned.log, () => CUT + 1_000, { noonCut: false, sleeps })();
  assert.deepEqual(pinned.calls, [{ cut: undefined }]);
  assert.deepEqual(sleeps, []);
});

test('a seal right after the cut first waits until cut + SEAL_SETTLE_MS for pre-cut creations to commit', async (t) => {
  t.mock.method(console, 'info', () => {});
  assert.equal(SEAL_SETTLE_MS, 30_000);
  for (const [offset, expected] of [
    [0, [30_000]],
    [5_000, [25_000]],
    [29_999, [1]],
    [30_000, []],
    [60_000, []],
  ] as const) {
    const sleeps: number[] = [];
    const { log, calls } = fakeLog();
    const res = await cronRoute(t, log, () => CUT + offset, { sleeps })();
    assert.equal(res.json().created, true, String(offset));
    assert.deepEqual(sleeps, expected, String(offset));
    assert.deepEqual(calls, [{ cut: CUT }], String(offset));
  }
});

test('a seal still running after 12:15 Berlin without a checkpoint logs a late line', async (t) => {
  t.mock.method(console, 'info', () => {});
  const errors = t.mock.method(console, 'error', () => {});
  const late = () =>
    errors.mock.calls
      .map((call) => JSON.parse(String(call.arguments[0])) as Record<string, unknown>)
      .filter((line) => line.event === 'count_log_checkpoint_late');
  // 12:15:00 Berlin exactly is not late yet.
  await cronRoute(t, fakeLog().log, () => CUT + 15 * 60_000)();
  assert.deepEqual(late(), []);
  // Before noon: skipped, never late.
  await cronRoute(t, fakeLog().log, () => CUT - 60_000)();
  assert.deepEqual(late(), []);
  // 12:20 Berlin (CEST), no checkpoint yet: one line, then the run signs it; the next firing is quiet.
  const { log } = fakeLog();
  const run = cronRoute(t, log, () => CUT + 20 * 60_000);
  assert.equal((await run()).json().created, true);
  assert.deepEqual(late(), [{ event: 'count_log_checkpoint_late', date: TODAY, minutes_late: 20 }]);
  assert.equal((await run()).json().created, false);
  assert.equal(late().length, 1);
  // Under CET (cut 11:00 UTC), 13:47 Berlin is 107 minutes late.
  await cronRoute(t, fakeLog().log, () => Date.parse('2026-12-02T12:47:30Z'))();
  assert.deepEqual(late().at(-1), {
    event: 'count_log_checkpoint_late',
    date: '2026-12-02',
    minutes_late: 107,
  });
});

test('through the cron route on a real log: nothing before noon, then the seal with the cut', async (t) => {
  t.mock.method(console, 'info', () => {});
  const db = await fixture(t);
  await yesterday(db);
  await seed(db, 1, 1_500, '2026-10-02T12:00:00Z');
  await recordAt(db, range(1, 1_500), CUT - 5 * 3_600_000);
  await seed(db, 2_001, 1, '2026-10-03T05:00:00Z', { recorded: false }); // missed, before the cut
  await seed(db, 2_101, 1, '2026-10-03T10:00:10Z', { recorded: false }); // missed, after the cut
  await seed(db, 3_001, 10, '2026-10-03T10:00:30Z');
  await recordAt(db, range(3_001, 3_010), CUT + 30_000); // after the cut: tomorrow
  let now = Date.parse('2026-10-03T09:59:00Z'); // 11:59 Berlin
  const log = createCountLog({ db, clock: () => now, budgetMs: 0, log: quiet });
  const sleeps: number[] = [];
  const run = cronRoute(t, log, () => now, { sleeps });

  assert.deepEqual((await run()).json(), { skipped: true, reason: 'not_berlin_noon_hour' });
  assert.equal(await leafCount(db), 0);
  assert.equal(await checkpointCount(db), 1);

  now = Date.parse('2026-10-03T10:00:00Z'); // 12:00 Berlin
  let res = await run();
  assert.deepEqual(sleeps, [30_000]);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.json(), {
    created: false,
    in_progress: true,
    appended: 1_000,
    remaining: 501,
    busy: false,
  });
  now = Date.parse('2026-10-03T10:05:00Z');
  res = await run();
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().created, true);
  assert.equal(res.json().date, TODAY);
  assert.equal(res.json().tree_size, 1_501);
  assert.equal((await run()).json().created, false);
  assert.deepEqual(sleeps, [30_000]);
});

test('vercel.json fires at 12:00 Berlin and keeps catching up until the evening, on both DST sides', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    crons: { path: string; schedule: string }[];
  };
  const { schedule } = config.crons.find((cron) => cron.path === '/api/cron/count-checkpoint')!;
  assert.equal(schedule, '*/5 10-21 * * *');
  const match = /^\*\/(\d+) (\d+)-(\d+) \* \* \*$/.exec(schedule);
  assert.ok(match, schedule);
  const [step, first, last] = match.slice(1).map(Number) as [number, number, number];
  for (const [date, offset] of [
    ['2026-07-15', 2],
    ['2026-12-02', 1],
    ['2026-10-25', 1],
    ['2027-03-28', 2],
  ] as const) {
    const firings: number[] = [];
    for (let hour = first; hour <= last; hour++)
      for (let minute = 0; minute < 60; minute += step)
        firings.push(Date.parse(`${date}T00:00:00Z`) + (hour * 60 + minute) * 60_000);
    const berlin = (time: number) =>
      (time - Date.parse(`${date}T00:00:00Z`)) / 60_000 + offset * 60;
    const noon = firings.find((time) => berlin(time) === 12 * 60);
    assert.equal(noon, cutInstant(date), `${date}: a firing at 12:00 Berlin`);
    assert.equal(isCheckpointDue(noon!), true);
    // The last firing is still the same Berlin day, at least 22:55, so a failed noon has hours.
    assert.equal(isCheckpointDue(firings.at(-1)!), true);
    assert.ok(berlin(firings.at(-1)!) >= 22 * 60 + 55, date);
  }
});
