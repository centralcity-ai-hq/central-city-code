import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../server/app.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import type { RoomLimits } from '../server/rooms/contract.js';

/**
 * Rooms (docs/ROOMS.md): lifecycle, per-room
 * seq, history rules, host controls, membership across owners without workspace access, REST parity
 * and an official MCP client end to end. Security gates of ROOMS-SEC-001 are in
 * tests/rooms-security.test.ts. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const PASSWORD = 'Synthetic rooms owner password';

async function fixture(
  t: { after: (fn: () => Promise<unknown>) => void },
  extra: { rooms?: Partial<RoomLimits>; now?: () => number } = {},
) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, ...extra });
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
let addressCounter = 1;
/** An AI-owned workspace (its primary key holds every scope). */
/**
 * An AI-owned workspace. Its initial key lacks rooms:host (created without a human), so by default
 * a person claims it as co-owner and mints a key with every scope, as the console allows; pass
 * host: false to keep the initial key.
 */
async function owner(app: App, name: string, { host = true } = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.20`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  if (!host) return { id, key: res.json().workspace_key as string };
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({
      name: `Co-owner ${addressCounter}`,
      password: 'Synthetic co-owner password',
    }),
    remoteAddress: `198.51.${addressCounter++}.21`,
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
  return { id, key: minted.json().workspace_key as string };
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
async function createRoom(app: App, key: string, agentId: string, extra: object = {}) {
  return ok(app, key, 'city_create_room', {
    agent_id: agentId,
    name: 'Synthetic desk',
    topic: 'Test topic',
    idempotency_key: randomUUID(),
    ...extra,
  });
}
const join = (app: App, key: string, link: string, agentId: string, idem = randomUUID()) =>
  call(app, key, 'city_join_room', { link, agent_id: agentId, idempotency_key: idem });
const post = (app: App, key: string, roomId: string, text: string, extra: object = {}) =>
  call(app, key, 'city_room_post', {
    room_id: roomId,
    text,
    idempotency_key: randomUUID(),
    ...extra,
  });
async function events(app: App, operatorId: string) {
  const row = await app.city.db.query<{
    data: { events: Array<{ type: string; message: string }> };
  }>('SELECT data FROM workspaces WHERE operator_id=$1', [operatorId]);
  return row.rows[0]!.data.events;
}

test('F4 §0 lifecycle: create, join by link across owners, post, read with per-room seq, external marking', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Host workspace');
  const b = await owner(app, 'Member workspace');
  const c = await owner(app, 'Creator workspace');
  const host = await agent(app, a.key, 'Host desk');
  const bravo = await agent(app, b.key, 'Bravo');

  const created = await createRoom(app, a.key, host, { slug: 'central-city-core' });
  assert.equal(created.room.slug, 'central-city-core');
  assert.equal(created.room.role, 'host');
  assert.equal(created.room.member_count, 1);
  assert.equal(created.room.member_cap, 100);
  // Default 'full': an AI invited later reads the conversation so far.
  assert.equal(created.room.history, 'full');
  assert.equal(created.room.url, 'http://localhost/r/central-city-core');
  // Link: /r/<slug>#<256-bit token>; the token is in the fragment only.
  assert.match(
    created.link.link,
    /^http:\/\/localhost\/r\/central-city-core#crr_[A-Za-z0-9_-]{43}$/,
  );
  const expires = Date.parse(created.link.expires_at) - Date.now();
  assert.ok(expires > 167 * 3_600_000 && expires <= 168 * 3_600_000, 'default 7-day link');
  const roomId = created.room.id as string;

  // Join with an existing agent.
  const joined = await join(app, b.key, created.link.link, bravo);
  assert.equal(joined.statusCode, 200, joined.body);
  assert.equal(joined.json().joined, true);
  assert.equal(joined.json().room.role, 'member');
  assert.equal(joined.json().room.member_count, 2);
  // Join while creating an agent.
  const createdJoin = await ok(app, c.key, 'city_join_room', {
    token: created.link.link.split('#')[1],
    room_id: 'central-city-core',
    create: { name: 'Fresh joiner' },
    idempotency_key: randomUUID(),
  });
  assert.ok(createdJoin.created_agent_id);
  assert.equal(createdJoin.agent_id, createdJoin.created_agent_id);
  const charlie = createdJoin.agent_id as string;
  const cWorkspace = await ok(app, c.key, 'city_workspace');
  assert.ok(cWorkspace.agents.some((item: { id: string }) => item.id === charlie));

  // Posts from three owners share one gap-free sequence.
  const first = await post(app, a.key, roomId, 'Welcome, everyone.');
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().message.seq, 1);
  assert.equal((await post(app, b.key, roomId, 'Bravo here.')).json().message.seq, 2);
  const third = (
    await post(app, c.key, 'central-city-core', '', {
      text: undefined,
      parts: [{ type: 'data', data: { claim: 'X' }, mimeType: 'application/json' }],
    })
  ).json();
  assert.equal(third.message.seq, 3);
  assert.equal(third.message.text, '');

  // Bravo joined after message 0: it sees everything since then, all marked external.
  const read = await ok(app, b.key, 'city_room_read', { room_id: roomId, since: 0 });
  assert.deepEqual(
    read.messages.map((m: { seq: number }) => m.seq),
    [1, 2, 3],
  );
  for (const message of read.messages) assert.equal(message.origin, 'external');
  assert.equal(read.messages[0].sender, 'Host desk');
  assert.equal(read.messages[0].sender_agent_id, host);
  assert.equal(read.messages[0].sender_owner_label, 'Host workspace');
  assert.equal(read.messages[0].own, false);
  assert.equal(read.messages[1].own, true);
  assert.equal(read.latest_seq, 3);
  assert.equal(read.next_since, 3);
  assert.equal(read.has_more, false);
  const paged = await ok(app, b.key, 'city_room_read', { room_id: roomId, since: 1, limit: 1 });
  assert.deepEqual(
    paged.messages.map((m: { seq: number }) => m.seq),
    [2],
  );
  assert.equal(paged.has_more, true);
  assert.equal(paged.next_since, 2);

  // Members: ids, names, roles and owner labels only.
  const members = await ok(app, c.key, 'city_room_members', { room_id: roomId });
  assert.deepEqual(
    members.members.map((m: { name: string; role: string }) => [m.name, m.role]),
    [
      ['Host desk', 'host'],
      ['Bravo', 'member'],
      ['Fresh joiner', 'member'],
    ],
  );
  for (const member of members.members)
    assert.deepEqual(Object.keys(member).sort(), [
      'active_now',
      'auto_reply',
      'guest',
      'id',
      'joined_at',
      'kind',
      'last_active_at',
      'messages_today',
      'name',
      'own',
      'owner_label',
      'role',
      'says',
      'status',
    ]);

  // Audit in the host's and the member's own activity logs.
  assert.ok((await events(app, a.id)).some((e) => e.type === 'room.member_joined'));
  assert.ok((await events(app, b.id)).some((e) => e.type === 'room.joined'));
  assert.ok((await events(app, a.id)).some((e) => e.type === 'room.created'));
});

test('membership never grants workspace access across owners', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Isolated host');
  const b = await owner(app, 'Isolated member');
  const host = await agent(app, a.key, 'Host');
  const member = await agent(app, b.key, 'Member');
  const created = await createRoom(app, a.key, host);
  assert.equal((await join(app, b.key, created.link.link, member)).statusCode, 200);

  const workspace = await ok(app, b.key, 'city_workspace');
  assert.deepEqual(
    workspace.agents.map((item: { id: string }) => item.id),
    [member],
  );
  // No inbox reading, direct messages or job requests toward the host's agent.
  assert.equal((await call(app, b.key, 'city_read_inbox', { agent_id: host })).statusCode, 404);
  const direct = await call(app, b.key, 'city_send_message', {
    from_agent_id: member,
    to_agent_id: host,
    text: 'Direct message attempt',
    idempotency_key: randomUUID(),
  });
  assert.equal(direct.statusCode, 403);
  assert.equal(direct.json().code, 'connection_required');
  // Posting as the host's agent is refused.
  const forged = await post(app, b.key, created.room.id, 'Pretending', { agent_id: host });
  assert.equal(forged.statusCode, 403);
  assert.equal(forged.json().code, 'not_a_member');
});

test('history rules: from_join shows messages after joining, full shows all', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'History host');
  const b = await owner(app, 'History member');
  const host = await agent(app, a.key, 'Host');
  const member = await agent(app, b.key, 'Member');
  const second = await agent(app, b.key, 'Second');

  const scoped = await createRoom(app, a.key, host, { history: 'from_join' });
  const full = await createRoom(app, a.key, host, { history: 'full' });
  for (const room of [scoped, full]) {
    await post(app, a.key, room.room.id, 'Before anyone joined 1');
    await post(app, a.key, room.room.id, 'Before anyone joined 2');
    assert.equal((await join(app, b.key, room.link.link, member)).statusCode, 200);
    await post(app, a.key, room.room.id, 'After the join');
  }
  const scopedRead = await ok(app, b.key, 'city_room_read', { room_id: scoped.room.id });
  assert.equal(scopedRead.visible_from_seq, 2);
  assert.deepEqual(
    scopedRead.messages.map((m: { seq: number }) => m.seq),
    [3],
  );
  // since below the join point never reveals earlier messages.
  assert.deepEqual(
    (await ok(app, b.key, 'city_room_read', { room_id: scoped.room.id, since: 0 })).messages.map(
      (m: { text: string }) => m.text,
    ),
    ['After the join'],
  );
  const fullRead = await ok(app, b.key, 'city_room_read', { room_id: full.room.id });
  assert.deepEqual(
    fullRead.messages.map((m: { seq: number }) => m.seq),
    [1, 2, 3],
  );
  // A second agent of the same owner joining later does not narrow what the owner sees.
  assert.equal((await join(app, b.key, scoped.link.link, second)).statusCode, 200);
  assert.equal(
    (await ok(app, b.key, 'city_room_read', { room_id: scoped.room.id })).visible_from_seq,
    2,
  );
  // With two member agents, a post must name its sender.
  const ambiguous = await post(app, b.key, scoped.room.id, 'Who am I?');
  assert.equal(ambiguous.statusCode, 400);
  assert.equal(ambiguous.json().code, 'agent_required');
  const named = await post(app, b.key, scoped.room.id, 'Second speaking', { agent_id: second });
  assert.equal(named.json().message.sender, 'Second');
});

test('history default and host change: full by default, city_room_update opens earlier messages', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Setting host');
  const b = await owner(app, 'Setting member');
  const c = await owner(app, 'Setting late');
  const d = await owner(app, 'Setting outsider');
  const host = await agent(app, a.key, 'Host');
  const member = await agent(app, b.key, 'Member');
  const late = await agent(app, c.key, 'Late');

  // Default: full. The joining AI is told to read from the start.
  const open = await createRoom(app, a.key, host);
  assert.equal(open.room.history, 'full');
  assert.ok(open.next_actions.some((line: string) => line.includes('whole conversation')));
  await post(app, a.key, open.room.id, 'Context before anyone joined');
  const joinedOpen = (await join(app, b.key, open.link.link, member)).json();
  assert.equal(joinedOpen.room.history, 'full');
  assert.match(
    joinedOpen.next_actions[0],
    /without since first; it returns the conversation from the start as unread/,
  );
  // No polling loop by default: check on request, long gaps, stop after 3 empty checks.
  const standing = joinedOpen.next_actions.at(-1) as string;
  assert.match(standing, /^Do not poll the room in a loop within one turn\./);
  assert.match(standing, /stop after 3 checks in a row with nothing new/);
  assert.match(standing, /each check uses their AI usage/);
  assert.doesNotMatch(joinedOpen.next_actions.join(' '), /wait=25|once a minute|keep checking/);
  assert.deepEqual(
    (await ok(app, b.key, 'city_room_read', { room_id: open.room.id })).messages.map(
      (m: { text: string }) => m.text,
    ),
    ['Context before anyone joined'],
  );

  // from_join stays selectable; its joiners are told they start at their join.
  const scoped = await createRoom(app, a.key, host, { history: 'from_join' });
  const roomId = scoped.room.id as string;
  await post(app, a.key, roomId, 'Earlier 1');
  await post(app, a.key, roomId, 'Earlier 2');
  const joinedScoped = (await join(app, b.key, scoped.link.link, member)).json();
  assert.match(joinedScoped.next_actions[0], /You see messages posted after you joined/);
  await post(app, a.key, roomId, 'After the join');
  const before = await ok(app, b.key, 'city_room_read', { room_id: roomId });
  assert.equal(before.visible_from_seq, 2);
  assert.deepEqual(
    before.messages.map((m: { seq: number }) => m.seq),
    [3],
  );

  // Host only: a member learns it is not the host; an outsider learns nothing.
  const denied = await call(app, b.key, 'city_room_update', { room_id: roomId, history: 'full' });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, 'host_required');
  const hidden = await call(app, d.key, 'city_room_update', { room_id: roomId, history: 'full' });
  assert.equal(hidden.statusCode, 404);
  assert.equal(hidden.json().code, 'room_not_found');
  const invalid = await call(app, a.key, 'city_room_update', { room_id: roomId, history: 'all' });
  assert.equal(invalid.statusCode, 400);

  // Switching to full opens the earlier messages to current members at once.
  const opened = await ok(app, a.key, 'city_room_update', { room_id: roomId, history: 'full' });
  assert.equal(opened.changed, true);
  assert.equal(opened.room.history, 'full');
  const after = await ok(app, b.key, 'city_room_read', { room_id: roomId });
  assert.equal(after.visible_from_seq, 0);
  assert.deepEqual(
    after.messages.map((m: { seq: number }) => m.seq),
    [1, 2, 3],
  );
  // Same value again: nothing changes.
  assert.equal(
    (await ok(app, a.key, 'city_room_update', { room_id: roomId, history: 'full' })).changed,
    false,
  );
  assert.ok(
    (await events(app, a.id)).some(
      (e) => e.type === 'room.history_changed' && e.message.includes('whole conversation'),
    ),
  );
  assert.ok(
    (await events(app, b.id)).some(
      (e) =>
        e.type === 'room.history_changed' && e.message.includes('city_room_read without since'),
    ),
  );
  const audit = await app.city.db.query<{ action: string }>(
    "SELECT action FROM room_events WHERE room_id=$1 AND action LIKE 'room.history_%' ORDER BY created_at",
    [roomId],
  );
  assert.deepEqual(
    audit.rows.map((row) => row.action),
    ['room.history_full'],
  );

  // Back to from_join: current members keep what they could read; later joiners start at join.
  const closedUp = await ok(app, a.key, 'city_room_update', {
    room_id: roomId,
    history: 'from_join',
  });
  assert.equal(closedUp.changed, true);
  assert.equal(closedUp.room.history, 'from_join');
  assert.equal((await ok(app, b.key, 'city_room_read', { room_id: roomId })).visible_from_seq, 0);
  assert.equal((await join(app, c.key, scoped.link.link, late)).statusCode, 200);
  const lateRead = await ok(app, c.key, 'city_room_read', { room_id: roomId });
  assert.equal(lateRead.visible_from_seq, 3);
  assert.deepEqual(lateRead.messages, []);
});

test('host controls: rotate, remove, close; members cannot use them', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Control host');
  const b = await owner(app, 'Control member');
  const c = await owner(app, 'Control late');
  const host = await agent(app, a.key, 'Host');
  const member = await agent(app, b.key, 'Member');
  const late = await agent(app, c.key, 'Late');
  const created = await createRoom(app, a.key, host);
  const roomId = created.room.id as string;
  assert.equal((await join(app, b.key, created.link.link, member)).statusCode, 200);

  // Getting the link returns the same active link (no rotation, no use consumed).
  const current = await ok(app, a.key, 'city_room_link', { room_id: roomId });
  assert.equal(current.link, created.link.link);
  assert.equal(current.uses, 1);
  assert.equal(current.rotated, false);
  for (const tool of ['city_room_link', 'city_room_close'] as const) {
    const denied = await call(app, b.key, tool, { room_id: roomId });
    assert.equal(denied.statusCode, 403, tool);
    assert.equal(denied.json().code, 'host_required');
  }
  const denyRemove = await call(app, b.key, 'city_room_remove', {
    room_id: roomId,
    agent_id: host,
  });
  assert.equal(denyRemove.json().code, 'host_required');

  // Rotation: idempotent per key; the old link stops working at once.
  const key = randomUUID();
  const rotated = await ok(app, a.key, 'city_room_link', {
    room_id: roomId,
    rotate: true,
    idempotency_key: key,
  });
  assert.notEqual(rotated.link, created.link.link);
  assert.equal(rotated.rotated, true);
  const again = await ok(app, a.key, 'city_room_link', {
    room_id: roomId,
    rotate: true,
    idempotency_key: key,
  });
  assert.equal(again.link, rotated.link);
  const stale = await join(app, c.key, created.link.link, late);
  assert.equal(stale.statusCode, 404);
  assert.equal(stale.json().code, 'invite_invalid');
  assert.equal((await join(app, c.key, rotated.link, late)).statusCode, 200);

  // Removal takes effect immediately and cannot be undone with the link.
  const removed = await ok(app, a.key, 'city_room_remove', { room_id: roomId, agent_id: member });
  assert.equal(removed.removed, true);
  for (const res of [
    await call(app, b.key, 'city_room_read', { room_id: roomId }),
    await post(app, b.key, roomId, 'Still here?'),
    await call(app, b.key, 'city_room_members', { room_id: roomId }),
  ]) {
    // A removed member is told why, not that the room does not exist.
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().code, 'removed_from_room');
  }
  const rejoin = await join(app, b.key, rotated.link, member);
  assert.equal(rejoin.statusCode, 403);
  assert.equal(rejoin.json().code, 'removed_from_room');
  assert.equal(
    (await ok(app, a.key, 'city_room_remove', { room_id: roomId, agent_id: member })).removed,
    false,
  );
  const hostRemoval = await call(app, a.key, 'city_room_remove', {
    room_id: roomId,
    agent_id: host,
  });
  assert.equal(hostRemoval.json().code, 'cannot_remove_host');
  assert.ok((await events(app, b.id)).some((e) => e.type === 'room.removed'));

  // Close: read-only history, no posts, no joins.
  await post(app, c.key, roomId, 'Last words');
  const closed = await ok(app, a.key, 'city_room_close', { room_id: roomId });
  assert.equal(closed.closed, true);
  assert.equal(closed.room.closed, true);
  assert.equal(closed.room.read_only, true);
  const afterClose = await post(app, c.key, roomId, 'After close');
  assert.equal(afterClose.statusCode, 409);
  assert.equal(afterClose.json().code, 'room_closed');
  const history = await ok(app, c.key, 'city_room_read', { room_id: roomId });
  // The last post, then the close's system line (T11).
  assert.equal(history.messages.at(-2).text, 'Last words');
  assert.equal(history.messages.at(-1).text, 'The host closed the room.');
  assert.equal(history.messages.at(-1).sender_kind, 'system');
  assert.equal(history.room.read_only, true);
  const d = await owner(app, 'Too late');
  const dAgent = await agent(app, d.key, 'D');
  // The real link of a closed room says so; it never admits anyone.
  assert.equal((await join(app, d.key, rotated.link, dAgent)).json().code, 'room_closed');
  assert.equal((await call(app, a.key, 'city_room_link', { room_id: roomId })).statusCode, 409);
  assert.equal((await ok(app, a.key, 'city_room_close', { room_id: roomId })).closed, false);
  assert.ok((await events(app, c.id)).some((e) => e.type === 'room.closed'));
});

test('idempotency: create, join and post replays are free and never duplicate', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Replay host');
  const b = await owner(app, 'Replay member');
  const host = await agent(app, a.key, 'Host');
  const member = await agent(app, b.key, 'Member');
  const other = await agent(app, b.key, 'Other');
  const key = randomUUID();
  const args = { agent_id: host, name: 'Replay room', idempotency_key: key };
  const first = await ok(app, a.key, 'city_create_room', args);
  const replay = await ok(app, a.key, 'city_create_room', args);
  assert.equal(replay.room.id, first.room.id);
  assert.equal(replay.replayed, true);
  assert.equal(replay.link.link, first.link.link);
  const conflict = await call(app, a.key, 'city_create_room', { ...args, name: 'Other name' });
  assert.equal(conflict.statusCode, 409);

  const joinKey = randomUUID();
  const joined = await join(app, b.key, first.link.link, member, joinKey);
  const rejoined = await join(app, b.key, first.link.link, member, joinKey);
  assert.equal(rejoined.statusCode, 200);
  assert.equal(rejoined.json().replayed, true);
  assert.equal(rejoined.json().agent_id, joined.json().agent_id);
  const changed = await join(app, b.key, first.link.link, other, joinKey);
  assert.equal(changed.statusCode, 409);
  // Joining again with a new key as an existing member consumes nothing.
  const again = await join(app, b.key, first.link.link, member);
  assert.equal(again.json().joined, false);
  assert.equal((await ok(app, a.key, 'city_room_link', { room_id: first.room.id })).uses, 1);

  const postKey = randomUUID();
  const body = { room_id: first.room.id, text: 'Once only', idempotency_key: postKey };
  const one = await ok(app, b.key, 'city_room_post', body);
  const two = await ok(app, b.key, 'city_room_post', body);
  assert.equal(two.message.id, one.message.id);
  assert.equal(two.replayed, true);
  assert.equal(
    (await call(app, b.key, 'city_room_post', { ...body, text: 'Different' })).statusCode,
    409,
  );
  assert.equal((await ok(app, b.key, 'city_room_read', { room_id: first.room.id })).latest_seq, 1);
});

test('member cap, agents per owner and the per-room seq stay exact under concurrent posts', async (t) => {
  const app = await fixture(t, { rooms: { agentsPerOwnerPerRoom: 2 } });
  const a = await owner(app, 'Cap host');
  const host = await agent(app, a.key, 'Host');
  const small = await createRoom(app, a.key, host, { member_cap: 3 });
  const b = await owner(app, 'Cap member');
  const [b1, b2, b3] = [
    await agent(app, b.key, 'B1'),
    await agent(app, b.key, 'B2'),
    await agent(app, b.key, 'B3'),
  ];
  assert.equal((await join(app, b.key, small.link.link, b1)).statusCode, 200);
  assert.equal((await join(app, b.key, small.link.link, b2)).statusCode, 200);
  const full = await join(app, b.key, small.link.link, b3);
  assert.equal(full.statusCode, 409);
  assert.equal(full.json().code, 'room_full');
  const big = await createRoom(app, a.key, host);
  await join(app, b.key, big.link.link, b1);
  await join(app, b.key, big.link.link, b2);
  const many = await join(app, b.key, big.link.link, b3);
  assert.equal(many.json().code, 'too_many_agents');

  const posters: Array<[string, string | undefined]> = [
    [a.key, undefined],
    [b.key, b1],
    [b.key, b2],
  ];
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, index) => {
      const [key, agentId] = posters[index % 3]!;
      return post(
        app,
        key,
        big.room.id,
        `Concurrent ${index}`,
        agentId ? { agent_id: agentId } : {},
      );
    }),
  );
  for (const res of results) assert.equal(res.statusCode, 200, res.body);
  const seqs = results.map((res) => res.json().message.seq as number).sort((x, y) => x - y);
  assert.deepEqual(
    seqs,
    Array.from({ length: 30 }, (_, index) => index + 1),
  );
  // A lookup (since 0): the host's own posts are not unread for it.
  const read = await ok(app, a.key, 'city_room_read', {
    room_id: big.room.id,
    since: 0,
    limit: 100,
  });
  assert.deepEqual(
    read.messages.map((m: { seq: number }) => m.seq),
    seqs,
  );
});

test('console REST: the same operations with a session, in the shapes the rooms UI expects', async (t) => {
  const app = await fixture(t);
  const register = async (name: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: jsonHeaders,
      payload: JSON.stringify({ name, password: PASSWORD }),
    });
    assert.equal(res.statusCode, 201, res.body);
    return `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
  };
  const api = (cookie: string, method: 'GET' | 'POST', url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...jsonHeaders, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const hostCookie = await register('Rest host');
  const memberCookie = await register('Rest member');
  const agentOf = async (cookie: string, name: string) =>
    (
      await api(cookie, 'POST', '/api/agents', { name, capability: 'research', mode: 'hosted' })
    ).json().agent.id as string;
  const host = await agentOf(hostCookie, 'Rest host desk');
  const member = await agentOf(memberCookie, 'Rest member desk');

  const created = await api(hostCookie, 'POST', '/api/rooms', {
    agent_id: host,
    name: 'REST room',
    idempotency_key: randomUUID(),
  });
  assert.equal(created.statusCode, 201, created.body);
  const room = created.json().room;
  const link = created.json().link.link as string;
  const [path, token] = link.split('#');
  const slug = path!.split('/r/')[1]!;
  assert.equal(slug, room.slug);

  // The UI's join({room_id, token, agent_id, idempotency_key}).
  const joined = await api(memberCookie, 'POST', `/api/rooms/${slug}/join`, {
    token,
    agent_id: member,
    idempotency_key: randomUUID(),
  });
  assert.equal(joined.statusCode, 200, joined.body);
  for (const field of ['id', 'name', 'topic', 'closed', 'read_only', 'role'])
    assert.ok(field in joined.json().room, field);
  const sent = await api(memberCookie, 'POST', `/api/rooms/${slug}/messages`, {
    text: 'Hello over REST',
    idempotency_key: randomUUID(),
  });
  assert.equal(sent.statusCode, 201, sent.body);
  const read = await api(hostCookie, 'GET', `/api/rooms/${room.id}/messages?since=0`);
  assert.equal(read.statusCode, 200, read.body);
  const message = read.json().messages[0];
  for (const field of ['id', 'seq', 'sender', 'text', 'origin']) assert.ok(field in message, field);
  assert.equal(message.origin, 'external');
  assert.equal(message.sender, 'Rest member desk');
  // Person accounts are shown by an opaque label, never their sign-in name.
  assert.match(message.sender_owner_label, /^Account [0-9a-f]{8}$/);
  const members = await api(memberCookie, 'GET', `/api/rooms/${slug}/members`);
  // The host's agent, the host as a person (in its room from creation, under the name it goes by
  // there) and the member's agent.
  const hostPerson = members
    .json()
    .members.find((m: { kind: string; own: boolean }) => m.kind === 'person' && !m.own);
  assert.ok(hostPerson, 'the host is in its room as itself');
  assert.deepEqual(
    members
      .json()
      .members.filter((m: { kind: string }) => m.kind === 'agent')
      .map((m: { id: string; role: string }) => [m.id, m.role]),
    [
      [host, 'host'],
      [member, 'member'],
    ],
  );
  assert.equal(hostPerson.role, 'member');
  // Owner labels stay opaque: an account is never named by its sign-in name in a label.
  for (const m of members.json().members as Array<{ owner_label: string }>)
    assert.match(m.owner_label, /^Account [0-9a-f]{8}$/);
  const listed = await api(memberCookie, 'GET', '/api/rooms');
  assert.deepEqual(
    listed.json().rooms.map((r: { id: string }) => r.id),
    [room.id],
  );
  const current = await api(hostCookie, 'POST', `/api/rooms/${slug}/link`);
  assert.equal(current.json().link, link);
  const rotateKey = randomUUID();
  const rotated = await api(hostCookie, 'POST', `/api/rooms/${slug}/link/rotate`, {
    idempotency_key: rotateKey,
  });
  assert.notEqual(rotated.json().link, link);
  const replayed = await api(hostCookie, 'POST', `/api/rooms/${slug}/link/rotate`, {
    idempotency_key: rotateKey,
  });
  assert.equal(replayed.json().link, rotated.json().link);
  const memberRotate = await api(memberCookie, 'POST', `/api/rooms/${slug}/link/rotate`, {
    idempotency_key: randomUUID(),
  });
  assert.equal(memberRotate.statusCode, 403);
  const removed = await api(hostCookie, 'POST', `/api/rooms/${slug}/members/${member}/remove`, {});
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(
    (await api(memberCookie, 'GET', `/api/rooms/${slug}/messages`)).json().code,
    'removed_from_room',
  );
  const closed = await api(hostCookie, 'POST', `/api/rooms/${slug}/close`, {});
  assert.equal(closed.json().room.closed, true);
});

test('official MCP client: two AIs create, join, post and read a room over /mcp', async (t) => {
  const app = await fixture(t);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  const a = await owner(app, 'MCP host');
  const b = await owner(app, 'MCP member');
  const connect = async (key: string, name: string) => {
    const client = new Client({ name, version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        authProvider: { token: async () => key },
      }),
    );
    t.after(() => client.close());
    return client;
  };
  const structured = (result: unknown) =>
    (result as { structuredContent: Record<string, any> }).structuredContent;
  const hostClient = await connect(a.key, 'room-host');
  const memberClient = await connect(b.key, 'room-member');
  const names = (await memberClient.listTools()).tools.map((tool) => tool.name);
  for (const name of [
    'city_create_room',
    'city_room_link',
    'city_join_room',
    'city_room_post',
    'city_room_read',
    'city_room_members',
    'city_room_remove',
    'city_room_close',
    'city_room_update',
  ])
    assert.ok(names.includes(name), name);
  const tools = Object.fromEntries(
    (await memberClient.listTools()).tools.map((tool) => [tool.name, tool]),
  );
  assert.equal(
    tools.city_room_read!.annotations?.readOnlyHint,
    false,
    'a read moves the cursor and the visible status',
  );
  assert.equal(tools.city_room_close!.annotations?.destructiveHint, true);
  assert.equal(tools.city_room_update!.annotations?.destructiveHint, false);

  const hostAgent = structured(
    await hostClient.callTool({
      name: 'city_create_agent',
      arguments: {
        name: 'MCP host desk',
        description: 'Synthetic',
        capability: 'research',
        mode: 'external',
        idempotencyKey: randomUUID(),
      },
    }),
  ).agent.id;
  const created = structured(
    await hostClient.callTool({
      name: 'city_create_room',
      arguments: { agent_id: hostAgent, name: 'MCP room', idempotency_key: randomUUID() },
    }),
  );
  assert.ok(created.link.link.startsWith(`${base}/r/`));
  const joined = structured(
    await memberClient.callTool({
      name: 'city_join_room',
      arguments: {
        link: created.link.link,
        create: { name: 'MCP joiner' },
        idempotency_key: randomUUID(),
      },
    }),
  );
  assert.equal(joined.joined, true);
  await memberClient.callTool({
    name: 'city_room_post',
    arguments: { room_id: joined.room.id, text: 'Hi from MCP', idempotency_key: randomUUID() },
  });
  const read = structured(
    await hostClient.callTool({ name: 'city_room_read', arguments: { room_id: created.room.id } }),
  );
  assert.equal(read.messages[0].text, 'Hi from MCP');
  assert.equal(read.messages[0].origin, 'external');
  const denied = await memberClient.callTool({
    name: 'city_room_close',
    arguments: { room_id: created.room.id },
  });
  assert.equal(denied.isError, true);
  assert.equal(
    JSON.parse((denied.content as Array<{ text: string }>)[0]!.text).error.code,
    'host_required',
  );
  // The open endpoint exposes no room tool (anonymous room access waits for B1).
  const open = new Client({ name: 'open', version: '1.0.0' });
  await open.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/open`)));
  t.after(() => open.close());
  assert.ok(!(await open.listTools()).tools.some((tool) => tool.name.includes('room')));
});

test('an AI workspace created without a human joins rooms but hosts only after a co-owner grants rooms:host', async (t) => {
  const app = await fixture(t);
  const anonymous = await owner(app, 'Anonymous AI', { host: false });
  const mine = await agent(app, anonymous.key, 'Anon desk');
  const refused = await call(app, anonymous.key, 'city_create_room', {
    agent_id: mine,
    name: 'Not yet',
    idempotency_key: randomUUID(),
  });
  assert.equal(refused.statusCode, 403, refused.body);
  // Keys the AI mints itself never exceed its own scopes.
  const escalate = await call(app, anonymous.key, 'city_create_workspace_key', {
    label: 'escalate',
    scopes: ['workspace:read', 'rooms:host'],
  });
  assert.equal(escalate.statusCode, 403, escalate.body);
  // It still joins, reads and posts in rooms others host.
  const host = await owner(app, 'Hosting AI');
  const created = await createRoom(app, host.key, await agent(app, host.key, 'Host'));
  assert.equal((await join(app, anonymous.key, created.link.link, mine)).statusCode, 200);
  assert.equal((await post(app, anonymous.key, created.room.id, 'Hello')).statusCode, 200);
  assert.equal(
    (await call(app, anonymous.key, 'city_room_link', { room_id: created.room.id })).statusCode,
    403,
  );
});

test('read cursor is per owner: a second agent or a history switch does not replay what the owner read', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Cursor host');
  const b = await owner(app, 'Cursor member');
  const host = await agent(app, a.key, 'Cursor host desk');
  const bravo = await agent(app, b.key, 'Bravo');
  const charlie = await agent(app, b.key, 'Charlie');
  const created = await createRoom(app, a.key, host);
  const roomId = created.room.id as string;
  assert.equal((await join(app, b.key, created.link.link, bravo)).statusCode, 200);
  for (const text of ['One', 'Two', 'Three'])
    assert.equal((await post(app, a.key, roomId, text)).statusCode, 200);
  const unread = async () =>
    (await ok(app, b.key, 'city_room_read', { room_id: roomId })).messages.map(
      (m: { text: string }) => m.text,
    );
  assert.deepEqual(await unread(), ['One', 'Two', 'Three']);

  // A second agent of the same owner starts at the owner's cursor, not at 0.
  assert.equal((await join(app, b.key, created.link.link, charlie)).statusCode, 200);
  assert.deepEqual(await unread(), []);
  assert.equal((await post(app, a.key, roomId, 'Four')).statusCode, 200);
  assert.deepEqual(await unread(), ['Four']);

  // from_join, a third agent joins late, then full again: the owner already saw everything
  // (Bravo reads from 0), so the reopened history is not replayed as unread.
  const late = await agent(app, b.key, 'Late');
  await ok(app, a.key, 'city_room_update', { room_id: roomId, history: 'from_join' });
  assert.equal((await post(app, a.key, roomId, 'Five')).statusCode, 200);
  assert.equal((await join(app, b.key, created.link.link, late)).statusCode, 200);
  await ok(app, a.key, 'city_room_update', { room_id: roomId, history: 'full' });
  assert.deepEqual(await unread(), ['Five']);
  assert.deepEqual(await unread(), []);
});

test('read cursor with wait (as on /mcp): a wait that returns messages advances it, a timeout does not', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Wait host');
  const b = await owner(app, 'Wait member');
  const host = await agent(app, a.key, 'Wait host desk');
  const bravo = await agent(app, b.key, 'Bravo');
  const created = await createRoom(app, a.key, host);
  const roomId = created.room.id as string;
  assert.equal((await join(app, b.key, created.link.link, bravo)).statusCode, 200);
  const cursor = async () =>
    Number(
      (
        await app.city.db.query<{ last_read_seq: string | number }>(
          'SELECT last_read_seq FROM room_members WHERE room_id=$1 AND agent_id=$2',
          [roomId, bravo],
        )
      ).rows[0]!.last_read_seq,
    );
  assert.equal((await post(app, a.key, roomId, 'Ping')).statusCode, 200);
  const got = await ok(app, b.key, 'city_room_read', { room_id: roomId, wait: 1 });
  assert.deepEqual(
    got.messages.map((m: { text: string }) => m.text),
    ['Ping'],
  );
  assert.equal(await cursor(), 1);
  const empty = await ok(app, b.key, 'city_room_read', { room_id: roomId, wait: 1 });
  assert.deepEqual(empty.messages, []);
  assert.equal(await cursor(), 1);
});

test('no wake on your own post: post then read returns nothing new; unread messages from others still arrive', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Self host');
  const b = await owner(app, 'Self member');
  const host = await agent(app, a.key, 'Self host desk');
  const bravo = await agent(app, b.key, 'Bravo');
  const charlie = await agent(app, b.key, 'Charlie');
  const created = await createRoom(app, a.key, host);
  const roomId = created.room.id as string;
  assert.equal((await join(app, b.key, created.link.link, bravo)).statusCode, 200);
  const unread = async (extra: object = {}) =>
    (await ok(app, b.key, 'city_room_read', { room_id: roomId, ...extra })).messages.map(
      (m: { text: string }) => m.text,
    );
  const cursor = async (agentId: string) =>
    Number(
      (
        await app.city.db.query<{ last_read_seq: string | number }>(
          'SELECT last_read_seq FROM room_members WHERE room_id=$1 AND agent_id=$2',
          [roomId, agentId],
        )
      ).rows[0]!.last_read_seq,
    );
  assert.equal((await post(app, a.key, roomId, 'Welcome')).statusCode, 200);
  assert.deepEqual(await unread(), ['Welcome']);

  // Caught up, then my own post: the next read, and a long-poll, do not return it.
  const mine = await post(app, b.key, roomId, 'My reply', { agent_id: bravo });
  assert.equal(mine.statusCode, 200, mine.body);
  assert.equal(await cursor(bravo), mine.json().message.seq);
  assert.deepEqual(await unread(), []);
  assert.deepEqual(await unread({ wait: 1 }), []);
  // Others still see it as new.
  assert.deepEqual(
    (await ok(app, a.key, 'city_room_read', { room_id: roomId })).messages.map(
      (m: { text: string }) => m.text,
    ),
    ['My reply'],
  );

  // Another member posts between my read and my post: it is still delivered, with my post.
  assert.equal((await post(app, a.key, roomId, 'Question for you')).statusCode, 200);
  const late = await post(app, b.key, roomId, 'Posted before reading', { agent_id: bravo });
  assert.equal(late.statusCode, 200, late.body);
  assert.ok((await cursor(bravo)) < late.json().message.seq, 'an unread message keeps the cursor');
  assert.deepEqual(await unread(), ['Question for you', 'Posted before reading']);
  assert.deepEqual(await unread(), []);

  // Reads are per owner: a second agent of the same owner at the head moves too.
  assert.equal((await join(app, b.key, created.link.link, charlie)).statusCode, 200);
  const third = await post(app, b.key, roomId, 'From Bravo again', { agent_id: bravo });
  assert.equal(third.statusCode, 200, third.body);
  assert.equal(await cursor(charlie), third.json().message.seq);
  assert.deepEqual(await unread(), []);
  // The other owner's cursor never moves on my post.
  assert.ok((await cursor(host)) < third.json().message.seq);
});

test('city_room_leave (workspace key, as on /mcp): a member leaves; the host is told to close instead', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Leave host workspace');
  const b = await owner(app, 'Leaving workspace');
  const host = await agent(app, a.key, 'Leave host desk');
  const bravo = await agent(app, b.key, 'Bravo');
  const created = await createRoom(app, a.key, host);
  const roomId = created.room.id as string;
  assert.equal((await join(app, b.key, created.link.link, bravo)).statusCode, 200);

  const hostLeave = await call(app, a.key, 'city_room_leave', { room_id: roomId });
  assert.equal(hostLeave.statusCode, 400, hostLeave.body);
  assert.equal(hostLeave.json().code, 'host_cannot_leave');
  const left = await ok(app, b.key, 'city_room_leave', { room_id: roomId });
  assert.deepEqual(left, { room_id: roomId, agent_id: bravo, left: true });
  const members = await ok(app, a.key, 'city_room_members', { room_id: roomId });
  assert.deepEqual(
    members.members.map((m: { name: string }) => m.name),
    ['Leave host desk'],
  );
  assert.equal((await post(app, b.key, roomId, 'Still here?')).statusCode, 404);
  assert.equal((await ok(app, b.key, 'city_room_leave', { room_id: roomId })).left, false);
});
