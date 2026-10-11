import { registerMigration, type Migration } from '../migrations.js';
import {
  countLogFeedIndexesMigration,
  countLogPendingBackfillMigration,
  countLogPendingMigration,
} from './pending.js';

/**
 * Migration 29 `count_log` (the verifiable agent count). Three append-only tables: triggers refuse every
 * UPDATE, DELETE and TRUNCATE, so the log can only grow; a rewrite would also break the published hash
 * chain and the public witness copy. `salt` is secret (revealed only to an agent's owner in a
 * proof); the tables are recognized by offline backup and never exported.
 */
export const COUNT_LOG_TABLES = [
  'count_log_checkpoints',
  'count_log_leaves',
  'count_log_withdrawn',
] as const;

export const countLogMigration: Migration = {
  version: 29,
  name: 'count_log',
  sql: `
CREATE TABLE IF NOT EXISTS count_log_leaves (
  idx integer PRIMARY KEY CHECK (idx >= 0),
  agent_id text NOT NULL UNIQUE,
  salt bytea NOT NULL CHECK (octet_length(salt) = 32),
  created_day text NOT NULL CHECK (created_day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  leaf_hash bytea NOT NULL CHECK (octet_length(leaf_hash) = 32),
  appended_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS count_log_withdrawn (
  idx integer PRIMARY KEY REFERENCES count_log_leaves(idx),
  reason text NOT NULL CHECK (reason IN ('no_longer_counted')),
  day text NOT NULL CHECK (day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  recorded_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS count_log_checkpoints (
  date text PRIMARY KEY CHECK (date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  tree_size integer NOT NULL CHECK (tree_size >= 0),
  withdrawn integer NOT NULL CHECK (withdrawn >= 0),
  root text NOT NULL,
  prev_hash text,
  hash text NOT NULL UNIQUE,
  subcounts jsonb NOT NULL,
  consistency jsonb NOT NULL,
  signature jsonb,
  created_at bigint NOT NULL
);
CREATE OR REPLACE FUNCTION count_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'count_log tables are append-only';
END;
$$;
CREATE TRIGGER count_log_leaves_append_only BEFORE UPDATE OR DELETE ON count_log_leaves
  FOR EACH ROW EXECUTE FUNCTION count_log_append_only();
CREATE TRIGGER count_log_withdrawn_append_only BEFORE UPDATE OR DELETE ON count_log_withdrawn
  FOR EACH ROW EXECUTE FUNCTION count_log_append_only();
CREATE TRIGGER count_log_checkpoints_append_only BEFORE UPDATE OR DELETE ON count_log_checkpoints
  FOR EACH ROW EXECUTE FUNCTION count_log_append_only();
CREATE TRIGGER count_log_leaves_no_truncate BEFORE TRUNCATE ON count_log_leaves
  FOR EACH STATEMENT EXECUTE FUNCTION count_log_append_only();
CREATE TRIGGER count_log_withdrawn_no_truncate BEFORE TRUNCATE ON count_log_withdrawn
  FOR EACH STATEMENT EXECUTE FUNCTION count_log_append_only();
CREATE TRIGGER count_log_checkpoints_no_truncate BEFORE TRUNCATE ON count_log_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION count_log_append_only();
`,
};

/**
 * Migration 72 `count_log_checkpoint_v2`: checkpoint format v2. New checkpoints sign a salted
 * commitment to the sub-counts instead of the sub-counts; the plaintext and its salt stay in
 * these private columns. Existing rows keep v = 1 and their stored bytes (the table is
 * append-only; the public API withholds their sub-counts).
 */
export const countLogCheckpointV2Migration: Migration = {
  version: 72,
  name: 'count_log_checkpoint_v2',
  sql: `
ALTER TABLE count_log_checkpoints
  ADD COLUMN IF NOT EXISTS v smallint NOT NULL DEFAULT 1 CHECK (v IN (1, 2)),
  ADD COLUMN IF NOT EXISTS subcounts_commitment text CHECK (subcounts_commitment ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS subcounts_salt bytea CHECK (octet_length(subcounts_salt) = 32);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'count_log_checkpoints_v2_commitment'
  ) THEN
    ALTER TABLE count_log_checkpoints ADD CONSTRAINT count_log_checkpoints_v2_commitment
      CHECK (v = 1 OR (subcounts_commitment IS NOT NULL AND subcounts_salt IS NOT NULL));
  END IF;
END
$$;
`,
};

/** Idempotent; call before runMigrations. */
export function registerCountLogMigration(): void {
  registerMigration(countLogMigration);
  // Migration 47: the live pending feed (pending.ts) rides on the same registration point.
  registerMigration(countLogPendingMigration);
  registerMigration(countLogPendingBackfillMigration);
  // Migration 60: the feed's indexes (pending.ts).
  registerMigration(countLogFeedIndexesMigration);
  registerMigration(countLogCheckpointV2Migration);
}
