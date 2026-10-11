/*
 * Whether a failed call to Base (the CDP node endpoint, the bundler) is the network saying "not
 * now": a 429 rate limit, a timeout, a 5xx from the endpoint, a dropped connection, or a JSON-RPC
 * "limit exceeded". Seen in production while many registrations polled at once: the endpoint
 * answered 429 and the register route turned it into a generic 500. Callers that can answer from
 * what is already stored (nothing concluded, nothing sent) treat these as transient; anything else
 * is a real error. The error and its causes are walked, never their URLs logged (the endpoint URL
 * carries a key).
 */
const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
/** JSON-RPC: limit exceeded (-32005), and the resource-unavailable/busy codes nodes use. */
const TRANSIENT_RPC = new Set([-32005, -32002, -32603]);
const TRANSIENT_NAMES = new Set([
  'TimeoutError',
  'LimitExceededRpcError',
  'ResourceUnavailableRpcError',
]);
const TRANSIENT_MESSAGE =
  /\b429\b|too many requests|rate limit|request timed out|timeout|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i;

export function transientChainError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    const e = current as {
      name?: unknown;
      status?: unknown;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof e.status === 'number' && TRANSIENT_HTTP.has(e.status)) return true;
    if (typeof e.code === 'number' && TRANSIENT_RPC.has(e.code)) return true;
    if (typeof e.name === 'string' && TRANSIENT_NAMES.has(e.name)) return true;
    if (typeof e.message === 'string' && TRANSIENT_MESSAGE.test(e.message)) return true;
    current = e.cause;
  }
  return false;
}
