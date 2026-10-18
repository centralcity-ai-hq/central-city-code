import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 125 `paid_call_count` (docs/FEED_PAY.md section 14, "Paid service calls count"): the
 * number of paid service calls, one row per chain, kept by a trigger on `feed_pay_calls`. The
 * public field `paid_calls` of GET /api/public/stats reads the Base mainnet row (8453) only.
 *
 * What counts: a call whose payment Base shows used, `payment_state = 'settled'`. Every payer
 * counts the same; a call paid with no answer (`paid_no_result`) has a settled payment, so it
 * counts. One call is one count: the protocol fee leg has its own columns (`fee_state`) and never
 * writes `payment_state`. Every paid path must reach `payment_state = 'settled'` on its
 * `feed_pay_calls` row to be counted (a future path that records a payment elsewhere is not
 * counted until it does).
 *
 * The money path comes first. `feed_pay_calls` holds payments, so the trigger can never block,
 * slow or fail a payment save:
 * - It is a deferred constraint trigger: it runs once, at the commit of the transaction that
 *   settled the call (the engine's compare-and-set), so a rollback takes its +1 with it and the
 *   counter row is locked only for the commit itself.
 * - Everything it does sits in one guarded block (`EXCEPTION WHEN OTHERS`): any error there skips
 *   the +1 and the payment commits. The daily check (server/stats/paid-calls.ts) adds what was
 *   skipped. It can only skip a +1, never add one.
 * - Inside the block, `lock_timeout` is 250 ms (restored afterwards): a wait for the counter row
 *   ends as `lock_not_available`, which the guard catches. Without it, a long wait could reach the
 *   statement timeout, whose `query_canceled` the guard cannot catch, and fail the payment save.
 * - No index changes on `feed_pay_calls`.
 *
 * `recent` holds the Base block times (ms, `settled_at`) of the latest 64 payments, newest first,
 * so the homepage can show each payment at its own moment. A payment without a block time (never
 * the case today) is stamped with the database clock.
 *
 * The starting count is exact: migrations run in one transaction, and CREATE TRIGGER takes a lock
 * (ShareRowExclusiveLock on `feed_pay_calls`) that waits for payment updates in progress and holds
 * new ones until the migration commits, so the backfill sees every settled row once.
 *
 * Deploy: runMigrations applies every pending migration in ONE transaction, so that lock is held
 * until the whole batch commits, not only this migration. Payment saves wait meanwhile and fail
 * with 55P03 after the session's 5 s lock_timeout (the engine retries them; the payment itself is
 * already on Base). So this migration ships alone or last in its batch: never together with a
 * heavier, higher-numbered migration. Its number is re-checked at merge (other open changes take
 * numbers too), and this rule with it.
 *
 * Derived data: backups skip the table (server/recovery.ts). After a restore the count is hidden
 * or low until the daily check, never too high.
 */
export const PAID_CALL_COUNT_TABLE = 'paid_call_count';

export const PAID_CALL_COUNT_SQL = `
CREATE TABLE IF NOT EXISTS paid_call_count (
  chain_id   integer PRIMARY KEY,
  total      bigint   NOT NULL CHECK (total >= 0),
  recent     bigint[] NOT NULL DEFAULT '{}' CHECK (cardinality(recent) <= 64),
  updated_at bigint   NOT NULL
);

CREATE OR REPLACE FUNCTION paid_call_count_bump() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
  t bigint;
  lock_was text;
BEGIN
  BEGIN
    n := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    t := COALESCE(NEW.settled_at, n);
    -- A lock wait ends as lock_not_available, which the handler below catches. A statement
    -- timeout would end as query_canceled, which WHEN OTHERS does not catch.
    lock_was := current_setting('lock_timeout');
    PERFORM set_config('lock_timeout', '250ms', true);
    INSERT INTO paid_call_count AS c (chain_id, total, recent, updated_at)
    VALUES (NEW.chain_id, 1, ARRAY[t], n)
    ON CONFLICT (chain_id) DO UPDATE SET
      total = c.total + 1,
      recent = ARRAY(SELECT x FROM unnest(c.recent || t) AS x ORDER BY x DESC LIMIT 64),
      updated_at = n;
    -- Back to the transaction's own limit for anything that runs after this at commit (an error
    -- above rolls the block back, which restores it as well).
    PERFORM set_config('lock_timeout', lock_was, true);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- never blocks a payment; the daily check adds what was missed
  END;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS paid_call_count_bump ON feed_pay_calls;
CREATE CONSTRAINT TRIGGER paid_call_count_bump
  AFTER UPDATE OF payment_state ON feed_pay_calls
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.payment_state = 'settled' AND OLD.payment_state IS DISTINCT FROM 'settled')
  EXECUTE FUNCTION paid_call_count_bump();

-- A row stored already settled counts once as well (no path does this today).
DROP TRIGGER IF EXISTS paid_call_count_insert ON feed_pay_calls;
CREATE CONSTRAINT TRIGGER paid_call_count_insert
  AFTER INSERT ON feed_pay_calls
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.payment_state = 'settled')
  EXECUTE FUNCTION paid_call_count_bump();

INSERT INTO paid_call_count (chain_id, total, recent, updated_at)
  SELECT chain_id, count(*), '{}', (extract(epoch FROM clock_timestamp()) * 1000)::bigint
  FROM feed_pay_calls WHERE payment_state = 'settled' GROUP BY chain_id
ON CONFLICT (chain_id) DO NOTHING;
`;

export const paidCallCountMigration: Migration = {
  version: 125,
  name: 'paid_call_count',
  sql: PAID_CALL_COUNT_SQL,
};

/** Idempotent; call before runMigrations (after Feed pay's 112, whose table it reads). */
export function registerPaidCallCountMigration(): void {
  registerMigration(paidCallCountMigration);
}
