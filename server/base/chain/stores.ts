/*
 * Postgres stores for the chain module (migrations 78, 79 and 82). Only this module reads or writes
 * `base_chain_ops` and `base_spender_keys`; every query names its columns explicitly, so no view,
 * export or `SELECT *` elsewhere can pick up ciphertexts or signed operations by accident.
 */
import { randomUUID } from 'node:crypto';
import { getAddress, type Hex } from 'viem';
import type { Database, Transaction } from '../../database.js';
import type { Address } from '../../../shared/base/chains.js';
import type { ChainOpKind, ChainOpStatus } from '../../../shared/base/types.js';
import type { SpenderKeyStore, StoredSpenderKey } from './keystore.js';
import { parseKeyRef } from './keystore.js';
import type { AuthorizationStore, IssuedAuthorization } from './x402.js';
import { fromJson, maxCostWei, type ChainOperationStore, type StoredOperation } from './submit.js';

interface OpRow {
  idempotency_key: string;
  intent_hash: string;
  chain_id: number;
  kind: ChainOpKind;
  status: ChainOpStatus;
  signed_operation: Uint8Array | null;
  signer_address: string | null;
  nonce: string | null;
  user_op_hash: string | null;
  tx_hash: string | null;
  block_number: string | null;
  gas_used: string | null;
  fee_wei: string | null;
  error_code: string | null;
  submitted_block: string | null;
}

const OP_COLUMNS = `idempotency_key, intent_hash, chain_id, kind, status, signed_operation,
  signer_address, nonce::text AS nonce, user_op_hash, tx_hash, block_number::text AS block_number,
  gas_used::text AS gas_used, fee_wei::text AS fee_wei, error_code,
  submitted_block::text AS submitted_block`;

function opView(row: OpRow): StoredOperation {
  // A tombstone (submission abandoned before anything was stored) carries no operation.
  if (
    row.error_code === 'ABANDONED_BEFORE_BROADCAST' &&
    (!row.signed_operation || row.signed_operation.length === 0)
  )
    return {
      idempotencyKey: row.idempotency_key,
      intentHash: row.intent_hash as Hex,
      chainId: row.chain_id,
      kind: row.kind,
      sender: '0x0000000000000000000000000000000000000000',
      signer: '0x0000000000000000000000000000000000000000',
      nonce: '0',
      userOpHash: `0x${'00'.repeat(32)}`,
      signedOperation: '',
      status: row.status,
      txHash: null,
      blockNumber: null,
      gasUsed: null,
      feeWei: null,
      maxCostWei: '0',
      submittedBlock: null,
      errorCode: row.error_code,
    };
  if (!row.signed_operation || !row.signer_address || !row.user_op_hash || row.nonce === null)
    throw new Error('Stored operation is incomplete.');
  const signedOperation = Buffer.from(row.signed_operation).toString('utf8');
  // sender and the cost bound are fixed by the signed operation itself, so they are derived from it.
  const op = fromJson(signedOperation);
  return {
    idempotencyKey: row.idempotency_key,
    intentHash: row.intent_hash as Hex,
    chainId: row.chain_id,
    kind: row.kind,
    sender: getAddress(op.sender),
    signer: getAddress(row.signer_address),
    nonce: row.nonce,
    userOpHash: row.user_op_hash as Hex,
    signedOperation,
    status: row.status,
    txHash: (row.tx_hash as Hex | null) ?? null,
    blockNumber: row.block_number,
    gasUsed: row.gas_used,
    feeWei: row.fee_wei,
    maxCostWei: maxCostWei(op).toString(10),
    // Rows stored before migration 82 have none: absence is then never concluded for them.
    submittedBlock: row.submitted_block,
    errorCode: row.error_code,
  };
}

/** Columns a caller may update after insert; identity and the signed operation never change. */
const UPDATABLE: Partial<Record<keyof StoredOperation, string>> = {
  status: 'status',
  txHash: 'tx_hash',
  blockNumber: 'block_number',
  gasUsed: 'gas_used',
  feeWei: 'fee_wei',
  errorCode: 'error_code',
};

export function pgChainOperationStore(
  db: Database,
  now: () => number = Date.now,
): ChainOperationStore {
  async function get(key: string) {
    const { rows } = await db.query<OpRow>(
      `SELECT ${OP_COLUMNS} FROM base_chain_ops WHERE idempotency_key = $1`,
      [key],
    );
    return rows[0] ? opView(rows[0]) : null;
  }

  return {
    get,

    async insert(row) {
      const at = now();
      await db.query(
        `INSERT INTO base_chain_ops (op_id, idempotency_key, intent_hash, kind, chain_id, status,
           signed_operation, signer_address, nonce, operation_hash, user_op_hash, tx_hash,
           block_number, gas_used, fee_wei, error_code, submitted_block, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,$17,$16,$16)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          randomUUID(),
          row.idempotencyKey,
          row.intentHash,
          row.kind,
          row.chainId,
          row.status,
          Buffer.from(row.signedOperation, 'utf8'),
          row.signer,
          row.nonce,
          row.userOpHash,
          row.txHash,
          row.blockNumber,
          row.gasUsed,
          row.feeWei,
          row.errorCode,
          at,
          row.submittedBlock,
        ],
      );
      // Whether this call or a concurrent one won, return what is stored for the key.
      const stored = await get(row.idempotencyKey);
      if (!stored) throw new Error('Operation could not be stored.');
      return stored;
    },

    async update(key, patch) {
      const sets: string[] = [];
      const params: unknown[] = [key];
      for (const [field, value] of Object.entries(patch)) {
        const column = UPDATABLE[field as keyof StoredOperation];
        if (!column) throw new Error(`Field ${field} cannot be updated.`);
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      }
      params.push(now());
      sets.push(`updated_at = $${params.length}`);
      const { rows } = await db.query<OpRow>(
        `UPDATE base_chain_ops SET ${sets.join(', ')} WHERE idempotency_key = $1 RETURNING ${OP_COLUMNS}`,
        params,
      );
      if (!rows[0]) throw new Error('No stored operation for this key.');
      return opView(rows[0]);
    },

    async transition(key, from, patch, expect) {
      const sets: string[] = [];
      const params: unknown[] = [key, [...from]];
      for (const [field, value] of Object.entries(patch)) {
        const column = UPDATABLE[field as keyof StoredOperation];
        if (!column) throw new Error(`Field ${field} cannot be updated.`);
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      }
      params.push(now());
      sets.push(`updated_at = $${params.length}`);
      // The receipt the write was decided on must still be the stored one.
      const guards: string[] = [];
      if (expect) {
        params.push(expect.txHash);
        guards.push(`tx_hash IS NOT DISTINCT FROM $${params.length}::text`);
        params.push(expect.blockNumber);
        guards.push(`block_number::text IS NOT DISTINCT FROM $${params.length}::text`);
        params.push(expect.errorCode);
        guards.push(`error_code IS NOT DISTINCT FROM $${params.length}::text`);
      }
      // Compare-and-set in one statement: concurrent claimers cannot both win.
      const { rows } = await db.query<OpRow>(
        `UPDATE base_chain_ops SET ${sets.join(', ')}
         WHERE idempotency_key = $1 AND status = ANY($2::text[])
           ${guards.map((guard) => `AND ${guard}`).join(' ')} RETURNING ${OP_COLUMNS}`,
        params,
      );
      return rows[0] ? opView(rows[0]) : null;
    },
  };
}

interface KeyRow {
  key_id: string;
  kek_version: number;
  wrapped_dek: Uint8Array;
  ciphertext: Uint8Array;
  signer_address: string;
  created_at: string;
  committed_at: string | null;
}

const KEY_COLUMNS =
  'key_id, kek_version, wrapped_dek, ciphertext, signer_address, created_at::text AS created_at, committed_at::text AS committed_at';

/** Orphaned keys (never referenced by a wallet) older than this are deleted. */
export const ORPHAN_KEY_AGE_MS = 60 * 60 * 1000;

export function pgSpenderKeyStore(db: Database) {
  const store: SpenderKeyStore & {
    commit(keyRef: string, at?: number): Promise<void>;
    deleteOrphans(now?: number): Promise<number>;
  } = {
    async insert(row: StoredSpenderKey) {
      await db.query(
        `INSERT INTO base_spender_keys (key_id, kek_version, wrapped_dek, ciphertext, signer_address, committed_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          row.keyId,
          row.kekVersion,
          Buffer.from(row.wrappedDek),
          Buffer.from(row.ciphertext),
          row.signerAddress,
          row.committedAt,
          row.createdAt,
        ],
      );
    },

    async get(keyId: string) {
      const { rows } = await db.query<KeyRow>(
        `SELECT ${KEY_COLUMNS} FROM base_spender_keys WHERE key_id = $1`,
        [keyId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        keyId: row.key_id,
        kekVersion: row.kek_version,
        wrappedDek: new Uint8Array(row.wrapped_dek),
        ciphertext: new Uint8Array(row.ciphertext),
        signerAddress: getAddress(row.signer_address) as Address,
        createdAt: Number(row.created_at),
        committedAt: row.committed_at === null ? null : Number(row.committed_at),
      };
    },

    /** Marks a key as referenced by a wallet, so orphan cleanup never removes it. */
    async commit(keyRef: string, at = Date.now()) {
      const { keyId } = parseKeyRef(keyRef);
      await db.query(
        'UPDATE base_spender_keys SET committed_at = COALESCE(committed_at, $2) WHERE key_id = $1',
        [keyId, at],
      );
    },

    /** Deletes uncommitted keys older than an hour that no wallet references; returns the count. */
    async deleteOrphans(now = Date.now()) {
      const { rows } = await db.query<{ key_id: string }>(
        `DELETE FROM base_spender_keys k
         WHERE k.committed_at IS NULL AND k.created_at < $1
           AND NOT EXISTS (SELECT 1 FROM base_wallets w WHERE w.spender_key_ref LIKE '%:' || k.key_id)
         RETURNING k.key_id`,
        [now - ORPHAN_KEY_AGE_MS],
      );
      return rows.length;
    },
  };
  return store;
}

interface AuthorizationRow {
  payment_intent_id: string;
  chain_id: number;
  token: string;
  from_address: string;
  to_address: string;
  value: string;
  valid_after: string;
  valid_before: string;
  nonce: string;
  signature: Uint8Array;
}

const AUTHORIZATION_COLUMNS = `payment_intent_id, chain_id, token, from_address, to_address,
  value::text AS value, valid_after::text AS valid_after, valid_before::text AS valid_before,
  nonce, signature`;

/**
 * Restricted store for issued x402 authorizations (migration 82). Only the chain module reads
 * `base_x402_authorizations`; hex values are stored lowercase, so the table's uniqueness holds.
 */
export function pgAuthorizationStore(
  db: Database,
  now: () => number = Date.now,
): AuthorizationStore {
  async function get(paymentIntentId: string): Promise<IssuedAuthorization | null> {
    const { rows } = await db.query<AuthorizationRow>(
      `SELECT ${AUTHORIZATION_COLUMNS} FROM base_x402_authorizations WHERE payment_intent_id = $1`,
      [paymentIntentId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      paymentIntentId: row.payment_intent_id,
      chainId: row.chain_id,
      token: getAddress(row.token),
      authorization: {
        from: getAddress(row.from_address),
        to: getAddress(row.to_address),
        value: BigInt(row.value),
        validAfter: BigInt(row.valid_after),
        validBefore: BigInt(row.valid_before),
        nonce: row.nonce as Hex,
      },
      signature: `0x${Buffer.from(row.signature).toString('hex')}`,
    };
  }

  return {
    get,
    async insert(row) {
      const a = row.authorization;
      await db.query(
        `INSERT INTO base_x402_authorizations (payment_intent_id, chain_id, token, from_address,
           to_address, value, valid_after, valid_before, nonce, signature, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (payment_intent_id) DO NOTHING`,
        [
          row.paymentIntentId,
          row.chainId,
          row.token.toLowerCase(),
          a.from.toLowerCase(),
          a.to.toLowerCase(),
          a.value.toString(10),
          a.validAfter.toString(10),
          a.validBefore.toString(10),
          a.nonce.toLowerCase(),
          Buffer.from(row.signature.slice(2), 'hex'),
          now(),
        ],
      );
      // Whether this call or a concurrent one won, return what is stored for the intent.
      const stored = await get(row.paymentIntentId);
      if (!stored) throw new Error('Authorization could not be stored.');
      return stored;
    },
  };
}

/**
 * Reads one stored operation inside the caller's transaction and holds a shared row lock on it
 * until that transaction ends, so a concurrent finality update waits until the caller has acted on
 * what it read. Stored state only: no RPC, no writes.
 */
export async function readOperationForShare(
  tx: Pick<Transaction, 'query'>,
  key: string,
): Promise<StoredOperation | null> {
  const { rows } = await tx.query<OpRow>(
    `SELECT ${OP_COLUMNS} FROM base_chain_ops WHERE idempotency_key = $1 FOR SHARE`,
    [key],
  );
  return rows[0] ? opView(rows[0]) : null;
}
