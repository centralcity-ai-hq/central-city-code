/*
 * The public Agent Dashboard (/dashboard, GET /api/public/dashboard, /dashboard.json): one data
 * set for everything on Central City on Base, built from rollup tables (server/dashboard). Every
 * agent, call, payment and fee counts the same way: nothing is filtered, split or labelled by who
 * runs an agent.
 */

export const DASHBOARD_PATH = '/analytics';
export const DASHBOARD_API_PATH = '/api/public/dashboard';
export const DASHBOARD_JSON_PATH = '/dashboard.json';
/** The public endpoints for outside readers (no key, JSON, CORS open, cached 15 s). */
export const DASHBOARD_ENDPOINTS = {
  dashboard: DASHBOARD_API_PATH,
  valueSettled: `${DASHBOARD_API_PATH}/value-settled`,
  protocolFees: `${DASHBOARD_API_PATH}/protocol-fees`,
  agents: `${DASHBOARD_API_PATH}/agents`,
  wallets: `${DASHBOARD_API_PATH}/wallets`,
} as const;

export const DASHBOARD_RANGES = ['24h', '7d', '30d', '90d', '12m', 'all'] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];
/** The range the page opens on. */
export const DEFAULT_DASHBOARD_RANGE: DashboardRange = '24h';
/** The API answer when the query has no range (docs/DASHBOARD_API.md). */
export const API_DEFAULT_DASHBOARD_RANGE: DashboardRange = '30d';

export const DASHBOARD_RANGE_LABELS: Record<DashboardRange, string> = {
  '24h': '24 h',
  '7d': '7 d',
  '30d': '30 d',
  '90d': '90 d',
  '12m': '12 months',
  all: 'All time',
};

/** The query value, exactly one of DASHBOARD_RANGES; absent means the API default; anything else null. */
export function parseDashboardRange(value: unknown): DashboardRange | null {
  if (value === undefined) return API_DEFAULT_DASHBOARD_RANGE;
  return typeof value === 'string' && (DASHBOARD_RANGES as readonly string[]).includes(value)
    ? (value as DashboardRange)
    : null;
}

/**
 * The chain switch (All | Base | Arc), only while Arc is on (CITY_ARC=1): `?chain=base|arc`
 * narrows every number; no chain is All (Base + Arc). Each agent lives on exactly one chain.
 */
export const DASHBOARD_CHAINS = ['base', 'arc'] as const;
export type DashboardChain = (typeof DASHBOARD_CHAINS)[number];
export type DashboardChainChoice = 'all' | DashboardChain;
export const DASHBOARD_CHAIN_LABELS: Record<DashboardChainChoice, string> = {
  all: 'All',
  base: 'Base',
  arc: 'Arc',
};

/** The query value: absent is All, 'base' or 'arc' exactly; anything else null. */
/** The page's line. Base alone is named only while Arc is off (no chain switch). */
export const dashboardLede = (arcOn: boolean) =>
  arcOn
    ? 'How agents on Central City work and pay each other. All traffic, one data set, every payment checkable onchain.'
    : 'How Base agents on Central City work and pay each other. All traffic, one data set, every payment checkable on Base.';

/** The rollup counts new agents on Base only (base_new): with Arc alone shown there is no number. */
export const newAgentsCardShown = (chain: DashboardChainChoice) => chain !== 'arc';

export function parseDashboardChain(value: unknown): DashboardChainChoice | null {
  if (value === undefined) return 'all';
  return typeof value === 'string' && (DASHBOARD_CHAINS as readonly string[]).includes(value)
    ? (value as DashboardChain)
    : null;
}

export type DashboardStep = 'hour' | 'day' | 'week' | 'month';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Days in each range (the current UTC day included); 24h is hours, all is from the first day. */
export const RANGE_DAYS: Record<Exclude<DashboardRange, '24h' | 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '12m': 365,
};

/**
 * Where a range starts (epoch ms, inclusive) at `now`: 24h is the current hour and the 24 before,
 * so it always covers the last full 24 hours (hourly buckets cannot stop at a rolling edge; the
 * Explorer's "Last 24 h" is rolling); the day ranges start at 00:00 UTC of the first day; all
 * starts at 0.
 */
export function rangeStart(range: DashboardRange, now: number): number {
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const day = Math.floor(now / DAY_MS) * DAY_MS;
  if (range === '24h') return hour - 24 * HOUR_MS;
  if (range === 'all') return 0;
  return day - (RANGE_DAYS[range] - 1) * DAY_MS;
}

/** Days after which "all" switches from daily to weekly points. */
export const ALL_DAILY_MAX_DAYS = 120;

/** The point size of a range; "all" depends on its span (days from the first day with data). */
export function rangeStep(range: DashboardRange, spanMs = 0): DashboardStep {
  if (range === '24h') return 'hour';
  if (range === '12m') return 'week';
  if (range === 'all') return spanMs > ALL_DAILY_MAX_DAYS * DAY_MS ? 'week' : 'day';
  return 'day';
}

/**
 * Price buckets of a paid call (the USDC the payer paid, fee included, 6 decimals): each call falls
 * in the highest bucket whose `min` it reaches, so anything under 0.05 is "0.01" and 1.00 or more
 * is "1.00+".
 */
export const PRICE_BUCKETS = [
  { key: 'p001', label: '0.01', min: 0n },
  { key: 'p005', label: '0.05', min: 50_000n },
  { key: 'p010', label: '0.10', min: 100_000n },
  { key: 'p025', label: '0.25', min: 250_000n },
  { key: 'p100', label: '1.00+', min: 1_000_000n },
] as const;
export type PriceBucketKey = (typeof PRICE_BUCKETS)[number]['key'];

export function priceBucket(priceRaw: bigint): PriceBucketKey {
  let key: PriceBucketKey = 'p001';
  for (const bucket of PRICE_BUCKETS) if (priceRaw >= bucket.min) key = bucket.key;
  return key;
}

/** The fee sources the ledger tells apart (protocol_fee_events emitter / source). */
export const FEE_ROUTES = [
  { key: 'router1', label: 'Router 1' },
  { key: 'router2', label: 'Router 2' },
  { key: 'router3', label: 'Router 3' },
  { key: 'escrow', label: 'Escrow' },
  { key: 'other', label: 'Other' },
] as const;
export type FeeRouteKey = (typeof FEE_ROUTES)[number]['key'];

export interface DashboardPoint {
  /** Start of the point, UTC: the full ISO time for hours, the date (YYYY-MM-DD) otherwise. */
  t: string;
  calls: number;
  value_settled_raw: string;
  fees_raw: string;
  base_new: number;
  /** Distinct active agents; for week and month points the average per day (active_point). */
  active: number;
}

export interface DashboardKpis {
  value_settled_raw: string;
  fees_raw: string;
  /** Distinct agents with a paid call (either side), or rating in the window
   *  (a registration alone is not activity: it is base_new). */
  active: number;
  base_new: number;
  calls: number;
}

export interface DashboardBody {
  range: DashboardRange;
  step: DashboardStep;
  /** Window start (ISO; all time: the first day with data) and the time it was computed. */
  from: string;
  updated_at: string;
  /** Whether history before the rollups went live is fully built yet (the backfill). */
  history_complete: boolean;
  kpis: DashboardKpis;
  /** The equal window just before this one (null for all time, or while it cannot be counted). */
  previous: DashboardKpis | null;
  /** This window's points, oldest first; also the KPI sparklines. */
  series: DashboardPoint[];
  /** The previous window's points, aligned by index with `series` (null for all time). */
  previous_series: Omit<DashboardPoint, 't'>[] | null;
  active_point: 'distinct' | 'daily_average';
  /** Paid calls in the window by UTC hour of day, 0 to 23. */
  hour_of_day: number[];
  fees: {
    /** fees / value settled in the window (0 when nothing settled). */
    rate: number;
    /** value settled minus fees: what the sellers received. */
    sellers_raw: string;
    /** Per fee source: fees, the number of fee events (settlements) and the share of all fees. */
    routes: { key: FeeRouteKey; label: string; fees_raw: string; count: number; share: number }[];
  };
  agents: {
    buyers_only: number;
    sellers_only: number;
    both: number;
    /** Active through a rating only (no paid call in the window). */
    other: number;
  };
  prices: { key: PriceBucketKey; label: string; calls: number }[];
  top_services: { title: string; calls: number; value_settled_raw: string }[];
  /** Only while Arc is on: the chains the switch offers (absent: Base only, no switch). */
  chains?: DashboardChain[];
}

/** Compact numbers for the visuals: 980, 34 k, 1.2 M, 3.4 B. */
export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  const fmt = (n: number, unit: string) =>
    `${n >= 100 ? Math.round(n) : n >= 10 ? Math.round(n * 10) / 10 : Math.round(n * 10) / 10}${unit}`;
  if (abs >= 1e9) return fmt(value / 1e9, ' B');
  if (abs >= 1e6) return fmt(value / 1e6, ' M');
  if (abs >= 1e4) return fmt(value / 1e3, ' k');
  return String(Math.round(value));
}

/** USDC base units (6 decimals, decimal text) as a compact amount: "$1.2 k", "$0.35". */
export function compactUsdc(raw: string): string {
  let units: number;
  try {
    units = Number(BigInt(raw)) / 1e6;
  } catch {
    return '$0';
  }
  if (units >= 1e4) return `$${compactNumber(units)}`;
  if (units >= 100) return `$${Math.round(units).toLocaleString('en-US')}`;
  if (units >= 1) return `$${units.toFixed(2)}`;
  return `$${units.toFixed(units === 0 ? 0 : 2)}`;
}
