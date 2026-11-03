import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { AGENT_ROWS_SQL } from '../server/agent-rows/schema.js';
import {
  agentByIdSql,
  agentCountSql,
  agentsArraySql,
  agentsListSql,
  documentAgentsSql,
} from '../server/agent-rows/sql.js';

const AGENTS = [
  { id: 'a-2', name: 'Second', createdAt: '2026-11-02T10:00:00.000Z' },
  {
    id: 'a-1',
    name: 'First',
    createdAt: '2026-11-02T09:00:00.000Z',
    revokedAt: '2026-11-02T11:00:00.000Z',
  },
  { id: 'a-3', name: 'Third', createdAt: '2026-11-02T12:00:00.000Z' },
];

// Two workspaces with the same agents: `doc` keeps them in its document, `rows` as rows (its
// document has no `agents`), plus `empty` (no agents key) and `odd` (agents not an array).
async function seeded(t: test.TestContext) {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec('CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL)');
  await db.exec(AGENT_ROWS_SQL);
  await db.query('INSERT INTO workspaces VALUES ($1, $2::jsonb)', [
    'doc',
    JSON.stringify({ agents: AGENTS, paused: false }),
  ]);
  await db.query('INSERT INTO workspaces VALUES ($1, $2::jsonb)', [
    'rows',
    JSON.stringify({ paused: false }),
  ]);
  await db.query(
    `INSERT INTO workspaces VALUES ('empty', '{}'::jsonb), ('odd', '{"agents": {}}'::jsonb)`,
  );
  for (const [index, agent] of AGENTS.entries())
    await db.query(
      'INSERT INTO agents (operator_id, agent_id, ordinal, agent) VALUES ($1, $2, $3, $4::jsonb)',
      ['rows', agent.id, index + 1, JSON.stringify(agent)],
    );
  await db.query(
    `INSERT INTO workspace_storage (operator_id, mode, changed_at) VALUES ('rows', 'rows', 1)`,
  );
  return db;
}

const one = async <T>(db: PGlite, sql: string, params: unknown[]) =>
  ((await db.query<{ v: T }>(sql, params)).rows[0] as { v: T } | undefined)?.v;

test('the reader fragments answer the same for a workspace in document and in rows mode', async (t) => {
  const db = await seeded(t);
  for (const id of ['doc', 'rows']) {
    const at = (fragment: string) =>
      one(db, `SELECT ${fragment} AS v FROM workspaces w WHERE w.operator_id=$1`, [id]);
    assert.deepEqual(await at(agentsArraySql('w.operator_id', 'w.data')), AGENTS, id);
    assert.deepEqual(await at(agentsListSql('w.operator_id', 'w.data')), AGENTS, id);
    assert.equal(await at(agentCountSql('w.operator_id', 'w.data')), 3, id);
    assert.deepEqual(
      await at(documentAgentsSql('w.operator_id', 'w.data')),
      id === 'doc' ? { agents: AGENTS, paused: false } : { agents: AGENTS },
      id,
    );
    const byId = agentByIdSql(
      'w.operator_id',
      `'a-3'`,
      `SELECT a FROM jsonb_array_elements(w.data->'agents') a WHERE a->>'id' = 'a-3'`,
    );
    assert.deepEqual(await at(byId), AGENTS[2], id);
    // The element scan most callers use, with a parameter as the workspace.
    const names = (
      await db.query<{ name: string }>(
        `SELECT a->>'name' AS name FROM jsonb_array_elements(${agentsArraySql('$1', `(SELECT data FROM workspaces WHERE operator_id=$1)`)}) a`,
        [id],
      )
    ).rows.map((row) => row.name);
    assert.deepEqual(names, ['Second', 'First', 'Third'], id);
  }
});

test('document mode keeps its old answers for a missing or odd agents value', async (t) => {
  const db = await seeded(t);
  const at = (fragment: string, id: string) =>
    one(db, `SELECT ${fragment} AS v FROM workspaces w WHERE w.operator_id=$1`, [id]);
  assert.equal(await at(agentsArraySql('w.operator_id', 'w.data'), 'empty'), null);
  assert.deepEqual(await at(agentsArraySql('w.operator_id', 'w.data'), 'odd'), {});
  assert.deepEqual(await at(agentsListSql('w.operator_id', 'w.data'), 'empty'), []);
  assert.deepEqual(await at(agentsListSql('w.operator_id', 'w.data'), 'odd'), []);
  assert.equal(await at(agentCountSql('w.operator_id', 'w.data'), 'empty'), null);
  await assert.rejects(at(agentCountSql('w.operator_id', 'w.data'), 'odd'));
});

test('a rows-mode workspace with no rows reads as an empty list and count 0', async (t) => {
  const db = await seeded(t);
  await db.query(`DELETE FROM agents WHERE operator_id='rows'`);
  const at = (fragment: string) =>
    one(db, `SELECT ${fragment} AS v FROM workspaces w WHERE w.operator_id='rows'`, []);
  assert.deepEqual(await at(agentsArraySql('w.operator_id', 'w.data')), []);
  assert.deepEqual(await at(agentsListSql('w.operator_id', 'w.data')), []);
  assert.equal(await at(agentCountSql('w.operator_id', 'w.data')), 0);
});
