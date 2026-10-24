import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { postgresDatabase, type Database } from '../server/database.js';
import { runMigrations } from '../server/migrations.js';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { PAID_CALL_COUNT_SQL, paidCallCountMigration } from '../server/feed/pay/count-schema.js';
import { PAID_CALL_VALUE_SQL } from '../server/feed/pay/value-schema.js';

const PAID_CALLS_SCHEMA_DOC = readFileSync(
  new URL('../server/feed/pay/count-schema.ts', import.meta.url),
  'utf8',
);
import { checkPaidCalls, PAID_CALLS_CHECK_SQL } from '../server/stats/paid-calls.js';
import {
  ALL,
  base,
  call,
  counts,
  migrated,
  quiet,
  recent,
  seedWallet,
  settle,
} from './paid-calls-fixtures.js';

/*
 * Migration 125, the paid service calls count (server/feed/pay/count-schema.ts), on the full
 * schema (every registered migration, in-memory Postgres). feed_pay_calls is the money path: the
 * counter's trigger must never block, slow or fail a payment save.
 */

test('migration 125: a table, two deferred constraint triggers and no index on feed_pay_calls', async (t) => {
  const db = await migrated(t);
  assert.equal(paidCallCountMigration.version, 125);
  assert.equal(paidCallCountMigration.name, 'paid_call_count');
  const triggers = (
    await db.query<{ tgname: string; tgdeferrable: boolean; tginitdeferred: boolean }>(
      `SELECT tgname, tgdeferrable, tginitdeferred FROM pg_trigger
        WHERE tgrelid = 'feed_pay_calls'::regclass AND NOT tgisinternal ORDER BY tgname`,
    )
  ).rows;
  assert.deepEqual(triggers, [
    { tgname: 'paid_call_count_bump', tgdeferrable: true, tginitdeferred: true },
    // Migration 128's -1 for a settled payment a reorg drops.
    { tgname: 'paid_call_count_drop', tgdeferrable: true, tginitdeferred: true },
    { tgname: 'paid_call_count_insert', tgdeferrable: true, tginitdeferred: true },
  ]);
  // Its indexes are Feed pay's own (migrations 112, 114 and the passport's 120): nothing added here.
  const indexes = (
    await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'feed_pay_calls' ORDER BY 1",
    )
  ).rows.map((row) => row.indexname);
  assert.ok(
    indexes.every((name) => name === 'feed_pay_calls_paid' || !/paid|count/.test(name)),
    indexes.join(', '),
  );
  assert.deepEqual(await counts(db), {});
});

test('migration 125 holds a lock on feed_pay_calls that blocks payment saves until its batch commits', async (t) => {
  // Payment saves (RowExclusiveLock) wait while it is held, and runMigrations applies every
  // pending migration in one transaction: so 125 ships alone or last in its batch (count-schema.ts).
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  await runMigrations(
    db,
    ALL.filter((migration) => migration.version !== paidCallCountMigration.version),
    Date.now,
    true,
    quiet,
  );
  const held = await db.transaction(async (tx) => {
    await tx.exec(PAID_CALL_COUNT_SQL);
    // A later migration of the same batch would run here, with the lock still held.
    return (
      await tx.query<{ mode: string }>(
        `SELECT mode FROM pg_locks
          WHERE locktype = 'relation' AND relation = 'feed_pay_calls'::regclass AND granted
          ORDER BY mode`,
      )
    ).rows.map((row) => row.mode);
  });
  assert.ok(held.includes('ShareRowExclusiveLock'), held.join(', '));
  const after = (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'relation' AND relation = 'feed_pay_calls'::regclass`,
    )
  ).rows[0]?.n;
  assert.equal(after, 0, 'released at the commit');
  assert.match(PAID_CALLS_SCHEMA_DOC, /alone or last in its batch/);
});

test('CI runs this file against a real PostgreSQL server (the postgres-races job)', () => {
  const workflow = readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8');
  const line = workflow
    .split('\n')
    .find((item) => item.includes('pnpm test:files') && item.includes('race'));
  assert.ok(line, 'the postgres-races test line');
  assert.ok(line.includes('tests/paid-calls-count.test.ts'), line);
  const job = workflow.slice(workflow.indexOf(line));
  assert.match(job.slice(0, line.length + 200), /CITY_TEST_POSTGRES_URL:/);
});

test('the backfill equals the settled rows per chain', async (t) => {
  const db = await migrated(t, {
    before120: async (raw) => {
      for (let i = 0; i < 3; i++)
        await call(raw, { state: 'result_saved', paymentState: 'settled', settledAt: 5 });
      await call(raw, { state: 'paid_no_result', paymentState: 'settled', settledAt: 6 });
      await call(raw, { chainId: 84532, state: 'result_saved', paymentState: 'settled' });
      await call(raw, { chainId: 84532, state: 'result_saved', paymentState: 'settled' });
      await call(raw, { state: 'calling', paymentState: 'sent' });
      await call(raw, { state: 'cancelled', paymentState: 'cancelled' });
      await call(raw, { state: 'expired', paymentState: 'expired' });
      await call(raw, { state: 'refused', paymentState: null });
    },
  });
  assert.deepEqual(await counts(db), { 8453: 4, 84532: 2 });
  assert.deepEqual(await recent(db), []);
  const ledger = (
    await db.query<{ name: string }>('SELECT name FROM schema_migrations WHERE version = 125')
  ).rows;
  assert.deepEqual(ledger, [{ name: 'paid_call_count' }]);
});

test('a settle adds 1, and a call paid with no answer adds 1', async (t) => {
  const db = await migrated(t);
  const first = await call(db);
  assert.equal(await settle(db, first), true);
  assert.equal(await base(db), 1);
  const noAnswer = await call(db, { state: 'reconciling' });
  assert.equal(await settle(db, noAnswer, { noResult: true }), true);
  assert.equal(await base(db), 2);
  const row = (
    await db.query<{ state: string }>('SELECT state FROM feed_pay_calls WHERE call_id=$1', [
      noAnswer,
    ])
  ).rows[0];
  assert.equal(row?.state, 'paid_no_result');
});

test('each adds 0: settled again, a saved result with the payment still sent, cancelled, expired', async (t) => {
  const db = await migrated(t);
  const id = await call(db);
  await settle(db, id);
  assert.equal(await base(db), 1);
  // Settled is final: writing it again (or anything else on the row) adds nothing.
  await db.query(`UPDATE feed_pay_calls SET payment_state = 'settled' WHERE call_id = $1`, [id]);
  await db.query(
    `UPDATE feed_pay_calls SET fee_verified = true, payment_state = payment_state, state = 'result_saved' WHERE call_id = $1`,
    [id],
  );
  // The result is saved while Base has not confirmed the payment yet.
  const pending = await call(db);
  await db.query(
    `UPDATE feed_pay_calls SET state = 'result_saved', payment_state = 'sent' WHERE call_id = $1`,
    [pending],
  );
  await db.query(`UPDATE feed_pay_calls SET state = 'settled' WHERE call_id = $1`, [pending]);
  // Payments Base shows cancelled or expired.
  for (const end of ['cancelled', 'expired']) {
    const other = await call(db);
    await db.query(`UPDATE feed_pay_calls SET payment_state = 'cancelling' WHERE call_id = $1`, [
      other,
    ]);
    await db.query(`UPDATE feed_pay_calls SET payment_state = $2, state = $2 WHERE call_id = $1`, [
      other,
      end,
    ]);
  }
  // A call refused before anything was signed.
  const refused = await call(db, { state: 'reserved', paymentState: null });
  await db.query(`UPDATE feed_pay_calls SET state = 'refused' WHERE call_id = $1`, [refused]);
  assert.equal(await base(db), 1);
  // The saved result's payment settles later: now it counts, once.
  await settle(db, pending);
  await settle(db, pending);
  assert.equal(await base(db), 2);
});

test('a Sepolia row lands in its own row; Base mainnet is unchanged', async (t) => {
  const db = await migrated(t);
  await settle(db, await call(db));
  await settle(db, await call(db, { chainId: 84532 }));
  await settle(db, await call(db, { chainId: 84532 }));
  assert.deepEqual(await counts(db), { 8453: 1, 84532: 2 });
});

test('a call stored already settled counts once', async (t) => {
  const db = await migrated(t);
  const id = await call(db, { state: 'result_saved', paymentState: 'settled', settledAt: 77 });
  assert.equal(await base(db), 1);
  assert.deepEqual(await recent(db), [77]);
  await settle(db, id);
  assert.equal(await base(db), 1);
});

test('the +1 runs at commit, and a rollback adds nothing', async (t) => {
  const db = await migrated(t);
  const id = await call(db);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query(
        `UPDATE feed_pay_calls SET payment_state = 'settled', settled_at = 5 WHERE call_id = $1`,
        [id],
      );
      // Deferred: nothing is counted before the commit.
      const inside = (await tx.query('SELECT count(*)::int AS n FROM paid_call_count')).rows[0];
      assert.deepEqual(inside, { n: 0 });
      throw new Error('roll back');
    }),
    /roll back/,
  );
  assert.deepEqual(await counts(db), {});
  const after = (
    await db.query<{ payment_state: string }>(
      'SELECT payment_state FROM feed_pay_calls WHERE call_id = $1',
      [id],
    )
  ).rows[0];
  assert.equal(after?.payment_state, 'sent');
  // The same settle, committed, counts.
  await settle(db, id);
  assert.equal(await base(db), 1);
});

test('a broken counter (table renamed) does not block the settle; the daily check adds it back', async (t) => {
  const db = await migrated(t);
  await settle(db, await call(db));
  await db.exec('ALTER TABLE paid_call_count RENAME TO paid_call_count_moved');
  const id = await call(db);
  assert.equal(await settle(db, id), true);
  const saved = (
    await db.query<{ payment_state: string }>(
      'SELECT payment_state FROM feed_pay_calls WHERE call_id = $1',
      [id],
    )
  ).rows[0];
  assert.equal(saved?.payment_state, 'settled');
  await db.exec('ALTER TABLE paid_call_count_moved RENAME TO paid_call_count');
  // The +1 was skipped, never added twice.
  assert.equal(await base(db), 1);
  const result = await checkPaidCalls(db, { log: quiet });
  assert.deepEqual(result, { counter: 1, scan: 2, drift: -1, repaired: true });
  assert.equal(await base(db), 2);
});

test('the lock limit: 250 ms inside the trigger, restored after it; a lock wait that ends skips the +1, never the payment', async (t) => {
  const db = await migrated(t);
  // What the counter's own statements see: the lock limit while the trigger writes the row.
  await db.exec(`
    CREATE TABLE lock_seen (lock_timeout text);
    CREATE FUNCTION record_lock() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO lock_seen VALUES (current_setting('lock_timeout'));
      RETURN NEW;
    END $$;
    CREATE TRIGGER record_lock BEFORE INSERT OR UPDATE ON paid_call_count
      FOR EACH ROW EXECUTE FUNCTION record_lock();`);
  const first = await call(db);
  const limits = await db.transaction(async (tx) => {
    await tx.query("SET LOCAL lock_timeout = '8s'");
    await tx.query(
      `UPDATE feed_pay_calls SET payment_state = 'settled', settled_at = 9 WHERE call_id = $1`,
      [first],
    );
    // Fire the deferred trigger now, to read the transaction's own limit after it.
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    return (await tx.query<{ l: string }>("SELECT current_setting('lock_timeout') AS l")).rows[0]!
      .l;
  });
  assert.equal(limits, '8s', 'the transaction keeps its own lock limit after the trigger');
  const seen = (await db.query<{ lock_timeout: string }>('SELECT * FROM lock_seen')).rows;
  assert.deepEqual(seen, [{ lock_timeout: '250ms' }]);
  assert.equal(await base(db), 1);

  // A wait for the counter row that runs out ends as lock_not_available (55P03): the payment
  // commits, the +1 is skipped.
  await db.exec(`
    CREATE OR REPLACE FUNCTION record_lock() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'canceling statement due to lock timeout' USING ERRCODE = 'lock_not_available';
    END $$;`);
  const second = await call(db);
  const started = Date.now();
  assert.equal(await settle(db, second), true);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(await base(db), 1);
  const saved = (
    await db.query<{ payment_state: string }>(
      'SELECT payment_state FROM feed_pay_calls WHERE call_id = $1',
      [second],
    )
  ).rows[0];
  assert.equal(saved?.payment_state, 'settled');
  // After a skipped +1 the transaction's limit is the one it had (the block rolled back).
  const third = await call(db);
  const after = await db.transaction(async (tx) => {
    await tx.query("SET LOCAL lock_timeout = '8s'");
    await tx.query(`UPDATE feed_pay_calls SET payment_state = 'settled' WHERE call_id = $1`, [
      third,
    ]);
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    return (await tx.query<{ l: string }>("SELECT current_setting('lock_timeout') AS l")).rows[0]!
      .l;
  });
  assert.equal(after, '8s');
  await db.exec('DROP TRIGGER record_lock ON paid_call_count');
  assert.deepEqual(await checkPaidCalls(db, { log: quiet }), {
    counter: 1,
    scan: 3,
    drift: -2,
    repaired: true,
  });
});

test('recent holds Base block times, newest first, at most 64', async (t) => {
  const db = await migrated(t);
  const start = Date.now() - 86_400_000;
  const times = Array.from({ length: 70 }, (_, i) => start + i * 1_000);
  // Found in no particular order (a late payment keeps its own block time).
  const shuffled = times.map((_, i) => times[(i * 37) % times.length]!);
  for (const at of shuffled) await settle(db, await call(db), { at });
  assert.equal(await base(db), 70);
  const kept = await recent(db);
  assert.equal(kept.length, 64);
  assert.deepEqual(kept, [...times].sort((a, b) => b - a).slice(0, 64));
  // A payment without a block time is stamped with the database clock.
  const before = Date.now();
  await settle(db, await call(db), { at: null });
  const stamped = (await recent(db))[0]!;
  assert.ok(stamped >= before - 5_000 && stamped <= Date.now() + 5_000, String(stamped));
  const check = await db.query<{ ok: boolean }>(
    'SELECT cardinality(recent) <= 64 AS ok FROM paid_call_count',
  );
  assert.ok(check.rows.every((row) => row.ok));
});

/*
 * Against a real PostgreSQL server, with several connections: the lock limit inside the trigger,
 * concurrent settles, a racing first insert and overlapping daily checks. Run with
 * CITY_TEST_POSTGRES_URL (a role that may create databases, as the other race suites; CI's
 * postgres-races job runs this file); skipped without it.
 */
/** The settled value of a chain's row (migration 243), in USDC base units. */
async function value(db: Pick<Database, 'query'>, chainId = 8453): Promise<bigint> {
  const row = (
    await db.query<{ v: string }>(
      'SELECT value_raw::text AS v FROM paid_call_count WHERE chain_id = $1',
      [chainId],
    )
  ).rows[0];
  return BigInt(row?.v ?? '0');
}

const REAL_PG = { skip: !process.env.CITY_TEST_POSTGRES_URL, timeout: 60_000 };

/** A fresh database with every migration and `connections` single-connection pools. */
async function realPg(
  t: { after: (fn: () => Promise<unknown>) => void },
  connections: number,
): Promise<Database[]> {
  const url = process.env.CITY_TEST_POSTGRES_URL!;
  const name = `city_paid_calls_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  const pools: pg.Pool[] = [];
  let created = false;
  t.after(async () => {
    try {
      await Promise.all(pools.map((pool) => pool.end()));
      if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE DATABASE ${name}`);
  created = true;
  const isolated = new URL(url);
  isolated.pathname = `/${name}`;
  for (let i = 0; i < connections; i++)
    pools.push(
      new pg.Pool({
        connectionString: isolated.toString(),
        max: 1,
        connectionTimeoutMillis: 5000,
        // As in production: a statement limit the guard could not catch, and a long lock limit.
        statement_timeout: 8000,
        lock_timeout: 8000,
      }),
    );
  const dbs = pools.map(postgresDatabase);
  await runMigrations(dbs[0]!, ALL, Date.now, true, quiet);
  await seedWallet(dbs[0]!);
  return dbs;
}

async function paymentStates(db: Pick<Database, 'query'>, ids: string[]) {
  return (
    await db.query<{ payment_state: string }>(
      'SELECT payment_state FROM feed_pay_calls WHERE call_id = ANY($1::text[]) ORDER BY call_id',
      [ids],
    )
  ).rows.map((row) => row.payment_state);
}

/** Holds the Base mainnet counter row in another transaction until `release` is called. */
async function holdCounterRow(holder: Database, sql: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const holding = holder.transaction(async (tx) => {
    await tx.query(sql);
    locked();
    await released;
  });
  await isLocked;
  return {
    release: async () => {
      release();
      await holding;
    },
  };
}

test(
  'real PG: a counter row locked by another transaction does not block the settle',
  REAL_PG,
  async (t) => {
    const [holder, payer] = (await realPg(t, 2)) as [Database, Database];
    await settle(payer, await call(payer));
    assert.equal(await base(holder), 1);

    const id = await call(payer);
    const hold = await holdCounterRow(
      holder,
      'SELECT total FROM paid_call_count WHERE chain_id = 8453 FOR UPDATE',
    );
    const started = Date.now();
    assert.equal(await settle(payer, id), true);
    const took = Date.now() - started;
    await hold.release();
    // The payment committed after about the 250 ms lock limit, far inside the 8 s limits.
    assert.ok(took < 3_000, `the settle took ${took} ms`);
    assert.deepEqual(await paymentStates(payer, [id]), ['settled']);
    // Skipped, never doubled; the daily check adds it.
    assert.equal(await base(holder), 1);
    assert.deepEqual(await checkPaidCalls(holder, { log: quiet }), {
      counter: 1,
      scan: 2,
      drift: -1,
      repaired: true,
    });
    assert.equal(await base(holder), 2);
  },
);

test(
  "real PG: a first insert racing another transaction's first insert does not block the settle",
  REAL_PG,
  async (t) => {
    const [holder, payer] = (await realPg(t, 2)) as [Database, Database];
    // No counter row yet: another transaction inserts it and has not committed.
    const hold = await holdCounterRow(
      holder,
      "INSERT INTO paid_call_count (chain_id, total, recent, updated_at) VALUES (8453, 1, '{}', 0)",
    );
    const id = await call(payer);
    const started = Date.now();
    assert.equal(await settle(payer, id), true);
    const took = Date.now() - started;
    assert.ok(took < 3_000, `the settle took ${took} ms`);
    assert.ok(took >= 200, `the settle waited for the lock limit (${took} ms)`);
    await hold.release();
    assert.deepEqual(await paymentStates(payer, [id]), ['settled']);
    // The racing insert counted 1 of its own with no value (migration 243), this +1 was skipped:
    // the count is right by chance, the value is not, and the check puts the value right.
    assert.deepEqual(await checkPaidCalls(holder, { log: quiet }), {
      counter: 1,
      scan: 1,
      drift: 0,
      repaired: true,
    });
    assert.equal(await value(holder), 20_000n);
  },
);

test(
  'real PG: 20 concurrent settles all commit quickly; the count is never too high',
  REAL_PG,
  async (t) => {
    const dbs = await realPg(t, 20);
    await settle(dbs[0]!, await call(dbs[0]!));
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await call(dbs[0]!));
    const took = await Promise.all(
      ids.map(async (id, i) => {
        const started = Date.now();
        assert.equal(await settle(dbs[i]!, id), true);
        return Date.now() - started;
      }),
    );
    assert.deepEqual(await paymentStates(dbs[0]!, ids), Array(20).fill('settled'));
    // Each commit waits at most for the others' short commits, or the 250 ms limit.
    assert.ok(Math.max(...took) < 1_500, `settles took ${took.join(', ')} ms`);
    const counted = await base(dbs[0]!);
    assert.ok(counted <= 21 && counted >= 1, String(counted));
    await checkPaidCalls(dbs[0]!, { log: quiet });
    assert.equal(await base(dbs[0]!), 21);
  },
);

test(
  'real PG: overlapping daily checks add the difference once; a settle meanwhile counts once',
  REAL_PG,
  async (t) => {
    const [a, b, payer] = (await realPg(t, 3)) as [Database, Database, Database];
    for (let i = 0; i < 3; i++) await settle(payer, await call(payer));
    await payer.query('UPDATE paid_call_count SET total = 1 WHERE chain_id = 8453');
    const late = await call(payer);
    // Run A pauses after its read; meanwhile run B starts and a payment settles and commits.
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    let read!: () => void;
    const hasRead = new Promise<void>((resolve) => (read = resolve));
    const pausing: Pick<Database, 'transaction'> = {
      transaction: (action) =>
        a.transaction((tx) =>
          action({
            ...tx,
            query: async (sql: string, params?: unknown[]) => {
              const result = await tx.query(sql, params);
              if (sql === PAID_CALLS_CHECK_SQL) {
                read();
                await paused;
              }
              return result;
            },
          } as never),
        ),
    };
    const first = checkPaidCalls(pausing, { log: quiet, timeoutMs: 20_000 });
    await hasRead;
    assert.equal(await settle(payer, late), true);
    // B finds the check's lock taken and does nothing.
    assert.equal(await checkPaidCalls(b, { log: quiet }), null);
    resume();
    assert.deepEqual(await first, { counter: 1, scan: 3, drift: -2, repaired: true });
    assert.equal(await base(payer), 4);
    assert.equal((await checkPaidCalls(b, { log: quiet }))?.drift, 0);
  },
);

/** The engine's payDropped: a settled payment a reorg dropped, in its own transaction. */
async function drop(db: Pick<Database, 'transaction'>, id: string) {
  await db.transaction((tx) =>
    tx.query(
      `UPDATE feed_pay_calls SET payment_state = 'cancelled', state = 'cancelled',
         updated_at = updated_at + 1 WHERE call_id = $1 AND payment_state = 'settled'`,
      [id],
    ),
  );
}

test('migration 128: a settled payment a reorg drops takes its 1 (and its recent entry) back at commit', async (t) => {
  const db = await migrated(t);
  const kept = await call(db);
  const dropped = await call(db);
  await settle(db, kept, { at: 10 });
  await settle(db, dropped, { at: 20 });
  assert.equal(await base(db), 2);
  assert.deepEqual(await recent(db), [20, 10]);
  // Deferred like the +1: inside the transaction nothing has changed yet; a rollback takes nothing.
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query(`UPDATE feed_pay_calls SET payment_state = 'cancelled' WHERE call_id = $1`, [
        dropped,
      ]);
      const inside = (await tx.query<{ total: string }>('SELECT total FROM paid_call_count'))
        .rows[0];
      assert.equal(Number(inside?.total), 2);
      throw new Error('roll back');
    }),
    /roll back/,
  );
  assert.equal(await base(db), 2);
  await drop(db, dropped);
  assert.equal(await base(db), 1);
  assert.deepEqual(await recent(db), [10]);
  // The daily check agrees: nothing to repair.
  assert.deepEqual(await checkPaidCalls(db, { log: quiet }), {
    counter: 1,
    scan: 1,
    drift: 0,
    repaired: false,
  });
  // A call that settles again counts once again.
  await settle(db, dropped, { at: 30 });
  assert.equal(await base(db), 2);
  // Other changes of a settled row take nothing.
  await db.query(`UPDATE feed_pay_calls SET payment_state = 'settled' WHERE call_id = $1`, [kept]);
  assert.equal(await base(db), 2);
});

test('migration 128: never below zero, and a broken counter does not block the drop', async (t) => {
  const db = await migrated(t);
  const id = await call(db);
  await settle(db, id);
  await db.query('UPDATE paid_call_count SET total = 0');
  await drop(db, id);
  assert.equal(await base(db), 0);
  const other = await call(db);
  await settle(db, other);
  await db.exec('ALTER TABLE paid_call_count RENAME TO paid_call_count_moved');
  await drop(db, other);
  const saved = (
    await db.query<{ payment_state: string }>(
      'SELECT payment_state FROM feed_pay_calls WHERE call_id = $1',
      [other],
    )
  ).rows[0];
  assert.equal(saved?.payment_state, 'cancelled', 'the payment save commits');
  await db.exec('ALTER TABLE paid_call_count_moved RENAME TO paid_call_count');
});

test('migration 243: the settled value moves exactly with the count (+ on settle, - on drop, never below 0)', async (t) => {
  const db = await migrated(t);
  const a = await call(db);
  const b = await call(db);
  assert.equal(await value(db), 0n);
  await settle(db, a, { at: 10 });
  assert.equal(await value(db), 20_000n);
  await settle(db, b, { at: 20, noResult: true });
  assert.equal(await base(db), 2);
  assert.equal(await value(db), 40_000n);
  // A rollback takes nothing, like the +1.
  const c = await call(db);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query(
        `UPDATE feed_pay_calls SET payment_state = 'settled', settled_at = 30 WHERE call_id = $1`,
        [c],
      );
      throw new Error('roll back');
    }),
    /roll back/,
  );
  assert.equal(await value(db), 40_000n);
  // A reorg drop takes its value back; settled again, it counts once again.
  await drop(db, b);
  assert.equal(await base(db), 1);
  assert.equal(await value(db), 20_000n);
  await settle(db, b, { at: 40 });
  assert.equal(await value(db), 40_000n);
  // Never below zero.
  await db.query('UPDATE paid_call_count SET value_raw = 5 WHERE chain_id = 8453');
  await drop(db, a);
  assert.equal(await value(db), 0n);
});

test('migration 243: the daily check repairs the value, even when the count is right', async (t) => {
  const db = await migrated(t);
  const a = await call(db);
  const b = await call(db);
  await settle(db, a);
  await settle(db, b);
  await db.query('UPDATE paid_call_count SET value_raw = 7 WHERE chain_id = 8453');
  const result = await checkPaidCalls(db, { log: quiet });
  assert.equal(result?.repaired, true);
  assert.equal(result?.drift, 0);
  assert.equal(await base(db), 2);
  assert.equal(await value(db), 40_000n);
  // In step afterwards: nothing more to repair.
  assert.equal((await checkPaidCalls(db, { log: quiet }))?.repaired, false);
});

test('migration 243: the backfill sums the settled calls per chain; it takes no lock on feed_pay_calls', async (t) => {
  const db = await migrated(t, {
    before120: async (raw) => {
      for (let i = 0; i < 3; i++)
        await call(raw, { state: 'result_saved', paymentState: 'settled', settledAt: 5 });
      await call(raw, { chainId: 84532, state: 'result_saved', paymentState: 'settled' });
      await call(raw, { state: 'calling', paymentState: 'sent' });
    },
  });
  assert.equal(await value(db), 60_000n);
  assert.equal(await value(db, 84532), 20_000n);
  assert.doesNotMatch(PAID_CALL_VALUE_SQL, /CREATE\s+(CONSTRAINT\s+)?TRIGGER/i);
});

for (const kind of ['settle', 'drop'] as const)
  test(
    `real PG: migration 243 holding paid_call_count (ACCESS EXCLUSIVE) does not fail a ${kind}; the check repairs it`,
    REAL_PG,
    async (t) => {
      const [holder, payer] = (await realPg(t, 2)) as [Database, Database];
      const kept = await call(payer);
      const other = await call(payer);
      await settle(payer, kept);
      if (kind === 'drop') await settle(payer, other);
      const before = { count: await base(holder), value: await value(holder) };
      // What 243's ALTER TABLE takes until its migration batch commits.
      const hold = await holdCounterRow(
        holder,
        'LOCK TABLE paid_call_count IN ACCESS EXCLUSIVE MODE',
      );
      const started = Date.now();
      if (kind === 'settle') assert.equal(await settle(payer, other), true);
      else await drop(payer, other);
      const took = Date.now() - started;
      assert.ok(took < 3_000, `the ${kind} took ${took} ms`);
      await hold.release();
      // The save committed; its counter update was skipped (bounded wait, then lock_not_available).
      assert.deepEqual(await paymentStates(payer, [other]), [
        kind === 'settle' ? 'settled' : 'cancelled',
      ]);
      assert.deepEqual({ count: await base(holder), value: await value(holder) }, before);
      // The daily check puts count and value right.
      const result = await checkPaidCalls(holder, { log: quiet });
      assert.equal(result?.repaired, true);
      const expected = kind === 'settle' ? 2 : 1;
      assert.equal(await base(holder), expected);
      assert.equal(await value(holder), BigInt(expected * 20_000));
    },
  );
