import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  CARD_BUSY_RETRY_AFTER_S,
  REGISTRATION_LIVE,
  registerShortLinks,
  type CardFields,
} from '../server/base/identity/short-links.js';
import { add, setup, shortOf } from './on-base-fixture.js';

// A crawler past the per-IP limit, or a database that was briefly too busy, made /a/<id> answer
// 404 for agents that exist (14 Oct 2026). A registry explorer reads 404 as an agent that is gone;
// only a card that is really missing may say so.

async function serve(
  t: test.TestContext,
  deps: {
    limit?: () => Promise<void>;
    card?: (agentId: string, origin: string) => Promise<CardFields | null>;
  },
): Promise<{ app: FastifyInstance; short: string }> {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 4711 });
  const app = Fastify();
  t.after(() => app.close());
  registerShortLinks(app, {
    db,
    originOf: () => 'https://centralcity.ai',
    card: deps.card ?? (async () => ({ name: 'Harbor', supportedInterfaces: [] })),
    ...(deps.limit ? { limit: deps.limit } : {}),
  });
  return { app, short: shortOf(1) };
}

const limited = (retryAfterMs?: number) => async () => {
  throw Object.assign(new Error('Too many requests. Try again later.'), {
    statusCode: 429,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
};

test('/a/<id>: over the per-IP limit is 429 with Retry-After, never 404', async (t) => {
  const { app, short } = await serve(t, { limit: limited(41_200) });
  for (const accept of [undefined, '*/*', 'application/json']) {
    const response = await app.inject({
      url: `/a/${short}`,
      headers: accept ? { accept } : {},
    });
    assert.equal(response.statusCode, 429, String(accept));
    assert.equal(response.headers['retry-after'], '42');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['vercel-cdn-cache-control'], undefined);
    assert.equal(response.headers.vary, 'Accept');
    assert.deepEqual(response.json(), { error: 'Too many requests. Try again later.' });
  }
});

test('/a/<id>: a 429 without a usable retry time still tells the client when to come back', async (t) => {
  const { app, short } = await serve(t, { limit: limited() });
  const response = await app.inject({ url: `/a/${short}` });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['retry-after'], '60');
});

test('/a/<id>: a limiter that fails (its database) is 503 busy, never 404', async (t) => {
  const { app, short } = await serve(t, {
    limit: async () => {
      throw new Error('timeout exceeded when trying to connect');
    },
  });
  const response = await app.inject({ url: `/a/${short}` });
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], String(CARD_BUSY_RETRY_AFTER_S));
});

test('/a/<id>: a card lookup that fails (the pool had no connection in time) is 503, never 404', async (t) => {
  const { app, short } = await serve(t, {
    card: async () => {
      throw new Error('timeout exceeded when trying to connect');
    },
  });
  const response = await app.inject({ url: `/a/${short}` });
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], String(CARD_BUSY_RETRY_AFTER_S));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['vercel-cdn-cache-control'], undefined);
  assert.deepEqual(response.json(), { error: 'Busy. Try again in a moment.' });
});

test('/a/<id>: an agent with no public card is still 404', async (t) => {
  const { app, short } = await serve(t, { card: async () => null });
  const response = await app.inject({ url: `/a/${short}` });
  assert.equal(response.statusCode, 404);
  assert.equal(response.headers['retry-after'], undefined);
  assert.notEqual(response.headers['cache-control'], REGISTRATION_LIVE);
  assert.deepEqual(response.json(), { error: 'Not found.' });
});

test('/a/<id>: a public card still gets the registration file, cached as before', async (t) => {
  const { app, short } = await serve(t, {});
  const response = await app.inject({ url: `/a/${short}` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], REGISTRATION_LIVE);
  assert.equal(response.headers['retry-after'], undefined);
});
