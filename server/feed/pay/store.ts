/*
 * Feed pay rows (migration 112, schema.ts) and the answers built from them (shared/feed-pay.ts).
 * Every query names its columns; results are read only by the account that owns the paying wallet,
 * and never go to logs, alerts or audit payloads.
 */
import { randomBytes } from 'node:crypto';
import { getAddress, type Hex } from 'viem';
import type { Transaction } from '../../database.js';
import type { Address } from '../../../shared/base/chains.js';
import { TX_EXPLORER } from '../../base/wallet/withdrawals.js';
import {
  FEED_NETWORK,
  rawToUsdc,
  type FeedAmount,
  type FeedHttpMethod,
} from '../../../shared/feed.js';
import {
  FEED_PAY_FAILURE_MESSAGES,
  feedPayCallDone,
  feedPayMoneyMoved,
  type FeedPayCall,
  type FeedPayCallState,
  type FeedPayFailureCode,
  type FeedPayFeeState,
  type FeedPayFloatMove,
  type FeedPayHistoryItem,
  type FeedPayOrigin,
  type FeedPayPayment,
  type FeedPayPaymentState,
  type FeedPayResult,
} from '../../../shared/feed-pay.js';

export type Queryable = Pick<Transaction, 'query'>;

export const amountOf = (raw: string | bigint): FeedAmount => {
  const text = typeof raw === 'bigint' ? raw.toString(10) : raw;
  return { raw: text, decimals: 6, display: rawToUsdc(text) };
};

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 'fc_' + 20 random base32 characters. */
export function newCallId(): string {
  const bytes = randomBytes(20);
  let out = '';
  for (const byte of bytes) out += BASE32[byte & 31];
  return `fc_${out}`;
}

export const newQuoteId = () => `fq_${randomBytes(24).toString('base64url')}`;

export interface CallRequirements {
  /** The option exactly as the service listed it. */
  accepted: Record<string, unknown>;
  /** The v2 resource object the 402 named (sent back in the payment header), or null. */
  resource: Record<string, unknown> | null;
  /** The v2 extensions the 402 named (echoed back in the payment header), or null. */
  extensions?: Record<string, unknown> | null;
  /** A service sold by a Central City agent (pay_kind 'included'): the offer and kind bought. */
  included?: { offerId: string; kind: string; version: number };
}

export interface CallRow {
  call_id: string;
  origin: FeedPayOrigin;
  scope: string;
  idempotency_key: string;
  request_hash: string;
  caller_id: string;
  actor: string;
  owner_account_id: string;
  operator_id: string;
  agent_id: string;
  agent_name: string;
  wallet_id: string;
  chain_id: number;
  service_id: string;
  service_title: string;
  host: string;
  method: FeedHttpMethod;
  request_url: string;
  request_body: string | null;
  max_amount_raw: string;
  quote_id: string | null;
  permission_id: string;
  permission_hash: string | null;
  payment_id: string;
  amount_raw: string;
  pay_to: string;
  x402_version: number;
  requirements: CallRequirements;
  validity_s: number;
  state: FeedPayCallState;
  payment_state: FeedPayPaymentState | null;
  failure_code: FeedPayFailureCode | null;
  valid_before: string | number | null;
  nonce: string | null;
  search_from_block: string | number | null;
  claimed_tx: string | null;
  tx_hash: string | null;
  settled_block: string | number | null;
  settled_at: string | number | null;
  topup_move_id: string | null;
  cancel_op_key: string | null;
  response_status: number | null;
  result_status: number | null;
  result_content_type: string | null;
  result_format: FeedPayResult['format'] | null;
  result_text: string | null;
  result_bytes: number | null;
  result_truncated: boolean | null;
  result_received_at: string | number | null;
  result_expires_at: string | number | null;
  result_deleted_at: string | number | null;
  lease_until: string | number;
  lease_token: string | null;
  created_at: string | number;
  updated_at: string | number;
  /** The protocol fee owed on top (migration 114); '0' with fee_state NULL when none. */
  fee_raw: string;
  fee_state: FeedPayFeeState | null;
  fee_op_key: string | null;
  fee_tx_hash: string | null;
  fee_block: string | number | null;
  fee_verified: boolean;
  fee_router: string | null;
  /** The fee leg is held by payment screening (migration 115): when it was last held, and why. */
  fee_held_at: string | number | null;
  fee_hold_reason: string | null;
  /**
   * Migration 123: 'included' is a service sold by a Central City agent, paid fee included in one
   * router call (amount_raw is the seller's 90%, fee_raw the 10%; the price is their sum).
   */
  pay_kind: 'x402' | 'included';
  offer_id: string | null;
  delivered_at: string | number | null;
  pay_final_at: string | number | null;
  /**
   * Migration 129: how often a rate-limited float top-up of this call was planned again (at most
   * FEED_PAY_TOPUP_RETRY.attempts), and from when the next one may be planned (ms; null: none due).
   */
  topup_attempts: number;
  topup_retry_at: string | number | null;
  /**
   * Migration 210: how often a rate-limited fee-included payment of this call was planned again (at
   * most FEED_PAY_PAY_RETRY.attempts), from when the next one may be planned (ms; null: none due),
   * and when its first payment was planned (ms; null: none yet).
   */
  pay_attempts: number;
  pay_retry_at: string | number | null;
  pay_first_at: string | number | null;
  wallet_address: string;
  spender_address: string;
  spender_key_ref: string;
}

const callSelect = (
  resultText: string,
) => `SELECT c.call_id, c.origin, c.scope, c.idempotency_key, c.request_hash,
  c.caller_id, c.actor, c.owner_account_id, c.operator_id, c.agent_id, c.agent_name, c.wallet_id,
  c.chain_id, c.service_id, c.service_title, c.host, c.method, c.request_url, c.request_body,
  c.max_amount_raw::text AS max_amount_raw, c.quote_id, c.permission_id, c.permission_hash,
  c.payment_id, c.amount_raw::text AS amount_raw, c.pay_to, c.x402_version, c.requirements,
  c.validity_s, c.state, c.payment_state, c.failure_code, c.valid_before, c.nonce,
  c.search_from_block, c.claimed_tx, c.tx_hash, c.settled_block, c.settled_at, c.topup_move_id,
  c.cancel_op_key, c.response_status, c.result_status, c.result_content_type, c.result_format,
  ${resultText}, c.result_bytes, c.result_truncated, c.result_received_at, c.result_expires_at,
  c.result_deleted_at, c.lease_until, c.lease_token, c.created_at, c.updated_at,
  c.fee_raw::text AS fee_raw, c.fee_state, c.fee_op_key, c.fee_tx_hash, c.fee_block, c.fee_verified, c.fee_router,
  c.fee_held_at, c.fee_hold_reason, c.pay_kind, c.offer_id, c.delivered_at, c.pay_final_at,
  c.topup_attempts, c.topup_retry_at, c.pay_attempts, c.pay_retry_at, c.pay_first_at,
  w.address AS wallet_address, w.spender_address, w.spender_key_ref
  FROM feed_pay_calls c JOIN base_wallets w ON w.wallet_id = c.wallet_id`;

/** Every column of a call plus its wallet's two addresses, over the alias `c` (and `w`). */
export const CALL_SELECT = callSelect('c.result_text');

/**
 * CALL_SELECT without the result's text (`result_text` is NULL, every other column as there): the
 * re-reads of a call while it is followed (the worker's loop, waitFor, the recovery cron), which
 * never answer with the result. The text (up to RESULT_MAX_BYTES) is read only for an answer.
 */
export const CALL_SELECT_NO_TEXT = callSelect('NULL::text AS result_text');

export const num = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

/**
 * One call. `{ text: false }` reads it without the result's text (CALL_SELECT_NO_TEXT): for the
 * polling re-reads only, never for a row that answers the caller (resultView would show no text).
 */
export async function loadCall(q: Queryable, callId: string, options: { text?: boolean } = {}) {
  const select = options.text === false ? CALL_SELECT_NO_TEXT : CALL_SELECT;
  const { rows } = await q.query<CallRow>(`${select} WHERE c.call_id = $1`, [callId]);
  return rows[0] ?? null;
}

/** True when the call has a stored result whose text a full read (loadCall) would return. */
export const hasResultText = (row: CallRow): boolean =>
  row.result_received_at !== null && row.result_deleted_at === null;

const TX = /^0x[0-9a-f]{64}$/;

/** What the buyer pays the seller's side: the price for a fee-included call, else amount_raw. */
export const paidAmountRaw = (row: Pick<CallRow, 'pay_kind' | 'amount_raw' | 'fee_raw'>) =>
  row.pay_kind === 'included'
    ? (BigInt(row.amount_raw) + BigInt(row.fee_raw)).toString(10)
    : row.amount_raw;

export function paymentView(row: CallRow): FeedPayPayment | null {
  if (!row.payment_state) return null;
  const txHash = row.tx_hash && TX.test(row.tx_hash) ? row.tx_hash : null;
  const amountRaw = paidAmountRaw(row);
  return {
    paymentId: row.payment_id,
    amountRaw,
    amount: amountOf(amountRaw),
    payTo: getAddress(row.pay_to) as Address,
    host: row.host,
    network: FEED_NETWORK,
    state: row.payment_state,
    from: {
      wallet: getAddress(row.wallet_address) as Address,
      spender: getAddress(row.spender_address) as Address,
    },
    validBefore: Number(row.valid_before ?? 0) * 1000,
    ...(txHash ? { txHash, explorerUrl: `${TX_EXPLORER}${txHash}` } : {}),
    ...(row.settled_at !== null ? { settledAt: Number(row.settled_at) } : {}),
  };
}

export function resultView(row: CallRow): FeedPayResult | null {
  if (row.result_received_at === null || row.result_deleted_at !== null) return null;
  return {
    origin: 'external',
    status: row.result_status ?? 0,
    contentType: row.result_content_type,
    format: row.result_format ?? 'empty',
    text: row.result_text,
    bytes: row.result_bytes ?? 0,
    truncated: row.result_truncated ?? false,
    receivedAt: Number(row.result_received_at),
  };
}

export function callView(row: CallRow): FeedPayCall {
  const payment = paymentView(row);
  const moneyMoved = feedPayMoneyMoved(payment);
  return {
    callId: row.call_id,
    origin: row.origin,
    state: row.state,
    moneyMoved,
    done: feedPayCallDone({ state: row.state, moneyMoved }),
    service: { id: row.service_id, title: row.service_title, host: row.host, method: row.method },
    agent: { id: row.agent_id, name: row.agent_name },
    maxAmount: amountOf(row.max_amount_raw),
    payment,
    protocolFee: !row.fee_state
      ? null
      : {
          amountRaw: row.fee_raw,
          amount: amountOf(row.fee_raw),
          state: row.fee_state,
          txHash: row.fee_tx_hash && TX.test(row.fee_tx_hash) ? (row.fee_tx_hash as Hex) : null,
          ...(row.pay_kind === 'included' ? { included: true as const } : {}),
        },
    result: resultView(row),
    resultExpired: row.result_deleted_at !== null,
    resultExpiresAt:
      row.result_received_at === null ? null : Number(row.result_expires_at ?? 0) || null,
    failure: row.failure_code
      ? { code: row.failure_code, message: FEED_PAY_FAILURE_MESSAGES[row.failure_code] }
      : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function historyItem(row: CallRow): FeedPayHistoryItem {
  const view = callView(row);
  return {
    callId: view.callId,
    origin: view.origin,
    state: view.state,
    moneyMoved: view.moneyMoved,
    service: { id: row.service_id, title: row.service_title, host: row.host },
    payment: view.payment,
    protocolFee: view.protocolFee,
    resultAvailable: view.result !== null,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

export interface MoveRow {
  move_id: string;
  wallet_id: string;
  kind: 'top_up' | 'sweep';
  amount_raw: string;
  op_key: string;
  intent_hash: string;
  state: 'pending' | 'final' | 'failed';
  call_id: string | null;
  reason: string | null;
  period_end: string | number | null;
  tx_hash: string | null;
  created_at: string | number;
  updated_at: string | number;
}

export const MOVE_COLUMNS = `move_id, wallet_id, kind, amount_raw::text AS amount_raw, op_key,
  intent_hash, state, call_id, reason, period_end, tx_hash, created_at, updated_at`;

export function moveView(row: MoveRow): FeedPayFloatMove {
  const txHash = row.tx_hash && TX.test(row.tx_hash) ? (row.tx_hash as Hex) : null;
  return {
    moveId: row.move_id,
    kind: row.kind,
    amount: amountOf(row.amount_raw),
    state: row.state,
    txHash,
    explorerUrl: txHash ? `${TX_EXPLORER}${txHash}` : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Calls whose price may still leave the float (not yet ended, or a payment Base may still use). */
export const LIVE_PRINCIPAL_SQL = (c: string) => `(${c}.state IN ('reserved','float_topup',
  'authorized','calling','reconciling','settled','not_settled')
  OR ${c}.payment_state IN ('signed','sent','cancelling'))`;

/**
 * Calls still live for a sweep: their price may still leave, or their protocol fee is owed. An owed
 * fee alone never reserves a price already settled again (floatHeld counts the fee on its own).
 */
export const LIVE_CALL_SQL = (c: string) =>
  `(${LIVE_PRINCIPAL_SQL(c)} OR ${c}.fee_state IN ('pending','sent'))`;

/**
 * The calls whose price the spender's balance read at `block` (a SQL parameter) still holds: the
 * live ones as LIVE_PRINCIPAL_SQL, except a fee-included call 'settled' (paid, its delivery
 * pending) whose payment is in a block at or before the read: its price has already left the
 * balance, so it is not held again.
 */
const HELD_PRINCIPAL_SQL = (c: string, block: string) => `(${c}.state IN ('reserved',
  'float_topup','authorized','calling','reconciling','not_settled')
  OR (${c}.state = 'settled' AND (${c}.pay_kind <> 'included' OR ${c}.settled_block IS NULL
    OR ${c}.settled_block > ${block}))
  OR ${c}.payment_state IN ('signed','sent','cancelling'))`;

/**
 * What the spender's balance read at `block` still owes: live calls' amounts (except `exclude`),
 * payments Base settled after that read (or whose block is not known), and sweeps not yet visible
 * in it. Available float = balance - this.
 */
export async function floatHeld(
  q: Queryable,
  input: { walletId: string; block: bigint; excludePaymentId?: string },
): Promise<bigint> {
  const { rows } = await q.query<{ total: string }>(
    `SELECT (
       (SELECT COALESCE(SUM(c.amount_raw), 0) FROM feed_pay_calls c
        WHERE c.wallet_id = $1 AND c.payment_id <> $2 AND (${HELD_PRINCIPAL_SQL('c', '$3')}
          OR (c.payment_state = 'settled' AND (c.settled_block IS NULL OR c.settled_block > $3))))
       + (SELECT COALESCE(SUM(c.fee_raw), 0) FROM feed_pay_calls c
          WHERE c.wallet_id = $1 AND c.payment_id <> $2 AND (c.fee_state IN ('pending','sent')
            OR (c.fee_state = 'charged' AND (c.fee_block IS NULL OR c.fee_block > $3))))
       + (SELECT COALESCE(SUM(m.amount_raw), 0) FROM feed_pay_float_moves m
          LEFT JOIN base_chain_ops o ON o.idempotency_key = m.op_key
        WHERE m.wallet_id = $1 AND m.kind = 'sweep' AND m.state <> 'failed'
          AND (m.state = 'pending' OR o.block_number IS NULL OR o.block_number > $3))
     )::text AS total`,
    [input.walletId, input.excludePaymentId ?? '', input.block.toString(10)],
  );
  return BigInt(rows[0]?.total ?? '0');
}

/** Any authorization of this wallet's spender that is not over (a sweep waits for none). */
export async function hasLiveCalls(q: Queryable, walletId: string): Promise<boolean> {
  const { rows } = await q.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM feed_pay_calls c WHERE c.wallet_id = $1 AND ${LIVE_CALL_SQL('c')}`,
    [walletId],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** A top-up or sweep of this wallet still on its way. */
export async function hasPendingMove(q: Queryable, walletId: string): Promise<boolean> {
  const { rows } = await q.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM feed_pay_float_moves WHERE wallet_id = $1 AND state = 'pending'`,
    [walletId],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * A top-up of this wallet's float not yet in a block (planned, or sent and not seen on Base), or
 * in a block but reverted and not decided yet: its USDC is not in the spender account. Once
 * included without a revert, the balance read shows it.
 */
export async function topUpInFlight(q: Queryable, walletId: string): Promise<boolean> {
  const { rows } = await q.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM feed_pay_float_moves m
     LEFT JOIN base_chain_ops o ON o.idempotency_key = m.op_key
     WHERE m.wallet_id = $1 AND m.kind = 'top_up' AND m.state = 'pending'
       AND (o.status IS NULL OR o.status NOT IN ('included','final','failed')
         OR (o.status = 'included' AND o.error_code IS NOT NULL))`,
    [walletId],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** A sweep of this wallet's float still on its way (a top-up waits for it). */
export async function sweepPending(q: Queryable, walletId: string): Promise<boolean> {
  const { rows } = await q.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM feed_pay_float_moves
     WHERE wallet_id = $1 AND kind = 'sweep' AND state = 'pending'`,
    [walletId],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** One audit event (append-only); ids and amounts only. */
export async function audit(
  q: Queryable,
  event: {
    at: number;
    actor: string;
    operatorId: string;
    agentId: string;
    kind: string;
    detail: Record<string, unknown>;
  },
) {
  await q.query(
    `INSERT INTO base_audit_events (at, actor, operator_id, agent_id, kind, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      event.at,
      event.actor,
      event.operatorId,
      event.agentId,
      event.kind,
      JSON.stringify(event.detail),
    ],
  );
}
