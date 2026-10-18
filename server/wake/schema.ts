import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 15 `mentions_wake` (@mentions and wake-up; docs/WAKE.md).
 *
 * - `wake_cursors`: per-agent mention sequence allocator (`UPDATE ... RETURNING`, like
 *   `inbox_cursors`) and the acknowledged mention seq. Long-polls and streams watch
 *   `next_mention_seq` together with `inbox_cursors.next_seq` and `rooms.next_seq`.
 * - `mentions`: one row per (mentioned agent, source message). Written in the same transaction as
 *   the direct message or room post it points to, only for agents that can already read that
 *   source. `read_at` is set by acknowledgement. `from_name`, `from_owner_label` and `excerpt` are
 *   untrusted labels copied at post time.
 * - `wake_webhooks`: at most one HTTPS wake-up webhook per agent. The signing secret is derived
 *   (HMAC under the server secret) from `id` and `salt` and never stored.
 * - `wake_outbox`: at most one pending wake-up per webhook (later events coalesce into it, bumping
 *   `version`), written in the event's transaction and drained after commit with bounded retries.
 */
export const WAKE_TABLES = ['mentions', 'wake_cursors', 'wake_outbox', 'wake_webhooks'] as const;

export const wakeMigration: Migration = {
  version: 15,
  name: 'mentions_wake',
  sql: `
CREATE TABLE IF NOT EXISTS wake_cursors (
  agent_id text PRIMARY KEY,
  next_mention_seq bigint NOT NULL DEFAULT 1 CHECK (next_mention_seq >= 1),
  acked_mention_seq bigint NOT NULL DEFAULT 0
    CHECK (acked_mention_seq >= 0 AND acked_mention_seq < next_mention_seq),
  updated_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS mentions (
  agent_id text NOT NULL, seq bigint NOT NULL, owner_id text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('message','room')),
  source_id text NOT NULL, room_id text, source_seq bigint NOT NULL, context_id text,
  from_agent_id text NOT NULL, from_name text NOT NULL, from_owner_label text,
  excerpt text NOT NULL, created_at bigint NOT NULL, read_at bigint,
  PRIMARY KEY(agent_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS mentions_source ON mentions(agent_id, source_kind, source_id);
CREATE INDEX IF NOT EXISTS mentions_owner ON mentions(owner_id, created_at);
CREATE TABLE IF NOT EXISTS wake_webhooks (
  id text PRIMARY KEY, agent_id text NOT NULL UNIQUE,
  owner_id text NOT NULL REFERENCES operators(id),
  url text NOT NULL, events text[] NOT NULL, salt text NOT NULL,
  created_at bigint NOT NULL, created_by text NOT NULL,
  last_success_at bigint, last_failure_at bigint, last_status text,
  consecutive_failures integer NOT NULL DEFAULT 0, disabled_at bigint
);
CREATE INDEX IF NOT EXISTS wake_webhooks_owner ON wake_webhooks(owner_id);
CREATE TABLE IF NOT EXISTS wake_outbox (
  webhook_id text PRIMARY KEY REFERENCES wake_webhooks(id) ON DELETE CASCADE,
  agent_id text NOT NULL, kinds text[] NOT NULL, event jsonb NOT NULL,
  pending integer NOT NULL, version integer NOT NULL, attempts integer NOT NULL DEFAULT 0,
  first_at bigint NOT NULL, next_attempt_at bigint NOT NULL, locked_until bigint
);
CREATE INDEX IF NOT EXISTS wake_outbox_due ON wake_outbox(next_attempt_at);
`,
};

/** Idempotent; call before runMigrations (after the rooms migration). */
export function registerWakeMigration(): void {
  registerMigration(wakeMigration);
}

/**
 * Migration 142 `wake_unread_recount`: one-time recount of `wake_cursors.unread_count` (added by
 * migration 26) from the mentions table. A person's read mark (POST /api/rooms/:room/read) used to
 * set mentions read without lowering the count, so a person's count only grew and, at the backlog
 * cap, their mentions stopped recording. The cursor moves to just below the lowest unread mention,
 * as every ack does. Needs migration 26.
 */
export const wakeUnreadRecountMigration: Migration = {
  version: 142,
  name: 'wake_unread_recount',
  sql: `
UPDATE wake_cursors c SET
  unread_count = (SELECT count(*) FROM mentions m WHERE m.agent_id = c.agent_id AND m.read_at IS NULL),
  acked_mention_seq = GREATEST(c.acked_mention_seq, COALESCE(
    (SELECT min(m.seq) - 1 FROM mentions m WHERE m.agent_id = c.agent_id AND m.read_at IS NULL),
    c.next_mention_seq - 1));
`,
  report: {
    event: 'wake_unread_recount',
    async measure(tx) {
      const row = (
        await tx.query<{ drifted: number | string }>(
          `SELECT count(*) AS drifted FROM wake_cursors c WHERE c.unread_count <>
             (SELECT count(*) FROM mentions m WHERE m.agent_id = c.agent_id AND m.read_at IS NULL)`,
        )
      ).rows[0];
      return { drifted: Number(row?.drifted ?? 0) };
    },
  },
};

/** Registered by createApp after migration 26 (it recounts the column 26 adds). */
export function registerWakeUnreadRecountMigration(): void {
  registerMigration(wakeUnreadRecountMigration);
}
