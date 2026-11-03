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
 * With Arc on (CITY_ARC=1) an agent has one chain, the one of its wallet row (agentChainOf). GET and
 * POST .../wallet, the spending limits, the agent-pay consent, withdrawals, payments, the payment
 * history and the service calls follow it, each chain's own service, Arc's built on first use, and
 * ratings too (arcRatingOperations). Everything else under .../wallet/ still works on Base only, so
 * it answers an Arc agent 409 not_on_arc_yet instead of acting on a Base row (refuseArcAgents). So
 * does everything while Arc's network isn't complete (no SpendPermissionManager in the registry
 * yet). With Arc off there's no such query and no such answer. The sweep runs each chain's rows with
 * that chain's service, side by side: Arc failing or stalling leaves Base's run as it is.
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
 *
 * On Arc owner operations read Arc's own settings, in USDC of gas (18 decimals): CITY_ARC_RPC_URL,
 * CITY_ARC_PAYMASTER, CITY_ARC_WALLET_FEE_CAP_WEI (required on mainnet), and optionally
 * CITY_ARC_SPONSOR_INFLIGHT_WEI_PER_WALLET (default 5 USDC) and CITY_ARC_SPONSOR_INFLIGHT_WEI_TOTAL
 * (default 50 USDC). Base's lanes, owner-funded fallback and pay-any-address settings don't reach it.
 * Screening reads Base's oracle through Base's client, so Base must be configured too.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { formatUnits, getAddress, type Hex } from 'viem';
import { z } from 'zod';
import type { Database } from '../../database.js';
import { baseNetwork, ETH_TOKEN, type Address } from '../../../shared/base/chains.js';
import {
  WALLET_CHAIN_ID as CHAIN_ID,
  WALLET_EXPLORER as EXPLORER,
  WALLET_NETWORK,
} from '../../../shared/base/wallet-network.js';
import {
  chainFamily,
  chainNetwork,
  chainView,
  isRealMoneyChain,
  usdcOf,
  type ChainId,
  type ChainView,
} from '../../../shared/chains.js';
import type { ProtocolDeployment } from '../../../shared/protocol.js';
import { protocolArcChainIdFromEnv, protocolArcRouter3Address } from '../../protocol/fees/cron.js';
import { registrationChainOn, type ChainRuntime } from '../identity/routes.js';
import { chainHolding, type WalletFunds } from '../identity/chain-hold.js';
import { createFeedPayAlerts } from '../../feed/pay/alerts.js';
import { arcRuntimeEnv } from '../chain/arc-env.js';
import { baseBalanceReader, type BalanceReader } from '../chain/balances.js';
import { basePermissionReader, type PermissionReader } from '../chain/permission-reader.js';
import { payChainReader, type PayChainReader } from '../pay/chain.js';
import { ownPaymasterAddress } from '../chain/own-paymaster-keys.js';
import { baseReadUrls } from '../chain/read-transport.js';
import {
  createAgentPayHistory,
  registerAgentPayHistoryRoutes,
  type AgentPayHistory,
} from '../pay/agent-history.js';
import { registerPayRoutes } from '../pay/routes.js';
import { createPayService, payAnyAddressEnabled, type PayService } from '../pay/service.js';
import {
  createScreeningGate,
  type ScreeningProvider,
  type ScreeningRequest,
} from '../../protocol/screening/gate.js';
import { registerRateRoutes } from '../rate/routes.js';
import { createRateService, rateDailyMax, rateEnabled, type RateService } from '../rate/service.js';
import { RATE_PATHS } from '../../../shared/base/rate.js';
import { FEED_PAY_PATHS, FEED_PAY_SCREENING_ALERT_EVERY_MS } from '../../../shared/feed-pay.js';
import { balanceCache, ChainUnavailableError } from './balance-cache.js';
import { createWalletService, WalletServiceError } from './service.js';
import { createVaultService, VaultError, type VaultView } from './vault.js';
import { registerWithdrawalRoutes, WITHDRAWALS_PATH } from './withdraw-routes.js';
import {
  createWithdrawalService,
  lanesCap,
  lanesEnabled,
  lanesRevertBudget,
  SWEEP_BUDGET_MS,
  sponsorBudget,
  sponsorBudgetWarnings,
  unsponsoredFallbackEnabled,
  type WithdrawalService,
} from './withdrawals.js';
import type { OwnerRevokePort } from '../chain/owner-revoke.js';
import { sponsorOperatorAccounts } from '../chain/sponsor-operators.js';
import { PAY_PATHS } from '../../../shared/base/pay.js';
import { onchainCapModel } from '../../../shared/base/spend-limits.js';
import { createLimitService, type LimitService } from './limits.js';
import { LIMITS_PATH, registerLimitRoutes } from './limits-routes.js';
import { createAgentPayConsentService, type AgentPayConsentService } from './agent-pay-consent.js';
import { AGENT_PAY_PATH, registerAgentPayRoutes } from './agent-pay-routes.js';

/** The only network these routes serve (shared/base/wallet-network.ts). */
export const WALLET_CHAIN_ID = CHAIN_ID;
const NETWORK = WALLET_NETWORK;
export const WALLET_EXPLORER = `${EXPLORER}/address/`;

export interface WalletRouteDeps {
  db: Database;
  env: Record<string, string | undefined>;
  /** Startup warnings, one JSON line each (the app's log sink; the Fastify logger is off). */
  log?: (line: string) => void;
  /** The signed-in person (console session), whatever workspace is selected; null signed out. */
  currentPerson(request: FastifyRequest): Promise<{ id: string } | null>;
  /** The workspace the console request acts in (own or a co-owned AI workspace). */
  currentWorkspace(request: FastifyRequest): Promise<{ id: string } | null>;
  /** The chain runtime: its wallet port (derivation, spender keys) and owner operations. */
  runtime(chainId: ChainId): Promise<ChainRuntime>;
  /** Whether a wallet holds anything on its chain. Absent: any wallet holds its agent there. */
  walletFunds?: WalletFunds;
  /** Tests: the deployments fixed in code (default protocolDeployment). */
  protocolDeploymentFor?: (chainId: number) => ProtocolDeployment | null;
  /** The wallet network's balance reader; absent when it is not configured (reads answer 503). */
  balances?: BalanceReader;
  /** An Arc network's balance reader, asked on first use; none when not configured (503). */
  arcBalances?: (chainId: number) => BalanceReader | undefined;
  /** Spend permissions on Base (W3); absent when it is not configured (views are stale). */
  permissions?: PermissionReader;
  /** The owner's revoke operations (W3); throws when the chain is not configured (503). */
  limitOperations?: () => Promise<OwnerRevokePort>;
  /** An Arc network's spend permissions, asked on first use; none when not configured (stale). */
  arcPermissions?: (chainId: number) => PermissionReader | undefined;
  /** An Arc network's revoke operations; throws when that chain is not configured (503). */
  arcLimitOperations?: (chainId: ChainId) => Promise<OwnerRevokePort>;
  /** The wallet network's ownerOf reader for Pay and Rate; absent when not configured (503). */
  payChain?: PayChainReader;
  /** An Arc network's ownerOf reader, asked on first use; none when not configured (503). */
  arcPayChain?: (chainId: number) => PayChainReader | undefined;
  /**
   * An Arc network's owner operations for ratings. A rating is one of them, and they aren't on Arc
   * yet: without this, ratings on Arc stay refused (not_on_arc_yet).
   */
  arcRatingOperations?: (chainId: ChainId) => Pick<WithdrawalService, 'rate'> | null;
  /**
   * Who screens an operation on an Arc chain: the sanctions oracle on Base (sanctionsOracleFor). None:
   * nothing on Arc is prepared or signed (fail closed).
   */
  arcScreeningProvider?: (chainId: number) => ScreeningProvider | null;
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
 * invented. Building them reads nothing. Every one of them falls back to the second read endpoint
 * (CITY_BASE_READ_FALLBACK_RPC_URL, else the public RPC when hosted; chain/read-transport.ts) when
 * the configured one cannot answer a read right now.
 */
export function walletReaders(
  env: Record<string, string | undefined>,
  options: { hosted?: boolean } = {},
): Pick<WalletRouteDeps, 'balances' | 'permissions' | 'payChain'> {
  const network = baseNetwork(WALLET_CHAIN_ID, env);
  const urls = network ? baseReadUrls(env[network.bundlerEnv], env, network.chainId, options) : [];
  if (!network || urls.length === 0) return {};
  return {
    balances: baseBalanceReader(urls, network),
    permissions: basePermissionReader(urls, network),
    payChain: payChainReader(urls, network),
  };
}

/**
 * The balance reader of an Arc network, or nothing for any other chain, with Arc off, or without its
 * endpoint. It sees Arc's settings only (arcRuntimeEnv), so Base's fallback endpoint is never asked,
 * and the reader checks the node's chain id before it reads.
 */
export function arcBalanceReader(
  chainId: number,
  env: Record<string, string | undefined>,
  options: { hosted?: boolean } = {},
): BalanceReader | undefined {
  if (chainFamily(chainId) !== 'arc') return undefined;
  const scoped = arcRuntimeEnv(env);
  const network = chainNetwork(chainId, scoped);
  const urls = network ? baseReadUrls(scoped[network.bundlerEnv], scoped, chainId, options) : [];
  return network && urls.length > 0 ? baseBalanceReader(urls, network) : undefined;
}

/** As arcBalanceReader, for spend permissions: Arc's settings, Arc's manager, its chain id checked. */
export function arcPermissionReader(
  chainId: number,
  env: Record<string, string | undefined>,
  options: { hosted?: boolean } = {},
): PermissionReader | undefined {
  if (chainFamily(chainId) !== 'arc') return undefined;
  const scoped = arcRuntimeEnv(env);
  const network = chainNetwork(chainId, scoped);
  const urls = network ? baseReadUrls(scoped[network.bundlerEnv], scoped, chainId, options) : [];
  return network && urls.length > 0 ? basePermissionReader(urls, network) : undefined;
}

/** As arcBalanceReader, for Pay's ownerOf: Arc's settings, Arc's registry, its chain id checked. */
export function arcPayChainReader(
  chainId: number,
  env: Record<string, string | undefined>,
  options: { hosted?: boolean } = {},
): PayChainReader | undefined {
  if (chainFamily(chainId) !== 'arc') return undefined;
  const scoped = arcRuntimeEnv(env);
  const network = chainNetwork(chainId, scoped);
  const urls = network ? baseReadUrls(scoped[network.bundlerEnv], scoped, chainId, options) : [];
  return network && urls.length > 0 ? payChainReader(urls, network) : undefined;
}

/**
 * An Arc chain's screening of payments: the gate over Arc's settings and the given provider (Base's
 * oracle), with an outage said out loud at most once per alert period.
 */
export function arcScreening(input: {
  db: Pick<Database, 'query'>;
  env: Record<string, string | undefined>;
  chainId: number;
  now: () => number;
  log: (line: string) => void;
  provider: () => ScreeningProvider | null;
  event: string;
  alertDetail: string;
}) {
  const { chainId, now, log } = input;
  const gate = createScreeningGate({
    db: input.db,
    env: arcRuntimeEnv(input.env),
    now,
    provider: input.provider,
  });
  // Refused with nothing but a code is how an outage goes unseen; every refusal would be too many.
  let screeningAlertedAt: number | null = null;
  const screeningWebhook = createFeedPayAlerts({ env: input.env, log });
  const screeningOutage = (reason: string) => {
    const at = Number(now());
    if (screeningAlertedAt !== null && at - screeningAlertedAt < FEED_PAY_SCREENING_ALERT_EVERY_MS)
      return;
    screeningAlertedAt = at;
    log(JSON.stringify({ event: input.event, level: 'ALERT', chainId, reason }));
    // The same webhook as Feed pay's outage, so someone hears it. It never stops a refusal.
    void screeningWebhook({
      kind: 'screening_unavailable',
      at,
      detail: `${input.alertDetail}:${reason}`,
    });
  };
  return async (request: ScreeningRequest) => {
    const decision = await gate.screen(request).catch((error: unknown) => {
      screeningOutage('gate_failed');
      throw error;
    });
    if (decision.outcome === 'unavailable') screeningOutage(decision.reason);
    return decision;
  };
}

/**
 * agentChainOf for many agents in one query (none with Arc off): the agents on Arc. An agent left out
 * is on the wallet network.
 */
export async function agentChainsOf(
  db: Pick<Database, 'query'>,
  env: Record<string, string | undefined>,
  agentIds: readonly string[],
): Promise<Map<string, ChainId>> {
  const chains = new Map<string, ChainId>();
  const arc = protocolArcChainIdFromEnv(env);
  if (arc === null || !agentIds.length) return chains;
  const { rows } = await db.query<{ agent_id: string }>(
    `SELECT w.agent_id FROM base_wallets w
     WHERE w.agent_id = ANY($1::text[]) AND w.chain_id IN ($2, $3)
     GROUP BY w.agent_id
     HAVING bool_or(w.chain_id = $3) AND (
       NOT bool_or(w.chain_id = $2) OR EXISTS (
         SELECT 1 FROM base_identities i
         WHERE i.agent_id = w.agent_id AND i.chain_id = $3 AND i.state <> 'failed'
       )
     )`,
    [agentIds, WALLET_CHAIN_ID, arc],
  );
  for (const row of rows) chains.set(row.agent_id, arc as ChainId);
  return chains;
}

/**
 * The chain an agent's wallet is on. Arc off: the wallet network, with no query. Arc on: the chain of
 * its wallet row, else the wallet network. An agent can hold a row on both (a wallet made on Base,
 * then a registration on Arc; or a failed Arc registration, then Base): Arc only when it has a live
 * identity there, since that's the chain the agent is on.
 */
export async function agentChainOf(
  db: Pick<Database, 'query'>,
  env: Record<string, string | undefined>,
  agentId: string,
): Promise<ChainId> {
  const arc = protocolArcChainIdFromEnv(env);
  if (arc === null) return WALLET_CHAIN_ID;
  const { rows } = await db.query<{ chain_id: number }>(
    'SELECT chain_id FROM base_wallets WHERE agent_id = $1 AND chain_id IN ($2, $3)',
    [agentId, WALLET_CHAIN_ID, arc],
  );
  const chains = rows.map((row) => Number(row.chain_id));
  if (!chains.includes(arc)) return WALLET_CHAIN_ID;
  if (!chains.includes(WALLET_CHAIN_ID)) return arc as ChainId;
  const identity = await db.query<{ chain_id: number }>(
    `SELECT chain_id FROM base_identities
     WHERE agent_id = $1 AND chain_id = $2 AND state <> 'failed' LIMIT 1`,
    [agentId, arc],
  );
  return identity.rows[0] ? (arc as ChainId) : WALLET_CHAIN_ID;
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
const walletBody = z.strictObject({ chainId: z.number().int().optional() });

/**
 * An agent registered on Base before it had a vault wallet: its wallet there is the
 * registration's, owned by the address typed at registration, with no owner account. Unless that
 * address is the person's own vault key it is never shown or used as the agent's wallet here
 * (GET: kind 'registered_elsewhere' with that wallet's public address and its owner address, no
 * balance, no Base read; POST: 409 wallet_registered_elsewhere). Nothing is adopted or rebound.
 */
export const REGISTERED_ELSEWHERE =
  "This agent's Base ID is held by the owner wallet you used when registering it. Connecting that wallet to Central City comes next.";

/** A chain as the wallet answers name it; only ever asked for a chain listed in shared/chains.ts. */
const shownChain = (chainId: ChainId) => chainView(chainId) as ChainView;

const registeredElsewhereMessage = (chainId: ChainId) =>
  REGISTERED_ELSEWHERE.replace('Base ID', `${shownChain(chainId).name} ID`);

/**
 * Every route under this path still works on Base's row only (ratings, service calls), unless
 * followsAgentChain says otherwise: the next slice's work list.
 */
export const NOT_ON_ARC_YET_PREFIX = '/api/base/agents/:agentId/wallet/';

/**
 * The routes under that prefix that work on the agent's chain: limits, the agent-pay consent,
 * withdrawals, payments and the payment history. By exact path: nothing joins by starting alike.
 */
export const followsAgentChain = (url: string) =>
  url === LIMITS_PATH ||
  url.startsWith(`${LIMITS_PATH}/`) ||
  url === AGENT_PAY_PATH ||
  url === WITHDRAWALS_PATH ||
  url.startsWith(`${WITHDRAWALS_PATH}/`) ||
  url === PAY_PATHS.payments ||
  url === PAY_PATHS.agentPayments ||
  url === FEED_PAY_PATHS.history;

/** The rating routes: on an agent's chain once that chain's owner operations exist. */
const isRatingRoute = (url: string) =>
  url === RATE_PATHS.ratings || url.startsWith(`${RATE_PATHS.ratings}/`);

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
  const arcCaches = new Map<number, ReturnType<typeof balanceCache>>();
  /** The balance cache of one chain; Arc's built on first use, a missing setting not remembered. */
  const cacheOn = (chainId: ChainId) => {
    if (chainFamily(chainId) !== 'arc') return cache;
    const known = arcCaches.get(chainId);
    if (known) return known;
    const reader = deps.arcBalances?.(chainId);
    if (!reader) return null;
    const built = balanceCache(reader, { now });
    arcCaches.set(chainId, built);
    return built;
  };
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
  const registeredJson = (row: { address: string; owner_address: string }, chainId: ChainId) => ({
    kind: 'registered_elsewhere' as const,
    address: getAddress(row.address),
    ownerAddress: getAddress(row.owner_address),
    chainId,
    network: shownChain(chainId).name,
    testnet: !isRealMoneyChain(chainId),
    code: 'wallet_registered_elsewhere',
    message: registeredElsewhereMessage(chainId),
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
    chainId: ChainId,
  ) => ({
    chainId,
    network: shownChain(chainId).name,
    testnet: !isRealMoneyChain(chainId),
    address: unlocked ? row.address : null,
    ownerAddress: row.owner_address,
    /** The agent's spending key: the only spender a limit of this wallet may name (W3). */
    spenderAddress: row.spender_address,
    fundingLocked: !unlocked,
    explorerUrl: unlocked ? `${shownChain(chainId).explorerUrl}/address/${row.address}` : null,
  });

  app.post('/api/base/agents/:agentId/wallet', async (request, reply) => {
    if (!enabled()) return notFound(reply);
    const owned = await ownedAgent(request);
    if (!owned.ok) return reply.code(owned.code).send({ error: 'Not found.' });
    const body = walletBody.safeParse(request.body ?? {});
    if (!body.success)
      return reply.code(400).send({
        error: 'The wallet takes only a chain: its owner is set by Central City.',
        code: 'invalid_body',
      });
    // The owner is the person's vault key, never an address from the request.
    const vault = await vaults.owner(owned.accountId);
    if (!vault)
      return reply
        .code(409)
        .send({ error: 'Set up your wallet vault first.', code: 'vault_missing' });
    // The chain picked before the wallet is made, as the registration would be asked for it. Not
    // an offered chain: the agent's own, as with no chain at all.
    const chosen = body.data.chainId;
    const current = await agentChainOf(deps.db, deps.env, owned.agentId);
    const chainId =
      chosen !== undefined && chosen !== current && registrationChainOn(chosen, deps.env)
        ? (chosen as ChainId)
        : current;
    if (chainId !== current) {
      const holding = await chainHolding(deps.db, deps.walletFunds, owned.agentId, chainId);
      if (holding !== null)
        return reply.code(409).send({
          error: 'This agent is already on another chain. An agent has one chain for now.',
          code: 'other_chain',
          details: { chainId: holding, name: chainView(holding)?.name ?? null },
        });
    }
    let runtime: ChainRuntime;
    try {
      runtime = await deps.runtime(chainId);
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
        chainId,
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
        chainId,
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
          [owned.agentId, chainId],
        );
        if (rows[0] && registeredElsewhere(rows[0], vault.ownerAddress))
          return reply.code(409).send({
            error: registeredElsewhereMessage(chainId),
            code: 'wallet_registered_elsewhere',
          });
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
    const chainId = await agentChainOf(deps.db, deps.env, owned.agentId);
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
      [owned.agentId, chainId, owned.workspaceId],
    );
    const row = rows[0];
    if (!row) return { wallet: null };
    // A registration's wallet is not this person's vault wallet unless their vault key holds it
    // (then POST adopts it): no address, no balance, nothing to withdraw or pay from.
    if (
      row.owner_account_id === null &&
      registeredElsewhere(row, (await vaults.owner(owned.accountId))?.ownerAddress ?? null)
    )
      return registeredJson(row, chainId);
    const unavailable = () =>
      reply.code(503).send({
        error: `${shownChain(chainId).name} could not be read.`,
        code: 'chain_unavailable',
        // Base's answer stays as it was; on Arc the screen says which chain isn't answering.
        ...(chainFamily(chainId) === 'arc' ? { details: { chainId } } : {}),
      });
    const chainCache = cacheOn(chainId);
    if (!chainCache) return unavailable();
    let read;
    try {
      read = await chainCache.read(row.address as Address);
    } catch (error) {
      if (error instanceof ChainUnavailableError) return unavailable();
      throw error;
    }
    const json = walletJson(row, row.backup_confirmed_at !== null, chainId);
    const onArc = chainFamily(chainId) === 'arc';
    return {
      chainId: json.chainId,
      network: json.network,
      testnet: json.testnet,
      address: json.address,
      ownerAddress: json.ownerAddress,
      spenderAddress: json.spenderAddress,
      deployed: read.balances.deployed,
      fundingLocked: json.fundingLocked,
      usdc: amount(read.balances.usdc, (usdcOf(chainId) ?? NETWORK.tokens.USDC).decimals),
      // On Arc the native balance is this same USDC at 18 decimals, so it's never shown as a second
      // figure. The field stays, at zero, because the client's type requires it; gasAsset says why.
      eth: amount(onArc ? 0n : read.balances.eth, ETH_TOKEN.decimals),
      ...(onArc ? { gasAsset: 'USDC' as const } : {}),
      readAtBlock: Number(read.balances.blockNumber),
      readAt: read.readAt,
      stale: read.stale,
      explorerUrl: json.explorerUrl,
    };
  });

  const arcRates = new Map<ChainId, RateService>();
  /**
   * Ratings on one Arc network, built on first use: its registries, its reader and its owner
   * operations. Null while any of them is missing, and then the route is refused below.
   */
  const arcRateService = (chainId: ChainId): RateService | null => {
    const known = arcRates.get(chainId);
    if (known) return known;
    const network = chainNetwork(chainId, arcRuntimeEnv(deps.env));
    const withdrawals = deps.arcRatingOperations?.(chainId) ?? arcServicesOn(chainId)?.withdrawals;
    const chain = deps.arcPayChain?.(chainId);
    if (!network || !withdrawals || !chain) return null;
    const built = createRateService({
      db: deps.db,
      withdrawals,
      chain,
      network,
      dailyMax: () => rateDailyMax(deps.env),
      now,
    });
    arcRates.set(chainId, built);
    return built;
  };

  // Arc on: an Arc agent is refused on every route below the wallet that still works on Base's row,
  // and on routes that other modules add under that path later (service calls). A hook, because the
  // refusal must come before each route's own service, and new routes there are refused by default.
  // Its owner gets 409; anyone else 404, as the routes answer, so an agent's chain is not disclosed.
  // The routes followsAgentChain names go on to their own service, unless Arc's network isn't
  // complete yet.
  app.addHook('preHandler', async function refuseArcAgents(request, reply) {
    const url = request.routeOptions?.url;
    if (!url?.startsWith(NOT_ON_ARC_YET_PREFIX)) return;
    if (!enabled() || protocolArcChainIdFromEnv(deps.env) === null) return;
    const person = await personOf(request);
    const parsed = params.safeParse(request.params);
    // The route answers these itself.
    if (!person.ok || !parsed.success) return;
    const chainId = await agentChainOf(deps.db, deps.env, parsed.data.agentId);
    if (chainFamily(chainId) !== 'arc') return;
    if (followsAgentChain(url) && chainNetwork(chainId, arcRuntimeEnv(deps.env))) return;
    if (isRatingRoute(url) && arcRateService(chainId)) return;
    const workspace = await deps.currentWorkspace(request).catch(() => null);
    const { rows } = await deps.db.query(
      `SELECT 1 FROM base_wallets
       WHERE agent_id = $1 AND chain_id = $2 AND (owner_account_id = $3 OR operator_id = $4)`,
      [parsed.data.agentId, chainId, person.accountId, workspace?.id ?? null],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Not found.' });
    return reply.code(409).send({
      error: `This isn't available for agents on ${shownChain(chainId).name} yet.`,
      code: 'not_on_arc_yet',
    });
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
    // Central City's proven fleet accounts (sponsor-operators.ts): not held to the per-account
    // unsigned caps.
    operatorAccounts: sponsorOperatorAccounts,
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
  // Setting names and defaults only (audit CCA-515: never to the disabled Fastify logger).
  const log = deps.log ?? ((line: string) => console.warn(line));
  for (const warning of sponsorBudgetWarnings(deps.env))
    log(JSON.stringify({ event: 'sponsor_budget_setting', level: 'warn', message: warning }));

  /**
   * Withdrawals and payments on an Arc chain, built on first use from Arc's settings alone (no Base
   * fallback, lanes or sponsor setting reaches them). Null while Arc's off or its network incomplete.
   * Building reads nothing and asks no runtime; a missing reader isn't remembered.
   */
  const arcOwnerServices = new Map<
    ChainId,
    { withdrawals: WithdrawalService; payments: PayService }
  >();
  const arcServicesOn = (chainId: ChainId) => {
    const known = arcOwnerServices.get(chainId);
    if (known) return known;
    const scoped = arcRuntimeEnv(deps.env);
    const network = chainNetwork(chainId, scoped);
    if (!network) return null;
    const balances = deps.arcBalances?.(chainId);
    const chain = deps.arcPayChain?.(chainId);
    const screen = arcScreening({
      db: deps.db,
      env: deps.env,
      chainId,
      now,
      log,
      provider: () => deps.arcScreeningProvider?.(chainId) ?? null,
      event: 'withdrawal.screening_unavailable',
      alertDetail: `withdrawals_chain_${chainId}`,
    });
    const arcWithdrawals: WithdrawalService = createWithdrawalService({
      db: deps.db,
      chain: {
        network,
        // This deployment's own contracts on Arc, not in the registry. Router 3 from where the ledger
        // takes it, and the setting too: a router it no longer reads still loses what it's sent.
        refusedDestinations: [
          ownPaymasterAddress(scoped),
          protocolArcRouter3Address(deps.env, chainId, deps.protocolDeploymentFor),
          scoped.CITY_PROTOCOL_FEE_ROUTER3,
        ]
          .map((address) => address?.trim())
          .filter((address) => address && /^0x[0-9a-fA-F]{40}$/.test(address)),
        // Arc's own server keys (facilitator, paymaster signer, submitters), from their key rows.
        ownKeyAddresses: async () => {
          const runtime = await deps.runtime(chainId);
          if (!runtime.protocolKeyAddresses) throw new Error('Key addresses are not available.');
          return runtime.protocolKeyAddresses();
        },
      },
      screen,
      operations: async () => {
        const runtime = await deps.runtime(chainId);
        if (!runtime.arcOwnerOperations) throw new Error('Owner operations are not configured.');
        return runtime.arcOwnerOperations();
      },
      balances,
      finalized: (tx, final) => arcPayments.finalized(tx, final),
      sponsoredOnly: (withdrawalId) => arcPayments.isPayment(withdrawalId),
      sponsorBudget: () => sponsorBudget(arcRuntimeEnv(deps.env), chainId),
      operatorAccounts: sponsorOperatorAccounts,
      now,
    });
    const arcPayments: PayService = createPayService({
      db: deps.db,
      withdrawals: arcWithdrawals,
      chain,
      network,
      // Agents only on Arc: Base's setting for paying any address doesn't reach it.
      anyAddress: () => false,
      now,
    });
    const built = { withdrawals: arcWithdrawals, payments: arcPayments };
    if (balances && chain) arcOwnerServices.set(chainId, built);
    return built;
  };
  /** The withdrawals of the agent's chain. refuseArcAgents answers first for a chain not complete. */
  const withdrawalsOf = async (agentId: string): Promise<WithdrawalService> => {
    const chainId = await agentChainOf(deps.db, deps.env, agentId);
    if (chainFamily(chainId) !== 'arc') return withdrawals;
    const services = arcServicesOn(chainId);
    if (!services) throw new Error('Arc is not configured.');
    return services.withdrawals;
  };
  const paymentsOf = async (agentId: string): Promise<PayService> => {
    const chainId = await agentChainOf(deps.db, deps.env, agentId);
    if (chainFamily(chainId) !== 'arc') return payments;
    const services = arcServicesOn(chainId);
    if (!services) throw new Error('Arc is not configured.');
    return services.payments;
  };
  /**
   * The sweep: each chain's rows with that chain's service, side by side, so Arc's never holds up
   * Base's. Whatever Arc's does (fails, or has no end) the answer waits only for Base's and the budget.
   */
  async function sweepAllChains(budgetMs?: number) {
    const arcId = protocolArcChainIdFromEnv(deps.env);
    const arc = arcId === null ? null : arcServicesOn(arcId as ChainId);
    if (!arc) return withdrawals.sweep(budgetMs);
    const arcRun = arc.withdrawals.sweep(budgetMs).catch(() => {
      log(JSON.stringify({ event: 'wallet_sweep_chain_failed', level: 'warn', chainId: arcId }));
      return null;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arcOrBudget = Promise.race([
      arcRun,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs ?? SWEEP_BUDGET_MS);
        timer.unref?.();
      }),
    ]);
    try {
      const [base, other] = await Promise.all([withdrawals.sweep(budgetMs), arcOrBudget]);
      return other
        ? { expired: base.expired + other.expired, advanced: base.advanced + other.advanced }
        : base;
    } finally {
      clearTimeout(timer);
    }
  }
  registerWithdrawalRoutes(app, {
    cronSecret: deps.cronSecret,
    enabled,
    lanes: () => lanesEnabled(deps.env),
    person: personOf,
    service: {
      create: async (accountId, agentId, input) =>
        (await withdrawalsOf(agentId)).create(accountId, agentId, input),
      read: async (accountId, agentId, withdrawalId) =>
        (await withdrawalsOf(agentId)).read(accountId, agentId, withdrawalId),
      open: async (accountId, agentId) => (await withdrawalsOf(agentId)).open(accountId, agentId),
      sign: async (accountId, agentId, withdrawalId, input) =>
        (await withdrawalsOf(agentId)).sign(accountId, agentId, withdrawalId, input),
      cancel: async (accountId, agentId, withdrawalId) =>
        (await withdrawalsOf(agentId)).cancel(accountId, agentId, withdrawalId),
      signCancel: async (accountId, agentId, withdrawalId, input) =>
        (await withdrawalsOf(agentId)).signCancel(accountId, agentId, withdrawalId, input),
      sweep: sweepAllChains,
    },
    limit: deps.limit,
  });
  registerPayRoutes(app, {
    enabled,
    person: personOf,
    service: {
      ...payments,
      create: async (accountId, agentId, input) =>
        (await paymentsOf(agentId)).create(accountId, agentId, input),
    },
    // Only the Arc chain that is on and complete; anything else is refused like an unknown parameter.
    onChain: (chainId) =>
      chainId === protocolArcChainIdFromEnv(deps.env)
        ? (arcServicesOn(chainId as ChainId)?.payments ?? null)
        : null,
    limit: deps.limit,
  });
  // Rate: a rating is an owner operation of the rater's wallet (sponsored, no money moves).
  const baseRates = createRateService({
    db: deps.db,
    withdrawals,
    chain: deps.payChain,
    // CITY_BASE_RATE_DAILY_MAX, read per request (100 when unset or not a whole number from 1).
    dailyMax: () => rateDailyMax(deps.env),
    now,
  });
  const ratesOf = async (agentId: string): Promise<RateService> => {
    const chainId = await agentChainOf(deps.db, deps.env, agentId);
    if (chainFamily(chainId) !== 'arc') return baseRates;
    const service = arcRateService(chainId);
    // refuseArcAgents answers first; only a setting changed in between gets here.
    if (!service) throw new Error('Arc is not configured.');
    return service;
  };
  registerRateRoutes(app, {
    // Off unless CITY_BASE_RATE is exactly '1' too; read per request.
    enabled: () => enabled() && rateEnabled(deps.env),
    person: personOf,
    service: {
      status: async (accountId, agentId) => (await ratesOf(agentId)).status(accountId, agentId),
      given: async (accountId, agentId) => (await ratesOf(agentId)).given(accountId, agentId),
      lookup: async (accountId, agentId, input) =>
        (await ratesOf(agentId)).lookup(accountId, agentId, input),
      create: async (accountId, agentId, input) =>
        (await ratesOf(agentId)).create(accountId, agentId, input),
    },
    limit: deps.limit,
  });

  // W3: authorized by the wallet's owner account, not by current agent access (v1.1 gate 3). The
  // on-chain model of new limits is one server setting: 'half' (default) or 'full'. Arc doesn't read
  // Base's setting, so its limits are 'half'.
  const baseLimits = createLimitService({
    db: deps.db,
    chainId: WALLET_CHAIN_ID,
    model: onchainCapModel(deps.env.CITY_BASE_LIMIT_ONCHAIN_MODEL),
    permissions: deps.permissions,
    operations: deps.limitOperations,
    now,
  });
  const arcLimits = new Map<ChainId, LimitService>();
  /** The limit service of one chain; Arc's built on first use, a missing reader not remembered. */
  const limitsOn = (chainId: ChainId) => {
    if (chainFamily(chainId) !== 'arc') return baseLimits;
    const known = arcLimits.get(chainId);
    if (known) return known;
    const scoped = arcRuntimeEnv(deps.env);
    const network = chainNetwork(chainId, scoped);
    // refuseArcAgents answers first; only a setting changed in between gets here.
    if (!network) throw new Error('Arc is not configured.');
    const permissions = deps.arcPermissions?.(chainId);
    const built = createLimitService({
      db: deps.db,
      chainId,
      network,
      model: onchainCapModel(scoped.CITY_BASE_LIMIT_ONCHAIN_MODEL),
      permissions,
      operations: deps.arcLimitOperations && (() => deps.arcLimitOperations!(chainId)),
      now,
    });
    if (permissions) arcLimits.set(chainId, built);
    return built;
  };
  const limitsOf = async (agentId: string) =>
    limitsOn(await agentChainOf(deps.db, deps.env, agentId));
  const limits: LimitService = {
    list: async (accountId, agentId) => (await limitsOf(agentId)).list(accountId, agentId),
    prepare: async (accountId, agentId, body) =>
      (await limitsOf(agentId)).prepare(accountId, agentId, body),
    store: async (accountId, agentId, body) =>
      (await limitsOf(agentId)).store(accountId, agentId, body),
    revoke: async (accountId, agentId, permissionId, body) =>
      (await limitsOf(agentId)).revoke(accountId, agentId, permissionId, body),
    signRevoke: async (accountId, agentId, permissionId, body) =>
      (await limitsOf(agentId)).signRevoke(accountId, agentId, permissionId, body),
  };
  registerLimitRoutes(app, { enabled, person: personOf, service: limits, limit: deps.limit });

  // P2b: the owner's consent that this agent may pay on its own (nothing pays with it yet). One
  // service per chain; building one reads nothing.
  const consents = new Map<ChainId, AgentPayConsentService>();
  const consentOf = async (agentId: string) => {
    const chainId = await agentChainOf(deps.db, deps.env, agentId);
    let service = consents.get(chainId);
    if (!service) {
      service = createAgentPayConsentService({ db: deps.db, chainId, now, env: deps.env });
      consents.set(chainId, service);
    }
    return service;
  };
  registerAgentPayRoutes(app, {
    enabled,
    person: personOf,
    service: {
      view: async (accountId, agentId) => (await consentOf(agentId)).view(accountId, agentId),
      grant: async (accountId, agentId, body) =>
        (await consentOf(agentId)).grant(accountId, agentId, body),
      revoke: async (accountId, agentId) => (await consentOf(agentId)).revoke(accountId, agentId),
    },
  });

  // P2d: the payments the agent made on its own, read only (the wallet's owner account alone). One
  // history per chain; building one reads nothing.
  const baseHistory = createAgentPayHistory({ db: deps.db });
  const arcHistories = new Map<ChainId, AgentPayHistory>();
  const historyOf = async (agentId: string) => {
    const chainId = await agentChainOf(deps.db, deps.env, agentId);
    if (chainFamily(chainId) !== 'arc') return baseHistory;
    const network = chainNetwork(chainId, arcRuntimeEnv(deps.env));
    // refuseArcAgents answers first; only a setting changed in between gets here.
    if (!network) throw new Error('Arc is not configured.');
    let history = arcHistories.get(chainId);
    if (!history) {
      history = createAgentPayHistory({ db: deps.db, network });
      arcHistories.set(chainId, history);
    }
    return history;
  };
  registerAgentPayHistoryRoutes(app, {
    enabled,
    person: personOf,
    history: {
      list: async (accountId, agentId) => (await historyOf(agentId)).list(accountId, agentId),
    },
  });
}
