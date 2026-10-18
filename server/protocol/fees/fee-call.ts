/*
 * The fee leg of a fee-on-top paid call (docs/protocol/FEES.md, "Fee on top is not atomic"):
 * pure helpers the paid-call engine uses to quote, build and confirm the 10% protocol fee.
 *
 * - quoteFeeOnTop: listed price -> { gross, fee, total }; refuses a total above MAX_TOTAL ($0.10
 *   including the fee) and a price whose fee rounds to 0, mirroring the contract exactly.
 * - feeCalls: the calls for one UserOperation from the payer's spender account, sent only after
 *   the seller's x402 settlement is known: [USDC.approve(router, fee), router.chargeFee(...)]. The
 *   approval is exactly the fee, never an open allowance.
 * - feeRef: the on-chain ref for a call, keccak256 of its payment intent id (retries reuse it).
 * - quoteFeeIncluded / payCalls: fee included (kind 1), for a service sold by a Central City agent.
 *   The buyer pays the listed price; the router's pay(payee, gross, ref) sends 90% to the seller and
 *   10% to the treasury in the same call: [USDC.approve(router, gross), router.pay(...)]. The
 *   approval is exactly the price.
 * - feeMatches: a fee is confirmed only when the FeeCharged event matches the call record field by
 *   field (its kind included); a revert (AlreadyCharged) is never taken as proof on its own.
 * - feeEventsOf: the FeeCharged events of one emitter in a transaction's logs.
 */
import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  stringToHex,
  type Hex,
} from 'viem';

export const FEE_BPS = 1_000n;
export const MAX_TOTAL = 100_000n; // USDC units, fee included: $0.10
/** CentralCityFeeRouter2's MAX_TOTAL (docs/protocol/FEE_ROUTER_2.md): 100 USDC, fee included. */
export const MAX_TOTAL_ROUTER2 = 100_000_000n;
export const KIND_EXTERNAL = 0;
export const KIND_INTERNAL = 1;
/** The router's MIN_INCLUDED: the smallest fee-included price ($0.05). */
export const MIN_INCLUDED = 50_000n;

export const FEE_ROUTER_ABI = parseAbi([
  'function chargeFee(address payee, uint256 gross, bytes32 ref) returns (uint256 fee)',
  'function pay(address payee, uint256 gross, bytes32 ref) returns (uint256 fee)',
  'function charged(address payer, bytes32 ref) view returns (bytes32)',
  'event FeeCharged(address indexed payer, address indexed payee, bytes32 indexed ref, uint8 kind, uint256 gross, uint256 fee)',
  'error AlreadyCharged()',
  'error RefMismatch()',
  'error BadAmount()',
  'error ZeroAddress()',
  'error TransferFailed()',
]);
const USDC_ABI = parseAbi(['function approve(address spender, uint256 value) returns (bool)']);

export class FeeQuoteError extends Error {
  constructor(
    readonly code: 'OVER_CAP' | 'FEE_ZERO' | 'INVALID_PRICE',
    message: string,
  ) {
    super(message);
  }
}

export interface FeeQuote {
  /** The listed service price paid to the seller. */
  gross: bigint;
  /** The protocol fee, floor(gross / 10). */
  fee: bigint;
  /** What the payer spends for the call: gross + fee. */
  total: bigint;
}

export const feeFor = (gross: bigint) => (gross * FEE_BPS) / 10_000n;

/** The largest listed price a fee-on-top call can have: 90909 (total 99999). */
export const MAX_LISTED_PRICE = (() => {
  let p = (MAX_TOTAL * 10_000n) / (10_000n + FEE_BPS);
  while (p + 1n + feeFor(p + 1n) <= MAX_TOTAL) p++;
  while (p + feeFor(p) > MAX_TOTAL) p--;
  return p;
})();

/** The largest listed price a fee-on-top call can have through router 2: 90_909_091 (total 100 USDC). */
export const MAX_LISTED_PRICE_ROUTER2 = (() => {
  let p = (MAX_TOTAL_ROUTER2 * 10_000n) / (10_000n + FEE_BPS);
  while (p + 1n + feeFor(p + 1n) <= MAX_TOTAL_ROUTER2) p++;
  while (p + feeFor(p) > MAX_TOTAL_ROUTER2) p--;
  return p;
})();

export function quoteFeeOnTop(listedPrice: bigint, maxTotal: bigint = MAX_TOTAL): FeeQuote {
  if (typeof listedPrice !== 'bigint' || listedPrice <= 0n)
    throw new FeeQuoteError('INVALID_PRICE', 'The price must be a positive amount.');
  const fee = feeFor(listedPrice);
  if (fee === 0n) throw new FeeQuoteError('FEE_ZERO', 'The price is too small to carry a fee.');
  const total = listedPrice + fee;
  if (total > maxTotal)
    throw new FeeQuoteError('OVER_CAP', `The price plus the fee is above ${usdcText(maxTotal)}.`);
  return { gross: listedPrice, fee, total };
}

/** A fee-included price: what the buyer pays (gross), the fee in it and what the seller gets. */
export interface IncludedQuote {
  gross: bigint;
  /** floor(gross / 10), the router's own rounding. */
  fee: bigint;
  /** gross - fee: what the router sends to the seller. */
  net: bigint;
}

/** The fee-included split of a price, exactly as the router's pay(): MIN_INCLUDED..MAX_TOTAL. */
export function quoteFeeIncluded(price: bigint, maxTotal: bigint = MAX_TOTAL): IncludedQuote {
  if (typeof price !== 'bigint' || price <= 0n)
    throw new FeeQuoteError('INVALID_PRICE', 'The price must be a positive amount.');
  if (price < MIN_INCLUDED)
    throw new FeeQuoteError('INVALID_PRICE', 'A fee-included price is at least $0.05.');
  if (price > maxTotal)
    throw new FeeQuoteError('OVER_CAP', `The price is above ${usdcText(maxTotal)}.`);
  const fee = feeFor(price);
  if (fee === 0n) throw new FeeQuoteError('FEE_ZERO', 'The price is too small to carry a fee.');
  return { gross: price, fee, net: price - fee };
}

export const feeRef = (paymentIntentId: string): Hex => {
  if (!paymentIntentId) throw new Error('A payment intent id is required.');
  return keccak256(stringToHex(paymentIntentId));
};

/** "$0.10", "$100": a cap in USDC units as a dollar amount for messages. */
function usdcText(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `$${whole}${frac ? `.${frac.length < 2 ? frac.padEnd(2, '0') : frac}` : ''}`;
}

/** The buyer's total debit for a price: the price (fee included) or price + fee (fee on top). */
export function totalFor(kind: typeof KIND_EXTERNAL | typeof KIND_INTERNAL, gross: bigint): bigint {
  return kind === KIND_INTERNAL ? gross : gross + feeFor(gross);
}

export interface FeeRoute {
  router: Hex;
  /** That router's MAX_TOTAL. */
  maxTotal: bigint;
}

/**
 * The router for a payment (docs/protocol/FEE_ROUTER_2.md section 3), from the exact integer total
 * only: up to MAX_TOTAL router 1; above it up to MAX_TOTAL_ROUTER2 router 2, when it is configured
 * and switched on; null otherwise (refused before anything is signed). Called once, at
 * reservation: the result is pinned on the call and never re-derived.
 */
export function routeFor(input: {
  total: bigint;
  router: Hex;
  /** Router 2, or null when it is not configured or not switched on. */
  router2: Hex | null;
}): FeeRoute | null {
  if (input.total <= 0n) return null;
  if (input.total <= MAX_TOTAL) return { router: input.router, maxTotal: MAX_TOTAL };
  if (input.router2 && input.total <= MAX_TOTAL_ROUTER2)
    return { router: input.router2, maxTotal: MAX_TOTAL_ROUTER2 };
  return null;
}

/** The MAX_TOTAL of a pinned router: router 2's when it is router 2, else router 1's. */
export function maxTotalOfRouter(pinned: string, router2: string | null): bigint {
  return router2 && pinned.toLowerCase() === router2.toLowerCase() ? MAX_TOTAL_ROUTER2 : MAX_TOTAL;
}

export interface FeeCall {
  to: Hex;
  value: bigint;
  data: Hex;
}

/** The two calls of the fee UserOperation, in order. */
export function feeCalls(input: {
  usdc: Hex;
  router: Hex;
  payee: Hex;
  quote: FeeQuote;
  paymentIntentId: string;
  /** The pinned router's MAX_TOTAL (MAX_TOTAL for router 1, MAX_TOTAL_ROUTER2 for router 2). */
  maxTotal?: bigint;
}): FeeCall[] {
  const again = quoteFeeOnTop(input.quote.gross, input.maxTotal);
  if (again.fee !== input.quote.fee || again.total !== input.quote.total)
    throw new FeeQuoteError('INVALID_PRICE', 'The quote does not match its price.');
  return [
    {
      to: getAddress(input.usdc),
      value: 0n,
      data: encodeFunctionData({
        abi: USDC_ABI,
        functionName: 'approve',
        args: [getAddress(input.router), input.quote.fee],
      }),
    },
    {
      to: getAddress(input.router),
      value: 0n,
      data: encodeFunctionData({
        abi: FEE_ROUTER_ABI,
        functionName: 'chargeFee',
        args: [getAddress(input.payee), input.quote.gross, feeRef(input.paymentIntentId)],
      }),
    },
  ];
}

/**
 * The two calls of a fee-included payment's UserOperation, in order: an exact approval of the
 * price to the router, then router.pay(payee, gross, ref). One operation: the seller and the
 * treasury are paid in the same call, or neither is.
 */
export function payCalls(input: {
  usdc: Hex;
  router: Hex;
  payee: Hex;
  quote: IncludedQuote;
  paymentIntentId: string;
  /** The pinned router's MAX_TOTAL (MAX_TOTAL for router 1, MAX_TOTAL_ROUTER2 for router 2). */
  maxTotal?: bigint;
}): FeeCall[] {
  const again = quoteFeeIncluded(input.quote.gross, input.maxTotal);
  if (again.fee !== input.quote.fee || again.net !== input.quote.net)
    throw new FeeQuoteError('INVALID_PRICE', 'The quote does not match its price.');
  return [
    {
      to: getAddress(input.usdc),
      value: 0n,
      data: encodeFunctionData({
        abi: USDC_ABI,
        functionName: 'approve',
        args: [getAddress(input.router), input.quote.gross],
      }),
    },
    {
      to: getAddress(input.router),
      value: 0n,
      data: encodeFunctionData({
        abi: FEE_ROUTER_ABI,
        functionName: 'pay',
        args: [getAddress(input.payee), input.quote.gross, feeRef(input.paymentIntentId)],
      }),
    },
  ];
}

export interface FeeEvent {
  chainId: number;
  emitter: Hex;
  payer: Hex;
  payee: Hex;
  ref: Hex;
  kind: number;
  gross: bigint;
  fee: bigint;
}

/**
 * True only when the on-chain fee is exactly the one this call owes: kind 0 (fee on top, the
 * default) with its FeeQuote, or kind 1 (fee included, router.pay) with its IncludedQuote.
 */
export function feeMatches(
  event: FeeEvent,
  expected: {
    chainId: number;
    router: Hex;
    payer: Hex;
    payee: Hex;
    quote: Pick<FeeQuote, 'gross' | 'fee'>;
    paymentIntentId: string;
    kind?: typeof KIND_EXTERNAL | typeof KIND_INTERNAL;
  },
): boolean {
  return (
    event.chainId === expected.chainId &&
    getAddress(event.emitter) === getAddress(expected.router) &&
    getAddress(event.payer) === getAddress(expected.payer) &&
    getAddress(event.payee) === getAddress(expected.payee) &&
    event.ref.toLowerCase() === feeRef(expected.paymentIntentId).toLowerCase() &&
    event.kind === (expected.kind ?? KIND_EXTERNAL) &&
    event.gross === expected.quote.gross &&
    event.fee === expected.quote.fee
  );
}

/**
 * The FeeCharged events that one emitter (the pinned router) left in a transaction's logs, decoded;
 * logs of any other address, and logs that do not decode as FeeCharged, are left out.
 */
export function feeEventsOf(
  chainId: number,
  router: Hex,
  logs: readonly { address: Hex; topics: readonly Hex[]; data: Hex }[],
): FeeEvent[] {
  const out: FeeEvent[] = [];
  for (const log of logs) {
    if (getAddress(log.address) !== getAddress(router)) continue;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: FEE_ROUTER_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue;
    }
    if (decoded.eventName !== 'FeeCharged') continue;
    out.push({
      chainId,
      emitter: getAddress(log.address),
      payer: decoded.args.payer,
      payee: decoded.args.payee,
      ref: decoded.args.ref,
      kind: decoded.args.kind,
      gross: decoded.args.gross,
      fee: decoded.args.fee,
    });
  }
  return out;
}

const SETTLEMENT_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);

export interface SettlementLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
}

/**
 * Whether a seller settlement receipt proves the service payment of a fee-on-top call: the
 * transaction succeeded on USDC and moved exactly `gross` from the payer to the seller's payTo,
 * consuming the payer's EIP-3009 authorization with the call's nonce. Only then may the fee row be
 * marked service-verified (its price then counts as volume).
 */
export function settlementMatches(
  receipt: { status: 'success' | 'reverted'; logs: readonly SettlementLog[] },
  expected: { usdc: Hex; payer: Hex; payee: Hex; gross: bigint; authorizationNonce: Hex },
): boolean {
  if (receipt.status !== 'success') return false;
  let transferred = false;
  let authorized = false;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(expected.usdc)) continue;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: SETTLEMENT_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue;
    }
    if (
      decoded.eventName === 'Transfer' &&
      getAddress(decoded.args.from) === getAddress(expected.payer) &&
      getAddress(decoded.args.to) === getAddress(expected.payee) &&
      decoded.args.value === expected.gross
    )
      transferred = true;
    if (
      decoded.eventName === 'AuthorizationUsed' &&
      getAddress(decoded.args.authorizer) === getAddress(expected.payer) &&
      decoded.args.nonce.toLowerCase() === expected.authorizationNonce.toLowerCase()
    )
      authorized = true;
  }
  return transferred && authorized;
}
