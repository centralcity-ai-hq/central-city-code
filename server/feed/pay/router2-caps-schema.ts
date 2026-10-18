import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 233 `feed_pay_router2_caps` (Operation Fee Contract, docs/protocol/FEE_ROUTER_2.md):
 * the database caps of one Feed payment move from 0.10 USDC (fee router 1's MAX_TOTAL) to 100 USDC
 * (fee router 2's), so a call routed to router 2 can be stored at all. The application still
 * enforces 0.10 USDC everywhere unless router 2 is configured and switched on
 * (CITY_PROTOCOL_FEE_ROUTER2_ENABLED): these checks are the outer bound, the code the inner one.
 *
 * Relaxed (each dropped and added again with the same name, 100_000 -> 100_000_000):
 * - feed_pay_calls.max_amount_raw and .amount_raw (migration 112)
 * - feed_pay_calls.fee_raw (migration 114): 0.01 -> 10 USDC (10% of 100 USDC)
 * - feed_pay_calls_total_cap: amount_raw + fee_raw (migration 114)
 * - feed_pay_agent_settings.per_call_max_raw, an owner's per-call maximum (migration 112)
 * - city_offers.price_raw, an offer's price, fee included (migration 122); its 0.05 minimum stays
 *
 * Widening a CHECK never rejects an existing row. No data changes.
 */
export const FEED_PAY_ROUTER2_CAPS_SQL = `
ALTER TABLE feed_pay_calls DROP CONSTRAINT IF EXISTS feed_pay_calls_max_amount_raw_check;
ALTER TABLE feed_pay_calls ADD CONSTRAINT feed_pay_calls_max_amount_raw_check
  CHECK (max_amount_raw > 0 AND max_amount_raw <= 100000000);
ALTER TABLE feed_pay_calls DROP CONSTRAINT IF EXISTS feed_pay_calls_amount_raw_check;
ALTER TABLE feed_pay_calls ADD CONSTRAINT feed_pay_calls_amount_raw_check
  CHECK (amount_raw > 0 AND amount_raw <= 100000000);
ALTER TABLE feed_pay_calls DROP CONSTRAINT IF EXISTS feed_pay_calls_fee_raw_check;
ALTER TABLE feed_pay_calls ADD CONSTRAINT feed_pay_calls_fee_raw_check
  CHECK (fee_raw >= 0 AND fee_raw <= 10000000);
ALTER TABLE feed_pay_calls DROP CONSTRAINT IF EXISTS feed_pay_calls_total_cap;
ALTER TABLE feed_pay_calls ADD CONSTRAINT feed_pay_calls_total_cap
  CHECK (amount_raw + fee_raw <= 100000000);
ALTER TABLE feed_pay_agent_settings DROP CONSTRAINT IF EXISTS feed_pay_agent_settings_per_call_max_raw_check;
ALTER TABLE feed_pay_agent_settings ADD CONSTRAINT feed_pay_agent_settings_per_call_max_raw_check
  CHECK (per_call_max_raw IS NULL OR (per_call_max_raw >= 1 AND per_call_max_raw <= 100000000));
ALTER TABLE city_offers DROP CONSTRAINT IF EXISTS city_offers_price_raw_check;
ALTER TABLE city_offers ADD CONSTRAINT city_offers_price_raw_check
  CHECK (price_raw >= 50000 AND price_raw <= 100000000);`;

export const feedPayRouter2CapsMigration: Migration = {
  version: 233,
  name: 'feed_pay_router2_caps',
  sql: FEED_PAY_ROUTER2_CAPS_SQL,
};

/** Idempotent; call before runMigrations (after 112, 114 and 122, which create these tables). */
export function registerFeedPayRouter2CapsMigration(): void {
  registerMigration(feedPayRouter2CapsMigration);
}
