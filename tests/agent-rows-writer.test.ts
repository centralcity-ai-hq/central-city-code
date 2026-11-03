import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { registerCountLogMigration } from '../server/count-log/index.js';
import { writeWorkspaceData } from '../server/agent-rows/writer.js';
import {
  AGENT_ROWS_WRITER_SQL,
  agentRowsWriterMigration,
} from '../server/agent-rows/writer-schema.js';
import type { Transaction } from '../server/database.js';

/**
 * Migration 360 and server/agent-rows/writer.ts: how a workspace in rows mode is written. The same
 * writes in document mode and in rows mode must leave the same document (as read through
 * workspace_document), the same counted agent ids, the same count log entries and the same room
 * name resets: in rows mode the 245 guards skip those triggers and workspace_agents_write does
 * their work. Document mode stores what it stored before. Synthetic data.
 */
registerCountLogMigration();

const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
type App = Awaited<ReturnType<typeof createApp>>;
type Q = Pick<Transaction, 'query'>;

async function ownerApp(t: { after: (fn: () => Promise<unknown>) => void }, name = 'Writer owner') {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: JSON.stringify({ name, password: 'Synthetic agent rows writer password' }),
  });
  assert.equal(res.statusCode, 201, res.body);
  return {
    app,
    operatorId: res.json().operator.id as string,
    cookie: `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`,
  };
}

/** Moves one workspace's agents to rows by hand, as the mover will. */
async function switchToRows(db: Q, operatorId: string) {
  await db.query(
    `INSERT INTO agents(operator_id, agent_id, ordinal, agent)
       SELECT w.operator_id, e.agent->>'id', e.ordinal, e.agent
         FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(w.data->'agents') = 'array' THEN w.data->'agents' ELSE '[]' END)
              WITH ORDINALITY AS e(agent, ordinal)
        WHERE w.operator_id = $1`,
    [operatorId],
  );
  await db.query(`INSERT INTO workspace_storage VALUES ($1, 'rows', 1)`, [operatorId]);
  await db.query(`UPDATE workspaces SET data = data - 'agents' WHERE operator_id = $1`, [
    operatorId,
  ]);
}

const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Agent ${id}`,
  createdAt: '2026-10-01T09:30:15.250Z',
  ...extra,
});

/** Valid agent lists only: rows mode refuses the others (see the last test). */
const STEPS: unknown[][] = [
  [agent('a1')],
  [agent('a1'), agent('a2'), agent('a3')],
  [agent('a1', { name: 'Renamed' }), agent('a2', { lastSeenAt: 'x' }), agent('a3')],
  [
    agent('b1'),
    agent('a1'),
    agent('demo', { demoKey: 'Relay' }),
    agent('b2', { createdAt: '2026-10-02T23:59:59.999Z', parentAgentId: 'a1', revision: 3 }),
    agent('a2'),
    agent('a3'),
  ],
  [agent('a3'), agent('a2'), agent('a1'), agent('b1')], // positions swap
  [agent('a2')],
  [],
  [agent('a2'), agent('e1'), agent('e2', { pausedAt: '2026-10-03T00:00:00.000Z' })],
  [agent('f1'), agent('C1'), agent('e1', { revokedAt: '2026-10-04T00:00:00.000Z' })],
];

const doc = (agents: unknown[]) => ({
  paused: false,
  agents,
  connections: [],
  jobs: [],
  events: [],
});

async function writeIn(app: App, operatorId: string, data: unknown) {
  await app.city.db.transaction((tx) => writeWorkspaceData(tx, operatorId, JSON.stringify(data)));
}

/** Everything a write may touch for one workspace, without its id. */
async function state(db: Q, operatorId: string) {
  const read = (
    await db.query<{ stored: Record<string, unknown>; seen: Record<string, unknown> }>(
      `SELECT data AS stored, workspace_document(operator_id, data) AS seen
         FROM workspaces WHERE operator_id = $1`,
      [operatorId],
    )
  ).rows[0]!;
  return {
    seen: read.seen,
    counted: (
      await db.query<{ agent_id: string }>(
        'SELECT agent_id FROM counted_agent_ids WHERE operator_id = $1 ORDER BY agent_id',
        [operatorId],
      )
    ).rows.map((row) => row.agent_id),
    members: (
      await db.query<{ agent_id: string; name_key: string | null; name_rev: number }>(
        `SELECT agent_id, name_key, name_rev FROM room_members WHERE owner_id = $1 ORDER BY agent_id`,
        [operatorId],
      )
    ).rows.map((row) => `${row.agent_id}:${row.name_key ?? 'NULL'}/${row.name_rev}`),
    logged: (
      await db.query<{ agent_id: string; created_ms: string; salt_bytes: number }>(
        `SELECT agent_id, created_ms::text, octet_length(salt) AS salt_bytes
           FROM count_log_pending ORDER BY seq`,
      )
    ).rows.map((row) => `${row.agent_id}@${row.created_ms}/${row.salt_bytes}`),
    stored: read.stored,
  };
}

async function roomFixture(db: Q, operatorId: string) {
  await db.query(
    `INSERT INTO rooms (id, slug, name, host_owner_id, host_agent_id, member_cap, history,
       link_ttl_ms, created_at, idempotency_key, request_hash)
     VALUES ($2, $2, 'Room', $1, 'a1', 10, 'full', 1000, 0, $2, 'h')`,
    [operatorId, `room-${operatorId}`],
  );
  for (const id of ['a1', 'a2', 'b2', 'C1', 'e1', 'x9'])
    await db.query(
      `INSERT INTO room_members (room_id, agent_id, owner_id, role, owner_label, visible_from_seq,
         joined_at, joined_by, name_key, slug_key)
       VALUES ($3, $1, $2, 'member', 'Owner', 0, 0, $2, 'key', 'slug')`,
      [id, operatorId, `room-${operatorId}`],
    );
}

test('migration 360 is registered and creates or replaces functions only', async (t) => {
  assert.equal(agentRowsWriterMigration.version, 360);
  assert.equal(agentRowsWriterMigration.name, 'agent_rows_writer');
  assert.doesNotMatch(
    AGENT_ROWS_WRITER_SQL,
    /CREATE\s+(TABLE|INDEX|TRIGGER)|ALTER\s+TABLE|DROP\s/i,
  );
  const { app } = await ownerApp(t);
  const fn = await app.city.db.query(
    "SELECT 1 FROM pg_proc WHERE proname IN ('workspace_agents_write', 'agents_public_cards_sync')",
  );
  assert.equal(fn.rows.length, 2);
});

test('the agents cards trigger does nothing for a workspace in document mode', async (t) => {
  const { app, operatorId } = await ownerApp(t);
  const db = app.city.db;
  const cards = async () =>
    (await db.query<{ n: string }>('SELECT count(*)::text AS n FROM agent_public_cards')).rows[0]!
      .n;
  const before = await cards();
  // A precopy writes rows for a document-mode workspace: nothing reads them, no card changes.
  await db.query(
    `INSERT INTO agents (operator_id, agent_id, ordinal, agent) VALUES ($1, 'precopied', 1, $2::jsonb)`,
    [operatorId, JSON.stringify(agent('precopied'))],
  );
  await db.query(`DELETE FROM agents WHERE operator_id = $1`, [operatorId]);
  assert.equal(await cards(), before);
  const source = (
    await db.query<{ def: string }>(
      "SELECT pg_get_functiondef('agents_public_cards_sync()'::regprocedure) AS def",
    )
  ).rows[0]!.def;
  assert.match(source, /workspace_storage/);
  assert.match(source, /COLLATE "default"/);
});

test('the same writes in document and rows mode: same document, counted ids, count log and room resets', async (t) => {
  const document = await ownerApp(t, 'Document owner');
  const rows = await ownerApp(t, 'Rows owner');
  for (const side of [document, rows]) await roomFixture(side.app.city.db, side.operatorId);
  await switchToRows(rows.app.city.db, rows.operatorId);
  for (const [index, agents] of STEPS.entries()) {
    const data = doc(agents);
    await writeIn(document.app, document.operatorId, data);
    await writeIn(rows.app, rows.operatorId, data);
    const a = await state(document.app.city.db, document.operatorId);
    const b = await state(rows.app.city.db, rows.operatorId);
    // Document mode stores exactly what it was given; rows mode stores it without its agents.
    assert.deepEqual(a.stored, data, `document stored, step ${index}`);
    const { agents: _dropped, ...withoutAgents } = data;
    assert.deepEqual(b.stored, withoutAgents, `rows stored, step ${index}`);
    assert.equal('agents' in b.stored, false);
    assert.deepEqual(b.seen, a.seen, `read back, step ${index}`);
    assert.deepEqual(b.counted, a.counted, `counted ids, step ${index}`);
    assert.deepEqual(b.members, a.members, `room resets, step ${index}`);
    assert.deepEqual(b.logged, a.logged, `count log, step ${index}`);
    for (const side of [document, rows])
      await side.app.city.db.query(`UPDATE room_members SET name_key = 'key' WHERE owner_id = $1`, [
        side.operatorId,
      ]);
  }
  // The rows are the list: ids, positions and objects.
  const last = STEPS.at(-1)!;
  const stored = (
    await rows.app.city.db.query<{ ordinal: string; agent: unknown }>(
      'SELECT ordinal::text, agent FROM agents WHERE operator_id = $1 ORDER BY ordinal',
      [rows.operatorId],
    )
  ).rows;
  assert.deepEqual(
    stored.map((row) => [Number(row.ordinal), row.agent]),
    last.map((value, i) => [i + 1, value]),
  );
});

test("in rows mode the app's own writes (create, rename, revoke) keep agents as rows and read back whole", async (t) => {
  const { app, operatorId, cookie } = await ownerApp(t);
  const call = (method: 'POST' | 'PATCH', url: string, body: unknown) =>
    app.inject({ method, url, headers: { ...headers, cookie }, payload: JSON.stringify(body) });
  const first = await call('POST', '/api/agents', {
    name: 'Before rows',
    description: '',
    mode: 'hosted',
    capability: 'extract',
  });
  assert.ok(first.statusCode < 300, first.body);
  await switchToRows(app.city.db, operatorId);
  const second = await call('POST', '/api/agents', {
    name: 'After rows',
    description: '',
    mode: 'hosted',
    capability: 'extract',
  });
  assert.ok(second.statusCode < 300, second.body);
  const ids = (
    await app.city.db.query<{ agent_id: string }>(
      'SELECT agent_id FROM agents WHERE operator_id = $1 ORDER BY ordinal',
      [operatorId],
    )
  ).rows.map((row) => row.agent_id);
  assert.equal(ids.length, 2);
  const renamed = await call('PATCH', `/api/agents/${ids[0]}`, { name: 'Renamed in rows' });
  assert.ok(renamed.statusCode < 300, renamed.body);
  const revoked = await call('POST', `/api/agents/${ids[1]}/revoke`, {});
  assert.ok(revoked.statusCode < 300, revoked.body);
  const row = (
    await app.city.db.query<{
      data: Record<string, unknown>;
      seen: { agents: Array<Record<string, unknown>> };
    }>(
      'SELECT data, workspace_document(operator_id, data) AS seen FROM workspaces WHERE operator_id = $1',
      [operatorId],
    )
  ).rows[0]!;
  assert.equal('agents' in row.data, false, 'the stored document carries no agents');
  assert.deepEqual(
    row.seen.agents.map((a) => a.id),
    ids,
  );
  assert.equal(row.seen.agents[0]!.name, 'Renamed in rows');
  assert.ok(row.seen.agents[1]!.revokedAt, 'revoked');
  // The snapshot the owner sees reads its agents from the rows.
  const snapshot = await app.inject({ method: 'GET', url: '/api/snapshot', headers: { cookie } });
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  assert.match(snapshot.body, /Renamed in rows/);
  assert.match(snapshot.body, /After rows/);
  // Both agents counted, as in document mode.
  const counted = await app.city.db.query(
    'SELECT agent_id FROM counted_agent_ids WHERE operator_id = $1',
    [operatorId],
  );
  assert.equal(counted.rows.length, 2);
});

test('rows mode refuses lists it cannot store, and a document-mode workspace is never written as rows', async (t) => {
  const { app, operatorId } = await ownerApp(t);
  const db = app.city.db;
  const refused = (list: unknown) =>
    assert.rejects(
      db.query('SELECT workspace_agents_write($1, $2::jsonb)', [operatorId, JSON.stringify(list)]),
    );
  await refused([agent('a1')]); // document mode: refused
  await switchToRows(db, operatorId);
  await refused({ id: 'not-an-array' });
  await refused([agent('a1'), 'stray']);
  await refused([{ name: 'No id' }]);
  await refused([{ id: 5, name: 'Number id' }]);
  await refused([agent('a1'), agent('a1')]);
  await db.query('SELECT workspace_agents_write($1, $2::jsonb)', [
    operatorId,
    JSON.stringify([agent('ok')]),
  ]);
  const n = await db.query('SELECT 1 FROM agents WHERE operator_id = $1', [operatorId]);
  assert.equal(n.rows.length, 1);
});

test('an emptied workspace in rows mode loses its agent rows too (erase writes through the writer)', async (t) => {
  const { app, operatorId } = await ownerApp(t);
  await switchToRows(app.city.db, operatorId);
  await writeIn(app, operatorId, doc([agent('a1'), agent('a2')]));
  await writeIn(app, operatorId, {
    paused: false,
    agents: [],
    connections: [],
    jobs: [],
    events: [],
  });
  const left = await app.city.db.query('SELECT 1 FROM agents WHERE operator_id = $1', [operatorId]);
  assert.equal(left.rows.length, 0);
  const counted = await app.city.db.query(
    'SELECT 1 FROM counted_agent_ids WHERE operator_id = $1',
    [operatorId],
  );
  assert.equal(counted.rows.length, 0);
});
