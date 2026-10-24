import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server/app.js';
import { registerCountLogMigration } from '../server/count-log/index.js';
import { countLogPendingLinearMigration } from '../server/count-log/pending.js';
import { COUNTED_AGENT_IDS_SYNC_SQL } from '../server/stats/schema.js';
import { AGENT_NAMES_RESET_SCOPED_SQL } from '../server/rooms/agent-names-schema.js';
import {
  AGENT_ROWS_SQL,
  AGENT_ROWS_TABLES,
  agentRowsMigration,
} from '../server/agent-rows/schema.js';
import type { Transaction } from '../server/database.js';

/**
 * Migration 245 (server/agent-rows/schema.ts): the schema for one row per agent. Nothing switches
 * a workspace, so every read function must answer exactly what the document says, the three
 * guarded trigger functions must behave exactly as before in document mode, and the guards must
 * hold in a workspace switched to rows by hand. Synthetic data.
 */
registerCountLogMigration();

const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
type App = Awaited<ReturnType<typeof createApp>>;
type Q = Pick<Transaction, 'query'>;

const GUARDED = [
  'count_log_record_pending',
  'counted_agent_ids_sync',
  'workspaces_agent_names_reset',
] as const;

/** `CREATE OR REPLACE FUNCTION name(...)` through its closing `$$` and the `;` after it. */
function functionText(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert.ok(start >= 0, `the SQL defines ${name}`);
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  const end = sql.indexOf(';', close);
  assert.ok(open > start && close > open && end > close, `${name} has a $$ body`);
  assert.equal(sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`, end), -1, `${name} once`);
  return sql.slice(start, end + 1);
}

/** The body between the two `$$` of one function text. */
function functionBody(text: string): string {
  const open = text.indexOf('$$');
  return text.slice(open + 2, text.indexOf('$$', open + 2));
}

const withoutGuards = (text: string) =>
  text.replace(/^[ \t]*-- 245 \{\n[\s\S]*?^[ \t]*-- 245 \}\n/gm, '');

const PREVIOUS: Record<(typeof GUARDED)[number], string> = {
  count_log_record_pending: functionText(
    countLogPendingLinearMigration.sql,
    'count_log_record_pending',
  ),
  counted_agent_ids_sync: functionText(COUNTED_AGENT_IDS_SYNC_SQL, 'counted_agent_ids_sync'),
  workspaces_agent_names_reset: functionText(
    AGENT_NAMES_RESET_SCOPED_SQL,
    'workspaces_agent_names_reset',
  ),
};

async function ownerApp(
  t: { after: (fn: () => Promise<unknown>) => void },
  options: { previous?: boolean; dataDir?: string; close?: boolean } = {},
) {
  const app = await createApp({ dataDir: options.dataDir ?? ':memory:', startWorkers: false });
  if (options.close !== false) t.after(() => app.close());
  if (options.previous) await app.city.db.exec(Object.values(PREVIOUS).join('\n'));
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: JSON.stringify({ name: 'Rows owner', password: 'Synthetic agent rows password' }),
  });
  assert.equal(res.statusCode, 201, res.body);
  return { app, operatorId: res.json().operator.id as string };
}

const agent = (id: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Agent ${String(id)}`,
  createdAt: '2026-10-01T09:30:15.250Z',
  ...extra,
});

/** Each step is the full `agents` value (or a raw `data` document) written by one UPDATE. */
const STEPS: Array<{ agents?: unknown; data?: unknown }> = [
  { agents: [agent('a1')] },
  { agents: [agent('a1'), agent('a2'), agent('a3')] },
  { agents: [agent('a1', { name: 'Renamed' }), agent('a2', { lastSeenAt: 'x' }), agent('a3')] },
  {
    agents: [
      agent('b1'),
      agent('a1'),
      agent('demo', { demoKey: 'Relay' }),
      agent('b2', { createdAt: '2026-10-02T23:59:59.999Z', parentAgentId: 'a1', revision: 3 }),
      agent('a2'),
      agent('a3'),
    ],
  },
  { agents: [agent('a1'), { name: 'No id' }, 'stray', agent('c1'), agent('c1'), agent('a2')] },
  { agents: [agent('a2')] },
  { agents: [agent('a2'), agent('a1'), agent('d1', { createdAt: '2026-09-30T00:00:00.000Z' })] },
  { agents: [agent(5), agent('a2')] },
  { agents: [agent('5'), agent(5), agent('a2'), null, 7, [agent('nested')]] },
  { data: { paused: false, connections: [], jobs: [], events: [] } },
  { data: { paused: false, agents: { id: 'not-an-array' }, connections: [] } },
  { data: { paused: false, agents: 'text', connections: [] } },
  { agents: [] },
  { agents: [agent('a2'), agent('e1'), agent('e2', { pausedAt: '2026-10-03T00:00:00.000Z' })] },
  { agents: [agent('f1'), agent('C1'), agent('e1', { revokedAt: '2026-10-04T00:00:00.000Z' })] },
];

/** The document each step writes, from a starting document with every other field. */
function documentOf(step: (typeof STEPS)[number]): Record<string, unknown> {
  if (step.data !== undefined) return step.data as Record<string, unknown>;
  return { paused: false, agents: step.agents, connections: [], jobs: [], events: [] };
}

/**
 * Whether a workspace write can store this step: the count-log recorder has always failed a
 * write whose `agents` is present but not an array, so those documents are read-only cases here.
 */
function writable(step: (typeof STEPS)[number]): boolean {
  const doc = documentOf(step);
  return !('agents' in doc) || Array.isArray(doc.agents);
}

/** Everything the read functions answer for one workspace id and document. */
async function readAll(db: Q, ws: string, doc: unknown, ids: string[]) {
  const json = JSON.stringify(doc);
  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await db.query<{ v: T }>(sql, [ws, json, ...params])).rows[0]!.v;
  return {
    mode: (await db.query<{ v: string }>('SELECT workspace_storage_mode($1) AS v', [ws])).rows[0]!
      .v,
    document: await one<unknown>('SELECT workspace_document($1, $2::jsonb) AS v'),
    agents: (
      await db.query<{ ordinal: string | number; agent: unknown }>(
        'SELECT ordinal, agent FROM workspace_agents($1, $2::jsonb) ORDER BY ordinal',
        [ws, json],
      )
    ).rows.map((row) => [Number(row.ordinal), row.agent]),
    count: await one<number | null>('SELECT workspace_agent_count($1, $2::jsonb) AS v'),
    counted: (
      await db.query<{ agent_id: string }>(
        'SELECT agent_id FROM workspace_counted_agent_ids($1, $2::jsonb) ORDER BY agent_id',
        [ws, json],
      )
    ).rows.map((row) => row.agent_id),
    byId: Object.fromEntries(
      await Promise.all(
        ids.map(async (id) => [
          id,
          await one<unknown>('SELECT workspace_agent($1, $2::jsonb, $3) AS v', [id]),
        ]),
      ),
    ),
  };
}

/** What the document alone says, computed in TypeScript and by migration 59's id rule. */
async function expected(db: Q, doc: Record<string, unknown>, ids: string[]) {
  const list = Array.isArray(doc.agents) ? (doc.agents as unknown[]) : [];
  const counted = (
    await db.query<{ agent_id: string }>(
      'SELECT agent_id FROM counted_agent_ids_of($1::jsonb) ORDER BY agent_id',
      [JSON.stringify(doc)],
    )
  ).rows.map((row) => row.agent_id);
  const idOf = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { id?: unknown }).id
      : undefined;
  return {
    mode: 'document',
    document: doc,
    agents: list.map((value, index) => [index + 1, value]),
    count: Array.isArray(doc.agents) ? list.length : null,
    counted,
    byId: Object.fromEntries(
      ids.map((id) => [
        id,
        list.find((value) => idOf(value) !== undefined && String(idOf(value)) === id) ?? null,
      ]),
    ),
  };
}

const LOOKUP_IDS = ['a1', 'a2', 'c1', 'C1', '5', 'demo', 'missing', 'not-an-array'];

test('migration 245 is registered, applied once, and running it again changes nothing', async (t) => {
  const { app } = await ownerApp(t);
  const db = app.city.db;
  assert.equal(agentRowsMigration.version, 245);
  assert.equal(agentRowsMigration.name, 'agent_rows');
  const applied = await db.query('SELECT name FROM schema_migrations WHERE version = 245');
  assert.deepEqual(applied.rows, [{ name: 'agent_rows' }]);
  const tables = async () =>
    (
      await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name`,
        [[...AGENT_ROWS_TABLES]],
      )
    ).rows.map((row) => row.table_name);
  assert.deepEqual(await tables(), [...AGENT_ROWS_TABLES]);
  await db.query(
    'UPDATE agent_rows_control SET precopy_enabled = true, lease_until = 9, updated_at = 5',
  );
  await db.exec(AGENT_ROWS_SQL);
  assert.deepEqual(await tables(), [...AGENT_ROWS_TABLES]);
  const control = await db.query('SELECT * FROM agent_rows_control');
  assert.deepEqual(control.rows, [
    {
      id: true,
      precopy_enabled: true,
      switch_enabled: false,
      new_workspace_mode: 'document',
      lease_until: 9,
      updated_at: 5,
    },
  ]);
});

test('migration 245 creates and replaces only; it alters, drops and locks no existing table', () => {
  let outside = AGENT_ROWS_SQL;
  for (const match of AGENT_ROWS_SQL.matchAll(/\$\$[\s\S]*?\$\$/g))
    outside = outside.replace(match[0], '$$ $$');
  assert.doesNotMatch(outside, /\b(?:ALTER|DROP|TRUNCATE|REFERENCES|LOCK|COPY|VACUUM)\b/i);
  assert.doesNotMatch(outside, /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER/i);
  assert.doesNotMatch(outside, /\bworkspaces\b/);
  assert.doesNotMatch(outside, /\bUPDATE\b|\bDELETE\b/i);
  const created = [...outside.matchAll(/CREATE TABLE (IF NOT EXISTS )?(\w+)/g)];
  assert.ok(
    created.every((match) => match[1]),
    'every table is IF NOT EXISTS',
  );
  assert.deepEqual(created.map((match) => match[2]).sort(), [...AGENT_ROWS_TABLES]);
  const indexes = [...outside.matchAll(/CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?(\w+) ON (\w+)/g)];
  assert.ok(indexes.length >= 5);
  for (const match of indexes) {
    assert.ok(match[2], `${match[3]} is IF NOT EXISTS`);
    assert.ok((AGENT_ROWS_TABLES as readonly string[]).includes(match[4]!), match[0]);
  }
  // The only data written: the one control row, on the new table.
  const inserts = [...outside.matchAll(/INSERT INTO (\w+)/g)].map((match) => match[1]);
  assert.deepEqual(inserts, ['agent_rows_control']);
  // The guarded functions' new statements read the new tables only (no workspaces scan).
  for (const name of GUARDED) {
    const added = functionText(AGENT_ROWS_SQL, name)
      .split(/^[ \t]*-- 245 \{\n/m)
      .slice(1)
      .map((part) => part.split(/^[ \t]*-- 245 \}\n/m)[0]!)
      .join('\n');
    assert.ok(added.length > 0, `${name} has a guard`);
    assert.doesNotMatch(added, /\bworkspaces\b|\bFOR\b|\bLOOP\b/);
  }
});

test('with no storage row a workspace is in document mode and every switch is off', async (t) => {
  const { app, operatorId } = await ownerApp(t);
  const db = app.city.db;
  const mode = await db.query('SELECT workspace_storage_mode($1) AS v', [operatorId]);
  assert.deepEqual(mode.rows, [{ v: 'document' }]);
  assert.equal((await db.query('SELECT * FROM workspace_storage')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM agents')).rows.length, 0);
  const control = await db.query(
    'SELECT precopy_enabled, switch_enabled, new_workspace_mode, lease_until FROM agent_rows_control',
  );
  assert.deepEqual(control.rows, [
    {
      precopy_enabled: false,
      switch_enabled: false,
      new_workspace_mode: 'document',
      lease_until: 0,
    },
  ]);
  await db.query(`INSERT INTO workspace_storage VALUES ($1, 'document', 1)`, [operatorId]);
  assert.deepEqual((await db.query('SELECT workspace_storage_mode($1) AS v', [operatorId])).rows, [
    { v: 'document' },
  ]);
});

test('in document mode every read function answers from the document, even with rows present', async (t) => {
  const { app, operatorId } = await ownerApp(t);
  const db = app.city.db;
  for (const [index, step] of STEPS.entries()) {
    const doc = documentOf(step);
    const want = await expected(db, doc, LOOKUP_IDS);
    assert.deepEqual(await readAll(db, operatorId, doc, LOOKUP_IDS), want, `step ${index}`);
    // Also through the stored row, as readers will call them.
    if (!writable(step)) continue;
    await db.query('UPDATE workspaces SET data = $2::jsonb WHERE operator_id = $1', [
      operatorId,
      JSON.stringify(doc),
    ]);
    const stored = (
      await db.query<{ v: unknown }>(
        'SELECT workspace_document(operator_id, data) AS v FROM workspaces WHERE operator_id = $1',
        [operatorId],
      )
    ).rows[0]!.v;
    assert.deepEqual(stored, doc, `stored step ${index}`);
  }
  // Rows that disagree with every document, and a storage row still saying 'document'.
  await db.query(
    `INSERT INTO agents(operator_id, agent_id, ordinal, agent) VALUES
       ($1, 'a1', 1, '{"id":"a1","name":"Row only"}'), ($1, 'zz', 2, '{"id":"zz"}')`,
    [operatorId],
  );
  await db.query(`INSERT INTO workspace_storage VALUES ($1, 'document', 1)`, [operatorId]);
  for (const [index, step] of STEPS.entries()) {
    const doc = documentOf(step);
    assert.deepEqual(
      await readAll(db, operatorId, doc, [...LOOKUP_IDS, 'zz']),
      await expected(db, doc, [...LOOKUP_IDS, 'zz']),
      `with rows, step ${index}`,
    );
  }
});

/** Moves one workspace's agents to rows by hand, as a later build will. */
async function switchToRows(db: Q, operatorId: string) {
  await db.query(
    `INSERT INTO agents(operator_id, agent_id, ordinal, agent)
       SELECT w.operator_id, e.agent->>'id', e.ordinal, e.agent
         FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents')
              WITH ORDINALITY AS e(agent, ordinal)
        WHERE w.operator_id = $1`,
    [operatorId],
  );
  await db.query(`INSERT INTO workspace_storage VALUES ($1, 'rows', 1)`, [operatorId]);
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', '[]') WHERE operator_id = $1`,
    [operatorId],
  );
}

test('a workspace switched to rows by hand reads back exactly as its document was', async (t) => {
  const { app, operatorId } = await ownerApp(t);
  const db = app.city.db;
  const valid = STEPS.filter(
    (step) =>
      Array.isArray(step.agents) &&
      step.agents.every((value) => typeof (value as { id?: unknown })?.id === 'string') &&
      new Set(step.agents.map((value) => (value as { id: string }).id)).size === step.agents.length,
  );
  assert.ok(valid.length >= 8);
  for (const [index, step] of valid.entries()) {
    const doc = documentOf(step);
    await db.query('DELETE FROM workspace_storage WHERE operator_id = $1', [operatorId]);
    await db.query('DELETE FROM agents WHERE operator_id = $1', [operatorId]);
    await db.query('UPDATE workspaces SET data = $2::jsonb WHERE operator_id = $1', [
      operatorId,
      JSON.stringify(doc),
    ]);
    const before = await readAll(db, operatorId, doc, LOOKUP_IDS);
    await switchToRows(db, operatorId);
    const stored = (
      await db.query<{ data: unknown }>('SELECT data FROM workspaces WHERE operator_id = $1', [
        operatorId,
      ])
    ).rows[0]!.data;
    assert.deepEqual((stored as { agents: unknown }).agents, [], `step ${index}`);
    const after = await readAll(db, operatorId, stored, LOOKUP_IDS);
    assert.equal(after.mode, 'rows');
    assert.deepEqual({ ...after, mode: 'document' }, before, `rows step ${index}`);
  }
});

test('outside the 245 blocks each guarded function is its previous text, and it is the live one', async (t) => {
  const { app } = await ownerApp(t);
  for (const name of GUARDED) {
    const text = functionText(AGENT_ROWS_SQL, name);
    assert.notEqual(text, PREVIOUS[name]);
    assert.equal(withoutGuards(text), PREVIOUS[name], name);
    const live = (
      await app.city.db.query<{ src: string }>(
        'SELECT prosrc AS src FROM pg_proc WHERE proname = $1',
        [name],
      )
    ).rows.map((row) => row.src);
    assert.deepEqual(live, [functionBody(text)], `${name} is the 245 text`);
  }
  assert.doesNotMatch(functionText(AGENT_ROWS_SQL, 'counted_agent_ids_sync'), /NOT EXISTS/);
});

/** The STEPS writes through the triggers, with an agent membership fixture. */
async function runWrites(app: App, operatorId: string) {
  const db = app.city.db;
  await db.query(
    `INSERT INTO rooms (id, slug, name, host_owner_id, host_agent_id, member_cap, history,
       link_ttl_ms, created_at, idempotency_key, request_hash)
     VALUES ('r1', 'r1', 'Room', $1, 'a1', 10, 'full', 1000, 0, 'k', 'h')`,
    [operatorId],
  );
  for (const id of ['a1', 'a2', 'b2', 'c1', 'e1', 'x9'])
    await db.query(
      `INSERT INTO room_members (room_id, agent_id, owner_id, role, owner_label, visible_from_seq,
         joined_at, joined_by, name_key, slug_key)
       VALUES ('r1', $1, $2, 'member', 'Owner', 0, 0, $2, 'key', 'slug')`,
      [id, operatorId],
    );
  const snapshot = async () => ({
    counted: (
      await db.query<{ agent_id: string }>(
        'SELECT agent_id FROM counted_agent_ids WHERE operator_id = $1 ORDER BY agent_id',
        [operatorId],
      )
    ).rows.map((row) => row.agent_id),
    members: (
      await db.query<{ agent_id: string; name_key: string | null; name_rev: number }>(
        `SELECT agent_id, name_key, name_rev FROM room_members WHERE room_id = 'r1' ORDER BY agent_id`,
      )
    ).rows.map((row) => `${row.agent_id}:${row.name_key ?? 'NULL'}/${row.name_rev}`),
  });
  const states = [];
  for (const step of STEPS.filter(writable)) {
    await db.query('UPDATE workspaces SET data = $2::jsonb WHERE operator_id = $1', [
      operatorId,
      JSON.stringify(documentOf(step)),
    ]);
    states.push(await snapshot());
    await db.query(`UPDATE room_members SET name_key = 'key' WHERE room_id = 'r1'`);
  }
  await db.query('DELETE FROM workspaces WHERE operator_id = $1', [operatorId]);
  states.push(await snapshot());
  await db.query('INSERT INTO workspaces(operator_id, data) VALUES ($1, $2::jsonb)', [
    operatorId,
    JSON.stringify({ paused: false, agents: [agent('g1'), agent('a1')], connections: [] }),
  ]);
  states.push(await snapshot());
  const pending = (
    await db.query(
      `SELECT agent_id, created_day, created_minute, created_ms, octet_length(salt) AS salt_bytes
         FROM count_log_pending ORDER BY seq`,
    )
  ).rows;
  return { states, pending };
}

test('in document mode the guarded triggers write exactly what the previous functions wrote', async (t) => {
  const previous = await ownerApp(t, { previous: true });
  const current = await ownerApp(t);
  const before = await runWrites(previous.app, previous.operatorId);
  const after = await runWrites(current.app, current.operatorId);
  assert.ok(before.pending.length >= 10);
  assert.ok(before.states.some((state) => state.members.some((m) => m.includes('NULL'))));
  assert.deepEqual(after.pending, before.pending);
  assert.deepEqual(after.states, before.states);
});

test('in rows mode the guards hold: no-ops, a document with agents refused, cleanup on delete', async (t) => {
  const { app, operatorId } = await ownerApp(t);
  const db = app.city.db;
  await db.query(
    'UPDATE workspaces SET data = jsonb_set(data, $2, $3::jsonb) WHERE operator_id = $1',
    [operatorId, '{agents}', JSON.stringify([agent('a1'), agent('a2')])],
  );
  await db.query(
    `INSERT INTO rooms (id, slug, name, host_owner_id, host_agent_id, member_cap, history,
       link_ttl_ms, created_at, idempotency_key, request_hash)
     VALUES ('r1', 'r1', 'Room', $1, 'a1', 10, 'full', 1000, 0, 'k', 'h')`,
    [operatorId],
  );
  await db.query(
    `INSERT INTO room_members (room_id, agent_id, owner_id, role, owner_label, visible_from_seq,
       joined_at, joined_by, name_key, slug_key)
     VALUES ('r1', 'a1', $1, 'member', 'Owner', 0, 0, $1, 'key', 'slug')`,
    [operatorId],
  );
  const state = async () => ({
    pending: Number(
      (await db.query<{ n: string }>('SELECT count(*) AS n FROM count_log_pending')).rows[0]!.n,
    ),
    counted: (
      await db.query<{ agent_id: string }>(
        'SELECT agent_id FROM counted_agent_ids WHERE operator_id = $1 ORDER BY agent_id',
        [operatorId],
      )
    ).rows.map((row) => row.agent_id),
    member: (
      await db.query<{ name_key: string | null; name_rev: number }>(
        `SELECT name_key, name_rev FROM room_members WHERE agent_id = 'a1'`,
      )
    ).rows[0],
  });
  const start = await state();
  assert.deepEqual(start.counted, ['a1', 'a2']);
  await switchToRows(db, operatorId);
  assert.deepEqual(await state(), start, 'switching changed nothing derived');
  // Other document fields: every guard returns early.
  await db.query(`UPDATE workspaces SET data = data || '{"paused":true}' WHERE operator_id = $1`, [
    operatorId,
  ]);
  assert.deepEqual(await state(), start);
  // A document carrying agents again is refused, unless the rows writer says so.
  const refused = async (sql: string, params: unknown[]) => {
    const error = await db.query(sql, params).then(
      () => assert.fail('the write went through'),
      (failure: { code?: string; message?: string }) => failure,
    );
    assert.equal(error.code, '55000');
    return error.message ?? '';
  };
  const renamed = JSON.stringify([agent('a1', { name: 'Renamed' }), agent('b9')]);
  assert.match(
    await refused(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}', $2::jsonb) WHERE operator_id = $1`,
      [operatorId, renamed],
    ),
    /stores its agents as rows; its document carries none/,
  );
  await db.transaction(async (tx) => {
    await tx.query("SET LOCAL city.agent_rows_writer = 'on'");
    await tx.query(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}', $2::jsonb) WHERE operator_id = $1`,
      [operatorId, renamed],
    );
  });
  assert.deepEqual(await state(), start, 'the writer setting skips every per-agent effect');
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', '[]') WHERE operator_id = $1`,
    [operatorId],
  );
  // The id of a rows-mode workspace never changes, in either direction.
  const other = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: JSON.stringify({
      name: 'Other rows owner',
      password: 'Synthetic agent rows password',
    }),
  });
  const otherId = other.json().operator.id as string;
  await db.query('DELETE FROM workspaces WHERE operator_id = $1', [otherId]);
  assert.match(
    await refused('UPDATE workspaces SET operator_id = $2 WHERE operator_id = $1', [
      operatorId,
      otherId,
    ]),
    /keeps its id/,
  );
  // Deleting the workspace removes its storage row, its agent rows and its precopy row.
  await db.query(
    `INSERT INTO agent_rows_precopy(operator_id, state, started_at, updated_at) VALUES ($1, 'copied', 1, 1)`,
    [operatorId],
  );
  await db.query('DELETE FROM workspaces WHERE operator_id = $1', [operatorId]);
  for (const table of ['workspace_storage', 'agents', 'agent_rows_precopy'])
    assert.deepEqual(
      (await db.query(`SELECT 1 FROM ${table} WHERE operator_id = $1`, [operatorId])).rows,
      [],
      table,
    );
});

test('the agent rows tables check what they store', async (t) => {
  const { app } = await ownerApp(t);
  const db = app.city.db;
  const rejected = async (sql: string, params: unknown[] = []) =>
    assert.rejects(db.query(sql, params), (error: { code?: string }) => {
      assert.ok(
        ['23514', '23505', '22P02', '23502'].includes(error.code ?? ''),
        String(error.code),
      );
      return true;
    });
  const insert =
    'INSERT INTO agents(operator_id, agent_id, ordinal, agent) VALUES ($1, $2, $3, $4::jsonb)';
  await rejected(insert, ['w', 'a', 1, '{"id":"b"}']);
  await rejected(insert, ['w', 'a', 1, '{"id":5}']);
  await rejected(insert, ['w', 'a', 1, '["a"]']);
  await rejected(insert, ['w', 'a', 0, '{"id":"a"}']);
  const full = {
    id: 'g1',
    name: 'Generated',
    createdAt: '2026-10-01T00:00:00.000Z',
    revokedAt: '2026-10-02T00:00:00.000Z',
    pausedAt: '2026-10-03T00:00:00.000Z',
    demoKey: 'Relay',
    revision: 3,
    parentAgentId: 'p1',
  };
  await db.query(insert, ['w', 'g1', 1, JSON.stringify(full)]);
  await db.query(insert, ['w', 'g2', 2, JSON.stringify({ id: 'g2', revision: 3.5 })]);
  await db.query(insert, ['w', 'g3', 3, JSON.stringify({ id: 'g3', revision: '3' })]);
  await db.query(insert, ['w', 'g4', 4, JSON.stringify({ id: 'g4', revision: 10_000_000_000 })]);
  await rejected(insert, ['w', 'g1', 5, '{"id":"g1"}']);
  await rejected(insert, ['w', 'g5', 4, '{"id":"g5"}']);
  assert.deepEqual(
    (
      await db.query(
        `SELECT agent_id, name, created_at, revoked_at, paused_at, demo, revision, parent_agent_id
           FROM agents WHERE operator_id = 'w' ORDER BY ordinal`,
      )
    ).rows,
    [
      {
        agent_id: 'g1',
        name: 'Generated',
        created_at: full.createdAt,
        revoked_at: full.revokedAt,
        paused_at: full.pausedAt,
        demo: true,
        revision: 3,
        parent_agent_id: 'p1',
      },
      ...['g2', 'g3', 'g4'].map((id) => ({
        agent_id: id,
        name: null,
        created_at: null,
        revoked_at: null,
        paused_at: null,
        demo: false,
        revision: null,
        parent_agent_id: null,
      })),
    ],
  );
  // Generated columns are never written directly.
  await assert.rejects(db.query(`UPDATE agents SET name = 'x' WHERE agent_id = 'g1'`));
  // Ordinals swap inside one transaction once the constraint is deferred.
  const swap = async (tx: Q) => {
    await tx.query(`UPDATE agents SET ordinal = 2 WHERE operator_id = 'w' AND agent_id = 'g1'`);
    await tx.query(`UPDATE agents SET ordinal = 1 WHERE operator_id = 'w' AND agent_id = 'g2'`);
  };
  await assert.rejects(db.transaction(swap));
  await db.transaction(async (tx) => {
    await tx.query('SET CONSTRAINTS agents_operator_ordinal DEFERRED');
    await swap(tx);
  });
  assert.deepEqual(
    (
      await db.query(`SELECT agent_id FROM agents WHERE operator_id = 'w' ORDER BY ordinal`)
    ).rows.map((row) => row.agent_id),
    ['g2', 'g1', 'g3', 'g4'],
  );
  await rejected(`INSERT INTO workspace_storage VALUES ('w', 'json', 1)`);
  await rejected(
    `INSERT INTO agent_rows_precopy(operator_id, state, started_at, updated_at) VALUES ('w', 'done', 1, 1)`,
  );
  await rejected(
    `INSERT INTO agent_rows_precopy(operator_id, state, digest, started_at, updated_at) VALUES ('w', 'copied', 'ABC', 1, 1)`,
  );
  await rejected(
    `INSERT INTO agent_rows_precopy(operator_id, state, refused, started_at, updated_at) VALUES ('w', 'refused', 'other', 1, 1)`,
  );
  await rejected(
    `INSERT INTO agent_rows_precopy(operator_id, state, copied, started_at, updated_at) VALUES ('w', 'copying', -1, 1, 1)`,
  );
  await db.query(
    `INSERT INTO agent_rows_precopy(operator_id, state, digest, refused, started_at, updated_at, mismatches)
     VALUES ('w', 'refused', $1, 'duplicate_id', 1, 1, 0)`,
    ['0'.repeat(64)],
  );
  await rejected(`INSERT INTO agent_rows_control(id, updated_at) VALUES (false, 0)`);
  await rejected(`INSERT INTO agent_rows_control(id, updated_at) VALUES (true, 0)`);
  await rejected(`UPDATE agent_rows_control SET new_workspace_mode = 'json'`);
});

test('a build that reads documents only refuses to start on a database with a rows-mode workspace', async (t) => {
  const base = resolve(process.env.CC_RECOVERY_TEST_ROOT ?? tmpdir());
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'city-agent-rows-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(`${base}${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  const dataDir = join(root, 'data');
  const { app, operatorId } = await ownerApp(t, { dataDir, close: false });
  await app.city.db.query(`INSERT INTO workspace_storage VALUES ($1, 'document', 1)`, [operatorId]);
  await app.close();
  const again = await createApp({ dataDir, startWorkers: false });
  await again.city.db.query(`UPDATE workspace_storage SET mode = 'rows' WHERE operator_id = $1`, [
    operatorId,
  ]);
  await again.close();
  await assert.rejects(
    createApp({ dataDir, startWorkers: false }),
    /stores its agents as rows; this build reads agents from documents only; refusing to start/,
  );
});
