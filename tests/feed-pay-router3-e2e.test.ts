import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createFeedPayEngine } from '../server/feed/pay/engine.js';
import { getAddress, keccak256, stringToHex, type Hex } from 'viem';
import { feedServiceId } from '../server/feed/bazaar.js';
import { feedPayKey } from '../server/feed/pay/engine.js';
import { ROUTER3_VALIDITY_S, router3Nonce } from '../server/feed/pay/router3.js';
import { floatHeld } from '../server/feed/pay/store.js';
import { HOSTED_SOURCE } from '../server/feed/types.js';
import { offerInputSummary, offerOutputSummary } from '../shared/feed-offers.js';
import type { FeedPayCall } from '../shared/feed-pay.js';
import { PROTOCOL_BASE_MAINNET } from '../shared/protocol.js';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network.js';
import { BODY, setup, type FeedPayApp } from './helpers/feed-pay-app.js';

/*
 * Fee router 3, end to end (docs/protocol/FEE_ROUTER_3.md): the real engine and chain side over
 * the fake Base, with router 3 deployed, verified on chain and switched on, and the fake
 * facilitator wired into the engine's `facilitator` dep. A service sold by a Central City agent
 * (fee included) is pinned to router 3: the spender account signs the two bound EIP-3009 legs and
 * the facilitator sends one settle (no UserOperation for the payment), seller 90%, treasury 10%.
 * Without router 3 ready everything stays on routers 1 and 2 as before; a settlement that did not
 * go through ends unpaid only past its window; a leg used outside the router is an anomaly.
 *
 * Synthetic data; nothing reaches a network.
 */

const ROUTER = PROTOCOL_BASE_MAINNET.feeRouter;
const ROUTER2 = getAddress(`0x${'42'.repeat(20)}`);
const ROUTER3 = getAddress(`0x${'43'.repeat(20)}`);
const TREASURY = PROTOCOL_BASE_MAINNET.treasury;
const SELLER = getAddress(`0x${'5e'.repeat(20)}`);
const ORIGIN = 'https://centralcity.ai';
const HELLO = { body: { text: 'hello' } };
const HELLO_HEX = createHash('sha256').update('hello', 'utf8').digest('hex');

let offerSeq = 0;
function newOfferId(): string {
  const B = 'abcdefghijklmnopqrstuvwxyz234567';
  let n = ++offerSeq + 29000;
  let tail = '';
  for (let i = 0; i < 16; i++) {
    tail = B[n % 32] + tail;
    n = Math.floor(n / 32);
  }
  return `off_${tail}`;
}

interface AppOptions {
  /** CITY_PROTOCOL_FEE_ROUTER3_ENABLED = '1' (default true). */
  router3?: boolean;
  finalityPerRun?: number;
  /** Router 2 configured, deployed and switched on too (default true). */
  router2?: boolean;
}

async function app(t: test.TestContext, options: AppOptions = {}): Promise<FeedPayApp> {
  const r3 = options.router3 ?? true;
  const r2 = options.router2 ?? true;
  const f = await setup(t, {
    env: {
      CITY_PROTOCOL_FEES: undefined,
      CITY_PROTOCOL_FEE_ROUTER2: r2 ? ROUTER2 : undefined,
      CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK: r2 ? '1' : undefined,
      CITY_PROTOCOL_FEE_ROUTER2_ENABLED: r2 ? '1' : undefined,
      CITY_PROTOCOL_FEE_ROUTER3: ROUTER3,
      CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK: '1',
      CITY_PROTOCOL_FEE_ROUTER3_ENABLED: r3 ? '1' : undefined,
    },
    funds: 200_000_000n,
    cap: 200_000_000n,
    facilitator: true,
    ...(options.finalityPerRun !== undefined ? { finalityPerRun: options.finalityPerRun } : {}),
  });
  f.base.state.feeRouter = { router: ROUTER, treasury: TREASURY };
  if (r2) {
    f.base.state.feeRouter2 = { router: ROUTER2, treasury: TREASURY };
    f.base.state.code.add(ROUTER2.toLowerCase());
  }
  f.base.state.feeRouter3 = { router: ROUTER3, treasury: TREASURY };
  f.base.state.code.add(ROUTER3.toLowerCase()); // a contract at router 3's address
  await f.limit(200_000_000n);
  await allowPerCall(f, 100_000_000n);
  return f;
}

/** The owner allows this agent up to `raw` per call (above 0.10 only possible with router 2 live). */
async function allowPerCall(f: FeedPayApp, raw: bigint) {
  await f.sql(
    `INSERT INTO feed_pay_agent_settings (wallet_id, per_call_max_raw, changed_by, changed_at, updated_at)
     VALUES ($1, $2, 'owner', $3, $3)
     ON CONFLICT (wallet_id) DO UPDATE SET per_call_max_raw = EXCLUDED.per_call_max_raw`,
    [f.walletId, raw.toString(), f.clock()],
  );
}

/** An offer of a seller agent and its Feed listing, as the offers store writes them. */
async function listOffer(f: FeedPayApp, priceRaw: string) {
  const offerId = newOfferId();
  const url = `${ORIGIN}/api/public/x402/${offerId}`;
  const id = feedServiceId(url);
  const at = f.clock();
  await f.sql(
    `INSERT INTO city_offers (offer_id, operator_id, agent_id, wallet_id, pay_to, kind, title,
       description, tags, price_raw, discoverable, version, state, idem_key, risky,
       price_changed_at, created_at, updated_at, preset)
     VALUES ($1, 'op-seller', 'agent-seller', 'wallet-seller', $2, 'hash', 'Text hash',
       'The SHA-256 of a text.', '{}', $3, true, 1, 'active', $1, NULL, $4, $4, $4, NULL)`,
    [offerId, SELLER, priceRaw, at],
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
      priceRaw,
      SELLER,
      JSON.stringify(offerInputSummary('hash', null)),
      JSON.stringify(offerOutputSummary('hash')),
      at,
      SELLER.toLowerCase(),
    ],
  );
  return id;
}

/** Quote then the confirmed body (as the drawer sends it). */
async function confirmed(f: FeedPayApp, id: string, inputs: unknown = HELLO) {
  const q = await f.quote(inputs, id);
  assert.equal(q.statusCode, 200, q.body);
  assert.equal(q.json().payable, true, q.body);
  return {
    agentId: f.agentId,
    inputs,
    quoteId: q.json().quoteId as string,
    maxAmountRaw: q.json().amount.raw as string,
    maxTotalRaw: q.json().total.raw as string,
    idempotencyKey: randomUUID(),
  };
}

const statusOf = async (f: FeedPayApp, callId: string) =>
  (await f.status(callId)).json() as FeedPayCall;

/** Waits (real time) until no worker holds the call any more: its background work stopped. */
async function idle(f: FeedPayApp, callId: string) {
  for (let i = 0; i < 2000; i++) {
    const [row] = await f.sql<{ lease_until: string }>(
      'SELECT lease_until::text AS lease_until FROM feed_pay_calls WHERE call_id = $1',
      [callId],
    );
    if (Number(row!.lease_until) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the worker did not stop');
}

/** POST call with a confirmed body; answers the call once its background work stopped. */
async function callAndWait(f: FeedPayApp, id: string, body: Record<string, unknown>) {
  const res = await f.callService(body, id);
  assert.equal(res.statusCode, 200, res.body);
  const callId = res.json().callId as string;
  await idle(f, callId);
  return statusOf(f, callId);
}

async function buy(f: FeedPayApp, id: string, inputs: unknown = HELLO) {
  const body = await confirmed(f, id, inputs);
  return { body, call: await callAndWait(f, id, body) };
}

/** Runs the cron every two minutes until the call is done (at most `rounds` times). */
async function cronUntilDone(f: FeedPayApp, callId: string, rounds = 8): Promise<FeedPayCall> {
  for (let i = 0; i < rounds; i++) {
    const call = await statusOf(f, callId);
    if (call.done) return call;
    f.advance(2 * 60_000);
    assert.equal((await f.cron()).statusCode, 200);
  }
  return statusOf(f, callId);
}

const rowOf = async (f: FeedPayApp, callId: string) =>
  (
    await f.sql<{
      fee_router: string | null;
      state: string;
      payment_state: string | null;
      fee_op_key: string | null;
      failure_code: string | null;
    }>(
      'SELECT fee_router, state, payment_state, fee_op_key, failure_code FROM feed_pay_calls WHERE call_id = $1',
      [callId],
    )
  )[0]!;

/** The router-3 legs stored for a call's pay key (seller first), as Base would see them. */
async function legsOf(f: FeedPayApp, callId: string) {
  const key = (await rowOf(f, callId)).fee_op_key ?? feedPayKey(callId, 0);
  return f.sql<{
    payment_intent_id: string;
    from_address: string;
    to_address: string;
    value: string;
    valid_after: string;
    valid_before: string;
    nonce: string;
    signature: string;
  }>(
    `SELECT payment_intent_id, from_address, to_address, value::text AS value,
       valid_after::text AS valid_after, valid_before::text AS valid_before, nonce,
       encode(signature, 'hex') AS signature
     FROM base_x402_authorizations WHERE payment_intent_id IN ($1, $2)
     ORDER BY payment_intent_id DESC`,
    [`${key}:seller`, `${key}:fee`],
  );
}

const authorizationCount = async (f: FeedPayApp) =>
  Number(
    (await f.sql<{ n: string }>('SELECT count(*)::text AS n FROM base_x402_authorizations'))[0]!.n,
  );

/** UserOperation effects that paid through a router (router 1/2 'pay' or 'fee', or router 3). */
const routerUserOps = (f: FeedPayApp) =>
  f.base.state.effects.filter((e) => e === 'pay' || e === 'fee' || e === 'router3_userop');

const heldNow = (f: FeedPayApp) =>
  floatHeld(f.db, { walletId: f.walletId, block: f.base.state.head });

/** The spender account's address on the fake Base (the payer of every router-3 leg). */
const payer = (f: FeedPayApp) => getAddress(f.base.spender);

// -------------------------------------------------------------------------------------------

test('router 3 on: a 1 USDC hosted service is pinned to router 3, settled by the facilitator (no payment UserOp), 90/10, delivered; both legs stored with the router nonces and one window', async (t) => {
  const f = await app(t);
  const id = await listOffer(f, '1000000');
  const seller0 = f.base.balanceOf(SELLER);
  const treasury0 = f.base.balanceOf(TREASURY);
  const { call: first } = await buy(f, id);
  const call = first.done ? first : await cronUntilDone(f, first.callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  assert.equal(call.payment?.amountRaw, '1000000');
  assert.equal(JSON.parse(call.result!.text!).hex, HELLO_HEX);

  const row = await rowOf(f, call.callId);
  assert.equal(row.fee_router, ROUTER3.toLowerCase(), 'pinned to router 3');
  assert.equal(f.base.balanceOf(SELLER) - seller0, 900_000n, 'seller +0.90');
  assert.equal(f.base.balanceOf(TREASURY) - treasury0, 100_000n, 'treasury +0.10');
  assert.deepEqual(routerUserOps(f), [], 'no UserOperation paid the call');
  assert.equal(f.base.state.facilitator.broadcasts, 1, 'one settlement');
  const charge = f.base.state.feeCharges.at(-1)!;
  assert.deepEqual(
    [charge.router, charge.kind, charge.gross, charge.fee, charge.ref],
    [ROUTER3, 1, 1_000_000n, 100_000n, keccak256(stringToHex(call.callId))],
  );

  // The two stored authorizations: the router-derived nonces, one window for both.
  const legs = await legsOf(f, call.callId);
  assert.equal(legs.length, 2);
  const [seller, fee] = legs as [(typeof legs)[0], (typeof legs)[0]];
  assert.ok(seller.payment_intent_id.endsWith(':seller'));
  assert.ok(fee.payment_intent_id.endsWith(':fee'));
  assert.equal(seller.valid_after, fee.valid_after);
  assert.equal(seller.valid_before, fee.valid_before);
  assert.equal(seller.valid_after, '0');
  const validBefore = BigInt(seller.valid_before);
  assert.ok(validBefore > 0n && validBefore <= BigInt(Math.floor(f.clock() / 1000)) + 600n);
  for (const [leg, stored, to, value] of [
    [0, seller, SELLER, '900000'],
    [1, fee, TREASURY, '100000'],
  ] as const) {
    assert.equal(getAddress(stored.from_address), payer(f));
    assert.equal(getAddress(stored.to_address), getAddress(to));
    assert.equal(stored.value, value);
    const nonce = router3Nonce({
      chainId: WALLET_CHAIN_ID,
      router: ROUTER3,
      treasury: TREASURY,
      payer: payer(f),
      payee: SELLER,
      gross: 1_000_000n,
      ref: keccak256(stringToHex(call.callId)),
      validAfter: 0n,
      validBefore,
      leg,
    });
    assert.equal(stored.nonce.toLowerCase(), nonce.toLowerCase(), `leg ${leg} nonce`);
  }
  // The settlement carried exactly the stored signatures.
  const sent = f.base.state.facilitator.submits.at(-1)!;
  assert.equal(sent.settlement.sellerSignature.toLowerCase(), `0x${seller.signature}`);
  assert.equal(sent.settlement.feeSignature.toLowerCase(), `0x${fee.signature}`);
  assert.equal(await heldNow(f), 0n, 'nothing held once paid');
});

for (const [price, perCall] of [
  [50_000n, 100_000_000n],
  [50_000_000n, 100_000_000n],
] as const)
  test(`router 3 on: a ${Number(price) / 1e6} USDC hosted service goes through router 3 too`, async (t) => {
    const f = await app(t);
    await allowPerCall(f, perCall);
    const id = await listOffer(f, price.toString());
    const seller0 = f.base.balanceOf(SELLER);
    const treasury0 = f.base.balanceOf(TREASURY);
    const { call: first } = await buy(f, id);
    const call = first.done ? first : await cronUntilDone(f, first.callId);
    assert.equal(call.state, 'result_saved', JSON.stringify(call));
    assert.equal((await rowOf(f, call.callId)).fee_router, ROUTER3.toLowerCase());
    assert.equal(f.base.balanceOf(SELLER) - seller0, price - price / 10n);
    assert.equal(f.base.balanceOf(TREASURY) - treasury0, price / 10n);
    assert.deepEqual(routerUserOps(f), []);
    assert.equal((await legsOf(f, call.callId)).length, 2);
  });

// Router 3 not ready: exactly the router 1 / router 2 paths, never a router-3 signature.
for (const [label, prepare] of [
  ['switch off', { router3: false }],
  ['facilitator absent', (f: FeedPayApp) => void (f.base.state.facilitator.present = false)],
  ['facilitator cannot pay', (f: FeedPayApp) => void (f.base.state.facilitator.canPay = false)],
  [
    'nonceFor differs on chain',
    (f: FeedPayApp) => void (f.base.state.feeRouter3!.nonceFor = 'mismatch'),
  ],
] as const)
  test(`router 3 not ready (${label}): 1 USDC pinned to router 2, 0.05 to router 1, router 3 never signed`, async (t) => {
    const f = await app(t, typeof prepare === 'function' ? {} : prepare);
    if (typeof prepare === 'function') prepare(f);
    for (const [price, router] of [
      [1_000_000n, ROUTER2],
      [50_000n, ROUTER],
    ] as const) {
      const id = await listOffer(f, price.toString());
      const seller0 = f.base.balanceOf(SELLER);
      const { call: first } = await buy(f, id);
      const call = first.done ? first : await cronUntilDone(f, first.callId);
      assert.equal(call.state, 'result_saved', JSON.stringify(call));
      assert.equal((await rowOf(f, call.callId)).fee_router, router.toLowerCase());
      assert.equal(f.base.balanceOf(SELLER) - seller0, price - price / 10n);
      assert.equal((await legsOf(f, call.callId)).length, 0, 'no router-3 legs');
      const charge = f.base.state.feeCharges.at(-1)!;
      assert.deepEqual([charge.router, charge.kind], [router, 1]);
    }
    assert.equal(f.base.state.facilitator.submits.length, 0, 'the facilitator was never asked');
    assert.equal(await authorizationCount(f), 0, 'nothing signed off-chain');
  });

test('fee on top (an external x402 service) never uses router 3', async (t) => {
  const f = await app(t);
  for (const amount of ['20000', '1000000']) {
    await f.list({ amount, paid: 'settle' });
    const body = await confirmed(f, 'svc_aaaaaaaaaaaaaaaaaaaa', BODY);
    const first = await callAndWait(f, 'svc_aaaaaaaaaaaaaaaaaaaa', body);
    const call = first.done ? first : await cronUntilDone(f, first.callId);
    assert.equal(call.state, 'result_saved', JSON.stringify(call));
    const router = (await rowOf(f, call.callId)).fee_router;
    assert.notEqual(router, ROUTER3.toLowerCase(), `${amount}: never router 3`);
    assert.equal((await legsOf(f, call.callId)).length, 0);
  }
  assert.equal(f.base.state.facilitator.submits.length, 0);
  assert.ok(f.base.state.feeCharges.every((c) => c.router !== ROUTER3 && c.kind === 0));
});

test('a crash between the legs and submit: every retry gets the SAME pair, no second authorization; it ends unpaid only past the window', async (t) => {
  const f = await app(t);
  const id = await listOffer(f, '1000000');
  f.base.state.facilitator.crashBeforeSubmit = () => true;
  const seller0 = f.base.balanceOf(SELLER);
  const { body, call: first } = await buy(f, id);
  assert.equal(first.done, false, JSON.stringify(first));
  const row = await rowOf(f, first.callId);
  assert.equal(row.fee_router, ROUTER3.toLowerCase());
  assert.equal(row.payment_state, 'sent');
  const legs = await legsOf(f, first.callId);
  assert.equal(legs.length, 2, 'the pair was stored before submit');
  assert.equal(await authorizationCount(f), 2);
  assert.ok(f.clock() < Number(legs[0]!.valid_before) * 1000, 'still inside the window');
  f.advance(2 * 60_000);
  assert.equal((await f.cron()).statusCode, 200);
  assert.equal((await statusOf(f, first.callId)).done, false, 'waits while the pair is valid');

  // The legs step again for the same key (as a resumed sendRouter3 would): the stored pair.
  const port = f.base.chainFor(() => f.db);
  const again = await port.router3Legs({
    key: row.fee_op_key!,
    wallet: {
      walletId: f.walletId,
      address: getAddress(f.wallet),
      spender: payer(f),
      spenderKeyRef: 'v1:00000000-0000-4000-8000-000000000001',
    },
    router: ROUTER3,
    treasury: TREASURY,
    payee: SELLER,
    gross: 1_000_000n,
    fee: 100_000n,
    ref: keccak256(stringToHex(first.callId)),
    validitySeconds: ROUTER3_VALIDITY_S,
  });
  assert.equal(again.seller.authorization.nonce.toLowerCase(), legs[0]!.nonce);
  assert.equal(again.fee.authorization.nonce.toLowerCase(), legs[1]!.nonce);
  assert.equal(again.seller.authorization.validBefore, BigInt(legs[0]!.valid_before));
  assert.equal((again.seller.signature as Hex).toLowerCase(), `0x${legs[0]!.signature}`);

  // A same-key call and the cron follow it: never a second pair, never paid.
  f.base.state.facilitator.crashBeforeSubmit = null;
  await callAndWait(f, id, body);
  const call = await cronUntilDone(f, first.callId);
  assert.deepEqual(await legsOf(f, first.callId), legs, 'the same pair');
  assert.equal(await authorizationCount(f), 2, 'no second authorization rows');
  assert.equal(f.base.state.facilitator.broadcasts, 0, 'nothing ever went out');
  assert.equal(call.done, true, JSON.stringify(call));
  assert.equal(call.state, 'refused', JSON.stringify(call));
  assert.notEqual(call.moneyMoved, 'yes');
  assert.equal(f.base.balanceOf(SELLER), seller0);
  assert.equal(await heldNow(f), 0n, 'the float is free again');
});

test('a reverted settlement with its legs unused: waits inside the window, then ends cancelled with nothing paid and the float released', async (t) => {
  const f = await app(t);
  const id = await listOffer(f, '1000000');
  f.base.state.facilitator.mode = 'revert';
  const seller0 = f.base.balanceOf(SELLER);
  const treasury0 = f.base.balanceOf(TREASURY);
  const { call: first } = await buy(f, id);
  const legs = await legsOf(f, first.callId);
  assert.equal(legs.length, 2);
  const validBeforeMs = Number(legs[0]!.valid_before) * 1000;
  // The work followed it for its budget: still inside the window, it waits (not ended).
  assert.ok(f.clock() < validBeforeMs, 'still inside the window');
  assert.equal(first.done, false, JSON.stringify(first));
  f.advance(2 * 60_000);
  assert.equal((await f.cron()).statusCode, 200);
  assert.ok(f.clock() < validBeforeMs);
  let call = await statusOf(f, first.callId);
  assert.equal(call.done, false, `waits while the pair may still be used: ${JSON.stringify(call)}`);
  assert.equal((await rowOf(f, first.callId)).payment_state, 'sent');
  assert.ok((await heldNow(f)) > 0n, 'the price stays held meanwhile');

  // Past validBefore with Base's safe block past it too: both nonces unused, the call ends.
  f.advance(validBeforeMs - f.clock() + 30_000);
  call = await cronUntilDone(f, first.callId);
  assert.equal(call.done, true, JSON.stringify(call));
  assert.equal(call.state, 'cancelled', JSON.stringify(call));
  assert.equal(call.failure?.code, 'payment_rejected');
  assert.notEqual(call.moneyMoved, 'yes');
  assert.equal(f.base.balanceOf(SELLER), seller0, 'nothing paid to the seller');
  assert.equal(f.base.balanceOf(TREASURY), treasury0, 'nothing paid to the treasury');
  assert.equal(await heldNow(f), 0n, 'the float is released');
  assert.equal(await authorizationCount(f), 2, 'never re-signed');
  assert.equal(f.base.state.facilitator.broadcasts, 1, 'never sent again');
});

test('a leg used outside the router after a revert: paid_no_result / payment_unverified anomaly, never re-signed', async (t) => {
  const f = await app(t);
  const id = await listOffer(f, '1000000');
  f.base.state.facilitator.mode = 'revert';
  const { call: first } = await buy(f, id);
  const legs = await legsOf(f, first.callId);
  assert.equal(legs.length, 2);
  // Someone holding the seller leg submits it to USDC directly (transferWithAuthorization).
  await f.base.useLater({
    from: getAddress(legs[0]!.from_address),
    to: getAddress(legs[0]!.to_address),
    value: BigInt(legs[0]!.value),
    validAfter: BigInt(legs[0]!.valid_after),
    validBefore: BigInt(legs[0]!.valid_before),
    nonce: legs[0]!.nonce as Hex,
    signature: `0x${legs[0]!.signature}`,
  });
  const call = await cronUntilDone(f, first.callId);
  assert.equal(call.state, 'paid_no_result', JSON.stringify(call));
  assert.equal(call.failure?.code, 'payment_unverified');
  assert.ok(
    f.alerts.some((a) => a.kind === 'payment_anomaly' && a.callId === first.callId),
    JSON.stringify(f.alerts),
  );
  assert.equal(await authorizationCount(f), 2, 'never re-signed');
  assert.equal(f.base.state.facilitator.broadcasts, 1, 'never sent again');
  assert.deepEqual(routerUserOps(f), [], 'never sent through router 1 or 2');
});

test('the FEE leg used outside the router after a revert: anomaly too, never re-signed or re-routed', async (t) => {
  const f = await app(t);
  const id = await listOffer(f, '1000000');
  f.base.state.facilitator.mode = 'revert';
  const { call: first } = await buy(f, id);
  const legs = await legsOf(f, first.callId);
  const fee = legs.find((l) => l.payment_intent_id.endsWith(':fee'))!;
  await f.base.useLater({
    from: getAddress(fee.from_address),
    to: getAddress(fee.to_address),
    value: BigInt(fee.value),
    validAfter: BigInt(fee.valid_after),
    validBefore: BigInt(fee.valid_before),
    nonce: fee.nonce as Hex,
    signature: `0x${fee.signature}`,
  });
  const call = await cronUntilDone(f, first.callId);
  assert.equal(call.state, 'paid_no_result', JSON.stringify(call));
  assert.equal(call.failure?.code, 'payment_unverified');
  assert.equal(await authorizationCount(f), 2, 'never re-signed');
  assert.equal(f.base.state.facilitator.broadcasts, 1, 'never sent again');
  assert.deepEqual(routerUserOps(f), [], 'never sent through router 1 or 2');
});

for (const tamper of ['drop', 'wrongToken', 'wrongRecipient', 'wrongAmount'] as const)
  test(`a router-3 receipt with FeeCharged but a ${tamper} fee-leg USDC Transfer fails closed: an anomaly, never paid`, async (t) => {
    const f = await app(t);
    const id = await listOffer(f, '1000000');
    f.base.state.router3FeeTransfer = tamper;
    const { call: first } = await buy(f, id);
    const call = first.done ? first : await cronUntilDone(f, first.callId);
    assert.equal(call.state, 'paid_no_result', JSON.stringify(call));
    assert.equal(call.failure?.code, 'payment_unverified');
    assert.ok(f.alerts.some((a) => a.kind === 'payment_anomaly' && a.callId === first.callId));
  });

test('router 3 switched off while a settlement is in flight: that call still settles on router 3; new calls use router 2', async (t) => {
  const f = await app(t);
  const id = await listOffer(f, '1000000');
  f.base.state.facilitator.mode = 'hold';
  const { call: first } = await buy(f, id);
  assert.equal(first.done, false, JSON.stringify(first));
  assert.equal((await rowOf(f, first.callId)).fee_router, ROUTER3.toLowerCase());
  // The switch goes off (rollback = new admissions only, room x402 #41/#44).
  delete process.env.CITY_PROTOCOL_FEE_ROUTER3_ENABLED;
  f.base.state.facilitator.mode = 'land';
  await f.base.landHeld();
  const call = await cronUntilDone(f, first.callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  assert.equal((await rowOf(f, call.callId)).fee_router, ROUTER3.toLowerCase());
  assert.equal(f.base.state.facilitator.broadcasts, 1, 'the one settlement, never re-sent');
  const { call: next } = await buy(f, id);
  const done = next.done ? next : await cronUntilDone(f, next.callId);
  assert.equal(done.state, 'result_saved', JSON.stringify(done));
  assert.equal((await rowOf(f, next.callId)).fee_router, ROUTER2.toLowerCase());
});

test('a worker restart with the treasury binding unreadable: a landed router-3 payment stays pending, then delivers (review #64)', async (t) => {
  const f = await app(t);
  const id = await listOffer(f, '1000000');
  f.base.state.facilitator.mode = 'hold';
  const { call: first } = await buy(f, id);
  assert.equal(first.done, false, JSON.stringify(first));
  await f.base.landHeld();
  // A new worker: its router binding cache is empty, and the binding read fails right now.
  const restarted = createFeedPayEngine({
    db: f.db,
    env: process.env,
    now: f.clock,
    chain: async () => f.base.chainFor(() => f.db),
    facilitator: async () => f.base.facilitatorFor(() => f.db),
    alert: (alert) => void f.alerts.push(alert),
    sleep: async () => {},
  });
  f.base.state.routerReadsDown = true;
  f.advance(2 * 60_000);
  await restarted.recover();
  const waiting = await rowOf(f, first.callId);
  assert.notEqual(waiting.failure_code, 'payment_unverified', JSON.stringify(waiting));
  assert.equal(waiting.payment_state, 'sent', 'still pending, not an anomaly');
  assert.ok(!f.alerts.some((a) => a.kind === 'payment_anomaly'), JSON.stringify(f.alerts));
  // The binding is readable again: the same payment is verified and delivered.
  f.base.state.routerReadsDown = false;
  for (let i = 0; i < 4 && (await rowOf(f, first.callId)).state !== 'result_saved'; i++) {
    f.advance(2 * 60_000);
    await restarted.recover();
  }
  const call = await statusOf(f, first.callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  assert.equal(f.base.state.facilitator.broadcasts, 1, 'the one settlement');
});

test('a settlement stored but never sent (queued, no tx) is submitted again under the same key and settles once (room x402 #208)', async (t) => {
  const f = await app(t);
  const id = await listOffer(f, '1000000');
  f.base.state.facilitator.mode = 'queued';
  const { call: first } = await buy(f, id);
  assert.equal(first.done, false, JSON.stringify(first));
  assert.equal(f.base.state.facilitator.broadcasts, 0, 'nothing sent yet');
  // Base answers again: the next step asks the facilitator once more with the same key.
  f.base.state.facilitator.mode = 'land';
  const call = await cronUntilDone(f, first.callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  assert.equal(f.base.state.facilitator.broadcasts, 1, 'sent exactly once');
  const keys = new Set(f.base.state.facilitator.submits.map((s) => s.key));
  assert.equal(keys.size, 1, 'one key, never a new settlement');
  assert.equal(await authorizationCount(f), 2, 'the one signed pair');
});

test('beforeBroadcast refuses (the limit revoked right before the send): nothing sent, the call ends refused', async (t) => {
  const f = await app(t);
  const id = await listOffer(f, '1000000');
  f.base.state.facilitator.beforeSubmit = async () => {
    await f.sql(
      `UPDATE base_spend_permissions SET state = 'revoked', revoked_block = 1
       WHERE wallet_id = $1 AND state <> 'revoked'`,
      [f.walletId],
    );
  };
  const seller0 = f.base.balanceOf(SELLER);
  const { call: first } = await buy(f, id);
  assert.equal(f.base.state.facilitator.broadcasts, 0, 'nothing sent');
  const call = first.done ? first : await cronUntilDone(f, first.callId);
  assert.equal(call.done, true, JSON.stringify(call));
  assert.equal(call.state, 'refused', JSON.stringify(call));
  assert.notEqual(call.moneyMoved, 'yes');
  assert.equal(f.base.balanceOf(SELLER), seller0);
  assert.equal(f.base.state.feeCharges.length, 0);
  assert.equal(f.base.state.facilitator.broadcasts, 0, 'never sent');
  assert.equal(await authorizationCount(f), 2, 'the one pair, never re-signed');
  const [row] = await f.sql<{ payment_state: string | null; fee_state: string }>(
    'SELECT payment_state, fee_state FROM feed_pay_calls WHERE call_id = $1',
    [call.callId],
  );
  assert.deepEqual([row!.payment_state, row!.fee_state], [null, 'not_owed'], 'nothing held for it');
  // The revoked limit sends the float back to the agent wallet, like any other unpaid call's.
  const sweeps = await f.sql<{ reason: string }>(
    "SELECT reason FROM feed_pay_float_moves WHERE kind = 'sweep' AND wallet_id = $1",
    [f.walletId],
  );
  assert.deepEqual(
    sweeps.map((m) => m.reason),
    ['limit_changed'],
  );
});

// Router 3 alone (router 2 off) carries prices above 0.10: perCallCap counts router 3 too.
test('router 3 live, router 2 off: a 1 USDC hosted service is quoted AND paid through router 3', async (t) => {
  const f = await app(t, { router2: false });
  const id = await listOffer(f, '1000000');
  const body = await confirmed(f, id);
  const res = await f.callService(body, id);
  assert.equal(res.statusCode, 200, res.body);
  await idle(f, res.json().callId);
  const call = await cronUntilDone(f, res.json().callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  assert.equal((await rowOf(f, call.callId)).fee_router, ROUTER3.toLowerCase());
});

// Room x402 #250/#253: a readiness READ failure (cold instance, RPC hiccup) must never reroute a
// router-3 call to routers 1/2. One retry; still failing, the call is refused 'unavailable'.
for (const [label, fail] of [
  [
    'the router probe',
    (f: FeedPayApp, n: number) => void (f.base.state.feeRouter3!.nonceForFailures = n),
  ],
  [
    'the facilitator balance',
    (f: FeedPayApp, n: number) => void (f.base.state.facilitator.canPayFailures = n),
  ],
  [
    'the router 3 treasury read',
    (f: FeedPayApp, n: number) => void (f.base.state.feeRouter3!.treasuryFailures = n),
  ],
  [
    'building the facilitator',
    (f: FeedPayApp, n: number) => void (f.base.state.facilitator.buildFailures = n),
  ],
] as const) {
  test(`router 3: ${label} failing at the purchase is retried once and the call still goes through router 3`, async (t) => {
    const f = await app(t);
    const id = await listOffer(f, '1000000');
    // Three failing reads from a cold start: the quote's, the purchase's availability read, then
    // the purchase's first router 3 attempt. Its one retry answers.
    fail(f, 3);
    const { call: first } = await buy(f, id);
    const call = first.done ? first : await cronUntilDone(f, first.callId);
    assert.equal(call.state, 'result_saved', JSON.stringify(call));
    assert.equal((await rowOf(f, call.callId)).fee_router, ROUTER3.toLowerCase());
    assert.deepEqual(routerUserOps(f), []);
  });

  test(`router 3: ${label} failing on every read refuses the call 'unavailable', never router 2; the next try uses router 3`, async (t) => {
    const f = await app(t);
    const id = await listOffer(f, '1000000');
    // Failing from before the quote (nothing verified or cached yet: a cold instance) until after
    // the refusal: the purchase's two reads both fail.
    fail(f, 99);
    const body = await confirmed(f, id);
    const refused = await f.callService(body, id);
    assert.notEqual(refused.statusCode, 200, refused.body);
    assert.match(refused.body, /unavailable/);
    const { rows } = await f.db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM feed_pay_calls',
    );
    assert.equal(rows[0]?.n, '0', 'nothing pinned or reserved');
    assert.equal(f.base.state.facilitator.submits.length, 0);
    assert.equal(await authorizationCount(f), 0);
    assert.equal(f.base.state.feeCharges.length, 0, 'no router 1/2 payment either');
    // Base answers again: the same request now settles through router 3.
    fail(f, 0);
    const call = await callAndWait(f, id, body);
    const done = call.done ? call : await cronUntilDone(f, call.callId);
    assert.equal(done.state, 'result_saved', JSON.stringify(done));
    assert.equal((await rowOf(f, done.callId)).fee_router, ROUTER3.toLowerCase());
  });
}

test('router 3: a facilitator that can pay is asked once per 30 s, not on every call', async (t) => {
  const f = await app(t);
  for (const price of ['1000000', '2000000', '3000000']) {
    const id = await listOffer(f, price);
    const { call: first } = await buy(f, id);
    const call = first.done ? first : await cronUntilDone(f, first.callId);
    assert.equal((await rowOf(f, call.callId)).fee_router, ROUTER3.toLowerCase());
  }
  assert.ok(
    f.base.state.facilitator.canPayCalls <= 2,
    `canPay read ${f.base.state.facilitator.canPayCalls} times`,
  );
});

/** Settled router-3 calls of one offer, delivered (their pay_final_at cleared for the test). */
async function settledCalls(f: FeedPayApp, n: number): Promise<string[]> {
  const id = await listOffer(f, '1000000');
  const calls: string[] = [];
  for (let i = 0; i < n; i++) {
    const { call: first } = await buy(f, id);
    const call = first.done ? first : await cronUntilDone(f, first.callId);
    assert.equal(call.state, 'result_saved', JSON.stringify(call));
    calls.push(call.callId);
  }
  // fee_verified as the ledger scan leaves it: the per-call sweep then leaves these delivered calls
  // alone until FEED_PAY_FINALITY_WAIT_MS, so only the bulk step can record their finality here.
  await f.sql(
    'UPDATE feed_pay_calls SET pay_final_at = NULL, fee_verified = true WHERE call_id = ANY($1::text[])',
    [calls],
  );
  return calls;
}

/**
 * Writes each call's x402_facilitator_ops row as the facilitator's batch would leave it (the fake
 * keeps its settlements in memory; the engine's bulk step only reads this table).
 */
async function finalOps(
  f: FeedPayApp,
  calls: string[],
  shape: (callId: string) => { status?: string; error?: string | null; tx?: string; block?: string; chain?: number } = () => ({}),
) {
  const rows = await f.sql<{ call_id: string; tx_hash: string; settled_block: string; key: string }>(
    `SELECT call_id, tx_hash, settled_block::text AS settled_block,
       COALESCE(fee_op_key, 'feed-pay:pay:' || call_id) AS key
     FROM feed_pay_calls WHERE call_id = ANY($1::text[])`,
    [calls],
  );
  for (const r of rows) {
    const s = shape(r.call_id);
    await f.sql(
      `INSERT INTO x402_facilitator_ops (op_key, intent_hash, chain_id, facilitator, router, calldata,
         status, tx_hash, block_number, error_code, created_at, updated_at)
       VALUES ($1, $2, $3, '0xfac', $4, '0x', $5, $6, $7::numeric, $8, $9, $9)
       ON CONFLICT (op_key) DO UPDATE SET chain_id = EXCLUDED.chain_id, status = EXCLUDED.status,
         tx_hash = EXCLUDED.tx_hash, block_number = EXCLUDED.block_number,
         error_code = EXCLUDED.error_code`,
      [
        r.key,
        `0x${'1'.repeat(64)}`,
        s.chain ?? WALLET_CHAIN_ID,
        ROUTER3.toLowerCase(),
        s.status ?? 'final',
        s.tx ?? r.tx_hash,
        s.block ?? r.settled_block,
        s.error ?? null,
        f.clock(),
      ],
    );
  }
}

const finalAt = async (f: FeedPayApp, callId: string) =>
  (
    await f.sql<{ v: string | null }>(
      'SELECT pay_final_at::text AS v FROM feed_pay_calls WHERE call_id = $1',
      [callId],
    )
  )[0]!.v;

test('bulk finality: only a final op on this chain with the same tx AND block records pay_final_at', async (t) => {
  const f = await app(t);
  const calls = await settledCalls(f, 6);
  const [match, wrongTx, wrongBlock, otherChain, reverted, already] = calls as [
    string, string, string, string, string, string,
  ];
  await finalOps(f, calls, (id) =>
    id === wrongTx
      ? { tx: `0x${'ab'.repeat(32)}` }
      : id === wrongBlock
        ? { block: '1' }
        : id === otherChain
          ? { chain: 84532 }
          : id === reverted
            ? { status: 'failed', error: 'REVERTED' }
            : {},
  );
  await f.sql('UPDATE feed_pay_calls SET pay_final_at = 12345 WHERE call_id = $1', [already]);
  // No time passes: the per-call sweep does not take these calls (recover grace), only the bulk step.
  assert.equal((await f.cron()).statusCode, 200);
  assert.notEqual(await finalAt(f, match), null, 'final op, same tx and block: recorded');
  assert.equal(await finalAt(f, wrongTx), null, 'another tx hash: untouched');
  assert.equal(await finalAt(f, wrongBlock), null, 'another block: untouched');
  assert.equal(await finalAt(f, otherChain), null, 'an op of another chain: untouched');
  assert.equal(await finalAt(f, reverted), null, 'reverted op: never final');
  assert.equal(await finalAt(f, already), '12345', 'already final: untouched');
});

test('bulk finality records at most finalityPerRun calls per recover run, oldest settled first', async (t) => {
  const f = await app(t, { finalityPerRun: 1 });
  const [older, newer] = (await settledCalls(f, 2)) as [string, string];
  await finalOps(f, [older, newer]);
  assert.equal((await f.cron()).statusCode, 200);
  assert.notEqual(await finalAt(f, older), null, 'the older one first');
  assert.equal(await finalAt(f, newer), null, 'the quota is one per run');
  assert.equal((await f.cron()).statusCode, 200);
  assert.notEqual(await finalAt(f, newer), null, 'the next run takes the rest');
});
