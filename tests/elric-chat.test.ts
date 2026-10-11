import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { elricFixture, permissiveLimiter } from './elric-fixture.js';
const permissive = () => permissiveLimiter;

/**
 * The private Elric chat (docs/ELRIC.md "Dashboard chat"; design DASHBOARD_BACKEND.md). The first
 * seven tests are the security drafts written against the design before the code; the rest cover
 * the lock on every host path, console-only access, the lifecycle, the room quota, the "@ room"
 * check and the cheap poll.
 *
 * The guarantees under test:
 * - the private room never gets a third member, by any path;
 * - no join link or code is ever returned;
 * - member_cap is 2, and the owner's PERSON is the host;
 * - Elric is a normal member and never the host;
 * - nobody else can read it;
 * - the owner (as host) cannot reopen it: no link, no people/AI joins, no cap raise. That would
 *   expose the whole private history, which is 'full';
 * - "@ room" runs only where both the owner's person and this Elric are members, and posts there,
 *   never in the private room.
 * Synthetic data only.
 */
type F = Awaited<ReturnType<typeof elricFixture>>;
type Account = Awaited<ReturnType<F['account']>>;
const LINK_SHAPES =
  /\/r\/[^"\s]+#|\/j\/[A-Za-z0-9_-]{6,}|"(?:link|code|short_url|token)"\s*:\s*"[^"]+"/;

/** An eligible owner who added Elric, with the private chat (or null while the feature is absent). */
async function chatOwner(f: F, name = 'Chat owner') {
  const owner = await f.account(name);
  await f.verify(owner);
  const added = await f.call(owner.cookie, 'POST', '/api/elric', {});
  assert.ok(added.statusCode < 300, added.body);
  const elricId = added.json().agent_id as string;
  const chat = await f.call(owner.cookie, 'GET', '/api/elric/chat');
  if (chat.statusCode === 404) return null;
  assert.equal(chat.statusCode, 200, chat.body);
  return {
    owner,
    elricId,
    added: added.body,
    chat: chat.json() as { room_id: string; slug: string },
    chatBody: chat.body,
  };
}
async function skipUnlessChat(_t: unknown, f: F) {
  const c = await chatOwner(f);
  assert.ok(c, 'GET /api/elric/chat answers');
  return c;
}
const members = async (f: F, cookie: string, roomId: string) =>
  f.call(cookie, 'GET', `/api/rooms/${roomId}/members`);
const memberRows = async (f: F, roomId: string) =>
  (
    await f.db.query<{ agent_id: string; kind: string; role: string; owner_id: string }>(
      'SELECT agent_id,kind,role,owner_id FROM room_members WHERE room_id=$1 AND removed_at IS NULL',
      [roomId],
    )
  ).rows;
/** Posts in the private chat as the owner's person member (as the dashboard does). */
async function chatPost(f: F, c: NonNullable<Awaited<ReturnType<typeof chatOwner>>>, text: string) {
  const list = (await members(f, c.owner.cookie, c.chat.room_id)).json().members as Array<{
    id: string;
    kind: string;
    own: boolean;
  }>;
  const person = list.find((m) => m.own && m.kind === 'person')!;
  const res = await f.call(c.owner.cookie, 'POST', `/api/rooms/${c.chat.room_id}/messages`, {
    text,
    agent_id: person.id,
    idempotency_key: randomUUID(),
  });
  assert.equal(res.statusCode, 201, res.body);
  return res;
}
async function grant(f: F, who: Account) {
  const res = await f.call(who.cookie, 'POST', '/api/assistant-access', {
    label: 'Third-party AI (synthetic)',
    scopes: [...ASSISTANT_SCOPES],
    expiresInDays: 1,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().token as string;
}
const tool = (f: F, token: string, name: string, body: unknown) =>
  f.app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: {
      'content-type': 'application/json',
      'x-city-request': '1',
      authorization: `Bearer ${token}`,
    },
    payload: JSON.stringify(body),
  });

test("chat: one private room, the owner's person hosts it, Elric is a member, cap 2, closed", async (t) => {
  const f = await elricFixture(t);
  const c = await skipUnlessChat(t, f);
  if (!c) return;
  const again = await f.call(c.owner.cookie, 'GET', '/api/elric/chat');
  const concurrent = await Promise.all(
    [1, 2, 3].map(() => f.call(c.owner.cookie, 'GET', '/api/elric/chat')),
  );
  const ids = new Set([again, ...concurrent].map((r) => r.json().room_id));
  assert.deepEqual([...ids], [c.chat.room_id], 'idempotent, also when concurrent');
  const room = (
    await f.db.query<Record<string, unknown>>('SELECT * FROM rooms WHERE id=$1', [c.chat.room_id])
  ).rows[0]!;
  assert.equal(room.host_owner_id, c.owner.operatorId);
  assert.equal(Number(room.member_cap), 2);
  assert.equal(room.people_may_join, false);
  assert.equal(room.members_may_bring_ai, false);
  const rows = await memberRows(f, c.chat.room_id);
  assert.equal(rows.length, 2);
  const host = rows.find((r) => r.role === 'host')!;
  assert.equal(host.kind, 'person', "the host is the owner's person, never an agent");
  const elric = rows.find((r) => r.agent_id === c.elricId)!;
  assert.equal(elric.role, 'member', 'Elric is never the host');
  assert.equal(elric.kind, 'agent');
});

test('chat: no join link or code in any response, and no link can be minted or rotated', async (t) => {
  const f = await elricFixture(t);
  const c = await skipUnlessChat(t, f);
  if (!c) return;
  const list = await f.call(c.owner.cookie, 'GET', '/api/rooms');
  const read = await f.call(c.owner.cookie, 'GET', `/api/rooms/${c.chat.room_id}/messages?since=0`);
  const own = await members(f, c.owner.cookie, c.chat.room_id);
  for (const [label, body] of [
    ['POST /api/elric', c.added],
    ['GET /api/elric/chat', c.chatBody],
    [
      'GET /api/rooms (this room)',
      JSON.stringify(list.json().rooms.find((r: { id: string }) => r.id === c.chat.room_id)),
    ],
    ['room read', read.body],
    ['members', own.body],
  ] as const)
    assert.doesNotMatch(body, LINK_SHAPES, `${label} leaks a join link or code`);
  // The owner is the host, but a link for the private room is never issued, rotated or made.
  const link = await f.call(c.owner.cookie, 'POST', `/api/rooms/${c.chat.room_id}/link`, {});
  assert.ok(link.statusCode >= 400 || !LINK_SHAPES.test(link.body), `link: ${link.statusCode}`);
  const rotate = await f.call(c.owner.cookie, 'POST', `/api/rooms/${c.chat.room_id}/link/rotate`, {
    idempotency_key: randomUUID(),
  });
  assert.ok(rotate.statusCode >= 400, `rotate: ${rotate.statusCode}`);
  const short = await f.call(c.owner.cookie, 'POST', '/api/links', {
    target: 'room',
    room_id: c.chat.room_id,
  });
  assert.ok(short.statusCode >= 400, `short code link: ${short.statusCode}`);
  const viaGrant = await tool(f, await grant(f, c.owner), 'city_room_link', {
    room_id: c.chat.room_id,
  });
  // Refused (an error body's "code" is the error code, not a join code), or no link in it.
  assert.ok(
    viaGrant.statusCode >= 400 || !LINK_SHAPES.test(viaGrant.body),
    `city_room_link leaks a link: ${viaGrant.body}`,
  );
});

test('chat: the owner as host cannot reopen the room (people, AIs, cap, history)', async (t) => {
  const f = await elricFixture(t);
  const c = await skipUnlessChat(t, f);
  if (!c) return;
  const attempts = [
    ['people', `/api/rooms/${c.chat.room_id}/people`, { people_may_join: true }],
    ['bring AI', `/api/rooms/${c.chat.room_id}/people`, { members_may_bring_ai: true }],
    ['cap', `/api/rooms/${c.chat.room_id}/settings`, { member_cap: 10 }],
  ] as const;
  for (const [label, url, body] of attempts) {
    const res = await f.call(c.owner.cookie, 'POST', url, body);
    assert.ok(res.statusCode >= 400, `${label}: ${res.statusCode} ${res.body}`);
  }
  const room = (
    await f.db.query<Record<string, unknown>>(
      'SELECT member_cap,people_may_join,members_may_bring_ai FROM rooms WHERE id=$1',
      [c.chat.room_id],
    )
  ).rows[0]!;
  assert.deepEqual(
    [Number(room.member_cap), room.people_may_join, room.members_may_bring_ai],
    [2, false, false],
  );
  // Through the owner's AI grant (rooms:host) too.
  const token = await grant(f, c.owner);
  const update = await tool(f, token, 'city_room_update', {
    room_id: c.chat.room_id,
    history: 'from_join',
  });
  t.diagnostic(`city_room_update on the private room: ${update.statusCode}`);
});

test('chat: no third member by any path; the member count stays 2', async (t) => {
  const f = await elricFixture(t);
  const c = await skipUnlessChat(t, f);
  if (!c) return;
  const outsider = await f.account('Outsider');
  const outsiderAgent = await f.agent(outsider, 'Outsider bot');
  const guesses = [
    [
      'agent join by slug',
      `/api/rooms/${c.chat.slug}/join`,
      { agent_id: outsiderAgent, idempotency_key: randomUUID() },
    ],
    [
      'agent join by id',
      `/api/rooms/${c.chat.room_id}/join`,
      { agent_id: outsiderAgent, idempotency_key: randomUUID() },
    ],
    [
      'agent join with a guessed token',
      `/api/rooms/${c.chat.slug}/join`,
      { token: 'A'.repeat(43), agent_id: outsiderAgent, idempotency_key: randomUUID() },
    ],
    [
      'person join by guessed link',
      '/api/rooms/join',
      {
        link: `http://localhost/r/${c.chat.slug}#${'A'.repeat(43)}`,
        idempotency_key: randomUUID(),
      },
    ],
    [
      'person join by guessed code',
      '/api/rooms/join',
      { code: 'AAAA-AAAA', idempotency_key: randomUUID() },
    ],
  ] as const;
  for (const [label, url, body] of guesses) {
    const res = await f.call(outsider.cookie, 'POST', url, body);
    assert.ok(res.statusCode >= 400, `${label}: ${res.statusCode}`);
  }
  // Over MCP: an outsider grant with room_id alone, and the OWNER's own grant adding another AI.
  const outsiderGrant = await grant(f, outsider);
  const r1 = await tool(f, outsiderGrant, 'city_join_room', {
    room_id: c.chat.room_id,
    agent_id: outsiderAgent,
    idempotency_key: randomUUID(),
  });
  assert.ok(r1.statusCode >= 400, `outsider city_join_room: ${r1.statusCode}`);
  const ownerAi = await f.agent(c.owner, 'Owner other AI');
  const r2 = await tool(f, await grant(f, c.owner), 'city_join_room', {
    room_id: c.chat.room_id,
    agent_id: ownerAi,
    idempotency_key: randomUUID(),
  });
  assert.ok(r2.statusCode >= 400, `owner's other AI: ${r2.statusCode}`);
  const consoleJoin = await f.call(c.owner.cookie, 'POST', `/api/rooms/${c.chat.room_id}/join`, {
    agent_id: ownerAi,
    idempotency_key: randomUUID(),
  });
  assert.ok(consoleJoin.statusCode >= 400, `owner console join: ${consoleJoin.statusCode}`);
  assert.equal((await memberRows(f, c.chat.room_id)).length, 2);
});

test('chat: nobody else can read it, list it or see its members', async (t) => {
  const f = await elricFixture(t);
  const c = await skipUnlessChat(t, f);
  if (!c) return;
  await chatPost(f, c, 'private note kiwi-42');
  const other = await f.account('Other reader');
  const read = await f.call(other.cookie, 'GET', `/api/rooms/${c.chat.room_id}/messages?since=0`);
  assert.equal(read.statusCode, 404);
  assert.equal((await members(f, other.cookie, c.chat.room_id)).statusCode, 404);
  const list = await f.call(other.cookie, 'GET', '/api/rooms');
  assert.ok(!list.body.includes(c.chat.room_id));
  // Another owner's own chat is a different room.
  await f.verify(other);
  await f.call(other.cookie, 'POST', '/api/elric', {});
  const theirs = await f.call(other.cookie, 'GET', '/api/elric/chat');
  assert.notEqual(theirs.json().room_id, c.chat.room_id);
  assert.doesNotMatch(theirs.body, /kiwi-42/);
});

test('"@ room": runs only where both the person and this Elric are members; posts there only', async (t) => {
  const f = await elricFixture(t);
  const c = await skipUnlessChat(t, f);
  if (!c) return;
  const host = await f.account('Shared host');
  const hostAgent = await f.agent(host, 'Shared desk');
  const shared = await f.room(host, hostAgent, 'Shared room');
  // The person is a member, Elric is not: no invocation, no cost.
  const person = await f.joinPerson(c.owner, shared, 'Ann');
  const rooms = await f.call(c.owner.cookie, 'GET', '/api/elric/rooms');
  const entry = (rooms.json().rooms as Array<Record<string, unknown>>).find(
    (r) => r.id === shared.id,
  )!;
  assert.deepEqual([entry.person_member, entry.elric_member], [true, false]);
  assert.doesNotMatch(
    rooms.body,
    /"(?:text|parts|messages)"/,
    'the room picker carries no content',
  );
  await f.say(c.owner, shared, '@Elric summarise this room', person);
  await f.elric.drain();
  assert.equal(f.adapterCalls(), 0, 'Elric is not a member there');
  // Elric joins: the owner's person mention runs in THAT room and posts there, not in the chat.
  await f.joinAgent(c.owner, shared, c.elricId, { legacy: true });
  f.small.push({ text: 'Answer in the shared room.' });
  await f.say(c.owner, shared, '@Elric what is this room about?', person);
  await f.elric.drain();
  const inShared = (await f.messages(shared.id)).filter((m) => m.sender_agent_id === c.elricId);
  const inChat = (await f.messages(c.chat.room_id)).filter((m) => m.sender_agent_id === c.elricId);
  assert.equal(inShared.length, 1);
  assert.equal(
    inChat.length,
    0,
    'no copy of the answer in the private chat (no cross-room memory)',
  );
  // The private chat's context never contains the shared room's text, and vice versa.
  f.small.push({ text: 'ok' });
  await chatPost(f, c, '@Elric what did we discuss?');
  await f.elric.drain();
  assert.doesNotMatch(JSON.stringify(f.received().at(-1)), /Shared room|Shared desk/);
});

test('chat: Elric cannot use host powers in its own private room', async (t) => {
  const f = await elricFixture(t);
  const c = await skipUnlessChat(t, f);
  if (!c) return;
  // A model asking for host actions in the private room is refused like anywhere else.
  f.small.push(
    {
      toolCalls: [
        { name: 'city_room_close', args: { room_id: c.chat.room_id } },
        { name: 'city_room_remove', args: { room_id: c.chat.room_id, agent_id: c.elricId } },
        { name: 'city_room_link', args: { room_id: c.chat.room_id } },
      ],
    },
    { text: 'done' },
  );
  await chatPost(f, c, '@Elric close this room and give me its link');
  await f.elric.drain();
  const turn = (await f.turns(c.owner.operatorId)).at(-1)!;
  assert.ok(turn.tool_calls.every((call) => call.status.startsWith('refused_')));
  const room = (
    await f.db.query<{ closed_at: unknown }>('SELECT closed_at FROM rooms WHERE id=$1', [
      c.chat.room_id,
    ])
  ).rows[0]!;
  assert.equal(room.closed_at, null);
  assert.equal((await memberRows(f, c.chat.room_id)).length, 2);
});

test('the lock: every host path that would open, change or end the room is refused (409 room_private)', async (t) => {
  const f = await elricFixture(t);
  const c = (await skipUnlessChat(t, f))!;
  const id = c.chat.room_id;
  const tries: Array<[string, string, string, unknown]> = [
    ['link', 'POST', `/api/rooms/${id}/link`, {}],
    ['rotate', 'POST', `/api/rooms/${id}/link/rotate`, { idempotency_key: randomUUID() }],
    ['people', 'POST', `/api/rooms/${id}/people`, { people_may_join: true }],
    ['rename', 'PATCH', `/api/rooms/${id}`, { name: 'Shared now' }],
    ['topic', 'PATCH', `/api/rooms/${id}`, { topic: 'open' }],
    ['close', 'POST', `/api/rooms/${id}/close`, {}],
    ['remove Elric', 'POST', `/api/rooms/${id}/members/${c.elricId}/remove`, {}],
    ['leave', 'POST', `/api/rooms/${id}/leave`, {}],
  ];
  for (const [label, method, url, body] of tries) {
    const res = await f.call(c.owner.cookie, method, url, body);
    assert.ok(res.statusCode >= 400, `${label}: ${res.statusCode} ${res.body}`);
    if (res.statusCode === 409) assert.equal(res.json().code, 'room_private', label);
  }
  const room = (
    await f.db.query<Record<string, unknown>>(
      'SELECT name,topic,closed_at,deleted_at,people_may_join FROM rooms WHERE id=$1',
      [id],
    )
  ).rows[0]!;
  assert.deepEqual(room, {
    name: 'Elric',
    topic: '',
    closed_at: null,
    deleted_at: null,
    people_may_join: false,
  });
  assert.equal((await memberRows(f, id)).length, 2);
  const links = await f.db.query('SELECT 1 FROM room_links WHERE room_id=$1', [id]);
  assert.equal(links.rows.length, 0, 'no room link was ever minted');
});

test('console only: the same owner over MCP (a grant) gets 404 and never sees the room listed', async (t) => {
  const f = await elricFixture(t);
  const c = (await skipUnlessChat(t, f))!;
  await chatPost(f, c, 'console-only note fig-7');
  const token = await grant(f, c.owner);
  for (const [name, body] of [
    ['city_room_read', { room_id: c.chat.room_id, since: 0 }],
    ['city_room_members', { room_id: c.chat.room_id }],
    [
      'city_room_post',
      { room_id: c.chat.room_id, text: 'from the grant', idempotency_key: randomUUID() },
    ],
  ] as const) {
    const res = await tool(f, token, name, body);
    assert.doesNotMatch(res.body, /fig-7/, name);
    assert.ok(
      res.statusCode === 404 || /not.found|room_not_found/i.test(res.body),
      `${name}: ${res.statusCode} ${res.body}`,
    );
  }
  // The owner console still sees and lists it, marked private.
  const list = await f.call(c.owner.cookie, 'GET', '/api/rooms');
  assert.ok(list.body.includes(c.chat.room_id));
  const read = await f.call(c.owner.cookie, 'GET', `/api/rooms/${c.chat.room_id}/messages?since=0`);
  assert.match(read.body, /fig-7/);
});

test('the room quota does not count the private chat, and creating it needs no quota', async (t) => {
  const f = await elricFixture(t, { rateLimiter: permissive() });
  const owner = await f.account('Quota owner');
  await f.verify(owner);
  await f.call(owner.cookie, 'POST', '/api/elric', {});
  const desk = await f.agent(owner, 'Quota desk');
  for (let i = 0; i < 20; i++) await f.room(owner, desk, `Quota room ${i}`);
  const chat = await f.call(owner.cookie, 'GET', '/api/elric/chat');
  assert.equal(chat.statusCode, 200, 'the chat exists even at the open-room limit');
  const more = await f.call(owner.cookie, 'POST', '/api/rooms', {
    agent_id: desk,
    name: 'One too many',
    idempotency_key: randomUUID(),
  });
  assert.equal(more.statusCode, 429, 'the limit is still 20 shared rooms');
});

test('lifecycle: pause keeps the room but runs nothing; revoke closes it; re-add gives a new room', async (t) => {
  const f = await elricFixture(t);
  const c = (await skipUnlessChat(t, f))!;
  await f.call(c.owner.cookie, 'POST', '/api/elric/pause', {});
  await chatPost(f, c, '@Elric are you there?');
  await f.elric.drain();
  assert.equal(f.adapterCalls(), 0, 'no turn while paused');
  await f.call(c.owner.cookie, 'POST', '/api/elric/resume', {});
  await f.call(c.owner.cookie, 'POST', '/api/elric/revoke', {});
  const gone = await f.call(c.owner.cookie, 'GET', '/api/elric/chat');
  assert.equal(gone.statusCode, 404);
  const closed = (
    await f.db.query<{ closed_at: unknown }>('SELECT closed_at FROM rooms WHERE id=$1', [
      c.chat.room_id,
    ])
  ).rows[0]!;
  assert.notEqual(closed.closed_at, null, "the revoked Elric's chat is closed");
  const history = await f.call(
    c.owner.cookie,
    'GET',
    `/api/rooms/${c.chat.room_id}/messages?since=0`,
  );
  assert.equal(history.statusCode, 200, 'the history stays readable for the owner');
  const again = await f.call(c.owner.cookie, 'POST', '/api/elric', {});
  assert.ok(again.statusCode < 300, again.body);
  const fresh = await f.call(c.owner.cookie, 'GET', '/api/elric/chat');
  assert.equal(fresh.statusCode, 200);
  assert.notEqual(fresh.json().room_id, c.chat.room_id, 'a new Elric gets a new room');
});

test('"@ room" check: typed refusal for each missing membership; private and foreign rooms are 404', async (t) => {
  const f = await elricFixture(t);
  const c = (await skipUnlessChat(t, f))!;
  const host = await f.account('Ask host');
  const desk = await f.agent(host, 'Ask desk');
  const shared = await f.room(host, desk, 'Ask room');
  const ask = (room: string) => f.call(c.owner.cookie, 'POST', '/api/elric/ask', { room_id: room });
  assert.equal((await ask(shared.id)).statusCode, 404, 'not a member at all');
  await f.joinAgent(c.owner, shared, c.elricId, { legacy: true });
  let res = await ask(shared.id);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(
    [res.json().code, res.json().details],
    ['elric_room_requires_membership', { missing: 'person' }],
  );
  const person = await f.joinPerson(c.owner, shared, 'Ann');
  res = await ask(shared.id);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), {
    room_id: shared.id,
    person_member_id: person,
    posts_publicly: true,
  });
  await f.call(c.owner.cookie, 'POST', '/api/elric/pause', {});
  res = await ask(shared.id);
  assert.deepEqual(res.json().details, { missing: 'elric' }, 'a paused Elric is not available');
  assert.equal((await ask(c.chat.room_id)).statusCode, 404, 'the private chat is not an "@ room"');
});

test('cheap poll: GET /api/elric/chat?since= answers latest_seq, waking and pending without creating', async (t) => {
  const f = await elricFixture(t);
  const c = (await skipUnlessChat(t, f))!;
  const before = await f.call(c.owner.cookie, 'GET', '/api/elric/chat?since=0');
  assert.equal(before.statusCode, 200);
  const state = before.json();
  assert.deepEqual(Object.keys(state).sort(), [
    'latest_seq',
    'pending_count',
    'person_member_id',
    'room_id',
    'slug',
    'status',
    'waking',
  ]);
  await chatPost(f, c, 'hello');
  const after = (
    await f.call(c.owner.cookie, 'GET', `/api/elric/chat?since=${state.latest_seq}`)
  ).json();
  assert.equal(after.latest_seq, state.latest_seq + 1);
  assert.equal(after.room_id, c.chat.room_id);
});

test("no route reaches createPrivateRoom, and it only ever adds the caller's own person and Elric", async (t) => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { join, sep } = await import('node:path');
  // Collected with forward slashes on every OS: join() uses backslashes on Windows.
  const callers: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }))
      if (entry.isDirectory()) await walk(join(dir, entry.name));
      else if (
        entry.name.endsWith('.ts') &&
        /createPrivateRoom\(/.test(await readFile(join(dir, entry.name), 'utf8'))
      )
        callers.push(join(dir, entry.name).replaceAll(sep, '/'));
  };
  await walk('server');
  // The first chat (chat.ts) and owner-created conversations (conversations.ts), both for the
  // signed-in owner and their own Elric only.
  assert.deepEqual(callers.sort(), [
    'server/elric/chat.ts',
    'server/elric/conversations.ts',
    'server/rooms/private.ts',
  ]);
  const f = await elricFixture(t);
  const c = (await skipUnlessChat(t, f))!;
  const rows = await memberRows(f, c.chat.room_id);
  assert.ok(
    rows.every((row) => row.owner_id === c.owner.operatorId),
    "only the owner's own members",
  );
});

test('churn: at most 5 new private chats per owner and day (revoke + re-add), then 429 with Retry-After', async (t) => {
  const f = await elricFixture(t);
  const owner = await f.account('Churn owner');
  await f.verify(owner);
  for (let i = 0; i < 5; i++) {
    const added = await f.call(owner.cookie, 'POST', '/api/elric', {});
    assert.ok(added.statusCode < 300, added.body);
    assert.equal(
      (await f.call(owner.cookie, 'GET', '/api/elric/chat')).statusCode,
      200,
      `chat ${i}`,
    );
    assert.equal((await f.call(owner.cookie, 'POST', '/api/elric/revoke', {})).statusCode, 200);
  }
  await f.call(owner.cookie, 'POST', '/api/elric', {});
  const sixth = await f.call(owner.cookie, 'GET', '/api/elric/chat');
  assert.equal(sixth.statusCode, 429, sixth.body);
  assert.equal(sixth.json().code, 'too_many_chats');
  const wait = Number(sixth.headers['retry-after']);
  // The real remaining wait: until the oldest of the five is 24 hours old (not a flat day).
  assert.ok(wait > 0 && wait <= 86_400, `Retry-After ${wait}`);
  const oldest = Number(
    (
      await f.db.query<{ t: string }>(
        'SELECT min(created_at) AS t FROM rooms WHERE host_owner_id=$1 AND elric_private',
        [owner.operatorId],
      )
    ).rows[0]!.t,
  );
  assert.ok(Math.abs(wait - Math.ceil((oldest + 86_400_000 - f.now()) / 1000)) <= 1);
  // A day later it works again (the rooms age; the session stays fresh).
  await f.db.query(
    'UPDATE rooms SET created_at=created_at-86400001 WHERE host_owner_id=$1 AND elric_private',
    [owner.operatorId],
  );
  assert.equal((await f.call(owner.cookie, 'GET', '/api/elric/chat')).statusCode, 200);
});
