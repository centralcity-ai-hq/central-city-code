/*
 * The chain runtime for one network: the RPC and bundler client, the keystore, the stores, and the
 * wallet and identity ports built on them. It refuses to start when any setting is missing, so the
 * routes that need it answer "unavailable" instead of running half-configured:
 *
 *   <network bundlerEnv>            CDP endpoint (JSON-RPC node + ERC-4337 bundler + ERC-7677
 *                                    paymaster in one URL, e.g. CITY_BASE_CDP_RPC_URL on mainnet)
 *   CITY_BASE_SPENDER_KEK           key-encryption keys for spender keys (see keystore.ts)
 *   CITY_BASE_MAX_FEE_PER_GAS_WEI   hard cap on maxFeePerGas; above it nothing is signed
 *   CITY_BASE_IDENTITY_FEE_CAP_WEI  fee budget per identity operation (mandatory on mainnet)
 *   CITY_BASE_WALLET_FEE_CAP_WEI    cost cap per owner wallet operation and per agent payment,
 *                                    wallet network only (mandatory on mainnet): missing there, or
 *                                    malformed anywhere, neither owner operations nor agent payments
 *                                    are built (the wallet routes answer 503 chain_unavailable, an
 *                                    agent payment unavailable) and nothing else of the runtime
 *                                    changes
 *   CITY_FEED_PAY_CDP_RPC_URL       optional: Feed pay's own CDP endpoint (a separate CDP project
 *                                    and key, https only), so bulk registrations on the shared
 *                                    endpoint never rate-limit paid calls. Set, the Feed pay port
 *                                    (node reads, bundler, paymaster, its balance reads, receipts
 *                                    and finality) and Feed pay's screening oracle reads use it,
 *                                    with the same read fallback, retry, fee cap, stub signature and
 *                                    sponsors; its requests count as 'feedpay:*' and
 *                                    'feedpay-bundler:configured' (rpc-count.ts). Unset, Feed pay
 *                                    uses the network endpoint as before. Set but not https, only
 *                                    Feed pay refuses (ChainRuntimeError naming the setting);
 *                                    identity, wallet, agent payments and the fee scan never use it.
 *
 * No setting value (they contain keys) ever appears in an error message or a log line. The fee
 * settings are named per chain, in that chain's gas asset (chain-params.ts).
 *
 * Reads only fall back to a second endpoint (CITY_BASE_READ_FALLBACK_RPC_URL, else the network's
 * public RPC when hosted; read-transport.ts): the shared client's pinned reads, blocks, receipts and
 * logs. The bundler and paymaster (rpc-bundler.ts posts to the CDP URL itself), nonce and other
 * unpinned reads that feed an operation, and the bare head number behind submit.ts's absence gates
 * stay on the CDP endpoint only. The identity port's evidence reads, the fee quotes and the head
 * hints ask the second endpoint first (presence only, bounded in time, tagged heads only while
 * recent; see `identityClient` below). Payments and owner operations, their fee quotes included,
 * read CDP first.
 */
import {
  chainFamily,
  chainNetwork,
  isRealMoneyChain,
  type ChainId,
} from '../../../shared/chains.js';
import { arcRuntimeEnv } from './arc-env.js';
import { createPublicClient, parseAbi, parseAbiItem, serializeTransaction, type Hex } from 'viem';
import { batchWorkspacesFromEnv, router3AddressFromEnv } from '../../feed/pay/router3.js';
import {
  protocolArcFeeConfigFromEnv,
  protocolReservedPayees,
  protocolTreasuryFor,
} from '../../protocol/fees/cron.js';
import { createSponsorSigner, pgSponsorReservations } from '../../feed/pay/sponsor-signer.js';
import { SFP_SPONSOR_KEY_REF_SETTING } from '../../feed/pay/sponsor-key.js';
import type { SponsorEthChain } from '../../feed/pay/sponsor-eth-sweep.js';
import {
  SPONSORED_KEY_PREFIX,
  sponsoredSenderMinEthWei,
  sponsoredSendsViaFacilitator,
  type SponsorPay,
} from '../../feed/pay/sponsored.js';
import {
  createRouter3Facilitator,
  FacilitatorError,
  FEE_CAPS,
  GAS_PRICE_ORACLE,
  type FacilitatorBatchConfig,
  type FacilitatorBatchGroup,
  usdcPerEthFromEnv,
} from '../../protocol/x402/facilitator.js';
import { PUBLIC_SETTLE_MAX_L1_FEE_WEI } from '../../protocol/x402/public-settle.js';
import type { PublicOfferLane } from '../../feed/offers/public-pay.js';
import type { Database } from '../../database.js';
import {
  BASE_MAINNET,
  baseNetwork,
  type Address,
  type BaseChainId,
} from '../../../shared/base/chains.js';
import type { ChainRuntime } from '../identity/routes.js';
import { baseBalanceReader, reservationBalanceOf } from './balances.js';
import { chainParams } from './chain-params.js';
import { createIdentityChainPort } from './identity-port.js';
import { createKeystore, parseKeks, parseKeyRef } from './keystore.js';
import { createOwnerOperationsPort, type OwnerOperationsPort } from './owner-ops.js';
import { agentPaymentChain } from './payment-chain.js';
import { createReservationLedger } from './reservations.js';
import { WALLET_CHAIN_ID } from '../../../shared/base/wallet-network.js';
import { walletSignature } from './permissions.js';
import { createWalletChainPort } from './port.js';
import { BUNDLER_429_WAITS_MS, BundlerError, rpcBundler } from './rpc-bundler.js';
import { bundlerChoice, createDirectBundler, lazyBundler } from './direct-bundler.js';
import {
  ownPaymasterAddress,
  ownPaymasterMode,
  PAYMASTER_SIGNER_KEY_REF_SETTING,
  SUBMITTER_KEY_REFS_SETTING,
} from './own-paymaster-keys.js';
import { createHotWalletWatch, hotWalletCeilingsFromEnv } from './hot-wallets.js';
import { arcFacilitatorKeyUsable, arcPaymasterKeysUsable, roleKeyUsable } from './key-roles.js';
import type { Bundler } from './submit.js';
import { blockTagCache, CDP_RETRY, MAX_LOG_RANGE_BLOCKS, withLiveReads } from './rpc-budget.js';
import { baseReadTransport, baseReadUrls, secureEndpoint } from './read-transport.js';
import { pgAuthorizationStore, pgChainOperationStore, pgSpenderKeyStore } from './stores.js';
import { createFeedPayChain } from './feed-pay-chain.js';
import { SPONSOR_PAYMASTERS } from '../../../shared/base/paymasters.js';

export class ChainRuntimeError extends Error {
  constructor(readonly setting: string) {
    super(`Base chain runtime is not configured (${setting}).`);
  }
}

const POSITIVE_INT = /^[1-9][0-9]{0,77}$/;

/** How long a head hint (identity service settling gate) is shared across rows and runs. */
export const HINT_TTL_MS = 10_000;

/** The setting that bounds every owner wallet operation on Base (required on mainnet). */
export const WALLET_FEE_CAP_SETTING = chainParams(BASE_MAINNET).settings.walletFeeCap;

/** A whole number from env within [min, max], else the fallback. */
function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw?.trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ChainRuntimeError(name);
  return value;
}

function positive(env: Record<string, string | undefined>, name: string): bigint {
  const value = required(env, name);
  if (!POSITIVE_INT.test(value)) throw new ChainRuntimeError(name);
  return BigInt(value);
}

/**
 * The cost cap of one owner wallet operation, or null when owner operations must not be built.
 * Real money is never spent without a fee budget, so on mainnet the cap is required; a malformed
 * value refuses on any network. A refusal takes owner operations only: the runtime this network
 * shares with registrations (identity, wallet derivation) is never taken down by a wallet setting.
 */
export function walletFeeCap(
  env: Record<string, string | undefined>,
  chainId: number,
): { cap: bigint | undefined } | null {
  const params = chainParams(chainId);
  const value = env[params.settings.walletFeeCap]?.trim();
  if (!value) return params.feeBudgetRequired ? null : { cap: undefined };
  return POSITIVE_INT.test(value) ? { cap: BigInt(value) } : null;
}

/**
 * The hard cap on maxFeePerGas: its chain's setting, required. A cap under the chain's fee floor
 * would refuse or drop every transaction, so it is refused like a missing setting.
 */
export function maxFeePerGasCapFromEnv(
  env: Record<string, string | undefined>,
  chainId: number,
): bigint {
  const params = chainParams(chainId);
  const cap = positive(env, params.settings.maxFeePerGas);
  if (cap < params.minMaxFeePerGasWei) throw new ChainRuntimeError(params.settings.maxFeePerGas);
  return cap;
}

/** The fee budget of one identity operation; real money is never spent without one. */
export function identityFeeCapFromEnv(
  env: Record<string, string | undefined>,
  chainId: number,
): bigint | undefined {
  const params = chainParams(chainId);
  const setting = params.settings.identityFeeCap;
  return params.feeBudgetRequired || env[setting] ? positive(env, setting) : undefined;
}

/** Feed pay's own CDP endpoint (optional; see the module header). */
export const FEED_PAY_CDP_SETTING = 'CITY_FEED_PAY_CDP_RPC_URL';

/**
 * Feed pay's own endpoint: `{ url: undefined }` when unset (Feed pay shares the network endpoint),
 * `{ url }` for an https URL, null when set to anything else (Feed pay is refused, nothing else).
 */
export function feedPayCdpUrl(
  env: Record<string, string | undefined>,
): { url: string | undefined } | null {
  const value = env[FEED_PAY_CDP_SETTING]?.trim();
  if (!value) return { url: undefined };
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname && !/\s/.test(value)
      ? { url: value }
      : null;
  } catch {
    return null;
  }
}

/**
 * The stub signature smart accounts present for gas estimation: a Coinbase Smart Wallet
 * SignatureWrapper around a well-formed 65-byte ECDSA signature (never a real one).
 */
function estimationStub(): Hex {
  return walletSignature(`0x${'ff'.repeat(64)}1c` as Hex, { ownerIndex: 0 });
}

/** The per-minute request count keys of Feed pay's own endpoint (rpc-count.ts). */
export const FEED_PAY_READ_PURPOSE = 'feedpay';
export const FEED_PAY_BUNDLER_COUNT_KEY = 'feedpay-bundler:configured';

/**
 * Feed pay's chain parts on its own endpoint (CITY_FEED_PAY_CDP_RPC_URL): the read client, the
 * bundler and paymaster, the balance reads and the reservation ledger's balance read, in the same
 * pattern as the runtime's shared client (read fallback, CDP_RETRY, head cache, fee cap, stub
 * signature), counted under their own keys. Reservations stay in the one table: the ledger's state
 * is the database, only its balance read moves.
 */
export function feedPayEndpoint(input: {
  url: string;
  env: Record<string, string | undefined>;
  network: NonNullable<ReturnType<typeof baseNetwork>>;
  hosted?: boolean;
  maxFeePerGasCap: bigint;
}) {
  const { url, network } = input;
  const readUrls = baseReadUrls(url, input.env, network.chainId, { hosted: input.hosted });
  const chain = {
    id: network.chainId,
    name: network.name,
    nativeCurrency: chainParams(network.chainId).nativeCurrency,
    rpcUrls: { default: { http: [url] } },
  };
  const transport = () =>
    baseReadTransport(readUrls, {
      chainId: network.chainId,
      retry: CDP_RETRY,
      purpose: FEED_PAY_READ_PURPOSE,
    });
  const client = withLiveReads(
    createPublicClient({ chain, transport: blockTagCache(transport()) }),
    createPublicClient({ chain, transport: transport() }),
  );
  const balances = baseBalanceReader(readUrls, network, undefined, FEED_PAY_READ_PURPOSE);
  return {
    client,
    bundler: rpcBundler({
      url,
      entryPoint: network.contracts.entryPointV06,
      chainId: network.chainId,
      client,
      maxFeePerGasCap: input.maxFeePerGasCap,
      stubSignature: estimationStub(),
      countKey: FEED_PAY_BUNDLER_COUNT_KEY,
      // A paid call rides out a rate-limited minute instead of failing (rpc-bundler.ts).
      rateLimitWaitsMs: BUNDLER_429_WAITS_MS,
    }),
    balances,
    ledger: createReservationLedger({
      chainId: network.chainId,
      balanceOf: reservationBalanceOf(balances, network),
    }),
  };
}

/**
 * The sponsored first purchase's batch settings (CITY_SFP_BATCH_*): at most 50 per settleBatch, a
 * 1.5 s window. Sponsored members carry no MCP grant to revalidate (grant null), and wait for the
 * next submit or the worker cron's flush: the 10 s default refused them as too old (canary 22 Oct,
 * REFUSED_BEFORE_BROADCAST). 2 min, well inside the legs' 600 s window; authorize() still checks
 * each member right before signing.
 */
export function sponsoredBatchFromEnv(env: Record<string, string | undefined>) {
  return {
    maxItems: boundedInt(env.CITY_SFP_BATCH_MAX, 50, 2, 200),
    windowMs: boundedInt(env.CITY_SFP_BATCH_WINDOW_MS, 1_500, 200, 30_000),
    maxMemberAgeMs: boundedInt(env.CITY_SFP_BATCH_MEMBER_AGE_MS, 120_000, 10_000, 300_000),
  };
}

/**
 * The router-3 facilitator's batch config. The engine's batch lane only while an allowlist is set
 * (CITY_PAY_BATCH_WORKSPACES; room Stress Test #200), its size and window from env, defaults 50 and
 * 1.5 s, its member age the facilitator's default. With CITY_SFP_SEND_VIA_FACILITATOR the sponsored
 * settlements are their own batch group ('sfp:' keys, sponsoredBatchFromEnv), and without an engine
 * allowlist ONLY that group batches (groupsOnly): every engine settlement is then sent alone,
 * exactly as without a batch config. Neither: no batch config, as before.
 */
export function router3BatchFromEnv(
  env: Record<string, string | undefined>,
): FacilitatorBatchConfig | undefined {
  const engine = batchWorkspacesFromEnv(env).size > 0;
  const sponsored = sponsoredSendsViaFacilitator(env);
  if (!engine && !sponsored) return undefined;
  const group: FacilitatorBatchGroup = {
    keyPrefix: SPONSORED_KEY_PREFIX,
    ...sponsoredBatchFromEnv(env),
  };
  return {
    maxItems: boundedInt(env.CITY_PAY_BATCH_MAX, 50, 2, 200),
    windowMs: boundedInt(env.CITY_PAY_BATCH_WINDOW_MS, 1_500, 200, 30_000),
    ...(sponsored ? { groups: [group], ...(engine ? {} : { groupsOnly: true }) } : {}),
  };
}

export function createChainRuntime(deps: {
  db: Database;
  env: Record<string, string | undefined>;
  chainId: ChainId;
  /** The network owner operations are built on; the wallet network (wallet-network.ts) by default. */
  walletChainId?: ChainId;
  /** Hosted: reads fall back to the network's public RPC when no second endpoint is set. */
  hosted?: boolean;
  /** The app's log sink (logLine); the console when absent, never the Fastify logger. */
  log?: (line: string) => void;
}): ChainRuntime {
  const { db, chainId } = deps;
  // Arc reads its own settings under Base's names, and none of Base's (arc-env.ts).
  const env = chainFamily(chainId) === 'arc' ? arcRuntimeEnv(deps.env) : deps.env;
  const sink = deps.log ?? ((line: string) => console.log(line));
  const network = chainNetwork(chainId, deps.env);
  if (!network) throw new ChainRuntimeError('network');
  const url = required(env, network.bundlerEnv);
  // Its key and every chain answer travel over it: https only (CCA-140).
  if (!secureEndpoint(url, network.chainId)) throw new ChainRuntimeError(network.bundlerEnv);
  const readUrls = baseReadUrls(url, env, network.chainId, { hosted: deps.hosted });
  const keks = parseKeksOrRefuse(env);
  // Hot-balance ceilings of the app-held wallets (audit CCA-706, hot-wallets.ts): every balance
  // read below is also seen here, which logs ALERT above a ceiling or on an unplanned outflow.
  const hotWallets = createHotWalletWatch({
    ceilings: hotWalletCeilingsFromEnv(env, network.chainId),
    log: (line) => console.error(line),
    chainId: network.chainId,
  });
  // One key per role (audit CCA-714, key-roles.ts): one ALERT per shared role per runtime.
  const roleReports = { reported: new Set<string>(), log: (line: string) => console.error(line) };
  const maxFeePerGasCap = maxFeePerGasCapFromEnv(env, chainId);
  // Real money is never spent without a fee budget: on mainnet the per-operation cap is required.
  const maxCostWeiCap = identityFeeCapFromEnv(env, chainId);
  // Owner withdrawals exist on the wallet network only (shared/base/wallet-network.ts), and only
  // with their own fee budget there.
  const walletCap =
    network.chainId === (deps.walletChainId ?? WALLET_CHAIN_ID)
      ? walletFeeCap(env, network.chainId)
      : null;

  const chain = {
    id: network.chainId,
    name: network.name,
    nativeCurrency: chainParams(network.chainId).nativeCurrency,
    rpcUrls: { default: { http: [url] } },
  };
  // Head reads are shared for a moment across every request and cron of this process; a read whose
  // conclusion needs a current head uses the live twin (rpc-budget.ts). Both read through the same
  // two endpoints; what only the CDP endpoint answers keeps its retry (CDP_RETRY).
  const transport = () =>
    baseReadTransport(readUrls, { chainId: network.chainId, retry: CDP_RETRY });
  const client = withLiveReads(
    createPublicClient({ chain, transport: blockTagCache(transport()) }),
    createPublicClient({ chain, transport: transport() }),
  );
  // With a second endpoint, the reads it may answer are asked of it FIRST for the identity port
  // (registrations move no funds: their evidence reads, receipts, pinned calls, blocks and tags),
  // for fee quotes, and for the head hints of the settling gate; presence only, every absence,
  // revert or failure is asked of the CDP endpoint (read-transport.ts preferSecond), and so is
  // whatever the second endpoint does not answer within PREFERRED_SECOND_TIMEOUT_MS or a 'safe' /
  // 'finalized' block from it that is too old (STALE_TAGGED_HEAD_MS). Payments, owner operations
  // (their bundler's fee quotes included) and the hand-over's destination check at the finalized
  // block (identityAt) keep `client` (CDP first). Without a second endpoint these are `client`.
  const preferred = (headHints = false) =>
    baseReadTransport(readUrls, {
      chainId: network.chainId,
      retry: CDP_RETRY,
      preferSecond: true,
      headNumberMayFallBack: headHints,
    });
  const twoEndpoints = readUrls.length > 1;
  const identityClient = twoEndpoints
    ? withLiveReads(
        createPublicClient({ chain, transport: blockTagCache(preferred()) }),
        createPublicClient({ chain, transport: preferred() }),
      )
    : client;
  // Hints only ever say "not yet" or "look now" (identity service, settling gate): a head up to
  // HINT_TTL_MS old only delays a check, so it is shared longer across rows and runs.
  const hintClient = createPublicClient({
    chain,
    transport: blockTagCache(twoEndpoints ? preferred(true) : transport(), {
      latestTtlMs: HINT_TTL_MS,
      settledTtlMs: HINT_TTL_MS,
    }),
  });
  const keyStore = pgSpenderKeyStore(db);
  const keystore = createKeystore({ store: keyStore, keks });
  // The bundler's client serves its fee quotes only (bundlerFees): never a decision; the fee cap
  // still bounds what is signed. Registrations quote with identityClient (the second endpoint
  // first); payments and owner operations keep their own bundler on `client` (CDP first).
  const bundlerOn = (feeClient: typeof client) =>
    rpcBundler({
      url,
      entryPoint: network.contracts.entryPointV06,
      chainId: network.chainId,
      client: feeClient,
      maxFeePerGasCap,
      stubSignature: estimationStub(),
    });
  // Operation Paymaster: CITY_BASE_BUNDLER=direct sends every user operation (registrations,
  // payments, feed pay, owner operations) through our own submitter and, with
  // CITY_BASE_OWN_PAYMASTER=on, our own paymaster (direct-bundler.ts). Unset: CDP, exactly as before.
  // The CDP bundler still answers receipts of operations it sent before the switch. Asked for
  // without what sponsoring needs (CITY_BASE_OWN_PAYMASTER=on, CITY_BASE_PAYMASTER_ADDRESS), the
  // server keeps CDP and says so once: a wrong setting never stops registrations or the site.
  const choice = bundlerChoice(env);
  // Arc has no CDP to fall back on: without our own bundler and paymaster it does not run at all.
  if (chainFamily(chainId) === 'arc' && choice !== 'direct')
    throw new ChainRuntimeError('CITY_ARC_PAYMASTER');
  if (choice === 'invalid')
    console.error(
      'own bundler: CITY_BASE_BUNDLER=direct needs CITY_BASE_OWN_PAYMASTER=on and CITY_BASE_PAYMASTER_ADDRESS; CDP kept',
    );
  // Ours exists whenever our paymaster is configured: with CITY_BASE_BUNDLER=direct it takes new
  // work; otherwise it DRAINS: new work goes to CDP at once, while operations that
  // are ours still finish on our lane (never resubmitted through CDP), until none is left open.
  const noCdp = chainFamily(chainId) === 'arc';
  const ownConfigured =
    choice === 'direct' || (ownPaymasterMode(env) !== 'off' && ownPaymasterAddress(env) !== null);
  const own = ownConfigured
    ? lazyBundler({
        newWork: choice === 'direct' ? 'direct' : 'cdp',
        make: async () => {
          // Arc's paymaster keys are its own (key-roles.ts); Base never reaches this check.
          if (noCdp && !arcPaymasterKeysUsable(deps.env, roleReports))
            throw new BundlerError('RPC_UNAVAILABLE', 'own bundler: a key role check refused it.');
          return createDirectBundler({
            db,
            env,
            client,
            chainId: network.chainId,
            network,
            keystore,
            ...(noCdp ? {} : { fallback: bundlerOn(client) }),
            log: sink,
            hotWallets,
          });
        },
        // Ours cannot be built (keys, registry): new operations use CDP, logged, never an outage
        //; operations that are ours are never forwarded.
        // Arc has no CDP: there a bundler that can't be built refuses, it never falls back.
        ...(noCdp ? {} : { fallback: bundlerOn(client) }),
        log: (line) => console.error(line),
        route: {
          db,
          chainId: network.chainId,
          entryPoint: network.contracts.entryPointV06,
          paymaster: ownPaymasterAddress(env),
        },
      })
    : null;
  const direct = choice === 'direct' ? own : null;
  /** A CDP bundler whose operations that are ours (a drain) still go to ours. */
  const cdpRouted = (cdp: Bundler) => (own ? own.routes(cdp) : cdp);
  const identityCdp = cdpRouted(bundlerOn(identityClient));
  const bundler = direct ?? identityCdp;
  const walletBundler =
    direct ?? (identityClient === client ? identityCdp : cdpRouted(bundlerOn(client)));
  const signerOf = async (ref: string) => {
    const key = await keyStore.get(parseKeyRef(ref).keyId);
    if (!key) throw new Error('Spender key not found.');
    return key.signerAddress;
  };
  // Agent payments hold their amount on the wallet's fresh USDC balance before anything is signed.
  const balances = baseBalanceReader(readUrls, network);
  const ledger = createReservationLedger({
    chainId: network.chainId,
    balanceOf: reservationBalanceOf(balances, network),
  });

  // Feed pay's own endpoint (CITY_FEED_PAY_CDP_RPC_URL, feedPayEndpoint). Unset: the shared
  // client, bundler, balance reads and ledger above, exactly as before.
  const feedPaySetting = feedPayCdpUrl(env);
  const feedPayOwn = feedPaySetting?.url
    ? feedPayEndpoint({
        url: feedPaySetting.url,
        env,
        network,
        hosted: deps.hosted,
        maxFeePerGasCap,
      })
    : null;
  const sponsoredBatch = sponsoredBatchFromEnv(env);
  /** The public x402 sender's one facilitator instance (publicSettleFacilitator below). */
  let publicSettle: ReturnType<typeof createRouter3Facilitator> | null = null;
  /** The offers' public address's one lane (publicOfferLane below). */
  let publicOffer: PublicOfferLane | null = null;
  const router3Batch = () => router3BatchFromEnv(env);
  /** The economics watch's price of the gas asset: fixed where it is USDC, else the setting's. */
  const usdcPerNativeOption = () => {
    const usdcPerEth = chainParams(network.chainId).usdcPerNative ?? usdcPerEthFromEnv(env);
    return usdcPerEth !== undefined ? { usdcPerEth } : {};
  };
  /**
   * Router 3 on this chain. Base's parser answers Base's router whatever the settings are, so Arc asks
   * its own (protocolArcFeeConfigFromEnv): a settlement is never pointed at Base's router on Arc.
   */
  const router3Address = (): Hex | null => {
    if (chainFamily(chainId) !== 'arc') return router3AddressFromEnv(env);
    const config = protocolArcFeeConfigFromEnv(deps.env);
    return config?.chainId === chainId ? (config.router as Hex) : null;
  };
  /**
   * Fee router 3's facilitator: Central City's own EOA (CITY_X402_FACILITATOR_KEY_REF) sends
   * router3.settle and pays its gas in ETH; null unless its key and router 3 are configured. Every
   * instance shares the EOA's one nonce lane and lane row in Postgres (facilitator.ts).
   */
  const buildRouter3Facilitator = () => {
    const keyRef = env.CITY_X402_FACILITATOR_KEY_REF?.trim();
    const router = router3Address();
    if (!keyRef || !router) return null;
    // Arc's facilitator is its own EOA: gas in another asset, its own nonce lane. A key any role of
    // Base names is always refused there. Read from the deployment's settings: Arc's view holds
    // nothing of Base's, and names Arc's key twice.
    if (chainFamily(chainId) === 'arc') {
      if (!arcFacilitatorKeyUsable(deps.env, roleReports)) return null;
    }
    // Its own key (audit CCA-714): a key shared with another role ALERTs; refused only with CITY_KEY_ROLES_ENFORCE=1.
    else if (!roleKeyUsable(env, 'router3_facilitator', roleReports)) return null;
    const batch = router3Batch();
    return createRouter3Facilitator({
      db,
      client: feedPayParts().client,
      keystore,
      keyRef,
      router,
      chainId: network.chainId,
      hotWallet: { role: 'router3_facilitator', watch: hotWallets },
      ...(batch ? { batch } : {}),
      // Beside the sponsored settlements only while the setting is on; unset, exactly as before.
      ...(sponsoredSendsViaFacilitator(env) ? { foreignReadOnly: true } : {}),
      // Its ALERT lines (gas budgets, reverted batches CCA-744, settlement economics CCA-754).
      log: sink,
      ...usdcPerNativeOption(),
    });
  };
  /** Feed pay's parts; refused (the setting name only) when its endpoint setting is not https. */
  let sponsorPay: ReturnType<NonNullable<ChainRuntime['sponsorPay']>> | null = null;
  let arcOwnerOperations: OwnerOperationsPort | null = null;
  const feedPayParts = () => {
    if (!feedPaySetting) throw new ChainRuntimeError(FEED_PAY_CDP_SETTING);
    if (feedPayOwn)
      return direct
        ? { ...feedPayOwn, bundler: direct }
        : own
          ? { ...feedPayOwn, bundler: cdpRouted(feedPayOwn.bundler) }
          : feedPayOwn;
    // The wallet bundler, as payments and owner operations (CCA-111): fee quotes on the configured
    // endpoint first, never the registrations' bundler (the second endpoint first).
    return { client, bundler: walletBundler, balances, ledger };
  };

  /**
   * The addresses of Central City's configured server keys (CCA-704): the router-3 facilitator
   * (CITY_X402_FACILITATOR_KEY_REF), the public x402 sender (CITY_X402_PUBLIC_SETTLE_KEY_REF), the
   * sponsored first purchase's sponsor (CITY_SFP_SPONSOR_KEY_REF), the paymaster signer
   * (CITY_BASE_PAYMASTER_SIGNER_KEY_REF) and its submitters (CITY_BASE_SUBMITTER_KEY_REFS). Read
   * from the key rows' stored address (never decrypted), once: a configured key that cannot be read
   * rejects (never a partial list) and is read again by the next call.
   */
  let keyAddresses: Promise<string[]> | null = null;
  const protocolKeyAddresses = () =>
    (keyAddresses ??= (async () => {
      const refs = [
        env.CITY_X402_FACILITATOR_KEY_REF,
        env.CITY_X402_PUBLIC_SETTLE_KEY_REF,
        env.CITY_X402_PUBLIC_OFFER_KEY_REF,
        env[SFP_SPONSOR_KEY_REF_SETTING],
        env[PAYMASTER_SIGNER_KEY_REF_SETTING],
        ...(env[SUBMITTER_KEY_REFS_SETTING] ?? '').split(','),
      ]
        .map((ref) => ref?.trim())
        .filter((ref): ref is string => Boolean(ref));
      return Promise.all(refs.map(async (ref) => (await signerOf(ref)).toLowerCase()));
    })().catch((error: unknown) => {
      keyAddresses = null;
      throw error;
    }));

  return {
    walletPort: createWalletChainPort({ keystore, env }),
    ...(chainFamily(chainId) === 'arc'
      ? {
          arcOwnerBundler: walletBundler,
          // Feed pay on Arc: Arc's fee budget, our own bundler, and its configured paymaster as the
          // one sponsor until one is pinned in SPONSOR_PAYMASTERS. No cap: throws, and a call
          // answers unavailable.
          feedPay: () => {
            const cap = walletFeeCap(env, network.chainId);
            if (!cap)
              throw new ChainRuntimeError(chainParams(network.chainId).settings.walletFeeCap);
            const parts = feedPayParts();
            const paymaster = ownPaymasterAddress(env);
            return createFeedPayChain({
              network,
              client: parts.client,
              db,
              operations: pgChainOperationStore(db),
              bundler: parts.bundler,
              keystore,
              signerOf,
              ledger: parts.ledger,
              usdcBalance: async (address) => {
                const read = await parts.balances.balances(address);
                return { balance: read.usdc, blockNumber: read.blockNumber };
              },
              authorizations: pgAuthorizationStore(db),
              maxCostWeiCap: cap.cap,
              sponsors: {
                [network.chainId]:
                  SPONSOR_PAYMASTERS[network.chainId] ?? (paymaster ? [paymaster] : []),
              },
            });
          },
          router3Facilitator: buildRouter3Facilitator,
          arcOwnerOperations: () => {
            if (arcOwnerOperations) return arcOwnerOperations;
            const cap = walletFeeCap(env, network.chainId);
            if (!cap)
              throw new ChainRuntimeError(chainParams(network.chainId).settings.walletFeeCap);
            const paymaster = ownPaymasterAddress(env);
            arcOwnerOperations = createOwnerOperationsPort({
              network,
              client,
              store: pgChainOperationStore(db),
              bundler: walletBundler,
              maxCostWeiCap: cap.cap,
              sponsors: {
                [network.chainId]:
                  SPONSOR_PAYMASTERS[network.chainId] ?? (paymaster ? [paymaster] : []),
              },
            });
            return arcOwnerOperations;
          },
        }
      : {}),
    readClient: client,
    protocolKeyAddresses,
    // The owner's one-click move of the sponsor's surplus ETH to the router-3 facilitator
    // (feed/pay/sponsor-eth-sweep.ts): addresses read from the key rows, the sponsor key used only
    // to sign that one transfer. Null while either key is not configured.
    sponsorEth: async (): Promise<SponsorEthChain | null> => {
      const keyRef = env[SFP_SPONSOR_KEY_REF_SETTING]?.trim();
      const facilitatorRef = env.CITY_X402_FACILITATOR_KEY_REF?.trim();
      if (!keyRef || !facilitatorRef || keyRef === facilitatorRef) return null;
      const sponsor = await keystore.addressOf(keyRef);
      const facilitator = await keystore.addressOf(facilitatorRef);
      return {
        chainId: network.chainId,
        sponsor,
        facilitator,
        client: feedPayParts().client,
        withTransferSigner: (use) =>
          keystore.withSigner(keyRef, (account) => {
            if (account.address.toLowerCase() !== sponsor.toLowerCase())
              throw new Error('The sponsor key does not match the sponsor address.');
            return use((tx) => account.signTransaction({ type: 'eip1559', ...tx }));
          }),
      };
    },
    ...(own
      ? {
          ownBundlerUpkeep: {
            mode: direct ? ('direct' as const) : ('drain' as const),
            maintain: (limit?: number) => own.maintain(limit),
            open: () => own.open(),
          },
          ownBundlerEffective: () => own.effective(),
        }
      : {}),
    feedPayReadClient: () => feedPayParts().client,
    ...(walletCap
      ? {
          ownerOperations: createOwnerOperationsPort({
            network,
            client,
            store: pgChainOperationStore(db),
            bundler: walletBundler,
            maxCostWeiCap: walletCap.cap,
          }),
          // Pinned sponsor or nothing, USDC only, the wallet fee budget (payment-chain.ts).
          agentPayments: (authorize) =>
            agentPaymentChain({
              network,
              client,
              db,
              operations: pgChainOperationStore(db),
              bundler: walletBundler,
              keystore,
              signerOf,
              ledger,
              maxCostWeiCap: walletCap.cap,
              authorize,
            }),
          // Feed pay (docs/FEED_PAY.md): the same budget, sponsor rule and stores; its own
          // endpoint when CITY_FEED_PAY_CDP_RPC_URL is set (feedPayParts above).
          feedPay: () => {
            const parts = feedPayParts();
            return createFeedPayChain({
              network,
              client: parts.client,
              db,
              operations: pgChainOperationStore(db),
              bundler: parts.bundler,
              keystore,
              signerOf,
              ledger: parts.ledger,
              usdcBalance: async (address) => {
                const read = await parts.balances.balances(address);
                return { balance: read.usdc, blockNumber: read.blockNumber };
              },
              authorizations: pgAuthorizationStore(db),
              maxCostWeiCap: walletCap.cap,
              sponsors: SPONSOR_PAYMASTERS,
            });
          },
          // Fee router 3's facilitator (server/protocol/x402/facilitator.ts, buildRouter3Facilitator
          // above). Only when its key (CITY_X402_FACILITATOR_KEY_REF) and router 3 are configured;
          // else null and nothing is ever pinned to router 3. Over Feed pay's own read client.
          router3Facilitator: buildRouter3Facilitator,
          // The public x402 facilitator's sender: its own EOA and nonce lane (never 0xc8d6's), target
          // USDC; rows of other EOAs in the shared table are only read. Null without its key.
          // One instance per runtime: its per-instance state (head check pacing, cached address)
          // must not be rebuilt for every request.
          // Never another server key (CCA-704, as the sponsor path; review finding 374): the
          // router-3 facilitator's, the sponsor's, the paymaster verifying signer's or one of our
          // bundler submitters' ref is refused here, and a different ref whose stored address is
          // one of theirs (the same key stored twice; compared on the key rows' stored address,
          // never decrypted) can never pay (canPay false, once alerted), so strangers' traffic
          // never shares their nonce lane or signs as them.
          publicSettleFacilitator: () => {
            const keyRef = env.CITY_X402_PUBLIC_SETTLE_KEY_REF?.trim();
            if (!keyRef || network.chainId !== 8453) return null;
            // Its own key (audit CCA-714): a key shared with another role ALERTs; refused only with CITY_KEY_ROLES_ENFORCE=1.
            if (!roleKeyUsable(env, 'public_settle', roleReports)) return null;
            const others = [
              env.CITY_X402_FACILITATOR_KEY_REF,
              env.CITY_X402_PUBLIC_OFFER_KEY_REF,
              env[SFP_SPONSOR_KEY_REF_SETTING],
              env[PAYMASTER_SIGNER_KEY_REF_SETTING],
              ...(env[SUBMITTER_KEY_REFS_SETTING] ?? '').split(','),
            ]
              .map((ref) => ref?.trim())
              .filter((ref): ref is string => Boolean(ref));
            if (others.includes(keyRef)) return null;
            return (publicSettle ??= (() => {
              const own = createRouter3Facilitator({
                db,
                client: feedPayParts().client,
                keystore,
                keyRef,
                router: network.tokens.USDC.address,
                chainId: network.chainId,
                foreignReadOnly: true,
                hotWallet: { role: 'public_settle', watch: hotWallets },
                log: sink,
                // Strangers' calldata: its L1 data fee is capped (CCA-704).
                caps: { maxL1FeeWei: PUBLIC_SETTLE_MAX_L1_FEE_WEI },
              });
              /** Its stored address is none of the other lanes' (kept once known; unread: false). */
              let separate: Promise<boolean> | null = null;
              const distinct = () =>
                (separate ??= (async () => {
                  const mine = (await signerOf(keyRef)).toLowerCase();
                  for (const ref of others)
                    if ((await signerOf(ref)).toLowerCase() === mine) {
                      sink('x402 facilitator: ALERT public settle key is another lane, refused');
                      return false;
                    }
                  return true;
                })().catch(() => {
                  separate = null;
                  return false;
                }));
              // Every path that can sign or send is behind the same identity check (review
              // finding 385), never behind the gas balance (canPay alone), so reconciliation of a
              // distinct sender is never blocked: an aliased one answers its stored state only
              // (status: no lane heal, refresh, replacement or broadcast) and stores nothing new.
              return {
                ...own,
                canPay: async () => (await distinct()) && own.canPay(),
                status: async (key: string, batch?: Parameters<typeof own.status>[1]) =>
                  (await distinct()) ? own.status(key, batch) : own.storedStatus(key),
                submitCall: async (input: Parameters<typeof own.submitCall>[0]) => {
                  if (!(await distinct()))
                    throw new FacilitatorError(
                      'RPC_UNAVAILABLE',
                      'The public sender key is another server key: nothing is sent.',
                    );
                  return own.submitCall(input);
                },
              };
            })());
          },
          // The offers' public address's sender (server/feed/offers/public-pay.ts): its OWN EOA
          // (CITY_X402_PUBLIC_OFFER_KEY_REF) and nonce lane sends router 3 settle for outside
          // buyers, who sign both legs themselves; never another server key, as the public settle
          // above (a ref or stored address of another lane is refused). Null closes the address.
          publicOfferLane: () => {
            const keyRef = env.CITY_X402_PUBLIC_OFFER_KEY_REF?.trim();
            const router = router3AddressFromEnv(env);
            if (!keyRef || !router || network.chainId !== 8453) return null;
            if (!roleKeyUsable(env, 'public_offer', roleReports)) return null;
            const others = [
              env.CITY_X402_FACILITATOR_KEY_REF,
              env.CITY_X402_PUBLIC_SETTLE_KEY_REF,
              env[SFP_SPONSOR_KEY_REF_SETTING],
              env[PAYMASTER_SIGNER_KEY_REF_SETTING],
              ...(env[SUBMITTER_KEY_REFS_SETTING] ?? '').split(','),
            ]
              .map((ref) => ref?.trim())
              .filter((ref): ref is string => Boolean(ref));
            if (others.includes(keyRef)) return null;
            return (publicOffer ??= (() => {
              const client = feedPayParts().client;
              const own = createRouter3Facilitator({
                db,
                client,
                keystore,
                keyRef,
                router,
                chainId: network.chainId,
                foreignReadOnly: true,
                hotWallet: { role: 'public_offer', watch: hotWallets },
                log: sink,
                // Strangers' signatures in the calldata: its L1 data fee is capped.
                caps: { maxL1FeeWei: PUBLIC_SETTLE_MAX_L1_FEE_WEI },
                ...(usdcPerEthFromEnv(env) !== undefined
                  ? { usdcPerEth: usdcPerEthFromEnv(env) }
                  : {}),
              });
              let separate: Promise<boolean> | null = null;
              const distinct = () =>
                (separate ??= (async () => {
                  const mine = (await signerOf(keyRef)).toLowerCase();
                  for (const ref of others)
                    if ((await signerOf(ref)).toLowerCase() === mine) {
                      sink('x402 facilitator: ALERT public offer key is another lane, refused');
                      return false;
                    }
                  return true;
                })().catch(() => {
                  separate = null;
                  return false;
                }));
              const usdc = network.tokens.USDC.address;
              const usdcAbi = parseAbi([
                'function authorizationState(address, bytes32) view returns (bool)',
              ]);
              return {
                address: () => own.address(),
                canPay: async () => (await distinct()) && own.canPay(),
                ethBalance: () => own.ethBalance(),
                finalityLagSeconds: async () => {
                  const [latest, finalized] = await Promise.all([
                    client.getBlock({ blockTag: 'latest' }),
                    client.getBlock({ blockTag: 'finalized' }),
                  ]);
                  return Number(latest.timestamp - finalized.timestamp);
                },
                simulate: async (data: Hex) => {
                  const answer = await own.verifyCall(data);
                  return answer.ok
                    ? { ok: true, gas: answer.gas }
                    : { ok: false, retryable: answer.retryable };
                },
                // As firstSend's checks, with its margins, and the fee caps as the largest fields
                // the transaction can carry (the oracle prices its serialized bytes). A nonce of
                // zero is at most three bytes short; the oracle's price is doubled over that.
                withinCaps: async (data: Hex, gas: bigint) => {
                  const gasLimit = (gas * 13n + 9n) / 10n;
                  if (gasLimit > FEE_CAPS.maxGasLimit) return false;
                  const l1Fee = await client.readContract({
                    address: GAS_PRICE_ORACLE,
                    abi: parseAbi(['function getL1Fee(bytes) view returns (uint256)']),
                    functionName: 'getL1Fee',
                    args: [
                      serializeTransaction({
                        type: 'eip1559',
                        chainId: network.chainId,
                        nonce: 0,
                        to: router,
                        value: 0n,
                        data,
                        gas: gasLimit,
                        maxFeePerGas: FEE_CAPS.maxFeePerGasWei,
                        maxPriorityFeePerGas: FEE_CAPS.maxPriorityFeePerGasWei,
                      }),
                    ],
                  });
                  return 2n * l1Fee <= PUBLIC_SETTLE_MAX_L1_FEE_WEI;
                },
                hasCode: async (address: Hex) => Boolean(await client.getCode({ address })),
                usdcBalance: (address: Hex) =>
                  client.readContract({
                    address: usdc,
                    abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
                    functionName: 'balanceOf',
                    args: [address],
                  }),
                submit: async (input) => {
                  if (!(await distinct()))
                    throw new FacilitatorError(
                      'RPC_UNAVAILABLE',
                      'The public offer key is another server key: nothing is sent.',
                    );
                  return own.submit(input);
                },
                status: async (key: string) =>
                  (await distinct()) ? own.status(key) : own.storedStatus(key),
                endUnsent: (key: string, intentHash: Hex) => own.endUnsent(key, intentHash),
                // As sponsorPay's expiredUnused, past the wall clock and at one safe block, with the
                // used case told apart (a leg sent outside this call).
                legsState: async (payer: Hex, nonces: Hex[], validBefore: number) => {
                  try {
                    const safe = await client.getBlock({ blockTag: 'safe' });
                    if (safe.number === null) return 'wait';
                    let used = false;
                    for (const nonce of nonces)
                      if (
                        await client.readContract({
                          address: usdc,
                          abi: usdcAbi,
                          functionName: 'authorizationState',
                          args: [payer, nonce],
                          blockNumber: safe.number,
                        })
                      )
                        used = true;
                    if (used) return 'used';
                    return Math.floor(Date.now() / 1000) > validBefore &&
                      Number(safe.timestamp) >= validBefore
                      ? 'unused'
                      : 'wait';
                  } catch {
                    return 'wait';
                  }
                },
                receiptLogs: async (hash: Hex) => {
                  const receipt = await client.getTransactionReceipt({ hash });
                  return receipt.status === 'success' ? receipt.logs : null;
                },
                // Blocks from the time they were made at (Base: one every 2 s), a margin each side;
                // the window is ~11 minutes, far inside one log page.
                feeLogs: async ({ payer, payee, ref, validAfter, validBefore }) => {
                  const safe = await client.getBlock({ blockTag: 'safe' });
                  if (safe.number === null) return null;
                  const margin = 30n;
                  const back = (safe.timestamp - BigInt(validAfter)) / 2n + margin;
                  const fromBlock = safe.number > back ? safe.number - back : 0n;
                  const span = BigInt(validBefore - validAfter) / 2n + 2n * margin;
                  const toBlock = fromBlock + span < safe.number ? fromBlock + span : safe.number;
                  if (toBlock < fromBlock || toBlock - fromBlock + 1n > MAX_LOG_RANGE_BLOCKS)
                    return null;
                  const logs = await client.getLogs({
                    address: router,
                    event: parseAbiItem(
                      'event FeeCharged(address indexed payer, address indexed payee, bytes32 indexed ref, uint8 kind, uint256 gross, uint256 fee)',
                    ),
                    args: { payer, payee, ref },
                    fromBlock,
                    toBlock,
                  });
                  return logs
                    .filter(
                      (log) => !log.removed && log.transactionHash && log.blockNumber !== null,
                    )
                    .map((log) => ({
                      address: log.address,
                      topics: log.topics,
                      data: log.data,
                      txHash: log.transactionHash!,
                      blockNumber: log.blockNumber!,
                    }));
                },
              } satisfies PublicOfferLane;
            })());
          },
        }
      : {}),
    // On the wallet chain (Base) and on Arc (2 Nov 2026: Arc's first buys answered unavailable while
    // this lived in the wallet chain's block alone). Arc's view passes the sponsor's key and
    // CITY_SFP_SEND_VIA_FACILITATOR (arc-env.ts): who sends is the same on both chains.
    ...(walletCap || chainFamily(chainId) === 'arc'
      ? {
          // The sponsored first purchase's payer (server/feed/pay/sponsored.ts): Central City's
          // sponsor EOA (CITY_SFP_SPONSOR_KEY_REF) signs both router-3 legs (it is the payer). Who
          // SENDS them: with CITY_SFP_SEND_VIA_FACILITATOR=1 the router-3 facilitator (its EOA, its
          // nonce lane, its ETH; the sponsored batch group), else the sponsor's OWN facilitator
          // (its own nonce lane, never the router-3 facilitator's), always batched. Either way the
          // other one stays a previous lane: what it already holds is followed and finished there.
          // Built once; null while the key or router 3 is not configured, and, with the setting,
          // while the router-3 facilitator is not.
          sponsorPay: () =>
            (sponsorPay ??= (async () => {
              const keyRef = env[SFP_SPONSOR_KEY_REF_SETTING]?.trim();
              const router = router3Address();
              if (!keyRef || !router) return null;
              // Its own key (audit CCA-714): a key shared with another role ALERTs; refused only with CITY_KEY_ROLES_ENFORCE=1.
              if (!roleKeyUsable(env, 'sfp_sponsor', roleReports)) return null;
              const client = feedPayParts().client;
              // Addresses only here: read from the store, never decrypted (CCA-719).
              const sponsor = await keystore.addressOf(keyRef);
              const usdc = network.tokens.USDC?.address;
              if (!usdc) return null;
              // Never the router-3 facilitator's own key, nor any agent's wallet or spender (review
              // S8): the sponsor is never an account whose live paid calls it could interleave with.
              // Note the sponsor key also SENDS router-3 transactions: without
              // CITY_SFP_SEND_VIA_FACILITATOR its own facilitator below (keyed with this same key)
              // submits the settlements, so the sponsor EOA is then the sender (tx_from) of its own
              // payments and pays their gas; with the setting the router-3 facilitator sends them.
              const facilitatorRef = env.CITY_X402_FACILITATOR_KEY_REF?.trim();
              if (facilitatorRef) {
                if (facilitatorRef === keyRef) return null;
                const live = await keystore.addressOf(facilitatorRef);
                if (live.toLowerCase() === sponsor.toLowerCase()) return null;
              }
              const { rows: agentAccounts } = await db.query(
                `SELECT 1 FROM base_wallets
                 WHERE lower(address) = lower($1) OR spender_address = $1 OR spender_address = lower($1)
                 LIMIT 1`,
                [sponsor],
              );
              if (agentAccounts.length) return null;
              // The sponsor's own facilitator: its own EOA and nonce lane, its whole batch lane
              // sponsored (no groups), as before the setting existed.
              const own = createRouter3Facilitator({
                db,
                client,
                keystore,
                keyRef,
                router,
                chainId: network.chainId,
                batch: sponsoredBatch,
                foreignReadOnly: true,
                hotWallet: { role: 'sfp_sponsor', watch: hotWallets },
                log: sink,
                ...usdcPerNativeOption(),
              });
              const shared = buildRouter3Facilitator();
              let lanes: Pick<SponsorPay, 'facilitator' | 'batch' | 'previous' | 'minSenderEthWei'>;
              if (sponsoredSendsViaFacilitator(env)) {
                // New settlements go to the router-3 facilitator, batched in the 'sfp:' group only
                // (its batch config has that group whenever the setting is on); what the sponsor's
                // own lane already holds is finished there, still batched under its own config.
                if (!shared) return null;
                lanes = {
                  facilitator: shared,
                  batch: { group: SPONSORED_KEY_PREFIX },
                  // Its gas is the engine's: first buys pause well above its floor (review S2).
                  minSenderEthWei: sponsoredSenderMinEthWei(env, network.chainId),
                  previous: [{ facilitator: own, batch: {} }],
                };
              } else {
                // As before; anything the router-3 facilitator holds from while the setting was on
                // is followed and finished there, never batched (its batch lane is the engine's).
                lanes = {
                  facilitator: own,
                  batch: {},
                  previous: shared ? [{ facilitator: shared }] : [],
                };
              }
              const usdcAbi = parseAbi([
                'function balanceOf(address) view returns (uint256)',
                'function authorizationState(address, bytes32) view returns (bool)',
              ]);
              return {
                signer: createSponsorSigner({
                  network,
                  keystore,
                  keyRef,
                  sponsor,
                  token: usdc,
                  store: pgAuthorizationStore(db),
                  now: Date.now,
                  router,
                  reservationOf: pgSponsorReservations(db),
                  reserved: protocolReservedPayees(env),
                  // The router's treasury() must be the protocol treasury for this chain (fixed in
                  // code on Base mainnet), as the engine requires (protocolTreasuryFor): never a
                  // fee leg to another address.
                  treasuryOf: async () => {
                    const read = (await client.readContract({
                      address: router,
                      abi: parseAbi(['function treasury() view returns (address)']),
                      functionName: 'treasury',
                    })) as Address;
                    const expected = protocolTreasuryFor(env, network.chainId);
                    if (expected && expected !== read.toLowerCase())
                      throw new Error('Router 3 pays another treasury than the protocol.');
                    return read;
                  },
                }),
                usdcBalance: async () => {
                  const balance = (await client.readContract({
                    address: usdc,
                    abi: usdcAbi,
                    functionName: 'balanceOf',
                    args: [sponsor],
                  })) as bigint;
                  hotWallets.observe('sfp_sponsor', 'usdc', balance);
                  return balance;
                },
                // As feed-pay-chain's outcome(): past validBefore by the wall clock AND at a safe
                // block whose timestamp is at or past it (EIP-3009 accepts block.timestamp <
                // validBefore), every nonce unused at that very block.
                expiredUnused: async (nonces: Hex[], validBefore: number) => {
                  try {
                    if (Math.floor(Date.now() / 1000) <= validBefore) return false;
                    const safe = await client.getBlock({ blockTag: 'safe' });
                    if (safe.number === null || Number(safe.timestamp) < validBefore) return false;
                    for (const nonce of nonces) {
                      const used = await client.readContract({
                        address: usdc,
                        abi: usdcAbi,
                        functionName: 'authorizationState',
                        args: [sponsor, nonce],
                        blockNumber: safe.number,
                      });
                      if (used !== false) return false;
                    }
                    return true;
                  } catch {
                    return false;
                  }
                },
                ...lanes,
              };
            })().catch(() => {
              sponsorPay = null;
              return null;
            })),
        }
      : {}),
    identityPort: createIdentityChainPort({
      network,
      client: identityClient,
      hintClient,
      finalizedClient: client,
      db,
      operations: pgChainOperationStore(db),
      bundler,
      keystore,
      signerOf,
      maxCostWeiCap,
      // Pinned sponsor or nothing on Base mainnet, also on the CDP fallback and drain (CCA-138).
      ...(isRealMoneyChain(network.chainId) ? { sponsors: SPONSOR_PAYMASTERS } : {}),
    }),
  };
}

function parseKeksOrRefuse(env: Record<string, string | undefined>) {
  try {
    return parseKeks(env.CITY_BASE_SPENDER_KEK);
  } catch {
    // The parser's message never contains the value, but the setting name is all a caller needs.
    throw new ChainRuntimeError('CITY_BASE_SPENDER_KEK');
  }
}

/** One runtime per network, built on first use; a configuration error is not cached. */
export function chainRuntimes(
  db: Database,
  env: Record<string, string | undefined>,
  options: { hosted?: boolean; log?: (line: string) => void } = {},
) {
  const built = new Map<ChainId, ChainRuntime>();
  return async (chainId: ChainId): Promise<ChainRuntime> => {
    const existing = built.get(chainId);
    if (existing) return existing;
    const runtime = createChainRuntime({
      db,
      env,
      chainId,
      hosted: options.hosted,
      ...(options.log ? { log: options.log } : {}),
    });
    built.set(chainId, runtime);
    return runtime;
  };
}
