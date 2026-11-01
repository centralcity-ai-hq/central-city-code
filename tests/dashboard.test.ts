import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import {
  DASHBOARD_ROLLUPS_SQL,
  dashboardRollupsMigration,
  DASHBOARD_TABLES,
} from '../server/dashboard/schema.js';
import {
  ARC_PREFIX,
  BACKFILL_SOURCES,
  addPaid,
  dashboardArcChainId,
  emptyAggregate,
  mergeArc,
  metricsView,
  buildSnapshot,
  runBackfill,
  runDashboardRollup,
  updateLive,
  feeRoute,
} from '../server/dashboard/rollup.js';
import { registerDashboardRoutes, DASHBOARD_CRON_PATH } from '../server/dashboard/routes.js';
import { createWalletsReader } from '../server/dashboard/wallets.js';
import {
  DAY_MS,
  DEFAULT_DASHBOARD_RANGE,
  HOUR_MS,
  parseDashboardChain,
  parseDashboardRange,
  rangeStep,
  priceBucket,
  rangeStart,
  type DashboardBody,
} from '../shared/dashboard.js';
import { DASHBOARD_CONTRACTS, PUBLIC_X402_SETTLE_ACCOUNT } from '../shared/dashboard-contracts.js';
import { PROTOCOL_BASE_MAINNET, X402_FACILITATOR_BASE_MAINNET } from '../shared/protocol.js';
import { BASE_NETWORKS } from '../shared/base/chains.js';
import { AGENT_URI_ORIGIN } from '../shared/base/on-base.js';
import { createApp } from '../server/app.js';
import type { Database } from '../server/database.js';

// 30 Oct 2026 14:30 UTC
const NOW = Date.UTC(2026, 9, 30, 14, 30);
const TODAY = Date.UTC(2026, 9, 30);
const ROUTER1 = PROTOCOL_BASE_MAINNET.feeRouter.toLowerCase();
const ROUTER3 = PROTOCOL_BASE_MAINNET.feeRouter3.toLowerCase();
const REGISTRY = BASE_NETWORKS[8453].contracts.identityRegistry!;
const hex40 = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const hex64 = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

/** The source tables the rollup reads, with the columns it uses (real names and types). */
const SOURCES_SQL = `
CREATE TABLE public_stats (key text PRIMARY KEY, value bigint NOT NULL DEFAULT 0,
  refreshed_at bigint NOT NULL DEFAULT 0, refreshing_until bigint NOT NULL DEFAULT 0);
CREATE TABLE base_wallets (wallet_id text PRIMARY KEY, agent_id text NOT NULL, chain_id integer NOT NULL,
  address text NOT NULL);
CREATE TABLE feed_pay_calls (call_id text PRIMARY KEY, chain_id integer NOT NULL, agent_id text NOT NULL,
  operator_id text NOT NULL, wallet_id text NOT NULL, service_id text NOT NULL, service_title text NOT NULL,
  pay_to text NOT NULL, amount_raw numeric(78,0) NOT NULL, fee_raw numeric(78,0) NOT NULL DEFAULT 0,
  payment_state text, tx_hash text, settled_at bigint);
CREATE TABLE feed_services (id text PRIMARY KEY, title text NOT NULL);
CREATE TABLE feed_pay_sponsored_calls (call_id text PRIMARY KEY, agent_id text NOT NULL, service_id text NOT NULL,
  pay_to text NOT NULL, gross_raw numeric(78,0) NOT NULL, fee_raw numeric(78,0) NOT NULL, state text NOT NULL,
  tx_hash text, updated_at bigint NOT NULL);
CREATE TABLE protocol_fee_events (chain_id integer NOT NULL, tx_hash text NOT NULL, log_index integer NOT NULL,
  emitter text NOT NULL, source text NOT NULL, block_time bigint NOT NULL, payer text NOT NULL, payee text NOT NULL,
  fee numeric(78,0) NOT NULL, gross numeric(78,0) NOT NULL, service_verified boolean NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index));
CREATE TABLE base_wallet_withdrawals (withdrawal_id text PRIMARY KEY, wallet_id text NOT NULL, chain_id integer NOT NULL,
  kind text NOT NULL, state text NOT NULL, created_at bigint NOT NULL);
CREATE TABLE base_short_ids (short_id text PRIMARY KEY, agent_id text NOT NULL UNIQUE);
CREATE TABLE base_identities (agent_id text NOT NULL, chain_id integer NOT NULL, registry_address text NOT NULL,
  erc8004_agent_id numeric, provisional_agent_id numeric, agent_card_uri text NOT NULL, state text NOT NULL,
  mint_seen_at bigint, mint_op_id text, mint_lost_at bigint, destination_mismatch text, mint_finality text,
  handover_id numeric, handover_tx_hash text, handover_finality text, PRIMARY KEY (agent_id, chain_id));
`;

async function seededDb(t: { after: (fn: () => Promise<unknown>) => void }) {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(SOURCES_SQL);
  await db.exec(DASHBOARD_ROLLUPS_SQL);
  return db as unknown as Database & PGlite;
}

let seq = 0;
async function wallet(db: Database, agent: string, address: string) {
  await db.query('INSERT INTO base_wallets VALUES ($1,$2,8453,$3)', [`w_${agent}`, agent, address]);
}
async function call(
  db: Database,
  o: {
    agent: string;
    operator?: string;
    payTo: string;
    at: number;
    amount: number;
    fee?: number;
    service?: string;
    chain?: number;
    state?: string;
  },
) {
  seq += 1;
  await db.query(`INSERT INTO feed_pay_calls VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [
    `fc_${String(seq).padStart(20, 'a')}`,
    o.chain ?? 8453,
    o.agent,
    o.operator ?? 'op_owner',
    `w_${o.agent}`,
    o.service ?? 'svc_a',
    `Service ${o.service ?? 'svc_a'}`,
    o.payTo,
    o.amount,
    o.fee ?? 0,
    o.state ?? 'settled',
    hex64(seq),
    o.at,
  ]);
}
async function fee(
  db: Database,
  o: {
    at: number;
    fee: number;
    emitter?: string;
    source?: string;
    gross?: number;
    verified?: boolean;
  },
) {
  seq += 1;
  await db.query(`INSERT INTO protocol_fee_events VALUES (8453,$1,0,$2,$3,$4,$5,$6,$7,$8,$9)`, [
    hex64(seq),
    o.emitter ?? ROUTER1,
    o.source ?? 'router',
    Math.floor(o.at / 1000),
    hex40(1000 + seq),
    hex40(2000 + seq),
    o.fee,
    o.gross ?? o.fee * 10,
    o.verified ?? true,
  ]);
}

/**
 * History (before today, the live start), live data (today) and a fleet-like operator: agents of
 * one owner buying from each other. Everything must be counted.
 */
async function seed(db: Database) {
  await wallet(db, 'buyer1', hex40(1));
  await wallet(db, 'seller1', hex40(2));
  await wallet(db, 'fleet1', hex40(3));
  await wallet(db, 'fleet2', hex40(4));
  // Yesterday (backfill): 2 calls buyer1 -> seller1 at 0.10 + 0.01 fee; fees 0.02 total.
  const y = TODAY - DAY_MS + 10 * HOUR_MS;
  await call(db, { agent: 'buyer1', payTo: hex40(2), at: y, amount: 100_000, fee: 10_000 });
  await call(db, {
    agent: 'buyer1',
    payTo: hex40(2),
    at: y + 60_000,
    amount: 100_000,
    fee: 10_000,
  });
  await fee(db, { at: y, fee: 10_000 });
  await fee(db, { at: y + 60_000, fee: 10_000, emitter: ROUTER3 });
  // Today (live): buyer1 -> seller1 one call at 0.05; fleet1 -> fleet2 three calls at 1.00.
  await call(db, { agent: 'buyer1', payTo: hex40(2), at: TODAY + 13 * HOUR_MS, amount: 50_000 });
  for (let i = 0; i < 3; i += 1)
    await call(db, {
      agent: 'fleet1',
      operator: 'op_fleet',
      payTo: hex40(4),
      at: TODAY + 14 * HOUR_MS + i * 1000,
      amount: 900_000,
      fee: 100_000,
      service: 'svc_fleet',
    });
  await fee(db, { at: TODAY + 14 * HOUR_MS, fee: 300_000 });
  // Not counted by the paid rule: another chain, and an unsettled payment.
  await call(db, {
    agent: 'buyer1',
    payTo: hex40(2),
    at: TODAY + 13 * HOUR_MS,
    amount: 50_000,
    chain: 84532,
  });
  await call(db, {
    agent: 'buyer1',
    payTo: hex40(2),
    at: TODAY + 13 * HOUR_MS,
    amount: 50_000,
    state: 'sent',
  });
  // A sponsored first purchase today, 0.10 gross.
  await db.query(`INSERT INTO feed_services VALUES ('svc_s','Sponsored svc')`);
  await db.query(
    `INSERT INTO feed_pay_sponsored_calls VALUES ('sp1','buyer2','svc_s',$1,100000,10000,'delivered',$2,$3)`,
    [hex40(2), hex64(999), TODAY + 12 * HOUR_MS],
  );
  // A rating yesterday by seller1.
  await db.query(
    `INSERT INTO base_wallet_withdrawals VALUES ('wd1','w_seller1',8453,'rate','final',$1)`,
    [y],
  );
  // A listed Base agent registered yesterday.
  await db.query(`INSERT INTO base_short_ids VALUES ('ABC123','reg1')`);
  await wallet(db, 'reg1', hex40(5));
  await db.query(
    `INSERT INTO base_identities VALUES ('reg1',8453,$1,7,NULL,$2,'confirmed',$3,NULL,NULL,NULL,'final',7,NULL,'final')`,
    [REGISTRY, `${AGENT_URI_ORIGIN}/a/ABC123`, y],
  );
  await db.query(`INSERT INTO public_stats VALUES ('base_agents_total', 1, 1, 0)`);
}

const noBusy = async () => false;
/** buildSnapshot runs inside a transaction (writeSnapshots), as in production. */
const snap = (
  db: Database,
  range: Parameters<typeof buildSnapshot>[1],
  now: number,
  complete: boolean,
) => db.transaction((tx) => buildSnapshot(tx, range, now, complete));

test('range parsing: the six ranges, a default, nothing else', () => {
  for (const r of ['24h', '7d', '30d', '90d', '12m', 'all'])
    assert.equal(parseDashboardRange(r), r);
  assert.equal(parseDashboardRange(undefined), '30d');
  assert.equal(DEFAULT_DASHBOARD_RANGE, '24h');
  assert.equal(rangeStep('all', 10 * DAY_MS), 'day');
  assert.equal(rangeStep('all', 400 * DAY_MS), 'week');
  assert.equal(rangeStep('12m'), 'week');
  for (const bad of ['', '1y', '24H', ['7d'], 7, 'all ', null])
    assert.equal(parseDashboardRange(bad), null);
  assert.equal(rangeStart('24h', NOW), Date.UTC(2026, 9, 29, 15));
  assert.equal(rangeStart('7d', NOW), Date.UTC(2026, 9, 24));
  assert.equal(rangeStart('all', NOW), 0);
  assert.equal(priceBucket(10_000n), 'p001');
  assert.equal(priceBucket(49_999n), 'p001');
  assert.equal(priceBucket(110_000n), 'p010');
  assert.equal(priceBucket(1_000_000n), 'p100');
});

test('migration 336: additive, next version, recognized by backups', () => {
  assert.equal(dashboardRollupsMigration.version, 336);
  assert.doesNotMatch(DASHBOARD_ROLLUPS_SQL, /\b(DROP|ALTER|TRUNCATE|DELETE)\b/i);
  assert.ok(DASHBOARD_TABLES.includes('dashboard_daily'));
});

test('rollup math: live, backfill and snapshots agree with the seeded sources', async (t) => {
  const db = await seededDb(t);
  await seed(db);
  await updateLive(db, NOW);
  const back = await runBackfill(db, { clock: () => NOW, busy: noBusy, pauseMs: 0, batch: 2 });
  assert.equal(back.stopped, 'done');
  // Re-running live and backfill changes nothing (idempotent).
  await updateLive(db, NOW + 60_000);
  await runBackfill(db, { clock: () => NOW, busy: noBusy, pauseMs: 0 });
  const day = async (d: number, metric: string) =>
    Number(
      (
        await db.query<{ v: string }>(
          'SELECT value::text AS v FROM dashboard_daily WHERE day = $1::date AND metric = $2',
          [new Date(d).toISOString().slice(0, 10), metric],
        )
      ).rows[0]?.v ?? 0,
    );
  const yesterday = TODAY - DAY_MS;
  assert.equal(await day(yesterday, 'calls'), 2);
  assert.equal(await day(yesterday, 'value'), 220_000);
  assert.equal(await day(yesterday, 'fee:router1'), 10_000);
  assert.equal(await day(yesterday, 'fee:router3'), 10_000);
  assert.equal(await day(yesterday, 'ratings'), 1);
  assert.equal(await day(yesterday, 'base_new'), 1);
  // buyer1, seller1 (as seller and rater); the minted reg1 is new, never active
  assert.equal(await day(yesterday, 'active'), 2);
  assert.equal(await day(yesterday, 'hod:10'), 2);
  // Today: 1 + 3 fleet + 1 sponsored.
  assert.equal(await day(TODAY, 'calls'), 5);
  assert.equal(await day(TODAY, 'value'), 50_000 + 3_000_000 + 100_000);
  assert.equal(await day(TODAY, 'fee:router1'), 300_000);
  assert.equal(await day(TODAY, 'price:p100'), 3);
  // buyer1, seller1, fleet1, fleet2, buyer2
  assert.equal(await day(TODAY, 'active'), 5);

  const body = await snap(db, '7d', NOW, true);
  assert.equal(body.kpis.calls, 7);
  // The ledger's volume rule: 100_000 + 100_000 yesterday, 3_000_000 today.
  assert.equal(body.kpis.value_settled_raw, String(3_200_000));
  assert.equal(body.kpis.fees_raw, '320000');
  assert.equal(body.kpis.base_new, 1);
  assert.equal(body.kpis.active, 5);
  assert.deepEqual(body.agents, { buyers_only: 3, sellers_only: 2, both: 0, other: 0 });
  // A mint adds no activity row anywhere.
  for (const table of ['dashboard_agent_last', 'dashboard_active_daily', 'dashboard_active_hourly'])
    assert.equal(
      (await db.query(`SELECT 1 FROM ${table} WHERE agent_id = 'reg1'`)).rows.length,
      0,
      table,
    );
  assert.equal(body.series.length, 7);
  assert.equal(body.previous_series?.length, 7);
  assert.equal(body.previous?.calls, 0);
  assert.equal(body.hour_of_day[14], 3);
  assert.equal(body.fees.routes.find((r) => r.key === 'router3')?.count, 1);
  assert.deepEqual(
    body.top_services.map((s) => [s.title, s.calls]),
    [
      ['Service svc_a', 3],
      ['Service svc_fleet', 3],
      ['Sponsored svc', 1],
    ],
  );
  const day24 = await snap(db, '24h', NOW, true);
  assert.equal(day24.series.length, 24);
  assert.equal(day24.kpis.calls, 5);
  assert.equal(day24.hour_of_day[14], 3);
  const all = await snap(db, 'all', NOW, true);
  assert.equal(all.kpis.calls, 7);
  assert.equal(all.previous, null);
  assert.equal(all.step, 'day');
  assert.ok(all.series.length >= 2);
});

test('no filtering: a fleet-like operator is counted like everyone', async (t) => {
  const db = await seededDb(t);
  await seed(db);
  await updateLive(db, NOW);
  const body = await snap(db, '24h', NOW, true);
  const svc = body.top_services.find((s) => s.title === 'Service svc_fleet');
  assert.equal(svc?.calls, 3);
  assert.ok(body.agents.sellers_only >= 1);
  // Nothing in the answer names an operator or an agent.
  const text = JSON.stringify(body);
  for (const id of ['op_fleet', 'op_owner', 'fleet1', 'buyer1']) assert.ok(!text.includes(id), id);
});

test('backfill: resumable, stops when busy, never counts a batch twice', async (t) => {
  const db = await seededDb(t);
  await seed(db);
  await updateLive(db, NOW);
  const busy = await runBackfill(db, { clock: () => NOW, busy: async () => true, pauseMs: 0 });
  assert.equal(busy.stopped, 'busy');
  assert.equal(busy.batches, 0);
  let n = 0;
  const one = await runBackfill(db, {
    clock: () => NOW,
    busy: async () => n++ > 0,
    pauseMs: 0,
    batch: 1,
  });
  assert.equal(one.batches, 1);
  const rest = await runBackfill(db, { clock: () => NOW, busy: noBusy, pauseMs: 0, batch: 1 });
  assert.equal(rest.stopped, 'done');
  const state = (
    await db.query<{ backfill: Record<string, unknown> }>('SELECT backfill FROM dashboard_state')
  ).rows[0]!;
  for (const s of BACKFILL_SOURCES) assert.equal(state.backfill[`${s}_done`], true, s);
  const calls = await db.query<{ v: string }>(
    `SELECT sum(value)::text AS v FROM dashboard_daily WHERE metric = 'calls'`,
  );
  assert.equal(calls.rows[0]!.v, '7');
});

test('live: a late settlement inside the window is corrected, base_new follows the total', async (t) => {
  const db = await seededDb(t);
  await seed(db);
  await updateLive(db, NOW);
  await call(db, {
    agent: 'buyer1',
    payTo: hex40(2),
    at: TODAY + 13 * HOUR_MS + 5,
    amount: 50_000,
  });
  await db.query(`UPDATE public_stats SET value = 4 WHERE key = 'base_agents_total'`);
  await updateLive(db, NOW + 60_000);
  const body = await snap(db, '24h', NOW + 60_000, true);
  assert.equal(body.kpis.calls, 6);
  assert.equal(body.kpis.base_new, 3);
});

async function api(
  t: { after: (fn: () => Promise<unknown>) => void },
  arcChainId: number | null = null,
) {
  const db = await seededDb(t);
  await seed(db);
  let now = NOW;
  const app = Fastify();
  registerDashboardRoutes(app, {
    db,
    clock: () => now,
    limit: async () => undefined,
    cronSecret: 'cron-secret-for-tests',
    arcChainId,
    chain: {
      ethOf: async () => 10n ** 16n,
      depositOf: async () => 2n * 10n ** 16n,
    },
  });
  t.after(() => app.close());
  return { app, db, tick: (ms: number) => (now += ms) };
}

test('API: shape, caching headers, CORS, ranges, narrow endpoints and size', async (t) => {
  const { app } = await api(t);
  const before = await app.inject({ url: '/api/public/dashboard?range=7d' });
  assert.equal(before.statusCode, 503);
  assert.equal((await app.inject({ url: DASHBOARD_CRON_PATH })).statusCode, 404);
  const cron = await app.inject({
    url: DASHBOARD_CRON_PATH,
    headers: { authorization: 'Bearer cron-secret-for-tests' },
  });
  assert.equal(cron.statusCode, 200);
  for (const range of ['24h', '7d', '30d', '90d', '12m', 'all']) {
    const res = await app.inject({ url: `/api/public/dashboard?range=${range}` });
    assert.equal(res.statusCode, 200, range);
    assert.match(String(res.headers['cache-control']), /s-maxage=15/);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.ok(res.body.length < 30_000, `${range} ${res.body.length}`);
    const body = res.json() as DashboardBody;
    assert.equal(body.range, range);
    for (const key of ['kpis', 'series', 'hour_of_day', 'fees', 'agents', 'prices', 'top_services'])
      assert.ok(key in body, key);
    assert.equal(body.hour_of_day.length, 24);
  }
  // The 15 s per-server cache: a new snapshot is not seen until it expires.
  const json = await app.inject({ url: '/dashboard.json?range=7d' });
  assert.equal(json.statusCode, 200);
  assert.deepEqual(
    json.json(),
    (await app.inject({ url: '/api/public/dashboard?range=7d' })).json(),
  );
  assert.equal((await app.inject({ url: '/api/public/dashboard?range=1y' })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/public/dashboard?range=7d&x=1' })).statusCode, 400);
  const v = (await app.inject({ url: '/api/public/dashboard/value-settled?range=7d' })).json();
  assert.equal(v.calls, 7);
  const f = (await app.inject({ url: '/api/public/dashboard/protocol-fees?range=7d' })).json();
  assert.equal(f.fees_raw, '320000');
  assert.ok(Array.isArray(f.routes));
  const a = (await app.inject({ url: '/api/public/dashboard/agents?range=7d' })).json();
  assert.equal(a.active, 5);
  const w = await app.inject({ url: '/api/public/dashboard/wallets' });
  assert.equal(w.statusCode, 200);
  assert.equal(w.headers['access-control-allow-origin'], '*');
  const wallets = w.json();
  assert.equal(wallets.wallets.length, 6);
  const pm = wallets.wallets.find((x: { kind: string }) => x.kind === 'paymaster');
  assert.equal(pm.deposit.raw, String(2n * 10n ** 16n));
  assert.equal(wallets.stale, false);
});

test('API: snapshot cache lasts about 15 s per server', async (t) => {
  const { app, db, tick } = await api(t);
  await runDashboardRollup(db, { clock: () => NOW, busy: noBusy });
  const first = (
    await app.inject({ url: '/api/public/dashboard?range=24h' })
  ).json() as DashboardBody;
  await db.query(
    `UPDATE dashboard_snapshots SET body = jsonb_set(body, '{kpis,calls}', '999') WHERE range = '24h'`,
  );
  const cached = (
    await app.inject({ url: '/api/public/dashboard?range=24h' })
  ).json() as DashboardBody;
  assert.equal(cached.kpis.calls, first.kpis.calls);
  tick(15_001);
  const fresh = (
    await app.inject({ url: '/api/public/dashboard?range=24h' })
  ).json() as DashboardBody;
  assert.equal(fresh.kpis.calls, 999);
});

test('wallets: 60 s cache, a failed read keeps the last good values with their time', async () => {
  let now = NOW;
  let fail = false;
  let reads = 0;
  const reader = createWalletsReader({
    clock: () => now,
    chain: {
      ethOf: async () => {
        reads += 1;
        if (fail) throw new Error('rpc down');
        return 2n;
      },
      depositOf: async () => 3n,
    },
  });
  const a = await reader();
  assert.equal(a.stale, false);
  await reader();
  assert.equal(reads, 2); // the two facilitators, once
  now += 60_001;
  fail = true;
  const b = await reader();
  assert.equal(b.stale, true);
  assert.equal(b.as_of, new Date(NOW).toISOString());
  assert.equal(b.wallets.find((w) => w.kind === 'public_facilitator')?.eth?.raw, '2');
});

test('contracts config: the six addresses, from the repo constants', () => {
  assert.equal(DASHBOARD_CONTRACTS.length, 6);
  const by = (k: string) => DASHBOARD_CONTRACTS.find((c) => c.kind === k)?.address;
  assert.equal(by('router1'), PROTOCOL_BASE_MAINNET.feeRouter);
  assert.equal(by('router2')?.toLowerCase(), '0xb1945a2af160e84e34f7c0fb0e4dd94fd4c0af0d');
  assert.equal(by('router3')?.toLowerCase(), '0xe807a76385ec3d76d17ab955091c12329d0a1403');
  assert.equal(by('facilitator'), X402_FACILITATOR_BASE_MAINNET);
  assert.equal(by('public_facilitator'), PUBLIC_X402_SETTLE_ACCOUNT);
  assert.equal(PUBLIC_X402_SETTLE_ACCOUNT, '0x023f489781C18F45730cFD0357ecdc064A68BAC5');
  assert.equal(by('paymaster'), '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105');
});

test('the full app: migration 336 runs and the cron works on the real schema', async (t) => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'cron-secret-for-app-test';
  t.after(() => {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  });
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => NOW });
  t.after(() => app.close());
  const cron = await app.inject({
    url: DASHBOARD_CRON_PATH,
    headers: { authorization: 'Bearer cron-secret-for-app-test' },
  });
  assert.equal(cron.statusCode, 200, cron.body);
  const res = await app.inject({ url: '/api/public/dashboard?range=30d' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as DashboardBody).kpis.calls, 0);
});

test('size: a busy year of rollups stays under 30 KB per range', async (t) => {
  const db = await seededDb(t);
  // 1 M USDC and 1 M calls a day, every day.
  const big = '1000000000000';
  const count = '1000000';
  const metrics = [
    'calls',
    'value',
    'fee:router1',
    'fee:router2',
    'fee:router3',
    'feen:router3',
    'active',
    'base_new',
    'ratings',
    'price:p001',
    'price:p100',
  ];
  for (let i = 0; i < 24; i += 1) metrics.push(`hod:${String(i).padStart(2, '0')}`);
  const days: string[] = [];
  const ms: string[] = [];
  const vs: string[] = [];
  for (let d = 0; d < 800; d += 1)
    for (const m of metrics) {
      days.push(new Date(TODAY - d * DAY_MS).toISOString().slice(0, 10));
      ms.push(m);
      vs.push(m === 'value' || m.startsWith('fee:') ? big : count);
    }
  await db.query(
    'INSERT INTO dashboard_daily SELECT * FROM unnest($1::date[], $2::text[], $3::numeric[])',
    [days, ms, vs],
  );
  for (let i = 0; i < 8; i += 1)
    await db.query(`INSERT INTO dashboard_service_daily VALUES ($1, $2, $3, $4, $5)`, [
      new Date(TODAY).toISOString().slice(0, 10),
      `svc_${i}`,
      'A very long service title '.repeat(10),
      1_000_000 + i,
      big,
    ]);
  for (const range of ['30d', '90d', '12m', 'all'] as const) {
    const body = await snap(db, range, NOW, true);
    const size = JSON.stringify(body).length;
    assert.ok(size < 30_000, `${range}: ${size}`);
  }
});

test('cron: a failing snapshot keeps the others, the backfill still advances, slow ranges wait', async (t) => {
  const db = await seededDb(t);
  await seed(db);
  const tried: string[] = [];
  const build: typeof buildSnapshot = async (tx, range, now, complete) => {
    tried.push(range);
    if (range === '12m') throw new Error('statement timeout');
    return buildSnapshot(tx, range, now, complete);
  };
  const first = await runDashboardRollup(db, { clock: () => NOW, busy: noBusy, build });
  assert.deepEqual(first.failed, ['12m']);
  assert.ok(first.snapshots?.includes('24h') && first.snapshots.includes('all'));
  assert.equal(first.backfill?.stopped, 'done');
  assert.ok((first.backfill?.batches ?? 0) > 0);
  const state = (
    await db.query<{ slow_at: string }>('SELECT slow_at::text AS slow_at FROM dashboard_state')
  ).rows[0]!;
  assert.equal(Number(state.slow_at), NOW);
  // Two minutes later: only the fast ranges run; 12m is not tried again yet.
  tried.length = 0;
  const second = await runDashboardRollup(db, { clock: () => NOW + 120_000, busy: noBusy, build });
  assert.deepEqual(tried, ['24h', '7d', '30d']);
  assert.equal(second.failed, undefined);
  // The other ranges' snapshots exist; 12m has none (its last good one would stay).
  const ranges = (
    await db.query<{ range: string }>('SELECT range FROM dashboard_snapshots ORDER BY range')
  ).rows.map((r) => r.range);
  assert.ok(!ranges.includes('12m'));
  assert.ok(ranges.includes('90d') && ranges.includes('all'));
});

test('value settled is the ledger: proven rows of every rail, no gap and no double at the cut', async (t) => {
  const db = await seededDb(t);
  // Only in the ledger: no paid-call row exists for any of these (another rail).
  const earlier = TODAY - 3 * DAY_MS;
  await fee(db, { at: earlier, fee: 1_000_000, gross: 10_000_000 });
  await fee(db, { at: earlier + HOUR_MS, fee: 2_000, gross: 20_000, emitter: ROUTER3 });
  // Its fee counts, its volume does not until the service is proven (the ledger's own rule).
  await fee(db, { at: earlier + 2 * HOUR_MS, fee: 5_000, gross: 50_000, verified: false });
  // Today: one hour before the live window, and one inside it.
  await fee(db, { at: NOW - 6 * HOUR_MS, fee: 100, gross: 1_000 });
  await fee(db, { at: NOW - HOUR_MS, fee: 200, gross: 2_000 });

  // An earlier live run without the new metric: the window now starts near the current hour.
  await updateLive(db, NOW);
  const state = async () =>
    (
      await db.query<{ backfill: { settled_from: number; settled_done?: boolean } }>(
        'SELECT backfill FROM dashboard_state WHERE id',
      )
    ).rows[0]!.backfill;
  const cut = (await state()).settled_from;
  assert.equal(typeof cut, 'number');
  // Later runs never move the cut, whatever they recompute.
  await updateLive(db, NOW + 60_000);
  assert.equal((await state()).settled_from, cut);

  for (let i = 0; i < 3; i += 1) {
    await runBackfill(db, { clock: () => NOW, busy: noBusy, pauseMs: 0, batch: 1 });
    await updateLive(db, NOW + 120_000);
  }
  assert.equal((await state()).settled_done, true);
  const body = await snap(db, '7d', NOW, true);
  assert.equal(body.kpis.value_settled_raw, String(10_000_000 + 20_000 + 1_000 + 2_000));
  assert.equal(body.kpis.fees_raw, String(1_000_000 + 2_000 + 5_000 + 100 + 200));
  assert.equal(body.kpis.calls, 0, 'calls stay the paid-call tables');
});

test('a database that finished the old backfill still walks the ledger for value', async (t) => {
  const db = await seededDb(t);
  await fee(db, { at: TODAY - DAY_MS, fee: 1_000, gross: 10_000 });
  await db.query(
    `UPDATE dashboard_state SET backfill_done = true, live_from = $1,
       backfill = '{"fees_done":true,"calls_done":true,"sponsored_done":true,"ratings_done":true,"base_done":true}'::jsonb`,
    [TODAY],
  );
  await updateLive(db, NOW);
  const run = await runBackfill(db, { clock: () => NOW, busy: noBusy, pauseMs: 0 });
  assert.equal(run.done, true);
  const body = await snap(db, '7d', NOW, true);
  assert.equal(body.kpis.value_settled_raw, '10000');
});

test('until the settled walk is done, value shows the paid-call value, never a half-walked sum', async (t) => {
  const db = await seededDb(t);
  await call(db, { agent: 'buyer1', payTo: hex40(2), at: TODAY - DAY_MS, amount: 500_000 });
  await fee(db, { at: TODAY - DAY_MS, fee: 50_000, gross: 500_000 });
  await updateLive(db, NOW);
  const before = await snap(db, '7d', NOW, false);
  assert.equal(before.kpis.value_settled_raw, '0', 'no walk has run: the old metric is empty too');
  await db.query(
    `INSERT INTO dashboard_daily VALUES ($1::date, 'value', 900000), ($1::date, 'settled', 7)`,
    [new Date(TODAY - DAY_MS).toISOString().slice(0, 10)],
  );
  assert.equal((await snap(db, '7d', NOW, false)).kpis.value_settled_raw, '900000');
  await db.query(
    `UPDATE dashboard_state SET backfill = backfill || '{"settled_done":true}'::jsonb`,
  );
  assert.equal((await snap(db, '7d', NOW, false)).kpis.value_settled_raw, '7');
});

// ---------------------------------------------------------------------------------------------
// Arc (CITY_ARC=1): All = Base + Arc, Base = All - Arc; off, nothing changes by a byte.

const ARC = 5042;
const GOLDEN = new URL('./fixtures/dashboard-arc-off-golden.json', import.meta.url);

/** Arc rows next to the Base seed: an Arc buyer paying an Arc seller, an Arc fee. */
async function seedArc(db: Database) {
  await db.query('INSERT INTO base_wallets VALUES ($1,$2,$3,$4)', [
    'w_arcb',
    'arcb',
    ARC,
    hex40(71),
  ]);
  await db.query('INSERT INTO base_wallets VALUES ($1,$2,$3,$4)', [
    'w_arcs',
    'arcs',
    ARC,
    hex40(72),
  ]);
  for (let i = 0; i < 2; i += 1)
    await call(db, {
      agent: 'arcb',
      payTo: hex40(72),
      at: TODAY + 14 * HOUR_MS + 10_000 + i,
      amount: 200_000,
      fee: 20_000,
      service: 'svc_arc',
      chain: ARC,
    });
  seq += 1;
  await db.query(
    `INSERT INTO protocol_fee_events VALUES ($1,$2,0,$3,'router',$4,$5,$6,40000,440000,true)`,
    [
      ARC,
      hex64(seq),
      hex40(9999),
      Math.floor((TODAY + 14 * HOUR_MS) / 1000),
      hex40(1000 + seq),
      hex40(2000 + seq),
    ],
  );
}

/** Every public answer of every range after one cron run, as served (bytes). */
async function servedAnswers(t: { after: (fn: () => Promise<unknown>) => void }, arc: boolean) {
  const { app, db } = await api(t, arc ? ARC : null);
  await seedArc(db);
  const cron = await app.inject({
    url: DASHBOARD_CRON_PATH,
    headers: { authorization: 'Bearer cron-secret-for-tests' },
  });
  assert.equal(cron.statusCode, 200);
  const out: Record<string, string> = {};
  for (const range of ['24h', '7d', '30d', '90d', '12m', 'all'])
    for (const path of ['', '/value-settled', '/protocol-fees', '/agents']) {
      const res = await app.inject({ url: `/api/public/dashboard${path}?range=${range}` });
      assert.equal(res.statusCode, 200);
      out[`${path || '/'}?range=${range}`] = res.body;
    }
  return { out, app, db };
}

test('Arc off: every answer is byte-identical to before Arc (golden), Arc rows ignored', async (t) => {
  const { out } = await servedAnswers(t, false);
  const { readFile, writeFile } = await import('node:fs/promises');
  if (process.env.UPDATE_DASHBOARD_GOLDEN === '1')
    await writeFile(GOLDEN, `${JSON.stringify(out, null, 1)}\n`);
  const golden = JSON.parse(await readFile(GOLDEN, 'utf8')) as Record<string, string>;
  assert.deepEqual(Object.keys(out), Object.keys(golden));
  for (const key of Object.keys(golden)) assert.equal(out[key], golden[key], key);
});

test('Arc: env switch, chain parsing', () => {
  assert.equal(dashboardArcChainId({}), null);
  assert.equal(dashboardArcChainId({ CITY_ARC_CHAIN_ID: '5042' }), null);
  assert.equal(dashboardArcChainId({ CITY_ARC: '1' }), 5042);
  assert.equal(dashboardArcChainId({ CITY_ARC: '1', CITY_ARC_CHAIN_ID: '5042002' }), 5042002);
  assert.equal(dashboardArcChainId({ CITY_ARC: '1', CITY_ARC_CHAIN_ID: '8453' }), null);
  assert.equal(parseDashboardChain(undefined), 'all');
  assert.equal(parseDashboardChain('base'), 'base');
  assert.equal(parseDashboardChain('arc'), 'arc');
  for (const bad of ['all', 'ARC', 'arc ', '', ['arc'], 5042, null])
    assert.equal(parseDashboardChain(bad), null);
});

test('fee route: a fee on Arc is router 3 whatever its address; on Base an unknown one stays other', () => {
  const unknown = '0x0000000000000000000000000000000000000a33';
  assert.equal(feeRoute(unknown, 'router', ARC), 'router3');
  assert.equal(feeRoute(unknown, 'router', 5042002), 'router3');
  assert.equal(feeRoute(unknown, 'router', BASE_NETWORKS[8453].chainId), 'other');
  assert.equal(feeRoute(PROTOCOL_BASE_MAINNET.feeRouter, 'router'), 'router1');
  assert.equal(feeRoute(unknown, 'escrow', ARC), 'escrow');
});

test('Arc: merged events count in the plain metrics and once more under arc:, Base = All - Arc', () => {
  const t = TODAY + 3 * HOUR_MS;
  const base = emptyAggregate();
  addPaid(
    base,
    [{ t, buyer: 'b1', payTo: '0xs', serviceId: 'svc_b', title: 'B', price: 100_000n }],
    new Map([['0xs', 's1']]),
  );
  const arc = emptyAggregate();
  addPaid(
    arc,
    [
      { t, buyer: 'a1', payTo: '0xa', serviceId: 'svc_a', title: 'A', price: 50_000n },
      { t, buyer: 'a1', payTo: '0xa', serviceId: 'svc_a', title: 'A', price: 1_000_000n },
    ],
    new Map([['0xa', 'a2']]),
  );
  const agg = mergeArc(base, arc);
  const m = agg.hourly.get(t)!;
  assert.equal(m.get('calls'), 3n);
  assert.equal(m.get(`${ARC_PREFIX}calls`), 2n);
  assert.equal(m.get('value'), 1_150_000n);
  assert.equal(m.get('arc:value'), 1_050_000n);
  assert.equal(m.get('arc:price:p100'), 1n);
  assert.equal(m.get('price:p100'), 1n);
  for (const k of m.keys()) assert.ok(/^[a-z0-9_:]{1,40}$/.test(k), k);
  assert.deepEqual([...agg.arcAgents!].sort(), ['a1', 'a2']);
  assert.equal(agg.active.get(t)!.size, 4);
  const svc = agg.services.get(t)!;
  assert.equal(svc.get('svc_a')?.calls, 2n);
  assert.equal(svc.get('arc:svc_a')?.calls, 2n);
  assert.equal(svc.get('arc:svc_b'), undefined);
  const rows = new Map([[t, m]]);
  const b = metricsView(rows, 'base').get(t)!;
  const a = metricsView(rows, 'arc').get(t)!;
  assert.equal(b.get('calls'), 1n);
  assert.equal(b.get('value'), 100_000n);
  assert.equal(b.get('price:p100'), 0n);
  assert.equal(a.get('calls'), 2n);
  assert.ok(![...b.keys(), ...a.keys()].some((k) => k.startsWith(ARC_PREFIX)));
  for (const [k, v] of m)
    if (!k.startsWith(ARC_PREFIX)) assert.equal((b.get(k) ?? 0n) + (a.get(k) ?? 0n), v, k);
  assert.equal(metricsView(rows, 'all'), rows);
});

test('Arc off: the rollup runs no read with the Arc chain', async (t) => {
  const db = await seededDb(t);
  await seed(db);
  await seedArc(db);
  const params: unknown[] = [];
  const spy = Object.create(db) as Database;
  const wrap = <T extends (...a: never[]) => unknown>(fn: T) => fn;
  spy.query = wrap(async (sql: string, p?: unknown[]) => {
    params.push(...(p ?? []));
    return db.query(sql, p);
  }) as Database['query'];
  spy.transaction = (fn) =>
    db.transaction((tx) => {
      const inner = Object.create(tx) as typeof tx;
      inner.query = (async (sql: string, p?: unknown[]) => {
        params.push(...(p ?? []));
        return tx.query(sql, p);
      }) as typeof tx.query;
      return fn(inner);
    });
  await runDashboardRollup(spy, { clock: () => NOW, busy: noBusy });
  assert.ok(params.length > 0);
  assert.ok(!params.includes(ARC), 'no query with the Arc chain id');
});

test('Arc on: All = Base + Arc, the Base view is the answer of before, Arc its own', async (t) => {
  const golden = JSON.parse(
    await (await import('node:fs/promises')).readFile(GOLDEN, 'utf8'),
  ) as Record<string, string>;
  const { app } = await servedAnswers(t, true);
  const get = async (url: string) => {
    const res = await app.inject({ url });
    assert.equal(res.statusCode, 200, url);
    return res.json() as Record<string, unknown> & DashboardBody;
  };
  for (const range of ['24h', '7d', '30d', '90d', '12m', 'all'])
    for (const path of ['', '/value-settled', '/protocol-fees', '/agents']) {
      const key = `${path || '/'}?range=${range}`;
      const base = await get(`/api/public/dashboard${path}?range=${range}&chain=base`);
      const { chains, ...rest } = base;
      if (!path) assert.deepEqual(chains, ['base', 'arc']);
      assert.deepEqual(rest, JSON.parse(golden[key]!), `base view = before: ${key}`);
    }
  const all = await get('/api/public/dashboard?range=24h');
  const arc = await get('/api/public/dashboard?range=24h&chain=arc');
  const base = await get('/api/public/dashboard?range=24h&chain=base');
  assert.ok(!('views' in all));
  assert.deepEqual(all.chains, ['base', 'arc']);
  assert.equal(arc.kpis.calls, 2);
  assert.equal(all.kpis.calls, base.kpis.calls + 2);
  assert.equal(arc.kpis.value_settled_raw, '440000');
  assert.equal(BigInt(all.kpis.value_settled_raw), BigInt(base.kpis.value_settled_raw) + 440_000n);
  assert.equal(arc.kpis.fees_raw, '40000');
  assert.equal(arc.kpis.active, 2);
  assert.equal(all.kpis.active, base.kpis.active + 2);
  assert.deepEqual(arc.agents, { buyers_only: 1, sellers_only: 1, both: 0, other: 0 });
  assert.equal(arc.kpis.base_new, 0);
  assert.equal(arc.hour_of_day[14], 2);
  assert.equal(
    arc.series.reduce((n, p) => n + p.active, 0),
    2,
  );
  assert.deepEqual(
    arc.top_services.map((s) => [s.title, s.calls]),
    [['Service svc_arc', 2]],
  );
  assert.ok(all.top_services.some((s) => s.title === 'Service svc_arc'));
  assert.ok(!base.top_services.some((s) => s.title === 'Service svc_arc'));
  for (let i = 0; i < all.series.length; i += 1)
    assert.equal(all.series[i]!.calls, base.series[i]!.calls + arc.series[i]!.calls);
  const fees = await get('/api/public/dashboard/protocol-fees?range=24h&chain=arc');
  assert.equal(fees.fees_raw, '40000');
  // A second run (same hours set again) changes nothing.
  await app.inject({
    url: DASHBOARD_CRON_PATH,
    headers: { authorization: 'Bearer cron-secret-for-tests' },
  });
  assert.equal((await get('/api/public/dashboard?range=7d&chain=arc')).kpis.calls, 2);
});

test('API: ?chain is strict; Arc off, base is the stored answer and arc a 400', async (t) => {
  const { app } = await servedAnswers(t, false);
  for (const bad of ['all', 'ARC', 'base,arc', '', 'arc&chain=arc'])
    assert.equal(
      (await app.inject({ url: `/api/public/dashboard?range=7d&chain=${bad}` })).statusCode,
      400,
      bad,
    );
  const off = await app.inject({ url: '/api/public/dashboard?range=7d&chain=arc' });
  assert.equal(off.statusCode, 400);
  assert.deepEqual(off.json(), { error: 'invalid_chain', chains: ['base'] });
  assert.equal(
    (await app.inject({ url: '/api/public/dashboard?range=7d&chain=base' })).body,
    (await app.inject({ url: '/api/public/dashboard?range=7d' })).body,
  );
});

test('Arc: new agents on Arc count in the Arc view and in All, never in Base', async (t) => {
  const db = await seededDb(t);
  await seed(db);
  await db.query(`INSERT INTO public_stats VALUES ('arc_agents_total', 10, 1, 0)`);
  await updateLive(db, NOW, undefined, ARC);
  await db.query(`UPDATE public_stats SET value = 4 WHERE key = 'base_agents_total'`);
  await db.query(`UPDATE public_stats SET value = 13 WHERE key = 'arc_agents_total'`);
  await updateLive(db, NOW + 60_000, undefined, ARC);
  // Sampled, never recomputed: a later run over the same hour keeps them and adds nothing.
  await updateLive(db, NOW + 120_000, undefined, ARC);
  const body = (await db.transaction((tx) =>
    buildSnapshot(tx, '24h', NOW + 120_000, true, ARC),
  )) as any;
  assert.equal(body.views.arc.kpis.base_new, 3);
  assert.equal(body.views.base.kpis.base_new, 3);
  assert.equal(body.kpis.base_new, 6);
});

test('Arc on before its snapshot is rebuilt: chain=arc is not ready yet, never invalid', async (t) => {
  const { app, db } = await api(t);
  const cron = await app.inject({
    url: DASHBOARD_CRON_PATH,
    headers: { authorization: 'Bearer cron-secret-for-tests' },
  });
  assert.equal(cron.statusCode, 200);
  const url = '/api/public/dashboard?range=24h&chain=arc';
  const off = await app.inject({ url });
  assert.equal(off.statusCode, 400);
  assert.equal(off.json().error, 'invalid_chain');
  const on = Fastify();
  t.after(() => on.close());
  registerDashboardRoutes(on, {
    db,
    clock: () => NOW,
    limit: async () => undefined,
    arcChainId: ARC,
    chain: null,
  });
  const early = await on.inject({ url });
  assert.equal(early.statusCode, 503, early.body);
  assert.equal(early.json().error, 'not_ready');
});
