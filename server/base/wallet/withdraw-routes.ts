/*
 * Operation Base Wallet W2: owner withdrawals over HTTP (service: withdrawals.ts). Registered by the
 * wallet routes, behind the same CITY_BASE_WALLET flag (404 while off), on the wallet network only.
 *
 *   POST /api/base/agents/:agentId/wallet/withdrawals                          201 to sign
 *   GET  /api/base/agents/:agentId/wallet/withdrawals?open=1                   200 unfinished ones
 *   GET  /api/base/agents/:agentId/wallet/withdrawals/:withdrawalId            200 its state
 *   POST /api/base/agents/:agentId/wallet/withdrawals/:withdrawalId/signature  202 sent
 *   POST /api/base/agents/:agentId/wallet/withdrawals/:withdrawalId/cancel     200 no-op to sign
 *   POST .../withdrawals/:withdrawalId/cancel/signature                        202 no-op sent
 *
 * The signed-in person must be the wallet's owner (its vault account), whatever workspace is
 * selected and whether or not the agent is still theirs; anyone else gets 404. Writes go through
 * the console's request guard in server/app.ts (X-City-Request, JSON).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { cronAuthorized } from '../../wake/cron.js';
import {
  SWEEP_BUDGET_MS,
  WALLET_SWEEP_PATH,
  WithdrawalError,
  type WithdrawalService,
} from './withdrawals.js';

export interface WithdrawalRouteDeps {
  enabled(): boolean;
  /** The signed-in person account, or the status to answer with (401 / 404). */
  person(
    request: FastifyRequest,
  ): Promise<{ ok: true; accountId: string } | { ok: false; code: number }>;
  service: WithdrawalService;
  /** Pay without waiting (CITY_BASE_LANES): the open list exists only while it is on. */
  lanes(): boolean;
  /** The shared rate limiter (server/app.ts); absent in unit tests. */
  limit?: (key: string, max: number, windowMs: number) => Promise<void>;
  /** Vercel Cron's bearer secret for the sweep; without it the sweep route does not exist. */
  cronSecret?: string;
}

/**
 * A lock wait or statement the database broke off (deadlock 40P01, serialization 40001, lock not
 * available 55P03, statement timeout or cancel 57014): the transaction rolled back, nothing was
 * done, and the request can simply be tried again.
 */
export const RETRYABLE_CODES: readonly string[] = ['40P01', '40001', '55P03', '57014'];
export const retryable = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code;
  return typeof code === 'string' && RETRYABLE_CODES.includes(code);
};

/** Per person: the open list may bring up to 20 operations up to date from Base per read. */
export const OPEN_LIST_RATE = { prefix: 'wallet-open', max: 30, windowMs: 60_000 } as const;

const params = z.object({
  agentId: z.string().uuid(),
  withdrawalId: z.string().max(64).optional(),
});
/** A cancel takes no settings. */
const emptyBody = z.strictObject({});

export const WITHDRAWALS_PATH = '/api/base/agents/:agentId/wallet/withdrawals';

export function registerWithdrawalRoutes(app: FastifyInstance, deps: WithdrawalRouteDeps) {
  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    status: number,
    action: (accountId: string, agentId: string, withdrawalId: string) => Promise<unknown>,
  ) {
    if (!deps.enabled()) return reply.code(404).send({ error: 'Not found.' });
    const person = await deps.person(request);
    if (!person.ok) return reply.code(person.code).send({ error: 'Not found.' });
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'Not found.' });
    try {
      const result = await action(
        person.accountId,
        parsed.data.agentId,
        parsed.data.withdrawalId ?? '',
      );
      return reply.code(status).send(result);
    } catch (error) {
      if (error instanceof WithdrawalError)
        return reply
          .code(error.status)
          .send({ ...error.detail, error: error.message, code: error.code });
      if (retryable(error))
        return reply.code(503).send({
          error: 'Busy for a moment; nothing was done. Try again.',
          code: 'retry',
          details: { retryAfterSeconds: 1 },
        });
      throw error;
    }
  }

  app.post(WITHDRAWALS_PATH, (request, reply) =>
    handle(request, reply, 201, (accountId, agentId) =>
      deps.service.create(accountId, agentId, request.body ?? {}),
    ),
  );

  // The scheduled sweep (every minute): Vercel Cron's bearer secret, else 404 like an unknown path.
  const cronSecret = deps.cronSecret;
  if (cronSecret !== undefined)
    app.get(WALLET_SWEEP_PATH, async (request, reply) => {
      if (!cronAuthorized(request.headers.authorization, cronSecret))
        return reply.code(404).send({ error: 'Not found.' });
      return reply.send(await deps.service.sweep(SWEEP_BUDGET_MS));
    });

  // Only the open list (?open=1), only with lanes on; anything else on this path answers exactly
  // as if the route did not exist (as before lanes).
  app.get(WITHDRAWALS_PATH, async (request, reply) => {
    const query = request.query as Record<string, unknown> | undefined;
    if (!deps.enabled() || !deps.lanes() || query?.open !== '1') return reply.callNotFound();
    return handle(request, reply, 200, async (accountId, agentId) => {
      await deps.limit?.(
        `${OPEN_LIST_RATE.prefix}:${accountId}`,
        OPEN_LIST_RATE.max,
        OPEN_LIST_RATE.windowMs,
      );
      return deps.service.open(accountId, agentId);
    });
  });

  app.get(`${WITHDRAWALS_PATH}/:withdrawalId`, (request, reply) =>
    handle(request, reply, 200, (accountId, agentId, withdrawalId) =>
      deps.service.read(accountId, agentId, withdrawalId),
    ),
  );

  app.post(`${WITHDRAWALS_PATH}/:withdrawalId/signature`, (request, reply) =>
    handle(request, reply, 202, (accountId, agentId, withdrawalId) =>
      deps.service.sign(accountId, agentId, withdrawalId, request.body ?? {}),
    ),
  );

  app.post(`${WITHDRAWALS_PATH}/:withdrawalId/cancel`, (request, reply) =>
    handle(request, reply, 200, async (accountId, agentId, withdrawalId) => {
      if (!emptyBody.safeParse(request.body ?? {}).success)
        throw new WithdrawalError('invalid_body', 'A cancel takes no settings.');
      return deps.service.cancel(accountId, agentId, withdrawalId);
    }),
  );

  app.post(`${WITHDRAWALS_PATH}/:withdrawalId/cancel/signature`, (request, reply) =>
    handle(request, reply, 202, (accountId, agentId, withdrawalId) =>
      deps.service.signCancel(accountId, agentId, withdrawalId, request.body ?? {}),
    ),
  );
}
