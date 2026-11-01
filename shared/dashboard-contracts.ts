/*
 * The contracts and wallets the Agent Dashboard lists (/dashboard "Contracts and wallets",
 * GET /api/public/dashboard/wallets). One reviewed module: every address comes from the constant
 * the rest of the code already uses, except the public x402 settle account, which the server reads
 * from CITY_X402_PUBLIC_SETTLE_ADDRESS at run time and has no code constant (its value is the
 * public one announced 25 Oct 2026; tests/dashboard.test.ts pins it).
 *
 * Two groups only (product owner, 30 Oct 2026): the three fee routers and the three payment
 * accounts. No treasury and no third-party contract is listed.
 */
import { OWN_PAYMASTER_RECORD } from './base/own-paymaster-record.js';
import { PROTOCOL_BASE_MAINNET, X402_FACILITATOR_BASE_MAINNET } from './protocol.js';

export type DashboardContractGroup = 'fees' | 'payments';
export type DashboardContractKind =
  'router1' | 'router2' | 'router3' | 'facilitator' | 'public_facilitator' | 'paymaster';

export interface DashboardContract {
  kind: DashboardContractKind;
  group: DashboardContractGroup;
  role: string;
  address: string;
}

/** The public x402 settle account (server/protocol/x402/public-settle.ts advertises it). */
export const PUBLIC_X402_SETTLE_ACCOUNT = '0x023f489781C18F45730cFD0357ecdc064A68BAC5';

export const DASHBOARD_CONTRACTS: readonly DashboardContract[] = Object.freeze([
  {
    kind: 'router1',
    group: 'fees',
    role: 'Fee router 1',
    address: PROTOCOL_BASE_MAINNET.feeRouter,
  },
  {
    kind: 'router2',
    group: 'fees',
    role: 'Fee router 2',
    address: PROTOCOL_BASE_MAINNET.feeRouter2,
  },
  {
    kind: 'router3',
    group: 'fees',
    role: 'Fee router 3',
    address: PROTOCOL_BASE_MAINNET.feeRouter3,
  },
  {
    kind: 'facilitator',
    group: 'payments',
    role: 'Facilitator',
    address: X402_FACILITATOR_BASE_MAINNET,
  },
  {
    kind: 'public_facilitator',
    group: 'payments',
    role: 'x402 public facilitator',
    address: PUBLIC_X402_SETTLE_ACCOUNT,
  },
  {
    kind: 'paymaster',
    group: 'payments',
    role: 'Paymaster',
    address: OWN_PAYMASTER_RECORD.address,
  },
]);

export const BASESCAN = 'https://basescan.org';
export const basescanAddress = (address: string) => `${BASESCAN}/address/${address}`;

/** One live balance, with the time it was read (a failed read keeps the last good one). */
export interface DashboardBalance {
  /** Wei, decimal text. */
  raw: string;
  as_of: string;
}

export interface DashboardWallet extends DashboardContract {
  /** ETH balance (the facilitators' gas). */
  eth: DashboardBalance | null;
  /** The paymaster's deposit in the EntryPoint (wei). */
  deposit: DashboardBalance | null;
  /** Facilitators: transactions sent so far (the account's nonce on Base). */
  transactions?: number | null;
  /** Paymaster: operations it has sponsored and that settled, so far. */
  operations?: number | null;
}

export interface DashboardWallets {
  chain_id: number;
  wallets: DashboardWallet[];
  /** When the chain was last read successfully (null: never yet). */
  as_of: string | null;
  /** The last read failed: the values are the last good ones, from as_of. */
  stale: boolean;
}
