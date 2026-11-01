import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { getAddress, type Hex } from 'viem';
import { feedServiceId } from '../server/feed/bazaar.js';
import { HOSTED_SOURCE } from '../server/feed/types.js';
import {
  createPublicOfferPay,
  PUBLIC_OFFER_PER_PAYEE_DAY,
  PUBLIC_OFFER_SIMULATIONS_PER_CLIENT_MINUTE,
  PUBLIC_OFFER_SIMULATIONS_PER_SELLER_MINUTE,
  PUBLIC_OFFER_READY_TTL_MS,
  PUBLIC_OFFER_RETENTION_MS,
  type PublicPayment,
} from '../server/feed/offers/public-pay.js';
import {
  clientAddressKey,
  FAIL_CLOSED_PREFIXES,
  MemoryRateLimiter,
  PostgresRateLimiter,
  type RateLimiter,
} from '../server/rate-limit.js';
import { checkPaidCalls } from '../server/stats/paid-calls.js';
import { BACKFILL_SOURCES, readWindow, sourceTables } from '../server/dashboard/rollup.js';
import { SERVICE_CALLS_PATH } from '../shared/explorer-calls.js';
import { offerInputSummary, offerOutputSummary } from '../shared/feed-offers.js';
import { PROTOCOL_BASE_MAINNET } from '../shared/protocol.js';
import { CHAIN_ID, CRON, setup, USDC } from './helpers/feed-pay-app.js';
import {
  fakePublicLane,
  newBuyer,
  paymentHeader,
  signedPayment,
} from './helpers/public-offer-lane.js';

/*
 * Stage 2 of the offers' public address through the real app (server/feed/offers/public-route.ts,
 * public-pay.ts): the real migrations, the engine's own offer read, pre-send checks and 'hash' kind,
 * real EIP-3009 signatures from a fresh key. Only the lane is a double (tests/helpers/
 * public-offer-lane.ts). Nothing reaches a network; nothing is signed with a real key. Synthetic.
 */

const SELLER = getAddress(`0x${'5e'.repeat(20)}`);
const ROUTER3 = PROTOCOL_BASE_MAINNET.feeRouter3 as Hex;
const TREASURY = PROTOCOL_BASE_MAINNET.treasury as Hex;
const OFFER = 'off_aaaaaaaaaaaaaaaa';
const URL_ = `/api/public/x402/${OFFER}`;
const INPUT = { text: 'hello' };
const CONFIG = {
  chainId: CHAIN_ID,
  router: ROUTER3,
  treasury: TREASURY,
  usdc: getAddress(USDC) as Hex,
};
const TX = `0x${'ab'.repeat(32)}` as Hex;

async function fixture(
  t: Parameters<typeof setup>[0],
  options: {
    settle?: string | undefined;
    rateLimiter?: RateLimiter;
    screening?: 'on' | 'off';
    waitMs?: number;
    /** False lists every address; a throw is the oracle down. */
    screen?: () => Promise<boolean>;
    noLane?: boolean;
    logLine?: (line: string) => void;
  } = {},
) {
  const { lane, state, include, feeLog } = fakePublicLane(CONFIG);
  /** The key removed mid-flight: the lane reads as closed from then on. */
  const control = { laneGone: false, now: () => Date.now() };
  const f = await setup(t, {
    env: {
      CITY_PROTOCOL_FEES: '1',
      CITY_PROTOCOL_FEE_ROUTER3_ENABLED: '1',
      CITY_PROTOCOL_SCREENING: options.screening === 'off' ? '0' : '1',
      CITY_X402_PUBLIC_OFFERS: '1',
      CITY_X402_PUBLIC_OFFERS_ALLOW: OFFER,
      CITY_X402_PUBLIC_OFFERS_SETTLE: 'settle' in options ? options.settle : '1',
      CITY_RATE_LIMIT_KEY: 'synthetic-rate-limit-key-0123456789abcdef',
    },
    publicOfferLane: async () => (options.noLane || control.laneGone ? null : lane),
    screeningProvider: () => ({
      ref: 'test:screening',
      supports: () => true,
      check: async ({ addresses }) => {
        const clear = options.screen ? await options.screen() : true;
        return {
          listed: Object.fromEntries(addresses.map((address) => [address, !clear])),
          observedAt: control.now(),
        };
      },
    }),
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.logLine ? { logLine: options.logLine } : {}),
    ...(options.waitMs !== undefined ? { publicOfferWaitMs: options.waitMs } : {}),
  });
  control.now = f.clock;
  f.base.state.feeRouter3 = { router: ROUTER3, treasury: TREASURY };
  f.base.state.code.add(ROUTER3.toLowerCase());
  const url = `https://centralcity.ai${URL_}`;
  const serviceId = feedServiceId(url);
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
      serviceId,
      HOSTED_SOURCE,
      `cc:${OFFER}`,
      url,
      SELLER,
      JSON.stringify(offerInputSummary('hash', null)),
      JSON.stringify(offerOutputSummary('hash')),
      at,
      SELLER.toLowerCase(),
    ],
  );
  const post = (headers: Record<string, string> = {}, body: unknown = INPUT) =>
    f.app.inject({
      method: 'POST',
      url: URL_,
      headers: { 'content-type': 'application/json', ...headers },
      payload: JSON.stringify(body),
      remoteAddress: '203.0.113.9',
    });
  const challenge = async (body: unknown = INPUT) => {
    const res = await post({}, body);
    assert.equal(res.statusCode, 402, res.body);
    return res.json().accepts[0] as PublicPayment['accepted'];
  };
  const row = async (callId: string) =>
    (
      await f.sql<Record<string, unknown>>(
        `SELECT state, failure_code, tx_hash, result_text, seller_signature, input, client_key,
              updated_at::text AS updated_at
       FROM feed_pay_public_calls WHERE call_id = $1`,
        [callId],
      )
    )[0];
  const rows = async () =>
    Number(
      (await f.sql<{ n: string }>('SELECT count(*)::text AS n FROM feed_pay_public_calls'))[0]!.n,
    );
  const work = () =>
    f.app.inject({
      url: '/api/cron/x402-offer-work',
      headers: { authorization: `Bearer ${CRON}` },
    });
  const pay = async (buyer = newBuyer(), body: unknown = INPUT) => {
    const accepted = await challenge(body);
    const payment = await signedPayment(buyer, CONFIG, accepted);
    return { buyer, accepted, payment, header: paymentHeader(payment) };
  };
  return { f, lane, state, include, feeLog, control, post, challenge, row, rows, work, pay };
}

const keyOf = (callId: string) => `x402pub:${callId}`;
const expectedHash = createHash('sha256').update('hello').digest('hex');

test('flag off: the 402 of stage 1 and 501 for any payment; nothing stored', async (t) => {
  const x = await fixture(t, { settle: undefined });
  const res = await x.post();
  assert.equal(res.statusCode, 402);
  assert.equal(res.json().accepts[0].extra.tag, undefined);
  const paid = await x.post({ 'payment-signature': 'anything' });
  assert.equal(paid.statusCode, 501);
  assert.equal(paid.json().code, 'payments_not_open');
  assert.equal(await x.rows(), 0);
  assert.equal(x.state.simulations, 0);
});

test('paid path: 402 bound by a tag, both legs, one settle, one FeeCharged, the result only once paid', async (t) => {
  const x = await fixture(t);
  const { accepted, header } = await x.pay();
  const callId = accepted.extra.callId;
  assert.match(accepted.extra.tag, /^[0-9a-f]{64}$/);
  // Base has not included it: 202, no result anywhere in the answer.
  const first = await x.post({ 'payment-signature': header });
  assert.equal(first.statusCode, 202, first.body);
  assert.doesNotMatch(first.body, new RegExp(expectedHash));
  assert.equal((await x.row(callId))!.state, 'sent');
  assert.equal(x.state.submitted.get(keyOf(callId))!.ran, true);
  // Simulated at the check and again right before the broadcast.
  assert.equal(x.state.simulations, 2);
  // Included: the same request answers the result.
  x.include(keyOf(callId), TX);
  const done = await x.post({ 'payment-signature': header });
  assert.equal(done.statusCode, 200, done.body);
  assert.match(done.body, new RegExp(expectedHash));
  const receipt = JSON.parse(
    Buffer.from(done.headers['payment-response'] as string, 'base64').toString(),
  );
  assert.equal(receipt.transaction, TX);
  const stored = (await x.row(callId))!;
  assert.equal(stored.state, 'delivered');
  assert.equal(stored.tx_hash, TX);
  // X-PAYMENT carries the same payment and answers the same call.
  const v1 = await x.post({ 'x-payment': header });
  assert.equal(v1.statusCode, 200);
  assert.ok(v1.headers['x-payment-response']);
  // One hand-over only: nothing was sent twice.
  assert.equal(x.state.submitted.size, 1);
});

test('replay and double submit: same call, one row, one settlement; a second challenge while open is refused', async (t) => {
  const x = await fixture(t);
  const buyer = newBuyer();
  const { accepted, header } = await x.pay(buyer);
  const [a, b] = await Promise.all([
    x.post({ 'payment-signature': header }),
    x.post({ 'payment-signature': header }),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [202, 202]);
  assert.equal(await x.rows(), 1);
  assert.equal(x.state.submitted.size, 1);
  // Another 402 for the same input from the same payer, while the first is open.
  const second = await x.pay(buyer);
  const refused = await x.post({ 'payment-signature': second.header });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, 'payer_in_flight');
  assert.equal(await x.rows(), 1);
  // A replay by anyone else of the same terms: another payer gets no call and no result.
  x.include(keyOf(accepted.extra.callId), TX);
  assert.equal((await x.post({ 'payment-signature': header })).statusCode, 200);
  const other = await signedPayment(newBuyer(), CONFIG, accepted);
  const stolen = await x.post({ 'payment-signature': paymentHeader(other) });
  assert.equal(stolen.statusCode, 409);
  assert.doesNotMatch(stolen.body, new RegExp(expectedHash));
});

test('tampered terms: every bound field refused by the tag before any chain read', async (t) => {
  const x = await fixture(t);
  const { payment } = await x.pay();
  const tamper = (edit: (p: PublicPayment) => void) => {
    const copy = JSON.parse(JSON.stringify(payment)) as PublicPayment;
    edit(copy);
    return paymentHeader(copy);
  };
  for (const edit of [
    (p: PublicPayment) => void (p.accepted.amount = '1'),
    (p: PublicPayment) => void (p.accepted.payTo = `0x${'11'.repeat(20)}`),
    (p: PublicPayment) => void (p.accepted.extra.feeAmount = '1'),
    (p: PublicPayment) => void (p.accepted.extra.sellerAmount = '999999'),
    (p: PublicPayment) => void (p.accepted.extra.ref = `0x${'22'.repeat(32)}`),
    (p: PublicPayment) => void (p.accepted.extra.inputHash = `0x${'33'.repeat(32)}`),
    (p: PublicPayment) => void (p.accepted.extra.validBefore = '99999999999'),
    (p: PublicPayment) => void (p.accepted.extra.kind = 'word-count'),
    (p: PublicPayment) => void (p.accepted.extra.offerVersion = 9),
    (p: PublicPayment) => void (p.accepted.extra.callId = 'xp_aaaaaaaaaaaaaaaaaaaa'),
  ]) {
    const res = await x.post({ 'payment-signature': tamper(edit) });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().code, 'invalid_terms');
  }
  // Another input under untouched terms.
  const other = await x.post({ 'payment-signature': paymentHeader(payment) }, { text: 'other' });
  assert.equal(other.statusCode, 400);
  assert.equal(other.json().code, 'input_mismatch');
  // Unreadable, and two different payments in the two headers.
  assert.equal((await x.post({ 'payment-signature': 'not json' })).statusCode, 400);
  assert.equal(
    (
      await x.post({
        'payment-signature': paymentHeader(payment),
        'x-payment': paymentHeader({ ...payment, x402Version: 1 }),
      })
    ).statusCode,
    400,
  );
  assert.equal(await x.rows(), 0);
  assert.equal(x.state.simulations, 0);
});

test('swapped legs and wrong leg fields: refused, nothing stored or sent', async (t) => {
  const x = await fixture(t);
  const accepted = await x.challenge();
  const buyer = newBuyer();
  // The signatures swapped inside otherwise correct legs: only the router's check sees it.
  const swapped = await signedPayment(buyer, CONFIG, accepted, { swapLegs: true });
  const res = await x.post({ 'payment-signature': paymentHeader(swapped) });
  assert.equal(res.statusCode, 402, res.body);
  assert.equal(res.json().code, 'payment_invalid');
  // Whole legs swapped: their nonces and recipients are wrong, refused before any simulation.
  const good = await signedPayment(buyer, CONFIG, accepted);
  const before = x.state.simulations;
  const wrong = await x.post({
    'payment-signature': paymentHeader({
      ...good,
      payload: { payer: buyer.address, seller: good.payload.fee, fee: good.payload.seller },
    }),
  });
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.json().code, 'invalid_legs');
  assert.equal(x.state.simulations, before);
  assert.equal(await x.rows(), 0);
  assert.equal(x.state.submitted.size, 0);
});

test('repricing: before the row a fresh 402; after the row nothing is sent and nothing is owed', async (t) => {
  const x = await fixture(t);
  const { accepted, header } = await x.pay();
  await x.f.sql(`UPDATE city_offers SET price_raw = 90000 WHERE offer_id = $1`, [OFFER]);
  await x.f.sql(`UPDATE feed_services SET price_raw = 90000 WHERE record_id = $1`, [`cc:${OFFER}`]);
  const res = await x.post({ 'payment-signature': header });
  assert.equal(res.statusCode, 402, res.body);
  assert.equal(res.json().accepts[0].amount, '90000');
  assert.notEqual(res.json().accepts[0].extra.callId, accepted.extra.callId);
  assert.equal(await x.rows(), 0);

  // Stored, the kind has run, then the seller reprices: the worker fences and fails it.
  await x.f.sql(`UPDATE city_offers SET price_raw = 100000 WHERE offer_id = $1`, [OFFER]);
  await x.f.sql(`UPDATE feed_services SET price_raw = 100000 WHERE record_id = $1`, [
    `cc:${OFFER}`,
  ]);
  const next = await x.pay();
  const callId = next.accepted.extra.callId;
  x.state.submitThrows = 'crash';
  await x.post({ 'payment-signature': next.header });
  x.state.submitThrows = null;
  assert.equal((await x.row(callId))!.state, 'ran');
  await x.f.sql(`UPDATE city_offers SET price_raw = 80000 WHERE offer_id = $1`, [OFFER]);
  x.f.advance(61_000);
  await x.work();
  const ended = (await x.row(callId))!;
  assert.equal(ended.state, 'failed');
  assert.equal(ended.failure_code, 'offer_changed');
  assert.equal(ended.result_text, null);
  assert.equal(x.state.submitted.size, 0);
  assert.ok(x.state.fenced.has(keyOf(callId)));
});

test('kind failure sends nothing: 502, nothing owed, the legs dropped and the key fenced', async (t) => {
  const x = await fixture(t);
  // The 'hash' kind refuses at run time when its row's input is not what it checked.
  const { accepted, header, payment } = await x.pay();
  void payment;
  const callId = accepted.extra.callId;
  x.state.submitThrows = null;
  await x.f.db.query(
    `CREATE OR REPLACE FUNCTION test_break_input() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN NEW.input := '{bad'; RETURN NEW; END $$`,
  );
  await x.f.db.query(
    `CREATE TRIGGER test_break BEFORE INSERT ON feed_pay_public_calls FOR EACH ROW
     EXECUTE FUNCTION test_break_input()`,
  );
  const res = await x.post({ 'payment-signature': header });
  assert.equal(res.statusCode, 502, res.body);
  assert.equal(res.json().code, 'kind_failed');
  const stored = (await x.row(callId))!;
  assert.equal(stored.state, 'failed');
  assert.equal(stored.failure_code, 'kind_failed');
  assert.equal(stored.seller_signature, null);
  assert.equal(x.state.submitted.size, 0);
  assert.ok(x.state.fenced.has(keyOf(callId)));
});

test('screening: off refuses, blocked refuses, nothing stored or budgeted; down holds', async (t) => {
  // The engine's emergency switch off: strangers are not accepted unscreened.
  const off = await fixture(t, { screening: 'off' });
  const a = await off.pay();
  const res = await off.post({ 'payment-signature': a.header });
  assert.equal(res.statusCode, 503, res.body);
  assert.ok(res.headers['retry-after']);
  assert.equal(await off.rows(), 0);
  assert.equal(off.state.submitted.size, 0);
});

test('screening: the oracle down or a listed address stores nothing and sends nothing', async (t) => {
  let answer: 'clear' | 'throw' | 'listed' = 'throw';
  const x = await fixture(t, {
    screen: async () => {
      if (answer === 'throw') throw new Error('oracle down');
      return answer === 'clear';
    },
  });
  const held = await x.pay();
  const down = await x.post({ 'payment-signature': held.header });
  assert.ok([503, 403].includes(down.statusCode), down.body);
  assert.notEqual(down.statusCode, 202);
  assert.equal(await x.rows(), 0);
  answer = 'listed';
  const listed = await x.post({ 'payment-signature': held.header });
  assert.equal(listed.statusCode, 403, listed.body);
  assert.equal(await x.rows(), 0);
  assert.equal(x.state.submitted.size, 0);
});

test('limiter down: the fail-closed prefix refuses before anything is stored', async (t) => {
  class PayPrefixDown extends MemoryRateLimiter {
    override async hit(key: string, limit: number, windowMs: number, weight?: number) {
      if (key.startsWith('x402-offer-pay:'))
        return { allowed: false, retryAfterMs: 5_000 } as never;
      return super.hit(key, limit, windowMs, weight);
    }
  }
  const x = await fixture(t, { rateLimiter: new PayPrefixDown() as RateLimiter });
  const { header } = await x.pay();
  const res = await x.post({ 'payment-signature': header });
  assert.equal(res.statusCode, 429, res.body);
  assert.equal(await x.rows(), 0);
  assert.equal(x.state.simulations, 0);
});

test('readiness: low gas, a finality lag, no key or router 3 off answer 503 before anyone signs', async (t) => {
  const x = await fixture(t);
  await x.challenge();
  x.state.eth = 19_999_999_999_999_999n;
  x.f.advance(PUBLIC_OFFER_READY_TTL_MS + 1);
  const low = await x.post();
  assert.equal(low.statusCode, 503);
  assert.ok(low.headers['retry-after']);
  x.state.eth = 20_000_000_000_000_000n;
  x.f.advance(PUBLIC_OFFER_READY_TTL_MS + 1);
  await x.challenge();
  x.state.lag = 3_601;
  x.f.advance(PUBLIC_OFFER_READY_TTL_MS + 1);
  assert.equal((await x.post()).statusCode, 503);
  // A payment signed before the gas ran low is refused the same way, nothing stored.
  x.state.lag = 600;
  x.f.advance(PUBLIC_OFFER_READY_TTL_MS + 1);
  const { header } = await x.pay();
  x.state.eth = 1n;
  x.f.advance(PUBLIC_OFFER_READY_TTL_MS + 1);
  assert.equal((await x.post({ 'payment-signature': header })).statusCode, 503);
  assert.equal(await x.rows(), 0);
  // Router 3 off: never another router.
  x.state.eth = 100_000_000_000_000_000n;
  delete process.env.CITY_PROTOCOL_FEE_ROUTER3_ENABLED;
  assert.equal((await x.post()).statusCode, 503);
});

test('no sender key: closed', async (t) => {
  const x = await fixture(t, { noLane: true });
  const res = await x.post();
  assert.equal(res.statusCode, 503, res.body);
  assert.ok(res.headers['retry-after']);
});

test('the budget prefix is classified fail closed', () => {
  assert.ok(FAIL_CLOSED_PREFIXES.includes('x402-offer-pay'));
});

for (const at of ['reserved', 'ran', 'sent', 'paid'] as const) {
  test(`crash resume at '${at}': the worker carries the same call to its end, one settlement`, async (t) => {
    const x = await fixture(t);
    const { accepted, header } = await x.pay();
    const callId = accepted.extra.callId;
    const key = keyOf(callId);
    // Stored by a request that then died, by forcing the row back to the state under test.
    x.state.submitThrows = 'crash';
    await x.post({ 'payment-signature': header });
    x.state.submitThrows = null;
    assert.equal((await x.row(callId))!.state, 'ran');
    if (at === 'reserved')
      await x.f.sql(
        `UPDATE feed_pay_public_calls SET state = 'reserved', result_text = NULL WHERE call_id = $1`,
        [callId],
      );
    if (at === 'sent' || at === 'paid') {
      x.f.advance(61_000);
      await x.work();
      assert.equal((await x.row(callId))!.state, 'sent');
    }
    if (at === 'paid') {
      x.include(key, TX);
      await x.f.sql(
        `UPDATE feed_pay_public_calls SET state = 'paid', tx_hash = $2 WHERE call_id = $1`,
        [callId, TX],
      );
    }
    for (let i = 0; i < 4; i++) {
      x.f.advance(61_000);
      await x.work();
      if (x.state.submitted.has(key) && !x.state.status.has(key)) x.include(key, TX);
    }
    const end = (await x.row(callId))!;
    assert.equal(end.state, 'delivered');
    assert.equal(end.tx_hash, TX);
    assert.equal(x.state.submitted.size, 1);
    const read = await x.post({ 'payment-signature': header });
    assert.equal(read.statusCode, 200, read.body);
    assert.match(read.body, new RegExp(expectedHash));
  });
}

test('a crash after the hand-over: the same key answers the same settlement, never a second', async (t) => {
  const x = await fixture(t);
  const { accepted, header } = await x.pay();
  const callId = accepted.extra.callId;
  x.state.throwAfterStore = true;
  const first = await x.post({ 'payment-signature': header });
  assert.equal(first.statusCode, 202);
  const stored = x.state.submitted.get(keyOf(callId))!;
  assert.equal(stored.ran, true);
  // The next pass finds the row 'ran' or 'sent' and the same settlement stored.
  x.f.advance(61_000);
  await x.work();
  assert.equal((await x.row(callId))!.state, 'sent');
  assert.equal(x.state.submitted.size, 1);
  x.include(keyOf(callId), TX);
  assert.equal((await x.post({ 'payment-signature': header })).statusCode, 200);
});

test('window over before the hand-over: fenced and failed', async (t) => {
  const x = await fixture(t);
  const { accepted, header } = await x.pay();
  const callId = accepted.extra.callId;
  x.state.submitThrows = 'crash';
  await x.post({ 'payment-signature': header });
  x.state.submitThrows = null;
  x.f.advance(700_000);
  await x.work();
  const ended = (await x.row(callId))!;
  assert.equal(ended.state, 'failed');
  assert.equal(ended.failure_code, 'window_expired');
  assert.ok(x.state.fenced.has(keyOf(callId)));
  const answer = await x.post({ 'payment-signature': header });
  assert.equal(answer.statusCode, 402, answer.body);
  assert.equal(answer.json().code, 'payment_failed');
  assert.doesNotMatch(answer.body, new RegExp(expectedHash));
});

test('reverted on Base: open until Base shows the legs unused; used elsewhere never reads as paid', async (t) => {
  const x = await fixture(t);
  const a = await x.pay();
  const callId = a.accepted.extra.callId;
  await x.post({ 'payment-signature': a.header });
  x.state.status.set(keyOf(callId), {
    key: keyOf(callId),
    status: 'failed',
    txHash: TX,
    blockNumber: 5n,
    neverSent: false,
    errorCode: 'REVERTED',
  });
  x.f.advance(61_000);
  await x.work();
  assert.equal((await x.row(callId))!.state, 'sent');
  x.state.legs = 'unused';
  x.f.advance(61_000);
  await x.work();
  assert.equal((await x.row(callId))!.state, 'failed');
  assert.equal((await x.row(callId))!.failure_code, 'REVERTED');

  const b = await x.pay();
  const other = b.accepted.extra.callId;
  x.state.legs = 'used';
  await x.post({ 'payment-signature': b.header });
  x.state.status.set(keyOf(other), {
    key: keyOf(other),
    status: 'failed',
    txHash: TX,
    blockNumber: 5n,
    neverSent: false,
    errorCode: 'REVERTED',
  });
  x.f.advance(61_000);
  await x.work();
  assert.equal((await x.row(other))!.failure_code, 'legs_used_elsewhere');
  const answer = await x.post({ 'payment-signature': b.header });
  assert.equal(answer.statusCode, 409);
  assert.doesNotMatch(answer.body, /Nothing was charged/);
  assert.doesNotMatch(answer.body, new RegExp(expectedHash));
});

test('exactly one FeeCharged: none or two stay open until final, then end unmatched, unpaid, uncounted', async (t) => {
  const logged: string[] = [];
  const x = await fixture(t, { logLine: (line) => logged.push(line) });
  const mismatches = () => logged.filter((line) => line.includes('x402_offer.fee_mismatch'));
  const { accepted, header } = await x.pay();
  const callId = accepted.extra.callId;
  await x.post({ 'payment-signature': header });
  x.include(keyOf(callId), TX, 777n, 2);
  const two = await x.post({ 'payment-signature': header });
  assert.equal(two.statusCode, 202);
  assert.equal((await x.row(callId))!.state, 'sent');
  x.include(keyOf(callId), TX, 777n, 0);
  x.f.advance(61_000);
  await x.work();
  assert.equal((await x.row(callId))!.state, 'sent');
  assert.equal(mismatches().length, 0);
  // Final: it ends, once, with the transaction kept, no result out and an ALERT line.
  x.state.status.set(keyOf(callId), { ...x.state.status.get(keyOf(callId))!, status: 'final' });
  x.f.advance(61_000);
  await x.work();
  x.f.advance(61_000);
  await x.work();
  const ended = (await x.row(callId))!;
  assert.equal(ended.state, 'unmatched');
  assert.equal(ended.failure_code, 'fee_unmatched');
  assert.equal(ended.tx_hash, TX);
  assert.equal(ended.seller_signature, null);
  assert.equal(mismatches().length, 1);
  assert.match(mismatches()[0]!, /ALERT/);
  const answer = await x.post({ 'payment-signature': header });
  assert.equal(answer.statusCode, 502);
  assert.equal(answer.json().code, 'settlement_unmatched');
  assert.equal(answer.json().transaction, TX);
  assert.doesNotMatch(answer.body, /Nothing was charged/);
  assert.doesNotMatch(answer.body, new RegExp(expectedHash));
  assert.equal(answer.headers['payment-response'], undefined);
  const counted = await x.f.sql<{ total: string | null }>(
    `SELECT total::text FROM paid_call_count WHERE chain_id = $1`,
    [CHAIN_ID],
  );
  assert.equal(Number(counted[0]?.total ?? 0), 0);
  // An end state: the sweep clears it after the retention, the transaction stays.
  x.f.advance(PUBLIC_OFFER_RETENTION_MS + 1);
  await x.work();
  const swept = (await x.row(callId))!;
  assert.equal(swept.state, 'unmatched');
  assert.equal(swept.result_text, null);
  assert.equal(swept.input, null);
  assert.equal(swept.tx_hash, TX);
});

test('settings off mid-flight: a buyer who paid hears the truth, anyone else the old answers', async (t) => {
  const x = await fixture(t);
  const { accepted, header } = await x.pay();
  const callId = accepted.extra.callId;
  await x.post({ 'payment-signature': header });
  x.include(keyOf(callId), TX);
  x.f.advance(61_000);
  await x.work();
  assert.equal((await x.row(callId))!.state, 'delivered');
  const stranger = await x.pay();
  // The settle flag off: the stored call answers; one never stored is the plain refusal.
  process.env.CITY_X402_PUBLIC_OFFERS_SETTLE = '0';
  const off = await x.post({ 'payment-signature': header });
  assert.equal(off.statusCode, 200, off.body);
  assert.match(off.body, new RegExp(expectedHash));
  const never = await x.post({ 'payment-signature': stranger.header });
  assert.equal(never.statusCode, 501);
  assert.equal(never.json().code, 'payments_not_open');
  assert.equal(await x.rows(), 1);
  // Off the allowlist, then the whole address off: the same; anything else is an unknown route.
  process.env.CITY_X402_PUBLIC_OFFERS_ALLOW = '';
  assert.equal((await x.post({ 'payment-signature': header })).statusCode, 200);
  assert.equal((await x.post({ 'payment-signature': stranger.header })).statusCode, 404);
  process.env.CITY_X402_PUBLIC_OFFERS = '0';
  assert.equal((await x.post({ 'payment-signature': header })).statusCode, 200);
  assert.equal((await x.post()).statusCode, 404);
  assert.equal((await x.post({ 'payment-signature': 'not-a-payment' })).statusCode, 404);
  const tampered = structuredClone(stranger.payment);
  tampered.accepted.extra.tag = 'f'.repeat(64);
  assert.equal((await x.post({ 'payment-signature': paymentHeader(tampered) })).statusCode, 404);
});

test('settle off with a call before the hand-over: it ends unsent and says so', async (t) => {
  const x = await fixture(t);
  const { accepted, header } = await x.pay();
  const callId = accepted.extra.callId;
  x.state.submitThrows = 'crash';
  await x.post({ 'payment-signature': header });
  x.state.submitThrows = null;
  assert.equal((await x.row(callId))!.state, 'ran');
  process.env.CITY_X402_PUBLIC_OFFERS_SETTLE = '0';
  x.f.advance(61_000);
  const answer = await x.post({ 'payment-signature': header });
  assert.equal(answer.statusCode, 402);
  assert.equal(answer.json().code, 'payment_failed');
  assert.equal(answer.json().reason, 'settle_off');
  assert.equal(x.state.submitted.size, 0);
});

test('the runtime pause: no new 402 or payment, nothing open goes out, then it resumes', async (t) => {
  const x = await fixture(t);
  const flag = (enabled: boolean) =>
    x.f.sql(
      `INSERT INTO feed_flags (name, enabled, updated_at, updated_by)
       VALUES ('x402-offer-settle', $1, 1, 'test')
       ON CONFLICT (name) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [enabled],
    );
  const open = await x.pay();
  const fresh = await x.pay();
  const callId = open.accepted.extra.callId;
  x.state.submitThrows = 'crash';
  await x.post({ 'payment-signature': open.header });
  x.state.submitThrows = null;
  assert.equal((await x.row(callId))!.state, 'ran');
  await flag(false);
  assert.equal((await x.post()).statusCode, 503);
  const refused = await x.post({ 'payment-signature': fresh.header });
  assert.equal(refused.statusCode, 503);
  assert.equal(refused.json().retryable, true);
  assert.equal(await x.rows(), 1);
  // Open: it waits, unsent, and answers that it is still working.
  x.f.advance(61_000);
  await x.work();
  assert.equal(x.state.submitted.size, 0);
  assert.equal((await x.row(callId))!.state, 'ran');
  assert.equal((await x.post({ 'payment-signature': open.header })).statusCode, 202);
  // Resumed: the same call carries on, one settlement.
  await flag(true);
  x.f.advance(61_000);
  await x.work();
  assert.equal(x.state.submitted.size, 1);
  assert.equal((await x.row(callId))!.state, 'sent');
});

test('an Arc seller: no 402 and no payment on this route, nothing stored', async (t) => {
  const x = await fixture(t);
  const { header } = await x.pay();
  await x.f.sql(`UPDATE base_wallets SET chain_id = 5042 WHERE wallet_id = $1`, [x.f.walletId]);
  await x.f.sql(`UPDATE city_offers SET wallet_id = $1 WHERE offer_id = $2`, [x.f.walletId, OFFER]);
  assert.equal((await x.post()).statusCode, 404);
  assert.equal((await x.post({ 'payment-signature': header })).statusCode, 404);
  assert.equal(await x.rows(), 0);
  assert.equal(x.state.submitted.size, 0);
});

test('open-call caps per payer and per client; the partial unique index holds one per input', async (t) => {
  const x = await fixture(t);
  const buyer = newBuyer();
  const first = await x.pay(buyer, { text: 'a' });
  assert.equal(
    (await x.post({ 'payment-signature': first.header }, { text: 'a' })).statusCode,
    202,
  );
  const over = await x.pay(buyer, { text: 'e' });
  const refused = await x.post({ 'payment-signature': over.header }, { text: 'e' });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, 'payer_in_flight');
  assert.equal(await x.rows(), 1);
  // Nine more payers from the same address reach the client cap of ten.
  for (let i = 0; i < 9; i++) {
    const p = await x.pay(newBuyer(), { text: `p${i}` });
    assert.equal(
      (await x.post({ 'payment-signature': p.header }, { text: `p${i}` })).statusCode,
      202,
    );
  }
  const eleventh = await x.pay(newBuyer(), { text: 'q' });
  assert.equal(
    (await x.post({ 'payment-signature': eleventh.header }, { text: 'q' })).statusCode,
    429,
  );
  assert.equal(await x.rows(), 10);
});

test('counts: one +1 with its value, the daily recount finds no drift, the sweep moves no number', async (t) => {
  const x = await fixture(t);
  const { accepted, header } = await x.pay();
  const callId = accepted.extra.callId;
  await x.post({ 'payment-signature': header });
  x.include(keyOf(callId), TX);
  assert.equal((await x.post({ 'payment-signature': header })).statusCode, 200);
  const counter = async () =>
    (
      await x.f.sql<{ total: string; value_raw: string }>(
        `SELECT total::text, value_raw::text FROM paid_call_count WHERE chain_id = $1`,
        [CHAIN_ID],
      )
    )[0]!;
  assert.deepEqual(await counter(), { total: '1', value_raw: '100000' });
  const check = await checkPaidCalls(x.f.db, { chainId: CHAIN_ID, timeoutMs: 30_000 });
  assert.equal(check?.scan, 1);
  assert.equal(check?.drift, 0);
  assert.equal(check?.repaired, false);
  // A row that missed its +1 is added back by the same check, and only once.
  await x.f.sql(`UPDATE paid_call_count SET total = 0, value_raw = 0 WHERE chain_id = $1`, [
    CHAIN_ID,
  ]);
  const repaired = await checkPaidCalls(x.f.db, { chainId: CHAIN_ID, timeoutMs: 30_000 });
  assert.equal(repaired?.repaired, true);
  assert.deepEqual(await counter(), { total: '1', value_raw: '100000' });

  // Retention: input, result, legs and client key cleared; updated_at (the paid time) unchanged.
  const before = (await x.row(callId))!;
  assert.match(String(before.client_key), /^[0-9a-f]{64}$/);
  assert.ok(before.result_text);
  assert.ok(before.input);
  x.f.advance(PUBLIC_OFFER_RETENTION_MS + 1_000);
  const pass = await x.work();
  assert.equal(pass.json().swept, 1);
  const after = (await x.row(callId))!;
  assert.equal(after.input, null);
  assert.equal(after.result_text, null);
  assert.equal(after.seller_signature, null);
  assert.equal(after.client_key, '');
  assert.equal(after.updated_at, before.updated_at);
  assert.equal(after.state, 'delivered');
  assert.equal((await checkPaidCalls(x.f.db, { chainId: CHAIN_ID, timeoutMs: 30_000 }))?.drift, 0);
  // Asked again, the receipt stands and the result is gone.
  const gone = await x.post({ 'payment-signature': header });
  assert.equal(gone.statusCode, 410);
  assert.ok(gone.headers['payment-response']);
});

test('the Explorer lists and finds a paid public call with its real payer; the dashboard counts it, no buyer agent', async (t) => {
  const x = await fixture(t);
  const buyer = newBuyer();
  const { accepted, header } = await x.pay(buyer);
  await x.post({ 'payment-signature': header });
  const get = (query = '') => x.f.app.inject({ url: `${SERVICE_CALLS_PATH}${query}` });
  // Open: not listed, not counted anywhere.
  assert.equal((await get()).json().items.length, 0);
  x.include(keyOf(accepted.extra.callId), TX);
  assert.equal((await x.post({ 'payment-signature': header })).statusCode, 200);
  x.f.advance(120_000);
  const page = (await get()).json();
  assert.equal(page.total, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].tx_hash, TX);
  assert.equal(page.items[0].payer.toLowerCase(), buyer.address.toLowerCase());
  assert.doesNotMatch(JSON.stringify(page), /xp_|hello/);
  for (const q of [TX, buyer.address.toLowerCase(), SELLER.toLowerCase(), '777']) {
    x.f.advance(120_000);
    const found = (await get(`?q=${q}`)).json();
    assert.equal(found.items.length, 1, q);
    assert.equal(found.matches, 1, q);
  }
  x.f.advance(120_000);
  assert.equal((await get(`?q=0x${'12'.repeat(20)}`)).json().items.length, 0);

  const agg = await readWindow(x.f.db, await sourceTables(x.f.db), 0, x.f.clock() + 1);
  const hours = [...agg.hourly.values()];
  assert.equal(
    hours.reduce((n, m) => n + (m.get('calls') ?? 0n), 0n),
    1n,
  );
  assert.equal(
    hours.reduce((n, m) => n + (m.get('value') ?? 0n), 0n),
    100_000n,
  );
  assert.ok(BACKFILL_SOURCES.includes('public'));
});

test('the table refuses what the checks say: lower case, bounds, states, prefix', async (t) => {
  const x = await fixture(t);
  const insert = (over: Record<string, unknown>) => {
    const row: Record<string, unknown> = {
      call_id: 'xp_check',
      payer: `0x${'aa'.repeat(20)}`,
      ref: `0x${'bb'.repeat(32)}`,
      input_hash: `0x${'cc'.repeat(32)}`,
      client_key: '203.0.113.9',
      service_id: 'svc',
      offer_id: OFFER,
      offer_kind: 'hash',
      offer_version: 1,
      operator_id: 'op',
      agent_id: 'agent',
      pay_to: `0x${'dd'.repeat(20)}`,
      gross_raw: '100000',
      fee_raw: '10000',
      input: '{}',
      state: 'reserved',
      op_key: 'x402pub:xp_check',
      valid_after: 1,
      valid_before: 2,
      created_at: 1,
      updated_at: 1,
      ...over,
    };
    const keys = Object.keys(row);
    return x.f.db.query(
      `INSERT INTO feed_pay_public_calls (${keys.join(', ')})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };
  for (const bad of [
    { payer: `0x${'AA'.repeat(20)}` },
    { pay_to: `0x${'DD'.repeat(20)}` },
    { gross_raw: '49999' },
    { gross_raw: '10000001' },
    { fee_raw: '0' },
    { fee_raw: '100000' },
    { state: 'done' },
    { op_key: 'sfp:xp_check' },
  ])
    await assert.rejects(insert(bad), /check/i, JSON.stringify(bad));
  await insert({});
  // Open: one per (payer, offer, input) under another call id and ref is refused by the index.
  await assert.rejects(
    insert({ call_id: 'xp_two', ref: `0x${'ee'.repeat(32)}`, op_key: 'x402pub:xp_two' }),
    /unique|duplicate/i,
  );
  // The same (payer, ref) too.
  await assert.rejects(
    insert({
      call_id: 'xp_three',
      input_hash: `0x${'ff'.repeat(32)}`,
      op_key: 'x402pub:xp_three',
    }),
    /unique|duplicate/i,
  );
});

const CLIENT = clientAddressKey('203.0.113.9');
const OTHER_TX = `0x${'cd'.repeat(32)}` as Hex;
const STRANDED_MS = 6 * 3_600_000;
const reverted = (key: string) => ({
  key,
  status: 'failed' as const,
  txHash: TX,
  blockNumber: 5n,
  neverSent: false,
  errorCode: 'REVERTED',
});

test('one balance, four payments at once: one call stored and sent, the others refused before the row', async (t) => {
  const x = await fixture(t);
  const buyer = newBuyer();
  const texts = ['a', 'b', 'c', 'd'];
  const paying = await Promise.all(texts.map((text) => x.pay(buyer, { text })));
  const answers = await Promise.all(
    paying.map((p, i) => x.post({ 'payment-signature': p.header }, { text: texts[i] })),
  );
  assert.deepEqual(answers.map((a) => a.statusCode).sort(), [202, 409, 409, 409]);
  for (const a of answers.filter((b) => b.statusCode === 409)) {
    assert.equal(a.json().code, 'payer_in_flight');
    assert.ok(a.headers['retry-after']);
  }
  assert.equal(await x.rows(), 1);
  assert.equal(x.state.submitted.size, 1);
});

test('a payer with a call in flight spends no simulation; once it is in a block the payer may pay again', async (t) => {
  const x = await fixture(t);
  const buyer = newBuyer();
  const a = await x.pay(buyer, { text: 'a' });
  await x.post({ 'payment-signature': a.header }, { text: 'a' });
  const b = await x.pay(buyer, { text: 'b' });
  const before = x.state.simulations;
  const busy = await x.post({ 'payment-signature': b.header }, { text: 'b' });
  assert.equal(busy.statusCode, 409, busy.body);
  assert.equal(x.state.simulations, before);
  x.include(keyOf(a.accepted.extra.callId), TX);
  x.f.advance(61_000);
  await x.work();
  assert.equal((await x.row(a.accepted.extra.callId))!.state, 'delivered');
  const later = await x.post({ 'payment-signature': b.header }, { text: 'b' });
  assert.equal(later.statusCode, 202, later.body);
});

test('a revert on Base cools the payer down, an ERC-1271 payer too; other payers are not touched', async (t) => {
  const x = await fixture(t);
  const contract = newBuyer();
  x.state.code.add(contract.address.toLowerCase());
  x.state.contractAccepts = true;
  const accepted = await x.challenge();
  // A contract's signature no key recovers: only its own isValidSignature can say yes.
  const signed = await signedPayment(contract, CONFIG, accepted, { swapLegs: true });
  const first = await x.post({ 'payment-signature': paymentHeader(signed) });
  assert.equal(first.statusCode, 202, first.body);
  const key = keyOf(accepted.extra.callId);
  x.state.status.set(key, reverted(key));
  x.state.legs = 'unused';
  x.f.advance(61_000);
  await x.work();
  assert.equal((await x.row(accepted.extra.callId))!.state, 'failed');
  const again = await signedPayment(contract, CONFIG, await x.challenge(), { swapLegs: true });
  const before = x.state.simulations;
  const cooling = await x.post({ 'payment-signature': paymentHeader(again) });
  assert.equal(cooling.statusCode, 429, cooling.body);
  assert.equal(cooling.json().code, 'payer_cooling');
  assert.equal(x.state.simulations, before);
  assert.equal(x.state.submitted.size, 1);
  const other = await x.pay();
  assert.equal((await x.post({ 'payment-signature': other.header })).statusCode, 202);
});

test('the worker cron sweeps ended cool-downs of both lanes, and keeps a running one', async (t) => {
  const x = await fixture(t);
  await x.f.sql(
    `INSERT INTO x402_payer_cooldowns (lane, payer, until_ms) VALUES
       ('x402-settle', '0xended-settle', 1), ('x402-offer-pay', '0xended-offer', 1),
       ('x402-settle', '0xrunning', 9007199254740991)`,
  );
  assert.equal((await x.work()).statusCode, 200);
  assert.deepEqual(await x.f.sql('SELECT payer FROM x402_payer_cooldowns'), [
    { payer: '0xrunning' },
  ]);
});

test('never sent is not a revert: no cool-down', async (t) => {
  const x = await fixture(t);
  const buyer = newBuyer();
  const a = await x.pay(buyer, { text: 'a' });
  x.state.hookSimulateRefused = true;
  const failed = await x.post({ 'payment-signature': a.header }, { text: 'a' });
  x.state.hookSimulateRefused = false;
  assert.equal(failed.statusCode, 402, failed.body);
  const b = await x.pay(buyer, { text: 'b' });
  assert.equal((await x.post({ 'payment-signature': b.header }, { text: 'b' })).statusCode, 202);
});

test('budget: a call that ends unpaid costs its payer and client, never the seller or the day; a paid one costs them all', async (t) => {
  const limiter = new MemoryRateLimiter();
  const x = await fixture(t, { rateLimiter: limiter as RateLimiter });
  const buyer = newBuyer();
  const units = async () => ({
    payer: await limiter.count(`x402-offer-pay:payer:${buyer.address.toLowerCase()}`, 3_600_000),
    client: await limiter.count(`x402-offer-pay:client:${CLIENT}`, 86_400_000),
    payee: await limiter.count(`x402-offer-pay:payee:${SELLER.toLowerCase()}`, 86_400_000),
    day: await limiter.count('x402-offer-pay:day', 86_400_000),
  });
  const a = await x.pay(buyer);
  await x.post({ 'payment-signature': a.header });
  const key = keyOf(a.accepted.extra.callId);
  x.state.status.set(key, reverted(key));
  x.state.legs = 'unused';
  x.f.advance(61_000);
  await x.work();
  assert.equal((await x.row(a.accepted.extra.callId))!.state, 'failed');
  assert.deepEqual(await units(), { payer: 1, client: 1, payee: 0, day: 0 });

  const paid = await x.pay();
  await x.post({ 'payment-signature': paid.header });
  x.include(keyOf(paid.accepted.extra.callId), TX);
  x.f.advance(61_000);
  await x.work();
  assert.equal((await x.row(paid.accepted.extra.callId))!.state, 'delivered');
  const after = await units();
  assert.equal(after.client, 2);
  assert.equal(after.payee, 1);
  assert.equal(after.day, 1);
});

test('budget: a seller at its daily cap of paid calls still refuses, before the row and the kind', async (t) => {
  const limiter = new MemoryRateLimiter();
  const x = await fixture(t, { rateLimiter: limiter as RateLimiter });
  for (let i = 0; i < PUBLIC_OFFER_PER_PAYEE_DAY; i++)
    await limiter.hit(
      `x402-offer-pay:payee:${SELLER.toLowerCase()}`,
      PUBLIC_OFFER_PER_PAYEE_DAY,
      86_400_000,
    );
  const { header } = await x.pay();
  const res = await x.post({ 'payment-signature': header });
  assert.equal(res.statusCode, 429, res.body);
  assert.equal(await x.rows(), 0);
});

test('a payment over the gas or L1 fee cap is refused before the budget and the kind', async (t) => {
  const limiter = new MemoryRateLimiter();
  const x = await fixture(t, { rateLimiter: limiter as RateLimiter });
  const buyer = newBuyer();
  const { header } = await x.pay(buyer);
  x.state.withinCaps = false;
  const res = await x.post({ 'payment-signature': header });
  assert.equal(res.statusCode, 402, res.body);
  assert.equal(res.json().code, 'payment_too_costly');
  assert.equal(await x.rows(), 0);
  assert.equal(
    await limiter.count(`x402-offer-pay:payer:${buyer.address.toLowerCase()}`, 3_600_000),
    0,
  );
  assert.equal(await limiter.count(`x402-offer-pay:client:${CLIENT}`, 86_400_000), 0);
});

test('garbage signatures from a payer with no code: refused off-chain, no simulation, no shared unit', async (t) => {
  const limiter = new MemoryRateLimiter();
  const x = await fixture(t, { rateLimiter: limiter as RateLimiter });
  const accepted = await x.challenge();
  const swapped = await signedPayment(newBuyer(), CONFIG, accepted, { swapLegs: true });
  const res = await x.post({ 'payment-signature': paymentHeader(swapped) });
  assert.equal(res.statusCode, 402, res.body);
  assert.equal(res.json().code, 'payment_invalid');
  assert.equal(x.state.simulations, 0);
  assert.equal(await limiter.count('x402-offer-pay:simulations', 60_000), 0);
  // Too long for an EOA, valid form otherwise.
  const long = await signedPayment(newBuyer(), CONFIG, accepted);
  long.payload.seller.signature += 'ab';
  const longer = await x.post({ 'payment-signature': paymentHeader(long) });
  assert.equal(longer.statusCode, 402, longer.body);
  assert.equal(x.state.simulations, 0);
  // A correct EOA signature does simulate.
  const good = await x.pay();
  assert.equal((await x.post({ 'payment-signature': good.header })).statusCode, 202);
  assert.ok(x.state.simulations > 0);
});

test('a payer without the price: refused with no simulation and no shared unit, contract or not', async (t) => {
  const limiter = new MemoryRateLimiter();
  const x = await fixture(t, { rateLimiter: limiter as RateLimiter });
  const accepted = await x.challenge();
  const buyer = newBuyer();
  x.state.usdc.set(buyer.address.toLowerCase(), BigInt(accepted.amount) - 1n);
  const short = await signedPayment(buyer, CONFIG, accepted);
  const res = await x.post({ 'payment-signature': paymentHeader(short) });
  assert.equal(res.statusCode, 402, res.body);
  assert.equal(res.json().code, 'payment_invalid');
  assert.equal(x.state.simulations, 0);
  assert.equal(await limiter.count('x402-offer-pay:simulations', 60_000), 0);

  // Base not answering decides nothing, and spends nothing shared.
  x.state.usdcDown = true;
  const down = await x.post({ 'payment-signature': paymentHeader(short) });
  assert.equal(down.statusCode, 503, down.body);
  assert.equal(x.state.simulations, 0);
  x.state.usdcDown = false;

  // Exactly the price is enough to be simulated.
  x.state.usdc.set(buyer.address.toLowerCase(), BigInt(accepted.amount));
  const enough = await x.post({ 'payment-signature': paymentHeader(short) });
  assert.notEqual(enough.json().code, 'payment_invalid', enough.body);
  assert.ok(x.state.simulations > 0);
});

test('one address reaches its own simulation limit well below the shared bucket; another address is not touched', async (t) => {
  const limiter = new MemoryRateLimiter();
  const x = await fixture(t, { rateLimiter: limiter as RateLimiter });
  const send = async (remoteAddress: string) => {
    const contract = newBuyer();
    x.state.code.add(contract.address.toLowerCase());
    const signed = await signedPayment(contract, CONFIG, await x.challenge(), { swapLegs: true });
    return x.f.app.inject({
      method: 'POST',
      url: URL_,
      headers: { 'content-type': 'application/json', 'payment-signature': paymentHeader(signed) },
      payload: JSON.stringify(INPUT),
      remoteAddress,
    });
  };
  for (let i = 0; i < 10; i++) assert.equal((await send('203.0.113.9')).statusCode, 402);
  assert.equal(x.state.simulations, 10);
  const over = await send('203.0.113.9');
  assert.equal(over.statusCode, 429, over.body);
  assert.equal(x.state.simulations, 10);
  assert.equal((await send('198.51.100.7')).statusCode, 402);
  assert.equal(x.state.simulations, 11);
});

test('our transaction reverted, the legs settled elsewhere with the right FeeCharged: paid, delivered, no cool-down', async (t) => {
  const x = await fixture(t);
  const buyer = newBuyer();
  const { accepted, header } = await x.pay(buyer);
  const callId = accepted.extra.callId;
  const key = keyOf(callId);
  await x.post({ 'payment-signature': header });
  x.state.status.set(key, reverted(key));
  x.state.legs = 'used';
  x.state.feeLogs = [{ ...x.feeLog(key), txHash: OTHER_TX, blockNumber: 9n }];
  x.f.advance(61_000);
  await x.work();
  const stored = (await x.row(callId))!;
  assert.equal(stored.state, 'delivered');
  assert.equal(stored.tx_hash, OTHER_TX);
  const read = await x.post({ 'payment-signature': header });
  assert.equal(read.statusCode, 200, read.body);
  assert.match(read.body, new RegExp(expectedHash));
  const counted = await x.f.sql<{ total: string }>(
    `SELECT total::text FROM paid_call_count WHERE chain_id = $1`,
    [CHAIN_ID],
  );
  assert.equal(counted[0]?.total, '1');
  const next = await x.pay(buyer, { text: 'next' });
  assert.equal(
    (await x.post({ 'payment-signature': next.header }, { text: 'next' })).statusCode,
    202,
  );
});

test('legs used elsewhere: a wrong FeeCharged never pays; an unreadable search waits', async (t) => {
  const x = await fixture(t);
  const { accepted, header } = await x.pay();
  const callId = accepted.extra.callId;
  const key = keyOf(callId);
  await x.post({ 'payment-signature': header });
  x.state.status.set(key, reverted(key));
  x.state.legs = 'used';
  x.state.feeLogs = null;
  x.f.advance(61_000);
  await x.work();
  assert.equal((await x.row(callId))!.state, 'sent');
  x.state.feeLogs = [{ ...x.feeLog(key, 200_000n), txHash: OTHER_TX, blockNumber: 9n }];
  x.f.advance(61_000);
  await x.work();
  const ended = (await x.row(callId))!;
  assert.equal(ended.state, 'failed');
  assert.equal(ended.failure_code, 'legs_used_elsewhere');
});

test('the check right before the send: a passing failure of Base is retried and the call goes out', async (t) => {
  const x = await fixture(t);
  const { accepted, header } = await x.pay();
  x.state.hookSimulateDown = 1;
  const res = await x.post({ 'payment-signature': header });
  assert.equal(res.statusCode, 202, res.body);
  assert.equal((await x.row(accepted.extra.callId))!.state, 'sent');
  assert.equal(x.state.submitted.get(keyOf(accepted.extra.callId))!.ran, true);
});

test('the check right before the send: a revert ends the call never sent', async (t) => {
  const x = await fixture(t);
  const { accepted, header } = await x.pay();
  x.state.hookSimulateRefused = true;
  const res = await x.post({ 'payment-signature': header });
  assert.equal(res.statusCode, 402, res.body);
  assert.equal(res.json().code, 'payment_failed');
  assert.equal((await x.row(accepted.extra.callId))!.state, 'failed');
  assert.equal(x.state.submitted.get(keyOf(accepted.extra.callId))!.ran, false);
});

test('the check right before the send: Base silent past its retries, the call keeps its result and goes out once later', async (t) => {
  const x = await fixture(t);
  const { accepted, header } = await x.pay();
  const callId = accepted.extra.callId;
  const key = keyOf(callId);
  x.state.hookSimulateDown = 99;
  const waiting = await x.post({ 'payment-signature': header });
  x.state.hookSimulateDown = 0;
  assert.equal(waiting.statusCode, 202, waiting.body);
  assert.doesNotMatch(waiting.body, new RegExp(expectedHash));
  const held = (await x.row(callId))!;
  assert.equal(held.state, 'ran');
  assert.ok(held.result_text);
  assert.equal(x.state.submitted.get(key)!.ran, false);
  // The worker hands it over: one settlement, the result still only after it is paid.
  x.f.advance(61_000);
  await x.work();
  assert.equal((await x.row(callId))!.state, 'sent');
  assert.equal(x.state.submitted.get(key)!.ran, true);
  x.include(key, TX);
  x.f.advance(61_000);
  const paid = await x.post({ 'payment-signature': header });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.match(paid.body, new RegExp(expectedHash));
});

/** The pay module over the fixture's database and lane, with the pause read from `paused`. */
const payWithPause = (x: Awaited<ReturnType<typeof fixture>>, paused: () => Promise<boolean>) => {
  let runs = 0;
  const pay = createPublicOfferPay({
    db: x.f.db,
    env: process.env,
    now: x.f.clock,
    chainId: CHAIN_ID,
    secret: () => 'synthetic',
    lane: async () => x.lane,
    hosted: {
      forSponsor: async () => {
        throw new Error('not used');
      },
      run: async () => {
        runs += 1;
        return { ok: false, failure: 'not used' };
      },
    },
    preSign: async () => null,
    paused,
    screeningOn: () => true,
    cooldown: { record: async () => {}, cooling: async () => false },
    budget: async () => true,
    paidBudget: async () => {},
    simulations: async () => true,
    clientSimulations: async () => true,
    sellerSimulations: async () => true,
    sleep: async () => {},
  });
  return { pay, runs: () => runs };
};

/** A call that ran and was not handed over: its one request crashed right at the hand-over. */
const ranCall = async (x: Awaited<ReturnType<typeof fixture>>) => {
  const { accepted, header } = await x.pay();
  const callId = accepted.extra.callId;
  x.state.submitThrows = 'crash';
  await x.post({ 'payment-signature': header });
  x.state.submitThrows = null;
  assert.equal((await x.row(callId))!.state, 'ran');
  x.f.advance(61_000);
  return { callId, header, key: keyOf(callId) };
};

test('a pause that starts inside the check before the send: the call waits, then goes out once', async (t) => {
  const x = await fixture(t);
  const { callId, key } = await ranCall(x);
  const before = (await x.row(callId))!.result_text;
  // The send's own read says running; every read inside the check says paused.
  const reads = [false, true, true, true];
  const { pay, runs } = payWithPause(x, async () => reads.shift() ?? false);
  assert.equal(await pay.step(callId), false);
  assert.equal(reads.length, 0);
  const held = (await x.row(callId))!;
  assert.equal(held.state, 'ran');
  assert.ok(held.seller_signature, 'the legs are kept');
  assert.equal(held.result_text, before);
  assert.equal(x.state.submitted.get(key)!.ran, false);
  assert.equal(x.state.fenced.has(key), false);
  assert.equal((await x.lane.status(key))!.status, 'queued');
  // Resumed: the same key, the same pair, sent once. The kind never ran again.
  assert.equal(await pay.step(callId), true);
  assert.equal((await x.row(callId))!.state, 'sent');
  assert.equal(x.state.submitted.get(key)!.ran, true);
  assert.equal(x.state.submitted.get(key)!.count, 2, 'asked again under its key');
  assert.equal(x.state.submitted.size, 1);
  assert.equal(runs(), 0);
});

test('a pause inside the check that outlasts the window: fenced and ended, nothing sent, nothing released', async (t) => {
  const x = await fixture(t);
  const { callId, header, key } = await ranCall(x);
  const reads = [false, true, true, true];
  const { pay } = payWithPause(x, async () => reads.shift() ?? true);
  assert.equal(await pay.step(callId), false);
  assert.equal((await x.row(callId))!.state, 'ran');
  x.f.advance(700_000);
  // Past the window the pause no longer matters: followed from the stored key, then fenced.
  assert.equal(await pay.step(callId), true);
  assert.equal((await x.row(callId))!.state, 'sent');
  assert.equal(await pay.step(callId), true);
  const ended = (await x.row(callId))!;
  assert.equal(ended.state, 'failed');
  assert.equal(ended.failure_code, 'window_expired');
  assert.equal(ended.result_text, null);
  assert.equal(ended.seller_signature, null);
  assert.equal(x.state.fenced.has(key), true);
  assert.equal(x.state.submitted.get(key)!.ran, false);
  assert.equal((await x.lane.status(key))!.neverSent, true);
  const answer = await x.post({ 'payment-signature': header });
  assert.equal(answer.statusCode, 402, answer.body);
  assert.doesNotMatch(answer.body, new RegExp(expectedHash));
});

test('the window ending while a put-off call waits: the check refuses, it never goes out', async (t) => {
  const x = await fixture(t);
  const { callId, key } = await ranCall(x);
  const reads = [false, true, true, true];
  const { pay } = payWithPause(x, async () => reads.shift() ?? false);
  assert.equal(await pay.step(callId), false);
  // The row is 'sent' with a queued key: it is resumed only inside the window.
  await x.f.sql(`UPDATE feed_pay_public_calls SET state = 'sent' WHERE call_id = $1`, [callId]);
  x.f.advance(700_000);
  assert.equal(await pay.step(callId), true);
  assert.equal((await x.row(callId))!.failure_code, 'window_expired');
  assert.equal(x.state.submitted.get(key)!.ran, false);
});

test('the check right before the send: a failed read of the pause is retried, not the end of the call', async (t) => {
  const x = await fixture(t);
  const { accepted, header } = await x.pay();
  const callId = accepted.extra.callId;
  x.state.submitThrows = 'crash';
  await x.post({ 'payment-signature': header });
  x.state.submitThrows = null;
  assert.equal((await x.row(callId))!.state, 'ran');
  // The send's own read says running, the first one inside the check fails, then it answers.
  const reads = [false, true];
  const pay = createPublicOfferPay({
    db: x.f.db,
    env: process.env,
    now: x.f.clock,
    chainId: CHAIN_ID,
    secret: () => 'synthetic',
    lane: async () => x.lane,
    hosted: {
      forSponsor: async () => {
        throw new Error('not used');
      },
      run: async () => ({ ok: false, failure: 'not used' }),
    },
    preSign: async () => null,
    paused: async () => reads.shift() ?? false,
    screeningOn: () => true,
    cooldown: { record: async () => {}, cooling: async () => false },
    budget: async () => true,
    paidBudget: async () => {},
    simulations: async () => true,
    clientSimulations: async () => true,
    sellerSimulations: async () => true,
    sleep: async () => {},
  });
  x.f.advance(61_000);
  assert.equal(await pay.step(callId), true);
  assert.equal((await x.row(callId))!.state, 'sent');
  assert.equal(x.state.submitted.get(keyOf(callId))!.ran, true);
  assert.equal(reads.length, 0);
});

test('the key removed mid-flight: a sent call ends past its time limit with an ALERT, frees its slot, releases nothing', async (t) => {
  const logged: string[] = [];
  const x = await fixture(t, { logLine: (line) => logged.push(line) });
  const buyer = newBuyer();
  const { accepted, header } = await x.pay(buyer, { text: 'a' });
  const callId = accepted.extra.callId;
  await x.post({ 'payment-signature': header }, { text: 'a' });
  assert.equal((await x.row(callId))!.state, 'sent');
  x.control.laneGone = true;
  x.f.advance(700_000);
  await x.work();
  assert.equal((await x.row(callId))!.state, 'sent');
  x.f.advance(STRANDED_MS);
  await x.work();
  const ended = (await x.row(callId))!;
  assert.equal(ended.state, 'unmatched');
  assert.equal(ended.failure_code, 'not_followed');
  assert.equal(ended.seller_signature, null);
  const alerts = logged.filter((line) => line.includes('x402_offer.stranded'));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /ALERT/);
  const answer = await x.post({ 'payment-signature': header }, { text: 'a' });
  assert.equal(answer.statusCode, 502, answer.body);
  assert.equal(answer.json().code, 'settlement_unknown');
  assert.doesNotMatch(answer.body, /Nothing was charged/);
  assert.doesNotMatch(answer.body, new RegExp(expectedHash));
  // The key back: the slot is free again for this payer.
  x.control.laneGone = false;
  x.f.advance(PUBLIC_OFFER_READY_TTL_MS + 1);
  const next = await x.pay(buyer, { text: 'b' });
  assert.equal((await x.post({ 'payment-signature': next.header }, { text: 'b' })).statusCode, 202);
});

test('the key rotated: a settlement only read from now on, and a call never handed over, end the same way', async (t) => {
  const x = await fixture(t);
  const sent = await x.pay();
  await x.post({ 'payment-signature': sent.header });
  const held = await x.pay();
  x.state.submitThrows = 'crash';
  await x.post({ 'payment-signature': held.header });
  x.state.submitThrows = null;
  assert.equal((await x.row(held.accepted.extra.callId))!.state, 'ran');
  x.control.laneGone = true;
  x.f.advance(700_000 + STRANDED_MS);
  await x.work();
  assert.equal((await x.row(sent.accepted.extra.callId))!.state, 'unmatched');
  assert.equal((await x.row(held.accepted.extra.callId))!.state, 'unmatched');
  // A lane that answers, with a settlement stuck as 'submitted' (a rotated key's stored state only).
  x.control.laneGone = false;
  x.f.advance(PUBLIC_OFFER_READY_TTL_MS + 1);
  const slow = await x.pay();
  await x.post({ 'payment-signature': slow.header });
  x.f.advance(700_000);
  await x.work();
  assert.equal((await x.row(slow.accepted.extra.callId))!.state, 'sent');
  x.f.advance(STRANDED_MS);
  await x.work();
  assert.equal((await x.row(slow.accepted.extra.callId))!.failure_code, 'not_followed');
});

test("one seller's share runs out before the shared cap: its next payer is refused, no simulation", async (t) => {
  const limiter = new MemoryRateLimiter();
  const x = await fixture(t, { rateLimiter: limiter as RateLimiter });
  const accepted = await x.challenge();
  const seller = accepted.payTo.toLowerCase();
  for (let i = 0; i < PUBLIC_OFFER_SIMULATIONS_PER_SELLER_MINUTE; i++)
    await limiter.hit(
      `x402-offer-pay:simulations-seller:${seller}`,
      PUBLIC_OFFER_SIMULATIONS_PER_SELLER_MINUTE,
      60_000,
    );
  const payment = await signedPayment(newBuyer(), CONFIG, accepted);
  const res = await x.post({ 'payment-signature': paymentHeader(payment) });
  assert.equal(res.statusCode, 429, res.body);
  assert.equal(x.state.simulations, 0);
  assert.equal(await limiter.count('x402-offer-pay:simulations', 60_000), 0);
});

test('on the PostgreSQL limiter: a refused simulation check spends no later bucket; the next window opens', async (t) => {
  // The app's own limiter wiring over the fixture's real database, swapped in once it exists.
  let limiter: RateLimiter = new MemoryRateLimiter();
  const x = await fixture(t, {
    rateLimiter: {
      hit: (...args) => limiter.hit(...args),
      count: (...args) => limiter.count(...args),
    },
  });
  const pg = new PostgresRateLimiter(x.f.db, x.f.clock);
  limiter = pg;
  x.f.advance(60_000 - (x.f.clock() % 60_000));
  const clientKey = `x402-offer-pay:simulations-client:${CLIENT}`;
  const sellerKey = `x402-offer-pay:simulations-seller:${SELLER.toLowerCase()}`;
  const shared = 'x402-offer-pay:simulations';
  const fill = async (key: string, limit: number) => {
    for (let i = 0; i < limit; i++) assert.equal((await pg.hit(key, limit, 60_000)).allowed, true);
  };
  const attempt = async () => {
    const { header } = await x.pay();
    return x.post({ 'payment-signature': header });
  };
  // The address's share used up: nothing later is spent, nothing simulated.
  await fill(clientKey, PUBLIC_OFFER_SIMULATIONS_PER_CLIENT_MINUTE);
  assert.equal((await attempt()).statusCode, 429);
  assert.equal(await pg.count(sellerKey, 60_000), 0);
  assert.equal(await pg.count(shared, 60_000), 0);
  assert.equal(x.state.simulations, 0);
  // Next window, the seller's share used up: the shared cap is not spent either.
  x.f.advance(60_000);
  assert.equal(await pg.count(clientKey, 60_000), 0);
  await fill(sellerKey, PUBLIC_OFFER_SIMULATIONS_PER_SELLER_MINUTE);
  assert.equal((await attempt()).statusCode, 429);
  assert.equal(await pg.count(shared, 60_000), 0);
  assert.equal(x.state.simulations, 0);
  assert.equal(await x.rows(), 0);
  // Next window: open again, and this call took one unit of each.
  x.f.advance(60_000);
  assert.equal((await attempt()).statusCode, 202);
  assert.equal(await pg.count(clientKey, 60_000), 1);
  assert.equal(await pg.count(sellerKey, 60_000), 1);
  assert.equal(await pg.count(shared, 60_000), 1);
});

test("the allowlist '*' opens every offer id, and nothing without the switch", async () => {
  const { publicOfferAllowed } = await import('../server/feed/offers/public-route.js');
  const id = 'off_226jomer6asqml5x';
  assert.equal(
    publicOfferAllowed({ CITY_X402_PUBLIC_OFFERS: '1', CITY_X402_PUBLIC_OFFERS_ALLOW: '*' }, id),
    true,
  );
  assert.equal(
    publicOfferAllowed({ CITY_X402_PUBLIC_OFFERS: '1', CITY_X402_PUBLIC_OFFERS_ALLOW: ' * ' }, id),
    true,
  );
  assert.equal(publicOfferAllowed({ CITY_X402_PUBLIC_OFFERS_ALLOW: '*' }, id), false);
  assert.equal(
    publicOfferAllowed(
      { CITY_X402_PUBLIC_OFFERS: '1', CITY_X402_PUBLIC_OFFERS_ALLOW: '*' },
      'not-an-offer',
    ),
    false,
  );
  assert.equal(
    publicOfferAllowed(
      { CITY_X402_PUBLIC_OFFERS: '1', CITY_X402_PUBLIC_OFFERS_ALLOW: 'off_aaaaaaaaaaaaaaaa' },
      id,
    ),
    false,
  );
});
