import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-test-only-rate-limit-secret-0000';
process.env.CITY_ROOM_TASKS = '1';

/**
 * A NUL character in a room post, a message part, a room topic or a task body is refused with a
 * 400 at validation. The database cannot store NUL in text or jsonb, so without the check the
 * write failed and the caller saw a plain 500.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const NUL = String.fromCharCode(0);

function tool(app: App, key: string, name: string, args: unknown = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify(args),
  });
}
async function ok(app: App, key: string, name: string, args: unknown = {}) {
  const res = await tool(app, key, name, args);
  assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
  return res.json();
}

async function hostKey(app: App): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'NUL host', idempotency_key: randomUUID() }),
    remoteAddress: '203.0.113.7',
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'NUL co-owner', password: 'Plain test password for NUL' }),
    remoteAddress: '203.0.113.21',
  });
  assert.equal(person.statusCode, 201, person.body);
  const cookie = `cc_session=${person.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/workspaces/claim',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ claim_token: res.json().claim_token }),
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const minted = await app.inject({
    method: 'POST',
    url: '/api/workspace-keys',
    headers: { ...jsonHeaders, cookie, 'x-city-workspace': id },
    payload: JSON.stringify({ label: 'room host', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return minted.json().workspace_key as string;
}

test('a NUL character in room text, parts, topic or task body is a 400, never a 500', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const key = await hostKey(app);
  const agentId = (
    await ok(app, key, 'city_create_agent', {
      name: 'Host',
      description: 'Room host',
      capability: 'research',
      mode: 'external',
      idempotencyKey: randomUUID(),
    })
  ).agent.id as string;

  const badTopic = await tool(app, key, 'city_create_room', {
    agent_id: agentId,
    name: 'NUL room',
    topic: `a${NUL}b`,
    idempotency_key: randomUUID(),
  });
  assert.equal(badTopic.statusCode, 400, badTopic.body);

  const created = await ok(app, key, 'city_create_room', {
    agent_id: agentId,
    name: 'NUL room',
    idempotency_key: randomUUID(),
  });
  const roomId = created.room.id as string;
  const post = (body: object) =>
    tool(app, key, 'city_room_post', { room_id: roomId, idempotency_key: randomUUID(), ...body });

  for (const body of [
    { text: `hi${NUL}there` },
    { parts: [{ type: 'text', text: `hi${NUL}there` }] },
    { parts: [{ type: 'data', data: { k: `a${NUL}b` } }] },
    { parts: [{ type: 'data', data: { [`k${NUL}`]: 'v' } }] },
    { parts: [{ type: 'data', data: [[`deep${NUL}`]] }] },
  ]) {
    const res = await post(body);
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)}: ${res.body}`);
  }

  const badTask = await tool(app, key, 'city_room_task_create', {
    room_id: roomId,
    agent_id: agentId,
    title: 'Task',
    body: `x${NUL}y`,
    idempotency_key: randomUUID(),
  });
  assert.equal(badTask.statusCode, 400, badTask.body);

  // Ordinary text, data and topics still work.
  assert.equal((await post({ text: 'hi there' })).statusCode, 200);
  assert.equal((await post({ parts: [{ type: 'data', data: { k: 'v' } }] })).statusCode, 200);
  await ok(app, key, 'city_room_task_create', {
    room_id: roomId,
    agent_id: agentId,
    title: 'Task',
    body: 'plain body',
    idempotency_key: randomUUID(),
  });
});
