/*
 * The contracts between the Base modules (docs/base/ARCHITECTURE.md §6 and §11). Modules depend
 * on these interfaces only, never on each other's internals. Token amounts are integer base units
 * (bigint in code, decimal strings in JSON). No type here ever carries a private key.
 */
import type { Address, BaseChainId } from './chains.js';

export type Hex = `0x${string}`;

/** A smart-account wallet's lifecycle. `derived` costs nothing: the address is counterfactual. */
export type WalletState = 'derived' | 'deployed' | 'frozen' | 'closed';

/** The CREATE2 recipe of an agent wallet; stored with the wallet, versioned. */
export interface WalletDerivation {
  version: 1;
  /** Ordered: [ownerEOA, SpendPermissionManager]. */
  owners: Address[];
  factory: Address;
  implementationVersion: string;
  accountIndex: string;
}

export interface WalletView {
  walletId: string;
  agentId: string;
  workspaceId: string;
  chainId: BaseChainId;
  /** The agent's counterfactual Coinbase Smart Wallet. */
  address: Address;
  ownerAddress: Address;
  /** The person whose vault key owns the wallet; null when the owner is an outside address. */
  ownerAccountId: string | null;
  /** The agent's spender smart account (§11.1); spends through the owner's on-chain permission. */
  spenderAddress: Address;
  derivation: WalletDerivation;
  state: WalletState;
  createdAt: number;
  updatedAt: number;
}

/** The on-chain SpendPermission struct (SpendPermissionManager), exact field types. */
export interface SpendPermission {
  account: Address;
  spender: Address;
  token: Address;
  /** uint160 */
  allowance: bigint;
  /** uint48 seconds */
  period: number;
  /** uint48 seconds */
  start: number;
  /** uint48 seconds */
  end: number;
  /** uint256 */
  salt: bigint;
  extraData: Hex;
}

export type SpendPermissionState = 'signed' | 'onchain' | 'revoked';

/** Every chain operation, written before broadcast (§11.3). */
export type ChainOpStatus =
  'queued' | 'submitted' | 'included' | 'final' | 'unknown' | 'reconciling' | 'reorged' | 'failed';

export type ChainOpKind =
  | 'userop'
  | 'batch'
  | 'transfer'
  | 'register'
  | 'approve'
  | 'pull'
  | 'settle'
  | 'cancel_authorization'
  | 'sweep'
  /** An owner withdrawal from an agent wallet, signed by the owner key in the browser. */
  | 'withdraw'
  /** The owner's no-op on a withdrawal's nonce, so that withdrawal can never land. */
  | 'withdraw_cancel'
  /** An owner's star rating of another agent from an agent wallet (Reputation Registry). */
  | 'rate';

export interface ChainOpRequest {
  /** Includes the chain id; the same key with a different intent hash is refused. */
  idempotencyKey: string;
  intentHash: Hex;
  chainId: BaseChainId;
  kind: ChainOpKind;
}

export interface ChainOpReceipt {
  opId: string;
  idempotencyKey: string;
  status: ChainOpStatus;
  userOpHash: Hex | null;
  txHash: Hex | null;
  blockNumber: bigint | null;
  gasUsed: bigint | null;
  feeWei: bigint | null;
  errorCode: string | null;
}

export type IdentityState = 'pending' | 'submitted' | 'confirmed' | 'failed';

export interface IdentityView {
  agentId: string;
  chainId: BaseChainId;
  registryAddress: Address;
  erc8004AgentId: bigint | null;
  agentCardUri: string;
  /** The account the identity token was minted to: the owner's smart account (§11.2). */
  ownerOfIdentity: Address;
  state: IdentityState;
  txHash: Hex | null;
}

/** Payment terminal outcomes are mutually exclusive (§11.5). */
export type PaymentState =
  | 'created'
  | 'pulling'
  | 'authorized'
  | 'settling'
  | 'paid'
  | 'reconciling'
  | 'refunded'
  /** Terminal: the operation finalized as failed (reverted, or provably never sent). */
  | 'failed';

export type PaymentSource = { agentId: string } | { fleetJobId: string };

export interface AmountByToken {
  token: Address;
  /** Integer base units. */
  amount: bigint;
}

/** What `ensureWallet` needs; idempotent on (agentId, chainId). */
export interface EnsureWalletInput {
  workspaceId: string;
  agentId: string;
  chainId: BaseChainId;
  ownerAddress: Address;
  /**
   * The person account whose vault holds `ownerAddress`'s key (vault wallets only). A wallet
   * linked to another account is a conflict; an unlinked one with the same owner is adopted.
   */
  ownerAccountId?: string;
}

export interface WalletService {
  ensureWallet(input: EnsureWalletInput): Promise<WalletView>;
  getWallet(agentId: string, chainId: BaseChainId): Promise<WalletView | null>;
  freeze(agentId: string, chainId: BaseChainId, actorId: string): Promise<WalletView>;
}

/** Serialize integer amounts for JSON; parse them back strictly. */
export const amountToJson = (value: bigint): string => value.toString(10);
export function amountFromJson(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value))
    throw new Error('Amount must be a non-negative integer string in base units.');
  return BigInt(value);
}
