/*
 * Durable UserOperation submission (docs/base/ARCHITECTURE.md §6.1, §11.3). Every on-chain action
 * of the chain module goes through `submitOperation`:
 *
 * 1. Look up the idempotency key. The same key with a different intent hash is refused.
 * 2. An existing operation is never rebuilt: it is reconciled by its locally computed userOpHash
 *    and, if not yet included, rebroadcast exactly as stored (same signature, same nonce).
 * 3. A new operation is built, signed inside the keystore and stored (signed operation, signer,
 *    nonce, hash) BEFORE it is broadcast. A crash between store and send is recovered by step 2.
 * 4. A failed or ambiguous broadcast becomes `unknown`, never a fresh operation.
 *
 * Accounts are Coinbase Smart Wallet v1 on EntryPoint v0.6. Gas and paymaster data come from the
 * injected bundler (the CDP bundler/paymaster in production; a local handleOps bundler on Anvil).
 */
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  parseSignature,
  recoverAddress,
  serializeSignature,
  stringToHex,
  TransactionReceiptNotFoundError,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  getUserOperationHash,
  toCoinbaseSmartAccount,
  type UserOperation,
} from 'viem/account-abstraction';
import { BASE_MAINNET, type Address, type BaseNetwork } from '../../../shared/base/chains.js';
import { sponsoredValidUntil } from '../../../shared/base/paymasters.js';
import type { ChainOpKind, ChainOpStatus } from '../../../shared/base/types.js';
import { createAccountCall, type DerivationRecipe } from './derive.js';
import { walletSignature } from './permissions.js';
import { liveReads, MAX_LOG_RANGE_BLOCKS } from './rpc-budget.js';
import { transientChainError } from './transient.js';

export interface Call {
  target: Address;
  value: bigint;
  data: Hex;
}

/** One row of `base_chain_ops`, as the chain module persists it. */
export interface StoredOperation {
  idempotencyKey: string;
  intentHash: Hex;
  chainId: number;
  kind: ChainOpKind;
  sender: Address;
  signer: Address;
  nonce: string;
  userOpHash: Hex;
  /** The exact signed operation, JSON with bigint fields as decimal strings. */
  signedOperation: string;
  status: ChainOpStatus;
  txHash: Hex | null;
  blockNumber: string | null;
  gasUsed: string | null;
  feeWei: string | null;
  /**
   * Upper bound on what this operation can ever be charged, fixed before broadcast: the
   * EntryPoint's required prefund for the signed limits (see `maxCostWei`). Budgets reserve this.
   */
  maxCostWei: string;
  /**
   * Head block when the operation was stored, i.e. the earliest block it could be included in. The
   * on-chain search for it starts here; when unknown, absence can never be proven (stays reconciling).
   */
  submittedBlock: string | null;
  /**
   * How far the current on-chain search for the operation's event got without finding it (decimal,
   * inclusive), through settled blocks only: the next search resumes after it (searchOnChain). Null
   * or absent: the next search starts at `submittedBlock`. Read only; written through
   * ChainOperationStore.recordSearched, never with update or transition.
   */
  searchedBlock?: string | null;
  errorCode: string | null;
  /**
   * When the row was last written (ms), read only. While it is 'submitted' this is when it was
   * last sent (the claim right before a send, or the record of a rebroadcast; see
   * REBROADCAST_MIN_MS). Absent from stores that do not keep it: then every reconcile may
   * rebroadcast, as before.
   */
  updatedAt?: number;
}

/**
 * The most an EntryPoint v0.6 can charge for an operation, from its signed fields alone:
 * (callGasLimit + verificationGasLimit × (3 with a paymaster, else 1) + preVerificationGas) ×
 * maxFeePerGas. On Base the L1 data fee is part of preVerificationGas, so this bound includes it.
 * The fields are signed, so the bundler cannot raise the bound after signing.
 */
export function maxCostWei(op: UserOperation<'0.6'>): bigint {
  const multiplier = op.paymasterAndData && op.paymasterAndData !== '0x' ? 3n : 1n;
  return (
    (op.callGasLimit + op.verificationGasLimit * multiplier + op.preVerificationGas) *
    op.maxFeePerGas
  );
}

/** The receipt a stored operation carries; a guarded write may require it unchanged. */
export type ReceiptIdentity = Pick<StoredOperation, 'txHash' | 'blockNumber' | 'errorCode'>;

export interface ChainOperationStore {
  get(idempotencyKey: string): Promise<StoredOperation | null>;
  /** Inserts unless the key exists; returns the stored row either way (atomic). */
  insert(row: StoredOperation): Promise<StoredOperation>;
  update(idempotencyKey: string, patch: Partial<StoredOperation>): Promise<StoredOperation>;
  /**
   * Applies the patch only if the row is still in one of the expected states (atomic compare-and-set);
   * returns the updated row, or null when another worker moved it first. This is the fence between
   * "stored" (queued) and "authorized for broadcast" (submitted). With `expect`, the row must also
   * still carry exactly that receipt (transaction, block, error), so a write decided on one receipt
   * never lands on a newer one recorded meanwhile.
   */
  transition(
    idempotencyKey: string,
    from: readonly ChainOpStatus[],
    patch: Partial<StoredOperation>,
    expect?: ReceiptIdentity,
  ): Promise<StoredOperation | null>;
  /**
   * Claims the next send of an operation in flight before it is made (compare-and-set): only
   * while the row is still in `status` with exactly the write time `seenUpdatedAt` the caller
   * decided on, its write time moves to `at` (always forward, so a second claim on the same
   * snapshot fails). Returns the claimed row, or null when another reader claimed or wrote it
   * first. Optional: a store without it (or without updatedAt) sends on every reconcile, as before.
   */
  claimSend?(
    idempotencyKey: string,
    status: ChainOpStatus,
    seenUpdatedAt: number,
    at: number,
  ): Promise<StoredOperation | null>;
  /**
   * Records how far the on-chain search for an operation got (`searchedBlock`; null clears it, so
   * the next search starts over at the submission block). Writes nothing else: never the status,
   * the receipt or the write time (updatedAt). An advance never moves it back. Optional: without
   * it every search starts at the submission block, still within the per-refresh page budget.
   */
  recordSearched?(idempotencyKey: string, block: string | null): Promise<void>;
}

export interface BundlerReceipt {
  success: boolean;
  txHash: Hex;
  blockNumber: bigint;
  actualGasUsed: bigint;
  actualGasCost: bigint;
}

export interface Bundler {
  /**
   * Fills gas limits, fee fields and paymasterAndData for an unsigned operation. With
   * `sponsor` set to false no paymaster is asked and the account pays its own gas (paymasterAndData
   * '0x'); the default asks the bundler's paymaster where it has one.
   */
  prepare(op: UserOperation<'0.6'>, options?: { sponsor?: boolean }): Promise<UserOperation<'0.6'>>;
  /** Broadcasts a signed operation; resending an already known operation must not fail. */
  send(op: UserOperation<'0.6'>): Promise<Hex>;
  receipt(userOpHash: Hex): Promise<BundlerReceipt | null>;
}

/** Signs a hash with a spender key without the key leaving the keystore. */
export interface OperationSigner {
  address: Address;
  signUserOperation(op: UserOperation<'0.6'>, sender: Address): Promise<Hex>;
}

export class SubmitError extends Error {
  constructor(
    readonly code:
      | 'IDEMPOTENCY_CONFLICT'
      | 'SENDER_MISMATCH'
      | 'NO_CALLS'
      | 'COST_CAP_EXCEEDED'
      /** A pinned nonce is no longer the account's next one: nothing was signed. */
      | 'NONCE_MOVED'
      /** An externally supplied signature is not the owner's over this exact operation. */
      | 'SIGNATURE_MISMATCH'
      /** The prepared operation's paymaster data is not a sponsor the caller accepts. */
      | 'NOT_SPONSORED',
    message: string,
  ) {
    super(message);
  }
}

const userOperationEvent = parseAbiItem(
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
);

const entryPointAbi = parseAbi([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
]);

const toJson = (op: UserOperation<'0.6'>) =>
  JSON.stringify(op, (_key, value) => (typeof value === 'bigint' ? value.toString(10) : value));

const BIGINT_FIELDS = [
  'nonce',
  'callGasLimit',
  'verificationGasLimit',
  'preVerificationGas',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
] as const;

export function fromJson(json: string): UserOperation<'0.6'> {
  const op = JSON.parse(json) as Record<string, unknown>;
  for (const field of BIGINT_FIELDS) op[field] = BigInt(op[field] as string);
  return op as unknown as UserOperation<'0.6'>;
}

/**
 * A Coinbase Smart Wallet's call encoding (execute for one call, executeBatch for several). The
 * encoding does not depend on the account, so a placeholder address is given and nothing is read
 * from the chain.
 */
export async function encodeAccountCalls(client: PublicClient, calls: Call[]): Promise<Hex> {
  const account = await toCoinbaseSmartAccount({
    client,
    version: '1',
    owners: ['0x0000000000000000000000000000000000000001'],
    address: '0x0000000000000000000000000000000000000001',
  });
  return account.encodeCalls(
    calls.map((call) => ({ to: call.target, value: call.value, data: call.data })),
  );
}

export interface SubmitInput {
  idempotencyKey: string;
  intentHash: Hex;
  kind: ChainOpKind;
  /** The account that sends the operation, and the recipe it is deployed from if needed. */
  account: { address: Address; recipe: DerivationRecipe };
  calls: Call[];
  /** 2D nonce lane (§11.1): parallel lanes per account never collide. */
  nonceKey?: bigint;
  /**
   * Replacement of an earlier operation: sign with exactly this full nonce. If the account's next
   * nonce on the lane is no longer it (the earlier operation, or another, used it), nothing is
   * signed (NONCE_MOVED), so a replacement can never become an additional operation.
   */
  pinnedNonce?: bigint;
  /** Fee budget reserved by the caller; above it nothing is signed (COST_CAP_EXCEEDED). */
  maxCostWeiCap?: bigint;
  /**
   * The caller's sponsor rule (e.g. shared/base/paymasters.ts sponsoredWithoutCharge): checked on
   * the prepared operation's paymasterAndData before anything is reserved, signed or stored. False
   * refuses it (NOT_SPONSORED). Without it the bundler's answer is used as it is.
   */
  sponsorCheck?: (paymasterAndData: Hex) => boolean;
  /**
   * Called with the operation's final cost bound after estimation and the cap check, BEFORE it is
   * signed or stored, so the caller can atomically reserve exactly that bound (plus any provider
   * markup). Throwing refuses the operation: nothing is signed, stored or sent. If anything later
   * fails before the operation is stored, the caller's own recovery releases what it reserved.
   */
  reserveCost?: (maxCostWei: bigint) => Promise<void>;
  /**
   * Current-authority check run after the operation is stored and immediately before its FIRST
   * broadcast (frozen wallet, revoked permission, expired run...). If it throws, the operation is
   * marked failed with REFUSED_BEFORE_BROADCAST and is never sent. Rebroadcasts of an operation
   * that may already be out are reconciliation, not new sends, and skip it. A stored operation that
   * was never authorized (queued) can only be resumed by a caller that passes this check; callers
   * with no authority rules pass an explicit no-op.
   */
  beforeBroadcast?: () => Promise<void>;
  /**
   * An operation prepared earlier (`prepareOperation`) and shown to its signer, sent exactly as it
   * is: nothing is estimated or read again, so the hash the signer approved is the hash stored and
   * broadcast. It must be from `account`, carry exactly `calls`, and sit on `nonceKey` /
   * `pinnedNonce` when those are given; its cost bound must stay within `maxCostWeiCap`.
   */
  prepared?: UserOperation<'0.6'>;
}

export interface PrepareInput {
  account: { address: Address; recipe: DerivationRecipe };
  calls: Call[];
  /** 2D nonce lane; the operation takes the account's next nonce on it unless pinned. */
  nonceKey: bigint;
  /** Use exactly this nonce; if the lane's next nonce is another one, nothing is prepared. */
  pinnedNonce?: bigint;
  maxCostWeiCap?: bigint;
  /**
   * Minimum fees, for a replacement that must outbid the operation it replaces at the same nonce
   * (bundlers require a raise). A bundler that does not honour them is refused.
   */
  feeFloor?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  /** false: no paymaster; the account prefunds its own gas (and must hold it). */
  sponsor?: boolean;
}

export interface PreparedOperation {
  /** Unsigned (`signature: '0x'`), with gas, fees and paymaster data filled in. */
  operation: UserOperation<'0.6'>;
  /** The EntryPoint's required prefund for these signed limits (see `maxCostWei`). */
  maxCostWei: bigint;
  /** The account had code when the operation was prepared (no initCode). */
  deployed: boolean;
}

/**
 * Builds an unsigned operation: the account's deployment (initCode from its recipe when it has no
 * code yet), its next nonce on the lane, the calls, then gas, fees and paymaster data from the
 * bundler. Refuses an operation the bundler changed and one whose cost bound exceeds the cap.
 * Signs nothing and stores nothing.
 */
export async function prepareOperation(
  deps: Pick<SubmitDeps, 'network' | 'client' | 'bundler'>,
  input: PrepareInput,
): Promise<PreparedOperation> {
  if (input.calls.length === 0)
    throw new SubmitError('NO_CALLS', 'An operation needs at least one call.');
  const sender = getAddress(input.account.address);
  const deployed = (await deps.client.getCode({ address: sender })) !== undefined;
  const nextNonce = await deps.client.readContract({
    address: deps.network.contracts.entryPointV06,
    abi: entryPointAbi,
    functionName: 'getNonce',
    args: [sender, input.nonceKey],
  });
  if (input.pinnedNonce !== undefined && nextNonce !== input.pinnedNonce)
    throw new SubmitError('NONCE_MOVED', 'The nonce to replace was already used; nothing signed.');
  const nonce = input.pinnedNonce ?? nextNonce;
  const initCode: Hex = deployed
    ? '0x'
    : (`${input.account.recipe.factory}${encodeFunctionData(createAccountCall(input.account.recipe)).slice(2)}` as Hex);
  const callData = await encodeAccountCalls(deps.client, input.calls);

  const unsigned = await deps.bundler.prepare(
    {
      sender,
      nonce,
      initCode,
      callData,
      callGasLimit: 0n,
      verificationGasLimit: 0n,
      preVerificationGas: 0n,
      maxFeePerGas: input.feeFloor?.maxFeePerGas ?? 0n,
      maxPriorityFeePerGas: input.feeFloor?.maxPriorityFeePerGas ?? 0n,
      paymasterAndData: '0x',
      signature: '0x',
    },
    ...(input.sponsor === undefined ? [] : [{ sponsor: input.sponsor }]),
  );
  if (
    getAddress(unsigned.sender) !== sender ||
    unsigned.nonce !== nonce ||
    (unsigned.initCode ?? '0x') !== initCode ||
    unsigned.maxPriorityFeePerGas > unsigned.maxFeePerGas ||
    unsigned.callData !== callData ||
    (input.sponsor === false && (unsigned.paymasterAndData ?? '0x') !== '0x') ||
    (input.feeFloor !== undefined &&
      (unsigned.maxFeePerGas < input.feeFloor.maxFeePerGas ||
        unsigned.maxPriorityFeePerGas < input.feeFloor.maxPriorityFeePerGas))
  )
    throw new SubmitError(
      'SENDER_MISMATCH',
      'The bundler changed the operation it was asked to prepare.',
    );

  // Budget check before anything is signed: fail closed when the bound exceeds what the caller reserved.
  const bound = maxCostWei(unsigned);
  if (input.maxCostWeiCap !== undefined && bound > input.maxCostWeiCap)
    throw new SubmitError(
      'COST_CAP_EXCEEDED',
      'The operation could cost more than its reserved budget.',
    );
  return { operation: { ...unsigned, signature: '0x' }, maxCostWei: bound, deployed };
}

/** Checks an operation prepared earlier against the submission it is sent for. */
async function checkPrepared(
  deps: SubmitDeps,
  input: SubmitInput & { prepared: UserOperation<'0.6'> },
  sender: Address,
): Promise<bigint> {
  const op = input.prepared;
  const nonceKey = input.nonceKey ?? nonceLaneFor(input.idempotencyKey);
  const initCode = (op.initCode ?? '0x').toLowerCase();
  const deployment =
    `${input.account.recipe.factory}${encodeFunctionData(createAccountCall(input.account.recipe)).slice(2)}`.toLowerCase();
  if (
    getAddress(op.sender) !== sender ||
    op.nonce >> 64n !== nonceKey ||
    (input.pinnedNonce !== undefined && op.nonce !== input.pinnedNonce) ||
    op.maxPriorityFeePerGas > op.maxFeePerGas ||
    (initCode !== '0x' && initCode !== deployment) ||
    op.callData.toLowerCase() !== (await encodeAccountCalls(deps.client, input.calls)).toLowerCase()
  )
    throw new SubmitError('SENDER_MISMATCH', 'The prepared operation is not this submission.');
  const bound = maxCostWei(op);
  if (input.maxCostWeiCap !== undefined && bound > input.maxCostWeiCap)
    throw new SubmitError(
      'COST_CAP_EXCEEDED',
      'The operation could cost more than its reserved budget.',
    );
  return bound;
}

/** Marks a failed operation that provably never left the server (nothing to reconcile). */
export const NEVER_BROADCAST = [
  'REFUSED_BEFORE_BROADCAST',
  'ABANDONED_BEFORE_BROADCAST',
  'EXPIRED_BEFORE_BROADCAST',
] as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;

/**
 * Fences off an idempotency key whose submission failed before any operation was stored (fee
 * cap, missing key, prepare error): a tombstone row is inserted for the key. Because the key is
 * unique, either the tombstone wins (then no worker can ever store or send an operation for this
 * key, and the caller may release what it reserved) or a real operation already won (then the
 * caller must reconcile it, never release).
 */
export async function abandonBeforeBroadcast(
  store: ChainOperationStore,
  input: { idempotencyKey: string; intentHash: Hex; chainId: number; kind: ChainOpKind },
): Promise<{ abandoned: boolean; row: StoredOperation }> {
  const row = await store.insert({
    idempotencyKey: input.idempotencyKey,
    intentHash: input.intentHash,
    chainId: input.chainId,
    kind: input.kind,
    sender: ZERO_ADDRESS,
    signer: ZERO_ADDRESS,
    nonce: '0',
    userOpHash: ZERO_HASH,
    signedOperation: '',
    status: 'failed',
    txHash: null,
    blockNumber: null,
    gasUsed: null,
    feeWei: null,
    maxCostWei: '0',
    submittedBlock: null,
    errorCode: 'ABANDONED_BEFORE_BROADCAST',
  });
  return {
    abandoned: row.errorCode === 'ABANDONED_BEFORE_BROADCAST' && row.signedOperation === '',
    row,
  };
}

export interface SubmitDeps {
  network: BaseNetwork;
  client: PublicClient;
  store: ChainOperationStore;
  bundler: Bundler;
  signer: OperationSigner;
  /** The clock the rebroadcast pause is measured with (the store's clock; Date.now by default). */
  now?: () => number;
  /**
   * The caller's current authority, checked before an operation whose first send may never have
   * reached the bundler ('unknown', BROADCAST_AMBIGUOUS) is sent again, exactly as before a first
   * send: a consent, grant or limit withdrawn meanwhile stops it. Throws to refuse; nothing is sent
   * and the row stays as stored. Absent: such an operation is sent again as before.
   */
  beforeRebroadcast?: (row: StoredOperation) => Promise<void>;
}

/** Settled for good: never changed again by any reconcile (status only moves forward). */
const TERMINAL: readonly ChainOpStatus[] = ['final', 'failed'];

/**
 * The 2D nonce lane of an operation: 192 bits derived from its idempotency key, so different
 * operations of one account never compete for the same nonce, and a retry uses the same lane.
 */
export const nonceLaneFor = (idempotencyKey: string): bigint =>
  BigInt(keccak256(stringToHex(idempotencyKey))) >> 64n;

/** Blocks per getLogs page when searching for an operation's event (the endpoint's range cap). */
const LOG_PAGE_BLOCKS = MAX_LOG_RANGE_BLOCKS;

/**
 * The most getLogs pages one refresh asks for (refreshFinality, or one reconcile), whatever the
 * span since the submission block: about 3,000 blocks, an hour and a half of Base blocks. Every
 * refresh of an operation still in flight (owner polls every few seconds, the crons every minute)
 * pays it at most once. A longer search continues on the next refresh where this one stopped
 * (StoredOperation.searchedBlock); until it has covered the whole span, nothing is concluded.
 */
export const SEARCH_PAGES_PER_REFRESH = 3;

/** What is left of one refresh's getLogs pages; every search of that refresh draws from it. */
interface PageBudget {
  pages: number;
}
const pageBudget = (): PageBudget => ({ pages: SEARCH_PAGES_PER_REFRESH });

/** Looks for the operation's UserOperationEvent on the chain itself, not trusting the bundler. */
type Search =
  | { kind: 'found'; receipt: BundlerReceipt }
  | { kind: 'absent' }
  | { kind: 'unknown'; reason: 'NO_START_BLOCK' | 'LOOKUP_FAILED' | 'SEARCH_INCOMPLETE' };

/**
 * Searches the chain itself for the operation's UserOperationEvent, from the block it was stored at
 * up to `toBlock`, in pages of at most LOG_PAGE_BLOCKS, drawing on the refresh's page budget. It
 * resumes after `searchedBlock`, the settled blocks an earlier refresh already searched without
 * finding it. 'absent' is returned only once every block of that interval was searched; an unknown
 * start block, a failed page or a spent budget gives 'unknown', never 'absent'.
 *
 * With `settled` (the caller's settled head) the cursor is kept: a search cut short is resumed after
 * the last block it searched, but never past a settled block that is on the chain now (a block
 * above it can still change, so it is searched again); a search that ended (found, or every block
 * searched) clears it, so the next one starts over at the submission block and reads every page
 * again (a log index that lagged the first time has caught up by then).
 */
async function searchOnChain(
  deps: SubmitDeps,
  row: StoredOperation,
  toBlock: bigint,
  budget: PageBudget,
  settled?: ChainHead,
): Promise<Search> {
  if (row.submittedBlock === null) return { kind: 'unknown', reason: 'NO_START_BLOCK' };
  const first = BigInt(row.submittedBlock);
  const resume = row.searchedBlock ? BigInt(row.searchedBlock) + 1n : first;
  let from = resume > first ? resume : first;
  let search: Search;
  try {
    for (;;) {
      if (from > toBlock) {
        search = { kind: 'absent' };
        break;
      }
      if (budget.pages <= 0) {
        search = { kind: 'unknown', reason: 'SEARCH_INCOMPLETE' };
        break;
      }
      budget.pages -= 1;
      const to = from + LOG_PAGE_BLOCKS - 1n < toBlock ? from + LOG_PAGE_BLOCKS - 1n : toBlock;
      const logs = await deps.client.getLogs({
        address: deps.network.contracts.entryPointV06,
        event: userOperationEvent,
        args: { userOpHash: row.userOpHash },
        fromBlock: from,
        toBlock: to,
      });
      const log = logs.at(-1);
      if (log) {
        search = {
          kind: 'found',
          receipt: {
            success: log.args.success!,
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
            actualGasUsed: log.args.actualGasUsed!,
            actualGasCost: log.args.actualGasCost!,
          },
        };
        break;
      }
      from = to + 1n;
    }
  } catch {
    search = { kind: 'unknown', reason: 'LOOKUP_FAILED' };
  }
  // `from - 1` is the last block searched without finding the event (every block before it, too).
  if (settled) await rememberSearch(deps, row, search, from - 1n, settled);
  return search;
}

/**
 * Keeps the search cursor (StoredOperation.searchedBlock), best effort: a failed write only means
 * the next refresh searches those pages again. A search cut short records the last block it
 * searched, capped at the settled block and only while that block is on the chain now
 * (headIsCanonical); one that ended clears it.
 */
async function rememberSearch(
  deps: SubmitDeps,
  row: StoredOperation,
  search: Search,
  searchedThrough: bigint,
  settled: ChainHead,
): Promise<void> {
  if (!deps.store.recordSearched || row.submittedBlock === null) return;
  const stored = row.searchedBlock ? BigInt(row.searchedBlock) : null;
  if (search.kind !== 'unknown') {
    if (stored !== null)
      await deps.store.recordSearched(row.idempotencyKey, null).catch(() => undefined);
    return;
  }
  const through = searchedThrough < settled.number ? searchedThrough : settled.number;
  if (through < BigInt(row.submittedBlock) || (stored !== null && through <= stored)) return;
  if (!(await headIsCanonical(deps, settled).catch(() => false))) return;
  await deps.store.recordSearched(row.idempotencyKey, through.toString(10)).catch(() => undefined);
}

export type ChainReader = Pick<SubmitDeps, 'network' | 'client'>;

/**
 * Latest block, read live (never the shared head, see rpc-budget.ts): every use here concludes
 * something from it (where a search starts or ends, whether a node has reached a block).
 */
const headBlock = (deps: ChainReader) => liveReads(deps.client).getBlockNumber({ cacheTime: 0 });

/** A head: its number, and its hash when it came from a block tag. */
export interface ChainHead {
  number: bigint;
  hash: Hex | null;
}

/** A tagged head as the (possibly shared) client reports it; null without a number and hash. */
async function taggedHead(deps: ChainReader, blockTag: 'safe' | 'finalized') {
  const block = await deps.client.getBlock({ blockTag }).catch(() => null);
  if (!block || block.number === null || block.number === undefined || !block.hash) return null;
  return { number: block.number, hash: block.hash } satisfies ChainHead;
}

/**
 * The block below which nothing reorgs: finalized on mainnet (a shared, possibly stale or foreign
 * head: anything concluded from it checks headIsCanonical first), the live head − confirmations
 * elsewhere.
 */
export async function settledHead(deps: ChainReader): Promise<ChainHead | null> {
  if (deps.network.chainId === BASE_MAINNET) return taggedHead(deps, 'finalized');
  const head = await headBlock(deps).catch(() => null);
  if (head === null) return null;
  const depth = BigInt(deps.network.confirmations);
  return { number: head > depth ? head - depth : 0n, hash: null };
}

/**
 * The newest block that is safe but not necessarily final: on mainnet the 'safe' tag (its data is
 * posted to L1, so only an L1 reorg could still drop it), elsewhere the settled block itself. Null
 * when the node cannot tell, which counts as not safe. It is a display signal only: an operation
 * becomes 'final' solely through settledHead (finalized on mainnet), which payments and fleet
 * batches rely on. A caller that reports 'safe' checks headIsCanonical first.
 */
export async function safeHead(deps: ChainReader): Promise<ChainHead | null> {
  if (deps.network.chainId === BASE_MAINNET) return taggedHead(deps, 'safe');
  return settledHead(deps);
}

/**
 * Whether a tagged head is on the chain as it is now: the block at its height, read live by number,
 * has its hash. A head from another fork, or one rolled back since, fails; so does a node that does
 * not have that block. A depth-derived head (no hash) is taken as read: it came from a live head.
 */
export async function headIsCanonical(deps: ChainReader, head: ChainHead): Promise<boolean> {
  if (head.hash === null) return true;
  const block = await liveReads(deps.client)
    .getBlock({ blockNumber: head.number })
    .catch(() => null);
  return !!block?.hash && block.hash.toLowerCase() === head.hash.toLowerCase();
}

/** Sent and not settled: the states a broadcast or a receipt lookup may still move forward. */
const IN_FLIGHT: readonly ChainOpStatus[] = ['submitted', 'unknown', 'reconciling', 'reorged'];

/**
 * Whether a sponsored operation in flight can never land any more. EntryPoint refuses an operation
 * once the block time is past its paymaster's signed validUntil (AA32), and block time only grows;
 * so a settled block that is canonical now, whose time is past validUntil, and at which the
 * operation's nonce was still unused, proves it never landed and never will. Anything Base cannot
 * tell right now (a failed read, no timestamp, a head from another fork) answers false, and an
 * operation without a bounded sponsorship (owner-funded) is never concluded here.
 */
async function sponsorshipLapsed(
  deps: ChainReader,
  row: StoredOperation,
  settled: ChainHead,
): Promise<boolean> {
  let until: number | null;
  try {
    until = sponsoredValidUntil(fromJson(row.signedOperation).paymasterAndData);
  } catch {
    return false;
  }
  if (until === null) return false;
  const block = await liveReads(deps.client)
    .getBlock({ blockNumber: settled.number })
    .catch(() => null);
  const time = (block as { timestamp?: unknown } | null)?.timestamp;
  if (typeof time !== 'bigint' || time * 1000n <= BigInt(until)) return false;
  const nonce = BigInt(row.nonce);
  const atSettled = await deps.client
    .readContract({
      address: deps.network.contracts.entryPointV06,
      abi: entryPointAbi,
      functionName: 'getNonce',
      args: [getAddress(row.sender), nonce >> 64n],
      blockNumber: settled.number,
    })
    .catch(() => null);
  if (atSettled === null || atSettled > nonce) return false;
  return headIsCanonical(deps, settled);
}

/**
 * A guarded write: applied only while the row is still in one of `from` (compare-and-set). A slow
 * worker's result never overwrites a newer state another worker already wrote (an inclusion, a
 * final or failed outcome); the newer row is returned instead.
 */
async function move(
  deps: SubmitDeps,
  key: string,
  from: readonly ChainOpStatus[],
  patch: Partial<StoredOperation>,
  expect?: ReceiptIdentity,
): Promise<StoredOperation> {
  return (await deps.store.transition(key, from, patch, expect)) ?? (await deps.store.get(key))!;
}

const receiptOf = (row: StoredOperation): ReceiptIdentity => ({
  txHash: row.txHash,
  blockNumber: row.blockNumber,
  errorCode: row.errorCode,
});

/**
 * Records an inclusion. A revert is 'included' with USEROP_REVERTED until it is deep enough. An
 * operation already included is only re-recorded (re-inclusion) while it still carries the receipt
 * it was read with; one in flight may take its first inclusion.
 */
const record = (deps: SubmitDeps, row: StoredOperation, receipt: BundlerReceipt) =>
  move(
    deps,
    row.idempotencyKey,
    row.status === 'included' ? ['included'] : IN_FLIGHT,
    {
      status: 'included',
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber.toString(10),
      gasUsed: receipt.actualGasUsed.toString(10),
      feeWei: receipt.actualGasCost.toString(10),
      errorCode: receipt.success ? null : 'USEROP_REVERTED',
    },
    row.status === 'included' ? receiptOf(row) : undefined,
  );

/**
 * JSON-RPC codes on which a receipt lookup (a read; nothing is sent or decided on its answer) is
 * "could not answer right now": limit exceeded, resource unavailable, internal error, whatever
 * their text. Wider than transient.ts on purpose: a register or send treats only rate limits as
 * "not now", while a read that could not be answered concludes nothing either way.
 */
const RECEIPT_NOT_NOW_RPC = new Set([-32005, -32002, -32603]);

/**
 * A receipt lookup the endpoint could not answer right now: a 429, a timeout, a 5xx or a dropped
 * connection (transient.ts), the bundler unreachable or answering a non-OK HTTP status
 * (rpc-bundler RPC_UNAVAILABLE), or a JSON-RPC "limit exceeded"/busy code (RECEIPT_NOT_NOW_RPC).
 * That is "unknown", not "no receipt": nothing may be concluded, searched, re-read or sent on it.
 */
export function receiptLookupNotNow(error: unknown): boolean {
  if (transientChainError(error)) return true;
  const e = error as { code?: unknown; rpcCode?: unknown } | null;
  if (e?.code === 'RPC_UNAVAILABLE') return true;
  return typeof e?.rpcCode === 'number' && RECEIPT_NOT_NOW_RPC.has(e.rpcCode);
}

/**
 * The bundler's receipt: a receipt, null when it definitively has none, or 'unknown' when it
 * could not answer right now (receiptLookupNotNow). Any other failure counts as no receipt, as
 * before: the chain itself is asked instead (nonce, then the on-chain search).
 */
async function bundlerReceipt(
  deps: SubmitDeps,
  userOpHash: Hex,
): Promise<BundlerReceipt | null | 'unknown'> {
  try {
    return await deps.bundler.receipt(userOpHash);
  } catch (error) {
    return receiptLookupNotNow(error) ? 'unknown' : null;
  }
}

/**
 * Least time between two sends of the same stored operation by reconcile (CDP call budget): a
 * polling reader reconciles every 2–3 s, and every one rebroadcast an operation still waiting for
 * its block. Only an operation the bundler accepted ('submitted') is held back: the bundler keeps
 * what it took, and resending sooner only spends the endpoint's budget. The first send
 * (authorizeAndSend), a send that failed ('unknown': the bundler may not have it) and the first
 * rebroadcast after a dropped block ('reorged') are never held back, whatever the clock. Measured on the row's own
 * updated_at: every write of a 'submitted' row is a send (the claim right before the first one,
 * the claim right before a resend, or the record of a resend), durable and shared by every
 * instance, no migration. Each resend is claimed first (claimSend: compare-and-set on the
 * updated_at it was decided on), so readers racing on the same row send once between them; a
 * claimed resend that fails leaves the row 'submitted' and the next window sends again. Sends
 * that are never held back are claimed the same way, so racing readers do not double them either.
 * A 'submitted' row is due only when now − updated_at reaches the window: a reader whose clock is
 * behind the row's waits until it passes it (bounded by the window whatever the clock skew).
 */
export const REBROADCAST_MIN_MS = 45_000;

/**
 * Whether reconcile may send this in-flight operation again now (see REBROADCAST_MIN_MS). Only a
 * time check on the row as read: the send itself is then claimed (ChainOperationStore.claimSend),
 * which is what makes it at most one per window, also for readers racing on the same row.
 */
function rebroadcastDue(deps: SubmitDeps, row: StoredOperation): boolean {
  if (row.updatedAt === undefined) return true;
  if (row.status !== 'submitted') return true;
  // Due only once the window since the row's last send is over. A clock behind the row's (another
  // instance's, or the row's claim moved past it) is NOT due: claims only move updated_at forward,
  // so such a reader sends at most once its clock passes updated_at + the window, whatever the
  // skew; readers with a correct clock keep resending meanwhile.
  return (deps.now ?? Date.now)() - row.updatedAt >= REBROADCAST_MIN_MS;
}

async function reconcile(deps: SubmitDeps, row: StoredOperation): Promise<StoredOperation> {
  return (await reconcileStep(deps, row, pageBudget())).row;
}

/**
 * Reconcile, telling the caller when the bundler could not be asked: `unknown` then means the row
 * is returned exactly as stored and nothing else was read or sent. `receipt` is the bundler's
 * answer this step read (a receipt or a definitive null), absent when it asked nothing: the caller
 * of this one refresh decides on that same answer instead of asking again (CDP call budget). It is
 * never kept beyond the refresh: a receipt can disappear on a reorg.
 */
async function reconcileStep(
  deps: SubmitDeps,
  row: StoredOperation,
  budget: PageBudget,
): Promise<{ row: StoredOperation; unknown: boolean; receipt?: BundlerReceipt | null }> {
  if (TERMINAL.includes(row.status)) return { row, unknown: false };
  // Stored but never authorized for broadcast: only the authorize-then-claim path may send it.
  if (row.status === 'queued') return { row, unknown: false };
  const receipt = await bundlerReceipt(deps, row.userOpHash);
  if (receipt === 'unknown') return { row, unknown: true };
  if (receipt) return { row: await record(deps, row, receipt), unknown: false, receipt };
  if (row.status === 'included') return { row, unknown: false, receipt };
  return { row: await afterNoReceipt(deps, row, budget), unknown: false, receipt };
}

/** An operation in flight the bundler has no receipt for: look at its nonce, else resend it. */
async function afterNoReceipt(
  deps: SubmitDeps,
  row: StoredOperation,
  budget: PageBudget,
): Promise<StoredOperation> {
  // The nonce moved on without a receipt for us: either our op landed (look on-chain) or another
  // op used the nonce, in which case ours can never land. It becomes 'failed' only once the
  // consuming block is deep enough (refreshFinality), never immediately.
  const nonce = BigInt(row.nonce);
  const current = await deps.client
    .readContract({
      address: deps.network.contracts.entryPointV06,
      abi: entryPointAbi,
      functionName: 'getNonce',
      args: [getAddress(row.sender), nonce >> 64n],
    })
    .catch(() => null);
  if (current !== null && current > nonce) {
    // Already known to be consumed: the settled search (refreshFinality) looks for the event with
    // the refresh's page budget and resumes where the last one stopped; searching here as well
    // would spend that budget on the same blocks every time.
    if (row.status === 'reconciling' && row.errorCode === 'NONCE_CONSUMED') return row;
    // The nonce was just read at the newest block: the (live) search must reach at least as far.
    const head = await headBlock(deps);
    const search = await searchOnChain(deps, row, head, budget);
    if (search.kind === 'found') return record(deps, row, search.receipt);
    // Absent or unknown: probably consumed by another operation. Not failed yet: that needs the
    // consumption to be final and complete canonical absence (refreshFinality).
    return move(deps, row.idempotencyKey, IN_FLIGHT, {
      status: 'reconciling',
      errorCode: 'NONCE_CONSUMED',
    });
  }

  // Not included yet: rebroadcast the exact stored operation, never a rebuilt one, at most once
  // per REBROADCAST_MIN_MS. Held back, the row stays exactly as stored.
  if (!rebroadcastDue(deps, row)) return row;
  // A first send that may never have reached the bundler is sent again only past the caller's
  // current authority (SubmitDeps.beforeRebroadcast). Refused: nothing is sent; a sponsored one
  // then lapses and is retired as not sent (refreshFinality, retireLapsed).
  if (row.status === 'unknown' && deps.beforeRebroadcast) {
    try {
      await deps.beforeRebroadcast(row);
    } catch {
      return row;
    }
  }
  // Claimed before it is sent: of concurrent readers holding the same snapshot (owner polls on
  // several instances, the crons) exactly one sends; the others answer the row as stored.
  let claimed = row;
  if (row.updatedAt !== undefined && deps.store.claimSend) {
    const won = await deps.store.claimSend(
      row.idempotencyKey,
      row.status,
      row.updatedAt,
      (deps.now ?? Date.now)(),
    );
    if (!won) return (await deps.store.get(row.idempotencyKey)) ?? row;
    claimed = won;
  }
  try {
    await deps.bundler.send(fromJson(row.signedOperation));
    // Still 'submitted': the claim already recorded this send (no second write).
    if (claimed !== row && row.status === 'submitted') return claimed;
    return move(deps, row.idempotencyKey, IN_FLIGHT, { status: 'submitted', errorCode: null });
  } catch {
    // A resend of an operation the bundler already took: it stays 'submitted', its claim is the
    // window's send, and the next window sends again. Any other failed send is ambiguous.
    if (row.status === 'submitted') return claimed;
    return move(deps, row.idempotencyKey, IN_FLIGHT, {
      status: 'unknown',
      errorCode: 'BROADCAST_AMBIGUOUS',
    });
  }
}

export async function submitOperation(
  deps: SubmitDeps,
  input: SubmitInput,
): Promise<StoredOperation> {
  if (input.calls.length === 0)
    throw new SubmitError('NO_CALLS', 'An operation needs at least one call.');
  // Every FIRST send meets the caller's current rules on the stored bytes: its sponsor rule (an
  // operation queued under an older or looser rule is not accepted by that alone), then its
  // authority check. Rebroadcasts of an operation that may already be out are reconciliation.
  const firstSend = (row: StoredOperation) =>
    input.sponsorCheck || input.beforeBroadcast
      ? async () => {
          const sponsorData = fromJson(row.signedOperation).paymasterAndData ?? '0x';
          if (input.sponsorCheck && !input.sponsorCheck(sponsorData))
            throw new SubmitError('NOT_SPONSORED', 'The network fee is not covered.');
          await input.beforeBroadcast?.();
        }
      : undefined;
  const existing = await deps.store.get(input.idempotencyKey);
  if (existing) {
    if (existing.chainId !== deps.network.chainId)
      throw new SubmitError(
        'IDEMPOTENCY_CONFLICT',
        'This key belongs to an operation on another network.',
      );
    if (existing.intentHash !== input.intentHash)
      throw new SubmitError('IDEMPOTENCY_CONFLICT', 'This key was used for a different intent.');
    // Stored but never authorized (a crash between store and check, or another worker still checking):
    // only a caller that runs the authority check itself may resume it; anyone else leaves it queued.
    if (existing.status === 'queued')
      return input.beforeBroadcast
        ? authorizeAndSend(deps, existing, firstSend(existing))
        : existing;
    return reconcile(deps, existing);
  }

  const sender = getAddress(input.account.address);
  let unsigned: UserOperation<'0.6'>;
  let bound: bigint;
  if (input.prepared) {
    bound = await checkPrepared(deps, { ...input, prepared: input.prepared }, sender);
    unsigned = { ...input.prepared, signature: '0x' };
  } else {
    const prepared = await prepareOperation(deps, {
      account: input.account,
      calls: input.calls,
      nonceKey: input.nonceKey ?? nonceLaneFor(input.idempotencyKey),
      pinnedNonce: input.pinnedNonce,
      maxCostWeiCap: input.maxCostWeiCap,
    });
    unsigned = prepared.operation;
    bound = prepared.maxCostWei;
  }
  const nonce = unsigned.nonce;
  if (input.sponsorCheck && !input.sponsorCheck(unsigned.paymasterAndData ?? '0x'))
    throw new SubmitError('NOT_SPONSORED', 'The network fee is not covered by an allowed sponsor.');
  await input.reserveCost?.(bound);

  const signature = await deps.signer.signUserOperation(unsigned, sender);
  const signed: UserOperation<'0.6'> = { ...unsigned, signature };
  const userOpHash = getUserOperationHash({
    chainId: deps.network.chainId,
    entryPointAddress: deps.network.contracts.entryPointV06,
    entryPointVersion: '0.6',
    userOperation: signed,
  });

  // Store before broadcast (§11.3). If another worker won the insert, reconcile its operation.
  // The head block now is the earliest block the operation can land in (start of every search).
  const submittedBlock = await headBlock(deps);
  const row = await deps.store.insert({
    idempotencyKey: input.idempotencyKey,
    intentHash: input.intentHash,
    chainId: deps.network.chainId,
    kind: input.kind,
    sender,
    signer: deps.signer.address,
    nonce: nonce.toString(10),
    userOpHash,
    signedOperation: toJson(signed),
    status: 'queued',
    txHash: null,
    blockNumber: null,
    gasUsed: null,
    feeWei: null,
    maxCostWei: bound.toString(10),
    submittedBlock: submittedBlock.toString(10),
    errorCode: null,
  });
  if (row.userOpHash !== userOpHash) {
    if (row.intentHash !== input.intentHash)
      throw new SubmitError('IDEMPOTENCY_CONFLICT', 'This key was used for a different intent.');
    return reconcile(deps, row);
  }
  return authorizeAndSend(deps, row, firstSend(row));
}

/**
 * The only path that sends an operation for the first time. The current-authority check runs, then
 * the row is claimed queued → submitted with a compare-and-set; only the worker that wins the claim
 * broadcasts. A refusal marks the row failed only while it is still queued, i.e. before anyone could
 * have sent it. Reconcile never sends a queued row, so no other worker can broadcast it in between.
 */
async function authorizeAndSend(
  deps: SubmitDeps,
  row: StoredOperation,
  beforeBroadcast: (() => Promise<void>) | undefined,
): Promise<StoredOperation> {
  if (beforeBroadcast) {
    try {
      await beforeBroadcast();
    } catch {
      const refused = await deps.store.transition(row.idempotencyKey, ['queued'], {
        status: 'failed',
        errorCode: 'REFUSED_BEFORE_BROADCAST',
      });
      return refused ?? reconcile(deps, (await deps.store.get(row.idempotencyKey)) ?? row);
    }
  }
  const claimed = await deps.store.transition(row.idempotencyKey, ['queued'], {
    status: 'submitted',
  });
  if (!claimed) return reconcile(deps, (await deps.store.get(row.idempotencyKey)) ?? row);
  try {
    await deps.bundler.send(fromJson(row.signedOperation));
    return claimed;
  } catch {
    return move(deps, row.idempotencyKey, ['submitted'], {
      status: 'unknown',
      errorCode: 'BROADCAST_AMBIGUOUS',
    });
  }
}

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What the chain itself says about a receipt (see `canonicalOutcome`). */
export type CanonicalOutcome =
  { kind: 'agrees'; blockHash: Hex } | { kind: 'missing' | 'differs' | 'unknown' };

/**
 * Checks a receipt against the chain itself before it settles anything:
 *
 *   - 'agrees': the node's receipt is for this transaction and in the given block, that block is
 *     the canonical one at its height now (a number alone does not survive a reorg to another
 *     block at the same height), the transaction succeeded and holds exactly one
 *     UserOperationEvent for the operation, from its sender with its nonce, with the given outcome;
 *   - 'missing': the node has no receipt for the transaction;
 *   - 'differs': the receipt is elsewhere, not canonical, or does not carry this outcome;
 *   - 'unknown': a read failed; nothing can be concluded.
 *
 * An 'agrees' carries the canonical block's hash. Only reads; never throws.
 */
export async function canonicalOutcome(
  deps: ChainReader,
  row: Pick<StoredOperation, 'userOpHash' | 'sender' | 'nonce'>,
  receipt: Pick<BundlerReceipt, 'txHash' | 'blockNumber' | 'success'>,
): Promise<CanonicalOutcome> {
  try {
    const onChain = await deps.client
      .getTransactionReceipt({ hash: receipt.txHash })
      .catch((error: unknown) => {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      });
    if (!onChain) return { kind: 'missing' };
    if (
      !sameHex(onChain.transactionHash, receipt.txHash) ||
      onChain.blockNumber !== receipt.blockNumber ||
      onChain.status !== 'success'
    )
      return { kind: 'differs' };
    const entryPoint = getAddress(deps.network.contracts.entryPointV06);
    const ours = parseEventLogs({
      abi: [userOperationEvent],
      logs: onChain.logs.filter((log) => getAddress(log.address) === entryPoint),
    }).filter((log) => sameHex(log.args.userOpHash, row.userOpHash));
    if (
      ours.length !== 1 ||
      !sameHex(ours[0].args.sender, row.sender) ||
      ours[0].args.nonce !== BigInt(row.nonce) ||
      ours[0].args.success !== receipt.success
    )
      return { kind: 'differs' };
    // Read last: a reorg during the reads above makes the canonical hash differ from the receipt's.
    const block = await deps.client.getBlock({ blockNumber: receipt.blockNumber });
    return block.hash && sameHex(block.hash, onChain.blockHash)
      ? { kind: 'agrees', blockHash: block.hash }
      : { kind: 'differs' };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * Moves an operation forward once it is deep enough (§11.1 finality): included + success → final,
 * included + revert → failed, nonce consumed by another operation → failed. On mainnet 'deep' means
 * at or below the finalized block; elsewhere the network's confirmation count. Before declaring
 * anything, the receipt this refresh read is compared with the stored one: a different block or
 * transaction (reorg, re-inclusion) is recorded and the depth count restarts. One refresh asks the
 * bundler for the receipt once; reconcile and the finality check decide on that same answer. A receipt is declared gone (reorged) only by a node
 * whose head has reached the recorded block. A deep receipt settles only once the chain itself
 * confirms it in the canonical block (canonicalOutcome); one the chain contradicts is reorged.
 * Never throws on a missing receipt or RPC hiccup. A receipt lookup the endpoint could not answer
 * right now (receiptLookupNotNow) ends the refresh with the stored row as it is: no search, no
 * nonce read, no resend, no state change. The on-chain search asks for at most
 * SEARCH_PAGES_PER_REFRESH getLogs pages per refresh; a longer one continues on the next refresh
 * (searchOnChain), and nothing is concluded from it before it has covered every block.
 */
export async function refreshFinality(
  deps: SubmitDeps,
  idempotencyKey: string,
  options: {
    /**
     * Retire an operation in flight whose sponsorship lapsed before it landed (sponsorshipLapsed):
     * failed with SPONSORSHIP_LAPSED, nothing sent, so its holds can be released. Without it such an
     * operation (a rejected first send, an initCode another operation made stale, a sponsorship
     * that ran out before the bundler took it) stays in flight forever, rebroadcast and refused.
     */
    retireLapsed?: boolean;
    /**
     * The operation runs on its own nonce lane (nonceLaneFor of its key) and nothing else is ever
     * signed there (agent payments): a used nonce on that lane means it landed. An empty log search
     * (a lagging or incomplete log index) is then never taken as absence, so a payment that moved
     * money is never failed and its hold never released; it stays reconciling until its event is
     * found. Never applied to an operation in another lane.
     */
    ownLane?: boolean;
  } = {},
): Promise<StoredOperation | null> {
  const row = await deps.store.get(idempotencyKey);
  if (!row) return null;
  if (TERMINAL.includes(row.status)) return row;
  // At most SEARCH_PAGES_PER_REFRESH getLogs pages for this whole refresh, however old it is.
  const budget = pageBudget();
  const step = await reconcileStep(deps, row, budget);
  // The bundler could not say right now (a 429, a timeout): the stored state stands, unchanged,
  // and nothing else is read or sent before the next poll.
  if (step.unknown) return step.row;
  let current = step.row;
  // Our event found on the chain itself by the settled search below: the receipt this refresh
  // reads (never a second search over the same blocks).
  let found: BundlerReceipt | undefined;
  // Only an inclusion, a consumed nonce and a lapsed sponsorship are decided against the settled
  // block: anything else in flight returns unchanged below, so its head is not read (CDP budget).
  const needsSettled =
    current.status === 'included' ||
    (current.status === 'reconciling' && current.errorCode === 'NONCE_CONSUMED') ||
    (options.retireLapsed === true && IN_FLIGHT.includes(current.status));
  if (!needsSettled) return current;
  const settled = await settledHead(deps);
  if (settled === null) return current;

  if (
    options.retireLapsed &&
    IN_FLIGHT.includes(current.status) &&
    (await sponsorshipLapsed(deps, current, settled))
  )
    return move(deps, idempotencyKey, IN_FLIGHT, {
      status: 'failed',
      errorCode: 'SPONSORSHIP_LAPSED',
    });

  // Nonce consumed by something else: failed only when the consumption itself is settled (nonce
  // read AT the settled block) and the chain shows no event for us from submission to that block.
  if (current.status === 'reconciling' && current.errorCode === 'NONCE_CONSUMED') {
    const nonce = BigInt(current.nonce);
    const atSettled = await deps.client
      .readContract({
        address: deps.network.contracts.entryPointV06,
        abi: entryPointAbi,
        functionName: 'getNonce',
        args: [getAddress(current.sender), nonce >> 64n],
        blockNumber: settled.number,
      })
      .catch(() => null);
    if (atSettled === null || atSettled <= nonce) return current;
    // Every block searched is settled: a search cut short resumes there on the next refresh.
    const search = await searchOnChain(deps, current, settled.number, budget, settled);
    if (search.kind === 'found') {
      // Recorded as included; settled below in this same refresh when its block is.
      current = await record(deps, current, search.receipt);
      found = search.receipt;
    } else {
      if (search.kind === 'unknown') return current;
      if (options.ownLane && nonce >> 64n === nonceLaneFor(idempotencyKey)) return current;
      // Only a settled block still on the chain (its hash, read live by number) proves anything: a
      // shared finalized head from another fork or a rolled-back node does not.
      if (!(await headIsCanonical(deps, settled))) return current;
      return move(deps, idempotencyKey, ['reconciling'], { status: 'failed' }, receiptOf(current));
    }
  }
  if (current.status !== 'included' || current.blockNumber === null) return current;

  // The receipt this refresh already has: found on chain above, or the bundler's answer read in
  // reconcileStep; the bundler is asked here only when neither exists.
  const answered =
    found ??
    (step.receipt !== undefined ? step.receipt : await bundlerReceipt(deps, current.userOpHash));
  // Not answered right now: never searched for, never declared gone.
  if (answered === 'unknown') return current;
  let fresh: BundlerReceipt | null | undefined = answered;
  // The head the on-chain search covered (null when the bundler answered).
  let head: bigint | null = null;
  if (!fresh) {
    try {
      // Read live (headBlock): an absent result up to this head declares the receipt gone.
      head = await headBlock(deps);
      const search = await searchOnChain(deps, current, head, budget, settled);
      fresh =
        search.kind === 'found' ? search.receipt : search.kind === 'absent' ? null : undefined;
    } catch {
      fresh = undefined;
    }
  }
  // undefined = could not check right now: keep waiting, never conclude anything.
  if (fresh === undefined) return current;
  if (fresh === null) {
    // A node whose head has not reached the recorded block (a lagging RPC behind a load balancer)
    // simply has not seen the receipt yet; only one at or past that block can tell it is gone.
    if (head === null || head < BigInt(current.blockNumber)) return current;
    return move(
      deps,
      idempotencyKey,
      ['included'],
      { status: 'reorged', errorCode: 'RECEIPT_GONE' },
      receiptOf(current),
    );
  }
  if (fresh.txHash !== current.txHash || fresh.blockNumber.toString(10) !== current.blockNumber)
    return record(deps, current, fresh);
  if (fresh.blockNumber > settled.number) return current;
  // The bundler's word is not enough to settle: the chain itself must hold this receipt in the
  // canonical block at that height, with our operation's outcome (a stale receipt survives a reorg
  // to another block at the same height with the same number).
  const canonical = (await canonicalOutcome(deps, current, fresh)).kind;
  if (canonical === 'unknown') return current;
  if (canonical === 'missing') {
    const now = await headBlock(deps).catch(() => null);
    if (now === null || now < fresh.blockNumber) return current;
  }
  if (canonical !== 'agrees')
    return move(
      deps,
      idempotencyKey,
      ['included'],
      { status: 'reorged', errorCode: 'RECEIPT_GONE' },
      receiptOf(current),
    );
  // Final only under a settled block that is on the chain now (hash read live by number): the
  // receipt's block is canonical (above) and so is the settled block, hence its ancestor.
  // With the identity port's client these reads (receipt, block by number) may be answered by the
  // second endpoint (read-transport.ts preferSecond): presence only, each bound to a hash the
  // bundler or the settled head already named, so an honest node on another fork or behind only
  // says "not yet". Reading them from the CDP endpoint alone would also trust nothing of a
  // dishonest second endpoint, at a few CDP calls per settled operation; not done here.
  if (!(await headIsCanonical(deps, settled))) return current;
  return move(
    deps,
    idempotencyKey,
    ['included'],
    fresh.success ? { status: 'final' } : { status: 'failed' },
    receiptOf(current),
  );
}

const OWNER_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/**
 * The address that signed a raw 32-byte hash with a 65-byte ECDSA signature (r || s || v, v as
 * 0/1 or 27/28): no message prefix, exactly what a Coinbase Smart Wallet checks for an operation.
 * Null when the signature is malformed or recovers nothing.
 */
export async function recoverRawSigner(hash: Hex, signature: string): Promise<Address | null> {
  if (!OWNER_SIGNATURE.test(signature)) return null;
  try {
    return getAddress(await recoverAddress({ hash, signature: signature as Hex }));
  } catch {
    return null;
  }
}

/**
 * The owner's signature as the wallet takes it in a UserOperation: v normalized to 27/28, inside
 * SignatureWrapper{ownerIndex, signatureData}. The EntryPoint deploys an undeployed account from
 * its initCode before validating, so no ERC-6492 wrapper is ever needed here.
 */
export function ownerOperationSignature(signature: Hex, ownerIndex: number): Hex {
  if (!OWNER_SIGNATURE.test(signature)) throw new Error('An owner signature is 65 bytes.');
  if (!Number.isInteger(ownerIndex) || ownerIndex < 0 || ownerIndex > 255)
    throw new Error('Owner index out of range.');
  return walletSignature(serializeSignature(parseSignature(signature)), { ownerIndex });
}

/**
 * A signer for an operation its owner signed elsewhere (the browser-held key of a wallet): it holds
 * no key. It answers only for the one operation whose raw userOpHash the owner signed, only when
 * the signature recovers to the owner, and returns it wrapped for the wallet.
 */
export function ownerSignatureSigner(input: {
  owner: Address;
  ownerIndex: number;
  /** 65 bytes over the raw userOpHash (no message prefix). */
  signature: Hex;
  userOpHash: Hex;
  chainId: number;
  entryPoint: Address;
}): OperationSigner {
  const owner = getAddress(input.owner);
  return {
    address: owner,
    async signUserOperation(op, sender) {
      const hash = getUserOperationHash({
        chainId: input.chainId,
        entryPointAddress: input.entryPoint,
        entryPointVersion: '0.6',
        userOperation: { ...op, sender },
      });
      if (hash.toLowerCase() !== input.userOpHash.toLowerCase())
        throw new SubmitError('SIGNATURE_MISMATCH', 'The signature is for another operation.');
      if ((await recoverRawSigner(hash, input.signature)) !== owner)
        throw new SubmitError('SIGNATURE_MISMATCH', 'The operation was not signed by its owner.');
      return ownerOperationSignature(input.signature, input.ownerIndex);
    },
  };
}

/** A signer backed by the keystore: the spender key is decrypted only for the signature. */
export function keystoreSigner(
  client: PublicClient,
  keystore: {
    withSigner<T>(
      ref: string,
      use: (account: import('viem/accounts').PrivateKeyAccount) => Promise<T>,
    ): Promise<T>;
  },
  keyRef: string,
  signerAddress: Address,
  /** The network the operation hash is computed for; must equal the submitting network. */
  chainId?: number,
): OperationSigner {
  return {
    address: signerAddress,
    async signUserOperation(op, sender) {
      return keystore.withSigner(keyRef, async (owner) => {
        const account = await toCoinbaseSmartAccount({
          client,
          version: '1',
          owners: [owner],
          address: sender,
        });
        const id = chainId ?? client.chain?.id;
        if (id === undefined) throw new Error('Signing needs an explicit chain id.');
        return account.signUserOperation({ ...op, chainId: id });
      });
    },
  };
}
