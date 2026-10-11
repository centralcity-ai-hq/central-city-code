import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { rpcResult } from './oauth-helpers.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-room-leave-test-root-secret';

/**
 * Member self-leave (first-run audit P1): REST for console members, city_room_leave on /mcp and
 * /mcp/open for invited guests (whose room credential is revoked), the host refused (it closes the
 * room instead), replay, the host's "<name> left" event, and rejoining after leaving. Synthetic
 * data only.
 */
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};
let address = 20;

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
  const account = async (name: string) => {
    const registered = await post(
      '/api/auth/register',
      { name, password: 'Synthetic room leave password' },
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
  const host = await account('Leave host');
  const room = await post(
    '/api/rooms',
    { name: 'Leave room', agent_id: host.agentId, idempotency_key: randomUUID() },
    { cookie: host.cookie },
  );
  assert.equal(room.statusCode, 201, room.body);
  const roomId = room.json().room.id as string;
  const roomLink = room.json().link.link as string;
  const joinLink = await post('/api/links', { target: 'room', room_id: roomId }, host);
  assert.equal(joinLink.statusCode, 201, joinLink.body);
  const code = new URL(joinLink.json().url).pathname.split('/').at(-1)!;
  const members = async (cookie = host.cookie) => {
    const res = await get(`/api/rooms/${roomId}/members`, { cookie });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().members as Array<{ id: string; name: string; role: string }>;
  };
  const events = async (cookie: string) => {
    const res = await get('/api/snapshot', { cookie });
    assert.equal(res.statusCode, 200, res.body);
    return (res.json().events as Array<{ type: string; message: string }>).map(
      (e) => `${e.type}: ${e.message}`,
    );
  };
  return { app, post, get, account, host, roomId, roomLink, code, members, events };
}

async function rpc(app: Awaited<ReturnType<typeof fixture>>['app'], method: string, params = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp/open',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: 'centralcity.ai',
      'x-forwarded-proto': 'https',
    },
    payload: { jsonrpc: '2.0', id: 1, method, params },
    remoteAddress: '203.0.113.12',
  });
  assert.equal(response.statusCode, 200, response.body);
  return rpcResult(response.body);
}
const callOpen = async (
  app: Awaited<ReturnType<typeof fixture>>['app'],
  name: string,
  args: unknown,
) => (await rpc(app, 'tools/call', { name, arguments: args })).result;

test('invited guest leaves on /mcp/open: membership ends, credential revoked, host sees it left', async (t) => {
  const f = await fixture(t);
  const listed = (await rpc(f.app, 'tools/list')).result.tools as Array<{
    name: string;
    annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  }>;
  const tool = listed.find((x) => x.name === 'city_room_leave');
  assert.ok(tool, 'city_room_leave is listed on /mcp/open');
  assert.equal(tool!.annotations.readOnlyHint, false);
  assert.equal(tool!.annotations.destructiveHint, true);

  const joined = await callOpen(f.app, 'city_join_invite', {
    invite_link: `https://centralcity.ai/j/${f.code}`,
    name: 'Guest AI',
  });
  assert.ok(!joined.isError, JSON.stringify(joined));
  const { room_credential, agent_id } = joined.structuredContent;
  assert.ok((await f.members()).some((m) => m.id === agent_id));

  const left = await callOpen(f.app, 'city_room_leave', { room_credential });
  assert.ok(!left.isError, JSON.stringify(left));
  assert.deepEqual(left.structuredContent, { room_id: f.roomId, agent_id, left: true });
  assert.ok(!(await f.members()).some((m) => m.id === agent_id), 'no longer a member');
  // The credential is revoked in the same transaction: every room tool now refuses it.
  const read = await callOpen(f.app, 'city_room_read', { room_credential });
  assert.ok(read.isError, JSON.stringify(read));
  const row = await f.app.city.db.query<{ revoked_at: string | null; removed_by: string }>(
    `SELECT c.revoked_at, m.removed_by FROM room_invite_credentials c
       JOIN room_members m ON m.room_id=c.room_id AND m.agent_id=c.agent_id WHERE c.agent_id=$1`,
    [agent_id],
  );
  assert.ok(row.rows[0]!.revoked_at !== null);
  assert.equal(row.rows[0]!.removed_by, 'left');
  const audit = await f.app.city.db.query<{ action: string }>(
    'SELECT action FROM room_events WHERE room_id=$1 AND agent_id=$2 ORDER BY created_at',
    [f.roomId, agent_id],
  );
  assert.deepEqual(
    audit.rows.map((r) => r.action),
    ['member.joined', 'member.left'],
  );
  assert.ok(
    (await f.events(f.host.cookie)).includes('room.member_left: Guest AI left Leave room.'),
  );
});

test('the host cannot leave (it closes the room); a console member leaves, replays and rejoins', async (t) => {
  const f = await fixture(t);
  const hostLeave = await f.post(`/api/rooms/${f.roomId}/leave`, {}, { cookie: f.host.cookie });
  assert.equal(hostLeave.statusCode, 400, hostLeave.body);
  assert.equal(hostLeave.json().code, 'host_cannot_leave');
  assert.match(hostLeave.json().message ?? hostLeave.body, /Close the room/);

  const member = await f.account('Member');
  const join = () =>
    f.post(
      `/api/rooms/${f.roomId}/join`,
      { link: f.roomLink, agent_id: member.agentId, idempotency_key: randomUUID() },
      { cookie: member.cookie },
    );
  assert.equal((await join()).statusCode, 200);
  // The host agent, the host as a person (in its room from creation) and the member.
  assert.equal((await f.members()).length, 3);

  const leave = () => f.post(`/api/rooms/${f.roomId}/leave`, {}, { cookie: member.cookie });
  const first = await leave();
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { room_id: f.roomId, agent_id: member.agentId, left: true });
  assert.equal((await f.members()).length, 2);
  // A retry after the leave answers left: false; the room is gone from the member's list.
  const again = await leave();
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().left, false);
  const rooms = await f.get('/api/rooms', { cookie: member.cookie });
  assert.deepEqual(rooms.json().rooms, []);
  const read = await f.get(`/api/rooms/${f.roomId}/messages`, { cookie: member.cookie });
  assert.equal(read.statusCode, 404);
  assert.ok(
    (await f.events(f.host.cookie)).includes('room.member_left: Member agent left Leave room.'),
  );
  assert.ok(
    (await f.events(member.cookie)).some((e) =>
      e.startsWith('room.left: Member agent left Leave room'),
    ),
  );

  // Leaving is not removal: the member can rejoin with a valid link, as a fresh member.
  const back = await join();
  assert.equal(back.statusCode, 200, back.body);
  assert.equal(back.json().joined, true);
  assert.equal((await f.members()).length, 3);
  const cursor = await f.app.city.db.query<{ last_read_seq: string; removed_at: string | null }>(
    'SELECT last_read_seq, removed_at FROM room_members WHERE room_id=$1 AND agent_id=$2',
    [f.roomId, member.agentId],
  );
  assert.equal(cursor.rows[0]!.removed_at, null);
  assert.equal(Number(cursor.rows[0]!.last_read_seq), 0);

  // A member the host removed still cannot rejoin.
  const removed = await f.post(
    `/api/rooms/${f.roomId}/members/${member.agentId}/remove`,
    {},
    { cookie: f.host.cookie },
  );
  assert.equal(removed.statusCode, 200, removed.body);
  const refused = await join();
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().code, 'removed_from_room');
  // And leaving after a removal is not a replay: the room is simply not found.
  assert.equal((await leave()).statusCode, 404);
});

test('leaving first never dodges a removal: the host sees recent leavers and can still ban them', async (t) => {
  const f = await fixture(t);
  const member = await f.account('Dodger');
  const join = () =>
    f.post(
      `/api/rooms/${f.roomId}/join`,
      { link: f.roomLink, agent_id: member.agentId, idempotency_key: randomUUID() },
      { cookie: member.cookie },
    );
  assert.equal((await join()).statusCode, 200);
  const left = await f.post(`/api/rooms/${f.roomId}/leave`, {}, { cookie: member.cookie });
  assert.equal(left.json().left, true);

  // The host (only) lists recent leavers.
  const list = await f.get(`/api/rooms/${f.roomId}/left`, { cookie: f.host.cookie });
  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(
    list.json().left.map((m: { id: string; name: string }) => [m.id, m.name]),
    [[member.agentId, 'Dodger agent']],
  );
  const other = await f.get(`/api/rooms/${f.roomId}/left`, { cookie: member.cookie });
  assert.equal(other.statusCode, 404);

  // Removing the leaver turns the row into a host removal.
  const removed = await f.post(
    `/api/rooms/${f.roomId}/members/${member.agentId}/remove`,
    {},
    { cookie: f.host.cookie },
  );
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().removed, true);
  const row = await f.app.city.db.query<{ removed_by: string }>(
    'SELECT removed_by FROM room_members WHERE room_id=$1 AND agent_id=$2',
    [f.roomId, member.agentId],
  );
  assert.notEqual(row.rows[0]!.removed_by, 'left');
  const audit = await f.app.city.db.query<{ action: string }>(
    'SELECT action FROM room_events WHERE room_id=$1 AND agent_id=$2 ORDER BY created_at',
    [f.roomId, member.agentId],
  );
  assert.deepEqual(
    audit.rows.map((r) => r.action),
    ['member.joined', 'member.left', 'member.removed'],
  );
  // No longer listed as a leaver; rejoining with a valid link is refused.
  const after = await f.get(`/api/rooms/${f.roomId}/left`, { cookie: f.host.cookie });
  assert.deepEqual(after.json().left, []);
  const refused = await join();
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().code, 'removed_from_room');
  // A second removal is a no-op.
  const again = await f.post(
    `/api/rooms/${f.roomId}/members/${member.agentId}/remove`,
    {},
    { cookie: f.host.cookie },
  );
  assert.equal(again.json().removed, false);
});
