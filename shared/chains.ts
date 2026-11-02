/*
 * Every chain Central City can work on: Base (shared/base/chains.ts, unchanged) and Arc. Code that
 * only ever meant Base keeps using baseNetwork; code that learns a second chain asks here.
 *
 * Arc is off unless CITY_ARC=1 (arcNetwork), so nothing here changes what Base does. Addresses read
 * from the chain on 31 Oct 2026, and from docs.arc.io/arc/references/contract-addresses.
 *
 * What differs on Arc and is easy to get wrong:
 * - Gas is USDC. The native balance has 18 decimals and the ERC-20 interface 6, over one balance:
 *   the same integer read across the two is off by 10^12 (gasAsset, usdcRawFromNativeWei).
 * - A transaction whose maxFeePerGas is under the floor is dropped with no error and no receipt
 *   (minMaxFeePerGasWei): it would wait forever.
 * - A transaction is final at inclusion, and blocks can share a timestamp: order by block number.
 * - The sanctions oracle Base uses has no code on Arc (sanctionsOracleChainId).
 */
import {
  BASE_MAINNET,
  BASE_NETWORKS,
  baseNetwork,
  type Address,
  type BaseChainId,
  type BaseNetwork,
} from './base/chains.js';

export const ARC_MAINNET = 5042;
export const ARC_TESTNET = 5042002;
export type ArcChainId = typeof ARC_MAINNET | typeof ARC_TESTNET;
export type ChainId = BaseChainId | ArcChainId;
export type ChainFamily = 'base' | 'arc';

/** Arc's one USDC: the native token and the ERC-20 interface share this balance. */
export const ARC_USDC: Address = '0x3600000000000000000000000000000000000000';
/** Native units (18 decimals) per ERC-20 base unit (6 decimals). */
export const ARC_NATIVE_PER_USDC_RAW = 10n ** 12n;

export interface GasAsset {
  symbol: 'ETH' | 'USDC';
  /** Decimals of the native balance gas is paid from (eth_getBalance, receipts). */
  decimals: 18;
}

export interface ArcNetwork {
  chainId: ArcChainId;
  family: 'arc';
  name: string;
  explorerUrl: string;
  /** Its public endpoint: a read fallback only, never where a key's traffic has to go. */
  publicRpcUrl: string;
  gasAsset: GasAsset;
  /** Under this the node drops a transaction without an error. */
  minMaxFeePerGasWei: bigint;
  confirmations: 1;
  usdc: { address: Address; decimals: 6; eip712: { name: string; version: string } };
  contracts: {
    identityRegistry: Address;
    reputationRegistry: Address;
    validationRegistry: Address;
    multicall3: Address;
    create2Factory: Address;
    entryPointV06: Address;
    entryPointV07: Address;
    /** Null where it has no code: see docs/arc/STRATEGY.md. */
    smartWalletFactory: Address | null;
    spendPermissionManager: Address | null;
  };
}

const ARC_SHARED = {
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  create2Factory: '0x4e59b44847b379578588920cA78FbF26c0B4956C',
  entryPointV06: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  entryPointV07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
} as const satisfies Record<string, Address>;

const ARC_COMMON = {
  family: 'arc',
  gasAsset: { symbol: 'USDC', decimals: 18 },
  minMaxFeePerGasWei: 20_000_000_000n,
  confirmations: 1,
  usdc: { address: ARC_USDC, decimals: 6, eip712: { name: 'USDC', version: '2' } },
} as const;

export const ARC_NETWORKS: Readonly<Record<ArcChainId, ArcNetwork>> = Object.freeze({
  [ARC_MAINNET]: {
    ...ARC_COMMON,
    chainId: ARC_MAINNET,
    name: 'Arc',
    explorerUrl: 'https://explorer.arc.io',
    publicRpcUrl: 'https://rpc.mainnet.arc.io',
    contracts: {
      ...ARC_SHARED,
      identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
      validationRegistry: '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58',
      smartWalletFactory: '0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a',
      // Deployed by the owner's deploy page on 31 Oct 2026 (docs/arc/MAINNET_DEPLOY.md step 2).
      spendPermissionManager: '0xf85210B21cC50302F477BA56686d2019dC9b67Ad',
    },
  },
  [ARC_TESTNET]: {
    ...ARC_COMMON,
    chainId: ARC_TESTNET,
    name: 'Arc Testnet',
    explorerUrl: 'https://explorer.testnet.arc.io',
    publicRpcUrl: 'https://rpc.testnet.arc.io',
    contracts: {
      ...ARC_SHARED,
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      validationRegistry: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
      // Replayed from Base's deploys on 31 Oct 2026 (scripts/arc/replay-deploys.ts).
      smartWalletFactory: '0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a',
      spendPermissionManager: '0xf85210B21cC50302F477BA56686d2019dC9b67Ad',
    },
  },
});

/** Whether this deployment has Arc on: exactly CITY_ARC=1. */
export const arcSwitchedOn = (env: { CITY_ARC?: string } = {}) => env.CITY_ARC?.trim() === '1';

/** The Arc network for a chain id, or null when it isn't Arc or Arc is off (CITY_ARC=1). */
export function arcNetwork(chainId: number, env: { CITY_ARC?: string } = {}): ArcNetwork | null {
  if (!arcSwitchedOn(env)) return null;
  return (ARC_NETWORKS as Record<number, ArcNetwork | undefined>)[chainId] ?? null;
}

export function chainFamily(chainId: number): ChainFamily | null {
  if (chainId === ARC_MAINNET || chainId === ARC_TESTNET) return 'arc';
  return Object.hasOwn(BASE_NETWORKS, chainId) ? 'base' : null;
}

/** What gas is paid in on a chain, or null for a chain not listed here. */
export function gasAssetOf(chainId: number): GasAsset | null {
  const family = chainFamily(chainId);
  if (!family) return null;
  return family === 'arc' ? ARC_COMMON.gasAsset : { symbol: 'ETH', decimals: 18 };
}

/** Arc native units as USDC base units, rounded down (the ERC-20 interface truncates the same). */
export function usdcRawFromNativeWei(nativeWei: bigint): bigint {
  return nativeWei / ARC_NATIVE_PER_USDC_RAW;
}

/**
 * The chain sanctions are read on. The oracle has no code on Arc, but an address is the same person
 * on every EVM chain, so Arc asks the one on Base mainnet. Never skipped for having no local oracle.
 */
export function sanctionsOracleChainId(chainId: number): number {
  return chainFamily(chainId) === 'arc' ? BASE_MAINNET : chainId;
}

/** What any screen or route needs to name a chain and link to it. */
export interface ChainView {
  chainId: ChainId;
  slug: ChainFamily;
  name: string;
  explorerUrl: string;
  finality: 'instant' | 'finalized-tag';
  gasAsset: GasAsset;
  /** The chain's mark colour in the Explorer (its dot): Base blue, Arc black. */
  mark: string;
}

/** Each family's mark colour (src/verify/on-base.css .ob-chain-*). */
export const CHAIN_MARKS: Readonly<Record<ChainFamily, string>> = {
  base: '#0052ff',
  arc: '#0b0b0f',
};

const BASE_EXPLORERS: Readonly<Record<number, string>> = {
  [BASE_MAINNET]: 'https://basescan.org',
  84532: 'https://sepolia.basescan.org',
};

/** A chain as shown, or null for a chain not listed here. Says nothing about whether it is on. */
export function chainView(chainId: number): ChainView | null {
  const arc = (ARC_NETWORKS as Record<number, ArcNetwork | undefined>)[chainId];
  if (arc)
    return {
      chainId: arc.chainId,
      slug: 'arc',
      name: arc.name,
      explorerUrl: arc.explorerUrl,
      finality: 'instant',
      gasAsset: arc.gasAsset,
      mark: CHAIN_MARKS.arc,
    };
  const base = (BASE_NETWORKS as Record<number, (typeof BASE_NETWORKS)[BaseChainId] | undefined>)[
    chainId
  ];
  if (!base) return null;
  return {
    chainId: base.chainId,
    slug: 'base',
    name: base.name,
    explorerUrl: BASE_EXPLORERS[chainId] ?? '',
    finality: 'finalized-tag',
    gasAsset: { symbol: 'ETH', decimals: 18 },
    mark: CHAIN_MARKS.base,
  };
}

/**
 * The real-money chains this deployment has on, Base mainnet first: what a page listing every
 * chain's payments reads. Arc while CITY_ARC=1 (on the network CITY_ARC_CHAIN_ID names, mainnet
 * unless set). A new chain is added here once, and every such page lists it.
 */
export function liveChainIds(env: Record<string, string | undefined> = {}): number[] {
  const ids: number[] = [BASE_MAINNET];
  const arc = arcNetwork(Number(env.CITY_ARC_CHAIN_ID?.trim() || ARC_MAINNET), env);
  if (arc) ids.push(arc.chainId);
  return ids;
}

/** The live chains' names for a sentence ("Base and Arc"): a new chain needs no text change. */
export function liveChainNames(env: Record<string, string | undefined> = {}): string {
  return liveChainIds(env)
    .map((id) => chainView(id)?.name)
    .filter((name): name is string => Boolean(name))
    .join(' and ');
}

export interface ChainUsdc {
  address: Address;
  decimals: number;
  /** What a signature over this token names: Base mainnet says "USD Coin", Arc "USDC". */
  eip712: { name: string; version: string };
}

/** USDC on a listed chain, or null. Never assume the signing name: it differs per chain. */
export function usdcOf(chainId: number): ChainUsdc | null {
  const arc = (ARC_NETWORKS as Record<number, ArcNetwork | undefined>)[chainId];
  if (arc) return arc.usdc;
  const base = (BASE_NETWORKS as Record<number, (typeof BASE_NETWORKS)[BaseChainId] | undefined>)[
    chainId
  ];
  const usdc = base?.tokens.USDC;
  return usdc?.eip712
    ? { address: usdc.address, decimals: usdc.decimals, eip712: usdc.eip712 }
    : null;
}

/** A network the chain runtime can run on: Base's as they are, Arc's in the same shape. */
export type ChainNetwork = BaseNetwork;

/**
 * The network for a chain, or null when it is not on or not complete: Base by its own gate, Arc by
 * CITY_ARC=1 and only with a smart wallet factory and SpendPermissionManager recorded above. Those
 * are fixed in code, never by a setting, so Arc mainnet stays off until its deploys are recorded.
 */
export function chainNetwork(
  chainId: number,
  env: Record<string, string | undefined> = {},
): ChainNetwork | null {
  const base = baseNetwork(chainId, env);
  if (base) return base;
  const arc = arcNetwork(chainId, env);
  if (!arc) return null;
  const { smartWalletFactory, spendPermissionManager } = arc.contracts;
  if (!smartWalletFactory || !spendPermissionManager) return null;
  return {
    chainId: arc.chainId,
    name: arc.name,
    enabledByDefault: false,
    contracts: {
      smartWalletFactory,
      spendPermissionManager,
      entryPointV06: arc.contracts.entryPointV06,
      entryPointV07: arc.contracts.entryPointV07,
      identityRegistry: arc.contracts.identityRegistry,
      reputationRegistry: arc.contracts.reputationRegistry,
    },
    tokens: { USDC: { symbol: 'USDC', ...arc.usdc } },
    bundlerEnv: 'CITY_ARC_RPC_URL',
    confirmations: arc.confirmations,
  };
}

/**
 * A chain with real money. The safety gates that must hold there (a fee cap configured, pinned
 * sponsors) ask this, not "is it Base mainnet", so a second mainnet can't pass them by being new.
 */
export function isRealMoneyChain(chainId: number): boolean {
  return chainId === BASE_MAINNET || chainId === ARC_MAINNET;
}
