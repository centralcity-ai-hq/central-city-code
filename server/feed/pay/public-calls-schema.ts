import { registerMigration, type Migration } from '../../migrations.js';
import { WALLET_CHAIN_ID } from '../../../shared/base/wallet-network.js';
import { x402PayerCooldownsMigration } from '../../protocol/x402/payer-cooldown.js';

/**
 * Migrations 353-356: the paid side of a Central City offer's public address, for buyers outside
 * Central City (server/feed/offers/public-pay.ts). Additive; unused while
 * CITY_X402_PUBLIC_OFFERS_SETTLE is not '1'.
 *
 * - 353 `feed_pay_public_calls`: one row per payment accepted at the address. `payer` is the outside
 *   buyer's address; `operator_id` and `agent_id` are the SELLER's (an outside buyer has neither).
 *   The legs (`seller_signature`, `fee_signature`, `valid_after`) are stored because the kind runs
 *   before the send and a crash in between is finished by the worker, which never sees the request.
 * - 354 `feed_pay_public_calls_explorer`: the Explorer's indexes, as migration 251.
 * - 355 `x402_facilitator_key_public_offer`: the provisioned key's purpose, as migration 352, whose
 *   three purposes it keeps.
 * - 356 `paid_call_count_public`: the count trigger and backfill, as migration 252; last in the
 *   batch for the same reason.
 *
 * Migration 357 `x402_payer_cooldowns` registers here too: it serves this address and the public
 * facilitator (server/protocol/x402/payer-cooldown.ts).
 */

/** The op key prefix of every public settlement; a CHECK of the table holds it to this. */
export const PUBLIC_CALL_KEY_PREFIX = 'x402pub:';

/**
 * Recognized by server/recovery.ts, never exported: Base is the record of every payment, and a
 * cool-down is an hour of operational state, like the limiter's counters.
 */
export const FEED_PAY_PUBLIC_TABLES = ['feed_pay_public_calls', 'x402_payer_cooldowns'] as const;

export const FEED_PAY_PUBLIC_CALLS_SQL = `
CREATE TABLE IF NOT EXISTS feed_pay_public_calls (
  call_id text PRIMARY KEY,
  payer text NOT NULL CHECK (payer = lower(payer)),
  ref text NOT NULL,
  input_hash text NOT NULL,
  client_key text NOT NULL,
  service_id text NOT NULL,
  offer_id text NOT NULL,
  offer_kind text NOT NULL,
  offer_version integer NOT NULL,
  operator_id text NOT NULL,
  agent_id text NOT NULL,
  pay_to text NOT NULL CHECK (pay_to = lower(pay_to)),
  gross_raw numeric(78,0) NOT NULL CHECK (gross_raw >= 50000 AND gross_raw <= 10000000),
  fee_raw numeric(78,0) NOT NULL,
  input text,
  state text NOT NULL CHECK (state IN ('reserved','ran','sent','paid','delivered','paid_no_result','failed','unmatched')),
  failure_code text,
  op_key text NOT NULL UNIQUE CHECK (op_key LIKE '${PUBLIC_CALL_KEY_PREFIX}%'),
  valid_after bigint NOT NULL,
  valid_before bigint NOT NULL,
  seller_signature text,
  fee_signature text,
  tx_hash text,
  block_number bigint,
  result_text text,
  result_mime text,
  result_format text,
  lease_until bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CONSTRAINT feed_pay_public_calls_fee_check CHECK (fee_raw > 0 AND fee_raw < gross_raw),
  UNIQUE (payer, ref)
);
CREATE UNIQUE INDEX IF NOT EXISTS feed_pay_public_calls_one_open
  ON feed_pay_public_calls (payer, offer_id, input_hash) WHERE state IN ('reserved','ran','sent');
CREATE INDEX IF NOT EXISTS feed_pay_public_calls_worker
  ON feed_pay_public_calls (state, lease_until) WHERE state IN ('reserved','ran','sent','paid');
CREATE INDEX IF NOT EXISTS feed_pay_public_calls_agent
  ON feed_pay_public_calls (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feed_pay_public_calls_sweep
  ON feed_pay_public_calls (updated_at)
  WHERE state IN ('delivered','paid_no_result','failed','unmatched')
    AND (input IS NOT NULL OR result_text IS NOT NULL OR seller_signature IS NOT NULL);`;

export const feedPayPublicCallsMigration: Migration = {
  version: 353,
  name: 'feed_pay_public_calls',
  sql: FEED_PAY_PUBLIC_CALLS_SQL,
};

/**
 * The indexes the Explorer's service calls view reads the paid public calls through, on the same
 * predicate it repeats (server/base/explorer/calls.ts PUBLIC_PAID), as migration 251 for the
 * sponsored ones. `_paid_payer` is theirs too: here the payer is a column, not one known address.
 * The table is new and empty, so building them takes no time.
 */
const PAID = `state IN ('paid','delivered','paid_no_result') AND tx_hash IS NOT NULL`;

export const FEED_PAY_PUBLIC_EXPLORER_SQL = `
CREATE INDEX IF NOT EXISTS feed_pay_public_calls_paid_time
  ON feed_pay_public_calls (updated_at) WHERE ${PAID};
CREATE INDEX IF NOT EXISTS feed_pay_public_calls_paid_tx
  ON feed_pay_public_calls (tx_hash) WHERE ${PAID};
CREATE INDEX IF NOT EXISTS feed_pay_public_calls_paid_block
  ON feed_pay_public_calls (block_number) WHERE ${PAID};
CREATE INDEX IF NOT EXISTS feed_pay_public_calls_paid_pay_to
  ON feed_pay_public_calls (pay_to, updated_at) WHERE ${PAID};
CREATE INDEX IF NOT EXISTS feed_pay_public_calls_paid_payer
  ON feed_pay_public_calls (payer, updated_at) WHERE ${PAID};
CREATE INDEX IF NOT EXISTS feed_pay_public_calls_paid_created
  ON feed_pay_public_calls (created_at) WHERE ${PAID};`;

export const feedPayPublicExplorerMigration: Migration = {
  version: 354,
  name: 'feed_pay_public_calls_explorer',
  sql: FEED_PAY_PUBLIC_EXPLORER_SQL,
};

/**
 * A fourth provisioned purpose: the public address's own sender (CITY_X402_PUBLIC_OFFER_KEY_REF). Only
 * the purpose CHECK changes; existing rows are untouched and not revalidated, as migration 352.
 */
export const X402_FACILITATOR_KEY_PUBLIC_OFFER_SQL = `
SET LOCAL lock_timeout = '2s';
ALTER TABLE x402_facilitator_key DROP CONSTRAINT IF EXISTS x402_facilitator_key_purpose_check;
ALTER TABLE x402_facilitator_key ADD CONSTRAINT x402_facilitator_key_purpose_check CHECK (purpose IN ('router3', 'public-settle', 'arc-router3', 'public-offer')) NOT VALID;
`;

export const x402FacilitatorKeyPublicOfferMigration: Migration = {
  version: 355,
  name: 'x402_facilitator_key_public_offer',
  sql: X402_FACILITATOR_KEY_PUBLIC_OFFER_SQL,
};

/**
 * Public calls count in `paid_call_count` like every other paid call, under migration 252's rules:
 * a row counts once, when it turns 'paid', 'delivered' or 'paid_no_result' with a `tx_hash` (never
 * 'unmatched'); value
 * `gross_raw`; `recent` the time it was recorded paid; deferred constraint triggers; the guarded
 * block with a 250 ms lock wait, so a busy counter skips the +1, never the save, and the daily check
 * (server/stats/paid-calls.ts) adds what was missed. No path moves a counted row out of the counted
 * states, so no -1 trigger. The backfill finds an empty table on first deploy; it stays for parity
 * and for a database restored with rows.
 */
const COUNTED = (row: 'NEW' | 'OLD') =>
  `${row}.state IN ('paid','delivered','paid_no_result') AND ${row}.tx_hash IS NOT NULL`;

export const PAID_CALL_COUNT_PUBLIC_CHAIN_ID = WALLET_CHAIN_ID;

export const PAID_CALL_COUNT_PUBLIC_SQL = `
CREATE OR REPLACE FUNCTION paid_call_count_public_bump() RETURNS trigger LANGUAGE plpgsql AS $$
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
    VALUES (${PAID_CALL_COUNT_PUBLIC_CHAIN_ID}, 1, ARRAY[t], n, v)
    ON CONFLICT (chain_id) DO UPDATE SET
      total = c.total + 1,
      recent = ARRAY(SELECT x FROM unnest(c.recent || t) AS x ORDER BY x DESC LIMIT 64),
      value_raw = c.value_raw + v,
      updated_at = n;
    PERFORM set_config('lock_timeout', lock_was, true);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- never blocks a public call's save; the daily check adds what was missed
  END;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS paid_call_count_public_bump ON feed_pay_public_calls;
CREATE CONSTRAINT TRIGGER paid_call_count_public_bump
  AFTER UPDATE OF state, tx_hash ON feed_pay_public_calls
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN ((${COUNTED('NEW')}) AND NOT (${COUNTED('OLD')}))
  EXECUTE FUNCTION paid_call_count_public_bump();

-- A row stored already counted counts once as well (no path does this today).
DROP TRIGGER IF EXISTS paid_call_count_public_insert ON feed_pay_public_calls;
CREATE CONSTRAINT TRIGGER paid_call_count_public_insert
  AFTER INSERT ON feed_pay_public_calls
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (${COUNTED('NEW')})
  EXECUTE FUNCTION paid_call_count_public_bump();

DO $$
BEGIN
  IF to_regclass('paid_call_count') IS NOT NULL THEN
    INSERT INTO paid_call_count AS c (chain_id, total, recent, updated_at, value_raw)
      SELECT ${PAID_CALL_COUNT_PUBLIC_CHAIN_ID}, count(*), '{}',
             (extract(epoch FROM clock_timestamp()) * 1000)::bigint, COALESCE(sum(s.gross_raw), 0)
        FROM feed_pay_public_calls s
       WHERE s.state IN ('paid','delivered','paid_no_result') AND s.tx_hash IS NOT NULL
      HAVING count(*) > 0
    ON CONFLICT (chain_id) DO UPDATE SET
      total = c.total + EXCLUDED.total,
      value_raw = c.value_raw + EXCLUDED.value_raw,
      updated_at = EXCLUDED.updated_at;
  END IF;
END $$;
`;

export const paidCallCountPublicMigration: Migration = {
  version: 356,
  name: 'paid_call_count_public',
  sql: PAID_CALL_COUNT_PUBLIC_SQL,
};

/** Idempotent; call before runMigrations (after 243, 252 and 352, and in this order). */
export function registerFeedPayPublicMigrations(): void {
  registerMigration(feedPayPublicCallsMigration);
  registerMigration(feedPayPublicExplorerMigration);
  registerMigration(x402FacilitatorKeyPublicOfferMigration);
  registerMigration(paidCallCountPublicMigration);
  registerMigration(x402PayerCooldownsMigration);
}
