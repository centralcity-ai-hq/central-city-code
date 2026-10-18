import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BundlerError, bundlerRejection, SponsorError } from '../server/base/chain/rpc-bundler.js';
import {
  FEED_PAY_RECOVER_GRACE_MS,
  FEED_PAY_TOPUP_RETRY,
  topUpRetryWaitMs,
} from '../server/feed/pay/engine.js';
import { BODY, setup, type FeedPayApp } from './helpers/feed-pay-app.js';

/*
 * Feed pay: a float top-up that the bundler or paymaster refused ONLY for its rate (HTTP 429, or a
 * 'busy' answer) and that provably never left the server is planned again after the provider's
 * Retry-After and a backoff, at most three times within ten minutes and only when it is due while
 * the worker that plans it still runs; every other refusal ends the call at once as before
 * (float_topup_failed). The real app, engine and chain side over a fake Base
 * whose bundler answers 429 on request (tests/helpers/feed-pay-fake-base.ts). Synthetic data only;
 * nothing reaches a network.
 */

/**
 * The engine's JSON log lines, by event. `stopAfterPlan`: the worker stops right after its first
 * re-plan is stored (as a server that goes away), so the call waits for its time without a worker.
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
      return; // Not one of the engine's lines.
    }
    lines.push(parsed);
    if (stopAfterPlan && !stopped && parsed.event === 'feed_pay.topup_retry_planned') {
      stopped = true;
      throw new Error('the worker stopped');
    }
  });
  return (event: string) => lines.filter((line) => line.event === event);
}

async function ready(t: test.TestContext, options: Parameters<typeof setup>[1] = {}) {
  const f = await setup(t, options);
  await f.limit();
  await f.list();
  return f;
}

/** Quote then confirm, as the drawer does; the body serves a same-key repeat. */
async function start(f: FeedPayApp) {
  const q = await f.quote();
  assert.equal(q.statusCode, 200, q.body);
  const body = {
    agentId: f.agentId,
    inputs: BODY,
    quoteId: q.json().quoteId,
    maxAmountRaw: q.json().amount.raw,
    maxTotalRaw: q.json().total.raw,
    idempotencyKey: randomUUID(),
  };
  const res = await f.callService(body);
  assert.equal(res.statusCode, 200, res.body);
  return { callId: res.json().callId as string, body };
}

interface CallState {
  state: string;
  failure_code: string | null;
  topup_attempts: number;
  topup_retry_at: string | null;
  topup_move_id: string | null;
  lease_until: string;
  updated_at: string;
}

const callRow = async (f: FeedPayApp, callId: string) =>
  (
    await f.sql<CallState>(
      `SELECT state, failure_code, topup_attempts, topup_retry_at::text AS topup_retry_at,
         topup_move_id, lease_until::text AS lease_until, updated_at::text AS updated_at
       FROM feed_pay_calls WHERE call_id = $1`,
      [callId],
    )
  )[0]!;

/** The call's top-ups, oldest first, with their operation and float hold. */
const topUps = (f: FeedPayApp, callId: string) =>
  f.sql<{
    state: string;
    op_key: string;
    created_at: string;
    op_status: string | null;
    op_error: string | null;
    signed: number | null;
    hold: string | null;
  }>(
    `SELECT m.state, m.op_key, m.created_at::text AS created_at, o.status AS op_status,
       o.error_code AS op_error, octet_length(o.signed_operation) AS signed, r.state AS hold
     FROM feed_pay_float_moves m
     LEFT JOIN base_chain_ops o ON o.idempotency_key = m.op_key
     LEFT JOIN base_wallet_reservations r ON r.holder_kind = 'float' AND r.holder_ref = m.op_key
     WHERE m.call_id = $1 AND m.kind = 'top_up' ORDER BY m.created_at, m.move_id`,
    [callId],
  );

/** Waits (yielding to the background worker) until it no longer holds the call, or it is done. */
async function workerGone(f: FeedPayApp, callId: string) {
  for (let i = 0; i < 4_000; i++) {
    const row = await callRow(f, callId);
    if (row.lease_until === '0' || ['result_saved', 'refused'].includes(row.state)) return row;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('the worker still holds the call');
}

const spends = (f: FeedPayApp) => f.base.state.effects.filter((effect) => effect === 'spend');

test('the wait before a re-plan: Retry-After or the backoff, the longer, at most 5 minutes', () => {
  assert.deepEqual(FEED_PAY_TOPUP_RETRY.backoffMs, [30_000, 90_000, 180_000]);
  assert.equal(topUpRetryWaitMs(1, null), 30_000);
  assert.equal(topUpRetryWaitMs(1, 2_000), 30_000);
  assert.equal(topUpRetryWaitMs(1, 120_000), 120_000, 'never earlier than the provider said');
  assert.equal(topUpRetryWaitMs(2, null), 90_000);
  assert.equal(topUpRetryWaitMs(3, 0), 180_000);
  assert.equal(topUpRetryWaitMs(1, 300_000), 300_000);
  assert.equal(topUpRetryWaitMs(1, 300_001), null, 'longer than 5 minutes: none is planned');
});

test('a 429 then success: one re-plan, the old op terminal and never sent, paid once', async (t) => {
  const f = await ready(t);
  const log = captureLog(t);
  f.base.state.rateLimit = { left: 1, retryAfter: '2', at: 'prepare' };
  const { callId } = await start(f);
  const call = await f.settled(callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));

  const moves = await topUps(f, callId);
  assert.equal(moves.length, 2);
  // The old top-up: failed, its operation a never-broadcast tombstone, its float hold released.
  assert.equal(moves[0]!.state, 'failed');
  assert.equal(moves[0]!.op_status, 'failed');
  assert.equal(moves[0]!.op_error, 'ABANDONED_BEFORE_BROADCAST');
  assert.equal(Number(moves[0]!.signed), 0, 'nothing was ever signed or stored for it');
  assert.notEqual(moves[0]!.hold, 'held');
  // The new one moved the float, once.
  assert.equal(moves[1]!.state, 'final');
  assert.equal(moves[1]!.op_status, 'final');
  assert.equal(f.base.state.sends.length, 1, 'only one top-up operation was ever broadcast');
  assert.equal(spends(f).length, 1);
  assert.equal(f.base.state.prepares, 2);
  // Planned no earlier than the backoff (the provider asked for 2 s only).
  assert.ok(Number(moves[1]!.created_at) >= Number(moves[0]!.created_at) + 30_000);

  const row = await callRow(f, callId);
  assert.equal(row.topup_attempts, 1);
  assert.equal(row.topup_retry_at, null);
  const [payments] = await f.sql<{ n: string }>(
    "SELECT count(*)::text AS n FROM base_payments WHERE kind = 'x402' AND state = 'paid'",
  );
  assert.equal(payments!.n, '1', 'the call is paid once');
  assert.deepEqual(log('feed_pay.topup_retry_planned'), [
    { event: 'feed_pay.topup_retry_planned', callId, attempt: 1, waitMs: 30_000 },
  ]);
  assert.deepEqual(log('feed_pay.topup_retry_exhausted'), []);
});

test('Retry-After is respected: neither a worker nor the cron plans before topup_retry_at', async (t) => {
  const f = await ready(t);
  // The worker stops once the re-plan is stored: the call waits for its time without one.
  const log = captureLog(t, { stopAfterPlan: true });
  // One minute: longer than the backoff, within the request's own work.
  f.base.state.rateLimit = { left: 1, retryAfter: '60', at: 'prepare' };
  const { callId, body } = await start(f);
  const waiting = await workerGone(f, callId);
  assert.equal(waiting.state, 'reserved');
  assert.equal(waiting.topup_move_id, null);
  assert.equal(waiting.topup_attempts, 1);
  const due = Number(waiting.topup_retry_at);
  assert.deepEqual(
    log('feed_pay.topup_retry_planned').map((line) => line.waitMs),
    [60_000],
  );
  assert.ok(f.clock() < due, 'the worker stopped before the retry was due');
  assert.equal(f.base.state.prepares, 1);

  // The cron leaves it alone before its time, and within the grace after it: no new top-up, and
  // the call is not ended as interrupted.
  for (const at of [due - 1_000, due + FEED_PAY_RECOVER_GRACE_MS - 15_000]) {
    f.advance(at - f.clock());
    assert.equal((await f.cron()).statusCode, 200);
    const row = await callRow(f, callId);
    assert.equal(row.state, 'reserved');
    assert.equal(row.topup_move_id, null);
    assert.equal(f.base.state.prepares, 1);
  }

  // The caller follows its call (a same-key repeat): its worker plans the new top-up now.
  const repeat = await f.callService(body);
  assert.equal(repeat.statusCode, 200, repeat.body);
  assert.equal(repeat.json().callId, callId);
  const call = await f.settled(callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  const moves = await topUps(f, callId);
  assert.equal(moves.length, 2);
  assert.ok(Number(moves[1]!.created_at) >= due, 'not planned before topup_retry_at');
  assert.equal(spends(f).length, 1);
});

test('a re-planned call left without a worker past its time ends as any interrupted call', async (t) => {
  const f = await ready(t);
  captureLog(t, { stopAfterPlan: true });
  f.base.state.rateLimit = { left: 1, retryAfter: '60', at: 'prepare' };
  const { callId } = await start(f);
  const waiting = await workerGone(f, callId);
  f.advance(Number(waiting.topup_retry_at) + FEED_PAY_RECOVER_GRACE_MS + 1_000 - f.clock());
  assert.equal((await f.cron()).statusCode, 200);
  const row = await callRow(f, callId);
  assert.equal(row.state, 'refused');
  assert.equal(row.failure_code, 'interrupted');
  assert.equal((await topUps(f, callId)).length, 1, 'the cron never plans a top-up');
  assert.equal(f.base.state.prepares, 1);
});

test('four 429s in a row: re-plans while they fit the worker, then float_topup_failed', async (t) => {
  const f = await ready(t);
  const log = captureLog(t);
  const before = f.base.balanceOf(f.wallet);
  f.base.state.rateLimit = { left: 4, retryAfter: null, at: 'prepare' };
  const { callId, body } = await start(f);
  // The caller follows its call each time the request's work has ended.
  for (let i = 0; i < 6; i++) {
    const row = await workerGone(f, callId);
    if (row.state === 'refused' || row.state === 'result_saved') break;
    assert.equal(row.state, 'reserved');
    f.advance(Math.max(Number(row.topup_retry_at) - f.clock(), 0));
    assert.equal((await f.callService(body)).statusCode, 200);
  }
  const row = await callRow(f, callId);
  assert.equal(row.state, 'refused');
  assert.equal(row.failure_code, 'float_topup_failed');
  // The third backoff (180 s) is longer than a worker's whole budget: never planned.
  assert.equal(row.topup_attempts, 2);

  const moves = await topUps(f, callId);
  assert.equal(moves.length, 3);
  for (const move of moves) {
    assert.equal(move.state, 'failed');
    assert.equal(move.op_error, 'ABANDONED_BEFORE_BROADCAST');
    assert.notEqual(move.hold, 'held');
  }
  assert.equal(f.base.state.sends.length, 0, 'nothing was ever broadcast');
  assert.equal(f.base.balanceOf(f.wallet), before, 'nothing moved');
  const planned = log('feed_pay.topup_retry_planned');
  assert.deepEqual(
    planned.map((line) => [line.attempt, line.waitMs]),
    [
      [1, 30_000],
      [2, 90_000],
    ],
  );
  assert.deepEqual(log('feed_pay.topup_retry_exhausted'), [
    { event: 'feed_pay.topup_retry_exhausted', callId, attempts: 2, reason: 'budget' },
  ]);
  // Each re-plan came no earlier than its wait.
  for (let i = 1; i < moves.length; i++)
    assert.ok(
      Number(moves[i]!.created_at) >=
        Number(moves[i - 1]!.created_at) + (planned[i - 1]!.waitMs as number),
    );
});

test('a longer Retry-After than five minutes, or past the window: no re-plan, ends at once', async (t) => {
  const f = await ready(t);
  const log = captureLog(t);
  f.base.state.rateLimit = { left: 1, retryAfter: '900', at: 'prepare' };
  const { callId } = await start(f);
  const call = await f.settled(callId);
  assert.equal(call.state, 'refused');
  const row = await callRow(f, callId);
  assert.equal(row.failure_code, 'float_topup_failed');
  assert.equal(row.topup_attempts, 0);
  assert.deepEqual(log('feed_pay.topup_retry_exhausted'), [
    { event: 'feed_pay.topup_retry_exhausted', callId, attempts: 0, reason: 'retry_after' },
  ]);
  assert.deepEqual(log('feed_pay.topup_retry_planned'), []);
});

test('a Retry-After due after the worker stops: float_topup_failed at once, no new op', async (t) => {
  const f = await ready(t);
  const log = captureLog(t);
  const before = f.base.balanceOf(f.wallet);
  // Four minutes: within the five-minute cap and the window, but past the worker's 150 s.
  f.base.state.rateLimit = { left: 1, retryAfter: '240', at: 'prepare' };
  const { callId, body } = await start(f);
  const row = await workerGone(f, callId);
  assert.equal(row.state, 'refused');
  assert.equal(row.failure_code, 'float_topup_failed', 'not left to the cron to end interrupted');
  assert.equal(row.topup_attempts, 0);
  assert.equal(row.topup_retry_at, null);
  const moves = await topUps(f, callId);
  assert.equal(moves.length, 1, 'no new top-up');
  assert.equal(moves[0]!.state, 'failed');
  assert.equal(moves[0]!.op_status, 'failed');
  assert.equal(moves[0]!.op_error, 'ABANDONED_BEFORE_BROADCAST');
  assert.notEqual(moves[0]!.hold, 'held', 'its float hold is released');
  assert.ok(
    Number(row.updated_at) < Number(moves[0]!.created_at) + 240_000,
    'ended at once, not after the wait',
  );
  assert.deepEqual(log('feed_pay.topup_retry_planned'), []);
  assert.deepEqual(log('feed_pay.topup_retry_exhausted'), [
    { event: 'feed_pay.topup_retry_exhausted', callId, attempts: 0, reason: 'budget' },
  ]);
  // Nothing later plans one: a same-key repeat, then the cron past the time.
  assert.equal((await f.callService(body)).statusCode, 200);
  f.advance(10 * 60_000);
  assert.equal((await f.cron()).statusCode, 200);
  assert.equal((await callRow(f, callId)).failure_code, 'float_topup_failed');
  assert.equal((await topUps(f, callId)).length, 1);
  assert.equal(f.base.state.prepares, 1);
  assert.equal(f.base.state.sends.length, 0, 'nothing was ever broadcast');
  assert.equal(f.base.balanceOf(f.wallet), before, 'nothing moved');
});

test('a Retry-After due while the worker still runs: re-planned, paid once', async (t) => {
  const f = await ready(t);
  const log = captureLog(t);
  f.base.state.rateLimit = { left: 1, retryAfter: '100', at: 'prepare' };
  const { callId } = await start(f);
  const call = await f.settled(callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  assert.deepEqual(log('feed_pay.topup_retry_planned'), [
    { event: 'feed_pay.topup_retry_planned', callId, attempt: 1, waitMs: 100_000 },
  ]);
  assert.deepEqual(log('feed_pay.topup_retry_exhausted'), []);
  const moves = await topUps(f, callId);
  assert.deepEqual(
    moves.map((move) => move.state),
    ['failed', 'final'],
  );
  assert.ok(Number(moves[1]!.created_at) >= Number(moves[0]!.created_at) + 100_000);
  assert.equal(f.base.state.sends.length, 1);
  assert.equal(spends(f).length, 1);
});

test('any other refusal ends the call at once, as before: no re-plan', async (t) => {
  const f = await ready(t);
  const log = captureLog(t);
  const refusals: Error[] = [
    // The paymaster's sponsorship policy (not a rate, although it says "limit").
    new SponsorError(
      bundlerRejection('pm_getPaymasterStubData', {
        code: -32002,
        message: 'max spend limit exceeded for policy',
      }),
    ),
    // A selector not in the paymaster's allowlist.
    new SponsorError(
      bundlerRejection('pm_getPaymasterData', {
        code: -32603,
        message: 'not in allowlist: 0x12345678',
      }),
    ),
    // The account cannot pay (insufficient funds for the prefund).
    bundlerRejection('eth_estimateUserOperationGas', {
      code: -32500,
      message: "AA21 didn't pay prefund",
    }),
    // An HTTP 500 with a Retry-After: not a rate limit.
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
  ];
  for (const refusal of refusals) {
    f.base.state.prepareErrors = [refusal];
    const { callId } = await start(f);
    const call = await f.settled(callId);
    assert.equal(call.state, 'refused', refusal.message);
    const row = await callRow(f, callId);
    assert.equal(row.failure_code, 'float_topup_failed', refusal.message);
    assert.equal(row.topup_attempts, 0);
    assert.equal((await topUps(f, callId)).length, 1);
  }
  assert.equal(f.base.state.prepares, refusals.length);
  assert.deepEqual(log('feed_pay.topup_retry_planned'), []);
  assert.deepEqual(log('feed_pay.topup_retry_exhausted'), []);
});

test('insufficient funds ends the call at once: no top-up, no re-plan', async (t) => {
  const f = await ready(t);
  const log = captureLog(t);
  // The wallet is emptied once the call is reserved (before its top-up is planned).
  f.base.state.beforeBalanceRead = async (address) => {
    if (address.toLowerCase() !== f.wallet.toLowerCase()) return;
    const [reserved] = await f.sql<{ n: string }>('SELECT count(*)::text AS n FROM feed_pay_calls');
    if (reserved!.n !== '0') f.base.credit(f.wallet, -f.base.balanceOf(f.wallet));
  };
  const { callId } = await start(f);
  const call = await f.settled(callId);
  assert.equal(call.state, 'refused');
  const row = await callRow(f, callId);
  assert.equal(row.failure_code, 'insufficient_funds');
  assert.equal(row.topup_attempts, 0);
  assert.equal(f.base.state.prepares, 0);
  assert.deepEqual(log('feed_pay.topup_retry_planned'), []);
});

test('STOP during the wait: no re-plan, the call ends as today’s refusal', async (t) => {
  const f = await ready(t);
  captureLog(t, { stopAfterPlan: true });
  f.base.state.rateLimit = { left: 1, retryAfter: '60', at: 'prepare' };
  const { callId, body } = await start(f);
  const waiting = await workerGone(f, callId);
  const due = Number(waiting.topup_retry_at);
  // The workspace is stopped (paused) while the call waits; the caller follows before the time.
  await f.sql(
    `UPDATE workspaces SET data = jsonb_set(data, '{paused}', 'true'::jsonb)
     WHERE operator_id = $1`,
    [f.owner.id],
  );
  const repeat = await f.callService(body);
  assert.equal(repeat.statusCode, 200, repeat.body);
  const row = await workerGone(f, callId);
  assert.equal(row.state, 'refused');
  assert.equal(row.failure_code, 'limit_changed', 'as a paused workspace ends a call today');
  assert.ok(Number(row.updated_at) < due, 'ended during the wait, not at its end');
  assert.equal((await topUps(f, callId)).length, 1);
  assert.equal(f.base.state.prepares, 1);
  assert.equal(f.base.state.sends.length, 0);
});

test('Feed pay switched off during the wait: no re-plan, the call ends paused', async (t) => {
  const f = await ready(t);
  captureLog(t, { stopAfterPlan: true });
  f.base.state.rateLimit = { left: 1, retryAfter: '60', at: 'prepare' };
  const { callId } = await start(f);
  const waiting = await workerGone(f, callId);
  process.env.CITY_FEED_PAY = '0';
  f.advance(Number(waiting.topup_retry_at) + FEED_PAY_RECOVER_GRACE_MS + 1_000 - f.clock());
  assert.equal((await f.cron()).statusCode, 200);
  const row = await callRow(f, callId);
  assert.equal(row.state, 'refused');
  assert.equal(row.failure_code, 'paused');
  assert.equal((await topUps(f, callId)).length, 1);
  assert.equal(f.base.state.prepares, 1);
});

test('two workers on the same due call: exactly one new top-up', async (t) => {
  const f = await ready(t);
  captureLog(t, { stopAfterPlan: true });
  f.base.state.rateLimit = { left: 1, retryAfter: '60', at: 'prepare' };
  const { callId, body } = await start(f);
  const waiting = await workerGone(f, callId);
  f.advance(Number(waiting.topup_retry_at) - f.clock() + 1);
  const answers = await Promise.all([f.callService(body), f.callService(body)]);
  for (const answer of answers) assert.equal(answer.statusCode, 200, answer.body);
  const call = await f.settled(callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  // Later runs (a third repeat, the cron) find nothing more to plan.
  assert.equal((await f.callService(body)).statusCode, 200);
  f.advance(10 * 60_000);
  assert.equal((await f.cron()).statusCode, 200);
  const moves = await topUps(f, callId);
  assert.equal(moves.length, 2);
  assert.deepEqual(
    moves.map((move) => move.state),
    ['failed', 'final'],
  );
  assert.equal(f.base.state.prepares, 2);
  assert.equal(f.base.state.sends.length, 1);
  assert.equal(spends(f).length, 1);
  assert.equal((await callRow(f, callId)).topup_attempts, 1);
});

test('a 429 on the send itself is ambiguous: reconciled as before, never planned again', async (t) => {
  const f = await ready(t);
  const log = captureLog(t);
  f.base.state.rateLimit = { left: 1, retryAfter: '1', at: 'send' };
  const { callId } = await start(f);
  await workerGone(f, callId);
  // The stored operation was claimed for its send, so it may have gone out: it is followed by its
  // own reconciliation (at most a resend of the very same operation), never replaced.
  const moves = await topUps(f, callId);
  assert.equal(moves.length, 1, 'no second top-up');
  assert.notEqual(moves[0]!.op_error, 'ABANDONED_BEFORE_BROADCAST');
  assert.equal((await callRow(f, callId)).topup_attempts, 0);
  assert.deepEqual(log('feed_pay.topup_retry_planned'), []);
  const keys = new Set(
    (
      await f.sql<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM base_chain_ops WHERE kind = 'pull'",
      )
    ).map((op) => op.idempotency_key),
  );
  assert.equal(keys.size, 1, 'one top-up operation, ever');
  assert.ok(spends(f).length <= 1);
});
