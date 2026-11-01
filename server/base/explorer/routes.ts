import { createHistoryObserver } from './history-observer.js';
import { ARC_MAINNET, ARC_TESTNET, chainView } from '../../../shared/chains.js';
/*
 * Public, read-only, cached routes of the Agent Explorer's "On Base" view (store.ts decides what
 * is listed). No cookies, no session, no chain write. The chain reads are the server's own, never
 * a verification: the latest Base block, ownerOf of the listed ids at that block, and a passport's
 * feedback in the Reputation Registry at that block.
 *
 *   GET /api/public/base/agents?q=&before=   newest first, ON_BASE_PAGE_SIZE per page, + totals
 *                                            ?q= reads a Base ID, short id or passport number,
 *                                            agent wallet, and a name of 3+ letters or digits
 *                                            (shared/base/on-base.ts onBaseSearchReadings); a
 *                                            text with none of them is 400 unsupported_reading;
 *                                            a transaction hash is 503 tx_search_unavailable
 *                                            until ON_BASE_TX_SEARCH_AVAILABLE (migration 291)
 *   GET /api/public/base/rated               the highest Base IDs with a final Central City
 *                                            rating (base_rated_agents, its primary key only),
 *                                            for the Rated agents proof page to sample
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
 * The other totals (on Base, finalizing, new in 24 h) are shared the same way: one count per
 * TOTALS_TTL_MS globally under a TOTALS_LEASE_MS lease, stored in the TOTALS_KEYS row and its parts.
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
import { readTimeoutError, type Database } from '../../database.js';
import { clientAddressKey, clientAddressPrefixes } from '../../rate-limit.js';
import {
  ANVIL,
  BASE_MAINNET,
  BASE_SEPOLIA,
  type BaseChainId,
} from '../../../shared/base/chains.js';
import {
  feedbackScore,
  ON_BASE_PATHS,
  onChainPaths,
  type ExplorerChainSlug,
  ON_BASE_QUERY_MAX,
  ON_BASE_RATED_MAX,
  ON_BASE_REPUTATION_MAX,
  ON_BASE_SEARCH_NOTICES,
  ON_BASE_TX_SEARCH_UNAVAILABLE_CODE,
  ON_BASE_TX_SEARCH_UNAVAILABLE_MESSAGE,
  ON_BASE_UNSUPPORTED_CODE,
  onBaseTxSearchUnavailable,
  onBaseUnsupportedReading,
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
import {
  createSharedStat,
  readStatParts,
  sqlPublicStatsStore,
  writeStatParts,
} from '../../stats/public-stats.js';
import { FEEDBACK_CLIENTS_MAX, type FeedbackRead, type OnBaseChainReader } from './head.js';
import { createOnBaseStore, parseQuery, type RecordedOwner } from './store.js';

/** Browsers always revalidate; shared caches at most 10 s fresh + 5 s stale. */
export const ON_BASE_LIVE = 'public, max-age=0, s-maxage=10, stale-while-revalidate=5';
/** Vercel's edge only (never forwarded to browsers): the same 15 s bound. */
export const ON_BASE_LIVE_EDGE = 'public, max-age=10, stale-while-revalidate=5';
/**
 * The list (the Explorer's On Base view and its count): fresh 10 s like ON_BASE_LIVE, then the
 * edge may serve its copy for up to 50 s more while one background request refreshes it, so a
 * visitor within that window does not wait for the full read (about 3 s). This bounds the HTTP
 * copy's age only: the totals and ratings inside it have their own caches and can be older. The
 * edge keeps serving longer (ON_BASE_LIST_LIVE_EDGE). The page names the block it
 * was read at. A passport keeps ON_BASE_LIVE: someone who just registered sees it within 15 s.
 */
/** How long one instance keeps the rated Base IDs before it reads them again. */
export const RATED_IDS_TTL_MS = 60_000;
/** How long one instance waits after a failed read of the rated Base IDs before it asks again. */
export const RATED_IDS_RETRY_MS = 15_000;

export const ON_BASE_LIST_LIVE = 'public, max-age=0, s-maxage=10, stale-while-revalidate=50';
/**
 * Vercel's edge only (never forwarded to browsers): fresh 10 s, then its copy is served for up to a
 * day while one background request refreshes it, like the homepage stats
 * (PUBLIC_STATS_EDGE_CACHE_CONTROL). Under load the full read took 12-28 s (23 Oct 2026), and a
 * visitor after a quiet minute waited for it or timed out; now only a first visitor ever does. The
 * page still names the block and time its answer was read at.
 */
export const ON_BASE_LIST_LIVE_EDGE = 'public, max-age=10, stale-while-revalidate=86400';
/** Not listed (yet): the row may appear within seconds. */
export const ON_BASE_NOT_FOUND = 'public, max-age=0, s-maxage=10';
/** Per client address, under the degraded 'ip' prefix like /api/public/stats. */
export const ON_BASE_RATE = { max: 60, windowMs: 60_000 } as const;
/**
 * Name searches per IPv6 /56 (one subscriber's network, rate-limit.ts clientAddressPrefixes), on
 * top of ON_BASE_RATE per /64: rotating /64s inside one /56 cannot multiply the search budget. Not
 * for IPv4, where a /24 is commonly shared by unrelated visitors.
 */
export const ON_BASE_SEARCH_SITE_RATE = { max: 120, windowMs: 60_000 } as const;
/** One search gets at most this long in the database; past it the list answers 503, busy. */
export const SEARCH_TIMEOUT_MS = 4_000;
/** A search that ran out of time reads as null (busy); any other failure rejects as it was. */
export const busyOnTimeout = (error: unknown): null => {
  if (readTimeoutError(error)) return null;
  throw error;
};
/**
 * One instance answers the same search (the same reading of q, the same page) from its last read
 * for this long, and identical searches in flight share one read. Each spelling of q is its own
 * edge-cache entry; this joins the spellings that mean the same search.
 */
export const SEARCH_CACHE_MS = 10_000;
/** Searches kept per instance; cleared when it grows past this. */
export const SEARCH_CACHE_MAX = 500;
/**
 * Per IPv6 /56 and /48 as well (a subscriber commonly holds a whole /56 or /48 and could rotate
 * /64s to multiply ON_BASE_RATE): a few /64s' worth each. IPv4 keeps its per-address limit only.
 */
export const ON_BASE_RATE_SITE = { max: 240, windowMs: 60_000 } as const;
export const ON_BASE_RATE_NETWORK = { max: 600, windowMs: 60_000 } as const;
/**
 * Passport reads that go to Base (an id not read at the current head) per minute, for the whole
 * deployment (the shared limiter). The configured Base endpoint also carries the bundler and
 * every wallet read, so anonymous passports may only spend this much of it; past it a passport
 * answers with its last read (or Central City's record), with that read's own block and time.
 */
export const ON_BASE_CHAIN_READS = { max: 600, windowMs: 60_000 } as const;
/** The server reads the chain head at most this often, and gives one read this long. */
export const HEAD_TTL_MS = 5_000;
export const READ_TIMEOUT_MS = 3_000;
/** Each of the passport's two record reads (rater names, rater wallets) gets at most this long. */
export const RECORDS_TIMEOUT_MS = 4_000;
/** A passport slower than this logs its stage durations (event passport_slow). */
export const PASSPORT_SLOW_LOG_MS = 2_000;
/**
 * Totals are counted about this often globally (one shared public_stats row and its parts); after
 * a failed count an instance waits as long before it asks the database again.
 */
export const TOTALS_TTL_MS = 30_000;
/**
 * How long one count keeps the others from starting: longer than the count itself (15-21 s on
 * 23 Oct 2026, a full join of every registration), so two never run at once.
 */
export const TOTALS_LEASE_MS = 60_000;
/** The public_stats row of each network's totals; its parts are `<key>_<part>` (TOTALS_PARTS). */
export const TOTALS_KEYS: Readonly<Record<number, string>> = {
  [BASE_MAINNET]: 'base_explorer_totals_mainnet',
  [BASE_SEPOLIA]: 'base_explorer_totals_sepolia',
  [ANVIL]: 'base_explorer_totals_local',
  [ARC_MAINNET]: 'arc_explorer_totals_mainnet',
  [ARC_TESTNET]: 'arc_explorer_totals_testnet',
};
/** The totals stored beside the on-Base count; 0 for a block or time means none recorded. */
export const TOTALS_PARTS = ['finalizing', 'new_day', 'block', 'at'] as const;
/**
 * Rated agents are counted about this often globally (one shared public_stats row); after a
 * failed count an instance waits as long before it asks the database again.
 */
export const RATED_TTL_MS = 30_000;
/** The public_stats row of each network's rated agents (keys are lower-case letters only). */
export const RATED_KEYS: Readonly<Record<number, string>> = {
  [BASE_MAINNET]: 'base_rated_agents_mainnet',
  [BASE_SEPOLIA]: 'base_rated_agents_sepolia',
  [ANVIL]: 'base_rated_agents_local',
  [ARC_MAINNET]: 'arc_rated_agents_mainnet',
  [ARC_TESTNET]: 'arc_rated_agents_testnet',
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
/** A Base ID written with leading zeros: the same passport as its canonical form. */
const PADDED_BASE_ID = /^0+[0-9]+$/;
const shortParams = z.object({ short: z.string().regex(/^[0-9A-Za-z]{6}$/) }).strict();

export interface OnBaseRouteDeps {
  db: Database;
  /** The network listed; Base mainnet unless a test or local run says otherwise. */
  chainId?: number;
  /**
   * The slug of its public paths (/api/public/<slug>/...): 'base' unless a second chain is mounted
   * beside it (Arc), which then needs its own chainId too.
   */
  slug?: ExplorerChainSlug;
  now?: () => number;
  /** The shared rate limiter (server/app.ts); absent in unit tests. */
  limit?: (key: string, max: number, windowMs: number) => Promise<void>;
  /** The server's Base reads (head.ts); without it, owners and readAt come from the records. */
  chain?: OnBaseChainReader;
  /** The agent URI origin (tests); defaults to https://centralcity.ai. */
  uriOrigin?: string;
  /**
   * Another chain whose passports the routes by short id also answer (Arc, while it is on): a short
   * id belongs to one agent on one chain, and these routes are mounted once. Unset: this chain only.
   */
  passportsAlsoOn?: number | null;
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
  const paths = deps.slug ? onChainPaths(deps.slug) : ON_BASE_PATHS;
  // What a 404 calls the chain: every Base network stays "Base", as it always read.
  const view = chainView(chainId);
  const chainName = view && view.slug !== 'base' ? view.name : 'Base';
  const clock = deps.now ?? Date.now;
  const observeHistory = createHistoryObserver(deps.db, clock);
  const store = createOnBaseStore(deps.db, { chainId, uriOrigin: deps.uriOrigin });

  const limited = async (request: FastifyRequest) => {
    if (!deps.limit) return;
    const scopes = clientAddressPrefixes(request.ip);
    await deps.limit(`ip:onbase:${scopes.source}`, ON_BASE_RATE.max, ON_BASE_RATE.windowMs);
    if (!scopes.source.endsWith('::/64')) return;
    await deps.limit(
      `ip:onbase-site:${scopes.site}`,
      ON_BASE_RATE_SITE.max,
      ON_BASE_RATE_SITE.windowMs,
    );
    await deps.limit(
      `ip:onbase-network:${scopes.network}`,
      ON_BASE_RATE_NETWORK.max,
      ON_BASE_RATE_NETWORK.windowMs,
    );
  };
  const searchLimited = async (request: FastifyRequest) => {
    const { source, site } = clientAddressPrefixes(request.ip);
    if (source.endsWith('::/64'))
      await deps.limit?.(
        `ip:onbase-search:${site}`,
        ON_BASE_SEARCH_SITE_RATE.max,
        ON_BASE_SEARCH_SITE_RATE.windowMs,
      );
  };
  /**
   * Whether a passport may read Base now (ON_BASE_CHAIN_READS, deployment-wide). Spent, or the
   * limiter not answering: no chain read, the last read stands.
   */
  const chainReadAllowed = async (): Promise<boolean> => {
    if (!deps.limit) return true;
    try {
      await deps.limit(
        'onbase-chain:passport',
        ON_BASE_CHAIN_READS.max,
        ON_BASE_CHAIN_READS.windowMs,
      );
      return true;
    } catch {
      return false;
    }
  };
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

  /**
   * Whether a passport reads Base now: only when its owner or feedback was not read at the current
   * head (otherwise nothing is read anyway), and then only within ON_BASE_CHAIN_READS.
   */
  async function freshPassport(baseId: string): Promise<boolean> {
    if (!deps.chain) return false;
    const head = await readHead();
    if (!head) return false;
    const owned = (owners.get(baseId)?.block ?? -1) >= head.block;
    const rated = !deps.chain.feedback || (feedbacks.get(baseId)?.block ?? -1) >= head.block;
    if (owned && rated) return false;
    return chainReadAllowed();
  }

  // The newest feedback read per id, like owners: read again once the head moves; when Base does
  // not answer, the last read stands with its own block and time; never read is "not read".
  // Each read is bounded (head.ts FEEDBACK_READ_MAX): each rater wallet on its own, so spam
  // feedback from other wallets can neither hide the score nor make the read too big to answer,
  // and no rater's entries can push another rater out. When the registry's client list cannot be
  // read, the raters in the records are asked instead.
  const feedbacks = new Map<
    string,
    {
      block: number;
      at: number;
      entries: FeedbackRead[];
      total: number;
      bounded: boolean;
      ratersSkipped: number;
    }
  >();
  const raterFirst = (clients: readonly string[]) => store.raterWallets(clients);
  // Read only when the client list is not, and bounded like the passport's other record reads.
  const recordedRaters = (baseId: string) =>
    deps.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY');
      await tx.query(`SET LOCAL statement_timeout = ${RECORDS_TIMEOUT_MS}`);
      return createOnBaseStore(tx, { chainId, uriOrigin: deps.uriOrigin }).recordedRaters(
        baseId,
        FEEDBACK_CLIENTS_MAX,
      );
    });
  /** Feedback reads in flight, per id and head block. */
  const feedbackInflight = new Map<
    string,
    ReturnType<NonNullable<OnBaseChainReader['feedback']>>
  >();
  /** `agentWallet`: the rated agent's own wallet, never one of its raters. */
  async function reputationOf(
    baseId: string,
    agentWallet: string,
    stages: Record<string, number | string> = {},
    mayRead = true,
  ): Promise<OnBaseReputation> {
    const chain = deps.chain;
    let at = clock();
    const head = chain?.feedback ? await readHead() : null;
    stages.headMs = clock() - at;
    let read = feedbacks.get(baseId);
    if (mayRead && chain?.feedback && head && (read?.block ?? -1) < head.block) {
      at = clock();
      try {
        // Concurrent passports of one id at one head share one read of Base.
        const key = `${baseId}@${head.block}`;
        let pending = feedbackInflight.get(key);
        if (!pending) {
          pending = withTimeout(
            chain.feedback(baseId, BigInt(head.block), raterFirst, () => recordedRaters(baseId)),
          );
          feedbackInflight.set(key, pending);
          const done = () => feedbackInflight.delete(key);
          pending.then(done, done);
        }
        const { entries, total, bounded, ratersSkipped } = await pending;
        read = { block: head.block, at: head.at, entries, total, bounded, ratersSkipped };
        if (feedbacks.size >= OWNER_CACHE_MAX) feedbacks.clear();
        feedbacks.set(baseId, read);
        stages.feedback = 'read';
      } catch {
        // Base did not answer: the earlier read (if any) stands.
        stages.feedback = 'failed';
      }
      stages.feedbackMs = clock() - at;
    }
    if (!read)
      return { readAtBlock: null, readAt: null, count: 0, entries: [], score: null, scoredBy: [] };
    // Said only when it is so: an answer of a fully read passport is unchanged.
    const partial = {
      ...(read.bounded ? { bounded: true as const } : {}),
      ...(read.ratersSkipped > 0 ? { ratersSkipped: read.ratersSkipped } : {}),
    };
    const shown = read.entries.slice(-ON_BASE_REPUTATION_MAX).reverse();
    const entriesOf = (listed: Map<string, { name: string; baseId: string }>) =>
      shown.map((entry) => {
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
      });
    // The score counts every entry read, not only the ones shown. Both reads run READ ONLY with
    // RECORDS_TIMEOUT_MS each: a slow read never holds the passport (24 Oct 2026: > 60 s for
    // agents with many raters); the passport then answers with Base's entries, unnamed, and
    // scoreUnread instead of a score.
    let records: [Map<string, { name: string; baseId: string }>, Set<string>];
    at = clock();
    stages.entries = read.entries.length;
    try {
      records = await deps.db.transaction(async (tx) => {
        await tx.query('SET TRANSACTION READ ONLY');
        await tx.query(`SET LOCAL statement_timeout = ${RECORDS_TIMEOUT_MS}`);
        const bounded = createOnBaseStore(tx, { chainId, uriOrigin: deps.uriOrigin });
        return [
          await bounded.listedByAddress(shown.map((entry) => entry.client)),
          // Never a wallet of the rated wallet's own owner key (CCA-144).
          await bounded.raterWallets(
            read!.entries.map((entry) => entry.client),
            agentWallet,
          ),
        ] as [Map<string, { name: string; baseId: string }>, Set<string>];
      });
    } catch {
      stages.recordsMs = clock() - at;
      stages.records = 'failed';
      return {
        readAtBlock: read.block,
        readAt: read.at,
        count: read.total,
        score: null,
        scoredBy: [],
        scoreUnread: true,
        entries: entriesOf(new Map()),
        ...partial,
      };
    }
    stages.recordsMs = clock() - at;
    const [listed, raters] = records;
    const counted = latestRatings(read.entries, raters, agentWallet);
    return {
      readAtBlock: read.block,
      readAt: read.at,
      count: read.total,
      score: averageOf(counted),
      scoredBy: counted.map((rating) => getAddress(rating.client)),
      entries: entriesOf(listed),
      ...partial,
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
    store: sqlPublicStatsStore(deps.db, observeHistory),
    failureBackoffMs: RATED_TTL_MS,
    countWithoutLease: false,
    staleWhileRevalidate: true,
  });
  const ratedAgents = (): Promise<number | null> =>
    rated.get().then(
      (stat) => stat.value,
      () => null,
    );

  // Totals: one shared count (TOTALS_KEYS) for every instance, never one per instance. A new
  // instance answers with the stored totals at once instead of counting first (23 Oct 2026: a
  // count is a full join, 15-21 s, and each new instance's first list waited for its own). Only
  // the lease holder counts, and the list never waits once any value is known; a failed count
  // keeps the last one.
  type Totals = Awaited<ReturnType<typeof store.totals>>;
  const totalsKey = TOTALS_KEYS[chainId];
  const partKeys = TOTALS_PARTS.map((part) => `${totalsKey}_${part}`);
  let counted: { at: number; value: Totals } | null = null;
  const totalsStat = createSharedStat({
    key: totalsKey,
    count: async (at) => {
      const value = await store.totals(at);
      // The parts first: a stored count always has its parts beside it.
      await writeStatParts(
        deps.db,
        [
          value.finalizingNow,
          value.new24h,
          value.recorded?.block ?? 0,
          value.recorded?.at ?? 0,
        ].map((part, index) => [partKeys[index]!, part] as const),
        at,
        observeHistory,
      );
      counted = { at, value };
      return value.onBase;
    },
    clock,
    ttlMs: TOTALS_TTL_MS,
    leaseMs: TOTALS_LEASE_MS,
    store: sqlPublicStatsStore(deps.db, observeHistory),
    failureBackoffMs: TOTALS_TTL_MS,
    staleWhileRevalidate: true,
  });
  /** The parts of the stored count this instance last read, by that count's time. */
  let read: { at: number; value: Totals } | null = null;
  async function totals(): Promise<Totals> {
    const stat = await totalsStat.get();
    if (counted?.at === stat.refreshedAt) return counted.value;
    if (read?.at !== stat.refreshedAt) {
      // A newer count may have written its parts already: they are at most one count newer.
      const parts = await readStatParts(deps.db, partKeys);
      const part = (index: number) => parts.get(partKeys[index]!) ?? 0;
      read = {
        at: stat.refreshedAt,
        value: {
          onBase: stat.value,
          finalizingNow: part(0),
          new24h: part(1),
          recorded: part(2) && part(3) ? { block: part(2), at: part(3) } : null,
        },
      };
    }
    return read.value;
  }

  // Searches: one READ ONLY transaction each with SEARCH_TIMEOUT_MS, kept SEARCH_CACHE_MS by
  // their reading of q (parseQuery) and page; a failed one is never kept.
  type Page = Awaited<ReturnType<typeof store.list>>;
  const searches = new Map<string, { at: number; page: Promise<Page> }>();
  function search(q: string, before: string | undefined): Promise<Page> {
    const key = JSON.stringify([parseQuery(q), before ?? null]);
    const kept = searches.get(key);
    if (kept && clock() - kept.at < SEARCH_CACHE_MS) return kept.page;
    if (searches.size >= SEARCH_CACHE_MAX) searches.clear();
    const page = deps.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY');
      await tx.query(`SET LOCAL statement_timeout = ${SEARCH_TIMEOUT_MS}`);
      return createOnBaseStore(tx, { chainId, uriOrigin: deps.uriOrigin }).list({ before, q });
    });
    searches.set(key, { at: clock(), page });
    page.catch(() => {
      if (searches.get(key)?.page === page) searches.delete(key);
    });
    return page;
  }

  app.get(paths.list, async (request, reply) => {
    await limited(request);
    const parsed = listQuery.safeParse(request.query ?? {});
    if (!parsed.success) return badRequest(reply, 'Use ?q=<search> and ?before=<Base ID>.');
    const q = parsed.data.q?.trim() || undefined;
    // A text the list has no reading for (a transaction hash, a 1-2 character name) is refused by
    // type, never answered as an empty list ("no match" for a search that was not made).
    const unsupported = q === undefined ? null : onBaseUnsupportedReading(q);
    if (unsupported)
      return reply.code(400).header('Cache-Control', 'no-store').send({
        error: ON_BASE_SEARCH_NOTICES[unsupported],
        code: ON_BASE_UNSUPPORTED_CODE,
        reading: unsupported,
      });
    // A transaction hash while its indexes are not built (ON_BASE_TX_SEARCH_AVAILABLE): answered
    // at once, explicitly unavailable, never the full read of the registrations it would take.
    if (q !== undefined && onBaseTxSearchUnavailable(q))
      return reply.code(503).header('Cache-Control', 'no-store').send({
        error: ON_BASE_TX_SEARCH_UNAVAILABLE_MESSAGE,
        code: ON_BASE_TX_SEARCH_UNAVAILABLE_CODE,
      });
    if (q !== undefined && parseQuery(q).name) await searchLimited(request);
    const before = parsed.data.before;
    // A search that cannot finish in time is busy (503); any other failure stays a 500.
    const [page, counted] = await Promise.all([
      q === undefined ? store.list({ before }) : search(q, before).catch(busyOnTimeout),
      totals(),
    ]);
    if (!page)
      return reply
        .code(503)
        .header('Cache-Control', 'no-store')
        .header('Retry-After', '10')
        .send({ error: 'Search is busy right now. Try again shortly.', code: 'busy' });
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
      ...(page.incomplete ? { incomplete: true as const } : {}),
      ...(page.notice ? { notice: page.notice } : {}),
    };
    return reply
      .header('Cache-Control', ON_BASE_LIST_LIVE)
      .header('Vercel-CDN-Cache-Control', ON_BASE_LIST_LIVE_EDGE)
      .send(body);
  });

  // The rated Base IDs: an index-only read of base_rated_agents' primary key (chain_id,
  // rated_base_id), highest first, kept RATED_IDS_TTL_MS per instance with one read in flight.
  // A failed read keeps the last answer; with none, 503.
  let ratedIds: { at: number; ids: string[] } | null = null;
  let ratedRead: Promise<void> | null = null;
  // After a failed read (cold or not), the next one waits RATED_IDS_RETRY_MS: a database that
  // cannot answer is never asked again on every request. The last good answer keeps its own time.
  let ratedRetryAt = 0;
  app.get(paths.rated, async (request, reply) => {
    await limited(request);
    if (!noQuery.safeParse(request.query ?? {}).success)
      return badRequest(reply, 'This address takes no query.');
    if (
      (!ratedIds || clock() - ratedIds.at >= RATED_IDS_TTL_MS) &&
      !ratedRead &&
      clock() >= ratedRetryAt
    )
      ratedRead = deps.db
        .transaction(async (tx) => {
          await tx.query('SET TRANSACTION READ ONLY');
          await tx.query('SET LOCAL statement_timeout = 2000');
          const { rows } = await tx.query<{ id: string }>(
            `SELECT rated_base_id::text AS id FROM base_rated_agents WHERE chain_id = $1
             ORDER BY rated_base_id DESC LIMIT ${ON_BASE_RATED_MAX}`,
            [chainId],
          );
          ratedIds = { at: clock(), ids: rows.map((row) => row.id) };
        })
        .catch(() => {
          ratedRetryAt = clock() + RATED_IDS_RETRY_MS;
        })
        .finally(() => {
          ratedRead = null;
        });
    if (!ratedIds && ratedRead) await ratedRead;
    if (!ratedIds)
      return reply
        .code(503)
        .header('Cache-Control', 'no-store')
        .header('Retry-After', '15')
        .send({ error: 'Rated agents cannot be read right now.', code: 'unavailable' });
    return reply
      .header('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=60')
      .send({ baseIds: ratedIds.ids, asOf: ratedIds.at });
  });

  app.get(`${paths.passport}/:baseId`, async (request, reply) => {
    const params = baseIdParams.safeParse(request.params);
    // A bare '?' or a stray '&' parses as no query but is another edge cache entry: refused too.
    if (!noQuery.safeParse(request.query ?? {}).success || request.url.includes('?'))
      return badRequest(reply, 'This address takes no query.');
    // One address per passport, so the edge cache keeps one entry for it: a padded id is sent on
    // to its canonical form before the limiter and the database.
    if (params.success && PADDED_BASE_ID.test(params.data.baseId))
      return reply
        .code(308)
        .header('Cache-Control', 'public, max-age=3600, s-maxage=86400')
        .header('Location', `${paths.passport}/${BigInt(params.data.baseId).toString(10)}`)
        .send();
    await limited(request);
    const started = clock();
    const stages: Record<string, number | string> = {};
    const found = params.success ? await store.passport(params.data.baseId) : null;
    stages.passportMs = clock() - started;
    if (!found)
      return reply
        .code(404)
        .header('Cache-Control', ON_BASE_NOT_FOUND)
        .send({ error: `No registered agent on ${chainName} with that id.`, code: 'not_found' });
    let at = clock();
    // Base is read only for an id not read at the current head, within the deployment's budget.
    const fresh = await freshPassport(found.passport.baseId);
    if (fresh) await readOwners([found.passport.baseId]);
    stages.ownerMs = clock() - at;
    const owner = ownerOf(found.passport.baseId, found.recorded).owner;
    at = clock();
    const reputation = await reputationOf(
      found.passport.baseId,
      found.passport.agentWallet,
      stages,
      fresh,
    );
    stages.reputationMs = clock() - at;
    // A slow passport names its slow stage in the function log (no addresses, no names).
    const totalMs = clock() - started;
    if (totalMs >= PASSPORT_SLOW_LOG_MS)
      console.log(
        JSON.stringify({
          event: 'passport_slow',
          baseId: found.passport.baseId,
          totalMs,
          ...stages,
        }),
      );
    // The owner can change on Base at any time, so a passport is as short-lived as the list.
    return live(reply).send({ ...found.passport, owner, reputation });
  });

  // Earnings and service payments are addressed by passport short id (any chain): mounted once,
  // with Base's routes.
  if (deps.slug && deps.slug !== 'base') return;
  const other =
    deps.passportsAlsoOn == null
      ? null
      : createOnBaseStore(deps.db, { chainId: deps.passportsAlsoOn, uriOrigin: deps.uriOrigin });
  app.get(EARNINGS_PATHS.passport, async (request, reply) => {
    await limited(request);
    const params = shortParams.safeParse(request.params);
    if (!noQuery.safeParse(request.query ?? {}).success)
      return badRequest(reply, 'This address takes no query.');
    const found = params.success
      ? ((await store.earnings(params.data.short)) ??
        (await other?.earnings(params.data.short)) ??
        null)
      : null;
    if (!found)
      return reply
        .code(404)
        .header('Cache-Control', ON_BASE_NOT_FOUND)
        .send({
          error: `No registered agent on ${chainName} with that passport.`,
          code: 'not_found',
        });
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
    const found = params.success
      ? ((await store.servicePayments(params.data.short)) ??
        (await other?.servicePayments(params.data.short)) ??
        null)
      : null;
    if (!found)
      return reply
        .code(404)
        .header('Cache-Control', ON_BASE_NOT_FOUND)
        .send({
          error: `No registered agent on ${chainName} with that passport.`,
          code: 'not_found',
        });
    // Totals only, built field by field: nothing else of a call can reach the answer.
    const body: PassportServicePayments = {
      paidCalls: found.paidCalls,
      // USDC has 6 decimals; "0.002", never "0.002000".
      totalUsdc: formatUnits(found.totalRaw, 6),
      totalFeeUsdc: formatUnits(found.feeRaw, 6),
      lastPaidAt: found.lastPaidAt,
      // Only for an agent whose first purchase Central City paid; everyone else's answer is unchanged.
      ...(found.sponsoredFirstPurchase
        ? {
            sponsoredFirstPurchase: {
              priceUsdc: formatUnits(found.sponsoredFirstPurchase.priceRaw, 6),
              paidAt: found.sponsoredFirstPurchase.paidAt,
            },
          }
        : {}),
    };
    return live(reply).send(body);
  });
}
