import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 127 `feed_pay_calls_included_settled` (server/feed/offers/uses.ts): the index the
 * 30-day use counts of the services sold by Central City agents are read through. It holds only
 * the fee-included calls whose payment Base shows used (pay_kind 'included', payment_state
 * 'settled'), by settled time, with the service, the paying wallet and the chain alongside, so the
 * refresh reads exactly the last 30 days of those calls and never the rest of the table (quotes,
 * refusals, x402 calls to the Bazaar's services, older calls).
 *
 * A plain CREATE INDEX: every migration runs inside the one migration transaction
 * (server/migrations.ts), where CREATE INDEX CONCURRENTLY is not allowed. Building it blocks writes
 * to feed_pay_calls until that transaction commits (reads go on); the engine retries a payment save
 * that waited too long (the payment itself is already on Base). The partial index covers only the
 * settled fee-included calls, a small part of a still small table, so the build is short. No data
 * changes.
 *
 * Version 127: 125 is the newest on main; 126 is taken by another open change.
 */
export const FEED_PAY_INCLUDED_SETTLED_SQL = `
CREATE INDEX IF NOT EXISTS feed_pay_calls_included_settled ON feed_pay_calls (settled_at)
  INCLUDE (service_id, wallet_id, chain_id)
  WHERE pay_kind = 'included' AND payment_state = 'settled';`;

export const feedPayIncludedSettledMigration: Migration = {
  version: 127,
  name: 'feed_pay_calls_included_settled',
  sql: FEED_PAY_INCLUDED_SETTLED_SQL,
};

/** Idempotent; call before runMigrations (after 123, which adds pay_kind). */
export function registerFeedPayIncludedSettledMigration(): void {
  registerMigration(feedPayIncludedSettledMigration);
}
