import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ARC_MAINNET, ARC_TESTNET } from '../shared/chains.js';
import { BASE_MAINNET, BASE_SEPOLIA } from '../shared/base/chains.js';
import type { Database } from '../server/database.js';
import {
  BudgetError,
  OWN_PAYMASTER_ATTRIBUTION_SQL,
  OWN_PAYMASTER_BUDGET_CHAIN_SQL,
  OWN_PAYMASTER_BUDGET_SQL,
  OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL,
  ownPaymasterBudget,
} from '../server/base/chain/own-paymaster-budget.js';

const NOW = 1_800_000_000_000;
const MILLI = 10n ** 15n;
let n = 0;
const hash = () => `0x${(++n).toString(16).padStart(64, '0')}`;
const sender = () => `0x${(++n).toString(16).padStart(40, '0')}`;

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(OWN_PAYMASTER_BUDGET_SQL);
  await pg.exec(OWN_PAYMASTER_ATTRIBUTION_SQL);
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  } as unknown as Database;
  return { db, pg };
}
const migrate = async (pg: PGlite) => {
  await pg.exec(OWN_PAYMASTER_BUDGET_CHAIN_SQL);
  await pg.exec(OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL);
};
const gate = (db: Database, chainId: number | undefined, wei: bigint, block = 100n) =>
  ownPaymasterBudget({
    db,
    ...(chainId === undefined ? {} : { chainId }),
    deposit: async () => ({ wei, block }),
    now: () => NOW,
  });
const reserve = (g: ReturnType<typeof gate>, cost: bigint) => {
  const userOpHash = hash();
  return g
    .reserve({
      userOpHash,
      flow: 'registration',
      maxCostWei: cost,
      validUntil: Math.floor(NOW / 1000) + 600,
      sender: sender(),
      accountId: null,
    })
    .then(() => userOpHash);
};
const refused = (p: Promise<unknown>, reason: string) =>
  assert.rejects(p, (e: unknown) => e instanceof BudgetError && e.reason === reason);

test('migrations 349 and 350 leave the live Base row and its reservations as they were', async (t) => {
  const { pg } = await setup(t);
  await pg.query(
    'UPDATE own_paymaster_budget SET overhead_wei = 12345, updated_at = 7 WHERE id = 1',
  );
  const before = hash();
  await pg.query(
    `INSERT INTO own_paymaster_reservations
       (user_op_hash, flow, protected, max_cost_wei, status, valid_until, created_at, updated_at)
     VALUES ($1, 'registration', false, 9, 'sent', 0, 1, 1)`,
    [before],
  );
  await migrate(pg);

  const rows = await pg.query<{
    id: number;
    chain_id: number;
    overhead_wei: string;
    updated_at: string;
  }>(
    'SELECT id, chain_id, overhead_wei::text, updated_at::text FROM own_paymaster_budget ORDER BY chain_id',
  );
  const base = rows.rows.find((row) => row.id === 1)!;
  assert.deepEqual(base, { id: 1, chain_id: BASE_MAINNET, overhead_wei: '12345', updated_at: '7' });
  assert.deepEqual(
    rows.rows.map((row) => row.chain_id),
    [BASE_MAINNET, ARC_MAINNET, 31337, BASE_SEPOLIA, ARC_TESTNET].sort((a, b) => a - b),
  );
  for (const row of rows.rows.filter((r) => r.id !== 1)) {
    assert.equal(row.overhead_wei, '0');
  }
  const old = await pg.query<{ chain_id: number; max_cost_wei: string }>(
    'SELECT chain_id, max_cost_wei::text FROM own_paymaster_reservations WHERE user_op_hash = $1',
    [before],
  );
  assert.deepEqual(old.rows[0], { chain_id: BASE_MAINNET, max_cost_wei: '9' });

  // An instance still on the old code during the rollout: its statements still work, on Base.
  const locked = await pg.query('SELECT id FROM own_paymaster_budget WHERE id = 1 FOR UPDATE');
  assert.equal(locked.rows.length, 1);
  const inserted = hash();
  await pg.query(
    `INSERT INTO own_paymaster_reservations
       (user_op_hash, flow, protected, max_cost_wei, status, valid_until, created_at, updated_at)
     VALUES ($1, 'registration', false, 1, 'sent', 0, 1, 1)`,
    [inserted],
  );
  const landed = await pg.query<{ chain_id: number }>(
    'SELECT chain_id FROM own_paymaster_reservations WHERE user_op_hash = $1',
    [inserted],
  );
  assert.equal(landed.rows[0]!.chain_id, BASE_MAINNET);
});

test('concurrent reservations on two chains never add into one budget', async (t) => {
  const { db, pg } = await setup(t);
  await migrate(pg);
  // Each deposit has exactly 0.001 above the protected 0.05: one reservation fits on each chain.
  const base = gate(db, BASE_MAINNET, 51n * MILLI);
  const arc = gate(db, ARC_MAINNET, 51n * MILLI);
  const results = await Promise.allSettled([
    reserve(base, MILLI),
    reserve(base, MILLI),
    reserve(arc, MILLI),
    reserve(arc, MILLI),
  ]);
  const won = (from: number) =>
    results.slice(from, from + 2).filter((r) => r.status === 'fulfilled').length;
  // Added together, only one of the four would fit; kept apart, one per chain does, and no more.
  assert.equal(won(0), 1);
  assert.equal(won(2), 1);
  const rows = await pg.query<{ chain_id: number; n: number }>(
    'SELECT chain_id, count(*)::int AS n FROM own_paymaster_reservations GROUP BY chain_id ORDER BY chain_id',
  );
  assert.deepEqual(rows.rows, [
    { chain_id: ARC_MAINNET, n: 1 },
    { chain_id: BASE_MAINNET, n: 1 },
  ]);
});

test('overhead and settled spend stay on their own chain', async (t) => {
  const { db, pg } = await setup(t);
  await migrate(pg);
  const arc = gate(db, ARC_MAINNET, 52n * MILLI);
  await arc.recordOverhead(5n * MILLI);
  const settled = await reserve(arc, 2n * MILLI);
  // Settled after the deposit reading, so it still counts: on Arc, and only there.
  await arc.settle(settled, 2n * MILLI, 101n);
  await refused(reserve(arc, 2n * MILLI), 'protected_reserve');

  const base = gate(db, BASE_MAINNET, 52n * MILLI);
  const overhead = await pg.query<{ chain_id: number; overhead_wei: string }>(
    'SELECT chain_id, overhead_wei::text FROM own_paymaster_budget WHERE overhead_wei > 0',
  );
  assert.deepEqual(overhead.rows, [
    { chain_id: ARC_MAINNET, overhead_wei: (5n * MILLI).toString() },
  ]);
  await reserve(base, 2n * MILLI);
  assert.equal((await base.snapshot()).ordinarySpentWei, 0n);
  assert.equal((await arc.snapshot()).ordinarySpentWei, 7n * MILLI);
});

test('a budget given no chain is Base', async (t) => {
  const { db, pg } = await setup(t);
  await migrate(pg);
  const plain = gate(db, undefined, 52n * MILLI);
  await plain.recordOverhead(MILLI);
  const row = await pg.query<{ chain_id: number }>(
    'SELECT chain_id FROM own_paymaster_budget WHERE overhead_wei > 0',
  );
  assert.deepEqual(row.rows, [{ chain_id: BASE_MAINNET }]);
  const h = await reserve(plain, MILLI);
  const reservation = await pg.query<{ chain_id: number }>(
    'SELECT chain_id FROM own_paymaster_reservations WHERE user_op_hash = $1',
    [h],
  );
  assert.equal(reservation.rows[0]!.chain_id, BASE_MAINNET);
});
