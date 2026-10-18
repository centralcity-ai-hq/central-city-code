import { registerMigration, type Migration } from '../migrations.js';
import { receiveMigration, receiveReconcileMigration } from './payments/receive-store.js';

/**
 * Migration 78 (docs/base/ARCHITECTURE.md §5 and §11): Base agent wallets, phase 1.
 * - `base_wallets`: one counterfactual smart-account wallet per agent and chain.
 * - `base_owner_vaults`: the owner key encrypted in the browser; the server cannot decrypt it.
 * - `base_spend_permissions`: owner-signed permissions, stored off-chain until the first spend.
 * - `base_identities`: ERC-8004 registrations.
 * - `base_chain_ops`: every chain operation, written before broadcast (idempotent, reconcilable).
 * - `base_audit_events`: append-only; never carries keys, signatures or passwords.
 * Fleet and payment tables come in their own migrations with those modules.
 */
export const BASE_TABLES = [
  'base_wallets',
  'base_owner_vaults',
  'base_spend_permissions',
  'base_identities',
  'base_chain_ops',
  'base_audit_events',
  'base_spender_keys',
  'base_wallet_reservations',
  'base_payments',
  'base_x402_receipts',
  'base_short_ids',
  'base_fleet_jobs',
  'base_fleet_token_budgets',
  'base_fleet_fee_budgets',
  'base_fleet_batches',
  'base_fleet_batch_allocations',
  'base_fleet_items',
  'base_x402_authorizations',
  'base_master_workspaces',
  'base_vault_challenges',
  'base_wallet_withdrawals',
  'base_wallet_payments',
  'base_pay_lookups',
  'base_agent_pay_consents',
  'base_rate_lookups',
  'base_cron_cursors',
  // The sponsor's gas in flight (migration 97): operational, recognized, never exported.
  'base_sponsor_exposure',
  // The rated agents (migration 121): derived from the ratings and their operations, never exported.
  'base_rated_agents',
] as const;

export const BASE_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS base_owner_vaults (
  operator_id text PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,
  owner_address text NOT NULL CHECK (owner_address ~ '^0x[0-9a-fA-F]{40}$'),
  encrypted_owner_key bytea NOT NULL,
  kdf_params jsonb NOT NULL,
  created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS base_wallets (
  wallet_id text PRIMARY KEY,
  agent_id text NOT NULL,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  chain_id integer NOT NULL CHECK (chain_id IN (84532, 8453, 31337)),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  owner_address text NOT NULL CHECK (owner_address ~ '^0x[0-9a-fA-F]{40}$'),
  spender_address text NOT NULL CHECK (spender_address ~ '^0x[0-9a-fA-F]{40}$'),
  spender_key_ref text NOT NULL CHECK (spender_key_ref ~ '^v[0-9]+:'),
  -- The complete, versioned CREATE2 recipe (ordered owners incl. SpendPermissionManager, factory,
  -- implementation version, account index), so a retry never uses an older address recipe.
  derivation jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('derived','deployed','frozen','closed')),
  provisioned_by_owner_fleet boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (agent_id, chain_id),
  UNIQUE (chain_id, address)
);
CREATE INDEX IF NOT EXISTS base_wallets_operator ON base_wallets(operator_id, chain_id);
CREATE TABLE IF NOT EXISTS base_spend_permissions (
  permission_id text PRIMARY KEY,
  wallet_id text NOT NULL REFERENCES base_wallets(wallet_id) ON DELETE CASCADE,
  chain_id integer NOT NULL,
  permission jsonb NOT NULL,
  signature bytea NOT NULL,
  state text NOT NULL CHECK (state IN ('signed','onchain','revoked')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS base_spend_permissions_wallet ON base_spend_permissions(wallet_id, state);
CREATE TABLE IF NOT EXISTS base_identities (
  agent_id text NOT NULL,
  chain_id integer NOT NULL,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  registry_address text NOT NULL,
  erc8004_agent_id numeric,
  agent_card_uri text NOT NULL,
  owner_of_identity text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','submitted','confirmed','failed')),
  op_id text,
  tx_hash text,
  updated_at bigint NOT NULL,
  PRIMARY KEY (agent_id, chain_id)
);
CREATE TABLE IF NOT EXISTS base_chain_ops (
  op_id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  intent_hash text NOT NULL,
  operator_id text,
  kind text NOT NULL CHECK (kind IN ('userop','batch','transfer','register','approve','pull','settle','cancel_authorization','sweep')),
  chain_id integer NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','submitted','included','final','unknown','reconciling','reorged','failed')),
  -- Stored before broadcast (§11.3): the exact signed operation, its signer and nonce, the locally
  -- computed hash, and the fenced submission owner. Recovery rebroadcasts this, never a new one.
  signed_operation bytea,
  signer_address text,
  nonce numeric,
  operation_hash text,
  lease_owner text,
  lease_until bigint,
  fencing_token bigint NOT NULL DEFAULT 0,
  user_op_hash text,
  tx_hash text,
  block_number bigint,
  gas_used numeric,
  fee_wei numeric,
  error_code text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS base_chain_ops_open ON base_chain_ops(chain_id, status)
  WHERE status IN ('queued','submitted','included','unknown','reconciling');
CREATE TABLE IF NOT EXISTS base_audit_events (
  event_id bigserial PRIMARY KEY,
  at bigint NOT NULL,
  actor text NOT NULL,
  operator_id text,
  agent_id text,
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS base_audit_events_operator ON base_audit_events(operator_id, at);
CREATE OR REPLACE FUNCTION base_audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'base_audit_events is append-only';
END;
$$;
DROP TRIGGER IF EXISTS base_audit_events_append_only ON base_audit_events;
CREATE TRIGGER base_audit_events_append_only BEFORE UPDATE OR DELETE ON base_audit_events
  FOR EACH ROW EXECUTE FUNCTION base_audit_events_append_only();
`;

export const baseWalletsMigration: Migration = {
  version: 78,
  name: 'base_wallets',
  sql: BASE_MIGRATION_SQL,
};

/**
 * Migration 79 (docs/base/ARCHITECTURE.md §11): the chain module's spender keystore, the one
 * balance-reservation ledger (owned by the chain module), and payments.
 * - `base_spender_keys`: envelope-encrypted spender keys. Read and written only by the chain
 *   module; never selected into any view, export or log. Rows never referenced by a wallet
 *   (committed_at NULL) for over an hour are orphans and are deleted.
 * - `base_wallet_reservations`: amounts held per wallet and token for a payment or fleet job;
 *   released or consumed only after definitive reconciliation, never on a timeout alone.
 * - `base_payments`: transfers and x402 payments with their durable legs; all amounts are
 *   non-negative integers in token base units.
 */
export const BASE_PAYMENTS_MIGRATION_SQL = `
ALTER TABLE base_wallets DROP COLUMN IF EXISTS provisioned_by_owner_fleet;
CREATE TABLE IF NOT EXISTS base_spender_keys (
  key_id text PRIMARY KEY,
  kek_version integer NOT NULL CHECK (kek_version > 0),
  wrapped_dek bytea NOT NULL,
  ciphertext bytea NOT NULL,
  signer_address text NOT NULL CHECK (signer_address ~ '^0x[0-9a-fA-F]{40}$'),
  committed_at bigint,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS base_spender_keys_orphans ON base_spender_keys(created_at)
  WHERE committed_at IS NULL;
CREATE TABLE IF NOT EXISTS base_wallet_reservations (
  reservation_id text PRIMARY KEY,
  wallet_id text NOT NULL REFERENCES base_wallets(wallet_id) ON DELETE RESTRICT,
  chain_id integer NOT NULL,
  token text NOT NULL CHECK (token ~ '^0x[0-9a-fA-F]{40}$'),
  amount numeric(78,0) NOT NULL CHECK (amount > 0),
  holder_kind text NOT NULL CHECK (holder_kind IN ('payment','fleet_job')),
  holder_ref text NOT NULL,
  intent_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('held','consumed','released')),
  op_id text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (holder_kind, holder_ref, wallet_id, token)
);
CREATE INDEX IF NOT EXISTS base_wallet_reservations_held
  ON base_wallet_reservations(wallet_id, token) WHERE state = 'held';
CREATE TABLE IF NOT EXISTS base_payments (
  payment_id text PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  chain_id integer NOT NULL,
  actor_id text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('agent','fleet')),
  source_ref text NOT NULL,
  parent_allocation_ref text,
  payer_wallet_id text NOT NULL REFERENCES base_wallets(wallet_id) ON DELETE RESTRICT,
  intent_version integer NOT NULL,
  intent_hash text NOT NULL,
  idempotency_key text NOT NULL,
  token_address text NOT NULL CHECK (token_address ~ '^0x[0-9a-fA-F]{40}$'),
  recipient_address text NOT NULL CHECK (recipient_address ~ '^0x[0-9a-fA-F]{40}$'),
  amount numeric(78,0) NOT NULL CHECK (amount > 0),
  kind text NOT NULL CHECK (kind IN ('transfer','x402')),
  state text NOT NULL CHECK (state IN ('created','pulling','authorized','settling','paid','reconciling','refunded')),
  reservation_id text REFERENCES base_wallet_reservations(reservation_id),
  pull_op_id text,
  settle_op_id text,
  cancel_op_id text,
  sweep_op_id text,
  authorization_nonce text,
  valid_after bigint,
  valid_before bigint,
  authorization_ref text,
  version bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (operator_id, chain_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS base_payments_open ON base_payments(chain_id, state)
  WHERE state NOT IN ('paid','refunded');
`;

export const basePaymentsMigration: Migration = {
  version: 79,
  name: 'base_keys_reservations_payments',
  sql: BASE_PAYMENTS_MIGRATION_SQL,
};

/** Migration 80: short ids for the on-chain agent URI (`/a/<6 base62 chars>`), one per agent. */
export const baseShortIdsMigration: Migration = {
  version: 80,
  name: 'base_short_ids',
  sql: `
CREATE TABLE IF NOT EXISTS base_short_ids (
  short_id text PRIMARY KEY CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
  agent_id text NOT NULL UNIQUE,
  created_at bigint NOT NULL
);
`,
};

/**
 * Migration 81 (docs/base/ARCHITECTURE.md §11.4): fleet jobs. The fleet module owns the job
 * ceiling ledger; wallet balances are held only through `base_wallet_reservations` (holder ref
 * `fleet_job:<jobId>:<batchNo>`), never reserved a second time here.
 * - `base_fleet_jobs`: one owner-signed run; `run_nonce` is unique per workspace (replay guard)
 *   and the signed intent is kept after completion for audit. `operator_id` is the workspace id
 *   (the run intent's `workspaceId`), as in `base_wallets`.
 * - `base_fleet_token_budgets` / `base_fleet_fee_budgets`: signed ceilings; reserved + spent never
 *   exceeds the ceiling. Amounts are integers in base units and never cross tokens; token
 *   addresses are stored lowercase so one token has exactly one ceiling.
 * - `base_fleet_batches`: exactly one UserOp per batch, with a fenced lease.
 * - `base_fleet_batch_allocations`: per batch and token, linked to its chain reservation.
 * - `base_fleet_items`: one row per agent and stage, with its own operation identity.
 * Batches and items keep the operation state (`status`) apart from the workflow refusal
 * (`refused_at`): refusing never clears a pending or unknown operation's reconciliation, and
 * `failed` still carries the actual fee charged.
 */
export const BASE_FLEET_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS base_fleet_jobs (
  job_id text PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  chain_id integer NOT NULL CHECK (chain_id IN (84532, 8453, 31337)),
  treasury_wallet_id text NOT NULL REFERENCES base_wallets(wallet_id) ON DELETE RESTRICT,
  -- Canonical unsigned decimal uint256 (no leading zeros), so '1' and '01' cannot both exist.
  run_nonce text NOT NULL CHECK (run_nonce ~ '^(0|[1-9][0-9]{0,77})$'
    AND run_nonce::numeric < 115792089237316195423570985008687907853269984665640564039457584007913129639936),
  intent_hash text NOT NULL,
  intent jsonb NOT NULL,
  signature bytea NOT NULL,
  manifest_hash text NOT NULL,
  registration_mode text NOT NULL CHECK (registration_mode IN ('lazy','immediate')),
  expires_at bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('created','running','cancelling','reconciling','done','refused')),
  version bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (operator_id, run_nonce)
);
CREATE INDEX IF NOT EXISTS base_fleet_jobs_open ON base_fleet_jobs(state)
  WHERE state NOT IN ('done','refused');
CREATE TABLE IF NOT EXISTS base_fleet_token_budgets (
  job_id text NOT NULL REFERENCES base_fleet_jobs(job_id) ON DELETE RESTRICT,
  token text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  principal_ceiling numeric(78,0) NOT NULL CHECK (principal_ceiling >= 0),
  principal_reserved numeric(78,0) NOT NULL DEFAULT 0 CHECK (principal_reserved >= 0),
  principal_spent numeric(78,0) NOT NULL DEFAULT 0 CHECK (principal_spent >= 0),
  PRIMARY KEY (job_id, token),
  CHECK (principal_reserved + principal_spent <= principal_ceiling)
);
CREATE TABLE IF NOT EXISTS base_fleet_fee_budgets (
  job_id text PRIMARY KEY REFERENCES base_fleet_jobs(job_id) ON DELETE RESTRICT,
  ceiling_wei numeric(78,0) NOT NULL CHECK (ceiling_wei >= 0),
  reserved_wei numeric(78,0) NOT NULL DEFAULT 0 CHECK (reserved_wei >= 0),
  spent_wei numeric(78,0) NOT NULL DEFAULT 0 CHECK (spent_wei >= 0),
  provider_pricing_version text NOT NULL,
  provider_terms jsonb NOT NULL,
  CHECK (reserved_wei + spent_wei <= ceiling_wei)
);
CREATE TABLE IF NOT EXISTS base_fleet_batches (
  job_id text NOT NULL REFERENCES base_fleet_jobs(job_id) ON DELETE RESTRICT,
  batch_no integer NOT NULL CHECK (batch_no >= 0),
  operation_key text NOT NULL UNIQUE,
  intent_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','unknown','final','failed')),
  refused_at bigint,
  attempted boolean NOT NULL DEFAULT false,
  max_fee_reserved_wei numeric(78,0) NOT NULL DEFAULT 0 CHECK (max_fee_reserved_wei >= 0),
  actual_fee_wei numeric(78,0) CHECK (actual_fee_wei >= 0),
  op_id text,
  lease_owner text,
  fence bigint NOT NULL DEFAULT 0,
  lease_expires_at bigint,
  next_retry_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (job_id, batch_no)
);
CREATE TABLE IF NOT EXISTS base_fleet_batch_allocations (
  job_id text NOT NULL,
  batch_no integer NOT NULL,
  token text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  reserved_principal numeric(78,0) NOT NULL CHECK (reserved_principal >= 0),
  finalized_spent numeric(78,0) CHECK (finalized_spent >= 0),
  reservation_id text NOT NULL UNIQUE REFERENCES base_wallet_reservations(reservation_id),
  PRIMARY KEY (job_id, batch_no, token),
  FOREIGN KEY (job_id, batch_no) REFERENCES base_fleet_batches(job_id, batch_no) ON DELETE RESTRICT,
  FOREIGN KEY (job_id, token) REFERENCES base_fleet_token_budgets(job_id, token) ON DELETE RESTRICT,
  CHECK (finalized_spent IS NULL OR finalized_spent <= reserved_principal)
);
CREATE TABLE IF NOT EXISTS base_fleet_items (
  job_id text NOT NULL REFERENCES base_fleet_jobs(job_id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  stage text NOT NULL CHECK (stage IN ('wallet','registration')),
  agent_id text NOT NULL,
  operation_key text NOT NULL UNIQUE,
  intent_hash text NOT NULL,
  batch_no integer,
  attempted boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('pending','unknown','final','failed')),
  refused_at bigint,
  lease_owner text,
  fence bigint NOT NULL DEFAULT 0,
  lease_expires_at bigint,
  next_retry_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (job_id, ordinal, stage),
  FOREIGN KEY (job_id, batch_no) REFERENCES base_fleet_batches(job_id, batch_no) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS base_fleet_items_claimable ON base_fleet_items(job_id, next_retry_at)
  WHERE status IN ('pending','unknown');
`;

export const baseFleetMigration: Migration = {
  version: 81,
  name: 'base_fleet',
  sql: BASE_FLEET_MIGRATION_SQL,
};

/**
 * Migration 82: the shared additions the chain and payment modules need.
 * - `base_payments.state` gains the terminal `failed` (a finalized failed operation is not `paid`,
 *   and reconciling forever would lose the outcome).
 * - `base_chain_ops.submitted_block`: the block at first broadcast; absence of an operation is only
 *   concluded from a complete scan starting there.
 * - `base_x402_authorizations`: issued EIP-3009 authorizations, one per payment intent, stored
 *   before they are returned. Restricted: read only by the chain module, never in views, exports or
 *   audit payloads (`base_payments.authorization_ref` points here).
 * - `base_master_workspaces`: the restricted internal list of master workspaces. Agents are not
 *   marked; registered-agent totals may include theirs under a clear definition, while activity they
 *   create stays excludable from user-adoption metrics through this list.
 * Hex values in the x402 table are stored lowercase, so case variants can never bypass uniqueness.
 */
export const BASE_SHARED_ADDITIONS_SQL = `
ALTER TABLE base_payments DROP CONSTRAINT IF EXISTS base_payments_state_check;
ALTER TABLE base_payments ADD CONSTRAINT base_payments_state_check CHECK (state IN
  ('created','pulling','authorized','settling','paid','reconciling','refunded','failed'));
DROP INDEX IF EXISTS base_payments_open;
CREATE INDEX IF NOT EXISTS base_payments_open ON base_payments(chain_id, state)
  WHERE state NOT IN ('paid','refunded','failed');
ALTER TABLE base_chain_ops ADD COLUMN IF NOT EXISTS submitted_block bigint
  CHECK (submitted_block IS NULL OR submitted_block >= 0);
CREATE TABLE IF NOT EXISTS base_x402_authorizations (
  payment_intent_id text PRIMARY KEY,
  chain_id integer NOT NULL CHECK (chain_id IN (84532, 8453, 31337)),
  token text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  from_address text NOT NULL CHECK (from_address ~ '^0x[0-9a-f]{40}$'),
  to_address text NOT NULL CHECK (to_address ~ '^0x[0-9a-f]{40}$'),
  value numeric(78,0) NOT NULL CHECK (value > 0),
  valid_after bigint NOT NULL CHECK (valid_after >= 0),
  valid_before bigint NOT NULL CHECK (valid_before > valid_after),
  nonce text NOT NULL CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
  signature bytea NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (chain_id, token, from_address, nonce)
);
CREATE TABLE IF NOT EXISTS base_master_workspaces (
  operator_id text PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,
  added_by text NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_at bigint NOT NULL
);
`;

export const baseSharedAdditionsMigration: Migration = {
  version: 82,
  name: 'base_shared_additions',
  sql: BASE_SHARED_ADDITIONS_SQL,
};

/**
 * Migration 83: each fleet item carries the owner, wallet and derivation version that the signed
 * manifest (shared/base/manifest.ts) committed to, so job creation can bind every item to it.
 * Stored lowercase. The table holds no rows before this migration (fleet runs were not wired).
 */
export const BASE_FLEET_MANIFEST_SQL = `
ALTER TABLE base_fleet_items
  ADD COLUMN IF NOT EXISTS owner_address text NOT NULL CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
  ADD COLUMN IF NOT EXISTS wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  ADD COLUMN IF NOT EXISTS derivation_version integer NOT NULL
    CHECK (derivation_version BETWEEN 1 AND 65535);
`;

export const baseFleetManifestMigration: Migration = {
  version: 83,
  name: 'base_fleet_manifest',
  sql: BASE_FLEET_MANIFEST_SQL,
};

/**
 * Migration 85: the provisional Base ID (identity service, server/base/identity/service.ts). The id
 * read from an INCLUDED registration is shown at once as provisional and the hand-over starts on
 * it; `confirmed` still needs both operations final. Every column here is internal bookkeeping of
 * the identity service: passport, registration file and authorization read only confirmed rows and
 * only `erc8004_agent_id`.
 * - `register_op_id`: the register attempt the row asked for; `mint_op_id`: the register operation
 *   whose receipt is the evidence (pinned once set; never sent again).
 * - `provisional_agent_id`, `mint_tx_hash`, `mint_block`, `mint_seen_at`, `mint_lost_at`: the
 *   verified receipt; `mint_lost_at` marks it ambiguous (receipt missing), never terminal.
 * - `mint_block_hash`: the receipt's block hash; "same receipt" is decided by tx and block HASH,
 *   never by number (same-height reorgs). `mint_finality` / `handover_finality`: 'included', 'safe'
 *   or 'final' (FINALIZED tag) as the port last reported it. Both 'safe' or better is the
 *   owner-facing "registered" moment; the state stays 'submitted' until canonical `confirmed`.
 * - `transfer_op_id`, `handover_id`, `handover_tx_hash`: the hand-over key and the id it is bound to;
 *   `handover_block`, `handover_block_hash`: where the bound hand-over landed (never a reverted one).
 * - `destination_mismatch`: the last failed post-transfer check at the finalized block (owner is not
 *   the agent wallet, tokenURI is not this agent, or the read is behind); never terminal.
 * - `evidence_rev`: fences every write to the evidence a poller observed.
 * - `started_at`: the latency metric's start; `swept_at`: the finalize cron's claim time.
 * Backfill: before 85 an id was only ever stored from a FINAL mint (so its mint finality is
 * 'final'), and only that id was handed over. The constraints are NOT VALID, so an odd legacy row
 * never blocks the deploy while every later write is checked. Applies after 84 (x402 receipts,
 * server/base/payments/receive-store.ts); it touches only base_identities, so a database that
 * already ran 85 before 84 arrives is fine too (runMigrations applies the missing lower version).
 */
export const BASE_IDENTITY_PROVISIONAL_SQL = `
ALTER TABLE base_identities
  ADD COLUMN IF NOT EXISTS register_op_id text
    CHECK (register_op_id IS NULL OR register_op_id LIKE 'identity:register:%'),
  ADD COLUMN IF NOT EXISTS mint_op_id text
    CHECK (mint_op_id IS NULL OR mint_op_id LIKE 'identity:register:%'),
  ADD COLUMN IF NOT EXISTS provisional_agent_id numeric(78,0)
    CHECK (provisional_agent_id IS NULL OR provisional_agent_id >= 0),
  ADD COLUMN IF NOT EXISTS mint_tx_hash text,
  ADD COLUMN IF NOT EXISTS mint_block bigint CHECK (mint_block IS NULL OR mint_block >= 0),
  ADD COLUMN IF NOT EXISTS mint_seen_at bigint,
  ADD COLUMN IF NOT EXISTS mint_lost_at bigint,
  ADD COLUMN IF NOT EXISTS transfer_op_id text
    CHECK (transfer_op_id IS NULL OR transfer_op_id LIKE 'identity:transfer:%'),
  ADD COLUMN IF NOT EXISTS handover_id numeric(78,0),
  ADD COLUMN IF NOT EXISTS handover_tx_hash text,
  ADD COLUMN IF NOT EXISTS evidence_rev bigint NOT NULL DEFAULT 0 CHECK (evidence_rev >= 0),
  ADD COLUMN IF NOT EXISTS started_at bigint,
  ADD COLUMN IF NOT EXISTS swept_at bigint,
  ADD COLUMN IF NOT EXISTS mint_block_hash text,
  ADD COLUMN IF NOT EXISTS mint_finality text
    CHECK (mint_finality IS NULL OR mint_finality IN ('included','safe','final')),
  ADD COLUMN IF NOT EXISTS handover_block bigint
    CHECK (handover_block IS NULL OR handover_block >= 0),
  ADD COLUMN IF NOT EXISTS handover_block_hash text,
  ADD COLUMN IF NOT EXISTS handover_finality text
    CHECK (handover_finality IS NULL OR handover_finality IN ('included','safe','final')),
  ADD COLUMN IF NOT EXISTS destination_mismatch text;
UPDATE base_identities SET started_at = updated_at WHERE started_at IS NULL;
UPDATE base_identities SET register_op_id = op_id
  WHERE register_op_id IS NULL AND op_id LIKE 'identity:register:%';
UPDATE base_identities SET provisional_agent_id = erc8004_agent_id,
  mint_seen_at = COALESCE(mint_seen_at, updated_at), mint_finality = 'final',
  mint_op_id = COALESCE(mint_op_id, register_op_id),
  transfer_op_id = CASE WHEN op_id LIKE 'identity:transfer:%' THEN op_id
                        ELSE 'identity:transfer:' || chain_id || ':' || agent_id END,
  handover_id = erc8004_agent_id
  WHERE erc8004_agent_id IS NOT NULL AND transfer_op_id IS NULL;
ALTER TABLE base_identities DROP CONSTRAINT IF EXISTS base_identities_confirmed_canonical;
ALTER TABLE base_identities ADD CONSTRAINT base_identities_confirmed_canonical CHECK (
  state <> 'confirmed' OR (erc8004_agent_id IS NOT NULL AND transfer_op_id IS NOT NULL
    AND handover_id = erc8004_agent_id)) NOT VALID;
ALTER TABLE base_identities DROP CONSTRAINT IF EXISTS base_identities_final_id_matches;
ALTER TABLE base_identities ADD CONSTRAINT base_identities_final_id_matches CHECK (
  erc8004_agent_id IS NULL OR provisional_agent_id = erc8004_agent_id) NOT VALID;
ALTER TABLE base_identities DROP CONSTRAINT IF EXISTS base_identities_handover_pair;
ALTER TABLE base_identities ADD CONSTRAINT base_identities_handover_pair CHECK (
  (transfer_op_id IS NULL) = (handover_id IS NULL)) NOT VALID;
CREATE INDEX IF NOT EXISTS base_identities_open_sweep ON base_identities (swept_at NULLS FIRST)
  WHERE state IN ('pending','submitted');
`;

export const baseIdentityProvisionalMigration: Migration = {
  version: 85,
  name: 'base_identity_provisional',
  sql: BASE_IDENTITY_PROVISIONAL_SQL,
  // Pre-deploy sanity: a confirmed row without a final id would violate the new invariant.
  report: {
    event: 'base_identity_provisional_migration',
    measure: async (tx) => {
      const { rows } = await tx.query<{ n: string | number }>(
        "SELECT count(*) AS n FROM base_identities WHERE state = 'confirmed' AND erc8004_agent_id IS NULL",
      );
      return { confirmedWithoutId: Number(rows[0]?.n ?? 0) };
    },
  },
};

/**
 * Migration 88 (Operation Base Wallet W1): the owner vault, one per person account.
 * - `base_owner_vaults` (migration 78, never read or written before this) stays keyed by
 *   `operator_id`: the person's own account id (kind 'owner'), never a workspace, so co-owners of
 *   an AI workspace never share a key. It gains the AES-GCM parameters, a version that every rewrap
 *   increments, the backup confirmation time and `updated_at`. `owner_address` is stored
 *   checksummed and is unique across vaults: a wallet's owner address names exactly one account.
 * - `base_vault_challenges`: single-use server nonces for the owner-key proofs, short-lived; a
 *   proof attempt deletes its nonce whatever the outcome.
 * - `base_wallets.owner_account_id`: the person whose vault key owns the wallet, so withdraw and
 *   limits can later authorize by the wallet's owner and not by current agent access. NULL for
 *   wallets whose owner is an outside address (mainnet registration, fleet).
 * The vault table holds no rows before this migration, so the NOT NULL columns need no default.
 */
export const BASE_WALLET_VAULT_SQL = `
ALTER TABLE base_owner_vaults
  ADD COLUMN IF NOT EXISTS cipher_params jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL CHECK (version >= 1),
  ADD COLUMN IF NOT EXISTS backup_confirmed_at bigint,
  ADD COLUMN IF NOT EXISTS updated_at bigint NOT NULL;
ALTER TABLE base_owner_vaults DROP CONSTRAINT IF EXISTS base_owner_vaults_ciphertext_size;
ALTER TABLE base_owner_vaults ADD CONSTRAINT base_owner_vaults_ciphertext_size
  CHECK (octet_length(encrypted_owner_key) BETWEEN 17 AND 1024);
CREATE UNIQUE INDEX IF NOT EXISTS base_owner_vaults_owner
  ON base_owner_vaults (lower(owner_address));
CREATE TABLE IF NOT EXISTS base_vault_challenges (
  nonce text PRIMARY KEY CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS base_vault_challenges_operator
  ON base_vault_challenges (operator_id, created_at);
CREATE INDEX IF NOT EXISTS base_vault_challenges_expiry ON base_vault_challenges (expires_at);
ALTER TABLE base_wallets
  ADD COLUMN IF NOT EXISTS owner_account_id text REFERENCES operators(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS base_wallets_owner_account
  ON base_wallets (owner_account_id, chain_id) WHERE owner_account_id IS NOT NULL;
`;

export const baseWalletVaultMigration: Migration = {
  version: 88,
  name: 'base_wallet_vault',
  sql: BASE_WALLET_VAULT_SQL,
  report: {
    event: 'base_wallet_vault_migration',
    measure: async (tx) => {
      const { rows } = await tx.query<{ n: string | number }>(
        'SELECT count(*) AS n FROM base_owner_vaults',
      );
      return { vaultsBefore: Number(rows[0]?.n ?? 0) };
    },
  },
};

/**
 * Migration 89 (Operation Base Wallet W2): owner withdrawals from an agent's wallet.
 * The owner key lives only in the browser, so a withdrawal is two-phase: the server prepares an
 * unsigned, sponsored UserOperation; the browser signs its raw userOpHash; the server checks the
 * signer is the wallet's owner and sends it through the durable chain operation path.
 * - `base_wallet_withdrawals`: one row per withdrawal. Authorized by the wallet's owner account
 *   (`owner_account_id`, v1.1 gate 3), idempotent per owner and key (`request_hash` is the body the
 *   key was first used with). `user_operation` is the exact unsigned operation the owner was shown
 *   (ERC-4337 v0.6 JSON-RPC form), `user_op_hash` its hash. `expires_at` applies only while
 *   unsigned (gate 2): a signed operation stays live until its nonce is used, by itself or by the
 *   owner's no-op at the same nonce (`cancel_*`, the same two phases). `tx_hash`, `block_number`,
 *   `cancel_state` and `cancel_tx_hash` mirror the chain operations for display;
 *   `submitted_at` / `cancel_submitted_at` mark the first time each was stored for broadcast.
 *   `sponsored`: a paymaster pays the gas; when it refuses or cannot be reached the operation is
 *   unsponsored and the wallet prefunds its gas from its own ETH, up to `max_fee_wei` (held as well:
 *   in the ETH hold of an ETH withdrawal, or in `fee_reservation_id` for a USDC one).
 * - One unfinished owner operation per wallet: a partial unique index over the open states.
 * - `base_wallet_reservations.holder_kind` gains 'withdrawal' (holder ref = the withdrawal id), so
 *   agent payments and withdrawals never commit the same funds twice.
 * - `base_chain_ops.kind` gains 'withdraw' and 'withdraw_cancel'.
 * The wallet networks only (Base Sepolia or Base; shared/base/wallet-network.ts names the one in
 * use); no other chain is accepted by the table.
 */
export const BASE_WALLET_WITHDRAWALS_SQL = `
ALTER TABLE base_wallet_reservations DROP CONSTRAINT IF EXISTS base_wallet_reservations_holder_kind_check;
ALTER TABLE base_wallet_reservations ADD CONSTRAINT base_wallet_reservations_holder_kind_check
  CHECK (holder_kind IN ('payment','fleet_job','withdrawal'));
ALTER TABLE base_chain_ops DROP CONSTRAINT IF EXISTS base_chain_ops_kind_check;
ALTER TABLE base_chain_ops ADD CONSTRAINT base_chain_ops_kind_check CHECK (kind IN
  ('userop','batch','transfer','register','approve','pull','settle','cancel_authorization','sweep',
   'withdraw','withdraw_cancel'));
CREATE TABLE IF NOT EXISTS base_wallet_withdrawals (
  withdrawal_id text PRIMARY KEY,
  wallet_id text NOT NULL REFERENCES base_wallets(wallet_id) ON DELETE RESTRICT,
  owner_account_id text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  chain_id integer NOT NULL CHECK (chain_id IN (84532, 8453)),
  token text NOT NULL CHECK (token IN ('USDC','ETH')),
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0),
  destination text NOT NULL CHECK (destination ~ '^0x[0-9a-fA-F]{40}$'),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('awaiting_signature','submitted','included','final',
    'failed','expired','cancel_pending','cancelled')),
  nonce numeric(78,0) NOT NULL CHECK (nonce >= 0),
  user_operation jsonb NOT NULL,
  user_op_hash text NOT NULL CHECK (user_op_hash ~ '^0x[0-9a-f]{64}$'),
  expires_at bigint NOT NULL,
  owner_signature bytea CHECK (owner_signature IS NULL OR octet_length(owner_signature) = 65),
  chain_op_key text UNIQUE,
  signed_at bigint,
  submitted_at bigint,
  tx_hash text CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_number bigint CHECK (block_number IS NULL OR block_number >= 0),
  reservation_id text UNIQUE REFERENCES base_wallet_reservations(reservation_id),
  sponsored boolean NOT NULL DEFAULT true,
  max_fee_wei numeric(78,0) NOT NULL DEFAULT 0 CHECK (max_fee_wei >= 0),
  fee_reservation_id text UNIQUE REFERENCES base_wallet_reservations(reservation_id),
  cancel_user_operation jsonb,
  cancel_user_op_hash text
    CHECK (cancel_user_op_hash IS NULL OR cancel_user_op_hash ~ '^0x[0-9a-f]{64}$'),
  cancel_expires_at bigint,
  cancel_signature bytea CHECK (cancel_signature IS NULL OR octet_length(cancel_signature) = 65),
  cancel_chain_op_key text UNIQUE,
  cancel_submitted_at bigint,
  cancel_state text CHECK (cancel_state IS NULL OR cancel_state IN
    ('awaiting_signature','submitted','included','final','failed','expired')),
  cancel_tx_hash text CHECK (cancel_tx_hash IS NULL OR cancel_tx_hash ~ '^0x[0-9a-f]{64}$'),
  cancel_sponsored boolean,
  cancel_max_fee_wei numeric(78,0) CHECK (cancel_max_fee_wei IS NULL OR cancel_max_fee_wei >= 0),
  error_code text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (owner_account_id, idempotency_key),
  CHECK ((owner_signature IS NULL) = (chain_op_key IS NULL)),
  CHECK ((owner_signature IS NULL) = (state IN ('awaiting_signature','expired'))),
  CHECK ((cancel_signature IS NULL) = (cancel_chain_op_key IS NULL)),
  CHECK (cancel_signature IS NULL OR cancel_user_op_hash IS NOT NULL),
  CHECK ((cancel_user_operation IS NULL) = (cancel_user_op_hash IS NULL)),
  CHECK ((cancel_user_op_hash IS NULL) = (cancel_state IS NULL)),
  CHECK (state <> 'cancelled' OR cancel_signature IS NOT NULL),
  CHECK (sponsored = (max_fee_wei = 0)),
  CHECK (fee_reservation_id IS NULL OR NOT sponsored),
  CHECK ((cancel_user_op_hash IS NULL) = (cancel_sponsored IS NULL)),
  CHECK ((cancel_sponsored IS NULL) = (cancel_max_fee_wei IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS base_wallet_withdrawals_one_open
  ON base_wallet_withdrawals (wallet_id)
  WHERE state IN ('awaiting_signature','submitted','included','cancel_pending');
CREATE INDEX IF NOT EXISTS base_wallet_withdrawals_owner
  ON base_wallet_withdrawals (owner_account_id, created_at);
`;

export const baseWalletWithdrawalsMigration: Migration = {
  version: 89,
  name: 'base_wallet_withdrawals',
  sql: BASE_WALLET_WITHDRAWALS_SQL,
};

/**
 * Migration 90 (Operation Base Wallet W3): owner-signed spending limits. `base_spend_permissions`
 * (migration 78) gets its first writer, the limit routes (server/base/wallet/limits.ts).
 * - `state` gains `revoke_pending`: the owner asked to revoke; the agent can no longer spend with
 *   it (payments read only 'signed' and 'onchain'), and it becomes `revoked` only once a read of
 *   Base at a settled block shows SpendPermissionManager.isRevoked (`revoked_block`).
 * - `token` (lowercase), `permission_hash` (SpendPermissionManager.getHash, unique per network),
 *   `period_kind` (the Berlin calendar period of the fixed on-chain period), `cap_raw` (the owner's
 *   cap, the calendar counter's bound) and `onchain_model` ('half': allowance = floor(cap / 2);
 *   'full': allowance = cap), plus the owner account that signed it.
 * - One limit per wallet and token that is not revoked (partial unique index): a new limit needs
 *   the old one revoked on Base first, never stacked.
 * - The revoke, two-phase: the unsigned UserOperation (`revoke_operation`, its hash and expiry)
 *   the owner signs in the browser; once signed, the owner's signature and the durable chain
 *   operation's key are stored BEFORE it is sent, so a stop in between resumes the same signed
 *   operation (`revoke_submitted_at` marks it handed to the chain module).
 * Every column is new and nullable (or defaulted) and the table had no writer, so nothing is
 * backfilled. Version 89 is W2's; 90 applies independently of it.
 */
export const BASE_WALLET_LIMITS_SQL = `
ALTER TABLE base_spend_permissions DROP CONSTRAINT IF EXISTS base_spend_permissions_state_check;
ALTER TABLE base_spend_permissions ADD CONSTRAINT base_spend_permissions_state_check
  CHECK (state IN ('signed','onchain','revoke_pending','revoked'));
ALTER TABLE base_spend_permissions
  ADD COLUMN IF NOT EXISTS token text CHECK (token IS NULL OR token ~ '^0x[0-9a-f]{40}$'),
  ADD COLUMN IF NOT EXISTS permission_hash text
    CHECK (permission_hash IS NULL OR permission_hash ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS period_kind text
    CHECK (period_kind IS NULL OR period_kind IN ('day','week','month')),
  ADD COLUMN IF NOT EXISTS cap_raw numeric(78,0) CHECK (cap_raw IS NULL OR cap_raw > 0),
  ADD COLUMN IF NOT EXISTS onchain_model text
    CHECK (onchain_model IS NULL OR onchain_model IN ('half','full')),
  ADD COLUMN IF NOT EXISTS owner_account_id text REFERENCES operators(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS revoke_requested_at bigint,
  ADD COLUMN IF NOT EXISTS revoke_attempt integer NOT NULL DEFAULT 0 CHECK (revoke_attempt >= 0),
  ADD COLUMN IF NOT EXISTS revoke_operation jsonb,
  ADD COLUMN IF NOT EXISTS revoke_user_op_hash text
    CHECK (revoke_user_op_hash IS NULL OR revoke_user_op_hash ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS revoke_expires_at bigint,
  ADD COLUMN IF NOT EXISTS revoke_op_key text,
  ADD COLUMN IF NOT EXISTS revoke_signature bytea
    CHECK (revoke_signature IS NULL OR octet_length(revoke_signature) = 65),
  ADD COLUMN IF NOT EXISTS revoke_submitted_at bigint,
  ADD COLUMN IF NOT EXISTS revoked_at bigint,
  ADD COLUMN IF NOT EXISTS revoked_block bigint CHECK (revoked_block IS NULL OR revoked_block >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS base_spend_permissions_hash
  ON base_spend_permissions (chain_id, permission_hash) WHERE permission_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS base_spend_permissions_one_active
  ON base_spend_permissions (wallet_id, token) WHERE token IS NOT NULL AND state <> 'revoked';
ALTER TABLE base_spend_permissions DROP CONSTRAINT IF EXISTS base_spend_permissions_revoked_proof;
ALTER TABLE base_spend_permissions ADD CONSTRAINT base_spend_permissions_revoked_proof
  CHECK (state <> 'revoked' OR permission_hash IS NULL OR revoked_block IS NOT NULL);
`;

export const baseWalletLimitsMigration: Migration = {
  version: 90,
  name: 'base_wallet_limits',
  sql: BASE_WALLET_LIMITS_SQL,
  report: {
    event: 'base_wallet_limits_migration',
    measure: async (tx) => {
      const { rows } = await tx.query<{ n: string | number }>(
        'SELECT count(*) AS n FROM base_spend_permissions',
      );
      return { permissionsBefore: Number(rows[0]?.n ?? 0) };
    },
  },
};

/**
 * Migration 91 (Operation Base Pay P1): an owner pays another Central City agent in USDC. A payment
 * goes out as an owner withdrawal (migration 89) to the recipient's wallet.
 * - `base_pay_lookups`: what a recipient lookup showed, server side, short-lived. `lookup_id` is
 *   random and unguessable (the answer's lookupId, the only thing a payment request carries for an
 *   agent); `account_id` is who looked up (only that account may pay with it); the chain,
 *   registry, agent, Base ID, short id and wallet it resolved to; the one block (`block`,
 *   `block_hash`) it was checked at, `issued_at` and `expires_at`; `version` of this row's
 *   format. One row per account and recipient and block (the same lookup again answers the same
 *   lookupId). Rows past their expiry are deleted as new lookups are issued.
 * - `base_wallet_payments`: the payment's own record, the stable row both wallets' histories join
 *   on (`withdrawal_id` for its state and transaction, `sender_wallet_id` / `recipient_wallet_id`
 *   for the two sides). `recipient_kind` 'central_city_agent': the recipient's agent, wallet, Base
 *   ID, short id and registry; `lookup_id` and `issued_block` / `issued_block_hash` /
 *   `issued_expires_at` copied from the lookup the person confirmed (issued by the server, never
 *   taken from the request); and the evidence of the fresh check right before the operation was
 *   prepared: ownerOf(Base ID) was the wallet at `verified_block` (`verified_block_hash`), read at
 *   `verified_at`, never after the lookup expired. 'address' (only while
 *   CITY_BASE_PAY_ANY_ADDRESS is on): any other address, no agent, no lookup, no evidence.
 *   `request_hash`: the payment as asked for under `idempotency_key` (one per owner account, like
 *   withdrawals). `note`: display only, at most 140 characters. `final_at`: set once, in the
 *   transaction that records the withdrawal final. `checked_at`: when the recipient's read last
 *   brought it up to date (the least recently checked go first).
 * - `change_xid`: the transaction that last changed the payment (its insert, or its withdrawal's
 *   state, by the trigger below). GET /api/base/pay/incoming pages by (change_xid, payment_id) and
 *   only returns rows whose transaction is older than every transaction still running, so a page
 *   can never pass a change that commits later: nothing is skipped.
 * USDC only, the wallet networks only (shared/base/wallet-network.ts). The recipient wallet's owner
 * account (base_wallets.owner_account_id, never the agent's current workspace) reads it.
 */
export const BASE_WALLET_PAYMENTS_SQL = `
CREATE TABLE IF NOT EXISTS base_pay_lookups (
  lookup_id text PRIMARY KEY CHECK (lookup_id ~ '^pl_[0-9A-Za-z_-]{32}$'),
  account_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  chain_id integer NOT NULL CHECK (chain_id IN (84532, 8453)),
  registry_address text NOT NULL CHECK (registry_address ~ '^0x[0-9a-fA-F]{40}$'),
  agent_id text NOT NULL,
  base_id numeric(78,0) NOT NULL CHECK (base_id >= 0),
  short_id text NOT NULL CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9a-fA-F]{40}$'),
  block bigint NOT NULL CHECK (block >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  issued_at bigint NOT NULL,
  expires_at bigint NOT NULL CHECK (expires_at > issued_at),
  version integer NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (account_id, chain_id, registry_address, agent_id, base_id, wallet, block_hash)
);
CREATE INDEX IF NOT EXISTS base_pay_lookups_expiry ON base_pay_lookups (expires_at);
CREATE TABLE IF NOT EXISTS base_wallet_payments (
  payment_id text PRIMARY KEY,
  withdrawal_id text NOT NULL UNIQUE
    REFERENCES base_wallet_withdrawals(withdrawal_id) ON DELETE RESTRICT,
  chain_id integer NOT NULL CHECK (chain_id IN (84532, 8453)),
  owner_account_id text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  sender_wallet_id text NOT NULL REFERENCES base_wallets(wallet_id) ON DELETE RESTRICT,
  sender_agent_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
  token text NOT NULL CHECK (token = 'USDC'),
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw >= 10000),
  recipient_kind text NOT NULL CHECK (recipient_kind IN ('central_city_agent','address')),
  recipient_address text NOT NULL CHECK (recipient_address ~ '^0x[0-9a-fA-F]{40}$'),
  recipient_agent_id text,
  recipient_wallet_id text REFERENCES base_wallets(wallet_id) ON DELETE RESTRICT,
  recipient_base_id numeric(78,0) CHECK (recipient_base_id IS NULL OR recipient_base_id >= 0),
  recipient_short_id text CHECK (recipient_short_id IS NULL OR recipient_short_id ~ '^[0-9A-Za-z]{6}$'),
  registry_address text CHECK (registry_address IS NULL OR registry_address ~ '^0x[0-9a-fA-F]{40}$'),
  lookup_id text CHECK (lookup_id IS NULL OR lookup_id ~ '^pl_[0-9A-Za-z_-]{32}$'),
  issued_block bigint CHECK (issued_block IS NULL OR issued_block >= 0),
  issued_block_hash text
    CHECK (issued_block_hash IS NULL OR issued_block_hash ~ '^0x[0-9a-f]{64}$'),
  issued_expires_at bigint,
  verified_block bigint CHECK (verified_block IS NULL OR verified_block >= 0),
  verified_block_hash text
    CHECK (verified_block_hash IS NULL OR verified_block_hash ~ '^0x[0-9a-f]{64}$'),
  verified_at bigint,
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 140),
  created_at bigint NOT NULL,
  final_at bigint,
  checked_at bigint,
  change_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  UNIQUE (owner_account_id, idempotency_key),
  CHECK ((recipient_kind = 'central_city_agent') = (recipient_agent_id IS NOT NULL)),
  CHECK (recipient_kind = 'central_city_agent' OR (recipient_wallet_id IS NULL
    AND recipient_base_id IS NULL AND recipient_short_id IS NULL AND registry_address IS NULL
    AND lookup_id IS NULL AND issued_block IS NULL AND issued_block_hash IS NULL
    AND issued_expires_at IS NULL AND verified_block IS NULL AND verified_block_hash IS NULL
    AND verified_at IS NULL)),
  CHECK (recipient_kind = 'address' OR (recipient_wallet_id IS NOT NULL
    AND recipient_base_id IS NOT NULL AND recipient_short_id IS NOT NULL
    AND registry_address IS NOT NULL AND lookup_id IS NOT NULL AND issued_block IS NOT NULL
    AND issued_block_hash IS NOT NULL AND issued_expires_at IS NOT NULL
    AND verified_block IS NOT NULL AND verified_block_hash IS NOT NULL
    AND verified_at IS NOT NULL AND verified_at <= issued_expires_at)),
  CHECK (recipient_wallet_id IS NULL OR recipient_wallet_id <> sender_wallet_id)
);
CREATE INDEX IF NOT EXISTS base_wallet_payments_sender
  ON base_wallet_payments (sender_wallet_id, created_at);
CREATE INDEX IF NOT EXISTS base_wallet_payments_recipient
  ON base_wallet_payments (recipient_wallet_id, change_xid, payment_id)
  WHERE recipient_wallet_id IS NOT NULL;
CREATE OR REPLACE FUNCTION base_wallet_payments_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE base_wallet_payments SET change_xid = pg_current_xact_id()
    WHERE withdrawal_id = NEW.withdrawal_id;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS base_wallet_payments_changed ON base_wallet_withdrawals;
CREATE TRIGGER base_wallet_payments_changed AFTER UPDATE OF state ON base_wallet_withdrawals
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION base_wallet_payments_changed();
`;

export const baseWalletPaymentsMigration: Migration = {
  version: 91,
  name: 'base_wallet_payments',
  sql: BASE_WALLET_PAYMENTS_SQL,
};

/**
 * Base Pay P2b: the owner's consent that one agent may pay on its own (wallet/agent-pay-consent.ts).
 * Bound to one chain, token, wallet and spending limit (permission id and hash); at most one live
 * consent per wallet and token. Withdrawn rows stay (revoked_at), so the history of who allowed
 * what is kept. Who it lets the agent pay (`recipients`) is migration 118's.
 */
export const BASE_AGENT_PAY_CONSENTS_SQL = `
CREATE TABLE IF NOT EXISTS base_agent_pay_consents (
  consent_id text PRIMARY KEY,
  chain_id integer NOT NULL CHECK (chain_id IN (84532, 8453, 31337)),
  wallet_id text NOT NULL REFERENCES base_wallets(wallet_id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  token text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  permission_id text NOT NULL REFERENCES base_spend_permissions(permission_id) ON DELETE CASCADE,
  permission_hash text NOT NULL CHECK (permission_hash ~ '^0x[0-9a-f]{64}$'),
  granted_by text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  granted_at bigint NOT NULL,
  revoked_at bigint,
  revoked_by text,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS base_agent_pay_consents_one_live
  ON base_agent_pay_consents (wallet_id, token) WHERE revoked_at IS NULL;
`;

export const baseAgentPayConsentsMigration: Migration = {
  version: 92,
  name: 'base_agent_pay_consents',
  sql: BASE_AGENT_PAY_CONSENTS_SQL,
};

/**
 * Migration 94 (Operation Rating R1): a Central City Base agent rates another one on Base (ERC-8004
 * Reputation Registry giveFeedback), as an owner operation from its own wallet.
 * - `base_wallet_withdrawals.kind`: 'withdraw' (every existing row, the default) or 'rate'. A rating
 *   is a row of this table so it shares the owner signing, gate 2 (one unlanded owner operation per
 *   wallet, settled at the safe head) and the status and cancel routes. It moves no money: `token`,
 *   `amount_raw` and `destination` are NULL for it, and so are both holds; it is sponsored, at no
 *   charge to the wallet (cancel included). A withdrawal still needs all three (the kind check);
 *   their own CHECKs stand. `rated_agent_id` / `rated_base_id` / `rating_value` (20 to 100 in steps
 *   of 20) say what a rating rates and are NULL for a withdrawal.
 * - `base_chain_ops.kind` gains 'rate' (a rating's operation; its cancel stays 'withdraw_cancel').
 * - `base_rate_lookups`: what a rating lookup showed, server side, short-lived, like
 *   `base_pay_lookups` (migration 91), and bound to the rater agent and wallet it was looked up for:
 *   only that account rating with that agent may use it, until `expires_at`. `rater_base_id` and
 *   `block` / `block_hash`: the one block both agents' owners were read at.
 * - The per-account daily count of ratings reads (owner_account_id, created_at) where kind 'rate'.
 * Nothing is dropped or rewritten; existing withdrawals and payments keep working as they are.
 */
export const BASE_WALLET_RATINGS_SQL = `
ALTER TABLE base_wallet_withdrawals
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'withdraw',
  ADD COLUMN IF NOT EXISTS rated_agent_id text,
  ADD COLUMN IF NOT EXISTS rated_base_id numeric(78,0),
  ADD COLUMN IF NOT EXISTS rating_value smallint;
ALTER TABLE base_wallet_withdrawals
  ALTER COLUMN token DROP NOT NULL,
  ALTER COLUMN amount_raw DROP NOT NULL,
  ALTER COLUMN destination DROP NOT NULL;
ALTER TABLE base_wallet_withdrawals DROP CONSTRAINT IF EXISTS base_wallet_withdrawals_kind_check;
ALTER TABLE base_wallet_withdrawals ADD CONSTRAINT base_wallet_withdrawals_kind_check CHECK (
  (kind = 'withdraw' AND token IS NOT NULL AND amount_raw IS NOT NULL AND destination IS NOT NULL
    AND rated_agent_id IS NULL AND rated_base_id IS NULL AND rating_value IS NULL)
  OR (kind = 'rate' AND token IS NULL AND amount_raw IS NULL AND destination IS NULL
    AND reservation_id IS NULL AND fee_reservation_id IS NULL AND sponsored
    AND (cancel_sponsored IS NULL OR cancel_sponsored)
    AND rated_agent_id IS NOT NULL AND rated_base_id IS NOT NULL AND rated_base_id >= 0
    AND rating_value IS NOT NULL AND rating_value IN (20, 40, 60, 80, 100)));
CREATE INDEX IF NOT EXISTS base_wallet_withdrawals_ratings
  ON base_wallet_withdrawals (owner_account_id, created_at) WHERE kind = 'rate';
ALTER TABLE base_chain_ops DROP CONSTRAINT IF EXISTS base_chain_ops_kind_check;
ALTER TABLE base_chain_ops ADD CONSTRAINT base_chain_ops_kind_check CHECK (kind IN
  ('userop','batch','transfer','register','approve','pull','settle','cancel_authorization','sweep',
   'withdraw','withdraw_cancel','rate'));
CREATE TABLE IF NOT EXISTS base_rate_lookups (
  lookup_id text PRIMARY KEY CHECK (lookup_id ~ '^rl_[0-9A-Za-z_-]{32}$'),
  account_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  rater_agent_id text NOT NULL,
  rater_wallet_id text NOT NULL REFERENCES base_wallets(wallet_id) ON DELETE CASCADE,
  rater_base_id numeric(78,0) NOT NULL CHECK (rater_base_id >= 0),
  chain_id integer NOT NULL CHECK (chain_id IN (84532, 8453)),
  registry_address text NOT NULL CHECK (registry_address ~ '^0x[0-9a-fA-F]{40}$'),
  agent_id text NOT NULL,
  base_id numeric(78,0) NOT NULL CHECK (base_id >= 0),
  short_id text NOT NULL CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9a-fA-F]{40}$'),
  block bigint NOT NULL CHECK (block >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  issued_at bigint NOT NULL,
  expires_at bigint NOT NULL CHECK (expires_at > issued_at),
  CHECK (agent_id <> rater_agent_id),
  UNIQUE (account_id, rater_agent_id, chain_id, registry_address, agent_id, base_id, wallet,
    block_hash)
);
CREATE INDEX IF NOT EXISTS base_rate_lookups_expiry ON base_rate_lookups (expires_at);
`;

export const baseWalletRatingsMigration: Migration = {
  version: 94,
  name: 'base_wallet_ratings',
  sql: BASE_WALLET_RATINGS_SQL,
};

/**
 * Admission, no longer one unsettled operation per wallet. Who may start the next owner operation
 * is decided when one is created, under the wallet's row lock (wallet/withdrawals.ts create and
 * openOn): an operation in a block that Base proves settled at its safe head no longer blocks; its
 * held amount stays held until final. An index can't say that, and it must never refuse the
 * chain's own story: a block Base drops sends an earlier operation back to submitted while the
 * next one exists. So only the one state nothing ever returns to stays unique (one unsigned
 * operation per wallet); the others are only indexed for that lookup.
 */
export const BASE_WALLET_ONE_UNSIGNED_SQL = `
DROP INDEX IF EXISTS base_wallet_withdrawals_one_open;
CREATE UNIQUE INDEX IF NOT EXISTS base_wallet_withdrawals_one_unsigned
  ON base_wallet_withdrawals (wallet_id)
  WHERE state = 'awaiting_signature';
CREATE INDEX IF NOT EXISTS base_wallet_withdrawals_in_flight
  ON base_wallet_withdrawals (wallet_id)
  WHERE state IN ('submitted','included','cancel_pending');
`;

export const baseWalletOneUnsignedMigration: Migration = {
  version: 93,
  name: 'base_wallet_withdrawals_one_unsigned',
  sql: BASE_WALLET_ONE_UNSIGNED_SQL,
};

/**
 * Pay without waiting (wallet/withdrawals.ts, only while CITY_BASE_LANES=1 at create; migration 95): an owner
 * operation may run in its own nonce lane, key = laneKey(withdrawal_id) (shared/base/lanes.ts),
 * nonce = key << 64 | 0. The lane is stored with the operation, in the same row and transaction:
 *
 *   - lane_key is never the wallet's shared lane 0, never the replayable key 8453, below 2^192,
 *     and always the key of the stored nonce (so a cancel at that nonce is in the same lane);
 *   - one operation per (chain, wallet, lane): a second one is refused, never reused.
 *
 * checked_at: when an operation was last brought up to date before an admission (the least
 * recently checked go first). cancel_fee_reservation_id: the hold on the wallet's ETH for an
 * owner-funded cancel's gas, released or consumed with the cancel. reverted_at: when Base first
 * showed the operation reverted, stored once (the sponsor's revert budget counts from it).
 *
 * Version 95: 94 is Base Rating's ratings table; the two touch different tables and apply in any
 * order.
 *
 * Several unsigned operations may wait in their own lanes; only unlanded ones stay one per wallet
 * (93's rule, scoped to lane_key IS NULL). Admission (the open-operations cap, holds, one deploying
 * operation at a time) is decided under the wallet's row lock in create.
 */
export const BASE_WALLET_LANES_SQL = `
ALTER TABLE base_wallet_withdrawals ADD COLUMN IF NOT EXISTS lane_key numeric(78,0)
  CHECK (lane_key IS NULL OR (
    lane_key > 0 AND lane_key <> 8453 AND lane_key < 2::numeric ^ 192
    AND div(nonce, 18446744073709551616::numeric) = lane_key));
ALTER TABLE base_wallet_withdrawals ADD COLUMN IF NOT EXISTS checked_at bigint;
ALTER TABLE base_wallet_withdrawals ADD COLUMN IF NOT EXISTS reverted_at bigint;
ALTER TABLE base_wallet_withdrawals ADD COLUMN IF NOT EXISTS cancel_fee_reservation_id text
  UNIQUE REFERENCES base_wallet_reservations(reservation_id);
CREATE UNIQUE INDEX IF NOT EXISTS base_wallet_withdrawals_lane
  ON base_wallet_withdrawals (chain_id, wallet_id, lane_key)
  WHERE lane_key IS NOT NULL;
DROP INDEX IF EXISTS base_wallet_withdrawals_one_unsigned;
CREATE UNIQUE INDEX IF NOT EXISTS base_wallet_withdrawals_one_unsigned_unlaned
  ON base_wallet_withdrawals (wallet_id)
  WHERE state = 'awaiting_signature' AND lane_key IS NULL;
CREATE INDEX IF NOT EXISTS base_wallet_withdrawals_unsigned
  ON base_wallet_withdrawals (wallet_id)
  WHERE state = 'awaiting_signature';
`;

export const baseWalletLanesMigration: Migration = {
  version: 95,
  name: 'base_wallet_withdrawals_lanes',
  sql: BASE_WALLET_LANES_SQL,
};

/**
 * Migration 96: the recipient's safe notice (GET /api/base/pay/incoming `safe`).
 * - `base_wallet_withdrawals.safe_at`: set once, by a recipient's read (wallet/withdrawals.ts
 *   markSafe), when Base proves the included operation settled at its safe head for its exact
 *   receipt and not reverted (settledIncluded, the payer's own proof). Only while included or final.
 * - Cleared by the row itself (BEFORE UPDATE) when the operation leaves that receipt: another state
 *   than final (a dropped block sends it back to submitted), another transaction or block, or an
 *   error. It never carries over to another landing.
 * - The incoming change cursor (migration 91's trigger) now moves the payment on a change of
 *   `state` OR `safe_at`, so a feed that only reads on after its cursor gets it again when it
 *   turns safe, and again when it stops being safe.
 */
export const BASE_WALLET_WITHDRAWALS_SAFE_SQL = `
ALTER TABLE base_wallet_withdrawals ADD COLUMN IF NOT EXISTS safe_at bigint;
ALTER TABLE base_wallet_withdrawals DROP CONSTRAINT IF EXISTS base_wallet_withdrawals_safe_check;
ALTER TABLE base_wallet_withdrawals ADD CONSTRAINT base_wallet_withdrawals_safe_check
  CHECK (safe_at IS NULL OR state IN ('included','final'));
CREATE OR REPLACE FUNCTION base_wallet_withdrawals_unsafe() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.safe_at IS NOT NULL AND NEW.safe_at IS NOT NULL AND (
      (NEW.state IS DISTINCT FROM OLD.state AND NEW.state <> 'final')
      OR NEW.tx_hash IS DISTINCT FROM OLD.tx_hash
      OR NEW.block_number IS DISTINCT FROM OLD.block_number
      OR NEW.error_code IS DISTINCT FROM OLD.error_code) THEN
    NEW.safe_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS base_wallet_withdrawals_unsafe ON base_wallet_withdrawals;
CREATE TRIGGER base_wallet_withdrawals_unsafe BEFORE UPDATE ON base_wallet_withdrawals
  FOR EACH ROW EXECUTE FUNCTION base_wallet_withdrawals_unsafe();
DROP TRIGGER IF EXISTS base_wallet_payments_changed ON base_wallet_withdrawals;
CREATE TRIGGER base_wallet_payments_changed AFTER UPDATE ON base_wallet_withdrawals
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state
    OR OLD.safe_at IS DISTINCT FROM NEW.safe_at)
  EXECUTE FUNCTION base_wallet_payments_changed();
`;

export const baseWalletWithdrawalsSafeMigration: Migration = {
  version: 96,
  name: 'base_wallet_withdrawals_safe',
  sql: BASE_WALLET_WITHDRAWALS_SAFE_SQL,
};

/**
 * Where a Base cron's walk continues on its next run (migration 98): one row per cron and network,
 * e.g. `base-pay-recover:8453` → the last held payment reservation the payment recovery cron looked
 * at. A run resumes after it and the row is removed once a walk reaches the end, so a slow or
 * unresolved first page can never hide later rows from every run. Operational only: no keys, no
 * amounts, nothing about a person; losing a row only restarts that walk at the oldest.
 *
 * Version 98: 96 and 97 are taken by other open changes; this table is independent of them.
 */
export const BASE_CRON_CURSORS_SQL = `
CREATE TABLE IF NOT EXISTS base_cron_cursors (
  name text PRIMARY KEY CHECK (name ~ '^[a-z0-9-]{1,48}:[0-9]{1,12}$'),
  cursor jsonb NOT NULL,
  updated_at bigint NOT NULL
);
`;

export const baseCronCursorsMigration: Migration = {
  version: 98,
  name: 'base_cron_cursors',
  sql: BASE_CRON_CURSORS_SQL,
};

/**
 * The ratings of one Base ID (migration 99): the Agent Explorer's list reads each page's scores in
 * one query by (chain_id, rated_base_id) over kind 'rate' (explorer/store.ts listScores). Without
 * it every uncached list read scans every rating. An index only: no data changes.
 */
export const BASE_RATINGS_BY_RATED_SQL = `
CREATE INDEX IF NOT EXISTS base_wallet_withdrawals_rated
  ON base_wallet_withdrawals (chain_id, rated_base_id) WHERE kind = 'rate';
`;

export const baseRatingsByRatedMigration: Migration = {
  version: 99,
  name: 'base_ratings_by_rated',
  sql: BASE_RATINGS_BY_RATED_SQL,
};

/**
 * A refused hand-over backs off (migration 102; 100 and 101 are the directory and room invitations): how many times in a row the bound hand-over was
 * refused before anything was stored (a node read refused under load, identity.handover_refused),
 * and when it may be tried again. The finalize cron skips a row until then, so its batch goes to
 * rows that can move; the owner's Try again tries it at once. Columns only: no data changes.
 */
export const BASE_IDENTITY_HANDOVER_BACKOFF_SQL = `
ALTER TABLE base_identities
  ADD COLUMN IF NOT EXISTS handover_refusals integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS handover_retry_at bigint;
`;

export const baseIdentityHandoverBackoffMigration: Migration = {
  version: 102,
  name: 'base_identity_handover_backoff',
  sql: BASE_IDENTITY_HANDOVER_BACKOFF_SQL,
};

/**
 * Migration 109 (105 to 108 belong to other changes). Columns only: no data changes.
 * - `base_chain_ops.searched_block`: how far the current on-chain search for an operation's event
 *   got without finding it, through settled blocks only (chain/submit.ts searchOnChain). The next
 *   search resumes after it, so one refresh asks for a few getLogs pages at most, never the whole
 *   span from the submission block. NULL: the next search starts at `submitted_block`.
 * - `base_identities.register_refusals`, `register_retry_at`: register attempts Base refused in a row
 *   before anything was stored (a rate limit or busy answer), and when the attempt may be tried
 *   again, like the hand-over's (102). The finalize cron skips a row until then; after a few
 *   refusals the owner is offered Try again, which asks at once with the same attempt key.
 */
export const BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL = `
ALTER TABLE base_chain_ops ADD COLUMN IF NOT EXISTS searched_block bigint
  CHECK (searched_block IS NULL OR searched_block >= 0);
ALTER TABLE base_identities
  ADD COLUMN IF NOT EXISTS register_refusals integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS register_retry_at bigint;
`;

export const baseSearchCursorRegisterBackoffMigration: Migration = {
  version: 109,
  name: 'base_search_cursor_register_backoff',
  sql: BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
};

/**
 * Migration 118 (116 and 117 belong to other open changes): who the owner's consent lets the agent
 * pay, as the owner confirmed it (wallet/agent-pay-consent.ts). 'central-city-agents' (city_pay) or
 * 'central-city-agents-and-feed-services' (also city_service_call). Every existing consent was
 * given before this column, so it reads 'central-city-agents': the owner was never asked about
 * services in the Feed, and confirms again to include them. Cheap DDL only: a constant default
 * (no rewrite, no scan) and a check that is NOT VALID (enforced on every new or changed row; the
 * existing rows hold the default, which passes it).
 */
export const BASE_AGENT_PAY_CONSENT_RECIPIENTS_SQL = `
ALTER TABLE base_agent_pay_consents
  ADD COLUMN IF NOT EXISTS recipients text NOT NULL DEFAULT 'central-city-agents';
ALTER TABLE base_agent_pay_consents
  ADD CONSTRAINT base_agent_pay_consents_recipients_check
  CHECK (recipients IN ('central-city-agents', 'central-city-agents-and-feed-services')) NOT VALID;
`;

export const baseAgentPayConsentRecipientsMigration: Migration = {
  version: 118,
  name: 'base_agent_pay_consent_recipients',
  sql: BASE_AGENT_PAY_CONSENT_RECIPIENTS_SQL,
};

/**
 * Migration 120 (119 belongs to another open change): the rated agents, kept as they happen, so
 * the Agent Explorer's "Rated agents" number (explorer/store.ts RATED_AGENTS_SQL) is a count of
 * one narrow index, never a walk of every rating.
 * - `base_rated_agents`: one row per network and Base ID with at least one rating sent through
 *   Central City (base_wallet_withdrawals kind 'rate') whose own operation (base_chain_ops, its
 *   chain_op_key) is a 'rate' on that network, FINAL on Base and not reverted: the finality the
 *   list's scores count by (listScores). Every rated agent and every rater. Rows are only added
 *   (a final operation stays final), and only by the two triggers below, in the same transaction
 *   as the change that makes a rating count, on every write path and on older instances during a
 *   deploy: an operation turning final (or stored final), or a rating linked to an operation that
 *   is already final. Both insert ON CONFLICT DO NOTHING: no counter row, so no hot row and no
 *   lock order between concurrent finalizations.
 * - The ratings from before it are added once here, from the rating rows' own index (migration 99)
 *   with one probe of the operation's unique key per rating: it grows with the ratings, never
 *   with base_chain_ops.
 */
export const BASE_RATED_AGENTS_SQL = `
CREATE TABLE IF NOT EXISTS base_rated_agents (
  chain_id integer NOT NULL,
  rated_base_id numeric(78,0) NOT NULL CHECK (rated_base_id >= 0),
  PRIMARY KEY (chain_id, rated_base_id)
);
CREATE OR REPLACE FUNCTION base_rated_agents_from_op() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO base_rated_agents (chain_id, rated_base_id)
    SELECT w.chain_id, w.rated_base_id FROM base_wallet_withdrawals w
    WHERE w.chain_op_key = NEW.idempotency_key AND w.kind = 'rate'
      AND w.chain_id = NEW.chain_id AND w.rated_base_id IS NOT NULL
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS base_rated_agents_from_op ON base_chain_ops;
CREATE TRIGGER base_rated_agents_from_op AFTER INSERT OR UPDATE OF status, error_code, kind
  ON base_chain_ops FOR EACH ROW
  WHEN (NEW.kind = 'rate' AND NEW.status = 'final'
    AND NEW.error_code IS DISTINCT FROM 'USEROP_REVERTED')
  EXECUTE FUNCTION base_rated_agents_from_op();
CREATE OR REPLACE FUNCTION base_rated_agents_from_rating() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO base_rated_agents (chain_id, rated_base_id)
    SELECT NEW.chain_id, NEW.rated_base_id FROM base_chain_ops o
    WHERE o.idempotency_key = NEW.chain_op_key AND o.kind = 'rate'
      AND o.chain_id = NEW.chain_id AND o.status = 'final'
      AND o.error_code IS DISTINCT FROM 'USEROP_REVERTED'
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS base_rated_agents_from_rating ON base_wallet_withdrawals;
CREATE TRIGGER base_rated_agents_from_rating AFTER INSERT OR UPDATE OF chain_op_key, rated_base_id, kind
  ON base_wallet_withdrawals FOR EACH ROW
  WHEN (NEW.kind = 'rate' AND NEW.chain_op_key IS NOT NULL AND NEW.rated_base_id IS NOT NULL)
  EXECUTE FUNCTION base_rated_agents_from_rating();
INSERT INTO base_rated_agents (chain_id, rated_base_id)
SELECT DISTINCT r.chain_id, r.rated_base_id FROM base_wallet_withdrawals r
WHERE r.kind = 'rate' AND r.rated_base_id IS NOT NULL
  AND (SELECT o.kind = 'rate' AND o.chain_id = r.chain_id AND o.status = 'final'
         AND o.error_code IS DISTINCT FROM 'USEROP_REVERTED'
       FROM base_chain_ops o WHERE o.idempotency_key = r.chain_op_key)
ON CONFLICT DO NOTHING;
`;

export const baseRatedAgentsMigration: Migration = {
  version: 121,
  name: 'base_rated_agents',
  sql: BASE_RATED_AGENTS_SQL,
};

/**
 * The sponsor's exposure in flight (migration 97; 96 is the incoming payments' safe_at, and the
 * two are independent): what the paymaster may still pay for owner operations that are not
 * finished, one row per sponsored operation or sponsored cancel (its most expensive gas,
 * maxCostWei). Reserved under the exposure lock when it is
 * created and released only on terminal evidence (final, failed, cancelled, expired unsigned, a
 * cancel that lapsed or failed); capped per wallet and in total (wallet/withdrawals.ts
 * reserveExposure). Never part of a wallet's balance. A table of its own: nothing else changes.
 *
 * Operations from before it are backfilled here, once, idempotently (ON CONFLICT on the holder):
 * every sponsored owner operation still open (awaiting its signature, sent, in a block, being
 * cancelled) and every sponsored cancel still live, at the bound of its own signed fields
 * (callGasLimit + 3 × verificationGasLimit + preVerificationGas) × maxFeePerGas, the formula of
 * chain/submit.ts maxCostWei with a paymaster. Their holders are the ones new rows use
 * ('withdrawal:<id>', 'headroom:<id>'), so the same terminal evidence releases them. Each also
 * gets its cancel headroom: its own gas at the fees a replacement must offer, or more when a live
 * sponsored cancel already costs more than the original (they share one nonce).
 * A bound of 10^77 or more (no real operation) is skipped, so a malformed stored operation can
 * never abort the migration with a numeric overflow.
 */
export const BASE_SPONSOR_EXPOSURE_SQL = `
CREATE TABLE IF NOT EXISTS base_sponsor_exposure (
  exposure_id text PRIMARY KEY,
  chain_id integer NOT NULL,
  wallet_id text NOT NULL REFERENCES base_wallets(wallet_id) ON DELETE RESTRICT,
  withdrawal_id text NOT NULL,
  holder text NOT NULL UNIQUE,
  amount numeric(78,0) NOT NULL CHECK (amount > 0),
  state text NOT NULL CHECK (state IN ('held','released')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS base_sponsor_exposure_wallet
  ON base_sponsor_exposure (chain_id, wallet_id) WHERE state = 'held';
CREATE INDEX IF NOT EXISTS base_sponsor_exposure_withdrawal
  ON base_sponsor_exposure (withdrawal_id) WHERE state = 'held';
CREATE OR REPLACE FUNCTION pg_temp.cc_hex_numeric(h text) RETURNS numeric LANGUAGE sql IMMUTABLE AS $f$
  SELECT coalesce(sum(
    (('x' || lpad(substr(lower(h), 2 + i, 1), 8, '0'))::bit(32)::int)::numeric
      * power(16::numeric, length(h) - 2 - i)), 0)::numeric(78,0)
  FROM generate_series(1, length(h) - 2) AS i
$f$;
CREATE OR REPLACE FUNCTION pg_temp.cc_sponsor_bound(op jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN
      op->>'callGasLimit' ~ '^0x[0-9a-fA-F]{1,64}$'
      AND op->>'verificationGasLimit' ~ '^0x[0-9a-fA-F]{1,64}$'
      AND op->>'preVerificationGas' ~ '^0x[0-9a-fA-F]{1,64}$'
      AND op->>'maxFeePerGas' ~ '^0x[0-9a-fA-F]{1,64}$'
    THEN (pg_temp.cc_hex_numeric(op->>'callGasLimit')
      + 3 * pg_temp.cc_hex_numeric(op->>'verificationGasLimit')
      + pg_temp.cc_hex_numeric(op->>'preVerificationGas'))
      * pg_temp.cc_hex_numeric(op->>'maxFeePerGas')
    END
$f$;
INSERT INTO base_sponsor_exposure (exposure_id, chain_id, wallet_id, withdrawal_id, holder, amount,
  state, created_at, updated_at)
SELECT 'backfill:withdrawal:' || w.withdrawal_id, w.chain_id, w.wallet_id, w.withdrawal_id,
  'withdrawal:' || w.withdrawal_id, b.bound, 'held', b.at, b.at
FROM base_wallet_withdrawals w
CROSS JOIN LATERAL (SELECT pg_temp.cc_sponsor_bound(w.user_operation) AS bound,
  (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS at) b
WHERE w.sponsored
  AND w.state IN ('awaiting_signature','submitted','included','cancel_pending')
  AND b.bound > 0 AND b.bound < 1e77
ON CONFLICT (holder) DO NOTHING;
CREATE OR REPLACE FUNCTION pg_temp.cc_cancel_room(op jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN pg_temp.cc_sponsor_bound(op) IS NULL THEN NULL ELSE
    (pg_temp.cc_hex_numeric(op->>'callGasLimit')
      + 3 * pg_temp.cc_hex_numeric(op->>'verificationGasLimit')
      + pg_temp.cc_hex_numeric(op->>'preVerificationGas'))
    * (pg_temp.cc_hex_numeric(op->>'maxFeePerGas')
      + floor(pg_temp.cc_hex_numeric(op->>'maxFeePerGas') / 10) + 1) END
$f$;
INSERT INTO base_sponsor_exposure (exposure_id, chain_id, wallet_id, withdrawal_id, holder, amount,
  state, created_at, updated_at)
SELECT 'backfill:headroom:' || w.withdrawal_id, w.chain_id, w.wallet_id, w.withdrawal_id,
  'headroom:' || w.withdrawal_id, h.room, 'held', h.at, h.at
FROM base_wallet_withdrawals w
CROSS JOIN LATERAL (SELECT greatest(
    CASE WHEN w.sponsored THEN coalesce(pg_temp.cc_cancel_room(w.user_operation), 0) ELSE 0 END,
    CASE WHEN w.cancel_user_operation IS NOT NULL AND coalesce(w.cancel_sponsored, true)
        AND w.cancel_state IN ('awaiting_signature','submitted','included')
      THEN coalesce(pg_temp.cc_sponsor_bound(w.cancel_user_operation), 0)
        - CASE WHEN w.sponsored THEN coalesce(pg_temp.cc_sponsor_bound(w.user_operation), 0)
          ELSE 0 END
      ELSE 0 END) AS room,
  (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS at) h
WHERE w.state IN ('awaiting_signature','submitted','included','cancel_pending')
  AND h.room > 0 AND h.room < 1e77
ON CONFLICT (holder) DO NOTHING;
DROP FUNCTION pg_temp.cc_cancel_room(jsonb);
DROP FUNCTION pg_temp.cc_sponsor_bound(jsonb);
DROP FUNCTION pg_temp.cc_hex_numeric(text);
`;

export const baseSponsorExposureMigration: Migration = {
  version: 97,
  name: 'base_sponsor_exposure',
  sql: BASE_SPONSOR_EXPOSURE_SQL,
};

export function registerBaseMigration(): void {
  registerMigration(baseWalletsMigration);
  registerMigration(basePaymentsMigration);
  registerMigration(baseShortIdsMigration);
  registerMigration(baseFleetMigration);
  registerMigration(baseSharedAdditionsMigration);
  registerMigration(baseFleetManifestMigration);
  registerMigration(receiveMigration); // 84
  registerMigration(baseIdentityProvisionalMigration); // 85
  registerMigration(receiveReconcileMigration); // 86
  registerMigration(baseWalletVaultMigration); // 88 (87 is the B2 journal)
  registerMigration(baseWalletWithdrawalsMigration); // 89
  registerMigration(baseWalletLimitsMigration); // 90 (89 is W2's withdrawals)
  registerMigration(baseWalletPaymentsMigration); // 91 (90 is W3's limits)
  registerMigration(baseAgentPayConsentsMigration); // 92 (91 is Base Pay P1)
  // 94 (93 is taken by the open gate-2 change, one unlanded operation per wallet; independent).
  registerMigration(baseWalletRatingsMigration);
  registerMigration(baseWalletOneUnsignedMigration); // 93 (92 is Base Pay P2b's consents)
  registerMigration(baseWalletLanesMigration); // 95 (94 is Base Rating's ratings)
  registerMigration(baseWalletWithdrawalsSafeMigration); // 96
  registerMigration(baseSponsorExposureMigration); // 97 (96: incoming safe_at, independent)
  registerMigration(baseCronCursorsMigration); // 98 (96 and 97 belong to other open changes)
  registerMigration(baseRatingsByRatedMigration); // 99
  registerMigration(baseIdentityHandoverBackoffMigration); // 102
  registerMigration(baseSearchCursorRegisterBackoffMigration); // 109 (105 to 108: other changes)
  registerMigration(baseAgentPayConsentRecipientsMigration); // 118 (116, 117: other open changes)
  registerMigration(baseRatedAgentsMigration); // 121 (119, 120: other open changes)
}
