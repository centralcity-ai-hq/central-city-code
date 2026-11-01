/*
 * POST /api/ops/paymaster/keys: provisions Operation Paymaster's server keys inside the deployed
 * app, exactly like the SFP sponsor key (server/feed/pay/sponsor-key.ts): random keys, encrypted
 * under CITY_BASE_SPENDER_KEK, stored in base_spender_keys and recorded in their own table in the
 * same transaction that commits them. Durably idempotent per purpose; a concurrent loser's key stays
 * uncommitted.
 *
 *   paymaster_signer      the VerifyingPaymaster's verifyingSigner (constructor argument)
 *   paymaster_submitter_1 the EOAs that call EntryPoint.handleOps (the contract's bundler
 *   paymaster_submitter_2 allowlist; beneficiary of their own batches)
 *
 * The keys in use are always the recorded ones (own_paymaster_keys). The settings
 * CITY_BASE_PAYMASTER_SIGNER_KEY_REF and CITY_BASE_SUBMITTER_KEY_REFS (comma-separated) do NOT
 * select keys: when set, they assert which recorded keys are in use, and a mismatch fails closed
 * (paymasterKeySettingsMismatch: our own bundler is not built, CDP keeps serving, one log line at
 * start). Unset, nothing is asserted.
 *
 * The contract's owner (admin) key is NOT made here: it is owner-held and never on any server; it
 * never reaches the app. Behind the ops guard (capability 'keys': CITY_OPS_KEYS_SECRET, else CITY_OPS_SECRET); 404 otherwise. Refused (409) while
 * CITY_BASE_PAYMASTER_SIGNER_KEY_REF is set, so a configured deployment never mints new keys.
 * Answers ONLY public addresses (never keyRefs, never key material), no-store.
 *
 * Prepare mode (Operation Paymaster, no secret needed): with CITY_BASE_OWN_PAYMASTER set to
 * 'prepare' (or 'on'), the server provisions the same keys itself when it starts
 * (provisionPaymasterKeys, the same idempotent code), and GET /api/public/paymaster shows a
 * read-only projection: the PUBLIC addresses of the signer and submitter 1, the configured paymaster
 * contract and the EntryPoint. Never keyRefs, never a side effect, never an error text. Prepare mode
 * sponsors and submits nothing: it only makes the addresses the contract deploy and its bundler
 * allowlist need.
 *
 * Arc's paymaster has its own keys, never Base's (migration 351): the same three roles under arc_
 * purposes, in the same table. A chain reads and provisions only its own purposes
 * (paymasterKeyPurposes); the maps below are always keyed by Base's names, so what uses a key does
 * not depend on the chain. Arc's runtime sees CITY_ARC_PAYMASTER_SIGNER_KEY_REF and
 * CITY_ARC_SUBMITTER_KEY_REFS under Base's setting names (arc-env.ts), with the same meaning.
 * POST /api/ops/paymaster/keys makes Base's only: Arc's come from prepare mode.
 */
import type { FastifyInstance } from 'fastify';
import { BASE_MAINNET } from '../../../shared/base/chains.js';
import { chainFamily } from '../../../shared/chains.js';
import type { Database } from '../../database.js';
import { registerMigration, type Migration } from '../../migrations.js';
import { createKeystore, parseKeks, parseKeyRef } from './keystore.js';
import { pgSpenderKeyStore } from './stores.js';
import { opsAuthorizedFor } from '../../elric/ops.js';

export const PAYMASTER_KEYS_PATH = '/api/ops/paymaster/keys';
export const PAYMASTER_PUBLIC_PATH = '/api/public/paymaster';
/** Arc's view on a server that answers PAYMASTER_PUBLIC_PATH for Base; only while Arc is on. */
export const PAYMASTER_ARC_PUBLIC_PATH = '/api/public/paymaster/arc';
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
export const ARC_PAYMASTER_SIGNER_KEY_REF_SETTING = 'CITY_ARC_PAYMASTER_SIGNER_KEY_REF';
export const ARC_SUBMITTER_KEY_REFS_SETTING = 'CITY_ARC_SUBMITTER_KEY_REFS';
export const ARC_PAYMASTER_KEY_PURPOSES = [
  'arc_paymaster_signer',
  'arc_paymaster_submitter_1',
  'arc_paymaster_submitter_2',
] as const;

/** A chain's own purposes, in the order of PAYMASTER_KEY_PURPOSES. */
export function paymasterKeyPurposes(
  chainId: number,
): typeof PAYMASTER_KEY_PURPOSES | typeof ARC_PAYMASTER_KEY_PURPOSES {
  return chainFamily(chainId) === 'arc' ? ARC_PAYMASTER_KEY_PURPOSES : PAYMASTER_KEY_PURPOSES;
}

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

/** Migration 351 `own_paymaster_keys_arc_purposes`: Arc's purposes; existing rows are untouched. */
export const OWN_PAYMASTER_KEYS_ARC_PURPOSES_SQL = `
SET LOCAL lock_timeout = '2s';
ALTER TABLE own_paymaster_keys DROP CONSTRAINT IF EXISTS own_paymaster_keys_purpose_check;
ALTER TABLE own_paymaster_keys ADD CONSTRAINT own_paymaster_keys_purpose_check CHECK (purpose IN ('paymaster_signer','paymaster_submitter_1','paymaster_submitter_2','arc_paymaster_signer','arc_paymaster_submitter_1','arc_paymaster_submitter_2')) NOT VALID;
`;

export const ownPaymasterKeysArcPurposesMigration: Migration = {
  version: 351,
  name: 'own_paymaster_keys_arc_purposes',
  sql: OWN_PAYMASTER_KEYS_ARC_PURPOSES_SQL,
};

/** Idempotent; call before runMigrations (after the Base keystore's base_spender_keys). */
export function registerOwnPaymasterKeysMigration(): void {
  registerMigration(ownPaymasterKeysMigration);
  registerMigration(ownPaymasterKeysArcPurposesMigration);
}

type ProvisionedKey = { address: string; keyRef: string };

/** One chain's recorded keys, by Base's name for the role (read-only). Default: Base. */
export async function provisionedPaymasterKeys(
  db: Pick<Database, 'query'>,
  chainId: number = BASE_MAINNET,
): Promise<Map<PaymasterKeyPurpose, ProvisionedKey>> {
  const { rows } = await db.query<{
    purpose: string;
    key_ref: string;
    address: string;
  }>('SELECT purpose, key_ref, address FROM own_paymaster_keys');
  const own: readonly string[] = paymasterKeyPurposes(chainId);
  const keys = new Map<PaymasterKeyPurpose, ProvisionedKey>();
  for (const row of rows) {
    const role = PAYMASTER_KEY_PURPOSES[own.indexOf(row.purpose)];
    if (role) keys.set(role, { address: row.address, keyRef: row.key_ref });
  }
  return keys;
}

/**
 * The key settings checked against the recorded keys: the NAME of the first setting that does not
 * match, or null (never a value). CITY_BASE_PAYMASTER_SIGNER_KEY_REF must be the recorded signer's
 * keyRef; CITY_BASE_SUBMITTER_KEY_REFS must start with submitter 1's keyRef (the lane in use) and
 * name only recorded submitters. A setting that is set while its keys are not recorded mismatches.
 */
export function paymasterKeySettingsMismatch(
  env: Record<string, string | undefined>,
  keys: Map<PaymasterKeyPurpose, ProvisionedKey>,
): typeof PAYMASTER_SIGNER_KEY_REF_SETTING | typeof SUBMITTER_KEY_REFS_SETTING | null {
  const signerRef = env[PAYMASTER_SIGNER_KEY_REF_SETTING]?.trim();
  if (signerRef && signerRef !== keys.get('paymaster_signer')?.keyRef)
    return PAYMASTER_SIGNER_KEY_REF_SETTING;
  const submitterRefs = env[SUBMITTER_KEY_REFS_SETTING]?.trim();
  if (submitterRefs) {
    const listed = submitterRefs.split(',').map((ref) => ref.trim());
    const first = keys.get('paymaster_submitter_1')?.keyRef;
    const recorded = new Set(
      (['paymaster_submitter_1', 'paymaster_submitter_2'] as const)
        .map((purpose) => keys.get(purpose)?.keyRef)
        .filter((ref): ref is string => !!ref),
    );
    if (!first || listed[0] !== first || !listed.every((ref) => recorded.has(ref)))
      return SUBMITTER_KEY_REFS_SETTING;
  }
  return null;
}

/** The name the owner set: on Arc, Arc's name for a setting the runtime sees under Base's. */
export function paymasterKeySettingName(
  setting: typeof PAYMASTER_SIGNER_KEY_REF_SETTING | typeof SUBMITTER_KEY_REFS_SETTING,
  chainId: number,
): string {
  if (chainFamily(chainId) !== 'arc') return setting;
  return setting === PAYMASTER_SIGNER_KEY_REF_SETTING
    ? ARC_PAYMASTER_SIGNER_KEY_REF_SETTING
    : ARC_SUBMITTER_KEY_REFS_SETTING;
}

/**
 * The one sanitized start line for a key-settings mismatch (CCA-716): the event, the state and the
 * setting NAME only, never a value or a keyRef.
 */
export function paymasterKeysMismatchLogLine(
  setting: typeof PAYMASTER_SIGNER_KEY_REF_SETTING | typeof SUBMITTER_KEY_REFS_SETTING,
  chainId: number = BASE_MAINNET,
): string {
  return JSON.stringify({
    event: 'own_paymaster_keys',
    state: 'settings_mismatch',
    setting: paymasterKeySettingName(setting, chainId),
  });
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
 * KeystoreUnavailable without a KEK. Only `chainId`'s keys (default: Base's) are read or made.
 */
export async function provisionPaymasterKeys(deps: {
  db: Database;
  env: Record<string, string | undefined>;
  now?: () => number;
  chainId?: number;
}): Promise<Map<PaymasterKeyPurpose, ProvisionedKey>> {
  const now = deps.now ?? Date.now;
  const chainId = deps.chainId ?? BASE_MAINNET;
  const existing = await provisionedPaymasterKeys(deps.db, chainId);
  if (PAYMASTER_KEY_PURPOSES.every((purpose) => existing.has(purpose))) return existing;
  let keks;
  try {
    keks = parseKeks(deps.env.CITY_BASE_SPENDER_KEK);
  } catch {
    throw new KeystoreUnavailable();
  }
  const keystore = createKeystore({ store: pgSpenderKeyStore(deps.db), keks });
  const purposes = paymasterKeyPurposes(chainId);
  for (const [index, purpose] of purposes.entries()) {
    if (existing.has(PAYMASTER_KEY_PURPOSES[index]!)) continue;
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
  return provisionedPaymasterKeys(deps.db, chainId);
}

/**
 * Prepare mode at server start: provisions the keys when CITY_BASE_OWN_PAYMASTER is 'prepare' or
 * 'on', then checks the key settings against them ('settings_mismatch': our own bundler refuses to
 * be built, createDirectBundler). Never throws (a failure must never keep the site from starting);
 * returns what happened, as a code only, for one log line.
 */
export async function provisionPaymasterKeysAtStart(deps: {
  db: Database;
  env: Record<string, string | undefined>;
  now?: () => number;
  /** Whose keys, with `env` that chain's view of the settings (arc-env.ts). Default: Base's. */
  chainId?: number;
  /**
   * Where the mismatch line goes (paymasterKeysMismatchLogLine). Default: the console, like the
   * app's other ALERT lines: the app's Fastify logger is off in production, so app.log would drop it.
   */
  log?: (line: string) => void;
}): Promise<'off' | 'ready' | 'settings_mismatch' | 'keystore_unavailable' | 'failed'> {
  if (ownPaymasterMode(deps.env) === 'off') return 'off';
  try {
    const keys = await provisionPaymasterKeys(deps);
    const mismatch = paymasterKeySettingsMismatch(deps.env, keys);
    if (!mismatch) return 'ready';
    (deps.log ?? ((line: string) => console.error(line)))(
      paymasterKeysMismatchLogLine(mismatch, deps.chainId),
    );
    return 'settings_mismatch';
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
    if (!opsAuthorizedFor(request.headers.authorization, deps.env, 'keys'))
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
    // Public addresses only (CCA-716): keyRefs never leave the server.
    const address = (purpose: PaymasterKeyPurpose) => ({ address: keys.get(purpose)!.address });
    return {
      signer: address('paymaster_signer'),
      // The canary runs ONE submitter lane (submitter 1); submitter 2 is for the full rollout.
      submitters: [address('paymaster_submitter_1'), address('paymaster_submitter_2')],
    };
  });
}

/**
 * GET /api/public/paymaster: the read-only public projection (404 while the mode is off). Public
 * addresses only, of `chainId`'s own keys; never keyRefs; it creates nothing.
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
    path?: string;
  },
): void {
  app.get(deps.path ?? PAYMASTER_PUBLIC_PATH, async (_request, reply) => {
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
      keys = await provisionedPaymasterKeys(deps.db, deps.chainId);
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
      // Arc runs every lane: all of them, for the owner to allow and fund (each is used only once
      // the paymaster allows it and it holds gas).
      ...(chainFamily(deps.chainId) === 'arc'
        ? {
            submitters: (['paymaster_submitter_1', 'paymaster_submitter_2'] as const).flatMap(
              (purpose) => {
                const key = keys.get(purpose);
                return key ? [key.address] : [];
              },
            ),
          }
        : {}),
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
