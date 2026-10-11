import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { rpcResult } from './oauth-helpers.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-room-allow-back-test-root-secret';

/**
 * "Allow back in" (the Members panel's Removed section): GET /api/rooms/:room/removed lists
 * host-removed members whose owners cannot rejoin, host only, and a second remove with
 * block_rejoin: false lifts the ban (the owner rejoins with a live link). Members who left on
 * their own are not listed (Recently left has them), nor are account-less guests (their block is
 * their network's). Synthetic data only.
 */
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};
let address = 40;

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
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
  const post = (url: string, body: unknown, extra = {}, remoteAddress = '203.0.113.40') =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress,
    });
  const get = (url: string, extra = {}) =>
    app.inject({ method: 'GET', url, headers: { ...headers, ...extra } });
  const account = async (name: string) => {
    const registered = await post(
      '/api/auth/register',
      { name, password: 'Synthetic allow-back password' },
      {},
      `203.0.113.${address++}`,
    );
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const agent = await post(
      '/api/agents',
      { name: `${name} agent`, capability: 'research', mode: 'hosted' },
      { cookie },
    );
    assert.equal(agent.statusCode, 201, agent.body);
    return { cookie, agentId: agent.json().agent.id as string };
  };
  const host = await account('Allow host');
  const room = await post(
    '/api/rooms',
    { name: 'Allow back room', agent_id: host.agentId, idempotency_key: randomUUID() },
    { cookie: host.cookie },
  );
  assert.equal(room.statusCode, 201, room.body);
  const roomId = room.json().room.id as string;
  const roomLink = room.json().link.link as string;
  const joinLink = await post('/api/links', { target: 'room', room_id: roomId }, host);
  assert.equal(joinLink.statusCode, 201, joinLink.body);
  const code = new URL(joinLink.json().url).pathname.split('/').at(-1)!;
  const join = (member: { cookie: string; agentId: string }) =>
    post(
      `/api/rooms/${roomId}/join`,
      { link: roomLink, agent_id: member.agentId, idempotency_key: randomUUID() },
      { cookie: member.cookie },
    );
  const remove = (agentId: string, body = {}, cookie = host.cookie) =>
    post(`/api/rooms/${roomId}/members/${agentId}/remove`, body, { cookie });
  const removed = async (cookie = host.cookie) => {
    const res = await get(`/api/rooms/${roomId}/removed`, { cookie });
    return res;
  };
  return { app, post, get, account, host, roomId, roomLink, code, join, remove, removed };
}

async function callOpen(
  app: Awaited<ReturnType<typeof fixture>>['app'],
  name: string,
  args: unknown,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp/open',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: 'centralcity.ai',
      'x-forwarded-proto': 'https',
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    remoteAddress: '203.0.113.40',
  });
  assert.equal(response.statusCode, 200, response.body);
  return rpcResult(response.body).result;
}

test('Removed lists a banned member, host only; Allow back in lifts the ban and they rejoin', async (t) => {
  const f = await fixture(t);
  const member = await f.account('Member');
  assert.equal((await f.join(member)).statusCode, 200);

  // Nothing removed yet: the list is empty (and members never see it).
  assert.deepEqual((await f.removed()).json().removed, []);
  const asMember = await f.removed(member.cookie);
  assert.equal(asMember.statusCode, 403, asMember.body);
  assert.equal(asMember.json().code, 'host_required');

  // The host removes the member (default: the owner cannot rejoin).
  const gone = await f.remove(member.agentId, { reason: 'Cooling off.' });
  assert.equal(gone.statusCode, 200, gone.body);
  const listed = (await f.removed()).json().removed as Array<{
    id: string;
    name: string;
    owner_label: string;
    removed_at: string;
  }>;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, member.agentId);
  assert.equal(listed[0]!.name, 'Member agent');
  assert.ok(Date.parse(listed[0]!.removed_at));
  // Banned: rejoining with a live link is refused.
  const refused = await f.join(member);
  assert.equal(refused.statusCode, 403, refused.body);

  // Allow back in: a second remove with block_rejoin: false lifts only the ban.
  const allow = await f.remove(member.agentId, { block_rejoin: false });
  assert.equal(allow.statusCode, 200, allow.body);
  assert.equal(allow.json().removed, false);
  assert.equal(allow.json().rejoin_allowed, true);
  assert.deepEqual((await f.removed()).json().removed, []);
  const back = await f.join(member);
  assert.equal(back.statusCode, 200, back.body);
  assert.equal(back.json().joined, true);

  // The audit line is the server's.
  const audit = await f.app.city.db.query<{ action: string }>(
    "SELECT action FROM room_events WHERE room_id=$1 AND agent_id=$2 AND action='member.rejoin_allowed'",
    [f.roomId, member.agentId],
  );
  assert.equal(audit.rows.length, 1);
});

test('self-left and account-less guests are not in Removed; a banned self-leaver is', async (t) => {
  const f = await fixture(t);

  // A member who left on their own is Recently left, not Removed.
  const leaver = await f.account('Leaver');
  assert.equal((await f.join(leaver)).statusCode, 200);
  const left = await f.post(`/api/rooms/${f.roomId}/leave`, {}, { cookie: leaver.cookie });
  assert.equal(left.statusCode, 200, left.body);
  assert.deepEqual((await f.removed()).json().removed, []);

  // Banning the leaver turns the row into a host removal: now it is in Removed.
  const banned = await f.remove(leaver.agentId, {});
  assert.equal(banned.statusCode, 200, banned.body);
  assert.deepEqual(
    ((await f.removed()).json().removed as Array<{ id: string }>).map((entry) => entry.id),
    [leaver.agentId],
  );

  // An account-less guest (invite link) is removed too: its block is its network's, so Removed
  // stays the leaver only.
  const guest = await callOpen(f.app, 'city_join_invite', {
    invite_link: `https://centralcity.ai/j/${f.code}`,
    name: 'Guest AI',
  });
  assert.ok(!guest.isError, JSON.stringify(guest));
  const guestRemoved = await f.remove(guest.structuredContent.agent_id, {});
  assert.equal(guestRemoved.statusCode, 200, guestRemoved.body);
  assert.equal(guestRemoved.json().guest_source_blocked, true);
  assert.deepEqual(
    ((await f.removed()).json().removed as Array<{ id: string }>).map((entry) => entry.id),
    [leaver.agentId],
  );

  // Allowing the banned leaver back drops it from Removed too.
  const allow = await f.remove(leaver.agentId, { block_rejoin: false });
  assert.equal(allow.json().rejoin_allowed, true);
  assert.deepEqual((await f.removed()).json().removed, []);
});
