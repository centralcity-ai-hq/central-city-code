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
  renewAsGuest,
  type SmokeTransport,
} from '../scripts/smoke/ai-guest.js';
import { sessionPair } from './session-cookie-pair.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-renew-test-root-stand-in';

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
    name: 'Renew host',
    password: 'Synthetic renew test password',
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
    { name: 'Renew room', agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
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
  return {
    app,
    post,
    host,
    roomId,
    code,
    transport,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test('a guest renews its credential before expiry; the old one only reads, briefly', async (t) => {
  const f = await fixture(t);
  const joined = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME);
  assert.equal(joined.ok, true, joined.raw);
  const first = joined.guest!;
  const renewed = await renewAsGuest(f.transport, first.credential);
  assert.equal(renewed.ok, true, renewed.raw);
  assert.ok(renewed.credential);
  assert.notEqual(renewed.credential, first.credential);
  assert.ok(!renewed.raw.includes(first.credential));
  // The old credential still reads for 10 minutes (grace) but cannot post; then it stops.
  const graced = await readAsGuest(f.transport, first.credential);
  assert.equal(graced.ok, true, graced.raw);
  const oldPost = await postAsGuest(f.transport, first.credential, SMOKE_POST_TEXT, randomUUID());
  assert.equal(oldPost.ok, false);
  assert.equal(oldPost.code, 'room_credential_denied');
  // The hint names the new credential, never another renew (an AI would loop).
  assert.match(
    oldPost.raw,
    /You already renewed: use the room_credential that city_room_renew returned/,
  );
  f.advance(10 * 60_000 + 1);
  const stale = await readAsGuest(f.transport, first.credential);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'room_credential_denied');
  assert.ok(!stale.raw.includes(first.credential));
  // The new credential is live for the same member: read, members and post work.
  const read = await readAsGuest(f.transport, renewed.credential!);
  assert.equal(read.ok, true, read.raw);
  const members = await listMembersAsGuest(f.transport, renewed.credential!);
  assert.equal(members.ok, true, members.raw);
  assert.ok(members.memberIds.includes(first.agentId));
  const posted = await postAsGuest(f.transport, renewed.credential!, SMOKE_POST_TEXT, randomUUID());
  assert.equal(posted.ok, true, posted.raw);
});

test('renew after expiry is refused', async (t) => {
  const f = await fixture(t);
  const joined = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME);
  assert.equal(joined.ok, true, joined.raw);
  const guest = joined.guest!;
  f.advance(86_400_000 + 1);
  const renewed = await renewAsGuest(f.transport, guest.credential);
  assert.equal(renewed.ok, false);
  // Expired, not "denied": the answer points at a rejoin link, never at another renew (#767).
  assert.equal(renewed.code, 'room_credential_expired');
  assert.ok(!renewed.raw.includes(guest.credential));
});

test('renew after the host removes the member is refused', async (t) => {
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
  const renewed = await renewAsGuest(f.transport, guest.credential);
  assert.equal(renewed.ok, false);
  // The member hears why.
  assert.equal(renewed.code, 'removed_from_room');
  assert.ok(!renewed.raw.includes(guest.credential));
});

test('a keyed join replayed after a renew never returns the superseded credential', async (t) => {
  const f = await fixture(t);
  const key = randomUUID();
  const joined = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME, key);
  assert.equal(joined.ok, true, joined.raw);
  const first = joined.guest!;
  const renewed = await renewAsGuest(f.transport, first.credential);
  assert.equal(renewed.ok, true, renewed.raw);
  f.advance(60_000);
  const replay = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME, key);
  assert.ok(!replay.raw.includes(first.credential), replay.raw);
  assert.equal(replay.ok, false, replay.raw);
  assert.equal(replay.code, 'room_credential_invalid');
  // The renewed credential stays live.
  const read = await readAsGuest(f.transport, renewed.credential!);
  assert.equal(read.ok, true, read.raw);
});
