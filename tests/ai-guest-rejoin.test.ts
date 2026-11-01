import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CityLimits } from '../server/limits.js';
import { createApp } from '../server/app.js';
import {
  SMOKE_GUEST_NAME,
  SMOKE_POST_TEXT,
  injectTransport,
  joinWithInvite,
  listMembersAsGuest,
  postAsGuest,
  readAsGuest,
  type SmokeTransport,
} from '../scripts/smoke/ai-guest.js';
import { sessionPair } from './session-cookie-pair.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-rejoin-test-root-stand-in';

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
  const registered = await post('/api/auth/register', {
    name: 'Rejoin host',
    password: 'Synthetic rejoin test password',
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
    { name: 'Rejoin room', agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
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
  return { app, post, host, roomId, code, transport };
}

/** The host mints a single-use rejoin link for one guest member; null when refused. */
async function hostRejoinLink(
  f: Awaited<ReturnType<typeof fixture>>,
  agentId: string,
): Promise<string | null> {
  const res = await f.post(`/api/rooms/${f.roomId}/members/${agentId}/rejoin-link`, {}, f.host);
  if (res.statusCode !== 200) return null;
  return new URL(res.json().link).pathname.split('/').at(-1)!;
}

test('rejoin with a fresh link after leaving works for the same member', async (t) => {
  const f = await fixture(t);
  const joined = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME);
  assert.equal(joined.ok, true, joined.raw);
  const guest = joined.guest!;
  const rejoinCode = await hostRejoinLink(f, guest.agentId);
  assert.ok(rejoinCode, 'host issues a rejoin link for a live guest member');
  // A rejoin (with the member's recovery code) keeps the same member: same agent, same room,
  // fresh credential.
  assert.match(guest.recoveryCode ?? '', /^crk_[A-Za-z0-9_-]{43}$/);
  const back = await joinWithInvite(
    f.transport,
    rejoinCode!,
    SMOKE_GUEST_NAME,
    undefined,
    undefined,
    guest.recoveryCode,
  );
  assert.equal(back.ok, true, back.raw);
  assert.equal(back.guest!.agentId, guest.agentId);
  assert.equal(back.guest!.roomId, guest.roomId);
  assert.notEqual(back.guest!.credential, guest.credential);
  // The old credential stops working; the fresh one reads, lists and posts.
  const stale = await readAsGuest(f.transport, guest.credential);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'room_credential_denied');
  assert.ok(!stale.raw.includes(guest.credential));
  const read = await readAsGuest(f.transport, back.guest!.credential);
  assert.equal(read.ok, true, read.raw);
  const members = await listMembersAsGuest(f.transport, back.guest!.credential);
  assert.equal(members.ok, true, members.raw);
  assert.ok(members.memberIds.includes(guest.agentId));
  const posted = await postAsGuest(
    f.transport,
    back.guest!.credential,
    SMOKE_POST_TEXT,
    randomUUID(),
  );
  assert.equal(posted.ok, true, posted.raw);
});

test('a rejoin link works once: the second redemption is refused', async (t) => {
  const f = await fixture(t);
  const joined = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME);
  assert.equal(joined.ok, true, joined.raw);
  const rejoinCode = await hostRejoinLink(f, joined.guest!.agentId);
  assert.ok(rejoinCode);
  const recovery = joined.guest!.recoveryCode;
  const first = await joinWithInvite(
    f.transport,
    rejoinCode!,
    SMOKE_GUEST_NAME,
    undefined,
    undefined,
    recovery,
  );
  assert.equal(first.ok, true, first.raw);
  const second = await joinWithInvite(
    f.transport,
    rejoinCode!,
    SMOKE_GUEST_NAME,
    undefined,
    undefined,
    first.guest!.recoveryCode,
  );
  assert.equal(second.ok, false);
  assert.equal(second.code, 'invite_invalid');
  assert.ok(!second.raw.includes(rejoinCode!));
});

test('a removed (banned) member gets no rejoin link and no rejoin', async (t) => {
  const f = await fixture(t);
  const joined = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME);
  assert.equal(joined.ok, true, joined.raw);
  const guest = joined.guest!;
  const removed = await f.post(
    `/api/rooms/${f.roomId}/members/${guest.agentId}/remove`,
    {},
    f.host,
  );
  assert.equal(removed.statusCode, 200, removed.body);
  // Uniform 404 for a removed member: no host oracle on whether the member existed.
  assert.equal(await hostRejoinLink(f, guest.agentId), null);
});
