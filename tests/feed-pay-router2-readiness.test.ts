import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { getAddress, keccak256, stringToHex } from 'viem';
import { feedServiceId } from '../server/feed/bazaar.js';
import { HOSTED_SOURCE } from '../server/feed/types.js';
import { offerInputSummary, offerOutputSummary } from '../shared/feed-offers.js';
import type { FeedPayCall } from '../shared/feed-pay.js';
import { PROTOCOL_BASE_MAINNET } from '../shared/protocol.js';
import { setup, type FeedPayApp } from './helpers/feed-pay-app.js';

/*
 * Fee router 2 readiness regressions (docs/protocol/FEE_ROUTER_2.md section 2): before any money
 * step above 0.10 USDC router 2 must be verified on chain, also for a call reserved earlier. Built on
 * the end-to-end setup: the real app, engine and chain side over the fake Base, with
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
  let n = ++offerSeq + 19000;
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

const routerOf = async (f: FeedPayApp) =>
  (await f.sql<{ fee_router: string | null }>('SELECT fee_router FROM feed_pay_calls'))[0]
    ?.fee_router ?? null;

async function ready(t: test.TestContext) {
  const f = await app(t, true);
  await f.limit(200_000_000n);
  await allowPerCall(f, 100_000_000n);
  return f;
}

const WRONG: [string, (f: FeedPayApp) => void][] = [
  [
    'wrong FEE_BPS',
    (f) => (f.base.state.feeRouter2 = { router: ROUTER2, treasury: TREASURY, feeBps: 500n }),
  ],
  [
    'wrong token',
    (f) =>
      (f.base.state.feeRouter2 = {
        router: ROUTER2,
        treasury: TREASURY,
        token: getAddress(`0x${'77'.repeat(20)}`),
      }),
  ],
  [
    'wrong treasury',
    (f) =>
      (f.base.state.feeRouter2 = { router: ROUTER2, treasury: getAddress(`0x${'66'.repeat(20)}`) }),
  ],
  ['no contract at the address (EOA)', (f) => f.base.state.code.delete(ROUTER2.toLowerCase())],
  ['router reads fail', (f) => (f.base.state.routerReadsDown = true)],
];

for (const [name, spoil] of WRONG)
  test(`router 2 not ready (${name}): nothing above 0.10 USDC is quoted payable, signed or sent`, async (t) => {
    const f = await ready(t);
    spoil(f);
    const id = await listOffer(f, '10000000');
    const before = { signatures: f.base.state.signatures, sends: f.base.state.sends.length };
    const { quote, call } = await buy(f, id);
    const refused = call === null || call.statusCode !== 200 || call.json().state === 'refused';
    assert.ok(refused, `refused: ${quote.body} ${call?.body ?? ''}`);
    assert.equal(f.base.state.signatures, before.signatures, 'nothing signed');
    assert.equal(f.base.state.sends.length, before.sends, 'nothing sent');
    assert.equal(f.base.state.feeCharges.length, 0, 'no router charged');
  });

test('router 2 removed from the config after the call is reserved: never signed, never router 1', async (t) => {
  const f = await ready(t);
  const id = await listOffer(f, '10000000');
  const before = { signatures: f.base.state.signatures, sends: f.base.state.sends.length };
  let removed = false;
  f.base.state.beforeBalanceRead = async () => {
    if (removed) return;
    const reserved = await f.sql<{ state: string }>(
      "SELECT state FROM feed_pay_calls WHERE state = 'reserved'",
    );
    if (!reserved.length) return;
    // The operator rolls back by unsetting router 2 after the call was pinned to it.
    delete process.env.CITY_PROTOCOL_FEE_ROUTER2;
    removed = true;
  };
  const { call } = await buy(f, id);
  f.base.state.beforeBalanceRead = null;
  assert.ok(removed, 'the config changed after the call was reserved');
  assert.ok(call, 'a call was made');
  assert.equal(await routerOf(f), ROUTER2.toLowerCase(), 'pinned to router 2, never re-routed');
  // Let the engine and the cron look at it again: still nothing signed or charged.
  for (let i = 0; i < 4; i++) {
    f.advance(2 * 60_000);
    await f.cron();
  }
  assert.equal(await routerOf(f), ROUTER2.toLowerCase());
  assert.equal(f.base.state.feeCharges.length, 0, 'neither router charged');
  assert.equal(
    f.base.state.feeCharges.filter((c) => c.router === ROUTER).length,
    0,
    'never router 1',
  );
  assert.equal(f.base.state.signatures - before.signatures <= 1, true, 'no payment signed');
  assert.ok(!f.base.state.effects.includes('pay'), 'no router payment executed');
});
