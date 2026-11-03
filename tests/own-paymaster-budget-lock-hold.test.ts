import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { chainParams } from '../server/base/chain/chain-params.js';
import {
  OWN_PAYMASTER_ATTRIBUTION_SQL,
  OWN_PAYMASTER_BUDGET_CHAIN_SQL,
  OWN_PAYMASTER_BUDGET_SQL,
  OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL,
  ownPaymasterBudget,
  ReservationGone,
  sums,
  windows,
} from '../server/base/chain/own-paymaster-budget.js';

/*
 * Arc, 2 Nov: the budget lock was held for round trips, four times per operation. Settles leave
 * the lock (settleUnlocked) and the hot paths lapse never-sent reservations once a second
 * (expireEveryMs); a reservation past validUntil + margin is still never sent. Base is unchanged.
 */

const NOW = 1_700_000_000_000;
const S = Math.floor(NOW / 1000);
const MILLI = 10n ** 15n;
let hashes = 0;
const hash = () => `0x${(++hashes).toString(16).padStart(64, '0')}`;

async function setup(t: { after: (f: () => Promise<void>) => void }) {
  const pg = new PGlite();
  for (const sql of [
    OWN_PAYMASTER_BUDGET_SQL,
    OWN_PAYMASTER_ATTRIBUTION_SQL,
    OWN_PAYMASTER_BUDGET_CHAIN_SQL,
    OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL,
  ])
    await pg.exec(sql);
  t.after(() => pg.close());
  const statements: string[] = [];
  /** Every statement a transaction runs, so a test can see which ones take the lock. */
  const watched = (tx: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => ({
    query: (sql: string, params?: unknown[]) => {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      return tx.query(sql, params);
    },
  });
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(watched(tx) as never)),
    close: () => pg.close(),
  } as unknown as Database;
  return { pg, db, statements, watched };
}

const budget = (
  db: Database,
  clock: { at: number },
  options: {
    settleUnlocked?: boolean;
    expireEveryMs?: number;
    log?: (line: string) => void;
    deposit?: bigint;
  } = {},
) => {
  const { deposit = 10n ** 21n, ...rest } = options;
  return ownPaymasterBudget({
    db,
    deposit: async () => ({ wei: deposit, block: 100n }),
    now: () => clock.at,
    submitterBound: true,
    ...rest,
  });
};

const rowOf = async (db: Database, h: string) =>
  (
    await db.query<{ status: string; actual: string | null }>(
      'SELECT status, actual_cost_wei::text AS actual FROM own_paymaster_reservations WHERE user_op_hash = $1',
      [h],
    )
  ).rows[0];

const LOCK = /FROM own_paymaster_budget WHERE chain_id = \$1 FOR UPDATE/;
const LAPSE = /SET status = 'expired', updated_at = \$1 WHERE status = 'reserved'/;
const count = (statements: string[], pattern: RegExp) =>
  statements.filter((sql) => pattern.test(sql)).length;

const reserve = (g: ReturnType<typeof budget>, h: string, validUntil = S + 300) =>
  g.reserve({
    userOpHash: h,
    flow: 'registration',
    maxCostWei: MILLI,
    validUntil,
    sender: `0x${'1'.repeat(40)}`,
    accountId: null,
  });

test('Arc settles outside the budget lock and lapses once a second; Base keeps both under it', () => {
  assert.equal(chainParams(5042).budgetSettleUnlocked, true);
  assert.equal(chainParams(5042).budgetExpireEveryMs, 1_000);
  assert.equal(chainParams(8453).budgetSettleUnlocked, undefined);
  assert.equal(chainParams(8453).budgetExpireEveryMs, undefined);
});

test('a settle takes the budget lock only when settles are not unlocked', async (t) => {
  for (const settleUnlocked of [false, true]) {
    const { db, statements } = await setup(t);
    const g = budget(db, { at: NOW }, { settleUnlocked });
    const h = hash();
    await reserve(g, h);
    await db.transaction(async (tx) => g.markSentIn(tx as never, h));
    statements.length = 0;
    await db.transaction(async (tx) => g.settleIn(tx as never, h, MILLI / 2n, 101n));
    assert.equal(count(statements, LOCK), settleUnlocked ? 0 : 1, `unlocked ${settleUnlocked}`);
    const { rows } = await db.query<{ status: string; actual: string }>(
      'SELECT status, actual_cost_wei::text AS actual FROM own_paymaster_reservations WHERE user_op_hash = $1',
      [h],
    );
    assert.deepEqual(rows, [{ status: 'settled', actual: String(MILLI / 2n) }]);
  }
});

test('settles stay locked on a budget that is not submitter-bound, whatever the option', async (t) => {
  const { db, statements } = await setup(t);
  const g = ownPaymasterBudget({
    db,
    deposit: async () => ({ wei: 10n ** 21n, block: 100n }),
    now: () => NOW,
    settleUnlocked: true,
  });
  const h = hash();
  await reserve(g, h);
  statements.length = 0;
  await db.transaction(async (tx) => g.settleIn(tx as never, h, 1n, 101n));
  assert.equal(count(statements, LOCK), 1);
});

test('the hot paths lapse at most once per interval; release still lapses every time', async (t) => {
  const { db, statements } = await setup(t);
  const clock = { at: NOW };
  const g = budget(db, clock, { expireEveryMs: 1_000 });
  await reserve(g, hash());
  await reserve(g, hash());
  await reserve(g, hash());
  assert.equal(count(statements, LAPSE), 1, 'three reserves in one instant, one lapse');
  clock.at += 1_000;
  await reserve(g, hash());
  assert.equal(count(statements, LAPSE), 2, 'the next one past the interval lapses');
  await g.release(hash());
  await g.release(hash());
  assert.equal(count(statements, LAPSE), 4, 'release lapses each time');
});

test('a reservation past validUntil + margin is never sent, though the lapse did not run', async (t) => {
  const { db } = await setup(t);
  const clock = { at: NOW };
  const g = budget(db, clock, { expireEveryMs: 60_000 });
  const late = hash();
  await reserve(g, late, S + 10);
  // A reserve just now (the lapse ran then), then past the deadline within the interval.
  clock.at = NOW + 50_000;
  await reserve(g, hash());
  clock.at = (S + 10 + 121) * 1000;
  await assert.rejects(
    db.transaction(async (tx) => g.markSentIn(tx as never, late)),
    (error: unknown) => error instanceof ReservationGone,
  );
  const { rows } = await db.query<{ status: string }>(
    'SELECT status FROM own_paymaster_reservations WHERE user_op_hash = $1',
    [late],
  );
  assert.equal(rows[0]?.status, 'reserved', 'not sent; it lapses on a later turn');
});

test('one still inside its window is sent as before', async (t) => {
  const { db } = await setup(t);
  const clock = { at: NOW };
  const g = budget(db, clock, { expireEveryMs: 1_000 });
  const h = hash();
  await reserve(g, h, S + 300);
  await db.transaction(async (tx) => g.markSentIn(tx as never, h));
  const { rows } = await db.query<{ status: string }>(
    'SELECT status FROM own_paymaster_reservations WHERE user_op_hash = $1',
    [h],
  );
  assert.equal(rows[0]?.status, 'sent');
});

test('an unlocked settle never raises a row: a cost above the worst case is held to it, with an ALERT', async (t) => {
  const { db } = await setup(t);
  const lines: string[] = [];
  const g = budget(db, { at: NOW }, { settleUnlocked: true, log: (line) => lines.push(line) });
  const h = hash();
  await reserve(g, h);
  await db.transaction(async (tx) => g.markSentIn(tx as never, h));
  await db.transaction(async (tx) => g.settleIn(tx as never, h, MILLI * 3n, 101n));
  assert.deepEqual(await rowOf(db, h), { status: 'settled', actual: String(MILLI) });
  assert.equal(lines.filter((line) => /ALERT .* settled at its admitted/.test(line)).length, 1);
});

test('a second settle of the same row changes nothing', async (t) => {
  const { db } = await setup(t);
  const g = budget(db, { at: NOW }, { settleUnlocked: true });
  const h = hash();
  await reserve(g, h);
  await db.transaction(async (tx) => g.markSentIn(tx as never, h));
  await db.transaction(async (tx) => g.settleIn(tx as never, h, MILLI / 4n, 101n));
  await db.transaction(async (tx) => g.settleIn(tx as never, h, MILLI / 2n, 102n));
  assert.deepEqual(await rowOf(db, h), { status: 'settled', actual: String(MILLI / 4n) });
});

test('lapse and settle in either order: a settle is never undone, a late receipt still counts', async (t) => {
  // Settle first: the lapse moves only 'reserved' rows, so the settled row stays settled.
  {
    const { db } = await setup(t);
    const clock = { at: NOW };
    const g = budget(db, clock, { settleUnlocked: true, expireEveryMs: 1_000 });
    const h = hash();
    await reserve(g, h, S + 10);
    await db.transaction(async (tx) => g.settleIn(tx as never, h, MILLI / 2n, 101n));
    clock.at = (S + 10 + 200) * 1000;
    await g.release(hash());
    assert.deepEqual(await rowOf(db, h), { status: 'settled', actual: String(MILLI / 2n) });
  }
  // Lapse first: a receipt that still comes settles it at its real cost (the deposit paid it).
  {
    const { db } = await setup(t);
    const clock = { at: NOW };
    const g = budget(db, clock, { settleUnlocked: true, expireEveryMs: 1_000 });
    const h = hash();
    await reserve(g, h, S + 10);
    clock.at = (S + 10 + 200) * 1000;
    await g.release(hash());
    assert.equal((await rowOf(db, h))?.status, 'expired');
    await db.transaction(async (tx) => g.settleIn(tx as never, h, MILLI / 2n, 101n));
    assert.deepEqual(await rowOf(db, h), { status: 'settled', actual: String(MILLI / 2n) });
  }
});

test('a reservation never sent and never settled is still lapsed by the next hot path past the interval', async (t) => {
  const { db } = await setup(t);
  const clock = { at: NOW };
  const g = budget(db, clock, { settleUnlocked: true, expireEveryMs: 1_000 });
  const h = hash();
  await reserve(g, h, S + 10);
  clock.at = (S + 10 + 121) * 1000;
  await reserve(g, hash());
  assert.equal((await rowOf(db, h))?.status, 'expired');
});

test('the sums an admission reads count a row at its worst case before an unlocked settle, its actual cost after', async (t) => {
  const { db } = await setup(t);
  const g = budget(db, { at: NOW }, { settleUnlocked: true });
  const h = hash();
  await reserve(g, h);
  await db.transaction(async (tx) => g.markSentIn(tx as never, h));
  const read = () =>
    db.transaction(async (tx) => sums(tx as never, windows(true), NOW, 100n, 8453));
  const before = await read();
  assert.equal(before.allOpen, MILLI);
  assert.equal(before.settledAfter, 0n);
  await db.transaction(async (tx) => g.settleIn(tx as never, h, MILLI / 10n, 101n));
  const after = await read();
  assert.equal(after.allOpen, 0n);
  // Settled after the deposit's block: counted at its actual cost, never above the worst case.
  assert.equal(after.settledAfter, MILLI / 10n);
});
