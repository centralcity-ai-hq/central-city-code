import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 240 `x402_facilitator` (fee router 3, docs/protocol/FEE_ROUTER_3.md): the tables of
 * Central City's own x402 facilitator (server/protocol/x402/facilitator.ts), the server EOA that
 * sends router 3 `settle` transactions and pays their gas. New tables only.
 *
 * - `x402_facilitator_lanes`: one row per (chain, facilitator address), its next nonce. Every
 *   nonce is taken under this row's lock (SELECT ... FOR UPDATE), in the same transaction that
 *   stores the signed transaction, so two settlements never share a nonce.
 * - `x402_facilitator_ops`: one row per settlement (idempotency key), stored before anything is
 *   broadcast: the settle calldata and intent hash first, then the nonce, fees, the current signed
 *   raw transaction and every hash ever signed for that nonce (replacements), the receipt's block,
 *   and the outcome. `never_sent` marks a row that provably never left the server.
 * - `x402_facilitator_key`: at most one row per purpose (`router3`), the facilitator key the ops
 *   route provisioned (server/protocol/x402/facilitator-key-route.ts), so a retried or concurrent
 *   provisioning call answers the same key instead of creating another.
 */
export const X402_FACILITATOR_TABLES = [
  'x402_facilitator_lanes',
  'x402_facilitator_ops',
  'x402_facilitator_key',
] as const;

export const X402_FACILITATOR_SQL = `
CREATE TABLE IF NOT EXISTS x402_facilitator_lanes (
  chain_id integer NOT NULL,
  facilitator text NOT NULL CHECK (facilitator ~ '^0x[0-9a-f]{40}$'),
  next_nonce numeric(78,0) NOT NULL CHECK (next_nonce >= 0),
  updated_at bigint NOT NULL,
  PRIMARY KEY (chain_id, facilitator)
);
CREATE TABLE IF NOT EXISTS x402_facilitator_ops (
  op_key text PRIMARY KEY CHECK (length(op_key) BETWEEN 1 AND 200),
  intent_hash text NOT NULL CHECK (intent_hash ~ '^0x[0-9a-f]{64}$'),
  chain_id integer NOT NULL,
  facilitator text NOT NULL,
  router text NOT NULL,
  calldata text NOT NULL,
  status text NOT NULL CHECK (status IN
    ('queued','submitted','included','final','unknown','reconciling','reorged','failed')),
  claim_id text,
  claimed_at bigint,
  nonce numeric(78,0),
  gas_limit numeric(78,0),
  max_fee_per_gas numeric(78,0),
  max_priority_fee_per_gas numeric(78,0),
  l1_fee_wei numeric(78,0) CHECK (l1_fee_wei IS NULL OR l1_fee_wei >= 0),
  raw_tx text,
  tx_hash text CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  tx_hashes text[] NOT NULL DEFAULT '{}',
  sent_at bigint,
  block_number numeric(78,0),
  block_hash text,
  never_sent boolean NOT NULL DEFAULT false,
  error_code text,
  error_name text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (chain_id, facilitator, nonce)
);
CREATE INDEX IF NOT EXISTS x402_facilitator_ops_open ON x402_facilitator_ops (updated_at)
  WHERE status NOT IN ('final','failed');
CREATE TABLE IF NOT EXISTS x402_facilitator_key (
  purpose text PRIMARY KEY CHECK (purpose = 'router3'),
  key_ref text NOT NULL UNIQUE,
  address text NOT NULL CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  created_at bigint NOT NULL
);
`;

export const x402FacilitatorMigration: Migration = {
  version: 240,
  name: 'x402_facilitator',
  sql: X402_FACILITATOR_SQL,
};

/**
 * Migration 246 `x402_facilitator_batch` (the batch lane, approved
 * 21 Oct): many router 3 settlements in one settleBatch transaction, for allowlisted workspaces only
 * (CITY_PAY_BATCH_WORKSPACES). A batch is one ordinary row of x402_facilitator_ops (op_key
 * 'batch:<uuid>', calldata settleBatch), so its nonce, gas budget, replacement, rebroadcast and
 * finality are the lane's own. Two columns on the same table:
 *
 * - `batch_lane`: the settlement waits to be sent in a batch (set when it is stored; false for every
 *   other settlement, so with an empty allowlist nothing changes).
 * - `batch_key`: the batch op that carries it, assigned in the same transaction that inserts that
 *   batch op (a durable claim). A member never gets a nonce or a raw transaction of its own.
 * - `grant_kind`, `grant_id`: for a member bought through MCP, the assistant grant or workspace key
 *   it was bought with (ids only, never a token or key). The engine checks that grant or key again
 *   (revoked, expired, scope) right before the batch is simulated and again before it is signed
 *   (approved 21 Oct).
 *
 * Deploy: two columns with constant defaults and two partial indexes on a facilitator table; no
 * change to feed_pay_calls.
 */
export const X402_FACILITATOR_BATCH_SQL = `
ALTER TABLE IF EXISTS x402_facilitator_ops
  ADD COLUMN IF NOT EXISTS batch_lane boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS batch_key text,
  ADD COLUMN IF NOT EXISTS grant_kind text CHECK (grant_kind IS NULL OR grant_kind IN ('grant','key')),
  ADD COLUMN IF NOT EXISTS grant_id text;
CREATE INDEX IF NOT EXISTS x402_facilitator_ops_batch_waiting
  ON x402_facilitator_ops (chain_id, facilitator, created_at)
  WHERE batch_lane AND batch_key IS NULL AND status = 'queued';
CREATE INDEX IF NOT EXISTS x402_facilitator_ops_batch_members
  ON x402_facilitator_ops (batch_key) WHERE batch_key IS NOT NULL;
`;

export const x402FacilitatorBatchMigration: Migration = {
  version: 246,
  name: 'x402_facilitator_batch',
  sql: X402_FACILITATOR_BATCH_SQL,
};

/** Idempotent; call before runMigrations. */
export function registerX402FacilitatorMigration(): void {
  registerMigration(x402FacilitatorMigration);
  registerMigration(x402FacilitatorBatchMigration);
}
