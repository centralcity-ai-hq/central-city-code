import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CityLimits } from '../server/limits.js';
import { createApp } from '../server/app.js';
import {
  SMOKE_GUEST_NAME,
  injectTransport,
  joinWithInvite,
  leaveAsGuest,
  listMembersAsGuest,
  listOpenToolSchemas,
  readAsGuest,
  type SmokeTransport,
} from '../scripts/smoke/ai-guest.js';
import { sessionPair } from './session-cookie-pair.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-leave-test-root-stand-in';

const ORIGIN = 'https://centralcity.ai';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};

async function fixture(
  t: { after(fn: () => Promise<unknown>): void },
  limits: Partial<CityLimits> = {},
) {
  let time = Date.now();
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
    now: () => time,
    limits,
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
  const get = (url: string, extra = {}) =>
    app.inject({ method: 'GET', url, headers: { ...headers, ...extra } });
  const registered = await post('/api/auth/register', {
    name: 'Leave host',
    password: 'Synthetic leave test password',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = sessionPair(registered.cookies);
  const host = { cookie };
  const agent = await post(
    '/api/agents',
    { name: 'Host', capability: 'research', mode: 'hosted' },
    host,
  );
  assert.equal(agent.statusCode, 201, agent.body);
  const room = await post(
    '/api/rooms',
    { name: 'Leave room', agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
    host,
  );
  assert.equal(room.statusCode, 201, room.body);
  const roomId = room.json().room.id;
  const link = await post('/api/links', { target: 'room', room_id: roomId }, host);
  assert.equal(link.statusCode, 201, link.body);
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;
  const transport: SmokeTransport = injectTransport(async (req) => {
    const res = await app.inject({
      method: req.method,
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
  return { app, post, get, host, roomId, code, transport };
}

async function leaveSupported(transport: SmokeTransport): Promise<boolean> {
  const listed = await listOpenToolSchemas(transport);
  return listed.ok && listed.tools.some((tool) => tool.name === 'city_room_leave');
}

test('a guest leaves; the host sees the member gone', async (t) => {
  const f = await fixture(t);
  if (!(await leaveSupported(f.transport))) {
    t.skip('city_room_leave is not in tools/list on main yet (#120)');
    return;
  }
  const joined = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME);
  assert.equal(joined.ok, true, joined.raw);
  const guest = joined.guest!;
  const left = await leaveAsGuest(f.transport, guest.credential);
  assert.equal(left.ok, true, left.raw);
  // The credential no longer reads: the member is gone.
  const read = await readAsGuest(f.transport, guest.credential);
  assert.equal(read.ok, false);
  assert.equal(read.code, 'room_credential_denied');
  assert.ok(!read.raw.includes(guest.credential));
  // The host sees the member gone from the room.
  const members = await f.get(`/api/rooms/${f.roomId}/members`, f.host);
  assert.equal(members.statusCode, 200, members.body);
  const ids = (members.json().members as { id: string }[]).map((member) => member.id);
  assert.ok(!ids.includes(guest.agentId));
});

test('a ban-after-leave means the same guest cannot rejoin with the old link', async (t) => {
  const f = await fixture(t);
  if (!(await leaveSupported(f.transport))) {
    t.skip('city_room_leave is not in tools/list on main yet (#120)');
    return;
  }
  const joined = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME);
  assert.equal(joined.ok, true, joined.raw);
  const guest = joined.guest!;
  const left = await leaveAsGuest(f.transport, guest.credential);
  assert.equal(left.ok, true, left.raw);
  // Host bans the departed member; the old link no longer admits them. A guest without an
  // account has no lasting identity, so its join source is blocked from the room instead.
  const removed = await f.post(
    `/api/rooms/${f.roomId}/members/${guest.agentId}/remove`,
    {},
    f.host,
  );
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().guest_source_blocked, true);
  const again = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME, randomUUID());
  assert.equal(again.ok, false, again.raw);
  assert.equal(again.code, 'removed_from_room');
  assert.match(again.raw, /\\?"may_rejoin\\?":false/);
});
