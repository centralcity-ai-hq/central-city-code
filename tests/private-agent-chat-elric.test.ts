import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { elricFixture } from './elric-fixture.js';

/**
 * Private chats with own agents next to the Elric chat (server/rooms/private.ts). Both are built
 * by the same insert and locked the same way, but:
 * - an Elric agent never gets a private agent chat (its chat is /elric), and the Elric chat, its
 *   conversations, its "@ room" picker and its lock message are unchanged;
 * - an own agent's chat is reachable by the owner's other principals (the agent's own runtime
 *   reads and answers there); the Elric chat stays the console's and Elric's only.
 * Synthetic data only.
 */
type F = Awaited<ReturnType<typeof elricFixture>>;

async function owner(f: F) {
  const me = await f.account('Chat owner');
  await f.verify(me);
  const added = await f.call(me.cookie, 'POST', '/api/elric', {});
  assert.ok(added.statusCode < 300, added.body);
  const elricId = added.json().agent_id as string;
  const elricChat = await f.call(me.cookie, 'GET', '/api/elric/chat');
  assert.equal(elricChat.statusCode, 200, elricChat.body);
  const agentId = await f.agent(me, 'Alex');
  const chat = await f.call(me.cookie, 'POST', '/api/rooms/private-agent', { agent_id: agentId });
  assert.equal(chat.statusCode, 200, chat.body);
  return {
    me,
    elricId,
    agentId,
    elricRoom: elricChat.json().room_id as string,
    chat: chat.json() as { room_id: string; slug: string; person_member_id: string },
  };
}

/** The agent chat as the fixture's room (posts use only its id; it has no link). */
const chatRoom = (o: Awaited<ReturnType<typeof owner>>) => ({
  id: o.chat.room_id,
  slug: o.chat.slug,
  token: '',
  link: '',
});

test('an Elric gets no private agent chat; the Elric chat, its lists and its lock are unchanged', async (t) => {
  const f = await elricFixture(t);
  const o = await owner(f);
  const refused = await f.call(o.me.cookie, 'POST', '/api/rooms/private-agent', {
    agent_id: o.elricId,
  });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().code, 'elric_private_chat');
  // The Elric chat is the same room, still flagged and keyed as before.
  const again = await f.call(o.me.cookie, 'GET', '/api/elric/chat');
  assert.equal(again.json().room_id, o.elricRoom);
  const rows = (
    await f.db.query<{ id: string; elric_private: boolean; idempotency_key: string }>(
      'SELECT id, elric_private, idempotency_key FROM rooms WHERE host_owner_id=$1 ORDER BY elric_private DESC',
      [o.me.operatorId],
    )
  ).rows;
  assert.equal(rows.length, 2, 'the Elric chat and the agent chat, nothing for the refused id');
  assert.equal(rows[0]!.id, o.elricRoom);
  assert.equal(rows[0]!.elric_private, true);
  assert.equal(rows[0]!.idempotency_key, `elric-chat:${o.elricRoom}`);
  assert.equal(rows[1]!.id, o.chat.room_id);
  assert.equal(rows[1]!.elric_private, false);
  // A conversation in the agent chat: still not an Elric conversation, not in the "@ room"
  // picker, and the "@ room" check treats it like the private chat it is (uniform 404).
  const said = await f.say(o.me, chatRoom(o), 'Hello Alex', o.chat.person_member_id);
  assert.equal(said.message.room_id, o.chat.room_id);
  const conversations = await f.call(o.me.cookie, 'GET', '/api/elric/conversations');
  assert.ok(
    !(conversations.json().conversations as Array<{ id: string }>).some(
      (c) => c.id === o.chat.room_id,
    ),
    conversations.body,
  );
  const picker = await f.call(o.me.cookie, 'GET', '/api/elric/rooms');
  assert.deepEqual(picker.json().rooms, [], picker.body);
  const ask = await f.call(o.me.cookie, 'POST', '/api/elric/ask', { room_id: o.chat.room_id });
  assert.equal(ask.statusCode, 404, ask.body);
  // Both chats are locked; each says which chat it is.
  const elricLink = await f.call(o.me.cookie, 'POST', `/api/rooms/${o.elricRoom}/link`, {});
  assert.equal(elricLink.statusCode, 409, elricLink.body);
  assert.deepEqual(elricLink.json(), {
    error: "This is your private Elric chat; it can't be shared or opened.",
    code: 'room_private',
  });
  const agentLink = await f.call(o.me.cookie, 'POST', `/api/rooms/${o.chat.room_id}/link`, {});
  assert.equal(agentLink.statusCode, 409, agentLink.body);
  assert.deepEqual(agentLink.json(), {
    error: "This is your private chat with your agent; it can't be shared or opened.",
    code: 'room_private',
  });
});

test("the owner's assistant grant reads and answers in the agent chat as the agent, never the Elric chat", async (t) => {
  const f = await elricFixture(t);
  const o = await owner(f);
  const granted = await f.call(o.me.cookie, 'POST', '/api/assistant-access', {
    label: 'Own runtime (synthetic)',
    scopes: [...ASSISTANT_SCOPES],
    expiresInDays: 1,
  });
  assert.equal(granted.statusCode, 201, granted.body);
  const token = granted.json().token as string;
  const tool = (name: string, body: unknown) =>
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
  await f.say(o.me, chatRoom(o), 'Hello Alex', o.chat.person_member_id);
  const read = await tool('city_room_read', { room_id: o.chat.room_id, since: 0 });
  assert.ok(read.statusCode < 300, read.body);
  assert.match(read.body, /Hello Alex/);
  const answer = await tool('city_room_post', {
    room_id: o.chat.room_id,
    text: 'Hello, here is Alex.',
    idempotency_key: randomUUID(),
  });
  assert.ok(answer.statusCode < 300, answer.body);
  const sender = (
    await f.db.query<{ sender_agent_id: string; sender_kind: string }>(
      'SELECT sender_agent_id, sender_kind FROM room_messages WHERE room_id=$1 ORDER BY seq DESC LIMIT 1',
      [o.chat.room_id],
    )
  ).rows[0]!;
  assert.deepEqual(sender, { sender_agent_id: o.agentId, sender_kind: 'agent' });
  // An AI of the account never posts as the owner's person.
  const asPerson = await tool('city_room_post', {
    room_id: o.chat.room_id,
    agent_id: o.chat.person_member_id,
    text: 'Pretending to be the owner',
    idempotency_key: randomUUID(),
  });
  assert.equal(asPerson.statusCode, 403, asPerson.body);
  // The Elric chat stays out of the grant's reach.
  const elric = await tool('city_room_read', { room_id: o.elricRoom, since: 0 });
  assert.ok(
    elric.statusCode === 404 || /room_not_found/.test(elric.body),
    `${elric.statusCode} ${elric.body}`,
  );
});
