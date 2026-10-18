import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createRoomTasks } from '../server/rooms/tasks-service.js';
import { registerRoomTasksMigration } from '../server/rooms/tasks-schema.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import type { RoomLimits } from '../server/rooms/contract.js';

registerRoomTasksMigration();

/**
 * Room tasks PR1, claims core (docs/ROOM_TASKS.md): create/get/list, claim with the
 * 409 path, renew/release, lazy lapse without a cron, events, closed rooms and the
 * binding review notes. Synthetic data only.
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
let addressCounter = 1;
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
  return { id, key: minted.json().workspace_key as string };
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
async function setLease(app: App, taskId: string, expiresAt: number, graceMs: number) {
  await app.city.db.query(
    'UPDATE room_tasks SET claim_expires_at=$2, claim_grace_ms=$3 WHERE id=$1',
    [taskId, expiresAt, graceMs],
  );
}

test('create/get/list: T-numbers, replay, untrusted titles verbatim', async (t) => {
  const { tasks, a, roomId } = await roomFixture(t);
  const first = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Fix the <flaky> test — T&Cs "quoted"',
    body: 'Steps:\n\n1. Reproduce\n2. Fix',
    idempotency_key: randomUUID(),
  });
  assert.equal(first.replayed, false);
  assert.equal(first.task.number, 1);
  assert.equal(first.task.status, 'open');
  assert.equal(first.task.claim, null);
  assert.equal(first.task.title, 'Fix the <flaky> test — T&Cs "quoted"');
  assert.deepEqual(first.task.attachment_ids, []);
  const second = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Second item',
    idempotency_key: randomUUID(),
  });
  assert.equal(second.task.number, 2);
  const fetched = await tasks.get(p(a.id), { room_id: roomId, task_id: first.task.id });
  assert.deepEqual(fetched.task, first.task);
  const listed = await tasks.list(p(a.id), { room_id: roomId });
  assert.deepEqual(
    listed.tasks.map((item) => item.number),
    [1, 2],
  );
  // Same key, same body: replay, no new task.
  const key = randomUUID();
  const once = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Replay me',
    idempotency_key: key,
  });
  const twice = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Replay me',
    idempotency_key: key,
  });
  assert.equal(twice.replayed, true);
  assert.equal(twice.task.id, once.task.id);
  assert.equal((await tasks.list(p(a.id), { room_id: roomId })).tasks.length, 3);
  // Pages: next_after is the last number shown, has_more says whether another page follows.
  const page1 = await tasks.list(p(a.id), { room_id: roomId, limit: 2 });
  assert.deepEqual(
    page1.tasks.map((item) => item.number),
    [1, 2],
  );
  assert.equal(page1.next_after, 2);
  assert.equal(page1.has_more, true);
  const page2 = await tasks.list(p(a.id), { room_id: roomId, limit: 2, after_number: 2 });
  assert.deepEqual(
    page2.tasks.map((item) => item.number),
    [3],
  );
  assert.equal(page2.next_after, 3);
  assert.equal(page2.has_more, false);
  // Same key, different body: conflict.
  const conflict = await failsCode(
    tasks.create(p(a.id), { room_id: roomId, title: 'Something else', idempotency_key: key }),
    'idempotency_conflict',
  );
  assert.equal(conflict.statusCode, 409);
});

test('internal task execution commits its outcome with the task or rolls both back', async (t) => {
  const { app, tasks, a, roomId } = await roomFixture(t);
  await app.city.db.query('CREATE TABLE task_outcome_fixture (task_id text PRIMARY KEY)');
  const input = { room_id: roomId, title: 'Atomic task', idempotency_key: randomUUID() };
  await assert.rejects(
    tasks.create(p(a.id), input, {
      execute: async (tx, effect) => {
        const result = await effect();
        await tx.query('INSERT INTO task_outcome_fixture VALUES ($1)', [result.task.id]);
        throw new Error('outcome commit failed');
      },
    }),
    /outcome commit failed/,
  );
  assert.equal((await app.city.db.query('SELECT 1 FROM room_tasks')).rows.length, 0);
  assert.equal((await app.city.db.query('SELECT 1 FROM task_outcome_fixture')).rows.length, 0);
  const result = await tasks.create(p(a.id), input, {
    execute: async (tx, effect) => {
      const created = await effect();
      await tx.query('INSERT INTO task_outcome_fixture VALUES ($1)', [created.task.id]);
      return created;
    },
  });
  assert.equal(result.task.number, 1);
  assert.equal((await app.city.db.query('SELECT 1 FROM task_outcome_fixture')).rows.length, 1);
  let replayChecked = false;
  const replay = await tasks.create(p(a.id), input, {
    execute: async (_tx, effect) => {
      replayChecked = true;
      return effect();
    },
  });
  assert.equal(replayChecked, true, 'the internal guard also runs for a replay');
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, result.task.id);
});

test('create validates: 16 KB body cap, attachments fail closed without migration 27', async (t) => {
  const { app, tasks, a, roomId } = await roomFixture(t);
  await assert.rejects(
    tasks.create(p(a.id), {
      room_id: roomId,
      title: 'Too big',
      body: 'x'.repeat(16_385),
      idempotency_key: randomUUID(),
    }),
  );
  const kept = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Exactly at cap',
    body: 'y'.repeat(16_384),
    idempotency_key: randomUUID(),
  });
  assert.equal(kept.task.body.length, 16_384);
  void app;
  const notReady = await failsCode(
    tasks.create(p(a.id), {
      room_id: roomId,
      title: 'Needs a file',
      attachment_ids: [randomUUID()],
      idempotency_key: randomUUID(),
    }),
    'attachment_not_ready',
  );
  assert.equal(notReady.statusCode, 409);
});

test('claim: token shape, single holder, task_claimed details, re-issue mints new', async (t) => {
  const { app, tasks, a, b, host, member, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Claim me',
    idempotency_key: randomUUID(),
  });
  const claimed = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    ttl_minutes: 30,
    idempotency_key: randomUUID(),
  });
  assert.match(claimed.claim_token, /^ccclaim_[A-Za-z0-9_-]{22}$/);
  assert.equal(claimed.generation, 1);
  assert.equal(claimed.task.status, 'claimed');
  assert.equal(claimed.task.claim?.agent_id, host);
  assert.ok(Date.parse(claimed.task.claim!.expires_at) > Date.now() + 29 * 60_000);
  assert.ok(
    Date.parse(claimed.task.claim!.grace_until) > Date.parse(claimed.task.claim!.expires_at),
  );
  // Only the hash is stored; the token never reaches the row or the logs.
  const stored = (
    await app.city.db.query<{ claim_token_hash: string; claim_agent_id: string }>(
      'SELECT claim_token_hash,claim_agent_id FROM room_tasks WHERE id=$1',
      [made.task.id],
    )
  ).rows[0]!;
  assert.match(stored.claim_token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(stored.claim_token_hash, claimed.claim_token);
  assert.equal(stored.claim_agent_id, host);
  // A second agent loses with task_claimed details.
  const denied = await failsCode(
    tasks.claim(p(b.id), {
      room_id: roomId,
      task_id: made.task.id,
      agent_id: member,
      idempotency_key: randomUUID(),
    }),
    'task_claimed',
  );
  assert.equal(denied.statusCode, 409);
  assert.equal(denied.details.claimed_by, host);
  assert.equal(denied.details.expires_at, claimed.expires_at);
  assert.equal(denied.details.grace_until, claimed.grace_until);
  // Same-agent retry re-issues: a NEW token, never the old one.
  const reissued = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  assert.notEqual(reissued.claim_token, claimed.claim_token);
  assert.equal(reissued.generation, 2);
  const staleRenew = await failsCode(
    tasks.renew(p(a.id), {
      room_id: roomId,
      task_id: made.task.id,
      claim_token: claimed.claim_token,
    }),
    'claim_stale',
  );
  assert.equal(staleRenew.statusCode, 409);
  assert.deepEqual(staleRenew.details, { current_holder: host, generation: 2 });
});

test('uniform 404 room_not_found for non-members; task_not_found for members', async (t) => {
  const { app, tasks, a, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Hidden',
    idempotency_key: randomUUID(),
  });
  const outsider = await owner(app, 'Task outsider workspace');
  for (const run of [
    tasks.get(p(outsider.id), { room_id: roomId, task_id: made.task.id }),
    tasks.list(p(outsider.id), { room_id: roomId }),
    tasks.claim(p(outsider.id), {
      room_id: roomId,
      task_id: made.task.id,
      idempotency_key: randomUUID(),
    }),
    tasks.events(p(outsider.id), { room_id: roomId, task_id: made.task.id }),
  ]) {
    const err = await failsCode(run, 'room_not_found');
    assert.equal(err.statusCode, 404);
  }
  const missing = await failsCode(
    tasks.get(p(a.id), { room_id: roomId, task_id: randomUUID() }),
    'task_not_found',
  );
  assert.equal(missing.statusCode, 404);
});

test('renew extends the lease without a token; foreign tokens change nothing', async (t) => {
  const { tasks, a, host, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Renew me',
    idempotency_key: randomUUID(),
  });
  const claimed = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    ttl_minutes: 5,
    idempotency_key: randomUUID(),
  });
  const renewed = await tasks.renew(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    claim_token: claimed.claim_token,
    ttl_minutes: 60,
  });
  assert.ok(!('claim_token' in renewed), 'renew never returns a token');
  assert.ok(Date.parse(renewed.expires_at) > Date.parse(claimed.expires_at));
  assert.equal(renewed.task.claim?.generation, 1);
  const before = (await tasks.get(p(a.id), { room_id: roomId, task_id: made.task.id })).task;
  const foreign = await failsCode(
    tasks.renew(p(a.id), {
      room_id: roomId,
      task_id: made.task.id,
      claim_token: 'ccclaim_foreigntoken00000000000001',
    }),
    'claim_stale',
  );
  assert.deepEqual(foreign.details, { current_holder: host, generation: 1 });
  const after = (await tasks.get(p(a.id), { room_id: roomId, task_id: made.task.id })).task;
  assert.deepEqual(after, before);
});

test('release opens the task; the old token dies at once', async (t) => {
  const { tasks, a, b, host, member, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Release me',
    idempotency_key: randomUUID(),
  });
  const claimed = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  const released = await tasks.release(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    claim_token: claimed.claim_token,
  });
  assert.equal(released.released, true);
  assert.equal(released.task.status, 'open');
  assert.equal(released.task.claim, null);
  const again = await failsCode(
    tasks.release(p(a.id), {
      room_id: roomId,
      task_id: made.task.id,
      claim_token: claimed.claim_token,
    }),
    'claim_stale',
  );
  assert.deepEqual(again.details, { current_holder: null, generation: 2 });
  const taken = await tasks.claim(p(b.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: member,
    idempotency_key: randomUUID(),
  });
  assert.equal(taken.task.claim?.agent_id, member);
  assert.equal(taken.generation, 3);
});

test('host force-release needs no token; others need one', async (t) => {
  const { tasks, a, b, host, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Take over',
    idempotency_key: randomUUID(),
  });
  const claimed = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  void claimed;
  const denied = await failsCode(
    tasks.release(p(b.id), { room_id: roomId, task_id: made.task.id }),
    'claim_token_required',
  );
  assert.equal(denied.statusCode, 400);
  const forced = await tasks.release(p(a.id), { room_id: roomId, task_id: made.task.id });
  assert.equal(forced.released, true);
  assert.equal(forced.task.status, 'open');
  const idle = await tasks.release(p(a.id), { room_id: roomId, task_id: made.task.id });
  assert.equal(idle.released, false);
});

test('lapse without a cron: read after lapse shows open, then claim wins', async (t) => {
  const { app, tasks, a, b, host, member, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Lapse me',
    idempotency_key: randomUUID(),
  });
  await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  await setLease(app, made.task.id, Date.now() - 600_000, 60_000);
  const read = await tasks.get(p(b.id), { room_id: roomId, task_id: made.task.id });
  assert.equal(read.task.status, 'open');
  assert.equal(read.task.claim, null);
  // The CHECK held: status open with every claim column cleared.
  const row = (
    await app.city.db.query<{
      status: string;
      claim_agent_id: string | null;
      claim_token_hash: string | null;
      claim_expires_at: string | null;
    }>(
      'SELECT status,claim_agent_id,claim_token_hash,claim_expires_at FROM room_tasks WHERE id=$1',
      [made.task.id],
    )
  ).rows[0]!;
  assert.deepEqual(
    [row.status, row.claim_agent_id, row.claim_token_hash, row.claim_expires_at],
    ['open', null, null, null],
  );
  const taken = await tasks.claim(p(b.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: member,
    idempotency_key: randomUUID(),
  });
  assert.equal(taken.task.claim?.agent_id, member);
});

test('events: append-only, ordered, keyset-paged', async (t) => {
  const { tasks, a, host, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Evented',
    idempotency_key: randomUUID(),
  });
  const claimed = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  await tasks.renew(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    claim_token: claimed.claim_token,
  });
  await tasks.release(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    claim_token: claimed.claim_token,
  });
  const first = await tasks.events(p(a.id), { room_id: roomId, task_id: made.task.id, limit: 2 });
  assert.deepEqual(
    first.events.map((e) => e.action),
    ['created', 'claimed'],
  );
  assert.equal(first.has_more, true);
  assert.ok(first.next_after);
  const second = await tasks.events(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    after_id: first.next_after!,
  });
  assert.deepEqual(
    second.events.map((e) => e.action),
    ['renewed', 'released'],
  );
  assert.equal(second.has_more, false);
});

test('closed rooms are read-only for tasks; guests read but cannot claim', async (t) => {
  const { app, tasks, a, b, host, member, roomId } = await roomFixture(t);
  const closed = await call(app, a.key, 'city_room_close', { room_id: roomId });
  assert.equal(closed.statusCode, 200, closed.body);
  const noCreate = await failsCode(
    tasks.create(p(a.id), { room_id: roomId, title: 'Late', idempotency_key: randomUUID() }),
    'room_closed',
  );
  assert.equal(noCreate.statusCode, 409);
  const made = await app.city.db.query<{ id: string }>(
    `INSERT INTO room_tasks(id,room_id,number,title,body,status,created_by_agent_id,created_by_owner_id,
      created_at,updated_at,idempotency_key,request_hash)
     VALUES($1,$2,1,'Seeded','', 'open',$3,$4,$5,$5,$6,$7) RETURNING id`,
    [randomUUID(), roomId, host, a.id, Date.now(), randomUUID(), randomUUID()],
  );
  const taskId = made.rows[0]!.id;
  const noClaim = await failsCode(
    tasks.claim(p(a.id), {
      room_id: roomId,
      task_id: taskId,
      agent_id: host,
      idempotency_key: randomUUID(),
    }),
    'room_closed',
  );
  assert.equal(noClaim.statusCode, 409);
  // Reads still work on a closed room.
  assert.equal(
    (await tasks.get(p(b.id), { room_id: roomId, task_id: taskId })).task.status,
    'open',
  );

  // A guest member reads but cannot write.
  const fresh = await roomFixture(t);
  const guestAgent = await agent(fresh.app, fresh.b.key, 'Guest watcher');
  await fresh.app.city.db.query(
    `INSERT INTO room_members(room_id,agent_id,owner_id,role,owner_label,visible_from_seq,joined_at,joined_by)
     VALUES($1,$2,$3,'guest','Task member workspace',0,$4,'the test owner')`,
    [fresh.roomId, guestAgent, fresh.b.id, Date.now()],
  );
  const seeded = await fresh.tasks.create(p(fresh.a.id), {
    room_id: fresh.roomId,
    title: 'Guest view',
    idempotency_key: randomUUID(),
  });
  assert.equal(
    (
      await fresh.tasks.get(p(fresh.b.id), {
        room_id: fresh.roomId,
        task_id: seeded.task.id,
      })
    ).task.title,
    'Guest view',
  );
  const guestDenied = await failsCode(
    fresh.tasks.claim(p(fresh.b.id), {
      room_id: fresh.roomId,
      task_id: seeded.task.id,
      agent_id: guestAgent,
      idempotency_key: randomUUID(),
    }),
    'read_only',
  );
  assert.equal(guestDenied.statusCode, 403);
  void member;
});

test('rate limits are charged before work; reads are free', async (t) => {
  const { tasks, a, host, roomId, charges } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Budgeted',
    idempotency_key: randomUUID(),
  });
  assert.deepEqual(charges, [`room-task-create:${a.id}:${roomId}`]);
  const claimed = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  assert.ok(charges.some((key) => key === `room-task-claim:${host}`));
  const before = charges.length;
  await tasks.get(p(a.id), { room_id: roomId, task_id: made.task.id });
  await tasks.list(p(a.id), { room_id: roomId });
  await tasks.events(p(a.id), { room_id: roomId, task_id: made.task.id });
  await tasks.renew(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    claim_token: claimed.claim_token,
  });
  assert.equal(charges.length, before + 1);
  assert.ok(charges.at(-1)!.startsWith('room-task-claim:'));
});

test('claim refuses done/cancelled/in_review with 409 task_not_claimable', async (t) => {
  const { app, tasks, a, host, roomId } = await roomFixture(t);
  for (const status of ['done', 'cancelled', 'in_review'] as const) {
    const made = await tasks.create(p(a.id), {
      room_id: roomId,
      title: `Closed ${status}`,
      idempotency_key: randomUUID(),
    });
    // CHECK-consistent: closed rows carry no holder, so clear the claim_* group.
    await app.city.db.query(
      `UPDATE room_tasks SET status=$2, claim_agent_id=NULL, claim_owner_id=NULL,
        claim_expires_at=NULL, claim_ttl_ms=NULL, claim_grace_ms=NULL,
        claim_token_hash=NULL WHERE id=$1`,
      [made.task.id, status],
    );
    const eventsBefore = (
      await app.city.db.query<{ n: string }>(
        'SELECT count(*) AS n FROM room_task_events WHERE task_id=$1',
        [made.task.id],
      )
    ).rows[0]!.n;
    const denied = await failsCode(
      tasks.claim(p(a.id), {
        room_id: roomId,
        task_id: made.task.id,
        agent_id: host,
        idempotency_key: randomUUID(),
      }),
      'task_not_claimable',
    );
    assert.equal(denied.statusCode, 409);
    assert.deepEqual(denied.details, { status });
    const row = (
      await app.city.db.query<{
        status: string;
        claim_agent_id: string | null;
        claim_token_hash: string | null;
      }>('SELECT status,claim_agent_id,claim_token_hash FROM room_tasks WHERE id=$1', [
        made.task.id,
      ])
    ).rows[0]!;
    assert.deepEqual([row.status, row.claim_agent_id, row.claim_token_hash], [status, null, null]);
    const eventsAfter = (
      await app.city.db.query<{ n: string }>(
        'SELECT count(*) AS n FROM room_task_events WHERE task_id=$1',
        [made.task.id],
      )
    ).rows[0]!.n;
    assert.equal(eventsAfter, eventsBefore);
  }
});

test('an owner the host muted cannot create, claim, renew or post a result; it may release', async (t) => {
  const { app, tasks, a, b, member, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Shared work',
    idempotency_key: randomUUID(),
  });
  const other = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Other work',
    idempotency_key: randomUUID(),
  });
  const claimed = await tasks.claim(p(b.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: member,
    ttl_minutes: 30,
    idempotency_key: randomUUID(),
  });
  // The host mutes the member (migration 35; the route is covered in room-management tests).
  await app.city.db.query(
    "UPDATE room_members SET muted_at=$3, mute_reason='Slow down' WHERE room_id=$1 AND agent_id=$2",
    [roomId, member, Date.now()],
  );
  const refusals = [
    tasks.create(p(b.id), { room_id: roomId, title: 'Muted task', idempotency_key: randomUUID() }),
    tasks.claim(p(b.id), {
      room_id: roomId,
      task_id: other.task.id,
      agent_id: member,
      idempotency_key: randomUUID(),
    }),
    tasks.renew(p(b.id), {
      room_id: roomId,
      task_id: made.task.id,
      claim_token: claimed.claim_token,
      ttl_minutes: 60,
    }),
    tasks.result(p(b.id), {
      room_id: roomId,
      task_id: made.task.id,
      claim_token: claimed.claim_token,
      evidence: { kind: 'proposal', ref: 'proposal-7', revision: 'rev-3' },
    }),
  ];
  for (const run of refusals) {
    const error = await failsCode(run, 'muted_in_room');
    assert.equal(error.statusCode, 403);
    assert.deepEqual(error.details, { reason: 'Slow down' });
    assert.match(error.message ?? '', /Slow down/);
  }
  const listed = await tasks.list(p(a.id), { room_id: roomId });
  assert.equal((listed as { tasks: unknown[] }).tasks.length, 2, 'no task was created');
  // Handing the work back is allowed.
  const released = await tasks.release(p(b.id), {
    room_id: roomId,
    task_id: made.task.id,
    claim_token: claimed.claim_token,
  });
  assert.equal(released.released, true);
  // The host's writes are never muted.
  await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Host task',
    idempotency_key: randomUUID(),
  });
});

test('a principal guard runs inside the task transaction and refuses the call', async (t) => {
  const { tasks, b, roomId } = await roomFixture(t);
  let checks = 0;
  const refusedGuard = async () => {
    checks += 1;
    throw Object.assign(new Error('revoked'), { errorCode: 'room_credential_invalid' });
  };
  await failsCode(
    tasks.create(
      { ...p(b.id), guard: refusedGuard },
      { room_id: roomId, title: 'Guarded', idempotency_key: randomUUID() },
    ),
    'room_credential_invalid',
  );
  await failsCode(
    tasks.list({ ...p(b.id), guard: refusedGuard }, { room_id: roomId }),
    'room_credential_invalid',
  );
  assert.equal(checks, 2);
  const listed = await tasks.list({ ...p(b.id), guard: async () => {} }, { room_id: roomId });
  assert.equal(listed.tasks.length, 0, 'nothing was created');
});
