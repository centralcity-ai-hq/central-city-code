import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import type { Database } from '../server/database.js';
import { loadHostedConfig } from '../server/hosted.js';
import { DEFAULT_LIMITS, loadLimits } from '../server/limits.js';
import { runMigrations } from '../server/migrations.js';
import { createHash, createHmac } from 'node:crypto';
import {
  DEGRADED_LIMIT_DIVISOR,
  DEGRADED_PREFIXES,
  FAIL_CLOSED_PREFIXES,
  FAIL_CLOSED_RETRY_MS,
  MemoryRateLimiter,
  PostgresRateLimiter,
  UnclassifiedRateLimitKeyError,
  outageCause,
  outageMode,
  storedKeyHash,
  strictClassificationDefault,
  throttledOutageLog,
  type LimiterOutageMode,
} from '../server/rate-limit.js';
import { readdir, readFile } from 'node:fs/promises';
import { windowClock } from './window-clock.js';
import { join } from 'node:path';

// Hosted apps refuse to start without a shared secret; this one is synthetic and test-only.
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-test-only-rate-limit-secret-0000';

const hostedEnv = {
  CITY_HOSTED: '1',
  DATABASE_URL: 'postgresql://db.example.com/staging',
  CITY_PUBLIC_ORIGIN: 'https://city.example.com',
};
const headers = {
  host: 'city.example.com',
  origin: 'https://city.example.com',
  'x-city-request': '1',
  'content-type': 'application/json',
};
// A distinct account name per attempt keeps the per-account failed-login lock out of these
// address-limiter tests.
let badLoginCount = 0;
const badLogin = () =>
  JSON.stringify({
    name: `Nobody here ${badLoginCount++}`,
    password: 'a synthetic wrong password',
  });

test('memory limiter enforces windows and reports Retry-After time', async () => {
  let now = 1_000;
  const limiter = new MemoryRateLimiter(() => now);
  assert.deepEqual(await limiter.hit('ip:k', 2, 10_000), { allowed: true, retryAfterMs: 0 });
  assert.equal((await limiter.hit('ip:k', 2, 10_000)).allowed, true);
  now += 4_000;
  assert.deepEqual(await limiter.hit('ip:k', 2, 10_000), { allowed: false, retryAfterMs: 6_000 });
  now += 6_000;
  assert.equal((await limiter.hit('ip:k', 2, 10_000)).allowed, true);
});

test('memory limiter evicts instead of denying everyone when full', async () => {
  let now = 0;
  const limiter = new MemoryRateLimiter(() => now, 3);
  for (let index = 0; index < 3; index++) await limiter.hit(`ip:idle-${index}`, 1, 60_000);
  // The limited key stays hot, so least-recently-used eviction reaches idle keys first.
  await limiter.hit('ip:attacker', 1, 60_000);
  for (let index = 0; index < 50; index++) {
    assert.equal((await limiter.hit(`ip:fresh-${index}`, 5, 60_000)).allowed, true);
    assert.equal((await limiter.hit('ip:attacker', 1, 60_000)).allowed, false);
    assert.ok(limiter.size <= 3);
  }
  now += 60_000;
  assert.equal((await limiter.hit('ip:attacker', 1, 60_000)).allowed, true);
  assert.throws(() => new MemoryRateLimiter(() => now, 0), /positive/);
});

async function migrated(t: { after: (fn: () => Promise<unknown>) => void }) {
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  await runMigrations(db);
  return db;
}

test('postgres limiter shares one fixed window across instances and hashes keys', async (t) => {
  const db = await migrated(t);
  let now = 1_800_000_000_000;
  const first = new PostgresRateLimiter(db, () => now);
  const second = new PostgresRateLimiter(db, () => now);
  const results = [];
  for (let index = 0; index < 6; index++)
    results.push(await (index % 2 ? second : first).hit('ip:198.51.100.7', 4, 60_000));
  assert.deepEqual(
    results.map((result) => result.allowed),
    [true, true, true, true, false, false],
  );
  assert.equal(results[4]!.retryAfterMs, 60_000);
  const rows = (await db.query<{ key_hash: string; count: number }>('SELECT * FROM rate_limits'))
    .rows;
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.key_hash, /^[a-f0-9]{64}$/);
  assert.equal(Number(rows[0]!.count), 6);
  now += 60_000;
  assert.equal((await second.hit('ip:198.51.100.7', 4, 60_000)).allowed, true);
  // Concurrent hits never lose increments.
  const burst = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      (index % 2 ? first : second).hit('ip:burst', 7, 60_000),
    ),
  );
  assert.equal(burst.filter((result) => result.allowed).length, 7);
});

test('stored limiter keys are HMAC-keyed with CITY_RATE_LIMIT_KEY on both hit and count', async (t) => {
  const saved = process.env.CITY_RATE_LIMIT_KEY;
  t.after(() => {
    if (saved === undefined) delete process.env.CITY_RATE_LIMIT_KEY;
    else process.env.CITY_RATE_LIMIT_KEY = saved;
  });
  const secret = 'synthetic-rate-limit-key-for-tests-0000000000';
  process.env.CITY_RATE_LIMIT_KEY = secret;
  const db = await migrated(t);
  const limiter = new PostgresRateLimiter(db, () => 1_800_000_000_000);
  await limiter.hit('ip:198.51.100.7', 4, 60_000);
  assert.equal(await limiter.count('ip:198.51.100.7', 60_000), 1);
  const material = '60000\nip:198.51.100.7';
  const stored = (await db.query<{ key_hash: string }>('SELECT key_hash FROM rate_limits')).rows;
  assert.deepEqual(
    stored.map((row) => row.key_hash),
    [createHmac('sha256', secret).update(material).digest('hex')],
  );
  assert.notEqual(stored[0]!.key_hash, createHash('sha256').update(material).digest('hex'));
  assert.equal(storedKeyHash(60_000, 'ip:198.51.100.7'), stored[0]!.key_hash);
});

test('postgres limiter cleans expired windows in bounded batches and degrades to memory', async (t) => {
  const db = await migrated(t);
  let now = 1_800_000_000_000;
  const limiter = new PostgresRateLimiter(db, () => now);
  for (let index = 0; index < 5; index++) await limiter.hit(`ip:k-${index}`, 1, 1_000);
  now += 2_000;
  await limiter.cleanup(now, 2);
  assert.equal(
    Number((await db.query<{ c: number }>('SELECT count(*) AS c FROM rate_limits')).rows[0]!.c),
    3,
  );
  await limiter.cleanup(now);
  assert.equal(
    Number((await db.query<{ c: number }>('SELECT count(*) AS c FROM rate_limits')).rows[0]!.c),
    0,
  );
  const broken = {
    query: async () => {
      throw new Error('Synthetic outage');
    },
  } as unknown as Database;
  const degraded = new PostgresRateLimiter(
    broken,
    () => now,
    undefined,
    undefined,
    () => {},
  );
  assert.equal((await degraded.hit('ip:x', DEGRADED_LIMIT_DIVISOR, 60_000)).allowed, true);
  assert.equal((await degraded.hit('ip:x', DEGRADED_LIMIT_DIVISOR, 60_000)).allowed, false);
});

/** A database whose queries fail while `down` is true, and pass through otherwise. */
function flaky(db: Database): { db: Database; state: { down: boolean } } {
  const state = { down: true };
  const wrapped: Database = {
    query: async (sql, params) => {
      if (state.down) throw new Error('Synthetic outage');
      return db.query(sql, params);
    },
    exec: (sql) => db.exec(sql),
    transaction: (action) => db.transaction(action),
    close: async () => {},
  };
  return { db: wrapped, state };
}

test('shared limiter outage: fail-closed buckets deny with a short Retry-After, on hit and count', async (t) => {
  const { db, state } = flaky(await migrated(t));
  const now = 1_800_000_000_000;
  const reported: LimiterOutageMode[] = [];
  const limiter = new PostgresRateLimiter(
    db,
    () => now,
    undefined,
    undefined,
    (mode) => reported.push(mode),
  );
  for (const key of ['anon-mcp:203.0.113.7', 'login-attempt:alice:203.0.113.7', 'oauth-token:c']) {
    const result = await limiter.hit(key, 1_000, 60_000);
    assert.deepEqual(result, { allowed: false, retryAfterMs: FAIL_CLOSED_RETRY_MS }, key);
  }
  // A failed-login ceiling reads as exhausted, so the caller refuses instead of skipping it.
  assert.equal(await limiter.count('login-fail:account:alice', 60_000), Number.MAX_SAFE_INTEGER);
  // Outside strict mode (production), an unclassified prefix is treated as fail-closed.
  const lenient = new PostgresRateLimiter(
    db,
    () => now,
    undefined,
    undefined,
    () => {},
    false,
  );
  assert.equal((await lenient.hit('new-bucket:x', 1_000, 60_000)).allowed, false);
  assert.deepEqual(lenient.outages, { 'fail-closed': 1, degraded: 0 });
  assert.deepEqual(limiter.outages, { 'fail-closed': 4, degraded: 0 });
  assert.deepEqual(reported, Array(4).fill('fail-closed'));

  // Recovery: once the database answers, the shared window applies again.
  state.down = false;
  assert.equal((await limiter.hit('anon-mcp:203.0.113.7', 2, 60_000)).allowed, true);
  assert.equal((await limiter.hit('anon-mcp:203.0.113.7', 2, 60_000)).allowed, true);
  assert.equal((await limiter.hit('anon-mcp:203.0.113.7', 2, 60_000)).allowed, false);
  assert.equal(await limiter.count('login-fail:account:alice', 60_000), 0);
  assert.equal(limiter.outages['fail-closed'], 4);
});

test('shared limiter outage: degraded buckets use memory at a reduced limit, then recover', async (t) => {
  const { db, state } = flaky(await migrated(t));
  const now = 1_800_000_000_000;
  const limiter = new PostgresRateLimiter(
    db,
    () => now,
    undefined,
    undefined,
    () => {},
  );
  const limit = 8;
  const reduced = limit / DEGRADED_LIMIT_DIVISOR;
  for (let index = 0; index < reduced; index++)
    assert.equal((await limiter.hit('workspace-key:k1', limit, 60_000)).allowed, true);
  const denied = await limiter.hit('workspace-key:k1', limit, 60_000);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 60_000);
  // A limit below the divisor still allows one request per instance.
  assert.equal((await limiter.hit('ip:198.51.100.1', 1, 60_000)).allowed, true);
  // count scales the per-instance count the same way.
  assert.equal(
    await limiter.count('workspace-key:k1', 60_000),
    (reduced + 1) * DEGRADED_LIMIT_DIVISOR,
  );
  assert.deepEqual(limiter.outages, { 'fail-closed': 0, degraded: reduced + 3 });

  // Recovery: the shared window takes over with the full limit.
  state.down = false;
  for (let index = 0; index < limit; index++)
    assert.equal((await limiter.hit('workspace-key:k1', limit, 60_000)).allowed, true);
  assert.equal((await limiter.hit('workspace-key:k1', limit, 60_000)).allowed, false);
});

test('an outage on a sign-in bucket answers 429 with Retry-After through the app', async (t) => {
  const inner = await migrated(t);
  let now = 1_800_000_000_000;
  const limiterDb = flaky(inner);
  limiterDb.state.down = false;
  const shared: Database = {
    query: (sql, params) => inner.query(sql, params),
    exec: (sql) => inner.exec(sql),
    transaction: (action) => inner.transaction(action),
    close: async () => {},
  };
  const app = await createApp({
    hosted: loadHostedConfig(hostedEnv),
    database: shared,
    now: () => now,
    rateLimiter: new PostgresRateLimiter(
      limiterDb.db,
      () => now,
      undefined,
      undefined,
      () => {},
    ),
  });
  t.after(() => app.close());
  const login = () =>
    app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: badLogin() });
  assert.equal((await login()).statusCode, 401);
  limiterDb.state.down = true;
  now += 1;
  const refused = await login();
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.headers['retry-after'], String(FAIL_CLOSED_RETRY_MS / 1000));
  limiterDb.state.down = false;
  assert.equal((await login()).statusCode, 401);
});

test('outage reports are throttled to one structured line per mode per minute, without keys', () => {
  let now = 0;
  const lines: string[] = [];
  const report = throttledOutageLog(
    () => now,
    (line) => lines.push(line),
  );
  report('fail-closed');
  report('fail-closed', 'pool-timeout');
  report('degraded');
  now += 30_000;
  report('fail-closed');
  now += 30_000;
  report('fail-closed', 'pool-timeout');
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      { metric: 'rate_limit_shared_unavailable', mode: 'fail-closed', count: 1, pool_timeouts: 0 },
      { metric: 'rate_limit_shared_unavailable', mode: 'degraded', count: 1, pool_timeouts: 0 },
      { metric: 'rate_limit_shared_unavailable', mode: 'fail-closed', count: 3, pool_timeouts: 2 },
    ],
  );
});

test('a pool acquisition timeout counts as an outage and is reported as its own metric', async () => {
  // The limiter shares the application pool (3 clients, 5 s acquisition timeout).
  assert.equal(outageCause(new Error('timeout exceeded when trying to connect')), 'pool-timeout');
  assert.equal(outageCause(new Error('Connection terminated unexpectedly')), 'database');
  assert.equal(outageCause('not an error'), 'database');
  let error = new Error('timeout exceeded when trying to connect');
  const causes: string[] = [];
  const limiter = new PostgresRateLimiter(
    {
      query: async () => {
        throw error;
      },
    } as unknown as Database,
    () => 1_800_000_000_000,
    undefined,
    undefined,
    (_mode, cause) => causes.push(cause),
  );
  // A healthy database behind a busy pool still refuses a critical bucket, briefly.
  assert.deepEqual(await limiter.hit('login:203.0.113.9', 20, 60_000), {
    allowed: false,
    retryAfterMs: FAIL_CLOSED_RETRY_MS,
  });
  assert.equal((await limiter.hit('ip:203.0.113.9', 600, 60_000)).allowed, true);
  error = new Error('Synthetic outage');
  await limiter.hit('login:203.0.113.9', 20, 60_000);
  assert.deepEqual(causes, ['pool-timeout', 'pool-timeout', 'database']);
  assert.equal(limiter.poolTimeouts, 2);
  assert.deepEqual(limiter.outages, { 'fail-closed': 2, degraded: 1 });
});

test('strict classification: an unclassified prefix throws on hit and count in test mode', async (t) => {
  assert.equal(strictClassificationDefault({ NODE_ENV: 'test' }), true);
  assert.equal(strictClassificationDefault({ NODE_TEST_CONTEXT: 'child-v8' }), true);
  assert.equal(strictClassificationDefault({ NODE_ENV: 'production' }), false);
  // This suite runs under the test runner, so both limiters are strict by default.
  assert.equal(strictClassificationDefault(), true);
  const errors = t.mock.method(console, 'error', () => {});
  const db = await migrated(t);
  for (const limiter of [new MemoryRateLimiter(() => 1), new PostgresRateLimiter(db, () => 1)]) {
    await assert.rejects(limiter.hit('new-bucket:x', 1, 60_000), UnclassifiedRateLimitKeyError);
    await assert.rejects(limiter.count('new-bucket:x', 60_000), /new-bucket/);
    await assert.rejects(limiter.hit('nocolon', 1, 60_000), /"nocolon"/);
    assert.equal((await limiter.hit('ip:x', 1, 60_000)).allowed, true);
  }
  assert.ok(errors.mock.callCount() >= 6);
  // Production (strict off) keeps working and fails closed only during an outage.
  const lenient = new MemoryRateLimiter(() => 1, 10, false);
  assert.equal((await lenient.hit('new-bucket:x', 1, 60_000)).allowed, true);
  assert.equal(
    await new PostgresRateLimiter(db, () => 1, undefined, undefined, undefined, false).count(
      'new-bucket:x',
      60_000,
    ),
    0,
  );
});

test('a mid-login limiter failure answers 429 with Retry-After', async (t) => {
  const inner = await migrated(t);
  const now = 1_800_000_000_000;
  // The login: hit succeeds; the per-account failure count then fails (the database drops).
  const limiterDb: Database = {
    query: async (sql, params) => {
      if (sql.startsWith('SELECT count FROM rate_limits')) throw new Error('Synthetic outage');
      return inner.query(sql, params);
    },
    exec: (sql) => inner.exec(sql),
    transaction: (action) => inner.transaction(action),
    close: async () => {},
  };
  // The apps must not close the shared database; the test does that.
  const shared: Database = { ...limiterDb, query: (sql, params) => inner.query(sql, params) };
  const app = await createApp({
    hosted: loadHostedConfig(hostedEnv),
    database: shared,
    now: () => now,
    rateLimiter: new PostgresRateLimiter(
      limiterDb,
      () => now,
      undefined,
      undefined,
      () => {},
    ),
  });
  t.after(() => app.close());
  const refused = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers,
    payload: badLogin(),
  });
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.headers['retry-after'], String(FAIL_CLOSED_RETRY_MS / 1000));

  // The per-source attempt budget carries its own window as Retry-After.
  const app2 = await createApp({
    hosted: loadHostedConfig(hostedEnv),
    database: shared,
    now: () => now,
    rateLimiter: {
      async hit(key) {
        if (key.startsWith('login-attempt:')) return { allowed: false, retryAfterMs: 42_000 };
        return { allowed: true, retryAfterMs: 0 };
      },
      async count() {
        return 0;
      },
    },
  });
  t.after(() => app2.close());
  const limited = await app2.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers,
    payload: badLogin(),
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['retry-after'], '42');
});

test('every rate-limit key prefix used under server/ has an explicit outage policy', async () => {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (path.endsWith('.ts')) files.push(path);
    }
  };
  await walk('server');
  // Prefixes built from a template (`wake-${kind}-owner:`) cannot be read statically. Each such
  // template must be listed here with every value it takes; a new one fails this test until it is.
  const templated: Record<string, string[]> = {
    'wake-${kind}-owner': ['wake-wait-owner', 'wake-stream-owner'],
    'wake-${kind}-ip': ['wake-wait-ip', 'wake-stream-ip'],
    'result-${kind}-principal': ['result-flag-principal', 'result-reuse-principal'],
  };
  // Direct limiter calls and the wrappers that forward to them (results charge/allowance).
  const call = String.raw`(?:\blimit|\.hit|\.count|\bcharge|\ballowance)\(\s*`;
  const prefix = String.raw`([a-z][a-z0-9-]*(?:\$\{\w+\}[a-z0-9-]*)*):`;
  const used = new Set<string>();
  const unknownTemplates = new Set<string>();
  const record = (found: string) => {
    if (!found.includes('${')) return used.add(found);
    if (templated[found]) for (const value of templated[found]!) used.add(value);
    else unknownTemplates.add(found);
  };
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(new RegExp(call + '`' + prefix, 'g'))) record(match[1]!);
    // Keys built into a variable first, then passed to the limiter within the same function.
    for (const match of text.matchAll(new RegExp(String.raw`const (\w+) = \`` + prefix, 'g'))) {
      const after = text.slice(match.index!, match.index! + 2_000);
      if (new RegExp(call + String.raw`${match[1]}\b`).test(after)) record(match[2]!);
    }
  }
  assert.deepEqual([...unknownTemplates], [], 'list the values of templated limiter keys above');
  for (const [template, values] of Object.entries(templated))
    assert.ok(
      values.every((value) => used.has(value)),
      `${template} is no longer used`,
    );
  assert.ok(used.size >= 55, `found only ${used.size} prefixes; the scan is broken`);
  const unclassified = [...used].filter(
    (prefix) => !FAIL_CLOSED_PREFIXES.includes(prefix) && !DEGRADED_PREFIXES.includes(prefix),
  );
  assert.deepEqual(unclassified, [], 'classify new rate-limit buckets in server/rate-limit.ts');
  assert.deepEqual(
    FAIL_CLOSED_PREFIXES.filter((prefix) => DEGRADED_PREFIXES.includes(prefix)),
    [],
  );
  for (const prefix of [
    'anon-mcp',
    'login-attempt',
    'oauth-token',
    'ws-key-issue',
    'join-link-read',
  ])
    assert.equal(outageMode(`${prefix}:x`), 'fail-closed', prefix);
  for (const prefix of [
    'ip',
    'assistant',
    'workspace-key',
    'room-post-agent',
    'msg-send',
    // Signed-in wake streams and long-polls keep working through an outage.
    'wake-wait-owner',
    'wake-wait-ip',
    'wake-stream-owner',
    'wake-stream-ip',
    'result-ask-owner',
    'result-ask-net',
    'result-ask-agent',
  ])
    assert.equal(outageMode(`${prefix}:x`), 'degraded', prefix);
  for (const prefix of [
    'result-publish-owner',
    'result-publish-net',
    'result-publish-agent',
    'result-report-net',
    'result-report-network',
    'result-flag-principal',
    'result-reuse-principal',
  ])
    assert.equal(outageMode(`${prefix}:x`), 'fail-closed', prefix);
});

test('two hosted app instances on one database share login limits and return Retry-After', async (t) => {
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  // Two function instances share one database; each app closing must not close it for the other.
  const shared: Database = {
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    transaction: (action) => db.transaction(action),
    close: async () => {},
  };
  const hosted = loadHostedConfig(hostedEnv);
  const now = 1_800_000_000_000;
  const apps = [
    await createApp({ hosted, database: shared, now: () => now }),
    await createApp({ hosted, database: shared, now: () => now }),
  ];
  t.after(() => Promise.all(apps.map((app) => app.close())));
  const statuses: number[] = [];
  let limited;
  for (let index = 0; index < 21; index++) {
    const response = await apps[index % 2]!.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers,
      payload: badLogin(),
    });
    statuses.push(response.statusCode);
    if (response.statusCode === 429) limited = response;
  }
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(401));
  assert.equal(statuses[20], 429);
  assert.equal(limited!.headers['retry-after'], String(15 * 60));
});

test('X-Forwarded-For is trusted for one hop only on Vercel', async (t) => {
  assert.equal(loadHostedConfig(hostedEnv).trustProxy, false);
  assert.equal(loadHostedConfig({ ...hostedEnv, VERCEL: '1' }).trustProxy, true);
  const login = (app: Awaited<ReturnType<typeof createApp>>, forwarded: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...headers, 'x-forwarded-for': forwarded },
      payload: badLogin(),
    });
  for (const vercel of [true, false]) {
    await t.test(vercel ? 'on Vercel' : 'elsewhere', async (st) => {
      const app = await createApp({
        hosted: loadHostedConfig({ ...hostedEnv, ...(vercel ? { VERCEL: '1' } : {}) }),
        database: await PGlite.create('memory://'),
        rateLimiter: 'memory',
        now: windowClock(),
      });
      st.after(() => app.close());
      for (let index = 0; index < 20; index++)
        assert.equal((await login(app, '203.0.113.1')).statusCode, 401);
      assert.equal((await login(app, '203.0.113.1')).statusCode, 429);
      // A client-supplied left-most entry cannot choose the bucket: the edge appends the real
      // address, and only that nearest hop is trusted.
      assert.equal((await login(app, '203.0.113.2, 203.0.113.1')).statusCode, 429);
      assert.equal((await login(app, '203.0.113.9')).statusCode, vercel ? 401 : 429);
    });
  }
});

test('capacity limits default to the reviewed bounds and accept validated overrides', () => {
  assert.deepEqual(loadLimits({}), { ...DEFAULT_LIMITS });
  assert.deepEqual(DEFAULT_LIMITS, {
    operators: 0,
    registrationsPerWindow: 10,
    apiRequestsPerMinute: 600,
    assistantToolCallsPerMinute: 120,
    agentsPerWorkspace: 100,
    roomMembersMax: 10_000,
    roomMembersDefault: 100,
    connectionsPerWorkspace: 500,
    jobsPerWorkspace: 1000,
    activeJobsPerWorkspace: 10,
    activeJobsPerAgent: 2,
    workflowsPerWorkspace: 200,
    replayNoncesPerAgent: 500,
    unclaimedAgentsPerSource: 200,
    unclaimedAgentsPerSite: 500,
    unclaimedAgentsPerNetwork: 1000,
    unclaimedAgentsPerRegion: 5000,
    unclaimedAgentsGlobal: 10_000_000,
    unclaimedBucketsGlobal: 200_000,
    unclaimedCreatesPerSourcePerHour: 200,
    unclaimedCreatesPerSitePerHour: 200,
    unclaimedCreatesPerNetworkPerHour: 300,
    unclaimedCreatesPerRegionPerHour: 500,
    aiWorkspacesGlobal: 1_000_000,
    aiWorkspacesPerSource: 100,
    aiWorkspacesPerSite: 300,
    aiWorkspacesPerNetwork: 1000,
    aiWorkspacesPerRegion: 10_000,
    aiWorkspaceCreatesPerSourcePerHour: 3,
    aiWorkspaceCreatesPerSitePerHour: 10,
    aiWorkspaceCreatesPerNetworkPerHour: 30,
    aiWorkspaceCreatesPerRegionPerHour: 100,
    workspaceKeysPerWorkspace: 10,
    connectionRequestsPerOwnerPerDay: 20,
    pendingConnectionRequestsPerWorkspace: 50,
    pendingConnectionRequestsPerTarget: 50,
    invitesPerOwner: 20,
    crossSendsPerPairPerMinute: 30,
    crossInboundSendsPerOwnerPerMinute: 600,
    // Answers (docs/ANSWERS.md).
    resultPublishesPerAgentPerHour: 30,
    resultPublishesPerOwnerPerDay: 200,
    resultPublishesPerNetworkPerHour: 100,
    activePublicResultsPerOwner: 1000,
    activePublicResultsPerPrincipal: 1000,
    resultAsksPerAgentPerMinute: 60,
    resultAsksPerOwnerPerHour: 1000,
    resultAsksPerNetworkPerHour: 2000,
    reuseReportsPerNetworkPerHour: 300,
    countedFlagsPerPrincipalPerDay: 20,
    countedReusePerPrincipalPerDay: 100,
    inviteGuestsPerHost: 10_000,
    invitedGuestsPerSource: 10_000,
    invitedGuestsPerSite: 100_000,
    invitedGuestsPerNetwork: 100_000,
    invitedGuestsPerRegion: 100_000,
    invitePickupsPerSource: 10_000,
    inviteRequestsPerSourcePerHour: 20_000,
    inviteRequestsPerSitePerHour: 50_000,
    inviteRequestsPerNetworkPerHour: 100_000,
    inviteRequestsPerRegionPerHour: 200_000,
    // city_service_call (docs/FEED_PAY.md section 11): new calls as before (20 a minute per grant or
    // key and per workspace), same-key re-reads on their own budget, calls in flight per workspace.
    feedPayCallsPerGrantPerMinute: 20,
    feedPayCallsPerWorkspacePerMinute: 20,
    feedPayReadsPerGrantPerMinute: 120,
    feedPayReadsPerWorkspacePerMinute: 120,
    feedPayCallsInFlightPerWorkspace: 10,
  });
  const raised = loadLimits(
    {
      CITY_LIMIT_AGENTS_PER_WORKSPACE: '250',
      CITY_LIMIT_OPERATORS: '75',
      CITY_LIMIT_API_REQUESTS_PER_MINUTE: '100000',
    },
    { operators: 80 },
  );
  assert.equal(raised.agentsPerWorkspace, 250);
  assert.equal(raised.operators, 80);
  // 0 means no account ceiling (the default); only the operator ceiling accepts it.
  assert.equal(loadLimits({ CITY_LIMIT_OPERATORS: '0' }).operators, 0);
  assert.equal(loadLimits({}, { operators: 0 }).operators, 0);
  assert.throws(() => loadLimits({ CITY_LIMIT_OPERATORS: '-1' }), /positive integer/);
  assert.equal(raised.apiRequestsPerMinute, 100000);
  for (const bad of ['0', '-1', '1.5', 'many', '99999999999'])
    assert.throws(() => loadLimits({ CITY_LIMIT_JOBS_PER_WORKSPACE: bad }), /positive integer/);
  assert.throws(() => loadLimits({}, { jobsPerWorkspace: 0 }), /positive integer/);
});

test('sign-up has no site-wide account ceiling by default and takes no table lock', async (t) => {
  const app = await createApp({
    dataDir: 'memory://',
    startWorkers: false,
    limits: { registrationsPerWindow: 1000, apiRequestsPerMinute: 100_000 },
  });
  t.after(() => app.close());
  const local = { 'content-type': 'application/json', 'x-city-request': '1' };
  const register = (name: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: local,
      payload: JSON.stringify({ name, password: 'Synthetic signup password' }),
    });
  // Past the old default ceiling of 50 owner accounts.
  for (let index = 1; index <= 55; index++)
    assert.equal((await register(`Owner ${index}`)).statusCode, 201, `sign-up ${index}`);
  // Concurrent sign-ups for one name: the unique name settles it, exactly one wins.
  const raced = await Promise.all(Array.from({ length: 5 }, () => register('Raced name')));
  assert.deepEqual(raced.map((reply) => reply.statusCode).sort(), [201, 409, 409, 409, 409]);
  for (const reply of raced.filter((entry) => entry.statusCode === 409))
    assert.equal(reply.json().error, 'That account name is unavailable.');
  // The sign-up path never serializes on a table lock.
  const source = await readFile(join(process.cwd(), 'server', 'app.ts'), 'utf8');
  const createOwner = source.slice(source.indexOf('async function createOwner('));
  assert.doesNotMatch(createOwner.slice(0, createOwner.indexOf('\n  }\n')), /LOCK TABLE/i);
});

test('CITY_LIMIT_OPERATORS still works as an emergency sign-up brake', async (t) => {
  const app = await createApp({
    dataDir: 'memory://',
    startWorkers: false,
    limits: { ...loadLimits({ CITY_LIMIT_OPERATORS: '2' }), registrationsPerWindow: 100 },
  });
  t.after(() => app.close());
  const local = { 'content-type': 'application/json', 'x-city-request': '1' };
  const register = (name: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: local,
      payload: JSON.stringify({ name, password: 'Synthetic signup password' }),
    });
  assert.equal((await register('Brake one')).statusCode, 201);
  assert.equal((await register('Brake two')).statusCode, 201);
  const refused = await register('Brake three');
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error, 'Account limit reached.');
});

test('the per-address API budget is the configured limit (600 a minute by default)', async (t) => {
  assert.equal(DEFAULT_LIMITS.apiRequestsPerMinute, 600);
  const app = await createApp({
    dataDir: 'memory://',
    startWorkers: false,
    limits: { apiRequestsPerMinute: 3 },
  });
  t.after(() => app.close());
  const statuses: number[] = [];
  for (let request = 0; request < 4; request++)
    statuses.push((await app.inject({ method: 'GET', url: '/api/session' })).statusCode);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
});

test('a configured agent limit applies to registration', async (t) => {
  const app = await createApp({
    dataDir: 'memory://',
    startWorkers: false,
    limits: { agentsPerWorkspace: 1 },
  });
  t.after(() => app.close());
  const local = { 'content-type': 'application/json', 'x-city-request': '1' };
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: local,
    payload: JSON.stringify({ name: 'Limit owner', password: 'Synthetic limit password' }),
  });
  const cookie = `cc_session=${registered.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
  const agent = () =>
    app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { ...local, cookie },
      payload: JSON.stringify({
        name: 'Limited',
        mode: 'external',
        capability: 'extract',
        description: 'Synthetic limit check',
      }),
    });
  assert.equal((await agent()).statusCode, 201);
  const refused = await agent();
  assert.equal(refused.statusCode, 409);
  assert.match(refused.json().error, /limit of 1 agents/);
});

test('limiters report a window count without counting a hit', async (t) => {
  let now = 1_800_000_000_000;
  const db = await migrated(t);
  for (const limiter of [
    new MemoryRateLimiter(() => now),
    new PostgresRateLimiter(db, () => now),
  ]) {
    now = 1_800_000_000_000;
    assert.equal(await limiter.count('login-fail:x', 60_000), 0);
    await limiter.hit('login-fail:x', 3, 60_000);
    await limiter.hit('login-fail:x', 3, 60_000);
    assert.equal(await limiter.count('login-fail:x', 60_000), 2);
    assert.equal(await limiter.count('login-fail:x', 60_000), 2);
    now += 60_000;
    assert.equal(await limiter.count('login-fail:x', 60_000), 0);
  }
});

test('JWKS and Agent Cards share the per-address budget at its configured size', async (t) => {
  // A fixed 600 here once tripped 429s on the shared counter when the budget was raised.
  const app = await createApp({
    dataDir: 'memory://',
    startWorkers: false,
    limits: { apiRequestsPerMinute: 3 },
  });
  t.after(() => app.close());
  const statuses: number[] = [];
  for (const url of [
    '/api/session',
    '/api/session',
    '/.well-known/jwks.json',
    '/.well-known/jwks.json',
  ])
    statuses.push((await app.inject({ method: 'GET', url })).statusCode);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
});
