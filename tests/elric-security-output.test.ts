import test from 'node:test';
import assert from 'node:assert/strict';
import { setKillSwitch } from '../server/elric/budget.js';
import { elricFixture } from './elric-fixture.js';

/**
 * Elric security (room-only context, tool loop, output, money controls): output that could page
 * other members or wake their paid responders, citations before the join point, cross-room
 * targeting by slug, a kill switch flipped between queueing and draining, and workspace pause.
 * Name collisions and impersonation are in elric-security-names.test.ts.
 * Synthetic data only.
 */

async function mentionsOf(f: Awaited<ReturnType<typeof elricFixture>>, agentId: string) {
  return Number(
    (
      await f.db.query<{ n: string }>('SELECT count(*) AS n FROM mentions WHERE agent_id=$1', [
        agentId,
      ])
    ).rows[0]!.n,
  );
}

for (const [label, at] of [
  ['fullwidth ＠ (U+FF20)', '＠'],
  ['small ﹫ (U+FE6B)', '﹫'],
] as const)
  test(`output: a model reply with ${label} next to an e-mail never mentions another member`, async (t) => {
    const f = await elricFixture(t);
    const s = await f.scene();
    // The e-mail puts an ASCII "@" in the text, so the room's mention parser runs; NFKC folds the
    // look-alike to "@". stripMentions must neutralise the look-alike as well.
    f.small.push({ text: `Write to ops@example.invalid or ask ${at}Host desk directly.` });
    const trigger = await f.say(s.owner, s.room, '@Elric who should I ask?', s.person);
    const before = await mentionsOf(f, s.hostAgent);
    await f.elric.run({ agentId: s.elricId, roomId: s.room.id, sourceSeq: trigger.message.seq });
    const posted = (await f.messages(s.room.id)).filter((m) => m.sender_agent_id === s.elricId);
    assert.equal(posted.length, 1, 'the reply was posted');
    assert.equal(
      await mentionsOf(f, s.hostAgent),
      before,
      'Elric paged the host agent (would wake its webhook or paid responder)',
    );
  });

test("output: a citation at or before Elric's join point is stripped", async (t) => {
  const f = await elricFixture(t);
  const host = await f.account('Join host');
  const hostAgent = await f.agent(host, 'Join desk');
  const room = await f.room(host, hostAgent, 'Join-point room', 'from_join');
  const early = await f.say(host, room, 'pre-join secret: kiwi-3', hostAgent);
  const owner = await f.account('Join owner');
  await f.verify(owner);
  const elricId = await f.addElric(owner);
  const person = await f.joinPerson(owner, room, 'Ann');
  await f.joinAgent(owner, room, elricId, { legacy: true });
  const trigger = await f.say(owner, room, '@Elric what was said?', person);
  f.small.push({ text: `See [#${early.message.seq}] and [#${trigger.message.seq}].` });
  await f.elric.run({ agentId: elricId, roomId: room.id, sourceSeq: trigger.message.seq });
  assert.doesNotMatch(JSON.stringify(f.received()), /kiwi-3/);
  const reply = (await f.messages(room.id)).find((m) => m.sender_agent_id === elricId)!;
  const text = f.textOf(reply);
  assert.ok(!text.includes(`[#${early.message.seq}]`), text);
  assert.ok(text.includes(`[#${trigger.message.seq}]`), text);
});

test('tools: room_id given as a slug of another room is refused, and never reads it', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Slug one');
  const r2 = await f.room(s.host, s.hostAgent, 'Slug two');
  const p2 = await f.joinPerson(s.owner, r2, 'Ann');
  await f.joinAgent(s.owner, r2, s.elricId, { legacy: true });
  await f.say(s.owner, r2, 'R2 via slug: mango-9', p2);
  const trigger = await f.say(s.owner, s.room, '@Elric read the other room', s.person);
  f.small.push(
    { toolCalls: [{ name: 'room_read', args: { room_id: r2.slug } }] },
    { toolCalls: [{ name: 'room_task_create', args: { room_id: r2.slug, title: 'x' } }] },
    { toolCalls: [{ name: 'room_read', args: { room_id: s.room.slug } }] },
    { text: 'done' },
  );
  await f.elric.run({ agentId: s.elricId, roomId: s.room.id, sourceSeq: trigger.message.seq });
  assert.doesNotMatch(JSON.stringify(f.received()), /mango-9/);
  const turn = (await f.turns(s.owner.operatorId))[0]!;
  const statuses = turn.tool_calls.map((call) => call.status);
  assert.notEqual(statuses[0], 'ok', 'R2 slug read refused');
  assert.notEqual(statuses[1], 'ok', 'R2 slug task refused');
  t.diagnostic(`own-room slug read: ${statuses[2]}`);
  const tasks = await f.db.query('SELECT 1 FROM room_tasks WHERE room_id=$1', [r2.id]);
  assert.equal(tasks.rows.length, 0);
});

test('budget: a kill switch flipped after queueing stops the drain and leaves nothing reserved', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  await f.say(s.owner, s.room, '@Elric one', s.person);
  await f.say(s.owner, s.room, '@Elric two', s.person);
  await setKillSwitch(f.db, true, 'security test', f.now());
  await f.elric.drain();
  assert.equal(f.adapterCalls(), 0);
  const usage = await f.usage(s.owner.operatorId);
  assert.ok(!usage || Number(usage.reserved_units) === 0, JSON.stringify(usage));
  const global = await f.globalUsage();
  assert.ok(!global || Number(global.reserved_units) === 0, JSON.stringify(global));
  assert.ok(
    (await f.messages(s.room.id)).every((m) => m.sender_agent_id !== s.elricId),
    'nothing posted',
  );
});

test("lifecycle: pausing the owner's whole workspace stops a queued Elric turn", async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  // Queued first (the person may post), then the owner pauses the whole workspace before the drain.
  await f.say(s.owner, s.room, '@Elric hello', s.person);
  assert.equal((await f.invocations(s.elricId)).length, 1, 'queued');
  const paused = await f.call(s.owner.cookie, 'POST', '/api/workspace/pause', { paused: true });
  assert.ok(paused.statusCode < 300, paused.body);
  await f.elric.drain();
  assert.equal(f.adapterCalls(), 0);
  const usage = await f.usage(s.owner.operatorId);
  assert.ok(!usage || Number(usage.reserved_units) === 0, JSON.stringify(usage));
  assert.ok((await f.messages(s.room.id)).every((m) => m.sender_agent_id !== s.elricId));
});
