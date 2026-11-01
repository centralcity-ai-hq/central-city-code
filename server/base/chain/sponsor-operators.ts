/*
 * Central City's own sponsor operators: the accounts whose fleets register agents, pay and rate at
 * volume, exempt from the paymaster's per-account, per-sender and never-sent caps and the handout
 * share (own-paymaster-budget.ts), the per-account unsigned caps (wallet/withdrawals.ts) and the
 * per-account registration rate (identity/routes.ts). Never from the deployment-wide hours and
 * days or the deposit; the exit day holds them like every account (each keeps its first 3 exits a
 * day past it). A proven workspace is exempt as a workspace: everyone acting in it (a co-owner
 * without the fleet key too) shares its registration-rate exemption.
 *
 * Configured as the fleets' PUBLIC owner EOAs (CITY_BASE_SPONSOR_OPERATOR_OWNERS, comma-separated;
 * public facts, never secrets). The server maps them to account ids itself, at startup and then
 * hourly, and ONLY through rows that carry server-verified proof of that owner key:
 *
 *   (b) the owner vault (migration 88; wallet/vault.ts create): the owner key signed VaultCreate
 *       naming this account and address over a single-use server nonce, verified before the row
 *       was written. The vault's account is proven, and so is the workspace of every wallet bound
 *       to that vault (owner_account_id = the vault's account, same owner address): the binding is
 *       made only by that account's own wallet-key session (identity/routes.ts walletKey,
 *       wallet/service.ts link).
 *   (a) an active spending limit (migration 90; wallet/limits.ts store): state 'signed' or
 *       'onchain', a permission hash, and an EIP-712 signature the server recovered to the wallet's
 *       owner address before storing it, for a wallet bound to the account that stored it. Its
 *       account and its wallet's workspace are proven. (In today's schema (a) implies (b): a limit
 *       is only stored for a wallet bound to the signer's vault. It is read on its own anyway, so
 *       the mapping stays the agreed design if vault rows are ever moved.)
 *
 * An asserted owner address proves nothing: a wallets-off registration stores the typed
 * ownerAddress through ensureWallet with no owner account (owner_account_id NULL), so such a row,
 * pre-existing or new, never maps, whatever address it names. Each refresh REPLACES the set: a
 * revoked limit, a removed vault or an owner key that moved to another account drops the old
 * account on the next refresh.
 *
 * The retired CITY_BASE_SPONSOR_OPERATOR_ACCOUNTS (account ids typed into the environment) is no
 * longer read: an id cannot show that its holder owns a fleet key. If it is still set, startup
 * says so as an alert; nobody is exempt through it.
 *
 * Logged at every resolution, counts only, never ids or addresses:
 *   "N owners -> M proven accounts, K owners unproven (not exempt)".
 * K counts listed owners with no proof row at all. Accounts holding only asserted rows for a listed
 * owner are not counted: base_wallets has no index on owner_address (about 371k rows on 21 Oct),
 * and a scan of it per instance per hour is not worth a log number; they are never exempt either way.
 */
import type { Database } from '../../database.js';

export const SPONSOR_OPERATOR_OWNERS_SETTING = 'CITY_BASE_SPONSOR_OPERATOR_OWNERS';
/** Retired: read only to warn that it no longer exempts anyone. */
export const RETIRED_SPONSOR_OPERATOR_ACCOUNTS_SETTING = 'CITY_BASE_SPONSOR_OPERATOR_ACCOUNTS';
/** How long a resolution stands before the next one is started. */
export const SPONSOR_OPERATORS_REFRESH_MS = 60 * 60_000;
/** After a failed resolution, the next attempt. */
export const SPONSOR_OPERATORS_RETRY_MS = 60_000;
/** A resolution older than this (refreshes kept failing) exempts nobody: it fails closed. */
export const SPONSOR_OPERATORS_MAX_AGE_MS = 2 * SPONSOR_OPERATORS_REFRESH_MS;

const EMPTY: ReadonlySet<string> = new Set();
const OWNER = /^0x[0-9a-fA-F]{40}$/;

/**
 * The configured owner EOAs, lowercased, each once (a repeat, in any case, is ignored). Empty or
 * unset: none. Parsed strictly: anything that is not an address (an empty item too) throws, and
 * startup stops.
 */
export function sponsorOperatorOwners(env: Record<string, string | undefined>): readonly string[] {
  const raw = env[SPONSOR_OPERATOR_OWNERS_SETTING]?.trim() ?? '';
  if (raw === '') return [];
  const items = raw.split(',').map((item) => item.trim());
  if (items.some((item) => !OWNER.test(item)))
    throw new Error(
      `${SPONSOR_OPERATOR_OWNERS_SETTING} must be comma-separated owner addresses (0x + 40 hex).`,
    );
  return [...new Set(items.map((item) => item.toLowerCase()))];
}

export interface SponsorOperatorResolution {
  /** Distinct configured owners. */
  owners: number;
  /** Distinct proven account ids (people and workspaces). */
  proven: number;
  /** Configured owners with no proof row: no account is exempt for them. */
  unprovenOwners: number;
  accounts: ReadonlySet<string>;
}

/**
 * The proof rows only; see the header. Reads through indexes (the vault's lower(owner_address),
 * base_wallets' owner_account_id) except the active limits, joined to their wallet by key.
 */
const RESOLVE_SQL = `
WITH vaults AS (
  SELECT v.operator_id AS account_id, lower(v.owner_address) AS owner
  FROM base_owner_vaults v
  WHERE lower(v.owner_address) = ANY($1::text[])
),
vault_wallets AS (
  SELECT DISTINCT w.operator_id AS account_id, v.owner
  FROM vaults v
  JOIN base_wallets w
    ON w.owner_account_id = v.account_id AND lower(w.owner_address) = v.owner
),
limits AS (
  SELECT DISTINCT p.owner_account_id, w.operator_id, lower(w.owner_address) AS owner
  FROM base_spend_permissions p
  JOIN base_wallets w ON w.wallet_id = p.wallet_id
  WHERE p.state IN ('signed', 'onchain')
    AND p.permission_hash IS NOT NULL
    AND p.owner_account_id IS NOT NULL
    AND p.owner_account_id = w.owner_account_id
    AND lower(w.owner_address) = ANY($1::text[])
)
SELECT account_id, owner FROM vaults
UNION SELECT account_id, owner FROM vault_wallets
UNION SELECT owner_account_id, owner FROM limits
UNION SELECT operator_id, owner FROM limits`;

export async function resolveSponsorOperatorAccounts(
  db: Pick<Database, 'query'>,
  owners: readonly string[],
): Promise<SponsorOperatorResolution> {
  if (owners.length === 0) return { owners: 0, proven: 0, unprovenOwners: 0, accounts: EMPTY };
  const { rows } = await db.query<{ account_id: string; owner: string }>(RESOLVE_SQL, [
    owners.map((owner) => owner.toLowerCase()),
  ]);
  const accounts = new Set(rows.map((row) => row.account_id));
  const provenOwners = new Set(rows.map((row) => row.owner));
  return {
    owners: owners.length,
    proven: accounts.size,
    unprovenOwners: owners.filter((owner) => !provenOwners.has(owner)).length,
    accounts,
  };
}

export type SponsorOperatorLog = (
  level: 'info' | 'warn',
  entry: Record<string, unknown>,
  message: string,
) => void;

/** The resolution's line: counts only. A warning when an owner is unproven or none are set while we sponsor. */
export function sponsorOperatorsLine(
  result: Omit<SponsorOperatorResolution, 'accounts'>,
  sponsoring: boolean,
): { level: 'info' | 'warn'; entry: Record<string, unknown>; message: string } {
  const entry = {
    event: 'sponsor_operator_owners',
    owners: result.owners,
    proven: result.proven,
    unprovenOwners: result.unprovenOwners,
    sponsoring,
  };
  if (result.owners === 0 && sponsoring)
    return {
      level: 'warn',
      entry: { ...entry, alert: true },
      message: `ALERT ${SPONSOR_OPERATOR_OWNERS_SETTING} is empty while our paymaster sponsors: the platform's own fleets are held to the per-account caps`,
    };
  return {
    level: result.unprovenOwners > 0 ? 'warn' : 'info',
    entry,
    message: `${result.owners} owners -> ${result.proven} proven accounts, ${result.unprovenOwners} owners unproven (not exempt)`,
  };
}

/** Said once at startup when the retired account-id list is still set. */
export function retiredSponsorOperatorAccountsLine(
  env: Record<string, string | undefined>,
): { entry: Record<string, unknown>; message: string } | null {
  if ((env[RETIRED_SPONSOR_OPERATOR_ACCOUNTS_SETTING]?.trim() ?? '') === '') return null;
  return {
    entry: { event: 'sponsor_operator_accounts_retired', alert: true },
    message: `ALERT ${RETIRED_SPONSOR_OPERATOR_ACCOUNTS_SETTING} is no longer read and exempts nobody: list the fleets' owner addresses in ${SPONSOR_OPERATOR_OWNERS_SETTING}`,
  };
}

export interface SponsorOperators {
  /**
   * The exempt account ids now (cached; never waits). Starts a refresh in the background once the
   * last one is an hour old; a set older than SPONSOR_OPERATORS_MAX_AGE_MS is not used.
   */
  accounts(): ReadonlySet<string>;
  /** Resolves now (or joins the one running) and REPLACES the set; null when it failed. */
  refresh(): Promise<SponsorOperatorResolution | null>;
}

export function createSponsorOperators(deps: {
  db: Pick<Database, 'query'>;
  owners: readonly string[];
  /** Whether our own paymaster sponsors (the empty-list alert). */
  sponsoring?: boolean;
  log?: SponsorOperatorLog;
  now?: () => number;
  refreshMs?: number;
  retryMs?: number;
  maxAgeMs?: number;
}): SponsorOperators {
  const now = deps.now ?? Date.now;
  const refreshMs = deps.refreshMs ?? SPONSOR_OPERATORS_REFRESH_MS;
  const retryMs = deps.retryMs ?? SPONSOR_OPERATORS_RETRY_MS;
  const maxAgeMs = deps.maxAgeMs ?? SPONSOR_OPERATORS_MAX_AGE_MS;
  let current: ReadonlySet<string> = EMPTY;
  let resolvedAt: number | null = null;
  let nextAt = 0;
  let inflight: Promise<SponsorOperatorResolution | null> | null = null;

  function refresh(): Promise<SponsorOperatorResolution | null> {
    if (inflight) return inflight;
    // A failure tries again soon; a success moves this an hour on.
    nextAt = now() + retryMs;
    inflight = (async () => {
      try {
        const result = await resolveSponsorOperatorAccounts(deps.db, deps.owners);
        current = result.accounts;
        resolvedAt = now();
        nextAt = resolvedAt + refreshMs;
        const line = sponsorOperatorsLine(result, deps.sponsoring === true);
        deps.log?.(line.level, line.entry, line.message);
        return result;
      } catch {
        // No error text: it is not needed to act, and the set stands until it is too old.
        deps.log?.(
          'warn',
          { event: 'sponsor_operator_owners', failed: true, alert: true },
          'ALERT sponsor operator owners could not be resolved; the last resolution stands for at most 2 h',
        );
        return null;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    accounts() {
      if (deps.owners.length === 0) return EMPTY;
      const at = now();
      if (at >= nextAt) void refresh();
      if (resolvedAt === null || at - resolvedAt > maxAgeMs) return EMPTY;
      return current;
    },
    refresh,
  };
}

/**
 * The process's sponsor operators, installed once at startup (server/app.ts) and read per
 * admission by the paymaster budget, the withdrawals and the registration rate. Nothing installed:
 * nobody is exempt.
 */
let installed: SponsorOperators | null = null;
export function installSponsorOperators(operators: SponsorOperators | null): void {
  installed = operators;
}
export function sponsorOperatorAccounts(): ReadonlySet<string> {
  return installed?.accounts() ?? EMPTY;
}
