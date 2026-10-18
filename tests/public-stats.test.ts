import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import {
  AI_AGENTS_TOTAL_SCAN_SQL,
  AI_AGENTS_TOTAL_SQL,
  countAiAgentsTotal,
  createPublicStats,
  PUBLIC_STATS_LEASE_MS,
  PUBLIC_STATS_RETRY_MS,
  sqlPublicStatsStore,
  parseExcludedOperators,
  PUBLIC_STATS_CACHE_CONTROL,
  PUBLIC_STATS_EDGE_CACHE_CONTROL,
  PUBLIC_STATS_RATE,
  PUBLIC_STATS_TTL_MS,
  registerPublicStatsRoutes,
  type PublicStatsService,
} from '../server/stats/public-stats.js';
import {
  COUNTED_AGENT_IDS_SQL,
  COUNTED_AGENT_IDS_SYNC_SQL,
  publicStatsMigration,
} from '../server/stats/schema.js';
import {
  createPaidCallsReader,
  PAID_CALLS_CACHE_MS,
  PAID_CALLS_LAST_GOOD_MS,
  PAID_CALLS_READ_BUDGET_MS,
  PAID_CALLS_READ_SQL,
  paidCallsField,
  type PaidCallsReader,
  type PaidCallsSnapshot,
} from '../server/stats/paid-calls.js';
import {
  PAID_CALLS_CHAIN_ID,
  PAID_CALLS_FLAG,
  PAID_CALLS_RECENT_MAX,
  PAID_CALLS_RECENT_WINDOW_MS,
} from '../shared/paid-calls.js';
import {
  BASE_AGENTS_COUNT_SQL,
  BASE_AGENTS_FAILURE_BACKOFF_MS,
  BASE_AGENTS_LAST_GOOD_MS,
  baseAgentsForResponse,
  countBaseAgents,
  createBaseAgentsReader,
} from '../server/stats/base-agents.js';
import { createOnBaseStore } from '../server/base/explorer/store.js';
import { add, NOW, SEPOLIA_REGISTRY, setup } from './on-base-fixture.js';
import Fastify from 'fastify';
import { ownerApi, type App } from './oauth-helpers.js';

const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Agent ${id}`,
  isDemo: false,
  createdAt: '2026-09-27T00:00:00.000Z',
  revokedAt: null,
  ...extra,
});

async function table(t: { after: (fn: () => Promise<unknown>) => void }) {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec('CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL)');
  await db.exec(COUNTED_AGENT_IDS_SQL);
  // The trigger function as migration 111 replaced it.
  await db.exec(COUNTED_AGENT_IDS_SYNC_SQL);
  const put = (operatorId: string, agents: unknown[] | undefined) =>
    db.query('INSERT INTO workspaces(operator_id,data) VALUES($1,$2::jsonb)', [
      operatorId,
      JSON.stringify(agents === undefined ? { jobs: [] } : { agents, jobs: [] }),
    ]);
  return { db, put };
}

test('count definition: distinct agents in every workspace kind, revoked and hosted kept, seeded demo and excluded left out', async (t) => {
  const { db, put } = await table(t);
  assert.equal(await countAiAgentsTotal(db), 0);
  // An owner account: one live, one revoked, one paused and one hosted (isDemo) agent, and the
  // three sample agents seeded by /api/demo/start (demoKey).
  await put('owner-1', [
    agent('a1'),
    agent('h1', { mode: 'hosted', isDemo: true }),
    agent('a2', { revokedAt: '2026-09-27T01:00:00.000Z' }),
    agent('a3', { pausedAt: '2026-09-27T01:00:00.000Z' }),
    agent('d1', { isDemo: true, demoKey: 'Scout' }),
    agent('d2', { isDemo: true, demoKey: 'Relay' }),
    agent('d3', { isDemo: true, demoKey: 'Checker' }),
  ]);
  // An unclaimed partition: an anonymous template agent (hosted, isDemo), an anonymous external
  // agent and a room-invite guest.
  await put('bucket-1', [
    agent('t1', { mode: 'hosted', isDemo: true, createdBy: { kind: 'anonymous-client' } }),
    agent('u1', { createdBy: { kind: 'anonymous-client' } }),
    agent('g1', { createdBy: { kind: 'anonymous-client' } }),
  ]);
  // An AI-owned workspace, an empty workspace and a legacy document without an agents array.
  await put('ai-1', [agent('w1')]);
  await put('empty', []);
  await put('legacy', undefined);
  assert.equal(await countAiAgentsTotal(db), 8);
  // An id seen in two documents (never expected; a claim moves it atomically) counts once.
  await put('owner-2', [agent('u1')]);
  assert.equal(await countAiAgentsTotal(db), 8);
  // Excluded synthetic accounts (e.g. the production canary) do not count.
  assert.equal(await countAiAgentsTotal(db, ['owner-1']), 4);
  assert.equal(await countAiAgentsTotal(db, ['owner-1', 'bucket-1', 'owner-2']), 1);
});

test('excluded operators are parsed strictly', () => {
  assert.deepEqual(parseExcludedOperators(undefined), []);
  assert.deepEqual(parseExcludedOperators(' '), []);
  assert.deepEqual(parseExcludedOperators('a-1, b_2,a-1'), ['a-1', 'b_2']);
  assert.throws(() => parseExcludedOperators("x' OR 1=1"), /operator ids/);
});

/** The trigger-kept count and the definition's scan over every document, for the same data. */
async function bothCounts(db: PGlite, excluded: string[] = []) {
  const run = async (sql: string) =>
    Number((await db.query<{ n: string | number }>(sql, [excluded])).rows[0]!.n);
  return { kept: await run(AI_AGENTS_TOTAL_SQL), scan: await run(AI_AGENTS_TOTAL_SCAN_SQL) };
}
async function assertSame(db: PGlite, expected: number, excluded: string[] = []) {
  assert.deepEqual(await bothCounts(db, excluded), { kept: expected, scan: expected });
}

test('migration 59: the kept ids follow every workspace write and equal the document scan', async (t) => {
  const { db, put } = await table(t);
  const set = (operatorId: string, agents: unknown) =>
    db.query(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}', $2::jsonb) WHERE operator_id=$1`,
      [operatorId, JSON.stringify(agents)],
    );
  await put('o1', [agent('a1'), agent('a2'), agent('d1', { demoKey: 'Scout' })]);
  await put('o2', [agent('b1')]);
  await assertSame(db, 3);
  // An agent revoked (still counted), one added, one removed from its document, a demo seed added.
  await set('o1', [
    agent('a1', { revokedAt: '2026-09-28T00:00:00.000Z' }),
    agent('a3'),
    agent('d1', { demoKey: 'Scout' }),
    agent('d2', { demoKey: 'Relay' }),
  ]);
  await assertSame(db, 3);
  // A demoKey set on a counted agent, and one that is JSON null (counted like an absent one).
  await set('o1', [agent('a1'), agent('a3', { demoKey: 'Scout' }), agent('d1', { demoKey: null })]);
  await assertSame(db, 3);
  // A claim: the agent moves to another document in one transaction, its id preserved.
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}', '[]'::jsonb) WHERE operator_id='o2'`,
    );
    await tx.query(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}', data->'agents' || $1::jsonb)
        WHERE operator_id='o1'`,
      [JSON.stringify([agent('b1')])],
    );
  });
  await assertSame(db, 3);
  // The same id in two documents, and twice in one document, counts once.
  await put('o3', [agent('b1'), agent('b1'), agent('c1')]);
  await assertSame(db, 4);
  // Odd elements: no id, a null id, a numeric id (counted by its text), non-object elements.
  await put('o4', [{ name: 'no id' }, agent('x', { id: null }), { id: 7 }, 'text', 42, null]);
  await assertSame(db, 5);
  // A document without agents, an empty array, and a write that leaves the agents unchanged.
  await put('o5', undefined);
  await put('o6', []);
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{jobs}', '[1]'::jsonb) WHERE operator_id='o1'`,
  );
  await assertSame(db, 5);
  // Excluded operators.
  await assertSame(db, 2, ['o1', 'o4']);
  await assertSame(db, 1, ['o1', 'o3']);
  // A purged partition (its workspace row deleted) and a changed key.
  await db.query(`DELETE FROM workspaces WHERE operator_id='o3'`);
  await assertSame(db, 4);
  await db.query(`UPDATE workspaces SET operator_id='o7' WHERE operator_id='o4'`);
  await assertSame(db, 4);
  await assertSame(db, 3, ['o7']);
  // The kept rows are exactly the scan's (workspace, id) pairs.
  const pairs = async (sql: string) =>
    (await db.query<{ o: string; a: string }>(sql)).rows.map((row) => `${row.o}/${row.a}`).sort();
  assert.deepEqual(
    await pairs('SELECT operator_id AS o, agent_id AS a FROM counted_agent_ids'),
    await pairs(`SELECT DISTINCT w.operator_id AS o, a.value->>'id' AS a FROM workspaces w
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'agents','[]'::jsonb)) AS a(value)
      WHERE a.value->>'demoKey' IS NULL AND a.value->>'id' IS NOT NULL`),
  );
});

test('migration 59: a workspace whose agents is not an array still saves and adds nothing', async (t) => {
  const { db, put } = await table(t);
  await put('o1', [agent('a1')]);
  await db.query(`INSERT INTO workspaces VALUES('odd', '{"agents":{"id":"x"}}'::jsonb)`);
  await db.query(`UPDATE workspaces SET data='{"agents":"text"}'::jsonb WHERE operator_id='odd'`);
  assert.equal(await countAiAgentsTotal(db), 1);
});

test('migration 59 backfills existing workspaces: 30,000 agents, the scan total, a fast count', async (t) => {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec('CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL)');
  // Data from before the migration: 30,000 one-agent partitions with padded documents (like
  // real ones), an owner with a demo seed, and an excluded canary.
  await db.query(
    `INSERT INTO workspaces(operator_id,data)
      SELECT 'op'||g, jsonb_build_object('agents', jsonb_build_array(jsonb_build_object(
        'id', 'agent-'||g, 'name', 'A'||g, 'createdAt', '2026-10-01T00:00:00.000Z')),
        'events', jsonb_build_array(jsonb_build_object('message', repeat('x', 400))),
        'jobs', '[]'::jsonb)
      FROM generate_series(1, 30000) g`,
  );
  await db.query(`INSERT INTO workspaces VALUES('owner', $1::jsonb), ('canary', $2::jsonb)`, [
    JSON.stringify({ agents: [agent('o-1'), agent('d-1', { demoKey: 'Scout' })] }),
    JSON.stringify({ agents: [agent('c-1'), agent('c-2')] }),
  ]);
  await db.exec(COUNTED_AGENT_IDS_SQL);
  await db.query('ANALYZE');
  const excluded = ['canary'];
  const time = async (sql: string) => {
    const started = performance.now();
    const n = Number((await db.query<{ n: string }>(sql, [excluded])).rows[0]!.n);
    return { n, ms: performance.now() - started };
  };
  // Warm both once, then measure.
  await time(AI_AGENTS_TOTAL_SQL);
  await time(AI_AGENTS_TOTAL_SCAN_SQL);
  const kept = await time(AI_AGENTS_TOTAL_SQL);
  const scan = await time(AI_AGENTS_TOTAL_SCAN_SQL);
  t.diagnostic(
    `30,001 agents: kept ids ${Math.round(kept.ms)} ms, document scan ${Math.round(scan.ms)} ms`,
  );
  assert.equal(kept.n, 30_001);
  assert.equal(scan.n, 30_001);
  assert.equal(await countAiAgentsTotal(db, excluded), 30_001);
  // The kept count reads no workspace document: faster than the scan, and well under a second.
  assert.ok(kept.ms < scan.ms, `kept ${kept.ms} ms vs scan ${scan.ms} ms`);
  assert.ok(kept.ms < 1_000, `took ${kept.ms} ms`);
  // The migration SQL is idempotent: running it again changes nothing.
  await db.exec(COUNTED_AGENT_IDS_SQL);
  assert.equal((await time(AI_AGENTS_TOTAL_SQL)).n, 30_001);
});

/** A database with workspaces, the migration 28 table, and a counter of aggregate queries. */
async function shared(t: { after: (fn: () => Promise<unknown>) => void }) {
  const { db, put } = await table(t);
  await db.exec(publicStatsMigration.sql);
  let counts = 0;
  let fail = false;
  const counted = {
    query: (async (sql: string, params?: unknown[]) => {
      if (sql === AI_AGENTS_TOTAL_SQL) {
        counts++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (fail) throw new Error('database unavailable');
      }
      return db.query(sql, params as never);
    }) as never,
  };
  return {
    db,
    put,
    counted,
    counts: () => counts,
    setFail: (value: boolean) => {
      fail = value;
    },
  };
}

test('one instance: one count per TTL, shared by concurrent callers, stale on failure', async (t) => {
  const s = await shared(t);
  await s.put('owner-1', [agent('a1'), agent('a2'), agent('a3')]);
  let now = 1_000_000;
  const stats = createPublicStats({ clock: () => now, db: s.counted });
  const [a, b, c] = await Promise.all([stats.get(), stats.get(), stats.get()]);
  assert.equal(s.counts(), 1);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.deepEqual(a, { ai_agents_total: 3, updated_at: new Date(now).toISOString() });
  await s.put('owner-2', [agent('a4')]);
  now += PUBLIC_STATS_TTL_MS - 1;
  assert.equal((await stats.get()).ai_agents_total, 3);
  assert.equal(s.counts(), 1);
  now += 1;
  assert.equal((await stats.get()).ai_agents_total, 4);
  assert.equal(s.counts(), 2);
  // A failed refresh keeps serving the last value.
  s.setFail(true);
  now += PUBLIC_STATS_TTL_MS;
  assert.equal((await stats.get()).ai_agents_total, 4);
  // Without any value, the failure surfaces.
  const cold = createPublicStats({
    clock: () => now,
    db: { query: (async () => Promise.reject(new Error('down'))) as never },
  });
  await assert.rejects(cold.get(), /down/);
});

test('many instances share one row: about one count per TTL globally', async (t) => {
  const s = await shared(t);
  await s.put('owner-1', [agent('a1'), agent('a2')]);
  let now = 2_000_000;
  const instances = Array.from({ length: 5 }, () =>
    createPublicStats({ clock: () => now, db: s.counted }),
  );
  // Cold start: the very first requests may count locally (nothing stored yet), but only the
  // lease winner writes; after that every instance reads the row.
  await Promise.all(instances.map((x) => x.get()));
  const cold = s.counts();
  assert.ok(cold >= 1 && cold <= instances.length, `cold counts ${cold}`);
  now += PUBLIC_STATS_RETRY_MS;
  const warm = await Promise.all(instances.map((x) => x.get()));
  assert.ok(warm.every((v) => v.ai_agents_total === 2));
  assert.equal(new Set(warm.map((v) => v.updated_at)).size, 1, 'one shared value');
  // Every later TTL: exactly one count across all instances.
  for (let round = 1; round <= 3; round++) {
    await s.put(`owner-${round + 1}`, [agent(`n${round}`)]);
    now += PUBLIC_STATS_TTL_MS;
    const before = s.counts();
    await Promise.all(instances.map((x) => x.get()));
    now += PUBLIC_STATS_RETRY_MS;
    const values = await Promise.all(instances.map((x) => x.get()));
    assert.equal(s.counts() - before, 1, `round ${round}`);
    assert.ok(
      values.every((v) => v.ai_agents_total === 2 + round),
      `round ${round}`,
    );
  }
});

test("the refresh lease runs on the database clock; a crashed winner's lease expires", async (t) => {
  const s = await shared(t);
  await s.put('owner-1', [agent('a1')]);
  const store = sqlPublicStatsStore(s.db);
  let now = 3_000_000;
  assert.equal(
    await store.claim('ai_agents_total', now, PUBLIC_STATS_TTL_MS, PUBLIC_STATS_LEASE_MS),
    true,
  );
  assert.equal(await store.write('ai_agents_total', 7, now), true);
  now += PUBLIC_STATS_TTL_MS;
  // A winner claims the stale row and "crashes" before writing.
  assert.equal(
    await store.claim('ai_agents_total', now, PUBLIC_STATS_TTL_MS, PUBLIC_STATS_LEASE_MS),
    true,
  );
  // The lease is stamped in database time (not the instance clock, which is at 3,015,000 here).
  const lease = Number(
    (await s.db.query<{ r: string }>('SELECT refreshing_until AS r FROM public_stats')).rows[0]!.r,
  );
  assert.ok(Math.abs(lease - (Date.now() + PUBLIC_STATS_LEASE_MS)) < 5_000, `lease ${lease}`);
  // While the lease lives, nobody else wins, whatever their own clock says, and readers serve 7.
  assert.equal(
    await store.claim(
      'ai_agents_total',
      now + 10 * PUBLIC_STATS_LEASE_MS,
      PUBLIC_STATS_TTL_MS,
      PUBLIC_STATS_LEASE_MS,
    ),
    false,
  );
  const reader = createPublicStats({ clock: () => now + 1, db: s.counted });
  assert.equal((await reader.get()).ai_agents_total, 7);
  assert.equal(s.counts(), 0);
  // Once the lease has expired in database time, another instance takes over and counts.
  await s.db.query('UPDATE public_stats SET refreshing_until = refreshing_until - $1', [
    2 * PUBLIC_STATS_LEASE_MS,
  ]);
  const next = createPublicStats({ clock: () => now + 2, db: s.counted });
  assert.equal((await next.get()).ai_agents_total, 1);
  assert.equal(s.counts(), 1);
});

test('a slow count never overwrites a newer total: values are stamped with the claim time', async (t) => {
  const s = await shared(t);
  const store = sqlPublicStatsStore(s.db);
  const ttl = PUBLIC_STATS_TTL_MS;
  const t1 = 4_000_000;
  // Instance A claims at t1 and starts a slow count (it will find 4 agents).
  assert.equal(await store.claim('ai_agents_total', t1, ttl, PUBLIC_STATS_LEASE_MS), true);
  // A's lease expires (database time); instance B claims later, at t2, and stores 5 first.
  await s.db.query('UPDATE public_stats SET refreshing_until = 0');
  const t2 = t1 + 1;
  assert.equal(await store.claim('ai_agents_total', t2, ttl, PUBLIC_STATS_LEASE_MS), true);
  assert.equal(await store.write('ai_agents_total', 5, t2), true);
  // A finishes last, but its claim is older: refused, and the newer total stays.
  assert.equal(await store.write('ai_agents_total', 4, t1), false);
  assert.deepEqual(await store.read('ai_agents_total'), { value: 5, refreshedAt: t2 });
  // Through the service: the value is stamped with the claim time, not the finish time.
  await s.put('owner-1', [agent('a1'), agent('a2')]);
  let clock = t2 + ttl;
  const service = createPublicStats({
    db: {
      query: (async (sql: string, params?: unknown[]) => {
        if (sql === AI_AGENTS_TOTAL_SQL) clock += 3_000; // the count takes 3 s
        return s.db.query(sql, params as never);
      }) as never,
    },
    clock: () => clock,
  });
  const got = await service.get();
  assert.equal(got.ai_agents_total, 2);
  assert.equal(got.updated_at, new Date(t2 + ttl).toISOString());
  assert.equal((await store.read('ai_agents_total'))!.refreshedAt, t2 + ttl);
});

async function stats(app: App, remoteAddress = '127.0.0.1') {
  const res = await app.inject({ method: 'GET', url: '/api/public/stats', remoteAddress });
  return res;
}

test('GET /api/public/stats: unauthenticated, cacheable, only the number, and counts every way in', async (t) => {
  let now = Date.parse('2026-09-27T12:00:00.000Z');
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => now });
  t.after(() => app.close());
  const tick = () => (now += PUBLIC_STATS_TTL_MS);

  const empty = await stats(app);
  assert.equal(empty.statusCode, 200, empty.body);
  assert.equal(empty.headers['cache-control'], PUBLIC_STATS_CACHE_CONTROL);
  // Edge only: fresh 15 s, then served stale for up to a day while one request refreshes it.
  assert.equal(empty.headers['vercel-cdn-cache-control'], PUBLIC_STATS_EDGE_CACHE_CONTROL);
  assert.match(PUBLIC_STATS_EDGE_CACHE_CONTROL, /max-age=15, stale-while-revalidate=86400/);
  assert.equal(empty.headers['set-cookie'], undefined);
  assert.match(String(empty.headers['content-type']), /^application\/json/);
  // The agent count, and the Base agents number (none registered on Base yet).
  assert.deepEqual(Object.keys(empty.json()).sort(), [
    'ai_agents_total',
    'base_agents',
    'updated_at',
  ]);
  assert.deepEqual(empty.json().base_agents, { total: 0, as_of: new Date(now).toISOString() });
  assert.equal(empty.json().ai_agents_total, 0);
  assert.equal(empty.json().updated_at, new Date(now).toISOString());

  // An owner creates an external and a hosted agent (both count), then starts the console demo,
  // whose three seeded sample agents (demoKey) do not.
  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Ticker owner', password: 'Synthetic ticker password' }),
  });
  assert.equal(register.statusCode, 201, register.body);
  const cookie = `cc_session=${register.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const created: Record<string, string> = {};
  for (const mode of ['external', 'hosted'] as const) {
    const res = await ownerApi(app, cookie, '/api/agents', {
      name: `Ticker ${mode}`,
      description: 'Synthetic ticker agent',
      capability: 'extract',
      mode,
    });
    assert.ok([200, 201].includes(res.statusCode), res.body);
    assert.equal(res.json().agent.isDemo, mode === 'hosted');
    created[mode] = res.json().agent.id;
  }
  assert.equal((await ownerApi(app, cookie, '/api/demo/start', {})).statusCode, 200);
  const snapshot = (await ownerApi(app, cookie, '/api/snapshot')).json();
  assert.equal(snapshot.agents.length, 5);

  // Within the TTL the cached value is served.
  assert.equal((await stats(app)).json().ai_agents_total, 0);
  tick();
  assert.equal((await stats(app)).json().ai_agents_total, 2);

  // An AI client creates agents anonymously (unclaimed): an external runtime and a template agent
  // (hosted, so isDemo) both count.
  const anonymous = async (body: Record<string, unknown>) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/agents',
      remoteAddress: '198.51.100.7',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ...body, idempotency_key: randomUUID() }),
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json();
  };
  const external = await anonymous({
    manifest: {
      apiVersion: 'centralcity.agent/v1',
      kind: 'Agent',
      metadata: { name: 'ticker-anonymous' },
      spec: { capabilities: ['research'], runtime: { mode: 'external' } },
    },
  });
  assert.equal(external.agent.isDemo, false);
  assert.equal((await anonymous({ template: 'template:extractor@1.0.0' })).agent.isDemo, true);
  tick();
  assert.equal((await stats(app)).json().ai_agents_total, 4);

  // Claiming moves the unclaimed agent into the owner's account: still one agent, not two.
  const claimToken = external.claim?.claim_token;
  assert.match(String(claimToken), /^ccclaim_/);
  const claimed = await ownerApi(app, cookie, '/api/agents/claim', { claim_token: claimToken });
  assert.equal(claimed.statusCode, 200, claimed.body);
  // Revoking keeps it counted: the count is of agents that ever joined.
  const revoked = await ownerApi(app, cookie, `/api/agents/${created.external}/revoke`, {});
  assert.equal(revoked.statusCode, 200, revoked.body);
  tick();
  const after = await stats(app);
  assert.equal(after.json().ai_agents_total, 4);
  assert.equal(after.json().updated_at, new Date(now).toISOString());
});

test('GET /api/public/stats is rate limited per client address', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  for (let i = 0; i < PUBLIC_STATS_RATE.max; i++)
    assert.equal((await stats(app, '203.0.113.9')).statusCode, 200);
  const limited = await stats(app, '203.0.113.9');
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  // Another address is unaffected.
  assert.equal((await stats(app, '203.0.113.10')).statusCode, 200);
});

test('a query string on /api/public/stats is redirected at the handler, never reaching the app', async () => {
  const { createHostedHandler, publicStatsRedirect, withoutRewriteParameter } =
    await import('../server/vercel-handler.js');
  // The Vercel rewrite parameter alone is not a client query: no redirect (no loop).
  for (const url of [
    '/api/public/stats',
    '/api/public/stats?path=public%2Fstats',
    '/api/public/stats?path=public/stats',
  ]) {
    assert.equal(publicStatsRedirect('GET', withoutRewriteParameter(url)), null, url);
  }
  assert.equal(publicStatsRedirect('GET', '/api/public/stats?x=1'), '/api/public/stats');
  assert.equal(publicStatsRedirect('HEAD', '/api/public/stats?'), '/api/public/stats');
  assert.equal(publicStatsRedirect('POST', '/api/public/stats?x=1'), null);
  assert.equal(publicStatsRedirect('GET', '/api/public/statsx?x=1'), null);
  assert.equal(publicStatsRedirect('GET', '/api/public/agents?x=1'), null);

  let created = 0;
  const handler = createHostedHandler(async () => {
    created++;
    throw new Error('the application must not start for a redirected request');
  });
  const written: { status?: number; headers?: Record<string, string>; ended?: boolean } = {};
  const response = {
    writeHead(status: number, headers: Record<string, string>) {
      written.status = status;
      written.headers = headers;
      return this;
    },
    end() {
      written.ended = true;
    },
  };
  await handler(
    { method: 'GET', url: '/api/public/stats?random=123&path=public%2Fstats' } as never,
    response as never,
  );
  assert.equal(created, 0);
  assert.equal(written.status, 308);
  assert.equal(written.headers!.Location, '/api/public/stats');
  assert.match(written.headers!['Cache-Control']!, /s-maxage=/);
  assert.equal(written.ended, true);
});

// ---------------------------------------------------------------------------------------------
// paid_calls: the paid service calls on Base mainnet (migration 125, server/stats/paid-calls.ts)

const AT = Date.parse('2026-10-15T14:02:11.402Z');

/** The route alone, with a fixed agent count and the given paid calls reader. */
async function statsRoute(
  t: { after: (fn: () => unknown) => void },
  deps: {
    paidCalls?: PaidCallsReader;
    env?: Record<string, string | undefined>;
    stats?: PublicStatsService;
    clock?: () => number;
    paidCallsBudgetMs?: number;
  } = {},
) {
  const app = Fastify();
  t.after(() => app.close());
  registerPublicStatsRoutes(app, {
    stats: deps.stats ?? {
      get: async () => ({ ai_agents_total: 42, updated_at: new Date(AT).toISOString() }),
    },
    limit: async () => {},
    paidCalls: deps.paidCalls,
    env: deps.env ?? {},
    clock: deps.clock ?? (() => AT),
    paidCallsBudgetMs: deps.paidCallsBudgetMs,
  });
  const get = async () => {
    const res = await app.inject({ method: 'GET', url: '/api/public/stats' });
    assert.equal(res.statusCode, 200, res.body);
    return res;
  };
  return { get };
}

const snapshot = (total: number, recent: number[] = []): PaidCallsSnapshot => ({
  total,
  recent,
  dbNowMs: AT,
  readAt: AT,
});

test('paid_calls: the field rides on the stats response, with the cache headers unchanged', async (t) => {
  const reader: PaidCallsReader = { read: async () => snapshot(1284, [AT - 1200, AT - 9800]) };
  const { get } = await statsRoute(t, { paidCalls: reader });
  const res = await get();
  assert.deepEqual(res.json(), {
    ai_agents_total: 42,
    updated_at: new Date(AT).toISOString(),
    paid_calls: {
      total: 1284,
      as_of: '2026-10-15T14:02:11.402Z',
      recent_ms: [1200, 9800],
      recent_complete: true,
    },
  });
  assert.equal(res.headers['cache-control'], PUBLIC_STATS_CACHE_CONTROL);
  assert.equal(res.headers['vercel-cdn-cache-control'], PUBLIC_STATS_EDGE_CACHE_CONTROL);
  assert.equal(res.headers['set-cookie'], undefined);
  // Never anything about who paid, which service, or how much.
  assert.deepEqual(Object.keys(res.json().paid_calls).sort(), [
    'as_of',
    'recent_complete',
    'recent_ms',
    'total',
  ]);
});

test('paid_calls is left out while switched off, before the row exists, or when its read fails; the agent count is still served', async (t) => {
  const on: PaidCallsReader = { read: async () => snapshot(3) };
  const cases: Array<[string, PaidCallsReader | undefined, Record<string, string | undefined>]> = [
    ['flag 0', on, { [PAID_CALLS_FLAG]: '0' }],
    ['no reader', undefined, {}],
    ['no row yet', { read: async () => null }, {}],
    [
      'read fails',
      {
        read: async () => {
          throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
        },
      },
      {},
    ],
  ];
  for (const [label, paidCalls, env] of cases) {
    const { get } = await statsRoute(t, { paidCalls, env });
    assert.deepEqual(
      (await get()).json(),
      { ai_agents_total: 42, updated_at: new Date(AT).toISOString() },
      label,
    );
  }
  // Only exactly '0' turns it off: unset, '1' or anything else leaves it on.
  assert.equal(PAID_CALLS_FLAG, 'CITY_PAID_CALLS_TICKER');
  for (const value of [undefined, '1', 'false', 'off', '']) {
    const { get } = await statsRoute(t, { paidCalls: on, env: { [PAID_CALLS_FLAG]: value } });
    assert.equal((await get()).json().paid_calls?.total, 3, String(value));
  }
});

test('paid_calls is read only after the agent count has been read, never alongside it', async (t) => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { get } = await statsRoute(t, {
    stats: {
      get: async () => {
        order.push('agents:start');
        await gate;
        order.push('agents:end');
        return { ai_agents_total: 42, updated_at: new Date(AT).toISOString() };
      },
    },
    paidCalls: {
      read: async () => {
        order.push('paid:start');
        return snapshot(1);
      },
    },
  });
  const pending = get();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ['agents:start']);
  release();
  assert.equal((await pending).json().paid_calls.total, 1);
  assert.deepEqual(order, ['agents:start', 'agents:end', 'paid:start']);
});

test('paid_calls never holds up the agent count: a slow read waits at most 250 ms, then the last good row or nothing', async (t) => {
  assert.equal(PAID_CALLS_READ_BUDGET_MS, 250);
  assert.equal(PAID_CALLS_LAST_GOOD_MS, 120_000);
  let now = AT;
  let last: PaidCallsSnapshot | null = null;
  const slow: PaidCallsReader = {
    read: () => new Promise((resolve) => setTimeout(() => resolve(snapshot(9)), 2_000).unref()),
    lastGood: () => last,
  };
  const { get } = await statsRoute(t, { paidCalls: slow, clock: () => now });
  // No good row yet: the agent count answers within the budget, without the field.
  let started = Date.now();
  let res = await get();
  let took = Date.now() - started;
  assert.ok(took < 1_000, `answered in ${took} ms`);
  assert.deepEqual(res.json(), { ai_agents_total: 42, updated_at: new Date(AT).toISOString() });
  // With a good row from 10 s ago: that row, as of its own read (never newer than it is).
  last = { total: 1284, recent: [AT - 11_000], dbNowMs: AT - 10_000, readAt: AT - 10_000 };
  started = Date.now();
  res = await get();
  took = Date.now() - started;
  assert.ok(took < 1_000, `answered in ${took} ms`);
  assert.deepEqual(res.json().paid_calls, {
    total: 1284,
    as_of: new Date(AT - 10_000).toISOString(),
    recent_ms: [1_000],
    recent_complete: true,
  });
  // A good row older than two minutes is not served.
  now = AT - 10_000 + PAID_CALLS_LAST_GOOD_MS + 1;
  assert.equal((await get()).json().paid_calls, undefined);
  // A read inside the budget is served as it is.
  const quick: PaidCallsReader = {
    read: () => new Promise((resolve) => setTimeout(() => resolve(snapshot(7)), 20)),
    lastGood: () => null,
  };
  const fast = await statsRoute(t, { paidCalls: quick });
  assert.equal((await fast.get()).json().paid_calls.total, 7);
});

test('paid_calls: a failed read serves the last good row instead of hiding the count', async (t) => {
  let fail = false;
  let now = AT;
  const reader = createPaidCallsReader({
    db: {
      query: async () => {
        if (fail) throw Object.assign(new Error('down'), { code: '57P01' });
        return {
          rows: [{ total: '1284', recent: [], now_ms: String(now) }],
        } as never;
      },
    },
    clock: () => now,
  });
  const { get } = await statsRoute(t, { paidCalls: reader, clock: () => now });
  assert.equal((await get()).json().paid_calls.total, 1284);
  const readAt = now;
  now += PAID_CALLS_CACHE_MS;
  fail = true;
  // The database blips: the count stays, as of the last good read.
  const kept = (await get()).json().paid_calls;
  assert.equal(kept.total, 1284);
  assert.equal(kept.as_of, new Date(readAt).toISOString());
  assert.equal(reader.lastGood?.()?.total, 1284);
  // Still down two minutes later: the field is left out.
  now = readAt + PAID_CALLS_LAST_GOOD_MS + 1;
  assert.equal((await get()).json().paid_calls, undefined);
  // Back up: a fresh read.
  fail = false;
  now += PAID_CALLS_CACHE_MS;
  assert.equal((await get()).json().paid_calls.as_of, new Date(now).toISOString());
});

test('paid_calls: recent_ms keeps the 120 s window, newest first, never below 0; recent_complete', () => {
  assert.equal(PAID_CALLS_RECENT_WINDOW_MS, 120_000);
  assert.equal(PAID_CALLS_RECENT_MAX, 64);
  // Newest first, in the window only; a block stamped ahead of the database clock reads 0.
  const field = paidCallsField(
    snapshot(10, [AT + 300, AT - 1_000, AT - 119_999, AT - 120_001, AT - 500_000]),
    AT,
  );
  assert.deepEqual(field, {
    total: 10,
    as_of: new Date(AT).toISOString(),
    recent_ms: [0, 1_000, 119_999],
    recent_complete: true,
  });
  // The time the row spent in this server's memory is part of every age, and of as_of.
  const later = paidCallsField(snapshot(10, [AT - 1_000]), AT + 4_000);
  assert.equal(later.as_of, new Date(AT + 4_000).toISOString());
  assert.deepEqual(later.recent_ms, [5_000]);
  // All 64 kept times inside the window: more may exist than are listed.
  const busy = Array.from({ length: 64 }, (_, i) => AT - i * 1_000);
  assert.deepEqual(paidCallsField(snapshot(500, busy), AT).recent_complete, false);
  assert.equal(paidCallsField(snapshot(500, busy), AT).recent_ms.length, 64);
  // 64 kept, the oldest outside the window: the list is complete.
  const spread = [...busy.slice(0, 63), AT - 200_000];
  assert.deepEqual(paidCallsField(snapshot(500, spread), AT).recent_complete, true);
  // Fewer than 64 kept: complete. Never more listed than the total (after a repair downward).
  assert.equal(paidCallsField(snapshot(2, busy.slice(0, 5)), AT).recent_complete, true);
  assert.equal(paidCallsField(snapshot(2, busy.slice(0, 5)), AT).recent_ms.length, 2);
});

test('the paid calls reader: one primary-key read of chain 8453, kept 5 s, one shared read, failures not repeated', async (t) => {
  assert.equal(PAID_CALLS_CHAIN_ID, 8453);
  assert.equal(PAID_CALLS_CACHE_MS, 5_000);
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE paid_call_count (chain_id integer PRIMARY KEY, total bigint NOT NULL,
    recent bigint[] NOT NULL DEFAULT '{}', updated_at bigint NOT NULL)`);
  let now = AT;
  const reads: unknown[][] = [];
  let fail = false;
  const reader = createPaidCallsReader({
    db: {
      query: async (sql, params) => {
        assert.equal(sql, PAID_CALLS_READ_SQL);
        reads.push(params ?? []);
        if (fail) throw new Error('down');
        return db.query(sql, params) as never;
      },
    },
    clock: () => now,
  });
  // Before the row exists: nothing to show.
  assert.equal(await reader.read(), null);
  assert.deepEqual(reads, [[8453]]);
  await db.query(
    "INSERT INTO paid_call_count VALUES (8453, 1284, '{1700000000000,1690000000000}', 1), (84532, 9, '{}', 1)",
  );
  // Within 5 s the remembered answer is served.
  now += PAID_CALLS_CACHE_MS - 1;
  assert.equal(await reader.read(), null);
  assert.equal(reads.length, 1);
  now += 1;
  const [a, b] = await Promise.all([reader.read(), reader.read()]);
  assert.equal(reads.length, 2, 'concurrent callers share one read');
  assert.deepEqual(a, b);
  assert.equal(a?.total, 1284);
  assert.deepEqual(a?.recent, [1_700_000_000_000, 1_690_000_000_000]);
  assert.ok(Math.abs(a!.dbNowMs - Date.now()) < 60_000, 'the database clock');
  assert.equal(a?.readAt, now);
  // A failed read is remembered for the same 5 s: the field is left out, without a read per request.
  now += PAID_CALLS_CACHE_MS;
  fail = true;
  await assert.rejects(reader.read(), /down/);
  await assert.rejects(reader.read());
  assert.equal(reads.length, 3);
  now += PAID_CALLS_CACHE_MS;
  fail = false;
  assert.equal((await reader.read())?.total, 1284);
  assert.equal(reads.length, 4);
});

test('GET /api/public/stats in the app: paid_calls appears once Base mainnet has paid calls, never Sepolia, and CITY_PAID_CALLS_TICKER=0 hides it', async (t) => {
  const saved = process.env[PAID_CALLS_FLAG];
  t.after(() => {
    if (saved === undefined) delete process.env[PAID_CALLS_FLAG];
    else process.env[PAID_CALLS_FLAG] = saved;
  });
  delete process.env[PAID_CALLS_FLAG];
  let now = Date.parse('2026-10-15T12:00:00.000Z');
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => now });
  t.after(() => app.close());
  // No counter row yet: the agent count keys and the Base agents number, no paid_calls.
  assert.deepEqual(Object.keys((await stats(app)).json()).sort(), [
    'ai_agents_total',
    'base_agents',
    'updated_at',
  ]);
  // A Sepolia count never shows.
  await app.city.db.query("INSERT INTO paid_call_count VALUES (84532, 5, '{}', 1)");
  now += PAID_CALLS_CACHE_MS;
  assert.equal((await stats(app)).json().paid_calls, undefined);
  await app.city.db.query("INSERT INTO paid_call_count VALUES (8453, 1284, '{}', 1)");
  now += PAID_CALLS_CACHE_MS;
  const shown = await stats(app);
  assert.equal(shown.json().paid_calls.total, 1284);
  assert.deepEqual(shown.json().paid_calls.recent_ms, []);
  assert.equal(shown.json().paid_calls.recent_complete, true);
  assert.equal(shown.headers['cache-control'], PUBLIC_STATS_CACHE_CONTROL);
  // The emergency off, read per request.
  process.env[PAID_CALLS_FLAG] = '0';
  assert.equal((await stats(app)).json().paid_calls, undefined);
  assert.equal(typeof (await stats(app)).json().ai_agents_total, 'number');
  delete process.env[PAID_CALLS_FLAG];
  assert.equal((await stats(app)).json().paid_calls.total, 1284);
});

// ---------------------------------------------------------------------------------------------
// base_agents: the Agent Explorer's "On Base now" total (server/stats/base-agents.ts)

test('base_agents counts exactly what the Agent Explorer counts as On Base now', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120 });
  await add(db, { n: 2, kind: 'finalizing', id: 130 });
  await add(db, { n: 3, kind: 'final', id: 110, revoked: true });
  await add(db, { n: 4, kind: 'final', id: 100, visibility: 'private' });
  // Never counted: not yet safe, registering, failed, another registry, URI or network.
  await add(db, { n: 5, kind: 'included', id: 140 });
  await add(db, { n: 6, kind: 'pending' });
  await add(db, { n: 7, kind: 'failed' });
  await add(db, { n: 8, kind: 'final', id: 150, registry: SEPOLIA_REGISTRY });
  await add(db, { n: 9, kind: 'final', id: 160, uri: 'https://example.com/a/S00009' });
  await add(db, { n: 10, kind: 'final', id: 170, chainId: 84532 });
  await add(db, { n: 13, kind: 'final', id: 200, seenAt: null });
  const explorer = await createOnBaseStore(db, { chainId: 8453 }).totals(NOW);
  assert.equal(explorer.onBase, 4);
  assert.equal(await countBaseAgents(db), explorer.onBase);
  // It never reads workspace documents.
  assert.doesNotMatch(BASE_AGENTS_COUNT_SQL, /workspaces|->'agents'/);
});

/** The shared row with a counted, failing-on-demand Base agents count. */
async function baseShared(t: { after: (fn: () => Promise<unknown>) => void }) {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(publicStatsMigration.sql);
  const state = { counts: 0, value: 31_452, fail: false, delayMs: 5 };
  const count = async () => {
    state.counts++;
    await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (state.fail) throw new Error('database unavailable');
    return state.value;
  };
  const store = sqlPublicStatsStore(db as never);
  return { db, store, state, count };
}

test('base_agents: about one count per TTL across instances; only the lease holder counts', async (t) => {
  const s = await baseShared(t);
  let now = 5_000_000;
  const instances = Array.from({ length: 5 }, () =>
    createBaseAgentsReader({ db: s.db as never, store: s.store, clock: () => now, count: s.count }),
  );
  const first = await Promise.all(instances.map((x) => x.read()));
  // Only the lease winner counts, even before any value exists; the others answer none for now.
  assert.equal(s.state.counts, 1);
  assert.equal(first.filter((v) => v?.value === 31_452).length, 1);
  assert.equal(first.filter((v) => v === null).length, 4);
  now += PUBLIC_STATS_RETRY_MS;
  const warm = await Promise.all(instances.map((x) => x.read()));
  assert.ok(warm.every((v) => v?.value === 31_452 && v.refreshedAt === 5_000_000));
  for (let round = 1; round <= 3; round++) {
    s.state.value += round;
    now += PUBLIC_STATS_TTL_MS;
    const before: number = s.state.counts;
    await Promise.all(instances.map((x) => x.read()));
    now += PUBLIC_STATS_RETRY_MS;
    const values = await Promise.all(instances.map((x) => x.read()));
    assert.equal(s.state.counts - before, 1, `round ${round}`);
    assert.ok(
      values.every((v) => v?.value === s.state.value),
      `round ${round}`,
    );
  }
});

test('base_agents: a failed count serves the last value and nobody counts again for a minute', async (t) => {
  const s = await baseShared(t);
  let now = 6_000_000;
  const a = createBaseAgentsReader({
    db: s.db as never,
    store: s.store,
    clock: () => now,
    count: s.count,
  });
  const b = createBaseAgentsReader({
    db: s.db as never,
    store: s.store,
    clock: () => now,
    count: s.count,
  });
  assert.equal((await a.read())?.value, 31_452);
  s.state.fail = true;
  now += PUBLIC_STATS_TTL_MS;
  assert.equal((await a.read())?.value, 31_452);
  assert.equal(s.state.counts, 2);
  // The holder keeps the shared lease through the back-off: the other instance does not count.
  now += PUBLIC_STATS_LEASE_MS + 1_000;
  assert.equal((await b.read())?.value, 31_452);
  assert.equal((await a.read())?.value, 31_452);
  assert.equal(s.state.counts, 2);
  assert.ok(BASE_AGENTS_FAILURE_BACKOFF_MS >= 60_000);
  // Without any value, the failure surfaces (the route then leaves the field out).
  const cold = createBaseAgentsReader({
    db: s.db as never,
    store: { ...s.store, read: async () => Promise.reject(new Error('down')) },
    clock: () => now,
  });
  await assert.rejects(cold.read(), /down/);
  await assert.rejects(cold.read(), /down/);
});

test('base_agents: a slow recount on a fresh instance still answers the stored number, and the count runs past the response', async (t) => {
  const s = await baseShared(t);
  let now = 7_000_000;
  const clock = () => now;
  const first = createBaseAgentsReader({
    db: s.db as never,
    store: s.store,
    clock,
    count: s.count,
  });
  assert.equal((await first.read())?.value, 31_452);
  // Much later (the stored row is stale), a fresh instance claims the recount, which is slow.
  now += 30 * 60_000;
  s.state.value = 39_037;
  s.state.delayMs = 400;
  const fresh = createBaseAgentsReader({
    db: s.db as never,
    store: s.store,
    clock,
    count: s.count,
  });
  const kept: Promise<unknown>[] = [];
  const key = Symbol.for('@vercel/request-context');
  const g = globalThis as unknown as Record<symbol, unknown>;
  g[key] = { get: () => ({ waitUntil: (p: Promise<unknown>) => kept.push(p) }) };
  t.after(() => delete g[key]);
  const field = await baseAgentsForResponse(fresh, clock, 50);
  // The response did not wait: it answers the stored number (30 minutes old), never nothing.
  assert.deepEqual(field, { total: 31_452, as_of: new Date(7_000_000).toISOString() });
  // The count was handed to waitUntil and finishes; the next response has the new number.
  assert.equal(kept.length, 1);
  await Promise.all(kept);
  assert.equal((await baseAgentsForResponse(fresh, clock, 50))?.total, 39_037);
  assert.equal(BASE_AGENTS_LAST_GOOD_MS, 60 * 60_000);
});

test('base_agents rides on the stats response; left out when unavailable; never holds it up', async (t) => {
  const stat = { value: 31_452, refreshedAt: AT - 2_000 };
  let read: () => Promise<{ value: number; refreshedAt: number } | null> = async () => stat;
  let last: { value: number; refreshedAt: number } | null = null;
  const reader = { read: () => read(), lastGood: () => last };
  const app = Fastify();
  t.after(() => app.close());
  registerPublicStatsRoutes(app, {
    stats: { get: async () => ({ ai_agents_total: 42, updated_at: new Date(AT).toISOString() }) },
    limit: async () => {},
    env: {},
    clock: () => AT,
    baseAgents: reader,
    baseAgentsBudgetMs: 50,
  });
  const get = async () => (await app.inject({ method: 'GET', url: '/api/public/stats' })).json();
  assert.deepEqual((await get()).base_agents, {
    total: 31_452,
    as_of: new Date(AT - 2_000).toISOString(),
  });
  assert.deepEqual(Object.keys(await get()).sort(), [
    'ai_agents_total',
    'base_agents',
    'updated_at',
  ]);
  // Not counted yet anywhere: left out; the agent count is still served.
  read = async () => null;
  const none = await get();
  assert.equal(none.base_agents, undefined);
  assert.equal(none.ai_agents_total, 42);
  // A failed or slow read: the last value while it is recent, else nothing.
  read = async () => Promise.reject(new Error('down'));
  assert.equal((await get()).base_agents, undefined);
  last = stat;
  assert.equal((await get()).base_agents.total, 31_452);
  read = () => new Promise(() => undefined);
  const started = performance.now();
  assert.equal((await get()).base_agents.total, 31_452);
  assert.ok(performance.now() - started < 1_000);
  last = { value: 1, refreshedAt: AT - BASE_AGENTS_LAST_GOOD_MS - 1 };
  assert.equal((await get()).base_agents, undefined);
});
