/*
 * The Feed pay engine (Feed D6, "Use with my agent"; docs/FEED_PAY.md, shared/feed-pay.ts). One
 * engine for the Feed drawer (a signed-in owner confirms each payment) and for the MCP tool
 * city_service_call (the owner's AI pays on its own, within the owner's consent and limits).
 *
 * Who pays: the agent's spender smart account, funded from the agent's own wallet through the
 * owner-signed spend permission (a float, "Ready for services"). Central City never pays from its
 * own money and never holds the owner's key. Only services the Feed lists now, at exactly their
 * listed URL.
 *
 * A call, in order (section 6):
 *   1. checks that answer an HTTP error and store nothing: flags, the listing, the inputs, the
 *      idempotency key, the quote (Feed), the agent and its limit (and, for MCP, the grant and the
 *      owner's consent), the live 402 (payee and price), the per-call maximum and the price the
 *      caller accepted, then in ONE transaction the limits on Base and on the Berlin calendar and
 *      the wallet's USDC; the call row and its base_payments row (kind 'x402') are written there:
 *      state `reserved`
 *   2. the worker (the request's background work, then the recovery cron) moves it on:
 *      float_topup when the float is short (one sponsored operation, wallet to spender), then the
 *      checks again and the signed authorization (`authorized`), the paid request sent ONCE
 *      (`calling`), the result, and Base's word on the payment (settled, cancelled or expired)
 *
 * The paid request is never sent twice: the state moves to `calling` (compare-and-set) before it
 * is sent, and nothing (worker, retry, cron) sends a call that is past `authorized`. A call is sent
 * from `authorized` only by a worker (the request's own, or a same-key retry) and only while its
 * authorization still has at least authValidityMinS to run and every authority check still
 * holds; otherwise it goes to Base unsent. The cron never sends. A lost or unclear answer is
 * reconciled on Base, never retried.
 */
import { randomUUID } from 'node:crypto';
import { decodeEventLog, getAddress, parseAbiItem, toEventSelector, type Hex } from 'viem';
import { z } from 'zod';
import type { Database } from '../../database.js';
import { baseNetwork, type Address } from '../../../shared/base/chains.js';
import {
  calendarPeriod,
  limitPeriodOf,
  type LimitPeriod,
} from '../../../shared/base/spend-limits.js';
import type { SpendPermission } from '../../../shared/base/types.js';
import { WALLET_CHAIN_ID, WALLET_NETWORK } from '../../../shared/base/wallet-network.js';
import { activePaymentLimit } from '../../base/chain/payment-chain.js';
import {
  basePeriodWindow,
  calendarSpent,
  periodAllowanceInFlight,
} from '../../base/chain/calendar-limit.js';
import { unavailableAmount } from '../../base/chain/reservations.js';
import { walletRecipientRefusal } from '../../base/payments/authority.js';
import {
  AgentPayConsentError,
  assertAgentPayConsent,
} from '../../base/wallet/agent-pay-consent.js';
import { feedListedSql } from '../services-schema.js';
import {
  FEED_HTTP_METHODS,
  FEED_USDC,
  feedEndpointRiskOf,
  feedRiskOf,
  rawToUsdc,
  type FeedHttpMethod,
  type FeedSchemaSummary,
} from '../../../shared/feed.js';
import {
  AUTH_VALIDITY_MAX_S,
  CALL_TIMEOUT_MS,
  DEFAULT_FLOAT_RAW,
  DEFAULT_PER_CALL_MAX_RAW,
  FEED_PAY_ERROR_MESSAGES,
  FEED_PAY_ERRORS,
  FEED_PAY_IDEMPOTENCY_KEY,
  FEED_PAY_LIMITS,
  FEED_PAY_NOT_PAYABLE_MESSAGES,
  FEED_PAY_QUOTE_ID,
  FEED_PAY_RETRYABLE,
  FEED_PAY_USER_AGENT,
  RESULT_KEEP_DAYS,
  RESULT_MAX_BYTES,
  feedPayCallDone,
  feedPayEnabled,
  feedPayListingCheck,
  type FeedPayAgent,
  type FeedPayAgentList,
  type FeedPayAlert,
  type FeedPayCall,
  type FeedPayCallState,
  type FeedPayError,
  type FeedPayErrorCode,
  type FeedPayFailureCode,
  type FeedPayHistory,
  type FeedPayInputProblem,
  type FeedPayInputs,
  type FeedPayNotPayable,
  type FeedPayNotPayableReason,
  type FeedPayNotReadyReason,
  type FeedPayQuote,
  type FeedPayQuoteAnswer,
  type FeedPayResult,
} from '../../../shared/feed-pay.js';
import {
  AUTHORIZATION_SEARCH_BLOCKS,
  FeedPayChainError,
  opIntentHash,
  permissionOf,
  type AllowanceLeft,
  type FeedPayChainPort,
  type FeedPayOp,
  type PermissionRef,
  type WalletRef,
} from '../../base/chain/feed-pay-chain.js';
import { bundlerRateLimited, providerRateLimit } from '../../base/chain/rpc-bundler.js';
import { NEVER_BROADCAST } from '../../base/chain/submit.js';
import {
  canonicalJson,
  feedPayInputsSchema,
  inputProblems,
  inputsHash,
  requestOf,
  sha256Hex,
  withoutQuery,
} from './inputs.js';
import {
  amountOf,
  audit,
  CALL_SELECT,
  callView,
  floatHeld,
  hasLiveCalls,
  hasPendingMove,
  hasResultText,
  historyItem,
  sweepPending,
  topUpInFlight,
  loadCall,
  MOVE_COLUMNS,
  moveView,
  newCallId,
  newQuoteId,
  num,
  paidAmountRaw,
  type CallRow,
  type MoveRow,
  type Queryable,
} from './store.js';
import { feedPayHttps, FeedPayHttpError, type FeedPayHttp } from './transport.js';
import {
  feeCalls,
  feeEventsOf,
  feeFor,
  feeMatches,
  feeRef,
  KIND_EXTERNAL,
  FEE_BPS,
  KIND_INTERNAL,
  MAX_LISTED_PRICE_ROUTER2,
  MAX_TOTAL,
  MAX_TOTAL_ROUTER2,
  payCalls,
  quoteFeeIncluded,
  quoteFeeOnTop,
  routeFor,
  type IncludedQuote,
} from '../../protocol/fees/fee-call.js';
import { feeRouter2Live } from './router2.js';
import {
  batchWorkspacesFromEnv,
  feeRouter3Live,
  LEG_SELLER,
  MAX_TOTAL_ROUTER3,
  MIN_INCLUDED_ROUTER3,
  router3AddressFromEnv,
  router3Nonce,
  router3OwnTransfers,
  ROUTER3_VALIDITY_S,
  type Router3FacilitatorPort,
} from './router3.js';
import { PRICE_CAP_RAW } from './x402-buyer.js';
import {
  isOfferKind,
  mergeOfferPreset,
  OFFER_ID,
  type OfferKindName,
  type OfferPreset,
} from '../../../shared/feed-offers.js';
import { HOSTED_SOURCE } from '../types.js';
import {
  checkOffer,
  OFFER_KIND_REGISTRY,
  offerKind,
  OfferKindFailure,
  OfferKindInputError,
  type OfferKind,
} from '../offers/kinds.js';
import {
  protocolFeeConfigFromEnv,
  protocolRouter2FromEnv,
  protocolFeesEnabled,
  protocolTreasuryFor,
} from '../../protocol/fees/cron.js';
import { markServiceVerified } from '../../protocol/fees/ledger.js';
import {
  screeningEnabled,
  type ScreeningDecision,
  type ScreeningGate,
  type ScreeningParty,
} from '../../protocol/screening/gate.js';
import {
  chooseOption,
  paymentHeader,
  readPaymentRequired,
  readSettlementClaim,
  type ChosenOption,
  type PaymentRequired,
} from './x402-buyer.js';

const CHAIN_ID = WALLET_CHAIN_ID;
const USDC = WALLET_NETWORK.tokens.USDC.address;

/** A worker holds a call this long; the cron takes calls whose lease ran out. */
export const FEED_PAY_LEASE_MS = 3 * 60_000;
/** The cron leaves a call alone until it has not changed for this long. */
export const FEED_PAY_RECOVER_GRACE_MS = 60_000;
/**
 * A delivered fee-included call whose only open step is its finality is left out of the recover
 * sweep until this long after it settled: Base finalizes after ~13-20 min, so earlier checks find
 * nothing new. Each check cost writes (claim, checked_at, release) and chain reads, and at Block D's
 * volume thousands of such calls were checked every run.
 */
export const FEED_PAY_FINALITY_WAIT_MS = 12 * 60_000;
/** Below this much time before validBefore, no cancel is sent: the authorization runs out first. */
export const FEED_PAY_CANCEL_MARGIN_S = 15;
/** How long the request's background work follows a call before leaving it to the cron. */
export const FEED_PAY_WORK_MS = 150_000;
/** Balance reads of the agents list give up after this (null = not known now). */
export const FEED_PAY_BALANCE_TIMEOUT_MS = 2_500;

const TERMINAL: ReadonlySet<FeedPayCallState> = new Set([
  'result_saved',
  'paid_no_result',
  'cancelled',
  'expired',
  'refused',
]);

// ---------------------------------------------------------------------------------------------
// Errors

/** A refusal before anything was stored: the FeedPayError answer and its HTTP status. */
export class FeedPayRefusal extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(
    readonly code: FeedPayErrorCode,
    readonly extra: Omit<FeedPayError, 'error' | 'code' | 'retryable'> = {},
    message?: string,
  ) {
    super(message ?? FEED_PAY_ERROR_MESSAGES[code]);
    this.status = FEED_PAY_ERRORS[code];
    this.retryable = FEED_PAY_RETRYABLE.has(code);
  }
  body(): FeedPayError {
    return { error: this.message, code: this.code, retryable: this.retryable, ...this.extra };
  }
}

const refuse = (code: FeedPayErrorCode, extra: FeedPayRefusal['extra'] = {}) =>
  new FeedPayRefusal(code, extra);

/** Why fee router 3 is not ready (engine router3Unready); logged, never shown to callers. */
type Router3Unready =
  | 'bad_address'
  | 'not_deployed'
  | 'limits'
  | 'treasury_hold'
  | 'nonce_mismatch'
  | 'probe_failed'
  | 'no_facilitator'
  | 'facilitator_unreachable'
  | 'facilitator_low_gas';
/** How long a 'can pay' answer of the router 3 facilitator is trusted. */
export const FACILITATOR_PAYABLE_TTL_MS = 30_000;
/** The pause before the one retry of a router 3 readiness read that failed. */
const ROUTER3_RETRY_MS = 300;

// ---------------------------------------------------------------------------------------------
// Deps and callers

export interface FeedPayEngineDeps {
  db: Database;
  /**
   * The batch lane's grant check without the request (assistant-access.ts guard, from stored ids):
   * throws when the grant or key of a workspace is revoked, expired or lacks services:pay. Absent:
   * MCP purchases are never batched (refused at the flush).
   */
  revalidateGrant?: (input: {
    operatorId: string;
    kind: 'grant' | 'key';
    id: string;
  }) => Promise<void>;
  /**
   * Read per request and per step: the emergency offs (CITY_FEED, CITY_FEED_PAY,
   * CITY_PROTOCOL_FEES, CITY_PROTOCOL_SCREENING; docs/protocol/LIVE.md).
   */
  env: Record<string, string | undefined>;
  /** The chain side (chain.ts); throws when Base is not configured (calls answer unavailable). */
  chain(): Promise<FeedPayChainPort>;
  /** The outbound transport (transport.ts) by default; tests pass a fake service. */
  http?: FeedPayHttp;
  alert?: (alert: FeedPayAlert) => void | Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How often the worker looks again at a step that waits on Base (default pollMs). */
  pollMs?: number;
  /** Calls whose finality one recover run records (default FINALITY_CALLS_PER_RUN; tests set it). */
  finalityPerRun?: number;
  log?: (line: string) => void;
  /**
   * The payment screening gate (server/protocol/screening/gate.ts), consulted unless
   * CITY_PROTOCOL_SCREENING is '0' (read per step). On without a gate, every new submission is
   * refused.
   */
  screening?: ScreeningGate;
  /**
   * The kinds a service sold by a Central City agent runs when it is bought
   * (server/feed/offers/kinds.ts, OFFER_KIND_REGISTRY by default; tests pass their own).
   */
  offerKinds?: ReadonlyMap<OfferKindName, OfferKind>;
  /**
   * The most calls one workspace may have in flight (reserved, not done yet), the same for every
   * workspace (CityLimits.feedPayCallsInFlightPerWorkspace); a new call at it is refused with
   * FeedPayInFlightLimit. Unset: no cap.
   */
  callsInFlightMax?: number;
  /**
   * Central City's own x402 facilitator for fee router 3 (server/protocol/x402/facilitator.ts);
   * null or unset: router 3 is never live and nothing is pinned to it.
   */
  facilitator?: () => Promise<Router3FacilitatorPort | null>;
}

// ---------------------------------------------------------------------------------------------
// Services sold by Central City agents (fee included, delivered in-process)

/** How long one delivery (a kind's run) may take before it is abandoned. */
export const OFFER_RUN_TIMEOUT_MS = 10_000;
/**
 * A delivery that a limiter refused before any request went out (a retryable OfferKindFailure
 * with status 429 or 503 and nothing sent: web-read's host_busy and busy) is run again, at most
 * this many runs in all, OFFER_RUN_RETRY_MS apart, before the call ends paid_no_result.
 */
export const OFFER_RUN_ATTEMPTS = 3;
export const OFFER_RUN_RETRY_MS = 2_000;
/** The most one delivery may answer (UTF-8 bytes). */
export const OFFER_OUTPUT_MAX_BYTES = 65_536;

/**
 * The not-yet-final delivered amount (owner decision of 15 Oct: deliver at inclusion, record
 * finality later): what was delivered for fee-included payments that Base has not finalized yet,
 * capped per seller wallet and in all. Above a cap, a call waits for its payment to be final before
 * it delivers. Generic env settings in USDC base units; the same for every seller.
 */
export const FEED_PAY_UNFINAL_ENV = {
  perSeller: 'CITY_FEED_PAY_UNFINAL_SELLER_MAX_RAW',
  total: 'CITY_FEED_PAY_UNFINAL_TOTAL_MAX_RAW',
} as const;
export const FEED_PAY_UNFINAL_DEFAULT = { perSeller: 1_000_000n, total: 50_000_000n } as const;

export function feedPayUnfinalCaps(env: Record<string, string | undefined>) {
  const read = (name: string, fallback: bigint) => {
    const value = env[name]?.trim();
    return value && /^\d{1,15}$/.test(value) ? BigInt(value) : fallback;
  };
  return {
    perSeller: read(FEED_PAY_UNFINAL_ENV.perSeller, FEED_PAY_UNFINAL_DEFAULT.perSeller),
    total: read(FEED_PAY_UNFINAL_ENV.total, FEED_PAY_UNFINAL_DEFAULT.total),
  };
}

/**
 * What a transport charges for one call, decided by the idempotency lookup: a key that names an
 * existing call is a re-read and never spends a new call's budget (assistant-access.ts charges the
 * CityLimits feedPay* buckets here). Each throws to refuse.
 */
export interface FeedPayAdmission {
  /** The key names an existing call: charged before it is answered again. */
  reread?(): Promise<void>;
  /** The key names no call: charged before the listing, the agent, the service or Base is read. */
  fresh?(): Promise<void>;
}

/** How long a caller refused by the in-flight cap is asked to wait before it tries again. */
export const FEED_PAY_IN_FLIGHT_RETRY_MS = 10_000;

/**
 * A new call while the paying agent's workspace has its cap of calls in flight. It answers as the
 * transports' rate limits do (429 with Retry-After; over MCP rate_limited, retryable), and nothing
 * was signed, sent or reserved.
 */
export class FeedPayInFlightLimit extends Error {
  readonly statusCode = 429;
  readonly retryAfterMs = FEED_PAY_IN_FLIGHT_RETRY_MS;
  constructor() {
    super('Too many calls of this workspace are still running. Try again when one is done.');
  }
}

/**
 * Calls of one workspace in flight, counted up to $2: the predicate is the one of the partial
 * index feed_pay_calls_live (server/feed/pay/schema.ts), so the count reads only calls that are
 * not done yet, never the table's history.
 */
export const FEED_PAY_IN_FLIGHT_SQL = `SELECT count(*)::int AS n FROM (SELECT 1 FROM feed_pay_calls
  WHERE operator_id = $1
    AND (state IN ('reserved','float_topup','authorized','calling','reconciling','settled',
      'not_settled') OR payment_state IN ('signed','sent','cancelling'))
  LIMIT $2) AS live`;

/** Re-screening of a fee leg held by screening waits at least this long after the last hold. */
export const FEED_PAY_FEE_HOLD_RETRY_MS = 5 * 60_000;

/**
 * A float top-up that the bundler or paymaster refused ONLY for its rate (an HTTP 429 or a 'busy'
 * answer: rpc-bundler.ts bundlerRateLimited) and whose operation provably never left the server is
 * planned again instead of ending the call: at most `attempts` times, each no earlier than the
 * provider's Retry-After and the backoff for that attempt (the longer of the two, at most
 * maxWaitMs), and only within windowMs of the call's first top-up and while the worker that plans
 * it still has budgetMarginMs of its work budget (FEED_PAY_WORK_MS) left once it is due: only that
 * worker (or its caller following the call) takes it up, never the cron. Every other refusal ends
 * the call at once, as before (float_topup_failed).
 */
export const FEED_PAY_TOPUP_RETRY = {
  attempts: 3,
  backoffMs: [30_000, 90_000, 180_000],
  maxWaitMs: 5 * 60_000,
  windowMs: 10 * 60_000,
  budgetMarginMs: 15_000,
} as const;

/**
 * The wait before re-plan `attempt` (from 1): the longer of the provider's Retry-After (ms; null
 * when it sent none) and the backoff, at most maxWaitMs. null when the provider asks for longer
 * than that: a new try would be earlier than it said, so none is planned.
 */
export function topUpRetryWaitMs(attempt: number, retryAfterMs: number | null): number | null {
  const { backoffMs, maxWaitMs } = FEED_PAY_TOPUP_RETRY;
  if (retryAfterMs !== null && retryAfterMs > maxWaitMs) return null;
  const backoff = backoffMs[Math.min(Math.max(attempt, 1), backoffMs.length) - 1]!;
  return Math.min(Math.max(retryAfterMs ?? 0, backoff), maxWaitMs);
}

/**
 * The same bounds for a fee-included call's router payment (router.pay in one operation) that the
 * provider refused only for its rate (rpc-bundler.ts providerRateLimit: an HTTP 429 or a 'busy'
 * answer of the bundler, the paymaster or the node read that prepares it) and whose operation
 * provably never left the server (its stored row failed with a NEVER_BROADCAST code): the call goes
 * back to 'reserved' and plans a new payment operation under a new key (feedPayKey) no earlier than
 * the wait of topUpRetryWaitMs, at most `attempts` times, within windowMs of its first payment and
 * only while it is due within the planning worker's budget. Every other refusal ends the call as
 * before; an operation that may have gone out (submitted, unknown, BROADCAST_AMBIGUOUS) is only
 * ever reconciled. Counted apart from the top-up's attempts (pay_attempts, migration 210).
 */
export const FEED_PAY_PAY_RETRY = FEED_PAY_TOPUP_RETRY;

/**
 * The operation key of a fee-included call's payment attempt: attempt 0 keeps the key every call
 * had before re-plans existed, so a call in flight while this ships resumes the same operation.
 */
export const feedPayKey = (callId: string, attempt: number) =>
  attempt > 0 ? `feed-pay:pay:${callId}:${attempt}` : `feed-pay:pay:${callId}`;

export type FeedPayCaller =
  | { origin: 'feed'; accountId: string }
  | {
      origin: 'mcp';
      /** The workspace the grant or key acts for. */
      workspaceId: string;
      /** Who acts, for the audit trail ("assistant grant <id>"). */
      actor: string;
      /** The grant or key checked again (assistant-access.ts); throws when it no longer may pay. */
      revalidate(): Promise<void>;
      /** The grant's or key's ids, for a check again later without this request (batch lane). */
      grant?: { kind: 'grant' | 'key'; id: string };
    };

/** One call's request, after the transport parsed it. */
export interface FeedPayCallInput {
  serviceId: string;
  agentId: string;
  inputs: FeedPayInputs;
  /** The most the caller accepted (the confirmed quote, or max_price_usdc). */
  maxAmountRaw: bigint;
  /**
   * Feed only: the total the person confirmed, price plus Central City's fee (absent from a page
   * that predates the fee: maxAmountRaw). MCP has none: max_price_usdc bounds the price.
   */
  maxTotalRaw?: bigint;
  idempotencyKey: string;
  /** Feed only. */
  quoteId?: string;
}

const RAW = /^[1-9][0-9]{0,77}$/;

export const feedPayQuoteBody = z
  .object({ inputs: feedPayInputsSchema, agentId: z.string().min(1).max(100).optional() })
  .strict();
export const feedPayCallBody = z
  .object({
    agentId: z.string().min(1).max(100),
    inputs: feedPayInputsSchema,
    quoteId: z.string().regex(FEED_PAY_QUOTE_ID),
    maxAmountRaw: z.string().regex(RAW),
    maxTotalRaw: z.string().regex(RAW).optional(),
    idempotencyKey: z.string().regex(FEED_PAY_IDEMPOTENCY_KEY),
  })
  .strict();
export const feedPayAgentBody = z
  .object({
    perCallMaxRaw: z.string().regex(RAW).nullable().optional(),
    /** The pot target (docs/protocol/FEE_ROUTER_2.md section 6): 1 to 100 USDC, null = default. */
    floatTargetRaw: z.string().regex(RAW).nullable().optional(),
  })
  .strict()
  .refine((b) => b.perCallMaxRaw !== undefined || b.floatTargetRaw !== undefined);

// ---------------------------------------------------------------------------------------------
// Listing

interface ListedService {
  id: string;
  title: string;
  host: string;
  url: string;
  method: FeedHttpMethod | null;
  scheme: 'exact' | 'upto';
  payTo: string;
  priceRaw: string | null;
  input: FeedSchemaSummary | null;
  /** The listing's source ('x402 Bazaar', or 'Central City' for a service an agent sells here). */
  source: string;
  recordId: string;
}

async function listedService(q: Queryable, id: string): Promise<ListedService | null> {
  if (!/^svc_[a-z2-7]{20}$/.test(id)) return null;
  const { rows } = await q.query<{
    id: string;
    title: string;
    description: string | null;
    host: string;
    url: string;
    method: string | null;
    scheme: 'exact' | 'upto';
    pay_to: string;
    price_raw: string | null;
    input: FeedSchemaSummary | null;
    source: string;
    record_id: string;
  }>(
    `SELECT s.id, s.title, s.description, s.host, s.url, s.method, s.scheme, s.pay_to,
       s.price_raw::text AS price_raw, s.input, s.source, s.record_id
     FROM feed_services s WHERE s.id = $1 AND ${feedListedSql('s')}`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  // `risky` is as fresh as the last sweep: the rules of this build decide too (never paid if risky).
  if (
    feedRiskOf(row.title.normalize('NFKC'), (row.description ?? '').normalize('NFKC')) ||
    feedEndpointRiskOf(row.url)
  )
    return null;
  return {
    id: row.id,
    title: row.title,
    host: row.host,
    url: row.url,
    method: FEED_HTTP_METHODS.find((method) => method === row.method) ?? null,
    scheme: row.scheme,
    payTo: row.pay_to,
    priceRaw: row.price_raw,
    input: row.input,
    source: row.source,
    recordId: row.record_id,
  };
}

/** A listing of a service sold by a Central City agent (paid fee included, delivered here). */
const isHosted = (service: ListedService) =>
  service.source === HOSTED_SOURCE && service.recordId.startsWith('cc:');

/** The offer behind a hosted listing, as it is now. */
interface HostedOffer {
  offerId: string;
  kind: OfferKind;
  version: number;
  payTo: string;
  /** The price (fee included) split as the router pays it. */
  split: IncludedQuote;
  /** The offer's fixed input fields (city_offers.preset), merged into every call's input. */
  preset: OfferPreset | null;
}

const notPayable = (serviceId: string, reason: FeedPayNotPayableReason): FeedPayNotPayable => ({
  payable: false,
  serviceId,
  reason,
  message: FEED_PAY_NOT_PAYABLE_MESSAGES[reason],
});

// ---------------------------------------------------------------------------------------------
// Payers

interface Payer {
  agentId: string;
  agentName: string;
  paused: boolean;
  walletId: string;
  operatorId: string;
  ownerAccountId: string | null;
  walletState: string;
  wallet: WalletRef;
}

interface StoredAgent {
  id: string;
  name?: string;
  revokedAt?: string | number | null;
  pausedAt?: string | number | null;
}

interface PayerRow {
  agent_id: string;
  wallet_id: string;
  operator_id: string;
  owner_account_id: string | null;
  state: string;
  address: string;
  spender_address: string;
  spender_key_ref: string;
  agent: StoredAgent | null;
  paused: boolean | null;
}

/** The wallet and only its own agent's record (never the workspace's whole agent list). */
const PAYER_SELECT = `SELECT w.agent_id, w.wallet_id, w.operator_id, w.owner_account_id, w.state,
  w.address, w.spender_address, w.spender_key_ref,
  (SELECT a FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ws.data->'agents') = 'array'
     THEN ws.data->'agents' ELSE '[]'::jsonb END) a WHERE a->>'id' = w.agent_id LIMIT 1) AS agent,
  (ws.data->>'paused')::boolean AS paused
  FROM base_wallets w JOIN workspaces ws ON ws.operator_id = w.operator_id`;

function payerOfRow(row: PayerRow): Payer | null {
  const agent = row.agent;
  if (!agent || agent.id !== row.agent_id || agent.revokedAt) return null;
  return {
    agentId: row.agent_id,
    agentName: typeof agent.name === 'string' ? agent.name : '',
    paused: !!agent.pausedAt || !!row.paused,
    walletId: row.wallet_id,
    operatorId: row.operator_id,
    ownerAccountId: row.owner_account_id,
    walletState: row.state,
    wallet: {
      walletId: row.wallet_id,
      address: getAddress(row.address) as Address,
      spender: getAddress(row.spender_address) as Address,
      spenderKeyRef: row.spender_key_ref,
    },
  };
}

/** The agent with a wallet on Base that this caller may pay from, or null (one answer). */
async function payerFor(
  q: Queryable,
  caller: FeedPayCaller,
  agentId: string,
): Promise<Payer | null> {
  const { rows } = await q.query<PayerRow>(
    `${PAYER_SELECT} WHERE w.agent_id = $1 AND w.chain_id = $2 AND ${
      caller.origin === 'feed' ? 'w.owner_account_id' : 'w.operator_id'
    } = $3`,
    [agentId, CHAIN_ID, caller.origin === 'feed' ? caller.accountId : caller.workspaceId],
  );
  return rows[0] ? payerOfRow(rows[0]) : null;
}

/**
 * An agent never pays its own listing: a payee that is the paying agent's own wallet or its
 * spender account (walletRecipientRefusal, the rule Agent Pay and withdrawals share; lowercased
 * compare). Only this agent's own two accounts count: another agent of the same owner may pay it.
 */
const paysOwnService = (payer: Payer, payTo: string) =>
  walletRecipientRefusal(
    { address: payer.wallet.address, spenderAddress: payer.wallet.spender },
    payTo,
  ) !== null;

/** The refusal for it, with its own sentence (the page and MCP callers read the same words). */
const ownServiceRefusal = () =>
  new FeedPayRefusal(
    'not_payable',
    { reason: 'own_service' },
    FEED_PAY_NOT_PAYABLE_MESSAGES.own_service,
  );

interface Limit {
  permissionId: string;
  permissionHash: string | null;
  permission: SpendPermission;
  state: 'signed' | 'onchain';
  signature: Hex;
  capRaw: bigint;
  period: LimitPeriod | null;
  /** When the limit was stored (ms): spends before it were under another limit. */
  createdAtMs: number;
}

async function limitOf(q: Queryable, payer: Payer): Promise<Limit | null> {
  const ref = await activePaymentLimit(q, {
    chainId: CHAIN_ID,
    walletId: payer.walletId,
    token: USDC,
    spender: payer.wallet.spender,
  });
  if (!ref) return null;
  const { rows } = await q.query<{
    permission: Record<string, string | number>;
    signature: Uint8Array;
    state: 'signed' | 'onchain';
    cap_raw: string | null;
    period_kind: LimitPeriod | null;
    created_at: string | null;
  }>(
    `SELECT permission, signature, state, cap_raw::text AS cap_raw, period_kind,
       created_at::text AS created_at
     FROM base_spend_permissions WHERE permission_id = $1`,
    [ref.permissionId],
  );
  const row = rows[0];
  if (!row) return null;
  const permission = permissionOf(row.permission);
  return {
    permissionId: ref.permissionId,
    permissionHash: ref.permissionHash,
    permission,
    state: row.state,
    signature: `0x${Buffer.from(row.signature).toString('hex')}` as Hex,
    capRaw: row.cap_raw ? BigInt(row.cap_raw) : permission.allowance,
    period: row.period_kind ?? limitPeriodOf(permission.period),
    createdAtMs: Number(row.created_at ?? 0),
  };
}

/**
 * What Base's read of the limit (`left`, read at `readAtMs`, taken before the read) may still
 * miss: agent Pay payments and float top-ups under this limit that are held, planned, or settled
 * since the read (periodAllowanceInFlight). Both spend from the same on-chain allowance, so the
 * room left for a top-up is Base's `left` minus this. A limit not on Base yet (state 'signed')
 * counts everything settled in the period, as agent Pay does.
 */
async function limitLeftNow(
  q: Queryable,
  walletId: string,
  limit: Limit,
  read: { left: bigint; readAtMs: number },
  excludeHolderRef = '',
): Promise<bigint> {
  const inFlight = await periodAllowanceInFlight(q, {
    walletId,
    chainId: CHAIN_ID,
    token: USDC,
    window: basePeriodWindow(limit.permission, Math.floor(read.readAtMs / 1000)),
    limitCreatedAtMs: limit.createdAtMs,
    chainReadAtMs: limit.state === 'onchain' ? read.readAtMs : null,
    excludeHolderRef,
  });
  return max(read.left - inFlight, 0n);
}

const permissionRef = (limit: Limit): PermissionRef => ({
  permissionId: limit.permissionId,
  permission: limit.permission,
  state: limit.state,
  signature: limit.signature,
});

/**
 * The owner's consent for an agent to pay a Feed service on its own (the MCP origin; a payment
 * from the Feed page is confirmed by the person each time and never asks): live, for exactly this
 * limit, and confirmed for Feed services. A consent the owner gave for Central City agents only
 * refuses with a sentence saying they can confirm again to include Feed services. Null: consented.
 */
async function consentRefusal(
  q: Queryable,
  payer: Payer,
  limit: Limit,
): Promise<FeedPayRefusal | null> {
  if (!limit.permissionHash) return refuse('no_consent');
  try {
    await assertAgentPayConsent(q, {
      chainId: CHAIN_ID,
      walletId: payer.walletId,
      token: USDC,
      permissionId: limit.permissionId,
      permissionHash: limit.permissionHash,
      recipient: 'feed-service',
    });
    return null;
  } catch (error) {
    if (!(error instanceof AgentPayConsentError)) throw error;
    return error.reason === 'recipient_not_covered'
      ? new FeedPayRefusal('no_consent', {}, error.message)
      : refuse('no_consent');
  }
}

const hasConsent = async (q: Queryable, payer: Payer, limit: Limit) =>
  (await consentRefusal(q, payer, limit)) === null;

const HARD_MAX_RAW = BigInt(FEED_PAY_LIMITS.perCallMaxMaxRaw);

/**
 * The owner's per-call maximum (null = the default), never above the hard maximum in force: 0.10
 * USDC, or 100 USDC while fee router 2 is switched on (`cap`).
 */
async function perCallMaxOf(
  q: Queryable,
  walletId: string,
  cap: bigint = HARD_MAX_RAW,
): Promise<bigint | null> {
  const { rows } = await q.query<{ per_call_max_raw: string | null }>(
    'SELECT per_call_max_raw::text AS per_call_max_raw FROM feed_pay_agent_settings WHERE wallet_id = $1',
    [walletId],
  );
  if (!rows[0]?.per_call_max_raw) return null;
  const value = BigInt(rows[0].per_call_max_raw);
  return value > cap ? cap : value;
}

/** The owner's pot target (null = the default, DEFAULT_FLOAT_RAW), FEE_ROUTER_2.md section 6. */
async function floatTargetOf(q: Queryable, walletId: string): Promise<bigint | null> {
  const { rows } = await q.query<{ float_target_raw: string | null }>(
    'SELECT float_target_raw::text AS float_target_raw FROM feed_pay_agent_settings WHERE wallet_id = $1',
    [walletId],
  );
  return rows[0]?.float_target_raw ? BigInt(rows[0].float_target_raw) : null;
}

/**
 * The scoped pot rules (FEE_ROUTER_2.md section 6, D2/D3) apply to a router-2 call (total above 0.10
 * USDC) or an owner-set pot target above the default; everything else keeps today's float rules.
 */
const scopedPot = (amount: bigint, target: bigint | null) =>
  amount > 100_000n || (target !== null && target > BigInt(DEFAULT_FLOAT_RAW));

/**
 * Where `nowMs` falls in the limit's window on Base: before its start (a limit created under the
 * previous limit-start behavior started at the next 00:00 Berlin after it was prepared), from its
 * end on, or inside it.
 */
function limitWindow(limit: Limit, nowMs: number): AllowanceLeft['phase'] {
  const nowS = Math.floor(nowMs / 1000);
  if (nowS < limit.permission.start) return 'before_start';
  if (nowS >= limit.permission.end) return 'after_end';
  return 'active';
}

/** Unix seconds as the API's ISO 8601 text. */
const isoOf = (seconds: number) => new Date(seconds * 1000).toISOString();

/** The refusal for a limit that is not live on Base now: not started yet, or ended. */
function limitNotLive(limit: Limit, phase: AllowanceLeft['phase']): FeedPayRefusal | null {
  if (phase === 'before_start')
    return refuse('limit_not_started', { startsAt: isoOf(limit.permission.start) });
  if (phase === 'after_end') return refuse('no_spending_limit');
  return null;
}

/** What the calendar cap still allows now (null: the limit has no calendar period). */
async function calendarLeft(q: Queryable, limit: Limit, walletId: string, nowMs: number) {
  if (!limit.period) return null;
  const spent = await calendarSpent(q, {
    walletId,
    token: USDC,
    window: calendarPeriod(limit.period, nowMs),
  });
  const left = limit.capRaw - spent;
  return left > 0n ? left : 0n;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** What a send error says, as fixed labels only (never the provider's own words). */
const SEND_FAILURE_LABELS: readonly [label: string, pattern: RegExp][] = [
  ['paymaster_policy_rejected', /policy rejected|not in allowlist/i],
  ['request_denied', /request denied/i],
  ['rate_limited', /rate.?limit|too many requests|\b429\b/i],
  ['insufficient_funds', /insufficient/i],
  ['reverted', /revert/i],
  ['timeout', /time(d)? ?out/i],
  ['nonce', /nonce/i],
  ['gas', /\bgas\b/i],
];

/**
 * A send error for the operator log, as fixed labels from SEND_FAILURE_LABELS plus an EntryPoint
 * code (AAnn) and, for a policy rejection, the 4-byte method selector it names. The provider's
 * free text is never logged, so nothing it carries (a key, a token, an address) can leak.
 */
export function sendFailureDetail(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    const e = current as {
      message?: unknown;
      details?: unknown;
      shortMessage?: unknown;
      cause?: unknown;
    };
    for (const text of [e.shortMessage, e.details, e.message])
      if (typeof text === 'string') parts.push(text);
    current = e.cause;
  }
  const text = parts.join(' | ');
  const labels = SEND_FAILURE_LABELS.filter(([, pattern]) => pattern.test(text)).map(([l]) => l);
  const entryPoint = /\bAA\d\d\b/.exec(text)?.[0];
  if (entryPoint) labels.push(`entrypoint:${entryPoint}`);
  const selector = /not in allowlist:\s*(0x[0-9a-fA-F]{8})\b/i.exec(text)?.[1];
  if (selector) labels.push(`selector:${selector.toLowerCase()}`);
  return labels.length ? labels.join(',') : text ? 'unrecognized' : '';
}

/** A send error's code for the log: an UPPER_SNAKE name or an integer RPC code, else null. */
export function sendFailureCode(error: unknown): string | number | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'number' && Number.isInteger(code) && Math.abs(code) < 1e6) return code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(code)) return code;
  return null;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    work.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref?.()),
  ]);
}

// ---------------------------------------------------------------------------------------------
// The engine

const USDC_TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const TRANSFER_TOPIC = toEventSelector(USDC_TRANSFER);

/** At most this many recover pages per run (each `page` calls), within the run's budget. */
export const RECOVER_MAX_PAGES = 40;
/** Distinct blocks the facilitator finalizes per recover run (one block-hash read each). */
export const FINALITY_BATCH_BLOCKS = 200;
/**
 * Calls whose pay_final_at one recover run may record, oldest settled first: a large backlog drains
 * over a few runs instead of locking thousands of rows in one statement while payments are saved.
 */
export const FINALITY_CALLS_PER_RUN = 2_000;
/** The share of a recover run's budget bulk finality may use (its RPC reads stop there). */
export const FINALITY_BUDGET_SHARE = 0.15;
/** Calls with a payment out on Base taken first in each recover run, before the fair pass. */
/** Share of a recover run the batch lane's flush may take before the run goes on (#221). */
export const BATCH_FLUSH_BUDGET_SHARE = 0.15;
export const RECOVER_URGENT_PER_RUN = 10;
/** The most of a run's calls budget the urgent pass may use; the rest is the fair pass's. */
export const RECOVER_URGENT_SHARE = 0.3;
/** The share of a recover run's budget the calls may use; the rest is for float moves and sweeps. */
export const RECOVER_CALLS_SHARE = 0.7;

export function createFeedPayEngine(deps: FeedPayEngineDeps) {
  const { db, env } = deps;
  const now = deps.now ?? Date.now;
  const http = deps.http ?? feedPayHttps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? FEED_PAY_LIMITS.pollMs;
  const finalityPerRun = deps.finalityPerRun ?? FINALITY_CALLS_PER_RUN;
  const log = deps.log ?? ((line: string) => console.info(line));
  const alert = (value: Omit<FeedPayAlert, 'at'>) => {
    try {
      void Promise.resolve(deps.alert?.({ ...value, at: now() })).catch(() => {});
    } catch {
      // Alerts never stop a payment.
    }
  };

  async function chain(): Promise<FeedPayChainPort> {
    if (!baseNetwork(CHAIN_ID, env)) throw refuse('unavailable');
    try {
      return await deps.chain();
    } catch {
      throw refuse('unavailable');
    }
  }

  const baseHeaders = (body: string | null): Record<string, string> => ({
    accept: 'application/json, */*;q=0.8',
    'accept-encoding': 'identity',
    'user-agent': FEED_PAY_USER_AGENT,
    ...(body !== null ? { 'content-type': 'application/json' } : {}),
  });

  type Live =
    | { kind: 'payable'; option: ChosenOption; required: PaymentRequired; validityS: number }
    | { kind: 'not_payable'; reason: FeedPayNotPayableReason };

  /** ONE unpaid request to the listed URL with these inputs, and what its answer asks for. */
  async function live(service: ListedService, inputs: FeedPayInputs): Promise<Live> {
    const request = requestOf({ url: service.url, method: service.method! }, inputs);
    let answer;
    try {
      answer = await http({
        url: request.url,
        method: service.method!,
        headers: baseHeaders(request.body),
        body: request.body,
        timeoutMs: FEED_PAY_LIMITS.quoteTimeoutMs,
        maxBytes: FEED_PAY_LIMITS.paymentRequiredMaxBytes,
      });
    } catch (error) {
      // A listed address we never call (another port, a private or special address): not
      // payable as listed, and trying again does not help.
      if (
        error instanceof FeedPayHttpError &&
        (error.kind === 'bad_url' || error.kind === 'not_public')
      )
        return { kind: 'not_payable', reason: 'needs_own_setup' };
      if (error instanceof FeedPayHttpError) throw refuse('service_unreachable');
      throw error;
    }
    const read = readPaymentRequired(answer);
    if (read.kind === 'not_payable') return read;
    const choice = chooseOption(
      read.required,
      service.payTo,
      // Router 2's highest listed price for a fee-on-top call (90.909091 USDC, total 100), only while
      // router 2 is live and verified on chain; else router 1's 0.10 (review N1, spec section 3).
      (await liveRouter2(await chain().catch(() => null)))
        ? MAX_LISTED_PRICE_ROUTER2
        : PRICE_CAP_RAW,
    );
    if (choice.kind === 'not_payable') {
      if (choice.reason === 'payee_mismatch')
        alert({ kind: 'payee_mismatch', serviceId: service.id, host: service.host });
      return choice;
    }
    return {
      kind: 'payable',
      option: choice.option,
      required: read.required,
      validityS: Math.min(AUTH_VALIDITY_MAX_S, choice.option.maxTimeoutSeconds),
    };
  }

  /** Stores a quote and answers it. */
  async function storeQuote(
    accountId: string,
    service: ListedService,
    inputs: FeedPayInputs,
    found: Extract<Live, { kind: 'payable' }>,
  ): Promise<FeedPayQuote> {
    const quotedAt = now();
    const quote: FeedPayQuote = {
      payable: true,
      quoteId: newQuoteId(),
      serviceId: service.id,
      title: service.title,
      host: service.host,
      method: service.method!,
      amount: amountOf(found.option.amountRaw),
      listed: service.priceRaw === null ? null : amountOf(service.priceRaw),
      protocolFee: protocolFee()
        ? amountOf(feeFor(BigInt(found.option.amountRaw)).toString(10))
        : null,
      total: amountOf(
        (
          BigInt(found.option.amountRaw) +
          (protocolFee() ? feeFor(BigInt(found.option.amountRaw)) : 0n)
        ).toString(10),
      ),
      vsListing:
        service.priceRaw === null
          ? 'unlisted'
          : BigInt(found.option.amountRaw) === BigInt(service.priceRaw)
            ? 'same'
            : BigInt(found.option.amountRaw) < BigInt(service.priceRaw)
              ? 'lower'
              : 'higher',
      payTo: found.option.payTo,
      network: 'eip155:8453',
      asset: FEED_USDC,
      x402Version: found.required.x402Version,
      validityS: found.validityS,
      quotedAt,
      expiresAt: quotedAt + FEED_PAY_LIMITS.quoteTtlMs,
    };
    await db.query(
      `INSERT INTO feed_pay_quotes (quote_id, account_id, service_id, inputs_hash, amount_raw,
         pay_to, x402_version, validity_s, quoted_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        quote.quoteId,
        accountId,
        service.id,
        inputsHash(inputs),
        found.option.amountRaw,
        found.option.payTo,
        quote.x402Version,
        quote.validityS,
        quotedAt,
        quote.expiresAt,
      ],
    );
    return quote;
  }

  /** The listing and the inputs, checked before any request (both quote and call). */
  async function checkedService(serviceId: string, inputs: FeedPayInputs) {
    const service = await listedService(db, serviceId);
    if (!service) throw refuse('service_not_found');
    const reason = feedPayListingCheck({
      url: service.url,
      method: service.method,
      scheme: service.scheme,
      input: service.input,
    });
    if (reason) return { service, reason };
    // A service sold by a Central City agent is checked against its kind's own schema instead
    // (offerInputOf, by both callers before anything else), with that schema's plain reasons.
    if (isHosted(service)) return { service, reason: null };
    const fields: FeedPayInputProblem[] = inputProblems(
      { method: service.method!, input: service.input },
      inputs,
    );
    if (fields.length) throw refuse('invalid_inputs', { fields });
    return { service, reason: null };
  }

  const kinds = deps.offerKinds ?? OFFER_KIND_REGISTRY;

  /**
   * The offer behind a hosted listing: active, its listing unchanged (the same payee and price as
   * the offer), a kind this build runs, and a price the router's pay() takes. Anything else is not
   * a service that can be bought now: one answer, service_not_found.
   */
  async function hostedOfferOf(service: ListedService): Promise<HostedOffer> {
    const offerId = service.recordId.slice(3);
    if (!OFFER_ID.test(offerId)) throw refuse('service_not_found');
    const { rows } = await db.query<{
      offer_id: string;
      kind: string;
      version: number;
      pay_to: string;
      price_raw: string;
      state: string;
      preset: OfferPreset | null;
    }>(
      `SELECT offer_id, kind, version, pay_to, price_raw::text AS price_raw, state, preset
       FROM city_offers WHERE offer_id = $1`,
      [offerId],
    );
    const row = rows[0];
    if (
      !row ||
      row.state !== 'active' ||
      row.pay_to.toLowerCase() !== service.payTo.toLowerCase() ||
      service.priceRaw === null ||
      BigInt(row.price_raw) !== BigInt(service.priceRaw)
    )
      throw refuse('service_not_found');
    const kind = isOfferKind(row.kind) ? offerKind(row.kind, kinds) : null;
    if (!kind) throw refuse('service_not_found');
    let split: IncludedQuote;
    try {
      const port = BigInt(row.price_raw) > MAX_TOTAL ? await chain().catch(() => null) : null;
      // Above 0.10 USDC: router 3 or router 2, whichever is live (router 3 first, as at reservation).
      const r2 = !!port && !!((await liveRouter3(port)) ?? (await liveRouter2(port)));
      split = quoteFeeIncluded(BigInt(row.price_raw), r2 ? MAX_TOTAL_ROUTER2 : MAX_TOTAL);
    } catch {
      throw refuse('service_not_found');
    }
    return {
      offerId,
      kind,
      version: Number(row.version),
      payTo: row.pay_to,
      split,
      preset: row.preset ?? null,
    };
  }

  /**
   * A hosted service's input, checked as the kind checks it (checkOffer: its schema, then the
   * kind's own check()): a JSON body with exactly the kind's fields, no query. The offer's preset
   * is merged in first (mergeOfferPreset: a buyer value for a fixed field is refused unless equal).
   * Refused with the plain reason before anything is reserved. Answers the canonical input the
   * kind will run with, preset fields included.
   */
  function offerInputOf(offer: HostedOffer, inputs: FeedPayInputs): string {
    if (inputs.query && Object.keys(inputs.query).length)
      throw new FeedPayRefusal(
        'invalid_inputs',
        {},
        'This service takes its input as a JSON body only.',
      );
    const merged = mergeOfferPreset(offer.preset, inputs.body ?? {});
    if (!merged.ok) throw new FeedPayRefusal('invalid_inputs', {}, merged.reason);
    let value: Record<string, unknown>;
    try {
      value = checkOffer(offer.kind, merged.value);
    } catch (err) {
      if (err instanceof OfferKindInputError)
        throw new FeedPayRefusal('invalid_inputs', {}, err.message);
      throw err;
    }
    return canonicalJson(value);
  }

  /** Stores the price check of a hosted service: the listed price, fee included. */
  async function storeIncludedQuote(
    accountId: string,
    service: ListedService,
    inputs: FeedPayInputs,
    offer: HostedOffer,
  ): Promise<FeedPayQuote> {
    const quotedAt = now();
    const price = offer.split.gross.toString(10);
    const quote: FeedPayQuote = {
      payable: true,
      quoteId: newQuoteId(),
      serviceId: service.id,
      title: service.title,
      host: service.host,
      method: service.method!,
      amount: amountOf(price),
      listed: amountOf(price),
      protocolFee: amountOf(offer.split.fee.toString(10)),
      total: amountOf(price),
      feeIncluded: true,
      vsListing: 'same',
      payTo: getAddress(offer.payTo) as Address,
      network: 'eip155:8453',
      asset: FEED_USDC,
      x402Version: 2,
      validityS: AUTH_VALIDITY_MAX_S,
      quotedAt,
      expiresAt: quotedAt + FEED_PAY_LIMITS.quoteTtlMs,
    };
    await db.query(
      `INSERT INTO feed_pay_quotes (quote_id, account_id, service_id, inputs_hash, amount_raw,
         pay_to, x402_version, validity_s, quoted_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        quote.quoteId,
        accountId,
        service.id,
        inputsHash(inputs),
        price,
        offer.payTo,
        quote.x402Version,
        quote.validityS,
        quotedAt,
        quote.expiresAt,
      ],
    );
    return quote;
  }

  // -------------------------------------------------------------------------------------------
  // Quote

  async function quote(accountId: string, serviceId: string, body: unknown) {
    const parsed = feedPayQuoteBody.safeParse(body ?? {});
    if (!parsed.success) throw refuse('invalid_request');
    const inputs = parsed.data.inputs as FeedPayInputs;
    const { service, reason } = await checkedService(serviceId, inputs);
    if (reason) return notPayable(service.id, reason);
    // With the agent that would pay: its own listing is not payable, and the service is not asked.
    if (parsed.data.agentId !== undefined) {
      const payer = await payerFor(db, { origin: 'feed', accountId }, parsed.data.agentId);
      if (!payer) throw refuse('agent_not_found');
      if (paysOwnService(payer, service.payTo)) return notPayable(service.id, 'own_service');
    }
    // A service sold by a Central City agent: its listed price, fee included, with no request.
    if (isHosted(service)) {
      const offer = await hostedOfferOf(service);
      offerInputOf(offer, inputs);
      if (!protocolFee()) throw refuse('unavailable');
      return storeIncludedQuote(accountId, service, inputs, offer);
    }
    const found = await live(service, inputs);
    if (found.kind === 'not_payable') return notPayable(service.id, found.reason);
    return storeQuote(accountId, service, inputs, found) as Promise<FeedPayQuoteAnswer>;
  }

  // -------------------------------------------------------------------------------------------
  // Call

  const scopeOf = (caller: FeedPayCaller) =>
    caller.origin === 'feed' ? `feed:${caller.accountId}` : `mcp:${caller.workspaceId}`;
  const callerIdOf = (caller: FeedPayCaller) =>
    caller.origin === 'feed' ? caller.accountId : caller.workspaceId;
  const keyOf = (caller: FeedPayCaller, key: string) =>
    sha256Hex(`feed-pay:${caller.origin}:${key}`);
  /** The total the person confirmed (Feed); a request without one confirmed the price alone. */
  const maxTotalOf = (input: FeedPayCallInput) => input.maxTotalRaw ?? input.maxAmountRaw;
  const requestHashOf = (input: FeedPayCallInput) =>
    sha256Hex(
      canonicalJson({
        serviceId: input.serviceId,
        agentId: input.agentId,
        inputs: input.inputs,
        maxAmountRaw: input.maxAmountRaw.toString(10),
        quoteId: input.quoteId ?? null,
        // Only a total other than the price is part of the hash: absent and equal mean the same,
        // and every request from before the fee keeps its hash (a same-key retry stays the call).
        ...(maxTotalOf(input) !== input.maxAmountRaw
          ? { maxTotalRaw: maxTotalOf(input).toString(10) }
          : {}),
      }),
    );

  /** The call this caller's key names, if any (one read of the unique scope and key index). */
  async function existingCall(caller: FeedPayCaller, input: FeedPayCallInput) {
    const { rows } = await db.query<CallRow>(
      `${CALL_SELECT} WHERE c.scope = $1 AND c.idempotency_key = $2`,
      [scopeOf(caller), keyOf(caller, input.idempotencyKey)],
    );
    return rows[0] ?? null;
  }

  /** Calls of this workspace in flight, counted up to `upTo` (FEED_PAY_IN_FLIGHT_SQL). */
  async function callsInFlight(operatorId: string, upTo: number): Promise<number> {
    const { rows } = await db.query<{ n: number | string }>(FEED_PAY_IN_FLIGHT_SQL, [
      operatorId,
      upTo,
    ]);
    return Number(rows[0]?.n ?? 0);
  }

  /** In-memory context of the worker that holds a call (the MCP caller's grant re-check). */
  interface WorkContext {
    revalidate?: () => Promise<void>;
    /** The MCP grant or key of the request working this call (batch lane). */
    grant?: { kind: 'grant' | 'key'; id: string };
    /** Why the last authority check refused, for the failure code. */
    refusal?: FeedPayFailureCode;
    /**
     * The top-up (its move) that the bundler or paymaster refused only for its rate, with the
     * provider's Retry-After (ms; null: none sent): stepTopUp may plan a new one (planTopUpAgain).
     */
    rateLimited?: { moveId: string; retryAfterMs: number | null };
    /**
     * The fee-included payment (its operation key) that the provider refused only for its rate,
     * with its Retry-After (ms; null: none sent): stepIncluded may plan a new one (planPayAgain).
     */
    payRateLimited?: { key: string; retryAfterMs: number | null };
    /** When the worker that holds the call stops (ms): a re-plan due later is not made. */
    deadline?: number;
  }

  /**
   * Pays and calls (section 6): the checks, the reservation, then the work in the background. A
   * repeat of the same key answers the same call (and follows it again if no worker holds it).
   * `admission` charges the transport's budgets once the key says which: a re-read or a new call.
   */
  async function call(
    caller: FeedPayCaller,
    input: FeedPayCallInput,
    admission: FeedPayAdmission = {},
  ): Promise<{ call: FeedPayCall; work: Promise<void> | null }> {
    // The same key answers the same call, whatever happened to the listing since, as a re-read:
    // its own budget, never a new call's, and never the in-flight cap.
    const existing = await existingCall(caller, input);
    if (existing) {
      await admission.reread?.();
      if (existing.request_hash !== requestHashOf(input)) throw refuse('idempotency_conflict');
      return { call: callView(existing), work: follow(existing.call_id, caller) };
    }
    await admission.fresh?.();
    const { service, reason } = await checkedService(input.serviceId, input.inputs);
    if (reason) throw refuse('not_payable', { reason });
    // A service sold by a Central City agent: the offer as it is now, and the input checked against
    // its kind before anything else (an invalid input is refused, nothing reserved).
    const hosted = isHosted(service) ? await hostedOfferOf(service) : null;
    const offerInput = hosted ? offerInputOf(hosted, input.inputs) : null;

    // The Feed pays only what the person confirmed: the quote binds the person, the service, the
    // inputs, the price (at most the quoted amount) and the payee the quote showed.
    let quoted: { amountRaw: bigint; payTo: string } | null = null;
    if (caller.origin === 'feed') {
      if (input.quoteId === undefined) throw refuse('quote_mismatch');
      const { rows } = await db.query<{
        account_id: string;
        service_id: string;
        inputs_hash: string;
        amount_raw: string;
        pay_to: string;
        expires_at: string | number;
      }>(
        `SELECT account_id, service_id, inputs_hash, amount_raw::text AS amount_raw, pay_to,
           expires_at FROM feed_pay_quotes WHERE quote_id = $1`,
        [input.quoteId],
      );
      const row = rows[0];
      if (!row || Number(row.expires_at) <= now()) throw refuse('quote_expired');
      if (
        row.account_id !== caller.accountId ||
        row.service_id !== service.id ||
        row.inputs_hash !== inputsHash(input.inputs) ||
        input.maxAmountRaw > BigInt(row.amount_raw)
      )
        throw refuse('quote_mismatch');
      quoted = { amountRaw: BigInt(row.amount_raw), payTo: row.pay_to.toLowerCase() };
    }

    const payer = await payerFor(db, caller, input.agentId);
    if (!payer || !payer.ownerAccountId) throw refuse('agent_not_found');
    if (!feedPayEnabled(env)) throw refuse('not_found');
    if (payer.paused) throw refuse('agent_paused');
    if (payer.walletState !== 'derived' && payer.walletState !== 'deployed')
      throw refuse('wallet_not_usable');
    // An agent never pays its own listing: refused before the service is asked, and before
    // anything is reserved or signed.
    if (paysOwnService(payer, service.payTo)) throw ownServiceRefusal();
    const limit = await limitOf(db, payer);
    if (!limit) throw refuse('no_spending_limit');
    if (caller.origin === 'mcp') {
      await caller.revalidate();
      const noConsent = await consentRefusal(db, payer, limit);
      if (noConsent) throw noConsent;
    }
    // A limit not live on Base yet (or any more) can't pay: said before the service is asked.
    const notLive = limitNotLive(limit, limitWindow(limit, now()));
    if (notLive) throw notLive;
    // The in-flight cap of the paying agent's workspace, the same for every workspace: read from
    // the calls themselves, so it holds across instances, and before the service or Base is asked.
    const inFlightMax = deps.callsInFlightMax;
    if (
      inFlightMax !== undefined &&
      (await callsInFlight(payer.operatorId, inFlightMax)) >= inFlightMax
    )
      throw new FeedPayInFlightLimit();

    const feeConfig = protocolFee();
    // What is paid, and how. External (x402): the live 402 decides the payee and the price, and
    // Central City's 10% comes on top. Hosted (a service sold by a Central City agent): the offer's
    // payee and price, the fee INCLUDED in the price, paid through the fee router, no x402 request.
    let found: Extract<Live, { kind: 'payable' }> | null = null;
    let payTo: string;
    /** The price the caller confirms or bounds (max_price_usdc, the Feed's amount). */
    let price: bigint;
    /** The stored amount_raw: the price for x402; the seller's 90% for a fee-included call. */
    let amount: bigint;
    let fee: bigint;
    if (hosted) {
      // The fee is part of the price: without the fee router nothing can be paid.
      if (!feeConfig) throw refuse('unavailable');
      payTo = hosted.payTo;
      price = hosted.split.gross;
      amount = hosted.split.net;
      fee = hosted.split.fee;
    } else {
      const live402 = await live(service, input.inputs);
      if (live402.kind === 'not_payable') {
        if (live402.reason === 'payee_mismatch') throw refuse('payee_mismatch');
        throw refuse('not_payable', { reason: live402.reason });
      }
      found = live402;
      payTo = found.option.payTo;
      price = BigInt(found.option.amountRaw);
      amount = price;
      // With protocol fees on, Central City's 10% comes on top of the price and the caps hold for
      // the total the agent spends (docs/protocol/FEES.md): price + fee <= the per-call max <= $0.10.
      fee = feeConfig ? feeFor(price) : 0n;
    }
    // What the agent spends: price + fee on top, or the price itself with the fee included.
    const total = amount + fee;
    // The payee the person confirmed, or nothing: a listing that changed its pay_to since the
    // quote is a new payee, and a new payee needs a new confirm.
    if (quoted && payTo.toLowerCase() !== quoted.payTo) throw refuse('quote_mismatch');
    // The Feed pays at most the total the person confirmed. At or under the confirmed price, a
    // total above it is a fee they were never shown (fees switched on after the quote, or a page
    // from before the fee): a new total needs a new confirm, so the page checks the price again
    // and shows the fee first. A higher price is price_above_max below, with a fresh quote.
    if (caller.origin === 'feed' && price <= input.maxAmountRaw && total > maxTotalOf(input))
      throw refuse('quote_mismatch');
    // The payee that is signed for, checked again next to the caps: the live payee equals the
    // listing's (chooseOption, or the offer's), and it is never the agent's own wallet or spender.
    if (paysOwnService(payer, payTo)) throw ownServiceRefusal();
    const perCallMax =
      (await perCallMaxOf(db, payer.walletId, perCallCap())) ?? BigInt(DEFAULT_PER_CALL_MAX_RAW);
    // The router for this call, from the exact total only (docs/protocol/FEE_ROUTER_2.md section 3):
    // pinned below on the call row and never derived again. Without protocol fees nothing above
    // router 1's cap is payable, exactly as before router 2.
    // A service sold by a Central City agent (fee included) settles through router 3 whenever it is
    // live and verified with its facilitator able to pay (docs/protocol/FEE_ROUTER_3.md): one x402
    // transaction, no UserOperation. Anything else keeps routers 1 and 2 exactly as before.
    // While router 3 is switched on, a read failure (Base or the facilitator did not answer) never
    // reroutes a call it covers to routers 1/2: retried once, then refused 'unavailable'
    // (retryable). A router 3 that is really not ready (no facilitator, low gas, a contract
    // mismatch) still falls back to routers 1/2 as before, and the reason is logged.
    const router3 =
      feeConfig && hosted && total >= MIN_INCLUDED_ROUTER3 && total <= MAX_TOTAL_ROUTER3
        ? await router3ForNewCall()
        : null;
    const route = !feeConfig
      ? null
      : router3
        ? { router: router3, maxTotal: MAX_TOTAL_ROUTER3 }
        : routeFor({
            total,
            router: feeConfig.router as Hex,
            // Router 2 only when it is live AND verified on chain right now (fail closed).
            router2: total > MAX_TOTAL ? await liveRouter2(await chain().catch(() => null)) : null,
          });
    const hardMax = route ? route.maxTotal : MAX_TOTAL;
    if (total > perCallMax || total > hardMax || (feeConfig && (fee === 0n || !route)))
      throw refuse('over_per_call_max', {
        neededRaw: total.toString(10),
        perCallMaxRaw: perCallMax.toString(10),
      });
    if (feeConfig && !hosted) quoteFeeOnTop(price, hardMax); // the same rounding and cap as the contract
    if (price > input.maxAmountRaw)
      throw refuse('price_above_max', {
        neededRaw: price.toString(10),
        ...(caller.origin === 'feed'
          ? {
              quote: hosted
                ? await storeIncludedQuote(caller.accountId, service, input.inputs, hosted)
                : await storeQuote(caller.accountId, service, input.inputs, found!),
            }
          : {}),
      });

    // Base, read before the transaction (no RPC inside it): the float and what the limit allows.
    const port = await chain();
    let read: AllowanceLeft;
    let spender: { balance: bigint; blockNumber: bigint };
    // Taken before the read: a spend settled after this moment may be missing from it.
    const readAtMs = now();
    try {
      [read, spender] = await Promise.all([
        port.allowanceLeft(limit.permission),
        port.usdcBalance(payer.wallet.spender),
      ]);
    } catch {
      throw refuse('unavailable');
    }
    // Base's own clock may still be a little before the limit's start: the same refusal.
    if (read.phase !== 'active') throw limitNotLive(limit, read.phase)!;
    const allowance = read;
    let walletRead: { balance: bigint; blockNumber: bigint } | null = null;

    const callId = newCallId();
    const paymentId = randomUUID();
    const at = now();
    const token = randomUUID();
    const reserve = async () =>
      db.transaction(async (tx) => {
        await tx.query('SELECT 1 FROM base_wallets WHERE wallet_id = $1 FOR UPDATE', [
          payer.walletId,
        ]);
        // A concurrent request with the same key won: the same call, or a conflict.
        const again = await tx.query<{ call_id: string; request_hash: string }>(
          `SELECT call_id, request_hash FROM feed_pay_calls
           WHERE scope = $1 AND idempotency_key = $2`,
          [scopeOf(caller), keyOf(caller, input.idempotencyKey)],
        );
        if (again.rows[0]) {
          if (again.rows[0].request_hash !== requestHashOf(input))
            throw refuse('idempotency_conflict');
          return again.rows[0].call_id;
        }
        // A quote pays for one call: a second call on the same quote (another key, another agent)
        // is refused while the first is not cancelled, refused or expired (also a unique index).
        if (input.quoteId) {
          const used = await tx.query(
            `SELECT 1 FROM feed_pay_calls WHERE quote_id = $1
               AND state NOT IN ('cancelled','refused','expired') LIMIT 1`,
            [input.quoteId],
          );
          if (used.rows.length) throw refuse('quote_mismatch');
        }
        const calendar = await calendarLeft(tx, limit, payer.walletId, at);
        if (calendar !== null && total > calendar)
          throw refuse('over_limit', {
            neededRaw: total.toString(10),
            limitLeftRaw: calendar.toString(10),
          });
        // A stale reserved call (past its window, nothing started) can no longer pay: it holds
        // nothing here either, so a new call is not refused for money nobody can spend.
        const held = await floatHeld(tx, {
          walletId: payer.walletId,
          block: spender.blockNumber,
          staleBefore: at - FEED_PAY_TOPUP_RETRY.windowMs,
        });
        const floatFree = max(spender.balance - held, 0n);
        const need = total - floatFree;
        if (need > 0n) {
          // Agent Pay payments and other top-ups under this limit, held or settled after Base's
          // read, spend the same on-chain allowance (counted under the wallet lock).
          const left = await limitLeftNow(tx, payer.walletId, limit, {
            left: allowance.left,
            readAtMs,
          });
          if (need > left)
            throw refuse('over_limit', {
              neededRaw: total.toString(10),
              limitLeftRaw: (left + floatFree).toString(10),
            });
          if (!walletRead) throw new NeedWalletRead();
          const holds = await unavailableAmount(tx, {
            walletId: payer.walletId,
            token: USDC,
            blockNumber: walletRead.blockNumber,
          });
          if (walletRead.balance - holds < need)
            throw refuse('insufficient_funds', { neededRaw: need.toString(10) });
        }
        const intentHash = opIntentHash({
          paymentId,
          wallet: payer.walletId,
          to: payTo.toLowerCase(),
          amount: amount.toString(10),
        });
        await tx.query(
          `INSERT INTO base_payments (payment_id, operator_id, chain_id, actor_id, source_kind,
             source_ref, payer_wallet_id, intent_version, intent_hash, idempotency_key,
             token_address, recipient_address, amount, kind, state, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'agent',$5,$6,1,$7,$8,$9,$10,$11,'x402','created',$12,$12)`,
          [
            paymentId,
            payer.operatorId,
            CHAIN_ID,
            caller.origin === 'feed' ? caller.accountId : payer.agentId,
            payer.agentId,
            payer.walletId,
            intentHash,
            `feed-pay:${callId}`,
            USDC.toLowerCase(),
            payTo.toLowerCase(),
            amount.toString(10),
            at,
          ],
        );
        // A hosted service is never requested: its checked input is kept for the delivery.
        const request = hosted
          ? { url: service.url, body: offerInput }
          : requestOf({ url: service.url, method: service.method! }, input.inputs);
        await tx.query(
          `INSERT INTO feed_pay_calls (call_id, origin, scope, idempotency_key, request_hash,
             caller_id, actor, owner_account_id, operator_id, agent_id, agent_name, wallet_id,
             chain_id, service_id, service_title, host, method, request_url, request_body,
             max_amount_raw, quote_id, permission_id, permission_hash, payment_id, amount_raw,
             pay_to, x402_version, requirements, validity_s, state, lease_until, lease_token,
             created_at, updated_at, fee_raw, fee_state, fee_router, pay_kind, offer_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
             $23,$24,$25,$26,$27,$28::jsonb,$29,'reserved',$30,$31,$32,$32,$33,$34,$35,$36,$37)`,
          [
            callId,
            caller.origin,
            scopeOf(caller),
            keyOf(caller, input.idempotencyKey),
            requestHashOf(input),
            callerIdOf(caller),
            caller.origin === 'feed' ? `owner ${caller.accountId}` : caller.actor,
            payer.ownerAccountId,
            payer.operatorId,
            payer.agentId,
            payer.agentName,
            payer.walletId,
            CHAIN_ID,
            service.id,
            service.title,
            service.host,
            service.method,
            request.url,
            request.body,
            // The stored ceiling is what may be paid: never above the hard cap, whatever the caller offered.
            (input.maxAmountRaw > perCallCap() ? perCallCap() : input.maxAmountRaw).toString(10),
            input.quoteId ?? null,
            limit.permissionId,
            limit.permissionHash,
            paymentId,
            amount.toString(10),
            hosted ? getAddress(payTo) : payTo,
            found ? found.required.x402Version : 2,
            JSON.stringify(
              found
                ? {
                    accepted: found.option.raw,
                    resource: found.required.resource,
                    extensions: found.required.extensions,
                  }
                : {
                    accepted: {},
                    resource: null,
                    included: {
                      offerId: hosted!.offerId,
                      kind: hosted!.kind.name,
                      version: hosted!.version,
                    },
                  },
            ),
            found ? found.validityS : AUTH_VALIDITY_MAX_S,
            at + FEED_PAY_LEASE_MS,
            token,
            at,
            fee.toString(10),
            fee > 0n ? 'pending' : null,
            fee > 0n && route ? route.router.toLowerCase() : null,
            hosted ? 'included' : 'x402',
            hosted ? hosted.offerId : null,
          ],
        );
        await audit(tx, {
          at,
          actor: caller.origin === 'feed' ? `owner ${caller.accountId}` : caller.actor,
          operatorId: payer.operatorId,
          agentId: payer.agentId,
          kind: 'feed_pay_call_reserved',
          detail: {
            callId,
            paymentId,
            serviceId: service.id,
            host: service.host,
            payTo,
            amount: amount.toString(10),
            protocolFee: fee.toString(10),
            ...(hosted
              ? { feeIncluded: true, price: price.toString(10), offerId: hosted.offerId }
              : {}),
            maxAmount: input.maxAmountRaw.toString(10),
            ...(caller.origin === 'feed' ? { maxTotal: maxTotalOf(input).toString(10) } : {}),
            origin: caller.origin,
            permissionId: limit.permissionId,
          },
        });
        return callId;
      });
    // Two concurrent requests that lock different wallets can both pass the checks above; the
    // unique constraints then decide, answered as the refusal they stand for, never as a 500.
    const reserveOnce = async () => {
      try {
        return await reserve();
      } catch (error) {
        const code = (error as { code?: string }).code;
        const constraint = String((error as { constraint?: string }).constraint ?? '');
        if (code === '23505')
          throw refuse(constraint.includes('quote') ? 'quote_mismatch' : 'idempotency_conflict');
        // A check constraint (the $0.10 cap) is the database refusing an amount: never a 500.
        if (code === '23514') throw refuse('over_limit');
        throw error;
      }
    };
    let id: string;
    try {
      id = await reserveOnce();
    } catch (error) {
      if (!(error instanceof NeedWalletRead)) throw error;
      try {
        walletRead = await port.usdcBalance(payer.wallet.address);
      } catch {
        throw refuse('unavailable');
      }
      id = await reserveOnce();
    }
    const row = await loadCall(db, id);
    if (!row) throw refuse('call_not_found');
    if (id !== callId) return { call: callView(row), work: follow(id, caller) };
    const ctx: WorkContext =
      caller.origin === 'mcp'
        ? { revalidate: caller.revalidate, ...(caller.grant ? { grant: caller.grant } : {}) }
        : {};
    return { call: callView(row), work: work(id, token, ctx) };
  }

  /** Follows an existing call again when no worker holds it (never sends a paid request again). */
  function follow(callId: string, caller: FeedPayCaller): Promise<void> | null {
    const ctx: WorkContext =
      caller.origin === 'mcp'
        ? { revalidate: caller.revalidate, ...(caller.grant ? { grant: caller.grant } : {}) }
        : {};
    return (async () => {
      const token = await claim(callId);
      if (token) await work(callId, token, ctx);
    })();
  }

  /** Takes a call whose lease ran out; null when another worker holds it. */
  async function claim(callId: string): Promise<string | null> {
    const token = randomUUID();
    const at = now();
    const { rows } = await db.query<{ call_id: string }>(
      `UPDATE feed_pay_calls SET lease_until = $2, lease_token = $3
       WHERE call_id = $1 AND lease_until < $4 RETURNING call_id`,
      [callId, at + FEED_PAY_LEASE_MS, token, at],
    );
    return rows[0] ? token : null;
  }

  async function release(callId: string, token: string) {
    await db.query(
      'UPDATE feed_pay_calls SET lease_until = 0 WHERE call_id = $1 AND lease_token = $2',
      [callId, token],
    );
  }

  /** Runs a call's steps while this worker holds it, waiting on Base between them. */
  async function work(
    callId: string,
    token: string,
    ctx: WorkContext,
    budgetMs = FEED_PAY_WORK_MS,
  ) {
    const deadline = now() + budgetMs;
    ctx.deadline = deadline;
    let idle = 0;
    // When this worker's lease runs out as far as it knows. Not known at the start (the claim or the
    // reservation set it), so the first wait renews it; after that only when half of it is used.
    let leaseUntil = 0;
    try {
      for (;;) {
        // Without the result's text: no step reads it, and this re-read runs every pollMs.
        const row = await loadCall(db, callId, { text: false });
        if (!row || row.lease_token !== token) return;
        if (TERMINAL.has(row.state) && !openPayment(row) && !feeOwed(row)) return;
        const moved = await step(row, ctx);
        if (moved) {
          idle = 0;
          continue;
        }
        if (now() >= deadline) return;
        // Renewed only when less than half of it is left, not on every wait: with hundreds of calls
        // waiting on Base, a write per call every pollMs was most of the database's write load.
        if (leaseUntil - now() < FEED_PAY_LEASE_MS / 2) {
          leaseUntil = now() + FEED_PAY_LEASE_MS;
          await db.query(
            'UPDATE feed_pay_calls SET lease_until = $3 WHERE call_id = $1 AND lease_token = $2',
            [callId, token, leaseUntil],
          );
        }
        // Waiting on Base: every pollMs at first, then less often (at most 4 times pollMs), so a
        // slow block does not cost a read of the node every pollMs for the whole budget.
        await sleep(pollMs * Math.min(2 ** Math.floor(idle++ / 5), 4));
      }
    } catch (error) {
      log(
        JSON.stringify({
          event: 'feed_pay_work_failed',
          callId,
          error: error instanceof Error ? error.constructor.name : 'unknown',
        }),
      );
    } finally {
      await release(callId, token).catch(() => {});
    }
  }

  /** The fee router configuration while protocol fees are on for Feed pay's chain, else null. */
  function protocolFee() {
    if (!protocolFeesEnabled(env)) return null;
    const config = protocolFeeConfigFromEnv(env);
    return config && config.chainId === CHAIN_ID && config.router ? config : null;
  }

  /**
   * True while new calls may be routed to fee router 2: protocol fees on, router 2 configured and
   * CITY_PROTOCOL_FEE_ROUTER2_ENABLED exactly '1' (docs/protocol/FEE_ROUTER_2.md section 2).
   */
  function router2Live(): boolean {
    return feeRouter2Live(env) && Boolean(protocolFee());
  }

  /** Fee router 2's address from the one parser the ledger uses too (protocolRouter2FromEnv). */
  function router2Address(): Hex | null {
    return protocolRouter2FromEnv(env)[0]?.address ?? null;
  }

  /**
   * The most an owner may set as an agent's per-call maximum now: 0.10, or 100 USDC while router 2
   * or router 3 is switched on (router 3's on-chain readiness is checked on the call path).
   */
  function perCallCap(): bigint {
    return router2Live() || (feeRouter3Live(env) && Boolean(protocolFee()))
      ? BigInt(FEED_PAY_LIMITS.perCallMaxMaxRouter2Raw)
      : HARD_MAX_RAW;
  }

  /**
   * The cap of a router pinned on a call: router 1's or router 2's, whatever the switches say now
   * (a pinned call is finished on its router); null for any other address, which is never paid.
   */
  function pinnedMaxTotal(pinned: string): bigint | null {
    const config = protocolFeeConfigFromEnv(env);
    if (!config || config.chainId !== CHAIN_ID) return null;
    const same = (a: string | null) => a !== null && a.toLowerCase() === pinned.toLowerCase();
    if (same(config.router)) return MAX_TOTAL;
    if (same(router2Address())) return MAX_TOTAL_ROUTER2;
    if (same(router3AddressFromEnv(env))) return MAX_TOTAL_ROUTER3;
    return null;
  }

  /** True for a call pinned to fee router 3 (settled by the facilitator, never by a UserOp). */
  const onRouter3 = (row: { fee_router: string | null }) => {
    const r3 = router3AddressFromEnv(env);
    return !!r3 && !!row.fee_router && row.fee_router.toLowerCase() === r3.toLowerCase();
  };

  /**
   * Payment screening of a NEW submission (docs/protocol/SCREENING-GATE.md): null while
   * CITY_PROTOCOL_SCREENING is '0' (nothing changes), else the gate's decision; a missing gate or a
   * gate that throws is unavailable, never clearance. Reconciliation of anything already broadcast
   * never asks. Logged with ids and reasons only, never addresses.
   */
  async function screen(
    amountRaw: string | bigint,
    intentId: string,
    parties: ScreeningParty[],
  ): Promise<ScreeningDecision | null> {
    if (!screeningEnabled(env)) return null;
    const unavailable = (): ScreeningDecision => ({
      allowed: false,
      outcome: 'unavailable',
      decisionId: null,
      reason: deps.screening ? 'provider_unavailable' : 'not_configured',
      expiresAt: now(),
      reused: false,
    });
    let decision: ScreeningDecision;
    try {
      decision = deps.screening
        ? await deps.screening.screen({
            chainId: CHAIN_ID,
            token: USDC,
            amountRaw,
            intentId,
            parties,
          })
        : unavailable();
    } catch {
      decision = unavailable();
    }
    log(
      JSON.stringify({
        event: 'feed_pay_screening',
        intentId,
        outcome: decision.outcome,
        reason: decision.reason,
        decisionId: decision.decisionId,
        reused: decision.reused,
      }),
    );
    return decision;
  }

  const screeningFailure = (decision: ScreeningDecision): FeedPayFailureCode =>
    decision.outcome === 'blocked' ? 'screening_blocked' : 'screening_unavailable';

  /** The seller leg before anything is signed: the paying wallet, its spender and the payee. */
  async function screenSeller(row: CallRow): Promise<FeedPayFailureCode | null> {
    const decision = await screen(row.amount_raw, `feed-pay:${row.call_id}`, [
      { role: 'payer', address: row.wallet_address },
      { role: 'spender', address: row.spender_address },
      { role: 'payee', address: row.pay_to },
    ]);
    return decision && !decision.allowed ? screeningFailure(decision) : null;
  }

  /**
   * The treasury leg of a fee-included payment before anything is signed: the spender and the
   * treasury the pinned router really pays (read from the router). router.pay moves the fee in the
   * same operation as the seller's share, so there is no later fee step to hold it: a blocked or
   * unavailable answer refuses the call like the seller leg, and nothing is signed or sent.
   */
  async function screenTreasury(
    row: CallRow,
    treasury: string,
  ): Promise<FeedPayFailureCode | null> {
    const decision = await screen(row.fee_raw, `feed-pay:fee:${row.call_id}`, [
      { role: 'spender', address: row.spender_address },
      { role: 'fee_recipient', address: treasury },
    ]);
    return decision && !decision.allowed ? screeningFailure(decision) : null;
  }

  /**
   * The pinned router's immutable binding read on the payment chain (treasury() and token()),
   * cached per chain and router once read; a failed read is never cached.
   */
  const routerBindings = new Map<string, { treasury: string; token: string }>();

  /**
   * The fee recipient of a call's pinned router, from the router itself: the treasury it really
   * pays, never a configured address taken on trust. Null with a hold reason when it can't be
   * established: the read failed or is malformed (fee_recipient_unknown), the router's token is not
   * Feed pay's USDC (fee_router_token_mismatch), or the router pays another address than the
   * protocol treasury for the chain (fee_recipient_mismatch: on Base mainnet the treasury fixed in
   * code, shared/protocol.ts; elsewhere CITY_PROTOCOL_TREASURY when set). Every one of these holds
   * the fee.
   */
  async function feeRecipientOf(
    port: FeedPayChainPort,
    router: string | null,
  ): Promise<{ treasury: string } | { hold: string }> {
    if (!router || !/^0x[0-9a-fA-F]{40}$/.test(router)) return { hold: 'fee_recipient_unknown' };
    const cacheKey = `${CHAIN_ID}:${router.toLowerCase()}`;
    let binding = routerBindings.get(cacheKey);
    if (!binding) {
      let read: { treasury: string; token: string };
      try {
        read = await port.feeRouterBinding(getAddress(router) as Address);
      } catch {
        return { hold: 'fee_recipient_unknown' };
      }
      const valid = (value: unknown) =>
        typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);
      if (!read || !valid(read.treasury) || !valid(read.token))
        return { hold: 'fee_recipient_unknown' };
      binding = { treasury: read.treasury.toLowerCase(), token: read.token.toLowerCase() };
      routerBindings.set(cacheKey, binding);
    }
    if (binding.token !== USDC.toLowerCase()) return { hold: 'fee_router_token_mismatch' };
    const expected = protocolTreasuryFor(env, CHAIN_ID);
    if (expected && expected !== binding.treasury) return { hold: 'fee_recipient_mismatch' };
    return { treasury: binding.treasury };
  }

  /** Fee router 2 addresses already verified on chain (chain id and address; successes only). */
  const router2Verified = new Set<string>();

  /**
   * Fee router 2's readiness (docs/protocol/FEE_ROUTER_2.md section 2), checked
   * on chain before any money step above 0.10 USDC: code at the address, MAX_TOTAL = 100 USDC,
   * FEE_BPS = 10%, token = Feed pay's USDC and treasury = the protocol's (feeRecipientOf). Any
   * failed, unreadable or different value is not ready: nothing above 0.10 USDC is quoted, reserved,
   * topped up or signed (fail closed). Only a success is cached, so a failed read is tried again.
   */
  async function router2Ready(port: FeedPayChainPort, router: string | null): Promise<boolean> {
    if (!router || !/^0x[0-9a-fA-F]{40}$/.test(router)) return false;
    const key = `${CHAIN_ID}:${router.toLowerCase()}`;
    if (router2Verified.has(key)) return true;
    try {
      const address = getAddress(router) as Address;
      if (!(await port.isDeployed(address))) return false;
      const limits = await port.feeRouterLimits(address);
      if (limits.maxTotal !== MAX_TOTAL_ROUTER2 || limits.feeBps !== FEE_BPS) return false;
    } catch {
      return false;
    }
    if ('hold' in (await feeRecipientOf(port, router))) return false;
    router2Verified.add(key);
    return true;
  }

  /**
   * True while a call above 0.10 USDC must not go on: its pinned router is not the configured router
   * 2, or router 2 is not verified on chain right now. Checked before every step that signs or sends
   * for such a call, also for a call reserved, funded or signed earlier (spec section 2: a pinned
   * call is never sent through router 1 and nothing is signed or sent while router 2 is not ready).
   */
  async function router2Held(row: CallRow, port: FeedPayChainPort): Promise<boolean> {
    // A call pinned to router 3 (any amount) goes on only while router 3 and its facilitator are ready.
    if (onRouter3(row)) return !(await router3Ready(port, row.fee_router));
    if (BigInt(row.amount_raw) + BigInt(row.fee_raw) <= MAX_TOTAL) return false;
    if (!row.fee_router || pinnedMaxTotal(row.fee_router) !== MAX_TOTAL_ROUTER2) return true;
    return !(await router2Ready(port, row.fee_router));
  }

  /**
   * Router 2 for a new money step: its address only when it is switched on (router2Live) and
   * verified on chain (router2Ready); null otherwise, so nothing above 0.10 USDC goes ahead.
   */
  async function liveRouter2(port: FeedPayChainPort | null): Promise<Hex | null> {
    if (!router2Live() || !port) return null;
    const router = router2Address();
    return router && (await router2Ready(port, router)) ? router : null;
  }

  /** The facilitator, or null when none is wired or it cannot be built right now. */
  async function facilitator(): Promise<Router3FacilitatorPort | null> {
    try {
      return (await deps.facilitator?.()) ?? null;
    } catch {
      return null;
    }
  }

  /** Fee router 3 addresses already verified on chain (chain id and address; successes only). */
  const router3Verified = new Set<string>();

  /**
   * Fee router 3's readiness (docs/protocol/FEE_ROUTER_3.md), checked before anything is pinned to
   * it, signed for it or sent through it: code at the address, MAX_TOTAL = 100 USDC, FEE_BPS = 10%,
   * token = Feed pay's USDC, treasury = the protocol's (feeRecipientOf), and its nonceFor equal to
   * router3Nonce for a probe purchase (so the pair we sign is exactly the pair it verifies). Then
   * the facilitator must be wired and able to pay gas (not cached). Fail closed on any doubt.
   */
  async function router3Ready(port: FeedPayChainPort, router: string | null): Promise<boolean> {
    return (await router3Unready(port, router)) === null;
  }

  /** The facilitator answered canPay true at this time (ms); trusted for FACILITATOR_PAYABLE_TTL_MS. */
  let facilitatorPayableAt = -Infinity;

  /**
   * Why router 3 is not ready right now, or null when it is (router3Ready). 'probe_failed' and
   * 'facilitator_unreachable' are read failures (Base or the facilitator did not answer), worth one
   * quick retry; the others are real refusals.
   */
  async function router3Unready(
    port: FeedPayChainPort,
    router: string | null,
  ): Promise<Router3Unready | null> {
    if (!router || !/^0x[0-9a-fA-F]{40}$/.test(router)) return 'bad_address';
    const key = `${CHAIN_ID}:${router.toLowerCase()}`;
    if (!router3Verified.has(key)) {
      try {
        const address = getAddress(router) as Address;
        if (!(await port.isDeployed(address))) return 'not_deployed';
        const limits = await port.feeRouterLimits(address);
        if (limits.maxTotal !== MAX_TOTAL_ROUTER3 || limits.feeBps !== FEE_BPS) return 'limits';
        const recipient = await feeRecipientOf(port, router);
        // An unread (or malformed) binding is a read failure, not a mismatch: retried, then refused.
        if ('hold' in recipient)
          return recipient.hold === 'fee_recipient_unknown' ? 'probe_failed' : 'treasury_hold';
        const probe = {
          payer: getAddress(`0x${'11'.repeat(20)}`) as Address,
          payee: getAddress(`0x${'22'.repeat(20)}`) as Address,
          gross: MIN_INCLUDED_ROUTER3,
          ref: feeRef('router3-readiness'),
          validAfter: 0n,
          validBefore: 1n,
          leg: LEG_SELLER as 0 | 1,
        };
        const onChain = await port.router3NonceFor(address, probe);
        const ours = router3Nonce({
          chainId: CHAIN_ID,
          router: address as Hex,
          treasury: getAddress(recipient.treasury) as Hex,
          ...probe,
        });
        if (onChain.toLowerCase() !== ours.toLowerCase()) return 'nonce_mismatch';
      } catch {
        return 'probe_failed';
      }
      router3Verified.add(key);
    }
    // A facilitator that could not be built right now (its key or runtime threw) is unreachable,
    // not absent: only none wired (null) is a real 'no_facilitator'.
    let f: Router3FacilitatorPort | null;
    try {
      f = (await deps.facilitator?.()) ?? null;
    } catch {
      return 'facilitator_unreachable';
    }
    if (!f) return 'no_facilitator';
    // A recent 'can pay' is trusted briefly (one balance read per call was a failure point); the
    // facilitator still refuses a new settlement below its minimum balance (LOW_GAS_FUNDS).
    if (now() - facilitatorPayableAt < FACILITATOR_PAYABLE_TTL_MS) return null;
    let payable: boolean;
    try {
      payable = await f.canPay();
    } catch {
      return 'facilitator_unreachable';
    }
    if (!payable) return 'facilitator_low_gas';
    facilitatorPayableAt = now();
    return null;
  }

  /**
   * Router 3 for a new call it covers: its address when ready; null while it is switched off or
   * really not ready (routers 1/2 then, as before, logged); a read that keeps failing refuses the
   * call 'unavailable' instead of rerouting it.
   */
  async function router3ForNewCall(): Promise<Hex | null> {
    if (!feeRouter3Live(env) || !protocolFee()) return null;
    const router = router3AddressFromEnv(env);
    if (!router) return null;
    let reason: Router3Unready | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const port = await chain().catch(() => null);
      reason = port ? await router3Unready(port, router) : 'probe_failed';
      if (!reason) return router;
      if (reason !== 'probe_failed' && reason !== 'facilitator_unreachable') break;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, ROUTER3_RETRY_MS));
    }
    const transient = reason === 'probe_failed' || reason === 'facilitator_unreachable';
    log(JSON.stringify({ event: 'feed_pay.router3_unready', reason, fallback: !transient }));
    if (transient) throw refuse('unavailable');
    return null;
  }

  /** Router 3 for a new fee-included call: its address while switched on and ready, else null. */
  async function liveRouter3(port: FeedPayChainPort | null): Promise<Hex | null> {
    if (!port || !feeRouter3Live(env) || !protocolFee()) return null;
    const router = router3AddressFromEnv(env);
    return router && (await router3Ready(port, router)) ? router : null;
  }

  /** The readiness of the 100-USDC router a call is pinned to: router 3's or router 2's. */
  const bigRouterReady = (port: FeedPayChainPort, row: CallRow) =>
    onRouter3(row) ? router3Ready(port, row.fee_router) : router2Ready(port, row.fee_router);

  /**
   * Screening of a fee leg owed after the seller settled, before its first submission: true when
   * it is held (blocked, unavailable, or screened too recently to ask again). A held fee stays
   * pending under its one key: nothing is charged, nothing is sent under another key, ops are
   * alerted once per hold, and it is screened again after FEED_PAY_FEE_HOLD_RETRY_MS.
   *
   * The router's binding (its token is USDC, its treasury the protocol's) is checked whether
   * screening is on or off, as for a fee-included payment: a router that would pay another
   * treasury or move another token holds the fee. With screening off and the binding right, the
   * fee goes (an earlier screening hold is released at once).
   */
  async function feeHeld(row: CallRow, port: FeedPayChainPort): Promise<boolean> {
    const screening = screeningEnabled(env);
    const last = num(row.fee_held_at);
    const recent = last !== null && now() - last < FEED_PAY_FEE_HOLD_RETRY_MS;
    if (screening && recent) return true;
    // A fee owed through router 2 is held until router 2 is verified on chain (fail closed).
    if (
      row.fee_router &&
      pinnedMaxTotal(row.fee_router) === MAX_TOTAL_ROUTER2 &&
      !(await router2Ready(port, row.fee_router))
    )
      return true;
    const recipient = await feeRecipientOf(port, row.fee_router);
    if (!screening && 'treasury' in recipient) return false;
    // Screening off and the binding not right (or not readable): held, recorded once per interval.
    if (recent) return true;
    const decision =
      'treasury' in recipient
        ? await screen(row.fee_raw, `feed-pay:fee:${row.call_id}`, [
            { role: 'spender', address: row.spender_address },
            { role: 'fee_recipient', address: recipient.treasury },
          ])
        : null;
    if (decision?.allowed) return false;
    const reason = decision ? decision.reason : 'hold' in recipient ? recipient.hold : 'unknown';
    const moved = await move(row, { fee_held_at: now(), fee_hold_reason: reason });
    if (moved && last === null)
      alert({
        kind: 'protocol_fee_screening_hold',
        callId: row.call_id,
        serviceId: row.service_id,
        host: row.host,
        walletId: row.wallet_id,
        amountRaw: row.fee_raw,
        detail: reason,
      });
    return true;
  }

  /** The protocol fee is owed and not charged yet (it keeps the call live and its float held). */
  const feeOwed = (row: CallRow) => row.fee_state === 'pending' || row.fee_state === 'sent';

  const openPayment = (row: CallRow) =>
    row.payment_state === 'signed' ||
    row.payment_state === 'sent' ||
    row.payment_state === 'cancelling';

  /** Compare-and-set of a call's state (and fields); false when it moved meanwhile. */
  async function move(
    row: CallRow,
    patch: Record<string, unknown>,
    paymentState?: string,
    /** The call's end, audited in the same transaction as the move (never one without the other). */
    end?: { state: FeedPayCallState; failure: FeedPayFailureCode | null },
  ): Promise<boolean> {
    const keys = Object.keys(patch);
    const sets = keys.map((key, index) => `${key} = $${index + 4}`);
    const result = await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ call_id: string }>(
        `UPDATE feed_pay_calls SET ${[...sets, 'updated_at = GREATEST($3, updated_at + 1)'].join(', ')}
         WHERE call_id = $1 AND state = $2 AND updated_at = $${keys.length + 4}
         RETURNING call_id`,
        [row.call_id, row.state, now(), ...keys.map((key) => patch[key]), row.updated_at],
      );
      if (!rows[0]) return false;
      if (paymentState)
        await tx.query(
          `UPDATE base_payments SET state = $2, version = version + 1, updated_at = $3
           WHERE payment_id = $1 AND state NOT IN ('paid','failed')`,
          [row.payment_id, paymentState, now()],
        );
      if (end) await ended(tx, row, end.state, end.failure);
      return true;
    });
    return result;
  }

  /** Ends a call before anything was signed: nothing paid. */
  async function refused(row: CallRow, failure: FeedPayFailureCode) {
    const fee = row.fee_state === 'pending' ? { fee_state: 'not_owed' } : {};
    return move(
      row,
      { state: 'refused', failure_code: failure, ...fee, ...scrubbed(row) },
      'failed',
      {
        state: 'refused',
        failure,
      },
    );
  }

  async function ended(
    q: Queryable,
    row: CallRow,
    state: FeedPayCallState,
    failure: FeedPayFailureCode | null,
  ) {
    await audit(q, {
      at: now(),
      actor: row.actor,
      operatorId: row.operator_id,
      agentId: row.agent_id,
      kind: 'feed_pay_call_ended',
      detail: { callId: row.call_id, paymentId: row.payment_id, state, failure },
    });
  }

  /** The payer, limit and flags still as reserved (and the MCP grant and consent). */
  async function authority(row: CallRow, ctx: WorkContext): Promise<FeedPayFailureCode | null> {
    if (!feedPayEnabled(env)) return 'paused';
    const caller: FeedPayCaller =
      row.origin === 'feed'
        ? { origin: 'feed', accountId: row.caller_id }
        : {
            origin: 'mcp',
            workspaceId: row.caller_id,
            actor: row.actor,
            revalidate: ctx.revalidate ?? (async () => {}),
          };
    const payer = await payerFor(db, caller, row.agent_id);
    if (
      !payer ||
      payer.walletId !== row.wallet_id ||
      payer.paused ||
      (payer.walletState !== 'derived' && payer.walletState !== 'deployed')
    )
      return 'limit_changed';
    const limit = await limitOf(db, payer);
    if (!limit || limit.permissionId !== row.permission_id) return 'limit_changed';
    if (row.origin === 'mcp') {
      // Only the worker of the MCP request itself can re-check its grant.
      if (!ctx.revalidate) return 'limit_changed';
      try {
        await ctx.revalidate();
      } catch {
        return 'limit_changed';
      }
      if (!(await hasConsent(db, payer, limit))) return 'limit_changed';
    }
    return null;
  }

  const walletRef = (row: CallRow): WalletRef => ({
    walletId: row.wallet_id,
    address: getAddress(row.wallet_address) as Address,
    spender: getAddress(row.spender_address) as Address,
    spenderKeyRef: row.spender_key_ref,
  });

  /** One step of a call; true when it moved (the loop goes on at once). */
  async function step(row: CallRow, ctx: WorkContext): Promise<boolean> {
    // A service sold by a Central City agent, once its float is ready: the router payment, then
    // the delivery (stepIncluded).
    if (row.pay_kind === 'included' && row.state !== 'reserved' && row.state !== 'float_topup')
      return stepIncluded(row, ctx);
    switch (row.state) {
      case 'reserved':
        return stepReserved(row, ctx);
      case 'float_topup':
        return stepTopUp(row, ctx);
      case 'authorized':
        return stepCall(row, ctx);
      case 'calling':
        // Only a worker that died while calling leaves this; the cron moves it to reconciling.
        return false;
      default:
        // The seller was paid: the protocol fee owed on top is charged next (FEES.md).
        if (row.payment_state === 'settled' && feeOwed(row)) return stepFee(row);
        return stepReconcile(row);
    }
  }

  /** A reserved call past the top-up retry window that never started a top-up or a payment. */
  function staleReserved(row: CallRow): boolean {
    return (
      row.payment_state === null &&
      row.topup_move_id === null &&
      Number(row.topup_attempts) === 0 &&
      Number(row.pay_attempts) === 0 &&
      now() > Number(row.created_at) + FEED_PAY_TOPUP_RETRY.windowMs
    );
  }

  async function stepReserved(row: CallRow, ctx: WorkContext): Promise<boolean> {
    const refusal = await authority(row, ctx);
    if (refusal) return refused(row, refusal);
    // Past the top-up retry window without ever starting a top-up or a payment: it no longer holds
    // the float (floatHeld staleBefore), so it can no longer pay either.
    if (staleReserved(row)) return refused(row, 'float_topup_failed');
    // A rate-limited top-up planned again (planTopUpAgain): nothing goes on before its time. The
    // authority check above still ends the call meanwhile (Feed pay off, a paused agent, a
    // changed limit, a revoked grant or consent), and then no top-up is planned again.
    if (row.topup_retry_at !== null && now() < Number(row.topup_retry_at)) return false;
    // A rate-limited payment planned again (planPayAgain): likewise nothing before its time, and
    // only within the retry window of the call's first payment.
    if (row.pay_retry_at !== null && now() < Number(row.pay_retry_at)) return false;
    if (row.pay_attempts > 0 && now() > firstPayAt(row) + FEED_PAY_PAY_RETRY.windowMs) {
      payRetryExhausted(row, row.pay_attempts, 'window');
      return refused(row, 'interrupted');
    }
    const screened = await screenSeller(row);
    if (screened) return refused(row, screened);
    const port = await chain().catch(() => null);
    if (!port) return false;
    // A call above 0.10 USDC whose router 2 is not (or no longer) ready: nothing goes on, and it ends
    // unsigned once the top-up retry window has passed.
    if (await router2Held(row, port)) {
      if (now() > Number(row.created_at) + FEED_PAY_TOPUP_RETRY.windowMs)
        return refused(row, 'interrupted');
      return false;
    }
    const wallet = walletRef(row);
    let spender: { balance: bigint; blockNumber: bigint };
    let deployed: boolean;
    try {
      [spender, deployed] = await Promise.all([
        port.usdcBalance(wallet.spender),
        port.isDeployed(wallet.spender),
      ]);
    } catch {
      return false;
    }
    // Only what was asked for before this call holds the float: reserved calls of the same wallet
    // queued after it wait for it (first come, first paid), never the other way round.
    const held = await floatHeld(db, {
      walletId: row.wallet_id,
      block: spender.blockNumber,
      excludePaymentId: row.payment_id,
      queuedAfter: { createdAt: Number(row.created_at), callId: row.call_id },
      staleBefore: now() - FEED_PAY_TOPUP_RETRY.windowMs,
    });
    const floatFree = max(spender.balance - held, 0n);
    // The float must hold the price and the protocol fee owed on top of it.
    const amount = BigInt(row.amount_raw) + BigInt(row.fee_raw);
    if (floatFree >= amount && deployed) return proceed(row, ctx);
    // D2 (scoped only): the pot holds enough, but other calls' holds make it short. The call waits for
    // them, bounded by the top-up retry window, instead of pulling a second top-up.
    if (
      deployed &&
      spender.balance >= amount &&
      scopedPot(amount, await floatTargetOf(db, row.wallet_id))
    ) {
      if (now() > Number(row.created_at) + FEED_PAY_TOPUP_RETRY.windowMs)
        return refused(row, 'float_topup_failed');
      return false;
    }
    // Another call's top-up of this float is on its way: wait for it rather than pull twice, bounded
    // by the top-up retry window like a hold. Unbounded, a top-up that stays in flight (a slow or
    // stuck operation) kept every younger call of the wallet reserved for hours, each one holding
    // its share of the float and of the agent's slots (stress run, 21 Oct).
    if (await topUpInFlight(db, row.wallet_id)) {
      if (now() > Number(row.created_at) + FEED_PAY_TOPUP_RETRY.windowMs)
        return refused(row, 'float_topup_failed');
      return false;
    }
    // A top-up planned again only within the retry window of the call's first one.
    if (
      row.topup_attempts > 0 &&
      now() > (await firstTopUpAt(row)) + FEED_PAY_TOPUP_RETRY.windowMs
    ) {
      retryExhausted(row, row.topup_attempts, 'window');
      return refused(row, 'float_topup_failed');
    }
    // A router-2 call tops up only once router 2 is verified on chain (fail closed), bounded by the
    // top-up retry window like a hold.
    if (amount > MAX_TOTAL && !(await bigRouterReady(port, row))) {
      if (now() > Number(row.created_at) + FEED_PAY_TOPUP_RETRY.windowMs)
        return refused(row, 'float_topup_failed');
      return false;
    }
    return startTopUp(row, ctx, port, floatFree);
  }

  /** Plans and sends the float top-up (section 8), or ends the call when it can't be done. */
  async function startTopUp(
    row: CallRow,
    ctx: WorkContext,
    port: FeedPayChainPort,
    floatFree: bigint,
  ): Promise<boolean> {
    const payer = await payerFor(
      db,
      { origin: 'feed', accountId: row.owner_account_id },
      row.agent_id,
    );
    const limit = payer ? await limitOf(db, payer) : null;
    if (!payer || !limit || limit.permissionId !== row.permission_id)
      return refused(row, 'limit_changed');
    const amount = BigInt(row.amount_raw) + BigInt(row.fee_raw);
    let allowance: AllowanceLeft;
    let walletRead: { balance: bigint; blockNumber: bigint };
    // Taken before the read: a spend settled after this moment may be missing from it.
    const readAtMs = now();
    try {
      [allowance, walletRead] = await Promise.all([
        port.allowanceLeft(limit.permission),
        port.usdcBalance(payer.wallet.address),
      ]);
    } catch {
      return false;
    }
    // Not live on Base now (as when its read reverted): tried again later.
    if (allowance.phase !== 'active') return false;
    const holds = await unavailableAmount(db, {
      walletId: row.wallet_id,
      token: USDC,
      blockNumber: walletRead.blockNumber,
    });
    const walletFree = max(walletRead.balance - holds, 0n);
    const calendar = await calendarLeft(db, limit, row.wallet_id, now());
    // Agent Pay payments under the same limit that Base's read may not show yet (held, or settled
    // since the read) spend the same on-chain allowance: the top-up is sized within what is left.
    const read = { left: allowance.left, readAtMs };
    const target = await floatTargetOf(db, row.wallet_id);
    const topUp = floatTopUp({
      amount,
      floatFree,
      allowanceLeft: await limitLeftNow(db, row.wallet_id, limit, read),
      walletFree,
      calendar,
      target: target ?? BigInt(DEFAULT_FLOAT_RAW),
      scoped: scopedPot(amount, target),
    });
    if (topUp === 'insufficient_funds' || topUp === 'over_limit') return refused(row, topUp);
    const moveId = randomUUID();
    const key = `feed-pay:top-up:${moveId}`;
    const intentHash = opIntentHash({ moveId, wallet: row.wallet_id, amount: topUp.toString(10) });
    const at = now();
    const ok = await db.transaction(async (tx) => {
      // One top-up at a time per wallet, and none while a sweep is on its way: the wallet row is
      // the lock (as for agent Pay's reservations), and the check is made again under it.
      await tx.query('SELECT 1 FROM base_wallets WHERE wallet_id = $1 FOR UPDATE', [row.wallet_id]);
      if ((await topUpInFlight(tx, row.wallet_id)) || (await sweepPending(tx, row.wallet_id)))
        return false;
      // An agent Pay payment reserved since the sizing above may leave too little for this
      // top-up: nothing is planned now, and the call is looked at again later (sized anew).
      if (topUp > (await limitLeftNow(tx, row.wallet_id, limit, read, key))) return false;
      const { rows } = await tx.query<{ call_id: string }>(
        `UPDATE feed_pay_calls SET state = 'float_topup', topup_move_id = $2,
           topup_retry_at = NULL, updated_at = $3
         WHERE call_id = $1 AND state = 'reserved' AND updated_at = $4 RETURNING call_id`,
        [row.call_id, moveId, at, row.updated_at],
      );
      if (!rows[0]) return false;
      await tx.query(
        `INSERT INTO feed_pay_float_moves (move_id, wallet_id, chain_id, kind, amount_raw, op_key,
           intent_hash, state, call_id, period_end, created_at, updated_at)
         VALUES ($1,$2,$3,'top_up',$4,$5,$6,'pending',$7,$8,$9,$9)`,
        [
          moveId,
          row.wallet_id,
          CHAIN_ID,
          topUp.toString(10),
          key,
          intentHash,
          row.call_id,
          allowance.periodEnd,
          at,
        ],
      );
      await tx.query(
        `INSERT INTO feed_pay_agent_settings (wallet_id, float_open, float_period_end,
           float_permission_id, updated_at)
         VALUES ($1, true, $2, $3, $4)
         ON CONFLICT (wallet_id) DO UPDATE SET float_open = true, float_period_end = $2,
           float_permission_id = $3, updated_at = $4`,
        [row.wallet_id, allowance.periodEnd, limit.permissionId, at],
      );
      await audit(tx, {
        at,
        actor: row.actor,
        operatorId: row.operator_id,
        agentId: row.agent_id,
        kind: 'feed_pay_float_top_up',
        detail: { moveId, callId: row.call_id, amount: topUp.toString(10) },
      });
      return true;
    });
    if (!ok) return false;
    const current = await loadCall(db, row.call_id);
    if (!current) return false;
    await sendTopUp(current, ctx, port, permissionRef(limit));
    return true;
  }

  async function sendTopUp(
    row: CallRow,
    ctx: WorkContext,
    port: FeedPayChainPort,
    limit: PermissionRef,
  ): Promise<void> {
    const moveRow = await moveOf(row.topup_move_id);
    if (!moveRow) return;
    ctx.rateLimited = undefined;
    try {
      await port.topUp({
        key: moveRow.op_key,
        intentHash: moveRow.intent_hash as Hex,
        wallet: walletRef(row),
        limit,
        amount: BigInt(moveRow.amount_raw),
        beforeBroadcast: async () => {
          const refusal = await authority(row, ctx);
          if (refusal) {
            ctx.refusal = refusal;
            throw new Error('refused');
          }
          // The top-up is a new submission: the agent's wallet to its own spender account.
          const decision = await screen(moveRow.amount_raw, `feed-pay:top-up:${moveRow.move_id}`, [
            { role: 'payer', address: row.wallet_address },
            { role: 'spender', address: row.spender_address },
          ]);
          if (decision && !decision.allowed) {
            ctx.refusal = screeningFailure(decision);
            throw new Error('refused');
          }
        },
      });
    } catch (error) {
      // Refused for good before anything was stored (the wallet's USDC, the limit, no sponsor or
      // fee budget): the call ends. Anything else (a node that did not answer) is tried again.
      if (error instanceof FeedPayChainError)
        ctx.refusal ??=
          error.code === 'INSUFFICIENT_BALANCE' ? 'insufficient_funds' : 'float_topup_failed';
      // Refused only for the provider's rate (an HTTP 429 or a 'busy' answer, carried as data on
      // the BundlerError): stepTopUp may plan a new top-up once the stored op proves it never
      // went out. Any other error (configuration, sponsor policy, allowlist, funds) never does.
      if (!ctx.refusal && bundlerRateLimited(error))
        ctx.rateLimited = { moveId: moveRow.move_id, retryAfterMs: error.retryAfterMs ?? null };
      // The top-up send raised an error: its cause in fixed labels only (as feed_pay.included_send_failed).
      // Not proof that nothing was broadcast; the stored op (neverSent) says that.
      if (!(error instanceof Error && error.message === 'refused'))
        log(
          JSON.stringify({
            event: 'feed_pay.topup_send_failed',
            callId: row.call_id,
            error: error instanceof Error ? error.constructor.name : 'unknown',
            code: sendFailureCode(error),
            detail: sendFailureDetail(error),
          }),
        );
      // The op step below reads what was stored (or the tombstone) and ends the call.
    }
  }

  /**
   * An operation of a call or a float move as Base and the store have it now. One stored but never
   * claimed for its first send (still 'queued') past the recover grace is expired on the way
   * (FeedPayChainPort.opStatus): its worker died, or its claim failed, between the insert and the
   * send, and nothing else would ever send or end it. It then reads as never sent, and each step
   * ends what waited on it as for any operation that never went out (nothing paid, holds released).
   */
  const opOf = (port: FeedPayChainPort, key: string, walletId: string) =>
    port.opStatus(key, walletId, { expireQueuedBefore: now() - FEED_PAY_RECOVER_GRACE_MS });

  async function moveOf(moveId: string | null): Promise<MoveRow | null> {
    if (!moveId) return null;
    const { rows } = await db.query<MoveRow>(
      `SELECT ${MOVE_COLUMNS} FROM feed_pay_float_moves WHERE move_id = $1`,
      [moveId],
    );
    return rows[0] ?? null;
  }

  async function endMove(moveRow: MoveRow, state: 'final' | 'failed', txHash: Hex | null) {
    await db.query(
      `UPDATE feed_pay_float_moves SET state = $2, tx_hash = COALESCE($3, tx_hash), updated_at = $4
       WHERE move_id = $1 AND state = 'pending'`,
      [moveRow.move_id, state, txHash?.toLowerCase() ?? null, now()],
    );
  }

  async function stepTopUp(row: CallRow, ctx: WorkContext): Promise<boolean> {
    const port = await chain().catch(() => null);
    if (!port) return false;
    const moveRow = await moveOf(row.topup_move_id);
    if (!moveRow) return refused(row, 'float_topup_failed');
    let op = await opOf(port, moveRow.op_key, row.wallet_id).catch(() => undefined);
    if (op === undefined) return false;
    /** Fences the never-stored top-up (nothing can send it later) and ends the call. */
    const endUnsent = async (failure: FeedPayFailureCode) => {
      if (!(await port.endUnsent(moveRow.op_key, moveRow.intent_hash as Hex, 'top_up')))
        return false;
      await endMove(moveRow, 'failed', null);
      return refused(row, failure);
    };
    if (op === null) {
      if (ctx.refusal) return endUnsent(ctx.refusal);
      // Planned but never sent (the worker stopped in between): send it now, same key.
      const payer = await payerFor(
        db,
        { origin: 'feed', accountId: row.owner_account_id },
        row.agent_id,
      );
      const limit = payer ? await limitOf(db, payer) : null;
      if (!limit || limit.permissionId !== row.permission_id) return endUnsent('limit_changed');
      await sendTopUp(row, ctx, port, permissionRef(limit));
      op = await opOf(port, moveRow.op_key, row.wallet_id).catch(() => undefined);
      if (op === null && ctx.refusal) return endUnsent(ctx.refusal);
      if (!op) return false;
    }
    if (op.neverSent || op.status === 'failed' || (op.status === 'final' && op.errorCode)) {
      log(
        JSON.stringify({
          event: 'feed_pay.topup_failed',
          callId: row.call_id,
          status: op.status,
          neverSent: Boolean(op.neverSent),
          refusal: ctx.refusal ?? null,
          code: sendFailureCode({ code: op.errorCode }),
        }),
      );
      // Refused only for the provider's rate, and provably never sent: a new top-up later
      // (planTopUpAgain), unless its attempts or its time are used up.
      const limited = ctx.rateLimited?.moveId === moveRow.move_id ? ctx.rateLimited : null;
      if (limited && op.neverSent && !ctx.refusal) {
        const again = await planTopUpAgain(row, moveRow, ctx, limited.retryAfterMs);
        if (again !== 'exhausted') return again;
      }
      await endMove(moveRow, 'failed', op.txHash);
      return refused(row, ctx.refusal ?? 'float_topup_failed');
    }
    // In a block but reverted (not deep enough to be failed yet): nothing moved. Wait for Base.
    if (op.status === 'included' && op.errorCode) return false;
    if (op.status === 'final') await endMove(moveRow, 'final', op.txHash);
    // In a block (or final), without a revert: the USDC is in the spender account and the
    // account is deployed.
    if (op.status === 'included' || op.status === 'final') return proceed(row, ctx);
    return false;
  }

  /** When the call's first float top-up was planned (ms). */
  async function firstTopUpAt(row: CallRow): Promise<number> {
    // By wallet first: feed_pay_float_moves_wallet holds it (there is no index by call).
    const { rows } = await db.query<{ at: string | number | null }>(
      `SELECT MIN(created_at) AS at FROM feed_pay_float_moves
       WHERE wallet_id = $1 AND call_id = $2 AND kind = 'top_up'`,
      [row.wallet_id, row.call_id],
    );
    return Number(rows[0]?.at ?? now());
  }

  /** No rate-limited top-up is planned again: fixed labels only. */
  const retryExhausted = (
    row: CallRow,
    attempts: number,
    reason: 'attempts' | 'window' | 'retry_after' | 'budget',
  ) =>
    log(
      JSON.stringify({
        event: 'feed_pay.topup_retry_exhausted',
        callId: row.call_id,
        attempts,
        reason,
      }),
    );

  /**
   * A new float top-up for a call whose top-up the provider refused only for its rate
   * (FEED_PAY_TOPUP_RETRY). In one transaction, under the wallet's top-up lock and against the
   * call as read: the old operation is proven terminal and never broadcast (failed with a
   * NEVER_BROADCAST code; such a row is never sent again), its float hold released, its move ended
   * failed, and the call goes back to 'reserved' without a top-up until topup_retry_at. From there
   * it takes the normal path again (stepReserved: authority, screening, the float, then startTopUp
   * with the limit, allowance, calendar cap, wallet balance and the one-top-up-per-wallet lock).
   * 'exhausted': attempts or time (the window, or this worker's budget) are used up, and the call
   * ends as before; false: not now (the call moved meanwhile, or the hold is not released yet).
   */
  async function planTopUpAgain(
    row: CallRow,
    moveRow: MoveRow,
    ctx: WorkContext,
    retryAfterMs: number | null,
  ): Promise<boolean | 'exhausted'> {
    const done = row.topup_attempts;
    if (done >= FEED_PAY_TOPUP_RETRY.attempts) {
      retryExhausted(row, done, 'attempts');
      return 'exhausted';
    }
    const waitMs = topUpRetryWaitMs(done + 1, retryAfterMs);
    if (waitMs === null) {
      retryExhausted(row, done, 'retry_after');
      return 'exhausted';
    }
    const at = now();
    if (at + waitMs > (await firstTopUpAt(row)) + FEED_PAY_TOPUP_RETRY.windowMs) {
      retryExhausted(row, done, 'window');
      return 'exhausted';
    }
    // Due after this worker stops (with a margin for its last polls): nothing would take it up in
    // time, and the cron would only end the call 'interrupted' later. It ends now instead.
    if (at + waitMs + FEED_PAY_TOPUP_RETRY.budgetMarginMs > (ctx.deadline ?? at)) {
      retryExhausted(row, done, 'budget');
      return 'exhausted';
    }
    const planned = await db.transaction(async (tx) => {
      await tx.query('SELECT 1 FROM base_wallets WHERE wallet_id = $1 FOR UPDATE', [row.wallet_id]);
      const { rows: ops } = await tx.query<{ status: string; error_code: string | null }>(
        'SELECT status, error_code FROM base_chain_ops WHERE idempotency_key = $1',
        [moveRow.op_key],
      );
      const op = ops[0];
      if (
        !op ||
        op.status !== 'failed' ||
        !(NEVER_BROADCAST as readonly string[]).includes(op.error_code ?? '')
      )
        return false;
      const { rows: held } = await tx.query(
        `SELECT 1 FROM base_wallet_reservations
         WHERE holder_kind = 'float' AND holder_ref = $1 AND state = 'held'`,
        [moveRow.op_key],
      );
      if (held[0]) return false;
      const { rows } = await tx.query<{ call_id: string }>(
        `UPDATE feed_pay_calls SET state = 'reserved', topup_move_id = NULL, topup_attempts = $3,
           topup_retry_at = $4, updated_at = GREATEST($5, updated_at + 1)
         WHERE call_id = $1 AND state = 'float_topup' AND topup_move_id = $2
           AND topup_attempts = $6 AND updated_at = $7
         RETURNING call_id`,
        [row.call_id, moveRow.move_id, done + 1, at + waitMs, at, done, row.updated_at],
      );
      if (!rows[0]) return false;
      await tx.query(
        `UPDATE feed_pay_float_moves SET state = 'failed', updated_at = $2
         WHERE move_id = $1 AND state = 'pending'`,
        [moveRow.move_id, at],
      );
      return true;
    });
    if (!planned) return false;
    log(
      JSON.stringify({
        event: 'feed_pay.topup_retry_planned',
        callId: row.call_id,
        attempt: done + 1,
        waitMs,
      }),
    );
    return true;
  }

  /** With the float ready: the x402 authorization, or the fee-included router payment. */
  const proceed = (row: CallRow, ctx: WorkContext) =>
    row.pay_kind === 'included' ? startPay(row, ctx) : authorize(row, ctx);

  /** Re-checks, then signs and stores the authorization (state authorized). */
  async function authorize(row: CallRow, ctx: WorkContext): Promise<boolean> {
    const refusal = await authority(row, ctx);
    if (refusal) return refused(row, refusal);
    // Screened again right before signing (the same binding reuses its unexpired decision).
    const screened = await screenSeller(row);
    if (screened) return refused(row, screened);
    const port = await chain().catch(() => null);
    if (!port) return false;
    // Right before signing: a call above 0.10 USDC needs its router 2 ready now, else unsigned.
    if (await router2Held(row, port)) return refused(row, 'interrupted');
    const nowS = Math.floor(now() / 1000);
    let head: bigint;
    try {
      head = await port.headBlock();
    } catch {
      return false;
    }
    let issued;
    try {
      issued = await port.issue({
        paymentId: row.payment_id,
        wallet: walletRef(row),
        to: getAddress(row.pay_to) as Address,
        value: BigInt(row.amount_raw),
        validAfter: BigInt(nowS - FEED_PAY_LIMITS.authValidAfterSkewS),
        validBefore: BigInt(nowS + row.validity_s),
      });
    } catch (error) {
      if (error instanceof FeedPayChainError && error.code === 'NOT_DEPLOYED') return false;
      throw error;
    }
    const validBefore = Number(issued.authorization.validBefore);
    const at = now();
    const ok = await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ call_id: string }>(
        `UPDATE feed_pay_calls SET state = 'authorized', payment_state = 'signed', valid_before = $2,
           nonce = $3, search_from_block = $4, updated_at = $5
         WHERE call_id = $1 AND state = $6 AND updated_at = $7 RETURNING call_id`,
        [
          row.call_id,
          validBefore,
          issued.authorization.nonce.toLowerCase(),
          (head > 5n ? head - 5n : 0n).toString(10),
          at,
          row.state,
          row.updated_at,
        ],
      );
      if (!rows[0]) return false;
      await tx.query(
        `UPDATE base_payments SET state = 'authorized', authorization_nonce = $2, valid_after = $3,
           valid_before = $4, authorization_ref = $1, version = version + 1, updated_at = $5
         WHERE payment_id = $1 AND state = 'created'`,
        [
          row.payment_id,
          issued.authorization.nonce.toLowerCase(),
          Number(issued.authorization.validAfter),
          validBefore,
          at,
        ],
      );
      await audit(tx, {
        at,
        actor: row.actor,
        operatorId: row.operator_id,
        agentId: row.agent_id,
        kind: 'feed_pay_call_authorized',
        detail: {
          callId: row.call_id,
          paymentId: row.payment_id,
          payTo: row.pay_to,
          amount: row.amount_raw,
          validBefore,
          permissionId: row.permission_id,
        },
      });
      return true;
    });
    return ok;
  }

  /** What a call keeps once nothing is sent any more: no typed body, no typed query. */
  const scrubbed = (row: CallRow): Record<string, unknown> => {
    const resource = row.requirements.resource;
    return {
      request_body: null,
      request_url: withoutQuery(row.request_url),
      ...(resource && typeof resource.url === 'string'
        ? {
            requirements: JSON.stringify({
              ...row.requirements,
              resource: { ...resource, url: withoutQuery(resource.url) },
            }),
          }
        : {}),
    };
  };

  /**
   * An authorized call that will never be sent (its window is about to close, or the authority
   * behind it is gone): to Base unsent, which ends it cancelled or expired. Nothing is paid.
   */
  const unsent = (row: CallRow, failure: FeedPayFailureCode) =>
    move(row, { state: 'reconciling', failure_code: failure, ...scrubbed(row) }, 'reconciling');

  /** Sends the paid request ONCE and records what came back. */
  async function stepCall(row: CallRow, ctx: WorkContext): Promise<boolean> {
    const port = await chain().catch(() => null);
    if (!port) return false;
    const issued = await port.stored(row.payment_id);
    if (!issued) return false;
    // A late worker (a same-key retry, or one that waited on Base or the database) never sends an
    // authorization that has run out or is about to, nor one whose authority is gone since signing.
    const left = Number(issued.authorization.validBefore) - Math.floor(now() / 1000);
    if (left < Math.max(FEED_PAY_LIMITS.authValidityMinS, FEED_PAY_CANCEL_MARGIN_S))
      return unsent(row, 'interrupted');
    // The messages of the authority codes say "before it was signed": this one was signed.
    if (await authority(row, ctx)) return unsent(row, 'interrupted');
    // Signed but not sent: a call above 0.10 USDC whose router 2 is not ready now is never sent.
    if (await router2Held(row, port)) return unsent(row, 'interrupted');
    // Durable mark before the call: from here on nothing sends this request again.
    if (!(await move(row, { state: 'calling', payment_state: 'sent' }, 'settling'))) return false;
    const a = issued.authorization;
    const header = paymentHeader({
      x402Version: row.x402_version === 1 ? 1 : 2,
      option: row.requirements.accepted,
      resource: row.requirements.resource,
      extensions: row.requirements.extensions ?? null,
      payload: {
        signature: issued.signature,
        authorization: {
          from: getAddress(a.from) as Address,
          to: getAddress(a.to) as Address,
          value: a.value.toString(10),
          validAfter: a.validAfter.toString(10),
          validBefore: a.validBefore.toString(10),
          nonce: a.nonce,
        },
      },
    });
    let answer: Awaited<ReturnType<FeedPayHttp>> | null = null;
    let failure: FeedPayHttpError | null = null;
    try {
      answer = await http({
        url: row.request_url,
        method: row.method,
        headers: { ...baseHeaders(row.request_body), [header.name]: header.value },
        body: row.request_body,
        timeoutMs: CALL_TIMEOUT_MS,
        maxBytes: RESULT_MAX_BYTES,
      });
    } catch (error) {
      failure =
        error instanceof FeedPayHttpError ? error : new FeedPayHttpError('unreachable', true);
    }
    const current = await loadCall(db, row.call_id);
    if (!current || current.state !== 'calling') return false;
    if (!answer) {
      const timeout = failure!.kind === 'timeout';
      // Never delivered: nobody has the authorization; it is cancelled or runs out.
      const state = !failure!.delivered && !timeout ? 'not_settled' : 'reconciling';
      await move(
        current,
        {
          state,
          failure_code: timeout ? 'service_timeout' : 'service_unreachable',
          ...scrubbed(current),
        },
        state === 'reconciling' ? 'reconciling' : undefined,
      );
      return true;
    }
    const claim = readSettlementClaim(answer.headers);
    const result = resultOf(answer, now());
    const ok = answer.status >= 200 && answer.status < 300;
    const patch: Record<string, unknown> = {
      state: ok ? 'result_saved' : 'not_settled',
      ...scrubbed(current),
      response_status: answer.status,
      claimed_tx: claim?.transaction ?? null,
      result_status: result.status,
      result_content_type: result.contentType,
      result_format: result.format,
      result_text: result.text,
      result_bytes: result.bytes,
      result_truncated: result.truncated,
      result_received_at: result.receivedAt,
      result_expires_at: result.receivedAt + RESULT_KEEP_DAYS * 86_400_000,
      ...(ok ? {} : { failure_code: answer.status === 402 ? 'payment_rejected' : 'service_error' }),
    };
    await move(current, patch);
    if (!ok && answer.status === 402)
      alert({
        kind: 'payment_rejected',
        callId: row.call_id,
        serviceId: row.service_id,
        host: row.host,
        walletId: row.wallet_id,
        amountRaw: row.amount_raw,
        detail: claim?.errorReason ?? `status_${answer.status}`,
      });
    return true;
  }

  /**
   * The protocol fee of a call whose seller was paid (docs/protocol/FEES.md, "Fee on top"): one
   * operation from the spender account, [approve(router, fee), chargeFee(payTo, price, ref)], with
   * the per-call key feed-pay:fee:<callId> and ref keccak256(callId). The state moves to 'sent'
   * before anything is broadcast, so a crash afterwards is found again; a resend reuses the key
   * (one operation per key) and the router refuses a second charge for the same ref on-chain.
   */
  async function stepFee(row: CallRow): Promise<boolean> {
    const port = await chain().catch(() => null);
    if (!port) return false;
    const key = row.fee_op_key ?? `feed-pay:fee:${row.call_id}`;
    if (row.fee_state === 'pending') {
      // The route pinned at reservation. An owed fee is completed through it even when protocol
      // fees or Feed pay were switched off after the seller was paid: it is the price the owner
      // confirmed (price + fee), paid from the float already held for this call, not a new spend.
      if (!row.fee_router) return feeFailed(row, 'no_fee_route', null);
      const router = getAddress(row.fee_router) as Hex;
      // The pinned router's own cap; a router that is neither ours nor the configured router 2 is
      // never paid (docs/protocol/FEE_ROUTER_2.md section 4).
      const cap = pinnedMaxTotal(row.fee_router);
      if (cap === null) return feeFailed(row, 'no_fee_route', null);
      let quote;
      try {
        quote = quoteFeeOnTop(BigInt(row.amount_raw), cap);
      } catch {
        quote = null;
      }
      if (!quote || quote.fee !== BigInt(row.fee_raw)) return feeFailed(row, 'fee_mismatch', null);
      // Payment screening (CITY_PROTOCOL_SCREENING) before the fee's first submission: a held fee
      // stays pending with its one key and is screened again later; it is never charged meanwhile.
      if (await feeHeld(row, port)) return false;
      if (
        !(await move(row, {
          fee_state: 'sent',
          fee_op_key: key,
          ...(row.fee_held_at !== null ? { fee_held_at: null } : {}),
        }))
      )
        return false;
      const calls = feeCalls({
        usdc: USDC as Hex,
        router,
        payee: getAddress(row.pay_to) as Hex,
        quote,
        paymentIntentId: row.call_id,
        maxTotal: cap,
      });
      await port
        .chargeFee({
          key,
          intentHash: opIntentHash({
            callId: row.call_id,
            router: router.toLowerCase(),
            fee: row.fee_raw,
            ref: feeRef(row.call_id),
          }),
          wallet: walletRef(row),
          calls,
          beforeBroadcast: async () => {},
        })
        .catch(() => null);
      return true;
    }
    // 'sent': Base decides the operation.
    const op = await opOf(port, key, row.wallet_id).catch(() => undefined);
    if (op === undefined) return false;
    if (op === null) {
      // Moved to 'sent' but the operation was never stored (a crash between): past the grace it is
      // planned again with the same key.
      if (Number(row.updated_at) < now() - FEED_PAY_RECOVER_GRACE_MS)
        return move(row, { fee_state: 'pending' });
      return false;
    }
    if (op.status === 'final' && !op.errorCode)
      return move(row, {
        fee_state: 'charged',
        fee_tx_hash: op.txHash ? op.txHash.toLowerCase() : null,
        fee_block: op.blockNumber === null ? null : op.blockNumber.toString(10),
      });
    if (op.status === 'final' || op.status === 'failed' || op.neverSent)
      return feeFailed(row, op.errorCode ?? 'failed', op.txHash);
    return false;
  }

  async function feeFailed(row: CallRow, detail: string, txHash: Hex | null): Promise<boolean> {
    const ok = await move(row, {
      fee_state: 'failed',
      ...(txHash ? { fee_tx_hash: txHash.toLowerCase() } : {}),
    });
    if (ok)
      alert({
        kind: 'protocol_fee_failed',
        callId: row.call_id,
        serviceId: row.service_id,
        host: row.host,
        walletId: row.wallet_id,
        amountRaw: row.fee_raw,
        detail,
      });
    return ok;
  }

  /**
   * Once the fee is charged and the ledger scan has its row, the call's price counts as volume:
   * the seller's settlement is proven by Base (the payment's authorization was used), so the fee
   * row is marked service-verified, matching every field. Until the scan has the row, it waits.
   * A fee-included payment (kind 1) is service-verified by itself in the ledger (the router moved
   * the price to the seller in the same call); this only confirms the ledger has that very row.
   */
  async function verifyFee(row: CallRow): Promise<boolean> {
    if (!row.fee_router || row.payment_state !== 'settled') return false;
    const included = row.pay_kind === 'included';
    const marked = await markServiceVerified(db, {
      chainId: CHAIN_ID,
      emitter: getAddress(row.fee_router) as Hex,
      payer: getAddress(row.spender_address) as Hex,
      payee: getAddress(row.pay_to) as Hex,
      ref: feeRef(row.call_id),
      kind: included ? KIND_INTERNAL : KIND_EXTERNAL,
      gross: BigInt(paidAmountRaw(row)),
      fee: BigInt(row.fee_raw),
    }).catch(() => false);
    if (!marked) return false;
    return move(row, { fee_verified: true });
  }

  // -------------------------------------------------------------------------------------------
  // Fee included: a service sold by a Central City agent (pay_kind 'included')
  //
  //   reserved / float_topup  as every call: limits held, the float topped up when short
  //   calling      ONE operation from the spender: [approve(router, price), router.pay(payTo,
  //                price, keccak256(callId))]; payment_state and fee_state 'sent'
  //   settled      the operation is in a block with the matching FeeCharged (kind 1): the seller
  //                has 90%, the treasury 10%; money moved. Delivery next: at once while the
  //                not-yet-final exposure stays under its caps, else once the payment is final
  //   result_saved the kind ran in-process with the checked input; its answer is the result
  //   paid_no_result the kind failed (the fee stays charged), or the FeeCharged did not match
  //   refused / cancelled  the operation never went out, or it failed or reverted: nothing paid
  // Finality is recorded afterwards (pay_final_at) only from chain proof: the operation's block at
  // or below the finalized head with its canonical block hash (refreshFinality). A reorg re-reads
  // the inclusion; the router's (payer, ref) commitment means the price is never paid twice.

  // A payment planned again (planPayAgain) is a new operation under a new key; its router ref stays
  // keccak256(callId), so of all of a call's payment operations the router charges at most one.
  const payKeyOf = (row: CallRow) => row.fee_op_key ?? feedPayKey(row.call_id, row.pay_attempts);
  const payIntentOf = (row: CallRow) =>
    opIntentHash({
      callId: row.call_id,
      router: (row.fee_router ?? '').toLowerCase(),
      payee: row.pay_to.toLowerCase(),
      gross: paidAmountRaw(row),
      ref: feeRef(row.call_id),
      // Attempt 0 hashes exactly as before (calls in flight while this ships keep their intent).
      ...(row.pay_attempts > 0 ? { attempt: row.pay_attempts } : {}),
    });

  /** The price split of a stored fee-included call, checked again against the router's rules. */
  function splitOf(row: CallRow): IncludedQuote | null {
    const cap = row.fee_router ? pinnedMaxTotal(row.fee_router) : null;
    if (cap === null) return null;
    try {
      const split = quoteFeeIncluded(BigInt(paidAmountRaw(row)), cap);
      return split.fee === BigInt(row.fee_raw) && split.net === BigInt(row.amount_raw)
        ? split
        : null;
    } catch {
      return null;
    }
  }

  /**
   * With the float ready: the checks once more (authority, screening of the seller leg, the
   * router's binding to the protocol treasury, screening of that treasury), then the state moves
   * to 'calling' (durable, before anything is sent) and the one payment operation goes out.
   */
  async function startPay(row: CallRow, ctx: WorkContext): Promise<boolean> {
    const refusal = await authority(row, ctx);
    if (refusal) return refused(row, refusal);
    const screened = await screenSeller(row);
    if (screened) return refused(row, screened);
    const port = await chain().catch(() => null);
    if (!port) return false;
    if (!row.fee_router || !splitOf(row)) return refused(row, 'interrupted');
    // The router pays its own treasury: it must be the protocol's (read from the router itself).
    const recipient = await feeRecipientOf(port, row.fee_router);
    if ('hold' in recipient) {
      if (recipient.hold === 'fee_recipient_unknown') return false;
      return refused(row, 'interrupted');
    }
    // A call pinned to router 2: nothing is signed until router 2 is verified on chain (fail closed;
    // looked at again later, never sent through router 1).
    if (pinnedMaxTotal(row.fee_router) === MAX_TOTAL_ROUTER2 && !(await bigRouterReady(port, row)))
      return false;
    // Router 3 (any amount): nothing is signed until router 3 and its facilitator are ready.
    if (onRouter3(row) && !(await router3Ready(port, row.fee_router))) return false;
    // The treasury's share moves in this same operation: screened here, on every attempt that could
    // still send it, before the state moves and before anything is signed.
    const treasuryScreened = await screenTreasury(row, recipient.treasury);
    if (treasuryScreened) return refused(row, treasuryScreened);
    const key = payKeyOf(row);
    if (
      !(await move(
        row,
        {
          state: 'calling',
          payment_state: 'sent',
          fee_state: 'sent',
          fee_op_key: key,
          pay_retry_at: null,
          pay_first_at: row.pay_first_at ?? now(),
        },
        'settling',
      ))
    )
      return false;
    const current = await loadCall(db, row.call_id);
    if (!current) return false;
    await sendPay(current, port, ctx);
    return true;
  }

  /** Stores and sends the payment operation (one per key; a resend is the same operation). */
  async function sendPay(row: CallRow, port: FeedPayChainPort, ctx: WorkContext): Promise<void> {
    const split = splitOf(row);
    if (!split || !row.fee_router) return;
    ctx.payRateLimited = undefined;
    if (onRouter3(row)) return sendRouter3(row, port, ctx, split);
    try {
      await port.routerPay({
        key: payKeyOf(row),
        intentHash: payIntentOf(row),
        wallet: walletRef(row),
        calls: payCalls({
          usdc: USDC as Hex,
          router: getAddress(row.fee_router) as Hex,
          payee: getAddress(row.pay_to) as Hex,
          quote: split,
          paymentIntentId: row.call_id,
          // splitOf above is null for a router that is neither ours nor router 2, so the call never
          // gets here with one; 0 would make payCalls refuse, never fall back to another cap (N2).
          maxTotal: pinnedMaxTotal(row.fee_router) ?? 0n,
        }),
        // A new payment: the authority behind it is checked right before its first send.
        beforeBroadcast: async () => {
          const refusal = await authority(row, ctx);
          if (refusal) {
            ctx.refusal = refusal;
            throw new Error('refused');
          }
        },
        // The batch lane: allowlisted workspaces only (the server's own operator_id). An MCP
        // purchase is batched only with its grant's ids (checked again before the batch goes).
        ...(batchWorkspacesFromEnv(env).has(row.operator_id)
          ? {
              batch: {
                authorize: batchAuthorize,
                ...(row.origin === 'feed'
                  ? { grant: null }
                  : ctx.grant
                    ? { grant: ctx.grant }
                    : {}),
              },
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof FeedPayChainError)
        ctx.refusal ??=
          error.code === 'INSUFFICIENT_BALANCE' ? 'insufficient_funds' : 'interrupted';
      // Refused only for the provider's rate (carried as data on the error, never read from its
      // text): stepIncluded may plan a new payment once the stored op proves it never went out.
      // Any other error (configuration, sponsor policy, allowlist, funds, a refusal) never does.
      const limited = ctx.refusal ? null : providerRateLimit(error);
      if (limited) ctx.payRateLimited = { key: payKeyOf(row), retryAfterMs: limited.retryAfterMs };
      // Why a fee-included payment did not go out, for the operator: the error class, its code and
      // a short message with every hex value (addresses, hashes, call data) taken out.
      log(
        JSON.stringify({
          event: 'feed_pay.included_send_failed',
          callId: row.call_id,
          error: error instanceof Error ? error.constructor.name : 'unknown',
          code: sendFailureCode(error),
          detail: sendFailureDetail(error),
        }),
      );
      // Stored or fenced: the next step reads what Base and the store say.
    }
  }

  /**
   * The batch lane's authority check (facilitator flush, right before simulating and again right
   * before signing a batch): the op keys of members whose call is refused now. Fails closed: a key
   * with no call, or a call no longer waiting to pay, is refused.
   */
  async function batchAuthorize(keys: string[]): Promise<Set<string>> {
    const refused = new Set<string>(keys);
    if (!keys.length) return refused;
    const { rows } = await db.query<CallRow>(
      `${CALL_SELECT} WHERE c.fee_op_key = ANY($1::text[])`,
      [keys],
    );
    const { rows: grants } = await db.query<{
      op_key: string;
      grant_kind: 'grant' | 'key' | null;
      grant_id: string | null;
    }>(
      'SELECT op_key, grant_kind, grant_id FROM x402_facilitator_ops WHERE op_key = ANY($1::text[])',
      [keys],
    );
    const grantOf = new Map(grants.map((g) => [g.op_key, g]));
    for (const row of rows) {
      if (row.payment_state !== 'sent' || !row.fee_op_key) continue;
      if (!batchWorkspacesFromEnv(env).has(row.operator_id)) continue;
      const ctx: WorkContext = {};
      if (row.origin === 'mcp') {
        // The MCP grant or key, checked again from its stored ids (revoked, expired, scope);
        // without them, or without the check, the member is refused (room #222/#223).
        const g = grantOf.get(row.fee_op_key);
        const check = deps.revalidateGrant;
        if (!check || !g?.grant_kind || !g.grant_id) continue;
        const grant = { operatorId: row.caller_id, kind: g.grant_kind, id: g.grant_id };
        ctx.revalidate = () => check(grant);
      }
      const refusal = await authority(row, ctx).catch(() => 'interrupted' as const);
      if (!refusal) refused.delete(row.fee_op_key);
    }
    return refused;
  }

  /**
   * A router-3 payment (docs/protocol/FEE_ROUTER_3.md): the spender account signs the bound pair
   * (stored before use; a retry gets the same pair, never a second one) and the facilitator stores
   * and sends one settle transaction under the call's pay key. The authority is checked right
   * before its first broadcast, as for a UserOp. Errors leave what is stored: stepIncluded reads it.
   */
  async function sendRouter3(
    row: CallRow,
    port: FeedPayChainPort,
    ctx: WorkContext,
    split: IncludedQuote,
  ): Promise<void> {
    try {
      const f = await facilitator();
      if (!f) throw new Error('no_facilitator');
      const recipient = await feeRecipientOf(port, row.fee_router);
      if ('hold' in recipient) throw new Error(recipient.hold);
      const key = payKeyOf(row);
      const legs = await port.router3Legs({
        key,
        wallet: walletRef(row),
        router: getAddress(row.fee_router!) as Address,
        treasury: getAddress(recipient.treasury) as Address,
        payee: getAddress(row.pay_to) as Address,
        gross: split.gross,
        fee: split.fee,
        ref: feeRef(row.call_id),
        validitySeconds: ROUTER3_VALIDITY_S,
      });
      await f.submit({
        key,
        intentHash: payIntentOf(row),
        settlement: {
          payer: getAddress(row.spender_address) as Hex,
          payee: getAddress(row.pay_to) as Hex,
          gross: split.gross,
          ref: feeRef(row.call_id),
          validAfter: legs.seller.authorization.validAfter,
          validBefore: legs.seller.authorization.validBefore,
          sellerSignature: legs.seller.signature,
          feeSignature: legs.fee.signature,
        },
        beforeBroadcast: async () => {
          const refusal = await authority(row, ctx);
          if (refusal) {
            ctx.refusal = refusal;
            throw new Error('refused');
          }
        },
      });
    } catch (error) {
      if (error instanceof FeedPayChainError)
        ctx.refusal ??=
          error.code === 'INSUFFICIENT_BALANCE' ? 'insufficient_funds' : 'interrupted';
      log(
        JSON.stringify({
          event: 'feed_pay.router3_send_failed',
          callId: row.call_id,
          error: error instanceof Error ? error.constructor.name : 'unknown',
          code: sendFailureCode(error),
          detail: sendFailureDetail(error),
        }),
      );
    }
  }

  /**
   * The facilitator's operation of a router-3 call, in the shape of a chain operation: what
   * stepIncluded reads for a UserOp. undefined: not readable now.
   */
  async function router3OpOf(key: string): Promise<FeedPayOp | null | undefined> {
    const f = await facilitator();
    if (!f) return undefined;
    return f.status(key, { authorize: batchAuthorize }).catch(() => undefined);
  }

  /**
   * A router-3 settlement that did not go through (never sent, or reverted). Its two signed
   * authorizations stay valid until validBefore, so the call is declared unpaid only when Base
   * shows both nonces unused at a safe block past the window (or cancelled); a leg used anyway
   * (outside the router) is money that moved: recorded as an anomaly, never paid again under new
   * nonces and never sent through router 1 or 2 (security review, room x402 #20). Pending: wait.
   */
  async function router3NotMade(
    row: CallRow,
    port: FeedPayChainPort,
    op: FeedPayOp,
    ctx: WorkContext,
  ): Promise<boolean> {
    const key = payKeyOf(row);
    const [seller, fee] = await Promise.all([
      port.stored(`${key}:seller`).catch(() => undefined),
      port.stored(`${key}:fee`).catch(() => undefined),
    ]);
    if (seller === undefined || fee === undefined) return false;
    // Nothing was ever signed: nothing can move, exactly like a UserOp that never went out.
    if (!seller && !fee)
      return payNotMade(
        row,
        op.neverSent ? (ctx.refusal ?? 'interrupted') : 'payment_rejected',
        op.neverSent ? null : { txHash: op.txHash },
      );
    const fromBlock = (await port.headBlock().catch(() => null)) ?? null;
    if (fromBlock === null) return false;
    const outcomes = await Promise.all(
      [seller, fee]
        .filter((leg): leg is NonNullable<typeof leg> => !!leg)
        .map((leg) =>
          port.outcome({
            payer: leg.authorization.from,
            nonce: leg.authorization.nonce,
            fromBlock:
              fromBlock > AUTHORIZATION_SEARCH_BLOCKS
                ? fromBlock - AUTHORIZATION_SEARCH_BLOCKS
                : 0n,
            validBefore: Number(leg.authorization.validBefore),
            claimedTx: op.txHash,
          }),
        ),
    );
    if (outcomes.some((o) => o.kind === 'used'))
      return payAnomaly(row, { txHash: op.txHash, blockNumber: op.blockNumber }, false);
    if (outcomes.every((o) => o.kind === 'expired' || o.kind === 'canceled'))
      return payNotMade(
        row,
        op.neverSent ? (ctx.refusal ?? 'interrupted') : 'payment_rejected',
        op.neverSent ? null : { txHash: op.txHash },
      );
    return false;
  }

  /**
   * The agreed success evidence of a router-3 sale (room x402 #29/#52), on top of payMatches'
   * FeeCharged: in the same receipt, exactly one USDC Transfer payer -> payee of gross - fee and
   * exactly one payer -> the router's treasury of fee. The immutable router implies both; checking
   * them keeps the approved evidence contract and the ledger reconciliation exact.
   */
  async function router3TransfersMatch(
    row: CallRow,
    port: FeedPayChainPort,
    logs: { address: Hex; topics: Hex[]; data: Hex }[],
  ): Promise<'match' | 'mismatch' | 'unknown'> {
    const split = splitOf(row);
    if (!split) return 'mismatch';
    const recipient = await feeRecipientOf(port, row.fee_router);
    if ('hold' in recipient)
      return recipient.hold === 'fee_recipient_unknown' ? 'unknown' : 'mismatch';
    const payer = getAddress(row.spender_address);
    if (!row.fee_router) return 'mismatch';
    // Only this payment's own legs (a settleBatch receipt carries many payments, #214/#221).
    const transfers = router3OwnTransfers(logs, {
      chainId: CHAIN_ID,
      router: getAddress(row.fee_router) as Hex,
      usdc: getAddress(USDC) as Hex,
      payer: payer as Hex,
      ref: feeRef(row.call_id),
    });
    if (!transfers) return 'mismatch';
    const count = (to: string, value: bigint) =>
      transfers.filter(
        (t) =>
          getAddress(t.from) === payer && getAddress(t.to) === getAddress(to) && t.value === value,
      ).length;
    return count(row.pay_to, split.net) === 1 && count(recipient.treasury, split.fee) === 1
      ? 'match'
      : 'mismatch';
  }

  /** The operation provably never went out (or reverted): nothing moved, the call ends. */
  async function payNotMade(
    row: CallRow,
    failure: FeedPayFailureCode,
    sent: { txHash: Hex | null } | null,
  ): Promise<boolean> {
    const state: FeedPayCallState = sent ? 'cancelled' : 'refused';
    const ok = await move(
      row,
      {
        state,
        failure_code: failure,
        payment_state: sent ? 'cancelled' : null,
        fee_state: 'not_owed',
        ...(sent?.txHash ? { fee_tx_hash: sent.txHash.toLowerCase() } : {}),
        ...scrubbed(row),
      },
      'failed',
      { state, failure },
    );
    if (ok && sent)
      alert({
        kind: 'protocol_fee_failed',
        callId: row.call_id,
        serviceId: row.service_id,
        host: row.host,
        walletId: row.wallet_id,
        amountRaw: paidAmountRaw(row),
        detail: 'included_payment_failed',
      });
    return ok;
  }

  /** No rate-limited payment is planned again: fixed labels only. */
  const payRetryExhausted = (
    row: CallRow,
    attempts: number,
    reason: 'attempts' | 'window' | 'retry_after' | 'budget',
  ) =>
    log(
      JSON.stringify({
        event: 'feed_pay.pay_retry_exhausted',
        callId: row.call_id,
        attempts,
        reason,
      }),
    );

  /** When the call's first payment was planned (ms); now when none was recorded. */
  const firstPayAt = (row: CallRow) => num(row.pay_first_at) ?? now();

  /**
   * A new payment for a fee-included call whose router payment the provider refused only for its
   * rate (FEED_PAY_PAY_RETRY). In one transaction, against the call as read: the old operation is
   * proven terminal and never broadcast (failed with a NEVER_BROADCAST code: a tombstone, or a row
   * refused or expired while still queued; such a row is never sent again), and the call goes back
   * to 'reserved' as it was before its payment (no payment state, its fee pending, no operation
   * key, its base payment 'created') with pay_attempts one higher and nothing planned before
   * pay_retry_at. From there it takes the normal path again (stepReserved: authority, screening,
   * the float with its holds, a top-up under the limit and the reservation ledger when the float
   * is short; then startPay: authority, both screenings, the router's binding) and pays under the
   * key of its new attempt. The float stays held for the call meanwhile ('reserved' counts in
   * floatHeld exactly as 'calling' did). 'exhausted': attempts or time (the window, the provider's
   * Retry-After, or this worker's budget) are used up, and the call ends as before; false: not now
   * (the call moved meanwhile, or its operation is not proven never sent).
   */
  async function planPayAgain(
    row: CallRow,
    key: string,
    ctx: WorkContext,
    retryAfterMs: number | null,
  ): Promise<boolean | 'exhausted'> {
    const done = row.pay_attempts;
    if (done >= FEED_PAY_PAY_RETRY.attempts) {
      payRetryExhausted(row, done, 'attempts');
      return 'exhausted';
    }
    const waitMs = topUpRetryWaitMs(done + 1, retryAfterMs);
    if (waitMs === null) {
      payRetryExhausted(row, done, 'retry_after');
      return 'exhausted';
    }
    const at = now();
    if (at + waitMs > firstPayAt(row) + FEED_PAY_PAY_RETRY.windowMs) {
      payRetryExhausted(row, done, 'window');
      return 'exhausted';
    }
    // Due after this worker stops (with a margin for its last polls): nothing would take it up in
    // time, and the cron would only end the call 'interrupted' later. It ends now instead.
    if (at + waitMs + FEED_PAY_PAY_RETRY.budgetMarginMs > (ctx.deadline ?? at)) {
      payRetryExhausted(row, done, 'budget');
      return 'exhausted';
    }
    const planned = await db.transaction(async (tx) => {
      const { rows: ops } = await tx.query<{ status: string; error_code: string | null }>(
        'SELECT status, error_code FROM base_chain_ops WHERE idempotency_key = $1',
        [key],
      );
      const op = ops[0];
      if (
        !op ||
        op.status !== 'failed' ||
        !(NEVER_BROADCAST as readonly string[]).includes(op.error_code ?? '')
      )
        return false;
      const { rows } = await tx.query<{ call_id: string }>(
        `UPDATE feed_pay_calls SET state = 'reserved', payment_state = NULL, fee_state = 'pending',
           fee_op_key = NULL, pay_attempts = $3, pay_retry_at = $4,
           updated_at = GREATEST($5, updated_at + 1)
         WHERE call_id = $1 AND state = 'calling' AND payment_state = 'sent' AND fee_state = 'sent'
           AND fee_op_key = $2 AND pay_kind = 'included' AND pay_attempts = $6 AND updated_at = $7
         RETURNING call_id`,
        [row.call_id, key, done + 1, at + waitMs, at, done, row.updated_at],
      );
      if (!rows[0]) return false;
      await tx.query(
        `UPDATE base_payments SET state = 'created', version = version + 1, updated_at = $2
         WHERE payment_id = $1 AND state = 'settling'`,
        [row.payment_id, at],
      );
      return true;
    });
    if (!planned) return false;
    log(
      JSON.stringify({
        event: 'feed_pay.pay_retry_planned',
        callId: row.call_id,
        attempt: done + 1,
        waitMs,
      }),
    );
    return true;
  }

  /**
   * The FeeCharged of exactly this payment (router, spender, payee, kind 1, price, fee, ref), found
   * among the events of every operation the transaction carries.
   */
  function payMatches(row: CallRow, logs: { address: Hex; topics: Hex[]; data: Hex }[]) {
    const split = splitOf(row);
    if (!split || !row.fee_router) return false;
    const expected = {
      chainId: CHAIN_ID,
      router: getAddress(row.fee_router) as Hex,
      payer: getAddress(row.spender_address) as Hex,
      payee: getAddress(row.pay_to) as Hex,
      quote: { gross: split.gross, fee: split.fee },
      paymentIntentId: row.call_id,
      kind: KIND_INTERNAL,
    } as const;
    // One bundle transaction can carry the operations of several payers (and other router users),
    // so only this payment's own event counts: the router charges each (payer, ref) once, which
    // makes it unique. Exactly one, and it must match the call in every field.
    const ref = feeRef(row.call_id).toLowerCase();
    const own = feeEventsOf(CHAIN_ID, expected.router, logs).filter(
      (event) => getAddress(event.payer) === expected.payer && event.ref.toLowerCase() === ref,
    );
    return own.length === 1 && feeMatches(own[0]!, expected);
  }

  /**
   * A payment in a block whose FeeCharged does not match the call: money moved, but not as this
   * call says. Nothing is delivered; ops are alerted once. Followed until final like any payment.
   */
  async function payAnomaly(
    row: CallRow,
    op: { txHash: Hex | null; blockNumber: bigint | null },
    final: boolean,
  ): Promise<boolean> {
    const ok = await move(
      row,
      {
        state: 'paid_no_result',
        failure_code: 'payment_unverified',
        payment_state: 'settled',
        tx_hash: op.txHash?.toLowerCase() ?? null,
        settled_block: op.blockNumber?.toString(10) ?? null,
        settled_at: now(),
        fee_state: 'failed',
        fee_tx_hash: op.txHash?.toLowerCase() ?? null,
        fee_block: op.blockNumber?.toString(10) ?? null,
        ...(final ? { pay_final_at: now() } : {}),
        ...scrubbed(row),
      },
      'paid',
      { state: 'paid_no_result', failure: 'payment_unverified' },
    );
    if (ok)
      alert({
        kind: 'payment_anomaly',
        callId: row.call_id,
        serviceId: row.service_id,
        host: row.host,
        walletId: row.wallet_id,
        amountRaw: paidAmountRaw(row),
        detail: 'fee_charged_mismatch',
      });
    return ok;
  }

  /**
   * A payment recorded as settled that Base later shows failed (a reorg, then the operation could
   * not land again): the money did not move after all. The call keeps what it delivered; ops are
   * alerted. This is the bounded not-yet-final exposure of owner decision 2.
   */
  async function payDropped(row: CallRow): Promise<boolean> {
    const delivered = row.state !== 'settled';
    const ok = await move(
      row,
      {
        payment_state: 'cancelled',
        fee_state: 'not_owed',
        ...(delivered ? {} : { state: 'cancelled', failure_code: 'payment_rejected' }),
        ...scrubbed(row),
      },
      'failed',
      delivered ? undefined : { state: 'cancelled', failure: 'payment_rejected' },
    );
    if (ok)
      alert({
        kind: 'payment_anomaly',
        callId: row.call_id,
        serviceId: row.service_id,
        host: row.host,
        walletId: row.wallet_id,
        amountRaw: paidAmountRaw(row),
        detail: delivered ? 'dropped_after_delivery' : 'dropped_before_delivery',
      });
    return ok;
  }

  /**
   * Commits the delivery of a paid call (delivered_at). Before its payment is final, only while the
   * not-yet-final delivered amount stays within the caps for its seller wallet and in all; the
   * check and the commit run under one lock, so concurrent deliveries are counted one after the
   * other. False: over a cap (it waits for finality) or the call moved meanwhile.
   */
  async function commitDelivery(row: CallRow, final: boolean): Promise<boolean> {
    const caps = feedPayUnfinalCaps(env);
    const price = BigInt(paidAmountRaw(row));
    return db.transaction(async (tx) => {
      if (!final) {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('feed_pay_unfinal'))");
        const { rows } = await tx.query<{ seller: string; total: string }>(
          `SELECT COALESCE(SUM(amount_raw + fee_raw) FILTER (WHERE lower(pay_to) = $1), 0)::text
               AS seller,
             COALESCE(SUM(amount_raw + fee_raw), 0)::text AS total
           FROM feed_pay_calls
           WHERE pay_kind = 'included' AND delivered_at IS NOT NULL AND pay_final_at IS NULL
             AND payment_state = 'settled' AND call_id <> $2`,
          [row.pay_to.toLowerCase(), row.call_id],
        );
        const seller = BigInt(rows[0]?.seller ?? '0');
        const total = BigInt(rows[0]?.total ?? '0');
        if (seller + price > caps.perSeller || total + price > caps.total) return false;
      }
      const { rows: moved } = await tx.query<{ call_id: string }>(
        `UPDATE feed_pay_calls SET delivered_at = $2, updated_at = GREATEST($2, updated_at + 1)
         WHERE call_id = $1 AND state = 'settled' AND delivered_at IS NULL AND updated_at = $3
         RETURNING call_id`,
        [row.call_id, now(), row.updated_at],
      );
      return moved.length > 0;
    });
  }

  /**
   * Runs the offer's kind with the checked input: at most OFFER_RUN_TIMEOUT_MS and 64 KiB. The
   * buyer has paid by now, so every failure is the call's outcome (paid_no_result, the fee stays
   * charged): OfferKindFailure, OfferKindInputError and the abort alike. A failure's outboundSent
   * only labels it (a request reached a third party: service_error; none did: service_unreachable).
   * A limiter's refusal (busy, nothing sent) is run again first: OFFER_RUN_ATTEMPTS runs in all,
   * OFFER_RUN_RETRY_MS apart, each with its own timeout.
   */
  async function runOffer(
    row: CallRow,
  ): Promise<
    | { ok: true; text: string; mime: string; format: 'json' | 'text' }
    | { ok: false; failure: FeedPayFailureCode }
  > {
    for (let attempt = 1; ; attempt++) {
      const outcome = await runOfferOnce(row);
      if (outcome.ok) return outcome;
      if (!outcome.busy || attempt >= OFFER_RUN_ATTEMPTS)
        return { ok: false, failure: outcome.failure };
      await sleep(OFFER_RUN_RETRY_MS);
    }
  }

  async function runOfferOnce(
    row: CallRow,
  ): Promise<
    | { ok: true; text: string; mime: string; format: 'json' | 'text' }
    | { ok: false; failure: FeedPayFailureCode; busy?: true }
  > {
    const included = row.requirements.included;
    const kind = included && isOfferKind(included.kind) ? offerKind(included.kind, kinds) : null;
    if (!kind || row.request_body === null) return { ok: false, failure: 'service_error' };
    let input: unknown;
    try {
      input = JSON.parse(row.request_body);
    } catch {
      return { ok: false, failure: 'service_error' };
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, OFFER_RUN_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      const answer = await Promise.race([
        kind.run(input, { signal: controller.signal, now: now() }),
        timeout,
      ]);
      if (answer === 'timeout') return { ok: false, failure: 'service_timeout' };
      const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
      // A NUL (U+0000) can't be stored as Postgres text: no result, never an update that fails.
      if (
        typeof text !== 'string' ||
        text.includes('\u0000') ||
        Buffer.byteLength(text, 'utf8') > OFFER_OUTPUT_MAX_BYTES
      )
        return { ok: false, failure: 'no_result' };
      const json = /^application\/([a-z.+-]*\+)?json\b/i.test(answer.mime);
      return {
        ok: true,
        text,
        mime: answer.mime.replace(/[^\x20-\x7e]/g, '').slice(0, 200),
        format: json ? 'json' : 'text',
      };
    } catch (err) {
      if (controller.signal.aborted) return { ok: false, failure: 'service_timeout' };
      if (
        err instanceof OfferKindFailure &&
        err.retryable &&
        !err.outboundSent &&
        (err.status === 429 || err.status === 503)
      )
        return { ok: false, failure: 'service_unreachable', busy: true };
      if (err instanceof OfferKindFailure)
        return { ok: false, failure: err.outboundSent ? 'service_error' : 'service_unreachable' };
      return { ok: false, failure: 'service_error' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * A result the database refuses for good, whatever the attempt: text it cannot hold (22021, a
   * NUL or bytes that are not UTF-8; 22P05, a character with no equivalent in its encoding).
   */
  const resultRefused = (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    return code === '22021' || code === '22P05';
  };

  /** Delivers a committed call: the kind's answer stored as its result, once (compare-and-set). */
  async function deliver(row: CallRow): Promise<boolean> {
    const outcome = await runOffer(row);
    const current = await loadCall(db, row.call_id);
    if (!current || current.state !== 'settled' || current.delivered_at === null) return false;
    /** Paid, and no result can be stored: the call ends paid_no_result and ops are alerted. */
    const noResult = async (failure: FeedPayFailureCode) => {
      const ok = await move(
        current,
        { state: 'paid_no_result', failure_code: failure, ...scrubbed(current) },
        undefined,
        { state: 'paid_no_result', failure },
      );
      if (ok)
        alert({
          kind: 'paid_no_result',
          callId: row.call_id,
          serviceId: row.service_id,
          host: row.host,
          walletId: row.wallet_id,
          amountRaw: paidAmountRaw(row),
        });
      return ok;
    };
    if (!outcome.ok) return noResult(outcome.failure);
    const at = now();
    try {
      return await move(
        current,
        {
          state: 'result_saved',
          ...scrubbed(current),
          response_status: 200,
          result_status: 200,
          result_content_type: outcome.mime,
          result_format: outcome.format,
          result_text: outcome.text,
          result_bytes: Buffer.byteLength(outcome.text, 'utf8'),
          result_truncated: false,
          result_received_at: at,
          result_expires_at: at + RESULT_KEEP_DAYS * 86_400_000,
        },
        undefined,
        { state: 'result_saved', failure: null },
      );
    } catch (error) {
      // The same answer would be refused on every pass (the kind would run again each time): the
      // call ends without a result. Anything else (a lost connection) is tried again.
      if (resultRefused(error)) return noResult('no_result');
      throw error;
    }
  }

  /** One step of a fee-included call past its float: Base's word, then the delivery. */
  async function stepIncluded(row: CallRow, ctx: WorkContext): Promise<boolean> {
    if (row.payment_state !== 'sent' && row.payment_state !== 'settled') return false;
    // Final and recorded: only a delivery may be left (committed at finality without the caps).
    if (row.payment_state === 'settled' && row.pay_final_at !== null) {
      if (row.state !== 'settled') return false;
      if (row.delivered_at === null) return commitDelivery(row, true);
      return deliver(row);
    }
    const port = await chain().catch(() => null);
    if (!port) return false;
    const key = payKeyOf(row);
    const r3 = onRouter3(row);
    const op = r3
      ? await router3OpOf(key)
      : await opOf(port, key, row.wallet_id).catch(() => undefined);
    if (op === undefined) return false;
    if (op === null) {
      // Moved to 'calling' but never stored (a crash between): past the grace nothing sends it any
      // more. The key is fenced and the call ends with nothing paid.
      if (
        row.payment_state !== 'sent' ||
        Number(row.updated_at) >= now() - FEED_PAY_RECOVER_GRACE_MS
      )
        return false;
      if (r3) {
        const f = await facilitator();
        if (!f || !(await f.endUnsent(key, payIntentOf(row)).catch(() => false))) return false;
        // Fenced: no settlement can go out under this key any more; a pair signed before the crash
        // is still followed until Base shows it unused past its window.
        return router3NotMade(
          row,
          port,
          {
            key,
            status: 'failed',
            txHash: null,
            blockNumber: null,
            neverSent: true,
            errorCode: null,
          },
          ctx,
        );
      }
      if (!(await port.endUnsent(key, payIntentOf(row), 'protocol_fee'))) return false;
      return payNotMade(row, ctx.refusal ?? 'interrupted', null);
    }
    if (op.neverSent || op.status === 'failed' || (op.status === 'final' && op.errorCode)) {
      if (row.payment_state === 'settled') return payDropped(row);
      if (r3) return router3NotMade(row, port, op, ctx);
      // Refused only for the provider's rate, and provably never sent: a new payment later
      // (planPayAgain), unless its attempts or its time are used up.
      const limited = ctx.payRateLimited?.key === key ? ctx.payRateLimited : null;
      if (limited && op.neverSent && !ctx.refusal && row.payment_state === 'sent') {
        const again = await planPayAgain(row, key, ctx, limited.retryAfterMs);
        if (again !== 'exhausted') return again;
      }
      return payNotMade(
        row,
        op.neverSent ? (ctx.refusal ?? 'interrupted') : 'payment_rejected',
        op.neverSent ? null : { txHash: op.txHash },
      );
    }
    // Router 3: a settlement stored but never signed or sent (its first send could not reach Base,
    // e.g. RPC_UNAVAILABLE) stays 'queued' with no transaction and nothing else ever sends it. Ask
    // the facilitator again under the same key: it continues exactly the stored settlement (same
    // signed pair, same calldata), so nothing can be paid twice; a pair past its window then fails
    // simulation and ends through router3NotMade like any never-sent settlement (room x402 #208).
    if (r3 && op.status === 'queued' && !op.txHash && row.payment_state === 'sent') {
      const split = splitOf(row);
      if (split) await sendRouter3(row, port, ctx, split);
      return false;
    }
    // In a block but reverted (not deep enough to be failed yet), in flight, or reorged: wait.
    if ((op.status !== 'included' && op.status !== 'final') || op.errorCode || !op.txHash)
      return false;
    const final = op.status === 'final';
    // An anomaly already recorded: only its finality is left to record.
    if (row.failure_code === 'payment_unverified')
      return final ? move(row, { pay_final_at: now() }) : false;
    const receipt = await port.receiptLogs(op.txHash);
    if (!receipt) return false;
    const matches = receipt.status === 'success' && payMatches(row, receipt.logs);
    // Router 3's transfer evidence: 'unknown' (the treasury binding not readable right now) waits
    // and is checked again; only a receipt that contradicts the call is an anomaly (review #64).
    const transfers =
      r3 && matches ? await router3TransfersMatch(row, port, receipt.logs) : 'match';
    if (transfers === 'unknown') return false;
    if (!matches || transfers === 'mismatch') return payAnomaly(row, op, final);
    const tx = op.txHash.toLowerCase();
    const block = (op.blockNumber ?? receipt.blockNumber).toString(10);
    if (row.payment_state === 'sent')
      // Paid: the seller has 90% and the treasury 10% of the price, in this one transaction.
      return move(
        row,
        {
          state: 'settled',
          payment_state: 'settled',
          tx_hash: tx,
          settled_block: block,
          settled_at: now(),
          fee_state: 'charged',
          fee_tx_hash: tx,
          fee_block: block,
          ...(final ? { pay_final_at: now() } : {}),
        },
        'paid',
      );
    // Settled before: included again elsewhere after a reorg (the same operation, so the same
    // payment), or now final.
    if (row.tx_hash !== tx || String(row.settled_block) !== block)
      return move(row, {
        tx_hash: tx,
        settled_block: block,
        fee_tx_hash: tx,
        fee_block: block,
        ...(final ? { pay_final_at: now() } : {}),
      });
    if (final) return move(row, { pay_final_at: now() });
    if (row.state !== 'settled') return false;
    if (row.delivered_at === null) return commitDelivery(row, false);
    return deliver(row);
  }

  /** Base decides the payment: settled, cancelled or expired (and a cancel while it may help). */
  async function stepReconcile(row: CallRow): Promise<boolean> {
    if (!openPayment(row)) {
      // A call that ended with its payment decided (or never signed) has nothing left to do.
      return false;
    }
    const port = await chain().catch(() => null);
    if (!port || row.nonce === null || row.valid_before === null) return false;
    const outcome = await port.outcome({
      payer: getAddress(row.spender_address) as Address,
      nonce: row.nonce as Hex,
      fromBlock: BigInt(num(row.search_from_block) ?? 0),
      validBefore: Number(row.valid_before),
      claimedTx: (row.claimed_tx as Hex | null) ?? null,
    });
    if (outcome.kind === 'used') {
      const paidWithout = row.state !== 'result_saved';
      const ok = await move(
        row,
        {
          payment_state: 'settled',
          tx_hash: outcome.txHash.toLowerCase(),
          settled_block: outcome.blockNumber.toString(10),
          settled_at: outcome.at,
          ...(paidWithout ? { state: 'paid_no_result', failure_code: 'no_result' } : {}),
        },
        'paid',
        paidWithout
          ? { state: 'paid_no_result', failure: 'no_result' }
          : { state: row.state, failure: row.failure_code },
      );
      if (ok && paidWithout)
        alert({
          kind: 'paid_no_result',
          callId: row.call_id,
          serviceId: row.service_id,
          host: row.host,
          walletId: row.wallet_id,
          amountRaw: row.amount_raw,
        });
      return ok;
    }
    if (outcome.kind === 'canceled' || outcome.kind === 'expired') {
      const keep = row.state === 'result_saved';
      const state: FeedPayCallState = keep
        ? 'result_saved'
        : outcome.kind === 'canceled'
          ? 'cancelled'
          : 'expired';
      const ok = await move(
        row,
        {
          payment_state: outcome.kind === 'canceled' ? 'cancelled' : 'expired',
          // The seller was never paid, so no protocol fee is owed.
          ...(row.fee_state === 'pending' ? { fee_state: 'not_owed' } : {}),
          ...(keep ? {} : { state, failure_code: row.failure_code ?? 'service_timeout' }),
        },
        'failed',
        { state, failure: keep ? null : (row.failure_code ?? 'service_timeout') },
      );
      return ok;
    }
    // Still open: a call that did not settle gets its authorization cancelled while that helps.
    const nowS = Math.floor(now() / 1000);
    // One cancel per payment: one that could not be sent is not tried again (it runs out instead).
    if (
      row.state === 'not_settled' &&
      row.payment_state === 'sent' &&
      !row.cancel_op_key &&
      Number(row.valid_before) - nowS > FEED_PAY_CANCEL_MARGIN_S
    ) {
      const key = `feed-pay:cancel:${row.payment_id}`;
      if (!(await move(row, { payment_state: 'cancelling', cancel_op_key: key }))) return false;
      try {
        await port.cancel({
          key,
          intentHash: opIntentHash({ cancel: row.payment_id, nonce: row.nonce }),
          wallet: walletRef(row),
          nonce: row.nonce as Hex,
          beforeBroadcast: async () => {},
        });
      } catch {
        // Not sent: the authorization simply runs out at validBefore.
      }
      return true;
    }
    if (row.payment_state === 'cancelling' && row.cancel_op_key) {
      const op = await opOf(port, row.cancel_op_key, row.wallet_id).catch(() => null);
      // A cancel that never went out or failed: wait for Base or for validBefore.
      if (op && (op.neverSent || op.status === 'failed'))
        return move(row, { payment_state: 'sent' });
    }
    return false;
  }

  // -------------------------------------------------------------------------------------------
  // Reads

  async function callFor(accountId: string, callId: string): Promise<FeedPayCall | null> {
    const row = await loadCall(db, callId);
    if (!row || row.owner_account_id !== accountId) return null;
    return callView(row);
  }

  /** Waits until the call is done, its worker stopped or `ms` passed; answers it as it is then. */
  async function waitFor(callId: string, ms: number, work: Promise<void> | null) {
    const deadline = now() + ms;
    let finished = work === null;
    const stopped = work
      ? work.then(
          () => (finished = true),
          () => (finished = true),
        )
      : Promise.resolve(true);
    for (;;) {
      // The polls skip the result's text; only the answer reads it (once, when there is one).
      const row = await loadCall(db, callId, { text: false });
      if (!row) return null;
      if (feedPayCallDone(callView(row)) || finished || now() >= deadline)
        return hasResultText(row) ? ((await loadCall(db, callId)) ?? row) : row;
      await Promise.race([stopped, sleep(Math.min(pollMs, Math.max(1, deadline - now())))]);
    }
  }

  async function floatOf(
    port: FeedPayChainPort,
    walletId: string,
    spender: Address,
  ): Promise<bigint | null> {
    const read = await withTimeout(port.usdcBalance(spender), FEED_PAY_BALANCE_TIMEOUT_MS);
    if (!read) return null;
    const held = await floatHeld(db, { walletId, block: read.blockNumber });
    return max(read.balance - held, 0n);
  }

  /** One of the person's agents that could pay (FeedPayAgent). */
  async function agentView(port: FeedPayChainPort | null, payer: Payer): Promise<FeedPayAgent> {
    const limit = await limitOf(db, payer);
    const perCallMax = await perCallMaxOf(db, payer.walletId, perCallCap());
    const floatTarget = await floatTargetOf(db, payer.walletId);
    const usable = payer.walletState === 'derived' || payer.walletState === 'deployed';
    const [usdc, float, allowance] = await Promise.all([
      port
        ? withTimeout(
            (async () => {
              const read = await port.usdcBalance(payer.wallet.address);
              const holds = await unavailableAmount(db, {
                walletId: payer.walletId,
                token: USDC,
                blockNumber: read.blockNumber,
              });
              return max(read.balance - holds, 0n);
            })(),
            FEED_PAY_BALANCE_TIMEOUT_MS,
          )
        : null,
      port ? floatOf(port, payer.walletId, payer.wallet.spender).catch(() => null) : null,
      port && limit
        ? withTimeout(port.allowanceLeft(limit.permission), FEED_PAY_BALANCE_TIMEOUT_MS)
        : null,
    ]);
    // Base's word on the limit's window when it answered, else the clock's.
    const phase = limit ? (allowance?.phase ?? limitWindow(limit, now())) : null;
    let limitLeft: bigint | null = null;
    if (limit && phase === 'active') {
      const calendar = await calendarLeft(db, limit, payer.walletId, now());
      const base = allowance?.phase === 'active' && float !== null ? allowance.left + float : null;
      limitLeft = calendar === null ? base : base === null ? null : min(calendar, base);
    }
    const consent = limit ? await hasConsent(db, payer, limit) : false;
    let notReady: FeedPayNotReadyReason | null = null;
    if (payer.paused) notReady = 'paused';
    else if (!usable) notReady = 'wallet_not_usable';
    else if (!limit || phase === 'after_end') notReady = 'no_limit';
    else if (phase === 'before_start') notReady = 'limit_not_started';
    else if (limitLeft !== null && limitLeft === 0n) notReady = 'limit_used';
    else if (usdc === 0n && float === 0n) notReady = 'no_funds';
    return {
      agentId: payer.agentId,
      name: payer.agentName,
      wallet: payer.wallet.address,
      spender: payer.wallet.spender,
      usdcRaw: usdc === null ? null : usdc.toString(10),
      floatRaw: float === null ? null : float.toString(10),
      limitRaw: limit ? limit.capRaw.toString(10) : null,
      limitLeftRaw: limitLeft === null ? null : limitLeft.toString(10),
      limitPeriod: limit?.period ?? null,
      limitStartsAt: limit && phase === 'before_start' ? isoOf(limit.permission.start) : null,
      perCallMaxRaw: (perCallMax ?? BigInt(DEFAULT_PER_CALL_MAX_RAW)).toString(10),
      perCallMaxIsDefault: perCallMax === null,
      perCallMaxCapRaw: perCallCap().toString(10),
      floatTargetRaw: (floatTarget ?? BigInt(DEFAULT_FLOAT_RAW)).toString(10),
      floatTargetIsDefault: floatTarget === null,
      hasLimit: !!limit,
      hasConsent: consent,
      paused: payer.paused,
      ready: notReady === null,
      notReady,
    };
  }

  /**
   * The person's agents with a wallet on Base, at most `limit` (one more is read to know whether
   * there are more): those with a spending limit first (only they can pay), then the ones used
   * for a service call most recently, then the oldest wallet.
   */
  async function payersOf(accountId: string, limit: number) {
    const { rows } = await db.query<PayerRow>(
      `${PAYER_SELECT} WHERE w.owner_account_id = $1 AND w.chain_id = $2
       ORDER BY EXISTS (SELECT 1 FROM base_spend_permissions p WHERE p.wallet_id = w.wallet_id
           AND p.state IN ('signed','onchain')) DESC,
         (SELECT max(c.created_at) FROM feed_pay_calls c WHERE c.wallet_id = w.wallet_id)
           DESC NULLS LAST,
         w.created_at, w.wallet_id
       LIMIT $3`,
      [accountId, CHAIN_ID, limit + 1],
    );
    const payers = rows.map(payerOfRow).filter((payer): payer is Payer => payer !== null);
    return { payers: payers.slice(0, limit), more: rows.length > limit };
  }

  /** Runs `work` over `items`, at most `width` at a time, keeping their order. */
  async function pooled<T, R>(items: T[], width: number, work: (item: T) => Promise<R>) {
    const out: R[] = new Array(items.length);
    let next = 0;
    const lane = async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await work(items[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
    return out;
  }

  async function agents(accountId: string): Promise<FeedPayAgentList> {
    const port = await chain().catch(() => null);
    const { payers, more } = await payersOf(accountId, FEED_PAY_LIMITS.agentsMax);
    // A few agents at a time: each reads Base three times and the database a few times.
    const list = await pooled(payers, 4, (payer) => agentView(port, payer));
    // Agents that can pay first; the order within each group stays.
    const ordered = [...list.filter((a) => a.ready), ...list.filter((a) => !a.ready)];
    return {
      agents: ordered,
      ...(more ? { more: true } : {}),
      defaultPerCallMaxRaw: String(DEFAULT_PER_CALL_MAX_RAW),
      floatTargetRaw: String(DEFAULT_FLOAT_RAW),
      readAt: now(),
    };
  }

  async function setPerCallMax(
    accountId: string,
    agentId: string,
    body: unknown,
  ): Promise<FeedPayAgent> {
    const parsed = feedPayAgentBody.safeParse(body ?? {});
    if (!parsed.success) throw refuse('invalid_request');
    const raw = (v: string | null | undefined) =>
      v === undefined ? undefined : v === null ? null : BigInt(v);
    const value = raw(parsed.data.perCallMaxRaw);
    const target = raw(parsed.data.floatTargetRaw);
    if (
      value !== undefined &&
      value !== null &&
      (value < BigInt(FEED_PAY_LIMITS.perCallMaxMinRaw) || value > perCallCap())
    )
      throw refuse('invalid_request');
    // The pot target: 1 USDC (the default) to 100 USDC (FEE_ROUTER_2.md section 6).
    if (
      target !== undefined &&
      target !== null &&
      (target < BigInt(DEFAULT_FLOAT_RAW) ||
        target > BigInt(FEED_PAY_LIMITS.perCallMaxMaxRouter2Raw))
    )
      throw refuse('invalid_request');
    const payer = await payerFor(db, { origin: 'feed', accountId }, agentId);
    if (!payer) throw refuse('agent_not_found');
    // The pot target never above the owner's spending limit per period (spec section 6): USDC moved
    // into the pot counts as spent for the whole period. A later lower limit clamps the top-up
    // itself (allowance left), so a stored target never moves more than the limit allows.
    if (target !== undefined && target !== null) {
      const limit = await limitOf(db, payer);
      if (!limit || target > limit.capRaw) throw refuse('over_period_limit');
    }
    const at = now();
    const text = (v: bigint | null) => (v === null ? null : v.toString(10));
    await db.transaction(async (tx) => {
      if (value !== undefined) {
        await tx.query(
          `INSERT INTO feed_pay_agent_settings (wallet_id, per_call_max_raw, changed_by, changed_at,
             updated_at)
           VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (wallet_id) DO UPDATE SET per_call_max_raw = $2, changed_by = $3,
             changed_at = $4, updated_at = $4`,
          [payer.walletId, text(value), accountId, at],
        );
        await audit(tx, {
          at,
          actor: `owner ${accountId}`,
          operatorId: payer.operatorId,
          agentId: payer.agentId,
          kind: 'feed_pay_per_call_max',
          detail: { walletId: payer.walletId, perCallMax: text(value) },
        });
      }
      if (target !== undefined) {
        await tx.query(
          `INSERT INTO feed_pay_agent_settings (wallet_id, float_target_raw, changed_by, changed_at,
             updated_at)
           VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (wallet_id) DO UPDATE SET float_target_raw = $2, changed_by = $3,
             changed_at = $4, updated_at = $4`,
          [payer.walletId, text(target), accountId, at],
        );
        await audit(tx, {
          at,
          actor: `owner ${accountId}`,
          operatorId: payer.operatorId,
          agentId: payer.agentId,
          kind: 'feed_pay_float_target',
          detail: { walletId: payer.walletId, floatTarget: text(target) },
        });
      }
    });
    return agentView(await chain().catch(() => null), payer);
  }

  /** The wallet History part (FeedPayHistory); null when the wallet is not this account's. */
  async function history(accountId: string, agentId: string): Promise<FeedPayHistory | null> {
    const { rows: wallets } = await db.query<{ wallet_id: string; spender_address: string }>(
      `SELECT wallet_id, spender_address FROM base_wallets
       WHERE agent_id = $1 AND chain_id = $2 AND owner_account_id = $3`,
      [agentId, CHAIN_ID, accountId],
    );
    const wallet = wallets[0];
    if (!wallet) return null;
    const { rows } = await db.query<CallRow>(
      `${CALL_SELECT} WHERE c.wallet_id = $1 ORDER BY c.created_at DESC, c.call_id DESC LIMIT $2`,
      [wallet.wallet_id, FEED_PAY_LIMITS.historyMax],
    );
    const { rows: moves } = await db.query<MoveRow>(
      `SELECT ${MOVE_COLUMNS} FROM feed_pay_float_moves WHERE wallet_id = $1
       ORDER BY created_at DESC, move_id DESC LIMIT $2`,
      [wallet.wallet_id, FEED_PAY_LIMITS.historyMax],
    );
    // Base is read only for a wallet whose float is open or still moving: one Feed pay never
    // touched (or whose float went back) has nothing ready for services, and no node is asked.
    const { rows: settings } = await db.query<{ float_open: boolean }>(
      'SELECT float_open FROM feed_pay_agent_settings WHERE wallet_id = $1',
      [wallet.wallet_id],
    );
    const idle =
      !settings[0]?.float_open &&
      !moves.some((item) => item.state === 'pending') &&
      !(await hasLiveCalls(db, wallet.wallet_id));
    let float: bigint | null = 0n;
    if (!idle) {
      const port = await chain().catch(() => null);
      float = port
        ? await floatOf(
            port,
            wallet.wallet_id,
            getAddress(wallet.spender_address) as Address,
          ).catch(() => null)
        : null;
    }
    const perCallMax = await perCallMaxOf(db, wallet.wallet_id, perCallCap());
    return {
      calls: rows.map(historyItem),
      moves: moves.map(moveView),
      readyForServices: float === null ? null : amountOf(float),
      perCallMax: amountOf(perCallMax ?? BigInt(DEFAULT_PER_CALL_MAX_RAW)),
      perCallMaxCapRaw: perCallCap().toString(10),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Recovery and sweeps (the cron)

  /**
   * Calls of a dead process (lease over, unchanged past the grace): never sends a paid request.
   * reserved and float_topup end refused (nothing was signed): `paused` when Feed pay is off for
   * them, else `interrupted`. authorized was never sent (`interrupted`) and calling lost its
   * answer, so both go to Base (reconciling); the rest are reconciled. A call waiting for a
   * rate-limited top-up planned again is not taken before its topup_retry_at plus the grace: the
   * worker that holds the caller's context (the request's own, or a same-key retry) plans it; the
   * cron never plans a new top-up. A fee-included call waiting for a rate-limited payment planned
   * again (pay_retry_at) is treated the same way: the cron never plans a new payment either (it
   * steps such calls with an empty context, which carries no rate limit).
   */
  async function recoverCall(row: CallRow): Promise<'ended' | 'moved' | 'waiting'> {
    if (row.state === 'reserved' || row.state === 'float_topup') {
      if (row.state === 'float_topup') {
        // The top-up itself goes on as a float move; only the call stops.
        const moveRow = await moveOf(row.topup_move_id);
        const port = await chain().catch(() => null);
        if (moveRow && port) await opOf(port, moveRow.op_key, row.wallet_id).catch(() => null);
      }
      const why = feedPayEnabled(env) ? 'interrupted' : 'paused';
      return (await refused(row, why)) ? 'ended' : 'waiting';
    }
    // A fee-included call past its float: its payment, its delivery and its finality, a few steps
    // per run (it never waits on Base here); then the ledger's word on its fee.
    if (row.pay_kind === 'included') {
      let moved = false;
      let current: CallRow | null = row;
      for (let i = 0; i < 4 && current; i++) {
        if (!(await stepIncluded(current, {}))) break;
        moved = true;
        current = await loadCall(db, row.call_id);
      }
      if (current && current.fee_state === 'charged' && !current.fee_verified)
        moved = (await verifyFee(current)) || moved;
      return moved ? 'moved' : 'waiting';
    }
    if (row.state === 'authorized') return (await unsent(row, 'interrupted')) ? 'moved' : 'waiting';
    if (row.state === 'calling')
      return (await move(row, { state: 'reconciling', ...scrubbed(row) }, 'reconciling'))
        ? 'moved'
        : 'waiting';
    if (row.payment_state === 'settled' && feeOwed(row))
      return (await stepFee(row)) ? 'moved' : 'waiting';
    if (row.fee_state === 'charged' && !row.fee_verified)
      return (await verifyFee(row)) ? 'moved' : 'waiting';
    if (await stepReconcile(row)) return 'moved';
    // Base should have decided an hour after the window closed: say so (ids only), every run, so
    // a payment whose events can't be found is seen (it keeps its wallet's float from a sweep).
    if (openPayment(row) && Number(row.valid_before ?? 0) < Math.floor(now() / 1000) - 3_600)
      log(
        JSON.stringify({
          event: 'feed_pay_reconcile_stuck',
          callId: row.call_id,
          walletId: row.wallet_id,
          paymentId: row.payment_id,
        }),
      );
    return 'waiting';
  }

  /** Brings pending float moves up to date (a failed sweep alerts ops). */
  async function settleMoves(limit: number) {
    // First the top-ups whose operation already ended with an error (reverted on Base): topUpInFlight
    // counts them as in flight until they are ended here, so every new call of their wallet waits
    // for them. Behind the backlog of moves that only wait for finality (oldest checked first), they
    // kept a whole fleet's wallets blocked for hours (22 Oct, Fleet D: 59 wallets, USEROP_REVERTED).
    const { rows: blocking } = await db.query<MoveRow>(
      `SELECT ${MOVE_COLUMNS} FROM feed_pay_float_moves WHERE move_id IN (
         SELECT m.move_id FROM feed_pay_float_moves m
         JOIN base_chain_ops o ON o.idempotency_key = m.op_key
         WHERE m.state = 'pending' AND m.kind = 'top_up'
           AND o.status = 'included' AND o.error_code IS NOT NULL
         ORDER BY m.checked_at LIMIT $1)`,
      // At most half the page: reverted moves not final on Base yet stay pending and come first
      // again each run; the other half always goes to the backlog (review #566).
      [Math.max(1, Math.floor(limit / 2))],
    );
    const taken = new Set(blocking.map((m) => m.move_id));
    const rest =
      blocking.length < limit
        ? (
            await db.query<MoveRow>(
              `SELECT ${MOVE_COLUMNS} FROM feed_pay_float_moves m WHERE state = 'pending'
                 AND NOT EXISTS (SELECT 1 FROM base_chain_ops o WHERE o.idempotency_key = m.op_key
                   AND o.status = 'included' AND o.error_code IS NOT NULL)
               ORDER BY checked_at, updated_at LIMIT $1`,
              [limit - blocking.length],
            )
          ).rows.filter((m) => !taken.has(m.move_id))
        : [];
    const rows = [...blocking, ...rest];
    if (!rows.length) return 0;
    const port = await chain().catch(() => null);
    if (!port) return 0;
    let settled = 0;
    for (const moveRow of rows) {
      // Least recently checked first (migration 241): a move that keeps waiting on Base goes to the
      // back, so a backlog of such moves never blocks the newer ones. updated_at stays as it is: the
      // grace for a move that never got an operation reads it.
      await db.query('UPDATE feed_pay_float_moves SET checked_at = $2 WHERE move_id = $1', [
        moveRow.move_id,
        now(),
      ]);
      const op = await opOf(port, moveRow.op_key, moveRow.wallet_id).catch(() => undefined);
      if (op === undefined) continue;
      if (op === null) {
        // Planned, never stored: past the grace nothing will send it any more. The key is fenced
        // (a late worker then never sends it) and anything it holds is released.
        if (
          Number(moveRow.updated_at) < now() - FEED_PAY_RECOVER_GRACE_MS &&
          (await port.endUnsent(moveRow.op_key, moveRow.intent_hash as Hex, moveRow.kind))
        ) {
          await endMove(moveRow, 'failed', null);
          settled++;
        }
        continue;
      }
      if (op.status === 'final' || op.neverSent || op.status === 'failed') {
        const done = op.status === 'final' && !op.errorCode;
        await endMove(moveRow, done ? 'final' : 'failed', op.txHash);
        settled++;
        // A sweep refused before it was sent (a call started meanwhile) is no failure: the next
        // run tries again. Anything else that did not land alerts ops.
        if (
          moveRow.kind === 'sweep' &&
          !done &&
          op.errorCode !== 'REFUSED_BEFORE_BROADCAST' &&
          op.errorCode !== 'ABANDONED_BEFORE_BROADCAST'
        )
          alert({
            kind: 'sweep_failed',
            walletId: moveRow.wallet_id,
            amountRaw: moveRow.amount_raw,
            detail: op.errorCode ?? 'failed',
          });
      }
    }
    return settled;
  }

  /**
   * Float holds left 'held' on an agent wallet although their move is no longer pending (or has no
   * row): nothing else visits them again, and every admission and top-up counts them as unavailable.
   * Each goes through the same rules as a pending move: the top-up's operation, if stored, settles
   * it (consumed only when final, released only when failed or never sent); an operation key that
   * never got an operation is fenced past the grace and released only if the fence wins. A hold
   * whose operation is still in flight (queued, submitted, included, unknown, reconciling, reorged)
   * is left as it is. Least recently checked first; at most `limit` per run. Answers how many it
   * ended.
   */
  async function settleFloatHolds(limit: number) {
    const { rows } = await db.query<{
      reservation_id: string;
      holder_ref: string;
      wallet_id: string;
      intent_hash: string;
    }>(
      `SELECT r.reservation_id, r.holder_ref, r.wallet_id, r.intent_hash FROM base_wallet_reservations r
       WHERE r.holder_kind = 'float' AND r.state = 'held' AND r.updated_at < $1
         AND NOT EXISTS (SELECT 1 FROM feed_pay_float_moves m
           WHERE m.op_key = r.holder_ref AND m.state = 'pending')
       ORDER BY r.checked_at, r.updated_at LIMIT $2`,
      [now() - FEED_PAY_RECOVER_GRACE_MS, limit],
    );
    if (!rows.length) return 0;
    const port = await chain().catch(() => null);
    if (!port) return 0;
    let ended = 0;
    for (const hold of rows) {
      // Least recently checked first (migration 241): a hold whose operation stays in flight goes to
      // the back. updated_at stays as it is: the grace for a key that never got an operation reads it.
      await db.query(
        'UPDATE base_wallet_reservations SET checked_at = $2 WHERE reservation_id = $1',
        [hold.reservation_id, now()],
      );
      try {
        const op = await opOf(port, hold.holder_ref, hold.wallet_id);
        if (op === null) {
          if (await port.endUnsent(hold.holder_ref, hold.intent_hash as Hex, 'top_up')) ended++;
          continue;
        }
        if (op.status === 'final' || op.status === 'failed' || op.neverSent) ended++;
      } catch (error) {
        // One broken hold never stops the rest; it is logged (ids only).
        logFailure('feed_pay_float_hold_failed', { walletId: hold.wallet_id }, error);
      }
    }
    return ended;
  }

  /**
   * Why a wallet's float goes back now, or null to keep it (section 8). Reasons: `switched_off`
   * (Feed pay off), `agent_paused` (paused or removed), `wallet` (not usable), `limit_changed`
   * (revoked, replaced or revoke pending: no longer the wallet's active limit), `limit_ended` (the
   * permission's own end passed). The end of a Base period alone is no reason: while the same
   * permission simply continues (still the active limit, recurring, its end not passed, with a
   * Berlin calendar cap) the float is kept and used in the new period. Its payments count against
   * the new period's calendar cap when they are made (calendarSpent counts payments, never
   * top-ups); onchain the top-up already counted in the old period. Such a float, once its Base
   * period ended, comes back as `{ periodEnd }` (the current period's end): it is closed if it is
   * empty, else kept and looked at again when that period ends.
   */
  async function sweepReason(
    walletId: string,
    permissionId: string | null,
    periodEnd: number | null,
  ): Promise<string | { periodEnd: number } | null> {
    const { rows } = await db.query<PayerRow>(`${PAYER_SELECT} WHERE w.wallet_id = $1`, [walletId]);
    const payer = rows[0] ? payerOfRow(rows[0]) : null;
    if (!feedPayEnabled(env)) return 'switched_off';
    if (!payer || payer.paused) return 'agent_paused';
    if (payer.walletState !== 'derived' && payer.walletState !== 'deployed') return 'wallet';
    // limitOf reads only a signed or onchain limit (never revoke_pending or revoked), the newest
    // one: the same permission id is the same stored permission and hash, not replaced.
    const limit = await limitOf(db, payer);
    if (!limit || limit.permissionId !== permissionId) return 'limit_changed';
    const nowS = Math.floor(now() / 1000);
    if (!(limit.permission.period > 0) || nowS >= limit.permission.end) return 'limit_ended';
    // A limit with no calendar cap (an on-chain period of another length) has only Base's
    // allowance per period: a float carried over would let it spend more than that in the new
    // period, so its float still goes back when the period ends, as before.
    if (periodEnd === null || nowS < periodEnd) return null;
    if (limit.period === null) return 'period_ended';
    return { periodEnd: basePeriodWindow(limit.permission, nowS).end };
  }

  /** The wallet's float settings row and its moves (count, latest change, states), as one string. */
  async function floatSnapshot(q: Pick<Database, 'query'>, walletId: string): Promise<string> {
    const { rows } = await q.query<{ s: string | null }>(
      `SELECT coalesce((SELECT row(s.*)::text FROM feed_pay_agent_settings s WHERE s.wallet_id = $1), '')
         || '|' || (SELECT count(*)::text || ':' || coalesce(max(updated_at), 0)::text || ':'
                    || coalesce(string_agg(state, ',' ORDER BY move_id), '')
                    FROM feed_pay_float_moves WHERE wallet_id = $1 AND state = 'pending')
         || '|' || (SELECT count(*)::text FROM feed_pay_float_moves WHERE wallet_id = $1)
         || '|' || (SELECT count(*)::text || ':' || coalesce(max(updated_at), 0)::text
                    FROM feed_pay_calls WHERE wallet_id = $1) AS s`,
      [walletId],
    );
    return rows[0]?.s ?? '';
  }

  /**
   * Sends a wallet's whole available float back to it, when nothing of it is still in use. With
   * `keepFunded` (the limit continues into a new Base period) it only closes an empty float and
   * keeps one with USDC in it ('kept').
   */
  async function sweepWallet(
    walletId: string,
    reason: string,
    keepFunded = false,
  ): Promise<'swept' | 'empty' | 'busy' | 'kept'> {
    if ((await hasLiveCalls(db, walletId)) || (await hasPendingMove(db, walletId))) return 'busy';
    const port = await chain().catch(() => null);
    if (!port) return 'busy';
    const { rows } = await db.query<{
      address: string;
      spender_address: string;
      spender_key_ref: string;
      operator_id: string;
      agent_id: string;
    }>(
      `SELECT address, spender_address, spender_key_ref, operator_id, agent_id FROM base_wallets
       WHERE wallet_id = $1`,
      [walletId],
    );
    const w = rows[0];
    if (!w) return 'busy';
    const wallet: WalletRef = {
      walletId,
      address: getAddress(w.address) as Address,
      spender: getAddress(w.spender_address) as Address,
      spenderKeyRef: w.spender_key_ref,
    };
    const before = await floatSnapshot(db, walletId);
    const free = await floatOf(port, walletId, wallet.spender);
    if (free === null) return 'busy';
    if (free === 0n) {
      // The balance read took time and held no lock: close the float only if, under the wallet
      // lock, nothing is live or pending and the wallet's float settings and moves are exactly as
      // they were before the read (a top-up started meanwhile would otherwise be left in a float
      // marked closed, which no later sweep picks up).
      const closed = await db.transaction(async (tx) => {
        await tx.query('SELECT 1 FROM base_wallets WHERE wallet_id = $1 FOR UPDATE', [walletId]);
        if ((await hasLiveCalls(tx, walletId)) || (await hasPendingMove(tx, walletId)))
          return false;
        if ((await floatSnapshot(tx, walletId)) !== before) return false;
        await tx.query(
          'UPDATE feed_pay_agent_settings SET float_open = false, updated_at = $2 WHERE wallet_id = $1',
          [walletId, now()],
        );
        return true;
      });
      return closed ? 'empty' : 'busy';
    }
    if (keepFunded) return 'kept';
    const moveId = randomUUID();
    const key = `feed-pay:sweep:${moveId}`;
    const intentHash = opIntentHash({ moveId, wallet: walletId, amount: free.toString(10) });
    const at = now();
    const planned = await db.transaction(async (tx) => {
      // The wallet row is the lock against a top-up or another cron run planning at the same time.
      await tx.query('SELECT 1 FROM base_wallets WHERE wallet_id = $1 FOR UPDATE', [walletId]);
      if ((await hasLiveCalls(tx, walletId)) || (await hasPendingMove(tx, walletId))) return false;
      await tx.query(
        `INSERT INTO feed_pay_float_moves (move_id, wallet_id, chain_id, kind, amount_raw, op_key,
           intent_hash, state, reason, created_at, updated_at)
         VALUES ($1,$2,$3,'sweep',$4,$5,$6,'pending',$7,$8,$8)`,
        [moveId, walletId, CHAIN_ID, free.toString(10), key, intentHash, reason, at],
      );
      await audit(tx, {
        at,
        actor: 'feed pay sweep',
        operatorId: w.operator_id,
        agentId: w.agent_id,
        kind: 'feed_pay_float_sweep',
        detail: { moveId, amount: free.toString(10), reason },
      });
      return true;
    });
    if (!planned) return 'busy';
    try {
      await port.sweep({
        key,
        intentHash,
        wallet,
        amount: free,
        // Never while an authorization of this spender may still be used.
        beforeBroadcast: async () => {
          if (await hasLiveCalls(db, walletId)) throw new Error('busy');
        },
      });
    } catch {
      // Stored or tombstoned: settleMoves ends it (a failed one alerts ops).
    }
    return 'swept';
  }

  /**
   * Checks the open floats checked least recently (each check is recorded, so every open float
   * comes round however many are open) and sweeps those with a reason.
   */
  async function sweeps(limit: number, deadline: number) {
    const { rows } = await db.query<{
      wallet_id: string;
      float_permission_id: string | null;
      float_period_end: string | number | null;
    }>(
      `SELECT wallet_id, float_permission_id, float_period_end FROM feed_pay_agent_settings
       WHERE float_open ORDER BY sweep_checked_at, wallet_id LIMIT $1`,
      [limit],
    );
    let swept = 0;
    for (const row of rows) {
      if (now() >= deadline) break;
      await db.query(
        'UPDATE feed_pay_agent_settings SET sweep_checked_at = $2 WHERE wallet_id = $1',
        [row.wallet_id, now()],
      );
      try {
        const reason = await sweepReason(
          row.wallet_id,
          row.float_permission_id,
          num(row.float_period_end),
        );
        if (!reason) continue;
        if (typeof reason === 'object') {
          // The same limit continues into a new Base period: the float stays (an empty one is
          // closed). Its balance is read again only when this period ends.
          if ((await sweepWallet(row.wallet_id, 'period_continues', true)) === 'kept')
            await db.query(
              `UPDATE feed_pay_agent_settings SET float_period_end = $2
               WHERE wallet_id = $1 AND float_open AND float_period_end < $2`,
              [row.wallet_id, reason.periodEnd],
            );
          continue;
        }
        if ((await sweepWallet(row.wallet_id, reason)) === 'swept') swept++;
      } catch (error) {
        logFailure('feed_pay_sweep_failed', { walletId: row.wallet_id }, error);
      }
    }
    return swept;
  }

  const logFailure = (event: string, ids: Record<string, string>, error: unknown) =>
    log(
      JSON.stringify({
        event,
        ...ids,
        error: error instanceof Error ? error.constructor.name : 'unknown',
      }),
    );

  /** One cron run (FEED_PAY_PATHS.cron): calls, moves, sweeps, old results and quotes. */
  /**
   * Bulk finality (see recover): the facilitator's batch, then pay_final_at for every settled
   * fee-included call whose router 3 operation is final with the same transaction and block the
   * call recorded, at most FINALITY_CALLS_PER_RUN per run (oldest settled first). Conditional on
   * pay_final_at still NULL, so a call stepped meanwhile is untouched.
   */
  async function recordFinality(budgetMs: number): Promise<number> {
    const f = await facilitator();
    if (!f?.finalizeIncluded) return 0;
    await f.finalizeIncluded({
      maxBlocks: FINALITY_BATCH_BLOCKS,
      maxRows: finalityPerRun,
      budgetMs,
    });
    const at = now();
    // One match, used to choose the candidates AND rechecked by the UPDATE itself (Postgres
    // re-evaluates it on a row changed while it waited for its lock): a call another worker moved
    // meanwhile never takes finality from a stale match. Chosen with the final operation already
    // matched, so calls not final yet can never fill the per-run quota and hold back the rest.
    const match = `c.pay_kind = 'included' AND c.payment_state = 'settled' AND c.pay_final_at IS NULL
        AND o.chain_id = c.chain_id AND o.chain_id = $3
        AND o.op_key = COALESCE(c.fee_op_key, CASE WHEN c.pay_attempts > 0
          THEN 'feed-pay:pay:' || c.call_id || ':' || c.pay_attempts
          ELSE 'feed-pay:pay:' || c.call_id END)
        AND o.status = 'final' AND o.error_code IS NULL
        AND lower(o.tx_hash) = lower(c.tx_hash) AND o.block_number = c.settled_block::numeric`;
    const { rows } = await db.query<{ call_id: string }>(
      `UPDATE feed_pay_calls c
       SET pay_final_at = $1, updated_at = GREATEST($1, c.updated_at + 1)
       FROM x402_facilitator_ops o
       WHERE c.call_id IN (
           SELECT c.call_id FROM feed_pay_calls c JOIN x402_facilitator_ops o ON ${match}
           ORDER BY c.settled_at LIMIT $2)
         AND ${match}
       RETURNING c.call_id`,
      [at, finalityPerRun, CHAIN_ID],
    );
    return rows.length;
  }

  async function recover(options: { budgetMs?: number; page?: number } = {}) {
    const started = now();
    const budget = options.budgetMs ?? 45_000;
    // The batch lane: whatever waits is sent (or a crashed worker's batch continued) once a run,
    // within BATCH_FLUSH_BUDGET_SHARE of the run: past it the run goes on and the flush finishes
    // on its own (its state is durable), so a slow Base never eats the calls' turn (#221).
    if (batchWorkspacesFromEnv(env).size) {
      const f = await facilitator();
      const flush = f
        ?.flushBatches?.(
          batchAuthorize,
          true,
          started + Math.floor(budget * BATCH_FLUSH_BUDGET_SHARE),
        )
        .catch(() => log(JSON.stringify({ event: 'feed_pay.batch_flush_failed' })));
      if (flush)
        await Promise.race([
          flush,
          new Promise<void>((resolve) =>
            setTimeout(resolve, Math.floor(budget * BATCH_FLUSH_BUDGET_SHARE)).unref?.(),
          ),
        ]);
    }
    const page = options.page ?? 25;
    const result = {
      checked: 0,
      ended: 0,
      moved: 0,
      moves: 0,
      holds: 0,
      swept: 0,
      results: 0,
      quotes: 0,
      finalized: 0,
    };
    // Finality first, in bulk: the facilitator marks final every still-canonical settlement at or
    // below the finalized head (bounded), then every settled fee-included call whose operation is
    // now final records pay_final_at in one statement. Before, each call's finality waited for the
    // sweep to reach that one row, and the delivered-but-unfinal exposure (its caps) stayed full.
    result.finalized = await recordFinality(Math.floor(budget * FINALITY_BUDGET_SHARE)).catch(
      (error) => {
        logFailure('feed_pay_finality_failed', {}, error);
        return 0;
      },
    );
    // The calls checked least recently first: one that keeps waiting on Base goes to the back, so
    // it never holds up the others.
    // Page after page (each one checked least recently first) until the budget is spent or a page
    // comes back short: a large backlog of open calls (say reserved calls whose request ended) is
    // worked through within one run instead of 25 a minute. A call is taken at most once per run.
    const seen = new Set<string>();
    // A soft cutoff: no new call is started after RECOVER_CALLS_SHARE of the run, so a sustained
    // backlog leaves the float moves and sweeps that follow their turn (a call already started may
    // still run past it; review #212/#218).
    const callsBudget = Math.floor(budget * RECOVER_CALLS_SHARE);
    // Page 0 is a bounded urgent pass: at most RECOVER_URGENT_PER_RUN calls with a payment out on
    // Base (their money is held, and a lost settlement can block a whole lane: 21 Oct, 2,782
    // unchecked calls sorted ahead of one). Every later page is the fair pass, least recently
    // checked first, so the other calls keep their share however many payments are out.
    for (let pages = 0; pages < RECOVER_MAX_PAGES && now() - started <= callsBudget; pages++) {
      const urgent = pages === 0;
      const { rows } = await db.query<{ call_id: string }>(
        `SELECT call_id FROM feed_pay_calls
       WHERE (state NOT IN ('result_saved','paid_no_result','cancelled','expired','refused')
         OR payment_state IN ('signed','sent','cancelling')
         OR fee_state IN ('pending','sent') OR (fee_state = 'charged' AND NOT fee_verified)
         OR (pay_kind = 'included' AND payment_state = 'settled' AND pay_final_at IS NULL))
         AND NOT (pay_kind = 'included' AND payment_state = 'settled' AND pay_final_at IS NULL
           AND state IN ('result_saved','paid_no_result') AND fee_state = 'charged'
           AND COALESCE(fee_verified, false) AND settled_at IS NOT NULL AND settled_at > $5)
         AND lease_until < $1 AND updated_at < $2
         AND (topup_retry_at IS NULL OR topup_retry_at < $2)
         AND (pay_retry_at IS NULL OR pay_retry_at < $2)
         AND NOT (call_id = ANY($4::text[]))
         AND (NOT $6 OR payment_state IN ('signed','sent','cancelling'))
       ORDER BY checked_at, updated_at LIMIT $3`,
        [
          started,
          started - FEED_PAY_RECOVER_GRACE_MS,
          urgent ? RECOVER_URGENT_PER_RUN : page,
          [...seen],
          started - FEED_PAY_FINALITY_WAIT_MS,
          urgent,
        ],
      );
      for (const { call_id } of rows) {
        seen.add(call_id);
        if (now() - started > callsBudget) break;
        // The urgent pass gets at most RECOVER_URGENT_SHARE of the calls budget: slow Base answers
        // for payments out never take the fair pass's time.
        if (urgent && now() - started > callsBudget * RECOVER_URGENT_SHARE) break;
        const token = await claim(call_id);
        if (!token) continue;
        try {
          await db.query('UPDATE feed_pay_calls SET checked_at = $2 WHERE call_id = $1', [
            call_id,
            now(),
          ]);
          // Without the result's text: recoverCall never reads it.
          const row = await loadCall(db, call_id, { text: false });
          if (!row) continue;
          result.checked++;
          const outcome = await recoverCall(row);
          if (outcome === 'ended') result.ended++;
          if (outcome === 'moved') result.moved++;
        } catch (error) {
          // One broken row never stops the rest; it is logged (ids only).
          logFailure('feed_pay_recover_failed', { callId: call_id }, error);
        } finally {
          await release(call_id, token).catch(() => {});
        }
      }
      if (!urgent && rows.length < page) break;
    }
    if (now() - started < budget)
      result.moves = await settleMoves(page).catch((error) => {
        logFailure('feed_pay_moves_failed', {}, error);
        return 0;
      });
    if (now() - started < budget)
      result.holds = await settleFloatHolds(page).catch((error) => {
        logFailure('feed_pay_float_holds_failed', {}, error);
        return 0;
      });
    if (now() - started < budget)
      result.swept = await sweeps(page, started + budget).catch((error) => {
        logFailure('feed_pay_sweeps_failed', {}, error);
        return 0;
      });
    const at = now();
    const deleted = await db.query<{ call_id: string }>(
      `UPDATE feed_pay_calls SET result_text = NULL, result_deleted_at = $1
       WHERE call_id IN (SELECT call_id FROM feed_pay_calls
         WHERE result_text IS NOT NULL AND result_expires_at < $1 LIMIT 500)
       RETURNING call_id`,
      [at],
    );
    result.results = deleted.rows.length;
    const quotes = await db.query<{ quote_id: string }>(
      `DELETE FROM feed_pay_quotes WHERE quote_id IN (SELECT quote_id FROM feed_pay_quotes
         WHERE expires_at < $1 LIMIT 1000) RETURNING quote_id`,
      [at - 3_600_000],
    );
    result.quotes = quotes.rows.length;
    return result;
  }

  /**
   * For the sponsored first purchase (server/feed/pay/sponsored.ts): a Central City hosted service
   * exactly as call() would sell it now (the active offer, its fee-included split, the input checked
   * by its kind), without reserving, signing or paying anything. Throws call()'s own refusals.
   */
  async function hostedForSponsor(serviceId: string, inputs: FeedPayInputs) {
    const { service, reason } = await checkedService(serviceId, inputs);
    if (reason) throw refuse('not_payable', { reason });
    if (!isHosted(service)) throw refuse('service_not_found');
    const hosted = await hostedOfferOf(service);
    return {
      service,
      offerId: hosted.offerId,
      kind: hosted.kind.name,
      version: hosted.version,
      payTo: hosted.payTo,
      split: hosted.split,
      input: offerInputOf(hosted, inputs),
    };
  }

  /** Runs a hosted offer's kind on a checked input (the delivery of a sponsored purchase). */
  async function runHostedOffer(
    offer: { offerId: string; kind: string; version: number },
    input: string,
  ) {
    return runOffer({
      requirements: {
        accepted: {},
        resource: null,
        included: { offerId: offer.offerId, kind: offer.kind, version: offer.version },
      },
      request_body: input,
    } as unknown as CallRow);
  }

  return {
    quote,
    call,
    callFor,
    waitFor,
    agents,
    setPerCallMax,
    history,
    recover,
    hostedForSponsor,
    runHostedOffer,
  };
}

export type FeedPayEngine = ReturnType<typeof createFeedPayEngine>;

/** Thrown inside the reservation when the wallet's balance must be read first (outside it). */
class NeedWalletRead extends Error {}

/**
 * How much one float top-up moves (section 8), or why it can't be made. At least what the call
 * needs; beyond that towards a float of DEFAULT_FLOAT_RAW in all (the call's amount included),
 * but never more than a quarter of what the Base allowance leaves after the call: Base counts a
 * top-up as spent for the whole period (a sweep returns the USDC, not the allowance), and agent
 * Pay uses the same allowance. Never more than the wallet has or the calendar cap still allows.
 */
export function floatTopUp(input: {
  amount: bigint;
  /** The spender's USDC not held by live authorizations. */
  floatFree: bigint;
  /** What the owner's limit still allows on Base in this period. */
  allowanceLeft: bigint;
  /** The agent wallet's USDC not held for its payments. */
  walletFree: bigint;
  /** What the Berlin calendar cap still allows (this call already counted), null without one. */
  calendar: bigint | null;
  /** The pot target (default DEFAULT_FLOAT_RAW). */
  target?: bigint;
  /**
   * The scoped rules (FEE_ROUTER_2.md D1/D3): fill to max(target, call) in one operation, clamped
   * by the ceilings, without the quarter-of-allowance share.
   */
  scoped?: boolean;
}): bigint | 'insufficient_funds' | 'over_limit' {
  const { amount, floatFree } = input;
  const need = max(amount - floatFree, 1n);
  if (need > input.walletFree) return 'insufficient_funds';
  let upper = min(input.allowanceLeft, input.walletFree);
  // The float never holds more than the owner may still spend in this period.
  if (input.calendar !== null) upper = min(upper, max(input.calendar + amount - floatFree, 0n));
  if (need > upper) return 'over_limit';
  if (input.scoped) {
    const fill = max(input.target ?? BigInt(DEFAULT_FLOAT_RAW), amount) - floatFree;
    return min(max(fill, need), upper);
  }
  const target = max(BigInt(DEFAULT_FLOAT_RAW), amount) - floatFree;
  const share = (input.allowanceLeft - need) / 4n;
  const extra = min(min(target - need, share), upper - need);
  return need + max(extra, 0n);
}

/** A result as stored: text for JSON and text answers, size and type only for files. */
export function resultOf(
  answer: {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
    truncated: boolean;
  },
  receivedAt: number,
): FeedPayResult {
  const raw = answer.headers['content-type'];
  // The service's own text, shown to people and AIs: printable ASCII only, at most 200 characters.
  const contentType = raw
    ? raw
        .replace(/[^\x20-\x7e]/g, '')
        .trim()
        .slice(0, 200) || null
    : null;
  const type = (contentType ?? '').toLowerCase();
  if (!answer.body.length)
    return {
      origin: 'external',
      status: answer.status,
      contentType,
      format: 'empty',
      text: null,
      bytes: 0,
      truncated: answer.truncated,
      receivedAt,
    };
  const json = /^application\/([a-z.+-]*\+)?json\b/.test(type);
  const textual =
    json ||
    type.startsWith('text/') ||
    /^application\/(xml|javascript|x-www-form-urlencoded)\b/.test(type) ||
    type === '';
  let text: string | null = null;
  if (textual) {
    try {
      // A cut answer may end inside a character: decode leniently, then check it is text.
      text = new TextDecoder('utf-8', { fatal: !answer.truncated }).decode(answer.body);
    } catch {
      text = null;
    }
    if (text !== null && text.includes('\u0000')) text = null;
  }
  return {
    origin: 'external',
    status: answer.status,
    contentType,
    format: text === null ? 'binary' : json ? 'json' : 'text',
    text,
    bytes: answer.body.length,
    truncated: answer.truncated,
    receivedAt,
  };
}

/** USDC decimal text of a raw amount (MCP details). */
export const usdcText = (raw: string | bigint) =>
  rawToUsdc(typeof raw === 'bigint' ? raw.toString(10) : raw);
