import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import type { Database } from '../server/database.js';
import { loadHostedConfig } from '../server/hosted.js';
import { runMigrations } from '../server/migrations.js';
import {
  LocalShed,
  PostgresRateLimiter,
  SHED_SKEW_MARGIN_MS,
  type RateLimitResult,
} from '../server/rate-limit.js';

// Hosted apps refuse to start without a shared secret; this one is synthetic and test-only.
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-test-only-rate-limit-secret-0000';

const WINDOW = 60_000;
/** A minute boundary: windows are aligned to the clock. */
const START = 1_800_000_000_000;
const END = START + WINDOW;

/**
 * Two migrated databases for the whole file (migrating is slow). Every test uses its own keys, and
 * each instance pair with and without the pre-check uses one database each.
 */
const databases = new Map<number, Promise<PGlite>>();
function database(index: number): Promise<PGlite> {
  let found = databases.get(index);
  if (!found) {
    found = PGlite.create('memory://').then(async (db) => {
      await runMigrations(db);
      return db;
    });
    databases.set(index, found);
  }
  return found;
}
after(async () => {
  for (const db of databases.values()) await (await db).close();
});

/** A view of a shared database whose queries are counted (`all`, and those on rate_limits). */
async function spied(index: number) {
  const inner = await database(index);
  const calls = { all: 0, limiter: 0, down: false };
  const db: Database = {
    query: async (sql, params) => {
      calls.all++;
      if (sql.includes('rate_limits')) calls.limiter++;
      if (calls.down) throw new Error('Synthetic outage');
      return inner.query(sql, params);
    },
    exec: (sql) => inner.exec(sql),
    transaction: (action) => inner.transaction(action),
    close: async () => {},
  };
  return { db, calls, inner };
}

const quiet = () => {};

function shedding(db: Database, clock: () => number, shed = new LocalShed()) {
  return new PostgresRateLimiter(db, clock, undefined, undefined, quiet, undefined, shed);
}
function plain(db: Database, clock: () => number) {
  return new PostgresRateLimiter(db, clock, undefined, undefined, quiet, undefined, null);
}

/**
 * The same instances twice, each pair on its own database: with the pre-check, and without it
 * (the shared limiter alone). `hit` runs a hit on both and requires the same answer.
 */
async function twins(clocks: Array<() => number>) {
  const withShed = await spied(0);
  const without = await spied(1);
  const instances = clocks.map((clock) => shedding(withShed.db, clock));
  const reference = clocks.map((clock) => plain(without.db, clock));
  return {
    instances,
    calls: withShed.calls,
    async hit(index: number, key: string, limit: number, windowMs = WINDOW) {
      const result = await instances[index]!.hit(key, limit, windowMs);
      const expected = await reference[index]!.hit(key, limit, windowMs);
      assert.deepEqual(result, expected, `instance ${index}: ${key} at limit ${limit}`);
      return result;
    },
  };
}

test('below the local limit every hit reaches the shared limiter, which decides as before', async () => {
  const now = START + 5_000;
  const w = await twins([() => now, () => now]);
  // Instance 0 stays within the limit on its own; instance 1 spends the rest of the shared budget,
  // so the shared limiter refuses instance 0 as well: those refusals still come from the database.
  const order = [0, 0, 1, 1, 1, 0, 0, 1];
  const allowed = [true, true, true, true, false, false, false, false];
  for (const [step, index] of order.entries()) {
    const before = w.calls.limiter;
    assert.equal((await w.hit(index, 'ip:198.51.100.7', 4)).allowed, allowed[step], `step ${step}`);
    assert.equal(w.calls.limiter, before + 1, `step ${step} reached the database`);
  }
  for (let step = 0; step < 50; step++) {
    const before = w.calls.limiter;
    assert.equal((await w.hit(step % 2, 'ip:198.51.100.8', 1_000)).allowed, true);
    assert.equal(w.calls.limiter, before + 1);
  }
  assert.deepEqual(
    w.instances.map((instance) => instance.shedHits),
    [0, 0],
  );
});

test('a concurrent burst reaches the shared limiter: only counted hits are known locally', async () => {
  const now = START + 5_000;
  const w = await twins([() => now]);
  const results = await Promise.all(
    Array.from({ length: 30 }, () => w.instances[0]!.hit('ip:198.51.100.9', 10, WINDOW)),
  );
  assert.equal(results.filter((result) => result.allowed).length, 10);
  assert.equal(w.calls.limiter, 30);
  assert.equal(w.instances[0]!.shedHits, 0);
  const shed = await w.instances[0]!.hit('ip:198.51.100.9', 10, WINDOW);
  assert.deepEqual(shed, { allowed: false, retryAfterMs: END - now });
  assert.equal(w.calls.limiter, 30);
});

test('past the limit, hits are refused without a query, exactly as the shared limiter refuses them', async () => {
  let now = START + 10_000;
  const w = await twins([() => now]);
  const key = 'ip:203.0.113.5';
  for (let step = 0; step < 3; step++) assert.equal((await w.hit(0, key, 3)).allowed, true);
  const queries = w.calls.all;
  for (let step = 0; step < 20; step++) {
    now += 100;
    // `w.hit` also asks a limiter without the pre-check (on its own database) for its answer.
    const result = await w.hit(0, key, 3);
    assert.deepEqual(result, { allowed: false, retryAfterMs: END - now });
  }
  assert.equal(w.calls.all, queries, 'no query of any kind for a refused hit');
  assert.equal(w.instances[0]!.shedHits, 20);
  // The shared row holds only the hits that reached it.
  assert.equal(await w.instances[0]!.count(key, WINDOW), 3);
});

test('a refused hit answers the same 429, body and Retry-After through the app', async (t) => {
  const now = START + 30_500;
  const hostedEnv = {
    CITY_HOSTED: '1',
    DATABASE_URL: 'postgresql://db.example.com/staging',
    CITY_PUBLIC_ORIGIN: 'https://city.example.com',
  };
  const run = async (withShed: boolean) => {
    const { db, calls, inner } = await spied(withShed ? 0 : 1);
    const limiter = withShed ? shedding(db, () => now) : plain(db, () => now);
    // The app's own queries go straight to the database; only the limiter's are counted.
    const app = await createApp({
      hosted: loadHostedConfig(hostedEnv),
      database: {
        query: (sql, params) => inner.query(sql, params),
        exec: (sql) => inner.exec(sql),
        transaction: (action) => inner.transaction(action),
        close: async () => {},
      },
      now: () => now,
      limits: { apiRequestsPerMinute: 2 },
      rateLimiter: limiter,
    });
    t.after(() => app.close());
    const responses = [];
    for (let step = 0; step < 3; step++) {
      const before = calls.limiter;
      const response = await app.inject({
        method: 'GET',
        url: '/api/session',
        headers: { host: 'city.example.com', origin: 'https://city.example.com' },
      });
      responses.push({ response, queried: calls.limiter > before });
    }
    return { responses, limiter };
  };
  const shed = await run(true);
  const shared = await run(false);
  assert.deepEqual(
    shed.responses.map(({ response }) => response.statusCode),
    [200, 200, 429],
  );
  assert.deepEqual(
    shared.responses.map(({ response }) => response.statusCode),
    [200, 200, 429],
  );
  const refused = shed.responses[2]!;
  const reference = shared.responses[2]!;
  assert.equal(refused.queried, false, 'the refused request made no limiter query');
  assert.equal(reference.queried, true);
  assert.equal(shed.limiter.shedHits, 1);
  assert.equal(refused.response.headers['retry-after'], '30');
  assert.equal(refused.response.headers['retry-after'], reference.response.headers['retry-after']);
  assert.deepEqual(refused.response.json(), reference.response.json());
  assert.equal(
    refused.response.headers['content-type'],
    reference.response.headers['content-type'],
  );
});

test('a new window starts again at zero, as the shared window does', async () => {
  let now = START + 1_000;
  const w = await twins([() => now]);
  const key = 'ip:203.0.113.6';
  assert.equal((await w.hit(0, key, 2)).allowed, true);
  assert.equal((await w.hit(0, key, 2)).allowed, true);
  let queries = w.calls.limiter;
  assert.equal((await w.hit(0, key, 2)).allowed, false);
  assert.equal(w.calls.limiter, queries);
  now = END + 1_000;
  for (let step = 0; step < 2; step++) {
    queries = w.calls.limiter;
    assert.deepEqual(await w.hit(0, key, 2), { allowed: true, retryAfterMs: 0 });
    assert.equal(w.calls.limiter, queries + 1);
  }
  queries = w.calls.limiter;
  assert.deepEqual(await w.hit(0, key, 2), { allowed: false, retryAfterMs: WINDOW - 1_000 });
  assert.equal(w.calls.limiter, queries);
});

test('in the last part of a window every hit goes to the shared limiter', async () => {
  let now = START + 1_000;
  const w = await twins([() => now]);
  const key = 'ip:203.0.113.7';
  await w.hit(0, key, 1);
  now = END - SHED_SKEW_MARGIN_MS - 1;
  let queries = w.calls.limiter;
  assert.deepEqual(await w.hit(0, key, 1), {
    allowed: false,
    retryAfterMs: SHED_SKEW_MARGIN_MS + 1,
  });
  assert.equal(w.calls.limiter, queries);
  now = END - SHED_SKEW_MARGIN_MS;
  queries = w.calls.limiter;
  assert.deepEqual(await w.hit(0, key, 1), { allowed: false, retryAfterMs: SHED_SKEW_MARGIN_MS });
  assert.equal(w.calls.limiter, queries + 1);
});

test('another instance clock running ahead within the margin never adds a refusal', async () => {
  let now = END - 1_200;
  const skew = 500;
  const w = await twins([() => now, () => now + skew]);
  const key = 'ip:192.0.2.44';
  assert.equal((await w.hit(0, key, 2)).allowed, true);
  assert.equal((await w.hit(0, key, 2)).allowed, true);
  now = END - 1_100;
  assert.equal((await w.hit(0, key, 2)).allowed, false);
  assert.equal(w.instances[0]!.shedHits, 1);
  // Instance 1 is already in the next window: the shared row starts over at 1.
  now = END - 400;
  assert.equal((await w.hit(1, key, 2)).allowed, true);
  // Instance 0 still counts 2 in its window, but the row says 1: the shared limiter allows it.
  assert.equal((await w.hit(0, key, 2)).allowed, true);
  assert.equal((await w.hit(0, key, 2)).allowed, false);
  // Those were counted in the next shared window, so they are not this window's local count, and
  // in its own next window instance 0 starts from zero: the shared limiter decides.
  now = END + 100;
  const queries = w.calls.limiter;
  assert.equal((await w.hit(0, key, 2)).allowed, false);
  assert.equal(w.calls.limiter, queries + 1);
  assert.equal(w.instances[0]!.shedHits, 1);

  // Without the margin the same history would refuse the hit the shared limiter allows.
  const { db } = await spied(0);
  const other = 'ip:192.0.2.46';
  now = END - 1_200;
  const early = shedding(db, () => now, new LocalShed(10_000, 0));
  const ahead = plain(db, () => now + skew);
  const shared = plain(db, () => now);
  await early.hit(other, 2, WINDOW);
  await early.hit(other, 2, WINDOW);
  now = END - 400;
  await ahead.hit(other, 2, WINDOW);
  assert.equal((await early.hit(other, 2, WINDOW)).allowed, false, 'the margin prevents this');
  // The shared limiter, asked at the same moment on the same clock, allows that hit.
  assert.equal((await shared.hit(other, 2, WINDOW)).allowed, true);
});

test('a clock that moves back never applies a count to another window', async () => {
  let now = END + 2_000;
  const w = await twins([() => now]);
  const key = 'ip:192.0.2.45';
  assert.equal((await w.hit(0, key, 1)).allowed, true);
  assert.equal((await w.hit(0, key, 1)).allowed, false);
  assert.equal(w.instances[0]!.shedHits, 1);
  // Back into the previous window: the count of the later window does not apply here.
  now = START + 2_000;
  let queries = w.calls.limiter;
  await w.hit(0, key, 1);
  await w.hit(0, key, 1);
  assert.equal(w.calls.limiter, queries + 2);
  // Forward again: the later window's own count still holds (the shared count only grew).
  now = END + 3_000;
  queries = w.calls.limiter;
  assert.deepEqual(await w.hit(0, key, 1), { allowed: false, retryAfterMs: WINDOW - 3_000 });
  assert.equal(w.calls.limiter, queries);
});

test('hits the shared limiter did not count are not counted locally', async () => {
  const now = START + 1_000;
  const w = await twins([() => now]);
  const instance = w.instances[0]!;
  // Database down: degraded buckets use the per-instance fallback, fail-closed ones refuse.
  w.calls.down = true;
  for (let step = 0; step < 5; step++) await instance.hit('ip:203.0.113.8', 2, WINDOW);
  for (let step = 0; step < 5; step++)
    assert.equal((await instance.hit('anon-mcp:203.0.113.8', 2, WINDOW)).allowed, false);
  w.calls.down = false;
  assert.equal(instance.shedHits, 0);
  // Back up: the shared limiter decides until it has counted the limit itself.
  for (const key of ['ip:203.0.113.8', 'anon-mcp:203.0.113.8']) {
    const queries = w.calls.limiter;
    assert.equal((await w.hit(0, key, 2)).allowed, true);
    assert.equal((await w.hit(0, key, 2)).allowed, true);
    assert.equal(w.calls.limiter, queries + 2);
    assert.equal((await w.hit(0, key, 2)).allowed, false);
    assert.equal(w.calls.limiter, queries + 2);
  }
  // A query that answers without a row is not a counted hit either.
  const empty = shedding({ query: async () => ({ rows: [] }) } as unknown as Database, () => now);
  for (let step = 0; step < 5; step++)
    assert.equal((await empty.hit('ip:203.0.113.9', 1, WINDOW)).allowed, true);
  assert.equal(empty.shedHits, 0);
});

test('keys, window lengths and limits are counted separately', async () => {
  const now = START + 1_000;
  const w = await twins([() => now]);
  assert.equal((await w.hit(0, 'ip:a', 1)).allowed, true);
  let queries = w.calls.limiter;
  assert.equal((await w.hit(0, 'ip:a', 1)).allowed, false);
  assert.equal(w.calls.limiter, queries);
  // Another key, and the same key with another window length (its own shared row).
  queries = w.calls.limiter;
  assert.equal((await w.hit(0, 'ip:b', 1)).allowed, true);
  assert.equal((await w.hit(0, 'ip:a', 1, 3_600_000)).allowed, true);
  assert.equal(w.calls.limiter, queries + 2);

  // One local count per limit: the shared row (one per key and window length) counts the hits of
  // every limit, so each local count stays below it.
  const { db, calls } = await spied(0);
  const instance = shedding(db, () => now);
  const key = 'ip:c';
  for (let step = 0; step < 3; step++)
    assert.equal((await instance.hit(key, 5, WINDOW)).allowed, true);
  // A stricter limit on the same key does not take the count kept under the laxer one: the shared
  // limiter decides (and refuses: the row holds 4 hits by then).
  queries = calls.limiter;
  assert.equal((await instance.hit(key, 1, WINDOW)).allowed, false);
  assert.equal(calls.limiter, queries + 1);
  // Its own count now refuses locally.
  assert.equal((await instance.hit(key, 1, WINDOW)).allowed, false);
  assert.equal(calls.limiter, queries + 1);
  // The laxer limit keeps its own count (3), so the shared limiter decides its next hit. The hit
  // refused locally never reached the row, which holds 4 rather than 5: this one is allowed.
  assert.equal((await instance.hit(key, 5, WINDOW)).allowed, true);
  assert.equal(calls.limiter, queries + 2);
  assert.equal(await instance.count(key, WINDOW), 5);
});

test('memory stays bounded; eviction only forgets counts', async () => {
  let now = START + 1_000;
  const shed = new LocalShed(3);
  const withShed = await spied(0);
  const without = await spied(1);
  const instance = shedding(withShed.db, () => now, shed);
  const reference = plain(without.db, () => now);
  const hit = async (key: string, limit: number) => {
    const result = await instance.hit(key, limit, WINDOW);
    assert.deepEqual(result, await reference.hit(key, limit, WINDOW), key);
    return result;
  };
  await hit('ip:flood', 1);
  for (let step = 0; step < 50; step++) {
    assert.equal((await hit(`ip:fresh-${step}`, 1)).allowed, true);
    const queries = withShed.calls.limiter;
    // The flooding key is touched on every hit, so least-recently-used eviction never reaches it.
    assert.equal((await hit('ip:flood', 1)).allowed, false);
    assert.equal(withShed.calls.limiter, queries);
    assert.ok(shed.size <= 3, `size ${shed.size}`);
  }
  // An evicted key goes back to the shared limiter, which still refuses it: same answer.
  let queries = withShed.calls.limiter;
  assert.equal((await hit('ip:fresh-0', 1)).allowed, false);
  assert.equal(withShed.calls.limiter, queries + 1);
  // Ended windows are swept before live entries are evicted.
  now = END + 1_000;
  await hit('ip:next-0', 5);
  assert.equal(shed.size, 1);
  queries = withShed.calls.limiter;
  assert.equal((await hit('ip:flood', 1)).allowed, true);
  assert.equal(withShed.calls.limiter, queries + 1);
  assert.throws(() => new LocalShed(0), /positive/);
  assert.throws(() => new LocalShed(10, -1), /negative/);
});

test('LocalShed refuses only what the shared comparison refuses', () => {
  const shed = new LocalShed();
  const at = START + 2;
  const refuse = (limit: number, key = 'ip:x', windowMs = WINDOW, time = at) =>
    shed.refuse(key, limit, windowMs, time);
  // One counted hit under each limit.
  for (const limit of [1, 2, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
    shed.counted('ip:x', limit, WINDOW, START, END, START + 1);
  assert.equal(refuse(1), WINDOW - 2);
  assert.equal(refuse(2), null);
  assert.equal(refuse(0.5), WINDOW - 2);
  assert.equal(refuse(Number.NaN), null);
  assert.equal(refuse(Number.POSITIVE_INFINITY), null);
  assert.equal(refuse(3), null, 'nothing counted under this limit');
  // A hit the row counted in a later window is not this window's.
  shed.counted('ip:y', 1, WINDOW, START, END + WINDOW, START + 1);
  assert.equal(refuse(1, 'ip:y'), null);
  // A late answer for a window already left does not add to the newer one.
  shed.counted('ip:z', 2, WINDOW, END, END + WINDOW, END + 1);
  shed.counted('ip:z', 2, WINDOW, START, END, END + 2);
  assert.equal(refuse(2, 'ip:z', WINDOW, END + 3), null);
  shed.counted('ip:z', 2, WINDOW, END, END + WINDOW, END + 4);
  assert.equal(refuse(2, 'ip:z', WINDOW, END + 5), WINDOW - 5);
  // Window lengths the shared limiter could not align are never refused or counted.
  shed.counted('ip:w', 1, 0, START, START, START);
  assert.equal(refuse(1, 'ip:w', 0), null);
  assert.equal(refuse(1, 'ip:w', Number.NaN), null);
});
