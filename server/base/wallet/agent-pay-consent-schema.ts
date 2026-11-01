import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 300 `base_agent_pay_consent_signature` (CCA-113): an agent-pay consent is bound to a
 * signature by the wallet's owner key (shared/base/agent-pay-consent.ts), not given by the console
 * session alone.
 *
 * - `owner_signature`: the owner key's EIP-712 signature over {chain, wallet, token, limit hash,
 *   recipients, nonce, issuedAt}, checked against base_wallets.owner_address when the consent is
 *   given (wallet/agent-pay-consent.ts grant) and stored with it.
 * - `consent_nonce` (unique while set): the signature's one-time nonce, so a signature is never
 *   accepted twice; `signed_at`: its issuedAt.
 * - `before_signing`: true for every consent that existed when this migration ran. Those were given
 *   by the owner console before signatures existed and keep working (the owner can withdraw and
 *   confirm again with a signature; ending them all at once is an owner decision). A consent
 *   written later without a signature (an older build's instance during the deploy) has neither a
 *   signature nor this flag, and never lets an agent pay.
 *
 * Additive: four nullable columns, two CHECKs that every existing row passes (NULL), one partial
 * unique index. An older build names its insert columns and never reads these, so it keeps
 * working. Lock: ACCESS EXCLUSIVE on base_agent_pay_consents (one row per consent ever given) for
 * the CHECK validation, the one UPDATE and the index build; no other table is touched.
 */
export const agentPayConsentSignatureMigration: Migration = {
  version: 300,
  name: 'base_agent_pay_consent_signature',
  sql: `
ALTER TABLE base_agent_pay_consents
  ADD COLUMN IF NOT EXISTS owner_signature text CHECK (owner_signature ~ '^0x[0-9a-f]{130}$'),
  ADD COLUMN IF NOT EXISTS consent_nonce text CHECK (consent_nonce ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS signed_at bigint,
  ADD COLUMN IF NOT EXISTS before_signing boolean;
UPDATE base_agent_pay_consents SET before_signing = true
  WHERE owner_signature IS NULL AND before_signing IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS base_agent_pay_consents_nonce
  ON base_agent_pay_consents (consent_nonce) WHERE consent_nonce IS NOT NULL;
`,
};

/** Idempotent; call before runMigrations (after the Base migration, which creates the table). */
export function registerAgentPayConsentSignatureMigration(): void {
  registerMigration(agentPayConsentSignatureMigration);
}
