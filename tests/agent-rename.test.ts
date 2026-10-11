import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, type App } from './oauth-helpers.js';
import { ensureShortId } from '../server/base/identity/short-links.js';
import { ELRIC_RESERVED_NAME_MESSAGE } from '../server/elric/names.js';

/**
 * My agents' Rename (PATCH /api/agents/:id {name}): owner only (co-owned AI workspaces through
 * X-City-Workspace), the creation name rules, Elric refused, removed agents refused, audit event.
 * Rooms read the current name; a manifest agent's Agent Card shows it. Synthetic data only.
 */
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

function api(
  app: App,
  cookie: string,
  url: string,
  body: unknown = {},
  method: 'POST' | 'GET' | 'PATCH' = 'POST',
  workspace?: string,
) {
  return app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie, ...(workspace ? { 'x-city-workspace': workspace } : {}) },
    ...(method === 'GET' ? {} : { payload: JSON.stringify(body) }),
  });
}
const rename = (app: App, cookie: string, id: string, body: unknown, workspace?: string) =>
  api(app, cookie, `/api/agents/${id}`, body, 'PATCH', workspace);

async function agent(app: App, cookie: string, name: string, extra: object = {}) {
  const created = await api(app, cookie, '/api/agents', {
    name,
    capability: 'research',
    mode: 'hosted',
    ...extra,
  });
  assert.equal(created.statusCode, 201, created.body);
  return created.json().agent.id as string;
}

async function snapshot(app: App, cookie: string, workspace?: string) {
  const response = await api(app, cookie, '/api/snapshot', undefined, 'GET', workspace);
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as {
    agents: { id: string; name: string }[];
    events: { type: string; agentId?: string; message: string }[];
  };
}

async function account(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name, password: `Synthetic rename password ${name}` }),
  });
  assert.equal(res.statusCode, 201, res.body);
  return `cc_session=${res.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
}

test('rename: shows in the snapshot, records an event, same name is a no-op', async (t) => {
  const { app, cookie } = await fixture(t);
  const scout = await agent(app, cookie, 'Scout');
  const other = await agent(app, cookie, 'Writer');

  const renamed = await rename(app, cookie, scout, { name: '  Field Scout  ' });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().changed, true);
  assert.equal(renamed.json().agent.name, 'Field Scout', 'trimmed like on creation');
  assert.equal(renamed.json().agent.id, scout);

  let state = await snapshot(app, cookie);
  assert.equal(state.agents.find((item) => item.id === scout)!.name, 'Field Scout');
  assert.equal(state.agents.find((item) => item.id === other)!.name, 'Writer');
  const events = state.events.filter((item) => item.type === 'agent.renamed');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.agentId, scout);
  assert.equal(events[0]!.message, 'Renamed Scout to Field Scout.');

  const again = await rename(app, cookie, scout, { name: 'Field Scout' });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().changed, false);
  state = await snapshot(app, cookie);
  assert.equal(state.events.filter((item) => item.type === 'agent.renamed').length, 1);

  // Names need not be unique in a workspace (creation allows duplicates too).
  const twin = await rename(app, cookie, other, { name: 'Field Scout' });
  assert.equal(twin.statusCode, 200, twin.body);
});

test('rename: invalid names 400, Elric name and Elric agent refused, removed 409', async (t) => {
  const { app, cookie } = await fixture(t);
  const scout = await agent(app, cookie, 'Scout');

  for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(65) }, { name: 7 }])
    assert.equal((await rename(app, cookie, scout, body)).statusCode, 400, JSON.stringify(body));
  assert.equal(
    (await rename(app, cookie, scout, { name: 'Ok', description: 'extra' })).statusCode,
    400,
    'strict body',
  );
  assert.equal((await rename(app, cookie, scout, { name: 'x'.repeat(64) })).statusCode, 200);

  // The reserved name, while Elric is on (the same check as creation).
  const before = process.env.CITY_ELRIC;
  process.env.CITY_ELRIC = '1';
  try {
    const reserved = await rename(app, cookie, scout, { name: 'Elric' });
    assert.equal(reserved.statusCode, 409, reserved.body);
    assert.equal(reserved.json().error, ELRIC_RESERVED_NAME_MESSAGE);
  } finally {
    if (before === undefined) delete process.env.CITY_ELRIC;
    else process.env.CITY_ELRIC = before;
  }

  // Elric itself is managed by Central City.
  const elric = await agent(app, cookie, 'Marked');
  const ownerId = (await app.city.db.query<{ id: string }>('SELECT id FROM operators')).rows[0]!.id;
  await app.city.db.query(
    `INSERT INTO elric_agents(agent_id,owner_id,status,created_at,updated_at,updated_by)
     VALUES($1,$2,'active',$3,$3,'test')`,
    [elric, ownerId, Date.now()],
  );
  const managed = await rename(app, cookie, elric, { name: 'Not Elric' });
  assert.equal(managed.statusCode, 409, managed.body);
  assert.equal(managed.json().code, 'elric_managed');

  assert.equal((await api(app, cookie, `/api/agents/${scout}/revoke`)).statusCode, 200);
  const removed = await rename(app, cookie, scout, { name: 'Ghost' });
  assert.equal(removed.statusCode, 409, removed.body);
  const state = await snapshot(app, cookie);
  assert.equal(state.agents.find((item) => item.id === scout)!.name, 'x'.repeat(64));
  assert.equal(state.agents.find((item) => item.id === elric)!.name, 'Marked');
});

test('rename: another workspace 404, the co-owner selects the AI workspace', async (t) => {
  const { app, cookie } = await fixture(t);
  const scout = await agent(app, cookie, 'Scout');
  const stranger = await account(app, 'Stranger');
  assert.equal((await rename(app, stranger, scout, { name: 'Taken' })).statusCode, 404);
  assert.equal((await rename(app, cookie, randomUUID(), { name: 'Nobody' })).statusCode, 404);
  assert.equal(
    (await snapshot(app, cookie)).agents.find((item) => item.id === scout)!.name,
    'Scout',
  );

  const created = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Rename AI', idempotency_key: randomUUID() }),
  });
  assert.equal(created.statusCode, 201, created.body);
  const { workspace_id: aiId, workspace_key: key, claim_token: claim } = created.json();
  const made = await app.inject({
    method: 'POST',
    url: '/api/assistant/tools/city_create_agent',
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify({
      name: 'AI scout',
      capability: 'research',
      mode: 'hosted',
      idempotencyKey: randomUUID(),
    }),
  });
  assert.equal(made.statusCode, 200, made.body);
  const aiAgent = made.json().agent.id as string;
  const claimed = await api(app, stranger, '/api/workspaces/claim', { claim_token: claim });
  assert.equal(claimed.statusCode, 200, claimed.body);

  // Without the selection the person's own workspace is used, where the agent is not.
  assert.equal((await rename(app, stranger, aiAgent, { name: 'Lead scout' })).statusCode, 404);
  // A person who does not co-own the AI workspace cannot select it.
  assert.equal((await rename(app, cookie, aiAgent, { name: 'Lead scout' }, aiId)).statusCode, 404);
  const done = await rename(app, stranger, aiAgent, { name: 'Lead scout' }, aiId);
  assert.equal(done.statusCode, 200, done.body);
  const state = await snapshot(app, stranger, aiId);
  assert.equal(state.agents.find((item) => item.id === aiAgent)!.name, 'Lead scout');
  assert.ok(state.events.some((item) => item.type === 'agent.renamed' && item.agentId === aiAgent));
});

test('rename: room members and the members search follow the new name', async (t) => {
  const { app, cookie } = await fixture(t);
  const scout = await agent(app, cookie, 'Scout');
  const room = await api(app, cookie, '/api/rooms', {
    agent_id: scout,
    name: 'Rename room',
    idempotency_key: randomUUID(),
  });
  assert.equal(room.statusCode, 201, room.body);
  const roomId = room.json().room.id as string;
  const members = async (q?: string) => {
    const response = await api(
      app,
      cookie,
      `/api/rooms/${roomId}/members${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      undefined,
      'GET',
    );
    assert.equal(response.statusCode, 200, response.body);
    return response.json().members as { id: string; name: string }[];
  };
  assert.equal((await members()).find((item) => item.id === scout)!.name, 'Scout');

  assert.equal((await rename(app, cookie, scout, { name: 'Harbor Desk' })).statusCode, 200);
  assert.equal((await members()).find((item) => item.id === scout)!.name, 'Harbor Desk');
  assert.deepEqual(
    (await members('harbor')).map((item) => item.id),
    [scout],
    'the members search (mention keys) finds the new name',
  );
  assert.deepEqual(await members('scout'), [], 'and no longer the old one');
});

test('rename: a manifest agent gets a new revision and its Agent Card shows the new name', async (t) => {
  const { app, cookie } = await fixture(t);
  const scout = await agent(app, cookie, 'Card Scout', { visibility: 'public' });
  const card = async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/a2a/${scout}/.well-known/agent-card.json`,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { name: string; version: string };
  };
  const first = await card();
  assert.equal(first.name, 'Card Scout');

  const renamed = await rename(app, cookie, scout, { name: 'Card Lead' });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().agent.revision, 2);
  const second = await card();
  assert.equal(second.name, 'Card Lead');
  assert.notEqual(second.version, first.version, 'the card version follows the content');

  const rows = await app.city.db.query<{ revision: number; manifest: any; manifest_hash: string }>(
    'SELECT revision,manifest,manifest_hash FROM agent_manifests WHERE agent_id=$1 ORDER BY revision',
    [scout],
  );
  assert.deepEqual(
    rows.rows.map((row) => row.manifest.metadata.displayName),
    ['Card Scout', 'Card Lead'],
  );
  assert.equal(
    rows.rows[1]!.manifest.metadata.name,
    rows.rows[0]!.manifest.metadata.name,
    'the manifest name (its identity) stays',
  );
  assert.equal(rows.rows[1]!.manifest_hash, renamed.json().agent.manifestHash);

  // The Base registration file (the on-chain agent URI) is built from the live card.
  const short = await ensureShortId(app.city.db, scout);
  const registration = await app.inject({ method: 'GET', url: `/a/${short}` });
  assert.equal(registration.statusCode, 200, registration.body);
  assert.equal(registration.json().name, 'Card Lead');
});
