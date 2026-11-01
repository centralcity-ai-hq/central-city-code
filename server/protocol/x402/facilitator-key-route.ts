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
 * Four purposes (?purpose=, default `router3`): `router3`, fee router 3's facilitator
 * (CITY_X402_FACILITATOR_KEY_REF), `public-settle`, the public x402 facilitator's own sender
 * (CITY_X402_PUBLIC_SETTLE_KEY_REF, migration 269), `arc-router3`, fee router 3's facilitator on
 * Arc (CITY_ARC_FACILITATOR_KEY_REF, migration 352), and `public-offer`, the offers' public address's
 * own sender (CITY_X402_PUBLIC_OFFER_KEY_REF, migration 355), each its own key, row and EOA.
 *
 * Behind the ops guard (capability 'keys': Bearer CITY_OPS_KEYS_SECRET, else CITY_OPS_SECRET;
 * server/elric/ops.ts opsAuthorizedFor); 404 otherwise. Refused (409) while that purpose's key ref is already set, so a
 * configured facilitator is never replaced by accident. Answers ONLY the address (to be
 * funded with a little of its chain's gas asset) and the opaque keyRef (for that purpose's setting),
 * no-store.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database.js';
import { createKeystore, parseKeks, parseKeyRef } from '../../base/chain/keystore.js';
import { pgSpenderKeyStore } from '../../base/chain/stores.js';
import { opsAuthorizedFor } from '../../elric/ops.js';

export const FACILITATOR_KEY_PATH = '/api/ops/x402/facilitator-key';

/** Each provisioned key's purpose and the setting that, once set, configures it. */
export const FACILITATOR_KEY_PURPOSES = {
  router3: 'CITY_X402_FACILITATOR_KEY_REF',
  'public-settle': 'CITY_X402_PUBLIC_SETTLE_KEY_REF',
  'arc-router3': 'CITY_ARC_FACILITATOR_KEY_REF',
  'public-offer': 'CITY_X402_PUBLIC_OFFER_KEY_REF',
} as const;
export type FacilitatorKeyPurpose = keyof typeof FACILITATOR_KEY_PURPOSES;

export function registerFacilitatorKeyRoute(
  app: FastifyInstance,
  deps: { db: Database; env: Record<string, string | undefined>; now?: () => number },
): void {
  const now = deps.now ?? Date.now;
  const provisioned = async (purpose: FacilitatorKeyPurpose) =>
    (
      await deps.db.query<{ key_ref: string; address: string }>(
        `SELECT key_ref, address FROM x402_facilitator_key WHERE purpose = $1`,
        [purpose],
      )
    ).rows[0];

  app.post(FACILITATOR_KEY_PATH, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!opsAuthorizedFor(request.headers.authorization, deps.env, 'keys'))
      return reply.code(404).send({ error: 'Not found.', code: 'not_found' });
    const asked = (request.query as { purpose?: unknown } | undefined)?.purpose ?? 'router3';
    if (typeof asked !== 'string' || !Object.hasOwn(FACILITATOR_KEY_PURPOSES, asked))
      return reply.code(400).send({ error: 'Unknown key purpose.', code: 'invalid_purpose' });
    const purpose = asked as FacilitatorKeyPurpose;
    if (deps.env[FACILITATOR_KEY_PURPOSES[purpose]]?.trim())
      return reply.code(409).send({
        error: 'A facilitator key is already configured.',
        code: 'facilitator_key_configured',
      });
    const existing = await provisioned(purpose);
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
         VALUES ($4, $1, $2, $3) ON CONFLICT (purpose) DO NOTHING RETURNING key_ref`,
        [keyRef, signer, at, purpose],
      );
      if (won.rows.length)
        await tx.query(
          'UPDATE base_spender_keys SET committed_at = COALESCE(committed_at, $2) WHERE key_id = $1',
          [parseKeyRef(keyRef).keyId, at],
        );
    });
    const winner = (await provisioned(purpose))!;
    return { address: winner.address, keyRef: winner.key_ref };
  });
}
