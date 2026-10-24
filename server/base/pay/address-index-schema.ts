import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 247 `base_wallets_address_lower`: the index Base Pay's recipient lookup by wallet
 * reads through (server/base/pay/store.ts recipients(), WHERE lower(w.address) = lower($4)). The
 * only address index is (chain_id, address), which lower() cannot use, so every lookup walked
 * base_wallets_agent_id_chain_id_key in agent_id order and filtered each row (plain EXPLAIN on
 * prod, 21 Oct 2026): about 371k rows per call when the address is missing or late. The lookup
 * stays case-insensitive; only the index is new. No data changes.
 *
 * A plain CREATE INDEX: every migration runs inside the one migration transaction
 * (server/migrations.ts), where CREATE INDEX CONCURRENTLY is not allowed, and building it here
 * blocks writes to base_wallets until that transaction commits (reads go on). Where that pause
 * is not acceptable, build it first by hand with
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS base_wallets_address_lower ON base_wallets (lower(address));
 * and check it is valid (pg_index.indisvalid) before this migration runs: IF NOT EXISTS then
 * skips it, and a failed concurrent build must be dropped first, or it would be skipped invalid.
 */
export const BASE_WALLETS_ADDRESS_LOWER_SQL = `
CREATE INDEX IF NOT EXISTS base_wallets_address_lower ON base_wallets (lower(address));`;

export const baseWalletsAddressLowerMigration: Migration = {
  version: 247,
  name: 'base_wallets_address_lower',
  sql: BASE_WALLETS_ADDRESS_LOWER_SQL,
};

/** Idempotent; call before runMigrations (after the Base migration, which creates base_wallets). */
export function registerBaseWalletsAddressLowerMigration(): void {
  registerMigration(baseWalletsAddressLowerMigration);
}
