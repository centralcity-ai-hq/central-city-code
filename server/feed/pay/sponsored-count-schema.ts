import { registerMigration, type Migration } from '../../migrations.js';
import { WALLET_CHAIN_ID } from '../../../shared/base/wallet-network.js';

/**
 * Migration 252 `paid_call_count_sponsored` (docs/FEED_PAY.md section 14, "Paid service calls
 * count"): sponsored first purchases (server/feed/pay/sponsored.ts, table
 * `feed_pay_sponsored_calls`) count in `paid_call_count` like every other paid call, so the public
 * stats (homepage: paid service calls, total value settled, the per-minute rate from `recent`) and
 * the Explorer read the same Total. Nothing in any answer tells them apart.
 *
 * What counts, exactly the Explorer's rule (server/base/explorer/calls.ts SPONSORED_PAID): a row
 * whose state is 'paid', 'delivered' or 'paid_no_result' with a `tx_hash`. Each counts once: the
 * +1 fires only when a row turns counted (it was not before), so 'paid' then 'delivered' adds 1,
 * not 2. They are paid on the wallet network (WALLET_CHAIN_ID, Base mainnet, the public row
 * PAID_CALLS_CHAIN_ID), so they land in that chain's row. Value: what the payer paid, fee
 * included, `gross_raw` (the seller's share plus the fee in the same transaction), the same as
 * `amount_raw + fee_raw` of a fee-included call in migration 243. `recent`: the time the call was
 * recorded paid (`updated_at`; the table keeps no block time; the Explorer lists it by that time).
 *
 * No path moves a counted row out of the counted states (paid only goes on to delivered or
 * paid_no_result, failed is reached only from reserved or sent, and rows are stored 'reserved'),
 * so there is no -1 trigger. The daily check (server/stats/paid-calls.ts) recounts both tables
 * and repairs the total and the value either way.
 *
 * The money path rules of 125/128/243 (count-schema.ts), unchanged: deferred constraint triggers
 * (they run at the commit of the save, so a rollback takes the +1 with it); everything inside one
 * guarded block (EXCEPTION WHEN OTHERS) with a 250 ms `lock_timeout` for the counter row, restored
 * afterwards, so a busy or broken counter skips the +1 and the sponsored save commits. Known
 * limitation, as there: a statement_timeout shorter than 250 ms firing inside the block raises
 * query_canceled, which WHEN OTHERS does not catch. No index changes on any table.
 *
 * Deploy: CREATE TRIGGER takes a ShareRowExclusiveLock on `feed_pay_sponsored_calls` (not on
 * `feed_pay_calls`, whose triggers are untouched). It waits for sponsored saves in progress and
 * holds new ones (reads go on) until the migration batch commits. That is what makes the backfill
 * exact: every row turned counted before the lock is in the sum, every later one passes the
 * trigger. A sponsored save that waits past its session lock_timeout fails with 55P03 and its
 * worker step runs again on the next pass (compare-and-set on the row, lease); the payment itself
 * is already on Base, so it is counted then. The backfill then updates the counter row, which
 * makes `feed_pay_calls` settles skip their +1 after 250 ms until the batch commits (as in 243);
 * the daily check adds those back. So this migration ships alone or last in its batch.
 *
 * Backfill: one count and one sum over the counted sponsored rows (through migration 251's partial
 * indexes), added to the chain's row (created when missing). `recent` is left as it is.
 */
const COUNTED = (row: 'NEW' | 'OLD') =>
  `${row}.state IN ('paid','delivered','paid_no_result') AND ${row}.tx_hash IS NOT NULL`;

export const PAID_CALL_COUNT_SPONSORED_CHAIN_ID = WALLET_CHAIN_ID;

export const PAID_CALL_COUNT_SPONSORED_SQL = `
CREATE OR REPLACE FUNCTION paid_call_count_sponsored_bump() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
  t bigint;
  v numeric(78,0);
  lock_was text;
BEGIN
  BEGIN
    n := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    t := COALESCE(NEW.updated_at, n);
    v := GREATEST(0, COALESCE(NEW.gross_raw, 0));
    -- A lock wait ends as lock_not_available, which the handler below catches. A statement
    -- timeout would end as query_canceled, which WHEN OTHERS does not catch.
    lock_was := current_setting('lock_timeout');
    PERFORM set_config('lock_timeout', '250ms', true);
    INSERT INTO paid_call_count AS c (chain_id, total, recent, updated_at, value_raw)
    VALUES (${PAID_CALL_COUNT_SPONSORED_CHAIN_ID}, 1, ARRAY[t], n, v)
    ON CONFLICT (chain_id) DO UPDATE SET
      total = c.total + 1,
      recent = ARRAY(SELECT x FROM unnest(c.recent || t) AS x ORDER BY x DESC LIMIT 64),
      value_raw = c.value_raw + v,
      updated_at = n;
    PERFORM set_config('lock_timeout', lock_was, true);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- never blocks a sponsored save; the daily check adds what was missed
  END;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS paid_call_count_sponsored_bump ON feed_pay_sponsored_calls;
CREATE CONSTRAINT TRIGGER paid_call_count_sponsored_bump
  AFTER UPDATE OF state, tx_hash ON feed_pay_sponsored_calls
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN ((${COUNTED('NEW')}) AND NOT (${COUNTED('OLD')}))
  EXECUTE FUNCTION paid_call_count_sponsored_bump();

-- A row stored already counted counts once as well (no path does this today).
DROP TRIGGER IF EXISTS paid_call_count_sponsored_insert ON feed_pay_sponsored_calls;
CREATE CONSTRAINT TRIGGER paid_call_count_sponsored_insert
  AFTER INSERT ON feed_pay_sponsored_calls
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (${COUNTED('NEW')})
  EXECUTE FUNCTION paid_call_count_sponsored_bump();

DO $$
BEGIN
  IF to_regclass('paid_call_count') IS NOT NULL THEN
    INSERT INTO paid_call_count AS c (chain_id, total, recent, updated_at, value_raw)
      SELECT ${PAID_CALL_COUNT_SPONSORED_CHAIN_ID}, count(*), '{}',
             (extract(epoch FROM clock_timestamp()) * 1000)::bigint, COALESCE(sum(s.gross_raw), 0)
        FROM feed_pay_sponsored_calls s
       WHERE s.state IN ('paid','delivered','paid_no_result') AND s.tx_hash IS NOT NULL
      HAVING count(*) > 0
    ON CONFLICT (chain_id) DO UPDATE SET
      total = c.total + EXCLUDED.total,
      value_raw = c.value_raw + EXCLUDED.value_raw,
      updated_at = EXCLUDED.updated_at;
  END IF;
END $$;
`;

export const paidCallCountSponsoredMigration: Migration = {
  version: 252,
  name: 'paid_call_count_sponsored',
  sql: PAID_CALL_COUNT_SPONSORED_SQL,
};

/** Idempotent; call before runMigrations (after 243, whose column it fills, and 250/251). */
export function registerPaidCallCountSponsoredMigration(): void {
  registerMigration(paidCallCountSponsoredMigration);
}
