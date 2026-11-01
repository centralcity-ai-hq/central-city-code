import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  decodeAbiParameters,
  decodeFunctionData,
  getAddress,
  hashTypedData,
  parseAbi,
  recoverTypedDataAddress,
  type Hex,
} from 'viem';
import { ownerTypedData } from '../server/base/chain/permissions.js';
import { createChainRuntime } from '../server/base/chain/runtime.js';
import { pgAuthorizationStore } from '../server/base/chain/stores.js';
import { transferAuthorizationTypedData } from '../server/base/chain/x402.js';
import { createRateService, RateError } from '../server/base/rate/service.js';
import { agentChainOf, agentChainsOf } from '../server/base/wallet/routes.js';
import type { ScreeningGate } from '../server/protocol/screening/gate.js';
import type { PayChainReader } from '../server/base/pay/chain.js';
import { feedServiceId } from '../server/feed/bazaar.js';
import { createOfferStore } from '../server/feed/offers/store.js';
import {
  createFeedPayEngine,
  feedPayKey,
  FeedPayRefusal,
  pinnedToRouter3,
} from '../server/feed/pay/engine.js';
import { withSellerChains } from '../server/feed/query.js';
import type { FeedService } from '../shared/feed.js';
import { HOSTED_SOURCE } from '../server/feed/types.js';
import type { Database } from '../server/database.js';
import { AGENT_URI_ORIGIN } from '../shared/base/on-base.js';
import {
  decodeRateCall,
  encodeRateCall,
  RATE_REGISTRY,
  rateCall,
  rateRegistryOf,
  starsValue,
} from '../shared/base/rate.js';
import {
  LIMIT_PERMISSION_END,
  permissionToJson,
  spendPermissionHash,
} from '../shared/base/spend-limits.js';
import type { SpendPermission } from '../shared/base/types.js';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network.js';
import {
  ARC_NETWORKS,
  ARC_TESTNET,
  ARC_USDC,
  chainNetwork,
  type ChainNetwork,
} from '../shared/chains.js';
import { offerInputSummary, offerOutputSummary } from '../shared/feed-offers.js';
import { FEED_PAY_PATHS, type FeedPayCall } from '../shared/feed-pay.js';
import { PROTOCOL_BASE_MAINNET } from '../shared/protocol.js';
import { BATCH_KEY_PREFIX } from '../server/protocol/x402/facilitator.js';
import { BODY, json, setup, withEnv, type FeedPayApp } from './helpers/feed-pay-app.js';
import { setup as facilitatorSetup, settlement } from './helpers/x402-fake-base.js';

/*
 * Feed pay and ratings per chain: an Arc agent buys from an Arc seller through Arc's chain side only,
 * no payment crosses chains, and Base is what it was. The real engine and chain side over two fake
 * chains; nothing reaches a network and nothing is sent. Synthetic data.
 */

const ARC_NET = chainNetwork(ARC_TESTNET, { CITY_ARC: '1' }) as ChainNetwork;
const ARC_ROUTER = getAddress(`0x${'a3'.repeat(20)}`);
const ARC_TREASURY = getAddress(`0x${'a4'.repeat(20)}`);
const BASE_ROUTER3 = PROTOCOL_BASE_MAINNET.feeRouter3;
const BASE_TREASURY = PROTOCOL_BASE_MAINNET.treasury;
const ORIGIN = 'https://centralcity.ai';
const HELLO = { body: { text: 'hello' } };
const PRICE = '100000';

const ARC_ENV = {
  CITY_ARC: '1',
  CITY_ARC_CHAIN_ID: String(ARC_TESTNET),
  CITY_ARC_FEE_ROUTER3: ARC_ROUTER,
  CITY_ARC_FEE_ROUTER3_FROM_BLOCK: '1',
  CITY_ARC_FEE_ROUTER3_ENABLED: '1',
  CITY_ARC_TREASURY: ARC_TREASURY,
};
const FEES_ON = {
  CITY_PROTOCOL_FEES: undefined,
  CITY_PROTOCOL_FEE_ROUTER3_ENABLED: '1',
  CITY_PAY_BATCH_WORKSPACES: undefined,
};
const ARC_UNSET = Object.fromEntries(Object.keys(ARC_ENV).map((name) => [name, undefined]));

async function fixture(
  t: test.TestContext,
  env: Record<string, string | undefined> = ARC_ENV,
  options: Pick<Parameters<typeof setup>[1] & object, 'arcScreening' | 'screeningProvider'> = {},
) {
  const f = await setup(t, {
    env: { ...ARC_UNSET, ...FEES_ON, ...env },
    arcNetwork: ARC_NET,
    facilitator: true,
    funds: 5_000_000n,
    cap: 5_000_000n,
    ...options,
  });
  f.base.state.feeRouter3 = { router: BASE_ROUTER3, treasury: BASE_TREASURY };
  f.base.state.feeRouter = { router: PROTOCOL_BASE_MAINNET.feeRouter, treasury: BASE_TREASURY };
  f.base.state.code.add(BASE_ROUTER3.toLowerCase());
  const arc = f.arcBase!;
  arc.state.feeRouter3 = { router: ARC_ROUTER, treasury: ARC_TREASURY };
  arc.state.code.add(ARC_ROUTER.toLowerCase());
  await f.limit();
  return f;
}

type Payer = Awaited<ReturnType<FeedPayApp['addPayer']>>;

let serial = 0;
const newPayer = (f: FeedPayApp) =>
  f.addPayer(`Synthetic owner ${++serial}`, 'Synthetic owner password of this test');

/** A payer's only wallet row moved to Arc, funded there, with an Arc limit; Base no longer knows it. */
async function onArc(f: FeedPayApp, p: Payer, funds = 5_000_000n) {
  const arc = f.arcBase!;
  await f.sql('UPDATE base_wallets SET chain_id = $2, spender_address = $3 WHERE wallet_id = $1', [
    p.walletId,
    ARC_TESTNET,
    arc.spender,
  ]);
  arc.credit(p.wallet, funds);
  const permission: SpendPermission = {
    account: getAddress(p.wallet),
    spender: arc.spender,
    token: getAddress(ARC_USDC),
    allowance: 5_000_000n,
    period: 86_400,
    start: Math.floor(f.clock() / 1000) - 86_400,
    end: LIMIT_PERMISSION_END,
    salt: BigInt(++serial),
    extraData: '0x',
  };
  await f.sql(
    `INSERT INTO base_spend_permissions (permission_id, wallet_id, chain_id, permission, signature,
       state, token, permission_hash, period_kind, cap_raw, onchain_model, owner_account_id,
       created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'signed', $6, $7, 'day', $8, 'full', $9, $10, $10)`,
    [
      randomUUID(),
      p.walletId,
      ARC_TESTNET,
      JSON.stringify(permissionToJson(permission)),
      Buffer.from('ab'.repeat(65), 'hex'),
      ARC_USDC.toLowerCase(),
      spendPermissionHash(ARC_NET, permission).toLowerCase(),
      '5000000',
      p.owner.id,
      f.clock(),
    ],
  );
}

let offers = 0;
/** An offer of `seller` and its Feed listing, as the offers store writes them. */
async function listOffer(
  f: FeedPayApp,
  seller: { walletId: string; wallet: string; agentId: string },
) {
  const tail = String(++offers)
    .replace(/[01890]/g, 'a')
    .padStart(16, 'q');
  const offerId = `off_${tail}`;
  const url = `${ORIGIN}/api/public/x402/${offerId}`;
  const id = feedServiceId(url);
  const at = f.clock();
  const payTo = getAddress(seller.wallet);
  await f.sql(
    `INSERT INTO city_offers (offer_id, operator_id, agent_id, wallet_id, pay_to, kind, title,
       description, tags, price_raw, discoverable, version, state, idem_key, risky,
       price_changed_at, created_at, updated_at, preset)
     VALUES ($1, 'op-seller', $2, $3, $4, 'hash', 'Text hash', 'The SHA-256 of a text.', '{}', $5,
       true, 1, 'active', $1, NULL, $6, $6, $6, NULL)`,
    [offerId, seller.agentId, seller.walletId, payTo, PRICE, at],
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
      PRICE,
      payTo,
      JSON.stringify(offerInputSummary('hash', null)),
      JSON.stringify(offerOutputSummary('hash')),
      at,
      payTo.toLowerCase(),
    ],
  );
  return id;
}

const quoteAs = (f: FeedPayApp, cookie: string, id: string, payload: Record<string, unknown>) => {
  f.advance(6_100);
  return f.app.inject({
    method: 'POST',
    url: FEED_PAY_PATHS.quote.replace(':id', id),
    headers: { ...json, cookie },
    payload: JSON.stringify(payload),
  });
};

const callAs = (f: FeedPayApp, cookie: string, id: string, payload: Record<string, unknown>) => {
  f.advance(12_100);
  return f.app.inject({
    method: 'POST',
    url: FEED_PAY_PATHS.call.replace(':id', id),
    headers: { ...json, cookie },
    payload: JSON.stringify(payload),
  });
};

/** Quote with the agent, then confirm, as the drawer does; the call's answer. */
async function buy(
  f: FeedPayApp,
  buyer: { owner: { cookie: string }; agentId: string },
  id: string,
) {
  const q = await quoteAs(f, buyer.owner.cookie, id, { inputs: HELLO, agentId: buyer.agentId });
  assert.equal(q.statusCode, 200, q.body);
  const res = await callAs(f, buyer.owner.cookie, id, {
    agentId: buyer.agentId,
    inputs: HELLO,
    quoteId: q.json().quoteId,
    maxAmountRaw: q.json().amount.raw,
    maxTotalRaw: q.json().total.raw,
    idempotencyKey: randomUUID(),
  });
  return { quote: q.json(), res };
}

async function finished(f: FeedPayApp, cookie: string, callId: string): Promise<FeedPayCall> {
  for (let i = 0; i < 600; i++) {
    const res = await f.app.inject({
      url: FEED_PAY_PATHS.callStatus.replace(':callId', callId),
      headers: { ...json, cookie },
    });
    const call = res.json() as FeedPayCall;
    if (call.done) return call;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the call did not finish');
}

test('Arc off: one engine asking nothing about chains, and Arc is never asked', async (t) => {
  withEnv(t, ARC_UNSET);
  const queries: string[] = [];
  const db = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as Database;
  let asked = 0;
  const engine = createFeedPayEngine({
    db,
    env: { CITY_BASE_MAINNET: '1' },
    chain: async () => {
      throw new Error('no chain here');
    },
    arc: {
      chain: async () => {
        asked++;
        throw new Error('Arc is off');
      },
      facilitator: async () => {
        asked++;
        return null;
      },
    },
  });
  await assert.rejects(
    engine.quote('account', 'svc_aaaaaaaaaaaaaaaaaaaa', { inputs: {}, agentId: 'an-agent' }),
    (error: FeedPayRefusal) => error.code === 'service_not_found',
  );
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /FROM feed_services/);
  queries.length = 0;
  await engine.history('account', 'an-agent');
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /FROM base_wallets/);
  queries.length = 0;
  await engine.agents('account');
  assert.ok(queries.every((sql) => !/base_identities/.test(sql)));
  assert.equal(asked, 0);
});

test('Arc off: a Base agent buys from a Base seller as ever, and Arc is untouched', async (t) => {
  const f = await fixture(t, {});
  const seller = await newPayer(f);
  const id = await listOffer(f, seller);
  const { quote, res } = await buy(f, { owner: f.owner, agentId: f.agentId }, id);
  assert.equal(quote.network, 'eip155:8453');
  assert.equal(res.statusCode, 200, res.body);
  await finished(f, f.owner.cookie, res.json().callId);
  assert.equal(f.base.balanceOf(seller.wallet), 5_000_000n + 90_000n);
  assert.equal(f.arcBase!.state.facilitator.submits.length, 0);
  assert.equal((await f.agents()).json().agents[0].chainId, undefined);
});

test('Arc on: a Base buyer and a Base seller go on exactly as with it off', async (t) => {
  const f = await fixture(t);
  const seller = await newPayer(f);
  const id = await listOffer(f, seller);
  const { quote, res } = await buy(f, { owner: f.owner, agentId: f.agentId }, id);
  assert.equal(quote.network, 'eip155:8453');
  assert.equal(quote.asset.address, PROTOCOL_BASE_MAINNET.usdc);
  assert.equal(res.statusCode, 200, res.body);
  const call = await finished(f, f.owner.cookie, res.json().callId);
  assert.equal(call.state, 'result_saved');
  assert.equal(call.payment?.network, 'eip155:8453');
  assert.match(call.payment?.explorerUrl ?? '', /basescan\.org/);
  assert.equal(f.base.balanceOf(seller.wallet), 5_000_000n + 90_000n);
  assert.equal(f.base.balanceOf(BASE_TREASURY), 10_000n);
  assert.equal(f.base.state.facilitator.submits.length, 1);
  const arc = f.arcBase!;
  assert.equal(arc.state.facilitator.submits.length, 0);
  assert.equal(arc.state.facilitator.canPayCalls, 0);
  assert.equal(arc.state.sends.length, 0);
});

test('an Arc buyer and an Arc seller: quoted on Arc, paid through Arc only, signed for USDC by the name USDC', async (t) => {
  const f = await fixture(t);
  const arc = f.arcBase!;
  const [buyer, seller] = [await newPayer(f), await newPayer(f)];
  await onArc(f, buyer);
  await onArc(f, seller, 0n);
  const id = await listOffer(f, seller);
  const baseSellerBefore = f.base.balanceOf(seller.wallet);
  const baseBuyerBefore = f.base.balanceOf(buyer.wallet);

  const { quote, res } = await buy(f, buyer, id);
  assert.equal(quote.network, `eip155:${ARC_TESTNET}`);
  assert.equal(quote.asset.address, ARC_USDC);
  assert.equal(quote.total.raw, PRICE);
  assert.equal(quote.protocolFee.raw, '10000');
  assert.equal(res.statusCode, 200, res.body);
  const callId = res.json().callId as string;
  const call = await finished(f, buyer.owner.cookie, callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  assert.equal(call.payment?.network, `eip155:${ARC_TESTNET}`);
  assert.ok(call.payment?.explorerUrl?.startsWith(`${ARC_NETWORKS[ARC_TESTNET].explorerUrl}/tx/`));

  // Same fee, on Arc alone.
  assert.equal(arc.balanceOf(seller.wallet), 90_000n);
  assert.equal(arc.balanceOf(ARC_TREASURY), 10_000n);
  assert.equal(arc.state.facilitator.submits.length, 1);
  assert.equal(f.base.state.facilitator.submits.length, 0);
  assert.equal(f.base.state.facilitator.canPayCalls, 0);
  assert.equal(f.base.state.sends.length, 0);
  assert.equal(f.base.balanceOf(seller.wallet), baseSellerBefore);
  assert.equal(f.base.balanceOf(buyer.wallet), baseBuyerBefore);

  const [row] = await f.sql<{ chain_id: number; fee_router: string; token_address: string }>(
    `SELECT c.chain_id, c.fee_router, p.token_address FROM feed_pay_calls c
     JOIN base_payments p ON p.payment_id = c.payment_id WHERE c.call_id = $1`,
    [callId],
  );
  assert.equal(Number(row!.chain_id), ARC_TESTNET);
  assert.equal(row!.fee_router, ARC_ROUTER.toLowerCase());
  assert.equal(row!.token_address, ARC_USDC.toLowerCase());
  const [move] = await f.sql<{ chain_id: number }>(
    'SELECT chain_id FROM feed_pay_float_moves WHERE call_id = $1',
    [callId],
  );
  assert.equal(Number(move!.chain_id), ARC_TESTNET);

  // The stored seller leg verifies under Arc's USDC domain, and not under Base's name.
  const stored = await pgAuthorizationStore(f.db).get(`${feedPayKey(callId, 0)}:seller`);
  assert.equal(stored!.chainId, ARC_TESTNET);
  const a = stored!.authorization;
  const typed = transferAuthorizationTypedData(ARC_NET, ARC_USDC, a);
  assert.equal(typed.domain.name, 'USDC');
  assert.equal(typed.domain.chainId, ARC_TESTNET);
  const [wrapper] = decodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'ownerIndex', type: 'uint256' },
          { name: 'signatureData', type: 'bytes' },
        ],
      },
    ],
    stored!.signature,
  );
  const signer = (domainName: string) =>
    recoverTypedDataAddress({
      ...ownerTypedData(
        ARC_TESTNET,
        a.from,
        hashTypedData({ ...typed, domain: { ...typed.domain, name: domainName } }),
      ),
      signature: wrapper.signatureData,
    });
  assert.equal(await signer('USDC'), arc.spenderSigner);
  assert.notEqual(await signer('USD Coin'), arc.spenderSigner);
});

test('no payment crosses chains: refused both ways before anything is signed', async (t) => {
  const f = await fixture(t);
  const arcBuyer = await newPayer(f);
  await onArc(f, arcBuyer);
  const arcSeller = await newPayer(f);
  await onArc(f, arcSeller, 0n);
  const baseSeller = await newPayer(f);
  const onArcId = await listOffer(f, arcSeller);
  const onBaseId = await listOffer(f, baseSeller);

  const nothingHappened = async () => {
    const calls = await f.sql('SELECT 1 FROM feed_pay_calls');
    assert.equal(calls.length, 0);
    assert.equal(f.base.state.facilitator.submits.length, 0);
    assert.equal(f.arcBase!.state.facilitator.submits.length, 0);
    assert.equal(f.base.state.sends.length, 0);
    assert.equal(f.arcBase!.state.sends.length, 0);
    assert.equal((await f.sql('SELECT 1 FROM base_x402_authorizations')).length, 0);
  };

  // Base buyer, Arc seller: the quote says so plainly.
  const q1 = await quoteAs(f, f.owner.cookie, onArcId, { inputs: HELLO, agentId: f.agentId });
  assert.equal(q1.statusCode, 409);
  assert.equal(q1.json().code, 'other_chain');
  assert.match(q1.json().error, /cross chains/);
  // A price check without an agent names the seller's chain; paying it from Base is still refused.
  const open = await quoteAs(f, f.owner.cookie, onArcId, { inputs: HELLO });
  assert.equal(open.statusCode, 200, open.body);
  assert.equal(open.json().network, `eip155:${ARC_TESTNET}`);
  const c1 = await callAs(f, f.owner.cookie, onArcId, {
    agentId: f.agentId,
    inputs: HELLO,
    quoteId: open.json().quoteId,
    maxAmountRaw: PRICE,
    maxTotalRaw: PRICE,
    idempotencyKey: randomUUID(),
  });
  assert.equal(c1.statusCode, 409, c1.body);
  assert.equal(c1.json().code, 'other_chain');

  // Arc buyer, Base seller.
  const q2 = await quoteAs(f, arcBuyer.owner.cookie, onBaseId, {
    inputs: HELLO,
    agentId: arcBuyer.agentId,
  });
  assert.equal(q2.statusCode, 409);
  assert.equal(q2.json().code, 'other_chain');
  const open2 = await quoteAs(f, arcBuyer.owner.cookie, onBaseId, { inputs: HELLO });
  assert.equal(open2.json().network, 'eip155:8453');
  const c2 = await callAs(f, arcBuyer.owner.cookie, onBaseId, {
    agentId: arcBuyer.agentId,
    inputs: HELLO,
    quoteId: open2.json().quoteId,
    maxAmountRaw: PRICE,
    maxTotalRaw: PRICE,
    idempotencyKey: randomUUID(),
  });
  assert.equal(c2.statusCode, 409, c2.body);
  assert.equal(c2.json().code, 'other_chain');
  await nothingHappened();
});

test('an outside x402 service is refused for an Arc agent, before the service is asked', async (t) => {
  const f = await fixture(t);
  const buyer = await newPayer(f);
  await onArc(f, buyer);
  const id = await f.list();
  const before = f.service.requests.length;
  const q = await quoteAs(f, buyer.owner.cookie, id, { inputs: BODY, agentId: buyer.agentId });
  assert.equal(q.statusCode, 409, q.body);
  assert.equal(q.json().code, 'other_chain');
  assert.match(q.json().error, /paid on Base/);
  assert.equal(f.service.requests.length, before);
  assert.equal(f.arcBase!.state.facilitator.canPayCalls, 0);
});

test('Arc on but its router 3 is off: nothing falls back to another router', async (t) => {
  const f = await fixture(t, { ...ARC_ENV, CITY_ARC_FEE_ROUTER3_ENABLED: undefined });
  const [buyer, seller] = [await newPayer(f), await newPayer(f)];
  await onArc(f, buyer);
  await onArc(f, seller, 0n);
  const id = await listOffer(f, seller);
  const q = await quoteAs(f, buyer.owner.cookie, id, { inputs: HELLO, agentId: buyer.agentId });
  assert.equal(q.statusCode, 200, q.body);
  const res = await callAs(f, buyer.owner.cookie, id, {
    agentId: buyer.agentId,
    inputs: HELLO,
    quoteId: q.json().quoteId,
    maxAmountRaw: PRICE,
    maxTotalRaw: PRICE,
    idempotencyKey: randomUUID(),
  });
  assert.equal(res.statusCode, 503, res.body);
  assert.equal(res.json().code, 'unavailable');
  assert.match(res.json().error, /^Payments on Arc Testnet are not available/);
  assert.equal((await f.sql('SELECT 1 FROM feed_pay_calls')).length, 0);
});

test('an agent on Arc mainnet buying a Base service is refused, never moved to Base', async (t) => {
  // Arc mainnet is listed now (manager recorded 31 Oct 2026), but payments don't cross chains.
  const f = await fixture(t, { CITY_ARC: '1' });
  const seller = await newPayer(f);
  const id = await listOffer(f, seller);
  await f.sql(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at, owner_account_id)
     SELECT 'arc-row', agent_id, operator_id, 5042, address, owner_address, spender_address,
       spender_key_ref, derivation, state, 1, 1, owner_account_id FROM base_wallets WHERE agent_id = $1`,
    [f.agentId],
  );
  await f.sql(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address, agent_card_uri,
       owner_of_identity, state, updated_at)
     VALUES ($1, 5042, $2, $3, 'https://card', $3, 'pending', 1)`,
    [f.agentId, f.owner.id, `0x${'7'.repeat(40)}`],
  );
  const q = await quoteAs(f, f.owner.cookie, id, { inputs: HELLO, agentId: f.agentId });
  assert.equal(q.statusCode, 409, q.body);
  assert.equal(q.json().code, 'other_chain');
  assert.equal(f.base.state.facilitator.submits.length, 0);
  assert.equal((await f.sql('SELECT 1 FROM feed_pay_calls')).length, 0);
});

test('an agent with a row on both chains and a live identity on Arc pays on Arc', async (t) => {
  const f = await fixture(t);
  const buyer = await newPayer(f);
  await onArc(f, buyer);
  await f.sql(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at, owner_account_id)
     SELECT 'base-row-of-arc-agent', agent_id, operator_id, $2, address, owner_address, spender_address,
       spender_key_ref, derivation, state, 1, 1, owner_account_id FROM base_wallets WHERE agent_id = $1`,
    [buyer.agentId, WALLET_CHAIN_ID],
  );
  await f.sql(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address, agent_card_uri,
       owner_of_identity, state, updated_at)
     VALUES ($1, $2, $3, $4, 'https://card', $4, 'pending', 1)`,
    [buyer.agentId, ARC_TESTNET, buyer.owner.id, `0x${'7'.repeat(40)}`],
  );
  const seller = await newPayer(f);
  await onArc(f, seller, 0n);
  const id = await listOffer(f, seller);
  const { res } = await buy(f, buyer, id);
  assert.equal(res.statusCode, 200, res.body);
  await finished(f, buyer.owner.cookie, res.json().callId);
  assert.equal(f.arcBase!.balanceOf(seller.wallet), 90_000n);
  assert.equal(f.base.state.facilitator.submits.length, 0);
  // Listed once, on Arc.
  const listed = await f.app.inject({
    url: FEED_PAY_PATHS.agents,
    headers: { ...json, cookie: buyer.owner.cookie },
  });
  const mine = listed.json().agents.filter((a: { agentId: string }) => a.agentId === buyer.agentId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].chainId, ARC_TESTNET);
});

test('an Arc agent sells on Arc: its offer names its Arc wallet', async (t) => {
  const f = await fixture(t);
  const seller = await newPayer(f);
  await onArc(f, seller, 0n);
  const offer = {
    key: 'arc-offer',
    agentId: seller.agentId,
    kind: 'hash',
    title: 'Text hash on Arc',
    description: 'The SHA-256 of a short text.',
    tags: ['Hash'],
    priceRaw: '50000',
  };
  const planWith = (chainEnv?: Record<string, string | undefined>) =>
    createOfferStore(f.db, {
      origin: ORIGIN,
      now: f.clock,
      ...(chainEnv ? { chainEnv } : {}),
    }).planOffers(seller.owner.id, [offer]);
  // The wallet is on Arc only: without Arc in view the agent has no wallet to be paid to.
  assert.equal((await planWith()).ok, false);
  const plan = await planWith(process.env);
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  const store = createOfferStore(f.db, { origin: ORIGIN, now: f.clock, chainEnv: process.env });
  await store.publishOffers(seller.owner.id, [offer], `batch-${randomUUID()}`, plan.hash!);
  const [row] = await f.sql<{ wallet_id: string; pay_to: string }>(
    'SELECT wallet_id, pay_to FROM city_offers WHERE agent_id = $1',
    [seller.agentId],
  );
  assert.equal(row!.wallet_id, seller.walletId);
  assert.equal(getAddress(row!.pay_to), getAddress(seller.wallet));

  // Its wallet not ready: the refusal names Arc, the chain the agent is on, not Base.
  await f.sql('UPDATE base_owner_vaults SET backup_confirmed_at = NULL');
  const refused = await planWith(process.env);
  assert.equal(refused.ok, false);
  assert.equal(refused.refusals[0]!.reason, 'wallet_not_ready');
  assert.equal(
    refused.refusals[0]!.message,
    "The agent's wallet on Arc Testnet is not ready to be paid.",
  );
});

test('batches never mix chains: each engine hands settlements to its own lane', async (t) => {
  const f = await fixture(t);
  const arc = f.arcBase!;
  const [arcBuyer, arcSeller, baseSeller] = [
    await newPayer(f),
    await newPayer(f),
    await newPayer(f),
  ];
  await onArc(f, arcBuyer);
  await onArc(f, arcSeller, 0n);
  process.env.CITY_PAY_BATCH_WORKSPACES = `${arcBuyer.owner.id},${f.owner.id}`;
  f.base.state.facilitator.batch = { maxItems: 2 };
  arc.state.facilitator.batch = { maxItems: 2 };
  const onArcId = await listOffer(f, arcSeller);
  const onBaseId = await listOffer(f, baseSeller);

  const first = await buy(f, { owner: f.owner, agentId: f.agentId }, onBaseId);
  const second = await buy(f, arcBuyer, onArcId);
  assert.equal(first.res.statusCode, 200, first.res.body);
  assert.equal(second.res.statusCode, 200, second.res.body);
  const waitFor = async (lane: { batchLane: string[] }) => {
    for (let i = 0; i < 400 && lane.batchLane.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
  };
  await waitFor(f.base.state.facilitator);
  await waitFor(arc.state.facilitator);
  // One waiting on each lane: together they would fill a batch of two, and they don't.
  assert.deepEqual(f.base.state.facilitator.batches, []);
  assert.deepEqual(arc.state.facilitator.batches, []);
  assert.deepEqual(f.base.state.facilitator.batchLane, [feedPayKey(first.res.json().callId, 0)]);
  assert.deepEqual(arc.state.facilitator.batchLane, [feedPayKey(second.res.json().callId, 0)]);
});

test('the facilitator takes only its own chain into a batch, also from the same EOA', async (t) => {
  const { base, facilitator, db } = await facilitatorSetup(t, {
    batch: { maxItems: 50, windowMs: 1_500 },
  });
  const allowAll = async () => new Set<string>();
  const member = (i: number) => ({
    ...settlement(),
    ref: `0x${String(i).padStart(64, '0')}` as Hex,
  });
  const submit = (key: string, i: number) =>
    facilitator.submit({
      key,
      intentHash: `0x${(i + 0x100).toString(16).padStart(64, '0')}` as Hex,
      settlement: member(i),
      beforeBroadcast: async () => {},
      batch: { authorize: allowAll, grant: null },
    });
  await submit('here-1', 1);
  await submit('here-2', 2);
  await submit('other-chain', 3);
  await db.query('UPDATE x402_facilitator_ops SET chain_id = $2 WHERE op_key = $1', [
    'other-chain',
    ARC_TESTNET,
  ]);
  await facilitator.flushBatches(allowAll, true);
  assert.equal(base.sends.length, 1);
  const { rows } = await db.query<{ op_key: string; batch_key: string | null }>(
    'SELECT op_key, batch_key FROM x402_facilitator_ops WHERE op_key = ANY($1::text[])',
    [['here-1', 'here-2', 'other-chain']],
  );
  const of = (key: string) => rows.find((row) => row.op_key === key)!.batch_key;
  assert.ok(of('here-1')?.startsWith(BATCH_KEY_PREFIX));
  assert.equal(of('here-1'), of('here-2'));
  assert.equal(of('other-chain'), null);
});

test('service calls of an Arc agent: its owner reads them, anyone else gets 404', async (t) => {
  const f = await fixture(t);
  const buyer = await newPayer(f);
  await onArc(f, buyer);
  const read = (cookie: string) =>
    f.app.inject({
      url: FEED_PAY_PATHS.history.replace(':agentId', buyer.agentId),
      headers: { ...json, cookie },
    });
  assert.equal((await read(buyer.owner.cookie)).statusCode, 200);
  assert.equal((await read(f.owner.cookie)).statusCode, 404);
});

test('a cron run with Arc off leaves Arc calls alone', async (t) => {
  const f = await fixture(t);
  const arc = f.arcBase!;
  const [buyer, seller] = [await newPayer(f), await newPayer(f)];
  await onArc(f, buyer);
  await onArc(f, seller, 0n);
  const id = await listOffer(f, seller);
  arc.state.facilitator.mode = 'hold';
  const { res } = await buy(f, buyer, id);
  assert.equal(res.statusCode, 200, res.body);
  const callId = res.json().callId as string;
  for (let i = 0; i < 400 && arc.state.facilitator.submits.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  delete process.env.CITY_ARC;
  f.advance(10 * 60_000);
  const before = await f.sql('SELECT checked_at, state FROM feed_pay_calls WHERE call_id = $1', [
    callId,
  ]);
  const baseChainAsked = f.base.state.facilitator.canPayCalls;
  assert.equal((await f.cron()).statusCode, 200);
  const after = await f.sql('SELECT checked_at, state FROM feed_pay_calls WHERE call_id = $1', [
    callId,
  ]);
  assert.deepEqual(after, before);
  assert.equal(f.base.state.facilitator.canPayCalls, baseChainAsked);
});

test('the Arc runtime pays through its own router and facilitator, never Base router 3', () => {
  const env = {
    CITY_ARC: '1',
    CITY_ARC_CHAIN_ID: String(ARC_TESTNET),
    CITY_ARC_RPC_URL: 'https://arc.invalid/rpc',
    CITY_BASE_SPENDER_KEK: `v1:${Buffer.alloc(32, 7).toString('base64')}`,
    CITY_ARC_MAX_FEE_PER_GAS_WEI: '100000000000',
    CITY_ARC_IDENTITY_FEE_CAP_WEI: '1000000000000000',
    CITY_ARC_WALLET_FEE_CAP_WEI: '1000000000000000',
    CITY_ARC_PAYMASTER: '0x00000000000000000000000000000000000000a1',
    CITY_ARC_OWN_PAYMASTER: 'on',
    CITY_BASE_SUBMITTER_KEY_REFS: 'v1:00000000-0000-4000-8000-0000000000aa',
    CITY_BASE_PAYMASTER_SIGNER_KEY_REF: 'v1:00000000-0000-4000-8000-0000000000ab',
    CITY_X402_FACILITATOR_KEY_REF: 'v1:00000000-0000-4000-8000-0000000000ac',
    CITY_ARC_FACILITATOR_KEY_REF: 'v1:00000000-0000-4000-8000-0000000000ad',
    CITY_ARC_FEE_ROUTER3: ARC_ROUTER,
    CITY_ARC_FEE_ROUTER3_FROM_BLOCK: '1',
  };
  const db = { query: async () => ({ rows: [] }) } as unknown as Database;
  const runtime = createChainRuntime({ db, env, chainId: ARC_TESTNET });
  assert.ok(runtime.feedPay);
  assert.equal(runtime.feedPay().network.chainId, ARC_TESTNET);
  assert.ok(runtime.router3Facilitator?.());
  // Arc's facilitator is never Base's EOA.
  const shared = createChainRuntime({
    db,
    env: {
      ...env,
      ['CITY_ARC_FACILITATOR_KEY_REF']: env['CITY_X402_FACILITATOR_KEY_REF'],
    },
    chainId: ARC_TESTNET,
  });
  assert.equal(shared.router3Facilitator?.(), null);
  // No router of its own: no facilitator, and never Base's router in its place.
  const none = createChainRuntime({
    db,
    env: { ...env, CITY_ARC_FEE_ROUTER3: '' },
    chainId: ARC_TESTNET,
  });
  assert.equal(none.router3Facilitator?.(), null);
  // No fee budget: no Feed pay.
  const noCap = createChainRuntime({
    db,
    env: { ...env, CITY_ARC_WALLET_FEE_CAP_WEI: 'not a number' },
    chainId: ARC_TESTNET,
  });
  assert.throws(() => noCap.feedPay!(), /CITY_ARC_WALLET_FEE_CAP_WEI/);
});

test('rateCall names each chain’s registry; Base keeps its one', () => {
  const arcRegistry = getAddress(ARC_NETWORKS[ARC_TESTNET].contracts.reputationRegistry);
  assert.notEqual(arcRegistry, RATE_REGISTRY);
  assert.equal(rateRegistryOf(WALLET_CHAIN_ID), RATE_REGISTRY);
  assert.equal(rateRegistryOf(ARC_TESTNET), arcRegistry);
  assert.equal(rateRegistryOf(1), null);
  assert.equal(rateCall(7n, 5).target, RATE_REGISTRY);
  assert.equal(rateCall(7n, 5, arcRegistry).target, arcRegistry);
  const wallet = getAddress(`0x${'12'.repeat(20)}`);
  const onArcData = encodeRateCall(7n, 5, arcRegistry);
  assert.deepEqual(decodeRateCall(onArcData, wallet, arcRegistry), { agentId: 7n, stars: 5 });
  // A rating for one chain's registry isn't a rating on the other.
  assert.equal(decodeRateCall(onArcData, wallet), null);
  assert.equal(decodeRateCall(encodeRateCall(7n, 5), wallet, arcRegistry), null);
  assert.equal(starsValue(5), 100n);
  const inner = decodeFunctionData({
    abi: parseAbi(['function execute(address target, uint256 value, bytes data)']),
    data: onArcData,
  });
  assert.equal(getAddress(inner.args[0]), arcRegistry);
});

test('a rating on Arc reads Arc records and Arc’s reader, and goes to Arc’s registry', async (t) => {
  const f = await fixture(t);
  const [rater, rated] = [await newPayer(f), await newPayer(f)];
  await onArc(f, rater, 0n);
  await onArc(f, rated, 0n);
  const registry = ARC_NET.contracts.identityRegistry!;
  const confirmed = async (p: Payer, baseId: number, short: string) => {
    await f.sql('INSERT INTO base_short_ids VALUES ($1, $2, 1)', [short, p.agentId]);
    await f.sql(
      `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
         erc8004_agent_id, agent_card_uri, owner_of_identity, state, op_id, updated_at,
         register_op_id, mint_op_id, provisional_agent_id, mint_seen_at, mint_finality,
         transfer_op_id, handover_id, handover_finality, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', $8, 1, $9, $9, $5, 1, 'final', $8, $5,
         'final', 1)`,
      [
        p.agentId,
        ARC_TESTNET,
        p.owner.id,
        registry,
        baseId,
        `${AGENT_URI_ORIGIN}/a/${short}`,
        p.wallet,
        `identity:transfer:${ARC_TESTNET}:${p.agentId}~${baseId}`,
        `identity:register:${ARC_TESTNET}:${p.agentId}`,
      ],
    );
  };
  await confirmed(rater, 901, 'Rater1');
  await confirmed(rated, 902, 'Rated1');
  const asked: string[][] = [];
  const chain = {
    chainId: ARC_TESTNET,
    registry,
    ownerOf: async () => {
      throw new Error('not asked');
    },
    ownersOf: async (ids: string[]) => {
      asked.push(ids);
      return {
        block: 5n,
        blockHash: `0x${'5'.repeat(64)}` as Hex,
        owners: [rated.wallet, rater.wallet].map((w) => getAddress(w)),
      };
    },
  } as unknown as PayChainReader;
  const arcRegistry = getAddress(ARC_NET.contracts.reputationRegistry);
  let built: ReturnType<typeof rateCall> | null = null;
  const service = (registryAnswered: string) =>
    createRateService({
      db: f.db,
      chain,
      network: ARC_NET,
      now: f.clock,
      withdrawals: {
        rate: (async (
          _account: string,
          _agent: string,
          input: { beforePrepare: () => Promise<{ baseId: bigint; stars: 1 | 2 | 3 | 4 | 5 }> },
        ) => {
          const target = await input.beforePrepare();
          built = rateCall(target.baseId, target.stars, rateRegistryOf(ARC_TESTNET)!);
          return { summary: { registry: registryAnswered } };
        }) as never,
      },
    });
  const rates = service(arcRegistry);
  const target = await rates.lookup(rater.owner.id, rater.agentId, {
    baseId: '902',
    passport: 'Rated1',
  });
  assert.equal(target.agent.agentId, rated.agentId);
  assert.deepEqual(asked[0], ['902', '901']);
  const [lookup] = await f.sql<{ chain_id: number; registry_address: string }>(
    'SELECT chain_id, registry_address FROM base_rate_lookups WHERE lookup_id = $1',
    [target.lookupId],
  );
  assert.equal(Number(lookup!.chain_id), ARC_TESTNET);
  assert.equal(lookup!.registry_address.toLowerCase(), registry.toLowerCase());
  const body = () => ({
    to: { lookupId: target.lookupId },
    stars: 4,
    idempotencyKey: randomUUID(),
  });
  await rates.create(rater.owner.id, rater.agentId, body());
  assert.equal(built!.target, arcRegistry);
  // An operation aimed at another registry never reaches the owner to sign.
  await assert.rejects(
    service(RATE_REGISTRY).create(rater.owner.id, rater.agentId, body()),
    (error: RateError) => error.code === 'chain_unavailable',
  );
  // A reader of Base can't serve Arc's ratings.
  assert.throws(
    () =>
      createRateService({
        db: f.db,
        chain: { ...chain, chainId: WALLET_CHAIN_ID },
        network: ARC_NET,
        withdrawals: { rate: (async () => ({})) as never },
      }),
    /canonical registry/,
  );
  // A Base agent isn't one of Arc's raters.
  await assert.rejects(
    rates.lookup(f.owner.id, f.agentId, { baseId: '902', passport: 'Rated1' }),
    (error: RateError) => error.code === 'not_found',
  );
});

/** A buyer and a seller on Arc, and the seller's listing. */
async function arcPair(f: FeedPayApp) {
  const [buyer, seller] = [await newPayer(f), await newPayer(f)];
  await onArc(f, buyer);
  await onArc(f, seller, 0n);
  return { buyer, seller, id: await listOffer(f, seller) };
}

const ANOTHER_ROUTER = getAddress(`0x${'a9'.repeat(20)}`);
const stateOf = async (f: FeedPayApp, callId: string) =>
  (
    await f.sql<{ state: string; failure_code: string | null; fee_router: string | null }>(
      'SELECT state, failure_code, fee_router FROM feed_pay_calls WHERE call_id = $1',
      [callId],
    )
  )[0]!;

for (const [change, value] of [
  ['changed', ANOTHER_ROUTER],
  ['removed', undefined],
] as const)
  test(`a call sent on Arc finishes on its pinned router when the router setting is ${change}`, async (t) => {
    const f = await fixture(t);
    const arc = f.arcBase!;
    const { buyer, seller, id } = await arcPair(f);
    arc.state.facilitator.mode = 'hold';
    const { res } = await buy(f, buyer, id);
    assert.equal(res.statusCode, 200, res.body);
    const callId = res.json().callId as string;
    for (let i = 0; i < 400 && arc.state.facilitator.submits.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(arc.state.facilitator.submits.length, 1);

    if (value) process.env.CITY_ARC_FEE_ROUTER3 = value;
    else delete process.env.CITY_ARC_FEE_ROUTER3;
    await arc.landHeld();
    f.advance(10 * 60_000);
    assert.equal((await f.cron()).statusCode, 200);

    const call = await finished(f, buyer.owner.cookie, callId);
    assert.equal(call.state, 'result_saved', JSON.stringify(call));
    const row = await stateOf(f, callId);
    assert.equal(row.fee_router, ARC_ROUTER.toLowerCase());
    assert.equal(row.failure_code, null);
    assert.equal(arc.balanceOf(seller.wallet), 90_000n);
    assert.equal(arc.balanceOf(ARC_TREASURY), 10_000n);
  });

test('a NEW call on Arc pins only the configured router: never one from before a change', async (t) => {
  const f = await fixture(t);
  const arc = f.arcBase!;
  const { buyer, seller, id } = await arcPair(f);
  process.env.CITY_ARC_FEE_ROUTER3 = ANOTHER_ROUTER;

  // The configured router isn't there on chain: refused, nothing pinned, the old one not used.
  const q = await quoteAs(f, buyer.owner.cookie, id, { inputs: HELLO, agentId: buyer.agentId });
  assert.equal(q.statusCode, 200, q.body);
  const refused = await callAs(f, buyer.owner.cookie, id, {
    agentId: buyer.agentId,
    inputs: HELLO,
    quoteId: q.json().quoteId,
    maxAmountRaw: PRICE,
    maxTotalRaw: PRICE,
    idempotencyKey: randomUUID(),
  });
  assert.equal(refused.statusCode, 503, refused.body);
  assert.equal(refused.json().code, 'unavailable');
  assert.equal((await f.sql('SELECT 1 FROM feed_pay_calls')).length, 0);

  // Once it is there, a new call is pinned to it.
  arc.state.feeRouter3 = { router: ANOTHER_ROUTER, treasury: ARC_TREASURY };
  arc.state.code.add(ANOTHER_ROUTER.toLowerCase());
  const { res } = await buy(f, buyer, id);
  assert.equal(res.statusCode, 200, res.body);
  const callId = res.json().callId as string;
  await finished(f, buyer.owner.cookie, callId);
  assert.equal((await stateOf(f, callId)).fee_router, ANOTHER_ROUTER.toLowerCase());
  assert.equal(arc.balanceOf(seller.wallet), 90_000n);
});

test('a call on Arc not signed yet when the router changes ends unpaid: nothing is signed for the old one', async (t) => {
  let changeRouter = false;
  const f = await fixture(t, ARC_ENV, {
    arcScreening: {
      screen: async () => {
        // The first screening of the seller leg comes right before signing, the pin already stored.
        if (changeRouter) process.env.CITY_ARC_FEE_ROUTER3 = ANOTHER_ROUTER;
        return CLEAR;
      },
    } as unknown as ScreeningGate,
  });
  const arc = f.arcBase!;
  const { buyer, seller, id } = await arcPair(f);
  changeRouter = true;
  const { res } = await buy(f, buyer, id);
  assert.equal(res.statusCode, 200, res.body);
  const callId = res.json().callId as string;
  await finished(f, buyer.owner.cookie, callId);
  const row = await stateOf(f, callId);
  assert.equal(row.fee_router, ARC_ROUTER.toLowerCase());
  assert.equal(row.failure_code, 'interrupted');
  assert.equal(arc.state.facilitator.submits.length, 0);
  assert.equal(await pgAuthorizationStore(f.db).get(`${feedPayKey(callId, 0)}:seller`), null);
  assert.equal(arc.balanceOf(seller.wallet), 0n);
});

const CLEAR = {
  allowed: true,
  outcome: 'allowed',
  decisionId: 'synthetic',
  reason: 'clear',
  expiresAt: Date.now() + 3_600_000,
  reused: false,
};

for (const [name, arcScreening, code] of [
  [
    'blocked',
    {
      screen: async () => ({ ...CLEAR, allowed: false, outcome: 'blocked', reason: 'sanctioned' }),
    } as unknown as ScreeningGate,
    'screening_blocked',
  ],
  [
    'unavailable',
    {
      screen: async () => {
        throw new Error('The oracle did not answer.');
      },
    } as unknown as ScreeningGate,
    'screening_unavailable',
  ],
  ['not wired', null, 'screening_unavailable'],
] as const)
  test(`Arc always screens, CITY_PROTOCOL_SCREENING=0 too: a gate ${name} stops the call`, async (t) => {
    const f = await fixture(t, { ...ARC_ENV, CITY_PROTOCOL_SCREENING: '0' }, { arcScreening });
    const arc = f.arcBase!;
    const { buyer, seller, id } = await arcPair(f);
    const { res } = await buy(f, buyer, id);
    assert.equal(res.statusCode, 200, res.body);
    const callId = res.json().callId as string;
    await finished(f, buyer.owner.cookie, callId);
    assert.equal((await stateOf(f, callId)).failure_code, code);
    assert.equal(arc.state.facilitator.submits.length, 0);
    assert.equal(arc.balanceOf(seller.wallet), 0n);
    const outages = f.alerts.filter((a) => a.kind === 'screening_unavailable');
    if (code === 'screening_blocked') assert.equal(outages.length, 0);
    else {
      assert.equal(outages.length, 1, JSON.stringify(outages));
      assert.match(outages[0]!.detail ?? '', new RegExp(`^chain_${ARC_TESTNET}:`));
    }
  });

test("Arc on, CITY_PROTOCOL_SCREENING=0: Base's buyer isn't screened, and Arc's gate isn't asked", async (t) => {
  let askedBase = 0;
  let askedArc = 0;
  const f = await fixture(
    t,
    { ...ARC_ENV, CITY_PROTOCOL_SCREENING: '0' },
    {
      screeningProvider: () => {
        askedBase++;
        return null;
      },
      arcScreening: {
        screen: async () => {
          askedArc++;
          return CLEAR;
        },
      } as unknown as ScreeningGate,
    },
  );
  const seller = await newPayer(f);
  const id = await listOffer(f, seller);
  const { res } = await buy(f, { owner: f.owner, agentId: f.agentId }, id);
  assert.equal(res.statusCode, 200, res.body);
  const call = await finished(f, f.owner.cookie, res.json().callId);
  assert.equal(call.state, 'result_saved');
  assert.equal(askedBase, 0);
  assert.equal(askedArc, 0);
});

/** Every statement on this database from now on, in and out of a transaction. */
function recordSql(db: Database) {
  const seen: { text: string; params: unknown[] }[] = [];
  const recording = <T extends Pick<Database, 'query'>>(target: T) => {
    const query = target.query.bind(target);
    target.query = ((text: string, params: unknown[] = []) => {
      seen.push({ text, params });
      return query(text, params);
    }) as T['query'];
    return target;
  };
  recording(db);
  const transaction = db.transaction.bind(db);
  db.transaction = ((
    action: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => unknown,
  ) => transaction((tx) => action(recording(tx)) as Promise<unknown>)) as Database['transaction'];
  return seen;
}

/** The statements only Arc needs (agentChainOf, agentChainsOf, sellerEngine, livingOnArc). */
const ARC_ONLY_SQL = [
  /FROM base_wallets WHERE agent_id = \$1 AND chain_id IN \(\$2, \$3\)/,
  /FROM base_identities\s+WHERE agent_id = \$1 AND chain_id = \$2 AND state <> 'failed'/,
  /FROM base_wallets w\s+WHERE w\.agent_id = ANY\(\$1::text\[\]\) AND w\.chain_id IN/,
  /JOIN base_wallets w ON w\.wallet_id = o\.wallet_id\s+WHERE s\.id = \$1/,
  /FROM base_identities\s+WHERE agent_id = ANY\(\$1::text\[\]\) AND chain_id = \$2/,
];

test('Arc off: the live buy path issues none of Arc’s statements, recorded one by one', async (t) => {
  const f = await fixture(t, {});
  const seller = await newPayer(f);
  const id = await listOffer(f, seller);
  const seen = recordSql(f.db);
  const { res } = await buy(f, { owner: f.owner, agentId: f.agentId }, id);
  assert.equal(res.statusCode, 200, res.body);
  await finished(f, f.owner.cookie, res.json().callId);
  assert.equal((await f.cron()).statusCode, 200);
  assert.equal(f.base.balanceOf(seller.wallet), 5_000_000n + 90_000n);
  assert.ok(seen.length > 20, `recorded ${seen.length}`);
  for (const pattern of ARC_ONLY_SQL)
    assert.deepEqual(
      seen.filter(({ text }) => pattern.test(text)).map(({ text }) => text),
      [],
      String(pattern),
    );
  assert.deepEqual(
    seen.filter(({ params }) => params.includes(ARC_TESTNET)).map(({ text }) => text),
    [],
  );
});

test('the same recording with Arc on sees them: the Arc-off test can fail', async (t) => {
  const f = await fixture(t);
  const seller = await newPayer(f);
  const id = await listOffer(f, seller);
  const seen = recordSql(f.db);
  const { res } = await buy(f, { owner: f.owner, agentId: f.agentId }, id);
  assert.equal(res.statusCode, 200, res.body);
  await finished(f, f.owner.cookie, res.json().callId);
  assert.ok(seen.some(({ text }) => ARC_ONLY_SQL[0]!.test(text)));
});

test('agentChainsOf: one query, the same answer as agentChainOf, none with Arc off', async (t) => {
  const f = await fixture(t);
  const [baseOnly, arcOnly, bothLive, bothNone, bothFailed] = [
    await newPayer(f),
    await newPayer(f),
    await newPayer(f),
    await newPayer(f),
    await newPayer(f),
  ];
  await onArc(f, arcOnly, 0n);
  for (const payer of [bothLive, bothNone, bothFailed]) {
    await onArc(f, payer, 0n);
    await f.sql(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at, owner_account_id)
       SELECT $3, agent_id, operator_id, $2, address, owner_address, spender_address, spender_key_ref,
         derivation, state, 1, 1, owner_account_id FROM base_wallets WHERE agent_id = $1`,
      [payer.agentId, WALLET_CHAIN_ID, `base-row-${payer.agentId}`],
    );
  }
  for (const [payer, state] of [
    [bothLive, 'pending'],
    [bothFailed, 'failed'],
  ] as const)
    await f.sql(
      `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address, agent_card_uri,
         owner_of_identity, state, updated_at)
       VALUES ($1, $2, $3, $4, 'https://card', $4, $5, 1)`,
      [payer.agentId, ARC_TESTNET, payer.owner.id, `0x${'7'.repeat(40)}`, state],
    );
  const agents = [baseOnly, arcOnly, bothLive, bothNone, bothFailed].map((p) => p.agentId);
  agents.push('an-agent-with-no-wallet');

  const queries: string[] = [];
  const counted = {
    query: (text: string, params: unknown[]) => {
      queries.push(text);
      return f.db.query(text, params);
    },
  } as Pick<Database, 'query'>;
  const chains = await agentChainsOf(counted, process.env, agents);
  assert.equal(queries.length, 1);
  for (const agent of agents)
    assert.equal(
      chains.get(agent) ?? WALLET_CHAIN_ID,
      await agentChainOf(f.db, process.env, agent),
      agent,
    );
  assert.deepEqual(
    agents.map((agent) => chains.has(agent)),
    [false, true, true, false, false, false],
  );

  queries.length = 0;
  assert.equal((await agentChainsOf(counted, {}, agents)).size, 0);
  assert.equal((await agentChainsOf(counted, process.env, [])).size, 0);
  assert.equal(queries.length, 0);
});

test('a publish plan asks for the chains once with Arc on, per batch and not per wallet row; never with it off', async (t) => {
  const f = await fixture(t);
  const seller = await newPayer(f);
  await onArc(f, seller, 0n);
  await f.sql(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at, owner_account_id)
     SELECT 'base-row-of-seller', agent_id, operator_id, $2, address, owner_address, spender_address,
       spender_key_ref, derivation, state, 1, 1, owner_account_id FROM base_wallets WHERE agent_id = $1`,
    [seller.agentId, WALLET_CHAIN_ID],
  );
  await f.sql(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address, agent_card_uri,
       owner_of_identity, state, updated_at)
     VALUES ($1, $2, $3, $4, 'https://card', $4, 'pending', 1)`,
    [seller.agentId, ARC_TESTNET, seller.owner.id, `0x${'7'.repeat(40)}`],
  );
  const offer = {
    key: 'arc-offer',
    agentId: seller.agentId,
    kind: 'hash',
    title: 'Text hash on Arc',
    description: 'The SHA-256 of a short text.',
    tags: ['Hash'],
    priceRaw: '50000',
  };
  const seen = recordSql(f.db);
  const plan = await createOfferStore(f.db, {
    origin: ORIGIN,
    now: f.clock,
    chainEnv: process.env,
  }).planOffers(seller.owner.id, [offer]);
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  assert.equal(seen.filter(({ text }) => ARC_ONLY_SQL[2]!.test(text)).length, 1);
  assert.equal(seen.filter(({ text }) => ARC_ONLY_SQL[0]!.test(text)).length, 0);
  assert.equal(seen.filter(({ text }) => ARC_ONLY_SQL[1]!.test(text)).length, 0);

  seen.length = 0;
  await createOfferStore(f.db, { origin: ORIGIN, now: f.clock }).planOffers(seller.owner.id, [
    offer,
  ]);
  assert.ok(seen.length > 0);
  assert.ok(!seen.some(({ text }) => ARC_ONLY_SQL.some((pattern) => pattern.test(text))));
});

test('a call pinned on Arc stays with the facilitator whatever the router setting becomes', () => {
  const row = { fee_router: ARC_ROUTER };
  // Arc: changed or gone settings don't turn a paid call into one never sent.
  assert.equal(pinnedToRouter3(row, true, ARC_ROUTER), true);
  assert.equal(pinnedToRouter3(row, true, '0x00000000000000000000000000000000000000f9'), true);
  assert.equal(pinnedToRouter3(row, true, null), true);
  assert.equal(pinnedToRouter3({ fee_router: null }, true, ARC_ROUTER), false);
  // Base has older routers: only a match is router 3, as ever.
  assert.equal(pinnedToRouter3(row, false, ARC_ROUTER), true);
  assert.equal(pinnedToRouter3(row, false, '0x00000000000000000000000000000000000000f9'), false);
  assert.equal(pinnedToRouter3(row, false, null), false);
});

test("a listing names the chain it is paid on: an Arc seller's says Arc and its USDC, Base's stays", async (t) => {
  const f = await fixture(t);
  const [arcSeller, baseSeller] = [await newPayer(f), await newPayer(f)];
  await onArc(f, arcSeller, 0n);
  const onArcId = await listOffer(f, arcSeller);
  const onBaseId = await listOffer(f, baseSeller);
  const listing = (id: string, name: string) =>
    ({
      id,
      source: { name },
      network: 'eip155:8453',
      asset: { address: '0xbase', symbol: 'USDC', decimals: 6 },
    }) as unknown as FeedService;
  const shown = await withSellerChains(f.db, [
    listing(onArcId, HOSTED_SOURCE),
    listing(onBaseId, HOSTED_SOURCE),
    listing('svc_outside', 'x402 Bazaar'),
  ]);
  assert.equal(shown[0]!.network, `eip155:${ARC_TESTNET}`);
  assert.equal(shown[0]!.asset.address, ARC_USDC);
  assert.equal(shown[1]!.network, 'eip155:8453');
  assert.equal(shown[1]!.asset.address, '0xbase');
  assert.equal(shown[2]!.network, 'eip155:8453');
});

test('an Arc seller sees its sale on Arc: what it received, its Arc transaction, nothing of the buyer', async (t) => {
  const f = await fixture(t);
  const [buyer, seller] = [await newPayer(f), await newPayer(f)];
  await onArc(f, buyer);
  await onArc(f, seller, 0n);
  const id = await listOffer(f, seller);
  const { res } = await buy(f, buyer, id);
  assert.equal(res.statusCode, 200, res.body);
  const call = await finished(f, buyer.owner.cookie, res.json().callId);
  assert.equal(f.arcBase!.balanceOf(seller.wallet), 90_000n);

  const read = (agentId: string, cookie: string) =>
    f.app.inject({
      url: `${FEED_PAY_PATHS.history.replace(':agentId', agentId)}?sales=1`,
      headers: { ...json, cookie },
    });
  const history = (await read(seller.agentId, seller.owner.cookie)).json();
  assert.deepEqual(history.calls, [], 'the seller paid for nothing');
  assert.equal(history.sales.length, 1);
  const [sale] = history.sales;
  assert.equal(sale.saleId, call.callId);
  assert.equal(sale.service.title, 'Text hash');
  assert.equal(sale.received.raw, '90000');
  assert.equal(sale.price.raw, '100000');
  assert.equal(sale.txHash, call.payment!.txHash);
  assert.match(sale.explorerUrl, /arc/i);
  assert.equal(sale.state, 'final');
  // A sale says nothing of who bought or what they asked.
  const text = JSON.stringify(sale).toLowerCase();
  assert.ok(!text.includes(buyer.wallet.toLowerCase()));
  assert.ok(!text.includes(buyer.agentId));
  assert.ok(!text.includes('hello'));
  // The buyer has no sale; anyone else still gets 404.
  assert.deepEqual((await read(buyer.agentId, buyer.owner.cookie)).json().sales, []);
  assert.equal((await read(seller.agentId, buyer.owner.cookie)).statusCode, 404);
});
