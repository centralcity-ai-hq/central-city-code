import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 234 `feed_pay_float_target` (Operation Fee Contract, docs/protocol/FEE_ROUTER_2.md
 * section 6): `feed_pay_agent_settings.float_target_raw`, the owner's pot target, 1 to 100 USDC;
 * null is the default (1 USDC). No existing row changes. (The 0.10 USDC column bounds themselves
 * are widened by migration 233, server/feed/pay/router2-caps-schema.ts.)
 */
export const FEED_PAY_FLOAT_TARGET_SQL = `
ALTER TABLE feed_pay_agent_settings
  ADD COLUMN IF NOT EXISTS float_target_raw numeric(78,0) CHECK (float_target_raw IS NULL
    OR (float_target_raw >= 1000000 AND float_target_raw <= 100000000));`;

export const feedPayFloatTargetMigration: Migration = {
  version: 234,
  name: 'feed_pay_float_target',
  sql: FEED_PAY_FLOAT_TARGET_SQL,
};

/** Idempotent; call before runMigrations (after 112, which creates feed_pay_agent_settings). */
export function registerFeedPayFloatTargetMigration(): void {
  registerMigration(feedPayFloatTargetMigration);
}
