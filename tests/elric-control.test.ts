import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { elricFixture } from './elric-fixture.js';

/**
 * Who controls Elric: CITY_ELRIC unset (no routes, no hook), and third-party grants (a grant or
 * key may pause Elric, never resume, revoke, rename or re-scope it).
 */
test('flag off: routes are not registered and the room hook is a no-op', async (t) => {
  const flag = process.env.CITY_ELRIC;
  delete process.env.CITY_ELRIC;
  t.after(() => {
    if (flag === undefined) delete process.env.CITY_ELRIC;
    else process.env.CITY_ELRIC = flag;
  });
  let now = Date.UTC(2026, 8, 30, 12, 0, 0);
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => now });
  t.after(() => app.close());
  const db = app.city.db;
  assert.equal(app.elric, undefined);
  const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: JSON.stringify({ name: 'Flag off owner', password: 'Synthetic flag off password' }),
  });
  assert.equal(register.statusCode, 201, register.body);
  const cookie = `cc_session=${register.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const call = (method: string, url: string, body?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { ...headers, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  assert.equal((await call('GET', '/api/elric')).statusCode, 404);
  assert.equal((await call('POST', '/api/elric', {})).statusCode, 404);
  // The tables exist (the schema never depends on the flag).
  assert.equal((await db.query('SELECT 1 FROM elric_turns')).rows.length, 0);
  const agent = (
    await call('POST', '/api/agents', { name: 'Marked', capability: 'research', mode: 'hosted' })
  ).json().agent.id as string;
  const owner = (await db.query<{ id: string }>('SELECT id FROM operators')).rows[0]!.id;
  await db.query(
    `INSERT INTO elric_agents(agent_id,owner_id,status,created_at,updated_at,updated_by)
     VALUES($1,$2,'active',$3,$3,'test')`,
    [agent, owner, now],
  );
  const room = await call('POST', '/api/rooms', {
    agent_id: agent,
    name: 'Flag off room',
    idempotency_key: randomUUID(),
  });
  assert.equal(room.statusCode, 201, room.body);
  const roomId = room.json().room.id as string;
  const helper = (
    await call('POST', '/api/agents', { name: 'Helper', capability: 'research', mode: 'hosted' })
  ).json().agent.id as string;
  const joined = await call('POST', `/api/rooms/${roomId}/join`, {
    token: (room.json().link.link as string).split('#')[1],
    agent_id: helper,
    idempotency_key: randomUUID(),
  });
  assert.equal(joined.statusCode, 200, joined.body);
  now += 1000;
  const posted = await call('POST', `/api/rooms/${roomId}/messages`, {
    text: '@Marked hello',
    agent_id: helper,
    idempotency_key: randomUUID(),
  });
  assert.equal(posted.statusCode, 201, posted.body);
  assert.equal(posted.json().elric_notice, undefined);
  assert.equal((await db.query('SELECT 1 FROM elric_invocations')).rows.length, 0);
  assert.equal((await db.query('SELECT 1 FROM elric_turns')).rows.length, 0);
  assert.equal((await db.query('SELECT 1 FROM elric_notices')).rows.length, 0);
});

test('Elric is managed: console revoke/rotate and city_control answer 409 elric_managed', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const granted = await f.call(s.owner.cookie, 'POST', '/api/assistant-access', {
    label: 'Synthetic third party',
    scopes: ['workspace:read', 'agents:control', 'agents:create'],
    expiresInDays: 1,
  });
  assert.equal(granted.statusCode, 201, granted.body);
  const token = granted.json().token as string;
  const tool = (name: string, body: unknown) =>
    f.app.inject({
      method: 'POST',
      url: `/api/assistant/tools/${name}`,
      headers: {
        'content-type': 'application/json',
        'x-city-request': '1',
        authorization: `Bearer ${token}`,
      },
      payload: JSON.stringify(body),
    });
  const managed = (response: { statusCode: number; body: string; json(): unknown }) => {
    assert.equal(response.statusCode, 409, response.body);
    const body = response.json() as { code?: string; error?: string };
    assert.equal(body.code, 'elric_managed', response.body);
    assert.equal(
      body.error,
      'Elric is managed by Central City. Turn it off in Elric settings instead.',
    );
  };
  // Console per-agent destructive routes.
  managed(await f.call(s.owner.cookie, 'POST', `/api/agents/${s.elricId}/revoke`, {}));
  managed(await f.call(s.owner.cookie, 'POST', `/api/agents/${s.elricId}/rotate-credential`, {}));
  managed(await f.call(s.owner.cookie, 'POST', `/api/agents/${s.elricId}/pause`, {}));
  managed(await f.call(s.owner.cookie, 'POST', `/api/agents/${s.elricId}/resume`, {}));
  // city_control: every action, including pause.
  for (const action of ['pause', 'resume', 'revoke'])
    managed(await tool('city_control', { agent_id: s.elricId, action }));
  await f.elric.pause(s.owner.operatorId);
  managed(await tool('city_control', { agent_id: s.elricId, action: 'resume' }));
  await f.elric.resume(s.owner.operatorId);
  // Normal agents still work through the same routes and tool.
  const normal = async (mode: string) => {
    const created = await f.call(s.owner.cookie, 'POST', '/api/agents', {
      name: `Normal ${mode}`,
      capability: 'research',
      mode,
    });
    assert.equal(created.statusCode, 201, created.body);
    return created.json().agent.id as string;
  };
  const external = await normal('external');
  const rotated = await f.call(
    s.owner.cookie,
    'POST',
    `/api/agents/${external}/rotate-credential`,
    {},
  );
  assert.equal(rotated.statusCode, 200, rotated.body);
  const paused = await tool('city_control', { agent_id: external, action: 'pause' });
  assert.equal(paused.statusCode, 200, paused.body);
  const revoked = await f.call(s.owner.cookie, 'POST', `/api/agents/${external}/revoke`, {});
  assert.equal(revoked.statusCode, 200, revoked.body);
  const hosted = await normal('hosted');
  const controlled = await tool('city_control', { agent_id: hosted, action: 'revoke' });
  assert.equal(controlled.statusCode, 200, controlled.body);
  // Rename or re-scope through a manifest: Elric was not created from a manifest, and the name
  // is reserved, so neither an update nor a look-alike create goes through.
  for (const name of ['Elric', 'elric']) {
    const created = await tool('city_create_agent', {
      template: 'template:extractor@1.0.0',
      overrides: { metadata: { name: name.toLowerCase(), displayName: name } },
      idempotency_key: randomUUID(),
    });
    assert.equal(created.statusCode, 409, `${name}: ${created.body}`);
    assert.match(created.body, /reserved/);
  }
  const snapshot = await f.call(s.owner.cookie, 'GET', '/api/snapshot');
  const elric = (
    snapshot.json().agents as Array<{
      id: string;
      name: string;
      capability: string;
      status: string;
    }>
  ).find((agent) => agent.id === s.elricId)!;
  assert.equal(elric.name, 'Elric');
  assert.equal(elric.capability, 'research');
  assert.notEqual(elric.status, 'revoked');
  assert.equal(
    (
      await f.db.query<{ status: string }>('SELECT status FROM elric_agents WHERE agent_id=$1', [
        s.elricId,
      ])
    ).rows[0]!.status,
    'active',
  );
});

test('the accountless invite join cannot take the reserved name (any look-alike)', async (t) => {
  const flow = process.env.CITY_INVITE_FLOW;
  process.env.CITY_INVITE_FLOW = '1';
  process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-elric-invite-test-root-secret';
  t.after(() => {
    if (flow === undefined) delete process.env.CITY_INVITE_FLOW;
    else process.env.CITY_INVITE_FLOW = flow;
  });
  const headers = {
    'content-type': 'application/json',
    'x-city-request': '1',
    host: 'centralcity.ai',
    origin: 'https://centralcity.ai',
  };
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
  let address = 20;
  const post = (url: string, body: unknown, extra = {}, same = false) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress: `203.0.113.${same ? address : ++address}`,
    });
  const registered = await post('/api/auth/register', {
    name: 'Invite name host',
    password: 'Synthetic invite name password',
  });
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const agent = await post(
    '/api/agents',
    { name: 'Host', capability: 'research', mode: 'hosted' },
    { cookie },
  );
  const room = await post(
    '/api/rooms',
    { name: 'Invite name room', agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
    { cookie },
  );
  const link = await post(
    '/api/links',
    { target: 'room', room_id: room.json().room.id },
    { cookie },
  );
  assert.equal(link.statusCode, 201, link.body);
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;
  for (const name of ['Elric', 'ELRIC', 'E l r i c', 'Еlric', 'Elrіc', 'E1ric']) {
    const start = await post('/api/public/invites/bootstrap', { code });
    assert.equal(start.statusCode, 200, start.body);
    const joined = await post(
      '/api/public/invites/redeem',
      { code, handle: start.json().handle, name },
      {},
      true,
    );
    assert.equal(joined.statusCode, 409, `${JSON.stringify(name)}: ${joined.body}`);
    assert.equal(joined.json().code, 'name_reserved');
  }
  const start = await post('/api/public/invites/bootstrap', { code });
  const fine = await post(
    '/api/public/invites/redeem',
    { code, handle: start.json().handle, name: 'Invited AI' },
    {},
    true,
  );
  assert.equal(fine.statusCode, 200, fine.body);
});

test("Elric's own off switch still pauses and revokes it after the managed refusals", async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const refused = await f.call(s.owner.cookie, 'POST', `/api/agents/${s.elricId}/revoke`, {});
  assert.equal(refused.statusCode, 409, refused.body);
  const status = async () =>
    (
      await f.db.query<{ status: string }>('SELECT status FROM elric_agents WHERE agent_id=$1', [
        s.elricId,
      ])
    ).rows[0]!.status;
  const paused = await f.call(s.owner.cookie, 'POST', '/api/elric/pause', {});
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(await status(), 'paused');
  const revoked = await f.call(s.owner.cookie, 'POST', '/api/elric/revoke', {});
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal(await status(), 'revoked');
});
