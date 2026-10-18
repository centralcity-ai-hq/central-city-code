import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createPublicClient,
  custom,
  encodeErrorResult,
  getAddress,
  parseAbi,
  type Hex,
  type PublicClient,
} from 'viem';
import { createFeedPayChain } from '../server/base/chain/feed-pay-chain.js';
import type { Database } from '../server/database.js';
import { LIMIT_PERMISSION_END, nextBerlinMidnight } from '../shared/base/spend-limits.js';
import type { SpendPermission } from '../shared/base/types.js';
import { FEED_PAY_ERRORS, type FeedPayAgent } from '../shared/feed-pay.js';
import { WALLET_NET } from './wallet-network-fixture.js';
import { fullFlow, mcpCall, rpcResult } from './oauth-helpers.js';
import { BODY, setup, SVC, type FeedPayApp } from './helpers/feed-pay-app.js';

/*
 * Feed pay with a spending limit that hasn't started yet. A limit signed before 14 Oct 2026 starts
 * on Base at the next 00:00 Berlin after it was signed (new limits start at 00:00 Berlin that day,
 * tests/feed-pay-limit-now.test.ts); until then SpendPermissionManager.getCurrentPeriod
 * reverts. That is no failure of Base: the agents list says when the limit starts, and a call is
 * refused with 409 limit_not_started and its start (never 503 "unavailable", which the page reads
 * as "can't tell whether the payment started"). Nothing is stored, signed or sent.
 * The app fixture runs the real routes, engine, chain side and MCP tool on PGlite against a fake
 * x402 service and a fake Base: nothing reaches a network. Synthetic data only.
 */

// ---------------------------------------------------------------------------------------------
// The chain side: allowanceLeft says the window, a window revert is no failure

const START = 1_792_015_200;
const errors = parseAbi([
  'error BeforeSpendPermissionStart(uint48 currentTimestamp, uint48 start)',
  'error AfterSpendPermissionEnd(uint48 currentTimestamp, uint48 end)',
  'error SomethingElse()',
]);

const permission = (overrides: Partial<SpendPermission> = {}): SpendPermission => ({
  account: getAddress(`0x${'1'.repeat(40)}`),
  spender: getAddress(`0x${'3'.repeat(40)}`),
  token: getAddress(WALLET_NET.tokens.USDC.address),
  allowance: 5_000_000n,
  period: 86_400,
  start: START,
  end: LIMIT_PERMISSION_END,
  salt: 7n,
  extraData: '0x',
  ...overrides,
});

/**
 * The chain side over a viem client whose node answers eth_call with `answer` (a revert's data, a
 * transport failure, or a period), as a real node would. Counts the eth_calls.
 */
function chainWith(nowS: number, answer: () => Hex | Error) {
  let calls = 0;
  const client = createPublicClient({
    transport: custom(
      {
        async request({ method }: { method: string }) {
          if (method === 'eth_chainId') return `0x${WALLET_NET.chainId.toString(16)}`;
          if (method !== 'eth_call') throw new Error(`no ${method}`);
          calls++;
          const out = answer();
          if (out instanceof Error) throw out;
          return out;
        },
      },
      { retryCount: 0 },
    ),
  }) as PublicClient;
  const chain = createFeedPayChain({
    network: WALLET_NET,
    client,
    db: {} as Database,
    operations: {} as never,
    bundler: {} as never,
    keystore: {} as never,
    signerOf: async () => getAddress(`0x${'3'.repeat(40)}`),
    ledger: {} as never,
    usdcBalance: async () => ({ balance: 0n, blockNumber: 1n }),
    authorizations: {} as never,
    now: () => nowS * 1000,
  });
  return { chain, calls: () => calls };
}

/** A node's revert of eth_call with this error data (JSON-RPC code 3). */
function reverted(data: Hex) {
  return Object.assign(new Error('execution reverted'), { code: 3, data });
}

test('allowanceLeft: before the start it says so from the clock, without a read', async () => {
  const { chain, calls } = chainWith(START - 3_600, () => {
    throw new Error('not read');
  });
  assert.deepEqual(await chain.allowanceLeft(permission()), {
    phase: 'before_start',
    startsAt: START,
  });
  assert.equal(calls(), 0);
  // From its end on, the same: no read.
  const ended = chainWith(START + 10, () => {
    throw new Error('not read');
  });
  assert.deepEqual(await ended.chain.allowanceLeft(permission({ end: START + 5 })), {
    phase: 'after_end',
    endedAt: START + 5,
  });
  assert.equal(ended.calls(), 0);
});

test('allowanceLeft: a window revert from Base (its clock behind ours) reads as the window', async () => {
  // Our clock is past the start, Base's latest block is not: getCurrentPeriod reverts.
  const before = chainWith(START + 2, () =>
    reverted(
      encodeErrorResult({
        abi: errors,
        errorName: 'BeforeSpendPermissionStart',
        args: [START - 1, START],
      }),
    ),
  );
  assert.deepEqual(await before.chain.allowanceLeft(permission()), {
    phase: 'before_start',
    startsAt: START,
  });
  assert.equal(before.calls(), 1);
  const after = chainWith(START + 2, () =>
    reverted(
      encodeErrorResult({
        abi: errors,
        errorName: 'AfterSpendPermissionEnd',
        args: [START + 9, START + 9],
      }),
    ),
  );
  assert.deepEqual(await after.chain.allowanceLeft(permission({ end: START + 9 })), {
    phase: 'after_end',
    endedAt: START + 9,
  });
  // Any other revert, or a node that can't answer, is still a failure (never zeros).
  const other = chainWith(START + 2, () =>
    reverted(encodeErrorResult({ abi: errors, errorName: 'SomethingElse' })),
  );
  await assert.rejects(other.chain.allowanceLeft(permission()));
  const down = chainWith(START + 2, () => new Error('connection refused'));
  await assert.rejects(down.chain.allowanceLeft(permission()));
});

test('allowanceLeft: inside the window, what is left and when the period ends', async () => {
  const { chain } = chainWith(
    START + 100,
    () =>
      // getCurrentPeriod's (uint48 start, uint48 end, uint160 spend): 1.5 USDC spent.
      `0x${[START, START + 86_400, 1_500_000]
        .map((value) => value.toString(16).padStart(64, '0'))
        .join('')}`,
  );
  assert.deepEqual(await chain.allowanceLeft(permission()), {
    phase: 'active',
    left: 3_500_000n,
    periodEnd: START + 86_400,
  });
});

// ---------------------------------------------------------------------------------------------
// The engine: the agents list and the call

/** The next 00:00 in Berlin after the fixture's clock, as limits signed before 14 Oct 2026 start. */
const nextStart = (f: FeedPayApp) => nextBerlinMidnight(f.clock());

async function agentOf(f: FeedPayApp): Promise<FeedPayAgent> {
  const res = await f.agents();
  assert.equal(res.statusCode, 200, res.body);
  const agent = (res.json().agents as FeedPayAgent[]).find((a) => a.agentId === f.agentId);
  assert.ok(agent);
  return agent;
}

async function nothingStored(f: FeedPayApp) {
  const [calls] = await f.sql<{ n: string }>('SELECT count(*)::text AS n FROM feed_pay_calls');
  const [payments] = await f.sql<{ n: string }>('SELECT count(*)::text AS n FROM base_payments');
  const [moves] = await f.sql<{ n: string }>(
    'SELECT count(*)::text AS n FROM feed_pay_float_moves',
  );
  assert.deepEqual([calls!.n, payments!.n, moves!.n], ['0', '0', '0']);
  assert.equal(f.base.state.signatures, 0, 'nothing signed');
  assert.equal(f.base.state.sends.length, 0, 'nothing sent to Base');
  assert.equal(f.service.paid().length, 0, 'nothing paid');
}

test('a limit that starts later: the agent is not ready and says when it starts', async (t) => {
  const f = await setup(t);
  await f.list();
  const start = nextStart(f);
  await f.limit(undefined, { start });
  const agent = await agentOf(f);
  assert.equal(agent.hasLimit, true);
  assert.equal(agent.ready, false);
  assert.equal(agent.notReady, 'limit_not_started');
  assert.equal(agent.limitStartsAt, new Date(start * 1000).toISOString());
  assert.equal(agent.limitLeftRaw, null);

  // Base can't be read: the clock still says the limit hasn't started.
  f.base.state.down = true;
  const offline = await agentOf(f);
  assert.equal(offline.notReady, 'limit_not_started');
  assert.equal(offline.limitStartsAt, agent.limitStartsAt);
  f.base.state.down = false;

  // From its start on, it is an ordinary limit.
  f.advance((start - Math.floor(f.clock() / 1000) + 60) * 1000);
  const started = await agentOf(f);
  assert.equal(started.ready, true);
  assert.equal(started.notReady, null);
  assert.equal(started.limitStartsAt, null);
  assert.equal(started.limitLeftRaw, '5000000');
});

test('a call on a limit that starts later: 409 limit_not_started, nothing stored or paid', async (t) => {
  const f = await setup(t);
  await f.list();
  const start = nextStart(f);
  await f.limit(undefined, { start });
  const q = await f.quote();
  assert.equal(q.statusCode, 200, q.body);
  const probes = f.service.requests.length;
  const body = {
    agentId: f.agentId,
    inputs: BODY,
    quoteId: q.json().quoteId as string,
    maxAmountRaw: q.json().amount.raw as string,
    idempotencyKey: randomUUID(),
  };
  const res = await f.callService(body);
  assert.equal(res.statusCode, FEED_PAY_ERRORS.limit_not_started, res.body);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), {
    error: "This agent's spending limit hasn't started yet.",
    code: 'limit_not_started',
    retryable: false,
    startsAt: new Date(start * 1000).toISOString(),
  });
  assert.equal(f.service.requests.length, probes, 'the service was not asked');
  await nothingStored(f);
  // The same key again: the same refusal (no call was stored under it).
  const again = await f.callService(body);
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().code, 'limit_not_started');
  await nothingStored(f);
});

test('Base still before the start while our clock is past it: the same 409, never 503', async (t) => {
  const f = await setup(t);
  await f.list();
  const start = Math.floor(f.clock() / 1000) + 60;
  await f.limit(undefined, { start });
  const q = await f.quote();
  assert.equal(q.statusCode, 200, q.body);
  // Our clock is now past the start (the quote moved it); Base's latest block is still before it,
  // so getCurrentPeriod reverts with BeforeSpendPermissionStart.
  f.advance(60_000);
  f.base.state.nodeBehindS = 600;
  const listed = await agentOf(f);
  assert.equal(listed.notReady, 'limit_not_started');
  assert.equal(listed.limitStartsAt, new Date(start * 1000).toISOString());
  const res = await f.callService({
    agentId: f.agentId,
    inputs: BODY,
    quoteId: q.json().quoteId,
    maxAmountRaw: q.json().amount.raw,
    idempotencyKey: randomUUID(),
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, 'limit_not_started');
  assert.equal(res.json().startsAt, new Date(start * 1000).toISOString());
  await nothingStored(f);
  // Base catches up: the call pays.
  f.base.state.nodeBehindS = 0;
  const paid = await f.pay();
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal((await f.settled(paid.json().callId)).state, 'result_saved');
});

test('city_service_call on a limit that starts later: a clear refusal with the start', async (t) => {
  const f = await setup(t);
  await f.list();
  const start = nextStart(f);
  const permission = await f.limit(undefined, { start });
  assert.equal((await f.consent(permission.hash)).statusCode, 200);
  const args = () => ({
    service_id: SVC,
    agent_id: f.agentId,
    inputs: BODY,
    max_price_usdc: '0.05',
    idempotency_key: randomUUID(),
  });
  const startsAt = new Date(start * 1000).toISOString();
  const message = `The agent's spending limit starts at ${startsAt}. Call again from then.`;
  const res = await f.tool(f.main.token, 'city_service_call', args());
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, 'limit_not_started');
  assert.equal(res.json().error, message);
  // Over MCP: the refusal carries the start in its details.
  const oauth = await fullFlow(f.app, {
    scope: 'workspace:read pay services:pay',
    scopes: ['pay', 'services:pay'],
  });
  const over = rpcResult(
    (
      await mcpCall(f.app, oauth.tokens.access_token, 'tools/call', {
        name: 'city_service_call',
        arguments: args(),
      })
    ).body,
  ).result;
  assert.equal(over.isError, true);
  const error = JSON.parse(over.content[0].text).error;
  assert.equal(error.code, 'limit_not_started');
  assert.equal(error.message, message);
  assert.equal(error.retryable, false);
  assert.deepEqual(error.details, { starts_at: startsAt });
  await nothingStored(f);
});
