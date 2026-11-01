import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CityLimits } from '../server/limits.js';
import { createApp } from '../server/app.js';
import {
  SMOKE_GUEST_NAME,
  SMOKE_POST_TEXT,
  assertNotProductionTarget,
  callForeignTool,
  injectTransport,
  joinWithInvite,
  listMembersAsGuest,
  postAsGuest,
  readAsGuest,
  runAiGuestRefusals,
  runAiGuestSmoke,
  type SmokeTransport,
} from '../scripts/smoke/ai-guest.js';
import { sessionPair } from './session-cookie-pair.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-smoke-test-root-stand-in';

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
    name: 'Smoke host',
    password: 'Synthetic smoke test password',
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
    { name: 'Smoke room', agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
    host,
  );
  assert.equal(room.statusCode, 201, room.body);
  const roomId = room.json().room.id;
  const link = await post('/api/links', { target: 'room', room_id: roomId }, host);
  assert.equal(link.statusCode, 201, link.body);
  const created = link.json() as { id: string; url: string };
  const code = new URL(created.url).pathname.split('/').at(-1)!;
  const linkId = created.id;
  const invoke = (credential: string, tool: string, args: unknown = {}) =>
    post(`/api/public/invites/tools/${tool}`, args, { authorization: `Bearer ${credential}` });
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
    linkId,
    invoke,
    transport,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test('the harness passes end to end exactly like an external AI', async (t) => {
  const f = await fixture(t);
  const report = await runAiGuestSmoke(f.transport, { invite: `${ORIGIN}/j/${f.code}` });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(
    report.steps.map((step) => step.name),
    ['invite-doc', 'join', 'post', 'read', 'members'],
  );
  const post = report.steps.find((step) => step.name === 'post')!;
  assert.match(post.note, /^message #\d+$/);
});

test('wrong codes, unknown credentials and foreign tools are refused', async (t) => {
  const f = await fixture(t);
  const report = await runAiGuestRefusals(f.transport);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(
    report.steps.map((step) => step.name),
    ['wrong-code', 'unknown-credential', 'open-rejects-foreign-tool'],
  );
});

test('a revoked link refuses the guest with invite_invalid', async (t) => {
  const f = await fixture(t);
  const revoked = await f.post(`/api/links/${f.linkId}/revoke`, {}, f.host);
  assert.equal(revoked.statusCode, 200, revoked.body);
  // The full flow fails, and the join itself is refused with the uniform code.
  const report = await runAiGuestSmoke(f.transport, { invite: f.code });
  assert.equal(report.ok, false);
  const joined = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME);
  assert.equal(joined.ok, false);
  assert.equal(joined.code, 'invite_invalid');
  assert.ok(!joined.raw.includes(f.code));
  assert.equal((await f.app.city.db.query('SELECT * FROM room_invite_credentials')).rows.length, 0);
});

test('a removed member is refused without leaking the credential', async (t) => {
  const f = await fixture(t);
  const joined = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME);
  assert.equal(joined.ok, true);
  const guest = joined.guest!;
  const removed = await f.post(
    `/api/rooms/${f.roomId}/members/${guest.agentId}/remove`,
    {},
    f.host,
  );
  assert.equal(removed.statusCode, 200, removed.body);
  const read = await readAsGuest(f.transport, guest.credential);
  assert.equal(read.ok, false);
  assert.equal(read.code, 'removed_from_room');
  assert.ok(!read.raw.includes(guest.credential));
  const members = await listMembersAsGuest(f.transport, guest.credential);
  assert.equal(members.ok, false);
  assert.equal(members.code, 'removed_from_room');
  assert.ok(!members.raw.includes(guest.credential));
});

test('other tools with the room credential are refused', async (t) => {
  const f = await fixture(t);
  const joined = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME);
  assert.equal(joined.ok, true);
  const guest = joined.guest!;
  const direct = await f.invoke(guest.credential, 'city_create_agent', { name: 'Escalation' });
  // An unknown guest tool is a 404 that names the four guest tools (Relay live test).
  assert.equal(direct.statusCode, 404, direct.body);
  assert.equal(direct.json().code, 'unknown_tool');
  const foreign = await callForeignTool(f.transport);
  assert.ok(Boolean(foreign.error) || foreign.result?.isError === true);
  assert.ok(!foreign.raw.includes(guest.credential));
  // The guest's own room tools still work: refusal is scoped, not a dead credential.
  const posted = await postAsGuest(f.transport, guest.credential, SMOKE_POST_TEXT, randomUUID());
  assert.equal(posted.ok, true);
});

test('a wrong or expired code gives the uniform invite_invalid', async (t) => {
  const f = await fixture(t);
  const first = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME);
  assert.equal(first.ok, true);
  const unknown = await joinWithInvite(f.transport, 'Q'.repeat(43), SMOKE_GUEST_NAME);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'invite_invalid');
  assert.ok(!unknown.raw.includes('Q'.repeat(43)));
  f.advance(24 * 3_600_000 + 1);
  const expired = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME, randomUUID());
  assert.equal(expired.ok, false);
  assert.equal(expired.code, 'invite_invalid');
});

test('production origins are refused without --allow-production', () => {
  const prior = process.env.CITY_PUBLIC_ORIGIN;
  process.env.CITY_PUBLIC_ORIGIN = 'https://smoke-prod.example.com';
  try {
    for (const baseUrl of [
      'https://centralcity.ai',
      'https://centralcity.ai/j/abc',
      'https://preview.centralcity.ai',
      'https://smoke-prod.example.com',
      'https://deep.smoke-prod.example.com',
    ])
      assert.throws(() => assertNotProductionTarget(baseUrl), /Refusing smoke run against/);
    // Previews are the intended target and stay allowed.
    for (const baseUrl of [
      'https://smoke-preview-1.vercel.app',
      'http://localhost:3000',
      'https://city-preview.example.com',
    ])
      assert.doesNotThrow(() => assertNotProductionTarget(baseUrl));
  } finally {
    if (prior === undefined) delete process.env.CITY_PUBLIC_ORIGIN;
    else process.env.CITY_PUBLIC_ORIGIN = prior;
  }
});
