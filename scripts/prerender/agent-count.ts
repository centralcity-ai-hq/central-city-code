import {
  parseAgentCount,
  parseBaseAgents,
  parsePaidCalls,
  type AgentCount,
} from '../../src/agentCount';

/*
 * The homepage agent count for the prerendered HTML, read ONCE per build (vite.config.ts
 * `shareCards`), so crawlers and visitors without JavaScript see a real number. Nothing here
 * runs per request: the number is written into the static index.html, and the client's
 * AgentTicker takes over from it and keeps it live (src/agentCount.ts).
 *
 * The same response says whether the live line under it shows (`paid_calls` or `base_agents` with
 * a total of at least 1): the build then reserves its empty line (`data-paid-calls="1"`) so the
 * pill fills it with no layout shift. Neither number is ever baked into the HTML.
 *
 * Never fails the build: an unreachable endpoint, a slow answer (BUILD_AGENT_COUNT_TIMEOUT_MS), an
 * error status or a body that is not a count all give null, and the page is built exactly as
 * before (the ticker's empty, reserved line, filled by the client).
 *
 * Environment:
 * - CC_BUILD_AGENT_COUNT: a fixed count to use instead of fetching (tests, offline builds). A
 *   positive integer is used as is; `0`, `off` or anything else that is not a positive integer
 *   builds with no count. No request is made when it is set.
 * - CC_BUILD_PAID_CALLS: with CC_BUILD_AGENT_COUNT set (no request), `1` reserves the paid service
 *   calls line; anything else, or unset, does not.
 * - CC_BUILD_AGENT_COUNT_URL: the stats endpoint to read (default: production's public one).
 */

export const BUILD_AGENT_COUNT_URL = 'https://centralcity.ai/api/public/stats';
export const BUILD_AGENT_COUNT_TIMEOUT_MS = 5_000;

export interface BuildAgentCountOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** The time a fixed count (CC_BUILD_AGENT_COUNT) is dated with. */
  now?: () => number;
  warn?: (message: string) => void;
}

/** What the landing is built with: the agent count, and whether the paid calls line is reserved. */
export interface BuildHomeStats {
  count: AgentCount | null;
  paidCalls: boolean;
}

export async function fetchBuildAgentCount(
  options: BuildAgentCountOptions = {},
): Promise<AgentCount | null> {
  return (await fetchBuildHomeStats(options)).count;
}

export async function fetchBuildHomeStats(
  options: BuildAgentCountOptions = {},
): Promise<BuildHomeStats> {
  const env = options.env ?? process.env;
  const warn = options.warn ?? console.warn;
  const fixed = env.CC_BUILD_AGENT_COUNT?.trim();
  if (fixed !== undefined && fixed !== '') {
    const paidCalls = env.CC_BUILD_PAID_CALLS?.trim() === '1';
    const total = /^\d+$/.test(fixed) ? Number(fixed) : NaN;
    if (!Number.isSafeInteger(total) || total <= 0) return { count: null, paidCalls };
    return { count: { total, at: (options.now ?? Date.now)() }, paidCalls };
  }
  const url = env.CC_BUILD_AGENT_COUNT_URL?.trim() || BUILD_AGENT_COUNT_URL;
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? BUILD_AGENT_COUNT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The timeout covers the whole exchange (headers and body), and wins even against a fetch
  // that ignores its signal.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const body = await Promise.race([
      (async () => {
        const response = await doFetch(url, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`status ${response.status}`);
        return (await response.json()) as unknown;
      })(),
      timeout,
    ]);
    const count = parseAgentCount(body);
    const paid = parsePaidCalls(body);
    const base = parseBaseAgents(body);
    const paidCalls = (paid !== null && paid.total >= 1) || (base !== null && base.total >= 1);
    if (!count || count.total <= 0) {
      warn(`agent count: ${url} gave no usable count; the landing is built without one`);
      return { count: null, paidCalls };
    }
    return { count, paidCalls };
  } catch (error) {
    warn(
      `agent count: ${url} failed (${error instanceof Error ? error.message : String(error)}); the landing is built without one`,
    );
    return { count: null, paidCalls: false };
  } finally {
    clearTimeout(timer);
  }
}
