import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createRoomTasks } from '../server/rooms/tasks-service.js';

// Task stages and invited guests: a guest whose credential is revoked or expired is refused on
// the stage tools, and the stage functions run the principal's credential re-check.
process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_ROOM_TASKS = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-guest-tasks-test-root-secret';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};
const evidence = { kind: 'proposal', ref: 'proposal-1', revision: 'rev-1' };

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
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
  const post = (url: string, body: unknown, extra = {}, remoteAddress = '203.0.113.12') =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress,
    });
  const registered = await post('/api/auth/register', {
    name: 'Task host',
    password: 'Synthetic guest task test password',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const host = {
    cookie: `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`,
  };
  const agent = await post(
    '/api/agents',
    { name: 'Host', capability: 'research', mode: 'hosted' },
    host,
  );
  assert.equal(agent.statusCode, 201, agent.body);
  const makeRoom = async (name: string) => {
    const room = await post(
      '/api/rooms',
      { name, agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
      host,
    );
    assert.equal(room.statusCode, 201, room.body);
    return room.json().room.id as string;
  };
  const join = async (roomId: string, address: string) => {
    const link = await post('/api/links', { target: 'room', room_id: roomId }, host);
    assert.equal(link.statusCode, 201, link.body);
    const code = new URL(link.json().url).pathname.split('/').at(-1)!;
    const start = await post('/api/public/invites/bootstrap', { code }, {}, address);
    assert.equal(start.statusCode, 200, start.body);
    const joined = await post(
      '/api/public/invites/redeem',
      { code, handle: start.json().handle, name: 'Invited AI' },
      {},
      address,
    );
    assert.equal(joined.statusCode, 200, joined.body);
    return joined.json() as { credential: string; agent_id: string; room_id: string };
  };
  const invoke = (credential: string, tool: string, args: unknown = {}) =>
    post(`/api/public/invites/tools/${tool}`, args, { authorization: `Bearer ${credential}` });
  return { app, post, host, makeRoom, join, invoke };
}

async function stagedRoom(f: Awaited<ReturnType<typeof fixture>>, address: string) {
  const roomId = await f.makeRoom('Guest stage room');
  const set = await f.app.inject({
    method: 'PUT',
    url: `/api/rooms/${roomId}/task-stages`,
    headers: { ...headers, ...f.host },
    payload: JSON.stringify({ stages: ['Building', 'Shipped'] }),
  });
  assert.equal(set.statusCode, 200, set.body);
  const guest = await f.join(roomId, address);
  const created = await f.invoke(guest.credential, 'city_room_task_create', {
    title: 'Guest stage work',
    idempotency_key: randomUUID(),
  });
  assert.equal(created.statusCode, 200, created.body);
  const taskId = created.json().task.id as string;
  const claimed = await f.invoke(guest.credential, 'city_room_task_claim', {
    task_id: taskId,
    idempotency_key: randomUUID(),
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  // A live guest holding the claim moves its own task's stage and reads the list.
  const moved = await f.invoke(guest.credential, 'city_room_task_review', {
    task_id: taskId,
    stage: 'Building',
  });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().task.stage, 'Building');
  return { roomId, guest, taskId };
}

async function refusedOnStageTools(
  f: Awaited<ReturnType<typeof fixture>>,
  credential: string,
  taskId: string,
) {
  const move = await f.invoke(credential, 'city_room_task_review', {
    task_id: taskId,
    stage: 'Shipped',
  });
  assert.equal(move.statusCode, 401, move.body);
  const list = await f.invoke(credential, 'city_room_task_list', { stage: 'Building' });
  assert.equal(list.statusCode, 401, list.body);
  const stage = (
    await f.app.city.db.query<{ stage: string | null }>(
      'SELECT stage FROM room_tasks WHERE id=$1',
      [taskId],
    )
  ).rows[0]!.stage;
  assert.equal(stage, 'Building');
}

test('a guest with a revoked credential is refused on the stage tools', async (t) => {
  const f = await fixture(t);
  const { guest, taskId } = await stagedRoom(f, '203.0.113.41');
  await f.app.city.db.query('UPDATE room_invite_credentials SET revoked_at=$2 WHERE agent_id=$1', [
    guest.agent_id,
    Date.now(),
  ]);
  await refusedOnStageTools(f, guest.credential, taskId);
});

test('a guest with an expired credential is refused on the stage tools', async (t) => {
  const f = await fixture(t);
  const { guest, taskId } = await stagedRoom(f, '203.0.113.42');
  await f.app.city.db.query('UPDATE room_invite_credentials SET expires_at=$2 WHERE agent_id=$1', [
    guest.agent_id,
    Date.now() - 1000,
  ]);
  await refusedOnStageTools(f, guest.credential, taskId);
});

test('the stage functions run the principal guard (credential re-check) first', async (t) => {
  const f = await fixture(t);
  const { roomId, guest, taskId } = await stagedRoom(f, '203.0.113.43');
  const operatorId = (
    await f.app.city.db.query<{ operator_id: string }>(
      'SELECT operator_id FROM room_invite_credentials WHERE agent_id=$1',
      [guest.agent_id],
    )
  ).rows[0]!.operator_id;
  const tasks = createRoomTasks({
    db: f.app.city.db,
    clock: () => Date.now(),
    limit: async () => {},
    secret: 'test-rooms-secret',
  });
  let calls = 0;
  const lapsed = {
    operatorId,
    actor: 'invited AI',
    origin: 'https://centralcity.ai',
    guard: async () => {
      calls += 1;
      throw Object.assign(new Error('credential no longer valid'), { errorCode: 'guard_refused' });
    },
  };
  for (const run of [
    () => tasks.update(lapsed, { room_id: roomId, task_id: taskId, stage: 'Shipped' }),
    () => tasks.stages(lapsed, { room_id: roomId }),
    () => tasks.setStages(lapsed, { room_id: roomId, stages: ['Other'] }),
    () => tasks.list(lapsed, { room_id: roomId, stage: 'Building' }),
  ])
    await assert.rejects(run(), /credential no longer valid/);
  assert.equal(calls, 4);
  const after = await f.app.city.db.query<{ task_stages: string[] }>(
    'SELECT task_stages FROM rooms WHERE id=$1',
    [roomId],
  );
  assert.deepEqual(after.rows[0]!.task_stages, ['Building', 'Shipped']);
});
