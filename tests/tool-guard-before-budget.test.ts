import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { proposalsListInput } from '../server/rooms/repos/proposal-contract.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';

/**
 * A credential without the right (here a read-only workspace key) is refused before anything else:
 * it can't spend the workspace's send or connection-request budget, and a replay of an existing
 * connection request doesn't show it the row. Synthetic data.
 */
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-tool-guard-test-root-secret';
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
type App = Awaited<ReturnType<typeof createApp>>;

let address = 1;
async function owner(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${address++}.90`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: JSON.stringify({ name: `${name} person`, password: 'Synthetic co-owner password' }),
    remoteAddress: `198.51.${address++}.91`,
  });
  assert.equal(person.statusCode, 201, person.body);
  const cookie = `cc_session=${person.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const scoped = { ...headers, cookie, 'x-city-workspace': id };
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/workspaces/claim',
    headers: { ...headers, cookie },
    payload: JSON.stringify({ claim_token: res.json().claim_token }),
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const mint = async (label: string, scopes: readonly string[]) => {
    const minted = await app.inject({
      method: 'POST',
      url: '/api/workspace-keys',
      headers: scoped,
      payload: JSON.stringify({ label, scopes }),
    });
    assert.equal(minted.statusCode, 201, minted.body);
    return minted.json().workspace_key as string;
  };
  return {
    scoped,
    key: await mint('full', ASSISTANT_SCOPES),
    readOnly: await mint('read only', ['workspace:read']),
  };
}

const tool = (app: App, key: string, name: string, args: unknown) =>
  app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...headers, authorization: `Bearer ${key}` },
    payload: JSON.stringify(args),
  });

async function agent(app: App, key: string, name: string) {
  const res = await tool(app, key, 'city_create_agent', {
    name,
    description: 'Guard test agent.',
    capability: 'research',
    mode: 'external',
    idempotencyKey: randomUUID(),
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().agent.id as string;
}

test('a read-only key spends no budget and gets no replay', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const a = await owner(app, 'Guard A');
  const b = await owner(app, 'Guard B');
  const [a1, a2, b1, b2] = [
    await agent(app, a.key, 'a one'),
    await agent(app, a.key, 'a two'),
    await agent(app, b.key, 'b one'),
    await agent(app, b.key, 'b two'),
  ];
  const invite = async (to: string) =>
    (await tool(app, b.key, 'city_create_invite', { agent_id: to })).json().invite_token as string;

  // A request that exists: its replay is the owner's, not a read-only credential's.
  const args = { from_agent_id: a1, invite_token: await invite(b1), idempotency_key: randomUUID() };
  const made = await tool(app, a.key, 'city_request_connection', args);
  assert.equal(made.statusCode, 200, made.body);
  const replay = await tool(app, a.readOnly, 'city_request_connection', args);
  assert.equal(replay.statusCode, 403, replay.body);
  assert.equal(replay.json().request, undefined);

  // Over both budgets (20 requests a day, 60 sends a minute): all refused, none charged.
  for (let i = 0; i < 21; i++) {
    const res = await tool(app, a.readOnly, 'city_request_connection', {
      from_agent_id: a1,
      to_agent_id: randomUUID(),
      idempotency_key: randomUUID(),
    });
    assert.equal(res.statusCode, 403, res.body);
  }
  const connected = await app.inject({
    method: 'POST',
    url: '/api/connections',
    headers: a.scoped,
    payload: JSON.stringify({ fromAgentId: a1, toAgentId: a2 }),
  });
  assert.ok(connected.statusCode < 300, connected.body);
  for (let i = 0; i < 61; i++) {
    const res = await tool(app, a.readOnly, 'city_send_message', {
      from_agent_id: a1,
      to_agent_id: a2,
      text: 'hello',
      idempotency_key: randomUUID(),
    });
    assert.equal(res.statusCode, 403, res.body);
  }
  const send = await tool(app, a.key, 'city_send_message', {
    from_agent_id: a1,
    to_agent_id: a2,
    text: 'hello',
    idempotency_key: randomUUID(),
  });
  assert.equal(send.statusCode, 200, send.body);
  const request = await tool(app, a.key, 'city_request_connection', {
    from_agent_id: a2,
    invite_token: await invite(b2),
    idempotency_key: randomUUID(),
  });
  assert.equal(request.statusCode, 200, request.body);
});

test('text the database cannot store is a 400, never a 500', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const a = await owner(app, 'Text A');
  const [a1, a2] = [await agent(app, a.key, 'a one'), await agent(app, a.key, 'a two')];
  const connected = await app.inject({
    method: 'POST',
    url: '/api/connections',
    headers: a.scoped,
    payload: JSON.stringify({ fromAgentId: a1, toAgentId: a2 }),
  });
  assert.ok(connected.statusCode < 300, connected.body);
  const send = (extra: Record<string, unknown>) =>
    tool(app, a.key, 'city_send_message', {
      from_agent_id: a1,
      to_agent_id: a2,
      idempotency_key: randomUUID(),
      ...extra,
    });
  const half = 'abcdefgh\ud83d';
  for (const extra of [
    { text: half },
    { text: 'hello', idempotency_key: 'ab\u0000cdefghij' },
    { text: 'hello', idempotency_key: half },
    { parts: [{ type: 'data', data: { [half]: 1 } }] },
  ]) {
    const res = await send(extra);
    assert.equal(res.statusCode, 400, `${JSON.stringify(extra)}: ${res.body}`);
  }
  const key = await app.inject({
    method: 'POST',
    url: '/api/workspace-keys',
    headers: a.scoped,
    payload: JSON.stringify({ label: 'x\u0000y', scopes: ['workspace:read'] }),
  });
  assert.equal(key.statusCode, 400, key.body);
  const list = await app.inject({
    method: 'GET',
    url: '/api/messages/conversations?agent_id=a%00b',
    headers: a.scoped,
  });
  assert.equal(list.statusCode, 400, list.body);
  // A whole emoji is fine.
  const ok = await send({ text: 'hello 😀' });
  assert.equal(ok.statusCode, 200, ok.body);
});

test('every tool refuses a read-only key before charging: rooms too', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const a = await owner(app, 'Rooms A');
  const a1 = await agent(app, a.key, 'a one');
  const args = () => ({
    agent_id: a1,
    name: 'Guard room',
    idempotency_key: randomUUID(),
  });
  // Rooms a day: 20. A read-only key spends none of them.
  for (let i = 0; i < 21; i++) {
    const res = await tool(app, a.readOnly, 'city_create_room', args());
    assert.equal(res.statusCode, 403, res.body);
  }
  const made = await tool(app, a.key, 'city_create_room', args());
  assert.equal(made.statusCode, 200, made.body);
});

test('no tool passes text the database cannot store on to its service', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const a = await owner(app, 'Input A');
  const a1 = await agent(app, a.key, 'a one');
  for (const [name, args] of [
    ['city_ask', { agent_id: a1, question: 'ab\u0000cd' }],
    ['city_room_search', { room_id: 'some-room', q: 'ab\u0000cd' }],
    ['city_publish_result', { agent_id: a1, text: 'ab\ud800cd' }],
    [
      'city_create_agent',
      {
        name: 'ab\ud800cd',
        description: 'x',
        capability: 'research',
        mode: 'external',
        idempotencyKey: randomUUID(),
      },
    ],
  ] as const) {
    const res = await tool(app, a.key, name, args);
    assert.equal(res.statusCode, 400, `${name}: ${res.body}`);
  }
  const big = proposalsListInput.safeParse({ room_id: 'some-room', before: 2147483648 });
  assert.equal(big.success, false);
});

test('rotating a credential cancels the enrollment code; REST refuses text it cannot store', async (t) => {
  process.env.CITY_ELRIC = '1';
  t.after(() => {
    delete process.env.CITY_ELRIC;
  });
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const a = await owner(app, 'Rotate A');
  const made = await tool(app, a.key, 'city_create_agent', {
    manifest: {
      apiVersion: 'centralcity.agent/v1',
      kind: 'Agent',
      metadata: { name: 'runner' },
      spec: { capabilities: ['research'], runtime: { mode: 'external' } },
    },
    idempotency_key: randomUUID(),
  });
  assert.equal(made.statusCode, 200, made.body);
  const { agent: created, enrollment } = made.json();
  assert.ok(enrollment?.enrollment_code, made.body);
  const rotated = await app.inject({
    method: 'POST',
    url: `/api/agents/${created.id}/rotate-credential`,
    headers: a.scoped,
    payload: '{}',
  });
  assert.equal(rotated.statusCode, 200, rotated.body);
  const late = await app.inject({
    method: 'POST',
    url: '/api/runtime/enroll',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ agent_id: created.id, enrollment_code: enrollment.enrollment_code }),
  });
  assert.equal(late.statusCode, 401, late.body);
  for (const url of ['/api/elric/turns?room_id=%00']) {
    const res = await app.inject({ method: 'GET', url, headers: a.scoped });
    assert.equal(res.statusCode, 400, `${url}: ${res.body}`);
  }
});
