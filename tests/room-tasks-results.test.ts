import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createRoomTasks, sweepLapsedTasks } from '../server/rooms/tasks-service.js';
import { registerRoomTasksMigration } from '../server/rooms/tasks-schema.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import type { RoomLimits } from '../server/rooms/contract.js';

registerRoomTasksMigration();

/**
 * Room tasks PR2, results + lapse (docs/ROOM_TASKS.md):
 * result binding with fake step-2 evidence, host review/cancel, stale_rejected
 * audit, the lapse sweep, and the claim-stale matrix. Backdated rows stand in for
 * the clock; nothing here sleeps. Synthetic data only.
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
let addressCounter = 301;
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
async function eventActions(app: App, taskId: string) {
  return (
    await app.city.db.query<{ action: string }>(
      'SELECT action FROM room_task_events WHERE task_id=$1 ORDER BY created_at, id',
      [taskId],
    )
  ).rows.map((row) => row.action);
}
/** Fake step-2 evidence until proposals merge (contract validates the shape only). */
const evidence = (over: Record<string, string> = {}) => ({
  kind: 'proposal',
  ref: 'proposal-7',
  revision: 'rev-3',
  ...over,
});

test('result: holder posts evidence, claimed -> in_review with the claim cleared', async (t) => {
  const { tasks, charges, a, host, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Finish it',
    idempotency_key: randomUUID(),
  });
  const claimed = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  const funded = charges.length;
  const posted = await tasks.result(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    claim_token: claimed.claim_token,
    evidence: evidence(),
  });
  assert.equal(posted.task.status, 'in_review');
  assert.equal(posted.task.claim, null);
  assert.deepEqual(posted.task.result, evidence());
  // Posting charges no limiter bucket: one result per claim needs no budget.
  assert.equal(charges.length, funded);
  // The CHECK held: in_review carries no holder, token hash or expiry.
  const done = await tasks.get(p(a.id), { room_id: roomId, task_id: made.task.id });
  assert.deepEqual(done.task, posted.task);
  // The old token is dead for every claimant write.
  await failsCode(
    tasks.renew(p(a.id), {
      room_id: roomId,
      task_id: made.task.id,
      claim_token: claimed.claim_token,
    }),
    'claim_stale',
  );
  await failsCode(
    tasks.result(p(a.id), {
      room_id: roomId,
      task_id: made.task.id,
      claim_token: claimed.claim_token,
      evidence: evidence({ revision: 'rev-4' }),
    }),
    'claim_stale',
  );
  // Evidence is validated, not free-form.
  await assert.rejects(
    tasks.result(p(a.id), {
      room_id: roomId,
      task_id: made.task.id,
      claim_token: claimed.claim_token,
      evidence: { kind: 'proposal', ref: 'proposal-7' },
    }),
  );
});

test('result: only the holder posts; strangers go stale and leave a stale_rejected event', async (t) => {
  const { app, tasks, a, b, host, member, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Guarded',
    idempotency_key: randomUUID(),
  });
  const claimed = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  const before = await eventActions(app, made.task.id);
  const denied = await failsCode(
    tasks.result(p(b.id), {
      room_id: roomId,
      task_id: made.task.id,
      claim_token: 'ccclaim_strangertoken00000000000001',
      evidence: evidence(),
    }),
    'claim_stale',
  );
  assert.equal(denied.statusCode, 409);
  // The refused write rolled back, but its audit survives in its own statement.
  const after = await eventActions(app, made.task.id);
  assert.deepEqual(after, [...before, 'stale_rejected']);
  const audit = (
    await app.city.db.query<{
      generation: string | number;
      actor: string;
      agent_id: string | null;
    }>('SELECT generation,actor,agent_id FROM room_task_events WHERE task_id=$1 AND action=$2', [
      made.task.id,
      'stale_rejected',
    ])
  ).rows;
  assert.equal(audit.length, 1);
  assert.equal(Number(audit[0]!.generation), claimed.generation);
  assert.equal(audit[0]!.agent_id, host);
  // The attempt itself is recorded in details: an opaque per-task owner key (never the
  // operator id) plus the caller's only live member agent.
  const detail = (
    await app.city.db.query<{ details: unknown }>(
      "SELECT details FROM room_task_events WHERE task_id=$1 AND action='stale_rejected'",
      [made.task.id],
    )
  ).rows[0]!.details;
  const parsed = (typeof detail === 'string' ? JSON.parse(detail) : detail) as {
    attempted_by: string;
    attempted_by_owner?: string;
    attempted_by_agent: string | null;
  };
  assert.equal(parsed.attempted_by_owner, undefined);
  assert.match(parsed.attempted_by, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(!JSON.stringify(parsed).includes(b.id), 'no operator id is stored');
  assert.equal(parsed.attempted_by_agent, member);
  // The task itself is untouched: still the holder's claim, no evidence.
  const seen = await tasks.get(p(a.id), { room_id: roomId, task_id: made.task.id });
  assert.equal(seen.task.status, 'claimed');
  assert.equal(seen.task.claim?.agent_id, host);
  assert.equal(seen.task.result, null);
  void member;
});

test('review: host approves in_review -> done; done tasks are not claimable', async (t) => {
  const { app, tasks, a, b, host, member, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Ship it',
    idempotency_key: randomUUID(),
  });
  const claimed = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  await tasks.result(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    claim_token: claimed.claim_token,
    evidence: evidence(),
  });
  // Approving an open task is a 409, not a silent no-op.
  const fresh = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Not ready',
    idempotency_key: randomUUID(),
  });
  const early = await failsCode(
    tasks.update(p(a.id), { room_id: roomId, task_id: fresh.task.id, decision: 'approve' }),
    'task_not_in_review',
  );
  assert.deepEqual(early.details, { status: 'open' });
  // Only the host reviews.
  const intruder = await failsCode(
    tasks.update(p(b.id), { room_id: roomId, task_id: made.task.id, decision: 'approve' }),
    'host_required',
  );
  assert.equal(intruder.statusCode, 403);
  const done = await tasks.update(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    decision: 'approve',
  });
  assert.equal(done.decision, 'approve');
  assert.equal(done.applied, true);
  assert.equal(done.task.status, 'done');
  assert.deepEqual(done.task.result, evidence());
  assert.deepEqual(await eventActions(app, made.task.id), [
    'created',
    'claimed',
    'result_posted',
    'approved',
  ]);
  const shut = await failsCode(
    tasks.claim(p(b.id), {
      room_id: roomId,
      task_id: made.task.id,
      agent_id: member,
      idempotency_key: randomUUID(),
    }),
    'task_not_claimable',
  );
  assert.deepEqual(shut.details, { status: 'done' });
});

test('review: host rejects in_review -> open with evidence cleared; claimable again', async (t) => {
  const { app, tasks, a, b, host, member, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Rework it',
    idempotency_key: randomUUID(),
  });
  const claimed = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  await tasks.result(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    claim_token: claimed.claim_token,
    evidence: evidence(),
  });
  const back = await tasks.update(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    decision: 'reject',
  });
  assert.equal(back.applied, true);
  assert.equal(back.task.status, 'open');
  assert.equal(back.task.claim, null);
  assert.equal(back.task.result, null);
  assert.deepEqual(await eventActions(app, made.task.id), [
    'created',
    'claimed',
    'result_posted',
    'rejected',
  ]);
  const retaken = await tasks.claim(p(b.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: member,
    idempotency_key: randomUUID(),
  });
  assert.equal(retaken.task.claim?.agent_id, member);
});

test('update: host cancels from claimed; done is terminal, repeat cancel is idle', async (t) => {
  const { tasks, a, b, host, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Drop it',
    idempotency_key: randomUUID(),
  });
  const claimed = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  void claimed;
  const refused = await failsCode(
    tasks.update(p(b.id), { room_id: roomId, task_id: made.task.id, decision: 'cancel' }),
    'host_required',
  );
  assert.equal(refused.statusCode, 403);
  const gone = await tasks.update(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    decision: 'cancel',
  });
  assert.equal(gone.decision, 'cancel');
  assert.equal(gone.applied, true);
  assert.equal(gone.task.status, 'cancelled');
  assert.equal(gone.task.claim, null);
  const idle = await tasks.update(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    decision: 'cancel',
  });
  assert.equal(idle.applied, false);
  assert.equal(idle.task.status, 'cancelled');
  // Done is terminal: cancelling it is a 409.
  const shipped = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Shipped',
    idempotency_key: randomUUID(),
  });
  const held = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: shipped.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  await tasks.result(p(a.id), {
    room_id: roomId,
    task_id: shipped.task.id,
    claim_token: held.claim_token,
    evidence: evidence(),
  });
  await tasks.update(p(a.id), { room_id: roomId, task_id: shipped.task.id, decision: 'approve' });
  const terminal = await failsCode(
    tasks.update(p(a.id), { room_id: roomId, task_id: shipped.task.id, decision: 'cancel' }),
    'task_closed',
  );
  assert.deepEqual(terminal.details, { status: 'done' });
});

test('sweepLapsedTasks: one batch-limited UPDATE lapses past-grace claims with events', async (t) => {
  const { app, tasks, a, b, host, member, roomId } = await roomFixture(t);
  const ids: string[] = [];
  for (const [ownerId, agentId, title] of [
    [a.id, host, 'Due one'],
    [b.id, member, 'Due two'],
    [a.id, host, 'Live one'],
  ] as const) {
    const made = await tasks.create(p(ownerId), {
      room_id: roomId,
      title,
      idempotency_key: randomUUID(),
    });
    await tasks.claim(p(ownerId), {
      room_id: roomId,
      task_id: made.task.id,
      agent_id: agentId,
      idempotency_key: randomUUID(),
    });
    ids.push(made.task.id);
  }
  await setLease(app, ids[0]!, Date.now() - 600_000, 60_000);
  await setLease(app, ids[1]!, Date.now() - 600_000, 60_000);
  const swept = await sweepLapsedTasks(app.city.db, 10);
  assert.equal(swept.lapsed.length, 2);
  assert.deepEqual(swept.lapsed.map((row) => row.task_id).sort(), [ids[0], ids[1]].sort());
  for (const row of swept.lapsed) {
    assert.equal(row.generation, 2);
    assert.deepEqual(await eventActions(app, row.task_id), ['created', 'claimed', 'lapsed']);
  }
  // The live lease is untouched, and the sweep is CHECK-clean.
  const live = await tasks.get(p(a.id), { room_id: roomId, task_id: ids[2]! });
  assert.equal(live.task.status, 'claimed');
  const cleared = (
    await app.city.db.query<{
      status: string;
      claim_agent_id: string | null;
      claim_token_hash: string | null;
    }>('SELECT status,claim_agent_id,claim_token_hash FROM room_tasks WHERE id=$1', [ids[0]])
  ).rows[0]!;
  assert.deepEqual(
    [cleared.status, cleared.claim_agent_id, cleared.claim_token_hash],
    ['open', null, null],
  );
  // Batch limit: two more due, a limit of 1 lapses exactly one.
  for (const title of ['Due three', 'Due four']) {
    const made = await tasks.create(p(a.id), {
      room_id: roomId,
      title,
      idempotency_key: randomUUID(),
    });
    await tasks.claim(p(a.id), {
      room_id: roomId,
      task_id: made.task.id,
      agent_id: host,
      idempotency_key: randomUUID(),
    });
    await setLease(app, made.task.id, Date.now() - 600_000, 60_000);
    ids.push(made.task.id);
  }
  const one = await sweepLapsedTasks(app.city.db, 1);
  assert.equal(one.lapsed.length, 1);
  const rest = await sweepLapsedTasks(app.city.db, 10);
  assert.equal(rest.lapsed.length, 1);
  assert.notEqual(rest.lapsed[0]!.task_id, one.lapsed[0]!.task_id);
});

test('matrix: post-grace take-over needs no touch first', async (t) => {
  const { app, tasks, a, b, host, member, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Take me',
    idempotency_key: randomUUID(),
  });
  await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  await setLease(app, made.task.id, Date.now() - 600_000, 60_000);
  const taken = await tasks.claim(p(b.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: member,
    idempotency_key: randomUUID(),
  });
  assert.equal(taken.task.claim?.agent_id, member);
});

test('matrix: removed holder is released with an event on the next touch', async (t) => {
  const { app, tasks, a, b, host, member, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Held by the departed',
    idempotency_key: randomUUID(),
  });
  await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  await app.city.db.query(
    'UPDATE room_members SET removed_at=$3, removed_by=$4 WHERE room_id=$1 AND agent_id=$2',
    [roomId, host, Date.now(), 'the test owner'],
  );
  const seen = await tasks.get(p(b.id), { room_id: roomId, task_id: made.task.id });
  assert.equal(seen.task.status, 'open');
  assert.equal(seen.task.claim, null);
  assert.deepEqual(await eventActions(app, made.task.id), ['created', 'claimed', 'released']);
  const audit = (
    await app.city.db.query<{ actor: string; agent_id: string | null }>(
      'SELECT actor,agent_id FROM room_task_events WHERE task_id=$1 AND action=$2',
      [made.task.id, 'released'],
    )
  ).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.actor, 'system');
  assert.equal(audit[0]!.agent_id, host);
  // The seat is free: the other member claims it straight away.
  const taken = await tasks.claim(p(b.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: member,
    idempotency_key: randomUUID(),
  });
  assert.equal(taken.task.claim?.agent_id, member);
});

test('matrix: access_expired holder is released from the credential row at read time', async (t) => {
  const { app, tasks, a, host, member, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Held by the expired',
    idempotency_key: randomUUID(),
  });
  await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  // A synthetic expired invite credential for the holder: Relay derives
  // access_expired from this row (the member row itself stays live).
  await app.city.db.query(
    'INSERT INTO unclaimed_agent_expiry(agent_id,operator_id,expires_at) VALUES($1,$2,$3)',
    [host, a.id, Date.now() + 86_400_000],
  );
  await app.city.db.query(
    `INSERT INTO room_invite_credentials(token_hash,operator_id,agent_id,room_id,host_owner_id,
      created_at,expires_at,source_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['synthetic-expired-token', a.id, host, roomId, a.id, Date.now() - 3_600_000, 0, 'synthetic'],
  );
  const seen = await tasks.get(p(a.id), { room_id: roomId, task_id: made.task.id });
  assert.equal(seen.task.status, 'open');
  assert.equal(seen.task.claim, null);
  assert.deepEqual(await eventActions(app, made.task.id), ['created', 'claimed', 'released']);
  void member;
});

test('matrix: closed rooms release their claims on read', async (t) => {
  const { app, tasks, a, b, host, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Held at closing',
    idempotency_key: randomUUID(),
  });
  await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  const closed = await call(app, a.key, 'city_room_close', { room_id: roomId });
  assert.equal(closed.statusCode, 200, closed.body);
  const seen = await tasks.get(p(b.id), { room_id: roomId, task_id: made.task.id });
  assert.equal(seen.task.status, 'open');
  assert.equal(seen.task.claim, null);
  assert.deepEqual(await eventActions(app, made.task.id), ['created', 'claimed', 'released']);
});

test('presence: holder status is derived, never added to the views', async (t) => {
  const { tasks, a, host, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Shapely',
    idempotency_key: randomUUID(),
  });
  assert.deepEqual(Object.keys(made.task).sort(), [
    'attachment_ids',
    'body',
    'claim',
    'comment_count',
    'created_at',
    'created_by_agent_id',
    'from_message_seq',
    'id',
    'number',
    'result',
    'room_id',
    'stage',
    'status',
    'submitted_by',
    'template',
    'title',
    'updated_at',
  ]);
  const claimed = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  // No presence fields leak into the claim: exactly the PR1 keys.
  assert.deepEqual(Object.keys(claimed.task.claim!).sort(), [
    'agent_id',
    'expires_at',
    'generation',
    'grace_until',
  ]);
});

test('06c result: accepted inside lease + grace, claim_stale past grace', async (t) => {
  const { app, tasks, a, host, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Graceful',
    idempotency_key: randomUUID(),
  });
  const claimed = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  // Expired a minute ago but inside a two-minute grace: the same window renew
  // allows, so the result is accepted.
  await setLease(app, made.task.id, Date.now() - 60_000, 120_000);
  const posted = await tasks.result(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    claim_token: claimed.claim_token,
    evidence: evidence(),
  });
  assert.equal(posted.task.status, 'in_review');
  // A second task, lapsed past grace: the holder's own token is stale now.
  const late = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Too late',
    idempotency_key: randomUUID(),
  });
  const held = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: late.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  await setLease(app, late.task.id, Date.now() - 600_000, 60_000);
  const denied = await failsCode(
    tasks.result(p(a.id), {
      room_id: roomId,
      task_id: late.task.id,
      claim_token: held.claim_token,
      evidence: evidence(),
    }),
    'claim_stale',
  );
  assert.equal(denied.statusCode, 409);
  // The refused write changed nothing: the claim and its (absent) result stand.
  const kept = (
    await app.city.db.query<{ status: string; claim_agent_id: string | null; result: unknown }>(
      'SELECT status,claim_agent_id,result FROM room_tasks WHERE id=$1',
      [late.task.id],
    )
  ).rows[0]!;
  assert.deepEqual([kept.status, kept.claim_agent_id, kept.result], ['claimed', host, null]);
  assert.deepEqual(await eventActions(app, late.task.id), ['created', 'claimed', 'stale_rejected']);
  // The matrix still lapses the past-grace lease on the next read.
  const seen = await tasks.get(p(a.id), { room_id: roomId, task_id: late.task.id });
  assert.equal(seen.task.status, 'open');
});

test('06c stale_rejected: at most one per (task, actor, generation) per minute', async (t) => {
  const { app, tasks, a, b, host, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Flooded',
    idempotency_key: randomUUID(),
  });
  const claimed = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  void claimed;
  await setLease(app, made.task.id, Date.now() - 600_000, 60_000);
  const staleResult = () =>
    tasks.result(p(a.id), {
      room_id: roomId,
      task_id: made.task.id,
      claim_token: 'ccclaim_strangertoken00000000000001',
      evidence: evidence(),
    });
  // A flood of stale writes: every one is still a 409, but only the first
  // writes an audit row.
  for (let i = 0; i < 5; i++) await failsCode(staleResult(), 'claim_stale');
  const first = (
    await app.city.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM room_task_events WHERE task_id=$1 AND action='stale_rejected'",
      [made.task.id],
    )
  ).rows[0]!;
  assert.equal(Number(first.n), 1);
  // A different owner under the SAME actor label is a different key: the dedupe
  // keys on the attempting owner/agent in details, never the label.
  await failsCode(
    tasks.result(
      { operatorId: b.id, actor: 'the test owner', origin: 'http://localhost' },
      {
        room_id: roomId,
        task_id: made.task.id,
        claim_token: 'ccclaim_strangertoken00000000000001',
        evidence: evidence(),
      },
    ),
    'claim_stale',
  );
  const second = (
    await app.city.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM room_task_events WHERE task_id=$1 AND action='stale_rejected'",
      [made.task.id],
    )
  ).rows[0]!;
  assert.equal(Number(second.n), 2);
  // Both attempting owners are recorded, one row each, under distinct opaque keys.
  const owners = (
    await app.city.db.query<{ owner: string; details: unknown }>(
      `SELECT details->>'attempted_by' AS owner, details FROM room_task_events
        WHERE task_id=$1 AND action='stale_rejected'`,
      [made.task.id],
    )
  ).rows;
  assert.equal(new Set(owners.map((row) => row.owner)).size, 2);
  for (const row of owners) {
    const text = JSON.stringify(row.details);
    assert.ok(!text.includes(a.id) && !text.includes(b.id), 'no operator id is stored');
  }
});

test('06c rejected: the event keeps a copy of the cleared evidence', async (t) => {
  const { app, tasks, a, host, member, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Rework with a trail',
    idempotency_key: randomUUID(),
  });
  const claimed = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  await tasks.result(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    claim_token: claimed.claim_token,
    evidence: evidence(),
  });
  const back = await tasks.update(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    decision: 'reject',
  });
  assert.equal(back.task.status, 'open');
  assert.equal(back.task.result, null);
  // The task no longer carries the evidence, but the `rejected` event does.
  const stored = (
    await app.city.db.query<{ details: unknown }>(
      'SELECT details FROM room_task_events WHERE task_id=$1 AND action=$2',
      [made.task.id, 'rejected'],
    )
  ).rows;
  assert.equal(stored.length, 1);
  const raw = stored[0]!.details;
  assert.deepEqual(typeof raw === 'string' ? JSON.parse(raw) : raw, {
    evidence: evidence(),
    untrusted: true,
  });
  // The same copy is visible through the events view, still marked untrusted.
  const viewed = await tasks.events(p(a.id), { room_id: roomId, task_id: made.task.id });
  const rejected = viewed.events.find((item) => item.action === 'rejected');
  assert.deepEqual(rejected!.details, { evidence: evidence(), untrusted: true });
  // Approve carries no payload: its event details stay null.
  const shipped = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Approved trail',
    idempotency_key: randomUUID(),
  });
  const held = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: shipped.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  await tasks.result(p(a.id), {
    room_id: roomId,
    task_id: shipped.task.id,
    claim_token: held.claim_token,
    evidence: evidence(),
  });
  await tasks.update(p(a.id), {
    room_id: roomId,
    task_id: shipped.task.id,
    decision: 'approve',
  });
  const approved = (
    await app.city.db.query<{ details: unknown }>(
      'SELECT details FROM room_task_events WHERE task_id=$1 AND action=$2',
      [shipped.task.id, 'approved'],
    )
  ).rows;
  assert.equal(approved.length, 1);
  assert.equal(approved[0]!.details, null);
  void member;
});

test('submitted_by: the hand-in records the holder and keeps it through done', async (t) => {
  const { app, tasks, a, b, member, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Who did it',
    idempotency_key: randomUUID(),
  });
  assert.equal(made.task.submitted_by, null);
  const claimed = await tasks.claim(p(b.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: member,
    idempotency_key: randomUUID(),
  });
  assert.equal(claimed.task.submitted_by, null);
  const posted = await tasks.result(p(b.id), {
    room_id: roomId,
    task_id: made.task.id,
    claim_token: claimed.claim_token,
    evidence: evidence(),
  });
  assert.equal(posted.task.status, 'in_review');
  assert.equal(posted.task.claim, null);
  assert.equal(posted.task.submitted_by, member);
  const done = await tasks.update(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    decision: 'approve',
  });
  assert.equal(done.task.status, 'done');
  assert.equal(done.task.submitted_by, member);
  // Every reader (the host here) sees it on get and list.
  const seen = await tasks.get(p(a.id), { room_id: roomId, task_id: made.task.id });
  assert.equal(seen.task.submitted_by, member);
  const listed = await tasks.list(p(a.id), { room_id: roomId, status: 'done' });
  assert.equal(listed.tasks[0]!.submitted_by, member);
  const stored = (
    await app.city.db.query<{ submitted_by: string | null }>(
      'SELECT submitted_by FROM room_tasks WHERE id=$1',
      [made.task.id],
    )
  ).rows[0];
  assert.equal(stored?.submitted_by, member);
});

test('submitted_by: a send back (reopen) keeps it until the next hand-in replaces it', async (t) => {
  const { tasks, a, b, host, member, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Try again',
    idempotency_key: randomUUID(),
  });
  const first = await tasks.claim(p(b.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: member,
    idempotency_key: randomUUID(),
  });
  await tasks.result(p(b.id), {
    room_id: roomId,
    task_id: made.task.id,
    claim_token: first.claim_token,
    evidence: evidence(),
  });
  const back = await tasks.update(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    decision: 'reject',
  });
  assert.equal(back.task.status, 'open');
  assert.equal(back.task.result, null);
  assert.equal(back.task.submitted_by, member, 'names whose work was sent back');
  // A new claim does not clear it; the claim itself names the new holder.
  const second = await tasks.claim(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: host,
    idempotency_key: randomUUID(),
  });
  assert.equal(second.task.claim?.agent_id, host);
  assert.equal(second.task.submitted_by, member);
  const again = await tasks.result(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    claim_token: second.claim_token,
    evidence: evidence({ revision: 'rev-4' }),
  });
  assert.equal(again.task.submitted_by, host);
  // Cancel keeps it too, like the evidence.
  const cancelled = await tasks.update(p(a.id), {
    room_id: roomId,
    task_id: made.task.id,
    decision: 'cancel',
  });
  assert.equal(cancelled.task.status, 'cancelled');
  assert.equal(cancelled.task.submitted_by, host);
});

test('submitted_by: hidden while the member is removed, shown again when added back', async (t) => {
  const { app, tasks, a, b, member, roomId } = await roomFixture(t);
  const made = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Left the room',
    idempotency_key: randomUUID(),
  });
  const claimed = await tasks.claim(p(b.id), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: member,
    idempotency_key: randomUUID(),
  });
  await tasks.result(p(b.id), {
    room_id: roomId,
    task_id: made.task.id,
    claim_token: claimed.claim_token,
    evidence: evidence(),
  });
  await tasks.update(p(a.id), { room_id: roomId, task_id: made.task.id, decision: 'approve' });
  await app.city.db.query(
    'UPDATE room_members SET removed_at=$3, removed_by=$4 WHERE room_id=$1 AND agent_id=$2',
    [roomId, member, Date.now(), 'the test owner'],
  );
  const seen = await tasks.get(p(a.id), { room_id: roomId, task_id: made.task.id });
  assert.equal(seen.task.status, 'done');
  assert.equal(seen.task.submitted_by, null);
  const listed = await tasks.list(p(a.id), { room_id: roomId });
  assert.equal(listed.tasks.find((item) => item.id === made.task.id)?.submitted_by, null);
  // The stored value stays: re-adding the member shows it again.
  await app.city.db.query(
    'UPDATE room_members SET removed_at=NULL, removed_by=NULL WHERE room_id=$1 AND agent_id=$2',
    [roomId, member],
  );
  const back = await tasks.get(p(a.id), { room_id: roomId, task_id: made.task.id });
  assert.equal(back.task.submitted_by, member);
});
