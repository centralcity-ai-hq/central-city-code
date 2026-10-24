import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { runMigrations } from '../server/migrations.js';
import {
  PAID_CALL_COUNT_SPONSORED_SQL,
  paidCallCountSponsoredMigration,
} from '../server/feed/pay/sponsored-count-schema.js';
import { checkPaidCalls, createPaidCallsReader } from '../server/stats/paid-calls.js';
import {
  ALL,
  base,
  call,
  migrated,
  quiet,
  recent,
  seedWallet,
  settle,
} from './paid-calls-fixtures.js';

/*
 * Migration 252 (server/feed/pay/sponsored-count-schema.ts): sponsored first purchases
 * (feed_pay_sponsored_calls) count in paid_call_count, once each, with their value (gross_raw, fee
 * included), and the daily check recounts both tables. The counter must never block or fail a
 * sponsored save. Synthetic values only.
 */

type Db = Pick<Database, 'query' | 'transaction'>;

let seq = 0;
/** A sponsored call stored as sponsored.ts stores it ('reserved' unless told otherwise). */
async function sponsored(
  db: Pick<Database, 'query'>,
  options: { state?: string; tx?: string | null; gross?: number; at?: number } = {},
): Promise<string> {
  seq += 1;
  const id = `sp_${seq.toString().padStart(20, '0')}`;
  const at = options.at ?? 1_000 + seq;
  await db.query(
    `INSERT INTO feed_pay_sponsored_calls (call_id, owner_account_id, idempotency_key,
       request_hash, operator_id, agent_id, service_id, offer_id, offer_kind, offer_version,
       pay_to, gross_raw, fee_raw, input, state, op_key, tx_hash, created_at, updated_at)
     VALUES ($1, 'acct-1', $2, 'h', 'op-1', 'agent-1', 'svc-1', 'offer-1', 'kind', 1, $3, $4, $5,
       '{}', $6, $7, $8, $9, $9)`,
    [
      id,
      `idem-${seq}`,
      `0x${'4'.repeat(40)}`,
      options.gross ?? 10_000,
      Math.floor((options.gross ?? 10_000) / 10),
      options.state ?? 'reserved',
      `sfp:${id}`,
      options.tx === undefined ? null : options.tx,
      at,
    ],
  );
  return id;
}

/** sponsored.ts's move(): one compare-and-set UPDATE, in its own transaction. */
async function move(db: Db, id: string, set: Record<string, unknown>): Promise<boolean> {
  const keys = Object.keys(set);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE feed_pay_sponsored_calls SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')},
         updated_at = updated_at + 1
       WHERE call_id = $1 RETURNING call_id`,
      [id, ...Object.values(set)],
    );
    return rows.length === 1;
  });
}
const txHash = () => `0x${randomBytes(32).toString('hex')}`;
/** The path to paid: sent, then paid with its transaction (as follow() does). */
async function pay(db: Db, id: string) {
  assert.equal(await move(db, id, { state: 'sent', valid_before: 9 }), true);
  assert.equal(await move(db, id, { state: 'paid', tx_hash: txHash(), block_number: 7 }), true);
}

async function value(db: Pick<Database, 'query'>, chainId = 8453) {
  const row = (
    await db.query<{ v: string }>(
      'SELECT value_raw::text AS v FROM paid_call_count WHERE chain_id = $1',
      [chainId],
    )
  ).rows[0];
  return BigInt(row?.v ?? '0');
}

test('migration 252: two deferred constraint triggers on the sponsored calls, nothing new on feed_pay_calls', async (t) => {
  const db = await migrated(t);
  assert.equal(paidCallCountSponsoredMigration.version, 252);
  assert.equal(paidCallCountSponsoredMigration.name, 'paid_call_count_sponsored');
  const triggers = async (table: string) =>
    (
      await db.query<{ tgname: string; tgdeferrable: boolean; tginitdeferred: boolean }>(
        `SELECT tgname, tgdeferrable, tginitdeferred FROM pg_trigger
          WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY tgname`,
        [table],
      )
    ).rows;
  assert.deepEqual(await triggers('feed_pay_sponsored_calls'), [
    { tgname: 'paid_call_count_sponsored_bump', tgdeferrable: true, tginitdeferred: true },
    { tgname: 'paid_call_count_sponsored_insert', tgdeferrable: true, tginitdeferred: true },
  ]);
  assert.deepEqual(
    (await triggers('feed_pay_calls')).map((row) => row.tgname),
    ['paid_call_count_bump', 'paid_call_count_drop', 'paid_call_count_insert'],
  );
  assert.doesNotMatch(PAID_CALL_COUNT_SPONSORED_SQL, /CREATE\s+(UNIQUE\s+)?INDEX/i);
  assert.doesNotMatch(PAID_CALL_COUNT_SPONSORED_SQL, /ON feed_pay_calls\b/);
});

test('a sponsored call turning paid adds 1, its gross value and its time to recent, once', async (t) => {
  const db = await migrated(t);
  await settle(db, await call(db), { at: 500 });
  assert.equal(await base(db), 1);
  assert.equal(await value(db), 20_000n);
  const id = await sponsored(db, { gross: 12_345, at: 9_000 });
  // reserved and sent: not counted.
  assert.equal(await move(db, id, { state: 'sent', valid_before: 9 }), true);
  assert.equal(await base(db), 1);
  assert.equal(await move(db, id, { state: 'paid', tx_hash: txHash(), block_number: 7 }), true);
  assert.equal(await base(db), 2);
  assert.equal(await value(db), 20_000n + 12_345n);
  assert.deepEqual(await recent(db), [9_002, 500]);
  // Delivered (or paid with no answer) afterwards, a lease or a repeated paid update: still once.
  assert.equal(await move(db, id, { lease_until: 99 }), true);
  assert.equal(await move(db, id, { state: 'paid', tx_hash: txHash() }), true);
  assert.equal(await move(db, id, { state: 'delivered', result_text: 'ok' }), true);
  assert.equal(await base(db), 2);
  assert.equal(await value(db), 20_000n + 12_345n);
  const other = await sponsored(db);
  await pay(db, other);
  assert.equal(await move(db, other, { state: 'paid_no_result', failure_code: 'x' }), true);
  assert.equal(await base(db), 3);
  assert.equal(await value(db), 20_000n + 12_345n + 10_000n);
  // A failed call, or one with no transaction, never counts.
  const failed = await sponsored(db);
  await move(db, failed, { state: 'sent' });
  await move(db, failed, { state: 'failed', failure_code: 'not_paid', tx_hash: txHash() });
  const noTx = await sponsored(db);
  await move(db, noTx, { state: 'delivered' });
  assert.equal(await base(db), 3);
  // Stored already paid (no path does this today): once.
  await sponsored(db, { state: 'delivered', tx: txHash() });
  assert.equal(await base(db), 4);
  // The public reader (homepage stats) sees them; the daily check finds nothing to repair.
  const read = await createPaidCallsReader({ db, clock: Date.now }).read();
  assert.equal(read?.total, 4);
  assert.equal(read?.valueRaw, String(20_000 + 12_345 + 10_000 + 10_000));
  assert.deepEqual(await checkPaidCalls(db, { log: quiet }), {
    counter: 4,
    scan: 4,
    drift: 0,
    repaired: false,
  });
});

test('a rollback of the paid save adds nothing', async (t) => {
  const db = await migrated(t);
  const id = await sponsored(db, { state: 'sent' });
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query(
        `UPDATE feed_pay_sponsored_calls SET state = 'paid', tx_hash = $2 WHERE call_id = $1`,
        [id, txHash()],
      );
      throw new Error('rolled back');
    }),
  );
  assert.equal(await base(db), 0);
});

test('the backfill counts the paid sponsored calls already stored once, with their value', async (t) => {
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  await runMigrations(
    db,
    ALL.filter((migration) => migration.version !== paidCallCountSponsoredMigration.version),
    Date.now,
    true,
    quiet,
  );
  await seedWallet(db);
  await settle(db, await call(db), { at: 500 });
  await sponsored(db, { state: 'paid', tx: txHash(), gross: 10_000 });
  await sponsored(db, { state: 'delivered', tx: txHash(), gross: 20_000 });
  await sponsored(db, { state: 'paid_no_result', tx: txHash(), gross: 30_000 });
  // Never counted: open, failed, or without a transaction.
  await sponsored(db, { state: 'reserved' });
  await sponsored(db, { state: 'sent', tx: txHash() });
  await sponsored(db, { state: 'failed', tx: txHash() });
  await sponsored(db, { state: 'delivered', tx: null });
  assert.equal(await base(db), 1);
  await runMigrations(db, ALL, Date.now, true, quiet);
  assert.equal(await base(db), 4);
  assert.equal(await value(db), 20_000n + 60_000n);
  assert.deepEqual(await recent(db), [500]);
  // Exactly: the daily check agrees.
  assert.equal((await checkPaidCalls(db, { log: quiet }))?.repaired, false);
  // A fresh database with only sponsored calls gets its row from the backfill as well.
  const fresh = await PGlite.create('memory://');
  t.after(() => fresh.close());
  await runMigrations(
    fresh,
    ALL.filter((migration) => migration.version !== paidCallCountSponsoredMigration.version),
    Date.now,
    true,
    quiet,
  );
  await sponsored(fresh, { state: 'delivered', tx: txHash(), gross: 7_000 });
  await runMigrations(fresh, ALL, Date.now, true, quiet);
  assert.equal(await base(fresh), 1);
  assert.equal(await value(fresh), 7_000n);
});

test('migration 252 locks the sponsored calls only (ShareRowExclusive), never feed_pay_calls', async (t) => {
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  await runMigrations(
    db,
    ALL.filter((migration) => migration.version !== paidCallCountSponsoredMigration.version),
    Date.now,
    true,
    quiet,
  );
  const held = await db.transaction(async (tx) => {
    await tx.exec(PAID_CALL_COUNT_SPONSORED_SQL);
    return (
      await tx.query<{ relation: string; mode: string }>(
        `SELECT c.relname AS relation, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
          WHERE l.pid = pg_backend_pid() AND c.relname IN ('feed_pay_sponsored_calls', 'feed_pay_calls')
          ORDER BY 1, 2`,
      )
    ).rows;
  });
  assert.ok(
    held.some(
      (row) => row.relation === 'feed_pay_sponsored_calls' && row.mode === 'ShareRowExclusiveLock',
    ),
    JSON.stringify(held),
  );
  assert.ok(!held.some((row) => row.relation === 'feed_pay_calls'), JSON.stringify(held));
});

test('the daily check recounts feed calls plus paid sponsored calls (total and value)', async (t) => {
  const db = await migrated(t);
  await settle(db, await call(db));
  await pay(db, await sponsored(db, { gross: 15_000 }));
  await pay(db, await sponsored(db, { gross: 5_000 }));
  assert.equal(await base(db), 3);
  await db.query('UPDATE paid_call_count SET total = 1, value_raw = 20000 WHERE chain_id = 8453');
  assert.deepEqual(await checkPaidCalls(db, { log: quiet }), {
    counter: 1,
    scan: 3,
    drift: -2,
    repaired: true,
  });
  assert.equal(await base(db), 3);
  assert.equal(await value(db), 40_000n);
  assert.equal((await checkPaidCalls(db, { log: quiet }))?.repaired, false);
  // Another chain's row never takes the sponsored calls.
  await settle(db, await call(db, { chainId: 84532 }));
  assert.deepEqual(await checkPaidCalls(db, { log: quiet, chainId: 84532 }), {
    counter: 1,
    scan: 1,
    drift: 0,
    repaired: false,
    chain_id: 84532,
  });
});

test('a broken or busy counter never fails a sponsored save; the daily check adds it back', async (t) => {
  const db = await migrated(t);
  // Broken: the table is gone.
  await db.exec('ALTER TABLE paid_call_count RENAME TO paid_call_count_moved');
  const first = await sponsored(db);
  await pay(db, first);
  await db.exec('ALTER TABLE paid_call_count_moved RENAME TO paid_call_count');
  // Busy: a lock wait that ends (lock_not_available).
  await db.exec(`
    CREATE FUNCTION busy_lock() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'canceling statement due to lock timeout' USING ERRCODE = 'lock_not_available';
    END $$;
    CREATE TRIGGER busy_lock BEFORE INSERT OR UPDATE ON paid_call_count
      FOR EACH ROW EXECUTE FUNCTION busy_lock();`);
  const second = await sponsored(db);
  const started = Date.now();
  await pay(db, second);
  assert.ok(Date.now() - started < 2_000);
  // The transaction keeps its own lock limit after the skipped +1.
  const third = await sponsored(db, { state: 'sent' });
  const limit = await db.transaction(async (tx) => {
    await tx.query("SET LOCAL lock_timeout = '8s'");
    await tx.query(
      `UPDATE feed_pay_sponsored_calls SET state = 'paid', tx_hash = $2 WHERE call_id = $1`,
      [third, txHash()],
    );
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    return (await tx.query<{ l: string }>("SELECT current_setting('lock_timeout') AS l")).rows[0]!
      .l;
  });
  assert.equal(limit, '8s');
  await db.exec('DROP TRIGGER busy_lock ON paid_call_count');
  const states = (
    await db.query<{ state: string }>(
      'SELECT state FROM feed_pay_sponsored_calls WHERE call_id = ANY($1) ORDER BY call_id',
      [[first, second, third]],
    )
  ).rows.map((row) => row.state);
  assert.deepEqual(states, ['paid', 'paid', 'paid']);
  // The +1s were skipped, never added twice; the check adds them.
  assert.equal(await base(db), 0);
  const result = await checkPaidCalls(db, { log: quiet });
  assert.deepEqual(result, { counter: null, scan: 3, drift: -3, repaired: true });
  assert.equal(await base(db), 3);
  assert.equal(await value(db), 30_000n);
});
