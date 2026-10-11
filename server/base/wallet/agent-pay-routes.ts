/*
 * Base Pay P2b over HTTP (service: agent-pay-consent.ts). Registered by the wallet routes, behind
 * the same CITY_BASE_WALLET flag (404 while off), on the wallet routes' one network.
 *
 *   GET    /api/base/agents/:agentId/wallet/agent-pay   200 the current limit's terms + the consent
 *   PUT    /api/base/agents/:agentId/wallet/agent-pay   200 consent for {permissionHash} (the limit seen)
 *   DELETE /api/base/agents/:agentId/wallet/agent-pay   200 consent withdrawn (idempotent)
 *
 * The signed-in person must be the wallet's owner (its vault account), whatever workspace is
 * selected; anyone else gets 404. Writes go through the console's request guard in server/app.ts.
 * No grant, workspace key or agent reaches these routes: they need the person's console session.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AgentPayConsentError, type AgentPayConsentService } from './agent-pay-consent.js';

export interface AgentPayRouteDeps {
  enabled(): boolean;
  /** The signed-in person account, or the status to answer with (401 / 404). */
  person(
    request: FastifyRequest,
  ): Promise<{ ok: true; accountId: string } | { ok: false; code: number }>;
  service: AgentPayConsentService;
}

const params = z.object({ agentId: z.string().uuid() });

export const AGENT_PAY_PATH = '/api/base/agents/:agentId/wallet/agent-pay';

export function registerAgentPayRoutes(app: FastifyInstance, deps: AgentPayRouteDeps) {
  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    action: (accountId: string, agentId: string) => Promise<unknown>,
  ) {
    if (!deps.enabled()) return reply.code(404).send({ error: 'Not found.' });
    const person = await deps.person(request);
    if (!person.ok) return reply.code(person.code).send({ error: 'Not found.' });
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'Not found.' });
    try {
      return reply.code(200).send(await action(person.accountId, parsed.data.agentId));
    } catch (error) {
      if (error instanceof AgentPayConsentError)
        return reply.code(error.status).send({ error: error.message, code: error.code });
      throw error;
    }
  }

  app.get(AGENT_PAY_PATH, (request, reply) =>
    handle(request, reply, (accountId, agentId) => deps.service.view(accountId, agentId)),
  );
  app.put(AGENT_PAY_PATH, (request, reply) =>
    handle(request, reply, (accountId, agentId) =>
      deps.service.grant(accountId, agentId, request.body ?? {}),
    ),
  );
  app.delete(AGENT_PAY_PATH, (request, reply) =>
    handle(request, reply, (accountId, agentId) => deps.service.revoke(accountId, agentId)),
  );
}
