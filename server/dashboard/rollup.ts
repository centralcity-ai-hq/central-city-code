/*
 * The Agent Dashboard rollups (migration 336, ./schema.ts): one data set for everything on Central
 * City on Base. Every agent, paid call, payment and fee counts the same way; nothing here filters,
 * splits or labels traffic by who runs an agent.
 *
 * Sources (the same ones the public stats and the explorer read):
 * - paid calls and value settled: feed_pay_calls on Base mainnet with payment_state 'settled' and a
 *   transaction (the paid_call_count rule, migration 125), price amount_raw + fee_raw, time
 *   settled_at; plus the paid sponsored first purchases, feed_pay_sponsored_calls state 'paid',
 *   'delivered' or 'paid_no_result' with a transaction (migration 252's rule), price gross_raw,
 *   time updated_at (the explorer's calls view reads them the same way); and the paid public calls,
 *   feed_pay_public_calls under the same rule (migration 356), whose buyer is no agent;
 * - protocol fees: the fee ledger protocol_fee_events on Base mainnet with the ledger's own
 *   counting rule (dailyFees: not the treasury's own payments, no router self-payment), time
 *   block_time, split by emitter (router 1, 2, 3) or escrow;
 * - new Base agents: the change of the base_agents_total public_stats row (the explorer's "On Base
 *   now" total and /api/public/stats base_agents), sampled by every run; history before the first
 *   sample from the listed Base identities' mint_seen_at;
 * - ratings: base_wallet_withdrawals kind 'rate' on Base mainnet in state 'final', time created_at;
 * - active agents: the buyer agent of a paid call, the seller agent (the Central City wallet that
 *   is the call's pay_to), and the rater of a rating
 *   (a registration is "new Base agents", never activity).
 *
 * Load (production: more than 1 M agents and 1 M paid calls on a pool of 25):
 * - the cron (every 2 minutes) holds a lease row, so one run at a time; it re-reads only the last
 *   LIVE_RECOMPUTE_HOURS hours of each source through their time indexes (feed_pay_calls_paid,
 *   the sponsored updated_at index, protocol_fee_events_time, the base ID index), sets those hours
 *   again (idempotent: a late settlement or a reorg inside them is corrected) and moves the days by
 *   the difference;
 * - every statement runs with a statement and lock timeout; nothing locks a source table;
 * - the backfill reads each source in primary-key order, BACKFILL_BATCH keys at a time, and
 *   applies each batch and its cursor in one transaction (resumable, never counted twice); it
 *   stops for this run when the database looks busy or a statement times out;
 * - the public route reads one dashboard_snapshots row per range; snapshots of the long ranges
 *   (90d, 12m, all) are rebuilt at most every SLOW_EVERY_MS.
 */
import type { Database, Transaction } from '../database.js';
import { transientDatabaseError } from '../database.js';
import { FROM, LISTED } from '../base/explorer/store.js';
import { BASE_MAINNET, BASE_NETWORKS } from '../../shared/base/chains.js';
import { ARC_MAINNET, arcNetwork, chainFamily } from '../../shared/chains.js';
import { AGENT_URI_ORIGIN } from '../../shared/base/on-base.js';
import { protocolDeployment } from '../../shared/protocol.js';
import { stepPaymasterOperations } from './paymaster-ops.js';
import {
  DASHBOARD_RANGES,
  DAY_MS,
  FEE_ROUTES,
  HOUR_MS,
  PRICE_BUCKETS,
  RANGE_DAYS,
  priceBucket,
  rangeStart,
  rangeStep,
  type DashboardBody,
  type DashboardKpis,
  type DashboardPoint,
  type DashboardRange,
  type FeeRouteKey,
  DASHBOARD_CHAINS,
  type DashboardChain,
} from '../../shared/dashboard.js';

export const DASHBOARD_CHAIN_ID = BASE_MAINNET;
/** The public_stats row of the Base agents total (server/stats/base-agents.ts BASE_AGENTS_KEY). */
const BASE_AGENTS_ROW = 'base_agents_total';
/** The public_stats row of the Arc agents total (server/stats/base-agents.ts ARC_AGENTS_KEY). */
const ARC_AGENTS_ROW = 'arc_agents_total';
/** New agents on Arc, sampled like base_new and never recomputed. */
const ARC_BASE_NEW = 'arc:base_new';

/** Hourly rows (and hourly active / service rows) are kept this long. */
export const HOURLY_KEEP_MS = 8 * DAY_MS;
/** Each run sets this many hours again (the current one and the ones before it). */
export const LIVE_RECOMPUTE_HOURS = 3;
/** A run that finds the last one longer ago catches up at most this far back. */
export const LIVE_CATCH_UP_MS = 2 * DAY_MS;
export const BACKFILL_BATCH = 1000;
/** A run spends at most this long on the backfill. */
export const BACKFILL_BUDGET_MS = 20_000;
/** Pause between backfill batches. */
export const BACKFILL_PAUSE_MS = 200;
/** More active statements than this on the database: the backfill waits for a later run. */
export const BUSY_ACTIVE_STATEMENTS = 10;
/** The long ranges' snapshots are rebuilt at most this often. */
export const SLOW_EVERY_MS = 10 * 60_000;
export const LEASE_MS = 90_000;
const STATEMENT_TIMEOUT = '10s';
const LOCK_TIMEOUT = '2s';
const WRITE_CHUNK = 5000;
const FAST_RANGES: readonly DashboardRange[] = ['24h', '7d', '30d'];
const SLOW_RANGES: readonly DashboardRange[] = ['90d', '12m', 'all'];

// ---------------------------------------------------------------------------------------------
// Events and their aggregation (pure; shared by the live update and the backfill)

export const ROLE_BUY = 1;
export const ROLE_SELL = 2;
/** Rated another agent. Registrations (mints) are not activity: they are "new Base agents". */
export const ROLE_RATER = 4;

export interface PaidEvent {
  t: number;
  buyer: string | null;
  payTo: string;
  serviceId: string;
  title: string;
  price: bigint;
}
export interface FeeEvent {
  t: number;
  route: FeeRouteKey;
  fee: bigint;
  /** A live row whose service is proven: its gross, the value it settled (the ledger's volume). */
  settled?: bigint;
}
export interface ActivityEvent {
  t: number;
  agent: string;
  role: number;
}
export interface CountEvent {
  t: number;
  metric: 'ratings' | 'base_new' | 'arc:base_new' | 'settled';
  n: bigint;
}

export interface Aggregate {
  /** hour -> metric -> value */
  hourly: Map<number, Map<string, bigint>>;
  /** hour -> service id -> calls and value */
  services: Map<number, Map<string, { title: string; calls: bigint; value: bigint }>>;
  /** hour -> agent -> roles */
  active: Map<number, Map<string, number>>;
  /** Agents seen in the Arc read (mergeArc): their new active rows also count as arc:active. */
  arcAgents?: Set<string>;
}

/**
 * Arc (CITY_ARC=1): its events count in the plain metrics (All = Base + Arc) and once more under
 * this prefix, so Base = plain - arc:. Services get an extra `arc:<id>` row the same way.
 */
export const ARC_PREFIX = 'arc:';

/** The Arc chain the rollup reads too, or null (Arc off: no extra query runs). */
export function dashboardArcChainId(env: {
  CITY_ARC?: string;
  CITY_ARC_CHAIN_ID?: string;
}): number | null {
  const id = Number(env.CITY_ARC_CHAIN_ID?.trim() || ARC_MAINNET);
  return arcNetwork(id, env) ? id : null;
}

/** Adds an Arc aggregate into `agg`: plain (All) and arc:-prefixed. */
export function mergeArc(agg: Aggregate, arc: Aggregate): Aggregate {
  for (const [hour, m] of arc.hourly) {
    const into = metricsAt(agg, hour);
    for (const [k, v] of m) {
      bump(into, k, v);
      bump(into, `${ARC_PREFIX}${k}`, v);
    }
  }
  for (const [hour, svc] of arc.services) {
    let into = agg.services.get(hour);
    if (!into) agg.services.set(hour, (into = new Map()));
    for (const [id, row] of svc)
      for (const key of [id, `${ARC_PREFIX}${id}`]) {
        const cur = into.get(key) ?? { title: row.title, calls: 0n, value: 0n };
        cur.calls += row.calls;
        cur.value += row.value;
        if (row.title) cur.title = row.title;
        into.set(key, cur);
      }
  }
  agg.arcAgents ??= new Set();
  for (const [hour, agents] of arc.active)
    for (const [agent, roles] of agents) {
      addActivity(agg, { t: hour, agent, role: roles });
      agg.arcAgents.add(agent);
    }
  return agg;
}

export const hourOf = (t: number) => Math.floor(t / HOUR_MS) * HOUR_MS;
export const dayText = (t: number) =>
  new Date(Math.floor(t / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

function bump(map: Map<string, bigint>, key: string, n: bigint) {
  map.set(key, (map.get(key) ?? 0n) + n);
}

export function emptyAggregate(): Aggregate {
  return { hourly: new Map(), services: new Map(), active: new Map() };
}

function metricsAt(agg: Aggregate, hour: number) {
  let m = agg.hourly.get(hour);
  if (!m) agg.hourly.set(hour, (m = new Map()));
  return m;
}

export function addActivity(agg: Aggregate, event: ActivityEvent) {
  if (!event.agent) return;
  const hour = hourOf(event.t);
  let m = agg.active.get(hour);
  if (!m) agg.active.set(hour, (m = new Map()));
  m.set(event.agent, (m.get(event.agent) ?? 0) | event.role);
}

/** Adds paid calls; `sellers` maps a lowercase pay_to to its Central City agent. */
export function addPaid(
  agg: Aggregate,
  events: readonly PaidEvent[],
  sellers: Map<string, string>,
) {
  for (const e of events) {
    const hour = hourOf(e.t);
    const m = metricsAt(agg, hour);
    bump(m, 'calls', 1n);
    bump(m, 'value', e.price);
    bump(m, `price:${priceBucket(e.price)}`, 1n);
    let s = agg.services.get(hour);
    if (!s) agg.services.set(hour, (s = new Map()));
    const row = s.get(e.serviceId) ?? { title: e.title, calls: 0n, value: 0n };
    row.calls += 1n;
    row.value += e.price;
    if (e.title) row.title = e.title;
    s.set(e.serviceId, row);
    if (e.buyer) addActivity(agg, { t: e.t, agent: e.buyer, role: ROLE_BUY });
    const seller = sellers.get(e.payTo.toLowerCase());
    if (seller) addActivity(agg, { t: e.t, agent: seller, role: ROLE_SELL });
  }
}

export function addFees(agg: Aggregate, events: readonly FeeEvent[]) {
  for (const e of events) {
    const m = metricsAt(agg, hourOf(e.t));
    bump(m, `fee:${e.route}`, e.fee);
    bump(m, `feen:${e.route}`, 1n);
    if (e.settled) bump(m, 'settled', e.settled);
  }
}

export function addCounts(agg: Aggregate, events: readonly CountEvent[]) {
  for (const e of events) bump(metricsAt(agg, hourOf(e.t)), e.metric, e.n);
}

/** The fee source of a ledger row: its emitter against the deployed routers, or escrow. */
export function feeRoute(
  emitter: string,
  source: string,
  chainId = DASHBOARD_CHAIN_ID,
): FeeRouteKey {
  if (source === 'escrow') return 'escrow';
  const d = protocolDeployment(chainId);
  const e = emitter.toLowerCase();
  if (d?.feeRouter.toLowerCase() === e) return 'router1';
  if (d?.feeRouter2.toLowerCase() === e) return 'router2';
  if (d?.feeRouter3.toLowerCase() === e) return 'router3';
  // Arc has router 3 only, and its address may come from a setting rather than a deployment.
  if (chainFamily(chainId) === 'arc') return 'router3';
  return 'other';
}

// ---------------------------------------------------------------------------------------------
// Source reads

type Q = Pick<Transaction, 'query'>;

export interface SourceTables {
  calls: boolean;
  sponsored: boolean;
  public: boolean;
  services: boolean;
  fees: boolean;
  ratings: boolean;
  identities: boolean;
  stats: boolean;
}

export async function sourceTables(db: Q): Promise<SourceTables> {
  const { rows } = await db.query<Record<keyof SourceTables, boolean>>(
    `SELECT to_regclass('feed_pay_calls') IS NOT NULL AS calls,
            to_regclass('feed_pay_sponsored_calls') IS NOT NULL AS sponsored,
            to_regclass('feed_pay_public_calls') IS NOT NULL AS public,
            to_regclass('feed_services') IS NOT NULL AS services,
            to_regclass('protocol_fee_events') IS NOT NULL AS fees,
            (to_regclass('base_wallet_withdrawals') IS NOT NULL AND to_regclass('base_wallets') IS NOT NULL) AS ratings,
            (to_regclass('base_identities') IS NOT NULL AND to_regclass('base_short_ids') IS NOT NULL) AS identities,
            to_regclass('public_stats') IS NOT NULL AS stats`,
  );
  const r = rows[0]!;
  return {
    calls: !!r.calls,
    sponsored: !!r.sponsored,
    public: !!r.public,
    services: !!r.services,
    fees: !!r.fees,
    ratings: !!r.ratings,
    identities: !!r.identities,
    stats: !!r.stats,
  };
}

const SETTLED = `c.chain_id = $1 AND c.payment_state = 'settled' AND c.tx_hash IS NOT NULL`;
const CALL_COLUMNS = `c.settled_at AS t, c.agent_id AS buyer, lower(c.pay_to) AS pay_to,
  c.service_id, c.service_title AS title, (c.amount_raw + COALESCE(c.fee_raw, 0))::text AS price`;
const SPONSORED_PAID = `s.state IN ('paid','delivered','paid_no_result') AND s.tx_hash IS NOT NULL`;
const sponsoredColumns = (titles: boolean) => `s.updated_at AS t, s.agent_id AS buyer,
  lower(s.pay_to) AS pay_to, s.service_id,
  ${titles ? `COALESCE((SELECT v.title FROM feed_services v WHERE v.id = s.service_id), '')` : `''::text`} AS title,
  s.gross_raw::text AS price`;
/** A public call's buyer is outside Central City, so no agent: only its seller counts as active. */
const publicColumns = (titles: boolean) => `s.updated_at AS t, NULL::text AS buyer,
  s.pay_to AS pay_to, s.service_id,
  ${titles ? `COALESCE((SELECT v.title FROM feed_services v WHERE v.id = s.service_id), '')` : `''::text`} AS title,
  s.gross_raw::text AS price`;
const COUNTED_FEES = `($2::text IS NULL OR f.payer <> $2::text) AND NOT (f.source = 'router' AND f.payer = f.payee)`;
const RATED = `r.kind = 'rate' AND r.chain_id = $1 AND r.state = 'final'`;

interface PaidRow {
  t: string | number | null;
  buyer: string | null;
  pay_to: string;
  service_id: string;
  title: string | null;
  price: string;
}
const paidOf = (rows: PaidRow[]): PaidEvent[] =>
  rows
    .filter((r) => r.t !== null)
    .map((r) => ({
      t: Number(r.t),
      buyer: r.buyer,
      payTo: r.pay_to,
      serviceId: r.service_id,
      title: r.title ?? '',
      price: BigInt(r.price),
    }));

const treasuryOf = (chainId: number) => protocolDeployment(chainId)?.treasury.toLowerCase() ?? null;

/** Central City agents behind these (lowercase) pay_to addresses: one indexed lookup. */
export async function sellerAgents(db: Q, payTos: Iterable<string>, chainId = DASHBOARD_CHAIN_ID) {
  const list = [...new Set([...payTos].map((a) => a.toLowerCase()))];
  const map = new Map<string, string>();
  if (!list.length) return map;
  const { rows } = await db.query<{ address: string; agent_id: string }>(
    `SELECT lower(address) AS address, agent_id FROM base_wallets
      WHERE lower(address) = ANY($1::text[]) AND chain_id = $2`,
    [list, chainId],
  );
  for (const r of rows) map.set(r.address, r.agent_id);
  return map;
}

/** Everything of every source in [from, to) (epoch ms) into one aggregate (the live window). */
export async function readWindow(
  db: Q,
  tables: SourceTables,
  from: number,
  to: number,
  chainId = DASHBOARD_CHAIN_ID,
): Promise<Aggregate> {
  const agg = emptyAggregate();
  const paid: PaidEvent[] = [];
  if (tables.calls) {
    // The feed_pay_calls_paid predicate with a settled_at bound (the explorer's own read).
    const { rows } = await db.query<PaidRow>(
      `SELECT ${CALL_COLUMNS} FROM feed_pay_calls c
        WHERE ${SETTLED} AND c.settled_at >= $2 AND c.settled_at < $3`,
      [chainId, from, to],
    );
    paid.push(...paidOf(rows));
  }
  if (tables.sponsored && chainId === DASHBOARD_CHAIN_ID) {
    const { rows } = await db.query<PaidRow>(
      `SELECT ${sponsoredColumns(tables.services)} FROM feed_pay_sponsored_calls s
        WHERE ${SPONSORED_PAID} AND s.updated_at >= $1 AND s.updated_at < $2`,
      [from, to],
    );
    paid.push(...paidOf(rows));
  }
  if (tables.public && chainId === DASHBOARD_CHAIN_ID) {
    const { rows } = await db.query<PaidRow>(
      `SELECT ${publicColumns(tables.services)} FROM feed_pay_public_calls s
        WHERE ${SPONSORED_PAID} AND s.updated_at >= $1 AND s.updated_at < $2`,
      [from, to],
    );
    paid.push(...paidOf(rows));
  }
  if (tables.ratings) {
    const sellers = await sellerAgents(
      db,
      paid.map((p) => p.payTo),
      chainId,
    );
    addPaid(agg, paid, sellers);
    const { rows } = await db.query<{ t: string; agent_id: string }>(
      `SELECT r.created_at AS t, w.agent_id FROM base_wallet_withdrawals r
         JOIN base_wallets w ON w.wallet_id = r.wallet_id
        WHERE ${RATED} AND r.created_at >= $2 AND r.created_at < $3`,
      [chainId, from, to],
    );
    for (const r of rows) {
      addCounts(agg, [{ t: Number(r.t), metric: 'ratings', n: 1n }]);
      addActivity(agg, { t: Number(r.t), agent: r.agent_id, role: ROLE_RATER });
    }
  } else addPaid(agg, paid, new Map());
  if (tables.fees) {
    const { rows } = await db.query<{
      t: string;
      emitter: string;
      source: string;
      fee: string;
      gross: string;
      service_verified: boolean;
    }>(
      `SELECT f.block_time AS t, f.emitter, f.source, f.fee::text AS fee, f.gross::text AS gross,
              f.service_verified FROM protocol_fee_events f
        WHERE f.chain_id = $1 AND ${COUNTED_FEES} AND f.block_time >= $3 AND f.block_time < $4`,
      [chainId, treasuryOf(chainId), Math.floor(from / 1000), Math.ceil(to / 1000)],
    );
    addFees(
      agg,
      rows.map((r) => ({
        t: Number(r.t) * 1000,
        route: feeRoute(r.emitter, r.source, chainId),
        fee: BigInt(r.fee),
        ...(r.service_verified ? { settled: BigInt(r.gross) } : {}),
      })),
    );
  }
  return agg;
}

const IDENTITY_PARAMS = (chainId: number) => [
  chainId,
  BASE_NETWORKS[chainId as keyof typeof BASE_NETWORKS]?.contracts.identityRegistry ?? '',
  AGENT_URI_ORIGIN,
];

// ---------------------------------------------------------------------------------------------
// Writes

const chunks = <T>(items: T[]) => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += WRITE_CHUNK) out.push(items.slice(i, i + WRITE_CHUNK));
  return out;
};

/** Metrics a live run sets again for each recomputed hour (base_new and active are added). */
const isRecomputed = (metric: string) =>
  metric !== 'base_new' &&
  metric !== ARC_BASE_NEW &&
  metric !== 'active' &&
  metric !== `${ARC_PREFIX}active`;

async function addDaily(tx: Q, deltas: Map<string, Map<string, bigint>>) {
  const rows: [string, string, string][] = [];
  for (const [day, m] of deltas)
    for (const [metric, v] of m) if (v !== 0n) rows.push([day, metric, v.toString()]);
  for (const part of chunks(rows))
    await tx.query(
      `INSERT INTO dashboard_daily AS t (day, metric, value)
         SELECT * FROM unnest($1::date[], $2::text[], $3::numeric[])
       ON CONFLICT (day, metric) DO UPDATE SET value = t.value + EXCLUDED.value`,
      [part.map((r) => r[0]), part.map((r) => r[1]), part.map((r) => r[2])],
    );
}

async function addHourly(tx: Q, rows: [number, string, bigint][]) {
  // One row per (hour, metric): an upsert may not touch a row twice.
  const merged = new Map<string, [number, string, bigint]>();
  for (const [hour, metric, v] of rows) {
    const key = `${hour}|${metric}`;
    const m = merged.get(key);
    if (m) m[2] += v;
    else merged.set(key, [hour, metric, v]);
  }
  const kept = [...merged.values()].filter((r) => r[2] !== 0n);
  for (const part of chunks(kept))
    await tx.query(
      `INSERT INTO dashboard_hourly AS t (hour, metric, value)
         SELECT * FROM unnest($1::bigint[], $2::text[], $3::numeric[])
       ON CONFLICT (hour, metric) DO UPDATE SET value = t.value + EXCLUDED.value`,
      [part.map((r) => r[0]), part.map((r) => r[1]), part.map((r) => r[2].toString())],
    );
}

function dayDelta(
  deltas: Map<string, Map<string, bigint>>,
  hour: number,
  metric: string,
  v: bigint,
) {
  if (v === 0n) return;
  const day = dayText(hour);
  let m = deltas.get(day);
  if (!m) deltas.set(day, (m = new Map()));
  bump(m, metric, v);
  // Calls by hour of day, per day (the agent clock of the day ranges).
  if (metric === 'calls' || metric === `${ARC_PREFIX}calls`)
    bump(
      m,
      `${metric === 'calls' ? '' : ARC_PREFIX}hod:${String(new Date(hour).getUTCHours()).padStart(2, '0')}`,
      v,
    );
}

/**
 * Applies an aggregate. `setHours` (the live window): those hours' recomputed metrics and services
 * are replaced by the aggregate's, and the days move by the difference. Every other hour (the
 * backfill) is added. Hourly rows are only written for hours at or after `keepFrom`. Active rows
 * are a union either way: an agent counts once per hour and day.
 */
export async function applyAggregate(
  tx: Q,
  agg: Aggregate,
  options: { setHours?: readonly number[]; keepFrom: number },
): Promise<void> {
  const deltas = new Map<string, Map<string, bigint>>();
  const setHours = new Set(options.setHours ?? []);
  const hourlyAdds: [number, string, bigint][] = [];
  if (setHours.size) {
    const hours = [...setHours];
    const old = await tx.query<{ hour: string; metric: string; value: string }>(
      `SELECT hour, metric, value::text AS value FROM dashboard_hourly
        WHERE hour = ANY($1::bigint[]) AND metric NOT IN ('base_new','arc:base_new','active','arc:active') FOR UPDATE`,
      [hours],
    );
    for (const r of old.rows) {
      const hour = Number(r.hour);
      const now = agg.hourly.get(hour)?.get(r.metric) ?? 0n;
      dayDelta(deltas, hour, r.metric, now - BigInt(r.value));
    }
    const seen = new Set(old.rows.map((r) => `${Number(r.hour)}|${r.metric}`));
    for (const hour of hours)
      for (const [metric, v] of agg.hourly.get(hour) ?? [])
        if (isRecomputed(metric) && !seen.has(`${hour}|${metric}`))
          dayDelta(deltas, hour, metric, v);
    await tx.query(
      `DELETE FROM dashboard_hourly WHERE hour = ANY($1::bigint[]) AND metric NOT IN ('base_new','arc:base_new','active','arc:active')`,
      [hours],
    );
    for (const hour of hours)
      for (const [metric, v] of agg.hourly.get(hour) ?? [])
        if (isRecomputed(metric) && hour >= options.keepFrom) hourlyAdds.push([hour, metric, v]);
    // Services of those hours: replaced; their days move by the difference.
    const oldSvc = await tx.query<{
      hour: string;
      service_id: string;
      calls: string;
      value_raw: string;
    }>(
      `DELETE FROM dashboard_service_hourly WHERE hour = ANY($1::bigint[])
       RETURNING hour, service_id, calls::text AS calls, value_raw::text AS value_raw`,
      [hours],
    );
    const svcDays = new Map<
      string,
      { day: string; id: string; title: string; calls: bigint; value: bigint }
    >();
    const svcDelta = (hour: number, id: string, title: string, calls: bigint, value: bigint) => {
      const day = dayText(hour);
      const key = `${day}|${id}`;
      const row = svcDays.get(key) ?? { day, id, title, calls: 0n, value: 0n };
      row.calls += calls;
      row.value += value;
      if (title) row.title = title;
      svcDays.set(key, row);
    };
    for (const r of oldSvc.rows)
      svcDelta(Number(r.hour), r.service_id, '', -BigInt(r.calls), -BigInt(r.value_raw));
    for (const hour of hours)
      for (const [id, s] of agg.services.get(hour) ?? [])
        svcDelta(hour, id, s.title, s.calls, s.value);
    await writeServices(
      tx,
      agg,
      hours.filter((h) => h >= options.keepFrom),
    );
    await addServiceDays(tx, [...svcDays.values()]);
  }
  // Every hour not being set: added.
  const addedHours = [...agg.hourly.keys()].filter((h) => !setHours.has(h));
  for (const hour of addedHours)
    for (const [metric, v] of agg.hourly.get(hour)!) {
      dayDelta(deltas, hour, metric, v);
      if (hour >= options.keepFrom) hourlyAdds.push([hour, metric, v]);
    }
  // base_new of a set hour is added too (it is a sampled change, never recomputed).
  for (const hour of setHours)
    for (const [metric, v] of agg.hourly.get(hour) ?? [])
      if (!isRecomputed(metric)) {
        dayDelta(deltas, hour, metric, v);
        if (hour >= options.keepFrom) hourlyAdds.push([hour, metric, v]);
      }
  const addedSvcHours = [...agg.services.keys()].filter((h) => !setHours.has(h));
  if (addedSvcHours.length) {
    const rows: { day: string; id: string; title: string; calls: bigint; value: bigint }[] = [];
    for (const hour of addedSvcHours)
      for (const [id, s] of agg.services.get(hour)!) rows.push({ day: dayText(hour), id, ...s });
    await addServiceDays(tx, rows);
    await addServiceHours(
      tx,
      addedSvcHours.filter((h) => h >= options.keepFrom),
      agg,
    );
  }
  await addHourly(tx, hourlyAdds);
  // Active agents: union rows; new rows count +1 for their hour and day.
  const activeHours: [number, string, number][] = [];
  const activeDays = new Map<string, number>();
  const last = new Map<string, { any: number; buy: number; sell: number }>();
  for (const [hour, agents] of agg.active)
    for (const [agent, roles] of agents) {
      if (hour >= options.keepFrom) activeHours.push([hour, agent, roles]);
      const key = `${dayText(hour)}|${agent}`;
      activeDays.set(key, (activeDays.get(key) ?? 0) | roles);
      const l = last.get(agent) ?? { any: 0, buy: 0, sell: 0 };
      l.any = Math.max(l.any, hour);
      if (roles & ROLE_BUY) l.buy = Math.max(l.buy, hour);
      if (roles & ROLE_SELL) l.sell = Math.max(l.sell, hour);
      last.set(agent, l);
    }
  const arcAgents = agg.arcAgents;
  const newPerHour: [number, string, bigint][] = [];
  for (const part of chunks(activeHours)) {
    const { rows } = await tx.query<{ hour: string; agent_id?: string; inserted: boolean }>(
      `INSERT INTO dashboard_active_hourly AS t (hour, agent_id, roles)
         SELECT * FROM unnest($1::bigint[], $2::text[], $3::smallint[])
       ON CONFLICT (hour, agent_id) DO UPDATE SET roles = t.roles | EXCLUDED.roles
         WHERE (t.roles | EXCLUDED.roles) <> t.roles
       RETURNING hour, ${arcAgents?.size ? 'agent_id, ' : ''}(xmax = 0) AS inserted`,
      [part.map((r) => r[0]), part.map((r) => r[1]), part.map((r) => r[2])],
    );
    for (const r of rows)
      if (r.inserted) {
        newPerHour.push([Number(r.hour), 'active', 1n]);
        if (r.agent_id !== undefined && arcAgents?.has(r.agent_id))
          newPerHour.push([Number(r.hour), `${ARC_PREFIX}active`, 1n]);
      }
  }
  await addHourly(tx, newPerHour);
  const dayRows = [...activeDays].map(([key, roles]) => {
    const [day, agent] = [key.slice(0, 10), key.slice(11)];
    return [day, agent, roles] as const;
  });
  const newPerDay = new Map<string, Map<string, bigint>>();
  for (const part of chunks(dayRows)) {
    const { rows } = await tx.query<{ day: string; agent_id?: string; inserted: boolean }>(
      `INSERT INTO dashboard_active_daily AS t (day, agent_id, roles)
         SELECT * FROM unnest($1::date[], $2::text[], $3::smallint[])
       ON CONFLICT (day, agent_id) DO UPDATE SET roles = t.roles | EXCLUDED.roles
         WHERE (t.roles | EXCLUDED.roles) <> t.roles
       RETURNING day::text AS day, ${arcAgents?.size ? 'agent_id, ' : ''}(xmax = 0) AS inserted`,
      [part.map((r) => r[0]), part.map((r) => r[1]), part.map((r) => r[2])],
    );
    for (const r of rows)
      if (r.inserted) {
        let m = newPerDay.get(r.day);
        if (!m) newPerDay.set(r.day, (m = new Map()));
        bump(m, 'active', 1n);
        if (r.agent_id !== undefined && arcAgents?.has(r.agent_id))
          bump(m, `${ARC_PREFIX}active`, 1n);
      }
  }
  for (const [day, m] of newPerDay) {
    let d = deltas.get(day);
    if (!d) deltas.set(day, (d = new Map()));
    for (const [metric, v] of m) bump(d, metric, v);
  }
  const lastRows = [...last];
  for (const part of chunks(lastRows))
    await tx.query(
      `INSERT INTO dashboard_agent_last AS t (agent_id, last_any, last_buy, last_sell)
         SELECT * FROM unnest($1::text[], $2::bigint[], $3::bigint[], $4::bigint[])
       ON CONFLICT (agent_id) DO UPDATE SET
         last_any = GREATEST(t.last_any, EXCLUDED.last_any),
         last_buy = GREATEST(t.last_buy, EXCLUDED.last_buy),
         last_sell = GREATEST(t.last_sell, EXCLUDED.last_sell)
       WHERE EXCLUDED.last_any > t.last_any OR EXCLUDED.last_buy > t.last_buy
          OR EXCLUDED.last_sell > t.last_sell`,
      [
        part.map((r) => r[0]),
        part.map((r) => r[1].any),
        part.map((r) => r[1].buy),
        part.map((r) => r[1].sell),
      ],
    );
  await addDaily(tx, deltas);
}

async function writeServices(tx: Q, agg: Aggregate, hours: number[]) {
  await addServiceHours(tx, hours, agg);
}

async function addServiceHours(tx: Q, hours: number[], agg: Aggregate) {
  const rows: [number, string, string, string, string][] = [];
  for (const hour of hours)
    for (const [id, s] of agg.services.get(hour) ?? [])
      rows.push([hour, id, s.title, s.calls.toString(), s.value.toString()]);
  for (const part of chunks(rows))
    await tx.query(
      `INSERT INTO dashboard_service_hourly AS t (hour, service_id, title, calls, value_raw)
         SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::bigint[], $5::numeric[])
       ON CONFLICT (hour, service_id) DO UPDATE SET calls = t.calls + EXCLUDED.calls,
         value_raw = t.value_raw + EXCLUDED.value_raw,
         title = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE t.title END`,
      [
        part.map((r) => r[0]),
        part.map((r) => r[1]),
        part.map((r) => r[2]),
        part.map((r) => r[3]),
        part.map((r) => r[4]),
      ],
    );
}

async function addServiceDays(
  tx: Q,
  rows: { day: string; id: string; title: string; calls: bigint; value: bigint }[],
) {
  const merged = new Map<
    string,
    { day: string; id: string; title: string; calls: bigint; value: bigint }
  >();
  for (const r of rows) {
    const key = `${r.day}|${r.id}`;
    const m = merged.get(key) ?? { ...r, calls: 0n, value: 0n };
    m.calls += r.calls;
    m.value += r.value;
    if (r.title) m.title = r.title;
    merged.set(key, m);
  }
  const list = [...merged.values()].filter((r) => r.calls !== 0n || r.value !== 0n);
  for (const part of chunks(list))
    await tx.query(
      `INSERT INTO dashboard_service_daily AS t (day, service_id, title, calls, value_raw)
         SELECT * FROM unnest($1::date[], $2::text[], $3::text[], $4::bigint[], $5::numeric[])
       ON CONFLICT (day, service_id) DO UPDATE SET calls = t.calls + EXCLUDED.calls,
         value_raw = t.value_raw + EXCLUDED.value_raw,
         title = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE t.title END`,
      [
        part.map((r) => r.day),
        part.map((r) => r.id),
        part.map((r) => r.title),
        part.map((r) => r.calls.toString()),
        part.map((r) => r.value.toString()),
      ],
    );
}

// ---------------------------------------------------------------------------------------------
// State and lease

interface StateRow {
  live_from: string | null;
  live_through: string | null;
  base_seen: string | null;
  base_from: string | null;
  max_base_id: string | null;
  backfill: Record<string, unknown> | string;
  backfill_done: boolean;
  slow_at: string;
}

const DB_NOW = `(extract(epoch from clock_timestamp()) * 1000)::bigint`;

async function claimLease(db: Q): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE dashboard_state SET lease_until = ${DB_NOW} + $1::bigint
      WHERE id AND lease_until <= ${DB_NOW} RETURNING id`,
    [LEASE_MS],
  );
  return rows.length === 1;
}

async function releaseLease(db: Q) {
  await db.query('UPDATE dashboard_state SET lease_until = 0 WHERE id');
}

async function readState(db: Q): Promise<StateRow> {
  const { rows } = await db.query<StateRow>(
    `SELECT live_from, live_through, base_seen, base_from, max_base_id::text AS max_base_id,
            backfill, backfill_done, slow_at FROM dashboard_state WHERE id`,
  );
  return rows[0]!;
}

const cursorsOf = (state: StateRow): Record<string, unknown> =>
  typeof state.backfill === 'string'
    ? (JSON.parse(state.backfill) as Record<string, unknown>)
    : state.backfill;

async function limits(tx: Q) {
  await tx.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
  await tx.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
}

// ---------------------------------------------------------------------------------------------
// The live update

export interface LiveResult {
  from: number;
  to: number;
  hours: number;
}

/**
 * Sets the last LIVE_RECOMPUTE_HOURS hours again (from the live start on the very first run: the
 * start of that UTC day), samples the Base agents total and prunes old hourly rows.
 */
export async function updateLive(
  db: Database,
  now: number,
  tables?: SourceTables,
  arcChainId: number | null = null,
): Promise<LiveResult> {
  const t = tables ?? (await sourceTables(db));
  return db.transaction(async (tx) => {
    await limits(tx);
    const state = await readState(tx);
    const liveFrom =
      state.live_from === null ? Math.floor(now / DAY_MS) * DAY_MS : Number(state.live_from);
    const current = hourOf(now);
    const lastRun = state.live_through === null ? liveFrom : Number(state.live_through);
    const from = Math.max(
      liveFrom,
      Math.min(current - (LIVE_RECOMPUTE_HOURS - 1) * HOUR_MS, hourOf(lastRun) - HOUR_MS),
      current - LIVE_CATCH_UP_MS,
    );
    const to = current + HOUR_MS;
    const agg = await readWindow(tx, t, from, to);
    // Arc: the same reads for the same window, only when Arc is on (live only, no backfill).
    if (arcChainId !== null) mergeArc(agg, await readWindow(tx, t, from, to, arcChainId));
    const hours: number[] = [];
    for (let h = from; h < to; h += HOUR_MS) hours.push(h);
    // New Base agents: the change of the shared total since the last sample.
    let baseSeen = state.base_seen === null ? null : BigInt(state.base_seen);
    let baseFrom = state.base_from === null ? null : Number(state.base_from);
    if (t.stats) {
      const row = (
        await tx.query<{ value: string }>(
          'SELECT value::text AS value FROM public_stats WHERE key = $1 AND refreshed_at > 0',
          [BASE_AGENTS_ROW],
        )
      ).rows[0];
      if (row) {
        const total = BigInt(row.value);
        if (baseSeen !== null && total !== baseSeen)
          addCounts(agg, [{ t: now, metric: 'base_new', n: total - baseSeen }]);
        baseSeen = total;
        baseFrom ??= now;
      }
    }
    // New Arc agents the same way, in All and in Arc (Base = All - Arc). The first sample only sets
    // the mark: agents from before it are in arc_agents, not in this series.
    let arcSeen: string | null = null;
    if (t.stats && arcChainId !== null) {
      const row = (
        await tx.query<{ value: string }>(
          'SELECT value::text AS value FROM public_stats WHERE key = $1 AND refreshed_at > 0',
          [ARC_AGENTS_ROW],
        )
      ).rows[0];
      if (row) {
        const seen = cursorsOf(state).arc_seen;
        const total = BigInt(row.value);
        if (typeof seen === 'string' && total !== BigInt(seen))
          addCounts(agg, [
            { t: now, metric: 'base_new', n: total - BigInt(seen) },
            { t: now, metric: ARC_BASE_NEW, n: total - BigInt(seen) },
          ]);
        arcSeen = row.value;
      }
    }
    const keepFrom = current - HOURLY_KEEP_MS;
    await applyAggregate(tx, agg, { setHours: hours, keepFrom });
    await tx.query('DELETE FROM dashboard_hourly WHERE hour < $1', [keepFrom]);
    await tx.query('DELETE FROM dashboard_active_hourly WHERE hour < $1', [keepFrom]);
    await tx.query('DELETE FROM dashboard_service_hourly WHERE hour < $1', [keepFrom]);
    await tx.query(
      `UPDATE dashboard_state SET live_from = $1, live_through = $2, base_seen = $3, base_from = $4,
         updated_at = $2 WHERE id`,
      [liveFrom, now, baseSeen?.toString() ?? null, baseFrom],
    );
    // The first run that counts value from the ledger: from this hour on live owns it, and the
    // settled walk counts everything before (same transaction, so nothing twice or missing).
    if (typeof cursorsOf(state).settled_from !== 'number')
      await tx.query(
        `UPDATE dashboard_state SET backfill = jsonb_set(backfill, '{settled_from}', $1::jsonb) WHERE id`,
        [JSON.stringify(from)],
      );
    if (arcSeen !== null)
      await tx.query(
        `UPDATE dashboard_state SET backfill = jsonb_set(backfill, '{arc_seen}', $1::jsonb) WHERE id`,
        [JSON.stringify(arcSeen)],
      );
    return { from, to, hours: hours.length };
  });
}

// ---------------------------------------------------------------------------------------------
// The backfill: history before the live start, source by source in primary-key order

// Money first: the two ledger walks are one table without joins, so they take bigger batches.
export const BACKFILL_SOURCES = [
  'fees',
  'settled',
  'calls',
  'sponsored',
  'public',
  'ratings',
  'base',
] as const;
export type BackfillSource = (typeof BACKFILL_SOURCES)[number];
const LEDGER_BATCH_FACTOR = 5;

interface Batch {
  agg: Aggregate;
  cursor: unknown;
  done: boolean;
}

async function backfillBatch(
  tx: Q,
  source: BackfillSource,
  cursor: unknown,
  cut: { liveFrom: number; baseFrom: number; settledFrom: number },
  tables: SourceTables,
  limit: number,
  chainId = DASHBOARD_CHAIN_ID,
): Promise<Batch> {
  const agg = emptyAggregate();
  if (source === 'calls' || source === 'sponsored' || source === 'public') {
    // Public calls read as sponsored ones do, from their own table (no buyer agent).
    const sponsored = source !== 'calls';
    const open = source === 'public' ? tables.public : sponsored ? tables.sponsored : tables.calls;
    if (!open) return { agg, cursor, done: true };
    const name =
      source === 'public'
        ? 'feed_pay_public_calls'
        : sponsored
          ? 'feed_pay_sponsored_calls'
          : 'feed_pay_calls';
    const table = `${name} ${sponsored ? 's' : 'c'}`;
    const alias = sponsored ? 's' : 'c';
    const columns =
      source === 'public'
        ? publicColumns(tables.services)
        : sponsored
          ? sponsoredColumns(tables.services)
          : CALL_COLUMNS;
    const after = typeof cursor === 'string' ? cursor : '';
    const { rows } = await tx.query<PaidRow & { k: string; ok: boolean }>(
      `WITH page AS (SELECT call_id FROM ${name}
                      WHERE call_id > $2 ORDER BY call_id LIMIT $3)
       SELECT p.call_id AS k, ${columns},
              (${sponsored ? `${SPONSORED_PAID} AND s.updated_at < $4 AND $1::int = $1::int` : `${SETTLED} AND c.settled_at < $4`}) AS ok
         FROM page p JOIN ${table} ON ${alias}.call_id = p.call_id ORDER BY p.call_id`,
      [chainId, after, limit, cut.liveFrom],
    );
    const ok = rows.filter((r) => r.ok);
    const paid = paidOf(ok);
    const sellers = tables.ratings
      ? await sellerAgents(
          tx,
          paid.map((p) => p.payTo),
          chainId,
        )
      : new Map();
    addPaid(agg, paid, sellers);
    return { agg, cursor: rows.at(-1)?.k ?? after, done: rows.length < limit };
  }
  if (source === 'fees') {
    if (!tables.fees) return { agg, cursor, done: true };
    const [tx0, log0] = Array.isArray(cursor) ? (cursor as [string, number]) : ['', -1];
    const { rows } = await tx.query<{
      tx_hash: string;
      log_index: number;
      t: string;
      emitter: string;
      source: string;
      fee: string;
      ok: boolean;
    }>(
      `SELECT f.tx_hash, f.log_index, f.block_time AS t, f.emitter, f.source, f.fee::text AS fee,
              (${COUNTED_FEES} AND f.block_time * 1000 < $5) AS ok
         FROM protocol_fee_events f
        WHERE f.chain_id = $1 AND (f.tx_hash, f.log_index) > ($3::text, $4::int)
        ORDER BY f.tx_hash, f.log_index LIMIT $6`,
      [chainId, treasuryOf(chainId), tx0, log0, cut.liveFrom, limit],
    );
    addFees(
      agg,
      rows
        .filter((r) => r.ok)
        .map((r) => ({
          t: Number(r.t) * 1000,
          route: feeRoute(r.emitter, r.source, chainId),
          fee: BigInt(r.fee),
        })),
    );
    const last = rows.at(-1);
    return {
      agg,
      cursor: last ? [last.tx_hash, Number(last.log_index)] : cursor,
      done: rows.length < limit,
    };
  }
  if (source === 'settled') {
    // Value settled, by the ledger's own volume rule (every router and rail, proven services),
    // before the hour the live run first counted it (settled_from).
    if (!tables.fees) return { agg, cursor, done: true };
    const [tx0, log0] = Array.isArray(cursor) ? (cursor as [string, number]) : ['', -1];
    const { rows } = await tx.query<{
      tx_hash: string;
      log_index: number;
      t: string;
      gross: string;
      ok: boolean;
    }>(
      `SELECT f.tx_hash, f.log_index, f.block_time AS t, f.gross::text AS gross,
              (${COUNTED_FEES} AND f.service_verified AND f.block_time * 1000 < $5) AS ok
         FROM protocol_fee_events f
        WHERE f.chain_id = $1 AND (f.tx_hash, f.log_index) > ($3::text, $4::int)
        ORDER BY f.tx_hash, f.log_index LIMIT $6`,
      [chainId, treasuryOf(chainId), tx0, log0, cut.settledFrom, limit],
    );
    addCounts(
      agg,
      rows
        .filter((r) => r.ok)
        .map((r) => ({ t: Number(r.t) * 1000, metric: 'settled', n: BigInt(r.gross) })),
    );
    const last = rows.at(-1);
    return {
      agg,
      cursor: last ? [last.tx_hash, Number(last.log_index)] : cursor,
      done: rows.length < limit,
    };
  }
  if (source === 'ratings') {
    if (!tables.ratings) return { agg, cursor, done: true };
    const after = typeof cursor === 'string' ? cursor : '';
    const { rows } = await tx.query<{ k: string; t: string; agent_id: string; ok: boolean }>(
      `WITH page AS (SELECT withdrawal_id FROM base_wallet_withdrawals
                      WHERE withdrawal_id > $2 ORDER BY withdrawal_id LIMIT $3)
       SELECT p.withdrawal_id AS k, r.created_at AS t, w.agent_id,
              (${RATED} AND r.created_at < $4) AS ok
         FROM page p JOIN base_wallet_withdrawals r ON r.withdrawal_id = p.withdrawal_id
         JOIN base_wallets w ON w.wallet_id = r.wallet_id ORDER BY p.withdrawal_id`,
      [chainId, after, limit, cut.liveFrom],
    );
    for (const r of rows.filter((x) => x.ok)) {
      addCounts(agg, [{ t: Number(r.t), metric: 'ratings', n: 1n }]);
      addActivity(agg, { t: Number(r.t), agent: r.agent_id, role: ROLE_RATER });
    }
    return { agg, cursor: rows.at(-1)?.k ?? after, done: rows.length < limit };
  }
  // base: listed Base identities, counted as new at mint_seen_at before the first sample.
  if (!tables.identities) return { agg, cursor, done: true };
  const [a0, c0] = Array.isArray(cursor) ? (cursor as [string, number]) : ['', -1];
  const page = await tx.query<{ agent_id: string; chain_id: number }>(
    `SELECT agent_id, chain_id FROM base_identities WHERE (agent_id, chain_id) > ($1::text, $2::int)
      ORDER BY agent_id, chain_id LIMIT $3`,
    [a0, c0, limit],
  );
  const ids = page.rows.filter((r) => Number(r.chain_id) === chainId).map((r) => r.agent_id);
  if (ids.length) {
    const { rows } = await tx.query<{ agent_id: string; t: string | null }>(
      `SELECT i.agent_id, i.mint_seen_at AS t ${FROM} WHERE ${LISTED} AND i.agent_id = ANY($4::text[])`,
      [...IDENTITY_PARAMS(chainId), ids],
    );
    for (const r of rows) {
      if (r.t === null) continue;
      const t = Number(r.t);
      // Counted as new only; a mint is not activity (no active or agent_last row).
      if (t < cut.baseFrom) addCounts(agg, [{ t, metric: 'base_new', n: 1n }]);
    }
  }
  const last = page.rows.at(-1);
  return {
    agg,
    cursor: last ? [last.agent_id, Number(last.chain_id)] : cursor,
    done: page.rows.length < limit,
  };
}

export async function databaseBusy(db: Q): Promise<boolean> {
  try {
    const { rows } = await db.query<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE state = 'active' AND pid <> pg_backend_pid()`,
    );
    return Number(rows[0]?.n ?? 0) > BUSY_ACTIVE_STATEMENTS;
  } catch {
    return false;
  }
}

export interface BackfillResult {
  batches: number;
  done: boolean;
  stopped: 'done' | 'budget' | 'busy' | 'not_live' | 'error';
}

/** Runs backfill batches until done, the time budget is spent, or the database looks busy. */
export async function runBackfill(
  db: Database,
  deps: {
    clock: () => number;
    budgetMs?: number;
    batch?: number;
    pauseMs?: number;
    busy?: (db: Q) => Promise<boolean>;
    tables?: SourceTables;
  },
): Promise<BackfillResult> {
  const started = deps.clock();
  const budget = deps.budgetMs ?? BACKFILL_BUDGET_MS;
  const busy = deps.busy ?? databaseBusy;
  const tables = deps.tables ?? (await sourceTables(db));
  let batches = 0;
  for (;;) {
    const state = await readState(db);
    const cursors = cursorsOf(state);
    // A database that finished before the settled walk existed still runs that walk.
    if (state.backfill_done && cursors.settled_done === true)
      return { batches, done: true, stopped: 'done' };
    if (state.live_from === null || typeof cursors.settled_from !== 'number')
      return { batches, done: false, stopped: 'not_live' };
    if (deps.clock() - started >= budget) return { batches, done: false, stopped: 'budget' };
    if (await busy(db)) return { batches, done: false, stopped: 'busy' };
    const source = BACKFILL_SOURCES.find((s) => !(cursors[`${s}_done`] === true));
    try {
      await db.transaction(async (tx) => {
        await limits(tx);
        const now = deps.clock();
        if (!source) {
          await tx.query('UPDATE dashboard_state SET backfill_done = true WHERE id');
          return;
        }
        const cut = {
          liveFrom: Number(state.live_from),
          baseFrom: state.base_from === null ? Number(state.live_from) : Number(state.base_from),
          settledFrom: cursors.settled_from as number,
        };
        const batch = await backfillBatch(
          tx,
          source,
          cursors[source],
          cut,
          tables,
          (deps.batch ?? BACKFILL_BATCH) *
            (source === 'fees' || source === 'settled' ? LEDGER_BATCH_FACTOR : 1),
        );
        await applyAggregate(tx, batch.agg, { keepFrom: hourOf(now) - HOURLY_KEEP_MS });
        const next = { ...cursors, [source]: batch.cursor, [`${source}_done`]: batch.done };
        // The cursor moves in the same transaction as the batch: a crash repeats nothing.
        await tx.query('UPDATE dashboard_state SET backfill = $1::jsonb WHERE id', [
          JSON.stringify(next),
        ]);
      });
    } catch (error) {
      if (transientDatabaseError(error)) return { batches, done: false, stopped: 'busy' };
      throw error;
    }
    batches += 1;
    if (deps.pauseMs ?? BACKFILL_PAUSE_MS)
      await new Promise((r) => setTimeout(r, deps.pauseMs ?? BACKFILL_PAUSE_MS));
  }
}

// ---------------------------------------------------------------------------------------------
// Snapshots: the public answer per range

type MetricRows = Map<number, Map<string, bigint>>;

async function loadHourly(db: Q, from: number): Promise<MetricRows> {
  const { rows } = await db.query<{ hour: string; metric: string; value: string }>(
    'SELECT hour, metric, value::text AS value FROM dashboard_hourly WHERE hour >= $1',
    [from],
  );
  const out: MetricRows = new Map();
  for (const r of rows) {
    const h = Number(r.hour);
    let m = out.get(h);
    if (!m) out.set(h, (m = new Map()));
    m.set(r.metric, BigInt(r.value));
  }
  return out;
}

async function loadDaily(db: Q, from: number): Promise<MetricRows> {
  const { rows } = await db.query<{ day: string; metric: string; value: string }>(
    `SELECT day::text AS day, metric, value::text AS value FROM dashboard_daily WHERE day >= $1::date`,
    [dayText(from)],
  );
  const out: MetricRows = new Map();
  for (const r of rows) {
    const d = dayMs(r.day);
    let m = out.get(d);
    if (!m) out.set(d, (m = new Map()));
    m.set(r.metric, BigInt(r.value));
  }
  return out;
}

const sumOf = (rows: MetricRows, from: number, to: number, pick: (metric: string) => boolean) => {
  let total = 0n;
  for (const [t, m] of rows)
    if (t >= from && t < to) for (const [k, v] of m) if (pick(k)) total += v;
  return total;
};
const isFee = (k: string) => k.startsWith('fee:');

interface Bucket {
  from: number;
  to: number;
}

/** The points of a window: hours, days, 7-day weeks from the start, or calendar months. */
export function bucketsOf(range: DashboardRange, from: number, to: number): Bucket[] {
  const step = rangeStep(range, to - from);
  const out: Bucket[] = [];
  if (step === 'month') {
    const d = new Date(from);
    let cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    while (cur < to) {
      const n = new Date(cur);
      const next = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1);
      out.push({ from: cur, to: next });
      cur = next;
    }
    return out;
  }
  const size = step === 'hour' ? HOUR_MS : step === 'day' ? DAY_MS : 7 * DAY_MS;
  for (let cur = from; cur < to; cur += size) out.push({ from: cur, to: Math.min(cur + size, to) });
  return out;
}

function pointsOf(
  rows: MetricRows,
  buckets: Bucket[],
  averageActive: boolean,
  hourly: boolean,
): DashboardPoint[] {
  return buckets.map((b) => {
    const pick = (k: string) => sumOf(rows, b.from, b.to, (m) => m === k);
    let active = Number(pick('active'));
    if (averageActive) {
      const days = Math.max(1, Math.round((b.to - b.from) / DAY_MS));
      active = Math.round(active / days);
    }
    return {
      // Day points as the date only (the answer stays small); hours as the full time.
      t: hourly ? new Date(b.from).toISOString() : dayText(b.from),
      calls: Number(pick('calls')),
      value_settled_raw: pick('settled').toString(),
      fees_raw: sumOf(rows, b.from, b.to, isFee).toString(),
      base_new: Number(pick('base_new')),
      active,
    };
  });
}

interface RoleCounts {
  active: number;
  buyers_only: number;
  sellers_only: number;
  both: number;
  other: number;
}

/**
 * Distinct agents active since `from` and their sides: one range read of dashboard_agent_last
 * through its last_any index (all time: one pass over the table). The table holds one narrow row
 * per agent that ever bought, sold or rated, so about 1 M rows is a single scan of a few seconds
 * at most, well under the 10 s limit, run at most every SLOW_EVERY_MS for the long ranges.
 */
async function rolesSince(db: Q, from: number, arcChainId?: number): Promise<RoleCounts> {
  const { rows } = await db.query<Record<keyof RoleCounts, string>>(
    `SELECT count(*)::text AS active,
            count(*) FILTER (WHERE last_buy >= $1 AND last_sell < $1)::text AS buyers_only,
            count(*) FILTER (WHERE last_sell >= $1 AND last_buy < $1)::text AS sellers_only,
            count(*) FILTER (WHERE last_buy >= $1 AND last_sell >= $1)::text AS both,
            count(*) FILTER (WHERE last_buy < $1 AND last_sell < $1)::text AS other
       FROM ${arcChainId === undefined ? 'dashboard_agent_last' : ARC_AGENT_LAST} WHERE last_any >= $1`,
    arcChainId === undefined ? [from] : [from, arcChainId],
  );
  const r = rows[0]!;
  return {
    active: Number(r.active),
    buyers_only: Number(r.buyers_only),
    sellers_only: Number(r.sellers_only),
    both: Number(r.both),
    other: Number(r.other),
  };
}

/**
 * Distinct agents active in [from, to): hours for 24h windows, else days. A GROUP BY in a subquery
 * (a hash aggregate over the primary key's range, index-only) instead of count(DISTINCT), which
 * sorts; buyers, sellers and raters only, so the tables hold one row per trading agent and day.
 */
export const DISTINCT_ACTIVE_HOURLY_SQL = `SELECT count(*)::text AS n FROM (
  SELECT agent_id FROM dashboard_active_hourly WHERE hour >= $1 AND hour < $2 GROUP BY agent_id) a`;
export const DISTINCT_ACTIVE_DAILY_SQL = `SELECT count(*)::text AS n FROM (
  SELECT agent_id FROM dashboard_active_daily WHERE day >= $1::date AND day < $2::date
   GROUP BY agent_id) a`;
/** The previous window's distinct count may take this long; past it the last value is kept. */
const PREVIOUS_ACTIVE_TIMEOUT = '5s';

/**
 * Arc agents are the agents whose wallet is on the Arc chain ($2): read from the Arc wallets (the
 * base_wallets (chain_id, address) index), each joined by primary key. Base = all - Arc.
 */
const ARC_AGENT_LAST = `(SELECT l.* FROM base_wallets w JOIN dashboard_agent_last l ON l.agent_id = w.agent_id
  WHERE w.chain_id = $2) l`;
const DISTINCT_ARC_ACTIVE_HOURLY_SQL = `SELECT count(*)::text AS n FROM (
  SELECT a.agent_id FROM base_wallets w JOIN dashboard_active_hourly a ON a.agent_id = w.agent_id
   WHERE w.chain_id = $3 AND a.hour >= $1 AND a.hour < $2 GROUP BY a.agent_id) a`;
const DISTINCT_ARC_ACTIVE_DAILY_SQL = `SELECT count(*)::text AS n FROM (
  SELECT a.agent_id FROM base_wallets w JOIN dashboard_active_daily a ON a.agent_id = w.agent_id
   WHERE w.chain_id = $3 AND a.day >= $1::date AND a.day < $2::date GROUP BY a.agent_id) a`;

async function distinctActive(
  db: Q,
  from: number,
  to: number,
  hourly: boolean,
  arcChainId?: number,
): Promise<number> {
  const arc = arcChainId === undefined ? [] : [arcChainId];
  const { rows } = hourly
    ? await db.query<{ n: string }>(
        arc.length ? DISTINCT_ARC_ACTIVE_HOURLY_SQL : DISTINCT_ACTIVE_HOURLY_SQL,
        [from, to, ...arc],
      )
    : await db.query<{ n: string }>(
        arc.length ? DISTINCT_ARC_ACTIVE_DAILY_SQL : DISTINCT_ACTIVE_DAILY_SQL,
        [dayText(from), dayText(to), ...arc],
      );
  return Number(rows[0]?.n ?? 0);
}

/** The previous window's active count of the stored snapshot (the last good one), or 0. */
async function storedPreviousActive(
  db: Q,
  range: DashboardRange,
  view: DashboardView = 'all',
): Promise<number> {
  const { rows } = await db.query<{ n: string | null }>(
    view === 'all'
      ? `SELECT body->'previous'->>'active' AS n FROM dashboard_snapshots WHERE range = $1`
      : `SELECT body->'views'->$2::text->'previous'->>'active' AS n FROM dashboard_snapshots WHERE range = $1`,
    view === 'all' ? [range] : [range, view],
  );
  return Number(rows[0]?.n ?? 0);
}

type DashboardView = 'all' | DashboardChain;

/**
 * Top services of a view. Arc off: the query of before. Arc on: All leaves the `arc:` copies out,
 * Arc reads only them, Base is each service's All minus its Arc copy.
 */
async function topServices(db: Q, from: number, hourly: boolean, view?: DashboardView) {
  if (view !== undefined) {
    const table = hourly ? 'dashboard_service_hourly' : 'dashboard_service_daily';
    const since = hourly ? 'hour >= $1' : 'day >= $1::date';
    const arc = `service_id LIKE 'arc:%'`;
    const sql =
      view === 'base'
        ? `SELECT max(title) FILTER (WHERE NOT ${arc}) AS title,
                  sum(CASE WHEN ${arc} THEN -calls ELSE calls END)::text AS calls,
                  sum(CASE WHEN ${arc} THEN -value_raw ELSE value_raw END)::text AS value_raw
             FROM ${table} WHERE ${since}
            GROUP BY regexp_replace(service_id, '^arc:', '')
           HAVING sum(CASE WHEN ${arc} THEN -calls ELSE calls END) > 0
            ORDER BY sum(CASE WHEN ${arc} THEN -calls ELSE calls END) DESC, regexp_replace(service_id, '^arc:', '') LIMIT 5`
        : `SELECT max(title) AS title, sum(calls)::text AS calls, sum(value_raw)::text AS value_raw
             FROM ${table} WHERE ${since} AND ${view === 'arc' ? '' : 'NOT '}${arc}
            GROUP BY service_id HAVING sum(calls) > 0 ORDER BY sum(calls) DESC, service_id LIMIT 5`;
    const { rows } = await db.query<{ title: string; calls: string; value_raw: string }>(sql, [
      hourly ? from : dayText(from),
    ]);
    return servicesOf(rows);
  }
  const { rows } = hourly
    ? await db.query<{ title: string; calls: string; value_raw: string }>(
        `SELECT max(title) AS title, sum(calls)::text AS calls, sum(value_raw)::text AS value_raw
           FROM dashboard_service_hourly WHERE hour >= $1
          GROUP BY service_id ORDER BY sum(calls) DESC, service_id LIMIT 5`,
        [from],
      )
    : await db.query<{ title: string; calls: string; value_raw: string }>(
        `SELECT max(title) AS title, sum(calls)::text AS calls, sum(value_raw)::text AS value_raw
           FROM dashboard_service_daily WHERE day >= $1::date
          GROUP BY service_id HAVING sum(calls) > 0 ORDER BY sum(calls) DESC, service_id LIMIT 5`,
        [dayText(from)],
      );
  return servicesOf(rows);
}

const servicesOf = (rows: { title: string | null; calls: string; value_raw: string }[]) =>
  rows
    .filter((r) => Number(r.calls) > 0)
    .map((r) => ({
      title: (r.title || 'Untitled service').slice(0, 80),
      calls: Number(r.calls),
      value_settled_raw: r.value_raw,
    }));

/**
 * One view of the stored metrics: All as stored (the arc: rows are never picked by name), Arc the
 * arc: rows without their prefix, Base each plain metric minus its arc: one.
 */
export function metricsView(rows: MetricRows, view: DashboardView): MetricRows {
  if (view === 'all') return rows;
  const out: MetricRows = new Map();
  for (const [t, m] of rows) {
    const v = new Map<string, bigint>();
    for (const [k, value] of m) {
      if (view === 'arc') {
        if (k.startsWith(ARC_PREFIX)) v.set(k.slice(ARC_PREFIX.length), value);
      } else if (!k.startsWith(ARC_PREFIX)) {
        v.set(k, value - (m.get(`${ARC_PREFIX}${k}`) ?? 0n));
      }
    }
    out.set(t, v);
  }
  return out;
}

function kpisOf(rows: MetricRows, from: number, to: number, active: number): DashboardKpis {
  const one = (k: string) => sumOf(rows, from, to, (m) => m === k);
  return {
    value_settled_raw: one('settled').toString(),
    fees_raw: sumOf(rows, from, to, isFee).toString(),
    active,
    base_new: Number(one('base_new')),
    calls: Number(one('calls')),
  };
}

/** Builds one range's answer from the rollup tables only (never a source table). */
export async function buildSnapshot(
  db: Q,
  range: DashboardRange,
  now: number,
  historyComplete: boolean,
  arcChainId: number | null = null,
): Promise<DashboardBody> {
  const hourly = range === '24h';
  let from = rangeStart(range, now);
  const end = hourly ? hourOf(now) + HOUR_MS : Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  if (range === 'all') {
    const first = (
      await db.query<{ day: string | null }>('SELECT min(day)::text AS day FROM dashboard_daily')
    ).rows[0]?.day;
    // At least two days, so the chart always has a line.
    from = Math.min(first ? dayMs(first) : end, end - 2 * DAY_MS);
  }
  const span = end - from;
  const prevFrom = range === 'all' ? null : from - span;
  const rows = hourly
    ? await loadHourly(db, prevFrom ?? from)
    : await loadDaily(db, prevFrom ?? from);
  // Until the settled walk has finished, the paid-call value stands in: close to the ledger, where
  // the half-walked ledger value would read as almost nothing.
  const walk = (
    await db.query<{ done: boolean | null }>(
      `SELECT (backfill->>'settled_done')::boolean AS done FROM dashboard_state WHERE id`,
    )
  ).rows[0];
  if (walk?.done !== true)
    for (const metrics of rows.values()) {
      metrics.set('settled', metrics.get('value') ?? 0n);
      if (arcChainId !== null)
        metrics.set(`${ARC_PREFIX}settled`, metrics.get(`${ARC_PREFIX}value`) ?? 0n);
    }
  const ctx = { range, now, historyComplete, hourly, from, end, prevFrom };
  if (arcChainId === null) return assemble(db, ctx, rows);
  // Arc on: All, Arc and Base (= All - Arc) from the same rows, stored together (one row per range).
  const all = await assemble(db, ctx, rows, 'all', arcChainId);
  const arc = await assemble(db, ctx, rows, 'arc', arcChainId);
  const base = await assemble(db, ctx, rows, 'base', arcChainId, { all, arc });
  const chains = [...DASHBOARD_CHAINS];
  return {
    ...all,
    chains,
    views: { base: { ...base, chains }, arc: { ...arc, chains } },
  } as DashboardBody;
}

interface SnapshotContext {
  range: DashboardRange;
  now: number;
  historyComplete: boolean;
  hourly: boolean;
  from: number;
  end: number;
  prevFrom: number | null;
}

/** One view's answer. Arc off: exactly the answer of before (view undefined). */
async function assemble(
  db: Q,
  ctx: SnapshotContext,
  stored: MetricRows,
  view?: DashboardView,
  arcChainId?: number,
  /** For Base: the All and Arc answers, so its agent counts are All - Arc (no anti-join). */
  parts?: { all: DashboardBody; arc: DashboardBody },
): Promise<DashboardBody> {
  const { range, now, historyComplete, hourly, from, end, prevFrom } = ctx;
  const rows = metricsView(stored, view ?? 'all');
  const buckets = bucketsOf(range, from, end);
  const step = rangeStep(range, end - from);
  const average = step === 'week' || step === 'month';
  const series = pointsOf(rows, buckets, average, hourly);
  const previousSeries =
    prevFrom === null
      ? null
      : pointsOf(rows, bucketsOf(range, prevFrom, from), average, hourly).map(
          ({ t: _t, ...p }) => p,
        );
  const roles: RoleCounts = parts
    ? {
        active: parts.all.kpis.active - parts.arc.kpis.active,
        buyers_only: parts.all.agents.buyers_only - parts.arc.agents.buyers_only,
        sellers_only: parts.all.agents.sellers_only - parts.arc.agents.sellers_only,
        both: parts.all.agents.both - parts.arc.agents.both,
        other: parts.all.agents.other - parts.arc.agents.other,
      }
    : await rolesSince(db, from, view === 'arc' ? arcChainId : undefined);
  let previous: DashboardKpis | null = null;
  if (prevFrom !== null) {
    // Under a savepoint with its own time limit: a slow count keeps the stored value instead of
    // failing the whole snapshot (the transaction stays usable after the rollback).
    let prevActive: number;
    if (parts) prevActive = (parts.all.previous?.active ?? 0) - (parts.arc.previous?.active ?? 0);
    else {
      await db.query('SAVEPOINT previous_active');
      try {
        await db.query(`SET LOCAL statement_timeout = '${PREVIOUS_ACTIVE_TIMEOUT}'`);
        prevActive = await distinctActive(
          db,
          prevFrom,
          from,
          hourly,
          view === 'arc' ? arcChainId : undefined,
        );
        await db.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
        await db.query('RELEASE SAVEPOINT previous_active');
      } catch (error) {
        if (!transientDatabaseError(error)) throw error;
        await db.query('ROLLBACK TO SAVEPOINT previous_active');
        prevActive = await storedPreviousActive(db, range, view);
      }
    }
    previous = kpisOf(rows, prevFrom, from, prevActive);
  }
  const kpis = kpisOf(rows, from, end, roles.active);
  const hourOfDay = Array.from({ length: 24 }, () => 0);
  if (hourly) {
    for (const [h, m] of rows)
      if (h >= from && h < end)
        hourOfDay[new Date(h).getUTCHours()]! += Number(m.get('calls') ?? 0n);
  } else
    for (let i = 0; i < 24; i += 1)
      hourOfDay[i] = Number(
        sumOf(rows, from, end, (k) => k === `hod:${String(i).padStart(2, '0')}`),
      );
  const fees = BigInt(kpis.fees_raw);
  const value = BigInt(kpis.value_settled_raw);
  const routes = FEE_ROUTES.map((r) => {
    const v = sumOf(rows, from, end, (k) => k === `fee:${r.key}`);
    const count = Number(sumOf(rows, from, end, (k) => k === `feen:${r.key}`));
    return {
      key: r.key,
      label: r.label,
      fees_raw: v.toString(),
      count,
      share: fees > 0n ? Number((v * 10000n) / fees) / 10000 : 0,
    };
  }).filter((r) => r.fees_raw !== '0' || r.key.startsWith('router'));
  return {
    range,
    step,
    from: new Date(from).toISOString(),
    updated_at: new Date(now).toISOString(),
    history_complete: historyComplete,
    kpis,
    previous,
    series,
    previous_series: previousSeries,
    active_point: average ? 'daily_average' : 'distinct',
    hour_of_day: hourOfDay,
    fees: {
      rate: value > 0n ? Number((fees * 1_000_000n) / value) / 1_000_000 : 0,
      sellers_raw: (value > fees ? value - fees : 0n).toString(),
      routes,
    },
    agents: {
      buyers_only: roles.buyers_only,
      sellers_only: roles.sellers_only,
      both: roles.both,
      other: roles.other,
    },
    prices: PRICE_BUCKETS.map((b) => ({
      key: b.key,
      label: b.label,
      calls: Number(sumOf(rows, from, end, (k) => k === `price:${b.key}`)),
    })),
    top_services: await topServices(db, from, hourly, view),
  };
}

export type SnapshotBuilder = typeof buildSnapshot;

/**
 * Writes each range on its own: a range that fails (a timeout) keeps its last good snapshot and
 * never stops the others. Returns the ranges written and the ranges that failed.
 */
export async function writeSnapshots(
  db: Database,
  now: number,
  ranges: readonly DashboardRange[],
  build: SnapshotBuilder = buildSnapshot,
  arcChainId: number | null = null,
): Promise<{ written: DashboardRange[]; failed: DashboardRange[] }> {
  const state = await readState(db);
  const written: DashboardRange[] = [];
  const failed: DashboardRange[] = [];
  for (const range of ranges) {
    try {
      const body = await db.transaction(async (tx) => {
        await limits(tx);
        return arcChainId === null
          ? build(tx, range, now, state.backfill_done)
          : build(tx, range, now, state.backfill_done, arcChainId);
      });
      await db.query(
        `INSERT INTO dashboard_snapshots (range, body, computed_at) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (range) DO UPDATE SET body = EXCLUDED.body, computed_at = EXCLUDED.computed_at`,
        [range, JSON.stringify(body), now],
      );
      written.push(range);
    } catch {
      failed.push(range);
    }
  }
  return { written, failed };
}

// ---------------------------------------------------------------------------------------------
// One cron run

export interface RollupRunResult {
  skipped?: 'lease';
  live?: LiveResult;
  /** Set when the live update failed; snapshots and the backfill still ran. */
  live_failed?: true;
  snapshots?: DashboardRange[];
  failed?: DashboardRange[];
  backfill?: BackfillResult;
  backfill_failed?: true;
}

/**
 * One cron run: the live update, the snapshots, then the backfill. No step stops the next: a
 * failed live update or snapshot still lets the backfill advance. The slow ranges' time is saved
 * before they run, so a range that times out is tried again only after SLOW_EVERY_MS, not on
 * every run.
 */
export async function runDashboardRollup(
  db: Database,
  deps: {
    clock: () => number;
    backfillBudgetMs?: number;
    busy?: (db: Q) => Promise<boolean>;
    build?: SnapshotBuilder;
    /** dashboardArcChainId(env): null (Arc off) runs exactly the reads of before. */
    arcChainId?: number | null;
  },
): Promise<RollupRunResult> {
  const arcChainId = deps.arcChainId ?? null;
  if (!(await claimLease(db))) return { skipped: 'lease' };
  try {
    const result: RollupRunResult = {};
    const tables = await sourceTables(db);
    const now = deps.clock();
    try {
      result.live = await updateLive(db, now, tables, arcChainId);
    } catch {
      result.live_failed = true;
    }
    const state = await readState(db);
    const slow = now - Number(state.slow_at) >= SLOW_EVERY_MS;
    if (slow) await db.query('UPDATE dashboard_state SET slow_at = $1 WHERE id', [now]);
    const ranges = slow ? [...FAST_RANGES, ...SLOW_RANGES] : [...FAST_RANGES];
    const snaps = await writeSnapshots(db, now, ranges, deps.build, arcChainId);
    result.snapshots = snaps.written;
    if (snaps.failed.length) result.failed = snaps.failed;
    // Its own transaction and time limit: a failure here repeats next run and stops nothing else.
    await stepPaymasterOperations(db).catch(() => undefined);
    try {
      result.backfill = await runBackfill(db, {
        clock: deps.clock,
        tables,
        ...(deps.backfillBudgetMs !== undefined ? { budgetMs: deps.backfillBudgetMs } : {}),
        ...(deps.busy ? { busy: deps.busy } : {}),
      });
    } catch {
      result.backfill_failed = true;
    }
    // History that just finished building shows in every range at once.
    if (result.backfill && result.backfill.batches > 0 && result.backfill.done) {
      const all = await writeSnapshots(db, deps.clock(), DASHBOARD_RANGES, deps.build, arcChainId);
      result.snapshots = all.written;
      if (all.failed.length) result.failed = all.failed;
      else delete result.failed;
    }
    return result;
  } finally {
    await releaseLease(db).catch(() => undefined);
  }
}

export { RANGE_DAYS };
