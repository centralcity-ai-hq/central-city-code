import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database } from '../database.js';
import { DAY_MS, dayOf, ELRIC_COST_UNIT_USD, ELRIC_GLOBAL_DAILY_USD } from './config.js';

/**
 * The operator's daily Elric cost report, read from the turn log (`elric_turns`).
 *
 * `GET /api/ops/elric/cost?days=N` (behind the same CITY_OPS_SECRET guard as the other ops routes,
 * 404 otherwise) returns, for the last N UTC days (today included, default 7, at most 90):
 * settled spend per day and per tier (T1, T2; T0 is deterministic and costs no GPU), the total
 * over the window against the budget (ELRIC_GLOBAL_DAILY_USD per day times N) and the percent used.
 *
 * Conversation-title calls (titles.ts, `elric_title_costs`) show as `titles` and count in the
 * total cost, not in the turn counts.
 *
 * Turns of deleted accounts count through `elric_cost_erased` (erase.ts), which has no owner.
 *
 * Aggregates only: sums and counts grouped by day and tier. Never an owner, room, agent, turn,
 * model output or message text.
 */
export const COST_REPORT_DEFAULT_DAYS = 7;
export const COST_REPORT_MAX_DAYS = 90;

export interface CostRow {
  /** Days since the epoch (UTC). */
  day_index: number;
  tier: number | null;
  cost_units: number;
  turns: number;
  /** A conversation-title row (elric_title_costs): `turns` counts title calls. */
  title?: boolean;
}

export interface TierSpend {
  turns: number;
  cost_units: number;
  spend_usd: number;
}

export interface CostDay {
  day: string;
  t1: TierSpend;
  t2: TierSpend;
  /** Conversation-title calls (titles.ts): `turns` is the number of calls. */
  titles: TierSpend;
  /** Every turn of the day, any tier (T0 and refusals included), plus the title cost. */
  total: TierSpend;
  budget_usd: number;
  percent: number;
}

export interface CostReport {
  days: number;
  from: string;
  to: string;
  budget_usd_per_day: number;
  cost_unit_usd: number;
  /** Newest first. */
  daily: CostDay[];
  cumulative: { t1: TierSpend; t2: TierSpend; titles: TierSpend; total: TierSpend };
  budget_usd: number;
  percent_used: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const usd = (units: number) => round2(units * ELRIC_COST_UNIT_USD);
const empty = (): { turns: number; cost_units: number } => ({ turns: 0, cost_units: 0 });
const view = (s: { turns: number; cost_units: number }): TierSpend => ({
  turns: s.turns,
  cost_units: s.cost_units,
  spend_usd: usd(s.cost_units),
});
const percent = (spent: number, budget: number) =>
  budget > 0 ? round2((spent / budget) * 100) : 100;

/** Builds the report from grouped rows. Pure: rows outside the window are ignored. */
export function buildCostReport(
  rows: CostRow[],
  now: number,
  days: number,
  budgetPerDay: number = ELRIC_GLOBAL_DAILY_USD,
): CostReport {
  const today = Math.floor(now / DAY_MS);
  const buckets = new Map<
    number,
    Record<'t1' | 't2' | 'titles' | 'total', ReturnType<typeof empty>>
  >();
  for (let i = 0; i < days; i++)
    buckets.set(today - i, { t1: empty(), t2: empty(), titles: empty(), total: empty() });
  const sum = { t1: empty(), t2: empty(), titles: empty(), total: empty() };
  for (const row of rows) {
    const bucket = buckets.get(Number(row.day_index));
    if (!bucket) continue;
    const units = Number(row.cost_units);
    const turns = Number(row.turns);
    if (row.title) {
      // Title calls add their cost to the total; they are not turns.
      for (const target of [bucket, sum]) {
        target.titles.turns += turns;
        target.titles.cost_units += units;
        target.total.cost_units += units;
      }
      continue;
    }
    const keys: Array<'t1' | 't2' | 'total'> = ['total'];
    if (Number(row.tier) === 1) keys.push('t1');
    if (Number(row.tier) === 2) keys.push('t2');
    for (const key of keys) {
      bucket[key].turns += turns;
      bucket[key].cost_units += units;
      sum[key].turns += turns;
      sum[key].cost_units += units;
    }
  }
  const daily = [...buckets].map(([index, b]): CostDay => {
    const total = view(b.total);
    return {
      day: dayOf(index * DAY_MS),
      t1: view(b.t1),
      t2: view(b.t2),
      titles: view(b.titles),
      total,
      budget_usd: budgetPerDay,
      percent: percent(total.spend_usd, budgetPerDay),
    };
  });
  const budget = budgetPerDay * days;
  const total = view(sum.total);
  return {
    days,
    from: dayOf((today - days + 1) * DAY_MS),
    to: dayOf(today * DAY_MS),
    budget_usd_per_day: budgetPerDay,
    cost_unit_usd: ELRIC_COST_UNIT_USD,
    daily,
    cumulative: { t1: view(sum.t1), t2: view(sum.t2), titles: view(sum.titles), total },
    budget_usd: budget,
    percent_used: percent(total.spend_usd, budget),
  };
}

const query = z
  .object({
    days: z.coerce
      .number()
      .int()
      .min(1)
      .max(COST_REPORT_MAX_DAYS)
      .default(COST_REPORT_DEFAULT_DAYS),
  })
  .strict();

/** Registered from registerElricOps, which passes its CITY_OPS_SECRET guard. */
export function registerElricCostReport(
  app: FastifyInstance,
  d: {
    db: Pick<Database, 'query'>;
    clock: () => number;
    guard: (request: FastifyRequest) => void;
  },
): void {
  app.get('/api/ops/elric/cost', async (request) => {
    d.guard(request);
    const { days } = query.parse(request.query ?? {});
    const now = d.clock();
    const since = (Math.floor(now / DAY_MS) - days + 1) * DAY_MS;
    const rows = (
      await d.db.query<CostRow>(
        `SELECT floor(created_at / ${DAY_MS})::int AS day_index, tier,
                COALESCE(sum(cost_units),0)::bigint AS cost_units, count(*)::int AS turns,
                false AS title
           FROM elric_turns WHERE created_at >= $1
          GROUP BY 1, 2
         UNION ALL
         SELECT day_index, tier, cost_units, turns, false FROM elric_cost_erased WHERE day_index >= $2
         UNION ALL
         SELECT day_index, NULL, cost_units, calls, true FROM elric_title_costs
          WHERE day_index >= $2`,
        [since, since / DAY_MS],
      )
    ).rows;
    return buildCostReport(rows, now, days);
  });
}
