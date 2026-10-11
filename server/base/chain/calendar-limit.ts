/*
 * The Berlin calendar counter of a spending limit (Operation Base Wallet W3, contract v1.3). Base
 * enforces the owner-signed spend permission per FIXED on-chain period; on top of that Central City
 * refuses an agent spend that would take the agent past the owner's cap within the current Berlin
 * calendar day, week (from Monday) or month (from the 1st). Stricter, never looser, and never the
 * security bound: it is a counter on our own ledger, not something Base enforces.
 *
 * What counts: the agent's payment reservations on the wallet in that token, held or consumed,
 * created inside the calendar period. Released ones (never sent, or failed) do not count; owner
 * withdrawals are not agent spends and are never counted.
 */
import type { Transaction } from '../../database.js';
import type { Address } from '../../../shared/base/chains.js';
import { calendarPeriod, type LimitPeriod } from '../../../shared/base/spend-limits.js';

type Queryable = Pick<Transaction, 'query'>;

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
  const { rows } = await db.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total FROM base_wallet_reservations
     WHERE wallet_id = $1 AND lower(token) = $2 AND holder_kind = 'payment'
       AND state IN ('held','consumed') AND created_at >= $3 AND created_at < $4
       AND holder_ref <> $5`,
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
