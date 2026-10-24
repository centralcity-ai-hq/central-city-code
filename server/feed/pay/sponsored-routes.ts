/*
 * The sponsored first purchase's routes (server/feed/pay/sponsored.ts), apart from the Feed pay
 * call so that path is left exactly as it is:
 *
 *   POST /api/feed/services/:id/sponsored-call   an owner buys a hosted service for one of its
 *                                                agents with the agent's credit (never charged)
 *   GET  /api/feed/sponsored-calls/:callId        that call, for its owner
 *   GET  /api/feed/sponsored-credit               the owner's agents' credits and the services they cover
 *   GET  /api/cron/sfp-work                       the worker and stale-reservation sweep (CRON_SECRET),
 *                                                runs also while new starts are off
 *
 * Signed-in owner session (the same person check as Feed pay); 404 while Feed pay or the sponsored
 * purchase is off. A refused credit answers 402 credit_unavailable with its reason.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { transientDatabaseError } from '../../database.js';
import { cronAuthorized } from '../../wake/cron.js';
import { feedPayEnabled, type FeedPayInputs } from '../../../shared/feed-pay.js';
import { FeedPayRefusal } from './engine.js';
import { jsonTooDeep } from './inputs.js';
import { sponsorConfig } from './sponsor.js';
import { SPONSORED_CALL_ID, SponsoredRefusal, type SponsoredCalls } from './sponsored.js';

export const SFP_PATHS = {
  call: '/api/feed/services/:id/sponsored-call',
  status: '/api/feed/sponsored-calls/:callId',
  credit: '/api/feed/sponsored-credit',
  cron: '/api/cron/sfp-work',
} as const;

/** Sponsored calls per owner per minute: a stress-test fleet makes about 17 (1,000 an hour). */
export const SFP_CALLS_PER_MINUTE = 120;
/** Credit reads per owner per minute (the Feed reads it on load and after a purchase). */
export const SFP_CREDIT_READS_PER_MINUTE = 60;
/**
 * One worker pass (the cron, every minute): up to this many open calls, 8 at a time, within this
 * budget (review S5: 10,000 an hour is about 170 new calls a minute, each stepped about 3 times).
 */
export const SFP_WORK_MAX_CALLS = 2_000;
export const SFP_WORK_BUDGET_MS = 50_000;

const body = z
  .object({
    agent_id: z.string().min(1).max(100),
    use_credit: z.literal(true),
    idempotency_key: z.string().min(1).max(200),
    inputs: z
      .object({
        body: z.record(z.string(), z.unknown()).optional(),
        query: z.record(z.string(), z.string()).optional(),
      })
      .default({}),
    max_price_usdc: z.string().regex(/^\d{1,3}(\.\d{1,6})?$/),
  })
  .strict();

const usdcRaw = (text: string) => {
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
};

export function registerSponsoredRoutes(
  app: FastifyInstance,
  deps: {
    sponsored: SponsoredCalls;
    env: Record<string, string | undefined>;
    person(request: FastifyRequest): Promise<{ accountId: string } | null>;
    limit?: (key: string, max: number, windowMs: number) => Promise<void>;
    cronSecret?: string;
  },
): void {
  const off = () => !feedPayEnabled(deps.env) || !sponsorConfig(deps.env);
  const notFound = (reply: FastifyReply) =>
    reply.code(404).header('Cache-Control', 'no-store').send({ error: 'Unknown API route' });

  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof SponsoredRefusal)
      return reply
        .code(error.status)
        .header('Cache-Control', 'no-store')
        .send({
          error: error.message,
          code: error.code,
          ...(error.reason ? { reason: error.reason } : {}),
          retryable: error.code === 'unavailable',
        });
    if (error instanceof FeedPayRefusal)
      return reply.code(error.status).header('Cache-Control', 'no-store').send(error.body());
    if (transientDatabaseError(error))
      return reply
        .code(503)
        .header('Retry-After', '5')
        .header('Cache-Control', 'no-store')
        .send({ error: 'Busy, try again shortly.', code: 'busy', retryable: true });
    throw error;
  };

  app.post(SFP_PATHS.call, async (request, reply) => {
    if (off()) return notFound(reply);
    const person = await deps.person(request);
    if (!person)
      return reply
        .code(401)
        .header('Cache-Control', 'no-store')
        .send({ error: 'Sign in to continue.' });
    await deps.limit?.(`sfp-call:${person.accountId}`, SFP_CALLS_PER_MINUTE, 60_000);
    if (jsonTooDeep(request.body))
      return reply.code(400).send({ error: 'Invalid request.', code: 'invalid_request' });
    const parsed = body.safeParse(request.body ?? {});
    if (!parsed.success)
      return reply.code(400).send({ error: 'Invalid request.', code: 'invalid_request' });
    try {
      const call = await deps.sponsored.start(person.accountId, {
        serviceId: String(((request.params ?? {}) as { id?: unknown }).id ?? ''),
        agentId: parsed.data.agent_id,
        inputs: parsed.data.inputs as FeedPayInputs,
        maxAmountRaw: usdcRaw(parsed.data.max_price_usdc),
        idempotencyKey: parsed.data.idempotency_key,
      });
      return reply.header('Cache-Control', 'no-store').send(call);
    } catch (error) {
      return failed(reply, error);
    }
  });

  // The owner's agents' credits and the services they cover (the Feed's "first service free").
  app.get(SFP_PATHS.credit, async (request, reply) => {
    if (off()) return notFound(reply);
    const person = await deps.person(request);
    if (!person)
      return reply
        .code(401)
        .header('Cache-Control', 'no-store')
        .send({ error: 'Sign in to continue.' });
    await deps.limit?.(`sfp-credit:${person.accountId}`, SFP_CREDIT_READS_PER_MINUTE, 60_000);
    try {
      return reply
        .header('Cache-Control', 'no-store')
        .send(await deps.sponsored.credit(person.accountId));
    } catch (error) {
      return failed(reply, error);
    }
  });

  app.get(SFP_PATHS.status, async (request, reply) => {
    const person = await deps.person(request);
    if (!person)
      return reply
        .code(401)
        .header('Cache-Control', 'no-store')
        .send({ error: 'Sign in to continue.' });
    const { callId } = (request.params ?? {}) as { callId?: unknown };
    try {
      const call =
        typeof callId === 'string' && SPONSORED_CALL_ID.test(callId)
          ? await deps.sponsored.callFor(person.accountId, callId)
          : null;
      if (!call) return notFound(reply);
      return reply.header('Cache-Control', 'no-store').send(call);
    } catch (error) {
      return failed(reply, error);
    }
  });

  // The worker (vercel.json, every minute): steps open calls, sends the sponsor's batches and
  // sweeps stale reservations. Without the secret: 404.
  app.get(SFP_PATHS.cron, async (request, reply) => {
    if (!cronAuthorized(request.headers.authorization, deps.cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    // Always: calls already started are followed to the end also while new starts are off (review
    // S4); with none open this is one indexed read.
    return reply.send({
      moved: await deps.sponsored.work({
        maxCalls: SFP_WORK_MAX_CALLS,
        budgetMs: SFP_WORK_BUDGET_MS,
      }),
    });
  });
}
