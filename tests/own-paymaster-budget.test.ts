import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import {
  BUDGET_LIMITS,
  BudgetError,
  EXPIRY_MARGIN_S,
  OWN_PAYMASTER_BUDGET_SQL,
  PRIOR_ORDINARY_FEES_WEI,
  ownPaymasterBudget,
  ReservationConflict,
  ReservationGone,
  worstCaseWei,
  type BudgetLimits,
} from '../server/base/chain/own-paymaster-budget.js';

// Operation Paymaster's spending gate (server/base/chain/own-paymaster-budget.ts): worst cases are
// reserved atomically before signing; ordinary work never touches the protected 0.05 ETH.

const MILLI = 10n ** 15n; // 0.001 ETH
const NOW = 1_792_800_000_000;
const S = Math.floor(NOW / 1000);
let n = 0;
const hash = () => `0x${(++n).toString(16).padStart(64, '0')}`;

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(OWN_PAYMASTER_BUDGET_SQL);
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  } as unknown as Database;
  return { db, pg };
}
/** A chain whose deposit and head block the test moves. */
const chain = (wei: bigint, block = 100n) => ({ wei, block });
const gate = (
  db: Database,
  state: { wei: bigint; block: bigint },
  options: { now?: () => number; limits?: BudgetLimits } = {},
) =>
  ownPaymasterBudget({
    db,
    deposit: async () => ({ ...state }),
    now: options.now ?? (() => NOW),
    ...(options.limits ? { limits: options.limits } : {}),
  });
const reserve = (
  g: ReturnType<typeof gate>,
  flow: 'registration' | 'exit',
  cost: bigint,
  validUntil = S + 300,
  h = hash(),
) => g.reserve({ userOpHash: h, flow, maxCostWei: cost, validUntil }).then(() => h);
const refusedWith = async (p: Promise<unknown>, reason: string) =>
  assert.rejects(p, (e: unknown) => e instanceof BudgetError && e.reason === reason);

test('worst case = EntryPoint v0.6 sponsored prefund: (call + 3 × verification + PVG) × maxFee', () => {
  // 100 + 3·50 + 10 = 260 gas × 7 = 1820 (not 1120).
  assert.equal(
    worstCaseWei({
      callGasLimit: 100n,
      verificationGasLimit: 50n,
      preVerificationGas: 10n,
      maxFeePerGas: 7n,
    }),
    1820n,
  );
});

test('deposit 0.051, ordinary 0.002 is refused (it would dip into the protected 0.05)', async (t) => {
  const { db } = await setup(t);
  await refusedWith(
    reserve(gate(db, chain(51n * MILLI)), 'registration', 2n * MILLI),
    'protected_reserve',
  );
  // ...but an exit may use the protected reserve.
  await reserve(gate(db, chain(51n * MILLI)), 'exit', 2n * MILLI);
});

test('two concurrent 0.001 requests cannot both take the same 0.001 headroom', async (t) => {
  const { db } = await setup(t);
  const g = gate(db, chain(51n * MILLI)); // 0.001 above the protected 0.05
  const results = await Promise.allSettled([
    reserve(g, 'registration', MILLI),
    reserve(g, 'registration', MILLI),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
});

test('race: a receipt settled in a block AFTER the deposit reading still counts', async (t) => {
  const { db } = await setup(t);
  const state = chain(52n * MILLI, 100n);
  const g = gate(db, state);
  const earlier = await reserve(g, 'registration', 2n * MILLI); // free 0.050 now
  // The op mines in block 101 and its receipt settles it, but our deposit reading is still block 100.
  await g.settle(earlier, 2n * MILLI, 101n);
  await refusedWith(reserve(g, 'registration', 2n * MILLI), 'protected_reserve');
  // Once the reading reaches block 101 the deposit shows the spend itself: still refused.
  state.wei = 50n * MILLI;
  state.block = 101n;
  await refusedWith(reserve(g, 'registration', 2n * MILLI), 'protected_reserve');
});

test('the 0.15 ordinary ceiling counts overhead, settled and outstanding; a restart sees the same state', async (t) => {
  const { db } = await setup(t);
  const limits = {
    ordinaryCeilingWei: 150n * MILLI,
    hourlyOrdinaryWei: 10n ** 18n,
    protectedWei: 50n * MILLI,
  };
  const state = chain(10n ** 18n);
  const g = gate(db, state, { limits });
  await g.recordOverhead(20n * MILLI); // deploy + allowlist + submitter float
  const settled = await reserve(g, 'registration', 60n * MILLI);
  await g.settle(settled, 50n * MILLI, 100n); // actual below the worst case
  await reserve(g, 'registration', 70n * MILLI); // outstanding
  // 20 + 50 + 70 = 140; +11 would be 151 > 150.
  await refusedWith(reserve(g, 'registration', 11n * MILLI), 'ordinary_ceiling');
  // A fresh instance (a restart / another replica) sees the same ledger.
  const again = gate(db, state, { limits });
  await refusedWith(reserve(again, 'registration', 11n * MILLI), 'ordinary_ceiling');
  await reserve(again, 'registration', 10n * MILLI); // exactly 150
});

test('hourly ordinary cap: 0.1 ETH per rolling hour', async (t) => {
  const { db } = await setup(t);
  let now = NOW;
  const g = gate(db, chain(10n ** 18n), { now: () => now });
  await reserve(g, 'registration', 99n * MILLI, Math.floor(now / 1000) + 300);
  await refusedWith(reserve(g, 'registration', 2n * MILLI, Math.floor(now / 1000) + 300), 'hourly');
  now += 3_600_001;
  await reserve(g, 'registration', 2n * MILLI, Math.floor(now / 1000) + 300);
});

test('a never-sent reservation expires only after validUntil + margin; a sent one never by time; late receipts still settle', async (t) => {
  const { db, pg } = await setup(t);
  let now = NOW;
  const g = gate(db, chain(52n * MILLI), { now: () => now });
  const sent = await reserve(g, 'registration', MILLI, S + 60);
  await g.markSent(sent);
  const unsent = await reserve(g, 'registration', MILLI, S + 60);
  await refusedWith(reserve(g, 'registration', MILLI, S + 60), 'protected_reserve');
  now = (S + 60 + EXPIRY_MARGIN_S - 1) * 1000; // past validUntil, inside the skew margin
  await refusedWith(reserve(g, 'registration', MILLI, S + 400), 'protected_reserve');
  now = (S + 60 + EXPIRY_MARGIN_S + 1) * 1000;
  await reserve(g, 'registration', MILLI, S + 400); // the unsent one lapsed
  await refusedWith(reserve(g, 'registration', MILLI, S + 400), 'protected_reserve'); // the sent one did not
  // It landed after all: the late receipt settles the expired reservation.
  await g.settle(unsent, MILLI, 200n);
  const row = await pg.query<{ status: string }>(
    'SELECT status FROM own_paymaster_reservations WHERE user_op_hash = $1',
    [unsent],
  );
  assert.equal(row.rows[0]!.status, 'settled');
});

test('the same userOpHash keeps one reservation; another flow/cost conflicts; a deposit shortfall is refused', async (t) => {
  const { db, pg } = await setup(t);
  const g = gate(db, chain(100n * MILLI));
  const h = hash();
  await reserve(g, 'registration', MILLI, S + 300, h);
  await reserve(g, 'registration', MILLI, S + 300, h);
  assert.equal(
    (await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM own_paymaster_reservations'))
      .rows[0]!.n,
    1,
  );
  await assert.rejects(reserve(g, 'registration', 2n * MILLI, S + 300, h), ReservationConflict);
  await assert.rejects(reserve(g, 'exit', MILLI, S + 300, h), ReservationConflict);
  await refusedWith(reserve(gate(db, chain(MILLI)), 'exit', 2n * MILLI), 'deposit');
});

test('expire -> new admission -> markSent on the expired one is refused (no resurrection)', async (t) => {
  const { db } = await setup(t);
  let now = NOW;
  const g = gate(db, chain(51n * MILLI), { now: () => now });
  const old = await reserve(g, 'registration', MILLI, S + 60); // takes the only 0.001 of headroom
  now = (S + 60 + EXPIRY_MARGIN_S + 1) * 1000; // it lapses unsent
  await reserve(g, 'registration', MILLI, S + 400); // its headroom is taken by a new operation
  await assert.rejects(g.markSent(old), ReservationGone); // the old one must never be sent now
  // ...and asking again for the old hash never revives it.
  await assert.rejects(reserve(g, 'registration', MILLI, S + 60, old), ReservationConflict);
  // An open reservation is marked sent (twice is fine), and markSent on an unknown hash refuses.
  const open = await reserve(g, 'exit', MILLI, S + 400);
  await g.markSent(open);
  await g.markSent(open);
  await assert.rejects(g.markSent(hash()), ReservationGone);
});

test('a known hash with another validUntil, or settled, is a conflict, never a quiet success', async (t) => {
  const { db } = await setup(t);
  const g = gate(db, chain(100n * MILLI));
  const h = await reserve(g, 'registration', MILLI, S + 300);
  await assert.rejects(reserve(g, 'registration', MILLI, S + 301, h), ReservationConflict);
  await g.settle(h, MILLI, 100n);
  await assert.rejects(reserve(g, 'registration', MILLI, S + 300, h), ReservationConflict);
});

test('the production ordinary ceiling is inclusive of the fees already paid before the budget existed', () => {
  // deploy + allowlist + D1 + D2 + F1, L2 + L1 from their Base receipts.
  assert.equal(PRIOR_ORDINARY_FEES_WEI, 20_773_789_406_452n);
  assert.equal(BUDGET_LIMITS.ordinaryCeilingWei, 929_979_226_210_593_548n);
  assert.equal(
    BUDGET_LIMITS.ordinaryCeilingWei + PRIOR_ORDINARY_FEES_WEI,
    930_000_000_000_000_000n,
  );
  assert.equal(BUDGET_LIMITS.protectedWei, 50_000_000_000_000_000n);
  assert.equal(BUDGET_LIMITS.hourlyOrdinaryWei, 100_000_000_000_000_000n);
});
