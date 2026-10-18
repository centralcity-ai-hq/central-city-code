import type { FastifyInstance } from 'fastify';
import { cronAuthorized } from '../wake/cron.js';
import { feedEnabled } from './flag.js';
import { inNoonPause, runFeedSync, type FeedSyncDeps } from './ingest.js';

/**
 * The scheduled Bazaar sweep (vercel.json "crons", every 15 minutes): one run of
 * server/feed/ingest.ts per call. Most runs only read the source's row (no sweep due); a sweep in
 * progress goes on where the last run stopped, for at most the run's budget.
 *
 * Each call first refreshes the use counts of the services sold by Central City agents
 * (`hostedUses`, server/feed/offers/uses.ts), outside the noon pause like the sweep. A failed
 * refresh is logged and the sweep runs anyway; the next call tries again.
 *
 * Vercel Cron calls GET with `Authorization: Bearer <CRON_SECRET>`. Fail closed: without a
 * configured secret, with any other header, or with the Feed switched off (CITY_FEED=0, read per
 * request) the route answers 404, exactly like an unknown path. The answer carries counts and
 * codes only.
 */
export const FEED_SYNC_PATH = '/api/cron/feed-sync';

export interface FeedCronDeps extends FeedSyncDeps {
  cronSecret: string | undefined;
  /** Where CITY_FEED is read, per request (server/app.ts passes process.env). */
  env: Record<string, string | undefined>;
  /** Operational log line sink (defaults to console.info). */
  log?: (line: string) => void;
  /** Recomputes the Central City rows' use counts; answers how many changed. None: not run. */
  hostedUses?: (now: number) => Promise<number>;
}

export function registerFeedCron(app: FastifyInstance, deps: FeedCronDeps): void {
  app.get(FEED_SYNC_PATH, async (request, reply) => {
    if (!cronAuthorized(request.headers.authorization, deps.cronSecret) || !feedEnabled(deps.env))
      return reply.code(404).send({ error: 'Not found.' });
    const log = deps.log ?? console.info;
    const at = (deps.now ?? Date.now)();
    if (deps.hostedUses && !inNoonPause(at))
      await deps.hostedUses(at).catch((error: unknown) =>
        log(
          JSON.stringify({
            event: 'feed.hosted_uses_failed',
            code: codeOf(error),
          }),
        ),
      );
    const run = await runFeedSync(deps);
    // One line per run that did something worth knowing: a page failed, a sweep completed, or
    // another run held the cursor.
    if (run.outcome === 'failed' || run.outcome === 'complete' || run.outcome === 'busy')
      log(JSON.stringify({ event: 'feed.sync_run', ...run }));
    return reply.header('Cache-Control', 'no-store').send(run);
  });
}

/** A Postgres error's code only (never its message, which may carry row data). */
function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}
