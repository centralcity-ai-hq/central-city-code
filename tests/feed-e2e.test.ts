import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { BAZAAR_LIST_URL, feedServiceId } from '../server/feed/bazaar.js';
import { FEED_SYNC_PATH } from '../server/feed/cron.js';
import { FEED_SYNC_BUDGET_MS, berlinMinuteOfDay, type FeedSyncRun } from '../server/feed/ingest.js';
import { feedServicesStatus } from '../server/feed/query.js';
import { serviceSearchToolOutput } from '../server/feed/tools.js';
import { BASE_NETWORKS, BASE_SEPOLIA } from '../shared/base/chains.js';
import {
  FEED_NETWORK,
  FEED_PATHS,
  FEED_SOURCE,
  FEED_TOOL_NOTICE,
  FEED_USDC,
  type FeedError,
  type FeedServiceDetail,
  type FeedServicePage,
  type FeedStatus,
} from '../shared/feed.js';
import page from './fixtures/feed-bazaar-page.json' with { type: 'json' };
import {
  fullFlow,
  mcpCall,
  ORIGIN,
  OWNER,
  ownerApi,
  PASSWORD,
  rpcResult,
  type App,
} from './oauth-helpers.js';

/*
 * Operation Central City Feed, slice 1 (Offered), end to end through the whole app on PGlite:
 * a fake x402 Bazaar with two pages, read by the sweep's cron route over two runs, then the
 * public services routes and the city_service_search tool (/mcp and its REST transport) over
 * what the sweep stored. Page 1 holds five real records of the public list (13 Oct 2026, from
 * tests/fixtures/feed-bazaar-page.json) among records the Feed never lists; page 2 holds made-up
 * ones. Nothing reaches a network: the app reads the fake, and the global fetch throws.
 */

const HOUR = 3_600_000;
const SECRET = 'feed-sweep-cron-secret-0001';
const PAY_TO = `0x${'4'.repeat(40)}`;
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

/** Sets settings for this test only and puts them back afterwards. */
function withEnv(
  t: { after: (fn: () => unknown) => void },
  values: Record<string, string | undefined>,
) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
  apply(values);
  t.after(() => apply(saved));
}

const offer = (fields: Record<string, unknown> = {}) => ({
  scheme: 'exact',
  network: FEED_NETWORK,
  asset: FEED_USDC.address,
  amount: '10000',
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  ...fields,
});

const listing = (resource: string, fields: Record<string, unknown> = {}) => ({
  resource,
  type: 'http',
  x402Version: 2,
  accepts: [offer()],
  ...fields,
});

// Page 1: five real records (all with a Base mainnet USDC offer), then one risky listing and
// records without a Base mainnet USDC offer, filled up to the page limit.
const REAL = page.items as Array<{ resource: string }>;
const RISKY = listing('https://cards.example.com/api/v1/buy', {
  serviceName: 'Card Market',
  description: 'Buy prepaid gift cards with crypto on the market.',
  tags: ['crypto', 'market'],
});
const NOT_USDC = listing('https://depth.example.com/api/v1/book', {
  serviceName: 'Crypto market depth',
  description: 'Order book depth of one crypto market.',
  accepts: [offer({ asset: `0x${'3'.repeat(40)}` })],
});
const TESTNET = listing('https://sepolia.example.com/api/v1/crypto-market', {
  serviceName: 'Crypto market on a testnet',
  accepts: [
    offer({
      network: `eip155:${BASE_SEPOLIA}`,
      asset: BASE_NETWORKS[BASE_SEPOLIA].tokens.USDC.address,
    }),
  ],
});
const PAGE_ONE = [...REAL, RISKY, NOT_USDC, TESTNET];
const FILLER = Array.from({ length: 1_000 - PAGE_ONE.length }, (_, n) =>
  listing(`https://data${n}.example.org/api/v1/record`, {
    serviceName: `Record ${n}`,
    accepts: [offer({ network: SOLANA, asset: 'So11111111111111111111111111111111111111112' })],
  }),
);

// Page 2: two made-up listings (one in x402 v1 terms with the upto scheme) and one over the cap.
const PRICES = listing('https://prices.example.com/api/v1/top', {
  serviceName: 'Crypto Market Prices',
  description: 'Top crypto market prices in USD.',
  tags: ['crypto', 'market', 'prices'],
  quality: { l30DaysTotalCalls: 40, l30DaysUniquePayers: 7 },
  accepts: [offer({ amount: '5000' })],
});
const HISTORY = listing('https://history.example.net/api/v1/candles', {
  x402Version: 1,
  serviceName: 'Market History',
  description: 'Daily candles of one crypto market.',
  quality: { l30DaysTotalCalls: 12 },
  accepts: [
    {
      scheme: 'upto',
      network: 'base',
      asset: FEED_USDC.address,
      maxAmountRequired: '20000',
      payTo: PAY_TO,
    },
  ],
});
const OVER_CAP = listing('https://report.example.com/api/v1/full', {
  serviceName: 'Crypto market report',
  accepts: [offer({ amount: '150000000' })],
});

const CATALOG: unknown[] = [...PAGE_ONE, ...FILLER, PRICES, HISTORY, OVER_CAP];
const LISTED = [...REAL, PRICES, HISTORY].map((item) => feedServiceId(item.resource)).sort();

/** The app, its owner signed in, and the fake Bazaar it reads. */
async function setup(t: { after: (fn: () => unknown) => void }) {
  // Near the real time (grants are checked against it), never in the noon checkpoint's window.
  const minute = berlinMinuteOfDay(Date.now());
  let skew = minute >= 11 * 60 && minute < 12 * 60 + 30 ? 2 * HOUR : 0;
  const clock = () => Date.now() + skew;

  const requests: Array<{ url: URL; encoding: string | null }> = [];
  const bazaar = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    requests.push({ url, encoding: new Headers(init?.headers).get('accept-encoding') });
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    // The first page takes the run's whole budget: the sweep goes on in the next run.
    if (offset === 0) skew += FEED_SYNC_BUDGET_MS;
    return new Response(
      JSON.stringify({
        items: CATALOG.slice(offset, offset + limit),
        pagination: { limit, offset, total: CATALOG.length },
        x402Version: 2,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    now: clock,
    feed: { fetch: bazaar },
    logLine: () => undefined,
  });
  t.after(() => app.close());
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: OWNER, password: PASSWORD }),
  });
  assert.equal(res.statusCode, 201, res.body);
  const cookie = `cc_session=${res.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
  return { app, cookie, requests, clock };
}

const sweep = (app: App, authorization = `Bearer ${SECRET}`) =>
  app.inject({ url: FEED_SYNC_PATH, headers: { authorization } });

type ToolResult = { isError?: boolean; structuredContent?: any; content: { text: string }[] };
async function searchTool(app: App, token: string, args: unknown): Promise<ToolResult> {
  const res = await mcpCall(app, token, 'tools/call', {
    name: 'city_service_search',
    arguments: args,
  });
  assert.equal(res.statusCode, 200, res.body);
  return rpcResult(res.body).result as ToolResult;
}

test('a two-page Bazaar sweep over two cron runs lists the Base USDC services on the routes and the tool', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('No network in this test.');
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  // Feed pay switched off (0): this test reads the search's own notice; with pay on (the default)
  // it is FEED_TOOL_NOTICE_WITH_PAY (tests/feed-pay-app.test.ts).
  withEnv(t, { CITY_FEED: '1', CITY_FEED_PAY: '0', CRON_SECRET: SECRET });
  const { app, cookie, requests, clock } = await setup(t);
  const token = (await fullFlow(app, { scope: 'workspace:read', scopes: [] })).tokens.access_token;
  const grant = await ownerApi(app, cookie, '/api/assistant-access', {
    label: 'Feed search grant',
    scopes: ['workspace:read'],
    expiresInDays: 1,
  });
  assert.equal(grant.statusCode, 201, grant.body);
  const restSearch = (query: string) =>
    app.inject({
      method: 'POST',
      url: '/api/assistant/tools/city_service_search',
      headers: { ...jsonHeaders, authorization: `Bearer ${grant.json().token as string}` },
      payload: JSON.stringify({ query }),
    });

  // The cron route fails closed: no secret or the flag off is a 404, and nothing is fetched.
  assert.equal((await sweep(app, 'Bearer not-the-cron-secret-0001')).statusCode, 404);
  process.env.CITY_FEED = '0';
  assert.equal((await sweep(app)).statusCode, 404);
  process.env.CITY_FEED = '1';
  assert.equal(requests.length, 0);

  // Run 1 reads page 1 and stops on its budget: rows are stored, nothing is listed yet.
  const first = await sweep(app);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.deepEqual(first.json() as FeedSyncRun, {
    outcome: 'partial',
    sweepId: 1,
    pages: 1,
    services: REAL.length + 1,
    excluded: 1_000 - REAL.length - 1,
    withdrawn: 0,
    offset: 1_000,
    error: null,
  });
  const before = await app.inject({ url: FEED_PATHS.services });
  assert.equal(before.statusCode, 503, before.body);
  const unavailable = before.json() as FeedError;
  assert.equal(unavailable.code, 'source_unavailable');
  assert.equal(unavailable.retryable, true);
  assert.equal(before.headers['cache-control'], 'no-store');
  const restBefore = await restSearch('crypto market');
  assert.equal(restBefore.statusCode, 503, restBefore.body);
  assert.equal(restBefore.json().code, 'source_unavailable');
  const toolBefore = await searchTool(app, token, { query: 'crypto market' });
  assert.equal(toolBefore.isError, true);
  assert.equal(JSON.parse(toolBefore.content[0]!.text).error.code, 'source_unavailable');

  // Run 2 resumes at offset 1000 and completes the sweep with page 2.
  const second = await sweep(app);
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(second.json() as FeedSyncRun, {
    outcome: 'complete',
    sweepId: 1,
    pages: 1,
    services: 2,
    excluded: 1,
    withdrawn: 0,
    offset: CATALOG.length,
    error: null,
  });
  const completedAt = clock();
  // One request per page, in order, gzip asked for; a third run has no sweep due and fetches nothing.
  assert.equal(((await sweep(app)).json() as FeedSyncRun).outcome, 'idle');
  assert.deepEqual(
    requests.map(({ url, encoding }) => [
      `${url.origin}${url.pathname}`,
      url.searchParams.get('offset'),
      url.searchParams.get('limit'),
      encoding,
    ]),
    [
      [BAZAAR_LIST_URL, '0', '1000', 'gzip'],
      [BAZAAR_LIST_URL, '1000', '1000', 'gzip'],
    ],
  );
  const { rows: reasons } = await app.city.db.query<{ reason: string; count: number }>(
    'SELECT reason, count(*)::int AS count FROM feed_exclusions GROUP BY reason ORDER BY reason',
  );
  assert.deepEqual(reasons, [
    { reason: 'not_base_mainnet', count: FILLER.length + 1 },
    { reason: 'not_usdc', count: 1 },
    { reason: 'price_over_cap', count: 1 },
  ]);

  // The public list: exactly the Base mainnet USDC services, with source credit; risky absent.
  const listed = await app.inject({ url: FEED_PATHS.services });
  assert.equal(listed.statusCode, 200, listed.body);
  const all = listed.json() as FeedServicePage;
  assert.deepEqual(all.services.map((service) => service.id).sort(), LISTED);
  assert.equal(all.total, LISTED.length);
  assert.equal(all.next, null);
  assert.equal(all.degraded, false);
  assert.ok(all.snapshotAt !== null && all.snapshotAt <= completedAt);
  assert.deepEqual(
    all.sources.map(({ name, state, total, listed: count }) => ({ name, state, total, count })),
    [{ name: FEED_SOURCE.name, state: 'ok', total: CATALOG.length, count: LISTED.length }],
  );
  const resources = new Map(
    [...REAL, PRICES, HISTORY].map((item) => [feedServiceId(item.resource), item.resource]),
  );
  for (const service of all.services) {
    assert.equal(service.kind, 'external_service');
    assert.equal(service.status, 'active');
    assert.equal(service.network, FEED_NETWORK);
    assert.deepEqual(service.asset, FEED_USDC);
    assert.equal(service.source.name, FEED_SOURCE.name);
    assert.equal(service.source.url, FEED_SOURCE.url);
    assert.equal(service.source.recordId, resources.get(service.id));
    assert.equal(service.usage.reportedBy, FEED_SOURCE.name);
  }
  const byId = new Map(all.services.map((service) => [service.id, service]));
  const prices = byId.get(feedServiceId(PRICES.resource))!;
  assert.deepEqual(prices.price, { raw: '5000', decimals: 6, display: '0.005', unit: 'per_call' });
  assert.equal(prices.usage.paidCalls30d, 40);
  const history = byId.get(feedServiceId(HISTORY.resource))!;
  assert.equal(history.x402Version, 1);
  assert.deepEqual(history.price, {
    raw: '20000',
    decimals: 6,
    display: '0.02',
    unit: 'up_to_per_call',
  });
  // The real record that lists a Solana offer first is listed on its Base USDC offer.
  const astro = byId.get(feedServiceId('https://astro-agent.dev/v1/western/transits'))!;
  assert.equal(astro.price?.raw, '80000');

  // Risky: stored with its risk (`hidden` is the operator's), never listed, never found, its
  // detail answers like an unknown id.
  const riskyId = feedServiceId(RISKY.resource);
  const { rows: stored } = await app.city.db.query<{ hidden: boolean; risky: string }>(
    'SELECT hidden, risky FROM feed_services WHERE id = $1',
    [riskyId],
  );
  assert.deepEqual(stored, [{ hidden: false, risky: 'prepaid_cards' }]);
  const riskyDetail = await app.inject({ url: `${FEED_PATHS.services}/${riskyId}` });
  assert.equal(riskyDetail.statusCode, 404);
  assert.equal((riskyDetail.json() as FeedError).code, 'service_not_found');
  const detail = await app.inject({ url: `${FEED_PATHS.services}/${prices.id}` });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal((detail.json() as FeedServiceDetail).service.source.recordId, PRICES.resource);
  assert.equal((await feedServicesStatus(app.city.db, Date.now())).services, LISTED.length);

  // One search, matched by listings of both pages and by the risky and excluded ones: the HTTP
  // route and the MCP tool answer the same ids in the same order.
  const searched = await app.inject({ url: `${FEED_PATHS.services}?q=crypto%20market` });
  assert.equal(searched.statusCode, 200, searched.body);
  const httpIds = (searched.json() as FeedServicePage).services.map((service) => service.id);
  assert.deepEqual(httpIds, [
    feedServiceId(PRICES.resource),
    feedServiceId(HISTORY.resource),
    feedServiceId('https://api.hergertsynthora.com/v1/top-crypto'),
  ]);
  const found = await searchTool(app, token, { query: 'crypto market' });
  assert.ok(!found.isError, JSON.stringify(found.content));
  const output = serviceSearchToolOutput.parse(found.structuredContent);
  assert.deepEqual(
    output.services.map((service) => service.id),
    httpIds,
  );
  assert.equal(output.notice, FEED_TOOL_NOTICE);
  assert.equal(output.snapshot_at, new Date(all.snapshotAt!).toISOString());
  assert.equal(output.degraded, false);
  for (const service of output.services) {
    assert.equal(service.status, 'active');
    assert.equal(service.source.name, FEED_SOURCE.name);
    assert.equal(service.source.record_id, resources.get(service.id));
    assert.equal(service.detail_url, `${ORIGIN}/feed/services/${service.id}`);
  }
  // The REST transport of the same tool agrees.
  const rest = await restSearch('crypto market');
  assert.equal(rest.statusCode, 200, rest.body);
  assert.deepEqual(
    serviceSearchToolOutput.parse(rest.json()).services.map((service) => service.id),
    httpIds,
  );
});
