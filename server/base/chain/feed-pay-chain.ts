/*
 * The chain side of Feed pay (docs/FEED_PAY.md sections 3, 6 and 8): everything the engine does on
 * Base, inside the chain module's rules. Keys never leave the keystore; every operation is stored
 * before it is broadcast (submit.ts) and paid for by a pinned sponsor or not sent at all.
 *
 *   topUp    one UserOperation from the agent's spender account: [approveWithSignature (the owner's
 *            limit, first spend only)] + SpendPermissionManager.spend(limit, amount). The agent
 *            wallet's USDC moves into its own spender account (the float). The first one also
 *            deploys the spender account (initCode), which ERC-1271 needs. The amount is held on
 *            the agent wallet (reservation holder 'float') before anything is signed.
 *   sweep    USDC.transfer(agent wallet, amount) from the spender account: the float goes back.
 *   cancel   USDC.cancelAuthorization(spender, nonce, ERC-1271 signature) from the spender account,
 *            for an authorization the service did not settle.
 *   issue    the EIP-3009 TransferWithAuthorization from the spender account (chain/x402.ts),
 *            stored before it is handed out; a retry gets the stored one.
 *   outcome  Base's word on an authorization: AuthorizationUsed (settled, with its transaction),
 *            AuthorizationCanceled, or unused past validBefore (expired). Reads only.
 *
 * Nothing here decides whether a payment may happen: the engine checks flags, limits and owners
 * and passes `beforeBroadcast`, run right before an operation's first send.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  stringToHex,
  type Hex,
  type PublicClient,
} from 'viem';
import type { Database } from '../../database.js';
import { BASE_MAINNET, type Address, type BaseNetwork } from '../../../shared/base/chains.js';
import { sponsoredWithoutCharge, type SponsorAllowlist } from '../../../shared/base/paymasters.js';
import type { ChainOpKind, SpendPermission } from '../../../shared/base/types.js';
import { spenderAccountRecipe } from './derive.js';
import { checkPermission, spendPermissionManagerAbi } from './permissions.js';
import { ReservationError, type createReservationLedger } from './reservations.js';
import { MAX_LOG_RANGE_BLOCKS } from './rpc-budget.js';
import {
  abandonBeforeBroadcast,
  keystoreSigner,
  NEVER_BROADCAST,
  refreshFinality,
  submitOperation,
  type Bundler,
  type Call,
  type ChainOperationStore,
  type StoredOperation,
} from './submit.js';
import { ROUTER3_ABI, router3Nonce } from '../../feed/pay/router3.js';
import {
  issueBoundAuthorization,
  issueTransferAuthorization,
  signCancelAuthorization,
  type AuthorizationStore,
  type IssuedAuthorization,
} from './x402.js';

type Keystore = {
  withSigner<T>(
    ref: string,
    use: (account: import('viem/accounts').PrivateKeyAccount) => Promise<T>,
  ): Promise<T>;
};

export interface FeedPayChainDeps {
  network: BaseNetwork;
  client: PublicClient;
  db: Database;
  operations: ChainOperationStore;
  bundler: Bundler;
  keystore: Keystore;
  signerOf(keyRef: string): Promise<Address>;
  ledger: ReturnType<typeof createReservationLedger>;
  /** A fresh USDC balance read with its block (never a cached one). */
  usdcBalance(address: Address): Promise<{ balance: bigint; blockNumber: bigint }>;
  authorizations: AuthorizationStore;
  /** Fee budget per operation (wei); mandatory on Base mainnet. */
  maxCostWeiCap?: bigint;
  /** The sponsors that may pay the gas; mandatory on Base mainnet (pinned sponsor or nothing). */
  sponsors?: SponsorAllowlist;
  now?: () => number;
}

export class FeedPayChainError extends Error {
  constructor(
    readonly code:
      | 'WRONG_NETWORK'
      | 'FEE_BUDGET_REQUIRED'
      | 'SPONSOR_REQUIRED'
      | 'WALLET_NOT_FOUND'
      | 'NO_PERMISSION'
      | 'OVER_ALLOWANCE'
      | 'INSUFFICIENT_BALANCE'
      | 'NOT_DEPLOYED',
    message: string,
  ) {
    super(message);
  }
}

/** One chain operation of Feed pay, as the engine follows it. */
export interface FeedPayOp {
  key: string;
  status: StoredOperation['status'];
  txHash: Hex | null;
  blockNumber: bigint | null;
  /** Provably never left the server (tombstone, refused or expired before its first send). */
  neverSent: boolean;
  errorCode: string | null;
}

export interface WalletRef {
  walletId: string;
  /** The agent wallet (where the money comes from and goes back to). */
  address: Address;
  /** Its spender smart account (the payer of every authorization). */
  spender: Address;
  spenderKeyRef: string;
}

export interface PermissionRef {
  permissionId: string;
  permission: SpendPermission;
  /** 'signed': not approved on Base yet, so the first spend approves it in the same operation. */
  state: 'signed' | 'onchain';
  signature: Hex;
}

/**
 * What a limit may still move now on Base. A limit is only live between its start and its end:
 * before its start (a limit created under the previous limit-start behavior started at the next 00:00 Berlin after it was
 * signed; new ones start at 00:00 Berlin that day) and from its end on,
 * SpendPermissionManager.getCurrentPeriod reverts, and that is no failure of Base.
 */
export type AllowanceLeft =
  | { phase: 'active'; left: bigint; periodEnd: number }
  /** Nothing may be spent until `startsAt` (unix seconds, the permission's start). */
  | { phase: 'before_start'; startsAt: number }
  /** Nothing may be spent any more since `endedAt` (unix seconds, the permission's end). */
  | { phase: 'after_end'; endedAt: number };

/** getCurrentPeriod's reverts outside start..end (SpendPermissionManager). */
const periodWindowErrors = parseAbi([
  'error BeforeSpendPermissionStart(uint48 currentTimestamp, uint48 start)',
  'error AfterSpendPermissionEnd(uint48 currentTimestamp, uint48 end)',
]);
const currentPeriodAbi = [...spendPermissionManagerAbi, ...periodWindowErrors] as const;

/** The window revert behind a failed getCurrentPeriod read, or null for any other failure. */
function periodWindowRevert(error: unknown): 'before_start' | 'after_end' | null {
  const reverted =
    error instanceof ContractFunctionRevertedError
      ? error
      : error instanceof BaseError
        ? error.walk((cause) => cause instanceof ContractFunctionRevertedError)
        : null;
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  let name = reverted.data?.errorName;
  if (!name && reverted.raw)
    try {
      name = decodeErrorResult({ abi: periodWindowErrors, data: reverted.raw }).errorName;
    } catch {
      return null;
    }
  if (name === 'BeforeSpendPermissionStart') return 'before_start';
  if (name === 'AfterSpendPermissionEnd') return 'after_end';
  return null;
}

export type AuthorizationOutcome =
  | { kind: 'used'; txHash: Hex; blockNumber: bigint; at: number }
  | { kind: 'canceled'; txHash: Hex; blockNumber: bigint }
  | { kind: 'expired' }
  | { kind: 'pending' };

const usdcAbi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function cancelAuthorization(address authorizer, bytes32 nonce, bytes signature)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);
const authorizationUsed = parseAbiItem(
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
);
const authorizationCanceled = parseAbiItem(
  'event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)',
);

/** Blocks searched for an authorization's events from where it was signed (about 66 minutes). */
export const AUTHORIZATION_SEARCH_BLOCKS = 2_000n;

export const opIntentHash = (value: unknown): Hex =>
  keccak256(stringToHex(JSON.stringify(['cc.feedpay.v1', value])));

const receiptOf = (row: StoredOperation): FeedPayOp => ({
  key: row.idempotencyKey,
  status: row.status,
  txHash: row.txHash,
  blockNumber: row.blockNumber === null ? null : BigInt(row.blockNumber),
  neverSent:
    row.status === 'failed' && (NEVER_BROADCAST as readonly string[]).includes(row.errorCode ?? ''),
  errorCode: row.errorCode,
});

const feeRouterReadAbi = parseAbi([
  'function treasury() view returns (address)',
  'function token() view returns (address)',
  'function MAX_TOTAL() view returns (uint256)',
  'function FEE_BPS() view returns (uint256)',
]);

export function createFeedPayChain(deps: FeedPayChainDeps) {
  const { network, client } = deps;
  const usdc = getAddress(network.tokens.USDC.address);
  const now = deps.now ?? Date.now;

  const submitDeps = (signer: Parameters<typeof submitOperation>[0]['signer']) => ({
    network,
    client,
    store: deps.operations,
    bundler: deps.bundler,
    signer,
  });

  /** Reconciling only reads and rebroadcasts the stored operation; nothing is signed. */
  const readOnly = (stored: StoredOperation) => ({
    address: getAddress(stored.signer),
    signUserOperation: async (): Promise<Hex> => {
      throw new Error('Reconciliation never signs.');
    },
  });

  function guard() {
    // Real money is never moved without a fee budget and a pinned sponsor.
    if (network.chainId === BASE_MAINNET && deps.maxCostWeiCap === undefined)
      throw new FeedPayChainError('FEE_BUDGET_REQUIRED', 'Base operations need a fee budget.');
    if (network.chainId === BASE_MAINNET && deps.sponsors === undefined)
      throw new FeedPayChainError('SPONSOR_REQUIRED', 'Base operations need a pinned sponsor.');
  }

  /** Releases a float reservation held for an operation that provably never went out. */
  async function releaseFloat(key: string) {
    await deps.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ reservation_id: string; state: string }>(
        `SELECT reservation_id, state FROM base_wallet_reservations
         WHERE holder_kind = 'float' AND holder_ref = $1 AND chain_id = $2`,
        [key, network.chainId],
      );
      for (const row of rows)
        if (row.state === 'held') await deps.ledger.release(tx, row.reservation_id);
    });
  }

  /** A final top-up consumes its hold (and marks the limit approved); a failed one releases it. */
  async function settleFloat(key: string, row: StoredOperation, walletId: string) {
    if (row.status !== 'final' && row.status !== 'failed') return;
    let approved: string[] = [];
    if (row.status === 'final') {
      const { rows } = await deps.db.query<{
        permission_id: string;
        permission: Record<string, string | number>;
      }>(
        `SELECT permission_id, permission FROM base_spend_permissions
         WHERE wallet_id = $1 AND chain_id = $2 AND state = 'signed'`,
        [walletId, network.chainId],
      );
      const checks = await Promise.all(
        rows.map(async (candidate) =>
          (await client
            .readContract({
              address: network.contracts.spendPermissionManager,
              abi: spendPermissionManagerAbi,
              functionName: 'isApproved',
              args: [permissionOf(candidate.permission)],
            })
            .catch(() => false))
            ? candidate.permission_id
            : null,
        ),
      );
      approved = checks.filter((id): id is string => id !== null);
    }
    await deps.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ reservation_id: string; state: string }>(
        `SELECT reservation_id, state FROM base_wallet_reservations
         WHERE holder_kind = 'float' AND holder_ref = $1 AND wallet_id = $2`,
        [key, walletId],
      );
      const reservation = rows[0];
      if (reservation?.state === 'held') {
        if (row.status === 'final') await deps.ledger.consume(tx, reservation.reservation_id, key);
        else await deps.ledger.release(tx, reservation.reservation_id);
      }
      if (approved.length)
        await tx.query(
          `UPDATE base_spend_permissions SET state = 'onchain', updated_at = $2
           WHERE permission_id = ANY($1::text[]) AND state = 'signed'`,
          [approved, now()],
        );
    });
  }

  /**
   * Stores and sends one operation from the spender account. Anything that fails before an
   * operation is stored fences the key with a tombstone, so the caller can end its step as never
   * sent; an operation stored meanwhile wins the key and is reconciled.
   */
  async function send(input: {
    key: string;
    intentHash: Hex;
    kind: ChainOpKind;
    wallet: WalletRef;
    calls: Call[];
    beforeBroadcast: () => Promise<void>;
    onAbandon?: () => Promise<void>;
  }): Promise<FeedPayOp> {
    guard();
    let row: StoredOperation;
    try {
      const signerAddress = await deps.signerOf(input.wallet.spenderKeyRef);
      const signer = keystoreSigner(
        client,
        deps.keystore,
        input.wallet.spenderKeyRef,
        signerAddress,
        network.chainId,
      );
      row = await submitOperation(submitDeps(signer), {
        idempotencyKey: input.key,
        intentHash: input.intentHash,
        kind: input.kind,
        sponsorFlow: 'feedPay',
        account: {
          address: input.wallet.spender,
          recipe: spenderAccountRecipe(network, signerAddress),
        },
        calls: input.calls,
        maxCostWeiCap: deps.maxCostWeiCap,
        ...(deps.sponsors
          ? {
              sponsorCheck: (data: Hex) =>
                sponsoredWithoutCharge(network.chainId, data, deps.sponsors),
            }
          : {}),
        beforeBroadcast: input.beforeBroadcast,
      });
    } catch (error) {
      if (await deps.operations.get(input.key)) throw error;
      const { abandoned } = await abandonBeforeBroadcast(deps.operations, {
        idempotencyKey: input.key,
        intentHash: input.intentHash,
        chainId: network.chainId,
        kind: input.kind,
      });
      if (abandoned) await input.onAbandon?.();
      throw error;
    }
    const op = receiptOf(row);
    if (op.neverSent) await input.onAbandon?.();
    return op;
  }

  return {
    network,

    /** The USDC an address holds now, with the block read at. */
    usdcBalance: (address: Address) => deps.usdcBalance(address),

    async headBlock(): Promise<bigint> {
      return client.getBlockNumber({ cacheTime: 0 });
    },

    /**
     * A fee router's immutable binding (CentralCityFeeRouter: treasury and token), read on this
     * chain. Reads only; throws when the node does not answer.
     */
    async feeRouterBinding(router: Address): Promise<{ treasury: Address; token: Address }> {
      const [treasury, token] = await Promise.all([
        client.readContract({ address: router, abi: feeRouterReadAbi, functionName: 'treasury' }),
        client.readContract({ address: router, abi: feeRouterReadAbi, functionName: 'token' }),
      ]);
      return { treasury: treasury as Address, token: token as Address };
    },

    /**
     * A fee router's immutable limits (MAX_TOTAL and FEE_BPS), read on this chain: fee router 2's
     * readiness check (docs/protocol/FEE_ROUTER_2.md section 2). Reads only; throws when the node
     * does not answer or the address is not such a router.
     */
    async feeRouterLimits(router: Address): Promise<{ maxTotal: bigint; feeBps: bigint }> {
      const [maxTotal, feeBps] = await Promise.all([
        client.readContract({ address: router, abi: feeRouterReadAbi, functionName: 'MAX_TOTAL' }),
        client.readContract({ address: router, abi: feeRouterReadAbi, functionName: 'FEE_BPS' }),
      ]);
      return { maxTotal: maxTotal as bigint, feeBps: feeBps as bigint };
    },

    async isDeployed(address: Address): Promise<boolean> {
      return (await client.getCode({ address })) !== undefined;
    },

    /**
     * What the limit may still move in its current Base period, and when that period ends; or
     * that it has not started yet / has ended. The window is checked against the clock first (no
     * read, no revert); a window revert from Base (its block time a little behind ours) reads the
     * same. Any other failure rejects.
     */
    async allowanceLeft(permission: SpendPermission): Promise<AllowanceLeft> {
      const nowS = Math.floor(now() / 1000);
      if (nowS < permission.start) return { phase: 'before_start', startsAt: permission.start };
      if (nowS >= permission.end) return { phase: 'after_end', endedAt: permission.end };
      let period: { start: number; end: number; spend: bigint };
      try {
        period = await client.readContract({
          address: network.contracts.spendPermissionManager,
          abi: currentPeriodAbi,
          functionName: 'getCurrentPeriod',
          args: [permission],
        });
      } catch (error) {
        const window = periodWindowRevert(error);
        if (window === 'before_start') return { phase: 'before_start', startsAt: permission.start };
        if (window === 'after_end') return { phase: 'after_end', endedAt: permission.end };
        throw error;
      }
      const left = permission.allowance - BigInt(period.spend);
      // A permission never used reports an empty period; its end is computed from the start.
      const end =
        Number(period.end) > nowS
          ? Number(period.end)
          : permission.start +
            (Math.floor((nowS - permission.start) / permission.period) + 1) * permission.period;
      return { phase: 'active', left: left > 0n ? left : 0n, periodEnd: end };
    },

    /**
     * Moves `amount` from the agent wallet into its spender account under the owner's limit. The
     * amount is held on the wallet first (holder 'float'); INSUFFICIENT_BALANCE when the wallet,
     * minus what it already holds, can't cover it. A retry with the same key reconciles the same
     * operation and never moves money twice.
     */
    async topUp(input: {
      key: string;
      intentHash: Hex;
      wallet: WalletRef;
      limit: PermissionRef;
      amount: bigint;
      beforeBroadcast: () => Promise<void>;
    }): Promise<FeedPayOp> {
      guard();
      const permission = input.limit.permission;
      checkPermission(permission);
      if (permission.account !== getAddress(input.wallet.address))
        throw new FeedPayChainError('NO_PERMISSION', 'The limit belongs to another wallet.');
      if (permission.spender !== getAddress(input.wallet.spender))
        throw new FeedPayChainError('NO_PERMISSION', 'The limit names another spender.');
      if (getAddress(permission.token) !== usdc)
        throw new FeedPayChainError('NO_PERMISSION', 'The limit is not for USDC.');
      if (input.amount <= 0n || input.amount > permission.allowance)
        throw new FeedPayChainError('OVER_ALLOWANCE', 'The amount exceeds the spending limit.');
      const nowS = Math.floor(now() / 1000);
      if (nowS < permission.start || nowS >= permission.end)
        throw new FeedPayChainError('NO_PERMISSION', 'The spending limit is not active now.');
      const existing = await deps.operations.get(input.key);
      if (!existing)
        try {
          await deps.db.transaction((tx) =>
            deps.ledger.reserve(tx, {
              walletId: input.wallet.walletId,
              chainId: network.chainId,
              token: usdc,
              amount: input.amount,
              holder: { kind: 'float', ref: input.key },
              intentHash: input.intentHash,
            }),
          );
        } catch (error) {
          if (error instanceof ReservationError && error.code === 'INSUFFICIENT_BALANCE')
            throw new FeedPayChainError('INSUFFICIENT_BALANCE', error.message);
          if (!(error instanceof ReservationError && error.code === 'RESERVATION_CLOSED'))
            throw error;
        }
      const spm = network.contracts.spendPermissionManager;
      const calls: Call[] = [];
      if (input.limit.state === 'signed')
        calls.push({
          target: spm,
          value: 0n,
          data: encodeFunctionData({
            abi: spendPermissionManagerAbi,
            functionName: 'approveWithSignature',
            args: [permission, input.limit.signature],
          }),
        });
      calls.push({
        target: spm,
        value: 0n,
        data: encodeFunctionData({
          abi: spendPermissionManagerAbi,
          functionName: 'spend',
          args: [permission, input.amount],
        }),
      });
      return send({
        key: input.key,
        intentHash: input.intentHash,
        kind: 'pull',
        wallet: input.wallet,
        calls,
        beforeBroadcast: input.beforeBroadcast,
        onAbandon: () => releaseFloat(input.key),
      });
    },

    /** Moves `amount` of the float back to the agent wallet. */
    async sweep(input: {
      key: string;
      intentHash: Hex;
      wallet: WalletRef;
      amount: bigint;
      beforeBroadcast: () => Promise<void>;
    }): Promise<FeedPayOp> {
      return send({
        key: input.key,
        intentHash: input.intentHash,
        kind: 'sweep',
        wallet: input.wallet,
        calls: [
          {
            target: usdc,
            value: 0n,
            data: encodeFunctionData({
              abi: usdcAbi,
              functionName: 'transfer',
              args: [getAddress(input.wallet.address), input.amount],
            }),
          },
        ],
        beforeBroadcast: input.beforeBroadcast,
      });
    },

    /**
     * The protocol fee of a paid call, from the spender account: an exact-fee USDC approval to the
     * fee router and its chargeFee (docs/protocol/FEES.md). Sent only after the seller's payment
     * settled; the key is per call, so a retry is the same operation, and the router refuses a
     * second charge for the same (payer, ref) on-chain.
     */
    async chargeFee(input: {
      key: string;
      intentHash: Hex;
      wallet: WalletRef;
      calls: { to: Hex; value: bigint; data: Hex }[];
      beforeBroadcast: () => Promise<void>;
    }): Promise<FeedPayOp> {
      return send({
        key: input.key,
        intentHash: input.intentHash,
        kind: 'protocol_fee',
        wallet: input.wallet,
        calls: input.calls.map((call) => ({ target: call.to, value: call.value, data: call.data })),
        beforeBroadcast: input.beforeBroadcast,
      });
    },

    /**
     * A fee-included payment of a service sold by a Central City agent, from the spender account:
     * an exact-price USDC approval to the fee router and its pay(payee, gross, ref), which sends 90%
     * to the seller and 10% to the treasury in the same call. The same submission machinery as the
     * fee leg (operation kind 'protocol_fee': pinned sponsor, fee budget, stored before broadcast,
     * one operation per key); the router refuses a second payment for the same (payer, ref).
     */
    async routerPay(input: {
      key: string;
      intentHash: Hex;
      wallet: WalletRef;
      calls: { to: Hex; value: bigint; data: Hex }[];
      beforeBroadcast: () => Promise<void>;
    }): Promise<FeedPayOp> {
      return send({
        key: input.key,
        intentHash: input.intentHash,
        kind: 'protocol_fee',
        wallet: input.wallet,
        calls: input.calls.map((call) => ({ target: call.to, value: call.value, data: call.data })),
        beforeBroadcast: input.beforeBroadcast,
      });
    },

    /**
     * The logs of a transaction as Base has it now, with its block: null when the receipt can't be
     * read right now or the transaction is not in a canonical block (its block hash, read live by
     * number, differs). Reads only.
     */
    async receiptLogs(txHash: Hex): Promise<{
      status: 'success' | 'reverted';
      blockNumber: bigint;
      blockHash: Hex;
      logs: { address: Hex; topics: Hex[]; data: Hex }[];
    } | null> {
      try {
        const receipt = await client.getTransactionReceipt({ hash: txHash });
        const block = await client.getBlock({ blockNumber: receipt.blockNumber });
        if (!block.hash || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
          return null;
        return {
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          logs: receipt.logs.map((log) => ({
            address: log.address,
            topics: [...log.topics] as Hex[],
            data: log.data,
          })),
        };
      } catch {
        return null;
      }
    },

    /** Cancels an unused authorization of the spender account on Base. */
    async cancel(input: {
      key: string;
      intentHash: Hex;
      wallet: WalletRef;
      nonce: Hex;
      beforeBroadcast: () => Promise<void>;
    }): Promise<FeedPayOp> {
      const existing = await deps.operations.get(input.key);
      const signature = existing
        ? ('0x' as Hex)
        : await signCancelAuthorization({
            network,
            keystore: deps.keystore,
            keyRef: input.wallet.spenderKeyRef,
            token: usdc,
            authorizer: getAddress(input.wallet.spender),
            nonce: input.nonce,
          });
      return send({
        key: input.key,
        intentHash: input.intentHash,
        kind: 'cancel_authorization',
        wallet: input.wallet,
        calls: [
          {
            target: usdc,
            value: 0n,
            data: encodeFunctionData({
              abi: usdcAbi,
              functionName: 'cancelAuthorization',
              args: [getAddress(input.wallet.spender), input.nonce, signature],
            }),
          },
        ],
        beforeBroadcast: input.beforeBroadcast,
      });
    },

    /**
     * An operation brought up to date from Base (reconcile, finality; at most a resend of the
     * same stored operation). A top-up's hold is consumed or released once it is definitive.
     *
     * `expireQueuedBefore` (ms): an operation stored but never claimed for its first send (still
     * 'queued': its worker died, or its claim threw, between the insert and the claim) and not
     * written since before then is expired: compare-and-set queued → failed
     * (EXPIRED_BEFORE_BROADCAST). That status is the only gate: the first send is itself claimed
     * queued → submitted (submit.ts authorizeAndSend), so exactly one of the two wins; once this
     * one has, nothing sends the operation any more (a terminal row is never sent again). Lost to
     * a claim: the row as stored now is followed like any other.
     */
    async opStatus(
      key: string,
      walletId: string,
      options: { expireQueuedBefore?: number } = {},
    ): Promise<FeedPayOp | null> {
      let stored = await deps.operations.get(key);
      if (!stored) return null;
      if (
        stored.status === 'queued' &&
        options.expireQueuedBefore !== undefined &&
        stored.updatedAt !== undefined &&
        stored.updatedAt < options.expireQueuedBefore
      )
        stored =
          (await deps.operations.transition(key, ['queued'], {
            status: 'failed',
            errorCode: 'EXPIRED_BEFORE_BROADCAST',
          })) ??
          (await deps.operations.get(key)) ??
          stored;
      const op = receiptOf(stored);
      if (op.neverSent) {
        if (stored.kind === 'pull') await releaseFloat(key);
        return op;
      }
      const row =
        (await refreshFinality(submitDeps(readOnly(stored)), key, {
          retireLapsed: true,
          ownLane: true,
        })) ?? stored;
      if (row.kind === 'pull') await settleFloat(key, row, walletId);
      return receiptOf(row);
    },

    /**
     * The EIP-3009 authorization for a payment, signed by the spender account and stored before it
     * is returned; a retry returns the stored one unchanged (same window, same nonce).
     */
    async issue(input: {
      paymentId: string;
      wallet: WalletRef;
      to: Address;
      value: bigint;
      validAfter: bigint;
      validBefore: bigint;
    }): Promise<IssuedAuthorization> {
      if (!(await client.getCode({ address: input.wallet.spender })))
        throw new FeedPayChainError('NOT_DEPLOYED', 'The spender account is not deployed yet.');
      return issueTransferAuthorization({
        network,
        client,
        keystore: deps.keystore,
        keyRef: input.wallet.spenderKeyRef,
        token: usdc,
        store: deps.authorizations,
        paymentIntentId: input.paymentId,
        authorization: {
          from: getAddress(input.wallet.spender),
          to: getAddress(input.to),
          value: input.value,
          validAfter: input.validAfter,
          validBefore: input.validBefore,
          nonce: '0x00',
        },
        now: Math.floor(now() / 1000),
      });
    },

    /**
     * The two EIP-3009 authorizations of a fee router 3 payment (docs/protocol/FEE_ROUTER_3.md),
     * signed by the spender account: `gross - fee` to the payee and `fee` to the router's treasury,
     * nonces as the router derives them (router3Nonce), one window for both. Stored under
     * `<key>:seller` and `<key>:fee` before they are returned; a retry gets the stored pair
     * unchanged (its window is read back from the seller leg, so a crash between the two legs
     * still yields one matching pair). Never a second pair for the same key.
     */
    async router3Legs(input: {
      key: string;
      wallet: WalletRef;
      router: Address;
      treasury: Address;
      payee: Address;
      gross: bigint;
      fee: bigint;
      ref: Hex;
      validitySeconds: number;
    }): Promise<{ seller: IssuedAuthorization; fee: IssuedAuthorization }> {
      if (!(await client.getCode({ address: input.wallet.spender })))
        throw new FeedPayChainError('NOT_DEPLOYED', 'The spender account is not deployed yet.');
      const payer = getAddress(input.wallet.spender);
      const sellerId = `${input.key}:seller`;
      const earlier = await deps.authorizations.get(sellerId);
      const at = BigInt(Math.floor(now() / 1000));
      const validAfter = earlier ? earlier.authorization.validAfter : 0n;
      const validBefore = earlier
        ? earlier.authorization.validBefore
        : at + BigInt(input.validitySeconds);
      const nonce = (leg: 0 | 1) =>
        router3Nonce({
          chainId: network.chainId,
          router: input.router,
          treasury: input.treasury,
          payer,
          payee: input.payee,
          gross: input.gross,
          ref: input.ref,
          validAfter,
          validBefore,
          leg,
        });
      const issue = (id: string, to: Address, value: bigint, legNonce: Hex) =>
        issueBoundAuthorization({
          network,
          client,
          keystore: deps.keystore,
          keyRef: input.wallet.spenderKeyRef,
          token: usdc,
          store: deps.authorizations,
          paymentIntentId: id,
          authorization: {
            from: payer,
            to: getAddress(to),
            value,
            validAfter,
            validBefore,
            nonce: legNonce,
          },
          now: Math.floor(now() / 1000),
        });
      const seller = await issue(sellerId, input.payee, input.gross - input.fee, nonce(0));
      const fee = await issue(`${input.key}:fee`, input.treasury, input.fee, nonce(1));
      return { seller, fee };
    },

    /**
     * Router 3's own nonce for a probe purchase, read on chain: the readiness check compares it with
     * router3Nonce, so a router whose derivation differs is never used. Reads only.
     */
    async router3NonceFor(
      router: Address,
      probe: {
        payer: Address;
        payee: Address;
        gross: bigint;
        ref: Hex;
        validAfter: bigint;
        validBefore: bigint;
        leg: 0 | 1;
      },
    ): Promise<Hex> {
      return (await client.readContract({
        address: router,
        abi: ROUTER3_ABI,
        functionName: 'nonceFor',
        args: [
          probe.payer,
          probe.payee,
          probe.gross,
          probe.ref,
          probe.validAfter,
          probe.validBefore,
          probe.leg,
        ],
      })) as Hex;
    },

    /**
     * Fences an operation key that never got an operation (a tombstone, insert-if-absent) and
     * releases what a top-up held for it. False when a real operation won the key meanwhile.
     * 'protocol_fee' fences a fee-included payment that was planned and never stored.
     */
    async endUnsent(
      key: string,
      intentHash: Hex,
      kind: 'top_up' | 'sweep' | 'protocol_fee',
    ): Promise<boolean> {
      const { row } = await abandonBeforeBroadcast(deps.operations, {
        idempotencyKey: key,
        intentHash,
        chainId: network.chainId,
        kind: kind === 'top_up' ? 'pull' : kind,
      });
      if (!receiptOf(row).neverSent) return false;
      if (kind === 'top_up') await releaseFloat(key);
      return true;
    },

    /** The stored authorization of a payment, if it was ever issued. */
    stored: (paymentId: string) => deps.authorizations.get(paymentId),

    /**
     * What Base says about an authorization (reads only; every failure is 'pending'):
     *   used      an AuthorizationUsed event of (payer, nonce) in a block that is canonical now;
     *             a transaction the service named is checked first
     *   canceled  an AuthorizationCanceled event likewise
     *   expired   Base's safe block is at or past validBefore and the nonce is unused there
     */
    async outcome(input: {
      payer: Address;
      nonce: Hex;
      fromBlock: bigint;
      validBefore: number;
      claimedTx: Hex | null;
    }): Promise<AuthorizationOutcome> {
      try {
        const payer = getAddress(input.payer);
        const nonce = input.nonce.toLowerCase();
        const canonical = async (blockNumber: bigint, blockHash: Hex) => {
          const block = await client.getBlock({ blockNumber });
          return !!block.hash && block.hash.toLowerCase() === blockHash.toLowerCase()
            ? block
            : null;
        };
        if (input.claimedTx) {
          const receipt = await client
            .getTransactionReceipt({ hash: input.claimedTx })
            .catch(() => null);
          if (receipt && receipt.status === 'success') {
            const logs = parseEventLogs({
              abi: [authorizationUsed],
              logs: receipt.logs.filter((log) => getAddress(log.address) === usdc),
            }).filter(
              (log) =>
                getAddress(log.args.authorizer) === payer && log.args.nonce.toLowerCase() === nonce,
            );
            const block = logs.length
              ? await canonical(receipt.blockNumber, receipt.blockHash)
              : null;
            if (block)
              return {
                kind: 'used',
                txHash: receipt.transactionHash,
                blockNumber: receipt.blockNumber,
                at: Number(block.timestamp) * 1000,
              };
          }
        }
        const head = await client.getBlockNumber({ cacheTime: 0 });
        const last = input.fromBlock + AUTHORIZATION_SEARCH_BLOCKS;
        const end = head < last ? head : last;
        for (let from = input.fromBlock; from <= end; from += MAX_LOG_RANGE_BLOCKS) {
          const to =
            from + MAX_LOG_RANGE_BLOCKS - 1n < end ? from + MAX_LOG_RANGE_BLOCKS - 1n : end;
          const page = { address: usdc, args: { authorizer: payer, nonce: input.nonce } };
          const used = await client.getLogs({
            ...page,
            event: authorizationUsed,
            fromBlock: from,
            toBlock: to,
          });
          const hit = used.find((log) => !log.removed && log.blockHash && log.transactionHash);
          if (hit) {
            const block = await canonical(hit.blockNumber!, hit.blockHash!);
            if (block)
              return {
                kind: 'used',
                txHash: hit.transactionHash!,
                blockNumber: hit.blockNumber!,
                at: Number(block.timestamp) * 1000,
              };
            return { kind: 'pending' };
          }
          const canceled = await client.getLogs({
            ...page,
            event: authorizationCanceled,
            fromBlock: from,
            toBlock: to,
          });
          const cancel = canceled.find(
            (log) => !log.removed && log.blockHash && log.transactionHash,
          );
          if (cancel) {
            if (await canonical(cancel.blockNumber!, cancel.blockHash!))
              return {
                kind: 'canceled',
                txHash: cancel.transactionHash!,
                blockNumber: cancel.blockNumber!,
              };
            return { kind: 'pending' };
          }
        }
        // Unused past its window: only once a settled block is at or past validBefore (EIP-3009
        // accepts block.timestamp < validBefore), the wall clock agrees, and the nonce is unused
        // at that very block.
        if (Math.floor(now() / 1000) <= input.validBefore) return { kind: 'pending' };
        const safe = await client.getBlock({ blockTag: 'safe' });
        if (safe.number === null || !safe.hash || Number(safe.timestamp) < input.validBefore)
          return { kind: 'pending' };
        const consumed = await client.readContract({
          address: usdc,
          abi: usdcAbi,
          functionName: 'authorizationState',
          args: [payer, input.nonce],
          blockNumber: safe.number,
        });
        if (consumed !== false) return { kind: 'pending' };
        return { kind: 'expired' };
      } catch {
        return { kind: 'pending' };
      }
    },
  };
}

export type FeedPayChainPort = ReturnType<typeof createFeedPayChain>;

/** A stored limit as SpendPermissionManager takes it. */
export function permissionOf(raw: Record<string, string | number>): SpendPermission {
  return {
    account: getAddress(String(raw.account)),
    spender: getAddress(String(raw.spender)),
    token: getAddress(String(raw.token)),
    allowance: BigInt(raw.allowance),
    period: Number(raw.period),
    start: Number(raw.start),
    end: Number(raw.end),
    salt: BigInt(raw.salt),
    extraData: String(raw.extraData ?? '0x') as Hex,
  };
}
