/*
 * The wallet network as the wallet tests see it (shared/base/wallet-network.ts). Every wallet,
 * withdrawal and Pay test runs on whichever network that constant names, Base Sepolia or Base, and
 * checks the literal values below rather than the ones the code under test derives from the
 * constant. Rows on the other network are the ones a wallet route must never touch.
 */
import { BASE_MAINNET, BASE_NETWORKS, BASE_SEPOLIA, type Address } from '../shared/base/chains.js';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network.js';

interface ExpectedWalletNetwork {
  chainId: number;
  /** eth_chainId as that network's node answers it. */
  chainHex: string;
  name: string;
  testnet: boolean;
  explorer: string;
  usdc: Address;
  /** The canonical ERC-8004 Identity Registry of that network. */
  registry: Address;
  /** The setting holding that network's CDP endpoint (chains.ts bundlerEnv). */
  endpointEnv: string;
}

const TABLE: Record<typeof BASE_SEPOLIA | typeof BASE_MAINNET, ExpectedWalletNetwork> = {
  [BASE_SEPOLIA]: {
    chainId: 84532,
    chainHex: '0x14a34',
    name: 'Base Sepolia',
    testnet: true,
    explorer: 'https://sepolia.basescan.org',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    endpointEnv: 'CITY_BASE_CDP_SEPOLIA_RPC_URL',
  },
  [BASE_MAINNET]: {
    chainId: 8453,
    chainHex: '0x2105',
    name: 'Base',
    testnet: false,
    explorer: 'https://basescan.org',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    endpointEnv: 'CITY_BASE_CDP_RPC_URL',
  },
};

/** The network every wallet route serves, as the tests expect it. */
export const WALLET_EXPECTED = TABLE[WALLET_CHAIN_ID];
export const WALLET_NET = BASE_NETWORKS[WALLET_CHAIN_ID];

/** The other of the two wallet networks: nothing there is read, created or spent. */
export const OTHER_CHAIN_ID = WALLET_CHAIN_ID === BASE_MAINNET ? BASE_SEPOLIA : BASE_MAINNET;
export const OTHER_EXPECTED = TABLE[OTHER_CHAIN_ID];
export const OTHER_NET = BASE_NETWORKS[OTHER_CHAIN_ID];

/**
 * The wallet routes on, with the wallet network's own gate open: CITY_BASE_MAINNET=1 is what Base
 * needs (chains.ts) and changes nothing on Base Sepolia.
 */
export const WALLET_ON = { CITY_BASE_WALLET: '1', CITY_BASE_MAINNET: '1' } as const;
