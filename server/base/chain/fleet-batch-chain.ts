/*
 * The chain side of one funded fleet batch: exactly ONE UserOperation from the treasury's spender
 * account, so the batch happens completely or not at all:
 *
 *   [approveWithSignature (only while the treasury's spend permission is still just signed)]
 *   SpendPermissionManager.spend(permission, total)        treasury wallet → treasury spender
 *   transfer(agentWallet_i, amount_i)  for each recipient   treasury spender → agent wallets
 *
 * The fleet module owns the job, batch and budget accounting (reservations, caps, expiry) and
 * passes its current-authority check as `beforeBroadcast`; this module only builds, signs, stores
 * and sends the operation, durably and idempotently on the batch's operation key. Its outcome is
 * read back with readBatchReceipt (payment-receipt.ts).
 */
import { encodeFunctionData, getAddress, parseAbi, type Hex, type PublicClient } from 'viem';
import {
  BASE_MAINNET,
  NATIVE_ETH,
  allowedToken,
  type Address,
  type BaseNetwork,
} from '../../../shared/base/chains.js';
import type { SpendPermission } from '../../../shared/base/types.js';
import { deriveAddressLocal, spenderAccountRecipe } from './derive.js';
import { checkPermission, spendPermissionManagerAbi } from './permissions.js';
import {
  abandonBeforeBroadcast,
  keystoreSigner,
  refreshFinality,
  submitOperation,
  type Bundler,
  type Call,
  type ChainOperationStore,
  type StoredOperation,
  type SubmitDeps,
} from './submit.js';

/** At most this many recipients per batch (one UserOp stays well inside the gas limit). */
export const MAX_BATCH_RECIPIENTS = 50;

const erc20Abi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);

export class BatchChainError extends Error {
  constructor(
    readonly code:
      | 'INVALID_BATCH'
      | 'TOKEN_NOT_ALLOWED'
      | 'NO_PERMISSION'
      | 'OVER_ALLOWANCE'
      | 'SPENDER_MISMATCH'
      | 'FEE_BUDGET_REQUIRED'
      | 'IDEMPOTENCY_CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

export interface BatchChainDeps {
  network: BaseNetwork;
  client: PublicClient;
  operations: ChainOperationStore;
  bundler: Bundler;
  keystore: {
    withSigner<T>(
      ref: string,
      use: (account: import('viem/accounts').PrivateKeyAccount) => Promise<T>,
    ): Promise<T>;
  };
  /** The signer address behind a spender key ref (public data from the keystore table). */
  signerOf(keyRef: string): Promise<Address>;
}

export interface BatchTransferInput {
  /** The batch's own operation key and intent hash (base_fleet_batches). */
  operationKey: string;
  intentHash: Hex;
  treasury: { wallet: Address; spender: Address; spenderKeyRef: string };
  /** The owner's spend permission for the treasury spender, and its signature while not on-chain. */
  permission: SpendPermission;
  permissionSignature: Hex | null;
  token: Address;
  transfers: readonly { to: Address; amount: bigint }[];
  /** Fee budget for this operation (wei); mandatory on mainnet. */
  maxCostWeiCap?: bigint;
  /**
   * Called with the final cost bound after estimation, before signing: the fleet module reserves
   * providerBoundWei(maxCostWei, stored pricing) atomically here; throwing refuses the batch.
   */
  reserveCost?: (maxCostWei: bigint) => Promise<void>;
  /** The fleet module's current-authority check right before the first broadcast. */
  beforeBroadcast?: () => Promise<void>;
}

/** Validates a batch before anything is signed; returns the total it spends. */
function validate(network: BaseNetwork, input: BatchTransferInput, nowSeconds: number) {
  const { transfers, permission } = input;
  if (transfers.length < 1 || transfers.length > MAX_BATCH_RECIPIENTS)
    throw new BatchChainError('INVALID_BATCH', `1 to ${MAX_BATCH_RECIPIENTS} recipients.`);
  const recipients = new Set(transfers.map((t) => getAddress(t.to)));
  if (recipients.size !== transfers.length)
    throw new BatchChainError('INVALID_BATCH', 'Each recipient appears once per batch.');
  let total = 0n;
  for (const { amount } of transfers) {
    if (typeof amount !== 'bigint' || amount <= 0n)
      throw new BatchChainError('INVALID_BATCH', 'Amounts are positive integers.');
    total += amount;
  }
  const token = allowedToken(network, input.token);
  if (!token) throw new BatchChainError('TOKEN_NOT_ALLOWED', 'Token is not allowlisted.');
  checkPermission(permission);
  if (
    getAddress(permission.account) !== getAddress(input.treasury.wallet) ||
    getAddress(permission.spender) !== getAddress(input.treasury.spender) ||
    getAddress(permission.token) !== getAddress(token.address)
  )
    throw new BatchChainError('NO_PERMISSION', 'The spend permission is for another account.');
  if (nowSeconds < permission.start || nowSeconds >= permission.end)
    throw new BatchChainError('NO_PERMISSION', 'The spend permission is not active now.');
  if (total > permission.allowance)
    throw new BatchChainError('OVER_ALLOWANCE', 'The batch exceeds the spend permission.');
  return { total, token };
}

/**
 * Fences a batch whose holds the fleet module wants to release while no operation is stored for it.
 * The absence of an operation row is NOT proof that nothing will be sent: a submit may still be
 * between reserveCost and its durable insert. This inserts a never-broadcast tombstone for the
 * batch's key (insert-if-absent): if it wins, a delayed submit finds the tombstone instead of
 * storing its own operation and never sends, so the holds may be released; if a real operation was
 * stored first, it does not win, nothing may be released, and the receipt decides.
 */
export async function fenceUnsentBatch(
  operations: ChainOperationStore,
  input: { operationKey: string; intentHash: Hex; chainId: number },
): Promise<{ fenced: boolean }> {
  const { abandoned, row } = await abandonBeforeBroadcast(operations, {
    idempotencyKey: input.operationKey,
    intentHash: input.intentHash,
    chainId: input.chainId,
    kind: 'batch',
  });
  // Only a tombstone for exactly this batch fences it (an existing one also counts, so a repeated
  // fence is idempotent); a tombstone for another intent, network or kind never does.
  const ours =
    row.intentHash.toLowerCase() === input.intentHash.toLowerCase() &&
    row.chainId === input.chainId &&
    row.kind === 'batch';
  return { fenced: abandoned && ours };
}

export function createBatchChain(deps: BatchChainDeps) {
  function readOnly(stored: StoredOperation): SubmitDeps {
    return {
      network: deps.network,
      client: deps.client,
      store: deps.operations,
      bundler: deps.bundler,
      signer: {
        address: getAddress(stored.signer),
        signUserOperation: async (): Promise<Hex> => {
          throw new Error('Reconciliation never signs.');
        },
      },
    };
  }

  return {
    /**
     * Submits the batch once. A batch already stored under its key is only reconciled (finality
     * refreshed), never re-validated, re-signed or re-sent; a row under the key that is not this
     * batch (another intent, network or kind) is refused before any receipt is looked up.
     */
    async submitBatchTransfer(input: BatchTransferInput): Promise<StoredOperation> {
      const existing = await deps.operations.get(input.operationKey);
      if (existing) {
        if (
          existing.intentHash.toLowerCase() !== String(input.intentHash).toLowerCase() ||
          existing.chainId !== deps.network.chainId ||
          existing.kind !== 'batch'
        )
          throw new BatchChainError(
            'IDEMPOTENCY_CONFLICT',
            'This key belongs to another operation, network or intent.',
          );
        return (await refreshFinality(readOnly(existing), input.operationKey)) ?? existing;
      }
      if (deps.network.chainId === BASE_MAINNET && input.maxCostWeiCap === undefined)
        throw new BatchChainError('FEE_BUDGET_REQUIRED', 'Mainnet batches need a fee budget.');
      const { total, token } = validate(deps.network, input, Math.floor(Date.now() / 1000));

      const signerAddress = await deps.signerOf(input.treasury.spenderKeyRef);
      const recipe = spenderAccountRecipe(deps.network, signerAddress);
      if (deriveAddressLocal(recipe) !== getAddress(input.treasury.spender))
        throw new BatchChainError('SPENDER_MISMATCH', 'The spender does not match its key.');

      const spm = deps.network.contracts.spendPermissionManager;
      const calls: Call[] = [];
      if (input.permissionSignature)
        calls.push({
          target: spm,
          value: 0n,
          data: encodeFunctionData({
            abi: spendPermissionManagerAbi,
            functionName: 'approveWithSignature',
            args: [input.permission, input.permissionSignature],
          }),
        });
      calls.push({
        target: spm,
        value: 0n,
        data: encodeFunctionData({
          abi: spendPermissionManagerAbi,
          functionName: 'spend',
          args: [input.permission, total],
        }),
      });
      for (const { to, amount } of input.transfers)
        calls.push(
          token.address === NATIVE_ETH
            ? { target: getAddress(to), value: amount, data: '0x' }
            : {
                target: token.address,
                value: 0n,
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: 'transfer',
                  args: [getAddress(to), amount],
                }),
              },
        );

      return submitOperation(
        {
          network: deps.network,
          client: deps.client,
          store: deps.operations,
          bundler: deps.bundler,
          signer: keystoreSigner(
            deps.client,
            deps.keystore,
            input.treasury.spenderKeyRef,
            signerAddress,
            deps.network.chainId,
          ),
        },
        {
          idempotencyKey: input.operationKey,
          intentHash: input.intentHash,
          kind: 'batch',
          account: { address: getAddress(input.treasury.spender), recipe },
          calls,
          maxCostWeiCap: input.maxCostWeiCap,
          reserveCost: input.reserveCost,
          beforeBroadcast: input.beforeBroadcast,
        },
      );
    },
  };
}
