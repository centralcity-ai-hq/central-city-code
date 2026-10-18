import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getAddress, HttpRequestError } from 'viem';
import { BundlerError, bundlerRejection, SponsorError } from '../server/base/chain/rpc-bundler.js';
import { feedServiceId } from '../server/feed/bazaar.js';
import { HOSTED_SOURCE } from '../server/feed/types.js';
import {
  FEED_PAY_PAY_RETRY,
  FEED_PAY_RECOVER_GRACE_MS,
  feedPayKey,
} from '../server/feed/pay/engine.js';
import { offerInputSummary, offerOutputSummary } from '../shared/feed-offers.js';
import type { FeedPayCall } from '../shared/feed-pay.js';
import { PROTOCOL_BASE_MAINNET } from '../shared/protocol.js';
import { setup, type FeedPayApp } from './helpers/feed-pay-app.js';

/*
 * Feed pay: a fee-included payment (a service sold by a Central City agent, paid in one
 * router.pay operation) that the bundler, the paymaster or the node read preparing it refused ONLY
 * for its rate (HTTP 429, or a 'busy' answer) and that provably never left the server is planned
 * again under a new operation key after the provider's Retry-After and a backoff, at most three
 * times within ten minutes and only when it is due while the worker that plans it still runs.
 * Every other refusal ends the call at once as before; an operation that may have gone out is only
 * reconciled. The router charges each (payer, ref) once, so the price is never paid twice. The real
 * app, engine and chain side over a fake Base (tests/helpers/feed-pay-fake-base.ts). Synthetic
 * data only; nothing reaches a network.
 */

const ROUTER = PROTOCOL_BASE_MAINNET.feeRouter;
const TREASURY = PROTOCOL_BASE_MAINNET.treasury;
const SELLER = getAddress(`0x${'5e'.repeat(20)}`);
const ORIGIN = 'https://centralcity.ai';
const HELLO = { body: { text: 'hello' } };

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
let offerSeq = 0;
function newOfferId(): string {
  let n = ++offerSeq + 4_000;
  let tail = '';
  for (let i = 0; i < 16; i++) {
    tail = BASE32[n % 32] + tail;
    n = Math.floor(n / 32);
  }
  return `off_${tail}`;
}

/**
 * The engine's JSON log lines, by event. `stopAfterPlan`: the worker stops right after its first
 * payment re-plan is stored (as a server that goes away), so the call waits without a worker.
 */
function captureLog(t: test.TestContext, { stopAfterPlan = false } = {}) {
  const lines: Record<string, unknown>[] = [];
  let stopped = false;
  t.mock.method(console, 'info', (line: unknown) => {
    if (typeof line !== 'string' || !line.startsWith('{')) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    lines.push(parsed);
    if (stopAfterPlan && !stopped && parsed.event === 'feed_pay.pay_retry_planned') {
      stopped = true;
      throw new Error('the worker stopped');
    }
  });
  return (event: string) => lines.filter((line) => line.event === event);
}

/** Protocol fees on, a limit, and one listed service of a seller agent ($0.05, fee included). */
async function ready(t: test.TestContext) {
  const f = await setup(t, { env: { CITY_PROTOCOL_FEES: undefined } });
  f.base.state.feeRouter = { router: ROUTER, treasury: TREASURY };
  await f.limit();
  const offerId = newOfferId();
  const url = `${ORIGIN}/api/public/x402/${offerId}`;
  const id = feedServiceId(url);
  const at = f.clock();
  await f.sql(
    `INSERT INTO city_offers (offer_id, operator_id, agent_id, wallet_id, pay_to, kind, title,
       description, tags, price_raw, discoverable, version, state, idem_key, risky,
       price_changed_at, created_at, updated_at)
     VALUES ($1, 'op-seller', 'agent-seller', 'wallet-seller', $2, 'hash', 'Text hash',
       'The SHA-256 of a text.', '{}', '50000', true, 1, 'active', $1, NULL, $3, $3, $3)`,
    [offerId, SELLER, at],
  );
  await f.sql(
    `INSERT INTO feed_services (id, source, record_id, host, url, title, description, capabilities,
       provider_name, method, x402_version, scheme, price_raw, pay_to, input, output,
       paid_calls_30d, payers_30d, last_called_at, source_updated_at, fetched_at, first_seen_at,
       last_seen_at, last_seen_sweep, missed_sweeps, withdrawn_at, risky, hidden, search_text,
       seller_key)
     VALUES ($1, $2, $3, 'centralcity.ai', $4, 'Text hash', 'The SHA-256 of a text.', '{}',
       'Synthetic seller', 'POST', 2, 'exact', '50000', $5, $6::jsonb, $7::jsonb, NULL, NULL, NULL,
       $8, $8, $8, $8, 0, 0, NULL, NULL, false, 'text hash', $9)`,
    [
      id,
      HOSTED_SOURCE,
      `cc:${offerId}`,
      url,
      SELLER,
      JSON.stringify(offerInputSummary('hash')),
      JSON.stringify(offerOutputSummary('hash')),
      at,
      SELLER.toLowerCase(),
    ],
  );
  return { f, serviceId: id };
}

/** Quote then confirm, as the Feed page does; `again` repeats the same key (follows the call). */
async function start(f: FeedPayApp, serviceId: string) {
  const q = await f.quote(HELLO, serviceId);
  assert.equal(q.statusCode, 200, q.body);
  assert.equal(q.json().feeIncluded, true, q.body);
  const body = {
    agentId: f.agentId,
    inputs: HELLO,
    quoteId: q.json().quoteId,
    maxAmountRaw: q.json().amount.raw,
    maxTotalRaw: q.json().total.raw,
    idempotencyKey: randomUUID(),
  };
  const res = await f.callService(body, serviceId);
  assert.equal(res.statusCode, 200, res.body);
  const again = () => f.callService(body, serviceId);
  return { callId: res.json().callId as string, again };
}

interface CallState {
  state: string;
  failure_code: string | null;
  payment_state: string | null;
  fee_state: string | null;
  fee_op_key: string | null;
  pay_attempts: number;
  pay_retry_at: string | null;
  topup_attempts: number;
  lease_until: string;
  updated_at: string;
}

const callRow = async (f: FeedPayApp, callId: string) =>
  (
    await f.sql<CallState>(
      `SELECT state, failure_code, payment_state, fee_state, fee_op_key, pay_attempts,
         pay_retry_at::text AS pay_retry_at, topup_attempts, lease_until::text AS lease_until,
         updated_at::text AS updated_at
       FROM feed_pay_calls WHERE call_id = $1`,
      [callId],
    )
  )[0]!;

/** The call's payment operations, oldest attempt first. */
const payOps = async (f: FeedPayApp, callId: string) =>
  (
    await f.sql<{
      idempotency_key: string;
      status: string;
      error_code: string | null;
      signed: number | null;
    }>(
      `SELECT idempotency_key, status, error_code, octet_length(signed_operation) AS signed
       FROM base_chain_ops WHERE kind = 'protocol_fee' AND idempotency_key LIKE $1`,
      [`feed-pay:pay:${callId}%`],
    )
  ).sort((a, b) => a.idempotency_key.length - b.idempotency_key.length);

const basePayment = async (f: FeedPayApp, callId: string) =>
  (
    await f.sql<{ state: string }>(
      `SELECT p.state FROM base_payments p JOIN feed_pay_calls c ON c.payment_id = p.payment_id
       WHERE c.call_id = $1`,
      [callId],
    )
  )[0]!.state;

/** Waits (yielding to the background worker) until it no longer holds the call, or it is done. */
async function workerGone(f: FeedPayApp, callId: string) {
  for (let i = 0; i < 4_000; i++) {
    const row = await callRow(f, callId);
    if (row.lease_until === '0' || ['result_saved', 'refused', 'cancelled'].includes(row.state))
      return row;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('the worker still holds the call');
}

const pays = (f: FeedPayApp) => f.base.state.effects.filter((effect) => effect === 'pay');

/** Asserts the call was paid exactly once, by the operation of `attempt`, and delivered. */
async function paidOnceBy(f: FeedPayApp, callId: string, attempt: number) {
  const row = await callRow(f, callId);
  assert.equal(row.state, 'result_saved', JSON.stringify(row));
  assert.equal(row.payment_state, 'settled');
  assert.equal(row.fee_state, 'charged');
  assert.equal(row.pay_attempts, attempt);
  assert.equal(row.pay_retry_at, null);
  assert.equal(row.fee_op_key, feedPayKey(callId, attempt));
  assert.equal(f.base.state.feeCharges.length, 1, 'a single FeeCharged');
  assert.equal(pays(f).length, 1, 'the price moved once');
  assert.equal(await basePayment(f, callId), 'paid');
}

test('a 429 then success: one re-plan under a new key, the old op never sent, paid once', async (t) => {
  const { f, serviceId } = await ready(t);
  const log = captureLog(t);
  f.base.state.rateLimit = { left: 1, retryAfter: '2', at: 'prepare', feeOnly: true };
  const { callId } = await start(f, serviceId);
  const call = await f.settled(callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  await paidOnceBy(f, callId, 1);

  const ops = await payOps(f, callId);
  assert.deepEqual(
    ops.map((op) => op.idempotency_key),
    [feedPayKey(callId, 0), feedPayKey(callId, 1)],
  );
  // The old payment: a never-broadcast tombstone, nothing ever signed or stored for it.
  assert.equal(ops[0]!.status, 'failed');
  assert.equal(ops[0]!.error_code, 'ABANDONED_BEFORE_BROADCAST');
  assert.equal(Number(ops[0]!.signed), 0);
  assert.equal(ops[1]!.status, 'final');
  // Planned no earlier than the backoff (the provider asked for 2 s only).
  assert.deepEqual(log('feed_pay.pay_retry_planned'), [
    { event: 'feed_pay.pay_retry_planned', callId, attempt: 1, waitMs: 30_000 },
  ]);
  assert.deepEqual(log('feed_pay.pay_retry_exhausted'), []);
  const failed = log('feed_pay.included_send_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.detail, 'rate_limited');
});

test('a busy -32002 answer inside an HTTP 200, then success: re-planned, paid once', async (t) => {
  const { f, serviceId } = await ready(t);
  const log = captureLog(t);
  f.base.state.rateLimit = { left: 1, retryAfter: null, at: 'prepare', feeOnly: true, busy: true };
  const { callId } = await start(f, serviceId);
  const call = await f.settled(callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  await paidOnceBy(f, callId, 1);
  const ops = await payOps(f, callId);
  assert.equal(ops.length, 2);
  assert.equal(ops[0]!.error_code, 'ABANDONED_BEFORE_BROADCAST');
  assert.deepEqual(
    log('feed_pay.pay_retry_planned').map((line) => [line.attempt, line.waitMs]),
    [[1, 30_000]],
  );
});

test('a 429 of the node read that prepares the payment (rate_limited,nonce): re-planned', async (t) => {
  const { f, serviceId } = await ready(t);
  const log = captureLog(t);
  // As viem throws it: a contract read (getNonce) wrapping the endpoint's HTTP 429.
  const http = new HttpRequestError({
    status: 429,
    url: 'https://node.invalid/',
    headers: new Headers({ 'retry-after': '45' }),
  });
  f.base.state.feePrepareErrors = [
    Object.assign(new Error('getNonce: HTTP request failed. Status: 429'), { cause: http }),
  ];
  const { callId } = await start(f, serviceId);
  const call = await f.settled(callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  await paidOnceBy(f, callId, 1);
  assert.equal(log('feed_pay.included_send_failed')[0]!.detail, 'rate_limited,nonce');
  // Never earlier than the provider's Retry-After (45 s, longer than the first backoff).
  assert.deepEqual(
    log('feed_pay.pay_retry_planned').map((line) => line.waitMs),
    [45_000],
  );
});

test('four rate limits in a row: re-plans while they fit, then the call ends with nothing paid', async (t) => {
  const { f, serviceId } = await ready(t);
  const log = captureLog(t);
  f.base.state.rateLimit = { left: 4, retryAfter: null, at: 'prepare', feeOnly: true };
  const { callId, again } = await start(f, serviceId);
  // The caller follows its call each time the request's work has ended.
  for (let i = 0; i < 6; i++) {
    const row = await workerGone(f, callId);
    if (row.state === 'refused' || row.state === 'result_saved') break;
    assert.equal(row.state, 'reserved');
    f.advance(Math.max(Number(row.pay_retry_at) - f.clock(), 0));
    assert.equal((await again()).statusCode, 200);
  }
  const row = await callRow(f, callId);
  assert.equal(row.state, 'refused');
  assert.equal(row.failure_code, 'interrupted', 'as a payment that never went out ends today');
  assert.equal(row.fee_state, 'not_owed');
  // The third backoff (180 s) is longer than a worker's whole budget (150 s): never planned.
  assert.equal(row.pay_attempts, 2);
  const ops = await payOps(f, callId);
  assert.equal(ops.length, 3);
  for (const op of ops) {
    assert.equal(op.status, 'failed');
    assert.equal(op.error_code, 'ABANDONED_BEFORE_BROADCAST');
  }
  assert.equal(f.base.state.feeCharges.length, 0, 'nothing was ever charged');
  assert.equal(pays(f).length, 0);
  assert.equal(await basePayment(f, callId), 'failed');
  assert.deepEqual(
    log('feed_pay.pay_retry_planned').map((line) => [line.attempt, line.waitMs]),
    [
      [1, 30_000],
      [2, 90_000],
    ],
  );
  assert.deepEqual(log('feed_pay.pay_retry_exhausted'), [
    { event: 'feed_pay.pay_retry_exhausted', callId, attempts: 2, reason: 'budget' },
  ]);
});

test('three re-plans used: the next rate limit ends the call, attempts exhausted', async (t) => {
  const { f, serviceId } = await ready(t);
  const log = captureLog(t, { stopAfterPlan: true });
  f.base.state.rateLimit = { left: 1, retryAfter: null, at: 'prepare', feeOnly: true };
  const { callId, again } = await start(f, serviceId);
  const waiting = await workerGone(f, callId);
  assert.equal(waiting.state, 'reserved');
  assert.equal(waiting.pay_attempts, 1);
  // As if two more re-plans had been made (the cap the column allows).
  await f.sql('UPDATE feed_pay_calls SET pay_attempts = 3 WHERE call_id = $1', [callId]);
  await assert.rejects(
    f.sql('UPDATE feed_pay_calls SET pay_attempts = 4 WHERE call_id = $1', [callId]),
    'the column never holds more than three',
  );
  f.base.state.rateLimit = { left: 1, retryAfter: null, at: 'prepare', feeOnly: true };
  f.advance(Number(waiting.pay_retry_at) - f.clock() + 1);
  assert.equal((await again()).statusCode, 200);
  const row = await workerGone(f, callId);
  assert.equal(row.state, 'refused');
  assert.equal(row.failure_code, 'interrupted');
  assert.equal(row.pay_attempts, 3);
  assert.deepEqual(
    (await payOps(f, callId)).map((op) => [op.idempotency_key, op.error_code]),
    [
      [feedPayKey(callId, 0), 'ABANDONED_BEFORE_BROADCAST'],
      [feedPayKey(callId, 3), 'ABANDONED_BEFORE_BROADCAST'],
    ],
  );
  assert.deepEqual(log('feed_pay.pay_retry_exhausted'), [
    { event: 'feed_pay.pay_retry_exhausted', callId, attempts: 3, reason: 'attempts' },
  ]);
  assert.equal(f.base.state.feeCharges.length, 0);
});

test('any other refusal ends the call at once, as before: no re-plan', async (t) => {
  const { f, serviceId } = await ready(t);
  const log = captureLog(t);
  const refusals: Error[] = [
    new SponsorError(
      bundlerRejection('pm_getPaymasterStubData', {
        code: -32002,
        message: 'max spend limit exceeded for policy',
      }),
    ),
    new SponsorError(
      bundlerRejection('pm_getPaymasterData', {
        code: -32603,
        message: 'not in allowlist: 0x12345678',
      }),
    ),
    bundlerRejection('eth_estimateUserOperationGas', {
      code: -32500,
      message: "AA21 didn't pay prefund",
    }),
    new SponsorError(
      new BundlerError(
        'RPC_UNAVAILABLE',
        'pm_getPaymasterStubData: HTTP 500.',
        undefined,
        undefined,
        500,
        5_000,
      ),
    ),
    // Text alone is not data: a plain error that says 429 is not a rate limit.
    new Error('HTTP 429: rate limited'),
  ];
  for (const refusal of refusals) {
    f.base.state.feePrepareErrors = [refusal];
    const { callId } = await start(f, serviceId);
    const call: FeedPayCall = await f.settled(callId);
    assert.equal(call.state, 'refused', refusal.message);
    const row = await callRow(f, callId);
    assert.equal(row.failure_code, 'interrupted', refusal.message);
    assert.equal(row.pay_attempts, 0);
    assert.equal((await payOps(f, callId)).length, 1);
  }
  assert.deepEqual(log('feed_pay.pay_retry_planned'), []);
  assert.deepEqual(log('feed_pay.pay_retry_exhausted'), []);
  assert.equal(f.base.state.feeCharges.length, 0);
});

test('STOP during the wait: no re-plan, the call ends as today’s refusal', async (t) => {
  const { f, serviceId } = await ready(t);
  captureLog(t, { stopAfterPlan: true });
  f.base.state.rateLimit = { left: 1, retryAfter: '60', at: 'prepare', feeOnly: true };
  const { callId, again } = await start(f, serviceId);
  const waiting = await workerGone(f, callId);
  assert.equal(waiting.state, 'reserved');
  assert.equal(waiting.payment_state, null);
  assert.equal(waiting.fee_state, 'pending');
  assert.equal(waiting.fee_op_key, null);
  assert.equal(await basePayment(f, callId), 'created');
  const due = Number(waiting.pay_retry_at);
  await f.sql(
    `UPDATE workspaces SET data = jsonb_set(data, '{paused}', 'true'::jsonb)
     WHERE operator_id = $1`,
    [f.owner.id],
  );
  assert.equal((await again()).statusCode, 200);
  const row = await workerGone(f, callId);
  assert.equal(row.state, 'refused');
  assert.equal(row.failure_code, 'limit_changed', 'as a paused workspace ends a call today');
  assert.equal(row.fee_state, 'not_owed');
  assert.ok(Number(row.updated_at) < due, 'ended during the wait, not at its end');
  assert.equal((await payOps(f, callId)).length, 1);
  assert.equal(f.base.state.feeCharges.length, 0);
});

test('neither a worker nor the cron plans before pay_retry_at; the cron never plans one', async (t) => {
  const { f, serviceId } = await ready(t);
  captureLog(t, { stopAfterPlan: true });
  f.base.state.rateLimit = { left: 1, retryAfter: '60', at: 'prepare', feeOnly: true };
  const { callId } = await start(f, serviceId);
  const waiting = await workerGone(f, callId);
  const due = Number(waiting.pay_retry_at);
  for (const at of [due - 1_000, due + FEED_PAY_RECOVER_GRACE_MS - 15_000]) {
    f.advance(at - f.clock());
    assert.equal((await f.cron()).statusCode, 200);
    const row = await callRow(f, callId);
    assert.equal(row.state, 'reserved');
    assert.equal((await payOps(f, callId)).length, 1);
  }
  // Past its time and the grace, without a worker: ended as any interrupted call, no new payment.
  f.advance(due + FEED_PAY_RECOVER_GRACE_MS + 1_000 - f.clock());
  assert.equal((await f.cron()).statusCode, 200);
  const row = await callRow(f, callId);
  assert.equal(row.state, 'refused');
  assert.equal(row.failure_code, 'interrupted');
  assert.equal((await payOps(f, callId)).length, 1);
  assert.equal(f.base.state.feeCharges.length, 0);
});

test('a Retry-After over five minutes, or due after the worker stops: ends at once', async (t) => {
  for (const [retryAfter, reason] of [
    ['900', 'retry_after'],
    ['240', 'budget'],
  ] as const) {
    await t.test(reason, async (t) => {
      const { f, serviceId } = await ready(t);
      const log = captureLog(t);
      f.base.state.rateLimit = { left: 1, retryAfter, at: 'prepare', feeOnly: true };
      const { callId, again } = await start(f, serviceId);
      const row = await workerGone(f, callId);
      assert.equal(row.state, 'refused');
      assert.equal(row.failure_code, 'interrupted');
      assert.equal(row.pay_attempts, 0);
      assert.equal(row.pay_retry_at, null);
      assert.deepEqual(log('feed_pay.pay_retry_planned'), []);
      assert.deepEqual(log('feed_pay.pay_retry_exhausted'), [
        { event: 'feed_pay.pay_retry_exhausted', callId, attempts: 0, reason },
      ]);
      // Nothing later plans one: a same-key repeat, then the cron past the time.
      assert.equal((await again()).statusCode, 200);
      f.advance(10 * 60_000);
      assert.equal((await f.cron()).statusCode, 200);
      assert.equal((await payOps(f, callId)).length, 1);
      assert.equal(f.base.state.feeCharges.length, 0);
    });
  }
});

test('an ambiguous send (a 429 on eth_sendUserOperation) is reconciled, never re-planned', async (t) => {
  const { f, serviceId } = await ready(t);
  const log = captureLog(t);
  f.base.state.rateLimit = { left: 1, retryAfter: '1', at: 'send', feeOnly: true };
  const { callId } = await start(f, serviceId);
  await workerGone(f, callId);
  for (
    let i = 0;
    i < 6 && !['result_saved', 'refused'].includes((await callRow(f, callId)).state);
    i++
  ) {
    f.advance(2 * 60_000);
    assert.equal((await f.cron()).statusCode, 200);
  }
  const ops = await payOps(f, callId);
  assert.equal(ops.length, 1, 'one payment operation, ever');
  assert.notEqual(ops[0]!.error_code, 'ABANDONED_BEFORE_BROADCAST');
  assert.equal((await callRow(f, callId)).pay_attempts, 0);
  assert.deepEqual(log('feed_pay.pay_retry_planned'), []);
  assert.ok(f.base.state.feeCharges.length <= 1);
});

test('two workers on one due call: exactly one new payment operation', async (t) => {
  const { f, serviceId } = await ready(t);
  captureLog(t, { stopAfterPlan: true });
  f.base.state.rateLimit = { left: 1, retryAfter: '60', at: 'prepare', feeOnly: true };
  const { callId, again } = await start(f, serviceId);
  const waiting = await workerGone(f, callId);
  f.advance(Number(waiting.pay_retry_at) - f.clock() + 1);
  const answers = await Promise.all([again(), again()]);
  for (const answer of answers) assert.equal(answer.statusCode, 200, answer.body);
  const call = await f.settled(callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  // Later runs (a third repeat, the cron) find nothing more to plan.
  assert.equal((await again()).statusCode, 200);
  f.advance(10 * 60_000);
  assert.equal((await f.cron()).statusCode, 200);
  assert.deepEqual(
    (await payOps(f, callId)).map((op) => op.idempotency_key),
    [feedPayKey(callId, 0), feedPayKey(callId, 1)],
  );
  await paidOnceBy(f, callId, 1);
});

test('the bounds are the top-up’s: 3 attempts, 30/90/180 s, at most 5 minutes, 10 minutes', () => {
  assert.equal(FEED_PAY_PAY_RETRY.attempts, 3);
  assert.deepEqual(FEED_PAY_PAY_RETRY.backoffMs, [30_000, 90_000, 180_000]);
  assert.equal(FEED_PAY_PAY_RETRY.maxWaitMs, 5 * 60_000);
  assert.equal(FEED_PAY_PAY_RETRY.windowMs, 10 * 60_000);
  assert.equal(feedPayKey('c1', 0), 'feed-pay:pay:c1', 'attempt 0 keeps the key calls had');
  assert.equal(feedPayKey('c1', 2), 'feed-pay:pay:c1:2');
});
