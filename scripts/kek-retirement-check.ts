import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rewrapTarget, type RewrapTarget } from './rewrap-target.js';
import type { Database, Transaction } from '../server/database.js';
import { parseKeyRef } from '../server/base/chain/keystore.js';
import {
  missingServiceKeyRefSettings,
  ALL_SERVICE_KEY_REF_SETTINGS,
  SERVICE_KEY_TABLES,
} from './rewrap-spender-keys.js';

/**
 * Pre-retirement gate for an old CITY_BASE_SPENDER_KEK version (audit CCA-707,
 * docs/KEY_ROLES_RUNBOOK.md "CCA-707: retiring an old spender KEK version"). Read-only: one
 * READ ONLY transaction, no key material selected, nothing decrypted, nothing written, and the
 * KEK itself is never read. Prints counts, table names, role purposes and setting NAMES only,
 * never key ids, refs, addresses, setting values or database errors.
 *
 *   CITY_HOSTED=1 DATABASE_URL=… <the service key ref settings> \
 *     node --import tsx scripts/kek-retirement-check.ts v1
 *
 * It counts everything still bound to the version: sealed rows in base_spender_keys (by kind:
 * wallet, service, uncommitted, unreferenced), base_wallets refs, the service key tables
 * (own_paymaster_keys, feed_pay_sponsor_key, x402_facilitator_key: per table and purpose) and the
 * service key ref settings that point at it (by name). A ref counts when it names the version, or
 * names a key whose row is sealed under it.
 *
 * Exit 0 and "SAFE TO RETIRE v<N>" only when all of those are zero. Anything else exits 1 with
 * "NOT SAFE TO RETIRE v<N>", and so does every case it cannot decide (fail closed): a read error,
 * a missing base table, a table holding a key ref or sealed column it does not know, a malformed
 * recorded ref, or a service setting that is unset or not a key ref (unless
 * --allow-missing-service-refs states that role holds no key in this deployment).
 *
 * CITY_RESPONDER_KEK (responder_credentials) and CITY_PII_KEK (elric_age_checks) are separate key
 * rings with their own rotation (docs/RESPONDER.md, docs/GOOGLE_SIGNIN.md), and base_owner_vaults
 * is sealed by each owner's password: listed as "otherKeyRings", never counted here.
 */

/** Tables whose columns hold spender keys or refs to them; everything the gate counts. */
export const SPENDER_KEY_TABLE = 'base_spender_keys';
export const WALLET_REF_TABLE = 'base_wallets';

/** Tables sealed under another key ring: known, not bound to CITY_BASE_SPENDER_KEK. */
export const OTHER_KEY_RING_TABLES = {
  responder_credentials: 'CITY_RESPONDER_KEK',
  elric_age_checks: 'CITY_PII_KEK',
  base_owner_vaults: 'owner password',
} as const;

const KNOWN_TABLES: ReadonlySet<string> = new Set([
  SPENDER_KEY_TABLE,
  WALLET_REF_TABLE,
  ...SERVICE_KEY_TABLES,
  ...Object.keys(OTHER_KEY_RING_TABLES),
]);

/** Column names that hold a key ref or sealed key material, in any table. */
export const SEALED_COLUMN_PATTERN = '(kek|dek|key_ref|ciphertext|encrypted|sealed|wrapped)';

export type RetirementReason =
  | 'read_error'
  | 'missing_tables'
  | 'unknown_tables'
  | 'malformed_refs'
  | 'missing_service_refs'
  | 'sealed_keys'
  | 'wallet_refs'
  | 'service_rows'
  | 'settings';

export interface KekRetirementReport {
  version: number;
  safeToRetire: boolean;
  /** Why it is not safe (empty when safe). */
  reasons: RetirementReason[];
  /** base_spender_keys rows sealed under the version, by what holds them. */
  sealedKeys: {
    total: number;
    wallet: number;
    service: number;
    uncommitted: number;
    unreferenced: number;
  };
  /** base_wallets rows whose spender_key_ref is bound to the version. */
  walletRefs: number;
  /** Per service table: present, rows bound to the version and their purposes (role names). */
  serviceTables: Record<string, { present: boolean; rows: number; purposes: string[] }>;
  /** Service key ref settings (names only) that point at the version. */
  settings: string[];
  /** Service settings unset, empty or not a key ref (names only). */
  missingServiceRefs: string[];
  /** Tables holding a recorded ref that is not a key ref (base_wallets and the service tables). */
  malformedRefs: string[];
  /** How many such refs per table (counts only, never the values). */
  malformedRefCounts: Record<string, number>;
  /** Base tables that are absent (wrong database?). */
  missingTables: string[];
  /** Tables with a key ref or sealed column that this gate does not know. */
  unknownTables: string[];
  /** Known tables sealed under another key ring, present in this database. */
  otherKeyRings: string[];
  /** Committed and uncommitted spender keys per KEK version (counts only). */
  versions: Record<string, number>;
}

/** `v1` or `1` → 1; anything else throws. */
export function parseRetireVersion(arg: string | undefined): number {
  const match = /^v?([1-9][0-9]{0,5})$/.exec((arg ?? '').trim());
  if (!match) throw new Error('Version must look like v1.');
  return Number(match[1]);
}

function emptyReport(version: number): KekRetirementReport {
  return {
    version,
    safeToRetire: false,
    reasons: [],
    sealedKeys: { total: 0, wallet: 0, service: 0, uncommitted: 0, unreferenced: 0 },
    walletRefs: 0,
    serviceTables: Object.fromEntries(
      SERVICE_KEY_TABLES.map((table) => [table, { present: false, rows: 0, purposes: [] }]),
    ),
    settings: [],
    missingServiceRefs: [],
    malformedRefs: [],
    malformedRefCounts: {},
    missingTables: [],
    unknownTables: [],
    otherKeyRings: [],
    versions: {},
  };
}

async function inventory(
  tx: Pick<Transaction, 'query'>,
  report: KekRetirementReport,
  env: Record<string, string | undefined>,
): Promise<void> {
  const version = report.version;
  // Every table that holds a key ref or a sealed column must be one the gate knows.
  const columns = await tx.query<{ table_name: string }>(
    `SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        AND column_name ~ $1 ORDER BY table_name`,
    [SEALED_COLUMN_PATTERN],
  );
  const present = new Set(columns.rows.map((row) => row.table_name));
  report.unknownTables = [...present].filter((table) => !KNOWN_TABLES.has(table)).sort();
  report.otherKeyRings = Object.keys(OTHER_KEY_RING_TABLES).filter((table) => present.has(table));
  const exists = async (table: string) =>
    Boolean(
      (await tx.query<{ t: string | null }>('SELECT to_regclass($1)::text AS t', [table])).rows[0]
        ?.t,
    );
  for (const table of [SPENDER_KEY_TABLE, WALLET_REF_TABLE])
    if (!(await exists(table))) report.missingTables.push(table);
  if (report.missingTables.length) return;

  for (const row of (
    await tx.query<{ kek_version: number; n: number }>(
      `SELECT kek_version, count(*)::int AS n FROM ${SPENDER_KEY_TABLE}
        GROUP BY kek_version ORDER BY kek_version`,
    )
  ).rows)
    report.versions[`v${row.kek_version}`] = Number(row.n);

  // The sealed rows on the version: ids and flags only, never wrapped_dek or ciphertext.
  const sealed = (
    await tx.query<{ key_id: string; committed: boolean; has_wallet: boolean }>(
      `SELECT k.key_id, k.committed_at IS NOT NULL AS committed,
              EXISTS (SELECT 1 FROM ${WALLET_REF_TABLE} w
                       WHERE split_part(w.spender_key_ref, ':', 2) = k.key_id) AS has_wallet
         FROM ${SPENDER_KEY_TABLE} k WHERE k.kek_version = $1`,
      [version],
    )
  ).rows;
  const onVersion = new Set(sealed.map((row) => row.key_id));
  const boundToVersion = (ref: { kekVersion: number; keyId: string }) =>
    ref.kekVersion === version || onVersion.has(ref.keyId);

  const malformed = (table: string) => {
    if (!report.malformedRefs.includes(table)) report.malformedRefs.push(table);
    report.malformedRefCounts[table] = (report.malformedRefCounts[table] ?? 0) + 1;
  };

  // Every recorded wallet ref is validated with the keystore's own parser, like the service rows:
  // a ref that does not parse cannot be placed on a version, so the gate refuses (never its value).
  const walletRows = await tx.query<{ spender_key_ref: string }>(
    `SELECT spender_key_ref FROM ${WALLET_REF_TABLE} WHERE spender_key_ref IS NOT NULL`,
  );
  for (const { spender_key_ref } of walletRows.rows) {
    let ref: { kekVersion: number; keyId: string };
    try {
      ref = parseKeyRef(spender_key_ref);
    } catch {
      malformed(WALLET_REF_TABLE);
      continue;
    }
    if (boundToVersion(ref)) report.walletRefs++;
  }

  // Service keys: every key a service table records or a service setting names (any version).
  const serviceIds = new Set<string>();
  for (const table of SERVICE_KEY_TABLES) {
    if (!(await exists(table))) continue;
    const entry = { present: true, rows: 0, purposes: [] as string[] };
    report.serviceTables[table] = entry;
    const { rows } = await tx.query<{ purpose: string; key_ref: string }>(
      `SELECT purpose, key_ref FROM ${table} ORDER BY purpose`,
    );
    for (const row of rows) {
      let ref: { kekVersion: number; keyId: string };
      try {
        ref = parseKeyRef(row.key_ref);
      } catch {
        malformed(table);
        continue;
      }
      serviceIds.add(ref.keyId);
      if (boundToVersion(ref)) {
        entry.rows++;
        entry.purposes.push(row.purpose);
      }
    }
  }
  report.missingServiceRefs = missingServiceKeyRefSettings(env);
  for (const name of ALL_SERVICE_KEY_REF_SETTINGS)
    for (const part of (env[name] ?? '').split(',')) {
      try {
        const ref = parseKeyRef(part.trim());
        serviceIds.add(ref.keyId);
        if (boundToVersion(ref) && !report.settings.includes(name)) report.settings.push(name);
      } catch {
        // Named in missingServiceRefs.
      }
    }

  for (const row of sealed) {
    report.sealedKeys.total++;
    if (serviceIds.has(row.key_id)) report.sealedKeys.service++;
    else if (row.has_wallet) report.sealedKeys.wallet++;
    else if (!row.committed) report.sealedKeys.uncommitted++;
    else report.sealedKeys.unreferenced++;
  }
}

/**
 * The read-only inventory and verdict for retiring `version`. Never throws: a read error is a
 * NOT SAFE verdict with reason "read_error" (the error itself is not reported).
 */
export async function checkKekRetirement(
  db: Pick<Database, 'transaction'>,
  version: number,
  options: {
    env?: Record<string, string | undefined>;
    /** The operator states the missing service settings hold no key here. */
    allowMissingServiceRefs?: boolean;
  } = {},
): Promise<KekRetirementReport> {
  let report = emptyReport(version);
  try {
    await db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY');
      await inventory(tx, report, options.env ?? {});
    });
  } catch {
    report = { ...emptyReport(version), reasons: ['read_error'] };
    return report;
  }
  const reasons: RetirementReason[] = [];
  if (report.missingTables.length) reasons.push('missing_tables');
  if (report.unknownTables.length) reasons.push('unknown_tables');
  if (report.malformedRefs.length) reasons.push('malformed_refs');
  if (report.missingServiceRefs.length && !options.allowMissingServiceRefs)
    reasons.push('missing_service_refs');
  if (report.sealedKeys.total) reasons.push('sealed_keys');
  if (report.walletRefs) reasons.push('wallet_refs');
  if (Object.values(report.serviceTables).some((entry) => entry.rows)) reasons.push('service_rows');
  if (report.settings.length) reasons.push('settings');
  report.reasons = reasons;
  report.safeToRetire = reasons.length === 0;
  return report;
}

export function verdictLine(report: KekRetirementReport): string {
  return report.safeToRetire
    ? `SAFE TO RETIRE v${report.version}: no key, ref or setting is bound to it.`
    : `NOT SAFE TO RETIRE v${report.version}: ${report.reasons.join(', ')}. Keep it in CITY_BASE_SPENDER_KEK.`;
}

async function main(argv: string[]): Promise<void> {
  const flags = ['--allow-missing-service-refs'];
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const unknown = argv.filter((arg) => arg.startsWith('--') && !flags.includes(arg));
  let version: number;
  try {
    if (unknown.length || positional.length !== 1) throw new Error('usage');
    version = parseRetireVersion(positional[0]);
  } catch {
    console.error('Usage: kek-retirement-check.ts v<version> [--allow-missing-service-refs]');
    process.exit(1);
  }
  // The same target rule as the re-wrap scripts: a gate run against the wrong database would
  // report SAFE for a database that holds nothing.
  let target: RewrapTarget;
  try {
    target = rewrapTarget(process.env);
  } catch (error) {
    console.error(`NOT SAFE TO RETIRE v${version}: ${(error as Error).message}`);
    process.exit(1);
  }
  console.error(`target: ${target.description}`);
  const { openPostgres } = await import('../server/database.js');
  const { loadHostedConfig } = await import('../server/hosted.js');
  const { acquireDataLock } = await import('../server/data-lock.js');
  let db: Pick<Database, 'transaction'> & { close(): Promise<void> };
  let release: (() => Promise<void>) | undefined;
  try {
    if (target.hosted)
      db = (await openPostgres(loadHostedConfig().databaseUrl)) as unknown as typeof db;
    else {
      const lock = await acquireDataLock(target.dataDir);
      const { PGlite } = await import('@electric-sql/pglite');
      db = (await PGlite.create(lock.dataDir)) as unknown as typeof db;
      release = () => lock.release();
    }
  } catch {
    console.error(`NOT SAFE TO RETIRE v${version}: read_error (database unavailable).`);
    process.exit(1);
  }
  try {
    const report = await checkKekRetirement(db, version, {
      env: process.env,
      allowMissingServiceRefs: argv.includes('--allow-missing-service-refs'),
    });
    console.log(JSON.stringify(report));
    console.log(verdictLine(report));
    process.exitCode = report.safeToRetire ? 0 : 1;
  } finally {
    await db.close().catch(() => {});
    await release?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2));
