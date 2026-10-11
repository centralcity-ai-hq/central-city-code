import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import type { ProviderPostRequest } from '../server/responder/providers.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-private-agent-chat-test-root-secret';

/**
 * Private chats with your own agents (server/rooms/private.ts, POST /api/rooms/private-agent).
 *
 * - The signed-in owner opens one room per own agent, the same room every time (also when
 *   concurrent): the owner's PERSON hosts it, the agent is the only other member, member_cap 2,
 *   no link, nobody may join. Any other agent id is the uniform 404.
 * - The room is locked like an Elric chat: every invite, join and host-settings path answers
 *   409 room_private. Only its owner's console deletes it (with its history); the next open makes
 *   a new chat.
 * - Every post of the owner's person there is addressed to the agent without an "@"
 *   (server/wake/hooks.ts roomPosted): a mention is recorded and its auto-reply can answer. The
 *   agent's own posts and auto-replies wake nothing, and a shared room still needs the "@".
 *
 * Fake provider and placeholder keys; synthetic data only.
 */
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};
const PLACEHOLDER_KEY = 'sk-ant-api03-test-private-chat-placeholder-0000';
const LINK_SHAPES =
  /\/r\/[^"\s]+#|\/j\/[A-Za-z0-9_-]{6,}|"(?:link|code|short_url|token)"\s*:\s*"[^"]+"/;
let address = 60;

type Chat = {
  room_id: string;
  slug: string;
  person_member_id: string;
  agent_id: string;
  status: 'active' | 'paused';
  latest_seq: number;
  created: boolean;
};

async function fixture(
  t: { after(fn: () => Promise<unknown>): void },
  options: { delivery?: boolean } = {},
) {
  const requests: ProviderPostRequest[] = [];
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
    responder: {
      enabled: true,
      env: { CITY_RESPONDER_KEK: randomBytes(32).toString('base64') },
      transport: async () => ({ status: 200 }),
      delivery: options.delivery ?? true,
      // The auto-reply names the agent itself: its own reply must never wake it again.
      postTransport: async (request) => {
        requests.push(request);
        return {
          status: 200,
          retryAfterMs: null,
          json: {
            content: [{ type: 'text', text: 'Alex here: @Alex will summarize now.' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 500, output_tokens: 20 },
          },
        };
      },
    },
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
  const call = (cookie: string, method: string, url: string, body?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { ...headers, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const createAgent = async (cookie: string, agentName: string) => {
    const agent = await post(
      '/api/agents',
      { name: agentName, capability: 'research', mode: 'hosted' },
      { cookie },
    );
    assert.equal(agent.statusCode, 201, agent.body);
    return agent.json().agent.id as string;
  };
  const account = async (name: string, agentName: string) => {
    const registered = await post(
      '/api/auth/register',
      { name, password: 'Synthetic private chat password' },
      {},
      `203.0.113.${address++}`,
    );
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const operatorId = (
      await app.city.db.query<{ id: string }>('SELECT id FROM operators WHERE name=$1', [name])
    ).rows[0]!.id;
    return { cookie, operatorId, agentId: await createAgent(cookie, agentName) };
  };
  const open = (cookie: string, agentId: unknown) =>
    post('/api/rooms/private-agent', { agent_id: agentId }, { cookie });
  const opened = async (cookie: string, agentId: string) => {
    const res = await open(cookie, agentId);
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as Chat;
  };
  const say = async (cookie: string, roomId: string, text: string, agentId: string) => {
    const posted = await post(
      `/api/rooms/${roomId}/messages`,
      { text, idempotency_key: randomUUID(), agent_id: agentId },
      { cookie },
    );
    assert.equal(posted.statusCode, 201, posted.body);
    return posted.json().message.seq as number;
  };
  const mentionedAt = async (roomId: string, seq: number) =>
    (
      await app.city.db.query<{ agent_id: string }>(
        'SELECT agent_id FROM mentions WHERE room_id=$1 AND source_seq=$2 ORDER BY agent_id',
        [roomId, seq],
      )
    ).rows.map((row) => row.agent_id);
  /** Pending wake-ups of the agent's auto-reply (the responder target), with their kinds. */
  const responderWakes = async (agentId: string) =>
    (
      await app.city.db.query<{ kinds: string[] }>(
        "SELECT kinds FROM wake_outbox WHERE agent_id=$1 AND kind='responder'",
        [agentId],
      )
    ).rows.map((row) => row.kinds);
  /** Turns the agent's auto-reply on with a placeholder key (owner console). */
  const autoReply = async (cookie: string, agentId: string) => {
    const key = await post(
      `/api/agents/${agentId}/responder/key`,
      { provider: 'anthropic', key: PLACEHOLDER_KEY },
      { cookie },
    );
    assert.ok(key.statusCode < 300, key.body);
    const on = await call(cookie, 'PUT', `/api/agents/${agentId}/responder`, { enabled: true });
    assert.equal(on.statusCode, 200, on.body);
  };
  const autoReplies = async (roomId: string) =>
    (
      await app.city.db.query<{ seq: number; sender_agent_id: string }>(
        'SELECT seq, sender_agent_id FROM room_messages WHERE room_id=$1 AND auto_reply IS NOT NULL ORDER BY seq',
        [roomId],
      )
    ).rows.map((row) => ({ seq: Number(row.seq), sender: row.sender_agent_id }));
  const memberRows = async (roomId: string) =>
    (
      await app.city.db.query<{ agent_id: string; kind: string; role: string; owner_id: string }>(
        'SELECT agent_id,kind,role,owner_id FROM room_members WHERE room_id=$1 AND removed_at IS NULL ORDER BY role',
        [roomId],
      )
    ).rows;
  const until = async (check: () => Promise<boolean>) => {
    for (let index = 0; index < 100; index++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('timed out');
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  return {
    app,
    requests,
    post,
    call,
    account,
    createAgent,
    open,
    opened,
    say,
    mentionedAt,
    responderWakes,
    autoReply,
    autoReplies,
    memberRows,
    until,
    settle,
  };
}

test("the owner's private chat: their person hosts, the agent is the only other member, nothing to join", async (t) => {
  const f = await fixture(t);
  const me = await f.account('Chat owner', 'Alex');
  const res = await f.open(me.cookie, me.agentId);
  assert.equal(res.statusCode, 200, res.body);
  const chat = res.json() as Chat;
  assert.deepEqual(Object.keys(chat).sort(), [
    'agent_id',
    'created',
    'latest_seq',
    'person_member_id',
    'room_id',
    'slug',
    'status',
  ]);
  assert.equal(chat.agent_id, me.agentId);
  assert.equal(chat.status, 'active');
  assert.equal(chat.latest_seq, 0);
  assert.equal(chat.created, true);
  assert.doesNotMatch(res.body, LINK_SHAPES, 'no link or code in the answer');
  const room = (
    await f.app.city.db.query<Record<string, unknown>>('SELECT * FROM rooms WHERE id=$1', [
      chat.room_id,
    ])
  ).rows[0]!;
  assert.equal(room.slug, chat.slug);
  assert.equal(room.host_owner_id, me.operatorId);
  assert.equal(room.host_agent_id, chat.person_member_id, "the host is the owner's person");
  assert.equal(room.name, 'Alex');
  assert.equal(Number(room.member_cap), 2);
  assert.equal(room.people_may_join, false);
  assert.equal(room.members_may_bring_ai, false);
  assert.equal(room.elric_private, false, 'not an Elric chat');
  assert.deepEqual(await f.memberRows(chat.room_id), [
    { agent_id: chat.person_member_id, kind: 'person', role: 'host', owner_id: me.operatorId },
    { agent_id: me.agentId, kind: 'agent', role: 'member', owner_id: me.operatorId },
  ]);
  const links = await f.app.city.db.query('SELECT 1 FROM room_links WHERE room_id=$1', [
    chat.room_id,
  ]);
  assert.equal(links.rows.length, 0, 'no room link exists');
  // The owner reads it in the console like any room, and posts there as their person.
  const list = await f.call(me.cookie, 'GET', '/api/rooms');
  const listed = (list.json().rooms as Array<{ id: string; role: string }>).find(
    (r) => r.id === chat.room_id,
  );
  assert.equal(listed?.role, 'host');
  assert.doesNotMatch(JSON.stringify(listed), LINK_SHAPES);
  // The console learns which agent the chat is with (it hides what the server refuses there).
  assert.equal((listed as { private_agent_id?: string } | undefined)?.private_agent_id, me.agentId);
  const seq = await f.say(me.cookie, chat.room_id, 'Hello Alex', chat.person_member_id);
  const read = await f.call(me.cookie, 'GET', `/api/rooms/${chat.room_id}/messages?since=0`);
  const message = (read.json().messages as Array<{ seq: number; sender_kind: string }>).find(
    (m) => m.seq === seq,
  );
  assert.equal(message?.sender_kind, 'person');
  // The request protection header and the session are required, like every console write.
  const unprotected = await f.app.inject({
    method: 'POST',
    url: '/api/rooms/private-agent',
    headers: { 'content-type': 'application/json', cookie: me.cookie },
    payload: JSON.stringify({ agent_id: me.agentId }),
  });
  assert.equal(unprotected.statusCode, 403, unprotected.body);
  const anonymous = await f.post('/api/rooms/private-agent', { agent_id: me.agentId });
  assert.equal(anonymous.statusCode, 401, anonymous.body);
  const malformed = await f.open(me.cookie, 'not-an-agent-id');
  assert.equal(malformed.statusCode, 400, malformed.body);
});

test('one room per agent: a second open and concurrent opens answer the same room', async (t) => {
  const f = await fixture(t);
  const me = await f.account('Chat owner', 'Alex');
  const first = await f.opened(me.cookie, me.agentId);
  const again = await f.opened(me.cookie, me.agentId);
  assert.equal(again.room_id, first.room_id);
  assert.equal(again.person_member_id, first.person_member_id);
  assert.equal(again.created, false);
  // Another agent of the same owner, opened concurrently: one room, created once.
  const bram = await f.createAgent(me.cookie, 'Bram');
  const concurrent = await Promise.all([1, 2, 3, 4].map(() => f.opened(me.cookie, bram)));
  assert.equal(new Set(concurrent.map((chat) => chat.room_id)).size, 1, 'one room');
  assert.equal(concurrent.filter((chat) => chat.created).length, 1, 'created once');
  assert.notEqual(concurrent[0]!.room_id, first.room_id, 'each agent has its own chat');
  const rooms = await f.app.city.db.query<{ n: string | number }>(
    'SELECT count(*) AS n FROM rooms WHERE host_owner_id=$1',
    [me.operatorId],
  );
  assert.equal(Number(rooms.rows[0]!.n), 2);
  // The latest seq follows the conversation.
  await f.say(me.cookie, first.room_id, 'One', first.person_member_id);
  assert.equal((await f.opened(me.cookie, me.agentId)).latest_seq, 1);
});

test("another owner's agent, an unknown id and a removed agent are the uniform 404", async (t) => {
  const f = await fixture(t);
  const me = await f.account('Chat owner', 'Alex');
  const other = await f.account('Other owner', 'Olga');
  const chat = await f.opened(me.cookie, me.agentId);
  const theirs = await f.open(me.cookie, other.agentId);
  const unknown = await f.open(me.cookie, randomUUID());
  const gone = await f.createAgent(me.cookie, 'Gone');
  const revoked = await f.post(`/api/agents/${gone}/revoke`, {}, { cookie: me.cookie });
  assert.equal(revoked.statusCode, 200, revoked.body);
  const removed = await f.open(me.cookie, gone);
  for (const res of [theirs, unknown, removed]) {
    assert.equal(res.statusCode, 404, res.body);
    assert.deepEqual(res.json(), { error: 'Agent not found.', code: 'agent_not_found' });
  }
  // The other owner opening my agent's chat gets the same; my chat stays out of their reach.
  const mine = await f.open(other.cookie, me.agentId);
  assert.equal(mine.statusCode, 404, mine.body);
  const read = await f.call(other.cookie, 'GET', `/api/rooms/${chat.room_id}/messages`);
  assert.equal(read.statusCode, 404, read.body);
  const list = await f.call(other.cookie, 'GET', '/api/rooms');
  assert.ok(
    !(list.json().rooms as Array<{ id: string }>).some((r) => r.id === chat.room_id),
    'not in their list',
  );
  // No room was created for any refused id.
  const rooms = await f.app.city.db.query<{ n: string | number }>(
    'SELECT count(*) AS n FROM rooms WHERE host_owner_id=$1',
    [me.operatorId],
  );
  assert.equal(Number(rooms.rows[0]!.n), 1);
});

test('a paused agent: its first open is refused like a join; an existing chat opens as paused', async (t) => {
  const f = await fixture(t);
  const me = await f.account('Chat owner', 'Alex');
  const chat = await f.opened(me.cookie, me.agentId);
  const bram = await f.createAgent(me.cookie, 'Bram');
  for (const id of [me.agentId, bram]) {
    const paused = await f.post(`/api/agents/${id}/pause`, {}, { cookie: me.cookie });
    assert.equal(paused.statusCode, 200, paused.body);
  }
  const refused = await f.open(me.cookie, bram);
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, 'agent_paused');
  const existing = await f.opened(me.cookie, me.agentId);
  assert.equal(existing.room_id, chat.room_id);
  assert.equal(existing.status, 'paused');
  const resumed = await f.post(`/api/agents/${bram}/resume`, {}, { cookie: me.cookie });
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal((await f.opened(me.cookie, bram)).status, 'active');
});

test('invites, joins and host settings are refused in the private chat (409 room_private)', async (t) => {
  const f = await fixture(t);
  const me = await f.account('Chat owner', 'Alex');
  const chat = await f.opened(me.cookie, me.agentId);
  const bram = await f.createAgent(me.cookie, 'Bram');
  const cookie = { cookie: me.cookie };
  const attempts = [
    await f.post('/api/links', { target: 'room', room_id: chat.room_id }, cookie),
    await f.post(`/api/rooms/${chat.room_id}/link`, {}, cookie),
    await f.post(
      `/api/rooms/${chat.room_id}/link/rotate`,
      { idempotency_key: randomUUID() },
      cookie,
    ),
    // Bringing another own AI in (room_id alone, no link).
    await f.post(
      `/api/rooms/${chat.slug}/join`,
      { agent_id: bram, idempotency_key: randomUUID() },
      cookie,
    ),
    await f.post(`/api/rooms/${chat.room_id}/people`, { people_may_join: true }, cookie),
    await f.post(`/api/rooms/${chat.room_id}/settings`, { member_cap: 10 }, cookie),
    await f.post(`/api/rooms/${chat.room_id}/settings`, { responders_allowed: false }, cookie),
    await f.call(me.cookie, 'PATCH', `/api/rooms/${chat.room_id}`, { name: 'Renamed' }),
    await f.post(`/api/rooms/${chat.room_id}/close`, {}, cookie),
    await f.post(`/api/rooms/${chat.room_id}/members/${me.agentId}/remove`, {}, cookie),
    await f.post(`/api/rooms/${chat.room_id}/leave`, { agent_id: me.agentId }, cookie),
  ];
  for (const res of attempts) {
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().code, 'room_private', res.body);
    assert.deepEqual(Object.keys(res.json()).sort(), ['code', 'error'], 'nothing else');
  }
  assert.match(attempts[0]!.json().error, /private chat with your agent/);
  // Still the owner's person and the agent, unchanged.
  assert.equal((await f.memberRows(chat.room_id)).length, 2);
  const room = (
    await f.app.city.db.query<Record<string, unknown>>('SELECT * FROM rooms WHERE id=$1', [
      chat.room_id,
    ])
  ).rows[0]!;
  assert.equal(room.name, 'Alex');
  assert.equal(room.closed_at, null);
  assert.equal(Number(room.member_cap), 2);
  const links = await f.app.city.db.query(
    'SELECT 1 FROM room_links WHERE room_id=$1 UNION ALL SELECT 1 FROM join_links WHERE room_id=$1',
    [chat.room_id],
  );
  assert.equal(links.rows.length, 0, 'no link or code was minted');
});

test('the owner deletes their private chat with their agent; the next open is a new, empty chat', async (t) => {
  const f = await fixture(t);
  const me = await f.account('Chat deleter', 'Alex');
  const other = await f.account('Someone else', 'Bram');
  const chat = await f.opened(me.cookie, me.agentId);
  await f.say(me.cookie, chat.room_id, 'Something private', chat.person_member_id);
  const remove = (cookie: string, confirm: string) =>
    f.call(cookie, 'DELETE', `/api/rooms/${chat.room_id}`, { confirm_name: confirm });
  // Another account never learns the chat exists; the name must be typed exactly.
  assert.equal((await remove(other.cookie, 'Alex')).statusCode, 404);
  const wrong = await remove(me.cookie, 'alex');
  assert.equal(wrong.statusCode, 400, wrong.body);
  assert.equal(wrong.json().code, 'confirm_name_mismatch');
  const deleted = await remove(me.cookie, 'Alex');
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.deepEqual(deleted.json(), { room_id: chat.room_id, deleted: true });
  // Its history is gone, the room is a tombstone, and it is gone for its owner.
  const left = await f.app.city.db.query('SELECT 1 FROM room_messages WHERE room_id=$1', [
    chat.room_id,
  ]);
  assert.equal(left.rows.length, 0, 'messages erased');
  const tombstone = (
    await f.app.city.db.query<{ deleted_at: unknown; name: string }>(
      'SELECT deleted_at, name FROM rooms WHERE id=$1',
      [chat.room_id],
    )
  ).rows[0]!;
  assert.notEqual(tombstone.deleted_at, null);
  assert.equal(tombstone.name, '');
  const late = await f.post(
    `/api/rooms/${chat.room_id}/messages`,
    { text: 'Still there?', idempotency_key: randomUUID(), agent_id: chat.person_member_id },
    { cookie: me.cookie },
  );
  assert.equal(late.statusCode, 410, late.body);
  // "Message Alex" again opens a new chat, not the deleted one.
  const again = await f.opened(me.cookie, me.agentId);
  assert.equal(again.created, true);
  assert.notEqual(again.room_id, chat.room_id);
  assert.equal(again.latest_seq, 0);
  // The new chat is locked like the first one.
  const close = await f.post(`/api/rooms/${again.room_id}/close`, {}, { cookie: me.cookie });
  assert.equal(close.statusCode, 409, close.body);
  assert.equal(close.json().code, 'room_private');
});

test("the owner's plain message wakes the agent: a mention, one auto-reply, no reply to the reply", async (t) => {
  const f = await fixture(t);
  const me = await f.account('Chat owner', 'Alex');
  await f.autoReply(me.cookie, me.agentId);
  const chat = await f.opened(me.cookie, me.agentId);
  const seq = await f.say(me.cookie, chat.room_id, 'Can you summarize?', chat.person_member_id);
  assert.deepEqual(await f.mentionedAt(chat.room_id, seq), [me.agentId], 'addressed without @');
  const mention = (
    await f.app.city.db.query<{ from_agent_id: string; from_name: string; excerpt: string }>(
      'SELECT from_agent_id, from_name, excerpt FROM mentions WHERE room_id=$1 AND source_seq=$2',
      [chat.room_id, seq],
    )
  ).rows[0]!;
  assert.deepEqual(mention, {
    from_agent_id: chat.person_member_id,
    from_name: 'Chat owner',
    excerpt: 'Can you summarize?',
  });
  await f.until(async () => (await f.autoReplies(chat.room_id)).length === 1);
  const [reply] = await f.autoReplies(chat.room_id);
  assert.equal(reply!.sender, me.agentId, 'answered as the agent');
  // The reply names the agent itself ("@Alex"): no mention of itself, no second answer.
  assert.deepEqual(await f.mentionedAt(chat.room_id, reply!.seq), []);
  await f.settle();
  assert.equal((await f.autoReplies(chat.room_id)).length, 1, 'no reply to its own reply');
  assert.equal(f.requests.length, 1, 'one provider call');
  // With an "@" too, the agent is mentioned once.
  const both = await f.say(me.cookie, chat.room_id, '@Alex and one more', chat.person_member_id);
  assert.deepEqual(await f.mentionedAt(chat.room_id, both), [me.agentId]);
});

test('the console cannot speak as the agent in its private chat', async (t) => {
  const f = await fixture(t, { delivery: false });
  const me = await f.account('Chat owner', 'Alex');
  await f.autoReply(me.cookie, me.agentId);
  const chat = await f.opened(me.cookie, me.agentId);
  for (const text of ['Note to self', '@Alex note to self']) {
    const refused = await f.post(
      `/api/rooms/${chat.room_id}/messages`,
      {
        text,
        agent_id: me.agentId,
        idempotency_key: randomUUID(),
      },
      { cookie: me.cookie },
    );
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(refused.json().code, 'agent_posts_itself');
  }
  assert.deepEqual(await f.responderWakes(me.agentId), [], 'no wake-up');
  // The owner's person is addressed to the agent, never to itself.
  const fromPerson = await f.say(me.cookie, chat.room_id, 'Now you', chat.person_member_id);
  assert.deepEqual(await f.mentionedAt(chat.room_id, fromPerson), [me.agentId]);
  assert.deepEqual(await f.responderWakes(me.agentId), [['mention']]);
});

test("muted notifications: the owner's plain message records nothing and wakes nothing", async (t) => {
  const f = await fixture(t, { delivery: false });
  const me = await f.account('Chat owner', 'Alex');
  await f.autoReply(me.cookie, me.agentId);
  const chat = await f.opened(me.cookie, me.agentId);
  const quiet = await f.post(
    `/api/rooms/${chat.room_id}/notifications`,
    { muted: true },
    { cookie: me.cookie },
  );
  assert.equal(quiet.statusCode, 200, quiet.body);
  const seq = await f.say(me.cookie, chat.room_id, 'Can you summarize?', chat.person_member_id);
  assert.deepEqual(await f.mentionedAt(chat.room_id, seq), []);
  assert.deepEqual(await f.responderWakes(me.agentId), []);
});

test('a shared room still needs the @mention: a plain message from the owner wakes nobody', async (t) => {
  const f = await fixture(t, { delivery: false });
  const me = await f.account('Chat owner', 'Alex');
  await f.autoReply(me.cookie, me.agentId);
  // A normal room hosted by the same agent, with the owner in it as a person (2 members).
  const created = await f.post(
    '/api/rooms',
    { name: 'Tea room', agent_id: me.agentId, idempotency_key: randomUUID() },
    { cookie: me.cookie },
  );
  assert.equal(created.statusCode, 201, created.body);
  const roomId = created.json().room.id as string;
  const link = await f.post(
    '/api/links',
    { target: 'room', room_id: roomId },
    { cookie: me.cookie },
  );
  assert.equal(link.statusCode, 201, link.body);
  const joined = await f.post(
    '/api/rooms/join',
    { idempotency_key: randomUUID(), code: link.json().code, name: 'Chat owner' },
    { cookie: me.cookie },
  );
  assert.equal(joined.statusCode, 200, joined.body);
  const members = await f.call(me.cookie, 'GET', `/api/rooms/${roomId}/members`);
  const person = (
    members.json().members as Array<{ id: string; own: boolean; kind?: string }>
  ).find((m) => m.own && m.kind === 'person')!.id;
  const plain = await f.say(me.cookie, roomId, 'Can you summarize?', person);
  assert.deepEqual(await f.mentionedAt(roomId, plain), [], 'no @: not addressed');
  assert.deepEqual(await f.responderWakes(me.agentId), [], 'no wake-up');
  const named = await f.say(me.cookie, roomId, '@Alex can you summarize?', person);
  assert.deepEqual(await f.mentionedAt(roomId, named), [me.agentId]);
  // The shared room is not a private chat: invites still work there.
  const again = await f.post(
    '/api/links',
    { target: 'room', room_id: roomId },
    { cookie: me.cookie },
  );
  assert.equal(again.statusCode, 201, again.body);
});

test('revoking an agent closes only its private chat and preserves readable history', async (t) => {
  const f = await fixture(t, { delivery: false });
  const me = await f.account('Chat owner', 'Alex');
  const chat = await f.opened(me.cookie, me.agentId);
  const otherId = await f.createAgent(me.cookie, 'Other');
  const other = await f.opened(me.cookie, otherId);
  await f.say(me.cookie, chat.room_id, 'Keep this history', chat.person_member_id);
  const revoke = () => f.post(`/api/agents/${me.agentId}/revoke`, {}, { cookie: me.cookie });
  assert.equal((await revoke()).statusCode, 200);
  const closedAt = async () =>
    (
      await f.app.city.db.query<{ closed_at: string | number | null }>(
        'SELECT closed_at FROM rooms WHERE id=$1',
        [chat.room_id],
      )
    ).rows[0]!.closed_at;
  const first = await closedAt();
  assert.notEqual(first, null);
  assert.equal((await revoke()).statusCode, 200);
  assert.equal(await closedAt(), first, 'repeated revoke preserves closure time');
  const read = await f.call(me.cookie, 'GET', `/api/rooms/${chat.room_id}/messages`);
  assert.equal(read.statusCode, 200, read.body);
  assert.match(read.body, /Keep this history/);
  const post = await f.post(
    `/api/rooms/${chat.room_id}/messages`,
    {
      text: 'Too late',
      agent_id: chat.person_member_id,
      idempotency_key: randomUUID(),
    },
    { cookie: me.cookie },
  );
  assert.equal(post.statusCode, 409, post.body);
  assert.equal(post.json().code, 'room_closed');
  await f.say(me.cookie, other.room_id, 'Still open', other.person_member_id);
});
