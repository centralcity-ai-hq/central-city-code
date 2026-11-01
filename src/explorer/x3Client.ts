/*
 * The Explorer's X3 reads (rating events, per-agent metrics, counter history, finalizing
 * registrations and Base heads), as the reviewed contracts in #635, #636, #638 and #621 define
 * them. Every loader answers one of three states:
 *
 *   absent       the endpoint is not deployed (404): the page shows nothing for it, no empty tab,
 *                no zero column, no flat line
 *   unavailable  it is deployed but did not answer (503, timeout, malformed body): "not available
 *                right now", never zero
 *   ok           a well-formed answer
 *
 * A malformed answer is never read as an empty one.
 */

import { timeoutSignal } from '../shell/timeoutSignal';
import type { OnBaseRow } from '../verify/onBaseData';

export type X3<T> =
  | { state: 'absent' }
  | { state: 'unavailable' }
  /** stale: the server answered from a cache it could not refresh (its own stale flag). */
  | { state: 'ok'; value: T; stale: boolean };

export const X3_PATHS = {
  search: '/api/public/base/search',
  ratingEvents: '/api/public/base/rating-events',
  agentMetrics: '/api/public/base/agent-metrics',
  history: '/api/public/base/history',
  heads: '/api/public/base/heads',
  finalizing: '/api/public/base/finalizing',
} as const;

const X3_TIMEOUT_MS = 15_000;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * An endpoint that answered 404 is not deployed yet: it is asked again only after
 * X3_ABSENT_RECHECK_MS, for the whole session (every Explorer view), so a page never polls a
 * missing endpoint on each refresh, and still turns the piece on by itself once it ships.
 */
export const X3_ABSENT_RECHECK_MS = 10 * 60_000;
const absentUntil = new Map<string, number>();
let clock: () => number = Date.now;

/** For tests: forget which endpoints answered 404, and set the clock the cooldown reads. */
export function resetX3Absence(now: () => number = Date.now): void {
  absentUntil.clear();
  clock = now;
}

async function read<T>(
  path: string,
  parse: (body: unknown) => T | null,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<X3<T>> {
  const now = clock;
  const endpoint = path.split('?')[0]!;
  if ((absentUntil.get(endpoint) ?? 0) > now()) return { state: 'absent' };
  try {
    const response = await fetcher(path, {
      headers: { accept: 'application/json' },
      signal: signal ? timeoutSignal(signal, X3_TIMEOUT_MS) : AbortSignal.timeout(X3_TIMEOUT_MS),
    });
    if (response.status === 404) {
      absentUntil.set(endpoint, now() + X3_ABSENT_RECHECK_MS);
      return { state: 'absent' };
    }
    absentUntil.delete(endpoint);
    if (!response.ok) return { state: 'unavailable' };
    const body: unknown = await response.json();
    const value = parse(body);
    if (value === null) return { state: 'unavailable' };
    return { state: 'ok', value, stale: isObject(body) && body.stale === true };
  } catch {
    return { state: 'unavailable' };
  }
}

// ---- rating events (#635) ----

export type RatingEvent = {
  eventId: string;
  block: string;
  transactionHash: string;
  /** When Central City recorded the rating as final, never the chain event time. */
  recordedAt: string;
  raterBaseId: string;
  ratedBaseId: string;
  /** '' when the agent's name is not public. */
  raterName: string;
  ratedName: string;
  stars: number;
};
export type RatingEvents = { rows: RatingEvent[]; nextBefore: string | null; asOf: number };

export function parseRatingEvents(body: unknown): RatingEvents | null {
  if (!isObject(body) || !Array.isArray(body.rows) || typeof body.asOf !== 'number') return null;
  const rows: RatingEvent[] = [];
  for (const row of body.rows) {
    if (
      !isObject(row) ||
      typeof row.eventId !== 'string' ||
      typeof row.block !== 'string' ||
      !DECIMAL.test(row.block) ||
      typeof row.transactionHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(row.transactionHash) ||
      typeof row.recordedAt !== 'string' ||
      typeof row.raterBaseId !== 'string' ||
      !DECIMAL.test(row.raterBaseId) ||
      typeof row.ratedBaseId !== 'string' ||
      !DECIMAL.test(row.ratedBaseId) ||
      typeof row.raterName !== 'string' ||
      typeof row.ratedName !== 'string' ||
      !Number.isInteger(row.stars) ||
      (row.stars as number) < 1 ||
      (row.stars as number) > 5
    )
      return null;
    rows.push(row as RatingEvent);
  }
  const next = body.nextBefore;
  if (next !== null && typeof next !== 'string') return null;
  return { rows, nextBefore: next as string | null, asOf: body.asOf };
}

/** How many sparse pages the Ratings tab follows before it says the latest pages hold none. */
export const RATING_PAGES_MAX = 3;

/**
 * The newest rating events. The feed may answer an empty page with a continuation (its public
 * filters removed every candidate): up to RATING_PAGES_MAX pages are followed until a row shows
 * up. `exhausted` says the feed itself ended; otherwise only the pages read were empty.
 */
export async function loadRatingEvents(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<X3<RatingEvents & { exhausted: boolean }>> {
  let before: string | null = null;
  let last: RatingEvents | null = null;
  let stale = false;
  for (let page = 0; page < RATING_PAGES_MAX; page += 1) {
    const path: string = before
      ? `${X3_PATHS.ratingEvents}?before=${encodeURIComponent(before)}`
      : X3_PATHS.ratingEvents;
    const answer = await read(path, parseRatingEvents, fetcher, signal);
    // A page that does not answer makes the whole read unavailable, never an empty success.
    if (answer.state !== 'ok') return answer;
    last = answer.value;
    stale ||= answer.stale;
    if (last.rows.length || !last.nextBefore) break;
    before = last.nextBefore;
  }
  return { state: 'ok', value: { ...last!, exhausted: !last!.nextBefore }, stale };
}

// ---- per-agent metrics (#636) ----

export type AgentMetric = {
  baseId: string;
  /** null when the services snapshot is unknown: shown as "–", never 0. */
  offeredServices: {
    count: number;
    /** false: count is a lower bound. */
    exact: boolean;
    priceRangeRaw: PriceRange | null;
  } | null;
  paidCallsSold: { count: number; exact: boolean; window: string };
};

export function parseAgentMetrics(body: unknown): Map<string, AgentMetric> | null {
  if (!isObject(body) || !Array.isArray(body.rows)) return null;
  const metrics = new Map<string, AgentMetric>();
  for (const row of body.rows) {
    if (!isObject(row) || typeof row.baseId !== 'string' || !DECIMAL.test(row.baseId)) return null;
    const offered = row.offeredServices;
    if (offered !== null) {
      if (!isObject(offered) || !isCount(offered.count) || typeof offered.exact !== 'boolean')
        return null;
      const range = offered.priceRangeRaw;
      // The reviewed contract: USDC with 6 decimals, min <= max. Anything else is malformed,
      // never rendered (a hostile decimals value must not reach the formatter).
      if (
        range !== null &&
        (!isObject(range) ||
          typeof range.min !== 'string' ||
          !DECIMAL.test(range.min) ||
          typeof range.max !== 'string' ||
          !DECIMAL.test(range.max) ||
          range.asset !== 'USDC' ||
          range.decimals !== 6 ||
          BigInt(range.min) > BigInt(range.max))
      )
        return null;
    }
    const sold = row.paidCallsSold;
    if (
      !isObject(sold) ||
      !isCount(sold.count) ||
      typeof sold.exact !== 'boolean' ||
      typeof sold.window !== 'string'
    )
      return null;
    metrics.set(row.baseId, row as AgentMetric);
  }
  return metrics;
}

export const loadAgentMetrics = (
  baseIds: readonly string[],
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
) => {
  const ids = [...new Set(baseIds)].filter((id) => DECIMAL.test(id)).slice(0, 50);
  if (!ids.length)
    return Promise.resolve<X3<Map<string, AgentMetric>>>({
      state: 'ok',
      value: new Map(),
      stale: false,
    });
  return read(`${X3_PATHS.agentMetrics}?ids=${ids.join(',')}`, parseAgentMetrics, fetcher, signal);
};

/** "12", "1,000+" (a lower bound), or "–" when unknown. */
export function countText(value: { count: number; exact: boolean } | null | undefined): string {
  if (!value) return '–';
  return `${value.count.toLocaleString('en-US')}${value.exact ? '' : '+'}`;
}

/** "0.05 to 20 USDC" from raw amounts, or null. */
export type PriceRange = { min: string; max: string; asset: string; decimals: number };

export function priceRangeText(range: PriceRange | null): string | null {
  if (!range) return null;
  const unit = (raw: string) => {
    const scale = 10n ** BigInt(range.decimals);
    const whole = BigInt(raw) / scale;
    const frac = (BigInt(raw) % scale).toString().padStart(range.decimals, '0').replace(/0+$/, '');
    return `${whole.toLocaleString('en-US')}.${frac.padEnd(2, '0')}`;
  };
  const min = unit(range.min);
  const max = unit(range.max);
  return min === max ? `${min} ${range.asset}` : `${min} to ${max} ${range.asset}`;
}

// ---- counter history (#637) ----

export const HISTORY_METRICS = ['agents', 'base', 'finalizing', 'calls', 'ratings'] as const;
export type HistoryMetric = (typeof HISTORY_METRICS)[number];
export type HistoryPoint = { hour: number; value: number | null };
export type HistorySeries = {
  metric: HistoryMetric;
  points: HistoryPoint[];
  observedHours: number;
  /** When collection began for this metric; nothing before it is ever drawn. */
  collectionStart: number | null;
};

export function parseHistory(body: unknown): Map<HistoryMetric, HistorySeries> | null {
  if (!isObject(body) || !Array.isArray(body.series)) return null;
  const series = new Map<HistoryMetric, HistorySeries>();
  for (const entry of body.series) {
    if (
      !isObject(entry) ||
      !HISTORY_METRICS.includes(entry.metric as HistoryMetric) ||
      !Array.isArray(entry.points) ||
      !isCount(entry.observedHours) ||
      (entry.collectionStart !== null && !isCount(entry.collectionStart))
    )
      return null;
    const points: HistoryPoint[] = [];
    for (const point of entry.points) {
      if (
        !isObject(point) ||
        !isCount(point.hour) ||
        (point.value !== null && !isCount(point.value))
      )
        return null;
      points.push({ hour: point.hour, value: point.value as number | null });
    }
    series.set(entry.metric as HistoryMetric, {
      metric: entry.metric as HistoryMetric,
      points,
      observedHours: entry.observedHours,
      collectionStart: entry.collectionStart as number | null,
    });
  }
  return series;
}

export const loadHistory = (signal?: AbortSignal, fetcher: typeof fetch = fetch) =>
  read(X3_PATHS.history, parseHistory, fetcher, signal);

// ---- finalizing registrations and Base heads (#621) ----

/**
 * Base's three heads as Central City's node saw them: node observations, never proof that a
 * particular registration is final. Block numbers stay BigInt (no Number precision loss).
 */
export type Heads = { latest: bigint; safe: bigint; finalized: bigint; asOf: number };

/** `chainId`: the view's chain (Base mainnet by default); an answer for any other is malformed. */
export function parseHeads(body: unknown, chainId: number = 8453): Heads | null {
  if (!isObject(body) || body.chainId !== chainId || !isCount(body.asOf)) return null;
  const { latest, safe, finalized } = body;
  if (![latest, safe, finalized].every((v) => typeof v === 'string' && DECIMAL.test(v)))
    return null;
  const heads = {
    latest: BigInt(latest as string),
    safe: BigInt(safe as string),
    finalized: BigInt(finalized as string),
    asOf: body.asOf,
  };
  // Out of order is malformed, never shown: finalized <= safe <= latest.
  if (heads.finalized > heads.safe || heads.safe > heads.latest) return null;
  return heads;
}

export const loadHeads = (
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  chainId: number = 8453,
) => read(X3_PATHS.heads, (body) => parseHeads(body, chainId), fetcher, signal);

/** One page of waiting registrations, newest first; the On Base list's row shape. */
export type FinalizingPage = { rows: OnBaseRow[]; nextBefore: string | null; asOf: number };

const FINALIZING_CURSOR = /^(0|[1-9][0-9]{0,77})~[a-f0-9]{32}$/;

function parseFinalizingRow(row: unknown): OnBaseRow | null {
  if (
    !isObject(row) ||
    typeof row.baseId !== 'string' ||
    !DECIMAL.test(row.baseId) ||
    typeof row.name !== 'string' ||
    typeof row.owner !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(row.owner) ||
    typeof row.short !== 'string' ||
    !/^[0-9A-Za-z]{6}$/.test(row.short) ||
    (row.status !== 'finalizing' && row.status !== 'final') ||
    (row.finalizingSince !== undefined && !isCount(row.finalizingSince)) ||
    (row.mintTx !== undefined &&
      (typeof row.mintTx !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(row.mintTx)))
  )
    return null;
  return {
    baseId: row.baseId,
    name: row.name,
    owner: row.owner,
    short: row.short,
    status: row.status,
    ...(row.finalizingSince !== undefined
      ? { finalizingSince: row.finalizingSince as number }
      : {}),
    ...(row.mintTx !== undefined ? { mintTx: row.mintTx as string } : {}),
  };
}

/**
 * A page may hold no rows and still carry nextBefore (public listing rules removed every
 * candidate): only nextBefore null means the end. A malformed row makes the page malformed.
 */
export function parseFinalizing(body: unknown): FinalizingPage | null {
  if (!isObject(body) || !Array.isArray(body.rows) || !isCount(body.asOf)) return null;
  if (
    body.nextBefore !== null &&
    (typeof body.nextBefore !== 'string' || !FINALIZING_CURSOR.test(body.nextBefore))
  )
    return null;
  const rows: OnBaseRow[] = [];
  for (const entry of body.rows) {
    const row = parseFinalizingRow(entry);
    if (!row) return null;
    rows.push(row);
  }
  return { rows, nextBefore: body.nextBefore as string | null, asOf: body.asOf };
}

export const loadFinalizing = (
  before: string | null = null,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
) =>
  read(
    before ? `${X3_PATHS.finalizing}?before=${encodeURIComponent(before)}` : X3_PATHS.finalizing,
    parseFinalizing,
    fetcher,
    signal,
  );

/** A line needs at least this many observed hours; fewer draw nothing (the card says collecting). */
export const SPARKLINE_MIN_POINTS = 3;
/** The y-range is padded by at least this share of the largest value, so a near-flat total looks flat. */
export const SPARKLINE_MIN_PAD = 0.02;

/**
 * The polyline segments of a sparkline in a width x height box: one segment per run of observed
 * hours, broken at every missing hour (never interpolated), nothing before collectionStart;
 * every segment needs SPARKLINE_MIN_POINTS contiguous hours, a shorter run draws nothing.
 * The y-domain is [min - pad, max + pad] with pad >= SPARKLINE_MIN_PAD of max, never the bare
 * min..max: a total that moved by a few out of millions stays a flat line, not a full-height jump.
 * Empty with fewer than SPARKLINE_MIN_POINTS observed hours.
 */
export function sparklineSegments(series: HistorySeries, width: number, height: number): string[] {
  const start = series.collectionStart ?? Infinity;
  const points = series.points.map((point) =>
    point.hour + 3_600_000 <= start ? { ...point, value: null } : point,
  );
  const values = points.flatMap((point) => (point.value === null ? [] : [point.value]));
  if (values.length < SPARKLINE_MIN_POINTS) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(max * SPARKLINE_MIN_PAD, (max - min) * 0.1, 1);
  const low = Math.max(0, min - pad);
  const span = max + pad - low;
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((point, index) => {
    if (point.value === null) {
      if (current.length >= SPARKLINE_MIN_POINTS) segments.push(current.join(' '));
      current = [];
      return;
    }
    const x = (index * step).toFixed(1);
    const y = (height - ((point.value - low) / span) * height).toFixed(1);
    current.push(`${x},${y}`);
  });
  if (current.length >= SPARKLINE_MIN_POINTS) segments.push(current.join(' '));
  return segments;
}

// ---- typed search (#630) ----

/** One registration row of the typed search: the same shape as the On Base list's rows. */
export type SearchRow = {
  baseId: string;
  name: string;
  owner: string;
  short: string;
  status: 'final' | 'finalizing';
  [key: string]: unknown;
};
export type TypedSearchPage = { rows: SearchRow[]; nextBefore: string | null; asOf: number | null };

export function parseTypedSearch(body: unknown): TypedSearchPage | null {
  if (!isObject(body) || !Array.isArray(body.rows)) return null;
  const rows: SearchRow[] = [];
  for (const row of body.rows) {
    if (
      !isObject(row) ||
      typeof row.baseId !== 'string' ||
      !DECIMAL.test(row.baseId) ||
      typeof row.name !== 'string' ||
      typeof row.owner !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(row.owner) ||
      typeof row.short !== 'string' ||
      !/^[0-9A-Za-z]{6}$/.test(row.short) ||
      (row.status !== 'final' && row.status !== 'finalizing')
    )
      return null;
    rows.push(row as SearchRow);
  }
  const next = body.nextBefore;
  if (
    next !== null &&
    (typeof next !== 'string' || !/^(0|[1-9][0-9]{0,77})~[a-f0-9]{32}$/.test(next))
  )
    return null;
  return {
    rows,
    nextBefore: next as string | null,
    asOf: isCount(body.asOf) && body.asOf <= 8_640_000_000_000_000 ? body.asOf : null,
  };
}

/** How many sparse name pages one search follows before it offers "Load more". */
export const SEARCH_PAGES_MAX = 3;

/**
 * The typed search, from `before` (a continuation) or the start. A name page may come back empty
 * WITH a continuation (its candidates failed the public-name recheck): up to SEARCH_PAGES_MAX
 * pages are followed until a row shows up; nextBefore then says more may follow.
 */
export async function loadTypedSearch(
  kind: string,
  q: string,
  before: string | null = null,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<X3<TypedSearchPage>> {
  let cursor = before;
  let stale = false;
  let last: TypedSearchPage | null = null;
  let oldest: number | null | undefined;
  for (let page = 0; page < SEARCH_PAGES_MAX; page += 1) {
    const params = new URLSearchParams({ kind, q });
    if (cursor) params.set('before', cursor);
    const answer = await read(`${X3_PATHS.search}?${params}`, parseTypedSearch, fetcher, signal);
    if (answer.state !== 'ok') return answer;
    last = answer.value;
    oldest =
      oldest === undefined
        ? last.asOf
        : oldest === null || last.asOf === null
          ? null
          : Math.min(oldest, last.asOf);
    stale ||= answer.stale;
    if (last.rows.length || !last.nextBefore) break;
    cursor = last.nextBefore;
  }
  return { state: 'ok', value: { ...last!, asOf: oldest ?? null }, stale };
}
