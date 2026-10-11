import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ELRIC_PENDING_REPLY } from '../server/elric/service.js';
import { elricFixture } from './elric-fixture.js';

/**
 * A consequential request: the reply in the room says "Waiting for your approval." and never the
 * raw pending id, which travels as auto_reply.pending_id for the Approve/Reject card. And only
 * Elric's own runtime posts as Elric: never the owner's console, a grant or a key.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test('the pending reply is a plain line; the id is in auto_reply.pending_id only', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Pending copy room');
  const trigger = await f.say(s.owner, s.room, '@Elric create a task for the notes', s.person);
  f.large.push(
    {
      toolCalls: [{ name: 'room_task_create', args: { room_id: s.room.id, title: 'Notes' } }],
    },
    // A model that echoes the id must not leak it.
    { text: 'Submitted for your approval (pending id 7d9e2c1a-0b3f-4c5d-8e6f-1a2b3c4d5e6f).' },
  );
  await f.elric.run({ agentId: s.elricId, roomId: s.room.id, sourceSeq: trigger.message.seq });
  const pending = (
    await f.db.query<{ id: string }>("SELECT id FROM elric_pending_actions WHERE status='pending'")
  ).rows;
  assert.equal(pending.length, 1);
  const read = await f.call(s.owner.cookie, 'GET', `/api/rooms/${s.room.id}/messages?since=0`);
  const reply = (
    read.json().messages as Array<{
      sender_agent_id: string;
      text: string;
      auto_reply: { pending_id?: string } | null;
    }>
  ).find((message) => message.sender_agent_id === s.elricId)!;
  assert.equal(reply.text, ELRIC_PENDING_REPLY);
  assert.doesNotMatch(reply.text, UUID);
  assert.equal(reply.auto_reply?.pending_id, pending[0]!.id);
});

test('only Elric posts as Elric: the console and a grant are refused (403 elric_posts_itself)', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Post as room');
  const console = await f.call(s.owner.cookie, 'POST', `/api/rooms/${s.room.id}/messages`, {
    text: 'I am Elric now',
    agent_id: s.elricId,
    idempotency_key: randomUUID(),
  });
  assert.equal(console.statusCode, 403, console.body);
  assert.equal(console.json().code, 'elric_posts_itself');
  const granted = await f.call(s.owner.cookie, 'POST', '/api/assistant-access', {
    label: 'Synthetic AI',
    scopes: ['workspace:read', 'rooms:host', 'rooms:join'],
    expiresInDays: 1,
  });
  const viaGrant = await f.app.inject({
    method: 'POST',
    url: '/api/assistant/tools/city_room_post',
    headers: {
      'content-type': 'application/json',
      'x-city-request': '1',
      authorization: `Bearer ${granted.json().token as string}`,
    },
    payload: JSON.stringify({
      room_id: s.room.id,
      agent_id: s.elricId,
      text: 'I am Elric too',
      idempotency_key: randomUUID(),
    }),
  });
  assert.ok(viaGrant.statusCode >= 400, viaGrant.body);
  assert.ok(
    !(await f.messages(s.room.id)).some((message) => message.sender_agent_id === s.elricId),
    'nothing was posted as Elric',
  );
  // The owner's person still posts, and Elric's own reply still goes out.
  f.small.push({ text: 'Here.' });
  await f.say(s.owner, s.room, '@Elric are you there?', s.person);
  await f.elric.drain();
  assert.ok((await f.messages(s.room.id)).some((message) => message.sender_agent_id === s.elricId));
});

test('an agent that ever was an Elric (also revoked) is never acted as: posts, tasks; it keeps its marker', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Ever Elric room');
  // Revoke the Elric row only (the agent stays a live room member, as on an older deploy).
  await f.db.query("UPDATE elric_agents SET status='revoked' WHERE agent_id=$1", [s.elricId]);
  const post = await f.call(s.owner.cookie, 'POST', `/api/rooms/${s.room.id}/messages`, {
    text: 'posing',
    agent_id: s.elricId,
    idempotency_key: randomUUID(),
  });
  assert.equal(post.statusCode, 403, post.body);
  assert.equal(post.json().code, 'elric_posts_itself');
  const task = await f.call(s.owner.cookie, 'POST', `/api/rooms/${s.room.id}/tasks`, {
    title: 'As Elric',
    agent_id: s.elricId,
    idempotency_key: randomUUID(),
  });
  assert.ok(task.statusCode >= 400, task.body);
  assert.equal(
    (await f.db.query('SELECT 1 FROM room_tasks WHERE room_id=$1', [s.room.id])).rows.length,
    0,
  );
  // The member list still marks it, so no "Post as" offers it.
  const members = (await f.call(s.owner.cookie, 'GET', `/api/rooms/${s.room.id}/members`)).json()
    .members as Array<{ id: string; auto_reply: { provider: string } | null }>;
  assert.equal(members.find((m) => m.id === s.elricId)?.auto_reply?.provider, 'elric');
  // The owner's own other AI still creates a task normally.
  const helper = await f.agent(s.owner, 'Owner helper');
  await f.joinAgent(s.owner, s.room, helper);
  const own = await f.call(s.owner.cookie, 'POST', `/api/rooms/${s.room.id}/tasks`, {
    title: 'By the helper',
    agent_id: helper,
    idempotency_key: randomUUID(),
  });
  assert.ok(own.statusCode < 300, own.body);
});

test('B13: a reply never names tools or functions (plain words instead)', async (t) => {
  const { plainToolWords } = await import('../server/elric/service.js');
  assert.equal(
    plainToolWords('I used room_task_create to add it.'),
    'I used create a task to add it.',
  );
  assert.equal(plainToolWords('Calling `room_read()` now'), 'Calling read the room now');
  assert.doesNotMatch(
    plainToolWords('Try city_room_post or elric_pending_list.'),
    /city_|elric_|room_/,
  );
  const f = await elricFixture(t);
  const s = await f.scene('Plain words room');
  f.small.push({ text: 'I checked with room_read and city_room_members; all good.' });
  await f.say(s.owner, s.room, '@Elric anything new?', s.person);
  await f.elric.drain();
  const reply = (await f.messages(s.room.id))
    .filter((m) => m.sender_agent_id === s.elricId)
    .at(-1)!;
  assert.doesNotMatch(f.textOf(reply), /room_read|city_room_members|_[a-z]+_/);
});

test('B15: nobody but Elric creates a room task as Elric (console and grant), active Elric', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Task as Elric room');
  const consoleTask = await f.call(s.owner.cookie, 'POST', `/api/rooms/${s.room.id}/tasks`, {
    title: 'Pretend Elric made this',
    agent_id: s.elricId,
    idempotency_key: randomUUID(),
  });
  assert.equal(consoleTask.statusCode, 403, consoleTask.body);
  const granted = await f.call(s.owner.cookie, 'POST', '/api/assistant-access', {
    label: 'Synthetic AI',
    scopes: ['workspace:read', 'rooms:host', 'rooms:join'],
    expiresInDays: 1,
  });
  const viaGrant = await f.app.inject({
    method: 'POST',
    url: '/api/assistant/tools/city_room_task_create',
    headers: {
      'content-type': 'application/json',
      'x-city-request': '1',
      authorization: `Bearer ${granted.json().token as string}`,
    },
    payload: JSON.stringify({
      room_id: s.room.id,
      agent_id: s.elricId,
      title: 'Grant as Elric',
      idempotency_key: randomUUID(),
    }),
  });
  assert.ok(
    viaGrant.statusCode >= 400 || /error|refus|not_a_member|elric/i.test(viaGrant.body),
    viaGrant.body,
  );
  const created = await f.db.query(
    'SELECT 1 FROM room_tasks WHERE room_id=$1 AND created_by_agent_id=$2',
    [s.room.id, s.elricId],
  );
  assert.equal(created.rows.length, 0, 'no task created as Elric');
});

test('reads stay open: an owner whose only member in a room is their Elric lists and reads tasks (200)', async (t) => {
  const f = await elricFixture(t);
  const host = await f.account('Task host');
  const desk = await f.agent(host, 'Task desk');
  const room = await f.room(host, desk, 'Tasks with Elric only');
  const owner = await f.account('Elric only owner');
  await f.verify(owner);
  const elricId = await f.addElric(owner);
  await f.joinAgent(owner, room, elricId, { legacy: true }); // the owner's only member in this room
  const made = await f.call(host.cookie, 'POST', `/api/rooms/${room.id}/tasks`, {
    title: 'A visible task',
    idempotency_key: randomUUID(),
  });
  assert.ok(made.statusCode < 300, made.body);
  const taskId = made.json().task.id as string;
  const list = await f.call(owner.cookie, 'GET', `/api/rooms/${room.id}/tasks`);
  assert.equal(list.statusCode, 200, list.body);
  assert.ok((list.json().tasks as Array<{ id: string }>).some((task) => task.id === taskId));
  const one = await f.call(owner.cookie, 'GET', `/api/rooms/${room.id}/tasks/${taskId}`);
  assert.equal(one.statusCode, 200, one.body);
  // Writing as that Elric stays refused.
  const write = await f.call(owner.cookie, 'POST', `/api/rooms/${room.id}/tasks`, {
    title: 'As Elric',
    agent_id: elricId,
    idempotency_key: randomUUID(),
  });
  assert.equal(write.statusCode, 403, write.body);
});
