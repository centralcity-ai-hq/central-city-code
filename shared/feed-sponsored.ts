/*
 * The sponsored first purchase as the page sees it (server/feed/pay/sponsor.ts, sponsored.ts,
 * sponsored-routes.ts): a new agent's first Central City service is paid by Central City. Shared
 * by the server's routes and the page (src/feed/pay/sponsoredApi.ts), so both name the same paths,
 * states and limits.
 */

export const FEED_SPONSORED_PATHS = {
  /**
   * GET -> FeedSponsoredCreditView (server/feed/pay/sponsored.ts credit()). Signed in (session +
   * X-City-Request). Read only: the owner's agents on Base (at most 200) with what each one's
   * credit can do now, the Feed services it covers and the most it pays. 404 while off.
   */
  credit: '/api/feed/sponsored-credit',
  /** POST FeedSponsoredCallRequest -> FeedSponsoredCall. 402 credit_unavailable, 503 unavailable. */
  call: '/api/feed/services/:id/sponsored-call',
  /** GET -> FeedSponsoredCall. The call's owner only. */
  status: '/api/feed/sponsored-calls/:callId',
} as const;

export const FEED_SPONSORED_LIMITS = {
  /** How often the page reads a sponsored call that is not done. */
  pollMs: 1_500,
} as const;

/** What an agent's credit can do now (a hint: the call itself decides). */
export type FeedSponsoredCredit = 'available' | 'in_progress' | 'used' | 'unavailable';

/** Why a credit is unavailable. */
export type FeedSponsoredUnavailable =
  'disabled' | 'unverified_owner' | 'not_eligible' | 'owner_daily';

export interface FeedSponsoredCreditView {
  agents: Array<{
    agentId: string;
    credit: FeedSponsoredCredit;
    reason?: FeedSponsoredUnavailable;
  }>;
  /** The Feed services a free first buy may be (Central City's own, CITY_SFP_OFFERS). */
  serviceIds: string[];
  /** The most one free first buy may cost, fee included (base units); '0' while off. */
  maxPriceRaw: string;
}

export interface FeedSponsoredCallRequest {
  agent_id: string;
  use_credit: true;
  idempotency_key: string;
  inputs: { body?: Record<string, unknown>; query?: Record<string, string> };
  /** USDC text, at most 6 decimals ("1.1"). */
  max_price_usdc: string;
}

export type FeedSponsoredState =
  'reserved' | 'sent' | 'paid' | 'delivered' | 'paid_no_result' | 'failed';

/** States after which a sponsored call never changes again. */
export const FEED_SPONSORED_DONE: readonly FeedSponsoredState[] = [
  'delivered',
  'paid_no_result',
  'failed',
];

export interface FeedSponsoredCall {
  callId: string;
  agentId: string;
  serviceId: string;
  offerId: string;
  state: FeedSponsoredState;
  sponsored: true;
  /** What Central City paid, fee included (base units). */
  priceRaw: string;
  payment: { payer: string; router: 'router3'; txHash: string | null };
  failure: string | null;
  result: { format: string | null; mime: string | null; text: string | null } | null;
}

/** The refusals of a sponsored call (credit_unavailable carries one of these as `reason`). */
export const FEED_SPONSORED_REFUSALS = [
  'disabled',
  'not_eligible',
  'unverified_owner',
  'used',
  'over_price',
  'self_dealing',
  'owner_daily',
  'service_not_allowed',
  'paused',
  'budget',
] as const;
export type FeedSponsoredRefusal = (typeof FEED_SPONSORED_REFUSALS)[number];

/**
 * The split of a fee-included price, as fee router 3 pays it (server/protocol/fees/fee-call.ts
 * quoteFeeIncluded: the fee is floor(gross / 10)). For display only.
 */
export function sponsoredSplit(grossRaw: string): { sellerRaw: string; feeRaw: string } | null {
  if (!/^\d{1,30}$/.test(grossRaw)) return null;
  const gross = BigInt(grossRaw);
  const fee = (gross * 1_000n) / 10_000n;
  return { sellerRaw: (gross - fee).toString(10), feeRaw: fee.toString(10) };
}
