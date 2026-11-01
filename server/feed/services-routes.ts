/*
 * Operation Central City Feed, slice 1 (Offered) over HTTP (query.ts answers; shared/feed.ts is the
 * contract the browser and the AI tool use). The status route (FEED_PATHS.status) belongs to the
 * requests slice (server/feed/routes.ts), which takes feedServicesStatus (query.ts) for its Offered
 * numbers.
 *
 *   GET /api/public/feed/services        ?q=&cursor=&max_price=&sort=&host= -> FeedServicePage
 *   GET /api/public/feed/services/:id    FeedServiceDetail (a withdrawn one within its tombstone)
 *
 * Public (signed out too), live unless CITY_FEED is '0' (read per request): switched off every
 * route answers 404 not_found. Rate limited per client address under its own prefix (ip:feed:),
 * with the directory search's budget. Answers are cached briefly (FEED_CACHE); errors never are.
 *
 * Errors are FeedError {error, code, retryable}: 400 invalid_request (an unreadable max_price, one
 * over FEED_USDC_TEXT_MAX among them: a price filter is never loosened silently; a query key the
 * route does not take, so the edge cache cannot be skipped with a made-up one), 404 service_not_found (unknown, hidden or long
 * withdrawn: one answer), 409 cursor_stale and 503 source_unavailable (both retryable; no list is
 * ever answered as an empty success before the first complete sweep), and 503 busy (retryable,
 * Retry-After) for a transient database failure (server/feed/busy.ts). Anything else goes on to
 * the app's error handler (its 500).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  canonicalFeedServiceSearch,
  FEED_ERRORS,
  FEED_LIMITS,
  FEED_PATHS,
  FEED_USDC_TEXT_MAX,
  feedServiceQueryRefusal,
  readFeedServiceQuery,
  type FeedError,
  type FeedErrorCode,
} from '../../shared/feed.js';
import { transientDatabaseError, type Database } from '../database.js';
import { clientAddressKey } from '../rate-limit.js';
import { ON_BASE_RATE } from '../base/explorer/routes.js';
import { sendFeedBusy } from './busy.js';
import { feedEnabled } from './flag.js';
import { FeedQueryError, feedServiceDetail, searchFeedServices } from './query.js';

export { FEED_PATHS, feedEnabled };

/** Public and short-lived: a sweep changes the listings at most every few hours. */
/**
 * The list and detail are the same for everyone, so the edge serves repeats for two minutes
 * (s-maxage) and briefly while it refreshes: a page of the list ranks every listed record, and
 * full-list paging at launch put that work on the database once per request. Kept short so a
 * page from before a new sweep (its cursor then answers cursor_stale) lives at most ~3 minutes.
 */
export const FEED_CACHE = 'public, max-age=60, s-maxage=120, stale-while-revalidate=60';
/** Per client address, the directory search's budget. */
export const FEED_RATE = ON_BASE_RATE;

export interface FeedServiceRouteDeps {
  db: Database;
  /** Where CITY_FEED is read, per request (server/app.ts passes process.env). */
  env: Record<string, string | undefined>;
  /** The shared rate limiter (server/app.ts); absent in unit tests. */
  limit?: (key: string, max: number, windowMs: number) => Promise<void>;
  now?: () => number;
}

export function feedError(code: FeedErrorCode, error: string): FeedError {
  return {
    error,
    code,
    retryable: code === 'cursor_stale' || code === 'source_unavailable' || code === 'busy',
  };
}

const sendError = (reply: FastifyReply, code: FeedErrorCode, error: string) =>
  reply.code(FEED_ERRORS[code]).header('Cache-Control', 'no-store').send(feedError(code, error));

export function registerFeedServiceRoutes(app: FastifyInstance, deps: FeedServiceRouteDeps): void {
  const now = deps.now ?? Date.now;

  /**
   * Off: 404 not_found and nothing else happens. On: a query the route does not take is answered
   * (`refused`) before the limiter and the database; otherwise the request is charged to its
   * address.
   */
  async function admitted(
    request: FastifyRequest,
    reply: FastifyReply,
    refused: (request: FastifyRequest, reply: FastifyReply) => boolean,
  ): Promise<boolean> {
    if (!feedEnabled(deps.env)) {
      sendError(reply, 'not_found', 'Not found.');
      return false;
    }
    if (refused(request, reply)) return false;
    await deps.limit?.(
      `ip:feed:${clientAddressKey(request.ip)}`,
      FEED_RATE.max,
      FEED_RATE.windowMs,
    );
    return true;
  }

  /**
   * A query error as its FeedError, a transient database failure as 503 busy; anything else goes
   * to the app's error handler.
   */
  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof FeedQueryError) return sendError(reply, error.code, error.message);
    if (transientDatabaseError(error)) return sendFeedBusy(reply, error);
    throw error;
  };

  /**
   * The edge cache keys by the whole URL, so only the list's own keys and values are taken (400
   * otherwise: feedServiceQueryRefusal), and any spelling but the canonical one
   * (canonicalFeedServiceSearch) is sent on to it (307), before the limiter and the database.
   */
  const listQueryRefused = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const refusal = feedServiceQueryRefusal(query);
    if (refusal) {
      sendError(reply, 'invalid_request', refusal);
      return true;
    }
    if (
      query.fresh !== undefined &&
      (typeof query.fresh !== 'string' || !/^[0-9]{1,15}$/.test(query.fresh))
    ) {
      sendError(reply, 'invalid_request', 'fresh must be a time in milliseconds.');
      return true;
    }
    // Any other spelling of the same query (another key order, spaces around q, 0.50 for 0.5, an
    // unrounded fresh, an empty value, a stray '&' or '?') is sent on to the one canonical URL.
    const canonical = canonicalFeedServiceSearch(query);
    if (canonical === null) return false; // an unreadable max_price: 400 below
    const mark = request.url.indexOf('?');
    if ((mark < 0 ? '' : request.url.slice(mark)) === canonical) return false;
    reply
      .code(307)
      .header('Cache-Control', 'no-store')
      .header('Location', `${mark < 0 ? request.url : request.url.slice(0, mark)}${canonical}`)
      .send();
    return true;
  };
  /**
   * The detail takes no query: its edge entries stay one per service. A bare '?' or stray '&'
   * (no key at all) is refused too: it is another edge cache entry.
   */
  const detailQueryRefused = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!request.url.includes('?')) return false;
    sendError(reply, 'invalid_request', 'This address takes no query.');
    return true;
  };

  app.get(FEED_PATHS.services, async (request, reply) => {
    if (!(await admitted(request, reply, listQueryRefused))) return reply;
    const query = readFeedServiceQuery((request.query ?? {}) as Record<string, unknown>);
    if (!query)
      return sendError(
        reply,
        'invalid_request',
        `max_price must be a USDC amount from 0 to ${FEED_USDC_TEXT_MAX} with at most 6 decimals, for example 0.05.`,
      );
    try {
      const page = await searchFeedServices(deps.db, query, {
        limit: FEED_LIMITS.pageSize,
        now: now(),
      });
      return reply.header('Cache-Control', FEED_CACHE).send(page);
    } catch (error) {
      return failed(reply, error);
    }
  });

  app.get(FEED_PATHS.service, async (request, reply) => {
    if (!(await admitted(request, reply, detailQueryRefused))) return reply;
    const { id } = (request.params ?? {}) as { id?: unknown };
    try {
      const detail = typeof id === 'string' ? await feedServiceDetail(deps.db, id, now()) : null;
      if (!detail) return sendError(reply, 'service_not_found', 'Service not found.');
      return reply.header('Cache-Control', FEED_CACHE).send(detail);
    } catch (error) {
      return failed(reply, error);
    }
  });
}
