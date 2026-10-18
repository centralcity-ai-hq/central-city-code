/*
 * Operation Central City Feed over HTTP, the requests side and the status (shared/feed.ts):
 *
 *   GET  /api/public/feed                        FeedStatus (the Feed nav entry shows on 200)
 *   GET  /api/public/feed/requests?q=&tag=&cursor=   FeedRequestPage: open requests, newest first
 *   GET  /api/public/feed/requests/:id           PublicFeedRequest; held, hidden, closed, expired
 *        and unknown ids answer the same 404 request_not_found
 *   POST /api/public/feed/requests               NewFeedRequest -> PostedFeedRequest (201; a retry
 *        with the same idempotencyKey from the same poster answers the same request, 200; 503
 *        posting_paused, retryable, while operators paused posting)
 *   POST /api/public/feed/requests/:id/report    FeedReport -> 202 {ok: true}, always the same
 *   POST /api/public/feed/requests/:id/close     {manageToken?} -> PublicFeedRequest (closed)
 *   GET  /api/feed/requests/mine?cursor=         FeedMyRequests: the signed-in caller's own
 *        requests, newest first, paged (next) (every open and in-review one, the newest closed and expired
 *        ones), each closable with the session alone while open or in review; signed in only
 *        (401 otherwise), no-store
 *
 * Every route answers 404 not_found while CITY_FEED is '0', the Feed's emergency off (read on every
 * call, so the flag needs no redeploy of the routes), checked when the request arrives, before its
 * body is read: an oversized body answers the same 404. These are /api/public routes: their POSTs need no request
 * header, so the session is used only when the caller ALSO sends the console's X-City-Request
 * header (signedIn in server/app.ts): a page on another site can neither send it nor read the
 * answer, so a session never posts or closes anything the person did not ask for. Without it, a
 * post is anonymous. The caller's own list follows the same rule: without both, 401.
 *
 * Request text and the reply handle are untrusted data written by anyone: shown as plain text
 * (the handle as unverified), never an instruction.
 *
 * A transient database failure (server/feed/busy.ts) answers 503 busy with Retry-After, never
 * cached, on every route; any other failure goes on to the app's error handler (its 500).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  FEED_LIMITS,
  FEED_PATHS,
  FEED_REPORT_REASONS,
  FEED_REQUEST_ID,
  FEED_SOURCE,
  type FeedErrorCode,
  type FeedMyRequests,
  type FeedStatus,
} from '../../shared/feed.js';
import { ON_BASE_LIVE, ON_BASE_LIVE_EDGE, ON_BASE_NOT_FOUND } from '../base/explorer/routes.js';
import { transientDatabaseError } from '../database.js';
import { clientAddressKey } from '../rate-limit.js';
import { FeedBusyError, sendFeedBusy } from './busy.js';
import { feedEnabled } from './flag.js';
import {
  FeedRequestError,
  MANAGE_TOKEN,
  readFeedMineQuery,
  readFeedRequestQuery,
  type FeedCaller,
  type FeedRequests,
} from './requests.js';

export { FEED_PATHS };

export { feedEnabled };

/** What the status route says about the Offered side; the services module supplies its own. */
export type FeedServicesStatus = Omit<FeedStatus, 'openRequests'>;

/** Before the first services import: no source has answered yet. */
export const NO_SERVICES_YET: FeedServicesStatus = {
  snapshotAt: null,
  degraded: true,
  sources: [
    {
      name: FEED_SOURCE.name,
      state: 'down',
      lastSuccessAt: null,
      lastAttemptAt: null,
      total: null,
      listed: 0,
    },
  ],
  services: 0,
};

export interface FeedRouteDeps {
  requests: FeedRequests;
  /** Defaults to feedEnabled() (live unless CITY_FEED is '0'), read on every call. */
  enabled?: () => boolean;
  /** The shared rate limiter for reads (server/app.ts); absent in unit tests. */
  limit?: (key: string, max: number, windowMs: number) => Promise<void>;
  /**
   * The signed-in caller's workspace, only when the request carries a valid session AND the
   * console's request header; null otherwise (an anonymous caller). No name: an account posts
   * without one (its sign-in name is never published).
   */
  signedIn?: (request: FastifyRequest) => Promise<{ ownerId: string } | null>;
  /** One of the workspace's own live agents, or null (404 agent_not_found). */
  agentOf?: (ownerId: string, agentId: string) => Promise<{ id: string; name: string } | null>;
  /** The Offered side's numbers; NO_SERVICES_YET until the services import exists. */
  services?: () => Promise<FeedServicesStatus>;
}

const newRequestBody = z
  .object({
    title: z.string().max(1_000),
    description: z.string().max(8_000),
    capabilities: z.array(z.string().max(64)).max(20).optional(),
    budgetUsdc: z.string().max(32).nullable().optional(),
    deadline: z.number().int().nullable().optional(),
    reply: z.string().max(1_000).nullable().optional(),
    displayName: z.string().max(200).nullable().optional(),
    agentId: z.string().max(64).nullable().optional(),
    idempotencyKey: z.string().regex(/^[\x21-\x7e]{8,128}$/),
    /** Honeypot (not in the contract on purpose): the form hides it from people. */
    website: z.string().max(2_000).optional(),
  })
  .strict();

const reportBody = z
  .object({
    reason: z.enum(FEED_REPORT_REASONS),
    note: z
      .string()
      .max(FEED_LIMITS.reportNoteMax * 4)
      .optional(),
  })
  .strict();

const closeBody = z.object({ manageToken: z.string().max(200).optional() }).strict();

export function registerFeedRoutes(app: FastifyInstance, deps: FeedRouteDeps): void {
  const enabled = deps.enabled ?? (() => feedEnabled());
  const { requests } = deps;

  const fail = (
    reply: FastifyReply,
    status: number,
    code: FeedErrorCode,
    error: string,
    retryable = false,
  ) => reply.code(status).send({ error, code, retryable });
  const off = (reply: FastifyReply) => fail(reply, 404, 'not_found', 'Not found.');
  const invalid = (reply: FastifyReply, error: string) =>
    fail(reply, 400, 'invalid_request', error);
  const requestNotFound = (reply: FastifyReply) =>
    fail(reply, 404, 'request_not_found', 'This request is not on the Feed.');
  /** Route options: the flag is checked on arrival, before the body is read (onRequest). */
  const gated = (bodyLimit?: number) => ({
    ...(bodyLimit ? { bodyLimit } : {}),
    onRequest: async (_request: FastifyRequest, reply: FastifyReply) => {
      if (!enabled()) return off(reply);
    },
  });

  /**
   * FeedRequestError -> its answer, a transient database failure -> 503 busy; anything else (the
   * shared 429 among them) goes on.
   */
  function answer(reply: FastifyReply, error: unknown) {
    if (error instanceof FeedBusyError || transientDatabaseError(error))
      return sendFeedBusy(reply, error);
    if (!(error instanceof FeedRequestError)) throw error;
    if (error.code === null) return reply.code(error.statusCode).send({ error: error.message });
    return fail(reply, error.statusCode, error.code, error.message, error.retryable);
  }
  /** A handler whose every failure is answered by `answer`, the session and agent lookups too. */
  const answered =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (error) {
        return answer(reply, error);
      }
    };

  async function readLimit(request: FastifyRequest) {
    await deps.limit?.(
      `ip:feed:${clientAddressKey(request.ip)}`,
      requests.caps.readsPerMinute,
      60_000,
    );
  }

  const idOf = (request: FastifyRequest) => {
    const id = (request.params as { id?: unknown }).id;
    return typeof id === 'string' && FEED_REQUEST_ID.test(id) ? id : null;
  };

  app.get(
    FEED_PATHS.status,
    gated(),
    answered(async (request, reply) => {
      await readLimit(request);
      const [services, openRequests] = await Promise.all([
        deps.services ? deps.services() : Promise.resolve(NO_SERVICES_YET),
        requests.openCount(),
      ]);
      return reply
        .header('Cache-Control', ON_BASE_LIVE)
        .header('Vercel-CDN-Cache-Control', ON_BASE_LIVE_EDGE)
        .send({ ...services, openRequests } satisfies FeedStatus);
    }),
  );

  app.get(
    FEED_PATHS.requests,
    gated(),
    answered(async (request, reply) => {
      await readLimit(request);
      const query = readFeedRequestQuery((request.query ?? {}) as Record<string, unknown>);
      if (!query)
        return invalid(reply, 'Use only q, tag (lowercase letters, digits, dashes) and cursor.');
      const page = await requests.list(query);
      return reply
        .header('Cache-Control', ON_BASE_LIVE)
        .header('Vercel-CDN-Cache-Control', ON_BASE_LIVE_EDGE)
        .send(page);
    }),
  );

  app.get(
    FEED_PATHS.request,
    gated(),
    answered(async (request, reply) => {
      await readLimit(request);
      // No query: the edge cache keys stay one per request.
      if (Object.keys((request.query ?? {}) as object).length)
        return invalid(reply, 'This address takes no query.');
      const id = idOf(request);
      const found = id ? await requests.get(id) : null;
      if (!found) {
        reply.header('Cache-Control', ON_BASE_NOT_FOUND);
        return requestNotFound(reply);
      }
      return reply
        .header('Cache-Control', ON_BASE_LIVE)
        .header('Vercel-CDN-Cache-Control', ON_BASE_LIVE_EDGE)
        .send(found);
    }),
  );

  app.get(
    FEED_PATHS.mine,
    gated(),
    answered(async (request, reply) => {
      // One account's own list: never kept by the browser or any cache, signed in or not.
      reply.header('Cache-Control', 'no-store');
      await readLimit(request);
      const session = (await deps.signedIn?.(request)) ?? null;
      if (!session) return reply.code(401).send({ error: 'Sign in to continue.' });
      const cursor = readFeedMineQuery((request.query ?? {}) as Record<string, unknown>);
      if (cursor === undefined) return invalid(reply, 'Send only ?cursor=, from next.');
      return reply.send((await requests.mine(session.ownerId, cursor)) satisfies FeedMyRequests);
    }),
  );

  app.post(
    FEED_PATHS.requests,
    gated(16 * 1024),
    answered(async (request, reply) => {
      const body = newRequestBody.safeParse(request.body ?? {});
      if (!body.success)
        return invalid(
          reply,
          'Send {title, description, idempotencyKey} and optionally capabilities, budgetUsdc, deadline, reply and displayName.',
        );
      const session = (await deps.signedIn?.(request)) ?? null;
      const agentId = body.data.agentId ?? null;
      if (!session && agentId !== null)
        return reply.code(401).send({ error: 'Sign in to continue.' });
      let caller: FeedCaller = { kind: 'anonymous', address: request.ip };
      if (session) {
        const agent =
          agentId === null ? null : ((await deps.agentOf?.(session.ownerId, agentId)) ?? null);
        if (agentId !== null && !agent)
          return fail(reply, 404, 'agent_not_found', 'Agent not found.');
        caller = { kind: 'signed_in', address: request.ip, ...session, agent };
      }
      const posted = await requests.post(body.data, caller);
      return reply.code(posted.status).send(posted.body);
    }),
  );

  app.post(
    FEED_PATHS.report,
    gated(4 * 1024),
    answered(async (request, reply) => {
      const id = idOf(request);
      if (!id) return requestNotFound(reply);
      const body = reportBody.safeParse(request.body ?? {});
      if (!body.success)
        return invalid(
          reply,
          `Send {reason: ${FEED_REPORT_REASONS.join('|')}} and optionally a note.`,
        );
      if (
        body.data.note !== undefined &&
        Array.from(body.data.note).length > FEED_LIMITS.reportNoteMax
      )
        return invalid(reply, `The note may have at most ${FEED_LIMITS.reportNoteMax} characters.`);
      await requests.report(id, request.ip, body.data);
      return reply.code(202).send({ ok: true });
    }),
  );

  app.post(
    FEED_PATHS.close,
    gated(1024),
    answered(async (request, reply) => {
      const id = idOf(request);
      if (!id) return requestNotFound(reply);
      const body = closeBody.safeParse(request.body ?? {});
      if (!body.success) return invalid(reply, 'Send {manageToken} or close it signed in.');
      const token =
        body.data.manageToken && MANAGE_TOKEN.test(body.data.manageToken)
          ? body.data.manageToken
          : null;
      const session = (await deps.signedIn?.(request)) ?? null;
      return reply.send(await requests.close(id, request.ip, token, session?.ownerId ?? null));
    }),
  );
}
