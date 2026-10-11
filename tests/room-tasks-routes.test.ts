import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerRoomTasksMigration } from '../server/rooms/tasks-schema.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { fixture, mcpCall, rpcResult, type App } from './oauth-helpers.js';

registerRoomTasksMigration();

/**
 * TASK 18: console REST routes for room tasks (follow-up to #142).
 *
 * Wired in server/app.ts behind the same flag:
 * `if (roomTasksEnabled(process.env)) registerTaskRoutes(app, { tasks, owner, originOf })`.
 * Each test sets and restores process.env.CITY_ROOM_TASKS. Fixture style mirrors
 * pr3-snapshot/room-tasks-e2e.test.ts (owner registration, cookies, app build
 * with the flag); the flag-on tests act as the host owner through the console
 * session (session cookie + x-city-request). Synthetic data only.
 */
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const PASSWORD = 'Synthetic task routes password';
const EVIDENCE = { kind: 'proposal', ref: 'proposal-7', revision: 'rev-3' };
let addressCounter = 71;

function flagOn(t: { after: (fn: () => void) => void }) {
  const saved = process.env.CITY_ROOM_TASKS;
  process.env.CITY_ROOM_TASKS = '1';
  t.after(() => {
    if (saved === undefined) delete process.env.CITY_ROOM_TASKS;
    else process.env.CITY_ROOM_TASKS = saved;
  });
}

function flagOff(t: { after: (fn: () => void) => void }) {
  const saved = process.env.CITY_ROOM_TASKS;
  delete process.env.CITY_ROOM_TASKS;
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

async function registerPerson(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name, password: PASSWORD }),
    remoteAddress: `198.51.${addressCounter++}.70`,
  });
  assert.equal(res.statusCode, 201, 'person registers');
  return `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
}

async function consoleAgent(app: App, cookie: string, name: string) {
  const res = await api(app, cookie, 'POST', '/api/agents', {
    name,
    capability: 'research',
    mode: 'hosted',
  });
  assert.equal(res.statusCode, 201, 'agent created');
  return res.json().agent.id as string;
}

async function consoleRoom(app: App, cookie: string, agentId: string, name: string) {
  const res = await api(app, cookie, 'POST', '/api/rooms', {
    agent_id: agentId,
    name,
    topic: 'Task routes topic',
    idempotency_key: randomUUID(),
  });
  assert.equal(res.statusCode, 201, 'room created');
  const room = res.json().room as { id: string; slug: string };
  return { room, link: res.json().link.link as string };
}

async function consoleJoin(app: App, cookie: string, link: string, agentId: string) {
  const [path, token] = link.split('#');
  const slug = path!.split('/r/')[1]!;
  const res = await api(app, cookie, 'POST', `/api/rooms/${slug}/join`, {
    token,
    agent_id: agentId,
    idempotency_key: randomUUID(),
  });
  assert.equal(res.statusCode, 200, 'member joins');
  return slug;
}

/** An AI-owned workspace co-owned by the cookie holder, with a full-scope key. */
async function workspaceKey(app: App, cookie: string, label: string) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: label, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.71`,
  });
  assert.equal(created.statusCode, 201, 'workspace created');
  const id = created.json().workspace_id as string;
  const claimed = await api(app, cookie, 'POST', '/api/workspaces/claim', {
    claim_token: created.json().claim_token,
  });
  assert.equal(claimed.statusCode, 200, 'workspace claimed');
  const minted = await app.inject({
    method: 'POST',
    url: '/api/workspace-keys',
    headers: { ...jsonHeaders, cookie, 'x-city-workspace': id },
    payload: JSON.stringify({ label: 'task routes probe', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, 'workspace key minted');
  return minted.json().workspace_key as string;
}

test('flag off: task REST, assistant tool and MCP tools are absent', async (t) => {
  flagOff(t);
  const { app, cookie } = await fixture(t);
  const key = await workspaceKey(app, cookie, 'Task routes flag-off workspace');

  const listed = await api(app, cookie, 'GET', '/api/rooms/route-probe-room/tasks');
  assert.equal(listed.statusCode, 404, 'flag-off REST list is absent');

  const tool = await app.inject({
    method: 'POST',
    url: '/api/assistant/tools/city_room_task_create',
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify({
      room_id: randomUUID(),
      title: 'Probe',
      idempotency_key: randomUUID(),
    }),
  });
  assert.equal(tool.statusCode, 404, 'flag-off assistant tool is absent');
  assert.ok(tool.body.includes('Assistant tool not found.'), 'flag-off assistant tool message');

  const toolsRes = await mcpCall(app, key, 'tools/list', {});
  assert.equal(toolsRes.statusCode, 200, toolsRes.body);
  const names = (rpcResult(toolsRes.body).result.tools as { name: string }[]).map(
    (entry) => entry.name,
  );
  assert.ok(
    names.every((name) => !name.startsWith('city_room_task_')),
    'flag-off tools/list hides task tools',
  );

  const callRes = await mcpCall(app, key, 'tools/call', {
    name: 'city_room_task_create',
    arguments: { room_id: randomUUID(), title: 'Probe', idempotency_key: randomUUID() },
  });
  assert.equal(callRes.statusCode, 200, callRes.body);
  const parsed = rpcResult(callRes.body) as {
    result?: { isError?: boolean };
    error?: unknown;
  };
  assert.ok(parsed.error ?? parsed.result?.isError, 'flag-off tools/call is an error');
});

test('flag on: host owner creates, lists and gets a task over REST', async (t) => {
  flagOn(t);
  const { app, cookie: hostCookie } = await fixture(t);
  const hostAgent = await consoleAgent(app, hostCookie, 'Task routes host');
  const { room } = await consoleRoom(app, hostCookie, hostAgent, 'Task routes desk');
  const outsiderCookie = await registerPerson(app, 'Task routes outsider');

  const created = await api(app, hostCookie, 'POST', `/api/rooms/${room.id}/tasks`, {
    title: 'Route task one',
    body: 'First route body',
    idempotency_key: randomUUID(),
  });
  assert.equal(created.statusCode, 201, 'task created');
  assert.equal(created.json().replayed, false);
  assert.equal(created.json().task.number, 1);
  assert.equal(created.json().task.status, 'open');
  const taskId = created.json().task.id as string;

  const listed = await api(app, hostCookie, 'GET', `/api/rooms/${room.id}/tasks`);
  assert.equal(listed.statusCode, 200, 'tasks listed');
  assert.deepEqual(
    listed.json().tasks.map((item: { id: string }) => item.id),
    [taskId],
  );

  const fetched = await api(app, hostCookie, 'GET', `/api/rooms/${room.id}/tasks/${taskId}`);
  assert.equal(fetched.statusCode, 200, 'task read');
  assert.equal(fetched.json().task.id, taskId);

  // A non-member owner sees the uniform 404, whether the room exists or not.
  const hiddenList = await api(app, outsiderCookie, 'GET', `/api/rooms/${room.id}/tasks`);
  assert.equal(hiddenList.statusCode, 404, 'outsider list refused');
  assert.equal(hiddenList.json().code, 'room_not_found');
  const madeUp = await api(app, outsiderCookie, 'GET', `/api/rooms/${randomUUID()}/tasks`);
  assert.equal(madeUp.statusCode, 404, 'made-up room refused');
  assert.equal(madeUp.json().code, hiddenList.json().code);
  const hiddenGet = await api(app, outsiderCookie, 'GET', `/api/rooms/${room.id}/tasks/${taskId}`);
  assert.equal(hiddenGet.statusCode, 404, 'outsider get refused');
  assert.equal(hiddenGet.json().code, 'room_not_found');

  // A task id from another room is task_not_found, not a leak of the other room.
  const other = await consoleRoom(app, hostCookie, hostAgent, 'Task routes second desk');
  const otherTask = await api(app, hostCookie, 'POST', `/api/rooms/${other.room.id}/tasks`, {
    title: 'Other room task',
    idempotency_key: randomUUID(),
  });
  assert.equal(otherTask.statusCode, 201, 'other task created');
  const crossed = await api(
    app,
    hostCookie,
    'GET',
    `/api/rooms/${room.id}/tasks/${otherTask.json().task.id}`,
  );
  assert.equal(crossed.statusCode, 404, 'cross-room task refused');
  assert.equal(crossed.json().code, 'task_not_found');
});

test('flag on: every task route is reachable; host checks match the service', async (t) => {
  flagOn(t);
  const { app, cookie: hostCookie } = await fixture(t);
  const hostAgent = await consoleAgent(app, hostCookie, 'Task routes host agent');
  const { room, link } = await consoleRoom(app, hostCookie, hostAgent, 'Task routes full desk');
  const memberCookie = await registerPerson(app, 'Task routes member');
  const memberAgent = await consoleAgent(app, memberCookie, 'Task routes member agent');
  await consoleJoin(app, memberCookie, link, memberAgent);

  // POST /api/rooms/:room/tasks — create (201).
  const created = await api(app, hostCookie, 'POST', `/api/rooms/${room.id}/tasks`, {
    title: 'Full route task',
    body: 'Lifecycle body',
    idempotency_key: randomUUID(),
  });
  assert.equal(created.statusCode, 201, 'task created');
  const taskId = created.json().task.id as string;

  // POST .../claim — claim.
  const claimed = await api(
    app,
    hostCookie,
    'POST',
    `/api/rooms/${room.id}/tasks/${taskId}/claim`,
    {
      agent_id: hostAgent,
      idempotency_key: randomUUID(),
    },
  );
  assert.equal(claimed.statusCode, 200, 'task claimed');
  assert.equal(claimed.json().task.status, 'claimed');
  const claimToken = claimed.json().claim_token as string;

  // POST .../renew — renew returns expiries only, never a token.
  const renewed = await api(
    app,
    hostCookie,
    'POST',
    `/api/rooms/${room.id}/tasks/${taskId}/renew`,
    {
      claim_token: claimToken,
    },
  );
  assert.equal(renewed.statusCode, 200, 'claim renewed');
  assert.ok(renewed.json().expires_at, 'renewal expiry present');
  assert.ok(!('claim_token' in renewed.json()), 'renewal returns no token');

  // POST .../result — holder posts evidence, claimed -> in_review.
  const posted = await api(
    app,
    hostCookie,
    'POST',
    `/api/rooms/${room.id}/tasks/${taskId}/result`,
    { claim_token: claimToken, evidence: EVIDENCE },
  );
  assert.equal(posted.statusCode, 200, 'result posted');
  assert.equal(posted.json().task.status, 'in_review');
  assert.equal(posted.json().task.submitted_by, hostAgent, 'hand-in records who did the work');

  // A member who is not the host cannot review: 403 host_required.
  const memberReview = await api(
    app,
    memberCookie,
    'POST',
    `/api/rooms/${room.id}/tasks/${taskId}/update`,
    { decision: 'approve' },
  );
  assert.equal(memberReview.statusCode, 403, 'member review refused');
  assert.equal(memberReview.json().code, 'host_required');

  // POST .../update — host approves, in_review -> done.
  const reviewed = await api(
    app,
    hostCookie,
    'POST',
    `/api/rooms/${room.id}/tasks/${taskId}/update`,
    { decision: 'approve' },
  );
  assert.equal(reviewed.statusCode, 200, 'task approved');
  assert.equal(reviewed.json().decision, 'approve');
  assert.equal(reviewed.json().task.status, 'done');

  // GET .../:task — read one; GET .../tasks — list.
  const fetched = await api(app, hostCookie, 'GET', `/api/rooms/${room.id}/tasks/${taskId}`);
  assert.equal(fetched.statusCode, 200, 'task read');
  assert.equal(fetched.json().task.status, 'done');
  assert.equal(fetched.json().task.submitted_by, hostAgent);
  const listed = await api(app, hostCookie, 'GET', `/api/rooms/${room.id}/tasks`);
  assert.equal(listed.statusCode, 200, 'tasks listed');
  assert.equal(
    (listed.json().tasks as { id: string; submitted_by: string | null }[]).find(
      (item) => item.id === taskId,
    )?.submitted_by,
    hostAgent,
    'the list shows who handed it in',
  );
  assert.ok(
    (listed.json().tasks as { id: string }[]).some((item) => item.id === taskId),
    'list contains the task',
  );

  // GET .../:task/events — event log.
  const events = await api(app, hostCookie, 'GET', `/api/rooms/${room.id}/tasks/${taskId}/events`);
  assert.equal(events.statusCode, 200, 'events read');
  assert.equal(events.json().task_id, taskId);
  assert.ok(
    (events.json().events as { action: string }[]).some((item) => item.action === 'created'),
    'events contain the creation',
  );

  // POST .../release — a second task covers release; a member release without a
  // token goes through the same service check as MCP (400 claim_token_required).
  const second = await api(app, hostCookie, 'POST', `/api/rooms/${room.id}/tasks`, {
    title: 'Release route task',
    idempotency_key: randomUUID(),
  });
  assert.equal(second.statusCode, 201, 'second task created');
  const secondId = second.json().task.id as string;
  const held = await api(app, hostCookie, 'POST', `/api/rooms/${room.id}/tasks/${secondId}/claim`, {
    agent_id: hostAgent,
    idempotency_key: randomUUID(),
  });
  assert.equal(held.statusCode, 200, 'second task claimed');
  const memberRelease = await api(
    app,
    memberCookie,
    'POST',
    `/api/rooms/${room.id}/tasks/${secondId}/release`,
    {},
  );
  assert.equal(memberRelease.statusCode, 400, 'member tokenless release refused');
  assert.equal(memberRelease.json().code, 'claim_token_required');
  const released = await api(
    app,
    hostCookie,
    'POST',
    `/api/rooms/${room.id}/tasks/${secondId}/release`,
    { claim_token: held.json().claim_token },
  );
  assert.equal(released.statusCode, 200, 'task released');
  assert.equal(released.json().released, true);
  assert.equal(released.json().task.status, 'open');
});
