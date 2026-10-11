/*
 * The homepage agent count's data, kept out of AgentTicker so the entry chunk can start the
 * request at startup (prefetchAgentCount, from Root's prefetchInitialScreen) in parallel with the
 * session check and the landing chunk, instead of after both. AgentTicker takes that response
 * for its first value and shows the last number this browser saw (localStorage) until it
 * arrives. Only the public number and its time are stored; any storage failure (private mode,
 * blocked site data) simply means no stored value.
 */

export const AGENT_COUNT_URL = '/api/public/stats';
export const AGENT_COUNT_STORAGE_KEY = 'cc-agent-count';
/** A prefetched response older than this is not used (the ticker fetches its own). */
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

export function fetchAgentCount(signal?: AbortSignal): Promise<AgentCount | null> {
  return fetch(AGENT_COUNT_URL, {
    credentials: 'omit',
    headers: { accept: 'application/json' },
    signal,
  }).then(async (response) => (response.ok ? parseAgentCount(await response.json()) : null));
}

let prefetched: { started: number; value: Promise<AgentCount | null> } | null = null;

/** Starts the count request now; the ticker's first load takes it (once). */
export function prefetchAgentCount(): void {
  if (prefetched) return;
  const value = fetchAgentCount();
  // Unhandled here on purpose: the ticker handles it, or nobody needs it.
  value.catch(() => undefined);
  prefetched = { started: Date.now(), value };
}

/** The prefetched response, once, while it is recent; else null. */
export function takePrefetchedAgentCount(): Promise<AgentCount | null> | null {
  const entry = prefetched;
  prefetched = null;
  if (!entry || Date.now() - entry.started > PREFETCH_MAX_AGE_MS) return null;
  return entry.value;
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
