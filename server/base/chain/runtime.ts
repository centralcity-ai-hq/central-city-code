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
 * No setting value (they contain keys) ever appears in an error message or a log line.
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
import { createPublicClient, type Hex } from 'viem';
import type { Database } from '../../database.js';
import { BASE_MAINNET, baseNetwork, type BaseChainId } from '../../../shared/base/chains.js';
import type { ChainRuntime } from '../identity/routes.js';
import { baseBalanceReader, reservationBalanceOf } from './balances.js';
import { createIdentityChainPort } from './identity-port.js';
import { createKeystore, parseKeks, parseKeyRef } from './keystore.js';
import { createOwnerOperationsPort } from './owner-ops.js';
import { agentPaymentChain } from './payment-chain.js';
import { createReservationLedger } from './reservations.js';
import { WALLET_CHAIN_ID } from '../../../shared/base/wallet-network.js';
import { walletSignature } from './permissions.js';
import { createWalletChainPort } from './port.js';
import { BUNDLER_429_WAITS_MS, rpcBundler } from './rpc-bundler.js';
import { blockTagCache, CDP_RETRY, withLiveReads } from './rpc-budget.js';
import { baseReadTransport, baseReadUrls } from './read-transport.js';
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

/** The setting that bounds every owner wallet operation (required on mainnet). */
export const WALLET_FEE_CAP_SETTING = 'CITY_BASE_WALLET_FEE_CAP_WEI';

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
  chainId: BaseChainId,
): { cap: bigint | undefined } | null {
  const value = env[WALLET_FEE_CAP_SETTING]?.trim();
  if (!value) return chainId === BASE_MAINNET ? null : { cap: undefined };
  return POSITIVE_INT.test(value) ? { cap: BigInt(value) } : null;
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
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
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

export function createChainRuntime(deps: {
  db: Database;
  env: Record<string, string | undefined>;
  chainId: BaseChainId;
  /** The network owner operations are built on; the wallet network (wallet-network.ts) by default. */
  walletChainId?: BaseChainId;
  /** Hosted: reads fall back to the network's public RPC when no second endpoint is set. */
  hosted?: boolean;
}): ChainRuntime {
  const { db, env, chainId } = deps;
  const network = baseNetwork(chainId, env);
  if (!network) throw new ChainRuntimeError('network');
  const url = required(env, network.bundlerEnv);
  const readUrls = baseReadUrls(url, env, network.chainId, { hosted: deps.hosted });
  const keks = parseKeksOrRefuse(env);
  const maxFeePerGasCap = positive(env, 'CITY_BASE_MAX_FEE_PER_GAS_WEI');
  // Real money is never spent without a fee budget: on mainnet the per-operation cap is required.
  const maxCostWeiCap =
    chainId === BASE_MAINNET || env.CITY_BASE_IDENTITY_FEE_CAP_WEI
      ? positive(env, 'CITY_BASE_IDENTITY_FEE_CAP_WEI')
      : undefined;
  // Owner withdrawals exist on the wallet network only (shared/base/wallet-network.ts), and only
  // with their own fee budget there.
  const walletCap =
    network.chainId === (deps.walletChainId ?? WALLET_CHAIN_ID)
      ? walletFeeCap(env, network.chainId)
      : null;

  const chain = {
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
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
  const bundler = bundlerOn(identityClient);
  const walletBundler = identityClient === client ? bundler : bundlerOn(client);
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
  /** Feed pay's parts; refused (the setting name only) when its endpoint setting is not https. */
  const feedPayParts = () => {
    if (!feedPaySetting) throw new ChainRuntimeError(FEED_PAY_CDP_SETTING);
    return feedPayOwn ?? { client, bundler, balances, ledger };
  };

  return {
    walletPort: createWalletChainPort({ keystore, env }),
    readClient: client,
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
  options: { hosted?: boolean } = {},
) {
  const built = new Map<BaseChainId, ChainRuntime>();
  return async (chainId: BaseChainId): Promise<ChainRuntime> => {
    const existing = built.get(chainId);
    if (existing) return existing;
    const runtime = createChainRuntime({ db, env, chainId, hosted: options.hosted });
    built.set(chainId, runtime);
    return runtime;
  };
}
