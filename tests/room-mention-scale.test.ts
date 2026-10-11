import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { ROOM_LIMITS } from '../server/rooms/contract.js';
import { findMentions, textOf } from '../server/wake/mentions.js';

/**
 * @mentions in a big room (server/wake/hooks.ts roomPosted, migration 62). The mentions recorded
 * for every post equal what resolving over every member gives (the previous query, kept here as
 * the reference), through renames, duplicate names, people, ids and quoted names; and in a room
 * of ROOM_MENTION_MEMBERS members (default 10,000) a post with or without an @mention stays
 * within budget. The timings, statements and member rows read per post are printed.
 */
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-room-scale-test-root-secret-000';

const MEMBERS = Math.min(
  Number(process.env.ROOM_MENTION_MEMBERS ?? ROOM_LIMITS.memberCapMax),
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

test(`@mentions in a room of ${MEMBERS} members: same mentions as resolving over everyone, and fast`, async (t) => {
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
  let address = 10;
  const call = (method: 'GET' | 'POST', url: string, cookie: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...headers, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      remoteAddress: `203.0.113.${address}`,
    });
  const account = async (name: string) => {
    address++;
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers,
      payload: JSON.stringify({ name, password: 'Synthetic room scale password' }),
      remoteAddress: `203.0.113.${address}`,
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const agent = await call('POST', '/api/agents', cookie, {
      name: `${name} agent`,
      capability: 'research',
      mode: 'hosted',
    });
    assert.equal(agent.statusCode, 201, agent.body);
    return { cookie, agentId: agent.json().agent.id as string };
  };

  const host = await account('Mention host');
  const hostId = (
    await db.query<{ id: string }>('SELECT id FROM operators WHERE name=$1', ['Mention host'])
  ).rows[0]!.id;
  const operatorsBefore = process.env.CITY_STRESS_TEST_OPERATORS;
  process.env.CITY_STRESS_TEST_OPERATORS = hostId;
  t.after(() => {
    if (operatorsBefore === undefined) delete process.env.CITY_STRESS_TEST_OPERATORS;
    else process.env.CITY_STRESS_TEST_OPERATORS = operatorsBefore;
  });
  const created = await call('POST', '/api/rooms', host.cookie, {
    name: 'Mention room',
    agent_id: host.agentId,
    member_cap: MEMBERS,
    idempotency_key: randomUUID(),
  });
  assert.equal(created.statusCode, 201, created.body);
  const room = created.json().room as { id: string };

  // Members: synthetic owners with one agent each. The first 40 have awkward, partly shared
  // names; a few more are people with display names.
  const special = [
    'Ann',
    'Ann Lee',
    'ann lee',
    'Elric',
    'Build Desk',
    'build-desk',
    'Zoë',
    'Ｚｏë',
    'İstanbul',
    'straße',
    'Bot 🤖',
    'Dr. Who',
    'a.b',
    'Desk',
  ];
  const others = MEMBERS - 1;
  const nameOf = (i: number) =>
    i <= special.length * 2 ? special[(i - 1) % special.length]! : `Scale agent ${i}`;
  // Every seventh agent id is upper case (ids are matched case-insensitively).
  const ids = Array.from({ length: others + 1 }, (_, i) =>
    i === 0 ? '' : i % 7 === 0 ? randomUUID().toUpperCase() : randomUUID(),
  );
  const names = Array.from({ length: others + 1 }, (_, i) => (i === 0 ? '' : nameOf(i)));
  const fill = performance.now();
  await db.query(
    `INSERT INTO operators(id,name,name_key,password_hash,salt,kind)
       SELECT 'mention-owner-' || i, 'Room guest', 'mention-owner-' || i, '!', '!', 'unclaimed'
         FROM generate_series(1, $1::int) AS i`,
    [others],
  );
  await db.query(
    `INSERT INTO workspaces(operator_id,data)
       SELECT 'mention-owner-' || i, jsonb_build_object(
         'paused', false, 'connections', '[]'::jsonb, 'jobs', '[]'::jsonb, 'events', '[]'::jsonb,
         'agents', jsonb_build_array(jsonb_build_object(
           'id', ($2::text[])[i + 1], 'name', ($3::text[])[i + 1],
           'description', '', 'capability', 'research', 'mode', 'external', 'isDemo', false,
           'lastSeenAt', null, 'createdAt', '2026-01-01T00:00:00.000Z', 'revokedAt', null,
           'lastSequence', -1, 'announcedOnline', false)))
         FROM generate_series(1, $1::int) AS i`,
    [others, ids, names],
  );
  const base = Date.now() - 86_400_000;
  await db.query(
    `INSERT INTO room_members(room_id,agent_id,owner_id,role,owner_label,visible_from_seq,joined_at,joined_by,last_read_seq)
       SELECT $1, ($2::text[])[i + 1], 'mention-owner-' || i, 'member',
              'Owner ' || i, 0, $4::bigint + i, 'load test', 0
         FROM generate_series(1, $3::int) AS i`,
    [room.id, ids, others, base],
  );
  // People (kind 'person') with display names, under three of the synthetic owners.
  for (const [slot, display] of [
    [1, 'Ann Lee'],
    [2, 'Pat Person'],
    [3, 'Zoë'],
  ] as const)
    await db.query(
      `INSERT INTO room_members(room_id,agent_id,owner_id,role,owner_label,visible_from_seq,joined_at,joined_by,last_read_seq,kind,display_name)
       VALUES($1,$2,$3,'member','Person',0,$4,'load test',0,'person',$5)`,
      [room.id, randomUUID(), `mention-owner-${slot}`, base, display],
    );
  t.diagnostic(`fixture of ${others} members: ${Math.round(performance.now() - fill)} ms`);

  /** Mentions as resolved before migration 62: every member loaded, then findMentions. */
  async function reference(messageId: string): Promise<string[]> {
    const message = (
      await db.query<{
        seq: string;
        sender_agent_id: string;
        parts: Array<{ type: string; text?: string }>;
      }>('SELECT seq, sender_agent_id, parts FROM room_messages WHERE room_id=$1 AND id=$2', [
        room.id,
        messageId,
      ])
    ).rows[0]!;
    const text = textOf(message.parts);
    if (!text.includes('@')) return [];
    const members = (
      await db.query<{
        agent_id: string;
        owner_id: string;
        name: string;
        kind: string;
        role: string;
      }>(
        `SELECT m.agent_id, m.owner_id, a->>'name' AS name, 'agent' AS kind, m.role FROM room_members m
          JOIN workspaces w ON w.operator_id=m.owner_id
          CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a
          WHERE m.room_id=$1 AND m.removed_at IS NULL AND m.visible_from_seq < $2
            AND m.kind='agent' AND a->>'id'=m.agent_id AND (a->>'revokedAt') IS NULL
         UNION ALL
         SELECT m.agent_id, m.owner_id, m.display_name AS name, 'person' AS kind, m.role FROM room_members m
          WHERE m.room_id=$1 AND m.removed_at IS NULL AND m.visible_from_seq < $2
            AND m.kind='person' AND m.display_name IS NOT NULL`,
        [room.id, Number(message.seq)],
      )
    ).rows;
    // An agent sender never mentions its owner's host; a person sender (the owner) does.
    const sender = members.find((m) => m.agent_id === message.sender_agent_id);
    const ownHost =
      sender?.kind === 'agent'
        ? members
            .filter(
              (m) => m.role === 'host' && m.kind === 'agent' && m.owner_id === sender.owner_id,
            )
            .map((m) => m.agent_id)
        : [];
    return findMentions(
      text,
      members.map((m) => ({ id: m.agent_id, name: m.name })),
      { exclude: [message.sender_agent_id, ...ownHost] },
    ).ids.sort();
  }
  const recorded = async (messageId: string) =>
    (
      await db.query<{ agent_id: string }>(
        "SELECT agent_id FROM mentions WHERE source_kind='room' AND source_id=$1 ORDER BY agent_id",
        [messageId],
      )
    ).rows.map((row) => row.agent_id);

  const counter = spy(pg);
  const timings: string[] = [];
  const post = async (label: string, text: string) => {
    const before = { ...counter };
    const start = performance.now();
    const response = await call('POST', `/api/rooms/${room.id}/messages`, host.cookie, {
      text,
      idempotency_key: randomUUID(),
    });
    const ms = Math.round(performance.now() - start);
    assert.equal(response.statusCode, 201, response.body);
    const line = `${label}: ${ms} ms, ${counter.statements - before.statements} statements, ${counter.rows - before.rows} rows`;
    timings.push(line);
    t.diagnostic(line);
    assert.ok(ms < BUDGET_MS, `${label} took ${ms} ms (budget ${BUDGET_MS} ms)`);
    const id = response.json().message.id as string;
    const expected = await reference(id);
    assert.deepEqual(await recorded(id), expected, `${label}: ${text}`);
    return expected;
  };

  await post('post without @', 'Hello everyone in the room.');
  await post('first post with @ (fills keys)', `@"Scale agent ${Math.floor(others / 2)}" hi`);
  for (let round = 0; round < 3; round++) {
    await post('post without @', 'Plain message number ' + round);
    await post('post with @"name"', `@"Scale agent ${others - round}" please check`);
  }
  await post('post with @slug', `@scale-agent-${others - 5} and @build-desk`);
  assert.equal(
    (await post('post with @id', `ping @${ids[others - 9]!.toLowerCase()} now`)).length,
    1,
  );
  assert.equal((await post('ambiguous', '@Ann Lee and @Elric and @Zoë')).length, 0);
  await post('longest match', '@Ann and @Dr. Who, @a.b and @Desk');
  await post('own name', '@"Mention host agent" and @Bot 🤖');
  await post('email is not a mention', 'mail scale@scale-agent-12.example');

  // A rename (workspace document) clears the member's keys: the new name resolves, the old one
  // does not; a person's display name change does the same.
  const renamed = Math.floor(others / 3);
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents,0,name}', '"Renamed Member"'::jsonb)
      WHERE operator_id=$1`,
    [`mention-owner-${renamed}`],
  );
  assert.deepEqual(await post('after rename (new name)', '@Renamed Member hello'), [ids[renamed]!]);
  assert.deepEqual(await post('after rename (old name)', `@"Scale agent ${renamed}" hello`), []);
  await db.query(
    "UPDATE room_members SET display_name='Pat Renamed' WHERE room_id=$1 AND display_name='Pat Person'",
    [room.id],
  );
  assert.equal((await post('person renamed', '@Pat Renamed and @Pat Person')).length, 1);
  // A member added after the keys were filled (keys not known yet) is still a candidate.
  const lateId = randomUUID();
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', data->'agents' || jsonb_build_array(
       jsonb_build_object('id', $2::text, 'name', 'Late Member', 'revokedAt', null)))
      WHERE operator_id=$1`,
    ['mention-owner-4', lateId],
  );
  await db.query(
    `INSERT INTO room_members(room_id,agent_id,owner_id,role,owner_label,visible_from_seq,joined_at,joined_by,last_read_seq)
     VALUES($1,$2,'mention-owner-4','member','Owner 4',0,$3,'load test',0)`,
    [room.id, lateId, base],
  );
  assert.deepEqual(await post('new member', '@Late Member welcome'), [lateId]);
  t.diagnostic(timings.join('\n'));
});
