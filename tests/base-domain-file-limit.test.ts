import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import { registerShortLinks } from '../server/base/identity/short-links.js';

// The domain file (/.well-known/agent-registration.json) is read by anyone: it keeps the
// visitor's per-IP limit, and a query string (which misses the edge cache) never costs a fresh
// read of every confirmed identity.
function countingDb() {
  const reads = { n: 0 };
  const db = {
    query: async () => ({ rows: [] }),
    exec: async () => {},
    transaction: async (action: (tx: unknown) => Promise<unknown>) => {
      reads.n += 1;
      return action({ query: async () => ({ rows: [] }), exec: async () => {} });
    },
    close: async () => {},
  } as unknown as Database;
  return { db, reads };
}

test('the domain file is read once for a burst of cache-busting requests', async (t) => {
  const { db, reads } = countingDb();
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
    assert.deepEqual(res.json(), { registrations: [] });
  }
  assert.equal(reads.n, 1);
});

test('the domain file keeps the per-IP limit: 429 with Retry-After, never cached', async (t) => {
  const { db, reads } = countingDb();
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
  assert.equal(reads.n, 0);
});
