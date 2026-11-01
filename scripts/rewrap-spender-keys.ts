import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rewrapTarget, type RewrapTarget } from './rewrap-target.js';
import type { Database, Transaction } from '../server/database.js';
import {
  parseKeks,
  parseKeyRef,
  rewrapStoredSpenderKey,
  type KeyEncryptionKeys,
} from '../server/base/chain/keystore.js';

/**
 * Retires an old CITY_BASE_SPENDER_KEK version (docs/base/ARCHITECTURE.md "Spender KEK"). Re-wraps
 * every agent spender key that is stored under an older version so it is under the current
 * (highest) one. Prints counts only, never ids, addresses, keys or database errors.
 *
 *   CITY_HOSTED=1 DATABASE_URL=… CITY_BASE_SPENDER_KEK=v1:<old>,v2:<new> \
 *     node --import tsx scripts/rewrap-spender-keys.ts            # dry run (default): counts only
 *   … scripts/rewrap-spender-keys.ts --confirm                    # re-wrap
 *
 * A key's ref is `v<version>:<keyId>` and both encryption layers bind the version, so a re-wrap
 * changes the ref. Only keys whose every reference is a `base_wallets.spender_key_ref` are
 * re-wrapped, and the key row and those wallet rows move together in one transaction. Keys held
 * by a service (the paymaster signer and submitters, the sponsor, the x402 facilitators: their
 * refs also live in deployment settings) are counted as "serviceKeys" and never touched here;
 * moving them needs a coordinated settings change (scripts/rewrap-service-key.ts, one at a time).
 * Keys no wallet references are "unreferenced" and skipped (rewrap-service-key.ts --orphans). A
 * worker that read a wallet's old ref just before the commit fails that one attempt ("Spender key
 * not found") and reads the new ref on its retry: run it at a quiet time.
 *
 * Fail closed (audit CCA-707): a service key that a wallet row also references is told apart only
 * by its setting, so a setting that is not loaded would make it look like a wallet key. While any
 * SERVICE_KEY_REF_SETTINGS entry is unset, empty or not a key ref, the run is refused: the output
 * carries "refused":true and the setting NAMES in "missingServiceRefs", nothing is written, and
 * the exit code is 1 (dry run too). Run it with the deployment's settings loaded; only when those
 * roles really hold no key in this deployment, add --allow-missing-service-refs.
 *
 * The target database and the KEK versions go to stderr first; DATABASE_URL without CITY_HOSTED=1
 * (or the reverse) is refused. A key that fails is counted as "failed" (exit 1) and the run
 * continues. Run --confirm until the dry run reports "walletKeys":0. Remove the old KEK version only when
 * "pending" is 0 as well (service keys moved by their own procedure) and
 * scripts/kek-retirement-check.ts passes (docs/KEY_ROLES_RUNBOOK.md, CCA-707).
 */

/** Deployment settings that hold a key ref outside the database. */
export const SERVICE_KEY_REF_SETTINGS = [
  'CITY_BASE_PAYMASTER_SIGNER_KEY_REF',
  'CITY_BASE_SUBMITTER_KEY_REFS',
  'CITY_SFP_SPONSOR_KEY_REF', // gitleaks:allow (a setting name, not a key)
  'CITY_X402_FACILITATOR_KEY_REF',
  'CITY_X402_PUBLIC_SETTLE_KEY_REF',
] as const;

/**
 * Arc's paymaster settings: optional, also where Arc is on (the recorded keys are the ones in use).
 * Arc's facilitator setting and the offers' public sender: optional, as most deployments have no such
 * key yet.
 * When set they count like the list above; unset is never "not loaded".
 */
export const OPTIONAL_SERVICE_KEY_REF_SETTINGS = [
  'CITY_ARC_PAYMASTER_SIGNER_KEY_REF',
  'CITY_ARC_SUBMITTER_KEY_REFS',
  'CITY_ARC_FACILITATOR_KEY_REF',
  'CITY_X402_PUBLIC_OFFER_KEY_REF',
] as const;

/** Every setting that can name a service key. */
export const ALL_SERVICE_KEY_REF_SETTINGS = [
  ...SERVICE_KEY_REF_SETTINGS,
  ...OPTIONAL_SERVICE_KEY_REF_SETTINGS,
] as const;

/** Tables whose key_ref column records a service key (each mirrored in a setting above). */
export const SERVICE_KEY_TABLES = [
  'own_paymaster_keys',
  'feed_pay_sponsor_key',
  'x402_facilitator_key',
] as const;

/** The key ids named by the service settings (comma-separated lists allowed); malformed refs are ignored. */
export function serviceKeyIdsFromEnv(env: Record<string, string | undefined>): Set<string> {
  const ids = new Set<string>();
  for (const name of ALL_SERVICE_KEY_REF_SETTINGS)
    for (const part of (env[name] ?? '').split(',')) {
      const ref = part.trim();
      if (!ref) continue;
      try {
        ids.add(parseKeyRef(ref).keyId);
      } catch {
        // Not a keystore ref: nothing to protect.
      }
    }
  return ids;
}

/**
 * The service settings that do not name a usable key ref here (unset, empty, or any part not a
 * keystore ref). Names only, never values. Non-empty means a service key could pass for a wallet key.
 */
export function missingServiceKeyRefSettings(env: Record<string, string | undefined>): string[] {
  const optional: readonly string[] = OPTIONAL_SERVICE_KEY_REF_SETTINGS;
  return ALL_SERVICE_KEY_REF_SETTINGS.filter((name) => {
    const refs = (env[name] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (!refs.length) return !optional.includes(name);
    return refs.some((ref) => {
      try {
        parseKeyRef(ref);
        return false;
      } catch {
        return true;
      }
    });
  });
}

export type SpenderKeyClass = 'current' | 'wallet' | 'service' | 'unreferenced' | 'unknownKek';

/** What the script does with one stored key. Pure: decides from the ids and refs it is given. */
export function classifySpenderKey(
  key: { keyId: string; kekVersion: number },
  context: {
    keks: KeyEncryptionKeys;
    /** Every base_wallets.spender_key_ref pointing at this key id (any version). */
    walletRefs: readonly string[];
    serviceKeyIds: ReadonlySet<string>;
  },
): SpenderKeyClass {
  if (key.kekVersion === context.keks.current) return 'current';
  if (context.serviceKeyIds.has(key.keyId)) return 'service';
  if (!context.keks.keys.has(key.kekVersion)) return 'unknownKek';
  const exact = `v${key.kekVersion}:${key.keyId}`;
  if (!context.walletRefs.length) return 'unreferenced';
  // A wallet ref under another version than the row would already be broken: never "fix" it here.
  if (context.walletRefs.some((ref) => ref !== exact)) return 'unreferenced';
  return 'wallet';
}

export interface SpenderRewrapCounts {
  pending: number;
  walletKeys: number;
  serviceKeys: number;
  unreferenced: number;
  unknownKek: number;
  rewrapped: number;
  /** Keys whose re-wrap threw (for example a corrupt row): skipped, the run continues. */
  failed: number;
  dryRun: boolean;
  /** Service settings not loaded (names only); see missingServiceKeyRefSettings. */
  missingServiceRefs: string[];
  /** True when missingServiceRefs is non-empty and not explicitly allowed: nothing was written. */
  refused: boolean;
}

type Db = Pick<Database, 'query' | 'transaction'>;

async function serviceKeyIds(
  db: Pick<Transaction, 'query'>,
  env: Record<string, string | undefined>,
): Promise<Set<string>> {
  const ids = serviceKeyIdsFromEnv(env);
  for (const table of SERVICE_KEY_TABLES) {
    const exists = await db.query<{ t: string | null }>('SELECT to_regclass($1)::text AS t', [
      table,
    ]);
    if (!exists.rows[0]?.t) continue;
    const { rows } = await db.query<{ key_ref: string }>(`SELECT key_ref FROM ${table}`);
    for (const { key_ref } of rows) {
      try {
        ids.add(parseKeyRef(key_ref).keyId);
      } catch {
        // A malformed recorded ref protects nothing and is not ours to change.
      }
    }
  }
  return ids;
}

async function walletRefsOf(db: Pick<Transaction, 'query'>, keyId: string, lock: boolean) {
  const { rows } = await db.query<{ spender_key_ref: string }>(
    `SELECT spender_key_ref FROM base_wallets WHERE spender_key_ref LIKE '%:' || $1${
      lock ? ' FOR UPDATE' : ''
    }`,
    [keyId],
  );
  return rows.map((row) => row.spender_key_ref);
}

export async function rewrapSpenderKeys(
  db: Db,
  keks: KeyEncryptionKeys,
  options: {
    confirm?: boolean;
    env?: Record<string, string | undefined>;
    /** The operator states the missing service settings hold no key here (--allow-missing-service-refs). */
    allowMissingServiceRefs?: boolean;
  } = {},
): Promise<SpenderRewrapCounts> {
  const env = options.env ?? {};
  const missingServiceRefs = missingServiceKeyRefSettings(env);
  const refused = missingServiceRefs.length > 0 && !options.allowMissingServiceRefs;
  const keys = (
    await db.query<{ key_id: string; kek_version: number }>(
      `SELECT key_id, kek_version FROM base_spender_keys
        WHERE kek_version <> $1 AND committed_at IS NOT NULL ORDER BY key_id`,
      [keks.current],
    )
  ).rows;
  const services = await serviceKeyIds(db, env);
  const counts: SpenderRewrapCounts = {
    pending: keys.length,
    walletKeys: 0,
    serviceKeys: 0,
    unreferenced: 0,
    unknownKek: 0,
    rewrapped: 0,
    failed: 0,
    dryRun: !options.confirm,
    missingServiceRefs,
    refused,
  };
  const movable: string[] = [];
  for (const key of keys) {
    const kind = classifySpenderKey(
      { keyId: key.key_id, kekVersion: key.kek_version },
      { keks, walletRefs: await walletRefsOf(db, key.key_id, false), serviceKeyIds: services },
    );
    if (kind === 'wallet') {
      counts.walletKeys++;
      movable.push(key.key_id);
    } else if (kind === 'service') counts.serviceKeys++;
    else if (kind === 'unreferenced') counts.unreferenced++;
    else if (kind === 'unknownKek') counts.unknownKek++;
  }
  // Refused: the counts are reported (walletKeys may include a service key), nothing is written.
  if (!options.confirm || refused) return counts;
  for (const keyId of movable) {
    // One key that cannot be re-wrapped is counted and skipped; the run goes on.
    const done = await db
      .transaction(async (tx) => {
        const row = (
          await tx.query<{
            key_id: string;
            kek_version: number;
            wrapped_dek: Uint8Array;
            ciphertext: Uint8Array;
            signer_address: string;
          }>(
            `SELECT key_id, kek_version, wrapped_dek, ciphertext, signer_address FROM base_spender_keys
            WHERE key_id = $1 AND kek_version <> $2 FOR UPDATE`,
            [keyId, keks.current],
          )
        ).rows[0];
        if (!row) return false;
        // Re-checked under the locks: still only wallet references, still not a service key.
        const refs = await walletRefsOf(tx, keyId, true);
        const kind = classifySpenderKey(
          { keyId, kekVersion: row.kek_version },
          { keks, walletRefs: refs, serviceKeyIds: await serviceKeyIds(tx, env) },
        );
        if (kind !== 'wallet') return false;
        const next = rewrapStoredSpenderKey(
          {
            keyId,
            kekVersion: row.kek_version,
            wrappedDek: new Uint8Array(row.wrapped_dek),
            ciphertext: new Uint8Array(row.ciphertext),
            signerAddress: row.signer_address as `0x${string}`,
          },
          keks,
        );
        await tx.query(
          'UPDATE base_spender_keys SET kek_version = $2, wrapped_dek = $3, ciphertext = $4 WHERE key_id = $1',
          [keyId, next.kekVersion, Buffer.from(next.wrappedDek), Buffer.from(next.ciphertext)],
        );
        await tx.query('UPDATE base_wallets SET spender_key_ref = $2 WHERE spender_key_ref = $1', [
          `v${row.kek_version}:${keyId}`,
          next.keyRef,
        ]);
        return true;
      })
      .catch(() => 'failed' as const);
    if (done === 'failed') counts.failed++;
    else if (done) counts.rewrapped++;
  }
  return counts;
}

async function main(argv: string[]): Promise<void> {
  const flags = ['--confirm', '--dry-run', '--allow-missing-service-refs'];
  const unknown = argv.filter((arg) => !flags.includes(arg));
  if (unknown.length || (argv.includes('--confirm') && argv.includes('--dry-run'))) {
    console.error(
      'Usage: rewrap-spender-keys.ts [--dry-run (default) | --confirm] [--allow-missing-service-refs]',
    );
    process.exit(1);
  }
  let target: RewrapTarget;
  try {
    target = rewrapTarget(process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  let keks: KeyEncryptionKeys;
  try {
    keks = parseKeks(process.env.CITY_BASE_SPENDER_KEK);
  } catch {
    console.error('CITY_BASE_SPENDER_KEK unavailable or malformed; nothing was changed.');
    process.exit(1);
  }
  if (keks.keys.size < 2) {
    console.error('CITY_BASE_SPENDER_KEK lists one version only; nothing to re-wrap from.');
    process.exit(1);
  }
  const { openPostgres } = await import('../server/database.js');
  const { loadHostedConfig } = await import('../server/hosted.js');
  const { acquireDataLock } = await import('../server/data-lock.js');
  let db: Db & { close(): Promise<void> };
  let release: (() => Promise<void>) | undefined;
  if (target.hosted)
    db = (await openPostgres(loadHostedConfig().databaseUrl)) as unknown as typeof db;
  else {
    const lock = await acquireDataLock(target.dataDir);
    const { PGlite } = await import('@electric-sql/pglite');
    db = (await PGlite.create(lock.dataDir)) as unknown as typeof db;
    release = () => lock.release();
  }
  // On stderr, so stdout stays the JSON counts. Key ids and versions are public fingerprints.
  console.error(
    `target: ${target.description}; current KEK v${keks.current}; versions ${[...keks.keys.keys()]
      .sort((a, b) => a - b)
      .map((v) => `v${v}`)
      .join(',')}`,
  );
  try {
    const counts = await rewrapSpenderKeys(db, keks, {
      confirm: argv.includes('--confirm'),
      env: process.env,
      allowMissingServiceRefs: argv.includes('--allow-missing-service-refs'),
    });
    console.log(JSON.stringify(counts));
    if (counts.refused) {
      console.error(
        `Service key ref settings not loaded: ${counts.missingServiceRefs.join(', ')}. A service ` +
          'key could pass for a wallet key; nothing was changed. Load the deployment settings, or ' +
          'add --allow-missing-service-refs only if those roles hold no key here.',
      );
      process.exitCode = 1;
    }
    if (counts.failed > 0) process.exitCode = 1;
  } catch {
    console.error('Spender key re-wrap failed; keys already re-wrapped stay valid. Re-run it.');
    process.exitCode = 1;
  } finally {
    await db.close();
    await release?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2));
