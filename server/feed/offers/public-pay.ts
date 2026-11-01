/*
 * The paid side of an offer's public address (public-route.ts), stage 2 of 3, behind
 * CITY_X402_PUBLIC_OFFERS_SETTLE. A buyer outside Central City signs both router 3 legs itself
 * (scheme cc-router3-split-v1, docs/FEED_PAY.md section 19); this lane's own EOA sends them.
 *
 * The 402 is stateless: its terms are bound by an HMAC (`tag`) under a key derived from the server
 * secret, so nothing is stored for a request that never pays. A payment is checked in this order,
 * nothing stored before the last check: the tag, the offer read again, the nonces (router3Nonce),
 * the lane's readiness, the payer (one call in flight, no cool-down after a revert), the signatures
 * off-chain where the payer has no code, settle simulated, the gas and L1 fee caps, screening
 * (router3PreSign; off refuses, unlike the engine, as publicSettleScreening), the budget.
 *
 * The budget: every attempt costs its payer and calling address, who alone can make it end unpaid.
 * The seller's and the overall daily caps count paid calls only: they are read at the check and
 * taken when a call is paid, so a call that ends unpaid can never shut a seller or the route.
 *
 * States: reserved (row stored) → ran (the kind answered, the result stored and not shown) → sent
 * (handed to the facilitator) → paid (included, exactly one matching FeeCharged; or our transaction
 * reverted and Base shows this call's FeeCharged from another) → delivered (the result may be read).
 * paid_no_result: paid with no stored result. failed: nothing was sent, or Base shows the legs can
 * no longer move money; the one exception is failure_code legs_used_elsewhere.
 * unmatched: a finalized successful settle without exactly this call's FeeCharged, or (failure_code
 * not_followed) a call that could not be followed to its end by its time limit, as after its sender
 * key was rotated or removed: an ALERT, not counted as paid, no result released, for someone to look
 * at.
 * A kind that fails sends nothing. Nothing here signs for the payer or ever re-signs a purchase.
 *
 * Every step is resumable by the worker (GET /api/cron/x402-offer-work), which holds the row's lease
 * as the sponsored path does. A window that ends before the hand-over fences the key at the
 * facilitator first (endUnsent), so a stored pair can never go out after the row says failed.
 *
 * Paused (feed_flags row PUBLIC_OFFER_FLAG, enabled false; no redeploy): no new 402 or payment, and
 * nothing open runs its kind or goes out; a call already on Base is still followed. Calls wait, and
 * end by their window if the pause outlasts it, also one that starts inside the facilitator's check
 * right before the first send (handOver).
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAddress, keccak256, recoverTypedDataAddress, stringToHex, type Hex } from 'viem';
import { z } from 'zod';
import type { Database } from '../../database.js';
import type { FeedPayOp } from '../../base/chain/feed-pay-chain.js';
import type { FeedPayJson } from '../../../shared/feed-pay.js';
import { baseNetwork } from '../../../shared/base/chains.js';
import { usdcOf } from '../../../shared/chains.js';
import { protocolTreasuryFor } from '../../protocol/fees/cron.js';
import { feeEventsOf, feeFor, feeRef } from '../../protocol/fees/fee-call.js';
import { BroadcastDeferred } from '../../protocol/x402/facilitator.js';
import { FeedPayRefusal } from '../pay/engine.js';
import { PUBLIC_CALL_KEY_PREFIX } from '../pay/public-calls-schema.js';
import { payerCooldown, sweepPayerCooldowns } from '../../protocol/x402/payer-cooldown.js';
import {
  feeRouter3Live,
  LEG_FEE,
  LEG_SELLER,
  MIN_INCLUDED_ROUTER3,
  router3AddressFromEnv,
  router3Nonce,
  ROUTER3_VALIDITY_S,
  router3SettleData,
  type Router3Settlement,
} from '../pay/router3.js';

export const PUBLIC_OFFER_SCHEME = 'cc-router3-split-v1';
/** The most one outside call may cost: 10 USDC in base units. */
export const PUBLIC_OFFER_MAX_RAW = 10_000_000n;
export const PUBLIC_OFFER_SETTLE_SETTING = 'CITY_X402_PUBLIC_OFFERS_SETTLE';
export const publicOfferSettleOn = (env: Record<string, string | undefined>) =>
  env[PUBLIC_OFFER_SETTLE_SETTING] === '1';
/** The runtime pause: a feed_flags row, as the public settle's 'x402-settle' (public-settle.ts). */
export const PUBLIC_OFFER_FLAG = 'x402-offer-settle';

/** Below this ETH the lane asks buyers to retry before they sign (0.02 ETH). */
export const PUBLIC_OFFER_MIN_ETH_WEI = 20_000_000_000_000_000n;
/** Base's finalized head further behind its latest than this asks buyers to retry (seconds). */
export const PUBLIC_OFFER_MAX_FINALITY_LAG_S = 3_600;
/** How long one readiness answer is kept per instance: anonymous requests never cost a read each. */
export const PUBLIC_OFFER_READY_TTL_MS = 15_000;
/** A new payment must leave at least this long before validBefore (seconds). */
export const PUBLIC_OFFER_MIN_PAY_WINDOW_S = 120;
/** Nothing is handed over or broadcast with less than this left (seconds). */
export const PUBLIC_OFFER_SEND_MARGIN_S = 30;
/**
 * Calls open at once per calling address and per payer. One per payer, as the public facilitator's
 * payerBusy (public-settle.ts): a simulation holds nothing of the payer's balance, so N calls from
 * one balance would all pass and all but one revert on Base at our gas cost.
 */
export const PUBLIC_OFFER_OPEN_PER_CLIENT = 10;
export const PUBLIC_OFFER_OPEN_PER_PAYER = 1;
/**
 * How long a payer whose settle reverted on Base gets no new call, as REVERT_COOLDOWN_MS: an hour
 * after the revert, a row of its own (server/protocol/x402/payer-cooldown.ts).
 */
export const PUBLIC_OFFER_REVERT_COOLDOWN_MS = 3_600_000;
/** An open call not followed to its end this long after validBefore ends, for review (seconds). */
export const PUBLIC_OFFER_STRANDED_AFTER_S = 6 * 3_600;
/** Reads of the check right before the first send: a passing failure is not the call's end. */
const BROADCAST_CHECK_TRIES = 3;
/** Input, result, signatures and the client key of an ended call are kept this long. */
export const PUBLIC_OFFER_RETENTION_MS = 24 * 3_600_000;
export const PUBLIC_OFFER_SWEEP_MAX = 500;
/** A request waits this long for its call before it answers 202 (the worker carries on). */
export const PUBLIC_OFFER_WAIT_MS = 20_000;
const LEASE_MS = 60_000;
const WORK_PARALLEL = 4;
const POLL_MS = 500;
const POLLS = 30;
/** The budget caps and the simulation cap, as the public facilitator's (public-settle.ts). */
export const PUBLIC_OFFER_DAILY = 500;
export const PUBLIC_OFFER_PER_PAYER_HOUR = 20;
export const PUBLIC_OFFER_PER_PAYEE_DAY = 100;
export const PUBLIC_OFFER_PER_CLIENT_DAY = 100;
export const PUBLIC_OFFER_SIMULATIONS_PER_MINUTE = 120;
export const PUBLIC_OFFER_SIMULATIONS_PER_SELLER_MINUTE = 30;
/** One address's own share of the shared cap, so that it takes many to use it up. */
export const PUBLIC_OFFER_SIMULATIONS_PER_CLIENT_MINUTE = 10;
/** ERC-1271 signatures can be long; this keeps a stranger's calldata (and its L1 fee) bounded. */
const MAX_SIGNATURE_HEX = 5_002;

type LogEntry = { address: Hex; topics: readonly Hex[]; data: Hex };
export type PublicLegsState = 'unused' | 'used' | 'wait';
/** A FeeCharged log found on Base, with the transaction that left it. */
export type PublicFeeLog = LogEntry & { txHash: Hex; blockNumber: bigint };

/** The lane's chain side (runtime.ts publicOfferLane): its own EOA and nonce lane, target router 3. */
export interface PublicOfferLane {
  address(): Promise<Hex>;
  canPay(): Promise<boolean>;
  ethBalance(): Promise<bigint>;
  /** How far Base's finalized head is behind its latest (seconds); may throw. */
  finalityLagSeconds(): Promise<number>;
  /** settle simulated from the EOA; retryable: Base could not answer, nothing was decided. */
  simulate(data: Hex): Promise<{ ok: true; gas: bigint } | { ok: false; retryable: boolean }>;
  /**
   * Whether a settle of this gas would stay within the facilitator's gas and L1 fee caps, which end
   * it never sent otherwise (firstSend stays the guard at the send itself). May throw.
   */
  withinCaps(data: Hex, gas: bigint): Promise<boolean>;
  /** Whether the address has code on Base (a contract signs by ERC-1271). May throw. */
  hasCode(address: Hex): Promise<boolean>;
  /** The address's USDC on Base at the latest block. May throw. */
  usdcBalance(address: Hex): Promise<bigint>;
  submit(input: {
    key: string;
    intentHash: Hex;
    settlement: Router3Settlement;
    beforeBroadcast: () => Promise<void>;
  }): Promise<FeedPayOp>;
  status(key: string): Promise<FeedPayOp | null>;
  endUnsent(key: string, intentHash: Hex): Promise<boolean>;
  /**
   * 'unused': past validBefore at Base's safe block and every nonce unused there. 'used': a nonce is
   * used at the safe block. 'wait': neither is known yet, a read error too.
   */
  legsState(payer: Hex, nonces: Hex[], validBefore: number): Promise<PublicLegsState>;
  /** The logs of a successful transaction, null when unreadable. */
  receiptLogs(txHash: Hex): Promise<readonly LogEntry[] | null>;
  /**
   * Router 3's FeeCharged logs of this payer, payee and ref up to Base's safe block, over the blocks
   * of the legs' window; null when unreadable.
   */
  feeLogs(input: {
    payer: Hex;
    payee: Hex;
    ref: Hex;
    validAfter: number;
    validBefore: number;
  }): Promise<readonly PublicFeeLog[] | null>;
}

/** The offer as a sale would see it now (the engine's hostedForSponsor). */
export interface PublicHostedOffer {
  offerId: string;
  kind: string;
  version: number;
  payTo: string;
  split: { gross: bigint; fee: bigint; net: bigint };
  input: string;
}

export interface PublicOfferPayDeps {
  db: Database;
  env: Record<string, string | undefined>;
  now: () => number;
  chainId: number;
  /** The server secret the challenge key is derived from; unset: closed. */
  secret: () => string | undefined;
  /** Null while CITY_X402_PUBLIC_OFFER_KEY_REF is unset or refused: closed. */
  lane: () => Promise<PublicOfferLane | null>;
  hosted: {
    forSponsor(serviceId: string, inputs: { body?: FeedPayJson }): Promise<PublicHostedOffer>;
    run(
      offer: { offerId: string; kind: string; version: number },
      input: string,
    ): Promise<
      | { ok: true; text: string; mime: string; format: 'json' | 'text' }
      | { ok: false; failure: string }
    >;
  };
  /** The engine's router3PreSign. Null: clear; 'hold': ask again later; else refused. */
  preSign: (input: {
    intentId: string;
    payer: string;
    payee: string;
    grossRaw: bigint;
    feeRaw: bigint;
  }) => Promise<string | null>;
  /** The runtime pause, read every time; a failed read is paused (publicSettlePaused). */
  paused: () => Promise<boolean>;
  /** False (CITY_PROTOCOL_SCREENING=0): nothing is accepted here, unlike the engine. */
  screeningOn: () => boolean;
  /** The payer's cool-down after a revert on Base; a throw on `cooling` refuses. */
  cooldown: { record(payer: Hex): Promise<void>; cooling(payer: Hex): Promise<boolean> };
  /** One new payment from the gas budget, over the fail-closed 'x402-offer-pay' prefix. */
  budget: (payer: Hex, scope: { payee: Hex; client: string }) => Promise<boolean>;
  /** A call was paid: takes its unit of the seller's and the overall daily caps. */
  paidBudget: (payee: Hex) => Promise<void>;
  /** The shared cap on chain simulations, same prefix. */
  simulations: () => Promise<boolean>;
  /** One calling address's share of the simulations, taken before any chain read. */
  clientSimulations: (client: string) => Promise<boolean>;
  /** One seller's share of the shared cap, so payers of one seller can't starve the others. */
  sellerSimulations: (seller: Hex) => Promise<boolean>;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
}

/** What the route sends. */
export interface PublicAnswer {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: { mime: string; body: string };
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const SIGNATURE = new RegExp(`^0x[0-9a-fA-F]{130,${MAX_SIGNATURE_HEX - 2}}$`);
const CALL_ID = /^xp_[a-z2-7]{20}$/;

const legSchema = z
  .object({
    from: z.string().regex(ADDRESS),
    to: z.string().regex(ADDRESS),
    value: z.string().regex(UINT),
    validAfter: z.string().regex(UINT),
    validBefore: z.string().regex(UINT),
    nonce: z.string().regex(HEX32),
    signature: z.string().regex(SIGNATURE),
  })
  .strict();
const acceptedSchema = z.object({
  scheme: z.literal(PUBLIC_OFFER_SCHEME),
  network: z.string().max(40),
  amount: z.string().regex(UINT),
  payTo: z.string().regex(ADDRESS),
  extra: z.object({
    router: z.string().regex(ADDRESS),
    treasury: z.string().regex(ADDRESS),
    sellerAmount: z.string().regex(UINT),
    feeAmount: z.string().regex(UINT),
    ref: z.string().regex(HEX32),
    validAfter: z.string().regex(UINT),
    validBefore: z.string().regex(UINT),
    callId: z.string().regex(CALL_ID),
    kind: z.string().min(1).max(64),
    offerVersion: z.number().int().nonnegative(),
    inputHash: z.string().regex(HEX32),
    tag: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});
const paymentSchema = z.object({
  x402Version: z.union([z.literal(1), z.literal(2)]),
  accepted: acceptedSchema,
  payload: z
    .object({ payer: z.string().regex(ADDRESS), seller: legSchema, fee: legSchema })
    .strict(),
});
export type PublicPayment = z.infer<typeof paymentSchema>;

/** The payment a request carries: 'absent', 'invalid' (two different ones too), or the payment. */
export function publicPaymentOf(
  headers: Record<string, string | string[] | undefined>,
): { kind: 'absent' } | { kind: 'invalid' } | { kind: 'ok'; payment: PublicPayment; v1: boolean } {
  const v2 = headers['payment-signature'];
  const v1 = headers['x-payment'];
  if (!v2 && !v1) return { kind: 'absent' };
  if (Array.isArray(v2) || Array.isArray(v1) || (v2 && v1 && v2 !== v1)) return { kind: 'invalid' };
  try {
    const parsed = paymentSchema.safeParse(
      JSON.parse(Buffer.from((v2 ?? v1)!, 'base64').toString('utf8')),
    );
    return parsed.success ? { kind: 'ok', payment: parsed.data, v1: !v2 } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

/** The terms a tag binds: everything the buyer signs or is sold, and the call they belong to. */
export interface PublicTerms {
  chainId: number;
  router: string;
  treasury: string;
  callId: string;
  offerId: string;
  kind: string;
  version: number;
  payTo: string;
  gross: string;
  fee: string;
  net: string;
  ref: string;
  inputHash: string;
  validAfter: string;
  validBefore: string;
}

export function publicTermsTag(key: Buffer, terms: PublicTerms): string {
  return createHmac('sha256', key)
    .update(
      JSON.stringify([
        PUBLIC_OFFER_SCHEME,
        terms.chainId,
        terms.router.toLowerCase(),
        terms.treasury.toLowerCase(),
        terms.callId,
        terms.offerId,
        terms.kind,
        terms.version,
        terms.payTo.toLowerCase(),
        terms.gross,
        terms.fee,
        terms.net,
        terms.ref.toLowerCase(),
        terms.inputHash.toLowerCase(),
        terms.validAfter,
        terms.validBefore,
      ]),
    )
    .digest('hex');
}

/** The challenge key: its own HKDF label under the server secret (never the secret itself). */
export const publicChallengeKey = (secret: string) =>
  Buffer.from(hkdfSync('sha256', secret, '', 'central-city/x402-public-offer-challenge/v1', 32));

/** The address key as stored: keyed, so the table never holds a caller's IP address. */
const storedClientKey = (key: Buffer, client: string) =>
  createHmac('sha256', key).update(`client:${client}`).digest('hex');

const sameTag = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const newCallId = () => {
  let out = '';
  for (const byte of randomBytes(20)) out += BASE32[byte & 31];
  return `xp_${out}`;
};

const inputHashOf = (input: string): Hex => keccak256(stringToHex(input));

type State =
  'reserved' | 'ran' | 'sent' | 'paid' | 'delivered' | 'paid_no_result' | 'failed' | 'unmatched';

interface Row {
  call_id: string;
  payer: string;
  ref: string;
  offer_id: string;
  offer_kind: string;
  offer_version: number;
  pay_to: string;
  gross_raw: string;
  fee_raw: string;
  input: string | null;
  state: State;
  failure_code: string | null;
  op_key: string;
  valid_after: string;
  valid_before: string;
  seller_signature: string | null;
  fee_signature: string | null;
  tx_hash: string | null;
  result_text: string | null;
  result_mime: string | null;
  result_format: string | null;
  updated_at: string;
}

const COLUMNS = `call_id, payer, ref, offer_id, offer_kind, offer_version, pay_to,
  gross_raw::text AS gross_raw, fee_raw::text AS fee_raw, input, state, failure_code, op_key,
  valid_after::text AS valid_after, valid_before::text AS valid_before, seller_signature,
  fee_signature, tx_hash, result_text, result_mime, result_format, updated_at::text AS updated_at`;

const NO_STORE = { 'Cache-Control': 'no-store' };
const refused = (
  status: number,
  code: string,
  error: string,
  extra: object = {},
): PublicAnswer => ({
  status,
  headers: NO_STORE,
  json: { error, code, ...extra },
});
const retryLater = (seconds: number): PublicAnswer => ({
  status: 503,
  headers: { ...NO_STORE, 'Retry-After': String(seconds) },
  json: { error: 'Not available right now. Nothing was charged.', retryable: true },
});

export function createPublicOfferPay(deps: PublicOfferPayDeps) {
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const nowS = () => Math.floor(deps.now() / 1000);
  const router = () => router3AddressFromEnv(deps.env);
  const treasury = () => protocolTreasuryFor(deps.env, deps.chainId);
  const key = () => {
    const secret = deps.secret();
    return secret ? publicChallengeKey(secret) : null;
  };

  const load = async (callId: string) =>
    (
      await deps.db.query<Row>(`SELECT ${COLUMNS} FROM feed_pay_public_calls WHERE call_id = $1`, [
        callId,
      ])
    ).rows[0] ?? null;

  /** Compare-and-set on updated_at. The sweep never touches updated_at: it is the paid time. */
  const move = async (row: Row, set: Record<string, unknown>): Promise<boolean> => {
    const keys = Object.keys(set);
    const { rows } = await deps.db.query(
      `UPDATE feed_pay_public_calls SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')},
         updated_at = $${keys.length + 3}
       WHERE call_id = $1 AND updated_at = $2 RETURNING call_id`,
      [
        row.call_id,
        row.updated_at,
        ...Object.values(set),
        Math.max(deps.now(), Number(row.updated_at) + 1),
      ],
    );
    return rows.length > 0;
  };

  const fail = async (row: Row, code: string, set: Record<string, unknown> = {}) => {
    const moved = await move(row, {
      state: 'failed',
      failure_code: code,
      seller_signature: null,
      fee_signature: null,
      result_text: null,
      ...set,
    });
    if (moved) log(JSON.stringify({ event: 'x402_offer.call_failed', callId: row.call_id, code }));
    return moved;
  };

  // ---- Readiness -----------------------------------------------------------------------------

  let readyKept: { at: number; value: boolean } | null = null;
  let readyPending: Promise<boolean> | null = null;
  const readNow = async (): Promise<boolean> => {
    if (!feeRouter3Live(deps.env) || !router() || !treasury() || !key()) return false;
    const lane = await deps.lane().catch(() => null);
    if (!lane) return false;
    try {
      if (!(await lane.canPay())) return false;
      if ((await lane.ethBalance()) < PUBLIC_OFFER_MIN_ETH_WEI) return false;
      return (await lane.finalityLagSeconds()) <= PUBLIC_OFFER_MAX_FINALITY_LAG_S;
    } catch {
      return false;
    }
  };
  /** Whether anyone should sign now: never a fallback to another router, retried by the buyer. */
  const ready = async (): Promise<boolean> => {
    const at = deps.now();
    if (readyKept && at - readyKept.at < PUBLIC_OFFER_READY_TTL_MS) return readyKept.value;
    readyPending ??= readNow().finally(() => {
      readyPending = null;
    });
    const value = await readyPending;
    readyKept = { at, value };
    return value;
  };

  // ---- The challenge -------------------------------------------------------------------------

  /** The offer can be settled here at all (router 3's lower bound, its fixed tenth). */
  const settleable = (offer: PublicHostedOffer) =>
    offer.split.gross >= MIN_INCLUDED_ROUTER3 &&
    offer.split.gross <= PUBLIC_OFFER_MAX_RAW &&
    offer.split.fee === feeFor(offer.split.gross) &&
    offer.split.net === offer.split.gross - offer.split.fee;

  /** The 402's `accepts` entry, tag included; null while closed. Stores nothing. */
  function acceptsEntry(offerId: string, offer: PublicHostedOffer) {
    const r = router();
    const t = treasury();
    const k = key();
    const network = baseNetwork(deps.chainId, deps.env);
    const domain = usdcOf(deps.chainId)?.eip712;
    if (!r || !t || !k || !network || !domain) return null;
    const callId = newCallId();
    const ref = feeRef(callId);
    const at = nowS();
    const terms: PublicTerms = {
      chainId: deps.chainId,
      router: r,
      treasury: t,
      callId,
      offerId,
      kind: offer.kind,
      version: offer.version,
      payTo: offer.payTo,
      gross: offer.split.gross.toString(),
      fee: offer.split.fee.toString(),
      net: offer.split.net.toString(),
      ref,
      inputHash: inputHashOf(offer.input),
      validAfter: String(at - 60),
      validBefore: String(at + ROUTER3_VALIDITY_S),
    };
    return {
      scheme: PUBLIC_OFFER_SCHEME,
      network: `eip155:${deps.chainId}`,
      asset: getAddress(network.tokens.USDC.address),
      amount: terms.gross,
      payTo: getAddress(offer.payTo),
      maxTimeoutSeconds: ROUTER3_VALIDITY_S,
      extra: {
        name: domain.name,
        version: domain.version,
        assetTransferMethod: 'eip3009',
        router: r,
        treasury: getAddress(t),
        sellerAmount: terms.net,
        feeAmount: terms.fee,
        ref,
        validAfter: terms.validAfter,
        validBefore: terms.validBefore,
        callId,
        kind: offer.kind,
        offerVersion: offer.version,
        inputHash: terms.inputHash,
        tag: publicTermsTag(k, terms),
      },
    };
  }

  // ---- The worker's steps --------------------------------------------------------------------

  const settlementOf = (row: Row): Router3Settlement | null =>
    row.seller_signature && row.fee_signature
      ? {
          payer: getAddress(row.payer) as Hex,
          payee: getAddress(row.pay_to) as Hex,
          gross: BigInt(row.gross_raw),
          ref: row.ref as Hex,
          validAfter: BigInt(row.valid_after),
          validBefore: BigInt(row.valid_before),
          sellerSignature: row.seller_signature as Hex,
          feeSignature: row.fee_signature as Hex,
        }
      : null;
  const intentOf = (row: Row): Hex =>
    keccak256(stringToHex(`${row.op_key}:${row.pay_to}:${row.gross_raw}:${row.ref}`));
  const windowOpen = (row: Row) => nowS() < Number(row.valid_before) - PUBLIC_OFFER_SEND_MARGIN_S;

  /** A row not handed over and not to be: followed if the key is stored, else fenced, then failed. */
  async function endUnhanded(row: Row, code: string): Promise<boolean> {
    const lane = await deps.lane().catch(() => null);
    if (!lane) return false;
    const op = await lane.status(row.op_key).catch(() => undefined);
    if (op === undefined) return false;
    if (op !== null) return move(row, { state: 'sent' });
    if (!(await lane.endUnsent(row.op_key, intentOf(row)).catch(() => false))) return false;
    return fail(row, code);
  }

  async function runKind(row: Row): Promise<boolean> {
    if (!publicOfferSettleOn(deps.env)) return endUnhanded(row, 'settle_off');
    if (!windowOpen(row)) return endUnhanded(row, 'window_expired');
    if (await deps.paused()) return false;
    if (row.input === null) return endUnhanded(row, 'no_input');
    const outcome = await deps.hosted.run(
      { offerId: row.offer_id, kind: row.offer_kind, version: row.offer_version },
      row.input,
    );
    const current = await load(row.call_id);
    if (!current || current.state !== 'reserved') return false;
    // A failed kind sends nothing: the row ends here, the stored legs are dropped.
    if (!outcome.ok) return endUnhanded(current, 'kind_failed');
    return move(current, {
      state: 'ran',
      result_text: outcome.text,
      result_mime: outcome.mime,
      result_format: outcome.format,
    });
  }

  /** The offer still sells exactly what this row was reserved for. Throws on a read error. */
  async function offerUnchanged(row: Row): Promise<boolean> {
    const offer = (
      await deps.db.query<{
        kind: string;
        version: number;
        pay_to: string;
        price: string;
        state: string;
      }>(
        `SELECT kind, version, pay_to, price_raw::text AS price, state FROM city_offers
         WHERE offer_id = $1`,
        [row.offer_id],
      )
    ).rows[0];
    return (
      !!offer &&
      offer.state === 'active' &&
      offer.kind === row.offer_kind &&
      Number(offer.version) === Number(row.offer_version) &&
      offer.pay_to.toLowerCase() === row.pay_to &&
      BigInt(offer.price) === BigInt(row.gross_raw)
    );
  }

  /** Hands the stored pair over: stored once per key, so a repeat continues the same settlement. */
  async function handOver(row: Row): Promise<FeedPayOp | null> {
    const lane = await deps.lane().catch(() => null);
    const settlement = settlementOf(row);
    if (!lane || !settlement) return null;
    const data = router3SettleData(settlement);
    return lane.submit({
      key: row.op_key,
      intentHash: intentOf(row),
      settlement,
      // Right before the first send: settle simulated again. A throw ends it failed, never sent, so
      // only what can't change throws plainly. A read that fails or a pause is asked again a few
      // times, then put off: the row stays queued and unsigned, this call keeps its stored result,
      // and the worker asks again until the window ends it (send, follow).
      beforeBroadcast: async () => {
        for (let tries = 1; ; tries++) {
          if (!publicOfferSettleOn(deps.env)) throw new Error('settle_off');
          if (!windowOpen(row)) throw new Error('window_expired');
          const paused = await deps.paused().catch(() => true);
          const again = paused
            ? null
            : await lane.simulate(data).catch(() => ({ ok: false, retryable: true }) as const);
          if (again?.ok) return;
          if (again && !again.retryable) throw new Error('simulation_refused');
          if (tries >= BROADCAST_CHECK_TRIES)
            throw new BroadcastDeferred(paused ? 'paused' : 'simulation_unavailable');
          await sleep(POLL_MS);
        }
      },
    });
  }

  async function send(row: Row): Promise<boolean> {
    if (!publicOfferSettleOn(deps.env)) return endUnhanded(row, 'settle_off');
    if (!windowOpen(row)) return endUnhanded(row, 'window_expired');
    if (await deps.paused()) return false;
    if (!(await offerUnchanged(row))) return endUnhanded(row, 'offer_changed');
    if (!settlementOf(row)) return endUnhanded(row, 'no_legs');
    const op = await handOver(row);
    if (!op) return false;
    return move(row, { state: 'sent' });
  }

  /** Exactly one FeeCharged in these logs, and it is this call's in every field. */
  const oneFeeOfCall = (row: Row, r: Hex, logs: readonly LogEntry[]) => {
    const events = feeEventsOf(deps.chainId, r, logs);
    const e = events[0];
    return (
      events.length === 1 &&
      !!e &&
      e.payer.toLowerCase() === row.payer &&
      e.payee.toLowerCase() === row.pay_to &&
      e.ref.toLowerCase() === row.ref.toLowerCase() &&
      e.gross === BigInt(row.gross_raw) &&
      e.fee === BigInt(row.fee_raw)
    );
  };

  /** Exactly this call's one FeeCharged in the receipt; null when unreadable. */
  async function feeMatched(row: Row, lane: PublicOfferLane, txHash: Hex): Promise<boolean | null> {
    const r = router();
    if (!r) return null;
    const logs = await lane.receiptLogs(txHash).catch(() => null);
    return logs ? oneFeeOfCall(row, r, logs) : null;
  }

  /** Base shows the money moved for this call: the row is paid, then the result may be read. */
  async function markPaid(row: Row, txHash: Hex, block: bigint | null): Promise<boolean> {
    if (
      !(await move(row, {
        state: 'paid',
        tx_hash: txHash,
        block_number: block === null ? null : block.toString(10),
      }))
    )
      return false;
    await deps.paidBudget(getAddress(row.pay_to) as Hex).catch(() => {
      log(JSON.stringify({ event: 'x402_offer.paid_budget_failed', callId: row.call_id }));
    });
    const paid = await load(row.call_id);
    return paid ? deliver(paid) : true;
  }

  /**
   * Our transaction reverted and a leg was used: someone else's transaction may have settled this
   * very call. Router 3 allows one settle per (payer, ref), so its FeeCharged in every field is the
   * buyer's money paid for this call. Undefined: unreadable, asked again.
   */
  async function settledElsewhere(
    row: Row,
    lane: PublicOfferLane,
  ): Promise<PublicFeeLog | null | undefined> {
    const r = router();
    if (!r) return undefined;
    const logs = await lane
      .feeLogs({
        payer: getAddress(row.payer) as Hex,
        payee: getAddress(row.pay_to) as Hex,
        ref: row.ref as Hex,
        validAfter: Number(row.valid_after),
        validBefore: Number(row.valid_before),
      })
      .catch(() => null);
    if (!logs) return undefined;
    return logs.length === 1 && oneFeeOfCall(row, r, logs) ? logs[0]! : null;
  }

  const legNonces = (row: Row): Hex[] | null => {
    const r = router();
    const t = treasury();
    if (!r || !t) return null;
    const of = (leg: typeof LEG_SELLER | typeof LEG_FEE) =>
      router3Nonce({
        chainId: deps.chainId,
        router: r,
        treasury: getAddress(t) as Hex,
        payer: getAddress(row.payer) as Hex,
        payee: getAddress(row.pay_to) as Hex,
        gross: BigInt(row.gross_raw),
        ref: row.ref as Hex,
        validAfter: BigInt(row.valid_after),
        validBefore: BigInt(row.valid_before),
        leg,
      });
    return [of(LEG_SELLER), of(LEG_FEE)];
  };

  async function follow(row: Row): Promise<boolean> {
    const lane = await deps.lane().catch(() => null);
    if (!lane) return false;
    const op = await lane.status(row.op_key).catch(() => undefined);
    if (op === undefined) return false;
    // Recorded as sent but unknown, or stored and never sent: the same stored pair, same key.
    if (op === null || (op.status === 'queued' && !op.txHash)) {
      if (!windowOpen(row)) {
        if (!(await lane.endUnsent(row.op_key, intentOf(row)).catch(() => false))) return false;
        return fail(row, 'window_expired');
      }
      if (await deps.paused()) return false;
      await handOver(row);
      return false;
    }
    if ((op.status === 'included' || op.status === 'final') && !op.errorCode) {
      if (!op.txHash) return false;
      const matched = await feeMatched(row, lane, op.txHash);
      if (matched === null) return false;
      if (!matched) {
        // A successful settle without exactly this event must not be called paid or unpaid. A block
        // can still be dropped until it is final; from then it ends here, for someone to look at.
        if (op.status !== 'final') return false;
        const ended = await move(row, {
          state: 'unmatched',
          failure_code: 'fee_unmatched',
          tx_hash: op.txHash,
          block_number: op.blockNumber === null ? null : op.blockNumber.toString(10),
          seller_signature: null,
          fee_signature: null,
        });
        if (ended)
          log(
            JSON.stringify({
              event: 'x402_offer.fee_mismatch',
              level: 'ALERT',
              callId: row.call_id,
              txHash: op.txHash,
            }),
          );
        return ended;
      }
      return markPaid(row, op.txHash, op.blockNumber);
    }
    const failedForGood =
      op.neverSent || op.status === 'failed' || (op.status === 'final' && !!op.errorCode);
    if (!failedForGood) return false;
    if (op.neverSent) return fail(row, op.errorCode ?? 'not_sent', { tx_hash: op.txHash });
    // Broadcast and failed: a late receipt can still turn it, and anyone holding the legs could
    // send them until validBefore. Only Base at a safe block past the window ends it.
    const nonces = legNonces(row);
    if (!nonces) return false;
    const legs = await lane
      .legsState(getAddress(row.payer) as Hex, nonces, Number(row.valid_before))
      .catch(() => 'wait' as const);
    if (legs === 'wait') return false;
    if (legs === 'used') {
      const elsewhere = await settledElsewhere(row, lane);
      if (elsewhere === undefined) return false;
      if (elsewhere) {
        log(JSON.stringify({ event: 'x402_offer.settled_elsewhere', callId: row.call_id }));
        return markPaid(row, elsewhere.txHash, elsewhere.blockNumber);
      }
      log(JSON.stringify({ event: 'x402_offer.legs_used', level: 'ALERT', callId: row.call_id }));
    }
    // A revert that cost our gas and paid nobody: the payer waits, whoever sent the legs. Taken only
    // now: until this row ends the payer has a call in flight anyway, and a front-run paid call
    // must not put an innocent buyer on the cool-down.
    if (op.errorCode === 'REVERTED')
      await deps.cooldown.record(getAddress(row.payer) as Hex).catch(() => {});
    if (legs === 'used') return fail(row, 'legs_used_elsewhere', { tx_hash: op.txHash });
    return fail(row, op.errorCode ?? 'not_paid', { tx_hash: op.txHash });
  }

  /** An open call past its time limit: unknown whether it settled, so never called paid or unpaid. */
  async function strand(row: Row): Promise<boolean> {
    const ended = await move(row, {
      state: 'unmatched',
      failure_code: 'not_followed',
      seller_signature: null,
      fee_signature: null,
    });
    if (ended)
      log(
        JSON.stringify({
          event: 'x402_offer.stranded',
          level: 'ALERT',
          callId: row.call_id,
          state: row.state,
        }),
      );
    return ended;
  }

  /** Paid: the stored result may now be read. The kind never runs after the money moved. */
  async function deliver(row: Row): Promise<boolean> {
    if (row.result_text === null)
      return move(row, { state: 'paid_no_result', failure_code: 'no_result' });
    return move(row, { state: 'delivered' });
  }

  async function step(callId: string): Promise<boolean> {
    const at = deps.now();
    const { rows } = await deps.db.query<Row>(
      `UPDATE feed_pay_public_calls SET lease_until = $2
       WHERE call_id = $1 AND lease_until < $3 AND state IN ('reserved','ran','sent','paid')
       RETURNING ${COLUMNS}`,
      [callId, at + LEASE_MS, at],
    );
    const row = rows[0];
    if (!row) return false;
    const lease = at + LEASE_MS;
    const stepFailed = (error: unknown) => {
      log(
        JSON.stringify({
          event: 'x402_offer.step_failed',
          callId,
          state: row.state,
          error: error instanceof Error ? error.constructor.name : 'unknown',
        }),
      );
      return false;
    };
    try {
      const moved = await (async () => {
        if (row.state === 'reserved') return runKind(row);
        if (row.state === 'ran') return send(row);
        if (row.state === 'sent') return follow(row);
        return deliver(row);
      })().catch(stepFailed);
      if (moved || row.state === 'paid') return moved;
      // Its key rotated or removed, or Base silent for hours: nothing here can end it any more, and
      // it holds its payer's and address's open slots. The legs have long expired by now.
      return (
        nowS() > Number(row.valid_before) + PUBLIC_OFFER_STRANDED_AFTER_S && (await strand(row))
      );
    } catch (error) {
      return stepFailed(error);
    } finally {
      await deps.db
        .query(
          'UPDATE feed_pay_public_calls SET lease_until = 0 WHERE call_id = $1 AND lease_until = $2',
          [callId, lease],
        )
        .catch(() => {});
    }
  }

  /** Steps a call until it ends or the polls run out; stepping is safe from anywhere (lease). */
  async function drive(callId: string, polls: number): Promise<void> {
    for (let i = 0; i < polls; i++) {
      const moved = await step(callId);
      const row = await load(callId);
      if (!row || !['reserved', 'ran', 'sent', 'paid'].includes(row.state)) return;
      if (!moved && i < polls - 1) await sleep(POLL_MS);
    }
  }

  /** Drives a call for at most waitMs of real time; a slow one answers 202 for the worker. */
  async function driveBounded(callId: string, polls: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deps.waitMs ?? PUBLIC_OFFER_WAIT_MS);
      timer.unref?.();
    });
    await Promise.race([drive(callId, polls).catch(() => {}), limit]);
    if (timer) clearTimeout(timer);
  }

  // ---- Answers -------------------------------------------------------------------------------

  const paymentResponse = (row: Row, v1: boolean): Record<string, string> => ({
    [v1 ? 'X-PAYMENT-RESPONSE' : 'PAYMENT-RESPONSE']: Buffer.from(
      JSON.stringify({
        success: true,
        transaction: row.tx_hash,
        network: `eip155:${deps.chainId}`,
        payer: getAddress(row.payer),
      }),
    ).toString('base64'),
  });

  /** A call's answer. The result leaves only from here, and only in state delivered. */
  function answerFor(row: Row, v1: boolean): PublicAnswer {
    switch (row.state) {
      case 'delivered':
        if (row.result_text === null)
          return {
            status: 410,
            headers: { ...NO_STORE, ...paymentResponse(row, v1) },
            json: { error: 'This result is no longer kept.', code: 'result_expired' },
          };
        return {
          status: 200,
          headers: { ...NO_STORE, ...paymentResponse(row, v1) },
          text: { mime: row.result_mime ?? 'text/plain', body: row.result_text },
        };
      case 'paid_no_result':
        return {
          status: 502,
          headers: { ...NO_STORE, ...paymentResponse(row, v1) },
          json: { error: 'Paid, but no result was stored.', code: 'paid_no_result' },
        };
      case 'unmatched':
        if (row.failure_code === 'not_followed')
          return refused(
            502,
            'settlement_unknown',
            'This call could not be followed to its end, so no result is released. Its authorizations have expired. It has been flagged for review.',
          );
        return refused(
          502,
          'settlement_unmatched',
          'A transaction for this call succeeded but its fee record did not match, so no result is released. It has been flagged for review.',
          { transaction: row.tx_hash },
        );
      case 'failed':
        if (row.failure_code === 'kind_failed')
          return refused(
            502,
            'kind_failed',
            'The service failed. Nothing was sent, nothing is owed.',
          );
        if (row.failure_code === 'legs_used_elsewhere')
          return refused(
            409,
            'legs_used_elsewhere',
            'Your authorizations were used outside this call. No result is available here.',
          );
        // Not "nothing was charged": a call that ended never sent can't know what its buyer did with
        // legs still in their hands, and those stay valid until they expire.
        return refused(
          402,
          'payment_failed',
          'Not settled by this call, which moved no money. Authorizations you signed stay valid until they expire.',
          { reason: row.failure_code },
        );
      default:
        return {
          status: 202,
          headers: { ...NO_STORE, 'Retry-After': '5' },
          json: {
            callId: row.call_id,
            state: row.state,
            retry: 'Send the same request again.',
          },
        };
    }
  }

  // ---- The payment ---------------------------------------------------------------------------

  const termsOf = (offerId: string, { accepted }: PublicPayment): PublicTerms => ({
    chainId: deps.chainId,
    router: accepted.extra.router,
    treasury: accepted.extra.treasury,
    callId: accepted.extra.callId,
    offerId,
    kind: accepted.extra.kind,
    version: accepted.extra.offerVersion,
    payTo: accepted.payTo,
    gross: accepted.amount,
    fee: accepted.extra.feeAmount,
    net: accepted.extra.sellerAmount,
    ref: accepted.extra.ref,
    inputHash: accepted.extra.inputHash,
    validAfter: accepted.extra.validAfter,
    validBefore: accepted.extra.validBefore,
  });
  const issuedHere = (k: Buffer, terms: PublicTerms, { accepted }: PublicPayment) =>
    accepted.network === `eip155:${deps.chainId}` &&
    sameTag(publicTermsTag(k, terms), accepted.extra.tag);

  /**
   * The answer of a call already stored, whatever the settings say now; null for anything else, so
   * the route answers as if this did not exist. Terms not issued here read nothing and spend no
   * limit; the caller's limit runs before the one read.
   */
  async function kept(input: {
    offerId: string;
    payment: PublicPayment;
    v1: boolean;
    admit: () => Promise<void>;
  }): Promise<PublicAnswer | null> {
    const k = key();
    if (!k || !issuedHere(k, termsOf(input.offerId, input.payment), input.payment)) return null;
    await input.admit();
    const row = await load(input.payment.accepted.extra.callId);
    if (!row) return null;
    const { payload } = input.payment;
    return replay(row, payload.payer.toLowerCase(), payload, input.v1);
  }

  /** The payment's checks, nothing stored, then the row, then the call driven as far as it goes. */
  async function pay(input: {
    offerId: string;
    serviceId: string;
    body: { body?: FeedPayJson };
    client: string;
    payment: PublicPayment;
    v1: boolean;
    challenge: (entry: NonNullable<ReturnType<typeof acceptsEntry>>) => PublicAnswer;
  }): Promise<PublicAnswer> {
    const k = key();
    const r = router();
    const t = treasury();
    if (!k || !r || !t) return retryLater(60);
    const { accepted, payload } = input.payment;
    const extra = accepted.extra;
    // The terms as issued, or nothing further is even read.
    const terms = termsOf(input.offerId, input.payment);
    if (!issuedHere(k, terms, input.payment))
      return refused(400, 'invalid_terms', 'These payment terms were not issued here.');
    const payer = payload.payer.toLowerCase();

    // A call seen before answers its stored state before any time or offer rule: a completed one
    // still answers after its window ended or the offer changed.
    const known = await load(extra.callId);
    if (known) return replay(known, payer, payload, input.v1);
    if (await deps.paused()) return retryLater(60);

    const at = nowS();
    if (BigInt(extra.validBefore) < BigInt(at + PUBLIC_OFFER_MIN_PAY_WINDOW_S)) {
      const again = await freshChallenge(input);
      return again ?? refused(402, 'challenge_expired', 'These terms have ended.');
    }
    if (BigInt(extra.validAfter) > BigInt(at))
      return refused(400, 'invalid_terms', 'These payment terms are not valid yet.');
    if (r.toLowerCase() !== extra.router.toLowerCase() || t !== extra.treasury.toLowerCase())
      return (await freshChallenge(input)) ?? retryLater(60);

    let offer: PublicHostedOffer;
    try {
      offer = await deps.hosted.forSponsor(input.serviceId, input.body);
    } catch (error) {
      if (!(error instanceof FeedPayRefusal)) throw error;
      if (error.code !== 'invalid_inputs')
        return {
          status: 404,
          headers: NO_STORE,
          json: { error: 'Unknown API route' },
        };
      return refused(400, 'invalid_inputs', error.message);
    }
    if (inputHashOf(offer.input) !== extra.inputHash.toLowerCase())
      return refused(
        400,
        'input_mismatch',
        'The input is not the one these terms were issued for.',
      );
    // Repriced, moved or replaced since the 402: the buyer is asked again, nothing was charged.
    if (
      !settleable(offer) ||
      offer.split.gross.toString() !== terms.gross ||
      offer.split.fee.toString() !== terms.fee ||
      offer.split.net.toString() !== terms.net ||
      offer.kind !== terms.kind ||
      offer.version !== terms.version ||
      offer.payTo.toLowerCase() !== terms.payTo.toLowerCase()
    ) {
      if (!settleable(offer)) return retryLater(60);
      const entry = acceptsEntry(input.offerId, offer);
      return entry ? input.challenge(entry) : retryLater(60);
    }

    const payee = getAddress(accepted.payTo) as Hex;
    const payerAddress = getAddress(payload.payer) as Hex;
    if (payerAddress === payee)
      return refused(400, 'invalid_payer', 'A seller cannot buy from itself here.');
    const gross = offer.split.gross;
    const fee = offer.split.fee;
    const validAfter = BigInt(extra.validAfter);
    const validBefore = BigInt(extra.validBefore);
    const nonce = (leg: typeof LEG_SELLER | typeof LEG_FEE) =>
      router3Nonce({
        chainId: deps.chainId,
        router: r,
        treasury: getAddress(t) as Hex,
        payer: payerAddress,
        payee,
        gross,
        ref: extra.ref as Hex,
        validAfter,
        validBefore,
        leg,
      });
    const legOk = (
      leg: PublicPayment['payload']['seller'],
      to: string,
      value: bigint,
      expected: Hex,
    ) =>
      leg.from.toLowerCase() === payer &&
      leg.to.toLowerCase() === to.toLowerCase() &&
      leg.value === value.toString() &&
      leg.validAfter === extra.validAfter &&
      leg.validBefore === extra.validBefore &&
      leg.nonce.toLowerCase() === expected.toLowerCase();
    if (
      !legOk(payload.seller, accepted.payTo, gross - fee, nonce(LEG_SELLER)) ||
      !legOk(payload.fee, t, fee, nonce(LEG_FEE))
    )
      return refused(400, 'invalid_legs', 'The two authorizations do not match these terms.');

    if (!(await ready())) return retryLater(30);
    const lane = await deps.lane().catch(() => null);
    if (!lane) return retryLater(60);
    if ((await lane.address().catch(() => null))?.toLowerCase() === payee.toLowerCase())
      return retryLater(60);

    // The payer next, before any chain read: one call in flight, none in a cool-down. The row is
    // the guard (reserve, under the payer's lock); this only saves the simulation. The same request
    // again is not a second call.
    if (await payerBusy(payer)) {
      const again = await load(extra.callId);
      return again ? replay(again, payer, payload, input.v1) : inFlight();
    }
    if (await deps.cooldown.cooling(payerAddress).catch(() => true)) return cooling();

    const settlement: Router3Settlement = {
      payer: payerAddress,
      payee,
      gross,
      ref: extra.ref as Hex,
      validAfter,
      validBefore,
      sellerSignature: payload.seller.signature as Hex,
      feeSignature: payload.fee.signature as Hex,
    };
    const wontSettle = () =>
      refused(402, 'payment_invalid', 'This payment would not settle. Nothing was charged.');
    // Signatures that recover say nothing about a balance, but ones that don't recover from an
    // address with no code can't settle: USDC only asks ERC-1271 of an address with code. Refused
    // here, the shared simulations stay for payments that can be real.
    const recovered = await signedByPayer(payerAddress, payload);
    if (!(await deps.clientSimulations(input.client).catch(() => false))) return tooMany();
    if (!recovered) {
      const contract = await lane.hasCode(payerAddress).catch(() => null);
      if (contract === null) return retryLater(15);
      if (!contract) return wontSettle();
    }
    // Keys and contracts cost nothing to make, a balance does: a payer without the price can't take
    // a shared simulation from anyone, from however many addresses it asks.
    const balance = await lane.usdcBalance(payerAddress).catch(() => null);
    if (balance === null) return retryLater(15);
    if (balance < gross) return wontSettle();
    if (!(await deps.sellerSimulations(payee).catch(() => false))) return tooMany();
    if (!(await deps.simulations().catch(() => false))) return tooMany();
    const data = router3SettleData(settlement);
    const simulated = await lane
      .simulate(data)
      .catch(() => ({ ok: false, retryable: true }) as const);
    if (!simulated.ok) return simulated.retryable ? retryLater(15) : wontSettle();
    // What would end it never sent at the send, asked before the kind runs for nothing: oversized
    // signatures, or an L1 fee spike.
    const fits = await lane.withinCaps(data, simulated.gas).catch(() => null);
    if (fits === null) return retryLater(15);
    if (!fits)
      return refused(
        402,
        'payment_too_costly',
        'This payment costs too much to settle right now. Nothing was charged.',
      );

    // Screening: fail closed. The engine's emergency switch off refuses here (nothing is accepted
    // from strangers unscreened); the gate's own errors are its 'hold' or a failure code.
    if (!deps.screeningOn()) return retryLater(60);
    const refusal = await deps
      .preSign({
        intentId: `x402-offer:${extra.callId}`,
        payer: payerAddress,
        payee,
        grossRaw: gross,
        feeRaw: fee,
      })
      .catch(() => 'hold' as const);
    if (refusal === 'hold') return retryLater(30);
    if (refusal)
      return refused(
        403,
        'payment_refused',
        'This payment cannot be accepted. Nothing was charged.',
      );

    if (!(await deps.budget(payerAddress, { payee, client: input.client }).catch(() => false)))
      return tooMany();

    const stored = await reserve({
      terms,
      serviceId: input.serviceId,
      payer,
      client: storedClientKey(k, input.client),
      input: offer.input,
      sellerSignature: payload.seller.signature,
      feeSignature: payload.fee.signature,
    });
    if (stored === 'payer_busy') {
      const again = await load(extra.callId);
      return again ? replay(again, payer, payload, input.v1) : inFlight();
    }
    if (stored === 'open_limit')
      return refused(429, 'too_many_open', 'Too many calls open. Try again shortly.');
    if (stored === 'no_seller') return retryLater(60);
    if (stored === 'conflict') {
      const again = await load(extra.callId);
      if (again) return replay(again, payer, payload, input.v1);
      return {
        status: 409,
        headers: { ...NO_STORE, 'Retry-After': '10' },
        json: {
          error: 'The same call from this payer is still open. Nothing new was charged.',
          code: 'call_open',
        },
      };
    }
    await driveBounded(extra.callId, POLLS);
    const row = await load(extra.callId);
    return answerFor(row!, input.v1);
  }

  const tooMany = (): PublicAnswer => ({
    status: 429,
    headers: { ...NO_STORE, 'Retry-After': '60' },
    json: { error: 'Too many requests. Nothing was charged.', code: 'rate_limited' },
  });
  const inFlight = (): PublicAnswer => ({
    status: 409,
    headers: { ...NO_STORE, 'Retry-After': '10' },
    json: {
      error: 'Another call from this payer is still in flight. Nothing new was charged.',
      code: 'payer_in_flight',
    },
  });
  const cooling = (): PublicAnswer => ({
    status: 429,
    headers: { ...NO_STORE, 'Retry-After': '600' },
    json: {
      error: 'A recent payment from this payer reverted. Try again later. Nothing was charged.',
      code: 'payer_cooling',
    },
  });

  /** Whether this payer has a call open (database only). */
  const payerBusy = async (payer: string) =>
    (
      await deps.db.query(
        `SELECT 1 FROM feed_pay_public_calls
         WHERE payer = $1 AND state IN ('reserved','ran','sent','paid') LIMIT 1`,
        [payer],
      )
    ).rows.length > 0;

  /** Both legs' EIP-3009 signatures recover to the payer, as USDC checks an address with no code. */
  async function signedByPayer(payer: Hex, payload: PublicPayment['payload']): Promise<boolean> {
    const domain = usdcOf(deps.chainId)?.eip712;
    const network = baseNetwork(deps.chainId, deps.env);
    if (!domain || !network) return false;
    const signedBy = async (leg: PublicPayment['payload']['seller']) =>
      leg.signature.length === 132 &&
      getAddress(
        await recoverTypedDataAddress({
          domain: {
            name: domain.name,
            version: domain.version,
            chainId: deps.chainId,
            verifyingContract: getAddress(network.tokens.USDC.address),
          },
          types: {
            TransferWithAuthorization: [
              { name: 'from', type: 'address' },
              { name: 'to', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'validAfter', type: 'uint256' },
              { name: 'validBefore', type: 'uint256' },
              { name: 'nonce', type: 'bytes32' },
            ],
          },
          primaryType: 'TransferWithAuthorization',
          message: {
            from: getAddress(leg.from),
            to: getAddress(leg.to),
            value: BigInt(leg.value),
            validAfter: BigInt(leg.validAfter),
            validBefore: BigInt(leg.validBefore),
            nonce: leg.nonce as Hex,
          },
          signature: leg.signature as Hex,
        }),
      ) === payer;
    try {
      return (await signedBy(payload.seller)) && (await signedBy(payload.fee));
    } catch {
      return false;
    }
  }

  async function freshChallenge(input: {
    offerId: string;
    serviceId: string;
    body: { body?: FeedPayJson };
    challenge: (entry: NonNullable<ReturnType<typeof acceptsEntry>>) => PublicAnswer;
  }): Promise<PublicAnswer | null> {
    try {
      const offer = await deps.hosted.forSponsor(input.serviceId, input.body);
      if (!settleable(offer)) return null;
      const entry = acceptsEntry(input.offerId, offer);
      return entry ? input.challenge(entry) : null;
    } catch (error) {
      if (error instanceof FeedPayRefusal) return null;
      throw error;
    }
  }

  /** The same purchase again: the same payer and the same signatures while they are kept. */
  async function replay(
    row: Row,
    payer: string,
    payload: PublicPayment['payload'],
    v1: boolean,
  ): Promise<PublicAnswer> {
    const sameLegs =
      row.seller_signature === null ||
      (row.seller_signature === payload.seller.signature &&
        row.fee_signature === payload.fee.signature);
    if (row.payer !== payer || !sameLegs)
      return refused(409, 'payment_conflict', 'These terms were already used for another payment.');
    if (['reserved', 'ran', 'sent', 'paid'].includes(row.state)) {
      await driveBounded(row.call_id, 1);
      return answerFor((await load(row.call_id)) ?? row, v1);
    }
    return answerFor(row, v1);
  }

  /** Inserts the row under the open-calls caps (per address and per payer, one lock each). */
  async function reserve(input: {
    terms: PublicTerms;
    serviceId: string;
    payer: string;
    client: string;
    input: string;
    sellerSignature: string;
    feeSignature: string;
  }): Promise<'ok' | 'conflict' | 'open_limit' | 'payer_busy' | 'no_seller'> {
    const { terms } = input;
    const seller = (
      await deps.db.query<{ operator_id: string; agent_id: string }>(
        'SELECT operator_id, agent_id FROM city_offers WHERE offer_id = $1',
        [terms.offerId],
      )
    ).rows[0];
    if (!seller) return 'no_seller';
    const at = deps.now();
    return deps.db.transaction(async (tx) => {
      // Always in this order, so two requests never wait on each other's second lock.
      for (const lock of [`x402-offer:client:${input.client}`, `x402-offer:payer:${input.payer}`])
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lock]);
      const { rows } = await tx.query<{ client: string; payer: string }>(
        `SELECT count(*) FILTER (WHERE client_key = $1)::text AS client,
                count(*) FILTER (WHERE payer = $2)::text AS payer
         FROM feed_pay_public_calls WHERE state IN ('reserved','ran','sent','paid')`,
        [input.client, input.payer],
      );
      if (Number(rows[0]?.payer ?? 0) >= PUBLIC_OFFER_OPEN_PER_PAYER) return 'payer_busy';
      if (Number(rows[0]?.client ?? 0) >= PUBLIC_OFFER_OPEN_PER_CLIENT) return 'open_limit';
      const inserted = await tx.query(
        `INSERT INTO feed_pay_public_calls (call_id, payer, ref, input_hash, client_key, service_id,
           offer_id, offer_kind, offer_version, operator_id, agent_id, pay_to, gross_raw, fee_raw,
           input, state, op_key, valid_after, valid_before, seller_signature, fee_signature,
           created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'reserved',$16,$17,$18,$19,$20,
           $21,$21)
         ON CONFLICT DO NOTHING RETURNING call_id`,
        [
          terms.callId,
          input.payer,
          terms.ref.toLowerCase(),
          terms.inputHash.toLowerCase(),
          input.client,
          input.serviceId,
          terms.offerId,
          terms.kind,
          terms.version,
          seller.operator_id,
          seller.agent_id,
          terms.payTo.toLowerCase(),
          terms.gross,
          terms.fee,
          input.input,
          `${PUBLIC_CALL_KEY_PREFIX}${terms.callId}`,
          terms.validAfter,
          terms.validBefore,
          input.sellerSignature,
          input.feeSignature,
          at,
        ],
      );
      return inserted.rows.length ? 'ok' : 'conflict';
    });
  }

  // ---- The worker and the retention sweep ----------------------------------------------------

  /** Clears what an ended call no longer needs. Never updated_at: that is the call's paid time. */
  async function sweep(): Promise<number> {
    const { rows } = await deps.db.query(
      `UPDATE feed_pay_public_calls SET input = NULL, result_text = NULL, seller_signature = NULL,
         fee_signature = NULL, client_key = ''
       WHERE call_id IN (
         SELECT call_id FROM feed_pay_public_calls
         WHERE state IN ('delivered','paid_no_result','failed','unmatched')
           AND (input IS NOT NULL OR result_text IS NOT NULL OR seller_signature IS NOT NULL)
           AND updated_at < $1
         ORDER BY updated_at LIMIT ${PUBLIC_OFFER_SWEEP_MAX})
       RETURNING call_id`,
      [deps.now() - PUBLIC_OFFER_RETENTION_MS],
    );
    return rows.length;
  }

  /** The cron's pass: open calls oldest first, also while the flag is off (sends none then). */
  async function work(limits: { maxCalls: number; budgetMs: number }) {
    const started = deps.now();
    const { rows } = await deps.db.query<{ call_id: string }>(
      `SELECT call_id FROM feed_pay_public_calls
       WHERE state IN ('reserved','ran','sent','paid') AND lease_until < $1
       ORDER BY created_at LIMIT $2`,
      [started, limits.maxCalls],
    );
    let moved = 0;
    let next = 0;
    const runner = async () => {
      while (next < rows.length && deps.now() - started <= limits.budgetMs) {
        const { call_id } = rows[next++]!;
        if (await step(call_id)) moved += 1;
      }
    };
    await Promise.all(Array.from({ length: WORK_PARALLEL }, runner));
    // Both lanes' expired cool-downs: this cron is always on, the facilitator has none of its own.
    await sweepPayerCooldowns(deps.db, deps.now()).catch(() => {
      log(JSON.stringify({ event: 'x402_cooldown.sweep_failed' }));
    });
    return {
      moved,
      swept: await sweep().catch(() => {
        log(JSON.stringify({ event: 'x402_offer.sweep_failed' }));
        return 0;
      }),
    };
  }

  return { ready, paused: deps.paused, settleable, acceptsEntry, pay, kept, step, work, sweep };
}

export type PublicOfferPay = ReturnType<typeof createPublicOfferPay>;

type OfferLimiter = {
  hit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean }>;
  count(key: string, windowMs: number): Promise<number>;
};
const payeeKey = (payee: Hex) => `x402-offer-pay:payee:${payee.toLowerCase()}`;
const DAY_KEY = 'x402-offer-pay:day';
const DAY_MS = 86_400_000;

/**
 * The budget over the shared limiter, sequential as limiterBudget (public-settle.ts): an attempt
 * takes a unit of its payer's and its address's own buckets. The seller's and the day's are only
 * read here (publicOfferPaidBudget takes them): attempts that end unpaid never spend them. In a
 * limiter outage the prefix fails closed: hit refuses and count reads as exhausted.
 */
export function publicOfferBudget(limiter: OfferLimiter): PublicOfferPayDeps['budget'] {
  return async (payer, scope) =>
    (
      await limiter.hit(
        `x402-offer-pay:payer:${payer.toLowerCase()}`,
        PUBLIC_OFFER_PER_PAYER_HOUR,
        3_600_000,
      )
    ).allowed &&
    (
      await limiter.hit(
        `x402-offer-pay:client:${scope.client}`,
        PUBLIC_OFFER_PER_CLIENT_DAY,
        DAY_MS,
      )
    ).allowed &&
    (await limiter.count(payeeKey(scope.payee), DAY_MS)) < PUBLIC_OFFER_PER_PAYEE_DAY &&
    (await limiter.count(DAY_KEY, DAY_MS)) < PUBLIC_OFFER_DAILY;
}

/** A paid call's unit of the seller's and the day's caps. */
export function publicOfferPaidBudget(limiter: OfferLimiter): PublicOfferPayDeps['paidBudget'] {
  return async (payee) => {
    const seller = await limiter.hit(payeeKey(payee), PUBLIC_OFFER_PER_PAYEE_DAY, DAY_MS);
    const day = await limiter.hit(DAY_KEY, PUBLIC_OFFER_DAILY, DAY_MS);
    // A limiter outage answers a refusal, not a throw: the call is paid either way, but say so. Also
    // true at a full cap, where calls in flight can pass it.
    if (!seller.allowed || !day.allowed) throw new Error('paid unit not taken');
  };
}

/** The cool-down, as publicSettleCooldown in its own lane; an unreadable table reads as cooling. */
export function publicOfferCooldown(
  db: Database,
  now: () => number,
  log?: (line: string) => void,
): PublicOfferPayDeps['cooldown'] {
  return payerCooldown(db, {
    lane: 'x402-offer-pay',
    ms: PUBLIC_OFFER_REVERT_COOLDOWN_MS,
    now,
    ...(log ? { log } : {}),
  });
}

/** The shared simulation cap over the limiter. */
export function publicOfferSimulations(
  hit: (key: string, limit: number, windowMs: number) => Promise<{ allowed: boolean }>,
): PublicOfferPayDeps['simulations'] {
  return async () =>
    (await hit('x402-offer-pay:simulations', PUBLIC_OFFER_SIMULATIONS_PER_MINUTE, 60_000)).allowed;
}

/** One seller's share of the simulations, a quarter of the shared cap. */
export function publicOfferSellerSimulations(
  hit: (key: string, limit: number, windowMs: number) => Promise<{ allowed: boolean }>,
): PublicOfferPayDeps['sellerSimulations'] {
  return async (seller) =>
    (
      await hit(
        `x402-offer-pay:simulations-seller:${seller.toLowerCase()}`,
        PUBLIC_OFFER_SIMULATIONS_PER_SELLER_MINUTE,
        60_000,
      )
    ).allowed;
}

/** One address's share of the simulations, below the shared cap's reach. */
export function publicOfferClientSimulations(
  hit: (key: string, limit: number, windowMs: number) => Promise<{ allowed: boolean }>,
): PublicOfferPayDeps['clientSimulations'] {
  return async (client) =>
    (
      await hit(
        `x402-offer-pay:simulations-client:${client}`,
        PUBLIC_OFFER_SIMULATIONS_PER_CLIENT_MINUTE,
        60_000,
      )
    ).allowed;
}
