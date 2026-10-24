/*
 * POST /api/ops/paymaster/keys: provisions Operation Paymaster's server keys inside the deployed
 * app, exactly like the SFP sponsor key (server/feed/pay/sponsor-key.ts): random keys, encrypted
 * under CITY_BASE_SPENDER_KEK, stored in base_spender_keys and recorded in their own table in the
 * same transaction that commits them. Durably idempotent per purpose; a concurrent loser's key stays
 * uncommitted.
 *
 *   paymaster_signer      the VerifyingPaymaster's verifyingSigner (constructor argument);
 *                         CITY_BASE_PAYMASTER_SIGNER_KEY_REF
 *   paymaster_submitter_1 the EOAs that call EntryPoint.handleOps (the contract's bundler
 *   paymaster_submitter_2 allowlist; beneficiary of their own batches);
 *                         CITY_BASE_SUBMITTER_KEY_REFS (comma-separated)
 *
 * The contract's owner (admin) key is NOT made here: it never reaches the app (it lives on the stress
 * server only). Behind the ops guard (Bearer CITY_OPS_SECRET); 404 otherwise. Refused (409) while
 * CITY_BASE_PAYMASTER_SIGNER_KEY_REF is set, so a configured deployment never mints new keys.
 * Answers ONLY addresses and the opaque keyRefs (references into the keystore, not key material),
 * no-store.
 *
 * Prepare mode (Operation Paymaster, no secret needed): with CITY_BASE_OWN_PAYMASTER set to
 * 'prepare' (or 'on'), the server provisions the same keys itself when it starts
 * (provisionPaymasterKeys, the same idempotent code), and GET /api/public/paymaster shows a
 * read-only projection: the PUBLIC addresses of the signer and submitter 1, the configured paymaster
 * contract and the EntryPoint. Never keyRefs, never a side effect, never an error text. Prepare mode
 * sponsors and submits nothing: it only makes the addresses the contract deploy and its bundler
 * allowlist need.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database.js';
import { registerMigration, type Migration } from '../../migrations.js';
import { createKeystore, parseKeks, parseKeyRef } from './keystore.js';
import { pgSpenderKeyStore } from './stores.js';
import { opsAuthorized } from '../../elric/ops.js';

export const PAYMASTER_KEYS_PATH = '/api/ops/paymaster/keys';
export const PAYMASTER_PUBLIC_PATH = '/api/public/paymaster';
/** off (default) | prepare (keys + public addresses only) | on (sponsoring; later PRs). */
export const OWN_PAYMASTER_SETTING = 'CITY_BASE_OWN_PAYMASTER';
/** The deployed paymaster contract (public), once it is deployed. */
export const PAYMASTER_ADDRESS_SETTING = 'CITY_BASE_PAYMASTER_ADDRESS';
export type OwnPaymasterMode = 'off' | 'prepare' | 'on';
export function ownPaymasterMode(env: Record<string, string | undefined>): OwnPaymasterMode {
  const value = env[OWN_PAYMASTER_SETTING]?.trim();
  return value === 'prepare' || value === 'on' ? value : 'off';
}

/** The configured paymaster contract (CITY_BASE_PAYMASTER_ADDRESS), or null. */
export function ownPaymasterAddress(env: Record<string, string | undefined>): `0x${string}` | null {
  const value = env[PAYMASTER_ADDRESS_SETTING]?.trim() ?? '';
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as `0x${string}`) : null;
}

/** The switch: 'direct' sends through our own bundler (direct-bundler.ts), else CDP. */
export const BUNDLER_SETTING = 'CITY_BASE_BUNDLER';

/**
 * Which bundler the environment asks for. 'direct' only with everything it needs to sponsor
 * (CITY_BASE_OWN_PAYMASTER=on and a paymaster address); 'invalid' when direct is asked without
 * them: the server then keeps CDP and says so, in its log and on the public route as
 * 'cdp_fallback' (a wrong setting never stops registrations or
 * the site, and is never shown as our own paymaster being ready).
 */
export function bundlerChoice(
  env: Record<string, string | undefined>,
): 'cdp' | 'direct' | 'invalid' {
  if (env[BUNDLER_SETTING]?.trim() !== 'direct') return 'cdp';
  const paymaster = env[PAYMASTER_ADDRESS_SETTING]?.trim() ?? '';
  if (ownPaymasterMode(env) !== 'on' || !/^0x[0-9a-fA-F]{40}$/.test(paymaster)) return 'invalid';
  return 'direct';
}
export const PAYMASTER_SIGNER_KEY_REF_SETTING = 'CITY_BASE_PAYMASTER_SIGNER_KEY_REF';
export const SUBMITTER_KEY_REFS_SETTING = 'CITY_BASE_SUBMITTER_KEY_REFS';
export const PAYMASTER_KEY_PURPOSES = [
  'paymaster_signer',
  'paymaster_submitter_1',
  'paymaster_submitter_2',
] as const;
export type PaymasterKeyPurpose = (typeof PAYMASTER_KEY_PURPOSES)[number];

/** Migration 256 `own_paymaster_keys`: one new table, one row per purpose; nothing else touched. */
export const OWN_PAYMASTER_KEYS_SQL = `
CREATE TABLE IF NOT EXISTS own_paymaster_keys (
  purpose text PRIMARY KEY CHECK (purpose IN ('paymaster_signer', 'paymaster_submitter_1', 'paymaster_submitter_2')),
  key_ref text NOT NULL UNIQUE,
  address text NOT NULL UNIQUE CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  created_at bigint NOT NULL
);`;

export const ownPaymasterKeysMigration: Migration = {
  version: 256,
  name: 'own_paymaster_keys',
  sql: OWN_PAYMASTER_KEYS_SQL,
};

/** Idempotent; call before runMigrations (after the Base keystore's base_spender_keys). */
export function registerOwnPaymasterKeysMigration(): void {
  registerMigration(ownPaymasterKeysMigration);
}

type ProvisionedKey = { address: string; keyRef: string };

/** The recorded keys by purpose (read-only). */
export async function provisionedPaymasterKeys(
  db: Pick<Database, 'query'>,
): Promise<Map<PaymasterKeyPurpose, ProvisionedKey>> {
  const { rows } = await db.query<{
    purpose: PaymasterKeyPurpose;
    key_ref: string;
    address: string;
  }>('SELECT purpose, key_ref, address FROM own_paymaster_keys');
  return new Map(rows.map((row) => [row.purpose, { address: row.address, keyRef: row.key_ref }]));
}

export class KeystoreUnavailable extends Error {
  constructor() {
    super('The keystore is not configured.');
  }
}

/**
 * Creates the missing keys (signer, submitter 1, submitter 2), idempotently per purpose: each new key
 * is stored uncommitted first and recorded + committed only if this call wins its purpose's row, so
 * concurrent callers (instances starting together) agree on one key per purpose. Throws
 * KeystoreUnavailable without a KEK.
 */
export async function provisionPaymasterKeys(deps: {
  db: Database;
  env: Record<string, string | undefined>;
  now?: () => number;
}): Promise<Map<PaymasterKeyPurpose, ProvisionedKey>> {
  const now = deps.now ?? Date.now;
  const existing = await provisionedPaymasterKeys(deps.db);
  if (PAYMASTER_KEY_PURPOSES.every((purpose) => existing.has(purpose))) return existing;
  let keks;
  try {
    keks = parseKeks(deps.env.CITY_BASE_SPENDER_KEK);
  } catch {
    throw new KeystoreUnavailable();
  }
  const keystore = createKeystore({ store: pgSpenderKeyStore(deps.db), keks });
  for (const purpose of PAYMASTER_KEY_PURPOSES) {
    if (existing.has(purpose)) continue;
    const { signer, keyRef } = await keystore.createSpenderKey();
    await deps.db.transaction(async (tx) => {
      const at = now();
      const won = await tx.query(
        `INSERT INTO own_paymaster_keys (purpose, key_ref, address, created_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (purpose) DO NOTHING RETURNING key_ref`,
        [purpose, keyRef, signer, at],
      );
      if (won.rows.length)
        await tx.query(
          'UPDATE base_spender_keys SET committed_at = COALESCE(committed_at, $2) WHERE key_id = $1',
          [parseKeyRef(keyRef).keyId, at],
        );
    });
  }
  return provisionedPaymasterKeys(deps.db);
}

/**
 * Prepare mode at server start: provisions the keys when CITY_BASE_OWN_PAYMASTER is 'prepare' or
 * 'on'. Never throws (a failure must never keep the site from starting); returns what happened, as
 * a code only, for one log line.
 */
export async function provisionPaymasterKeysAtStart(deps: {
  db: Database;
  env: Record<string, string | undefined>;
  now?: () => number;
}): Promise<'off' | 'ready' | 'keystore_unavailable' | 'failed'> {
  if (ownPaymasterMode(deps.env) === 'off') return 'off';
  try {
    await provisionPaymasterKeys(deps);
    return 'ready';
  } catch (error) {
    return error instanceof KeystoreUnavailable ? 'keystore_unavailable' : 'failed';
  }
}

export function registerOwnPaymasterKeysRoute(
  app: FastifyInstance,
  deps: { db: Database; env: Record<string, string | undefined>; now?: () => number },
): void {
  const now = deps.now ?? Date.now;
  app.post(PAYMASTER_KEYS_PATH, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!opsAuthorized(request.headers.authorization, deps.env.CITY_OPS_SECRET))
      return reply.code(404).send({ error: 'Not found.', code: 'not_found' });
    if (deps.env[PAYMASTER_SIGNER_KEY_REF_SETTING]?.trim())
      return reply.code(409).send({
        error: 'Paymaster keys are already configured.',
        code: 'paymaster_keys_configured',
      });
    let keys;
    try {
      keys = await provisionPaymasterKeys({ db: deps.db, env: deps.env, now });
    } catch (error) {
      if (!(error instanceof KeystoreUnavailable)) throw error;
      return reply
        .code(503)
        .send({ error: 'The keystore is not configured.', code: 'keystore_unavailable' });
    }
    const out = (purpose: PaymasterKeyPurpose) => keys.get(purpose)!;
    return {
      signer: out('paymaster_signer'),
      submitters: [out('paymaster_submitter_1'), out('paymaster_submitter_2')],
      // The env values for the canary: ONE submitter lane (submitter 1). Submitter 2 is listed for
      // the full rollout only, never activated by this answer.
      env: {
        [PAYMASTER_SIGNER_KEY_REF_SETTING]: out('paymaster_signer').keyRef,
        [SUBMITTER_KEY_REFS_SETTING]: out('paymaster_submitter_1').keyRef,
      },
      laterLaneKeyRef: out('paymaster_submitter_2').keyRef,
    };
  });
}

/**
 * GET /api/public/paymaster: the read-only public projection (404 while the mode is off). Public
 * addresses only; never keyRefs; it creates nothing.
 */
export function registerPaymasterPublicRoute(
  app: FastifyInstance,
  deps: {
    db: Database;
    env: Record<string, string | undefined>;
    chainId: number;
    entryPoint: string;
    /** What the running bundler actually is, when ours is configured (direct-bundler.ts). */
    effective?: () => Promise<'direct' | 'cdp_fallback' | 'unknown' | undefined>;
  },
): void {
  app.get(PAYMASTER_PUBLIC_PATH, async (_request, reply) => {
    const mode = ownPaymasterMode(deps.env);
    if (mode === 'off') return reply.code(404).send({ error: 'Not found.', code: 'not_found' });
    reply.header('Cache-Control', 'public, max-age=0, s-maxage=30');
    const effectiveBundler = async () => {
      const choice = bundlerChoice(deps.env);
      if (choice !== 'direct') return choice === 'cdp' ? 'cdp' : 'cdp_fallback';
      const state = await deps.effective?.().catch(() => undefined);
      return state === 'direct'
        ? 'direct'
        : state === 'cdp_fallback'
          ? 'cdp_fallback'
          : 'direct_starting';
    };
    let keys: Map<PaymasterKeyPurpose, ProvisionedKey>;
    try {
      keys = await provisionedPaymasterKeys(deps.db);
    } catch {
      return reply.code(503).send({ error: 'Not available now.', code: 'unavailable' });
    }
    const paymaster = deps.env[PAYMASTER_ADDRESS_SETTING]?.trim();
    return {
      mode,
      chainId: deps.chainId,
      entryPoint: deps.entryPoint,
      paymaster: paymaster && /^0x[0-9a-fA-F]{40}$/.test(paymaster) ? paymaster : null,
      verifyingSigner: keys.get('paymaster_signer')?.address ?? null,
      // The canary runs ONE lane: only submitter 1 is shown (and allowlisted).
      submitter: keys.get('paymaster_submitter_1')?.address ?? null,
      // Which bundler this server sends with: 'direct' (ours), 'cdp', or 'cdp_fallback' when
      // direct was asked without what sponsoring needs (degraded, never "ready").
      // Configured vs in effect: 'direct' only once ours was built; 'cdp_fallback'
      // when direct is configured without what it needs, or could not be built (degraded, never
      // "ready"); 'direct_starting' before the first operation built it.
      bundlerConfigured: { cdp: 'cdp', direct: 'direct', invalid: 'direct_invalid' }[
        bundlerChoice(deps.env)
      ],
      bundler: await effectiveBundler(),
    };
  });
}
