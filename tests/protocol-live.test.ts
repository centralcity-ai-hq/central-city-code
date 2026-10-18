import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { feedEnabled } from '../server/feed/flag.js';
import { PROTOCOL_FEE_SCAN_PATH } from '../server/protocol/fees/cron.js';
import { screeningEnabled, type ScreeningProvider } from '../server/protocol/screening/gate.js';
import { FEED_PATHS } from '../shared/feed.js';
import { FEED_PAY_PATHS, feedPayEnabled } from '../shared/feed-pay.js';
import {
  EMERGENCY_OFF,
  liveUnlessOff,
  PROTOCOL_BASE_MAINNET,
  PROTOCOL_OFF_FLAGS,
} from '../shared/protocol.js';
import { json, PAY_TO, setup, withEnv } from './helpers/feed-pay-app.js';

/*
 * Operation Protocol live (docs/protocol/LIVE.md): with an empty environment the Feed, Feed pay for
 * every account, the 10% protocol fee, the fee ledger (scan and public metrics) and payment
 * screening all run, with Base mainnet's addresses fixed in code. Each keeps one emergency off: its
 * flag set to exactly '0'. Fake service, fake Base and fake screening provider only: nothing
 * reaches a network and nothing real is paid. Synthetic data.
 */

/** Every Operation Protocol setting, unset: the environment production needs. */
const EMPTY = {
  CITY_FEED: undefined,
  CITY_FEED_PAY: undefined,
  CITY_FEED_PAY_OPERATORS: undefined,
  CITY_PROTOCOL_FEES: undefined,
  CITY_PROTOCOL_SCREENING: undefined,
  CITY_PROTOCOL_CHAIN_ID: undefined,
  CITY_PROTOCOL_ROUTER: undefined,
  CITY_PROTOCOL_TREASURY: undefined,
  CITY_PROTOCOL_START_BLOCK: undefined,
  CITY_PROTOCOL_RPC_URL: undefined,
  CITY_PROTOCOL_SCREENING_ORACLE: undefined,
  CITY_PROTOCOL_SCREENING_DENY: undefined,
  // No RPC at all, so nothing can reach a network.
  CITY_BASE_CDP_RPC_URL: undefined,
  CITY_BASE_READ_FALLBACK_RPC_URL: undefined,
};

/** A screening provider that clears every address (a fake, never the network). */
function clearProvider(clock: () => number) {
  const asked: string[][] = [];
  const provider: ScreeningProvider = {
    ref: 'fake-oracle:live',
    supports: (chainId) => chainId === PROTOCOL_BASE_MAINNET.chainId,
    async check({ addresses }) {
      asked.push(addresses);
      return {
        listed: Object.fromEntries(addresses.map((address) => [address, false])),
        observedAt: clock(),
      };
    },
  };
  return { provider, asked };
}

test('one rule for every switch: live unless set to exactly 0', () => {
  assert.equal(EMERGENCY_OFF, '0');
  assert.deepEqual(Object.values(PROTOCOL_OFF_FLAGS), [
    'CITY_FEED',
    'CITY_FEED_PAY',
    'CITY_PROTOCOL_FEES',
    'CITY_PROTOCOL_SCREENING',
  ]);
  for (const flag of Object.values(PROTOCOL_OFF_FLAGS)) {
    assert.equal(liveUnlessOff({}, flag), true, `${flag} unset`);
    for (const value of ['1', 'true', 'on', 'off', 'false', '', ' 0', '00'])
      assert.equal(liveUnlessOff({ [flag]: value }, flag), true, `${flag}=${value}`);
    assert.equal(liveUnlessOff({ [flag]: '0' }, flag), false, `${flag}=0`);
  }
  assert.equal(feedEnabled({}), true);
  assert.equal(feedEnabled({ CITY_FEED: '0' }), false);
  assert.equal(feedPayEnabled({}), true);
  assert.equal(feedPayEnabled({ CITY_FEED_PAY: '0' }), false);
  assert.equal(screeningEnabled({}), true);
  assert.equal(screeningEnabled({ CITY_PROTOCOL_SCREENING: '0' }), false);
});

test('an empty environment: the Feed, the public fee metrics and the fee scan answer; each 0 turns its own off', async (t) => {
  withEnv(t, { ...EMPTY, CRON_SECRET: 'protocol-live-cron-secret-0001' });
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const feed = await app.inject(FEED_PATHS.status);
  assert.equal(feed.statusCode, 200, feed.body);
  const fees = await app.inject('/api/public/protocol/fees');
  assert.equal(fees.statusCode, 200, fees.body);
  const body = fees.json();
  assert.equal(body.chain_id, 8453);
  assert.equal(body.fee_rate, '0.10');
  assert.equal(body.totals.fees_usdc, '0.000000');
  // The scan cron is live too; without any RPC it reports unavailable (no crash).
  const scan = await app.inject({
    url: PROTOCOL_FEE_SCAN_PATH,
    headers: { authorization: 'Bearer protocol-live-cron-secret-0001' },
  });
  assert.equal(scan.statusCode, 503, scan.body);
  assert.deepEqual(scan.json(), { error: 'unavailable', reason: 'no_rpc' });
  // The emergency offs, read per request.
  process.env.CITY_PROTOCOL_FEES = '0';
  assert.equal((await app.inject('/api/public/protocol/fees')).statusCode, 404);
  assert.equal((await app.inject(FEED_PATHS.status)).statusCode, 200, 'the Feed is not affected');
  process.env.CITY_FEED = '0';
  assert.equal((await app.inject(FEED_PATHS.status)).statusCode, 404);
  delete process.env.CITY_FEED;
  delete process.env.CITY_PROTOCOL_FEES;
  assert.equal((await app.inject(FEED_PATHS.status)).statusCode, 200);
  assert.equal((await app.inject('/api/public/protocol/fees')).statusCode, 200);
});

test('Feed pay is open to any owner: an account nobody listed anywhere quotes and sees its agents', async (t) => {
  const f = await setup(t, { env: { ...EMPTY, CITY_PROTOCOL_FEES: '0' } });
  await f.list();
  const someone = await f.register('Any owner', 'Synthetic any owner password');
  const quote = await f.quote(undefined, undefined, someone.cookie);
  assert.equal(quote.statusCode, 200, quote.body);
  assert.equal(quote.json().payable, true, quote.body);
  const agents = await f.app.inject({
    url: FEED_PAY_PATHS.agents,
    headers: { ...json, cookie: someone.cookie },
  });
  assert.equal(agents.statusCode, 200, agents.body);
  // The old staging list is ignored: naming someone else changes nothing.
  process.env.CITY_FEED_PAY_OPERATORS = 'someone-else';
  assert.equal((await f.quote(undefined, undefined, someone.cookie)).statusCode, 200);
  // The emergency off stops everyone.
  process.env.CITY_FEED_PAY = '0';
  assert.equal((await f.quote(undefined, undefined, someone.cookie)).statusCode, 404);
  assert.equal((await f.quote()).statusCode, 404);
});

test('an empty environment pays end to end: screened, the price to the seller, 10% to the Base mainnet treasury through the router fixed in code', async (t) => {
  let fake: ReturnType<typeof clearProvider> | undefined;
  const f = await setup(t, { env: EMPTY, screeningProvider: () => fake!.provider });
  fake = clearProvider(f.clock);
  // The fake Base answers for the router and treasury fixed in code.
  f.base.state.feeRouter = {
    router: PROTOCOL_BASE_MAINNET.feeRouter,
    treasury: PROTOCOL_BASE_MAINNET.treasury,
  };
  await f.list();
  await f.limit();
  const quote = (await f.quote()).json();
  assert.equal(quote.protocolFee.raw, '2000');
  assert.equal(quote.total.raw, '22000');
  const paid = await f.pay();
  assert.equal(paid.statusCode, 200, paid.body);
  const callId = paid.json().callId as string;
  const call = await f.settled(callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call.failure));
  for (let i = 0; i < 6; i++) {
    const now = (await f.status(callId)).json();
    if (now.protocolFee?.state === 'charged') break;
    f.advance(60_000);
    assert.equal((await f.cron()).statusCode, 200);
  }
  const done = (await f.status(callId)).json();
  assert.equal(done.protocolFee.state, 'charged', JSON.stringify(done.protocolFee));
  assert.equal(f.base.balanceOf(PAY_TO), 20000n, 'the seller got exactly the price');
  assert.equal(f.base.balanceOf(PROTOCOL_BASE_MAINNET.treasury), 2000n, 'the treasury got 10%');
  const [row] = await f.sql<{ fee_router: string }>(
    'SELECT fee_router FROM feed_pay_calls WHERE call_id = $1',
    [callId],
  );
  assert.equal(row?.fee_router, PROTOCOL_BASE_MAINNET.feeRouter.toLowerCase());
  // Screened: the seller leg and the fee leg (to the router's own treasury) were asked.
  const decisions = await f.sql<{ intent_id: string; outcome: string }>(
    'SELECT intent_id, outcome FROM protocol_screening_decisions',
  );
  assert.ok(decisions.some((d) => d.intent_id === `feed-pay:${callId}` && d.outcome === 'allowed'));
  assert.ok(
    decisions.some((d) => d.intent_id === `feed-pay:fee:${callId}` && d.outcome === 'allowed'),
  );
  assert.ok(
    fake.asked.flat().includes(PROTOCOL_BASE_MAINNET.treasury.toLowerCase()),
    'the treasury was screened',
  );
});

test('screening is on by default and fails closed: no provider, no new payment', async (t) => {
  const f = await setup(t, {
    env: { ...EMPTY, CITY_PROTOCOL_FEES: '0' },
    screeningProvider: () => null,
  });
  await f.list();
  await f.limit();
  const paid = await f.pay();
  assert.equal(paid.statusCode, 200, paid.body);
  const call = await f.settled(paid.json().callId);
  assert.equal(call.state, 'refused');
  assert.equal(call.failure?.code, 'screening_unavailable');
  assert.equal(call.payment, null);
  assert.equal(f.base.state.signatures, 0, 'nothing was signed');
  assert.equal(f.base.balanceOf(PAY_TO), 0n);
  // Switched off with 0: the same call is paid without screening.
  process.env.CITY_PROTOCOL_SCREENING = '0';
  const again = await f.pay();
  const paidCall = await f.settled(again.json().callId);
  assert.equal(paidCall.state, 'result_saved', JSON.stringify(paidCall.failure));
  assert.equal(f.base.balanceOf(PAY_TO), 20000n);
});
