import { registerMigration, type Migration } from '../migrations.js';
import { guardedIndexReport, guardedIndexSql, type ConcurrentIndex } from '../concurrent-index.js';

/**
 * Migration 304 `reservation_audit_lookup_indexes` (MPR1-01): indexes for reads that run under the
 * wallet row lock or on every agent payment, and that had no index starting with what they filter:
 *
 *   base_wallet_reservations_wallet_token_created
 *     base_wallet_reservations (wallet_id, lower(token), created_at). unavailableAmount
 *     (chain/reservations.ts), calendarSpent and periodAllowanceInFlight (chain/calendar-limit.ts)
 *     each sum one wallet's reservations of one token, consumed ones included, filtered by
 *     `wallet_id = $1 AND lower(token) = $2` (and a created_at range for the two limit counters).
 *     The only index starting with wallet_id is partial (state = 'held'), so the planner walked
 *     the (holder_kind, holder_ref, wallet_id, token) unique index across every wallet. The token
 *     is indexed as lower(token), the form every one of these reads compares, so the index applies
 *     to the statements as they are and to every stored row whatever its case.
 *   base_audit_events_payment
 *     base_audit_events (operator_id, kind, (detail->>'paymentId')), partial on events that name
 *     a payment. The agent-pay audit marker (AGENT_PAY_AUDIT_ONCE_SQL: one event of a kind per
 *     payment) and the stored payment read (AGENT_PAY_STORED_SQL) look an event up by those three;
 *     the table was only indexed by (operator_id, at), so each read every event of the workspace.
 *     Both compare detail->>'paymentId' with `=`, which implies it is not null, so the partial
 *     index applies to them.
 * No data changes; the statements are unchanged, so their results are too.
 *
 * Built CONCURRENTLY by the owner on production, never by this migration on a large table, exactly
 * as migration 301 (server/rooms/purge-indexes-schema.ts): a missing index is built here only on a
 * table of at most GUARD_ROWS rows; on a larger table it is left with a NOTICE for
 * scripts/lookup-indexes.ts --confirm (before or after this deploy), and an invalid one is left for
 * the script, which rebuilds it. It never fails. The report line `reservation_audit_lookup_indexes`
 * counts what it found.
 */
export const GUARD_ROWS = 10_000;

export const RESERVATION_AUDIT_INDEXES: readonly ConcurrentIndex[] = [
  {
    name: 'base_wallet_reservations_wallet_token_created',
    table: 'base_wallet_reservations',
    definition: 'ON base_wallet_reservations (wallet_id, lower(token), created_at)',
  },
  {
    name: 'base_audit_events_payment',
    table: 'base_audit_events',
    definition:
      "ON base_audit_events (operator_id, kind, (detail->>'paymentId')) WHERE (detail->>'paymentId') IS NOT NULL",
  },
];

export const RESERVATION_AUDIT_INDEXES_SQL = guardedIndexSql(
  'migration 304',
  RESERVATION_AUDIT_INDEXES,
  GUARD_ROWS,
  'scripts/lookup-indexes.ts',
);

export const reservationAuditIndexesMigration: Migration = {
  version: 304,
  name: 'reservation_audit_lookup_indexes',
  sql: RESERVATION_AUDIT_INDEXES_SQL,
  report: {
    event: 'reservation_audit_lookup_indexes',
    measure: (tx) =>
      guardedIndexReport(
        (sql) => tx.query<Record<string, unknown>>(sql),
        RESERVATION_AUDIT_INDEXES,
        GUARD_ROWS,
      ),
  },
};

/** Idempotent; call before runMigrations (after the Base wallet and payment migrations). */
export function registerReservationAuditIndexesMigration(): void {
  registerMigration(reservationAuditIndexesMigration);
}
