/*
 * POST /api/ops/x402/facilitator-key: provisions the x402 facilitator's EOA key (fee router 3)
 * inside the deployed app, so the production database URL and CITY_BASE_SPENDER_KEK never leave
 * the platform. Same keystore as scripts/protocol/create-facilitator-key.ts: a random key,
 * encrypted under the KEK, stored in base_spender_keys.
 *
 * Durably idempotent: the provisioned key is recorded in x402_facilitator_key (one row, purpose
 * `router3`) in the same database transaction that commits the key. A retry (after a lost response)
 * or a concurrent call answers that same address and keyRef; a call that loses the race leaves its
 * own key uncommitted, and orphan cleanup removes it.
 *
 * Behind the ops guard (Authorization: Bearer CITY_OPS_SECRET, server/elric/ops.ts
 * opsAuthorized); 404 otherwise. Refused (409) while CITY_X402_FACILITATOR_KEY_REF is already
 * set, so a configured facilitator is never replaced by accident. Answers ONLY the address (to be
 * funded with a little ETH) and the opaque keyRef (for CITY_X402_FACILITATOR_KEY_REF), no-store.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database.js';
import { createKeystore, parseKeks, parseKeyRef } from '../../base/chain/keystore.js';
import { pgSpenderKeyStore } from '../../base/chain/stores.js';
import { opsAuthorized } from '../../elric/ops.js';

export const FACILITATOR_KEY_PATH = '/api/ops/x402/facilitator-key';

export function registerFacilitatorKeyRoute(
  app: FastifyInstance,
  deps: { db: Database; env: Record<string, string | undefined>; now?: () => number },
): void {
  const now = deps.now ?? Date.now;
  const provisioned = async () =>
    (
      await deps.db.query<{ key_ref: string; address: string }>(
        `SELECT key_ref, address FROM x402_facilitator_key WHERE purpose = 'router3'`,
      )
    ).rows[0];

  app.post(FACILITATOR_KEY_PATH, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!opsAuthorized(request.headers.authorization, deps.env.CITY_OPS_SECRET))
      return reply.code(404).send({ error: 'Not found.', code: 'not_found' });
    if (deps.env.CITY_X402_FACILITATOR_KEY_REF?.trim())
      return reply.code(409).send({
        error: 'A facilitator key is already configured.',
        code: 'facilitator_key_configured',
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
        `INSERT INTO x402_facilitator_key (purpose, key_ref, address, created_at)
         VALUES ('router3', $1, $2, $3) ON CONFLICT (purpose) DO NOTHING RETURNING key_ref`,
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
