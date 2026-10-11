/*
 * Operation Rating R1 over HTTP (service: rate/service.ts). Registered by the wallet routes, behind
 * CITY_BASE_WALLET and CITY_BASE_RATE (404 while either is off), on the wallet network only.
 *
 *   POST .../wallet/ratings/lookup  200 RateTarget for {baseId, passport}, checked at one block
 *   POST .../wallet/ratings         201 the rating operation to sign
 *   GET  .../wallet/ratings/status  200 {enabled: true} (404 while ratings are off)
 *   GET  .../wallet/ratings         200 RatingsGiven: the ratings this agent's wallet made
 *
 * (... is /api/base/agents/:agentId.) The lookup and create paths and bodies are
 * shared/base/rate.ts (RATE_PATHS, RateLookup, RateTarget, RateToAgent, RatingsGiven), the file the
 * browser uses. The list reads our records only, never Base.
 * :agentId is the rating agent; only its wallet's owner account may look up or rate with it (else
 * 404, as for withdrawals and payments). Signing, status and cancel of a rating are the withdrawal
 * routes of its withdrawalId. Writes go through the console's request guard in server/app.ts.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RATE_PATHS } from '../../../shared/base/rate.js';
import { WithdrawalError } from '../wallet/withdrawals.js';
import { retryable } from '../wallet/withdraw-routes.js';
import { RateError, type RateService } from './service.js';

export { RATE_PATHS };

/** GET: {enabled: true} for the rater's owner while ratings are on; 404 while they are off. */
export const RATE_STATUS_PATH = '/api/base/agents/:agentId/wallet/ratings/status';

export interface RateRouteDeps {
  /** Both the wallet routes and ratings are on. */
  enabled(): boolean;
  /** The signed-in person account, or the status to answer with (401 / 404). */
  person(
    request: FastifyRequest,
  ): Promise<{ ok: true; accountId: string } | { ok: false; code: number }>;
  service: RateService;
  /** The shared rate limiter (server/app.ts); absent in unit tests. */
  limit?: (key: string, max: number, windowMs: number) => Promise<void>;
}

/**
 * Per person, each its own bucket, as Pay's: a lookup reads Base and stores a lookup; a rating
 * reads Base and prepares an operation. The 100-a-day cap is the service's (rate/service.ts).
 */
export const RATE_RATES = {
  lookup: { prefix: 'rate-lookup', max: 30, windowMs: 60_000 },
  create: { prefix: 'rate-create', max: 20, windowMs: 60_000 },
} as const;

const params = z.object({ agentId: z.string().uuid() });

export function registerRateRoutes(app: FastifyInstance, deps: RateRouteDeps) {
  const limited = (rate: (typeof RATE_RATES)[keyof typeof RATE_RATES], accountId: string) =>
    deps.limit?.(`${rate.prefix}:${accountId}`, rate.max, rate.windowMs);
  const failure = (reply: FastifyReply, error: unknown) => {
    if (error instanceof RateError || error instanceof WithdrawalError)
      return (
        reply
          .code(error.status)
          // The facts also under `details` when there are any, where the client's ApiError reads
          // them (e.g. the daily max). An error that already says its own `details` (a wallet's
          // too_many_open or sponsor_busy, as the withdrawal routes answer it) keeps them as they are.
          .send({
            ...error.detail,
            ...(Object.keys(error.detail).length && !('details' in error.detail)
              ? { details: error.detail }
              : {}),
            error: error.message,
            code: error.code,
          })
      );
    // A lock wait the database broke: nothing was done, the request can simply be tried again.
    if (retryable(error))
      return reply.code(503).send({
        error: 'Busy for a moment; nothing was done. Try again.',
        code: 'retry',
        details: { retryAfterSeconds: 1 },
      });
    throw error;
  };

  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    rate: (typeof RATE_RATES)[keyof typeof RATE_RATES] | null,
    status: number,
    action: (accountId: string, agentId: string) => Promise<unknown>,
  ) {
    if (!deps.enabled()) return reply.code(404).send({ error: 'Not found.' });
    const person = await deps.person(request);
    if (!person.ok) return reply.code(person.code).send({ error: 'Not found.' });
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'Not found.' });
    if (rate) await limited(rate, person.accountId);
    try {
      return reply.code(status).send(await action(person.accountId, parsed.data.agentId));
    } catch (error) {
      return failure(reply, error);
    }
  }

  app.post(RATE_PATHS.lookup, (request, reply) =>
    handle(request, reply, RATE_RATES.lookup, 200, (accountId, agentId) =>
      deps.service.lookup(accountId, agentId, request.body ?? {}),
    ),
  );

  // Off is 404 like every other rating route (the browser reads a 404 as "ratings are off").
  app.get(RATE_STATUS_PATH, (request, reply) =>
    handle(request, reply, null, 200, (accountId, agentId) =>
      deps.service.status(accountId, agentId),
    ),
  );

  // Read-only and from our records: no Base read, so no bucket of its own (as status).
  app.get(RATE_PATHS.ratings, (request, reply) =>
    handle(request, reply, null, 200, (accountId, agentId) =>
      deps.service.given(accountId, agentId),
    ),
  );

  app.post(RATE_PATHS.ratings, (request, reply) =>
    handle(request, reply, RATE_RATES.create, 201, (accountId, agentId) =>
      deps.service.create(accountId, agentId, request.body ?? {}),
    ),
  );
}
