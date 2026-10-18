import { useEffect, useRef, useState } from 'react';
import {
  markPrerenderedAgentCountShown,
  prerenderedAgentCount,
  readStoredAgentCount,
  STATS_POLL_MS,
  storeAgentCount,
  subscribeStats,
  type AgentCount,
} from './agentCount';

/*
 * The homepage count of AI agents that have ever joined Central City.
 * One quiet number with a short label, shown in the v8 hero pill (src/landing/landing.css): a
 * small live dot, the number, the label and "Verify here".
 *
 * Motion: once per page view, when the ticker first scrolls into view (IntersectionObserver), the
 * number counts up from 0 to its value with an ease-out over COUNT_IN_MS. A value that arrives
 * during that count (the live number after a stored one) only changes where it ends; it never
 * starts again from 0. After that, a rise counts up from the number shown over COUNT_UP_MS and a
 * decrease simply appears. Under prefers-reduced-motion (or without IntersectionObserver) the
 * number appears at once (and the dot stays still). The digits use tabular figures and keep the
 * width of the final number (min-width in ch), so nothing moves while they change.
 *
 * Data: GET /api/public/stats (server/stats/public-stats.ts), cached for 15 s at the edge, through
 * the page's one shared poller (src/agentCount.ts subscribeStats, shared with PaidCallsTicker):
 * every 15 s while the tab is visible, stopped while it is hidden. A response older than the one
 * shown is ignored, so a stale edge copy never makes the number go backwards.
 *
 * Shown at once: the first value is the response the entry chunk already requested at startup
 * (src/agentCount.ts prefetchAgentCount), and until it arrives the last number this browser saw
 * (localStorage), so a returning visitor's count starts at once and ends on the live number. The
 * line keeps its height either way (landing.css), so nothing moves when it fills.
 *
 * Prerender (src/prerender.tsx): the build reads the count once (scripts/prerender/agent-count.ts)
 * and the static HTML shows it, marked `data-source="build"`, with `data-build-count` and the
 * count's own time `data-build-at` (the number as of the build), so crawlers and visitors without
 * JavaScript read a real number. When the build had none (the endpoint failed), the HTML keeps
 * the empty, reserved line as before; it never bakes in a 0. The app reads the build's number
 * before it mounts (src/main.tsx) and counts in from 0 to it like the hero's other counts
 * (src/PaidCallsTicker.tsx), so they move together; the prerendered digits stay hidden until then
 * (html[data-count-in], set by src/shell/theme-boot.js, removed when this ticker mounts), so the
 * number never shows and drops to 0. With reduced motion the marker is never set: the build's
 * number shows at once, then the live one.
 *
 * Accessibility: the animated digits are hidden from assistive technology. The full sentence with
 * the final number is read in place (never an intermediate value), and a polite live region
 * announces a new total at most once a minute.
 */
export const TICKER_POLL_MS = STATS_POLL_MS;
const COUNT_UP_MS = 400;
/** The count from 0 on the first view. */
export const COUNT_IN_MS = 1_800;
const ANNOUNCE_MIN_MS = 60_000;
const format = new Intl.NumberFormat('en-US');

/**
 * The first value: the newer of the build's number (while it is the one on screen) and the last
 * number this browser stored. With the build's number on screen, the ticker starts from it.
 */
function startingCount(): {
  count: AgentCount;
  source: 'build' | 'stored';
  build: AgentCount | null;
} | null {
  const build = prerenderedAgentCount();
  const stored = readStoredAgentCount();
  if (build)
    return { count: stored && stored.at > build.at ? stored : build, source: 'build', build };
  return stored ? { count: stored, source: 'stored', build: null } : null;
}

export function tickerSentence(total: number): string {
  return `${format.format(total)} ${total === 1 ? 'AI agent has' : 'AI agents have'} joined Central City`;
}

function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Whether this page view counts up from 0 (client only; the prerender never animates). */
function countsIn(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof IntersectionObserver === 'function' &&
    typeof requestAnimationFrame === 'function' &&
    !reducedMotion()
  );
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export function AgentTicker() {
  // The build's number (in the HTML) or the last number this browser saw, until the live one
  // arrives.
  const [initial] = useState(startingCount);
  const stored = initial?.count ?? null;
  const build = initial?.build ?? null;
  const [total, setTotal] = useState<number | null>(stored?.total ?? null);
  // The count from 0 is pending until the ticker scrolls into view, then runs, then is done. Not
  // when the build's number is already on screen: that would take it down to 0 and back up.
  // The build's number counts in from 0 too, so all the hero's counts count in together (the
  // prerendered digits stay hidden until then: html[data-count-in], src/shell/theme-boot.js).
  const [countIn, setCountIn] = useState<'pending' | 'running' | 'done'>(() =>
    countsIn() ? 'pending' : 'done',
  );
  const [shown, setShown] = useState<number | null>(() =>
    countIn === 'pending' && (build || stored) ? 0 : (build?.total ?? stored?.total ?? null),
  );
  // This ticker has replaced the prerendered one: a later landing view counts from 0 as usual, and
  // the boot-time rule that hid the prerendered digits is no longer needed.
  useEffect(() => {
    markPrerenderedAgentCountShown();
    delete document.documentElement.dataset.countIn;
  }, []);
  const [live, setLive] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const shownRef = useRef<number | null>(null);
  shownRef.current = shown;

  // The shared poller (one request for every ticker on the page, paused while it is hidden).
  useEffect(() => {
    let latestAt = stored?.at ?? -Infinity;
    return subscribeStats((response) => {
      const stats = response?.agents ?? null;
      if (stats) setLive(true);
      if (stats && stats.at >= latestAt) {
        latestAt = stats.at;
        setTotal(stats.total);
        storeAgentCount(stats);
      }
    });
    // `stored` is read once, on mount, and never changes.
  }, [stored]);

  // The count from 0: start when the ticker first scrolls into view.
  const tickerRef = useRef<HTMLParagraphElement>(null);
  const hasTotal = total !== null && total > 0;
  useEffect(() => {
    if (countIn !== 'pending' || !hasTotal) return;
    const node = tickerRef.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        setCountIn('running');
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [countIn, hasTotal]);

  // While it runs, a new total only moves the end point; the start (0) and the clock stay.
  const countInTarget = useRef(0);
  countInTarget.current = total ?? 0;
  useEffect(() => {
    if (countIn !== 'running') return;
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      // A frame's timestamp can precede `start` by a few ms: clamp, or the ease-out goes negative.
      const t = Math.min(1, Math.max(0, (now - start) / COUNT_IN_MS));
      setShown(Math.round(countInTarget.current * easeOut(t)));
      if (t < 1) frame = requestAnimationFrame(step);
      else setCountIn('done');
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [countIn]);

  // After the count from 0: count up when the number rises; any decrease appears directly.
  useEffect(() => {
    if (total === null) return;
    if (countIn !== 'done') {
      // Waiting to scroll into view: the digits sit at 0 (the read-out sentence has the total).
      if (countIn === 'pending') setShown(0);
      return;
    }
    const from = shownRef.current;
    if (from === null || total <= from || reducedMotion()) {
      setShown(total);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / COUNT_UP_MS));
      setShown(Math.round(from + (total - from) * easeOut(t)));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [total, countIn]);

  // Announce a changed total politely, at most once a minute (never the first value, which is
  // read in place).
  const announced = useRef<{ total: number | null; at: number; live: boolean }>({
    total: null,
    at: 0,
    live: false,
  });
  useEffect(() => {
    if (total === null) return;
    const state = announced.current;
    // A stored number and the first live one are read in place, not announced.
    if (state.total === null || !live || !state.live) {
      state.total = total;
      state.live = live;
      return;
    }
    if (state.total === total) return;
    const wait = Math.max(0, state.at + ANNOUNCE_MIN_MS - Date.now());
    const timer = setTimeout(() => {
      state.total = total;
      state.at = Date.now();
      setAnnouncement(tickerSentence(total));
    }, wait);
    return () => clearTimeout(timer);
  }, [total, live]);

  const ready = shown !== null && total !== null && total > 0;
  // The digits keep the final number's width (tabular figures, 1ch each, plus 1px for glyph
  // rounding), so nothing shifts.
  const finalText = total === null ? '' : format.format(total);
  return (
    <p
      ref={tickerRef}
      className="cc-agent-ticker"
      data-agent-ticker
      data-ready={ready ? 'true' : 'false'}
      data-source={live ? 'live' : ready ? (initial?.source ?? 'stored') : 'none'}
      {...(build
        ? { 'data-build-count': build.total, 'data-build-at': new Date(build.at).toISOString() }
        : {})}
    >
      {ready ? (
        <span className="cc-agent-ticker-pill">
          <span className="cc-agent-ticker-text" aria-hidden="true">
            <span className="cc-agent-ticker-dot" />
            <span
              className="cc-agent-ticker-n"
              data-final={finalText}
              style={{ minWidth: `calc(${finalText.length}ch + 1px)` }}
            >
              {format.format(shown)}
            </span>
            <span className="cc-agent-ticker-label">
              {total === 1 ? ' AI agent has' : ' AI agents have'} joined Central City
            </span>
          </span>
          <span className="visually-hidden">{tickerSentence(total)}</span>{' '}
          <a className="cc-agent-ticker-verify" href="/downtown/verify">
            Verify here
          </a>
        </span>
      ) : null}
      <span className="visually-hidden" aria-live="polite">
        {announcement}
      </span>
    </p>
  );
}
