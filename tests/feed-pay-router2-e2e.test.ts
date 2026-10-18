import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { getAddress, keccak256, stringToHex } from 'viem';
import { feedServiceId } from '../server/feed/bazaar.js';
import { HOSTED_SOURCE } from '../server/feed/types.js';
import { offerInputSummary, offerOutputSummary } from '../shared/feed-offers.js';
import type { FeedPayCall } from '../shared/feed-pay.js';
import { PROTOCOL_BASE_MAINNET } from '../shared/protocol.js';
import { BODY, setup, type FeedPayApp } from './helpers/feed-pay-app.js';

/*
 * Operation Fee Contract, end to end: the real app, engine and chain side over the fake Base, with
 * fee router 2 configured, verified on chain and switched on. A Central City service above 0.10 USDC
 * is paid through router 2 in one operation (seller 90%, treasury 10%) and delivered; a service up to
 * 0.10 still goes through router 1; with the switch off a price above 0.10 is refused before
 * anything is sent. Synthetic data; nothing reaches a network.
 */

const ROUTER = PROTOCOL_BASE_MAINNET.feeRouter;
const ROUTER2 = getAddress(`0x${'42'.repeat(20)}`);
const TREASURY = PROTOCOL_BASE_MAINNET.treasury;
const SELLER = getAddress(`0x${'5e'.repeat(20)}`);
const ORIGIN = 'https://centralcity.ai';
const HELLO = { body: { text: 'hello' } };
const HELLO_HEX = createHash('sha256').update('hello', 'utf8').digest('hex');
const ROUTER2_ENV = {
  CITY_PROTOCOL_FEES: undefined,
  CITY_PROTOCOL_FEE_ROUTER2: ROUTER2,
  CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK: '1',
};

let offerSeq = 0;
function newOfferId(): string {
  const B = 'abcdefghijklmnopqrstuvwxyz234567';
  let n = ++offerSeq + 9000;
  let tail = '';
  for (let i = 0; i < 16; i++) {
    tail = B[n % 32] + tail;
    n = Math.floor(n / 32);
  }
  return `off_${tail}`;
}

async function app(t: test.TestContext, enabled: boolean): Promise<FeedPayApp> {
  const f = await setup(t, {
    env: { ...ROUTER2_ENV, CITY_PROTOCOL_FEE_ROUTER2_ENABLED: enabled ? '1' : undefined },
    funds: 200_000_000n,
    cap: 200_000_000n,
  });
  f.base.state.feeRouter = { router: ROUTER, treasury: TREASURY };
  f.base.state.feeRouter2 = { router: ROUTER2, treasury: TREASURY };
  f.base.state.code.add(ROUTER2.toLowerCase()); // a contract at router 2's address
  return f;
}

/** The owner allows this agent up to 100 USDC per call (only possible while router 2 is live). */
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

async function buy(f: FeedPayApp, id: string) {
  const q = await f.quote(HELLO, id);
  if (q.statusCode !== 200 || q.json().payable !== true) return { quote: q, call: null };
  const res = await f.callService(
    {
      agentId: f.agentId,
      inputs: HELLO,
      quoteId: q.json().quoteId,
      maxAmountRaw: q.json().amount.raw,
      maxTotalRaw: q.json().total.raw,
      idempotencyKey: randomUUID(),
    },
    id,
  );
  return { quote: q, call: res };
}

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

const routerOf = async (f: FeedPayApp, callId: string) =>
  (
    await f.sql<{ fee_router: string }>(
      'SELECT fee_router FROM feed_pay_calls WHERE call_id = $1',
      [callId],
    )
  )[0]!.fee_router;

test('router 2 live: 1 USDC and 10 USDC services pay through router 2, 0.05 still through router 1', async (t) => {
  const f = await app(t, true);
  await f.limit(200_000_000n);
  await allowPerCall(f, 100_000_000n);
  for (const [price, router] of [
    [1_000_000n, ROUTER2],
    [10_000_000n, ROUTER2],
    [50_000n, ROUTER],
  ] as const) {
    const id = await listOffer(f, price.toString());
    const seller0 = f.base.balanceOf(SELLER);
    const treasury0 = f.base.balanceOf(TREASURY);
    const { quote, call: res } = await buy(f, id);
    assert.ok(res, `quote for ${price}: ${quote.body}`);
    assert.equal(res.statusCode, 200, res.body);
    const call = await done(f, res.json().callId);
    assert.equal(call.state, 'result_saved', JSON.stringify(call));
    assert.equal(call.payment?.amountRaw, price.toString());
    assert.deepEqual(JSON.parse(call.result!.text!).hex, HELLO_HEX);
    // Exactly 90 / 10, in one operation, through the router the total chose.
    assert.equal(f.base.balanceOf(SELLER) - seller0, price - price / 10n, 'seller got 90%');
    assert.equal(f.base.balanceOf(TREASURY) - treasury0, price / 10n, 'treasury got 10%');
    assert.equal(await routerOf(f, call.callId), router.toLowerCase());
    const charge = f.base.state.feeCharges.at(-1)!;
    assert.deepEqual(
      [charge.router, charge.kind, charge.gross, charge.fee, charge.ref],
      [router, 1, price, price / 10n, keccak256(stringToHex(call.callId))],
    );
  }
});

test('router 2 switched off: a 10 USDC service is refused before anything is sent', async (t) => {
  const f = await app(t, false);
  await f.limit(200_000_000n);
  const id = await listOffer(f, '10000000');
  const sends = f.base.state.sends.length;
  const { quote, call } = await buy(f, id);
  const refused = call === null || call.statusCode !== 200;
  assert.ok(refused, `refused while router 2 is off: ${quote.body} ${call?.body ?? ''}`);
  assert.equal(f.base.state.sends.length, sends, 'nothing sent');
  assert.equal(f.base.state.feeCharges.length, 0);
});

test('router 2 with a wrong cap on chain: not ready, nothing above 0.10 is paid', async (t) => {
  const f = await app(t, true);
  f.base.state.feeRouter2 = { router: ROUTER2, treasury: TREASURY, maxTotal: 100_000n };
  await f.limit(200_000_000n);
  await allowPerCall(f, 100_000_000n);
  const id = await listOffer(f, '10000000');
  const sends = f.base.state.sends.length;
  const { quote, call } = await buy(f, id);
  const refused = call === null || call.statusCode !== 200;
  assert.ok(refused, `refused with an unverified router 2: ${quote.body} ${call?.body ?? ''}`);
  assert.equal(f.base.state.sends.length, sends, 'nothing sent');
});

/** x402 transfer authorizations signed so far (each one is a signature a seller could submit). */
const x402Signatures = async (f: FeedPayApp) =>
  Number(
    (await f.sql<{ n: string }>('SELECT count(*)::text AS n FROM base_x402_authorizations'))[0]!.n,
  );

/** Steps the call to its end: the worker, then the cron. */
async function settle(f: FeedPayApp, callId: string): Promise<FeedPayCall> {
  return done(f, callId);
}

/** An external x402 service above 0.10 USDC whose first call needs a top-up held on Base. */
async function externalCallHeldAtTopUp(f: FeedPayApp, amount: string) {
  await f.limit(200_000_000n);
  await allowPerCall(f, 100_000_000n);
  await f.list({ amount, paid: 'settle' });
  f.base.state.autoLand = false;
  return f.pay();
}

test('external above 0.10: router 2 removed after reservation, the call is held: no signature, no seller request', async (t) => {
  const f = await app(t, true);
  const res = await externalCallHeldAtTopUp(f, '1000000');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().state, 'float_topup', res.body);
  assert.equal(await routerOf(f, res.json().callId), ROUTER2.toLowerCase(), 'pinned to router 2');
  // Router 2's configuration is removed while the top-up is on its way (post-top-up proceed).
  delete process.env.CITY_PROTOCOL_FEE_ROUTER2;
  delete process.env.CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK;
  const pending = [...f.base.state.sends].at(-1)!;
  f.base.land(pending);
  f.base.state.autoLand = true;
  const call = await settle(f, res.json().callId);
  assert.notEqual(call.state, 'result_saved', JSON.stringify(call));
  assert.equal(call.payment, null, 'nothing paid to the seller');
  assert.equal(await x402Signatures(f), 0, 'no x402 authorization was ever signed');
  assert.equal(f.service.paid().length, 0, 'no paid request reached the seller');
  assert.equal(f.base.state.feeCharges.length, 0, 'no fee charged, on either router');
  // Never re-routed to router 1.
  assert.equal(await routerOf(f, call.callId), ROUTER2.toLowerCase());
});

test('fresh engine, router 2 binding unreadable on chain: nothing above 0.10 is quoted, signed or sent', async (t) => {
  const f = await app(t, true);
  f.base.state.routerReadsDown = true;
  await f.limit(200_000_000n);
  await allowPerCall(f, 100_000_000n);
  await f.list({ amount: '1000000', paid: 'settle' });
  const sends = f.base.state.sends.length;
  const q = await f.quote();
  // Not ready: the quote is not payable (or a call is refused before anything is signed).
  if (q.statusCode === 200 && q.json().payable === true) {
    const res = await f.pay();
    assert.notEqual(res.json()?.state, 'result_saved', res.body);
  }
  assert.equal(f.base.state.sends.length, sends, 'no operation sent');
  assert.equal(f.service.paid().length, 0, 'no signature reached the seller');
});

test('external x402 service at 1 USDC: the seller is paid 1 USDC, the 10% fee is charged on top through router 2', async (t) => {
  const f = await app(t, true);
  await f.limit(200_000_000n);
  await allowPerCall(f, 100_000_000n);
  await f.list({ amount: '1000000', paid: 'settle' });
  const treasury0 = f.base.balanceOf(TREASURY);
  const res = await f.pay();
  assert.equal(res.statusCode, 200, res.body);
  const call = await done(f, res.json().callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  assert.equal(call.payment?.amountRaw, '1000000');
  assert.equal(f.service.paid().length, 1, 'one paid request to the seller');
  assert.equal(await x402Signatures(f), 1, 'the counter sees the one signed authorization');
  assert.equal(await routerOf(f, call.callId), ROUTER2.toLowerCase());
  const charge = f.base.state.feeCharges.at(-1)!;
  assert.deepEqual(
    [charge.router, charge.kind, charge.gross, charge.fee],
    [ROUTER2, 0, 1_000_000n, 100_000n],
  );
  assert.equal(f.base.balanceOf(TREASURY) - treasury0, 100_000n, 'treasury got the 10% fee');
});

/** Quote then the confirmed body, so the same call can be retried with the same key. */
async function confirmedBody(f: FeedPayApp) {
  const q = await f.quote();
  assert.equal(q.statusCode, 200, q.body);
  assert.equal(q.json().payable, true, q.body);
  return {
    agentId: f.agentId,
    inputs: BODY,
    quoteId: q.json().quoteId as string,
    maxAmountRaw: q.json().amount.raw as string,
    maxTotalRaw: q.json().total.raw as string,
    idempotencyKey: randomUUID(),
  };
}

for (const removeRouter2 of [true, false])
  test(`external above 0.10 signed but never sent, resumed by a same-key retry: ${removeRouter2 ? 'router 2 removed -> never sent' : 'control, router 2 kept -> sent'}`, async (t) => {
    const f = await app(t, true);
    await f.limit(200_000_000n);
    await allowPerCall(f, 100_000_000n);
    await f.list({ amount: '1000000', paid: 'settle' });
    // The worker stops right after signing (one failed read), as a crash between issue and send.
    let failOnce = true;
    const chainFor = f.base.chainFor.bind(f.base);
    f.base.chainFor = ((db: Parameters<typeof chainFor>[0]) => {
      const port = chainFor(db);
      return {
        ...port,
        stored: async (paymentId: string) => {
          if (failOnce) {
            failOnce = false;
            throw new Error('stored read failed once');
          }
          return port.stored(paymentId);
        },
      };
    }) as typeof f.base.chainFor;
    const body = await confirmedBody(f);
    const res = await f.callService(body);
    assert.equal(res.statusCode, 200, res.body);
    const callId = res.json().callId as string;
    const [row] = await f.sql<{ state: string; fee_router: string }>(
      'SELECT state, fee_router FROM feed_pay_calls WHERE call_id = $1',
      [callId],
    );
    assert.equal(row!.state, 'authorized', 'signed, never sent');
    assert.equal(row!.fee_router, ROUTER2.toLowerCase());
    assert.equal(f.service.paid().length, 0);
    if (removeRouter2) {
      delete process.env.CITY_PROTOCOL_FEE_ROUTER2;
      delete process.env.CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK;
    }
    // Resumed inside the authorization's window: only the router 2 guard can stop the send.
    f.advance(5_000);
    await f.callService(body);
    for (let i = 0; i < 200; i++) {
      const c = (await f.status(callId)).json() as FeedPayCall;
      if (c.done) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (removeRouter2) {
      const call = (await f.status(callId)).json() as FeedPayCall;
      assert.ok(
        ['reconciling', 'expired', 'cancelled'].includes(call.state),
        `left unsent and reconciled: ${JSON.stringify(call)}`,
      );
      assert.equal(call.failure?.code, 'interrupted');
      assert.notEqual(call.moneyMoved, 'yes');
      assert.equal(f.service.paid().length, 0, 'the signed payment never reached the seller');
      assert.equal(f.base.state.feeCharges.length, 0, 'no fee charged on either router');
    } else {
      assert.equal(f.service.paid().length, 1, 'control: the resumed call is sent');
    }
  });
