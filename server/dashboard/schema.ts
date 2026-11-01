import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 336 `dashboard_rollups`: the rollup tables of the public Agent Dashboard
 * (server/dashboard/rollup.ts, shared/dashboard.ts). Additive only: new, empty tables; nothing on
 * the payment, fee, rating or identity tables changes (no trigger, no index).
 *
 * - dashboard_hourly / dashboard_daily: one value per (hour | day, metric). Hourly rows are kept
 *   DASHBOARD_HOURLY_KEEP_MS (8 days), daily rows for good.
 * - dashboard_active_hourly / dashboard_active_daily: one row per (hour | day, agent) active then,
 *   with role bits (1 bought, 2 sold, 4 rated or registered), for exact distinct counts.
 * - dashboard_agent_last: each agent's latest active, buying and selling hour, so "distinct agents
 *   active since X" (and only-buy / only-sell / both) is one range read, never a scan of sources.
 * - dashboard_service_hourly / dashboard_service_daily: paid calls per service.
 * - dashboard_snapshots: the finished public answer per range, read by primary key per request.
 * - dashboard_state: one row: the cron's lease, the live start, watermarks and backfill cursors.
 *
 * Derived data: never exported by backups (server/recovery.ts); after a restore the backfill
 * builds everything again from the source tables.
 */
export const DASHBOARD_TABLES = [
  'dashboard_hourly',
  'dashboard_daily',
  'dashboard_active_hourly',
  'dashboard_active_daily',
  'dashboard_agent_last',
  'dashboard_service_hourly',
  'dashboard_service_daily',
  'dashboard_snapshots',
  'dashboard_state',
] as const;

export const DASHBOARD_ROLLUPS_SQL = `
CREATE TABLE IF NOT EXISTS dashboard_hourly (
  hour bigint NOT NULL CHECK (hour >= 0 AND hour % 3600000 = 0),
  metric text NOT NULL CHECK (metric ~ '^[a-z0-9_:]{1,40}$'),
  value numeric(78,0) NOT NULL,
  PRIMARY KEY (hour, metric)
);
CREATE TABLE IF NOT EXISTS dashboard_daily (
  day date NOT NULL,
  metric text NOT NULL CHECK (metric ~ '^[a-z0-9_:]{1,40}$'),
  value numeric(78,0) NOT NULL,
  PRIMARY KEY (day, metric)
);
CREATE TABLE IF NOT EXISTS dashboard_active_hourly (
  hour bigint NOT NULL CHECK (hour >= 0 AND hour % 3600000 = 0),
  agent_id text NOT NULL,
  roles smallint NOT NULL CHECK (roles BETWEEN 1 AND 7),
  PRIMARY KEY (hour, agent_id)
);
CREATE TABLE IF NOT EXISTS dashboard_active_daily (
  day date NOT NULL,
  agent_id text NOT NULL,
  roles smallint NOT NULL CHECK (roles BETWEEN 1 AND 7),
  PRIMARY KEY (day, agent_id)
);
CREATE TABLE IF NOT EXISTS dashboard_agent_last (
  agent_id text PRIMARY KEY,
  last_any bigint NOT NULL,
  last_buy bigint NOT NULL DEFAULT 0,
  last_sell bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS dashboard_agent_last_any ON dashboard_agent_last (last_any);
CREATE TABLE IF NOT EXISTS dashboard_service_hourly (
  hour bigint NOT NULL CHECK (hour >= 0 AND hour % 3600000 = 0),
  service_id text NOT NULL,
  title text NOT NULL,
  calls bigint NOT NULL,
  value_raw numeric(78,0) NOT NULL,
  PRIMARY KEY (hour, service_id)
);
CREATE TABLE IF NOT EXISTS dashboard_service_daily (
  day date NOT NULL,
  service_id text NOT NULL,
  title text NOT NULL,
  calls bigint NOT NULL,
  value_raw numeric(78,0) NOT NULL,
  PRIMARY KEY (day, service_id)
);
CREATE TABLE IF NOT EXISTS dashboard_snapshots (
  range text PRIMARY KEY CHECK (range IN ('24h','7d','30d','90d','12m','all')),
  body jsonb NOT NULL,
  computed_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS dashboard_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  lease_until bigint NOT NULL DEFAULT 0,
  live_from bigint,
  live_through bigint,
  base_seen bigint,
  base_from bigint,
  max_base_id numeric(78,0),
  backfill jsonb NOT NULL DEFAULT '{}'::jsonb,
  backfill_done boolean NOT NULL DEFAULT false,
  slow_at bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL DEFAULT 0
);
INSERT INTO dashboard_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
`;

export const dashboardRollupsMigration: Migration = {
  version: 336,
  name: 'dashboard_rollups',
  sql: DASHBOARD_ROLLUPS_SQL,
};

/** Idempotent; call before runMigrations. */
export function registerDashboardRollupsMigration(): void {
  registerMigration(dashboardRollupsMigration);
}
