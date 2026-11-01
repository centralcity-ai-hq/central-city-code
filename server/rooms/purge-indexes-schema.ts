import { registerMigration, type Migration } from '../migrations.js';
import { guardedIndexReport, guardedIndexSql, type ConcurrentIndex } from '../concurrent-index.js';

/**
 * Migration 301 `room_purge_indexes` (CCA-517): the indexes a room delete (rooms/service.ts) and
 * the hard purge of private rooms (elric/erase.ts purgeRooms, rooms/mention-purge.ts) need. Each
 * deletes by room_id from these tables, and none had an index that starts with room_id, so every
 * delete read the whole table:
 *   mentions_room            mentions (room_id), partial: direct-message mentions have no room
 *   room_task_comments_room  room_task_comments (room_id)
 *   room_join_receipts_room  room_join_receipts (room_id)
 *   elric_catch_ups_room     elric_catch_ups (room_id)
 * No data changes.
 *
 * Built CONCURRENTLY by the owner on production, never by this migration on a large table: every
 * migration runs inside a transaction, where CREATE INDEX CONCURRENTLY is not allowed, and a plain
 * build holds a SHARE lock on the table (inserts, updates and deletes wait) for the whole build.
 * So, per index whose table exists and which is missing:
 *   - table with at most GUARD_ROWS rows (a new, local, test or preview database): built here,
 *     a plain CREATE INDEX that takes milliseconds;
 *   - larger table: left alone with a NOTICE; scripts/room-purge-indexes.ts --confirm builds it
 *     CONCURRENTLY on a direct connection, before or after this deploy;
 *   - present but invalid (a failed concurrent build): left for the script, which rebuilds it.
 * It never fails, so a deploy never waits for the script: until the script runs, deletes cost
 * what they cost before. The report line `room_purge_indexes` counts what it found.
 */
export const GUARD_ROWS = 10_000;

export const ROOM_PURGE_INDEXES: readonly ConcurrentIndex[] = [
  {
    name: 'mentions_room',
    table: 'mentions',
    definition: 'ON mentions (room_id) WHERE room_id IS NOT NULL',
  },
  {
    name: 'room_task_comments_room',
    table: 'room_task_comments',
    definition: 'ON room_task_comments (room_id)',
  },
  {
    name: 'room_join_receipts_room',
    table: 'room_join_receipts',
    definition: 'ON room_join_receipts (room_id)',
  },
  {
    name: 'elric_catch_ups_room',
    table: 'elric_catch_ups',
    definition: 'ON elric_catch_ups (room_id)',
  },
];

export const ROOM_PURGE_INDEXES_SQL = guardedIndexSql(
  'migration 301',
  ROOM_PURGE_INDEXES,
  GUARD_ROWS,
  'scripts/room-purge-indexes.ts',
);

export const roomPurgeIndexesMigration: Migration = {
  version: 301,
  name: 'room_purge_indexes',
  sql: ROOM_PURGE_INDEXES_SQL,
  report: {
    event: 'room_purge_indexes',
    measure: (tx) =>
      guardedIndexReport(
        (sql) => tx.query<Record<string, unknown>>(sql),
        ROOM_PURGE_INDEXES,
        GUARD_ROWS,
      ),
  },
};

/** Idempotent; call before runMigrations (after the rooms, tasks, wake and Elric migrations). */
export function registerRoomPurgeIndexesMigration(): void {
  registerMigration(roomPurgeIndexesMigration);
}
