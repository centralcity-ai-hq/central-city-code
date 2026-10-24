import { useEffect, useRef, useState } from 'react';
import {
  markPrerenderedAgentCountShown,
  prerenderedAgentCount,
  prerenderedBaseAgents,
  readStoredAgentCount,
  readStoredLiveNumbers,
  storeAgentCount,
  storeLiveNumbers,
  STATS_POLL_MS,
  subscribeStats,
  type StatsRates,
} from '../agentCount';
import { PAID_CALLS_DOCS_HREF } from '../../shared/paid-calls';

/*
 * The homepage's live numbers (design v10, 19 Oct 2026), directly under the headline: total
 * value settled, paid service calls, Base agents and AI agents joined. Every number comes from GET
 * /api/public/stats through the shared poller (src/agentCount.ts); nothing is invented. A number
 * not known yet shows a dash, in a cell that already has its final size, so nothing moves.
 *
 * Every number starts from the last one known, so a dash shows only to a first-time visitor
 * before the first answer: the AI agents and Base agents numbers from the build's (prerendered,
 * data-build-count and data-build-base) or else the last ones this browser saw; the value settled
 * and the paid service calls from the last ones this browser saw only (they are never baked into
 * the HTML, scripts/prerender/agent-count.ts). Until the server answers on this page the label
 * says Central City, not live (data-fresh="saved"). An answer that leaves a number out keeps the
 * last known one, and every answer's numbers are stored for the next visit.
 *
 * Each number counts up to every answer (from what is shown, so it never drops), the later ones
 * across the poll interval so the numbers tick up live. Reduced motion: no count-up.
 */
const format = new Intl.NumberFormat('en-US');
/** Without an animation frame by then, the numbers are set directly (no count). */
export const FRAME_GUARD_MS = 1_000;
/** On the first answer the numbers start this many seconds behind and count up at the real rate. */
const LAG_S = 30;

interface Values {
  value: number | null;
  paid: number | null;
  base: number | null;
  agents: number | null;
}

/** Whole US dollars from USDC base units (6 decimals) as decimal text. */
function dollars(raw: string): number {
  return Number(BigInt(raw) / 1_000_000n);
}

/** What the page shows before its first answer: the build's numbers, else the stored ones. */
function startingValues(build: { agents: number | null; base: number | null }): Values {
  const stored = readStoredLiveNumbers();
  return {
    value: stored.value ? dollars(stored.value.raw) : null,
    paid: stored.paid?.total ?? null,
    base: build.base ?? stored.base?.total ?? null,
    agents: build.agents ?? readStoredAgentCount()?.total ?? null,
  };
}

export function LiveNumbers() {
  const [build] = useState(() => prerenderedAgentCount());
  const [buildBase] = useState(() => prerenderedBaseAgents());
  const [target, setTarget] = useState<Values>(() =>
    startingValues({ agents: build?.total ?? null, base: buildBase?.total ?? null }),
  );
  const [shown, setShown] = useState<Values>(target);
  const counted = useRef(false);
  // True once an answer has arrived: the starting numbers are not counted, only answers are.
  const answered = useRef(false);
  // Growth per second of each number, as the last answer gave it (empty until the server knows).
  const rates = useRef<StatsRates>({});
  // True once the server has answered: before that only the build's or this browser's last count shows.
  const [live, setLive] = useState(false);

  useEffect(() => {
    markPrerenderedAgentCountShown();
    return subscribeStats((response) => {
      // A failed load keeps the numbers but stops calling them live until the next answer.
      if (!response) {
        setLive(false);
        return;
      }
      if (response.agents) storeAgentCount(response.agents);
      storeLiveNumbers(response);
      answered.current = true;
      if (response.rates) rates.current = response.rates;
      setTarget((previous) => {
        const next: Values = {
          agents: response.agents?.total ?? previous.agents,
          // A validated number, zero included, replaces the last one; only a missing field keeps it.
          base: response.base ? response.base.total : previous.base,
          paid: response.paid ? response.paid.total : previous.paid,
          value:
            typeof response.paid?.valueRaw === 'string'
              ? dollars(response.paid.valueRaw)
              : previous.value,
        };
        // The same numbers again (a cached answer): keep the running count, do not restart it.
        const same = (Object.keys(next) as (keyof Values)[]).every((k) => next[k] === previous[k]);
        return same ? previous : next;
      });
      setLive(true);
    });
  }, []);

  // The numbers always count up. On the first answer, when the server knows how fast they grow,
  // each number counts up fast (1.3 s) to its value of LAG_S seconds ago and then on at that real
  // rate to the answered value, so it is moving from the first second and never shows more than
  // was answered. Without rates the first answer counts up in 1.3 s. Every later answer counts on
  // from the current number to the new one across two polls (30 s), so they keep ticking up live.
  // A number that went down (a correction) is set at once. Reduced motion: set at once.
  const current = useRef<Values>(shown);
  current.current = shown;
  // What the page showed first (the build's or this browser's last count): a count never goes
  // below it unless the answer itself is lower.
  const floor = useRef<Values>(shown);
  useEffect(() => {
    const reduce =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ready =
      answered.current && (target.paid !== null || target.base !== null || target.value !== null);
    if (reduce || !ready) {
      setShown(target);
      return;
    }
    const first = !counted.current;
    counted.current = true;
    const from = current.current;
    const perSecond: Record<keyof Values, number | undefined> = {
      value: rates.current.valueRaw === undefined ? undefined : rates.current.valueRaw / 1_000_000,
      paid: rates.current.paid,
      base: rates.current.base,
      agents: rates.current.agents,
    };
    // First answer: where the fast count stops (the value LAG_S ago, never below what is shown).
    const lagged = (key: keyof Values) => {
      const to = target[key];
      if (to === null) return null;
      const rate = perSecond[key];
      const base = Math.max(from[key] ?? 0, Math.min(to, floor.current[key] ?? 0));
      if (!first || rate === undefined || rate <= 0) return to;
      return Math.max(base, Math.min(to, to - rate * LAG_S));
    };
    const mid = {
      value: lagged('value'),
      paid: lagged('paid'),
      base: lagged('base'),
      agents: lagged('agents'),
    };
    const anyLag = (Object.keys(mid) as (keyof Values)[]).some(
      (k) => mid[k] !== null && mid[k] !== target[k],
    );
    const start = performance.now();
    const fast = 1_300;
    // Two polls long: the stats answer may repeat a cached value for a poll or two, and spreading
    // each count over two intervals keeps the numbers moving instead of stopping and starting.
    const length = first ? (anyLag ? fast + LAG_S * 1_000 : fast) : 2 * STATS_POLL_MS;
    let frame = 0;
    // Whether the count has drawn a frame: where animation frames are paused or throttled (a
    // background tab, power saving, an embedded or in-app browser) it never would, and the numbers
    // would stay at "–" or the stored ones. Then they are set directly after FRAME_GUARD_MS.
    let ticked = false;
    const tick = (now: number) => {
      ticked = true;
      const t = now - start;
      const step = (key: keyof Values) => {
        const to = target[key];
        if (to === null) return null;
        const base = Math.max(from[key] ?? 0, Math.min(to, floor.current[key] ?? 0));
        if (!first) {
          if (to <= base) return to;
          return Math.round(base + (to - base) * Math.min(1, t / length));
        }
        // A first answer at or below what is shown (an older cached copy, a correction) is set at
        // once, never counted down.
        if (to <= base) return to;
        const m = mid[key] ?? to;
        if (t < fast) {
          // Fast, easing out, to the value LAG_S ago.
          const e = 1 - Math.pow(1 - Math.min(1, t / fast), 4);
          return Math.round(base + (m - base) * e);
        }
        // Then steadily, at the real rate, to the answered value.
        const k = Math.min(1, (t - fast) / (LAG_S * 1_000));
        return Math.round(m + (to - m) * k);
      };
      setShown({
        value: step('value'),
        paid: step('paid'),
        base: step('base'),
        agents: step('agents'),
      });
      if (t < length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const guard = window.setTimeout(() => {
      if (ticked) return;
      cancelAnimationFrame(frame);
      setShown(target);
    }, FRAME_GUARD_MS);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(guard);
    };
  }, [target]);

  const n = (value: number | null) => (value === null ? '–' : format.format(value));
  const sentence = [
    target.value !== null ? `$${format.format(target.value)} total value settled` : null,
    target.paid !== null ? `${format.format(target.paid)} paid service calls` : null,
    target.base !== null ? `${format.format(target.base)} Central City base agents` : null,
    target.agents !== null ? `${format.format(target.agents)} AI agents joined` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="cc-kpis" data-live-numbers>
      <div className="cc-khead">
        <span className="cc-kl" data-fresh={live ? 'live' : 'saved'}>
          {live ? <span className="cc-live" aria-hidden="true" /> : null}
          {live ? 'Central City, live' : 'Central City'}
        </span>
        <a className="cc-kv" href={PAID_CALLS_DOCS_HREF}>
          Verify on Base
        </a>
      </div>
      <dl className="cc-kgrid" aria-hidden="true">
        <div className="cc-kc" data-stat="value">
          <dt>Total value settled (x402)</dt>
          <dd>
            <span className="cc-cur">$</span>
            {n(shown.value)}
            <span className="cc-unit">USDC</span>
          </dd>
        </div>
        <div className="cc-kc" data-stat="paid">
          <dt>Paid service calls</dt>
          <dd>{n(shown.paid)}</dd>
        </div>
        <div
          className="cc-kc"
          data-stat="base"
          data-build-base={buildBase ? String(buildBase.total) : undefined}
          data-build-base-at={buildBase ? new Date(buildBase.asOf).toISOString() : undefined}
        >
          <dt>Central City base agents</dt>
          <dd>{n(shown.base)}</dd>
        </div>
        <div
          className="cc-kc"
          data-stat="agents"
          data-agent-ticker
          data-build-count={build ? String(build.total) : undefined}
          data-build-at={build ? new Date(build.at).toISOString() : undefined}
        >
          <dt>AI agents joined</dt>
          <dd>{n(shown.agents)}</dd>
        </div>
      </dl>
      <p className="visually-hidden">
        {sentence
          ? `${live ? 'Live on Central City' : 'Central City, last known'}: ${sentence}.`
          : 'Numbers of Central City.'}
      </p>
    </div>
  );
}
