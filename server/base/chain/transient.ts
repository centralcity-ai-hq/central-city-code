/*
 * Whether a failed call to Base (the CDP node endpoint, the bundler) is the network saying "not
 * now": a 429 rate limit, a timeout, a 5xx from the endpoint, a dropped connection, or a JSON-RPC
 * error that says it is a rate limit (also one sent inside an HTTP 200, which rpc-bundler
 * classifies as 'busy'). Seen in production while many registrations polled at once: the endpoint
 * answered 429 and the register route turned it into a generic 500. Callers that can answer from
 * what is already stored (nothing concluded, nothing sent) treat these as transient; anything else
 * is a real error. The error and its causes are walked, never their URLs logged (the endpoint URL
 * carries a key).
 */
const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_NAMES = new Set(['TimeoutError']);
const TRANSIENT_MESSAGE =
  /\b429\b|too many requests|rate limit|request timed out|timeout|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i;

/** Text that says the request was refused for its rate. */
const RATE_LIMITED = /rate.?limit|too many requests|\b429\b|throttl|requests? per (second|minute)/i;
/** The standard text of -32002: the resource is not available right now. */
const RESOURCE_UNAVAILABLE = /resource (is )?(temporarily )?(unavailable|not available)/i;
/** A limit that is not a rate (a paymaster's spending policy, a gas limit, a denial): never busy. */
const OTHER_LIMIT = /spend|policy|gas limit|denied/i;

/**
 * Whether a JSON-RPC error (its numeric code and the upstream text) says "not now":
 *   - 429 (a gateway's HTTP status inside the JSON-RPC error) and -32005 (limit exceeded);
 *   - -32002 (resource unavailable) only with rate-limit or resource-unavailable text;
 *   - -32603 (internal error) only with clear rate-limit text.
 * Never when the text names another limit: a paymaster refusing its policy ("max spend limit
 * exceeded for policy", "request denied") or a gas limit ("gas limit exceeded") is a real error,
 * and asking again would never help. Bare "limit exceeded" or "capacity" text is not enough.
 */
export function busyRpcAnswer(code: number, text: string): boolean {
  if (OTHER_LIMIT.test(text)) return false;
  if (code === 429 || code === -32005) return true;
  if (code === -32002) return RATE_LIMITED.test(text) || RESOURCE_UNAVAILABLE.test(text);
  if (code === -32603) return RATE_LIMITED.test(text);
  return false;
}

export function transientChainError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    const e = current as {
      name?: unknown;
      status?: unknown;
      code?: unknown;
      message?: unknown;
      details?: unknown;
      rejection?: unknown;
      cause?: unknown;
    };
    if (typeof e.status === 'number' && TRANSIENT_HTTP.has(e.status)) return true;
    // A JSON-RPC error from the node (viem keeps the node's own text in `details`; its message
    // starts with a generic sentence for the code, which says nothing about why).
    if (typeof e.code === 'number') {
      const text =
        typeof e.details === 'string' ? e.details : typeof e.message === 'string' ? e.message : '';
      if (busyRpcAnswer(e.code, text)) return true;
    }
    if (typeof e.name === 'string' && TRANSIENT_NAMES.has(e.name)) return true;
    if (typeof e.message === 'string' && TRANSIENT_MESSAGE.test(e.message)) return true;
    // A bundler/paymaster JSON-RPC error inside an HTTP 200 that rpc-bundler classified as busy
    // (busyRpcAnswer): its upstream text is not kept, only this classification.
    if (e.rejection === 'busy') return true;
    current = e.cause;
  }
  return false;
}
