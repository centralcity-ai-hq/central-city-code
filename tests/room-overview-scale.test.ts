import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { ROOM_LIMITS } from '../server/rooms/contract.js';
import { ROOM_COUNTS_SCAN_SQL } from '../server/rooms/overview.js';

/**
 * Room overview, members page, "Needs you" and posting in a room of ROOM_OVERVIEW_MEMBERS members
 * (default 10,000) with 60 tasks (server/rooms/overview.ts, migration 64): the counts equal a scan,
 * each call stays within budget, and the overview reads a constant number of rows whatever the
 * member count. Timings, statements and rows returned per call are printed.
 */
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-room-scale-test-root-secret-000';

const MEMBERS = Math.min(
  Number(process.env.ROOM_OVERVIEW_MEMBERS ?? ROOM_LIMITS.memberCapMax),
  ROOM_LIMITS.memberCapMax,
);
const BUDGET_MS = Number(process.env.ROOM_SCALE_BUDGET_MS ?? 2000);
const ORIGIN = 'https://centralcity.ai';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: ORIGIN,
};

/** Statements and rows returned, counted on the PGlite instance itself. */
function spy(pg: PGlite) {
  const counter = { statements: 0, rows: 0 };
  type Query = PGlite['query'];
  const wrap =
    (inner: Query): Query =>
    async (...args: Parameters<Query>) => {
      const result = await inner(...args);
      counter.statements++;
      counter.rows += result.rows.length;
      return result as never;
    };
  const query = pg.query.bind(pg);
  pg.query = wrap(query);
  const transaction = pg.transaction.bind(pg);
  pg.transaction = ((callback: Parameters<PGlite['transaction']>[0]) =>
    transaction((tx) => {
      tx.query = wrap(tx.query.bind(tx));
      return callback(tx);
    })) as PGlite['transaction'];
  return counter;
}

test(`room overview in a room of ${MEMBERS} members and 60 tasks: exact counts, constant work`, async (t) => {
  const saved = process.env.CITY_ROOM_TASKS;
  process.env.CITY_ROOM_TASKS = '1';
  t.after(() => {
    if (saved === undefined) delete process.env.CITY_ROOM_TASKS;
    else process.env.CITY_ROOM_TASKS = saved;
  });
  const pg = await PGlite.create('memory://');
  const app = await createApp({
    database: pg,
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  const db = app.city.db;
  const call = (method: 'GET' | 'POST', url: string, cookie: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...headers, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      remoteAddress: '203.0.113.10',
    });
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: JSON.stringify({ name: 'Overview host', password: 'Synthetic room scale password' }),
    remoteAddress: '203.0.113.11',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const hostAgent = await call('POST', '/api/agents', cookie, {
    name: 'Overview host agent',
    capability: 'research',
    mode: 'hosted',
  });
  assert.equal(hostAgent.statusCode, 201, hostAgent.body);
  const hostId = (
    await db.query<{ id: string }>('SELECT id FROM operators WHERE name=$1', ['Overview host'])
  ).rows[0]!.id;
  const operatorsBefore = process.env.CITY_STRESS_TEST_OPERATORS;
  process.env.CITY_STRESS_TEST_OPERATORS = hostId;
  t.after(() => {
    if (operatorsBefore === undefined) delete process.env.CITY_STRESS_TEST_OPERATORS;
    else process.env.CITY_STRESS_TEST_OPERATORS = operatorsBefore;
  });
  const created = await call('POST', '/api/rooms', cookie, {
    name: 'Overview room',
    agent_id: hostAgent.json().agent.id,
    member_cap: MEMBERS,
    idempotency_key: randomUUID(),
  });
  assert.equal(created.statusCode, 201, created.body);
  const room = created.json().room as { id: string };

  // Members: synthetic owners with one agent each; every 10th is a person. 51 AIs were active a
  // few minutes ago, everyone else joined a day ago and went quiet. Two members are the host's:
  // its agent and itself as a person (in its room from creation).
  const others = MEMBERS - 2;
  const ids = Array.from({ length: others + 1 }, () => randomUUID());
  const fill = performance.now();
  const now = Date.now();
  await db.query(
    `INSERT INTO operators(id,name,name_key,password_hash,salt,kind)
       SELECT 'overview-owner-' || i, 'Room guest', 'overview-owner-' || i, '!', '!', 'unclaimed'
         FROM generate_series(1, $1::int) AS i`,
    [others],
  );
  await db.query(
    `INSERT INTO workspaces(operator_id,data)
       SELECT 'overview-owner-' || i, jsonb_build_object(
         'paused', false, 'connections', '[]'::jsonb, 'jobs', '[]'::jsonb, 'events', '[]'::jsonb,
         'agents', jsonb_build_array(jsonb_build_object(
           'id', ($2::text[])[i + 1], 'name', 'Scale agent ' || i,
           'description', '', 'capability', 'research', 'mode', 'external', 'isDemo', false,
           'lastSeenAt', null, 'createdAt', '2026-01-01T00:00:00.000Z', 'revokedAt', null,
           'lastSequence', -1, 'announcedOnline', false)))
         FROM generate_series(1, $1::int) AS i`,
    [others, ids],
  );
  const base = now - 86_400_000;
  await db.query(
    `INSERT INTO room_members(room_id,agent_id,owner_id,role,owner_label,visible_from_seq,joined_at,joined_by,last_read_seq,kind,display_name,last_active_at)
       SELECT $1, ($2::text[])[i + 1], 'overview-owner-' || i, 'member', 'Owner ' || i, 0,
              $4::bigint + i, 'load test', 0,
              CASE WHEN i % 10 = 0 THEN 'person' ELSE 'agent' END,
              CASE WHEN i % 10 = 0 THEN 'Person ' || i END,
              CASE WHEN i % 10 <> 0 AND i <= 56 THEN $5::bigint - i * 1000 END
         FROM generate_series(1, $3::int) AS i`,
    [room.id, ids, others, base, now - 3 * 60_000],
  );
  // 60 tasks across the statuses (written directly; the triggers keep the counts).
  const statuses = ['open', 'open', 'claimed', 'in_review', 'done', 'cancelled'];
  await db.query(
    `INSERT INTO room_tasks(id,room_id,number,title,status,created_by_agent_id,created_by_owner_id,
       claim_agent_id,claim_owner_id,claim_expires_at,claim_token_hash,created_at,updated_at,
       idempotency_key,request_hash)
     SELECT 'scale-task-' || i, $1, i, 'Task ' || i, ($2::text[])[1 + i % 6], 'a', $3,
       CASE WHEN ($2::text[])[1 + i % 6] = 'claimed' THEN ($4::text[])[i + 1] END,
       CASE WHEN ($2::text[])[1 + i % 6] = 'claimed' THEN 'overview-owner-' || i END,
       CASE WHEN ($2::text[])[1 + i % 6] = 'claimed' THEN $5::bigint + 3600000 END,
       CASE WHEN ($2::text[])[1 + i % 6] = 'claimed' THEN 'hash-' || i END,
       $6::bigint + i, $6::bigint + i, 'scale-' || i, 'h'
     FROM generate_series(1, 60) AS i`,
    [room.id, statuses, hostId, ids, now, base - 86_400_000],
  );
  t.diagnostic(
    `fixture of ${others} members and 60 tasks: ${Math.round(performance.now() - fill)} ms`,
  );

  const scan = (
    await db.query<Record<string, number>>(
      `SELECT * FROM (${ROOM_COUNTS_SCAN_SQL}) s WHERE room_id=$1`,
      [room.id],
    )
  ).rows[0]!;
  const counter = spy(pg);
  const lines: string[] = [];
  const measure = async (
    label: string,
    run: () => Promise<{ statusCode: number; body: string }>,
  ) => {
    const before = { ...counter };
    const start = performance.now();
    const response = await run();
    const ms = Math.round(performance.now() - start);
    assert.ok(response.statusCode < 300, `${label}: ${response.body}`);
    const line = `${label}: ${ms} ms, ${counter.statements - before.statements} statements, ${counter.rows - before.rows} rows`;
    lines.push(line);
    t.diagnostic(line);
    assert.ok(ms < BUDGET_MS, `${label} took ${ms} ms (budget ${BUDGET_MS} ms)`);
    return {
      response,
      statements: counter.statements - before.statements,
      rows: counter.rows - before.rows,
    };
  };

  // Warm-up: the first call of a fresh app also loads one-time state (a cached table check), so
  // statement counts are compared from the second call on.
  const warm = await call('GET', `/api/rooms/${room.id}/overview`, cookie);
  assert.equal(warm.statusCode, 200, warm.body);
  const overview = await measure('overview (console)', () =>
    call('GET', `/api/rooms/${room.id}/overview`, cookie),
  );
  const o = JSON.parse(overview.response.body);
  assert.equal(o.members.total, MEMBERS);
  assert.equal(o.members.people, Number(scan.people));
  assert.equal(o.members.ais, Number(scan.agents));
  // AIs 1..56 without the people (every 10th): 51 recent, plus the host agent (joined just now).
  assert.equal(o.members.ais_active_15m, 52);
  assert.deepEqual(o.tasks, {
    open: Number(scan.tasks_open),
    claimed: Number(scan.tasks_claimed),
    in_review: Number(scan.tasks_in_review),
    done: Number(scan.tasks_done),
  });
  assert.deepEqual(o.tasks, { open: 20, claimed: 10, in_review: 10, done: 10 });
  // Constant work: the rows returned do not grow with the member count.
  assert.ok(overview.rows < 40, `overview returned ${overview.rows} rows`);
  // The active-AI count is a range on the partial index, not a pass over every member.
  const plan = (
    await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT count(*) FROM room_members m WHERE m.room_id=$1 AND m.removed_at IS NULL
         AND m.kind <> 'person' AND GREATEST(COALESCE(m.last_active_at, 0), m.joined_at) >= $2`,
      [room.id, now - 15 * 60_000],
    )
  ).rows
    .map((row) => row['QUERY PLAN'])
    .join('\n');
  t.diagnostic(plan);
  assert.match(plan, /room_members_ai_activity/);

  await measure('needs you (host console)', () =>
    call('GET', `/api/rooms/${room.id}/needs-you`, cookie),
  );
  const first = await measure('members page 1 (500, with messages_today)', () =>
    call('GET', `/api/rooms/${room.id}/members`, cookie),
  );
  const members = JSON.parse(first.response.body).members as Array<{
    messages_today: number | null;
  }>;
  assert.equal(members.length, 500);
  assert.ok(members.every((m) => typeof m.messages_today === 'number'));
  for (let i = 0; i < 3; i++)
    await measure('post', () =>
      call('POST', `/api/rooms/${room.id}/messages`, cookie, {
        text: `Plain message ${i}`,
        agent_id: hostAgent.json().agent.id,
        idempotency_key: randomUUID(),
      }),
    );
  const after = await measure('overview after posts', () =>
    call('GET', `/api/rooms/${room.id}/overview`, cookie),
  );
  assert.equal(JSON.parse(after.response.body).members.total, MEMBERS);
  assert.equal(after.statements, overview.statements);
  const today = (
    await db.query<{ posts_today: number }>(
      'SELECT posts_today FROM room_members WHERE room_id=$1 AND agent_id=$2',
      [room.id, hostAgent.json().agent.id],
    )
  ).rows[0]!;
  assert.equal(today.posts_today, 3);
  t.diagnostic(lines.join('\n'));
});
