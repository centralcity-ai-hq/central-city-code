import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 248 `feed_pay_sponsor_credits` (247 belongs to the open base_wallets index change):
 * the sponsored first purchase (server/feed/pay/sponsor.ts). Two new tables, nothing else read or
 * changed; unused while CITY_SFP_ENABLED is not '1'.
 *
 * - `feed_pay_sponsor_credits`: one row per agent that used (or holds) its one sponsored purchase.
 *   The primary key on agent_id is what makes the credit single-use; a released row (the call was
 *   not paid) may be reserved again.
 * - `feed_pay_sponsor_days`: what each UTC day's credits hold (reserved + used), one row per day,
 *   so the daily budget is one row read under the sponsor lock, never a sum over the day's credits
 *   (10,000 a hour at fleet scale).
 * - `feed_pay_sponsor_refusals`: refusal counts per minute and code, for the ops stats only.
 */
/**
 * The sponsored first purchase's tables (migrations 248-250: this file, sponsor-key.ts and
 * sponsored.ts), for server/recovery.ts: recognized, never exported.
 */
export const FEED_PAY_SPONSOR_TABLES = [
  'feed_pay_sponsor_credits',
  'feed_pay_sponsor_days',
  'feed_pay_sponsor_refusals',
  'feed_pay_sponsor_key',
  'feed_pay_sponsored_calls',
] as const;

export const FEED_PAY_SPONSOR_SQL = `
CREATE TABLE IF NOT EXISTS feed_pay_sponsor_credits (
  agent_id text PRIMARY KEY,
  chain_id integer NOT NULL,
  owner_account_id text NOT NULL,
  call_id text NOT NULL UNIQUE,
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0 AND amount_raw <= 2000000),
  state text NOT NULL CHECK (state IN ('reserved','used','released')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_pay_sponsor_credits_updated
  ON feed_pay_sponsor_credits (updated_at);
CREATE INDEX IF NOT EXISTS feed_pay_sponsor_credits_owner
  ON feed_pay_sponsor_credits (owner_account_id, created_at) WHERE state <> 'released';
CREATE TABLE IF NOT EXISTS feed_pay_sponsor_days (
  day bigint PRIMARY KEY,
  spent_raw numeric(78,0) NOT NULL DEFAULT 0 CHECK (spent_raw >= 0),
  credits integer NOT NULL DEFAULT 0 CHECK (credits >= 0)
);
CREATE TABLE IF NOT EXISTS feed_pay_sponsor_refusals (
  minute bigint NOT NULL,
  code text NOT NULL,
  n integer NOT NULL,
  PRIMARY KEY (minute, code)
);`;

export const feedPaySponsorMigration: Migration = {
  version: 248,
  name: 'feed_pay_sponsor_credits',
  sql: FEED_PAY_SPONSOR_SQL,
};

/** Idempotent; call before runMigrations (after the Base migration and Feed pay, 112). */
export function registerFeedPaySponsorMigration(): void {
  registerMigration(feedPaySponsorMigration);
}
