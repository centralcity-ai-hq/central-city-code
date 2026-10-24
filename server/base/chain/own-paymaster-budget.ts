/*
 * Operation Paymaster's spending gate (a 0.2 ETH envelope: 0.05 ETH protected for
 * withdrawals/revokes/cancels, at most 0.15 ETH for deploy, canary and normal work; 0.01
 * ETH/h ordinary). Every sponsorship reserves its WORST-CASE cost before its signature is handed
 * out, atomically under one row lock shared by every server instance, so two requests can never
 * spend the same headroom. The worst case is what EntryPoint v0.6 may charge a sponsored operation
 * (submit.ts maxCostWei with a paymaster: verificationGasLimit counts three times):
 *
 *   worst case = (callGasLimit + 3 × verificationGasLimit + preVerificationGas) × maxFeePerGas
 *
 * An ordinary flow is admitted only if, counting every reservation still outstanding:
 *   overhead + ordinary settled + ordinary outstanding + worst case <= ordinaryCeiling (0.93 ETH)
 *   ordinary in the last hour (settled actual + outstanding worst case) + worst case <= hourly (0.1)
 *   free - worst case >= protected (0.05 ETH)
 * A protected flow (exit) only needs free - worst case >= 0, where
 *   free = deposit@block - outstanding - settled after block
 *
 * `deposit@block` is the paymaster's EntryPoint deposit read from Base at a known block (the truth:
 * what executed up to that block is gone from it), read inside the lock. Outstanding reservations may
 * still execute, so they are subtracted. A reservation settled by a receipt in a LATER block was still
 * in that deposit reading, so it is subtracted too (coherent with the block, never double-spendable);
 * one settled at or before the block is already out of it. An operation that executed but whose
 * receipt is not settled yet is counted twice (outstanding and gone from the deposit): conservative.
 * `overhead` is the envelope's gas spent outside the paymaster (deploy, allowlist, submitter float,
 * failed submitter transactions), entered by the operator (recordOverhead) so 0.15 counts it once.
 *
 * Lifecycle: 'reserved' when the signature is handed out, 'sent' once the submitter stored a
 * transaction carrying it, 'settled' with its actual cost and block from the receipt, or 'expired'
 * when it was never sent and EXPIRY_MARGIN_S has passed after its validUntil (EntryPoint refuses it
 * after validUntil: AA32; the margin covers clock skew). A late receipt still settles an expired one.
 * A 'sent' reservation is never expired by time.
 */
import type { UserOperation } from 'viem/account-abstraction';
import type { Database, Transaction } from '../../database.js';
import { registerMigration, type Migration } from '../../migrations.js';
import { PROTECTED_FLOWS, type SponsorFlow } from './own-paymaster-policy.js';
import { maxCostWei } from './submit.js';

/** Every table Operation Paymaster adds (migrations 256-257), for the backup's recognized list. */
export const OWN_PAYMASTER_TABLES = [
  'own_paymaster_keys',
  'own_paymaster_budget',
  'own_paymaster_reservations',
] as const;

export const OWN_PAYMASTER_BUDGET_SQL = `
CREATE TABLE IF NOT EXISTS own_paymaster_budget (
  id integer PRIMARY KEY CHECK (id = 1),
  overhead_wei numeric(78,0) NOT NULL DEFAULT 0 CHECK (overhead_wei >= 0),
  updated_at bigint NOT NULL
);
INSERT INTO own_paymaster_budget (id, overhead_wei, updated_at) VALUES (1, 0, 0) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS own_paymaster_reservations (
  user_op_hash text PRIMARY KEY CHECK (user_op_hash ~ '^0x[0-9a-f]{64}$'),
  flow text NOT NULL,
  protected boolean NOT NULL,
  max_cost_wei numeric(78,0) NOT NULL CHECK (max_cost_wei > 0),
  actual_cost_wei numeric(78,0) CHECK (actual_cost_wei IS NULL OR actual_cost_wei >= 0),
  settled_block numeric(78,0),
  status text NOT NULL CHECK (status IN ('reserved','sent','settled','expired')),
  valid_until bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CHECK ((status = 'settled') = (actual_cost_wei IS NOT NULL AND settled_block IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS own_paymaster_reservations_open ON own_paymaster_reservations (status)
  WHERE status IN ('reserved','sent');
CREATE INDEX IF NOT EXISTS own_paymaster_reservations_recent ON own_paymaster_reservations (created_at);
CREATE INDEX IF NOT EXISTS own_paymaster_reservations_settled ON own_paymaster_reservations (settled_block)
  WHERE status = 'settled';
`;

/** Migration 257: two new tables (the gate's lock row and its reservations); nothing else touched. */
export const ownPaymasterBudgetMigration: Migration = {
  version: 257,
  name: 'own_paymaster_budget',
  sql: OWN_PAYMASTER_BUDGET_SQL,
};
export function registerOwnPaymasterBudgetMigration(): void {
  registerMigration(ownPaymasterBudgetMigration);
}

export interface BudgetLimits {
  /** Ordinary work (everything but exits) plus overhead, in total. */
  ordinaryCeilingWei: bigint;
  /** Ordinary work per rolling hour. */
  hourlyOrdinaryWei: bigint;
  /** Deposit kept for exits only. */
  protectedWei: bigint;
}
const ETH = 10n ** 18n;
/**
 * What the admin wallet already paid out of the ordinary 0.15 ETH before this budget existed: the gas
 * of the paymaster deploy, the submitter allowlist and the three funding transfers, in exact wei from
 * their Base receipts (L2 + L1). The ceiling is inclusive of it, so it is subtracted, never re-granted.
 */
export const PRIOR_ORDINARY_FEES_WEI = 20_773_789_406_452n;
export const BUDGET_LIMITS: BudgetLimits = {
  ordinaryCeilingWei: (93n * ETH) / 100n - PRIOR_ORDINARY_FEES_WEI, // 0.929979226210593548 ETH (24 Oct: deposit topped up to 0.988)
  hourlyOrdinaryWei: ETH / 10n, // 0.1 ETH (24 Oct: worst-case accounting; backlog mints + hand-overs + 500/h + 50 ratings/h; real spend ~0.003 ETH/h)
  protectedWei: (5n * ETH) / 100n, // 0.05 ETH
};
/** Seconds after validUntil before a never-sent reservation lapses (clock skew between us and Base). */
export const EXPIRY_MARGIN_S = 120;

export type BudgetRefusal = 'ordinary_ceiling' | 'hourly' | 'protected_reserve' | 'deposit';
export class BudgetError extends Error {
  constructor(readonly reason: BudgetRefusal) {
    super(`Sponsorship refused by the budget (${reason}).`);
  }
}

/** Whether a refusal is a cap that frees up later (retry later), never a policy denial. */
export const budgetTransient = (reason: BudgetRefusal) => reason !== 'deposit';

/** What EntryPoint v0.6 may charge for the operation once it carries our paymaster (× 3 verification). */
export function worstCaseWei(
  op: Pick<
    UserOperation<'0.6'>,
    'callGasLimit' | 'verificationGasLimit' | 'preVerificationGas' | 'maxFeePerGas'
  >,
): bigint {
  return maxCostWei({ ...(op as UserOperation<'0.6'>), paymasterAndData: '0x01' });
}

/** The paymaster's EntryPoint deposit at a block (EntryPoint.balanceOf(paymaster), blockTag). */
export interface DepositReading {
  wei: bigint;
  block: bigint;
}

interface Sums {
  overhead: bigint;
  ordinaryDone: bigint;
  ordinaryOpen: bigint;
  hourOrdinary: bigint;
  allOpen: bigint;
  settledAfter: bigint;
}

async function sums(tx: Transaction, now: number, afterBlock: bigint): Promise<Sums> {
  const { rows } = await tx.query<Record<keyof Sums, string>>(
    `SELECT
       (SELECT overhead_wei FROM own_paymaster_budget WHERE id = 1)::text AS "overhead",
       COALESCE(SUM(actual_cost_wei) FILTER (WHERE NOT protected AND status = 'settled'), 0)::text AS "ordinaryDone",
       COALESCE(SUM(max_cost_wei) FILTER (WHERE NOT protected AND status IN ('reserved','sent')), 0)::text AS "ordinaryOpen",
       COALESCE(SUM(CASE WHEN status = 'settled' THEN actual_cost_wei ELSE max_cost_wei END)
         FILTER (WHERE NOT protected AND status <> 'expired' AND created_at > $1), 0)::text AS "hourOrdinary",
       COALESCE(SUM(max_cost_wei) FILTER (WHERE status IN ('reserved','sent')), 0)::text AS "allOpen",
       COALESCE(SUM(actual_cost_wei) FILTER (WHERE status = 'settled' AND settled_block > $2), 0)::text AS "settledAfter"
     FROM own_paymaster_reservations`,
    [now - 3_600_000, afterBlock.toString()],
  );
  const r = rows[0]!;
  return {
    overhead: BigInt(r.overhead ?? '0'),
    ordinaryDone: BigInt(r.ordinaryDone),
    ordinaryOpen: BigInt(r.ordinaryOpen),
    hourOrdinary: BigInt(r.hourOrdinary),
    allOpen: BigInt(r.allOpen),
    settledAfter: BigInt(r.settledAfter),
  };
}

/** markSent on a reservation that is no longer open: the operation must not be broadcast. */
export class ReservationGone extends Error {
  constructor() {
    super('The reservation is no longer open; do not send this operation.');
  }
}

export class ReservationConflict extends Error {
  constructor() {
    super('This operation was reserved with another flow or cost.');
  }
}

export function ownPaymasterBudget(deps: {
  db: Database;
  /** A FRESH read of the deposit at a known block (no cache): it is taken while holding the lock. */
  deposit: () => Promise<DepositReading>;
  limits?: BudgetLimits;
  now?: () => number;
}) {
  const limits = deps.limits ?? BUDGET_LIMITS;
  const now = deps.now ?? Date.now;

  /** Lapses reservations that were never sent and can no longer execute (validUntil + margin). */
  const expire = (tx: Transaction, at: number) =>
    tx.query(
      `UPDATE own_paymaster_reservations SET status = 'expired', updated_at = $1
       WHERE status = 'reserved' AND (valid_until + $2) * 1000 < $1`,
      [at, EXPIRY_MARGIN_S],
    );

  async function markSentIn(tx: Transaction, userOpHash: string): Promise<void> {
    const at = now();
    await tx.query('SELECT id FROM own_paymaster_budget WHERE id = 1 FOR UPDATE');
    await expire(tx, at);
    const moved = await tx.query(
      `UPDATE own_paymaster_reservations SET status = 'sent', updated_at = $2
       WHERE user_op_hash = $1 AND status IN ('reserved','sent') RETURNING user_op_hash`,
      [userOpHash.toLowerCase(), at],
    );
    if (moved.rows.length !== 1) throw new ReservationGone();
  }

  async function settleIn(
    tx: Transaction,
    userOpHash: string,
    actualCostWei: bigint,
    block: bigint,
  ): Promise<void> {
    if (actualCostWei < 0n) throw new Error('A cost is never negative.');
    await tx.query('SELECT id FROM own_paymaster_budget WHERE id = 1 FOR UPDATE');
    await tx.query(
      `UPDATE own_paymaster_reservations
         SET status = 'settled', actual_cost_wei = $2, settled_block = $3, updated_at = $4
       WHERE user_op_hash = $1 AND status IN ('reserved','sent','expired')`,
      [userOpHash.toLowerCase(), actualCostWei.toString(), block.toString(), now()],
    );
  }

  /**
   * The admission rules for `cost` more, under the lock, against a deposit read inside it: no
   * settlement can land between this reading and the decision. Throws BudgetError.
   */
  async function admit(tx: Transaction, at: number, isProtected: boolean, cost: bigint) {
    const deposit = await deps.deposit();
    const s = await sums(tx, at, deposit.block);
    const free = deposit.wei - s.allOpen - s.settledAfter - cost;
    if (free < 0n) throw new BudgetError('deposit');
    if (!isProtected) {
      if (s.overhead + s.ordinaryDone + s.ordinaryOpen + cost > limits.ordinaryCeilingWei)
        throw new BudgetError('ordinary_ceiling');
      if (s.hourOrdinary + cost > limits.hourlyOrdinaryWei) throw new BudgetError('hourly');
      if (free < limits.protectedWei) throw new BudgetError('protected_reserve');
    }
  }

  /**
   * The submitter's own exposure for one operation: what its handleOps transaction may
   * cost beyond the EntryPoint's repayment (gas limit x max fee + L1 data fee, the conservative
   * side). Reserved under `key` BEFORE the first broadcast and raised BEFORE a replacement is
   * signed: alternatives at one nonce count once, at their largest (only one can be mined), and
   * only the increase is admitted. Settled once, at the measured overhead (settleIn). It counts
   * against the deposit too, which only makes the gate more careful. Takes the budget lock; the
   * caller takes its lane lock after it.
   */
  async function exposeIn(
    tx: Transaction,
    input: { key: string; flow: SponsorFlow; maxCostWei: bigint },
  ): Promise<void> {
    const key = input.key.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(key)) throw new Error('An exposure key is 32 bytes.');
    if (input.maxCostWei <= 0n) throw new Error('An exposure costs more than 0.');
    const at = now();
    await tx.query('SELECT id FROM own_paymaster_budget WHERE id = 1 FOR UPDATE');
    await expire(tx, at);
    const known = await tx.query<{ max_cost_wei: string; status: string; protected: boolean }>(
      `SELECT max_cost_wei::text AS max_cost_wei, status, protected
       FROM own_paymaster_reservations WHERE user_op_hash = $1`,
      [key],
    );
    const row = known.rows[0];
    if (row) {
      if (row.status !== 'sent') throw new ReservationConflict();
      const old = BigInt(row.max_cost_wei);
      if (input.maxCostWei <= old) return;
      await admit(tx, at, row.protected, input.maxCostWei - old);
      await tx.query(
        'UPDATE own_paymaster_reservations SET max_cost_wei = $2, updated_at = $3 WHERE user_op_hash = $1',
        [key, input.maxCostWei.toString(), at],
      );
      return;
    }
    const isProtected = PROTECTED_FLOWS.has(input.flow);
    await admit(tx, at, isProtected, input.maxCostWei);
    await tx.query(
      `INSERT INTO own_paymaster_reservations
         (user_op_hash, flow, protected, max_cost_wei, status, valid_until, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'sent', 0, $5, $5)`,
      [key, input.flow, isProtected, input.maxCostWei.toString(), at],
    );
  }

  /**
   * Settles at the reservation's own worst case (max_cost_wei): an outcome nobody can measure (a
   * nonce consumed without any of our receipts) is never counted as free.
   */
  async function settleWorstIn(tx: Transaction, key: string, block: bigint): Promise<void> {
    await tx.query('SELECT id FROM own_paymaster_budget WHERE id = 1 FOR UPDATE');
    await tx.query(
      `UPDATE own_paymaster_reservations
         SET status = 'settled', actual_cost_wei = max_cost_wei, settled_block = $2, updated_at = $3
       WHERE user_op_hash = $1 AND status IN ('reserved','sent','expired')`,
      [key.toLowerCase(), block.toString(), now()],
    );
  }

  async function recordOverheadIn(tx: Transaction, wei: bigint): Promise<void> {
    if (wei < 0n) throw new Error('Overhead is never negative.');
    await tx.query(
      'UPDATE own_paymaster_budget SET overhead_wei = overhead_wei + $1, updated_at = $2 WHERE id = 1',
      [wei.toString(), now()],
    );
  }

  return {
    /**
     * Reserves the worst case of one sponsorship, or throws BudgetError. Call it BEFORE the
     * signature leaves the server. Idempotent per userOpHash (the same op asked again keeps its one
     * reservation); the same hash with another flow or cost is a ReservationConflict.
     */
    async reserve(input: {
      userOpHash: string;
      flow: SponsorFlow;
      maxCostWei: bigint;
      validUntil: number;
    }): Promise<void> {
      const hash = input.userOpHash.toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('userOpHash must be 32 bytes.');
      if (!Number.isSafeInteger(input.validUntil) || input.validUntil <= 0)
        throw new Error('validUntil must be whole seconds.');
      if (input.maxCostWei <= 0n) throw new Error('A reservation costs more than 0.');
      const isProtected = PROTECTED_FLOWS.has(input.flow);
      await deps.db.transaction(async (tx) => {
        const at = now();
        await tx.query('SELECT id FROM own_paymaster_budget WHERE id = 1 FOR UPDATE');
        await expire(tx, at);
        const known = await tx.query<{
          flow: string;
          max_cost_wei: string;
          valid_until: string;
          status: string;
        }>(
          `SELECT flow, max_cost_wei::text AS max_cost_wei, valid_until::text AS valid_until, status
           FROM own_paymaster_reservations WHERE user_op_hash = $1`,
          [hash],
        );
        if (known.rows.length) {
          // The same operation asked again: only an exact, still-open reservation is its own;
          // an expired or settled one is never revived (its headroom may be someone else's now).
          const row = known.rows[0]!;
          if (
            row.flow !== input.flow ||
            BigInt(row.max_cost_wei) !== input.maxCostWei ||
            Number(row.valid_until) !== input.validUntil ||
            !(row.status === 'reserved' || row.status === 'sent')
          )
            throw new ReservationConflict();
          return;
        }
        const cost = input.maxCostWei;
        await admit(tx, at, isProtected, cost);
        await tx.query(
          `INSERT INTO own_paymaster_reservations
             (user_op_hash, flow, protected, max_cost_wei, status, valid_until, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'reserved', $5, $6, $6)`,
          [hash, input.flow, isProtected, cost.toString(), input.validUntil, at],
        );
      });
    },

    /**
     * The submitter is about to store and broadcast a transaction carrying it: from now on it is
     * never expired by time. Call it BEFORE the broadcast; it throws ReservationGone when the
     * reservation is no longer open (expired: its headroom may already be someone else's), and
     * then the operation must NOT be sent (re-sponsor it instead). Under the lock, so it cannot
     * interleave with an expiry or an admission.
     */
    async markSent(userOpHash: string): Promise<void> {
      await deps.db.transaction((tx) => markSentIn(tx, userOpHash));
    },

    /**
     * A reservation's status, read under the lock after the expiry sweep (undefined: none). Every
     * markSentIn commits under the same lock and only moves 'reserved' or 'sent', so 'expired' (or
     * no reservation) here proves no transaction carrying it was ever stored or ever can be.
     */
    async lapsedState(userOpHash: string): Promise<string | undefined> {
      return deps.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM own_paymaster_budget WHERE id = 1 FOR UPDATE');
        await expire(tx, now());
        const row = await tx.query<{ status: string }>(
          'SELECT status FROM own_paymaster_reservations WHERE user_op_hash = $1',
          [userOpHash.toLowerCase()],
        );
        return row.rows[0]?.status;
      });
    },

    /**
     * markSent inside the caller's transaction: the submitter commits this move and
     * the signed transaction that carries the operation together, or neither. Takes the budget
     * lock first; callers take any lock of their own after it (one lock order, no deadlock).
     */
    markSentIn,

    /** settle inside the caller's transaction (the submitter's receipt bookkeeping). */
    settleIn,

    /** The submitter's exposure inside the caller's transaction (see exposeIn). */
    exposeIn,

    /** settle at the worst case, inside the caller's transaction (see settleWorstIn). */
    settleWorstIn,

    /**
     * Moves a still-open reservation to another key: the service reserves under the
     * paymaster digest BEFORE it signs, then re-keys to the userOpHash the signature produced.
     * Idempotent (already moved: nothing to do); a reservation that lapsed in between is
     * ReservationGone, and the signed operation must not be handed out.
     */
    async rekey(from: string, to: string): Promise<void> {
      const source = from.toLowerCase();
      const target = to.toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(source) || !/^0x[0-9a-f]{64}$/.test(target))
        throw new Error('Reservation keys are 32 bytes.');
      await deps.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM own_paymaster_budget WHERE id = 1 FOR UPDATE');
        await expire(tx, now());
        const moved = await tx.query(
          `UPDATE own_paymaster_reservations SET user_op_hash = $2, updated_at = $3
           WHERE user_op_hash = $1 AND status = 'reserved' RETURNING user_op_hash`,
          [source, target, now()],
        );
        if (moved.rows.length) return;
        const there = await tx.query<{ status: string }>(
          'SELECT status FROM own_paymaster_reservations WHERE user_op_hash = $1',
          [target],
        );
        const status = there.rows[0]?.status;
        if (status !== 'reserved' && status !== 'sent') throw new ReservationGone();
      });
    },

    /** recordOverhead inside the caller's transaction (a reverted submitter transaction's gas). */
    recordOverheadIn,

    /**
     * The receipt: actualGasCost and its block (a conclusively failed transaction that never
     * included the operation settles at 0 in the block that proves it). Under the lock, so a
     * reservation never leaves "outstanding" while a reserve() decides. Settles expired ones too.
     */
    async settle(userOpHash: string, actualCostWei: bigint, block: bigint): Promise<void> {
      await deps.db.transaction((tx) => settleIn(tx, userOpHash, actualCostWei, block));
    },

    /** Envelope gas spent outside the paymaster (deploy, allowlist, failed submitter txs). */
    async recordOverhead(wei: bigint): Promise<void> {
      await deps.db.transaction((tx) => recordOverheadIn(tx, wei));
    },

    /** For the monitor: where the envelope stands right now. */
    async snapshot() {
      return deps.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM own_paymaster_budget WHERE id = 1 FOR UPDATE');
        await expire(tx, now());
        const deposit = await deps.deposit();
        const s = await sums(tx, now(), deposit.block);
        return {
          depositWei: deposit.wei,
          depositBlock: deposit.block,
          freeWei: deposit.wei - s.allOpen - s.settledAfter,
          openWei: s.allOpen,
          ordinarySpentWei: s.overhead + s.ordinaryDone,
          ordinaryOpenWei: s.ordinaryOpen,
          lastHourOrdinaryWei: s.hourOrdinary,
          limits,
        };
      });
    },
  };
}
