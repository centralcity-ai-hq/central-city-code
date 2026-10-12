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
 *
 * No setting value (they contain keys) ever appears in an error message or a log line.
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
import { rpcBundler } from './rpc-bundler.js';
import { blockTagCache, cdpTransport, withLiveReads } from './rpc-budget.js';
import { pgChainOperationStore, pgSpenderKeyStore } from './stores.js';

export class ChainRuntimeError extends Error {
  constructor(readonly setting: string) {
    super(`Base chain runtime is not configured (${setting}).`);
  }
}

const POSITIVE_INT = /^[1-9][0-9]{0,77}$/;

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

/**
 * The stub signature smart accounts present for gas estimation: a Coinbase Smart Wallet
 * SignatureWrapper around a well-formed 65-byte ECDSA signature (never a real one).
 */
function estimationStub(): Hex {
  return walletSignature(`0x${'ff'.repeat(64)}1c` as Hex, { ownerIndex: 0 });
}

export function createChainRuntime(deps: {
  db: Database;
  env: Record<string, string | undefined>;
  chainId: BaseChainId;
  /** The network owner operations are built on; the wallet network (wallet-network.ts) by default. */
  walletChainId?: BaseChainId;
}): ChainRuntime {
  const { db, env, chainId } = deps;
  const network = baseNetwork(chainId, env);
  if (!network) throw new ChainRuntimeError('network');
  const url = required(env, network.bundlerEnv);
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
  // conclusion needs a current head uses the live twin (rpc-budget.ts).
  const client = withLiveReads(
    createPublicClient({ chain, transport: blockTagCache(cdpTransport(url)) }),
    createPublicClient({ chain, transport: cdpTransport(url) }),
  );
  const keyStore = pgSpenderKeyStore(db);
  const keystore = createKeystore({ store: keyStore, keks });
  const bundler = rpcBundler({
    url,
    entryPoint: network.contracts.entryPointV06,
    chainId: network.chainId,
    client,
    maxFeePerGasCap,
    stubSignature: estimationStub(),
  });
  const signerOf = async (ref: string) => {
    const key = await keyStore.get(parseKeyRef(ref).keyId);
    if (!key) throw new Error('Spender key not found.');
    return key.signerAddress;
  };
  // Agent payments hold their amount on the wallet's fresh USDC balance before anything is signed.
  const ledger = createReservationLedger({
    chainId: network.chainId,
    balanceOf: reservationBalanceOf(baseBalanceReader(url, network), network),
  });

  return {
    walletPort: createWalletChainPort({ keystore, env }),
    ...(walletCap
      ? {
          ownerOperations: createOwnerOperationsPort({
            network,
            client,
            store: pgChainOperationStore(db),
            bundler,
            maxCostWeiCap: walletCap.cap,
          }),
          // Pinned sponsor or nothing, USDC only, the wallet fee budget (payment-chain.ts).
          agentPayments: (authorize) =>
            agentPaymentChain({
              network,
              client,
              db,
              operations: pgChainOperationStore(db),
              bundler,
              keystore,
              signerOf,
              ledger,
              maxCostWeiCap: walletCap.cap,
              authorize,
            }),
        }
      : {}),
    identityPort: createIdentityChainPort({
      network,
      client,
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
export function chainRuntimes(db: Database, env: Record<string, string | undefined>) {
  const built = new Map<BaseChainId, ChainRuntime>();
  return async (chainId: BaseChainId): Promise<ChainRuntime> => {
    const existing = built.get(chainId);
    if (existing) return existing;
    const runtime = createChainRuntime({ db, env, chainId });
    built.set(chainId, runtime);
    return runtime;
  };
}
