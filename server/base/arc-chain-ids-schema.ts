import { registerMigration, type Migration } from '../migrations.js';
import { ARC_MAINNET, ARC_TESTNET } from '../../shared/chains.js';

/*
 * Migrations 337-348: the tables that name their allowed chains also accept Arc (shared/chains.ts). Each
 * keeps every chain it allowed before. NOT VALID: no table is scanned, existing rows passed a
 * narrower check, and new rows are checked at once. Nothing writes an Arc row while CITY_ARC is off.
 * Each table has its own migration and lock_timeout of 2 s; if a lock's not had, that one rolls back
 * and the next cold start tries again. Running one again changes nothing.
 */
const ARC = `${ARC_MAINNET}, ${ARC_TESTNET}`;

const TABLES: ReadonlyArray<readonly [table: string, before: string]> = [
  ['base_wallets', '84532, 8453, 31337'],
  ['base_fleet_jobs', '84532, 8453, 31337'],
  ['base_x402_authorizations', '84532, 8453, 31337'],
  ['base_wallet_withdrawals', '84532, 8453'],
  ['base_pay_lookups', '84532, 8453'],
  ['base_wallet_payments', '84532, 8453'],
  ['base_agent_pay_consents', '84532, 8453, 31337'],
  ['base_rate_lookups', '84532, 8453'],
  ['base_x402_receipts', '8453, 84532'],
  ['protocol_fee_events', '8453, 84532, 31337'],
  ['protocol_fee_scan_state', '8453, 84532, 31337'],
  ['protocol_fee_router_starts', '8453, 84532, 31337'],
];

/** One migration per table: the runner's transaction holds each table's lock for milliseconds. */
export const arcChainIdsMigrations: readonly Migration[] = TABLES.map(([table, before], index) => ({
  version: 337 + index,
  name: `arc_chain_ids_${table}`,
  sql: `SET LOCAL lock_timeout = '2s';
ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_chain_id_check;
ALTER TABLE ${table} ADD CONSTRAINT ${table}_chain_id_check
  CHECK (chain_id IN (${before}, ${ARC})) NOT VALID;`,
}));

/** Idempotent; call before runMigrations (after the migrations that create these tables). */
export function registerArcChainIdsMigrations(): void {
  for (const migration of arcChainIdsMigrations) registerMigration(migration);
}
