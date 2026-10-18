import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ASSISTANT_TOOL_SCOPES } from '../server/assistant-access.js';
import { createApp } from '../server/app.js';
import { agentWalletRecipe, deriveAddressLocal } from '../server/base/chain/derive.js';
import { accountIndexFor } from '../server/base/wallet/service.js';
import { feedServiceId } from '../server/feed/bazaar.js';
import {
  OFFER_CAPS_DEFAULT,
  offerListingUrl,
  type OfferCaps,
} from '../server/feed/offers/store.js';
import {
  FEED_OFFER_TOOLS,
  feedOfferToolAnnotations,
  feedOfferToolDescriptions,
  OFFER_FEE_SENTENCE,
} from '../server/feed/offers/tools.js';
import { feedToolDescriptions } from '../server/feed/tools.js';
import { feedPayToolDescriptions } from '../server/feed/pay/tool.js';
import { BAZAAR_SOURCE, HOSTED_SOURCE } from '../server/feed/types.js';
import { consentPage, SCOPE_TEXT } from '../server/oauth/pages.js';
import { INITIAL_KEY_SCOPES } from '../server/workspaces/service.js';
import { WALLET_CHAIN_ID, WALLET_NETWORK } from '../shared/base/wallet-network.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { FEED_LIMITS, FEED_TOOL_NOTICE } from '../shared/feed.js';
import { FEED_TOOL_NOTICE_WITH_PAY } from '../shared/feed-pay.js';
import { OFFER_LIMITS, offerPriceSplit, TOOL_BODY_MAX_BYTES } from '../shared/feed-offers.js';
import { fixture as oauthFixture, fullFlow, mcpCall, rpcResult } from './oauth-helpers.js';

/*
 * The services:sell tools (server/feed/offers/tools.ts): plan, publish, update, pause and list the
 * services an owner's agents sell in the Feed, through the REST tool transport and remote MCP.
 * createApp on PGlite with synthetic owners, agents and wallet rows (built as the wallet service
 * derives them); nothing reaches a network and no money moves. Made-up, low-entropy data only.
 */

const NOW = Date.parse('2026-10-15T08:00:00Z');
const HOUR = 3_600_000;
const ORIGIN = 'https://city.example.com';
const json = { 'content-type': 'application/json', 'x-city-request': '1' };
const SPENDER = getAddress(`0x${'5c'.repeat(20)}`);
let address = 60;

async function fixture(
  t: { after: (fn: () => unknown) => void },
  options: {
    agents?: number;
    caps?: Partial<OfferCaps>;
    wallets?: boolean;
    scopes?: string[];
  } = {},
) {
  let clockMs = NOW;
  const clock = () => clockMs;
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    now: clock,
    offers: { origin: ORIGIN, caps: { ...OFFER_CAPS_DEFAULT, ...options.caps } },
  });
  t.after(() => app.close());
  const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    app.city.db.query<T>(text, params).then((res) => res.rows);
  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: json,
    payload: JSON.stringify({
      name: `Seller owner ${address}`,
      password: 'Synthetic seller owner pw',
    }),
    remoteAddress: `198.51.100.${address++}`,
  });
  assert.equal(register.statusCode, 201, register.body);
  const ownerId = register.json().operator.id as string;
  const cookie = `cc_session=${register.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
  const grant = async (scopes: string[]) => {
    const granted = await app.inject({
      method: 'POST',
      url: '/api/assistant-access',
      headers: { ...json, cookie },
      payload: JSON.stringify({ label: 'Synthetic seller client', scopes, expiresInDays: 1 }),
    });
    assert.equal(granted.statusCode, 201, granted.body);
    return granted.json().token as string;
  };
  const creator = await grant(['workspace:read', 'agents:create']);
  const token = await grant(options.scopes ?? ['workspace:read', 'services:sell']);

  const ownerKey = privateKeyToAccount(generatePrivateKey());
  await sql(
    `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key, kdf_params,
       cipher_params, version, backup_confirmed_at, created_at, updated_at)
     VALUES ($1, $2, decode($3, 'hex'), '{}', '{}', 1, 1, 1, 1)`,
    [ownerId, ownerKey.address, '5a'.repeat(48)],
  );
  const agents: Array<{ id: string; wallet: string }> = [];
  for (let i = 0; i < (options.agents ?? 2); i++) {
    const created = await app.inject({
      method: 'POST',
      url: '/api/assistant/tools/city_create_agent',
      headers: { ...json, authorization: `Bearer ${creator}` },
      payload: JSON.stringify({
        name: `vendor${i}`,
        description: 'Synthetic agent',
        capability: 'research',
        mode: 'external',
        idempotencyKey: randomUUID(),
      }),
    });
    assert.equal(created.statusCode, 200, created.body);
    const id = created.json().agent.id as string;
    const recipe = agentWalletRecipe(WALLET_NETWORK, ownerKey.address, accountIndexFor(id));
    const wallet = getAddress(deriveAddressLocal(recipe));
    if (options.wallets !== false)
      await sql(
        `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address,
           owner_address, spender_address, spender_key_ref, derivation, state, created_at,
           updated_at, owner_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'v1:00000000-0000-4000-8000-000000000002', $8,
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
  // The Bazaar's last complete sweep: the Feed answers searches from then on.
  await sql(
    `INSERT INTO feed_sources (name, sweep_id, last_attempt_at, last_success_at, last_total)
     VALUES ($1, 1, $2, $2, 1)
     ON CONFLICT (name) DO UPDATE SET sweep_id = 1, sweep_offset = 0, last_attempt_at = $2,
       last_success_at = $2, last_total = 1`,
    [BAZAAR_SOURCE, NOW],
  );
  const call = (tool: string, body: unknown, bearer = token) =>
    app.inject({
      method: 'POST',
      url: `/api/assistant/tools/${tool}`,
      headers: { ...json, authorization: `Bearer ${bearer}` },
      payload: JSON.stringify(body),
    });
  const counts = async () =>
    (
      await sql<{ offers: number; rows: number; batches: number; version: string }>(
        `SELECT (SELECT count(*) FROM city_offers)::int AS offers,
           (SELECT count(*) FROM feed_services WHERE source = $1)::int AS rows,
           (SELECT count(*) FROM city_offer_batches)::int AS batches,
           (SELECT data_version::text FROM feed_sources WHERE name = $1) AS version`,
        [HOSTED_SOURCE],
      )
    )[0];
  const ownerRoute = (path: string, body: unknown = {}) =>
    app.inject({
      method: 'POST',
      url: path,
      headers: { ...json, cookie },
      payload: JSON.stringify(body),
    });
  return {
    app,
    sql,
    ownerId,
    agents,
    token,
    grant,
    call,
    counts,
    ownerRoute,
    advance: (ms: number) => void (clockMs += ms),
  };
}

const offer = (
  agentId: string,
  key: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> => ({
  key,
  agent_id: agentId,
  kind: 'hash',
  title: `Text hash ${key}`,
  description: 'The SHA-256 of a short text.',
  tags: ['hash', 'text'],
  price_usdc: '0.05',
  ...fields,
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Plans, checks the plan is ok, then publishes it with its hash. */
async function planAndPublish(f: Fixture, offers: unknown[], key = `pub-${randomUUID()}`) {
  const plan = await f.call('city_service_plan', { offers });
  assert.equal(plan.statusCode, 200, plan.body);
  assert.equal(plan.json().ok, true, plan.body);
  const published = await f.call('city_service_publish', {
    offers,
    idempotency_key: key,
    expected_hash: plan.json().hash,
  });
  assert.equal(published.statusCode, 200, published.body);
  return published.json();
}

// ---------------------------------------------------------------------------------------------
// The scope

test('services:sell is its own opt-in scope: never a default, never in a first key, plain text next to services:pay', () => {
  const at = ASSISTANT_SCOPES.indexOf('services:sell');
  assert.equal(ASSISTANT_SCOPES[at - 1], 'services:pay', 'listed right after services:pay');
  assert.ok(!INITIAL_KEY_SCOPES.includes('services:sell'), "never in an AI workspace's first key");
  assert.match(SCOPE_TEXT['services:sell'], /services your agents sell in the Feed/);
  assert.match(SCOPE_TEXT['services:sell'], /the seller receives 90% of the price and 10% goes/);
  const page = consentPage({
    requestId: 'r',
    csrf: 'c',
    clientName: 'Synthetic client',
    clientId: 'https://client.example/meta.json',
    verified: true,
    redirectUri: 'https://client.example/cb',
    scopes: ['workspace:read', 'services:pay', 'services:sell'],
    operatorName: 'Synthetic owner',
  });
  // Unchecked until the owner ticks it, and shown after services:pay.
  assert.match(page, /name="scope" value="services:sell">/);
  assert.ok(page.indexOf('value="services:pay"') < page.indexOf('value="services:sell"'));
  for (const tool of FEED_OFFER_TOOLS) assert.equal(ASSISTANT_TOOL_SCOPES[tool], 'services:sell');
});

test('the scope is required: without services:sell every tool is refused and nothing is written', async (t) => {
  const f = await fixture(t, { scopes: ['workspace:read', 'services:pay'] });
  const before = await f.counts();
  for (const tool of FEED_OFFER_TOOLS) {
    const res = await f.call(tool, tool === 'city_service_mine' ? {} : { offers: [] });
    assert.equal(res.statusCode, 403, `${tool}: ${res.body}`);
  }
  assert.deepEqual(await f.counts(), before);
});

test('remote MCP: the tools are listed only to a grant with services:sell, with their annotations and the fee sentence; never on /mcp/open', async (t) => {
  const { app } = await oauthFixture(t);
  const names = async (token: string | undefined, url = '/mcp') => {
    const res =
      url === '/mcp'
        ? await mcpCall(app, token, 'tools/list')
        : await app.inject({
            method: 'POST',
            url,
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
          });
    assert.equal(res.statusCode, 200, res.body);
    return rpcResult(res.body).result.tools as Array<{
      name: string;
      description: string;
      annotations: Record<string, unknown>;
      securitySchemes?: unknown;
    }>;
  };
  const without = (
    await fullFlow(app, { scope: 'workspace:read services:pay', scopes: ['services:pay'] })
  ).tokens.access_token;
  const listedWithout = await names(without);
  for (const tool of FEED_OFFER_TOOLS)
    assert.ok(!listedWithout.some((item) => item.name === tool), tool);
  // Called anyway: the insufficient_scope step-up names services:sell and its plain label.
  const refused = await mcpCall(app, without, 'tools/call', {
    name: 'city_service_mine',
    arguments: {},
  });
  assert.equal(refused.statusCode, 403, refused.body);
  const challenge = String(refused.headers['www-authenticate']);
  assert.match(challenge, /error="insufficient_scope"/);
  assert.match(challenge, /scope="workspace:read services:sell"/);
  assert.match(challenge, /Sell services in the Feed \(services:sell\)/);

  const seller = (
    await fullFlow(app, { scope: 'workspace:read services:sell', scopes: ['services:sell'] })
  ).tokens.access_token;
  const listed = await names(seller);
  for (const tool of FEED_OFFER_TOOLS) {
    const entry = listed.find((item) => item.name === tool);
    assert.ok(entry, tool);
    const { title, ...hints } = entry.annotations;
    assert.equal(title, feedOfferToolDescriptions[tool].title);
    assert.deepEqual(hints, feedOfferToolAnnotations[tool]);
    assert.deepEqual(entry.securitySchemes, [
      { type: 'oauth2', scopes: ['workspace:read', 'services:sell'] },
    ]);
  }
  for (const tool of ['city_service_plan', 'city_service_publish'] as const)
    assert.ok(feedOfferToolDescriptions[tool].description.includes(OFFER_FEE_SENTENCE), tool);
  assert.match(OFFER_FEE_SENTENCE, /the seller receives 90% and 10% goes to the protocol/);
  // The plan over MCP: an agent with no ready wallet is refused with its reason, nothing written.
  const plan = rpcResult(
    (
      await mcpCall(app, seller, 'tools/call', {
        name: 'city_service_plan',
        arguments: { offers: [offer('agent-unknown', 'k1')] },
      })
    ).body,
  ).result;
  assert.equal(plan.isError, undefined, JSON.stringify(plan));
  assert.equal(plan.structuredContent.ok, false);
  assert.equal(plan.structuredContent.refusals[0].reason, 'agent_not_found');
  assert.equal(plan.structuredContent.fee, OFFER_FEE_SENTENCE);
  // Never on the no-account endpoint.
  const open = await names(undefined, '/mcp/open');
  for (const tool of FEED_OFFER_TOOLS) assert.ok(!open.some((item) => item.name === tool), tool);
});

test('switched off with the Feed (CITY_FEED=0), every tool answers 404', async (t) => {
  const before = process.env.CITY_FEED;
  process.env.CITY_FEED = '0';
  t.after(() => {
    if (before === undefined) delete process.env.CITY_FEED;
    else process.env.CITY_FEED = before;
  });
  const f = await fixture(t);
  for (const tool of FEED_OFFER_TOOLS) assert.equal((await f.call(tool, {})).statusCode, 404, tool);
});

// ---------------------------------------------------------------------------------------------
// Plan and publish

test('a dry run writes nothing, and its hash is stable for the same offers', async (t) => {
  const f = await fixture(t);
  const before = await f.counts();
  const offers = [offer(f.agents[0]!.id, 'a'), offer(f.agents[1]!.id, 'b', { price_usdc: '0.09' })];
  const first = await f.call('city_service_plan', { offers });
  assert.equal(first.statusCode, 200, first.body);
  const plan = first.json();
  assert.equal(plan.ok, true, first.body);
  assert.match(plan.hash, /^[0-9a-f]{64}$/);
  assert.equal(plan.writes, 2);
  assert.deepEqual(
    plan.offers.map((item: Record<string, unknown>) => [
      item.action,
      item.price_usdc,
      item.seller_receives_usdc,
      item.protocol_fee_usdc,
      item.listed,
      item.pay_to,
    ]),
    [
      ['create', '0.05', '0.045', '0.005', true, f.agents[0]!.wallet],
      ['create', '0.09', '0.081', '0.009', true, f.agents[1]!.wallet],
    ],
  );
  // The same offers with their fields in another order: the same hash.
  const reordered = offers.map((item) => Object.fromEntries(Object.entries(item).reverse()));
  assert.equal((await f.call('city_service_plan', { offers: reordered })).json().hash, plan.hash);
  assert.deepEqual(await f.counts(), before, 'the dry run wrote nothing');
});

test('publish refuses a changed plan and writes nothing; then the new plan publishes and lists at once', async (t) => {
  const f = await fixture(t);
  const offers = [offer(f.agents[0]!.id, 'a')];
  const plan = (await f.call('city_service_plan', { offers })).json();
  const before = await f.counts();
  // Other offers than the plan's.
  const changed = await f.call('city_service_publish', {
    offers: [offer(f.agents[0]!.id, 'a', { title: 'Another title' })],
    idempotency_key: 'publish-changed-1',
    expected_hash: plan.hash,
  });
  assert.equal(changed.statusCode, 409, changed.body);
  assert.equal(changed.json().code, 'plan_changed');
  // The workspace changed since the plan: the agent was paused (an active offer cannot list).
  assert.equal((await f.ownerRoute(`/api/agents/${f.agents[0]!.id}/pause`)).statusCode, 200);
  const paused = await f.call('city_service_publish', {
    offers,
    idempotency_key: 'publish-changed-2',
    expected_hash: plan.hash,
  });
  assert.equal(paused.statusCode, 400, paused.body);
  assert.equal(paused.json().code, 'plan_refused');
  assert.deepEqual(
    paused.json().issues.map((issue: Record<string, unknown>) => [issue.code, issue.path]),
    [['agent_paused', 'offers.0']],
  );
  assert.deepEqual(await f.counts(), before, 'nothing written');
  assert.equal((await f.ownerRoute(`/api/agents/${f.agents[0]!.id}/resume`)).statusCode, 200);

  const published = await planAndPublish(f, offers);
  assert.equal(published.replay, false);
  assert.equal(published.writes, 1);
  const [one] = published.offers;
  assert.match(one.offer_id, /^off_[a-z2-7]{16}$/);
  assert.equal(one.service_id, feedServiceId(offerListingUrl(ORIGIN, one.offer_id)));
  assert.equal(one.listed, true);
  // Listed in the Feed at once: city_service_search reads it by id.
  const search = await f.call(
    'city_service_search',
    { id: one.service_id },
    await f.grant(['workspace:read']),
  );
  assert.equal(search.statusCode, 200, search.body);
  assert.equal(search.json().services.length, 1);
  assert.equal(search.json().services[0].source.name, HOSTED_SOURCE);
  // Buyers are told Central City listings are fee included.
  for (const text of [
    FEED_TOOL_NOTICE,
    FEED_TOOL_NOTICE_WITH_PAY,
    feedToolDescriptions.city_service_search.description,
  ])
    assert.match(text, /fee included: the buyer pays the listed price, the seller receives 90%/);
  assert.match(feedPayToolDescriptions.city_service_call.description, /are fee included instead/);
});

test('a batch replay changes nothing; the same key with other offers is refused', async (t) => {
  const f = await fixture(t);
  const offers = [offer(f.agents[0]!.id, 'a'), offer(f.agents[1]!.id, 'b')];
  const plan = (await f.call('city_service_plan', { offers })).json();
  const body = { offers, idempotency_key: 'replay-key-0001', expected_hash: plan.hash };
  const first = await f.call('city_service_publish', body);
  assert.equal(first.statusCode, 200, first.body);
  const after = await f.counts();
  const again = await f.call('city_service_publish', body);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().replay, true);
  assert.deepEqual(again.json().offers, first.json().offers);
  assert.deepEqual(await f.counts(), after, 'a replay writes nothing and moves no version');
  const other = await f.call('city_service_publish', {
    ...body,
    offers: [offer(f.agents[0]!.id, 'c')],
  });
  assert.equal(other.statusCode, 409, other.body);
  assert.equal(other.json().code, 'idempotency_key_reused');
  assert.deepEqual(await f.counts(), after);
});

test('bulk: 100 offers in one publish, for any owner, under generic caps', async (t) => {
  const f = await fixture(t, { agents: 2, caps: { activePerAgent: 50 } });
  const offers = Array.from({ length: 100 }, (_, i) =>
    offer(f.agents[i % 2]!.id, `bulk-${i}`, { price_usdc: i % 2 ? '0.1' : '0.05' }),
  );
  const published = await planAndPublish(f, offers);
  assert.equal(published.writes, 100);
  const counts = await f.counts();
  assert.equal(counts.offers, 100);
  assert.equal(counts.rows, 100);
  // 101 is more than one call carries.
  const over = await f.call('city_service_plan', {
    offers: [...offers, offer(f.agents[0]!.id, 'bulk-100')],
  });
  assert.equal(over.statusCode, 400, over.body);
});

/** An offer with every text field at its maximum: title, description, eight full tags. */
const fullOffer = (agentId: string, i: number) =>
  offer(agentId, `full-${String(i).padStart(3, '0')}-${'k'.repeat(55)}`, {
    title: `Full ${String(i).padStart(3, '0')} ${'t'.repeat(FEED_LIMITS.titleMax - 9)}`,
    description: 'Synthetic words '
      .repeat(FEED_LIMITS.descriptionMax / 16)
      .slice(0, FEED_LIMITS.descriptionMax),
    tags: Array.from(
      { length: FEED_LIMITS.tagsMax },
      (_, tag) => `${String.fromCharCode(97 + tag)}${'g'.repeat(FEED_LIMITS.tagMax - 1)}`,
    ),
  });

test('body limit: 100 full-size offers plan and publish (REST and /mcp); every other tool keeps 64 KiB', async (t) => {
  const f = await fixture(t, { agents: 2, caps: { activePerAgent: 50 } });
  const offers = Array.from({ length: OFFER_LIMITS.batchMax }, (_, i) =>
    fullOffer(f.agents[i % 2]!.id, i),
  );
  const bytes = Buffer.byteLength(JSON.stringify({ offers }));
  assert.ok(bytes > TOOL_BODY_MAX_BYTES * 1.5, `the batch is well over 64 KiB (${bytes})`);
  assert.ok(bytes < OFFER_LIMITS.batchBytesMax);
  const published = await planAndPublish(f, offers);
  assert.equal(published.writes, OFFER_LIMITS.batchMax);
  const ids = (published.offers as Array<{ offer_id: string }>).map((o) => o.offer_id);
  const update = await f.call('city_service_update', {
    changes: ids.map((offer_id, i) => ({
      offer_id,
      description: (offers[i]!.description as string).replace('Synthetic', 'Changed  '),
      tags: offers[i]!.tags,
      title: offers[i]!.title,
    })),
    idempotency_key: `upd-${randomUUID()}`,
  });
  assert.equal(update.statusCode, 200, update.body);
  assert.equal(update.json().writes, OFFER_LIMITS.batchMax);
  // Any other tool over 64 KiB: 413 before it runs, whatever it is.
  const padding = 'p'.repeat(TOOL_BODY_MAX_BYTES + 1);
  for (const tool of ['city_service_mine', 'city_service_pause', 'city_service_search']) {
    const res = await f.call(tool, { query: padding });
    assert.equal(res.statusCode, 413, `${tool}: ${res.body}`);
  }
  // Over 1 MiB even for a batch tool: 413.
  const huge = await f.call('city_service_plan', {
    offers,
    pad: 'p'.repeat(OFFER_LIMITS.batchBytesMax),
  });
  assert.equal(huge.statusCode, 413, huge.body);

  // /mcp: the same 100 offers in one tools/call; another tool, or a batch, over 64 KiB is 413.
  const { app } = await oauthFixture(t);
  const seller = (
    await fullFlow(app, { scope: 'workspace:read services:sell', scopes: ['services:sell'] })
  ).tokens.access_token;
  for (const name of ['city_service_plan', 'city_service_publish']) {
    const res = await mcpCall(app, seller, 'tools/call', {
      name,
      arguments:
        name === 'city_service_plan'
          ? { offers }
          : { offers, idempotency_key: `mcp-${randomUUID()}`, expected_hash: '0'.repeat(64) },
    });
    assert.equal(res.statusCode, 200, `${name}: ${res.body.slice(0, 300)}`);
    // Another workspace's agents: refused by the plan, not by the transport.
    const result = rpcResult(res.body).result;
    if (name === 'city_service_plan') assert.equal(result.structuredContent.ok, false);
    else assert.equal(result.isError, true);
  }
  const other = await mcpCall(app, seller, 'tools/call', {
    name: 'city_service_mine',
    arguments: { pad: padding },
  });
  assert.equal(other.statusCode, 413, other.body);
  const listed = await mcpCall(app, seller, 'tools/list', { pad: padding });
  assert.equal(listed.statusCode, 413, listed.body);
  const batch = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${seller}`,
    },
    payload: JSON.stringify([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'city_service_plan', arguments: { offers } },
      },
    ]),
  });
  assert.equal(batch.statusCode, 413, batch.body);
});

test('the caps hold: active offers per agent and per workspace, writes per hour', async (t) => {
  const f = await fixture(t, {
    caps: { activePerAgent: 2, perWorkspace: 3, writesPerWorkspacePerHour: 4 },
  });
  const [a, b] = f.agents;
  const agentCap = (
    await f.call('city_service_plan', {
      offers: [offer(a!.id, 'a1'), offer(a!.id, 'a2'), offer(a!.id, 'a3')],
    })
  ).json();
  assert.equal(agentCap.ok, false);
  assert.deepEqual(
    agentCap.refusals.map((r: Record<string, unknown>) => [r.index, r.reason]),
    [[2, 'agent_offer_cap']],
  );
  await planAndPublish(f, [offer(a!.id, 'a1'), offer(a!.id, 'a2'), offer(b!.id, 'b1')]);
  const workspaceCap = (await f.call('city_service_plan', { offers: [offer(b!.id, 'b2')] })).json();
  assert.deepEqual(
    workspaceCap.refusals.map((r: Record<string, unknown>) => r.reason),
    ['workspace_offer_cap'],
  );
  // 3 writes so far this hour; changing 2 more passes the cap of 4.
  const ids = (await f.call('city_service_mine', {}))
    .json()
    .offers.map((o: Record<string, unknown>) => o.offer_id);
  const rate = await f.call('city_service_update', {
    changes: ids.slice(0, 2).map((id: string) => ({ offer_id: id, title: 'Changed title' })),
    idempotency_key: 'rate-key-0001',
  });
  assert.equal(rate.statusCode, 400, rate.body);
  assert.deepEqual(
    rate.json().issues.map((issue: Record<string, unknown>) => [issue.code, issue.path]),
    [['write_rate', 'changes']],
  );
});

test('a wallet that is not ready is refused with a reason, and nothing is written', async (t) => {
  const f = await fixture(t, { wallets: false });
  const before = await f.counts();
  const plan = (
    await f.call('city_service_plan', { offers: [offer(f.agents[0]!.id, 'a')] })
  ).json();
  assert.equal(plan.ok, false);
  assert.equal(plan.hash, null);
  assert.deepEqual(plan.refusals, [
    {
      index: 0,
      key: 'a',
      reason: 'wallet_not_ready',
      message: "The agent's wallet on Base is not ready to be paid.",
    },
  ]);
  // A price outside the fee router's bounds is named in the tool's own words.
  const price = (
    await f.call('city_service_plan', {
      offers: [offer(f.agents[0]!.id, 'b', { price_usdc: '0.01' })],
    })
  ).json();
  assert.equal(price.refusals[0].reason, 'invalid_price');
  assert.match(price.refusals[0].message, /^price_usdc must be from 0\.05 to 0\.1 USDC/);
  assert.deepEqual(await f.counts(), before);
});

// ---------------------------------------------------------------------------------------------
// Update, pause and the owner's list

test('update, pause, resume and remove by offer id; mine says what the Feed shows and why not', async (t) => {
  const f = await fixture(t);
  const published = await planAndPublish(f, [
    offer(f.agents[0]!.id, 'a'),
    offer(f.agents[1]!.id, 'b'),
  ]);
  const [a, b] = published.offers as Array<{ offer_id: string; service_id: string }>;
  const mine = async (body: Record<string, unknown> = {}) => {
    const res = await f.call('city_service_mine', body);
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  const listed = await mine();
  assert.equal(listed.fee, OFFER_FEE_SENTENCE);
  assert.deepEqual(
    listed.offers.map((o: Record<string, unknown>) => [o.key, o.listed, o.not_listed]).sort(),
    [
      ['a', true, null],
      ['b', true, null],
    ],
  );
  const one = listed.offers.find((o: Record<string, unknown>) => o.key === 'a');
  assert.equal(one.service_id, a!.service_id);
  assert.equal(one.seller_receives_usdc, '0.045');
  assert.equal(one.protocol_fee_usdc, '0.005');

  // Pause one: it leaves the Feed and stays the owner's; a replay changes nothing.
  const pauseBody = { offer_ids: [a!.offer_id], idempotency_key: 'pause-key-0001' };
  const paused = await f.call('city_service_pause', pauseBody);
  assert.equal(paused.statusCode, 200, paused.body);
  assert.deepEqual(
    paused.json().offers.map((o: Record<string, unknown>) => [o.action, o.listed]),
    [['update', false]],
  );
  const counts = await f.counts();
  assert.equal((await f.call('city_service_pause', pauseBody)).json().replay, true);
  assert.deepEqual(await f.counts(), counts);
  const afterPause = await mine({ state: 'paused' });
  assert.deepEqual(
    afterPause.offers.map((o: Record<string, unknown>) => [o.key, o.state, o.not_listed]),
    [['a', 'paused', 'paused']],
  );
  // Held while its agent is paused: listed again only once the agent resumes.
  assert.equal(
    (
      await f.call('city_service_pause', {
        offer_ids: [a!.offer_id],
        resume: true,
        idempotency_key: 'resume-key-0001',
      })
    ).json().offers[0].listed,
    true,
  );
  assert.equal((await f.ownerRoute(`/api/agents/${f.agents[0]!.id}/pause`)).statusCode, 200);
  assert.equal((await mine({ agent_id: f.agents[0]!.id })).offers[0].not_listed, 'held');
  assert.equal((await f.ownerRoute(`/api/agents/${f.agents[0]!.id}/resume`)).statusCode, 200);

  // Update: only the fields given change; the price at most once an hour.
  const updated = await f.call('city_service_update', {
    changes: [{ offer_id: b!.offer_id, title: 'Hash of a text', price_usdc: '0.08' }],
    idempotency_key: 'update-key-0001',
  });
  assert.equal(updated.statusCode, 400, updated.body);
  assert.deepEqual(
    updated.json().issues.map((issue: Record<string, unknown>) => [issue.code, issue.path]),
    [['price_change_too_soon', 'changes.0']],
  );
  f.advance(HOUR + 1);
  const later = await f.call('city_service_update', {
    changes: [{ offer_id: b!.offer_id, title: 'Hash of a text', price_usdc: '0.08' }],
    idempotency_key: 'update-key-0002',
  });
  assert.equal(later.statusCode, 200, later.body);
  assert.equal(later.json().offers[0].version, 2);
  const changed = (await mine()).offers.find((o: Record<string, unknown>) => o.key === 'b');
  assert.deepEqual(
    [changed.title, changed.description, changed.price_usdc, changed.seller_receives_usdc],
    ['Hash of a text', 'The SHA-256 of a short text.', '0.08', '0.072'],
  );

  // An unknown id, or the same offer twice, is refused with its path; nothing changes.
  const before = await f.counts();
  const unknown = await f.call('city_service_update', {
    changes: [
      { offer_id: b!.offer_id, title: 'Again' },
      { offer_id: 'off_aaaaaaaaaaaaaaaa', title: 'Nobody' },
      { offer_id: b!.offer_id, title: 'Twice' },
    ],
    idempotency_key: 'update-key-0003',
  });
  assert.equal(unknown.statusCode, 400, unknown.body);
  assert.deepEqual(
    unknown.json().issues.map((issue: Record<string, unknown>) => [issue.code, issue.path]),
    [
      ['offer_not_found', 'changes.1'],
      ['duplicate_offer', 'changes.2'],
    ],
  );
  assert.deepEqual(await f.counts(), before);

  // Remove: final; it leaves the default list and shows only when asked for by state.
  const removed = await f.call('city_service_update', {
    changes: [{ offer_id: b!.offer_id, state: 'removed' }],
    idempotency_key: 'remove-key-0001',
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(
    (await mine()).offers.map((o: Record<string, unknown>) => o.key),
    ['a'],
  );
  assert.deepEqual(
    (await mine({ state: 'removed' })).offers.map((o: Record<string, unknown>) => [
      o.key,
      o.not_listed,
    ]),
    [['b', 'removed']],
  );
  // A removed offer is out for good: pausing it changes nothing, resuming it is not found.
  const gone = await f.call('city_service_pause', {
    offer_ids: [b!.offer_id],
    idempotency_key: 'pause-key-0002',
  });
  assert.equal(gone.statusCode, 200, gone.body);
  assert.equal(gone.json().writes, 0);
  assert.equal(gone.json().offers[0].action, 'unchanged');
  const back = await f.call('city_service_pause', {
    offer_ids: [b!.offer_id],
    resume: true,
    idempotency_key: 'pause-key-0003',
  });
  assert.equal(back.json().issues[0].code, 'offer_not_found');
});

test('pausing a removed offer (its agent revoked) is a no-op success; other changes to it are refused', async (t) => {
  const f = await fixture(t);
  const published = await planAndPublish(f, [
    offer(f.agents[0]!.id, 'gone-a'),
    offer(f.agents[0]!.id, 'gone-b'),
    offer(f.agents[1]!.id, 'kept'),
  ]);
  const [a, b, kept] = published.offers as Array<{ offer_id: string }>;
  const revoked = await f.ownerRoute(`/api/agents/${f.agents[0]!.id}/revoke`);
  assert.equal(revoked.statusCode, 200, revoked.body);
  const state = async (id: string) =>
    (await f.sql<{ state: string }>('SELECT state FROM city_offers WHERE offer_id = $1', [id]))[0]!
      .state;
  // Revoking removed the agent's offers for good and withdrew their listings.
  assert.equal(await state(a!.offer_id), 'removed');
  const before = await f.counts();

  const pauseKey = `pause-${randomUUID()}`;
  const paused = await f.call('city_service_pause', {
    offer_ids: [a!.offer_id],
    idempotency_key: pauseKey,
  });
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(paused.json().writes, 0);
  assert.deepEqual(
    paused.json().offers.map((o: Record<string, unknown>) => [o.offer_id, o.action, o.listed]),
    [[a!.offer_id, 'unchanged', false]],
  );
  assert.equal(await state(a!.offer_id), 'removed', 'never brought back as paused');
  const replay = await f.call('city_service_pause', {
    offer_ids: [a!.offer_id],
    idempotency_key: pauseKey,
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().replay, true);
  // Mixed with a live offer: the answer keeps the request's order; only the live one is written.
  const mixed = await f.call('city_service_pause', {
    offer_ids: [b!.offer_id, kept!.offer_id, a!.offer_id],
    idempotency_key: `pause-${randomUUID()}`,
  });
  assert.equal(mixed.statusCode, 200, mixed.body);
  assert.equal(mixed.json().writes, 1);
  assert.deepEqual(
    mixed.json().offers.map((o: Record<string, unknown>) => [o.offer_id, o.action]),
    [
      [b!.offer_id, 'unchanged'],
      [kept!.offer_id, 'update'],
      [a!.offer_id, 'unchanged'],
    ],
  );
  assert.equal(await state(kept!.offer_id), 'paused');
  // Removing it again is the same no-op; resuming or editing it is refused as not found.
  const removed = await f.call('city_service_update', {
    changes: [{ offer_id: b!.offer_id, state: 'removed' }],
    idempotency_key: `rm-${randomUUID()}`,
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().writes, 0);
  for (const [tool, body] of [
    ['city_service_pause', { offer_ids: [a!.offer_id], resume: true }],
    ['city_service_update', { changes: [{ offer_id: a!.offer_id, title: 'Back again' }] }],
    ['city_service_update', { changes: [{ offer_id: a!.offer_id, state: 'paused', title: 'X' }] }],
  ] as const) {
    const res = await f.call(tool, { ...body, idempotency_key: `no-${randomUUID()}` });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().issues[0].code, 'offer_not_found');
  }
  assert.equal(await state(a!.offer_id), 'removed');
  const after = await f.counts();
  assert.equal(after.offers, before.offers);
  assert.equal(after.rows, before.rows);
});

test("mine pages with a cursor and never shows another workspace's offers", async (t) => {
  const f = await fixture(t, { caps: { activePerAgent: 10 } });
  await planAndPublish(
    f,
    Array.from({ length: 5 }, (_, i) => offer(f.agents[0]!.id, `p${i}`)),
  );
  const first = (await f.call('city_service_mine', { limit: 3 })).json();
  assert.equal(first.offers.length, 3);
  assert.ok(first.next_cursor);
  const second = (
    await f.call('city_service_mine', { limit: 3, cursor: first.next_cursor })
  ).json();
  assert.equal(second.offers.length, 2);
  assert.equal(second.next_cursor, undefined);
  const ids = [...first.offers, ...second.offers].map((o: Record<string, unknown>) => o.offer_id);
  assert.equal(new Set(ids).size, 5);
  // Another owner on the same app sees none of them, and cannot pause them.
  const other = await f.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: json,
    payload: JSON.stringify({ name: 'Other seller owner', password: 'Synthetic other owner pw' }),
    remoteAddress: '198.51.100.250',
  });
  assert.equal(other.statusCode, 201, other.body);
  const otherCookie = `cc_session=${other.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
  const otherGrant = await f.app.inject({
    method: 'POST',
    url: '/api/assistant-access',
    headers: { ...json, cookie: otherCookie },
    payload: JSON.stringify({
      label: 'Other client',
      scopes: ['workspace:read', 'services:sell'],
      expiresInDays: 1,
    }),
  });
  const otherToken = otherGrant.json().token as string;
  assert.deepEqual((await f.call('city_service_mine', {}, otherToken)).json().offers, []);
  const foreign = await f.call(
    'city_service_pause',
    { offer_ids: [ids[0]], idempotency_key: 'foreign-key-0001' },
    otherToken,
  );
  assert.equal(foreign.statusCode, 400, foreign.body);
  assert.equal(foreign.json().issues[0].code, 'offer_not_found');
});

test("the fee split is the fee router's: 10% rounded down, the rest to the seller", () => {
  assert.deepEqual(offerPriceSplit('50000'), { feeRaw: '5000', sellerRaw: '45000' });
  assert.deepEqual(offerPriceSplit('99999'), { feeRaw: '9999', sellerRaw: '90000' });
  assert.deepEqual(offerPriceSplit('100000'), { feeRaw: '10000', sellerRaw: '90000' });
});

test('preset: planned, published, listed by city_service_mine, changed and cleared by city_service_update', async (t) => {
  const f = await fixture(t);
  const agentId = f.agents[0]!.id;
  const converter = (preset: unknown) =>
    offer(agentId, 'km-mi', { kind: 'unit-convert', title: 'Km to miles', preset });
  // A preset field the kind does not have: refused as invalid_preset, with the reason.
  const bad = await f.call('city_service_plan', { offers: [converter({ algorithm: 'sha256' })] });
  assert.equal(bad.statusCode, 200, bad.body);
  assert.equal(bad.json().ok, false);
  assert.equal(bad.json().refusals[0].reason, 'invalid_preset');
  assert.equal(bad.json().refusals[0].message, 'preset may only fix value, from, to.');
  // A value of the wrong type is the tool schema's refusal.
  assert.equal(
    (await f.call('city_service_plan', { offers: [converter({ from: ['km'] })] })).statusCode,
    400,
  );
  const plan = (
    await f.call('city_service_plan', { offers: [converter({ from: 'km', to: 'mi' })] })
  ).json();
  assert.deepEqual(plan.offers[0].preset, { from: 'km', to: 'mi' });
  const published = await planAndPublish(f, [converter({ from: 'km', to: 'mi' })]);
  const offerId = published.offers[0].offer_id;
  const mine = (await f.call('city_service_mine', {})).json();
  assert.deepEqual(mine.offers.find((o: { offer_id: string }) => o.offer_id === offerId).preset, {
    from: 'km',
    to: 'mi',
  });
  const changed = await f.call('city_service_update', {
    changes: [{ offer_id: offerId, preset: null }],
    idempotency_key: `upd-${randomUUID()}`,
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().offers[0].action, 'update');
  const after = (await f.call('city_service_mine', {})).json();
  assert.equal(after.offers.find((o: { offer_id: string }) => o.offer_id === offerId).preset, null);
});
