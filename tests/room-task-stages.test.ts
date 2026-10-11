import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createRoomTasks } from '../server/rooms/tasks-service.js';
import { registerRoomTasksMigration } from '../server/rooms/tasks-schema.js';
import { roomTaskOutputSchemas, runRoomTaskTool } from '../server/rooms/tasks-tools.js';
import { taskUpdateInput, taskListInput } from '../server/rooms/tasks-contract.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import type { RoomLimits } from '../server/rooms/contract.js';

registerRoomTasksMigration();

/**
 * Optional task stages (migration 54, docs/ROOM_TASKS.md "Stages"): the host sets a room's stage
 * list, the host or the claim holder's owner moves a task between stages, every move is recorded
 * in the task event log, and rooms without stages are unaffected. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

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
  return res.json() as any;
}
let addressCounter = 141;
/** An AI-owned workspace with a full-scope key (mirrors tests/rooms.test.ts). */
async function owner(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.20`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
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
    payload: JSON.stringify({ label: 'task tester', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return { id, cookie, key: minted.json().workspace_key as string };
}
async function agent(app: App, key: string, name: string) {
  const body = await ok(app, key, 'city_create_agent', {
    name,
    description: 'Synthetic task member',
    capability: 'research',
    mode: 'external',
    idempotencyKey: randomUUID(),
  });
  return body.agent.id as string;
}
async function createRoom(app: App, key: string, agentId: string) {
  return ok(app, key, 'city_create_room', {
    agent_id: agentId,
    name: 'Synthetic task desk',
    topic: 'Task test topic',
    idempotency_key: randomUUID(),
  });
}
async function joinRoom(app: App, key: string, link: string, agentId: string) {
  const res = await call(app, key, 'city_join_room', {
    link,
    agent_id: agentId,
    idempotency_key: randomUUID(),
  });
  assert.equal(res.statusCode, 200, res.body);
}
const p = (operatorId: string) => ({
  operatorId,
  actor: 'the test owner',
  origin: 'http://localhost',
});
function tasksOf(app: App, charges: string[]) {
  return createRoomTasks({
    db: app.city.db,
    clock: () => Date.now(),
    limit: async (key: string) => {
      charges.push(key);
    },
    secret: 'test-rooms-secret',
  });
}
async function roomFixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await fixture(t);
  const charges: string[] = [];
  const tasks = tasksOf(app, charges);
  const a = await owner(app, 'Task host workspace');
  const b = await owner(app, 'Task member workspace');
  const host = await agent(app, a.key, 'Task host');
  const member = await agent(app, b.key, 'Task member');
  const created = await createRoom(app, a.key, host);
  await joinRoom(app, b.key, created.link.link, member);
  return { app, charges, tasks, a, b, host, member, roomId: created.room.id as string };
}
async function failsCode(
  run: Promise<unknown>,
  code: string,
): Promise<{ statusCode?: number; errorCode?: string; details?: any; message?: string }> {
  try {
    await run;
  } catch (error) {
    const err = error as {
      statusCode?: number;
      errorCode?: string;
      details?: any;
      message?: string;
    };
    assert.equal(err?.errorCode, code, `expected ${code}, got ${String(err)}`);
    return err;
  }
  assert.fail(`expected failure ${code}`);
}

async function made(
  tasks: ReturnType<typeof tasksOf>,
  operatorId: string,
  roomId: string,
  title = 'Stage me',
) {
  return (
    await tasks.create(p(operatorId), { room_id: roomId, title, idempotency_key: randomUUID() })
  ).task;
}

test('rooms without stages are unaffected: no stage, empty list, stage moves refused', async (t) => {
  const { tasks, a, roomId } = await roomFixture(t);
  const task = await made(tasks, a.id, roomId);
  assert.equal(task.stage, null);
  assert.equal(task.status, 'open');
  const listed = await tasks.list(p(a.id), { room_id: roomId });
  assert.deepEqual(listed.stages, []);
  assert.equal(listed.tasks[0]!.stage, null);
  assert.deepEqual(await tasks.stages(p(a.id), { room_id: roomId }), {
    room_id: roomId,
    stages: [],
  });
  const refused = await failsCode(
    tasks.update(p(a.id), { room_id: roomId, task_id: task.id, stage: 'Building' }),
    'unknown_stage',
  );
  assert.equal(refused.statusCode, 400);
  assert.deepEqual(refused.details, { stages: [] });
  assert.match(refused.message ?? '', /no stages/);
  await failsCode(tasks.list(p(a.id), { room_id: roomId, stage: 'Building' }), 'unknown_stage');
  // The decision path is unchanged.
  const cancelled = await tasks.update(p(a.id), {
    room_id: roomId,
    task_id: task.id,
    decision: 'cancel',
  });
  assert.equal(cancelled.decision, 'cancel');
  assert.equal(cancelled.task.status, 'cancelled');
  const events = await tasks.events(p(a.id), { room_id: roomId, task_id: task.id });
  assert.deepEqual(
    events.events.map((event) => event.action),
    ['created', 'cancelled'],
  );
});

test('only the host sets the stage list; names are validated', async (t) => {
  const { tasks, a, b, roomId } = await roomFixture(t);
  await failsCode(
    tasks.setStages(p(b.id), { room_id: roomId, stages: ['Building'] }),
    'host_required',
  );
  await failsCode(
    tasks.setStages(p(a.id), { room_id: roomId, stages: ['Building', 'building'] }),
    'duplicate_stage',
  );
  await assert.rejects(
    tasks.setStages(p(a.id), {
      room_id: roomId,
      stages: Array.from({ length: 9 }, (_, i) => `S${i}`),
    }),
  );
  await assert.rejects(tasks.setStages(p(a.id), { room_id: roomId, stages: ['x'.repeat(25)] }));
  await assert.rejects(tasks.setStages(p(a.id), { room_id: roomId, stages: ['  '] }));
  const saved = await tasks.setStages(p(a.id), {
    room_id: roomId,
    stages: [" Spec'd ", 'Building', 'Testing', 'Shipped'],
  });
  assert.deepEqual(saved.stages, ["Spec'd", 'Building', 'Testing', 'Shipped']);
  // Members read the list.
  assert.deepEqual((await tasks.stages(p(b.id), { room_id: roomId })).stages, saved.stages);
  assert.deepEqual((await tasks.list(p(b.id), { room_id: roomId })).stages, saved.stages);
});

test('stage moves: host and claim holder only; status unchanged; history recorded', async (t) => {
  const { app, tasks, a, b, member, roomId } = await roomFixture(t);
  const c = await owner(app, 'Task bystander workspace');
  await tasks.setStages(p(a.id), { room_id: roomId, stages: ['Building', 'Testing', 'Shipped'] });
  const task = await made(tasks, a.id, roomId);
  // A member who does not hold the claim cannot move it.
  const notYet = await failsCode(
    tasks.update(p(b.id), { room_id: roomId, task_id: task.id, stage: 'Building' }),
    'stage_not_allowed',
  );
  assert.equal(notYet.statusCode, 403);
  // The host can, on any task; matching ignores case and stores the room's spelling.
  const hosted = await tasks.update(p(a.id), {
    room_id: roomId,
    task_id: task.id,
    stage: 'building',
  });
  assert.equal(hosted.applied, true);
  assert.equal(hosted.decision, undefined);
  assert.equal(hosted.task.stage, 'Building');
  assert.equal(hosted.task.status, 'open');
  // The same stage again is a no-op without an event.
  const again = await tasks.update(p(a.id), {
    room_id: roomId,
    task_id: task.id,
    stage: 'Building',
  });
  assert.equal(again.applied, false);
  // The member claims; now the holder's owner may move it.
  const claimed = await tasks.claim(p(b.id), {
    room_id: roomId,
    task_id: task.id,
    agent_id: member,
    idempotency_key: randomUUID(),
  });
  const moved = await tasks.update(p(b.id), {
    room_id: roomId,
    task_id: task.id,
    stage: 'Testing',
  });
  assert.equal(moved.task.stage, 'Testing');
  assert.equal(moved.task.status, 'claimed');
  assert.equal(moved.task.claim?.agent_id, member);
  // Unknown stages are refused with the room's list.
  const unknown = await failsCode(
    tasks.update(p(b.id), { room_id: roomId, task_id: task.id, stage: 'Deployed' }),
    'unknown_stage',
  );
  assert.deepEqual(unknown.details, { stages: ['Building', 'Testing', 'Shipped'] });
  // Someone outside the room still gets the uniform 404.
  await failsCode(
    tasks.update(p(c.id), { room_id: roomId, task_id: task.id, stage: 'Testing' }),
    'room_not_found',
  );
  // Decision and stage together are refused; so is neither.
  await failsCode(
    tasks.update(p(a.id), {
      room_id: roomId,
      task_id: task.id,
      decision: 'cancel',
      stage: 'Shipped',
    }),
    'invalid_request',
  );
  await failsCode(tasks.update(p(a.id), { room_id: roomId, task_id: task.id }), 'invalid_request');
  // After release the member no longer holds it.
  await tasks.release(p(b.id), {
    room_id: roomId,
    task_id: task.id,
    claim_token: claimed.claim_token,
  });
  await failsCode(
    tasks.update(p(b.id), { room_id: roomId, task_id: task.id, stage: 'Shipped' }),
    'stage_not_allowed',
  );
  // The host clears the stage with null.
  const cleared = await tasks.update(p(a.id), { room_id: roomId, task_id: task.id, stage: null });
  assert.equal(cleared.task.stage, null);
  const events = (await tasks.events(p(a.id), { room_id: roomId, task_id: task.id })).events;
  const stageEvents = events.filter((event) => event.action === 'stage_changed');
  assert.deepEqual(
    stageEvents.map((event) => [event.actor, event.agent_id, event.details]),
    [
      ['the test owner', null, { from: null, to: 'Building' }],
      ['the test owner', member, { from: 'Building', to: 'Testing' }],
      ['the test owner', null, { from: 'Testing', to: null }],
    ],
  );
  for (const event of stageEvents) assert.ok(Date.parse(event.created_at) > 0);
  // List filters by stage.
  await tasks.update(p(a.id), { room_id: roomId, task_id: task.id, stage: 'Shipped' });
  await made(tasks, a.id, roomId, 'No stage');
  const shipped = await tasks.list(p(a.id), { room_id: roomId, stage: 'shipped' });
  assert.deepEqual(
    shipped.tasks.map((item) => item.id),
    [task.id],
  );
});

test('removing a stage clears it from tasks with an event; closed rooms are read-only', async (t) => {
  const { app, tasks, a, roomId } = await roomFixture(t);
  await tasks.setStages(p(a.id), { room_id: roomId, stages: ['Building', 'Testing'] });
  const one = await made(tasks, a.id, roomId, 'One');
  const two = await made(tasks, a.id, roomId, 'Two');
  await tasks.update(p(a.id), { room_id: roomId, task_id: one.id, stage: 'Building' });
  await tasks.update(p(a.id), { room_id: roomId, task_id: two.id, stage: 'Testing' });
  const saved = await tasks.setStages(p(a.id), { room_id: roomId, stages: ['Testing'] });
  assert.equal(saved.cleared, 1);
  const listed = await tasks.list(p(a.id), { room_id: roomId });
  assert.deepEqual(
    listed.tasks.map((item) => item.stage),
    [null, 'Testing'],
  );
  const last = (await tasks.events(p(a.id), { room_id: roomId, task_id: one.id })).events.at(-1)!;
  assert.equal(last.action, 'stage_changed');
  assert.deepEqual(last.details, { from: 'Building', to: null, reason: 'stage_removed' });
  // Turning stages off clears the rest.
  assert.equal((await tasks.setStages(p(a.id), { room_id: roomId, stages: [] })).cleared, 1);
  await app.city.db.query('UPDATE rooms SET closed_at=$2 WHERE id=$1', [roomId, Date.now()]);
  await failsCode(tasks.setStages(p(a.id), { room_id: roomId, stages: ['Again'] }), 'room_closed');
  await failsCode(
    tasks.update(p(a.id), { room_id: roomId, task_id: one.id, stage: 'Testing' }),
    'room_closed',
  );
});

test('MCP: stage on the review and list tools, additive schemas', async (t) => {
  const { tasks, a, b, member, roomId } = await roomFixture(t);
  // Existing calls still parse unchanged; stage is optional on both inputs.
  assert.equal(
    taskUpdateInput.safeParse({ room_id: roomId, task_id: randomUUID(), decision: 'approve' })
      .success,
    true,
  );
  assert.equal(taskListInput.safeParse({ room_id: roomId }).success, true);
  await tasks.setStages(p(a.id), { room_id: roomId, stages: ['Building', 'Shipped'] });
  const task = await made(tasks, a.id, roomId);
  const claimed = (await runRoomTaskTool(
    tasks,
    'city_room_task_claim',
    { room_id: roomId, task_id: task.id, agent_id: member, idempotency_key: randomUUID() },
    p(b.id),
  )) as any;
  assert.equal(claimed.task.status, 'claimed');
  const moved = (await runRoomTaskTool(
    tasks,
    'city_room_task_review',
    { room_id: roomId, task_id: task.id, stage: 'Shipped' },
    p(b.id),
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_review.safeParse(moved).success, true);
  assert.equal(moved.task.stage, 'Shipped');
  assert.equal(moved.applied, true);
  const listed = (await runRoomTaskTool(
    tasks,
    'city_room_task_list',
    { room_id: roomId, stage: 'Shipped' },
    p(b.id),
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_list.safeParse(listed).success, true);
  assert.deepEqual(listed.stages, ['Building', 'Shipped']);
  assert.equal(listed.tasks.length, 1);
  await failsCode(
    runRoomTaskTool(
      tasks,
      'city_room_task_review',
      { room_id: roomId, task_id: task.id, stage: 'Nope' },
      p(b.id),
    ),
    'unknown_stage',
  );
  const events = (await runRoomTaskTool(
    tasks,
    'city_room_task_events',
    { room_id: roomId, task_id: task.id },
    p(a.id),
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_events.safeParse(events).success, true);
  assert.equal(events.events.at(-1).action, 'stage_changed');
});

test('REST and the assistant tool endpoint: task-stages routes and stage moves', async (t) => {
  const saved = process.env.CITY_ROOM_TASKS;
  process.env.CITY_ROOM_TASKS = '1';
  t.after(() => {
    if (saved === undefined) delete process.env.CITY_ROOM_TASKS;
    else process.env.CITY_ROOM_TASKS = saved;
  });
  const { app, a, b, roomId } = await roomFixture(t);
  const rest = (
    who: { id: string; cookie: string },
    method: 'GET' | 'PUT' | 'POST',
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { ...jsonHeaders, cookie: who.cookie, 'x-city-workspace': who.id },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  const empty = await rest(a, 'GET', `/api/rooms/${roomId}/task-stages`);
  assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(empty.json().stages, []);
  const denied = await rest(b, 'PUT', `/api/rooms/${roomId}/task-stages`, { stages: ['Building'] });
  assert.equal(denied.statusCode, 403, denied.body);
  const put = await rest(a, 'PUT', `/api/rooms/${roomId}/task-stages`, {
    stages: ['Building', 'Shipped'],
  });
  assert.equal(put.statusCode, 200, put.body);
  const created = await ok(app, a.key, 'city_room_task_create', {
    room_id: roomId,
    title: 'Over the wire',
    idempotency_key: randomUUID(),
  });
  const moved = await ok(app, a.key, 'city_room_task_review', {
    room_id: roomId,
    task_id: created.task.id,
    stage: 'Building',
  });
  assert.equal(moved.task.stage, 'Building');
  const bad = await call(app, a.key, 'city_room_task_review', {
    room_id: roomId,
    task_id: created.task.id,
    stage: 'Nope',
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.match(bad.body, /unknown_stage/);
  const viaRest = await rest(a, 'POST', `/api/rooms/${roomId}/tasks/${created.task.id}/update`, {
    stage: 'Shipped',
  });
  assert.equal(viaRest.statusCode, 200, viaRest.body);
  const listed = await rest(a, 'GET', `/api/rooms/${roomId}/tasks?stage=Shipped`);
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().tasks.length, 1);
  assert.deepEqual(listed.json().stages, ['Building', 'Shipped']);
});

test('a case-only rename keeps the stage on its tasks, spelled the new way', async (t) => {
  const { tasks, a, roomId } = await roomFixture(t);
  await tasks.setStages(p(a.id), { room_id: roomId, stages: ['testing', 'Shipped'] });
  const task = await made(tasks, a.id, roomId);
  await tasks.update(p(a.id), { room_id: roomId, task_id: task.id, stage: 'testing' });
  const saved = await tasks.setStages(p(a.id), { room_id: roomId, stages: ['Testing', 'Shipped'] });
  assert.equal(saved.cleared, 0);
  const fetched = await tasks.get(p(a.id), { room_id: roomId, task_id: task.id });
  assert.equal(fetched.task.stage, 'Testing');
  const actions = (await tasks.events(p(a.id), { room_id: roomId, task_id: task.id })).events
    .filter((event) => event.action === 'stage_changed')
    .map((event) => event.details);
  assert.deepEqual(actions, [{ from: null, to: 'testing' }]);
});
