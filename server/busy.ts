/*
 * The app's answer to a transient database failure on any route the Feed's own busy answer
 * (server/feed/busy.ts) does not cover: no free pool connection in time, a statement or lock
 * timeout, too many connections, a serialization conflict or deadlock, a lost connection
 * (transientDatabaseError in server/database.ts). These say "not now", never "wrong": 503 busy
 * instead of the plain 500. Retryable (with Retry-After) only for a GET or HEAD. A write may have
 * committed part of its work before the failure, even when the failing statement itself never
 * reached the database (statement A done, no connection for statement B): 503 not retryable, no
 * Retry-After, so the caller checks before doing it again. Any other failure keeps the app's 500.
 */
import type { FastifyReply } from 'fastify';

/** Seconds a busy answer asks the caller to wait before trying again. */
export const DATABASE_BUSY_RETRY_AFTER_S = 5;
export const DATABASE_BUSY_MESSAGE = 'Busy. Try again in a moment.';
/** A write that may or may not have been done: the caller checks before doing it again. */
export const DATABASE_BUSY_UNSURE_MESSAGE =
  'Busy. This may or may not have been done: check before trying again.';

/** At most one busy log line per route and failure code in this window (ms). */
export const DATABASE_BUSY_LOG_EVERY_MS = 60_000;

const lastLogged = new Map<string, number>();
const suppressed = new Map<string, number>();

/** Test hook: forget the log throttle. */
export function forgetDatabaseBusyLog() {
  lastLogged.clear();
  suppressed.clear();
}

/** A database code fit for the log: a SQLSTATE or a socket code, never the message. */
function failureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^([0-9A-Z]{5}|E[A-Z]{2,20})$/.test(code)) return code;
  return 'pool';
}

/**
 * One JSON line per route and code per minute (the app runs without a request logger), so a wave
 * of busy answers shows in the logs with its route. The route is its pattern (ids stay out); no
 * address, no query string, no message.
 */
function logBusy(reply: FastifyReply, error: unknown, retryable: boolean) {
  const route = reply.request?.routeOptions?.url ?? 'unrouted';
  const code = failureCode(error);
  const key = `${route} ${code}`;
  const now = Date.now();
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < DATABASE_BUSY_LOG_EVERY_MS) {
    suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
    return;
  }
  lastLogged.set(key, now);
  const skipped = suppressed.get(key) ?? 0;
  suppressed.delete(key);
  console.warn(JSON.stringify({ event: 'db.busy', code, route, retryable, suppressed: skipped }));
}

/**
 * 503 busy. Never cached, by the browser or the edge (an edge cache header a handler set before it
 * failed is dropped): a stored 503 would keep answering busy after the database recovered.
 * Retry-After and retryable only for reads (see above).
 */
export function sendDatabaseBusy(reply: FastifyReply, error?: unknown) {
  const method = reply.request?.method;
  const retryable = method === 'GET' || method === 'HEAD';
  logBusy(reply, error, retryable);
  reply.code(503).removeHeader('Vercel-CDN-Cache-Control').header('Cache-Control', 'no-store');
  if (!retryable)
    // No Retry-After at all, even one a handler set before it failed: nothing says try again.
    return reply
      .removeHeader('Retry-After')
      .send({ error: DATABASE_BUSY_UNSURE_MESSAGE, code: 'busy', retryable: false });
  return reply
    .header('Retry-After', String(DATABASE_BUSY_RETRY_AFTER_S))
    .send({ error: DATABASE_BUSY_MESSAGE, code: 'busy', retryable: true });
}
