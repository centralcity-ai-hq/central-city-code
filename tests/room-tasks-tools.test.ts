import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createRoomTasks } from '../server/rooms/tasks-service.js';
import { registerRoomTasksMigration } from '../server/rooms/tasks-schema.js';
import {
  ROOM_TASK_TOOLS,
  ROOM_TASK_TOOL_SCOPES,
  roomTaskAnnotations,
  roomTaskDescriptions,
  roomTaskInputSchemas,
  roomTaskOutputSchemas,
  roomTasksEnabled,
  runRoomTaskTool,
  type RoomTaskToolName,
} from '../server/rooms/tasks-tools.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import type { RoomLimits } from '../server/rooms/contract.js';

registerRoomTasksMigration();

/**
 * Room task tools module (docs/ROOM_TASKS.md "MCP tools"):
 * the fifteen city_room_task_* names each carry input, output, description,
 * annotation and scope; runRoomTaskTool dispatches to the real service.
 * Synthetic data only.
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
let addressCounter = 501;
/** An AI-owned workspace with a full-scope key (mirrors tests/room-tasks.test.ts). */
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
    payload: JSON.stringify({ label: 'task tools tester', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return { id, key: minted.json().workspace_key as string };
}
async function agent(app: App, key: string, name: string) {
  const body = await ok(app, key, 'city_create_agent', {
    name,
    description: 'Synthetic task tools member',
    capability: 'research',
    mode: 'external',
    idempotencyKey: randomUUID(),
  });
  return body.agent.id as string;
}
async function createRoom(app: App, key: string, agentId: string) {
  return ok(app, key, 'city_create_room', {
    agent_id: agentId,
    name: 'Synthetic task tools desk',
    topic: 'Task tools test topic',
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
function tasksOf(app: App) {
  return createRoomTasks({
    db: app.city.db,
    clock: () => Date.now(),
    limit: async () => {},
    secret: 'test-rooms-secret',
  });
}
async function roomFixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await fixture(t);
  const tasks = tasksOf(app);
  const a = await owner(app, 'Task tools host workspace');
  const b = await owner(app, 'Task tools member workspace');
  const host = await agent(app, a.key, 'Task tools host');
  const member = await agent(app, b.key, 'Task tools member');
  const created = await createRoom(app, a.key, host);
  await joinRoom(app, b.key, created.link.link, member);
  return { app, tasks, a, b, host, member, roomId: created.room.id as string };
}

test('every tool has input, output, description, annotation and scope', async () => {
  assert.deepEqual(
    [...ROOM_TASK_TOOLS],
    [
      'city_room_task_create',
      'city_room_task_claim',
      'city_room_task_renew',
      'city_room_task_release',
      'city_room_task_result',
      'city_room_task_review',
      'city_room_task_request_review',
      'city_room_task_peer_review',
      'city_room_task_list',
      'city_room_task_get',
      'city_room_task_events',
      'city_room_task_templates',
      'city_room_task_comment_add',
      'city_room_task_comment_list',
      'city_room_task_comment_delete',
    ],
  );
  for (const name of ROOM_TASK_TOOLS) {
    assert.ok(roomTaskInputSchemas[name], `${name}: input schema`);
    assert.ok(roomTaskOutputSchemas[name], `${name}: output schema`);
    assert.ok(
      roomTaskDescriptions[name]?.title && roomTaskDescriptions[name]?.description,
      `${name}: description`,
    );
    assert.ok(roomTaskAnnotations[name], `${name}: annotation`);
    assert.equal(ROOM_TASK_TOOL_SCOPES[name], 'rooms:join', `${name}: scope`);
  }
  assert.equal(Object.keys(roomTaskInputSchemas).length, 15);
  assert.equal(Object.keys(roomTaskOutputSchemas).length, 15);
  assert.equal(Object.keys(roomTaskDescriptions).length, 15);
  assert.equal(Object.keys(roomTaskAnnotations).length, 15);
  assert.equal(Object.keys(ROOM_TASK_TOOL_SCOPES).length, 15);
});

test('annotations match the contract table', async () => {
  const expected: Record<
    RoomTaskToolName,
    { read: boolean; dest: boolean; idem: boolean; open: boolean }
  > = {
    city_room_task_create: { read: false, dest: false, idem: true, open: true },
    city_room_task_claim: { read: false, dest: false, idem: false, open: true },
    city_room_task_renew: { read: false, dest: false, idem: false, open: true },
    city_room_task_release: { read: false, dest: true, idem: false, open: true },
    city_room_task_result: { read: false, dest: true, idem: false, open: true },
    city_room_task_review: { read: false, dest: true, idem: false, open: true },
    city_room_task_request_review: { read: false, dest: true, idem: true, open: true },
    city_room_task_peer_review: { read: false, dest: false, idem: false, open: true },
    city_room_task_list: { read: true, dest: false, idem: true, open: false },
    city_room_task_get: { read: true, dest: false, idem: true, open: false },
    city_room_task_events: { read: true, dest: false, idem: true, open: false },
    city_room_task_templates: { read: true, dest: false, idem: true, open: false },
    city_room_task_comment_add: { read: false, dest: false, idem: false, open: true },
    city_room_task_comment_list: { read: true, dest: false, idem: true, open: false },
    city_room_task_comment_delete: { read: false, dest: true, idem: true, open: true },
  };
  for (const name of ROOM_TASK_TOOLS) {
    const seen = roomTaskAnnotations[name]!;
    const want = expected[name];
    assert.deepEqual(
      {
        readOnlyHint: seen.readOnlyHint,
        destructiveHint: seen.destructiveHint,
        idempotentHint: seen.idempotentHint,
        openWorldHint: seen.openWorldHint,
      },
      {
        readOnlyHint: want.read,
        destructiveHint: want.dest,
        idempotentHint: want.idem,
        openWorldHint: want.open,
      },
      name,
    );
  }
});

test('descriptions carry no behavioural phrases', async () => {
  const banned = /before|always|at session start|call city_/i;
  for (const name of ROOM_TASK_TOOLS) {
    const { title, description } = roomTaskDescriptions[name]!;
    assert.ok(title.length > 0, `${name}: title`);
    assert.doesNotMatch(description, banned, `${name}: description`);
  }
});

test('runRoomTaskTool round-trips create -> claim -> result -> review on the real service', async (t) => {
  const { tasks, a, host, roomId } = await roomFixture(t);
  const principal = p(a.id);

  const created = (await runRoomTaskTool(
    tasks,
    'city_room_task_create',
    {
      room_id: roomId,
      title: 'Wire me up',
      body: 'Steps:\n\n1. Create\n2. Claim',
      idempotency_key: randomUUID(),
    },
    principal,
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_create.safeParse(created).success, true);
  assert.equal(created.replayed, false);
  assert.equal(created.task.number, 1);
  assert.equal(created.task.status, 'open');
  const taskId = created.task.id as string;

  const claimed = (await runRoomTaskTool(
    tasks,
    'city_room_task_claim',
    {
      room_id: roomId,
      task_id: taskId,
      agent_id: host,
      idempotency_key: randomUUID(),
    },
    principal,
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_claim.safeParse(claimed).success, true);
  assert.match(claimed.claim_token, /^ccclaim_[A-Za-z0-9_-]{22}$/);
  assert.equal(claimed.task.status, 'claimed');

  const listed = (await runRoomTaskTool(
    tasks,
    'city_room_task_list',
    {
      room_id: roomId,
    },
    principal,
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_list.safeParse(listed).success, true);
  assert.equal(listed.tasks.length, 1);

  const fetched = (await runRoomTaskTool(
    tasks,
    'city_room_task_get',
    {
      room_id: roomId,
      task_id: taskId,
    },
    principal,
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_get.safeParse(fetched).success, true);
  assert.equal(fetched.task.claim?.agent_id, host);
  assert.equal(fetched.task.submitted_by, null);

  const posted = (await runRoomTaskTool(
    tasks,
    'city_room_task_result',
    {
      room_id: roomId,
      task_id: taskId,
      claim_token: claimed.claim_token,
      evidence: { kind: 'proposal', ref: 'proposal-7', revision: 'rev-3' },
    },
    principal,
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_result.safeParse(posted).success, true);
  assert.equal(posted.task.status, 'in_review');
  assert.deepEqual(posted.task.result, { kind: 'proposal', ref: 'proposal-7', revision: 'rev-3' });
  // The hand-in keeps who did the work, in the tool output, after the claim is cleared.
  assert.equal(posted.task.claim, null);
  assert.equal(posted.task.submitted_by, host);

  const reviewed = (await runRoomTaskTool(
    tasks,
    'city_room_task_review',
    {
      room_id: roomId,
      task_id: taskId,
      decision: 'approve',
    },
    principal,
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_review.safeParse(reviewed).success, true);
  assert.equal(reviewed.decision, 'approve');
  assert.equal(reviewed.applied, true);
  assert.equal(reviewed.task.status, 'done');
  assert.equal(reviewed.task.submitted_by, host);
  const done = (await runRoomTaskTool(
    tasks,
    'city_room_task_list',
    { room_id: roomId, status: 'done' },
    principal,
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_list.safeParse(done).success, true);
  assert.equal(done.tasks[0].submitted_by, host);

  const events = (await runRoomTaskTool(
    tasks,
    'city_room_task_events',
    {
      room_id: roomId,
      task_id: taskId,
    },
    principal,
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_events.safeParse(events).success, true);
  assert.deepEqual(
    events.events.map((e: { action: string }) => e.action),
    ['created', 'claimed', 'result_posted', 'approved'],
  );
});

test('runRoomTaskTool covers renew and release outputs', async (t) => {
  const { tasks, a, host, roomId } = await roomFixture(t);
  const principal = p(a.id);
  const created = (await runRoomTaskTool(
    tasks,
    'city_room_task_create',
    {
      room_id: roomId,
      title: 'Renew me',
      idempotency_key: randomUUID(),
    },
    principal,
  )) as any;
  const claimed = (await runRoomTaskTool(
    tasks,
    'city_room_task_claim',
    {
      room_id: roomId,
      task_id: created.task.id,
      agent_id: host,
      idempotency_key: randomUUID(),
    },
    principal,
  )) as any;
  const renewed = (await runRoomTaskTool(
    tasks,
    'city_room_task_renew',
    {
      room_id: roomId,
      task_id: created.task.id,
      claim_token: claimed.claim_token,
    },
    principal,
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_renew.safeParse(renewed).success, true);
  assert.ok(!('claim_token' in renewed), 'renew never returns a token');
  const released = (await runRoomTaskTool(
    tasks,
    'city_room_task_release',
    {
      room_id: roomId,
      task_id: created.task.id,
      claim_token: claimed.claim_token,
    },
    principal,
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_release.safeParse(released).success, true);
  assert.equal(released.released, true);
  assert.equal(released.task.status, 'open');
});

test('roomTasksEnabled is false by default, true only for CITY_ROOM_TASKS=1', async () => {
  assert.equal(roomTasksEnabled({}), false);
  assert.equal(roomTasksEnabled({ CITY_ROOM_TASKS: undefined }), false);
  assert.equal(roomTasksEnabled({ CITY_ROOM_TASKS: '' }), false);
  assert.equal(roomTasksEnabled({ CITY_ROOM_TASKS: '0' }), false);
  assert.equal(roomTasksEnabled({ CITY_ROOM_TASKS: 'true' }), false);
  assert.equal(roomTasksEnabled({ CITY_ROOM_TASKS: '1' }), true);
  const saved = process.env.CITY_ROOM_TASKS;
  delete process.env.CITY_ROOM_TASKS;
  try {
    assert.equal(roomTasksEnabled(), false);
  } finally {
    if (saved !== undefined) process.env.CITY_ROOM_TASKS = saved;
  }
});
