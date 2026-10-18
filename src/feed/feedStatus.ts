import { useEffect, useState, useSyncExternalStore } from 'react';
import type { FeedStatus } from '../../shared/feed';

/*
 * Is the Feed on? GET /api/public/feed (shared/feed.ts FEED_PATHS.status) answers 200 with the
 * Feed's status while the Feed is on and 404 when it is switched off (CITY_FEED=0). The
 * workspace sidebar asks once per page load and shows its Feed entry only on a 200; Root asks again each time a Feed address
 * opens (useFeedCheck). Both read the same answer, so turning the Feed off hides the entry as
 * soon as the page learns it, and a question still on its way is never asked twice.
 * Kept free of the Feed's other modules: the sidebar is in every workspace page, and Root decides
 * with it before the Feed's code is fetched.
 */

/** FEED_PATHS.status (tests/feed-ui.test.ts keeps the two equal). */
export const FEED_STATUS_PATH = '/api/public/feed';

export type FeedGate =
  | { phase: 'on'; status: FeedStatus }
  | { phase: 'off' }
  /**
   * No answer, or one that is neither 200 nor 404: no entry; the page offers a retry. `limited`:
   * the last answer was 429 (too many tries from this address), so the page says to wait.
   */
  | { phase: 'error'; limited?: true };

let pending: Promise<FeedGate> | null = null;
/** When `pending` was asked (Date.now()). */
let pendingAt = 0;
/** The request still on its way, if any: every caller shares it, `fresh` or not. */
let inFlight: Promise<FeedGate> | null = null;
let known: FeedGate | null = null;
const listeners = new Set<() => void>();

function remember(gate: FeedGate) {
  // A failed re-check keeps a Feed this page load already saw on (its counts stay as they were).
  if (gate.phase === 'error' && known?.phase === 'on') return;
  known = gate;
  for (const listener of listeners) listener();
}

/** Root asks again when a Feed address opens, unless the answer it has is this recent. */
export const FEED_RECHECK_MS = 10_000;

/**
 * A check with no answer, or one that is neither 200 nor 404, is asked again after each of these
 * waits before the page says the Feed couldn't be loaded: a moment of server trouble is not a Feed
 * that is down. A 429 is not asked again: this address was just told to wait.
 */
export const FEED_GATE_RETRY_MS = [1_000, 3_000];

/**
 * A status read that has not answered by then is given up (a stalled database or function would
 * otherwise keep "Opening Central City" up for minutes): the page then offers Try again. A read
 * that stalled is not asked again by itself either; the server was just slow, not briefly down.
 */
export const FEED_GATE_TIMEOUT_MS = 8_000;

/** An answer, and whether the read was given up for taking too long. */
type Asked = { gate: FeedGate; stalled: boolean };

function askGate(fetcher: typeof fetch, timeoutMs: number): Promise<Asked> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetcher(FEED_STATUS_PATH, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    signal: controller.signal,
  })
    .then(async (response): Promise<Asked> => {
      // The body is always read: an unread one keeps the request (and its connection) open.
      const body = (await response.json().catch(() => null)) as FeedStatus | null;
      if (response.status === 404) return { gate: { phase: 'off' }, stalled: false };
      if (response.status === 429)
        return { gate: { phase: 'error', limited: true }, stalled: false };
      // A body that stalled past the deadline (a 200 too) is a stalled read, not asked again.
      if (!response.ok || !body)
        return { gate: { phase: 'error' }, stalled: controller.signal.aborted };
      return { gate: { phase: 'on', status: body }, stalled: false };
    })
    .catch((): Asked => ({ gate: { phase: 'error' }, stalled: controller.signal.aborted }))
    .finally(() => clearTimeout(timer));
}

/**
 * The gate. One request per page load, shared by the sidebar and the page. `maxAgeMs` asks again
 * when the answer is older than that (Root does, so a Feed turned on or off a minute ago shows as
 * it is now); `fresh` always asks again. A request still on its way is shared by every caller.
 */
export function loadFeedGate(
  options: {
    fresh?: boolean;
    maxAgeMs?: number;
    fetcher?: typeof fetch;
    /** FEED_GATE_RETRY_MS (tests pass zeros). */
    retryMs?: readonly number[];
    /** FEED_GATE_TIMEOUT_MS (tests pass less). */
    timeoutMs?: number;
  } = {},
): Promise<FeedGate> {
  if (inFlight) return inFlight;
  const maxAge = options.fresh ? 0 : (options.maxAgeMs ?? Infinity);
  if (pending && Date.now() - pendingAt < maxAge) return pending;
  const fetcher = options.fetcher ?? fetch;
  const retryMs = options.retryMs ?? FEED_GATE_RETRY_MS;
  const timeoutMs = options.timeoutMs ?? FEED_GATE_TIMEOUT_MS;
  const asked: Promise<FeedGate> = (async () => {
    let answer = await askGate(fetcher, timeoutMs);
    for (const ms of retryMs) {
      if (answer.gate.phase !== 'error' || answer.gate.limited || answer.stalled) break;
      await new Promise((resolve) => setTimeout(resolve, ms));
      answer = await askGate(fetcher, timeoutMs);
    }
    return answer.gate;
  })().then((gate) => {
    if (inFlight === asked) inFlight = null;
    remember(gate);
    // A failed check may be asked again by the next caller.
    if (gate.phase === 'error' && pending === asked) pending = null;
    return gate;
  });
  pending = asked;
  pendingAt = Date.now();
  inFlight = asked;
  return asked;
}

/** The last answer this page load got, if any. */
export function knownFeedGate(): FeedGate | null {
  return known;
}

/** For tests: forget this page load's answer. */
export function resetFeedGate() {
  pending = null;
  pendingAt = 0;
  inFlight = null;
  known = null;
  retriedAt = -Infinity;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The gate as this page load knows it (null until the first answer). */
export function useFeedGate(): FeedGate | null {
  return useSyncExternalStore(subscribe, knownFeedGate, () => null);
}

/** A sidebar that could not learn the status asks again after this long (and on focus, online). */
export const FEED_SIDEBAR_RETRY_MS = 30_000;

/** When the sidebar last asked again (Date.now()); one clock for every sidebar on the page. */
let retriedAt = -Infinity;

/**
 * The sidebar asks again after a failed answer (`trigger`: its timer, window focus, the network
 * back online). At most once per FEED_SIDEBAR_RETRY_MS, however often the window gets focus; and
 * after a 429 only by the timer, since this address was just told to wait. Says whether it asked.
 */
export function retryFeedGate(
  trigger: 'timer' | 'focus' | 'online',
  options: { now?: number; fetcher?: typeof fetch; retryMs?: readonly number[] } = {},
): boolean {
  if (known?.phase !== 'error') return false;
  if (known.limited && trigger !== 'timer') return false;
  const now = options.now ?? Date.now();
  if (now - retriedAt < FEED_SIDEBAR_RETRY_MS) return false;
  retriedAt = now;
  void loadFeedGate({ fetcher: options.fetcher, retryMs: options.retryMs });
  return true;
}

/**
 * The sidebar's question: true once the Feed answered 200. Asked once per page load; a failed
 * answer (a moment of server trouble, a 429 from a busy address) is asked again after
 * FEED_SIDEBAR_RETRY_MS, and when the window gets focus or the network comes back (not after a
 * 429; at most once per FEED_SIDEBAR_RETRY_MS: retryFeedGate), so the entry is not lost for the
 * rest of the page load.
 */
export function useFeedOn(): boolean {
  const gate = useFeedGate();
  const failed = gate?.phase === 'error';
  useEffect(() => {
    if (!knownFeedGate()) void loadFeedGate();
  }, []);
  useEffect(() => {
    if (!failed) return;
    // Each failed answer is a new gate: the timer starts again from it.
    const timer = window.setTimeout(() => retryFeedGate('timer'), FEED_SIDEBAR_RETRY_MS);
    const onFocus = () => retryFeedGate('focus');
    const onOnline = () => retryFeedGate('online');
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
    };
  }, [failed, gate]);
  return gate?.phase === 'on';
}

/**
 * Root's question on a Feed address (`active`): asked again each time a Feed address opens (the
 * startup's own question counts: src/Root.tsx prefetchInitialScreen), so a Feed turned on or off
 * a minute ago shows as it is now. `answered` says whether this visit has
 * its answer yet; until then a Feed this page load already saw on opens at once, and anything
 * else waits without naming the Feed (it may be off). Moving between Feed addresses asks nothing.
 */
export function useFeedCheck(active: boolean): {
  gate: FeedGate | null;
  answered: boolean;
  retry: () => void;
} {
  // Off a Feed address the answer is not read, so a change to it never renders Root again.
  const gate = useSyncExternalStore(
    subscribe,
    () => (active ? known : null),
    () => null,
  );
  const [attempt, setAttempt] = useState(0);
  const [answered, setAnswered] = useState(false);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void loadFeedGate({ maxAgeMs: FEED_RECHECK_MS }).then(() => {
      if (live) setAnswered(true);
    });
    return () => {
      live = false;
      // Leaving the Feed, or asking again: the next answer is a new one.
      setAnswered(false);
    };
  }, [active, attempt]);
  return {
    gate,
    answered: active && answered,
    retry: () => {
      setAnswered(false);
      setAttempt((value) => value + 1);
    },
  };
}

/** True when `gate` says the Feed is on; for the flag-gating checks in tests and the page. */
export function feedShown(gate: FeedGate | null): gate is { phase: 'on'; status: FeedStatus } {
  return gate?.phase === 'on';
}
