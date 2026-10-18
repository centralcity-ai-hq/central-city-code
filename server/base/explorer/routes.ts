/*
 * Public, read-only, cached routes of the Agent Explorer's "On Base" view (store.ts decides what
 * is listed). No cookies, no session, no chain write. The chain reads are the server's own, never
 * a verification: the latest Base block, ownerOf of the listed ids at that block, and a passport's
 * feedback in the Reputation Registry at that block.
 *
 *   GET /api/public/base/agents?q=&before=   newest first, ON_BASE_PAGE_SIZE per page, + totals
 *   GET /api/public/base/agents/:baseId      one agent's passport, with its feedback and its
 *                                            Central City score (shared/base/rating-score.ts)
 *   GET /api/public/passports/:short/earnings  what the agent was paid through Central City:
 *                                            final USDC payments, totals only (store.earnings)
 *   GET /api/public/passports/:short/service-payments  what the agent paid for services from
 *                                            its own wallet: paid calls, USDC, the Central City
 *                                            fee, the last one; totals only, under the earnings'
 *                                            listing rule (store.servicePayments)
 *
 * The list reads no feedback from Base (one chain read per row is too much for a page). Its rows'
 * score is Central City's own record (store.ts listScores, one query per page): the latest rating
 * each Central City rater wallet sent the agent through Central City whose operation is final on
 * Base, averaged with the passport's own averageOf. The passport's score, read from Base, is the
 * authority, and Verify checks that one; ratings sent outside Central City count only there.
 *
 * row.owner is ownerOf(baseId) as the server read it. When Base does not answer, it is the last
 * value the server read for that id, else Central City's record (the agent wallet the identity
 * service checked as ownerOf); totals.readAtBlock and readAt then name the OLDEST of those reads
 * in the answer, with its true time, so a lagging answer always shows its age.
 *
 * Caching follows server/count-log/routes.ts, tighter: a copy is never more than 15 s old anywhere
 * (edge fresh 10 s + 5 s stale, browsers revalidate every time), so the page's "Base isn't
 * answering" banner (readAt more than 60 s behind) only shows when Base really did not answer.
 *
 * totals.ratedAgents (the "Rated agents" number, store.ts RATED_AGENTS_SQL) is one count shared by
 * every instance through a public_stats row (server/stats/public-stats.ts createSharedStat): about
 * one count per RATED_TTL_MS globally, each instance reading the row at most that often, and the
 * list never waits for a count (stale-while-revalidate). When it cannot be counted, the list still
 * answers, with the last count or null.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { formatUnits, getAddress } from 'viem';
import { z } from 'zod';
import type { Database } from '../../database.js';
import { clientAddressKey } from '../../rate-limit.js';
import {
  ANVIL,
  BASE_MAINNET,
  BASE_SEPOLIA,
  type BaseChainId,
} from '../../../shared/base/chains.js';
import {
  feedbackScore,
  ON_BASE_PATHS,
  ON_BASE_QUERY_MAX,
  ON_BASE_REPUTATION_MAX,
  type OnBaseList,
  type OnBaseReputation,
  type OnBaseTotals,
} from '../../../shared/base/on-base.js';
import { averageOf, latestRatings } from '../../../shared/base/rating-score.js';
import {
  EARNINGS_PATHS,
  SERVICE_PAYMENTS_PATHS,
  type PassportEarnings,
  type PassportServicePayments,
} from '../../../shared/directory.js';
import { createSharedStat, sqlPublicStatsStore } from '../../stats/public-stats.js';
import type { FeedbackRead, OnBaseChainReader } from './head.js';
import { createOnBaseStore, type RecordedOwner } from './store.js';

/** Browsers always revalidate; shared caches at most 10 s fresh + 5 s stale. */
export const ON_BASE_LIVE = 'public, max-age=0, s-maxage=10, stale-while-revalidate=5';
/** Vercel's edge only (never forwarded to browsers): the same 15 s bound. */
export const ON_BASE_LIVE_EDGE = 'public, max-age=10, stale-while-revalidate=5';
/**
 * The list (the Explorer's On Base view and its count): fresh 10 s like ON_BASE_LIVE, then the
 * edge may serve its copy for up to 50 s more while one background request refreshes it, so a
 * visitor within that window does not wait for the full read (about 3 s). This bounds the HTTP
 * copy's age only: the totals and ratings inside it have their own caches and can be older. A
 * visitor after a longer quiet moment still waits for a fresh read. The page names the block it
 * was read at. A passport keeps ON_BASE_LIVE: someone who just registered sees it within 15 s.
 */
export const ON_BASE_LIST_LIVE = 'public, max-age=0, s-maxage=10, stale-while-revalidate=50';
/** Vercel's edge only (never forwarded to browsers): the same 60 s HTTP allowance. */
export const ON_BASE_LIST_LIVE_EDGE = 'public, max-age=10, stale-while-revalidate=50';
/** Not listed (yet): the row may appear within seconds. */
export const ON_BASE_NOT_FOUND = 'public, max-age=0, s-maxage=10';
/** Per client address, under the degraded 'ip' prefix like /api/public/stats. */
export const ON_BASE_RATE = { max: 60, windowMs: 60_000 } as const;
/** The server reads the chain head at most this often, and gives one read this long. */
export const HEAD_TTL_MS = 5_000;
export const READ_TIMEOUT_MS = 3_000;
/** Totals are counted at most this often per instance. */
export const TOTALS_TTL_MS = 5_000;
/**
 * Rated agents are counted about this often globally (one shared public_stats row); after a
 * failed count an instance waits as long before it asks the database again.
 */
export const RATED_TTL_MS = 30_000;
/** The public_stats row of each network's rated agents (keys are lower-case letters only). */
export const RATED_KEYS: Readonly<Record<BaseChainId, string>> = {
  [BASE_MAINNET]: 'base_rated_agents_mainnet',
  [BASE_SEPOLIA]: 'base_rated_agents_sepolia',
  [ANVIL]: 'base_rated_agents_local',
};
/** ownerOf reads kept per instance (the newest read per id); cleared when it grows past this. */
export const OWNER_CACHE_MAX = 10_000;
/** The longest tag shown; the registry stores any length. */
export const FEEDBACK_TAG_MAX = 40;
/** ownerOf of an id the registry does not know (it reverts): no owner. */
export const NO_OWNER = '0x0000000000000000000000000000000000000000';

const decimal = /^(0|[1-9][0-9]{0,77})$/;
// Only these keys: any other query string would be a separate edge-cache entry.
const listQuery = z
  .object({
    q: z.string().max(ON_BASE_QUERY_MAX).optional(),
    before: z.string().regex(decimal).optional(),
  })
  .strict();
const noQuery = z.object({}).strict();
/** A passport is addressed by its numeric Base ID only: never a short id. */
const baseIdParams = z.object({ baseId: z.string().regex(/^[0-9]{1,78}$/) }).strict();
const shortParams = z.object({ short: z.string().regex(/^[0-9A-Za-z]{6}$/) }).strict();

export interface OnBaseRouteDeps {
  db: Database;
  /** The network listed; Base mainnet unless a test or local run says otherwise. */
  chainId?: BaseChainId;
  now?: () => number;
  /** The shared rate limiter (server/app.ts); absent in unit tests. */
  limit?: (key: string, max: number, windowMs: number) => Promise<void>;
  /** The server's Base reads (head.ts); without it, owners and readAt come from the records. */
  chain?: OnBaseChainReader;
  /** The agent URI origin (tests); defaults to https://centralcity.ai. */
  uriOrigin?: string;
}

/** One read that answered: what it found, at which block, and when (ms). */
interface Read {
  owner: string;
  block: number | null;
  at: number;
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), READ_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A tag as shown: one line, no control characters, at most FEEDBACK_TAG_MAX characters. */
function tagOf(tag: string): string {
  const line = tag.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return line.length > FEEDBACK_TAG_MAX ? `${line.slice(0, FEEDBACK_TAG_MAX - 1)}…` : line;
}

export function registerOnBaseRoutes(app: FastifyInstance, deps: OnBaseRouteDeps): void {
  const chainId = deps.chainId ?? BASE_MAINNET;
  const clock = deps.now ?? Date.now;
  const store = createOnBaseStore(deps.db, { chainId, uriOrigin: deps.uriOrigin });

  const limited = (request: FastifyRequest) =>
    deps.limit?.(
      `ip:onbase:${clientAddressKey(request.ip)}`,
      ON_BASE_RATE.max,
      ON_BASE_RATE.windowMs,
    );
  const badRequest = (reply: FastifyReply, error: string) =>
    reply.code(400).header('Cache-Control', 'no-store').send({ error, code: 'bad_request' });
  const live = (reply: FastifyReply) =>
    reply
      .header('Cache-Control', ON_BASE_LIVE)
      .header('Vercel-CDN-Cache-Control', ON_BASE_LIVE_EDGE);

  // The last head read that answered: its block and the true time of the read. One read at a
  // time per instance, at most every HEAD_TTL_MS; a failed read keeps the last good one with its
  // own old time and is tried again after the same interval.
  let lastHead: { block: number; at: number } | null = null;
  let headTriedAt = -Infinity;
  let headInflight: Promise<void> | null = null;
  async function readHead(): Promise<{ block: number; at: number } | null> {
    const chain = deps.chain;
    if (!chain) return null;
    if (clock() - headTriedAt >= HEAD_TTL_MS) {
      headTriedAt = clock();
      headInflight = (async () => {
        try {
          const { block } = await withTimeout(chain.head());
          lastHead = { block: Number(block), at: clock() };
        } catch {
          // Not answered: lastHead stays as it was, with its own time.
        } finally {
          headInflight = null;
        }
      })();
    }
    await headInflight;
    return lastHead;
  }

  // The newest ownerOf read per id. A page reads the ids it lacks at the current head block in
  // one call; when that fails, each id keeps its last read (with its own block and time).
  const owners = new Map<string, Read>();
  async function readOwners(ids: string[]): Promise<void> {
    const chain = deps.chain;
    const head = await readHead();
    if (!chain || !head) return;
    const stale = ids.filter((id) => (owners.get(id)?.block ?? -1) < head.block);
    if (stale.length === 0) return;
    try {
      const read = await withTimeout(chain.owners(stale, BigInt(head.block)));
      if (owners.size + stale.length > OWNER_CACHE_MAX) owners.clear();
      for (const id of stale)
        if (read.has(id))
          owners.set(id, { owner: read.get(id) ?? NO_OWNER, block: head.block, at: head.at });
    } catch {
      // Base did not answer: the earlier reads (or the records) stand, with their own age.
    }
  }
  /** The owner to publish for an id: the server's newest read, else Central City's record. */
  const ownerOf = (id: string, recorded: RecordedOwner): Read => owners.get(id) ?? recorded;

  // The newest feedback read per id, like owners: read again once the head moves; when Base does
  // not answer, the last read stands with its own block and time; never read is "not read".
  // Each read is bounded (head.ts FEEDBACK_READ_MAX): the rater wallets first, so spam feedback
  // from other wallets can neither hide the score nor make the read too big to answer.
  const feedbacks = new Map<
    string,
    { block: number; at: number; entries: FeedbackRead[]; total: number }
  >();
  const raterFirst = (clients: readonly string[]) => store.raterWallets(clients);
  /** `agentWallet`: the rated agent's own wallet, never one of its raters. */
  async function reputationOf(baseId: string, agentWallet: string): Promise<OnBaseReputation> {
    const chain = deps.chain;
    const head = chain?.feedback ? await readHead() : null;
    let read = feedbacks.get(baseId);
    if (chain?.feedback && head && (read?.block ?? -1) < head.block) {
      try {
        const { entries, total } = await withTimeout(
          chain.feedback(baseId, BigInt(head.block), raterFirst),
        );
        read = { block: head.block, at: head.at, entries, total };
        if (feedbacks.size >= OWNER_CACHE_MAX) feedbacks.clear();
        feedbacks.set(baseId, read);
      } catch {
        // Base did not answer: the earlier read (if any) stands.
      }
    }
    if (!read)
      return { readAtBlock: null, readAt: null, count: 0, entries: [], score: null, scoredBy: [] };
    const shown = read.entries.slice(-ON_BASE_REPUTATION_MAX).reverse();
    // The score counts every entry read, not only the ones shown.
    const [listed, raters] = await Promise.all([
      store.listedByAddress(shown.map((entry) => entry.client)),
      store.raterWallets(read.entries.map((entry) => entry.client)),
    ]);
    const counted = latestRatings(read.entries, raters, agentWallet);
    return {
      readAtBlock: read.block,
      readAt: read.at,
      count: read.total,
      score: averageOf(counted),
      scoredBy: counted.map((rating) => getAddress(rating.client)),
      entries: shown.map((entry) => {
        const from = listed.get(entry.client.toLowerCase()) ?? null;
        return {
          client: entry.client,
          // Shown only ("Feedback #3"); the score compares the exact bigint above.
          index: Number(entry.index),
          from,
          score: feedbackScore(entry.value, entry.decimals),
          // Anyone can give feedback: only our own agents' tags are printed on our page.
          tags: from ? [entry.tag1, entry.tag2].map(tagOf).filter(Boolean) : [],
        };
      }),
    };
  }

  // Rated agents: one shared count (RATED_KEYS), never a count per request, and the list never
  // waits for it: once any value is known (this instance's, or the stored row) the list answers
  // with it and the refresh runs on its own. Only the lease holder counts; a failed count keeps
  // the lease for the back-off. A failure is not the list's: the last count, else null.
  const rated = createSharedStat({
    key: RATED_KEYS[chainId],
    count: store.ratedAgents,
    clock,
    ttlMs: RATED_TTL_MS,
    store: sqlPublicStatsStore(deps.db),
    failureBackoffMs: RATED_TTL_MS,
    countWithoutLease: false,
    staleWhileRevalidate: true,
  });
  const ratedAgents = (): Promise<number | null> =>
    rated.get().then(
      (stat) => stat.value,
      () => null,
    );

  let totalsCache: { until: number; value: Awaited<ReturnType<typeof store.totals>> } | null = null;
  async function totals(now: number) {
    if (totalsCache && now < totalsCache.until) return totalsCache.value;
    const value = await store.totals(now);
    totalsCache = { until: now + TOTALS_TTL_MS, value };
    return value;
  }

  app.get(ON_BASE_PATHS.list, async (request, reply) => {
    await limited(request);
    const parsed = listQuery.safeParse(request.query ?? {});
    if (!parsed.success) return badRequest(reply, 'Use ?q=<search> and ?before=<Base ID>.');
    const q = parsed.data.q?.trim() || undefined;
    const [page, counted] = await Promise.all([
      store.list({ before: parsed.data.before, q }),
      totals(clock()),
    ]);
    // Scores: Central City's own final ratings, from the records (the passport verifies on Base).
    // Rated agents here, not beside the page and totals: at most two pooled connections at once.
    const [, scores, ratedNow] = await Promise.all([
      readOwners(page.items.map((item) => item.row.baseId)),
      store.listScores(
        page.items.map((item) => ({ baseId: item.row.baseId, agentWallet: item.agentWallet })),
      ),
      ratedAgents(),
    ]);
    const reads = page.items.map((item) => ownerOf(item.row.baseId, item.recorded));
    // The answer is as old as its oldest read. Without rows: the newest head read, else the
    // newest stored evidence. Never a time later than the read itself.
    const oldest = reads.length
      ? reads.reduce((a, b) => (b.at < a.at ? b : a))
      : (lastHead ?? counted.recorded);
    const block =
      reads.length && reads.some((read) => read.block !== null)
        ? Math.min(...reads.flatMap((read) => (read.block === null ? [] : [read.block])))
        : (oldest?.block ?? null);
    const body: OnBaseList = {
      rows: page.items.map((item, index) => ({
        ...item.row,
        owner: reads[index].owner,
        score: averageOf(scores.get(item.row.baseId) ?? []),
      })),
      totals: {
        onBase: counted.onBase,
        new24h: counted.new24h,
        finalizingNow: counted.finalizingNow,
        ratedAgents: ratedNow,
        readAtBlock: block,
        readAt: oldest?.at ?? null,
        // Built here, cached with readAt: servedAt - readAt is the server's own lag.
        servedAt: clock(),
      } satisfies OnBaseTotals,
      registry: store.registry,
      nextBefore: page.nextBefore,
    };
    return reply
      .header('Cache-Control', ON_BASE_LIST_LIVE)
      .header('Vercel-CDN-Cache-Control', ON_BASE_LIST_LIVE_EDGE)
      .send(body);
  });

  app.get(`${ON_BASE_PATHS.passport}/:baseId`, async (request, reply) => {
    await limited(request);
    const params = baseIdParams.safeParse(request.params);
    if (!noQuery.safeParse(request.query ?? {}).success)
      return badRequest(reply, 'This address takes no query.');
    const found = params.success ? await store.passport(params.data.baseId) : null;
    if (!found)
      return reply
        .code(404)
        .header('Cache-Control', ON_BASE_NOT_FOUND)
        .send({ error: 'No registered agent on Base with that id.', code: 'not_found' });
    await readOwners([found.passport.baseId]);
    const owner = ownerOf(found.passport.baseId, found.recorded).owner;
    const reputation = await reputationOf(found.passport.baseId, found.passport.agentWallet);
    // The owner can change on Base at any time, so a passport is as short-lived as the list.
    return live(reply).send({ ...found.passport, owner, reputation });
  });

  app.get(EARNINGS_PATHS.passport, async (request, reply) => {
    await limited(request);
    const params = shortParams.safeParse(request.params);
    if (!noQuery.safeParse(request.query ?? {}).success)
      return badRequest(reply, 'This address takes no query.');
    const found = params.success ? await store.earnings(params.data.short) : null;
    if (!found)
      return reply
        .code(404)
        .header('Cache-Control', ON_BASE_NOT_FOUND)
        .send({ error: 'No registered agent on Base with that passport.', code: 'not_found' });
    const body: PassportEarnings = {
      paidTimes: found.paidTimes,
      // USDC has 6 decimals; "8.4", never "8.400000".
      totalUsdc: formatUnits(found.totalRaw, 6),
      lastPaidAt: found.lastPaidAt,
    };
    return live(reply).send(body);
  });

  // The same answers as earnings for anything not listed (one 404 for every reason), so neither
  // route tells more than the other about a passport.
  app.get(SERVICE_PAYMENTS_PATHS.passport, async (request, reply) => {
    await limited(request);
    const params = shortParams.safeParse(request.params);
    if (!noQuery.safeParse(request.query ?? {}).success)
      return badRequest(reply, 'This address takes no query.');
    const found = params.success ? await store.servicePayments(params.data.short) : null;
    if (!found)
      return reply
        .code(404)
        .header('Cache-Control', ON_BASE_NOT_FOUND)
        .send({ error: 'No registered agent on Base with that passport.', code: 'not_found' });
    // Totals only, built field by field: nothing else of a call can reach the answer.
    const body: PassportServicePayments = {
      paidCalls: found.paidCalls,
      // USDC has 6 decimals; "0.002", never "0.002000".
      totalUsdc: formatUnits(found.totalRaw, 6),
      totalFeeUsdc: formatUnits(found.feeRaw, 6),
      lastPaidAt: found.lastPaidAt,
    };
    return live(reply).send(body);
  });
}
