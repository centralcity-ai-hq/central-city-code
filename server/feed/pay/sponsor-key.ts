/*
 * POST /api/ops/sfp/sponsor-key: provisions the sponsored first purchase's sponsor account
 * (server/feed/pay/sponsor.ts, sponsor-signer.ts) inside the deployed app, exactly like the
 * facilitator key (server/protocol/x402/facilitator-key-route.ts): a random key, encrypted under
 * CITY_BASE_SPENDER_KEK, stored in base_spender_keys and recorded in its own one-row table in the
 * same transaction that commits it. Durably idempotent; a concurrent loser's key stays uncommitted.
 *
 * Its own table (migration 249), never x402_facilitator_key: the sponsor key is not the router-3
 * facilitator's and the live facilitator's provisioning is left exactly as it is.
 *
 * Behind the ops guard (Bearer CITY_OPS_SECRET); 404 otherwise. Refused (409) while
 * CITY_SFP_SPONSOR_KEY_REF is set. Answers ONLY the address (to be funded with USDC and a little
 * ETH) and the opaque keyRef (for CITY_SFP_SPONSOR_KEY_REF), no-store.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database.js';
import { registerMigration, type Migration } from '../../migrations.js';
import { createKeystore, parseKeks, parseKeyRef } from '../../base/chain/keystore.js';
import { pgSpenderKeyStore } from '../../base/chain/stores.js';
import { opsAuthorized } from '../../elric/ops.js';

export const SFP_SPONSOR_KEY_PATH = '/api/ops/sfp/sponsor-key';
export const SFP_SPONSOR_KEY_REF_SETTING = 'CITY_SFP_SPONSOR_KEY_REF';

/** Migration 249 `feed_pay_sponsor_key`: one new one-row table; nothing else read or changed. */
export const FEED_PAY_SPONSOR_KEY_SQL = `
CREATE TABLE IF NOT EXISTS feed_pay_sponsor_key (
  purpose text PRIMARY KEY CHECK (purpose = 'sfp_sponsor'),
  key_ref text NOT NULL UNIQUE,
  address text NOT NULL CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  created_at bigint NOT NULL
);`;

export const feedPaySponsorKeyMigration: Migration = {
  version: 249,
  name: 'feed_pay_sponsor_key',
  sql: FEED_PAY_SPONSOR_KEY_SQL,
};

/** Idempotent; call before runMigrations (after the Base keystore's base_spender_keys). */
export function registerFeedPaySponsorKeyMigration(): void {
  registerMigration(feedPaySponsorKeyMigration);
}

export function registerSponsorKeyRoute(
  app: FastifyInstance,
  deps: { db: Database; env: Record<string, string | undefined>; now?: () => number },
): void {
  const now = deps.now ?? Date.now;
  const provisioned = async () =>
    (
      await deps.db.query<{ key_ref: string; address: string }>(
        `SELECT key_ref, address FROM feed_pay_sponsor_key WHERE purpose = 'sfp_sponsor'`,
      )
    ).rows[0];

  app.post(SFP_SPONSOR_KEY_PATH, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!opsAuthorized(request.headers.authorization, deps.env.CITY_OPS_SECRET))
      return reply.code(404).send({ error: 'Not found.', code: 'not_found' });
    if (deps.env[SFP_SPONSOR_KEY_REF_SETTING]?.trim())
      return reply.code(409).send({
        error: 'A sponsor key is already configured.',
        code: 'sponsor_key_configured',
      });
    const existing = await provisioned();
    if (existing) return { address: existing.address, keyRef: existing.key_ref };
    let keks;
    try {
      keks = parseKeks(deps.env.CITY_BASE_SPENDER_KEK);
    } catch {
      return reply
        .code(503)
        .send({ error: 'The keystore is not configured.', code: 'keystore_unavailable' });
    }
    // Stored uncommitted first; recorded and committed together only if this call wins the row.
    const { signer, keyRef } = await createKeystore({
      store: pgSpenderKeyStore(deps.db),
      keks,
    }).createSpenderKey();
    await deps.db.transaction(async (tx) => {
      const at = now();
      const won = await tx.query(
        `INSERT INTO feed_pay_sponsor_key (purpose, key_ref, address, created_at)
         VALUES ('sfp_sponsor', $1, $2, $3) ON CONFLICT (purpose) DO NOTHING RETURNING key_ref`,
        [keyRef, signer, at],
      );
      if (won.rows.length)
        await tx.query(
          'UPDATE base_spender_keys SET committed_at = COALESCE(committed_at, $2) WHERE key_id = $1',
          [parseKeyRef(keyRef).keyId, at],
        );
    });
    const winner = (await provisioned())!;
    return { address: winner.address, keyRef: winner.key_ref };
  });
}
