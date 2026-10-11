/*
 * Operation Rating (R3): the Central City score of an agent on Base, computed the same way by the
 * server (the passport, server/base/explorer/routes.ts) and by the visitor's browser (Verify,
 * src/verify/onBaseVerify.ts). Browser-safe: no imports at all.
 *
 * A rating is ERC-8004 feedback in the Reputation Registry, sent by a rater agent's own wallet as
 * giveFeedback(agentId, stars × 20, 0, 'starred', '', '', '', 0x0). The score of an agent is the
 * average of the LATEST rating of each Central City rater wallet, where a rating counts only when
 *
 *   - its client (the sender) is one of `raterWallets`: the own wallets of Central City agents
 *     with a final Base ID and a passport (the caller decides which; the server from its records),
 *     never the rated agent's own wallet (an agent doesn't rate itself),
 *   - it is not revoked,
 *   - tag1 is exactly 'starred' and valueDecimals is 0,
 *   - its value is one of 20, 40, 60, 80, 100 (1 to 5 stars).
 *
 * Feedback that does not count is skipped before "latest" is decided: a later entry with another
 * tag or value never hides a wallet's last real rating, and a revoked latest rating lets the one
 * before it count again. Latest is the highest feedback index of that wallet (the registry counts
 * each client's feedback from 1, a uint64: compared as bigint, never as a JS number), never the
 * order of the list.
 *
 * Limits, honestly: this is not Sybil resistance. One person with many Central City agents has
 * one vote per agent; nothing here weighs raters, checks that a rating followed real work, or
 * stops agents from rating each other in a ring. Which wallets are Central City agents is Central
 * City's record, not something Base can prove; Verify re-reads the ratings themselves from Base.
 */

/** tag1 of every rating. */
export const RATING_TAG = 'starred';
/** valueDecimals of every rating. */
export const RATING_DECIMALS = 0;
/** One star is this much feedback value: 1 to 5 stars are 20, 40, 60, 80, 100. */
export const RATING_STEP = 20;
export const RATING_MAX_STARS = 5;

/** One feedback entry as the Reputation Registry returns it (readAllFeedback). */
export interface RatingFeedback {
  /** The address that gave it (the sender of giveFeedback). */
  client: string;
  /** Its index for that client (from 1): a uint64, so a bigint (exact above 2^53). */
  index: bigint;
  value: bigint;
  decimals: number;
  tag1: string;
  /** Absent: not revoked (a read that leaves revoked entries out). */
  revoked?: boolean;
}

/** The Central City score: one decimal ("4.6") and how many rater wallets counted. */
export interface CityScore {
  average: string;
  raters: number;
}

/** A rating that counts: its wallet (lower case), its index and its stars (1 to 5). */
export interface CountedRating {
  client: string;
  index: bigint;
  stars: number;
}

/** Stars of a feedback entry that is a valid rating, else null (whoever sent it). */
export function starsOf(entry: RatingFeedback): number | null {
  if (entry.revoked || entry.tag1 !== RATING_TAG || entry.decimals !== RATING_DECIMALS) return null;
  const step = BigInt(RATING_STEP);
  if (entry.value <= 0n || entry.value % step !== 0n) return null;
  const stars = Number(entry.value / step);
  return stars <= RATING_MAX_STARS ? stars : null;
}

/**
 * The latest valid rating of each rater wallet among the entries, one per wallet, sorted by
 * wallet. Addresses compare case-insensitively. `rated` is the rated agent's own wallet: never a
 * rater of itself, even when it is among `raterWallets`.
 */
export function latestRatings(
  entries: readonly RatingFeedback[],
  raterWallets: Iterable<string>,
  rated: string | null = null,
): CountedRating[] {
  const self = rated?.toLowerCase();
  const raters = new Set(
    [...raterWallets].map((wallet) => wallet.toLowerCase()).filter((wallet) => wallet !== self),
  );
  const latest = new Map<string, CountedRating>();
  for (const entry of entries) {
    const client = entry.client.toLowerCase();
    if (!raters.has(client)) continue;
    const stars = starsOf(entry);
    if (stars === null) continue;
    const kept = latest.get(client);
    if (!kept || entry.index > kept.index)
      latest.set(client, { client, index: entry.index, stars });
  }
  return [...latest.values()].sort((a, b) => (a.client < b.client ? -1 : 1));
}

/**
 * The average of the counted ratings with one decimal, rounded half up on the exact fraction (no
 * floating point: 29 stars from 20 raters is 1.45, shown "1.5"); null when none counts.
 */
export function averageOf(ratings: readonly CountedRating[]): CityScore | null {
  const raters = ratings.length;
  if (raters === 0) return null;
  const stars = ratings.reduce((sum, rating) => sum + rating.stars, 0);
  // round(10 × stars / raters), halves up.
  const tenths = Math.floor((20 * stars + raters) / (2 * raters));
  return { average: `${Math.floor(tenths / 10)}.${tenths % 10}`, raters };
}

/**
 * The Central City score of the feedback entries, counting only `raterWallets` and never the
 * rated agent's own wallet `rated`.
 */
export function cityScore(
  entries: readonly RatingFeedback[],
  raterWallets: Iterable<string>,
  rated: string | null = null,
): CityScore | null {
  return averageOf(latestRatings(entries, raterWallets, rated));
}

const count = new Intl.NumberFormat('en-US');

/** "4.6 ★ from 12 Central City agents" ("from 1 Central City agent"). */
export function scoreLine(score: CityScore): string {
  return `${score.average} ★ from ${count.format(score.raters)} Central City agent${score.raters === 1 ? '' : 's'}`;
}

/** Shown where an agent's score was read and none counts. */
export const NO_SCORE_LINE = 'No Central City ratings yet';
