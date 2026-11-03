import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { registerCountLogMigration } from '../server/count-log/index.js';
import { AGENT_ROWS_MOVER_SQL } from '../server/agent-rows/mover.js';

/**
 * server/agent-rows/mover.ts: one workspace from document to rows mode and back, installed by hand
 * as an operator would. Off until agent_rows_control turns it on; the switch copies the delta
 * since the precopy and verifies every position; the rollback restores the document exactly; the
 * counted ids and count log do not change. Synthetic data.
 */
registerCountLogMigration();

const headers = { 'content-type': 'application/json', 'x-city-request': '1' };

async function ownerApp(t: { after: (fn: () => Promise<unknown>) => void }, name = 'Mover owner') {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: JSON.stringify({ name, password: 'Synthetic agent rows mover password' }),
  });
  assert.equal(res.statusCode, 201, res.body);
  await app.city.db.exec(AGENT_ROWS_MOVER_SQL);
  return { app, operatorId: res.json().operator.id as string };
}

const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Agent ${id}`,
  createdAt: '2026-10-01T09:30:15.250Z',
  ...extra,
});

test('the mover installs again over itself', async (t) => {
  const { app } = await ownerApp(t);
  await app.city.db.exec(AGENT_ROWS_MOVER_SQL);
  const { rows } = await app.city.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_proc WHERE proname IN
       ('agent_rows_refusal', 'agent_rows_ms', 'agent_rows_precopy_run', 'agent_rows_switch', 'agent_rows_rollback')`,
  );
  assert.equal(rows[0]!.n, '5');
});

test('the mover: precopy, delta at the switch, identical reads, exact rollback; off by default', async (t) => {
  const { app, operatorId } = await ownerApp(t);
  const db = app.city.db;
  const list = [agent('m1'), agent('m2', { revision: 2 }), agent('m3', { demoKey: 'Relay' })];
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', $2::jsonb) WHERE operator_id = $1`,
    [operatorId, JSON.stringify(list)],
  );
  await assert.rejects(
    db.query('SELECT agent_rows_precopy_run($1)', [operatorId]),
    /precopy is off/,
  );
  await db.query('UPDATE agent_rows_control SET precopy_enabled = true');
  const copied = (
    await db.query<{ v: { copied: number } }>('SELECT agent_rows_precopy_run($1) AS v', [
      operatorId,
    ])
  ).rows[0]!.v;
  assert.equal(copied.copied, 3);
  await assert.rejects(db.query('SELECT agent_rows_switch($1)', [operatorId]), /switch is off/);
  await db.query('UPDATE agent_rows_control SET switch_enabled = true');
  // A change after the precopy (a rename, a removal, a new agent) is the delta the switch copies.
  const later = [
    agent('m1', { name: 'Renamed after precopy' }),
    agent('m3', { demoKey: 'Relay' }),
    agent('m4'),
  ];
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', $2::jsonb) WHERE operator_id = $1`,
    [operatorId, JSON.stringify(later)],
  );
  const before = (
    await db.query<{ data: Record<string, unknown> }>(
      'SELECT data FROM workspaces WHERE operator_id = $1',
      [operatorId],
    )
  ).rows[0]!.data;
  const pendingBefore = (await db.query('SELECT 1 FROM count_log_pending')).rows.length;
  const countedBefore = (
    await db.query<{ agent_id: string }>(
      'SELECT agent_id FROM counted_agent_ids WHERE operator_id = $1 ORDER BY agent_id',
      [operatorId],
    )
  ).rows;
  const switched = (
    await db.query<{ v: { agents: number; removed: number; held_ms: number } }>(
      'SELECT agent_rows_switch($1) AS v',
      [operatorId],
    )
  ).rows[0]!.v;
  assert.equal(switched.agents, 3);
  assert.equal(switched.removed, 1);
  assert.ok(switched.held_ms >= 0);
  const after = (
    await db.query<{ data: Record<string, unknown>; seen: Record<string, unknown>; mode: string }>(
      `SELECT data, workspace_document(operator_id, data) AS seen, workspace_storage_mode(operator_id) AS mode
         FROM workspaces WHERE operator_id = $1`,
      [operatorId],
    )
  ).rows[0]!;
  assert.equal(after.mode, 'rows');
  assert.equal('agents' in after.data, false);
  assert.deepEqual(after.seen, before);
  assert.equal(
    (await db.query('SELECT 1 FROM count_log_pending')).rows.length,
    pendingBefore,
    'nothing logged again',
  );
  assert.deepEqual(
    (
      await db.query<{ agent_id: string }>(
        'SELECT agent_id FROM counted_agent_ids WHERE operator_id = $1 ORDER BY agent_id',
        [operatorId],
      )
    ).rows,
    countedBefore,
  );
  await assert.rejects(
    db.query('SELECT agent_rows_switch($1)', [operatorId]),
    /Precopy this workspace first|already/,
  );
  // Back: the stored document is exactly the one before the switch, and nothing is logged again.
  await db.query('UPDATE agent_rows_control SET switch_enabled = false, precopy_enabled = false');
  await db.query('SELECT agent_rows_rollback($1)', [operatorId]);
  const back = (
    await db.query<{ data: Record<string, unknown>; mode: string }>(
      'SELECT data, workspace_storage_mode(operator_id) AS mode FROM workspaces WHERE operator_id = $1',
      [operatorId],
    )
  ).rows[0]!;
  assert.equal(back.mode, 'document');
  assert.deepEqual(back.data, before);
  assert.equal((await db.query('SELECT 1 FROM count_log_pending')).rows.length, pendingBefore);
  await assert.rejects(
    db.query('SELECT agent_rows_rollback($1)', [operatorId]),
    /in its document already/,
  );
});

test('the mover refuses a document whose agents cannot be rows, and switches nothing', async (t) => {
  const { app, operatorId } = await ownerApp(t);
  const db = app.city.db;
  await db.query('UPDATE agent_rows_control SET precopy_enabled = true, switch_enabled = true');
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', $2::jsonb) WHERE operator_id = $1`,
    [operatorId, JSON.stringify([agent('d1'), agent('d1')])],
  );
  const result = (
    await db.query<{ v: { refused: string } }>('SELECT agent_rows_precopy_run($1) AS v', [
      operatorId,
    ])
  ).rows[0]!.v;
  assert.equal(result.refused, 'duplicate_id');
  await assert.rejects(
    db.query('SELECT agent_rows_switch($1)', [operatorId]),
    /Precopy this workspace first/,
  );
  const mode = await db.query<{ m: string }>('SELECT workspace_storage_mode($1) AS m', [
    operatorId,
  ]);
  assert.equal(mode.rows[0]!.m, 'document');
});
