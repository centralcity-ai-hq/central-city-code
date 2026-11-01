import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rewrapTarget, type RewrapTarget } from './rewrap-target.js';
import type { Database, Transaction } from '../server/database.js';
import {
  createKeystore,
  parseKeks,
  parseKeyRef,
  rewrapStoredSpenderKey,
  type KeyEncryptionKeys,
  type StoredSpenderKey,
} from '../server/base/chain/keystore.js';
import {
  missingServiceKeyRefSettings,
  ALL_SERVICE_KEY_REF_SETTINGS,
  SERVICE_KEY_TABLES,
} from './rewrap-spender-keys.js';

/**
 * Moves ONE service key to the current CITY_BASE_SPENDER_KEK version in place (audit CCA-707,
 * docs/KEY_ROLES_RUNBOOK.md "CCA-707: retiring an old spender KEK version", step 4), and reports
 * the keys nobody references (step 5). An owner step: it needs the deployment's settings and KEK.
 *
 *   … node --import tsx scripts/rewrap-service-key.ts --service CITY_SFP_SPONSOR_KEY_REF   # dry run
 *   … scripts/rewrap-service-key.ts --service CITY_SFP_SPONSOR_KEY_REF --confirm          # move it
 *   … scripts/rewrap-service-key.ts --service CITY_BASE_SUBMITTER_KEY_REFS --index 2 --confirm
 *   … scripts/rewrap-service-key.ts --orphans [--version v1] [--show-addresses]           # report
 *
 * Service mode: the key the named setting points at (entry --index of a list) is opened with its
 * old version and sealed again under the current one INSIDE this process, in one transaction with
 * its service table row (if the role has one): same key, same address, only the ref's version
 * changes. The decrypted key's address is checked against the stored address (and the table's)
 * before the write, the new seal is opened and checked before the write, and the written row is
 * read back and checked again; any mismatch or error rolls the whole transaction back. Dry run
 * (default) does every check in a read-only transaction and writes nothing.
 *
 * Refused (exit 1, nothing written): an unknown setting name; the setting unset, empty or not a
 * key ref; any other service setting not loaded (unless --allow-missing-service-refs); a key a
 * wallet references (that is scripts/rewrap-spender-keys.ts's job); a key another role also
 * names; a setting and table row that disagree; an uncommitted key; a target version (--to) that
 * is not the configured current one; an old version not configured.
 *
 * Key refs are never printed (they are not logged anywhere in the app): the output says how the
 * setting must change ("same value, prefix v<N>: becomes v<M>:"); the new ref is also in the
 * role's table row. Never prints key material, key ids or addresses (except --show-addresses in
 * orphan mode: public signer addresses only, so the owner can check their balances).
 *
 * Orphan mode is report-only: it never re-seals and never deletes. The owner decides per key.
 */

type Setting = (typeof ALL_SERVICE_KEY_REF_SETTINGS)[number];

/** Each service setting's table and the purposes its rows carry there. */
export const SERVICE_ROLES: Readonly<
  Record<Setting, { table: (typeof SERVICE_KEY_TABLES)[number]; purposes: readonly string[] }>
> = Object.freeze({
  CITY_BASE_PAYMASTER_SIGNER_KEY_REF: {
    table: 'own_paymaster_keys',
    purposes: ['paymaster_signer'],
  },
  CITY_BASE_SUBMITTER_KEY_REFS: {
    table: 'own_paymaster_keys',
    purposes: ['paymaster_submitter_1', 'paymaster_submitter_2'],
  },
  CITY_ARC_PAYMASTER_SIGNER_KEY_REF: {
    table: 'own_paymaster_keys',
    purposes: ['arc_paymaster_signer'],
  },
  CITY_ARC_SUBMITTER_KEY_REFS: {
    table: 'own_paymaster_keys',
    purposes: ['arc_paymaster_submitter_1', 'arc_paymaster_submitter_2'],
  },
  CITY_ARC_FACILITATOR_KEY_REF: { table: 'x402_facilitator_key', purposes: ['arc-router3'] },
  CITY_SFP_SPONSOR_KEY_REF: { table: 'feed_pay_sponsor_key', purposes: ['sfp_sponsor'] },
  CITY_X402_FACILITATOR_KEY_REF: { table: 'x402_facilitator_key', purposes: ['router3'] },
  CITY_X402_PUBLIC_SETTLE_KEY_REF: { table: 'x402_facilitator_key', purposes: ['public-settle'] },
  CITY_X402_PUBLIC_OFFER_KEY_REF: { table: 'x402_facilitator_key', purposes: ['public-offer'] },
});

export type ServiceRewrapRefusal =
  | 'unknown_setting'
  | 'setting_not_loaded'
  | 'index_required'
  | 'index_out_of_range'
  | 'service_settings_not_loaded'
  | 'target_not_current'
  | 'target_kek_unavailable'
  | 'old_kek_unavailable'
  | 'key_not_found'
  | 'uncommitted'
  | 'wallet_referenced'
  | 'shared_with_other_role'
  | 'setting_table_mismatch'
  | 'ref_version_mismatch'
  | 'table_ref_stale'
  | 'address_mismatch'
  | 'open_failed'
  | 'failed';

export interface ServiceRewrapResult {
  mode: 'service';
  setting: string;
  dryRun: boolean;
  refused: boolean;
  reason: ServiceRewrapRefusal | null;
  /** Other service settings not loaded (names only). */
  missingServiceRefs: string[];
  fromVersion: number | null;
  toVersion: number | null;
  /** The role's table row moved with the key (null when the role has none here). */
  table: string | null;
  purpose: string | null;
  /** The key was already under the target version: nothing to move. */
  alreadyCurrent: boolean;
  /** Every address check passed (dry run: the move would succeed). */
  verified: boolean;
  /** The key row (and table row) were written. */
  moved: boolean;
  /** What the owner must change in the setting (never the value itself). */
  settingAction: string | null;
}

class Refusal extends Error {
  constructor(readonly code: ServiceRewrapRefusal) {
    super(code);
  }
}

type Db = Pick<Database, 'transaction'>;
type Tx = Pick<Transaction, 'query'>;

const refsOf = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function tableExists(tx: Tx, table: string): Promise<boolean> {
  return Boolean(
    (await tx.query<{ t: string | null }>('SELECT to_regclass($1)::text AS t', [table])).rows[0]?.t,
  );
}

interface KeyRow {
  key_id: string;
  kek_version: number;
  wrapped_dek: Uint8Array;
  ciphertext: Uint8Array;
  signer_address: string;
  committed_at: string | number | null;
}

async function readKey(tx: Tx, keyId: string, lock: boolean): Promise<KeyRow | undefined> {
  return (
    await tx.query<KeyRow>(
      `SELECT key_id, kek_version, wrapped_dek, ciphertext, signer_address, committed_at
         FROM base_spender_keys WHERE key_id = $1${lock ? ' FOR UPDATE' : ''}`,
      [keyId],
    )
  ).rows[0];
}

/** Opens a sealed row under `keks` inside this process; returns only the derived address. */
async function addressFromSeal(
  row: Pick<
    StoredSpenderKey,
    'keyId' | 'kekVersion' | 'wrappedDek' | 'ciphertext' | 'signerAddress'
  >,
  keks: KeyEncryptionKeys,
): Promise<string> {
  const keystore = createKeystore({
    keks,
    store: {
      insert: async () => {
        throw new Error('read only');
      },
      get: async () => ({ ...row, createdAt: 0, committedAt: 0 }),
    },
  });
  // withSigner also refuses when the opened key does not derive the stored address.
  return keystore.withSigner(`v${row.kekVersion}:${row.keyId}`, async (signer) => signer.address);
}

export async function rewrapServiceKey(
  db: Db,
  keks: KeyEncryptionKeys,
  options: {
    setting: string;
    /** 1-based entry of a list setting (CITY_BASE_SUBMITTER_KEY_REFS); required when it lists several. */
    index?: number;
    /** The version to move to; must be the configured current (highest) one. */
    to?: number;
    confirm?: boolean;
    env?: Record<string, string | undefined>;
    allowMissingServiceRefs?: boolean;
  },
): Promise<ServiceRewrapResult> {
  const env = options.env ?? {};
  const result: ServiceRewrapResult = {
    mode: 'service',
    setting: options.setting,
    dryRun: !options.confirm,
    refused: false,
    reason: null,
    missingServiceRefs: [],
    fromVersion: null,
    toVersion: keks.current,
    table: null,
    purpose: null,
    alreadyCurrent: false,
    verified: false,
    moved: false,
    settingAction: null,
  };
  const refuse = (code: ServiceRewrapRefusal) => {
    result.refused = true;
    result.reason = code;
    result.verified = false;
    result.moved = false;
    return result;
  };
  if (!(ALL_SERVICE_KEY_REF_SETTINGS as readonly string[]).includes(options.setting))
    return refuse('unknown_setting');
  const setting = options.setting as Setting;
  const role = SERVICE_ROLES[setting];
  if (options.to !== undefined) {
    if (!keks.keys.has(options.to)) return refuse('target_kek_unavailable');
    if (options.to !== keks.current) return refuse('target_not_current');
  }
  const refs = refsOf(env[setting]);
  let parsed: { kekVersion: number; keyId: string }[];
  try {
    parsed = refs.map((ref) => parseKeyRef(ref));
  } catch {
    return refuse('setting_not_loaded');
  }
  if (!parsed.length) return refuse('setting_not_loaded');
  if (parsed.length > 1 && options.index === undefined) return refuse('index_required');
  const index = options.index ?? 1;
  if (!Number.isInteger(index) || index < 1 || index > parsed.length)
    return refuse('index_out_of_range');
  const chosen = parsed[index - 1]!;
  result.missingServiceRefs = missingServiceKeyRefSettings(env);
  if (result.missingServiceRefs.length && !options.allowMissingServiceRefs)
    return refuse('service_settings_not_loaded');
  // A key another role's setting also names would break that role: fail closed.
  for (const other of ALL_SERVICE_KEY_REF_SETTINGS) {
    const otherRefs = refsOf(env[other]).flatMap((ref) => {
      try {
        return [parseKeyRef(ref).keyId];
      } catch {
        return [];
      }
    });
    const hits = otherRefs.filter((id) => id === chosen.keyId).length;
    if (other === setting ? hits > 1 : hits > 0) return refuse('shared_with_other_role');
  }

  try {
    await db.transaction(async (tx) => {
      if (!options.confirm) await tx.query('SET TRANSACTION READ ONLY');
      const row = await readKey(tx, chosen.keyId, Boolean(options.confirm));
      if (!row) throw new Refusal('key_not_found');
      result.fromVersion = row.kek_version;
      if (row.committed_at === null) throw new Refusal('uncommitted');
      const wallets = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM base_wallets WHERE split_part(spender_key_ref, ':', 2) = $1`,
        [chosen.keyId],
      );
      if (Number(wallets.rows[0]?.n ?? 0) > 0) throw new Refusal('wallet_referenced');

      // The role's own table row, and no other role's row on the same key.
      let own: { purpose: string; key_ref: string; address: string } | undefined;
      let roleHasRows = false;
      for (const table of SERVICE_KEY_TABLES) {
        if (!(await tableExists(tx, table))) continue;
        const { rows } = await tx.query<{ purpose: string; key_ref: string; address: string }>(
          `SELECT purpose, key_ref, address FROM ${table} ORDER BY purpose${
            options.confirm ? ' FOR UPDATE' : ''
          }`,
        );
        for (const entry of rows) {
          const mine = table === role.table && role.purposes.includes(entry.purpose);
          if (mine) roleHasRows = true;
          let keyId: string | null = null;
          try {
            keyId = parseKeyRef(entry.key_ref).keyId;
          } catch {
            if (mine) throw new Refusal('setting_table_mismatch');
          }
          if (keyId !== chosen.keyId) continue;
          if (!mine) throw new Refusal('shared_with_other_role');
          own = entry;
          result.table = table;
          result.purpose = entry.purpose;
        }
      }
      // The role has table rows, none of them on this key: setting and table disagree.
      if (!own && roleHasRows) throw new Refusal('setting_table_mismatch');
      if (own && !sameAddress(own.address, row.signer_address))
        throw new Refusal('address_mismatch');

      if (row.kek_version === keks.current) {
        result.alreadyCurrent = true;
        if (own && parseKeyRef(own.key_ref).kekVersion !== keks.current)
          throw new Refusal('table_ref_stale');
        return;
      }
      if (chosen.kekVersion !== row.kek_version) throw new Refusal('ref_version_mismatch');
      if (own && parseKeyRef(own.key_ref).kekVersion !== row.kek_version)
        throw new Refusal('ref_version_mismatch');
      if (!keks.keys.has(row.kek_version)) throw new Refusal('old_kek_unavailable');

      const stored: Pick<
        StoredSpenderKey,
        'keyId' | 'kekVersion' | 'wrappedDek' | 'ciphertext' | 'signerAddress'
      > = {
        keyId: row.key_id,
        kekVersion: row.kek_version,
        wrappedDek: new Uint8Array(row.wrapped_dek),
        ciphertext: new Uint8Array(row.ciphertext),
        signerAddress: row.signer_address as `0x${string}`,
      };
      let next: ReturnType<typeof rewrapStoredSpenderKey>;
      try {
        // Opens with the old version and checks the key derives the stored address.
        next = rewrapStoredSpenderKey(stored, keks);
      } catch (error) {
        throw new Refusal(
          error instanceof Error && /does not match/.test(error.message)
            ? 'address_mismatch'
            : 'open_failed',
        );
      }
      const check = async (sealed: typeof stored) => {
        let address: string;
        try {
          address = await addressFromSeal(sealed, keks);
        } catch {
          throw new Refusal('address_mismatch');
        }
        if (!sameAddress(address, row.signer_address)) throw new Refusal('address_mismatch');
      };
      // The new seal opens under the target version to the same address, before anything is written.
      await check({ ...stored, ...next });
      result.verified = true;
      if (!options.confirm) return;

      const updated = await tx.query<{ key_id: string }>(
        `UPDATE base_spender_keys SET kek_version = $3, wrapped_dek = $4, ciphertext = $5
          WHERE key_id = $1 AND kek_version = $2 RETURNING key_id`,
        [
          row.key_id,
          row.kek_version,
          next.kekVersion,
          Buffer.from(next.wrappedDek),
          Buffer.from(next.ciphertext),
        ],
      );
      if (updated.rows.length !== 1) throw new Refusal('failed');
      if (own) {
        const moved = await tx.query<{ purpose: string }>(
          `UPDATE ${result.table} SET key_ref = $3 WHERE purpose = $1 AND key_ref = $2 RETURNING purpose`,
          [own.purpose, own.key_ref, next.keyRef],
        );
        if (moved.rows.length !== 1) throw new Refusal('failed');
      }
      // Read back what was written and open it again: same key, same address.
      const written = await readKey(tx, row.key_id, false);
      if (!written || written.kek_version !== next.kekVersion) throw new Refusal('failed');
      await check({
        ...stored,
        kekVersion: written.kek_version,
        wrappedDek: new Uint8Array(written.wrapped_dek),
        ciphertext: new Uint8Array(written.ciphertext),
      });
      result.moved = true;
    });
  } catch (error) {
    return refuse(error instanceof Refusal ? error.code : 'failed');
  }
  if (chosen.kekVersion !== keks.current)
    result.settingAction =
      (result.dryRun && !result.alreadyCurrent
        ? 'Dry run, nothing written. After --confirm: '
        : '') +
      `Set ${setting} to its current value with ${
        parsed.length > 1 ? `entry ${index}'s ` : 'the '
      }prefix v${chosen.kekVersion}: changed to v${keks.current}: (same key id)` +
      (result.table ? `, as recorded in ${result.table} (${result.purpose})` : '') +
      ', then redeploy.';
  return result;
}

export interface OrphanReport {
  mode: 'orphans';
  refused: boolean;
  reason: 'service_settings_not_loaded' | 'failed' | null;
  missingServiceRefs: string[];
  /** Keys no wallet, service table or service setting references, per KEK version. */
  byVersion: Record<string, { committed: number; uncommitted: number }>;
  /** Public signer addresses of the committed ones (only with showAddresses and a version). */
  addresses?: string[];
}

/** Report-only: never re-seals, never deletes. The owner decides per key (runbook step 5). */
export async function reportOrphanKeys(
  db: Db,
  options: {
    env?: Record<string, string | undefined>;
    allowMissingServiceRefs?: boolean;
    version?: number;
    showAddresses?: boolean;
  } = {},
): Promise<OrphanReport> {
  const env = options.env ?? {};
  const report: OrphanReport = {
    mode: 'orphans',
    refused: false,
    reason: null,
    missingServiceRefs: missingServiceKeyRefSettings(env),
    byVersion: {},
  };
  if (report.missingServiceRefs.length && !options.allowMissingServiceRefs)
    return { ...report, refused: true, reason: 'service_settings_not_loaded' };
  const serviceIds = new Set<string>();
  for (const name of ALL_SERVICE_KEY_REF_SETTINGS)
    for (const ref of refsOf(env[name]))
      try {
        serviceIds.add(parseKeyRef(ref).keyId);
      } catch {
        // Named in missingServiceRefs.
      }
  try {
    await db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY');
      for (const table of SERVICE_KEY_TABLES) {
        if (!(await tableExists(tx, table))) continue;
        for (const { key_ref } of (
          await tx.query<{ key_ref: string }>(`SELECT key_ref FROM ${table}`)
        ).rows)
          try {
            serviceIds.add(parseKeyRef(key_ref).keyId);
          } catch {
            // Malformed: the gate refuses on it; nothing to report here.
          }
      }
      const { rows } = await tx.query<{
        key_id: string;
        kek_version: number;
        committed: boolean;
        signer_address: string;
      }>(
        `SELECT k.key_id, k.kek_version, k.committed_at IS NOT NULL AS committed, k.signer_address
           FROM base_spender_keys k
          WHERE NOT EXISTS (SELECT 1 FROM base_wallets w
                             WHERE split_part(w.spender_key_ref, ':', 2) = k.key_id)
          ORDER BY k.kek_version, k.signer_address`,
      );
      const addresses: string[] = [];
      for (const row of rows) {
        if (serviceIds.has(row.key_id)) continue;
        const entry = (report.byVersion[`v${row.kek_version}`] ??= {
          committed: 0,
          uncommitted: 0,
        });
        if (row.committed) entry.committed++;
        else entry.uncommitted++;
        if (row.committed && options.version === row.kek_version)
          addresses.push(row.signer_address);
      }
      if (options.showAddresses && options.version !== undefined) report.addresses = addresses;
    });
  } catch {
    return { ...report, byVersion: {}, refused: true, reason: 'failed' };
  }
  return report;
}

function usage(): never {
  console.error(
    'Usage: rewrap-service-key.ts --service <SETTING> [--index <n>] [--to v<M>] [--confirm] [--allow-missing-service-refs]\n' +
      '       rewrap-service-key.ts --orphans [--version v<N>] [--show-addresses] [--allow-missing-service-refs]',
  );
  process.exit(1);
}

const versionArg = (value: string | undefined) => {
  const match = /^v?([1-9][0-9]{0,5})$/.exec(value ?? '');
  if (!match) usage();
  return Number(match[1]);
};

async function main(argv: string[]): Promise<void> {
  const valued = ['--service', '--index', '--to', '--version'];
  const flags = ['--confirm', '--orphans', '--show-addresses', '--allow-missing-service-refs'];
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (valued.includes(arg)) {
      if (argv[i + 1] === undefined || arg in values) usage();
      values[arg] = argv[++i]!;
    } else if (!flags.includes(arg)) usage();
  }
  const orphans = argv.includes('--orphans');
  if (orphans === '--service' in values) usage();
  if (orphans && (argv.includes('--confirm') || '--index' in values || '--to' in values)) usage();
  if (!orphans && (argv.includes('--show-addresses') || '--version' in values)) usage();
  const index = '--index' in values ? Number(values['--index']) : undefined;
  if (index !== undefined && !/^[1-9][0-9]?$/.test(values['--index']!)) usage();
  const to = '--to' in values ? versionArg(values['--to']) : undefined;
  const version = '--version' in values ? versionArg(values['--version']) : undefined;

  let keks: KeyEncryptionKeys | undefined;
  if (!orphans) {
    try {
      keks = parseKeks(process.env.CITY_BASE_SPENDER_KEK);
    } catch {
      console.error('CITY_BASE_SPENDER_KEK unavailable or malformed; nothing was changed.');
      process.exit(1);
    }
  }
  let target: RewrapTarget;
  try {
    target = rewrapTarget(process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  // On stderr, so stdout stays the JSON result. Versions are public fingerprints.
  console.error(
    `target: ${target.description}${
      keks
        ? `; current KEK v${keks.current}; versions ${[...keks.keys.keys()]
            .sort((a, b) => a - b)
            .map((v) => `v${v}`)
            .join(',')}`
        : ''
    }`,
  );
  const { openPostgres } = await import('../server/database.js');
  const { loadHostedConfig } = await import('../server/hosted.js');
  const { acquireDataLock } = await import('../server/data-lock.js');
  let db: Db & { close(): Promise<void> };
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
    console.error('Database unavailable; nothing was changed.');
    process.exit(1);
  }
  try {
    const allowMissingServiceRefs = argv.includes('--allow-missing-service-refs');
    const out = orphans
      ? await reportOrphanKeys(db, {
          env: process.env,
          allowMissingServiceRefs,
          version,
          showAddresses: argv.includes('--show-addresses'),
        })
      : await rewrapServiceKey(db, keks!, {
          setting: values['--service']!,
          index,
          to,
          confirm: argv.includes('--confirm'),
          env: process.env,
          allowMissingServiceRefs,
        });
    console.log(JSON.stringify(out));
    if (out.mode === 'service' && out.settingAction) console.log(out.settingAction);
    process.exitCode = out.refused ? 1 : 0;
  } finally {
    await db.close().catch(() => {});
    await release?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2));
