/*
 * The Agent Explorer's "Service calls" view (/explorer/calls, shared/explorer-calls.ts): every paid
 * service call on Central City as the Base transaction that paid for it. Public, read-only,
 * cached. No cookies, no session, no chain read and never a write.
 *
 *   GET /api/public/explorer/calls?cursor=&q=   SERVICE_CALLS_PAGE_SIZE calls, newest first, and
 *                                                the four numbers above the table
 *
 * What a row is. One feed_pay_calls row (server/feed/pay/schema.ts) whose payment Base shows used:
 * payment_state 'settled' on Base mainnet (PAID_CALLS_CHAIN_ID), with its transaction. One call is
 * one row, the same rule as the public paid calls count (server/feed/pay/count-schema.ts); the fee
 * leg has its own columns and never makes a second row.
 *
 * What a row says. Only what Base itself shows anyone: the transaction (tx_hash), its block and
 * time, the payer (the paying wallet's spender account, the address the USDC leaves:
 * base_wallets.spender_address, the same address the engine names as payer), the provider
 * (pay_to), the USDC moved and the service's public title. The Central City fee is shown only when
 * its transfer is on Base (fee_state 'charged'): for a fee-included call (pay_kind 'included') it
 * moved in the payment's own transaction, amount_raw is the provider's 90% and the price is
 * amount_raw + fee_raw; for a fee-on-top call ('x402') it moved in its own transaction
 * (fee_tx_hash). Each answer is built field by field from those columns only: never the agent,
 * the account, the workspace, who called, the request, the result, the call id, the permission or
 * the host. No address is labelled as anyone's.
 *
 * The payment path comes first. A live payment load writes to feed_pay_calls all the time, so:
 *   - every statement runs in a READ ONLY transaction with its own statement_timeout
 *     (PAGE_TIMEOUT_MS, DAY_TIMEOUT_MS); reads never take a lock a payment save waits for;
 *   - each answer (one per search and page) is kept SERVICE_CALLS_CACHE_MS per server, with one
 *     shared read in flight; a failed read is kept as long, so an outage never turns into one
 *     query per request (the shape of server/stats/paid-calls.ts);
 *   - at most SERVICE_CALLS_READ_SLOTS uncached read runs at once per server (the pool is shared
 *     with payment saves); a read that finds it taken serves that key's last answer, or 503 busy;
 *   - searches also share one budget across every client and server (SERVICE_CALLS_SEARCH_GLOBAL);
 *   - the counter row is never waited for longer than COUNTER_READ_BUDGET_MS;
 *   - the edge keeps each answer a few seconds as well (SERVICE_CALLS_LIVE), and the page polls
 *     only its first page, only while visible;
 *   - Total comes from the paid_call_count row (one primary-key read, the public stats' own
 *     reader and cache), never from a count over the table; Per minute is an exact count of the
 *     last minute in the page read (two bounded index ranges, cached with the page);
 *   - Last 24 h and Services used are one bounded aggregate, kept DAY_TTL_MS per server and never
 *     waited for once known (the last value is served while a new one is read).
 *
 * Sponsored first purchases (server/feed/pay/sponsored.ts) are paid calls too: Central City's
 * sponsor account pays the whole price through fee router 3 (FeeCharged payer = the sponsor, 90% to
 * pay_to, the 10% fee to the treasury in the same transaction), and they are stored in their own
 * table, feed_pay_sponsored_calls, never in feed_pay_calls. A row of that table is listed and
 * counted once Base shows it paid: state 'paid', 'delivered' or 'paid_no_result', with its
 * transaction (SPONSORED_PAID). It reads like a fee-included call: the price is gross_raw, the
 * provider got gross_raw - fee_raw, the fee (fee_raw) moved in the same transaction; the payer is
 * the sponsor address (feed_pay_sponsor_key). A public row looks exactly like every other one: no
 * field or label tells a sponsored call apart (only what Base shows). Its time is
 * updated_at: the table has no paid_at, and updated_at is set when the call turns 'paid' and once
 * more when its answer is stored ('delivered' / 'paid_no_result', seconds later), so a sponsored
 * row's time is its last state change after payment, not its block time. Both tables are read
 * apart, each through its own index and LIMITed, and merged (UNION ALL) in one statement: one total
 * order (time, transaction, md5(call_id)) over both, so cursors page through both without a row
 * twice or skipped. Total is the paid_call_count row, which counts the paid sponsored calls too
 * (migration 252, server/feed/pay/sponsored-count-schema.ts), so the homepage and this view read
 * one number; Per minute and the 24 h numbers include them. Without the sponsored tables
 * (an older database) or a known sponsor address, everything reads exactly as before.
 *
 * Indexes. No migration here for feed_pay_calls: it is the payment table, and an index on it needs the
 * product owner's approval. What the reads use today:
 *   - every query repeats the predicate of feed_pay_calls_paid (migration 120: (wallet_id,
 *     settled_at) WHERE payment_state = 'settled' AND tx_hash IS NOT NULL) and bounds settled_at
 *     from below where it can, so the planner reads through that index on settled_at alone (a
 *     skip scan over the wallets on Postgres 18, else a scan of that index, small, without
 *     heap reads for the rows outside the bound):
 *       - the newest page: from the block time of the SERVICE_CALLS_PAGE_SIZE + 1-th newest payment
 *         the paid_call_count row keeps (`recent`);
 *       - an older page: from its cursor's time minus OLDER_WINDOW_MS;
 *     when the bound holds fewer rows than a page (a payment the counter skipped, a reorg, a quiet
 *     hour) the page is read again without it;
 *   - searches and the 24 h numbers have no index for what they match (tx_hash, settled_block,
 *     pay_to) or for a whole day of calls of every kind (feed_pay_calls_included_settled holds
 *     only fee-included calls), so they read the settled calls through feed_pay_calls_paid or a
 *     scan, inside their time limit; searches are cached and rate limited per address, the day
 *     counted once a minute. The indexes to add once approved are in
 *     docs/explorer-service-calls-indexes.md.
 *   - the sponsored calls read through migration 251's partial indexes
 *     (server/feed/pay/sponsored-explorer-schema.ts): the page and the day by
 *     updated_at, searches by tx_hash, block_number or (lower(pay_to), updated_at).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { formatUnits, getAddress } from 'viem';
import { z } from 'zod';
import { feeRef } from '../../protocol/fees/fee-call.js';
import type { Database, Transaction } from '../../database.js';
import { clientAddressKey } from '../../rate-limit.js';
import { createPaidCallsReader, type PaidCallsReader } from '../../stats/paid-calls.js';
import { PAID_CALLS_RECENT_MAX } from '../../../shared/paid-calls.js';
import { WALLET_CHAIN_ID } from '../../../shared/base/wallet-network.js';
import {
  PAID_CALLS_CHAIN_ID,
  SERVICE_CALLS_CURSOR,
  SERVICE_CALLS_PAGE_SIZE,
  SERVICE_CALLS_PATH,
  SERVICE_CALLS_QUERY_MAX,
  parseServiceCallsSearch,
  type ServiceCall,
  type ServiceCallsPage,
  type ServiceCallsSearch,
} from '../../../shared/explorer-calls.js';

/** Browsers always revalidate; shared caches at most 5 s fresh + 5 s stale. */
export const SERVICE_CALLS_LIVE = 'public, max-age=0, s-maxage=5, stale-while-revalidate=5';
/** Vercel's edge only (never forwarded to browsers): the same 10 s bound. */
export const SERVICE_CALLS_LIVE_EDGE = 'public, max-age=5, stale-while-revalidate=5';
/** Per client address, under the degraded 'ip' prefix like the other explorer routes. */
export const SERVICE_CALLS_RATE = { max: 60, windowMs: 60_000 } as const;
/** Each answer (per search and page) is kept this long per server, one read in flight. */
export const SERVICE_CALLS_CACHE_MS = 5_000;
/** Answers kept per server; past this, expired ones go first, then all. */
export const SERVICE_CALLS_CACHE_MAX = 256;
/** The time limit of one page read (its statements together run inside one transaction). */
export const PAGE_TIMEOUT_MS = 2_000;
/** Last 24 h and Services used: counted at most this often per server, with this time limit. */
export const DAY_TTL_MS = 60_000;
export const DAY_TIMEOUT_MS = 3_000;
/** Once a 24 h value is known, an answer waits at most this long for a newer one. */
export const DAY_READ_BUDGET_MS = 250;
/**
 * An older page first looks at most this far back from its cursor (through feed_pay_calls_paid,
 * like the newest page), and reads without the bound only when that holds less than a page.
 */
export const OLDER_WINDOW_MS = 60 * 60 * 1000;
/**
 * Uncached database reads this route runs at once per server (pages, searches and the 24 h count
 * together). The application pool has 3 clients and payment saves use the same pool, so the
 * explorer never holds more than one of them. A read that finds the slot taken serves the last
 * answer it has for that page or search, or 503 with Retry-After.
 */
export const SERVICE_CALLS_READ_SLOTS = 1;
/** Searches across every client and server together (shared limiter, fail-closed). */
export const SERVICE_CALLS_SEARCH_GLOBAL = { max: 30, windowMs: 60_000 } as const;
/** How long an answer waits for the counter row before using its last good copy. */
export const COUNTER_READ_BUDGET_MS = 250;
/** "Per minute now": payments whose block is at most this old. */
export const PER_MINUTE_WINDOW_MS = 60_000;
/**
 * The route's "Per minute": the average over this many minutes, not one exact minute. Payments are
 * recorded in settlement batches, so one minute read 0, 19, 46 and 73 within 40 s while Base
 * showed a steady ~99 a minute (23 Oct 2026), and the Explorer often showed 0.
 */
export const PER_MINUTE_AVERAGE_MINUTES = 5;
/** Whether the sponsored tables exist and the sponsor's address are looked up at most this often. */
export const SPONSOR_TTL_MS = 60_000;
/**
 * A search's sponsored matches are counted up to this many (a search for the sponsor's own
 * address matches every sponsored call): past it, `matches` is a lower bound.
 */
export const SPONSORED_MATCHES_MAX = 100_000;

/**
 * Below this span the kept times are never extrapolated: sponsored calls are recorded paid in
 * batches (up to 50 rows within about a second), and 64 times spanning under a second would read
 * as thousands a minute.
 */
export const PER_MINUTE_MIN_SPAN_MS = 10_000;

/**
 * Paid calls in the last minute, from the counter row's recent block times (newest first, at
 * most PAID_CALLS_RECENT_MAX of them). When every kept time is inside the minute the row holds
 * fewer than really happened, so the count would stop at the cap: then the rate is measured from
 * how fast those calls came (their count over the time they span), never capped, and only when
 * they span at least PER_MINUTE_MIN_SPAN_MS (else the count kept). A rough figure: the route's
 * Per minute is an exact count (paidMinute below); this is only its last-resort estimate.
 */
export function perMinuteOf(recent: readonly number[], asOf: number): number {
  const inWindow = recent.filter((at) => asOf - at <= PER_MINUTE_WINDOW_MS);
  if (inWindow.length < PAID_CALLS_RECENT_MAX || inWindow.length !== recent.length)
    return inWindow.length;
  const span = Math.max(...inWindow) - Math.min(...inWindow);
  if (span < PER_MINUTE_MIN_SPAN_MS) return inWindow.length;
  return Math.max(
    inWindow.length,
    Math.round(((inWindow.length - 1) * PER_MINUTE_WINDOW_MS) / span),
  );
}
const DAY_MS = 24 * 60 * 60 * 1000;

// Only these keys: any other query string would be a separate edge-cache entry.
const pageQuery = z
  .object({
    q: z.string().max(SERVICE_CALLS_QUERY_MAX).optional(),
    cursor: z.string().regex(SERVICE_CALLS_CURSOR).optional(),
  })
  .strict();

/** One stored call, only the columns a public row is built from. */
interface CallRow {
  tx_hash: string;
  settled_block: string | number | null;
  settled_at: string | number;
  payer: string;
  pay_to: string;
  service_title: string;
  amount_raw: string;
  fee_raw: string;
  fee_state: string | null;
  fee_tx_hash: string | null;
  fee_block: string | number | null;
  pay_kind: string;
  /** Internal only: never in an answer. Its hash orders calls that share a block time and tx. */
  call_id: string;
  /** md5(call_id): the opaque tie-breaker in the cursor (calls of one settleBatch share a tx). */
  row_key: string;
  /**
   * Internal only, never in an answer: the row is from feed_pay_sponsored_calls (the page's
   * bound applies to the feed's rows only). Absent without the sponsored side.
   */
  sponsored?: boolean | null;
}

/**
 * The columns read, and nothing else. The payer comes from the paying wallet's row by its
 * primary key (base_wallets.wallet_id).
 */
const COLUMNS = `c.tx_hash, c.settled_block::text AS settled_block, c.settled_at::text AS settled_at,
  w.spender_address AS payer, c.pay_to, c.service_title, c.amount_raw::text AS amount_raw,
  c.fee_raw::text AS fee_raw, c.fee_state, c.fee_tx_hash, c.fee_block::text AS fee_block,
  c.pay_kind, c.call_id, md5(c.call_id) AS row_key`;

/**
 * Settled calls on one chain with their transaction: the predicate of feed_pay_calls_paid
 * (migration 120) plus the chain, so the planner can read through that index.
 */
const SETTLED = `c.chain_id = $1 AND c.payment_state = 'settled' AND c.tx_hash IS NOT NULL
  AND c.settled_at IS NOT NULL`;

/**
 * A sponsored call Base shows paid, with its transaction: the predicate of migration 251's partial
 * indexes (server/feed/pay/sponsored-explorer-schema.ts), repeated so the planner reads through
 * them.
 */
const SPONSORED_PAID = `s.state IN ('paid','delivered','paid_no_result') AND s.tx_hash IS NOT NULL`;

/**
 * The same columns for a sponsored call, as a fee-included one: the price is gross_raw, the
 * provider's share gross_raw - fee_raw, the fee charged in the payment's own transaction. The
 * payer is the sponsor address (a parameter); the title is the listed service's, by its primary
 * key (empty when that table is absent).
 */
const sponsoredColumns = (payer: string, titles: boolean) => `s.tx_hash,
  s.block_number::text AS settled_block, s.updated_at::text AS settled_at, ${payer}::text AS payer,
  s.pay_to, ${titles ? `coalesce((SELECT v.title FROM feed_services v WHERE v.id = s.service_id), '')` : `''::text`} AS service_title,
  (s.gross_raw - s.fee_raw)::text AS amount_raw, s.fee_raw::text AS fee_raw,
  'charged'::text AS fee_state, NULL::text AS fee_tx_hash, NULL::text AS fee_block,
  'included'::text AS pay_kind, s.call_id, md5(s.call_id) AS row_key, true AS sponsored,
  s.updated_at AS sort_at`;

/** The sponsored side of the page, when the tables exist and the sponsor is known. */
interface Sponsor {
  /** The sponsor account's address, lower case. */
  address: string;
  /** feed_services exists (the services' titles). */
  titles: boolean;
}

/**
 * A search as SQL over the sponsored calls `s`, its value at `at` (on the page, $2 as the feed's):
 * '' when every sponsored call matches (the sponsor's own address is the payer of all of them).
 */
function sponsoredSearchSql(search: ServiceCallsSearch, sponsor: Sponsor, at: string): string {
  switch (search.kind) {
    case 'tx':
      return `s.tx_hash = ${at}`;
    case 'block':
      return `s.block_number = ${at}`;
    case 'address':
      return search.address === sponsor.address ? '' : `lower(s.pay_to) = ${at}`;
  }
}

/** A search as SQL over `c`, its value at $2. */
function searchSql(search: ServiceCallsSearch): { sql: string; value: string | number } {
  switch (search.kind) {
    case 'tx':
      return { sql: 'c.tx_hash = $2', value: search.hash };
    case 'block':
      return { sql: 'c.settled_block = $2', value: search.block };
    case 'address':
      // The provider, or the payer: the spender account of the paying wallet, on this chain.
      return {
        sql: `(lower(c.pay_to) = $2 OR c.wallet_id IN (SELECT wallet_id FROM base_wallets
               WHERE chain_id = $1 AND lower(spender_address) = $2))`,
        value: search.address,
      };
  }
}

/** The read slot was taken and no earlier answer exists for that page or search. */
class ServiceCallsBusy extends Error {}

const num = (value: string | number | null) => (value === null ? null : Number(value));
const usdc = (raw: bigint) => formatUnits(raw, 6);

/** One public row, built field by field from the columns above. */
export function publicCall(row: CallRow): ServiceCall {
  const amount = BigInt(row.amount_raw);
  const fee = BigInt(row.fee_raw);
  const included = row.pay_kind === 'included';
  const block = num(row.settled_block);
  // The fee only when its transfer is on Base: in the payment's own transaction (included), or
  // in its own one (on top). A fee still on its way, failed or never owed is not shown.
  const charged = row.fee_state === 'charged' && fee > 0n;
  return {
    tx_hash: row.tx_hash,
    block,
    time: Number(row.settled_at),
    payer: getAddress(row.payer),
    provider: getAddress(row.pay_to),
    service: row.service_title,
    // Included: the price, both legs in one transaction. On top: what this transaction moved.
    amount: usdc(included ? amount + fee : amount),
    provider_amount: usdc(amount),
    fee:
      charged && included
        ? {
            model: 'included',
            amount: usdc(fee),
            tx_hash: row.fee_tx_hash ?? row.tx_hash,
            block: num(row.fee_block) ?? block,
          }
        : charged && row.fee_tx_hash
          ? {
              model: 'on_top',
              amount: usdc(fee),
              tx_hash: row.fee_tx_hash,
              block: num(row.fee_block),
            }
          : null,
    // The FeeCharged ref of this payment (keccak256 of its intent id, public on Base for a router
    // payment): unique per call, so a page can key calls that share one batch transaction.
    ref: feeRef(row.call_id),
    status: 'settled',
  };
}

/**
 * The cursor after a row: its time, transaction and opaque row key. Calls settled in one batch
 * share time and transaction (batch lane), so the key keeps pages from skipping or repeating them.
 */
export const cursorOf = (row: { time: number; tx_hash: string; row_key: string }) =>
  `${row.time}_${row.tx_hash}_${row.row_key}`;

export interface ServiceCallsRouteDeps {
  db: Database;
  /** The network listed; Base mainnet unless a test says otherwise. */
  chainId?: number;
  now?: () => number;
  /** The shared rate limiter (server/app.ts); absent in unit tests. */
  limit?: (key: string, max: number, windowMs: number) => Promise<void>;
  /** The paid_call_count reader; by default one of this route's own (5 s cache). */
  counter?: PaidCallsReader;
  /** The network sponsored first purchases are paid on (WALLET_CHAIN_ID); listed only there. */
  sponsoredChainId?: number;
}

interface PageRead {
  items: ServiceCall[];
  nextCursor: string | null;
  matches: number | null;
  /** Paid service calls in the minute before this read, counted exactly (paidMinute). */
  perMinute: number;
}

export function registerServiceCallsRoutes(app: FastifyInstance, deps: ServiceCallsRouteDeps) {
  const chainId = deps.chainId ?? PAID_CALLS_CHAIN_ID;
  const clock = deps.now ?? Date.now;
  const counter = deps.counter ?? createPaidCallsReader({ db: deps.db, clock, chainId: chainId });

  /**
   * The counter row, never waited for longer than COUNTER_READ_BUDGET_MS: past that (or on a
   * failure) its last good copy, or null. The read itself carries on and fills the reader's cache.
   */
  async function counterSnapshot() {
    const fallback = () => counter.lastGood?.() ?? null;
    const read = counter.read().catch(() => fallback());
    const late = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), COUNTER_READ_BUDGET_MS).unref?.(),
    );
    return (await Promise.race([read, late])) ?? fallback();
  }

  /** One slot set for every uncached read of this route on this server. */
  let readsInFlight = 0;
  const takeSlot = () => {
    if (readsInFlight >= SERVICE_CALLS_READ_SLOTS) return false;
    readsInFlight += 1;
    return true;
  };
  const releaseSlot = () => {
    readsInFlight = Math.max(0, readsInFlight - 1);
  };

  /** A READ ONLY transaction with its own time limit: it can neither write nor run long. */
  const readOnly = <T>(timeoutMs: number, run: (tx: Transaction) => Promise<T>) =>
    deps.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY');
      await tx.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
      return run(tx);
    });

  /**
   * The sponsored side, when its tables exist and the sponsor's address is recorded; null keeps
   * every read as before. Looked up at most every SPONSOR_TTL_MS, inside the read's own
   * transaction.
   */
  const sponsoredChain = chainId === (deps.sponsoredChainId ?? WALLET_CHAIN_ID);
  let sponsorKnown: { at: number; value: Sponsor | null } | null = null;
  async function sponsorIn(tx: Transaction): Promise<Sponsor | null> {
    if (!sponsoredChain) return null;
    const at = clock();
    if (sponsorKnown && at - sponsorKnown.at < SPONSOR_TTL_MS) return sponsorKnown.value;
    const { rows } = await tx.query<{ calls: boolean; key: boolean; titles: boolean }>(
      `SELECT to_regclass('feed_pay_sponsored_calls') IS NOT NULL AS calls,
              to_regclass('feed_pay_sponsor_key') IS NOT NULL AS key,
              to_regclass('feed_services') IS NOT NULL AS titles`,
    );
    let value: Sponsor | null = null;
    if (rows[0]?.calls && rows[0]?.key) {
      const { rows: keys } = await tx.query<{ address: string }>(
        `SELECT address FROM feed_pay_sponsor_key WHERE purpose = 'sfp_sponsor'`,
      );
      const address = keys[0]?.address;
      if (address && /^0x[0-9a-fA-F]{40}$/.test(address))
        value = { address: address.toLowerCase(), titles: !!rows[0]?.titles };
    }
    sponsorKnown = { at, value };
    return value;
  }

  /**
   * One page (PAGE_SIZE + 1 rows tell whether another follows). With a sponsor: the newest
   * PAGE_SIZE + 1 of each table after the cursor, merged in the one order (at most twice that).
   */
  async function readPage(
    tx: Transaction,
    options: {
      cursor: { at: number; tx: string; key: string | null } | null;
      search: ServiceCallsSearch | null;
    },
    floor: number | null,
    sponsor: Sponsor | null,
  ): Promise<CallRow[]> {
    const params: unknown[] = [chainId];
    const where = [SETTLED];
    const sponsoredWhere = [SPONSORED_PAID];
    if (options.search) {
      const { sql, value } = searchSql(options.search);
      params.push(value);
      where.push(sql);
      const own = sponsor ? sponsoredSearchSql(options.search, sponsor, '$2') : '';
      if (own) sponsoredWhere.push(own);
    }
    if (options.cursor?.key) {
      params.push(options.cursor.at, options.cursor.tx, options.cursor.key);
      const after = `($${params.length - 2}::bigint, $${params.length - 1}::text, $${params.length}::text)`;
      where.push(`(c.settled_at, c.tx_hash, md5(c.call_id)) < ${after}`);
      sponsoredWhere.push(`(s.updated_at, s.tx_hash, md5(s.call_id)) < ${after}`);
    } else if (options.cursor) {
      // A cursor from before the row key (time and tx only): as before.
      params.push(options.cursor.at, options.cursor.tx);
      const after = `($${params.length - 1}::bigint, $${params.length}::text)`;
      where.push(`(c.settled_at, c.tx_hash) < ${after}`);
      sponsoredWhere.push(`(s.updated_at, s.tx_hash) < ${after}`);
    }
    // The floor comes from the counter row (feed_pay_calls only): never on the sponsored side.
    if (floor !== null) {
      params.push(floor);
      where.push(`c.settled_at >= $${params.length}::bigint`);
    }
    const feed = `SELECT ${COLUMNS}${sponsor ? ', false AS sponsored, c.settled_at AS sort_at' : ''}
       FROM feed_pay_calls c JOIN base_wallets w ON w.wallet_id = c.wallet_id
       WHERE ${where.join(' AND ')}
       ORDER BY c.settled_at DESC, c.tx_hash DESC, md5(c.call_id) DESC
       LIMIT ${SERVICE_CALLS_PAGE_SIZE + 1}`;
    if (!sponsor) return (await tx.query<CallRow>(feed, params)).rows;
    params.push(sponsor.address);
    const { rows } = await tx.query<CallRow>(
      `SELECT * FROM (
         (${feed})
         UNION ALL
         (SELECT ${sponsoredColumns(`$${params.length}`, sponsor.titles)}
          FROM feed_pay_sponsored_calls s
          WHERE ${sponsoredWhere.join(' AND ')}
          ORDER BY s.updated_at DESC, s.tx_hash DESC, md5(s.call_id) DESC
          LIMIT ${SERVICE_CALLS_PAGE_SIZE + 1})
       ) u ORDER BY u.sort_at DESC, u.tx_hash DESC, u.row_key DESC`,
      params,
    );
    return rows;
  }

  /** A search's sponsored matches, counted up to SPONSORED_MATCHES_MAX. */
  async function sponsoredMatches(
    tx: Transaction,
    search: ServiceCallsSearch,
    sponsor: Sponsor,
  ): Promise<number> {
    const own = sponsoredSearchSql(search, sponsor, '$1');
    const { rows } = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT 1 FROM feed_pay_sponsored_calls s
         WHERE ${SPONSORED_PAID}${own ? ` AND ${own}` : ''}
         LIMIT ${SPONSORED_MATCHES_MAX}) m`,
      own ? [searchSql(search).value] : [],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Paid service calls a minute, averaged over the last PER_MINUTE_AVERAGE_MINUTES on the
   * database clock (rounded), each counted exactly:
   * the settled calls (block time, through feed_pay_calls_paid: the SETTLED predicate and a
   * settled_at bound) plus, with the sponsored side, the sponsored calls recorded paid in that
   * minute (updated_at, through migration 251's feed_pay_sponsored_calls_paid_time). One
   * statement, two bounded index ranges. Not from the counter row's `recent`: its 64 times can be
   * one batch of sponsored calls recorded within a second.
   */
  async function paidMinute(tx: Transaction, sponsor: Sponsor | null): Promise<number> {
    const since = `(extract(epoch FROM now()) * 1000)::bigint - $2::bigint`;
    const { rows } = await tx.query<{ n: string }>(
      `SELECT ((SELECT count(*) FROM feed_pay_calls c WHERE ${SETTLED} AND c.settled_at > ${since})${
        sponsor
          ? ` + (SELECT count(*) FROM feed_pay_sponsored_calls s
                  WHERE ${SPONSORED_PAID} AND s.updated_at > ${since})`
          : ''
      })::text AS n`,
      [chainId, PER_MINUTE_AVERAGE_MINUTES * PER_MINUTE_WINDOW_MS],
    );
    return Math.round(Number(rows[0]?.n ?? 0) / PER_MINUTE_AVERAGE_MINUTES);
  }

  /**
   * The lower bound of the newest page: the block time of the PAGE_SIZE + 1-th newest payment the
   * counter row keeps, so the read touches only the newest entries. null when it keeps too few.
   */
  async function newestFloor(): Promise<number | null> {
    const snapshot = await counterSnapshot();
    const recent = [...(snapshot?.recent ?? [])].sort((a, b) => b - a);
    return recent.length > SERVICE_CALLS_PAGE_SIZE ? recent[SERVICE_CALLS_PAGE_SIZE]! : null;
  }

  async function loadPage(
    cursor: { at: number; tx: string; key: string | null } | null,
    search: ServiceCallsSearch | null,
  ): Promise<PageRead> {
    // An older page is bounded the same way by its cursor: at most OLDER_WINDOW_MS older.
    const floor = search ? null : cursor ? cursor.at - OLDER_WINDOW_MS : await newestFloor();
    return readOnly(PAGE_TIMEOUT_MS, async (tx) => {
      const sponsor = await sponsorIn(tx);
      let rows = await readPage(tx, { cursor, search }, floor, sponsor);
      // The bound found fewer rows than a page (the counter skipped a payment, one left 'settled'
      // after a reorg, or payments are sparse there): the same page without it. Only the feed's
      // own rows decide: the bound is never applied to the sponsored side.
      if (floor !== null && rows.filter((row) => !row.sponsored).length <= SERVICE_CALLS_PAGE_SIZE)
        rows = await readPage(tx, { cursor, search }, null, sponsor);
      let matches: number | null = null;
      if (search && !cursor) {
        const { sql, value } = searchSql(search);
        const counted = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM feed_pay_calls c WHERE ${SETTLED} AND ${sql}`,
          [chainId, value],
        );
        matches = Number(counted.rows[0]?.n ?? 0);
        if (sponsor) matches += await sponsoredMatches(tx, search, sponsor);
      }
      const perMinute = await paidMinute(tx, sponsor);
      const page = rows.slice(0, SERVICE_CALLS_PAGE_SIZE);
      const items = page.map(publicCall);
      const last = page.at(-1);
      return {
        items,
        nextCursor:
          rows.length > SERVICE_CALLS_PAGE_SIZE && last
            ? cursorOf({
                time: Number(last.settled_at),
                tx_hash: last.tx_hash,
                row_key: last.row_key,
              })
            : null,
        matches,
        perMinute,
      };
    });
  }

  // Each answer kept SERVICE_CALLS_CACHE_MS, one read in flight per answer; a failure is kept
  // as long (the next request after it reads again).
  const pages = new Map<string, { until: number; value: Promise<PageRead> }>();
  // The last good answer per key, served when the read slot is taken (bounded like `pages`).
  const stale = new Map<string, PageRead>();
  function cachedPage(
    key: string,
    cursor: { at: number; tx: string; key: string | null } | null,
    search: ServiceCallsSearch | null,
  ): Promise<PageRead> {
    const now = clock();
    const hit = pages.get(key);
    if (hit && now < hit.until) return hit.value;
    // The slot is taken: the last answer for this key, or busy (503 with Retry-After).
    if (!takeSlot()) {
      const last = stale.get(key);
      return last ? Promise.resolve(last) : Promise.reject(new ServiceCallsBusy());
    }
    if (pages.size >= SERVICE_CALLS_CACHE_MAX) {
      for (const [entry, value] of pages) if (now >= value.until) pages.delete(entry);
      if (pages.size >= SERVICE_CALLS_CACHE_MAX) pages.clear();
    }
    if (stale.size >= SERVICE_CALLS_CACHE_MAX) stale.clear();
    const value = loadPage(cursor, search).finally(releaseSlot);
    value.then((page) => stale.set(key, page)).catch(() => undefined);
    // Counted from the start of the read, like the paid calls reader.
    pages.set(key, { until: now + SERVICE_CALLS_CACHE_MS, value });
    return value;
  }

  // Last 24 h and Services used: one aggregate over the settled calls of the last day, at most
  // every DAY_TTL_MS per server. Once known, an answer never waits for a newer one longer than
  // DAY_READ_BUDGET_MS; a failed count keeps the last one (or null) until the next try.
  let day: {
    calls: number;
    services: number;
    valueRaw: string;
    feeRaw: string;
    /** When the count was taken (this server's clock), sent as day_as_of. */
    at: number;
  } | null = null;
  let dayTriedAt = -Infinity;
  let dayInflight: Promise<void> | null = null;
  function readDay(): Promise<void> {
    if (dayInflight) return dayInflight;
    if (clock() - dayTriedAt < DAY_TTL_MS) return Promise.resolve();
    // Never next to another read of this route: the last numbers stay until the slot is free.
    if (!takeSlot()) return Promise.resolve();
    dayTriedAt = clock();
    const since = dayTriedAt - DAY_MS;
    dayInflight = readOnly(DAY_TIMEOUT_MS, async (tx) => {
      const sponsor = await sponsorIn(tx);
      if (!sponsor) {
        const rows = await tx.query<{
          calls: string;
          services: string;
          value_raw: string;
          fee_raw: string;
        }>(
          `SELECT count(*)::text AS calls, count(DISTINCT c.service_id)::text AS services,
                  coalesce(sum(c.amount_raw + CASE WHEN c.fee_state = 'charged' THEN c.fee_raw ELSE 0 END), 0)::text AS value_raw,
                  coalesce(sum(c.fee_raw) FILTER (WHERE c.fee_state = 'charged'), 0)::text AS fee_raw
           FROM feed_pay_calls c WHERE ${SETTLED} AND c.settled_at > $2::bigint`,
          [chainId, since],
        );
        return rows;
      }
      // The sponsored calls of the day as well, each table through its own index: the price
      // (gross_raw, fee included) and the fee charged in the same transaction (fee_raw).
      const counted = await tx.query<{
        calls: string;
        services: string;
        value_raw: string;
        fee_raw: string;
      }>(
        `SELECT count(*)::text AS calls, count(DISTINCT d.service_id)::text AS services,
                coalesce(sum(d.value_raw), 0)::text AS value_raw,
                coalesce(sum(d.fee_raw), 0)::text AS fee_raw
         FROM (
           SELECT c.service_id,
                  c.amount_raw + CASE WHEN c.fee_state = 'charged' THEN c.fee_raw ELSE 0 END AS value_raw,
                  CASE WHEN c.fee_state = 'charged' THEN c.fee_raw ELSE 0 END AS fee_raw
           FROM feed_pay_calls c WHERE ${SETTLED} AND c.settled_at > $2::bigint
           UNION ALL
           SELECT s.service_id, s.gross_raw, s.fee_raw
           FROM feed_pay_sponsored_calls s WHERE ${SPONSORED_PAID} AND s.updated_at > $2::bigint
         ) d`,
        [chainId, since],
      );
      return counted;
    })
      .then(({ rows }) => {
        day = {
          calls: Number(rows[0]?.calls ?? 0),
          services: Number(rows[0]?.services ?? 0),
          valueRaw: rows[0]?.value_raw ?? '0',
          feeRaw: rows[0]?.fee_raw ?? '0',
          at: since + DAY_MS,
        };
      })
      .catch((error: unknown) => {
        // Kept: the last value (or null) with its own time (day_as_of), until the next try.
        const code = (error as { code?: unknown } | null)?.code;
        console.warn(
          `[explorer-calls] 24 h count failed: ${typeof code === 'string' ? code : 'error'} ${
            error instanceof Error ? error.message.slice(0, 160) : ''
          }`.trim(),
        );
      })
      .finally(() => {
        releaseSlot();
        dayInflight = null;
      });
    return dayInflight;
  }
  async function dayNow() {
    const read = readDay();
    if (day === null) await read;
    else
      await Promise.race([
        read,
        new Promise<void>((resolve) => setTimeout(resolve, DAY_READ_BUDGET_MS).unref?.()),
      ]);
    return day;
  }

  /** Total from the counter row; null when it cannot be read. */
  async function counted() {
    const snapshot = await counterSnapshot();
    return { total: snapshot ? snapshot.total : null };
  }

  const badRequest = (reply: FastifyReply, error: string) =>
    reply.code(400).header('Cache-Control', 'no-store').send({ error, code: 'bad_request' });
  const limited = (request: FastifyRequest) =>
    deps.limit?.(
      `ip:explorercalls:${clientAddressKey(request.ip)}`,
      SERVICE_CALLS_RATE.max,
      SERVICE_CALLS_RATE.windowMs,
    );

  app.get(SERVICE_CALLS_PATH, async (request, reply) => {
    await limited(request);
    const parsed = pageQuery.safeParse(request.query ?? {});
    if (!parsed.success)
      return badRequest(
        reply,
        'Use ?q=<transaction hash, block number or 0x address> and ?cursor=<next_cursor>.',
      );
    const text = parsed.data.q?.trim() ?? '';
    const search = text ? parseServiceCallsSearch(text) : null;
    if (text && !search)
      return badRequest(
        reply,
        'Search by a transaction hash (0x and 64 hex), a block number or an address (0x and 40 hex).',
      );
    const match = parsed.data.cursor ? SERVICE_CALLS_CURSOR.exec(parsed.data.cursor) : null;
    const cursor = match ? { at: Number(match[1]), tx: match[2]!, key: match[3] ?? null } : null;
    const key = `${search ? JSON.stringify(search) : ''}|${parsed.data.cursor ?? ''}`;
    // Searches scan the payment table: one budget for all clients and servers together.
    if (search)
      await deps.limit?.(
        'explorer-calls-search:all',
        SERVICE_CALLS_SEARCH_GLOBAL.max,
        SERVICE_CALLS_SEARCH_GLOBAL.windowMs,
      );
    let page: PageRead;
    try {
      page = await cachedPage(key, cursor, search);
    } catch (error) {
      if (error instanceof ServiceCallsBusy)
        return reply
          .code(503)
          .header('Cache-Control', 'no-store')
          .header('Retry-After', '5')
          .send({ error: 'Busy, try again in a few seconds.', code: 'busy' });
      return reply
        .code(503)
        .header('Cache-Control', 'no-store')
        .send({ error: 'Service calls cannot be read right now.', code: 'unavailable' });
    }
    const now = clock();
    const [numbers, day24] = await Promise.all([counted(), dayNow()]);
    // Built field by field: nothing else can reach the answer.
    const body: ServiceCallsPage = {
      // The counter row: feed_pay_calls and the paid sponsored calls (migration 252).
      total: numbers.total,
      last24h: day24?.calls ?? null,
      // Counted exactly with the page read (paidMinute), kept as long as the page.
      perMinute: page.perMinute,
      services24h: day24?.services ?? null,
      value24hRaw: day24?.valueRaw ?? null,
      fee24hRaw: day24?.feeRaw ?? null,
      day_as_of: day24 ? new Date(day24.at).toISOString() : null,
      as_of: new Date(now).toISOString(),
      matches: page.matches,
      items: page.items,
      next_cursor: page.nextCursor,
    };
    return reply
      .header('Cache-Control', SERVICE_CALLS_LIVE)
      .header('Vercel-CDN-Cache-Control', SERVICE_CALLS_LIVE_EDGE)
      .send(body);
  });
}
