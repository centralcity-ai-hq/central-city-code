import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import type { Database, Transaction } from '../server/database.js';
import { createRoomTasks, type TaskPrincipal } from '../server/rooms/tasks-service.js';
import { registerRoomTasksMigration } from '../server/rooms/tasks-schema.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';

registerRoomTasksMigration();

/**
 * Idempotency keys on task create and comment add are unique per owner across every room
 * (tasks-schema.ts). A key reused in another room is `409 idempotency_conflict`, and a retry
 * that overlaps the first request (both miss the receipt lookup) replays instead of failing
 * on the unique index with a 500. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
let addressCounter = 171;

async function ok(app: App, key: string, name: string, args: unknown = {}) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify(args),
  });
  assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
  return res.json() as any;
}
async function owner(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.40`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({
      name: `Key co-owner ${addressCounter}`,
      password: 'Synthetic key co-owner password',
    }),
    remoteAddress: `198.51.${addressCounter++}.41`,
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
    payload: JSON.stringify({ label: 'key tester', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return { id, key: minted.json().workspace_key as string };
}
const p = (operatorId: string): TaskPrincipal => ({
  operatorId,
  actor: 'the test owner',
  origin: 'http://localhost',
});

/**
 * Wraps the database so the next receipt lookup matching `pattern` comes back empty, as it
 * does for a retry whose first attempt has not committed yet when the lookup runs.
 */
function racingDb(db: Database) {
  const state = { hide: null as RegExp | null, hidden: 0 };
  const wrap = (tx: Transaction): Transaction => ({
    exec: (sql) => tx.exec(sql),
    query: async <T>(sql: string, params?: unknown[]) => {
      if (state.hide && state.hide.test(sql)) {
        state.hide = null;
        state.hidden++;
        return { rows: [] as T[] };
      }
      return tx.query<T>(sql, params);
    },
  });
  const wrapped: Database = {
    ...wrap(db),
    transaction: (action) => db.transaction((tx) => action(wrap(tx))),
    close: () => db.close(),
  };
  return { db: wrapped, state };
}

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const race = racingDb(app.city.db);
  const tasks = createRoomTasks({
    db: race.db,
    clock: () => Date.now(),
    limit: async () => {},
    secret: 'test-rooms-secret',
  });
  const a = await owner(app, 'Key host workspace');
  const host = (
    await ok(app, a.key, 'city_create_agent', {
      name: 'Key host',
      description: 'Synthetic key member',
      capability: 'research',
      mode: 'external',
      idempotencyKey: randomUUID(),
    })
  ).agent.id as string;
  const room = async (name: string) =>
    (
      await ok(app, a.key, 'city_create_room', {
        agent_id: host,
        name,
        idempotency_key: randomUUID(),
      })
    ).room.id as string;
  return { app, tasks, race, a, roomA: await room('Key desk A'), roomB: await room('Key desk B') };
}
async function refusal(run: Promise<unknown>) {
  try {
    await run;
  } catch (error) {
    return error as { statusCode?: number; errorCode?: string; code?: string };
  }
  return assert.fail('expected a refusal');
}

test('task create: the same idempotency_key in another room is 409 idempotency_conflict', async (t) => {
  const { app, tasks, a, roomA, roomB } = await fixture(t);
  const key = randomUUID();
  const first = await tasks.create(p(a.id), {
    room_id: roomA,
    title: 'Same',
    idempotency_key: key,
  });
  assert.equal(first.replayed, false);
  const err = await refusal(
    tasks.create(p(a.id), { room_id: roomB, title: 'Same', idempotency_key: key }),
  );
  assert.equal(err.statusCode, 409, String(err));
  assert.equal(err.errorCode, 'idempotency_conflict');
  // The replay in its own room still works, and room B got nothing.
  const replay = await tasks.create(p(a.id), {
    room_id: roomA,
    title: 'Same',
    idempotency_key: key,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, first.task.id);
  const inB = await app.city.db.query('SELECT 1 FROM room_tasks WHERE room_id=$1', [roomB]);
  assert.equal(inB.rows.length, 0);
});

test('task create: an overlapping retry that misses the receipt replays, never a 500', async (t) => {
  const { app, tasks, race, a, roomA, roomB } = await fixture(t);
  const key = randomUUID();
  const first = await tasks.create(p(a.id), {
    room_id: roomA,
    title: 'Race',
    idempotency_key: key,
  });
  race.state.hide = /FROM room_tasks WHERE created_by_owner_id=\$1 AND idempotency_key=\$2/;
  const replay = await tasks.create(p(a.id), {
    room_id: roomA,
    title: 'Race',
    idempotency_key: key,
  });
  assert.equal(race.state.hidden, 1, 'the receipt lookup was hidden once');
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, first.task.id);
  // The cross-room race (another room's lock) is refused cleanly too.
  race.state.hide = /FROM room_tasks WHERE created_by_owner_id=\$1 AND idempotency_key=\$2/;
  const err = await refusal(
    tasks.create(p(a.id), { room_id: roomB, title: 'Race', idempotency_key: key }),
  );
  assert.equal(race.state.hidden, 2);
  assert.equal(err.errorCode, 'idempotency_conflict', String(err));
  const count = await app.city.db.query('SELECT 1 FROM room_tasks WHERE created_by_owner_id=$1', [
    a.id,
  ]);
  assert.equal(count.rows.length, 1);
});

test('comment add: an overlapping retry that misses the receipt replays, never a 500', async (t) => {
  const { app, tasks, race, a, roomA } = await fixture(t);
  const task = (
    await tasks.create(p(a.id), { room_id: roomA, title: 'Talk', idempotency_key: randomUUID() })
  ).task;
  const base = { room_id: roomA, task_id: task.id };
  const key = randomUUID();
  const once = await tasks.commentAdd(p(a.id), { ...base, body: 'Once', idempotency_key: key });
  race.state.hide = /FROM room_task_comments WHERE author_owner_id=\$1 AND idempotency_key=\$2/;
  const replay = await tasks.commentAdd(p(a.id), { ...base, body: 'Once', idempotency_key: key });
  assert.equal(race.state.hidden, 1, 'the receipt lookup was hidden once');
  assert.equal(replay.replayed, true);
  assert.equal(replay.comment.id, once.comment.id);
  // A different body under the same key, racing, is still a conflict.
  race.state.hide = /FROM room_task_comments WHERE author_owner_id=\$1 AND idempotency_key=\$2/;
  const err = await refusal(
    tasks.commentAdd(p(a.id), { ...base, body: 'Other', idempotency_key: key }),
  );
  assert.equal(err.errorCode, 'idempotency_conflict', String(err));
  const rows = await app.city.db.query('SELECT 1 FROM room_task_comments WHERE task_id=$1', [
    task.id,
  ]);
  assert.equal(rows.rows.length, 1);
});
