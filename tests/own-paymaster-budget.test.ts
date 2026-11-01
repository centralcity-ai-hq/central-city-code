import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import {
  BUDGET_LIMITS,
  budgetAlert,
  budgetTransient,
  BudgetError,
  EXPIRY_MARGIN_S,
  OWN_PAYMASTER_ATTRIBUTION_SQL,
  OWN_PAYMASTER_BUDGET_CHAIN_SQL,
  OWN_PAYMASTER_BUDGET_SQL,
  OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL,
  ownPaymasterAttributionMigration,
  PRIOR_ORDINARY_FEES_WEI,
  ownPaymasterBudget,
  ReservationConflict,
  ReservationGone,
  worstCaseWei,
  type BudgetLimits,
} from '../server/base/chain/own-paymaster-budget.js';
import { GAS_CEILINGS, type SponsorFlow } from '../server/base/chain/own-paymaster-policy.js';

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
  await pg.exec(OWN_PAYMASTER_ATTRIBUTION_SQL);
  await pg.exec(OWN_PAYMASTER_BUDGET_CHAIN_SQL);
  await pg.exec(OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL);
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
  options: {
    now?: () => number;
    limits?: Partial<BudgetLimits>;
    operatorAccounts?: ReadonlySet<string>;
    submitterBound?: boolean;
  } = {},
) =>
  ownPaymasterBudget({
    db,
    deposit: async () => ({ ...state }),
    now: options.now ?? (() => NOW),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.operatorAccounts ? { operatorAccounts: () => options.operatorAccounts! } : {}),
    ...(options.submitterBound ? { submitterBound: true } : {}),
  });
/** The whole shared hour open to owner handouts, 10 never-sent exits each: for the other caps. */
const OPEN_HANDOUTS = { handoutShareBps: 10_000, unsignedOpenExitPerAccount: 10 } as const;
/** A fresh sender each time unless one is given; no account unless one is given. */
let senders = 0;
const sender = () => `0x${(++senders).toString(16).padStart(40, '0')}`;
const reserve = (
  g: ReturnType<typeof gate>,
  flow: SponsorFlow,
  cost: bigint,
  validUntil = S + 300,
  h = hash(),
  who: { sender?: string; accountId?: string | null } = {},
) =>
  g
    .reserve({
      userOpHash: h,
      flow,
      maxCostWei: cost,
      validUntil,
      sender: who.sender ?? sender(),
      accountId: who.accountId ?? null,
    })
    .then(() => h);
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
    senderHourlyOrdinaryWei: 10n ** 18n,
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
  // One operation above a sender's own hour, to reach the shared one.
  const g = gate(db, chain(10n ** 18n), {
    now: () => now,
    limits: { senderHourlyOrdinaryWei: 10n ** 18n },
  });
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

// Per-account sponsorship budgets: every reservation records its sender and account (migration 270);
// one account, one sender and the exit class each have an hourly cap, and one account holds at most
// 10 never-sent reservations. None of these refusals existed before: the old gate admitted all of it.

test('one account: 0.01 ETH ordinary per hour, whatever its senders; other accounts unaffected', async (t) => {
  const { db, pg } = await setup(t);
  const g = gate(db, chain(10n ** 18n));
  const acc = { accountId: 'acc-1' };
  for (let i = 0; i < 3; i++) await reserve(g, 'registration', 3n * MILLI, S + 300, hash(), acc);
  // 9 + 2 = 11 > 10, though each sender is new and far below its own 0.005.
  await refusedWith(reserve(g, 'registration', 2n * MILLI, S + 300, hash(), acc), 'account_hourly');
  await reserve(g, 'registration', MILLI, S + 300, hash(), acc); // exactly 10
  await reserve(g, 'registration', 3n * MILLI, S + 300, hash(), { accountId: 'acc-2' });
  // Recorded: who it was for.
  const rows = await pg.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM own_paymaster_reservations WHERE account_id = 'acc-1' AND sender ~ '^0x[0-9a-f]{40}$'",
  );
  assert.equal(rows.rows[0]!.n, 4);
});

test('one sender: 0.005 ETH ordinary and 0.0025 exit per hour, with or without an account', async (t) => {
  const { db } = await setup(t);
  let now = NOW;
  const g = gate(db, chain(10n ** 18n), { now: () => now, limits: OPEN_HANDOUTS });
  const wallet = `0x${'ab'.repeat(20)}`;
  await reserve(g, 'registration', 3n * MILLI, S + 300, hash(), { sender: wallet });
  await refusedWith(
    reserve(g, 'registration', 3n * MILLI, S + 300, hash(), { sender: wallet, accountId: 'a' }),
    'sender_hourly',
  );
  // The exit class has its own, smaller hour: 2 + 1 > 2.5.
  await reserve(g, 'exit', 2n * MILLI, S + 300, hash(), { sender: wallet, accountId: 'a' });
  await refusedWith(
    reserve(g, 'exit', MILLI, S + 300, hash(), { sender: wallet, accountId: 'b' }),
    'sender_hourly',
  );
  // One account's exits: 0.005 per hour across its senders.
  await reserve(g, 'exit', 2n * MILLI, S + 300, hash(), { accountId: 'b' });
  await reserve(g, 'exit', 2n * MILLI, S + 300, hash(), { accountId: 'b' });
  await refusedWith(
    reserve(g, 'exit', 2n * MILLI, S + 300, hash(), { accountId: 'b' }),
    'account_hourly',
  );
  // A rolling hour later the sender may again.
  now += 3_600_001;
  await reserve(g, 'registration', 3n * MILLI, Math.floor(now / 1000) + 300, hash(), {
    sender: wallet,
  });
});

test('exits: 0.02 ETH per hour in all, still exempt from the ordinary hour and ceiling', async (t) => {
  const { db } = await setup(t);
  const g = gate(db, chain(10n ** 18n), {
    limits: { hourlyOrdinaryWei: 2n * MILLI, ordinaryCeilingWei: 2n * MILLI, ...OPEN_HANDOUTS },
  });
  await reserve(g, 'registration', 2n * MILLI); // the ordinary hour and ceiling are full
  await refusedWith(reserve(g, 'registration', MILLI), 'ordinary_ceiling');
  for (let i = 0; i < 10; i++)
    await reserve(g, 'exit', 2n * MILLI, S + 300, hash(), { accountId: `x${i}` });
  await refusedWith(
    reserve(g, 'exit', MILLI, S + 300, hash(), { accountId: 'x10' }),
    'exit_hourly',
  );
});

test("exits per rolling day: 0.005 ETH per account, 0.05 deployment-wide past each account's first 3", async (t) => {
  const { db } = await setup(t);
  let now = NOW;
  const g = gate(db, chain(10n ** 18n), { now: () => now, limits: OPEN_HANDOUTS });
  const at = () => Math.floor(now / 1000) + 300;
  // One account, a fresh wallet each time, settled at once: its whole hour, then its day.
  for (let i = 0; i < 5; i++)
    await g.settle(await reserve(g, 'exit', MILLI, at(), hash(), { accountId: 'loop' }), MILLI, 1n);
  await refusedWith(
    reserve(g, 'exit', MILLI, at(), hash(), { accountId: 'loop' }),
    'account_hourly',
  );
  now += 3_600_001;
  await refusedWith(
    reserve(g, 'exit', MILLI, at(), hash(), { accountId: 'loop' }),
    'account_daily',
  );
  // Others fill the rest of the deployment's day (5 + 45 = 50), an hour at a time.
  for (let hour = 0; hour < 3; hour++) {
    for (let i = 0; i < (hour < 2 ? 20 : 5); i++)
      await g.settle(
        await reserve(g, 'exit', MILLI, at(), hash(), { accountId: `o${hour}-${i % 4}` }),
        MILLI,
        1n,
      );
    now += 3_600_001;
  }
  // An account that already made its 3 exits of the day is refused...
  await refusedWith(reserve(g, 'exit', MILLI, at(), hash(), { accountId: 'o0-0' }), 'exit_daily');
  // ...one that has not still has its first 3; the platform (no account) has none.
  for (let i = 0; i < 3; i++)
    await g.settle(
      await reserve(g, 'exit', MILLI, at(), hash(), { accountId: 'fresh' }),
      MILLI,
      1n,
    );
  await refusedWith(reserve(g, 'exit', MILLI, at(), hash(), { accountId: 'fresh' }), 'exit_daily');
  await refusedWith(reserve(g, 'exit', MILLI, at(), hash()), 'exit_daily');
  // Never-sent ones it gave back (or that lapsed) are not among its 3; exposures never count.
  const bound = gate(db, chain(10n ** 18n), {
    now: () => now,
    limits: OPEN_HANDOUTS,
    submitterBound: true,
  });
  for (let i = 0; i < 4; i++)
    await bound.release(await reserve(bound, 'exit', MILLI, at(), hash(), { accountId: 'back' }));
  const day = (await bound.snapshot()).lastDayExitWei;
  await db.transaction((tx) =>
    bound.exposeIn(tx as never, {
      key: hash(),
      flow: 'exit',
      maxCostWei: MILLI,
      sender: null,
      accountId: 'back',
      sponsored: true,
    }),
  );
  assert.equal((await bound.snapshot()).lastDayExitWei, day);
  await reserve(bound, 'exit', MILLI, at(), hash(), { accountId: 'back' });
  // A rolling day on, all are open again.
  now = NOW + 26 * 3_600_000;
  await reserve(g, 'exit', MILLI, at(), hash(), { accountId: 'loop' });
  await reserve(g, 'exit', MILLI, at(), hash(), { accountId: 'o0-0' });
});

test('at most 2 never-sent exits per account, within its 10 handouts; a signed or released one frees a place', async (t) => {
  const { db } = await setup(t);
  const g = gate(db, chain(10n ** 18n));
  const acc = { accountId: 'owner-x' };
  const first = await reserve(g, 'exit', 1000n, S + 300, hash(), acc);
  const second = await reserve(g, 'exit', 1000n, S + 300, hash(), acc);
  await refusedWith(reserve(g, 'exit', 1000n, S + 300, hash(), acc), 'unsigned_open');
  // Its other handouts are not held to it.
  await reserve(g, 'rate', 1000n, S + 300, hash(), acc);
  await reserve(g, 'ownerPay', 1000n, S + 300, hash(), acc);
  await g.markSent(first);
  await reserve(g, 'exit', 1000n, S + 300, hash(), acc);
  await g.release(second);
  await reserve(g, 'exit', 1000n, S + 300, hash(), acc);
  assert.equal(BUDGET_LIMITS.unsignedOpenExitPerAccount, 2);
});

test('at most 10 never-sent owner handouts per account; the server-signed flows never count; sent and released ones free a place', async (t) => {
  const { db, pg } = await setup(t);
  const g = gate(db, chain(10n ** 18n), { limits: { unsignedOpenExitPerAccount: 10 } });
  const acc = { accountId: 'owner-1' };
  const open: string[] = [];
  const owners: SponsorFlow[] = ['exit', 'ownerPay', 'rate'];
  for (let i = 0; i < 10; i++)
    open.push(await reserve(g, owners[i % 3]!, 1000n, S + 300, hash(), acc));
  for (const flow of owners)
    await refusedWith(reserve(g, flow, 1000n, S + 300, hash(), acc), 'unsigned_open');
  // The server signs these itself right away: never held to the owner's never-sent places, and
  // never taking one (12 more, and the owner is still at 10).
  for (let i = 0; i < 4; i++)
    for (const flow of ['registration', 'agentPay', 'feedPay'] as const)
      await reserve(g, flow, 1000n, S + 300, hash(), acc);
  // No account: only the global and per-sender caps.
  await reserve(g, 'rate', 1000n);
  await g.markSent(open[0]!);
  await reserve(g, 'rate', 1000n, S + 300, hash(), acc);
  await refusedWith(reserve(g, 'exit', 1000n, S + 300, hash(), acc), 'unsigned_open');
  // release: a never-sent one is given back at once; twice is the same; a sent one is untouched.
  await g.release(open[1]!);
  await g.release(open[1]!);
  await g.release(open[0]!);
  await g.release(hash());
  const states = await pg.query<{
    user_op_hash: string;
    status: string;
    released_at: string | null;
  }>(
    'SELECT user_op_hash, status, released_at::text AS released_at FROM own_paymaster_reservations WHERE user_op_hash = ANY($1)',
    [[open[0], open[1]]],
  );
  const by = new Map(states.rows.map((r) => [r.user_op_hash, r]));
  assert.equal(by.get(open[0]!)!.status, 'sent');
  assert.equal(by.get(open[0]!)!.released_at, null);
  assert.equal(by.get(open[1]!)!.status, 'expired');
  assert.equal(by.get(open[1]!)!.released_at, String(NOW));
  await reserve(g, 'exit', 1000n, S + 300, hash(), acc);
  // A released reservation is never sent again.
  await assert.rejects(g.markSent(open[1]!), ReservationGone);
});

test('without the submitter binding, a released reservation holds every shared window while its signature may execute; its own account keeps it for the hour', async (t) => {
  const { db } = await setup(t);
  let now = NOW;
  const state = chain(10n ** 18n);
  const limits: Partial<BudgetLimits> = { hourlyOrdinaryWei: 3n * MILLI };
  const g = gate(db, state, { now: () => now, limits });
  const acc = { accountId: 'acc-r' };
  const held = await reserve(g, 'registration', 3n * MILLI, S + 60, hash(), acc);
  await refusedWith(reserve(g, 'registration', MILLI), 'hourly');
  // Another account's, never sent and never released: it lapses by time below.
  limits.hourlyOrdinaryWei = 10n * MILLI;
  await reserve(g, 'registration', 3n * MILLI, S + 60, hash(), { accountId: 'acc-l' });
  limits.hourlyOrdinaryWei = 3n * MILLI;
  await g.release(held);
  // Its signature may still execute elsewhere until validUntil: the shared hour still counts it,
  // and the deposit (51 - 3 - 3 - 1 < 50)...
  await refusedWith(reserve(g, 'registration', MILLI), 'hourly');
  state.wei = 51n * MILLI;
  limits.hourlyOrdinaryWei = 10n ** 18n;
  await refusedWith(reserve(g, 'registration', MILLI), 'protected_reserve');
  // ...and so does its own account's (3 + 8 > 10, with room everywhere else).
  state.wei = 10n ** 18n;
  await refusedWith(reserve(g, 'registration', 8n * MILLI, S + 300, hash(), acc), 'account_hourly');
  // Past validUntil + margin neither can execute: the deposit and the shared hour no longer count
  // them (50 = 51 - 1)...
  state.wei = 51n * MILLI;
  limits.hourlyOrdinaryWei = MILLI;
  now = (S + 60 + EXPIRY_MARGIN_S + 1) * 1000;
  await reserve(g, 'registration', MILLI, S + 400);
  // ...but their own accounts' hours do, the lapsed one's too.
  state.wei = 10n ** 18n;
  limits.hourlyOrdinaryWei = 10n ** 18n;
  for (const accountId of ['acc-r', 'acc-l'])
    await refusedWith(
      reserve(g, 'registration', 8n * MILLI, S + 400, hash(), { accountId }),
      'account_hourly',
    );
  // An hour on, both are out of every hour.
  now = NOW + 3_600_001;
  await reserve(g, 'registration', 4n * MILLI, Math.floor(now / 1000) + 300, hash(), acc);
});

test('without the submitter binding, released still-valid handouts of many accounts and senders never take any shared hour past its cap', async (t) => {
  const { db } = await setup(t);
  let now = NOW;
  const limits: Partial<BudgetLimits> = { hourlyOrdinaryWei: 20n * MILLI };
  const g = gate(db, chain(10n ** 18n), { now: () => now, limits });
  const exitShare = (BUDGET_LIMITS.hourlyExitWei * 3n) / 10n; // 0.006
  const ordinaryShare = (20n * MILLI * 3n) / 10n; // 0.006
  const firsts = { exit: 0n, ordinary: 0n };
  const tally = { exit: 0n, ordinary: 0n };
  const refusals = new Set<string>();
  // Eight accounts, two wallets each, reserve and release at once, ordinary and exit alike.
  const churn = async (accounts: number, prefix: string) => {
    for (let i = 0; i < accounts; i++) {
      const seen = new Set<string>();
      for (let j = 0; j < 2; j++) {
        const who = { accountId: `${prefix}-${i}`, sender: sender() };
        for (const flow of ['exit', 'rate', 'ownerPay'] as const) {
          const cls = flow === 'exit' ? 'exit' : 'ordinary';
          try {
            await g.release(await reserve(g, flow, MILLI, S + 300, hash(), who));
            tally[cls] += MILLI;
            if (!seen.has(cls)) firsts[cls] += MILLI;
            seen.add(cls);
          } catch (error) {
            if (!(error instanceof BudgetError)) throw error;
            refusals.add(error.reason);
          }
        }
      }
    }
  };
  await churn(8, 'leaver');
  // Every signature may still execute: past each account's first handout of a class (which the
  // share never refuses), what was admitted never passed the share of its hour.
  assert.deepEqual([...refusals], ['handout_share']);
  assert.deepEqual(firsts, { exit: 8n * MILLI, ordinary: 8n * MILLI });
  assert.ok(tally.exit > exitShare && tally.exit - firsts.exit <= exitShare);
  assert.ok(tally.ordinary > ordinaryShare && tally.ordinary - firsts.ordinary <= ordinaryShare);
  const held = await g.snapshot();
  assert.equal(held.unsignedHandoutExitWei, tally.exit);
  assert.equal(held.lastHourExitWei, tally.exit);
  assert.equal(held.lastHourOrdinaryWei, tally.ordinary);
  // An account that holds one already is refused its next; one that holds none gets its first.
  await refusedWith(
    reserve(g, 'exit', MILLI, S + 300, hash(), { accountId: 'leaver-0' }),
    'handout_share',
  );
  // However many accounts take their first, no shared hour ever passes its cap.
  refusals.clear();
  await churn(30, 'many');
  assert.ok(refusals.has('exit_hourly') && refusals.has('hourly'));
  const busy = await g.snapshot();
  assert.equal(busy.lastHourExitWei, BUDGET_LIMITS.hourlyExitWei);
  assert.equal(busy.lastHourOrdinaryWei, 20n * MILLI);
  assert.equal(busy.openWei, BUDGET_LIMITS.hourlyExitWei + 20n * MILLI);
  // Their validUntil + margin passed: no signature can execute, nothing is held any more.
  now = (S + 300 + EXPIRY_MARGIN_S + 1) * 1000;
  const after = await g.snapshot();
  assert.deepEqual(
    [after.lastHourExitWei, after.lastHourOrdinaryWei, after.openWei, after.unsignedHandoutExitWei],
    [0n, 0n, 0n, 0n],
  );
  await reserve(g, 'exit', MILLI, S + 900, hash(), { accountId: 'someone-else' });
  await reserve(g, 'rate', MILLI, S + 900, hash(), { accountId: 'someone-else' });
  for (let i = 0; i < 2; i++)
    await reserve(g, 'registration', 5n * MILLI, S + 900, hash(), { accountId: 'server-1' });
});

test('with the submitter binding, a released never-sent handout gives its shares back at once; a lapsed one at validUntil + margin', async (t) => {
  const { db, pg } = await setup(t);
  let now = NOW;
  const state = chain(10n ** 18n);
  const limits: Partial<BudgetLimits> = {};
  const g = gate(db, state, { now: () => now, submitterBound: true, limits });
  // Four accounts each fill their own exit hour, and give every exit back unsigned.
  for (let i = 0; i < 4; i++) {
    const acc = { accountId: `leaver-${i}` };
    for (let j = 0; j < 2; j++)
      await g.release(await reserve(g, 'exit', (25n * MILLI) / 10n, S + 300, hash(), acc));
    // Their own hour still counts them (one account's churn stays its own).
    await refusedWith(reserve(g, 'exit', MILLI, S + 300, hash(), acc), 'account_hourly');
  }
  // None of it holds the shared exit hour, the handout share or the deposit any more.
  const snap = await g.snapshot();
  assert.equal(snap.lastHourExitWei, 0n);
  assert.equal(snap.unsignedHandoutExitWei, 0n);
  assert.equal(snap.openWei, 0n);
  await reserve(g, 'exit', (25n * MILLI) / 10n, S + 300, hash(), { accountId: 'someone-else' });
  // A handout left open holds its share (3 of a 10 hour) until it lapses; then nothing, as it was
  // never sent.
  limits.hourlyOrdinaryWei = 10n * MILLI;
  // (Another account's first handout is never refused by the share; its second is, until then.)
  const left = await reserve(g, 'rate', 2n * MILLI, S + 60, hash(), { accountId: 'idle' });
  await reserve(g, 'rate', MILLI, S + 300, hash(), { accountId: 'idle-2' });
  await refusedWith(
    reserve(g, 'rate', MILLI, S + 300, hash(), { accountId: 'idle-2' }),
    'handout_share',
  );
  now = (S + 60 + EXPIRY_MARGIN_S + 1) * 1000;
  await reserve(g, 'rate', MILLI, S + 400, hash(), { accountId: 'idle-2' });
  assert.equal((await g.snapshot()).lastHourOrdinaryWei, 2n * MILLI);
  // It landed after all (it cannot, but the receipt is the truth): it settles once, and counts.
  await g.settle(left, 2n * MILLI, 200n);
  await g.settle(left, 3n * MILLI, 201n);
  const row = await pg.query<{ status: string; actual: string }>(
    'SELECT status, actual_cost_wei::text AS actual FROM own_paymaster_reservations WHERE user_op_hash = $1',
    [left],
  );
  assert.deepEqual(row.rows[0], { status: 'settled', actual: String(2n * MILLI) });
  assert.equal((await g.snapshot()).lastHourOrdinaryWei, 4n * MILLI);
});

/** The submitter's exposure for a stored operation (direct-bundler.ts send, resend). */
const expose = (
  db: Database,
  g: ReturnType<typeof gate>,
  key: string,
  flow: SponsorFlow,
  cost: bigint,
  who: { sender: string | null; accountId: string | null; sponsored: boolean },
) => db.transaction((tx) => g.exposeIn(tx as never, { key, flow, maxCostWei: cost, ...who }));

test('one exit at the fee ceiling fits an empty account; at send a sponsorship meets the deposit only and never counts twice for its account', async (t) => {
  const { db } = await setup(t);
  const g = gate(db, chain(10n ** 18n));
  // The largest exit the policy signs: every gas field at its ceiling, deploying the wallet.
  const ceiling = worstCaseWei({
    callGasLimit: GAS_CEILINGS.callGasLimit,
    verificationGasLimit: GAS_CEILINGS.verificationGasLimitWithInit,
    preVerificationGas: GAS_CEILINGS.preVerificationGas,
    maxFeePerGas: GAS_CEILINGS.maxFeePerGas,
  });
  assert.ok(ceiling <= BUDGET_LIMITS.senderHourlyExitWei);
  assert.ok(ceiling <= (BUDGET_LIMITS.hourlyExitWei * 3n) / 10n);
  const who = { sender: `0x${'e1'.repeat(20)}`, accountId: 'exiting' };
  await g.markSent(await reserve(g, 'exit', ceiling, S + 300, hash(), who));
  // Signed: its exposure (about as large again) is admitted, and counts for the account only once,
  // at reserve: a second exit of the account from another wallet still fits its hour (2 x 0.0019).
  await expose(db, g, hash(), 'exit', ceiling, { ...who, sponsored: true });
  await reserve(g, 'exit', ceiling, S + 300, hash(), { accountId: 'exiting' });
  await refusedWith(reserve(g, 'exit', ceiling, S + 300, hash(), who), 'account_hourly');
  // With every shared cap full, an exit or ordinary sponsorship admitted at reserve is still sent,
  // and raised: the deposit is its only check at send.
  const busy = gate(db, chain(10n ** 18n), {
    limits: {
      hourlyExitWei: 2n * ceiling,
      hourlyOrdinaryWei: MILLI,
      ordinaryCeilingWei: MILLI,
      protectedWei: 10n ** 18n,
    },
  });
  for (const flow of ['exit', 'ownerPay', 'rate'] as const) {
    const key = hash();
    await expose(db, busy, key, flow, ceiling, { ...who, sponsored: true });
    await expose(db, busy, key, flow, 2n * ceiling, { ...who, sponsored: true });
  }
  await refusedWith(
    reserve(busy, 'exit', MILLI, S + 300, hash(), { accountId: 'late' }),
    'exit_hourly',
  );
  await refusedWith(
    reserve(busy, 'agentPay', MILLI, S + 300, hash(), { accountId: 'late' }),
    'ordinary_ceiling',
  );
  // Only the deposit itself refuses it.
  const dry = gate(db, chain(ceiling));
  await refusedWith(
    expose(db, dry, hash(), 'exit', ceiling, { ...who, sponsored: true }),
    'deposit',
  );
});

test('a self-paid operation is its own class: only the submitter float, never the sponsored caps or a sender cap', async (t) => {
  const { db } = await setup(t);
  // Every sponsored cap full: the hours, the ceiling, the reserve and the deposit.
  const g = gate(db, chain(0n), {
    limits: {
      hourlyOrdinaryWei: 1n,
      ordinaryCeilingWei: 1n,
      senderHourlyOrdinaryWei: 1n,
      protectedWei: 10n ** 18n,
    },
  });
  const own = { sender: `0x${'e2'.repeat(20)}`, accountId: null, sponsored: false };
  const float = 10n * MILLI;
  const first = hash();
  for (const key of [first, hash(), hash()])
    await db.transaction((tx) =>
      g.exposeIn(tx as never, {
        key,
        flow: 'ownerPay',
        maxCostWei: 3n * MILLI,
        ...own,
        floatWei: float,
      }),
    );
  // 9 of the float's 10 are held by open self-paid sends: one more of 2 is refused, of 1 fits.
  await refusedWith(
    db.transaction((tx) =>
      g.exposeIn(tx as never, {
        key: hash(),
        flow: 'exit',
        maxCostWei: 2n * MILLI,
        ...own,
        floatWei: float,
      }),
    ),
    'submitter_float',
  );
  // A replacement's raise of a self-paid send meets the float too.
  await refusedWith(
    db.transaction((tx) =>
      g.exposeIn(tx as never, {
        key: first,
        flow: 'ownerPay',
        maxCostWei: 5n * MILLI,
        ...own,
        floatWei: float,
      }),
    ),
    'submitter_float',
  );
  await db.transaction((tx) =>
    g.exposeIn(tx as never, {
      key: first,
      flow: 'ownerPay',
      maxCostWei: 4n * MILLI,
      ...own,
      floatWei: float,
    }),
  );
  // It never counts against the sponsored ones: the deposit, the hours or the ceiling.
  const open = gate(db, chain(10n ** 18n));
  const snap = await open.snapshot();
  assert.equal(snap.openWei, 0n);
  assert.equal(snap.lastHourOrdinaryWei, 0n);
  assert.equal(snap.ordinaryOpenWei, 0n);
  assert.equal(snap.selfPaidOpenWei, 10n * MILLI);
  await reserve(open, 'registration', 5n * MILLI, S + 300, hash(), { sender: own.sender });
});

test('operator accounts skip the per-account, per-sender and never-sent caps, never the global ones', async (t) => {
  const { db } = await setup(t);
  const g = gate(db, chain(10n ** 18n), {
    operatorAccounts: new Set(['ops']),
    limits: { hourlyOrdinaryWei: 30n * MILLI, ...OPEN_HANDOUTS },
  });
  const ops = { accountId: 'ops', sender: `0x${'0c'.repeat(20)}` };
  // 12 never-sent, 24 milli from one sender: past the account, sender and never-sent caps.
  for (let i = 0; i < 12; i++) await reserve(g, 'registration', 2n * MILLI, S + 300, hash(), ops);
  await refusedWith(reserve(g, 'registration', 7n * MILLI, S + 300, hash(), ops), 'hourly');
  // Exits too: 6 from one operator sender, past both of its exit caps.
  await reserve(g, 'exit', 3n * MILLI, S + 300, hash(), ops);
  await reserve(g, 'exit', 3n * MILLI, S + 300, hash(), ops);
  // Anyone else is held to them (2 + 2 + 2 > 5).
  await reserve(g, 'exit', 2n * MILLI, S + 300, hash(), { accountId: 'someone' });
  await reserve(g, 'exit', 2n * MILLI, S + 300, hash(), { accountId: 'someone' });
  await refusedWith(
    reserve(g, 'exit', 2n * MILLI, S + 300, hash(), { accountId: 'someone' }),
    'account_hourly',
  );
  // The handout share does not hold them either (the fleets sign theirs at once): 12 ratings
  // never signed yet, past a 3 milli share, while anyone else's second is refused.
  const share = gate(db, chain(10n ** 18n), {
    operatorAccounts: new Set(['ops']),
    limits: { hourlyOrdinaryWei: 10n ** 17n, handoutShareBps: 1 },
  });
  for (let i = 0; i < 12; i++) await reserve(share, 'rate', MILLI, S + 300, hash(), ops);
  await reserve(share, 'rate', MILLI, S + 300, hash(), { accountId: 'someone' });
  await refusedWith(
    reserve(share, 'rate', MILLI, S + 300, hash(), { accountId: 'someone' }),
    'handout_share',
  );
});

test('the new refusals are all "try again later"', () => {
  for (const reason of [
    'account_hourly',
    'sender_hourly',
    'exit_hourly',
    'exit_daily',
    'account_daily',
    'handout_share',
    'unsigned_open',
    'submitter_float',
  ] as const)
    assert.equal(budgetTransient(reason), true);
  assert.equal(budgetTransient('deposit'), false);
  // The ones the operator hears about at once.
  assert.deepEqual(
    (['exit_daily', 'deposit', 'protected_reserve', 'hourly', 'handout_share'] as const).map(
      budgetAlert,
    ),
    [true, true, true, false, false],
  );
  assert.equal(BUDGET_LIMITS.dailyExitWei, BUDGET_LIMITS.protectedWei);
  assert.equal(BUDGET_LIMITS.accountDailyExitWei, 5_000_000_000_000_000n);
  assert.equal(BUDGET_LIMITS.freeDailyExitsPerAccount, 3);
  assert.equal(BUDGET_LIMITS.handoutShareBps, 3_000);
  assert.equal(BUDGET_LIMITS.accountHourlyOrdinaryWei, 10_000_000_000_000_000n);
  assert.equal(BUDGET_LIMITS.senderHourlyOrdinaryWei, 5_000_000_000_000_000n);
  assert.equal(BUDGET_LIMITS.accountHourlyExitWei, 5_000_000_000_000_000n);
  assert.equal(BUDGET_LIMITS.senderHourlyExitWei, 2_500_000_000_000_000n);
  assert.equal(BUDGET_LIMITS.hourlyExitWei, 20_000_000_000_000_000n);
  assert.equal(BUDGET_LIMITS.unsignedOpenPerAccount, 10);
  assert.equal(BUDGET_LIMITS.unsignedOpenExitPerAccount, 2);
});

test('migration 270 is idempotent and keeps the rows from before, unattributed', async (t) => {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(OWN_PAYMASTER_BUDGET_SQL);
  await pg.query(
    `INSERT INTO own_paymaster_reservations
       (user_op_hash, flow, protected, max_cost_wei, status, valid_until, created_at, updated_at)
     VALUES ($1, 'registration', false, 1, 'sent', 0, 1, 1)`,
    [hash()],
  );
  assert.equal(ownPaymasterAttributionMigration.version, 270);
  await pg.exec(ownPaymasterAttributionMigration.sql);
  await pg.exec(ownPaymasterAttributionMigration.sql);
  const row = await pg.query<{ sender: string | null; account_id: string | null }>(
    'SELECT sender, account_id, released_at FROM own_paymaster_reservations',
  );
  assert.deepEqual(row.rows, [{ sender: null, account_id: null, released_at: null }]);
  const indexes = await pg.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'own_paymaster_reservations' ORDER BY 1",
  );
  for (const name of ['own_paymaster_reservations_account', 'own_paymaster_reservations_sender'])
    assert.ok(indexes.rows.some((r) => r.indexname === name));
  await assert.rejects(pg.query("UPDATE own_paymaster_reservations SET sender = 'not-an-address'"));
});

test('rekey: the same operation prepared twice in one second releases the duplicate digest row', async (t) => {
  const { db, pg } = await setup(t);
  const g = gate(db, chain(500n * MILLI));
  const digest = hash();
  const opHash = hash();
  const prepare = async () => {
    await reserve(g, 'registration', MILLI, S + 300, digest);
    await g.rekey(digest, opHash);
  };
  await prepare();
  // Same digest again (same operation, same validUntil second): no key collision, no throw.
  await prepare();
  const rows = await pg.query<{ user_op_hash: string; status: string }>(
    'SELECT user_op_hash, status FROM own_paymaster_reservations ORDER BY user_op_hash',
  );
  assert.deepEqual(rows.rows, [
    { user_op_hash: digest, status: 'expired' },
    { user_op_hash: opHash, status: 'reserved' },
  ]);
  // Only one worst case is held.
  assert.equal((await g.snapshot()).openWei, MILLI);
  // Once the target is no longer open, a duplicate is released and the op is refused.
  await g.settle(opHash, MILLI / 2n, 101n);
  await pg.query('DELETE FROM own_paymaster_reservations WHERE user_op_hash = $1', [digest]);
  await reserve(g, 'registration', MILLI, S + 300, digest);
  await assert.rejects(g.rekey(digest, opHash), ReservationGone);
  const dup = await pg.query<{ status: string }>(
    'SELECT status FROM own_paymaster_reservations WHERE user_op_hash = $1',
    [digest],
  );
  assert.equal(dup.rows[0]!.status, 'expired');
  assert.equal((await g.snapshot()).openWei, 0n);
});
