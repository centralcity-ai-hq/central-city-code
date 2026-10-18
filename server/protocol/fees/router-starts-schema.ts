import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 232 `protocol_fee_router_starts` (Operation Fee Contract): one row per fee router the
 * ledger has started reading after the first one. A router added later (router 2, payments above
 * 0.10 USDC) is configured only after its deployment, when the scan checkpoint may already be past
 * its deploy block. On the first scan that sees it, the ledger records it here and moves the
 * checkpoint back to that block in the same transaction (ledger.ts startAddedRouters), so the
 * normal scan re-reads that range once and no fee of the new router is missed. A router dropped
 * from the config is marked inactive (a scan without it replaces its rows); configured again, it is
 * re-read from its deploy block once more. No data changes.
 */
export const PROTOCOL_FEE_ROUTER_STARTS_SQL = `
CREATE TABLE IF NOT EXISTS protocol_fee_router_starts (
  chain_id integer NOT NULL CHECK (chain_id IN (8453,84532,31337)),
  router text NOT NULL CHECK (router ~ '^0x[0-9a-f]{40}$'),
  from_block bigint NOT NULL CHECK (from_block >= 0),
  started_at bigint NOT NULL,
  -- false while the router is not configured: configuring it again re-reads its history.
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (chain_id, router)
);`;

export const protocolFeeRouterStartsMigration: Migration = {
  version: 232,
  name: 'protocol_fee_router_starts',
  sql: PROTOCOL_FEE_ROUTER_STARTS_SQL,
};

/** Idempotent; call before runMigrations (after 113, which creates the ledger). */
export function registerProtocolFeeRouterStartsMigration(): void {
  registerMigration(protocolFeeRouterStartsMigration);
}
