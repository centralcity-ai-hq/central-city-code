import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerRoomTasksMigration } from '../server/rooms/tasks-schema.js';
import { createRoomToolInput } from '../server/rooms/contract.js';
import { TASK_LIMITS } from '../server/rooms/tasks-contract.js';
import { remoteOutputSchemas } from '../server/remote-mcp/tools.js';
import {
  BLANK_ROOM_TEMPLATE_ID,
  ROOM_TEMPLATES,
  findRoomTemplate,
  inviteSummary,
  roomTemplateView,
  starterTaskInput,
} from '../shared/room-templates.js';
import { findTaskTemplate, taskTemplateBody } from '../shared/task-templates.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { fixture, mcpCall, rpcResult, type App } from './oauth-helpers.js';

registerRoomTasksMigration();

/**
 * Room templates (docs/ROOMS.md "Room templates"): the built-in catalog, `room_template_id` on
 * create (defaults the caller can override, never a task, an agent or an invite), `GET /api/room-templates` and the `city_list_room_templates` tool.
 * Synthetic data only.
 */
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
let addressCounter = 171;

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

async function hostAgent(app: App, cookie: string) {
  const agent = await api(app, cookie, 'POST', '/api/agents', {
    name: 'Template host',
    capability: 'research',
    mode: 'hosted',
  });
  assert.equal(agent.statusCode, 201, agent.body);
  return agent.json().agent.id as string;
}

async function agentCount(app: App, cookie: string) {
  return ((await api(app, cookie, 'GET', '/api/snapshot')).json().agents as unknown[]).length;
}

async function workspaceKey(app: App, cookie: string) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Room template workspace', idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.91`,
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
    payload: JSON.stringify({ label: 'room template probe', scopes: [...ASSISTANT_SCOPES] }),
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

test('the catalog is valid: unique ids, frozen, names, task templates and invites', () => {
  assert.ok(ROOM_TEMPLATES.length >= 5);
  const ids = ROOM_TEMPLATES.map((template) => template.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  assert.ok(ids.includes(BLANK_ROOM_TEMPLATE_ID));
  for (const template of ROOM_TEMPLATES) {
    assert.match(template.id, /^[a-z0-9-]{1,64}$/, template.id);
    assert.match(template.version, /^\d+\.\d+\.\d+$/, template.id);
    assert.ok(template.name.trim() && template.name.length <= 80, template.id);
    assert.ok(template.purpose.trim() && !template.purpose.includes('\n'), template.id);
    assert.ok(template.topic.length <= 280 && !template.topic.includes('\n'), template.id);
    assert.ok(Object.isFrozen(template) && Object.isFrozen(template.invites), template.id);
    // The defaults pass the create contract.
    if (template.id !== BLANK_ROOM_TEMPLATE_ID)
      assert.equal(
        createRoomToolInput.safeParse({
          agent_id: randomUUID(),
          name: template.room_name,
          topic: template.topic,
          room_template_id: template.id,
          idempotency_key: randomUUID(),
        }).success,
        true,
        template.id,
      );
    for (const task of template.starter_tasks) {
      assert.ok(task.title.trim() && task.title.length <= TASK_LIMITS.titleChars, task.title);
      assert.ok(!!task.task_template_id !== (task.body !== undefined), 'a template or a body');
      const input = starterTaskInput(task);
      assert.ok(input.body.trim() && input.body.length <= TASK_LIMITS.bodyChars, task.title);
      if (task.task_template_id) {
        const source = findTaskTemplate(task.task_template_id);
        assert.ok(source, `${template.id}: task template ${task.task_template_id} exists`);
        assert.deepEqual(input.template, { id: source.id, version: source.version });
        assert.equal(input.body, taskTemplateBody(source));
      } else assert.equal(input.template, null);
    }
    for (const invite of template.invites) {
      assert.ok(invite.kind === 'ai' || invite.kind === 'person', template.id);
      assert.ok(invite.label.trim() && invite.reason.trim(), template.id);
    }
    assert.equal(findRoomTemplate(template.id), template);
  }
  const blank = findRoomTemplate(BLANK_ROOM_TEMPLATE_ID)!;
  assert.equal(blank.room_name, '');
  assert.deepEqual([blank.starter_tasks.length, blank.invites.length], [0, 0]);
  for (const template of ROOM_TEMPLATES.filter((item) => item.id !== BLANK_ROOM_TEMPLATE_ID)) {
    assert.ok(template.room_name.trim(), template.id);
    assert.ok(template.starter_tasks.length >= 2, template.id);
    assert.ok(template.invites.some((invite) => invite.kind === 'ai'));
    assert.ok(template.invites.some((invite) => invite.kind === 'person'));
  }
  assert.equal(findRoomTemplate('nope'), undefined);
  assert.equal(
    inviteSummary(findRoomTemplate('code-review-crew')!.invites),
    'a coding AI, a reviewer AI and a person',
  );
  assert.equal(inviteSummary([]), '');
});

test('tasks on: a templated room gets its name, topic and suggestions, but no tasks and no agents', async (t) => {
  flag(t, true);
  const { app, cookie } = await fixture(t);
  const agentId = await hostAgent(app, cookie);
  const agentsBefore = await agentCount(app, cookie);
  const template = findRoomTemplate('product-team')!;

  const listed = await api(app, cookie, 'GET', '/api/room-templates');
  assert.equal(listed.json().starter_tasks, false, 'templates never create tasks');

  const created = await api(app, cookie, 'POST', '/api/rooms', {
    agent_id: agentId,
    room_template_id: 'product-team',
    idempotency_key: randomUUID(),
  });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json();
  assert.equal(body.room.name, template.room_name);
  assert.equal(body.room.topic, template.topic);
  assert.deepEqual(body.room.template, { id: 'product-team', version: template.version });
  // The host agent and the creator as a person (in its room from creation): nobody else.
  assert.equal(body.room.member_count, 2, 'nobody else was added');
  assert.equal(body.room.latest_seq, 0, 'no task lines in the thread');
  assert.equal(body.template.id, 'product-team');
  assert.deepEqual(body.template.starter_tasks, []);
  assert.deepEqual(body.template.invite_suggestions, template.invites);
  assert.match(body.next_actions[0], /suggests inviting a coding AI, a reviewer AI and a person/);
  assert.match(body.next_actions[0], /Nobody was invited/);
  assert.equal(await agentCount(app, cookie), agentsBefore, 'no agent was created');

  // A new room starts with no tasks; the first one the host adds is #1.
  const roomId = body.room.id as string;
  const tasks = (await api(app, cookie, 'GET', `/api/rooms/${roomId}/tasks`)).json().tasks;
  assert.deepEqual(tasks, []);
  const next = await api(app, cookie, 'POST', `/api/rooms/${roomId}/tasks`, {
    title: 'Another task',
    idempotency_key: randomUUID(),
  });
  assert.equal(next.statusCode, 201, next.body);
  assert.equal(next.json().task.number, 1);

  // A replay returns the same room; nothing new is created.
  const replayBody = {
    agent_id: agentId,
    room_template_id: 'writing-room',
    name: 'Launch notes',
    topic: 'Release notes for the spring launch',
    idempotency_key: randomUUID(),
  };
  const first = await api(app, cookie, 'POST', '/api/rooms', replayBody);
  assert.equal(first.statusCode, 201, first.body);
  // The caller's name and topic win over the template's.
  assert.equal(first.json().room.name, 'Launch notes');
  assert.equal(first.json().room.topic, 'Release notes for the spring launch');
  const again = await api(app, cookie, 'POST', '/api/rooms', replayBody);
  assert.equal(again.statusCode, 201, again.body);
  assert.equal(again.json().replayed, true);
  assert.equal(again.json().room.id, first.json().room.id);
  assert.deepEqual(again.json().template.starter_tasks, []);
  const writing = await api(app, cookie, 'GET', `/api/rooms/${first.json().room.id}/tasks`);
  assert.equal(writing.json().tasks.length, 0);
  const conflict = await api(app, cookie, 'POST', '/api/rooms', {
    ...replayBody,
    room_template_id: 'research-squad',
  });
  assert.equal(conflict.statusCode, 409, 'another template under the same key conflicts');
  assert.equal(conflict.json().code, 'idempotency_conflict');
});

test('tasks off: a templated room starts without tasks; refusals store nothing', async (t) => {
  flag(t, false);
  const { app, cookie } = await fixture(t);
  const agentId = await hostAgent(app, cookie);

  const listed = await api(app, cookie, 'GET', '/api/room-templates');
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().starter_tasks, false);

  const created = await api(app, cookie, 'POST', '/api/rooms', {
    agent_id: agentId,
    room_template_id: 'code-review-crew',
    idempotency_key: randomUUID(),
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().room.name, 'Code review crew');
  assert.deepEqual(created.json().template.starter_tasks, []);
  assert.equal(created.json().template.invite_suggestions.length, 3);
  const thread = (
    await api(app, cookie, 'GET', `/api/rooms/${created.json().room.id}/messages?since=0`)
  ).json();
  assert.equal(thread.messages.length, 0, 'no task lines');

  const unknown = await api(app, cookie, 'POST', '/api/rooms', {
    agent_id: agentId,
    name: 'Unknown template',
    room_template_id: 'no-such-template',
    idempotency_key: randomUUID(),
  });
  assert.equal(unknown.statusCode, 400, unknown.body);
  assert.equal(unknown.json().code, 'unknown_room_template');
  assert.ok(unknown.json().details.templates.includes('product-team'));
  const malformed = await api(app, cookie, 'POST', '/api/rooms', {
    agent_id: agentId,
    name: 'Bad id',
    room_template_id: 'Not An Id',
    idempotency_key: randomUUID(),
  });
  assert.equal(malformed.statusCode, 400, malformed.body);
  const unnamed = await api(app, cookie, 'POST', '/api/rooms', {
    agent_id: agentId,
    idempotency_key: randomUUID(),
  });
  assert.equal(unnamed.statusCode, 400, unnamed.body);
  assert.equal(unnamed.json().code, 'name_required');
  const blankUnnamed = await api(app, cookie, 'POST', '/api/rooms', {
    agent_id: agentId,
    room_template_id: 'blank',
    idempotency_key: randomUUID(),
  });
  assert.equal(blankUnnamed.statusCode, 400, 'Blank has no default name');
  assert.equal(blankUnnamed.json().code, 'name_required');

  // Blank with a name: a room like any other, no suggestions.
  const blank = await api(app, cookie, 'POST', '/api/rooms', {
    agent_id: agentId,
    name: 'Plain room',
    room_template_id: 'blank',
    idempotency_key: randomUUID(),
  });
  assert.equal(blank.statusCode, 201, blank.body);
  assert.equal(blank.json().room.topic, '');
  assert.deepEqual(blank.json().template.invite_suggestions, []);
  // Without a template: no template recorded and no template part in the answer.
  const plain = await api(app, cookie, 'POST', '/api/rooms', {
    agent_id: agentId,
    name: 'No template',
    idempotency_key: randomUUID(),
  });
  assert.equal(plain.statusCode, 201, plain.body);
  assert.equal(plain.json().room.template, null);
  assert.equal(plain.json().template, undefined);

  const rooms = (await api(app, cookie, 'GET', '/api/rooms')).json().rooms as unknown[];
  assert.equal(rooms.length, 3, 'refused creates stored nothing');
});

test('REST and MCP: list the room templates; an AI creates a room from one', async (t) => {
  flag(t, true);
  const { app, cookie } = await fixture(t);
  const key = await workspaceKey(app, cookie);

  const anonymous = await app.inject({ method: 'GET', url: '/api/room-templates' });
  assert.equal(anonymous.statusCode, 401, 'signed-in owners only');
  const expected = {
    catalog_version: '1.0.0',
    starter_tasks: false,
    templates: ROOM_TEMPLATES.map(roomTemplateView),
  };
  const listed = await api(app, cookie, 'GET', '/api/room-templates');
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json(), expected);
  assert.equal(remoteOutputSchemas.city_list_room_templates.safeParse(expected).success, true);

  const viaTool = await tool(app, key, 'city_list_room_templates', {});
  assert.equal(viaTool.statusCode, 200, viaTool.body);
  assert.deepEqual(viaTool.json(), expected);
  const extra = await tool(app, key, 'city_list_room_templates', { x: 1 });
  assert.equal(extra.statusCode, 400, 'no input');

  const toolsRes = await mcpCall(app, key, 'tools/list', {});
  const tools = rpcResult(toolsRes.body).result.tools as {
    name: string;
    annotations: { readOnlyHint: boolean };
    inputSchema: { properties: Record<string, unknown>; required?: string[] };
  }[];
  const entry = tools.find((item) => item.name === 'city_list_room_templates');
  assert.ok(entry, 'tools/list includes the room templates tool');
  assert.equal(entry.annotations.readOnlyHint, true);
  const create = tools.find((item) => item.name === 'city_create_room')!;
  assert.ok(create.inputSchema.properties.room_template_id, 'create takes room_template_id');
  assert.ok(!(create.inputSchema.required ?? []).includes('name'), 'name is optional');

  const agent = await tool(app, key, 'city_create_agent', {
    name: 'Room template AI',
    description: 'Synthetic room template host',
    capability: 'research',
    mode: 'external',
    idempotencyKey: randomUUID(),
  });
  assert.equal(agent.statusCode, 200, agent.body);
  const called = await mcpCall(app, key, 'tools/call', {
    name: 'city_create_room',
    arguments: {
      agent_id: agent.json().agent.id,
      room_template_id: 'research-squad',
      idempotency_key: randomUUID(),
    },
  });
  const result = rpcResult(called.body).result as { isError?: boolean; structuredContent: any };
  assert.notEqual(result.isError, true, called.body);
  const out = result.structuredContent;
  assert.equal(out.room.name, 'Research squad');
  assert.equal(out.room.template, undefined, 'the room view carries no template in tool results');
  assert.deepEqual(out.template.starter_tasks, [], 'an AI-created room starts with no tasks too');
  assert.equal(out.template.invite_suggestions[0].label, 'A research AI');
  assert.ok(out.link.link, 'the invite link is returned as usual');
  assert.equal(out.room.member_count, 1);
});
