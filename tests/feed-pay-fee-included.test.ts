import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { getAddress, keccak256, stringToHex, type Hex } from 'viem';
import { feedServiceId } from '../server/feed/bazaar.js';
import { HOSTED_SOURCE } from '../server/feed/types.js';
import {
  hashKind,
  OFFER_KIND_REGISTRY,
  OfferKindFailure,
  OfferKindInputError,
  type OfferKind,
} from '../server/feed/offers/kinds.js';
import {
  offerInputSummary,
  offerOutputSummary,
  type OfferKindName,
  type OfferPreset,
} from '../shared/feed-offers.js';
import { FEED_PAY_FAILURE_MESSAGES, FEED_PAY_PATHS, type FeedPayCall } from '../shared/feed-pay.js';
import { PROTOCOL_BASE_MAINNET } from '../shared/protocol.js';
import { permissionOf } from '../server/base/chain/feed-pay-chain.js';
import { pgChainOperationStore } from '../server/base/chain/stores.js';
import { floatHeld, hasLiveCalls, topUpInFlight } from '../server/feed/pay/store.js';
import { CHAIN_ID, setup, type FeedPayApp } from './helpers/feed-pay-app.js';
import type { FakeFeeEvent } from './helpers/feed-pay-fake-base.js';
import type { ScreeningProvider } from '../server/protocol/screening/gate.js';

/*
 * Feed pay: a service sold by a Central City agent is paid FEE INCLUDED and delivered at once
 * (owner decisions of 15 Oct). The buyer pays the listed price; one operation from its spender
 * account, [USDC.approve(router, price), router.pay(payTo, price, keccak256(callId))], sends 90% to
 * the seller and 10% to the treasury; once it is in a block with the matching FeeCharged (kind 1)
 * the offer's kind runs in-process and its answer is the result. No x402 request is ever made.
 *
 * The real app, engine and chain side over a fake Base (tests/helpers/feed-pay-fake-base.ts) whose
 * router moves the money like CentralCityFeeRouter. Synthetic data; nothing reaches a network.
 */

const ROUTER = PROTOCOL_BASE_MAINNET.feeRouter;
const TREASURY = PROTOCOL_BASE_MAINNET.treasury;
const FEES_ON = { CITY_PROTOCOL_FEES: undefined };
const SELLER = getAddress(`0x${'5e'.repeat(20)}`);
const OTHER_SELLER = getAddress(`0x${'5f'.repeat(20)}`);
const ORIGIN = 'https://centralcity.ai';
const HELLO = { body: { text: 'hello' } };
const HELLO_HEX = createHash('sha256').update('hello', 'utf8').digest('hex');

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
let offerSeq = 0;
/** A fresh synthetic offer id ('off_' + 16 base32 characters). */
function newOfferId(): string {
  let n = ++offerSeq;
  let tail = '';
  for (let i = 0; i < 16; i++) {
    tail = BASE32[n % 32] + tail;
    n = Math.floor(n / 32);
  }
  return `off_${tail}`;
}

async function feesOn(
  t: test.TestContext,
  options: Parameters<typeof setup>[1] = {},
): Promise<FeedPayApp> {
  const f = await setup(t, { ...options, env: { ...FEES_ON, ...options.env } });
  f.base.state.feeRouter = { router: ROUTER, treasury: TREASURY };
  return f;
}

/**
 * An offer of a seller agent and its Feed listing (source 'Central City', record 'cc:<offerId>'),
 * as the offers store writes them (server/feed/offers/store.ts). Answers the listing's id.
 */
async function listOffer(
  f: FeedPayApp,
  o: {
    priceRaw?: string;
    payTo?: string;
    kind?: OfferKindName;
    state?: string;
    preset?: OfferPreset | null;
  } = {},
) {
  const offerId = newOfferId();
  const url = `${ORIGIN}/api/public/x402/${offerId}`;
  const id = feedServiceId(url);
  const kind = o.kind ?? 'hash';
  const price = o.priceRaw ?? '50000';
  const payTo = o.payTo ?? SELLER;
  const at = f.clock();
  await f.sql(
    `INSERT INTO city_offers (offer_id, operator_id, agent_id, wallet_id, pay_to, kind, title,
       description, tags, price_raw, discoverable, version, state, idem_key, risky,
       price_changed_at, created_at, updated_at, preset)
     VALUES ($1, 'op-seller', 'agent-seller', 'wallet-seller', $2, $3, 'Text hash',
       'The SHA-256 of a text.', '{}', $4, true, 1, $5, $1, NULL, $6, $6, $6, $7::jsonb)`,
    [
      offerId,
      payTo,
      kind,
      price,
      o.state ?? 'active',
      at,
      o.preset ? JSON.stringify(o.preset) : null,
    ],
  );
  await f.sql(
    `INSERT INTO feed_services (id, source, record_id, host, url, title, description, capabilities,
       provider_name, method, x402_version, scheme, price_raw, pay_to, input, output,
       paid_calls_30d, payers_30d, last_called_at, source_updated_at, fetched_at, first_seen_at,
       last_seen_at, last_seen_sweep, missed_sweeps, withdrawn_at, risky, hidden, search_text,
       seller_key)
     VALUES ($1, $2, $3, 'centralcity.ai', $4, 'Text hash', 'The SHA-256 of a text.', '{}',
       'Synthetic seller', 'POST', 2, 'exact', $5, $6, $7::jsonb, $8::jsonb, NULL, NULL, NULL,
       $9, $9, $9, $9, 0, 0, NULL, NULL, false, 'text hash', $10)`,
    [
      id,
      HOSTED_SOURCE,
      `cc:${offerId}`,
      url,
      price,
      payTo,
      JSON.stringify(offerInputSummary(kind, o.preset ?? null)),
      JSON.stringify(offerOutputSummary(kind)),
      at,
      payTo.toLowerCase(),
    ],
  );
  return { id, offerId };
}

/** The person's price check of a service. */
function quoteOf(f: FeedPayApp, id: string, inputs: unknown = HELLO) {
  return f.quote(inputs, id);
}

/** Quote then confirm, as the Feed page does. */
async function payOffer(f: FeedPayApp, id: string, inputs: unknown = HELLO, key = randomUUID()) {
  const q = await quoteOf(f, id, inputs);
  assert.equal(q.statusCode, 200, q.body);
  assert.equal(q.json().payable, true, q.body);
  return f.callService(
    {
      agentId: f.agentId,
      inputs,
      quoteId: q.json().quoteId,
      maxAmountRaw: q.json().amount.raw,
      maxTotalRaw: q.json().total.raw,
      idempotencyKey: key,
    },
    id,
  );
}

/** Waits (yielding to the worker, then the cron) until the call is done. */
async function done(f: FeedPayApp, callId: string): Promise<FeedPayCall> {
  for (let i = 0; i < 400; i++) {
    const call = (await f.status(callId)).json() as FeedPayCall;
    if (call.done) return call;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (let i = 0; i < 6; i++) {
    f.advance(2 * 60_000);
    assert.equal((await f.cron()).statusCode, 200);
    const call = (await f.status(callId)).json() as FeedPayCall;
    if (call.done) return call;
  }
  return (await f.status(callId)).json() as FeedPayCall;
}

async function counts(f: FeedPayApp) {
  const [calls] = await f.sql<{ n: string }>('SELECT count(*)::text AS n FROM feed_pay_calls');
  const [payments] = await f.sql<{ n: string }>('SELECT count(*)::text AS n FROM base_payments');
  const [ops] = await f.sql<{ n: string }>(
    "SELECT count(*)::text AS n FROM base_chain_ops WHERE kind = 'protocol_fee'",
  );
  return {
    calls: Number(calls!.n),
    payments: Number(payments!.n),
    payOps: Number(ops!.n),
    requests: f.service.requests.length,
    sends: f.base.state.sends.length,
  };
}

const callRow = async (f: FeedPayApp, callId: string) =>
  (
    await f.sql<{
      pay_kind: string;
      offer_id: string | null;
      amount_raw: string;
      fee_raw: string;
      fee_state: string;
      fee_op_key: string;
      delivered_at: string | null;
      pay_final_at: string | null;
      request_body: string | null;
    }>(
      `SELECT pay_kind, offer_id, amount_raw::text AS amount_raw, fee_raw::text AS fee_raw,
         fee_state, fee_op_key, delivered_at, pay_final_at, request_body
       FROM feed_pay_calls WHERE call_id = $1`,
      [callId],
    )
  )[0]!;

test('the quote of a Central City agent’s service: the listed price, fee included, no request', async (t) => {
  const f = await feesOn(t);
  await f.limit();
  const { id } = await listOffer(f, { priceRaw: '50000' });
  const before = await counts(f);
  const res = await quoteOf(f, id);
  assert.equal(res.statusCode, 200, res.body);
  const quote = res.json();
  assert.equal(quote.payable, true);
  assert.equal(quote.feeIncluded, true);
  assert.equal(quote.amount.raw, '50000');
  assert.equal(quote.listed.raw, '50000');
  assert.equal(quote.protocolFee.raw, '5000', 'the fee is price / 10, inside the price');
  assert.equal(quote.total.raw, '50000', 'the total is the price: nothing on top');
  assert.equal(quote.payTo, SELLER);
  assert.equal(quote.vsListing, 'same');
  // The service is in-process: no unpaid request went anywhere, nothing was stored but the quote.
  assert.deepEqual(await counts(f), before);

  // The router's rounding: $0.09 is 9,000 of fee; $0.10 (the most) is 10,000.
  for (const [price, fee] of [
    ['90000', '9000'],
    ['100000', '10000'],
  ]) {
    const listing = await listOffer(f, { priceRaw: price });
    const q = (await quoteOf(f, listing.id)).json();
    assert.deepEqual([q.amount.raw, q.protocolFee.raw, q.total.raw], [price, fee, price]);
  }

  // With protocol fees switched off there is no router to pay through: not available now.
  process.env.CITY_PROTOCOL_FEES = '0';
  const off = await quoteOf(f, id);
  assert.equal(off.statusCode, 503, off.body);
  assert.equal(off.json().code, 'unavailable');
});

test('the per-call maximum and the limits compare against the price, not price + fee', async (t) => {
  const f = await feesOn(t);
  await f.limit();
  // An owner maximum of exactly $0.05: a $0.05 service is within it (fee included), although the
  // same price with 10% on top ($0.055) would not be.
  await f.sql(
    `INSERT INTO feed_pay_agent_settings (wallet_id, per_call_max_raw, updated_at)
     VALUES ($1, 50000, 1)`,
    [f.walletId],
  );
  const { id } = await listOffer(f, { priceRaw: '50000' });
  const paid = await payOffer(f, id);
  assert.equal(paid.statusCode, 200, paid.body);
  const call = await done(f, paid.json().callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));

  // $0.06 is above that maximum: refused with the price as what is needed, nothing reserved.
  const dear = await listOffer(f, { priceRaw: '60000' });
  const before = await counts(f);
  const res = await payOffer(f, dear.id);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, 'over_per_call_max');
  assert.equal(res.json().neededRaw, '60000');
  assert.equal(res.json().perCallMaxRaw, '50000');
  assert.deepEqual(await counts(f), before);

  // A $0.10 service, the most a call may be, is within the default maximum: no fee on top.
  await f.sql('DELETE FROM feed_pay_agent_settings WHERE wallet_id = $1', [f.walletId]);
  const most = await listOffer(f, { priceRaw: '100000' });
  const top = await payOffer(f, most.id);
  assert.equal(top.statusCode, 200, top.body);
  assert.equal((await done(f, top.json().callId)).state, 'result_saved');
  // The calendar cap counts exactly the prices paid: 0.05 + 0.10.
  const [spent] = await f.sql<{ total: string }>(
    `SELECT (SELECT COALESCE(SUM(amount), 0) FROM base_payments WHERE kind = 'x402')
       + (SELECT COALESCE(SUM(fee_raw), 0) FROM feed_pay_calls
          WHERE fee_state IN ('pending','sent','charged')) AS total`,
  );
  assert.equal(String(spent!.total), '150000');
});

test('an invalid input is refused before anything is reserved, with a plain reason', async (t) => {
  const f = await feesOn(t);
  const permission = await f.limit();
  assert.equal((await f.consent(permission.hash)).statusCode, 200);
  const { id } = await listOffer(f);
  const before = await counts(f);
  for (const inputs of [
    { body: { text: 'a', extra: 1 } },
    { body: {} },
    { body: { text: 'x'.repeat(8_193) } },
    { query: { text: 'a' }, body: { text: 'a' } },
  ]) {
    const quoted = await quoteOf(f, id, inputs);
    assert.equal(quoted.statusCode, 400, quoted.body);
    assert.equal(quoted.json().code, 'invalid_inputs');
    assert.doesNotMatch(quoted.json().error, /x{20}/, 'the value is never echoed');
    f.advance(12_100);
    const mcp = await f.tool(f.main.token, 'city_service_call', {
      service_id: id,
      agent_id: f.agentId,
      inputs,
      max_price_usdc: '0.05',
      idempotency_key: randomUUID(),
    });
    assert.equal(mcp.statusCode, 400, mcp.body);
    assert.equal(mcp.json().code, 'invalid_inputs');
  }
  const extra = await quoteOf(f, id, { body: { text: 'a', extra: 1 } });
  assert.equal(extra.json().error, 'This service takes only text.');
  // Nothing reserved, signed or sent.
  assert.deepEqual(await counts(f), before);
  assert.equal(f.base.state.signatures, 0);
});

test('an offer preset: merged into the input, a different buyer value refused before anything is reserved', async (t) => {
  const f = await feesOn(t);
  const permission = await f.limit();
  assert.equal((await f.consent(permission.hash)).statusCode, 200);
  const preset = { from: 'km', to: 'mi' };
  const { id } = await listOffer(f, { kind: 'unit-convert', preset });
  const before = await counts(f);
  // A buyer value for a fixed field: refused with a plain reason, over the page and the tool.
  const overridden = await quoteOf(f, id, { body: { value: 2, from: 'm' } });
  assert.equal(overridden.statusCode, 400, overridden.body);
  assert.equal(overridden.json().code, 'invalid_inputs');
  assert.equal(overridden.json().error, 'from is fixed by this service to "km": leave it out.');
  const mcp = await f.tool(f.main.token, 'city_service_call', {
    service_id: id,
    agent_id: f.agentId,
    inputs: { body: { value: 2, to: 'ft' } },
    max_price_usdc: '0.05',
    idempotency_key: randomUUID(),
  });
  assert.equal(mcp.statusCode, 400, mcp.body);
  assert.equal(mcp.json().code, 'invalid_inputs');
  // Still the kind's own schema for the rest: a missing value is refused.
  assert.equal((await quoteOf(f, id, { body: {} })).json().code, 'invalid_inputs');
  assert.deepEqual(await counts(f), before);
  // The same value as the preset is fine; leaving it out is the usual call.
  assert.equal((await quoteOf(f, id, { body: { value: 2, from: 'km' } })).statusCode, 200);
  const res = await payOffer(f, id, { body: { value: 2 } });
  assert.equal(res.statusCode, 200, res.body);
  const call = await done(f, res.json().callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  // The kind ran with the preset merged in.
  const expected = await OFFER_KIND_REGISTRY.get('unit-convert')!.run(
    { value: 2, ...preset },
    { signal: new AbortController().signal, now: 0 },
  );
  assert.deepEqual(JSON.parse(call.result!.text!), expected.body);
});

test('a full call: one operation with approve + pay, FeeCharged kind 1 matched, delivered at inclusion', async (t) => {
  const f = await feesOn(t);
  await f.limit();
  const { id, offerId } = await listOffer(f, { priceRaw: '50000' });
  const before = await counts(f);
  const res = await payOffer(f, id);
  assert.equal(res.statusCode, 200, res.body);
  const call = await done(f, res.json().callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  assert.equal(call.moneyMoved, 'yes');
  assert.equal(call.failure, null);
  // The payment is the price, fee included; the fee was charged in the same transaction.
  assert.equal(call.payment?.amountRaw, '50000');
  assert.equal(call.payment?.payTo, SELLER);
  assert.equal(call.payment?.state, 'settled');
  assert.ok(call.payment?.txHash);
  assert.deepEqual(call.protocolFee, {
    amountRaw: '5000',
    amount: call.protocolFee!.amount,
    state: 'charged',
    txHash: call.payment!.txHash,
    included: true,
  });
  // The kind ran in-process with the checked input: the stored result is its answer.
  assert.equal(call.result?.origin, 'external');
  assert.equal(call.result?.status, 200);
  assert.equal(call.result?.format, 'json');
  assert.deepEqual(JSON.parse(call.result!.text!), {
    algorithm: 'sha256',
    hex: HELLO_HEX,
    bytes: 5,
  });

  // Exactly one operation, and it was the router payment: no x402 request, no fee leg.
  const after = await counts(f);
  assert.equal(after.payOps - before.payOps, 1);
  assert.equal(after.requests, before.requests, 'no request to any service');
  assert.equal(f.service.paid().length, 0);
  assert.ok(f.base.state.effects.includes('pay'));
  assert.ok(!f.base.state.effects.includes('fee'));
  assert.deepEqual(
    f.base.state.feeCharges.map((c) => [c.kind, c.payee, c.gross, c.fee, c.ref]),
    [[1, SELLER, 50000n, 5000n, keccak256(stringToHex(call.callId))]],
  );
  assert.equal(f.base.balanceOf(SELLER), 45000n, 'the seller got 90%');
  assert.equal(f.base.balanceOf(TREASURY), 5000n, 'the treasury got 10%');
  const row = await callRow(f, call.callId);
  assert.equal(row.pay_kind, 'included');
  assert.equal(row.offer_id, offerId);
  assert.deepEqual([row.amount_raw, row.fee_raw, row.fee_state], ['45000', '5000', 'charged']);
  assert.equal(row.fee_op_key, `feed-pay:pay:${call.callId}`);
  assert.ok(row.delivered_at !== null);
  assert.ok(row.pay_final_at !== null, 'the fake Base finalizes at once: finality recorded');
  assert.equal(row.request_body, null, 'the input is not kept after the delivery');

  // A same-key re-read answers the same call and sends nothing again.
  const q = (await quoteOf(f, id)).json();
  const body = {
    agentId: f.agentId,
    inputs: HELLO,
    quoteId: q.quoteId,
    maxAmountRaw: q.amount.raw,
    maxTotalRaw: q.total.raw,
    idempotencyKey: randomUUID(),
  };
  const first = await f.callService(body, id);
  assert.equal(first.statusCode, 200, first.body);
  const firstCall = await done(f, first.json().callId);
  assert.equal(firstCall.state, 'result_saved');
  const sent = await counts(f);
  const again = await f.callService(body, id);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().callId, firstCall.callId);
  assert.deepEqual(again.json().result, firstCall.result);
  assert.deepEqual(await counts(f), sent);
  // The same key with another request (a new quote): refused, nothing paid.
  const other = (await quoteOf(f, id)).json();
  const conflict = await f.callService({ ...body, quoteId: other.quoteId }, id);
  assert.equal(conflict.json().code, 'idempotency_conflict', conflict.body);
  assert.deepEqual(await counts(f), sent);
});

test('city_service_call: the answer names the price, fee included, and the fee; a retry is the same call', async (t) => {
  const f = await feesOn(t);
  const permission = await f.limit();
  assert.equal((await f.consent(permission.hash)).statusCode, 200);
  const { id } = await listOffer(f, { priceRaw: '50000' });
  const args = {
    service_id: id,
    agent_id: f.agentId,
    inputs: HELLO,
    max_price_usdc: '0.05',
    idempotency_key: randomUUID(),
  };
  f.advance(12_100);
  const res = await f.tool(f.main.token, 'city_service_call', args);
  assert.equal(res.statusCode, 200, res.body);
  let out = res.json();
  for (let i = 0; i < 6 && !out.done; i++) {
    f.advance(12_100);
    out = (await f.tool(f.main.token, 'city_service_call', args)).json();
  }
  assert.equal(out.done, true, JSON.stringify(out));
  assert.equal(out.state, 'result_saved');
  assert.equal(out.money_moved, 'yes');
  assert.deepEqual(out.payment.amount, {
    raw: '50000',
    decimals: 6,
    usdc: out.payment.amount.usdc,
  });
  assert.equal(out.payment.fee_included, true);
  assert.equal(out.payment.protocol_fee.raw, '5000');
  assert.equal(JSON.parse(out.result.text).hex, HELLO_HEX);
  const sent = await counts(f);
  f.advance(12_100);
  const again = (await f.tool(f.main.token, 'city_service_call', args)).json();
  assert.equal(again.call_id, out.call_id);
  assert.equal(again.result.text, out.result.text);
  assert.deepEqual(await counts(f), sent, 'no second operation');
  // $0.04 as the most the price may be: refused, the price is $0.05 (the fee is inside it).
  f.advance(12_100);
  const low = await f.tool(f.main.token, 'city_service_call', {
    ...args,
    max_price_usdc: '0.04',
    idempotency_key: randomUUID(),
  });
  assert.equal(low.statusCode, 409, low.body);
  assert.equal(low.json().code, 'price_above_max');
});

test('a kind that fails: paid_no_result with a plain reason, the fee stays charged', async (t) => {
  let runs = 0;
  const failing: OfferKind = {
    ...hashKind,
    async run() {
      runs++;
      throw new Error('synthetic failure');
    },
  };
  const f = await feesOn(t, { offerKinds: new Map([['hash', failing]]) });
  await f.limit();
  const { id } = await listOffer(f);
  const res = await payOffer(f, id);
  assert.equal(res.statusCode, 200, res.body);
  const call = await done(f, res.json().callId);
  assert.equal(call.state, 'paid_no_result', JSON.stringify(call));
  assert.equal(call.moneyMoved, 'yes');
  assert.deepEqual(call.failure, {
    code: 'service_error',
    message: FEED_PAY_FAILURE_MESSAGES.service_error,
  });
  assert.equal(call.result, null);
  assert.equal(call.protocolFee?.state, 'charged');
  assert.equal(f.base.balanceOf(SELLER), 45000n);
  assert.equal(f.base.balanceOf(TREASURY), 5000n);
  assert.equal(runs, 1, 'delivered once');
  assert.ok(f.alerts.some((a) => a.kind === 'paid_no_result' && a.callId === call.callId));
});

test('the kind’s own check() refuses before anything is reserved, with its plain reason', async (t) => {
  let runs = 0;
  const strict: OfferKind = {
    ...hashKind,
    check(input) {
      hashKind.check(input);
      if ((input as { text?: unknown }).text === 'no')
        throw new OfferKindInputError('Not this text.');
    },
    async run(input, ctx) {
      runs++;
      return hashKind.run(input, ctx);
    },
  };
  const f = await feesOn(t, { offerKinds: new Map([['hash', strict]]) });
  const permission = await f.limit();
  assert.equal((await f.consent(permission.hash)).statusCode, 200);
  const { id } = await listOffer(f);
  const before = await counts(f);
  const quoted = await quoteOf(f, id, { body: { text: 'no' } });
  assert.equal(quoted.statusCode, 400, quoted.body);
  assert.equal(quoted.json().code, 'invalid_inputs');
  assert.equal(quoted.json().error, 'Not this text.');
  f.advance(12_100);
  const mcp = await f.tool(f.main.token, 'city_service_call', {
    service_id: id,
    agent_id: f.agentId,
    inputs: { body: { text: 'no' } },
    max_price_usdc: '0.05',
    idempotency_key: randomUUID(),
  });
  assert.equal(mcp.statusCode, 400, mcp.body);
  assert.equal(mcp.json().code, 'invalid_inputs');
  assert.deepEqual(await counts(f), before);
  assert.equal(f.base.state.signatures, 0);
  assert.equal(runs, 0);
});

test('an OfferKindFailure after payment is paid_no_result; outboundSent only labels it', async (t) => {
  for (const [outboundSent, code] of [
    [false, 'service_unreachable'],
    [true, 'service_error'],
  ] as const) {
    await t.test(code, async (t) => {
      const failing: OfferKind = {
        ...hashKind,
        async run() {
          throw new OfferKindFailure('read_failed', 'The page could not be read.', 502, {
            outboundSent,
          });
        },
      };
      const f = await feesOn(t, { offerKinds: new Map([['hash', failing]]) });
      await f.limit();
      const { id } = await listOffer(f);
      const res = await payOffer(f, id);
      assert.equal(res.statusCode, 200, res.body);
      const call = await done(f, res.json().callId);
      assert.equal(call.state, 'paid_no_result', JSON.stringify(call));
      assert.equal(call.moneyMoved, 'yes');
      assert.equal(call.failure?.code, code);
      assert.equal(call.protocolFee?.state, 'charged');
      assert.equal(f.base.balanceOf(TREASURY), 5000n);
    });
  }
});

test('a limiter refusal after payment (busy, nothing sent) is run again a few times before paid_no_result', async (t) => {
  const busyRuns = (failFirst: number, status: 429 | 503 | 502 = 429) => {
    const state = { runs: 0 };
    const kind: OfferKind = {
      ...hashKind,
      async run(input, ctx) {
        state.runs++;
        if (state.runs <= failFirst)
          throw new OfferKindFailure(
            status === 429 ? 'host_busy' : status === 503 ? 'busy' : 'unreachable',
            'Busy.',
            status,
          );
        return hashKind.run(input, ctx);
      },
    };
    return { state, kind };
  };
  await t.test('busy twice, then an answer', async (t) => {
    const { state, kind } = busyRuns(2, 503);
    const f = await feesOn(t, { offerKinds: new Map([['hash', kind]]) });
    await f.limit();
    const { id } = await listOffer(f);
    const res = await payOffer(f, id);
    assert.equal(res.statusCode, 200, res.body);
    const call = await done(f, res.json().callId);
    assert.equal(call.state, 'result_saved', JSON.stringify(call));
    assert.equal(state.runs, 3);
    assert.equal(f.base.balanceOf(TREASURY), 5000n, 'paid once');
  });
  await t.test('busy every time: three runs, then paid_no_result', async (t) => {
    const { state, kind } = busyRuns(99);
    const f = await feesOn(t, { offerKinds: new Map([['hash', kind]]) });
    await f.limit();
    const { id } = await listOffer(f);
    const res = await payOffer(f, id);
    const call = await done(f, res.json().callId);
    assert.equal(call.state, 'paid_no_result', JSON.stringify(call));
    assert.equal(call.failure?.code, 'service_unreachable');
    assert.equal(state.runs, 3);
    assert.equal(f.base.balanceOf(TREASURY), 5000n, 'paid once');
  });
  await t.test('any other failure is not run again', async (t) => {
    const { state, kind } = busyRuns(99, 502);
    const f = await feesOn(t, { offerKinds: new Map([['hash', kind]]) });
    await f.limit();
    const { id } = await listOffer(f);
    const res = await payOffer(f, id);
    const call = await done(f, res.json().callId);
    assert.equal(call.state, 'paid_no_result', JSON.stringify(call));
    assert.equal(state.runs, 1);
  });
});

test('the not-yet-final caps: above one, a call waits for finality before it delivers', async (t) => {
  for (const env of [
    // Per seller wallet: one $0.05 sale not final yet; the second waits.
    { CITY_FEED_PAY_UNFINAL_SELLER_MAX_RAW: '50000' },
    // In all: one $0.05 sale not final yet, whoever sells; the second waits.
    { CITY_FEED_PAY_UNFINAL_TOTAL_MAX_RAW: '50000' },
  ]) {
    await t.test(Object.keys(env)[0]!, async (st) => {
      const f = await feesOn(st, { env });
      await f.limit();
      f.base.state.finalizeOnLand = false;
      const first = await listOffer(f);
      const second = await listOffer(f, {
        payTo: 'CITY_FEED_PAY_UNFINAL_TOTAL_MAX_RAW' in env ? OTHER_SELLER : SELLER,
      });
      const a = await payOffer(f, first.id);
      const aCall = await done(f, a.json().callId);
      assert.equal(aCall.state, 'result_saved', 'delivered at inclusion, under the cap');
      assert.equal((await callRow(f, aCall.callId)).pay_final_at, null, 'not final yet');

      const b = await payOffer(f, second.id);
      assert.equal(b.statusCode, 200, b.body);
      const callId = b.json().callId as string;
      let call = (await f.status(callId)).json() as FeedPayCall;
      for (let i = 0; i < 400 && call.state !== 'settled'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        call = (await f.status(callId)).json() as FeedPayCall;
      }
      // Paid (money moved, the fee charged), but not delivered: it waits for finality.
      assert.equal(call.state, 'settled', JSON.stringify(call));
      assert.equal(call.moneyMoved, 'yes');
      assert.equal(call.done, false);
      assert.equal(call.result, null);
      assert.equal(call.protocolFee?.state, 'charged');
      // Time alone never makes it final: the cron runs, Base has not finalized the block.
      for (let i = 0; i < 3; i++) {
        f.advance(20 * 60_000);
        await f.cron();
      }
      assert.equal(((await f.status(callId)).json() as FeedPayCall).state, 'settled');
      // Base finalizes the block (the finalized head passes it, its hash canonical): delivered.
      f.base.state.head += 10n;
      const delivered = await done(f, callId);
      assert.equal(delivered.state, 'result_saved', JSON.stringify(delivered));
      assert.equal(JSON.parse(delivered.result!.text!).hex, HELLO_HEX);
      assert.ok((await callRow(f, callId)).pay_final_at !== null);
      // The cron recorded the first call's finality too.
      assert.ok((await callRow(f, aCall.callId)).pay_final_at !== null);
    });
  }
});

test('a FeeCharged that does not match is a money anomaly: nothing is delivered', async (t) => {
  let runs = 0;
  const counting: OfferKind = {
    ...hashKind,
    async run(input, ctx) {
      runs++;
      return hashKind.run(input, ctx);
    },
  };
  const f = await feesOn(t, { offerKinds: new Map([['hash', counting]]) });
  await f.limit();
  const tampers: Array<[string, (e: FakeFeeEvent) => FakeFeeEvent]> = [
    ['payee', (e) => ({ ...e, payee: OTHER_SELLER })],
    ['gross', (e) => ({ ...e, gross: e.gross - 1n })],
    ['kind', (e) => ({ ...e, kind: 0 })],
    ['emitter', (e) => ({ ...e, emitter: getAddress(`0x${'e1'.repeat(20)}`) })],
  ];
  for (const [name, tamper] of tampers) {
    f.base.state.tamperFeeEvent = tamper;
    const { id } = await listOffer(f);
    const res = await payOffer(f, id);
    assert.equal(res.statusCode, 200, res.body);
    const call = await done(f, res.json().callId);
    assert.equal(call.state, 'paid_no_result', `${name}: ${JSON.stringify(call)}`);
    assert.equal(call.failure?.code, 'payment_unverified', name);
    assert.equal(call.failure?.message, FEED_PAY_FAILURE_MESSAGES.payment_unverified);
    assert.equal(call.moneyMoved, 'yes', `${name}: the operation went out`);
    assert.equal(call.result, null, `${name}: nothing delivered`);
    assert.equal(call.protocolFee?.state, 'failed', name);
    assert.ok(
      f.alerts.some((a) => a.kind === 'payment_anomaly' && a.callId === call.callId),
      `${name}: ops alerted`,
    );
    assert.equal((await callRow(f, call.callId)).delivered_at, null, name);
  }
  assert.equal(runs, 0, 'the kind never ran');
});

test('a bundle with other payments in the same transaction: each call matches only its own FeeCharged', async (t) => {
  const f = await feesOn(t);
  await f.limit();
  const otherPayer = getAddress(`0x${'b2'.repeat(20)}`);
  // Other operations in the same bundle: another payer's fee-included payment to the same seller
  // at the same price, another payer's fee on top, and the same spender's payment of another call.
  f.base.state.bundledFeeEvents = [
    {
      emitter: getAddress(ROUTER),
      payer: otherPayer,
      payee: SELLER,
      ref: keccak256(stringToHex('another-call-1')),
      kind: 1,
      gross: 50000n,
      fee: 5000n,
    },
    {
      emitter: getAddress(ROUTER),
      payer: otherPayer,
      payee: OTHER_SELLER,
      ref: keccak256(stringToHex('another-call-2')),
      kind: 0,
      gross: 20000n,
      fee: 2000n,
    },
  ];
  const { id } = await listOffer(f, { priceRaw: '50000' });
  const first = await payOffer(f, id);
  assert.equal(first.statusCode, 200, first.body);
  const one = await done(f, first.json().callId);
  assert.equal(one.state, 'result_saved', JSON.stringify(one));
  assert.equal(one.protocolFee?.state, 'charged');

  // The same spender's first payment is in the bundle too: a second call still matches only its own.
  const spender = f.base.state.feeCharges[0]!.payer;
  f.base.state.bundledFeeEvents.push({
    emitter: getAddress(ROUTER),
    payer: spender,
    payee: SELLER,
    ref: keccak256(stringToHex(one.callId)),
    kind: 1,
    gross: 50000n,
    fee: 5000n,
  });
  const second = await payOffer(f, id);
  assert.equal(second.statusCode, 200, second.body);
  const two = await done(f, second.json().callId);
  assert.equal(two.state, 'result_saved', JSON.stringify(two));
  assert.equal(two.failure, null);
  assert.equal(two.protocolFee?.state, 'charged');
  const row = await callRow(f, two.callId);
  assert.deepEqual([row.fee_raw, row.fee_state], ['5000', 'charged']);
  assert.ok(row.delivered_at !== null);
  assert.ok(!f.alerts.some((a) => a.kind === 'payment_anomaly'), 'no anomaly');

  // Others' events never stand in for a missing own event: still an anomaly.
  f.base.state.tamperFeeEvent = (e) => ({ ...e, ref: keccak256(stringToHex('not-this-call')) });
  const third = await payOffer(f, id);
  assert.equal(third.statusCode, 200, third.body);
  const three = await done(f, third.json().callId);
  assert.equal(three.state, 'paid_no_result', JSON.stringify(three));
  assert.equal(three.failure?.code, 'payment_unverified');
  assert.equal(three.result, null);
});

test('an offer that is not active, or whose listing no longer matches it, is not found', async (t) => {
  const f = await feesOn(t);
  await f.limit();
  const paused = await listOffer(f, { state: 'paused' });
  const res = await quoteOf(f, paused.id);
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().code, 'service_not_found');
  // The listing's payee changed under the offer: never paid.
  const moved = await listOffer(f);
  await f.sql('UPDATE feed_services SET pay_to = $2 WHERE id = $1', [moved.id, OTHER_SELLER]);
  assert.equal((await quoteOf(f, moved.id)).json().code, 'service_not_found');
  const before = await counts(f);
  const call = await f.callService(
    {
      agentId: f.agentId,
      inputs: HELLO,
      quoteId: `fq_${'a'.repeat(32)}`,
      maxAmountRaw: '50000',
      maxTotalRaw: '50000',
      idempotencyKey: randomUUID(),
    },
    moved.id,
  );
  assert.equal(call.statusCode, 404, call.body);
  assert.deepEqual(await counts(f), before);
});

test('an agent never buys its own service, fee included or not', async (t) => {
  const f = await feesOn(t);
  await f.limit();
  const own = await listOffer(f, { payTo: f.wallet });
  const before = await counts(f);
  f.advance(6_100);
  const quoted = await f.app.inject({
    method: 'POST',
    url: FEED_PAY_PATHS.quote.replace(':id', own.id),
    headers: { 'content-type': 'application/json', 'x-city-request': '1', cookie: f.owner.cookie },
    payload: JSON.stringify({ inputs: HELLO, agentId: f.agentId }),
  });
  assert.equal(quoted.json().reason, 'own_service', quoted.body);
  const q = (await quoteOf(f, own.id)).json();
  const res = await f.callService(
    {
      agentId: f.agentId,
      inputs: HELLO,
      quoteId: q.quoteId,
      maxAmountRaw: q.amount.raw,
      maxTotalRaw: q.total.raw,
      idempotencyKey: randomUUID(),
    },
    own.id,
  );
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().reason, 'own_service');
  assert.deepEqual(await counts(f), before);
});

/*
 * Payment screening of the treasury leg. router.pay moves the treasury's share in the same operation
 * as the seller's, so the resolved treasury is screened before anything is signed: blocked or
 * unavailable refuses the call like the seller leg, and no payment operation is stored or sent.
 */

/** A fake screening provider: listed addresses, and addresses whose check fails (an outage). */
function treasuryScreening(clock: () => number) {
  const state = { listed: new Set<string>(), failing: new Set<string>(), asked: [] as string[][] };
  const provider: ScreeningProvider = {
    ref: 'fake-oracle:test',
    supports: () => true,
    async check({ addresses }) {
      state.asked.push(addresses.map((address) => address.toLowerCase()));
      if (addresses.some((address) => state.failing.has(address.toLowerCase())))
        throw new Error('provider down');
      return {
        listed: Object.fromEntries(
          addresses.map((address) => [address, state.listed.has(address.toLowerCase())]),
        ),
        observedAt: clock(),
      };
    },
  };
  return { state, provider };
}

async function screenedIncluded(t: test.TestContext) {
  let fake: ReturnType<typeof treasuryScreening> | undefined;
  const f = await feesOn(t, {
    env: { CITY_PROTOCOL_SCREENING: undefined, CITY_PROTOCOL_SCREENING_DENY: undefined },
    screeningProvider: () => fake!.provider,
  });
  fake = treasuryScreening(f.clock);
  await f.limit();
  return { f, fake };
}

async function screeningDecisions(f: FeedPayApp) {
  return f.sql<{ outcome: string; reason: string; intent_id: string }>(
    'SELECT outcome, reason, intent_id FROM protocol_screening_decisions ORDER BY decided_at',
  );
}

for (const [outcome, failure] of [
  ['blocked', 'screening_blocked'],
  ['unavailable', 'screening_unavailable'],
] as const) {
  test(`a ${outcome} treasury screening refuses a fee-included call: no payment operation is built or sent`, async (t) => {
    const { f, fake } = await screenedIncluded(t);
    const treasury = TREASURY.toLowerCase();
    if (outcome === 'blocked') fake.state.listed.add(treasury);
    else fake.state.failing.add(treasury);
    const { id } = await listOffer(f, { priceRaw: '50000' });
    const before = await counts(f);
    const res = await payOffer(f, id);
    assert.equal(res.statusCode, 200, res.body);
    const callId = res.json().callId;
    const call = await done(f, callId);

    assert.equal(call.state, 'refused', JSON.stringify(call));
    assert.equal(call.failure?.code, failure);
    assert.equal(call.failure?.message, FEED_PAY_FAILURE_MESSAGES[failure]);
    assert.equal(call.payment, null, 'nothing signed');
    assert.equal(call.result, null, 'nothing delivered');
    const row = await callRow(f, callId);
    assert.equal(row.fee_state, 'not_owed');
    assert.equal(row.fee_op_key, null, 'no payment key was ever taken');
    assert.equal(row.delivered_at, null);

    // No router.pay operation stored, none sent, no money moved to the seller or the treasury.
    const after = await counts(f);
    assert.equal(after.payOps, before.payOps, 'no payment operation built');
    assert.equal(f.base.state.feeCharges.length, 0, 'no router.pay landed');
    assert.equal(f.base.balanceOf(SELLER), 0n);
    assert.equal(f.base.balanceOf(TREASURY), 0n);
    assert.equal(after.requests, before.requests, 'no request anywhere');

    // The seller leg was cleared; the treasury was asked (spender + the router's treasury).
    assert.ok(fake.state.asked.some((addresses) => addresses.includes(SELLER.toLowerCase())));
    assert.ok(fake.state.asked.some((addresses) => addresses.includes(treasury)));
    const rows = await screeningDecisions(f);
    assert.ok(
      rows.some((r) => r.intent_id === `feed-pay:${callId}` && r.outcome === 'allowed'),
      JSON.stringify(rows),
    );
    if (outcome === 'blocked')
      assert.ok(
        rows.some((r) => r.intent_id === `feed-pay:fee:${callId}` && r.outcome === 'blocked'),
        JSON.stringify(rows),
      );
    else
      assert.ok(
        !rows.some((r) => r.intent_id === `feed-pay:fee:${callId}`),
        'an outage is never stored as a decision',
      );

    // Later crons never send it either: the call stays refused.
    for (let i = 0; i < 3; i++) {
      f.advance(2 * 60_000);
      assert.equal((await f.cron()).statusCode, 200);
    }
    assert.equal((await counts(f)).payOps, before.payOps);
    assert.equal(f.base.state.feeCharges.length, 0);
    assert.equal(((await f.status(callId)).json() as FeedPayCall).state, 'refused');
  });
}

test('a cleared treasury screening pays the fee-included call as before', async (t) => {
  const { f, fake } = await screenedIncluded(t);
  const { id } = await listOffer(f, { priceRaw: '50000' });
  const res = await payOffer(f, id);
  assert.equal(res.statusCode, 200, res.body);
  const call = await done(f, res.json().callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  assert.equal(f.base.balanceOf(TREASURY), 5000n);
  assert.ok(fake.state.asked.some((addresses) => addresses.includes(TREASURY.toLowerCase())));
});

// ---------------------------------------------------------------------------------------------
// Operations stored but never claimed for their first send, results Postgres can't hold, and the
// float a payment already in the balance read no longer holds.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface OpRow {
  status: string;
  error_code: string | null;
  user_op_hash: Hex;
  intent_hash: Hex;
}

const opOfKey = async (f: FeedPayApp, key: string): Promise<OpRow | undefined> =>
  (
    await f.sql<OpRow>(
      `SELECT status, error_code, user_op_hash, intent_hash FROM base_chain_ops
       WHERE idempotency_key = $1`,
      [key],
    )
  )[0];

/** The stored operation of a key, waiting (for the background worker) until it is stored. */
async function storedOp(f: FeedPayApp, key: () => Promise<string | null>) {
  for (let i = 0; i < 400; i++) {
    const k = await key();
    const op = k ? await opOfKey(f, k) : undefined;
    if (k && op) return { key: k, op };
    await sleep(5);
  }
  throw new Error('the operation was never stored');
}

const heldNow = (f: FeedPayApp) =>
  floatHeld(f.db, { walletId: f.walletId, block: f.base.state.head });

const walletOf = (f: FeedPayApp) => ({
  walletId: f.walletId,
  address: f.wallet,
  spender: f.base.spender,
  spenderKeyRef: 'unused',
});

/**
 * The app's clock for the crash tests: behind the wall clock the operation store writes with, so
 * the steps right after a crash run well within the recover grace; `done` then moves it past.
 */
const behind = () => ({ now: Date.now() - 5 * 60_000 });

test('a payment stored but never claimed for its send (a crash between): expired after the grace, nothing paid, never sent', async (t) => {
  const f = await feesOn(t, behind());
  await f.limit();
  const { id } = await listOffer(f, { priceRaw: '50000' });
  // The worker stores the router payment, then dies before it claims the send.
  f.base.state.crashBeforeClaim = (key) => key.startsWith('feed-pay:pay:');
  const res = await payOffer(f, id);
  assert.equal(res.statusCode, 200, res.body);
  const callId = res.json().callId as string;
  const { key, op: stuck } = await storedOp(f, async () => `feed-pay:pay:${callId}`);
  assert.equal(stuck.status, 'queued');
  await sleep(50);
  assert.equal((await opOfKey(f, key))!.status, 'queued', 'within the grace it is left alone');
  const [calling] = await f.sql<{ state: string }>(
    'SELECT state FROM feed_pay_calls WHERE call_id = $1',
    [callId],
  );
  assert.equal(calling!.state, 'calling');
  assert.equal(await heldNow(f), 50000n, 'the gross is held while the payment may still go out');
  assert.equal(await hasLiveCalls(f.db, f.walletId), true);

  // From here a claim would run: the expiry alone must keep the operation from ever going out.
  f.base.state.crashBeforeClaim = null;
  const call = await done(f, callId);
  assert.equal(call.state, 'refused', JSON.stringify(call));
  assert.equal(call.moneyMoved, 'no');
  assert.equal(call.failure?.code, 'interrupted');
  const op = (await opOfKey(f, key))!;
  assert.deepEqual([op.status, op.error_code], ['failed', 'EXPIRED_BEFORE_BROADCAST']);
  assert.ok(!f.base.state.sends.includes(op.user_op_hash), 'never sent');
  assert.equal(f.base.balanceOf(SELLER), 0n);
  assert.equal(f.base.balanceOf(TREASURY), 0n);
  // Nothing of the call is held any more: the float is free and a sweep may run.
  assert.equal(await heldNow(f), 0n);
  assert.equal(await hasLiveCalls(f.db, f.walletId), false);

  // A later send of the same key (a retry, a late worker) reconciles the failed row: never sent.
  const sends = f.base.state.sends.length;
  const port = f.base.chainFor(() => f.db);
  const again = await port.routerPay({
    key,
    intentHash: op.intent_hash,
    wallet: walletOf(f),
    calls: [{ to: ROUTER, value: 0n, data: '0x' }],
    beforeBroadcast: async () => {},
  });
  assert.equal(again.status, 'failed');
  assert.equal(again.neverSent, true);
  f.advance(10 * 60_000);
  assert.equal((await f.cron()).statusCode, 200);
  assert.equal(f.base.state.sends.length, sends, 'nothing was sent after the expiry');
  assert.equal((await opOfKey(f, key))!.status, 'failed');
});

test('an expiry that comes after the claim changes nothing: the operation is followed as sent', async (t) => {
  const f = await feesOn(t);
  await f.limit();
  const { id } = await listOffer(f, { priceRaw: '50000' });
  const res = await payOffer(f, id);
  assert.equal(res.statusCode, 200, res.body);
  const call = await done(f, res.json().callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  // Claimed and sent: an expiry asked for now (with any cut-off) never applies.
  const port = f.base.chainFor(() => f.db);
  const op = await port.opStatus(`feed-pay:pay:${call.callId}`, f.walletId, {
    expireQueuedBefore: Date.now() + 3_600_000,
  });
  assert.equal(op?.status, 'final');
  assert.equal(op?.neverSent, false);
});

test('a top-up stored but never claimed for its send: expired after the grace, its hold released, the call refused', async (t) => {
  const f = await feesOn(t, behind());
  await f.limit();
  const { id } = await listOffer(f, { priceRaw: '50000' });
  const walletBefore = f.base.balanceOf(f.wallet);
  f.base.state.crashBeforeClaim = (key) => key.startsWith('feed-pay:top-up:');
  const res = await payOffer(f, id);
  assert.equal(res.statusCode, 200, res.body);
  const callId = res.json().callId as string;
  const { key, op: stuck } = await storedOp(
    f,
    async () =>
      (
        await f.sql<{ op_key: string }>(
          "SELECT op_key FROM feed_pay_float_moves WHERE call_id = $1 AND kind = 'top_up'",
          [callId],
        )
      )[0]?.op_key ?? null,
  );
  assert.equal(stuck.status, 'queued');
  const reservation = async () =>
    (
      await f.sql<{ state: string }>(
        "SELECT state FROM base_wallet_reservations WHERE holder_kind = 'float' AND holder_ref = $1",
        [key],
      )
    )[0]?.state;
  assert.equal(await reservation(), 'held');
  await sleep(50);
  assert.equal((await opOfKey(f, key))!.status, 'queued', 'within the grace it is left alone');
  assert.equal(await reservation(), 'held');
  assert.equal(await topUpInFlight(f.db, f.walletId), true, 'a second top-up waits for this one');

  f.base.state.crashBeforeClaim = null;
  const call = await done(f, callId);
  assert.equal(call.state, 'refused', JSON.stringify(call));
  assert.equal(call.moneyMoved, 'no');
  // The worker ends it as a failed top-up; the cron, when it comes first, as interrupted.
  assert.ok(
    ['float_topup_failed', 'interrupted'].includes(call.failure?.code ?? ''),
    String(call.failure?.code),
  );
  // A call the cron ends leaves its top-up to go on as a float move: once the operation is past
  // the grace, the moves pass expires it.
  f.advance(10 * 60_000);
  assert.equal((await f.cron()).statusCode, 200);
  const op = (await opOfKey(f, key))!;
  assert.deepEqual([op.status, op.error_code], ['failed', 'EXPIRED_BEFORE_BROADCAST']);
  assert.ok(!f.base.state.sends.includes(op.user_op_hash), 'never sent');
  assert.equal(await reservation(), 'released');
  const [move] = await f.sql<{ state: string }>(
    'SELECT state FROM feed_pay_float_moves WHERE op_key = $1',
    [key],
  );
  assert.equal(move!.state, 'failed');
  assert.equal(await topUpInFlight(f.db, f.walletId), false);
  assert.equal(f.base.balanceOf(f.wallet), walletBefore, 'nothing left the wallet');
  assert.equal(f.base.balanceOf(f.base.spender), 0n);

  // A new call tops up and pays as usual.
  const next = await payOffer(f, id);
  assert.equal(next.statusCode, 200, next.body);
  assert.equal((await done(f, next.json().callId)).state, 'result_saved');
});

test('sweeps stored but never claimed for their send: expired, never sent, nothing held, and they never fill the moves page', async (t) => {
  const f = await feesOn(t);
  await f.limit();
  const port = f.base.chainFor(() => f.db);
  // 31 sweeps stored and never claimed: more than one recover page (25) of pending moves.
  f.base.state.crashBeforeClaim = (key) => key.startsWith('feed-pay:sweep:');
  const at = f.clock();
  for (let i = 0; i < 31; i++) {
    const moveId = randomUUID();
    const key = `feed-pay:sweep:${moveId}`;
    const intentHash = keccak256(stringToHex(key));
    await f.sql(
      `INSERT INTO feed_pay_float_moves (move_id, wallet_id, chain_id, kind, amount_raw, op_key,
         intent_hash, state, created_at, updated_at)
       VALUES ($1, $2, $3, 'sweep', 1000, $4, $5, 'pending', $6, $6)`,
      [moveId, f.walletId, CHAIN_ID, key, intentHash, at + i],
    );
    await port
      .sweep({
        key,
        intentHash,
        wallet: walletOf(f),
        amount: 1000n,
        beforeBroadcast: async () => {},
      })
      .catch(() => null);
  }
  const count = async (sql: string) => (await f.sql<{ n: string }>(sql))[0]!.n;
  assert.equal(
    await count(
      "SELECT count(*)::text AS n FROM base_chain_ops WHERE kind = 'sweep' AND status = 'queued'",
    ),
    '31',
  );
  f.base.state.crashBeforeClaim = null;
  const sends = f.base.state.sends.length;
  assert.equal(await heldNow(f), 31_000n, 'the sweeps are held while they may still go out');
  f.advance(2 * 60_000);
  assert.equal((await f.cron()).statusCode, 200);
  assert.equal((await f.cron()).statusCode, 200);
  assert.equal(
    await count(
      "SELECT count(*)::text AS n FROM feed_pay_float_moves WHERE kind = 'sweep' AND state = 'pending'",
    ),
    '0',
    'every stuck move left the pending set',
  );
  assert.equal(
    await count(
      `SELECT count(*)::text AS n FROM base_chain_ops
       WHERE kind = 'sweep' AND status = 'failed' AND error_code = 'EXPIRED_BEFORE_BROADCAST'`,
    ),
    '31',
  );
  assert.equal(f.base.state.sends.length, sends, 'none of them was sent');
  assert.equal(await heldNow(f), 0n, 'nothing of them is held any more');
});

test('a NUL in a decoded answer is refused before payment: nothing reserved, signed or sent', async (t) => {
  const f = await feesOn(t);
  const permission = await f.limit();
  assert.equal((await f.consent(permission.hash)).statusCode, 200);
  const { id: b64 } = await listOffer(f, { kind: 'base64' });
  const { id: url } = await listOffer(f, { kind: 'url-encode' });
  const before = await counts(f);
  for (const [id, text] of [
    [b64, 'AA=='],
    [url, '%00'],
  ] as const) {
    const quoted = await quoteOf(f, id, { body: { text, mode: 'decode' } });
    assert.equal(quoted.statusCode, 400, quoted.body);
    assert.equal(quoted.json().code, 'invalid_inputs');
    f.advance(12_100);
    const mcp = await f.tool(f.main.token, 'city_service_call', {
      service_id: id,
      agent_id: f.agentId,
      inputs: { body: { text, mode: 'decode' } },
      max_price_usdc: '0.05',
      idempotency_key: randomUUID(),
    });
    assert.equal(mcp.statusCode, 400, mcp.body);
    assert.equal(mcp.json().code, 'invalid_inputs');
  }
  assert.deepEqual(await counts(f), before);
  assert.equal(f.base.state.signatures, 0);
  // Without a NUL the same decode is paid and saved as before.
  const ok = await payOffer(f, b64, { body: { text: 'aGk=', mode: 'decode' } });
  assert.equal(ok.statusCode, 200, ok.body);
  const call = await done(f, ok.json().callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  assert.equal(call.result?.text, 'hi');
});

/**
 * A paid call that ended paid_no_result: paid exactly once (one payment operation, one FeeCharged,
 * 90/10), terminal, no result kept; recover passes after it send nothing, pay nothing and leave it
 * as it is.
 */
async function paidOnceNoResult(f: FeedPayApp, callId: string) {
  const once = async () => {
    const call = (await f.status(callId)).json() as FeedPayCall;
    assert.equal(call.state, 'paid_no_result', JSON.stringify(call));
    assert.equal(call.done, true);
    assert.equal(call.failure?.code, 'no_result');
    assert.equal(call.moneyMoved, 'yes');
    assert.equal(call.result, null);
    assert.deepEqual(
      f.base.state.feeCharges.map((c) => [c.kind, c.gross, c.fee]),
      [[1, 50000n, 5000n]],
    );
    assert.equal(f.base.balanceOf(SELLER), 45000n);
    assert.equal(f.base.balanceOf(TREASURY), 5000n);
    const [row] = await f.sql<{ state: string; result_text: string | null }>(
      'SELECT state, result_text FROM feed_pay_calls WHERE call_id = $1',
      [callId],
    );
    assert.deepEqual([row!.state, row!.result_text], ['paid_no_result', null]);
  };
  await once();
  const before = await counts(f);
  assert.equal(before.payOps, 1);
  for (let i = 0; i < 3; i++) {
    f.advance(10 * 60_000);
    assert.equal((await f.cron()).statusCode, 200);
  }
  assert.deepEqual(await counts(f), before, 'no second payment, nothing sent again');
  await once();
  assert.equal(
    f.alerts.filter((a) => a.kind === 'paid_no_result' && a.callId === callId).length,
    1,
    'alerted once',
  );
}

test('a NUL that reaches delivery anyway (a kind that skips its check) ends paid_no_result once', async (t) => {
  let runs = 0;
  const nul: OfferKind = {
    ...hashKind,
    async run() {
      runs++;
      return { body: 'a\u0000b', mime: 'text/plain' };
    },
  };
  const f = await feesOn(t, { offerKinds: new Map([['hash', nul]]) });
  await f.limit();
  const { id } = await listOffer(f);
  const res = await payOffer(f, id);
  assert.equal(res.statusCode, 200, res.body);
  const call = await done(f, res.json().callId);
  assert.equal(call.state, 'paid_no_result', JSON.stringify(call));
  assert.equal(call.failure?.code, 'no_result');
  assert.equal(call.moneyMoved, 'yes');
  await paidOnceNoResult(f, call.callId);
  assert.equal(runs, 1, 'the kind is not run again on every recover pass');
});

test('a result the database refuses for good (22021) ends paid_no_result instead of failing every pass', async (t) => {
  let runs = 0;
  const marked: OfferKind = {
    ...hashKind,
    async run() {
      runs++;
      return { body: 'refused-by-the-database', mime: 'text/plain' };
    },
  };
  const f = await feesOn(t, { offerKinds: new Map([['hash', marked]]) });
  // The database refuses this text as it refuses a NUL (invalid byte sequence, 22021).
  await f.sql(`CREATE OR REPLACE FUNCTION refuse_marked_result() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.result_text = 'refused-by-the-database' THEN
        RAISE EXCEPTION 'invalid byte sequence' USING ERRCODE = '22021';
      END IF;
      RETURN NEW;
    END $fn$ LANGUAGE plpgsql`);
  await f.sql(`CREATE TRIGGER refuse_marked_result BEFORE UPDATE ON feed_pay_calls
    FOR EACH ROW EXECUTE FUNCTION refuse_marked_result()`);
  await f.limit();
  const { id } = await listOffer(f);
  const res = await payOffer(f, id);
  assert.equal(res.statusCode, 200, res.body);
  const call = await done(f, res.json().callId);
  assert.equal(call.state, 'paid_no_result', JSON.stringify(call));
  assert.equal(call.failure?.code, 'no_result');
  assert.equal(call.moneyMoved, 'yes');
  await paidOnceNoResult(f, call.callId);
  assert.equal(runs, 1, 'ended: the kind is not run again on every recover pass');
});

test('floatHeld: a fee-included call paid at or before the balance read no longer holds its price', async (t) => {
  const f = await feesOn(t);
  await f.limit();
  const { id } = await listOffer(f, { priceRaw: '50000' });
  const res = await payOffer(f, id);
  assert.equal(res.statusCode, 200, res.body);
  const call = await done(f, res.json().callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  // The same call as it is between its inclusion and its delivery: 'settled', paid in block N.
  const [paid] = await f.sql<{ settled_block: string }>(
    `UPDATE feed_pay_calls SET state = 'settled', delivered_at = NULL
     WHERE call_id = $1 RETURNING settled_block::text AS settled_block`,
    [call.callId],
  );
  const block = BigInt(paid!.settled_block);
  const at = (b: bigint) => floatHeld(f.db, { walletId: f.walletId, block: b });
  // A balance read at N or later already shows the gross gone: nothing is held for it.
  assert.equal(await at(block), 0n);
  assert.equal(await at(block + 5n), 0n);
  // A read before N still holds it: the price (45000) and the fee inside it (5000).
  assert.equal(await at(block - 1n), 50000n);
  // Its block not known: held.
  await f.sql(
    'UPDATE feed_pay_calls SET settled_block = NULL, fee_block = NULL WHERE call_id = $1',
    [call.callId],
  );
  assert.equal(await at(block + 5n), 50000n);
  // Still a live call for a sweep while its delivery is pending.
  assert.equal(await hasLiveCalls(f.db, f.walletId), true);
});

/**
 * One operation of `kind` stored through the chain side whose first-send claim crashes: it is left
 * 'queued', never sent. A top-up holds its amount on the wallet (holder 'float', ref = key).
 */
async function queuedOp(f: FeedPayApp, kind: 'pay' | 'top-up' | 'sweep'): Promise<string> {
  const port = f.base.chainFor(() => f.db);
  const key = `race:${kind}:${randomUUID()}`;
  const intentHash = keccak256(stringToHex(key));
  const beforeBroadcast = async () => {};
  f.base.state.crashBeforeClaim = (k) => k === key;
  let send: Promise<unknown>;
  if (kind === 'pay')
    send = port.routerPay({
      key,
      intentHash,
      wallet: walletOf(f),
      calls: [{ to: ROUTER, value: 0n, data: '0x' }],
      beforeBroadcast,
    });
  else if (kind === 'sweep')
    send = port.sweep({ key, intentHash, wallet: walletOf(f), amount: 1000n, beforeBroadcast });
  else {
    // The wallet's one active limit (the test's f.limit()).
    const [row] = await f.sql<{ id: string; permission: Record<string, string | number> }>(
      'SELECT permission_id AS id, permission FROM base_spend_permissions WHERE wallet_id = $1',
      [f.walletId],
    );
    const id = row!.id;
    send = port.topUp({
      key,
      intentHash,
      wallet: walletOf(f),
      limit: {
        permissionId: id,
        permission: permissionOf(row!.permission),
        state: 'signed',
        signature: `0x${'ab'.repeat(65)}`,
      },
      amount: 1000n,
      beforeBroadcast,
    });
  }
  await assert.rejects(send, /synthetic crash before the claim/);
  f.base.state.crashBeforeClaim = null;
  assert.equal((await opOfKey(f, key))?.status, 'queued');
  return key;
}

const floatHold = async (f: FeedPayApp, key: string) =>
  (
    await f.sql<{ state: string }>(
      "SELECT state FROM base_wallet_reservations WHERE holder_kind = 'float' AND holder_ref = $1",
      [key],
    )
  )[0]?.state;

for (const kind of ['pay', 'top-up', 'sweep'] as const) {
  test(`the expiry of a queued ${kind} and its first-send claim: exactly one wins, no release when the claim does`, async (t) => {
    const f = await feesOn(t);
    await f.limit();
    const port = f.base.chainFor(() => f.db);
    // The claim of submit.ts authorizeAndSend, as it is made right before the first send.
    const ops = pgChainOperationStore(f.db);
    const claim = (key: string) => ops.transition(key, ['queued'], { status: 'submitted' });
    // Any cut-off: the row's age is not what decides between the two, the status is.
    const expire = (key: string) =>
      port.opStatus(key, f.walletId, { expireQueuedBefore: Date.now() + 3_600_000 });
    const holdBefore = kind === 'top-up' ? 'held' : undefined;

    /** The claim won: the row is in flight, followed by reconciliation, nothing released. */
    const claimWon = async (key: string, op: Awaited<ReturnType<typeof expire>>) => {
      assert.equal(op?.neverSent, false);
      assert.notEqual(op?.status, 'failed');
      const row = (await opOfKey(f, key))!;
      assert.equal(row.status, 'submitted');
      assert.equal(row.error_code, null);
      assert.equal(await floatHold(f, key), holdBefore, 'nothing released');
    };
    /** The expiry won: failed before any send; the claim can no longer take it. */
    const expiryWon = async (key: string, op: Awaited<ReturnType<typeof expire>>) => {
      assert.equal(op?.neverSent, true);
      const row = (await opOfKey(f, key))!;
      assert.deepEqual([row.status, row.error_code], ['failed', 'EXPIRED_BEFORE_BROADCAST']);
      assert.ok(!f.base.state.sends.includes(row.user_op_hash), 'never sent');
      assert.equal(await claim(key), null, 'a later claim loses');
      assert.equal(await floatHold(f, key), kind === 'top-up' ? 'released' : undefined);
    };

    await t.test('the claim first', async () => {
      const key = await queuedOp(f, kind);
      assert.ok(await claim(key));
      await claimWon(key, await expire(key));
    });
    await t.test('the expiry first', async () => {
      const key = await queuedOp(f, kind);
      await expiryWon(key, await expire(key));
    });
    await t.test('both at once', async () => {
      for (let i = 0; i < 4; i++) {
        const key = await queuedOp(f, kind);
        // Started together in both orders: whichever compare-and-set lands first wins.
        const [claimed, op] =
          i % 2 === 0
            ? await Promise.all([claim(key), expire(key)])
            : await Promise.all([expire(key), claim(key)]).then(([o, c]) => [c, o] as const);
        assert.notEqual(claimed !== null, op?.neverSent, 'exactly one wins');
        if (claimed) await claimWon(key, op);
        else await expiryWon(key, op);
      }
    });
  });
}
