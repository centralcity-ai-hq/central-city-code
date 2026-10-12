/*
 * Owner withdrawals (Operation Base Wallet W2; contract v1, v1.1 gates 2 and 3; migration 89): the
 * owner of an agent's wallet on the wallet network (shared/base/wallet-network.ts) moves USDC or
 * ETH out of it with the vault key, which signs in the browser. The server never holds that key.
 *
 *   create   one balance read at one block minus what is held; the unsigned operation is prepared,
 *            sponsored by the paymaster (fees covered). When sponsorship is refused, unreachable or
 *            empty it fails closed (503 sponsorship_unavailable, nothing held or stored), unless the
 *            owner-funded fallback is on (CITY_BASE_WALLET_UNSPONSORED_FALLBACK=1, default off): the
 *            wallet then prefunds its gas from its own ETH, which must be there on top of the
 *            amount (else 409 fee_unfunded, never a smaller withdrawal). The amount (and an
 *            owner-funded operation's most expensive gas) is held (reservation 'withdrawal') and
 *            the withdrawal stored awaiting the owner's signature. Unsigned, it expires.
 *   sign     the signature must recover to the wallet's owner over the RAW userOpHash; it is stored,
 *            then the operation goes out through the durable chain path. A crash in between is
 *            resumed by the next read. A signed withdrawal never expires: it is live until its
 *            nonce is used (gate 2).
 *   read     brings the withdrawal up to date from its chain operation(s).
 *   cancel   a signed, not yet included withdrawal: the wallet's no-op at the SAME nonce, signed the
 *            same way. 'cancelled' only once that no-op is final and the original never landed; if
 *            the original wins, the withdrawal follows it. An unsigned withdrawal is just discarded.
 *
 * Authorized by the wallet's owner account (base_wallets.owner_account_id), never by current agent
 * access (gate 3): a removed or transferred agent's wallet stays withdrawable by its owner, also
 * when frozen (decision 4). One unfinished owner operation per wallet (gate 2). Audit events carry
 * amounts, addresses and hashes, never signatures.
 *
 * Pay without waiting (CITY_BASE_LANES=1, off by default; migration 95): each new operation runs
 * in its own nonce lane, key = laneKey(withdrawalId) (shared/base/lanes.ts), nonce key << 64 | 0,
 * stored with it; its cancel is the no-op at exactly that nonce. Gate 2 then becomes, under the
 * wallet's row lock: at most CITY_BASE_LANES_CAP (default 100) unfinished operations per wallet,
 * laned or not (409 too_many_open); balance minus everything held must cover the amount (409
 * funds_held, with how many are on their way); and one operation that deploys the wallet at a time
 * (409 operation_pending). Holds are released only on terminal evidence (final, failed, cancelled,
 * expired unsigned). Turned off again, laned operations still reconcile and settle, and new ones
 * wait (one at a time, as before) until none is unfinished. GET …/withdrawals?open=1 lists the
 * wallet's unfinished operations.
 *
 * A payment to another Central City agent (Operation Base Pay, pay/service.ts) is a USDC withdrawal
 * to a recipient the pay service re-verifies on Base right before the operation is prepared
 * (PaymentHooks): the same two phases, holds and one open operation per wallet, its own request
 * hash, and fees covered or nothing: the owner-funded fallback is never used for a payment.
 *
 * A rating (Operation Rating, rate/service.ts; migration 94) is a row of kind 'rate': one
 * giveFeedback call to the pinned Reputation Registry (shared/base/rate.ts rateCall, the exact call
 * the browser checks with checkRateOperation), prepared by `rate` once the rate service re-checked
 * both agents on Base (RatingHooks). The same owner signing, gate 2 (it waits for an unfinished
 * withdrawal or payment of the wallet, and they wait for it), status and cancel. It moves no money:
 * no token, amount or destination, no balance read, no hold, and sponsored or nothing (its cancel
 * too). Its view reads as a zero amount with no token, to the registry. Its own request hash and
 * audit kinds ('rating_…'). A signature is accepted only while the stored operation is exactly the
 * row's own call: a withdrawal's transfer, or a rating's giveFeedback, never the other.
 *
 * With lanes on, a rating gets its own lane exactly like a payment (lane_key = laneKey(id), nonce
 * laneNonce(id), `lanes: true` in its signing request) and waits for nothing: it counts toward the
 * same open cap (409 too_many_open), the same sponsor revert budget (409 sponsor_paused, at create
 * and at sign) and the same exposure caps (its own cost plus its cancel's headroom, since a signed
 * rating can be cancelled: 409 sponsor_busy), refuses a taken lane (409 lane_collision) and a second
 * deploying operation (409 operation_pending). No balance read, no hold, no funds_held/funds_moved.
 */
import { createHash, randomUUID } from 'node:crypto';
import { encodeAbiParameters, formatUnits, getAddress, isAddress, keccak256, type Hex } from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import type { Database, Transaction } from '../../database.js';
import { BASE_NETWORKS, NATIVE_ETH, type Address } from '../../../shared/base/chains.js';
import type { WalletDerivation } from '../../../shared/base/types.js';
import { WALLET_EXPLORER, WALLET_TESTNET } from '../../../shared/base/wallet-network.js';
import { laneKey, LaneKeyError } from '../../../shared/base/lanes.js';
import { sponsoredValidUntil } from '../../../shared/base/paymasters.js';
import {
  decodeOwnerCall,
  noopCall,
  ownerOperationHash,
  userOperationFromRpc,
  userOperationToRpc,
  WITHDRAWAL_CHAIN_ID,
  WITHDRAWAL_OPEN_STATES,
  WITHDRAWAL_SIGNATURE_TTL_MS,
  withdrawalCall,
  type RpcUserOperation,
  type WithdrawalState,
  type WithdrawalToken,
} from '../../../shared/base/withdraw.js';
import type { BalanceReader } from '../chain/balances.js';
import { DERIVATION_VERSION, type DerivationRecipe } from '../chain/derive.js';
import {
  OwnerOperationError,
  type OwnerOperationsPort,
  type PreparedOwnerOperation,
} from '../chain/owner-ops.js';
import {
  createReservationLedger,
  ReservationError,
  unavailableAmount,
} from '../chain/reservations.js';
import { maxCostWei, recoverRawSigner, type StoredOperation } from '../chain/submit.js';
import { walletRecipientRefusal } from '../payments/authority.js';
import {
  decodeRateCall,
  RATE_REGISTRY,
  RATE_TAG,
  rateCall,
  starsOf,
  starsValue,
  type Stars,
} from '../../../shared/base/rate.js';
import { PUBLIC_NAME } from '../explorer/store.js';

const NETWORK = BASE_NETWORKS[WITHDRAWAL_CHAIN_ID];
export const TX_EXPLORER = `${WALLET_EXPLORER}/tx/`;

export type WithdrawalErrorCode =
  | 'not_found'
  | 'invalid_body'
  | 'invalid_address'
  | 'invalid_amount'
  | 'invalid_signature'
  | 'backup_required'
  | 'destination_not_allowed'
  | 'insufficient_balance'
  | 'fee_unfunded'
  | 'idempotency_conflict'
  | 'operation_pending'
  | 'too_many_open'
  | 'funds_held'
  | 'lane_collision'
  | 'funds_moved'
  | 'sponsor_paused'
  | 'sponsor_busy'
  | 'cancel_over_headroom'
  | 'not_cancellable'
  | 'expired'
  | 'signature_mismatch'
  /** The stored operation is not exactly the row's own call; nothing is signed or sent. */
  | 'operation_mismatch'
  | 'fee_cap'
  | 'sponsorship_unavailable'
  | 'sponsorship_expired'
  | 'chain_unavailable';

const STATUS: Record<WithdrawalErrorCode, number> = {
  not_found: 404,
  invalid_body: 400,
  invalid_address: 400,
  invalid_amount: 400,
  invalid_signature: 400,
  backup_required: 409,
  destination_not_allowed: 409,
  insufficient_balance: 409,
  fee_unfunded: 409,
  idempotency_conflict: 409,
  operation_pending: 409,
  too_many_open: 409,
  funds_held: 409,
  lane_collision: 409,
  funds_moved: 409,
  sponsor_paused: 409,
  sponsor_busy: 409,
  cancel_over_headroom: 409,
  not_cancellable: 409,
  expired: 410,
  signature_mismatch: 422,
  operation_mismatch: 409,
  fee_cap: 503,
  sponsorship_unavailable: 503,
  sponsorship_expired: 409,
  chain_unavailable: 503,
};

export class WithdrawalError extends Error {
  readonly status: number;
  constructor(
    readonly code: WithdrawalErrorCode,
    message: string,
    /** Extra fields for the answer (e.g. the pending withdrawal's id); never secrets. */
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export interface WithdrawalAmount {
  raw: string;
  decimals: number;
  display: string;
}

/**
 * The network fee: paid by the paymaster when sponsored; otherwise the wallet prefunds it from its
 * own ETH and is charged at most `max` (what is not used comes back to it).
 */
export interface WithdrawalFee {
  paidBy: 'sponsor' | 'wallet';
  token: 'ETH';
  /** The most the wallet can be charged: zero when the sponsor pays. */
  max: WithdrawalAmount;
}

/** What the owner is asked to sign: the create answer (contract v1 W2). */
export interface WithdrawalSigningRequest {
  withdrawalId: string;
  state: WithdrawalState;
  userOperation: RpcUserOperation;
  userOpHash: Hex;
  entryPoint: Address;
  chainId: typeof WITHDRAWAL_CHAIN_ID;
  expiresAt: number;
  /**
   * Only for an operation in its own nonce lane (pay without waiting): its nonce is
   * laneNonce(withdrawalId), and the next one needn't wait for it. Absent otherwise.
   */
  lanes?: true;
  summary: {
    kind: 'withdraw';
    token: WithdrawalToken;
    amount: WithdrawalAmount;
    from: Address;
    to: Address;
    network: string;
    testnet: boolean;
    sponsored: boolean;
    fee: WithdrawalFee;
    /** The operation also deploys the wallet (its first owner operation). */
    deploysWallet: boolean;
    /** The destination has code (a smart wallet or contract): the screen warns. Null: unknown. */
    toIsContract: boolean | null;
  };
}

/**
 * What a rating rates, as signed: giveFeedback(agentId, value, 0, tag1, "", "", "", 0x0). The
 * shape of shared/base/rate.ts RateSummary, which the browser checks field by field
 * (src/base/wallet/rate.ts checkRateOperation).
 */
export interface RatingSummary {
  kind: 'rate';
  /** The pinned Reputation Registry (proxy) the one call goes to (RATE_REGISTRY). */
  registry: Address;
  /** giveFeedback's agentId: the rated agent's Base ID (decimal), never its Central City id. */
  agentId: string;
  /** stars × 20 (decimal): '20', '40', '60', '80' or '100' (valueDecimals 0). */
  value: string;
  tag1: typeof RATE_TAG;
  stars: Stars;
}

/** A rating as the withdrawal view names it: the summary, and who was rated (display only). */
export interface RatingView extends RatingSummary {
  /** The rated agent's Central City id. */
  ratedAgentId: string;
  /** Its public card name now; '' while the card is not public. Display only. */
  name: string;
}

/** A rating to sign (POST …/wallet/ratings): a withdrawal's signing request with its own summary. */
export interface RatingSigningRequest extends Omit<WithdrawalSigningRequest, 'summary'> {
  summary: RatingSummary & {
    from: Address;
    network: string;
    testnet: boolean;
    /** Always true: a rating is sponsored at no charge to the wallet, or not prepared. */
    sponsored: boolean;
    fee: WithdrawalFee;
    deploysWallet: boolean;
  };
}

export type CancelState =
  'awaiting_signature' | 'submitted' | 'included' | 'final' | 'failed' | 'expired';

/**
 * A withdrawal (or payment) as GET …/withdrawals/:id answers it. A rating adds `kind: 'rate'` and
 * `rating`; it moves no money, so its token is null, its amount zero (RATING_AMOUNT) and its `to`
 * the registry it calls: a screen that reads every operation as a transfer never breaks on it. A
 * withdrawal's answer carries no `kind`.
 */
export interface WithdrawalView {
  withdrawalId: string;
  kind?: 'rate';
  rating?: RatingView;
  state: WithdrawalState;
  token: WithdrawalToken | null;
  amount: WithdrawalAmount;
  from: Address;
  to: Address;
  network: string;
  chainId: typeof WITHDRAWAL_CHAIN_ID;
  userOpHash: Hex;
  sponsored: boolean;
  fee: WithdrawalFee;
  txHash: Hex | null;
  blockNumber: number | null;
  /**
   * In a block Base proves settled at its safe head (owner-ops.ts settledAtSafe), or final: the
   * operation can no longer be undone in practice. Final is only when `state` says so.
   */
  safe: boolean;
  errorCode: string | null;
  explorerUrl: string | null;
  /** Only while unsigned: after this it can no longer be signed. */
  expiresAt: number | null;
  /** The owner's no-op at the same nonce, once asked for. */
  cancel: null | {
    state: CancelState;
    userOpHash: Hex;
    /** The unsigned no-op to sign, only while it can still be signed. */
    userOperation: RpcUserOperation | null;
    entryPoint: Address;
    expiresAt: number | null;
    sponsored: boolean;
    fee: WithdrawalFee;
    txHash: Hex | null;
    explorerUrl: string | null;
  };
  /** Only for an operation in its own nonce lane (see WithdrawalSigningRequest.lanes). */
  lanes?: true;
  /** Only in the open list: the operation as prepared (to check a cancel, or a deployment). */
  userOperation?: RpcUserOperation;
  createdAt: number;
  updatedAt: number;
}

/** Pay without waiting: each new owner operation in its own nonce lane. OFF unless exactly '1'. */
export const LANES_SETTING = 'CITY_BASE_LANES';
/** The most unfinished owner operations per wallet with lanes on (default 100). */
export const LANES_CAP_SETTING = 'CITY_BASE_LANES_CAP';
export const LANES_CAP_DEFAULT = 100;

export function lanesEnabled(env: Record<string, string | undefined>): boolean {
  return env[LANES_SETTING] === '1';
}

/** A whole number from 1 to 1000; anything else is the default. */
export function lanesCap(env: Record<string, string | undefined>): number {
  const text = env[LANES_CAP_SETTING]?.trim();
  if (!text || !/^[1-9][0-9]{0,3}$/.test(text)) return LANES_CAP_DEFAULT;
  const cap = Number(text);
  return cap <= 1000 ? cap : LANES_CAP_DEFAULT;
}

/**
 * Sponsored reverts a wallet may cause in 24 hours before its new laned operations pause (default
 * 3): the sponsor's revert budget, apart from token holds.
 */
export const LANES_REVERT_BUDGET_SETTING = 'CITY_BASE_LANES_REVERT_BUDGET';
export const LANES_REVERT_BUDGET_DEFAULT = 3;
const REVERT_WINDOW_MS = 24 * 60 * 60_000;

/** A whole number from 1 to 1000; anything else is the default. */
export function lanesRevertBudget(env: Record<string, string | undefined>): number {
  const text = env[LANES_REVERT_BUDGET_SETTING]?.trim();
  if (!text || !/^[1-9][0-9]{0,3}$/.test(text)) return LANES_REVERT_BUDGET_DEFAULT;
  const budget = Number(text);
  return budget <= 1000 ? budget : LANES_REVERT_BUDGET_DEFAULT;
}

/**
 * The sponsor's exposure in flight: the most it may still pay in gas for sponsored operations (and
 * sponsored cancels) that are not finished, per wallet and in total. Hard ceilings: each sponsored
 * operation reserves its own max cost plus a cancel headroom (one fee cap). Absolute defaults (the
 * owner's decision): 0.1 ETH per wallet, 3 ETH in total (about USD 10k); the settings override
 * them, and a malformed or zero setting is its default.
 */
export const SPONSOR_INFLIGHT_WALLET_SETTING = 'CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET';
export const SPONSOR_INFLIGHT_TOTAL_SETTING = 'CITY_BASE_SPONSOR_INFLIGHT_WEI_TOTAL';
/** 0.1 ETH: the default ceiling of sponsored gas in flight per wallet. */
export const SPONSOR_INFLIGHT_WALLET_DEFAULT_WEI = 100_000_000_000_000_000n;
/** 3 ETH (about USD 10k): the default ceiling of sponsored gas in flight in total. */
export const SPONSOR_INFLIGHT_TOTAL_DEFAULT_WEI = 3_000_000_000_000_000_000n;
/** What a refused create is told to wait: about a minute, until something in flight ends. */
const SPONSOR_RETRY_SECONDS = 60;
/** The one advisory lock every exposure write takes first ("cc-spons" as a 64-bit key). */
const EXPOSURE_LOCK_KEY = '7161117711238328179';
/** Unsigned operations expired per pass when a cap is reached, and per sweep. */
const STALE_BATCH = 100;
/** Signed, unfinished operations brought up to date per sweep (least recently checked first). */
export const SWEEP_BATCH = 50;
/** How long one sweep may keep starting reads (like the wake drain); it ends well before the next. */
export const SWEEP_BUDGET_MS = 40_000;
/** The scheduled sweep (vercel.json crons, every minute). */
export const WALLET_SWEEP_PATH = '/api/cron/base-wallet-sweep';

/**
 * What is wrong with the sponsor settings, to say once at startup: a malformed or zero cap falls
 * back to its default, and a fee cap that is not a positive number leaves both caps off unless they
 * are set themselves.
 */
export function sponsorBudgetWarnings(env: Record<string, string | undefined>): string[] {
  const warnings: string[] = [];
  const positive = (text: string) => /^[1-9][0-9]{0,77}$/.test(text);
  for (const name of [SPONSOR_INFLIGHT_WALLET_SETTING, SPONSOR_INFLIGHT_TOTAL_SETTING]) {
    const text = env[name]?.trim();
    if (text && !positive(text))
      warnings.push(
        `${name} is not a positive whole number of wei; its default (${
          name === SPONSOR_INFLIGHT_WALLET_SETTING ? '0.1' : '3'
        } ETH) applies.`,
      );
  }
  const feeCap = env.CITY_BASE_WALLET_FEE_CAP_WEI?.trim();
  if (feeCap !== undefined && feeCap !== '' && !positive(feeCap))
    warnings.push(
      'CITY_BASE_WALLET_FEE_CAP_WEI is not a positive whole number: a cancel headroom is ' +
        "estimated from each operation's own gas instead.",
    );
  return warnings;
}

export interface SponsorBudget {
  perWallet: bigint | null;
  total: bigint | null;
  /** The cost cap of one owner operation (CITY_BASE_WALLET_FEE_CAP_WEI): a cancel's headroom. */
  feeCap: bigint | null;
}

export function sponsorBudget(env: Record<string, string | undefined>): SponsorBudget {
  const wei = (name: string) => {
    const text = env[name]?.trim();
    return text && /^[1-9][0-9]{0,77}$/.test(text) ? BigInt(text) : null;
  };
  const feeCap = wei('CITY_BASE_WALLET_FEE_CAP_WEI');
  return {
    perWallet: wei(SPONSOR_INFLIGHT_WALLET_SETTING) ?? SPONSOR_INFLIGHT_WALLET_DEFAULT_WEI,
    total: wei(SPONSOR_INFLIGHT_TOTAL_SETTING) ?? SPONSOR_INFLIGHT_TOTAL_DEFAULT_WEI,
    feeCap,
  };
}

/** The open list: at least this many, newest first (more when the cap is set higher). */
export const OPEN_LIST_MAX = 100;

/**
 * The owner-funded fallback: when sponsorship is unavailable, a withdrawal (or its cancel) may be
 * prepared unsponsored, its gas prefunded from the wallet's own ETH. OFF unless this setting is
 * exactly '1' (the rule is "fees covered"); off, an unsponsored operation is never prepared and the
 * request fails closed with 503 sponsorship_unavailable. It belongs to withdrawals alone: nothing
 * else reads this setting or decides to fall back (the chain port never does by itself).
 */
export const UNSPONSORED_FALLBACK_SETTING = 'CITY_BASE_WALLET_UNSPONSORED_FALLBACK';

export function unsponsoredFallbackEnabled(env: Record<string, string | undefined>): boolean {
  return env[UNSPONSORED_FALLBACK_SETTING] === '1';
}

export interface WithdrawalDeps {
  db: Database;
  /** The wallet network's owner-operations port; rejects when the chain is not configured. */
  operations(): Promise<OwnerOperationsPort>;
  /** Fresh balances at one block (never a cached read); absent when no endpoint is configured. */
  balances?: BalanceReader;
  /** Read per request: whether the owner-funded fallback is on (default: off). Never for a payment. */
  unsponsoredFallback?: () => boolean;
  /**
   * Called once per withdrawal, inside the transaction that records it as final (the payment's
   * notice, pay/service.ts). A failure rolls that transaction back; the next read tries again.
   */
  finalized?: (tx: Transaction, final: FinalWithdrawal) => Promise<void>;
  /**
   * Whether a withdrawal is a payment (pay/service.ts): its cancel is then sponsored or nothing,
   * whatever the owner-funded fallback setting says.
   */
  sponsoredOnly?: (withdrawalId: string) => Promise<boolean>;
  /** Whether ratings are on (CITY_BASE_RATE): a prepared rating is never signed while they are off. */
  ratingsEnabled?: () => boolean;
  /** Read per create: pay without waiting (default: off). */
  lanes?: () => boolean;
  /** Read per create with lanes on: the most unfinished operations per wallet (default 100). */
  openCap?: () => number;
  /** Read per create with lanes on: sponsored reverts allowed per wallet in 24 h (default 3). */
  revertBudget?: () => number;
  /** Read per create, lanes on or off: the sponsor's exposure caps in flight (default: none). */
  sponsorBudget?: () => SponsorBudget;
  /** A new withdrawal's id (default a random UUID); tests pin it to force a lane collision. */
  newId?: () => string;
  now?: () => number;
}

/** A withdrawal that just became final, as the `finalized` hook gets it. */
export interface FinalWithdrawal {
  withdrawalId: string;
  txHash: Hex | null;
  blockNumber: number | null;
  at: number;
}

/**
 * What the pay service (pay/service.ts) adds to a create; never taken from a request. A payment is
 * USDC only, an exact amount (never 'max'), sponsored or nothing.
 */
export interface PaymentHooks {
  /** The payment as asked for (its own request hash), bound into this withdrawal's request hash. */
  request: string;
  /**
   * Right before the operation is prepared, after every other check: the recipient checked again on
   * Base. Throws to refuse; nothing is prepared, held or stored then.
   */
  beforePrepare(): Promise<void>;
  /** In the transaction that stores the withdrawal: the payment's own record. */
  stored(tx: Transaction, withdrawalId: string): Promise<void>;
}

/** What a rating is (rate/service.ts resolved it from the lookup the person confirmed). */
export interface RatingTarget {
  /** The rated Central City agent. */
  agentId: string;
  /** Its Base ID. */
  baseId: bigint;
  stars: Stars;
}

/**
 * What the rate service (rate/service.ts) adds to a rating; never taken from a request as such.
 */
export interface RatingHooks {
  /** The rating as asked for (its own request hash), bound into this row's request hash. */
  request: string;
  idempotencyKey: string;
  /**
   * Right before the operation is prepared, after the wallet and gate-2 checks: both agents checked
   * again on Base; answers what to rate. Throws to refuse; nothing is prepared or stored then.
   */
  beforePrepare(): Promise<RatingTarget>;
  /** In the transaction that stores the rating (the daily count). Throws to refuse. */
  stored(tx: Transaction, withdrawalId: string): Promise<void>;
}

interface WalletRow {
  wallet_id: string;
  agent_id: string;
  operator_id: string;
  address: string;
  owner_address: string;
  spender_address: string | null;
  derivation: WalletDerivation;
  vault_owner: string | null;
  backup_confirmed_at: string | number | null;
}

interface Row {
  withdrawal_id: string;
  wallet_id: string;
  owner_account_id: string;
  /** 'rate': a rating (migration 94); token, amount and destination are null then. */
  kind: 'withdraw' | 'rate';
  token: WithdrawalToken | null;
  amount_raw: string | null;
  destination: string | null;
  rated_agent_id: string | null;
  rated_base_id: string | null;
  rating_value: number | null;
  idempotency_key: string;
  request_hash: string;
  state: WithdrawalState;
  nonce: string;
  user_operation: RpcUserOperation;
  user_op_hash: string;
  expires_at: string | number;
  owner_signature: Uint8Array | null;
  chain_op_key: string | null;
  signed_at: string | number | null;
  submitted_at: string | number | null;
  tx_hash: string | null;
  block_number: string | number | null;
  reservation_id: string | null;
  sponsored: boolean;
  max_fee_wei: string;
  fee_reservation_id: string | null;
  cancel_user_operation: RpcUserOperation | null;
  cancel_user_op_hash: string | null;
  cancel_expires_at: string | number | null;
  cancel_signature: Uint8Array | null;
  cancel_chain_op_key: string | null;
  cancel_submitted_at: string | number | null;
  cancel_state: CancelState | null;
  cancel_tx_hash: string | null;
  cancel_sponsored: boolean | null;
  cancel_max_fee_wei: string | null;
  error_code: string | null;
  /** The operation's own nonce lane (pay without waiting), as decimal; null on the owner lane. */
  lane_key: string | null;
  /** The hold on the wallet's ETH for an owner-funded cancel's gas, while one is asked for. */
  cancel_fee_reservation_id: string | null;
  created_at: string | number;
  updated_at: string | number;
}

const COLUMNS = `withdrawal_id, wallet_id, owner_account_id, kind, token,
  amount_raw::text AS amount_raw, destination, rated_agent_id, rated_base_id::text AS rated_base_id,
  rating_value, idempotency_key, request_hash, state, nonce::text AS nonce, user_operation,
  user_op_hash, expires_at, owner_signature, chain_op_key, signed_at, submitted_at, tx_hash,
  block_number, reservation_id, cancel_user_operation, cancel_user_op_hash, cancel_expires_at,
  cancel_signature, cancel_chain_op_key, cancel_submitted_at, cancel_state, cancel_tx_hash,
  sponsored, max_fee_wei::text AS max_fee_wei, fee_reservation_id, cancel_sponsored,
  cancel_max_fee_wei::text AS cancel_max_fee_wei, error_code, lane_key::text AS lane_key, cancel_fee_reservation_id,
  created_at, updated_at`;

/** Open states a signature has already authorized: their operations are followed on-chain. */
const SIGNED_OPEN: readonly WithdrawalState[] = ['submitted', 'included', 'cancel_pending'];

/** At most this many operations are brought up to date (or proven at the safe head) per request. */
const CATCH_UP_MAX = 20;

/** An included operation proven settled at the safe head, with the receipt it was proven for. */
interface Settled {
  withdrawalId: string;
  txHash: string;
  blockNumber: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** Destinations that would lose the funds or loop them back (contract decision 7). */
const REFUSED_DESTINATIONS = new Set(
  [
    ZERO_ADDRESS,
    NATIVE_ETH,
    NETWORK.contracts.spendPermissionManager,
    NETWORK.contracts.smartWalletFactory,
    NETWORK.contracts.entryPointV06,
    NETWORK.contracts.entryPointV07,
    NETWORK.tokens.USDC.address,
  ].map((address) => address.toLowerCase()),
);

const UINT256 = 2n ** 256n;
const RAW_AMOUNT = /^[1-9][0-9]{0,77}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

const tokenInfo = (token: WithdrawalToken) => NETWORK.tokens[token];
/** More than 10% above a fee: what a same-nonce replacement must offer. */
const outbid = (fee: bigint) => fee + fee / 10n + 1n;
/** The reservation ledger's token key: USDC's address, native ETH as the allowlisted constant. */
const tokenAddress = (token: WithdrawalToken): Address => tokenInfo(token).address;

const amountJson = (token: WithdrawalToken, raw: bigint): WithdrawalAmount => ({
  raw: raw.toString(10),
  decimals: tokenInfo(token).decimals,
  display: formatUnits(raw, tokenInfo(token).decimals),
});

const feeJson = (sponsored: boolean, maxWei: string | bigint): WithdrawalFee => ({
  paidBy: sponsored ? 'sponsor' : 'wallet',
  token: 'ETH',
  max: amountJson('ETH', sponsored ? 0n : BigInt(maxWei)),
});

/** The wallet lacks the ETH to prefund an unsponsored operation's gas; nothing is prepared. */
const unfunded = (fee: bigint, needed: bigint, available: bigint) =>
  new WithdrawalError(
    'fee_unfunded',
    'The network fee is not sponsored right now and the wallet does not hold enough ETH to pay it.',
    {
      fee: amountJson('ETH', fee),
      needed: amountJson('ETH', needed),
      available: amountJson('ETH', available),
    },
  );

const hexOf = (bytes: Uint8Array): Hex => `0x${Buffer.from(bytes).toString('hex')}`;
const num = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

/** Binds a chain operation key to exactly this withdrawal and the operation the owner signed. */
function intentHash(
  kind: 'withdraw' | 'withdraw_cancel' | 'rate',
  withdrawalId: string,
  wallet: Address,
  hash: string,
) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'string' },
        { type: 'bytes32' },
      ],
      [
        kind === 'withdraw'
          ? 'base-wallet-withdraw-v1'
          : kind === 'rate'
            ? 'base-wallet-rate-v1'
            : 'base-wallet-withdraw-cancel-v1',
        BigInt(WITHDRAWAL_CHAIN_ID),
        wallet,
        withdrawalId,
        hash as Hex,
      ],
    ),
  );
}

/** The lane a stored operation (and its cancel) runs in: its own, or (absent) the owner lane. */
const laneInput = (row: Pick<Row, 'lane_key'>): { nonceKey?: bigint } =>
  row.lane_key === null ? {} : { nonceKey: BigInt(row.lane_key) };

/**
 * Until when a prepared operation can be signed: its fixed signing deadline, or, in its own lane
 * and sponsored, the earlier of that and the paymaster's signed validUntil (prepare refused any
 * sponsorship ending after the deadline). A sponsorship that died frees its slot and exposure
 * then, not minutes later. Only unsigned operations ever expire; a signed one is never freed by it.
 */
const signableUntil = (
  deadline: number,
  laned: boolean,
  sponsored: boolean,
  operation: Pick<UserOperation<'0.6'>, 'paymasterAndData'>,
) => {
  if (!laned || !sponsored) return deadline;
  const until = sponsoredValidUntil(operation.paymasterAndData);
  return until === null ? deadline : Math.min(deadline, until);
};

/** `lanes: true` only for an operation in its own lane; nothing at all otherwise. */
const lanesFlag = (row: Pick<Row, 'lane_key'>): { lanes?: true } =>
  row.lane_key === null ? {} : { lanes: true };

/** The stored derivation as the chain module takes it. */
function recipeOf(wallet: WalletRow): DerivationRecipe {
  const d = wallet.derivation;
  if (
    !d ||
    d.version !== DERIVATION_VERSION ||
    !Array.isArray(d.owners) ||
    typeof d.factory !== 'string' ||
    typeof d.accountIndex !== 'string' ||
    !/^(0|[1-9][0-9]{0,77})$/.test(d.accountIndex)
  )
    throw new Error('The wallet has no usable derivation.');
  return {
    version: d.version,
    factory: getAddress(d.factory),
    owners: d.owners.map((owner) => getAddress(owner)),
    index: BigInt(d.accountIndex),
  };
}

/** The owner's index in the wallet's owners (the order the factory deployed them in). */
function ownerIndexOf(wallet: WalletRow): number {
  const owner = wallet.owner_address.toLowerCase();
  const index = recipeOf(wallet).owners.findIndex((address) => address.toLowerCase() === owner);
  if (index < 0) throw new Error('The wallet owner is not among its owners.');
  return index;
}

interface CreateBody {
  idempotencyKey: string;
  token: WithdrawalToken;
  amount: bigint | 'max';
  /** As sent (for the request hash); `to` is the checksummed form. */
  amountText: string;
  to: Address;
}

function parseCreate(input: unknown): CreateBody {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new WithdrawalError('invalid_body', 'Send idempotencyKey, token, amount and to.');
  const body = input as Record<string, unknown>;
  const allowed = ['idempotencyKey', 'token', 'amount', 'to'];
  // The network, the wallet and the owner are the server's: no other field is taken.
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new WithdrawalError(
      'invalid_body',
      'Only idempotencyKey, token, amount and to are taken.',
    );
  if (typeof body.idempotencyKey !== 'string' || !UUID.test(body.idempotencyKey))
    throw new WithdrawalError('invalid_body', 'idempotencyKey must be a UUID.');
  if (body.token !== 'USDC' && body.token !== 'ETH')
    throw new WithdrawalError('invalid_body', "token must be 'USDC' or 'ETH'.");
  const to = body.to;
  // A mixed-case address must carry a valid checksum (EIP-55); all lower case has none to check.
  if (typeof to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(to) || !isAddress(to, { strict: true }))
    throw new WithdrawalError(
      'invalid_address',
      'That is not a valid address (check its letters).',
    );
  const amount = body.amount;
  if (amount === 'max')
    return {
      idempotencyKey: body.idempotencyKey.toLowerCase(),
      token: body.token,
      amount,
      amountText: amount,
      to: getAddress(to),
    };
  if (typeof amount !== 'string' || !RAW_AMOUNT.test(amount) || BigInt(amount) >= UINT256)
    throw new WithdrawalError(
      'invalid_amount',
      "amount is a positive whole number of base units, or 'max'.",
    );
  return {
    idempotencyKey: body.idempotencyKey.toLowerCase(),
    token: body.token,
    amount: BigInt(amount),
    amountText: amount,
    to: getAddress(to),
  };
}

function parseSignature(input: unknown): Hex {
  const body = input as Record<string, unknown> | null;
  if (
    typeof body !== 'object' ||
    body === null ||
    Object.keys(body).length !== 1 ||
    typeof body.signature !== 'string' ||
    !SIGNATURE.test(body.signature)
  )
    throw new WithdrawalError('invalid_signature', 'Send the 65-byte signature as hex.');
  return body.signature as Hex;
}

/**
 * Same key, same body: the body the key was first used with, bound to the agent. A payment hashes
 * in its own domain, so a key used for a payment never replays a withdrawal, nor the other way round.
 */
function requestHash(agentId: string, body: CreateBody, payment?: PaymentHooks): string {
  const fields = [body.token, body.amountText, body.to];
  const canonical = JSON.stringify(
    payment ? ['pay-v1', agentId, ...fields, payment.request] : ['withdraw-v1', agentId, ...fields],
  );
  return `0x${createHash('sha256').update(canonical).digest('hex')}`;
}

/** A rating's own domain: its key never replays a withdrawal or a payment, nor the other way round. */
function ratingRequestHash(agentId: string, request: string): string {
  const canonical = JSON.stringify(['rate-v1', agentId, request]);
  return `0x${createHash('sha256').update(canonical).digest('hex')}`;
}

/** What a chain operation means for the withdrawal it belongs to. */
type Outcome =
  | 'pending'
  | 'included'
  | 'included_reverted'
  | 'final'
  | 'failed_reverted'
  | 'failed_replaced'
  | 'failed_other';

function outcomeOf(op: StoredOperation | null): Outcome {
  if (!op) return 'pending';
  if (op.status === 'final') return 'final';
  if (op.status === 'included')
    return op.errorCode === 'USEROP_REVERTED' ? 'included_reverted' : 'included';
  if (op.status === 'failed') {
    if (op.errorCode === 'USEROP_REVERTED') return 'failed_reverted';
    if (op.errorCode === 'NONCE_CONSUMED') return 'failed_replaced';
    return 'failed_other';
  }
  return 'pending';
}

const PUBLIC_ERROR: Partial<Record<Outcome, string>> = {
  included_reverted: 'reverted',
  failed_reverted: 'reverted',
  failed_replaced: 'replaced',
  failed_other: 'not_sent',
};

/** The block an operation landed in, when it did (a revert lands too); null otherwise. */
function landed(op: StoredOperation | null): { txHash: Hex; blockNumber: string } | null {
  const outcome = outcomeOf(op);
  if (!op?.txHash || op.blockNumber === null) return null;
  if (outcome === 'pending' || outcome === 'failed_replaced' || outcome === 'failed_other')
    return null;
  return { txHash: op.txHash.toLowerCase() as Hex, blockNumber: op.blockNumber };
}

/** A rating moves no money: its amount in the view (USDC's decimals, so a Pay screen reads it). */
export const RATING_AMOUNT: WithdrawalAmount = { raw: '0', decimals: 6, display: '0' };

/** A rating row's stars (migration 94 allows only 20 to 100 in steps of 20). */
function starsOfRow(row: Row): Stars {
  const stars = starsOf(BigInt(row.rating_value ?? -1));
  if (stars === null) throw new Error('A rating row without a rating value.');
  return stars;
}

/** The one call a row's own operation makes: its transfer, or its rating. */
function callOf(row: Row) {
  if (row.kind === 'rate') return rateCall(BigInt(row.rated_base_id!), starsOfRow(row));
  return withdrawalCall(row.token!, getAddress(row.destination!), BigInt(row.amount_raw!));
}

const ratingOf = (row: Row): RatingSummary => {
  const stars = starsOfRow(row);
  return {
    kind: 'rate',
    registry: RATE_REGISTRY,
    agentId: BigInt(row.rated_base_id!).toString(10),
    value: starsValue(stars).toString(10),
    tag1: RATE_TAG,
    stars,
  };
};

/**
 * Whether a row's stored operation is exactly what it was prepared as: from its wallet, at its
 * nonce, hashing to its userOpHash, and its callData exactly the row's own call (a withdrawal's
 * transfer, never a rating's giveFeedback, and the other way round). Anything else: false.
 */
function operationMatches(wallet: Address, row: Row): boolean {
  let op;
  try {
    op = userOperationFromRpc(row.user_operation);
  } catch {
    return false;
  }
  if (getAddress(op.sender) !== getAddress(wallet) || op.nonce !== BigInt(row.nonce)) return false;
  if (ownerOperationHash(op).toLowerCase() !== row.user_op_hash.toLowerCase()) return false;
  const rated = decodeRateCall(op.callData, wallet);
  const transfer = decodeOwnerCall(op.callData, wallet);
  if (row.kind === 'rate')
    return (
      transfer === null &&
      rated !== null &&
      rated.agentId === BigInt(row.rated_base_id!) &&
      starsValue(rated.stars) === BigInt(row.rating_value ?? -1)
    );
  return (
    rated === null &&
    transfer?.kind === 'withdraw' &&
    transfer.token === row.token &&
    transfer.to === getAddress(row.destination!) &&
    transfer.amount === BigInt(row.amount_raw!)
  );
}

function cancelStateOf(outcome: Outcome): CancelState {
  if (outcome === 'final') return 'final';
  if (outcome === 'included' || outcome === 'included_reverted') return 'included';
  if (outcome === 'pending') return 'submitted';
  return 'failed';
}

export function createWithdrawalService(deps: WithdrawalDeps) {
  const now = deps.now ?? Date.now;
  const db = deps.db;
  // Consume and release only; holds are placed in `create` with the read it already made.
  const ledger = createReservationLedger({
    chainId: WITHDRAWAL_CHAIN_ID,
    balanceOf: async () => {
      throw new Error('No balance read here.');
    },
    now,
  });

  const WALLET_COLUMNS = `w.wallet_id, w.agent_id, w.operator_id, w.address, w.owner_address,
    w.spender_address, w.derivation, v.owner_address AS vault_owner, v.backup_confirmed_at
    FROM base_wallets w
    LEFT JOIN base_owner_vaults v ON v.operator_id = w.owner_account_id`;

  async function walletOf(accountId: string, agentId: string): Promise<WalletRow> {
    const { rows } = await db.query<WalletRow>(
      `SELECT ${WALLET_COLUMNS}
       WHERE w.agent_id = $1 AND w.chain_id = $2 AND w.owner_account_id = $3`,
      [agentId, WITHDRAWAL_CHAIN_ID, accountId],
    );
    // Not the wallet's owner (a co-owner, a stranger) or no such wallet: not disclosed.
    if (!rows[0]) throw new WithdrawalError('not_found', 'Not found.');
    return rows[0];
  }

  async function load(wallet: WalletRow, withdrawalId: string): Promise<Row> {
    if (!UUID.test(withdrawalId)) throw new WithdrawalError('not_found', 'Not found.');
    const { rows } = await db.query<Row>(
      `SELECT ${COLUMNS} FROM base_wallet_withdrawals WHERE withdrawal_id = $1 AND wallet_id = $2`,
      [withdrawalId.toLowerCase(), wallet.wallet_id],
    );
    if (!rows[0]) throw new WithdrawalError('not_found', 'Not found.');
    return rows[0];
  }

  async function reload(row: Row): Promise<Row> {
    const { rows } = await db.query<Row>(
      `SELECT ${COLUMNS} FROM base_wallet_withdrawals WHERE withdrawal_id = $1`,
      [row.withdrawal_id],
    );
    return rows[0];
  }

  async function operations(): Promise<OwnerOperationsPort> {
    try {
      return await deps.operations();
    } catch {
      throw new WithdrawalError('chain_unavailable', 'Base cannot be reached right now.');
    }
  }

  async function audit(
    tx: Pick<Transaction, 'query'>,
    wallet: WalletRow,
    row: Row,
    kind: string,
    detail: Record<string, unknown> = {},
  ) {
    await tx.query(
      `INSERT INTO base_audit_events (at, actor, operator_id, agent_id, kind, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        now(),
        row.owner_account_id,
        wallet.operator_id,
        wallet.agent_id,
        // A rating's events are its own: rating_created, rating_signed, rating_final, …
        row.kind === 'rate' ? kind.replace(/^withdrawal_/, 'rating_') : kind,
        JSON.stringify({ withdrawalId: row.withdrawal_id, ...detail }),
      ],
    );
  }

  /**
   * A sponsored operation; only with the owner-funded fallback on, an owner-funded one when
   * sponsorship is unavailable. Off (the default), SPONSORSHIP_UNAVAILABLE stands: nothing is held,
   * stored or returned to sign.
   */
  async function prepareOwnerOperation(
    port: OwnerOperationsPort,
    input: Parameters<OwnerOperationsPort['prepare']>[0],
  ): Promise<PreparedOwnerOperation> {
    try {
      return await port.prepare(input);
    } catch (error) {
      if (
        !(error instanceof OwnerOperationError) ||
        error.code !== 'SPONSORSHIP_UNAVAILABLE' ||
        deps.unsponsoredFallback?.() !== true
      )
        throw error;
      return port.prepare({ ...input, ownerFunded: true });
    }
  }

  const operationError = (error: unknown): never => {
    if (error instanceof OwnerOperationError) {
      if (error.code === 'SPONSORSHIP_UNAVAILABLE')
        throw new WithdrawalError(
          'sponsorship_unavailable',
          'The network fee cannot be covered right now; nothing was prepared. Try again later.',
        );
      if (error.code === 'FEE_CAP')
        throw new WithdrawalError('fee_cap', 'Network fees are too high right now; try later.');
      if (error.code === 'NONCE_MOVED')
        throw new WithdrawalError('not_cancellable', 'The withdrawal already used its nonce.');
    }
    if (error instanceof WithdrawalError) throw error;
    throw new WithdrawalError('chain_unavailable', 'Base cannot be reached right now.');
  };

  /**
   * The withdrawal's holds (amount, and the gas of an unsponsored USDC withdrawal): consumed by its
   * operation when that landed (so they count until a balance read sees the debit), else released.
   */
  async function settleHolds(tx: Transaction, row: Row, landed: boolean) {
    for (const id of [row.reservation_id, row.fee_reservation_id]) {
      if (!id) continue;
      if (landed) await ledger.consume(tx, id, row.chain_op_key!);
      else await ledger.release(tx, id);
    }
  }

  /**
   * The hold for an owner-funded cancel's gas ends with the cancel: consumed when the no-op won
   * (cancelled), released once it can no longer be charged (it lapsed unsigned, failed, or the
   * original landed). Otherwise it stays.
   */
  async function settleCancelHold(tx: Transaction, row: Row) {
    const id = row.cancel_fee_reservation_id;
    if (!id) return;
    const { rows } = await tx.query<{ state: string }>(
      'SELECT state FROM base_wallet_reservations WHERE reservation_id = $1',
      [id],
    );
    if (rows[0]?.state !== 'held') return;
    if (row.state === 'cancelled' && row.cancel_chain_op_key)
      await ledger.consume(tx, id, row.cancel_chain_op_key);
    else if (
      row.cancel_state === 'expired' ||
      row.cancel_state === 'failed' ||
      row.state === 'final' ||
      row.state === 'failed'
    )
      await ledger.release(tx, id);
  }

  /**
   * Every write to the sponsor's exposure, and every change of an operation's state that settles
   * it, runs under ONE transaction-scoped advisory lock, taken FIRST in each such transaction
   * (before the wallet's row lock or any row it updates), so two of them can never wait on each
   * other in opposite orders. The sums below are exact across wallets under it.
   */
  async function exposureLock(tx: Pick<Transaction, 'query'>) {
    await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [EXPOSURE_LOCK_KEY]);
  }

  /**
   * The exposure that counts: held, and its operation still open (unsigned and not expired, or
   * signed and not finished). An unsigned operation past its time never counts, whether or not
   * anything has marked it expired yet.
   */
  async function exposureSums(tx: Pick<Transaction, 'query'>, walletId: string) {
    const { rows } = await tx.query<{ wallet: string; total: string }>(
      `SELECT coalesce(sum(e.amount) FILTER (WHERE e.wallet_id = $1), 0)::text AS wallet,
              coalesce(sum(e.amount), 0)::text AS total
       FROM base_sponsor_exposure e
       JOIN base_wallet_withdrawals w ON w.withdrawal_id = e.withdrawal_id
       WHERE e.chain_id = $2 AND e.state = 'held'
         AND (w.state IN ('submitted','included','cancel_pending')
           OR (w.state = 'awaiting_signature' AND w.expires_at > $3))`,
      [walletId, WITHDRAWAL_CHAIN_ID, now()],
    );
    return { wallet: BigInt(rows[0]?.wallet ?? '0'), total: BigInt(rows[0]?.total ?? '0') };
  }

  /**
   * Unsigned operations of ANY wallet past their time (oldest first, at most `limit`): expired,
   * their holds and exposure released. Under the exposure lock (the caller's transaction).
   */
  async function expireStaleEverywhere(tx: Transaction, limit: number): Promise<number> {
    await exposureLock(tx);
    const { rows } = await tx.query<Row>(
      `UPDATE base_wallet_withdrawals SET state = 'expired', updated_at = $1
       WHERE withdrawal_id IN (
         SELECT withdrawal_id FROM base_wallet_withdrawals
         WHERE chain_id = $2 AND state = 'awaiting_signature' AND expires_at <= $1
         ORDER BY expires_at, withdrawal_id LIMIT $3)
       RETURNING ${COLUMNS}`,
      [now(), WITHDRAWAL_CHAIN_ID, limit],
    );
    for (const old of rows) {
      await settleHolds(tx, old, false);
      await settleExposure(tx, old);
      const owner = await tx.query<WalletRow>(`SELECT ${WALLET_COLUMNS} WHERE w.wallet_id = $1`, [
        old.wallet_id,
      ]);
      if (owner.rows[0]) await audit(tx, owner.rows[0], old, 'withdrawal_expired');
    }
    return rows.length;
  }

  /**
   * Reserves the sponsor's exposure for one sponsored operation: its most expensive gas. In the
   * caller's transaction, under the exposure lock. Over a cap (per wallet or in total), unsigned
   * operations past their time anywhere are expired first and the sums read again; still over:
   * 409 sponsor_busy, and as the transaction rolls back nothing is reserved or stored.
   * retryAfterSeconds only when something counted can still end and make room. `enforce: false`
   * records without refusing (a cancel's extra cost: the owner can always cancel).
   */
  async function reserveExposure(
    tx: Transaction,
    input: {
      walletId: string;
      withdrawalId: string;
      holder: string;
      amount: bigint;
      enforce?: boolean;
      /**
       * What the caps are checked against when it is more than this row: every part one operation
       * reserves together (its cost and its headroom), in this ONE check, before any part is written.
       */
      together?: bigint;
    },
  ) {
    if (input.amount <= 0n) return;
    await exposureLock(tx);
    const need = input.together ?? input.amount;
    if (input.enforce !== false) {
      const budget = deps.sponsorBudget?.() ?? { perWallet: null, total: null };
      const over = (sums: { wallet: bigint; total: bigint }) => ({
        wallet: budget.perWallet !== null && sums.wallet + need > budget.perWallet,
        total: budget.total !== null && sums.total + need > budget.total,
      });
      let sums = await exposureSums(tx, input.walletId);
      let refused = over(sums);
      if ((refused.wallet || refused.total) && (await expireStaleEverywhere(tx, STALE_BATCH)) > 0) {
        sums = await exposureSums(tx, input.walletId);
        refused = over(sums);
      }
      if (refused.wallet || refused.total) {
        // Honest: room can only come from something counted that will end, and only if this
        // operation fits the cap at all.
        const roomLater =
          (!refused.wallet || (need <= budget.perWallet! && sums.wallet > 0n)) &&
          (!refused.total || (need <= budget.total! && sums.total > 0n));
        throw new WithdrawalError(
          'sponsor_busy',
          roomLater
            ? 'Many operations are on their way right now; try again in a minute.'
            : 'This operation is more than the network fee sponsorship allows right now.',
          roomLater
            ? {
                retryAfterSeconds: SPONSOR_RETRY_SECONDS,
                details: { retryAfterSeconds: SPONSOR_RETRY_SECONDS },
              }
            : { details: {} },
        );
      }
    }
    const at = now();
    await tx.query(
      `INSERT INTO base_sponsor_exposure (exposure_id, chain_id, wallet_id, withdrawal_id, holder,
         amount, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'held', $7, $7)
       ON CONFLICT (holder) DO NOTHING`,
      [
        randomUUID(),
        WITHDRAWAL_CHAIN_ID,
        input.walletId,
        input.withdrawalId,
        input.holder,
        input.amount.toString(10),
        at,
      ],
    );
  }

  /**
   * The cancel headroom a sponsored operation reserves at create, next to its own cost, so that a
   * cancel never has to add anything under the caps: the cost cap of one owner operation (a
   * sponsored no-op is never prepared above it), or without a cap the operation's own gas at the
   * outbid fees a replacement must offer. With it the caps are hard ceilings, cancels included.
   */
  const headroomFor = (operation: UserOperation<'0.6'>) => {
    const cap = deps.sponsorBudget?.().feeCap ?? null;
    if (cap !== null) return cap;
    return (
      (operation.callGasLimit +
        operation.verificationGasLimit * 3n +
        operation.preVerificationGas) *
      outbid(operation.maxFeePerGas)
    );
  };

  /** The headroom a withdrawal still holds for its cancel (0 when none). */
  async function headroomOf(tx: Pick<Transaction, 'query'>, withdrawalId: string) {
    const { rows } = await tx.query<{ total: string | null }>(
      `SELECT sum(amount)::text AS total FROM base_sponsor_exposure
       WHERE withdrawal_id = $1 AND holder LIKE 'headroom:%' AND state = 'held'`,
      [withdrawalId],
    );
    return BigInt(rows[0]?.total ?? '0');
  }

  /** Reserves a sponsored operation's own cost and its cancel headroom, both under the caps. */
  async function reserveWithHeadroom(
    tx: Transaction,
    input: {
      walletId: string;
      withdrawalId: string;
      operation: UserOperation<'0.6'>;
      cost: bigint;
    },
  ) {
    // Both parts checked together, once, against the current sums; then both written.
    const headroom = headroomFor(input.operation);
    await reserveExposure(tx, {
      walletId: input.walletId,
      withdrawalId: input.withdrawalId,
      holder: `withdrawal:${input.withdrawalId}`,
      amount: input.cost,
      together: input.cost + headroom,
    });
    await reserveExposure(tx, {
      walletId: input.walletId,
      withdrawalId: input.withdrawalId,
      holder: `headroom:${input.withdrawalId}`,
      amount: headroom,
      enforce: false,
    });
  }

  /**
   * A cancel's own exposure: its no-op and the original share one nonce, so only one of them can
   * ever be paid for. Only what the no-op could cost beyond the original's own exposure is
   * recorded, and never refused: the owner can always cancel.
   */
  const cancelExtra = (row: Row, cancelCost: bigint) => {
    const original = row.sponsored ? maxCostWei(userOperationFromRpc(row.user_operation)) : 0n;
    return cancelCost > original ? cancelCost - original : 0n;
  };

  /**
   * Defence in depth for an operation from before the exposure ledger, in the signing transaction
   * (under the exposure lock, taken first). A sponsored operation without its own exposure or its
   * cancel headroom gets them now; a sponsored cancel whose extra cost is beyond the headroom held
   * gets the difference. Each under the caps: over one, 409 sponsor_busy and nothing is signed.
   */
  async function ensureExposure(tx: Transaction, row: Row, which: 'operation' | 'cancel') {
    const held = async (holder: string) =>
      (
        await tx.query(`SELECT 1 FROM base_sponsor_exposure WHERE holder = $1 AND state = 'held'`, [
          holder,
        ])
      ).rows.length > 0;
    if (which === 'operation') {
      if (!row.sponsored) return;
      const operation = userOperationFromRpc(row.user_operation);
      // What is missing, checked together once against the caps, then written.
      const parts: Array<{ holder: string; amount: bigint }> = [];
      if (!(await held(`withdrawal:${row.withdrawal_id}`)))
        parts.push({ holder: `withdrawal:${row.withdrawal_id}`, amount: maxCostWei(operation) });
      if (!(await held(`headroom:${row.withdrawal_id}`)))
        parts.push({ holder: `headroom:${row.withdrawal_id}`, amount: headroomFor(operation) });
      const together = parts.reduce((sum, part) => sum + part.amount, 0n);
      for (const [i, part] of parts.entries())
        await reserveExposure(tx, {
          walletId: row.wallet_id,
          withdrawalId: row.withdrawal_id,
          ...part,
          ...(i === 0 ? { together } : { enforce: false }),
        });
      return;
    }
    if (!row.cancel_user_operation || row.cancel_sponsored === false) return;
    const extra = cancelExtra(row, maxCostWei(userOperationFromRpc(row.cancel_user_operation)));
    const room = await headroomOf(tx, row.withdrawal_id);
    if (extra > room)
      await reserveExposure(tx, {
        walletId: row.wallet_id,
        withdrawalId: row.withdrawal_id,
        holder: `headroom:${row.withdrawal_id}:${randomUUID()}`,
        amount: extra - room,
      });
  }

  /**
   * Releases the sponsor's exposure of a withdrawal on terminal evidence: all of it once the
   * withdrawal is final, failed, cancelled or expired; only its cancel's once that lapsed or failed.
   */
  async function releaseExposure(
    tx: Pick<Transaction, 'query'>,
    withdrawalId: string,
    scope: 'all' | 'cancel',
  ) {
    await tx.query(
      `UPDATE base_sponsor_exposure SET state = 'released', updated_at = $2
       WHERE withdrawal_id = $1 AND state = 'held' AND ($3::boolean OR holder LIKE 'cancel:%')`,
      [withdrawalId, now(), scope === 'all'],
    );
  }

  /** What a withdrawal's state says about its sponsor exposure (called with every change). */
  async function settleExposure(tx: Pick<Transaction, 'query'>, row: Row) {
    if (
      row.state === 'final' ||
      row.state === 'failed' ||
      row.state === 'cancelled' ||
      row.state === 'expired'
    )
      await releaseExposure(tx, row.withdrawal_id, 'all');
    else if (row.cancel_state === 'expired' || row.cancel_state === 'failed')
      await releaseExposure(tx, row.withdrawal_id, 'cancel');
  }

  /** An unsigned withdrawal past its time becomes expired; its hold is released. */
  async function expire(wallet: WalletRow, row: Row, errorCode: string | null): Promise<Row> {
    const at = now();
    const updated = await db.transaction(async (tx) => {
      await exposureLock(tx);
      const { rows } = await tx.query<Row>(
        `UPDATE base_wallet_withdrawals SET state = 'expired', error_code = $3, updated_at = $2
         WHERE withdrawal_id = $1 AND state = 'awaiting_signature'
           AND ($3::text IS NOT NULL OR expires_at <= $2)
         RETURNING ${COLUMNS}`,
        [row.withdrawal_id, at, errorCode],
      );
      if (!rows[0]) return null;
      await settleHolds(tx, rows[0], false);
      await settleExposure(tx, rows[0]);
      await audit(tx, wallet, rows[0], errorCode ? 'withdrawal_discarded' : 'withdrawal_expired');
      return rows[0];
    });
    return updated ?? reload(row);
  }

  /** Every unsigned withdrawal of the wallet past its time: expired, holds released. */
  async function expireStale(tx: Transaction, wallet: WalletRow) {
    await exposureLock(tx);
    const { rows } = await tx.query<Row>(
      `UPDATE base_wallet_withdrawals SET state = 'expired', updated_at = $2
       WHERE wallet_id = $1 AND state = 'awaiting_signature' AND expires_at <= $2
       RETURNING ${COLUMNS}`,
      [wallet.wallet_id, now()],
    );
    for (const old of rows) {
      await settleHolds(tx, old, false);
      await settleExposure(tx, old);
      await audit(tx, wallet, old, 'withdrawal_expired');
    }
  }

  async function settleExpiry(wallet: WalletRow, row: Row): Promise<Row> {
    if (row.state !== 'awaiting_signature' || Number(row.expires_at) > now()) return row;
    return expire(wallet, row, null);
  }

  /** The operation a withdrawal (or its cancel) sends, rebuilt from what was stored. */
  function submission(wallet: WalletRow, row: Row, kind: 'withdraw' | 'withdraw_cancel') {
    const cancel = kind === 'withdraw_cancel';
    const json = cancel ? row.cancel_user_operation : row.user_operation;
    const hash = cancel ? row.cancel_user_op_hash : row.user_op_hash;
    const signature = cancel ? row.cancel_signature : row.owner_signature;
    const key = cancel ? row.cancel_chain_op_key : row.chain_op_key;
    if (!json || !hash || !signature || !key) return null;
    const walletAddress = getAddress(wallet.address);
    // A rating's own operation is its own chain operation kind; any cancel is the same no-op.
    const opKind: 'withdraw' | 'withdraw_cancel' | 'rate' = cancel
      ? 'withdraw_cancel'
      : row.kind === 'rate'
        ? 'rate'
        : 'withdraw';
    return {
      idempotencyKey: key,
      intentHash: intentHash(opKind, row.withdrawal_id, walletAddress, hash),
      kind: opKind,
      wallet: walletAddress,
      recipe: recipeOf(wallet),
      calls: [cancel ? noopCall(walletAddress) : callOf(row)],
      operation: userOperationFromRpc(json),
      userOpHash: hash as Hex,
      owner: getAddress(wallet.owner_address),
      ownerIndex: ownerIndexOf(wallet),
      signature: hexOf(signature),
      ...laneInput(row),
    };
  }

  /** Marks, once, that an operation was stored for broadcast, with its audit event. */
  async function markSubmitted(
    wallet: WalletRow,
    row: Row,
    kind: 'withdraw' | 'withdraw_cancel',
    op: StoredOperation,
  ) {
    const column = kind === 'withdraw' ? 'submitted_at' : 'cancel_submitted_at';
    if (row[column] !== null) return;
    await db.transaction(async (tx) => {
      const { rows } = await tx.query<Row>(
        `UPDATE base_wallet_withdrawals SET ${column} = $2
         WHERE withdrawal_id = $1 AND ${column} IS NULL RETURNING ${COLUMNS}`,
        [row.withdrawal_id, now()],
      );
      if (rows[0])
        await audit(
          tx,
          wallet,
          rows[0],
          kind === 'withdraw' ? 'withdrawal_submitted' : 'withdrawal_cancel_submitted',
          { userOpHash: op.userOpHash.toLowerCase() },
        );
    });
  }

  /**
   * The chain operation of a signed withdrawal (or cancel), brought up to date. Signed and stored
   * here but never stored by the chain module (a crash or an outage in between): sent now, exactly
   * as signed. Null when the chain cannot be reached; the next read tries again.
   */
  async function follow(
    port: OwnerOperationsPort,
    wallet: WalletRow,
    row: Row,
    kind: 'withdraw' | 'withdraw_cancel',
  ): Promise<StoredOperation | null> {
    const input = submission(wallet, row, kind);
    if (!input) return null;
    let op = await port.refresh(input.idempotencyKey);
    if (!op) {
      try {
        op = await port.submit(input);
      } catch {
        return null;
      }
    }
    await markSubmitted(wallet, row, kind, op);
    return op;
  }

  /**
   * The state a signed, unfinished withdrawal is in, from its operation and its cancel's (gate 2):
   * the original landing decides everything; 'cancelled' needs the no-op final AND the original
   * failed because its nonce was used.
   */
  function decide(row: Row, original: StoredOperation | null, cancel: StoredOperation | null) {
    const at = now();
    const outcome = outcomeOf(original);
    const cancelSigned = row.cancel_signature !== null;
    const cancelOutcome = cancelSigned ? outcomeOf(cancel) : null;
    const cancelLive =
      cancelSigned || (row.cancel_user_op_hash !== null && Number(row.cancel_expires_at) > at);
    let state: WithdrawalState;
    if (outcome === 'final') state = 'final';
    else if (outcome === 'failed_reverted' || outcome === 'failed_other') state = 'failed';
    else if (outcome === 'failed_replaced')
      state =
        cancelOutcome === 'final'
          ? 'cancelled'
          : cancelSigned && (cancelOutcome === 'pending' || cancelOutcome?.startsWith('included'))
            ? 'cancel_pending'
            : 'failed';
    else if (outcome === 'included' || outcome === 'included_reverted') state = 'included';
    else state = cancelLive ? 'cancel_pending' : 'submitted';
    const cancelState: CancelState | null =
      row.cancel_user_op_hash === null
        ? null
        : cancelSigned
          ? cancelStateOf(cancelOutcome!)
          : cancelLive
            ? 'awaiting_signature'
            : 'expired';
    const errorCode =
      state === 'cancelled' || state === 'cancel_pending' || state === 'submitted'
        ? null
        : (PUBLIC_ERROR[outcome] ?? null);
    return {
      state,
      cancelState,
      errorCode,
      landed: landed(original),
      cancelLanded: landed(cancel),
    };
  }

  /**
   * Brings a withdrawal up to date; signed ones from the chain. Never throws for the chain. The
   * write applies only to the exact row it was decided from (state, the cancel's request,
   * signature and state, and the last write): a cancel requested or signed meanwhile makes it a
   * conflict, and the row is read and decided again (a bounded number of times).
   */
  async function advance(wallet: WalletRow, row: Row, attempt = 0): Promise<Row> {
    row = await settleExpiry(wallet, row);
    if (!SIGNED_OPEN.includes(row.state)) return row;
    let port: OwnerOperationsPort;
    try {
      port = await deps.operations();
    } catch {
      return row;
    }
    const original = await follow(port, wallet, row, 'withdraw');
    const cancel = row.cancel_signature ? await follow(port, wallet, row, 'withdraw_cancel') : null;
    // The chain could not be read: keep what is stored rather than guess.
    if (!original) return row;
    const next = decide(row, original, cancel);
    const txHash = next.landed?.txHash ?? null;
    const blockNumber = next.landed ? Number(next.landed.blockNumber) : null;
    const cancelTx = next.cancelLanded?.txHash ?? null;
    if (
      next.state === row.state &&
      next.cancelState === row.cancel_state &&
      next.errorCode === row.error_code &&
      txHash === row.tx_hash &&
      blockNumber === num(row.block_number) &&
      cancelTx === row.cancel_tx_hash
    )
      return row;
    const updated = await db.transaction(async (tx) => {
      await exposureLock(tx);
      const { rows } = await tx.query<Row>(
        `UPDATE base_wallet_withdrawals SET state = $3, cancel_state = $4, error_code = $5,
           tx_hash = $6, block_number = $7, cancel_tx_hash = $8, updated_at = $9,
           reverted_at = CASE WHEN $5::text = 'reverted' THEN coalesce(reverted_at, $9)
             ELSE reverted_at END
         WHERE withdrawal_id = $1 AND state = $2
           AND cancel_state IS NOT DISTINCT FROM $10
           AND cancel_user_op_hash IS NOT DISTINCT FROM $11
           AND cancel_signature IS NOT DISTINCT FROM $12
           AND updated_at = $13
         RETURNING ${COLUMNS}`,
        [
          row.withdrawal_id,
          row.state,
          next.state,
          next.cancelState,
          next.errorCode,
          txHash,
          blockNumber,
          cancelTx,
          now(),
          row.cancel_state,
          row.cancel_user_op_hash,
          row.cancel_signature,
          row.updated_at,
        ],
      );
      const done = rows[0];
      if (!done) return null;
      await settleCancelHold(tx, done);
      await settleExposure(tx, done);
      if (done.state === row.state) return done;
      if (done.state === 'final') {
        await settleHolds(tx, done, true);
        await audit(tx, wallet, done, 'withdrawal_final', { txHash, blockNumber });
        await deps.finalized?.(tx, {
          withdrawalId: done.withdrawal_id,
          txHash,
          blockNumber,
          at: now(),
        });
      } else if (done.state === 'failed' || done.state === 'cancelled') {
        // A revert landed and spent (gas, when unsponsored); anything else never landed.
        await settleHolds(tx, done, done.state === 'failed' && done.error_code === 'reverted');
        await audit(
          tx,
          wallet,
          done,
          done.state === 'failed' ? 'withdrawal_failed' : 'withdrawal_cancelled',
          done.state === 'failed'
            ? { errorCode: done.error_code, txHash }
            : { cancelTxHash: cancelTx },
        );
      }
      return done;
    });
    if (updated) return updated;
    // Written meanwhile (a cancel requested or signed, another read): decide again from the row
    // as it is now, never from the older one.
    const current = await reload(row);
    return attempt < 2 ? advance(wallet, current, attempt + 1) : current;
  }

  /**
   * A withdrawal as every answer shows it (GET and the POST answers alike): `safe` once final, or
   * included, not reverted, and proven settled at the safe head for its exact receipt.
   */
  async function present(wallet: WalletRow, row: Row): Promise<WithdrawalView> {
    const safe =
      row.state === 'final' ||
      (row.state === 'included' &&
        row.error_code === null &&
        isSettled(await settledIncluded(wallet, row), row));
    return view(wallet, row, safe);
  }

  /** The rated agent's public card name now ('' while it is not public); display only. */
  async function ratedName(agentId: string): Promise<string> {
    const { rows } = await db.query<{ name: string | null }>(
      `SELECT p.name FROM (SELECT $1::text AS agent_id) l ${PUBLIC_NAME}`,
      [agentId],
    );
    return rows[0]?.name ?? '';
  }

  async function view(
    wallet: WalletRow,
    row: Row,
    safe = row.state === 'final',
  ): Promise<WithdrawalView> {
    const txHash = (row.tx_hash as Hex | null) ?? null;
    const cancelTx = (row.cancel_tx_hash as Hex | null) ?? null;
    const cancelOpen =
      row.cancel_state === 'awaiting_signature' &&
      row.cancel_signature === null &&
      Number(row.cancel_expires_at) > now();
    const rating = row.kind === 'rate';
    return {
      withdrawalId: row.withdrawal_id,
      // Only a rating says what it is; a withdrawal's answer is as it always was.
      ...(rating
        ? {
            kind: 'rate' as const,
            rating: {
              ...ratingOf(row),
              ratedAgentId: row.rated_agent_id!,
              name: await ratedName(row.rated_agent_id!),
            },
          }
        : {}),
      state: row.state,
      // A rating moves no money: no token, a zero amount, to the registry it calls.
      token: rating ? null : row.token,
      amount: rating ? RATING_AMOUNT : amountJson(row.token!, BigInt(row.amount_raw!)),
      from: getAddress(wallet.address),
      to: rating ? RATE_REGISTRY : getAddress(row.destination!),
      network: NETWORK.name,
      chainId: WITHDRAWAL_CHAIN_ID,
      userOpHash: row.user_op_hash as Hex,
      sponsored: row.sponsored,
      fee: feeJson(row.sponsored, row.max_fee_wei),
      txHash,
      blockNumber: num(row.block_number),
      safe,
      errorCode: row.error_code,
      explorerUrl: txHash ? `${TX_EXPLORER}${txHash}` : null,
      expiresAt: row.state === 'awaiting_signature' ? Number(row.expires_at) : null,
      cancel:
        row.cancel_user_op_hash === null
          ? null
          : {
              // An unsigned cancel past its time reads as expired even before the next refresh.
              state:
                row.cancel_state === 'awaiting_signature' && !cancelOpen
                  ? 'expired'
                  : row.cancel_state!,
              userOpHash: row.cancel_user_op_hash as Hex,
              userOperation: cancelOpen ? row.cancel_user_operation : null,
              entryPoint: NETWORK.contracts.entryPointV06,
              expiresAt: cancelOpen ? Number(row.cancel_expires_at) : null,
              sponsored: row.cancel_sponsored !== false,
              fee: feeJson(row.cancel_sponsored !== false, row.cancel_max_fee_wei ?? '0'),
              txHash: cancelTx,
              explorerUrl: cancelTx ? `${TX_EXPLORER}${cancelTx}` : null,
            },
      ...lanesFlag(row),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async function signingRequest(
    wallet: WalletRow,
    row: Row,
    toIsContract: boolean | null,
  ): Promise<WithdrawalSigningRequest> {
    return {
      withdrawalId: row.withdrawal_id,
      state: row.state,
      userOperation: row.user_operation,
      userOpHash: row.user_op_hash as Hex,
      entryPoint: NETWORK.contracts.entryPointV06,
      chainId: WITHDRAWAL_CHAIN_ID,
      expiresAt: Number(row.expires_at),
      ...lanesFlag(row),
      summary: {
        kind: 'withdraw',
        token: row.token!,
        amount: amountJson(row.token!, BigInt(row.amount_raw!)),
        from: getAddress(wallet.address),
        to: getAddress(row.destination!),
        network: NETWORK.name,
        testnet: WALLET_TESTNET,
        sponsored: row.sponsored,
        fee: feeJson(row.sponsored, row.max_fee_wei),
        deploysWallet: row.user_operation.initCode !== '0x',
        toIsContract,
      },
    };
  }

  /** A rating to sign: the same request as a withdrawal's, its summary the rating itself. */
  function ratingSigningRequest(wallet: WalletRow, row: Row): RatingSigningRequest {
    return {
      withdrawalId: row.withdrawal_id,
      state: row.state,
      userOperation: row.user_operation,
      userOpHash: row.user_op_hash as Hex,
      entryPoint: NETWORK.contracts.entryPointV06,
      chainId: WITHDRAWAL_CHAIN_ID,
      expiresAt: Number(row.expires_at),
      ...lanesFlag(row),
      summary: {
        ...ratingOf(row),
        from: getAddress(wallet.address),
        network: NETWORK.name,
        testnet: WALLET_TESTNET,
        sponsored: row.sponsored,
        fee: feeJson(row.sponsored, row.max_fee_wei),
        deploysWallet: row.user_operation.initCode !== '0x',
      },
    };
  }

  async function byKey(accountId: string, key: string): Promise<Row | null> {
    const { rows } = await db.query<Row>(
      `SELECT ${COLUMNS} FROM base_wallet_withdrawals
       WHERE owner_account_id = $1 AND idempotency_key = $2`,
      [accountId, key],
    );
    return rows[0] ?? null;
  }

  /** The same key again: the same body gets the same withdrawal, another body is refused. */
  async function replay(wallet: WalletRow, existing: Row, hash: string) {
    if (
      existing.kind !== 'withdraw' ||
      existing.request_hash !== hash ||
      existing.wallet_id !== wallet.wallet_id
    )
      throw new WithdrawalError(
        'idempotency_conflict',
        'This idempotencyKey was used for another withdrawal.',
      );
    const row = await advance(wallet, existing);
    const port = await deps.operations().catch(() => null);
    const toIsContract = port ? await port.isContract(getAddress(row.destination!)) : null;
    return signingRequest(wallet, row, toIsContract);
  }

  /** The same key again for a rating: the same rating as it is now; anything else is refused. */
  async function replayRating(wallet: WalletRow, existing: Row, hash: string) {
    if (
      existing.kind !== 'rate' ||
      existing.request_hash !== hash ||
      existing.wallet_id !== wallet.wallet_id
    )
      throw new WithdrawalError(
        'idempotency_conflict',
        'This idempotencyKey was used for another operation.',
      );
    return ratingSigningRequest(wallet, await advance(wallet, existing));
  }

  /**
   * The wallet's open owner operation, ignoring unsigned ones whose time is up and the included
   * ones in `settled` (proven settled at Base's safe head, `settledIncluded`), matched by id AND
   * the receipt the proof was made for (transaction and block): their nonce is used for good and
   * their amount stays held until final, so the next operation can start. Every other included
   * operation still blocks, also one whose recorded receipt changed since it was proven. This is
   * the one-at-a-time rule (lanes off): an unfinished operation in a lane of its own always counts
   * here, so with lanes turned off again new ones wait until every laned one is finished.
   */
  async function openOn(
    tx: Pick<Transaction, 'query'>,
    walletId: string,
    settled: readonly Settled[],
  ): Promise<string | null> {
    const { rows } = await tx.query<{ withdrawal_id: string }>(
      `SELECT withdrawal_id FROM base_wallet_withdrawals w
       WHERE wallet_id = $1 AND state = ANY($2::text[])
         AND NOT (state = 'awaiting_signature' AND expires_at <= $3)
         AND NOT (state = 'included' AND lane_key IS NULL AND EXISTS (
           SELECT 1 FROM unnest($4::text[], $5::text[], $6::bigint[]) AS s(id, tx, block)
           WHERE s.id = w.withdrawal_id AND s.tx = w.tx_hash AND s.block = w.block_number))
       LIMIT 1`,
      [
        walletId,
        [...WITHDRAWAL_OPEN_STATES],
        now(),
        settled.map((s) => s.withdrawalId),
        settled.map((s) => s.txHash),
        settled.map((s) => s.blockNumber),
      ],
    );
    return rows[0]?.withdrawal_id ?? null;
  }

  /** Whether `row` is one of `settled`, with the very receipt the proof was made for. */
  const isSettled = (settled: readonly Settled[], row: Row) =>
    settled.some(
      (s) =>
        s.withdrawalId === row.withdrawal_id &&
        s.txHash === row.tx_hash &&
        row.block_number !== null &&
        s.blockNumber === String(row.block_number),
    );

  /**
   * The wallet's included operations (or just `only`) that Base proves settled at its safe head
   * (owner-ops.ts settledAtSafe: this operation's own receipt in the canonical block, at or below
   * the safe head, its lane's nonce used), each with the receipt it was proven for. Anything Base
   * can't tell right now is left out, so it keeps blocking.
   */
  async function settledIncluded(
    wallet: WalletRow,
    only?: Row,
    /** Proofs already made in this request, by withdrawal id, transaction and block. */
    memo: Map<string, boolean> = new Map(),
  ): Promise<Settled[]> {
    const { rows } = only
      ? { rows: only.state === 'included' ? [only] : [] }
      : await db.query<Row>(
          `SELECT ${COLUMNS} FROM base_wallet_withdrawals
           WHERE wallet_id = $1 AND state = 'included'
           ORDER BY created_at, withdrawal_id LIMIT $2`,
          [wallet.wallet_id, CATCH_UP_MAX],
        );
    if (!rows.length) return [];
    let port: OwnerOperationsPort;
    try {
      port = await deps.operations();
    } catch {
      return [];
    }
    if (!port.settledAtSafe) return [];
    const settled: Settled[] = [];
    for (const row of rows) {
      if (!row.tx_hash || row.block_number === null) continue;
      const memoKey = `${row.withdrawal_id}:${row.tx_hash}:${row.block_number}`;
      const known = memo.get(memoKey);
      const proven =
        known ??
        (await port.settledAtSafe({
          sender: getAddress(wallet.address),
          nonce: BigInt(row.nonce),
          userOpHash: row.user_op_hash as Hex,
          txHash: row.tx_hash as Hex,
          blockNumber: BigInt(row.block_number),
          success: row.error_code !== 'reverted',
        })) === true;
      memo.set(memoKey, proven);
      if (proven)
        settled.push({
          withdrawalId: row.withdrawal_id,
          txHash: row.tx_hash,
          blockNumber: String(row.block_number),
        });
    }
    return settled;
  }

  /**
   * What the holds of included operations proven settled at the safe head (for their exact
   * receipt) add up to on `token`, for a balance read at `readBlock` at or after their blocks: that
   * read already shows their debit, so their holds (still held until final) must not count twice.
   * Unproven ones, and any in a block after the read, keep counting.
   */
  async function settledHeld(
    tx: Pick<Transaction, 'query'>,
    walletId: string,
    token: Address,
    readBlock: bigint,
    settled: readonly Settled[],
  ): Promise<bigint> {
    if (!settled.length) return 0n;
    const { rows } = await tx.query<{ total: string | null }>(
      `SELECT sum(r.amount)::text AS total
       FROM base_wallet_withdrawals w
       JOIN base_wallet_reservations r
         ON r.reservation_id = w.reservation_id OR r.reservation_id = w.fee_reservation_id
       WHERE w.wallet_id = $1 AND w.state = 'included' AND r.state = 'held'
         AND lower(r.token) = lower($2) AND w.block_number <= $3::bigint
         AND EXISTS (
           SELECT 1 FROM unnest($4::text[], $5::text[], $6::bigint[]) AS s(id, tx, block)
           WHERE s.id = w.withdrawal_id AND s.tx = w.tx_hash AND s.block = w.block_number)`,
      [
        walletId,
        token,
        readBlock.toString(10),
        settled.map((one) => one.withdrawalId),
        settled.map((one) => one.txHash),
        settled.map((one) => one.blockNumber),
      ],
    );
    return BigInt(rows[0]?.total ?? '0');
  }

  /** Held on `token` for this read, less what the read already shows spent (settledHeld). */
  async function heldFor(
    tx: Pick<Transaction, 'query'>,
    walletId: string,
    token: Address,
    readBlock: bigint,
    settled: readonly Settled[],
  ): Promise<bigint> {
    const held = await unavailableAmount(tx, { walletId, token, blockNumber: readBlock });
    const spent = await settledHeld(tx, walletId, token, readBlock, settled);
    return held > spent ? held - spent : 0n;
  }

  /**
   * Brings the wallet's signed, unfinished operations up to date before an admission decision
   * (the least recently checked first, at most CATCH_UP_MAX, so every one gets its turn however
   * many old ones are stuck), so one that is final by now releases or consumes its holds and stops
   * counting. One that can't be brought up to date stays as it is: it keeps blocking and holding
   * (fail closed).
   */
  async function catchUp(wallet: WalletRow, states: readonly WithdrawalState[]) {
    const { rows } = await db.query<Row>(
      `SELECT ${COLUMNS} FROM base_wallet_withdrawals
       WHERE wallet_id = $1 AND state = ANY($2::text[])
       ORDER BY checked_at ASC NULLS FIRST, created_at, withdrawal_id LIMIT $3`,
      [wallet.wallet_id, [...states], CATCH_UP_MAX],
    );
    if (!rows.length) return;
    // Marked first: one that fails to read still goes to the back of the line.
    await db.query(
      'UPDATE base_wallet_withdrawals SET checked_at = $2 WHERE withdrawal_id = ANY($1::text[])',
      [rows.map((row) => row.withdrawal_id), now()],
    );
    for (const row of rows)
      try {
        await advance(wallet, row);
      } catch {
        // Left as stored: it still counts.
      }
  }

  /**
   * An unsponsored cancel prefunds its gas from the wallet's ETH. The no-op and the withdrawal share
   * one nonce, so at most one of them is ever charged: the ETH this withdrawal itself holds counts
   * as free for its cancel; everything else held on the wallet does not.
   */
  async function checkCancelFunded(
    wallet: WalletRow,
    row: Row,
    fee: bigint,
  ): Promise<{ eth: bigint; blockNumber: bigint; own: bigint }> {
    if (!deps.balances)
      throw new WithdrawalError('chain_unavailable', 'Base cannot be read right now.');
    let read;
    try {
      read = await deps.balances.balances(getAddress(wallet.address));
    } catch {
      throw new WithdrawalError('chain_unavailable', 'Base cannot be read right now.');
    }
    const held = await unavailableAmount(db, {
      walletId: wallet.wallet_id,
      token: NATIVE_ETH,
      blockNumber: read.blockNumber,
    });
    const own = (row.token === 'ETH' ? BigInt(row.amount_raw!) : 0n) + BigInt(row.max_fee_wei);
    const others = held > own ? held - own : 0n;
    const free = read.eth > others ? read.eth - others : 0n;
    if (fee > free) throw unfunded(fee, fee, free);
    return { eth: read.eth, blockNumber: read.blockNumber, own };
  }

  /**
   * Right before a laned operation is signed: Base read again. Balance minus everything else held
   * must still cover what this operation holds (its amount, and its gas when owner-funded), or it
   * would only revert at the sponsor's cost (the owner spent outside the app meanwhile). Refused
   * with 409 funds_moved: nothing is signed or sent, and its hold stays until it expires or is
   * cancelled.
   */
  async function checkStillFunded(wallet: WalletRow, row: Row) {
    // A rating moves no money and holds nothing.
    if (row.kind === 'rate' || row.amount_raw === null) return;
    if (!deps.balances)
      throw new WithdrawalError('chain_unavailable', 'Base cannot be read right now.');
    let read;
    try {
      read = await deps.balances.balances(getAddress(wallet.address));
    } catch {
      throw new WithdrawalError('chain_unavailable', 'Base cannot be read right now.');
    }
    const settled = await settledIncluded(wallet);
    const amount = BigInt(row.amount_raw);
    const fee = BigInt(row.max_fee_wei);
    const own: Array<[WithdrawalToken, bigint]> =
      row.token === 'ETH'
        ? [['ETH', amount + fee]]
        : [
            ['USDC', amount],
            ['ETH', fee],
          ];
    for (const [token, mine] of own) {
      if (mine === 0n) continue;
      const held = await heldFor(
        db,
        wallet.wallet_id,
        tokenAddress(token),
        read.blockNumber,
        settled,
      );
      const others = held > mine ? held - mine : 0n;
      const balance = token === 'USDC' ? read.usdc : read.eth;
      const free = balance > others ? balance - others : 0n;
      if (free < mine)
        throw new WithdrawalError(
          'funds_moved',
          'The wallet no longer holds enough for this operation; nothing was sent.',
          {
            token,
            available: amountJson(token, free),
            needed: amountJson(token, mine),
            details: {
              token,
              available: amountJson(token, free),
              needed: amountJson(token, mine),
            },
          },
        );
    }
  }

  /**
   * The wallet's sponsored operations that reverted on Base in the last 24 hours (from when Base
   * first showed each reverted, stored once): at the budget, new laned payments pause (409
   * sponsor_paused) until the oldest of those leaves the window. The owner's own withdrawals never
   * pause; they are checked against the balance at sign instead (checkStillFunded).
   */
  async function checkRevertBudget(tx: Pick<Transaction, 'query'>, walletId: string) {
    const budget = deps.revertBudget?.() ?? LANES_REVERT_BUDGET_DEFAULT;
    const { rows } = await tx.query<{ reverted_at: string | number }>(
      `SELECT reverted_at FROM base_wallet_withdrawals
       WHERE wallet_id = $1 AND sponsored AND error_code = 'reverted'
         AND state IN ('included','failed') AND reverted_at > $2
       ORDER BY reverted_at DESC LIMIT $3`,
      [walletId, now() - REVERT_WINDOW_MS, budget],
    );
    if (rows.length >= budget) {
      const retryAt = Number(rows[budget - 1].reverted_at) + REVERT_WINDOW_MS;
      throw new WithdrawalError(
        'sponsor_paused',
        'Several operations from this wallet failed on Base; new ones pause for a while.',
        { reverted: rows.length, retryAt, details: { reverted: rows.length, retryAt } },
      );
    }
  }

  const pending = (withdrawalId: string) =>
    new WithdrawalError(
      'operation_pending',
      'This wallet already has a withdrawal in progress; finish or cancel it first.',
      { withdrawalId },
    );

  /** The wallet's unfinished owner operations, laned or not (unsigned ones past their time aside). */
  async function openCount(tx: Pick<Transaction, 'query'>, walletId: string): Promise<number> {
    const { rows } = await tx.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM base_wallet_withdrawals
       WHERE wallet_id = $1 AND state = ANY($2::text[])
         AND NOT (state = 'awaiting_signature' AND expires_at <= $3)`,
      [walletId, [...WITHDRAWAL_OPEN_STATES], now()],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * An unfinished owner operation of the wallet that deploys it and is not final (awaiting its
   * signature, sent, in a block, being cancelled), or a spending-limit revoke that deploys it and
   * is still live: while there is one, no second deploying operation starts.
   */
  async function deployingOn(
    tx: Pick<Transaction, 'query'>,
    walletId: string,
  ): Promise<{ withdrawalId: string } | { permissionId: string } | null> {
    const { rows } = await tx.query<{ withdrawal_id: string }>(
      `SELECT withdrawal_id FROM base_wallet_withdrawals
       WHERE wallet_id = $1 AND state = ANY($3::text[])
         AND NOT (state = 'awaiting_signature' AND expires_at <= $2)
         AND coalesce(user_operation->>'initCode', '0x') <> '0x'
       ORDER BY created_at LIMIT 1`,
      [walletId, now(), [...WITHDRAWAL_OPEN_STATES]],
    );
    if (rows[0]) return { withdrawalId: rows[0].withdrawal_id };
    const revokes = await tx.query<{ permission_id: string }>(
      `SELECT permission_id FROM base_spend_permissions
       WHERE wallet_id = $1 AND state = 'revoke_pending'
         AND coalesce(revoke_operation->>'initCode', '0x') <> '0x'
         AND (revoke_signature IS NOT NULL OR revoke_expires_at > $2)
       LIMIT 1`,
      [walletId, now()],
    );
    return revokes.rows[0] ? { permissionId: revokes.rows[0].permission_id } : null;
  }

  /** Whether an operation of this wallet already has this lane (any state: lanes are never reused). */
  async function laneTaken(
    tx: Pick<Transaction, 'query'>,
    walletId: string,
    lane: bigint,
  ): Promise<boolean> {
    const { rows } = await tx.query(
      `SELECT 1 FROM base_wallet_withdrawals
       WHERE chain_id = $1 AND wallet_id = $2 AND lane_key = $3::numeric`,
      [WITHDRAWAL_CHAIN_ID, walletId, lane.toString(10)],
    );
    return rows.length > 0;
  }

  const tooManyOpen = (max: number, open: number) =>
    new WithdrawalError('too_many_open', `Wait a moment: ${max} payments are still on their way.`, {
      max,
      open,
      details: { max, open },
    });

  const fundsHeld = (token: WithdrawalToken, available: bigint, open: number) =>
    new WithdrawalError(
      'funds_held',
      `Not enough ${token} while ${open} ${open === 1 ? 'payment is' : 'payments are'} still on ${open === 1 ? 'its' : 'their'} way.`,
      {
        open,
        available: amountJson(token, available),
        details: { open, available: amountJson(token, available) },
      },
    );

  /** The operation's lane is already used (here or on Base): refused, never reused. */
  const laneCollision = () =>
    new WithdrawalError(
      'lane_collision',
      'This operation’s lane is already in use; nothing was prepared. Try again.',
    );

  return {
    /** `payment` only from the pay service (a payment to a re-verified recipient), never a request. */
    async create(
      accountId: string,
      agentId: string,
      input: unknown,
      payment?: PaymentHooks,
    ): Promise<WithdrawalSigningRequest> {
      const wallet = await walletOf(accountId, agentId);
      const body = parseCreate(input);
      if (payment && (body.token !== 'USDC' || body.amount === 'max'))
        throw new WithdrawalError('invalid_body', 'A payment is an exact amount of USDC.');
      const hash = requestHash(agentId, body, payment);
      const existing = await byKey(accountId, body.idempotencyKey);
      if (existing) return replay(wallet, existing, hash);

      // The owner key must be backed up before any money moves (contract decision 3, v1.2).
      if (
        wallet.backup_confirmed_at === null ||
        wallet.vault_owner === null ||
        wallet.vault_owner.toLowerCase() !== wallet.owner_address.toLowerCase()
      )
        throw new WithdrawalError('backup_required', 'Confirm your backup key first.');
      if (
        REFUSED_DESTINATIONS.has(body.to.toLowerCase()) ||
        walletRecipientRefusal(
          { address: wallet.address, spenderAddress: wallet.spender_address },
          body.to,
        )
      )
        throw new WithdrawalError(
          'destination_not_allowed',
          'Funds sent to that address would be lost or come straight back.',
        );
      // Pay without waiting, decided once per request (CITY_BASE_LANES).
      const laned = deps.lanes?.() === true;
      const cap = laned ? (deps.openCap?.() ?? LANES_CAP_DEFAULT) : 0;
      const withdrawalId = (deps.newId ?? randomUUID)().toLowerCase();
      await db.transaction((tx) => expireStale(tx, wallet));
      // Signed ones that are final by now release or consume their holds first (and with lanes
      // stop counting towards the cap).
      await catchUp(wallet, SIGNED_OPEN);
      // Proven once for this request, each for the receipt it carries now (openOn and the holds
      // below match it).
      const settled = await settledIncluded(wallet);
      /** The operation's own lane with lanes on (refused, never reused, when taken). */
      let lane: bigint | null = null;
      if (laned) {
        if (payment) await checkRevertBudget(db, wallet.wallet_id);
        const open = await openCount(db, wallet.wallet_id);
        if (open >= cap) throw tooManyOpen(cap, open);
        try {
          lane = laneKey(withdrawalId);
        } catch (error) {
          if (error instanceof LaneKeyError) throw laneCollision();
          throw error;
        }
        if (await laneTaken(db, wallet.wallet_id, lane)) throw laneCollision();
      } else {
        const open = await openOn(db, wallet.wallet_id, settled);
        if (open) throw pending(open);
      }

      const port = await operations();
      if (!deps.balances)
        throw new WithdrawalError('chain_unavailable', 'Base cannot be read right now.');
      let read;
      try {
        read = await deps.balances.balances(getAddress(wallet.address));
      } catch {
        throw new WithdrawalError('chain_unavailable', 'Base cannot be read right now.');
      }
      const token = tokenAddress(body.token);
      const balance = body.token === 'USDC' ? read.usdc : read.eth;
      const held = await heldFor(db, wallet.wallet_id, token, read.blockNumber, settled);
      const available = balance > held ? balance - held : 0n;
      let amount = body.amount === 'max' ? available : body.amount;
      // With lanes on, what is held for operations still on their way is named as the reason.
      if (laned && held > 0n && amount <= balance && (amount <= 0n || amount > available))
        throw fundsHeld(body.token, available, await openCount(db, wallet.wallet_id));
      if (amount <= 0n || amount > available)
        throw new WithdrawalError(
          'insufficient_balance',
          'The wallet does not hold that much right now.',
          { available: amountJson(body.token, available) },
        );
      // The ETH free for gas, if no paymaster sponsors the operation.
      const ethHeld =
        body.token === 'ETH'
          ? held
          : await heldFor(db, wallet.wallet_id, NATIVE_ETH, read.blockNumber, settled);
      const ethFree = read.eth > ethHeld ? read.eth - ethHeld : 0n;

      const walletAddress = getAddress(wallet.address);
      const signingDeadline = now() + WITHDRAWAL_SIGNATURE_TTL_MS;
      const prepareFor = async (value: bigint, ownerFunded?: true) => {
        const input = {
          wallet: walletAddress,
          recipe: recipeOf(wallet),
          calls: [withdrawalCall(body.token, body.to, value)],
          // Its own lane, first sequence: a lane Base has seen used is refused (NONCE_MOVED).
          ...(lane === null
            ? {}
            : { nonceKey: lane, pinnedNonce: lane << 64n, sponsorshipDeadline: signingDeadline }),
        };
        try {
          // A payment: sponsored or nothing, whatever the fallback setting says.
          if (payment) return await port.prepare(input);
          // Re-preparing an owner-funded 'max' stays owner-funded (only reached with the fallback on).
          return ownerFunded
            ? await port.prepare({ ...input, ownerFunded })
            : await prepareOwnerOperation(port, input);
        } catch (error) {
          if (lane !== null && error instanceof OwnerOperationError && error.code === 'NONCE_MOVED')
            throw laneCollision();
          return operationError(error);
        }
      };
      // The recipient of a payment, checked again on Base right before anything is prepared.
      if (payment) await payment.beforePrepare();
      let prepared: PreparedOwnerOperation = await prepareFor(amount);
      if (payment && !prepared.sponsored)
        throw new WithdrawalError(
          'sponsorship_unavailable',
          'The network fee cannot be covered right now; nothing was prepared. Try again later.',
        );
      if (!prepared.sponsored) {
        // Not sponsored: the wallet prefunds its own gas, so it must hold it on top of the amount.
        // Never a partial withdrawal: a fixed amount that leaves too little ETH is refused.
        if (body.token === 'USDC') {
          if (prepared.maxCostWei > ethFree)
            throw unfunded(prepared.maxCostWei, prepared.maxCostWei, ethFree);
        } else if (body.amount !== 'max') {
          if (amount + prepared.maxCostWei > available)
            throw unfunded(prepared.maxCostWei, amount + prepared.maxCostWei, available);
        } else {
          // 'max' ETH is what is left after the gas; the gas does not depend on the value sent.
          for (let tries = 0; amount + prepared.maxCostWei > available; tries++) {
            if (tries === 3 || available <= prepared.maxCostWei)
              throw unfunded(prepared.maxCostWei, prepared.maxCostWei + 1n, available);
            amount = available - prepared.maxCostWei;
            prepared = await prepareFor(amount, true);
          }
        }
      }
      // What the owner will sign must decode to exactly this withdrawal.
      const decoded = decodeOwnerCall(prepared.operation.callData, walletAddress);
      if (
        decoded?.kind !== 'withdraw' ||
        decoded.token !== body.token ||
        decoded.to !== body.to ||
        decoded.amount !== amount
      )
        throw new Error('The prepared operation is not the withdrawal asked for.');
      // With lanes, exactly the nonce the browser derives from the id: key << 64 | 0.
      if (lane !== null && prepared.operation.nonce !== lane << 64n)
        throw new Error('The prepared operation is not in its own lane.');
      const deploys = (prepared.operation.initCode ?? '0x') !== '0x';
      const toIsContract = await port.isContract(body.to);

      const at = now();
      const userOpHash = prepared.userOpHash.toLowerCase();
      /** What the wallet itself may be charged for gas: nothing when sponsored. */
      const fee = prepared.sponsored ? 0n : prepared.maxCostWei;
      const intent = intentHash('withdraw', withdrawalId, walletAddress, userOpHash);
      let row: Row;
      try {
        row = await db.transaction(async (tx) => {
          // Concurrent creates for this wallet line up here; unsigned withdrawals past their time
          // stop holding funds before the new hold is counted.
          await exposureLock(tx);
          await tx.query('SELECT 1 FROM base_wallets WHERE wallet_id = $1 FOR UPDATE', [
            wallet.wallet_id,
          ]);
          await expireStale(tx, wallet);
          if (laned) {
            if (payment) await checkRevertBudget(tx, wallet.wallet_id);
            // Counted under the lock, legacy (unlanded) operations included.
            const open = await openCount(tx, wallet.wallet_id);
            if (open >= cap) throw tooManyOpen(cap, open);
            // One deploying operation at a time: the others wait until the wallet exists.
            if (deploys) {
              const deploying = await deployingOn(tx, wallet.wallet_id);
              if (deploying)
                throw 'withdrawalId' in deploying
                  ? pending(deploying.withdrawalId)
                  : new WithdrawalError(
                      'operation_pending',
                      'This wallet is being set up on Base; try again in a moment.',
                      deploying,
                    );
            }
          }
          // The read made above, for both tokens: one block for everything held here.
          const holds = createReservationLedger({
            chainId: WITHDRAWAL_CHAIN_ID,
            // What this read already shows spent by operations settled at the safe head is added
            // back, as their holds still count in the ledger's own sum (settledHeld).
            balanceOf: async (_address, held) => ({
              balance:
                (held.toLowerCase() === NATIVE_ETH.toLowerCase() ? read.eth : read.usdc) +
                (await settledHeld(tx, wallet.wallet_id, held, read.blockNumber, settled)),
              blockNumber: read.blockNumber,
            }),
            now,
          });
          const hold = (heldToken: Address, value: bigint) =>
            holds.reserve(tx, {
              walletId: wallet.wallet_id,
              chainId: WITHDRAWAL_CHAIN_ID,
              token: heldToken,
              amount: value,
              holder: { kind: 'withdrawal', ref: withdrawalId },
              intentHash: intent,
            });
          // Unsponsored, the gas is held too: with the amount for ETH, on its own for USDC.
          const reservation = await hold(token, body.token === 'ETH' ? amount + fee : amount);
          let feeReservation = null;
          if (body.token === 'USDC' && fee > 0n)
            try {
              feeReservation = await hold(NATIVE_ETH, fee);
            } catch (error) {
              if (error instanceof ReservationError && error.code === 'INSUFFICIENT_BALANCE')
                throw unfunded(fee, fee, 0n);
              throw error;
            }
          // The sponsor's exposure in flight, lanes on or off (only when it pays the gas): its own
          // cost and its cancel's headroom, both under the caps.
          if (prepared.sponsored)
            await reserveWithHeadroom(tx, {
              walletId: wallet.wallet_id,
              withdrawalId,
              operation: prepared.operation,
              cost: prepared.maxCostWei,
            });
          if (!laned) {
            const openNow = await openOn(tx, wallet.wallet_id, settled);
            if (openNow) throw pending(openNow);
          }
          const { rows } = await tx.query<Row>(
            `INSERT INTO base_wallet_withdrawals (withdrawal_id, wallet_id, owner_account_id,
               chain_id, token, amount_raw, destination, idempotency_key, request_hash, state,
               nonce, user_operation, user_op_hash, expires_at, reservation_id, created_at,
               updated_at, sponsored, max_fee_wei, fee_reservation_id, lane_key)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_signature',$10,$11,$12,$13,$14,$15,$15,
               $16,$17,$18,$19::numeric)
             RETURNING ${COLUMNS}`,
            [
              withdrawalId,
              wallet.wallet_id,
              accountId,
              WITHDRAWAL_CHAIN_ID,
              body.token,
              amount.toString(10),
              body.to,
              body.idempotencyKey,
              hash,
              prepared.operation.nonce.toString(10),
              JSON.stringify(userOperationToRpc(prepared.operation)),
              userOpHash,
              signableUntil(signingDeadline, lane !== null, prepared.sponsored, prepared.operation),
              reservation.reservationId,
              at,
              prepared.sponsored,
              fee.toString(10),
              feeReservation?.reservationId ?? null,
              lane === null ? null : lane.toString(10),
            ],
          );
          await audit(tx, wallet, rows[0], 'withdrawal_created', {
            token: body.token,
            amount: amount.toString(10),
            to: body.to,
            userOpHash,
            ...(lane === null ? {} : { laneKey: lane.toString(10) }),
            deploysWallet: !prepared.deployed,
            sponsored: prepared.sponsored,
            maxFeeWei: fee.toString(10),
            ...(payment ? { purpose: 'pay' } : {}),
          });
          if (payment) await payment.stored(tx, withdrawalId);
          return rows[0];
        });
      } catch (error) {
        // A parallel request with the same key got there first: its withdrawal is the answer.
        const raced = await byKey(accountId, body.idempotencyKey);
        if (raced) return replay(wallet, raced, hash);
        if (error instanceof ReservationError && error.code === 'INSUFFICIENT_BALANCE') {
          // Another create took what was left meanwhile (with lanes: still on its way).
          if (laned) {
            const left = await unavailableAmount(db, {
              walletId: wallet.wallet_id,
              token,
              blockNumber: read.blockNumber,
            });
            throw fundsHeld(
              body.token,
              balance > left ? balance - left : 0n,
              await openCount(db, wallet.wallet_id),
            );
          }
          throw new WithdrawalError(
            'insufficient_balance',
            'The wallet does not hold that much right now.',
          );
        }
        if (error instanceof WithdrawalError) throw error;
        if ((error as { code?: string }).code === '23505') {
          if (lane !== null && (await laneTaken(db, wallet.wallet_id, lane))) throw laneCollision();
          const other = await openOn(db, wallet.wallet_id, settled);
          if (other) throw pending(other);
        }
        throw error;
      }
      return signingRequest(wallet, row, toIsContract);
    },

    /**
     * A rating from the agent's wallet (rate/service.ts only): one giveFeedback call to the pinned
     * Reputation Registry, sponsored at no charge or nothing (never the owner-funded fallback), no
     * balance read and no hold. The same key and request again answers the same rating as it is
     * now, without any check; another one is refused.
     */
    async rate(
      accountId: string,
      agentId: string,
      hooks: RatingHooks,
    ): Promise<RatingSigningRequest> {
      const wallet = await walletOf(accountId, agentId);
      const hash = ratingRequestHash(agentId, hooks.request);
      const existing = await byKey(accountId, hooks.idempotencyKey);
      if (existing) return replayRating(wallet, existing, hash);
      if (
        wallet.backup_confirmed_at === null ||
        wallet.vault_owner === null ||
        wallet.vault_owner.toLowerCase() !== wallet.owner_address.toLowerCase()
      )
        throw new WithdrawalError('backup_required', 'Confirm your backup key first.');
      // Pay without waiting, decided once per request (CITY_BASE_LANES), as for a withdrawal.
      const laned = deps.lanes?.() === true;
      const cap = laned ? (deps.openCap?.() ?? LANES_CAP_DEFAULT) : 0;
      const withdrawalId = laned ? (deps.newId ?? randomUUID)().toLowerCase() : randomUUID();
      await db.transaction((tx) => expireStale(tx, wallet));
      /** With lanes on, the rating's own lane (refused, never reused, when taken). */
      let lane: bigint | null = null;
      /** Lanes off: included ones Base proves settled at its safe head (they no longer block). */
      let settled: Awaited<ReturnType<typeof settledIncluded>> = [];
      if (laned) {
        // Gate 2 with lanes, as for a payment: final ones stop counting first; then the sponsor's
        // revert budget, the open cap (laned or not, ratings included) and a lane of its own. No
        // balance read and no hold: a rating moves no money.
        await catchUp(wallet, SIGNED_OPEN);
        await checkRevertBudget(db, wallet.wallet_id);
        const open = await openCount(db, wallet.wallet_id);
        if (open >= cap) throw tooManyOpen(cap, open);
        try {
          lane = laneKey(withdrawalId);
        } catch (error) {
          if (error instanceof LaneKeyError) throw laneCollision();
          throw error;
        }
        if (await laneTaken(db, wallet.wallet_id, lane)) throw laneCollision();
      } else {
        // Gate 2, as for a withdrawal: it waits while another operation of the wallet is open.
        // One in a block that Base proves settled at its safe head no longer blocks.
        settled = await settledIncluded(wallet);
        const open = await openOn(db, wallet.wallet_id, settled);
        if (open) throw pending(open);
      }
      const port = await operations();
      // Both agents checked again on Base right before anything is prepared.
      const target = await hooks.beforePrepare();
      const walletAddress = getAddress(wallet.address);
      // Fixed once per create, as for a withdrawal: with lanes, the paymaster's sponsorship must
      // stay valid until then, and the rating can be signed only until then (its expires_at).
      const signingDeadline = now() + WITHDRAWAL_SIGNATURE_TTL_MS;
      let prepared: PreparedOwnerOperation;
      try {
        // Sponsored by a pinned paymaster at no charge, or nothing.
        prepared = await port.prepare({
          wallet: walletAddress,
          recipe: recipeOf(wallet),
          calls: [rateCall(target.baseId, target.stars)],
          // Its own lane, first sequence: a lane Base has seen used is refused (NONCE_MOVED).
          ...(lane === null
            ? {}
            : { nonceKey: lane, pinnedNonce: lane << 64n, sponsorshipDeadline: signingDeadline }),
        });
      } catch (error) {
        if (lane !== null && error instanceof OwnerOperationError && error.code === 'NONCE_MOVED')
          throw laneCollision();
        return operationError(error);
      }
      if (!prepared.sponsored)
        throw new WithdrawalError(
          'sponsorship_unavailable',
          'The network fee cannot be covered right now; nothing was prepared. Try again later.',
        );
      // What the owner will sign must decode to exactly this rating, and never to a transfer.
      const decoded = decodeRateCall(prepared.operation.callData, walletAddress);
      if (
        decodeOwnerCall(prepared.operation.callData, walletAddress) !== null ||
        decoded?.agentId !== target.baseId ||
        decoded.stars !== target.stars
      )
        throw new Error('The prepared operation is not the rating asked for.');
      // With lanes, exactly the nonce the browser derives from the id: key << 64 | 0.
      if (lane !== null && prepared.operation.nonce !== lane << 64n)
        throw new Error('The prepared operation is not in its own lane.');
      const deploys = (prepared.operation.initCode ?? '0x') !== '0x';

      const at = now();
      const userOpHash = prepared.userOpHash.toLowerCase();
      let row: Row;
      try {
        row = await db.transaction(async (tx) => {
          await exposureLock(tx);
          await tx.query('SELECT 1 FROM base_wallets WHERE wallet_id = $1 FOR UPDATE', [
            wallet.wallet_id,
          ]);
          await expireStale(tx, wallet);
          if (laned) {
            await checkRevertBudget(tx, wallet.wallet_id);
            // Counted under the lock, legacy (unlaned) operations and other ratings included.
            const open = await openCount(tx, wallet.wallet_id);
            if (open >= cap) throw tooManyOpen(cap, open);
            // One deploying operation at a time: the others wait until the wallet exists.
            if (deploys) {
              const deploying = await deployingOn(tx, wallet.wallet_id);
              if (deploying)
                throw 'withdrawalId' in deploying
                  ? pending(deploying.withdrawalId)
                  : new WithdrawalError(
                      'operation_pending',
                      'This wallet is being set up on Base; try again in a moment.',
                      deploying,
                    );
            }
          } else {
            const openNow = await openOn(tx, wallet.wallet_id, settled);
            if (openNow) throw pending(openNow);
          }
          // A rating is always sponsored: its own cost and its cancel's headroom, like any other
          // (a signed rating can be cancelled with a sponsored no-op at its nonce), lanes on or off.
          await reserveWithHeadroom(tx, {
            walletId: wallet.wallet_id,
            withdrawalId,
            operation: prepared.operation,
            cost: prepared.maxCostWei,
          });
          const { rows } = await tx.query<Row>(
            `INSERT INTO base_wallet_withdrawals (withdrawal_id, wallet_id, owner_account_id,
               chain_id, kind, rated_agent_id, rated_base_id, rating_value, idempotency_key,
               request_hash, state, nonce, user_operation, user_op_hash, expires_at, created_at,
               updated_at, sponsored, max_fee_wei, lane_key)
             VALUES ($1,$2,$3,$4,'rate',$5,$6,$7,$8,$9,'awaiting_signature',$10,$11,$12,$13,$14,
               $14,true,0,$15::numeric)
             RETURNING ${COLUMNS}`,
            [
              withdrawalId,
              wallet.wallet_id,
              accountId,
              WITHDRAWAL_CHAIN_ID,
              target.agentId,
              target.baseId.toString(10),
              Number(starsValue(target.stars)),
              hooks.idempotencyKey,
              hash,
              prepared.operation.nonce.toString(10),
              JSON.stringify(userOperationToRpc(prepared.operation)),
              userOpHash,
              signableUntil(signingDeadline, lane !== null, true, prepared.operation),
              at,
              lane === null ? null : lane.toString(10),
            ],
          );
          await audit(tx, wallet, rows[0], 'withdrawal_created', {
            registry: RATE_REGISTRY,
            ratedAgentId: target.agentId,
            ratedBaseId: target.baseId.toString(10),
            value: Number(starsValue(target.stars)),
            stars: target.stars,
            userOpHash,
            ...(lane === null ? {} : { laneKey: lane.toString(10) }),
            deploysWallet: !prepared.deployed,
            sponsored: true,
          });
          await hooks.stored(tx, withdrawalId);
          return rows[0];
        });
      } catch (error) {
        // A parallel request with the same key got there first: its rating is the answer.
        const raced = await byKey(accountId, hooks.idempotencyKey);
        if (raced) return replayRating(wallet, raced, hash);
        if (error instanceof WithdrawalError) throw error;
        if ((error as { code?: string }).code === '23505') {
          if (lane !== null && (await laneTaken(db, wallet.wallet_id, lane))) throw laneCollision();
          if (!laned) {
            const other = await openOn(db, wallet.wallet_id, settled);
            if (other) throw pending(other);
          }
        }
        throw error;
      }
      return ratingSigningRequest(wallet, row);
    },

    /**
     * The scheduled sweep (WALLET_SWEEP_PATH): unsigned operations of any wallet past their time
     * are expired, and signed unfinished ones are brought up to date from Base, least recently
     * checked first, so a final or failed operation nobody reads still releases its holds and the
     * sponsor's exposure. Bounded per run; never signs or sends anything new.
     */
    async sweep(budgetMs = SWEEP_BUDGET_MS): Promise<{ expired: number; advanced: number }> {
      // Wall time, not the service clock: the budget bounds this run, whatever the clock says.
      const started = Date.now();
      const expired = await db.transaction((tx) => expireStaleEverywhere(tx, STALE_BATCH));
      const { rows } = await db.query<Row>(
        `SELECT ${COLUMNS} FROM base_wallet_withdrawals
         WHERE chain_id = $1 AND state = ANY($2::text[])
         ORDER BY checked_at ASC NULLS FIRST, created_at, withdrawal_id LIMIT $3`,
        [WITHDRAWAL_CHAIN_ID, [...SIGNED_OPEN], SWEEP_BATCH],
      );
      if (rows.length)
        await db.query(
          'UPDATE base_wallet_withdrawals SET checked_at = $2 WHERE withdrawal_id = ANY($1::text[])',
          [rows.map((row) => row.withdrawal_id), now()],
        );
      let advanced = 0;
      for (const row of rows) {
        // Past its budget: no new read starts; the rest waits for the next sweep.
        if (Date.now() - started >= budgetMs) break;
        const wallets = await db.query<WalletRow>(
          `SELECT ${WALLET_COLUMNS} WHERE w.wallet_id = $1`,
          [row.wallet_id],
        );
        if (!wallets.rows[0]) continue;
        try {
          const done = await advance(wallets.rows[0], row);
          if (done.state !== row.state) advanced++;
        } catch {
          // Left as stored: the next sweep tries again.
        }
      }
      return { expired, advanced };
    },

    async read(accountId: string, agentId: string, withdrawalId: string): Promise<WithdrawalView> {
      const wallet = await walletOf(accountId, agentId);
      const row = await advance(wallet, await load(wallet, withdrawalId));
      // Proven on Base for an included one: settled at the safe head, not final yet. A reverted one
      // (error_code) is settled too, so the next one may start, but it sent nothing: never shown as safe.
      return present(wallet, row);
    },

    /**
     * The wallet's unfinished operations (awaiting a signature and not expired, sent, in a block,
     * being cancelled), newest first, at most the cap (at least OPEN_LIST_MAX), each as GET :id answers it plus the
     * operation as prepared. The oldest signed ones are brought up to date first and the oldest
     * included ones proven at the safe head (CATCH_UP_MAX each): bounded reads per request; one
     * not proven reads safe false. Only the wallet's owner, as for GET :id.
     */
    async open(accountId: string, agentId: string): Promise<{ withdrawals: WithdrawalView[] }> {
      const wallet = await walletOf(accountId, agentId);
      await db.transaction((tx) => expireStale(tx, wallet));
      await catchUp(wallet, SIGNED_OPEN);
      const { rows } = await db.query<Row>(
        `SELECT ${COLUMNS} FROM base_wallet_withdrawals
         WHERE wallet_id = $1 AND state = ANY($2::text[])
           AND NOT (state = 'awaiting_signature' AND expires_at <= $3)
         ORDER BY created_at DESC, withdrawal_id DESC LIMIT $4`,
        [
          wallet.wallet_id,
          [...WITHDRAWAL_OPEN_STATES],
          now(),
          Math.max(OPEN_LIST_MAX, deps.openCap?.() ?? LANES_CAP_DEFAULT),
        ],
      );
      const settled = await settledIncluded(wallet);
      return {
        withdrawals: await Promise.all(
          rows.map(async (row) => ({
            ...(await view(
              wallet,
              row,
              row.state === 'included' && row.error_code === null && isSettled(settled, row),
            )),
            userOperation: row.user_operation,
          })),
        ),
      };
    },

    /**
     * Brings one withdrawal up to date from the chain, exactly as its owner's next read would, for a
     * caller inside the server that is not its owner (a payment's recipient, pay/service.ts). Never
     * signs or authorizes anything; answers only the state. Null when there is no such withdrawal.
     */
    async refresh(withdrawalId: string): Promise<WithdrawalState | null> {
      if (!UUID.test(withdrawalId)) return null;
      const { rows } = await db.query<Row>(
        `SELECT ${COLUMNS} FROM base_wallet_withdrawals WHERE withdrawal_id = $1`,
        [withdrawalId.toLowerCase()],
      );
      if (!rows[0]) return null;
      const wallets = await db.query<WalletRow>(`SELECT ${WALLET_COLUMNS} WHERE w.wallet_id = $1`, [
        rows[0].wallet_id,
      ]);
      if (!wallets.rows[0]) return null;
      return (await advance(wallets.rows[0], rows[0])).state;
    },

    /**
     * Records `safe_at` (migration 96) on those of these withdrawals that are `safe` exactly as GET
     * :id means it: included, not reverted, and proven settled at Base's safe head for their exact
     * receipt (settledIncluded, the owner's own proof). For a caller inside the server that is not
     * their owner (a payment's recipient, pay/service.ts). Only ones not yet recorded, the oldest
     * first, at most `limit` (never over CATCH_UP_MAX) proofs; written once and only while the row
     * still holds the receipt it was proven for. Never signs, sends or brings anything up to date;
     * anything Base can't tell right now is left unrecorded. Answers the ids recorded now.
     */
    async markSafe(withdrawalIds: readonly string[], limit: number): Promise<string[]> {
      const ids = [
        ...new Set(withdrawalIds.filter((id) => UUID.test(id)).map((id) => id.toLowerCase())),
      ];
      const max = Math.min(Math.max(Math.floor(limit), 0), CATCH_UP_MAX);
      if (!ids.length || !max) return [];
      const { rows } = await db.query<Row>(
        `SELECT ${COLUMNS} FROM base_wallet_withdrawals
         WHERE withdrawal_id = ANY($1::text[]) AND state = 'included' AND error_code IS NULL
           AND safe_at IS NULL AND tx_hash IS NOT NULL AND block_number IS NOT NULL
         ORDER BY created_at, withdrawal_id LIMIT $2`,
        [ids, max],
      );
      // Proven side by side, so one read waits at most one proof's time limit (owner-ops.ts).
      const recorded = await Promise.all(
        rows.map(async (row) => {
          const wallets = await db.query<WalletRow>(
            `SELECT ${WALLET_COLUMNS} WHERE w.wallet_id = $1`,
            [row.wallet_id],
          );
          if (!wallets.rows[0]) return null;
          const settled = await settledIncluded(wallets.rows[0], row).catch(() => []);
          if (!isSettled(settled, row)) return null;
          const written = await db.query(
            `UPDATE base_wallet_withdrawals SET safe_at = $4
             WHERE withdrawal_id = $1 AND state = 'included' AND error_code IS NULL
               AND safe_at IS NULL AND tx_hash = $2 AND block_number = $3::bigint
             RETURNING withdrawal_id`,
            [row.withdrawal_id, row.tx_hash, String(row.block_number), now()],
          );
          return written.rows.length ? row.withdrawal_id : null;
        }),
      ).catch((): Array<string | null> => []);
      return recorded.filter((id): id is string => id !== null);
    },

    async sign(
      accountId: string,
      agentId: string,
      withdrawalId: string,
      input: unknown,
    ): Promise<WithdrawalView> {
      const wallet = await walletOf(accountId, agentId);
      let row = await load(wallet, withdrawalId);
      // Ratings switched off: one prepared before is never signed (its cancel and read stay open).
      if (row.kind === 'rate' && deps.ratingsEnabled && !deps.ratingsEnabled())
        throw new WithdrawalError('not_found', 'Not found.');
      const signature = parseSignature(input);
      row = await settleExpiry(wallet, row);
      // Expired exists only while unsigned (gate 2); a signed withdrawal never gets here.
      if (row.state === 'expired')
        throw new WithdrawalError('expired', 'This withdrawal can no longer be signed.');
      // The raw userOpHash, as the wallet checks it: a prefixed (personal_sign) or other key's
      // signature recovers to someone else.
      const signer = await recoverRawSigner(row.user_op_hash as Hex, signature);
      if (signer === null || signer !== getAddress(wallet.owner_address))
        throw new WithdrawalError(
          'signature_mismatch',
          'This signature is not the wallet owner key over this withdrawal.',
        );
      if (row.state === 'awaiting_signature') {
        if (
          row.lane_key !== null &&
          row.sponsored !== false &&
          (await operations()).sponsorshipValid?.(
            row.user_operation.paymasterAndData,
            Number(row.expires_at),
          ) !== true
        )
          throw new WithdrawalError(
            'sponsorship_expired',
            'The sponsorship is no longer valid; nothing was sent. Prepare again.',
          );
        // Only for exactly the operation this row was prepared as: a withdrawal's transfer, a
        // rating's giveFeedback; never one in place of the other, never anything else.
        if (!operationMatches(getAddress(wallet.address), row))
          throw new WithdrawalError(
            'operation_mismatch',
            'This operation is not the one prepared; nothing was signed or sent.',
          );
        // With its own lane: never signed for a balance the owner spent elsewhere meanwhile, and a
        // payment or a rating (sponsored or nothing) not while the sponsor's revert budget for
        // this wallet is spent.
        if (row.lane_key !== null) {
          if (row.kind === 'rate' || (await deps.sponsoredOnly?.(row.withdrawal_id)) === true)
            await checkRevertBudget(db, wallet.wallet_id);
          // What has landed since is brought up to date first (settled debits count once).
          await catchUp(wallet, SIGNED_OPEN);
          await checkStillFunded(wallet, row);
        }
        const signed = await db.transaction(async (tx) => {
          await exposureLock(tx);
          const at = now();
          if (
            row.lane_key !== null &&
            row.sponsored !== false &&
            (await operations()).sponsorshipValid?.(
              row.user_operation.paymasterAndData,
              Number(row.expires_at),
            ) !== true
          )
            throw new WithdrawalError(
              'sponsorship_expired',
              'The sponsorship is no longer valid; nothing was sent. Prepare again.',
            );
          const { rows } = await tx.query<Row>(
            `UPDATE base_wallet_withdrawals SET state = 'submitted', owner_signature = $3,
               chain_op_key = $4, signed_at = $2, updated_at = $2
             WHERE withdrawal_id = $1 AND state = 'awaiting_signature' AND expires_at > $2
             RETURNING ${COLUMNS}`,
            [
              row.withdrawal_id,
              at,
              Buffer.from(signature.slice(2), 'hex'),
              `base-wallet:${row.kind === 'rate' ? 'rate' : 'withdraw'}:${row.withdrawal_id}`,
            ],
          );
          if (rows[0]) {
            // An operation from before the exposure ledger is counted now, or not signed.
            await ensureExposure(tx, rows[0], 'operation');
            await audit(tx, wallet, rows[0], 'withdrawal_signed', {
              userOpHash: rows[0].user_op_hash,
            });
          }
          return rows[0] ?? null;
        });
        row = signed ?? (await settleExpiry(wallet, await reload(row)));
        if (row.state === 'expired')
          throw new WithdrawalError('expired', 'This withdrawal can no longer be signed.');
      }
      // Signed (now or before): on its way through the durable path, and its current state.
      return present(wallet, await advance(wallet, row));
    },

    async cancel(
      accountId: string,
      agentId: string,
      withdrawalId: string,
    ): Promise<WithdrawalView> {
      const wallet = await walletOf(accountId, agentId);
      let row = await settleExpiry(wallet, await load(wallet, withdrawalId));
      // Never signed: nothing can be sent for it, so it is simply discarded.
      if (row.state === 'awaiting_signature') {
        row = await expire(wallet, row, 'discarded');
        if (row.state === 'expired') return present(wallet, row);
      }
      row = await advance(wallet, row);
      if (row.state === 'cancel_pending') return present(wallet, row);
      if (row.state !== 'submitted')
        throw new WithdrawalError(
          'not_cancellable',
          'Only a signed withdrawal that is not in a block yet can be cancelled.',
          { state: row.state },
        );
      const port = await operations();
      const walletAddress = getAddress(wallet.address);
      const original = userOperationFromRpc(row.user_operation);
      const cancelDeadline = now() + WITHDRAWAL_SIGNATURE_TTL_MS;
      // A payment's (or a rating's) cancel: sponsored or nothing, like the operation itself.
      // A rating's cancel too: it is never charged to the wallet.
      const sponsoredOnly =
        row.kind === 'rate' || (await deps.sponsoredOnly?.(row.withdrawal_id)) === true;
      let prepared: PreparedOwnerOperation;
      try {
        const input = {
          wallet: walletAddress,
          recipe: recipeOf(wallet),
          calls: [noopCall(walletAddress)],
          // Exactly the original's full nonce, in its lane: only one of the two can ever land.
          pinnedNonce: BigInt(row.nonce),
          ...laneInput(row),
          ...(row.lane_key === null ? {} : { sponsorshipDeadline: cancelDeadline }),
          // Bundlers replace an operation at the same nonce only for a fee raise of over 10%.
          feeFloor: {
            maxFeePerGas: outbid(original.maxFeePerGas),
            maxPriorityFeePerGas: outbid(original.maxPriorityFeePerGas),
          },
        };
        prepared = sponsoredOnly
          ? await port.prepare(input)
          : await prepareOwnerOperation(port, input);
      } catch (error) {
        // The nonce is used: the withdrawal (or something on its nonce) landed meanwhile.
        if (error instanceof OwnerOperationError && error.code === 'NONCE_MOVED') {
          const current = await advance(wallet, row);
          throw new WithdrawalError('not_cancellable', 'The withdrawal is already in a block.', {
            state: current.state,
          });
        }
        return operationError(error);
      }
      if (decodeOwnerCall(prepared.operation.callData, walletAddress)?.kind !== 'noop')
        throw new Error('The prepared cancel is not the wallet no-op.');
      if (sponsoredOnly && !prepared.sponsored)
        throw new WithdrawalError(
          'sponsorship_unavailable',
          'The network fee cannot be covered right now; nothing was prepared. Try again later.',
        );
      // A sponsored cancel spends only from the headroom its operation reserved: never beyond it.
      if (
        prepared.sponsored &&
        cancelExtra(row, prepared.maxCostWei) > (await headroomOf(db, row.withdrawal_id))
      ) {
        if (sponsoredOnly || deps.unsponsoredFallback?.() !== true)
          throw new WithdrawalError(
            'cancel_over_headroom',
            'This cancel would cost the network fee sponsor more than was set aside for it; ' +
              'nothing was prepared. Try again when fees are lower.',
          );
        try {
          prepared = await port.prepare({
            wallet: walletAddress,
            recipe: recipeOf(wallet),
            calls: [noopCall(walletAddress)],
            pinnedNonce: BigInt(row.nonce),
            ...laneInput(row),
            feeFloor: {
              maxFeePerGas: outbid(original.maxFeePerGas),
              maxPriorityFeePerGas: outbid(original.maxPriorityFeePerGas),
            },
            ownerFunded: true,
          });
        } catch (error) {
          return operationError(error);
        }
        if (decodeOwnerCall(prepared.operation.callData, walletAddress)?.kind !== 'noop')
          throw new Error('The prepared cancel is not the wallet no-op.');
      }
      const funded = prepared.sponsored
        ? null
        : await checkCancelFunded(wallet, row, prepared.maxCostWei);
      const at = now();
      const cancelHash = prepared.userOpHash.toLowerCase();
      const updated = await db.transaction(async (tx) => {
        await exposureLock(tx);
        const { rows } = await tx.query<Row>(
          `UPDATE base_wallet_withdrawals SET state = 'cancel_pending',
             cancel_user_operation = $3, cancel_user_op_hash = $4, cancel_expires_at = $5,
             cancel_state = 'awaiting_signature', cancel_sponsored = $6, cancel_max_fee_wei = $7,
             updated_at = $2
           WHERE withdrawal_id = $1 AND state = 'submitted' AND cancel_signature IS NULL
           RETURNING ${COLUMNS}`,
          [
            row.withdrawal_id,
            at,
            JSON.stringify(userOperationToRpc(prepared.operation)),
            cancelHash,
            signableUntil(
              cancelDeadline,
              row.lane_key !== null,
              prepared.sponsored,
              prepared.operation,
            ),
            prepared.sponsored,
            (prepared.sponsored ? 0n : prepared.maxCostWei).toString(10),
          ],
        );
        if (!rows[0]) return null;
        let asked = rows[0];
        // An earlier owner-funded cancel that lapsed unsigned no longer holds anything.
        if (row.cancel_fee_reservation_id) {
          const old = await tx.query<{ state: string }>(
            'SELECT state FROM base_wallet_reservations WHERE reservation_id = $1',
            [row.cancel_fee_reservation_id],
          );
          if (old.rows[0]?.state === 'held')
            await ledger.release(tx, row.cancel_fee_reservation_id);
        }
        // A sponsored cancel adds nothing: it was checked against its operation's headroom.
        await releaseExposure(tx, row.withdrawal_id, 'cancel');
        let feeReservation: string | null = null;
        if (funded) {
          // Its gas is held on the wallet's ETH like any other operation's, until the cancel ends.
          // The withdrawal's own ETH counts as free for it: only one of the two can be charged.
          const holds = createReservationLedger({
            chainId: WITHDRAWAL_CHAIN_ID,
            balanceOf: async () => ({
              balance: funded.eth + funded.own,
              blockNumber: funded.blockNumber,
            }),
            now,
          });
          try {
            feeReservation = (
              await holds.reserve(tx, {
                walletId: wallet.wallet_id,
                chainId: WITHDRAWAL_CHAIN_ID,
                token: NATIVE_ETH,
                amount: prepared.maxCostWei,
                holder: { kind: 'withdrawal', ref: `${row.withdrawal_id}:cancel:${randomUUID()}` },
                intentHash: intentHash(
                  'withdraw_cancel',
                  row.withdrawal_id,
                  walletAddress,
                  cancelHash,
                ),
              })
            ).reservationId;
          } catch (error) {
            if (error instanceof ReservationError && error.code === 'INSUFFICIENT_BALANCE')
              throw unfunded(prepared.maxCostWei, prepared.maxCostWei, 0n);
            throw error;
          }
        }
        if (feeReservation !== row.cancel_fee_reservation_id) {
          const again = await tx.query<Row>(
            `UPDATE base_wallet_withdrawals SET cancel_fee_reservation_id = $2
             WHERE withdrawal_id = $1 RETURNING ${COLUMNS}`,
            [row.withdrawal_id, feeReservation],
          );
          asked = again.rows[0];
        }
        await audit(tx, wallet, asked, 'withdrawal_cancel_requested', {
          cancelUserOpHash: cancelHash,
          sponsored: prepared.sponsored,
        });
        return asked;
      });
      if (updated) return present(wallet, updated);
      const current = await reload(row);
      if (current.state === 'cancel_pending') return present(wallet, current);
      throw new WithdrawalError(
        'not_cancellable',
        'Only a signed withdrawal that is not in a block yet can be cancelled.',
        { state: current.state },
      );
    },

    async signCancel(
      accountId: string,
      agentId: string,
      withdrawalId: string,
      input: unknown,
    ): Promise<WithdrawalView> {
      const wallet = await walletOf(accountId, agentId);
      let row = await load(wallet, withdrawalId);
      const signature = parseSignature(input);
      if (row.cancel_user_op_hash === null)
        throw new WithdrawalError('not_cancellable', 'No cancel was asked for.', {
          state: row.state,
        });
      const signer = await recoverRawSigner(row.cancel_user_op_hash as Hex, signature);
      if (signer === null || signer !== getAddress(wallet.owner_address))
        throw new WithdrawalError(
          'signature_mismatch',
          'This signature is not the wallet owner key over this cancel.',
        );
      if (row.cancel_signature === null) {
        const at = now();
        if (Number(row.cancel_expires_at) <= at) {
          await advance(wallet, row);
          throw new WithdrawalError('expired', 'This cancel can no longer be signed; ask again.');
        }
        if (row.state !== 'cancel_pending')
          throw new WithdrawalError('not_cancellable', 'The withdrawal is already in a block.', {
            state: row.state,
          });
        if (
          row.lane_key !== null &&
          row.cancel_sponsored !== false &&
          (await operations()).sponsorshipValid?.(
            row.cancel_user_operation?.paymasterAndData,
            Number(row.cancel_expires_at),
          ) !== true
        )
          throw new WithdrawalError(
            'sponsorship_expired',
            'The cancellation sponsorship is no longer valid; nothing was sent. Prepare again.',
          );
        const signed = await db.transaction(async (tx) => {
          await exposureLock(tx);
          const at = now();
          if (
            row.lane_key !== null &&
            row.cancel_sponsored !== false &&
            (await operations()).sponsorshipValid?.(
              row.cancel_user_operation?.paymasterAndData,
              Number(row.cancel_expires_at),
            ) !== true
          )
            throw new WithdrawalError(
              'sponsorship_expired',
              'The cancellation sponsorship is no longer valid; nothing was sent. Prepare again.',
            );
          const { rows } = await tx.query<Row>(
            `UPDATE base_wallet_withdrawals SET cancel_signature = $3, cancel_chain_op_key = $4,
               cancel_state = 'submitted', updated_at = $2
             WHERE withdrawal_id = $1 AND state = 'cancel_pending' AND cancel_signature IS NULL
               AND cancel_user_op_hash = $5 AND cancel_expires_at > $2
             RETURNING ${COLUMNS}`,
            [
              row.withdrawal_id,
              at,
              Buffer.from(signature.slice(2), 'hex'),
              `base-wallet:withdraw-cancel:${row.withdrawal_id}`,
              row.cancel_user_op_hash,
            ],
          );
          if (rows[0]) {
            // A cancel from before the exposure ledger is counted now, or not signed.
            await ensureExposure(tx, rows[0], 'cancel');
            await audit(tx, wallet, rows[0], 'withdrawal_cancel_signed', {
              cancelUserOpHash: rows[0].cancel_user_op_hash,
            });
          }
          return rows[0] ?? null;
        });
        row = signed ?? (await reload(row));
        if (row.cancel_signature === null)
          throw new WithdrawalError('expired', 'This cancel can no longer be signed; ask again.');
      }
      return present(wallet, await advance(wallet, row));
    },
  };
}

export type WithdrawalService = ReturnType<typeof createWithdrawalService>;
