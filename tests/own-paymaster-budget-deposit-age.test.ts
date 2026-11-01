import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { chainParams } from '../server/base/chain/chain-params.js';
import {
  boundWaits,
  BudgetError,
  OWN_PAYMASTER_ATTRIBUTION_SQL,
  OWN_PAYMASTER_BUDGET_CHAIN_SQL,
  OWN_PAYMASTER_BUDGET_SQL,
  OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL,
  ownPaymasterBudget,
} from '../server/base/chain/own-paymaster-budget.js';

const MILLI = 10n ** 15n;
const NOW = 1_700_000_000_000;

async function setup(t: { after: (f: () => Promise<void>) => void }) {
  const pg = new PGlite();
  await pg.exec(OWN_PAYMASTER_BUDGET_SQL);
  await pg.exec(OWN_PAYMASTER_ATTRIBUTION_SQL);
  await pg.exec(OWN_PAYMASTER_BUDGET_CHAIN_SQL);
  await pg.exec(OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL);
  t.after(() => pg.close());
  return {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  } as unknown as Database;
}

function world(db: Database, depositMaxAgeMs?: number) {
  const state = {
    wei: 10n ** 18n,
    block: 100n,
    at: NOW,
    reads: 0,
    fail: false,
    // Set: a read waits here, for a test to look at what happened meanwhile.
    hold: null as Promise<void> | null,
  };
  const budget = ownPaymasterBudget({
    db,
    now: () => state.at,
    ...(depositMaxAgeMs === undefined ? {} : { depositMaxAgeMs }),
    limits: { protectedWei: 0n },
    deposit: async () => {
      state.reads += 1;
      if (state.hold) await state.hold;
      if (state.fail) throw new Error('rpc down');
      return { wei: state.wei, block: state.block };
    },
  });
  return { state, budget };
}

let ops = 0;
const reserve = (budget: ReturnType<typeof ownPaymasterBudget>, maxCostWei = MILLI) => {
  ops += 1;
  const hash = `0x${ops.toString(16).padStart(64, '0')}`;
  return budget
    .reserve({
      userOpHash: hash,
      flow: 'registration',
      maxCostWei,
      validUntil: Math.floor(NOW / 1000) + 3600,
      sender: `0x${ops.toString(16).padStart(40, '0')}`,
      accountId: null,
    })
    .then(() => hash);
};

test('Arc allows an old reading, Base has none', () => {
  assert.equal(chainParams(5042).depositMaxAgeMs, 8_000);
  assert.equal(chainParams(5042).budgetLockTimeoutMs, 3_000);
  assert.ok(8_000 / 2 > 3_000);
  assert.equal(chainParams(8453).depositMaxAgeMs, undefined);
  assert.equal(chainParams(8453).budgetLockTimeoutMs, 5_000);
});

test('with no age set every admission reads the deposit', async (t) => {
  const { state, budget } = world(await setup(t));
  await budget.freshenDeposit();
  assert.equal(state.reads, 0);
  await reserve(budget);
  await reserve(budget);
  assert.equal(state.reads, 2);
});

test('admissions inside the age share one reading, and it is renewed after half of it', async (t) => {
  const { state, budget } = world(await setup(t), 2_000);
  await reserve(budget);
  await reserve(budget);
  await reserve(budget);
  assert.equal(state.reads, 1);
  state.at += 999;
  await reserve(budget);
  assert.equal(state.reads, 1);
  state.at += 1;
  await reserve(budget);
  assert.equal(state.reads, 2);
});

test('the deposit is read before the transaction, so the lock is never held across it', async (t) => {
  const db = await setup(t);
  const { state, budget } = world(db, 2_000);
  let release = () => {};
  state.hold = new Promise((resolve) => (release = resolve));
  let opened = false;
  const inner = db.transaction.bind(db);
  (db as { transaction: unknown }).transaction = (action: never) => {
    opened = true;
    return inner(action);
  };
  const pending = reserve(budget);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.reads, 1);
  assert.equal(opened, false, 'no transaction while the read is out');
  release();
  await pending;
  assert.equal(opened, true);
});

test('reads at the same moment share one call', async (t) => {
  const { state, budget } = world(await setup(t), 2_000);
  await Promise.all([budget.freshenDeposit(), budget.freshenDeposit(), budget.freshenDeposit()]);
  assert.equal(state.reads, 1);
});

test('an old reading still counts what was settled after its block', async (t) => {
  const { state, budget } = world(await setup(t), 2_000);
  state.wei = 5n * MILLI;
  const first = await reserve(budget, 4n * MILLI);
  // It mines in block 101; the shared reading is still block 100 and still holds that money.
  await budget.settle(first, 4n * MILLI, 101n);
  await assert.rejects(
    reserve(budget, 2n * MILLI),
    (error: unknown) => error instanceof BudgetError && error.reason === 'deposit',
  );
  assert.equal(state.reads, 1);
});

test('an old reading still counts what is open', async (t) => {
  const { state, budget } = world(await setup(t), 2_000);
  state.wei = 5n * MILLI;
  await reserve(budget, 4n * MILLI);
  await assert.rejects(
    reserve(budget, 2n * MILLI),
    (error: unknown) => error instanceof BudgetError && error.reason === 'deposit',
  );
  assert.equal(state.reads, 1);
});

test('a failed read is not kept: nothing is admitted on it, and the next read works', async (t) => {
  const { state, budget } = world(await setup(t), 2_000);
  state.fail = true;
  await assert.rejects(reserve(budget), /rpc down/);
  state.fail = false;
  await reserve(budget);
});

test('past the age a reading is never used, even when renewing it failed', async (t) => {
  const { state, budget } = world(await setup(t), 2_000);
  await reserve(budget);
  state.at += 2_000;
  state.fail = true;
  await assert.rejects(reserve(budget), /rpc down/);
});

test('a lock timeout is set once in a transaction, before the lock; none without one', async (t) => {
  const db = await setup(t);
  const seen: string[] = [];
  const inner = db.transaction.bind(db);
  (db as { transaction: unknown }).transaction = (action: (tx: never) => Promise<unknown>) =>
    inner(((tx: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) =>
      action({
        ...tx,
        query: (sql: string, params?: unknown[]) => {
          seen.push(sql);
          return tx.query(sql, params);
        },
      } as never)) as never);
  const budget = ownPaymasterBudget({
    db,
    now: () => NOW,
    lockTimeoutMs: 3_000,
    limits: { protectedWei: 0n },
    deposit: async () => ({ wei: 10n ** 18n, block: 100n }),
  });
  const hash = await reserve(budget);
  await db.transaction(async (tx) => {
    await budget.markSentIn(tx, hash);
    await budget.settleIn(tx, hash, MILLI, 101n);
  });
  const sets = seen.filter((sql) => sql.includes('set_config'));
  assert.equal(sets.length, 2);
  assert.ok(seen[0]!.includes('set_config'));
  seen.length = 0;
  await reserve(world(db).budget);
  assert.equal(seen.filter((sql) => sql.includes('set_config')).length, 0);
});

test('boundWaits holds for its transaction only', async (t) => {
  const db = await setup(t);
  const show = async (tx: { query: Database['query'] }) => {
    const lock = await tx.query<{ lock_timeout: string }>('SHOW lock_timeout');
    const idle = await tx.query<{ idle_in_transaction_session_timeout: string }>(
      'SHOW idle_in_transaction_session_timeout',
    );
    return [lock.rows[0]!.lock_timeout, idle.rows[0]!.idle_in_transaction_session_timeout];
  };
  const before = await show(db);
  await db.transaction(async (tx) => {
    await boundWaits(tx, 3_000);
    assert.deepEqual(await show(tx), ['3s', '15s']);
  });
  assert.deepEqual(await show(db), before);
});

test('both chains bound a wait for a send row', () => {
  const source = readFileSync('server/base/chain/direct-bundler.ts', 'utf8');
  assert.match(source, /if \(lock && tx && params\.budgetLockTimeoutMs\)\s+await boundWaits/);
  assert.equal(chainParams(8453).budgetLockTimeoutMs, 5_000);
});

test('maintain orders sends by the nonce column on every chain: COLUMNS gives text, 10 before 9', () => {
  const source = readFileSync('server/base/chain/direct-bundler.ts', 'utf8');
  assert.doesNotMatch(source, /ORDER BY nonce\b/);
});
