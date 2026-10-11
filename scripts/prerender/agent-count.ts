import { parseAgentCount, type AgentCount } from '../../src/agentCount';

/*
 * The homepage agent count for the prerendered HTML, read ONCE per build (vite.config.ts
 * `shareCards`), so crawlers and visitors without JavaScript see a real number. Nothing here
 * runs per request: the number is written into the static index.html, and the client's
 * AgentTicker takes over from it and keeps it live (src/agentCount.ts).
 *
 * Never fails the build: an unreachable endpoint, a slow answer (BUILD_AGENT_COUNT_TIMEOUT_MS), an
 * error status or a body that is not a count all give null, and the page is built exactly as
 * before (the ticker's empty, reserved line, filled by the client).
 *
 * Environment:
 * - CC_BUILD_AGENT_COUNT: a fixed count to use instead of fetching (tests, offline builds). A
 *   positive integer is used as is; `0`, `off` or anything else that is not a positive integer
 *   builds with no count. No request is made when it is set.
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

export async function fetchBuildAgentCount(
  options: BuildAgentCountOptions = {},
): Promise<AgentCount | null> {
  const env = options.env ?? process.env;
  const warn = options.warn ?? console.warn;
  const fixed = env.CC_BUILD_AGENT_COUNT?.trim();
  if (fixed !== undefined && fixed !== '') {
    const total = /^\d+$/.test(fixed) ? Number(fixed) : NaN;
    if (!Number.isSafeInteger(total) || total <= 0) return null;
    return { total, at: (options.now ?? Date.now)() };
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
    const count = await Promise.race([
      (async () => {
        const response = await doFetch(url, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`status ${response.status}`);
        return parseAgentCount(await response.json());
      })(),
      timeout,
    ]);
    if (!count || count.total <= 0) {
      warn(`agent count: ${url} gave no usable count; the landing is built without one`);
      return null;
    }
    return count;
  } catch (error) {
    warn(
      `agent count: ${url} failed (${error instanceof Error ? error.message : String(error)}); the landing is built without one`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
