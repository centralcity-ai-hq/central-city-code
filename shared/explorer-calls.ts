/*
 * The Agent Explorer's "Service calls" view (/explorer/calls; the approved mockup
 * explorer-service-calls.html, Operation DESIGN): every paid service call on Central City as the
 * Base transaction that paid for it. The JSON the public route sends
 * (server/base/explorer/calls.ts) in the shape the page reads (src/verify/serviceCallsData.ts).
 * Browser-safe: no Node imports.
 *
 * Only what Base itself already shows to anyone is in it: the transaction, its block and time, the
 * address that paid, the address that was paid, the amounts, and the service's public title. Never
 * who started a call, which agent or account it belongs to, what was asked or answered, or any id
 * Central City keeps for itself. No address is labelled as anyone's.
 */
import { PAID_CALLS_CHAIN_ID } from './paid-calls.js';

export { PAID_CALLS_CHAIN_ID };

/** The public read route. */
export const SERVICE_CALLS_PATH = '/api/public/explorer/calls';

/** Rows per page (fixed, so every page is one edge-cache entry). */
export const SERVICE_CALLS_PAGE_SIZE = 15;

/** The longest search accepted: a transaction hash (0x + 64 hex) is the longest valid one. */
export const SERVICE_CALLS_QUERY_MAX = 66;

/**
 * The page cursor: the last row's Base block time (ms) and its transaction, `<ms>_<0x hash>`. The
 * next page starts strictly after that row in (time, transaction) order, newest first.
 */
export const SERVICE_CALLS_CURSOR = /^(0|[1-9][0-9]{0,15})_(0x[0-9a-f]{64})$/;

/** What a search can be; anything else is refused (400). */
export type ServiceCallsSearch =
  | { kind: 'tx'; hash: string }
  | { kind: 'address'; address: string }
  | { kind: 'block'; block: number };

/**
 * A search as the route reads it, or null when it is none of the three:
 * - 0x + 64 hex: a transaction hash, matched exactly (lower case);
 * - 0x + 40 hex: an address, the payer or the provider (lower case);
 * - digits: a Base block number (a safe integer).
 * Spaces around it are ignored; nothing else is accepted.
 */
export function parseServiceCallsSearch(text: string): ServiceCallsSearch | null {
  const q = text.trim();
  if (q.length === 0 || q.length > SERVICE_CALLS_QUERY_MAX) return null;
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) return { kind: 'tx', hash: q.toLowerCase() };
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) return { kind: 'address', address: q.toLowerCase() };
  if (/^(0|[1-9][0-9]{0,15})$/.test(q)) {
    const block = Number(q);
    if (Number.isSafeInteger(block)) return { kind: 'block', block };
  }
  return null;
}

/** The Central City protocol fee of one call, when its transfer is on Base. */
export interface ServiceCallFee {
  /**
   * 'included': the price includes the 10% fee, paid in the same transaction (a service sold by a
   * Central City agent). 'on_top': the fee was charged on top, in a transaction of its own.
   */
  model: 'included' | 'on_top';
  /** USDC, exact ("0.005"). */
  amount: string;
  /** The transaction that moved the fee (the payment's own for 'included'). */
  tx_hash: string;
  block: number | null;
}

/** One paid service call: one row, one Base transaction. */
export interface ServiceCall {
  /** The transaction that paid the provider. */
  tx_hash: string;
  block: number | null;
  /** When Base settled it (epoch ms). */
  time: number;
  /** The address the USDC left (checksummed). */
  payer: string;
  /** The address the service is paid at (checksummed). */
  provider: string;
  /** The service's public title. */
  service: string;
  /** USDC moved by `tx_hash`, exact ("0.05"). For 'included' it is the whole price. */
  amount: string;
  /** What the provider received, exact. */
  provider_amount: string;
  /** null: no fee leg on Base for this call. */
  fee: ServiceCallFee | null;
  status: 'settled';
}

/** GET /api/public/explorer/calls?cursor=&q= */
export interface ServiceCallsPage {
  /** Paid service calls on Base mainnet, ever (the public counter); null while not readable. */
  total: number | null;
  /** Paid in the last 24 hours; null while not counted. */
  last24h: number | null;
  /** Payments whose block is at most 60 s old; null while not readable. */
  perMinute: number | null;
  /** Distinct services paid in the last 24 hours; null while not counted. */
  services24h: number | null;
  /** USDC paid by buyers for the calls of the last 24 hours (price, fee included), in 6-decimal raw units; null while not counted. */
  value24hRaw: string | null;
  /** The 10% protocol fee of those calls, in 6-decimal raw units; null while not counted. */
  fee24hRaw: string | null;
  /** When this answer was built, ISO 8601. */
  as_of: string;
  /** A search's matching calls (first page of a search only); else null. */
  matches: number | null;
  items: ServiceCall[];
  /** The cursor of the next (older) page, or null at the end. */
  next_cursor: string | null;
}
