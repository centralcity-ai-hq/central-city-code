/*
 * Operation Base Wallet W3: the owner's spending limits over HTTP (service: limits.ts). Registered
 * by the wallet routes, behind the same CITY_BASE_WALLET flag (404 while off), on the wallet
 * routes' one network.
 *
 *   GET  /api/base/agents/:agentId/wallet/limits                                    200 the limits
 *   POST /api/base/agents/:agentId/wallet/limits/prepare                            200 to sign
 *   POST /api/base/agents/:agentId/wallet/limits                                    201 stored
 *   POST /api/base/agents/:agentId/wallet/limits/:permissionId/revoke               200 to sign
 *   POST /api/base/agents/:agentId/wallet/limits/:permissionId/revoke/signature     202 sent
 *
 * Times in a limit (start, end, currentPeriod*, calendar period*) are unix seconds, as on Base;
 * readAt and expiresAt are milliseconds, as in the other wallet routes. Amounts are base-unit
 * strings with a display value. The signed-in person must be the wallet's owner (its vault
 * account), whatever workspace is selected and whether or not the agent is still theirs; anyone
 * else gets 404. Writes go through the console's request guard in server/app.ts.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LimitError, type LimitService } from './limits.js';

export interface LimitRouteDeps {
  enabled(): boolean;
  /** The signed-in person account, or the status to answer with (401 / 404). */
  person(
    request: FastifyRequest,
  ): Promise<{ ok: true; accountId: string } | { ok: false; code: number }>;
  service: LimitService;
}

const params = z.object({
  agentId: z.string().uuid(),
  permissionId: z.string().uuid().optional(),
});

export const LIMITS_PATH = '/api/base/agents/:agentId/wallet/limits';

export function registerLimitRoutes(app: FastifyInstance, deps: LimitRouteDeps) {
  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    status: number,
    action: (accountId: string, agentId: string, permissionId: string) => Promise<unknown>,
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
        parsed.data.permissionId ?? '',
      );
      return reply.code(status).send(result);
    } catch (error) {
      if (error instanceof LimitError)
        return reply
          .code(error.status)
          .send({ ...error.detail, error: error.message, code: error.code });
      throw error;
    }
  }

  app.get(LIMITS_PATH, (request, reply) =>
    handle(request, reply, 200, (accountId, agentId) => deps.service.list(accountId, agentId)),
  );

  app.post(`${LIMITS_PATH}/prepare`, (request, reply) =>
    handle(request, reply, 200, (accountId, agentId) =>
      deps.service.prepare(accountId, agentId, request.body ?? {}),
    ),
  );

  app.post(LIMITS_PATH, (request, reply) =>
    handle(request, reply, 201, (accountId, agentId) =>
      deps.service.store(accountId, agentId, request.body ?? {}),
    ),
  );

  app.post(`${LIMITS_PATH}/:permissionId/revoke`, (request, reply) =>
    handle(request, reply, 200, (accountId, agentId, permissionId) =>
      deps.service.revoke(accountId, agentId, permissionId, request.body ?? {}),
    ),
  );

  app.post(`${LIMITS_PATH}/:permissionId/revoke/signature`, (request, reply) =>
    handle(request, reply, 202, (accountId, agentId, permissionId) =>
      deps.service.signRevoke(accountId, agentId, permissionId, request.body ?? {}),
    ),
  );
}
