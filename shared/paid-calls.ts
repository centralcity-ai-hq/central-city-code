/*
 * The paid service calls count on the homepage and the Feed head (docs/FEED_PAY.md section 14,
 * "Paid service calls count"): the public field `paid_calls` of GET /api/public/stats and the
 * numbers the server and the client share. Browser-safe: no Node imports.
 */
import { BASE_MAINNET } from './base/chains.js';
import { liveUnlessOff } from './protocol.js';

/**
 * The one emergency off: exactly '0' leaves the field out (so nothing shows); unset or any other
 * value leaves it on. Read per request.
 */
export const PAID_CALLS_FLAG = 'CITY_PAID_CALLS_TICKER';

/** Only Base mainnet is ever shown; other chains keep their own counts. */
export const PAID_CALLS_CHAIN_ID = BASE_MAINNET;

/** Payments whose block is at most this old are listed one by one (`recent_ms`). */
export const PAID_CALLS_RECENT_WINDOW_MS = 120_000;
/** At most this many block times are kept and listed. */
export const PAID_CALLS_RECENT_MAX = 64;
/**
 * Each payment shows this long after its block: the edge's 15 s freshness, the 15 s poll and the
 * settle check, so every payment shows as its own +1, in order.
 */
export const PAID_CALLS_SHOW_DELAY_MS = 45_000;
/** A copy older than this (its Age plus the time since it arrived) greys the live dot. */
export const PAID_CALLS_OLD_COPY_MS = 120_000;

/** Where "Verify here" leads: the Agent Explorer's Service calls view, every paid call on Base. */
export const PAID_CALLS_DOCS_HREF = '/explorer/calls';

/** The public field, as GET /api/public/stats sends it. */
export interface PaidCallsField {
  /** Paid service calls on Base mainnet, ever. */
  total: number;
  /** When this count was read, ISO 8601. */
  as_of: string;
  /** Milliseconds from each recent payment's block to `as_of`, newest first, never below 0. */
  recent_ms: number[];
  /** False when the window may hold more payments than are listed (all 64 kept are in it). */
  recent_complete: boolean;
  /**
   * Total value settled: the USDC (base units, 6 decimals, decimal text) the buyers paid for all
   * `total` calls (price plus fee). Optional: absent before migration 243 is read.
   */
  value_settled_raw?: string;
}

/** Total value settled in whole US dollars for the line ("$12,345"), rounded down. */
export function valueSettledText(raw: string): string {
  const dollars = BigInt(raw) / 1_000_000n;
  return `$${new Intl.NumberFormat('en-US').format(dollars)}`;
}

/**
 * The optional `base_agents` field of GET /api/public/stats (server/stats/base-agents.ts): the
 * Agent Explorer's "On Base now" total, the agents Central City registered on Base mainnet.
 */
export interface BaseAgentsField {
  total: number;
  /** When it was counted, ISO 8601. */
  as_of: string;
}

/** The label after the Base agents number: "Base agent" for exactly 1. */
export function baseAgentsLabel(total: number): string {
  return total === 1 ? 'Base agent' : 'Base agents';
}

/** True unless CITY_PAID_CALLS_TICKER is exactly '0'. */
export function paidCallsTickerOn(env: Readonly<Record<string, string | undefined>>): boolean {
  return liveUnlessOff(env, PAID_CALLS_FLAG);
}

/** The label after the number: "paid service call" for exactly 1. */
export function paidCallsLabel(total: number): string {
  return total === 1 ? 'paid service call' : 'paid service calls';
}
