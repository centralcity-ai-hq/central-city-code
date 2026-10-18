import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress } from 'viem';
import {
  createScreeningGate,
  SCREENING_DECISION_TTL_MS,
  type ScreeningProvider,
  type ScreeningRequest,
} from '../server/protocol/screening/gate.js';
import {
  sanctionsOracleFor,
  sanctionsOracleProvider,
} from '../server/protocol/screening/sanctions-oracle.js';
import { FEED_PAY_FEE_HOLD_RETRY_MS } from '../server/feed/pay/engine.js';
import { PROTOCOL_BASE_MAINNET } from '../shared/protocol.js';
import { CHAIN_ID, PAY_TO, USDC, setup } from './helpers/feed-pay-app.js';

/*
 * Operation Protocol N3: the payment screening gate (docs/protocol/SCREENING-GATE.md) and its
 * wiring into Feed pay. Fake screening provider, fake service and fake Base only: nothing reaches a
 * network and nothing real is paid. Synthetic addresses.
 *
 * Screening and fees are live by default (docs/protocol/LIVE.md): "on" here is the flag unset. The
 * fee router and treasury are Base mainnet's, fixed in code; the fake Base answers for them.
 */

const ROUTER = PROTOCOL_BASE_MAINNET.feeRouter;
const TREASURY = PROTOCOL_BASE_MAINNET.treasury;
const FEES_ON = { CITY_PROTOCOL_FEES: undefined };
const SCREENING_ON = {
  CITY_PROTOCOL_SCREENING: undefined,
  CITY_PROTOCOL_SCREENING_DENY: undefined,
};

/** A fake screening provider: listed addresses, an outage, a malformed or stale answer, a hang. */
function fakeProvider(clock: () => number) {
  const state = {
    listed: new Set<string>(),
    down: false,
    malformed: false,
    stale: false,
    hang: false,
    chainId: CHAIN_ID as number,
    calls: 0,
    asked: [] as string[][],
  };
  const provider: ScreeningProvider = {
    ref: 'fake-oracle:test',
    supports: (chainId) => chainId === state.chainId,
    async check({ addresses, signal }) {
      state.calls++;
      state.asked.push(addresses);
      if (state.down) throw new Error('provider down');
      if (state.hang)
        await new Promise((resolve) => signal.addEventListener('abort', () => resolve(null)));
      return {
        listed: Object.fromEntries(
          addresses.map((address) => [
            address,
            state.malformed ? 'maybe' : state.listed.has(address.toLowerCase()),
          ]),
        ),
        observedAt: state.stale ? clock() - 60 * 60_000 : clock(),
      };
    },
  };
  return { state, provider };
}

async function screened(t: test.TestContext, env: Record<string, string | undefined> = {}) {
  let fake: ReturnType<typeof fakeProvider> | undefined;
  const f = await setup(t, {
    env: { ...SCREENING_ON, ...env },
    screeningProvider: () => fake!.provider,
  });
  fake = fakeProvider(f.clock);
  // Base mainnet's router, paying its treasury (only used while fees are on).
  f.base.state.feeRouter = { router: ROUTER, treasury: TREASURY };
  await f.list();
  await f.limit();
  return { f, fake };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function decisions(f: Fixture) {
  return f.sql<{ outcome: string; reason: string; intent_id: string }>(
    'SELECT outcome, reason, intent_id FROM protocol_screening_decisions ORDER BY decided_at',
  );
}

async function feeRow(f: Fixture, callId: string) {
  const [row] = await f.sql<{
    fee_state: string;
    fee_op_key: string | null;
    fee_held_at: string | null;
    fee_hold_reason: string | null;
  }>(
    'SELECT fee_state, fee_op_key, fee_held_at::text, fee_hold_reason FROM feed_pay_calls WHERE call_id = $1',
    [callId],
  );
  return row!;
}

// ---------------------------------------------------------------------------------------------
// Feed pay wiring

test('switched off (0): no screening at all, the call is paid exactly as before', async (t) => {
  let fake: ReturnType<typeof fakeProvider> | undefined;
  const f = await setup(t, {
    env: { CITY_PROTOCOL_SCREENING: '0', CITY_PROTOCOL_SCREENING_DENY: PAY_TO },
    screeningProvider: () => fake!.provider,
  });
  fake = fakeProvider(f.clock);
  fake.state.listed.add(PAY_TO.toLowerCase());
  await f.list();
  await f.limit();
  const paid = await f.pay();
  assert.equal(paid.statusCode, 200, paid.body);
  const call = await f.settled(paid.json().callId);
  assert.equal(call.state, 'result_saved');
  assert.equal(call.failure, null);
  assert.equal(f.base.balanceOf(PAY_TO), 20000n);
  assert.equal(fake.state.calls, 0, 'the provider is never asked');
  assert.deepEqual(await decisions(f), []);
});

test('a blocked payee is refused before anything is signed or sent', async (t) => {
  const { f, fake } = await screened(t);
  fake.state.listed.add(PAY_TO.toLowerCase());
  const paid = await f.pay();
  assert.equal(paid.statusCode, 200, paid.body);
  const call = await f.settled(paid.json().callId);
  assert.equal(call.state, 'refused');
  assert.equal(call.failure?.code, 'screening_blocked');
  assert.match(call.failure!.message, /Nothing was paid/);
  assert.equal(call.payment, null);
  assert.equal(call.moneyMoved, 'no');
  assert.equal(f.base.state.signatures, 0, 'nothing was signed');
  assert.equal(f.base.state.sends.length, 0, 'no top-up, no operation');
  assert.equal(f.base.balanceOf(PAY_TO), 0n);
  const rows = await decisions(f);
  assert.deepEqual(rows, [
    { outcome: 'blocked', reason: 'sanctioned', intent_id: `feed-pay:${call.callId}` },
  ]);
  // The payee, the paying wallet and its spender were screened, lowercased.
  assert.ok(fake.state.asked[0]!.includes(PAY_TO.toLowerCase()));
  assert.ok(fake.state.asked[0]!.includes(f.wallet.toLowerCase()));
});

test('the static denylist blocks even when the provider clears the address', async (t) => {
  const { f } = await screened(t, {
    CITY_PROTOCOL_SCREENING_DENY: ` ${PAY_TO.toLowerCase()} ,junk`,
  });
  const paid = await f.pay();
  const call = await f.settled(paid.json().callId);
  assert.equal(call.failure?.code, 'screening_blocked');
  assert.equal((await decisions(f))[0]?.reason, 'denylisted');
  assert.equal(f.base.state.signatures, 0);
});

test('a clear screening pays as usual and stores one allowed decision per binding', async (t) => {
  const { f, fake } = await screened(t);
  const paid = await f.pay();
  const call = await f.settled(paid.json().callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call.failure));
  assert.equal(f.base.balanceOf(PAY_TO), 20000n);
  const rows = await decisions(f);
  // The seller leg (screened again right before signing, reusing the same decision) and the
  // top-up from the agent's wallet to its spender account.
  assert.ok(rows.every((row) => row.outcome === 'allowed' && row.reason === 'clear'));
  assert.equal(rows.filter((row) => row.intent_id === `feed-pay:${call.callId}`).length, 1);
  assert.ok(rows.some((row) => row.intent_id.startsWith('feed-pay:top-up:')));
  assert.equal(fake.state.calls, rows.length, 'a reused decision does not ask again');
});

test('provider outage: new submissions fail closed, already-broadcast operations still reconcile', async (t) => {
  const { f, fake } = await screened(t, FEES_ON);
  // The fee operation is broadcast after a clear screening but stays unlanded.
  f.base.state.holdFee = true;
  const paid = await f.pay();
  assert.equal(paid.statusCode, 200, paid.body);
  const callId = paid.json().callId;
  const first = await f.settled(callId);
  assert.equal(first.state, 'result_saved');
  const sent = await feeRow(f, callId);
  assert.equal(sent.fee_state, 'sent');
  // The provider goes down.
  fake.state.down = true;
  const asked = fake.state.calls;
  // A new call is refused before signing: screening_unavailable, nothing paid.
  const other = await f.pay();
  assert.equal(other.statusCode, 200, other.body);
  const refused = await f.settled(other.json().callId);
  assert.equal(refused.state, 'refused');
  assert.equal(refused.failure?.code, 'screening_unavailable');
  assert.equal(refused.payment, null);
  // The broadcast fee lands; reconciliation finishes it without asking the provider.
  f.base.state.holdFee = false;
  for (const hash of [...f.base.state.pool.keys()])
    if (!f.base.state.landed.has(hash)) f.base.land(hash);
  for (let i = 0; i < 6 && (await feeRow(f, callId)).fee_state !== 'charged'; i++) {
    f.advance(60_000);
    assert.equal((await f.cron()).statusCode, 200);
  }
  assert.equal((await feeRow(f, callId)).fee_state, 'charged');
  assert.equal(f.base.balanceOf(TREASURY), 2000n);
  // Only the new call's seller leg asked (and failed); no stored decision for the outage.
  assert.equal(fake.state.calls, asked + 1);
  const rows = await decisions(f);
  assert.ok(rows.every((row) => row.outcome === 'allowed'));
  assert.ok(!rows.some((row) => row.intent_id === `feed-pay:${other.json().callId}`));
});

test('a blocked fee recipient holds the owed fee: nothing charged, one alert, no new key; retried later', async (t) => {
  const { f, fake } = await screened(t, FEES_ON);
  fake.state.listed.add(TREASURY.toLowerCase());
  const paid = await f.pay();
  assert.equal(paid.statusCode, 200, paid.body);
  const callId = paid.json().callId;
  const call = await f.settled(callId);
  assert.equal(call.state, 'result_saved', 'the seller leg is not affected');
  assert.equal(f.base.balanceOf(PAY_TO), 20000n);
  let row = await feeRow(f, callId);
  assert.equal(row.fee_state, 'pending');
  assert.equal(row.fee_op_key, null, 'never submitted');
  assert.equal(row.fee_hold_reason, 'sanctioned');
  assert.equal(f.base.state.feeCharges.length, 0);
  assert.equal(f.base.balanceOf(TREASURY), 0n);
  // The cron leaves it held (and does not alert again) until the retry time.
  for (let i = 0; i < 3; i++) {
    f.advance(60_000);
    await f.cron();
  }
  row = await feeRow(f, callId);
  assert.equal(row.fee_state, 'pending');
  assert.equal(f.base.state.feeCharges.length, 0);
  const holds = f.alerts.filter((a) => a.kind === 'protocol_fee_screening_hold');
  assert.equal(holds.length, 1);
  assert.deepEqual(
    { callId: holds[0]!.callId, amountRaw: holds[0]!.amountRaw, detail: holds[0]!.detail },
    { callId, amountRaw: '2000', detail: 'sanctioned' },
  );
  assert.ok(!JSON.stringify(holds).includes(TREASURY.toLowerCase()), 'no address in the alert');
  // Cleared later (the blocked decision expired, the retry time passed): charged once, same key.
  fake.state.listed.clear();
  f.advance(Math.max(SCREENING_DECISION_TTL_MS, FEED_PAY_FEE_HOLD_RETRY_MS) + 1);
  for (let i = 0; i < 6 && (await feeRow(f, callId)).fee_state !== 'charged'; i++) {
    f.advance(60_000);
    await f.cron();
  }
  row = await feeRow(f, callId);
  assert.equal(row.fee_state, 'charged');
  assert.equal(row.fee_op_key, `feed-pay:fee:${callId}`);
  assert.equal(f.base.state.feeCharges.length, 1);
  assert.equal(f.base.balanceOf(TREASURY), 2000n);
});

/** Pays one call with fees on and lets the worker and a few crons try its fee leg. */
async function payAndTryFee(f: Fixture) {
  const paid = await f.pay();
  assert.equal(paid.statusCode, 200, paid.body);
  const callId = paid.json().callId as string;
  const call = await f.settled(callId);
  assert.equal(call.state, 'result_saved', 'the seller leg is not affected');
  for (let i = 0; i < 3; i++) {
    f.advance(60_000);
    await f.cron();
  }
  return callId;
}

const holdAlerts = (f: Fixture) => f.alerts.filter((a) => a.kind === 'protocol_fee_screening_hold');

test("the fee recipient is the pinned router's own treasury: a protocol treasury A that differs from the router's B holds the fee", async (t) => {
  const { f, fake } = await screened(t, FEES_ON);
  // The router on Base pays B; the treasury fixed in code is A (TREASURY).
  const actual = getAddress(`0x${'b0'.repeat(20)}`);
  f.base.state.feeRouter = { router: ROUTER, treasury: actual };
  const callId = await payAndTryFee(f);
  const row = await feeRow(f, callId);
  assert.equal(row.fee_state, 'pending');
  assert.equal(row.fee_op_key, null, 'never submitted');
  assert.equal(row.fee_hold_reason, 'fee_recipient_mismatch');
  assert.equal(f.base.state.feeCharges.length, 0);
  assert.equal(f.base.balanceOf(actual), 0n);
  assert.equal(f.base.balanceOf(TREASURY), 0n);
  // Neither address was screened as a substitute recipient, and nothing fee-related was decided.
  const asked = fake.state.asked.flat();
  assert.ok(!asked.includes(TREASURY.toLowerCase()), 'the configured address is never screened');
  assert.ok(!asked.includes(actual.toLowerCase()));
  assert.ok(!(await decisions(f)).some((d) => d.intent_id.startsWith('feed-pay:fee:')));
  assert.deepEqual(
    holdAlerts(f).map((a) => a.detail),
    ['fee_recipient_mismatch'],
  );
});

test("a failed read of the router's treasury holds the fee (fee_recipient_unknown) and it is charged once after", async (t) => {
  const { f } = await screened(t, FEES_ON);
  f.base.state.routerReadsDown = true;
  const callId = await payAndTryFee(f);
  let row = await feeRow(f, callId);
  assert.equal(row.fee_state, 'pending');
  assert.equal(row.fee_hold_reason, 'fee_recipient_unknown');
  assert.equal(f.base.state.feeCharges.length, 0);
  assert.deepEqual(
    holdAlerts(f).map((a) => a.detail),
    ['fee_recipient_unknown'],
  );
  // The node answers again (the failure was not cached): screened and charged once, same key.
  f.base.state.routerReadsDown = false;
  f.advance(FEED_PAY_FEE_HOLD_RETRY_MS + 1);
  for (let i = 0; i < 6 && (await feeRow(f, callId)).fee_state !== 'charged'; i++) {
    f.advance(60_000);
    await f.cron();
  }
  row = await feeRow(f, callId);
  assert.equal(row.fee_state, 'charged');
  assert.equal(row.fee_op_key, `feed-pay:fee:${callId}`);
  assert.equal(f.base.state.feeCharges.length, 1);
  assert.equal(f.base.balanceOf(TREASURY), 2000n);
  assert.ok(
    (await decisions(f)).some(
      (d) => d.intent_id === `feed-pay:fee:${callId}` && d.outcome === 'allowed',
    ),
  );
});

test("a router whose token is not Feed pay's USDC holds the fee (fee_router_token_mismatch)", async (t) => {
  const { f } = await screened(t, FEES_ON);
  f.base.state.feeRouter = {
    router: ROUTER,
    treasury: TREASURY,
    token: getAddress(`0x${'d1'.repeat(20)}`),
  };
  const callId = await payAndTryFee(f);
  const row = await feeRow(f, callId);
  assert.equal(row.fee_state, 'pending');
  assert.equal(row.fee_hold_reason, 'fee_router_token_mismatch');
  assert.equal(f.base.state.feeCharges.length, 0);
  assert.equal(f.base.balanceOf(TREASURY), 0n);
});

test('a pinned router with no contract behind it holds the fee (fee_recipient_unknown)', async (t) => {
  const { f } = await screened(t, FEES_ON);
  // Base has no router at the pinned address (the fake answers no treasury() there).
  f.base.state.feeRouter = { router: getAddress(`0x${'42'.repeat(20)}`), treasury: TREASURY };
  const callId = await payAndTryFee(f);
  const row = await feeRow(f, callId);
  assert.equal(row.fee_state, 'pending');
  assert.equal(row.fee_hold_reason, 'fee_recipient_unknown');
  assert.equal(f.base.state.feeCharges.length, 0);
});

// ---------------------------------------------------------------------------------------------
// The gate itself

async function gateFixture(t: test.TestContext, options: { timeoutMs?: number } = {}) {
  const f = await setup(t);
  let clockMs = f.clock();
  const now = () => clockMs;
  const fake = fakeProvider(now);
  const env: Record<string, string | undefined> = {};
  let provider: ScreeningProvider | null = fake.provider;
  const gate = createScreeningGate({
    db: f.db,
    env,
    now,
    provider: () => provider,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  return {
    f,
    gate,
    fake,
    env,
    advance: (ms: number) => {
      clockMs += ms;
    },
    setProvider: (next: ScreeningProvider | null) => {
      provider = next;
    },
  };
}

const A = getAddress(`0x${'a1'.repeat(20)}`);
const B = getAddress(`0x${'b2'.repeat(20)}`);
const C = getAddress(`0x${'c3'.repeat(20)}`);
const request = (over: Partial<ScreeningRequest> = {}): ScreeningRequest => ({
  chainId: CHAIN_ID,
  token: USDC,
  amountRaw: '20000',
  intentId: 'feed-pay:fc_test',
  parties: [
    { role: 'spender', address: A },
    { role: 'payee', address: B },
  ],
  ...over,
});

test('gate: a decision is reused only for the identical binding; amount or destination changes ask again', async (t) => {
  const { gate, fake } = await gateFixture(t);
  const first = await gate.screen(request());
  assert.equal(first.allowed, true);
  assert.match(first.decisionId!, /^sd_[0-9a-f]{32}$/);
  // The same binding (addresses in another case and order): reused, not asked again.
  const again = await gate.screen(
    request({
      parties: [
        { role: 'payee', address: B.toLowerCase() },
        { role: 'spender', address: A.toUpperCase().replace('0X', '0x') },
      ],
    }),
  );
  assert.deepEqual([again.decisionId, again.reused, fake.state.calls], [first.decisionId, true, 1]);
  // Another amount, destination, intent or chain: a new decision.
  const amount = await gate.screen(request({ amountRaw: 20001n }));
  const destination = await gate.screen(
    request({
      parties: [
        { role: 'spender', address: A },
        { role: 'payee', address: C },
      ],
    }),
  );
  const intent = await gate.screen(request({ intentId: 'feed-pay:fc_other' }));
  for (const d of [amount, destination, intent]) {
    assert.equal(d.reused, false);
    assert.notEqual(d.decisionId, first.decisionId);
  }
  assert.equal(fake.state.calls, 4);
  // A blocked destination after clearance: the changed binding is blocked.
  fake.state.listed.add(C.toLowerCase());
  const blocked = await gate.screen(
    request({
      amountRaw: '1',
      parties: [
        { role: 'spender', address: A },
        { role: 'payee', address: C },
      ],
    }),
  );
  assert.deepEqual(
    [blocked.allowed, blocked.outcome, blocked.reason],
    [false, 'blocked', 'sanctioned'],
  );
});

test('gate: an expired decision is not reused, and a policy change (denylist) invalidates it', async (t) => {
  const { gate, fake, env, advance } = await gateFixture(t);
  const first = await gate.screen(request());
  advance(SCREENING_DECISION_TTL_MS + 1);
  const later = await gate.screen(request());
  assert.equal(later.reused, false);
  assert.notEqual(later.decisionId, first.decisionId);
  assert.equal(fake.state.calls, 2);
  // A denylist change is a new policy version: the earlier clearance is not reused.
  env.CITY_PROTOCOL_SCREENING_DENY = B;
  const denied = await gate.screen(request());
  assert.deepEqual([denied.allowed, denied.reason, denied.reused], [false, 'denylisted', false]);
});

test('gate: outage, timeout, malformed, stale, unknown chain, no provider and bad input fail closed', async (t) => {
  const { gate, fake, setProvider, f } = await gateFixture(t, { timeoutMs: 20 });
  const expectClosed = async (reason: string, req = request()) => {
    const d = await gate.screen(req);
    assert.deepEqual(
      [d.allowed, d.outcome, d.decisionId, d.reason],
      [false, 'unavailable', null, reason],
      reason,
    );
  };
  fake.state.down = true;
  await expectClosed('provider_unavailable');
  fake.state.down = false;
  fake.state.hang = true;
  await expectClosed('timeout');
  fake.state.hang = false;
  fake.state.malformed = true;
  await expectClosed('malformed');
  fake.state.malformed = false;
  fake.state.stale = true;
  await expectClosed('stale');
  fake.state.stale = false;
  await expectClosed('unknown_chain', request({ chainId: 1 }));
  await expectClosed('invalid_request', request({ parties: [{ role: 'payee', address: 'nope' }] }));
  await expectClosed('invalid_request', request({ amountRaw: '-1' }));
  await expectClosed(
    'invalid_request',
    request({ parties: [{ role: 'owner' as never, address: A }] }),
  );
  setProvider(null);
  await expectClosed('not_configured');
  // Nothing undecided is stored; a later clear answer is a fresh decision.
  const [count] = await f.sql<{ n: number }>(
    'SELECT count(*)::int AS n FROM protocol_screening_decisions',
  );
  assert.equal(count?.n, 0);
});

test('gate: on Base mainnet the oracle is the one fixed in code; a test network needs it from the environment', () => {
  const client = async () => ({ readContract: async () => false }) as never;
  const constant = PROTOCOL_BASE_MAINNET.sanctionsOracle.toLowerCase();
  // Base mainnet: no setting needed, and a setting that disagrees is ignored (logged once).
  assert.equal(CHAIN_ID, PROTOCOL_BASE_MAINNET.chainId);
  assert.equal(
    sanctionsOracleFor({}, CHAIN_ID, client)?.ref,
    `sanctions-oracle:${CHAIN_ID}:${constant}`,
  );
  const lines: string[] = [];
  const other = getAddress(`0x${'5d'.repeat(20)}`);
  const env = { CITY_PROTOCOL_SCREENING_ORACLE: other };
  const ignored = sanctionsOracleFor(env, CHAIN_ID, client, { log: (line) => lines.push(line) });
  assert.equal(ignored?.ref, `sanctions-oracle:${CHAIN_ID}:${constant}`);
  sanctionsOracleFor(env, CHAIN_ID, client, { log: (line) => lines.push(line) });
  assert.equal(lines.length, 1, 'logged once');
  assert.deepEqual(JSON.parse(lines[0]!), {
    event: 'protocol.setting_ignored',
    setting: 'CITY_PROTOCOL_SCREENING_ORACLE',
    chainId: CHAIN_ID,
  });
  assert.ok(!lines[0]!.includes(other.toLowerCase()), 'the value is never logged');
  // A test network: only from the environment, no default.
  const sepolia = 84532;
  assert.equal(sanctionsOracleFor({}, sepolia, client), null);
  assert.equal(sanctionsOracleFor({ CITY_PROTOCOL_SCREENING_ORACLE: 'x' }, sepolia, client), null);
  const oracle = getAddress(`0x${'5c'.repeat(20)}`);
  const provider = sanctionsOracleFor({ CITY_PROTOCOL_SCREENING_ORACLE: oracle }, sepolia, client);
  assert.equal(provider?.ref, `sanctions-oracle:${sepolia}:${oracle.toLowerCase()}`);
  assert.equal(provider?.supports(sepolia), true);
  assert.equal(provider?.supports(CHAIN_ID), false);
});

test('gate: the oracle provider reads isSanctioned per address (a fake client, no network)', async () => {
  const listed = A.toLowerCase();
  const reads: string[] = [];
  const provider = sanctionsOracleFor(
    {},
    CHAIN_ID,
    async () =>
      ({
        readContract: async (call: { address: string; functionName: string; args: [string] }) => {
          assert.equal(call.address, PROTOCOL_BASE_MAINNET.sanctionsOracle);
          reads.push(call.functionName);
          return call.args[0].toLowerCase() === listed;
        },
      }) as never,
  )!;
  const answer = await provider.check({
    chainId: CHAIN_ID,
    addresses: [A.toLowerCase(), B.toLowerCase()],
    signal: new AbortController().signal,
  });
  assert.deepEqual(answer.listed, { [A.toLowerCase()]: true, [B.toLowerCase()]: false });
  assert.deepEqual(reads, ['isSanctioned', 'isSanctioned']);
});

test("screening off: a fee on top still needs the router's binding (its treasury and USDC); a right one is charged", async (t) => {
  const off = { ...FEES_ON, CITY_PROTOCOL_SCREENING: '0' };
  await t.test('another treasury holds the fee', async (t) => {
    const { f, fake } = await screened(t, off);
    const actual = getAddress(`0x${'b0'.repeat(20)}`);
    f.base.state.feeRouter = { router: ROUTER, treasury: actual };
    const callId = await payAndTryFee(f);
    const row = await feeRow(f, callId);
    assert.equal(row.fee_state, 'pending');
    assert.equal(row.fee_op_key, null, 'never submitted');
    assert.equal(row.fee_hold_reason, 'fee_recipient_mismatch');
    assert.equal(f.base.state.feeCharges.length, 0);
    assert.equal(f.base.balanceOf(actual), 0n);
    assert.equal(fake.state.calls, 0, 'nothing is screened while screening is off');
    assert.deepEqual(
      holdAlerts(f).map((a) => a.detail),
      ['fee_recipient_mismatch'],
    );
  });
  await t.test('another token holds the fee', async (t) => {
    const { f } = await screened(t, off);
    f.base.state.feeRouter = {
      router: ROUTER,
      treasury: TREASURY,
      token: getAddress(`0x${'d1'.repeat(20)}`),
    };
    const callId = await payAndTryFee(f);
    const row = await feeRow(f, callId);
    assert.equal(row.fee_state, 'pending');
    assert.equal(row.fee_hold_reason, 'fee_router_token_mismatch');
    assert.equal(f.base.state.feeCharges.length, 0);
  });
  await t.test(
    'an unreadable binding holds it; once read, it is charged at once, once',
    async (t) => {
      const { f, fake } = await screened(t, off);
      f.base.state.routerReadsDown = true;
      const callId = await payAndTryFee(f);
      assert.equal((await feeRow(f, callId)).fee_hold_reason, 'fee_recipient_unknown');
      assert.equal(f.base.state.feeCharges.length, 0);
      f.base.state.routerReadsDown = false;
      for (let i = 0; i < 6 && (await feeRow(f, callId)).fee_state !== 'charged'; i++) {
        f.advance(60_000);
        await f.cron();
      }
      const row = await feeRow(f, callId);
      assert.equal(row.fee_state, 'charged');
      assert.equal(row.fee_op_key, `feed-pay:fee:${callId}`);
      assert.equal(f.base.state.feeCharges.length, 1);
      assert.equal(f.base.balanceOf(TREASURY), 2000n);
      assert.equal(fake.state.calls, 0);
    },
  );
});

test('sanctions oracle: a failed read is asked again twice, then the error stands (fail closed)', async () => {
  const oracle = '0x40C57923924B5c5c5455c48D93317139ADDaC8fb' as const;
  const addr = '0x1111111111111111111111111111111111111111';
  let calls = 0;
  let failures = 2;
  const waits: number[] = [];
  const provider = sanctionsOracleProvider({
    chainId: CHAIN_ID,
    oracle,
    sleep: async (ms) => {
      waits.push(ms);
    },
    client: async () => ({
      readContract: (async () => {
        calls++;
        if (failures-- > 0) throw new Error('HTTP 429');
        return false;
      }) as never,
    }),
  });
  const answer = await provider.check({
    chainId: CHAIN_ID,
    addresses: [addr],
    signal: new AbortController().signal,
  } as never);
  assert.equal(answer.listed[addr], false);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 750]);

  // Always failing: three reads, then the error (the gate turns it into unavailable, not clear).
  calls = 0;
  failures = 99;
  await assert.rejects(
    provider.check({
      chainId: CHAIN_ID,
      addresses: [addr],
      signal: new AbortController().signal,
    } as never),
  );
  assert.equal(calls, 3);

  // The gate's deadline passed: no further try.
  calls = 0;
  failures = 99;
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    provider.check({ chainId: CHAIN_ID, addresses: [addr], signal: aborted.signal } as never),
  );
  assert.equal(calls, 1);
});
