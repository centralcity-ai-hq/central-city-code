import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 114 `feed_pay_protocol_fee` (docs/protocol/FEES.md, "Fee on top"): the protocol fee
 * leg of a Feed pay call. A call made while protocol fees are on owes `fee_raw` (10% of the price,
 * on top); the fee is charged from the spender account through CentralCityFeeRouter.chargeFee only
 * after the seller's payment settled, as its own chain operation (kind 'protocol_fee').
 *
 * - fee_state: NULL (no fee: protocol fees off when the call was made), 'pending' (owed, not sent),
 *   'sent' (the operation is on its way), 'charged' (included without a revert), 'not_owed' (the
 *   seller was never paid, so no fee), 'failed' (reverted or never sendable; flagged for review).
 * - fee_verified: the fee row in the protocol fee ledger was marked service-verified (its price
 *   counts as volume).
 * Columns only on feed_pay_calls (a small, new table) and a widened check on base_chain_ops added
 * NOT VALID, so nothing live is scanned under a lock.
 */
export const FEED_PAY_FEE_SQL = `
ALTER TABLE feed_pay_calls
  ADD COLUMN IF NOT EXISTS fee_raw numeric(78,0) NOT NULL DEFAULT 0
    CHECK (fee_raw >= 0 AND fee_raw <= 10000),
  ADD COLUMN IF NOT EXISTS fee_state text
    CHECK (fee_state IS NULL OR fee_state IN ('pending','sent','charged','not_owed','failed')),
  ADD COLUMN IF NOT EXISTS fee_op_key text,
  ADD COLUMN IF NOT EXISTS fee_tx_hash text CHECK (fee_tx_hash IS NULL OR fee_tx_hash ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS fee_block bigint,
  ADD COLUMN IF NOT EXISTS fee_verified boolean NOT NULL DEFAULT false,
  -- The fee route pinned when the call was reserved (the router fixes its token and treasury):
  -- submission and verification use it, never the configuration at that later moment.
  ADD COLUMN IF NOT EXISTS fee_router text
    CHECK (fee_router IS NULL OR fee_router ~ '^0x[0-9a-f]{40}$');
ALTER TABLE feed_pay_calls DROP CONSTRAINT IF EXISTS feed_pay_calls_total_cap;
ALTER TABLE feed_pay_calls ADD CONSTRAINT feed_pay_calls_total_cap
  CHECK (amount_raw + fee_raw <= 100000);
ALTER TABLE feed_pay_calls DROP CONSTRAINT IF EXISTS feed_pay_calls_fee_owed;
ALTER TABLE feed_pay_calls ADD CONSTRAINT feed_pay_calls_fee_owed
  CHECK ((fee_raw = 0) = (fee_state IS NULL) AND (fee_state IS NULL) = (fee_router IS NULL));
CREATE INDEX IF NOT EXISTS feed_pay_calls_fee_open ON feed_pay_calls (checked_at, updated_at)
  WHERE fee_state IN ('pending','sent') OR (fee_state = 'charged' AND NOT fee_verified);
ALTER TABLE base_chain_ops DROP CONSTRAINT IF EXISTS base_chain_ops_kind_check;
ALTER TABLE base_chain_ops ADD CONSTRAINT base_chain_ops_kind_check CHECK (kind IN
  ('userop','batch','transfer','register','approve','pull','settle','cancel_authorization','sweep',
   'withdraw','withdraw_cancel','rate','protocol_fee')) NOT VALID;`;

export const feedPayFeeMigration: Migration = {
  version: 114,
  name: 'feed_pay_protocol_fee',
  sql: FEED_PAY_FEE_SQL,
};

export function registerFeedPayFeeMigration(): void {
  registerMigration(feedPayFeeMigration);
}
