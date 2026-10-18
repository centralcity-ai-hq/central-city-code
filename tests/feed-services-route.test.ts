import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import { createApp } from '../server/app.js';
import type { Database } from '../server/database.js';
import {
  FEED_CACHE,
  FEED_RATE,
  registerFeedServiceRoutes,
  type FeedServiceRouteDeps,
} from '../server/feed/services-routes.js';
import {
  FeedQueryError,
  feedCursor,
  feedServiceDetail,
  feedServicesStatus,
  searchFeedServices,
  searchWords,
} from '../server/feed/query.js';
import { FEED_SERVICES_SQL } from '../server/feed/services-schema.js';
import { FEED_OFFERS_SQL } from '../server/feed/offers/schema.js';
import { createFeedStore } from '../server/feed/store.js';
import { BAZAAR_SOURCE, type FeedServiceRow } from '../server/feed/types.js';
import {
  FEED_LIMITS,
  FEED_PATHS,
  FEED_SOURCE,
  FEED_USDC,
  type FeedError,
  type FeedSchemaSummary,
  type FeedService,
  type FeedServiceDetail,
  type FeedServicePage,
  type FeedServiceQuery,
  type FeedStatus,
} from '../shared/feed.js';

/*
 * Operation Central City Feed, slice 1 (server/feed/query.ts and routes.ts): the public services
 * list, a service's detail and the Feed's status. Rows are written straight into migration 104's
 * tables (no ingestion, no network). Made-up, low-entropy data only.
 */

const NOW = 1_791_640_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 'svc_' + 20 letters, ordered like n (letters only, so every collation agrees). */
function id(n: number) {
  let tail = '';
  for (let value = n, i = 0; i < 4; i++, value = Math.floor(value / 26))
    tail = String.fromCharCode(97 + (value % 26)) + tail;
  return `svc_${'k'.repeat(16)}${tail}`;
}
const payTo = (n: number) => `0x${'7'.repeat(36)}${n.toString(16).padStart(4, '0')}`;

async function feedDb(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(FEED_SERVICES_SQL);
  await pg.exec(FEED_OFFERS_SQL); // 122: seller_key and the second source's data version
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  return db;
}

interface Seed {
  n: number;
  host?: string;
  title?: string;
  description?: string;
  capabilities?: string[];
  providerName?: string | null;
  method?: string | null;
  scheme?: 'exact' | 'upto';
  price?: string | null;
  paid?: number | null;
  firstSeenAt?: number;
  /** The source's own update time (source_updated_at); null = unknown. */
  updatedAt?: number | null;
  withdrawnAt?: number | null;
  hidden?: boolean;
  risky?: string | null;
  input?: FeedSchemaSummary | null;
}

const hostOf = (seed: Seed) => seed.host ?? `provider-${seed.n}.example`;
const urlOf = (seed: Seed) => `https://${hostOf(seed)}/api/s${seed.n}`;

/** One stored record, as ingestion would write it (search_text included). */
async function addService(db: Database, seed: Seed) {
  const host = hostOf(seed);
  const title = seed.title ?? `Service ${seed.n}`;
  const description = seed.description ?? '';
  const capabilities = seed.capabilities ?? [];
  const providerName = seed.providerName === undefined ? null : seed.providerName;
  const searchText = [title, description, capabilities.join(' '), host, providerName ?? '']
    .join(' ')
    .toLowerCase();
  await db.query(
    `INSERT INTO feed_services (id, record_id, host, url, title, description, capabilities,
       provider_name, method, x402_version, scheme, price_raw, pay_to, input, output,
       paid_calls_30d, payers_30d, last_called_at, source_updated_at, fetched_at, first_seen_at,
       last_seen_at, last_seen_sweep, missed_sweeps, withdrawn_at, risky, hidden, search_text)
     VALUES ($1, $2, $3, $2, $4, $5, $6, $7, $8, 2, $9, $10::numeric, $11, $12, NULL, $13, $14,
       $15, $16, $17, $18, $17, 1, 0, $19, $20, $21, $22)`,
    [
      id(seed.n),
      urlOf(seed),
      host,
      title,
      description,
      capabilities,
      providerName,
      seed.method === undefined ? 'GET' : seed.method,
      seed.scheme ?? 'exact',
      seed.price === undefined ? '10000' : seed.price,
      payTo(seed.n),
      seed.input === undefined ? null : JSON.stringify(seed.input),
      seed.paid === undefined ? null : seed.paid,
      seed.paid === undefined || seed.paid === null ? null : 3,
      seed.paid ? NOW - 2 * HOUR : null,
      seed.updatedAt === undefined ? NOW - 5 * DAY : seed.updatedAt,
      NOW - HOUR,
      seed.firstSeenAt ?? NOW - 10 * DAY,
      seed.withdrawnAt ?? null,
      seed.risky ?? null,
      seed.hidden ?? false,
      searchText,
    ],
  );
}

/** A listing as ingestion hands it to the store (server/feed/store.ts savePage). */
function storedRow(n: number, paid: number, at: number): FeedServiceRow {
  const seed: Seed = { n };
  const title = `Service ${n}`;
  return {
    id: id(n),
    recordId: urlOf(seed),
    host: hostOf(seed),
    url: urlOf(seed),
    title,
    description: '',
    capabilities: [],
    providerName: null,
    method: 'GET',
    x402Version: 2,
    scheme: 'exact',
    priceRaw: '10000',
    payTo: payTo(n) as FeedServiceRow['payTo'],
    input: null,
    output: null,
    paidCalls30d: paid,
    payers30d: null,
    lastCalledAt: null,
    sourceUpdatedAt: null,
    fetchedAt: at,
    risky: null,
    searchText: `${title} ${hostOf(seed)}`.toLowerCase(),
  };
}

/** A complete sweep at `at` (the snapshot every list answer reflects). */
async function sweepDone(db: Database, at: number, listed = 0) {
  await db.query(
    `INSERT INTO feed_sources (name, sweep_id, last_attempt_at, last_success_at, last_total, listed)
     VALUES ($1, $2, $2, $2, 31600, $3)
     ON CONFLICT (name) DO UPDATE SET sweep_id = $2, last_attempt_at = $2, last_success_at = $2,
       last_total = 31600, listed = $3`,
    [FEED_SOURCE.name, at, listed],
  );
}

function routes(
  t: { after: (fn: () => Promise<unknown>) => void },
  db: Database,
  extra: Partial<FeedServiceRouteDeps> = {},
) {
  const app = Fastify();
  t.after(() => app.close());
  registerFeedServiceRoutes(app, { db, env: { CITY_FEED: '1' }, now: () => NOW, ...extra });
  return app;
}

type App = ReturnType<typeof routes>;

async function list(app: App, query = '') {
  const response = await app.inject({ url: `${FEED_PATHS.services}${query}` });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], FEED_CACHE);
  return response.json() as FeedServicePage;
}
const ids = (page: FeedServicePage) => page.services.map((service) => service.id);
const detailPath = (serviceId: string) => FEED_PATHS.service.replace(':id', serviceId);

async function refused(app: App, url: string, status: number, body: FeedError) {
  const response = await app.inject({ url });
  assert.equal(response.statusCode, status, response.body);
  assert.deepEqual(response.json(), body);
  assert.equal(response.headers['cache-control'], 'no-store');
}

const query = (patch: Partial<FeedServiceQuery> = {}): FeedServiceQuery => ({
  q: '',
  maxPrice: null,
  sort: 'most_used',
  host: null,
  cursor: null,
  ...patch,
});

test('before the first complete sweep every list answers 503 source_unavailable, never an empty success', async (t) => {
  const db = await feedDb(t);
  // A first sweep in progress: rows stored, nothing completed.
  await addService(db, { n: 1, paid: 5 });
  await db.query(
    `INSERT INTO feed_sources (name, sweep_id, sweep_offset, sweep_started_at, last_attempt_at)
     VALUES ($1, 1, 1000, $2, $2)`,
    [FEED_SOURCE.name, NOW - HOUR],
  );
  const app = routes(t, db);
  const unavailable: FeedError = {
    error: 'The service listings are not available yet. Try again in a few minutes.',
    code: 'source_unavailable',
    retryable: true,
  };
  await refused(app, FEED_PATHS.services, 503, unavailable);
  await refused(app, `${FEED_PATHS.services}?q=service&sort=cheapest`, 503, unavailable);
  await refused(app, detailPath(id(1)), 503, unavailable);
  await assert.rejects(
    searchFeedServices(db, query(), { limit: 5, now: NOW }),
    (error: unknown) => error instanceof FeedQueryError && error.code === 'source_unavailable',
  );

  // The status's Offered numbers (the requests slice's status route takes them): nothing listed
  // yet, the source down.
  assert.deepEqual(await feedServicesStatus(db, NOW), {
    snapshotAt: null,
    degraded: true,
    sources: [
      {
        name: 'x402 Bazaar',
        state: 'down',
        lastSuccessAt: null,
        lastAttemptAt: NOW - HOUR,
        total: null,
        listed: 0,
      },
    ],
    services: 0,
  } satisfies Omit<FeedStatus, 'openRequests'>);

  // No source row at all reads the same.
  const empty = await feedDb(t);
  await refused(routes(t, empty), FEED_PATHS.services, 503, unavailable);
});

test('a listing carries source credit, labelled usage and an exact price; no flag or bookkeeping', async (t) => {
  const db = await feedDb(t);
  const input: FeedSchemaSummary = {
    format: 'json',
    fields: [{ name: 'city', in: 'query', type: 'string', required: true, description: 'City.' }],
    more: 0,
    example: '{"city":"Lisbon"}',
    exampleState: 'whole',
  };
  await addService(db, {
    n: 1,
    host: 'weather.example',
    title: 'Weather forecast',
    description: 'Daily forecast by city.',
    capabilities: ['weather', 'forecast'],
    providerName: 'Weather Co',
    price: '10000',
    paid: 120,
    input,
  });
  await addService(db, { n: 2, scheme: 'upto', price: '2500000', method: null, paid: 1 });
  await addService(db, { n: 3, price: null, method: 'TRACE' });
  await sweepDone(db, NOW - HOUR, 3);
  const app = routes(t, db);
  const page = await list(app);
  assert.equal(page.snapshotAt, NOW - HOUR);
  assert.equal(page.degraded, false);
  assert.deepEqual(page.sources, [
    {
      name: 'x402 Bazaar',
      state: 'ok',
      lastSuccessAt: NOW - HOUR,
      lastAttemptAt: NOW - HOUR,
      total: 31600,
      listed: 3,
    },
  ]);
  assert.deepEqual(ids(page), [id(1), id(2), id(3)]);
  assert.equal(page.total, 3);
  assert.equal(page.next, null);
  assert.deepEqual(page.services[0], {
    id: id(1),
    kind: 'external_service',
    title: 'Weather forecast',
    capabilities: ['weather', 'forecast'],
    description: 'Daily forecast by city.',
    provider: { host: 'weather.example', name: 'Weather Co' },
    url: 'https://weather.example/api/s1',
    method: 'GET',
    protocol: 'x402',
    x402Version: 2,
    network: 'eip155:8453',
    asset: { ...FEED_USDC },
    scheme: 'exact',
    price: { raw: '10000', decimals: 6, display: '0.01', unit: 'per_call' },
    payTo: payTo(1) as FeedService['payTo'],
    input,
    output: null,
    source: {
      name: FEED_SOURCE.name,
      credit: 'Listed by x402 Bazaar',
      url: FEED_SOURCE.url,
      recordId: 'https://weather.example/api/s1',
      fetchedAt: NOW - HOUR,
      updatedAt: NOW - 5 * DAY,
    },
    usage: {
      paidCalls30d: 120,
      payers30d: 3,
      lastCalledAt: NOW - 2 * HOUR,
      reportedBy: FEED_SOURCE.name,
    },
    lastSeenAt: NOW - HOUR,
    status: 'active',
    moreFromHost: 0,
  } satisfies FeedService);
  // 'upto' is the most one call may cost; a method we do not know reads as unknown.
  assert.deepEqual(page.services[1].price, {
    raw: '2500000',
    decimals: 6,
    display: '2.5',
    unit: 'up_to_per_call',
  });
  assert.equal(page.services[1].method, null);
  assert.equal(page.services[2].method, null);
  // Unknown stays unknown: no price, no usage numbers.
  assert.equal(page.services[2].price, null);
  assert.deepEqual(page.services[2].usage, {
    paidCalls30d: null,
    payers30d: null,
    lastCalledAt: null,
    reportedBy: FEED_SOURCE.name,
  });
  for (const service of page.services)
    for (const key of ['risky', 'hidden', 'searchText', 'search_text', 'firstSeenAt', 'excluded'])
      assert.ok(!(key in service), key);

  // Every record names its source in words and by record, in the list and on its detail alike: a
  // record read on its own (copied, cached, handed to an agent) still credits the source.
  const credited = (service: FeedService) => {
    assert.equal(service.source.name, 'x402 Bazaar');
    assert.equal(service.source.credit, FEED_SOURCE.credit);
    assert.equal(service.source.credit, 'Listed by x402 Bazaar');
    assert.equal(service.source.url, FEED_SOURCE.url);
    assert.equal(service.source.recordId, service.url);
  };
  for (const service of page.services) credited(service);
  for (const service of (await list(app, '?q=weather&sort=cheapest')).services) credited(service);
  for (const n of [1, 2, 3]) {
    const detail = await app.inject({ url: detailPath(id(n)) });
    assert.equal(detail.statusCode, 200, detail.body);
    credited((detail.json() as FeedServiceDetail).service);
  }
});

test('freshness: ok, then delayed (degraded), then down with every service stale', async (t) => {
  const db = await feedDb(t);
  await addService(db, { n: 1, paid: 1 });
  await addService(db, { n: 2 });
  let now = NOW;
  const app = routes(t, db, { now: () => now });

  await sweepDone(db, NOW - 11 * HOUR, 2);
  let page = await list(app);
  assert.equal(page.degraded, false);
  assert.equal(page.sources[0].state, 'ok');
  assert.deepEqual(
    page.services.map((service) => service.status),
    ['active', 'active'],
  );

  // Older than two sync intervals: delayed, still active.
  now = NOW + 2 * HOUR;
  page = await list(app);
  assert.equal(page.degraded, true);
  assert.equal(page.sources[0].state, 'delayed');
  assert.equal(page.services[0].status, 'active');

  // Older than staleAfterMs: down, still listed but labelled stale (detail too).
  now = NOW - 11 * HOUR + FEED_LIMITS.staleAfterMs + 1;
  page = await list(app);
  assert.equal(page.degraded, true);
  assert.equal(page.sources[0].state, 'down');
  assert.deepEqual(ids(page), [id(1), id(2)]);
  assert.deepEqual(
    page.services.map((service) => service.status),
    ['stale', 'stale'],
  );
  const detail = await app.inject({ url: detailPath(id(1)) });
  assert.equal((detail.json() as FeedServiceDetail).service.status, 'stale');
  assert.equal((detail.json() as FeedServiceDetail).degraded, true);

  // A new complete sweep: ok again.
  await sweepDone(db, now - HOUR, 2);
  page = await list(app);
  assert.equal(page.degraded, false);
  assert.equal(page.services[0].status, 'active');
});

test('q: every word must appear, case-insensitive and literal; title hits rank first', async (t) => {
  const db = await feedDb(t);
  await addService(db, { n: 1, title: 'Weather forecast', paid: 5 });
  await addService(db, {
    n: 2,
    title: 'Climate API',
    description: 'Weather and forecast data',
    paid: 100,
  });
  await addService(db, { n: 3, title: 'Weather now', description: 'Live forecast', paid: 50 });
  await addService(db, { n: 4, title: 'Forecast', description: 'Rain only, 1x0 grid', paid: 500 });
  await addService(db, { n: 5, title: 'Uptime', description: '99% uptime, 1_000 calls' });
  await addService(db, { n: 6, title: 'Images', capabilities: ['ocr'], providerName: 'Lens Ltd' });
  await sweepDone(db, NOW - HOUR);
  const app = routes(t, db);

  // Relevance: both words in the title, then one, then paid calls.
  let page = await list(app, '?q=Weather%20FORECAST');
  assert.deepEqual(ids(page), [id(1), id(3), id(2)]);
  assert.equal(page.total, 3);
  // Spaces collapse; one word.
  assert.deepEqual(ids(await list(app, '?q=%20%20rain%20')), [id(4)]);
  // Capabilities, host and provider name are searched too.
  assert.deepEqual(ids(await list(app, '?q=ocr')), [id(6)]);
  assert.deepEqual(ids(await list(app, '?q=lens')), [id(6)]);
  assert.deepEqual(ids(await list(app, '?q=provider-2.example')), [id(2)]);
  // LIKE's wildcards are literal text.
  assert.deepEqual(ids(await list(app, '?q=%25')), [id(5)]);
  assert.deepEqual(ids(await list(app, '?q=1_0')), [id(5)]);
  assert.deepEqual(ids(await list(app, '?q=x%25y')), []);
  // At most eight distinct words count: a ninth that matches nothing is ignored.
  const nine = 'weather forecast eat her fore cast wea ather nothinghere';
  page = await list(app, `?q=${encodeURIComponent(nine)}`);
  assert.deepEqual(ids(page), [id(1), id(3), id(2)]);
  assert.equal(page.total, 3);
  // Repeated words count once.
  assert.deepEqual(ids(await list(app, '?q=rain%20rain%20RAIN')), [id(4)]);
  // No match is a success with nothing in it (the source is up).
  page = await list(app, '?q=submarine');
  assert.deepEqual(page.services, []);
  assert.equal(page.total, 0);
  assert.equal(page.next, null);
});

test('max_price: base units compared exactly, an unknown price never passes, unreadable is 400', async (t) => {
  const db = await feedDb(t);
  await addService(db, { n: 1, price: '10000', paid: 4 });
  await addService(db, { n: 2, price: '50000', paid: 3 });
  await addService(db, { n: 3, price: '50001', paid: 2 });
  await addService(db, { n: 4, price: null, paid: 1 });
  await sweepDone(db, NOW - HOUR);
  const app = routes(t, db);
  assert.deepEqual(ids(await list(app, '?max_price=0.05')), [id(1), id(2)]);
  assert.deepEqual(ids(await list(app, '?max_price=0.050001')), [id(1), id(2), id(3)]);
  assert.deepEqual(ids(await list(app, '?max_price=0')), []);
  assert.deepEqual(ids(await list(app, '?max_price=1000')), [id(1), id(2), id(3)]);
  // Absent or empty: no filter, the unknown price listed too.
  assert.deepEqual(ids(await list(app, '?max_price=')), [id(1), id(2), id(3), id(4)]);
  // The largest amount read is a filter like any other.
  assert.deepEqual(ids(await list(app, '?max_price=999999999.999999')), [id(1), id(2), id(3)]);
  const invalid: FeedError = {
    error:
      'max_price must be a USDC amount from 0 to 999999999.999999 with at most 6 decimals, for example 0.05.',
    code: 'invalid_request',
    retryable: false,
  };
  // Too large is refused like unreadable, never a 500 and never a filter silently dropped.
  for (const value of [
    'abc',
    '-1',
    '0.0000001',
    '1e3',
    '1e30',
    '1000000000',
    '99999999999999999',
    '9'.repeat(400),
  ])
    await refused(app, `${FEED_PATHS.services}?max_price=${value}`, 400, invalid);
  // An unknown parameter is still ignored, as before.
  assert.deepEqual(ids(await list(app, '?max_price=0.05&colour=blue')), [id(1), id(2)]);
});

test('sorts: most used (unknown last), cheapest (unknown last), newest; ties by id', async (t) => {
  const db = await feedDb(t);
  await addService(db, { n: 1, paid: 10, price: '500', firstSeenAt: NOW - 3 * DAY });
  await addService(db, { n: 2, paid: null, price: null, firstSeenAt: NOW - DAY });
  await addService(db, { n: 3, paid: 30, price: '100', firstSeenAt: NOW - 2 * DAY });
  await addService(db, { n: 4, paid: 30, price: '100', firstSeenAt: NOW - 2 * DAY });
  await addService(db, { n: 5, paid: 0, price: '0', firstSeenAt: NOW - 9 * DAY });
  await sweepDone(db, NOW - HOUR);
  const app = routes(t, db);
  const mostUsed = [id(3), id(4), id(1), id(5), id(2)];
  assert.deepEqual(ids(await list(app, '?sort=most_used')), mostUsed);
  // Without q, relevance (the default) reads as most used.
  assert.deepEqual(ids(await list(app)), mostUsed);
  assert.deepEqual(ids(await list(app, '?sort=relevance')), mostUsed);
  assert.deepEqual(
    ids(await searchFeedServices(db, query({ sort: 'relevance' }), { limit: 10, now: NOW })),
    mostUsed,
  );
  // An unreadable sort falls back to the default.
  assert.deepEqual(ids(await list(app, '?sort=loudest')), mostUsed);
  assert.deepEqual(ids(await list(app, '?sort=cheapest')), [id(5), id(3), id(4), id(1), id(2)]);
  assert.deepEqual(ids(await list(app, '?sort=newest')), [id(2), id(3), id(4), id(1), id(5)]);
});

test('per host at most two listings; moreFromHost counts the rest; host= lifts the cap', async (t) => {
  const db = await feedDb(t);
  const host = 'busy.example';
  await addService(db, { n: 1, host, paid: 40, title: 'Alpha' });
  await addService(db, { n: 2, host, paid: 30, title: 'Beta' });
  await addService(db, { n: 3, host, paid: 20, title: 'Gamma', price: '1000' });
  await addService(db, { n: 4, host, paid: 10, title: 'Delta', price: '900000' });
  // Not listed: they never count.
  await addService(db, { n: 5, host, paid: 99, hidden: true });
  await addService(db, { n: 6, host, paid: 98, withdrawnAt: NOW - DAY });
  await addService(db, { n: 7, host: 'quiet.example', paid: 15 });
  await sweepDone(db, NOW - HOUR);
  const app = routes(t, db);

  let page = await list(app);
  assert.deepEqual(ids(page), [id(1), id(2), id(7)]);
  assert.equal(page.total, 3, 'the total counts after the cap');
  // The Offered tab's number is the list's own total, never the raw row count (here 5).
  assert.equal((await feedServicesStatus(db, NOW)).services, page.total);
  // Counted once per data version: the next status reads only the source row, and a version that
  // moves (here a completed sweep, as every saved page moves it) counts again.
  const counts: string[] = [];
  const watched: Database = {
    ...db,
    query: (sql, params) => {
      if (/sum\(least\(n,/.test(sql)) counts.push(sql);
      return db.query(sql, params);
    },
  };
  assert.equal((await feedServicesStatus(watched, NOW)).services, page.total);
  assert.equal((await feedServicesStatus(watched, NOW)).services, page.total);
  assert.equal(counts.length, 1);
  await addService(db, { n: 8, host: 'new.example', paid: 1 });
  await sweepDone(db, NOW - HOUR + 1);
  assert.equal((await feedServicesStatus(watched, NOW)).services, page.total + 1);
  assert.equal(counts.length, 2);
  await db.query('DELETE FROM feed_services WHERE id = $1', [id(8)]);
  await sweepDone(db, NOW - HOUR);
  // The unfiltered order is ranked once per data version and sort; its pages read their ids only,
  // and a row hidden since the ranking never shows.
  const rankings: string[] = [];
  const ranked: Database = {
    ...db,
    query: (sql, params) => {
      // Partitioned per seller (migration 122: the host for the Bazaar's rows).
      if (/PARTITION BY COALESCE\(s\.seller_key, s\.host\)/.test(sql)) rankings.push(sql);
      return db.query(sql, params);
    },
  };
  const unfiltered = (cursor: string | null = null) =>
    searchFeedServices(ranked, { ...query(), cursor }, { limit: 2, now: NOW });
  const firstPage = await unfiltered();
  assert.deepEqual(ids(firstPage), [id(1), id(2)]);
  assert.equal(firstPage.total, 3);
  assert.deepEqual(ids(await unfiltered(firstPage.next)), [id(7)]);
  assert.equal(rankings.length, 1);
  await searchFeedServices(ranked, { ...query(), sort: 'cheapest' }, { limit: 2, now: NOW });
  assert.equal(rankings.length, 2);
  await db.query('UPDATE feed_services SET hidden = true WHERE id = $1', [id(2)]);
  assert.deepEqual(ids(await unfiltered()), [id(1)]);
  assert.equal(rankings.length, 2);
  await db.query('UPDATE feed_services SET hidden = false WHERE id = $1', [id(2)]);
  assert.deepEqual(
    page.services.map((service) => service.moreFromHost),
    [2, 2, 0],
  );
  // The cap follows the sort: the two cheapest of the host.
  page = await list(app, '?sort=cheapest');
  assert.deepEqual(ids(page), [id(3), id(1), id(7)]);
  assert.deepEqual(
    page.services.map((service) => service.moreFromHost),
    [2, 2, 0],
  );
  page = await list(app, '?q=delta');
  assert.deepEqual(ids(page), [id(4)]);
  assert.equal(page.services[0].moreFromHost, 3, 'the other listed ones of its host');

  // Only this host, every listing, none left over.
  page = await list(app, `?host=${host}`);
  assert.deepEqual(ids(page), [id(1), id(2), id(3), id(4)]);
  assert.equal(page.total, 4);
  assert.deepEqual(
    page.services.map((service) => service.moreFromHost),
    [0, 0, 0, 0],
  );
  // Exact host only (no suffix match), case-insensitive input.
  assert.deepEqual(ids(await list(app, '?host=BUSY.EXAMPLE')), [id(1), id(2), id(3), id(4)]);
  assert.deepEqual(ids(await list(app, '?host=example')), [id(1), id(2), id(7)]);
  assert.deepEqual(ids(await list(app, '?host=usy.example')), []);
  // A host's own list shows all of the host, page by page: none is left over on any page.
  const first = await searchFeedServices(db, query({ host }), { limit: 3, now: NOW });
  assert.deepEqual(ids(first), [id(1), id(2), id(3)]);
  assert.deepEqual(
    first.services.map((service) => service.moreFromHost),
    [0, 0, 0],
  );
  // The detail counts the others of its host.
  const detail = (await feedServiceDetail(db, id(3), NOW))!;
  assert.equal(detail.service.moreFromHost, 3);
});

test('moreFromHost: the host listings the whole list leaves out, the same on every page', async (t) => {
  const db = await feedDb(t);
  const host = 'busy.example';
  await addService(db, { n: 1, host, paid: 50, title: 'Service alpha' });
  await addService(db, { n: 2, host, paid: 10 });
  await addService(db, { n: 3, host, paid: 5 });
  await addService(db, { n: 4, host, paid: 1 });
  await addService(db, { n: 5, paid: 40, title: 'Alpha five' });
  await addService(db, { n: 6, paid: 30 });
  await sweepDone(db, NOW - HOUR);
  const pages = async (patch: Partial<FeedServiceQuery>) => {
    const shown: Array<[string, number]> = [];
    let cursor: string | null = null;
    do {
      const page = await searchFeedServices(db, query({ ...patch, cursor }), {
        limit: 2,
        now: NOW,
      });
      shown.push(...page.services.map((s): [string, number] => [s.id, s.moreFromHost]));
      cursor = page.next;
    } while (cursor);
    return shown;
  };
  // The host's two kept listings land on different pages; both say the two it leaves out.
  const capped: Array<[string, number]> = [
    [id(1), 2],
    [id(5), 0],
    [id(6), 0],
    [id(2), 2],
  ];
  assert.deepEqual(await pages({}), capped);
  // The ranked path (a filter that keeps every row) answers the same.
  assert.deepEqual(await pages({ q: 'service' }), [
    [id(1), 2],
    [id(6), 0],
    [id(2), 2],
  ]);
  assert.deepEqual(await pages({ maxPrice: '10000' }), capped);
  // Filtered: the host's listed ones minus those this filtered list keeps.
  assert.deepEqual(await pages({ q: 'alpha', sort: 'relevance' }), [
    [id(1), 3],
    [id(5), 0],
  ]);
  // The host's own list shows them all.
  assert.deepEqual(await pages({ host }), [
    [id(1), 0],
    [id(2), 0],
    [id(3), 0],
    [id(4), 0],
  ]);
  // The detail leaves out all but itself.
  assert.equal((await feedServiceDetail(db, id(2), NOW))!.service.moreFromHost, 3);
});

test('newest: within one sweep page, the source update time orders listings, unknown last', async (t) => {
  const db = await feedDb(t);
  const saved = NOW - 2 * DAY;
  // One page saved at once: first_seen_at equal, the id order the reverse of the update order.
  await addService(db, { n: 1, firstSeenAt: saved, updatedAt: NOW - 9 * DAY });
  await addService(db, { n: 2, firstSeenAt: saved, updatedAt: null });
  await addService(db, { n: 3, firstSeenAt: saved, updatedAt: NOW - 3 * DAY });
  await addService(db, { n: 4, firstSeenAt: saved, updatedAt: NOW - 4 * DAY });
  await addService(db, { n: 5, firstSeenAt: saved, updatedAt: NOW - 4 * DAY });
  // A later saved page is newer whatever its update time.
  await addService(db, { n: 6, firstSeenAt: NOW - DAY, updatedAt: NOW - 30 * DAY });
  await sweepDone(db, NOW - HOUR);
  const app = routes(t, db);
  const newest = [id(6), id(3), id(4), id(5), id(1), id(2)];
  assert.deepEqual(ids(await list(app, '?sort=newest')), newest);
  // The ranked path (a filter that keeps every row) and paging agree with the cached order.
  assert.deepEqual(ids(await list(app, '?sort=newest&q=service')), newest);
  for (const patch of [{}, { q: 'service' }]) {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await searchFeedServices(db, query({ ...patch, sort: 'newest', cursor }), {
        limit: 4,
        now: NOW,
      });
      seen.push(...ids(page));
      assert.equal(page.total, newest.length);
      cursor = page.next;
    } while (cursor);
    assert.deepEqual(seen, newest);
  }
});

test('q: one-letter words are dropped when longer ones are given; alone they still search', async (t) => {
  assert.deepEqual(searchWords('a weather B 7 forecast ü'), ['weather', 'forecast']);
  assert.deepEqual(searchWords('a b c'), ['a', 'b', 'c']);
  assert.deepEqual(searchWords('AI x'), ['ai']);
  // One Han, kana or Hangul character is a whole word: it stays beside longer ones.
  assert.deepEqual(searchWords('天気 予 報 a'), ['天気', '予', '報']);
  assert.deepEqual(searchWords('weather 雨 - x'), ['weather', '雨']);
  assert.deepEqual(searchWords('날씨 비'), ['날씨', '비']);
  const db = await feedDb(t);
  await addService(db, { n: 1, title: 'Weather forecast', paid: 5 });
  await addService(db, { n: 2, title: 'Xylophone', paid: 3 });
  await sweepDone(db, NOW - HOUR);
  const likes: number[] = [];
  const watched: Database = {
    ...db,
    query: (sql, params) => {
      if (/WITH matched/.test(sql)) likes.push(sql.match(/search_text ILIKE/g)?.length ?? 0);
      return db.query(sql, params);
    },
  };
  const app = routes(t, watched);
  assert.deepEqual(ids(await list(app, '?q=a%20weather%20z')), [id(1)]);
  assert.deepEqual(likes, [1], 'one scan condition, not one per letter');
  assert.deepEqual(ids(await list(app, '?q=y')), [id(2)]);
  assert.deepEqual(ids(await list(app, '?q=y%20q')), []);
});

test('cursor: next pages continue the order; a cursor of another snapshot answers 409 cursor_stale', async (t) => {
  const db = await feedDb(t);
  for (let n = 1; n <= 30; n++) await addService(db, { n, paid: 100 - n });
  await sweepDone(db, NOW - HOUR);
  const app = routes(t, db);

  const first = await list(app);
  assert.equal(first.services.length, FEED_LIMITS.pageSize);
  assert.equal(first.total, 30);
  assert.ok(first.next);
  assert.deepEqual(
    ids(first),
    Array.from({ length: 24 }, (_, i) => id(i + 1)),
  );
  const second = await list(app, `?cursor=${first.next}`);
  assert.deepEqual(
    ids(second),
    Array.from({ length: 6 }, (_, i) => id(i + 25)),
  );
  assert.equal(second.total, 30);
  assert.equal(second.next, null);

  // The tool's own limit pages the same order.
  const tool = await searchFeedServices(db, query(), { limit: 5, now: NOW });
  assert.deepEqual(ids(tool), [id(1), id(2), id(3), id(4), id(5)]);
  const toolNext = await searchFeedServices(db, query({ cursor: tool.next }), {
    limit: 5,
    now: NOW,
  });
  assert.deepEqual(ids(toolNext), [id(6), id(7), id(8), id(9), id(10)]);

  const stale: FeedError = {
    error: 'The listings changed since this page. Load the first page again.',
    code: 'cursor_stale',
    retryable: true,
  };
  // Cursors this server never wrote.
  for (const cursor of [
    'abc',
    feedCursor(NOW - HOUR, { sweep: NOW - HOUR, offset: 0, hosted: 0 }, 0),
    `${first.next}A`,
  ])
    await refused(app, `${FEED_PATHS.services}?cursor=${cursor}`, 409, stale);

  // A new sweep completes: the old cursor is stale, the first page answers the new snapshot.
  await sweepDone(db, NOW - 60_000);
  await refused(app, `${FEED_PATHS.services}?cursor=${first.next}`, 409, stale);
  await assert.rejects(
    searchFeedServices(db, query({ cursor: tool.next }), { limit: 5, now: NOW }),
    (error: unknown) => error instanceof FeedQueryError && error.code === 'cursor_stale',
  );
  const again = await list(app);
  assert.equal(again.snapshotAt, NOW - 60_000);
  assert.deepEqual(ids(again), ids(first));
  assert.notEqual(again.next, first.next);
  // The client reads page 1 again past the edge with a throwaway parameter (feedApi.ts
  // freshParam): the route ignores it and answers the same page.
  const fresh = await list(app, `?fresh=${NOW}`);
  assert.deepEqual(ids(fresh), ids(again));
  assert.equal(fresh.next, again.next);
  const freshSorted = await list(app, `?sort=cheapest&fresh=1`);
  assert.deepEqual(ids(freshSorted), ids(await list(app, '?sort=cheapest')));
});

test('cursor: a page saved by the next sweep, still in progress, makes an older cursor stale', async (t) => {
  const db = await feedDb(t);
  for (let n = 1; n <= 30; n++) await addService(db, { n, paid: 100 - n });
  await sweepDone(db, NOW - HOUR);
  const app = routes(t, db);
  const first = await searchFeedServices(db, query(), { limit: 5, now: NOW });
  const httpFirst = await list(app);
  // Nothing written since: the next page continues the order.
  const second = await searchFeedServices(db, query({ cursor: first.next }), {
    limit: 5,
    now: NOW,
  });
  assert.deepEqual(ids(second), [id(6), id(7), id(8), id(9), id(10)]);

  // The next sweep starts and saves one page: five new listings with more calls than any.
  const store = createFeedStore(db);
  const started = await store.startSweep(
    BAZAAR_SOURCE,
    (await store.source(BAZAAR_SOURCE)).sweepId,
    NOW - 60_000,
  );
  assert.ok(started !== null);
  const saved = await store.savePage({
    source: BAZAAR_SOURCE,
    sweepId: started,
    offset: 0,
    next: 5,
    total: 31_600,
    services: [101, 102, 103, 104, 105].map((n) => storedRow(n, 1_000 + n, NOW - 60_000)),
    excluded: [],
    complete: false,
    now: NOW - 60_000,
  });
  assert.equal(saved.advanced, true);

  // The snapshot (the last complete sweep) is unchanged, yet the cursors written before the page
  // are stale: their page 2 would repeat page 1.
  const fresh = await searchFeedServices(db, query(), { limit: 5, now: NOW });
  assert.equal(fresh.snapshotAt, first.snapshotAt);
  assert.deepEqual(ids(fresh), [id(105), id(104), id(103), id(102), id(101)]);
  for (const cursor of [first.next, second.next])
    await assert.rejects(
      searchFeedServices(db, query({ cursor }), { limit: 5, now: NOW }),
      (error: unknown) => error instanceof FeedQueryError && error.code === 'cursor_stale',
    );
  await refused(app, `${FEED_PATHS.services}?cursor=${httpFirst.next}`, 409, {
    error: 'The listings changed since this page. Load the first page again.',
    code: 'cursor_stale',
    retryable: true,
  });
  // A cursor written after the page carries on, and a failed attempt changes nothing stored.
  await store.failed(BAZAAR_SOURCE, 'unavailable', NOW - 30_000);
  const next = await searchFeedServices(db, query({ cursor: fresh.next }), {
    limit: 5,
    now: NOW,
  });
  assert.deepEqual(ids(next), [id(1), id(2), id(3), id(4), id(5)]);
});

test('hidden and risky records are never listed or found; withdrawn answers on its detail, then 404', async (t) => {
  const db = await feedDb(t);
  await addService(db, { n: 1, title: 'Listed card art', paid: 1 });
  await addService(db, { n: 2, title: 'Operator hidden', hidden: true, paid: 9 });
  // A risky record is never listed (ingestion leaves `hidden` to the operator), nor one both are.
  await addService(db, { n: 3, title: 'Gift cards', risky: 'prepaid_cards', paid: 9 });
  await addService(db, { n: 4, title: 'Wire transfers', risky: 'money_transfer', hidden: true });
  await addService(db, { n: 5, title: 'Recently withdrawn', withdrawnAt: NOW - DAY, paid: 9 });
  await addService(db, {
    n: 6,
    title: 'Withdrawn long ago',
    withdrawnAt: NOW - FEED_LIMITS.tombstoneMs,
    paid: 9,
  });
  await sweepDone(db, NOW - HOUR);
  const app = routes(t, db);

  const page = await list(app);
  assert.deepEqual(ids(page), [id(1)]);
  assert.equal(page.total, 1);
  for (const q of ['hidden', 'gift', 'wire', 'withdrawn'])
    assert.deepEqual(ids(await list(app, `?q=${q}`)), []);
  // A NUL in the search is a space, never a database error (500).
  assert.deepEqual(ids(await list(app, '?q=%00')), [id(1)]);
  assert.deepEqual(ids(await list(app, '?q=wire%00')), []);
  assert.deepEqual(
    ids(await searchFeedServices(db, query({ q: 'a\u0000b' }), { limit: 5, now: NOW })),
    [],
  );
  assert.equal((await feedServicesStatus(db, NOW)).services, 1);

  const listed = await app.inject({ url: detailPath(id(1)) });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.headers['cache-control'], FEED_CACHE);
  // The edge serves repeats (s-maxage): list pages rank every listed record.
  assert.match(FEED_CACHE, /(?:^|, )s-maxage=\d+/);
  const listedDetail = listed.json() as FeedServiceDetail;
  assert.equal(listedDetail.service.status, 'active');
  assert.equal(listedDetail.snapshotAt, NOW - HOUR);
  assert.equal(listedDetail.degraded, false);

  // Saved links keep working while the tombstone lasts.
  const withdrawn = await app.inject({ url: detailPath(id(5)) });
  assert.equal(withdrawn.statusCode, 200);
  const withdrawnDetail = withdrawn.json() as FeedServiceDetail;
  assert.equal(withdrawnDetail.service.status, 'withdrawn');
  assert.equal(withdrawnDetail.service.title, 'Recently withdrawn');
  assert.equal(withdrawnDetail.service.moreFromHost, 0);
  // A withdrawn record still credits its source.
  assert.equal(withdrawnDetail.service.source.credit, FEED_SOURCE.credit);

  // One answer for hidden, risky, long-withdrawn, unknown and malformed ids.
  const notFound: FeedError = {
    error: 'Service not found.',
    code: 'service_not_found',
    retryable: false,
  };
  for (const missing of [
    id(2),
    id(3),
    id(4),
    id(6),
    id(99),
    'svc_short',
    'svc_KKKKKKKKKKKKKKKKKKKK',
  ])
    await refused(app, detailPath(missing), 404, notFound);
  assert.equal(await feedServiceDetail(db, id(6), NOW), null);
  // A moment earlier, the long-withdrawn one was still inside its tombstone.
  assert.equal((await feedServiceDetail(db, id(6), NOW - 1))?.service.status, 'withdrawn');
});

test('CITY_FEED off: every route answers 404 not_found and charges nothing', async (t) => {
  const db = await feedDb(t);
  await addService(db, { n: 1 });
  await sweepDone(db, NOW - HOUR);
  const keys: string[] = [];
  const limit = async (key: string) => {
    keys.push(key);
  };
  const notFound: FeedError = { error: 'Not found.', code: 'not_found', retryable: false };
  // Only exactly '0' (the emergency off) turns it off.
  const offApp = routes(t, db, { env: { CITY_FEED: '0' }, limit });
  for (const url of [FEED_PATHS.services, detailPath(id(1))])
    await refused(offApp, url, 404, notFound);
  assert.deepEqual(keys, []);
  for (const env of [{}, { CITY_FEED: 'true' }, { CITY_FEED: ' 1' }, { CITY_FEED: '' }])
    assert.deepEqual(ids(await list(routes(t, db, { env }))), [id(1)], JSON.stringify(env));

  // Read per request: turning it back on needs no restart.
  const env: Record<string, string | undefined> = { CITY_FEED: '0' };
  const app = routes(t, db, { env });
  await refused(app, FEED_PATHS.services, 404, notFound);
  delete env.CITY_FEED;
  assert.deepEqual(ids(await list(app)), [id(1)]);
});

test('rate limit: every route charges ip:feed:<client address> with the directory budget', async (t) => {
  const db = await feedDb(t);
  await addService(db, { n: 1 });
  await sweepDone(db, NOW - HOUR);
  const calls: Array<[string, number, number]> = [];
  const app = routes(t, db, {
    limit: async (key, max, windowMs) => {
      calls.push([key, max, windowMs]);
    },
  });
  for (const url of [FEED_PATHS.services, detailPath(id(1))]) {
    const response = await app.inject({ url, remoteAddress: '203.0.113.7' });
    assert.equal(response.statusCode, 200, response.body);
  }
  const mapped = await app.inject({
    url: FEED_PATHS.services,
    remoteAddress: '::ffff:203.0.113.8',
  });
  assert.equal(mapped.statusCode, 200);
  assert.deepEqual(calls, [
    ['ip:feed:203.0.113.7', 60, 60_000],
    ['ip:feed:203.0.113.7', 60, 60_000],
    ['ip:feed:203.0.113.8', 60, 60_000],
  ]);
  assert.deepEqual(FEED_RATE, { max: 60, windowMs: 60_000 });

  // Over the budget: the limiter's refusal stands, nothing is read.
  const limited = Fastify();
  t.after(() => limited.close());
  registerFeedServiceRoutes(limited, {
    db,
    env: { CITY_FEED: '1' },
    limit: async () => {
      throw Object.assign(new Error('Too many requests. Try again later.'), { statusCode: 429 });
    },
  });
  const response = await limited.inject({ url: FEED_PATHS.services });
  assert.equal(response.statusCode, 429);
});

test('the app registers migrations 104 and 107 and the routes behind CITY_FEED', async (t) => {
  const before = process.env.CITY_FEED;
  t.after(() => {
    if (before === undefined) delete process.env.CITY_FEED;
    else process.env.CITY_FEED = before;
  });
  process.env.CITY_FEED = '0';
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const { rows: ledger } = await app.city.db.query<{ version: number; name: string }>(
    "SELECT version, name FROM schema_migrations WHERE name LIKE 'feed_services%' ORDER BY version",
  );
  assert.deepEqual(ledger, [
    { version: 104, name: 'feed_services' },
    { version: 107, name: 'feed_services_operator_hides' },
  ]);

  const off = await app.inject({ url: FEED_PATHS.services });
  assert.equal(off.statusCode, 404);
  assert.deepEqual(off.json(), { error: 'Not found.', code: 'not_found', retryable: false });

  process.env.CITY_FEED = '1';
  assert.equal((await feedServicesStatus(app.city.db, NOW)).snapshotAt, null);
  const services = await app.inject({ url: FEED_PATHS.services });
  assert.equal(services.statusCode, 503);
  assert.equal((services.json() as FeedError).code, 'source_unavailable');

  // Rows written to the app's own tables answer once a sweep completed.
  await addService(app.city.db, { n: 1, paid: 2 });
  await sweepDone(app.city.db, NOW - HOUR);
  const page = await app.inject({ url: `${FEED_PATHS.services}?q=service` });
  assert.equal(page.statusCode, 200, page.body);
  assert.deepEqual(ids(page.json() as FeedServicePage), [id(1)]);
});
