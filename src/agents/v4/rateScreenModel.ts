/*
 * The Rate screen's plain rules (Operation Rating R2; docs: the approved Rate mockup): who may
 * rate, what each server refusal says, where a rating on its way stands, and when a rating needs a
 * new idempotency key. No React, no requests.
 */
import { ApiError } from '../../api';
import { stageOf, type RegistrationRow } from '../../base/baseRegistrationModel';
import { NOT_SAME_AGENT, passportUri, RateTargetError, type Stars } from '../../base/wallet/rate';
import type { WithdrawalView } from '../../base/wallet/withdraw';
import { BASE_MAINNET } from '../../../shared/base/chains';
import { passportCode } from './baseScreenModel';

/** The rater as Base knows it: its final Base ID and its passport number. */
export interface Rater {
  baseId: string;
  passport: string;
}

const BASE_ID = /^[1-9][0-9]{0,77}$/;
const SHORT = /^[0-9A-Za-z]{6}$/;

/**
 * The agent may rate only once it is itself a Central City agent on Base: a final Base ID, and a
 * passport at centralcity.ai/a/<passport number>. Anything less (still registering, an older card
 * address, another network) and there is no Rate at all.
 */
export function raterOf(rows: readonly RegistrationRow[] | null | undefined): Rater | null {
  const row = rows?.find((one) => one?.chainId === BASE_MAINNET);
  if (!row || stageOf(row) !== 'confirmed') return null;
  if (row.finality != null && row.finality !== 'final') return null;
  const baseId = row.erc8004AgentId;
  if (typeof baseId !== 'string' || !BASE_ID.test(baseId)) return null;
  if (typeof row.agentUri !== 'string') return null;
  const passport = passportCode(row.agentUri);
  if (!SHORT.test(passport) || row.agentUri !== passportUri(passport)) return null;
  return { baseId, passport };
}

export const STAR_WORDS = ['Poor', 'Fair', 'Good', 'Very good', 'Excellent'] as const;

/** "4 of 5 · Very good"; before a choice, what to do. */
export const starsCaption = (stars: Stars | null) =>
  stars ? `${stars} of 5 · ${STAR_WORDS[stars - 1]}` : 'Choose 1 to 5 stars.';

/** One star's accessible name. */
export const starLabel = (stars: number) => `${stars} ${stars === 1 ? 'star' : 'stars'}`;

export const MISMATCH = `${NOT_SAME_AGENT} Check both on the agent’s passport.`;
export const DETAILS_CHANGED = 'This agent’s details changed. Check them again.';
export const NOT_RATEABLE = 'Only Central City agents on Base can be rated.';
/** The daily cap reached: with the server's own max when it sent one (CITY_BASE_RATE_DAILY_MAX). */
export const ratingLimit = (max?: number | null) =>
  typeof max === 'number' && Number.isSafeInteger(max) && max > 0
    ? `You’ve rated ${max.toLocaleString('en-US')} times today. Try again tomorrow.`
    : 'You’ve reached today’s rating limit. Try again tomorrow.';
/** The cap's text when the server didn't say its max. */
export const RATING_LIMIT = ratingLimit();
export const OPERATION_PENDING =
  'A payment or rating from this wallet is still on its way. Try again in a minute.';
export const samePerson = (rater: string) => `${rater} can’t rate your own agents.`;

/** The codes that mean the agent on screen is no longer the one to rate: look it up again. */
export const LOOK_AGAIN = ['lookup_expired', 'lookup_changed'] as const;

const KNOWN = [
  'lookup_mismatch',
  ...LOOK_AGAIN,
  'not_rateable',
  'same_person',
  'rating_limit',
  'operation_pending',
];

/**
 * A 404 from the ratings routes that isn't one of their own refusals: ratings aren't switched on
 * here (as a wallet route's 404 means wallets are off).
 */
export const ratingsOffError = (error: unknown) =>
  error instanceof ApiError && error.status === 404 && !KNOWN.includes(error.code ?? '');

/**
 * What the owner reads for a refusal, in plain words. `rater` is the rating agent's name;
 * `otherwise` words anything else (the wallet screens' signingFailure).
 */
export function rateFailure(
  error: unknown,
  rater: string,
  otherwise: (error: unknown) => string,
): string {
  if (error instanceof RateTargetError && error.message === NOT_SAME_AGENT) return MISMATCH;
  if (error instanceof ApiError)
    switch (error.code) {
      case 'lookup_mismatch':
        return MISMATCH;
      case 'lookup_expired':
      case 'lookup_changed':
        return DETAILS_CHANGED;
      case 'not_rateable':
        return NOT_RATEABLE;
      case 'same_person':
        return samePerson(rater);
      case 'rating_limit': {
        const max = (error.details as { max?: unknown } | undefined)?.max;
        return ratingLimit(typeof max === 'number' ? max : null);
      }
      case 'operation_pending':
        return OPERATION_PENDING;
    }
  return otherwise(error);
}

/** A rating as the withdrawal route reads it; `safe` from servers that send it. */
export type RatingView = WithdrawalView & { safe?: boolean };

export type RatingStage = 'on_its_way' | 'rated' | 'final' | 'failed' | 'expired' | 'cancelled';

/**
 * Where a rating stands. "Rated" once it is in a block at Base's safe head (or final). Safe is not
 * final: until Base finalizes that block (about 15 minutes, hence "Final in about 15 minutes.") a
 * reorganization could still undo it, however unlikely. In a block but not safe yet is still on its
 * way: a replaced block undoes it far more easily.
 */
export function ratingStage(view: Pick<RatingView, 'state' | 'safe'>): RatingStage {
  switch (view.state) {
    case 'final':
      return 'final';
    case 'included':
      return view.safe === true ? 'rated' : 'on_its_way';
    case 'failed':
    case 'expired':
    case 'cancelled':
      return view.state;
    default:
      return 'on_its_way';
  }
}

/** The idempotency key and the rating it was made for. */
export interface RatingKey {
  lookupId: string;
  stars: Stars;
  key: string;
}

/**
 * The key for this rating: the same one while the agent looked up and the stars stay (a retry
 * never makes a second rating), a new one as soon as either changes.
 */
export function ratingKey(
  previous: RatingKey | null,
  lookupId: string,
  stars: Stars,
  make: () => string,
): RatingKey {
  return previous && previous.lookupId === lookupId && previous.stars === stars
    ? previous
    : { lookupId, stars, key: make() };
}
