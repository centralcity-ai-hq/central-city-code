import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 104 `feed_services` (Operation Central City Feed, release 1; shared/feed.ts): the
 * services the Feed lists as "Offered", ingested from the x402 Bazaar (server/feed/ingest.ts).
 *
 * - `feed_services`: one row per Bazaar resource (record_id = its URL as listed). Listed per
 *   feedListedSql below (since migration 107: `risky` decides risk, `hidden` is the operator's).
 *   `withdrawn_at` is set only after two complete sweeps in a row missed it (offset paging over a
 *   moving catalog can skip a record once). Usage numbers are the source's, never ours.
 * - `feed_exclusions`: records the Feed never lists (not Base mainnet USDC, a bad URL, over the
 *   price cap, unreadable), kept for the operator with the reason.
 * - `feed_sources`: per source, the sweep in progress (its offset, resumed by the next cron run)
 *   and the last complete one, which every list answer reports as its freshness.
 *
 * Version 104: 100 and 101 are the directory and room invitations, 102 the hand-over backoff
 * (#308), 103 the Feed requests (#309).
 */
export const FEED_SERVICE_TABLES = ['feed_services', 'feed_exclusions', 'feed_sources'] as const;

export const FEED_SERVICES_SQL = `
CREATE TABLE IF NOT EXISTS feed_services (
  id text PRIMARY KEY CHECK (id ~ '^svc_[a-z2-7]{20}$'),
  source text NOT NULL DEFAULT 'x402 Bazaar',
  record_id text NOT NULL UNIQUE,
  host text NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  capabilities text[] NOT NULL DEFAULT '{}',
  provider_name text,
  method text,
  x402_version integer NOT NULL,
  scheme text NOT NULL CHECK (scheme IN ('exact','upto')),
  price_raw numeric(78,0),
  pay_to text NOT NULL,
  input jsonb,
  output jsonb,
  paid_calls_30d integer,
  payers_30d integer,
  last_called_at bigint,
  source_updated_at bigint,
  fetched_at bigint NOT NULL,
  first_seen_at bigint NOT NULL,
  last_seen_at bigint NOT NULL,
  last_seen_sweep bigint NOT NULL,
  missed_sweeps integer NOT NULL DEFAULT 0,
  withdrawn_at bigint,
  risky text,
  hidden boolean NOT NULL DEFAULT false,
  search_text text NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_services_host ON feed_services (host);
CREATE INDEX IF NOT EXISTS feed_services_listed ON feed_services (paid_calls_30d DESC NULLS LAST, id)
  WHERE withdrawn_at IS NULL AND NOT hidden;
CREATE TABLE IF NOT EXISTS feed_exclusions (
  record_id text PRIMARY KEY,
  reason text NOT NULL,
  last_seen_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS feed_sources (
  name text PRIMARY KEY,
  sweep_id bigint,
  sweep_offset integer NOT NULL DEFAULT 0,
  sweep_total integer,
  sweep_started_at bigint,
  sweep_listed integer NOT NULL DEFAULT 0,
  last_attempt_at bigint,
  last_success_at bigint,
  last_total integer,
  listed integer NOT NULL DEFAULT 0,
  last_error text
);
`;

export const feedServicesMigration: Migration = {
  version: 104,
  name: 'feed_services',
  sql: FEED_SERVICES_SQL,
};

/**
 * Neither hidden by the operator nor risky now, as SQL over the alias `a`: the only rows a list,
 * a count or a detail ever answers.
 */
export const feedShownSql = (a: string) => `NOT ${a}.hidden AND ${a}.risky IS NULL`;

/**
 * A listed row of feed_services, as SQL over the alias `a`: not withdrawn, not hidden by the
 * operator, and no risk rule matches it now. The one rule every list, count and listed figure
 * uses (server/feed/query.ts, store.ts). `risky` is recomputed on every sweep, so a listing whose
 * rule is loosened is listed again by the next sweep; no sweep ever sets or clears `hidden`.
 */
export const feedListedSql = (a: string) => `${a}.withdrawn_at IS NULL AND ${feedShownSql(a)}`;

/**
 * Whom the Feed's per-seller cap (FEED_LIMITS.perHostPerPage) and moreFromHost count a row for,
 * as SQL over the alias `a`: the stored seller_key (migration 122: the host for the Bazaar's rows,
 * the offer's wallet for Central City's), else the host. Served by the index feed_services_seller.
 */
export const feedSellerKeySql = (a: string) => `COALESCE(${a}.seller_key, ${a}.host)`;

/**
 * Migration 107 `feed_services_operator_hides`: `hidden` becomes the operator's own hide. Until
 * now ingestion stored a risky listing hidden and never cleared it, so a listing whose rule was
 * loosened later (a product decision on 13 Oct re-listed email and phone validators) stayed hidden
 * for good. From now on `risky` alone hides for risk (recomputed by every sweep, feedListedSql),
 * and ingestion inserts `hidden = false` and never writes it again (server/feed/store.ts).
 *
 * No operator hide existed before this migration, so a hidden row with `risky` set is a risk hide:
 * its `hidden` is cleared. It stays unlisted for its `risky`, so the listed rows are exactly the
 * same right after. A hidden row with `risky` NULL (a risk hide whose rule no longer matched at
 * the last sweep, or a hide set by hand) stays hidden: never more public than before. The report
 * counts both; the operator clears the second kind by hand once checked.
 *
 * Data only, idempotent (a second run matches no row), and it writes only the hidden risky rows: no
 * DDL, no lock on the rest of the table. The partial index feed_services_listed (`withdrawn_at IS
 * NULL AND NOT hidden`) stays as it is: feedListedSql implies its predicate, so it still serves,
 * and rebuilding it would lock the live table.
 *
 * Deploy between sweeps (every feed_sources.sweep_started_at NULL). The code before this
 * migration counts listed as `withdrawn_at IS NULL AND NOT hidden`, so if an old instance saves or
 * completes a page after it, its listed figure counts the risky rows (none is ever shown: the old
 * reads also require risky NULL) and its upsert hides its page's risky rows again, until the next
 * sweep on this code. After deploy, check that feed.migration107 reports hidden_kept = 0. A row
 * kept hidden is a risk hide whose rule was already loosened by an old sweep (risky cleared,
 * hidden left set), indistinguishable from an operator hide, and no code clears it: the operator
 * clears it by hand once checked (`UPDATE feed_services SET hidden = false WHERE hidden AND risky
 * IS NULL` if no operator hide was ever set).
 */
export const FEED_OPERATOR_HIDES_SQL = `
UPDATE feed_services SET hidden = false WHERE hidden AND risky IS NOT NULL;
`;

export const feedOperatorHidesMigration: Migration = {
  version: 107,
  name: 'feed_services_operator_hides',
  sql: FEED_OPERATOR_HIDES_SQL,
  // What it changes, measured before the UPDATE: counts only (no ids, no provider text).
  report: {
    event: 'feed.migration107',
    async measure(tx) {
      const row = (
        await tx.query<{ risk_hides_cleared: number | string; hidden_kept: number | string }>(
          `SELECT count(*) FILTER (WHERE risky IS NOT NULL) AS risk_hides_cleared,
                  count(*) FILTER (WHERE risky IS NULL) AS hidden_kept
             FROM feed_services WHERE hidden`,
        )
      ).rows[0]!;
      return {
        risk_hides_cleared: Number(row.risk_hides_cleared),
        hidden_kept: Number(row.hidden_kept),
      };
    },
  },
};

/** Idempotent; call before runMigrations. */
export function registerFeedServicesMigration(): void {
  registerMigration(feedServicesMigration);
  registerMigration(feedOperatorHidesMigration); // 107: `hidden` is the operator's
}
