import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { chainParams } from '../server/base/chain/chain-params.js';
import {
  historySums,
  OWN_PAYMASTER_ATTRIBUTION_SQL,
  OWN_PAYMASTER_BUDGET_CHAIN_SQL,
  OWN_PAYMASTER_BUDGET_SQL,
  OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL,
  ownPaymasterBudget,
  recentSums,
  sums,
  windows,
} from '../server/base/chain/own-paymaster-budget.js';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const CHAIN = 8453;

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
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  } as unknown as Database;
  return { pg, db };
}

test('Arc allows old history sums, Base has none', () => {
  assert.equal(chainParams(5042).budgetHistoryMaxAgeMs, 120_000);
  assert.equal(chainParams(8453).budgetHistoryMaxAgeMs, undefined);
});

test('the split sums equal the whole query, on every kind of row', async (t) => {
  const { pg, db } = await setup(t);
  let id = 0;
  const flows = ['registration', 'withdrawal', 'selfPaid'];
  const add = async (row: {
    flow: string;
    protectedFlow: boolean;
    status: string;
    createdAt: number;
    exposure: boolean;
    chain?: number;
  }) => {
    id += 1;
    const settled = row.status === 'settled';
    await pg.query(
      `INSERT INTO own_paymaster_reservations
         (user_op_hash, flow, protected, max_cost_wei, actual_cost_wei, status, settled_block,
          valid_until, created_at, updated_at, sender, account_id, chain_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, NULL, $11)`,
      [
        `0x${id.toString(16).padStart(64, '0')}`,
        row.flow,
        row.protectedFlow,
        String(1000 + id),
        settled ? String(100 + id) : null,
        row.status,
        settled ? String(90 + (id % 20)) : null,
        row.exposure ? 0 : Math.floor(NOW / 1000) + 600,
        row.createdAt,
        `0x${id.toString(16).padStart(40, '0')}`,
        row.chain ?? CHAIN,
      ],
    );
  };
  for (const flow of flows)
    for (const protectedFlow of [false, true])
      for (const status of ['reserved', 'sent', 'settled', 'expired'])
        for (const age of [10_000, 2 * HOUR, 30 * HOUR])
          for (const exposure of [false, true]) {
            await add({ flow, protectedFlow, status, createdAt: NOW - age, exposure });
            // Another chain's rows never count.
            await add({ flow, protectedFlow, status, createdAt: NOW - age, exposure, chain: 5042 });
          }
  await db.transaction(async (tx) => {
    const whole = await sums(tx, windows(true), NOW, 100n, CHAIN);
    const history = await historySums(tx as never, NOW, CHAIN);
    assert.deepEqual(await recentSums(tx, NOW, 100n, CHAIN, history), whole);
    assert.ok(whole.ordinaryDone > 0n && whole.dayExit > 0n && whole.allOpen > 0n);
    assert.ok(whole.hourOrdinary > 0n && whole.settledAfter > 0n && whole.selfPaidOpen > 0n);
  });
});

function gate(db: Database, clock: { at: number }, historyMaxAgeMs = 120_000) {
  return ownPaymasterBudget({
    db,
    now: () => clock.at,
    submitterBound: true,
    historyMaxAgeMs,
    limits: {
      protectedWei: 0n,
      hourlyOrdinaryWei: 10n ** 20n,
      senderHourlyOrdinaryWei: 10n ** 20n,
      ordinaryCeilingWei: 1_000n,
    },
    deposit: async () => ({ wei: 10n ** 20n, block: 100n }),
  });
}
let ops = 0;
const reserve = (budget: ReturnType<typeof ownPaymasterBudget>, cost: bigint, at: number) => {
  ops += 1;
  const hash = `0x${ops.toString(16).padStart(64, '0')}`;
  return budget
    .reserve({
      userOpHash: hash,
      flow: 'registration',
      maxCostWei: cost,
      validUntil: Math.floor(at / 1000) + 600,
      sender: `0x${ops.toString(16).padStart(40, '0')}`,
      accountId: null,
    })
    .then(() => hash);
};

test('the history is read before the lock and shared; what is open still counts at once', async (t) => {
  const { db } = await setup(t);
  const clock = { at: NOW };
  const scans: string[] = [];
  const query = db.query.bind(db);
  (db as { query: unknown }).query = (sql: string, params?: unknown[]) => {
    if (sql.includes('"ordinaryDone"')) scans.push(sql);
    return query(sql, params as never);
  };
  const budget = gate(db, clock);
  await reserve(budget, 600n, clock.at);
  await reserve(budget, 300n, clock.at);
  assert.equal(scans.length, 1);
  // 900 open: the ceiling of 1,000 refuses at once, whatever the history's age.
  await assert.rejects(reserve(budget, 200n, clock.at), /ordinary_ceiling/);
  clock.at += 60_000;
  await reserve(budget, 50n, clock.at);
  assert.equal(scans.length, 2, 'renewed past half its age');
});

test('a settled spend counts in the ceiling once the history is renewed, at most its age late', async (t) => {
  const { db } = await setup(t);
  const clock = { at: NOW };
  const budget = gate(db, clock);
  const first = await reserve(budget, 900n, clock.at);
  await budget.settle(first, 900n, 90n);
  // The shared history predates the settlement: the ceiling is passed by this much, no more.
  await reserve(budget, 500n, clock.at);
  clock.at += 60_000;
  await assert.rejects(reserve(budget, 500n, clock.at), /ordinary_ceiling/);
});

test('with no usable history an admission counts everything itself', async (t) => {
  const { db } = await setup(t);
  const clock = { at: NOW };
  const budget = gate(db, clock, 0);
  const first = await reserve(budget, 900n, clock.at);
  await budget.settle(first, 900n, 90n);
  await assert.rejects(reserve(budget, 500n, clock.at), /ordinary_ceiling/);
});
