import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { AGENT_ROWS_SQL } from '../server/agent-rows/schema.js';
import {
  WORKSPACE_AGENT_PATH_SQL,
  registerWorkspaceAgentPathMigration,
  workspaceAgentPathMigration,
} from '../server/agent-rows/agent-lookup-schema.js';
import { listMigrations } from '../server/migrations.js';

async function db() {
  const pg = await PGlite.create('memory://');
  await pg.exec('CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL);');
  await pg.exec(AGENT_ROWS_SQL);
  return pg;
}

const lookup = async (pg: PGlite, ws: string, doc: unknown, aid: string) =>
  (
    await pg.query<{ a: unknown }>('SELECT workspace_agent($1, $2::jsonb, $3) AS a', [
      ws,
      JSON.stringify(doc),
      aid,
    ])
  ).rows[0]!.a;

test('migration 254 registers once and answers exactly as 245 did', async (t) => {
  registerWorkspaceAgentPathMigration();
  registerWorkspaceAgentPathMigration();
  assert.equal(listMigrations().filter((m) => m.version === 254).length, 1);
  assert.equal(workspaceAgentPathMigration.name, 'workspace_agent_path');

  const pg = await db();
  t.after(() => pg.close());
  const docs: unknown[] = [
    { agents: [{ id: 'a1', revision: 1 }, { id: 'a2', revision: 3, revokedAt: 'x' }] },
    // Two with one id: the first in array order.
    { agents: [{ id: 'a2', n: 1 }, { id: 'a2', n: 2 }] },
    { agents: [] },
    { agents: { id: 'a1' } },
    { agents: 'a1' },
    {},
    { agents: [1, 'a1', null, { id: 1 }, { name: 'no id' }, { id: 'a1', ok: true }] },
  ];
  const ids = ['a1', 'a2', 'a3', ''];
  const before: unknown[] = [];
  for (const doc of docs) for (const aid of ids) before.push(await lookup(pg, 'w', doc, aid));
  await pg.exec(WORKSPACE_AGENT_PATH_SQL);
  const after: unknown[] = [];
  for (const doc of docs) for (const aid of ids) after.push(await lookup(pg, 'w', doc, aid));
  assert.deepEqual(after, before);
  assert.deepEqual(await lookup(pg, 'w', docs[1], 'a2'), { id: 'a2', n: 1 });

  // Rows mode still reads the row, not the document.
  await pg.exec(`INSERT INTO workspace_storage VALUES ('r', 'rows', 0);
    INSERT INTO agents (operator_id, agent_id, ordinal, agent) VALUES ('r', 'a1', 1, '{"id":"a1","row":true}');`);
  assert.deepEqual(await lookup(pg, 'r', { agents: [{ id: 'a1' }] }, 'a1'), { id: 'a1', row: true });

  // Running again is a no-op.
  await pg.exec(WORKSPACE_AGENT_PATH_SQL);
});

test('a lookup in a 20k-agent document no longer expands it into rows', async (t) => {
  const pg = await db();
  t.after(() => pg.close());
  const agents = Array.from({ length: 20_000 }, (_, i) => ({ id: `ag_${i}`, revision: 1, name: `A ${i}` }));
  await pg.query('INSERT INTO workspaces VALUES ($1, $2::jsonb)', ['big', JSON.stringify({ agents })]);
  const time = async () => {
    const started = performance.now();
    for (let i = 0; i < 20; i++)
      await pg.query(
        `SELECT workspace_agent(ws.operator_id, ws.data, $1) AS a FROM workspaces ws WHERE ws.operator_id = 'big'`,
        [`ag_${19_000 + i}`],
      );
    return performance.now() - started;
  };
  const old = await time();
  await pg.exec(WORKSPACE_AGENT_PATH_SQL);
  const now = await time();
  t.diagnostic(`20 lookups: ${old.toFixed(0)} ms before, ${now.toFixed(0)} ms after`);
  assert.ok(now < old, `${now} ms is not faster than ${old} ms`);
});
