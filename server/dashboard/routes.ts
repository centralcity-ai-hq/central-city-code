import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../database.js';
import { clientAddressKey } from '../rate-limit.js';
import {
  PUBLIC_STATS_CACHE_CONTROL,
  PUBLIC_STATS_INCOMPLETE_CACHE_CONTROL,
} from '../stats/public-stats.js';
import {
  DASHBOARD_API_PATH,
  DASHBOARD_ENDPOINTS,
  DASHBOARD_JSON_PATH,
  DASHBOARD_RANGES,
  DASHBOARD_CHAINS,
  parseDashboardChain,
  parseDashboardRange,
  type DashboardBody,
  type DashboardChainChoice,
  type DashboardRange,
} from '../../shared/dashboard.js';
import { dashboardArcChainId, runDashboardRollup } from './rollup.js';
import { paymasterOperations } from './paymaster-ops.js';
import { createWalletsReader, viemWalletChain, type WalletChain } from './wallets.js';

/*
 * The public Agent Dashboard API (shared/dashboard.ts):
 *   GET /api/public/dashboard?range=24h|7d|30d|90d|12m|all
 *   GET /dashboard.json?range=...            the same answer
 *   GET /api/public/dashboard/value-settled?range=...   value settled (and calls) only
 *   GET /api/public/dashboard/protocol-fees?range=...   protocol fees, split by fee router
 *   GET /api/public/dashboard/agents?range=...          active and new Base agents
 *   GET /api/public/dashboard/wallets                   contracts and wallets, live balances
 * The four range endpoints also take `chain=base|arc` while Arc is on (CITY_ARC=1; no chain is
 * All = Base + Arc). The snapshot row holds all three views; Arc off it holds the answer of before
 * and is served unchanged (chain=base is then that same answer, chain=arc a 400).
 * Each answer is one primary-key read of dashboard_snapshots (built by the rollup cron), kept
 * DASHBOARD_CACHE_MS per server with one read in flight, and cacheable at the edge like
 * /api/public/stats. Never a read of a source table on a request.
 *
 *   GET /api/cron/dashboard-rollup           the cron (CRON_SECRET bearer; 404 otherwise)
 */
export const DASHBOARD_CRON_PATH = '/api/cron/dashboard-rollup';
export const DASHBOARD_CACHE_MS = 15_000;
/** Vercel's edge only: fresh 15 s, then stale for up to 10 minutes while one request refreshes. */
export const DASHBOARD_EDGE_CACHE_CONTROL = 'public, max-age=15, stale-while-revalidate=600';
export const DASHBOARD_RATE = { max: 60, windowMs: 60_000 } as const;

interface Cached {
  body: Views | null;
  until: number;
}

/** A snapshot as served per chain; arc null while the snapshot has no Arc views (Arc off). */
export interface Views {
  all: string;
  base: string;
  arc: string | null;
}

/** Splits a stored snapshot into its served answers. Arc off: the stored body, untouched. */
export function viewsOf(raw: unknown): Views {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
    views?: { base: unknown; arc: unknown };
  };
  if (!parsed || typeof parsed !== 'object' || !parsed.views)
    return { all: text, base: text, arc: null };
  const { views, ...all } = parsed;
  return {
    all: JSON.stringify(all),
    base: JSON.stringify(views.base),
    arc: JSON.stringify(views.arc),
  };
}

export function createDashboardReader(deps: {
  db: Pick<Database, 'query'>;
  clock: () => number;
  ttlMs?: number;
}) {
  const cache = new Map<DashboardRange, Cached>();
  const inflight = new Map<DashboardRange, Promise<Views | null>>();
  return async (range: DashboardRange): Promise<Views | null> => {
    const hit = cache.get(range);
    if (hit && deps.clock() < hit.until) return hit.body;
    let run = inflight.get(range);
    if (!run) {
      run = deps.db
        .query<{ body: unknown }>('SELECT body FROM dashboard_snapshots WHERE range = $1', [range])
        .then((result) => {
          const raw = result.rows[0]?.body;
          const body = raw === undefined ? null : viewsOf(raw);
          // No snapshot yet is not kept: the first one shows as soon as the cron writes it.
          if (body !== null)
            cache.set(range, { body, until: deps.clock() + (deps.ttlMs ?? DASHBOARD_CACHE_MS) });
          return body;
        })
        .catch((error: unknown) => {
          // A failed read serves the last body this server had.
          if (hit) return hit.body;
          throw error;
        })
        .finally(() => inflight.delete(range));
      inflight.set(range, run);
    }
    return run;
  };
}

function bearerMatches(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The parts of a snapshot each narrow endpoint answers with. */
export function valueSettledOf(b: DashboardBody) {
  return {
    range: b.range,
    step: b.step,
    from: b.from,
    updated_at: b.updated_at,
    history_complete: b.history_complete,
    value_settled_raw: b.kpis.value_settled_raw,
    calls: b.kpis.calls,
    previous: b.previous
      ? { value_settled_raw: b.previous.value_settled_raw, calls: b.previous.calls }
      : null,
    series: b.series.map((p) => ({
      t: p.t,
      value_settled_raw: p.value_settled_raw,
      calls: p.calls,
    })),
  };
}

export function protocolFeesOf(b: DashboardBody) {
  return {
    range: b.range,
    step: b.step,
    from: b.from,
    updated_at: b.updated_at,
    history_complete: b.history_complete,
    fees_raw: b.kpis.fees_raw,
    previous: b.previous ? { fees_raw: b.previous.fees_raw } : null,
    rate: b.fees.rate,
    routes: b.fees.routes,
    series: b.series.map((p) => ({ t: p.t, fees_raw: p.fees_raw })),
  };
}

export function agentsOf(b: DashboardBody) {
  return {
    range: b.range,
    step: b.step,
    from: b.from,
    updated_at: b.updated_at,
    history_complete: b.history_complete,
    active: b.kpis.active,
    base_new: b.kpis.base_new,
    previous: b.previous ? { active: b.previous.active, base_new: b.previous.base_new } : null,
    sides: b.agents,
    active_point: b.active_point,
    series: b.series.map((p) => ({ t: p.t, active: p.active, base_new: p.base_new })),
  };
}

const NARROW: Record<string, (b: DashboardBody) => unknown> = {
  [DASHBOARD_ENDPOINTS.valueSettled]: valueSettledOf,
  [DASHBOARD_ENDPOINTS.protocolFees]: protocolFeesOf,
  [DASHBOARD_ENDPOINTS.agents]: agentsOf,
};

const PUBLIC_HEADERS = (reply: FastifyReply) =>
  reply
    .header('Content-Type', 'application/json; charset=utf-8')
    .header('Cache-Control', PUBLIC_STATS_CACHE_CONTROL)
    .header('Vercel-CDN-Cache-Control', DASHBOARD_EDGE_CACHE_CONTROL)
    .header('Access-Control-Allow-Origin', '*');

export function registerDashboardRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    clock: () => number;
    limit: (key: string, max: number, windowMs: number) => Promise<void>;
    cronSecret?: string | undefined;
    /** The Arc chain the rollup also reads (default: dashboardArcChainId(process.env)). */
    arcChainId?: number | null;
    /** Base read endpoints for the wallets' balances (none: balances stay empty). */
    chainUrls?: readonly string[];
    /** Tests pass a fake chain. */
    chain?: WalletChain | null;
  },
): void {
  const read = createDashboardReader({ db: deps.db, clock: deps.clock });
  const arcChainId =
    deps.arcChainId !== undefined ? deps.arcChainId : dashboardArcChainId(process.env);
  const wallets = createWalletsReader({
    chain: deps.chain !== undefined ? deps.chain : viemWalletChain(deps.chainUrls ?? []),
    clock: deps.clock,
    operations: () => paymasterOperations(deps.db),
  });
  const limited = (request: FastifyRequest) =>
    deps.limit(
      `ip:dashboard:${clientAddressKey(request.ip)}`,
      DASHBOARD_RATE.max,
      DASHBOARD_RATE.windowMs,
    );
  const answer = async (request: FastifyRequest, reply: FastifyReply) => {
    // Only `range` and `chain`, once: every other spelling would be a new edge cache entry.
    const query = (request.query ?? {}) as Record<string, unknown>;
    if (Object.keys(query).some((key) => key !== 'range' && key !== 'chain'))
      return reply.code(400).header('Cache-Control', 'no-store').send({ error: 'invalid_query' });
    const chain: DashboardChainChoice | null = parseDashboardChain(query.chain);
    if (!chain)
      return reply
        .code(400)
        .header('Cache-Control', 'no-store')
        .send({ error: 'invalid_chain', chains: DASHBOARD_CHAINS });
    const range = parseDashboardRange(query.range);
    if (!range)
      return reply
        .code(400)
        .header('Cache-Control', 'no-store')
        .send({ error: 'invalid_range', ranges: DASHBOARD_RANGES });
    await limited(request);
    const views = await read(range);
    // A snapshot without Arc's views is a 400 only while Arc is off. With Arc on it was built before
    // the switch: chain=arc is valid and being built, so it answers 503 as any unbuilt range does.
    if (views !== null && chain === 'arc' && views.arc === null && arcChainId === null)
      return reply
        .code(400)
        .header('Cache-Control', 'no-store')
        .send({ error: 'invalid_chain', chains: ['base'] });
    const body = views === null ? null : chain === 'all' ? views.all : views[chain];
    if (body === null)
      return reply
        .code(503)
        .header('Cache-Control', PUBLIC_STATS_INCOMPLETE_CACHE_CONTROL)
        .header('Vercel-CDN-Cache-Control', PUBLIC_STATS_INCOMPLETE_CACHE_CONTROL)
        .header('Access-Control-Allow-Origin', '*')
        .send({
          error: 'not_ready',
          message: 'The dashboard is being built. Try again in a minute.',
        });
    const path = request.url.split('?')[0]!;
    const narrow = NARROW[path];
    return PUBLIC_HEADERS(reply).send(
      narrow ? JSON.stringify(narrow(JSON.parse(body) as DashboardBody)) : body,
    );
  };
  app.get(DASHBOARD_API_PATH, answer);
  app.get(DASHBOARD_JSON_PATH, answer);
  for (const path of Object.keys(NARROW)) app.get(path, answer);
  app.get(DASHBOARD_ENDPOINTS.wallets, async (request, reply) => {
    if (Object.keys((request.query ?? {}) as object).length)
      return reply.code(400).header('Cache-Control', 'no-store').send({ error: 'invalid_query' });
    await limited(request);
    return PUBLIC_HEADERS(reply).send(JSON.stringify(await wallets()));
  });
  app.get(DASHBOARD_CRON_PATH, async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, deps.cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    try {
      const result = await runDashboardRollup(deps.db, { clock: deps.clock, arcChainId });
      console.log(JSON.stringify({ event: 'dashboard_rollup', ...result }));
      return reply.header('Cache-Control', 'no-store').send(result);
    } catch {
      // Database errors can quote SQL parameters: a fixed line only. Applied work stays applied.
      console.error(JSON.stringify({ event: 'dashboard_rollup_failed' }));
      return reply.code(500).send({ error: 'The rollup failed; the next run continues it.' });
    }
  });
}
