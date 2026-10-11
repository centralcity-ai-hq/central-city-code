/*
 * The one network of Operation Base Wallet: Base (chain 8453). Every wallet route, the withdrawals
 * table, owner operations, the vault proof domain, the wallet balances reader and Base Pay take
 * their chain from here, so moving the wallets to another network is this one constant and nothing
 * else. Nothing is live by this constant alone: the wallet routes answer 404 until
 * CITY_BASE_WALLET=1, and Base needs its own gate open (CITY_BASE_MAINNET=1, chains.ts) or the
 * chain runtime and the wallet readers refuse to start (503). The settings the wallets need on Base
 * are listed in server/base/wallet/routes.ts.
 */
import { BASE_MAINNET, BASE_NETWORKS, BASE_SEPOLIA } from './chains.js';

export type WalletChainId = typeof BASE_SEPOLIA | typeof BASE_MAINNET;

export const WALLET_CHAIN_ID = BASE_MAINNET as WalletChainId;
export const WALLET_NETWORK = BASE_NETWORKS[WALLET_CHAIN_ID];
/** No real money: the screens say so while this is true. */
export const WALLET_TESTNET: boolean = WALLET_CHAIN_ID !== BASE_MAINNET;

const EXPLORERS: Record<WalletChainId, string> = {
  [BASE_SEPOLIA]: 'https://sepolia.basescan.org',
  [BASE_MAINNET]: 'https://basescan.org',
};
/** The block explorer of the wallet network, without a trailing slash. */
export const WALLET_EXPLORER = EXPLORERS[WALLET_CHAIN_ID];
