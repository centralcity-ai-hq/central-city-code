import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import type { Database } from '../../database.js';
import type { Migration } from '../../migrations.js';
import { receivePaymentProven, type ReceiveEvidence } from './receive-evidence.js';

export const RECEIVE_SQL = `
CREATE TABLE IF NOT EXISTS base_x402_receipts (
  receipt_id text PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  resource text NOT NULL CHECK (length(resource) BETWEEN 1 AND 2048),
  chain_id integer NOT NULL CHECK (chain_id IN (8453,84532)),
  token text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  payer text NOT NULL CHECK (payer ~ '^0x[0-9a-f]{40}$'),
  nonce text NOT NULL CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
  recipient text NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{40}$'),
  amount numeric(78,0) NOT NULL CHECK (amount > 0),
  state text NOT NULL CHECK (state IN ('claimed','reconciling','paid','failed')),
  transaction_hash text CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (chain_id, token, payer, nonce)
);
CREATE INDEX IF NOT EXISTS base_x402_receipts_open ON base_x402_receipts(chain_id,state)
  WHERE state IN ('claimed','reconciling');
CREATE OR REPLACE FUNCTION base_x402_receipt_binding_immutable() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.receipt_id,NEW.operator_id,NEW.resource,NEW.chain_id,NEW.token,NEW.payer,
         NEW.nonce,NEW.recipient,NEW.amount,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.receipt_id,OLD.operator_id,OLD.resource,OLD.chain_id,OLD.token,OLD.payer,
         OLD.nonce,OLD.recipient,OLD.amount,OLD.created_at) THEN
    RAISE EXCEPTION 'Receive binding is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS base_x402_receipt_binding_guard ON base_x402_receipts;
CREATE TRIGGER base_x402_receipt_binding_guard BEFORE UPDATE ON base_x402_receipts
  FOR EACH ROW EXECUTE FUNCTION base_x402_receipt_binding_immutable();`;

// Persistence only; receive routes remain separately gated and unwired.
export const receiveMigration: Migration = {
  version: 84,
  name: 'base_x402_receive_attempts',
  sql: RECEIVE_SQL,
};

/**
 * Migration 86: what a reconciler needs to end a claim without a transaction. valid_before is the
 * authorization's EIP-3009 deadline (seconds); search_from_block is where the on-chain search for
 * its AuthorizationUsed event starts. Both are write-once; NULL means "never conclude absence".
 */
export const RECEIVE_RECONCILE_SQL = `
ALTER TABLE base_x402_receipts
  ADD COLUMN IF NOT EXISTS valid_before numeric(78,0) CHECK (valid_before >= 0),
  ADD COLUMN IF NOT EXISTS search_from_block bigint CHECK (search_from_block >= 0);
CREATE OR REPLACE FUNCTION base_x402_receipt_binding_immutable() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.receipt_id,NEW.operator_id,NEW.resource,NEW.chain_id,NEW.token,NEW.payer,
         NEW.nonce,NEW.recipient,NEW.amount,NEW.created_at,NEW.valid_before,NEW.search_from_block)
     IS DISTINCT FROM
     ROW(OLD.receipt_id,OLD.operator_id,OLD.resource,OLD.chain_id,OLD.token,OLD.payer,
         OLD.nonce,OLD.recipient,OLD.amount,OLD.created_at,OLD.valid_before,OLD.search_from_block) THEN
    RAISE EXCEPTION 'Receive binding is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`;

export const receiveReconcileMigration: Migration = {
  version: 86,
  name: 'base_x402_receive_reconcile',
  sql: RECEIVE_RECONCILE_SQL,
};

/** Recorded at claim time so a claim without a transaction can later be reconciled on chain. */
export interface ReceiveTerms {
  validBefore: string | null;
  searchFromBlock: bigint | null;
}

export interface ReceiveBinding {
  workspaceId: string;
  resource: string;
  chainId: number;
  token: string;
  payer: string;
  nonce: string;
  recipient: string;
  amount: string;
}

function canonical(input: ReceiveBinding): ReceiveBinding {
  if (
    ![8453, 84532].includes(input.chainId) ||
    !input.workspaceId ||
    !input.resource ||
    !/^0x[0-9a-fA-F]{64}$/.test(input.nonce) ||
    !/^[1-9][0-9]{0,77}$/.test(input.amount) ||
    BigInt(input.amount) >= 1n << 256n
  )
    throw new Error('INVALID_RECEIVE_BINDING');
  return {
    ...input,
    token: getAddress(input.token).toLowerCase(),
    payer: getAddress(input.payer).toLowerCase(),
    recipient: getAddress(input.recipient).toLowerCase(),
    nonce: input.nonce.toLowerCase(),
  };
}

interface Row {
  receipt_id: string;
  operator_id: string;
  resource: string;
  recipient: string;
  amount: string;
  state: 'claimed' | 'reconciling' | 'paid' | 'failed';
  transaction_hash: string | null;
}

/** Only the insert winner may call settle. A crash never makes a claim reusable. */
export function createReceiveStore(db: Database, now = Date.now) {
  return {
    async find(input: ReceiveBinding) {
      const b = canonical(input);
      const { rows } = await db.query<Row>(
        `SELECT receipt_id,operator_id,resource,recipient,amount::text,state,transaction_hash
         FROM base_x402_receipts WHERE chain_id=$1 AND token=$2 AND payer=$3 AND nonce=$4`,
        [b.chainId, b.token, b.payer, b.nonce],
      );
      const row = rows[0];
      if (!row) return null;
      if (
        row.operator_id !== b.workspaceId ||
        row.resource !== b.resource ||
        row.recipient !== b.recipient ||
        row.amount !== b.amount
      )
        throw new Error('RECEIVE_BINDING_CONFLICT');
      return {
        receiptId: row.receipt_id,
        acquired: false,
        state: row.state,
        transaction: row.transaction_hash,
      };
    },
    async claim(
      input: ReceiveBinding,
      terms: ReceiveTerms = { validBefore: null, searchFromBlock: null },
    ) {
      const b = canonical(input);
      if (
        (terms.validBefore !== null &&
          (!/^(0|[1-9][0-9]{0,77})$/.test(terms.validBefore) ||
            BigInt(terms.validBefore) >= 1n << 256n)) ||
        (terms.searchFromBlock !== null &&
          (terms.searchFromBlock < 0n || terms.searchFromBlock >= 1n << 63n))
      )
        throw new Error('INVALID_RECEIVE_BINDING');
      return db.transaction(async (tx) => {
        const inserted = await tx.query<Row>(
          `INSERT INTO base_x402_receipts
           (receipt_id,operator_id,resource,chain_id,token,payer,nonce,recipient,amount,state,
            created_at,updated_at,valid_before,search_from_block)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'claimed',$10,$10,$11::numeric,$12::bigint)
           ON CONFLICT (chain_id,token,payer,nonce) DO NOTHING RETURNING receipt_id`,
          [
            randomUUID(),
            b.workspaceId,
            b.resource,
            b.chainId,
            b.token,
            b.payer,
            b.nonce,
            b.recipient,
            b.amount,
            now(),
            terms.validBefore,
            terms.searchFromBlock?.toString() ?? null,
          ],
        );
        const { rows } = await tx.query<Row>(
          `SELECT receipt_id,operator_id,resource,recipient,amount::text,state,transaction_hash
           FROM base_x402_receipts WHERE chain_id=$1 AND token=$2 AND payer=$3 AND nonce=$4 FOR UPDATE`,
          [b.chainId, b.token, b.payer, b.nonce],
        );
        const row = rows[0];
        if (
          !row ||
          row.operator_id !== b.workspaceId ||
          row.resource !== b.resource ||
          row.recipient !== b.recipient ||
          row.amount !== b.amount
        )
          throw new Error('RECEIVE_BINDING_CONFLICT');
        return {
          receiptId: row.receipt_id,
          acquired: inserted.rows.length === 1,
          state: row.state,
          transaction: row.transaction_hash,
        };
      });
    },
    // Facilitator success alone is NOT a paid state; only canonical receipt verification can pay.
    async reconcile(workspaceId: string, receiptId: string, transaction: string | null) {
      if (transaction !== null && !/^0x[0-9a-fA-F]{64}$/.test(transaction))
        throw new Error('INVALID_TRANSACTION');
      const hash = transaction?.toLowerCase() ?? null;
      const result = await db.query(
        `UPDATE base_x402_receipts SET state='reconciling',
           transaction_hash=COALESCE(transaction_hash,$3),updated_at=$4
         WHERE operator_id=$1 AND receipt_id=$2 AND state IN ('claimed','reconciling')
           AND (transaction_hash IS NULL OR $3::text IS NULL OR transaction_hash=$3)
         RETURNING receipt_id`,
        [workspaceId, receiptId, hash, now()],
      );
      return result.rows.length === 1;
    },
    /** The stored claim as a reconciler sees it; null when this workspace has no such receipt. */
    async load(workspaceId: string, receiptId: string) {
      const { rows } = await db.query<
        Row & {
          chain_id: number;
          token: string;
          payer: string;
          nonce: string;
          valid_before: string | null;
          search_from_block: string | null;
        }
      >(
        `SELECT receipt_id,operator_id,resource,chain_id,token,payer,nonce,recipient,amount::text,
           state,transaction_hash,valid_before::text,search_from_block::text
         FROM base_x402_receipts WHERE operator_id=$1 AND receipt_id=$2`,
        [workspaceId, receiptId],
      );
      const row = rows[0];
      if (!row) return null;
      const binding: ReceiveBinding = {
        workspaceId: row.operator_id,
        resource: row.resource,
        chainId: Number(row.chain_id),
        token: row.token,
        payer: row.payer,
        nonce: row.nonce,
        recipient: row.recipient,
        amount: row.amount,
      };
      return {
        binding,
        receiptId: row.receipt_id,
        state: row.state,
        transaction: row.transaction_hash,
        validBefore: row.valid_before,
        searchFromBlock: row.search_from_block === null ? null : BigInt(row.search_from_block),
      };
    },
    /**
     * Ends a claim that can never be paid. Only a claim without a transaction may fail: a recorded
     * transaction is resolved by its receipt, never by absence.
     */
    async markFailed(workspaceId: string, receiptId: string) {
      const result = await db.query(
        `UPDATE base_x402_receipts SET state='failed',updated_at=$3
         WHERE operator_id=$1 AND receipt_id=$2 AND state IN ('claimed','reconciling')
           AND transaction_hash IS NULL
         RETURNING receipt_id`,
        [workspaceId, receiptId, now()],
      );
      return result.rows.length === 1;
    },
    /** Only independently proven evidence can pay the exact durable claim. Never rebind a tx. */
    async markPaid(input: ReceiveBinding, receiptId: string, evidence: ReceiveEvidence) {
      const b = canonical(input);
      if (!receivePaymentProven(b, evidence)) return false;
      const result = await db.query(
        `UPDATE base_x402_receipts SET state='paid',updated_at=$11
         WHERE receipt_id=$1 AND operator_id=$2 AND resource=$3 AND chain_id=$4
           AND token=$5 AND payer=$6 AND nonce=$7 AND recipient=$8 AND amount=$9::numeric
           AND transaction_hash=$10 AND state IN ('reconciling','paid')
         RETURNING receipt_id`,
        [
          receiptId,
          b.workspaceId,
          b.resource,
          b.chainId,
          b.token,
          b.payer,
          b.nonce,
          b.recipient,
          b.amount,
          evidence.transaction.toLowerCase(),
          now(),
        ],
      );
      return result.rows.length === 1;
    },
  };
}
