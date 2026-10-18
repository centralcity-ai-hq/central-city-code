import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 123 `feed_pay_fee_included` (shared/feed-offers.ts, docs/FEED_PAY.md "Services sold by
 * Central City agents"): a Feed pay call can pay a service sold by a Central City agent with the
 * protocol fee INCLUDED in the price, in one router call (CentralCityFeeRouter.pay, FeeCharged kind
 * 1), and get the answer delivered in-process. Columns only on feed_pay_calls (a small table) plus
 * two partial indexes; nothing live is rewritten.
 *
 * - pay_kind: 'x402' (every call so far: the seller is paid through x402, the fee comes on top) or
 *   'included' (the router pays the seller 90% and the treasury 10% of the price in one operation;
 *   no x402 leg). For 'included', amount_raw is the seller's 90% and fee_raw the 10%, so the price
 *   is amount_raw + fee_raw and every existing sum (float, calendar cap, the $0.10 total cap) counts
 *   exactly the price.
 * - offer_id: the offer bought ('included' only).
 * - delivered_at: when the delivery of an 'included' call was committed (the not-yet-final exposure
 *   counts from then).
 * - pay_final_at: when the payment's operation was proven final on Base (its block at or below the
 *   finalized head, its block hash canonical); never from elapsed time.
 *
 * Version 123: 120 and 121 are taken by other changes, 122 is the offers
 * (server/feed/offers/schema.ts).
 */
export const FEED_PAY_INCLUDED_SQL = `
ALTER TABLE feed_pay_calls
  ADD COLUMN IF NOT EXISTS pay_kind text NOT NULL DEFAULT 'x402'
    CHECK (pay_kind IN ('x402','included')),
  ADD COLUMN IF NOT EXISTS offer_id text CHECK (offer_id IS NULL OR offer_id ~ '^off_[a-z2-7]{16}$'),
  ADD COLUMN IF NOT EXISTS delivered_at bigint,
  ADD COLUMN IF NOT EXISTS pay_final_at bigint;
CREATE INDEX IF NOT EXISTS feed_pay_calls_unfinal ON feed_pay_calls (pay_to)
  WHERE pay_kind = 'included' AND delivered_at IS NOT NULL AND pay_final_at IS NULL
    AND payment_state = 'settled';
CREATE INDEX IF NOT EXISTS feed_pay_calls_included_open ON feed_pay_calls (checked_at, updated_at)
  WHERE pay_kind = 'included' AND payment_state = 'settled' AND pay_final_at IS NULL;
`;

export const feedPayIncludedMigration: Migration = {
  version: 123,
  name: 'feed_pay_fee_included',
  sql: FEED_PAY_INCLUDED_SQL,
};

/** Idempotent; call before runMigrations (after migration 114). */
export function registerFeedPayIncludedMigration(): void {
  registerMigration(feedPayIncludedMigration);
}
