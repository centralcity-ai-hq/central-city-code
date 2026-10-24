import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 255 `base_identities_base_id`: the index the Explorer's newest-first list and its
 * passport lookup read through (store.ts: ORDER BY BASE_ID DESC, i.agent_id DESC LIMIT 51, and
 * BASE_ID = $4, where BASE_ID is COALESCE(i.erc8004_agent_id, i.provisional_agent_id)).
 * base_identities had no index on it, so every uncached list sorted all ~760k registrations
 * (13 s cold, 23 Oct 2026). The expression is BASE_ID's own, column for column, so the planner
 * matches it. No data changes.
 *
 * A plain CREATE INDEX: every migration runs inside the one migration transaction
 * (server/migrations.ts), where CREATE INDEX CONCURRENTLY is not allowed, and building it here
 * blocks writes to base_identities until that transaction commits (reads go on). On prod build it
 * first by hand with
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS base_identities_base_id ON base_identities
 *     (chain_id, (COALESCE(erc8004_agent_id, provisional_agent_id)) DESC, agent_id DESC);
 * and check it is valid (pg_index.indisvalid) before this migration runs: IF NOT EXISTS then
 * skips it, and a failed concurrent build must be dropped first, or it would be skipped invalid.
 */
export const BASE_IDENTITIES_BASE_ID_SQL = `
CREATE INDEX IF NOT EXISTS base_identities_base_id ON base_identities
  (chain_id, (COALESCE(erc8004_agent_id, provisional_agent_id)) DESC, agent_id DESC);`;

export const baseIdentitiesBaseIdMigration: Migration = {
  version: 255,
  name: 'base_identities_base_id',
  sql: BASE_IDENTITIES_BASE_ID_SQL,
};

/** Idempotent; call before runMigrations (after the Base migration, which creates base_identities). */
export function registerBaseIdentitiesBaseIdMigration(): void {
  registerMigration(baseIdentitiesBaseIdMigration);
}
