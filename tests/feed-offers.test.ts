import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApp } from '../server/app.js';
import type { Database } from '../server/database.js';
import { agentWalletRecipe, deriveAddressLocal } from '../server/base/chain/derive.js';
import { accountIndexFor } from '../server/base/wallet/service.js';
import { feedServiceId } from '../server/feed/bazaar.js';
import { runFeedSync } from '../server/feed/ingest.js';
import {
  checkOffer,
  hashKind,
  OFFER_KIND_REGISTRY,
  offerKind,
  OfferKindInputError,
} from '../server/feed/offers/kinds.js';
import { FEED_OFFERS_SQL, feedOffersMigration } from '../server/feed/offers/schema.js';
import {
  FEED_OFFER_KINDS_V2_SQL,
  feedOfferKindsV2Migration,
} from '../server/feed/offers/kinds-schema.js';
import {
  createOfferStore,
  OFFER_CAP_ENV,
  OFFER_CAPS_DEFAULT,
  offerCaps,
  OfferError,
  offerListingUrl,
  type OfferCaps,
} from '../server/feed/offers/store.js';
import {
  FEED_OFFER_PRESETS_SQL,
  feedOfferPresetsMigration,
} from '../server/feed/offers/preset-schema.js';
import { refreshHostedUses } from '../server/feed/offers/uses.js';
import { feedPayIncludedSettledMigration } from '../server/feed/offers/uses-schema.js';
import { feedServiceDetail, feedStatus, searchFeedServices } from '../server/feed/query.js';
import { BAZAAR_SOURCE, HOSTED_SOURCE } from '../server/feed/types.js';
import { MAX_TOTAL } from '../server/protocol/fees/fee-call.js';
import { WALLET_CHAIN_ID, WALLET_NETWORK } from '../shared/base/wallet-network.js';
import {
  FEED_HOSTED_SOURCE,
  FEED_SOURCE,
  FEED_USDC,
  type FeedService,
  type FeedServiceQuery,
} from '../shared/feed.js';
import {
  checkOfferInput,
  checkOfferPreset,
  FEE_ROUTER_MAX_TOTAL,
  FEE_ROUTER_MIN_INCLUDED,
  mergeOfferPreset,
  OFFER_ID,
  OFFER_KIND_SPECS,
  OFFER_KINDS,
  offerInputSummary,
  type OfferInput,
} from '../shared/feed-offers.js';

/*
 * Feed offers (server/feed/offers): an owner's agents list built-in services in the Feed, fee
 * included, one offer or a hundred per publish. createApp on PGlite with synthetic owners, agents
 * and wallets (the wallet rows are built as the wallet service derives them; nothing reaches a
 * network and no money moves). Made-up, low-entropy data only.
 */

const NOW = Date.parse('2026-10-15T06:00:00Z');
const HOUR = 3_600_000;
const ORIGIN = 'https://city.example.com';
const HOST = 'city.example.com';
const json = { 'content-type': 'application/json', 'x-city-request': '1' };
const SPENDER = getAddress(`0x${'5b'.repeat(20)}`);
const LIST: FeedServiceQuery = {
  q: '',
  maxPrice: null,
  sort: 'most_used',
  host: null,
  cursor: null,
};

let address = 30;

interface Agent {
  id: string;
  wallet: string;
}

async function fixture(
  t: { after: (fn: () => unknown) => void },
  options: {
    agents?: number;
    caps?: Partial<OfferCaps>;
    wallets?: boolean;
    /** Agents created from My agents with a private profile (a manifest), not by the tool. */
    profiles?: boolean;
  } = {},
) {
  let clockMs = NOW;
  const clock = () => clockMs;
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: clock });
  t.after(() => app.close());
  const db: Database = app.city.db;
  const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    db.query<T>(text, params).then((res) => res.rows);

  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: json,
    payload: JSON.stringify({
      name: `Offer owner ${address}`,
      password: 'Synthetic offer owner pw',
    }),
    remoteAddress: `198.51.100.${address++}`,
  });
  assert.equal(register.statusCode, 201, register.body);
  const ownerId = register.json().operator.id as string;
  const cookie = `cc_session=${register.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
  const granted = await app.inject({
    method: 'POST',
    url: '/api/assistant-access',
    headers: { ...json, cookie },
    payload: JSON.stringify({
      label: 'Synthetic client',
      scopes: ['workspace:read', 'agents:create'],
      expiresInDays: 1,
    }),
  });
  assert.equal(granted.statusCode, 201, granted.body);
  const token = granted.json().token as string;

  const ownerKey = privateKeyToAccount(generatePrivateKey());
  await sql(
    `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key, kdf_params,
       cipher_params, version, backup_confirmed_at, created_at, updated_at)
     VALUES ($1, $2, decode($3, 'hex'), '{}', '{}', 1, 1, 1, 1)`,
    [ownerId, ownerKey.address, '5a'.repeat(48)],
  );
  const agents: Agent[] = [];
  for (let i = 0; i < (options.agents ?? 2); i++) {
    const created = options.profiles
      ? await app.inject({
          method: 'POST',
          url: '/api/agents',
          headers: { ...json, cookie },
          payload: JSON.stringify({
            name: `seller${i}`,
            capability: 'research',
            mode: 'hosted',
            visibility: 'private',
          }),
        })
      : await app.inject({
          method: 'POST',
          url: '/api/assistant/tools/city_create_agent',
          headers: { ...json, authorization: `Bearer ${token}` },
          payload: JSON.stringify({
            name: `seller${i}`,
            description: 'Synthetic agent',
            capability: 'research',
            mode: 'external',
            idempotencyKey: randomUUID(),
          }),
        });
    assert.equal(created.statusCode, options.profiles ? 201 : 200, created.body);
    const id = created.json().agent.id as string;
    const recipe = agentWalletRecipe(WALLET_NETWORK, ownerKey.address, accountIndexFor(id));
    const wallet = getAddress(deriveAddressLocal(recipe));
    if (options.wallets !== false)
      await sql(
        `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address,
           owner_address, spender_address, spender_key_ref, derivation, state, created_at,
           updated_at, owner_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'v1:00000000-0000-4000-8000-000000000001', $8,
           'derived', 1, 1, $3)`,
        [
          `wallet-${id}`,
          id,
          ownerId,
          WALLET_CHAIN_ID,
          wallet,
          ownerKey.address,
          SPENDER,
          JSON.stringify({
            version: 1,
            owners: recipe.owners,
            factory: recipe.factory,
            implementationVersion: 'test-impl-0001',
            accountIndex: recipe.index.toString(10),
          }),
        ],
      );
    agents.push({ id, wallet });
  }
  // The Bazaar's last complete sweep: the Feed answers lists from then on.
  await sql(
    `UPDATE feed_sources SET sweep_id = 1, sweep_offset = 0, last_attempt_at = $2,
       last_success_at = $2, last_total = 1, listed = 0 WHERE name = $1`,
    [BAZAAR_SOURCE, NOW],
  );
  await sql(
    `INSERT INTO feed_sources (name, sweep_id, last_attempt_at, last_success_at, last_total)
     VALUES ($1, 1, $2, $2, 1) ON CONFLICT (name) DO NOTHING`,
    [BAZAAR_SOURCE, NOW],
  );
  const store = createOfferStore(db, {
    origin: ORIGIN,
    now: clock,
    caps: { ...OFFER_CAPS_DEFAULT, ...options.caps },
  });
  const ownerRoute = (path: string, body: unknown = {}) =>
    app.inject({
      method: 'POST',
      url: path,
      headers: { ...json, cookie },
      payload: JSON.stringify(body),
    });
  const hostedVersion = async () =>
    Number(
      (
        await sql<{ v: string | number }>(
          'SELECT data_version AS v FROM feed_sources WHERE name = $1',
          [HOSTED_SOURCE],
        )
      )[0].v,
    );
  const list = async (limit = 100) => searchFeedServices(db, LIST, { limit, now: clockMs });
  /** Plans and publishes in one go; the plan must be ok. */
  const publish = async (offers: unknown, key = `batch-${randomUUID()}`) => {
    const plan = await store.planOffers(ownerId, offers);
    assert.ok(plan.ok, JSON.stringify(plan.refusals));
    return store.publishOffers(ownerId, offers, key, plan.hash!);
  };
  return {
    app,
    db,
    sql,
    ownerId,
    agents,
    store,
    ownerRoute,
    cookie,
    token,
    hostedVersion,
    list,
    publish,
    advance: (ms: number) => void (clockMs += ms),
    now: () => clockMs,
  };
}

const offer = (agent: Agent, key: string, fields: Partial<OfferInput> = {}): OfferInput => ({
  key,
  agentId: agent.id,
  kind: 'hash',
  title: `Text hash ${key}`,
  description: 'The SHA-256 of a short text.',
  tags: ['Hash', 'text'],
  priceRaw: '50000',
  ...fields,
});

const counts = async (sql: <T>(text: string, params?: unknown[]) => Promise<T[]>) =>
  (
    await sql<{ offers: number; rows: number }>(
      `SELECT (SELECT count(*) FROM city_offers)::int AS offers,
              (SELECT count(*) FROM feed_services WHERE source = 'Central City')::int AS rows`,
    )
  )[0];

// ---------------------------------------------------------------------------------------------
// The contract

test('contract: the price bounds are the fee router constants, everywhere they are written', () => {
  const router = readFileSync(
    new URL('../contracts/fees/CentralCityFeeRouter.sol', import.meta.url),
    'utf8',
  );
  assert.match(router, /uint256 public constant MIN_INCLUDED = 50_000;/);
  assert.match(router, /uint256 public constant MAX_TOTAL = 100_000;/);
  assert.equal(FEE_ROUTER_MIN_INCLUDED, 50_000);
  assert.equal(FEE_ROUTER_MAX_TOTAL, 100_000);
  assert.equal(BigInt(FEE_ROUTER_MAX_TOTAL), MAX_TOTAL);
  // The migration writes them (and the kinds) out: its text never changes once applied.
  assert.match(FEED_OFFERS_SQL, /price_raw >= 50000 AND price_raw <= 100000/);
  const kinds = /kind IN \(([^)]*)\)/.exec(FEED_OFFERS_SQL)![1].replace(/\s+/g, '');
  // 122 holds the first twenty kinds; 230 replaces the CHECK with every kind.
  assert.equal(
    kinds,
    OFFER_KINDS.slice(0, 20)
      .map((kind) => `'${kind}'`)
      .join(','),
  );
  const allKinds = /kind IN \(([^)]*)\)/.exec(FEED_OFFER_KINDS_V2_SQL)![1].replace(/\s+/g, '');
  assert.equal(allKinds, OFFER_KINDS.map((kind) => `'${kind}'`).join(','));
  assert.equal(feedOfferKindsV2Migration.version, 230);
  assert.equal(feedOffersMigration.version, 122);
  assert.equal(HOSTED_SOURCE, FEED_HOSTED_SOURCE.name);
  assert.equal(BAZAAR_SOURCE, FEED_SOURCE.name);
  assert.equal(FEED_HOSTED_SOURCE.credit, 'Listed on Central City');
});

test('kinds: the registry holds every built-in kind; hash answers sha256 hex of up to 8 KiB', async () => {
  assert.deepEqual([...OFFER_KIND_REGISTRY.keys()], [...OFFER_KINDS]);
  for (const name of OFFER_KINDS) assert.equal(offerKind(name)?.name, name);
  assert.equal(offerKind('hash'), hashKind);
  // A registry without a kind does not offer it.
  assert.equal(offerKind('web-read', new Map([[hashKind.name, hashKind]])), null);
  const ctx = { signal: new AbortController().signal, now: NOW };
  const answer = await hashKind.run({ text: 'hello' }, ctx);
  assert.equal(answer.mime, 'application/json');
  assert.deepEqual(answer.body, {
    algorithm: 'sha256',
    hex: createHash('sha256').update('hello').digest('hex'),
    bytes: 5,
  });
  // 8 KiB in UTF-8 bytes: 8,192 one-byte characters pass, a two-byte one past it does not.
  await hashKind.run({ text: 'a'.repeat(8_192) }, ctx);
  await assert.rejects(hashKind.run({ text: `${'a'.repeat(8_191)}é` }, ctx), OfferKindInputError);
  await assert.rejects(hashKind.run({ text: 'x', extra: 1 }, ctx), OfferKindInputError);
  await assert.rejects(hashKind.run({}, ctx), OfferKindInputError);
  await assert.rejects(hashKind.run('text', ctx), OfferKindInputError);
  // The pre-payment check: the schema, then the kind's own rules.
  assert.deepEqual(checkOffer(hashKind, { text: 'hello' }), { text: 'hello' });
  assert.throws(() => checkOffer(hashKind, { text: 'x', extra: 1 }), OfferKindInputError);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(hashKind.run({ text: 'x' }, { signal: aborted.signal, now: NOW }));
  // Every kind's example passes its own schema, and its listing shows the same fields.
  for (const kind of OFFER_KINDS) {
    const summary = offerInputSummary(kind);
    assert.equal(checkOfferInput(kind, JSON.parse(summary.example!)).ok, true, kind);
    assert.ok(summary.fields.every((field) => field.in === 'body'));
  }
  assert.equal(checkOfferInput('unit-convert', { value: 1, from: 'km', to: 'parsec' }).ok, false);
  assert.equal(checkOfferInput('base-block', { number: 1.5 }).ok, false);
});

test('kinds: an answer with a NUL character (U+0000) is refused by check(), before payment', async () => {
  const ctx = { signal: new AbortController().signal, now: NOW };
  const base64 = offerKind('base64')!;
  const url = offerKind('url-encode')!;
  const caseKind = offerKind('case-convert')!;
  // Decodes that give a NUL: refused as input errors, the same whether checked or run.
  for (const [kind, input] of [
    [base64, { text: 'AA==', mode: 'decode' }],
    [base64, { text: 'YQBi', mode: 'decode' }],
    [url, { text: '%00', mode: 'decode' }],
    [url, { text: 'a%00b', mode: 'decode' }],
    [caseKind, { text: 'a\u0000b', to: 'upper' }],
  ] as const) {
    assert.throws(() => checkOffer(kind, input), OfferKindInputError, JSON.stringify(input));
    await assert.rejects(kind.run(input, ctx), OfferKindInputError);
  }
  // Without one, the same kinds answer as before; an encode escapes it.
  assert.equal((await base64.run({ text: 'aGk=', mode: 'decode' }, ctx)).body, 'hi');
  assert.equal((await url.run({ text: '%41', mode: 'decode' }, ctx)).body, 'A');
  assert.equal((await url.run({ text: '\u0000', mode: 'encode' }, ctx)).body, '%00');
  assert.equal((await base64.run({ text: '\u0000', mode: 'encode' }, ctx)).body, 'AA==');
});

test('caps: generic env settings, positive integers only', () => {
  assert.deepEqual(OFFER_CAP_ENV, {
    activePerAgent: 'CITY_LIMIT_OFFERS_ACTIVE_PER_AGENT',
    perWorkspace: 'CITY_LIMIT_OFFERS_PER_WORKSPACE',
    writesPerWorkspacePerHour: 'CITY_LIMIT_OFFERS_WRITES_PER_WORKSPACE_PER_HOUR',
    priceChangeMinutes: 'CITY_LIMIT_OFFERS_PRICE_CHANGE_MINUTES',
  });
  assert.deepEqual(offerCaps({}), {
    activePerAgent: 5,
    perWorkspace: 2_000,
    writesPerWorkspacePerHour: 3_000,
    priceChangeMinutes: 60,
  });
  assert.equal(offerCaps({ CITY_LIMIT_OFFERS_PER_WORKSPACE: '10' }).perWorkspace, 10);
  for (const bad of ['0', '-1', '1.5', 'many'])
    assert.throws(() => offerCaps({ CITY_LIMIT_OFFERS_ACTIVE_PER_AGENT: bad }));
});

// ---------------------------------------------------------------------------------------------
// Create and list

test('a published offer shows at once on the unfiltered Feed, credited to Central City', async (t) => {
  const f = await fixture(t, { agents: 1 });
  const [agent] = f.agents;
  // The unfiltered order is cached per data version: read it first, so the publish must move it.
  assert.equal((await f.list()).total, 0);
  const versionBefore = await f.hostedVersion();

  const plan = await f.store.planOffers(f.ownerId, [offer(agent, 'one')]);
  assert.equal(plan.ok, true);
  assert.match(plan.hash!, /^[0-9a-f]{64}$/);
  assert.deepEqual(plan.items[0], {
    key: 'one',
    offerId: null,
    action: 'create',
    agentId: agent.id,
    payTo: agent.wallet,
    kind: 'hash',
    title: 'Text hash one',
    description: 'The SHA-256 of a short text.',
    tags: ['hash', 'text'],
    priceRaw: '50000',
    discoverable: true,
    state: 'active',
    preset: null,
    version: 1,
    listed: true,
  });
  // A dry run writes nothing.
  assert.deepEqual(await counts(f.sql), { offers: 0, rows: 0 });
  assert.equal(await f.hostedVersion(), versionBefore);

  const published = await f.store.publishOffers(
    f.ownerId,
    [offer(agent, 'one')],
    'batch-one-0001',
    plan.hash!,
  );
  assert.equal(published.replay, false);
  assert.equal(published.writes, 1);
  const offerId = published.offers[0].offerId;
  assert.match(offerId, OFFER_ID);
  assert.equal(await f.hostedVersion(), versionBefore + 1);

  const page = await f.list();
  assert.equal(page.total, 1);
  const service = page.services[0];
  const url = `${ORIGIN}/api/public/x402/${offerId}`;
  assert.equal(url, offerListingUrl(ORIGIN, offerId));
  assert.equal(service.id, feedServiceId(url));
  assert.equal(service.url, url);
  assert.equal(service.provider.host, HOST);
  assert.equal(service.method, 'POST');
  assert.equal(service.scheme, 'exact');
  assert.equal(service.x402Version, 2);
  assert.deepEqual(service.price, { raw: '50000', decimals: 6, display: '0.05', unit: 'per_call' });
  assert.equal(service.payTo, agent.wallet);
  assert.deepEqual(service.input, offerInputSummary('hash'));
  assert.deepEqual(service.source, {
    name: 'Central City',
    credit: 'Listed on Central City',
    url: FEED_HOSTED_SOURCE.url,
    recordId: `cc:${offerId}`,
    fetchedAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(service.usage.reportedBy, 'Central City');
  assert.equal(service.status, 'active');
  // Its detail and the Offered count follow too.
  assert.equal((await feedServiceDetail(f.db, service.id, NOW))!.service.url, url);
  assert.equal((await feedStatus(f.db, NOW)).services, 1);
  // The stored offer: pay_to copied from the wallet, fee-included price, discoverable by default.
  const [row] = await f.sql<Record<string, unknown>>(
    `SELECT operator_id, agent_id, wallet_id, pay_to, kind, price_raw::text AS price_raw,
       discoverable, version, state, idem_key FROM city_offers`,
  );
  assert.deepEqual(row, {
    operator_id: f.ownerId,
    agent_id: agent.id,
    wallet_id: `wallet-${agent.id}`,
    pay_to: agent.wallet,
    kind: 'hash',
    price_raw: '50000',
    discoverable: true,
    version: 1,
    state: 'active',
    idem_key: 'one',
  });
});

test('public JSON names the agent, its wallet, price and text only: no owner or workspace', async (t) => {
  const f = await fixture(t, { agents: 1 });
  await f.publish([offer(f.agents[0], 'snap')]);
  const [service] = (await f.list()).services;
  assert.deepEqual(Object.keys(service).sort(), [
    'asset',
    'capabilities',
    'description',
    'id',
    'input',
    'kind',
    'lastSeenAt',
    'method',
    'moreFromHost',
    'network',
    'output',
    'payTo',
    'price',
    'protocol',
    'provider',
    'scheme',
    'source',
    'status',
    'title',
    'url',
    'usage',
    'x402Version',
  ]);
  const { id, url, source, payTo, ...rest } = service;
  assert.deepEqual(rest, {
    kind: 'external_service',
    title: 'Text hash snap',
    capabilities: ['hash', 'text'],
    description: 'The SHA-256 of a short text.',
    provider: { host: HOST, name: null },
    method: 'POST',
    protocol: 'x402',
    x402Version: 2,
    network: 'eip155:8453',
    asset: FEED_USDC,
    scheme: 'exact',
    price: { raw: '50000', decimals: 6, display: '0.05', unit: 'per_call' },
    input: offerInputSummary('hash'),
    output: { format: 'json', fields: [], more: 0, example: null, exampleState: null },
    usage: { paidCalls30d: 0, payers30d: 0, lastCalledAt: null, reportedBy: 'Central City' },
    lastSeenAt: NOW,
    status: 'active',
    moreFromHost: 0,
  } satisfies Partial<FeedService>);
  assert.equal(payTo, f.agents[0].wallet);
  assert.equal(Object.keys(source).sort().join(), 'credit,fetchedAt,name,recordId,updatedAt,url');
  // No owner, workspace, agent id, private agent name or wallet row id anywhere in it.
  const text = JSON.stringify(service);
  for (const hidden of [
    f.ownerId,
    f.agents[0].id,
    'Offer owner',
    'seller0',
    'wallet-',
    'operator',
    'workspace',
  ])
    assert.ok(!text.includes(hidden), hidden);
  assert.match(id, /^svc_[a-z2-7]{20}$/);
  assert.ok(url.startsWith(`${ORIGIN}/api/public/x402/off_`));
});

test('30 offers from 15 wallets on one host show 2 per wallet: the cap counts sellers', async (t) => {
  const f = await fixture(t, { agents: 15 });
  const offers = f.agents.flatMap((agent, n) => [
    offer(agent, `w${n}-a`),
    offer(agent, `w${n}-b`, { priceRaw: '60000' }),
  ]);
  await f.publish(offers);
  const page = await f.list();
  assert.equal(page.total, 30);
  assert.equal(page.services.length, 30);
  assert.ok(page.services.every((service) => service.provider.host === HOST));
  assert.ok(page.services.every((service) => service.moreFromHost === 0));
  assert.equal((await feedStatus(f.db, NOW)).services, 30);

  // A third offer of one wallet: still 2 of it per page, the third behind moreFromHost.
  await f.publish([offer(f.agents[0], 'w0-c', { priceRaw: '70000' })]);
  const capped = await f.list();
  assert.equal(capped.total, 30);
  const mine = capped.services.filter((service) => service.payTo === f.agents[0].wallet);
  assert.equal(mine.length, 2);
  assert.ok(mine.every((service) => service.moreFromHost === 1));
  assert.equal((await feedStatus(f.db, NOW)).services, 30);
  // A search and the host filter partition the same way; ?host= lifts the cap.
  const searched = await searchFeedServices(f.db, { ...LIST, q: 'hash' }, { limit: 100, now: NOW });
  assert.equal(searched.total, 30);
  const hostOnly = await searchFeedServices(
    f.db,
    { ...LIST, host: HOST },
    { limit: 100, now: NOW },
  );
  assert.equal(hostOnly.total, 31);
});

test('risky text is stored but never listed', async (t) => {
  const f = await fixture(t, { agents: 1 });
  const published = await f.publish([
    offer(f.agents[0], 'risky', { title: 'Buy prepaid gift cards' }),
    offer(f.agents[0], 'contact', { description: 'Support desk +1 415 555 2671' }),
    offer(f.agents[0], 'fine'),
  ]);
  assert.deepEqual(
    published.offers.map((item) => [item.key, item.listed]),
    [
      ['risky', false],
      ['contact', false],
      ['fine', true],
    ],
  );
  assert.deepEqual(await f.sql(`SELECT idem_key, risky FROM city_offers ORDER BY idem_key`), [
    { idem_key: 'contact', risky: 'contact_details' },
    { idem_key: 'fine', risky: null },
    { idem_key: 'risky', risky: 'prepaid_cards' },
  ]);
  assert.equal((await counts(f.sql)).rows, 3);
  const page = await f.list();
  assert.deepEqual(
    page.services.map((service) => service.title),
    ['Text hash fine'],
  );
});

// ---------------------------------------------------------------------------------------------
// Bulk, idempotency, plan hash

test('bulk: 100 offers publish in one transaction with one version move; a replay changes nothing', async (t) => {
  const f = await fixture(t, { agents: 20 });
  const offers = f.agents.flatMap((agent, n) =>
    [0, 1, 2, 3, 4].map((i) =>
      offer(agent, `bulk-${n}-${i}`, { priceRaw: String(50_000 + i * 10_000) }),
    ),
  );
  assert.equal(offers.length, 100);
  const plan = await f.store.planOffers(f.ownerId, offers);
  assert.equal(plan.ok, true, JSON.stringify(plan.refusals));
  assert.equal(plan.writes, 100);

  // Every statement of the publish runs inside exactly one transaction.
  let transactions = 0;
  let outside = 0;
  const counted: Database = {
    ...f.db,
    query: (text, params) => {
      outside++;
      return f.db.query(text, params);
    },
    transaction: (action) => {
      transactions++;
      return f.db.transaction(action);
    },
  };
  const store = createOfferStore(counted, { origin: ORIGIN, now: f.now });
  const before = await f.hostedVersion();
  const published = await store.publishOffers(f.ownerId, offers, 'bulk-batch-0001', plan.hash!);
  assert.equal(transactions, 1);
  assert.equal(outside, 0);
  assert.equal(published.writes, 100);
  assert.equal(published.offers.length, 100);
  assert.ok(published.offers.every((item) => item.action === 'create' && item.listed));
  assert.equal(await f.hostedVersion(), before + 1);
  assert.deepEqual(await counts(f.sql), { offers: 100, rows: 100 });
  // 2 of each agent's 5 per page (one wallet each).
  assert.equal((await f.list()).total, 40);

  // The same key and batch again: the first answer, nothing written, no version move.
  const snapshot = await f.sql(
    'SELECT offer_id, version, updated_at FROM city_offers ORDER BY offer_id',
  );
  f.advance(60_000);
  const replay = await f.store.publishOffers(f.ownerId, offers, 'bulk-batch-0001', plan.hash!);
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.offers, published.offers);
  assert.equal(await f.hostedVersion(), before + 1);
  assert.deepEqual(
    await f.sql('SELECT offer_id, version, updated_at FROM city_offers ORDER BY offer_id'),
    snapshot,
  );
  // The same key for another batch is refused.
  await assert.rejects(
    f.store.publishOffers(f.ownerId, offers.slice(1), 'bulk-batch-0001', plan.hash!),
    (error: unknown) => error instanceof OfferError && error.code === 'idempotency_key_reused',
  );
  // The same batch planned again: every offer unchanged, nothing to write, still publishable.
  const again = await f.store.planOffers(f.ownerId, offers);
  assert.equal(again.ok, true);
  assert.equal(again.writes, 0);
  assert.ok(again.items.every((item) => item.action === 'unchanged' && item.offerId));
  const noop = await f.store.publishOffers(f.ownerId, offers, 'bulk-batch-0002', again.hash!);
  assert.equal(noop.writes, 0);
  assert.equal(await f.hostedVersion(), before + 1);
});

test('a changed plan with the old hash is refused, and nothing is written', async (t) => {
  const f = await fixture(t, { agents: 1 });
  const [agent] = f.agents;
  await f.publish([offer(agent, 'p1'), offer(agent, 'p2')]);
  const change = [offer(agent, 'p1', { title: 'New title' })];
  const plan = await f.store.planOffers(f.ownerId, change);
  assert.equal(plan.items[0].action, 'update');
  assert.equal(plan.items[0].version, 2);

  // Meanwhile another publish changes that offer: the plan no longer describes what would happen.
  await f.publish([offer(agent, 'p1', { description: 'Changed meanwhile.' })]);
  const version = await f.hostedVersion();
  await assert.rejects(
    f.store.publishOffers(f.ownerId, change, 'stale-plan-0001', plan.hash!),
    (error: unknown) => error instanceof OfferError && error.code === 'plan_changed',
  );
  // A batch that differs from what was planned is refused the same way.
  const fresh = await f.store.planOffers(f.ownerId, change);
  await assert.rejects(
    f.store.publishOffers(
      f.ownerId,
      [offer(agent, 'p1', { title: 'Other' })],
      'stale-plan-0002',
      fresh.hash!,
    ),
    (error: unknown) => error instanceof OfferError && error.code === 'plan_changed',
  );
  assert.equal(await f.hostedVersion(), version);
  assert.deepEqual(
    await f.sql(`SELECT title, description, version FROM city_offers WHERE idem_key = 'p1'`),
    [{ title: 'Text hash p1', description: 'Changed meanwhile.', version: 2 }],
  );
  assert.equal(
    (
      await f.sql('SELECT count(*)::int AS n FROM city_offer_batches WHERE idem_key LIKE $1', [
        'stale-%',
      ])
    )[0].n,
    0,
  );
  // Planned again, it publishes: the update is version 3, listed with the new title.
  const published = await f.store.publishOffers(f.ownerId, change, 'stale-plan-0003', fresh.hash!);
  assert.deepEqual(published.offers[0].version, 3);
  assert.ok((await f.list()).services.some((service) => service.title === 'New title'));
});

// ---------------------------------------------------------------------------------------------
// Checks and caps

test('price: refused below MIN_INCLUDED (50000) or above MAX_TOTAL (100000), whole base units only', async (t) => {
  const f = await fixture(t, { agents: 1 });
  const [agent] = f.agents;
  for (const priceRaw of ['49999', '100001', '0', '10000', '50000.5', '-50000', '5e4', '', 'x'])
    assert.deepEqual(
      (await f.store.planOffers(f.ownerId, [offer(agent, 'price', { priceRaw })])).refusals.map(
        (item) => item.reason,
      ),
      ['invalid_price'],
      priceRaw,
    );
  const bounds = await f.store.planOffers(f.ownerId, [
    offer(agent, 'low', { priceRaw: '50000' }),
    offer(agent, 'high', { priceRaw: '100000' }),
  ]);
  assert.equal(bounds.ok, true);
  // The table's outer bound is fee router 2's 100 USDC (migration 233): above it is refused too.
  await assert.rejects(
    f.sql(
      `INSERT INTO city_offers (offer_id, operator_id, agent_id, wallet_id, pay_to, kind, title,
         price_raw, idem_key, price_changed_at, created_at, updated_at)
       VALUES ('off_aaaaaaaaaaaaaaaa', $1, $2, 'w', $3, 'hash', 't', 100000001, 'k', 1, 1, 1)`,
      [f.ownerId, agent.id, agent.wallet],
    ),
  );
});

test('price with fee router 2 live: up to 100 USDC (100000000), never above; off = 0.10 as before', async (t) => {
  const f = await fixture(t, { agents: 1 });
  const [agent] = f.agents;
  const live = createOfferStore(f.db, {
    origin: ORIGIN,
    now: f.now,
    priceMaxRaw: () => 100_000_000,
  });
  const ok = await live.planOffers(f.ownerId, [offer(agent, 'one-usdc', { priceRaw: '1000000' })]);
  assert.equal(ok.ok, true, JSON.stringify(ok.refusals));
  const top = await live.planOffers(f.ownerId, [offer(agent, 'top', { priceRaw: '100000000' })]);
  assert.equal(top.ok, true, JSON.stringify(top.refusals));
  const over = await live.planOffers(f.ownerId, [offer(agent, 'over', { priceRaw: '100000001' })]);
  assert.deepEqual(
    over.refusals.map((item) => item.reason),
    ['invalid_price'],
  );
  // The default store (router 2 off) keeps refusing anything above 0.10 USDC.
  const off = await f.store.planOffers(f.ownerId, [
    offer(agent, 'one-usdc', { priceRaw: '1000000' }),
  ]);
  assert.deepEqual(
    off.refusals.map((item) => item.reason),
    ['invalid_price'],
  );
});

test('table: the migration accepts every built-in kind and no other', async (t) => {
  const f = await fixture(t, { agents: 1 });
  const [agent] = f.agents;
  const insert = (index: number, kind: string) =>
    f.sql(
      `INSERT INTO city_offers (offer_id, operator_id, agent_id, wallet_id, pay_to, kind, title,
         price_raw, idem_key, price_changed_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'w', $4, $5, 't', 50000, $6, 1, 1, 1)`,
      [
        `off_${'a'.repeat(14)}${'abcdefghijklmnopqrstuvwxyz'[index % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(index / 26)]}`,
        f.ownerId,
        agent.id,
        agent.wallet,
        kind,
        `table-kind-${index}`,
      ],
    );
  for (const [index, kind] of OFFER_KINDS.entries()) await insert(index, kind);
  assert.equal(
    (await f.sql('SELECT count(DISTINCT kind)::int AS n FROM city_offers'))[0].n,
    OFFER_KINDS.length,
  );
  await assert.rejects(insert(OFFER_KINDS.length, 'mint'));
});

test('checks: agent, wallet, pause, kind, text, keys; a refused plan cannot be published', async (t) => {
  const f = await fixture(t, { agents: 2 });
  const [agent, other] = f.agents;
  const reasons = async (offers: unknown[]) =>
    (await f.store.planOffers(f.ownerId, offers)).refusals.map((item) => [item.index, item.reason]);

  assert.deepEqual(await reasons([offer({ id: 'agent-unknown', wallet: '' }, 'x')]), [
    [0, 'agent_not_found'],
  ]);
  // Every built-in kind is offered; a kind the registry lacks is refused.
  assert.deepEqual(await reasons([offer(agent, 'x', { kind: 'web-read' })]), []);
  const hashOnly = createOfferStore(f.db, {
    origin: ORIGIN,
    now: f.now,
    registry: new Map([[hashKind.name, hashKind]]),
  });
  assert.deepEqual(
    (await hashOnly.planOffers(f.ownerId, [offer(agent, 'x', { kind: 'web-read' })])).refusals.map(
      (item) => [item.index, item.reason],
    ),
    [[0, 'kind_unavailable']],
  );
  assert.deepEqual(await reasons([{ ...offer(agent, 'x'), kind: 'mint' }]), [[0, 'invalid_kind']]);
  assert.deepEqual(await reasons([offer(agent, 'x', { title: ' ​ ' })]), [[0, 'invalid_title']]);
  assert.deepEqual(await reasons([offer(agent, 'x', { title: 'x'.repeat(81) })]), [
    [0, 'invalid_title'],
  ]);
  assert.deepEqual(await reasons([offer(agent, 'x', { tags: Array(9).fill('a') })]), [
    [0, 'invalid_tags'],
  ]);
  assert.deepEqual(await reasons([{ ...offer(agent, 'x'), extra: true }]), [[0, 'invalid_field']]);
  assert.deepEqual(await reasons([offer(agent, 'bad key!')]), [[0, 'invalid_key']]);
  assert.deepEqual(await reasons([offer(agent, 'same'), offer(other, 'same')]), [
    [1, 'duplicate_key'],
  ]);
  assert.deepEqual(await reasons([offer(agent, 'x', { state: 'removed' })]), [
    [0, 'invalid_state'],
  ]);
  await assert.rejects(
    f.store.planOffers(f.ownerId, []),
    (error: unknown) => error instanceof OfferError && error.code === 'invalid_batch',
  );
  await assert.rejects(
    f.store.planOffers(
      f.ownerId,
      Array.from({ length: 101 }, (_, i) => offer(agent, `k${i}`)),
    ),
    (error: unknown) => error instanceof OfferError && error.code === 'invalid_batch',
  );

  // No ready wallet: the vault's backup is not confirmed.
  await f.sql('UPDATE base_owner_vaults SET backup_confirmed_at = NULL');
  assert.deepEqual(await reasons([offer(agent, 'x')]), [[0, 'wallet_not_ready']]);
  await f.sql('UPDATE base_owner_vaults SET backup_confirmed_at = 1');

  // A paused agent can publish paused offers only.
  assert.equal((await f.ownerRoute(`/api/agents/${agent.id}/pause`)).statusCode, 200);
  assert.deepEqual(await reasons([offer(agent, 'x')]), [[0, 'agent_paused']]);
  assert.deepEqual(await reasons([offer(agent, 'x', { state: 'paused' })]), []);
  assert.equal((await f.ownerRoute(`/api/agents/${agent.id}/resume`)).statusCode, 200);

  // A refused plan has no hash, and publishing it is refused with the reasons.
  const refused = await f.store.planOffers(f.ownerId, [
    offer(agent, 'ok'),
    offer(agent, 'x', { priceRaw: '1' }),
  ]);
  assert.equal(refused.ok, false);
  assert.equal(refused.hash, null);
  await assert.rejects(
    f.store.publishOffers(
      f.ownerId,
      [offer(agent, 'ok'), offer(agent, 'x', { priceRaw: '1' })],
      'refused-0001',
      'a'.repeat(64),
    ),
    (error: unknown) =>
      error instanceof OfferError &&
      error.code === 'plan_refused' &&
      error.refusals.map((item) => item.reason).join() === 'invalid_price',
  );
  assert.deepEqual(await counts(f.sql), { offers: 0, rows: 0 });

  // An offer keeps its agent and its kind.
  await f.publish([offer(agent, 'mine')]);
  assert.deepEqual(await reasons([offer(other, 'mine')]), [[0, 'agent_changed']]);
});

test('caps: active per agent, per workspace, writes per hour, one price change per hour', async (t) => {
  const f = await fixture(t, {
    agents: 2,
    caps: { activePerAgent: 2, perWorkspace: 3, writesPerWorkspacePerHour: 5 },
  });
  const [a, b] = f.agents;
  const reasons = async (offers: unknown[]) =>
    (await f.store.planOffers(f.ownerId, offers)).refusals.map((item) => [item.key, item.reason]);

  // Active per agent: the third active one is refused; paused ones do not count.
  assert.deepEqual(await reasons([offer(a, 'a1'), offer(a, 'a2'), offer(a, 'a3')]), [
    ['a3', 'agent_offer_cap'],
  ]);
  await f.publish([offer(a, 'a1'), offer(a, 'a2'), offer(a, 'a3', { state: 'paused' })]);
  assert.deepEqual(await reasons([offer(a, 'a3')]), [['a3', 'agent_offer_cap']]);
  // Pausing one frees its slot in the same batch.
  assert.deepEqual(await reasons([offer(a, 'a1', { state: 'paused' }), offer(a, 'a3')]), []);

  // Per workspace (active and paused): 3 kept already, a fourth is refused.
  assert.deepEqual(await reasons([offer(b, 'b1')]), [['b1', 'workspace_offer_cap']]);

  // Writes per workspace per hour: 3 written this hour, 3 more would make 6 of 5 (the whole batch).
  const three = [
    offer(a, 'a1', { title: 'Changed' }),
    offer(a, 'a2', { title: 'Changed' }),
    offer(a, 'a3', { state: 'paused', title: 'Changed' }),
  ];
  assert.deepEqual(await reasons(three), [[null, 'write_rate']]);
  assert.deepEqual(await reasons(three.slice(0, 2)), []);
  // An hour later the window holds none of them.
  f.advance(HOUR);
  assert.deepEqual(await reasons(three), []);

  // Removing one frees its place in the workspace.
  await f.publish([offer(a, 'a3', { state: 'removed' })]);
  assert.deepEqual(await reasons([offer(b, 'b1')]), []);

  // One price change per offer per hour: creating it set the price.
  await f.publish([offer(b, 'b1', { priceRaw: '60000' })]);
  assert.deepEqual(await reasons([offer(b, 'b1', { priceRaw: '70000' })]), [
    ['b1', 'price_change_too_soon'],
  ]);
  // Other fields still change; the price again after the hour, then not again within the next.
  assert.deepEqual(await reasons([offer(b, 'b1', { priceRaw: '60000', title: 'Renamed' })]), []);
  f.advance(HOUR + 1);
  await f.publish([offer(b, 'b1', { priceRaw: '70000' })]);
  assert.deepEqual(await reasons([offer(b, 'b1', { priceRaw: '80000' })]), [
    ['b1', 'price_change_too_soon'],
  ]);
  assert.deepEqual(
    await f.sql(`SELECT price_raw::text AS price, version FROM city_offers WHERE idem_key = 'b1'`),
    [{ price: '70000', version: 2 }],
  );
});

test('caps: a pause or removal that changes nothing else is never refused by the hourly write cap', async (t) => {
  const f = await fixture(t, { agents: 1, caps: { writesPerWorkspacePerHour: 3 } });
  const [a] = f.agents;
  const published = await f.publish([offer(a, 'w1'), offer(a, 'w2'), offer(a, 'w3')]);
  const [w1, w2, w3] = published.offers.map((item) => item.offerId);
  const change = (changes: unknown[], key = `change-${randomUUID()}`) =>
    f.store.changeOffers(f.ownerId, changes as never, key);
  // The hour's budget is spent: any other change is refused.
  await assert.rejects(change([{ offerId: w1, title: 'Changed' }]), /cannot be published/);
  await assert.rejects(change([{ offerId: w1, state: 'paused', title: 'Changed' }]));
  // Taking offers off the Feed still works at once, and is recorded as writes.
  const paused = await change(
    [
      { offerId: w1, state: 'paused' },
      { offerId: w2, state: 'removed' },
    ],
    'withdraw-0001',
  );
  assert.deepEqual(
    paused.offers.map((item) => item.listed),
    [false, false],
  );
  assert.deepEqual(
    (await f.list()).services.map((service) => service.title),
    ['Text hash w3'],
  );
  const [batch] = await f.sql<{ writes: number }>(
    "SELECT writes FROM city_offer_batches WHERE idem_key = 'withdraw-0001'",
  );
  assert.equal(batch.writes, 2);
  // Paused, then removed: a withdrawal too. Listing one again is a write like any other.
  await change([{ offerId: w1, state: 'removed' }]);
  await assert.rejects(change([{ offerId: w3, title: 'Changed' }]));
  f.advance(HOUR);
  await change([{ offerId: w3, title: 'Changed' }]);
});

// ---------------------------------------------------------------------------------------------
// Pause, resume, revoke

test('pausing an agent or the workspace withdraws its offers in the same transaction; resuming lists them again; revoking removes them', async (t) => {
  const f = await fixture(t, { agents: 2 });
  const [agent, other] = f.agents;
  await f.publish([
    offer(agent, 'x1'),
    offer(agent, 'x2'),
    offer(other, 'y1'),
    offer(agent, 'x3', { state: 'paused' }),
  ]);
  const titles = async () => (await f.list()).services.map((service) => service.title).sort();
  assert.deepEqual(await titles(), ['Text hash x1', 'Text hash x2', 'Text hash y1']);

  let version = await f.hostedVersion();
  assert.equal((await f.ownerRoute(`/api/agents/${agent.id}/pause`)).statusCode, 200);
  assert.equal(await f.hostedVersion(), ++version);
  assert.deepEqual(await titles(), ['Text hash y1']);
  // The offers stay active: only their listing waits for the agent.
  assert.deepEqual(
    (
      await f.sql(`SELECT state FROM city_offers WHERE agent_id = $1 ORDER BY idem_key`, [agent.id])
    ).map((row) => (row as { state: string }).state),
    ['active', 'active', 'paused'],
  );
  assert.equal((await f.ownerRoute(`/api/agents/${agent.id}/resume`)).statusCode, 200);
  assert.equal(await f.hostedVersion(), ++version);
  // The paused offer stays withdrawn.
  assert.deepEqual(await titles(), ['Text hash x1', 'Text hash x2', 'Text hash y1']);

  // The workspace paused: every offer leaves the Feed; resumed: they come back.
  assert.equal((await f.ownerRoute('/api/workspace/pause', { paused: true })).statusCode, 200);
  assert.equal(await f.hostedVersion(), ++version);
  assert.deepEqual(await titles(), []);
  assert.deepEqual(
    (await f.store.planOffers(f.ownerId, [offer(other, 'y2')])).refusals.map((r) => r.reason),
    ['workspace_paused'],
  );
  assert.equal((await f.ownerRoute('/api/workspace/pause', { paused: false })).statusCode, 200);
  assert.equal(await f.hostedVersion(), ++version);
  assert.deepEqual(await titles(), ['Text hash x1', 'Text hash x2', 'Text hash y1']);

  // Revoking removes its offers for good; their keys can be used again (for another agent).
  assert.equal((await f.ownerRoute(`/api/agents/${agent.id}/revoke`)).statusCode, 200);
  assert.equal(await f.hostedVersion(), ++version);
  assert.deepEqual(await titles(), ['Text hash y1']);
  assert.deepEqual(
    (await f.sql(`SELECT DISTINCT state FROM city_offers WHERE agent_id = $1`, [agent.id])).map(
      (row) => (row as { state: string }).state,
    ),
    ['removed'],
  );
  const reused = await f.publish([offer(other, 'x1')]);
  assert.equal(reused.offers[0].action, 'create');
  assert.deepEqual(await titles(), ['Text hash x1', 'Text hash y1']);
});

test('a rename or a visibility change updates the listing name and its search text in the same transaction', async (t) => {
  const f = await fixture(t, { agents: 1, profiles: true });
  const [agent] = f.agents;
  await f.publish([offer(agent, 'n1'), offer(agent, 'n2', { state: 'paused' })]);
  const patch = (body: unknown) =>
    f.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: { ...json, cookie: f.cookie },
      payload: JSON.stringify(body),
    });
  const shown = async (q = '') =>
    (await searchFeedServices(f.db, { ...LIST, q }, { limit: 100, now: f.now() })).services.map(
      (service) => service.provider.name,
    );
  const stored = async () =>
    (
      await f.sql<{ provider_name: string | null; search_text: string }>(
        `SELECT provider_name, search_text FROM feed_services WHERE source = $1 ORDER BY record_id`,
        [HOSTED_SOURCE],
      )
    ).map((row) => [row.provider_name, row.search_text.includes('alice')]);
  assert.deepEqual(await shown(), [null]);

  let version = await f.hostedVersion();
  const pub = await patch({ visibility: 'public', name: 'Alice Bot' });
  assert.equal(pub.statusCode, 200, pub.body);
  assert.equal(await f.hostedVersion(), ++version);
  assert.deepEqual(await shown(), ['Alice Bot']);
  assert.deepEqual(await shown('alice'), ['Alice Bot']);
  // The paused offer's listing (withdrawn) follows too.
  assert.deepEqual(await stored(), [
    ['Alice Bot', true],
    ['Alice Bot', true],
  ]);

  assert.equal((await patch({ name: 'Bob Bot' })).statusCode, 200);
  assert.equal(await f.hostedVersion(), ++version);
  assert.deepEqual(await shown(), ['Bob Bot']);
  assert.deepEqual(await shown('alice'), []);

  // Private: no name on the Feed, and the old one finds nothing.
  assert.equal((await patch({ visibility: 'private' })).statusCode, 200);
  assert.equal(await f.hostedVersion(), ++version);
  assert.deepEqual(await shown(), [null]);
  assert.deepEqual(await shown('bob'), []);
  assert.deepEqual(await stored(), [
    [null, false],
    [null, false],
  ]);
  // A rename while private shows nothing either, and moves nothing.
  assert.equal((await patch({ name: 'Carol Bot' })).statusCode, 200);
  assert.equal(await f.hostedVersion(), version);
  assert.deepEqual(await shown('carol'), []);
});

test('a Team manifest apply that renames an agent or makes it private updates its listing name too', async (t) => {
  const f = await fixture(t, { agents: 1, profiles: true });
  const [agent] = f.agents;
  const patched = await f.app.inject({
    method: 'PATCH',
    url: `/api/agents/${agent.id}`,
    headers: { ...json, cookie: f.cookie },
    payload: JSON.stringify({ visibility: 'public', name: 'Alice Bot' }),
  });
  assert.equal(patched.statusCode, 200, patched.body);
  await f.publish([offer(agent, 'm1')]);
  const stored = async () =>
    (
      await f.sql<{ provider_name: string | null; search_text: string }>(
        `SELECT provider_name, search_text FROM feed_services WHERE source = $1`,
        [HOSTED_SOURCE],
      )
    ).map((row) => [row.provider_name, row.search_text.toLowerCase().includes('alice')]);
  assert.deepEqual(await stored(), [['Alice Bot', true]]);

  const [{ manifest, name }] = await f.sql<{ manifest: any; name: string }>(
    `SELECT manifest, manifest->'metadata'->>'name' AS name FROM agent_manifests
     WHERE agent_id = $1 ORDER BY revision DESC LIMIT 1`,
    [agent.id],
  );
  const apply = async (member: any) => {
    const res = await f.app.inject({
      method: 'POST',
      url: '/api/assistant/tools/city_apply_team',
      headers: { ...json, authorization: `Bearer ${f.token}` },
      payload: JSON.stringify({
        manifest: {
          apiVersion: manifest.apiVersion,
          kind: 'Team',
          metadata: { name: 'listing-team', displayName: 'Listing team' },
          spec: { coordinator: name, members: [{ name, manifest: member }] },
        },
        idempotency_key: randomUUID(),
      }),
    });
    assert.equal(res.statusCode, 200, res.body);
    const actions = res.json().agents.map((item: { action: string }) => item.action);
    assert.deepEqual(actions, ['update'], res.body);
  };
  // A rename through the manifest: the listing shows the new name and is found by it.
  await apply({ ...manifest, metadata: { ...manifest.metadata, displayName: 'Bob Bot' } });
  assert.deepEqual(await stored(), [['Bob Bot', false]]);
  // Private through the manifest: no name on the listing, and the old one finds nothing.
  await apply({
    ...manifest,
    metadata: { ...manifest.metadata, displayName: 'Bob Bot' },
    spec: { ...manifest.spec, visibility: 'private' },
  });
  assert.deepEqual(await stored(), [[null, false]]);
  assert.deepEqual(
    (await searchFeedServices(f.db, { ...LIST, q: 'bob' }, { limit: 100, now: f.now() })).services,
    [],
  );
});

// ---------------------------------------------------------------------------------------------
// The Bazaar sweep never takes a Central City row

test('the sweep never overwrites or withdraws a Central City row; a Bazaar copy of a paused offer stays excluded', async (t) => {
  const f = await fixture(t, { agents: 1 });
  const [agent] = f.agents;
  const published = await f.publish([
    offer(agent, 'listed'),
    offer(agent, 'held', { state: 'paused' }),
  ]);
  const [listedId, heldId] = published.offers.map((item) => item.offerId);
  const urlOf = (offerId: string) => offerListingUrl(ORIGIN, offerId);
  const bazaarRecord = (resource: string) => ({
    resource,
    type: 'http',
    x402Version: 2,
    serviceName: 'A copy',
    description: 'The same resource as the Bazaar lists it.',
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: FEED_USDC.address,
        amount: '10000',
        payTo: `0x${'2'.repeat(40)}`,
      },
    ],
  });
  const rowsBefore = await f.sql(
    `SELECT id, source, record_id, pay_to, withdrawn_at, missed_sweeps FROM feed_services ORDER BY id`,
  );
  const sweep = async (hostedHost: string | null) => {
    f.advance(7 * HOUR);
    return runFeedSync({
      db: f.db,
      now: f.now,
      hostedHost,
      fetchPage: async () => ({
        items: [
          bazaarRecord(urlOf(heldId)),
          bazaarRecord(urlOf(listedId)),
          bazaarRecord('https://api.other-provider.com/v1/run'),
        ],
        total: 3,
      }),
    });
  };
  // With the host configured: both copies are 'hosted_here' exclusions, never rows.
  const run = await sweep(HOST);
  assert.equal(run.outcome, 'complete');
  assert.deepEqual(
    await f.sql(`SELECT record_id, reason FROM feed_exclusions ORDER BY record_id`),
    [
      {
        record_id: urlOf(heldId) < urlOf(listedId) ? urlOf(heldId) : urlOf(listedId),
        reason: 'hosted_here',
      },
      {
        record_id: urlOf(heldId) < urlOf(listedId) ? urlOf(listedId) : urlOf(heldId),
        reason: 'hosted_here',
      },
    ],
  );
  // Without it (the source guard alone): the copies are kept as duplicates, the rows stay ours.
  await sweep(null);
  assert.deepEqual(
    (await f.sql<{ reason: string }>(`SELECT reason FROM feed_exclusions ORDER BY record_id`)).map(
      (row) => row.reason,
    ),
    ['duplicate', 'duplicate'],
  );
  // Two complete sweeps that never listed the Central City rows: neither withdrawn nor taken.
  assert.deepEqual(
    await f.sql(
      `SELECT id, source, record_id, pay_to, withdrawn_at, missed_sweeps FROM feed_services
       WHERE source = 'Central City' ORDER BY id`,
    ),
    rowsBefore,
  );
  const titles = (await f.list()).services.map((service) => service.title).sort();
  assert.deepEqual(titles, ['A copy', 'Text hash listed']);
  assert.equal(
    (
      await f.sql<{ withdrawn: boolean }>(
        `SELECT withdrawn_at IS NOT NULL AS withdrawn FROM feed_services WHERE record_id = $1`,
        [`cc:${heldId}`],
      )
    )[0].withdrawn,
    true,
  );
});

// ---------------------------------------------------------------------------------------------
// Use counts (server/feed/offers/uses.ts)

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
let callSeq = 0;
const OTHER_URL = 'https://api.other-provider.com/v1/run';

/** A Feed pay call stored as the engine leaves it; settled unless paymentState says otherwise. */
async function payCall(
  sql: <T>(text: string, params?: unknown[]) => Promise<T[]>,
  options: {
    serviceId: string;
    offerId: string | null;
    payer: Agent;
    settledAt: number;
    chainId?: number;
    paymentState?: string;
  },
) {
  const n = callSeq++;
  const callId = `fc_${'q'.repeat(18)}${BASE32[Math.floor(n / 32) % 32]}${BASE32[n % 32]}`;
  const hex = (salt: string) => createHash('sha256').update(`${callId}:${salt}`).digest('hex');
  const settled = (options.paymentState ?? 'settled') === 'settled';
  await sql(
    `INSERT INTO feed_pay_calls (call_id, origin, scope, idempotency_key, request_hash, caller_id,
       actor, owner_account_id, operator_id, agent_id, agent_name, wallet_id, chain_id, service_id,
       service_title, host, method, request_url, max_amount_raw, permission_id, payment_id,
       amount_raw, pay_to, x402_version, requirements, validity_s, state, payment_state, tx_hash,
       settled_block, settled_at, pay_kind, offer_id, created_at, updated_at)
     VALUES ($1, 'feed', 'feed:buyer', $2, $3, 'buyer', 'person', 'buyer', 'buyer', $4, 'Buyer',
       $5, $6, $7, 'A service', $8, 'POST', 'https://city.example.com/run', 50000, 'perm-1', $9,
       45000, $10, 2, '{}', 60, $11, $12, $13, $14, $15, $16, $17, $15, $15)`,
    [
      callId,
      hex('idem'),
      hex('request'),
      options.payer.id,
      `wallet-${options.payer.id}`,
      options.chainId ?? 8453,
      options.serviceId,
      HOST,
      `pay-${callId}`,
      `0x${'4'.repeat(40)}`,
      settled ? 'result_saved' : 'calling',
      options.paymentState ?? 'settled',
      settled ? `0x${hex('tx')}` : null,
      settled ? 1 : null,
      options.settledAt,
      options.offerId ? 'included' : 'x402',
      options.offerId,
    ],
  );
}

test('use counts: settled Base mainnet calls of the last 30 days, by distinct paying wallets; Bazaar rows untouched', async (t) => {
  const f = await fixture(t, { agents: 2 });
  const [seller, other] = f.agents;
  const published = await f.publish([offer(seller, 'used'), offer(seller, 'unused')]);
  const [usedOffer, unusedOffer] = published.offers.map((item) => item.offerId);
  const serviceOf = (offerId: string) => feedServiceId(offerListingUrl(ORIGIN, offerId));
  const used = serviceOf(usedOffer);
  const unused = serviceOf(unusedOffer);
  const bazaar = feedServiceId(OTHER_URL);
  // A Bazaar row with its own counts, which the refresh never writes.
  await f.sql(
    `INSERT INTO feed_services (id, source, record_id, host, url, title, x402_version, scheme,
       pay_to, paid_calls_30d, payers_30d, last_called_at, fetched_at, first_seen_at,
       last_seen_at, last_seen_sweep, search_text)
     VALUES ($1, $2, $3, 'api.other-provider.com', $3, 'Other', 2, 'exact', $4, 77, 9, $5, $5,
       $5, $5, 1, 'other')`,
    [bazaar, BAZAAR_SOURCE, OTHER_URL, `0x${'2'.repeat(40)}`, NOW - HOUR],
  );
  const usage = async () =>
    Object.fromEntries(
      (
        await f.sql<{
          id: string;
          paid_calls_30d: number | null;
          payers_30d: number | null;
          last_called_at: string | number | null;
        }>(`SELECT id, paid_calls_30d, payers_30d, last_called_at FROM feed_services`)
      ).map((row) => [
        row.id,
        [
          row.paid_calls_30d,
          row.payers_30d,
          row.last_called_at === null ? null : Number(row.last_called_at),
        ],
      ]),
    );
  // A new listing starts at 0 with no call: the card says "New", never "Not reported".
  assert.deepEqual(await usage(), {
    [used]: [0, 0, null],
    [unused]: [0, 0, null],
    [bazaar]: [77, 9, NOW - HOUR],
  });
  const hostedUsage = async () =>
    (await f.list()).services
      .filter((service) => service.source.name === 'Central City')
      .map((service) => [service.id, service.usage]);
  for (const [, item] of await hostedUsage())
    assert.deepEqual(item, {
      paidCalls30d: 0,
      payers30d: 0,
      lastCalledAt: null,
      reportedBy: 'Central City',
    });

  // Counted: three settled calls by two wallets. Not counted: older than 30 days, not settled,
  // another chain, an x402 call (no offer) to the same id.
  const call = (
    payer: Agent,
    settledAt: number,
    extra: { chainId?: number; paymentState?: string } = {},
  ) => payCall(f.sql, { serviceId: used, offerId: usedOffer, payer, settledAt, ...extra });
  await call(seller, NOW - 2 * HOUR);
  await call(other, NOW - HOUR);
  await call(other, NOW - 3 * HOUR);
  await call(other, NOW - 31 * 24 * HOUR);
  await call(seller, NOW - 30 * 60_000, { paymentState: 'sent' });
  await call(seller, NOW - 20 * 60_000, { chainId: 84532 });
  await payCall(f.sql, {
    serviceId: used,
    offerId: null,
    payer: seller,
    settledAt: NOW - 10 * 60_000,
  });

  const version = await f.hostedVersion();
  assert.equal(await refreshHostedUses(f.db, NOW), 1);
  assert.equal(await f.hostedVersion(), version + 1, 'the cached order and cursors follow');
  assert.deepEqual(await usage(), {
    [used]: [3, 2, NOW - HOUR],
    [unused]: [0, 0, null],
    [bazaar]: [77, 9, NOW - HOUR],
  });
  assert.deepEqual(Object.fromEntries(await hostedUsage())[used], {
    paidCalls30d: 3,
    payers30d: 2,
    lastCalledAt: NOW - HOUR,
    reportedBy: 'Central City',
  });
  // Nothing changed since: no write, no version move.
  assert.equal(await refreshHostedUses(f.db, NOW), 0);
  assert.equal(await f.hostedVersion(), version + 1);

  // A re-publish (a new title) keeps the counts.
  f.advance(HOUR);
  const changed = await f.publish([offer(seller, 'used', { title: 'Text hash renamed' })]);
  assert.equal(changed.writes, 1);
  assert.equal(
    (await f.sql<{ title: string }>('SELECT title FROM feed_services WHERE id = $1', [used]))[0]
      .title,
    'Text hash renamed',
  );
  assert.deepEqual((await usage())[used], [3, 2, NOW - HOUR]);
  // The counts grow with each refresh.
  await call(seller, f.now() - 60_000);
  assert.equal(await refreshHostedUses(f.db, f.now()), 1);
  assert.deepEqual((await usage())[used], [4, 2, f.now() - 60_000]);

  // 30 days on: no call in the window, the last call kept ("No recent uses", not "New").
  const last = f.now() - 60_000;
  f.advance(31 * 24 * HOUR);
  assert.equal(await refreshHostedUses(f.db, f.now()), 1);
  assert.deepEqual(await usage(), {
    [used]: [0, 0, last],
    [unused]: [0, 0, null],
    [bazaar]: [77, 9, NOW - HOUR],
  });
});

test('use counts: the 30 days are read through the partial index of migration 127', async (t) => {
  const f = await fixture(t, { agents: 1 });
  assert.equal(feedPayIncludedSettledMigration.version, 127);
  const [index] = await f.sql<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE indexname = 'feed_pay_calls_included_settled'`,
  );
  assert.match(index.indexdef, /\(settled_at\) INCLUDE \(service_id, wallet_id, chain_id\)/);
  assert.match(index.indexdef, /pay_kind = 'included'.*payment_state = 'settled'/);
  const plan = await f.db.transaction(async (tx) => {
    await tx.query('SET LOCAL enable_seqscan = off');
    return (
      await tx.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT service_id, count(*), count(DISTINCT wallet_id), max(settled_at)
         FROM feed_pay_calls
         WHERE pay_kind = 'included' AND payment_state = 'settled' AND settled_at > $1
           AND chain_id = $2
         GROUP BY service_id`,
        [NOW - HOUR, 8453],
      )
    ).rows
      .map((row) => row['QUERY PLAN'])
      .join('\n');
  });
  assert.match(plan, /feed_pay_calls_included_settled/);
});

// ---------------------------------------------------------------------------------------------
// Presets

test('presets: checked against the kind, stored, listed as fixed settings, changed and cleared', async (t) => {
  const f = await fixture(t, { agents: 1 });
  const [agent] = f.agents;
  const convert = (key: string, preset: unknown) =>
    offer(agent, key, {
      kind: 'unit-convert',
      title: `Km to miles ${key}`,
      preset: preset as OfferInput['preset'],
    });
  // Refused at plan time, each with a sentence saying what is wrong.
  const refusals = async (preset: unknown) =>
    (await f.store.planOffers(f.ownerId, [convert('bad', preset)])).refusals.map((entry) => [
      entry.reason,
      entry.message,
    ]);
  assert.deepEqual(await refusals({ algorithm: 'sha256' }), [
    ['invalid_preset', 'preset may only fix value, from, to.'],
  ]);
  assert.deepEqual(await refusals({ from: 'parsec' }), [
    [
      'invalid_preset',
      `preset from must be one of ${OFFER_KIND_SPECS['unit-convert'].input[1]!.values!.join(', ')}.`,
    ],
  ]);
  assert.deepEqual(await refusals({ value: 'one' }), [
    ['invalid_preset', 'preset value must be a number.'],
  ]);
  assert.deepEqual(await refusals(['km']), [
    ['invalid_preset', 'preset must be a JSON object of input fields.'],
  ]);
  // Valid fields that the kind's own rules refuse together.
  assert.deepEqual(await refusals({ from: 'kg', to: 'mi' }), [
    [
      'invalid_preset',
      'With this preset the service refuses its example input: kg is a unit of mass and mi a unit of length.',
    ],
  ]);
  assert.deepEqual(await refusals({ to: 'x'.repeat(3000) }), [
    [
      'invalid_preset',
      `preset to must be one of ${OFFER_KIND_SPECS['unit-convert'].input[2]!.values!.join(', ')}.`,
    ],
  ]);
  const big = await f.store.planOffers(f.ownerId, [
    offer(agent, 'big', { kind: 'json-query', preset: { path: 'a'.repeat(256) } }),
  ]);
  assert.equal(big.ok, true, JSON.stringify(big.refusals));

  // Accepted: stored in the kind's field order, planned and listed without the fixed fields.
  const plan = await f.store.planOffers(f.ownerId, [convert('km', { to: 'mi', from: 'km' })]);
  assert.equal(plan.ok, true, JSON.stringify(plan.refusals));
  assert.deepEqual(plan.items[0]!.preset, { from: 'km', to: 'mi' });
  const published = await f.store.publishOffers(
    f.ownerId,
    [convert('km', { to: 'mi', from: 'km' })],
    'preset-1',
    plan.hash!,
  );
  const offerId = published.offers[0]!.offerId;
  const [stored] = await f.sql<{ preset: unknown }>(
    'SELECT preset FROM city_offers WHERE offer_id = $1',
    [offerId],
  );
  assert.deepEqual(stored!.preset, { from: 'km', to: 'mi' });
  const [listing] = await f.sql<{
    input: { fields: Array<{ name: string }>; example: string; fixed: unknown };
  }>('SELECT input FROM feed_services WHERE record_id = $1', [`cc:${offerId}`]);
  assert.deepEqual(
    listing!.input.fields.map((field) => field.name),
    ['value'],
  );
  assert.equal(listing!.input.example, '{"value":1}');
  assert.deepEqual(listing!.input.fixed, [
    { name: 'from', value: 'km' },
    { name: 'to', value: 'mi' },
  ]);
  const shown = (await f.list()).services.find((service) => service.url.endsWith(offerId))!;
  assert.deepEqual(shown.input, offerInputSummary('unit-convert', { from: 'km', to: 'mi' }));
  const mine = await f.store.listOffers(f.ownerId);
  assert.deepEqual(mine.offers.find((item) => item.offerId === offerId)!.preset, {
    from: 'km',
    to: 'mi',
  });

  // The same preset again changes nothing; another one is an update (a new version).
  const again = await f.publish([convert('km', { from: 'km', to: 'mi' })]);
  assert.equal(again.offers[0]!.action, 'unchanged');
  const changed = await f.store.changeOffers(
    f.ownerId,
    [{ offerId, preset: { from: 'km', to: 'ft' } }],
    'preset-change-1',
  );
  assert.equal(changed.offers[0]!.action, 'update');
  assert.equal(changed.offers[0]!.version, 2);
  const cleared = await f.store.changeOffers(
    f.ownerId,
    [{ offerId, preset: null }],
    'preset-clear-1',
  );
  assert.equal(cleared.offers[0]!.version, 3);
  const [after] = await f.sql<{ preset: unknown; input: { fields: unknown[]; fixed?: unknown } }>(
    `SELECT o.preset, s.input FROM city_offers o JOIN feed_services s ON s.record_id = 'cc:' || o.offer_id
     WHERE o.offer_id = $1`,
    [offerId],
  );
  assert.equal(after!.preset, null);
  assert.equal(after!.input.fields.length, 3);
  assert.equal(after!.input.fixed, undefined);
  await assert.rejects(
    f.store.changeOffers(
      f.ownerId,
      [{ offerId, preset: { from: 'lightyear' } as never }],
      'preset-bad-1',
    ),
    (error: unknown) =>
      (error as { refusals?: Array<{ reason: string }> }).refusals?.[0]?.reason ===
      'invalid_preset',
  );
});

test('presets: a plan without one hashes as before; merge rules; migration 231 adds one nullable column', async (t) => {
  // The plan hash of an offer without a preset does not depend on the feature.
  const f = await fixture(t, { agents: 1 });
  const plain = await f.store.planOffers(f.ownerId, [offer(f.agents[0], 'h')]);
  const nulled = await f.store.planOffers(f.ownerId, [offer(f.agents[0], 'h', { preset: null })]);
  const empty = await f.store.planOffers(f.ownerId, [offer(f.agents[0], 'h', { preset: {} })]);
  assert.equal(plain.hash, nulled.hash);
  assert.equal(plain.hash, empty.hash);
  assert.equal(plain.items[0]!.preset, null);
  // Merging: preset values win, an equal buyer value is fine, another one is refused.
  assert.deepEqual(mergeOfferPreset({ to: 'mi' }, { value: 2 }), {
    ok: true,
    value: { value: 2, to: 'mi' },
  });
  assert.deepEqual(mergeOfferPreset({ to: 'mi' }, { value: 2, to: 'mi' }), {
    ok: true,
    value: { value: 2, to: 'mi' },
  });
  assert.deepEqual(mergeOfferPreset({ to: 'mi' }, { value: 2, to: 'km' }), {
    ok: false,
    reason: 'to is fixed by this service to "mi": leave it out.',
  });
  assert.deepEqual(mergeOfferPreset(null, 'x'), { ok: true, value: 'x' });
  assert.deepEqual(mergeOfferPreset({ to: 'mi' }, [1]), { ok: true, value: [1] });
  assert.deepEqual(checkOfferPreset('base-gas', { a: 1 }), {
    ok: false,
    reason: 'This kind has no input fields to fix.',
  });
  // The migration: one nullable jsonb column, an object when set.
  assert.equal(feedOfferPresetsMigration.version, 231);
  assert.match(
    FEED_OFFER_PRESETS_SQL,
    /ALTER TABLE city_offers ADD COLUMN IF NOT EXISTS preset jsonb/,
  );
  assert.doesNotMatch(FEED_OFFER_PRESETS_SQL, /feed_pay|DEFAULT/);
  const [column] = await f.sql<{ is_nullable: string; data_type: string }>(
    `SELECT is_nullable, data_type FROM information_schema.columns
     WHERE table_name = 'city_offers' AND column_name = 'preset'`,
  );
  assert.deepEqual(column, { is_nullable: 'YES', data_type: 'jsonb' });
  await assert.rejects(
    f.sql(
      `INSERT INTO city_offers (offer_id, operator_id, agent_id, wallet_id, pay_to, kind, title,
         price_raw, idem_key, price_changed_at, created_at, updated_at, preset)
       VALUES ('off_aaaaaaaaaaaaaaaa', $1, 'a', 'w', $2, 'hash', 't', 50000, 'k', 1, 1, 1, '[1]')`,
      [f.ownerId, f.agents[0].wallet],
    ),
  );
});
