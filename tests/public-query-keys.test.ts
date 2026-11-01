import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { cursorOf } from '../server/directory/store.js';
import { DIRECTORY_PATHS } from '../shared/directory.js';
import { FEED_FRESH_STEP_MS, FEED_PATHS } from '../shared/feed.js';
import { freshParam } from '../src/feed/feedApi.js';

/*
 * Public reads the edge caches per URL, query included, refuse a query key they do not take (or
 * send it on to the canonical URL), before the rate limiter and the database: a made-up key per
 * request would otherwise skip the edge cache and reach the function and the database every time.
 * A public route added later that is cached at the edge belongs on this list.
 */

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

const SERVICE = FEED_PATHS.service.replace(':id', 'svc_aaaaaaaaaaaaaaaaaaaa');

test('cacheable public reads refuse unknown query keys', async (t) => {
  withEnv(t, { CITY_FEED: '1' });
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    logLine: () => undefined,
  });
  t.after(() => app.close());

  for (const url of [
    `${FEED_PATHS.services}?cb=1`,
    `${FEED_PATHS.services}?q=pdf&cb=1`,
    `${SERVICE}?cb=1`,
    `${FEED_PATHS.status}?cb=1`,
    `${DIRECTORY_PATHS.search}?cb=1`,
    `${DIRECTORY_PATHS.search}?q=a&limit=5`,
    '/api/public/code?cb=1',
    `${FEED_PATHS.services}?fresh=soon`,
    // A value the route would not read answers like the bare URL, so it is refused too.
    `${FEED_PATHS.services}?free=2`,
    `${FEED_PATHS.services}?free=x1`,
    `${FEED_PATHS.services}?sort=zz`,
    `${FEED_PATHS.services}?host=nohost`,
    `${FEED_PATHS.services}?cursor=!`,
    `${FEED_PATHS.services}?q=a&q=b`,
    `${FEED_PATHS.services}?sort=cheapest&sort=newest`,
    `${FEED_PATHS.services}?fresh=10000&fresh=20000`,
    `${DIRECTORY_PATHS.search}?min_rating=9`,
    `${DIRECTORY_PATHS.search}?min_rating=4.0`,
    `${DIRECTORY_PATHS.search}?sort=zz`,
    `${DIRECTORY_PATHS.search}?before=!`,
    `${DIRECTORY_PATHS.search}?before=abc`,
    `${DIRECTORY_PATHS.search}?q=a&q=b`,
  ]) {
    const response = await app.inject({ url });
    assert.equal(response.statusCode, 400, `${url}: ${response.body}`);
    assert.equal(response.headers['cache-control'], 'no-store', url);
  }

  // The keys each route takes still answer as before (the services before the first sweep: 503).
  for (const [url, status] of [
    [`${FEED_PATHS.services}?q=pdf&max_price=0.05&sort=cheapest&host=a.example&free=1`, 503],
    [`${FEED_PATHS.status}`, 200],
    [`${FEED_PATHS.services}?sort=cheapest&cursor=abc`, 503],
    [`${DIRECTORY_PATHS.search}?q=a&min_rating=4&sort=newest&before=${cursorOf(20)}`, 200],
    [SERVICE, 503],
  ] as const) {
    const response = await app.inject({ url });
    assert.equal(response.statusCode, status, `${url}: ${response.body}`);
  }
});

test('every other spelling of a query is sent on to its one canonical URL, before the limiter and the database; no-query reads refuse a stray &', async (t) => {
  withEnv(t, { CITY_FEED: '1' });
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    logLine: () => undefined,
  });
  t.after(() => app.close());
  const S = FEED_PATHS.services;
  const D = DIRECTORY_PATHS.search;
  for (const [url, location] of [
    // Empty values, a stray '&' or a bare '?': the bare URL.
    [`${S}?q=&max_price=&sort=&host=&free=&cursor=`, S],
    [`${S}?&&&`, S],
    // Spaces around or inside q (all read as one search), q of spaces only (the whole list).
    [`${S}?q=%20pdf%20%20tools%20`, `${S}?q=pdf+tools`],
    [`${S}?q=%20%20%20`, S],
    // Another key order, another spelling of a price, the default sort.
    [`${S}?max_price=0.050&q=pdf`, `${S}?q=pdf&max_price=0.05`],
    [`${S}?sort=most_used`, S],
    [`${S}?q=pdf&sort=relevance`, `${S}?q=pdf`],
    [`${S}?sort=relevance&cursor=abc`, `${S}?cursor=abc`],
    [`${S}?q=pdf%20&`, `${S}?q=pdf`],
    [`${D}?q=&min_rating=&sort=best_rated&before=`, D],
    [`${D}?&`, D],
    [`${D}?sort=newest&q=a`, `${D}?q=a&sort=newest`],
    [`${D}?q=%20a%20`, `${D}?q=a`],
  ] as const) {
    const response = await app.inject({ url });
    assert.equal(response.statusCode, 307, `${url}: ${response.body}`);
    assert.equal(response.headers.location, location, url);
    assert.equal(response.headers['cache-control'], 'no-store', url);
    // The canonical URL is read as it is (never moved again).
    const read = await app.inject({ url: location });
    assert.notEqual(read.statusCode, 307, `${location}: moved again`);
    assert.notEqual(read.statusCode, 400, `${location}: ${read.body}`);
  }
  for (const url of [
    `${FEED_PATHS.status}?&&`,
    `${SERVICE}?&`,
    '/api/public/code?&',
    '/api/public/base/agents/101?&',
  ]) {
    const response = await app.inject({ url });
    assert.equal(response.statusCode, 400, `${url}: ${response.body}`);
    assert.equal(response.headers['cache-control'], 'no-store', url);
  }
});

test('services: fresh is rounded to its step, and an unrounded one is sent on to it', async (t) => {
  withEnv(t, { CITY_FEED: '1' });
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    logLine: () => undefined,
  });
  t.after(() => app.close());
  const at = 1_792_000_012_345;
  const rounded = at - (at % FEED_FRESH_STEP_MS);
  assert.equal(freshParam('?q=pdf', at), `?q=pdf&fresh=${rounded}`);

  const moved = await app.inject({ url: `${FEED_PATHS.services}?q=pdf&fresh=${at}` });
  assert.equal(moved.statusCode, 307, moved.body);
  assert.equal(moved.headers.location, `${FEED_PATHS.services}?q=pdf&fresh=${rounded}`);
  assert.equal(moved.headers['cache-control'], 'no-store');
  // A host in capitals or with spaces is sent on to its plain form, a fresh with it.
  const host = await app.inject({ url: `${FEED_PATHS.services}?host=%20A.Example&fresh=${at}` });
  assert.equal(host.statusCode, 307, host.body);
  assert.equal(host.headers.location, `${FEED_PATHS.services}?host=a.example&fresh=${rounded}`);
  const read = await app.inject({ url: `${FEED_PATHS.services}${freshParam('?q=pdf', at)}` });
  // Read like any list (503 before the first sweep), never refused or moved.
  assert.equal(read.statusCode, 503, read.body);
});
