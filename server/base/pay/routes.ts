/*
 * Operation Base Pay P1 over HTTP (service: pay/service.ts). Registered by the wallet routes,
 * behind the same CITY_BASE_WALLET flag (404 while off), on the wallet network only.
 *
 *   GET  /api/base/pay/recipient?q=<typed>          200 who a payment would go to, checked at a block
 *   POST /api/base/agents/:agentId/wallet/payments  201 the withdrawal to sign + payment
 *   GET  /api/base/pay/incoming?after=&limit=        200 payments to wallets the person owns, by state
 *
 * Any signed-in person may look a recipient up. Only the paying wallet's owner account may pay
 * (else 404, as for withdrawals), and only the recipient wallet's owner account reads it in
 * /incoming: never by the agent's current workspace or co-owners. Signing, status and cancel of a
 * payment are the withdrawal routes of its withdrawalId. Writes go through the console's request
 * guard in server/app.ts.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PAY_INCOMING_PAGE_MAX, PAY_PATHS, PAY_QUERY_MAX } from '../../../shared/base/pay.js';
import { WithdrawalError } from '../wallet/withdrawals.js';
import { retryable } from '../wallet/withdraw-routes.js';
import { PayError, type PayService } from './service.js';

export interface PayRouteDeps {
  enabled(): boolean;
  /** The signed-in person account, or the status to answer with (401 / 404). */
  person(
    request: FastifyRequest,
  ): Promise<{ ok: true; accountId: string } | { ok: false; code: number }>;
  service: PayService;
  /** The shared rate limiter (server/app.ts); absent in unit tests. */
  limit?: (key: string, max: number, windowMs: number) => Promise<void>;
}

/**
 * Per person, each its own bucket: a lookup reads Base and stores a lookup; an incoming read may
 * bring payments up to date from Base; a payment reads Base and prepares an operation.
 */
export const PAY_RATES = {
  lookup: { prefix: 'pay-lookup', max: 30, windowMs: 60_000 },
  incoming: { prefix: 'pay-incoming', max: 30, windowMs: 60_000 },
  create: { prefix: 'pay-create', max: 20, windowMs: 60_000 },
} as const;

const recipientQuery = z.strictObject({ q: z.string().max(PAY_QUERY_MAX) });
const incomingQuery = z.strictObject({
  // The cursor of the last page: the change's transaction id and the payment id.
  after: z
    .string()
    .regex(/^[0-9]{1,20}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    .optional(),
  limit: z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .optional(),
});
const params = z.object({ agentId: z.string().uuid() });

export function registerPayRoutes(app: FastifyInstance, deps: PayRouteDeps) {
  const limited = (rate: (typeof PAY_RATES)[keyof typeof PAY_RATES], accountId: string) =>
    deps.limit?.(`${rate.prefix}:${accountId}`, rate.max, rate.windowMs);
  const failure = (reply: FastifyReply, error: unknown) => {
    if (error instanceof PayError || error instanceof WithdrawalError)
      return reply
        .code(error.status)
        .send({ ...error.detail, error: error.message, code: error.code });
    // A lock wait the database broke: nothing was done, the request can simply be tried again.
    if (retryable(error))
      return reply.code(503).send({
        error: 'Busy for a moment; nothing was done. Try again.',
        code: 'retry',
        details: { retryAfterSeconds: 1 },
      });
    throw error;
  };

  app.get(PAY_PATHS.recipient, async (request, reply) => {
    if (!deps.enabled()) return reply.code(404).send({ error: 'Not found.' });
    const person = await deps.person(request);
    if (!person.ok) return reply.code(person.code).send({ error: 'Not found.' });
    const query = recipientQuery.safeParse(request.query ?? {});
    if (!query.success)
      return reply
        .code(400)
        .send({ error: 'Use ?q=<passport or Base ID>.', code: 'invalid_query' });
    await limited(PAY_RATES.lookup, person.accountId);
    try {
      return await deps.service.lookup(person.accountId, query.data.q);
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post(PAY_PATHS.payments, async (request, reply) => {
    if (!deps.enabled()) return reply.code(404).send({ error: 'Not found.' });
    const person = await deps.person(request);
    if (!person.ok) return reply.code(person.code).send({ error: 'Not found.' });
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'Not found.' });
    await limited(PAY_RATES.create, person.accountId);
    try {
      const created = await deps.service.create(
        person.accountId,
        parsed.data.agentId,
        request.body ?? {},
      );
      return reply.code(201).send(created);
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get(PAY_PATHS.incoming, async (request, reply) => {
    if (!deps.enabled()) return reply.code(404).send({ error: 'Not found.' });
    const person = await deps.person(request);
    if (!person.ok) return reply.code(person.code).send({ error: 'Not found.' });
    const query = incomingQuery.safeParse(request.query ?? {});
    if (!query.success)
      return reply.code(400).send({
        error: `Use ?after=<cursor> and ?limit=<1 to ${PAY_INCOMING_PAGE_MAX}>.`,
        code: 'invalid_query',
      });
    const limit = Number(query.data.limit ?? PAY_INCOMING_PAGE_MAX);
    if (limit > PAY_INCOMING_PAGE_MAX)
      return reply.code(400).send({
        error: `Use ?limit=<1 to ${PAY_INCOMING_PAGE_MAX}>.`,
        code: 'invalid_query',
      });
    await limited(PAY_RATES.incoming, person.accountId);
    const [xid, paymentId] = query.data.after?.split('.') ?? [];
    try {
      return await deps.service.incoming(person.accountId, {
        after: query.data.after ? { xid, paymentId } : null,
        limit,
      });
    } catch (error) {
      return failure(reply, error);
    }
  });
}
