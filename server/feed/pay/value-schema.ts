import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 243 `paid_call_value` (docs/FEED_PAY.md section 14, "Paid service calls count"): the
 * total value settled next to the paid service calls count. One more column on `paid_call_count`,
 * `value_raw`: the USDC (base units) the buyers paid for every call counted in `total`, that is
 * `amount_raw + fee_raw` of each settled call (fee included: the seller's 90% plus the 10%; fee on
 * top: the price plus the fee). The homepage shows it as "Total value settled".
 *
 * It moves with `total`: the same two trigger functions (125's +1 and 128's -1) add or subtract
 * the call's value in the same statement, inside their guarded block. The money path rules are
 * the existing ones, unchanged: the update waits at most 250 ms (lock_timeout) for the counter
 * row, then skips; errors raised inside the guarded block (lock_not_available included) are caught
 * and the payment save commits. Known limitation, as in 125/128: a statement_timeout that fires
 * inside that block raises query_canceled, which WHEN OTHERS does not catch. It cannot fire while
 * the wait is bounded at 250 ms unless the enclosing statement_timeout is shorter than that. So the
 * update can slow a save by the bounded wait, and fails it only in that timeout case. The value
 * never goes below zero.
 *
 * Deploy: only CREATE OR REPLACE FUNCTION and a column with a default on the one-row-per-chain
 * table; no CREATE TRIGGER, so no ShareRowExclusive lock on `feed_pay_calls` (unlike 125 and
 * 128). The ALTER TABLE holds `paid_call_count` until the migration batch commits: settles and
 * drops meanwhile skip their counter update after the 250 ms wait (tested on real PostgreSQL).
 * The backfill is one sum over the settled calls (an AccessShare read of `feed_pay_calls`).
 * Payments that settle or drop while it runs can leave the value off in either direction until
 * the daily check (server/stats/paid-calls.ts) repairs it, as it does for `total`.
 */
export const PAID_CALL_VALUE_SQL = `
ALTER TABLE IF EXISTS paid_call_count
  ADD COLUMN IF NOT EXISTS value_raw numeric(78,0) NOT NULL DEFAULT 0 CHECK (value_raw >= 0);

CREATE OR REPLACE FUNCTION paid_call_count_bump() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
  t bigint;
  v numeric(78,0);
  lock_was text;
BEGIN
  BEGIN
    n := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    t := COALESCE(NEW.settled_at, n);
    v := GREATEST(0, COALESCE(NEW.amount_raw, 0) + COALESCE(NEW.fee_raw, 0));
    -- A lock wait ends as lock_not_available, which the handler below catches. A statement
    -- timeout would end as query_canceled, which WHEN OTHERS does not catch.
    lock_was := current_setting('lock_timeout');
    PERFORM set_config('lock_timeout', '250ms', true);
    INSERT INTO paid_call_count AS c (chain_id, total, recent, updated_at, value_raw)
    VALUES (NEW.chain_id, 1, ARRAY[t], n, v)
    ON CONFLICT (chain_id) DO UPDATE SET
      total = c.total + 1,
      recent = ARRAY(SELECT x FROM unnest(c.recent || t) AS x ORDER BY x DESC LIMIT 64),
      value_raw = c.value_raw + v,
      updated_at = n;
    PERFORM set_config('lock_timeout', lock_was, true);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- never blocks a payment; the daily check adds what was missed
  END;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION paid_call_count_drop() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
  v numeric(78,0);
  lock_was text;
BEGIN
  BEGIN
    n := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    v := GREATEST(0, COALESCE(OLD.amount_raw, 0) + COALESCE(OLD.fee_raw, 0));
    lock_was := current_setting('lock_timeout');
    PERFORM set_config('lock_timeout', '250ms', true);
    UPDATE paid_call_count AS c SET
      total = GREATEST(0, c.total - 1),
      -- One entry with the dropped payment's block time leaves the list (if it is still there).
      recent = COALESCE((
        SELECT array_agg(u.x ORDER BY u.i) FROM unnest(c.recent) WITH ORDINALITY AS u(x, i)
         WHERE u.i <> COALESCE((
           SELECT min(v2.j) FROM unnest(c.recent) WITH ORDINALITY AS v2(y, j)
            WHERE v2.y = OLD.settled_at), 0)
      ), '{}'),
      value_raw = GREATEST(0, c.value_raw - v),
      updated_at = n
    WHERE c.chain_id = OLD.chain_id;
    PERFORM set_config('lock_timeout', lock_was, true);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- never blocks a payment; the daily check repairs the total
  END;
  RETURN NULL;
END $$;

DO $$
BEGIN
  IF to_regclass('paid_call_count') IS NOT NULL THEN
    UPDATE paid_call_count AS c SET value_raw = s.v
      FROM (SELECT chain_id, COALESCE(sum(amount_raw + fee_raw), 0) AS v
              FROM feed_pay_calls WHERE payment_state = 'settled' GROUP BY chain_id) s
     WHERE c.chain_id = s.chain_id;
  END IF;
END $$;
`;

export const paidCallValueMigration: Migration = {
  version: 243,
  name: 'paid_call_value',
  sql: PAID_CALL_VALUE_SQL,
};

/** Idempotent; call before runMigrations (after 125 and 128, whose functions it replaces). */
export function registerPaidCallValueMigration(): void {
  registerMigration(paidCallValueMigration);
}
