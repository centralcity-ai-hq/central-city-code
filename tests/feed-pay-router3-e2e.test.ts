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
import { BODY, setup, withEnv, type FeedPayApp } from './helpers/feed-pay-app.js';

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
// Base mainnet: routers 2 and 3 are fixed in code (shared/protocol.ts); their settings are ignored.
const ROUTER2 = PROTOCOL_BASE_MAINNET.feeRouter2;
const ROUTER3 = PROTOCOL_BASE_MAINNET.feeRouter3;
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

// The batch lane (CITY_PAY_BATCH_WORKSPACES): a router-3 Feed call of an allowlisted workspace
// asks the facilitator for it, so its settlement waits and goes out in one settleBatch with others.
for (const allowlisted of [true, false])
  test(`router 3, buyer ${allowlisted ? 'on' : 'NOT on'} the batch allowlist: two paid calls go out in ${allowlisted ? 'ONE settleBatch' : 'two single settles'}, each 90/10 and delivered`, async (t) => {
    const f = await app(t);
    f.base.state.facilitator.batch = { maxItems: 2 };
    withEnv(t, { CITY_PAY_BATCH_WORKSPACES: allowlisted ? `ws-other,${f.owner.id}` : 'ws-other' });
    const id = await listOffer(f, '1000000');
    const seller0 = f.base.balanceOf(SELLER);
    const treasury0 = f.base.balanceOf(TREASURY);
    // The spender's float holds both prices, so the second call never waits for the first to land.
    f.base.credit(f.base.spender, 2_000_000n);
    const first = (await buy(f, id)).call;
    const second = (await buy(f, id)).call;
    const calls = [];
    for (const c of [first, second]) calls.push(c.done ? c : await cronUntilDone(f, c.callId));
    for (const call of calls) {
      assert.equal(call.state, 'result_saved', JSON.stringify(call));
      assert.equal(JSON.parse(call.result!.text!).hex, HELLO_HEX);
      assert.equal((await rowOf(f, call.callId)).fee_router, ROUTER3.toLowerCase());
    }
    assert.equal(f.base.balanceOf(SELLER) - seller0, 1_800_000n, 'seller +0.90 twice');
    assert.equal(f.base.balanceOf(TREASURY) - treasury0, 200_000n, 'treasury +0.10 twice');
    assert.deepEqual(routerUserOps(f), [], 'no UserOperation paid a call');
    const fac = f.base.state.facilitator;
    assert.deepEqual(
      [...new Set(fac.submits.map((s) => s.batched))],
      [allowlisted],
      'the batch lane asked exactly for the allowlisted buyer',
    );
    if (allowlisted) {
      assert.equal(fac.broadcasts, 1, 'one settleBatch');
      assert.equal(fac.batches.length, 1);
      assert.equal(fac.batches[0]!.length, 2, 'both calls in it');
    } else {
      assert.equal(fac.broadcasts, 2, 'each call its own settle');
      assert.equal(fac.batches.length, 0);
    }
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

test('CCA-731: a router-3 call planned again never signs a new pair while the earlier pair is open; its legs are cancelled on USDC first, then it is paid once', async (t) => {
  const f = await app(t);
  const id = await listOffer(f, '1000000');
  f.base.state.facilitator.crashBeforeSubmit = () => true;
  const seller0 = f.base.balanceOf(SELLER);
  const { body, call: first } = await buy(f, id);
  const legs = await legsOf(f, first.callId);
  assert.equal(legs.length, 2, 'the first pair was signed and stored');
  assert.ok(f.clock() < Number(legs[0]!.valid_before) * 1000, 'still inside the window');
  // The call as planPayAgain leaves it: back to 'reserved', no operation key, attempt 1.
  await f.sql(
    `UPDATE feed_pay_calls SET state = 'reserved', payment_state = NULL, fee_state = 'pending',
       fee_op_key = NULL, pay_attempts = 1, pay_retry_at = NULL, updated_at = updated_at + 1
     WHERE call_id = $1`,
    [first.callId],
  );
  await f.sql(
    `UPDATE base_payments SET state = 'created' WHERE payment_id = (
       SELECT payment_id FROM feed_pay_calls WHERE call_id = $1)`,
    [first.callId],
  );
  f.base.state.facilitator.crashBeforeSubmit = null;
  // The same-key call resumes it (the cron never plans a new payment).
  await callAndWait(f, id, body);
  const call = await cronUntilDone(f, first.callId);
  const canceled = (nonce: string) =>
    f.base.state.canceled.has(`${payer(f).toLowerCase()}:${nonce}`);
  assert.ok(
    legs.every((leg) => canceled(leg.nonce.toLowerCase())),
    'both earlier legs cancelled on USDC before a new pair',
  );
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  assert.equal(await authorizationCount(f), 4, 'one new pair, signed after the cancels');
  assert.equal(f.base.balanceOf(SELLER) - seller0, 900_000n, 'paid exactly once');
});

/** The engine's log lines (console.info, its default sink) for the rest of the test. */
function engineLines(t: test.TestContext) {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  t.after(() => {
    console.info = original;
  });
  return lines;
}

/** A router-3 call whose first pair is stored and unsent, then planned again (attempt 1). */
async function plannedAgain(f: FeedPayApp, id: string) {
  f.base.state.facilitator.crashBeforeSubmit = () => true;
  const { body, call } = await buy(f, id);
  const legs = await legsOf(f, call.callId);
  assert.equal(legs.length, 2);
  await f.sql(
    `UPDATE feed_pay_calls SET state = 'reserved', payment_state = NULL, fee_state = 'pending',
       fee_op_key = NULL, pay_attempts = 1, pay_retry_at = NULL, updated_at = updated_at + 1
     WHERE call_id = $1`,
    [call.callId],
  );
  await f.sql(
    `UPDATE base_payments SET state = 'created' WHERE payment_id = (
       SELECT payment_id FROM feed_pay_calls WHERE call_id = $1)`,
    [call.callId],
  );
  f.base.state.facilitator.crashBeforeSubmit = null;
  return { body, callId: call.callId, legs };
}

test('CCA-731: when cancelAuthorization cannot be sent, no new pair is signed; the call stays reserved, then ends unpaid past the window', async (t) => {
  const f = await app(t);
  const lines = engineLines(t);
  const id = await listOffer(f, '1000000');
  const seller0 = f.base.balanceOf(SELLER);
  const { body, callId, legs } = await plannedAgain(f, id);
  // Every cancel is refused by the provider (nothing is stored or sent).
  f.base.state.prepareErrors.push(
    ...Array.from({ length: 200 }, () => new Error('paymaster refused')),
  );
  await callAndWait(f, id, body);
  const row = (
    await f.sql<{ state: string; pay_attempts: number; fee_op_key: string | null }>(
      'SELECT state, pay_attempts, fee_op_key FROM feed_pay_calls WHERE call_id = $1',
      [callId],
    )
  )[0]!;
  assert.deepEqual(
    { state: row.state, attempts: Number(row.pay_attempts), key: row.fee_op_key },
    { state: 'reserved', attempts: 1, key: null },
    'held before anything new is signed',
  );
  assert.equal(await authorizationCount(f), 2, 'no second pair');
  assert.equal(f.base.state.effects.filter((e) => e === 'cancel').length, 0, 'no cancel landed');
  assert.ok(
    lines.some((l) => l.includes('feed_pay.router3_resign_held')),
    JSON.stringify(lines),
  );
  // Past the earlier window (and the pay retry window): it ends unpaid, still never re-signed.
  f.base.state.prepareErrors.length = 0;
  f.advance(Number(legs[0]!.valid_before) * 1000 - f.clock() + 60_000);
  await callAndWait(f, id, body);
  const call = await statusOf(f, callId);
  assert.equal(call.done, true, JSON.stringify(call));
  assert.notEqual(call.moneyMoved, 'yes');
  assert.equal(await authorizationCount(f), 2, 'never re-signed');
  assert.equal(f.base.balanceOf(SELLER), seller0, 'nothing paid');
});

test('CCA-731: an earlier leg Base shows USED is only logged; no new pair is ever signed and nothing is paid again', async (t) => {
  const f = await app(t);
  const lines = engineLines(t);
  const id = await listOffer(f, '1000000');
  const { body, callId, legs } = await plannedAgain(f, id);
  const [seller] = legs as [(typeof legs)[0]];
  // Someone holding the seller leg submits it to USDC directly.
  await f.base.useLater({
    from: getAddress(seller.from_address),
    to: getAddress(seller.to_address),
    value: BigInt(seller.value),
    validAfter: BigInt(seller.valid_after),
    validBefore: BigInt(seller.valid_before),
    nonce: seller.nonce as Hex,
    signature: `0x${seller.signature}`,
  });
  const sellerAfterUse = f.base.balanceOf(SELLER);
  await callAndWait(f, id, body);
  assert.equal(await authorizationCount(f), 2, 'no new pair');
  assert.equal(f.base.state.facilitator.broadcasts, 0, 'no settlement sent');
  assert.ok(
    lines.some(
      (l) =>
        l.includes('feed_pay.router3_earlier_leg_used') &&
        l.includes(callId) &&
        l.includes('"leg":"seller"'),
    ),
    JSON.stringify(lines),
  );
  f.advance(Number(seller.valid_before) * 1000 - f.clock() + 60_000);
  await callAndWait(f, id, body);
  assert.equal(await authorizationCount(f), 2, 'never re-signed');
  assert.equal(f.base.balanceOf(SELLER), sellerAfterUse, 'paid once at most, by the used leg');
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

test('a correct router-3 settlement submitted by someone else after our revert: checked like our own receipt, paid and delivered, not an anomaly (CCA-738)', async (t) => {
  const f = await app(t);
  const id = await listOffer(f, '1000000');
  f.base.state.facilitator.mode = 'revert';
  const seller0 = f.base.balanceOf(SELLER);
  const treasury0 = f.base.balanceOf(TREASURY);
  const { call: first } = await buy(f, id);
  const sent = f.base.state.facilitator.submits.at(-1)!;
  // Another sender takes the broadcast pair and calls router 3 with it: FeeCharged plus both legs.
  await f.base.router3SettledBy(f.db, sent.key, sent.settlement);
  const call = await cronUntilDone(f, first.callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  assert.equal(call.failure ?? null, null, JSON.stringify(call));
  assert.equal(JSON.parse(call.result!.text!).hex, HELLO_HEX);
  assert.equal(f.base.balanceOf(SELLER) - seller0, 900_000n);
  assert.equal(f.base.balanceOf(TREASURY) - treasury0, 100_000n);
  assert.ok(!f.alerts.some((a) => a.kind === 'payment_anomaly'), JSON.stringify(f.alerts));
  const [row] = await f.sql<{ tx_hash: string; fee_state: string; pay_final_at: string | null }>(
    'SELECT tx_hash, fee_state, pay_final_at::text FROM feed_pay_calls WHERE call_id = $1',
    [first.callId],
  );
  assert.equal(row!.tx_hash, keccak256(stringToHex(`feed-pay-router3-${sent.key}`)).toLowerCase());
  assert.equal(row!.fee_state, 'charged');
  assert.notEqual(row!.pay_final_at, null, 'settled only once final');
  assert.equal(await authorizationCount(f), 2, 'never re-signed');
  assert.equal(await heldNow(f), 0n, 'nothing held once paid');
});

test('a router-3 leg used long after signing is still found: the search starts at the block stored at signing, not head minus 2,000 (CCA-739)', async (t) => {
  const f = await app(t);
  const id = await listOffer(f, '1000000');
  f.base.state.facilitator.mode = 'revert';
  const { call: first } = await buy(f, id);
  const legs = await legsOf(f, first.callId);
  const [seller] = legs as [(typeof legs)[0]];
  await f.base.useLater({
    from: getAddress(seller.from_address),
    to: getAddress(seller.to_address),
    value: BigInt(seller.value),
    validAfter: BigInt(seller.valid_after),
    validBefore: BigInt(seller.valid_before),
    nonce: seller.nonce as Hex,
    signature: `0x${seller.signature}`,
  });
  // Base moves on far past the use (a worker that was down), then the window ends.
  f.base.state.head += 2_500n;
  f.advance(Number(seller.valid_before) * 1000 - f.clock() + 30_000);
  const call = await cronUntilDone(f, first.callId);
  assert.equal(call.state, 'paid_no_result', JSON.stringify(call));
  assert.equal(call.failure?.code, 'payment_unverified');
  assert.ok(
    f.alerts.some(
      (a) =>
        a.kind === 'payment_anomaly' &&
        a.callId === first.callId &&
        a.detail === 'fee_charged_mismatch',
    ),
    JSON.stringify(f.alerts),
  );
});

test('a router-3 leg Base shows used with no event in the searched window: an anomaly with its own alert, never left pending (CCA-739)', async (t) => {
  const f = await app(t);
  const id = await listOffer(f, '1000000');
  f.base.state.facilitator.mode = 'revert';
  const { call: first } = await buy(f, id);
  const legs = await legsOf(f, first.callId);
  const [seller] = legs as [(typeof legs)[0]];
  // The use lands beyond the 2,000 blocks searched from signing (as a log index with a gap would
  // show it): only authorizationState knows.
  f.base.state.head += 2_500n;
  await f.base.useLater({
    from: getAddress(seller.from_address),
    to: getAddress(seller.to_address),
    value: BigInt(seller.value),
    validAfter: BigInt(seller.valid_after),
    validBefore: BigInt(seller.valid_before),
    nonce: seller.nonce as Hex,
    signature: `0x${seller.signature}`,
  });
  f.base.state.head += 10n; // the use is below Base's safe block
  f.advance(Number(seller.valid_before) * 1000 - f.clock() + 30_000);
  const call = await cronUntilDone(f, first.callId);
  assert.equal(call.state, 'paid_no_result', JSON.stringify(call));
  assert.equal(call.failure?.code, 'payment_unverified');
  assert.ok(
    f.alerts.some(
      (a) =>
        a.kind === 'payment_anomaly' &&
        a.callId === first.callId &&
        a.detail === 'authorization_used_unseen',
    ),
    JSON.stringify(f.alerts),
  );
  assert.equal(await authorizationCount(f), 2, 'never re-signed');
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

test('router3PreSign (the sponsored path): reserved payee, screening of payee and treasury, router 3 probe and treasury pin, fail closed', async (t) => {
  const f = await app(t);
  const SPONSOR = getAddress(`0x${'5a'.repeat(20)}`);
  const asked: { intentId: string; parties: { role: string; address: string }[] }[] = [];
  let blocked: string | null = null;
  let down = false;
  const screening = {
    screen: async (req: { intentId: string; parties: { role: string; address: string }[] }) => {
      asked.push({ intentId: req.intentId, parties: req.parties });
      const hit = req.parties.some((p) => p.address.toLowerCase() === blocked);
      return {
        allowed: !down && !hit,
        outcome: down ? 'unavailable' : hit ? 'blocked' : 'allowed',
        decisionId: down ? null : 'd1',
        reason: down ? 'provider_unavailable' : hit ? 'sanctioned' : 'clear',
        expiresAt: f.clock() + 60_000,
        reused: false,
      };
    },
  } as unknown as NonNullable<Parameters<typeof createFeedPayEngine>[0]['screening']>;
  const engine = createFeedPayEngine({
    db: f.db,
    env: { ...process.env, CITY_PROTOCOL_SCREENING: '1' },
    now: f.clock,
    chain: async () => f.base.chainFor(() => f.db),
    alert: (alert) => void f.alerts.push(alert),
    sleep: async () => {},
    screening,
  });
  const input = {
    intentId: 'sfp:sp_test',
    payer: SPONSOR,
    payee: SELLER,
    grossRaw: 1_000_000n,
    feeRaw: 100_000n,
  };
  // Clear: the seller leg (payer, payee) and the fee leg (payer, the router's treasury) screened.
  assert.equal(await engine.router3PreSign(input), null);
  assert.deepEqual(asked, [
    {
      intentId: 'sfp:sp_test',
      parties: [
        { role: 'payer', address: SPONSOR },
        { role: 'payee', address: SELLER },
      ],
    },
    {
      intentId: 'sfp:sp_test:fee',
      parties: [
        { role: 'payer', address: SPONSOR },
        { role: 'fee_recipient', address: TREASURY.toLowerCase() },
      ],
    },
  ]);
  // A reserved payee, before any screening.
  asked.length = 0;
  assert.equal(await engine.router3PreSign({ ...input, payee: ROUTER3 }), 'payee_reserved');
  assert.equal(asked.length, 0);
  // Screening blocks the payee, or the treasury; an unavailable answer fails closed.
  blocked = SELLER.toLowerCase();
  assert.equal(await engine.router3PreSign(input), 'screening_blocked');
  blocked = TREASURY.toLowerCase();
  assert.equal(await engine.router3PreSign(input), 'screening_blocked');
  blocked = null;
  down = true;
  assert.equal(await engine.router3PreSign(input), 'screening_unavailable');
  down = false;
  // Router 3 pays another treasury than the one fixed in code: held, nothing signed.
  const other = createFeedPayEngine({
    db: f.db,
    env: { ...process.env, CITY_PROTOCOL_SCREENING: '1' },
    now: f.clock,
    chain: async () => f.base.chainFor(() => f.db),
    alert: (alert) => void f.alerts.push(alert),
    sleep: async () => {},
    screening,
  });
  f.base.state.feeRouter3 = { router: ROUTER3, treasury: getAddress(`0x${'7d'.repeat(20)}`) };
  assert.equal(await other.router3PreSign(input), 'hold');
  // Router 3 with no code, or Base unreadable: held.
  f.base.state.feeRouter3 = { router: ROUTER3, treasury: TREASURY };
  f.base.state.code.delete(ROUTER3.toLowerCase());
  const third = createFeedPayEngine({
    db: f.db,
    env: { ...process.env, CITY_PROTOCOL_SCREENING: '1' },
    now: f.clock,
    chain: async () => f.base.chainFor(() => f.db),
    alert: (alert) => void f.alerts.push(alert),
    sleep: async () => {},
    screening,
  });
  assert.equal(await third.router3PreSign(input), 'hold');
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
  shape: (callId: string) => {
    status?: string;
    error?: string | null;
    tx?: string;
    block?: string;
    chain?: number;
  } = () => ({}),
) {
  const rows = await f.sql<{
    call_id: string;
    tx_hash: string;
    settled_block: string;
    key: string;
  }>(
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
    string,
    string,
    string,
    string,
    string,
    string,
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
