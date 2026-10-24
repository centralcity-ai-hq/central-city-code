import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { backupDatabase, restoreDatabase } from '../server/recovery.js';
import { AGENT_ROWS_TABLES } from '../server/agent-rows/schema.js';

/**
 * The offline backup with migration 245 (server/agent-rows/schema.ts): its four tables are
 * recognized all together or not at all and never exported, and a workspace whose agents are
 * stored as rows is exported with them in its document, so the snapshot format is unchanged and a
 * restore starts every workspace in document mode. Synthetic data.
 */
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };

async function tempRoot(t: { after: (fn: () => Promise<unknown>) => void }) {
  const base = resolve(process.env.CC_RECOVERY_TEST_ROOT ?? tmpdir());
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'city-agent-rows-backup-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(`${base}${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

/** Two owners with agents; the second one's agents moved to rows by hand. */
async function source(root: string) {
  const dataDir = join(root, 'source');
  const app = await createApp({ dataDir, startWorkers: false });
  const owners: Array<{ id: string; cookie: string }> = [];
  for (const name of ['Document owner', 'Rows owner']) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers,
      payload: JSON.stringify({ name, password: 'Synthetic agent rows backup password' }),
    });
    assert.equal(res.statusCode, 201, res.body);
    owners.push({
      id: res.json().operator.id as string,
      cookie: `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`,
    });
  }
  for (const [index, owner] of owners.entries())
    for (const name of [`Fixture ${index}a`, `Fixture ${index}b`, `Fixture ${index}c`]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        headers: { ...headers, cookie: owner.cookie },
        payload: JSON.stringify({ name, description: '', mode: 'hosted', capability: 'extract' }),
      });
      assert.ok(res.statusCode < 300, res.body);
    }
  const documents = Object.fromEntries(
    (
      await app.city.db.query<{ operator_id: string; data: { agents: unknown[] } }>(
        'SELECT operator_id, data FROM workspaces',
      )
    ).rows.map((row) => [row.operator_id, row.data]),
  );
  assert.equal(documents[owners[1]!.id]!.agents.length, 3);
  await app.close();
  // The switch, by hand, with the application stopped (this build refuses to start on it).
  const db = await PGlite.create(dataDir);
  try {
    await db.query(
      `INSERT INTO agents(operator_id, agent_id, ordinal, agent)
         SELECT w.operator_id, e.agent->>'id', e.ordinal, e.agent
           FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents')
                WITH ORDINALITY AS e(agent, ordinal)
          WHERE w.operator_id = $1`,
      [owners[1]!.id],
    );
    await db.query(`INSERT INTO workspace_storage VALUES ($1, 'rows', 1)`, [owners[1]!.id]);
    await db.query(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}', '[]') WHERE operator_id = $1`,
      [owners[1]!.id],
    );
  } finally {
    await db.close();
  }
  return { dataDir, owners, documents };
}

test('a rows-mode workspace is backed up with its agents in its document and restored as one', async (t) => {
  const root = await tempRoot(t);
  const { dataDir, owners, documents } = await source(root);
  const backup = join(root, 'snapshot.json');
  const result = await backupDatabase(dataDir, backup);
  assert.equal(result.operators, 2);
  const envelope = JSON.parse(await readFile(backup, 'utf8')) as { payload: string };
  const snapshot = JSON.parse(envelope.payload) as {
    workspaces: Array<{ operator_id: string; data: { agents: Array<{ id: string }> } }>;
  };
  // The tables are never exported: no snapshot section and no storage mode anywhere.
  for (const table of AGENT_ROWS_TABLES) assert.ok(!Object.hasOwn(snapshot, table), table);
  assert.doesNotMatch(envelope.payload, /workspace_storage|agent_rows_|"ordinal"|"mode":"rows"/);
  for (const owner of owners) {
    const row = snapshot.workspaces.find((item) => item.operator_id === owner.id)!;
    assert.deepEqual(
      row.data.agents.map((agent) => agent.id),
      (documents[owner.id] as { agents: Array<{ id: string }> }).agents.map((agent) => agent.id),
    );
  }
  // Exported exactly as the document-mode owner's: the whole document as it was before.
  for (const owner of owners)
    assert.deepEqual(
      snapshot.workspaces.find((item) => item.operator_id === owner.id)!.data,
      documents[owner.id],
    );
  const restoredPath = join(root, 'restored');
  await restoreDatabase(backup, restoredPath);
  const restored = await createApp({ dataDir: restoredPath, startWorkers: false });
  try {
    const db = restored.city.db;
    assert.deepEqual((await db.query('SELECT * FROM workspace_storage')).rows, []);
    assert.deepEqual((await db.query('SELECT * FROM agents')).rows, []);
    for (const owner of owners) {
      const data = (
        await db.query<{ data: { agents: Array<{ id: string; name: string }> } }>(
          'SELECT data FROM workspaces WHERE operator_id = $1',
          [owner.id],
        )
      ).rows[0]!.data;
      const before = (documents[owner.id] as { agents: Array<{ id: string; name: string }> })
        .agents;
      assert.deepEqual(
        data.agents.map((agent) => [agent.id, agent.name]),
        before.map((agent) => [agent.id, agent.name]),
      );
    }
    const counted = await db.query<{ n: string }>('SELECT count(*) AS n FROM counted_agent_ids');
    assert.equal(Number(counted.rows[0]!.n), 6);
  } finally {
    await restored.close();
  }
});

test('a database with only some of the agent rows tables is not backed up', async (t) => {
  const root = await tempRoot(t);
  const dataDir = join(root, 'source');
  const app = await createApp({ dataDir, startWorkers: false });
  await app.close();
  // A complete schema backs up.
  await backupDatabase(dataDir, join(root, 'complete.json'));
  for (const [index, table] of AGENT_ROWS_TABLES.entries()) {
    const copy = join(root, `partial-${index}`);
    const backup = join(root, `partial-${index}.json`);
    const restoredFrom = join(root, 'complete.json');
    await restoreDatabase(restoredFrom, copy);
    const started = await createApp({ dataDir: copy, startWorkers: false });
    await started.close();
    const db = await PGlite.create(copy);
    try {
      await db.exec(`DROP TABLE ${table}`);
    } finally {
      await db.close();
    }
    await assert.rejects(
      backupDatabase(copy, backup),
      /Unsupported database schema; no backup was written\./,
    );
  }
});
