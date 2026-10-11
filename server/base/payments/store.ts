import { randomUUID } from 'node:crypto';
import type { Database, Transaction } from '../../database.js';
import { intentFor, PaymentError, type PaymentStore, type TransferIntent } from './service.js';
import type { ChainOpReceipt, PaymentState } from '../../../shared/base/types.js';

export interface PaymentReceiptReader {
  /** Lock canonical operation state until the caller's transaction commits; no RPC or secrets. */
  (
    tx: Transaction,
    identity: {
      operationKey: string;
      intentHash: TransferIntent['intentHash'];
      workspaceId: string;
      chainId: number;
      agentId: string;
    },
  ): Promise<ChainOpReceipt | null>;
}

interface Row {
  payment_id: string;
  actor_id: string;
  source_kind: string;
  source_ref: string;
  intent_version: number;
  intent_hash: string;
  token_address: string;
  recipient_address: string;
  amount: string;
  kind: string;
  state: PaymentState;
}

const columns = `payment_id, actor_id, source_kind, source_ref, intent_version, intent_hash,
  token_address, recipient_address, amount::text AS amount, kind, state`;

function canonical(
  input: TransferIntent,
  env?: Record<string, string | undefined>,
): TransferIntent {
  if (!/^[1-9][0-9]{0,77}$/.test(input.amount)) throw new PaymentError('INVALID_AMOUNT');
  const intent = intentFor(input, { ...input, amount: BigInt(input.amount) }, env);
  if (intent.intentHash !== input.intentHash || intent.operationKey !== input.operationKey)
    throw new PaymentError('IDEMPOTENCY_CONFLICT');
  if (!('agentId' in intent.source)) throw new PaymentError('FLEET_ALLOCATION_REQUIRED');
  return intent;
}

function record(row: Row, intent: TransferIntent) {
  if (
    row.intent_hash !== intent.intentHash ||
    row.intent_version !== 1 ||
    row.actor_id !== intent.actorId ||
    row.source_kind !== 'agent' ||
    row.source_ref !== ('agentId' in intent.source ? intent.source.agentId : '') ||
    row.token_address !== intent.token ||
    row.recipient_address !== intent.to ||
    row.amount !== intent.amount ||
    row.kind !== 'transfer'
  )
    throw new PaymentError('IDEMPOTENCY_CONFLICT');
  return { intent, state: row.state, receipt: null };
}

/** Payment persistence; canonical receipt reads are injected by the chain module. Not live wiring. */
export function createPaymentIntentStore(deps: {
  db: Database;
  now?: () => number;
  readPaymentReceipt?: PaymentReceiptReader;
  /** The deployment's settings, for Base's own gate (payments/service.ts intentFor). */
  env?: Record<string, string | undefined>;
}): PaymentStore {
  const now = deps.now ?? Date.now;
  async function load(tx: Transaction, intent: TransferIntent): Promise<Row> {
    const { rows } = await tx.query<Row>(
      `SELECT ${columns} FROM base_payments
       WHERE operator_id = $1 AND chain_id = $2 AND idempotency_key = $3 FOR UPDATE`,
      [intent.workspaceId, intent.chainId, intent.idempotencyKey],
    );
    if (!rows[0]) throw new PaymentError('PAYMENT_NOT_FOUND');
    record(rows[0], intent);
    return rows[0];
  }
  return {
    async observe(input, supplied) {
      const intent = canonical(input, deps.env);
      if (supplied && supplied.idempotencyKey !== intent.operationKey)
        throw new PaymentError('RECEIPT_MISMATCH');
      if (!deps.readPaymentReceipt) throw new PaymentError('RECEIPT_READER_REQUIRED');
      return deps.db.transaction(async (tx) => {
        const row = await load(tx, intent);
        const receipt = await deps.readPaymentReceipt!(tx, {
          operationKey: intent.operationKey,
          intentHash: intent.intentHash,
          workspaceId: intent.workspaceId,
          chainId: intent.chainId,
          agentId: 'agentId' in intent.source ? intent.source.agentId : '',
        });
        if (receipt && receipt.idempotencyKey !== intent.operationKey)
          throw new PaymentError('RECEIPT_MISMATCH');
        // Missing evidence cannot erase a terminal outcome or make an attempted intent retryable.
        const state: PaymentState = receipt
          ? receipt.status === 'final'
            ? 'paid'
            : receipt.status === 'failed'
              ? 'failed'
              : 'reconciling'
          : row.state === 'created' || row.state === 'paid' || row.state === 'failed'
            ? row.state
            : 'reconciling';
        if ((row.state === 'paid' || row.state === 'failed') && state !== row.state)
          throw new PaymentError('TERMINAL_RECEIPT_CONFLICT');
        await tx.query(
          `UPDATE base_payments SET state = $2, settle_op_id = COALESCE($3, settle_op_id),
           version = version + 1, updated_at = $4 WHERE payment_id = $1`,
          [row.payment_id, state, receipt?.opId ?? null, now()],
        );
        return { intent, state, receipt };
      });
    },
    async reserve(input) {
      const intent = canonical(input, deps.env);
      return deps.db.transaction(async (tx) => {
        const { rows: wallets } = await tx.query<{ wallet_id: string }>(
          `SELECT wallet_id FROM base_wallets WHERE agent_id = $1 AND operator_id = $2
           AND chain_id = $3 AND state IN ('derived','deployed') FOR UPDATE`,
          [
            'agentId' in intent.source ? intent.source.agentId : '',
            intent.workspaceId,
            intent.chainId,
          ],
        );
        if (!wallets[0]) throw new PaymentError('SOURCE_UNAVAILABLE');
        const at = now();
        await tx.query(
          `INSERT INTO base_payments (payment_id, operator_id, chain_id, actor_id, source_kind,
            source_ref, payer_wallet_id, intent_version, intent_hash, idempotency_key,
            token_address, recipient_address, amount, kind, state, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'agent',$5,$6,1,$7,$8,$9,$10,$11,'transfer','created',$12,$12)
           ON CONFLICT (operator_id, chain_id, idempotency_key) DO NOTHING`,
          [
            randomUUID(),
            intent.workspaceId,
            intent.chainId,
            intent.actorId,
            'agentId' in intent.source ? intent.source.agentId : '',
            wallets[0].wallet_id,
            intent.intentHash,
            intent.idempotencyKey,
            intent.token,
            intent.to,
            intent.amount,
            at,
          ],
        );
        return record(await load(tx, intent), intent);
      });
    },
    async begin(input) {
      const intent = canonical(input, deps.env);
      return deps.db.transaction(async (tx) => {
        const row = await load(tx, intent);
        if (row.state !== 'created') return { acquired: false, record: record(row, intent) };
        await tx.query(
          `UPDATE base_payments SET state = 'settling', version = version + 1, updated_at = $2
           WHERE payment_id = $1`,
          [row.payment_id, now()],
        );
        row.state = 'settling';
        return { acquired: true, record: record(row, intent) };
      });
    },
  };
}
