import { PAID_CALLS_RECENT_MAX } from '../shared/paid-calls';

/*
 * The homepage counts' data (GET /api/public/stats): the AI agents that joined and, when the
 * server sends them, the paid service calls (`paid_calls`, shared/paid-calls.ts) and the Base
 * agents (`base_agents`, server/stats/base-agents.ts). Kept out of the
 * tickers so the entry chunk can start the request at startup (prefetchAgentCount, from Root's
 * prefetchInitialScreen) in parallel with the session check and the landing chunk, instead of
 * after both.
 *
 * One shared poller (subscribeStats) feeds every ticker on the page (AgentTicker,
 * PaidCallsTicker): one request every STATS_POLL_MS while the tab is visible, none while it is
 * hidden, whatever the number of tickers. Its first load takes the prefetched response.
 *
 * AgentTicker shows the last number this browser saw (localStorage) until the first response
 * arrives. Only the public number and its time are stored; any storage failure (private mode,
 * blocked site data) simply means no stored value. The homepage's other live numbers (value
 * settled, paid service calls, Base agents) are kept the same way under their own key
 * (LIVE_NUMBERS_STORAGE_KEY), so a returning visitor sees the last known numbers at once instead
 * of a dash.
 */

export const AGENT_COUNT_URL = '/api/public/stats';
export const AGENT_COUNT_STORAGE_KEY = 'cc-agent-count';
/** The homepage's other live numbers, last seen by this browser (readStoredLiveNumbers). */
export const LIVE_NUMBERS_STORAGE_KEY = 'cc-live-numbers';
/** The shared poll, while the tab is visible (the response is fresh 15 s at the edge). */
export const STATS_POLL_MS = 15_000;
/**
 * Until a first load succeeds, a failed one is retried after this, doubling up to STATS_POLL_MS:
 * a phone whose first request fails (or is cut off while the page is briefly hidden as it opens
 * from a search result) gets its numbers in about a second, not one full poll later.
 */
export const STATS_FIRST_RETRY_MS = 1_000;
/**
 * An answer that leaves out a number (paid_calls, its value_settled_raw, or base_agents: a cold
 * server instance, cached at the edge for only a couple of seconds) is read again sooner: after
 * this, then twice as long, PARTIAL_RETRIES times, then at the normal poll. A known number is never
 * blanked meanwhile (a missing field keeps it). A full answer resets the count; a server that
 * leaves a field out for good (switched off) costs only these few extra reads per page view.
 */
export const STATS_PARTIAL_RETRY_MS = 2_000;
export const STATS_PARTIAL_RETRIES = 2;

/** Whether a stats answer leaves out any of the homepage's numbers. */
export function statsIncomplete(stats: Pick<StatsResponse, 'paid' | 'base'>): boolean {
  return !stats.paid || stats.paid.valueRaw === null || !stats.base;
}

/**
 * The wait before the next load after an answer: sooner while answers come in incomplete
 * (`partial` incomplete answers in a row, this one included), else the normal poll.
 */
export function nextStatsDelay(partial: number, pollMs: number): number {
  if (partial < 1 || partial > STATS_PARTIAL_RETRIES) return pollMs;
  return Math.min(pollMs, STATS_PARTIAL_RETRY_MS * 2 ** (partial - 1));
}

/** A prefetched response older than this is not used (the poller fetches its own). */
const PREFETCH_MAX_AGE_MS = 10_000;

export interface AgentCount {
  total: number;
  /** updated_at of the response, in epoch ms. */
  at: number;
}

export function parseAgentCount(value: unknown): AgentCount | null {
  if (!value || typeof value !== 'object') return null;
  const { ai_agents_total: total, updated_at: updated } = value as Record<string, unknown>;
  const at = typeof updated === 'string' ? Date.parse(updated) : NaN;
  if (!Number.isSafeInteger(total) || (total as number) < 0 || !Number.isFinite(at)) return null;
  return { total: total as number, at };
}

/** The paid service calls, as the client reads the optional `paid_calls` field. */
export interface PaidCalls {
  total: number;
  /** `as_of`, epoch ms (the server's clock). */
  asOf: number;
  /** Milliseconds from each recent payment's block to `as_of`, newest first. */
  recentMs: number[];
  /** False when more recent payments may exist than are listed. */
  recentComplete: boolean;
  /** Total value settled, USDC base units as decimal text (`value_settled_raw`); null if absent. */
  valueRaw: string | null;
}

/** The `paid_calls` field of a stats response, or null when it is missing or not readable. */
export function parsePaidCalls(value: unknown): PaidCalls | null {
  if (!value || typeof value !== 'object') return null;
  const field = (value as Record<string, unknown>).paid_calls;
  if (!field || typeof field !== 'object') return null;
  const {
    total,
    as_of: asOfText,
    recent_ms: recentMs,
    recent_complete: recentComplete,
    value_settled_raw: valueSettledRaw,
  } = field as Record<string, unknown>;
  const asOf = typeof asOfText === 'string' ? Date.parse(asOfText) : NaN;
  if (!Number.isSafeInteger(total) || (total as number) < 0 || !Number.isFinite(asOf)) return null;
  const recent = Array.isArray(recentMs)
    ? recentMs
        .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0)
        .slice(0, Math.min(PAID_CALLS_RECENT_MAX, total as number))
    : [];
  return {
    total: total as number,
    asOf,
    recentMs: recent,
    recentComplete: recentComplete !== false,
    valueRaw:
      typeof valueSettledRaw === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(valueSettledRaw)
        ? valueSettledRaw
        : null,
  };
}

/** The Base agents number, as the client reads the optional `base_agents` field. */
export interface BaseAgents {
  total: number;
  /** `as_of`, epoch ms (when the server counted it). */
  asOf: number;
}

/** The `base_agents` field of a stats response, or null when it is missing or not readable. */
export function parseBaseAgents(value: unknown): BaseAgents | null {
  if (!value || typeof value !== 'object') return null;
  const field = (value as Record<string, unknown>).base_agents;
  if (!field || typeof field !== 'object') return null;
  const { total, as_of: asOfText } = field as Record<string, unknown>;
  const asOf = typeof asOfText === 'string' ? Date.parse(asOfText) : NaN;
  if (!Number.isSafeInteger(total) || (total as number) < 0 || !Number.isFinite(asOf)) return null;
  return { total: total as number, asOf };
}

/** Growth per second of the public numbers (`value` in USDC base units). */
export interface StatsRates {
  agents?: number;
  paid?: number;
  base?: number;
  valueRaw?: number;
}

/** The optional `rates` field: only finite, non-negative numbers are kept. */
export function parseStatsRates(value: unknown): StatsRates {
  const field =
    value && typeof value === 'object' ? (value as Record<string, unknown>).rates : null;
  if (!field || typeof field !== 'object') return {};
  const read = (key: string) => {
    const n = (field as Record<string, unknown>)[key];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const out: StatsRates = {};
  const agents = read('ai_agents');
  const paid = read('paid_calls');
  const base = read('base_agents');
  const valueRaw = read('value_settled_raw');
  if (agents !== undefined) out.agents = agents;
  if (paid !== undefined) out.paid = paid;
  if (base !== undefined) out.base = base;
  if (valueRaw !== undefined) out.valueRaw = valueRaw;
  return out;
}

/** One stats response: the counts, the response's Age header and when it arrived. */
export interface StatsResponse {
  agents: AgentCount | null;
  paid: PaidCalls | null;
  /** The Base agents number (`base_agents`), when the server sent it. */
  base: BaseAgents | null;
  /** Growth per second of each number, where the server knows it (`rates`); else empty. */
  rates?: StatsRates;
  /** The edge's Age header in seconds (0 when missing). */
  ageS: number;
  /** Date.now() when the response arrived. */
  arrived: number;
}

/** GET /api/public/stats; null for an error status. */
export function fetchStats(signal?: AbortSignal): Promise<StatsResponse | null> {
  return fetch(AGENT_COUNT_URL, {
    credentials: 'omit',
    headers: { accept: 'application/json' },
    signal,
  }).then(async (response) => {
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    const age = Number(response.headers.get('age') ?? 0);
    return {
      agents: parseAgentCount(body),
      paid: parsePaidCalls(body),
      base: parseBaseAgents(body),
      rates: parseStatsRates(body),
      ageS: Number.isFinite(age) && age > 0 ? age : 0,
      arrived: Date.now(),
    };
  });
}

export function fetchAgentCount(signal?: AbortSignal): Promise<AgentCount | null> {
  return fetchStats(signal).then((stats) => stats?.agents ?? null);
}

let prefetched: { started: number; value: Promise<StatsResponse | null> } | null = null;

/** Starts the stats request now; the shared poller's first load takes it (once). */
export function prefetchAgentCount(): void {
  if (prefetched) return;
  const value = fetchStats();
  // Unhandled here on purpose: the poller handles it, or nobody needs it.
  value.catch(() => undefined);
  prefetched = { started: Date.now(), value };
}

/** The prefetched response, once, while it is recent; else null. */
export function takePrefetchedStats(): Promise<StatsResponse | null> | null {
  const entry = prefetched;
  prefetched = null;
  if (!entry || Date.now() - entry.started > PREFETCH_MAX_AGE_MS) return null;
  return entry.value;
}

/**
 * A ticker's view of each load: the response, or null when this load failed (an error status,
 * offline, an unreadable body). A load stopped because the tab was hidden reports nothing.
 */
export type StatsListener = (stats: StatsResponse | null) => void;

const listeners = new Set<StatsListener>();
let stopPoller: (() => void) | null = null;
let latest: StatsResponse | null = null;

function deliver(listener: StatsListener, stats: StatsResponse | null) {
  try {
    listener(stats);
  } catch {
    // One ticker's failure never stops the others.
  }
}

/**
 * Subscribes to the shared poller; returns the unsubscribe. The first subscriber starts it (its
 * first load at once), the last one to leave stops it. A subscriber joining a running poller
 * gets its latest response at once.
 */
export function subscribeStats(listener: StatsListener): () => void {
  listeners.add(listener);
  if (stopPoller) {
    if (latest) deliver(listener, latest);
  } else stopPoller = startPoller(STATS_POLL_MS);
  return () => {
    if (!listeners.delete(listener) || listeners.size) return;
    stopPoller?.();
    stopPoller = null;
    latest = null;
  };
}

function startPoller(pollMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let lastFetch = 0;
  let stopped = false;
  let first = true;
  /** No load has succeeded yet: failures retry sooner and a return to view loads at once. */
  let pending = true;
  let retryMs = STATS_FIRST_RETRY_MS;
  /** Incomplete answers in a row (statsIncomplete): read again sooner, a bounded few times. */
  let partial = 0;
  const schedule = (delay: number) => {
    clearTimeout(timer);
    if (!stopped && !document.hidden) timer = setTimeout(load, delay);
  };
  async function load() {
    clearTimeout(timer);
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    lastFetch = Date.now();
    let stats: StatsResponse | null = null;
    try {
      // The first load takes the request the entry chunk started at startup, when there is one.
      const early = first ? takePrefetchedStats() : null;
      first = false;
      stats = await (early ?? fetchStats(mine.signal));
    } catch {
      // Offline or aborted: keep the last numbers and try again on the next tick.
      stats = null;
    } finally {
      if (controller === mine) {
        controller = null;
        if (stats && !stopped && !mine.signal.aborted) pending = false;
        if (pending && !mine.signal.aborted) {
          schedule(Math.min(retryMs, pollMs));
          retryMs *= 2;
        } else if (stats) {
          partial = statsIncomplete(stats) ? partial + 1 : 0;
          schedule(nextStatsDelay(partial, pollMs));
        } else schedule(pollMs);
      }
    }
    if (stopped || mine.signal.aborted) return;
    if (stats) latest = stats;
    for (const listener of [...listeners]) deliver(listener, stats);
  }
  function onVisibility() {
    if (document.hidden) {
      clearTimeout(timer);
      controller?.abort();
      return;
    }
    const since = Date.now() - lastFetch;
    if (pending || since >= pollMs) void load();
    else schedule(pollMs - since);
  }
  void load();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/**
 * Whether the homepage reserves the paid calls line before its first response: once a response
 * has said (a shown count or none), that; before, what the build saw (data-paid-calls="1" in the
 * prerendered HTML, scripts/prerender/agent-count.ts). No number is ever baked into the HTML.
 */
let paidLineFromBuild = false;
let paidLineSeen: boolean | null = null;

export function setBuildPaidCallsLine(reserved: boolean): void {
  paidLineFromBuild = reserved;
  paidLineSeen = null;
}

/** Reads the build's reserved line (`data-paid-calls="1"`) before the app mounts (src/main.tsx). */
export function captureBuildPaidCallsLine(root: ParentNode): void {
  setBuildPaidCallsLine(
    Boolean(root.querySelector('[data-paid-calls-ticker][data-paid-calls="1"]')),
  );
}

export function reservePaidCallsLine(): boolean {
  return paidLineSeen ?? paidLineFromBuild;
}

/**
 * Whether the Feed head keeps the chip's place before its first response: yes, unless a response
 * on this page already said there is no count (switched off, or nothing counted yet).
 */
export function reservePaidCallsChip(): boolean {
  return paidLineSeen !== false;
}

/** A response said whether there is a count to show. */
export function notePaidCallsLine(shown: boolean): void {
  paidLineSeen = shown;
}

export function readStoredAgentCount(): AgentCount | null {
  try {
    const raw = window.localStorage.getItem(AGENT_COUNT_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { total?: unknown; at?: unknown };
    if (!Number.isSafeInteger(value.total) || (value.total as number) <= 0) return null;
    if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
    return { total: value.total as number, at: value.at };
  } catch {
    return null;
  }
}

export function storeAgentCount(count: AgentCount): void {
  try {
    window.localStorage.setItem(AGENT_COUNT_STORAGE_KEY, JSON.stringify(count));
  } catch {
    // Storage unavailable: the next visit simply waits for the response.
  }
}

/**
 * The homepage's live numbers other than the agent count, as this browser last saw them. Each
 * field is kept with the time of the answer that carried it, and a field one answer left out
 * keeps its stored value (storeLiveNumbers merges). A validated zero is kept like any number: it
 * was a real answer (a correction), and showing an older, higher number instead would be wrong.
 */
export interface StoredLiveNumbers {
  paid: { total: number; at: number } | null;
  base: { total: number; at: number } | null;
  /** Total value settled, USDC base units as decimal text (like PaidCalls.valueRaw). */
  value: { raw: string; at: number } | null;
}

const EMPTY_LIVE_NUMBERS: StoredLiveNumbers = { paid: null, base: null, value: null };

function storedCount(value: unknown): { total: number; at: number } | null {
  if (!value || typeof value !== 'object') return null;
  const { total, at } = value as { total?: unknown; at?: unknown };
  if (!Number.isSafeInteger(total) || (total as number) < 0) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  return { total: total as number, at };
}

function storedValue(value: unknown): { raw: string; at: number } | null {
  if (!value || typeof value !== 'object') return null;
  const { raw, at } = value as { raw?: unknown; at?: unknown };
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(raw)) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  return { raw, at };
}

/** The stored live numbers; every field null when nothing is stored or storage fails. */
export function readStoredLiveNumbers(): StoredLiveNumbers {
  try {
    const raw = window.localStorage.getItem(LIVE_NUMBERS_STORAGE_KEY);
    if (!raw) return EMPTY_LIVE_NUMBERS;
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== 'object') return EMPTY_LIVE_NUMBERS;
    return {
      paid: storedCount(value.paid),
      base: storedCount(value.base),
      value: storedValue(value.value),
    };
  } catch {
    return EMPTY_LIVE_NUMBERS;
  }
}

/**
 * Keeps the numbers one stats answer carried. A field the answer left out keeps what is stored;
 * a stored field from a later answer than this one (another tab) is never replaced by it.
 */
export function storeLiveNumbers(stats: Pick<StatsResponse, 'paid' | 'base'>): void {
  const stored = readStoredLiveNumbers();
  const newer = <T extends { at: number }>(next: T | null, kept: T | null) =>
    next && (!kept || next.at >= kept.at) ? next : kept;
  const next: StoredLiveNumbers = {
    paid: newer(stats.paid ? { total: stats.paid.total, at: stats.paid.asOf } : null, stored.paid),
    base: newer(stats.base ? { total: stats.base.total, at: stats.base.asOf } : null, stored.base),
    value: newer(
      stats.paid?.valueRaw ? { raw: stats.paid.valueRaw, at: stats.paid.asOf } : null,
      stored.value,
    ),
  };
  if (!next.paid && !next.base && !next.value) return;
  try {
    window.localStorage.setItem(LIVE_NUMBERS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the next visit starts from the build's numbers or a dash.
  }
}

let fromBuild: AgentCount | null = null;
let baseFromBuild: BaseAgents | null = null;
let buildShown = false;

/**
 * The count the build put into the landing's HTML (scripts/prerender/agent-count.ts): set by
 * the prerender (src/prerender.tsx) before it renders, and in the browser by
 * captureBuildAgentCount before React replaces the prerendered markup.
 */
export function setBuildAgentCount(count: AgentCount | null): void {
  fromBuild = count && Number.isSafeInteger(count.total) && count.total > 0 ? count : null;
  buildShown = false;
}

/**
 * The Base agents number the build put into the landing's HTML, like the agent count: set by the
 * prerender before it renders and in the browser by captureBuildAgentCount. Only a positive
 * number is baked (a 0 in the HTML would read as broken, and is never shown before an answer).
 */
export function setBuildBaseAgents(base: BaseAgents | null): void {
  baseFromBuild =
    base && Number.isSafeInteger(base.total) && base.total > 0 && Number.isFinite(base.asOf)
      ? base
      : null;
}

/**
 * Reads the number from the prerendered ticker (`data-build-count`, `data-build-at`), once,
 * before the app mounts (src/main.tsx). A page without one (the build had no count) has none.
 * The Base agents cell's build number (`data-build-base`, `data-build-base-at`) is read with it.
 */
export function captureBuildAgentCount(root: ParentNode): void {
  const node = root.querySelector('[data-agent-ticker][data-build-count]');
  const total = Number(node?.getAttribute('data-build-count') || NaN);
  const at = Date.parse(node?.getAttribute('data-build-at') ?? '');
  setBuildAgentCount(Number.isSafeInteger(total) && Number.isFinite(at) ? { total, at } : null);
  const baseNode = root.querySelector('[data-stat="base"][data-build-base]');
  const base = Number(baseNode?.getAttribute('data-build-base') || NaN);
  const baseAt = Date.parse(baseNode?.getAttribute('data-build-base-at') ?? '');
  setBuildBaseAgents(
    Number.isSafeInteger(base) && Number.isFinite(baseAt) ? { total: base, asOf: baseAt } : null,
  );
}

/**
 * The build's number while it is still the one on screen: from the prerender to the first
 * ticker the app mounts. A later landing view in the same page load (client navigation) no
 * longer starts from it.
 */
export function prerenderedAgentCount(): AgentCount | null {
  return buildShown ? null : fromBuild;
}

/** The build's Base agents number while the prerendered markup is the one on screen. */
export function prerenderedBaseAgents(): BaseAgents | null {
  return buildShown ? null : baseFromBuild;
}

/** The first ticker has mounted over the prerendered one. */
export function markPrerenderedAgentCountShown(): void {
  buildShown = true;
}
