/*
 * This instance's requests to Base endpoints, by purpose and endpoint, and the answers that said
 * "slow down": an HTTP 429, or a JSON-RPC rate-limit answer (busyRpcAnswer, also one inside an
 * HTTP 200). One log line a minute per instance, counts only: never a URL (the configured
 * endpoint's URL carries a key), an address or a parameter. It changes no behaviour; it shows how
 * close the CDP endpoint's limits are while many agents pay or register at once.
 */
import { busyRpcAnswer } from './transient.js';

export type RpcOutcome = 'ok' | 'http429' | 'busy' | 'failed';

export interface RpcCounts {
  requests: number;
  http429: number;
  busy: number;
  failed: number;
}

export const RPC_COUNT_WINDOW_MS = 60_000;

type Log = (line: string) => void;

let counts = new Map<string, RpcCounts>();
let windowStart = 0;
let log: Log = (line) => console.log(line);

/** Tests: where the minute line goes, and a fresh window. */
export function resetRpcCounts(to?: Log): void {
  counts = new Map();
  windowStart = 0;
  if (to) log = to;
}

/** Whether a failed request was the endpoint saying "not now" for its rate, or something else. */
export function rpcOutcome(error: unknown): Exclude<RpcOutcome, 'ok'> {
  let current: unknown = error;
  let busy = false;
  for (let depth = 0; current && depth < 6; depth++) {
    const e = current as {
      status?: unknown;
      code?: unknown;
      details?: unknown;
      message?: unknown;
      rejection?: unknown;
      cause?: unknown;
    };
    if (e.status === 429) return 'http429';
    if (typeof e.code === 'number') {
      const text =
        typeof e.details === 'string' ? e.details : typeof e.message === 'string' ? e.message : '';
      if (busyRpcAnswer(e.code, text)) busy = true;
    }
    if (e.rejection === 'busy') busy = true;
    current = e.cause;
  }
  return busy ? 'busy' : 'failed';
}

/** Counts one request; the first count after a full minute writes the last window's line. */
export function countRpc(key: string, outcome: RpcOutcome, now = Date.now()): void {
  if (windowStart === 0) windowStart = now;
  else if (now - windowStart >= RPC_COUNT_WINDOW_MS) {
    if (counts.size)
      log(
        JSON.stringify({
          event: 'base.rpc.count',
          windowSeconds: Math.round((now - windowStart) / 1000),
          counts: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))),
        }),
      );
    counts = new Map();
    windowStart = now;
  }
  let entry = counts.get(key);
  if (!entry) counts.set(key, (entry = { requests: 0, http429: 0, busy: 0, failed: 0 }));
  entry.requests += 1;
  if (outcome !== 'ok') entry[outcome] += 1;
}

/** An error answer is small; a larger body (logs, blocks) is never read twice. */
const PEEK_BYTES = 4_096;

/** Whether a small HTTP 200 body is a JSON-RPC rate-limit answer (one, or one in a batch). */
async function busyBody(response: Response): Promise<boolean> {
  const length = Number(response.headers.get('content-length'));
  if (!length || length > PEEK_BYTES) return false;
  try {
    const body = (await response.clone().json()) as unknown;
    return (Array.isArray(body) ? body : [body]).some((item) => {
      const error = (item as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      return (
        typeof error?.code === 'number' &&
        busyRpcAnswer(error.code, typeof error.message === 'string' ? error.message : '')
      );
    });
  } catch {
    return false;
  }
}

/**
 * A fetch for viem's http transport (`fetchFn`) that counts every HTTP attempt under `key`
 * ('purpose:endpoint'), retries included, and changes nothing about the answer.
 */
export function countingFetch(key: string, base: typeof fetch = (...args) => fetch(...args)) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let response: Response;
    try {
      response = await base(input, init);
    } catch (error) {
      countRpc(key, 'failed');
      throw error;
    }
    if (response.status === 429) countRpc(key, 'http429');
    else if (!response.ok) countRpc(key, 'failed');
    else countRpc(key, (await busyBody(response)) ? 'busy' : 'ok');
    return response;
  };
}
