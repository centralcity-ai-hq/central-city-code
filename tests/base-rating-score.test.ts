import assert from 'node:assert/strict';
import test from 'node:test';
import {
  averageOf,
  cityScore,
  latestRatings,
  NO_SCORE_LINE,
  RATING_TAG,
  scoreLine,
  starsOf,
  type RatingFeedback,
} from '../shared/base/rating-score.js';

/*
 * The Central City score (shared/base/rating-score.ts): the latest valid star rating of each
 * Central City rater wallet, averaged with one decimal. Synthetic, low-entropy addresses.
 */

const wallet = (n: number) => `0x${'1'.repeat(38)}${n.toString(16).padStart(2, '0')}`;
const outsider = (n: number) => `0x${'9'.repeat(38)}${n.toString(16).padStart(2, '0')}`;
const CITY = [wallet(1), wallet(2), wallet(3), wallet(4)];

/** A rating: `stars` × 20, decimals 0, tag1 'starred', unless `more` says otherwise. */
const rating = (
  client: string,
  index: number | bigint,
  stars: number,
  more: Partial<RatingFeedback> = {},
): RatingFeedback => ({
  client,
  index: BigInt(index),
  value: BigInt(stars * 20),
  decimals: 0,
  tag1: RATING_TAG,
  ...more,
});

test('one rating per rater wallet: 1 to 5 stars are 20, 40, 60, 80, 100', () => {
  assert.deepEqual(
    [20n, 40n, 60n, 80n, 100n].map((value) => starsOf({ ...rating(wallet(1), 1, 0), value })),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    cityScore([rating(wallet(1), 1, 5), rating(wallet(2), 1, 4), rating(wallet(3), 1, 4)], CITY),
    { average: '4.3', raters: 3 },
  );
  assert.deepEqual(cityScore([rating(wallet(1), 1, 5)], CITY), { average: '5.0', raters: 1 });
  assert.deepEqual(cityScore([rating(wallet(1), 1, 1)], CITY), { average: '1.0', raters: 1 });
});

test('nothing counted is no score', () => {
  assert.equal(cityScore([], CITY), null);
  assert.equal(cityScore([rating(wallet(1), 1, 5)], []), null);
  assert.equal(averageOf([]), null);
});

test('the latest rating of a wallet wins, by feedback index, never by list order', () => {
  const entries = [rating(wallet(1), 3, 2), rating(wallet(1), 1, 5), rating(wallet(1), 2, 4)];
  assert.deepEqual(latestRatings(entries, CITY), [
    { client: wallet(1).toLowerCase(), index: 3n, stars: 2 },
  ]);
  assert.deepEqual(cityScore(entries, CITY), { average: '2.0', raters: 1 });
  // One vote per wallet: ten ratings from one wallet are still one rater.
  const many = Array.from({ length: 10 }, (_, i) => rating(wallet(2), i + 1, 5));
  assert.deepEqual(cityScore([...many, rating(wallet(3), 1, 1)], CITY), {
    average: '3.0',
    raters: 2,
  });
});

test('feedback indexes are uint64: compared exactly above 2^53, never as JS numbers', () => {
  // 2^53 and 2^53 + 1 are the same JS number; as bigints the later one wins.
  const top = 2n ** 53n;
  assert.equal(Number(top), Number(top + 1n));
  const entries = [rating(wallet(1), top + 1n, 2), rating(wallet(1), top, 5)];
  assert.deepEqual(latestRatings(entries, CITY), [
    { client: wallet(1).toLowerCase(), index: top + 1n, stars: 2 },
  ]);
  assert.deepEqual(cityScore(entries, CITY), { average: '2.0', raters: 1 });
  assert.deepEqual(cityScore([...entries].reverse(), CITY), { average: '2.0', raters: 1 });
  // The largest uint64 index is still later than the one before it.
  const max = 2n ** 64n - 1n;
  assert.deepEqual(cityScore([rating(wallet(2), max, 1), rating(wallet(2), max - 1n, 4)], CITY), {
    average: '1.0',
    raters: 1,
  });
});

test("the rated agent's own wallet never counts as a rater of itself", () => {
  const entries = [rating(wallet(1), 1, 1), rating(wallet(2), 1, 5)];
  // wallet(1) is a Central City rater, but it is the rated agent's own wallet here.
  assert.deepEqual(cityScore(entries, CITY, wallet(1)), { average: '5.0', raters: 1 });
  assert.deepEqual(
    latestRatings(entries, CITY, wallet(1)).map((r) => r.client),
    [wallet(2).toLowerCase()],
  );
  // Case never lets it back in.
  assert.deepEqual(cityScore(entries, CITY, wallet(1).toUpperCase().replace('0X', '0x')), {
    average: '5.0',
    raters: 1,
  });
  // Only its own ratings: no score.
  assert.equal(cityScore([rating(wallet(1), 1, 5)], CITY, wallet(1)), null);
  // Another agent's score still counts that wallet.
  assert.deepEqual(cityScore(entries, CITY, wallet(3)), { average: '3.0', raters: 2 });
  assert.deepEqual(cityScore(entries, CITY), { average: '3.0', raters: 2 });
});

test('duplicates count once; addresses compare case-insensitively', () => {
  const upper = `0x${wallet(1).slice(2).toUpperCase()}`;
  const entries = [rating(wallet(1), 1, 4), rating(wallet(1), 1, 4), rating(upper, 2, 2)];
  assert.deepEqual(cityScore(entries, [upper.toLowerCase()]), { average: '2.0', raters: 1 });
  assert.deepEqual(cityScore([rating(wallet(2), 1, 3)], [wallet(2).toUpperCase()]), {
    average: '3.0',
    raters: 1,
  });
  // The same wallet twice in the rater set is one rater.
  assert.deepEqual(cityScore([rating(wallet(1), 1, 3)], [wallet(1), wallet(1)]), {
    average: '3.0',
    raters: 1,
  });
});

test('revoked ratings are left out; a revoked latest lets the one before count', () => {
  assert.equal(cityScore([rating(wallet(1), 1, 5, { revoked: true })], CITY), null);
  assert.deepEqual(
    cityScore([rating(wallet(1), 1, 3), rating(wallet(1), 2, 5, { revoked: true })], CITY),
    { average: '3.0', raters: 1 },
  );
  assert.deepEqual(cityScore([rating(wallet(1), 1, 3, { revoked: false })], CITY), {
    average: '3.0',
    raters: 1,
  });
});

test('another tag, other decimals or a value outside the five never count', () => {
  const wrong: RatingFeedback[] = [
    rating(wallet(1), 1, 5, { tag1: '' }),
    rating(wallet(1), 2, 5, { tag1: 'Starred' }),
    rating(wallet(1), 3, 5, { tag1: 'starred ' }),
    rating(wallet(1), 4, 5, { tag1: 'quality' }),
    // 100 with decimals 1 is 10.0; 1000 with decimals 1 is 100, still not a rating.
    rating(wallet(1), 5, 5, { decimals: 1 }),
    rating(wallet(1), 6, 0, { value: 1000n, decimals: 1 }),
    rating(wallet(1), 7, 0, { value: 0n }),
    rating(wallet(1), 8, 0, { value: 10n }),
    rating(wallet(1), 9, 0, { value: 50n }),
    rating(wallet(1), 10, 0, { value: 99n }),
    rating(wallet(1), 11, 0, { value: 120n }),
    rating(wallet(1), 12, 0, { value: -20n }),
    rating(wallet(1), 13, 0, { value: -100n }),
    rating(wallet(1), 14, 0, { value: 2n ** 127n - 1n }),
    rating(wallet(1), 15, 0, { value: 2n ** 120n * 20n }),
  ];
  for (const entry of wrong) assert.equal(starsOf(entry), null, String(entry.index));
  assert.equal(cityScore(wrong, CITY), null);
  // A later entry that is no rating never hides the wallet's last real rating.
  assert.deepEqual(cityScore([rating(wallet(1), 1, 4), ...wrong.slice(1)], CITY), {
    average: '4.0',
    raters: 1,
  });
});

test('feedback from anyone but a Central City rater wallet does not count', () => {
  const entries = [
    rating(outsider(1), 1, 1),
    rating(outsider(2), 1, 1),
    rating(outsider(3), 5, 1),
    rating(wallet(1), 1, 5),
  ];
  assert.deepEqual(cityScore(entries, CITY), { average: '5.0', raters: 1 });
  assert.equal(cityScore(entries.slice(0, 3), CITY), null);
});

test('one decimal, rounded half up on the exact fraction', () => {
  const score = (stars: number[]) =>
    averageOf(stars.map((s, i) => ({ client: wallet(i), index: 1n, stars: s })));
  assert.equal(score([4, 5])?.average, '4.5');
  assert.equal(score([5, 5, 4])?.average, '4.7'); // 4.666…
  assert.equal(score([5, 4, 4])?.average, '4.3'); // 4.333…
  assert.equal(score([1, 2, 2])?.average, '1.7'); // 1.666…
  // 29 stars from 20 raters is exactly 1.45: half up is 1.5 (floating point would say 1.4).
  const halves = [...Array(11).fill(1), ...Array(9).fill(2)] as number[];
  assert.equal(
    halves.reduce((a, b) => a + b, 0),
    29,
  );
  assert.equal(score(halves)?.average, '1.5');
  assert.equal(score(halves)?.raters, 20);
  // 99 stars from 20 raters is 4.95: 5.0.
  assert.equal(score([...Array(19).fill(5), 4])?.average, '5.0');
  // 81 stars from 20 raters is 4.05: 4.1; 4.04… stays 4.0.
  assert.equal(score([...Array(1).fill(5), ...Array(19).fill(4)])?.average, '4.1');
  assert.equal(score([...Array(24).fill(4), 5])?.average, '4.0');
});

test('the line the passport, Verify and My agents show', () => {
  assert.equal(scoreLine({ average: '4.6', raters: 12 }), '4.6 ★ from 12 Central City agents');
  assert.equal(scoreLine({ average: '5.0', raters: 1 }), '5.0 ★ from 1 Central City agent');
  assert.equal(scoreLine({ average: '3.2', raters: 1234 }), '3.2 ★ from 1,234 Central City agents');
  assert.equal(NO_SCORE_LINE, 'No Central City ratings yet');
});
