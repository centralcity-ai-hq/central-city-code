/*
 * The Feed's answer to a transient database failure (transientDatabaseError in
 * server/database.ts: no free pool connection in time, a statement or lock timeout, too many
 * connections, a serialization conflict or deadlock, a lost connection). Under load these say
 * "not now", never "wrong", so every Feed route (the ops review routes too) answers 503 busy
 * (retryable, with Retry-After) instead of the app's plain 500, and the city_service_search and
 * city_request_search tools a retryable busy error. Any other failure keeps the app's 500 and its
 * log.
 */
import type { FastifyReply } from 'fastify';
import { FEED_BUSY_MESSAGE, FEED_ERRORS, type FeedError } from '../../shared/feed.js';

/** Seconds a busy answer asks the caller to wait before trying again. */
export const FEED_BUSY_RETRY_AFTER_S = 5;
/**
 * Seconds a text search past its own time limit asks for: the same words may be slow every time,
 * so callers wait longer than for a moment of load before they repeat them.
 */
export const FEED_SEARCH_BUSY_RETRY_AFTER_S = 30;
/** At most one busy log line per route and failure code in this window (ms). */
export const FEED_BUSY_LOG_EVERY_MS = 60_000;

/** Busy with its own wait: thrown by the Feed where a plain transient failure is not enough. */
export class FeedBusyError extends Error {
  constructor(
    readonly retryAfterS: number,
    /** The database code behind it, for the log line. */
    readonly failure: unknown,
  ) {
    super(FEED_BUSY_MESSAGE);
  }
}

/** A database code fit for the log: a SQLSTATE or a socket code, never the message. */
function failureCode(error: unknown): string {
  const inner = error instanceof FeedBusyError ? error.failure : error;
  const code = (inner as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^([0-9A-Z]{5}|E[A-Z]{2,20})$/.test(code)) return code;
  return 'pool';
}

const lastLogged = new Map<string, number>();
const suppressed = new Map<string, number>();

/** Test hook: forget the log throttle. */
export function forgetFeedBusyLog() {
  lastLogged.clear();
  suppressed.clear();
}

/**
 * One JSON line per route and code per minute (the app runs without a request logger): a query
 * that is slow every time shows up as a steady line instead of silent busy answers. The route is
 * its pattern (ids stay out); no address, no query string, no message.
 */
function logBusy(reply: FastifyReply, error: unknown) {
  const route = reply.request?.routeOptions?.url ?? 'unrouted';
  const code = failureCode(error);
  const key = `${route} ${code}`;
  const now = Date.now();
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < FEED_BUSY_LOG_EVERY_MS) {
    suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
    return;
  }
  lastLogged.set(key, now);
  const skipped = suppressed.get(key) ?? 0;
  suppressed.delete(key);
  console.warn(JSON.stringify({ event: 'feed.busy', code, route, suppressed: skipped }));
}

/**
 * 503 busy with Retry-After. Never cached, by the browser or the edge (an edge cache header a
 * handler set before it failed is dropped): a stored 503 would keep answering busy after the
 * database recovered.
 */
export function sendFeedBusy(reply: FastifyReply, error?: unknown) {
  logBusy(reply, error);
  const retryAfterS = error instanceof FeedBusyError ? error.retryAfterS : FEED_BUSY_RETRY_AFTER_S;
  return reply
    .code(FEED_ERRORS.busy)
    .removeHeader('Vercel-CDN-Cache-Control')
    .header('Cache-Control', 'no-store')
    .header('Retry-After', String(retryAfterS))
    .send({ error: FEED_BUSY_MESSAGE, code: 'busy', retryable: true } satisfies FeedError);
}

/**
 * Feed paths: the public ones, the status route included; the signed-in console ones under
 * /api/feed/ (the caller's own requests, Respond); and the operators' review routes (review.ts).
 * Not /api/public/feedback or the like.
 */
export function isFeedPath(url: string) {
  const path = url.split('?')[0]!;
  return (
    path === '/api/public/feed' ||
    path.startsWith('/api/public/feed/') ||
    path.startsWith('/api/feed/') ||
    path === '/api/ops/feed' ||
    path.startsWith('/api/ops/feed/')
  );
}
