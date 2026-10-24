/*
 * Operation Paymaster, Phase 1: our own bundler and sponsoring service (CITY_BASE_BUNDLER=direct).
 * It implements the same Bundler interface as the CDP one (rpc-bundler.ts), with no third party:
 *
 *   prepare  fees from Base (capped by the policy's ceilings), gas limits of our own (Base's L1 data
 *            fee included in preVerificationGas), and, for a sponsored operation, four gates in
 *            this order, all BEFORE our paymaster signs:
 *              1. the caller's intent, from its own records: the sender (and the deployment) it
 *                 prepared the operation for, its flow, and EXACTLY the calls it built (the
 *                 callData must be their encoding);
 *              2. the flow's policy (own-paymaster-policy.ts);
 *              3. the budget: the worst case is reserved under the paymaster digest (getHash, which
 *                 the deterministic signature then fixes), and only then signed;
 *              4. the reservation is re-keyed to the userOpHash the signature produced.
 *   send     one operation per EntryPoint.handleOps transaction from our submitter EOA (beneficiary:
 *            the submitter itself, so the EntryPoint pays its gas back). Durable sending, in the
 *            same way as the router-3 facilitator (protocol/x402/facilitator.ts):
 *              1. an operation already stored here is never signed again: it is rebroadcast exactly
 *                 as stored, replaced at the SAME nonce once stuck (bounded), or cancelled at that
 *                 nonce (a zero-value self-transfer) once it can no longer succeed (expired, or its
 *                 simulation reverts), so a revert is never paid for;
 *              2. a new one is simulated first (estimateGas of handleOps): a revert sends nothing,
 *                 takes no nonce and moves no reservation;
 *              3. in ONE database transaction: the reservation moves reserved -> sent
 *                 and the submitter's own exposure is admitted, both under the budget
 *                 lock; then the nonce is taken from the lane row (lane lock), and the transaction
 *                 is signed in the keystore and stored. A crash after the commit is recovered by
 *                 rebroadcasting the stored bytes; a crash before it leaves nothing durable, and
 *                 the reservation lapses by time;
 *              4. only then is it broadcast.
 *   receipt  from the stored transaction's receipt and its UserOperationEvent. The sponsorship
 *            settles at actualGasCost (0 when handleOps reverted or was cancelled); the submitter's
 *            exposure settles at its measured overhead (L2 gas + L1 fee - repayment). An operation
 *            this module never sent (the CDP bundler's, before the switch) is answered by
 *            `fallback`.
 *   maintain the cron (/api/cron/own-paymaster-maintain) and every send/receipt look after open
 *            sends: rebroadcast, replace, cancel, receipts, settlement.
 *
 * Runbook: before switching CITY_BASE_BUNDLER off again, let the cron drain every
 * non-final send (SELECT count(*) FROM own_paymaster_sends WHERE NOT final = 0): with the switch
 * off nothing follows them, and their reservations stay held at worst case until they are final.
 *
 * Fails closed: nothing is sponsored unless the mode is 'on', the paymaster is
 * configured, its on-chain verifyingSigner is our signer key's address (decrypted, so a missing or
 * rotated KEK refuses), no foreign pending signer is set, and our submitter is on its bundler
 * allowlist. Prepare mode sponsors nothing.
 *
 * Logs carry hashes, states and codes only: never raw transactions, keys or endpoint URLs.
 */
import {
  decodeErrorResult,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseEventLogs,
  serializeTransaction,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import type { FastifyInstance } from 'fastify';
import type { PrivateKeyAccount } from 'viem/accounts';
import { cronAuthorized } from '../../wake/cron.js';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import type { Database, Transaction } from '../../database.js';
import { registerMigration, type Migration } from '../../migrations.js';
import type { Address } from '../../../shared/base/chains.js';
import { SPONSOR_PAYMASTERS } from '../../../shared/base/paymasters.js';
import { protocolDeployment } from '../../../shared/protocol.js';
import { protocolRouter2FromEnv } from '../../protocol/fees/cron.js';
import {
  BudgetError,
  budgetTransient,
  ownPaymasterBudget,
  ReservationGone,
  worstCaseWei,
} from './own-paymaster-budget.js';
import {
  ownPaymasterMode,
  PAYMASTER_ADDRESS_SETTING,
  provisionedPaymasterKeys,
} from './own-paymaster-keys.js';
import { paymasterHash, signPaymasterData, type PaymasterFields } from './own-paymaster.js';
import {
  checkSponsorship,
  GAS_CEILINGS,
  PolicyRefusal,
  type GasCeilings,
  type PolicyAddresses,
  type SponsorFlow,
} from './own-paymaster-policy.js';
import { liveReads } from './rpc-budget.js';
import { BundlerError, SponsorError } from './rpc-bundler.js';
import {
  encodeAccountCalls,
  type Bundler,
  type BundlerReceipt,
  type SponsorIntent,
} from './submit.js';
import { transientChainError } from './transient.js';

export const DIRECT_BUNDLER_TABLES = [
  'own_paymaster_lanes',
  'own_paymaster_sends',
  'own_paymaster_prepared',
] as const;

export const DIRECT_BUNDLER_SQL = `
CREATE TABLE IF NOT EXISTS own_paymaster_lanes (
  chain_id integer NOT NULL,
  submitter text NOT NULL CHECK (submitter ~ '^0x[0-9a-f]{40}$'),
  next_nonce numeric(78,0) NOT NULL CHECK (next_nonce >= 0),
  updated_at bigint NOT NULL,
  PRIMARY KEY (chain_id, submitter)
);
CREATE TABLE IF NOT EXISTS own_paymaster_sends (
  user_op_hash text PRIMARY KEY CHECK (user_op_hash ~ '^0x[0-9a-f]{64}$'),
  chain_id integer NOT NULL,
  submitter text NOT NULL,
  sponsored boolean NOT NULL,
  calldata text NOT NULL,
  valid_until bigint NOT NULL DEFAULT 0,
  nonce numeric(78,0) NOT NULL,
  gas_limit numeric(78,0) NOT NULL,
  max_fee_per_gas numeric(78,0) NOT NULL,
  max_priority_fee_per_gas numeric(78,0) NOT NULL,
  raw_tx text NOT NULL,
  l1_fee_wei numeric(78,0) NOT NULL DEFAULT 0,
  cancelled boolean NOT NULL DEFAULT false,
  tx_hash text NOT NULL,
  tx_hashes text[] NOT NULL,
  sent_at bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('submitted','included','failed')),
  block_number numeric(78,0),
  block_hash text,
  settled boolean NOT NULL DEFAULT false,
  error_code text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (chain_id, submitter, nonce),
  CHECK (status <> 'failed' OR settled)
);
CREATE INDEX IF NOT EXISTS own_paymaster_sends_open ON own_paymaster_sends (submitter, nonce)
  WHERE status = 'submitted' OR NOT settled;
`;

/**
 * Migration 259: a send is followed until its receipt is final, and only then settled. Applied after 258 as it shipped (inert rollout); 258 itself is unchanged.
 */
export const DIRECT_BUNDLER_FINALITY_SQL = `
ALTER TABLE own_paymaster_sends ADD COLUMN IF NOT EXISTS final boolean NOT NULL DEFAULT false;
ALTER TABLE own_paymaster_sends ADD CONSTRAINT own_paymaster_sends_final_settled
  CHECK (NOT final OR settled);
CREATE INDEX IF NOT EXISTS own_paymaster_sends_unfinal ON own_paymaster_sends (submitter, nonce)
  WHERE NOT final;
-- Provenance: every operation this bundler prepared, so it is only ever sent through it, never
-- forwarded to another bundler (and nothing another bundler prepared moves here). Never pruned:
-- age must not hand an operation of ours to another bundler.
CREATE TABLE IF NOT EXISTS own_paymaster_prepared (
  user_op_hash text PRIMARY KEY CHECK (user_op_hash ~ '^0x[0-9a-f]{64}$'),
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS own_paymaster_prepared_age ON own_paymaster_prepared (created_at);
`;

/** Migration 258: the submitter's lane and its stored transactions; nothing else touched. */
export const directBundlerMigration: Migration = {
  version: 258,
  name: 'own_paymaster_sends',
  sql: DIRECT_BUNDLER_SQL,
};
export const directBundlerFinalityMigration: Migration = {
  version: 259,
  name: 'own_paymaster_sends_final',
  sql: DIRECT_BUNDLER_FINALITY_SQL,
};
export function registerDirectBundlerMigration(): void {
  registerMigration(directBundlerMigration);
  registerMigration(directBundlerFinalityMigration);
}

const entryPointAbi = parseAbi([
  'struct UserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; uint256 callGasLimit; uint256 verificationGasLimit; uint256 preVerificationGas; uint256 maxFeePerGas; uint256 maxPriorityFeePerGas; bytes paymasterAndData; bytes signature; }',
  'function handleOps(UserOperation[] ops, address beneficiary)',
  'error FailedOp(uint256 opIndex, string reason)',
]);
const userOperationEvent = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);
/** Base's (OP stack) L1 fee oracle predeploy. */
export const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F' as const;
const oracleAbi = parseAbi(['function getL1Fee(bytes data) view returns (uint256)']);
const EXPOSURE_TAG = Buffer.from('own-paymaster/submitter-exposure').toString('hex');
/** The budget key of the submitter's own exposure for one operation. */
export const exposureKey = (userOpHash: string) =>
  keccak256(`0x${EXPOSURE_TAG}${userOpHash.slice(2).toLowerCase()}`);
const paymasterAbi = parseAbi([
  'function verifyingSigner() view returns (address)',
  'function pendingVerifyingSigner() view returns (address)',
  'function isBundlerAllowed(address bundler) view returns (bool)',
]);

/** How long a sponsorship stays valid at most (seconds); within the owner's 10-minute deadline. */
export const SPONSOR_VALIDITY_S = 9 * 60;
/**
 * A sponsored operation this close to its validUntil is no longer sent, and one still pending is
 * cancelled: it could otherwise be mined just past validUntil and revert (AA32) at
 * our cost.
 */
export const VALIDITY_MARGIN_S = 120;
/** Gas limits of our own (EntryPoint v0.6 charges what is used, not the limit). */
export const DIRECT_GAS = {
  /** Without initCode: the inner call is estimated, then given this margin and floor. */
  callFloor: 100_000n,
  callMargin: 50_000n,
  verification: 300_000n,
  verificationWithInit: 700_000n,
  /** Base overhead of a one-op bundle before calldata (21000 intrinsic + EntryPoint bookkeeping). */
  preVerificationBase: 45_000n,
  /** What the submitter's handleOps transaction may use at most. */
  maxTxGas: 6_000_000n,
  /** A cancellation: a zero-value transfer to the submitter itself. */
  cancel: 21_000n,
} as const;
/** An unmined transaction older than this is replaced (same nonce and calldata, +30% fees). */
export const STUCK_MS = 3 * 60_000;
export const MAX_REPLACEMENTS = 3;
/** The submitter keeps at least this much ETH beyond one transaction's worst case. */
export const SUBMITTER_RESERVE_WEI = 100_000_000_000_000n; // 0.0001 ETH
/** How often (per instance) open sends are looked after without being asked (maintain). */
export const MAINTAIN_EVERY_MS = 15_000;
/** Final receipts settled per run: 4 x the lane limit (200 per cron minute), 8 at a time. */
export const SETTLE_FACTOR = 4;
export const SETTLE_PARALLEL = 8;
/** The most a draining CDP path waits for the provenance lookup before it keeps CDP (M2). */
export const PROVENANCE_TIMEOUT_MS = 500;

interface SendRow {
  user_op_hash: string;
  submitter: string;
  sponsored: boolean;
  calldata: string;
  valid_until: string;
  nonce: string;
  gas_limit: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  raw_tx: string;
  l1_fee_wei: string;
  cancelled: boolean;
  tx_hash: string;
  tx_hashes: string[];
  sent_at: string;
  status: 'submitted' | 'included' | 'failed';
  block_number: string | null;
  block_hash: string | null;
  settled: boolean;
  final: boolean;
  error_code: string | null;
}
const COLUMNS = `user_op_hash, submitter, sponsored, calldata, valid_until::text AS valid_until,
  nonce::text AS nonce, gas_limit::text AS gas_limit, max_fee_per_gas::text AS max_fee_per_gas,
  max_priority_fee_per_gas::text AS max_priority_fee_per_gas, raw_tx, l1_fee_wei::text AS l1_fee_wei,
  cancelled, tx_hash, tx_hashes, sent_at::text AS sent_at, status, block_number::text AS block_number,
  block_hash, settled, final, error_code`;

type Keystore = {
  withSigner<T>(keyRef: string, use: (signer: PrivateKeyAccount) => Promise<T>): Promise<T>;
};

export interface DirectBundlerDeps {
  db: Database;
  client: PublicClient;
  chainId: number;
  entryPoint: Address;
  /** 'on' sponsors; 'prepare' (or a missing paymaster) sends self-paid operations only. */
  mode: 'prepare' | 'on';
  /** The deployed paymaster (CITY_BASE_PAYMASTER_ADDRESS); null until it is deployed. */
  paymaster: Address | null;
  keystore: Keystore;
  signer: { keyRef: string; address: Address };
  submitter: { keyRef: string; address: Address };
  budget: Pick<
    ReturnType<typeof ownPaymasterBudget>,
    'reserve' | 'rekey' | 'markSentIn' | 'settleIn' | 'settleWorstIn' | 'exposeIn' | 'lapsedState'
  >;
  policy: { addresses: PolicyAddresses; ceilings?: GasCeilings; paused?: ReadonlySet<SponsorFlow> };
  /** Receipts of operations this module never sent (the CDP bundler's, before the switch). */
  fallback?: Pick<Bundler, 'receipt'>;
  now?: () => number;
  log?: (line: string) => void;
  /**
   * Whether send()/receipt() also look after open sends in the background (default true; the
   * cron does it regardless). Tests turn it off and call maintain() themselves.
   */
  autoMaintain?: boolean;
}

export type DirectBundler = Bundler & {
  /** Looks after open sends (rebroadcast, replace, cancel, receipts, settlement); for the cron. */
  maintain(limit?: number): Promise<number>;
  /**
   * An operation of ours that must NOT be first-sent now (draining): follows it when a send is
   * stored, otherwise refuses it, as never broadcast only when that is proven for the operation.
   */
  unsent(op: UserOperation<'0.6'>): Promise<Hex>;
  /** Whether sponsoring is possible right now (the fail-closed checks), as a code. */
  readiness(): Promise<
    'ready' | 'prepare' | 'no_paymaster' | 'signer_mismatch' | 'not_allowlisted' | 'unavailable'
  >;
};

const ceilMul = (value: bigint, num: bigint, den: bigint) => (value * num + den - 1n) / den;
const maxOf = (a: bigint, b: bigint) => (a > b ? a : b);
const minOf = (a: bigint, b: bigint) => (a < b ? a : b);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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

const ALREADY_KNOWN = /already known|known transaction|already imported|nonce too low/i;
function alreadyKnown(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    const e = current as { message?: unknown; details?: unknown; cause?: unknown };
    for (const text of [e.details, e.message])
      if (typeof text === 'string' && ALREADY_KNOWN.test(text)) return true;
    current = e.cause;
  }
  return false;
}

/**
 * Whether a failed estimateGas is a revert (not Base being unavailable), and the EntryPoint's AA
 * code when it is a FailedOp. Only the code is kept, never upstream text.
 */
export function handleOpsRevert(error: unknown): { reverted: boolean; aa: string | null } {
  let reverted = false;
  let data: Hex | null = null;
  let aa: string | null = null;
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
      if (typeof text === 'string') {
        if (/revert/i.test(text)) reverted = true;
        aa ??= /\bAA[1-9][0-9]\b/.exec(text)?.[0] ?? null;
      }
    const raw =
      typeof e.data === 'string'
        ? e.data
        : typeof (e.data as { data?: unknown } | null)?.data === 'string'
          ? (e.data as { data: string }).data
          : null;
    if (!data && raw && /^0x[0-9a-fA-F]{8,}$/.test(raw)) data = raw as Hex;
    current = e.cause;
  }
  if (data) {
    reverted = true;
    try {
      const decoded = decodeErrorResult({ abi: entryPointAbi, data });
      if (decoded.errorName === 'FailedOp')
        aa ??= /\bAA[1-9][0-9]\b/.exec(String(decoded.args?.[1] ?? ''))?.[0] ?? null;
    } catch {
      // not a FailedOp: the revert stands without a code
    }
  }
  return { reverted, aa };
}

/** Base's L1 data fee from an OP-stack receipt (bigint once formatted, hex when raw; 0 if absent). */
export function l1FeeOf(receipt: TransactionReceipt): bigint {
  const fee = (receipt as unknown as { l1Fee?: unknown }).l1Fee;
  if (typeof fee === 'bigint') return fee;
  if (typeof fee === 'string' && /^0x[0-9a-fA-F]+$/.test(fee)) return BigInt(fee);
  return 0n;
}

/**
 * A send that provably never left this server and never can through any other bundler (an
 * operation only ours may send, and ours holds no send for it): the caller may end it as never
 * broadcast (submit.ts: REFUSED_BEFORE_BROADCAST) instead of following it as ambiguous.
 * Recognized by its `neverBroadcast` marker.
 */
export class NeverBroadcastError extends BundlerError {
  readonly neverBroadcast = true as const;
}

/** A refusal to sponsor, as callers of the CDP bundler already know it (SponsorError). */
const refuse = (message: string, rejection: 'busy' | 'other' = 'other') =>
  new SponsorError(
    new BundlerError(
      'RPC_ERROR',
      `own paymaster: ${message}`,
      rejection,
      rejection === 'busy' ? -32005 : undefined,
    ),
  );

function toTuple(op: UserOperation<'0.6'>) {
  return {
    sender: op.sender,
    nonce: op.nonce,
    initCode: op.initCode ?? '0x',
    callData: op.callData,
    callGasLimit: op.callGasLimit,
    verificationGasLimit: op.verificationGasLimit,
    preVerificationGas: op.preVerificationGas,
    maxFeePerGas: op.maxFeePerGas,
    maxPriorityFeePerGas: op.maxPriorityFeePerGas,
    paymasterAndData: op.paymasterAndData ?? '0x',
    signature: op.signature,
  } as const;
}

/** A one-op handleOps as the submitter sends it (beneficiary: the submitter). */
const handleOpsData = (op: UserOperation<'0.6'>, beneficiary: Address) =>
  encodeFunctionData({
    abi: entryPointAbi,
    functionName: 'handleOps',
    args: [[toTuple(op)], beneficiary],
  });

/** The signed validUntil of our paymaster data (seconds), 0 for none. */
const validUntilOf = (op: UserOperation<'0.6'>) => {
  const data = op.paymasterAndData ?? '0x';
  return data.length === 2 + 194 * 2 ? Number(BigInt(`0x${data.slice(42, 54)}`)) : 0;
};

/** Error names a failure log may carry verbatim; anything else is logged as 'other'. */
const LOGGED_ERROR_NAMES = new Set([
  'BundlerError',
  'BudgetError',
  'ReservationConflict',
  'ReservationGone',
  'HttpRequestError',
  'TimeoutError',
  'RpcRequestError',
  'TransactionReceiptNotFoundError',
  'BlockNotFoundError',
  'AbortError',
  'TypeError',
  'Error',
]);

/**
 * Why an upkeep step failed, safe to log: an allowlisted error name, a code-shaped code, a numeric
 * RPC or HTTP code, and a database SQLSTATE. Never the message (an endpoint URL in it may carry a key).
 */
/**
 * Messages of our own fixed guard errors (budget and bundler): logged verbatim only on an exact
 * match, so no free text (and no endpoint URL) can ever reach the log through it.
 */
const KNOWN_MESSAGES = new Set([
  'Submitter key does not match.',
  'A cost is never negative.',
  'An exposure key is 32 bytes.',
  'An exposure costs more than 0.',
  'Overhead is never negative.',
  'userOpHash must be 32 bytes.',
  'validUntil must be whole seconds.',
  'A reservation costs more than 0.',
  'Reservation keys are 32 bytes.',
  'Spender key not found.',
]);

export function failureOf(error: unknown): string {
  const e = error as {
    name?: unknown;
    code?: unknown;
    rpcCode?: unknown;
    httpStatus?: unknown;
    status?: unknown;
    message?: unknown;
  } | null;
  const name = typeof e?.name === 'string' && LOGGED_ERROR_NAMES.has(e.name) ? e.name : 'other';
  const code =
    typeof e?.code === 'number' ||
    (typeof e?.code === 'string' && /^[A-Z0-9][A-Z0-9_]{1,39}$/.test(e.code))
      ? String(e.code)
      : '-';
  const rpc = typeof e?.rpcCode === 'number' ? String(e.rpcCode) : '-';
  const http =
    typeof e?.httpStatus === 'number'
      ? String(e.httpStatus)
      : typeof e?.status === 'number'
        ? String(e.status)
        : '-';
  const known =
    typeof e?.message === 'string' && KNOWN_MESSAGES.has(e.message) ? ` msg=${e.message}` : '';
  return `${name} code=${code} rpc=${rpc} http=${http}${known}`;
}

export function directBundler(deps: DirectBundlerDeps): DirectBundler {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const ceilings = deps.policy.ceilings ?? GAS_CEILINGS;
  const submitter = getAddress(deps.submitter.address);
  const submitterKey = submitter.toLowerCase();
  // Nonces, balances, fees and finality need the node's current head, never a shared cached one.
  const live = liveReads(deps.client);
  const opHash = (op: UserOperation<'0.6'>) =>
    getUserOperationHash({
      chainId: deps.chainId,
      entryPointAddress: deps.entryPoint,
      entryPointVersion: '0.6',
      userOperation: op,
    }).toLowerCase() as Hex;

  /** Twice the oracle's L1 data fee for exactly this unsigned transaction (as the facilitator). */
  const l1FeeFor = async (input: {
    nonce: number;
    to: Address;
    data: Hex;
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }) =>
    2n *
    (await deps.client.readContract({
      address: GAS_PRICE_ORACLE,
      abi: oracleAbi,
      functionName: 'getL1Fee',
      args: [
        serializeTransaction({
          type: 'eip1559',
          chainId: deps.chainId,
          value: 0n,
          ...input,
        }),
      ],
    }));

  // ---------------------------------------------------------------- fail-closed readiness
  let readyUntil = 0;
  async function readiness() {
    if (deps.mode !== 'on') return 'prepare' as const;
    if (!deps.paymaster) return 'no_paymaster' as const;
    if (now() < readyUntil) return 'ready' as const;
    try {
      // The signer key must decrypt (KEK present, not rotated away) and be the address we expect.
      const decrypted = await deps.keystore.withSigner(deps.signer.keyRef, async (a) => a.address);
      const [onChain, pending, allowed] = await Promise.all([
        live.readContract({
          address: deps.paymaster,
          abi: paymasterAbi,
          functionName: 'verifyingSigner',
        }),
        live.readContract({
          address: deps.paymaster,
          abi: paymasterAbi,
          functionName: 'pendingVerifyingSigner',
        }),
        live.readContract({
          address: deps.paymaster,
          abi: paymasterAbi,
          functionName: 'isBundlerAllowed',
          args: [submitter],
        }),
      ]);
      const zero = '0x0000000000000000000000000000000000000000';
      if (
        !same(decrypted, deps.signer.address) ||
        !same(onChain, deps.signer.address) ||
        !(same(pending, zero) || same(pending, deps.signer.address))
      ) {
        log('own paymaster: ALERT signer mismatch, sponsoring refused');
        return 'signer_mismatch' as const;
      }
      if (!allowed) return 'not_allowlisted' as const;
      readyUntil = now() + 60_000;
      return 'ready' as const;
    } catch {
      return 'unavailable' as const;
    }
  }

  /** Provenance: this bundler prepared it, so only this bundler sends it. */
  const prepared = (op: UserOperation<'0.6'>) =>
    deps.db.query(
      `INSERT INTO own_paymaster_prepared (user_op_hash, created_at) VALUES ($1, $2)
       ON CONFLICT (user_op_hash) DO NOTHING`,
      [opHash(op), now()],
    );

  // ---------------------------------------------------------------- prepare
  async function prepare(
    op: UserOperation<'0.6'>,
    options?: { sponsor?: boolean; intent?: SponsorIntent },
  ): Promise<UserOperation<'0.6'>> {
    const sponsor = options?.sponsor ?? true;
    let baseFee: bigint;
    let suggested: bigint;
    try {
      const [block, priority] = await Promise.all([
        live.getBlock(),
        live.estimateMaxPriorityFeePerGas(),
      ]);
      baseFee = block.baseFeePerGas ?? 0n;
      suggested = priority;
    } catch {
      throw new BundlerError('RPC_UNAVAILABLE', 'Base could not quote fees now.');
    }
    // A node's priority suggestion above our ceiling is only a suggestion: it is capped (Base
    // includes at ~0.001 gwei). Twice the base fee plus the tip, as CDP's bundlerFees. Fee fields on
    // the incoming operation are minimums (a replacement must outbid); only those, or a base fee
    // past the cap, refuse.
    const maxPriorityFeePerGas = maxOf(
      op.maxPriorityFeePerGas,
      minOf(suggested, ceilings.maxPriorityFeePerGas),
    );
    const maxFeePerGas = maxOf(op.maxFeePerGas, 2n * baseFee + maxPriorityFeePerGas);
    if (
      maxFeePerGas > ceilings.maxFeePerGas ||
      maxPriorityFeePerGas > ceilings.maxPriorityFeePerGas
    )
      throw new BundlerError('FEE_CAP_EXCEEDED', 'Network fees are above the configured cap.');

    const withInit = (op.initCode ?? '0x') !== '0x';
    let callGasLimit = ceilings.callGasLimit;
    if (!withInit) {
      // The account exists: its calls are simulated as the EntryPoint would make them. A call that
      // reverts here would fail on chain too, and is never sponsored.
      try {
        const used = await deps.client.estimateGas({
          account: deps.entryPoint,
          to: op.sender,
          data: op.callData,
        });
        callGasLimit = minOf(
          maxOf(ceilMul(used, 3n, 2n) + DIRECT_GAS.callMargin, DIRECT_GAS.callFloor),
          ceilings.callGasLimit,
        );
      } catch (error) {
        if (transientChainError(error) || !handleOpsRevert(error).reverted)
          throw new BundlerError('RPC_UNAVAILABLE', 'Base could not simulate the calls now.');
        throw refuse('the operation reverts in simulation.');
      }
    }
    const draft: UserOperation<'0.6'> = {
      ...op,
      callGasLimit,
      verificationGasLimit: withInit
        ? minOf(DIRECT_GAS.verificationWithInit, ceilings.verificationGasLimitWithInit)
        : minOf(DIRECT_GAS.verification, ceilings.verificationGasLimit),
      preVerificationGas: 0n,
      maxFeePerGas,
      maxPriorityFeePerGas,
      // The final length (194 bytes when sponsored), for preVerificationGas.
      paymasterAndData: sponsor ? `0x${'00'.repeat(194)}` : '0x',
      signature: '0x',
    };
    // preVerificationGas: intrinsic + calldata of the one-op bundle, plus Base's L1 data fee
    // turned into gas at the price the EntryPoint will repay.
    const bundle = handleOpsData({ ...draft, signature: `0x${'ff'.repeat(65)}` }, submitter);
    let l1Fee: bigint;
    try {
      l1Fee = await l1FeeFor({
        nonce: 0,
        to: deps.entryPoint,
        data: bundle,
        gas: 1_000_000n,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
    } catch {
      throw new BundlerError('RPC_UNAVAILABLE', 'Base could not quote fees now.');
    }
    const repaidPrice = maxOf(1n, minOf(maxFeePerGas, baseFee + maxPriorityFeePerGas));
    draft.preVerificationGas = minOf(
      DIRECT_GAS.preVerificationBase +
        16n * BigInt((bundle.length - 2) / 2) +
        ceilMul(l1Fee, 1n, repaidPrice),
      ceilings.preVerificationGas,
    );
    draft.paymasterAndData = '0x';
    if (!sponsor) {
      await prepared(draft);
      return draft;
    }

    // 1. The caller's intent, from its own records: sender, deployment, calls.
    const state = await readiness();
    if (state !== 'ready') throw refuse(`not sponsoring (${state}).`);
    const paymaster = deps.paymaster!;
    const intent = options?.intent;
    if (!intent) throw refuse('no intent: the calling flow did not say what it sponsors.');
    if (!same(op.sender, intent.sender))
      throw refuse('the operation is not for the sender its flow intended.');
    if (!same(op.initCode ?? '0x', intent.initCode))
      throw refuse('the operation does not deploy what its flow intended.');
    let expected: Hex;
    try {
      expected = await encodeAccountCalls(deps.client, intent.calls);
    } catch {
      throw new BundlerError('RPC_UNAVAILABLE', 'The calls could not be encoded now.');
    }
    if (!same(expected, op.callData))
      throw refuse('the operation is not the calls its flow intended.');

    // 2. The flow's policy, with the sender from the flow's records.
    try {
      checkSponsorship(draft, intent.flow, {
        addresses: deps.policy.addresses,
        expect: { sender: getAddress(intent.sender) },
        ceilings,
        ...(deps.policy.paused ? { paused: deps.policy.paused } : {}),
      });
    } catch (error) {
      if (error instanceof PolicyRefusal) {
        log(`own paymaster: policy refused ${intent.flow} (${error.reason})`);
        throw refuse(`policy refused (${error.reason}).`);
      }
      throw error;
    }

    // 3. The budget, BEFORE the signature: the worst case is reserved under the paymaster digest
    // (getHash binds the whole operation and every paymaster field; the signature over it is
    // deterministic, so it fixes the userOpHash the reservation is re-keyed to below).
    const at = Math.floor(now() / 1000);
    const fields: PaymasterFields = {
      validUntil: at + SPONSOR_VALIDITY_S,
      validAfter: 0,
      // Our own accounting id: the operation's sender and nonce (UserOperationSponsored's index).
      sponsorUUID:
        BigInt(
          keccak256(`${op.sender.toLowerCase()}${op.nonce.toString(16).padStart(64, '0')}` as Hex),
        ) &
        ((1n << 128n) - 1n),
    };
    const digest = paymasterHash(draft, { chainId: deps.chainId, paymaster, fields }).toLowerCase();
    const worst = worstCaseWei(draft);
    try {
      await deps.budget.reserve({
        userOpHash: digest,
        flow: intent.flow,
        maxCostWei: worst,
        validUntil: fields.validUntil,
      });
    } catch (error) {
      if (error instanceof BudgetError) {
        log(`own paymaster: budget refused ${intent.flow} (${error.reason})`);
        // Transient limits (hour, ceiling, protected reserve) say "not now", like a rate limit.
        throw refuse(`budget (${error.reason}).`, budgetTransient(error.reason) ? 'busy' : 'other');
      }
      throw error;
    }

    // 4. Signed, then the reservation follows the operation's own hash. A failure in between
    // leaves the digest's reservation to lapse at validUntil + margin; nothing was handed out.
    draft.paymasterAndData = await signPaymasterData(draft, {
      chainId: deps.chainId,
      paymaster,
      fields,
      sign: (hash) =>
        deps.keystore.withSigner(deps.signer.keyRef, (account) =>
          account.signMessage({ message: { raw: hash } }),
        ),
    });
    try {
      await deps.budget.rekey(digest, opHash(draft));
    } catch (error) {
      if (error instanceof ReservationGone) throw refuse('the reservation lapsed; prepare again.');
      throw error;
    }
    await prepared(draft);
    return { ...draft, signature: '0x' };
  }

  // ---------------------------------------------------------------- lane, signing, broadcast
  const lockLane = async (tx: Transaction, at: number) => {
    await tx.query(
      `INSERT INTO own_paymaster_lanes (chain_id, submitter, next_nonce, updated_at)
       VALUES ($1, $2, 0, $3) ON CONFLICT DO NOTHING`,
      [deps.chainId, submitterKey, at],
    );
    return (
      await tx.query<{ next_nonce: string }>(
        `SELECT next_nonce::text AS next_nonce FROM own_paymaster_lanes
         WHERE chain_id = $1 AND submitter = $2 FOR UPDATE`,
        [deps.chainId, submitterKey],
      )
    ).rows[0]!;
  };

  const signTx = (input: {
    nonce: bigint;
    to: Address;
    data: Hex;
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }) =>
    deps.keystore.withSigner(deps.submitter.keyRef, async (account) => {
      if (!same(account.address, submitter)) throw new Error('Submitter key does not match.');
      return account.signTransaction({
        type: 'eip1559',
        chainId: deps.chainId,
        nonce: Number(input.nonce),
        to: input.to,
        value: 0n,
        data: input.data,
        gas: input.gas,
        maxFeePerGas: input.maxFeePerGas,
        maxPriorityFeePerGas: input.maxPriorityFeePerGas,
      });
    });

  const broadcast = async (raw: Hex): Promise<boolean> => {
    try {
      await deps.client.sendRawTransaction({ serializedTransaction: raw });
      return true;
    } catch (error) {
      return alreadyKnown(error);
    }
  };

  /** One stored send; `lock` takes its row lock (inside a transaction) against other replicas. */
  const get = async (hash: string, tx?: Transaction, lock = false): Promise<SendRow | null> =>
    (
      await (tx ?? deps.db).query<SendRow>(
        `SELECT ${COLUMNS} FROM own_paymaster_sends WHERE user_op_hash = $1${lock ? ' FOR UPDATE' : ''}`,
        [hash.toLowerCase()],
      )
    ).rows[0] ?? null;

  /**
   * The flow a stored operation's exposure is counted under: its sponsorship's (or its exposure's)
   * own recorded flow, or null when no such record exists. Never a default: a missing record must
   * not grant the protected exit class; the caller refuses instead.
   */
  const flowOf = async (tx: Transaction, hash: string): Promise<SponsorFlow | null> =>
    (
      await tx.query<{ flow: SponsorFlow }>(
        'SELECT flow FROM own_paymaster_reservations WHERE user_op_hash = ANY($1::text[]) LIMIT 1',
        [[hash.toLowerCase(), exposureKey(hash)]],
      )
    ).rows[0]?.flow ?? null;

  /**
   * A self-paid operation (owner ops when not sponsored) brings no trusted purpose to this module:
   * its submitter exposure is ORDINARY work, within the hourly cap and the 0.15
   * ceiling, never the protected exit reserve.
   */
  const SELF_PAID_FLOW: SponsorFlow = 'ownerPay';

  /**
   * This call did not send it, but that alone does not prove the OPERATION was never sent: another
   * instance may have stored, broadcast and even settled it meanwhile, or may still be about to.
   * Only a sponsored operation gets here (validUntil and a lapsed reservation are sponsorship
   * facts). Never-sent is proven only by the reservation's state under the budget lock, after the
   * expiry sweep: 'expired' is final for sending (markSentIn moves only 'reserved' or 'sent', an
   * expired reservation is never revived, and a sponsored send is stored only together with that
   * move). Anything else stays ambiguous: follow it, never prepare again. That is 'reserved'
   * (another instance may yet send it), 'sent'/'settled' (somebody did), and no reservation at all
   * (a sponsorship we hand out always has one, and none is ever deleted, so this operation is not
   * one we can account for). The stored row is read after the state, so a competing send that
   * committed first is followed as stored.
   */
  async function neverSent(hash: Hex, op: UserOperation<'0.6'>): Promise<Hex> {
    const status = await deps.budget.lapsedState(hash);
    if (await get(hash)) return send(op);
    if (status === 'reserved')
      throw new BundlerError(
        'RPC_UNAVAILABLE',
        'eth_sendUserOperation: the sponsorship is still open; ask again shortly, do not prepare again.',
      );
    if (status === undefined)
      throw new BundlerError(
        'RPC_ERROR',
        'eth_sendUserOperation: no reservation for this sponsorship; do not prepare again.',
        'other',
      );
    if (status !== 'expired')
      throw new BundlerError(
        'RPC_ERROR',
        'eth_sendUserOperation: the sponsorship was used elsewhere; follow it, do not prepare again.',
        'other',
      );
    throw new NeverBroadcastError(
      'RPC_ERROR',
      'eth_sendUserOperation: the sponsorship lapsed; prepare it again.',
      'other',
    );
  }

  /**
   * Draining: a draft of ours is never first-sent here, yet an older deployment still taking new
   * work may send it meanwhile. A sponsored draft gets the same locked proof as above (still open
   * until its reservation expires). A self-paid draft has no reservation and no validUntil, so
   * nothing proves it never left: ambiguous, settled by the account nonce and its receipt.
   */
  async function unsent(op: UserOperation<'0.6'>): Promise<Hex> {
    const hash = opHash(op);
    if ((op.paymasterAndData ?? '0x') !== '0x') return neverSent(hash, op);
    if (await get(hash)) return send(op);
    throw new BundlerError(
      'RPC_ERROR',
      'eth_sendUserOperation: draining; an older deployment may still send this draft, do not prepare again.',
      'other',
    );
  }

  async function send(op: UserOperation<'0.6'>): Promise<Hex> {
    void maintainSoon();
    const hash = opHash(op);
    const stored = await get(hash);
    if (stored) {
      // Never signed again: rebroadcast as stored, replaced or cancelled at the same nonce.
      const row = await refresh(stored);
      if (row.status === 'failed')
        throw new BundlerError(
          'RPC_ERROR',
          `eth_sendUserOperation: the stored transaction failed (${row.error_code ?? 'unknown'}).`,
          'other',
        );
      return hash;
    }
    const data = (op.paymasterAndData ?? '0x').toLowerCase();
    const sponsored = data !== '0x';
    if (sponsored && !(deps.paymaster && data.startsWith(deps.paymaster.toLowerCase())))
      throw new BundlerError('RPC_ERROR', 'eth_sendUserOperation: not our sponsorship.', 'other');

    const until = validUntilOf(op);
    if (until !== 0 && Math.floor(now() / 1000) > until - VALIDITY_MARGIN_S) {
      log(`own bundler: ${hash} too close to its validUntil, not sent`);
      return neverSent(hash, op);
    }
    const calldata = handleOpsData(op, submitter);
    // Simulated first: a revert sends nothing, takes no nonce and moves no reservation.
    let gas: bigint;
    try {
      gas = await deps.client.estimateGas({
        account: submitter,
        to: deps.entryPoint,
        data: calldata,
      });
    } catch (error) {
      const revert = handleOpsRevert(error);
      if (!revert.reverted || transientChainError(error))
        throw new BundlerError(
          'RPC_UNAVAILABLE',
          'eth_sendUserOperation: Base could not simulate now.',
        );
      log(`own bundler: ${hash} simulation reverted${revert.aa ? ` ${revert.aa}` : ''}, not sent`);
      if (revert.aa === 'AA25')
        throw new BundlerError('NONCE_CONSUMED', 'eth_sendUserOperation: nonce already used.');
      throw new BundlerError(
        'RPC_ERROR',
        `eth_sendUserOperation: bundler rejected the request (simulation${revert.aa ? `, ${revert.aa}` : ''}).`,
        'other',
      );
    }
    const gasLimit = ceilMul(gas, 13n, 10n);
    if (gasLimit > DIRECT_GAS.maxTxGas)
      throw new BundlerError(
        'RPC_ERROR',
        'eth_sendUserOperation: gas above the bundle limit.',
        'other',
      );
    // The bundle pays the operation's own prices: the EntryPoint pays the submitter back at them.
    const fees = { maxFeePerGas: op.maxFeePerGas, maxPriorityFeePerGas: op.maxPriorityFeePerGas };
    if (fees.maxFeePerGas > ceilings.maxFeePerGas)
      throw new BundlerError('FEE_CAP_EXCEEDED', 'Network fees are above the configured cap.');

    let pending: number;
    let balance: bigint;
    let l1Fee: bigint;
    try {
      [pending, balance] = await Promise.all([
        live.getTransactionCount({ address: submitter, blockTag: 'pending' }),
        live.getBalance({ address: submitter }),
      ]);
      l1Fee = await l1FeeFor({
        nonce: pending,
        to: deps.entryPoint,
        data: calldata,
        gas: gasLimit,
        ...fees,
      });
    } catch {
      throw new BundlerError(
        'RPC_UNAVAILABLE',
        'eth_sendUserOperation: Base could not answer now.',
      );
    }
    if (balance < gasLimit * fees.maxFeePerGas + l1Fee + SUBMITTER_RESERVE_WEI) {
      log('own bundler: ALERT submitter low on gas funds, not sent');
      throw new BundlerError(
        'RPC_UNAVAILABLE',
        'eth_sendUserOperation: submitter low on gas funds.',
      );
    }
    // The submitter's own exposure (no repayment assumed): the whole outer cost.
    const exposure = gasLimit * fees.maxFeePerGas + l1Fee;

    let gone = false;
    let refused: BudgetError | null = null;
    let row: SendRow | null = null;
    try {
      row = await deps.db.transaction(async (tx) => {
        const at = now();
        // Budget lock first (markSentIn, exposeIn), lane lock second: the one lock order here.
        if (sponsored) await deps.budget.markSentIn(tx, hash);
        await deps.budget.exposeIn(tx, {
          key: exposureKey(hash),
          flow: sponsored
            ? ((await flowOf(tx, hash)) ??
              (() => {
                // markSentIn just moved this very reservation: its record cannot be missing.
                throw new ReservationGone();
              })())
            : SELF_PAID_FLOW,
          maxCostWei: exposure,
        });
        const lane = await lockLane(tx, at);
        if (await get(hash, tx)) return null; // another instance stored it meanwhile
        const nonce = maxOf(BigInt(lane.next_nonce), BigInt(pending));
        const raw = await signTx({
          nonce,
          to: deps.entryPoint,
          data: calldata,
          gas: gasLimit,
          ...fees,
        });
        await tx.query(
          'UPDATE own_paymaster_lanes SET next_nonce = $3, updated_at = $4 WHERE chain_id = $1 AND submitter = $2',
          [deps.chainId, submitterKey, (nonce + 1n).toString(10), at],
        );
        return (
          await tx.query<SendRow>(
            `INSERT INTO own_paymaster_sends (user_op_hash, chain_id, submitter, sponsored, calldata,
               valid_until, nonce, gas_limit, max_fee_per_gas, max_priority_fee_per_gas, raw_tx,
               l1_fee_wei, tx_hash, tx_hashes, sent_at, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, ARRAY[$13]::text[], $14,
               'submitted', $14, $14)
             RETURNING ${COLUMNS}`,
            [
              hash,
              deps.chainId,
              submitterKey,
              sponsored,
              calldata,
              validUntilOf(op),
              nonce.toString(10),
              gasLimit.toString(10),
              fees.maxFeePerGas.toString(10),
              fees.maxPriorityFeePerGas.toString(10),
              raw,
              l1Fee.toString(10),
              keccak256(raw),
              at,
            ],
          )
        ).rows[0]!;
      });
    } catch (error) {
      if (error instanceof ReservationGone) gone = true;
      else if (error instanceof BudgetError) refused = error;
      else throw error;
    }
    if (gone) {
      log(`own bundler: ${hash} reservation not open, not sent by this call`);
      return neverSent(hash, op);
    }
    if (refused) {
      const reason = (refused as BudgetError).reason;
      log(`own bundler: ${hash} submitter exposure refused (${reason}), not signed`);
      throw new BundlerError(
        'RPC_ERROR',
        `eth_sendUserOperation: budget (${reason}).`,
        budgetTransient(reason) ? 'busy' : 'other',
        budgetTransient(reason) ? -32005 : undefined,
      );
    }
    if (!row) {
      await refresh((await get(hash))!);
      return hash;
    }
    if (await broadcast(row.raw_tx as Hex)) {
      log(`own bundler: ${hash} sent nonce ${row.nonce}`);
      return hash;
    }
    log(`own bundler: ${hash} broadcast failed, stored for rebroadcast`);
    throw new BundlerError('RPC_UNAVAILABLE', 'eth_sendUserOperation: broadcast failed; stored.');
  }

  // ---------------------------------------------------------------- follow-up
  async function anyReceipt(row: SendRow): Promise<TransactionReceipt | null> {
    for (const hash of [...row.tx_hashes].reverse()) {
      try {
        return await deps.client.getTransactionReceipt({ hash: hash as Hex });
      } catch (error) {
        if (!notFound(error, TransactionReceiptNotFoundError)) throw error;
      }
    }
    return null;
  }

  /** The operation's event in a receipt (one op per bundle), or null. */
  const eventOf = (receipt: TransactionReceipt, hash: string) =>
    parseEventLogs({ abi: userOperationEvent, logs: receipt.logs }).find(
      (log) => same(log.args.userOpHash, hash) && same(log.address, deps.entryPoint),
    ) ?? null;

  /**
   * Records the receipt a send now has (its block, and its outcome code), under the send row's
   * lock. Nothing is settled here: until the receipt is final both reservations keep
   * their worst case, so headroom is never released early and a reorg cannot leave a deficit.
   */
  async function record(row: SendRow, receipt: TransactionReceipt): Promise<SendRow> {
    const event = receipt.status === 'success' ? eventOf(receipt, row.user_op_hash) : null;
    return deps.db.transaction(async (tx) => {
      const current = await get(row.user_op_hash, tx, true);
      if (!current || current.final) return current ?? row;
      if (current.status !== 'submitted' && current.block_hash === receipt.blockHash.toLowerCase())
        return current;
      return (
        await tx.query<SendRow>(
          `UPDATE own_paymaster_sends SET status = 'included', tx_hash = $2, block_number = $3,
             block_hash = $4, error_code = $5, updated_at = $6
           WHERE user_op_hash = $1 RETURNING ${COLUMNS}`,
          [
            row.user_op_hash,
            receipt.transactionHash.toLowerCase(),
            receipt.blockNumber.toString(10),
            receipt.blockHash.toLowerCase(),
            event
              ? null
              : current.cancelled && receipt.to && same(receipt.to, submitter)
                ? 'CANCELLED'
                : 'REVERTED',
            now(),
          ],
        )
      ).rows[0]!;
    });
  }

  /**
   * A final receipt (at or below Base's finalized block): both reservations settle once, by it,
   * and the row is final. The deposit paid actualGasCost (0 when handleOps reverted or a cancel
   * was mined); the submitter's exposure settles at its measured overhead (L2 gas + Base's L1
   * data fee - the EntryPoint's repayment). A final failure becomes 'failed'.
   */
  async function finalize(row: SendRow, receipt: TransactionReceipt): Promise<SendRow> {
    const event = receipt.status === 'success' ? eventOf(receipt, row.user_op_hash) : null;
    return deps.db.transaction(async (tx) => {
      const current = await get(row.user_op_hash, tx, true);
      if (!current || current.final) return current ?? row;
      if (current.block_hash !== receipt.blockHash.toLowerCase()) return current;
      if (!current.settled) {
        if (current.sponsored)
          await deps.budget.settleIn(
            tx,
            row.user_op_hash,
            event ? event.args.actualGasCost : 0n,
            receipt.blockNumber,
          );
        const paid = receipt.gasUsed * receipt.effectiveGasPrice + l1FeeOf(receipt);
        const repaid = event ? event.args.actualGasCost : 0n;
        await deps.budget.settleIn(
          tx,
          exposureKey(row.user_op_hash),
          paid > repaid ? paid - repaid : 0n,
          receipt.blockNumber,
        );
      }
      return (
        await tx.query<SendRow>(
          `UPDATE own_paymaster_sends SET status = $2, settled = true, final = true, updated_at = $3
           WHERE user_op_hash = $1 RETURNING ${COLUMNS}`,
          [row.user_op_hash, event ? 'included' : 'failed', now()],
        )
      ).rows[0]!;
    });
  }

  /** The next fees at this nonce: +30% on both, within the ceilings; null at the ceiling. */
  const bumped = (row: SendRow) => {
    const oldMax = BigInt(row.max_fee_per_gas);
    const oldPriority = BigInt(row.max_priority_fee_per_gas);
    const maxPriorityFeePerGas = minOf(
      ceilMul(oldPriority, 13n, 10n),
      ceilings.maxPriorityFeePerGas,
    );
    const maxFeePerGas = minOf(
      maxOf(ceilMul(oldMax, 13n, 10n), maxPriorityFeePerGas),
      ceilings.maxFeePerGas,
    );
    // A replacement must raise both fees; at the ceiling there is nothing left to raise.
    if (maxFeePerGas <= oldMax || maxPriorityFeePerGas <= oldPriority) return null;
    return { maxFeePerGas, maxPriorityFeePerGas };
  };

  /**
   * A new transaction at the stored nonce, signed and stored before it is broadcast: the same
   * handleOps at higher fees (`cancel` false), or a zero-value transfer to the submitter itself
   * (`cancel` true) once the operation can no longer succeed. The exposure is raised BEFORE the
   * signature; refused, nothing is signed and the row stays as it is.
   */
  async function resend(row: SendRow, cancel: boolean): Promise<SendRow> {
    const fees = bumped(row);
    if (!fees) {
      log(`own bundler: ALERT ${row.user_op_hash} fee ceiling reached, stays pending`);
      return row;
    }
    const to = cancel ? submitter : deps.entryPoint;
    const data = cancel ? '0x' : (row.calldata as Hex);
    const gas = cancel ? DIRECT_GAS.cancel : BigInt(row.gas_limit);
    const l1Fee = cancel ? BigInt(row.l1_fee_wei) : ceilMul(BigInt(row.l1_fee_wei), 13n, 10n);
    const exposure = gas * fees.maxFeePerGas + l1Fee;
    // The submitter must still hold this transaction's worst case.
    let balance: bigint;
    try {
      balance = await live.getBalance({ address: submitter });
    } catch {
      return row;
    }
    if (balance < exposure + SUBMITTER_RESERVE_WEI) {
      log(`own bundler: ALERT ${row.user_op_hash} submitter low on gas funds, not re-signed`);
      return row;
    }
    let raw: Hex | null = null;
    let refused: BudgetError | null = null;
    let unaccounted = false;
    const rows = await deps.db.transaction(async (tx) => {
      const at = now();
      const flow = await flowOf(tx, row.user_op_hash);
      if (!flow) {
        // No accounting record to classify it by: nothing is signed.
        unaccounted = true;
        return [] as SendRow[];
      }
      try {
        await deps.budget.exposeIn(tx, {
          key: exposureKey(row.user_op_hash),
          flow,
          maxCostWei: exposure,
        });
      } catch (error) {
        if (!(error instanceof BudgetError)) throw error;
        refused = error;
        return [] as SendRow[];
      }
      await lockLane(tx, at);
      const current = await get(row.user_op_hash, tx, true);
      if (!current || current.sent_at !== row.sent_at || current.status !== 'submitted')
        return [] as SendRow[];
      raw = await signTx({ nonce: BigInt(row.nonce), to, data, gas, ...fees });
      const hash = keccak256(raw);
      return (
        await tx.query<SendRow>(
          `UPDATE own_paymaster_sends SET raw_tx = $3, tx_hash = $4, tx_hashes = array_append(tx_hashes, $4),
             max_fee_per_gas = $5, max_priority_fee_per_gas = $6, sent_at = $7, updated_at = $7,
             cancelled = cancelled OR $8
           WHERE user_op_hash = $1 AND sent_at = $2 RETURNING ${COLUMNS}`,
          [
            row.user_op_hash,
            row.sent_at,
            raw,
            hash,
            fees.maxFeePerGas.toString(10),
            fees.maxPriorityFeePerGas.toString(10),
            at,
            cancel,
          ],
        )
      ).rows;
    });
    if (unaccounted) {
      log(`own bundler: ALERT ${row.user_op_hash} has no accounting record, nothing signed`);
      return row;
    }
    if (refused) {
      const reason = (refused as BudgetError).reason;
      log(
        `own bundler: ALERT ${row.user_op_hash} ${cancel ? 'cancel' : 'replacement'} refused (${reason}), stays pending`,
      );
      return row;
    }
    const changed = rows[0];
    if (!changed || !raw) return (await get(row.user_op_hash)) ?? row;
    log(
      `own bundler: ${row.user_op_hash} ${cancel ? 'cancelled' : 'replaced'} (attempt ${changed.tx_hashes.length})`,
    );
    await broadcast(raw);
    return changed;
  }

  /** Whether the stored operation can still succeed now (its handleOps simulates). */
  async function stillValid(row: SendRow): Promise<boolean | null> {
    if (
      row.valid_until !== '0' &&
      Math.floor(now() / 1000) > Number(row.valid_until) - VALIDITY_MARGIN_S
    )
      return false;
    try {
      await deps.client.estimateGas({
        account: submitter,
        to: deps.entryPoint,
        data: row.calldata as Hex,
      });
      return true;
    } catch (error) {
      if (transientChainError(error) || !handleOpsRevert(error).reverted) return null;
      return false;
    }
  }

  /** Brings one stored send up to date from Base. Throws on RPC failures. */
  /** Base's finalized height now (one read per maintain run). */
  const finalizedHeight = async () => (await live.getBlock({ blockTag: 'finalized' })).number;

  async function refresh(row: SendRow, finalizedNow?: bigint | null): Promise<SendRow> {
    // Every row is followed until its outcome is final: a receipt at or
    // below Base's finalized block. Only then does it settle.
    if (row.final) return row;
    const receipt = await anyReceipt(row);
    if (receipt) {
      let current = row;
      if (row.status === 'submitted' || !same(row.block_hash ?? '', receipt.blockHash))
        current = await record(row, receipt);
      const finalized = finalizedNow === undefined ? await finalizedHeight() : finalizedNow;
      if (finalized !== null && receipt.blockNumber <= finalized) {
        // Final only if the block at that height IS the receipt's block: the
        // receipt and the finalized height may come from different nodes.
        const atHeight = await live.getBlock({ blockNumber: receipt.blockNumber });
        if (atHeight.hash && same(atHeight.hash, receipt.blockHash))
          current = await finalize(current, receipt);
      }
      return current;
    }
    if (row.status !== 'submitted') {
      // Its receipt is gone (a reorg) before it was final: nothing was settled, so nothing is
      // reopened; it is followed again (rebroadcast exactly as stored below).
      log(`own bundler: ${row.user_op_hash} receipt orphaned before finality, followed again`);
      row =
        (
          await deps.db.query<SendRow>(
            `UPDATE own_paymaster_sends SET status = 'submitted', block_number = NULL, block_hash = NULL,
               error_code = NULL, updated_at = $2
             WHERE user_op_hash = $1 AND status = 'included' AND NOT final RETURNING ${COLUMNS}`,
            [row.user_op_hash, now()],
          )
        ).rows[0] ?? row;
    }
    const mined = await live.getTransactionCount({ address: submitter, blockTag: 'latest' });
    if (BigInt(mined) > BigInt(row.nonce)) {
      // Our nonce is used but none of our hashes has a receipt (yet): only finalized evidence ends
      // it. Then something we never stored used our key (ALERT): both reservations settle at their
      // worst case (never hidden as free), and the row is final.
      const finalized = await live.getTransactionCount({
        address: submitter,
        blockTag: 'finalized',
      });
      if (BigInt(finalized) > BigInt(row.nonce) && !(await anyReceipt(row))) {
        log(`own bundler: ALERT ${row.user_op_hash} nonce consumed without our receipt`);
        const block = await live.getBlockNumber();
        return deps.db.transaction(async (tx) => {
          const current = await get(row.user_op_hash, tx, true);
          if (!current || current.status !== 'submitted') return current ?? row;
          if (current.sponsored) await deps.budget.settleWorstIn(tx, row.user_op_hash, block);
          await deps.budget.settleWorstIn(tx, exposureKey(row.user_op_hash), block);
          return (
            await tx.query<SendRow>(
              `UPDATE own_paymaster_sends SET status = 'failed', settled = true, final = true, error_code = 'NONCE_CONSUMED',
                 updated_at = $2 WHERE user_op_hash = $1 RETURNING ${COLUMNS}`,
              [row.user_op_hash, now()],
            )
          ).rows[0]!;
        });
      }
      return row;
    }
    // Not mined. One that can no longer succeed is cancelled at its nonce (an expired sponsorship
    // or a now-reverting operation would revert at our cost); one that is only slow
    // is replaced at higher fees, at most MAX_REPLACEMENTS times.
    // Only the lane head is bumped: a later nonce cannot be mined before it, and
    // bumping it would only add exposure. A cancellation applies at any nonce: an operation that can
    // no longer succeed must not land right behind the head and revert at our cost. Past
    // MAX_REPLACEMENTS bumps the head is cancelled too (a self-paid one has no validUntil to end
    // it), and a cancel is itself bumped at most twice; past that it is rebroadcast as stored.
    const head = BigInt(mined) === BigInt(row.nonce);
    const stuck = now() - Number(row.sent_at) >= STUCK_MS;
    const bumps = row.tx_hashes.length - 1;
    if (!row.cancelled && (stuck || row.valid_until !== '0')) {
      const valid = await stillValid(row);
      if (valid === false) return resend(row, true);
      if (valid && stuck && head) return resend(row, bumps >= MAX_REPLACEMENTS);
    } else if (row.cancelled && stuck && head && bumps < MAX_REPLACEMENTS + 3) {
      return resend(row, true);
    }
    // Otherwise (or past every bound): the lane head stays alive, rebroadcast
    // exactly as stored whenever the node does not know it.
    try {
      await deps.client.getTransaction({ hash: row.tx_hash as Hex });
      return row;
    } catch (error) {
      if (!notFound(error, TransactionNotFoundError)) throw error;
    }
    const sent = await broadcast(row.raw_tx as Hex);
    log(`own bundler: ${row.user_op_hash} rebroadcast ${sent ? 'sent' : 'failed'}`);
    return row;
  }

  async function receipt(userOpHash: Hex): Promise<BundlerReceipt | null> {
    void maintainSoon();
    const row = await get(userOpHash);
    if (!row) return deps.fallback ? deps.fallback.receipt(userOpHash) : null;
    const current = await refresh(row);
    if (current.status !== 'included') return null;
    const txReceipt = await deps.client.getTransactionReceipt({ hash: current.tx_hash as Hex });
    const event = eventOf(txReceipt, userOpHash);
    if (!event) return null;
    return {
      success: event.args.success,
      txHash: txReceipt.transactionHash,
      blockNumber: txReceipt.blockNumber,
      actualGasUsed: event.args.actualGasUsed,
      actualGasCost: event.args.actualGasCost,
    };
  }

  /** Open sends, lane head first: rebroadcast, replace, cancel, record receipts and settle. */
  /**
   * One upkeep run, in three bounded passes, so included rows waiting for
   * finality (15-30 min of them at fleet pace) can never crowd out the lane:
   *   1. the unmined sends, lane head first: rebroadcast, bump, cancel, first receipts;
   *   2. included rows at or below the finalized height (read once): settle them;
   *   3. a few included rows above it, least recently checked first: is their receipt still there
   *      (a reorg sends them back to 1)? Each check touches updated_at, so all rotate.
   */
  async function maintain(limit = 50): Promise<number> {
    let done = 0;
    /**
     * Rows one after another (the lane, whose order matters), or up to `parallel` at a time
     * (settlement and orphan checks: independent rows, each under its own row lock), so
     * finality settlement keeps pace with the fleet.
     */
    const run = async (rows: SendRow[], finalizedNow?: bigint | null, parallel = 1) => {
      let next = 0;
      const worker = async () => {
        while (next < rows.length) {
          const row = rows[next++]!;
          try {
            await refresh(row, finalizedNow);
            done++;
          } catch (error) {
            log(
              `own bundler: maintain ${row.user_op_hash} failed (${failureOf(error)}), next time`,
            );
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(parallel, rows.length) }, worker));
    };
    const pending = await deps.db.query<SendRow>(
      `SELECT ${COLUMNS} FROM own_paymaster_sends
       WHERE chain_id = $1 AND submitter = $2 AND status = 'submitted' AND NOT final
       ORDER BY nonce LIMIT $3`,
      [deps.chainId, submitterKey, limit],
    );
    let finalizedNow: bigint | null = null;
    try {
      finalizedNow = await finalizedHeight();
    } catch {
      finalizedNow = null;
    }
    await run(pending.rows, finalizedNow);
    if (finalizedNow === null) return done;
    const settleable = await deps.db.query<SendRow>(
      `SELECT ${COLUMNS} FROM own_paymaster_sends
       WHERE chain_id = $1 AND submitter = $2 AND status <> 'submitted' AND NOT final
         AND block_number <= $3
       ORDER BY block_number LIMIT $4`,
      [deps.chainId, submitterKey, finalizedNow.toString(10), limit * SETTLE_FACTOR],
    );
    await run(settleable.rows, finalizedNow, SETTLE_PARALLEL);
    const waiting = await deps.db.query<SendRow>(
      `UPDATE own_paymaster_sends SET updated_at = $5
       WHERE user_op_hash IN (
         SELECT user_op_hash FROM own_paymaster_sends
         WHERE chain_id = $1 AND submitter = $2 AND status <> 'submitted' AND NOT final
           AND block_number > $3
         ORDER BY updated_at LIMIT $4)
       RETURNING ${COLUMNS}`,
      [
        deps.chainId,
        submitterKey,
        finalizedNow.toString(10),
        Math.max(1, Math.floor(limit / 5)),
        now(),
      ],
    );
    await run(waiting.rows, finalizedNow, SETTLE_PARALLEL);
    return done;
  }

  let maintainedAt = 0;
  /** At most once per MAINTAIN_EVERY_MS per instance; never blocks or fails the caller. */
  async function maintainSoon() {
    if (deps.autoMaintain === false) return;
    if (now() - maintainedAt < MAINTAIN_EVERY_MS) return;
    maintainedAt = now();
    try {
      await maintain(5);
    } catch (error) {
      log(`own bundler: maintain failed (${failureOf(error)})`);
    }
  }

  return { prepare, send, receipt, maintain, unsent, readiness };
}

/** The upkeep cron (CRON_SECRET; vercel.json, every minute). */
export const OWN_BUNDLER_MAINTAIN_PATH = '/api/cron/own-paymaster-maintain';

/**
 * GET /api/cron/own-paymaster-maintain: 404 without the cron secret; { state: 'off' } unless our
 * bundler is in effect (and when the runtime cannot be built); { state: 'on', looked } after one
 * maintain() run; 503 { state: 'unavailable' } when that run failed.
 */
export interface OwnBundlerUpkeep {
  /** 'direct': ours takes new work; 'drain': it only finishes what it already holds. */
  mode: 'direct' | 'drain';
  maintain(limit?: number): Promise<number>;
  open(): Promise<number>;
}

export function registerOwnBundlerMaintainRoute(
  app: FastifyInstance,
  deps: {
    cronSecret: string | undefined;
    upkeep: () => Promise<OwnBundlerUpkeep | undefined>;
  },
): void {
  app.get(OWN_BUNDLER_MAINTAIN_PATH, async (request, reply) => {
    if (!cronAuthorized(request.headers.authorization, deps.cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    let upkeep: OwnBundlerUpkeep | undefined;
    try {
      upkeep = await deps.upkeep();
    } catch {
      upkeep = undefined;
    }
    if (!upkeep) return { state: 'off' };
    try {
      if (upkeep.mode === 'direct') return { state: 'on', looked: await upkeep.maintain(50) };
      // Drain: until every send of ours is final, then off.
      if ((await upkeep.open()) === 0) return { state: 'off' };
      const looked = await upkeep.maintain(50);
      return { state: 'drain', open: await upkeep.open(), looked };
    } catch {
      return reply.code(503).send({ state: 'unavailable' });
    }
  });
}

// The switch lives beside the mode setting (own-paymaster-keys.ts), where the public route reads it.
export { BUNDLER_SETTING, bundlerChoice } from './own-paymaster-keys.js';

const depositAbi = parseAbi(['function balanceOf(address account) view returns (uint256)']);

/**
 * Our bundler built on first use (the keys are read from the database), routed by provenance
 *:
 *   - an operation that is ours (this bundler prepared or stored it, or it carries our
 *     sponsorship) goes to ours only; while ours cannot be built it fails as "not reachable" and is
 *     NEVER forwarded to another bundler (our paymaster allows only our submitter, and its pending
 *     transactions keep their nonce and reconciliation here);
 *   - any other operation (prepared by the CDP bundler, before the switch or during a fallback)
 *     goes to the CDP bundler, never silently to ours;
 *   - a NEW preparation uses ours, or the CDP bundler while ours cannot be built (never an
 *     outage), logged as cdp_fallback and tried again after 60 s.
 */
export function lazyBundler(input: {
  make: () => Promise<DirectBundler>;
  fallback?: Bundler;
  log?: (line: string) => void;
  /** Where provenance is read, and how a userOpHash is computed. */
  route: {
    db: Pick<Database, 'query'>;
    chainId: number;
    entryPoint: Address;
    paymaster: Address | null;
  };
  now?: () => number;
  /**
   * Where NEW operations go: 'direct' (ours, the CDP fallback while ours cannot be built) or 'cdp'
   * (DRAIN: CITY_BASE_BUNDLER is not direct, yet ours still finishes what it already
   * holds: its existing operations keep their route, nonces, budget and cancellation bounds, and
   * nothing new is prepared, signed or sponsored by it).
   */
  newWork?: 'direct' | 'cdp';
}): DirectBundler & {
  effective(): 'direct' | 'cdp_fallback' | 'unknown';
  /** Sends of ours not yet final (what a drain still has to finish). */
  open(): Promise<number>;
  /** A bundler whose new work is `cdp`, and whose operations that are ours stay ours. */
  routes(cdp: Bundler): Bundler;
} {
  const { make, fallback, route } = input;
  const newWork = input.newWork ?? 'direct';
  const log = input.log ?? (() => {});
  const now = input.now ?? Date.now;
  let made: Promise<DirectBundler> | null = null;
  let failedAt = -Infinity;
  let state: 'direct' | 'cdp_fallback' | 'unknown' = 'unknown';
  const get = async (): Promise<DirectBundler | null> => {
    if (!made && fallback && now() - failedAt < 60_000) return null;
    made ??= make();
    try {
      const built = await made;
      state = 'direct';
      return built;
    } catch (error) {
      made = null;
      failedAt = now();
      if (fallback) {
        state = 'cdp_fallback';
        log('own bundler: ALERT could not be built, CDP used for new operations (cdp_fallback)');
        return null;
      }
      throw error instanceof BundlerError
        ? error
        : new BundlerError('RPC_UNAVAILABLE', 'own bundler: not available now.');
    }
  };
  /** Ours, or a refusal: an operation that is ours never goes anywhere else. */
  const ours = async () => {
    const built = await get();
    if (!built)
      throw new BundlerError(
        'RPC_UNAVAILABLE',
        'own bundler: not available now; this operation is only sent by it.',
      );
    return built;
  };
  const owned = async (hash: string) =>
    (
      await route.db.query(
        `SELECT 1 FROM own_paymaster_prepared WHERE user_op_hash = $1
         UNION ALL SELECT 1 FROM own_paymaster_sends WHERE user_op_hash = $1 LIMIT 1`,
        [hash.toLowerCase()],
      )
    ).rows.length > 0;
  const hashOf = (op: UserOperation<'0.6'>) =>
    getUserOperationHash({
      chainId: route.chainId,
      entryPointAddress: route.entryPoint,
      entryPointVersion: '0.6',
      userOperation: op,
    });
  const sponsoredByUs = (op: UserOperation<'0.6'>) =>
    route.paymaster !== null &&
    (op.paymasterAndData ?? '0x').toLowerCase().startsWith(route.paymaster.toLowerCase());
  const other = () => fallback ?? null;
  const open = async () =>
    Number(
      (
        await route.db.query<{ n: string }>(
          // This chain's sends from our provisioned submitters only: a
          // stray row of any other address can never hold the cron in 'drain'.
          `SELECT count(*)::text AS n FROM own_paymaster_sends
           WHERE chain_id = $1 AND NOT final
             AND submitter IN (SELECT lower(address) FROM own_paymaster_keys
                               WHERE purpose IN ('paymaster_submitter_1', 'paymaster_submitter_2'))`,
          [route.chainId],
        )
      ).rows[0]?.n ?? '0',
    );
  /**
   * The provenance lookup, bounded (PROVENANCE_TIMEOUT_MS) and FAIL-CLOSED: when the database
   * cannot say whose an operation is, it goes NOWHERE and the
   * caller gets a retriable "not reachable" (liabilities stay held). Unknown provenance never
   * authorizes CDP: our self-paid drafts and sends carry no marker of ours. What is known without
   * the database still routes: our paymaster to ours, a pinned CDP sponsor to CDP (knownCdp).
   */
  const lookup = async (query: () => Promise<boolean>): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        query(),
        new Promise<boolean>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), PROVENANCE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      log('own bundler: provenance unknown (database), refused for a retry');
      throw new BundlerError(
        'RPC_UNAVAILABLE',
        'own bundler: whose operation this is cannot be read now; retry.',
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  /**
   * An operation sponsored by a pinned sponsor other than ours (Coinbase's) was prepared by CDP:
   * established from its own data, so it goes to CDP without the database.
   */
  const knownCdp = (op: UserOperation<'0.6'>) => {
    const data = (op.paymasterAndData ?? '0x').toLowerCase();
    return (SPONSOR_PAYMASTERS[route.chainId] ?? []).some(
      (sponsor) =>
        !(route.paymaster && same(sponsor, route.paymaster)) &&
        data.startsWith(sponsor.toLowerCase()),
    );
  };
  /** Whether ours already holds a committed send for it (stored signed tx and nonce). */
  const stored = async (hash: string) =>
    (
      await route.db.query('SELECT 1 FROM own_paymaster_sends WHERE user_op_hash = $1', [
        hash.toLowerCase(),
      ])
    ).rows.length > 0;
  /** send/receipt by provenance: ours to ours only, everything else to `cdp`. */
  const routed = (cdp: Bundler | null): Pick<Bundler, 'send' | 'receipt'> => ({
    send: async (op) => {
      const hash = hashOf(op);
      // Known from the operation itself: a CDP sponsor's op is CDP's, no database needed.
      if (cdp && knownCdp(op)) return cdp.send(op);
      if (sponsoredByUs(op) || (await lookup(() => owned(hash)))) {
        // Draining: only what ours already committed (a stored send) is recovered.
        // A draft ours prepared but never sent is NOT first-sent now: no nonce, no signature. It
        // is never broadcast only once that is proven for the operation (unsent), since an older
        // deployment may still send it during the switch.
        if (newWork === 'cdp' && !(await lookup(() => stored(hash))))
          return (await ours()).unsent(op);
        return (await ours()).send(op);
      }
      return cdp ? cdp.send(op) : (await ours()).send(op);
    },
    receipt: async (hash) => {
      if (await lookup(() => owned(hash))) return (await ours()).receipt(hash);
      return cdp ? cdp.receipt(hash) : (await ours()).receipt(hash);
    },
  });
  return {
    effective: () => (newWork === 'cdp' ? 'unknown' : state),
    open,
    routes: (cdp) => ({ prepare: (op, options) => cdp.prepare(op, options), ...routed(cdp) }),
    prepare: async (op, options) =>
      newWork === 'cdp'
        ? fallback!.prepare(op, options)
        : ((await get()) ?? fallback!).prepare(op, options),
    ...routed(other()),
    // A drain builds ours only while there is something to finish.
    maintain: async (limit) => {
      const waiting = newWork === 'cdp' ? await open() : null;
      if (waiting === 0) return 0;
      const built = await get();
      if (!built) {
        // A drain that cannot build ours leaves its open sends unfollowed.
        if (waiting) log(`own bundler: ALERT drain cannot build ours, ${waiting} sends open`);
        return 0;
      }
      return built.maintain(limit);
    },
    unsent: async (op) => (await ours()).unsent(op),
    readiness: async () =>
      newWork === 'cdp' ? 'prepare' : ((await get())?.readiness() ?? 'unavailable'),
  };
}

/**
 * The direct bundler from the environment (CITY_BASE_BUNDLER=direct): the server-provisioned
 * signer and submitter 1 (own-paymaster-keys.ts), the paymaster from CITY_BASE_PAYMASTER_ADDRESS,
 * sponsoring only with CITY_BASE_OWN_PAYMASTER=on, the budget on the paymaster's EntryPoint
 * deposit (read fresh, at a block), the policy on this network's contracts and fee routers.
 */
export async function createDirectBundler(deps: {
  db: Database;
  env: Record<string, string | undefined>;
  client: PublicClient;
  chainId: number;
  network: {
    contracts: {
      entryPointV06: Address;
      smartWalletFactory: Address;
      spendPermissionManager: Address;
      identityRegistry: Address | null;
      reputationRegistry: Address;
    };
    tokens: { USDC: { address: Address } };
  };
  keystore: Keystore;
  fallback?: Pick<Bundler, 'receipt'>;
  log?: (line: string) => void;
}): Promise<DirectBundler> {
  const keys = await provisionedPaymasterKeys(deps.db);
  const signer = keys.get('paymaster_signer');
  const submitter = keys.get('paymaster_submitter_1');
  if (!signer || !submitter)
    throw new BundlerError('RPC_UNAVAILABLE', 'own bundler: keys are not provisioned.');
  const configured = deps.env[PAYMASTER_ADDRESS_SETTING]?.trim() ?? '';
  const paymaster = /^0x[0-9a-fA-F]{40}$/.test(configured) ? getAddress(configured) : null;
  const entryPoint = deps.network.contracts.entryPointV06;
  const live = liveReads(deps.client);
  const budget = ownPaymasterBudget({
    db: deps.db,
    deposit: async () => {
      if (!paymaster) return { wei: 0n, block: 0n };
      const block = await live.getBlockNumber();
      const wei = await live.readContract({
        address: entryPoint,
        abi: depositAbi,
        functionName: 'balanceOf',
        args: [paymaster],
        blockNumber: block,
      });
      return { wei, block };
    },
  });
  const deployment = protocolDeployment(deps.chainId);
  const feeRouters = [
    ...(deployment ? [deployment.feeRouter as Address] : []),
    ...protocolRouter2FromEnv(deps.env).map((router) => router.address as Address),
  ];
  const identityRegistry = deps.network.contracts.identityRegistry;
  if (!identityRegistry)
    throw new BundlerError('RPC_UNAVAILABLE', 'own bundler: no identity registry on this network.');
  return directBundler({
    db: deps.db,
    client: deps.client,
    chainId: deps.chainId,
    entryPoint,
    mode: ownPaymasterMode(deps.env) === 'on' ? 'on' : 'prepare',
    paymaster,
    keystore: deps.keystore,
    signer: { keyRef: signer.keyRef, address: getAddress(signer.address) },
    submitter: { keyRef: submitter.keyRef, address: getAddress(submitter.address) },
    budget,
    policy: {
      addresses: {
        usdc: deps.network.tokens.USDC.address,
        spendPermissionManager: deps.network.contracts.spendPermissionManager,
        identityRegistry,
        reputationRegistry: deps.network.contracts.reputationRegistry,
        smartWalletFactory: deps.network.contracts.smartWalletFactory,
        feeRouters,
      },
    },
    ...(deps.fallback ? { fallback: deps.fallback } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
}
