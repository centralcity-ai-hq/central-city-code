/**
 * Benchmark for the signed-in endpoints GET /api/snapshot and GET /api/elric (hosted mode).
 *
 *   pnpm exec tsx scripts/perf/signed-in.ts [--agents=80000] [--rtt=1] [--runs=40] [--verbose]
 *
 * Runs the hosted app on an in-memory PGlite, seeds one signed-in account plus `--agents` agents
 * in other workspaces (and matching Elric invocation rows), and reports for each endpoint the
 * database round trips per request and the cold (first) and warm (p50/p95) times. `--rtt` adds
 * that many milliseconds to every database round trip (BEGIN and COMMIT included) to model the
 * network between the function and the database. Synthetic data only.
 */
import { performance } from 'node:perf_hooks';

const arg = (name: string, fallback: number) => {
  const found = process.argv.find((item) => item.startsWith(`--${name}=`));
  return found ? Number(found.split('=')[1]) : fallback;
};
const AGENTS = arg('agents', 80_000);
const RTT = arg('rtt', 1);
const RUNS = arg('runs', 40);
const VERBOSE = process.argv.includes('--verbose');

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-perf-benchmark-root-secret';
process.env.CITY_ELRIC ??= '1';

const importStart = performance.now();
const { createApp } = await import('../../server/app.js');
const importMs = performance.now() - importStart;
const { PGlite } = await import('@electric-sql/pglite');
const { btree_gin } = await import('@electric-sql/pglite/contrib/btree_gin');
type Database = import('../../server/database.js').Database;
type Transaction = import('../../server/database.js').Transaction;

const pglite = await PGlite.create('memory://', { extensions: { btree_gin } });
let trips = 0;
let log: { sql: string; ms: number }[] = [];
const pause = () => (RTT > 0 ? new Promise((r) => setTimeout(r, RTT)) : Promise.resolve());
async function timed<T>(sql: string, run: () => Promise<T>): Promise<T> {
  trips++;
  await pause();
  const start = performance.now();
  try {
    return await run();
  } finally {
    log.push({ sql: sql.replace(/\s+/g, ' ').slice(0, 110), ms: performance.now() - start });
  }
}
const wrap = (q: Transaction): Transaction => ({
  query: (sql, params) => timed(sql, () => q.query(sql, params)) as never,
  exec: (sql) => timed(sql, () => q.exec(sql)),
});
const database: Database = {
  ...wrap(pglite as unknown as Transaction),
  transaction: async (action) => {
    trips++; // BEGIN
    await pause();
    const result = await pglite.transaction((tx) => action(wrap(tx as unknown as Transaction)));
    trips++; // COMMIT
    await pause();
    return result;
  },
  close: () => pglite.close(),
};

const options = {
  hosted: {
    databaseUrl: 'postgres://unused.invalid/perf',
    publicOrigin: 'https://centralcity.ai',
    allowedOrigins: ['https://centralcity.ai'],
  },
  startWorkers: false,
  limits: { apiRequestsPerMinute: 1_000_000 },
};
// The setup instance applies the migrations and seeds; a fresh instance on the current schema
// is then measured, as a cold function start in production would be.
const setup = await createApp({ ...options, database: { ...database, close: async () => {} } });
await setup.ready();
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};
const registered = await setup.inject({
  method: 'POST',
  url: '/api/auth/register',
  headers,
  payload: { name: 'Perf Owner', password: 'Synthetic perf benchmark password' },
  remoteAddress: '203.0.113.7',
});
if (registered.statusCode !== 201) throw new Error(registered.body);
const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
for (let i = 0; i < 5; i++) {
  const created = await setup.inject({
    method: 'POST',
    url: '/api/agents',
    headers: { ...headers, cookie },
    payload: { name: `Perf ${i}`, description: 'x', capability: 'research', mode: 'external' },
    remoteAddress: '203.0.113.7',
  });
  if (created.statusCode !== 201) throw new Error(created.body);
}

// Other workspaces: AI-owned operators with 10 agents each, plus Elric invocation history.
const seedStart = performance.now();
const perWorkspace = 10;
const workspaces = Math.ceil(AGENTS / perWorkspace);
await pglite.query(
  `INSERT INTO operators(id,name,name_key,password_hash,salt,kind)
     SELECT 'perf-'||g, 'Perf '||g, 'perf-'||g, 'x', 'x', 'ai' FROM generate_series(1,$1::int) g`,
  [workspaces],
);
await pglite.query(
  `INSERT INTO workspaces(operator_id,data)
     SELECT 'perf-'||g, jsonb_build_object(
       'agents', (SELECT jsonb_agg(jsonb_build_object('id', 'perf-'||g||'-'||a, 'name', 'Agent '||a,
         'description', repeat('x', 200), 'capability', 'research', 'mode', 'external',
         'status', 'offline', 'createdAt', '2026-01-01T00:00:00.000Z'))
         FROM generate_series(1,$2::int) a),
       'jobs', '[]'::jsonb, 'events', '[]'::jsonb, 'workflows', '[]'::jsonb)
     FROM generate_series(1,$1::int) g`,
  [workspaces, perWorkspace],
);
await pglite.query(
  `INSERT INTO elric_invocations(agent_id,room_id,source_seq,owner_id,invoker_member_id,invoker_kind,
       status,created_at,waking_since)
     SELECT 'perf-elric-'||(g % $2::int), 'perf-room-'||(g % $2::int), g, 'perf-'||(g % $2::int + 1),
       'm', 'owner', CASE WHEN g % 50 = 0 THEN 'queued' ELSE 'done' END, g,
       CASE WHEN g % 10 = 0 THEN g ELSE NULL END
     FROM generate_series(1,$1::int) g`,
  [AGENTS, workspaces],
);
await pglite.exec('ANALYZE');
const seedMs = performance.now() - seedStart;
await setup.close();

trips = 0;
log = [];
const startApp = performance.now();
const app = await createApp({ ...options, database });
await app.ready();
const appMs = performance.now() - startApp;
const startupTrips = trips;
if (VERBOSE)
  for (const entry of log)
    console.log(`  startup ${entry.ms.toFixed(1).padStart(6)} ms  ${entry.sql}`);

async function measure(url: string) {
  const one = async () => {
    trips = 0;
    log = [];
    const start = performance.now();
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { ...headers, cookie },
      remoteAddress: '203.0.113.7',
    });
    const ms = performance.now() - start;
    if (res.statusCode !== 200) throw new Error(`${url}: ${res.statusCode} ${res.body}`);
    return { ms, trips, log };
  };
  const first = await one();
  const warm: number[] = [];
  let steady = first;
  for (let i = 0; i < RUNS; i++) {
    steady = await one();
    warm.push(steady.ms);
  }
  warm.sort((a, b) => a - b);
  const pick = (p: number) => warm[Math.min(warm.length - 1, Math.floor(p * warm.length))]!;
  return {
    url,
    firstMs: first.ms,
    firstTrips: first.trips,
    p50: pick(0.5),
    p95: pick(0.95),
    trips: steady.trips,
    firstLog: first.log,
    log: steady.log,
  };
}

const fmt = (n: number) => n.toFixed(1);
console.log(
  `agents=${AGENTS} rtt=${RTT}ms runs=${RUNS} | import ${fmt(importMs)} ms, createApp+ready ${fmt(appMs)} ms (${startupTrips} round trips), seed ${fmt(seedMs)} ms`,
);
for (const url of ['/api/snapshot', '/api/elric']) {
  const r = await measure(url);
  console.log(
    `${url}: first ${fmt(r.firstMs)} ms (${r.firstTrips} round trips), warm p50 ${fmt(r.p50)} ms p95 ${fmt(r.p95)} ms (${r.trips} round trips)`,
  );
  if (VERBOSE) {
    for (const [label, entries] of [
      ['first', r.firstLog],
      ['warm', r.log],
    ] as const) {
      console.log(`  ${label}:`);
      for (const entry of entries) console.log(`    ${fmt(entry.ms).padStart(6)} ms  ${entry.sql}`);
    }
  }
}
await app.close();
