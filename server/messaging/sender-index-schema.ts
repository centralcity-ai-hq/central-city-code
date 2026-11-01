import { registerMigration, type Migration } from '../migrations.js';
import { guardedIndexReport, guardedIndexSql, type ConcurrentIndex } from '../concurrent-index.js';

/**
 * Migration 305 `messages_sender_owner_context` (R1-6): messages (sender_owner_id, context_id,
 * created_at), the sent-side twin of messages_owner_context (recipient_owner_id, context_id,
 * created_at). The conversation list (service.ts conversations(), until the summaries are
 * backfilled) walks it like the received side: one index probe per distinct thread the owner sent
 * into, plus one per thread for its newest send. Without it the list could only afford the
 * owner's newest sent rows, so a thread the owner only sent into, older than those rows, was left
 * out. No data changes.
 *
 * Built CONCURRENTLY by the owner on production, never by this migration on a large table, exactly
 * as migrations 301 and 304: built here only while messages has at most GUARD_ROWS rows; otherwise
 * left with a NOTICE for scripts/lookup-indexes.ts --confirm (before or after this deploy); an
 * invalid one is left for the script, which rebuilds it. It never fails. Until the index is valid
 * the list finds the sent threads with one grouped read of the owner's sent rows (correct, cost
 * linear in what the owner sent) instead of the walk. The report line
 * `messages_sender_owner_context` counts what it found.
 */
export const GUARD_ROWS = 10_000;

export const SENDER_CONTEXT_INDEX = 'messages_sender_owner_context';

export const MESSAGE_SENDER_INDEXES: readonly ConcurrentIndex[] = [
  {
    name: SENDER_CONTEXT_INDEX,
    table: 'messages',
    definition: 'ON messages (sender_owner_id, context_id, created_at)',
  },
];

export const MESSAGE_SENDER_INDEXES_SQL = guardedIndexSql(
  'migration 305',
  MESSAGE_SENDER_INDEXES,
  GUARD_ROWS,
  'scripts/lookup-indexes.ts',
);

export const messageSenderIndexMigration: Migration = {
  version: 305,
  name: 'messages_sender_owner_context',
  sql: MESSAGE_SENDER_INDEXES_SQL,
  report: {
    event: 'messages_sender_owner_context',
    measure: (tx) =>
      guardedIndexReport(
        (sql) => tx.query<Record<string, unknown>>(sql),
        MESSAGE_SENDER_INDEXES,
        GUARD_ROWS,
      ),
  },
};

/** Idempotent; call before runMigrations (after the messaging migrations). */
export function registerMessageSenderIndexMigration(): void {
  registerMigration(messageSenderIndexMigration);
}
