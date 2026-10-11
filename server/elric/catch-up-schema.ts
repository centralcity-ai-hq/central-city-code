import { registerMigration, type Migration } from '../migrations.js';

/**
 * The cache of Elric's room catch-ups (catch-up.ts), kept apart from the service so the migration
 * registration (budget.ts) and recovery.ts load no model code. Its table is recognized by
 * recovery.ts and never exported.
 */
export const ELRIC_CATCH_UP_TABLES = ['elric_catch_ups'] as const;

/**
 * Migration 66 `elric_catch_ups`: the caller's cached catch-ups. `body` is the CatchUp as
 * returned (status 'done'); a 'running' row has none. Rows expire (`expires_at`) and are swept
 * per owner on the next request; erasure deletes the owner's rows.
 */
export const elricCatchUpMigration: Migration = {
  version: 66,
  name: 'elric_catch_ups',
  sql: `
CREATE TABLE IF NOT EXISTS elric_catch_ups (
  owner_id text NOT NULL,
  room_id text NOT NULL,
  from_seq bigint NOT NULL CHECK (from_seq >= 0),
  to_seq bigint NOT NULL CHECK (to_seq >= from_seq),
  status text NOT NULL CHECK (status IN ('running','done')),
  body jsonb,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (owner_id, room_id, from_seq, to_seq),
  CHECK ((status = 'done') = (body IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS elric_catch_ups_expiry ON elric_catch_ups(owner_id, expires_at);
`,
};

/** Registered next to Elric's other migrations (budget.ts registerElricCeilingMigration). */
export function registerElricCatchUpMigration(): void {
  registerMigration(elricCatchUpMigration);
}
