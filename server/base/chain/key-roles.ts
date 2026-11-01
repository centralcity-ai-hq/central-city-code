/*
 * One key per role (audit CCA-714). The app holds keys for several unrelated jobs, and the owner
 * holds the treasury and the funding wallet. A key that serves two of them is used more often and
 * a single exposure reaches both, so:
 *
 *   roleKeyUsable              a role whose configured key ref is also configured for another
 *                              role is logged as ALERT; with CITY_KEY_ROLES_ENFORCE=1 the runtime
 *                              then does not build its signer (fail closed), without it the role
 *                              is built exactly as before (service continuity until the owner has
 *                              split the roles)
 *   checkKeyRolesAtStart       at start, resolves every configured role to its public address
 *                              (the keystore's signer_address column and own_paymaster_keys, never
 *                              key material) and logs an ALERT line for every two roles that share
 *                              an address; the treasury and the funding wallet are compared too.
 *                              It only ALERTs, never refuses
 *   arcPaymasterKeysUsable     Arc's paymaster keys are roles of their own. A key that any of Base's
 *                              roles also names is always refused on Arc, with or without
 *                              CITY_KEY_ROLES_ENFORCE: no key serves both chains. Base is untouched
 *   arcFacilitatorKeyUsable    the same for Arc's fee router 3 facilitator. Its setting never blocks
 *                              a role of Base: the refusal is Arc's alone
 *
 * Only setting NAMES, role names and public addresses are logged; never a key ref or a value of a
 * secret setting. Splitting roles that share a key is an owner action
 * (docs/KEY_ROLES_RUNBOOK.md).
 */
import type { Database } from '../../database.js';
import { protocolTreasuryFor } from '../../protocol/fees/cron.js';
import { parseKeyRef } from './keystore.js';

export type KeyRole =
  | 'paymaster_signer'
  | 'paymaster_submitter'
  | 'arc_paymaster_signer'
  | 'arc_paymaster_submitter'
  | 'arc_router3_facilitator'
  | 'router3_facilitator'
  | 'public_settle'
  | 'public_offer'
  | 'sfp_sponsor'
  | 'treasury'
  | 'funding';

/** The app-held roles and the settings that name their keys (comma-separated where several). */
export const KEY_REF_SETTINGS: Readonly<Record<Exclude<KeyRole, 'treasury' | 'funding'>, string>> =
  Object.freeze({
    paymaster_signer: 'CITY_BASE_PAYMASTER_SIGNER_KEY_REF',
    paymaster_submitter: 'CITY_BASE_SUBMITTER_KEY_REFS',
    arc_paymaster_signer: 'CITY_ARC_PAYMASTER_SIGNER_KEY_REF',
    arc_paymaster_submitter: 'CITY_ARC_SUBMITTER_KEY_REFS',
    arc_router3_facilitator: 'CITY_ARC_FACILITATOR_KEY_REF',
    router3_facilitator: 'CITY_X402_FACILITATOR_KEY_REF',
    public_settle: 'CITY_X402_PUBLIC_SETTLE_KEY_REF',
    public_offer: 'CITY_X402_PUBLIC_OFFER_KEY_REF',
    sfp_sponsor: 'CITY_SFP_SPONSOR_KEY_REF',
  });

/** The owner's low-balance wallet that tops up the app-held wallets (public address). */
export const FUNDING_WALLET_SETTING = 'CITY_FUNDING_WALLET_ADDRESS';

type AppRole = keyof typeof KEY_REF_SETTINGS;

const refsOf = (env: Record<string, string | undefined>, role: AppRole): string[] =>
  (env[KEY_REF_SETTINGS[role]] ?? '')
    .split(',')
    .map((ref) => ref.trim())
    .filter(Boolean);

const ARC_PAYMASTER_ROLES = ['arc_paymaster_signer', 'arc_paymaster_submitter'] as const;
const ARC_ROLES: readonly AppRole[] = [...ARC_PAYMASTER_ROLES, 'arc_router3_facilitator'];

/**
 * True when a key ref configured for `role` is also configured for another role. Arc's facilitator
 * doesn't count against a role of Base: that sharing is refused on Arc (arcFacilitatorKeyUsable).
 */
export function keyRefSharedWithOtherRole(
  env: Record<string, string | undefined>,
  role: AppRole,
): boolean {
  const own = new Set(refsOf(env, role));
  if (!own.size) return false;
  for (const other of Object.keys(KEY_REF_SETTINGS) as AppRole[]) {
    if (other === 'arc_router3_facilitator' && !ARC_ROLES.includes(role)) continue;
    if (other !== role && refsOf(env, other).some((ref) => own.has(ref))) return true;
  }
  return false;
}

/** Exactly '1' makes a shared key ref refuse its role; anything else only ALERTs. */
export const KEY_ROLES_ENFORCE_SETTING = 'CITY_KEY_ROLES_ENFORCE';

export function keyRolesEnforced(env: Record<string, string | undefined>): boolean {
  return env[KEY_ROLES_ENFORCE_SETTING]?.trim() === '1';
}

/**
 * Whether the runtime may build `role`'s signer. A key ref shared with another role is refused
 * only with CITY_KEY_ROLES_ENFORCE=1 (the last owner step, after the roles are split); without
 * it the role is built exactly as before. Either way the sharing is logged as ONE sanitized
 * ALERT line per role (setting and role names only) for each `reported` set.
 */
export function roleKeyUsable(
  env: Record<string, string | undefined>,
  role: AppRole,
  options: { reported: Set<string>; log?: (line: string) => void },
): boolean {
  if (!keyRefSharedWithOtherRole(env, role)) return true;
  const enforce = keyRolesEnforced(env);
  if (!options.reported.has(role)) {
    options.reported.add(role);
    (options.log ?? ((line: string) => console.error(line)))(
      enforce
        ? `key roles: ALERT ${KEY_REF_SETTINGS[role]} names a key also configured for another role; ${role} is not built (${KEY_ROLES_ENFORCE_SETTING}=1)`
        : `key roles: ALERT ${KEY_REF_SETTINGS[role]} names a key also configured for another role; ${role} built anyway (${KEY_ROLES_ENFORCE_SETTING} is off)`,
    );
  }
  return !enforce;
}

/** The key behind a ref whatever its KEK version; a ref that isn't one compares as itself. */
const keyOf = (ref: string): string => {
  try {
    return parseKeyRef(ref).keyId;
  } catch {
    return ref;
  }
};

/** The first setting of these roles of Arc naming a key that a role of Base also names, or null. */
const arcKeySharedWithBase = (
  env: Record<string, string | undefined>,
  roles: readonly AppRole[],
): string | null => {
  const base = new Set(
    (Object.keys(KEY_REF_SETTINGS) as AppRole[])
      .filter((role) => !ARC_ROLES.includes(role))
      .flatMap((role) => refsOf(env, role).map(keyOf)),
  );
  for (const role of roles)
    if (refsOf(env, role).some((ref) => base.has(keyOf(ref)))) return KEY_REF_SETTINGS[role];
  return null;
};

/** The first of Arc's paymaster settings naming a key that a role of Base also names, or null. */
export function arcPaymasterKeySharedWithBase(
  env: Record<string, string | undefined>,
): string | null {
  return arcKeySharedWithBase(env, ARC_PAYMASTER_ROLES);
}

/** Arc's facilitator setting when it names a key that a role of Base also names, or null. */
export function arcFacilitatorKeySharedWithBase(
  env: Record<string, string | undefined>,
): string | null {
  return arcKeySharedWithBase(env, ['arc_router3_facilitator']);
}

/**
 * Whether Arc's own bundler may use the keys its settings name. `env` is the deployment's settings,
 * not Arc's view of them: that view holds nothing of Base's to compare with. A key shared with Base
 * is always refused; any other sharing follows roleKeyUsable.
 */
export function arcPaymasterKeysUsable(
  env: Record<string, string | undefined>,
  options: { reported: Set<string>; log?: (line: string) => void },
): boolean {
  const shared = arcPaymasterKeySharedWithBase(env);
  if (shared) {
    if (!options.reported.has(shared)) {
      options.reported.add(shared);
      (options.log ?? ((line: string) => console.error(line)))(
        `key roles: ALERT ${shared} names a key also configured for a role on Base; Arc's paymaster is not built`,
      );
    }
    return false;
  }
  return ARC_PAYMASTER_ROLES.map((role) => roleKeyUsable(env, role, options)).every(Boolean);
}

/**
 * Whether Arc's fee router 3 facilitator may use the key its setting names. `env` is the deployment's
 * settings, as for arcPaymasterKeysUsable. A key shared with Base is always refused; any other
 * sharing follows roleKeyUsable.
 */
export function arcFacilitatorKeyUsable(
  env: Record<string, string | undefined>,
  options: { reported: Set<string>; log?: (line: string) => void },
): boolean {
  const shared = arcFacilitatorKeySharedWithBase(env);
  if (shared) {
    if (!options.reported.has(shared)) {
      options.reported.add(shared);
      (options.log ?? ((line: string) => console.error(line)))(
        `key roles: ALERT ${shared} names a key also configured for a role on Base; Arc's facilitator is not built`,
      );
    }
    return false;
  }
  return roleKeyUsable(env, 'arc_router3_facilitator', options);
}

export interface RoleHolder {
  role: KeyRole;
  address: string;
}

export interface RoleConflict {
  roles: [KeyRole, KeyRole];
  address: string;
}

/** Every two different roles held by the same address (case-insensitive), once per pair. */
export function keyRoleConflicts(holders: readonly RoleHolder[]): RoleConflict[] {
  const byAddress = new Map<string, Set<KeyRole>>();
  for (const { role, address } of holders) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
    const key = address.toLowerCase();
    const roles = byAddress.get(key) ?? new Set<KeyRole>();
    roles.add(role);
    byAddress.set(key, roles);
  }
  const conflicts: RoleConflict[] = [];
  for (const [address, roles] of byAddress) {
    const list = [...roles].sort();
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        conflicts.push({ roles: [list[i], list[j]], address });
  }
  return conflicts;
}

/**
 * Resolves every configured role to its public address and logs one ALERT line per conflict.
 * Lines carry role names, setting names and public
 * addresses only. `log` is the effective sink (the app's logLine); without one, the console, as
 * production runs Fastify with logger: false. Never throws; returns what it found.
 */
export async function checkKeyRolesAtStart(deps: {
  db: Pick<Database, 'query'>;
  env: Record<string, string | undefined>;
  chainId: number;
  log?: (line: string) => void;
}): Promise<{ holders: RoleHolder[]; conflicts: RoleConflict[] }> {
  const { env } = deps;
  const log = deps.log ?? ((line: string) => console.error(line));
  const holders: RoleHolder[] = [];
  try {
    // A key ref shared by two roles is reported where the role is built (roleKeyUsable) and shows
    // up here as two roles on one account.
    const refs = new Map<string, AppRole>();
    for (const role of Object.keys(KEY_REF_SETTINGS) as AppRole[])
      for (const ref of refsOf(env, role)) {
        try {
          refs.set(parseKeyRef(ref).keyId, role);
        } catch {
          log(`key roles: ALERT ${KEY_REF_SETTINGS[role]} is not a key ref`);
        }
      }
    if (refs.size) {
      const { rows } = await deps.db.query<{ key_id: string; signer_address: string }>(
        'SELECT key_id, signer_address FROM base_spender_keys WHERE key_id = ANY($1)',
        [[...refs.keys()]],
      );
      for (const row of rows)
        holders.push({ role: refs.get(row.key_id)!, address: row.signer_address });
    }
    // The paymaster keys the app provisioned itself (own_paymaster_keys), configured or not.
    const paymaster = await deps.db
      .query<{ purpose: string; address: string }>(
        'SELECT purpose, address FROM own_paymaster_keys',
      )
      .then((r) => r.rows)
      .catch(() => []);
    for (const row of paymaster)
      holders.push({
        role:
          row.purpose === 'paymaster_signer'
            ? 'paymaster_signer'
            : row.purpose === 'arc_paymaster_signer'
              ? 'arc_paymaster_signer'
              : row.purpose.startsWith('arc_')
                ? 'arc_paymaster_submitter'
                : 'paymaster_submitter',
        address: row.address,
      });
    // The map above keeps one role per key, so a ref named on both chains would not show here.
    for (const sharedWithBase of [
      arcPaymasterKeySharedWithBase(env),
      arcFacilitatorKeySharedWithBase(env),
    ])
      if (sharedWithBase)
        log(`key roles: ALERT ${sharedWithBase} names a key also configured for a role on Base`);
    const treasury = protocolTreasuryFor(env, deps.chainId);
    if (treasury) holders.push({ role: 'treasury', address: treasury });
    const funding = env[FUNDING_WALLET_SETTING]?.trim();
    if (funding) holders.push({ role: 'funding', address: funding });
    const conflicts = keyRoleConflicts(holders);
    for (const { roles, address } of conflicts)
      log(`key roles: ALERT ${roles[0]} and ${roles[1]} use the same account ${address}`);
    return { holders, conflicts };
  } catch {
    log('key roles: ALERT the role check could not run');
    return { holders, conflicts: [] };
  }
}
