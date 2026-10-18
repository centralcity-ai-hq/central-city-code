/*
 * The one balance-reservation ledger (docs/base/ARCHITECTURE.md §11.4, migration 79), owned by
 * the chain module and used by payments and bulk provisioning alike. A reservation holds an amount
 * of one token on one wallet for one holder (a payment or a provisioning job):
 *
 *   held ──consume(operationKey)──▶ consumed      (the operation that spent it is final)
 *     └────release()──────▶ released      (only after definitive reconciliation)
 *
 * reserve() runs inside the caller's transaction and fails closed: the wallet row is locked
 * (SELECT … FOR UPDATE) so concurrent reserves serialize, then on-chain balance minus everything
 * still held must cover the amount. The same holder reserving again is idempotent; a different
 * amount or intent for the same holder is refused. Nothing is ever released on a timeout alone.
 *
 * Bulk provisioning reserves per batch, not per job: holder ref `<jobId>:<batchNo>` (immutable);
 * one batch is one operation, so consuming the whole reservation with that operation is exact.
 * The job ceiling across batches is the provisioning module's own ledger, checked before each
 * batch reserve. Payments inside a job reference the batch reservation and never reserve again.
 */
import { randomUUID } from 'node:crypto';
import type { Transaction } from '../../database.js';
import type { Address } from '../../../shared/base/chains.js';

/**
 * `withdrawal`: an owner withdrawal (migration 89), holder ref = the withdrawal id. `float`: a Feed
 * pay float top-up (migration 110), holder ref = its operation key; it moves the agent's USDC into
 * its own spender account, so the calendar counter never counts it.
 */
export type HolderKind = 'payment' | 'fleet_job' | 'withdrawal' | 'float';
export type ReservationState = 'held' | 'consumed' | 'released';

/**
 * What a wallet cannot spend of a token at a balance read at `blockNumber`: everything held, plus
 * every consumed reservation whose operation is not visibly debited in that read (no block yet, or
 * a block newer than the read). A lagging RPC can therefore never give spent funds back.
 */
export async function unavailableAmount(
  tx: Pick<Transaction, 'query'>,
  input: { walletId: string; token: Address; blockNumber: bigint },
): Promise<bigint> {
  const held = await tx.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(r.amount), 0)::text AS total
     FROM base_wallet_reservations r
     LEFT JOIN base_chain_ops o ON o.idempotency_key = r.op_id
     WHERE r.wallet_id = $1 AND lower(r.token) = $2
       AND (r.state = 'held'
         OR (r.state = 'consumed' AND (o.block_number IS NULL OR o.block_number > $3)))`,
    [input.walletId, input.token.toLowerCase(), input.blockNumber.toString(10)],
  );
  return BigInt(held.rows[0]?.total ?? '0');
}

export interface Reservation {
  reservationId: string;
  walletId: string;
  chainId: number;
  token: Address;
  amount: bigint;
  holderKind: HolderKind;
  holderRef: string;
  intentHash: string;
  state: ReservationState;
  /** The idempotency key (base_chain_ops.idempotency_key) of the operation that spent it. */
  operationKey: string | null;
}

export class ReservationError extends Error {
  constructor(
    readonly code:
      | 'WALLET_NOT_FOUND'
      | 'INSUFFICIENT_BALANCE'
      | 'RESERVATION_CONFLICT'
      | 'RESERVATION_NOT_FOUND'
      | 'INVALID_TRANSITION'
      | 'INVALID_AMOUNT'
      | 'RESERVATION_CLOSED'
      | 'WRONG_NETWORK',
    message: string,
  ) {
    super(message);
  }
}

interface Row {
  reservation_id: string;
  wallet_id: string;
  chain_id: number;
  token: string;
  amount: string;
  holder_kind: HolderKind;
  holder_ref: string;
  intent_hash: string;
  state: ReservationState;
  op_id: string | null;
}

const COLUMNS =
  'reservation_id, wallet_id, chain_id, token, amount::text AS amount, holder_kind, holder_ref, intent_hash, state, op_id';

const view = (row: Row): Reservation => ({
  reservationId: row.reservation_id,
  walletId: row.wallet_id,
  chainId: row.chain_id,
  token: row.token as Address,
  amount: BigInt(row.amount),
  holderKind: row.holder_kind,
  holderRef: row.holder_ref,
  intentHash: row.intent_hash,
  state: row.state,
  operationKey: row.op_id,
});

export interface ReservationDeps {
  /** The one network this ledger instance serves; its balanceOf reads that network only. */
  chainId: number;
  /**
   * On-chain balance of a wallet address in a token (native ETH as the allowlisted constant), with
   * the block it was read at. A stale read is safe: spends final after that block still count.
   */
  balanceOf(address: Address, token: Address): Promise<{ balance: bigint; blockNumber: bigint }>;
  now?: () => number;
}

export interface ReserveInput {
  walletId: string;
  chainId: number;
  token: Address;
  amount: bigint;
  holder: { kind: HolderKind; ref: string };
  intentHash: string;
}

export function createReservationLedger(deps: ReservationDeps) {
  const now = deps.now ?? Date.now;

  async function load(tx: Transaction, reservationId: string): Promise<Row> {
    const { rows } = await tx.query<Row>(
      `SELECT ${COLUMNS} FROM base_wallet_reservations WHERE reservation_id = $1 FOR UPDATE`,
      [reservationId],
    );
    if (!rows[0]) throw new ReservationError('RESERVATION_NOT_FOUND', 'No such reservation.');
    return rows[0];
  }

  return {
    /**
     * Holds `amount` for the holder, or returns its existing identical reservation while it is still
     * held. A consumed or released reservation is never handed back as if it were new: that refuses
     * with RESERVATION_CLOSED, so a retry can only reconcile, never authorize another send.
     */
    async reserve(tx: Transaction, input: ReserveInput): Promise<Reservation> {
      if (input.chainId !== deps.chainId)
        throw new ReservationError('WRONG_NETWORK', 'This ledger serves another network.');
      if (input.amount <= 0n || input.amount >= 2n ** 256n)
        throw new ReservationError('INVALID_AMOUNT', 'Amount must be a positive integer.');
      const token = input.token.toLowerCase();

      // Serialize every reserve on this wallet: concurrent callers wait here.
      const wallet = await tx.query<{ address: string }>(
        'SELECT address FROM base_wallets WHERE wallet_id = $1 AND chain_id = $2 FOR UPDATE',
        [input.walletId, input.chainId],
      );
      if (!wallet.rows[0])
        throw new ReservationError('WALLET_NOT_FOUND', 'No such wallet on this chain.');

      const existing = await tx.query<Row>(
        `SELECT ${COLUMNS} FROM base_wallet_reservations
         WHERE holder_kind = $1 AND holder_ref = $2 AND wallet_id = $3 AND lower(token) = $4`,
        [input.holder.kind, input.holder.ref, input.walletId, token],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (BigInt(row.amount) !== input.amount || row.intent_hash !== input.intentHash)
          throw new ReservationError(
            'RESERVATION_CONFLICT',
            'This holder already reserved a different amount or intent.',
          );
        if (row.state !== 'held')
          throw new ReservationError(
            'RESERVATION_CLOSED',
            `This holder's reservation is already ${row.state}; reconcile, do not send again.`,
          );
        return view(row);
      }

      // Read the balance first, then subtract what is unavailable at that read.
      const { balance, blockNumber } = await deps.balanceOf(
        wallet.rows[0].address as Address,
        input.token,
      );
      const held = await unavailableAmount(tx, {
        walletId: input.walletId,
        token: input.token,
        blockNumber,
      });
      if (balance - held < input.amount)
        throw new ReservationError(
          'INSUFFICIENT_BALANCE',
          'Balance minus held reservations does not cover the amount.',
        );

      const at = now();
      const { rows } = await tx.query<Row>(
        `INSERT INTO base_wallet_reservations (reservation_id, wallet_id, chain_id, token, amount,
           holder_kind, holder_ref, intent_hash, state, op_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'held',NULL,$9,$9)
         RETURNING ${COLUMNS}`,
        [
          randomUUID(),
          input.walletId,
          input.chainId,
          token,
          input.amount.toString(10),
          input.holder.kind,
          input.holder.ref,
          input.intentHash,
          at,
        ],
      );
      return view(rows[0]);
    },

    /** Marks a held reservation as spent by the (final) operation; idempotent for the same op. */
    /** `operationKey` is the operation's idempotency key, never the base_chain_ops row id. */
    async consume(
      tx: Transaction,
      reservationId: string,
      operationKey: string,
    ): Promise<Reservation> {
      const row = await load(tx, reservationId);
      if (row.state === 'consumed' && row.op_id === operationKey) return view(row);
      if (row.state !== 'held')
        throw new ReservationError(
          'INVALID_TRANSITION',
          `Cannot consume a ${row.state} reservation.`,
        );
      const { rows } = await tx.query<Row>(
        `UPDATE base_wallet_reservations SET state = 'consumed', op_id = $2, updated_at = $3
         WHERE reservation_id = $1 RETURNING ${COLUMNS}`,
        [reservationId, operationKey, now()],
      );
      return view(rows[0]);
    },

    /**
     * Releases a held reservation. Callers release only after definitive reconciliation (the
     * operation is known never to land, or was refused before broadcast); never on a timeout.
     */
    async release(tx: Transaction, reservationId: string): Promise<Reservation> {
      const row = await load(tx, reservationId);
      if (row.state === 'released') return view(row);
      if (row.state !== 'held')
        throw new ReservationError(
          'INVALID_TRANSITION',
          `Cannot release a ${row.state} reservation.`,
        );
      const { rows } = await tx.query<Row>(
        `UPDATE base_wallet_reservations SET state = 'released', updated_at = $2
         WHERE reservation_id = $1 RETURNING ${COLUMNS}`,
        [reservationId, now()],
      );
      return view(rows[0]);
    },
  };
}
