import {
  sponsoredSplit,
  type FeedSponsoredCall,
  type FeedSponsoredRefusal,
} from '../../../shared/feed-sponsored';
import type { FeedPayResult } from '../../../shared/feed-pay';
import { plain } from '../feedFormat';
import type { SponsoredFailure } from './sponsoredApi';
import { usdcText, type MoneyLine } from './payModel';

/*
 * The words of a free first buy (docs: the First service free mockup), kept pure so the unit tests
 * read them without a browser. Central City pays for a new agent's first Central City service; the
 * agent pays nothing. Short lines, no arrows.
 */

export const FREE_CHIP = 'First buy free';
export const USED_CHIP = 'Used';
export const IN_PROGRESS_CHIP = 'In progress';
export const USE_FREE = 'Use free';
/** The use sheet's intro while the free first buy applies. */
export const FREE_INTRO = 'Central City pays for this one. Your agent pays nothing.';
export const DONE_TITLE = 'Done. Paid by Central City.';
export const PAUSED_TEXT = 'Free first buys are paused right now. Try again in a few minutes.';

const name = (agentName: string) => plain(agentName) || 'This agent';
const possessive = (agentName: string) => {
  const n = name(agentName);
  return `${n}’${/s$/i.test(n) ? '' : 's'}`;
};

/** "2 USDC", "1.10 USDC". */
export const usdcShort = (raw: string | null | undefined) => {
  const text = usdcText(raw);
  return `${text === null ? '?' : text.replace(/\.00$/, '')} USDC`;
};

/** The agent page's card. */
export const freeCardTitle = (agentName: string) =>
  `${possessive(agentName)} first service is on Central City`;
export const freeCardBody = (agentName: string, creditMaxRaw: string | null) =>
  `Pick one Central City service up to ${usdcShort(creditMaxRaw ?? '2000000')}. ${name(agentName)} pays nothing.`;

/** The free price: Price X, Central City pays X, You pay 0 USDC (the total line last). */
export function freeLines(priceRaw: string): MoneyLine[] {
  const price = `${usdcText(priceRaw) ?? '?'} USDC`;
  return [
    { key: 'price', label: 'Price', value: price },
    { key: 'fee', label: 'Central City pays', value: price },
    { key: 'total', label: 'You pay', value: '0 USDC' },
  ];
}

/** A price a free first buy covers: positive and at most the credit's maximum. */
export function freeCovers(priceRaw: string | null | undefined, creditMaxRaw: string | null) {
  if (!priceRaw || !creditMaxRaw || !/^\d{1,30}$/.test(priceRaw)) return false;
  if (!/^\d{1,30}$/.test(creditMaxRaw)) return false;
  const price = BigInt(priceRaw);
  return price > 0n && price <= BigInt(creditMaxRaw);
}

/** "Nova’s first service. 1.10 USDC: 0.99 to Edward, 0.11 fee." */
export function doneLine(agentName: string, priceRaw: string, seller: string | null) {
  const split = sponsoredSplit(priceRaw);
  const first = `${possessive(agentName)} first service.`;
  if (!split) return first;
  return `${first} ${usdcText(priceRaw)} USDC: ${usdcText(split.sellerRaw)} to ${plain(seller ?? '') || 'the seller'}, ${usdcText(split.feeRaw)} fee.`;
}

/** Where a free first buy is, while it is not done; null once done. */
export function freeStateLine(call: Pick<FeedSponsoredCall, 'state'>, agentName: string) {
  switch (call.state) {
    case 'reserved':
    case 'sent':
      return `Central City is paying for ${possessive(agentName)} first service…`;
    case 'paid':
      return 'Paid by Central City. Waiting for the result…';
    default:
      return null;
  }
}

export const FREE_FAILED = 'This free first buy didn’t go through. Nothing was paid.';
export const FREE_NO_RESULT = 'The service sent no result.';
export const FREE_LOST =
  'We didn’t get an answer. Use free again: it never pays twice for the same buy.';

const REASONS: Record<FeedSponsoredRefusal, (agentName: string) => string> = {
  used: (n) => `${name(n)} already used its free first buy.`,
  not_eligible: (n) => `${name(n)} can’t get a free first buy. Its passport must be final first.`,
  unverified_owner: () => 'Free first buys need a verified Google sign-in and finished onboarding.',
  owner_daily: () => 'You used today’s free first buy. Try again tomorrow.',
  over_price: () => 'This service costs more than a free first buy covers.',
  service_not_allowed: () => 'Only Central City services can be a free first buy.',
  self_dealing: () => 'This service can’t be a free first buy for this agent.',
  budget: () => 'Today’s free first buys are used up. Try again tomorrow.',
  disabled: () => 'Free first buys are off right now.',
  paused: () => PAUSED_TEXT,
};

/** A refused free first buy in short words (nothing was paid in every case). */
export function sponsoredRefusalText(failure: SponsoredFailure, agentName: string): string {
  switch (failure.code) {
    case 'credit_unavailable':
      return failure.reason && REASONS[failure.reason]
        ? REASONS[failure.reason](agentName)
        : 'This free first buy isn’t available now.';
    case 'unavailable':
      return PAUSED_TEXT;
    case 'busy':
    case 'rate_limited':
      return 'Central City is busy. Try again in a moment.';
    case 'off':
      return REASONS.disabled(agentName);
    case 'agent_not_found':
      return `${name(agentName)} can’t use a free first buy.`;
    case 'idempotency_conflict':
      return 'This free first buy was started with other inputs. Try again.';
    case 'signed_out':
      return 'You were signed out. Sign in again to go on.';
    case 'network':
    case 'server':
    case 'unknown':
      return FREE_LOST;
  }
}

/** The result as the existing result block shows it (plain text, marked External). */
export function sponsoredResult(
  call: FeedSponsoredCall,
  receivedAt = Date.now(),
): FeedPayResult | null {
  const result = call.result;
  if (!result || result.text === null) return null;
  return {
    origin: 'external',
    status: 200,
    contentType: result.mime,
    format: result.format === 'json' ? 'json' : 'text',
    text: result.text,
    bytes: new TextEncoder().encode(result.text).length,
    truncated: false,
    receivedAt,
  };
}

