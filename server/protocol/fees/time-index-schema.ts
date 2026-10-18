import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 172 `protocol_fee_events_time`: the index the public fee metrics
 * (server/protocol/fees/routes.ts, dailyFees in ./ledger.ts) read their window through, by chain
 * and block time, so a request reads only the days it asks for and never every row of the chain.
 *
 * A plain CREATE INDEX: every migration runs inside the one migration transaction
 * (server/migrations.ts), where CREATE INDEX CONCURRENTLY is not allowed. Building it blocks writes
 * to protocol_fee_events until that transaction commits (reads go on). Only the scan cron writes
 * that table, and it reads the same blocks again on its next run, so a scan that waited loses
 * nothing. The table holds one row per protocol fee event and is still small, which is also why
 * the index is added now. No data changes.
 */
export const PROTOCOL_FEE_TIME_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS protocol_fee_events_time ON protocol_fee_events (chain_id, block_time);`;

export const protocolFeeTimeIndexMigration: Migration = {
  version: 172,
  name: 'protocol_fee_events_time',
  sql: PROTOCOL_FEE_TIME_INDEX_SQL,
};

/** Idempotent; call before runMigrations (after 113, which creates protocol_fee_events). */
export function registerProtocolFeeTimeIndexMigration(): void {
  registerMigration(protocolFeeTimeIndexMigration);
}
