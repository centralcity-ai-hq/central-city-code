import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { rpcResult } from './oauth-helpers.js';
import { sessionPair } from './session-cookie-pair.js';

/**
 * Room history setting over the console REST route and the invited-AI path (/mcp/open
 * city_join_invite): new rooms default to 'full', the host changes it with
 * POST /api/rooms/:room/settings, and an invited AI is told whether it can read earlier messages.
 * The MCP host tool (city_room_update) is covered in tests/rooms.test.ts. Synthetic data only.
 */
process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-room-history-test-root-secret';
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
  let address = 10;
  const post = (url: string, body: unknown, extra = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress: `203.0.113.${address}`,
    });
  const person = async (name: string) => {
    address++;
    const registered = await post('/api/auth/register', {
      name,
      password: 'Synthetic room history password',
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = sessionPair(registered.cookies);
    const agent = await post(
      '/api/agents',
      { name: `${name} desk`, capability: 'research', mode: 'hosted' },
      { cookie },
    );
    assert.equal(agent.statusCode, 201, agent.body);
    return { cookie, agentId: agent.json().agent.id as string };
  };
  const rpc = async (method: string, params: unknown) => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp/open',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: 'centralcity.ai',
        'x-forwarded-proto': 'https',
      },
      payload: { jsonrpc: '2.0', id: 1, method, params },
      remoteAddress: `203.0.113.${++address}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    return rpcResult(response.body).result;
  };
  return { app, post, person, rpc };
}

test('REST: new rooms default to full; the host changes history; others are refused', async (t) => {
  const { post, person } = await fixture(t);
  const host = await person('History host');
  const member = await person('History member');
  const created = await post(
    '/api/rooms',
    { agent_id: host.agentId, name: 'Tea room', idempotency_key: randomUUID() },
    { cookie: host.cookie },
  );
  assert.equal(created.statusCode, 201, created.body);
  const room = created.json().room;
  assert.equal(room.history, 'full');
  const settings = `/api/rooms/${room.id}/settings`;

  // Not a member: the room does not exist for it. A member that is not the host: 403.
  const outsider = await post(settings, { history: 'from_join' }, { cookie: member.cookie });
  assert.equal(outsider.statusCode, 404, outsider.body);
  const joined = await post(
    `/api/rooms/${room.id}/join`,
    {
      token: created.json().link.link.split('#')[1],
      agent_id: member.agentId,
      idempotency_key: randomUUID(),
    },
    { cookie: member.cookie },
  );
  assert.equal(joined.statusCode, 200, joined.body);
  const refused = await post(settings, { history: 'from_join' }, { cookie: member.cookie });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().code, 'host_required');
  // Only known fields and values.
  assert.equal((await post(settings, { history: 'all' }, { cookie: host.cookie })).statusCode, 400);
  assert.equal(
    (await post(settings, { history: 'full', name: 'x' }, { cookie: host.cookie })).statusCode,
    400,
  );

  const changed = await post(settings, { history: 'from_join' }, { cookie: host.cookie });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().changed, true);
  assert.equal(changed.json().room.history, 'from_join');
  const again = await post(settings, { history: 'full' }, { cookie: host.cookie });
  assert.equal(again.json().room.history, 'full');
  assert.equal(again.json().changed, true);
});

test('invited AI: city_join_invite says whether earlier messages are readable', async (t) => {
  const { post, person, rpc } = await fixture(t);
  const host = await person('Invite host');
  const created = await post(
    '/api/rooms',
    { agent_id: host.agentId, name: 'Tea room', idempotency_key: randomUUID() },
    { cookie: host.cookie },
  );
  assert.equal(created.statusCode, 201, created.body);
  const roomId = created.json().room.id as string;
  for (const text of ['We agreed on green tea.', 'Hazel brings the cups.'])
    assert.equal(
      (
        await post(
          `/api/rooms/${roomId}/messages`,
          { text, idempotency_key: randomUUID() },
          { cookie: host.cookie },
        )
      ).statusCode,
      201,
    );
  const invite = async () => {
    const link = await post(
      '/api/links',
      { target: 'room', room_id: roomId },
      { cookie: host.cookie },
    );
    assert.equal(link.statusCode, 201, link.body);
    return link.json().url as string;
  };

  // Full (the default): the invited AI is told to read from the start, and it can.
  const tools = (await rpc('tools/list', {})) as {
    tools: Array<{ name: string; description: string }>;
  };
  const readTool = tools.tools.find((tool) => tool.name === 'city_room_read')!;
  assert.match(readTool.description, /messages posted before you joined/);
  const first = (await rpc('tools/call', {
    name: 'city_join_invite',
    arguments: { invite_link: await invite(), name: 'Hazel' },
  })) as { isError?: boolean; structuredContent: Record<string, string> };
  assert.ok(!first.isError, JSON.stringify(first));
  assert.equal(first.structuredContent.history, 'full');
  assert.match(first.structuredContent.next_step!, /the conversation from the start/);
  const read = (await rpc('tools/call', {
    name: 'city_room_read',
    arguments: { room_credential: first.structuredContent.room_credential },
  })) as { structuredContent: { messages: Array<{ text: string }> } };
  assert.deepEqual(
    read.structuredContent.messages.map((m) => m.text),
    ['We agreed on green tea.', 'Hazel brings the cups.'],
  );

  // from_join: a later invited AI is told it starts at its join.
  const changed = await post(
    `/api/rooms/${roomId}/settings`,
    { history: 'from_join' },
    { cookie: host.cookie },
  );
  assert.equal(changed.statusCode, 200, changed.body);
  const second = (await rpc('tools/call', {
    name: 'city_join_invite',
    arguments: { invite_link: await invite(), name: 'Latecomer' },
  })) as { isError?: boolean; structuredContent: Record<string, string> };
  assert.ok(!second.isError, JSON.stringify(second));
  assert.equal(second.structuredContent.history, 'from_join');
  assert.match(second.structuredContent.next_step!, /messages since you joined/);
});
