import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { getAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { feedServiceId } from '../server/feed/bazaar.js';
import { HOSTED_SOURCE } from '../server/feed/types.js';
import type { FeedPayOp } from '../server/base/chain/feed-pay-chain.js';
import type { AuthorizationStore, IssuedAuthorization } from '../server/base/chain/x402.js';
import type { Router3FacilitatorPort } from '../server/feed/pay/router3.js';
import { createSponsorSigner } from '../server/feed/pay/sponsor-signer.js';
import { AGENT_URI_ORIGIN } from '../shared/base/on-base.js';
import { BASE_NETWORKS, type Address } from '../shared/base/chains.js';
import { offerInputSummary, offerOutputSummary } from '../shared/feed-offers.js';
import { setup } from './helpers/feed-pay-app.js';
import { WALLET_EXPECTED } from './wallet-network-fixture.js';

/*
 * The sponsored first purchase through the real app (server/feed/pay/sponsored-routes.ts): the
 * owner's session, the real migrations (248-250), the engine's own hosted-offer check and the real
 * 'hash' kind for the delivery. Only the sponsor's facilitator is a double (it records what it is
 * handed and answers the status the test sets); the sponsor's legs are really signed. Synthetic.
 */

const SELLER = getAddress(`0x${'5e'.repeat(20)}`);
const ROUTER3 = getAddress(`0x${'43'.repeat(20)}`);
const TREASURY = getAddress(`0x${'7e'.repeat(20)}`);
const START = Date.now() - 3_600_000;

function fakeFacilitator() {
  const submitted = new Map<string, Parameters<Router3FacilitatorPort['submit']>[0]>();
  const status = new Map<string, FeedPayOp>();
  const port: Router3FacilitatorPort = {
    submit: async (input) => {
      submitted.set(input.key, input);
      const op = status.get(input.key) ?? {
        key: input.key,
        status: 'submitted' as FeedPayOp['status'],
        txHash: null,
        blockNumber: null,
        neverSent: false,
        errorCode: null,
      };
      status.set(input.key, op);
      return op;
    },
    status: async (key) => status.get(key) ?? null,
    endUnsent: async () => true,
    canPay: async () => true,
    flushBatches: async () => {},
  };
  return { port, submitted, status };
}

function memoryStore(): AuthorizationStore {
  const rows = new Map<string, IssuedAuthorization>();
  return {
    get: async (id) => rows.get(id) ?? null,
    insert: async (row) => {
      if (!rows.has(row.paymentIntentId)) rows.set(row.paymentIntentId, row);
      return rows.get(row.paymentIntentId)!;
    },
  };
}

test('sponsored first purchase end to end: owner session → sponsor signs → its facilitator → delivered', async (t) => {
  const network = BASE_NETWORKS[WALLET_EXPECTED.chainId as 8453];
  const sponsor = privateKeyToAccount(generatePrivateKey());
  const facilitator = fakeFacilitator();
  const signer = createSponsorSigner({
    network,
    keystore: { withSigner: async (_ref, use) => use(sponsor) },
    keyRef: 'v1:sponsor',
    sponsor: sponsor.address as Address,
    token: network.tokens.USDC!.address as Address,
    store: memoryStore(),
    now: Date.now,
    router: ROUTER3,
    treasuryOf: async () => TREASURY,
  });
  let workspace = '';
  const f = await setup(t, {
    sponsorPay: async () => ({
      signer,
      facilitator: facilitator.port,
      usdcBalance: async () => 1_000_000_000n,
      expiredUnused: async () => false,
    }),
  });
  workspace = f.owner.id;
  // A Central City hosted 'hash' offer for 0.10 USDC, sold by another (fleet) workspace.
  const offerId = 'off_aaaaaaaaaaaaaaaa';
  const url = `https://centralcity.ai/api/public/x402/${offerId}`;
  const serviceId = feedServiceId(url);
  const at = f.clock();
  await f.sql(
    `INSERT INTO city_offers (offer_id, operator_id, agent_id, wallet_id, pay_to, kind, title,
       description, tags, price_raw, discoverable, version, state, idem_key, risky,
       price_changed_at, created_at, updated_at, preset)
     VALUES ($1, 'op-seller', 'agent-seller', 'wallet-seller', $2, 'hash', 'Text hash',
       'The SHA-256 of a text.', '{}', 100000, true, 1, 'active', $1, NULL, $3, $3, $3, NULL)`,
    [offerId, SELLER, at],
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
      `cc:${offerId}`,
      url,
      SELLER,
      JSON.stringify(offerInputSummary('hash', null)),
      JSON.stringify(offerOutputSummary('hash')),
      at,
      SELLER.toLowerCase(),
    ],
  );
  // The agent's passport is final (confirmed, started after the sponsored purchase's start).
  await f.sql(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
       erc8004_agent_id, agent_card_uri, owner_of_identity, state, op_id, updated_at,
       register_op_id, mint_op_id, provisional_agent_id, mint_seen_at, mint_finality,
       transfer_op_id, handover_id, handover_finality, started_at)
     VALUES ($1, $2, $3, $4, 501, $5, $6, 'confirmed', $7, $8, $9, $9, 501, 1, 'final', $7, 501,
       'final', $8)`,
    [
      f.agentId,
      WALLET_EXPECTED.chainId,
      workspace,
      WALLET_EXPECTED.registry,
      `${AGENT_URI_ORIGIN}/a/Sfp001`,
      f.wallet,
      `identity:transfer:${WALLET_EXPECTED.chainId}:${f.agentId}~501`,
      START + 1,
      `identity:register:${WALLET_EXPECTED.chainId}:${f.agentId}`,
    ],
  );
  process.env.CITY_SFP_ENABLED = '1';
  process.env.CITY_SFP_START_MS = String(START);
  process.env.CITY_SFP_FLEET_WORKSPACES = `${workspace},op-seller`;
  process.env.CITY_SFP_FLEET_OFFERS = offerId;
  t.after(() => {
    for (const k of [
      'CITY_SFP_ENABLED',
      'CITY_SFP_START_MS',
      'CITY_SFP_FLEET_WORKSPACES',
      'CITY_SFP_FLEET_OFFERS',
    ])
      delete process.env[k];
  });

  const post = (body: Record<string, unknown>, cookie = f.owner.cookie) =>
    f.app.inject({
      method: 'POST',
      url: `/api/feed/services/${serviceId}/sponsored-call`,
      headers: { 'content-type': 'application/json', 'x-city-request': '1', cookie },
      payload: JSON.stringify(body),
    });
  const body = {
    agent_id: f.agentId,
    use_credit: true,
    idempotency_key: `sfp-${f.agentId}`,
    inputs: { body: { text: 'hello' } },
    max_price_usdc: '0.1',
  };

  // Signed out: 401. Without use_credit: 400 (never a normal paid call).
  assert.equal((await post(body, '')).statusCode, 401);
  assert.equal((await post({ ...body, use_credit: undefined })).statusCode, 400);

  const started = await post(body);
  assert.equal(started.statusCode, 200, started.body);
  const call = started.json() as {
    callId: string;
    state: string;
    sponsored: boolean;
    payment: { payer: string };
  };
  assert.equal(call.state, 'sent');
  assert.equal(call.sponsored, true);
  assert.equal(call.payment.payer, sponsor.address);
  const handed = facilitator.submitted.get(`sfp:${call.callId}`)!;
  assert.equal(handed.settlement.payer, sponsor.address);
  assert.equal(handed.settlement.payee, SELLER);
  assert.equal(handed.settlement.gross, 100_000n);
  // The agent's own wallet is never touched: no Feed pay call, no reservation.
  assert.equal((await f.sql('SELECT 1 FROM feed_pay_calls')).length, 0);

  // The same key answers the same call; the credit is single-use.
  assert.equal(((await post(body)).json() as { callId: string }).callId, call.callId);
  const second = await post({ ...body, idempotency_key: 'another' });
  assert.equal(second.statusCode, 402);
  assert.deepEqual([second.json().code, second.json().reason], ['credit_unavailable', 'used']);

  // Included on Base, then the worker cron: paid, then delivered with the hash kind's answer.
  facilitator.status.set(`sfp:${call.callId}`, {
    key: `sfp:${call.callId}`,
    status: 'included',
    txHash: `0x${'ab'.repeat(32)}` as Hex,
    blockNumber: 7n,
    neverSent: false,
    errorCode: null,
  });
  const cron = () =>
    f.app.inject({
      url: '/api/cron/sfp-work',
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
  assert.equal((await cron()).statusCode, 200);
  await cron();
  const read = await f.app.inject({
    url: `/api/feed/sponsored-calls/${call.callId}`,
    headers: { 'x-city-request': '1', cookie: f.owner.cookie },
  });
  const done = read.json() as { state: string; result: { text: string } | null };
  assert.equal(done.state, 'delivered', read.body);
  assert.match(done.result!.text, new RegExp(createHash('sha256').update('hello').digest('hex')));
  const credit = await f.sql<{ state: string }>('SELECT state FROM feed_pay_sponsor_credits');
  assert.deepEqual(
    credit.map((r) => r.state),
    ['used'],
  );
});
