/*
 * "Ratings given" on the Rate screen (Operation Rating; the product owner's call after the first
 * real rating: see the agents you rated, and rate one again). Plain rules, no React, no requests:
 * what each stored state reads as, which rating per agent is shown, and which ones are still on
 * their way. Never "final" before Base says final.
 */
import type { RatingGiven } from '../../base/wallet/rate';

export const GIVEN_FINAL = 'Rated ✓ · on Base';
export const GIVEN_ON_BASE = 'On Base · final in about 15 minutes';
export const GIVEN_ON_ITS_WAY = 'On its way to Base';
export const GIVEN_FAILED = 'Didn’t go through';
export const GIVEN_CANCELLED = 'Cancelled';
export const GIVEN_NEVER_SENT = 'Never sent';
/** Once, under the list: rating an agent again replaces the earlier rating. */
export const GIVEN_NOTE = 'Your latest rating counts.';

export type GivenPhase = 'final' | 'on_base' | 'on_its_way' | 'failed' | 'cancelled' | 'expired';

/**
 * What a listed rating says. Final only when stored final. In a block (included) it is on Base and
 * final follows in about 15 minutes; when the server says the block isn't at Base's safe head yet
 * (`safe` false), it is still on its way. Prepared, sent, or with a cancel asked for: on its way.
 */
export function givenStatus(row: Pick<RatingGiven, 'state' | 'safe'>): {
  phase: GivenPhase;
  line: string;
} {
  switch (row.state) {
    case 'final':
      return { phase: 'final', line: GIVEN_FINAL };
    case 'included':
      return row.safe === false
        ? { phase: 'on_its_way', line: GIVEN_ON_ITS_WAY }
        : { phase: 'on_base', line: GIVEN_ON_BASE };
    case 'failed':
      return { phase: 'failed', line: GIVEN_FAILED };
    case 'cancelled':
      return { phase: 'cancelled', line: GIVEN_CANCELLED };
    case 'expired':
      return { phase: 'expired', line: GIVEN_NEVER_SENT };
    default:
      return { phase: 'on_its_way', line: GIVEN_ON_ITS_WAY };
  }
}

/** Not done yet: Base may still change what it reads as (the list is read again meanwhile). */
export const givenOpen = (row: Pick<RatingGiven, 'state'>) =>
  row.state === 'awaiting_signature' ||
  row.state === 'submitted' ||
  row.state === 'included' ||
  row.state === 'cancel_pending';

/** Signed and not done: reading it on the withdrawal route follows it on Base. */
export const givenFollowed = (row: Pick<RatingGiven, 'state'>) =>
  givenOpen(row) && row.state !== 'awaiting_signature';

/** Never landed: it rated nothing (an earlier rating of the same agent still counts). */
const nothingRated = (row: Pick<RatingGiven, 'state'>) =>
  row.state === 'failed' || row.state === 'cancelled' || row.state === 'expired';

/**
 * One row per rated agent, newest first: its latest rating, the one that counts. A latest that
 * rated nothing (failed, cancelled, never sent) gives way to the latest that did or still may; an
 * agent whose ratings all rated nothing shows its latest, so the owner sees it didn't go through.
 */
export function latestPerAgent(rows: readonly RatingGiven[]): RatingGiven[] {
  const byAgent = new Map<string, RatingGiven[]>();
  for (const row of rows) {
    const list = byAgent.get(row.ratedAgentId) ?? [];
    list.push(row);
    byAgent.set(row.ratedAgentId, list);
  }
  const newest = (a: RatingGiven, b: RatingGiven) =>
    b.createdAt - a.createdAt || (a.withdrawalId < b.withdrawalId ? 1 : -1);
  const shown: RatingGiven[] = [];
  for (const list of byAgent.values()) {
    list.sort(newest);
    shown.push(list.find((row) => !nothingRated(row)) ?? list[0]!);
  }
  return shown.sort(newest);
}

/** The rated agent as shown: its public name, else its passport number, else its Base ID. */
export const givenName = (row: Pick<RatingGiven, 'name' | 'short' | 'baseId'>) =>
  row.name.trim() || (row.short ? `CC-${row.short}` : `Base ID ${row.baseId}`);

/** "Oct 11", as the wallet's other lists date a row. */
export const givenDate = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
