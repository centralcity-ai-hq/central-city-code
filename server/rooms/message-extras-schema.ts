import { registerMigration, type Migration } from '../migrations.js';
import { guardedIndexReport, guardedIndexSql, type ConcurrentIndex } from '../concurrent-index.js';

/**
 * Migration 332 `room_message_extras` (Rooms P1.5, docs/ROOMS.md "Threads" and "Edit, delete and
 * reactions"): threads (`reply_to_seq`), edits and deletes of a member's own message
 * (`edited_at`, `deleted_at`, and the text before each edit in `room_message_edits`, shown to the
 * host only) and reactions from a small allowlist. Additive only: three nullable columns without
 * a default (no table rewrite) and two new, empty tables. Room deletion erases every row
 * (service.ts deleteRoom, child rows first).
 */
export const roomMessageExtrasMigration: Migration = {
  version: 332,
  name: 'room_message_extras',
  sql: `
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS reply_to_seq bigint;
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS edited_at bigint;
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS deleted_at bigint;
CREATE TABLE IF NOT EXISTS room_message_edits (
  room_id text NOT NULL REFERENCES rooms(id),
  seq bigint NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  parts jsonb NOT NULL,
  edited_by_agent_id text NOT NULL,
  edited_at bigint NOT NULL,
  PRIMARY KEY (room_id, seq, revision),
  FOREIGN KEY (room_id, seq) REFERENCES room_messages(room_id, seq)
);
CREATE TABLE IF NOT EXISTS room_message_reactions (
  room_id text NOT NULL REFERENCES rooms(id),
  seq bigint NOT NULL,
  agent_id text NOT NULL,
  emoji text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 8),
  created_at bigint NOT NULL,
  PRIMARY KEY (room_id, seq, agent_id, emoji),
  FOREIGN KEY (room_id, seq) REFERENCES room_messages(room_id, seq)
);
CREATE INDEX IF NOT EXISTS room_message_reactions_msg ON room_message_reactions(room_id, seq);
`,
};

/**
 * Migration 333 `room_thread_index`: the thread index on room_messages, our largest table. Like
 * migration 301 (purge-indexes-schema.ts) it is built here only on a small table (new, local,
 * test or preview databases); on production scripts/room-thread-index.ts --confirm builds it
 * CONCURRENTLY, so posts never wait on a SHARE lock. Thread reads work without it: they scan the
 * room's own rows by its primary key, bounded by messagesPerRoom (service.ts read).
 */
export const THREAD_INDEX_GUARD_ROWS = 10_000;
export const ROOM_THREAD_INDEXES: readonly ConcurrentIndex[] = [
  {
    name: 'room_messages_thread',
    table: 'room_messages',
    definition: 'ON room_messages (room_id, reply_to_seq, seq) WHERE reply_to_seq IS NOT NULL',
  },
];
export const roomThreadIndexMigration: Migration = {
  version: 333,
  name: 'room_thread_index',
  sql: guardedIndexSql(
    'migration 333',
    ROOM_THREAD_INDEXES,
    THREAD_INDEX_GUARD_ROWS,
    'scripts/room-thread-index.ts',
  ),
  report: {
    event: 'room_thread_index',
    measure: (tx) =>
      guardedIndexReport(
        (sql) => tx.query<Record<string, unknown>>(sql),
        ROOM_THREAD_INDEXES,
        THREAD_INDEX_GUARD_ROWS,
      ),
  },
};

/**
 * Migration 334 `room_message_actor`: the owner whose own action a system line reports
 * (system-lines.ts postSystemLine), so that owner's reads can mark the line `by_you` and compact
 * AI reads can shrink it like the caller's own posts. Additive only: one nullable column without a
 * default (no table rewrite, no scan); older lines stay null.
 */
export const roomMessageActorMigration: Migration = {
  version: 334,
  name: 'room_message_actor',
  sql: `
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS actor_owner_id text;
`,
};

/** Idempotent; call before runMigrations (after the rooms migrations). */
export function registerRoomMessageExtrasMigration(): void {
  registerMigration(roomMessageExtrasMigration);
  registerMigration(roomThreadIndexMigration);
  registerMigration(roomMessageActorMigration);
}
