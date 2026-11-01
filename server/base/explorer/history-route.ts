import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database.js';
import { clientAddressKey } from '../../rate-limit.js';
import { createExplorerReadCache } from './read-cache.js';
import { readHistory } from './history-store.js';
export function registerHistoryRoute(
  app: FastifyInstance,
  options: {
    db: Database;
    limit?: (key: string, max: number, windowMs: number) => Promise<void>;
  },
) {
  const read = createExplorerReadCache({
    maxConcurrent: 1,
    maxKeys: 1,
    read: () =>
      options.db.transaction(async (tx) => {
        await tx.query('SET TRANSACTION READ ONLY');
        await tx.query('SET LOCAL statement_timeout = 2000');
        return readHistory(tx, Date.now());
      }),
  });
  app.get('/api/public/base/history', async (request, reply) => {
    await options.limit?.(`ip:explorer-history:${clientAddressKey(request.ip)}`, 30, 60_000);
    const query = request.query as Record<string, unknown>;
    if (Object.keys(query).length)
      return reply.code(400).header('Cache-Control', 'no-store').send({ error: 'invalid_query' });
    const result = await read('history');
    if (!result)
      return reply
        .code(503)
        .header('Cache-Control', 'no-store')
        .header('Retry-After', '15')
        .send({ error: 'history_unavailable' });
    return reply.header('Cache-Control', 'public, max-age=0, s-maxage=5').send({
      ...result.value,
      cachedAt: result.asOf,
      stale: result.stale,
      evidence: 'collected_public_counter_observations',
    });
  });
}
