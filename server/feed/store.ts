/*
 * The Feed's ingestion store (migrations 104 and 107, server/feed/services-schema.ts). server/feed/ingest.ts drives
 * it; server/feed/query.ts reads the same tables.
 *
 * - `feed_sources`, one row per source: the sweep in progress (its number, the offset the next
 *   page is read at, when it started) and the last complete sweep (when, the total the source
 *   reported, how many rows the Feed lists). `sweep_started_at` is set exactly while a sweep is in
 *   progress; `sweep_id` keeps the number of the last sweep started, and every sweep's number is
 *   the previous one plus one.
 * - `feed_services`: upserted per page. A row seen in this sweep carries its number in
 *   `last_seen_sweep`, with `missed_sweeps = 0` and `withdrawn_at` cleared (a withdrawn listing
 *   that comes back is listed again). `first_seen_at` never changes after the insert. `risky` is
 *   the record's risk as the rules read it in this sweep: a rule that is loosened lists the record
 *   again, a new one unlists it. `hidden` is the operator's (migration 107): inserted false, never
 *   set or cleared by a sweep. Listed = feedListedSql (services-schema.ts), here as in query.ts.
 * - One row per service id, owned by one record: the id hashes the canonical URL, so other
 *   spellings of one URL (host case, an explicit default port, dot segments, a backslash) share
 *   it. Another spelling never writes over a row whose record is still listed and is kept as a
 *   'duplicate' exclusion instead. It takes the row over only once the owning record is withdrawn
 *   (or when no row exists yet: the first one listed); a row taken over is risky only for the new
 *   record's own text, and keeps an operator's hide (the same canonical URL).
 * - `feed_exclusions`: the records the Feed never lists, with the reason (FEED_EXCLUSIONS, or
 *   'duplicate' as above), for the operator.
 *
 * Every write that moves a sweep is a compare-and-set on the source row inside one transaction:
 * a page is saved only while the cursor still stands where the page was read (same sweep, same
 * offset), and a sweep starts only while none is in progress. Two runs at once (a slow run
 * overlapping the next cron firing) can read the same page twice, but only one of them moves the
 * cursor and writes it; the other writes nothing and stops.
 *
 * On the page that completes a sweep, in the same transaction: every row of the source not seen
 * in it gets `missed_sweeps + 1` and is withdrawn when that reaches 2 (offset paging over a moving
 * catalog can skip a record once), or at once when the source listed it in this sweep and said
 * for certain that it no longer qualifies (FEED_WITHDRAWN_AT_ONCE: a price over the cap, no Base
 * mainnet USDC offer; an unreadable record is only a miss). Then the source's last success, total
 * and listed count are set. A failed page records only the attempt and its error code: it never
 * completes or withdraws.
 */
import type { Database, Transaction } from '../database.js';
import type { FeedExclusion } from '../../shared/feed.js';
import { feedListedSql } from './services-schema.js';
import type { FeedServiceRow } from './types.js';

type Queryable = Pick<Transaction, 'query'>;

/** Why a record is not listed: the contract's exclusions, or another spelling of a listed URL. */
export type FeedExclusionReason = FeedExclusion | 'duplicate';

/**
 * Exclusions the source states for certain about a record it lists: one seen in a complete sweep
 * withdraws the record's row at once. 'malformed' (could not be read this time) and 'duplicate'
 * (another record) are not among them: such a row is only missed, like a skipped one.
 */
export const FEED_WITHDRAWN_AT_ONCE: readonly FeedExclusion[] = [
  'not_base_mainnet',
  'not_usdc',
  'unsupported_scheme',
  'bad_url',
  'price_over_cap',
];

/** A source's row in feed_sources (times in ms). */
export interface FeedSourceRecord {
  name: string;
  /** The sweep in progress, else the last one started; null before the first. */
  sweepId: number | null;
  /** Where the next page of the sweep in progress is read. */
  sweepOffset: number;
  /** The total the source reported on the sweep's last page. */
  sweepTotal: number | null;
  /** Set exactly while a sweep is in progress. */
  sweepStartedAt: number | null;
  /** Listable rows the sweep in progress has written so far (a progress figure). */
  sweepListed: number;
  lastAttemptAt: number | null;
  /** When the last complete sweep finished; null before the first. */
  lastSuccessAt: number | null;
  /** The total the source reported in its last complete sweep. */
  lastTotal: number | null;
  /** Rows of this source listed after its last complete sweep. */
  listed: number;
  /** The last attempt's failure code (never a message); null when it succeeded. */
  lastError: string | null;
}

export interface FeedExcludedRecord {
  recordId: string;
  reason: FeedExclusionReason;
}

/** One page of a sweep, normalized, to save. */
export interface FeedPageWrite {
  source: string;
  sweepId: number;
  /** The offset the page was read at: the cursor must still stand there (compare-and-set). */
  offset: number;
  /** Where the next page is read. */
  next: number;
  /** The total the source reported with this page. */
  total: number;
  services: FeedServiceRow[];
  excluded: FeedExcludedRecord[];
  /** This page completes the sweep. */
  complete: boolean;
  now: number;
}

export interface FeedPageSaved {
  /** False: another run moved the cursor first, and nothing was written. */
  advanced: boolean;
  /** Listings of the page kept as 'duplicate' exclusions (another record owns their row). */
  duplicates: number;
  /** Rows withdrawn by the sweep this page completed (0 otherwise). */
  withdrawn: number;
  /** The source's listed count after the sweep this page completed; null otherwise. */
  listed: number | null;
}

/**
 * Exclusions with a longer record id (UTF-8 bytes) are counted, not stored: it is a unique key,
 * and an index entry has a size limit (bazaar.ts keeps the same bound).
 */
export const FEED_RECORD_ID_MAX_BYTES = 2_048;

const SOURCE_COLUMNS = `name, sweep_id::float8 AS sweep_id, sweep_offset, sweep_total,
  sweep_started_at::float8 AS sweep_started_at, sweep_listed,
  last_attempt_at::float8 AS last_attempt_at, last_success_at::float8 AS last_success_at,
  last_total, listed, last_error`;

interface SourceRow {
  name: string;
  sweep_id: number | null;
  sweep_offset: number;
  sweep_total: number | null;
  sweep_started_at: number | null;
  sweep_listed: number;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_total: number | null;
  listed: number;
  last_error: string | null;
}

const sourceOf = (row: SourceRow): FeedSourceRecord => ({
  name: row.name,
  sweepId: row.sweep_id,
  sweepOffset: row.sweep_offset,
  sweepTotal: row.sweep_total,
  sweepStartedAt: row.sweep_started_at,
  sweepListed: row.sweep_listed,
  lastAttemptAt: row.last_attempt_at,
  lastSuccessAt: row.last_success_at,
  lastTotal: row.last_total,
  listed: row.listed,
  lastError: row.last_error,
});

/** The record set a page's rows are read from (jsonb_to_recordset), by column. */
const SERVICE_RECORD = `id text, record_id text, host text, url text, title text,
  description text, capabilities text[], provider_name text, method text, x402_version integer,
  scheme text, price_raw numeric, pay_to text, input jsonb, output jsonb, paid_calls_30d integer,
  payers_30d integer, last_called_at bigint, source_updated_at bigint, fetched_at bigint,
  risky text, search_text text`;

/** FeedServiceRow as the record set's JSON (snake_case keys, nulls kept). */
const serviceRecord = (row: FeedServiceRow) => ({
  id: row.id,
  record_id: row.recordId,
  host: row.host,
  url: row.url,
  title: row.title,
  description: row.description,
  capabilities: row.capabilities,
  provider_name: row.providerName,
  method: row.method,
  x402_version: row.x402Version,
  scheme: row.scheme,
  price_raw: row.priceRaw,
  pay_to: row.payTo,
  input: row.input,
  output: row.output,
  paid_calls_30d: row.paidCalls30d,
  payers_30d: row.payers30d,
  last_called_at: row.lastCalledAt,
  source_updated_at: row.sourceUpdatedAt,
  fetched_at: row.fetchedAt,
  risky: row.risky,
  search_text: row.searchText,
});

/** The last of each key wins (one statement cannot upsert the same row twice). */
function lastByKey<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

export function createFeedStore(db: Database) {
  /** The source's row, created with its defaults on first use. */
  async function source(name: string): Promise<FeedSourceRecord> {
    await db.query('INSERT INTO feed_sources (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [
      name,
    ]);
    const { rows } = await db.query<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM feed_sources WHERE name = $1`,
      [name],
    );
    return sourceOf(rows[0]);
  }

  /**
   * Starts the next sweep at offset 0, only while none is in progress and the last one started is
   * still `previous` (compare-and-set). The new sweep's number, or null when another run started
   * one first.
   */
  async function startSweep(
    name: string,
    previous: number | null,
    now: number,
  ): Promise<number | null> {
    const { rows } = await db.query<{ sweep_id: number }>(
      `UPDATE feed_sources SET sweep_id = COALESCE(sweep_id, 0) + 1, sweep_offset = 0,
         sweep_total = NULL, sweep_started_at = $3, sweep_listed = 0
       WHERE name = $1 AND sweep_started_at IS NULL AND sweep_id IS NOT DISTINCT FROM $2::bigint
       RETURNING sweep_id::float8 AS sweep_id`,
      [name, previous, now],
    );
    return rows[0]?.sweep_id ?? null;
  }

  /** A failed attempt: its time and code only. The cursor and every listing stay as they are. */
  async function failed(name: string, code: string, now: number): Promise<void> {
    await db.query(
      'UPDATE feed_sources SET last_attempt_at = $2, last_error = $3 WHERE name = $1',
      [name, now, code],
    );
  }

  /**
   * The page's listings that write their row, and the other spellings (see the header). The same
   * record twice in one page: the last one wins, as it would over two pages. Per id, the record
   * that owns the row writes it; when there is no row yet or its record is withdrawn, the owning
   * record when listed, else the first spelling listed.
   */
  async function ownersOf(
    tx: Queryable,
    source: string,
    services: readonly FeedServiceRow[],
  ): Promise<{ write: FeedServiceRow[]; duplicates: FeedServiceRow[] }> {
    const records = lastByKey(services, (row) => row.recordId);
    if (!records.length) return { write: [], duplicates: [] };
    const { rows: held } = await tx.query<{
      id: string;
      record_id: string;
      source: string;
      withdrawn: boolean;
    }>(
      `SELECT id, record_id, source, withdrawn_at IS NOT NULL AS withdrawn FROM feed_services
       WHERE id = ANY($1::text[])`,
      [[...new Set(records.map((row) => row.id))]],
    );
    const owner = new Map(held.map((row) => [row.id, row]));
    const write = new Map<string, FeedServiceRow>();
    for (const row of records) {
      const current = owner.get(row.id);
      // Source guard: a row of another source is never this sweep's, listed or withdrawn (a
      // Central City offer's row stays its offer's, also while the offer is paused).
      if (current && current.source !== source) continue;
      if (current?.record_id === row.recordId) write.set(row.id, row);
      else if (!write.has(row.id) && (!current || current.withdrawn)) write.set(row.id, row);
    }
    const written = new Set(write.values());
    return {
      write: [...written],
      duplicates: records.filter((row) => !written.has(row)),
    };
  }

  async function upsertServices(
    tx: Queryable,
    page: FeedPageWrite,
  ): Promise<{ listable: number; duplicates: FeedServiceRow[] }> {
    const { write: services, duplicates } = await ownersOf(tx, page.source, page.services);
    if (!services.length) return { listable: 0, duplicates };
    // The WHERE repeats the ownership rule and the source guard: a row whose record is listed is
    // written by that record only, and a row of another source never. `risky` is always the
    // writing record's own, from this sweep's rules (an earlier record's or an older rule's match
    // never sticks). `hidden` is never written here: it is the operator's, and a new row takes its
    // default (false). The seller is the host (one provider per host, as listed).
    const { rows } = await tx.query<{ listable: boolean }>(
      `INSERT INTO feed_services AS s (id, source, record_id, host, url, title, description,
         capabilities, provider_name, method, x402_version, scheme, price_raw, pay_to, input,
         output, paid_calls_30d, payers_30d, last_called_at, source_updated_at, fetched_at,
         first_seen_at, last_seen_at, last_seen_sweep, missed_sweeps, withdrawn_at, risky,
         search_text, seller_key)
       SELECT r.id, $2, r.record_id, r.host, r.url, r.title, COALESCE(r.description, ''),
         COALESCE(r.capabilities, '{}'), r.provider_name, r.method, r.x402_version, r.scheme,
         r.price_raw, r.pay_to, r.input, r.output, r.paid_calls_30d, r.payers_30d,
         r.last_called_at, r.source_updated_at, r.fetched_at, $3, $3, $4, 0, NULL, r.risky,
         r.search_text, r.host
       FROM jsonb_to_recordset($1::jsonb) AS r(${SERVICE_RECORD})
       ON CONFLICT (id) DO UPDATE SET
         source = EXCLUDED.source, record_id = EXCLUDED.record_id, host = EXCLUDED.host,
         url = EXCLUDED.url, title = EXCLUDED.title, description = EXCLUDED.description,
         capabilities = EXCLUDED.capabilities, provider_name = EXCLUDED.provider_name,
         method = EXCLUDED.method, x402_version = EXCLUDED.x402_version, scheme = EXCLUDED.scheme,
         price_raw = EXCLUDED.price_raw, pay_to = EXCLUDED.pay_to, input = EXCLUDED.input,
         output = EXCLUDED.output, paid_calls_30d = EXCLUDED.paid_calls_30d,
         payers_30d = EXCLUDED.payers_30d, last_called_at = EXCLUDED.last_called_at,
         source_updated_at = EXCLUDED.source_updated_at, fetched_at = EXCLUDED.fetched_at,
         last_seen_at = EXCLUDED.last_seen_at, last_seen_sweep = EXCLUDED.last_seen_sweep,
         missed_sweeps = 0, withdrawn_at = NULL, risky = EXCLUDED.risky,
         search_text = EXCLUDED.search_text, seller_key = EXCLUDED.seller_key
       WHERE s.source = EXCLUDED.source
         AND (s.record_id = EXCLUDED.record_id OR s.withdrawn_at IS NOT NULL)
       RETURNING ${feedListedSql('s')} AS listable`,
      [JSON.stringify(services.map(serviceRecord)), page.source, page.now, page.sweepId],
    );
    // A record listed again no longer counts as excluded.
    await tx.query('DELETE FROM feed_exclusions WHERE record_id = ANY($1::text[])', [
      services.map((row) => row.recordId),
    ]);
    return { listable: rows.filter((row) => row.listable).length, duplicates };
  }

  async function upsertExclusions(
    tx: Queryable,
    records: readonly FeedExcludedRecord[],
    now: number,
  ): Promise<void> {
    const excluded = lastByKey(
      records.filter(
        (item) => Buffer.byteLength(item.recordId, 'utf8') <= FEED_RECORD_ID_MAX_BYTES,
      ),
      (item) => item.recordId,
    );
    if (!excluded.length) return;
    await tx.query(
      `INSERT INTO feed_exclusions (record_id, reason, last_seen_at)
       SELECT r.record_id, r.reason, $2 FROM unnest($1::text[], $3::text[]) AS r(record_id, reason)
       ON CONFLICT (record_id) DO UPDATE SET reason = EXCLUDED.reason,
         last_seen_at = EXCLUDED.last_seen_at`,
      [excluded.map((item) => item.recordId), now, excluded.map((item) => item.reason)],
    );
  }

  /** The completing page's last step (see the header), inside its transaction. */
  async function completeSweep(
    tx: Queryable,
    page: FeedPageWrite,
    startedAt: number,
  ): Promise<{ withdrawn: number; listed: number }> {
    const { rows: missed } = await tx.query<{ withdrawn: boolean }>(
      `UPDATE feed_services s SET missed_sweeps = s.missed_sweeps + 1,
         withdrawn_at = CASE WHEN s.missed_sweeps + 1 >= 2 OR EXISTS (
           SELECT 1 FROM feed_exclusions e WHERE e.record_id = s.record_id AND e.last_seen_at >= $3
             AND e.reason = ANY($5::text[])
         ) THEN $4::bigint END
       WHERE s.source = $1 AND s.last_seen_sweep < $2 AND s.withdrawn_at IS NULL
       RETURNING s.withdrawn_at IS NOT NULL AS withdrawn`,
      [page.source, page.sweepId, startedAt, page.now, FEED_WITHDRAWN_AT_ONCE],
    );
    const { rows: counted } = await tx.query<{ listed: number }>(
      `SELECT count(*)::int AS listed FROM feed_services s
       WHERE s.source = $1 AND ${feedListedSql('s')}`,
      [page.source],
    );
    const listed = counted[0].listed;
    await tx.query(
      `UPDATE feed_sources SET sweep_started_at = NULL, last_success_at = $2, last_total = $3,
         listed = $4, last_error = NULL
       WHERE name = $1`,
      [page.source, page.now, page.total, listed],
    );
    return { withdrawn: missed.filter((row) => row.withdrawn).length, listed };
  }

  /**
   * Saves one page of the sweep in progress in one transaction: moves the cursor (compare-and-set
   * on the sweep and the offset the page was read at), upserts its listings and exclusions, and
   * completes the sweep when the page says so. Nothing is written when the cursor moved.
   */
  async function savePage(page: FeedPageWrite): Promise<FeedPageSaved> {
    return db.transaction(async (tx) => {
      const { rows: moved } = await tx.query<{ started_at: number }>(
        `UPDATE feed_sources SET sweep_offset = $4, sweep_total = $5, last_attempt_at = $6,
           last_error = NULL
         WHERE name = $1 AND sweep_id = $2 AND sweep_offset = $3 AND sweep_started_at IS NOT NULL
         RETURNING sweep_started_at::float8 AS started_at`,
        [page.source, page.sweepId, page.offset, page.next, page.total, page.now],
      );
      if (!moved.length) return { advanced: false, duplicates: 0, withdrawn: 0, listed: null };
      await upsertExclusions(tx, page.excluded, page.now);
      const { listable, duplicates } = await upsertServices(tx, page);
      await upsertExclusions(
        tx,
        duplicates.map((row) => ({ recordId: row.recordId, reason: 'duplicate' })),
        page.now,
      );
      if (listable)
        await tx.query('UPDATE feed_sources SET sweep_listed = sweep_listed + $2 WHERE name = $1', [
          page.source,
          listable,
        ]);
      const saved = { advanced: true, duplicates: duplicates.length };
      if (!page.complete) return { ...saved, withdrawn: 0, listed: null };
      return { ...saved, ...(await completeSweep(tx, page, moved[0].started_at)) };
    });
  }

  return { source, startSweep, failed, savePage };
}

export type FeedStore = ReturnType<typeof createFeedStore>;
