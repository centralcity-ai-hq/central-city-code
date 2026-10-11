import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { createHttpRoomsClient } from '../src/rooms/api.js';
import type { Snapshot } from '../shared/types.js';

/**
 * The host "New room" creates when the person has no agent yet (src/rooms/NewRoomSheet.tsx, also
 * "My first room" in src/RoomsShell.tsx) is made like "Create a CC agent" in My agents: from a
 * manifest with a private profile. The Wallet and Base routes find an agent by its manifest
 * (agent_manifests), so without one they answered 404 for the host. The rooms client runs
 * against the real app (fetch is bridged to app.inject); synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
type Sent = { url: string; method: string; body: unknown };
const guarded = { 'content-type': 'application/json', 'x-city-request': '1' };

async function fixture(t: { after: (fn: () => Promise<unknown> | void) => void }) {
  const previous = process.env.CITY_BASE_WALLET;
  process.env.CITY_BASE_WALLET = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.CITY_BASE_WALLET;
    else process.env.CITY_BASE_WALLET = previous;
  });
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: guarded,
    payload: JSON.stringify({ name: 'Room host person', password: 'Synthetic room host password' }),
  });
  assert.equal(res.statusCode, 201, res.body);
  const cookie = `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
  return { app, cookie, sent: bridgeFetch(t, app, cookie) };
}

/** The browser's fetch, answered by the app in this process as the signed-in person. */
function bridgeFetch(
  t: { after: (fn: () => Promise<unknown> | void) => void },
  app: App,
  cookie: string,
) {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET') as 'GET' | 'POST';
    const payload = typeof init?.body === 'string' ? init.body : undefined;
    sent.push({ url: String(input), method, body: payload ? JSON.parse(payload) : undefined });
    const res = await app.inject({
      method,
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>), cookie },
      ...(payload ? { payload } : {}),
    });
    return new Response(res.body, {
      status: res.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return sent;
}

test('a host made by New room has a private profile, so its Wallet and Base answer', async (t) => {
  const { app, cookie, sent } = await fixture(t);
  const client = createHttpRoomsClient();
  // What the New room sheet does with no agent yet: create the host, then the room.
  const host = await client.createAgent({ name: 'Harbor host' });
  const room = await client.create({
    agent_id: host.id,
    name: 'Tea room',
    idempotency_key: randomUUID(),
  });
  assert.equal(room.name, 'Tea room');
  assert.deepEqual(
    sent.find((call) => call.url === '/api/agents')?.body,
    { name: 'Harbor host', capability: 'research', mode: 'hosted', visibility: 'private' },
    'the host is asked for like "Create a CC agent": hosted, with a private profile',
  );

  // The same agent as one made in My agents: a CC agent with a profile, private.
  const snapshot = (
    await app.inject({ url: '/api/snapshot', headers: { cookie } })
  ).json<Snapshot>();
  const stored = snapshot.agents.find((agent) => agent.id === host.id)!;
  assert.equal(stored.name, 'Harbor host');
  assert.equal(stored.mode, 'hosted');
  assert.equal(stored.isDemo, true);
  assert.equal(stored.visibility, 'private');
  assert.equal(stored.revision, 1);
  assert.ok(stored.manifestHash);

  // Wallet and Base find it (no wallet and no Base ID yet), instead of answering 404.
  const wallet = await app.inject({
    url: `/api/base/agents/${host.id}/wallet`,
    headers: { cookie },
  });
  assert.equal(wallet.statusCode, 200, wallet.body);
  assert.deepEqual(wallet.json(), { wallet: null });
  const base = await app.inject({
    url: `/api/base/agents/${host.id}/registration`,
    headers: { cookie },
  });
  assert.equal(base.statusCode, 200, base.body);
  assert.deepEqual(base.json(), { identities: [] });

  // Private: its Agent Card is the owner's only; nobody else learns it exists.
  const card = `/a2a/${host.id}/.well-known/agent-card.json`;
  assert.equal((await app.inject({ url: card, headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ url: card })).statusCode, 404);
});

test('without a profile (the earlier host request) the wallet route answered 404', async (t) => {
  const { app, cookie } = await fixture(t);
  const res = await app.inject({
    method: 'POST',
    url: '/api/agents',
    headers: { ...guarded, cookie },
    payload: JSON.stringify({ name: 'Older host', capability: 'research', mode: 'hosted' }),
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().agent.id as string;
  const wallet = await app.inject({ url: `/api/base/agents/${id}/wallet`, headers: { cookie } });
  assert.equal(wallet.statusCode, 404);
});
