import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { FEED_SYNC_PATH } from '../server/feed/cron.js';
import { berlinMinuteOfDay, type FeedSyncRun } from '../server/feed/ingest.js';
import {
  FEED_PATHS,
  FEED_SOURCE,
  type FeedServicePage,
  type FeedStatus,
  type PostedFeedRequest,
} from '../shared/feed.js';
import page from './fixtures/feed-bazaar-page.json' with { type: 'json' };

/*
 * The Feed status route (GET /api/public/feed, the one the Feed nav entry waits for) inside the
 * whole app on PGlite: after one sweep of a fake x402 Bazaar through the cron route and one
 * posted request, it answers the listed services, the open requests and the sweep's freshness;
 * with CITY_FEED off it answers 404. The page holds five real records of the public list (all
 * with a Base mainnet USDC offer, tests/fixtures/feed-bazaar-page.json) and one made-up record
 * the Feed never lists. Nothing reaches a network: the app reads the fake, the global fetch
 * throws.
 */

const HOUR = 3_600_000;
const SECRET = 'feed-status-cron-secret-0001';

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

const REAL = page.items as Array<{ resource: string }>;
/** Paid on Solana only: excluded, never listed. */
const NOT_BASE = {
  resource: 'https://data.example.org/api/v1/record',
  type: 'http',
  x402Version: 2,
  serviceName: 'Record on another network',
  accepts: [
    {
      scheme: 'exact',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      asset: 'So11111111111111111111111111111111111111112',
      amount: '10000',
      payTo: `0x${'4'.repeat(40)}`,
      maxTimeoutSeconds: 60,
    },
  ],
};
const CATALOG: unknown[] = [...REAL, NOT_BASE];

test('the status route answers the swept services, one open request and the sweep freshness; 404 with CITY_FEED off', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('No network in this test.');
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  withEnv(t, { CITY_FEED: '1', CRON_SECRET: SECRET });
  // Near the real time, never in the noon checkpoint's window (no page is fetched then).
  const minute = berlinMinuteOfDay(Date.now());
  const skew = minute >= 11 * 60 && minute < 12 * 60 + 30 ? 2 * HOUR : 0;
  const bazaar = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
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
    now: () => Date.now() + skew,
    feed: { fetch: bazaar },
    logLine: () => undefined,
  });
  t.after(() => app.close());

  // Before the first sweep: no services and no requests, nothing fresh yet.
  const empty = await app.inject({ url: FEED_PATHS.status });
  assert.equal(empty.statusCode, 200, empty.body);
  const before = empty.json() as FeedStatus;
  assert.equal(before.services, 0);
  assert.equal(before.openRequests, 0);
  assert.equal(before.snapshotAt, null);
  assert.equal(before.degraded, true);

  // One cron run reads the one page and completes the sweep.
  const run = await app.inject({
    url: FEED_SYNC_PATH,
    headers: { authorization: `Bearer ${SECRET}` },
  });
  assert.equal(run.statusCode, 200, run.body);
  assert.equal((run.json() as FeedSyncRun).outcome, 'complete', run.body);

  // One request, posted signed out.
  const posted = await app.inject({
    method: 'POST',
    url: FEED_PATHS.requests,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      title: 'Chart a year of harbor tides',
      description: 'Daily highs and lows.',
      idempotencyKey: randomUUID(),
    }),
  });
  assert.equal(posted.statusCode, 201, posted.body);
  assert.equal((posted.json() as PostedFeedRequest).request.status, 'open');

  const services = await app.inject({ url: FEED_PATHS.services });
  assert.equal(services.statusCode, 200, services.body);
  const listed = services.json() as FeedServicePage;

  const answer = await app.inject({ url: FEED_PATHS.status });
  assert.equal(answer.statusCode, 200, answer.body);
  const status = answer.json() as FeedStatus;
  assert.deepEqual(Object.keys(status).sort(), [
    'degraded',
    'openRequests',
    'services',
    'snapshotAt',
    'sources',
  ]);
  assert.equal(status.services, REAL.length);
  assert.equal(status.services, listed.total);
  assert.equal(status.openRequests, 1);
  // The freshness of the sweep, the same the services list answers with.
  assert.ok(status.snapshotAt !== null && status.snapshotAt <= Date.now() + skew);
  assert.equal(status.degraded, false);
  assert.deepEqual(
    { snapshotAt: status.snapshotAt, degraded: status.degraded, sources: status.sources },
    { snapshotAt: listed.snapshotAt, degraded: listed.degraded, sources: listed.sources },
  );
  assert.deepEqual(
    status.sources.map(({ name, state, total, listed: count }) => ({ name, state, total, count })),
    [{ name: FEED_SOURCE.name, state: 'ok', total: CATALOG.length, count: REAL.length }],
  );
  assert.ok(status.sources[0]!.lastSuccessAt !== null);
  assert.ok(status.sources[0]!.lastAttemptAt !== null);

  // CITY_FEED off: the status route answers like an unknown path.
  process.env.CITY_FEED = '0';
  const off = await app.inject({ url: FEED_PATHS.status });
  assert.equal(off.statusCode, 404, off.body);
  assert.deepEqual(off.json(), { error: 'Not found.', code: 'not_found', retryable: false });
});
