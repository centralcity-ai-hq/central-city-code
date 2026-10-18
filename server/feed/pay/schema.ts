import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 112 `feed_pay` (Feed D6, "Use with my agent"; docs/FEED_PAY.md section 14): the whole
 * feature. (113 is the protocol fee ledger; Feed pay takes the next free number if it needs a second one.) New tables only, plus one constraint widened without a scan, so
 * nothing live is rewritten or locked for long at cold start:
 *
 * - `feed_pay_quotes`: the live price checks a person made (short-lived, deleted by the cron once
 *   expired). The quote id the browser holds is opaque; the row binds the person, the service, the
 *   inputs (hash) and the option the service asked for.
 * - `feed_pay_calls`: one row per paid call (Feed or MCP), its state machine, its payment
 *   (base_payments.payment_id, kind 'x402') and its result. `request_body` is what the person typed
 *   for the body, kept only until the paid request was sent; `result_text` is deleted after
 *   RESULT_KEEP_DAYS. `request_url` loses the typed query at the same moment as `request_body`.
 *   Idempotency: one key per scope (the person for the Feed, the workspace for MCP), stored as a
 *   hash. `checked_at` is when the recovery cron last looked at the call (it takes the least
 *   recently checked first, so a call that keeps waiting never blocks the others).
 * - `feed_pay_agent_settings`: per wallet, the owner's per-call maximum (null = the default; at
 *   most 0.10 USDC, the hard maximum of one Feed payment) and whether its spender account may
 *   hold a float ("Ready for services") until the next sweep. `sweep_checked_at` is when the cron
 *   last checked that float (least recently checked first, so no float is starved).
 * - `feed_pay_float_moves`: USDC moved between an agent's own two accounts (top-up: wallet to
 *   spender; sweep: back), each one chain operation.
 * - `base_wallet_reservations.holder_kind` gains 'float' (a top-up holds its amount on the agent
 *   wallet like a payment, but the calendar counter never counts it). The widened check is added
 *   NOT VALID: every existing row already satisfies it, so no scan runs under the table lock.
 * - `base_payments_x402_wallet`: a partial index the calendar counter reads service payments
 *   through (chain/calendar-limit.ts). No row has kind 'x402' before this feature, so it is empty;
 *   building it reads base_payments once (a small table) and changes no data.
 */
export const FEED_PAY_TABLES = [
  'feed_pay_quotes',
  'feed_pay_calls',
  'feed_pay_agent_settings',
  'feed_pay_float_moves',
] as const;

export const FEED_PAY_SQL = `
ALTER TABLE base_wallet_reservations DROP CONSTRAINT IF EXISTS base_wallet_reservations_holder_kind_check;
ALTER TABLE base_wallet_reservations ADD CONSTRAINT base_wallet_reservations_holder_kind_check
  CHECK (holder_kind IN ('payment','fleet_job','withdrawal','float')) NOT VALID;
CREATE TABLE IF NOT EXISTS feed_pay_quotes (
  quote_id text PRIMARY KEY CHECK (quote_id ~ '^fq_[A-Za-z0-9_-]+$'
    AND length(quote_id) BETWEEN 23 AND 403),
  account_id text NOT NULL,
  service_id text NOT NULL,
  inputs_hash text NOT NULL CHECK (inputs_hash ~ '^[0-9a-f]{64}$'),
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0),
  pay_to text NOT NULL CHECK (pay_to ~ '^0x[0-9a-fA-F]{40}$'),
  x402_version integer NOT NULL CHECK (x402_version IN (1, 2)),
  validity_s integer NOT NULL CHECK (validity_s > 0),
  quoted_at bigint NOT NULL,
  expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_pay_quotes_expiry ON feed_pay_quotes (expires_at);
CREATE TABLE IF NOT EXISTS feed_pay_calls (
  call_id text PRIMARY KEY CHECK (call_id ~ '^fc_[a-z2-7]{20}$'),
  origin text NOT NULL CHECK (origin IN ('feed','mcp')),
  scope text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  caller_id text NOT NULL,
  actor text NOT NULL,
  owner_account_id text NOT NULL,
  operator_id text NOT NULL,
  agent_id text NOT NULL,
  agent_name text NOT NULL,
  wallet_id text NOT NULL REFERENCES base_wallets(wallet_id) ON DELETE RESTRICT,
  chain_id integer NOT NULL,
  service_id text NOT NULL,
  service_title text NOT NULL,
  host text NOT NULL,
  method text NOT NULL,
  request_url text NOT NULL,
  request_body text,
  max_amount_raw numeric(78,0) NOT NULL CHECK (max_amount_raw > 0 AND max_amount_raw <= 100000),
  quote_id text,
  permission_id text NOT NULL,
  permission_hash text,
  payment_id text NOT NULL UNIQUE,
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0 AND amount_raw <= 100000),
  pay_to text NOT NULL CHECK (pay_to ~ '^0x[0-9a-fA-F]{40}$'),
  x402_version integer NOT NULL CHECK (x402_version IN (1, 2)),
  requirements jsonb NOT NULL,
  validity_s integer NOT NULL CHECK (validity_s > 0),
  state text NOT NULL CHECK (state IN ('reserved','float_topup','authorized','calling',
    'reconciling','settled','not_settled','result_saved','paid_no_result','cancelled','expired',
    'refused')),
  payment_state text CHECK (payment_state IS NULL OR payment_state IN ('signed','sent',
    'cancelling','settled','cancelled','expired')),
  failure_code text,
  valid_before bigint,
  nonce text CHECK (nonce IS NULL OR nonce ~ '^0x[0-9a-f]{64}$'),
  search_from_block bigint,
  claimed_tx text CHECK (claimed_tx IS NULL OR claimed_tx ~ '^0x[0-9a-f]{64}$'),
  tx_hash text CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  settled_block bigint,
  settled_at bigint,
  topup_move_id text,
  cancel_op_key text,
  response_status integer,
  result_status integer,
  result_content_type text,
  result_format text CHECK (result_format IS NULL OR result_format IN ('json','text','binary','empty')),
  result_text text,
  result_bytes integer,
  result_truncated boolean,
  result_received_at bigint,
  result_expires_at bigint,
  result_deleted_at bigint,
  lease_until bigint NOT NULL DEFAULT 0,
  lease_token text,
  checked_at bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (scope, idempotency_key)
);
CREATE INDEX IF NOT EXISTS feed_pay_calls_owner ON feed_pay_calls (owner_account_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS feed_pay_calls_quote_once ON feed_pay_calls (quote_id)
  WHERE quote_id IS NOT NULL AND state NOT IN ('cancelled','refused','expired');
CREATE INDEX IF NOT EXISTS feed_pay_calls_wallet ON feed_pay_calls (wallet_id, created_at);
CREATE INDEX IF NOT EXISTS feed_pay_calls_open ON feed_pay_calls (checked_at, updated_at)
  WHERE state NOT IN ('result_saved','paid_no_result','cancelled','expired','refused')
    OR payment_state IN ('signed','sent','cancelling');
CREATE INDEX IF NOT EXISTS feed_pay_calls_live ON feed_pay_calls (wallet_id)
  WHERE state IN ('reserved','float_topup','authorized','calling','reconciling','settled',
    'not_settled') OR payment_state IN ('signed','sent','cancelling');
CREATE INDEX IF NOT EXISTS feed_pay_calls_results ON feed_pay_calls (result_expires_at)
  WHERE result_text IS NOT NULL;
CREATE TABLE IF NOT EXISTS feed_pay_agent_settings (
  wallet_id text PRIMARY KEY REFERENCES base_wallets(wallet_id) ON DELETE RESTRICT,
  per_call_max_raw numeric(78,0) CHECK (per_call_max_raw IS NULL
    OR (per_call_max_raw >= 1 AND per_call_max_raw <= 100000)),
  changed_by text,
  changed_at bigint,
  float_open boolean NOT NULL DEFAULT false,
  float_period_end bigint,
  float_permission_id text,
  sweep_checked_at bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_pay_agent_settings_float ON feed_pay_agent_settings
  (sweep_checked_at, wallet_id) WHERE float_open;
CREATE TABLE IF NOT EXISTS feed_pay_float_moves (
  move_id text PRIMARY KEY,
  wallet_id text NOT NULL REFERENCES base_wallets(wallet_id) ON DELETE RESTRICT,
  chain_id integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('top_up','sweep')),
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0),
  op_key text NOT NULL UNIQUE,
  intent_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','final','failed')),
  call_id text,
  reason text,
  period_end bigint,
  tx_hash text CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_pay_float_moves_wallet ON feed_pay_float_moves (wallet_id, created_at);
CREATE INDEX IF NOT EXISTS feed_pay_float_moves_pending ON feed_pay_float_moves (updated_at)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS base_payments_x402_wallet ON base_payments (payer_wallet_id, created_at)
  WHERE kind = 'x402';
`;

export const feedPayMigration: Migration = {
  version: 112,
  name: 'feed_pay',
  sql: FEED_PAY_SQL,
};

/** Idempotent; call before runMigrations. */
export function registerFeedPayMigration(): void {
  registerMigration(feedPayMigration);
}
