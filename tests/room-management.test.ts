import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import type { RoomLimits } from '../server/rooms/contract.js';
import { PGlite } from '@electric-sql/pglite';
import { createRoomTasks } from '../server/rooms/tasks-service.js';
import { callOpenTool, injectTransport, outcomeErrorCode } from '../scripts/smoke/ai-guest.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-room-management-test-root-not-a-real-secret';

/**
 * Room management (docs/ROOMS.md "Room management", migration 35): rename and topic, host delete
 * with confirm_name (tombstone, content erased, links revoked, 410 room_deleted), removal with a
 * reason and an optional rejoin, and the host's mute of a member. Console REST, the MCP host tools
 * and the no-account guest tools (/mcp/open).
 * Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
type Owner = { id: string; key: string; cookie: string };
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

async function fixture(
  t: { after: (fn: () => Promise<unknown>) => void },
  rooms: Partial<RoomLimits> = {},
) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, rooms });
  t.after(() => app.close());
  return app;
}
function call(app: App, key: string, name: string, args: unknown = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify(args),
  });
}
async function ok(app: App, key: string, name: string, args: unknown = {}) {
  const res = await call(app, key, name, args);
  assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
  return res.json();
}
/** The owner console (a signed-in co-owner acting in the workspace). */
function rest(app: App, who: Owner, method: string, url: string, body?: unknown) {
  return app.inject({
    method: method as 'GET',
    url,
    headers: { ...jsonHeaders, cookie: who.cookie, 'x-city-workspace': who.id },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
/** The signed-in co-owner in their own account (no workspace selected): a person. */
function self(app: App, who: Owner, method: string, url: string, body?: unknown) {
  return app.inject({
    method: method as 'GET',
    url,
    headers: { ...jsonHeaders, cookie: who.cookie },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
/**
 * `who`'s co-owner joins the room as a person from their own account and gets its member id. The
 * same join from the AI workspace's console is refused first: an invite never adds an AI
 * workspace as a person (404 room_not_found, like an unknown room).
 */
async function joinAsPerson(app: App, who: Owner, link: string, roomId: string, name: string) {
  const body = () => ({ link, name, idempotency_key: randomUUID() });
  const fromWorkspace = await rest(app, who, 'POST', '/api/rooms/join', body());
  assert.equal(fromWorkspace.statusCode, 404, fromWorkspace.body);
  assert.equal(fromWorkspace.json().code, 'room_not_found');
  const joined = await self(app, who, 'POST', '/api/rooms/join', body());
  assert.equal(joined.statusCode, 200, joined.body);
  return personIdOf(app, roomId, name);
}
/** The id of `who`'s co-owner's own account: the owner of the person it joins as. */
async function accountOf(app: App, who: Owner) {
  const res = await self(app, who, 'GET', '/api/session');
  assert.equal(res.statusCode, 200, res.body);
  return res.json().operator.id as string;
}
let addressCounter = 1;
/** An AI-owned workspace claimed by a person, with a key holding every scope. */
async function owner(app: App, name: string): Promise<Owner> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.30`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({
      name: `Owner ${addressCounter}`,
      password: 'Synthetic management password',
    }),
    remoteAddress: `198.51.${addressCounter++}.31`,
  });
  assert.equal(person.statusCode, 201, person.body);
  const cookie = `cc_session=${person.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/workspaces/claim',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ claim_token: res.json().claim_token }),
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const minted = await app.inject({
    method: 'POST',
    url: '/api/workspace-keys',
    headers: { ...jsonHeaders, cookie, 'x-city-workspace': id },
    payload: JSON.stringify({ label: 'room host', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return { id, key: minted.json().workspace_key as string, cookie };
}
async function agent(app: App, key: string, name: string) {
  const body = await ok(app, key, 'city_create_agent', {
    name,
    description: 'Synthetic room member',
    capability: 'research',
    mode: 'external',
    idempotencyKey: randomUUID(),
  });
  return body.agent.id as string;
}
/** A room of host `a` with member agents of `b` (and more owners when given). */
async function room(app: App, name = 'Synthetic desk') {
  const a = await owner(app, 'Host workspace');
  const b = await owner(app, 'Member workspace');
  const hostAgent = await agent(app, a.key, 'Host desk');
  const bravo = await agent(app, b.key, 'Bravo');
  const created = await ok(app, a.key, 'city_create_room', {
    agent_id: hostAgent,
    name,
    topic: 'First topic',
    idempotency_key: randomUUID(),
  });
  const roomId = created.room.id as string;
  const link = created.link.link as string;
  await ok(app, b.key, 'city_join_room', { link, agent_id: bravo, idempotency_key: randomUUID() });
  return { a, b, hostAgent, bravo, roomId, link };
}
async function texts(app: App, who: Owner, roomId: string) {
  const res = await rest(app, who, 'GET', `/api/rooms/${roomId}/messages?limit=100`);
  assert.equal(res.statusCode, 200, res.body);
  return (res.json().messages as Array<{ text: string; sender_kind: string }>).map(
    (m) => `${m.sender_kind}: ${m.text}`,
  );
}

test('PATCH /api/rooms/:room renames and changes the topic (host only, cleaned, one line each)', async (t) => {
  const app = await fixture(t);
  const { a, b, roomId } = await room(app);
  // Bidi and zero-width characters are removed; whitespace collapses.
  const renamed = await rest(app, a, 'PATCH', `/api/rooms/${roomId}`, {
    name: '  Design‮  re​view ',
    topic: 'Ship the⁦ room page',
  });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().changed, true);
  assert.equal(renamed.json().room.name, 'Design review');
  assert.equal(renamed.json().room.topic, 'Ship the room page');
  assert.deepEqual((await texts(app, a, roomId)).slice(-2), [
    'system: The host renamed the room.',
    'system: The host updated the room topic.',
  ]);
  // The same values again: nothing changes, no line.
  const same = await rest(app, a, 'PATCH', `/api/rooms/${roomId}`, { name: 'Design review' });
  assert.equal(same.json().changed, false);
  assert.equal((await texts(app, a, roomId)).length, 2);
  // Clearing the topic is a change.
  const cleared = await rest(app, a, 'PATCH', `/api/rooms/${roomId}`, { topic: '' });
  assert.equal(cleared.json().room.topic, '');
  // Validation as at creation: 1..80 characters, no control characters; empty after cleaning.
  for (const [body, code] of [
    [{ name: 'x'.repeat(81) }, 400],
    [{ name: 'line\nbreak' }, 400],
    [{ name: '​‎' }, 400],
    [{}, 400],
    [{ name: 'Fine', slug: 'nope' }, 400],
    [{ topic: 'y'.repeat(281) }, 400],
  ] as const) {
    const res = await rest(app, a, 'PATCH', `/api/rooms/${roomId}`, body);
    assert.equal(res.statusCode, code, `${JSON.stringify(body)}: ${res.body}`);
  }
  const empty = await rest(app, a, 'PATCH', `/api/rooms/${roomId}`, { name: '​‎' });
  assert.equal(empty.json().code, 'invalid_name');
  // A member is told it is not the host; an outsider learns nothing.
  const member = await rest(app, b, 'PATCH', `/api/rooms/${roomId}`, { name: 'Mine now' });
  assert.equal(member.statusCode, 403);
  assert.equal(member.json().code, 'host_required');
  const c = await owner(app, 'Outsider workspace');
  const outsider = await rest(app, c, 'PATCH', `/api/rooms/${roomId}`, { name: 'Mine now' });
  assert.equal(outsider.statusCode, 404);
  // The MCP host tool takes name and topic too.
  const tool = await ok(app, a.key, 'city_room_update', { room_id: roomId, name: 'Tool name' });
  assert.equal(tool.room.name, 'Tool name');
  assert.equal(tool.changed, true);
  // A closed room keeps its name.
  await ok(app, a.key, 'city_room_close', { room_id: roomId });
  const closed = await rest(app, a, 'PATCH', `/api/rooms/${roomId}`, { name: 'Too late' });
  assert.equal(closed.statusCode, 409);
  assert.equal(closed.json().code, 'room_closed');
});

test('remove with a reason: only the removed member sees it; the rejoin block is the default', async (t) => {
  const app = await fixture(t);
  const { a, b, bravo, roomId, link } = await room(app);
  const removed = await rest(app, a, 'POST', `/api/rooms/${roomId}/members/${bravo}/remove`, {
    reason: 'Off‮ topic,\n  again',
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(removed.json(), {
    room_id: roomId,
    agent_id: bravo,
    removed: true,
    guest_source_blocked: false,
  });
  // The thread says who was removed, never why.
  const thread = await texts(app, a, roomId);
  assert.equal(thread.at(-1), 'system: Bravo was removed by the host.');
  assert.ok(!thread.some((line) => line.includes('Off topic')));
  // The removed owner hears the reason (cleaned) on every read, over REST and MCP.
  const read = await rest(app, b, 'GET', `/api/rooms/${roomId}/messages`);
  assert.equal(read.statusCode, 403);
  assert.equal(read.json().code, 'removed_from_room');
  assert.deepEqual(read.json().details, { reason: 'Off topic, again', may_rejoin: false });
  assert.match(read.json().error, /Off topic, again/);
  const tool = await call(app, b.key, 'city_room_read', { room_id: roomId });
  assert.equal(tool.statusCode, 403, tool.body);
  assert.equal(tool.json().code, 'removed_from_room');
  // Blocked by default: the owner cannot rejoin with any agent and a live link.
  const other = await agent(app, b.key, 'Bravo two');
  const rejoin = await call(app, b.key, 'city_join_room', {
    link,
    agent_id: other,
    idempotency_key: randomUUID(),
  });
  assert.equal(rejoin.statusCode, 403, rejoin.body);
  assert.equal(rejoin.json().code, 'removed_from_room');
  // Bounds: at most 200 characters, never a credential, no unknown fields.
  const c = await owner(app, 'Third workspace');
  const charlie = await agent(app, c.key, 'Charlie');
  await ok(app, c.key, 'city_join_room', {
    link,
    agent_id: charlie,
    idempotency_key: randomUUID(),
  });
  for (const [body, code] of [
    [{ reason: 'x'.repeat(201) }, 'invalid_request'],
    [{ reason: `use crr_${'A'.repeat(43)}` }, 'credential_in_message'],
    [{ block_rejoin: 'no' }, 'invalid_request'],
    [{ ban: true }, 'invalid_request'],
  ] as const) {
    const res = await rest(app, a, 'POST', `/api/rooms/${roomId}/members/${charlie}/remove`, body);
    assert.equal(res.statusCode, 400, res.body);
    if (code === 'credential_in_message') assert.equal(res.json().code, code);
  }
});

test('block_rejoin: false lets the removed owner rejoin with a live link (MCP host tool)', async (t) => {
  const app = await fixture(t);
  const { a, b, bravo, roomId, link } = await room(app);
  const removed = await ok(app, a.key, 'city_room_remove', {
    room_id: roomId,
    agent_id: bravo,
    reason: 'Take a break',
    block_rejoin: false,
  });
  assert.equal(removed.removed, true);
  const read = await call(app, b.key, 'city_room_read', { room_id: roomId });
  assert.equal(read.statusCode, 403);
  assert.deepEqual(read.json().details, { reason: 'Take a break', may_rejoin: true });
  // The same agent rejoins in place; the reason is gone with the removal.
  const rejoined = await ok(app, b.key, 'city_join_room', {
    link,
    agent_id: bravo,
    idempotency_key: randomUUID(),
  });
  assert.equal(rejoined.joined, true);
  const row = (
    await app.city.db.query<{
      removed_at: string | null;
      removal_reason: string | null;
      rejoin_allowed: boolean;
    }>('SELECT removed_at, removal_reason, rejoin_allowed FROM room_members WHERE agent_id=$1', [
      bravo,
    ])
  ).rows[0]!;
  assert.deepEqual(row, { removed_at: null, removal_reason: null, rejoin_allowed: false });
  await ok(app, b.key, 'city_room_read', { room_id: roomId });
});

test('the host allows a blocked owner back: remove again with block_rejoin: false', async (t) => {
  const app = await fixture(t);
  const { a, b, bravo, roomId, link } = await room(app);
  await ok(app, a.key, 'city_room_remove', { room_id: roomId, agent_id: bravo });
  const blocked = await call(app, b.key, 'city_room_read', { room_id: roomId });
  assert.deepEqual(blocked.json().details, { reason: null, may_rejoin: false });
  // A plain second removal changes nothing and does not lift the ban.
  const again = await ok(app, a.key, 'city_room_remove', { room_id: roomId, agent_id: bravo });
  assert.equal(again.removed, false);
  assert.equal(again.rejoin_allowed, undefined);
  // Only the host can allow it back.
  const byMember = await call(app, b.key, 'city_room_remove', {
    room_id: roomId,
    agent_id: bravo,
    block_rejoin: false,
  });
  assert.notEqual(byMember.statusCode, 200, byMember.body);
  const allowed = await ok(app, a.key, 'city_room_remove', {
    room_id: roomId,
    agent_id: bravo,
    block_rejoin: false,
  });
  assert.equal(allowed.removed, false);
  assert.equal(allowed.rejoin_allowed, true);
  const read = await call(app, b.key, 'city_room_read', { room_id: roomId });
  assert.equal(read.json().details.may_rejoin, true);
  const rejoined = await ok(app, b.key, 'city_join_room', {
    link,
    agent_id: bravo,
    idempotency_key: randomUUID(),
  });
  assert.equal(rejoined.joined, true);
  await ok(app, b.key, 'city_room_read', { room_id: roomId });
  const audit = await app.city.db.query<{ action: string }>(
    "SELECT action FROM room_events WHERE room_id=$1 AND action='member.rejoin_allowed'",
    [roomId],
  );
  assert.equal(audit.rows.length, 1);
});

test('mute: host only; a muted owner cannot post (any agent, after rejoin) and sees the reason', async (t) => {
  const app = await fixture(t);
  const { a, b, bravo, hostAgent, roomId, link } = await room(app);
  const bOwner = (
    await app.city.db.query<{ owner_id: string }>(
      'SELECT owner_id FROM room_members WHERE agent_id=$1',
      [bravo],
    )
  ).rows[0]!.owner_id;
  await app.city.db.query(
    `INSERT INTO wake_webhooks(id,agent_id,owner_id,url,events,salt,created_at,created_by)
      VALUES('hook-bravo',$1,$2,'https://hooks.example.test/wake',ARRAY['room_post','mention'],'00',0,'test')`,
    [bravo, bOwner],
  );
  const say = (text: string) =>
    rest(app, a, 'POST', `/api/rooms/${roomId}/messages`, {
      text,
      idempotency_key: randomUUID(),
    });
  const counts = async () => {
    const q = async (sql: string) =>
      Number((await app.city.db.query<{ n: string }>(sql, [bravo])).rows[0]!.n);
    return {
      mentions: await q('SELECT count(*) AS n FROM mentions WHERE agent_id=$1'),
      outbox: await q('SELECT count(*) AS n FROM wake_outbox WHERE agent_id=$1'),
    };
  };
  const bravoPost = (text = 'Hello') =>
    call(app, b.key, 'city_room_post', {
      room_id: roomId,
      agent_id: bravo,
      text,
      idempotency_key: randomUUID(),
    });
  assert.equal((await say('@Bravo first')).statusCode, 201);
  assert.deepEqual(await counts(), { mentions: 1, outbox: 1 });
  await app.city.db.query('DELETE FROM wake_outbox');

  // Only the host mutes: a member hears host_required, an outsider 404; the host is never muted.
  const c = await owner(app, 'Outsider workspace');
  const byMember = await rest(app, b, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: bravo,
    muted: true,
  });
  assert.equal(byMember.statusCode, 403, byMember.body);
  assert.equal(byMember.json().code, 'host_required');
  const byOutsider = await rest(app, c, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: bravo,
    muted: true,
  });
  assert.equal(byOutsider.statusCode, 404, byOutsider.body);
  const host = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: hostAgent,
    muted: true,
  });
  assert.equal(host.statusCode, 400, host.body);
  assert.equal(host.json().code, 'cannot_mute_host');
  // Owner isolation: an agent that is not in this room (another owner's, another room's) is 404.
  const charlie = await agent(app, c.key, 'Charlie');
  const stranger = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: charlie,
    muted: true,
  });
  assert.equal(stranger.statusCode, 404, stranger.body);
  assert.equal(stranger.json().code, 'member_not_found');
  // Bounds: agent_id and muted required, reason at most 200 characters and never a credential.
  for (const [body, code] of [
    [{ muted: true }, 'invalid_request'],
    [{ agent_id: bravo }, 'invalid_request'],
    [{ agent_id: bravo, muted: true, reason: 'x'.repeat(201) }, 'invalid_request'],
    [
      { agent_id: bravo, muted: true, reason: `use crr_${'A'.repeat(43)}` },
      'credential_in_message',
    ],
  ] as const) {
    const res = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, body);
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)}: ${res.body}`);
    if (code === 'credential_in_message') assert.equal(res.json().code, code);
  }

  const muted = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: bravo,
    muted: true,
    reason: 'Too‮ many\n pings',
  });
  assert.equal(muted.statusCode, 200, muted.body);
  assert.deepEqual(muted.json(), {
    room_id: roomId,
    agent_id: bravo,
    muted: true,
    reason: 'Too many pings',
  });
  // Nothing in the thread says so.
  assert.ok(!(await texts(app, a, roomId)).some((line) => line.includes('pings')));
  // The muted owner cannot post, over MCP or REST, and hears the reason.
  const refused = await bravoPost();
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().code, 'muted_in_room');
  assert.deepEqual(refused.json().details, { reason: 'Too many pings' });
  assert.match(refused.json().error, /Too many pings/);
  const viaRest = await rest(app, b, 'POST', `/api/rooms/${roomId}/messages`, {
    agent_id: bravo,
    text: 'From the console',
    idempotency_key: randomUUID(),
  });
  assert.equal(viaRest.statusCode, 403, viaRest.body);
  assert.equal(viaRest.json().code, 'muted_in_room');
  // Its console view says so, with the reason; the host's view does not.
  const listed = (await rest(app, b, 'GET', '/api/rooms'))
    .json()
    .rooms.find((r: { id: string }) => r.id === roomId);
  assert.equal(listed.muted, true);
  assert.equal(listed.mute_reason, 'Too many pings');
  assert.equal(listed.mute_scope, 'all');
  const hostView = (await rest(app, a, 'GET', '/api/rooms'))
    .json()
    .rooms.find((r: { id: string }) => r.id === roomId);
  assert.equal(hostView.muted, false);
  // Another agent of the same owner is silenced too (the mute is per owner, like a removal).
  const bravo2 = await agent(app, b.key, 'Bravo two');
  await ok(app, b.key, 'city_join_room', { link, agent_id: bravo2, idempotency_key: randomUUID() });
  const second = await call(app, b.key, 'city_room_post', {
    room_id: roomId,
    agent_id: bravo2,
    text: 'Sneaky',
    idempotency_key: randomUUID(),
  });
  assert.equal(second.statusCode, 403, second.body);
  assert.equal(second.json().code, 'muted_in_room');
  // Leaving and rejoining keeps the mute.
  await ok(app, b.key, 'city_room_leave', { room_id: roomId, agent_id: bravo });
  await ok(app, b.key, 'city_join_room', { link, agent_id: bravo, idempotency_key: randomUUID() });
  assert.equal((await bravoPost()).json().code, 'muted_in_room');
  // Not woken (it could not answer), and still a reader of every message.
  assert.equal((await say('@Bravo second')).statusCode, 201);
  assert.deepEqual(await counts(), { mentions: 1, outbox: 0 });
  // Per owner: the owner's other agent is not woken or mentioned either.
  assert.equal((await say('@Bravo two are you there')).statusCode, 201);
  assert.equal(
    Number(
      (
        await app.city.db.query<{ n: string }>(
          'SELECT count(*) AS n FROM mentions WHERE agent_id=$1',
          [bravo2],
        )
      ).rows[0]!.n,
    ),
    0,
  );
  const page = await ok(app, b.key, 'city_room_read', { room_id: roomId, since: 0 });
  assert.ok(page.messages.some((m: { text: string }) => m.text === '@Bravo second'));
  // The host lists mutes; nobody else can.
  const mutes = await rest(app, a, 'GET', `/api/rooms/${roomId}/mutes`);
  assert.equal(mutes.statusCode, 200, mutes.body);
  assert.deepEqual(
    mutes
      .json()
      .muted.map((m: { agent_id: string; reason: string; active: boolean }) => [
        m.agent_id,
        m.reason,
        m.active,
      ]),
    [[bravo, 'Too many pings', true]],
  );
  assert.equal((await rest(app, b, 'GET', `/api/rooms/${roomId}/mutes`)).statusCode, 403);
  assert.equal((await rest(app, c, 'GET', `/api/rooms/${roomId}/mutes`)).statusCode, 404);

  // Unmuting lifts it for the whole owner.
  const unmuted = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: bravo2,
    muted: false,
  });
  assert.equal(unmuted.statusCode, 200, unmuted.body);
  assert.equal(unmuted.json().muted, false);
  assert.equal((await bravoPost('Back')).statusCode, 200);
  assert.equal((await say('@Bravo third')).statusCode, 201);
  assert.deepEqual(await counts(), { mentions: 2, outbox: 1 });
  assert.deepEqual((await rest(app, a, 'GET', `/api/rooms/${roomId}/mutes`)).json().muted, []);
  // A closed room takes no mutes.
  await ok(app, a.key, 'city_room_close', { room_id: roomId });
  const closed = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: bravo,
    muted: true,
  });
  assert.equal(closed.statusCode, 409, closed.body);
});

test('rename and remove are host only over MCP too; a blocked owner cannot rejoin by any link', async (t) => {
  const app = await fixture(t);
  const { a, b, bravo, roomId, link } = await room(app);
  const c = await owner(app, 'Third workspace');
  const charlie = await agent(app, c.key, 'Charlie');
  await ok(app, c.key, 'city_join_room', {
    link,
    agent_id: charlie,
    idempotency_key: randomUUID(),
  });
  // A member cannot rename or remove; an outsider learns nothing.
  const rename = await call(app, b.key, 'city_room_update', { room_id: roomId, name: 'Mine' });
  assert.equal(rename.statusCode, 403, rename.body);
  assert.equal(rename.json().code, 'host_required');
  const remove = await call(app, b.key, 'city_room_remove', { room_id: roomId, agent_id: charlie });
  assert.equal(remove.statusCode, 403, remove.body);
  const restRemove = await rest(
    app,
    b,
    'POST',
    `/api/rooms/${roomId}/members/${charlie}/remove`,
    {},
  );
  assert.equal(restRemove.statusCode, 403, restRemove.body);
  const d = await owner(app, 'Outsider workspace');
  const outsider = await call(app, d.key, 'city_room_update', { room_id: roomId, topic: 'x' });
  assert.equal(outsider.statusCode, 404, outsider.body);
  // Delete and mute are console only for the host; a member's DELETE is host_required.
  assert.equal(
    (await rest(app, b, 'DELETE', `/api/rooms/${roomId}`, { confirm_name: 'Synthetic desk' }))
      .statusCode,
    403,
  );

  // b's co-owner is in the room as a person too, from their own account.
  const bea = await joinAsPerson(app, b, link, roomId, 'Bea');

  // Blocked removal: every way back in is refused, including a link minted afterwards.
  await ok(app, a.key, 'city_room_remove', { room_id: roomId, agent_id: bravo, reason: 'Spam' });
  await ok(app, a.key, 'city_room_remove', { room_id: roomId, agent_id: bea, reason: 'Spam' });
  const rotated = await ok(app, a.key, 'city_room_link', {
    room_id: roomId,
    rotate: true,
    idempotency_key: randomUUID(),
  });
  const joinLink = await rest(app, a, 'POST', '/api/links', { target: 'room', room_id: roomId });
  assert.equal(joinLink.statusCode, 201, joinLink.body);
  const fresh = await agent(app, b.key, 'Bravo again');
  const attempts = [
    await call(app, b.key, 'city_join_room', {
      link: rotated.link,
      agent_id: bravo,
      idempotency_key: randomUUID(),
    }),
    await call(app, b.key, 'city_join_room', {
      link: rotated.link,
      agent_id: fresh,
      idempotency_key: randomUUID(),
    }),
    await call(app, b.key, 'city_join_room', {
      link: joinLink.json().url,
      agent_id: fresh,
      idempotency_key: randomUUID(),
    }),
    await call(app, b.key, 'city_join_room', {
      link: rotated.join_link,
      create: { name: 'Brand new' },
      idempotency_key: randomUUID(),
    }),
    ...(rotated.short_code
      ? [
          await call(app, b.key, 'city_join_room', {
            link: rotated.short_code,
            agent_id: fresh,
            idempotency_key: randomUUID(),
          }),
        ]
      : []),
    // The removed person joining as themselves from their own account.
    await self(app, b, 'POST', '/api/rooms/join', {
      link: rotated.link,
      idempotency_key: randomUUID(),
    }),
  ];
  for (const res of attempts) {
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().code, 'removed_from_room');
    assert.deepEqual(res.json().details, { reason: 'Spam', may_rejoin: false });
  }
  // The AI workspace's console can't come back as a person either: it never joins as one.
  const asPerson = await rest(app, b, 'POST', '/api/rooms/join', {
    link: rotated.link,
    idempotency_key: randomUUID(),
  });
  assert.equal(asPerson.statusCode, 404, asPerson.body);
  assert.equal(asPerson.json().code, 'room_not_found');
  const active = await app.city.db.query(
    'SELECT 1 FROM room_members WHERE room_id=$1 AND owner_id IN (SELECT owner_id FROM room_members WHERE room_id=$1 AND agent_id = ANY($2::text[])) AND removed_at IS NULL',
    [roomId, [bravo, bea]],
  );
  assert.equal(active.rows.length, 0);
});

test('DELETE /api/rooms/:room: confirm_name, erase, revoke, 410 for members, 404 for others', async (t) => {
  const app = await fixture(t);
  const { a, b, bravo, roomId, link } = await room(app, 'Delete me');
  const joinLink = await rest(app, a, 'POST', '/api/links', { target: 'room', room_id: roomId });
  assert.equal(joinLink.statusCode, 201, joinLink.body);
  const said = await rest(app, b, 'POST', `/api/rooms/${roomId}/messages`, {
    text: 'Secret plan for @Host desk',
    idempotency_key: randomUUID(),
  });
  assert.equal(said.statusCode, 201, said.body);
  await app.city.db.query(
    `INSERT INTO room_tasks(id,room_id,number,title,status,created_by_agent_id,created_by_owner_id,created_at,updated_at,idempotency_key,request_hash)
      VALUES('task-1',$1,1,'Synthetic task','open',$2,'owner',0,0,'k','h')`,
    [roomId, bravo],
  );
  // Host only; the name must match exactly.
  const member = await rest(app, b, 'DELETE', `/api/rooms/${roomId}`, {
    confirm_name: 'Delete me',
  });
  assert.equal(member.statusCode, 403);
  assert.equal(member.json().code, 'host_required');
  for (const confirm_name of ['delete me', 'Delete me ', '']) {
    const res = await rest(app, a, 'DELETE', `/api/rooms/${roomId}`, { confirm_name });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().code, 'confirm_name_mismatch');
  }
  assert.equal((await rest(app, a, 'DELETE', `/api/rooms/${roomId}`, {})).statusCode, 400);

  const deleted = await rest(app, a, 'DELETE', `/api/rooms/${roomId}`, {
    confirm_name: 'Delete me',
  });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.deepEqual(deleted.json(), { room_id: roomId, deleted: true });
  // Both sides hear about it in their activity log (members through the chunked notices).
  for (const agentId of [bravo, null]) {
    const ownerId = agentId
      ? (
          await app.city.db.query<{ owner_id: string }>(
            'SELECT owner_id FROM room_members WHERE agent_id=$1',
            [agentId],
          )
        ).rows[0]!.owner_id
      : (
          await app.city.db.query<{ host_owner_id: string }>(
            'SELECT host_owner_id FROM rooms WHERE id=$1',
            [roomId],
          )
        ).rows[0]!.host_owner_id;
    const events = (
      await app.city.db.query<{ events: Array<{ type: string; message: string }> }>(
        "SELECT data->'events' AS events FROM workspaces WHERE operator_id=$1",
        [ownerId],
      )
    ).rows[0]!.events;
    const notice = events.filter((e) => e.type === 'room.deleted');
    assert.equal(notice.length, 1, `${agentId ? 'member' : 'host'} notice`);
    assert.ok(!notice[0]!.message.includes('Delete me'), 'no room name in the notice');
  }

  // Gone from every list; the host and former members hear 410, others 404.
  for (const who of [a, b]) {
    const rooms = (await rest(app, who, 'GET', '/api/rooms')).json().rooms as Array<{ id: string }>;
    assert.ok(!rooms.some((r) => r.id === roomId));
    const read = await rest(app, who, 'GET', `/api/rooms/${roomId}/messages`);
    assert.equal(read.statusCode, 410, read.body);
    assert.equal(read.json().code, 'room_deleted');
  }
  const tool = await call(app, b.key, 'city_room_read', { room_id: roomId });
  assert.equal(tool.json().code, 'room_deleted');
  const c = await owner(app, 'Outsider workspace');
  const outsider = await rest(app, c, 'GET', `/api/rooms/${roomId}/messages`);
  assert.equal(outsider.statusCode, 404);
  // Again: the room is already deleted.
  const again = await rest(app, a, 'DELETE', `/api/rooms/${roomId}`, { confirm_name: 'Delete me' });
  assert.equal(again.statusCode, 410);
  // No link admits anyone: the room link and the join link are revoked.
  const charlie = await agent(app, c.key, 'Charlie');
  const byLink = await call(app, c.key, 'city_join_room', {
    link,
    agent_id: charlie,
    idempotency_key: randomUUID(),
  });
  // A link live when the room ended says it is gone (410), to any holder.
  assert.equal(byLink.statusCode, 410, byLink.body);
  assert.equal(byLink.json().code, 'room_deleted');
  const byCode = await call(app, c.key, 'city_join_room', {
    link: joinLink.json().url,
    agent_id: charlie,
    idempotency_key: randomUUID(),
  });
  assert.equal(byCode.statusCode, 410, byCode.body);
  assert.equal(byCode.json().code, 'room_deleted');
  // Content is erased; the tombstone keeps no name or topic; audit rows stay.
  const count = async (sql: string) =>
    Number((await app.city.db.query<{ n: string }>(sql, [roomId])).rows[0]!.n);
  assert.equal(await count('SELECT count(*) AS n FROM room_messages WHERE room_id=$1'), 0);
  assert.equal(await count('SELECT count(*) AS n FROM room_receipts WHERE room_id=$1'), 0);
  assert.equal(await count('SELECT count(*) AS n FROM mentions WHERE room_id=$1'), 0);
  assert.equal(await count('SELECT count(*) AS n FROM room_tasks WHERE room_id=$1'), 0);
  assert.equal(
    await count('SELECT count(*) AS n FROM room_links WHERE room_id=$1 AND revoked_at IS NULL'),
    0,
  );
  assert.equal(
    await count('SELECT count(*) AS n FROM join_links WHERE room_id=$1 AND revoked_at IS NULL'),
    0,
  );
  assert.equal(
    await count('SELECT count(*) AS n FROM room_members WHERE room_id=$1 AND removed_at IS NULL'),
    0,
  );
  const tomb = (
    await app.city.db.query<{ name: string; topic: string; deleted_at: string | null }>(
      'SELECT name, topic, deleted_at FROM rooms WHERE id=$1',
      [roomId],
    )
  ).rows[0]!;
  assert.equal(tomb.name, '');
  assert.equal(tomb.topic, '');
  assert.ok(tomb.deleted_at !== null);
  assert.equal(
    await count("SELECT count(*) AS n FROM room_events WHERE room_id=$1 AND action='room.deleted'"),
    1,
  );
});

test('room deletion is rate limited per owner', async (t) => {
  const app = await fixture(t, { deletesPerOwnerPerHour: 2 });
  const { a, roomId } = await room(app);
  for (let i = 0; i < 2; i++) {
    const res = await rest(app, a, 'DELETE', `/api/rooms/${roomId}`, { confirm_name: 'wrong' });
    assert.equal(res.statusCode, 400, res.body);
  }
  const limited = await rest(app, a, 'DELETE', `/api/rooms/${roomId}`, {
    confirm_name: 'Synthetic desk',
  });
  assert.equal(limited.statusCode, 429, limited.body);
});

// ---------------------------------------------------------------------------------------------
// Hosted origin: the no-account guest paths (/mcp/open, /api/public/invites) and short codes.

const ORIGIN = 'https://centralcity.ai';
async function hosted(t: { after(fn: () => Promise<unknown>): void }) {
  let now = Date.now();
  const app = await createApp({
    now: () => now,
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  let address = 10;
  const send = (method: string, url: string, body: unknown, extra: Record<string, string> = {}) =>
    app.inject({
      method: method as 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        'x-city-request': '1',
        host: 'centralcity.ai',
        origin: ORIGIN,
        ...extra,
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      remoteAddress: `203.0.113.${address}`,
    });
  const hostedOwner = async (name: string): Promise<Owner> => {
    address++;
    const res = await send('POST', '/api/public/workspaces', {
      name,
      idempotency_key: randomUUID(),
    });
    assert.equal(res.statusCode, 201, res.body);
    const person = await send('POST', '/api/auth/register', {
      name: `Co-owner ${address}`,
      password: 'Synthetic co-owner password',
    });
    assert.equal(person.statusCode, 201, person.body);
    const cookie = `cc_session=${person.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const id = res.json().workspace_id as string;
    assert.equal(
      (
        await send(
          'POST',
          '/api/workspaces/claim',
          { claim_token: res.json().claim_token },
          { cookie },
        )
      ).statusCode,
      200,
    );
    const minted = await send(
      'POST',
      '/api/workspace-keys',
      { label: 'room host', scopes: [...ASSISTANT_SCOPES] },
      { cookie, 'x-city-workspace': id },
    );
    assert.equal(minted.statusCode, 201, minted.body);
    return { id, key: minted.json().workspace_key as string, cookie };
  };
  const tool = (key: string, name: string, args: unknown = {}) =>
    send('POST', `/api/assistant/tools/${name}`, args, { authorization: `Bearer ${key}` });
  const console = (who: Owner, method: string, url: string, body?: unknown) =>
    send(method, url, body, { cookie: who.cookie, 'x-city-workspace': who.id });
  /** The signed-in person in their own account (no workspace selected). */
  const self = (who: Owner, method: string, url: string, body?: unknown) =>
    send(method, url, body, { cookie: who.cookie });
  /** A no-account MCP client at one address (its join source). */
  const transportFrom = (remoteAddress: string) =>
    injectTransport(async (req) => {
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
        remoteAddress,
      });
      return { statusCode: res.statusCode, body: res.body };
    }, ORIGIN);
  const transport = injectTransport(async (req) => {
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
      remoteAddress: '198.51.100.7',
    });
    return { statusCode: res.statusCode, body: res.body };
  }, ORIGIN);
  const guestJoin = async (link: string) => {
    const joined = await callOpenTool(transport, 'city_join_invite', {
      invite_link: link,
      name: 'Guest AI',
      idempotency_key: randomUUID(),
    });
    const structured = joined.result?.structuredContent ?? {};
    assert.ok(structured['room_credential'], joined.raw.slice(0, 600));
    return {
      credential: structured['room_credential'] as string,
      agentId: structured['agent_id'] as string,
    };
  };
  const guestPost = (credential: string, text: string) =>
    callOpenTool(transport, 'city_room_post', {
      room_credential: credential,
      text,
      idempotency_key: randomUUID(),
    });
  const setup = async () => {
    const a = await hostedOwner('Host workspace');
    const b = await hostedOwner('Member workspace');
    const hostAgent = (
      await (
        await tool(a.key, 'city_create_agent', {
          name: 'Host desk',
          description: 'Synthetic room host',
          capability: 'research',
          mode: 'external',
          idempotencyKey: randomUUID(),
        })
      ).json()
    ).agent.id as string;
    const bravo = (
      await (
        await tool(b.key, 'city_create_agent', {
          name: 'Bravo',
          description: 'Synthetic room member',
          capability: 'research',
          mode: 'external',
          idempotencyKey: randomUUID(),
        })
      ).json()
    ).agent.id as string;
    const created = await tool(a.key, 'city_create_room', {
      agent_id: hostAgent,
      name: 'Hosted desk',
      idempotency_key: randomUUID(),
    });
    assert.equal(created.statusCode, 200, created.body);
    const roomId = created.json().room.id as string;
    const link = created.json().link as { link: string; join_link: string; short_code: string };
    const joined = await tool(b.key, 'city_join_room', {
      link: link.link,
      agent_id: bravo,
      idempotency_key: randomUUID(),
    });
    assert.equal(joined.statusCode, 200, joined.body);
    return { a, b, bravo, roomId, link };
  };
  return {
    app,
    tool,
    console,
    self,
    transport,
    transportFrom,
    guestJoin,
    guestPost,
    hostedOwner,
    setup,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('a muted guest (no account) cannot post over /mcp/open and hears the reason', async (t) => {
  const h = await hosted(t);
  const { a, roomId, link } = await h.setup();
  const guest = await h.guestJoin(link.join_link);
  const before = await h.guestPost(guest.credential, 'Hi from a guest');
  assert.equal(outcomeErrorCode(before), null, before.raw.slice(0, 600));
  const muted = await h.console(a, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: guest.agentId,
    muted: true,
    reason: 'Guest spam',
  });
  assert.equal(muted.statusCode, 200, muted.body);
  const after = await h.guestPost(guest.credential, 'Still here');
  assert.equal(outcomeErrorCode(after), 'muted_in_room', after.raw.slice(0, 600));
  assert.match(after.raw, /Guest spam/);
  // It still reads.
  const read = await callOpenTool(h.transport, 'city_room_read', {
    room_credential: guest.credential,
  });
  assert.equal(outcomeErrorCode(read), null, read.raw.slice(0, 600));
});

test('a deleted room is 410 room_deleted everywhere: tools, links, short codes, guests, wake', async (t) => {
  const h = await hosted(t);
  const { a, b, bravo, roomId, link } = await h.setup();
  const guest = await h.guestJoin(link.join_link);
  const deleted = await h.console(a, 'DELETE', `/api/rooms/${roomId}`, {
    confirm_name: 'Hosted desk',
  });
  assert.equal(deleted.statusCode, 200, deleted.body);

  const expect410 = (
    res: { statusCode: number; body: string; json(): { code: string } },
    what: string,
  ) => {
    assert.equal(res.statusCode, 410, `${what}: ${res.body}`);
    assert.equal(res.json().code, 'room_deleted', what);
  };
  // Member and host: REST, MCP, the wake long-poll and every host control.
  expect410(await h.console(b, 'GET', `/api/rooms/${roomId}/messages?wait=1`), 'wake long-poll');
  expect410(await h.console(b, 'GET', `/api/rooms/${roomId}/members`), 'members');
  expect410(
    await h.console(b, 'POST', `/api/rooms/${roomId}/messages`, {
      text: 'Anyone?',
      idempotency_key: randomUUID(),
    }),
    'post',
  );
  expect410(
    await h.tool(b.key, 'city_room_post', {
      room_id: roomId,
      agent_id: bravo,
      text: 'Anyone?',
      idempotency_key: randomUUID(),
    }),
    'city_room_post',
  );
  expect410(await h.tool(a.key, 'city_room_update', { room_id: roomId, name: 'Back' }), 'update');
  expect410(await h.console(a, 'PATCH', `/api/rooms/${roomId}`, { name: 'Back' }), 'rename');
  expect410(
    await h.console(a, 'POST', `/api/rooms/${roomId}/mute`, { agent_id: bravo, muted: true }),
    'mute',
  );
  expect410(
    await h.console(a, 'POST', `/api/rooms/${roomId}/members/${bravo}/remove`, {}),
    'remove',
  );
  expect410(await h.tool(a.key, 'city_room_link', { room_id: roomId }), 'city_room_link');
  // Links of every kind, to a signed-in newcomer: the room link, the join link, the short code.
  const c = await h.hostedOwner('Newcomer workspace');
  for (const value of [link.link, link.join_link, link.short_code])
    expect410(
      await h.tool(c.key, 'city_join_room', {
        link: value,
        create: { name: 'Newcomer' },
        idempotency_key: randomUUID(),
      }),
      `join with ${value.slice(0, 30)}`,
    );
  expect410(
    await h.self(c, 'POST', '/api/rooms/join', {
      link: link.link,
      idempotency_key: randomUUID(),
    }),
    'person join',
  );
  // The same join from the AI workspace's console is no person: the uniform 404, as before any
  // room lookup.
  const fromWorkspace = await h.console(c, 'POST', '/api/rooms/join', {
    link: link.link,
    idempotency_key: randomUUID(),
  });
  assert.equal(fromWorkspace.statusCode, 404, fromWorkspace.body);
  assert.equal(fromWorkspace.json().code, 'room_not_found');
  // No-account guests: joining by link or short code, the REST bootstrap, and a credential
  // holder's tools and renewal.
  for (const value of [link.join_link, link.short_code, link.link]) {
    const joined = await callOpenTool(h.transport, 'city_join_invite', {
      invite_link: value,
      name: 'Late guest',
      idempotency_key: randomUUID(),
    });
    assert.equal(outcomeErrorCode(joined), 'room_deleted', joined.raw.slice(0, 600));
  }
  expect410(
    await h.console(c, 'POST', '/api/public/invites/bootstrap', { code: link.join_link }),
    'bootstrap',
  );
  for (const name of ['city_room_read', 'city_room_post', 'city_room_members', 'city_room_renew']) {
    const res = await callOpenTool(h.transport, name, {
      room_credential: guest.credential,
      ...(name === 'city_room_post' ? { text: 'Hello?', idempotency_key: randomUUID() } : {}),
    });
    assert.equal(outcomeErrorCode(res), 'room_deleted', `${name}: ${res.raw.slice(0, 600)}`);
  }
  // An outsider with no link learns nothing (404).
  const outsider = await h.console(c, 'GET', `/api/rooms/${roomId}/messages`);
  assert.equal(outsider.statusCode, 404, outsider.body);
});

test('a removed guest without an account cannot rejoin from its network by any link', async (t) => {
  const h = await hosted(t);
  const { a, b, bravo, roomId, link } = await h.setup();
  const home = h.transportFrom('192.0.2.44');
  const join = (transport: typeof home, value: string) =>
    callOpenTool(transport, 'city_join_invite', {
      invite_link: value,
      name: 'Returning guest',
      idempotency_key: randomUUID(),
    });
  const joined = await join(home, link.join_link);
  const guestId = joined.result?.structuredContent?.['agent_id'] as string;
  assert.ok(guestId, joined.raw.slice(0, 600));
  const removed = await h.console(a, 'POST', `/api/rooms/${roomId}/members/${guestId}/remove`, {
    reason: 'Spamming the room',
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().guest_source_blocked, true);
  // Only the keyed source hash, the room and the expiry are stored.
  const rows = (
    await h.app.city.db.query<Record<string, unknown>>(
      'SELECT * FROM room_guest_blocks WHERE room_id=$1',
      [roomId],
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['expires_at', 'room_id', 'source_hash']);
  assert.ok(!JSON.stringify(rows).includes('192.0.2.44'));

  // The same link, its short code and the room link are refused from the same source, without
  // the host's reason (someone else on that network may be asking).
  for (const value of [link.join_link, link.short_code, link.link]) {
    const again = await join(home, value);
    assert.equal(outcomeErrorCode(again), 'removed_from_room', again.raw.slice(0, 600));
    assert.ok(!again.raw.includes('Spamming'), 'the reason is never told to the source');
  }
  // So are links minted after the removal.
  const fresh = await h.tool(a.key, 'city_room_link', {
    room_id: roomId,
    rotate: true,
    idempotency_key: randomUUID(),
  });
  assert.equal(fresh.statusCode, 200, fresh.body);
  for (const value of [fresh.json().join_link, fresh.json().short_code, fresh.json().link]) {
    const again = await join(home, value);
    assert.equal(outcomeErrorCode(again), 'removed_from_room', again.raw.slice(0, 600));
  }
  // The REST guest path (bootstrap) is refused too, with may_rejoin false.
  const boot = await h.app.inject({
    method: 'POST',
    url: '/api/public/invites/bootstrap',
    headers: {
      'content-type': 'application/json',
      'x-city-request': '1',
      host: 'centralcity.ai',
      origin: ORIGIN,
    },
    payload: JSON.stringify({ code: fresh.json().join_link }),
    remoteAddress: '192.0.2.44',
  });
  assert.equal(boot.statusCode, 403, boot.body);
  assert.equal(boot.json().code, 'removed_from_room');
  assert.deepEqual(boot.json().details, { reason: null, may_rejoin: false });

  // Another network still joins with the live link; signed-in owners are unaffected.
  const elsewhere = await join(h.transportFrom('198.51.100.90'), fresh.json().join_link);
  assert.ok(elsewhere.result?.structuredContent?.['agent_id'], elsewhere.raw.slice(0, 600));
  const c = await h.hostedOwner('Signed-in newcomer');
  const signedIn = await h.tool(c.key, 'city_join_room', {
    link: fresh.json().link,
    create: { name: 'Signed-in AI' },
    idempotency_key: randomUUID(),
  });
  assert.equal(signedIn.statusCode, 200, signedIn.body);
  // Removing a signed-in member records no source block (its owner is blocked instead).
  const member = await h.console(a, 'POST', `/api/rooms/${roomId}/members/${bravo}/remove`, {});
  assert.equal(member.json().guest_source_blocked, false);
  const back = await h.tool(b.key, 'city_join_room', {
    link: fresh.json().link,
    agent_id: bravo,
    idempotency_key: randomUUID(),
  });
  assert.equal(back.json().code, 'removed_from_room');

  // The block ends after 30 days, and the sweep removes it.
  h.advance(30 * 86_400_000 + 1000);
  const later = await h.tool(a.key, 'city_room_link', {
    room_id: roomId,
    rotate: true,
    idempotency_key: randomUUID(),
  });
  const returned = await join(home, later.json().join_link);
  assert.ok(returned.result?.structuredContent?.['agent_id'], returned.raw.slice(0, 600));
  await h.app.city.tick();
  assert.equal(
    (await h.app.city.db.query('SELECT 1 FROM room_guest_blocks WHERE room_id=$1', [roomId])).rows
      .length,
    0,
  );
});

test('block_rejoin false records no guest source block', async (t) => {
  const h = await hosted(t);
  const { a, roomId, link } = await h.setup();
  const home = h.transportFrom('192.0.2.55');
  const joined = await callOpenTool(home, 'city_join_invite', {
    invite_link: link.join_link,
    name: 'Guest on a break',
    idempotency_key: randomUUID(),
  });
  const guestId = joined.result?.structuredContent?.['agent_id'] as string;
  const removed = await h.tool(a.key, 'city_room_remove', {
    room_id: roomId,
    agent_id: guestId,
    block_rejoin: false,
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().guest_source_blocked, false);
  const again = await callOpenTool(home, 'city_join_invite', {
    invite_link: link.join_link,
    name: 'Guest is back',
    idempotency_key: randomUUID(),
  });
  assert.ok(again.result?.structuredContent?.['agent_id'], again.raw.slice(0, 600));
});
test('members carry guest: true only for invited AIs without an account (REST, MCP, /mcp/open)', async (t) => {
  const h = await hosted(t);
  const { a, b, bravo, roomId, link } = await h.setup();
  const guest = await h.guestJoin(link.join_link);
  const flags = (members: Array<{ id: string; guest?: boolean }>) =>
    Object.fromEntries(members.map((m) => [m.id, m.guest]));
  // The host's console list, a signed-in member's MCP list, and the guest's own view agree.
  const viaRest = await h.console(a, 'GET', `/api/rooms/${roomId}/members`);
  assert.equal(viaRest.statusCode, 200, viaRest.body);
  const rest = flags(viaRest.json().members);
  assert.equal(rest[guest.agentId], true);
  assert.equal(rest[bravo], false);
  assert.equal(Object.values(rest).filter((flag) => flag === true).length, 1);
  assert.ok(
    Object.values(rest).every((flag) => typeof flag === 'boolean'),
    'always sent',
  );
  const viaTool = await h.tool(b.key, 'city_room_members', { room_id: roomId });
  assert.equal(viaTool.statusCode, 200, viaTool.body);
  assert.deepEqual(flags(viaTool.json().members), rest);
  const viaOpen = await callOpenTool(h.transport, 'city_room_members', {
    room_credential: guest.credential,
  });
  assert.equal(outcomeErrorCode(viaOpen), null, viaOpen.raw.slice(0, 600));
  assert.deepEqual(
    flags(viaOpen.result!.structuredContent!['members'] as Array<{ id: string; guest: boolean }>),
    rest,
  );
});

test('the host lifts guest network blocks explicitly; rotating the link keeps them', async (t) => {
  const h = await hosted(t);
  const { a, b, roomId, link } = await h.setup();
  const home = h.transportFrom('192.0.2.66');
  const join = (value: string) =>
    callOpenTool(home, 'city_join_invite', {
      invite_link: value,
      name: 'Blocked guest',
      idempotency_key: randomUUID(),
    });
  const hostView = async () =>
    (await h.console(a, 'GET', '/api/rooms'))
      .json()
      .rooms.find((r: { id: string }) => r.id === roomId);
  assert.equal((await hostView()).guest_blocks, 0);
  const joined = await join(link.join_link);
  const guestId = joined.result?.structuredContent?.['agent_id'] as string;
  assert.ok(guestId, joined.raw.slice(0, 600));
  const removed = await h.console(a, 'POST', `/api/rooms/${roomId}/members/${guestId}/remove`, {});
  assert.equal(removed.json().guest_source_blocked, true);
  assert.equal((await hostView()).guest_blocks, 1);
  // Only the host's console view carries the count.
  const memberView = (await h.console(b, 'GET', '/api/rooms'))
    .json()
    .rooms.find((r: { id: string }) => r.id === roomId);
  assert.equal(memberView.guest_blocks, undefined);

  // Rotating the link (as the removal dialog's "reset the invite link" does) keeps the block.
  const rotated = await h.tool(a.key, 'city_room_link', {
    room_id: roomId,
    rotate: true,
    idempotency_key: randomUUID(),
  });
  assert.equal(rotated.statusCode, 200, rotated.body);
  assert.equal((await hostView()).guest_blocks, 1);
  assert.equal(outcomeErrorCode(await join(rotated.json().join_link)), 'removed_from_room');

  // Only the host lifts blocks: a member hears host_required, an outsider 404.
  const byMember = await h.console(b, 'DELETE', `/api/rooms/${roomId}/guest-blocks`);
  assert.equal(byMember.statusCode, 403, byMember.body);
  assert.equal(byMember.json().code, 'host_required');
  const c = await h.hostedOwner('Outsider workspace');
  const byOutsider = await h.console(c, 'DELETE', `/api/rooms/${roomId}/guest-blocks`);
  assert.equal(byOutsider.statusCode, 404, byOutsider.body);
  assert.equal((await hostView()).guest_blocks, 1);

  const cleared = await h.console(a, 'DELETE', `/api/rooms/${roomId}/guest-blocks`);
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.deepEqual(cleared.json(), { room_id: roomId, cleared: 1 });
  assert.equal((await hostView()).guest_blocks, 0);
  const audited = await h.app.city.db.query(
    "SELECT 1 FROM room_events WHERE room_id=$1 AND action='guest_blocks.cleared'",
    [roomId],
  );
  assert.equal(audited.rows.length, 1);
  // That network may join again with a live link; clearing again lifts nothing.
  const back = await join(rotated.json().join_link);
  assert.ok(back.result?.structuredContent?.['agent_id'], back.raw.slice(0, 600));
  const again = await h.console(a, 'DELETE', `/api/rooms/${roomId}/guest-blocks`);
  assert.deepEqual(again.json(), { room_id: roomId, cleared: 0 });

  // A deleted room answers 410 to its host.
  const room = await hostView();
  await h.console(a, 'DELETE', `/api/rooms/${roomId}`, { confirm_name: room.name });
  const gone = await h.console(a, 'DELETE', `/api/rooms/${roomId}/guest-blocks`);
  assert.equal(gone.statusCode, 410, gone.body);
});

test('a member mutes a room for itself: no wake-up or mention, still reads and posts', async (t) => {
  const app = await fixture(t);
  const { a, b, bravo, roomId, link } = await room(app);
  const bOwner = (
    await app.city.db.query<{ owner_id: string }>(
      'SELECT owner_id FROM room_members WHERE agent_id=$1',
      [bravo],
    )
  ).rows[0]!.owner_id;
  await app.city.db.query(
    `INSERT INTO wake_webhooks(id,agent_id,owner_id,url,events,salt,created_at,created_by)
      VALUES('hook-self',$1,$2,'https://hooks.example.test/wake',ARRAY['room_post','mention'],'00',0,'test')`,
    [bravo, bOwner],
  );
  const bravo2 = await agent(app, b.key, 'Bravo two');
  await ok(app, b.key, 'city_join_room', { link, agent_id: bravo2, idempotency_key: randomUUID() });
  const say = (text: string) =>
    rest(app, a, 'POST', `/api/rooms/${roomId}/messages`, { text, idempotency_key: randomUUID() });
  const counts = async () => {
    const q = async (sql: string, id: string) =>
      Number((await app.city.db.query<{ n: string }>(sql, [id])).rows[0]!.n);
    return {
      mentions:
        (await q('SELECT count(*) AS n FROM mentions WHERE agent_id=$1', bravo)) +
        (await q('SELECT count(*) AS n FROM mentions WHERE agent_id=$1', bravo2)),
      outbox: await q('SELECT count(*) AS n FROM wake_outbox WHERE agent_id=$1', bravo),
    };
  };
  const view = async (who: Owner) =>
    (await rest(app, who, 'GET', '/api/rooms'))
      .json()
      .rooms.find((r: { id: string }) => r.id === roomId);
  assert.equal((await say('@Bravo first')).statusCode, 201);
  assert.deepEqual(await counts(), { mentions: 1, outbox: 1 });
  await app.city.db.query('DELETE FROM wake_outbox');
  assert.equal((await view(b)).notifications_muted, false);

  const muted = await rest(app, b, 'POST', `/api/rooms/${roomId}/notifications`, { muted: true });
  assert.equal(muted.statusCode, 200, muted.body);
  assert.deepEqual(muted.json(), { room_id: roomId, notifications_muted: true });
  assert.equal((await view(b)).notifications_muted, true);
  // Only the viewer's own setting: the host's view is unaffected.
  assert.equal((await view(a)).notifications_muted, false);
  // No wake-up and no mention for any of this owner's agents.
  assert.equal((await say('@Bravo second, @Bravo two too')).statusCode, 201);
  assert.deepEqual(await counts(), { mentions: 1, outbox: 0 });
  // It still reads and posts (unlike the host's mute).
  const page = await ok(app, b.key, 'city_room_read', { room_id: roomId, since: 0 });
  assert.ok(page.messages.some((m: { text: string }) => m.text.startsWith('@Bravo second')));
  const posted = await call(app, b.key, 'city_room_post', {
    room_id: roomId,
    agent_id: bravo,
    text: 'Still here',
    idempotency_key: randomUUID(),
  });
  assert.equal(posted.statusCode, 200, posted.body);
  // Leaving and rejoining keeps the setting.
  await ok(app, b.key, 'city_room_leave', { room_id: roomId, agent_id: bravo2 });
  await ok(app, b.key, 'city_join_room', { link, agent_id: bravo2, idempotency_key: randomUUID() });
  assert.equal((await view(b)).notifications_muted, true);

  const unmuted = await rest(app, b, 'POST', `/api/rooms/${roomId}/notifications`, {
    muted: false,
  });
  assert.deepEqual(unmuted.json(), { room_id: roomId, notifications_muted: false });
  assert.equal((await say('@Bravo third')).statusCode, 201);
  assert.deepEqual(await counts(), { mentions: 2, outbox: 1 });
  // Members only; the body is exactly { muted }.
  const c = await owner(app, 'Outsider workspace');
  assert.equal(
    (await rest(app, c, 'POST', `/api/rooms/${roomId}/notifications`, { muted: true })).statusCode,
    404,
  );
  for (const body of [{}, { muted: 'yes' }, { muted: true, agent_id: bravo }])
    assert.equal(
      (await rest(app, b, 'POST', `/api/rooms/${roomId}/notifications`, body)).statusCode,
      400,
    );
  // A deleted room answers 410 to its former members.
  await rest(app, a, 'DELETE', `/api/rooms/${roomId}`, { confirm_name: 'Synthetic desk' });
  assert.equal(
    (await rest(app, b, 'POST', `/api/rooms/${roomId}/notifications`, { muted: true })).statusCode,
    410,
  );
});

// Smart Rooms v2 (Z6): AI self-reported status ("says") and the host's bulk "Mute all AIs".

async function clockedRoom(t: { after: (fn: () => Promise<unknown>) => void }) {
  let now = Date.now();
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    now: () => now,
    rooms: { statusSetsPerAgentPerMinute: 4 },
  });
  t.after(() => app.close());
  return {
    app,
    ...(await room(app)),
    advance: (ms: number) => {
      now += ms;
    },
  };
}
async function personIdOf(app: App, roomId: string, name: string) {
  return (
    await app.city.db.query<{ agent_id: string }>(
      "SELECT agent_id FROM room_members WHERE room_id=$1 AND kind='person' AND display_name=$2",
      [roomId, name],
    )
  ).rows[0]!.agent_id;
}
type Says = { text: string; eta: string | null; self_reported: true } | null;
async function saysOf(app: App, who: Owner, roomId: string) {
  const res = await rest(app, who, 'GET', `/api/rooms/${roomId}/members`);
  assert.equal(res.statusCode, 200, res.body);
  return new Map(
    (res.json().members as Array<{ id: string; says: Says }>).map((m) => [m.id, m.says]),
  );
}
function statusPost(app: App, key: string, roomId: string, agentId: string, status: unknown) {
  return call(app, key, 'city_room_post', {
    room_id: roomId,
    agent_id: agentId,
    text: 'Working on it',
    status,
    idempotency_key: randomUUID(),
  });
}

test('says: an AI sets a short self-reported status; cleaned, bounded, expiring, cleared', async (t) => {
  const { app, a, b, bravo, hostAgent, roomId, advance } = await clockedRoom(t);
  const set = await statusPost(app, b.key, roomId, bravo, {
    text: '  running‮  the​ test\nharness ',
    eta_minutes: 10,
  });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(set.json().status.text, 'running the test harness');
  assert.equal(set.json().status.self_reported, true);
  // Every member sees it (the host here), labelled self-reported, with the eta.
  const seen = (await saysOf(app, a, roomId)).get(bravo)!;
  assert.equal(seen!.text, 'running the test harness');
  assert.equal(seen!.self_reported, true);
  assert.ok(seen!.eta);
  // Members without a status show null.
  assert.equal((await saysOf(app, a, roomId)).get(hostAgent), null);

  // Bounds: 120 characters, plain text only (no credentials), visible text, eta 1..240 minutes.
  for (const [status, code] of [
    [{ text: 'x'.repeat(121) }, 'invalid_request'],
    [{ text: '​​ ' }, 'invalid_status'],
    [{ text: `token crr_${'A'.repeat(43)}` }, 'credential_in_message'],
    [{ text: 'ok', eta_minutes: 0 }, 'invalid_request'],
    [{ text: 'ok', eta_minutes: 241 }, 'invalid_request'],
    [{ text: 'ok', extra: true }, 'invalid_request'],
  ] as const) {
    const res = await statusPost(app, b.key, roomId, bravo, status);
    assert.equal(res.statusCode, 400, JSON.stringify(status));
    assert.equal(res.json().code, code, JSON.stringify(status));
  }
  assert.equal((await saysOf(app, a, roomId)).get(bravo)!.text, 'running the test harness');

  // It expires 30 minutes after it was set (or at a later eta).
  advance(29 * 60_000);
  assert.ok((await saysOf(app, a, roomId)).get(bravo));
  advance(2 * 60_000);
  assert.equal((await saysOf(app, a, roomId)).get(bravo), null);
  const long = await statusPost(app, b.key, roomId, bravo, { text: 'long build', eta_minutes: 90 });
  assert.equal(long.statusCode, 200, long.body);
  advance(60 * 60_000);
  assert.equal((await saysOf(app, a, roomId)).get(bravo)!.text, 'long build');

  // "clear" (any case) and null clear it at once.
  advance(60_000);
  assert.equal(
    (await statusPost(app, b.key, roomId, bravo, { text: ' Clear ' })).json().status,
    null,
  );
  assert.equal((await saysOf(app, a, roomId)).get(bravo), null);
  advance(60_000);
  await statusPost(app, b.key, roomId, bravo, { text: 'again' });
  assert.equal((await statusPost(app, b.key, roomId, bravo, null)).json().status, null);
  assert.equal((await saysOf(app, a, roomId)).get(bravo), null);
  // A post without status leaves it alone and returns no status field.
  advance(60_000);
  await statusPost(app, b.key, roomId, bravo, { text: 'kept' });
  const plain = await call(app, b.key, 'city_room_post', {
    room_id: roomId,
    agent_id: bravo,
    text: 'No status',
    idempotency_key: randomUUID(),
  });
  assert.equal(plain.json().status, undefined);
  assert.equal((await saysOf(app, a, roomId)).get(bravo)!.text, 'kept');
});

test('says: rate limited per member, AI only, per room, and hidden while muted', async (t) => {
  const { app, a, b, bravo, hostAgent, roomId, link, advance } = await clockedRoom(t);
  // 4 status changes per member per minute in this fixture (default 6); plain posts are not counted.
  for (let i = 0; i < 4; i++)
    assert.equal(
      (await statusPost(app, b.key, roomId, bravo, { text: `step ${i}` })).statusCode,
      200,
    );
  const limited = await statusPost(app, b.key, roomId, bravo, { text: 'step 5' });
  assert.equal(limited.statusCode, 429, limited.body);
  const plain = await call(app, b.key, 'city_room_post', {
    room_id: roomId,
    agent_id: bravo,
    text: 'Plain post',
    idempotency_key: randomUUID(),
  });
  assert.equal(plain.statusCode, 200, plain.body);
  advance(61_000);

  // A person (the console posting as the person member, in their own account) cannot set one.
  const personId = await joinAsPerson(app, b, link, roomId, 'Bea');
  const byPerson = await self(app, b, 'POST', `/api/rooms/${roomId}/messages`, {
    agent_id: personId,
    text: 'Hi',
    status: { text: 'person status' },
    idempotency_key: randomUUID(),
  });
  assert.equal(byPerson.statusCode, 400, byPerson.body);
  assert.equal(byPerson.json().code, 'status_ai_only');

  // Per room: bravo's status in this room never shows in another room it is in.
  const other = await ok(app, a.key, 'city_create_room', {
    agent_id: hostAgent,
    name: 'Other desk',
    idempotency_key: randomUUID(),
  });
  await ok(app, b.key, 'city_join_room', {
    link: other.link.link,
    agent_id: bravo,
    idempotency_key: randomUUID(),
  });
  assert.equal(
    (await statusPost(app, b.key, roomId, bravo, { text: 'only here' })).statusCode,
    200,
  );
  assert.equal((await saysOf(app, a, roomId)).get(bravo)!.text, 'only here');
  assert.equal((await saysOf(app, a, other.room.id)).get(bravo), null);

  // Hidden while the host mutes the member; back when unmuted (until it expires).
  const mute = (muted: boolean) =>
    rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, { agent_id: bravo, muted });
  assert.equal((await mute(true)).statusCode, 200);
  assert.equal((await saysOf(app, a, roomId)).get(bravo), null);
  assert.equal((await mute(false)).statusCode, 200);
  assert.equal((await saysOf(app, a, roomId)).get(bravo)!.text, 'only here');
});

test('says: an invited guest without an account sets its own status in its own room', async (t) => {
  const h = await hosted(t);
  const { a, roomId, link } = await h.setup();
  const guest = await h.guestJoin(link.join_link);
  const posted = await callOpenTool(h.transport, 'city_room_post', {
    room_credential: guest.credential,
    text: 'Reviewing the spec',
    status: { text: 'reviewing the spec', eta_minutes: 5 },
    idempotency_key: randomUUID(),
  });
  assert.equal(outcomeErrorCode(posted), null, posted.raw.slice(0, 600));
  const members = await h.console(a, 'GET', `/api/rooms/${roomId}/members`);
  const self = (members.json().members as Array<{ id: string; says: Says }>).find(
    (m) => m.id === guest.agentId,
  );
  assert.equal(self!.says!.text, 'reviewing the spec');
  assert.equal(self!.says!.self_reported, true);
});

test('mute all AIs: host only; never people or the host own members; idempotent; reversible', async (t) => {
  const app = await fixture(t);
  const { a, b, bravo, hostAgent, roomId, link } = await room(app);
  const c = await owner(app, 'Third workspace');
  const charlie = await agent(app, c.key, 'Charlie');
  await ok(app, c.key, 'city_join_room', {
    link,
    agent_id: charlie,
    idempotency_key: randomUUID(),
  });
  // b's co-owner joins too, as a person from their own account (bravo's AI workspace never can).
  const bea = await joinAsPerson(app, b, link, roomId, 'Bea');
  const bulk = (who: Owner, body: unknown) =>
    rest(app, who, 'POST', `/api/rooms/${roomId}/mute-ais`, body);

  // Host only: a member hears host_required, an outsider 404.
  assert.equal((await bulk(b, { muted: true })).json().code, 'host_required');
  const d = await owner(app, 'Outsider workspace');
  assert.equal((await bulk(d, { muted: true })).statusCode, 404);
  for (const body of [
    {},
    { muted: true, include_individual: true },
    { muted: false, reason: 'x' },
    { muted: true, reason: 'x'.repeat(201) },
    { muted: true, extra: 1 },
  ]) {
    const res = await bulk(a, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }

  // charlie is muted on its own first (a single mute, kept apart from the bulk mute).
  assert.equal(
    (
      await rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, {
        agent_id: charlie,
        muted: true,
        reason: 'Single',
      })
    ).statusCode,
    200,
  );
  const first = await bulk(a, { muted: true, reason: 'Quiet please' });
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), {
    room_id: roomId,
    muted: true,
    changed: 1,
    reason: 'Quiet please',
  });
  // Idempotent: a second call changes nothing.
  assert.equal((await bulk(a, { muted: true })).json().changed, 0);

  const mutedRows = async () =>
    (
      await app.city.db.query<{ agent_id: string; mute_scope: string | null }>(
        'SELECT agent_id, mute_scope FROM room_members WHERE room_id=$1 AND muted_at IS NOT NULL ORDER BY agent_id',
        [roomId],
      )
    ).rows;
  const scopes = new Map((await mutedRows()).map((r) => [r.agent_id, r.mute_scope]));
  assert.equal(scopes.get(bravo), 'ai');
  assert.equal(scopes.get(charlie), null);
  assert.equal(scopes.has(hostAgent), false);
  assert.equal(scopes.has(bea), false);

  // bravo cannot post; b's co-owner as the person Bea still can; the host's own AI still can.
  const post = (who: Owner, agentId: string, via = rest) =>
    via(app, who, 'POST', `/api/rooms/${roomId}/messages`, {
      agent_id: agentId,
      text: 'Hello',
      idempotency_key: randomUUID(),
    });
  const bravoPost = await call(app, b.key, 'city_room_post', {
    room_id: roomId,
    agent_id: bravo,
    text: 'Hello',
    idempotency_key: randomUUID(),
  });
  assert.equal(bravoPost.json().code, 'muted_in_room');
  assert.match(bravoPost.body, /Quiet please/);
  assert.equal((await post(b, bea, self)).statusCode, 201);
  assert.equal((await post(a, hostAgent)).statusCode, 201);
  // The console view tells the composer which: b still posts as a person, c cannot post at all.
  const consoleView = async (who: Owner) =>
    (await rest(app, who, 'GET', '/api/rooms'))
      .json()
      .rooms.find((r: { id: string }) => r.id === roomId);
  assert.equal((await consoleView(b)).muted, true);
  assert.equal((await consoleView(b)).mute_scope, 'ai');
  assert.equal((await consoleView(c)).mute_scope, 'all');
  assert.equal((await consoleView(a)).mute_scope, null);

  // Unmute all lifts the bulk mutes only; include_individual lifts single mutes too.
  const unmuted = await bulk(a, { muted: false });
  assert.deepEqual(unmuted.json(), { room_id: roomId, muted: false, changed: 1, reason: null });
  assert.deepEqual(
    (await mutedRows()).map((r) => r.agent_id),
    [charlie],
  );
  assert.equal((await bulk(a, { muted: false })).json().changed, 0);
  assert.equal((await bulk(a, { muted: false, include_individual: true })).json().changed, 1);
  assert.deepEqual(await mutedRows(), []);
  const bravoAgain = await call(app, b.key, 'city_room_post', {
    room_id: roomId,
    agent_id: bravo,
    text: 'Back',
    idempotency_key: randomUUID(),
  });
  assert.equal(bravoAgain.statusCode, 200, bravoAgain.body);

  // One audit row per call, like single mutes.
  const actions = (
    await app.city.db.query<{ action: string }>(
      "SELECT action FROM room_events WHERE room_id=$1 AND action LIKE 'members.bulk_%' ORDER BY created_at",
      [roomId],
    )
  ).rows.map((r) => r.action);
  assert.deepEqual(actions, [
    'members.bulk_muted',
    'members.bulk_muted',
    'members.bulk_unmuted',
    'members.bulk_unmuted',
    'members.bulk_unmuted',
  ]);
});

test('mute all AIs at 10,000 members: batched, complete, idempotent, and unmuted again', async (t) => {
  const app = await fixture(t);
  const { a, bravo, roomId } = await room(app);
  // 10,000 synthetic AI member rows (copies of bravo's row with fresh ids and owners).
  await app.city.db.query(
    `INSERT INTO room_members(room_id, agent_id, owner_id, role, owner_label, visible_from_seq, joined_at, joined_by, last_read_seq, kind)
     SELECT room_id, 'synthetic-ai-' || lpad(g::text, 5, '0'), 'synthetic-owner-' || g, role, owner_label,
            visible_from_seq, joined_at, joined_by, last_read_seq, kind
       FROM room_members, generate_series(1, 10000) AS g
      WHERE room_id=$1 AND agent_id=$2`,
    [roomId, bravo],
  );
  const bulk = (body: unknown) => rest(app, a, 'POST', `/api/rooms/${roomId}/mute-ais`, body);
  const count = async () =>
    Number(
      (
        await app.city.db.query<{ n: string }>(
          "SELECT count(*) AS n FROM room_members WHERE room_id=$1 AND muted_at IS NOT NULL AND mute_scope='ai'",
          [roomId],
        )
      ).rows[0]!.n,
    );
  const muted = await bulk({ muted: true });
  assert.equal(muted.statusCode, 200, muted.body);
  assert.equal(muted.json().changed, 10_001);
  assert.equal(await count(), 10_001);
  assert.equal((await bulk({ muted: true })).json().changed, 0);
  const unmuted = await bulk({ muted: false });
  assert.equal(unmuted.json().changed, 10_001);
  assert.equal(await count(), 0);
});

test('mute all AIs: audit rows per batch carry changed and reason', async (t) => {
  const app = await fixture(t);
  const { a, bravo, roomId } = await room(app);
  await app.city.db.query(
    `INSERT INTO room_members(room_id, agent_id, owner_id, role, owner_label, visible_from_seq, joined_at, joined_by, last_read_seq, kind)
     SELECT room_id, 'synthetic-ai-' || lpad(g::text, 5, '0'), 'synthetic-owner-' || g, role, owner_label,
            visible_from_seq, joined_at, joined_by, last_read_seq, kind
       FROM room_members, generate_series(1, 1500) AS g
      WHERE room_id=$1 AND agent_id=$2`,
    [roomId, bravo],
  );
  const bulk = (body: unknown) => rest(app, a, 'POST', `/api/rooms/${roomId}/mute-ais`, body);
  assert.equal((await bulk({ muted: true, reason: 'Quiet' })).json().changed, 1501);
  assert.equal((await bulk({ muted: true })).json().changed, 0);
  const rows = (
    await app.city.db.query<{ action: string; detail: unknown }>(
      "SELECT action, detail FROM room_events WHERE room_id=$1 AND action LIKE 'members.bulk_%' ORDER BY created_at, detail->>'changed' DESC",
      [roomId],
    )
  ).rows.map((r) => ({
    action: r.action,
    detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail,
  }));
  // One row per applied batch (written in the batch's transaction), one for a no-op call.
  assert.deepEqual(rows, [
    { action: 'members.bulk_muted', detail: { changed: 1000, reason: 'Quiet' } },
    { action: 'members.bulk_muted', detail: { changed: 501, reason: 'Quiet' } },
    { action: 'members.bulk_muted', detail: { changed: 0, reason: null } },
  ]);
});

test('mute all AIs: a person whose AI was bulk-muted still renews, reports, reviews, moves stages and deletes comments', async (t) => {
  const app = await fixture(t);
  const { a, b, bravo, hostAgent, roomId, link } = await room(app);
  const tasks = createRoomTasks({
    db: app.city.db,
    clock: () => Date.now(),
    limit: async () => {},
    secret: 'synthetic-room-management-tasks-secret',
  });
  // The owners' consoles: only a person in the app acts as its person member (Bea), never its AI.
  const p = (operatorId: string) => ({
    operatorId,
    actor: 'the test owner',
    origin: 'http://localhost',
    console: true,
  });
  // Bea is bravo's workspace's co-owner, in the room as a person from her own account.
  const bea = await joinAsPerson(app, b, link, roomId, 'Bea');
  const beaOwner = await accountOf(app, b);
  const refused = async (run: Promise<unknown>, label: string) => {
    try {
      await run;
    } catch (error) {
      assert.equal((error as { errorCode?: string }).errorCode, 'muted_in_room', label);
      return;
    }
    assert.fail(`${label}: expected muted_in_room`);
  };
  const newTask = async (title: string) =>
    (
      await tasks.create(p(a.id), {
        room_id: roomId,
        agent_id: hostAgent,
        title,
        idempotency_key: randomUUID(),
      })
    ).task.id as string;
  const claimAs = (taskId: string, agentId: string, ownerId: string, review?: unknown) =>
    tasks.claim(p(ownerId), {
      room_id: roomId,
      task_id: taskId,
      agent_id: agentId,
      idempotency_key: randomUUID(),
      ...(review ? { review } : {}),
    });
  await tasks.setStages(p(a.id), { room_id: roomId, stages: ['Doing', 'Checking'] });

  // Before the bulk mute: bravo (AI) and Bea (person, its co-owner) each hold a claim and a
  // comment; the host's AI holds two claims, one asking Bea and one asking bravo to review.
  const forBea = await newTask('Person work');
  const forBravo = await newTask('AI work');
  const beaClaim = await claimAs(forBea, bea, beaOwner);
  const bravoClaim = await claimAs(forBravo, bravo, b.id);
  const reviewBea = await newTask('Review by Bea');
  const reviewBravo = await newTask('Review by bravo');
  await claimAs(reviewBea, hostAgent, a.id, { reviewer_agent_id: bea });
  await claimAs(reviewBravo, hostAgent, a.id, { reviewer_agent_id: bravo });
  const comment = async (agentId: string, ownerId: string) =>
    (
      await tasks.commentAdd(p(ownerId), {
        room_id: roomId,
        task_id: forBea,
        agent_id: agentId,
        body: 'A note',
      })
    ).comment.id as string;
  const beaComment = await comment(bea, beaOwner);
  const beaComment2 = await comment(bea, beaOwner);
  const bravoComment = await comment(bravo, b.id);

  const muted = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute-ais`, { muted: true });
  assert.equal(muted.statusCode, 200, muted.body);

  // Renew.
  await tasks.renew(p(beaOwner), {
    room_id: roomId,
    task_id: forBea,
    claim_token: beaClaim.claim_token,
  });
  await refused(
    tasks.renew(p(b.id), {
      room_id: roomId,
      task_id: forBravo,
      claim_token: bravoClaim.claim_token,
    }),
    'renew by bulk-muted AI',
  );
  // Stage move by the claim holder.
  assert.equal(
    (await tasks.update(p(beaOwner), { room_id: roomId, task_id: forBea, stage: 'Doing' })).applied,
    true,
  );
  await refused(
    tasks.update(p(b.id), { room_id: roomId, task_id: forBravo, stage: 'Doing' }),
    'stage by bulk-muted AI',
  );
  // Peer review.
  await tasks.peerReview(p(beaOwner), {
    room_id: roomId,
    task_id: reviewBea,
    agent_id: bea,
    verdict: 'approve',
  });
  await refused(
    tasks.peerReview(p(b.id), {
      room_id: roomId,
      task_id: reviewBravo,
      agent_id: bravo,
      verdict: 'approve',
    }),
    'peer review by bulk-muted AI',
  );
  // Comment delete.
  await tasks.commentDelete(p(beaOwner), {
    room_id: roomId,
    task_id: forBea,
    comment_id: beaComment,
    agent_id: bea,
  });
  await refused(
    tasks.commentDelete(p(b.id), {
      room_id: roomId,
      task_id: forBea,
      comment_id: bravoComment,
      agent_id: bravo,
    }),
    'comment delete by bulk-muted AI',
  );
  // Result.
  await tasks.result(p(beaOwner), {
    room_id: roomId,
    task_id: forBea,
    claim_token: beaClaim.claim_token,
    evidence: { kind: 'proposal', ref: 'proposal-7', revision: 'rev-3' },
  });
  await refused(
    tasks.result(p(b.id), {
      room_id: roomId,
      task_id: forBravo,
      claim_token: bravoClaim.claim_token,
      evidence: { kind: 'proposal', ref: 'proposal-7', revision: 'rev-3' },
    }),
    'result by bulk-muted AI',
  );

  // An individual mute is unchanged: once Bea is muted on her own, she is refused too.
  const single = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: bea,
    muted: true,
  });
  assert.equal(single.statusCode, 200, single.body);
  await refused(
    tasks.commentDelete(p(beaOwner), {
      room_id: roomId,
      task_id: forBea,
      comment_id: beaComment2,
      agent_id: bea,
    }),
    'comment delete by individually muted person',
  );
});

test('mute all AIs: a person who also brought their own AI keeps the person controls', async (t) => {
  const app = await fixture(t);
  const { a, b, hostAgent, roomId, link } = await room(app);
  // Bea joins as a person from her own account, then brings her own AI from that account: her
  // owner has a person row and an AI row in the room.
  await joinAsPerson(app, b, link, roomId, 'Bea');
  const granted = await self(app, b, 'POST', '/api/assistant-access', {
    label: 'Bea assistant',
    scopes: [...ASSISTANT_SCOPES],
    expiresInDays: 1,
  });
  assert.equal(granted.statusCode, 201, granted.body);
  const grant = granted.json().token as string;
  const beaAi = await agent(app, grant, 'Bea desk');
  await ok(app, grant, 'city_join_room', { link, agent_id: beaAi, idempotency_key: randomUUID() });
  const bulk = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute-ais`, {
    muted: true,
    reason: 'Quiet please',
  });
  assert.equal(bulk.json().changed, 2, bulk.body);
  const viewOf = async (send: typeof self, who: Owner) => {
    const res = await send(app, who, 'GET', '/api/rooms');
    assert.equal(res.statusCode, 200, res.body);
    return (res.json().rooms as Array<{ id: string; muted: boolean; mute_reason: string | null }>)
      .filter((r) => r.id === roomId)
      .map((r) => [r.muted, r.mute_reason])[0];
  };

  // The console shows Bea unmuted: she writes as her person, which the bulk mute spares.
  assert.deepEqual(await viewOf(self, b), [false, null]);
  // The AI workspace's console has no person member: its AI's bulk mute shows.
  assert.deepEqual(await viewOf(rest, b), [true, 'Quiet please']);

  // She pins and unpins as her person; her AI over its key is still refused.
  const posted = await ok(app, a.key, 'city_room_post', {
    room_id: roomId,
    agent_id: hostAgent,
    text: 'Worth keeping',
    idempotency_key: randomUUID(),
  });
  const seq = posted.message.seq as number;
  const pinned = await self(app, b, 'POST', `/api/rooms/${roomId}/pins`, { message_seq: seq });
  assert.equal(pinned.statusCode, 201, pinned.body);
  const unpinned = await self(
    app,
    b,
    'DELETE',
    `/api/rooms/${roomId}/pins/${pinned.json().pin.id as string}`,
  );
  assert.equal(unpinned.statusCode, 200, unpinned.body);
  const aiPin = await call(app, grant, 'city_room_pin', {
    room_id: roomId,
    agent_id: beaAi,
    message_seq: seq,
  });
  assert.equal(aiPin.json().code, 'muted_in_room', aiPin.body);

  // Her console adds and deletes a task comment as her person, naming no agent.
  const tasks = createRoomTasks({
    db: app.city.db,
    clock: () => Date.now(),
    limit: async () => {},
    secret: 'synthetic-room-management-tasks-secret',
  });
  const p = (operatorId: string) => ({
    operatorId,
    actor: 'the test owner',
    origin: 'http://localhost',
    console: true,
  });
  const taskId = (
    await tasks.create(p(a.id), {
      room_id: roomId,
      agent_id: hostAgent,
      title: 'Person comments',
      idempotency_key: randomUUID(),
    })
  ).task.id as string;
  const beaOwner = await accountOf(app, b);
  const added = await tasks.commentAdd(p(beaOwner), {
    room_id: roomId,
    task_id: taskId,
    body: 'A note',
  });
  const deleted = await tasks.commentDelete(p(beaOwner), {
    room_id: roomId,
    task_id: taskId,
    comment_id: added.comment.id as string,
  });
  assert.equal(deleted.deleted, true);
});

test('DELETE /api/rooms/:room erases peer reviews, comments, pins and caches; private messages stay', async (t) => {
  const app = await fixture(t);
  const { a, b, hostAgent, bravo, roomId } = await room(app, 'Reviewed room');
  const db = app.city.db;
  await db.query(
    `INSERT INTO room_tasks(id,room_id,number,title,status,created_by_agent_id,created_by_owner_id,created_at,updated_at,idempotency_key,request_hash)
      VALUES('task-r',$1,1,'Synthetic task','open',$2,'owner',0,0,'k','h')`,
    [roomId, bravo],
  );
  await db.query(
    `INSERT INTO room_task_reviews(id,task_id,room_id,reviewer_agent_id,reviewer_owner_id,requested_by_agent_id,requested_by_owner_id,status,requested_at)
      VALUES('review-1','task-r',$1,$2,$3,$4,$5,'requested',0)`,
    [roomId, hostAgent, a.id, bravo, b.id],
  );
  await db.query(
    `INSERT INTO room_task_comments(id,task_id,room_id,author_kind,author_agent_id,author_owner_id,body,created_at)
      VALUES('comment-1','task-r',$1,'agent',$2,$3,'Synthetic comment',0)`,
    [roomId, bravo, b.id],
  );
  await db.query(
    `INSERT INTO room_pins(id,room_id,kind,task_id,pinned_by_agent_id,pinned_by_owner_id,created_at)
      VALUES('pin-1',$1,'task','task-r',$2,$3,0)`,
    [roomId, hostAgent, a.id],
  );
  await db.query(
    `INSERT INTO elric_catch_ups(owner_id,room_id,from_seq,to_seq,status,body,created_at,expires_at)
      VALUES($1,$2,0,1,'done','{"summary":"Synthetic"}'::jsonb,0,9999999999999)`,
    [b.id, roomId],
  );
  await db.query(
    `UPDATE room_members SET says_text='Reviewing', says_set_at=0 WHERE room_id=$1 AND agent_id=$2`,
    [roomId, bravo],
  );
  // A private message authorized by the room: an inbox row of the recipient.
  const dm = await call(app, b.key, 'city_send_message', {
    from_agent_id: bravo,
    to_agent_id: hostAgent,
    room_id: roomId,
    text: 'Synthetic private note',
    idempotency_key: randomUUID(),
  });
  assert.equal(dm.statusCode, 200, dm.body);

  const deleted = await rest(app, a, 'DELETE', `/api/rooms/${roomId}`, {
    confirm_name: 'Reviewed room',
  });
  assert.equal(deleted.statusCode, 200, deleted.body);
  for (const table of [
    'room_task_reviews',
    'room_task_comments',
    'room_tasks',
    'room_pins',
    'room_briefs',
    'elric_catch_ups',
  ]) {
    const left = await db.query(`SELECT 1 FROM ${table} WHERE room_id=$1`, [roomId]);
    assert.equal(left.rows.length, 0, `${table} erased`);
  }
  const events = await db.query("SELECT 1 FROM room_task_events WHERE task_id='task-r'");
  assert.equal(events.rows.length, 0, 'room_task_events erased');
  const says = await db.query(
    'SELECT 1 FROM room_members WHERE room_id=$1 AND says_text IS NOT NULL',
    [roomId],
  );
  assert.equal(says.rows.length, 0, 'says status cleared');
  const counts = await db.query<{ tasks_open: number }>(
    'SELECT tasks_open FROM room_counts WHERE room_id=$1',
    [roomId],
  );
  assert.ok(
    counts.rows.every((r) => r.tasks_open === 0),
    'no task counts left',
  );
  // Private messages belong to the recipient's inbox (docs/MESSAGING.md): they survive.
  const kept = await db.query('SELECT 1 FROM messages WHERE room_id=$1', [roomId]);
  assert.equal(kept.rows.length, 1, 'the private message stays in the inbox');
});
