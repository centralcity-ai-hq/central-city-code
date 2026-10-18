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
 *   - Total and Per minute come from the paid_call_count row (one primary-key read, the public
 *     stats' own reader and cache), never from a count over the table;
 *   - Last 24 h and Services used are one bounded aggregate, kept DAY_TTL_MS per server and never
 *     waited for once known (the last value is served while a new one is read).
 *
 * Indexes. No migration here: feed_pay_calls is the payment table, and an index on it needs the
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
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { formatUnits, getAddress } from 'viem';
import { z } from 'zod';
import type { Database, Transaction } from '../../database.js';
import { clientAddressKey } from '../../rate-limit.js';
import { createPaidCallsReader, type PaidCallsReader } from '../../stats/paid-calls.js';
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
}

/**
 * The columns read, and nothing else. The payer comes from the paying wallet's row by its
 * primary key (base_wallets.wallet_id).
 */
const COLUMNS = `c.tx_hash, c.settled_block::text AS settled_block, c.settled_at::text AS settled_at,
  w.spender_address AS payer, c.pay_to, c.service_title, c.amount_raw::text AS amount_raw,
  c.fee_raw::text AS fee_raw, c.fee_state, c.fee_tx_hash, c.fee_block::text AS fee_block,
  c.pay_kind`;

/**
 * Settled calls on one chain with their transaction: the predicate of feed_pay_calls_paid
 * (migration 120) plus the chain, so the planner can read through that index.
 */
const SETTLED = `c.chain_id = $1 AND c.payment_state = 'settled' AND c.tx_hash IS NOT NULL
  AND c.settled_at IS NOT NULL`;

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
    status: 'settled',
  };
}

/** The cursor after a row: its time and transaction. */
export const cursorOf = (call: Pick<ServiceCall, 'time' | 'tx_hash'>) =>
  `${call.time}_${call.tx_hash}`;

export interface ServiceCallsRouteDeps {
  db: Database;
  /** The network listed; Base mainnet unless a test says otherwise. */
  chainId?: number;
  now?: () => number;
  /** The shared rate limiter (server/app.ts); absent in unit tests. */
  limit?: (key: string, max: number, windowMs: number) => Promise<void>;
  /** The paid_call_count reader; by default one of this route's own (5 s cache). */
  counter?: PaidCallsReader;
}

interface PageRead {
  items: ServiceCall[];
  nextCursor: string | null;
  matches: number | null;
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

  /** One page (PAGE_SIZE + 1 rows tell whether another follows). */
  async function readPage(
    tx: Transaction,
    options: { cursor: { at: number; tx: string } | null; search: ServiceCallsSearch | null },
    floor: number | null,
  ): Promise<CallRow[]> {
    const params: unknown[] = [chainId];
    const where = [SETTLED];
    if (options.search) {
      const { sql, value } = searchSql(options.search);
      params.push(value);
      where.push(sql);
    }
    if (options.cursor) {
      params.push(options.cursor.at, options.cursor.tx);
      where.push(
        `(c.settled_at, c.tx_hash) < ($${params.length - 1}::bigint, $${params.length}::text)`,
      );
    }
    if (floor !== null) {
      params.push(floor);
      where.push(`c.settled_at >= $${params.length}::bigint`);
    }
    const { rows } = await tx.query<CallRow>(
      `SELECT ${COLUMNS}
       FROM feed_pay_calls c JOIN base_wallets w ON w.wallet_id = c.wallet_id
       WHERE ${where.join(' AND ')}
       ORDER BY c.settled_at DESC, c.tx_hash DESC
       LIMIT ${SERVICE_CALLS_PAGE_SIZE + 1}`,
      params,
    );
    return rows;
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
    cursor: { at: number; tx: string } | null,
    search: ServiceCallsSearch | null,
  ): Promise<PageRead> {
    // An older page is bounded the same way by its cursor: at most OLDER_WINDOW_MS older.
    const floor = search ? null : cursor ? cursor.at - OLDER_WINDOW_MS : await newestFloor();
    return readOnly(PAGE_TIMEOUT_MS, async (tx) => {
      let rows = await readPage(tx, { cursor, search }, floor);
      // The bound found fewer rows than a page (the counter skipped a payment, one left 'settled'
      // after a reorg, or payments are sparse there): the same page without it.
      if (floor !== null && rows.length <= SERVICE_CALLS_PAGE_SIZE)
        rows = await readPage(tx, { cursor, search }, null);
      let matches: number | null = null;
      if (search && !cursor) {
        const { sql, value } = searchSql(search);
        const counted = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM feed_pay_calls c WHERE ${SETTLED} AND ${sql}`,
          [chainId, value],
        );
        matches = Number(counted.rows[0]?.n ?? 0);
      }
      const items = rows.slice(0, SERVICE_CALLS_PAGE_SIZE).map(publicCall);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > SERVICE_CALLS_PAGE_SIZE && last ? cursorOf(last) : null,
        matches,
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
    cursor: { at: number; tx: string } | null,
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
  let day: { calls: number; services: number; valueRaw: string; feeRaw: string } | null = null;
  let dayTriedAt = -Infinity;
  let dayInflight: Promise<void> | null = null;
  function readDay(): Promise<void> {
    if (dayInflight) return dayInflight;
    if (clock() - dayTriedAt < DAY_TTL_MS) return Promise.resolve();
    // Never next to another read of this route: the last numbers stay until the slot is free.
    if (!takeSlot()) return Promise.resolve();
    dayTriedAt = clock();
    const since = dayTriedAt - DAY_MS;
    dayInflight = readOnly(DAY_TIMEOUT_MS, (tx) =>
      tx.query<{ calls: string; services: string; value_raw: string; fee_raw: string }>(
        `SELECT count(*)::text AS calls, count(DISTINCT c.service_id)::text AS services,
                coalesce(sum(c.amount_raw + c.fee_raw), 0)::text AS value_raw,
                coalesce(sum(c.fee_raw), 0)::text AS fee_raw
         FROM feed_pay_calls c WHERE ${SETTLED} AND c.settled_at > $2::bigint`,
        [chainId, since],
      ),
    )
      .then(({ rows }) => {
        day = {
          calls: Number(rows[0]?.calls ?? 0),
          services: Number(rows[0]?.services ?? 0),
          valueRaw: rows[0]?.value_raw ?? '0',
          feeRaw: rows[0]?.fee_raw ?? '0',
        };
      })
      .catch(() => undefined)
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

  /** Total and Per minute from the counter row; nulls when it cannot be read. */
  async function counted(now: number) {
    const snapshot = await counterSnapshot();
    if (!snapshot) return { total: null, perMinute: null };
    // The database clock at the read, plus the time the row has been kept here since.
    const asOf = snapshot.dbNowMs + Math.max(0, now - snapshot.readAt);
    return {
      total: snapshot.total,
      perMinute: snapshot.recent.filter((at) => asOf - at <= PER_MINUTE_WINDOW_MS).length,
    };
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
    const cursor = match ? { at: Number(match[1]), tx: match[2]! } : null;
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
    const [numbers, day24] = await Promise.all([counted(now), dayNow()]);
    // Built field by field: nothing else can reach the answer.
    const body: ServiceCallsPage = {
      total: numbers.total,
      last24h: day24?.calls ?? null,
      perMinute: numbers.perMinute,
      services24h: day24?.services ?? null,
      value24hRaw: day24?.valueRaw ?? null,
      fee24hRaw: day24?.feeRaw ?? null,
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
