import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerRoomTasksMigration } from '../server/rooms/tasks-schema.js';
import {
  listTaskTemplates,
  roomTaskInputSchemas,
  roomTaskOutputSchemas,
  runRoomTaskTool,
} from '../server/rooms/tasks-tools.js';
import { TASK_LIMITS } from '../server/rooms/tasks-contract.js';
import { TASK_TEMPLATES, findTaskTemplate, taskTemplateBody } from '../shared/task-templates.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { fixture, mcpCall, rpcResult, type App } from './oauth-helpers.js';

registerRoomTasksMigration();

/**
 * Room task templates (docs/ROOM_TASKS.md "Templates"): the built-in catalog, the
 * `GET /api/task-templates` route, `template_id` on create (defaults the caller can override)
 * and the `city_room_task_templates` tool. Synthetic data only.
 */
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
let addressCounter = 141;

function flag(t: { after: (fn: () => void) => void }, on: boolean) {
  const saved = process.env.CITY_ROOM_TASKS;
  if (on) process.env.CITY_ROOM_TASKS = '1';
  else delete process.env.CITY_ROOM_TASKS;
  t.after(() => {
    if (saved === undefined) delete process.env.CITY_ROOM_TASKS;
    else process.env.CITY_ROOM_TASKS = saved;
  });
}

function api(app: App, cookie: string, method: 'GET' | 'POST', url: string, body?: unknown) {
  return app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

async function hostRoom(app: App, cookie: string) {
  const agent = await api(app, cookie, 'POST', '/api/agents', {
    name: 'Template host',
    capability: 'research',
    mode: 'hosted',
  });
  assert.equal(agent.statusCode, 201, agent.body);
  const room = await api(app, cookie, 'POST', '/api/rooms', {
    agent_id: agent.json().agent.id,
    name: 'Template desk',
    topic: 'Template topic',
    idempotency_key: randomUUID(),
  });
  assert.equal(room.statusCode, 201, room.body);
  return room.json().room.id as string;
}

async function workspaceKey(app: App, cookie: string) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Template workspace', idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.90`,
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().workspace_id as string;
  const claimed = await api(app, cookie, 'POST', '/api/workspaces/claim', {
    claim_token: created.json().claim_token,
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const minted = await app.inject({
    method: 'POST',
    url: '/api/workspace-keys',
    headers: { ...jsonHeaders, cookie, 'x-city-workspace': id },
    payload: JSON.stringify({ label: 'template probe', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return minted.json().workspace_key as string;
}

function tool(app: App, key: string, name: string, args: unknown) {
  return app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify(args),
  });
}

test('the catalog is valid: unique ids, frozen, sections and criteria, bodies within the cap', () => {
  assert.ok(TASK_TEMPLATES.length >= 5);
  const ids = TASK_TEMPLATES.map((template) => template.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  for (const template of TASK_TEMPLATES) {
    assert.match(template.id, /^[a-z0-9-]{1,64}$/, template.id);
    assert.match(template.version, /^\d+\.\d+\.\d+$/, template.id);
    assert.ok(template.name.trim() && template.name.length <= TASK_LIMITS.titleChars);
    assert.ok(template.purpose.trim() && !template.purpose.includes('\n'), template.id);
    assert.ok(template.title_prefix.trim(), template.id);
    assert.ok(template.sections.length >= 2, template.id);
    assert.ok(template.criteria.length >= 3, template.id);
    assert.ok(Object.isFrozen(template) && Object.isFrozen(template.criteria), template.id);
    const body = taskTemplateBody(template);
    assert.ok(body.length <= TASK_LIMITS.bodyChars, template.id);
    for (const section of template.sections) assert.ok(body.includes(`## ${section.heading}\n`));
    assert.ok(body.includes('## Acceptance criteria\n'));
    for (const item of template.criteria) assert.ok(body.includes(`- [ ] ${item}`));
    assert.equal(findTaskTemplate(template.id), template);
  }
  assert.equal(findTaskTemplate('nope'), undefined);
  const listed = listTaskTemplates();
  assert.equal(
    roomTaskOutputSchemas.city_room_task_templates.safeParse(listed).success,
    true,
    'tool output matches its schema',
  );
  assert.deepEqual(
    listed.templates.map((template) => template.id),
    ids,
  );
  assert.equal(roomTaskInputSchemas.city_room_task_templates.safeParse({ x: 1 }).success, false);
});

test('the templates input accepts and ignores room_id and agent_id (guest calls add the room)', async () => {
  const schema = roomTaskInputSchemas.city_room_task_templates;
  assert.equal(schema.safeParse({}).success, true);
  assert.equal(schema.safeParse({ room_id: 'room-from-credential' }).success, true);
  assert.equal(schema.safeParse({ room_id: randomUUID(), agent_id: randomUUID() }).success, true);
  assert.equal(schema.safeParse({ room_id: 7 }).success, false);
  const tasks = {} as Parameters<typeof runRoomTaskTool>[0];
  const principal = { operatorId: 'op', actor: 'invited AI', origin: 'http://localhost' };
  assert.deepEqual(
    await runRoomTaskTool(
      tasks,
      'city_room_task_templates',
      { room_id: 'room-from-credential', agent_id: randomUUID() },
      principal,
    ),
    listTaskTemplates(),
  );
});

test('flag off: the template route is absent', async (t) => {
  flag(t, false);
  const { app, cookie } = await fixture(t);
  const res = await api(app, cookie, 'GET', '/api/task-templates');
  assert.equal(res.statusCode, 404);
});

test('REST: list templates, create from one, override, unknown id and missing title', async (t) => {
  flag(t, true);
  const { app, cookie } = await fixture(t);
  const roomId = await hostRoom(app, cookie);

  const anonymous = await app.inject({ method: 'GET', url: '/api/task-templates' });
  assert.equal(anonymous.statusCode, 401, 'signed-in owners only');
  const listed = await api(app, cookie, 'GET', '/api/task-templates');
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json(), listTaskTemplates());

  const review = findTaskTemplate('code-review')!;
  // Defaults: the template's name and body.
  const plain = await api(app, cookie, 'POST', `/api/rooms/${roomId}/tasks`, {
    template_id: 'code-review',
    idempotency_key: randomUUID(),
  });
  assert.equal(plain.statusCode, 201, plain.body);
  assert.equal(plain.json().task.title, review.name);
  assert.equal(plain.json().task.body, taskTemplateBody(review));
  assert.deepEqual(plain.json().task.template, { id: 'code-review', version: review.version });

  // Overrides: the caller's title and body win; the template is still recorded.
  const key = randomUUID();
  const custom = {
    template_id: 'bug-triage',
    title: 'Bug triage: login loop',
    body: '## Report\nLogin redirects forever.',
    idempotency_key: key,
  };
  const overridden = await api(app, cookie, 'POST', `/api/rooms/${roomId}/tasks`, custom);
  assert.equal(overridden.statusCode, 201, overridden.body);
  assert.equal(overridden.json().task.title, custom.title);
  assert.equal(overridden.json().task.body, custom.body);
  assert.equal(overridden.json().task.template.id, 'bug-triage');
  const replay = await api(app, cookie, 'POST', `/api/rooms/${roomId}/tasks`, custom);
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(replay.json().replayed, true);
  const conflict = await api(app, cookie, 'POST', `/api/rooms/${roomId}/tasks`, {
    ...custom,
    template_id: 'test-plan',
  });
  assert.equal(conflict.statusCode, 409, 'another template under the same key conflicts');
  assert.equal(conflict.json().code, 'idempotency_conflict');

  // Without a template nothing changes: no template recorded.
  const blank = await api(app, cookie, 'POST', `/api/rooms/${roomId}/tasks`, {
    title: 'Plain task',
    idempotency_key: randomUUID(),
  });
  assert.equal(blank.statusCode, 201, blank.body);
  assert.equal(blank.json().task.template, null);
  assert.equal(blank.json().task.body, '');

  const unknown = await api(app, cookie, 'POST', `/api/rooms/${roomId}/tasks`, {
    template_id: 'no-such-template',
    idempotency_key: randomUUID(),
  });
  assert.equal(unknown.statusCode, 400, unknown.body);
  assert.equal(unknown.json().code, 'unknown_template');
  const malformed = await api(app, cookie, 'POST', `/api/rooms/${roomId}/tasks`, {
    template_id: 'Not An Id',
    idempotency_key: randomUUID(),
  });
  assert.equal(malformed.statusCode, 400, malformed.body);
  const untitled = await api(app, cookie, 'POST', `/api/rooms/${roomId}/tasks`, {
    idempotency_key: randomUUID(),
  });
  assert.equal(untitled.statusCode, 400, untitled.body);
  assert.equal(untitled.json().code, 'title_required');

  const tasks = await api(app, cookie, 'GET', `/api/rooms/${roomId}/tasks`);
  assert.equal(tasks.json().tasks.length, 3, 'refused creates stored nothing');
});

test('MCP: the templates tool lists the catalog and create takes template_id', async (t) => {
  flag(t, true);
  const { app, cookie } = await fixture(t);
  const roomId = await hostRoom(app, cookie);
  const key = await workspaceKey(app, cookie);

  const listed = await tool(app, key, 'city_room_task_templates', {});
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json(), listTaskTemplates());

  const toolsRes = await mcpCall(app, key, 'tools/list', {});
  const tools = rpcResult(toolsRes.body).result.tools as {
    name: string;
    annotations: { readOnlyHint: boolean };
    inputSchema: { properties: Record<string, unknown>; required?: string[] };
  }[];
  const entry = tools.find((item) => item.name === 'city_room_task_templates');
  assert.ok(entry, 'tools/list includes the templates tool');
  assert.equal(entry.annotations.readOnlyHint, true);
  const create = tools.find((item) => item.name === 'city_room_task_create')!;
  assert.ok(create.inputSchema.properties.template_id, 'create takes template_id');
  assert.ok(!(create.inputSchema.required ?? []).includes('title'), 'title is optional');

  const called = await mcpCall(app, key, 'tools/call', {
    name: 'city_room_task_templates',
    arguments: {},
  });
  const result = rpcResult(called.body).result as { structuredContent: unknown };
  assert.deepEqual(result.structuredContent, listTaskTemplates());

  // An AI creates its own room and a task from a template.
  const agent = await tool(app, key, 'city_create_agent', {
    name: 'Template AI',
    description: 'Synthetic template member',
    capability: 'research',
    mode: 'external',
    idempotencyKey: randomUUID(),
  });
  assert.equal(agent.statusCode, 200, agent.body);
  const room = await tool(app, key, 'city_create_room', {
    agent_id: agent.json().agent.id,
    name: 'Template AI desk',
    topic: 'Template AI topic',
    idempotency_key: randomUUID(),
  });
  assert.equal(room.statusCode, 200, room.body);
  const aiRoom = room.json().room.id as string;
  const created = await mcpCall(app, key, 'tools/call', {
    name: 'city_room_task_create',
    arguments: {
      room_id: aiRoom,
      template_id: 'research-question',
      title: 'Research: which formats do readers prefer?',
      idempotency_key: randomUUID(),
    },
  });
  const task = (rpcResult(created.body).result as { structuredContent: any }).structuredContent
    .task;
  assert.equal(task.title, 'Research: which formats do readers prefer?');
  assert.equal(task.body, taskTemplateBody(findTaskTemplate('research-question')!));
  assert.equal(task.template.id, 'research-question');

  const refused = await tool(app, key, 'city_room_task_create', {
    room_id: aiRoom,
    template_id: 'nope-nope',
    idempotency_key: randomUUID(),
  });
  assert.equal(refused.statusCode, 400, refused.body);
  assert.equal(refused.json().code, 'unknown_template');
  assert.ok(roomId);
});
