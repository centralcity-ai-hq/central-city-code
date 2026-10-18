import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 128 `paid_call_count_drop` (docs/FEED_PAY.md section 14, "Paid service calls count"):
 * the -1 that pairs with migration 125's +1. A settled payment that a reorg drops (the engine's
 * payDropped moves `payment_state` from 'settled' to 'cancelled') no longer counts, so the public
 * `paid_calls` total goes down by one at that commit instead of staying one too high until the
 * daily check (server/stats/paid-calls.ts). Its block time leaves `recent` as well (one entry).
 *
 * The same money-path rules as 125 (count-schema.ts): a deferred constraint trigger, everything in
 * one guarded block with a 250 ms `lock_timeout`, never below zero. Any error there skips the -1
 * and the payment save commits; the daily check repairs the total either way. A call that settles
 * again later passes 125's trigger once more, so it is counted once again.
 *
 * Deploy: CREATE TRIGGER takes the same ShareRowExclusiveLock on `feed_pay_calls` as 125, held
 * until the whole batch commits, so this migration ships alone or last in its batch too. No
 * backfill and no index.
 */
export const PAID_CALL_COUNT_DROP_SQL = `
CREATE OR REPLACE FUNCTION paid_call_count_drop() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
  lock_was text;
BEGIN
  BEGIN
    n := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    lock_was := current_setting('lock_timeout');
    PERFORM set_config('lock_timeout', '250ms', true);
    UPDATE paid_call_count AS c SET
      total = GREATEST(0, c.total - 1),
      -- One entry with the dropped payment's block time leaves the list (if it is still there).
      recent = COALESCE((
        SELECT array_agg(u.x ORDER BY u.i) FROM unnest(c.recent) WITH ORDINALITY AS u(x, i)
         WHERE u.i <> COALESCE((
           SELECT min(v.j) FROM unnest(c.recent) WITH ORDINALITY AS v(y, j)
            WHERE v.y = OLD.settled_at), 0)
      ), '{}'),
      updated_at = n
    WHERE c.chain_id = OLD.chain_id;
    PERFORM set_config('lock_timeout', lock_was, true);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- never blocks a payment; the daily check repairs the total
  END;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS paid_call_count_drop ON feed_pay_calls;
CREATE CONSTRAINT TRIGGER paid_call_count_drop
  AFTER UPDATE OF payment_state ON feed_pay_calls
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.payment_state = 'settled' AND NEW.payment_state IS DISTINCT FROM 'settled')
  EXECUTE FUNCTION paid_call_count_drop();
`;

export const paidCallCountDropMigration: Migration = {
  version: 128,
  name: 'paid_call_count_drop',
  sql: PAID_CALL_COUNT_DROP_SQL,
};

/** Idempotent; call before runMigrations (after 125, whose table it updates). */
export function registerPaidCallCountDropMigration(): void {
  registerMigration(paidCallCountDropMigration);
}
