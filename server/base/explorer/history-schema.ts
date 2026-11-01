import { registerMigration, type Migration } from '../../migrations.js';

/** Optional chart observations: excluded from recovery; collection restarts after restore. */
export const EXPLORER_HISTORY_SQL = `
CREATE TABLE IF NOT EXISTS explorer_history_start (
  metric text PRIMARY KEY CHECK (metric IN ('agents','base','finalizing','calls','ratings')),
  collected_at bigint NOT NULL CHECK (collected_at >= 0)
);
CREATE TABLE IF NOT EXISTS explorer_history (
  metric text NOT NULL REFERENCES explorer_history_start(metric),
  hour bigint NOT NULL CHECK (hour >= 0 AND hour % 3600000 = 0),
  value bigint NOT NULL CHECK (value >= 0 AND value <= 9007199254740991),
  observed_at bigint NOT NULL CHECK (observed_at >= hour AND observed_at < hour + 3600000),
  PRIMARY KEY (metric, hour)
);`;
export const explorerHistoryMigration: Migration = {
  version: 268,
  name: 'explorer_public_observations',
  sql: EXPLORER_HISTORY_SQL,
};
export function registerExplorerHistoryMigration() {
  registerMigration(explorerHistoryMigration);
}
