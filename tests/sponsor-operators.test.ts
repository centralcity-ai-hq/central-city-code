import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_WALLET_LIMITS_SQL,
  BASE_WALLET_VAULT_SQL,
} from '../server/base/schema.js';
import { createWalletService, type WalletChainPort } from '../server/base/wallet/service.js';
import {
  BudgetError,
  OWN_PAYMASTER_ATTRIBUTION_SQL,
  OWN_PAYMASTER_BUDGET_CHAIN_SQL,
  OWN_PAYMASTER_BUDGET_SQL,
  OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL,
  ownPaymasterBudget,
} from '../server/base/chain/own-paymaster-budget.js';
import {
  createSponsorOperators,
  installSponsorOperators,
  resolveSponsorOperatorAccounts,
  retiredSponsorOperatorAccountsLine,
  sponsorOperatorAccounts,
  sponsorOperatorOwners,
  sponsorOperatorsLine,
  SPONSOR_OPERATORS_REFRESH_MS,
  type SponsorOperatorLog,
} from '../server/base/chain/sponsor-operators.js';
import { BASE_SEPOLIA, type Address } from '../shared/base/chains.js';

// The sponsor operators (server/base/chain/sponsor-operators.ts): the fleets' public owner EOAs
// map to account ids only through server-verified proof of the owner key (a vault, or an active
// limit the server verified), never through an address someone typed.

const NOW = 1_792_800_000_000;
const S = Math.floor(NOW / 1000);
const FLEET = privateKeyToAccount(generatePrivateKey()).address;
const FLEET_2 = privateKeyToAccount(generatePrivateKey()).address;
const ATTACKER_KEY = privateKeyToAccount(generatePrivateKey()).address;
const ACCOUNTS = [
  'person-fleet',
  'ws-fleet',
  'person-new',
  'ws-new',
  'person-limit',
  'ws-limit',
  'person-attacker',
  'ws-attacker',
];
const hex = (bytes: number) => `0x${randomBytes(bytes).toString('hex')}`;

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec('CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);');
  for (const id of ACCOUNTS)
    await pg.query('INSERT INTO operators VALUES ($1, $2)', [
      id,
      id.startsWith('person') ? 'owner' : 'ai',
    ]);
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_WALLET_VAULT_SQL);
  await pg.exec(BASE_WALLET_LIMITS_SQL);
  await pg.exec(OWN_PAYMASTER_BUDGET_SQL);
  await pg.exec(OWN_PAYMASTER_ATTRIBUTION_SQL);
  await pg.exec(OWN_PAYMASTER_BUDGET_CHAIN_SQL);
  await pg.exec(OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const chain: WalletChainPort = {
    implementationVersion: 'cbsw-1.1',
    async deriveSmartAccount() {
      return hex(20) as Address;
    },
    async createSpender() {
      return { spender: hex(20) as Address, keyRef: `v1:${hex(4)}` };
    },
    async commitSpender() {},
  };
  // The real writer behind a wallets-off registration (identity/routes.ts -> ensureWallet): it
  // stores whatever owner address was typed, with no owner account.
  const wallets = createWalletService({ db, chain, now: () => NOW });
  let agents = 0;
  const agent = () => `00000000-0000-4000-8000-${(++agents).toString(16).padStart(12, '0')}`;
  const asserted = (workspaceId: string, ownerAddress: string, ownerAccountId?: string) =>
    wallets.ensureWallet({
      workspaceId,
      agentId: agent(),
      chainId: BASE_SEPOLIA,
      ownerAddress: ownerAddress as Address,
      ...(ownerAccountId ? { ownerAccountId } : {}),
    });
  /** As wallet/vault.ts create writes it, once the owner key's VaultCreate proof is verified. */
  const vault = (account: string, owner: string) =>
    pg.query(
      `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key, kdf_params,
         cipher_params, version, backup_confirmed_at, created_at, updated_at)
       VALUES ($1, $2, decode(repeat('ab', 48), 'hex'), '{}', '{}', 1, 1, 1, 1)`,
      [account, owner],
    );
  /** A wallet bound to its owner's vault, as the wallet-key registration makes it. */
  const bound = async (workspace: string, account: string, owner: string) => {
    const id = hex(16);
    await pg.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at,
         owner_account_id)
       VALUES ($1, $2, $3, ${BASE_SEPOLIA}, $4, $5, $6, 'v1:k', '{}', 'derived', 0, 0, $7)`,
      [id, agent(), workspace, hex(20), owner, hex(20), account],
    );
    return id;
  };
  /** A spending limit row as wallet/limits.ts store writes it (its signature verified first). */
  const limit = async (
    walletId: string,
    account: string,
    options: { state?: string; hash?: boolean } = {},
  ) => {
    const id = hex(16);
    await pg.query(
      `INSERT INTO base_spend_permissions (permission_id, wallet_id, chain_id, permission, signature,
         state, token, permission_hash, period_kind, cap_raw, onchain_model, owner_account_id,
         created_at, updated_at)
       VALUES ($1, $2, ${BASE_SEPOLIA}, '{}', decode(repeat('cd', 65), 'hex'), $3, $4, $5, 'day',
         1000000, 'half', $6, 1, 1)`,
      [
        id,
        walletId,
        options.state ?? 'signed',
        hex(20),
        options.hash === false ? null : hex(32),
        account,
      ],
    );
    return id;
  };
  return { pg, db, asserted, vault, bound, limit };
}

const sorted = (set: ReadonlySet<string>) => [...set].sort();

test('the owner list is parsed strictly: a malformed address stops startup, repeats are ignored', () => {
  const env = (value?: string) => ({ CITY_BASE_SPONSOR_OPERATOR_OWNERS: value });
  assert.deepEqual(sponsorOperatorOwners(env()), []);
  assert.deepEqual(sponsorOperatorOwners(env('  ')), []);
  // The same owner twice, in two cases: once, lowercased.
  assert.deepEqual(sponsorOperatorOwners(env(` ${FLEET}, ${FLEET.toLowerCase()},${FLEET_2} `)), [
    FLEET.toLowerCase(),
    FLEET_2.toLowerCase(),
  ]);
  for (const bad of [
    '0x1234',
    'person-fleet',
    `${FLEET},,${FLEET_2}`,
    `${FLEET};${FLEET_2}`,
    `${FLEET} ${FLEET_2}`,
    `${FLEET}0`,
    FLEET.slice(2),
  ])
    assert.throws(() => sponsorOperatorOwners(env(bad)), /CITY_BASE_SPONSOR_OPERATOR_OWNERS/);
  // The retired account-id list is never read as an exemption; startup only says it is set.
  assert.equal(retiredSponsorOperatorAccountsLine({}), null);
  const retired = retiredSponsorOperatorAccountsLine({
    CITY_BASE_SPONSOR_OPERATOR_ACCOUNTS: 'person-fleet',
  });
  assert.match(retired!.message, /^ALERT CITY_BASE_SPONSOR_OPERATOR_ACCOUNTS is no longer read/);
  assert.doesNotMatch(JSON.stringify(retired), /person-fleet/);
});

test('an attacker that pre-created or newly creates a row claiming a fleet owner gets no exemption', async (t) => {
  const f = await setup(t);
  const owners = sponsorOperatorOwners({ CITY_BASE_SPONSOR_OPERATOR_OWNERS: FLEET });
  // Before any proof exists: a wallets-off registration in the attacker's workspace claims the
  // fleet owner, the attacker holds a vault of its own key, and a limit-shaped row sits on the
  // claimed wallet (its owner account is not the wallet's: the store could never have written it).
  const early = await f.asserted('ws-attacker', FLEET);
  await f.vault('person-attacker', ATTACKER_KEY);
  await f.limit(early.walletId, 'person-attacker');
  // The broad mapping first proposed (every base_wallets row naming the owner) would exempt it.
  const broad = await f.pg.query<{ operator_id: string }>(
    'SELECT DISTINCT operator_id FROM base_wallets WHERE lower(owner_address) = ANY($1)',
    [owners],
  );
  assert.deepEqual(
    broad.rows.map((row) => row.operator_id),
    ['ws-attacker'],
  );
  const none = await resolveSponsorOperatorAccounts(f.db, owners);
  assert.deepEqual(
    { owners: none.owners, proven: none.proven, unprovenOwners: none.unprovenOwners },
    { owners: 1, proven: 0, unprovenOwners: 1 },
  );
  assert.deepEqual(sorted(none.accounts), []);

  // The fleet's own account proves the key (its vault), with a wallet bound to it.
  await f.vault('person-fleet', FLEET);
  await f.bound('ws-fleet', 'person-fleet', FLEET);
  // New claims after that: another wallets-off row, and one bound to the attacker's account that
  // names the fleet owner (not the attacker's vault key, so not a vault-backed wallet).
  await f.asserted('ws-attacker', FLEET.toLowerCase());
  await f.asserted('ws-attacker', FLEET, 'person-attacker');
  const proven = await resolveSponsorOperatorAccounts(f.db, owners);
  assert.deepEqual(sorted(proven.accounts), ['person-fleet', 'ws-fleet']);
  assert.equal(proven.unprovenOwners, 0);
  for (const id of ['ws-attacker', 'person-attacker']) assert.equal(proven.accounts.has(id), false);
});

test('a proven account is exempt through an active verified limit; revoking it drops it on refresh', async (t) => {
  const f = await setup(t);
  const owners = sponsorOperatorOwners({ CITY_BASE_SPONSOR_OPERATOR_OWNERS: FLEET_2 });
  // No vault row for this owner: the limit alone is the proof.
  const wallet = await f.bound('ws-limit', 'person-limit', FLEET_2);
  // A row without a permission hash (from before the limit store existed) proves nothing.
  const legacy = await f.limit(wallet, 'person-limit', { hash: false });
  assert.equal((await resolveSponsorOperatorAccounts(f.db, owners)).proven, 0);
  await f.pg.query('DELETE FROM base_spend_permissions WHERE permission_id = $1', [legacy]);
  const active = await f.limit(wallet, 'person-limit');
  let clock = NOW;
  const operators = createSponsorOperators({ db: f.db, owners, now: () => clock });
  await operators.refresh();
  assert.deepEqual(sorted(operators.accounts()), ['person-limit', 'ws-limit']);
  // Revoked by its owner (no longer usable to spend): gone at the next refresh.
  await f.pg.query(
    "UPDATE base_spend_permissions SET state = 'revoke_pending' WHERE permission_id = $1",
    [active],
  );
  assert.deepEqual(sorted(operators.accounts()), ['person-limit', 'ws-limit']); // cached
  clock += SPONSOR_OPERATORS_REFRESH_MS;
  operators.accounts(); // starts the hourly refresh
  await operators.refresh(); // joins it
  assert.deepEqual(sorted(operators.accounts()), []);
});

test('an ownership change re-resolves on the hourly refresh, which replaces the set; logs carry counts only', async (t) => {
  const f = await setup(t);
  const owners = sponsorOperatorOwners({
    CITY_BASE_SPONSOR_OPERATOR_OWNERS: `${FLEET},${FLEET_2}`,
  });
  await f.vault('person-fleet', FLEET);
  await f.bound('ws-fleet', 'person-fleet', FLEET);
  const lines: Array<{ level: string; entry: Record<string, unknown>; message: string }> = [];
  const log: SponsorOperatorLog = (level, entry, message) => lines.push({ level, entry, message });
  let clock = NOW;
  let reads = 0;
  const db = {
    query: (sql: string, params?: unknown[]) => {
      reads += 1;
      return f.db.query(sql, params);
    },
  } as Pick<Database, 'query'>;
  const operators = createSponsorOperators({ db, owners, sponsoring: true, log, now: () => clock });
  installSponsorOperators(operators);
  t.after(() => installSponsorOperators(null));
  // Nothing resolved yet: nobody is exempt (and the first read starts a resolution).
  assert.deepEqual(sorted(sponsorOperatorAccounts()), []);
  await operators.refresh();
  assert.deepEqual(sorted(sponsorOperatorAccounts()), ['person-fleet', 'ws-fleet']);
  assert.equal(
    lines.at(-1)!.message,
    '2 owners -> 2 proven accounts, 1 owners unproven (not exempt)',
  );
  assert.equal(lines.at(-1)!.level, 'warn');
  // The key moves: the old account's vault is gone, another account now holds it.
  await f.pg.query("DELETE FROM base_owner_vaults WHERE operator_id = 'person-fleet'");
  await f.vault('person-new', FLEET);
  await f.bound('ws-new', 'person-new', FLEET);
  const before = reads;
  clock += SPONSOR_OPERATORS_REFRESH_MS - 1;
  assert.deepEqual(sorted(sponsorOperatorAccounts()), ['person-fleet', 'ws-fleet']); // cached
  assert.equal(reads, before);
  clock += 1;
  sponsorOperatorAccounts();
  await operators.refresh();
  assert.equal(reads, before + 1);
  assert.deepEqual(sorted(sponsorOperatorAccounts()), ['person-new', 'ws-new']);
  // The other owner proves its key too: every owner proven, an info line.
  await f.vault('person-limit', FLEET_2);
  clock += SPONSOR_OPERATORS_REFRESH_MS;
  sponsorOperatorAccounts();
  await operators.refresh();
  assert.deepEqual(sorted(sponsorOperatorAccounts()), ['person-limit', 'person-new', 'ws-new']);
  assert.equal(
    lines.at(-1)!.message,
    '2 owners -> 3 proven accounts, 0 owners unproven (not exempt)',
  );
  assert.equal(lines.at(-1)!.level, 'info');
  assert.deepEqual(lines.at(-1)!.entry, {
    event: 'sponsor_operator_owners',
    owners: 2,
    proven: 3,
    unprovenOwners: 0,
    sponsoring: true,
  });
  // Never an id or an address in what is logged.
  const logged = JSON.stringify(lines).toLowerCase();
  for (const secretish of [...ACCOUNTS, FLEET.toLowerCase(), FLEET_2.toLowerCase()])
    assert.equal(logged.includes(secretish), false, secretish);
});

test('a failing refresh keeps the last set for at most 2 h, then nobody is exempt', async (t) => {
  const f = await setup(t);
  await f.vault('person-fleet', FLEET);
  let clock = NOW;
  let fail = false;
  const lines: string[] = [];
  const operators = createSponsorOperators({
    db: {
      query: (sql: string, params?: unknown[]) =>
        fail ? Promise.reject(new Error('down')) : f.db.query(sql, params),
    } as Pick<Database, 'query'>,
    owners: [FLEET.toLowerCase()],
    log: (_level, _entry, message) => lines.push(message),
    now: () => clock,
  });
  await operators.refresh();
  fail = true;
  clock += SPONSOR_OPERATORS_REFRESH_MS;
  operators.accounts();
  assert.equal(await operators.refresh(), null);
  assert.match(lines.at(-1)!, /^ALERT sponsor operator owners could not be resolved/);
  assert.deepEqual(sorted(operators.accounts()), ['person-fleet']);
  clock += SPONSOR_OPERATORS_REFRESH_MS + 1;
  assert.deepEqual(sorted(operators.accounts()), []);
  await operators.refresh(); // the attempt that read started, still failing
  // Back: the next attempt (a minute after a failure) restores it.
  fail = false;
  await operators.refresh();
  assert.deepEqual(sorted(operators.accounts()), ['person-fleet']);
});

test('no owners listed: nobody is exempt, nothing is read, and an alert while we sponsor', async () => {
  const operators = createSponsorOperators({
    db: { query: () => Promise.reject(new Error('never read')) } as Pick<Database, 'query'>,
    owners: [],
  });
  assert.deepEqual((await operators.refresh())?.proven, 0);
  assert.deepEqual(sorted(operators.accounts()), []);
  const line = sponsorOperatorsLine({ owners: 0, proven: 0, unprovenOwners: 0 }, true);
  assert.equal(line.level, 'warn');
  assert.match(line.message, /^ALERT CITY_BASE_SPONSOR_OPERATOR_OWNERS is empty/);
  assert.equal(
    sponsorOperatorsLine({ owners: 0, proven: 0, unprovenOwners: 0 }, false).level,
    'info',
  );
});

test('the global hourly, daily-exit and deposit caps still bind a proven account; an unproven one gets its own caps', async (t) => {
  const f = await setup(t);
  await f.vault('person-fleet', FLEET);
  await f.asserted('ws-attacker', FLEET);
  const operators = createSponsorOperators({
    db: f.db,
    owners: [FLEET.toLowerCase()],
    now: () => NOW,
  });
  await operators.refresh();
  const MILLI = 10n ** 15n;
  let n = 0;
  const gate = (limits: Parameters<typeof ownPaymasterBudget>[0]['limits'], wei = 10n ** 18n) =>
    ownPaymasterBudget({
      db: f.db,
      deposit: async () => ({ wei, block: 100n }),
      now: () => NOW,
      limits,
      operatorAccounts: operators.accounts,
    });
  const reserve = (
    g: ReturnType<typeof gate>,
    flow: 'registration' | 'exit',
    cost: bigint,
    accountId: string,
  ) =>
    g.reserve({
      userOpHash: `0x${(++n).toString(16).padStart(64, '0')}`,
      flow,
      maxCostWei: cost,
      validUntil: S + 300,
      sender: `0x${'0c'.repeat(20)}`,
      accountId,
    });
  const refused = (p: Promise<unknown>, reason: string) =>
    assert.rejects(p, (e: unknown) => e instanceof BudgetError && e.reason === reason);

  // The hour: past its own account and sender caps (10 + 5 milli), then the shared hour holds it.
  const hour = gate({ hourlyOrdinaryWei: 30n * MILLI, handoutShareBps: 10_000 });
  // The unproven claimant is held to the per-account cap (10 milli) at once.
  await refused(reserve(hour, 'registration', 11n * MILLI, 'ws-attacker'), 'account_hourly');
  for (let i = 0; i < 14; i++) await reserve(hour, 'registration', 2n * MILLI, 'person-fleet');
  await refused(reserve(hour, 'registration', 3n * MILLI, 'person-fleet'), 'hourly');

  // The exit day: no free exits, so the shared day holds it, past its own exit caps.
  const day = gate({
    hourlyExitWei: 10n ** 17n,
    dailyExitWei: 8n * MILLI,
    freeDailyExitsPerAccount: 0,
    unsignedOpenExitPerAccount: 10,
  });
  await reserve(day, 'exit', 6n * MILLI, 'person-fleet');
  await refused(reserve(day, 'exit', 3n * MILLI, 'person-fleet'), 'exit_daily');

  // The deposit.
  const poor = gate({}, 51n * MILLI);
  await refused(reserve(poor, 'registration', 100n * MILLI, 'person-fleet'), 'deposit');
});
