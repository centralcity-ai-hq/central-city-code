/*
 * Canonical receipts for the payment and fleet modules. Each read runs inside the caller's own
 * transaction, after the caller has locked its own row (the payment intent, or the fleet batch):
 * lock order is always caller row → base_chain_ops (chain code never locks payment or fleet rows).
 * The operation row stays share-locked until the caller has written its state, and only receipt
 * fields leave this module: never the signed operation, signer or key material.
 */
import { getAddress } from 'viem';
import type { Transaction } from '../../database.js';
import type { ChainOpReceipt } from '../../../shared/base/types.js';
import { readOperationForShare } from './stores.js';
import { NEVER_BROADCAST, type StoredOperation } from './submit.js';

export interface ReceiptQuery {
  operationKey: string;
  intentHash: string;
  workspaceId: string;
  chainId: number;
  agentId: string;
}

export interface BatchReceiptQuery {
  workspaceId: string;
  chainId: number;
  jobId: string;
  batchNo: number;
}

export class PaymentReceiptError extends Error {
  constructor(
    readonly code:
      | 'INTENT_MISMATCH'
      | 'WRONG_NETWORK'
      | 'NOT_THIS_AGENT'
      | 'BATCH_NOT_FOUND'
      | 'NOT_THIS_TREASURY'
      | 'WRONG_KIND',
    message: string,
  ) {
    super(message);
  }
}

type Tx = Pick<Transaction, 'query'>;

/** A tombstone was never sent and carries no sender; the matching intent is its identity. */
const isTombstone = (stored: StoredOperation) =>
  stored.status === 'failed' &&
  (NEVER_BROADCAST as readonly string[]).includes(stored.errorCode ?? '') &&
  stored.signedOperation === '';

function project(stored: StoredOperation): ChainOpReceipt {
  return {
    opId: stored.idempotencyKey,
    idempotencyKey: stored.idempotencyKey,
    status: stored.status,
    userOpHash: isTombstone(stored) ? null : stored.userOpHash,
    txHash: stored.txHash,
    blockNumber: stored.blockNumber === null ? null : BigInt(stored.blockNumber),
    gasUsed: stored.gasUsed === null ? null : BigInt(stored.gasUsed),
    feeWei: stored.feeWei === null ? null : BigInt(stored.feeWei),
    errorCode: stored.errorCode,
  };
}

/** Reads the share-locked operation and checks the identity every caller shares. */
async function readChecked(
  tx: Tx,
  operationKey: string,
  intentHash: string,
  chainId: number,
  kind: StoredOperation['kind'],
): Promise<StoredOperation | null> {
  const stored = await readOperationForShare(tx, operationKey);
  if (!stored) return null;
  if (stored.intentHash.toLowerCase() !== intentHash.toLowerCase())
    throw new PaymentReceiptError('INTENT_MISMATCH', 'This operation belongs to another intent.');
  if (stored.chainId !== chainId)
    throw new PaymentReceiptError('WRONG_NETWORK', 'This operation is on another network.');
  // A tombstone counts too: one written for another kind of operation is not this one's outcome.
  if (stored.kind !== kind)
    throw new PaymentReceiptError('WRONG_KIND', 'This operation is another kind of operation.');
  return stored;
}

/** The canonical receipt for an agent payment's operation, or null when nothing is stored yet. */
export async function readPaymentReceipt(
  tx: Tx,
  query: ReceiptQuery,
): Promise<ChainOpReceipt | null> {
  const stored = await readChecked(
    tx,
    query.operationKey,
    query.intentHash,
    query.chainId,
    'transfer',
  );
  if (!stored) return null;
  if (!isTombstone(stored)) {
    const { rows } = await tx.query<{ spender_address: string }>(
      `SELECT spender_address FROM base_wallets
       WHERE agent_id = $1 AND operator_id = $2 AND chain_id = $3`,
      [query.agentId, query.workspaceId, query.chainId],
    );
    if (!rows[0] || getAddress(rows[0].spender_address) !== getAddress(stored.sender))
      throw new PaymentReceiptError(
        'NOT_THIS_AGENT',
        'This operation was not sent for this agent.',
      );
  }
  return project(stored);
}

/**
 * The canonical receipt for one funded fleet batch (one UserOp per batch), or null when nothing is
 * stored for it yet. The batch's own operation key and intent hash identify the operation, and the
 * sender must be the job's treasury wallet's spender account, never a recipient agent's.
 */
export async function readBatchReceipt(
  tx: Tx,
  query: BatchReceiptQuery,
): Promise<ChainOpReceipt | null> {
  const { rows } = await tx.query<{
    operation_key: string;
    intent_hash: string;
    spender_address: string;
  }>(
    `SELECT b.operation_key, b.intent_hash, w.spender_address
     FROM base_fleet_batches b
     JOIN base_fleet_jobs j ON j.job_id = b.job_id
     JOIN base_wallets w ON w.wallet_id = j.treasury_wallet_id
     WHERE b.job_id = $1 AND b.batch_no = $2 AND j.operator_id = $3 AND j.chain_id = $4
       AND w.operator_id = j.operator_id AND w.chain_id = j.chain_id`,
    [query.jobId, query.batchNo, query.workspaceId, query.chainId],
  );
  const batch = rows[0];
  if (!batch)
    throw new PaymentReceiptError(
      'BATCH_NOT_FOUND',
      'No such batch for this workspace and network.',
    );
  const stored = await readChecked(
    tx,
    batch.operation_key,
    batch.intent_hash,
    query.chainId,
    'batch',
  );
  if (!stored) return null;
  if (!isTombstone(stored) && getAddress(batch.spender_address) !== getAddress(stored.sender))
    throw new PaymentReceiptError(
      'NOT_THIS_TREASURY',
      "This operation was not sent from the job's treasury.",
    );
  return project(stored);
}
