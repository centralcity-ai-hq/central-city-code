import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 115 `protocol_screening_decisions` (docs/protocol/SCREENING-GATE.md): the durable
 * decisions of the payment screening gate (server/protocol/screening/gate.ts), and the hold of a
 * Feed pay protocol fee that screening did not clear.
 *
 * A decision is bound to the chain, the token, the exact amount, the intent id, every party
 * (role and lowercase address), the policy version and the provider reference; binding_hash is the
 * SHA-256 of that binding. Only an unexpired decision with the same binding is reused. Only
 * allowed and blocked answers are stored: an outage, a timeout or a malformed answer is never a
 * decision (and never clearance). New table and two nullable columns: nothing live is scanned.
 */
export const PROTOCOL_SCREENING_SQL = `
CREATE TABLE IF NOT EXISTS protocol_screening_decisions (
  decision_id text PRIMARY KEY CHECK (decision_id ~ '^sd_[0-9a-f]{32}$'),
  binding_hash text NOT NULL CHECK (binding_hash ~ '^[0-9a-f]{64}$'),
  chain_id integer NOT NULL CHECK (chain_id > 0),
  token text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw >= 0),
  intent_id text NOT NULL CHECK (length(intent_id) BETWEEN 1 AND 200),
  parties jsonb NOT NULL,
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 100),
  provider_ref text NOT NULL CHECK (length(provider_ref) BETWEEN 1 AND 200),
  outcome text NOT NULL CHECK (outcome IN ('allowed','blocked')),
  reason text NOT NULL CHECK (reason IN ('clear','sanctioned','denylisted')),
  decided_at bigint NOT NULL,
  expires_at bigint NOT NULL CHECK (expires_at > decided_at)
);
CREATE INDEX IF NOT EXISTS protocol_screening_decisions_binding
  ON protocol_screening_decisions (binding_hash, expires_at);
ALTER TABLE feed_pay_calls
  ADD COLUMN IF NOT EXISTS fee_held_at bigint,
  ADD COLUMN IF NOT EXISTS fee_hold_reason text
    CHECK (fee_hold_reason IS NULL OR fee_hold_reason ~ '^[a-z_]{1,40}$');`;

/** The screening tables (server/recovery.ts recognizes them and never exports them). */
export const PROTOCOL_SCREENING_TABLES = ['protocol_screening_decisions'] as const;

export const protocolScreeningMigration: Migration = {
  version: 115,
  name: 'protocol_screening_decisions',
  sql: PROTOCOL_SCREENING_SQL,
};

export function registerProtocolScreeningMigration(): void {
  registerMigration(protocolScreeningMigration);
}
