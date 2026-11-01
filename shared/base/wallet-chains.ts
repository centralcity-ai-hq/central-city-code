/*
 * The chains this build lets an owner sign for: the Base network the wallets are on, and the two
 * Arc networks. The browser checks what the server asks an owner to sign, so everything it checks
 * against is here, in the build: the chain's id, EntryPoint, USDC, wallet factory,
 * SpendPermissionManager and sponsors. The server only says which of these chains an agent is on;
 * a chain not listed here is refused, and no address is ever taken from an answer.
 *
 * Whether Arc is on is the server's to say (CITY_ARC=1): a build with Arc off never gets an Arc
 * answer. Arc mainnet is listed but has no SpendPermissionManager recorded yet (shared/chains.ts),
 * so its wallets can't be derived and nothing is signed for it until that record is made.
 *
 * Each chain's public endpoint and identity registry are here too: where this browser reads a
 * payee or a rated agent from itself (src/base/wallet/pay.ts, rate.ts). The endpoints are the only
 * chain endpoints the Content-Security-Policy's connect-src lists (server/security-headers.ts).
 */
import {
  ARC_MAINNET,
  ARC_NETWORKS,
  ARC_TESTNET,
  chainNetwork,
  isRealMoneyChain,
} from '../chains.js';
import { BASE_MAINNET, type Address, type BaseChainId } from './chains.js';
import { PUBLIC_BASE_RPC } from './on-base.js';
import { SPONSOR_PAYMASTERS, type SponsorAllowlist } from './paymasters.js';
import type { LimitChain } from './spend-limits.js';
import { WALLET_CHAIN_ID, WALLET_NETWORK } from './wallet-network.js';
import { WITHDRAWAL_CHAIN, type OwnerOperationChain } from './withdraw.js';

/** The calm line for something the owner can't do on Arc yet. */
export const NOT_ON_ARC_YET = 'Not available on Arc yet.';

export interface WalletChain {
  chainId: number;
  name: string;
  testnet: boolean;
  /** What an owner operation's hash binds and what its one call may do. */
  owner: OwnerOperationChain;
  /** Null where it isn't recorded: then no wallet is derived and nothing is signed there. */
  factory: Address | null;
  manager: Address | null;
  /** The chain as the spend-limit functions take it; null without a SpendPermissionManager. */
  limit: LimitChain | null;
  /** Its public endpoint, for this browser's own reads; null where this site may not reach one. */
  publicRpc: string | null;
  /** Where its agents' IDs are minted: what those reads ask, never an address from an answer. */
  identityRegistry: Address | null;
}

function arcChain(chainId: typeof ARC_MAINNET | typeof ARC_TESTNET): WalletChain {
  const arc = ARC_NETWORKS[chainId];
  return {
    chainId,
    name: arc.name,
    testnet: !isRealMoneyChain(chainId),
    owner: {
      chainId,
      entryPoint: arc.contracts.entryPointV06,
      usdc: arc.usdc.address,
      // Native USDC is the gas balance: only ever moved through the ERC-20 interface.
      nativeWithdrawals: false,
    },
    factory: arc.contracts.smartWalletFactory,
    manager: arc.contracts.spendPermissionManager,
    limit: chainNetwork(chainId, { CITY_ARC: '1' }),
    publicRpc: arc.publicRpcUrl,
    identityRegistry: arc.contracts.identityRegistry,
  };
}

const WALLET_CHAINS: ReadonlyMap<number, WalletChain> = new Map(
  [
    {
      chainId: WALLET_CHAIN_ID,
      name: WALLET_NETWORK.name,
      testnet: !isRealMoneyChain(WALLET_CHAIN_ID),
      owner: WITHDRAWAL_CHAIN,
      factory: WALLET_NETWORK.contracts.smartWalletFactory,
      manager: WALLET_NETWORK.contracts.spendPermissionManager,
      limit: WALLET_CHAIN_ID as BaseChainId,
      publicRpc: (WALLET_CHAIN_ID as number) === BASE_MAINNET ? PUBLIC_BASE_RPC : null,
      identityRegistry: WALLET_NETWORK.contracts.identityRegistry,
    },
    arcChain(ARC_MAINNET),
    arcChain(ARC_TESTNET),
  ].map((chain) => [chain.chainId, Object.freeze(chain)]),
);

/** The listed chain with this id, or null for anything else (another number, not a number). */
export function walletChain(chainId: unknown): WalletChain | null {
  return typeof chainId === 'number' ? (WALLET_CHAINS.get(chainId) ?? null) : null;
}

/**
 * The chain an operation may be for: the agent's, as the wallet view names it (the wallet network
 * when not given), when this build lists it and the operation names the same one. Null otherwise:
 * an operation for another chain than the agent's is refused whichever way round they differ.
 */
export function operationChain(requested: unknown, agentChainId?: number): WalletChain | null {
  const chain = walletChain(agentChainId === undefined ? WALLET_CHAIN_ID : agentChainId);
  return chain && requested === chain.chainId ? chain : null;
}

/**
 * The Arc chain this browser reads a target on for an agent on `chainId`, or null for the wallet
 * network (not given included), whose own read stays as it is. Arc mainnet refuses until its record
 * is made, and any other chain refuses: `refuse` makes the error, before anything is read.
 */
export function arcReadChain(
  chainId: number | undefined,
  refuse: (message: string) => Error,
): (WalletChain & { publicRpc: string; identityRegistry: Address }) | null {
  if (chainId === undefined || chainId === WALLET_CHAIN_ID) return null;
  const chain = walletChain(chainId);
  if (!chain) throw refuse('This wallet’s network isn’t supported here.');
  if (!chain.manager || !chain.publicRpc || !chain.identityRegistry) throw refuse(NOT_ON_ARC_YET);
  return { ...chain, publicRpc: chain.publicRpc, identityRegistry: chain.identityRegistry };
}

/** The node's answer to eth_chainId is exactly this chain's id. */
export const isChainIdOf = (answer: unknown, chainId: number): boolean =>
  typeof answer === 'string' && /^0x[0-9a-f]+$/i.test(answer) && BigInt(answer) === BigInt(chainId);

/** How the wallet's screens name an agent's chain to a person. */
export interface ChainWords {
  /** "Base", or the Arc network's own name: "Checked on Arc Testnet". */
  on: string;
  /** What an agent's ID there is called. */
  id: string;
  /** Where a link to a transaction goes. */
  explorer: string;
  /** A fixed sentence written for Base, in this chain's words. Never for text holding a name. */
  say(text: string): string;
}

const BASE_WORDS: ChainWords = Object.freeze({
  on: 'Base',
  id: 'Base ID',
  explorer: 'Basescan',
  say: (text: string) => text,
});

/** The words for `chainId`: Base's, untouched, for anything but an Arc network. */
export function chainWords(chainId: unknown): ChainWords {
  if (chainId !== ARC_MAINNET && chainId !== ARC_TESTNET) return BASE_WORDS;
  const on = ARC_NETWORKS[chainId].name;
  return {
    on,
    id: 'Arc ID',
    explorer: 'Arc’s explorer',
    say: (text) =>
      text
        .replace(/\bA Base ID\b/g, 'An Arc ID')
        .replace(/\ba Base ID\b/g, 'an Arc ID')
        .replace(/\bBase ID\b/g, 'Arc ID')
        .replace(/\bBasescan\b/g, 'Arc’s explorer')
        .replace(/\bA Base\b/g, `An ${on}`)
        .replace(/\ba Base\b/g, `an ${on}`)
        .replace(/\bBase\b/g, on)
        // Arc is final once in a block: Base's wait isn't Arc's.
        .replace(/\bfinal in about 15 minutes/g, 'final in a moment')
        .replace(/\bFinal in about 15 minutes/g, 'Final in a moment')
        .replace(/\busually finalizes in 15–30 minutes, sometimes longer/g, 'finalizes in a moment')
        .replace(/\busually 15–30 min/g, 'usually a moment'),
  };
}

/*
 * Who may sponsor an owner operation, as the browser checks it. Base's list as it is, and Arc's
 * here rather than in SPONSOR_PAYMASTERS, which also feeds the server's refused destinations on
 * Base. Arc testnet: our paymaster from docs/arc/TESTNET.md, its runtime byte-identical to Base's.
 * Arc mainnet: its own paymaster, deployed 31 Oct 2026 and recorded in SPONSOR_PAYMASTERS (spread
 * above); an address the server names is never accepted.
 */
export const WALLET_SPONSORS: SponsorAllowlist = {
  ...SPONSOR_PAYMASTERS,
  [ARC_TESTNET]: ['0x96165D05A3a9C8fC56C08E21fB3f56D98709b4DB'],
};
