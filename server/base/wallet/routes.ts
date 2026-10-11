/*
 * Operation Base Wallet W1 (contract v1 + v1.1): the person's owner vault and each agent's wallet
 * on the wallet network (shared/base/wallet-network.ts; Base, chain 8453). Behind
 * CITY_BASE_WALLET=1; every route answers 404 while it is off. The network is never read from a
 * request; the registration flow (identity/routes.ts) is not touched, though on Base it keeps its
 * agents' wallets in the same table (one wallet per agent and chain).
 *
 *   GET  /api/base/vault                   the person's vault + a single-use challenge
 *   POST /api/base/vault                   store a new vault (proof: VaultCreate, purpose 'create')
 *   PUT  /api/base/vault                   re-encrypt it (purpose 'rewrap', same owner, version + 1)
 *   POST /api/base/vault/backup-confirmed  the owner key confirms the recovery phrase was saved
 *   POST /api/base/agents/:agentId/wallet  the agent's wallet, owned by the vault key only
 *   GET  /api/base/agents/:agentId/wallet  address (after backup), balances read on Base
 *   .../wallet/withdrawals[/...]            owner withdrawals (W2, withdraw-routes.ts)
 *   .../wallet/limits[/...]                 owner-signed spending limits (W3, limits-routes.ts)
 *   .../wallet/payments, /api/base/pay/...  pay another Central City agent (pay/routes.ts)
 *   .../wallet/ratings[/lookup|/status]     rate another Central City agent (rate/routes.ts)
 *   .../wallet/agent-payments               what the agent paid on its own (pay/agent-history.ts)
 *
 * Vaults belong to person accounts only: a selected AI workspace, a non-person account or a
 * caller without a console session answers 404 (401 when nothing at all is presented). Writes go
 * through the console's request guard in server/app.ts (X-City-Request, JSON).
 *
 * What the wallets need on Base. Without the flag every route is 404; without any other required
 * setting the routes that touch Base answer 503, never half-configured:
 *
 *   CITY_BASE_WALLET=1                      the routes exist (404 otherwise; read per request)
 *   CITY_BASE_MAINNET=1                     Base's own gate (chains.ts): the chain runtime and the
 *                                           wallet readers refuse without it
 *   CITY_BASE_CDP_RPC_URL                   the CDP endpoint of Base (node, bundler, paymaster);
 *                                           balances, spend permissions, Pay's ownerOf and owner
 *                                           operations use it
 *   CITY_BASE_SPENDER_KEK                   encrypts each agent's spender key (keystore.ts)
 *   CITY_BASE_MAX_FEE_PER_GAS_WEI           hard cap on maxFeePerGas (chain/runtime.ts)
 *   CITY_BASE_IDENTITY_FEE_CAP_WEI          the Base runtime (shared with registrations) refuses
 *                                           to start without it
 *   CITY_BASE_WALLET_FEE_CAP_WEI            cost cap per owner operation (withdrawal, payment,
 *                                           cancel, limit revoke); without it no owner operation
 *                                           exists on Base
 *   CITY_BASE_LIMIT_ONCHAIN_MODEL           optional, 'half' (default) or 'full' (W3 limits)
 *   CITY_BASE_WALLET_UNSPONSORED_FALLBACK   optional, off unless '1' (withdrawals.ts)
 *   CITY_BASE_PAY_ANY_ADDRESS               optional, off unless '1' (pay/service.ts)
 *   CITY_BASE_RATE                          optional, off unless '1': the rating routes exist
 *                                           (404 otherwise; read per request; rate/service.ts)
 *   CITY_BASE_RATE_DAILY_MAX                optional, ratings per account per Berlin day
 *                                           (default 100; read per request; rate/service.ts)
 *   CITY_BASE_LANES                         optional, off unless '1': pay without waiting, each
 *                                           new owner operation in its own nonce lane
 *                                           (withdrawals.ts)
 *   CITY_BASE_LANES_CAP                     optional, unfinished operations per wallet with
 *                                           lanes on (1-1000, default 100)
 *   CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET  optional, sponsored gas in flight per wallet
 *                                           (default 0.1 ETH = 100000000000000000 wei)
 *   CITY_BASE_SPONSOR_INFLIGHT_WEI_TOTAL    optional, sponsored gas in flight in total
 *                                           (default 3 ETH = 3000000000000000000 wei, about
 *                                           USD 10k)
 *                                           Both are hard ceilings on what the sponsor can be
 *                                           charged for operations in flight, cancels included:
 *                                           each sponsored operation reserves its own max cost
 *                                           plus a cancel headroom of one fee cap.
 *   CITY_BASE_LANES_REVERT_BUDGET           optional, sponsored reverts per wallet in 24 h
 *                                           before new laned operations pause (default 3)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { formatUnits, getAddress, type Hex } from 'viem';
import { z } from 'zod';
import type { Database } from '../../database.js';
import { baseNetwork, type Address } from '../../../shared/base/chains.js';
import {
  WALLET_CHAIN_ID as CHAIN_ID,
  WALLET_EXPLORER as EXPLORER,
  WALLET_NETWORK,
  WALLET_TESTNET,
} from '../../../shared/base/wallet-network.js';
import type { ChainRuntime } from '../identity/routes.js';
import { baseBalanceReader, type BalanceReader } from '../chain/balances.js';
import { basePermissionReader, type PermissionReader } from '../chain/permission-reader.js';
import { payChainReader, type PayChainReader } from '../pay/chain.js';
import { createAgentPayHistory, registerAgentPayHistoryRoutes } from '../pay/agent-history.js';
import { registerPayRoutes } from '../pay/routes.js';
import { createPayService, payAnyAddressEnabled } from '../pay/service.js';
import { registerRateRoutes } from '../rate/routes.js';
import { createRateService, rateDailyMax, rateEnabled } from '../rate/service.js';
import { balanceCache, ChainUnavailableError } from './balance-cache.js';
import { createWalletService, WalletServiceError } from './service.js';
import { createVaultService, VaultError, type VaultView } from './vault.js';
import { registerWithdrawalRoutes } from './withdraw-routes.js';
import {
  createWithdrawalService,
  lanesCap,
  lanesEnabled,
  lanesRevertBudget,
  sponsorBudget,
  sponsorBudgetWarnings,
  unsponsoredFallbackEnabled,
} from './withdrawals.js';
import type { OwnerRevokePort } from '../chain/owner-revoke.js';
import { onchainCapModel } from '../../../shared/base/spend-limits.js';
import { createLimitService } from './limits.js';
import { registerLimitRoutes } from './limits-routes.js';
import { createAgentPayConsentService } from './agent-pay-consent.js';
import { registerAgentPayRoutes } from './agent-pay-routes.js';

/** The only network these routes serve (shared/base/wallet-network.ts). */
export const WALLET_CHAIN_ID = CHAIN_ID;
const NETWORK = WALLET_NETWORK;
export const WALLET_EXPLORER = `${EXPLORER}/address/`;

export interface WalletRouteDeps {
  db: Database;
  env: Record<string, string | undefined>;
  /** The signed-in person (console session), whatever workspace is selected; null signed out. */
  currentPerson(request: FastifyRequest): Promise<{ id: string } | null>;
  /** The workspace the console request acts in (own or a co-owned AI workspace). */
  currentWorkspace(request: FastifyRequest): Promise<{ id: string } | null>;
  /** The chain runtime: its wallet port (derivation, spender keys) and owner operations. */
  runtime(chainId: typeof WALLET_CHAIN_ID): Promise<ChainRuntime>;
  /** The wallet network's balance reader; absent when it is not configured (reads answer 503). */
  balances?: BalanceReader;
  /** Spend permissions on Base (W3); absent when it is not configured (views are stale). */
  permissions?: PermissionReader;
  /** The owner's revoke operations (W3); throws when the chain is not configured (503). */
  limitOperations?: () => Promise<OwnerRevokePort>;
  /** The wallet network's ownerOf reader for Pay and Rate; absent when not configured (503). */
  payChain?: PayChainReader;
  /** The shared rate limiter (server/app.ts); absent in unit tests. */
  limit?: (key: string, max: number, windowMs: number) => Promise<void>;
  /** Vercel Cron's bearer secret: the withdrawals sweep exists only with it. */
  cronSecret?: string;
  now?: () => number;
}

/**
 * The wallet network's readers (balances; W3's spend permissions; Pay's ownerOf) from the
 * environment: its endpoint (the network's bundlerEnv) and, on Base, its gate (CITY_BASE_MAINNET=1).
 * Without either there are none, so a read answers 503 (a limit view is stale) and nothing is
 * invented. Building them reads nothing.
 */
export function walletReaders(
  env: Record<string, string | undefined>,
): Pick<WalletRouteDeps, 'balances' | 'permissions' | 'payChain'> {
  const network = baseNetwork(WALLET_CHAIN_ID, env);
  const url = network ? env[network.bundlerEnv]?.trim() : undefined;
  if (!network || !url) return {};
  return {
    balances: baseBalanceReader(url, network),
    permissions: basePermissionReader(url, network),
    payChain: payChainReader(url, network),
  };
}

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const hexBytes = (max: number) =>
  z
    .string()
    .max(2 + 2 * max)
    .regex(HEX)
    .transform((value) => value as Hex);
const proof = z.strictObject({
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
// Shape only: exactly the fields the envelope hash covers. Which algorithms and parameters are
// accepted is checked after the proof (vault.ts), so a swapped value is a signature mismatch.
const kdf = z.strictObject({
  alg: z.string().max(32),
  N: z.number().int().nonnegative(),
  r: z.number().int().nonnegative(),
  p: z.number().int().nonnegative(),
  salt: hexBytes(64),
});
const cipher = z.strictObject({
  alg: z.string().max(32),
  iv: hexBytes(64),
});
const vaultBody = z.strictObject({
  ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  encryptedKey: z.string().max(2 + 2 * 1024),
  kdf: z.unknown(),
  cipher: z.unknown(),
  version: z.number().int().positive().optional(),
  proof,
});
const params = z.object({ agentId: z.string().uuid() });
/** The wallet takes no settings: network and owner are the server's, never the browser's. */
const walletBody = z.strictObject({});

/**
 * An agent registered on Base before it had a vault wallet: its wallet there is the
 * registration's, owned by the address typed at registration, with no owner account. Unless that
 * address is the person's own vault key it is never shown or used as the agent's wallet here
 * (GET: kind 'registered_elsewhere' with that wallet's public address and its owner address, no
 * balance, no Base read; POST: 409 wallet_registered_elsewhere). Nothing is adopted or rebound.
 */
export const REGISTERED_ELSEWHERE =
  "This agent's Base ID is held by the owner wallet you used when registering it. Connecting that wallet to Central City comes next.";

const registeredElsewhere = (
  row: { owner_account_id: string | null; owner_address: string },
  vaultOwner: string | null,
) => row.owner_account_id === null && row.owner_address.toLowerCase() !== vaultOwner?.toLowerCase();

const amount = (raw: bigint, decimals: number) => ({
  raw: raw.toString(10),
  decimals,
  display: formatUnits(raw, decimals),
});

const vaultJson = (accountId: string, vault: VaultView | null) => ({
  accountId,
  exists: vault !== null,
  ownerAddress: vault?.ownerAddress ?? null,
  encryptedKey: vault?.encryptedKey ?? null,
  kdf: vault?.kdf ?? null,
  cipher: vault?.cipher ?? null,
  version: vault?.version ?? null,
  backupConfirmedAt: vault?.backupConfirmedAt ?? null,
  // A page built for another network sees it before signing and asks for a reload.
  chainId: WALLET_CHAIN_ID,
});

export function registerBaseWalletRoutes(app: FastifyInstance, deps: WalletRouteDeps) {
  const now = deps.now ?? Date.now;
  const vaults = createVaultService({ db: deps.db, now });
  const cache = deps.balances ? balanceCache(deps.balances, { now }) : null;
  const enabled = () => deps.env.CITY_BASE_WALLET === '1';
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'Not found.' });

  /** The signed-in person account, or the status to answer with. */
  async function personOf(request: FastifyRequest) {
    const person = await deps.currentPerson(request);
    // Without a session: signed out (401), or another kind of principal (404, not disclosed).
    if (!person) return { ok: false as const, code: request.headers.authorization ? 404 : 401 };
    const { rows } = await deps.db.query<{ kind: string }>(
      'SELECT kind FROM operators WHERE id = $1',
      [person.id],
    );
    if (rows[0]?.kind !== 'owner') return { ok: false as const, code: 404 };
    return { ok: true as const, accountId: person.id };
  }

  /** The vault routes: the person's own account only, never a selected AI workspace. */
  async function vaultAccount(request: FastifyRequest) {
    const person = await personOf(request);
    if (!person.ok) return person;
    const selected = request.headers['x-city-workspace'];
    if (selected !== undefined && selected !== person.accountId)
      return { ok: false as const, code: 404 };
    return person;
  }

  /** The agent routes: an agent of the selected workspace, acted on by the signed-in person. */
  async function ownedAgent(request: FastifyRequest) {
    const person = await personOf(request);
    if (!person.ok) return person;
    const workspace = await deps.currentWorkspace(request);
    if (!workspace) return { ok: false as const, code: 401 };
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return { ok: false as const, code: 404 };
    const { rows } = await deps.db.query<{ operator_id: string }>(
      'SELECT operator_id FROM agent_manifests WHERE agent_id = $1 LIMIT 1',
      [parsed.data.agentId],
    );
    // Someone else's agent answers 404, so its existence is not disclosed.
    if (rows[0]?.operator_id !== workspace.id) return { ok: false as const, code: 404 };
    return {
      ok: true as const,
      accountId: person.accountId,
      agentId: parsed.data.agentId,
      workspaceId: workspace.id,
    };
  }

  /**
   * The agent's registration wallet as the wallet screen gets it: the identity wallet holding the
   * Base ID and its external owner (both public on Base), never a balance or anything to act on.
   */
  const registeredJson = (row: { address: string; owner_address: string }) => ({
    kind: 'registered_elsewhere' as const,
    address: getAddress(row.address),
    ownerAddress: getAddress(row.owner_address),
    chainId: WALLET_CHAIN_ID,
    network: NETWORK.name,
    testnet: WALLET_TESTNET,
    code: 'wallet_registered_elsewhere',
    message: REGISTERED_ELSEWHERE,
  });

  const vaultFailure = (reply: FastifyReply, error: unknown) => {
    if (error instanceof VaultError)
      return reply.code(error.status).send({ error: error.message, code: error.code });
    throw error;
  };

  const parseVault = (body: unknown) => {
    const parsed = vaultBody.safeParse(body ?? {});
    if (!parsed.success) return null;
    const kdfParsed = kdf.safeParse(parsed.data.kdf);
    const cipherParsed = cipher.safeParse(parsed.data.cipher);
    return { body: parsed.data, kdf: kdfParsed, cipher: cipherParsed };
  };

  async function writeVault(
    request: FastifyRequest,
    reply: FastifyReply,
    purpose: 'create' | 'rewrap',
  ) {
    if (!enabled()) return notFound(reply);
    const account = await vaultAccount(request);
    if (!account.ok) return reply.code(account.code).send({ error: 'Not found.' });
    const parsed = parseVault(request.body);
    if (!parsed)
      return reply
        .code(400)
        .send({ error: 'The vault is not well formed.', code: 'invalid_vault' });
    if (!parsed.kdf.success)
      return reply.code(400).send({
        error: 'scrypt needs N between 2^17 and 2^20, r = 8, p = 1.',
        code: 'invalid_kdf',
      });
    if (!parsed.cipher.success)
      return reply.code(400).send({
        error: 'The cipher must be AES-256-GCM with a 12-byte IV.',
        code: 'invalid_cipher',
      });
    const input = { ...parsed.body, kdf: parsed.kdf.data, cipher: parsed.cipher.data };
    try {
      const vault =
        purpose === 'create'
          ? await vaults.create(account.accountId, input)
          : await vaults.rewrap(account.accountId, input);
      return reply.code(purpose === 'create' ? 201 : 200).send(vaultJson(account.accountId, vault));
    } catch (error) {
      return vaultFailure(reply, error);
    }
  }

  app.get('/api/base/vault', async (request, reply) => {
    if (!enabled()) return notFound(reply);
    const account = await vaultAccount(request);
    if (!account.ok) return reply.code(account.code).send({ error: 'Not found.' });
    const { vault, challenge } = await vaults.read(account.accountId);
    return { ...vaultJson(account.accountId, vault), challenge };
  });

  app.post('/api/base/vault', (request, reply) => writeVault(request, reply, 'create'));
  app.put('/api/base/vault', (request, reply) => writeVault(request, reply, 'rewrap'));

  app.post('/api/base/vault/backup-confirmed', async (request, reply) => {
    if (!enabled()) return notFound(reply);
    const account = await vaultAccount(request);
    if (!account.ok) return reply.code(account.code).send({ error: 'Not found.' });
    const parsed = proof.safeParse(request.body ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'Send the challenge nonce and the signature.', code: 'invalid_proof' });
    try {
      const vault = await vaults.confirmBackup(account.accountId, parsed.data);
      return { backupConfirmedAt: vault.backupConfirmedAt };
    } catch (error) {
      return vaultFailure(reply, error);
    }
  });

  /** The wallet as the screen shows it; the address only once the recovery phrase is saved. */
  const walletJson = (
    row: { address: string; owner_address: string; spender_address: string },
    unlocked: boolean,
  ) => ({
    chainId: WALLET_CHAIN_ID,
    network: NETWORK.name,
    testnet: WALLET_TESTNET,
    address: unlocked ? row.address : null,
    ownerAddress: row.owner_address,
    /** The agent's spending key: the only spender a limit of this wallet may name (W3). */
    spenderAddress: row.spender_address,
    fundingLocked: !unlocked,
    explorerUrl: unlocked ? `${WALLET_EXPLORER}${row.address}` : null,
  });

  app.post('/api/base/agents/:agentId/wallet', async (request, reply) => {
    if (!enabled()) return notFound(reply);
    const owned = await ownedAgent(request);
    if (!owned.ok) return reply.code(owned.code).send({ error: 'Not found.' });
    if (!walletBody.safeParse(request.body ?? {}).success)
      return reply.code(400).send({
        error: 'The wallet takes no settings: network and owner are set by Central City.',
        code: 'invalid_body',
      });
    // The owner is the person's vault key, never an address from the request.
    const vault = await vaults.owner(owned.accountId);
    if (!vault)
      return reply
        .code(409)
        .send({ error: 'Set up your wallet vault first.', code: 'vault_missing' });
    let runtime: ChainRuntime;
    try {
      runtime = await deps.runtime(WALLET_CHAIN_ID);
    } catch {
      return reply
        .code(503)
        .send({ error: 'Wallets are not available yet.', code: 'network_unavailable' });
    }
    const wallets = createWalletService({
      db: deps.db,
      chain: runtime.walletPort,
      env: deps.env,
      now,
    });
    try {
      const wallet = await wallets.ensureWallet({
        workspaceId: owned.workspaceId,
        agentId: owned.agentId,
        chainId: WALLET_CHAIN_ID,
        ownerAddress: vault.ownerAddress,
        ownerAccountId: owned.accountId,
      });
      return walletJson(
        {
          address: wallet.address,
          owner_address: wallet.ownerAddress,
          spender_address: wallet.spenderAddress,
        },
        vault.backupConfirmedAt !== null,
      );
    } catch (error) {
      if (error instanceof WalletServiceError && error.code === 'wallet_conflict') {
        // The agent's wallet from its Base registration, held by the owner wallet typed then.
        const { rows } = await deps.db.query<{
          owner_account_id: string | null;
          owner_address: string;
        }>(
          `SELECT owner_account_id, owner_address FROM base_wallets
           WHERE agent_id = $1 AND chain_id = $2`,
          [owned.agentId, WALLET_CHAIN_ID],
        );
        if (rows[0] && registeredElsewhere(rows[0], vault.ownerAddress))
          return reply
            .code(409)
            .send({ error: REGISTERED_ELSEWHERE, code: 'wallet_registered_elsewhere' });
        return reply.code(409).send({
          error: 'This agent already has a wallet with another owner.',
          code: 'wallet_conflict',
        });
      }
      if (error instanceof WalletServiceError && error.code === 'network_unavailable')
        return reply
          .code(503)
          .send({ error: 'Wallets are not available yet.', code: 'network_unavailable' });
      throw error;
    }
  });

  app.get('/api/base/agents/:agentId/wallet', async (request, reply) => {
    if (!enabled()) return notFound(reply);
    const owned = await ownedAgent(request);
    if (!owned.ok) return reply.code(owned.code).send({ error: 'Not found.' });
    // Unlocked only when the wallet's own owner (its vault, same key) confirmed the backup;
    // co-owners see the same wallet, and an outside-owned wallet stays locked here.
    const { rows } = await deps.db.query<{
      address: string;
      owner_address: string;
      spender_address: string;
      owner_account_id: string | null;
      backup_confirmed_at: string | number | null;
    }>(
      `SELECT w.address, w.owner_address, w.spender_address, w.owner_account_id,
              v.backup_confirmed_at
       FROM base_wallets w
       LEFT JOIN base_owner_vaults v
         ON v.operator_id = w.owner_account_id AND lower(v.owner_address) = lower(w.owner_address)
       WHERE w.agent_id = $1 AND w.chain_id = $2 AND w.operator_id = $3`,
      [owned.agentId, WALLET_CHAIN_ID, owned.workspaceId],
    );
    const row = rows[0];
    if (!row) return { wallet: null };
    // A registration's wallet is not this person's vault wallet unless their vault key holds it
    // (then POST adopts it): no address, no balance, nothing to withdraw or pay from.
    if (
      row.owner_account_id === null &&
      registeredElsewhere(row, (await vaults.owner(owned.accountId))?.ownerAddress ?? null)
    )
      return registeredJson(row);
    const unavailable = () =>
      reply.code(503).send({ error: 'Base could not be read.', code: 'chain_unavailable' });
    if (!cache) return unavailable();
    let read;
    try {
      read = await cache.read(row.address as Address);
    } catch (error) {
      if (error instanceof ChainUnavailableError) return unavailable();
      throw error;
    }
    const json = walletJson(row, row.backup_confirmed_at !== null);
    return {
      chainId: json.chainId,
      network: json.network,
      testnet: json.testnet,
      address: json.address,
      ownerAddress: json.ownerAddress,
      spenderAddress: json.spenderAddress,
      deployed: read.balances.deployed,
      fundingLocked: json.fundingLocked,
      usdc: amount(read.balances.usdc, NETWORK.tokens.USDC.decimals),
      eth: amount(read.balances.eth, NETWORK.tokens.ETH.decimals),
      readAtBlock: Number(read.balances.blockNumber),
      readAt: read.readAt,
      stale: read.stale,
      explorerUrl: json.explorerUrl,
    };
  });

  // W2: authorized by the wallet's owner account, not by current agent access (v1.1 gate 3).
  const withdrawals = createWithdrawalService({
    db: deps.db,
    operations: async () => {
      const runtime = await deps.runtime(WALLET_CHAIN_ID);
      if (!runtime.ownerOperations) throw new Error('Owner operations are not configured.');
      return runtime.ownerOperations;
    },
    balances: deps.balances,
    // Off unless CITY_BASE_WALLET_UNSPONSORED_FALLBACK is exactly '1'; read per request.
    unsponsoredFallback: () => unsponsoredFallbackEnabled(deps.env),
    // A payment's notice is recorded in the transaction that makes its withdrawal final.
    finalized: (tx, final) => payments.finalized(tx, final),
    // A payment's cancel never falls back to an owner-funded operation either.
    sponsoredOnly: (withdrawalId) => payments.isPayment(withdrawalId),
    ratingsEnabled: () => rateEnabled(deps.env),
    // Pay without waiting: off unless CITY_BASE_LANES is exactly '1'; both read per request.
    lanes: () => lanesEnabled(deps.env),
    openCap: () => lanesCap(deps.env),
    revertBudget: () => lanesRevertBudget(deps.env),
    // The sponsor's exposure in flight, lanes on or off; read per request.
    sponsorBudget: () => sponsorBudget(deps.env),
    now,
  });
  // Pay: a payment is a withdrawal to a re-verified Central City agent (never owner-funded).
  const payments = createPayService({
    db: deps.db,
    withdrawals,
    chain: deps.payChain,
    // Off unless CITY_BASE_PAY_ANY_ADDRESS is exactly '1'; read per request.
    anyAddress: () => payAnyAddressEnabled(deps.env),
    now,
  });
  // Said once, at startup: sponsor settings that fall back to a default or leave the caps off.
  for (const warning of sponsorBudgetWarnings(deps.env)) app.log.warn(warning);
  registerWithdrawalRoutes(app, {
    cronSecret: deps.cronSecret,
    enabled,
    lanes: () => lanesEnabled(deps.env),
    person: personOf,
    service: withdrawals,
    limit: deps.limit,
  });
  registerPayRoutes(app, {
    enabled,
    person: personOf,
    service: payments,
    limit: deps.limit,
  });
  // Rate: a rating is an owner operation of the rater's wallet (sponsored, no money moves).
  registerRateRoutes(app, {
    // Off unless CITY_BASE_RATE is exactly '1' too; read per request.
    enabled: () => enabled() && rateEnabled(deps.env),
    person: personOf,
    service: createRateService({
      db: deps.db,
      withdrawals,
      chain: deps.payChain,
      // CITY_BASE_RATE_DAILY_MAX, read per request (100 when unset or not a whole number from 1).
      dailyMax: () => rateDailyMax(deps.env),
      now,
    }),
    limit: deps.limit,
  });

  // W3: authorized by the wallet's owner account, not by current agent access (v1.1 gate 3). The
  // on-chain model of new limits is one server setting: 'half' (default) or 'full'.
  registerLimitRoutes(app, {
    enabled,
    person: personOf,
    service: createLimitService({
      db: deps.db,
      chainId: WALLET_CHAIN_ID,
      model: onchainCapModel(deps.env.CITY_BASE_LIMIT_ONCHAIN_MODEL),
      permissions: deps.permissions,
      operations: deps.limitOperations,
      now,
    }),
  });

  // P2b: the owner's consent that this agent may pay on its own (nothing pays with it yet).
  registerAgentPayRoutes(app, {
    enabled,
    person: personOf,
    service: createAgentPayConsentService({ db: deps.db, chainId: WALLET_CHAIN_ID, now }),
  });

  // P2d: the payments the agent made on its own, read only (the wallet's owner account alone).
  registerAgentPayHistoryRoutes(app, {
    enabled,
    person: personOf,
    history: createAgentPayHistory({ db: deps.db }),
  });
}
