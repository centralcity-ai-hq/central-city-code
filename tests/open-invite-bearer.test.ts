import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { rpcResult } from './oauth-helpers.js';
import { sessionPair } from './session-cookie-pair.js';
process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-open-invite-bearer-test-root-secret';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
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
    name: 'Bearer host',
    password: 'Synthetic bearer test password',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const host = {
    cookie: sessionPair(registered.cookies),
  };
  const agent = await post(
    '/api/agents',
    { name: 'Host', capability: 'research', mode: 'hosted' },
    host,
  );
  assert.equal(agent.statusCode, 201, agent.body);
  const room = await post(
    '/api/rooms',
    { name: 'Bearer room', agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
    host,
  );
  assert.equal(room.statusCode, 201, room.body);
  const link = await post('/api/links', { target: 'room', room_id: room.json().room.id }, host);
  assert.equal(link.statusCode, 201, link.body);
  return { app, url: link.json().url as string };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function call(f: Fixture, name: string, args: unknown, authorization?: string) {
  const response = await f.app.inject({
    method: 'POST',
    url: '/mcp/open',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: 'centralcity.ai',
      'x-forwarded-proto': 'https',
      ...(authorization ? { authorization } : {}),
    },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: args === undefined ? { name } : { name, arguments: args },
    },
    remoteAddress: '203.0.113.12',
  });
  assert.equal(response.statusCode, 200, response.body);
  return { result: rpcResult(response.body).result, body: response.body };
}
const errorCode = (result: any) => JSON.parse(result.content[0].text).error.code as string;

async function join(f: Fixture) {
  const { result } = await call(f, 'city_join_invite', {
    invite_link: f.url,
    name: 'Bearer AI',
    idempotency_key: randomUUID(),
  });
  assert.ok(result && !result.isError, JSON.stringify(result));
  return result.structuredContent.room_credential as string;
}

test('/mcp/open: Authorization: Bearer crc_ works as the room_credential of the room tools', async (t) => {
  const f = await fixture(t);
  const credential = await join(f);
  const bearer = `Bearer ${credential}`;
  const posted = await call(
    f,
    'city_room_post',
    { text: 'via header', idempotency_key: randomUUID() },
    bearer,
  );
  assert.ok(!posted.result.isError, posted.body);
  const seq = posted.result.structuredContent.message.seq as number;
  const read = await call(f, 'city_room_read', { since: seq - 1 }, bearer);
  assert.ok(!read.result.isError, read.body);
  assert.ok(read.result.structuredContent.messages.some((m: any) => m.seq === seq));
  // No arguments object at all is fine too.
  const members = await call(f, 'city_room_members', undefined, bearer);
  assert.ok(!members.result.isError, members.body);
  // Anonymous tools are unaffected by the header.
  const templates = await call(f, 'city_list_templates', {}, bearer);
  assert.ok(!templates.result.isError, templates.body);
});

test('/mcp/open: an explicit room_credential argument wins over the header', async (t) => {
  const f = await fixture(t);
  const credential = await join(f);
  const wrong = `crc_${'A'.repeat(43)}`;
  const withWrongArgument = await call(
    f,
    'city_room_read',
    { room_credential: wrong },
    `Bearer ${credential}`,
  );
  assert.ok(withWrongArgument.result.isError, withWrongArgument.body);
  const withWrongHeader = await call(
    f,
    'city_room_read',
    { room_credential: credential },
    `Bearer ${wrong}`,
  );
  assert.ok(!withWrongHeader.result.isError, withWrongHeader.body);
  // A wrong header alone fails exactly as a wrong argument does, and is never echoed.
  const headerOnly = await call(f, 'city_room_read', {}, `Bearer ${wrong}`);
  const argumentOnly = await call(f, 'city_room_read', { room_credential: wrong });
  assert.ok(headerOnly.result.isError);
  assert.equal(errorCode(headerOnly.result), errorCode(argumentOnly.result));
  assert.ok(!headerOnly.body.includes(wrong));
});

test('/mcp/open: other bearer tokens stay ignored', async (t) => {
  const f = await fixture(t);
  await join(f);
  const { result, body } = await call(f, 'city_room_read', {}, `Bearer ccw_${'B'.repeat(43)}`);
  assert.ok(result.isError, body);
  assert.equal(errorCode(result), 'room_credential_required');
});

test('the room-invite /j JSON carries the stateless call as data and a correct mcp block', async (t) => {
  const f = await fixture(t);
  const path = new URL(f.url).pathname;
  const response = await f.app.inject({
    method: 'GET',
    url: `${path}?format=json`,
    headers: { host: 'centralcity.ai', 'x-forwarded-proto': 'https' },
  });
  assert.equal(response.statusCode, 200, response.body);
  const doc = response.json();
  assert.equal(doc.stateless.endpoint, 'https://centralcity.ai/mcp/open');
  assert.equal(doc.stateless.tool, 'city_join_invite');
  assert.equal(doc.stateless.arguments.invite_link, f.url);
  assert.deepEqual(Object.keys(doc.stateless.arguments).sort(), [
    'idempotency_key',
    'invite_link',
    'name',
  ]);
  assert.equal(doc.stateless.then.tool, 'city_room_post');
  assert.equal(doc.mcp.url, 'https://centralcity.ai/mcp/open');
  assert.match(doc.mcp.authentication, /room_credential argument/);
  assert.match(doc.mcp.authentication, /Bearer <room_credential>/);
  assert.ok(!/redemption/.test(doc.mcp.authentication));
  assert.ok(doc.mcp.tools.includes('city_join_invite'));
  assert.match(doc.stateless_agents, /Authorization: Bearer <room_credential>/);
  // The structured call works exactly as given.
  const { result } = await call(f, doc.stateless.tool, {
    ...doc.stateless.arguments,
    name: 'Structured AI',
    idempotency_key: randomUUID(),
  });
  assert.ok(!result.isError, JSON.stringify(result));
});
