import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { createRoomTasks, type TaskPrincipal } from '../server/rooms/tasks-service.js';
import { registerRoomTasksMigration } from '../server/rooms/tasks-schema.js';
import { TASK_LIMITS } from '../server/rooms/tasks-contract.js';
import { roomTaskOutputSchemas } from '../server/rooms/tasks-tools.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';

registerRoomTasksMigration();

/**
 * Task comments (docs/ROOM_TASKS.md "Comments"): members only, the guest credential re-check,
 * cross-room 404s, delete rules, caps, credential refusal, idempotent adds, comment_count on
 * task views, and the REST and MCP surfaces. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
let addressCounter = 61;

function flag(t: { after: (fn: () => void) => void }) {
  const saved = process.env.CITY_ROOM_TASKS;
  process.env.CITY_ROOM_TASKS = '1';
  t.after(() => {
    if (saved === undefined) delete process.env.CITY_ROOM_TASKS;
    else process.env.CITY_ROOM_TASKS = saved;
  });
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
/** An AI-owned workspace with a full-scope key, plus the person who co-owns it. */
async function owner(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.30`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({
      name: `Comment co-owner ${addressCounter}`,
      password: 'Synthetic comment co-owner password',
    }),
    remoteAddress: `198.51.${addressCounter++}.31`,
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
    payload: JSON.stringify({ label: 'comment tester', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return { id, key: minted.json().workspace_key as string, cookie };
}
async function agent(app: App, key: string, name: string) {
  const body = await ok(app, key, 'city_create_agent', {
    name,
    description: 'Synthetic comment member',
    capability: 'research',
    mode: 'external',
    idempotencyKey: randomUUID(),
  });
  return body.agent.id as string;
}
const p = (operatorId: string): TaskPrincipal => ({
  operatorId,
  actor: 'the test owner',
  origin: 'http://localhost',
});
function tasksOf(app: App, charges: string[] = []) {
  return createRoomTasks({
    db: app.city.db,
    clock: () => Date.now(),
    limit: async (key: string) => {
      charges.push(key);
    },
    secret: 'test-rooms-secret',
  });
}
async function failsCode(run: Promise<unknown>, code: string) {
  try {
    await run;
  } catch (error) {
    const err = error as { statusCode?: number; errorCode?: string; message?: string };
    assert.equal(err?.errorCode, code, `expected ${code}, got ${String(err)}`);
    return err;
  }
  return assert.fail(`expected failure ${code}`);
}
async function roomFixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const charges: string[] = [];
  const tasks = tasksOf(app, charges);
  const a = await owner(app, 'Comment host workspace');
  const b = await owner(app, 'Comment member workspace');
  const c = await owner(app, 'Comment outsider workspace');
  const host = await agent(app, a.key, 'Comment host');
  const member = await agent(app, b.key, 'Comment member');
  const outsider = await agent(app, c.key, 'Comment outsider');
  const created = await ok(app, a.key, 'city_create_room', {
    agent_id: host,
    name: 'Comment desk',
    topic: 'Comment topic',
    idempotency_key: randomUUID(),
  });
  await ok(app, b.key, 'city_join_room', {
    link: created.link.link,
    agent_id: member,
    idempotency_key: randomUUID(),
  });
  const roomId = created.room.id as string;
  const task = (
    await tasks.create(p(a.id), {
      room_id: roomId,
      title: 'Discuss me',
      idempotency_key: randomUUID(),
    })
  ).task;
  return { app, charges, tasks, a, b, c, host, member, outsider, roomId, task };
}
const messageCount = async (app: App, roomId: string) =>
  Number(
    (
      await app.city.db.query<{ n: string }>(
        'SELECT count(*) AS n FROM room_messages WHERE room_id=$1',
        [roomId],
      )
    ).rows[0]!.n,
  );

test('members comment and read the thread; outsiders get the uniform 404', async (t) => {
  const { app, charges, tasks, a, b, c, member, roomId, task } = await roomFixture(t);
  assert.equal(task.comment_count, 0);
  const before = await messageCount(app, roomId);
  const first = await tasks.commentAdd(p(b.id), {
    room_id: roomId,
    task_id: task.id,
    body: 'Should this cover\nthe mobile layout too?',
  });
  assert.equal(first.replayed, false);
  assert.equal(first.comment.author_agent_id, member);
  assert.equal(first.comment.author, 'Comment member');
  assert.equal(first.comment.author_kind, 'agent');
  assert.equal(first.comment.origin, 'external');
  assert.equal(first.comment.own, true);
  assert.equal(first.comment.body, 'Should this cover\nthe mobile layout too?');
  assert.ok(charges.includes(`room-task-comment:${member}`), charges.join());
  // Plain text, stored verbatim: markup is not interpreted or stripped.
  const second = await tasks.commentAdd(p(a.id), {
    room_id: roomId,
    task_id: task.id,
    body: 'Yes. <b>Both</b> layouts.',
  });
  assert.equal(second.comment.body, 'Yes. <b>Both</b> layouts.');
  // Nothing reaches the room thread.
  assert.equal(await messageCount(app, roomId), before);

  const listed = await tasks.commentList(p(b.id), { room_id: roomId, task_id: task.id });
  assert.deepEqual(
    listed.comments.map((item) => [item.id, item.own]),
    [
      [first.comment.id, true],
      [second.comment.id, false],
    ],
  );
  assert.equal(listed.has_more, false);
  assert.equal(roomTaskOutputSchemas.city_room_task_comment_list.safeParse(listed).success, true);
  // Paged, newest last.
  const page = await tasks.commentList(p(b.id), { room_id: roomId, task_id: task.id, limit: 1 });
  assert.equal(page.has_more, true);
  const rest = await tasks.commentList(p(b.id), {
    room_id: roomId,
    task_id: task.id,
    after_id: page.next_after!,
  });
  assert.deepEqual(
    rest.comments.map((item) => item.id),
    [second.comment.id],
  );
  // comment_count on every task view.
  assert.equal(
    (await tasks.get(p(b.id), { room_id: roomId, task_id: task.id })).task.comment_count,
    2,
  );
  assert.equal((await tasks.list(p(a.id), { room_id: roomId })).tasks[0]!.comment_count, 2);

  // Non-members: the same 404 as an unknown room, for every operation.
  await failsCode(
    tasks.commentAdd(p(c.id), { room_id: roomId, task_id: task.id, body: 'Let me in' }),
    'room_not_found',
  );
  await failsCode(
    tasks.commentList(p(c.id), { room_id: roomId, task_id: task.id }),
    'room_not_found',
  );
  await failsCode(
    tasks.commentDelete(p(c.id), {
      room_id: roomId,
      task_id: task.id,
      comment_id: first.comment.id,
    }),
    'room_not_found',
  );
  // An agent that is not one of the caller's members is refused.
  await failsCode(
    tasks.commentAdd(p(b.id), {
      room_id: roomId,
      task_id: task.id,
      agent_id: randomUUID(),
      body: 'As someone else',
    }),
    'not_a_member',
  );
});

test('a task of another room is 404 task_not_found; unknown tasks too', async (t) => {
  const { app, tasks, a, host, roomId } = await roomFixture(t);
  const other = await ok(app, a.key, 'city_create_room', {
    agent_id: host,
    name: 'Second desk',
    idempotency_key: randomUUID(),
  });
  const foreign = (
    await tasks.create(p(a.id), {
      room_id: other.room.id,
      title: 'Elsewhere',
      idempotency_key: randomUUID(),
    })
  ).task;
  await tasks.commentAdd(p(a.id), { room_id: other.room.id, task_id: foreign.id, body: 'Here' });
  for (const run of [
    tasks.commentAdd(p(a.id), { room_id: roomId, task_id: foreign.id, body: 'Wrong room' }),
    tasks.commentList(p(a.id), { room_id: roomId, task_id: foreign.id }),
    tasks.commentList(p(a.id), { room_id: roomId, task_id: randomUUID() }),
  ]) {
    const err = await failsCode(run, 'task_not_found');
    assert.equal(err.statusCode, 404);
  }
});

test('delete: authors delete their own, the host any; others are refused', async (t) => {
  const { app, tasks, a, b, roomId, task } = await roomFixture(t);
  const hostNote = await tasks.commentAdd(p(a.id), {
    room_id: roomId,
    task_id: task.id,
    body: 'Host note',
  });
  const memberNote = await tasks.commentAdd(p(b.id), {
    room_id: roomId,
    task_id: task.id,
    body: 'Member note',
  });
  const memberSecond = await tasks.commentAdd(p(b.id), {
    room_id: roomId,
    task_id: task.id,
    body: 'Member second note',
  });
  const refused = await failsCode(
    tasks.commentDelete(p(b.id), {
      room_id: roomId,
      task_id: task.id,
      comment_id: hostNote.comment.id,
    }),
    'not_comment_author',
  );
  assert.equal(refused.statusCode, 403);
  const own = await tasks.commentDelete(p(b.id), {
    room_id: roomId,
    task_id: task.id,
    comment_id: memberNote.comment.id,
  });
  assert.equal(own.deleted, true);
  assert.equal(own.comment.body, '');
  assert.equal(roomTaskOutputSchemas.city_room_task_comment_delete.safeParse(own).success, true);
  // A real delete: the row is gone, so a repeat finds nothing.
  const kept = await app.city.db.query('SELECT 1 FROM room_task_comments WHERE id=$1', [
    memberNote.comment.id,
  ]);
  assert.equal(kept.rows.length, 0);
  await failsCode(
    tasks.commentDelete(p(b.id), {
      room_id: roomId,
      task_id: task.id,
      comment_id: memberNote.comment.id,
    }),
    'comment_not_found',
  );
  const byHost = await tasks.commentDelete(p(a.id), {
    room_id: roomId,
    task_id: task.id,
    comment_id: memberSecond.comment.id,
  });
  assert.equal(byHost.deleted, true);
  await failsCode(
    tasks.commentDelete(p(a.id), { room_id: roomId, task_id: task.id, comment_id: randomUUID() }),
    'comment_not_found',
  );
  const left = await tasks.commentList(p(a.id), { room_id: roomId, task_id: task.id });
  assert.deepEqual(
    left.comments.map((item) => item.id),
    [hostNote.comment.id],
  );
  assert.equal(
    (await tasks.get(p(a.id), { room_id: roomId, task_id: task.id })).task.comment_count,
    1,
  );
});

test('caps: 4000 characters, no control characters, no credentials; idempotent adds', async (t) => {
  const { app, tasks, b, roomId, task } = await roomFixture(t);
  const base = { room_id: roomId, task_id: task.id };
  const longest = await tasks.commentAdd(p(b.id), {
    ...base,
    body: 'x'.repeat(TASK_LIMITS.commentChars),
  });
  assert.equal(longest.comment.body.length, 4000);
  await assert.rejects(tasks.commentAdd(p(b.id), { ...base, body: 'x'.repeat(4001) }));
  await assert.rejects(tasks.commentAdd(p(b.id), { ...base, body: '   ' }));
  await assert.rejects(tasks.commentAdd(p(b.id), { ...base, body: 'bell \u0007 here' }));
  const credential = await failsCode(
    tasks.commentAdd(p(b.id), {
      ...base,
      body: `my key is crc_${'A1b2C3d4'.repeat(5)}abc please use it`,
    }),
    'credential_in_message',
  );
  assert.equal(credential.statusCode, 400);
  assert.ok(!credential.message?.includes('A1b2C3d4'), 'the error never echoes the value');
  await failsCode(
    tasks.commentAdd(p(b.id), { ...base, body: `claim ccclaim_${'Zz09'.repeat(6)}` }),
    'credential_in_message',
  );
  const stored = await app.city.db.query(
    "SELECT 1 FROM room_task_comments WHERE body LIKE '%crc_%' OR body LIKE '%ccclaim_%'",
  );
  assert.equal(stored.rows.length, 0);

  const key = randomUUID();
  const once = await tasks.commentAdd(p(b.id), { ...base, body: 'Once', idempotency_key: key });
  const replay = await tasks.commentAdd(p(b.id), { ...base, body: 'Once', idempotency_key: key });
  assert.equal(replay.replayed, true);
  assert.equal(replay.comment.id, once.comment.id);
  await failsCode(
    tasks.commentAdd(p(b.id), { ...base, body: 'Different', idempotency_key: key }),
    'idempotency_conflict',
  );
  // Once deleted, the comment's key is free for a new comment.
  await tasks.commentDelete(p(b.id), { ...base, comment_id: once.comment.id });
  const reused = await tasks.commentAdd(p(b.id), {
    ...base,
    body: 'Different',
    idempotency_key: key,
  });
  assert.equal(reused.replayed, false);
  assert.notEqual(reused.comment.id, once.comment.id);
});

test('rate limit: 120 comments per agent per hour, charged before anything is stored', async (t) => {
  const { app, b, member, roomId, task } = await roomFixture(t);
  const seen: Array<[string, number, number]> = [];
  let used = 0;
  const limited = createRoomTasks({
    db: app.city.db,
    clock: () => Date.now(),
    limit: async (key: string, max: number, windowMs: number) => {
      seen.push([key, max, windowMs]);
      if (key.startsWith('room-task-comment:') && ++used > max)
        throw Object.assign(new Error('Too many requests.'), {
          statusCode: 429,
          errorCode: 'rate_limited',
        });
    },
    secret: 'test-rooms-secret',
  });
  const base = { room_id: roomId, task_id: task.id };
  for (let i = 0; i < TASK_LIMITS.commentsPerAgentPerHour; i += 1)
    await limited.commentAdd(p(b.id), { ...base, body: `Note ${i}` });
  const refused = await failsCode(
    limited.commentAdd(p(b.id), { ...base, body: 'One too many' }),
    'rate_limited',
  );
  assert.equal(refused.statusCode, 429);
  assert.deepEqual(seen.at(-1), [`room-task-comment:${member}`, 120, 3_600_000]);
  const stored = await app.city.db.query<{ n: string }>(
    'SELECT count(*) AS n FROM room_task_comments WHERE task_id=$1',
    [task.id],
  );
  assert.equal(Number(stored.rows[0]!.n), 120);
  // Reads are free.
  assert.equal((await limited.commentList(p(b.id), { ...base, limit: 100 })).comments.length, 100);
});

test('closed rooms, muted owners and read-only guests cannot write; reads still work', async (t) => {
  const { app, tasks, a, b, roomId, task } = await roomFixture(t);
  const note = await tasks.commentAdd(p(b.id), {
    room_id: roomId,
    task_id: task.id,
    body: 'Before the mute',
  });
  await app.city.db.query(
    "UPDATE room_members SET muted_at=$3, mute_reason='Synthetic reason' WHERE room_id=$1 AND owner_id=$2",
    [roomId, b.id, Date.now()],
  );
  await failsCode(
    tasks.commentAdd(p(b.id), { room_id: roomId, task_id: task.id, body: 'Muted' }),
    'muted_in_room',
  );
  await failsCode(
    tasks.commentDelete(p(b.id), {
      room_id: roomId,
      task_id: task.id,
      comment_id: note.comment.id,
    }),
    'muted_in_room',
  );
  assert.equal(
    (await tasks.commentList(p(b.id), { room_id: roomId, task_id: task.id })).comments.length,
    1,
  );

  // A read-only guest member reads but cannot add.
  const viewer = await owner(app, 'Comment viewer workspace');
  const viewerAgent = await agent(app, viewer.key, 'Viewer agent');
  await app.city.db.query(
    `INSERT INTO room_members(room_id,agent_id,owner_id,role,owner_label,visible_from_seq,joined_at,joined_by)
     VALUES($1,$2,$3,'guest','Comment viewer workspace',0,$4,'the test owner')`,
    [roomId, viewerAgent, viewer.id, Date.now()],
  );
  await failsCode(
    tasks.commentAdd(p(viewer.id), { room_id: roomId, task_id: task.id, body: 'Hello' }),
    'read_only',
  );
  assert.equal(
    (await tasks.commentList(p(viewer.id), { room_id: roomId, task_id: task.id })).comments.length,
    1,
  );

  const closed = await call(app, a.key, 'city_room_close', { room_id: roomId });
  assert.equal(closed.statusCode, 200, closed.body);
  await failsCode(
    tasks.commentAdd(p(a.id), { room_id: roomId, task_id: task.id, body: 'Too late' }),
    'room_closed',
  );
  await failsCode(
    tasks.commentDelete(p(a.id), {
      room_id: roomId,
      task_id: task.id,
      comment_id: note.comment.id,
    }),
    'room_closed',
  );
  assert.equal(
    (await tasks.commentList(p(a.id), { room_id: roomId, task_id: task.id })).comments.length,
    1,
  );
});

test('REST and MCP: add, list and delete own; outputs match the tool schemas', async (t) => {
  flag(t);
  const { app, a, b, roomId, task } = await roomFixture(t);
  const added = await ok(app, b.key, 'city_room_task_comment_add', {
    room_id: roomId,
    task_id: task.id,
    body: 'From MCP',
    idempotency_key: randomUUID(),
  });
  assert.equal(
    roomTaskOutputSchemas.city_room_task_comment_add.safeParse(added).success,
    true,
    JSON.stringify(added),
  );
  const listed = await ok(app, a.key, 'city_room_task_comment_list', {
    room_id: roomId,
    task_id: task.id,
  });
  assert.equal(listed.comments[0].body, 'From MCP');
  assert.equal(listed.comments[0].own, false);
  const got = await ok(app, a.key, 'city_room_task_get', { room_id: roomId, task_id: task.id });
  assert.equal(got.task.comment_count, 1);
  assert.equal(roomTaskOutputSchemas.city_room_task_get.safeParse(got).success, true);
  const hostDelete = await ok(app, a.key, 'city_room_task_comment_delete', {
    room_id: roomId,
    task_id: task.id,
    comment_id: added.comment.id,
  });
  assert.equal(hostDelete.deleted, true);

  // Console REST (the signed-in co-owner of the member workspace).
  const headers = { ...jsonHeaders, cookie: b.cookie, 'x-city-workspace': b.id };
  const base = `/api/rooms/${roomId}/tasks/${task.id}/comments`;
  const posted = await app.inject({
    method: 'POST',
    url: base,
    headers,
    payload: JSON.stringify({ body: 'From the web app', idempotency_key: randomUUID() }),
  });
  assert.equal(posted.statusCode, 201, posted.body);
  const page = await app.inject({ method: 'GET', url: `${base}?limit=10`, headers });
  assert.equal(page.statusCode, 200, page.body);
  assert.deepEqual(
    page.json().comments.map((item: { body: string }) => item.body),
    ['From the web app'],
  );
  const tooLong = await app.inject({
    method: 'POST',
    url: base,
    headers,
    payload: JSON.stringify({ body: 'y'.repeat(4001) }),
  });
  assert.equal(tooLong.statusCode, 400, tooLong.body);
  const removed = await app.inject({
    method: 'DELETE',
    url: `${base}/${posted.json().comment.id}`,
    headers,
    payload: JSON.stringify({}),
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().deleted, true);
});

// Invited guests (joined by invite link) comment in their own room through the task service with
// their room credential re-checked inside each transaction (TaskPrincipal.guard).
test('an invited guest comments in its own room only; the credential is re-checked', async (t) => {
  const saved = { ...process.env };
  process.env.CITY_INVITE_FLOW = '1';
  process.env.CITY_ROOM_TASKS = '1';
  process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-task-comments-test-root-secret';
  t.after(() => {
    for (const name of ['CITY_INVITE_FLOW', 'CITY_ROOM_TASKS', 'CITY_RATE_LIMIT_KEY'])
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
  });
  const headers = {
    'content-type': 'application/json',
    'x-city-request': '1',
    host: 'centralcity.ai',
    origin: 'https://centralcity.ai',
  };
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  const post = (url: string, body: unknown, extra = {}, remoteAddress = '203.0.113.41') =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress,
    });
  const registered = await post('/api/auth/register', {
    name: 'Comment host',
    password: 'Synthetic comment guest test password',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const hostCookie = {
    cookie: `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`,
  };
  const hostAgent = await post(
    '/api/agents',
    { name: 'Host', capability: 'research', mode: 'hosted' },
    hostCookie,
  );
  assert.equal(hostAgent.statusCode, 201, hostAgent.body);
  const makeRoom = async (name: string) => {
    const room = await post(
      '/api/rooms',
      { name, agent_id: hostAgent.json().agent.id, idempotency_key: randomUUID() },
      hostCookie,
    );
    assert.equal(room.statusCode, 201, room.body);
    return room.json().room.id as string;
  };
  const mine = await makeRoom('Guest comment room');
  const other = await makeRoom('Other comment room');
  const link = await post('/api/links', { target: 'room', room_id: mine }, hostCookie);
  assert.equal(link.statusCode, 201, link.body);
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;
  const start = await post('/api/public/invites/bootstrap', { code }, {}, '203.0.113.42');
  assert.equal(start.statusCode, 200, start.body);
  const joined = await post(
    '/api/public/invites/redeem',
    { code, handle: start.json().handle, name: 'Invited AI' },
    {},
    '203.0.113.42',
  );
  assert.equal(joined.statusCode, 200, joined.body);
  const guest = joined.json() as { credential: string; agent_id: string; room_id: string };
  const operator = (
    await app.city.db.query<{ operator_id: string }>(
      'SELECT operator_id FROM room_invite_credentials WHERE agent_id=$1',
      [guest.agent_id],
    )
  ).rows[0]!.operator_id;
  const hostOperator = (
    await app.city.db.query<{ host_owner_id: string }>(
      'SELECT host_owner_id FROM rooms WHERE id=$1',
      [mine],
    )
  ).rows[0]!.host_owner_id;

  const tasks = tasksOf(app);
  const hostTask = (
    await tasks.create(p(hostOperator), {
      room_id: mine,
      title: 'Guest discussion',
      idempotency_key: randomUUID(),
    })
  ).task;
  const otherTask = (
    await tasks.create(p(hostOperator), {
      room_id: other,
      title: 'Host only',
      idempotency_key: randomUUID(),
    })
  ).task;
  // The guest principal, as the invite tool path builds it: the guard re-checks the credential.
  let guarded = 0;
  const guestP: TaskPrincipal = {
    operatorId: operator,
    actor: 'invited AI',
    origin: 'https://centralcity.ai',
    guard: async (tx) => {
      guarded += 1;
      const live = await tx.query(
        'SELECT 1 FROM room_invite_credentials WHERE agent_id=$1 AND room_id=$2 AND revoked_at IS NULL',
        [guest.agent_id, mine],
      );
      if (!live.rows.length) throw Object.assign(new Error('revoked'), { errorCode: 'revoked' });
    },
  };
  // The guest path injects room_id and agent_id: accepted, and they must be its own.
  const added = await tasks.commentAdd(guestP, {
    room_id: mine,
    agent_id: guest.agent_id,
    task_id: hostTask.id,
    body: 'Guest thoughts',
  });
  assert.equal(added.comment.author_agent_id, guest.agent_id);
  const read = await tasks.commentList(guestP, {
    room_id: mine,
    agent_id: guest.agent_id,
    task_id: hostTask.id,
  });
  assert.equal(read.comments.length, 1);
  assert.ok(guarded >= 2, 'the guard runs inside each transaction');
  // Another room: the uniform 404, for the room and for its task through the guest's own room.
  await failsCode(
    tasks.commentAdd(guestP, { room_id: other, task_id: otherTask.id, body: 'Sneaky' }),
    'room_not_found',
  );
  await failsCode(
    tasks.commentList(guestP, { room_id: other, task_id: otherTask.id }),
    'room_not_found',
  );
  await failsCode(
    tasks.commentAdd(guestP, { room_id: mine, task_id: otherTask.id, body: 'Sneaky' }),
    'task_not_found',
  );
  // The host deletes the guest's comment; the guest cannot delete the host's.
  const hostNote = await tasks.commentAdd(p(hostOperator), {
    room_id: mine,
    task_id: hostTask.id,
    body: 'Host reply',
  });
  await failsCode(
    tasks.commentDelete(guestP, {
      room_id: mine,
      task_id: hostTask.id,
      comment_id: hostNote.comment.id,
    }),
    'not_comment_author',
  );
  const own = await tasks.commentDelete(guestP, {
    room_id: mine,
    agent_id: guest.agent_id,
    task_id: hostTask.id,
    comment_id: added.comment.id,
  });
  assert.equal(own.deleted, true);
  // A revoked credential stops the guest at once.
  await app.city.db.query('UPDATE room_invite_credentials SET revoked_at=$2 WHERE agent_id=$1', [
    guest.agent_id,
    Date.now(),
  ]);
  await failsCode(
    tasks.commentAdd(guestP, { room_id: mine, task_id: hostTask.id, body: 'After revoke' }),
    'revoked',
  );
});
