/*
 * Operation Directory D1 over HTTP (store.ts decides who is listed; shared/directory.ts is the
 * contract the browser and the AI tools use).
 *
 *   GET   /api/public/directory?q=&min_rating=&sort=&before=   DirectoryPage. Public (signed out
 *         too), rate limited per address like the explorer, cached as briefly as its list.
 *   GET   /api/agents/:agentId/directory                       DirectorySettings
 *   PATCH /api/agents/:agentId/directory                       {listed?, invitations?} ->
 *         DirectorySettings. listed=true needs a final Base ID and a public card (409
 *         not_base_agent); turning it off or changing invitations never does.
 *
 * The settings are the agent's owner's only: signed out 401; another account's agent, an unknown
 * or malformed id 404 agent_not_found, the same answer, so an id cannot be probed. The PATCH goes
 * through the console's request guard in server/app.ts (request header, JSON).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BASE_MAINNET, type BaseChainId } from '../../shared/base/chains.js';
import { DIRECTORY_PATHS, readDirectoryQuery } from '../../shared/directory.js';
import { clientAddressKey } from '../rate-limit.js';
import type { Database } from '../database.js';
import { ON_BASE_LIVE, ON_BASE_LIVE_EDGE, ON_BASE_RATE } from '../base/explorer/routes.js';
import { createDirectoryStore } from './store.js';

export { DIRECTORY_PATHS };

export interface DirectoryRouteDeps {
  db: Database;
  /**
   * Whether the signed-in person's selected workspace owns this agent: 'signed_out' (401),
   * 'not_found' (another account's or unknown: 404) or 'ok'.
   */
  owns(request: FastifyRequest, agentId: string): Promise<'ok' | 'signed_out' | 'not_found'>;
  /** The network listed; Base mainnet (the explorer's) unless a test or local run says otherwise. */
  chainId?: BaseChainId;
  /** The agent URI origin (tests); defaults to https://centralcity.ai. */
  uriOrigin?: string;
  /** The shared rate limiter (server/app.ts); absent in unit tests. */
  limit?: (key: string, max: number, windowMs: number) => Promise<void>;
}

const params = z.object({ agentId: z.string().uuid() }).strict();
/** Partial<DirectorySettings>, nothing else. */
const patchBody = z
  .object({ listed: z.boolean().optional(), invitations: z.enum(['ask', 'never']).optional() })
  .strict();

export function registerDirectoryRoutes(app: FastifyInstance, deps: DirectoryRouteDeps): void {
  const store = createDirectoryStore(deps.db, {
    chainId: deps.chainId ?? BASE_MAINNET,
    uriOrigin: deps.uriOrigin,
  });

  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: 'Agent not found.', code: 'agent_not_found' });

  /** The owner's agent id, or the reply already sent. */
  async function ownedAgent(request: FastifyRequest, reply: FastifyReply) {
    const parsed = params.safeParse(request.params);
    const owned = parsed.success ? await deps.owns(request, parsed.data.agentId) : 'not_found';
    if (owned === 'signed_out') {
      reply.code(401).send({ error: 'Sign in to continue.' });
      return null;
    }
    if (owned !== 'ok' || !parsed.success) {
      notFound(reply);
      return null;
    }
    return parsed.data.agentId;
  }

  app.get(DIRECTORY_PATHS.search, async (request, reply) => {
    await deps.limit?.(
      `ip:directory:${clientAddressKey(request.ip)}`,
      ON_BASE_RATE.max,
      ON_BASE_RATE.windowMs,
    );
    // Never refused: anything unreadable in the query falls back to its default.
    const page = await store.search(
      readDirectoryQuery((request.query ?? {}) as Record<string, unknown>),
    );
    // As short-lived as the explorer's list: listing, scores and cards change within seconds.
    return reply
      .header('Cache-Control', ON_BASE_LIVE)
      .header('Vercel-CDN-Cache-Control', ON_BASE_LIVE_EDGE)
      .send(page);
  });

  app.get(DIRECTORY_PATHS.settings, async (request, reply) => {
    const agentId = await ownedAgent(request, reply);
    if (agentId === null) return reply;
    return reply.header('Cache-Control', 'no-store').send(await store.settings(agentId));
  });

  app.patch(DIRECTORY_PATHS.settings, async (request, reply) => {
    const agentId = await ownedAgent(request, reply);
    if (agentId === null) return reply;
    const body = patchBody.safeParse(request.body ?? {});
    if (!body.success)
      return reply.code(400).send({
        error: "Send {listed: true|false} and/or {invitations: 'ask'|'never'}.",
        code: 'invalid_request',
      });
    if (body.data.listed === true && !(await store.eligible(agentId)))
      return reply.code(409).send({
        error:
          'Only a Central City Base agent with a final Base ID and a public card can be listed.',
        code: 'not_base_agent',
      });
    return reply.header('Cache-Control', 'no-store').send(await store.save(agentId, body.data));
  });
}
