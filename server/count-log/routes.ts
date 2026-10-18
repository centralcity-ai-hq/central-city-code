import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../shared/types.js';
import {
  isCheckpointDue,
  cutInstant,
  isDay,
  nextCheckpointAt,
} from '../../shared/count-log/index.js';
import { CheckpointInProgress, LEAVES_PAGE_MAX, type CountLog } from './service.js';
import { FEED_LIMITS } from './pending.js';

/*
 * Public, cacheable routes of the verifiable agent count, the owner-only proof route and the
 * daily cron endpoint (spec §3 and §7). Public responses carry only hashes, counts and days: no
 * agent ids, owner ids, names or salts.
 */
const SHORT = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';
/**
 * Vercel's edge only (Vercel-CDN-Cache-Control, never forwarded to browsers): the same freshness,
 * then served stale while one background request refreshes, so a visitor does not wait for a cold
 * function. Browsers keep the Cache-Control values.
 */
export const SHORT_EDGE = 'public, max-age=300, stale-while-revalidate=86400';
export const LIVE_EDGE = 'public, max-age=2, stale-while-revalidate=3600';
const IMMUTABLE = 'public, max-age=31536000, s-maxage=31536000, immutable';

const leavesQuery = z
  .object({
    from: z.coerce.number().int().min(0).default(0),
    to: z.coerce.number().int().min(1).optional(),
  })
  .strict();
/**
 * The withdrawn list, paged by leaf index like /leaves: other query strings would each be a
 * separate edge-cache entry and a fresh read of the whole (append-only) table.
 */
const withdrawnQuery = z
  .object({
    from: z.coerce.number().int().min(0).max(2_147_483_647).default(0),
    to: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  })
  .strict();
// Only an optional day: other query strings would each be a separate edge-cache entry. The verify page adds ?after=<checkpoint day> to skip a stale cached list.
const checkpointsQuery = z
  .object({ after: z.string().refine(isDay, 'Use YYYY-MM-DD.').optional() })
  .strict();
const feedQuery = z
  .object({
    before: z
      .string()
      .regex(/^\d{1,18}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(FEED_LIMITS.max).optional(),
  })
  .strict();
/** The live head of the pending feed: about 2 s at the edge. */
const LIVE = 'public, max-age=2, s-maxage=2, stale-while-revalidate=5';
/** A feed page whose entries are all removed never changes again. */
const FINAL = 'public, max-age=86400, s-maxage=86400';
/**
 * The checkpoint list's cache. No copy, fresh or stale, may outlive the next Berlin-noon cut: every
 * lifetime (max-age, s-maxage, and each of them plus stale-while-revalidate) is capped by the
 * seconds left until the cut, so a list cached before noon is never served after it. While the
 * day's checkpoint is due (the cut has passed) but not listed yet, the list is cached 5 s without a
 * stale copy. A list cached at 12:01 Berlin on 10 Oct hid the 12:04 checkpoint from verifiers for
 * minutes. The day is the UTC date, like the checkpoint's own date (Berlin noon is the same UTC day).
 */
export function checkpointsCache(
  latest: string | undefined,
  now: number,
): { browser: string; edge: string } {
  const today = new Date(now).toISOString().slice(0, 10);
  if (now >= cutInstant(today) && (latest ?? '') < today)
    return { browser: 'public, max-age=5, s-maxage=5', edge: 'public, max-age=5' };
  // Strictly after now: at the cut instant itself, with the day listed, the next cut is tomorrow.
  const left = Math.floor((nextCheckpointAt(now + 1) - now) / 1000);
  // Under a second to the cut: any whole-second lifetime would cross it, so no caching at all.
  if (left < 1) return { browser: 'public, max-age=0, s-maxage=0', edge: 'public, max-age=0' };
  const stale = (fresh: number, most: number) => {
    const seconds = Math.min(most, left - fresh);
    return seconds > 0 ? `, stale-while-revalidate=${seconds}` : '';
  };
  const browserAge = Math.min(60, left);
  const sharedAge = Math.min(300, left);
  return {
    browser: `public, max-age=${browserAge}, s-maxage=${sharedAge}${stale(sharedAge, 600)}`,
    edge: `public, max-age=${sharedAge}${stale(sharedAge, 86400)}`,
  };
}

/** Seconds until the next daily checkpoint (12:00 Europe/Berlin), when a confirmed entry may change. */
function untilCheckpoint(now: number): number {
  return Math.max(2, Math.floor((nextCheckpointAt(now) - now) / 1000));
}
const dateParams = z.object({ date: z.string().refine(isDay, 'Use YYYY-MM-DD.') }).strict();
const agentParams = z.object({ id: z.string().uuid() }).strict();
/** Per signed-in owner. */
export const OWNER_PROOF_RATE = { max: 10, windowMs: 60_000 } as const;
/** A seal still running this long after the noon cut without a checkpoint logs a late line. */
export const CHECKPOINT_LATE_AFTER_MS = 15 * 60_000;
/**
 * How long after the noon cut the seal starts at the earliest. An agent created in a transaction
 * that began before the cut carries a pre-cut createdAt and record time, but only becomes visible
 * when it commits, possibly after the cut. Creation transactions normally commit within seconds,
 * so waiting 30 s usually lets them in before the first listing. It is not a fence: nothing bounds
 * a whole transaction's lifetime (the pool limits single statements and idle gaps). An agent that
 * becomes visible later with a pre-cut time is appended by whichever later run sees it, or by the
 * next day's checkpoint.
 */
export const SEAL_SETTLE_MS = 30_000;

function bearerMatches(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerCountLogRoutes(
  app: FastifyInstance,
  d: {
    log: CountLog;
    owner: (request: FastifyRequest) => Promise<Operator>;
    /** Vercel Cron's bearer secret (CRON_SECRET); without it the cron route answers 404. */
    cronSecret?: string;
    /** Wall clock for the cron gate (tests); defaults to Date.now. */
    now?: () => number;
    /**
     * Tests only: false seals without the noon cut. For suites that pin the gate
     * clock (CITY_COUNT_LOG_CRON_NOW) while the database stamps pending agents with the real time:
     * a cut on the pinned day would leave out every agent they just created. Default true.
     */
    noonCut?: boolean;
    /** Waits before a seal that starts within SEAL_SETTLE_MS of the cut (tests inject it). */
    sleep?: (ms: number) => Promise<void>;
    /** The shared rate limiter; the owner proof route allows OWNER_PROOF_RATE per owner. */
    limit?: (key: string, max: number, windowMs: number) => Promise<void>;
  },
): void {
  app.get('/api/public/count-log/checkpoints', async (request, reply) => {
    checkpointsQuery.parse(request.query);
    const checkpoints = await d.log.checkpoints();
    const cache = checkpointsCache(checkpoints.at(-1)?.date, d.now?.() ?? Date.now());
    return reply
      .header('Cache-Control', cache.browser)
      .header('Vercel-CDN-Cache-Control', cache.edge)
      .send({ checkpoints });
  });
  // Live log Phase 2: new agents' fingerprints as they are created (pending), confirmed by the
  // next checkpoint. Hashes, days and minutes only.
  app.get('/api/public/count-log/feed', async (request, reply) => {
    const query = feedQuery.parse(request.query);
    const feed = await d.log.feed(query);
    const age = untilCheckpoint(Date.now());
    const cache =
      query.before === undefined || feed.stability === 'live'
        ? LIVE
        : feed.stability === 'final'
          ? FINAL
          : `public, max-age=${age}, s-maxage=${age}`;
    const { stability: _stability, ...body } = feed;
    if (cache === LIVE) reply.header('Vercel-CDN-Cache-Control', LIVE_EDGE);
    return reply.header('Cache-Control', cache).send(body);
  });
  app.get('/api/public/count-log/checkpoints/:date', async (request, reply) => {
    const { date } = dateParams.parse(request.params);
    const checkpoint = await d.log.checkpointOn(date);
    if (!checkpoint)
      return reply.code(404).send({ error: 'No checkpoint for that day.', code: 'not_found' });
    return reply.header('Cache-Control', IMMUTABLE).send({ checkpoint });
  });
  app.get('/api/public/count-log/leaves', async (request, reply) => {
    const { from, to } = leavesQuery.parse(request.query);
    const page = await d.log.leaves(from, to ?? from + LEAVES_PAGE_MAX);
    const end = from + page.leaves.length;
    // Immutable only when the URL pins the range (`to` given) and the page is filled (up to `to`,
    // or a full page): those leaves never change. Without `to` the page follows the log's current
    // size, so it revalidates. Either way the body's tree_size is the size at response time:
    // clients read the current size from /checkpoints, never from a cached leaves page.
    const settled = to !== undefined && (end >= to || page.leaves.length === LEAVES_PAGE_MAX);
    return reply
      .header('Cache-Control', settled ? IMMUTABLE : SHORT)
      .send({ from, tree_size: page.tree_size, leaves: page.leaves });
  });
  app.get('/api/public/count-log/withdrawn', async (request, reply) => {
    const { from, to } = withdrawnQuery.parse(request.query);
    const withdrawn = await d.log.withdrawn(from, to, LEAVES_PAGE_MAX);
    // A full page may have more after it: `next` is the `from` of the following page. Never
    // immutable: a leaf in any range can still be withdrawn later.
    const next = withdrawn.length === LEAVES_PAGE_MAX ? withdrawn.at(-1)!.idx + 1 : null;
    return reply.header('Cache-Control', SHORT).send({ from, withdrawn, next });
  });
  // The owner's own agents, id and name only, for "Check my agent" on /downtown/verify. Unlike
  // /api/snapshot it reads nothing else and advances no work.
  app.get('/api/count-log/my-agents', async (request, reply) => {
    const operator = await d.owner(request);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send({ agents: await d.log.ownerAgents(operator.id) });
  });
  // The owner's own proof: console session only; "not yours" and "does not exist" look the same.
  app.get('/api/agents/:id/count-proof', async (request, reply) => {
    const operator = await d.owner(request);
    const { id } = agentParams.parse(request.params);
    // Under the degraded 'ip' prefix (classified in server/rate-limit.ts), keyed per owner: the
    // key never collides with the global ip:<address> buckets.
    await d.limit?.(
      `ip:count-proof:${operator.id}`,
      OWNER_PROOF_RATE.max,
      OWNER_PROOF_RATE.windowMs,
    );
    const result = await d.log.ownerProof(operator.id, id);
    if (!result) return reply.code(404).send({ error: 'Agent not found.', code: 'not_found' });
    return reply.header('Cache-Control', 'private, no-store').send(result);
  });
  // Vercel Cron (GET with Authorization: Bearer CRON_SECRET) fires every 5 minutes from 10:00
  // to 21:55 UTC (vercel.json). The checkpoint is 12:00 Europe/Berlin: the 10:00 UTC hour reaches
  // it under CEST, the 11:00 UTC hour under CET. It seals with the noon cut: agents the pending
  // feed recorded from 12:00 Berlin on wait for the next day, so agents created after noon cannot keep
  // the seal running. An
  // unfinished or failed run is retried on every later firing until Berlin midnight, so a slow day
  // is caught up instead of skipped; once the day's checkpoint exists, checkpoint() returns it
  // unchanged. Before Berlin noon nothing runs.
  app.get('/api/cron/count-checkpoint', async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, d.cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    const now = d.now?.() ?? Date.now();
    // How long this instance has been up when the handler starts (a cold start shows as small).
    console.info(
      JSON.stringify({
        event: 'count_log.cron.start',
        uptime_ms: Math.round(process.uptime() * 1000),
        due: isCheckpointDue(now) ? 1 : 0,
      }),
    );
    if (!isCheckpointDue(now)) return reply.send({ skipped: true, reason: 'not_berlin_noon_hour' });
    // The checkpoint's day. From Berlin noon on, the UTC day (which dates the checkpoint) is the
    // Berlin day, so its cut is 12:00 Berlin of this day.
    const date = new Date(now).toISOString().slice(0, 10);
    const noon = cutInstant(date);
    const cut = d.noonCut === false ? undefined : noon;
    // Let creation transactions that began before the cut commit first (SEAL_SETTLE_MS).
    const settle = Math.min(noon + SEAL_SETTLE_MS - now, SEAL_SETTLE_MS);
    if (cut !== undefined && settle > 0)
      await (d.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(settle);
    // Logged before the run, so a run that the function limit cuts off still leaves the line.
    if (now - noon > CHECKPOINT_LATE_AFTER_MS && !(await d.log.checkpointOn(date)))
      console.error(
        JSON.stringify({
          event: 'count_log_checkpoint_late',
          date,
          minutes_late: Math.floor((now - noon) / 60_000),
        }),
      );
    let result: Awaited<ReturnType<CountLog['checkpoint']>>;
    try {
      result = await d.log.checkpoint({ cut });
    } catch (error) {
      // Not finished within this invocation: progress is committed, the next cron run continues.
      if (error instanceof CheckpointInProgress)
        return reply.code(202).send({
          created: false,
          in_progress: true,
          appended: error.appended,
          remaining: error.remaining,
          busy: error.busy,
        });
      throw error;
    }
    const { checkpoint, created } = result;
    return reply.send({
      date: checkpoint.date,
      tree_size: checkpoint.tree_size,
      withdrawn: checkpoint.withdrawn,
      hash: checkpoint.hash,
      created,
    });
  });
}
