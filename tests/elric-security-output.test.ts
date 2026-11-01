import test from 'node:test';
import assert from 'node:assert/strict';
import { setKillSwitch } from '../server/elric/budget.js';
import { stripMentions } from '../server/elric/reply.js';
import { findMentions } from '../server/wake/mentions.js';
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

test('output: a letter that lower-cases to a combining mark before "@" (İ@Name) never mentions', async (t) => {
  // The parser checks the character before "@" after lower-casing: "İ" becomes "i" plus U+0307
  // (not a letter), so it reads a mention there. Astral letters end in a surrogate the same way.
  for (const text of ['Thanks İ@Bob for the notes.', 'See 𐐀@Bob', 'mail@@Bob', '@@Bob'])
    assert.deepEqual(findMentions(stripMentions(text), [{ id: 'agent-bob', name: 'Bob' }]).ids, []);
  // E-mail addresses stay as written.
  assert.equal(
    stripMentions('mail ann@example.com or Ünal@example.com'),
    'mail ann@example.com or Ünal@example.com',
  );
  const f = await elricFixture(t);
  const s = await f.scene();
  f.small.push({ text: 'Thanks İ@Host desk for the notes.' });
  const trigger = await f.say(s.owner, s.room, '@Elric who wrote the notes?', s.person);
  const before = await mentionsOf(f, s.hostAgent);
  await f.elric.run({ agentId: s.elricId, roomId: s.room.id, sourceSeq: trigger.message.seq });
  const posted = (await f.messages(s.room.id)).filter((m) => m.sender_agent_id === s.elricId);
  assert.equal(posted.length, 1, 'the reply was posted');
  assert.equal(f.textOf(posted[0]!), 'Thanks İHost desk for the notes.');
  assert.equal(await mentionsOf(f, s.hostAgent), before, 'Elric paged the host agent');
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

test("output: in a 'from_join' room Elric's context starts where its latest reader joined", async (t) => {
  const f = await elricFixture(t);
  const host = await f.account('Audience host');
  const hostAgent = await f.agent(host, 'Audience desk');
  const room = await f.room(host, hostAgent, 'Audience room', 'from_join');
  const owner = await f.account('Audience owner');
  await f.verify(owner);
  const elricId = await f.addElric(owner);
  const person = await f.joinPerson(owner, room, 'Ann');
  await f.joinAgent(owner, room, elricId, { legacy: true });
  const early = await f.say(host, room, 'before the newcomer: plum-7', hostAgent);
  // A later member: from_join hides everything above from them.
  const newcomer = await f.account('Audience newcomer');
  await f.joinPerson(newcomer, room, 'Nia');
  await f.say(host, room, 'after the newcomer: pear-4', hostAgent);
  const trigger = await f.say(owner, room, '@Elric what was said here?', person);
  f.small.push(
    { toolCalls: [{ name: 'room_read', args: { room_id: room.id, since: 0 } }] },
    { text: `See [#${early.message.seq}] and [#${trigger.message.seq}].` },
  );
  await f.elric.run({ agentId: elricId, roomId: room.id, sourceSeq: trigger.message.seq });
  const sent = JSON.stringify(f.received());
  assert.doesNotMatch(sent, /plum-7/, 'context or room_read reached before the newcomer joined');
  assert.match(sent, /pear-4/);
  assert.match(sent, /what was said here/);
  assert.match(sent, /Room history \(trusted\): earlier messages are left out/);
  const reply = (await f.messages(room.id)).find((m) => m.sender_agent_id === elricId)!;
  const text = f.textOf(reply);
  assert.ok(!text.includes(`[#${early.message.seq}]`), text);
  assert.ok(text.includes(`[#${trigger.message.seq}]`), text);
  // A member who joins after the question cannot see it: it is not answered, and nothing of it
  // reaches the model or the room.
  f.small.requests.length = 0;
  const calls = f.adapterCalls();
  const next = await f.say(owner, room, '@Elric and now?', person);
  await f.joinPerson(await f.account('Audience late'), room, 'Lou');
  f.small.push({ text: 'You asked: and now?' });
  const result = await f.elric.run({
    agentId: elricId,
    roomId: room.id,
    sourceSeq: next.message.seq,
  });
  assert.deepEqual([result?.outcome, result?.reason], ['cancelled', 'audience_changed']);
  assert.equal(f.adapterCalls(), calls);
  assert.doesNotMatch(JSON.stringify(f.small.requests), /and now\?/);
  const replies = (await f.messages(room.id)).filter((m) => m.sender_agent_id === elricId);
  assert.equal(replies.length, 1, 'only the first answer was posted');
});

test("output: in a 'from_join' room a question asked before a member joined is never echoed to them", async (t) => {
  const f = await elricFixture(t);
  const host = await f.account('Echo host');
  const hostAgent = await f.agent(host, 'Echo desk');
  const room = await f.room(host, hostAgent, 'Echo room', 'from_join');
  const owner = await f.account('Echo owner');
  await f.verify(owner);
  const elricId = await f.addElric(owner);
  const person = await f.joinPerson(owner, room, 'Ann');
  await f.joinAgent(owner, room, elricId, { legacy: true });
  const trigger = await f.say(owner, room, '@Elric repeat synthetic secret plum-7', person);
  // The newcomer joins after the question, before the run.
  const newcomer = await f.account('Echo newcomer');
  await f.joinPerson(newcomer, room, 'Nia');
  const read = async () => {
    const res = await f.call(newcomer.cookie, 'GET', `/api/rooms/${room.id}/messages`);
    assert.equal(res.statusCode, 200, res.body);
    return res.body;
  };
  assert.doesNotMatch(await read(), /plum-7/, 'the newcomer cannot see the question');
  const calls = f.adapterCalls();
  // The model echoes whatever synthetic secret its request holds.
  f.small.push((request) => ({
    text: `Your synthetic secret is ${JSON.stringify(request.messages).match(/plum-\d/)?.[0] ?? 'unknown'}.`,
  }));
  const result = await f.elric.run({
    agentId: elricId,
    roomId: room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.doesNotMatch(await read(), /plum-7/, 'the echo never reaches the newcomer');
  assert.deepEqual([result?.outcome, result?.reason], ['cancelled', 'audience_changed']);
  assert.equal(f.adapterCalls(), calls, 'no model step for a question the audience cannot see');
  assert.doesNotMatch(JSON.stringify(f.received()), /plum-7/);
  const replies = (await f.messages(room.id)).filter((m) => m.sender_agent_id === elricId);
  assert.deepEqual(replies, []);
  // Without a late joiner a question is answered as before (by the same echoing model step,
  // which the refused run never used).
  const again = await f.say(owner, room, '@Elric repeat synthetic secret plum-8', person);
  const ok = await f.elric.run({ agentId: elricId, roomId: room.id, sourceSeq: again.message.seq });
  assert.equal(ok?.outcome, 'ok');
  assert.match(JSON.stringify(f.received()), /plum-8/);
  assert.match(await read(), /Your synthetic secret is plum-8/, 'the newcomer sees the new answer');
  assert.doesNotMatch(await read(), /plum-7/);
});

test('output: a member who joins during the run is noticed even when the context already started at the question', async (t) => {
  const f = await elricFixture(t);
  const host = await f.account('Edge host');
  const hostAgent = await f.agent(host, 'Edge desk');
  const room = await f.room(host, hostAgent, 'Edge room', 'from_join');
  const owner = await f.account('Edge owner');
  await f.verify(owner);
  const elricId = await f.addElric(owner);
  const person = await f.joinPerson(owner, room, 'Ann');
  await f.joinAgent(owner, room, elricId, { legacy: true });
  await f.say(host, room, 'said early: fig-3', hostAgent);
  // Mia joins right before the question: the context starts at the question itself.
  await f.joinPerson(await f.account('Edge mia'), room, 'Mia');
  const trigger = await f.say(owner, room, '@Elric repeat synthetic secret pear-5', person);
  const late = await f.account('Edge late');
  f.small.push(async () => {
    await f.joinPerson(late, room, 'Lou');
    return { text: 'Your synthetic secret is pear-5.' };
  });
  const result = await f.elric.run({
    agentId: elricId,
    roomId: room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.deepEqual([result?.outcome, result?.reason], ['cancelled', 'audience_changed']);
  const sent = JSON.stringify(f.received());
  assert.match(sent, /pear-5/, 'the context was loaded before the join');
  assert.doesNotMatch(sent, /fig-3/);
  assert.deepEqual(
    (await f.messages(room.id)).filter((m) => m.sender_agent_id === elricId),
    [],
  );
  const res = await f.call(late.cookie, 'GET', `/api/rooms/${room.id}/messages`);
  assert.equal(res.statusCode, 200, res.body);
  assert.doesNotMatch(res.body, /pear-5/);
});

test("output: in a 'from_join' room a member who joins during the run never gets a reply built from before their join", async (t) => {
  const f = await elricFixture(t);
  const host = await f.account('Midrun host');
  const hostAgent = await f.agent(host, 'Midrun desk');
  const room = await f.room(host, hostAgent, 'Midrun room', 'from_join');
  const owner = await f.account('Midrun owner');
  await f.verify(owner);
  const elricId = await f.addElric(owner);
  const person = await f.joinPerson(owner, room, 'Ann');
  await f.joinAgent(owner, room, elricId, { legacy: true });
  await f.say(host, room, 'said early: fig-3', hostAgent);
  const elricReplies = async () =>
    (await f.messages(room.id)).filter((m) => m.sender_agent_id === elricId);
  // One step: the newcomer joins while the model is answering from the loaded context.
  const first = await f.say(owner, room, '@Elric what was said?', person);
  f.small.push(async () => {
    await f.joinPerson(await f.account('Midrun newcomer'), room, 'Nia');
    return { text: 'Earlier someone said fig-3.' };
  });
  const result = await f.elric.run({
    agentId: elricId,
    roomId: room.id,
    sourceSeq: first.message.seq,
  });
  assert.deepEqual([result?.outcome, result?.reason], ['cancelled', 'audience_changed']);
  assert.match(JSON.stringify(f.small.requests), /fig-3/, 'the context was loaded before the join');
  assert.deepEqual(await elricReplies(), []);
  assert.equal((await f.usage(owner.operatorId))!.short, 1, 'a paid step keeps its count');
  // Several steps: a join during the first one stops the run before the next model call.
  await f.say(host, room, 'said after Nia joined: kiwi-9', hostAgent);
  const second = await f.say(owner, room, '@Elric and in short?', person);
  const calls = f.adapterCalls();
  f.small.push(async () => {
    await f.joinPerson(await f.account('Midrun later'), room, 'Lou');
    return { toolCalls: [{ name: 'city_help', args: { query: 'rooms' } }] };
  });
  const again = await f.elric.run({
    agentId: elricId,
    roomId: room.id,
    sourceSeq: second.message.seq,
  });
  assert.deepEqual([again?.outcome, again?.reason], ['cancelled', 'audience_changed']);
  assert.equal(f.adapterCalls(), calls + 1);
  assert.match(JSON.stringify(f.small.requests.at(-1)), /kiwi-9/);
  assert.deepEqual(await elricReplies(), []);
  // No join during the run: the reply is posted as before.
  const third = await f.say(owner, room, '@Elric still there?', person);
  f.small.push({ text: 'Yes.' });
  const ok = await f.elric.run({ agentId: elricId, roomId: room.id, sourceSeq: third.message.seq });
  assert.equal(ok?.outcome, 'ok');
  assert.equal((await elricReplies()).length, 1);
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
