import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getAddress } from 'viem';
import { BODY, setup, SVC } from './helpers/feed-pay-app.js';

/*
 * Regression tests for the second review of Feed pay at 004d7f42: the sweep that closed a float
 * while a top-up started, a quote paid more than once, the database cap on call amounts, and a
 * duplicate key raced across two wallets. Fake service and fake Base only; nothing is paid.
 */

test('sweep: a float is not closed when something changed on the wallet while its balance was read', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  const paid = await f.pay();
  assert.equal(paid.json().state, 'result_saved', paid.body);
  // The float is empty on Base and its period is over, so the cron would close it.
  f.base.state.balances.set(f.base.spender.toLowerCase(), 0n);
  f.advance(86_400_000 + 60_000);
  let raced = false;
  f.base.state.beforeBalanceRead = async (address) => {
    if (raced || getAddress(address) !== getAddress(f.base.spender)) return;
    raced = true;
    // A call tops up and finishes while the cron waits for the balance: the float's settings
    // change (a new period) and a move is recorded, so the empty read is stale.
    await f.sql(
      'UPDATE feed_pay_agent_settings SET float_period_end = float_period_end + 86400 WHERE wallet_id = $1',
      [f.walletId],
    );
  };
  assert.equal((await f.cron()).statusCode, 200);
  assert.ok(raced, 'the sweep read the float balance');
  const [open] = await f.sql<{ float_open: boolean }>(
    'SELECT float_open FROM feed_pay_agent_settings WHERE wallet_id = $1',
    [f.walletId],
  );
  assert.equal(open?.float_open, true, 'a stale empty read never closes a float that changed');
  // Nothing changes on the next run: the empty float is closed then.
  f.base.state.beforeBalanceRead = null;
  f.advance(2 * 86_400_000);
  assert.equal((await f.cron()).statusCode, 200);
  const [after] = await f.sql<{ float_open: boolean }>(
    'SELECT float_open FROM feed_pay_agent_settings WHERE wallet_id = $1',
    [f.walletId],
  );
  assert.equal(after?.float_open, false);
});

test('quote: one quote pays for one call; a second key on the same quote is refused', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  const q = (await f.quote()).json();
  const body = () => ({
    agentId: f.agentId,
    inputs: BODY,
    quoteId: q.quoteId,
    maxAmountRaw: q.amount.raw,
    idempotencyKey: randomUUID(),
  });
  const first = await f.callService(body());
  assert.equal(first.statusCode, 200, first.body);
  const second = await f.callService(body());
  assert.equal(second.statusCode, 409, second.body);
  assert.match(second.body, /quote_mismatch/);
  const calls = await f.sql('SELECT 1 FROM feed_pay_calls WHERE quote_id = $1', [q.quoteId]);
  assert.equal(calls.length, 1);
});

test('database: a call above $100 (the cap of fee router 2, migration 233) cannot be stored, whatever the code path', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  const paid = await f.pay();
  const callId = paid.json().callId;
  await assert.rejects(
    f.sql('UPDATE feed_pay_calls SET amount_raw = 100000001 WHERE call_id = $1', [callId]),
  );
  await assert.rejects(
    f.sql('UPDATE feed_pay_calls SET max_amount_raw = 100000001 WHERE call_id = $1', [callId]),
  );
});

test('city_service_call: a generous ceiling ($1.00) pays the $0.02 price; the stored ceiling is capped at $0.10', async (t) => {
  const f = await setup(t);
  await f.list();
  const permission = await f.limit();
  assert.equal((await f.consent(permission.hash)).statusCode, 200);
  const res = await f.tool(f.main.token, 'city_service_call', {
    service_id: `https://centralcity.ai/feed/services/${SVC}`,
    agent_id: f.agentId,
    inputs: BODY,
    max_price_usdc: '1.00',
    idempotency_key: randomUUID(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().state, 'result_saved');
  assert.equal(res.json().payment.amount.usdc, '0.02');
  const [row] = await f.sql<{ max_amount_raw: string }>(
    'SELECT max_amount_raw::text FROM feed_pay_calls WHERE call_id = $1',
    [res.json().call_id],
  );
  assert.equal(row?.max_amount_raw, '100000');
});
