/*
 * The one allowlist of Base networks and contracts (docs/base/ARCHITECTURE.md §6, §11.1). Every
 * module reads chain ids, contract addresses and tokens from here; anything not listed is refused.
 * Addresses verified on-chain (eth_getCode) on 8 Oct 2026, the same on Base Sepolia and Base.
 * Mainnet is listed but disabled until the mainnet gate is opened (CITY_BASE_MAINNET=1).
 */

export type Address = `0x${string}`;

export const BASE_SEPOLIA = 84532;
export const BASE_MAINNET = 8453;
export const ANVIL = 31337;
export type BaseChainId = typeof BASE_SEPOLIA | typeof BASE_MAINNET | typeof ANVIL;

/**
 * Multicall3, at the same address on every OP Stack chain (a preinstall on Base and Base
 * Sepolia). Read only: it is only ever called with eth_call.
 */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** The constant SpendPermissionManager and our APIs use for native ETH. */
export const NATIVE_ETH: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export interface TokenInfo {
  symbol: 'USDC' | 'ETH';
  address: Address;
  decimals: number;
  /** The EIP-712 domain for EIP-3009 authorizations (USDC only). */
  eip712?: { name: string; version: string };
}

export interface BaseNetwork {
  chainId: BaseChainId;
  name: string;
  /** False until the gate for this network is open. */
  enabledByDefault: boolean;
  contracts: {
    smartWalletFactory: Address;
    spendPermissionManager: Address;
    /** Coinbase Smart Wallet v1 uses EntryPoint v0.6; v0.7 is listed for reference only. */
    entryPointV06: Address;
    entryPointV07: Address;
    identityRegistry: Address | null;
    /** ERC-8004 Reputation Registry (feedback after real interactions; owners cannot rate their own agents). */
    reputationRegistry: Address;
  };
  tokens: Record<'USDC' | 'ETH', TokenInfo>;
  /** The env var holding the CDP bundler/paymaster URL (it contains the key: never the URL itself). */
  bundlerEnv: string;
  /** Blocks after inclusion before an operation counts as final. */
  confirmations: number;
}

const SHARED = {
  smartWalletFactory: '0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a',
  spendPermissionManager: '0xf85210B21cC50302F477BA56686d2019dC9b67Ad',
  entryPointV06: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  entryPointV07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
} as const satisfies Record<string, Address>;

const ETH: TokenInfo = { symbol: 'ETH', address: NATIVE_ETH, decimals: 18 };

export const BASE_NETWORKS: Readonly<Record<BaseChainId, BaseNetwork>> = Object.freeze({
  [BASE_SEPOLIA]: {
    chainId: BASE_SEPOLIA,
    name: 'Base Sepolia',
    enabledByDefault: true,
    contracts: {
      ...SHARED,
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    },
    tokens: {
      USDC: {
        symbol: 'USDC',
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        decimals: 6,
        eip712: { name: 'USDC', version: '2' },
      },
      ETH,
    },
    bundlerEnv: 'CITY_BASE_CDP_SEPOLIA_RPC_URL',
    confirmations: 3,
  },
  [BASE_MAINNET]: {
    chainId: BASE_MAINNET,
    name: 'Base',
    enabledByDefault: false,
    contracts: {
      ...SHARED,
      identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    },
    tokens: {
      USDC: {
        symbol: 'USDC',
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        decimals: 6,
        eip712: { name: 'USD Coin', version: '2' },
      },
      ETH,
    },
    bundlerEnv: 'CITY_BASE_CDP_RPC_URL',
    confirmations: 12,
  },
  [ANVIL]: {
    chainId: ANVIL,
    name: 'Local Base fork',
    enabledByDefault: true,
    // A fork of Base Sepolia: the Sepolia registry exists there (bulk runs use our own copy).
    contracts: {
      ...SHARED,
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    },
    tokens: {
      USDC: {
        symbol: 'USDC',
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        decimals: 6,
        eip712: { name: 'USDC', version: '2' },
      },
      ETH,
    },
    bundlerEnv: 'CITY_BASE_ANVIL_RPC_URL',
    confirmations: 1,
  },
});

/** The network for a chain id, or null when it is not allowlisted or not enabled. */
export function baseNetwork(
  chainId: number,
  env: { CITY_BASE_MAINNET?: string } = {},
): BaseNetwork | null {
  const network = (BASE_NETWORKS as Record<number, BaseNetwork | undefined>)[chainId];
  if (!network) return null;
  if (network.chainId === BASE_MAINNET && env.CITY_BASE_MAINNET !== '1') return null;
  return network;
}

/** The token on a network by address (case-insensitive), or null when not allowlisted. */
export function allowedToken(network: BaseNetwork, address: string): TokenInfo | null {
  const lower = address.toLowerCase();
  return (
    Object.values(network.tokens).find((token) => token.address.toLowerCase() === lower) ?? null
  );
}
