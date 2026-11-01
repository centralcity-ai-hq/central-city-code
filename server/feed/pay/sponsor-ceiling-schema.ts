import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 260 `feed_pay_sponsor_fleet_ceiling`: a stress-test FLEET agent's sponsored first
 * purchase may cost up to 20 USDC, fee included (SFP_FLEET_CREDIT_CEILING_RAW,
 * server/feed/pay/sponsor.ts), so the fleets can buy dearer services; a real user's stays at 2 USDC.
 *
 * Both tables of a sponsored purchase get a `fleet` column, written by the server when the credit is
 * reserved: true only when the buying agent's workspace (read from its wallet, never from the
 * request) is on CITY_SFP_FLEET_WORKSPACES. The price CHECKs of migrations 248 and 250 become
 * kind-specific, so the storage itself holds the 2 USDC limit for everything that is not a fleet
 * credit, whatever the code above it does:
 *   amount_raw / gross_raw > 0 AND (<= 2 USDC OR (fleet AND <= 20 USDC))
 *
 * Old and new builds side by side, and a code rollback: a build without this change never writes
 * the column, so its rows are `fleet = false` (the default) and held to 2 USDC, its own limit too.
 * Forward-only like every migration; nothing has to be undone for an older build to run.
 *
 * Locks: every pending migration runs in ONE transaction (server/migrations.ts runMigrations), so
 * the ACCESS EXCLUSIVE lock each ALTER takes on these two tables is held until that transaction
 * commits: sponsored first purchases (and their reads) wait for the whole migration run. The work
 * under it is small: ADD COLUMN with a constant default rewrites nothing, and each new CHECK scans
 * its table once (one row per sponsored purchase; all existing rows are <= 2 USDC and fleet = false,
 * so it passes). Bounded: every session of the app's pool (server/database.ts) has lock_timeout 5 s
 * and statement_timeout 8 s, so an ALTER waits at most 5 s for its lock (behind a reader that is
 * itself cut at 8 s); if it cannot get it the migration run fails with 55P03, rolls back whole, and
 * the next cold start tries again. Requests queued behind a waiting ALTER give up after their own
 * 5 s too. Before deploying, count both tables and look for long open transactions on them.
 * Each CHECK is replaced by name (PostgreSQL's default name for a column CHECK), so running it
 * again changes nothing.
 */
const kindCheck = (column: string, fleetMax = 20000000) =>
  `CHECK (${column} > 0 AND (${column} <= 2000000 OR (fleet AND ${column} <= ${fleetMax})))`;

export const FEED_PAY_SPONSOR_FLEET_CEILING_SQL = `
ALTER TABLE feed_pay_sponsor_credits ADD COLUMN IF NOT EXISTS fleet boolean NOT NULL DEFAULT false;
ALTER TABLE feed_pay_sponsor_credits DROP CONSTRAINT IF EXISTS feed_pay_sponsor_credits_amount_raw_check;
ALTER TABLE feed_pay_sponsor_credits ADD CONSTRAINT feed_pay_sponsor_credits_amount_raw_check
  ${kindCheck('amount_raw')};
ALTER TABLE feed_pay_sponsored_calls ADD COLUMN IF NOT EXISTS fleet boolean NOT NULL DEFAULT false;
ALTER TABLE feed_pay_sponsored_calls DROP CONSTRAINT IF EXISTS feed_pay_sponsored_calls_gross_raw_check;
ALTER TABLE feed_pay_sponsored_calls ADD CONSTRAINT feed_pay_sponsored_calls_gross_raw_check
  ${kindCheck('gross_raw')};`;

export const feedPaySponsorFleetCeilingMigration: Migration = {
  version: 260,
  name: 'feed_pay_sponsor_fleet_ceiling',
  sql: FEED_PAY_SPONSOR_FLEET_CEILING_SQL,
};

/** Idempotent; call before runMigrations (after migrations 248 and 250, which create the tables). */
export function registerFeedPaySponsorFleetCeilingMigration(): void {
  registerMigration(feedPaySponsorFleetCeilingMigration);
}

/**
 * Migration 307 `feed_pay_sponsor_fleet_ceiling_40`: the fleet ceiling of migration 260 rises from
 * 20 USDC to 40 USDC, fee included (SFP_FLEET_CREDIT_CEILING_RAW). A real user's stays at 2 USDC:
 *   amount_raw / gross_raw > 0 AND (<= 2 USDC OR (fleet AND <= 40 USDC))
 * Migration 260 is applied and stays as written; this one replaces the same two CHECKs by name.
 * Every existing row passes (each is within the 260 bound, which is narrower), so the scan finds
 * nothing to refuse. Locks as in 260: the ACCESS EXCLUSIVE lock of each ALTER is held until the
 * migration run commits, bounded by the pool's lock_timeout 5 s / statement_timeout 8 s; on 55P03
 * the run rolls back whole and the next cold start tries again. Running it again changes nothing.
 * An older build (20 USDC limit in code) runs fine on it: its own limit is the narrower one.
 */
export const FEED_PAY_SPONSOR_FLEET_CEILING_40_SQL = `
ALTER TABLE feed_pay_sponsor_credits DROP CONSTRAINT IF EXISTS feed_pay_sponsor_credits_amount_raw_check;
ALTER TABLE feed_pay_sponsor_credits ADD CONSTRAINT feed_pay_sponsor_credits_amount_raw_check
  ${kindCheck('amount_raw', 40000000)};
ALTER TABLE feed_pay_sponsored_calls DROP CONSTRAINT IF EXISTS feed_pay_sponsored_calls_gross_raw_check;
ALTER TABLE feed_pay_sponsored_calls ADD CONSTRAINT feed_pay_sponsored_calls_gross_raw_check
  ${kindCheck('gross_raw', 40000000)};`;

export const feedPaySponsorFleetCeiling40Migration: Migration = {
  version: 307,
  name: 'feed_pay_sponsor_fleet_ceiling_40',
  sql: FEED_PAY_SPONSOR_FLEET_CEILING_40_SQL,
};

/** Idempotent; call before runMigrations (after migration 260). */
export function registerFeedPaySponsorFleetCeiling40Migration(): void {
  registerMigration(feedPaySponsorFleetCeiling40Migration);
}
