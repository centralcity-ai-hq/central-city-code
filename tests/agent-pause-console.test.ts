import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, type App } from './oauth-helpers.js';

/**
 * My agents' Pause / Resume (POST /api/agents/:id/pause | resume): the same change as
 * city_control on one agent, without the cascade. Owner only, audit event, idempotent, removed
 * agents refused. Synthetic data only.
 */
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

function api(app: App, cookie: string, url: string, body: unknown = {}, method = 'POST') {
  return app.inject({
    method: method as 'POST' | 'GET',
    url,
    headers: { ...jsonHeaders, cookie },
    ...(method === 'GET' ? {} : { payload: JSON.stringify(body) }),
  });
}

async function agent(app: App, cookie: string, name: string, parentAgentId?: string) {
  const created = await api(app, cookie, '/api/agents', {
    name,
    capability: 'research',
    mode: 'hosted',
    ...(parentAgentId ? { parentAgentId } : {}),
  });
  assert.equal(created.statusCode, 201, created.body);
  return created.json().agent.id as string;
}

async function snapshot(app: App, cookie: string) {
  return (await api(app, cookie, '/api/snapshot', undefined, 'GET')).json() as {
    agents: { id: string; pausedAt?: string | null }[];
    events: { type: string; agentId?: string; message: string }[];
  };
}

test('pause and resume one agent: audit events, idempotent, no cascade', async (t) => {
  const { app, cookie } = await fixture(t);
  const scout = await agent(app, cookie, 'Scout');
  const other = await agent(app, cookie, 'Writer');

  const paused = await api(app, cookie, `/api/agents/${scout}/pause`);
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(paused.json().changed, true);
  assert.ok(paused.json().agent.pausedAt, 'the answer carries the paused agent');

  let state = await snapshot(app, cookie);
  assert.ok(state.agents.find((item) => item.id === scout)!.pausedAt);
  assert.ok(!state.agents.find((item) => item.id === other)!.pausedAt, 'only that one agent');
  assert.ok(
    state.events.some((event) => event.type === 'agent.paused' && event.agentId === scout),
    'audit event',
  );

  const again = await api(app, cookie, `/api/agents/${scout}/pause`);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().changed, false, 'pausing a paused agent changes nothing');

  const resumed = await api(app, cookie, `/api/agents/${scout}/resume`);
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(resumed.json().changed, true);
  state = await snapshot(app, cookie);
  assert.ok(!state.agents.find((item) => item.id === scout)!.pausedAt);
  assert.ok(
    state.events.some((event) => event.type === 'agent.resumed' && event.agentId === scout),
  );
});

test('pause: owner only, removed agents refused, no body fields', async (t) => {
  const { app, cookie } = await fixture(t);
  const scout = await agent(app, cookie, 'Scout');

  const stranger = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Stranger', password: 'correct horse battery staple 2' }),
  });
  assert.equal(stranger.statusCode, 201, stranger.body);
  const theirs = `cc_session=${stranger.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
  const refused = await api(app, theirs, `/api/agents/${scout}/pause`);
  assert.equal(refused.statusCode, 404, 'another owner cannot see the agent');
  assert.ok(!(await snapshot(app, cookie)).agents.find((item) => item.id === scout)!.pausedAt);

  assert.equal(
    (await api(app, cookie, `/api/agents/${scout}/pause`, { cascade: true })).statusCode,
    400,
  );

  assert.equal((await api(app, cookie, `/api/agents/${scout}/revoke`)).statusCode, 200);
  const removed = await api(app, cookie, `/api/agents/${scout}/pause`);
  assert.equal(removed.statusCode, 409);
});
