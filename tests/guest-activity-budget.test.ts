import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CityLimits } from '../server/limits.js';
import { createApp } from '../server/app.js';
import { sessionPair } from './session-cookie-pair.js';
import {
  SMOKE_GUEST_NAME,
  injectTransport,
  joinWithInvite,
  readAsGuest,
  renewAsGuest,
  type SmokeTransport,
} from '../scripts/smoke/ai-guest.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-guest-budget-test-root-stand-in';

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
    name: 'Budget host',
    password: 'Synthetic guest budget test password',
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
    { name: 'Budget room', agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
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

/** One guest tool call over REST with the guest's bearer credential. */
const tool = (f: Awaited<ReturnType<typeof fixture>>, credential: string, name: string) =>
  f.app.inject({
    method: 'POST',
    url: `/api/public/invites/tools/${name}`,
    headers: { ...headers, authorization: `Bearer ${credential}` },
    payload: '{}',
    remoteAddress: '203.0.113.12',
  });
const renewRest = (f: Awaited<ReturnType<typeof fixture>>, credential: string) =>
  f.app.inject({
    method: 'POST',
    url: '/api/public/invites/renew',
    headers: { ...headers, authorization: `Bearer ${credential}` },
    payload: '{}',
    remoteAddress: '203.0.113.12',
  });

test('one busy guest spends only its own activity budget, not the other guests of the host', async (t) => {
  const f = await fixture(t, { apiRequestsPerMinute: 100_000 });
  const busy = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME);
  assert.equal(busy.ok, true, busy.raw);
  const other = await joinWithInvite(f.transport, f.code, 'Second guest');
  assert.equal(other.ok, true, other.raw);
  let limited = 0;
  for (let i = 0; i < 125; i++) {
    const res = await tool(f, busy.guest!.credential, 'city_room_members');
    if (res.statusCode === 429) limited++;
    else assert.equal(res.statusCode, 200, res.body);
  }
  // The busy guest meets its own 120 per minute (its join already spent a few).
  assert.ok(limited >= 5, `limited ${limited}`);
  // The other guest of the same host still reads and renews.
  const read = await readAsGuest(f.transport, other.guest!.credential);
  assert.equal(read.ok, true, read.raw);
  const renewed = await renewAsGuest(f.transport, other.guest!.credential);
  assert.equal(renewed.ok, true, renewed.raw);
});

test('a removed guest that keeps calling renew never limits the remaining guests', async (t) => {
  const f = await fixture(t, { apiRequestsPerMinute: 100_000 });
  const removedGuest = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME);
  assert.equal(removedGuest.ok, true, removedGuest.raw);
  const other = await joinWithInvite(f.transport, f.code, 'Second guest');
  assert.equal(other.ok, true, other.raw);
  const removed = await f.post(
    `/api/rooms/${f.roomId}/members/${removedGuest.guest!.agentId}/remove`,
    {},
    f.host,
  );
  assert.equal(removed.statusCode, 200, removed.body);
  for (let i = 0; i < 130; i++) {
    const res = await renewRest(f, removedGuest.guest!.credential);
    assert.ok([403, 429].includes(res.statusCode), res.body);
  }
  const read = await readAsGuest(f.transport, other.guest!.credential);
  assert.equal(read.ok, true, read.raw);
  const renewed = await renewAsGuest(f.transport, other.guest!.credential);
  assert.equal(renewed.ok, true, renewed.raw);
});
