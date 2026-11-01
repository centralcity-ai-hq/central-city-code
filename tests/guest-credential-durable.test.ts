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
  callOpenTool,
  readAsGuest,
  type SmokeTransport,
} from '../scripts/smoke/ai-guest.js';
import { sessionPair } from './session-cookie-pair.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-durable-test-root-stand-in';

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
  const database = await PGlite.create('memory://');
  const app = await createApp({
    database,
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
    database,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type F = Awaited<ReturnType<typeof fixture>>;

async function joined(f: F) {
  const j = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME);
  assert.equal(j.ok, true, j.raw);
  return j.guest!;
}
async function expiresAt(f: F, agentId: string) {
  const r = await f.database.query<{ expires_at: string | number }>(
    'SELECT expires_at FROM room_invite_credentials WHERE agent_id=$1',
    [agentId],
  );
  return Number(r.rows[0]!.expires_at);
}
const tool = (f: F, credential: string, name: string, body: unknown = {}) =>
  f.post(`/api/public/invites/tools/${name}`, body, { authorization: `Bearer ${credential}` });
const renew = (f: F, credential: string, body: unknown = {}) =>
  f.post('/api/public/invites/renew', body, { authorization: `Bearer ${credential}` });
const now = async (f: F, agentId: string) => (await expiresAt(f, agentId)) - DAY;

test('a call after 5 hours idle slides the expiry back to 24 hours', async (t) => {
  const f = await fixture(t);
  const g = await joined(f);
  const issued = await expiresAt(f, g.agentId);
  f.advance(5 * HOUR);
  const read = await tool(f, g.credential, 'city_room_read');
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(await expiresAt(f, g.agentId), issued + 5 * HOUR);
});

test('no extension while more than 20 hours are left', async (t) => {
  const f = await fixture(t);
  const g = await joined(f);
  const issued = await expiresAt(f, g.agentId);
  f.advance(3 * HOUR);
  assert.equal((await tool(f, g.credential, 'city_room_read')).statusCode, 200);
  assert.equal(await expiresAt(f, g.agentId), issued);
});

test('the absolute cap stops sliding 30 days after issue', async (t) => {
  const f = await fixture(t);
  const g = await joined(f);
  const issued = await now(f, g.agentId);
  for (let i = 0; i < 40; i++) {
    f.advance(20 * HOUR);
    const read = await tool(f, g.credential, 'city_room_read');
    if (read.statusCode !== 200) break;
  }
  const cap = issued + 30 * DAY;
  assert.equal(await expiresAt(f, g.agentId), cap);
  f.advance(30 * DAY);
  const late = await tool(f, g.credential, 'city_room_read');
  assert.equal(late.statusCode, 401, late.body);
});

test('a removed member is not extended and is refused', async (t) => {
  const f = await fixture(t);
  const g = await joined(f);
  const issued = await expiresAt(f, g.agentId);
  const removed = await f.post(`/api/rooms/${f.roomId}/members/${g.agentId}/remove`, {}, f.host);
  assert.equal(removed.statusCode, 200, removed.body);
  f.advance(5 * HOUR);
  const read = await tool(f, g.credential, 'city_room_read');
  assert.notEqual(read.statusCode, 200, read.body);
  assert.equal(await expiresAt(f, g.agentId), issued);
  f.advance(20 * HOUR);
  assert.equal((await tool(f, g.credential, 'city_room_read')).statusCode, 401);
});

test('renew with the same key twice returns the identical credential', async (t) => {
  const f = await fixture(t);
  const g = await joined(f);
  const key = randomUUID();
  const first = await renew(f, g.credential, { idempotency_key: key });
  assert.equal(first.statusCode, 200, first.body);
  f.advance(60_000);
  const again = await renew(f, g.credential, { idempotency_key: key });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().credential, first.json().credential);
  assert.match(first.json().credential, /^crc_[A-Za-z0-9_-]{43}$/);
  // Over MCP too, and a different key is refused (never a second rotation).
  const mcp = await callOpenTool(f.transport, 'city_room_renew', {
    room_credential: g.credential,
    idempotency_key: key,
  });
  assert.equal(mcp.result?.structuredContent?.['room_credential'], first.json().credential);
  const other = await renew(f, g.credential, { idempotency_key: randomUUID() });
  assert.equal(other.statusCode, 401, other.body);
  assert.equal(other.json().error?.code ?? other.json().code, 'room_credential_invalid');
  // The new credential is the live one.
  const read = await tool(f, first.json().credential, 'city_room_read');
  assert.equal(read.statusCode, 200, read.body);
});

test('the old credential in grace can read but cannot post', async (t) => {
  const f = await fixture(t);
  const g = await joined(f);
  const next = await renew(f, g.credential);
  assert.equal(next.statusCode, 200, next.body);
  f.advance(5 * 60_000);
  const read = await tool(f, g.credential, 'city_room_read');
  assert.equal(read.statusCode, 200, read.body);
  const mcpRead = await readAsGuest(f.transport, g.credential);
  assert.equal(mcpRead.ok, true, mcpRead.raw);
  const post = await tool(f, g.credential, 'city_room_post', {
    text: 'old credential',
    idempotency_key: randomUUID(),
  });
  assert.equal(post.statusCode, 401, post.body);
  assert.match(post.body, /room_credential_invalid/);
  assert.match(post.body, /renewed credential/);
  const ok = await tool(f, next.json().credential, 'city_room_post', {
    text: 'new credential',
    idempotency_key: randomUUID(),
  });
  assert.equal(ok.statusCode, 200, ok.body);
});

test('the old credential is refused after 10 minutes', async (t) => {
  const f = await fixture(t);
  const g = await joined(f);
  assert.equal((await renew(f, g.credential)).statusCode, 200);
  f.advance(10 * 60_000 + 1);
  const read = await tool(f, g.credential, 'city_room_read');
  assert.equal(read.statusCode, 401, read.body);
  assert.match(read.body, /room_credential_invalid/);
});

test('renew without a key still rotates to a random credential', async (t) => {
  const f = await fixture(t);
  const g = await joined(f);
  const a = await renew(f, g.credential);
  assert.equal(a.statusCode, 200, a.body);
  assert.notEqual(a.json().credential, g.credential);
  // The previous one in grace cannot rotate again (no key): it is told to use the renewed one.
  const twice = await renew(f, g.credential);
  assert.equal(twice.statusCode, 401, twice.body);
  assert.match(twice.body, /renewed credential/);
  const b = await renew(f, a.json().credential);
  assert.equal(b.statusCode, 200, b.body);
  assert.notEqual(b.json().credential, a.json().credential);
});

const cap = async (f: F, agentId: string) =>
  Number(
    (
      await f.database.query<{ absolute_expires_at: string | number }>(
        'SELECT absolute_expires_at FROM room_invite_credentials WHERE agent_id=$1',
        [agentId],
      )
    ).rows[0]!.absolute_expires_at,
  );
/** Renew every 20 hours up to `days` after issue; returns the live credential. */
async function renewTo(f: F, credential: string, days: number) {
  let live = credential;
  for (let elapsed = 0; elapsed + 20 * HOUR <= days * DAY; elapsed += 20 * HOUR) {
    f.advance(20 * HOUR);
    const r = await renew(f, live);
    assert.equal(r.statusCode, 200, r.body);
    live = r.json().credential;
  }
  return live;
}

test('renew never moves the 30-day cap: near day 29 the expiry stops at day 30', async (t) => {
  const f = await fixture(t);
  const g = await joined(f);
  const issued = await now(f, g.agentId);
  const limit = issued + 30 * DAY;
  assert.equal(await cap(f, g.agentId), limit);
  // 34 renews of 20 hours: day 28 plus 8 hours.
  const live = await renewTo(f, g.credential, 29);
  assert.equal(await cap(f, g.agentId), limit);
  // Day 29 plus 4 hours: capped at day 30, not 24 hours later.
  f.advance(20 * HOUR);
  const near = await renew(f, live);
  assert.equal(near.statusCode, 200, near.body);
  assert.equal(Date.parse(near.json().expires_at), limit);
  assert.equal(await expiresAt(f, g.agentId), limit);
  assert.equal(await cap(f, g.agentId), limit);
  // After day 30 the renew is refused with the clear message.
  f.advance(20 * HOUR);
  const late = await renew(f, near.json().credential);
  assert.equal(late.statusCode, 403, late.body);
  assert.match(late.body, /room_credential_denied/);
  assert.match(late.body, /rejoin link/);
});

test('renew at the cap is refused: ask the host for a rejoin link', async (t) => {
  const f = await fixture(t);
  const g = await joined(f);
  const issued = await now(f, g.agentId);
  // Push the cap to just ahead of the live expiry so the credential is live but at its cap.
  await f.database.query(
    'UPDATE room_invite_credentials SET absolute_expires_at=$2 WHERE agent_id=$1',
    [g.agentId, issued + HOUR],
  );
  f.advance(HOUR);
  const refused = await renew(f, g.credential);
  assert.equal(refused.statusCode, 403, refused.body);
  assert.match(refused.body, /room_credential_denied/);
  assert.match(refused.body, /rejoin link/);
  assert.match(refused.body, /recovery code/);
});

test('a keyed renew retry does not move the cap', async (t) => {
  const f = await fixture(t);
  const g = await joined(f);
  const before = await cap(f, g.agentId);
  f.advance(10 * HOUR);
  const key = randomUUID();
  const first = await renew(f, g.credential, { idempotency_key: key });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(await cap(f, g.agentId), before);
  f.advance(5 * 60_000);
  const again = await renew(f, g.credential, { idempotency_key: key });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().credential, first.json().credential);
  assert.equal(again.json().expires_at, first.json().expires_at);
  assert.equal(await cap(f, g.agentId), before);
});

test('only a rejoin (host link plus recovery code) starts a fresh 30-day window', async (t) => {
  const f = await fixture(t);
  const g = await joined(f);
  const issued = await now(f, g.agentId);
  await renewTo(f, g.credential, 29);
  assert.equal(await cap(f, g.agentId), issued + 30 * DAY);
  // The host signs in again (its session from day 0 has ended).
  const login = await f.post('/api/auth/login', {
    name: 'Renew host',
    password: 'Synthetic renew test password',
  });
  assert.equal(login.statusCode, 200, login.body);
  const link = await f.post(
    `/api/rooms/${f.roomId}/members/${g.agentId}/rejoin-link`,
    {},
    { cookie: sessionPair(login.cookies) },
  );
  assert.equal(link.statusCode, 200, link.body);
  const rejoinCode = new URL(link.json().link).pathname.split('/').at(-1)!;
  const back = await joinWithInvite(
    f.transport,
    rejoinCode,
    SMOKE_GUEST_NAME,
    undefined,
    undefined,
    g.recoveryCode,
  );
  assert.equal(back.ok, true, back.raw);
  const rejoinedAt = (await expiresAt(f, g.agentId)) - DAY;
  assert.ok(rejoinedAt > issued + 28 * DAY);
  assert.equal(await cap(f, g.agentId), rejoinedAt + 30 * DAY);
  f.advance(10 * HOUR);
  const r = await renew(f, back.guest!.credential);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(Date.parse(r.json().expires_at), rejoinedAt + 10 * HOUR + DAY);
});

for (const renews of [1, 2, 3]) {
  test(`a join replay after ${renews} renew(s) is refused, never a second membership`, async (t) => {
    const f = await fixture(t);
    const key = randomUUID();
    const first = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME, key);
    assert.equal(first.ok, true, first.raw);
    let credential = first.guest!.credential;
    for (let i = 0; i < renews; i++) {
      const r = await renew(f, credential);
      assert.equal(r.statusCode, 200, r.body);
      credential = r.json().credential;
    }
    // Past the old credential's grace period, the same join is replayed with the same key.
    f.advance(11 * 60_000);
    const again = await joinWithInvite(f.transport, f.code, SMOKE_GUEST_NAME, key);
    assert.equal(again.ok, false, again.raw);
    assert.match(again.raw, /renewed/);
    const members = await f.database.query<{ n: string | number }>(
      'SELECT count(*) AS n FROM room_invite_credentials WHERE room_id=$1',
      [f.roomId],
    );
    assert.equal(Number(members.rows[0]!.n), 1, 'one guest membership');
    const read = await tool(f, credential, 'city_room_read');
    assert.equal(read.statusCode, 200, read.body);
  });
}

test('a credential idle past its expiry says so and points at the rejoin, never at renew', async (t) => {
  const f = await fixture(t);
  const g = await joined(f);
  f.advance(25 * HOUR);
  const read = await tool(f, g.credential, 'city_room_read');
  assert.equal(read.statusCode, 401, read.body);
  assert.equal(read.json().code, 'room_credential_expired');
  assert.match(read.json().error, /expired/);
  // Renewing an expired credential is refused the same way, not as "only permits its room".
  const renewed = await renew(f, g.credential);
  assert.equal(renewed.statusCode, 401, renewed.body);
  assert.equal(renewed.json().code, 'room_credential_expired');
  // Over MCP the guidance names the rejoin, not city_room_renew.
  const mcp = await callOpenTool(f.transport, 'city_room_read', { room_credential: g.credential });
  const error = JSON.parse(String(mcp.result!.content![0]!.text)).error;
  assert.equal(error.code, 'room_credential_expired');
  assert.equal(error.next?.tool, 'city_join_invite');
  assert.match(error.hint, /rejoin link .* recovery_code/);
  assert.doesNotMatch(error.hint, /city_room_renew/);
});
