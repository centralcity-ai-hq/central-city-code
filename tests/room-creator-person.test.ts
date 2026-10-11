import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { personMemberId } from '../server/rooms/person.js';
import { createPrivateRoom } from '../server/rooms/private.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-room-creator-person-test-root-secret';

/**
 * People are in their own rooms by default (docs/ROOMS.md "Your own rooms"): a room created in
 * the app has its creator in it as a person; the host joins an older room, or one an AI created,
 * with POST /api/rooms/:room/join-self. The host's person takes none of its AI slots, posts
 * without agent_id come from it, and it messages its own host agent privately. AI-created rooms,
 * co-owned AI workspaces and private Elric chats get no person. Synthetic data only.
 */
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};
let address = 60;

type Member = { id: string; name: string; kind: string; role: string; own: boolean };

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
  const post = (url: string, body: unknown, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress: `203.0.113.${address}`,
    });
  const get = (url: string, extra: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { ...headers, ...extra } });
  const agent = async (cookie: string, name: string) => {
    const res = await post(
      '/api/agents',
      { name, capability: 'research', mode: 'hosted' },
      { cookie },
    );
    assert.equal(res.statusCode, 201, res.body);
    return res.json().agent.id as string;
  };
  const account = async (name: string, agentName = `${name} agent`) => {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers,
      payload: JSON.stringify({ name, password: 'Synthetic creator person password' }),
      remoteAddress: `203.0.113.${address++}`,
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const operatorId = (await get('/api/session', { cookie })).json().operator.id as string;
    return { cookie, operatorId, agentId: await agent(cookie, agentName) };
  };
  const create = (cookie: string, body: Record<string, unknown>, extra = {}) =>
    post('/api/rooms', { idempotency_key: randomUUID(), ...body }, { cookie, ...extra });
  const members = async (cookie: string, roomId: string) => {
    const res = await get(`/api/rooms/${roomId}/members`, { cookie });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().members as Member[];
  };
  const roomOf = async (cookie: string, roomId: string) =>
    (await get('/api/rooms', { cookie })).json().rooms.find((r: { id: string }) => r.id === roomId);
  const joinSelf = (cookie: string, roomId: string, body: unknown = {}) =>
    post(`/api/rooms/${roomId}/join-self`, body, { cookie });
  /** An assistant grant of this account: its AI calls the MCP tools. */
  const grant = async (cookie: string) => {
    const granted = await post(
      '/api/assistant-access',
      { label: 'Synthetic assistant', scopes: ASSISTANT_SCOPES, expiresInDays: 1 },
      { cookie },
    );
    assert.equal(granted.statusCode, 201, granted.body);
    return granted.json().token as string;
  };
  const tool = (token: string, name: string, args: unknown) =>
    post(`/api/assistant/tools/${name}`, args, { authorization: `Bearer ${token}` });
  /** A room an AI creates for this account (an assistant grant on MCP): no person in it. */
  const aiRoom = async (cookie: string, agentId: string, extra: Record<string, unknown> = {}) => {
    const token = await grant(cookie);
    const res = await post(
      '/api/assistant/tools/city_create_room',
      { agent_id: agentId, name: 'AI made room', idempotency_key: randomUUID(), ...extra },
      { authorization: `Bearer ${token}` },
    );
    assert.equal(res.statusCode, 200, res.body);
    return { roomId: res.json().room.id as string, link: res.json().link.link as string, token };
  };
  return {
    app,
    post,
    get,
    agent,
    account,
    create,
    members,
    roomOf,
    joinSelf,
    grant,
    tool,
    aiRoom,
  };
}

test('a room created in the app has its creator in it as a person: posts, recipients, direct thread', async (t) => {
  const f = await fixture(t);
  const ann = await f.account('Ann Creator', 'Hostbot');
  const key = randomUUID();
  const created = await f.create(ann.cookie, {
    name: 'Ann room',
    agent_id: ann.agentId,
    idempotency_key: key,
  });
  assert.equal(created.statusCode, 201, created.body);
  const room = created.json().room;
  const personId = personMemberId(ann.operatorId, room.id);
  // The answer already says the creator is in the room as themselves.
  assert.deepEqual(room.person, { id: personId, name: 'Ann Creator' });
  assert.equal(room.role, 'host');
  assert.equal(room.member_count, 2);
  const list = await f.members(ann.cookie, room.id);
  assert.deepEqual(list.map((m) => [m.name, m.kind, m.role, m.own]).sort(), [
    ['Ann Creator', 'person', 'member', true],
    ['Hostbot', 'agent', 'host', true],
  ]);
  assert.equal(list.find((m) => m.kind === 'person')!.id, personId);
  // Atomic with the room and idempotent: a replay creates nothing, and no second person.
  const replay = await f.create(ann.cookie, {
    name: 'Ann room',
    agent_id: ann.agentId,
    idempotency_key: key,
  });
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(replay.json().replayed, true);
  assert.deepEqual(replay.json().room.person, { id: personId, name: 'Ann Creator' });
  assert.equal((await f.members(ann.cookie, room.id)).length, 2);
  // The person's row: the whole history of the new room; audited like a join.
  const row = (
    await f.app.city.db.query<{ visible_from_seq: string | number; owner_label: string }>(
      'SELECT visible_from_seq, owner_label FROM room_members WHERE room_id=$1 AND agent_id=$2',
      [room.id, personId],
    )
  ).rows[0]!;
  assert.equal(Number(row.visible_from_seq), 0);
  assert.match(row.owner_label, /^Account [0-9a-f]{8}$/, 'never the account name');
  const audit = await f.app.city.db.query(
    "SELECT 1 FROM room_events WHERE room_id=$1 AND agent_id=$2 AND action='member.joined'",
    [room.id, personId],
  );
  assert.equal(audit.rows.length, 1);

  // A post without agent_id comes from the person; agent_id picks the AI.
  const said = await f.post(
    `/api/rooms/${room.id}/messages`,
    { text: 'Hello from me', idempotency_key: randomUUID() },
    { cookie: ann.cookie },
  );
  assert.equal(said.statusCode, 201, said.body);
  assert.equal(said.json().message.sender_kind, 'person');
  assert.equal(said.json().message.sender_agent_id, personId);
  assert.equal(said.json().message.sender, 'Ann Creator');
  const asAi = await f.post(
    `/api/rooms/${room.id}/messages`,
    { text: 'Hello from the AI', agent_id: ann.agentId, idempotency_key: randomUUID() },
    { cookie: ann.cookie },
  );
  assert.equal(asAi.statusCode, 201, asAi.body);
  assert.equal(asAi.json().message.sender_kind, 'agent');
  assert.equal(asAi.json().message.sender, 'Hostbot');

  // Messages: the host agent is a recipient of the person, and the person writes to it privately.
  const recipients = await f.get('/api/messages/recipients', { cookie: ann.cookie });
  assert.equal(recipients.statusCode, 200, recipients.body);
  assert.deepEqual(
    (
      recipients.json().recipients as Array<{
        room_id: string;
        member_id: string;
        kind: string;
        own: boolean;
      }>
    )
      .filter((r) => r.room_id === room.id)
      .map((r) => [r.member_id, r.kind, r.own]),
    [[ann.agentId, 'agent', true]],
  );
  const opened = await f.post(
    `/api/rooms/${room.id}/direct`,
    { to: ann.agentId },
    { cookie: ann.cookie },
  );
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal(opened.json().self.id, personId);
  assert.equal(opened.json().self.kind, 'person');
  assert.equal(opened.json().peer.id, ann.agentId);
  const sent = await f.post(
    `/api/rooms/${room.id}/direct/messages`,
    { from: personId, to: ann.agentId, text: 'Just between us', idempotency_key: randomUUID() },
    { cookie: ann.cookie },
  );
  assert.equal(sent.statusCode, 201, sent.body);
});

test("the host's person takes none of its AI slots; a guest person still counts", async (t) => {
  const f = await fixture(t);
  const ann = await f.account('Ann Slots', 'Host one');
  const created = await f.create(ann.cookie, { name: 'Slots', agent_id: ann.agentId });
  assert.equal(created.statusCode, 201, created.body);
  const roomId = created.json().room.id as string;
  const addAi = async (cookie: string, agentId: string) =>
    f.post(
      `/api/rooms/${roomId}/join`,
      { agent_id: agentId, idempotency_key: randomUUID() },
      { cookie },
    );
  // The host agent and two more of the host's AIs: three AIs next to the host's person.
  for (const name of ['Host two', 'Host three']) {
    const added = await addAi(ann.cookie, await f.agent(ann.cookie, name));
    assert.equal(added.statusCode, 200, added.body);
  }
  const fourth = await addAi(ann.cookie, await f.agent(ann.cookie, 'Host four'));
  assert.equal(fourth.statusCode, 409, fourth.body);
  assert.equal(fourth.json().code, 'too_many_agents');
  const mine = (await f.members(ann.cookie, roomId)).filter((m) => m.own);
  assert.equal(mine.filter((m) => m.kind === 'agent').length, 3);
  assert.equal(mine.filter((m) => m.kind === 'person').length, 1);
  // join-self with all three AI slots taken: already in, nothing refused.
  const again = await f.joinSelf(ann.cookie, roomId);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().joined, false);

  // A guest person is unchanged: the person and two AIs (documented per-room cap).
  const link = await f.post(
    '/api/links',
    { target: 'room', room_id: roomId },
    { cookie: ann.cookie },
  );
  assert.equal(link.statusCode, 201, link.body);
  const bo = await f.account('Bo Guest', 'Bo one');
  const joined = await f.post(
    '/api/rooms/join',
    { code: link.json().code, name: 'Bo', idempotency_key: randomUUID() },
    { cookie: bo.cookie },
  );
  assert.equal(joined.statusCode, 200, joined.body);
  assert.equal((await addAi(bo.cookie, bo.agentId)).statusCode, 200);
  assert.equal((await addAi(bo.cookie, await f.agent(bo.cookie, 'Bo two'))).statusCode, 200);
  const third = await addAi(bo.cookie, await f.agent(bo.cookie, 'Bo three'));
  assert.equal(third.statusCode, 409, third.body);
  assert.equal(third.json().code, 'too_many_agents');
});

test('rooms an AI creates, or a co-owned AI workspace creates, start without a person', async (t) => {
  const f = await fixture(t);
  const ann = await f.account('Ann Assisted', 'Assisted host');
  // An assistant grant (MCP) of a person account: the AI acts, so no person is added.
  const made = await f.aiRoom(ann.cookie, ann.agentId);
  const list = await f.members(ann.cookie, made.roomId);
  assert.deepEqual(
    list.map((m) => [m.kind, m.role]),
    [['agent', 'host']],
  );
  const view = await f.roomOf(ann.cookie, made.roomId);
  // Present and null: not in the room as itself, but it may join its own room (join-self).
  assert.ok('person' in view);
  assert.equal(view.person, null, 'the console sees it is not in the room as itself');
  assert.equal(view.member_count, 1);
  // A post from the console without agent_id still comes from the only member, the host agent.
  const said = await f.post(
    `/api/rooms/${made.roomId}/messages`,
    { text: 'From the console', idempotency_key: randomUUID() },
    { cookie: ann.cookie },
  );
  assert.equal(said.statusCode, 201, said.body);
  assert.equal(said.json().message.sender_kind, 'agent');
  // Tool results never carry the console-only field.
  const tool = await f.post(
    '/api/assistant/tools/city_room_read',
    { room_id: made.roomId },
    { authorization: `Bearer ${made.token}` },
  );
  assert.equal(tool.statusCode, 200, tool.body);
  assert.equal('person' in tool.json().room, false);

  // The console of a co-owned AI workspace: the room is the AI workspace's, with no person.
  const ai = await f.app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers,
    payload: JSON.stringify({ name: 'Synthetic AI workspace', idempotency_key: randomUUID() }),
    remoteAddress: `198.51.100.${address++}`,
  });
  assert.equal(ai.statusCode, 201, ai.body);
  const workspace = ai.json().workspace_id as string;
  const claimed = await f.post(
    '/api/workspaces/claim',
    { claim_token: ai.json().claim_token },
    { cookie: ann.cookie },
  );
  assert.equal(claimed.statusCode, 200, claimed.body);
  const inAi = { cookie: ann.cookie, 'x-city-workspace': workspace };
  const aiAgent = await f.post(
    '/api/agents',
    { name: 'Workspace host', capability: 'research', mode: 'hosted' },
    inAi,
  );
  assert.equal(aiAgent.statusCode, 201, aiAgent.body);
  const created = await f.post(
    '/api/rooms',
    { name: 'AI workspace room', agent_id: aiAgent.json().agent.id, idempotency_key: randomUUID() },
    inAi,
  );
  assert.equal(created.statusCode, 201, created.body);
  // An AI workspace is never in a room as itself: no person field at all.
  assert.equal('person' in created.json().room, false);
  assert.equal(created.json().room.member_count, 1);
  const aiRoomId = created.json().room.id as string;
  const listed = (await f.get('/api/rooms', inAi)).json().rooms as Array<Record<string, unknown>>;
  assert.equal('person' in listed.find((r) => r.id === aiRoomId)!, false);

  // join-self from that workspace's console: the uniform 404, and nobody is added.
  const selfInAi = await f.post(`/api/rooms/${aiRoomId}/join-self`, {}, inAi);
  assert.equal(selfInAi.statusCode, 404, selfInAi.body);
  assert.equal(selfInAi.json().code, 'room_not_found');
  const rows = (
    await f.app.city.db.query<{ kind: string }>('SELECT kind FROM room_members WHERE room_id=$1', [
      aiRoomId,
    ])
  ).rows;
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['agent'],
  );
  // The person's own workspace still sees its own rooms with the field (here: in it).
  const own = await f.create(ann.cookie, { name: 'Own again', agent_id: ann.agentId });
  assert.equal(own.statusCode, 201, own.body);
  assert.ok(own.json().room.person && typeof own.json().room.person.id === 'string');
});

test('join-self: the host joins its own room as itself, idempotently, with the join rules', async (t) => {
  const f = await fixture(t);
  const ann = await f.account('Ann Later', 'Later host');
  const made = await f.aiRoom(ann.cookie, ann.agentId, { history: 'from_join' });
  const personId = personMemberId(ann.operatorId, made.roomId);
  // The host agent posts before the person joins.
  const early = await f.post(
    `/api/rooms/${made.roomId}/messages`,
    { text: 'Before you', idempotency_key: randomUUID() },
    { cookie: ann.cookie },
  );
  assert.equal(early.statusCode, 201, early.body);

  // Nobody else: another account, a guest member of the room, a grant on the console route.
  const bo = await f.account('Bo Other');
  const foreign = await f.joinSelf(bo.cookie, made.roomId);
  assert.equal(foreign.statusCode, 404, foreign.body);
  assert.equal(foreign.json().code, 'room_not_found');
  const guest = await f.post(
    '/api/rooms/join',
    { link: made.link, name: 'Bo', idempotency_key: randomUUID() },
    { cookie: bo.cookie },
  );
  assert.equal(guest.statusCode, 200, guest.body);
  const member = await f.joinSelf(bo.cookie, made.roomId);
  assert.equal(member.statusCode, 404, member.body);
  const byGrant = await f.post(
    `/api/rooms/${made.roomId}/join-self`,
    {},
    { authorization: `Bearer ${made.token}` },
  );
  assert.equal(byGrant.statusCode, 401, byGrant.body);
  const unknown = await f.joinSelf(ann.cookie, randomUUID());
  assert.equal(unknown.statusCode, 404, unknown.body);
  // A reserved name is refused like on any person join (reserved while Elric is on).
  const elricWas = process.env.CITY_ELRIC;
  process.env.CITY_ELRIC = '1';
  const reserved = await f.joinSelf(ann.cookie, made.roomId, { name: 'Elric' });
  if (elricWas === undefined) delete process.env.CITY_ELRIC;
  else process.env.CITY_ELRIC = elricWas;
  assert.equal(reserved.statusCode, 409, reserved.body);
  const unknownField = await f.joinSelf(ann.cookie, made.roomId, { agent_id: ann.agentId });
  assert.equal(unknownField.statusCode, 400, unknownField.body);

  const joined = await f.joinSelf(ann.cookie, made.roomId, { name: '  Ann  L.  ' });
  assert.equal(joined.statusCode, 200, joined.body);
  assert.equal(joined.json().joined, true);
  assert.deepEqual(
    { ...joined.json().member, joined_at: undefined },
    {
      id: personId,
      name: 'Ann L.',
      kind: 'person',
      role: 'member',
      own: true,
      joined_at: undefined,
    },
  );
  assert.deepEqual(joined.json().room.person, { id: personId, name: 'Ann L.' });
  assert.equal(joined.json().room.role, 'host');
  // History by the room's rule ('from_join': from now), like any join; the read cursor at the
  // latest message, so the room does not start out unread.
  const row = (
    await f.app.city.db.query<{
      visible_from_seq: string | number;
      last_read_seq: string | number;
    }>(
      'SELECT visible_from_seq, last_read_seq FROM room_members WHERE room_id=$1 AND agent_id=$2',
      [made.roomId, personId],
    )
  ).rows[0]!;
  assert.equal(Number(row.visible_from_seq), early.json().message.seq);
  assert.equal(Number(row.last_read_seq), early.json().message.seq);
  // Idempotent: the same member, nothing new.
  const again = await f.joinSelf(ann.cookie, made.roomId, { name: 'Another name' });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().joined, false);
  assert.equal(again.json().member.id, personId);
  assert.equal(again.json().member.name, 'Ann L.');
  assert.equal(
    (await f.members(ann.cookie, made.roomId)).filter((m) => m.own && m.kind === 'person').length,
    1,
  );
  // Now a console post without agent_id comes from the person.
  const said = await f.post(
    `/api/rooms/${made.roomId}/messages`,
    { text: 'Now as me', idempotency_key: randomUUID() },
    { cookie: ann.cookie },
  );
  assert.equal(said.statusCode, 201, said.body);
  assert.equal(said.json().message.sender_agent_id, personId);

  // Left on its own: comes back in place.
  const left = await f.post(
    `/api/rooms/${made.roomId}/leave`,
    { agent_id: personId },
    { cookie: ann.cookie },
  );
  assert.equal(left.statusCode, 200, left.body);
  assert.equal((await f.roomOf(ann.cookie, made.roomId)).person, null);
  const back = await f.joinSelf(ann.cookie, made.roomId);
  assert.equal(back.statusCode, 200, back.body);
  assert.equal(back.json().joined, true);
  assert.equal(back.json().member.name, 'Ann Later', 'default: the account name');

  // Removed by the host: stays out until allowed back.
  const removed = await f.post(
    `/api/rooms/${made.roomId}/members/${personId}/remove`,
    {},
    { cookie: ann.cookie },
  );
  assert.equal(removed.statusCode, 200, removed.body);
  const refused = await f.joinSelf(ann.cookie, made.roomId);
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().code, 'removed_from_room');
  const allowed = await f.post(
    `/api/rooms/${made.roomId}/members/${personId}/remove`,
    { block_rejoin: false },
    { cookie: ann.cookie },
  );
  assert.equal(allowed.statusCode, 200, allowed.body);
  const readmitted = await f.joinSelf(ann.cookie, made.roomId);
  assert.equal(readmitted.statusCode, 200, readmitted.body);
  assert.equal(readmitted.json().joined, true);
});

test('join-self refuses closed and full rooms; private Elric and agent chats stay as they are', async (t) => {
  const f = await fixture(t);
  const ann = await f.account('Ann Closed', 'Closed host');
  const closedRoom = await f.aiRoom(ann.cookie, ann.agentId);
  const closed = await f.post(`/api/rooms/${closedRoom.roomId}/close`, {}, { cookie: ann.cookie });
  assert.equal(closed.statusCode, 200, closed.body);
  const late = await f.joinSelf(ann.cookie, closedRoom.roomId);
  assert.equal(late.statusCode, 409, late.body);
  assert.equal(late.json().code, 'room_closed');

  // Full: a two-member room with the host agent and another owner's AI.
  const full = await f.aiRoom(ann.cookie, ann.agentId, { member_cap: 2 });
  const bo = await f.account('Bo Full');
  const boJoined = await f.post(
    `/api/rooms/${full.roomId}/join`,
    { link: full.link, agent_id: bo.agentId, idempotency_key: randomUUID() },
    { cookie: bo.cookie },
  );
  assert.equal(boJoined.statusCode, 200, boJoined.body);
  // Bo is in another host's room only through its AI: it cannot join it as itself from here, so
  // its room view has no person field (not null).
  const boView = await f.roomOf(bo.cookie, full.roomId);
  assert.ok(boView, "the room is in Bo's list");
  assert.equal('person' in boView, false);
  const noRoom = await f.joinSelf(ann.cookie, full.roomId);
  assert.equal(noRoom.statusCode, 409, noRoom.body);
  assert.equal(noRoom.json().code, 'room_full');

  // A private Elric chat (rooms/private.ts): the owner's person hosts, Elric is a member; nothing
  // changes it, and join-self is refused like every other path into it.
  const elric = await f.agent(ann.cookie, 'Private helper');
  const time = Date.now();
  const privateRoom = await f.app.city.db.transaction((tx) =>
    createPrivateRoom(tx, { ownerId: ann.operatorId, elricAgentId: elric, time }),
  );
  const rows = (
    await f.app.city.db.query<{ kind: string; role: string }>(
      'SELECT kind, role FROM room_members WHERE room_id=$1 ORDER BY kind',
      [privateRoom.room_id],
    )
  ).rows;
  assert.deepEqual(
    rows.map((r) => [r.kind, r.role]),
    [
      ['agent', 'member'],
      ['person', 'host'],
    ],
  );
  const refused = await f.joinSelf(ann.cookie, privateRoom.room_id);
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, 'room_private');
  assert.equal(
    Number(
      (
        await f.app.city.db.query<{ n: string | number }>(
          'SELECT count(*) AS n FROM room_members WHERE room_id=$1',
          [privateRoom.room_id],
        )
      ).rows[0]!.n,
    ),
    2,
  );

  // A private chat with one of your own agents ("Message <agent>"): the server makes it with
  // the owner's person as its host, nothing from rooms/create adds another, and join-self is
  // refused like for every private room.
  const helper = await f.agent(ann.cookie, 'Chat helper');
  const chat = await f.post(
    '/api/rooms/private-agent',
    { agent_id: helper },
    { cookie: ann.cookie },
  );
  assert.equal(chat.statusCode, 200, chat.body);
  const chatId = chat.json().room_id as string;
  const chatRows = async () =>
    (
      await f.app.city.db.query<{ agent_id: string; kind: string; role: string }>(
        'SELECT agent_id, kind, role FROM room_members WHERE room_id=$1 ORDER BY kind',
        [chatId],
      )
    ).rows.map((r) => [r.agent_id, r.kind, r.role]);
  const before = await chatRows();
  assert.deepEqual(before, [
    [helper, 'agent', 'member'],
    [chat.json().person_member_id, 'person', 'host'],
  ]);
  const chatSelf = await f.joinSelf(ann.cookie, chatId);
  assert.equal(chatSelf.statusCode, 409, chatSelf.body);
  assert.equal(chatSelf.json().code, 'room_private');
  assert.deepEqual(await chatRows(), before);
  // Its room view says the owner is in it as itself.
  const chatPerson = (await f.members(ann.cookie, chatId)).find((m) => m.kind === 'person')!;
  assert.deepEqual((await f.roomOf(ann.cookie, chatId)).person, {
    id: chat.json().person_member_id,
    name: chatPerson.name,
  });
});

test('without agent_id the console acts as its person and an AI as its only AI: posts, tasks, pins', async (t) => {
  const saved = process.env.CITY_ROOM_TASKS;
  process.env.CITY_ROOM_TASKS = '1';
  t.after(() => {
    if (saved === undefined) delete process.env.CITY_ROOM_TASKS;
    else process.env.CITY_ROOM_TASKS = saved;
  });
  const f = await fixture(t);
  const ann = await f.account('Ann Defaults', 'Default host');
  const created = await f.create(ann.cookie, { name: 'Defaults', agent_id: ann.agentId });
  assert.equal(created.statusCode, 201, created.body);
  const roomId = created.json().room.id as string;
  const personId = personMemberId(ann.operatorId, roomId);
  const token = await f.grant(ann.cookie);

  // Posts: the AI of the same account (a grant) posts as its host agent, never as the person.
  const aiPost = await f.tool(token, 'city_room_post', {
    room_id: roomId,
    text: 'From the AI',
    idempotency_key: randomUUID(),
  });
  assert.equal(aiPost.statusCode, 200, aiPost.body);
  assert.equal(aiPost.json().message.sender_agent_id, ann.agentId);
  const asPerson = await f.tool(token, 'city_room_post', {
    room_id: roomId,
    text: 'Pretending',
    agent_id: personId,
    idempotency_key: randomUUID(),
  });
  assert.notEqual(asPerson.statusCode, 200, asPerson.body);

  // Tasks: the console creates as the person, the AI as its host agent.
  const consoleTask = await f.post(
    `/api/rooms/${roomId}/tasks`,
    { title: 'From the console', idempotency_key: randomUUID() },
    { cookie: ann.cookie },
  );
  assert.equal(consoleTask.statusCode, 201, consoleTask.body);
  assert.equal(consoleTask.json().task.created_by_agent_id, personId);
  const aiTask = await f.tool(token, 'city_room_task_create', {
    room_id: roomId,
    title: 'From the AI',
    idempotency_key: randomUUID(),
  });
  assert.equal(aiTask.statusCode, 200, aiTask.body);
  assert.equal(aiTask.json().task.created_by_agent_id, ann.agentId);
  // The AI never acts as its account's person, even when it names it.
  const aiAsPerson = await f.tool(token, 'city_room_task_create', {
    room_id: roomId,
    title: 'As the person',
    agent_id: personId,
    idempotency_key: randomUUID(),
  });
  assert.notEqual(aiAsPerson.statusCode, 200, aiAsPerson.body);
  assert.match(aiAsPerson.body, /not_a_member/);

  // Pins: the same rule.
  const seq = aiPost.json().message.seq as number;
  const consolePin = await f.post(
    `/api/rooms/${roomId}/pins`,
    { message_seq: seq },
    { cookie: ann.cookie },
  );
  assert.equal(consolePin.statusCode, 201, consolePin.body);
  assert.equal(consolePin.json().pin.pinned_by_agent_id, personId);
  const aiPin = await f.tool(token, 'city_room_pin', {
    room_id: roomId,
    task_id: aiTask.json().task.id,
  });
  assert.equal(aiPin.statusCode, 200, aiPin.body);
  assert.equal(aiPin.json().pin.pinned_by_agent_id, ann.agentId);
  const aiPinAsPerson = await f.tool(token, 'city_room_pin', {
    room_id: roomId,
    message_seq: seq,
    agent_id: personId,
  });
  assert.notEqual(aiPinAsPerson.statusCode, 200, aiPinAsPerson.body);
  assert.match(aiPinAsPerson.body, /not_a_member/);
});
