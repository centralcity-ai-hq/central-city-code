import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { rpcResult } from './oauth-helpers.js';

// Invited guests (joined by invite link) work on their own room's tasks with the member rules.
process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_ROOM_TASKS = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-guest-tasks-test-root-secret';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};
const evidence = { kind: 'proposal', ref: 'proposal-1', revision: 'rev-1' };

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
  const post = (url: string, body: unknown, extra = {}, remoteAddress = '203.0.113.12') =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress,
    });
  const registered = await post('/api/auth/register', {
    name: 'Task host',
    password: 'Synthetic guest task test password',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const host = {
    cookie: `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`,
  };
  const agent = await post(
    '/api/agents',
    { name: 'Host', capability: 'research', mode: 'hosted' },
    host,
  );
  assert.equal(agent.statusCode, 201, agent.body);
  const makeRoom = async (name: string) => {
    const room = await post(
      '/api/rooms',
      { name, agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
      host,
    );
    assert.equal(room.statusCode, 201, room.body);
    return room.json().room.id as string;
  };
  const join = async (roomId: string, address: string) => {
    const link = await post('/api/links', { target: 'room', room_id: roomId }, host);
    assert.equal(link.statusCode, 201, link.body);
    const code = new URL(link.json().url).pathname.split('/').at(-1)!;
    const start = await post('/api/public/invites/bootstrap', { code }, {}, address);
    assert.equal(start.statusCode, 200, start.body);
    const joined = await post(
      '/api/public/invites/redeem',
      { code, handle: start.json().handle, name: 'Invited AI' },
      {},
      address,
    );
    assert.equal(joined.statusCode, 200, joined.body);
    return joined.json() as { credential: string; agent_id: string; room_id: string };
  };
  const invoke = (credential: string, tool: string, args: unknown = {}) =>
    post(`/api/public/invites/tools/${tool}`, args, { authorization: `Bearer ${credential}` });
  return { app, post, host, makeRoom, join, invoke };
}

test('an invited guest creates, claims and completes a task in its own room', async (t) => {
  const f = await fixture(t);
  const roomId = await f.makeRoom('Guest task room');
  const guest = await f.join(roomId, '203.0.113.21');
  const created = await f.invoke(guest.credential, 'city_room_task_create', {
    title: 'Summarise the thread',
    body: 'One paragraph.',
    idempotency_key: randomUUID(),
  });
  assert.equal(created.statusCode, 200, created.body);
  const task = created.json().task;
  assert.equal(task.room_id, roomId);
  assert.equal(task.created_by_agent_id, guest.agent_id);
  const listed = await f.invoke(guest.credential, 'city_room_task_list');
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().tasks.length, 1);
  const claimed = await f.invoke(guest.credential, 'city_room_task_claim', {
    task_id: task.id,
    idempotency_key: randomUUID(),
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const token = claimed.json().claim_token;
  const renewed = await f.invoke(guest.credential, 'city_room_task_renew', {
    task_id: task.id,
    claim_token: token,
  });
  assert.equal(renewed.statusCode, 200, renewed.body);
  const result = await f.invoke(guest.credential, 'city_room_task_result', {
    task_id: task.id,
    claim_token: token,
    evidence,
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().task.status, 'in_review');
  // Review stays host-only: the guest is refused, the host approves.
  const selfReview = await f.invoke(guest.credential, 'city_room_task_review', {
    task_id: task.id,
    decision: 'approve',
  });
  assert.equal(selfReview.statusCode, 403, selfReview.body);
  assert.match(selfReview.json().error, /Only the room host/);
  const approved = await f.post(
    `/api/rooms/${roomId}/tasks/${task.id}/update`,
    { decision: 'approve' },
    f.host,
  );
  assert.equal(approved.statusCode, 200, approved.body);
  const done = await f.invoke(guest.credential, 'city_room_task_get', { task_id: task.id });
  assert.equal(done.json().task.status, 'done');
  const events = await f.invoke(guest.credential, 'city_room_task_events', { task_id: task.id });
  assert.equal(events.statusCode, 200, events.body);
  assert.ok(events.json().events.length >= 4);
});

test('a guest cannot reach another room or its tasks', async (t) => {
  const f = await fixture(t);
  const mine = await f.makeRoom('Guest room');
  const other = await f.makeRoom('Other room');
  const guest = await f.join(mine, '203.0.113.22');
  const foreign = await f.post(
    `/api/rooms/${other}/tasks`,
    { title: 'Host only task', idempotency_key: randomUUID() },
    f.host,
  );
  assert.equal(foreign.statusCode, 201, foreign.body);
  const taskId = foreign.json().task.id;
  const crossList = await f.invoke(guest.credential, 'city_room_task_list', { room_id: other });
  assert.equal(crossList.statusCode, 403, crossList.body);
  const crossGet = await f.invoke(guest.credential, 'city_room_task_get', { task_id: taskId });
  assert.equal(crossGet.statusCode, 404, crossGet.body);
  const crossClaim = await f.invoke(guest.credential, 'city_room_task_claim', {
    task_id: taskId,
    idempotency_key: randomUUID(),
  });
  assert.equal(crossClaim.statusCode, 404, crossClaim.body);
  const otherAgent = await f.invoke(guest.credential, 'city_room_task_create', {
    agent_id: randomUUID(),
    title: 'As someone else',
    idempotency_key: randomUUID(),
  });
  assert.equal(otherAgent.statusCode, 403, otherAgent.body);
});

test('with room tasks off, guests get no task tools', async (t) => {
  const f = await fixture(t);
  const roomId = await f.makeRoom('Tasks off room');
  const guest = await f.join(roomId, '203.0.113.23');
  process.env.CITY_ROOM_TASKS = '0';
  try {
    const refused = await f.invoke(guest.credential, 'city_room_task_create', {
      title: 'Nope',
      idempotency_key: randomUUID(),
    });
    assert.equal(refused.statusCode, 404, refused.body);
    assert.match(refused.json().error, /Unknown guest tool/);
    const list = await mcpList(f.app);
    assert.ok(!list.some((name: string) => name.startsWith('city_room_task_')));
  } finally {
    process.env.CITY_ROOM_TASKS = '1';
  }
});

test('guests are never offered the peer review tools', async (t) => {
  const f = await fixture(t);
  const roomId = await f.makeRoom('Peer review guest room');
  const guest = await f.join(roomId, '203.0.113.25');
  const list = await mcpList(f.app);
  assert.ok(list.includes('city_room_task_list'));
  for (const name of ['city_room_task_request_review', 'city_room_task_peer_review']) {
    assert.ok(!list.includes(name), `${name} is not on /mcp/open`);
    const refused = await f.invoke(guest.credential, name, {});
    assert.equal(refused.statusCode, 404, refused.body);
    assert.match(refused.json().error, /Unknown guest tool/);
  }
});

async function mcpList(app: Awaited<ReturnType<typeof createApp>>) {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp/open',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: 'centralcity.ai',
      'x-forwarded-proto': 'https',
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    remoteAddress: '203.0.113.12',
  });
  assert.equal(response.statusCode, 200, response.body);
  return rpcResult(response.body).result.tools.map((x: { name: string }) => x.name);
}

test('an /mcp/open guest sees the task tools and uses them with its credential', async (t) => {
  const f = await fixture(t);
  const roomId = await f.makeRoom('Open MCP room');
  const guest = await f.join(roomId, '203.0.113.24');
  const response = await f.app.inject({
    method: 'POST',
    url: '/mcp/open',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: 'centralcity.ai',
      'x-forwarded-proto': 'https',
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    remoteAddress: '203.0.113.12',
  });
  const tools = rpcResult(response.body).result.tools as {
    name: string;
    inputSchema: { properties: Record<string, unknown> };
  }[];
  for (const name of [
    'city_room_task_list',
    'city_room_task_get',
    'city_room_task_create',
    'city_room_task_claim',
    'city_room_task_renew',
    'city_room_task_release',
    'city_room_task_result',
    'city_room_task_events',
    'city_room_task_review',
    'city_room_task_templates',
  ]) {
    const tool = tools.find((x) => x.name === name);
    assert.ok(tool, name);
    assert.ok(tool.inputSchema.properties.room_credential, `${name} takes room_credential`);
    assert.ok(!tool.inputSchema.properties.room_id, `${name} has no room_id`);
  }
  const called = await f.app.inject({
    method: 'POST',
    url: '/mcp/open',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: 'centralcity.ai',
      'x-forwarded-proto': 'https',
    },
    payload: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'city_room_task_create',
        arguments: {
          room_credential: guest.credential,
          title: 'From open MCP',
          idempotency_key: randomUUID(),
        },
      },
    },
    remoteAddress: '203.0.113.12',
  });
  const result = rpcResult(called.body).result;
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(result.structuredContent.task.room_id, roomId);
});

test('a guest reads the task template catalog, with or without its room id', async (t) => {
  const f = await fixture(t);
  const roomId = await f.makeRoom('Template room');
  const guest = await f.join(roomId, '203.0.113.25');
  const plain = await f.invoke(guest.credential, 'city_room_task_templates');
  assert.equal(plain.statusCode, 200, plain.body);
  assert.ok(Array.isArray(plain.json().templates) && plain.json().templates.length > 0);
  const withRoom = await f.invoke(guest.credential, 'city_room_task_templates', {
    room_id: roomId,
  });
  assert.equal(withRoom.statusCode, 200, withRoom.body);
  const otherRoom = await f.invoke(guest.credential, 'city_room_task_templates', {
    room_id: 'another-room',
  });
  assert.equal(otherRoom.statusCode, 403, otherRoom.body);
});
