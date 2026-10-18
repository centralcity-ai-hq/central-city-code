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
 * blocked site data) simply means no stored value.
 */

export const AGENT_COUNT_URL = '/api/public/stats';
export const AGENT_COUNT_STORAGE_KEY = 'cc-agent-count';
/** The shared poll, while the tab is visible (the response is fresh 15 s at the edge). */
export const STATS_POLL_MS = 15_000;
/**
 * Until a first load succeeds, a failed one is retried after this, doubling up to STATS_POLL_MS:
 * a phone whose first request fails (or is cut off while the page is briefly hidden as it opens
 * from a search result) gets its numbers in about a second, not one full poll later.
 */
export const STATS_FIRST_RETRY_MS = 1_000;
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

/** One stats response: the counts, the response's Age header and when it arrived. */
export interface StatsResponse {
  agents: AgentCount | null;
  paid: PaidCalls | null;
  /** The Base agents number (`base_agents`), when the server sent it. */
  base: BaseAgents | null;
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

let fromBuild: AgentCount | null = null;
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
 * Reads the number from the prerendered ticker (`data-build-count`, `data-build-at`), once,
 * before the app mounts (src/main.tsx). A page without one (the build had no count) has none.
 */
export function captureBuildAgentCount(root: ParentNode): void {
  const node = root.querySelector('[data-agent-ticker][data-build-count]');
  const total = Number(node?.getAttribute('data-build-count') || NaN);
  const at = Date.parse(node?.getAttribute('data-build-at') ?? '');
  setBuildAgentCount(Number.isSafeInteger(total) && Number.isFinite(at) ? { total, at } : null);
}

/**
 * The build's number while it is still the one on screen: from the prerender to the first
 * ticker the app mounts. A later landing view in the same page load (client navigation) no
 * longer starts from it.
 */
export function prerenderedAgentCount(): AgentCount | null {
  return buildShown ? null : fromBuild;
}

/** The first ticker has mounted over the prerendered one. */
export function markPrerenderedAgentCountShown(): void {
  buildShown = true;
}
