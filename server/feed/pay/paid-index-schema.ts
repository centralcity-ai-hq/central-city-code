import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 120 `feed_pay_calls_paid` (116, 117 and 119 belong to other open changes): the index
 * the public passport's "Paid for services" totals read through (server/base/explorer/store.ts
 * servicePayments). It holds only the calls whose payment is confirmed on Base (payment_state
 * 'settled' with its transaction), by the paying wallet and settled time, so one passport view
 * reads exactly the counted calls of one wallet and never the others (quotes, refusals,
 * cancellations, payments still on their way).
 *
 * A plain CREATE INDEX: every migration runs inside the one migration transaction
 * (server/migrations.ts), where CREATE INDEX CONCURRENTLY is not allowed. Building it blocks
 * writes to feed_pay_calls until that transaction commits (reads go on). That is acceptable only
 * because the table is still small: it holds just the service calls made since Feed pay shipped
 * (migration 112), each one confirmed by its owner or its agent under the per-call and daily
 * limits. That is also why the index is added now and not later, when a plain build would hold
 * the lock for longer. No data changes.
 */
export const FEED_PAY_PAID_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS feed_pay_calls_paid ON feed_pay_calls (wallet_id, settled_at)
  WHERE payment_state = 'settled' AND tx_hash IS NOT NULL;`;

export const feedPayPaidIndexMigration: Migration = {
  version: 120,
  name: 'feed_pay_calls_paid',
  sql: FEED_PAY_PAID_INDEX_SQL,
};

/** Idempotent; call before runMigrations (after 112, which creates feed_pay_calls). */
export function registerFeedPayPaidIndexMigration(): void {
  registerMigration(feedPayPaidIndexMigration);
}
