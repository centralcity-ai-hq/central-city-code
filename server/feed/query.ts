/*
 * Operation Central City Feed, slice 1 (Offered): the services search, one service's detail and the
 * freshness every answer carries (shared/feed.ts is the contract; migration 104 in
 * server/feed/services-schema.ts the tables). The public routes (services-routes.ts) and the city_service_search
 * tool both read through here.
 *
 * Listed: feedListedSql (services-schema.ts), `withdrawn_at IS NULL AND NOT hidden AND risky IS
 * NULL`, the same rule the store counts with. `risky` is recomputed by every sweep; `hidden` is the
 * operator's. A withdrawn record answers on its detail only, for FEED_LIMITS.tombstoneMs, then
 * like an unknown id; a hidden or risky one never answers.
 *
 * Freshness comes from `feed_sources`: the last COMPLETE sweep is the snapshot every list answer
 * reflects. Before the first one every list answers source_unavailable (retryable), never an empty
 * success. A service is 'stale' once that sweep is older than staleAfterMs, else 'active'.
 *
 * A search matches every word of `q` (searchWords) in `search_text`, keeps at most perHostPerPage
 * listings per seller (in the sort's order; `host` lifts the cap) and pages by offset. The seller
 * is feedSellerKeySql: the host for the Bazaar's records (one provider per host), the selling
 * agent's wallet for Central City's offers (they all share Central City's host).
 * The cursor carries the snapshot and the data version it was written for: once a new sweep
 * completes, a sweep in progress saves a page (the list reads the stored rows, which every saved
 * page changes) or Central City's offers change (their source's data_version), an older cursor
 * answers cursor_stale and the client loads the first page again: offset paging over changed rows
 * would repeat or skip listings. Usage numbers and prices are the source's as listed; an unknown
 * one stays null and never passes max_price.
 */
import type { Address } from '../../shared/base/chains.js';
import type { Database } from '../database.js';
import {
  FEED_HTTP_METHODS,
  FEED_LIMITS,
  FEED_NETWORK,
  FEED_SERVICE_ID,
  FEED_SOURCE,
  FEED_USDC,
  feedSourceOf,
  rawToUsdc,
  type FeedFreshness,
  type FeedHttpMethod,
  type FeedSchemaSummary,
  type FeedService,
  type FeedServiceDetail,
  type FeedServicePage,
  type FeedServiceQuery,
  type FeedServiceSort,
  type FeedServiceStatus,
  type FeedSourceState,
  type FeedStatus,
} from '../../shared/feed.js';
import { feedListedSql, feedSellerKeySql, feedShownSql } from './services-schema.js';
import { BAZAAR_SOURCE, HOSTED_SOURCE } from './types.js';

type Queryable = Pick<Database, 'query'>;

/** At most this many words of `q` must all match (the rest of a longer query is ignored). */
export const SEARCH_WORDS_MAX = 8;
/** One page holds at most this many services, whatever the caller asks. */
export const FEED_PAGE_MAX = 100;
/** Cursors past this offset are not ones this server writes. */
const OFFSET_MAX = 1_000_000;

export type FeedQueryErrorCode = 'cursor_stale' | 'source_unavailable';

export class FeedQueryError extends Error {
  constructor(
    readonly code: FeedQueryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FeedQueryError';
  }
}

const SOURCE_UNAVAILABLE =
  'The service listings are not available yet. Try again in a few minutes.';
const CURSOR_STALE = 'The listings changed since this page. Load the first page again.';

/** A listed record, as SQL over the alias `a` (the one rule, shared with the store). */
const listable = feedListedSql;

/** The columns a FeedService is built from, over the alias `a`. */
const serviceColumns = (a: string) =>
  [
    'id',
    'source',
    'record_id',
    'host',
    'url',
    'title',
    'description',
    'capabilities',
    'provider_name',
    'method',
    'x402_version',
    'scheme',
    'pay_to',
    'input',
    'output',
    'paid_calls_30d',
    'payers_30d',
    'last_called_at',
    'source_updated_at',
    'fetched_at',
    'last_seen_at',
  ]
    .map((column) => `${a}.${column}`)
    .concat(`${a}.price_raw::text AS price_raw`)
    .join(', ');

/** The seller a row counts for (feedSellerKeySql): the host, or a Central City offer's wallet. */
const seller = feedSellerKeySql;

/** Other listed records of the row's seller (alias `a`), for moreFromHost. */
const hostListed = (a: string) =>
  `(SELECT count(*) FROM feed_services h WHERE ${seller('h')} = ${seller(a)} AND ${listable('h')})::int`;

interface ServiceRow {
  id: string;
  source: string;
  record_id: string;
  host: string;
  url: string;
  title: string;
  description: string;
  capabilities: string[] | null;
  provider_name: string | null;
  method: string | null;
  x402_version: number;
  scheme: 'exact' | 'upto';
  price_raw: string | null;
  pay_to: string;
  input: FeedSchemaSummary | null;
  output: FeedSchemaSummary | null;
  paid_calls_30d: number | null;
  payers_30d: number | null;
  last_called_at: number | string | null;
  source_updated_at: number | string | null;
  fetched_at: number | string;
  last_seen_at: number | string;
  host_listed: number;
}

/** bigint columns arrive as numbers (PGlite) or strings (node-postgres). */
const time = (value: number | string | null): number | null =>
  value === null ? null : Number(value);

/**
 * A stored summary as the contract has it. A row saved before exampleState existed reads null
 * there (unknown, never a guessed 'whole') until the next sweep saves it again.
 */
const storedSummary = (summary: FeedSchemaSummary | null): FeedSchemaSummary | null =>
  summary && { ...summary, exampleState: summary.exampleState ?? null };

const methodOf = (value: string | null): FeedHttpMethod | null =>
  FEED_HTTP_METHODS.find((method) => method === value) ?? null;

/**
 * The public record: source credit and usage always labelled, never a flag or bookkeeping. Each
 * row carries its own source (FEED_SOURCES); a Central City row is confirmed by its offer, not by
 * a sweep, so it never reads 'stale' while listed.
 */
export function feedServiceOf(
  row: Omit<ServiceRow, 'host_listed'>,
  status: FeedServiceStatus,
  moreFromHost: number,
): FeedService {
  const source = feedSourceOf(row.source);
  return {
    id: row.id,
    kind: 'external_service',
    title: row.title,
    capabilities: row.capabilities ?? [],
    description: row.description,
    provider: { host: row.host, name: row.provider_name },
    url: row.url,
    method: methodOf(row.method),
    protocol: 'x402',
    x402Version: row.x402_version === 1 ? 1 : 2,
    network: FEED_NETWORK,
    asset: FEED_USDC,
    scheme: row.scheme,
    price:
      row.price_raw === null
        ? null
        : {
            raw: row.price_raw,
            decimals: 6,
            display: rawToUsdc(row.price_raw),
            unit: row.scheme === 'exact' ? 'per_call' : 'up_to_per_call',
          },
    payTo: row.pay_to as Address,
    input: storedSummary(row.input),
    output: storedSummary(row.output),
    source: {
      name: source.name,
      credit: source.credit,
      url: source.url,
      recordId: row.record_id,
      fetchedAt: Number(row.fetched_at),
      updatedAt: time(row.source_updated_at),
    },
    usage: {
      paidCalls30d: row.paid_calls_30d,
      payers30d: row.payers_30d,
      lastCalledAt: time(row.last_called_at),
      reportedBy: source.name,
    },
    lastSeenAt: Number(row.last_seen_at),
    status: status === 'stale' && source.name === HOSTED_SOURCE ? 'active' : status,
    moreFromHost: Math.max(0, moreFromHost),
  };
}

/**
 * 'ok' while the last complete sweep is under syncEveryMs × 2 old, 'delayed' after that, 'down'
 * once it is older than staleAfterMs or there was none.
 */
export function feedSourceStateOf(lastSuccessAt: number | null, now: number) {
  if (lastSuccessAt === null || now - lastSuccessAt > FEED_LIMITS.staleAfterMs) return 'down';
  return now - lastSuccessAt >= FEED_LIMITS.syncEveryMs * 2 ? 'delayed' : 'ok';
}

/**
 * Where the stored rows stand: the sweep last started and the offset it has saved up to. Every
 * page a sweep saves moves it, completing a sweep moves the snapshot too, and a failed attempt
 * moves neither (it writes no row).
 *
 * The per-version caches below (the Offered count, the unfiltered order) rely on one invariant:
 * every write in code that changes which rows are listed moves this version or the snapshot in
 * the same transaction. For the Bazaar's rows savePage (store.ts) is the only such write: every
 * listing it upserts has `risky` recomputed (a risk set or cleared), and the page that completes a
 * sweep withdraws the missed ones. Central City's rows move `hosted`, the 'Central City' source's
 * data_version (migration 122), once per write that changes them (server/feed/offers/store.ts:
 * a publish, a pause or resume, a revoke; offers/uses.ts: a use count refresh that changed a
 * row). `hidden` is the operator's and no code writes it: a hide set by hand shows at once
 * wherever a row is read (pages re-check listed; searches and details read the row), and the
 * cached count and order catch up with the next saved page or version move. A code path that writes `hidden` or `risky` outside these must move a version
 * these keys include (never `sweep_offset`: it is the sweep's compare-and-set cursor).
 */
export interface FeedDataVersion {
  sweep: number;
  offset: number;
  /** The Central City source's data_version. */
  hosted: number;
}

/** The Bazaar's freshness, and the version of the rows both sources wrote. */
async function readSource(
  db: Queryable,
  now: number,
): Promise<{ freshness: FeedFreshness; version: FeedDataVersion }> {
  const { rows } = await db.query<{
    name: string;
    sweep_id: number | string | null;
    sweep_offset: number;
    last_success_at: number | string | null;
    last_attempt_at: number | string | null;
    last_total: number | null;
    listed: number;
    data_version: number | string | null;
  }>(
    `SELECT name, sweep_id, sweep_offset, last_success_at, last_attempt_at, last_total, listed,
       data_version
     FROM feed_sources WHERE name = ANY($1::text[])`,
    [[BAZAAR_SOURCE, HOSTED_SOURCE]],
  );
  const row = rows.find((item) => item.name === BAZAAR_SOURCE);
  const hosted = rows.find((item) => item.name === HOSTED_SOURCE);
  const lastSuccessAt = time(row?.last_success_at ?? null);
  const source: FeedSourceState = {
    name: FEED_SOURCE.name,
    state: feedSourceStateOf(lastSuccessAt, now),
    lastSuccessAt,
    lastAttemptAt: time(row?.last_attempt_at ?? null),
    total: lastSuccessAt === null ? null : (row?.last_total ?? null),
    listed: lastSuccessAt === null ? 0 : (row?.listed ?? 0),
  };
  return {
    freshness: { snapshotAt: lastSuccessAt, degraded: source.state !== 'ok', sources: [source] },
    version: {
      sweep: time(row?.sweep_id ?? null) ?? 0,
      offset: row?.sweep_offset ?? 0,
      hosted: time(hosted?.data_version ?? null) ?? 0,
    },
  };
}

/** A data version as one cache key, with the snapshot it belongs to. */
const versionKey = (snapshotAt: number, version: FeedDataVersion) =>
  `${snapshotAt}:${version.sweep}:${version.offset}:${version.hosted}`;

/** Where the data stands: the Bazaar's sweep state (its row in feed_sources; none yet = down). */
export async function feedFreshness(db: Queryable, now: number): Promise<FeedFreshness> {
  return (await readSource(db, now)).freshness;
}

/** 'stale' once the snapshot is older than staleAfterMs (the source failed since), else 'active'. */
const listedStatus = (freshness: FeedFreshness, now: number): FeedServiceStatus =>
  freshness.snapshotAt === null || now - freshness.snapshotAt > FEED_LIMITS.staleAfterMs
    ? 'stale'
    : 'active';

/**
 * The page cursor: the snapshot and the data version it belongs to, and the offset into the
 * search's order.
 */
export const feedCursor = (snapshotAt: number, version: FeedDataVersion, offset: number) =>
  Buffer.from(
    JSON.stringify({
      s: snapshotAt,
      w: version.sweep,
      p: version.offset,
      h: version.hosted,
      o: offset,
    }),
  ).toString('base64url');

const wholeNumber = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** A cursor this server wrote, or null. */
export function readFeedCursor(
  cursor: string,
): { snapshotAt: number; version: FeedDataVersion; offset: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    return null;
  }
  const { s, w, p, h, o } = (value ?? {}) as Record<string, unknown>;
  if (
    !wholeNumber(s) ||
    !wholeNumber(w) ||
    !wholeNumber(p) ||
    !wholeNumber(h) ||
    !wholeNumber(o, 1, OFFSET_MAX)
  )
    return null;
  const version = { sweep: w, offset: p, hosted: h };
  return feedCursor(s, version, o) === cursor ? { snapshotAt: s, version, offset: o } : null;
}

/**
 * One Latin letter, digit, punctuation mark or symbol: dropped from a search that has a longer word.
 * One Han, kana or Hangul character is a whole word and stays.
 */
const MINOR_WORD = /^[\p{Script=Latin}\p{N}\p{P}\p{S}]$/u;

/**
 * The words that must all match: lowercased, deduplicated, at most SEARCH_WORDS_MAX. A minor word
 * (MINOR_WORD) is dropped when the search has another word: it matches nearly every listing and
 * only narrows the results by noise. A search of minor words only keeps them all.
 */
export function searchWords(q: string): string[] {
  // Control characters split words too: the database refuses a NUL in a text parameter.
  const words = [
    ...new Set(
      q
        .toLowerCase()
        .split(/[\s\p{Cc}]+/u)
        .filter(Boolean),
    ),
  ];
  const kept = words.filter((word) => !MINOR_WORD.test(word));
  return (kept.length ? kept : words).slice(0, SEARCH_WORDS_MAX);
}

/** Literal text inside LIKE: its wildcards and its escape character escaped. */
const likeText = (word: string) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * The unfiltered list's order per database, by sort, for one data version and snapshot. Every
 * write that changes the listed rows moves the version or the snapshot in the same transaction
 * (FeedDataVersion), so an order ranked at an equal key is still the order.
 */
const defaultOrders = new WeakMap<
  Queryable,
  { key: string; ids: Map<FeedServiceSort, string[]> }
>();

/**
 * Each sort's order over the matched rows; ties by id. Newest: first_seen_at is when a sweep saved
 * the listing's page, so a page's listings (and the whole first sweep) share it nearly; the
 * source's own update time orders them within it.
 */
const ORDER: Record<FeedServiceSort, string> = {
  relevance: 'title_hits DESC, paid_calls_30d DESC NULLS LAST, id',
  most_used: 'paid_calls_30d DESC NULLS LAST, id',
  cheapest: 'price_raw ASC NULLS LAST, id',
  newest: 'first_seen_at DESC, source_updated_at DESC NULLS LAST, id',
};

/** The narrow columns every order and the per-seller cap read, over the alias `a`. */
const rankColumns = (a: string) =>
  ['id', 'host', 'paid_calls_30d', 'price_raw', 'first_seen_at', 'source_updated_at']
    .map((column) => `${a}.${column}`)
    .concat(`${seller(a)} AS seller_key`)
    .join(', ');

/**
 * One page of listed services. Throws FeedQueryError 'source_unavailable' before the first
 * complete sweep and 'cursor_stale' for a cursor of another snapshot or data version (or one this
 * server did not write).
 */
export async function searchFeedServices(
  db: Queryable,
  query: FeedServiceQuery,
  options: { limit: number; now: number },
): Promise<FeedServicePage> {
  // Read before the rows: a page saved in between makes this answer's cursor stale, never valid
  // over rows it did not see.
  const { freshness, version } = await readSource(db, options.now);
  const snapshotAt = freshness.snapshotAt;
  if (snapshotAt === null) throw new FeedQueryError('source_unavailable', SOURCE_UNAVAILABLE);
  let offset = 0;
  if (query.cursor !== null) {
    const cursor = readFeedCursor(query.cursor);
    if (
      !cursor ||
      cursor.snapshotAt !== snapshotAt ||
      cursor.version.sweep !== version.sweep ||
      cursor.version.offset !== version.offset ||
      cursor.version.hosted !== version.hosted
    )
      throw new FeedQueryError('cursor_stale', CURSOR_STALE);
    offset = cursor.offset;
  }
  const limit = Math.min(FEED_PAGE_MAX, Math.max(1, Math.floor(options.limit) || 1));

  const params: unknown[] = [];
  const p = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const words = searchWords(query.q);
  const where = [listable('s')];
  const titleHits: string[] = [];
  for (const word of words) {
    const like = p(likeText(word));
    where.push(`s.search_text ILIKE ${like}`);
    titleHits.push(`(s.title ILIKE ${like})::int`);
  }
  // An unknown price (NULL) never passes.
  if (query.maxPrice !== null) where.push(`s.price_raw <= ${p(query.maxPrice)}::numeric`);
  if (query.host !== null) where.push(`s.host = ${p(query.host)}`);
  const sort = query.sort === 'relevance' && !words.length ? 'most_used' : query.sort;
  const order = ORDER[sort];
  const status = listedStatus(freshness, options.now);
  // moreFromHost: the host's listed services this list shows on none of its pages (shared/feed.ts),
  // so a host's rows say the same number on every page; under ?host= the list shows them all.
  const pageOf = (
    rows: Array<ServiceRow & { host_kept: number }>,
    total: number,
  ): FeedServicePage => ({
    ...freshness,
    services: rows.map((row) =>
      feedServiceOf(row, status, query.host === null ? row.host_listed - row.host_kept : 0),
    ),
    next: offset + limit < total ? feedCursor(snapshotAt, version, offset + limit) : null,
    total,
  });

  // The unfiltered list (what the Feed opens on, and its deep pages): its order is ranked once
  // per data version and sort, then each page reads its own ids only.
  if (where.length === 1) {
    const key = versionKey(snapshotAt, version);
    let orders = defaultOrders.get(db);
    if (!orders || orders.key !== key) {
      orders = { key, ids: new Map() };
      defaultOrders.set(db, orders);
    }
    let ids = orders.ids.get(sort);
    if (!ids) {
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM (
           SELECT ${rankColumns('s')},
                  row_number() OVER (PARTITION BY ${seller('s')} ORDER BY ${order}) AS host_rank
           FROM feed_services s WHERE ${listable('s')}) r
         WHERE host_rank <= ${FEED_LIMITS.perHostPerPage}
         ORDER BY ${order}`,
      );
      ids = rows.map((row) => row.id);
      orders.ids.set(sort, ids);
    }
    const pageIds = ids.slice(offset, offset + limit);
    // Listed is checked again: a row hidden since the order was ranked never shows.
    const { rows } = pageIds.length
      ? await db.query<ServiceRow>(
          `SELECT ${serviceColumns('s')}, ${hostListed('s')} AS host_listed
           FROM unnest($1::text[]) WITH ORDINALITY AS page(id, position)
           JOIN feed_services s ON s.id = page.id
           WHERE ${listable('s')}
           ORDER BY page.position`,
          [pageIds],
        )
      : { rows: [] };
    // The capped list keeps perHostPerPage of every seller's listed ones (fewer when it lists fewer).
    return pageOf(
      rows.map((row) => ({
        ...row,
        host_kept: Math.min(row.host_listed, FEED_LIMITS.perHostPerPage),
      })),
      ids.length,
    );
  }

  // The per-seller cap keeps a seller's first listings in the page's own order; ?host= lifts it.
  const kept =
    query.host === null
      ? `SELECT * FROM (
           SELECT m.*, row_number() OVER (PARTITION BY seller_key ORDER BY ${order}) AS host_rank
           FROM matched m) r
         WHERE host_rank <= ${FEED_LIMITS.perHostPerPage}`
      : 'SELECT * FROM matched';
  const start = p(offset);
  const end = p(offset + limit);
  // One statement: the page and the total agree. The LEFT JOINs answer the total on an empty page.
  // Ranking reads only the narrow columns the order and the per-seller cap need; the full rows (text
  // and schemas) are read for the page's own ids only, so a page never sorts every wide row.
  // host_kept: the host's listings in this whole list (every page), for moreFromHost.
  type Row = ServiceRow & { total: number; host_kept: number };
  const { rows } = await db.query<Row | { id: null; total: number }>(
    `WITH matched AS (
       SELECT ${rankColumns('s')}, ${titleHits.join(' + ') || '0'} AS title_hits
       FROM feed_services s WHERE ${where.join(' AND ')}
     ), kept AS (${kept}
     ), ranked AS (
       SELECT kept.id, row_number() OVER (ORDER BY ${order}) AS position,
              count(*) OVER (PARTITION BY kept.seller_key) AS host_kept
       FROM kept
     ), page AS (
       SELECT id, position, host_kept FROM ranked WHERE position > ${start} AND position <= ${end}
     )
     SELECT (SELECT count(*) FROM kept)::int AS total, ${serviceColumns('s')},
            ${hostListed('s')} AS host_listed, page.host_kept::int AS host_kept
     FROM (SELECT 1) one
     LEFT JOIN page ON true
     LEFT JOIN feed_services s ON s.id = page.id
     ORDER BY page.position`,
    params,
  );
  const total = rows[0]?.total ?? 0;
  return pageOf(
    rows.filter((row): row is Row => row.id !== null),
    total,
  );
}

/**
 * One service by id: listed ones as 'active' or 'stale', a withdrawn one as 'withdrawn' within the
 * tombstone. null (404 service_not_found) for an unknown, malformed, hidden or long-withdrawn id:
 * one answer, so hidden ones cannot be probed. Throws 'source_unavailable' before the first
 * complete sweep (nothing is confirmed yet).
 */
export async function feedServiceDetail(
  db: Queryable,
  id: string,
  now: number,
): Promise<FeedServiceDetail | null> {
  if (!FEED_SERVICE_ID.test(id)) return null;
  const freshness = await feedFreshness(db, now);
  if (freshness.snapshotAt === null)
    throw new FeedQueryError('source_unavailable', SOURCE_UNAVAILABLE);
  const { rows } = await db.query<ServiceRow & { withdrawn_at: number | string | null }>(
    `SELECT ${serviceColumns('s')}, s.withdrawn_at, ${hostListed('s')} AS host_listed
     FROM feed_services s
     WHERE s.id = $1 AND ${feedShownSql('s')}
       AND (s.withdrawn_at IS NULL OR s.withdrawn_at > $2)`,
    [id, now - FEED_LIMITS.tombstoneMs],
  );
  const row = rows[0];
  if (!row) return null;
  const withdrawn = row.withdrawn_at !== null;
  return {
    ...freshness,
    // The others of its host: all listed ones but itself (a withdrawn one is not among them).
    service: feedServiceOf(
      row,
      withdrawn ? 'withdrawn' : listedStatus(freshness, now),
      row.host_listed - (withdrawn ? 0 : 1),
    ),
  };
}

/**
 * The Feed's status: freshness, listed services (active and stale; 0 before the first complete
 * sweep) and the open requests the caller counted (the requests slice).
 */
/** The Offered side of FeedStatus, for the status route of the requests slice (its services hook). */
export async function feedServicesStatus(
  db: Queryable,
  now: number,
): Promise<Omit<FeedStatus, 'openRequests'>> {
  const { openRequests: _ignored, ...services } = await feedStatus(db, now);
  return services;
}

/**
 * The Offered count last counted per database, with the data version and snapshot it was counted
 * at. Every write that changes the listed rows moves the version or the snapshot in the same
 * transaction (FeedDataVersion), so an equal key is an equal count.
 */
const offeredCounts = new WeakMap<Queryable, { key: string; count: number }>();

export async function feedStatus(
  db: Queryable,
  now: number,
  openRequests = 0,
): Promise<FeedStatus> {
  const { freshness, version } = await readSource(db, now);
  let services = 0;
  if (freshness.snapshotAt !== null) {
    const key = versionKey(freshness.snapshotAt, version);
    const counted = offeredCounts.get(db);
    if (counted?.key === key) services = counted.count;
    else {
      // The same number the unfiltered list counts (its total): at most perHostPerPage listings
      // per seller, the rest are behind moreFromHost. A raw row count would show the
      // Offered tab ten times the list's own total on real Bazaar data. Counted once per version:
      // the workspace sidebar asks for the status on every page load.
      const { rows } = await db.query<{ count: number }>(
        `SELECT coalesce(sum(least(n, ${FEED_LIMITS.perHostPerPage})), 0)::int AS count
         FROM (SELECT count(*) AS n FROM feed_services s WHERE ${listable('s')}
               GROUP BY ${seller('s')}) h`,
      );
      services = rows[0]?.count ?? 0;
      offeredCounts.set(db, { key, count: services });
    }
  }
  return { ...freshness, services, openRequests };
}
