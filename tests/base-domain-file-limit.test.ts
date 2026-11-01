import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import {
  DOMAIN_CHAINS,
  DOMAIN_FILE_ALERT_BYTES,
  DOMAIN_FILE_BODY_LIMIT,
  DOMAIN_FILE_MAX_BYTES,
  DOMAIN_FILE_SCOPE,
  acceptsGzip,
  registerShortLinks,
} from '../server/base/identity/short-links.js';
import {
  DOMAIN_FILE_PATH,
  buildDomainFile,
  registerDomainFileCron,
} from '../server/base/identity/domain-file.js';

// The domain file (/.well-known/agent-registration.json) is read by anyone: it keeps the
// visitor's per-IP limit, a request only reads the stored file (built by the cron), and a query
// string (which misses the edge cache) never costs more than one read of that row per instance.
const FILE = { registrations: [{ agentId: 101, agentRegistry: 'eip155:8453:0x8004' }] };

function storedDb(file: unknown = FILE) {
  const reads = { stored: 0, other: 0 };
  const db = {
    query: async (sql: string) => {
      if (/FROM base_domain_files/.test(sql)) {
        reads.stored += 1;
        return { rows: file === null ? [] : [{ body: gzipSync(JSON.stringify(file)) }] };
      }
      reads.other += 1;
      return { rows: [] };
    },
    exec: async () => {},
    transaction: async () => {
      reads.other += 1;
      throw new Error('a request never reads the registrations');
    },
    close: async () => {},
  } as unknown as Database;
  return { db, reads };
}

test('a request serves the stored file, read once for a burst of cache-busting requests', async (t) => {
  const { db, reads } = storedDb();
  const app = Fastify();
  t.after(() => app.close());
  registerShortLinks(app, { db, originOf: () => 'https://centralcity.ai' });
  const answers = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      app.inject({ url: `/.well-known/agent-registration.json?x=${i}` }),
    ),
  );
  for (const res of answers) {
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), FILE);
  }
  assert.deepEqual(reads, { stored: 1, other: 0 });
});

test('the stored file goes out gzip-compressed to clients that take gzip', async (t) => {
  const { db } = storedDb();
  const app = Fastify();
  t.after(() => app.close());
  registerShortLinks(app, { db, originOf: () => 'https://centralcity.ai' });
  const zipped = await app.inject({
    url: '/.well-known/agent-registration.json',
    headers: { 'accept-encoding': 'gzip, deflate, br' },
  });
  assert.equal(zipped.statusCode, 200);
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal(zipped.headers.vary, 'Accept-Encoding');
  assert.deepEqual(zipped.rawPayload, gzipSync(JSON.stringify(FILE)));
  const plain = await app.inject({
    url: '/.well-known/agent-registration.json',
    headers: { 'accept-encoding': 'gzip;q=0, identity' },
  });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(plain.json(), FILE);
  assert.equal(acceptsGzip('*'), true);
  assert.equal(acceptsGzip('br'), false);
  assert.equal(acceptsGzip(undefined), false);
});

test('before the first build the domain file is busy, never an empty list', async (t) => {
  const { db } = storedDb(null);
  const app = Fastify();
  t.after(() => app.close());
  registerShortLinks(app, { db, originOf: () => 'https://centralcity.ai' });
  const res = await app.inject({ url: '/.well-known/agent-registration.json' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['retry-after'], '10');
});

test('the domain file keeps the per-IP limit: 429 with Retry-After, never cached', async (t) => {
  const { db, reads } = storedDb();
  const app = Fastify();
  t.after(() => app.close());
  registerShortLinks(app, {
    db,
    originOf: () => 'https://centralcity.ai',
    limit: async () => {
      throw Object.assign(new Error('limited'), { statusCode: 429, retryAfterMs: 30_000 });
    },
  });
  const res = await app.inject({ url: '/.well-known/agent-registration.json' });
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '30');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(reads, { stored: 0, other: 0 });
});

const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

/** Confirmed public agents as the build reads them before the public cards are backfilled. */
function registrationsDb(identities: Array<{ chain: number; id: string }>) {
  const rows = identities.map((identity, i) => ({
    agent_id: `a${i}`,
    chain_id: identity.chain,
    registry_address: REGISTRY,
    erc8004_agent_id: identity.id,
    workspace: 'ws',
  }));
  const cards = rows.map((row) => ({ operator_id: 'ws', agent_id: row.agent_id }));
  const tx = {
    query: async (sql: string) => ({
      rows: /FROM base_identities/.test(sql) ? rows : /FROM workspaces/.test(sql) ? cards : [],
    }),
    exec: async () => {},
  };
  const stored: unknown[][] = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      if (/^INSERT INTO base_domain_files/.test(sql.trim())) stored.push(params);
      return { rows: [] };
    },
    exec: async () => {},
    transaction: async (action: (tx: unknown) => Promise<unknown>) => action(tx),
    close: async () => {},
  } as unknown as Database;
  const file = (n = stored.length - 1) =>
    JSON.parse(gunzipSync(stored[n]![1] as Buffer).toString('utf8')) as {
      registrations: Array<{ agentId: number | string; agentRegistry: string }>;
    };
  return { db, stored, file };
}

const range = (chain: number, from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ chain, id: String(from + i) }));

test('the domain file is scoped: only the newest registrations of each chain (CCA-118)', async () => {
  // Mainnet ids 1001..1025 and Sepolia 501..505, unordered: a scope of 10 keeps mainnet's newest
  // 10 (the highest ids) and all of Sepolia's, in the file's order (id, then chain).
  const { db, stored, file } = registrationsDb(
    [...range(8453, 1001, 25), ...range(84532, 501, 5)].reverse(),
  );
  const build = await buildDomainFile(db, 'https://centralcity.ai', {
    logLine: () => {},
    scope: 10,
  });
  assert.equal(build.entries, 15);
  assert.equal(stored[0]![3], 15);
  assert.deepEqual(
    file().registrations.map((entry) => `${entry.agentRegistry.split(':')[1]}:${entry.agentId}`),
    [
      ...range(84532, 501, 5).map((r) => `84532:${r.id}`),
      ...range(8453, 1016, 10).map((r) => `8453:${r.id}`),
    ],
  );
  // The default scope is DOMAIN_FILE_SCOPE per chain, never every registration.
  const big = registrationsDb(range(8453, 1, DOMAIN_FILE_SCOPE + 7));
  assert.equal(
    (await buildDomainFile(big.db, 'https://centralcity.ai', { logLine: () => {} })).entries,
    DOMAIN_FILE_SCOPE,
  );
  assert.equal(big.file().registrations[0]!.agentId, 8);
});

test('the scoped file stays below the ALERT bound uncompressed, on every chain at once', () => {
  // The largest entry a safe-integer id makes, on the longest chain id: every chain full.
  const entry = {
    agentId: Number.MAX_SAFE_INTEGER,
    agentRegistry: `eip155:${Math.max(...DOMAIN_CHAINS)}:${REGISTRY}`,
  };
  const full = JSON.stringify({
    registrations: Array.from({ length: DOMAIN_FILE_SCOPE * DOMAIN_CHAINS.length }, () => entry),
  });
  assert.ok(Buffer.byteLength(full) < DOMAIN_FILE_ALERT_BYTES, String(Buffer.byteLength(full)));
  assert.ok(DOMAIN_FILE_ALERT_BYTES < DOMAIN_FILE_MAX_BYTES);
  assert.ok(DOMAIN_FILE_MAX_BYTES < DOMAIN_FILE_BODY_LIMIT);
});

test('the size guard: an ALERT line past the alert bound, and a file over the bound is never stored', async () => {
  const { db, stored } = registrationsDb(range(8453, 1, 40));
  const lines: string[] = [];
  const large = await buildDomainFile(db, 'https://centralcity.ai', {
    logLine: (line) => lines.push(line),
    alertBytes: 1_000,
  });
  assert.equal(stored.length, 1);
  const sizes = { entries: 40, bytes: large.bytes, gzipBytes: large.gzipBytes };
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      { event: 'domain_file_built', ...sizes },
      {
        event: 'domain_file_large',
        level: 'ALERT',
        origin: 'https://centralcity.ai',
        ...sizes,
        limitBytes: DOMAIN_FILE_BODY_LIMIT,
      },
    ],
  );
  // Over the hard bound: nothing is written (the last stored file stays), one ALERT line.
  lines.length = 0;
  const refused = await buildDomainFile(db, 'https://centralcity.ai', {
    logLine: (line) => lines.push(line),
    maxBytes: 1_000,
  });
  assert.equal(refused.refused, true);
  assert.equal(stored.length, 1);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      {
        event: 'domain_file_refused',
        level: 'ALERT',
        origin: 'https://centralcity.ai',
        entries: 40,
        bytes: refused.bytes,
        maxBytes: 1_000,
        limitBytes: DOMAIN_FILE_BODY_LIMIT,
      },
    ],
  );
});

test('with the Fastify logger off and no sink passed, the size ALERT still reaches the console', async (t) => {
  // Production: the app's logger is disabled and app.ts passes no logLine. Ids as long as a
  // uint256, on more chains than the scope was sized for, make even the scoped file pass
  // DOMAIN_FILE_MAX_BYTES: the guard, not the scope, has to catch it.
  const huge = (n: number) => `${'9'.repeat(70)}${String(n).padStart(8, '0')}`;
  const { db, stored } = registrationsDb(
    [...DOMAIN_CHAINS, 1, 10].flatMap((chain) =>
      Array.from({ length: DOMAIN_FILE_SCOPE }, (_, i) => ({ chain, id: huge(i) })),
    ),
  );
  const app = Fastify();
  t.after(() => app.close());
  const errors: string[] = [];
  t.mock.method(console, 'error', (line: string) => errors.push(line));
  t.mock.method(console, 'info', () => {});
  const secret = 's'.repeat(32);
  registerDomainFileCron(app, {
    db,
    cronSecret: secret,
    origins: () => ['https://centralcity.ai'],
  });
  const res = await app.inject({
    url: DOMAIN_FILE_PATH,
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(stored.length, 0);
  const alerts = errors.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.event, 'domain_file_refused');
  assert.equal(alerts[0]!.level, 'ALERT');
  assert.ok(Number(alerts[0]!.bytes) > DOMAIN_FILE_MAX_BYTES);
});

test('the cron builds one file per hosted origin, every minute, only with the cron secret', async (t) => {
  const stored: string[] = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      if (/^INSERT INTO base_domain_files/.test(sql.trim())) stored.push(String(params[0]));
      return { rows: [] };
    },
    exec: async () => {},
    transaction: async (action: (tx: unknown) => Promise<unknown>) =>
      action({ query: async () => ({ rows: [] }), exec: async () => {} }),
    close: async () => {},
  } as unknown as Database;
  const app = Fastify();
  t.after(() => app.close());
  const secret = 's'.repeat(32);
  t.mock.method(console, 'info', () => {});
  registerDomainFileCron(app, {
    db,
    cronSecret: secret,
    origins: () => ['https://centralcity.ai', 'https://www.centralcity.ai'],
  });
  assert.equal((await app.inject({ url: DOMAIN_FILE_PATH })).statusCode, 404);
  const res = await app.inject({
    url: DOMAIN_FILE_PATH,
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(stored, ['https://centralcity.ai', 'https://www.centralcity.ai']);
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    crons: Array<{ path: string; schedule: string }>;
  };
  assert.deepEqual(
    config.crons.filter((cron) => cron.path === DOMAIN_FILE_PATH),
    [{ path: DOMAIN_FILE_PATH, schedule: '* * * * *' }],
  );
});
