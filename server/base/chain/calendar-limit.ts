/*
 * The Berlin calendar counter of a spending limit (Operation Base Wallet W3, contract v1.3). Base
 * enforces the owner-signed spend permission per FIXED on-chain period; on top of that Central City
 * refuses an agent spend that would take the agent past the owner's cap within the current Berlin
 * calendar day, week (from Monday) or month (from the 1st). Stricter, never looser, and never the
 * security bound: it is a counter on our own ledger, not something Base enforces.
 *
 * What counts: the agent's payment reservations on the wallet in that token, held or consumed,
 * created inside the calendar period, and its x402 service payments (Feed pay, base_payments kind
 * 'x402', docs/FEED_PAY.md section 4) from the moment they are reserved until they fail (cancelled,
 * expired or refused before signing), plus the protocol fees of those calls (migration 114) from the
 * moment they are owed until they are known not owed or failed. Released ones (never sent, or failed) do not count; owner
 * withdrawals are not agent spends and are never counted, and neither are float top-ups (holder
 * kind 'float': USDC moved between the agent's own two accounts).
 */
import type { Transaction } from '../../database.js';
import type { Address } from '../../../shared/base/chains.js';
import { calendarPeriod, type LimitPeriod } from '../../../shared/base/spend-limits.js';
import { WALLET_NETWORK } from '../../../shared/base/wallet-network.js';

type Queryable = Pick<Transaction, 'query'>;

/** The token Feed pay float top-ups move (lowercase). */
const FLOAT_TOKEN = WALLET_NETWORK.tokens.USDC.address.toLowerCase();

export class CalendarLimitError extends Error {
  constructor(
    readonly period: LimitPeriod,
    readonly window: { start: number; end: number },
  ) {
    super(`This spend would exceed the owner's cap for the current ${period} (Berlin time).`);
  }
}

/** The agent's spends in a token on a wallet within [start, end) (unix seconds). */
export async function calendarSpent(
  db: Queryable,
  input: {
    walletId: string;
    token: Address;
    window: { start: number; end: number };
    /** A payment being retried is not counted against itself. */
    excludeHolderRef?: string;
  },
): Promise<bigint> {
  // One statement. The protocol fees on top of Feed pay calls are agent spends too: their columns
  // (migration 114) exist wherever this runs, as createApp registers 114 and refuses to start
  // until every registered migration is applied (server/migrations.ts runMigrations).
  const { rows } = await db.query<{ total: string | null }>(
    `SELECT (
       (SELECT COALESCE(SUM(amount), 0) FROM base_wallet_reservations
        WHERE wallet_id = $1 AND lower(token) = $2 AND holder_kind = 'payment'
          AND state IN ('held','consumed') AND created_at >= $3 AND created_at < $4
          AND holder_ref <> $5)
       + (SELECT COALESCE(SUM(amount), 0) FROM base_payments
        WHERE payer_wallet_id = $1 AND kind = 'x402' AND lower(token_address) = $2
          AND state NOT IN ('failed','refunded') AND created_at >= $3 AND created_at < $4)
       + (SELECT COALESCE(SUM(fee_raw), 0) FROM feed_pay_calls
        WHERE wallet_id = $1 AND fee_state IN ('pending','sent','charged')
          AND created_at >= $3 AND created_at < $4)
     )::text AS total`,
    [
      input.walletId,
      input.token.toLowerCase(),
      input.window.start * 1000,
      input.window.end * 1000,
      input.excludeHolderRef ?? '',
    ],
  );
  return BigInt(rows[0]?.total ?? '0');
}

/**
 * Refuses (CalendarLimitError) when `amount` on top of what the agent already spent in the current
 * Berlin period would exceed `cap`. Runs inside the reservation's transaction: the wallet row is
 * locked first, so concurrent spends of one wallet are counted one after the other. A payment that
 * already holds its reservation (a retry) passed this check when it reserved and is not re-checked.
 */
export async function assertWithinCalendarLimit(
  tx: Queryable,
  input: {
    walletId: string;
    chainId: number;
    token: Address;
    amount: bigint;
    cap: bigint;
    period: LimitPeriod;
    holderRef: string;
    nowMs: number;
  },
): Promise<void> {
  await tx.query('SELECT 1 FROM base_wallets WHERE wallet_id = $1 AND chain_id = $2 FOR UPDATE', [
    input.walletId,
    input.chainId,
  ]);
  const own = await tx.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM base_wallet_reservations
     WHERE holder_kind = 'payment' AND holder_ref = $1 AND wallet_id = $2 AND lower(token) = $3`,
    [input.holderRef, input.walletId, input.token.toLowerCase()],
  );
  if (Number(own.rows[0]?.n ?? 0) > 0) return;
  const window = calendarPeriod(input.period, input.nowMs);
  const spent = await calendarSpent(tx, {
    walletId: input.walletId,
    token: input.token,
    window,
    excludeHolderRef: input.holderRef,
  });
  if (spent + input.amount > input.cap) throw new CalendarLimitError(input.period, window);
}

/** Refused by assertWithinPeriodAllowance: the payments already sent would use up the period. */
export class PeriodAllowanceError extends Error {
  constructor() {
    super('The spending limit for this period is used up.');
  }
}

/**
 * The Base period of a spend permission that contains `nowS` (unix seconds), as
 * SpendPermissionManager counts it: from the permission's start in steps of its period, cut at
 * its end.
 */
export function basePeriodWindow(
  permission: { start: number; end: number; period: number },
  nowS: number,
): { start: number; end: number } {
  const start =
    permission.start +
    Math.floor((nowS - permission.start) / permission.period) * permission.period;
  return { start, end: Math.min(start + permission.period, permission.end) };
}

/**
 * What is committed under a limit's on-chain allowance on top of Base's own count of the current
 * Base period: every spend through the spend permission sent here that may be missing from that
 * count. Both paths that call SpendPermissionManager.spend under one limit count: agent Pay
 * payments (holder kind 'payment') and Feed pay float top-ups (holder kind 'float': the agent
 * wallet to its own spender account, under the same limit). Counted conservatively:
 * - every such reservation still held, whenever it was reserved (one reserved before the period
 *   began may still land in it); a held one already in a block counts twice, which can only
 *   refuse, never overspend;
 * - every one settled (consumed) here since Base's count was read: it may have become final
 *   between that read and now, so the read may not include it. A minute earlier than the read:
 *   the settling instance's clock may run behind this one's. Without a read (`chainReadAtMs`
 *   null), every one settled in this period;
 * - every Feed pay top-up planned (its float move pending) that does not hold its reservation
 *   yet: the hold is taken right before it is signed.
 * A released one never spends. Rows from before the limit was created spent under another limit.
 * `excludeHolderRef` (the caller's own operation) is never counted.
 */
export async function periodAllowanceInFlight(
  tx: Queryable,
  input: {
    walletId: string;
    chainId: number;
    token: Address;
    window: { start: number; end: number };
    limitCreatedAtMs: number;
    chainReadAtMs: number | null;
    excludeHolderRef: string;
  },
): Promise<bigint> {
  const settledSince = Math.max(
    input.chainReadAtMs === null ? input.window.start * 1000 : input.chainReadAtMs - 60_000,
    input.limitCreatedAtMs,
  );
  const { rows } = await tx.query<{ total: string | null }>(
    `SELECT (
       (SELECT COALESCE(SUM(amount), 0) FROM base_wallet_reservations
        WHERE wallet_id = $1 AND lower(token) = $2 AND holder_kind IN ('payment','float')
          AND holder_ref <> $3 AND created_at >= $4
          AND (state = 'held' OR (state = 'consumed' AND updated_at >= $5)))
       + (SELECT COALESCE(SUM(m.amount_raw), 0) FROM feed_pay_float_moves m
        WHERE $6::boolean AND m.wallet_id = $1 AND m.chain_id = $7 AND m.kind = 'top_up'
          AND m.state = 'pending' AND m.op_key <> $3 AND m.created_at >= $4
          AND NOT EXISTS (SELECT 1 FROM base_wallet_reservations r
            WHERE r.holder_kind = 'float' AND r.holder_ref = m.op_key))
     )::text AS total`,
    [
      input.walletId,
      input.token.toLowerCase(),
      input.excludeHolderRef,
      input.limitCreatedAtMs,
      settledSince,
      // Feed pay top-ups move USDC only.
      input.token.toLowerCase() === FLOAT_TOKEN,
      input.chainId,
    ],
  );
  return BigInt(rows[0]?.total ?? '0');
}

/**
 * Refuses (PeriodAllowanceError) a spend the chain would revert because spends sent before it but
 * not yet final use up the on-chain allowance of the current Base period: Base's own count of this
 * period (`onchainSpend`) plus periodAllowanceInFlight (agent Pay payments and Feed pay float
 * top-ups under the same limit). Runs in the reservation's transaction under the wallet row lock,
 * so concurrent spends of one wallet are counted one after the other. A payment that already
 * holds its reservation (a retry) passed when it reserved and is not re-checked.
 */
export async function assertWithinPeriodAllowance(
  tx: Queryable,
  input: {
    walletId: string;
    chainId: number;
    token: Address;
    amount: bigint;
    allowance: bigint;
    onchainSpend: bigint;
    window: { start: number; end: number };
    /** When the limit was created (ms): payments before it spent under another limit. */
    limitCreatedAtMs: number;
    /**
     * When Base's count (`onchainSpend`) was read (ms, taken BEFORE the read), or null when it was
     * not read (a limit not on Base yet). A spend settled here since then may be missing from it.
     */
    chainReadAtMs: number | null;
    holderRef: string;
  },
): Promise<void> {
  await tx.query('SELECT 1 FROM base_wallets WHERE wallet_id = $1 AND chain_id = $2 FOR UPDATE', [
    input.walletId,
    input.chainId,
  ]);
  const own = await tx.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM base_wallet_reservations
     WHERE holder_kind = 'payment' AND holder_ref = $1 AND wallet_id = $2 AND lower(token) = $3`,
    [input.holderRef, input.walletId, input.token.toLowerCase()],
  );
  if (Number(own.rows[0]?.n ?? 0) > 0) return;
  const inFlight = await periodAllowanceInFlight(tx, {
    walletId: input.walletId,
    chainId: input.chainId,
    token: input.token,
    window: input.window,
    limitCreatedAtMs: input.limitCreatedAtMs,
    chainReadAtMs: input.chainReadAtMs,
    excludeHolderRef: input.holderRef,
  });
  if (input.onchainSpend + inFlight + input.amount > input.allowance)
    throw new PeriodAllowanceError();
}
