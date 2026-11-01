import {
  DASHBOARD_API_PATH,
  DASHBOARD_ENDPOINTS,
  compactNumber,
  type DashboardBody,
  type DashboardChainChoice,
  type DashboardPoint,
  type DashboardRange,
} from '../../shared/dashboard';
import type { DashboardWallets } from '../../shared/dashboard-contracts';

/** USDC base units (decimal text) as a number of USDC. */
export function usdc(raw: string | undefined | null): number {
  if (!raw) return 0;
  try {
    return Number(BigInt(raw)) / 1e6;
  } catch {
    return 0;
  }
}

/** A compact amount split into number and unit, for "23.6 k" + "USDC" on one line. */
export function usdcParts(raw: string | undefined | null): { num: string; unit: string } {
  return usdcPartsOf(usdc(raw));
}

/** The same for a number of USDC (a counting value). */
export function usdcPartsOf(v: number): { num: string; unit: string } {
  if (v >= 1e4) return { num: compactNumber(v), unit: 'USDC' };
  if (v >= 100) return { num: Math.round(v).toLocaleString('en-US'), unit: 'USDC' };
  return { num: v.toFixed(2), unit: 'USDC' };
}

export const compactUsdcText = (raw: string | undefined | null) => {
  const p = usdcParts(raw);
  return `${p.num} ${p.unit}`;
};

/** The change against the previous window as a badge text: "+18 %", "-4 %", "New", or null. */
export function changeBadge(current: number, previous: number | null | undefined): string | null {
  if (previous === null || previous === undefined) return null;
  if (previous === 0) return current > 0 ? 'New' : '0 %';
  const pct = ((current - previous) / previous) * 100;
  const rounded = Math.abs(pct) >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  if (rounded === 0) return '0 %';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)} %`;
}

export type SeriesKey = 'value' | 'calls' | 'active';
export const SERIES_LABELS: Record<SeriesKey, string> = {
  value: 'Value settled',
  calls: 'Paid calls',
  active: 'Active agents',
};

export function pointValue(
  point: Omit<DashboardPoint, 't'>,
  key: SeriesKey | 'fees' | 'base_new',
): number {
  if (key === 'value') return usdc(point.value_settled_raw);
  if (key === 'fees') return usdc(point.fees_raw);
  if (key === 'calls') return point.calls;
  if (key === 'base_new') return point.base_new;
  return point.active;
}

export function busiestHour(hours: readonly number[]): { hour: number; calls: number } | null {
  let best = -1;
  let calls = 0;
  hours.forEach((n, i) => {
    if (n > calls) {
      calls = n;
      best = i;
    }
  });
  return best < 0 ? null : { hour: best, calls };
}

/** Shares that add up to 100 (largest remainder), for labels like "62 %". */
export function percents(values: readonly number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => 0);
  const raw = values.map((v) => (v / total) * 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floors[i]! += 1;
    left -= 1;
  }
  return floors;
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** All keeps the key of before; a chain view has its own. */
const CACHE_KEY = (range: DashboardRange, chain: DashboardChainChoice = 'all') =>
  `cc.dashboard.v1.${range}${chain === 'all' ? '' : `.${chain}`}`;

/** The last answer this browser saw for a range, so the page shows numbers from the first second. */
export function cachedBody(
  range: DashboardRange,
  chain: DashboardChainChoice = 'all',
): DashboardBody | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY(range, chain));
    return raw ? (JSON.parse(raw) as DashboardBody) : null;
  } catch {
    return null;
  }
}

export function rememberBody(body: DashboardBody, chain: DashboardChainChoice = 'all') {
  try {
    window.localStorage.setItem(CACHE_KEY(body.range, chain), JSON.stringify(body));
  } catch {
    // Storage may be blocked; the page works without it.
  }
}

export async function loadDashboard(
  range: DashboardRange,
  signal?: AbortSignal,
  chain: DashboardChainChoice = 'all',
): Promise<DashboardBody> {
  const query = chain === 'all' ? `range=${range}` : `range=${range}&chain=${chain}`;
  const response = await fetch(`${DASHBOARD_API_PATH}?${query}`, { signal });
  if (!response.ok) throw new Error(`dashboard ${response.status}`);
  return (await response.json()) as DashboardBody;
}

export async function loadWallets(signal?: AbortSignal): Promise<DashboardWallets> {
  const response = await fetch(DASHBOARD_ENDPOINTS.wallets, { signal });
  if (!response.ok) throw new Error(`wallets ${response.status}`);
  return (await response.json()) as DashboardWallets;
}

export const TRACK_ENDPOINTS: { label: string; path: string; query: boolean }[] = [
  { label: 'Everything on this page', path: DASHBOARD_ENDPOINTS.dashboard, query: true },
  { label: 'Value settled', path: DASHBOARD_ENDPOINTS.valueSettled, query: true },
  { label: 'Protocol revenue, by fee router', path: DASHBOARD_ENDPOINTS.protocolFees, query: true },
  { label: 'Active and new Base agents', path: DASHBOARD_ENDPOINTS.agents, query: true },
  {
    label: 'Contracts and wallets, live balances',
    path: DASHBOARD_ENDPOINTS.wallets,
    query: false,
  },
];
