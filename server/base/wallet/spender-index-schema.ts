import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 253 `base_wallets_spender`: the index two hot lookups by spender read through,
 * identity-port.ts walletUsable() and payment-chain.ts (both `WHERE spender_address = $1 AND
 * chain_id = $2`). base_wallets had no index on spender_address, so each call scanned the table
 * (Neon query performance, 22-23 Oct 2026: 793k calls, avg 1 s, during the DB overload). The
 * manual base_wallets_spender_lower (docs/explorer-service-calls-indexes.md) is on
 * lower(spender_address), which a plain equality cannot use. No data changes.
 *
 * A plain CREATE INDEX: every migration runs inside the one migration transaction
 * (server/migrations.ts), where CREATE INDEX CONCURRENTLY is not allowed, and building it here
 * blocks writes to base_wallets until that transaction commits (reads go on). On prod build it
 * first by hand with
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS base_wallets_spender ON base_wallets (spender_address, chain_id);
 * and check it is valid (pg_index.indisvalid) before this migration runs: IF NOT EXISTS then
 * skips it, and a failed concurrent build must be dropped first, or it would be skipped invalid.
 */
export const BASE_WALLETS_SPENDER_SQL = `
CREATE INDEX IF NOT EXISTS base_wallets_spender ON base_wallets (spender_address, chain_id);`;

export const baseWalletsSpenderMigration: Migration = {
  version: 253,
  name: 'base_wallets_spender',
  sql: BASE_WALLETS_SPENDER_SQL,
};

/** Idempotent; call before runMigrations (after the Base migration, which creates base_wallets). */
export function registerBaseWalletsSpenderMigration(): void {
  registerMigration(baseWalletsSpenderMigration);
}
