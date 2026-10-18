import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getAddress, keccak256, stringToHex } from 'viem';
import { floatHeld, hasLiveCalls } from '../server/feed/pay/store.js';
import type { FeedPayQuote } from '../shared/feed-pay.js';
import { PROTOCOL_BASE_MAINNET } from '../shared/protocol.js';
import { BODY, CHAIN_ID, PAY_TO, SVC, setup } from './helpers/feed-pay-app.js';

/*
 * Operation Protocol Z2: the protocol fee on top of a Feed pay call (docs/protocol/FEES.md, "Fee on
 * top"). Fake service and fake Base only: the fake router moves the approved 10% to the treasury
 * once per (payer, ref), like CentralCityFeeRouter. Nothing real is paid.
 *
 * Fees are live by default on Base mainnet with the router and treasury fixed in code
 * (shared/protocol.ts): "fees on" here is simply CITY_PROTOCOL_FEES unset, and the fake Base
 * answers for the code's router and treasury. The fixture's default switches fees off with '0'.
 */

const ROUTER = PROTOCOL_BASE_MAINNET.feeRouter;
const TREASURY = PROTOCOL_BASE_MAINNET.treasury;
const FEES_ON = { CITY_PROTOCOL_FEES: undefined };

type Fixture = Awaited<ReturnType<typeof setup>>;

async function feesOn(t: test.TestContext, extra: Record<string, string | undefined> = {}) {
  const f = await setup(t, { env: { ...FEES_ON, ...extra } });
  f.base.state.feeRouter = { router: ROUTER, treasury: TREASURY };
  await f.list();
  await f.limit();
  return f;
}

async function settle(f: Fixture, callId: string) {
  // The cron finishes what the request's worker left: the fee leg after the seller's payment.
  for (let i = 0; i < 6; i++) {
    const call = (await f.status(callId)).json();
    if (call.protocolFee?.state === 'charged' || call.protocolFee?.state === 'failed') return call;
    f.advance(60_000);
    assert.equal((await f.cron()).statusCode, 200);
  }
  return (await f.status(callId)).json();
}

test('fee on top: the seller is paid the price, then 10% goes to the treasury through the router', async (t) => {
  const f = await feesOn(t);
  const paid = await f.pay();
  assert.equal(paid.statusCode, 200, paid.body);
  const call = await settle(f, paid.json().callId);
  assert.equal(call.state, 'result_saved');
  assert.equal(call.payment.amountRaw, '20000');
  assert.deepEqual(
    { amountRaw: call.protocolFee.amountRaw, state: call.protocolFee.state },
    { amountRaw: '2000', state: 'charged' },
  );
  assert.equal(f.base.balanceOf(PAY_TO), 20000n, 'the seller got exactly the price');
  assert.equal(f.base.balanceOf(TREASURY), 2000n, 'the treasury got exactly 10%');
  assert.deepEqual(
    f.base.state.feeCharges.map((c) => [c.payee, c.gross, c.fee, c.ref]),
    [[getAddress(PAY_TO), 20000n, 2000n, keccak256(stringToHex(call.callId))]],
  );
  // The fee left only after the seller's payment: approve + charge in one operation.
  const effects = f.base.state.effects;
  assert.ok(effects.indexOf('fee') > effects.indexOf('spend'));
  const [row] = await f.sql<{ fee_state: string; fee_op_key: string }>(
    'SELECT fee_state, fee_op_key FROM feed_pay_calls WHERE call_id = $1',
    [call.callId],
  );
  assert.deepEqual(row, { fee_state: 'charged', fee_op_key: `feed-pay:fee:${call.callId}` });
});

test('the caps hold for price + fee: a $0.095 service is refused with fees on ($0.1045 total)', async (t) => {
  const f = await feesOn(t);
  await f.list({ amount: '95000' });
  const res = await f.pay();
  assert.equal(res.statusCode, 409, res.body);
  assert.match(res.body, /over_per_call_max/);
  assert.equal(f.base.state.feeCharges.length, 0);
});

test('no seller payment, no fee: a call refused before signing owes nothing', async (t) => {
  const f = await feesOn(t);
  // Empty float: the call needs a top-up, held up on Base; meanwhile Feed pay is switched off.
  f.base.state.autoLand = false;
  const res = await f.pay();
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().state, 'float_topup', res.body);
  assert.equal(res.json().protocolFee.state, 'pending');
  process.env.CITY_FEED_PAY = '0';
  f.base.land([...f.base.state.sends].at(-1)!);
  f.base.state.autoLand = true;
  let call = (await f.status(res.json().callId)).json();
  for (let i = 0; i < 400 && !call.done; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    call = (await f.status(res.json().callId)).json();
  }
  if (!call.done) {
    f.advance(2 * 60_000);
    await f.cron();
    call = (await f.status(res.json().callId)).json();
  }
  assert.equal(call.state, 'refused', JSON.stringify(call));
  assert.equal(call.payment, null);
  assert.equal(call.protocolFee.state, 'not_owed');
  assert.equal(f.base.balanceOf(TREASURY), 0n);
  assert.equal(f.base.state.feeCharges.length, 0);
});

test("the owner's daily cap counts the fee: 0.02 + 0.002 per call", async (t) => {
  const f = await feesOn(t);
  await f.pay();
  const [spent] = await f.sql<{ fee: string }>(
    "SELECT COALESCE(SUM(fee_raw), 0)::text AS fee FROM feed_pay_calls WHERE fee_state IN ('pending','sent','charged')",
  );
  assert.equal(spent?.fee, '2000');
});

test('fees switched off (0): no fee is owed, nothing goes to a router', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  const paid = await f.pay();
  assert.equal(paid.json().protocolFee, null);
  assert.equal(f.base.state.feeCharges.length, 0);
  const [row] = await f.sql<{ fee_raw: string; fee_state: string | null }>(
    'SELECT fee_raw::text, fee_state FROM feed_pay_calls WHERE call_id = $1',
    [paid.json().callId],
  );
  assert.deepEqual(row, { fee_raw: '0', fee_state: null });
});

test('a charged fee is marked service-verified once the ledger has its row (its price then counts as volume)', async (t) => {
  const f = await feesOn(t);
  const paid = await f.pay();
  const call = await settle(f, paid.json().callId);
  assert.equal(call.protocolFee.state, 'charged');
  // The ledger scan has not seen it yet: the cron keeps waiting, nothing is marked.
  f.advance(60_000);
  await f.cron();
  let [row] = await f.sql<{ fee_verified: boolean }>(
    'SELECT fee_verified FROM feed_pay_calls WHERE call_id = $1',
    [call.callId],
  );
  assert.equal(row?.fee_verified, false);
  // The scan records the FeeCharged row (as the ledger would, with its transfer proof).
  await f.sql(
    `INSERT INTO protocol_fee_events (chain_id, tx_hash, log_index, emitter, source, kind,
       block_number, block_hash, block_time, payer, payee, ref, gross, fee, finalized, created_at)
     VALUES ($1, $2, 1, $3, 'router', 0, 10, $4, 1, $5, $6, $7, 20000, 2000, true, 1)`,
    [
      CHAIN_ID,
      `0x${'ab'.repeat(32)}`,
      ROUTER.toLowerCase(),
      `0x${'cd'.repeat(32)}`,
      f.base.spender.toLowerCase(),
      PAY_TO.toLowerCase(),
      keccak256(stringToHex(call.callId)),
    ],
  );
  f.advance(60_000);
  await f.cron();
  [row] = await f.sql<{ fee_verified: boolean }>(
    'SELECT fee_verified FROM feed_pay_calls WHERE call_id = $1',
    [call.callId],
  );
  assert.equal(row?.fee_verified, true);
  const [ledger] = await f.sql<{ service_verified: boolean }>(
    'SELECT service_verified FROM protocol_fee_events WHERE ref = $1',
    [keccak256(stringToHex(call.callId))],
  );
  assert.equal(ledger?.service_verified, true);
});

test('the quote shows the fee on top and the total the agent spends', async (t) => {
  const f = await feesOn(t);
  const q = (await f.quote()).json();
  assert.equal(q.amount.raw, '20000');
  assert.equal(q.protocolFee.raw, '2000');
  assert.equal(q.total.raw, '22000');
});

test('with fees switched off (0) the quote has no fee and the total is the price', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  const q = (await f.quote()).json();
  assert.equal(q.protocolFee, null);
  assert.equal(q.total.raw, '20000');
});

test('the fee route is pinned per call: config changed or switched off after the seller is paid, the owed fee still goes through the pinned router', async (t) => {
  const f = await feesOn(t);
  // The fee operation is sent but stays unlanded until the configuration has changed.
  f.base.state.holdFee = true;
  const paid = await f.pay();
  assert.equal(paid.statusCode, 200, paid.body);
  const callId = paid.json().callId;
  const [pinned] = await f.sql<{ fee_router: string }>(
    'SELECT fee_router FROM feed_pay_calls WHERE call_id = $1',
    [callId],
  );
  assert.equal(pinned?.fee_router, ROUTER.toLowerCase());
  // The seller is paid; the fee leg is still owed (the cron completes it).
  const [owed] = await f.sql<{ fee_state: string }>(
    'SELECT fee_state FROM feed_pay_calls WHERE call_id = $1',
    [callId],
  );
  assert.ok(['pending', 'sent'].includes(owed!.fee_state), owed!.fee_state);
  assert.equal(f.base.state.feeCharges.length, 0);
  // After reservation: another router named in the environment (ignored on Base mainnet), protocol
  // fees and Feed pay switched off.
  process.env.CITY_PROTOCOL_ROUTER = getAddress(`0x${'41'.repeat(20)}`);
  process.env.CITY_PROTOCOL_FEES = '0';
  process.env.CITY_FEED_PAY = '0';
  f.base.state.holdFee = false;
  for (const hash of [...f.base.state.pool.keys()])
    if (!f.base.state.landed.has(hash)) f.base.land(hash);
  const call = await settle(f, callId);
  assert.equal(call.payment?.state ?? 'settled', 'settled');
  assert.equal(call.protocolFee.state, 'charged', JSON.stringify(call));
  assert.equal(f.base.balanceOf(TREASURY), 2000n, 'charged once, through the pinned router');
  assert.equal(f.base.state.feeCharges.length, 1);
  assert.deepEqual(
    f.base.state.feeCharges.map((c) => c.ref),
    [keccak256(stringToHex(callId))],
  );
});

test('an owed fee always has its pinned route: the database refuses a row without one', async (t) => {
  const f = await feesOn(t);
  const paid = await f.pay();
  await assert.rejects(
    f.sql('UPDATE feed_pay_calls SET fee_router = NULL WHERE call_id = $1', [paid.json().callId]),
    /feed_pay_calls_fee_owed|check constraint/i,
  );
});

test('a fee still owed holds only the fee: the settled price is not held again (newer and older balance reads)', async (t) => {
  const f = await feesOn(t);
  f.base.state.holdFee = true;
  const paid = await f.pay();
  assert.equal(paid.statusCode, 200, paid.body);
  const [row] = await f.sql<{ wallet_id: string; settled_block: string; fee_state: string }>(
    'SELECT wallet_id, settled_block::text, fee_state FROM feed_pay_calls WHERE call_id = $1',
    [paid.json().callId],
  );
  assert.ok(row && ['pending', 'sent'].includes(row.fee_state), row?.fee_state);
  const q = {
    query: async (text: string, params?: unknown[]) => ({ rows: await f.sql(text, params) }),
  } as unknown as Parameters<typeof floatHeld>[0];
  const settled = BigInt(row!.settled_block);
  // A balance read after the seller's payment: the price is already gone, only the fee is held.
  assert.equal(await floatHeld(q, { walletId: row!.wallet_id, block: settled + 1n }), 2000n);
  assert.equal(await floatHeld(q, { walletId: row!.wallet_id, block: settled }), 2000n);
  // An older read (before the payment): the price and the fee are both still to leave.
  assert.equal(await floatHeld(q, { walletId: row!.wallet_id, block: settled - 1n }), 22000n);
  // The call stays live for a sweep while its fee is owed.
  assert.equal(await hasLiveCalls(q, row!.wallet_id), true);
});

// The total the person confirmed binds the fee (maxTotalRaw): a fee that applies only since the
// quote, or one a page from before the fee never showed, is refused before anything is signed.

const callBody = (
  f: Fixture,
  quote: FeedPayQuote,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  agentId: f.agentId,
  inputs: BODY,
  quoteId: quote.quoteId,
  maxAmountRaw: quote.amount.raw,
  maxTotalRaw: quote.total.raw,
  idempotencyKey: randomUUID(),
  ...extra,
});

/** The body a page from before the fee sends: no maxTotalRaw. */
function withoutTotal(body: Record<string, unknown>) {
  const old = { ...body };
  delete old.maxTotalRaw;
  return old;
}

async function nothingPaid(f: Fixture) {
  assert.equal(f.service.paid().length, 0, 'the service was not paid');
  assert.equal(f.base.state.feeCharges.length, 0, 'no fee was charged');
  assert.equal(f.base.balanceOf(PAY_TO), 0n);
  assert.equal(f.base.balanceOf(TREASURY), 0n);
  const calls = await f.sql('SELECT call_id FROM feed_pay_calls');
  assert.equal(calls.length, 0, 'no call was stored');
}

test('fees switched on after a quote without the fee: quote_mismatch, nothing paid; the total with the fee pays', async (t) => {
  const f = await feesOn(t, { CITY_PROTOCOL_FEES: '0' });
  const quote = (await f.quote()).json();
  assert.equal(quote.protocolFee, null);
  assert.equal(quote.total.raw, '20000');
  // Within the quote's 5 minutes the fee is switched on. The person confirmed 0.02 USDC, no fee.
  process.env.CITY_PROTOCOL_FEES = '1';
  const refused = await f.callService(callBody(f, quote));
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, 'quote_mismatch');
  await nothingPaid(f);
  // The page checks the price again: the fee is shown, and the confirmed total pays it.
  const fresh = (await f.quote()).json();
  assert.equal(fresh.protocolFee.raw, '2000');
  const paid = await f.callService(callBody(f, fresh));
  assert.equal(paid.statusCode, 200, paid.body);
  const call = await settle(f, paid.json().callId);
  assert.equal(call.payment.amountRaw, '20000');
  assert.equal(call.protocolFee.amountRaw, '2000');
  assert.equal(f.base.balanceOf(TREASURY), 2000n);
});

test('a page from before the fee (no maxTotalRaw) confirmed the price alone: the fee is refused', async (t) => {
  const f = await feesOn(t);
  const quote = (await f.quote()).json();
  assert.equal(quote.total.raw, '22000');
  const old = withoutTotal(callBody(f, quote));
  const refused = await f.callService(old);
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, 'quote_mismatch');
  // A total below the price plus the fee is refused the same way.
  const short = await f.callService(callBody(f, quote, { maxTotalRaw: '21999' }));
  assert.equal(short.json().code, 'quote_mismatch');
  await nothingPaid(f);
  // The same quote, with the total confirmed, pays.
  const paid = await f.callService(callBody(f, quote));
  assert.equal(paid.statusCode, 200, paid.body);
});

test('the confirmed total is part of the request: the same key pays once, another total conflicts', async (t) => {
  const f = await feesOn(t);
  const quote = (await f.quote()).json();
  const body = callBody(f, quote);
  const first = await f.callService(body);
  assert.equal(first.statusCode, 200, first.body);
  const again = await f.callService(body);
  assert.equal(again.json().callId, first.json().callId);
  const other = await f.callService({ ...body, maxTotalRaw: '23000' });
  assert.equal(other.statusCode, 409, other.body);
  assert.equal(other.json().code, 'idempotency_conflict');
  assert.equal(f.service.paid().length, 1);
});

test('fees off: a total equal to the price is the same request as none (same key, same call)', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  const quote = (await f.quote()).json();
  const old = withoutTotal(callBody(f, quote));
  const first = await f.callService(old);
  assert.equal(first.statusCode, 200, first.body);
  const again = await f.callService({ ...old, maxTotalRaw: quote.amount.raw });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().callId, first.json().callId);
  assert.equal(f.service.paid().length, 1);
});

test('MCP: max_price_usdc bounds the price; with fees on the agent pays the fee on top', async (t) => {
  const f = await setup(t, { env: FEES_ON });
  f.base.state.feeRouter = { router: ROUTER, treasury: TREASURY };
  await f.list();
  const permission = await f.limit();
  assert.equal((await f.consent(permission.hash)).statusCode, 200);
  const res = await f.tool(f.main.token, 'city_service_call', {
    service_id: SVC,
    agent_id: f.agentId,
    inputs: BODY,
    max_price_usdc: '0.02',
    idempotency_key: randomUUID(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().payment.amount.usdc, '0.02');
  const [row] = await f.sql<{ fee_raw: string }>(
    'SELECT fee_raw::text FROM feed_pay_calls WHERE call_id = $1',
    [res.json().call_id],
  );
  assert.equal(row?.fee_raw, '2000');
});
