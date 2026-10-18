/*
 * An agent's wallet as the console reads it (Operation Base Wallet W1, test network only;
 * server/base/wallet/routes.ts, behind CITY_BASE_WALLET). Balances are what the server read on
 * Base, with the block and time; nothing here is ever a promise of money.
 */
import { formatUnits, getAddress, isAddress } from 'viem';
import { api, ApiError } from '../../api';
import { WALLET_CHAIN_ID } from '../../../shared/base/wallet-network';
import { pageOutOfDate, STALE_PAGE, UNSUPPORTED_NETWORK } from '../stalePage';
import { heldOwnerKeys } from '../vault/keyPin';
import { signedInPerson } from '../signedInPerson';
import { isOwnWallet } from './derive';

export interface Amount {
  raw: string;
  decimals: number;
  display: string;
}

export interface WalletView {
  chainId: number;
  network: string;
  /** True on Base Sepolia (no real money); false on Base, where the USDC is real. */
  testnet: boolean;
  /** Null until the wallet key's backup is confirmed (funding stays locked until then). */
  address: string | null;
  ownerAddress: string;
  /** The agent's spending key (W3): the only key a spending limit may let spend. */
  spenderAddress?: string | null;
  deployed: boolean;
  fundingLocked: boolean;
  usdc: Amount;
  eth: Amount;
  readAtBlock: number;
  readAt: number;
  stale: boolean;
  explorerUrl: string | null;
}

/** The two networks a wallet can be on, exactly as the server names them. */
export type WalletNetwork =
  | { chainId: 8453; network: 'Base'; testnet: false }
  | { chainId: 84532; network: 'Base Sepolia'; testnet: true };

/**
 * The wallet's network when its chain, name and test flag are exactly one of the two; null for
 * anything else. Screens then show no address, QR or copy: never a funding address for a network
 * this page can't name correctly.
 */
export function walletNetwork(
  view: Pick<WalletView, 'chainId' | 'network' | 'testnet'>,
): WalletNetwork | null {
  // And only the network this build's wallets are on (the server is built from the same commit).
  if (view.chainId !== WALLET_CHAIN_ID) return null;
  if (view.chainId === 8453 && view.network === 'Base' && view.testnet === false)
    return { chainId: 8453, network: 'Base', testnet: false };
  if (view.chainId === 84532 && view.network === 'Base Sepolia' && view.testnet === true)
    return { chainId: 84532, network: 'Base Sepolia', testnet: true };
  return null;
}

export { UNSUPPORTED_NETWORK };

/** Why a wallet shows no network: this page is out of date, or the network isn't supported. */
export const networkProblem = (view: Pick<WalletView, 'chainId'>) =>
  pageOutOfDate(view.chainId) ? STALE_PAGE : UNSUPPORTED_NETWORK;

export const NOT_OWN_WALLET =
  'This isn’t the wallet your wallet key makes for this agent, so its address isn’t shown.';

/**
 * A wallet's address checked before it is shown. 'key': against the wallet key this browser held
 * itself (made, unlocked or restored here), the only check a funding address is shown on.
 * 'unlock': everything the account reports agrees, but this browser hasn't held the key yet (first
 * use here, or storage lost it): the address waits for one unlock.
 */
export type WalletCheck = { problem: string } | { problem: null; against: 'key' | 'unlock' };

/**
 * Checks a wallet's address before it is shown. The vault must be the signed-in person's own; the
 * wallet's owner their wallet key, as reported and as this browser held it; and the address exactly
 * the wallet that key makes for this agent (derive.ts). A substituted owner with its own correctly
 * derived wallet agrees with every report, so without a key held here nothing is offered for funds.
 * A wallet whose address isn't shown yet (before the backup) has nothing to check.
 */
export function checkOwnWallet(
  wallet: Pick<WalletView, 'address' | 'ownerAddress'>,
  vault: { accountId: string; ownerAddress: string | null },
  agentId: string,
): WalletCheck {
  if (!wallet.address) return { problem: null, against: 'unlock' };
  const owner = strictAddress(wallet.ownerAddress);
  const reported = strictAddress(vault.ownerAddress);
  if (!owner || !reported || reported !== owner) return { problem: NOT_OWN_WALLET };
  // Another account's vault than the session's: its accountId never picks the key it's held to.
  if (vault.accountId !== signedInPerson()) return { problem: NOT_OWN_WALLET };
  // A key this browser held that isn't the one reported now: never shown on the report alone.
  const held = heldOwnerKeys();
  if (held.some((key) => key !== owner)) return { problem: NOT_OWN_WALLET };
  if (!isOwnWallet(wallet.address, owner, agentId)) return { problem: NOT_OWN_WALLET };
  return { problem: null, against: held.length ? 'key' : 'unlock' };
}

/** GET …/wallet: the wallet, none yet, or unavailable (the feature is off: 404). */
export type WalletRead =
  | { kind: 'wallet'; wallet: WalletView }
  /**
   * The agent was registered on Base before wallets: its Base ID is in a wallet another key owns
   * (the owner's own wallet outside Central City). Shown, never used: no balance, no actions.
   */
  | { kind: 'registered_elsewhere'; address: `0x${string}`; ownerAddress: `0x${string}` }
  | { kind: 'none' }
  | { kind: 'off' }
  | { kind: 'chain_unavailable' };

const path = (agentId: string) => `/api/base/agents/${encodeURIComponent(agentId)}/wallet`;

const strictAddress = (value: unknown): `0x${string}` | null =>
  typeof value === 'string' &&
  /^0x[0-9a-fA-F]{40}$/.test(value) &&
  isAddress(value, { strict: true })
    ? getAddress(value)
    : null;

export async function readWallet(agentId: string): Promise<WalletRead> {
  try {
    const body = await api<
      WalletView | { wallet: null } | ({ kind: string } & Record<string, unknown>)
    >(path(agentId), undefined, 'GET');
    if ('wallet' in body && body.wallet === null) return { kind: 'none' };
    if ('kind' in body) {
      // Never read as a wallet: an answer with a kind is one of these, or nothing this page uses.
      const { address, ownerAddress, chainId } = body as Record<string, unknown>;
      const held = strictAddress(address);
      const owner = strictAddress(ownerAddress);
      if (body.kind === 'registered_elsewhere' && held && owner && chainId === WALLET_CHAIN_ID)
        return { kind: 'registered_elsewhere', address: held, ownerAddress: owner };
      throw new Error('This wallet can’t be shown here.');
    }
    return { kind: 'wallet', wallet: body as WalletView };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { kind: 'off' };
    if (error instanceof ApiError && error.status === 503) return { kind: 'chain_unavailable' };
    throw error;
  }
}

/** POST …/wallet: makes the agent's wallet from the person's wallet key (idempotent). */
export const ensureWallet = (agentId: string) => api<Partial<WalletView>>(path(agentId), {});

/** One USDC transfer log of the last 24 hours (the history reader). */
export interface WalletTransfer {
  at: number;
  block: number;
  blockHash: string;
  txHash: string;
  /** The log's index in its block: one transaction can move USDC more than once. */
  logIndex: number;
  kind: 'received' | 'spent' | 'withdrawn';
  amount: Amount;
  counterparty: string | null;
}

export interface WalletHistory {
  window: { from: number; to: number };
  headBlock: number;
  readAt: number;
  /** The balance when the window opened; null when the reader could not prove it (complete false). */
  startBalance: { usdc: Amount } | null;
  transfers: WalletTransfer[];
  /** The first block the reader scanned: nothing before it is claimed. */
  scannedFrom: number;
  /** True only when the scan covers the whole window. */
  complete: boolean;
}

/** A transfer's identity: its log (block hash, transaction, log index), never the transaction alone. */
export const transferKey = (transfer: WalletTransfer) =>
  `${transfer.blockHash}:${transfer.txHash}:${transfer.logIndex}`;

/** The whole window is read and its opening balance is known: the line and "none" can be shown. */
export const fullHistory = (
  history: WalletHistory | null,
): history is WalletHistory & { startBalance: { usdc: Amount } } =>
  !!history && history.complete && history.startBalance !== null;

/** Whether a transfer moved money between the wallet and itself (it changes nothing). */
export const isSelfTransfer = (transfer: WalletTransfer, address: string | null) =>
  !!address && transfer.counterparty?.toLowerCase() === address.toLowerCase();

/** What a transfer did to the balance, in USDC: in +, out −, to itself 0. */
export const transferDelta = (transfer: WalletTransfer, address: string | null) =>
  isSelfTransfer(transfer, address)
    ? 0
    : (transfer.kind === 'received' ? 1 : -1) * usdcNumber(transfer.amount);

/** The last 24 hours, or null while the reader isn't there yet (404) or Base can't be read. */
export async function readHistory(agentId: string): Promise<WalletHistory | null> {
  try {
    return await api<WalletHistory>(`${path(agentId)}/history?window=24h`, undefined, 'GET');
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 503)) return null;
    throw error;
  }
}

/** A signed USDC amount for the line and the list (6 decimals; display string as the server sent it). */
export const usdcNumber = (amount: Amount) => Number(amount.raw) / 10 ** amount.decimals;

/**
 * A USDC amount as text, exact to its base units with at least two decimals ("1.234567", "0.007",
 * "20.00"). For every amount a person reads: service payments are sub-cent, so rounding to cents
 * would show them as 0.00 or 0.01. usdcNumber stays for chart geometry only.
 */
export function usdcAmountText(amount: Pick<Amount, 'raw' | 'decimals'>): string {
  const text = formatUnits(BigInt(amount.raw), amount.decimals);
  const [whole, fraction = ''] = text.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

/** A USDC value the balance line computed (a number) as text, exact to the 6 decimals of USDC. */
export const usdcValueText = (value: number) =>
  usdcAmountText({ raw: String(Math.round(value * 1e6)), decimals: 6 });

/** ETH for gas, to four decimals without trailing zeros: 1 reads "1", never "1.". */
export const ethAmountText = (display: string) => {
  const value = Number(display);
  return value === 0 ? '0' : value < 0.0001 ? '<0.0001' : value.toFixed(4).replace(/\.?0+$/, '');
};
