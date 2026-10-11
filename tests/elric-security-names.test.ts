import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { MockAdapter } from '../server/elric/adapter.js';
import { isReservedElricName } from '../server/elric/names.js';
import { injectTransport, joinWithInvite } from '../scripts/smoke/ai-guest.js';
import { defaultPiiKeyring, storeDob } from '../server/google/pii.js';
import { elricFixture } from './elric-fixture.js';

/**
 * Elric security: the reserved name "Elric" on EVERY path that names a
 * room member, not only the console and manifest creates. A second member reading as "Elric"
 * makes "@Elric" ambiguous (the owner can no longer invoke it) and lets anyone impersonate the
 * first-party agent. Synthetic data only.
 */
process.env.CITY_INVITE_FLOW = '1';
// The hosted invite path needs a rate-limit key; set here so CI never depends on the env.
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-elric-security-rate-limit-stand-in';

type F = Awaited<ReturnType<typeof elricFixture>>;
const NAMES = [
  'Elric',
  'ELRIC',
  'E l r i c',
  'Еlric' /* Cyrillic Е */,
  'E1ric',
  'Elrіc' /* Cyrillic і */,
];

async function grant(f: F, cookie: string) {
  const res = await f.call(cookie, 'POST', '/api/assistant-access', {
    label: 'Third-party AI (synthetic)',
    scopes: [...ASSISTANT_SCOPES],
    expiresInDays: 1,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().token as string;
}
const tool = (f: F, token: string, name: string, body: unknown) =>
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
/** Every room member other than the real Elric whose name reads as "Elric". */
async function lookAlikes(f: F, cookie: string, roomId: string, elricId: string) {
  const members = (await f.call(cookie, 'GET', `/api/rooms/${roomId}/members`)).json()
    .members as Array<{ id: string; name: string }>;
  return members.filter((m) => m.id !== elricId && isReservedElricName(m.name)).map((m) => m.name);
}
async function ownerCanStillInvoke(f: F, s: Awaited<ReturnType<F['scene']>>) {
  const before = f.adapterCalls();
  await f.say(s.owner, s.room, '@Elric are you there?', s.person);
  await f.elric.drain();
  return f.adapterCalls() > before;
}

test('names: the console refuses every look-alike of "Elric" (baseline)', async (t) => {
  const f = await elricFixture(t);
  const who = await f.account('Console namer');
  for (const name of NAMES) {
    const res = await f.call(who.cookie, 'POST', '/api/agents', {
      name,
      capability: 'research',
      mode: 'hosted',
    });
    assert.equal(res.statusCode, 409, `${JSON.stringify(name)} → ${res.statusCode}`);
  }
});

test('names: city_create_agent (plain, non-manifest) through an AI grant cannot take "Elric"', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const other = await f.account('Grant namer');
  const token = await grant(f, other.cookie);
  for (const name of NAMES) {
    const res = await tool(f, token, 'city_create_agent', {
      name,
      description: 'Synthetic',
      capability: 'research',
      mode: 'external',
      idempotencyKey: randomUUID(),
    });
    assert.notEqual(res.statusCode, 200, `${JSON.stringify(name)} was created: ${res.body}`);
  }
  void s;
});

test('names: city_join_room {create: {name: "Elric"}} cannot add a look-alike to the room', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const other = await f.account('Join namer');
  const token = await grant(f, other.cookie);
  for (const name of NAMES) {
    const res = await tool(f, token, 'city_join_room', {
      link: s.room.link,
      create: { name },
      idempotency_key: randomUUID(),
    });
    t.diagnostic(`join create ${JSON.stringify(name)}: ${res.statusCode}`);
  }
  assert.deepEqual(await lookAlikes(f, s.owner.cookie, s.room.id, s.elricId), []);
  assert.ok(await ownerCanStillInvoke(f, s), 'the owner can still reach Elric');
});

test('names: an accountless invited AI (city_join_invite) cannot join as "Elric"', async (t) => {
  // Invite links and /mcp/open run on the hosted code path (as tests/ai-guest-join-code.test.ts).
  const ORIGIN = 'https://centralcity.ai';
  const headers = {
    'content-type': 'application/json',
    'x-city-request': '1',
    host: 'centralcity.ai',
    origin: ORIGIN,
  };
  const small = new MockAdapter('mock-small');
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
    elric: { enabled: true, adapterFor: () => small, autoDrain: false },
  });
  t.after(() => app.close());
  let address = 20;
  const post = (url: string, body: unknown, cookie = '') =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...(cookie ? { cookie } : {}) },
      payload: JSON.stringify(body),
      remoteAddress: `203.0.113.${address++}`,
    });
  const account = async (name: string) => {
    const res = await post('/api/auth/register', { name, password: `Synthetic password ${name}` });
    assert.equal(res.statusCode, 201, res.body);
    return `cc_session=${res.cookies.find((c) => c.name === 'cc_session')!.value}`;
  };
  const host = await account('Invite host');
  const hostAgent = (
    await post('/api/agents', { name: 'Host', capability: 'research', mode: 'hosted' }, host)
  ).json().agent.id;
  const room = (
    await post(
      '/api/rooms',
      { name: 'Invite room', agent_id: hostAgent, idempotency_key: randomUUID() },
      host,
    )
  ).json();
  const roomId = room.room.id as string;
  // Only the room's host may add their Elric, so the host owns the real Elric here.
  const owner = host;
  const ownerId = (
    await app.city.db.query<{ id: string }>("SELECT id FROM operators WHERE name='Invite host'")
  ).rows[0]!.id;
  await app.city.db.query(
    `INSERT INTO elric_verified_identities(operator_id,provider,subject,email,email_verified,verified_at,created_at)
     VALUES($1,'google','sub-invite-owner','invite.owner@example.com',true,$2,$2)`,
    [ownerId, Date.now()],
  );
  await storeDob(app.city.db, defaultPiiKeyring(), ownerId, '1990-01-01', 'owner', Date.now());
  const elricId = (await post('/api/elric', {}, owner)).json().agent_id as string;
  const joined = await post(
    `/api/rooms/${room.room.slug}/join`,
    { token: room.link.link.split('#')[1], agent_id: elricId, idempotency_key: randomUUID() },
    owner,
  );
  assert.equal(joined.statusCode, 200, joined.body);
  const link = await post('/api/links', { target: 'room', room_id: roomId }, host);
  assert.equal(link.statusCode, 201, link.body);
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;
  const transport = injectTransport(async (req) => {
    const res = await app.inject({
      method: req.method as 'POST',
      url: req.path,
      headers: {
        host: 'centralcity.ai',
        'x-forwarded-proto': 'https',
        ...(req.accept ? { accept: req.accept } : {}),
        ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...req.headers,
      },
      ...(req.body === undefined ? {} : { payload: JSON.stringify(req.body) }),
      remoteAddress: '203.0.113.12',
    });
    return { statusCode: res.statusCode, body: res.body };
  }, ORIGIN);
  const control = await joinWithInvite(transport, code, 'Ordinary guest', randomUUID());
  assert.ok(control.ok, `control join failed: ${control.code}`);
  const names: string[] = [];
  for (const name of NAMES) {
    const res = await joinWithInvite(transport, code, name, randomUUID());
    t.diagnostic(`invited AI named ${JSON.stringify(name)}: ok=${res.ok} code=${res.code}`);
    if (res.ok) names.push(name);
  }
  const members = (
    await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/members`,
      headers: { ...headers, cookie: owner },
    })
  ).json().members as Array<{ id: string; name: string }>;
  const impostors = members.filter((m) => m.id !== elricId && isReservedElricName(m.name));
  assert.deepEqual(
    impostors.map((m) => m.name),
    [],
    'an invited AI took a name that reads as Elric',
  );
});

test('names: a person joining as "Elric" neither blocks nor shadows the real Elric', async (t) => {
  const f = await elricFixture(t);
  const host = await f.account('Person-name host');
  const hostAgent = await f.agent(host, 'Host desk');
  const room = await f.room(host, hostAgent, 'Person-name room');
  // A guest person tries to take the name BEFORE the owner adds Elric: every look-alike is refused.
  const squatter = await f.account('Squatter');
  for (const name of NAMES) {
    const res = await f.call(squatter.cookie, 'POST', '/api/rooms/join', {
      link: room.link,
      name,
      idempotency_key: randomUUID(),
    });
    assert.equal(res.statusCode, 409, `person named ${JSON.stringify(name)}: ${res.body}`);
  }
  // Only the room's host may add their Elric, so the host owns the real Elric here.
  const owner = host;
  await f.verify(owner);
  const elricId = await f.addElric(owner);
  const person = await f.joinPerson(owner, room, 'Ann');
  const joined = await f.call(owner.cookie, 'POST', `/api/rooms/${room.slug}/join`, {
    token: room.token,
    agent_id: elricId,
    idempotency_key: randomUUID(),
  });
  t.diagnostic(
    `Elric joining after a person named Elric: ${joined.statusCode} ${joined.body.slice(0, 160)}`,
  );
  assert.equal(joined.statusCode, 200, 'a person cannot keep the real Elric out of a room');
  const members = (await f.call(owner.cookie, 'GET', `/api/rooms/${room.id}/members`)).json()
    .members as Array<{ id: string; name: string; kind: string }>;
  t.diagnostic(`members: ${JSON.stringify(members.map((m) => [m.name, m.kind]))}`);
  const before = f.adapterCalls();
  await f.say(owner, room, '@Elric hello', person);
  await f.elric.drain();
  assert.ok(f.adapterCalls() > before, 'the owner can still reach Elric');
});
