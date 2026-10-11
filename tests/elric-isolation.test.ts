import test from 'node:test';
import assert from 'node:assert/strict';
import { elricRoomAccess } from '../server/elric/access.js';
import { listElricTurns } from '../server/elric/turns.js';
import type { ModelRequest } from '../server/elric/adapter.js';
import { elricFixture } from './elric-fixture.js';

/**
 * THREAT_PRIVACY_REVIEW §11 "Cross-room leak" and "Cross-user leak": what the adapter RECEIVED
 * and the database state, with the MockAdapter.
 */
const everything = (requests: ModelRequest[]) => JSON.stringify(requests);

test('cross-room: invoking in R1 sends nothing of R2, even when R2 is newer and Elric is in R2', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Room one');
  const r2 = await f.room(s.host, s.hostAgent, 'Room two');
  const person2 = await f.joinPerson(s.owner, r2, 'Ann');
  await f.joinAgent(s.owner, r2, s.elricId, { legacy: true });
  await f.say(s.host, s.room, 'R1: the deploy is on Friday', s.hostAgent);
  const trigger = await f.say(s.owner, s.room, '@Elric when is the deploy?', s.person);
  // Newer text in R2, written after the trigger in R1.
  await f.say(s.host, r2, 'R2 secret plan: zebra-7', s.hostAgent);
  await f.say(s.owner, r2, 'more R2 text: zebra-8', person2);
  f.small.push(
    { toolCalls: [{ name: 'room_read', args: { room_id: r2.id } }] },
    { toolCalls: [{ name: 'room_read', args: { room_id: s.room.id } }] },
    { text: 'Friday [#1].' },
  );
  await f.elric.run({ agentId: s.elricId, roomId: s.room.id, sourceSeq: trigger.message.seq });
  const received = everything(f.received());
  assert.doesNotMatch(received, /zebra/);
  assert.match(received, /the deploy is on Friday/);
  // The R1 read tool result is bounded by the trigger: nothing after it either.
  const turns = await f.turns(s.owner.operatorId);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.outcome, 'ok');
  assert.deepEqual(
    turns[0]!.tool_calls.map((call) => [call.name, call.status]),
    [
      ['room_read', 'refused_room'],
      ['room_read', 'ok'],
    ],
  );
  assert.equal(turns[0]!.room_id, s.room.id);
  assert.equal(Number(turns[0]!.context_to_seq), trigger.message.seq);
  // Nothing was posted in R2.
  assert.ok((await f.messages(r2.id)).every((row) => row.sender_agent_id !== s.elricId));
});

test('from_join: Elric never receives a message at or before its own join point', async (t) => {
  const f = await elricFixture(t);
  const host = await f.account('Join host');
  const hostAgent = await f.agent(host, 'Join desk');
  const r3 = await f.room(host, hostAgent, 'Join room', 'from_join');
  for (let i = 1; i <= 4; i++) await f.say(host, r3, `early secret ${i}: walrus-${i}`, hostAgent);
  const owner = await f.account('Join owner');
  await f.verify(owner);
  const elricId = await f.addElric(owner);
  const person = await f.joinPerson(owner, r3, 'Jo');
  await f.joinAgent(owner, r3, elricId, { legacy: true });
  const visible = Number(
    (
      await f.db.query<{ v: string }>(
        'SELECT visible_from_seq AS v FROM room_members WHERE room_id=$1 AND agent_id=$2',
        [r3.id, elricId],
      )
    ).rows[0]!.v,
  );
  assert.ok(visible >= 4, `Elric joins after the early messages (visible_from_seq ${visible})`);
  await f.say(host, r3, 'after join: the answer is 42', hostAgent);
  const trigger = await f.say(owner, r3, '@Elric what was said before I came?', person);
  f.small.push(
    { toolCalls: [{ name: 'room_read', args: { room_id: r3.id, since: 0 } }] },
    { text: 'Before you joined: nothing I can see [#2]. After: 42 [#' + (visible + 1) + '].' },
  );
  await f.elric.run({ agentId: elricId, roomId: r3.id, sourceSeq: trigger.message.seq });
  const received = everything(f.received());
  assert.doesNotMatch(received, /walrus/);
  for (const request of f.received())
    for (const message of request.messages)
      for (const line of (message.role === 'tool' ? '' : (message.content ?? '')).split('\n'))
        if (line.startsWith('{"seq"')) assert.ok(JSON.parse(line).seq > visible, line);
  const turn = (await f.turns(owner.operatorId))[0]!;
  assert.ok(Number(turn.context_from_seq) > visible);
  // The citation of a pre-join message is stripped; the visible one is kept.
  const reply = (await f.messages(r3.id)).at(-1)!;
  assert.equal(reply.sender_agent_id, elricId);
  assert.doesNotMatch(f.textOf(reply), /\[#2\]/);
  assert.match(f.textOf(reply), new RegExp(`\\[#${visible + 1}\\]`));
  assert.equal(turn.reason, 'citations_stripped:1');
});

test("a room where the owner is only a person: Elric's access is the uniform not_found", async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const other = await f.room(s.host, s.hostAgent, 'Person only room');
  const person = await f.joinPerson(s.owner, other, 'Ann');
  const denied = await elricRoomAccess(f.db, s.elricId, other.id);
  assert.deepEqual(denied, { ok: false, code: 'not_found' });
  assert.deepEqual(await elricRoomAccess(f.db, s.elricId, 'no-such-room'), denied);
  // A mention there does not even reach Elric (it is not a member): no invocation, no turn.
  await f.say(s.owner, other, '@Elric are you here?', person);
  assert.equal((await f.invocations(s.elricId)).length, 0);
  assert.equal((await f.turns(s.owner.operatorId)).length, 0);
});

test('cross-user: two owners, two Elrics in one room; no data, access or billing crosses', async (t) => {
  // Two member Elrics in one room: only possible in a room from before the host-only rule.
  const f = await elricFixture(t);
  const host = await f.account('Shared host');
  const hostAgent = await f.agent(host, 'Shared desk');
  const shared = await f.room(host, hostAgent, 'Shared room');
  const a = await f.account('Owner Alice');
  const b = await f.account('Owner Bruno');
  await f.verify(a);
  await f.verify(b);
  const elricA = await f.addElric(a, 'Elric Alice');
  const elricB = await f.addElric(b, 'Elric Bruno');
  const personA = await f.joinPerson(a, shared, 'Alice');
  const personB = await f.joinPerson(b, shared, 'Bruno');
  await f.joinAgent(a, shared, elricA, { legacy: true });
  await f.joinAgent(b, shared, elricB, { legacy: true });
  // Alice's private room (her agent hosts it), with a message and a task.
  const aliceAgent = await f.agent(a, 'Alice desk');
  const privateA = await f.room(a, aliceAgent, 'Alice private');
  await f.joinAgent(a, privateA, elricA);
  await f.say(a, privateA, 'Alice private note: okapi-1', aliceAgent);
  const task = await f.call(a.cookie, 'POST', `/api/rooms/${privateA.id}/tasks`, {
    agent_id: aliceAgent,
    title: 'Alice private task okapi-2',
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(task.statusCode, 201, task.body);

  await f.say(host, shared, 'shared: standup at 10', hostAgent);
  const trigger = await f.say(b, shared, '@"Elric Bruno" when is standup?', personB);
  f.small.push(
    { toolCalls: [{ name: 'room_read', args: { room_id: privateA.id } }] },
    { text: 'At 10 [#1].' },
  );
  const result = await f.elric.run({
    agentId: elricB,
    roomId: shared.id,
    sourceSeq: trigger.message.seq,
  });
  assert.equal(result?.outcome, 'ok');
  assert.doesNotMatch(everything(f.received()), /okapi/);
  // Bruno's Elric sees Alice's rooms exactly like rooms that do not exist.
  assert.deepEqual(await elricRoomAccess(f.db, elricB, privateA.id), {
    ok: false,
    code: 'not_found',
  });
  assert.deepEqual(
    await elricRoomAccess(f.db, elricB, privateA.id),
    await elricRoomAccess(f.db, elricB, 'no-such-room'),
  );
  // Billing and attribution: only Bruno's allowance moved; the turn is his only.
  assert.equal((await f.usage(b.operatorId))!.short, 1);
  assert.equal(await f.usage(a.operatorId), undefined);
  const turnsB = await listElricTurns(f.db, b.operatorId);
  const turnsA = await listElricTurns(f.db, a.operatorId);
  assert.equal(turnsB.turns.length, 1);
  assert.equal(turnsB.turns[0]!.agent_id, elricB);
  assert.equal(turnsA.turns.length, 0);
  // Alice mentions her own Elric in the same room: billed and attributed to her.
  const triggerA = await f.say(a, shared, '@"Elric Alice" and for me?', personA);
  await f.elric.run({ agentId: elricA, roomId: shared.id, sourceSeq: triggerA.message.seq });
  assert.equal((await f.usage(a.operatorId))!.short, 1);
  assert.equal((await f.usage(b.operatorId))!.short, 1);
  assert.equal((await listElricTurns(f.db, a.operatorId)).turns[0]!.agent_id, elricA);
  // Mentioning the OTHER owner's Elric queues nothing for it.
  await f.say(a, shared, '@"Elric Bruno" answer me', personA);
  assert.equal(
    (await f.invocations(elricB)).filter((row) => row.status === 'queued').length,
    0,
    'Alice cannot invoke Bruno’s Elric',
  );
});
