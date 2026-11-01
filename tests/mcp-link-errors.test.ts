import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { RETRYABLE_CODES } from '../server/remote-mcp/tools.js';
import type { LinkFetchOptions, LinkTransport } from '../server/rooms/link-fetch.js';
import { rpcResult } from './oauth-helpers.js';
import { sessionPair } from './session-cookie-pair.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-link-error-test-root-not-a-real-secret';

/** Link fetch failures over MCP keep their own codes and are retryable after a wait. */

const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};

const transport: LinkTransport = async ({ url, signal }) => {
  if (url.pathname === '/slow')
    await new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  const status = url.pathname === '/missing' ? 404 : 500;
  return { status, headers: {}, body: (async function* () {})(), destroy() {} };
};
const linkFetch: LinkFetchOptions = {
  transport,
  timeMs: 200,
  resolve: async (host) => {
    if (host !== 'pages.example.com') throw new Error('NXDOMAIN');
    return [{ address: '93.184.215.14', family: 4 }];
  },
};

test('link_timeout and link_fetch_failed over /mcp/open are retryable with retry_after_ms', async (t) => {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
    linkFetch,
  });
  t.after(() => app.close());
  const post = (url: string, body: unknown, extra = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress: '203.0.113.12',
    });
  const registered = await post('/api/auth/register', {
    name: 'Link error host',
    password: 'Synthetic link error test password',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const host = { cookie: sessionPair(registered.cookies) };
  const agent = await post(
    '/api/agents',
    { name: 'Host', capability: 'research', mode: 'hosted' },
    host,
  );
  assert.equal(agent.statusCode, 201, agent.body);
  const room = await post(
    '/api/rooms',
    { name: 'Link error room', agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
    host,
  );
  assert.equal(room.statusCode, 201, room.body);
  const roomId = room.json().room.id as string;
  const link = await post('/api/links', { target: 'room', room_id: roomId }, host);
  assert.equal(link.statusCode, 201, link.body);
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;

  const call = async (name: string, args: unknown) => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp/open',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: 'centralcity.ai',
        'x-forwarded-proto': 'https',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      remoteAddress: '203.0.113.12',
    });
    assert.equal(response.statusCode, 200, response.body);
    return rpcResult(response.body).result;
  };
  const joined = await call('city_join_invite', {
    invite_link: `https://centralcity.ai/j/${code}`,
    name: 'Link error AI',
  });
  assert.ok(!joined.isError, JSON.stringify(joined));
  const credential = joined.structuredContent.room_credential as string;

  for (const [url, expected] of [
    ['https://pages.example.com/slow', 'link_timeout'],
    ['https://pages.example.com/broken', 'link_fetch_failed'],
    ['https://nowhere.example.com/', 'link_fetch_failed'],
  ] as const) {
    const result = await call('city_room_link_save', {
      room_credential: credential,
      url,
    });
    assert.equal(result.isError, true, JSON.stringify(result));
    const { error } = JSON.parse(result.content[0].text);
    assert.equal(error.code, expected, JSON.stringify(error));
    assert.equal(error.retryable, true);
    assert.equal(error.retry_after_ms, 30_000);
    assert.match(error.message, /city_room_file_put/);
    assert.notEqual(error.message, 'The operation could not be completed.');
    if (url.endsWith('/broken')) assert.match(error.message, /HTTP 500/);
  }

  // An upstream 4xx keeps the code but is not retryable: the URL needs a change.
  const missing = await call('city_room_link_save', {
    room_credential: credential,
    url: 'https://pages.example.com/missing',
  });
  assert.equal(missing.isError, true, JSON.stringify(missing));
  const { error } = JSON.parse(missing.content[0].text);
  assert.equal(error.code, 'link_fetch_failed', JSON.stringify(error));
  assert.equal(error.retryable, false);
  assert.equal(error.retry_after_ms, undefined);
  assert.match(error.message, /HTTP 404/);
  assert.match(error.message, /check the URL/);
});

test('storage_full is not retryable (a global ceiling that does not clear quickly)', () => {
  assert.equal(RETRYABLE_CODES.has('storage_full'), false);
  assert.equal(RETRYABLE_CODES.has('room_storage_full'), false);
});
