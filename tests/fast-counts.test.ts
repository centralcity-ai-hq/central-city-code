import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createApp } from '../server/app.js';
import type { Database } from '../server/database.js';
import { AI_AGENTS_TOTAL_SCAN_SQL, AI_AGENTS_TOTAL_SQL } from '../server/stats/public-stats.js';

/*
 * Migration 59 in the real app: the kept agent ids follow the app's own writes, and GET
 * /api/session answers setupRequired from one index probe, with the same answer as before
 * ("no owner account exists"). Synthetic data only.
 */

const headers = { 'content-type': 'application/json', 'x-city-request': '1' };

async function setupRequired(app: Awaited<ReturnType<typeof createApp>>) {
  const res = await app.inject({ method: 'GET', url: '/api/session' });
  assert.equal(res.statusCode, 200);
  return res.json().setupRequired as boolean;
}

test('setupRequired is true until an owner account exists, whatever else is stored', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const db = app.city.db as Database;
  assert.equal(await setupRequired(app), true);
  // Unclaimed partitions and AI-owned workspaces are not owner accounts.
  await db.query(
    `INSERT INTO operators(id,name,name_key,password_hash,salt,kind)
      SELECT 'op'||g, 'Op '||g, 'op'||g, 'x', 'x', CASE WHEN g % 2 = 0 THEN 'unclaimed' ELSE 'ai' END
        FROM generate_series(1, 30000) g`,
  );
  await db.query('ANALYZE operators');
  assert.equal(await setupRequired(app), true);
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: { name: 'Fast Count Owner', password: 'Synthetic fast count password' },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(await setupRequired(app), false);
  // One probe of the partial index, never a scan of the 30,000 other operators.
  const plan = (
    await db.query<{ 'QUERY PLAN': string }>(
      "EXPLAIN SELECT EXISTS (SELECT 1 FROM operators WHERE kind='owner') AS any",
    )
  ).rows
    .map((row) => row['QUERY PLAN'])
    .join('\n');
  assert.match(plan, /operators_owner/);
  assert.doesNotMatch(plan, /Seq Scan on operators/);
});

test("the kept agent ids follow the app's own writes and give the scan's total", async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const db = app.city.db as Database;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: { name: 'Kept Ids Owner', password: 'Synthetic fast count password' },
  });
  const cookie = `cc_session=${res.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { ...headers, cookie },
      payload: { name: `Kept ${i}`, description: 'x', capability: 'research', mode: 'external' },
    });
    assert.equal(created.statusCode, 201, created.body);
    ids.push(created.json().agent.id);
  }
  // The console demo seeds sample agents (demoKey): never counted.
  const demo = await app.inject({
    method: 'POST',
    url: '/api/demo/start',
    headers: { ...headers, cookie },
  });
  assert.ok(demo.statusCode < 300, demo.body);
  const seeded = (
    await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM workspaces w, jsonb_array_elements(w.data->'agents') a WHERE a->>'demoKey' IS NOT NULL",
    )
  ).rows[0]!.n;
  assert.ok(Number(seeded) > 0);
  // Revoking keeps the agent counted.
  const revoked = await app.inject({
    method: 'POST',
    url: `/api/agents/${ids[0]}/revoke`,
    headers: { ...headers, cookie },
  });
  assert.ok(revoked.statusCode < 300, revoked.body);
  const counts = async () => {
    const run = async (sql: string) =>
      Number((await db.query<{ n: string }>(sql, [[]])).rows[0]!.n);
    return { kept: await run(AI_AGENTS_TOTAL_SQL), scan: await run(AI_AGENTS_TOTAL_SCAN_SQL) };
  };
  assert.deepEqual(await counts(), { kept: 3, scan: 3 });
  const stats = await app.inject({ method: 'GET', url: '/api/public/stats' });
  assert.equal(stats.json().ai_agents_total, 3);
  // Timing at scale: 30,000 more agents in their own partitions.
  await db.query(
    `INSERT INTO operators(id,name,name_key,password_hash,salt,kind)
      SELECT 'op'||g, 'Op '||g, 'op'||g, 'x', 'x', 'unclaimed' FROM generate_series(1, 30000) g`,
  );
  await db.query(
    `INSERT INTO workspaces(operator_id,data)
      SELECT 'op'||g, jsonb_build_object('agents', jsonb_build_array(jsonb_build_object(
        'id', 'agent-'||g, 'name', 'A'||g, 'createdAt', '2026-10-01T00:00:00.000Z')))
      FROM generate_series(1, 30000) g`,
  );
  await db.query('ANALYZE');
  await counts();
  const started = performance.now();
  const total = await counts();
  t.diagnostic(`both counts at 30,003 agents: ${Math.round(performance.now() - started)} ms`);
  assert.deepEqual(total, { kept: 30_003, scan: 30_003 });
});
