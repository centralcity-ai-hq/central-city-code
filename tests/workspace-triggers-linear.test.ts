import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { registerCountLogMigration } from '../server/count-log/index.js';
import {
  countLogPendingBackfillMigration,
  countLogPendingLinearMigration,
} from '../server/count-log/pending.js';
import {
  COUNTED_AGENT_IDS_SQL,
  countedAgentIdsSyncLinearMigration,
} from '../server/stats/schema.js';

/**
 * Migrations 110 and 111 make the two per-agent triggers on `workspaces` linear: the count-log
 * pending recorder (a containment test against the whole old agents array for every agent) and
 * the counted_agent_ids sync (a NOT EXISTS whose cached generic plan can rescan the document for
 * every row). These tests run the same workspace writes against the previous trigger functions
 * (their migrations' text, verbatim) and the new ones and require the same rows: the same pending
 * agents in the same order, and the same counted ids after every write. Synthetic data.
 */
registerCountLogMigration();

const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
type App = Awaited<ReturnType<typeof createApp>>;

/** A trigger function exactly as an earlier migration created it. */
function previousFunction(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}()`);
  assert.ok(start >= 0, `the migration defines ${name}`);
  const end = sql.indexOf('\n$$;\n', start);
  assert.ok(end > start);
  return sql.slice(start, end + '\n$$;\n'.length);
}
/** Migration 51's recorder and migration 59's sync, as they were before 110 and 111. */
const PREVIOUS_FUNCTIONS =
  previousFunction(countLogPendingBackfillMigration.sql, 'count_log_record_pending') +
  previousFunction(COUNTED_AGENT_IDS_SQL, 'counted_agent_ids_sync');

async function workspaceApp(t: { after: (fn: () => Promise<unknown>) => void }, previous: boolean) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  if (previous) await app.city.db.exec(PREVIOUS_FUNCTIONS);
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: JSON.stringify({ name: 'Linear owner', password: 'Synthetic linear log password' }),
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
const STEPS: Array<{ agents?: unknown; data?: unknown; drift?: boolean }> = [
  { agents: [agent('a1')] },
  { agents: [agent('a1'), agent('a2'), agent('a3')] },
  // A rename and a presence change only: nothing new.
  { agents: [agent('a1', { name: 'Renamed' }), agent('a2', { lastSeenAt: 'x' }), agent('a3')] },
  // New agents between old ones keep their document order; demo seeds are never counted.
  {
    agents: [
      agent('b1'),
      agent('a1'),
      agent('demo', { demoKey: 'Relay' }),
      agent('b2', { createdAt: '2026-10-02T23:59:59.999Z' }),
      agent('a2'),
      agent('a3'),
    ],
  },
  // An element without an id, a non-object element, a duplicate id in one write.
  {
    agents: [agent('a1'), { name: 'No id' }, 'stray', agent('c1'), agent('c1'), agent('a2')],
  },
  // Removal, then the same id again: already pending, so recorded once.
  { agents: [agent('a2')] },
  { agents: [agent('a2'), agent('a1'), agent('d1', { createdAt: '2026-09-30T00:00:00.000Z' })] },
  // A numeric id is not the string id (the containment test never matched it either).
  { agents: [agent(5), agent('a2')] },
  { agents: [agent('5'), agent(5), agent('a2')] },
  // A document without agents, then agents again: every agent of that write is new to it.
  { data: { paused: false, connections: [], jobs: [], events: [] } },
  { agents: [agent('a2'), agent('e1'), agent('e2')] },
  { agents: [agent('f1'), agent('e1')] },
  // Drift in counted_agent_ids (a stray row, a missing row) is repaired by the next write.
  { agents: [agent('f1'), agent('e1'), agent('h1')], drift: true },
];

async function run(app: App, operatorId: string) {
  const db = app.city.db;
  const counted: string[][] = [];
  const countedNow = async () =>
    (
      await db.query<{ agent_id: string }>(
        'SELECT agent_id FROM counted_agent_ids WHERE operator_id=$1 ORDER BY agent_id',
        [operatorId],
      )
    ).rows.map((row) => row.agent_id);
  for (const step of STEPS) {
    if (step.drift) {
      await db.query("INSERT INTO counted_agent_ids(operator_id,agent_id) VALUES($1,'stray')", [
        operatorId,
      ]);
      await db.query("DELETE FROM counted_agent_ids WHERE operator_id=$1 AND agent_id='e1'", [
        operatorId,
      ]);
    }
    if (step.data !== undefined)
      await db.query('UPDATE workspaces SET data=$2::jsonb WHERE operator_id=$1', [
        operatorId,
        JSON.stringify(step.data),
      ]);
    else
      await db.query(
        `UPDATE workspaces SET data=jsonb_set(
           CASE WHEN jsonb_typeof(data->'agents') IS NULL THEN data || '{"agents":[]}' ELSE data END,
           '{agents}', $2::jsonb) WHERE operator_id=$1`,
        [operatorId, JSON.stringify(step.agents)],
      );
    counted.push(await countedNow());
  }
  // A fresh workspace row written with agents (the INSERT triggers).
  await db.query('DELETE FROM workspaces WHERE operator_id=$1', [operatorId]);
  counted.push(await countedNow());
  await db.query('INSERT INTO workspaces(operator_id,data) VALUES($1,$2::jsonb)', [
    operatorId,
    JSON.stringify({ paused: false, agents: [agent('g1'), agent('a1')], connections: [] }),
  ]);
  counted.push(await countedNow());
  const pending = (
    await db.query<Record<string, unknown>>(
      `SELECT agent_id, created_day, created_minute, created_ms, octet_length(salt) AS salt_bytes
         FROM count_log_pending ORDER BY seq`,
    )
  ).rows;
  return { pending, counted };
}

test('the linear triggers record and count exactly what the previous ones did', async (t) => {
  const previous = await workspaceApp(t, true);
  const current = await workspaceApp(t, false);
  const before = await run(previous.app, previous.operatorId);
  const after = await run(current.app, current.operatorId);
  assert.deepEqual(
    before.pending.map((row) => row.agent_id),
    ['a1', 'a2', 'a3', 'b1', 'b2', 'c1', 'd1', '5', 'e1', 'e2', 'f1', 'h1', 'g1'],
  );
  assert.deepEqual(after.pending, before.pending);
  assert.deepEqual(before.counted.slice(-7), [
    ['5', 'a2'],
    [],
    ['a2', 'e1', 'e2'],
    ['e1', 'f1'],
    ['e1', 'f1', 'h1'],
    [],
    ['a1', 'g1'],
  ]);
  assert.deepEqual(after.counted, before.counted);
});

test('migrations 110 and 111 are registered and replace both trigger functions', async (t) => {
  const { app } = await workspaceApp(t, false);
  const applied = (
    await app.city.db.query<{ version: number; name: string }>(
      'SELECT version, name FROM schema_migrations WHERE version = ANY($1::int[]) ORDER BY version',
      [[countLogPendingLinearMigration.version, countedAgentIdsSyncLinearMigration.version]],
    )
  ).rows;
  assert.deepEqual(applied, [
    { version: 110, name: 'count_log_pending_linear' },
    { version: 111, name: 'counted_agent_ids_sync_linear' },
  ]);
  const source = async (name: string) =>
    (
      await app.city.db.query<{ src: string }>(
        'SELECT prosrc AS src FROM pg_proc WHERE proname=$1',
        [name],
      )
    ).rows.map((row) => row.src);
  const [recorder] = await source('count_log_record_pending');
  assert.match(recorder!, /old_ids \? /);
  assert.doesNotMatch(recorder!, /@>/);
  const [sync] = await source('counted_agent_ids_sync');
  assert.match(sync!, /NOT \(ids \? c\.agent_id\)/);
  assert.doesNotMatch(sync!, /NOT EXISTS/);
});

/**
 * The cost each trigger adds to one workspace write at 5,000 agents, against the same write with
 * every user trigger off (the cost of rewriting the document itself, linear). The connection first
 * makes more than five small writes, so PL/pgSQL has switched to its cached generic plans, as on a
 * long-lived production connection whose workspace grew. Before 110 and 111 the recorder added
 * about a hundred times the write's own cost and the sync's generic plan about sixty times; now
 * each adds about as much as the write.
 */
test('each workspace trigger costs about one pass over the agents, not one per agent', async (t) => {
  const { app, operatorId } = await workspaceApp(t, false);
  const db = app.city.db;
  const agents = Array.from({ length: 200 }, (_, index) => agent(`bulk-${index}`));
  let added = 0;
  const write = async () => {
    agents.push(agent(`added-${added++}`));
    const started = performance.now();
    await db.query(
      `UPDATE workspaces SET data=jsonb_set(data,'{agents}',$2::jsonb) WHERE operator_id=$1`,
      [operatorId, JSON.stringify(agents)],
    );
    return performance.now() - started;
  };
  const triggers = [
    'count_log_pending_on_update',
    'counted_agent_ids_on_update',
    'workspaces_agent_names_reset',
  ];
  const only = async (enabled: string[]) => {
    for (const name of triggers)
      await db.exec(
        `ALTER TABLE workspaces ${enabled.includes(name) ? 'ENABLE' : 'DISABLE'} TRIGGER ${name}`,
      );
    const timings = [await write(), await write(), await write()];
    return Math.min(...timings);
  };
  // Small writes first, past the custom-plan executions, then the workspace grows to 5,000.
  for (let round = 0; round < 8; round++) await write();
  agents.push(...Array.from({ length: 4800 }, (_, index) => agent(`grown-${index}`)));
  await write();
  const base = await only([]);
  for (const name of triggers.slice(0, 2)) {
    const cost = (await only([name])) - base;
    t.diagnostic(`${name}: +${cost.toFixed(0)} ms over a ${base.toFixed(0)} ms write`);
    assert.ok(
      cost < 3 * base + 50,
      `${name} added ${cost.toFixed(0)} ms to a ${base.toFixed(0)} ms write of 5,000 agents`,
    );
  }
  await only(triggers);
  // With every trigger back on, the next writes leave the owner's counted ids exactly the agents.
  const counted = (
    await db.query<{ count: string | number }>(
      'SELECT count(*) AS count FROM counted_agent_ids WHERE operator_id=$1',
      [operatorId],
    )
  ).rows[0]!;
  assert.equal(Number(counted.count), agents.length);
});
