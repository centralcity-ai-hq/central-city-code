import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { getAddress, recoverTypedDataAddress, type Hex } from 'viem';
import {
  BASE_MAINNET_TERMS,
  buyOffer,
  BuyOfferError,
  checkOfferTerms,
  legNonce,
  resumeOffer,
  SCHEME,
  type BuyOfferOptions,
  type PendingPurchase,
} from '../examples/x402-buyer/buy-offer.js';
import { feedServiceId } from '../server/feed/bazaar.js';
import { LEG_FEE, LEG_SELLER, router3Nonce } from '../server/feed/pay/router3.js';
import { HOSTED_SOURCE } from '../server/feed/types.js';
import { offerInputSummary, offerOutputSummary } from '../shared/feed-offers.js';
import { PROTOCOL_BASE_MAINNET, reservedPayees } from '../shared/protocol.js';
import { CHAIN_ID, setup, USDC } from './helpers/feed-pay-app.js';
import { fakePublicLane, newBuyer } from './helpers/public-offer-lane.js';

/*
 * The buyer module (examples/x402-buyer/buy-offer.ts) through the real route and pay code
 * (createApp, public-route.ts, public-pay.ts) with the lane double: its `fetch` is app.inject, so
 * nothing reaches a network. Fresh keys, really signed; the double recovers both signatures against
 * the server's own nonces, so a wrong nonce or domain would be refused. Synthetic.
 */

const SELLER = getAddress(`0x${'5e'.repeat(20)}`) as Hex;
const OFFER = 'off_aaaaaaaaaaaaaaaa';
const PATH = `/api/public/x402/${OFFER}`;
const URL_ = `${BASE_MAINNET_TERMS.origin}${PATH}`;
const INPUT = { text: 'hello' };
const TX = `0x${'ab'.repeat(32)}` as Hex;
const HASH = createHash('sha256').update('hello').digest('hex');
const GROSS = 100_000n;
const CONFIG = {
  chainId: CHAIN_ID,
  router: PROTOCOL_BASE_MAINNET.feeRouter3 as Hex,
  treasury: PROTOCOL_BASE_MAINNET.treasury as Hex,
  usdc: getAddress(USDC) as Hex,
};
const keyOf = (callId: string) => `x402pub:${callId}`;

async function fixture(t: Parameters<typeof setup>[0]) {
  const fake = fakePublicLane(CONFIG);
  const f = await setup(t, {
    env: {
      CITY_PROTOCOL_FEES: '1',
      CITY_PROTOCOL_FEE_ROUTER3_ENABLED: '1',
      CITY_PROTOCOL_SCREENING: '1',
      CITY_X402_PUBLIC_OFFERS: '1',
      CITY_X402_PUBLIC_OFFERS_ALLOW: OFFER,
      CITY_X402_PUBLIC_OFFERS_SETTLE: '1',
      CITY_RATE_LIMIT_KEY: 'synthetic-rate-limit-key-0123456789abcdef',
    },
    publicOfferLane: async () => fake.lane,
    screeningProvider: () => ({
      ref: 'test:screening',
      supports: () => true,
      check: async ({ addresses }) => ({
        listed: Object.fromEntries(addresses.map((address) => [address, false])),
        observedAt: f.clock(),
      }),
    }),
  });
  f.base.state.feeRouter3 = { router: CONFIG.router, treasury: CONFIG.treasury };
  f.base.state.code.add(CONFIG.router.toLowerCase());
  const at = f.clock();
  await f.sql(
    `INSERT INTO city_offers (offer_id, operator_id, agent_id, wallet_id, pay_to, kind, title,
       description, tags, price_raw, discoverable, version, state, idem_key, risky,
       price_changed_at, created_at, updated_at, preset)
     VALUES ($1, 'op-seller', 'agent-seller', 'wallet-seller', $2, 'hash', 'Text hash',
       'The SHA-256 of a text.', '{}', 100000, true, 1, 'active', $1, NULL, $3, $3, $3, NULL)`,
    [OFFER, SELLER, at],
  );
  await f.sql(
    `INSERT INTO feed_services (id, source, record_id, host, url, title, description, capabilities,
       provider_name, method, x402_version, scheme, price_raw, pay_to, input, output,
       paid_calls_30d, payers_30d, last_called_at, source_updated_at, fetched_at, first_seen_at,
       last_seen_at, last_seen_sweep, missed_sweeps, withdrawn_at, risky, hidden, search_text,
       seller_key)
     VALUES ($1, $2, $3, 'centralcity.ai', $4, 'Text hash', 'The SHA-256 of a text.', '{}',
       'Synthetic seller', 'POST', 2, 'exact', 100000, $5, $6::jsonb, $7::jsonb, NULL, NULL, NULL,
       $8, $8, $8, $8, 0, 0, NULL, NULL, false, 'text hash', $9)`,
    [
      feedServiceId(URL_),
      HOSTED_SOURCE,
      `cc:${OFFER}`,
      URL_,
      SELLER,
      JSON.stringify(offerInputSummary('hash', null)),
      JSON.stringify(offerOutputSummary('hash')),
      at,
      SELLER.toLowerCase(),
    ],
  );

  /** Every request the module sends, as the route saw it. */
  const seen: { payment: string | null; body: string }[] = [];
  /** Rewrites an answer, for a server that lies. */
  const control = { rewrite: null as null | ((json: any) => any) };
  const appFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, BASE_MAINNET_TERMS.origin);
    assert.equal(init?.redirect, 'error', 'a redirect must never carry the signed legs away');
    const headers = init?.headers as Record<string, string>;
    seen.push({ payment: headers['PAYMENT-SIGNATURE'] ?? null, body: String(init?.body) });
    const res = await f.app.inject({
      method: 'POST',
      url: url.pathname,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      payload: String(init?.body),
      remoteAddress: '203.0.113.9',
    });
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, String(v));
    let payload = res.body;
    if (res.statusCode === 402 && control.rewrite) {
      payload = JSON.stringify(control.rewrite(res.json()));
      out.delete('payment-required');
    }
    return new Response(payload, { status: res.statusCode, headers: out });
  }) as typeof globalThis.fetch;

  const signing = { count: 0 };
  const account = (buyer = newBuyer()): BuyOfferOptions['account'] => ({
    address: buyer.address,
    signTypedData: async (parameters) => {
      signing.count += 1;
      return buyer.signTypedData(parameters);
    },
  });
  const options = (extra: Partial<BuyOfferOptions> = {}): BuyOfferOptions => ({
    account: account(),
    url: URL_,
    input: INPUT,
    maxPriceRaw: GROSS,
    fetch: appFetch,
    now: f.clock,
    terms: { ...BASE_MAINNET_TERMS, usdc: CONFIG.usdc },
    sleep: async () => {},
    ...extra,
  });
  const rows = async () =>
    Number(
      (await f.sql<{ n: string }>('SELECT count(*)::text AS n FROM feed_pay_public_calls'))[0]!.n,
    );
  return { f, ...fake, seen, control, signing, options, account, rows, appFetch };
}

test('the module pins what the server pins, and its nonces are the servers', () => {
  const d = PROTOCOL_BASE_MAINNET;
  assert.equal(BASE_MAINNET_TERMS.chainId, d.chainId);
  assert.equal(BASE_MAINNET_TERMS.usdc, d.usdc);
  assert.equal(BASE_MAINNET_TERMS.router, d.feeRouter3);
  assert.equal(BASE_MAINNET_TERMS.treasury, d.treasury);
  const reserved = reservedPayees();
  for (const address of BASE_MAINNET_TERMS.reservedPayees)
    assert.ok(reserved.has(address.toLowerCase()), `${address} is reserved on the server too`);

  const input = {
    chainId: d.chainId,
    router: d.feeRouter3 as Hex,
    treasury: d.treasury as Hex,
    payer: `0x${'11'.repeat(20)}` as Hex,
    payee: SELLER,
    gross: 1_040_000n,
    ref: `0x${'22'.repeat(32)}` as Hex,
    validAfter: 1_700_000_000n,
    validBefore: 1_700_000_600n,
  };
  assert.equal(legNonce({ ...input, leg: 0 }), router3Nonce({ ...input, leg: LEG_SELLER }));
  assert.equal(legNonce({ ...input, leg: 1 }), router3Nonce({ ...input, leg: LEG_FEE }));
  assert.notEqual(legNonce({ ...input, leg: 0 }), legNonce({ ...input, leg: 1 }));
  assert.notEqual(
    legNonce({ ...input, leg: 0 }),
    legNonce({ ...input, gross: input.gross + 1n, leg: 0 }),
  );
});

test('buys through the real route: 402, both legs, 202 by the same request, result and hash', async (t) => {
  const x = await fixture(t);
  let callId = '';
  let stored: PendingPurchase | null = null;
  const bought = await buyOffer(
    x.options({
      payTo: SELLER.toLowerCase(),
      onSigned: (pending) => {
        stored = pending;
        callId = pending.callId;
        assert.equal(x.seen.at(-1)?.payment, null, 'stored before anything signed is sent');
      },
      // The second wait: Base includes the settlement while the buyer waits for the 202.
      sleep: async () => x.include(keyOf(callId), TX),
    }),
  );
  assert.equal(bought.transaction, TX);
  assert.match(bought.result, new RegExp(HASH));
  assert.equal(bought.callId, callId);
  assert.equal(bought.amountRaw, GROSS.toString());
  assert.equal(x.signing.count, 2, 'two legs, signed once');

  const paying = x.seen.filter((s) => s.payment);
  assert.equal(x.seen[0]!.payment, null);
  assert.equal(paying.length, 2, 'the 202, then the result');
  assert.equal(paying[0]!.payment, paying[1]!.payment, 'the very same request again');
  assert.equal(paying[0]!.body, paying[1]!.body);
  assert.equal(paying[0]!.body, x.seen[0]!.body);

  const sent = JSON.parse(Buffer.from(paying[0]!.payment!, 'base64').toString());
  assert.equal(sent.accepted.scheme, SCHEME);
  assert.equal(stored!.paymentHeader, paying[0]!.payment);
  // The seller leg pays 90% to the seller, the fee leg 10% to the treasury, both from the buyer.
  const { seller, fee, payer } = sent.payload;
  assert.equal(seller.to, SELLER);
  assert.equal(seller.value, '90000');
  assert.equal(fee.to, getAddress(CONFIG.treasury));
  assert.equal(fee.value, '10000');
  for (const leg of [seller, fee])
    assert.equal(
      await recoverTypedDataAddress({
        domain: {
          name: 'USD Coin',
          version: '2',
          chainId: CHAIN_ID,
          verifyingContract: CONFIG.usdc,
        },
        types: {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        message: {
          from: leg.from,
          to: leg.to,
          value: BigInt(leg.value),
          validAfter: BigInt(leg.validAfter),
          validBefore: BigInt(leg.validBefore),
          nonce: leg.nonce,
        },
        signature: leg.signature,
      }),
      payer,
    );
});

test('refuses before signing: every term that does not match, and nothing is stored', async (t) => {
  const x = await fixture(t);
  const other = getAddress(`0x${'77'.repeat(20)}`);
  const edit =
    (change: (entry: any) => void) =>
    (json: any): any => {
      change(json.accepts[0]);
      return json;
    };
  const nowS = () => Math.floor(x.f.clock() / 1000);
  const cases: [string, string, (json: any) => any][] = [
    ['x402Version', 'version 1', (j) => ({ ...j, x402Version: 1 })],
    ['scheme', 'stock exact', edit((e) => (e.scheme = 'exact'))],
    ['scheme', 'two entries', (j) => ({ ...j, accepts: [j.accepts[0], j.accepts[0]] })],
    ['network', 'another chain', edit((e) => (e.network = 'eip155:1'))],
    ['asset', 'another token', edit((e) => (e.asset = other))],
    ['router', 'another router', edit((e) => (e.extra.router = other))],
    ['treasury', 'another treasury', edit((e) => (e.extra.treasury = other))],
    ['extra', 'another signing domain', edit((e) => (e.extra.name = 'Fake'))],
    ['payTo', 'the router as payee', edit((e) => (e.payTo = CONFIG.router))],
    ['payTo', 'the treasury as payee', edit((e) => (e.payTo = CONFIG.treasury))],
    [
      'payTo',
      'an older router as payee',
      edit((e) => (e.payTo = PROTOCOL_BASE_MAINNET.feeRouter2)),
    ],
    ['payTo', 'USDC as payee', edit((e) => (e.payTo = CONFIG.usdc))],
    ['payTo', 'not an address', edit((e) => (e.payTo = 'nobody'))],
    ['amount', 'above the maximum', edit((e) => (e.amount = '100001'))],
    ['amount', 'below the router minimum', edit((e) => (e.amount = '10'))],
    ['amount', 'not a number', edit((e) => (e.amount = '1e6'))],
    ['split', 'the seller share too large', edit((e) => (e.extra.sellerAmount = '100000'))],
    ['split', 'the fee too large', edit((e) => (e.extra.feeAmount = '20000'))],
    ['callId', 'no call (stage 1 terms)', edit((e) => delete e.extra.callId)],
    ['ref', 'a ref of another call', edit((e) => (e.extra.ref = `0x${'33'.repeat(32)}`))],
    ['window', 'ended', edit((e) => (e.extra.validBefore = String(nowS() - 1)))],
    ['window', 'about to end', edit((e) => (e.extra.validBefore = String(nowS() + 60)))],
    ['window', 'starts later', edit((e) => (e.extra.validAfter = String(nowS() + 500)))],
    [
      'window',
      'a long window',
      edit((e) => {
        e.extra.validAfter = String(nowS() - 60);
        e.extra.validBefore = String(nowS() + 86_400);
      }),
    ],
    [
      'window',
      'far ahead',
      edit((e) => {
        e.extra.validAfter = String(nowS() + 50);
        e.extra.validBefore = String(nowS() + 700);
      }),
    ],
  ];
  for (const [term, name, rewrite] of cases) {
    x.control.rewrite = rewrite;
    await assert.rejects(
      buyOffer(x.options()),
      (error: unknown) =>
        error instanceof BuyOfferError &&
        error.code === 'terms_mismatch' &&
        error.term === term &&
        error.pending === undefined,
      name,
    );
  }
  x.control.rewrite = null;

  // The caller's own limits, on the server's real terms.
  await assert.rejects(buyOffer(x.options({ maxPriceRaw: GROSS - 1n })), { term: 'amount' });
  await assert.rejects(buyOffer(x.options({ payTo: other })), { term: 'payTo' });
  const buyer = newBuyer();
  x.control.rewrite = edit((e) => (e.payTo = buyer.address));
  await assert.rejects(buyOffer(x.options({ account: x.account(buyer) })), { term: 'payTo' });
  x.control.rewrite = null;

  assert.equal(x.signing.count, 0, 'nothing signed');
  assert.equal(x.seen.filter((s) => s.payment).length, 0, 'no payment sent');
  assert.equal(await x.rows(), 0, 'nothing stored');
});

test('refuses bad arguments before any request', async (t) => {
  const x = await fixture(t);
  const bad: Partial<BuyOfferOptions>[] = [
    { maxPriceRaw: undefined as unknown as bigint },
    { maxPriceRaw: 100000 as unknown as bigint },
    { maxPriceRaw: 0n },
    { url: 'not a url' },
    { url: `http://centralcity.ai${PATH}` },
    { url: `https://centralcity.ai.evil.example${PATH}` },
    { url: `https://user:pw@centralcity.ai${PATH}` },
    { url: 'https://centralcity.ai/api/feed/pay' },
    { url: `${URL_}?x=1` },
  ];
  for (const extra of bad)
    await assert.rejects(buyOffer(x.options(extra)), { code: 'bad_argument' });
  assert.equal(x.seen.length, 0);
});

test('a refused or unavailable first answer signs nothing', async (t) => {
  const x = await fixture(t);
  x.state.canPay = false;
  x.state.eth = 0n;
  await assert.rejects(
    buyOffer(x.options()),
    (error: unknown) => error instanceof BuyOfferError && error.status === 503 && !error.pending,
  );
  await assert.rejects(
    buyOffer(
      x.options({ url: `${BASE_MAINNET_TERMS.origin}/api/public/x402/off_bbbbbbbbbbbbbbbb` }),
    ),
    {
      status: 404,
    },
  );
  assert.equal(x.signing.count, 0);
});

test('after signing it only resends: a timeout hands back the purchase, resuming signs nothing', async (t) => {
  const x = await fixture(t);
  let clock = x.f.clock();
  const error = (await buyOffer(
    x.options({
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      maxWaitMs: 12_000,
    }),
  ).catch((e) => e)) as BuyOfferError;
  assert.ok(error instanceof BuyOfferError, String(error));
  assert.equal(error.code, 'still_pending');
  assert.ok(error.pending);
  assert.equal(x.signing.count, 2);
  const paying = x.seen.filter((s) => s.payment);
  assert.ok(paying.length >= 2);
  assert.equal(new Set(paying.map((s) => s.payment)).size, 1);

  // A lost answer on the way: the same request again.
  x.include(keyOf(error.pending.callId), TX);
  let lost = false;
  const flaky = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (!lost) {
      lost = true;
      throw new TypeError('fetch failed');
    }
    return x.appFetch(input, init);
  }) as typeof globalThis.fetch;
  const bought = await resumeOffer(error.pending, {
    fetch: flaky,
    sleep: async () => {},
    now: x.f.clock,
  });
  assert.equal(bought.transaction, TX);
  assert.match(bought.result, new RegExp(HASH));
  assert.equal(x.signing.count, 2, 'never signed again');
  assert.equal(new Set(x.seen.filter((s) => s.payment).map((s) => s.payment)).size, 1);
});

test('a new 402 after signing is never signed again', async (t) => {
  const x = await fixture(t);
  const buy = buyOffer(
    x.options({
      onSigned: async () => {
        // Repriced between the 402 and the payment: the route answers a fresh 402.
        await x.f.sql(`UPDATE city_offers SET price_raw = 90000 WHERE offer_id = $1`, [OFFER]);
        await x.f.sql(`UPDATE feed_services SET price_raw = 90000 WHERE record_id = $1`, [
          `cc:${OFFER}`,
        ]);
      },
    }),
  );
  await assert.rejects(
    buy,
    (error: unknown) =>
      error instanceof BuyOfferError &&
      error.code === 'terms_changed' &&
      error.status === 402 &&
      !!error.pending,
  );
  assert.equal(x.signing.count, 2);
  assert.equal(await x.rows(), 0, 'nothing stored by the server');
});

test("too costly is resent, a call that ended surfaces the server's code", async (t) => {
  const x = await fixture(t);
  x.state.withinCaps = false;
  // Over the fee caps now: resent with the same legs until the wait ends, never signed again.
  let clock = x.f.clock();
  const error = (await buyOffer(
    x.options({
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      maxWaitMs: 6_000,
    }),
  ).catch((e) => e)) as BuyOfferError;
  assert.equal(error.code, 'still_pending', String(error));
  assert.equal(x.signing.count, 2);
  assert.equal(await x.rows(), 0);
  x.state.withinCaps = true;

  // The first send refused: the call ended, unsettled. Told apart from a new 402, not signed again.
  x.signing.count = 0;
  x.state.hookSimulateRefused = true;
  const failed = (await buyOffer(x.options()).catch((e) => e)) as BuyOfferError;
  assert.ok(failed instanceof BuyOfferError, String(failed));
  assert.equal(failed.code, 'payment_failed');
  assert.equal(failed.status, 402);
  assert.ok(failed.pending, 'the legs were signed: they stay valid until they expire');
  assert.equal(x.signing.count, 2);
});

test('a 200 without a matching receipt is not a purchase', async () => {
  const pending: PendingPurchase = {
    url: URL_,
    body: '{}',
    paymentHeader: 'x',
    callId: 'xp_aaaaaaaaaaaaaaaaaaaa',
    payer: getAddress(`0x${'11'.repeat(20)}`) as Hex,
    network: 'eip155:8453',
    amountRaw: '100000',
    validBefore: '1',
  };
  const answer = (receipt?: object) =>
    (async () =>
      new Response('result', {
        status: 200,
        headers: receipt
          ? { 'payment-response': Buffer.from(JSON.stringify(receipt)).toString('base64') }
          : {},
      })) as unknown as typeof globalThis.fetch;
  const good = { success: true, transaction: TX, network: 'eip155:8453', payer: pending.payer };
  for (const receipt of [
    undefined,
    { ...good, success: false },
    { ...good, transaction: '0x12' },
    { ...good, network: 'eip155:1' },
    { ...good, payer: SELLER },
  ])
    await assert.rejects(resumeOffer(pending, { fetch: answer(receipt) }), {
      code: 'invalid_receipt',
    });
  const bought = await resumeOffer(pending, { fetch: answer(good) });
  assert.equal(bought.transaction, TX);
});

test('a payee equal to the buyer is refused in any letter case', () => {
  const buyer = `0x${'ab'.repeat(20)}`;
  assert.throws(
    () =>
      checkOfferTerms(
        {
          x402Version: 2,
          accepts: [
            {
              scheme: SCHEME,
              network: 'eip155:8453',
              asset: BASE_MAINNET_TERMS.usdc,
              amount: '100000',
              payTo: buyer.toUpperCase().replace('0X', '0x'),
              extra: {
                name: 'USD Coin',
                version: '2',
                assetTransferMethod: 'eip3009',
                router: BASE_MAINNET_TERMS.router,
                treasury: BASE_MAINNET_TERMS.treasury,
              },
            },
          ],
        },
        { payer: buyer, maxPriceRaw: 100_000n, nowSeconds: 1 },
      ),
    { term: 'payTo' },
  );
});
