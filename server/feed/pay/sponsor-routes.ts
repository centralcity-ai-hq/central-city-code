/*
 * GET /api/ops/sfp/stats: the sponsored first purchase's numbers (server/feed/pay/sponsor.ts) for
 * the team's monitoring: credits reserved, used and released, refusals by code, and today's budget
 * left. Behind the ops guard (Authorization: Bearer CITY_OPS_SECRET, server/elric/ops.ts
 * opsAuthorized); 404 otherwise. Read-only, no-store.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database.js';
import { opsAuthorized } from '../../elric/ops.js';
import { createSponsorCredits } from './sponsor.js';

export const SFP_STATS_PATH = '/api/ops/sfp/stats';

export function registerSponsorStatsRoute(
  app: FastifyInstance,
  deps: { db: Database; env: Record<string, string | undefined>; now?: () => number },
): void {
  const credits = createSponsorCredits({ db: deps.db, env: deps.env, now: deps.now ?? Date.now });
  app.get(SFP_STATS_PATH, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!opsAuthorized(request.headers.authorization, deps.env.CITY_OPS_SECRET))
      return reply.code(404).send({ error: 'Not found.', code: 'not_found' });
    return credits.stats();
  });
}
