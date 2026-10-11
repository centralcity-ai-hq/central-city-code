import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api.js';
import type { RegistrationRow } from '../src/base/baseRegistrationModel.js';
import { NOT_SAME_AGENT, RateTargetError, RatingCheckError } from '../src/base/wallet/rate.js';
import {
  DETAILS_CHANGED,
  MISMATCH,
  NOT_RATEABLE,
  OPERATION_PENDING,
  RATING_LIMIT,
  rateFailure,
  raterOf,
  ratingKey,
  ratingsOffError,
  ratingStage,
  starLabel,
  starsCaption,
} from '../src/agents/v4/rateScreenModel.js';

/*
 * The Rate screen's plain rules (src/agents/v4/rateScreenModel.ts): who may rate, the words for
 * each refusal, when a rating counts as rated, and when it needs a new idempotency key.
 */

const row = (over: Partial<RegistrationRow> = {}): RegistrationRow => ({
  chainId: 8453,
  state: 'confirmed',
  stage: 'confirmed',
  erc8004AgentId: '99515',
  agentUri: 'https://centralcity.ai/a/Ab3dE9',
  finality: 'final',
  ...over,
});

test('only an agent with a final Base ID and a passport on Base mainnet may rate', () => {
  assert.deepEqual(raterOf([row()]), { baseId: '99515', passport: 'Ab3dE9' });
  // Older servers send no stage or finality: a confirmed state is final.
  assert.deepEqual(raterOf([row({ stage: undefined, finality: undefined })]), {
    baseId: '99515',
    passport: 'Ab3dE9',
  });
  assert.equal(raterOf(undefined), null);
  assert.equal(raterOf(null), null);
  assert.equal(raterOf([]), null);
  // Another network, still registering or finalizing, or not final yet.
  assert.equal(raterOf([row({ chainId: 84532 })]), null);
  assert.equal(raterOf([row({ stage: 'finalizing' })]), null);
  assert.equal(raterOf([row({ stage: 'registered' })]), null);
  assert.equal(raterOf([row({ stage: undefined, state: 'submitted' })]), null);
  assert.equal(raterOf([row({ finality: 'safe' })]), null);
  // No final Base ID, or one that isn't one.
  assert.equal(raterOf([row({ erc8004AgentId: null })]), null);
  assert.equal(raterOf([row({ erc8004AgentId: '0' })]), null);
  assert.equal(raterOf([row({ erc8004AgentId: '0099' })]), null);
  // No passport: an older card address, another host, a short code that isn't one.
  assert.equal(raterOf([row({ agentUri: 'https://centralcity.ai/agents/x/card.json' })]), null);
  assert.equal(raterOf([row({ agentUri: 'https://example.com/a/Ab3dE9' })]), null);
  assert.equal(raterOf([row({ agentUri: 'https://centralcity.ai/a/Ab3dE9/' })]), null);
  assert.equal(raterOf([row({ agentUri: 'https://centralcity.ai/a/Ab3d' })]), null);
  assert.equal(raterOf([row({ agentUri: 'https://centralcity.ai/a/Ab3d-9' })]), null);
  // The mainnet row decides, whatever else is listed.
  assert.deepEqual(raterOf([row({ chainId: 84532, erc8004AgentId: '7' }), row()]), {
    baseId: '99515',
    passport: 'Ab3dE9',
  });
});

test('the stars’ words', () => {
  assert.equal(starsCaption(null), 'Choose 1 to 5 stars.');
  assert.equal(starsCaption(1), '1 of 5 · Poor');
  assert.equal(starsCaption(2), '2 of 5 · Fair');
  assert.equal(starsCaption(3), '3 of 5 · Good');
  assert.equal(starsCaption(4), '4 of 5 · Very good');
  assert.equal(starsCaption(5), '5 of 5 · Excellent');
  assert.equal(starLabel(1), '1 star');
  assert.equal(starLabel(4), '4 stars');
});

test('each server refusal reads as one plain sentence', () => {
  const otherwise = (error: unknown) => `other: ${(error as Error).message}`;
  const api = (code: string, status = 409) => new ApiError('server words', status, code);
  assert.equal(
    MISMATCH,
    'This Base ID and passport number don’t belong to the same Central City agent. Check both on the agent’s passport.',
  );
  assert.equal(rateFailure(api('lookup_mismatch', 422), 'Research scout', otherwise), MISMATCH);
  assert.equal(
    rateFailure(new RateTargetError(NOT_SAME_AGENT), 'Research scout', otherwise),
    MISMATCH,
  );
  assert.equal(rateFailure(api('lookup_expired'), 'Research scout', otherwise), DETAILS_CHANGED);
  assert.equal(rateFailure(api('lookup_changed'), 'Research scout', otherwise), DETAILS_CHANGED);
  assert.equal(DETAILS_CHANGED, 'This agent’s details changed. Check them again.');
  assert.equal(rateFailure(api('not_rateable'), 'Research scout', otherwise), NOT_RATEABLE);
  assert.equal(NOT_RATEABLE, 'Only Central City agents on Base can be rated.');
  assert.equal(
    rateFailure(api('same_person', 403), 'Research scout', otherwise),
    'Research scout can’t rate your own agents.',
  );
  // Without a max from the server: the plain limit line; with one: the server's own number.
  assert.equal(rateFailure(api('rating_limit', 429), 'Research scout', otherwise), RATING_LIMIT);
  assert.equal(RATING_LIMIT, 'You’ve reached today’s rating limit. Try again tomorrow.');
  const capped = new ApiError('Limit.', 429, 'rating_limit', { max: 10000 });
  assert.equal(
    rateFailure(capped, 'Research scout', otherwise),
    'You’ve rated 10,000 times today. Try again tomorrow.',
  );
  const odd = new ApiError('Limit.', 429, 'rating_limit', { max: 'lots' });
  assert.equal(rateFailure(odd, 'Research scout', otherwise), RATING_LIMIT);
  assert.equal(
    rateFailure(api('operation_pending'), 'Research scout', otherwise),
    OPERATION_PENDING,
  );
  assert.equal(
    OPERATION_PENDING,
    'A payment or rating from this wallet is still on its way. Try again in a minute.',
  );
  // Anything else is worded by the caller (the wallet screens' signingFailure).
  assert.equal(rateFailure(api('other_code'), 'Research scout', otherwise), 'other: server words');
  assert.equal(
    rateFailure(
      new RatingCheckError('The operation rates a different agent.'),
      'Research scout',
      otherwise,
    ),
    'other: The operation rates a different agent.',
  );
  assert.equal(
    rateFailure(new RateTargetError('Something else.'), 'Research scout', otherwise),
    'other: Something else.',
  );
});

test('a 404 that isn’t a rating refusal means ratings are off', () => {
  assert.equal(ratingsOffError(new ApiError('Not found.', 404)), true);
  assert.equal(ratingsOffError(new ApiError('Not found.', 404, 'not_found')), true);
  assert.equal(ratingsOffError(new ApiError('No.', 404, 'not_rateable')), false);
  assert.equal(ratingsOffError(new ApiError('No.', 404, 'lookup_mismatch')), false);
  assert.equal(ratingsOffError(new ApiError('No.', 409, 'not_rateable')), false);
  assert.equal(ratingsOffError(new ApiError('Server.', 500)), false);
  assert.equal(ratingsOffError(new Error('404')), false);
});

test('rated only at Base’s safe head or final; in a block alone is still on its way', () => {
  assert.equal(ratingStage({ state: 'awaiting_signature' }), 'on_its_way');
  assert.equal(ratingStage({ state: 'submitted' }), 'on_its_way');
  assert.equal(ratingStage({ state: 'included' }), 'on_its_way');
  assert.equal(ratingStage({ state: 'included', safe: false }), 'on_its_way');
  assert.equal(ratingStage({ state: 'included', safe: true }), 'rated');
  assert.equal(ratingStage({ state: 'final' }), 'final');
  assert.equal(ratingStage({ state: 'final', safe: false }), 'final');
  assert.equal(ratingStage({ state: 'failed' }), 'failed');
  assert.equal(ratingStage({ state: 'expired' }), 'expired');
  assert.equal(ratingStage({ state: 'cancelled' }), 'cancelled');
  assert.equal(ratingStage({ state: 'cancel_pending' }), 'on_its_way');
});

test('one idempotency key per rating meant: new when the agent looked up or the stars change', () => {
  let made = 0;
  const make = () => `key-${++made}`;
  const first = ratingKey(null, 'lk-1', 4, make);
  assert.deepEqual(first, { lookupId: 'lk-1', stars: 4, key: 'key-1' });
  // A retry of the same rating keeps its key.
  assert.equal(ratingKey(first, 'lk-1', 4, make), first);
  // Other stars, another lookup: a new key each.
  const other = ratingKey(first, 'lk-1', 5, make);
  assert.equal(other.key, 'key-2');
  assert.equal(ratingKey(other, 'lk-2', 5, make).key, 'key-3');
  // Back (null) always starts a new one.
  assert.equal(ratingKey(null, 'lk-2', 5, make).key, 'key-4');
});
