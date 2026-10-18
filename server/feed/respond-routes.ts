/*
 * Feed Respond over HTTP (server/feed/respond.ts; the paths are FEED_RESPOND_PATHS in
 * shared/feed.ts):
 *
 *   POST /api/feed/requests/:id/respond               FeedRespond -> FeedResponseSent (201; the
 *        same idempotencyKey answers the same response and room, 200)
 *   GET  /api/feed/requests/:id/responses/count       FeedResponseCount (the poster only)
 *   GET  /api/feed/requests/:id/responses/mine        {responses: FeedResponseSent[]}
 *   POST /api/feed/request-invitations/:id/withdraw   FeedResponseSent (withdrawn)
 *
 * The poster answers in the owner invitations inbox (rooms/invitations-routes.ts). These are
 * console routes, not /api/public: a write needs the session AND the console's request header
 * (the root guard in server/app.ts), so a page on another site can never respond for someone.
 * Every route answers 404 not_found while the Feed is switched off (CITY_FEED=0, read per request,
 * before the body is read). Refusals answer {error, code, retryable}; 429 answers the shared
 * {error} shape with Retry-After, as the other Feed limits do. A transient database failure (the session lookup
 * included) answers 503 busy with Retry-After, as on every Feed route (busy.ts).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../shared/types.js';
import { FEED_RESPOND_PATHS } from '../../shared/feed.js';
import { transientDatabaseError } from '../database.js';
import { clientAddressKey } from '../rate-limit.js';
import { RoomError, type RoomPrincipal } from '../rooms/service.js';
import { FeedBusyError, sendFeedBusy } from './busy.js';
import { feedEnabled } from './flag.js';
import type { FeedRespond } from './respond.js';

export { FEED_RESPOND_PATHS };

export interface FeedRespondRouteDeps {
  respond: FeedRespond;
  /** The workspace the console request acts in (401 when signed out). */
  owner(request: FastifyRequest): Promise<Operator>;
  originOf(request: FastifyRequest): string;
  /** Defaults to feedEnabled() (live unless CITY_FEED is '0'), read on every call. */
  enabled?: () => boolean;
}

export function registerFeedRespondRoutes(app: FastifyInstance, d: FeedRespondRouteDeps): void {
  const enabled = d.enabled ?? (() => feedEnabled());
  const gated = (bodyLimit?: number) => ({
    ...(bodyLimit ? { bodyLimit } : {}),
    onRequest: async (_request: FastifyRequest, reply: FastifyReply) => {
      if (!enabled())
        return reply.code(404).send({ error: 'Not found.', code: 'not_found', retryable: false });
    },
  });
  const principal = async (request: FastifyRequest): Promise<RoomPrincipal> => ({
    operatorId: (await d.owner(request)).id,
    actor: 'the owner',
    origin: d.originOf(request),
    console: true,
    address: clientAddressKey(request.ip),
  });
  const idOf = (request: FastifyRequest) => {
    const id = (request.params as { id?: unknown }).id;
    return typeof id === 'string' ? id : '';
  };

  /**
   * The service's refusals in the Feed's shape, a transient database failure 503 busy; anything
   * else (the shared 429 among them) goes on.
   */
  async function answer<T>(reply: FastifyReply, run: () => Promise<T>) {
    try {
      return await run();
    } catch (error) {
      if (error instanceof FeedBusyError || transientDatabaseError(error))
        return sendFeedBusy(reply, error);
      if (error instanceof z.ZodError)
        return reply.code(400).send({
          error: error.issues[0]?.message?.startsWith('Send ')
            ? error.issues[0].message
            : 'Send {roomId or newRoom: true, fromAgentId, note, idempotencyKey}.',
          code: 'invalid_request',
          retryable: false,
        });
      if (!(error instanceof RoomError)) throw error;
      if (error.statusCode === 429) {
        if (typeof error.retryAfterMs === 'number')
          reply.header('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
        return reply.code(429).send({ error: error.message });
      }
      return reply
        .code(error.statusCode)
        .send({ error: error.message, code: error.errorCode, retryable: false });
    }
  }

  app.post(FEED_RESPOND_PATHS.respond, gated(8 * 1024), async (request, reply) => {
    return answer(reply, async () => {
      const p = await principal(request);
      const { created, response } = await d.respond.send(p, idOf(request), request.body ?? {});
      return reply.code(created ? 201 : 200).send(response);
    });
  });
  app.get(FEED_RESPOND_PATHS.count, gated(), async (request, reply) => {
    return answer(reply, async () => d.respond.count(await principal(request), idOf(request)));
  });
  app.get(FEED_RESPOND_PATHS.mine, gated(), async (request, reply) => {
    return answer(reply, async () => ({
      responses: await d.respond.mine(await principal(request), idOf(request)),
    }));
  });
  app.post(FEED_RESPOND_PATHS.withdraw, gated(1024), async (request, reply) => {
    return answer(reply, async () => d.respond.withdraw(await principal(request), idOf(request)));
  });
}
