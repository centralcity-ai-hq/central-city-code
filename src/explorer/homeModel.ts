import type { StatsResponse } from '../agentCount';

/*
 * The Explorer home's pure rules (review #616): how a partial stats answer merges, what a search
 * looks for, and what a live feed may claim about itself.
 */

/** A stats answer may leave a number out: keep the last known value instead of erasing it. */
export function mergeStats(prev: StatsResponse | null, next: StatsResponse): StatsResponse {
  if (!prev) return next;
  return {
    ...next,
    agents: next.agents ?? prev.agents,
    paid: next.paid ?? prev.paid,
    base: next.base ?? prev.base,
  };
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** A transaction hash searches the paid calls; anything else the agents on Base. */
export function searchKind(q: string): 'tx' | 'agents' | 'empty' {
  const text = q.trim();
  if (!text) return 'empty';
  return TX_HASH.test(text) ? 'tx' : 'agents';
}

export type FeedState = { lastOk: number | null; failed: boolean };
export type FeedStatus = 'loading' | 'live' | 'stale' | 'failed';

/**
 * What a feed may say: loading before any answer, failed if nothing ever arrived, stale when the
 * last good answer is older than three refreshes or the latest read failed, else live.
 */
export function feedStatus(feed: FeedState, now: number, everyMs: number): FeedStatus {
  if (feed.lastOk === null) return feed.failed ? 'failed' : 'loading';
  if (feed.failed || now - feed.lastOk > everyMs * 3) return 'stale';
  return 'live';
}

/**
 * The poller's rule (useVisiblePoll): one read at a time, but a read that has not settled after
 * `stuckMs` no longer blocks the next one; every read gets isCurrent(), true only while it is the
 * newest, so a superseded read that settles late commits nothing and never clears the newer
 * read's busy mark.
 */
export function createPollState(stuckMs: number) {
  let generation = 0;
  // When the read in flight started, or null when none is in flight.
  let busySince: number | null = null;
  let busyOf = 0;
  return {
    /** A new read's isCurrent and its done(), or null while a read in flight still counts. */
    begin(now: number): { isCurrent: () => boolean; done: () => void } | null {
      if (busySince !== null && now - busySince <= stuckMs) return null;
      const mine = ++generation;
      busySince = now;
      busyOf = mine;
      return {
        isCurrent: () => generation === mine,
        done: () => {
          if (busyOf === mine) busySince = null;
        },
      };
    },
    /** Stop: every read in flight is no longer current. */
    stop() {
      generation += 1;
    },
  };
}

/** The kinds the typed search (GET /api/public/base/search, #630) takes. */
export type TypedKind = 'baseId' | 'shortId' | 'address' | 'txHash' | 'name';

/**
 * The kind a search box query is read as: a 0x40 hex is an agent wallet, a 0x64 hex a
 * transaction, digits a Base ID, six letters or digits a short id, anything else a name.
 * forceName reads it as a name whatever its shape (a numeric or six-character name).
 */
export function typedKind(q: string, forceName = false): TypedKind | null {
  const text = q.trim();
  if (!text) return null;
  if (forceName) return text.length >= 2 ? 'name' : null;
  if (/^0x[0-9a-fA-F]{40}$/.test(text)) return 'address';
  if (/^0x[0-9a-fA-F]{64}$/.test(text)) return 'txHash';
  if (/^(0|[1-9][0-9]{0,77})$/.test(text)) return 'baseId';
  if (/^[0-9A-Za-z]{6}$/.test(text)) return 'shortId';
  return text.length >= 2 ? 'name' : null;
}

/** Whether a query read as an identifier could also be a public name ("Search names instead"). */
export function couldBeName(q: string): boolean {
  const kind = typedKind(q);
  return kind === 'baseId' || kind === 'shortId';
}
