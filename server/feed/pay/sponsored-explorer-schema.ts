import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 251 `feed_pay_sponsored_calls_explorer`: the indexes the public Explorer's service
 * calls view (server/base/explorer/calls.ts) reads the paid sponsored first purchases through.
 * All five are partial on the same predicate the Explorer repeats (a sponsored call Base shows
 * paid, with its transaction), so they hold only paid rows and never the open ones:
 *   - `_paid_time` (updated_at): the page newest first (its ties, calls of one batch, are sorted
 *     by transaction and row key on the few rows read) and its cursor, the per-minute count and
 *     the 24 h range. Kept to one narrow key with no INCLUDE on purpose: it is then smaller than
 *     feed_pay_sponsored_calls_updated (every state), so the planner picks it over that one (a
 *     wider key or INCLUDE columns lost that choice in EXPLAIN);
 *   - `_paid_tx`, `_paid_block`: a search by transaction or by block;
 *   - `_paid_pay_to` (lower(pay_to), updated_at): a search by provider address, newest first;
 *   - `_paid_created` (created_at): Total's sponsored part, counted by creation time (it never
 *     changes, unlike updated_at), so only the newest hours are counted again each minute.
 * No data changes; the payment path's own reads and writes are untouched.
 *
 * A plain CREATE INDEX: every migration runs inside the one migration transaction
 * (server/migrations.ts), where CREATE INDEX CONCURRENTLY is not allowed, and building these
 * blocks writes to feed_pay_sponsored_calls until that transaction commits (reads go on). The
 * table is young and small, so the pause is short. Where it is not acceptable, build them first
 * by hand with CREATE INDEX CONCURRENTLY IF NOT EXISTS (same definitions) and check
 * pg_index.indisvalid before this migration runs: IF NOT EXISTS then skips them.
 */
const PAID = `state IN ('paid','delivered','paid_no_result') AND tx_hash IS NOT NULL`;

export const FEED_PAY_SPONSORED_EXPLORER_SQL = `
CREATE INDEX IF NOT EXISTS feed_pay_sponsored_calls_paid_time
  ON feed_pay_sponsored_calls (updated_at) WHERE ${PAID};
CREATE INDEX IF NOT EXISTS feed_pay_sponsored_calls_paid_tx
  ON feed_pay_sponsored_calls (tx_hash) WHERE ${PAID};
CREATE INDEX IF NOT EXISTS feed_pay_sponsored_calls_paid_block
  ON feed_pay_sponsored_calls (block_number) WHERE ${PAID};
CREATE INDEX IF NOT EXISTS feed_pay_sponsored_calls_paid_pay_to
  ON feed_pay_sponsored_calls (lower(pay_to), updated_at) WHERE ${PAID};
CREATE INDEX IF NOT EXISTS feed_pay_sponsored_calls_paid_created
  ON feed_pay_sponsored_calls (created_at) WHERE ${PAID};`;

export const feedPaySponsoredExplorerMigration: Migration = {
  version: 251,
  name: 'feed_pay_sponsored_calls_explorer',
  sql: FEED_PAY_SPONSORED_EXPLORER_SQL,
};

/** Idempotent; call before runMigrations (after migration 250, which creates the table). */
export function registerFeedPaySponsoredExplorerMigration(): void {
  registerMigration(feedPaySponsoredExplorerMigration);
}
