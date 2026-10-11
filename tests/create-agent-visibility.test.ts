import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { PASSWORD } from './oauth-helpers.js';

const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

async function owner(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Card owner', password: PASSWORD }),
  });
  assert.equal(res.statusCode, 201, res.body);
  const cookie = `cc_session=${res.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
  const create = (body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify(body),
    });
  const snapshot = async () =>
    (await app.inject({ url: '/api/snapshot', headers: { cookie } })).json() as {
      agents: { id: string; visibility?: string }[];
    };
  return { app, create, snapshot };
}

const agent = {
  name: 'Alphonse',
  description: 'Turns text into a short brief.',
  capability: 'research',
  mode: 'hosted',
};

test('Create agent with Public gets a public signed card and a manifest', async (t) => {
  const { app, create, snapshot } = await owner(t);
  const res = await create({ ...agent, visibility: 'public' });
  assert.equal(res.statusCode, 201, res.body);
  const { agent: created, agent_card_url } = res.json();
  assert.equal(created.name, 'Alphonse');
  assert.equal(created.visibility, 'public');
  assert.match(agent_card_url, /\/a2a\/[0-9a-f-]{36}\/\.well-known\/agent-card\.json$/);
  // The owner's snapshot carries the choice, so the agent page can offer the Base action.
  const listed = (await snapshot()).agents.find((item) => item.id === res.json().agent.id);
  assert.equal(listed?.visibility, 'public');
  // Signed out, a public card is served.
  const card = await app.inject({ url: `/a2a/${created.id}/.well-known/agent-card.json` });
  assert.equal(card.statusCode, 200, card.body);
  assert.equal(card.json().name, 'Alphonse');
  assert.equal(card.json().description, 'Turns text into a short brief.');
  // The same display name twice creates two agents, never an update of the first.
  const again = await create({ ...agent, visibility: 'public' });
  assert.equal(again.statusCode, 201, again.body);
  assert.notEqual(again.json().agent.id, created.id);
});

test('Create agent with Private keeps the card owner-only; without a choice nothing changes', async (t) => {
  const { app, create } = await owner(t);
  const priv = await create({ ...agent, visibility: 'private' });
  assert.equal(priv.statusCode, 201, priv.body);
  const card = await app.inject({
    url: `/a2a/${priv.json().agent.id}/.well-known/agent-card.json`,
  });
  assert.equal(card.statusCode, 404);
  assert.equal(priv.json().agent.visibility, 'private');
  const plain = await create(agent);
  assert.equal(plain.statusCode, 201, plain.body);
  assert.equal(plain.json().agent.visibility, undefined);
  assert.equal(plain.json().agent_card_url, undefined);
  assert.equal((await create({ ...agent, visibility: 'everyone' })).statusCode, 400);
  // External agents get no manifest here, so a visibility choice is refused, not dropped.
  assert.equal(
    (await create({ ...agent, mode: 'external', visibility: 'public' })).statusCode,
    400,
  );
});
