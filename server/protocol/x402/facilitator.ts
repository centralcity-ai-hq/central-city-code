/*
 * Central City's own x402 facilitator for fee router 3 (docs/protocol/FEE_ROUTER_3.md): a server
 * EOA that sends router 3 `settle` transactions and pays their gas in ETH. Anyone may send a
 * settlement; only the buyer's two EIP-3009 signatures move money, so this module never decides
 * whether a payment may happen. The engine checks flags, limits and owners and passes
 * `beforeBroadcast`, run right before a settlement's first send.
 *
 * Durable sending, in the same spirit as the chain module's UserOperations (chain/submit.ts):
 *
 * 1. The idempotency key is looked up. The same key with a different intent hash is refused; an
 *    existing settlement is never rebuilt.
 * 2. A new settlement is stored (calldata + intent hash) BEFORE anything is simulated or sent.
 * 3. It is simulated (estimateGas). A revert ends it failed (SIMULATION_REVERTED, never sent) and
 *    takes no nonce, so the lane never gaps.
 * 4. The nonce is taken from the facilitator's lane row under its lock, and the transaction is
 *    signed inside the keystore and stored (raw transaction + hash) in that same database
 *    transaction. One address is one lane: no two settlements ever share a nonce.
 * 5. Only then is it broadcast. A failed send becomes 'unknown', never a fresh transaction.
 *
 * status() follows it on Base: a lost transaction is rebroadcast exactly as stored (never
 * re-signed with a new nonce); one stuck unmined for STUCK_MS is replaced with the same nonce and
 * calldata at +30% fees (stored first; a receipt for any hash it ever had counts). Final means at
 * or below the 'finalized' block, in the block the chain still has at that height.
 *
 * Logs carry keys, states and codes only: never addresses, raw transactions or endpoint URLs.
 */
import { randomUUID } from 'node:crypto';
import {
  decodeErrorResult,
  decodeFunctionData,
  encodeFunctionData,
  keccak256,
  parseAbi,
  serializeTransaction,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { Database, Transaction } from '../../database.js';
import type { Address } from '../../../shared/base/chains.js';
import type { FeedPayOp } from '../../base/chain/feed-pay-chain.js';
import type { NEVER_BROADCAST, StoredOperation } from '../../base/chain/submit.js';
import { transientChainError } from '../../base/chain/transient.js';

/** One router 3 settlement, as the buyer signed it (CentralCityFeeRouter3.Settlement). */
export interface Router3Settlement {
  payer: Hex;
  payee: Hex;
  gross: bigint;
  ref: Hex;
  validAfter: bigint;
  validBefore: bigint;
  sellerSignature: Hex;
  feeSignature: Hex;
}

/** Router 3's settle and its own errors (a copy kept here; the contract is the source). */
export const router3SettleAbi = parseAbi([
  'struct Settlement { address payer; address payee; uint256 gross; bytes32 ref; uint256 validAfter; uint256 validBefore; bytes sellerSignature; bytes feeSignature; }',
  'function settle(Settlement s) returns (uint256 fee)',
  'function settleBatch(Settlement[] batch)',
  'error ZeroAddress()',
  'error BadAmount()',
  'error AlreadyCharged()',
  'error RefMismatch()',
]);

/** The settle calldata for one settlement. */
export const encodeSettle = (s: Router3Settlement): Hex =>
  encodeFunctionData({ abi: router3SettleAbi, functionName: 'settle', args: [s] });

/** The settleBatch calldata for several settlements, in this order (all or none on Base). */
export const encodeSettleBatch = (batch: readonly Router3Settlement[]): Hex =>
  encodeFunctionData({ abi: router3SettleAbi, functionName: 'settleBatch', args: [batch] });

/** The settlement a stored settle calldata carries (a batch is rebuilt from its members' own). */
export function decodeSettle(calldata: Hex): Router3Settlement {
  const decoded = decodeFunctionData({ abi: router3SettleAbi, data: calldata });
  if (decoded.functionName !== 'settle') throw new Error('Not a settle calldata.');
  const s = decoded.args[0] as Router3Settlement;
  return { ...s };
}

/**
 * The batch lane (room Stress Test #200/#214): settlements of allowlisted workspaces wait up to
 * windowMs (or until maxItems are waiting) and go out together in ONE router 3 settleBatch
 * transaction from this same facilitator EOA. Absent: every settlement is sent alone, as before.
 */
export interface FacilitatorBatchConfig {
  /** Most settlements in one batch (start at 50). */
  maxItems: number;
  /** How long the oldest waiting settlement waits for others before a smaller batch goes. */
  windowMs: number;
  /** Most calldata bytes of one batch (Base refuses transactions above about 128 KB). */
  maxCalldataBytes?: number;
  /** Gas limit allowed per settlement in a batch (the single cap is maxGasLimit). */
  perItemGas?: bigint;
  /**
   * Oldest a member may be when its batch is simulated and signed. Its MCP grant was revalidated
   * when it entered the lane (only the request's own worker can do that), so a member that waited
   * longer (a crash, a backlog, Base down) is refused, never sent on an old grant (room #222).
   */
  maxMemberAgeMs?: number;
  /**
   * Batch groups: the op keys starting with a group's prefix wait, are batched, judged and sent
   * among themselves only, in batches whose op key is 'batch:<prefix><uuid>'. Every other key is
   * the default group. A flush serves exactly one group with that group's caller's `authorize`, so
   * one origin's authority check never judges another origin's members (the sponsored first
   * purchase sends on this EOA beside the engine). Its own size, window and member age, or the
   * config's.
   */
  groups?: FacilitatorBatchGroup[];
  /**
   * Only the groups batch: a key outside every group is never put on the batch lane (sent alone,
   * exactly as without a batch config) and the default group is never flushed.
   */
  groupsOnly?: boolean;
}
/** One batch group (FacilitatorBatchConfig.groups). */
export interface FacilitatorBatchGroup {
  /** The op key prefix of the group's members, e.g. 'sfp:' (lowercase letters, digits, ':', '-'). */
  keyPrefix: string;
  maxItems?: number;
  windowMs?: number;
  maxMemberAgeMs?: number;
}
const GROUP_PREFIX = /^[a-z0-9-]+:$/;
export const BATCH_DEFAULTS = {
  maxCalldataBytes: 96_000,
  perItemGas: 260_000n,
  baseGas: 100_000n,
  maxMemberAgeMs: 10_000,
};
/** The op key prefix of a batch transaction (its members keep their own keys). */
export const BATCH_KEY_PREFIX = 'batch:';

type Keystore = {
  withSigner<T>(ref: string, use: (account: PrivateKeyAccount) => Promise<T>): Promise<T>;
};

export interface Router3FacilitatorDeps {
  db: Database;
  client: PublicClient;
  keystore: Keystore;
  /** The facilitator EOA's opaque keystore ref (CITY_X402_FACILITATOR_KEY_REF). */
  keyRef: string;
  router: Address;
  chainId: number;
  /** Least ETH (wei) the EOA must hold for submit to store a new settlement. */
  minBalanceWei?: bigint;
  /** Fee ceilings and replacement bound (defaults: FEE_CAPS). */
  caps?: Partial<FacilitatorCaps>;
  /**
   * The Base L1 data fee (wei) reserved for one signed transaction, given that transaction
   * serialized unsigned with its real nonce, gas limit and fees (default: the OP-stack
   * GasPriceOracle's getL1Fee over it, doubled as a margin for price moves).
   */
  l1FeeWei?: (unsignedTx: Hex) => Promise<bigint>;
  now?: () => number;
  log?: (line: string) => void;
  /** The batch lane; absent: no settlement is ever batched. */
  batch?: FacilitatorBatchConfig;
  /**
   * A settlement stored by another EOA in the same table is only read here, never sent, refreshed,
   * replaced or fenced (a facilitator that shares its table with another one's sponsored keys).
   */
  foreignReadOnly?: boolean;
}

export class FacilitatorError extends Error {
  constructor(
    readonly code:
      | 'IDEMPOTENCY_CONFLICT'
      /** The EOA holds less ETH than minBalanceWei: nothing was stored. */
      | 'LOW_GAS_FUNDS'
      /** Base could not answer before the first send: the row stays queued, nothing was sent. */
      | 'RPC_UNAVAILABLE'
      /** The caller's deadline passed before signing: the row stays queued, nothing was signed. */
      | 'DEADLINE_PASSED',
    message: string,
  ) {
    super(message);
  }
}

/** 0.0005 ETH. */
export const DEFAULT_MIN_BALANCE_WEI = 500_000_000_000_000n;
/**
 * Spending bounds of the facilitator EOA. Every signature (first send and each replacement) is
 * checked with its ACTUAL gas limit: maxFeePerGas and the priority fee are capped, the gas limit
 * may not exceed maxGasLimit, a transaction is replaced at most maxReplacements times, and the EOA
 * must keep reserveWei on top of the worst-case cost of every settlement still in flight. At a
 * bound nothing new is signed: the settlement stays pending (alerted), never unpaid. Base L1 data
 * fees come on top of gas and are covered by the reserve.
 */
export interface FacilitatorCaps {
  maxFeePerGasWei: bigint;
  maxPriorityFeePerGasWei: bigint;
  maxGasLimit: bigint;
  maxReplacements: number;
  reserveWei: bigint;
}
export const FEE_CAPS: FacilitatorCaps = {
  maxFeePerGasWei: 500_000_000n, // 0.5 gwei (Base runs around 0.006 gwei)
  maxPriorityFeePerGasWei: 50_000_000n, // 0.05 gwei
  maxGasLimit: 400_000n, // one settle measured 164k-185k on a Base fork
  maxReplacements: 3,
  reserveWei: 200_000_000_000_000n, // 0.0002 ETH
};
/** Base's (OP stack) L1 fee oracle predeploy. */
export const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F' as const;
const gasPriceOracleAbi = [
  {
    type: 'function',
    name: 'getL1Fee',
    stateMutability: 'view',
    inputs: [{ name: '_data', type: 'bytes' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
/** An unmined transaction older than this is replaced (same nonce, same calldata, +30% fees). */
export const STUCK_MS = 5 * 60_000;
/** How often (per instance) a submit looks at the lane's head (healHead). */
export const HEAD_CHECK_MS = 15_000;
/** A lane head unmined this long after its send is refreshed by the next submit. */
export const HEAD_STALE_MS = 30_000;
/** A claim on a queued settlement (simulate, sign, send) older than this may be taken over. */
export const CLAIM_TTL_MS = 60_000;

/** The chain module's never-broadcast codes (submit.ts NEVER_BROADCAST), reused unchanged. */
type NeverBroadcast = (typeof NEVER_BROADCAST)[number];
const REFUSED: NeverBroadcast = 'REFUSED_BEFORE_BROADCAST';
const ABANDONED: NeverBroadcast = 'ABANDONED_BEFORE_BROADCAST';
const TERMINAL: readonly StoredOperation['status'][] = ['final', 'failed'];

interface OpRow {
  op_key: string;
  intent_hash: string;
  facilitator: string;
  calldata: string;
  status: StoredOperation['status'];
  claim_id: string | null;
  claimed_at: string | null;
  nonce: string | null;
  gas_limit: string | null;
  max_fee_per_gas: string | null;
  max_priority_fee_per_gas: string | null;
  l1_fee_wei: string | null;
  raw_tx: string | null;
  tx_hash: string | null;
  tx_hashes: string[];
  sent_at: string | null;
  block_number: string | null;
  block_hash: string | null;
  never_sent: boolean;
  error_code: string | null;
  error_name: string | null;
  batch_lane: boolean;
  batch_key: string | null;
  created_at: string;
}

const COLUMNS = `op_key, intent_hash, facilitator, calldata, status, claim_id, claimed_at::text AS claimed_at,
  nonce::text AS nonce, gas_limit::text AS gas_limit, max_fee_per_gas::text AS max_fee_per_gas,
  max_priority_fee_per_gas::text AS max_priority_fee_per_gas, l1_fee_wei::text AS l1_fee_wei, raw_tx, tx_hash, tx_hashes,
  sent_at::text AS sent_at, block_number::text AS block_number, block_hash, never_sent, error_code,
  error_name, batch_lane, batch_key, created_at::text AS created_at`;

const opOf = (row: OpRow): FeedPayOp => ({
  key: row.op_key,
  status: row.status,
  txHash: (row.tx_hash as Hex | null) ?? null,
  blockNumber: row.block_number === null ? null : BigInt(row.block_number),
  neverSent: row.never_sent,
  errorCode: row.error_code,
});

const ceilMul = (value: bigint, num: bigint, den: bigint) => (value * num + den - 1n) / den;
const minOf = (a: bigint, b: bigint) => (a < b ? a : b);
const maxOf = (a: bigint, b: bigint) => (a > b ? a : b);

/** Whether an error (or one of its causes) is a definite "not found". */
function notFound(
  error: unknown,
  kind: typeof TransactionReceiptNotFoundError | typeof TransactionNotFoundError,
) {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    if (current instanceof kind || (current as { name?: unknown }).name === kind.name) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** A send the node refused because it already has exactly this transaction. */
const ALREADY_KNOWN = /already known|known transaction|already imported/i;
function alreadyKnown(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    const e = current as { message?: unknown; details?: unknown; cause?: unknown };
    if (typeof e.details === 'string' && ALREADY_KNOWN.test(e.details)) return true;
    if (typeof e.message === 'string' && ALREADY_KNOWN.test(e.message)) return true;
    current = e.cause;
  }
  return false;
}

/**
 * Whether a failed estimateGas is the call reverting (not Base being unavailable), and the
 * decoded error name when the revert data is router 3's or a revert string's: `AlreadyCharged`,
 * `Error: FiatTokenV2: invalid signature`.
 */
export function simulationRevert(error: unknown): { reverted: boolean; name: string | null } {
  let reverted = false;
  let data: Hex | null = null;
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const e = current as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      details?: unknown;
      data?: unknown;
      cause?: unknown;
    };
    if (e.name === 'ExecutionRevertedError' || e.code === 3) reverted = true;
    for (const text of [e.message, e.details])
      if (typeof text === 'string' && /revert/i.test(text)) reverted = true;
    const raw =
      typeof e.data === 'string'
        ? e.data
        : typeof (e.data as { data?: unknown } | null)?.data === 'string'
          ? (e.data as { data: string }).data
          : null;
    if (!data && raw && /^0x[0-9a-fA-F]{8,}$/.test(raw)) data = raw as Hex;
    current = e.cause;
  }
  if (data) reverted = true;
  if (!reverted) return { reverted, name: null };
  if (!data) return { reverted, name: null };
  try {
    // decodeErrorResult also knows Solidity's built-in Error(string) and Panic(uint256).
    const decoded = decodeErrorResult({ abi: router3SettleAbi, data }) as {
      errorName: string;
      args?: readonly unknown[];
    };
    if (decoded.errorName === 'Error' && typeof decoded.args?.[0] === 'string')
      return { reverted, name: `Error: ${decoded.args[0].slice(0, 120)}` };
    return { reverted, name: decoded.errorName };
  } catch {
    return { reverted, name: null };
  }
}

export function createRouter3Facilitator(deps: Router3FacilitatorDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const minBalance = deps.minBalanceWei ?? DEFAULT_MIN_BALANCE_WEI;
  const caps: FacilitatorCaps = { ...FEE_CAPS, ...deps.caps };
  /** Caps a fee quote: never above the configured ceilings. */
  const capped = (fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }) => {
    const maxPriorityFeePerGas = minOf(fees.maxPriorityFeePerGas, caps.maxPriorityFeePerGasWei);
    const maxFeePerGas = maxOf(
      minOf(fees.maxFeePerGas, caps.maxFeePerGasWei),
      maxPriorityFeePerGas,
    );
    return { maxFeePerGas, maxPriorityFeePerGas };
  };
  /**
   * Worst-case cost of every other settlement of this EOA in flight: gas limit x max fee plus the
   * L1 fee reserved when it was signed (stored with its raw transaction). Called inside the
   * transaction that holds the EOA's lane lock, so concurrent signers see each other. A settlement
   * already in a block ('included') has paid its gas: the balance read shows it, so it is not
   * counted again until finality (~20 min on Base). Counting it held the whole balance at Block D's
   * volume (21 Oct: LOW_GAS_FUNDS with 0.058 ETH). A reorg moves it back to 'reorged', which counts.
   */
  const inFlightLiability = async (
    q: Transaction,
    from: Address,
    exceptKey: string,
    /** The block the balance was read at: an op included at or below it paid its gas in it. */
    balanceBlock: bigint,
  ) => {
    const { rows } = await q.query<{ wei: string | null }>(
      `SELECT COALESCE(SUM(gas_limit * max_fee_per_gas + COALESCE(l1_fee_wei, 0)), 0)::text AS wei
       FROM x402_facilitator_ops
       WHERE facilitator = $1 AND op_key <> $2 AND raw_tx IS NOT NULL
         AND status NOT IN ('final', 'failed')
         AND NOT (status = 'included' AND block_number IS NOT NULL
           AND block_number <= $3::numeric)`,
      [from.toLowerCase(), exceptKey, balanceBlock.toString(10)],
    );
    return BigInt(rows[0]?.wei ?? '0');
  };
  /** Whether a signature fits the balance: its gas and L1 fee, the reserve, the others in flight. */
  const fits = (
    balance: bigint,
    gas: bigint,
    maxFeePerGas: bigint,
    l1Fee: bigint,
    liability: bigint,
  ) => balance >= gas * maxFeePerGas + l1Fee + caps.reserveWei + liability;
  const l1Oracle =
    deps.l1FeeWei ??
    (async (unsignedTx: Hex) =>
      2n *
      ((await deps.client.readContract({
        address: GAS_PRICE_ORACLE,
        abi: gasPriceOracleAbi,
        functionName: 'getL1Fee',
        args: [unsignedTx],
      })) as bigint));
  /**
   * The L1 data fee of exactly the transaction about to be signed: the oracle reads the whole
   * EIP-1559 transaction serialized unsigned, with its allocated nonce, gas limit and capped fees
   * (the oracle adds the signature allowance itself).
   */
  const l1FeeOf = (input: {
    nonce: bigint;
    data: Hex;
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }) =>
    l1Oracle(
      serializeTransaction({
        type: 'eip1559',
        chainId: deps.chainId,
        nonce: Number(input.nonce),
        to: router,
        value: 0n,
        data: input.data,
        gas: input.gas,
        maxFeePerGas: input.maxFeePerGas,
        maxPriorityFeePerGas: input.maxPriorityFeePerGas,
      }),
    );
  /** Takes the EOA's lane lock (one row per chain and EOA) inside a transaction. */
  const lockLane = async (tx: Transaction, from: Address, at: number) => {
    await tx.query(
      `INSERT INTO x402_facilitator_lanes (chain_id, facilitator, next_nonce, updated_at)
       VALUES ($1, $2, 0, $3) ON CONFLICT DO NOTHING`,
      [deps.chainId, from.toLowerCase(), at],
    );
    return (
      await tx.query<{ next_nonce: string }>(
        `SELECT next_nonce::text AS next_nonce FROM x402_facilitator_lanes
         WHERE chain_id = $1 AND facilitator = $2 FOR UPDATE`,
        [deps.chainId, from.toLowerCase()],
      )
    ).rows[0]!;
  };
  const router = deps.router.toLowerCase() as Address;
  let cachedAddress: Address | null = null;

  /**
   * The batch lane's groups (FacilitatorBatchConfig.groups): `prefix` null is the default group
   * (every key outside the others). Group prefixes are validated so they are safe in LIKE.
   */
  interface Lane {
    id: string;
    prefix: string | null;
    maxItems: number;
    windowMs: number;
    maxAge: number;
  }
  const groupLanes: Lane[] = (deps.batch?.groups ?? []).map((g) => {
    if (!GROUP_PREFIX.test(g.keyPrefix) || g.keyPrefix === BATCH_KEY_PREFIX)
      throw new Error('Invalid batch group prefix.');
    return {
      id: g.keyPrefix,
      prefix: g.keyPrefix,
      maxItems: g.maxItems ?? deps.batch!.maxItems,
      windowMs: g.windowMs ?? deps.batch!.windowMs,
      maxAge: g.maxMemberAgeMs ?? deps.batch!.maxMemberAgeMs ?? BATCH_DEFAULTS.maxMemberAgeMs,
    };
  });
  if (new Set(groupLanes.map((l) => l.id)).size !== groupLanes.length)
    throw new Error('Duplicate batch group prefix.');
  const defaultLane: Lane | null =
    deps.batch && !deps.batch.groupsOnly
      ? {
          id: '',
          prefix: null,
          maxItems: deps.batch.maxItems,
          windowMs: deps.batch.windowMs,
          maxAge: deps.batch.maxMemberAgeMs ?? BATCH_DEFAULTS.maxMemberAgeMs,
        }
      : null;
  /** Every group prefix as a LIKE pattern (the default group is the keys matching none). */
  const groupPatterns = groupLanes.map((l) => `${l.prefix}%`);
  const batchGroupPatterns = groupLanes.map((l) => `${BATCH_KEY_PREFIX}${l.prefix}%`);
  /** The group of a settlement's key; null: it never batches here. */
  const laneOfKey = (key: string): Lane | null =>
    groupLanes.find((l) => key.startsWith(l.prefix!)) ?? defaultLane;
  /** The group a batch op belongs to (by its key); null: none configured here. */
  const laneOfBatch = (batchKey: string): Lane | null =>
    groupLanes.find((l) => batchKey.startsWith(`${BATCH_KEY_PREFIX}${l.prefix}`)) ?? defaultLane;
  /**
   * The extra SQL condition (and its parameter, as $n) keeping a query to one group's keys: a
   * group's own prefix, or for the default group every key outside the groups. No groups
   * configured: nothing (the query is exactly the one without groups).
   */
  const scope = (lane: Lane, n: number, patterns: string[], prefixed: (p: string) => string) =>
    lane.prefix
      ? { sql: ` AND op_key LIKE $${n}`, params: [`${prefixed(lane.prefix)}%`] }
      : patterns.length
        ? { sql: ` AND NOT (op_key LIKE ANY($${n}::text[]))`, params: [patterns] }
        : { sql: '', params: [] };
  const memberScope = (lane: Lane, n: number) => scope(lane, n, groupPatterns, (p) => p);
  const batchScope = (lane: Lane, n: number) =>
    scope(lane, n, batchGroupPatterns, (p) => `${BATCH_KEY_PREFIX}${p}`);
  /**
   * A row stored by ANOTHER EOA (a second facilitator writes the same table), when this instance
   * was built with foreignReadOnly: it never refreshes, replaces, signs or fences it (its nonce and
   * key are the other EOA's); it only reads its stored state. '' is endUnsent's tombstone.
   */
  const storedByOther = async (row: OpRow) =>
    row.facilitator !== '' && row.facilitator !== (await address()).toLowerCase();
  const foreign = async (row: OpRow) => Boolean(deps.foreignReadOnly) && storedByOther(row);

  const address = async (): Promise<Address> => {
    if (!cachedAddress)
      cachedAddress = await deps.keystore.withSigner(deps.keyRef, async (a) => a.address);
    return cachedAddress;
  };

  const get = async (key: string, tx: Transaction = deps.db, lock = false) =>
    (
      await tx.query<OpRow>(
        `SELECT ${COLUMNS} FROM x402_facilitator_ops WHERE op_key = $1${lock ? ' FOR UPDATE' : ''}`,
        [key],
      )
    ).rows[0] ?? null;

  const ethBalance = async () => deps.client.getBalance({ address: await address() });
  /**
   * The EOA's balance at one block, with that block's number. The liabilities are counted against
   * the same observation (an op included at or below it has paid its gas in this balance; one
   * included later, or not at all, still counts), however long the caller then waits for the lane.
   */
  const ethBalanceAt = async () => {
    const head = await deps.client.getBlock({ blockTag: 'latest' });
    const block = BigInt(head.number!);
    const balance = await deps.client.getBalance({ address: await address(), blockNumber: block });
    return { balance, block };
  };

  /** The node's fees now: maxFeePerGas = 2 × base fee + priority fee. */
  const nodeFees = async () => {
    const block = await deps.client.getBlock({ blockTag: 'latest' });
    const priority = await deps.client.estimateMaxPriorityFeePerGas();
    const base = block.baseFeePerGas ?? 0n;
    return { maxFeePerGas: 2n * base + priority, maxPriorityFeePerGas: priority };
  };

  const sign = (input: {
    nonce: bigint;
    data: Hex;
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }) =>
    deps.keystore.withSigner(deps.keyRef, (account) =>
      account.signTransaction({
        type: 'eip1559',
        chainId: deps.chainId,
        nonce: Number(input.nonce),
        to: router,
        value: 0n,
        data: input.data,
        gas: input.gas,
        maxFeePerGas: input.maxFeePerGas,
        maxPriorityFeePerGas: input.maxPriorityFeePerGas,
      }),
    );

  /** Ends a queued, unsigned settlement this worker claimed, as never sent. */
  const endClaimed = async (key: string, claimId: string, code: string, name: string | null) => {
    const { rows } = await deps.db.query<OpRow>(
      `UPDATE x402_facilitator_ops SET status = 'failed', never_sent = true, error_code = $3,
         error_name = $4, claim_id = NULL, updated_at = $5
       WHERE op_key = $1 AND claim_id = $2 AND status = 'queued' AND raw_tx IS NULL
       RETURNING ${COLUMNS}`,
      [key, claimId, code, name, now()],
    );
    log(`x402 facilitator: ${key} failed ${code}${name ? ` (${name})` : ''}, never sent`);
    return rows[0] ?? (await get(key));
  };

  const releaseClaim = (key: string, claimId: string) =>
    deps.db.query(
      'UPDATE x402_facilitator_ops SET claim_id = NULL, claimed_at = NULL, updated_at = $3 WHERE op_key = $1 AND claim_id = $2',
      [key, claimId, now()],
    );

  const send = async (raw: Hex): Promise<'sent' | 'failed'> => {
    try {
      await deps.client.sendRawTransaction({ serializedTransaction: raw });
      return 'sent';
    } catch (error) {
      return alreadyKnown(error) ? 'sent' : 'failed';
    }
  };

  /** Simulates, signs on the lane and sends a claimed, queued settlement for the first time. */
  async function firstSend(
    row: OpRow,
    claimId: string,
    beforeBroadcast: () => Promise<void>,
    /** The gas limit allowed (a batch: per settlement times its size). */
    gasCap: bigint = caps.maxGasLimit,
    /** No signature after this time (ms, now()): the claim is released, nothing is signed. */
    deadline?: number,
  ): Promise<OpRow> {
    const key = row.op_key;
    const from = await address();
    const data = row.calldata as Hex;
    let gas: bigint;
    try {
      gas = await deps.client.estimateGas({ account: from, to: router, data });
    } catch (error) {
      const revert = simulationRevert(error);
      if (revert.reverted && !transientChainError(error))
        return (await endClaimed(key, claimId, 'SIMULATION_REVERTED', revert.name)) ?? row;
      await releaseClaim(key, claimId);
      throw new FacilitatorError('RPC_UNAVAILABLE', 'Base could not simulate the settlement now.');
    }
    let fees: Awaited<ReturnType<typeof nodeFees>>;
    let pending: number;
    try {
      fees = await nodeFees();
      pending = await deps.client.getTransactionCount({ address: from, blockTag: 'pending' });
    } catch {
      await releaseClaim(key, claimId);
      throw new FacilitatorError('RPC_UNAVAILABLE', 'Base could not quote fees or nonce now.');
    }
    const gasLimit = ceilMul(gas, 13n, 10n);
    if (gasLimit > gasCap)
      return (await endClaimed(key, claimId, 'GAS_LIMIT_EXCEEDED', null)) ?? row;
    fees = capped(fees);

    try {
      await beforeBroadcast();
    } catch {
      return (await endClaimed(key, claimId, REFUSED, null)) ?? row;
    }

    // Base is read BEFORE the lane lock: the lock is one row for every settlement of this EOA, and
    // holding it across two RPC round trips serialised all of them behind the node (21 Oct: ~85/min
    // at most, then lock timeouts under a burst and no settlement sent at all). The L1 fee is quoted
    // with the pending nonce (the allocated one differs by at most a byte of calldata). The balance
    // is read at one block and the liabilities under the lock are counted against that block
    // (ethBalanceAt, inFlightLiability): settlements included after it, while this one waited for
    // the lane, still count, so the snapshot never makes the budget look larger than it is.
    let balance: { balance: bigint; block: bigint };
    let l1Fee: bigint;
    try {
      balance = await ethBalanceAt();
      l1Fee = await l1FeeOf({ nonce: BigInt(pending), data, gas: gasLimit, ...fees });
    } catch {
      await releaseClaim(key, claimId);
      throw new FacilitatorError('RPC_UNAVAILABLE', 'Base could not report the gas balance now.');
    }

    if (deadline !== undefined && now() >= deadline) {
      await releaseClaim(key, claimId);
      throw new FacilitatorError('DEADLINE_PASSED', 'No time left to sign in this run.');
    }
    let overBudget = false;
    let pastDeadline = false;
    const stored = await deps.db.transaction(async (tx) => {
      const at = now();
      const lane = await lockLane(tx, from, at);
      const current = await get(key, tx, true);
      if (!current || current.claim_id !== claimId || current.status !== 'queued' || current.raw_tx)
        return null;
      const nonce = maxOf(BigInt(lane.next_nonce), BigInt(pending));
      // The budget is checked under the lane lock, against every settlement already signed, so
      // two concurrent first sends can never both spend the same balance.
      if (
        !fits(
          balance.balance,
          gasLimit,
          fees.maxFeePerGas,
          l1Fee,
          await inFlightLiability(tx, from, key, balance.block),
        )
      ) {
        overBudget = true;
        return null;
      }
      // Under the lane and row locks, right before signing: waiting for them may have crossed the
      // deadline (room #234). Nothing is written in this transaction then.
      if (deadline !== undefined && now() >= deadline) {
        pastDeadline = true;
        return null;
      }
      const raw = await sign({ nonce, data, gas: gasLimit, ...fees });
      const hash = keccak256(raw);
      await tx.query(
        'UPDATE x402_facilitator_lanes SET next_nonce = $3, updated_at = $4 WHERE chain_id = $1 AND facilitator = $2',
        [deps.chainId, from.toLowerCase(), (nonce + 1n).toString(10), at],
      );
      return (
        await tx.query<OpRow>(
          `UPDATE x402_facilitator_ops SET status = 'submitted', claim_id = NULL, nonce = $2,
             gas_limit = $3, max_fee_per_gas = $4, max_priority_fee_per_gas = $5, raw_tx = $6,
             tx_hash = $7, tx_hashes = ARRAY[$7]::text[], sent_at = $8, updated_at = $8,
             l1_fee_wei = $9
           WHERE op_key = $1 RETURNING ${COLUMNS}`,
          [
            key,
            nonce.toString(10),
            gasLimit.toString(10),
            fees.maxFeePerGas.toString(10),
            fees.maxPriorityFeePerGas.toString(10),
            raw,
            hash,
            at,
            l1Fee.toString(10),
          ],
        )
      ).rows[0];
    });
    if (pastDeadline) {
      await releaseClaim(key, claimId);
      throw new FacilitatorError('DEADLINE_PASSED', 'No time left to sign in this run.');
    }
    if (overBudget) {
      await releaseClaim(key, claimId);
      log(`x402 facilitator: ALERT ${key} gas budget below worst case + reserve, stays queued`);
      throw new FacilitatorError('LOW_GAS_FUNDS', 'The facilitator is low on gas funds.');
    }
    if (!stored) return (await get(key)) ?? row;

    if ((await send(stored.raw_tx as Hex)) === 'sent') {
      log(`x402 facilitator: ${key} sent nonce ${stored.nonce}`);
      return stored;
    }
    const { rows } = await deps.db.query<OpRow>(
      `UPDATE x402_facilitator_ops SET status = 'unknown', error_code = 'BROADCAST_AMBIGUOUS', updated_at = $2
       WHERE op_key = $1 AND status = 'submitted' RETURNING ${COLUMNS}`,
      [key, now()],
    );
    log(`x402 facilitator: ${key} send failed, unknown`);
    return rows[0] ?? stored;
  }

  /** Writes a state change guarded by the row's current status; returns the row as it now is. */
  const move = async (
    row: OpRow,
    from: readonly StoredOperation['status'][],
    set: Partial<Pick<OpRow, 'status' | 'tx_hash' | 'block_number' | 'block_hash' | 'error_code'>>,
  ): Promise<OpRow> => {
    const fields = Object.keys(set) as (keyof typeof set)[];
    const assignments = fields.map((field, i) => `${field} = $${i + 3}`);
    const { rows } = await deps.db.query<OpRow>(
      `UPDATE x402_facilitator_ops SET ${[...assignments, `updated_at = $${fields.length + 3}`].join(', ')}
       WHERE op_key = $1 AND status = ANY($2::text[]) RETURNING ${COLUMNS}`,
      [row.op_key, from, ...fields.map((field) => set[field]), now()],
    );
    if (rows[0] && set.status && set.status !== row.status)
      log(
        `x402 facilitator: ${row.op_key} ${set.status}${set.error_code ? ` ${set.error_code}` : ''}`,
      );
    return rows[0] ?? (await get(row.op_key)) ?? row;
  };

  const IN_FLIGHT: readonly StoredOperation['status'][] = [
    'submitted',
    'unknown',
    'reorged',
    'included',
    'reconciling',
  ];

  /** Replaces a stuck transaction: same nonce, gas limit and calldata, fees +30% (or the node's). */
  async function replace(row: OpRow): Promise<OpRow> {
    // Bounded: at most maxReplacements, never above the fee ceilings, never beyond the gas budget.
    // At a bound the stored transaction stays as it is (pending, alerted).
    if (row.tx_hashes.length - 1 >= caps.maxReplacements) {
      log(`x402 facilitator: ALERT ${row.op_key} replacement limit reached, stays pending`);
      return row;
    }
    let fresh: Awaited<ReturnType<typeof nodeFees>> | null = null;
    try {
      fresh = await nodeFees();
    } catch {
      fresh = null;
    }
    const oldMax = BigInt(row.max_fee_per_gas ?? '0');
    const oldPriority = BigInt(row.max_priority_fee_per_gas ?? '0');
    const maxPriorityFeePerGas = maxOf(
      ceilMul(oldPriority, 13n, 10n),
      fresh?.maxPriorityFeePerGas ?? 0n,
    );
    const bumped = capped({
      maxFeePerGas: maxOf(
        maxOf(ceilMul(oldMax, 13n, 10n), fresh?.maxFeePerGas ?? 0n),
        maxPriorityFeePerGas,
      ),
      maxPriorityFeePerGas,
    });
    // A replacement must raise both fees; at the ceiling there is nothing left to raise.
    if (bumped.maxFeePerGas <= oldMax || bumped.maxPriorityFeePerGas <= oldPriority) {
      log(`x402 facilitator: ALERT ${row.op_key} fee ceiling reached, stays pending`);
      return row;
    }
    const from = row.facilitator as Address;
    const maxFeePerGas = bumped.maxFeePerGas;
    let overBudget = false;
    let l1Fee = 0n;
    let raw: Hex | null = null;
    // Budget check, signature and storage under the EOA's lane lock: concurrent replacements and
    // first sends see each other's liabilities and can never oversubscribe the balance.
    const rows = await deps.db.transaction(async (tx) => {
      const at = now();
      await lockLane(tx, from, at);
      const current = await get(row.op_key, tx, true);
      if (!current || current.sent_at !== row.sent_at) return [] as OpRow[];
      // Balance and this replacement's own L1 fee read under the lane lock, consistent with the
      // liabilities below; the replacement's reservation replaces the one stored for the old one.
      let balance: { balance: bigint; block: bigint };
      try {
        balance = await ethBalanceAt();
        l1Fee = await l1FeeOf({
          nonce: BigInt(row.nonce!),
          data: row.calldata as Hex,
          gas: BigInt(row.gas_limit!),
          maxFeePerGas,
          maxPriorityFeePerGas: bumped.maxPriorityFeePerGas,
        });
      } catch {
        return [] as OpRow[];
      }
      if (
        !fits(
          balance.balance,
          BigInt(row.gas_limit!),
          maxFeePerGas,
          l1Fee,
          await inFlightLiability(tx, from, row.op_key, balance.block),
        )
      ) {
        overBudget = true;
        return [] as OpRow[];
      }
      raw = await sign({
        nonce: BigInt(row.nonce!),
        data: row.calldata as Hex,
        gas: BigInt(row.gas_limit!),
        maxFeePerGas,
        maxPriorityFeePerGas: bumped.maxPriorityFeePerGas,
      });
      const hash = keccak256(raw);
      // Stored before it is sent; claimed on sent_at, so racing readers replace once between them.
      return (
        await tx.query<OpRow>(
          `UPDATE x402_facilitator_ops SET raw_tx = $3, tx_hash = $4, tx_hashes = array_append(tx_hashes, $4),
         max_fee_per_gas = $5, max_priority_fee_per_gas = $6, sent_at = $7, updated_at = $7,
         l1_fee_wei = $9
       WHERE op_key = $1 AND sent_at = $2 AND status = ANY($8::text[]) RETURNING ${COLUMNS}`,
          [
            row.op_key,
            row.sent_at,
            raw,
            hash,
            maxFeePerGas.toString(10),
            bumped.maxPriorityFeePerGas.toString(10),
            at,
            ['submitted', 'unknown', 'reorged'],
            l1Fee.toString(10),
          ],
        )
      ).rows;
    });
    if (overBudget) {
      log(`x402 facilitator: ALERT ${row.op_key} gas budget reached, replacement not signed`);
      return row;
    }
    const replaced = rows[0];
    if (!replaced || !raw) return (await get(row.op_key)) ?? row;
    log(`x402 facilitator: ${row.op_key} replaced (attempt ${replaced.tx_hashes.length})`);
    const sent = await send(raw);
    if (sent === 'sent' && replaced.status === 'unknown')
      return move(replaced, ['unknown'], { status: 'submitted', error_code: null });
    return replaced;
  }

  /** The receipt for any hash this settlement ever had, newest first; null when none has one. */
  async function anyReceipt(row: OpRow): Promise<TransactionReceipt | null> {
    for (const hash of [...row.tx_hashes].reverse()) {
      try {
        return await deps.client.getTransactionReceipt({ hash: hash as Hex });
      } catch (error) {
        if (!notFound(error, TransactionReceiptNotFoundError)) throw error;
      }
    }
    return null;
  }

  let headCheckedAt = 0;
  /**
   * The lane's head: the stored settlement holding the next nonce Base expects. Every later
   * settlement waits behind it, and refresh() (rebroadcast exactly as stored, or the reviewed
   * same-nonce replacement once stuck) only ran when someone asked for THAT key. A head whose call
   * nobody follows any more blocked the whole lane (21 Oct: nonce 150268 dropped after a broadcast
   * failure, 972 signed settlements behind it, nothing mined for an hour). So status() and
   * submit(), at most once per HEAD_CHECK_MS per instance, refresh a head that has waited past
   * HEAD_STALE_MS. Concurrent instances are fenced as for any refresh: a replacement is signed
   * under the lane lock only if the row is unchanged (sent_at), within maxReplacements and the fee
   * caps. Best effort: a failure here never blocks the caller.
   */
  async function healHead() {
    if (now() - headCheckedAt < HEAD_CHECK_MS) return;
    headCheckedAt = now();
    try {
      const from = await address();
      const mined = await deps.client.getTransactionCount({ address: from, blockTag: 'latest' });
      const { rows } = await deps.db.query<OpRow>(
        `SELECT ${COLUMNS} FROM x402_facilitator_ops
         WHERE facilitator = $1 AND nonce = $2::numeric AND raw_tx IS NOT NULL
           AND status NOT IN ('included', 'final', 'failed') LIMIT 1`,
        [from.toLowerCase(), String(mined)],
      );
      const head = rows[0];
      if (!head || Number(head.sent_at ?? 0) > now() - HEAD_STALE_MS) return;
      log(`x402 facilitator: lane head ${head.op_key} waited past ${HEAD_STALE_MS} ms, refreshed`);
      await refresh(head);
    } catch {
      log('x402 facilitator: lane head check failed');
    }
  }

  /**
   * Members still behind a terminal (final or failed) batch take its outcome, at most `limit` per
   * call, oldest first (finalizeIncluded). Conditional on the member not being terminal yet and on
   * the parent still being terminal, so it is safe to repeat and to run beside status().
   */
  async function catchUpMembers(from: string, limit: number): Promise<number> {
    const { rows } = await deps.db.query<{ op_key: string }>(
      `UPDATE x402_facilitator_ops m
       SET status = p.status, tx_hash = p.tx_hash, tx_hashes = p.tx_hashes,
           block_number = p.block_number, block_hash = p.block_hash,
           error_code = p.error_code, claim_id = NULL, updated_at = $3
       FROM x402_facilitator_ops p
       WHERE m.op_key IN (
           SELECT mm.op_key FROM x402_facilitator_ops mm
           JOIN x402_facilitator_ops pp ON pp.op_key = mm.batch_key
           WHERE mm.chain_id = $1 AND mm.facilitator = $2 AND mm.batch_key IS NOT NULL
             AND mm.status NOT IN ('final', 'failed')
             AND pp.chain_id = $1 AND pp.facilitator = $2 AND pp.status IN ('final', 'failed')
           ORDER BY mm.created_at LIMIT $4)
         AND p.op_key = m.batch_key AND p.status IN ('final', 'failed')
         AND m.status NOT IN ('final', 'failed')
       RETURNING m.op_key`,
      [deps.chainId, from, now(), limit],
    );
    return rows.length;
  }

  /** Brings one in-flight row up to date from Base. Throws on RPC failures (status() catches). */
  async function refresh(row: OpRow): Promise<OpRow> {
    if (row.status === 'failed' && row.error_code === 'NONCE_CONSUMED' && row.raw_tx) {
      // Recovery past finality: absence of a receipt was an indexing assumption. If one of our
      // stored hashes has a receipt after all, the settlement is included again.
      const late = await anyReceipt(row);
      if (!late) return row;
      return move(row, ['failed'], {
        status: 'included',
        tx_hash: late.transactionHash.toLowerCase(),
        block_number: late.blockNumber.toString(10),
        block_hash: late.blockHash.toLowerCase(),
        error_code: late.status !== 'success' ? 'REVERTED' : null,
      });
    }
    if (TERMINAL.includes(row.status) || !row.raw_tx || row.nonce === null) return row;
    const from = row.facilitator as Address;
    // The nonce is read before the receipts: a transaction mined by then has its receipt below.
    const mined = await deps.client.getTransactionCount({ address: from, blockTag: 'latest' });
    const receipt = await anyReceipt(row);

    if (receipt) {
      const hash = receipt.transactionHash.toLowerCase();
      const reverted = receipt.status !== 'success';
      let current = row;
      if (
        row.status !== 'included' ||
        row.tx_hash !== hash ||
        row.block_hash !== receipt.blockHash.toLowerCase()
      )
        current = await move(row, IN_FLIGHT, {
          status: 'included',
          tx_hash: hash,
          block_number: receipt.blockNumber.toString(10),
          block_hash: receipt.blockHash.toLowerCase(),
          error_code: reverted ? 'REVERTED' : null,
        });
      if (current.status !== 'included') return current;
      const finalized = await deps.client.getBlock({ blockTag: 'finalized' });
      if (finalized.number === null || receipt.blockNumber > finalized.number) return current;
      const atHeight = await deps.client.getBlock({ blockNumber: receipt.blockNumber });
      if (!atHeight.hash || atHeight.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
        return current;
      return move(
        current,
        ['included'],
        reverted ? { status: 'failed', error_code: 'REVERTED' } : { status: 'final' },
      );
    }

    let current = row;
    // Included before, no receipt now: the block was dropped. Sent again below, exactly as stored.
    if (row.status === 'included')
      current = await move(row, ['included'], {
        status: 'reorged',
        block_number: null,
        block_hash: null,
        error_code: null,
      });
    if (BigInt(mined) > BigInt(current.nonce!)) {
      // Our nonce was used, but none of our stored hashes has a receipt (yet). Only FINALIZED
      // evidence ends it: the nonce consumed at the finalized block and still no receipt for any
      // of our hashes. Before that it keeps reconciling (a lagging receipt backend, or a reorg that
      // frees the nonce again), and every stored hash keeps being checked.
      const finalizedCount = await deps.client.getTransactionCount({
        address: from,
        blockTag: 'finalized',
      });
      if (BigInt(finalizedCount) > BigInt(current.nonce!) && !(await anyReceipt(current)))
        return move(current, ['submitted', 'unknown', 'reorged', 'reconciling'], {
          status: 'failed',
          error_code: 'NONCE_CONSUMED',
        });
      if (current.status !== 'reconciling')
        return move(current, ['submitted', 'unknown', 'reorged'], { status: 'reconciling' });
      return current;
    }
    // The nonce is free again (a reorg dropped what used it): continue the same transaction.
    if (current.status === 'reconciling')
      current = await move(current, ['reconciling'], { status: 'submitted', error_code: null });
    if (current.sent_at !== null && now() - Number(current.sent_at) >= STUCK_MS)
      return replace(current);
    let known = true;
    try {
      await deps.client.getTransaction({ hash: current.tx_hash as Hex });
    } catch (error) {
      if (!notFound(error, TransactionNotFoundError)) throw error;
      known = false;
    }
    if (known) return current;
    const sent = await send(current.raw_tx as Hex);
    log(`x402 facilitator: ${current.op_key} rebroadcast ${sent}`);
    if (sent === 'sent' && current.status === 'unknown')
      return move(current, ['unknown'], { status: 'submitted', error_code: null });
    return current;
  }

  // ---------------------------------------------------------------- batch lane (room #200/#214)
  /**
   * The engine's authority check for batch members, by op key: the keys it refuses now. Asked
   * right before a batch is simulated AND again right before it is signed (beforeBroadcast), so a
   * member refused meanwhile (Feed pay off, paused agent, changed limit) is never sent.
   */
  type Authorize = (keys: string[]) => Promise<Set<string>>;
  /** The groups being flushed by this instance now (one flush per group at a time). */
  const flushing = new Set<string>();
  /**
   * The default (engine) group's flush running on this instance, if any. A group flush waits for it
   * before it starts and again right before it claims a batch: when both are due in the same cycle,
   * the engine's batch takes the lane's nonce first.
   */
  let defaultFlush: Promise<void> | null = null;
  const engineFirst = async () => {
    if (defaultFlush) await defaultFlush.catch(() => {});
  };
  const batchGasCap = (n: number) =>
    BigInt(n) * (deps.batch?.perItemGas ?? BATCH_DEFAULTS.perItemGas) + BATCH_DEFAULTS.baseGas;
  const isBatch = (row: OpRow) => row.op_key.startsWith(BATCH_KEY_PREFIX);

  /** A waiting or batched member refused or abandoned: never sent, out of any batch. */
  const endMember = async (key: string, code: string) =>
    deps.db.query(
      `UPDATE x402_facilitator_ops SET status = 'failed', never_sent = true, error_code = $2,
         batch_key = NULL, claim_id = NULL, updated_at = $3
       WHERE op_key = $1 AND status = 'queued' AND raw_tx IS NULL`,
      [key, code, now()],
    );

  /** Members back to the single path (their batch provably never left the server). */
  const detach = async (batchKey: string, keys?: string[]) =>
    deps.db.query(
      `UPDATE x402_facilitator_ops SET batch_key = NULL, batch_lane = false, claim_id = NULL,
         claimed_at = NULL, updated_at = $2
       WHERE batch_key = $1 AND status = 'queued' AND raw_tx IS NULL
         AND ($3::text[] IS NULL OR op_key = ANY($3::text[]))`,
      [batchKey, now(), keys ?? null],
    );

  /**
   * Makes every member show its batch transaction's state (one shared tx hash, block and outcome),
   * so the engine, the bulk finality and every reader see them like any included settlement. A
   * batch that provably never left (never_sent) hands its members back to the single path; one
   * that reverted or lost its nonce passes that on (the engine checks each member's leg nonces).
   */
  async function propagate(batch: OpRow): Promise<void> {
    if (batch.status === 'queued') return;
    if (batch.status === 'failed' && batch.never_sent) {
      await detach(batch.op_key);
      log(`x402 facilitator: ${batch.op_key} never sent (${batch.error_code}), members single`);
      return;
    }
    await deps.db.query(
      `UPDATE x402_facilitator_ops SET status = $2, tx_hash = $3, tx_hashes = $4::text[],
         block_number = $5::numeric, block_hash = $6, error_code = $7, sent_at = $8::bigint,
         claim_id = NULL, updated_at = $9
       WHERE batch_key = $1 AND status NOT IN ('final', 'failed')
         AND (status IS DISTINCT FROM $2 OR tx_hash IS DISTINCT FROM $3
           OR block_hash IS DISTINCT FROM $6 OR error_code IS DISTINCT FROM $7)`,
      [
        batch.op_key,
        batch.status,
        batch.tx_hash,
        batch.tx_hashes,
        batch.block_number,
        batch.block_hash,
        batch.error_code,
        batch.sent_at,
        now(),
      ],
    );
  }

  /**
   * Sends one claimed batch op: authority for every member, the whole ordered batch simulated (a
   * revert: each member alone, the failing ones back to the single path, the rest rebuilt), then the
   * ordinary firstSend (simulates the final batch again, takes the lane's nonce, signs, sends), with
   * the authority asked once more right before signing. Errors leave it queued for a later flush.
   */
  async function sendBatch(
    batchKey: string,
    claimId: string,
    authorize: Authorize,
    /** A cooperative deadline (now() ms): checked before every new expensive or mutating stage. */
    deadline?: number,
  ) {
    const late = () => deadline !== undefined && now() >= deadline;
    /** Out of time: the claim goes back, the batch stays queued for a later flush. */
    const stop = async () => {
      await releaseClaim(batchKey, claimId);
    };
    /** An RPC bounded by the time left (an answer after it counts as Base being unavailable). */
    const bounded = <T>(work: Promise<T>): Promise<T> =>
      deadline === undefined
        ? work
        : Promise.race([
            work,
            new Promise<T>((_, reject) =>
              setTimeout(
                () => reject(Object.assign(new Error('deadline'), { name: 'HttpRequestError' })),
                Math.max(0, deadline - now()),
              ).unref?.(),
            ),
          ]);
    // Every change to the batch or its members below is fenced by THIS worker's claim on the
    // still unsigned, queued batch op, in the same statement: a worker that lost its claim (it
    // stalled past CLAIM_TTL_MS and another took the batch over) changes nothing (room #223).
    const fenced = async (keys: string[], mode: 'refuse' | 'single'): Promise<boolean> => {
      if (!keys.length) return true;
      const set =
        mode === 'refuse'
          ? `status = 'failed', never_sent = true, error_code = '${REFUSED}', batch_key = NULL`
          : 'batch_key = NULL, batch_lane = false';
      // The parent row is locked FIRST (as rebuild and firstSend do), then the claim is checked,
      // then the members change, in one transaction: a takeover or a signing of the batch waits
      // for this lock, so it can never interleave with the check (room #228).
      return deps.db.transaction(async (tx) => {
        const b = await get(batchKey, tx, true);
        if (!b || b.claim_id !== claimId || b.status !== 'queued' || b.raw_tx) return false;
        const { rows } = await tx.query<{ op_key: string }>(
          `UPDATE x402_facilitator_ops SET ${set}, claim_id = NULL, claimed_at = NULL, updated_at = $3
           WHERE batch_key = $1 AND op_key = ANY($2::text[]) AND status = 'queued' AND raw_tx IS NULL
           RETURNING op_key`,
          [batchKey, keys, now()],
        );
        return rows.length === keys.length;
      });
    };
    /** Still ours: the batch op unsigned, queued and claimed by this worker. */
    const ours = async () => {
      const b = await get(batchKey);
      return !!b && b.claim_id === claimId && b.status === 'queued' && !b.raw_tx;
    };
    const membersOf = async () =>
      (
        await deps.db.query<OpRow>(
          `SELECT ${COLUMNS} FROM x402_facilitator_ops WHERE batch_key = $1 AND status = 'queued'
             AND raw_tx IS NULL ORDER BY created_at, op_key`,
          [batchKey],
        )
      ).rows;
    // The member age of the batch's own group (the sponsored group waits longer than the engine's).
    const maxAge =
      laneOfBatch(batchKey)?.maxAge ?? deps.batch?.maxMemberAgeMs ?? BATCH_DEFAULTS.maxMemberAgeMs;
    const tooOld = (m: OpRow) => now() - Number(m.created_at) > maxAge;

    if (late()) return stop();
    let members = await membersOf();
    if (
      !(await fenced(
        members.filter(tooOld).map((m) => m.op_key),
        'refuse',
      ))
    )
      return;
    members = members.filter((m) => !tooOld(m));
    if (late()) return stop();
    const refused = await authorize(members.map((m) => m.op_key));
    if (!(await fenced([...refused], 'refuse'))) return;
    members = members.filter((m) => !refused.has(m.op_key));
    const from = await address();
    const simulate = async (data: Hex) => {
      try {
        await bounded(deps.client.estimateGas({ account: from, to: router, data }));
        return 'ok' as const;
      } catch (error) {
        const revert = simulationRevert(error);
        return revert.reverted && !transientChainError(error)
          ? ('reverted' as const)
          : ('rpc' as const);
      }
    };
    if (late()) return stop();
    if (members.length) {
      const whole = await simulate(
        encodeSettleBatch(members.map((m) => decodeSettle(m.calldata as Hex))),
      );
      if (whole === 'rpc') {
        await releaseClaim(batchKey, claimId);
        return;
      }
      if (whole === 'reverted') {
        const failing: string[] = [];
        for (const m of members) {
          if (late()) return stop();
          const alone = await simulate(m.calldata as Hex);
          if (alone === 'rpc') {
            await releaseClaim(batchKey, claimId);
            return;
          }
          if (alone === 'reverted') failing.push(m.op_key);
        }
        // Each fails alone too: back to the single path, which ends it SIMULATION_REVERTED itself.
        if (!(await fenced(failing, 'single'))) return;
        members = members.filter((m) => !failing.includes(m.op_key));
      }
    }
    if (!(await ours())) return;
    if (late()) return stop();
    // Membership and calldata in ONE transaction, under the batch row's lock and this claim: the
    // calldata signed below is exactly the members still in the batch at this point.
    const keys = await deps.db.transaction(async (tx) => {
      const b = await get(batchKey, tx, true);
      if (!b || b.claim_id !== claimId || b.status !== 'queued' || b.raw_tx) return null;
      const { rows } = await tx.query<OpRow>(
        `SELECT ${COLUMNS} FROM x402_facilitator_ops WHERE batch_key = $1 AND status = 'queued'
           AND raw_tx IS NULL ORDER BY created_at, op_key`,
        [batchKey],
      );
      const keep = rows.filter((m) => members.some((x) => x.op_key === m.op_key));
      if (!keep.length) return [];
      await tx.query(
        `UPDATE x402_facilitator_ops SET calldata = $2, updated_at = $3 WHERE op_key = $1`,
        [batchKey, encodeSettleBatch(keep.map((m) => decodeSettle(m.calldata as Hex))), now()],
      );
      return keep.map((m) => m.op_key);
    });
    if (keys === null) return;
    if (!keys.length) {
      const ended = await endClaimed(batchKey, claimId, ABANDONED, null);
      if (ended) await propagate(ended);
      return;
    }
    const row = await get(batchKey);
    if (!row || row.claim_id !== claimId) return;
    const kept = members.filter((m) => keys.includes(m.op_key));
    const sent = await firstSend(
      row,
      claimId,
      async () => {
        // Right before signing (firstSend still holds no nonce): age and authority again.
        const old = kept.filter(tooOld).map((m) => m.op_key);
        const late = old.length ? new Set(old) : await authorize(keys);
        if (late.size) {
          await fenced([...late], 'refuse');
          // The batch is not signed: its other members go out alone (each checked again there).
          throw new Error('refused');
        }
      },
      batchGasCap(keys.length),
      deadline,
    ).catch(async (error) => {
      if (error instanceof FacilitatorError) return null; // claim released, stays queued
      throw error;
    });
    if (sent) await propagate(sent);
  }

  /**
   * Sends what the batch lane holds: first any batch op left queued by a crashed worker (its
   * claim expired), then a new batch when maxItems are waiting or the oldest waited windowMs (or
   * `force`). One flush per instance at a time; across instances FOR UPDATE SKIP LOCKED and the
   * claims keep two workers from taking the same members or the same batch.
   */
  async function flush(
    authorize: Authorize,
    force = false,
    deadline?: number,
    /** The group served; null: none configured here (nothing is flushed). */
    lane: Lane | null = defaultLane,
  ): Promise<void> {
    if (!lane || lane.prefix === null) {
      const running = flushLane(authorize, force, deadline, lane);
      if (lane) defaultFlush = running;
      try {
        await running;
      } finally {
        if (defaultFlush === running) defaultFlush = null;
      }
      return;
    }
    await engineFirst();
    await flushLane(authorize, force, deadline, lane);
  }

  async function flushLane(
    authorize: Authorize,
    force: boolean,
    deadline: number | undefined,
    lane: Lane | null,
  ): Promise<void> {
    // Fail closed: no authority check, no batch (a member is never sent unjudged).
    if (!deps.batch || !lane || typeof authorize !== 'function' || flushing.has(lane.id)) return;
    flushing.add(lane.id);
    try {
      const from = (await address()).toLowerCase();
      const at = now();
      const staleScope = batchScope(lane, 5);
      const dueScope = memberScope(lane, 3);
      const pickScope = memberScope(lane, 4);
      const { rows: stale } = await deps.db.query<{ op_key: string }>(
        `SELECT op_key FROM x402_facilitator_ops
         WHERE chain_id = $1 AND facilitator = $2 AND op_key LIKE $3 AND status = 'queued'
           AND raw_tx IS NULL AND (claimed_at IS NULL OR claimed_at <= $4)${staleScope.sql}
         ORDER BY created_at LIMIT 3`,
        [
          deps.chainId,
          from,
          `${BATCH_KEY_PREFIX}${lane.prefix ?? ''}%`,
          at - CLAIM_TTL_MS,
          ...staleScope.params,
        ],
      );
      for (const s of stale) {
        const claimId = randomUUID();
        const { rows } = await deps.db.query(
          `UPDATE x402_facilitator_ops SET claim_id = $2, claimed_at = $3, updated_at = $3
           WHERE op_key = $1 AND status = 'queued' AND raw_tx IS NULL
             AND (claimed_at IS NULL OR claimed_at <= $4) RETURNING op_key`,
          [s.op_key, claimId, at, at - CLAIM_TTL_MS],
        );
        if (rows[0]) await sendBatch(s.op_key, claimId, authorize, deadline);
        if (deadline !== undefined && now() >= deadline) return;
      }
      const { rows: due } = await deps.db.query<{ n: number; oldest: string | null }>(
        `SELECT count(*)::int AS n, min(created_at)::text AS oldest FROM x402_facilitator_ops
         WHERE chain_id = $1 AND facilitator = $2 AND batch_lane AND batch_key IS NULL
           AND status = 'queued' AND raw_tx IS NULL${dueScope.sql}`,
        [deps.chainId, from, ...dueScope.params],
      );
      const n = due[0]?.n ?? 0;
      const oldest = Number(due[0]?.oldest ?? at);
      if (!n || (!force && n < lane.maxItems && at - oldest < lane.windowMs)) return;
      if (lane.prefix !== null) await engineFirst();
      if (deadline !== undefined && now() >= deadline) return;
      const batchKey = `${BATCH_KEY_PREFIX}${lane.prefix ?? ''}${randomUUID()}`;
      const claimId = randomUUID();
      const maxBytes = deps.batch.maxCalldataBytes ?? BATCH_DEFAULTS.maxCalldataBytes;
      const taken = await deps.db.transaction(async (tx) => {
        const { rows } = await tx.query<OpRow>(
          `SELECT ${COLUMNS} FROM x402_facilitator_ops
           WHERE chain_id = $1 AND facilitator = $2 AND batch_lane AND batch_key IS NULL
             AND status = 'queued' AND raw_tx IS NULL${pickScope.sql}
           ORDER BY created_at, op_key LIMIT $3 FOR UPDATE SKIP LOCKED`,
          [deps.chainId, from, lane.maxItems, ...pickScope.params],
        );
        const picked: OpRow[] = [];
        let bytes = 0;
        for (const r of rows) {
          const size = (r.calldata.length - 2) / 2;
          if (picked.length && bytes + size > maxBytes) break;
          picked.push(r);
          bytes += size;
        }
        if (!picked.length) return [];
        const keys = picked.map((r) => r.op_key);
        await tx.query(
          `INSERT INTO x402_facilitator_ops (op_key, intent_hash, chain_id, facilitator, router,
             calldata, status, claim_id, claimed_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $8, $8)`,
          [
            batchKey,
            keccak256(`0x${Buffer.from(keys.join('\n')).toString('hex')}` as Hex),
            deps.chainId,
            from,
            router,
            encodeSettleBatch(picked.map((r) => decodeSettle(r.calldata as Hex))),
            claimId,
            at,
          ],
        );
        await tx.query(
          `UPDATE x402_facilitator_ops SET batch_key = $1, updated_at = $3
           WHERE op_key = ANY($2::text[])`,
          [batchKey, keys, at],
        );
        return keys;
      });
      if (!taken.length) return;
      log(`x402 facilitator: ${batchKey} claimed ${taken.length} settlements`);
      await sendBatch(batchKey, claimId, authorize, deadline);
    } finally {
      flushing.delete(lane.id);
    }
  }

  /** A member's state: its batch's, brought up to date from Base and passed on. */
  async function memberStatus(row: OpRow, authorize?: Authorize): Promise<OpRow> {
    const batch = row.batch_key ? await get(row.batch_key) : null;
    if (!batch) return row;
    if (batch.status === 'queued') {
      if (authorize)
        await flush(authorize, false, undefined, laneOfBatch(batch.op_key)).catch(() =>
          log('x402 facilitator: batch flush failed'),
        );
    } else {
      const fresh = await refresh(batch).catch(() => batch);
      await propagate(fresh);
    }
    return (await get(row.op_key)) ?? row;
  }

  return {
    /** The facilitator EOA (from the keystore signer). */
    address,

    /** The EOA's ETH balance (wei), read live. */
    ethBalance,

    /**
     * Read-only check of a settlement (for the public x402 /verify): simulates exactly the
     * router3.settle call from the facilitator EOA. Never stores a row, never signs, never sends,
     * never spends gas. ok=false carries the decoded revert name when Base gave one.
     */
    async verify(
      settlement: Router3Settlement,
    ): Promise<
      { ok: true; gas: bigint } | { ok: false; reason: string | null; retryable: boolean }
    > {
      try {
        const gas = await deps.client.estimateGas({
          account: await address(),
          to: router,
          data: encodeSettle(settlement),
        });
        return { ok: true, gas };
      } catch (error) {
        const revert = simulationRevert(error);
        if (revert.reverted && !transientChainError(error))
          return { ok: false, reason: revert.name, retryable: false };
        return { ok: false, reason: null, retryable: true };
      }
    },

    /**
     * The stored state of a settlement, read from the database only: no chain read, no
     * rebroadcast, no replacement (safe for unauthenticated polling). Null for an unknown key.
     */
    async storedStatus(key: string): Promise<FeedPayOp | null> {
      const row = await get(key);
      return row ? opOf(row) : null;
    },

    /** Whether the EOA holds at least minBalanceWei (submit refuses new settlements below it). */
    async canPay(): Promise<boolean> {
      return (await ethBalance()) >= minBalance;
    },

    /**
     * Settles one router 3 payment, idempotent per key: stored before anything is sent; a second
     * call with the same key returns the stored settlement (or continues it while it is still
     * queued and unsigned). `beforeBroadcast` runs right before the first send only; if it throws,
     * the settlement ends failed with REFUSED_BEFORE_BROADCAST and is never sent.
     */
    async submit(input: {
      key: string;
      intentHash: Hex;
      settlement: Router3Settlement;
      beforeBroadcast: () => Promise<void>;
      /**
       * The batch lane (allowlisted workspace, decided by the engine from the server-side
       * workspace): the settlement waits for a settleBatch instead of its own transaction. Used
       * only when this facilitator has a batch config and `authorize` is given.
       */
      batch?: {
        authorize: Authorize;
        /**
         * The grant or key an MCP purchase was made with (checked again before the batch is sent);
         * null: no grant applies (a Feed purchase). undefined: unknown here, so it is not batched.
         */
        grant?: { kind: 'grant' | 'key'; id: string } | null;
      };
    }): Promise<FeedPayOp> {
      await healHead();
      const intentHash = input.intentHash.toLowerCase();
      const calldata = encodeSettle(input.settlement);
      const conflict = () =>
        new FacilitatorError('IDEMPOTENCY_CONFLICT', 'This key was used for another settlement.');
      let row = await get(input.key);
      if (row && row.intent_hash !== intentHash) throw conflict();
      // Stored by another EOA: only that facilitator may continue it (its key, its nonce lane).
      if (row && (await foreign(row))) return opOf(row);
      const lane = laneOfKey(input.key);
      if (!row) {
        const balance = await ethBalance().catch(() => {
          throw new FacilitatorError(
            'RPC_UNAVAILABLE',
            'Base could not report the gas balance now.',
          );
        });
        if (balance < minBalance)
          throw new FacilitatorError('LOW_GAS_FUNDS', 'The facilitator is low on gas funds.');
        const at = now();
        await deps.db.query(
          `INSERT INTO x402_facilitator_ops (op_key, intent_hash, chain_id, facilitator, router,
             calldata, status, created_at, updated_at, batch_lane, grant_kind, grant_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $7, $8, $9, $10)
           ON CONFLICT (op_key) DO NOTHING`,
          [
            input.key,
            intentHash,
            deps.chainId,
            (await address()).toLowerCase(),
            router,
            calldata,
            at,
            Boolean(
              input.batch &&
              typeof input.batch.authorize === 'function' &&
              deps.batch &&
              lane &&
              input.batch.grant !== undefined,
            ),
            input.batch?.grant?.kind ?? null,
            input.batch?.grant?.id ?? null,
          ],
        );
        row = await get(input.key);
        if (!row) throw new Error('Settlement row missing after insert.');
        if (row.intent_hash !== intentHash) throw conflict();
      }
      // In a batch: its batch's state (never a transaction of its own).
      if (row.batch_key) return opOf(await memberStatus(row, input.batch?.authorize));
      if (row.status !== 'queued' || row.raw_tx) return opOf(row);
      if (row.calldata !== calldata) throw conflict();
      if (row.batch_lane) {
        // Waiting for a batch: checked now, again before its batch is simulated and signed.
        try {
          await input.beforeBroadcast();
        } catch {
          await endMember(input.key, REFUSED);
          return opOf((await get(input.key)) ?? row);
        }
        if (input.batch && deps.batch)
          await flush(input.batch.authorize, false, undefined, lane).catch(() =>
            log('x402 facilitator: batch flush failed'),
          );
        const now_ = (await get(input.key)) ?? row;
        return opOf(now_.batch_key ? await memberStatus(now_) : now_);
      }

      const claimId = randomUUID();
      const at = now();
      const { rows } = await deps.db.query<OpRow>(
        `UPDATE x402_facilitator_ops SET claim_id = $2, claimed_at = $3, updated_at = $3
         WHERE op_key = $1 AND status = 'queued' AND raw_tx IS NULL
           AND (claimed_at IS NULL OR claimed_at <= $4) RETURNING ${COLUMNS}`,
        [input.key, claimId, at, at - CLAIM_TTL_MS],
      );
      if (!rows[0]) return opOf((await get(input.key)) ?? row);
      return opOf(await firstSend(rows[0], claimId, input.beforeBroadcast));
    },

    /**
     * The settlement as Base has it now: included, final, failed (REVERTED, NONCE_CONSUMED), or
     * still in flight (rebroadcast or replaced as needed). Never throws on RPC hiccups: the stored
     * state is returned. Null for an unknown key.
     */
    async status(key: string, batch?: { authorize: Authorize }): Promise<FeedPayOp | null> {
      // Followed calls reach the lane head too, also while no new settlement is submitted.
      await healHead();
      const row = await get(key);
      if (!row) return null;
      // Stored by another EOA: its stored state only (that facilitator follows it on Base).
      if (await foreign(row)) return opOf(row);
      if (row.batch_key) return opOf(await memberStatus(row, batch?.authorize));
      if (row.batch_lane && row.status === 'queued' && batch && deps.batch) {
        await flush(batch.authorize, false, undefined, laneOfKey(key)).catch(() =>
          log('x402 facilitator: batch flush failed'),
        );
        const after = (await get(key)) ?? row;
        return opOf(after.batch_key ? await memberStatus(after) : after);
      }
      try {
        return opOf(await refresh(row));
      } catch {
        log(`x402 facilitator: ${key} status read failed, stored state returned`);
        return opOf((await get(key).catch(() => null)) ?? row);
      }
    },

    /**
     * Fences off a key whose settlement must never be sent: a tombstone (failed,
     * ABANDONED_BEFORE_BROADCAST) is inserted if no row exists, and a queued, unsigned, unclaimed
     * row is ended the same way. True when the key provably never left the server; false when a
     * real settlement exists (the caller must follow it with status, never release).
     */
    async endUnsent(key: string, intentHash: Hex): Promise<boolean> {
      const intent = intentHash.toLowerCase();
      const at = now();
      const inserted = await deps.db.query(
        `INSERT INTO x402_facilitator_ops (op_key, intent_hash, chain_id, facilitator, router, calldata,
           status, never_sent, error_code, created_at, updated_at)
         VALUES ($1, $2, $3, '', $4, '', 'failed', true, $6, $5, $5)
         ON CONFLICT (op_key) DO NOTHING RETURNING op_key`,
        [key, intent, deps.chainId, router, at, ABANDONED],
      );
      if (inserted.rows.length) return true;
      const row = await get(key);
      if (!row) return false;
      if (row.intent_hash !== intent)
        throw new FacilitatorError(
          'IDEMPOTENCY_CONFLICT',
          'This key was used for another settlement.',
        );
      if (row.never_sent) return true;
      // Another EOA's settlement is never fenced here: it is followed where it is stored.
      if (await foreign(row)) return false;
      // A member of a batch may be in a transaction already: follow it, never fence it off.
      if (row.batch_key) return false;
      const { rows } = await deps.db.query(
        `UPDATE x402_facilitator_ops SET status = 'failed', never_sent = true,
           error_code = $4, updated_at = $2
         WHERE op_key = $1 AND status = 'queued' AND raw_tx IS NULL AND batch_key IS NULL
           AND (claimed_at IS NULL OR claimed_at <= $3) RETURNING op_key`,
        [key, at, at - CLAIM_TTL_MS, ABANDONED],
      );
      return rows.length > 0;
    },

    /**
     * Sends what the batch lane holds now (the recover cron: no settlement waits longer than one
     * run when no new submit comes). `force` sends a smaller batch before its window.
     */
    async flushBatches(
      authorize: Authorize,
      force = false,
      deadline?: number,
      /**
       * The group served (its key prefix, e.g. 'sfp:'); left out: the default group. A group not
       * configured here flushes nothing (another group's members are never judged by `authorize`).
       */
      group?: string,
    ): Promise<void> {
      const lane =
        group === undefined ? defaultLane : (groupLanes.find((l) => l.id === group) ?? null);
      await flush(authorize, force, deadline, lane);
    },

    /** Whether this facilitator batches (a batch config was given). */
    batching(): boolean {
      return Boolean(deps.batch);
    },

    /**
     * Whether this EOA stored the settlement of this key (not another facilitator, not a
     * tombstone): the caller follows and finishes a key on the facilitator that holds it.
     */
    async holds(key: string): Promise<boolean> {
      const row = await get(key);
      return !!row && row.facilitator !== '' && !(await storedByOther(row));
    },

    /**
     * Finality for many settlements at once (21 Oct: 8,214 delivered calls waited for finality
     * that was only recorded when status() reached each key, one row per recover step). One read
     * of the finalized head, then for at most `maxBlocks` distinct stored blocks at or below it,
     * oldest first: the chain's block hash at that height is read, and only rows still 'included'
     * with exactly that block and hash move, reverted ones to failed (REVERTED) and the rest to
     * final, as refresh() does. A block whose hash differs is left to refresh() (reorg handling).
     * Conditional updates only: safe to run concurrently with status() or another batch. Scoped
     * to this chain and this EOA. Bounded by blocks, by rows and by wall time (`budgetMs`, each
     * RPC read also capped by it), so a slow node cannot take the caller's whole run.
     */
    async finalizeIncluded(limits: {
      maxBlocks: number;
      maxRows: number;
      budgetMs: number;
    }): Promise<number> {
      const started = Date.now();
      const left = () => limits.budgetMs - (Date.now() - started);
      const timed = <T>(read: Promise<T>): Promise<T> =>
        Promise.race([
          read,
          new Promise<T>((_, reject) => {
            const timer = setTimeout(() => reject(new Error('finality budget spent')), left());
            timer.unref?.();
          }),
        ]);
      const from = (await address()).toLowerCase();
      // Base unreadable now: no new finality, but members of batches already terminal still catch up.
      const finalized = await timed(deps.client.getBlock({ blockTag: 'finalized' })).catch(
        () => null,
      );
      if (finalized?.number === null || finalized?.number === undefined)
        return catchUpMembers(from, limits.maxRows);
      const { rows: blocks } = await deps.db.query<{ block_number: string; block_hash: string }>(
        `SELECT block_number::text AS block_number, block_hash FROM (
           SELECT DISTINCT block_number, block_hash FROM x402_facilitator_ops
           WHERE chain_id = $1 AND facilitator = $2 AND status = 'included'
             AND block_number IS NOT NULL AND block_hash IS NOT NULL AND block_number <= $3::numeric
         ) b ORDER BY b.block_number LIMIT $4`,
        [deps.chainId, from, finalized.number.toString(10), limits.maxBlocks],
      );
      let moved = 0;
      for (const b of blocks) {
        if (left() <= 0 || moved >= limits.maxRows) break;
        let canonical: { hash: string | null };
        try {
          canonical = await timed(deps.client.getBlock({ blockNumber: BigInt(b.block_number) }));
        } catch {
          break;
        }
        if (!canonical.hash || canonical.hash.toLowerCase() !== b.block_hash.toLowerCase())
          continue;
        const { rows } = await deps.db.query<{ op_key: string }>(
          `UPDATE x402_facilitator_ops
           SET status = CASE WHEN error_code = 'REVERTED' THEN 'failed' ELSE 'final' END,
               updated_at = $5
           WHERE op_key IN (
             SELECT op_key FROM x402_facilitator_ops
             WHERE chain_id = $1 AND facilitator = $2 AND status = 'included'
               AND block_number = $3::numeric AND block_hash = $4
             LIMIT $6)
             AND chain_id = $1 AND facilitator = $2 AND status = 'included'
             AND block_number = $3::numeric AND block_hash = $4
           RETURNING op_key`,
          [deps.chainId, from, b.block_number, b.block_hash, now(), limits.maxRows - moved],
        );
        moved += rows.length;
      }
      // Members whose batch is final (or failed) carry its outcome too, within what is left of the
      // row quota. Its own pass over EVERY terminal batch, not only the ones this run finalized: a
      // member left behind (propagate() not run, or this step failing after its batch moved) is
      // picked up by a later run instead of waiting for its own status() call. It runs even when
      // budgetMs is spent: one bounded statement (the pool's 8 s statement_timeout), so the batch
      // may overrun its budget by at most that, never by more RPC reads.
      if (moved < limits.maxRows) moved += await catchUpMembers(from, limits.maxRows - moved);
      return moved;
    },

    /** The decoded revert name of a SIMULATION_REVERTED settlement, when Base gave one. */
    async errorName(key: string): Promise<string | null> {
      return (await get(key))?.error_name ?? null;
    },
  };
}

export type Router3Facilitator = ReturnType<typeof createRouter3Facilitator>;
