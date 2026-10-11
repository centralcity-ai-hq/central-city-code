import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, type App } from './oauth-helpers.js';
import { ensureShortId } from '../server/base/identity/short-links.js';

/**
 * My agents' Make public (PATCH /api/agents/:id {visibility}, optionally with {name}): a private
 * manifest agent becomes public (new manifest revision, public Agent Card and /a/<id> file, audit
 * event), so it can register on Base. Agents without a manifest have no card and cannot be made
 * public; a Base agent cannot be made private again. Owner only, Elric refused. Synthetic data only.
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
const patch = (app: App, cookie: string, id: string, body: unknown, workspace?: string) =>
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
    agents: { id: string; name: string; visibility?: string }[];
    events: { type: string; agentId?: string; message: string }[];
  };
}

/** The card and the /a/<id> file as an unauthenticated visitor sees them. */
async function publicStatus(app: App, id: string) {
  const card = await app.inject({ method: 'GET', url: `/a2a/${id}/.well-known/agent-card.json` });
  const short = await ensureShortId(app.city.db, id);
  const file = await app.inject({ method: 'GET', url: `/a/${short}` });
  return { card: card.statusCode, file: file.statusCode, name: card.json().name as string };
}

async function manifests(app: App, id: string) {
  return (
    await app.city.db.query<{ revision: number; manifest: any }>(
      'SELECT revision,manifest FROM agent_manifests WHERE agent_id=$1 ORDER BY revision',
      [id],
    )
  ).rows;
}

const visibilityEvents = async (app: App, cookie: string, id: string, workspace?: string) =>
  (await snapshot(app, cookie, workspace)).events.filter(
    (item) => item.type === 'agent.visibility' && item.agentId === id,
  );

test('make public: the card and /a/<id> become visible, a new revision, an event; again is a no-op', async (t) => {
  const { app, cookie } = await fixture(t);
  const scout = await agent(app, cookie, 'Quiet Scout', { visibility: 'private' });
  assert.deepEqual(await publicStatus(app, scout), {
    card: 404,
    file: 404,
    name: undefined,
  });

  const made = await patch(app, cookie, scout, { visibility: 'public' });
  assert.equal(made.statusCode, 200, made.body);
  assert.equal(made.json().changed, true);
  assert.equal(made.json().agent.visibility, 'public');
  assert.equal(made.json().agent.revision, 2);
  assert.deepEqual(await publicStatus(app, scout), { card: 200, file: 200, name: 'Quiet Scout' });

  const rows = await manifests(app, scout);
  assert.deepEqual(
    rows.map((row) => row.manifest.spec.visibility),
    ['private', 'public'],
  );
  assert.equal(rows[1]!.manifest.metadata.name, rows[0]!.manifest.metadata.name);
  const events = await visibilityEvents(app, cookie, scout);
  assert.deepEqual(
    events.map((item) => item.message),
    ['Quiet Scout is now public.'],
  );
  const state = await snapshot(app, cookie);
  assert.equal(state.agents.find((item) => item.id === scout)!.visibility, 'public');

  const again = await patch(app, cookie, scout, { visibility: 'public' });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().changed, false);
  assert.equal((await manifests(app, scout)).length, 2);
  assert.equal((await visibilityEvents(app, cookie, scout)).length, 1);
});

test('make public with a new name: one revision, both events', async (t) => {
  const { app, cookie } = await fixture(t);
  const scout = await agent(app, cookie, 'Draft Scout', { visibility: 'private' });
  const made = await patch(app, cookie, scout, { name: 'Harbor Scout', visibility: 'public' });
  assert.equal(made.statusCode, 200, made.body);
  assert.equal(made.json().agent.revision, 2);
  const rows = await manifests(app, scout);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.manifest.metadata.displayName, 'Harbor Scout');
  assert.equal(rows[1]!.manifest.spec.visibility, 'public');
  const events = (await snapshot(app, cookie)).events.filter((item) => item.agentId === scout);
  assert.ok(events.some((item) => item.message === 'Renamed Draft Scout to Harbor Scout.'));
  assert.ok(events.some((item) => item.message === 'Harbor Scout is now public.'));
  assert.equal((await publicStatus(app, scout)).name, 'Harbor Scout');
});

test('visibility: invalid bodies 400; agents without a manifest cannot be made public', async (t) => {
  const { app, cookie } = await fixture(t);
  const scout = await agent(app, cookie, 'Scout', { visibility: 'private' });
  for (const body of [{}, { visibility: 'org' }, { visibility: 'PUBLIC' }, { visibility: true }])
    assert.equal((await patch(app, cookie, scout, body)).statusCode, 400, JSON.stringify(body));
  assert.equal(
    (await patch(app, cookie, scout, { visibility: 'public', description: 'x' })).statusCode,
    400,
    'strict body',
  );

  // Created without a manifest (no visibility choice): no card, so nothing to make public.
  const plain = await agent(app, cookie, 'Plain');
  const external = await agent(app, cookie, 'Outside', { mode: 'external' });
  for (const id of [plain, external]) {
    const refused = await patch(app, cookie, id, { visibility: 'public' });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.match(refused.json().error, /cannot be made public/);
    assert.equal(refused.json().code, 'no_profile');
    // Private is what it already is.
    const same = await patch(app, cookie, id, { visibility: 'private' });
    assert.equal(same.statusCode, 200, same.body);
    assert.equal(same.json().changed, false);
  }
  // A rename of such an agent still works, and a refused combined change changes nothing.
  assert.equal((await patch(app, cookie, plain, { name: 'Plain Two' })).statusCode, 200);
  const combined = await patch(app, cookie, plain, { name: 'Plain Three', visibility: 'public' });
  assert.equal(combined.statusCode, 409, combined.body);
  const state = await snapshot(app, cookie);
  assert.equal(state.agents.find((item) => item.id === plain)!.name, 'Plain Two');
  assert.equal(state.agents.find((item) => item.id === plain)!.visibility, undefined);
});

test('make private: allowed before Base, refused once a Base registration started', async (t) => {
  const { app, cookie } = await fixture(t);
  const scout = await agent(app, cookie, 'Open Scout', { visibility: 'public' });
  const hidden = await patch(app, cookie, scout, { visibility: 'private' });
  assert.equal(hidden.statusCode, 200, hidden.body);
  assert.equal(hidden.json().changed, true);
  const card = await app.inject({
    method: 'GET',
    url: `/a2a/${scout}/.well-known/agent-card.json`,
  });
  assert.equal(card.statusCode, 404);
  assert.deepEqual(
    (await visibilityEvents(app, cookie, scout)).map((item) => item.message),
    ['Open Scout is now private.'],
  );

  // A short id is the agent URI written on chain: from then on the card stays public.
  const short = await agent(app, cookie, 'Short Scout', { visibility: 'public' });
  await ensureShortId(app.city.db, short);
  const refusedShort = await patch(app, cookie, short, { visibility: 'private' });
  assert.equal(refusedShort.statusCode, 409, refusedShort.body);
  assert.equal(refusedShort.json().error, "A Base agent's profile stays public.");
  assert.equal(refusedShort.json().code, 'base_stays_public');

  // An identity row in any state (seeded like the identity tests do).
  const based = await agent(app, cookie, 'Base Scout', { visibility: 'public' });
  const ownerId = (await app.city.db.query<{ id: string }>('SELECT id FROM operators')).rows[0]!.id;
  await app.city.db.query(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
       agent_card_uri, owner_of_identity, state, updated_at)
     VALUES ($1, 84532, $2, $3, 'https://example.test/a/abc123', $4, 'pending', 1)`,
    [based, ownerId, `0x${'8'.repeat(40)}`, `0x${'1'.repeat(40)}`],
  );
  const refused = await patch(app, cookie, based, { visibility: 'private' });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().error, "A Base agent's profile stays public.");
  assert.equal(refused.json().code, 'base_stays_public');
  assert.equal((await manifests(app, based)).at(-1)!.manifest.spec.visibility, 'public');
  // Renaming a Base agent stays possible, and asking for public again is a no-op.
  const renamed = await patch(app, cookie, based, { name: 'Base Lead', visibility: 'public' });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().changed, true);
  assert.equal(renamed.json().agent.visibility, 'public');
});

test('visibility: Elric refused, removed 409, another workspace 404, the co-owner selects the AI workspace', async (t) => {
  const { app, cookie } = await fixture(t);
  const elric = await agent(app, cookie, 'Marked', { visibility: 'private' });
  const ownerId = (await app.city.db.query<{ id: string }>('SELECT id FROM operators')).rows[0]!.id;
  await app.city.db.query(
    `INSERT INTO elric_agents(agent_id,owner_id,status,created_at,updated_at,updated_by)
     VALUES($1,$2,'active',$3,$3,'test')`,
    [elric, ownerId, Date.now()],
  );
  const managed = await patch(app, cookie, elric, { visibility: 'public' });
  assert.equal(managed.statusCode, 409, managed.body);
  assert.equal(managed.json().code, 'elric_managed');

  const gone = await agent(app, cookie, 'Gone', { visibility: 'private' });
  assert.equal((await api(app, cookie, `/api/agents/${gone}/revoke`)).statusCode, 200);
  const removed = await patch(app, cookie, gone, { visibility: 'public' });
  assert.equal(removed.statusCode, 409, removed.body);
  assert.equal(removed.json().error, 'Removed agents cannot be changed.');

  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Stranger', password: 'Synthetic visibility password' }),
  });
  assert.equal(register.statusCode, 201, register.body);
  const stranger = `cc_session=${register.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
  const mine = await agent(app, cookie, 'Mine', { visibility: 'private' });
  assert.equal((await patch(app, stranger, mine, { visibility: 'public' })).statusCode, 404);

  // An AI workspace's external runtime agent (created by the AI from a manifest, private by
  // default, no visibility remembered on the agent), made public by its human co-owner.
  const created = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Visibility AI', idempotency_key: randomUUID() }),
  });
  assert.equal(created.statusCode, 201, created.body);
  const { workspace_id: aiId, workspace_key: key, claim_token: claim } = created.json();
  const made = await app.inject({
    method: 'POST',
    url: '/api/assistant/tools/city_create_agent',
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify({
      manifest: {
        apiVersion: 'centralcity.agent/v1',
        kind: 'Agent',
        metadata: { name: 'ai-runtime', displayName: 'AI runtime' },
        spec: { capabilities: ['research'], runtime: { mode: 'external' } },
      },
      idempotency_key: randomUUID(),
    }),
  });
  assert.equal(made.statusCode, 200, made.body);
  const aiAgent = made.json().agent.id as string;
  assert.equal(made.json().agent.mode, 'external');
  assert.equal(made.json().agent.visibility, undefined);
  assert.equal(
    (await api(app, stranger, '/api/workspaces/claim', { claim_token: claim })).statusCode,
    200,
  );
  assert.equal(
    (await patch(app, cookie, aiAgent, { visibility: 'public' }, aiId)).statusCode,
    404,
    'not a co-owner',
  );
  assert.equal((await publicStatus(app, aiAgent)).card, 404);
  const done = await patch(app, stranger, aiAgent, { visibility: 'public' }, aiId);
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().changed, true);
  assert.equal(done.json().agent.visibility, 'public');
  assert.equal((await publicStatus(app, aiAgent)).card, 200);
  assert.equal((await visibilityEvents(app, stranger, aiAgent, aiId)).length, 1);
});

test('manifest update: keeps the stored visibility in step and cannot make a Base agent private', async (t) => {
  const { app } = await fixture(t);
  const created = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Manifest AI', idempotency_key: randomUUID() }),
  });
  assert.equal(created.statusCode, 201, created.body);
  const key = created.json().workspace_key as string;
  const apply = (visibility?: 'private' | 'public', displayName = 'Desk runtime') =>
    app.inject({
      method: 'POST',
      url: '/api/assistant/tools/city_create_agent',
      headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
      payload: JSON.stringify({
        manifest: {
          apiVersion: 'centralcity.agent/v1',
          kind: 'Agent',
          metadata: { name: 'desk-runtime', displayName },
          spec: {
            capabilities: ['research'],
            runtime: { mode: 'external' },
            ...(visibility ? { visibility } : {}),
          },
        },
        idempotency_key: randomUUID(),
      }),
    });
  const first = await apply();
  assert.equal(first.statusCode, 200, first.body);
  const id = first.json().agent.id as string;

  const opened = await apply('public');
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal(opened.json().agent.id, id, 'updated in place');
  assert.equal(opened.json().agent.visibility, 'public');
  assert.equal((await publicStatus(app, id)).card, 200);

  // publicStatus assigned the short id: the agent's Base registration has started.
  for (const visibility of ['private', undefined] as const) {
    const refused = await apply(visibility, 'Desk runtime two');
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(refused.json().code, 'base_stays_public');
    assert.match(refused.body, /BASE_AGENT_PUBLIC/);
  }
  const rows = await manifests(app, id);
  assert.equal(rows.length, 2, 'nothing written by the refused updates');
  assert.equal(rows.at(-1)!.manifest.spec.visibility, 'public');
  const renamed = await apply('public', 'Desk runtime two');
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().agent.visibility, 'public');
});
