import { useEffect, useRef, useState, type RefObject } from 'react';
import { COUNT_IN_MS } from './AgentTicker';
import {
  notePaidCallsLine,
  reservePaidCallsChip,
  reservePaidCallsLine,
  subscribeStats,
} from './agentCount';
import { accept, advance, nextDue, type ReplayState } from './paidCallsReplay';
import { baseAgentsLabel, PAID_CALLS_DOCS_HREF, paidCallsLabel } from '../shared/paid-calls';

/*
 * The live line under the agent count on the homepage: the same pill (src/landing/landing.css), a
 * live dot, "31,452 Base agents · 1,284 paid service calls" and "Verify here" (the Agent
 * Explorer's Service calls view, /explorer/calls). Every payer counts the same; nothing here
 * says who paid, which service, how much or when.
 *
 * Data: the optional `base_agents` and `paid_calls` fields of GET /api/public/stats
 * (server/stats/base-agents.ts, server/stats/paid-calls.ts), through the page's one shared poller
 * (src/agentCount.ts subscribeStats, with AgentTicker). Each part hides on its own while its field
 * is missing or its total is under 1; the line hides when both do, or when the first loads failed
 * (three in a row, about 3 s with the poller's quick retries).
 *
 * Base agents: the Agent Explorer's "On Base now" total, shown as each poll brings it (a copy
 * counted earlier than the one shown is ignored); no ticks in between, no roll.
 *
 * Each payment at its own moment (src/paidCallsReplay.ts): the number shown is the real total as it
 * stood 45 s earlier, one +1 per payment, 45 s after its Base block. A response with an older
 * `as_of` (another edge's copy) is ignored; a lower total is a repair and shows at once.
 *
 * Count-in (homepage only): once per page view, when the line first scrolls into view, both
 * numbers count up from 0 to their values over COUNT_IN_MS with the agent count's ease-out, so the
 * two pills count in together. A value that arrives during the count only moves where it ends.
 * The Feed chip shows its values at once. With reduced motion (or without IntersectionObserver)
 * the numbers appear at once.
 *
 * Motion: on each real +1 only the digits that changed roll up over 300 ms (transform only) and
 * the dot sends out one ring; between payments the dot breathes every 2 s, like the agent pill's.
 * Tabular digits keep the number's width (min-width in ch). With reduced motion the number changes
 * in place and the dot is still.
 *
 * Old copy: when the copy shown is more than DOT_GREY_MS old (the edge's Age header plus the time
 * since it arrived; no header counts as 0), the dot turns grey and stops breathing. Five minutes,
 * not two: a deploy switch or one slow refresh at the edge must not grey a line that is live. A
 * hidden tab never greys it (its poller sleeps); back in view, the first load gets a moment first.
 *
 * Layout: when the build saw the field it reserves an empty line (`data-paid-calls="1"`,
 * scripts/prerender/agent-count.ts), so the pill fills it with no shift; no number is ever baked
 * into the HTML. Otherwise the pill appears with one layout shift until the next build.
 *
 * Accessibility: the digits are hidden from assistive technology; the whole sentence is read in
 * place, and a polite live region announces a new total at most once a minute.
 */
const format = new Intl.NumberFormat('en-US');
const ANNOUNCE_MIN_MS = 60_000;
/** The roll's length (CSS cc-paid-roll); its markup is cleared when it ends, or a little after. */
const ROLL_MS = 300;

/** The whole line as one sentence, for screen readers: the parts that show. */
export function liveLineSentence(base: number | null, paid: number | null): string {
  const parts = [
    ...(base !== null ? [`${format.format(base)} ${baseAgentsLabel(base)}`] : []),
    ...(paid !== null ? [`${format.format(paid)} ${paidCallsLabel(paid)}`] : []),
  ];
  return `${parts.join(' and ')} on Central City`;
}

/** "paid service calls", whose "service" the narrowest layouts leave out (CSS). */
function PaidLabel({ total, prefix }: { total: number; prefix: 'cc-paid' | 'fd-paid' }) {
  return (
    <>
      paid <span className={`${prefix}-long`}>service </span>
      {total === 1 ? 'call' : 'calls'}
    </>
  );
}

/** Failed loads in a row (the poller's quick first retries) before a reserved, empty line closes. */
const FAILURES_BEFORE_CLOSE = 3;

/** A copy older than this greys the live dot (client only; the server's limit is its own). */
export const DOT_GREY_MS = 5 * 60_000;
/** Back in view, the poller's first load gets this long before the dot is judged again. */
const VISIBLE_GRACE_MS = 5_000;

/** How old a copy is now: its Age at the edge plus the time since it arrived. */
export function copyAgeMs(copy: { ageS: number; arrived: number }, now: number): number {
  return copy.ageS * 1000 + Math.max(0, now - copy.arrived);
}

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

function countsIn(): boolean {
  return (
    typeof IntersectionObserver === 'function' &&
    typeof requestAnimationFrame === 'function' &&
    !reducedMotion()
  );
}

/**
 * The homepage count-in: 0 until the line first scrolls into view, then the eased share of the
 * way (0 to 1) over COUNT_IN_MS, then null (done: show the values as they are).
 */
function useCountIn(node: RefObject<HTMLElement | null>, ready: boolean): number | null {
  const [phase, setPhase] = useState<'pending' | 'running' | 'done'>(() =>
    countsIn() ? 'pending' : 'done',
  );
  const [share, setShare] = useState(0);
  useEffect(() => {
    if (phase !== 'pending' || !ready || !node.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        setPhase('running');
      }
    });
    observer.observe(node.current);
    return () => observer.disconnect();
  }, [phase, ready, node]);
  useEffect(() => {
    if (phase !== 'running') return;
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      // A frame's timestamp can precede `start` by a few ms: clamp, or the ease-out goes negative.
      const t = Math.min(1, Math.max(0, (now - start) / COUNT_IN_MS));
      setShare(easeOut(t));
      if (t < 1) frame = requestAnimationFrame(step);
      else setPhase('done');
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [phase]);
  return phase === 'done' ? null : share;
}

/** One rise of the number: the digits that differ roll from `from` to `to`. */
interface Roll {
  from: number;
  to: number;
  seq: number;
}

/**
 * The number, one fixed slot per character. During a roll, each digit that changed holds its old
 * value above its new one and moves up (transform only); the others stay put.
 */
function Digits({
  value,
  roll,
  prefix,
}: {
  value: number;
  roll: Roll | null;
  /** The surface's class prefix: cc-paid (homepage) or fd-paid (the Feed). */
  prefix: 'cc-paid' | 'fd-paid';
}) {
  const text = format.format(value);
  const rolling = roll !== null && roll.to === value && roll.from < value;
  const before = rolling ? format.format(roll.from).padStart(text.length, ' ') : text;
  return (
    <>
      {[...text].map((char, index) => {
        const old = before[index] ?? ' ';
        if (!rolling || old === char || !/\d/.test(char))
          return (
            <span key={index} className={`${prefix}-c`}>
              {char}
            </span>
          );
        return (
          <span key={`${roll.seq}-${index}`} className={`${prefix}-c`}>
            <span className={`${prefix}-roll`}>
              <span>{old === ' ' ? '\u00a0' : old}</span>
              <span>{char}</span>
            </span>
          </span>
        );
      })}
    </>
  );
}

/** The Base agents number as shown, with its copy's Age and arrival (for the dot's staleness). */
interface BaseCopy {
  total: number;
  asOf: number;
  ageS: number;
  arrived: number;
}

/**
 * The line as one surface shows it: the Base agents number as each poll brings it, the paid calls
 * replayed one payment at a time, whether the copy is old, the roll and ring of each real +1, and
 * the polite announcement.
 */
function useLiveLine() {
  const [replay, setReplay] = useState<ReplayState | null>(null);
  const [base, setBase] = useState<BaseCopy | null>(null);
  const baseRef = useRef<BaseCopy | null>(null);
  baseRef.current = base;
  const [answered, setAnswered] = useState(false);
  const [stale, setStale] = useState(false);
  const [roll, setRoll] = useState<Roll | null>(null);
  const [ring, setRing] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const failures = useRef(0);

  useEffect(
    () =>
      subscribeStats((response) => {
        // A failed load keeps what is shown (the dot greys once it is old). Before any answer
        // the reserved line waits through the poller's quick retries and closes only after
        // FAILURES_BEFORE_CLOSE failed loads in a row.
        if (!response) {
          failures.current += 1;
          if (failures.current >= FAILURES_BEFORE_CLOSE) setAnswered(true);
          return;
        }
        failures.current = 0;
        setAnswered(true);
        const counted = response.base;
        // A response without the Base number (a cold server instance that had no value within its
        // read budget) keeps the number already shown: the counter never blinks out between polls.
        const baseShown = Boolean((counted && counted.total >= 1) || baseRef.current);
        if (!counted || counted.total < 1) {
          if (!baseRef.current) setBase(null);
        } else
          setBase((previous) =>
            // Another edge's older copy: keep the newer number.
            previous && counted.asOf < previous.asOf
              ? previous
              : {
                  total: counted.total,
                  asOf: counted.asOf,
                  ageS: response.ageS,
                  arrived: response.arrived,
                },
          );
        const paid = response.paid;
        if (!paid || paid.total < 1) {
          // Switched off, not counted yet, or nothing paid: no paid part.
          notePaidCallsLine(baseShown);
          setReplay(null);
          return;
        }
        notePaidCallsLine(true);
        const copy = {
          total: paid.total,
          asOf: paid.asOf,
          recentMs: paid.recentMs,
          ageS: response.ageS,
          arrived: response.arrived,
        };
        setReplay((previous) => accept(previous, copy, Date.now()));
      }),
    [],
  );

  // The next payment shows when it is due.
  useEffect(() => {
    if (!replay) return;
    const at = nextDue(replay, Date.now());
    if (at === null) return;
    const timer = setTimeout(
      () => setReplay((state) => (state ? advance(state, Date.now()) : state)),
      Math.max(0, at - Date.now()) + 1,
    );
    return () => clearTimeout(timer);
  }, [replay]);

  // The dot greys once the newest copy shown is more than five minutes old, never while hidden.
  const paidCopy = replay?.copy ?? null;
  const copy =
    paidCopy && base
      ? paidCopy.arrived - paidCopy.ageS * 1000 >= base.arrived - base.ageS * 1000
        ? paidCopy
        : base
      : (paidCopy ?? base);
  useEffect(() => {
    if (!copy) return;
    const check = () => {
      if (!document.hidden) setStale(copyAgeMs(copy, Date.now()) > DOT_GREY_MS);
    };
    check();
    const age = copyAgeMs(copy, Date.now());
    const timer = age <= DOT_GREY_MS ? setTimeout(check, DOT_GREY_MS - age + 1) : undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const shown = () => {
      if (document.hidden) return;
      clearTimeout(grace);
      grace = setTimeout(check, VISIBLE_GRACE_MS);
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      clearTimeout(timer);
      clearTimeout(grace);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [copy]);

  const shown = replay?.shown ?? null;
  const baseShown = base?.total ?? null;

  // A real rise rolls the changed digits and rings the dot once; never the first value, never a
  // drop (a repair), never with reduced motion.
  const last = useRef<number | null>(null);
  useEffect(() => {
    const from = last.current;
    last.current = shown;
    if (from === null || shown === null || shown <= from || reducedMotion()) {
      setRoll(null);
      return;
    }
    setRoll((previous) => ({ from, to: shown, seq: (previous?.seq ?? 0) + 1 }));
    setRing((previous) => previous + 1);
  }, [shown]);
  // The roll's markup (old digits above new ones) is cleared once it has run.
  useEffect(() => {
    if (!roll) return;
    const timer = setTimeout(() => setRoll(null), ROLL_MS + 50);
    return () => clearTimeout(timer);
  }, [roll]);

  // Announce a changed line politely, at most once a minute (never the first, read in place).
  const announced = useRef<{ line: string | null; at: number }>({ line: null, at: 0 });
  useEffect(() => {
    if (shown === null && baseShown === null) return;
    const line = liveLineSentence(baseShown, shown);
    const state = announced.current;
    if (state.line === null) {
      state.line = line;
      return;
    }
    if (state.line === line) return;
    const wait = Math.max(0, state.at + ANNOUNCE_MIN_MS - Date.now());
    const timer = setTimeout(() => {
      state.line = line;
      state.at = Date.now();
      setAnnouncement(line);
    }, wait);
    return () => clearTimeout(timer);
  }, [shown, baseShown]);

  return {
    shown,
    baseShown,
    stale,
    roll,
    ring,
    announcement,
    answered,
    rolled: () => setRoll(null),
  };
}

export function PaidCallsTicker() {
  // The build saw the line (or an earlier view on this page did): keep it until the first
  // answer, so the pill fills it with no shift.
  const [reserved] = useState(reservePaidCallsLine);
  const { shown, baseShown, stale, roll, ring, announcement, answered, rolled } = useLiveLine();
  const lineRef = useRef<HTMLParagraphElement>(null);
  const share = useCountIn(lineRef, shown !== null || baseShown !== null);
  if (shown === null && baseShown === null) {
    // Until the first answer, the reserved line keeps its height; then it closes.
    return reserved && !answered ? (
      <p
        className="cc-agent-ticker cc-paid-ticker"
        data-paid-calls-ticker
        data-paid-calls="1"
        data-ready="false"
      />
    ) : null;
  }
  const text = shown === null ? '' : format.format(shown);
  const baseText = baseShown === null ? '' : format.format(baseShown);
  // During the count-in the digits show the counted value; widths keep the final number's.
  const counted = (value: number) => (share === null ? value : Math.round(value * share));
  return (
    <p
      ref={lineRef}
      className={`cc-agent-ticker cc-paid-ticker${stale ? ' is-stale' : ''}`}
      data-paid-calls-ticker
      data-paid-calls={reserved ? '1' : undefined}
      data-ready="true"
      data-stale={stale ? 'true' : 'false'}
    >
      <span className="cc-agent-ticker-pill">
        <span className="cc-agent-ticker-text" aria-hidden="true">
          <span className="cc-paid-dot">
            <span className="cc-agent-ticker-dot" />
            {ring > 0 && !stale ? <span key={ring} className="cc-paid-ring" /> : null}
          </span>
          {baseShown !== null ? (
            <span className="cc-base-part">
              <span
                className="cc-agent-ticker-n cc-base-n"
                style={
                  share === null ? undefined : { minWidth: `calc(${baseText.length}ch + 1px)` }
                }
              >
                {format.format(counted(baseShown))}
              </span>
              <span className="cc-agent-ticker-label">{` ${baseAgentsLabel(baseShown)}`}</span>
            </span>
          ) : null}
          {baseShown !== null && shown !== null ? (
            <span className="cc-paid-sep">{' · '}</span>
          ) : null}
          {shown !== null ? (
            <span className="cc-paid-part">
              <span
                className="cc-agent-ticker-n cc-paid-n"
                data-final={text}
                style={{ minWidth: `calc(${text.length}ch + 1px)` }}
                onAnimationEnd={rolled}
              >
                <Digits
                  value={counted(shown)}
                  roll={share === null ? roll : null}
                  prefix="cc-paid"
                />
              </span>
              <span className="cc-agent-ticker-label">
                {' '}
                <PaidLabel total={shown} prefix="cc-paid" />
              </span>
            </span>
          ) : null}
        </span>
        <span className="visually-hidden">{liveLineSentence(baseShown, shown)}</span>{' '}
        <a className="cc-agent-ticker-verify" href={PAID_CALLS_DOCS_HREF}>
          Verify here
        </a>
      </span>
      <span className="visually-hidden" aria-live="polite">
        {announcement}
      </span>
    </p>
  );
}

/**
 * The Feed head's chip (src/feed/FeedParts.tsx): the same line, shorter. "31,452 Base agents ·
 * 1,284 paid service calls" with the live dot ("paid calls" where the Feed column is narrow); no
 * link (the head already links "How the Feed works"). Shown on the
 * public and the signed-in Feed. Until the first answer it keeps an empty, hidden chip in its
 * place (unless an earlier answer on this page said there is no count), so on phones, where the
 * chip has its own line under the lede, nothing below moves when it appears; an answer with no
 * count closes that line. Styles: src/feed/feed.css (.fd-paid).
 */
export function PaidCallsChip() {
  const [reserved] = useState(() => reservePaidCallsChip());
  const { shown, baseShown, stale, roll, ring, announcement, answered, rolled } = useLiveLine();
  if (shown === null && baseShown === null)
    return reserved && !answered ? (
      <p className="fd-paid is-pending" data-paid-calls-pending aria-hidden="true" />
    ) : null;
  const text = shown === null ? '' : format.format(shown);
  return (
    <p
      className={`fd-paid${stale ? ' is-stale' : ''}`}
      data-paid-calls-ticker
      data-ready="true"
      data-stale={stale ? 'true' : 'false'}
    >
      <span className="fd-paid-dot" aria-hidden="true">
        <span className="fd-paid-core" />
        {ring > 0 && !stale ? <span key={ring} className="fd-paid-ring" /> : null}
      </span>
      {baseShown !== null ? (
        <span className="fd-base-part" aria-hidden="true">
          <span className="fd-base-n">{format.format(baseShown)}</span>
          <span className="fd-base-label">{` ${baseAgentsLabel(baseShown)}`}</span>
        </span>
      ) : null}
      {baseShown !== null && shown !== null ? (
        <span className="fd-paid-sep" aria-hidden="true">
          ·
        </span>
      ) : null}
      {shown !== null ? (
        <span className="fd-paid-part" aria-hidden="true">
          <span
            className="fd-paid-n"
            data-final={text}
            style={{ minWidth: `calc(${text.length}ch + 1px)` }}
            onAnimationEnd={rolled}
          >
            <Digits value={shown} roll={roll} prefix="fd-paid" />
          </span>
          <span className="fd-paid-label">
            {' '}
            <PaidLabel total={shown} prefix="fd-paid" />
          </span>
        </span>
      ) : null}
      <span className="visually-hidden">{liveLineSentence(baseShown, shown)}</span>
      <span className="visually-hidden" aria-live="polite">
        {announcement}
      </span>
    </p>
  );
}
