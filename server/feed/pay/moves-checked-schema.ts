import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 241 `feed_pay_moves_checked`: the recovery cron settles pending float moves, and float
 * holds no move visits any more, least recently checked first (server/feed/pay/engine.ts
 * settleMoves, settleFloatHolds), as it already does for calls. One that keeps waiting on Base goes
 * to the back, so a backlog of 25 or more never blocks every newer one. One column each on
 * feed_pay_float_moves and base_wallet_reservations, with a default (no rewrite), and a partial
 * index over the rows each pass reads.
 *
 * - checked_at: when the cron last looked at the row (ms); 0 for every row so far. It is kept apart
 *   from updated_at, which the grace for a move or hold that never got an operation reads.
 */
export const FEED_PAY_MOVES_CHECKED_SQL = `
ALTER TABLE feed_pay_float_moves ADD COLUMN IF NOT EXISTS checked_at bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS feed_pay_float_moves_pending_checked
  ON feed_pay_float_moves (checked_at, updated_at) WHERE state = 'pending';
ALTER TABLE base_wallet_reservations ADD COLUMN IF NOT EXISTS checked_at bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS base_wallet_reservations_float_held_checked
  ON base_wallet_reservations (checked_at, updated_at) WHERE holder_kind = 'float' AND state = 'held';
`;

export const feedPayMovesCheckedMigration: Migration = {
  version: 241,
  name: 'feed_pay_moves_checked',
  sql: FEED_PAY_MOVES_CHECKED_SQL,
};

/** Idempotent; call before runMigrations (after 112, which creates feed_pay_float_moves). */
export function registerFeedPayMovesCheckedMigration(): void {
  registerMigration(feedPayMovesCheckedMigration);
}
