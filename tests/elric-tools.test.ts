import test from 'node:test';
import assert from 'node:assert/strict';
import { elricRoomAccess } from '../server/elric/access.js';
import { ELRIC_STEP_LIMIT_TEXT } from '../server/elric/service.js';
import { argsHash } from '../server/elric/turns.js';
import { elricFixture } from './elric-fixture.js';

/**
 * Tools, the bounded loop, and revocation/pause/removal (THREAT_PRIVACY_REVIEW §11 "Unauthorized
 * tool use" and "Revocation, pause and removal").
 */

test('unauthorized tools are refused server-side and audited; the loop carries on honestly', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric tidy up', s.person);
  const names = [
    'city_control',
    'city_create_room',
    'city_request_connection',
    'city_set_wake_webhook',
    'city_room_apply',
  ];
  f.small.push(
    // Two steps (at most four tool calls per step are honoured).
    {
      toolCalls: names
        .slice(0, 3)
        .map((name) => ({ name, args: { room_id: s.room.id, action: 'revoke' } })),
    },
    {
      toolCalls: names
        .slice(3)
        .map((name) => ({ name, args: { room_id: s.room.id, action: 'revoke' } })),
    },
    { text: 'I cannot do that here.' },
  );
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.equal(result?.outcome, 'ok');
  const turn = (await f.turns(s.owner.operatorId))[0]!;
  assert.deepEqual(
    turn.tool_calls.map((call) => [call.name, call.status]),
    names.map(() => ['other', 'refused_not_allowed']),
  );
  // Only allowlisted names are stored; the requested name is kept as a hash for auditors.
  assert.deepEqual(
    turn.tool_calls.map((call) => call.name_hash),
    names.map((name) => argsHash(name)),
  );
  assert.doesNotMatch(JSON.stringify(turn.tool_calls), /city_/);
  // The model was told each call was refused (and nothing else happened).
  const toolMessages = f.received()[2]!.messages.filter((message) => message.role === 'tool');
  assert.equal(toolMessages.length, names.length);
  assert.ok(toolMessages.every((message) => message.content.includes('refused_not_allowed')));
  const snapshot = await f.call(s.owner.cookie, 'GET', '/api/snapshot');
  const elric = (snapshot.json().agents as Array<{ id: string; status: string }>).find(
    (agent) => agent.id === s.elricId,
  )!;
  assert.notEqual(elric.status, 'revoked');
});

test('room_task_create: only in the invoking room (R2 refused even though allowlisted), only when tasks are on', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Task room');
  const r2 = await f.room(s.host, s.hostAgent, 'Other task room');
  await f.joinAgent(s.owner, r2, s.elricId, { legacy: true });
  const trigger = await f.say(s.owner, s.room, '@Elric create a task for the login fix', s.person);
  f.large.push(
    {
      toolCalls: [
        { name: 'room_task_create', args: { room_id: r2.id, title: 'Sneaky task' } },
        { name: 'room_task_create', args: { room_id: s.room.id, title: 'Fix login' } },
      ],
    },
    { text: 'Created T1.' },
  );
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  // room_task_create is consequential: nothing is created until the owner approves.
  assert.equal(result?.outcome, 'pending');
  assert.equal(result?.tier, 2);
  assert.equal((await f.db.query('SELECT 1 FROM room_tasks')).rows.length, 0);
  const turn = (await f.turns(s.owner.operatorId))[0]!;
  assert.deepEqual(
    turn.tool_calls.map((call) => call.status),
    ['refused_room', 'refused_pending'],
  );
  assert.equal(turn.model, 'mock-large');
  const [pending] = (
    await f.db.query<{ id: string; args_hash: string; args: unknown; room_id: string }>(
      "SELECT id,args_hash,args,room_id FROM elric_pending_actions WHERE status='pending'",
    )
  ).rows;
  assert.deepEqual(pending!.args, { room_id: s.room.id, title: 'Fix login' });
  // The model was told it waits for approval (fixed text with the pending id).
  const told = f.large.requests
    .at(-1)!
    .messages.find((m) => m.role === 'tool' && m.content.includes(pending!.id));
  assert.ok(told, 'the tool result names the pending id');
  const approved = await f.call(
    s.owner.cookie,
    'POST',
    `/api/elric/pending/${pending!.id}/approve`,
    {
      args_hash: pending!.args_hash,
    },
  );
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().status, 'approved');
  const tasks = (
    await f.db.query<{ room_id: string; title: string; created_by_agent_id: string }>(
      'SELECT room_id,title,created_by_agent_id FROM room_tasks',
    )
  ).rows;
  assert.deepEqual(tasks, [
    { room_id: s.room.id, title: 'Fix login', created_by_agent_id: s.elricId },
  ]);
  assert.equal((await f.usage(s.owner.operatorId))!.tool, 1);
  // Tier 0 lists it.
  await f.say(s.owner, s.room, '@Elric open tasks', s.person);
  await f.elric.drain();
  assert.match(f.textOf((await f.messages(s.room.id)).at(-1)!), /T1 Fix login \(open\)/);

  // Room tasks off: the tool is not offered and a request is refused.
  process.env.CITY_ROOM_TASKS = '0';
  try {
    const off = await f.say(s.owner, s.room, '@Elric create a task for docs', s.person);
    f.large.push(
      { toolCalls: [{ name: 'room_task_create', args: { room_id: s.room.id, title: 'Docs' } }] },
      { text: 'Tasks are off here.' },
    );
    await f.elric.run({ agentId: s.elricId, roomId: s.room.id, sourceSeq: off.message.seq });
    const offered = f.large.requests.at(-1)!.tools!.map((tool) => tool.name);
    assert.deepEqual(offered, ['room_read', 'city_help']);
    const last = (await f.turns(s.owner.operatorId)).at(-1)!;
    assert.deepEqual(
      last.tool_calls.map((call) => call.status),
      ['refused_disabled'],
    );
    assert.equal((await f.db.query('SELECT 1 FROM room_tasks')).rows.length, 1);
  } finally {
    process.env.CITY_ROOM_TASKS = '1';
  }
});

test('the tool loop stops at 8 adapter steps with an honest message', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric dig through everything', s.person);
  for (let i = 0; i < 20; i++)
    f.small.push({ toolCalls: [{ name: 'room_read', args: { room_id: s.room.id } }] });
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.equal(f.adapterCalls(), 8);
  assert.equal(result?.outcome, 'step_limit');
  const reply = (await f.messages(s.room.id)).at(-1)!;
  assert.equal(reply.sender_agent_id, s.elricId);
  assert.equal(f.textOf(reply), ELRIC_STEP_LIMIT_TEXT);
  const turn = (await f.turns(s.owner.operatorId))[0]!;
  assert.equal(turn.tool_calls.length, 8);
  assert.ok(Number(turn.cost_units) > 0);
  const usage = (await f.usage(s.owner.operatorId))!;
  assert.equal(Number(usage.reserved_units), 0, 'the reservation was settled');
  assert.equal(Number(usage.spent_units), Number(turn.cost_units));
});

test('revocation between tool steps: the next tool call is refused, nothing posted, refunded, next refused', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric look around', s.person);
  f.small.push(
    { toolCalls: [{ name: 'room_read', args: { room_id: s.room.id } }] },
    { toolCalls: [{ name: 'room_read', args: { room_id: s.room.id } }] },
    { text: 'never posted' },
  );
  let tools = 0;
  f.setProbe(async (point) => {
    if (point === 'before_tool' && ++tools === 2) await f.elric.revoke(s.owner.operatorId);
  });
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  f.setProbe(undefined);
  assert.equal(result?.outcome, 'refused_inactive');
  assert.equal(result?.reason, 'revoked');
  assert.equal(f.adapterCalls(), 2);
  const turn = (await f.turns(s.owner.operatorId))[0]!;
  assert.deepEqual(
    turn.tool_calls.map((call) => call.status),
    ['ok', 'cancelled'],
  );
  assert.ok((await f.messages(s.room.id)).every((row) => row.sender_agent_id !== s.elricId));
  const usage = (await f.usage(s.owner.operatorId))!;
  assert.equal(usage.short, 0, 'the allowance was refunded');
  assert.equal(Number(usage.reserved_units), 0);
  // Revoked: the next mention reaches nothing (no invocation, no adapter call).
  await f.say(s.owner, s.room, '@Elric are you there?', s.person);
  await f.elric.drain();
  assert.equal(f.adapterCalls(), 2);
  assert.deepEqual(await elricRoomAccess(f.db, s.elricId, s.room.id), {
    ok: false,
    code: 'revoked',
  });
  // The owner can see who revoked it.
  const row = (
    await f.db.query<{ revoked_by: string }>(
      'SELECT revoked_by FROM elric_agents WHERE agent_id=$1',
      [s.elricId],
    )
  ).rows[0]!;
  assert.equal(row.revoked_by, 'the owner');
});

test('pause while a model call is in flight: nothing posted, refunded, the next call refused', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric answer slowly', s.person);
  f.small.beforeReply = async () => {
    const res = await f.call(s.owner.cookie, 'POST', '/api/elric/pause');
    assert.equal(res.statusCode, 200, res.body);
  };
  f.small.push({ text: 'generated while paused' });
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  f.small.beforeReply = undefined;
  assert.equal(result?.outcome, 'refused_inactive');
  assert.equal(result?.reason, 'paused');
  assert.ok((await f.messages(s.room.id)).every((row) => row.sender_agent_id !== s.elricId));
  const usage = (await f.usage(s.owner.operatorId))!;
  assert.equal(usage.short, 0);
  assert.equal(Number(usage.reserved_units), 0);
  // Paused: the next mention is refused before any read or adapter call.
  await f.say(s.owner, s.room, '@Elric still there?', s.person);
  await f.elric.drain();
  assert.equal(f.adapterCalls(), 1);
  const turns = await f.turns(s.owner.operatorId);
  assert.deepEqual(
    turns.map((turn) => [turn.outcome, turn.reason]),
    [
      ['refused_inactive', 'paused'],
      ['refused_inactive', 'paused'],
    ],
  );
  // A paused Elric cannot read, even through a resumed workspace agent (a third-party
  // city_control resume only clears the workspace agent's pause, never Elric's own status).
  assert.deepEqual(await elricRoomAccess(f.db, s.elricId, s.room.id), {
    ok: false,
    code: 'paused',
  });
  // Resume through the owner console only.
  assert.equal((await f.call(s.owner.cookie, 'POST', '/api/elric/resume')).statusCode, 200);
  assert.equal((await elricRoomAccess(f.db, s.elricId, s.room.id)).ok, true);
  // A paused workspace also stops reads.
  await f.db.query(
    "UPDATE workspaces SET data=jsonb_set(data,'{paused}','true'::jsonb) WHERE operator_id=$1",
    [s.owner.operatorId],
  );
  assert.deepEqual(await elricRoomAccess(f.db, s.elricId, s.room.id), {
    ok: false,
    code: 'paused',
  });
});

test('the host removes Elric mid-task: the post is refused under the room lock and refunded', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric write the summary of it all', s.person);
  f.setProbe(async (point) => {
    if (point !== 'before_post') return;
    const res = await f.call(
      s.host.cookie,
      'POST',
      `/api/rooms/${s.room.id}/members/${s.elricId}/remove`,
      {},
    );
    assert.equal(res.statusCode, 200, res.body);
  });
  f.large.push({ text: 'A summary that must not appear.' });
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  f.setProbe(undefined);
  assert.equal(result?.outcome, 'cancelled');
  assert.ok(
    (await f.messages(s.room.id)).every((row) => !f.textOf(row).includes('must not appear')),
  );
  const usage = (await f.usage(s.owner.operatorId))!;
  assert.equal(usage.summary, 0);
  assert.equal(Number(usage.reserved_units), 0);
  assert.deepEqual(await elricRoomAccess(f.db, s.elricId, s.room.id), {
    ok: false,
    code: 'removed',
  });
});

test('room_task_create rechecks inside the create transaction: revoked just before, no task', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric create a task for the release', s.person);
  f.large.push(
    { toolCalls: [{ name: 'room_task_create', args: { room_id: s.room.id, title: 'Release' } }] },
    { text: 'never posted' },
  );
  f.setProbe(async (point) => {
    if (point === 'before_tool') await f.elric.revoke(s.owner.operatorId);
  });
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  f.setProbe(undefined);
  assert.deepEqual([result?.outcome, result?.reason], ['refused_inactive', 'revoked']);
  assert.equal((await f.db.query('SELECT 1 FROM room_tasks')).rows.length, 0);
  const turn = (await f.turns(s.owner.operatorId))[0]!;
  assert.deepEqual(
    turn.tool_calls.map((call) => [call.name, call.status]),
    [['room_task_create', 'cancelled']],
  );
  assert.equal((await f.usage(s.owner.operatorId))!.tool, 0, 'refunded');
});
