import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createRoomTasks } from '../server/rooms/tasks-service.js';
import {
  GUEST_EXCLUDED_TASK_TOOLS,
  ROOM_TASK_TOOLS,
  roomTaskOutputSchemas,
  runRoomTaskTool,
} from '../server/rooms/tasks-tools.js';
import { registerRoomTasksMigration } from '../server/rooms/tasks-schema.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import type { RoomLimits } from '../server/rooms/contract.js';

registerRoomTasksMigration();

/**
 * Peer review of room tasks (docs/ROOM_TASKS.md "Peer review"):
 * only the requested reviewer answers, never on their own claim, one open request per task,
 * checklist limits, muted and closed rooms refused, and the host decision unchanged.
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
let addressCounter = 701;
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
async function eventActions(app: App, taskId: string) {
  return (
    await app.city.db.query<{ action: string }>(
      'SELECT action FROM room_task_events WHERE task_id=$1 ORDER BY created_at, id',
      [taskId],
    )
  ).rows.map((row) => row.action);
}
/** Fake step-2 evidence until proposals merge (contract validates the shape only). */

const evidence = () => ({ kind: 'proposal', ref: 'proposal-7', revision: 'rev-3' });

/** Host (a), claimer (b) and a third owner's reviewer (c) in one room, one task claimed by b. */
async function reviewFixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await fixture(t);
  const tasks = tasksOf(app, []);
  const a = await owner(app, 'Review host workspace');
  const b = await owner(app, 'Review claimer workspace');
  const c = await owner(app, 'Review reviewer workspace');
  const host = await agent(app, a.key, 'Review host');
  const member = await agent(app, b.key, 'Review claimer');
  const reviewer = await agent(app, c.key, 'Review checker');
  const created = await createRoom(app, a.key, host);
  await joinRoom(app, b.key, created.link.link, member);
  await joinRoom(app, c.key, created.link.link, reviewer);
  const roomId = created.room.id as string;
  const task = await tasks.create(p(a.id), {
    room_id: roomId,
    title: 'Check the numbers',
    idempotency_key: randomUUID(),
  });
  const claim = await tasks.claim(p(b.id), {
    room_id: roomId,
    task_id: task.task.id,
    idempotency_key: randomUUID(),
  });
  return {
    app,
    tasks,
    a,
    b,
    c,
    host,
    member,
    reviewer,
    roomId,
    taskId: task.task.id,
    token: claim.claim_token,
  };
}

test('peer review: the claimer asks, only the requested reviewer answers; advisory only', async (t) => {
  const f = await reviewFixture(t);
  const asked = await f.tasks.requestReview(p(f.b.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    reviewer_agent_id: f.reviewer,
    checklist: ['Totals add up', 'Sources linked'],
  });
  assert.equal(asked.requested, true);
  assert.equal(asked.task.peer_review?.status, 'requested');
  assert.equal(asked.task.peer_review?.reviewer_agent_id, f.reviewer);
  assert.deepEqual(asked.task.peer_review?.checklist, [
    { item: 'Totals add up', checked: null },
    { item: 'Sources linked', checked: null },
  ]);
  // The reviewer is mentioned (woken like any @mention).
  const mention = (
    await f.app.city.db.query<{ agent_id: string; excerpt: string }>(
      'SELECT agent_id, excerpt FROM mentions WHERE agent_id=$1',
      [f.reviewer],
    )
  ).rows;
  assert.equal(mention.length, 1);
  assert.match(mention[0]!.excerpt, /asked Review checker to review task #1/);

  // Somebody else (the host) cannot answer.
  await failsCode(
    f.tasks.peerReview(p(f.a.id), { room_id: f.roomId, task_id: f.taskId, verdict: 'approve' }),
    'not_the_reviewer',
  );
  // One tick per item.
  await failsCode(
    f.tasks.peerReview(p(f.c.id), {
      room_id: f.roomId,
      task_id: f.taskId,
      verdict: 'approve',
      checklist: [true],
    }),
    'checklist_mismatch',
  );
  const verdict = await f.tasks.peerReview(p(f.c.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    verdict: 'changes_requested',
    comment: 'The second table double counts March.',
    checklist: [false, true],
  });
  assert.equal(verdict.verdict, 'changes_requested');
  assert.equal(verdict.task.status, 'claimed', 'a verdict never moves the task');
  assert.equal(verdict.task.peer_review?.status, 'changes_requested');
  assert.equal(verdict.task.peer_review?.comment, 'The second table double counts March.');
  assert.deepEqual(
    verdict.task.peer_review?.checklist.map((item) => item.checked),
    [false, true],
  );
  // Answered once: a second verdict has no open request.
  await failsCode(
    f.tasks.peerReview(p(f.c.id), { room_id: f.roomId, task_id: f.taskId, verdict: 'approve' }),
    'no_review_requested',
  );
  // The claimer and the host are mentioned.
  const told = (
    await f.app.city.db.query<{ agent_id: string }>(
      'SELECT agent_id FROM mentions WHERE agent_id = ANY($1::text[]) ORDER BY agent_id',
      [[f.member, f.host]],
    )
  ).rows.map((row) => row.agent_id);
  assert.deepEqual(told, [f.member, f.host].sort());
  assert.deepEqual(await eventActions(f.app, f.taskId), [
    'created',
    'claimed',
    'review_requested',
    'peer_reviewed',
  ]);
  const listed = await f.tasks.list(p(f.b.id), { room_id: f.roomId });
  assert.equal(listed.tasks[0]!.peer_review?.status, 'changes_requested');

  // The host's decision is unchanged: hand in, then approve despite changes_requested.
  await f.tasks.result(p(f.b.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    claim_token: f.token,
    evidence: evidence(),
  });
  const approved = await f.tasks.update(p(f.a.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    decision: 'approve',
  });
  assert.equal(approved.task.status, 'done');
  assert.equal(approved.applied, true);
});

test('peer review: never on your own claim; host or claimer only; one open request', async (t) => {
  const f = await reviewFixture(t);
  await failsCode(
    f.tasks.requestReview(p(f.a.id), {
      room_id: f.roomId,
      task_id: f.taskId,
      reviewer_agent_id: f.member,
    }),
    'reviewer_is_claimer',
  );
  // A member who is neither host nor claimer cannot ask.
  await failsCode(
    f.tasks.requestReview(p(f.c.id), {
      room_id: f.roomId,
      task_id: f.taskId,
      reviewer_agent_id: f.host,
    }),
    'review_not_allowed',
  );
  await f.tasks.requestReview(p(f.a.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    reviewer_agent_id: f.reviewer,
  });
  // The same request again is a no-op; a different one is refused while one is open.
  const again = await f.tasks.requestReview(p(f.a.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    reviewer_agent_id: f.reviewer,
  });
  assert.equal(again.task.peer_review?.status, 'requested');
  await failsCode(
    f.tasks.requestReview(p(f.a.id), {
      room_id: f.roomId,
      task_id: f.taskId,
      reviewer_agent_id: f.host,
    }),
    'review_active',
  );
  // Withdraw, then ask the host's own agent: the claimer still cannot be the reviewer.
  const withdrawn = await f.tasks.requestReview(p(f.a.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    cancel: true,
  });
  assert.equal(withdrawn.task.peer_review?.status, 'cancelled');
  // The claim moves to the reviewer: they can no longer review their own claim.
  await f.tasks.requestReview(p(f.b.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    reviewer_agent_id: f.reviewer,
  });
  await f.tasks.release(p(f.b.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    claim_token: f.token,
  });
  await f.tasks.claim(p(f.c.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    idempotency_key: randomUUID(),
  });
  await failsCode(
    f.tasks.peerReview(p(f.c.id), { room_id: f.roomId, task_id: f.taskId, verdict: 'approve' }),
    'own_claim',
  );
});

test('peer review: checklist limits, create and claim with a review', async (t) => {
  const f = await reviewFixture(t);
  const items = (n: number) => Array.from({ length: n }, (_, i) => `Item ${i + 1}`);
  await assert.rejects(
    f.tasks.requestReview(p(f.a.id), {
      room_id: f.roomId,
      task_id: f.taskId,
      reviewer_agent_id: f.reviewer,
      checklist: items(11),
    }),
  );
  await assert.rejects(
    f.tasks.requestReview(p(f.a.id), {
      room_id: f.roomId,
      task_id: f.taskId,
      reviewer_agent_id: f.reviewer,
      checklist: ['x'.repeat(121)],
    }),
  );
  await assert.rejects(
    f.tasks.peerReview(p(f.c.id), {
      room_id: f.roomId,
      task_id: f.taskId,
      verdict: 'approve',
      comment: 'x'.repeat(2001),
    }),
  );
  const ten = await f.tasks.requestReview(p(f.a.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    reviewer_agent_id: f.reviewer,
    checklist: [...items(9), 'y'.repeat(120)],
  });
  assert.equal(ten.task.peer_review?.checklist.length, 10);

  // Create with a review (host), then a claim with a review (claimer).
  const created = await f.tasks.create(p(f.a.id), {
    room_id: f.roomId,
    title: 'Second pass',
    review: { reviewer_agent_id: f.reviewer, checklist: ['Reads well'] },
    idempotency_key: randomUUID(),
  });
  assert.equal(created.task.peer_review?.status, 'requested');
  const third = await f.tasks.create(p(f.a.id), {
    room_id: f.roomId,
    title: 'Third pass',
    idempotency_key: randomUUID(),
  });
  const claimed = await f.tasks.claim(p(f.b.id), {
    room_id: f.roomId,
    task_id: third.task.id,
    review: { reviewer_agent_id: f.reviewer },
    idempotency_key: randomUUID(),
  });
  assert.equal(claimed.task.peer_review?.reviewer_agent_id, f.reviewer);
});

test('peer review: muted members and closed rooms are refused', async (t) => {
  const f = await reviewFixture(t);
  await f.tasks.requestReview(p(f.a.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    reviewer_agent_id: f.reviewer,
  });
  await f.app.city.db.query(
    'UPDATE room_members SET muted_at=$3 WHERE room_id=$1 AND owner_id=$2',
    [f.roomId, f.c.id, Date.now()],
  );
  await failsCode(
    f.tasks.peerReview(p(f.c.id), { room_id: f.roomId, task_id: f.taskId, verdict: 'approve' }),
    'muted_in_room',
  );
  await f.tasks.requestReview(p(f.a.id), { room_id: f.roomId, task_id: f.taskId, cancel: true });
  await failsCode(
    f.tasks.requestReview(p(f.a.id), {
      room_id: f.roomId,
      task_id: f.taskId,
      reviewer_agent_id: f.reviewer,
    }),
    'reviewer_muted',
  );
  await f.app.city.db.query('UPDATE room_members SET muted_at=NULL WHERE room_id=$1', [f.roomId]);
  await f.tasks.requestReview(p(f.a.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    reviewer_agent_id: f.reviewer,
  });
  await f.app.city.db.query('UPDATE rooms SET closed_at=$2 WHERE id=$1', [f.roomId, Date.now()]);
  await failsCode(
    f.tasks.peerReview(p(f.c.id), { room_id: f.roomId, task_id: f.taskId, verdict: 'approve' }),
    'room_closed',
  );
  await failsCode(
    f.tasks.requestReview(p(f.a.id), { room_id: f.roomId, task_id: f.taskId, cancel: true }),
    'room_closed',
  );
});

test('peer review over the MCP tools', async (t) => {
  const f = await reviewFixture(t);
  const asked = (await runRoomTaskTool(
    f.tasks,
    'city_room_task_request_review',
    { room_id: f.roomId, task_id: f.taskId, reviewer_agent_id: f.reviewer, checklist: ['Ok'] },
    p(f.b.id),
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_request_review.safeParse(asked).success, true);
  const verdict = (await runRoomTaskTool(
    f.tasks,
    'city_room_task_peer_review',
    {
      room_id: f.roomId,
      task_id: f.taskId,
      verdict: 'approve',
      comment: 'Looks right.',
      checklist: [true],
    },
    p(f.c.id),
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_peer_review.safeParse(verdict).success, true);
  assert.equal(verdict.task.peer_review.status, 'approved');
  const events = (await runRoomTaskTool(
    f.tasks,
    'city_room_task_events',
    { room_id: f.roomId, task_id: f.taskId },
    p(f.a.id),
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_events.safeParse(events).success, true);
  const reviewed = events.events.find((e: { action: string }) => e.action === 'peer_reviewed');
  assert.equal(reviewed.details.verdict, 'approve');
  assert.equal(reviewed.details.untrusted, true);
  const listed = (await runRoomTaskTool(
    f.tasks,
    'city_room_task_list',
    { room_id: f.roomId },
    p(f.a.id),
  )) as any;
  assert.equal(roomTaskOutputSchemas.city_room_task_list.safeParse(listed).success, true);
  // The same tool over the assistant endpoint, when room tasks are on.
  process.env.CITY_ROOM_TASKS = '1';
  t.after(() => {
    delete process.env.CITY_ROOM_TASKS;
  });
  const res = await call(f.app, f.c.key, 'city_room_task_peer_review', {
    room_id: f.roomId,
    task_id: f.taskId,
    verdict: 'approve',
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.match(res.body, /no_review_requested/);
});

test('peer review: requests and answers are rate limited per agent (no withdraw/re-ask wake loop)', async (t) => {
  const f = await reviewFixture(t);
  const counts = new Map<string, number>();
  const limited = createRoomTasks({
    db: f.app.city.db,
    clock: () => Date.now(),
    limit: async (key: string, max: number) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      if (next > max)
        throw Object.assign(new Error('Too many requests.'), {
          statusCode: 429,
          errorCode: 'rate_limited',
        });
    },
    secret: 'test-rooms-secret',
  });
  assert.equal(limited.limits.reviewsPerAgentPerHour, 20);
  let refused: unknown = null;
  for (let i = 0; i < 30 && !refused; i++) {
    try {
      await limited.requestReview(p(f.a.id), {
        room_id: f.roomId,
        task_id: f.taskId,
        ...(i % 2 ? { cancel: true } : { reviewer_agent_id: f.reviewer }),
      });
    } catch (error) {
      refused = error;
    }
  }
  assert.equal((refused as { statusCode?: number })?.statusCode, 429);
  assert.equal(counts.get(`room-task-review:${f.host}`), 21);
  // Only the 20 allowed calls woke the reviewer (10 requests).
  const woken = (
    await f.app.city.db.query('SELECT 1 FROM mentions WHERE agent_id=$1', [f.reviewer])
  ).rows.length;
  assert.equal(woken, 10);
});

test('peer review: comments and checklists get the room-post text checks', async (t) => {
  const f = await reviewFixture(t);
  const secret = `ccw_${'A'.repeat(43)}`;
  await failsCode(
    f.tasks.requestReview(p(f.a.id), {
      room_id: f.roomId,
      task_id: f.taskId,
      reviewer_agent_id: f.reviewer,
      checklist: [`Use ${secret}`],
    }),
    'credential_in_message',
  );
  await assert.rejects(
    f.tasks.requestReview(p(f.a.id), {
      room_id: f.roomId,
      task_id: f.taskId,
      reviewer_agent_id: f.reviewer,
      checklist: ['Bell\u0007 item'],
    }),
  );
  await f.tasks.requestReview(p(f.a.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    reviewer_agent_id: f.reviewer,
  });
  await failsCode(
    f.tasks.peerReview(p(f.c.id), {
      room_id: f.roomId,
      task_id: f.taskId,
      verdict: 'approve',
      comment: `token: ${secret.toLowerCase()}`,
    }),
    'credential_in_message',
  );
  await assert.rejects(
    f.tasks.peerReview(p(f.c.id), {
      room_id: f.roomId,
      task_id: f.taskId,
      verdict: 'approve',
      comment: 'Escape \u001b[31m red',
    }),
  );
  // Line breaks and tabs are fine.
  const ok = await f.tasks.peerReview(p(f.c.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    verdict: 'approve',
    comment: 'Looks right.\n\tSee the second table.',
  });
  assert.equal(ok.task.peer_review?.comment, 'Looks right.\n\tSee the second table.');
});

test('peer review: after a send back, the author of the latest result still cannot review it', async (t) => {
  const f = await reviewFixture(t);
  const second = await agent(f.app, f.b.key, 'Claimer helper');
  const link = await ok(f.app, f.a.key, 'city_room_link', { room_id: f.roomId });
  await joinRoom(f.app, f.b.key, link.link, second);
  await f.tasks.result(p(f.b.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    claim_token: f.token,
    evidence: evidence(),
  });
  await f.tasks.update(p(f.a.id), { room_id: f.roomId, task_id: f.taskId, decision: 'reject' });
  const open = await f.tasks.get(p(f.a.id), { room_id: f.roomId, task_id: f.taskId });
  assert.equal(open.task.status, 'open');
  assert.equal(open.task.claim, null);
  for (const reviewer of [f.member, second])
    await failsCode(
      f.tasks.requestReview(p(f.a.id), {
        room_id: f.roomId,
        task_id: f.taskId,
        reviewer_agent_id: reviewer,
      }),
      'reviewer_is_claimer',
    );
  // Asked anyway before the result, the author cannot answer after the send back.
  await f.app.city.db.query(
    `INSERT INTO room_task_reviews(id,task_id,room_id,reviewer_agent_id,reviewer_owner_id,
      requested_by_agent_id,requested_by_owner_id,checklist,status,requested_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'[]'::jsonb,'requested',$8)`,
    [randomUUID(), f.taskId, f.roomId, f.member, f.b.id, f.host, f.a.id, Date.now()],
  );
  await failsCode(
    f.tasks.peerReview(p(f.b.id), {
      room_id: f.roomId,
      task_id: f.taskId,
      agent_id: f.member,
      verdict: 'approve',
    }),
    'own_claim',
  );
});

test('peer review: invite guests can neither ask, answer nor be asked', async (t) => {
  const f = await reviewFixture(t);
  assert.deepEqual([...GUEST_EXCLUDED_TASK_TOOLS].sort(), [
    'city_room_task_peer_review',
    'city_room_task_request_review',
  ]);
  for (const name of GUEST_EXCLUDED_TASK_TOOLS) assert.ok(ROOM_TASK_TOOLS.includes(name));
  // A credential-guarded (invite guest) principal is refused outright.
  const guest = { ...p(f.c.id), guard: async () => {} };
  await failsCode(
    f.tasks.requestReview(guest, {
      room_id: f.roomId,
      task_id: f.taskId,
      reviewer_agent_id: f.host,
    }),
    'guest_not_allowed',
  );
  await f.tasks.requestReview(p(f.a.id), {
    room_id: f.roomId,
    task_id: f.taskId,
    reviewer_agent_id: f.reviewer,
  });
  await failsCode(
    f.tasks.peerReview(guest, { room_id: f.roomId, task_id: f.taskId, verdict: 'approve' }),
    'guest_not_allowed',
  );
  // A member holding an invite room credential (an invite guest) cannot answer or be asked.
  await f.tasks.requestReview(p(f.a.id), { room_id: f.roomId, task_id: f.taskId, cancel: true });
  await f.app.city.db.query('SET session_replication_role = replica');
  await f.app.city.db.query(
    `INSERT INTO room_invite_credentials(token_hash,operator_id,agent_id,room_id,host_owner_id,
      source_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      'f'.repeat(64),
      f.c.id,
      f.reviewer,
      f.roomId,
      f.a.id,
      'e'.repeat(64),
      Date.now(),
      Date.now() + 3_600_000,
    ],
  );
  await f.app.city.db.query('SET session_replication_role = origin');
  await failsCode(
    f.tasks.requestReview(p(f.a.id), {
      room_id: f.roomId,
      task_id: f.taskId,
      reviewer_agent_id: f.reviewer,
    }),
    'reviewer_not_eligible',
  );
  await failsCode(
    f.tasks.peerReview(p(f.c.id), { room_id: f.roomId, task_id: f.taskId, verdict: 'approve' }),
    'guest_not_allowed',
  );
});
