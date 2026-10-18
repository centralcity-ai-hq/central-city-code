/*
 * The buyer side of x402 (docs/FEED_PAY.md section 5): reading a service's live 402, choosing the
 * one option we sign, building the payment header and reading the settlement answer. Pure: no
 * network, no keys, no database.
 *
 *   v2  the 402 carries a PAYMENT-REQUIRED header (base64 JSON {x402Version: 2, resource,
 *       accepts}); our payment goes in PAYMENT-SIGNATURE ({x402Version, resource, accepted,
 *       payload}); the settlement answer comes in PAYMENT-RESPONSE.
 *   v1  the 402's JSON body {x402Version: 1, accepts}; our payment goes in X-PAYMENT
 *       ({x402Version, scheme, network, payload}); the answer in X-PAYMENT-RESPONSE.
 *
 * The header wins over the body (one service sends v1 inside the body of a v2 answer). The option
 * is never accepts[0]: only scheme exact on Base mainnet in Base USDC, its EIP-712 domain exactly
 * 'USD Coin' version 2, EIP-3009, and payTo equal to the listing's pay_to; the cheapest of those.
 */
import { getAddress, type Hex } from 'viem';
import {
  FEED_PAY_LIMITS,
  FEED_PAY_OPTION,
  X402_HEADERS,
  type FeedPayNotPayableReason,
} from '../../../shared/feed-pay.js';
import type { Address } from '../../../shared/base/chains.js';

/**
 * The live price an option may ask by default (0.10 USDC, router 1's cap): a higher price is
 * price_over_cap. With fee router 2 switched on, the engine passes a higher cap (chooseOption's
 * priceCapRaw); the total with the fee is checked against the pinned router at reservation.
 */
export const PRICE_CAP_RAW = 100_000n;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const POSITIVE_INT = /^[1-9][0-9]{0,77}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const USDC = FEED_PAY_OPTION.asset.toLowerCase();

/** A header value by name, any case. */
export function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === wanted) return value;
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** base64 (standard or url-safe) JSON object, or null. */
function decodeJsonHeader(value: string): Record<string, unknown> | null {
  const text = value.trim();
  if (!text || text.length > FEED_PAY_LIMITS.paymentRequiredMaxBytes) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(text, 'base64').toString('utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonBody(body: Buffer): Record<string, unknown> | null {
  if (!body.length || body.length > FEED_PAY_LIMITS.paymentRequiredMaxBytes) return null;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A readable payment request: its version, its options as sent, the v2 resource and the v2
 * extensions (echoed back in the payment, x402 v2 section 5.1.2).
 */
export interface PaymentRequired {
  x402Version: 1 | 2;
  accepts: Record<string, unknown>[];
  resource: Record<string, unknown> | null;
  extensions: Record<string, unknown> | null;
}

export type PaymentRequiredRead =
  | { kind: 'required'; required: PaymentRequired }
  | {
      kind: 'not_payable';
      reason: Extract<
        FeedPayNotPayableReason,
        'free_answer' | 'redirects' | 'no_payment_request' | 'unreadable_payment_request'
      >;
    };

function requiredOf(json: Record<string, unknown> | null): PaymentRequired | null {
  if (!json || !Array.isArray(json.accepts)) return null;
  const accepts = json.accepts.filter(isRecord);
  if (!accepts.length) return null;
  return {
    x402Version: json.x402Version === 1 ? 1 : 2,
    accepts,
    resource: isRecord(json.resource) ? json.resource : null,
    extensions: isRecord(json.extensions) ? json.extensions : null,
  };
}

/** What an unpaid answer says about payment (section 5, "Reading the answer"). */
export function readPaymentRequired(answer: {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}): PaymentRequiredRead {
  const { status } = answer;
  if (status >= 300 && status < 400) return { kind: 'not_payable', reason: 'redirects' };
  // It answered without asking for payment (with or without a payment header): a free answer.
  if (status >= 200 && status < 300) return { kind: 'not_payable', reason: 'free_answer' };
  const header = headerOf(answer.headers, X402_HEADERS.required);
  if (header !== undefined) {
    if (status !== 402) return { kind: 'not_payable', reason: 'no_payment_request' };
    const required = requiredOf(decodeJsonHeader(header));
    return required
      ? { kind: 'required', required }
      : { kind: 'not_payable', reason: 'unreadable_payment_request' };
  }
  if (status !== 402) return { kind: 'not_payable', reason: 'no_payment_request' };
  const body = parseJsonBody(answer.body);
  const required = requiredOf(body);
  if (!required) return { kind: 'not_payable', reason: 'unreadable_payment_request' };
  // A body without a version is a v1 answer (v2 always names itself, in the header).
  return {
    kind: 'required',
    required: { ...required, x402Version: body?.x402Version === 2 ? 2 : 1 },
  };
}

/** The one option we sign, as the service sent it plus what we read from it. */
export interface ChosenOption {
  /** Exactly as the service listed it (sent back as `accepted` in v2). */
  raw: Record<string, unknown>;
  network: string;
  amountRaw: string;
  payTo: Address;
  /** min(AUTH_VALIDITY_MAX_S, maxTimeoutSeconds), decided by the engine. */
  maxTimeoutSeconds: number;
}

export type OptionChoice =
  | { kind: 'chosen'; option: ChosenOption }
  | { kind: 'not_payable'; reason: FeedPayNotPayableReason };

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** The amount of an option: v2 `amount`, v1 `maxAmountRequired`; a positive integer string. */
function amountOf(option: Record<string, unknown>): string | null {
  const value = option.amount ?? option.maxAmountRequired;
  if (typeof value === 'string' && POSITIVE_INT.test(value)) return BigInt(value).toString(10);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

/** maxTimeoutSeconds; absent means the x402 default of 60 s. */
function timeoutOf(option: Record<string, unknown>): number | null {
  const value = option.maxTimeoutSeconds;
  if (value === undefined || value === null) return 60;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Extensions a payment must fill to be accepted that we cannot fill: payment-identifier with
 * `required: true` (we send no id). Advertised but optional ones are only echoed back.
 */
function blockingExtension(extensions: Record<string, unknown> | null): boolean {
  const identifier = extensions?.['payment-identifier'];
  if (!isRecord(identifier)) return false;
  const info = isRecord(identifier.info) ? identifier.info : identifier;
  return info.required === true;
}

/**
 * Chooses the option (section 5 step 3) or names why none can be paid (step 4, in that order),
 * then checks amounts and windows (step 5): the cheapest option with a readable amount, a window
 * of at least windowMinS and a price within the cap. Only when none is left is the reason
 * the price (some readable option fits the window but costs too much) or the window.
 */
export function chooseOption(
  required: PaymentRequired,
  listingPayTo: string,
  priceCapRaw: bigint = PRICE_CAP_RAW,
): OptionChoice {
  const networks: readonly string[] = FEED_PAY_OPTION.networks;
  const baseUsdc = required.accepts.filter(
    (option) =>
      networks.includes(text(option.network) ?? '') &&
      (text(option.asset) ?? '').toLowerCase() === USDC,
  );
  const exact = baseUsdc.filter((option) => option.scheme === FEED_PAY_OPTION.scheme);
  if (!exact.length)
    return {
      kind: 'not_payable',
      reason: baseUsdc.some((option) => option.scheme === 'upto') ? 'upto_only' : 'no_base_usdc',
    };
  const payee = listingPayTo.toLowerCase();
  const ours = exact.filter((option) => {
    const payTo = text(option.payTo);
    return payTo !== undefined && EVM_ADDRESS.test(payTo) && payTo.toLowerCase() === payee;
  });
  if (!ours.length) return { kind: 'not_payable', reason: 'payee_mismatch' };
  const extra = (option: Record<string, unknown>) => (isRecord(option.extra) ? option.extra : {});
  const domain = ours.filter((option) => {
    const e = extra(option);
    return (
      e.name === FEED_PAY_OPTION.tokenName &&
      (e.version === undefined || e.version === FEED_PAY_OPTION.tokenVersion)
    );
  });
  if (!domain.length) return { kind: 'not_payable', reason: 'wrong_token_domain' };
  const method = domain.filter((option) => {
    const transfer = extra(option).assetTransferMethod;
    return transfer === undefined || transfer === FEED_PAY_OPTION.transferMethod;
  });
  if (!method.length) return { kind: 'not_payable', reason: 'unsupported_transfer' };
  if (blockingExtension(required.extensions))
    return { kind: 'not_payable', reason: 'needs_own_setup' };
  let best: ChosenOption | null = null;
  let readable = false;
  let windowOk = false;
  for (const option of method) {
    const amountRaw = amountOf(option);
    const maxTimeoutSeconds = timeoutOf(option);
    if (amountRaw === null || maxTimeoutSeconds === null) continue;
    readable = true;
    if (maxTimeoutSeconds < FEED_PAY_LIMITS.windowMinS) continue;
    windowOk = true;
    if (BigInt(amountRaw) > priceCapRaw) continue;
    if (best && BigInt(amountRaw) >= BigInt(best.amountRaw)) continue;
    best = {
      raw: option,
      network: text(option.network)!,
      amountRaw,
      payTo: getAddress(text(option.payTo)!),
      maxTimeoutSeconds,
    };
  }
  if (best) return { kind: 'chosen', option: best };
  if (!readable) return { kind: 'not_payable', reason: 'unreadable_payment_request' };
  return { kind: 'not_payable', reason: windowOk ? 'price_over_cap' : 'window_too_short' };
}

/** The signed EIP-3009 authorization as the payment header carries it. */
export interface PaymentPayload {
  signature: Hex;
  authorization: {
    from: Address;
    to: Address;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
}

/** The payment header (name and base64 value) for the version the service answered with. */
export function paymentHeader(input: {
  x402Version: 1 | 2;
  option: Record<string, unknown>;
  resource: Record<string, unknown> | null;
  /** v2: the 402's extensions, echoed back as received (section 5.1.2). */
  extensions?: Record<string, unknown> | null;
  payload: PaymentPayload;
}): { name: string; value: string } {
  const body =
    input.x402Version === 2
      ? {
          x402Version: 2,
          ...(input.resource ? { resource: input.resource } : {}),
          accepted: input.option,
          payload: input.payload,
          ...(input.extensions ? { extensions: input.extensions } : {}),
        }
      : {
          x402Version: 1,
          scheme: FEED_PAY_OPTION.scheme,
          network: text(input.option.network),
          payload: input.payload,
        };
  return {
    name: input.x402Version === 2 ? X402_HEADERS.signature : X402_HEADERS.v1Payment,
    value: Buffer.from(JSON.stringify(body), 'utf8').toString('base64'),
  };
}

/** What a service says about its settlement (PAYMENT-RESPONSE or X-PAYMENT-RESPONSE). */
export interface SettlementClaim {
  success: boolean;
  /** The transaction it names, when well formed; checked on Base before anything is believed. */
  transaction: Hex | null;
  /** Only known machine words pass ('invalid_signature', ...); anything else is 'unspecified'. */
  errorReason: string | null;
}

const SAFE_REASONS = new Set([
  'invalid_signature',
  'insufficient_funds',
  'invalid_payload',
  'invalid_exact_evm_payload_signature',
  'invalid_exact_evm_payload_authorization_valid_before',
  'invalid_exact_evm_payload_authorization_valid_after',
  'invalid_exact_evm_payload_authorization_value',
  'invalid_exact_evm_payload_recipient_mismatch',
  'invalid_network',
  'invalid_scheme',
  'settlement_pending',
  'unexpected_settle_error',
]);

export function readSettlementClaim(headers: Record<string, string>): SettlementClaim | null {
  const value =
    headerOf(headers, X402_HEADERS.response) ?? headerOf(headers, X402_HEADERS.v1Response);
  if (value === undefined) return null;
  const json = decodeJsonHeader(value);
  if (!json || typeof json.success !== 'boolean') return null;
  const transaction = text(json.transaction);
  const reason = text(json.errorReason);
  return {
    success: json.success,
    transaction:
      transaction && TX_HASH.test(transaction) ? (transaction.toLowerCase() as Hex) : null,
    errorReason: reason === undefined ? null : SAFE_REASONS.has(reason) ? reason : 'unspecified',
  };
}
