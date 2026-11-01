// Operation Paymaster's spending gate across many accounts (own-paymaster-budget.ts): handouts that
// are never signed (given back or held until they lapse), signed operations at send, self-paid
// exposure, counting once per operation, the never-sent places and the daily exit caps, at Base's
// usual fees and at the policy's fee ceiling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import {
  BUDGET_LIMITS,
  BudgetError,
  EXPIRY_MARGIN_S,
  OWN_PAYMASTER_ATTRIBUTION_SQL,
  OWN_PAYMASTER_BUDGET_CHAIN_SQL,
  OWN_PAYMASTER_BUDGET_SQL,
  OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL,
  ownPaymasterBudget,
  worstCaseWei,
  type BudgetLimits,
} from '../server/base/chain/own-paymaster-budget.js';

const NOW = 1_792_800_000_000;
const S = Math.floor(NOW / 1000);
const HOUR = 3_600_000;
let n = 0;
const hash = () => `0x${(++n).toString(16).padStart(64, '0')}`;
let senders = 0;
const addr = () => `0x${(++senders).toString(16).padStart(40, '0')}`;

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(OWN_PAYMASTER_BUDGET_SQL);
  await pg.exec(OWN_PAYMASTER_ATTRIBUTION_SQL);
  await pg.exec(OWN_PAYMASTER_BUDGET_CHAIN_SQL);
  await pg.exec(OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL);
  return {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  } as unknown as Database;
}
const gate = (
  db: Database,
  options: {
    clock?: () => number;
    deposit?: () => { wei: bigint; block: bigint };
    limits?: Partial<BudgetLimits>;
    /** The direct bundler's: only our submitter can send a sponsorship (see the module header). */
    submitterBound?: boolean;
    log?: (line: string) => void;
  } = {},
) =>
  ownPaymasterBudget({
    db,
    ...(options.log ? { log: options.log } : {}),
    deposit: async () => options.deposit?.() ?? { wei: 10n ** 18n, block: 1n },
    now: options.clock ?? (() => NOW),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.submitterBound ? { submitterBound: true } : {}),
  });
const outcome = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'admitted';
  } catch (e) {
    if (e instanceof BudgetError) return e.reason;
    throw e;
  }
};

// A sponsored withdrawal at Base's usual fees: deployed wallet, USDC transfer.
// callGas = max(1.5*45k + 50k, 100k) = 117.5k, verification 300k, PVG ~70k, maxFee 2*0.006+0.001 gwei.
const W = worstCaseWei({
  callGasLimit: 117_500n,
  verificationGasLimit: 300_000n,
  preVerificationGas: 70_000n,
  maxFeePerGas: 13_000_000n,
});
/** The same withdrawal at the policy's 0.5 gwei fee ceiling (GAS_CEILINGS.maxFeePerGas). */
const W_CEILING = worstCaseWei({
  callGasLimit: 117_500n,
  verificationGasLimit: 300_000n,
  preVerificationGas: 70_000n,
  maxFeePerGas: 500_000_000n,
});

/**
 * The shared caps scaled down to whole numbers of W, in production's proportions (an account a
 * tenth of the ordinary hour and a quarter of the exit hour, a sender half of its account's), so the
 * cases below need a few hundred operations instead of thousands.
 */
const SCALED: Partial<BudgetLimits> = {
  hourlyOrdinaryWei: 100n * W,
  accountHourlyOrdinaryWei: 10n * W,
  senderHourlyOrdinaryWei: 5n * W,
  hourlyExitWei: 40n * W,
  dailyExitWei: 100n * W,
  accountHourlyExitWei: 10n * W,
  accountDailyExitWei: 20n * W,
  senderHourlyExitWei: 5n * W,
};
assert.equal(BUDGET_LIMITS.hourlyOrdinaryWei / BUDGET_LIMITS.accountHourlyOrdinaryWei, 10n);
assert.equal(BUDGET_LIMITS.hourlyExitWei / BUDGET_LIMITS.accountHourlyExitWei, 4n);

/**
 * More accounts than it takes to fill a shared hour, two wallets each, create and release owner
 * handouts until each is refused (cost 0 gas, inside the per-person create rates).
 */
async function churn(
  g: ReturnType<typeof gate>,
  input: { accounts: number; flow: 'exit' | 'rate'; clock: () => number; tick: () => void },
) {
  let made = 0n;
  const reasons = new Set<string>();
  for (let a = 0; a < input.accounts; a++)
    for (const wallet of [addr(), addr()])
      for (;;) {
        const h = hash();
        const r = await outcome(
          g.reserve({
            userOpHash: h,
            flow: input.flow,
            maxCostWei: W,
            validUntil: Math.floor(input.clock() / 1000) + 540,
            sender: wallet,
            accountId: `leaver${a}`,
          }),
        );
        if (r !== 'admitted') {
          reasons.add(r);
          break;
        }
        made++;
        await g.release(h); // the owner cancels it unsigned: given back at once
        input.tick();
      }
  return { made, reasons };
}
const honestly = (
  g: ReturnType<typeof gate>,
  flow: 'exit' | 'registration' | 'agentPay' | 'feedPay',
  clock: number,
) =>
  outcome(
    g.reserve({
      userOpHash: hash(),
      flow,
      maxCostWei: W,
      validUntil: Math.floor(clock / 1000) + 540,
      sender: addr(),
      accountId: 'honest',
    }),
  );

test('exits: accounts that create and release unsigned exits never take the shared exit hour from an honest owner', async (t) => {
  const db = await setup(t);
  let clock = NOW;
  const g = gate(db, { clock: () => clock, submitterBound: true, limits: SCALED });
  const { made, reasons } = await churn(g, {
    accounts: 5,
    flow: 'exit',
    clock: () => clock,
    tick: () => (clock += 1_000),
  });
  // More than the whole shared exit hour was handed out; each account stopped at its own caps.
  assert.ok(made * W > SCALED.hourlyExitWei!);
  for (const reason of reasons) assert.ok(['account_hourly', 'sender_hourly'].includes(reason));
  // None of it stays in the shared hour: an honest owner's first exit is admitted.
  assert.equal(await honestly(g, 'exit', clock), 'admitted');
  assert.equal((await g.snapshot()).lastHourExitWei, W);
});

test("exits without the submitter binding: released exits hold at most the handout share past each account's first; a signed exit is still sent", async (t) => {
  const db = await setup(t);
  let clock = NOW;
  const g = gate(db, { clock: () => clock, limits: SCALED });
  // An honest owner signed an exit before the churn began.
  const signed = { sender: addr(), accountId: 'honest-signed' };
  const before = hash();
  await g.reserve({
    userOpHash: before,
    flow: 'exit',
    maxCostWei: W,
    validUntil: S + 540,
    ...signed,
  });
  const { reasons } = await churn(g, {
    accounts: 5,
    flow: 'exit',
    clock: () => clock,
    tick: () => (clock += 1_000),
  });
  assert.ok(reasons.has('handout_share'));
  const snap = await g.snapshot();
  // The share, and one first exit of each of the five accounts (never refused by the share).
  assert.ok(snap.unsignedHandoutExitWei <= (SCALED.hourlyExitWei! * 3n) / 10n + 5n * W);
  assert.ok(snap.lastHourExitWei <= SCALED.hourlyExitWei!);
  // An honest owner's first exit is admitted while they are still held.
  assert.equal(await honestly(g, 'exit', clock), 'admitted');
  // The signed one is sent: its exposure meets the deposit only.
  await db.transaction(async (tx) => {
    await g.markSentIn(tx as never, before);
    await g.exposeIn(tx as never, {
      key: hash(),
      flow: 'exit',
      maxCostWei: W,
      ...signed,
      sponsored: true,
    });
  });
  // Once their validUntil + margin passed, a new owner's exit is admitted again.
  clock += (540 + EXPIRY_MARGIN_S + 1) * 1000;
  assert.equal(await honestly(g, 'exit', clock), 'admitted');
});

test('ordinary: accounts that create and release ratings never take the shared hour from registrations, agent payments or feed pay', async (t) => {
  for (const submitterBound of [true, false]) {
    const db = await setup(t);
    let clock = NOW;
    const g = gate(db, { clock: () => clock, submitterBound, limits: SCALED });
    const { made } = await churn(g, {
      accounts: 11,
      flow: 'rate',
      clock: () => clock,
      tick: () => (clock += 500),
    });
    if (submitterBound) assert.ok(made * W > SCALED.hourlyOrdinaryWei!);
    for (const flow of ['registration', 'agentPay', 'feedPay'] as const)
      assert.equal(await honestly(g, flow, clock), 'admitted', `${flow} (bound ${submitterBound})`);
    const snap = await g.snapshot();
    if (submitterBound) assert.equal(snap.unsignedHandoutOrdinaryWei, 0n);
    else
      assert.ok(
        snap.unsignedHandoutOrdinaryWei <= (SCALED.hourlyOrdinaryWei! * 3n) / 10n + 11n * W,
      );
  }
});

test('the owner-funded way out: a self-paid exposure at send meets only the submitter float, whatever the shared hour', async (t) => {
  const db = await setup(t);
  const g = gate(db, {
    limits: {
      hourlyOrdinaryWei: 10n * W,
      accountHourlyOrdinaryWei: 10n * W,
      senderHourlyOrdinaryWei: 10n * W,
    },
  });
  for (let i = 0; i < 10; i++)
    await g.reserve({
      userOpHash: hash(),
      flow: 'agentPay',
      maxCostWei: W,
      validUntil: S + 540,
      sender: addr(),
      accountId: 'busy',
    });
  assert.equal(
    await outcome(
      g.reserve({
        userOpHash: hash(),
        flow: 'agentPay',
        maxCostWei: W,
        validUntil: S + 540,
        sender: addr(),
        accountId: 'x',
      }),
    ),
    'hourly',
  );
  // direct-bundler.ts send(): a self-paid op's exposure, its sender's twice in a row.
  const wallet = addr();
  for (let i = 0; i < 2; i++) {
    const r = await outcome(
      db.transaction((tx) =>
        g.exposeIn(tx as never, {
          key: hash(),
          flow: 'ownerPay',
          maxCostWei: W,
          sender: wallet,
          accountId: null,
          sponsored: false,
          floatWei: 2n * W,
        }),
      ),
    );
    assert.equal(r, 'admitted');
  }
  assert.equal(
    await outcome(
      db.transaction((tx) =>
        g.exposeIn(tx as never, {
          key: hash(),
          flow: 'ownerPay',
          maxCostWei: W,
          sender: wallet,
          accountId: null,
          sponsored: false,
          floatWei: 2n * W,
        }),
      ),
    ),
    'submitter_float',
  );
});

test('a signed sponsored payment or rating is sent though others filled the shared hour after its reserve', async (t) => {
  for (const flow of ['ownerPay', 'rate'] as const) {
    const db = await setup(t);
    const g = gate(db, { limits: { hourlyOrdinaryWei: 3n * W, handoutShareBps: 10_000 } });
    const honest = { sender: addr(), accountId: 'honest' };
    const h = hash();
    await g.reserve({ userOpHash: h, flow, maxCostWei: W, validUntil: S + 540, ...honest });
    // Meanwhile others fill the hour.
    for (let i = 0; i < 2; i++)
      await g.reserve({
        userOpHash: hash(),
        flow: 'agentPay',
        maxCostWei: W,
        validUntil: S + 540,
        sender: addr(),
        accountId: `o${i}`,
      });
    const r = await outcome(
      db.transaction(async (tx) => {
        await g.markSentIn(tx as never, h);
        await g.exposeIn(tx as never, {
          key: hash(),
          flow,
          maxCostWei: W,
          ...honest,
          sponsored: true,
        });
      }),
    );
    assert.equal(r, 'admitted', flow);
  }
});

test('one account gets its whole documented hour: each sponsored operation counts once against it', async (t) => {
  const db = await setup(t);
  const g = gate(db);
  const acct = 'busy-owner';
  let ops = 0;
  for (;;) {
    const who = { sender: addr(), accountId: acct };
    const h = hash();
    const r = await outcome(
      g.reserve({ userOpHash: h, flow: 'agentPay', maxCostWei: W, validUntil: S + 540, ...who }),
    );
    if (r !== 'admitted') {
      assert.equal(r, 'account_hourly');
      break;
    }
    await db.transaction(async (tx) => {
      await g.markSentIn(tx as never, h);
      await g.exposeIn(tx as never, {
        key: hash(),
        flow: 'agentPay',
        maxCostWei: W,
        ...who,
        sponsored: true,
      });
    });
    ops++;
  }
  assert.equal(BigInt(ops), BUDGET_LIMITS.accountHourlyOrdinaryWei / W);
});

test("the never-sent places hold owner handouts only: unsigned withdrawals never block the same owner's agents", async (t) => {
  const db = await setup(t);
  const g = gate(db);
  // Two withdrawals (its never-sent exits) and eight payments, none signed yet.
  for (let i = 0; i < 10; i++)
    await g.reserve({
      userOpHash: hash(),
      flow: i < 2 ? 'exit' : 'ownerPay',
      maxCostWei: W / 10n,
      validUntil: S + 540,
      sender: addr(),
      accountId: 'owner',
    });
  for (const flow of ['agentPay', 'registration', 'feedPay'] as const)
    assert.equal(
      await outcome(
        g.reserve({
          userOpHash: hash(),
          flow,
          maxCostWei: W / 10n,
          validUntil: S + 540,
          sender: addr(),
          accountId: 'owner',
        }),
      ),
      'admitted',
      flow,
    );
  // An eleventh handout of the owner's is the one refused.
  assert.equal(
    await outcome(
      g.reserve({
        userOpHash: hash(),
        flow: 'rate',
        maxCostWei: W / 10n,
        validUntil: S + 540,
        sender: addr(),
        accountId: 'owner',
      }),
    ),
    'unsigned_open',
  );
});

test('a burst of server-signed sends that failed before broadcast never blocks the retry', async (t) => {
  const db = await setup(t);
  let clock = NOW;
  const g = gate(db, { clock: () => clock });
  // Ten agent payments prepared; the send step fails (Base RPC down) for all.
  for (let i = 0; i < 10; i++)
    await g.reserve({
      userOpHash: hash(),
      flow: 'agentPay',
      maxCostWei: W,
      validUntil: S + 540,
      sender: addr(),
      accountId: 'fleet',
    });
  // At once, and ten minutes later.
  for (const later of [0, 10 * 60_000]) {
    clock = NOW + later;
    assert.equal(
      await outcome(
        g.reserve({
          userOpHash: hash(),
          flow: 'agentPay',
          maxCostWei: W,
          validUntil: Math.floor(clock / 1000) + 540,
          sender: addr(),
          accountId: 'fleet',
        }),
      ),
      'admitted',
    );
  }
});

test("one account's exits have a daily cap: one account looping exits spends at most 0.005 ETH a rolling day", async (t) => {
  const db = await setup(t);
  let clock = NOW;
  let deposit = 6n * 10n ** 16n; // 0.06 ETH left: the ordinary work is already refused (protected)
  let block = 1n;
  const g = gate(db, { clock: () => clock, deposit: () => ({ wei: deposit, block }) });
  assert.equal(
    await outcome(
      g.reserve({
        userOpHash: hash(),
        flow: 'registration',
        maxCostWei: 2n * 10n ** 16n,
        validUntil: S + 540,
        sender: addr(),
        accountId: 'x',
      }),
    ),
    'protected_reserve',
  );
  let spent = 0n;
  const refusals = new Set<string>();
  const wallets = [addr(), addr()];
  for (let hours = 0; hours < 48; hours++) {
    for (const wallet of wallets)
      for (;;) {
        const h = hash();
        const cost = 10n ** 14n; // 0.0001 ETH worst = actual (revoke / dust withdrawal loop)
        const r = await outcome(
          g.reserve({
            userOpHash: h,
            flow: 'exit',
            maxCostWei: cost,
            validUntil: Math.floor(clock / 1000) + 540,
            sender: wallet,
            accountId: 'looper',
          }),
        );
        if (r !== 'admitted') {
          refusals.add(r);
          break;
        }
        block++;
        await g.settle(h, cost, block);
        deposit -= cost; // gone from the paymaster's deposit at that block
        spent += cost;
      }
    clock += HOUR + 1;
  }
  // One hour of its own exit cap a day, then nothing until that day has rolled past: 0.01 ETH in
  // 48 hours, where it took the whole 0.06 in 12 before.
  assert.ok(refusals.has('account_daily'));
  assert.equal(spent, 2n * BUDGET_LIMITS.accountDailyExitWei);
  assert.equal(deposit, 5n * 10n ** 16n);
  // And deployment-wide: never more than the protected reserve per day, whoever exits.
  assert.equal(BUDGET_LIMITS.dailyExitWei, BUDGET_LIMITS.protectedWei);
});

/**
 * Accounts that take owner handouts and simply keep them (never signed, never cancelled: each one
 * holds its share until validUntil + margin, at no gas), two wallets each, until each account is
 * refused, and until the handout share of the class is full; then a few more accounts, each
 * holding its first.
 */
async function hold(
  g: ReturnType<typeof gate>,
  flow: 'exit' | 'rate',
  cost: bigint,
  limits: BudgetLimits,
) {
  const share =
    ((flow === 'exit' ? limits.hourlyExitWei : limits.hourlyOrdinaryWei) *
      BigInt(limits.handoutShareBps)) /
    10_000n;
  const reasons = new Set<string>();
  let held = 0n;
  let after = 0;
  for (let a = 0; after < 3; a++) {
    if (held + cost > share) after++;
    for (const wallet of [addr(), addr()])
      for (;;) {
        const r = await outcome(
          g.reserve({
            userOpHash: hash(),
            flow,
            maxCostWei: cost,
            validUntil: S + 540,
            sender: wallet,
            accountId: `holder${flow}${a}`,
          }),
        );
        if (r !== 'admitted') {
          reasons.add(r);
          break;
        }
        held += cost;
      }
  }
  return { held, share, reasons };
}

test("handouts held until they lapse: the share never refuses an honest owner's first exit or first payment while the shared hour has room, at usual fees and at the fee ceiling", async (t) => {
  for (const cost of [W, W_CEILING]) {
    for (const flow of ['exit', 'rate'] as const) {
      const db = await setup(t);
      const g = gate(db, { submitterBound: true });
      const { held, share, reasons } = await hold(g, flow, cost, BUDGET_LIMITS);
      // The share is full (and more: each late account holds its first past it)...
      assert.ok(held > share, `${flow} at ${cost}`);
      assert.ok(reasons.has('handout_share'));
      const snap = await g.snapshot();
      const hour = flow === 'exit' ? snap.lastHourExitWei : snap.lastHourOrdinaryWei;
      const cap = flow === 'exit' ? BUDGET_LIMITS.hourlyExitWei : BUDGET_LIMITS.hourlyOrdinaryWei;
      assert.equal(hour, held);
      assert.ok(hour + cost <= cap, 'the shared hour still has room');
      // ...and, with room left in the shared hour, an honest owner's first exit and first
      // payment are admitted all the same (the share does not refuse them).
      for (const own of ['exit', 'ownerPay'] as const)
        assert.equal(
          await outcome(
            g.reserve({
              userOpHash: hash(),
              flow: own,
              maxCostWei: cost,
              validUntil: S + 540,
              sender: addr(),
              accountId: `honest-${own}`,
            }),
          ),
          'admitted',
          `${own} after ${flow} holders at ${cost}`,
        );
      // So is the platform's own work (registrations) and an operator's never-signed rating.
      assert.equal(await honestly(g, 'registration', NOW), 'admitted');
    }
  }
  // Each account holds at most 2 never-sent exits (it was 10).
  assert.equal(BUDGET_LIMITS.unsignedOpenExitPerAccount, 2);
});

test("exits past the deployment's day figure: accounts looping signed exits up to their own day never pause an honest owner's first exits once the exit hour has room", async (t) => {
  const db = await setup(t);
  let clock = NOW;
  let block = 1n;
  const g = gate(db, { clock: () => clock, submitterBound: true });
  const cost = W_CEILING; // the fewest exits it takes: the fee ceiling, actual = worst case
  const reasons = new Set<string>();
  let looped = 0;
  // Accounts, two wallets each, exit until refused, hour after hour, until the shared day is full.
  for (let hour = 0, a = 0; !reasons.has('exit_daily'); hour++) {
    for (let k = 0; k < 6 && !reasons.has('exit_daily'); k++, a++)
      for (const wallet of [addr(), addr()])
        for (;;) {
          const h = hash();
          const who = { sender: wallet, accountId: `looper${a}` };
          const r = await outcome(
            g.reserve({
              userOpHash: h,
              flow: 'exit',
              maxCostWei: cost,
              validUntil: Math.floor(clock / 1000) + 300,
              ...who,
            }),
          );
          if (r !== 'admitted') {
            reasons.add(r);
            break;
          }
          // Signed and sent at once (dust withdrawals to itself), its exposure too, then settled.
          await db.transaction(async (tx) => {
            await g.markSentIn(tx as never, h);
            await g.exposeIn(tx as never, {
              key: hash(),
              flow: 'exit',
              maxCostWei: cost,
              ...who,
              sponsored: true,
            });
          });
          await g.settle(h, cost, ++block);
          looped++;
        }
    clock += HOUR + 1;
    assert.ok(hour < 24);
  }
  // The day counts the exits themselves, not the submitter's exposures for them; past it only the
  // first 3 of the account that met it.
  const snap = await g.snapshot();
  const free = BigInt(BUDGET_LIMITS.freeDailyExitsPerAccount);
  assert.ok(snap.lastDayExitWei <= BUDGET_LIMITS.dailyExitWei + free * cost);
  assert.ok(snap.lastDayExitWei + cost > BUDGET_LIMITS.dailyExitWei);
  assert.equal(snap.lastDayExitWei, BigInt(looped) * cost);
  // It took more than ten accounts at their own day; an hour later the exit hour has room again.
  assert.ok(looped * Number(cost) > 10 * Number(BUDGET_LIMITS.accountDailyExitWei) * 0.9);
  clock += HOUR + 1;
  const honest = { sender: addr(), accountId: 'honest-day' };
  const tryExit = () =>
    outcome(
      g.reserve({
        userOpHash: hash(),
        flow: 'exit',
        maxCostWei: cost,
        validUntil: Math.floor(clock / 1000) + 300,
        ...honest,
      }),
    );
  for (let i = 0; i < BUDGET_LIMITS.freeDailyExitsPerAccount; i++) {
    const h = hash();
    assert.equal(
      await outcome(
        g.reserve({
          userOpHash: h,
          flow: 'exit',
          maxCostWei: cost,
          validUntil: Math.floor(clock / 1000) + 300,
          ...honest,
        }),
      ),
      'admitted',
      `honest exit ${i + 1}`,
    );
    await g.markSent(h);
  }
  // Past its first 3 the shared day holds it too, and the loopers stay refused.
  assert.equal(await tryExit(), 'exit_daily');
  assert.notEqual(
    await outcome(
      g.reserve({
        userOpHash: hash(),
        flow: 'exit',
        maxCostWei: cost,
        validUntil: Math.floor(clock / 1000) + 300,
        sender: addr(),
        accountId: 'looper0',
      }),
    ),
    'admitted',
  );
});

test("residual: enough accounts each holding one never-signed first exit fill the shared exit hour; an honest owner's first exit is then refused by the hour (exit_hourly), not by the share", async (t) => {
  const db = await setup(t);
  let clock = NOW;
  const g = gate(db, { clock: () => clock, submitterBound: true });
  const cost = W_CEILING; // the fewest accounts it takes: the fee ceiling
  const firsts = (BUDGET_LIMITS.hourlyExitWei / cost) as bigint;
  let held = 0n;
  // Each account holds exactly one first exit, never signed, never released: the share never
  // refuses a first, so the share (30%) is no bound here; the shared hour is.
  for (let a = 0; ; a++) {
    const r = await outcome(
      g.reserve({
        userOpHash: hash(),
        flow: 'exit',
        maxCostWei: cost,
        validUntil: S + 300,
        sender: addr(),
        accountId: `holder${a}`,
      }),
    );
    if (r !== 'admitted') {
      assert.equal(r, 'exit_hourly');
      break;
    }
    held++;
  }
  assert.equal(held, firsts, 'one first exit per account until the exit hour is full');
  assert.ok(held * cost > (BUDGET_LIMITS.hourlyExitWei * 3n) / 10n, 'far past the 30% share');
  const honest = () =>
    outcome(
      g.reserve({
        userOpHash: hash(),
        flow: 'exit',
        maxCostWei: cost,
        validUntil: Math.floor(clock / 1000) + 300,
        sender: addr(),
        accountId: 'honest-first',
      }),
    );
  assert.equal(await honest(), 'exit_hourly');
  // Once those lapse (validUntil + margin), the honest owner's first exit is admitted.
  clock += (300 + EXPIRY_MARGIN_S + 1) * 1000;
  assert.equal(await honest(), 'admitted');
});

test("an exit admitted past the deployment's exit day figure only as an account's first of the day is an ALERT, at most once a rolling day per instance", async (t) => {
  const db = await setup(t);
  let clock = NOW;
  const lines: string[] = [];
  const alerts = () =>
    lines.filter((line) => line.includes('ALERT exits past the deployment exit day'));
  // A day figure of 1 wei: every exit is past it, so only the first-3 exemption admits any.
  const g = gate(db, {
    clock: () => clock,
    submitterBound: true,
    limits: { dailyExitWei: 1n },
    log: (line) => lines.push(line),
  });
  const exit = async (accountId: string, send = true, on = g) => {
    const h = hash();
    const r = await outcome(
      on.reserve({
        userOpHash: h,
        flow: 'exit',
        maxCostWei: W,
        validUntil: Math.floor(clock / 1000) + 300,
        sender: addr(),
        accountId,
      }),
    );
    if (r === 'admitted' && send) await on.markSent(h);
    return r;
  };
  // Another instance (its own notice clock) leaves an account holding 2 never-sent exits; here its
  // third passes the day exemption but is refused after it (unsigned_open): nothing was admitted,
  // no ALERT.
  const other = gate(db, {
    clock: () => clock,
    submitterBound: true,
    limits: { dailyExitWei: 1n },
  });
  assert.equal(await exit('held', false, other), 'admitted');
  assert.equal(await exit('held', false, other), 'admitted');
  assert.equal(await exit('held', false), 'unsigned_open');
  assert.deepEqual(alerts(), []);
  // The first exit admitted past the day figure in this period: one ALERT, with the numbers.
  assert.equal(await exit('a'), 'admitted');
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0]!, /day figure 1 wei/);
  assert.doesNotMatch(alerts()[0]!, /ceiling/);
  // More of them in the same rolling day, other accounts too: no second ALERT.
  assert.equal(await exit('a'), 'admitted');
  assert.equal(await exit('a'), 'admitted');
  clock += HOUR;
  assert.equal(await exit('b'), 'admitted');
  clock = NOW + 24 * HOUR - 1;
  assert.equal(await exit('c'), 'admitted');
  assert.equal(alerts().length, 1);
  // An account past its first 3 is refused at the day figure (exit_daily): no exemption ALERT.
  clock = NOW + 2 * HOUR;
  assert.equal(await exit('a'), 'exit_daily');
  assert.equal(alerts().length, 1);
  // A rolling day after the first ALERT, the next exemption is reported again.
  clock = NOW + 24 * HOUR;
  assert.equal(await exit('d'), 'admitted');
  assert.equal(alerts().length, 2);
  // Under the figure nothing is reported: a fresh instance with the default day figure.
  const quiet: string[] = [];
  const g2 = gate(await setup(t), {
    clock: () => clock,
    submitterBound: true,
    log: (l) => quiet.push(l),
  });
  await g2.reserve({
    userOpHash: hash(),
    flow: 'exit',
    maxCostWei: W,
    validUntil: Math.floor(clock / 1000) + 300,
    sender: addr(),
    accountId: 'a',
  });
  assert.deepEqual(quiet, []);
});
