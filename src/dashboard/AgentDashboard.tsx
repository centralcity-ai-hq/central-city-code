import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { PublicHeader } from '../shell/PublicHeader';
import { PublicFooter } from '../shell/PublicFooter';
import { usePageTitle } from '../shell/usePageTitle';
import {
  DASHBOARD_CHAIN_LABELS,
  DASHBOARD_JSON_PATH,
  DASHBOARD_RANGES,
  DASHBOARD_RANGE_LABELS,
  DEFAULT_DASHBOARD_RANGE,
  compactNumber,
  type DashboardBody,
  type DashboardChainChoice,
  type DashboardRange,
} from '../../shared/dashboard';
import {
  DASHBOARD_CONTRACTS,
  basescanAddress,
  type DashboardWallet,
  type DashboardWallets,
} from '../../shared/dashboard-contracts';
import {
  SERIES_LABELS,
  TRACK_ENDPOINTS,
  busiestHour,
  cachedBody,
  changeBadge,
  loadDashboard,
  loadWallets,
  percents,
  pointValue,
  rememberBody,
  shortAddress,
  usdc,
  usdcPartsOf,
  type SeriesKey,
} from './dashboardModel';
import { useTweenedArray, useTweenedNumber } from './motion';
import './dashboard.css';

/*
 * The public Analytics page (/analytics, formerly /dashboard; approved design, 30 Oct 2026). One data set: every
 * agent, call, payment and fee on Central City on Base, from GET /api/public/dashboard. The last
 * answer this browser saw is shown at once; the page asks again every 15 s while visible.
 */

const REFRESH_MS = 15_000;
const WALLETS_REFRESH_MS = 60_000;

function useDashboard(range: DashboardRange, chain: DashboardChainChoice) {
  const [shown, setShown] = useState<{ body: DashboardBody; chain: DashboardChainChoice } | null>(
    () => {
      const cached = cachedBody(range, chain);
      return cached ? { body: cached, chain } : null;
    },
  );
  const body = shown?.body ?? null;
  const setBody = (next: DashboardBody) => setShown({ body: next, chain });
  const [failed, setFailed] = useState(false);
  const reading = useRef(false);
  useEffect(() => {
    // Keep what is on screen until the new range or chain arrives (its cached copy, at once).
    const cached = cachedBody(range, chain);
    if (cached) setBody(cached);
    setFailed(false);
    let live = true;
    const controller = new AbortController();
    const read = async () => {
      if (reading.current) return;
      reading.current = true;
      try {
        const next = await loadDashboard(range, controller.signal, chain);
        if (!live) return;
        setBody(next);
        setFailed(false);
        rememberBody(next, chain);
      } catch {
        if (live) setFailed(true);
      } finally {
        reading.current = false;
      }
    };
    void read();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void read();
    }, REFRESH_MS);
    return () => {
      live = false;
      controller.abort();
      reading.current = false;
      window.clearInterval(timer);
    };
  }, [range, chain]);
  // Another range's (or chain's) numbers may stay on screen while this one loads (smooth motion),
  // but never after it failed: then the cards show no value and the page says it did not load.
  const stale = body !== null && (body.range !== range || shown?.chain !== chain);
  return { body: failed && stale ? null : body, failed };
}

function useWallets() {
  const [wallets, setWallets] = useState<DashboardWallets | null>(null);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const read = () =>
      loadWallets(controller.signal)
        .then((w) => live && setWallets(w))
        .catch(() => undefined);
    void read();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void read();
    }, WALLETS_REFRESH_MS);
    return () => {
      live = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);
  return wallets;
}

function useNow(everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="5" y="5" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M11 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function CopyButton({
  text,
  label,
  iconOnly,
}: {
  text: string;
  label: string;
  iconOnly?: boolean;
}) {
  const [done, setDone] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setDone(true);
        window.setTimeout(() => setDone(false), 1500);
      })
      .catch(() => undefined);
  }, [text]);
  return (
    <button
      type="button"
      className={iconOnly ? 'ccd-copy ccd-copy-icon' : 'ccd-copy'}
      onClick={copy}
      aria-label={label}
      title={label}
    >
      <CopyIcon />
      {iconOnly ? null : <span>{done ? 'Copied' : 'Copy'}</span>}
      {iconOnly && done ? <span className="ccd-sr">Copied</span> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Small charts (SVG, sized by viewBox, no library)

function Sparkline({ values: target }: { values: number[] }) {
  const values = useTweenedArray(target);
  if (values.length < 2)
    return <svg className="ccd-spark" viewBox="0 0 100 28" aria-hidden="true" />;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 26 - (v / max) * 24] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  return (
    <svg className="ccd-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <path d={`${line} L100,28 L0,28 Z`} className="ccd-spark-area" />
      <path d={line} className="ccd-spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Badge({ text }: { text: string | null }) {
  if (!text) return null;
  const tone =
    text.startsWith('+') || text === 'New' ? 'up' : text.startsWith('−') ? 'down' : 'flat';
  return <span className={`ccd-badge ccd-badge-${tone}`}>{text}</span>;
}

function Kpi({
  label,
  value,
  format,
  badge,
  spark,
}: {
  label: string;
  value: number | null;
  format: (v: number) => { num: string; unit?: string };
  badge: string | null;
  spark: number[];
}) {
  const shown = useTweenedNumber(value ?? 0);
  const { num, unit } = value === null ? { num: '–', unit: undefined } : format(shown);
  return (
    <div className="ccd-kpi">
      <div className="ccd-kpi-head">
        <span className="ccd-kpi-label">{label}</span>
        <Badge text={badge} />
      </div>
      <div className="ccd-kpi-value">
        <span className="ccd-num">{num}</span>
        {unit ? <span className="ccd-unit">{unit}</span> : null}
      </div>
      <Sparkline values={spark} />
    </div>
  );
}

function tickLabel(t: string, step: DashboardBody['step'], range?: DashboardBody['range']) {
  const d = new Date(t);
  if (step === 'hour') return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
  if (step === 'month' || range === '12m' || range === 'all')
    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function ActivityChart({ body, series }: { body: DashboardBody; series: SeriesKey }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 220;
  const pad = { l: 8, r: 8, t: 12, b: 26 };
  const target = body.series.map((p) => pointValue(p, series));
  // The line morphs to the new data; the scale is this period's, with ~10 % headroom.
  const cur = useTweenedArray(target);
  const max = Math.max(...cur, 1) * 1.1;
  const n = Math.max(cur.length, 1);
  // One point sits in the middle (a dot plus a flat line), never an empty box.
  const x = (i: number) => (n === 1 ? W / 2 : pad.l + (i / (n - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const path = (vals: number[]) =>
    vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const line =
    cur.length === 1
      ? `M${pad.l},${y(cur[0]!).toFixed(1)} L${W - pad.r},${y(cur[0]!).toFixed(1)}`
      : path(cur);
  const area =
    cur.length === 1
      ? `${line} L${W - pad.r},${H - pad.b} L${pad.l},${H - pad.b} Z`
      : `${line} L${x(cur.length - 1).toFixed(1)},${H - pad.b} L${x(0).toFixed(1)},${H - pad.b} Z`;
  // 5 evenly spread labels (start, quarters, middle, end), 3 when the points are few.
  const parts = n >= 9 ? 4 : 2;
  const ticks = Array.from({ length: parts + 1 }, (_, k) =>
    Math.round((k * (n - 1)) / parts),
  ).filter((v, i, a) => a.indexOf(v) === i);
  const format = (v: number) =>
    series === 'value' ? `${compactNumber(v)} USDC` : compactNumber(v);
  return (
    <div className="ccd-chart-wrap">
      <svg
        className="ccd-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${SERIES_LABELS[series]} for this period`}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const rel = ((e.clientX - box.left) / box.width) * W;
          setHover(
            Math.max(
              0,
              Math.min(n - 1, Math.round(((rel - pad.l) / (W - pad.l - pad.r)) * (n - 1))),
            ),
          );
        }}
        onPointerLeave={() => setHover(null)}
      >
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={pad.l}
            x2={W - pad.r}
            y1={y(max * f)}
            y2={y(max * f)}
            className="ccd-grid"
          />
        ))}
        <path d={area} className="ccd-area" />
        <path d={line} className="ccd-line" />
        {cur.length === 1 ? <circle cx={x(0)} cy={y(cur[0]!)} r="4" className="ccd-dot" /> : null}
        {ticks.map((i) =>
          body.series[i] ? (
            <text
              key={i}
              x={x(i)}
              y={H - 6}
              className="ccd-tick"
              textAnchor={n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
            >
              {tickLabel(body.series[i]!.t, body.step, body.range)}
              {body.step === 'hour' && i === n - 1 ? ' UTC' : ''}
            </text>
          ) : null,
        )}
        {hover !== null && body.series[hover] ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="ccd-cross" />
            <circle cx={x(hover)} cy={y(cur[hover]!)} r="4" className="ccd-dot" />
          </g>
        ) : null}
      </svg>
      {hover !== null && body.series[hover] ? (
        <div className="ccd-readout">
          <strong className="ccd-num">{format(cur[hover]!)}</strong>
          <span>
            {tickLabel(body.series[hover]!.t, body.step, body.range)}
            {body.step === 'hour' ? ' UTC' : ''}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function AgentClock({ hours: target }: { hours: number[] }) {
  const busiest = busiestHour(target);
  const hours = useTweenedArray(target);
  const max = Math.max(...hours, 1);
  const C = 120;
  const inner = 54;
  const outer = 100;
  return (
    <div className="ccd-clock">
      <svg viewBox="0 0 240 240" role="img" aria-label="Paid calls by hour of day, UTC">
        {hours.map((v, i) => {
          const a = (i / 24) * Math.PI * 2 - Math.PI / 2;
          const len = inner + 4 + (v / max) * (outer - inner - 4);
          const x1 = C + Math.cos(a) * inner;
          const y1 = C + Math.sin(a) * inner;
          const x2 = C + Math.cos(a) * len;
          const y2 = C + Math.sin(a) * len;
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              className={
                busiest && busiest.hour === i ? 'ccd-clock-bar ccd-clock-peak' : 'ccd-clock-bar'
              }
            >
              <title>{`${String(i).padStart(2, '0')}:00 UTC, ${compactNumber(v)} calls`}</title>
            </line>
          );
        })}
        {[0, 6, 12, 18].map((h) => {
          const a = (h / 24) * Math.PI * 2 - Math.PI / 2;
          return (
            <text
              key={h}
              x={C + Math.cos(a) * 113}
              y={C + Math.sin(a) * 113 + 4}
              className="ccd-clock-tick"
              textAnchor="middle"
            >
              {String(h).padStart(2, '0')}
            </text>
          );
        })}
      </svg>
      <div className="ccd-clock-centre">
        {busiest ? (
          <>
            <span className="ccd-clock-hour ccd-num">{`${String(busiest.hour).padStart(2, '0')}:00`}</span>
            <span className="ccd-muted">busiest hour, UTC</span>
          </>
        ) : (
          <span className="ccd-muted">No calls yet</span>
        )}
      </div>
    </div>
  );
}

function Donut({ parts: target }: { parts: { label: string; value: number; tone: string }[] }) {
  const values = useTweenedArray(target.map((p) => p.value));
  const parts = target.map((p, i) => ({ ...p, value: Math.max(0, values[i] ?? p.value) }));
  const total = parts.reduce((a, p) => a + p.value, 0);
  const pct = percents(target.map((p) => p.value));
  const shownTotal = useTweenedNumber(target.reduce((a, p) => a + p.value, 0));
  const R = 42;
  const L = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="ccd-donut">
      <svg viewBox="0 0 120 120" role="img" aria-label="Agents that only buy, only sell, or both">
        <circle cx="60" cy="60" r={R} className="ccd-donut-track" />
        {total > 0
          ? parts.map((p) => {
              const len = (p.value / total) * L;
              const el = (
                <circle
                  key={p.label}
                  cx="60"
                  cy="60"
                  r={R}
                  className={`ccd-donut-seg ccd-tone-${p.tone}`}
                  strokeDasharray={`${len} ${L - len}`}
                  strokeDashoffset={-offset}
                  transform="rotate(-90 60 60)"
                />
              );
              offset += len;
              return el;
            })
          : null}
        <text x="60" y="58" textAnchor="middle" className="ccd-donut-total">
          {compactNumber(shownTotal)}
        </text>
        <text x="60" y="74" textAnchor="middle" className="ccd-donut-sub">
          trading agents
        </text>
      </svg>
      <ul className="ccd-legend">
        {parts.map((p, i) => (
          <li key={p.label}>
            <span className={`ccd-swatch ccd-tone-${p.tone}`} />
            <span>{p.label}</span>
            <span className="ccd-num ccd-legend-v">{pct[i]} %</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A segmented control with a sliding pill under the chosen option (transform transition). The
 * pill is measured from the chosen button, so it follows a wrapped second row on a phone too.
 */
function Segmented<T extends string>({
  className,
  label,
  options,
  value,
  onChange,
}: {
  className: string;
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const measure = useCallback(() => {
    const button = wrap.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    if (button)
      setPill({
        x: button.offsetLeft,
        y: button.offsetTop,
        w: button.offsetWidth,
        h: button.offsetHeight,
      });
  }, []);
  useLayoutEffect(measure, [measure, value]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);
  return (
    <div ref={wrap} className={`ccd-seg ${className}`} role="group" aria-label={label}>
      {pill ? (
        <span
          className="ccd-seg-pill"
          aria-hidden="true"
          style={{
            width: pill.w,
            height: pill.h,
            transform: `translate(${pill.x}px, ${pill.y}px)`,
          }}
        />
      ) : null}
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={o.id === value}
          className={o.id === value ? 'ccd-seg-on' : ''}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Card({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`ccd-card ${className ?? ''}`}>
      <h2 className="ccd-card-title">{title}</h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Contracts and wallets

const MARKS: Record<DashboardWallet['kind'], { mark: string; tone: string; purpose: string }> = {
  router1: { mark: 'R1', tone: 'blue', purpose: 'Takes the 10 % fee on calls up to 0.10 USDC' },
  router2: { mark: 'R2', tone: 'blue', purpose: 'Takes the fee on payments up to 100 USDC' },
  router3: { mark: 'R3', tone: 'blue', purpose: 'Settles x402 purchases with the fee' },
  facilitator: { mark: 'F', tone: 'teal', purpose: 'Sends fee router 3 settlements' },
  public_facilitator: {
    mark: 'X',
    tone: 'teal',
    purpose: 'Settles x402 payments for anyone on Base',
  },
  paymaster: { mark: 'P', tone: 'teal', purpose: 'Pays the network fee of agent wallets' },
};

const STATIC_WALLETS: DashboardWallet[] = DASHBOARD_CONTRACTS.map((c) => ({
  ...c,
  eth: null,
  deposit: null,
}));

const GROUPS: { id: DashboardWallet['group']; title: string }[] = [
  { id: 'fees', title: 'Protocol revenue' },
  { id: 'payments', title: 'Payments' },
];

/** Which chain the page speaks of: Arc off (no switch) it reads Base, as before Arc. */
type ChainView = 'all' | 'base' | 'arc';
const viewOf = (arcOn: boolean, chain: DashboardChainChoice): ChainView =>
  !arcOn ? 'base' : chain === 'base' ? 'base' : chain === 'arc' ? 'arc' : 'all';
const AGENTS_WORD: Record<ChainView, string> = {
  all: 'ERC-8004 agents',
  base: 'Base agents',
  arc: 'Arc agents',
};
const ON_WORD: Record<ChainView, string> = {
  all: 'on Base and Arc',
  base: 'on Base',
  arc: 'on Arc',
};

/** Arc mainnet's contracts, each checkable on Arc's explorer. */
const ARC_EXPLORER = 'https://explorer.arc.io';
const ARC_CONTRACTS: { role: string; address: string; purpose: string; mark: string }[] = [
  {
    role: 'Fee router 3',
    address: '0xe807a76385ec3d76d17ab955091c12329d0a1403',
    purpose: 'Settles x402 purchases with the fee',
    mark: 'R3',
  },
  {
    role: 'Paymaster',
    address: '0x271BFB75cA5741875F1C69Bf478252133896FAdA',
    purpose: 'Pays the network fee of agent wallets',
    mark: 'P',
  },
  {
    role: 'USDC',
    address: '0x3600000000000000000000000000000000000000',
    purpose: 'Arc’s USDC, also its gas token',
    mark: '$',
  },
];

function ArcWallets({ titled }: { titled: boolean }) {
  return (
    <div className="ccd-group" data-k="arc-contracts">
      {titled ? <div className="ccd-group-head">Arc</div> : null}
      {ARC_CONTRACTS.map((c) => (
        <div key={c.address} className="ccd-row">
          <div className="ccd-row-role">
            <span className="ccd-mark ccd-tone-arc">{c.mark}</span>
            <span>
              <strong>{c.role}</strong>
              <span className="ccd-muted ccd-purpose">{c.purpose}</span>
            </span>
          </div>
          <div className="ccd-row-addr">
            <code className="ccd-mono" title={c.address}>
              {shortAddress(c.address)}
            </code>
            <CopyButton text={c.address} label={`Copy the ${c.role} address`} iconOnly />
          </div>
          <div className="ccd-row-link">
            <a
              className="ccd-outline"
              href={`${ARC_EXPLORER}/address/${c.address}`}
              target="_blank"
              rel="noreferrer"
            >
              Arc explorer
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}

function Wallets({ wallets, view }: { wallets: DashboardWallets | null; view: ChainView }) {
  const sub =
    view === 'arc'
      ? 'Every address on Arc, checkable on Arc’s explorer'
      : view === 'all'
        ? 'Every address on Base and Arc, checkable on Basescan and Arc’s explorer'
        : 'Every address on Base, checkable on Basescan';
  return (
    <section className="ccd-panel" aria-labelledby="ccd-wallets-title">
      <div className="ccd-panel-head">
        <h2 id="ccd-wallets-title" className="ccd-card-title">
          Contracts and wallets
        </h2>
        <span className="ccd-muted">{sub}</span>
      </div>
      {(view === 'arc' ? [] : GROUPS).map((g) => (
        <div key={g.id} className="ccd-group">
          <div className="ccd-group-head">{view === 'all' ? `Base · ${g.title}` : g.title}</div>
          {(wallets?.wallets ?? STATIC_WALLETS)
            .filter((w) => w.group === g.id)
            .map((w) => {
              const m = MARKS[w.kind];
              return (
                <div key={w.kind} className="ccd-row">
                  <div className="ccd-row-role">
                    <span className={`ccd-mark ccd-tone-${m.tone}`}>{m.mark}</span>
                    <span>
                      <strong>{w.role}</strong>
                      <span className="ccd-muted ccd-purpose">{m.purpose}</span>
                    </span>
                  </div>
                  <div className="ccd-row-addr">
                    <code className="ccd-mono" title={w.address}>
                      {shortAddress(w.address)}
                    </code>
                    <CopyButton text={w.address} label={`Copy the ${w.role} address`} iconOnly />
                  </div>
                  <div className="ccd-row-link">
                    <a
                      className="ccd-outline"
                      href={basescanAddress(w.address)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Basescan
                    </a>
                  </div>
                </div>
              );
            })}
        </div>
      ))}
      {view === 'base' ? null : <ArcWallets titled={view === 'all'} />}
    </section>
  );
}

function Track({ range, view }: { range: DashboardRange; view: ChainView }) {
  const origin = typeof window === 'undefined' ? 'https://centralcity.ai' : window.location.origin;
  const curl = `curl -s "${origin}/api/public/dashboard?range=${range}"`;
  return (
    <section className="ccd-track" aria-labelledby="ccd-track-title">
      <h2 id="ccd-track-title">Track these numbers yourself</h2>
      <p>No key, JSON, open to any site (CORS), cached 15 s.</p>
      <ul className="ccd-endpoints">
        {TRACK_ENDPOINTS.map((t) => {
          const e = t.label.includes('Base agents')
            ? { ...t, label: t.label.replace('Base agents', AGENTS_WORD[view]) }
            : t;
          const url = `${origin}${e.path}${e.query ? `?range=${range}` : ''}`;
          return (
            <li key={e.path}>
              <span className="ccd-endpoint-label">{e.label}</span>
              <code className="ccd-mono">{`GET ${e.path}${e.query ? '?range=' + range : ''}`}</code>
              <CopyButton text={url} label={`Copy the ${e.label} endpoint`} />
            </li>
          );
        })}
      </ul>
      <div className="ccd-curl">
        <code className="ccd-mono">{curl}</code>
        <CopyButton text={curl} label="Copy the curl example" />
      </div>
      <div className="ccd-track-links">
        <a className="ccd-track-link" href={`${DASHBOARD_JSON_PATH}?range=${range}`}>
          Open /dashboard.json
        </a>
        <a className="ccd-track-link" href="/docs/dashboard-api.md">
          API docs
        </a>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

export function AgentDashboard() {
  usePageTitle('Analytics · Central City');
  const [range, setRange] = useState<DashboardRange>(DEFAULT_DASHBOARD_RANGE);
  const [series, setSeries] = useState<SeriesKey>('calls');
  const [chain, setChain] = useState<DashboardChainChoice>('all');
  const { body, failed } = useDashboard(range, chain);
  // The chain switch shows only while the server answers with Arc on (`chains`); Arc off it is
  // hidden and the page reads All, the answer of before.
  const arcOn = body?.chains?.includes('arc') === true;
  const view = viewOf(arcOn, chain);
  const wallets = useWallets();
  const now = useNow();
  const ago = body ? Math.max(0, Math.round((now - Date.parse(body.updated_at)) / 1000)) : null;

  const kpis = useMemo(() => {
    const p = body?.previous;
    const usdcFormat = (v: number) => usdcPartsOf(v);
    const countFormat = (v: number) => ({ num: compactNumber(v) });
    return [
      {
        label: 'Value settled',
        value: body ? usdc(body.kpis.value_settled_raw) : null,
        format: usdcFormat,
        badge: body
          ? changeBadge(usdc(body.kpis.value_settled_raw), p ? usdc(p.value_settled_raw) : null)
          : null,
        spark: body?.series.map((pt) => pointValue(pt, 'value')) ?? [],
      },
      {
        label: 'Protocol revenue',
        value: body ? usdc(body.kpis.fees_raw) : null,
        format: usdcFormat,
        badge: body ? changeBadge(usdc(body.kpis.fees_raw), p ? usdc(p.fees_raw) : null) : null,
        spark: body?.series.map((pt) => pointValue(pt, 'fees')) ?? [],
      },
      {
        label: `Active ${!arcOn || chain === 'base' ? 'Base ' : chain === 'arc' ? 'Arc ' : ''}agents`,
        value: body ? body.kpis.active : null,
        format: countFormat,
        badge: body ? changeBadge(body.kpis.active, p?.active) : null,
        spark: body?.series.map((pt) => pt.active) ?? [],
      },
      {
        label: `New ${AGENTS_WORD[viewOf(arcOn, chain)]}`,
        value: body ? body.kpis.base_new : null,
        format: countFormat,
        badge: body ? changeBadge(body.kpis.base_new, p?.base_new) : null,
        spark: body?.series.map((pt) => pt.base_new) ?? [],
      },
    ];
  }, [body, arcOn, chain]);

  const totalTarget = body
    ? series === 'value'
      ? usdc(body.kpis.value_settled_raw)
      : series === 'calls'
        ? body.kpis.calls
        : body.kpis.active
    : 0;
  const totalShown = useTweenedNumber(totalTarget);
  const total = !body
    ? '–'
    : series === 'value'
      ? `${usdcPartsOf(totalShown).num} USDC`
      : compactNumber(totalShown);
  const sides = body?.agents;
  const priceTotal = body?.prices.reduce((a, p) => a + p.calls, 0) ?? 0;
  const priceMax = Math.max(...(body?.prices.map((p) => p.calls) ?? [0]), 1);
  const topMax = Math.max(...(body?.top_services.map((s) => s.calls) ?? [0]), 1);

  return (
    <div className="ccd">
      <PublicHeader current="dashboard" />
      <main id="main-content">
        <div className="ccd-hero">
          <div className="ccd-inner">
            <p className="ccd-eyebrow">Open Source</p>
            <div className="ccd-hero-top">
              <div>
                <h1>Analytics</h1>
                <p className="ccd-lede">
                  How {AGENTS_WORD[view]} on Central City work and pay each other. All traffic, one
                  data set, every payment checkable {ON_WORD[view]}.
                </p>
              </div>
              <div className="ccd-hero-controls">
                <span className={`ccd-live ${failed && !body ? 'ccd-live-off' : ''}`}>
                  <span className="ccd-live-dot" aria-hidden="true" />
                  {ago === null ? 'Connecting' : `Live, updated ${ago} s ago`}
                </span>
                <div className="ccd-switches">
                  {arcOn ? (
                    <Segmented
                      className="ccd-switch ccd-chain-switch"
                      label="Chain"
                      options={(['all', 'base', 'arc'] as const).map((c) => ({
                        id: c,
                        label: DASHBOARD_CHAIN_LABELS[c],
                      }))}
                      value={chain}
                      onChange={setChain}
                    />
                  ) : null}
                  <Segmented
                    className="ccd-switch"
                    label="Time window"
                    options={DASHBOARD_RANGES.map((r) => ({
                      id: r,
                      label: DASHBOARD_RANGE_LABELS[r],
                    }))}
                    value={range}
                    onChange={setRange}
                  />
                </div>
              </div>
            </div>
            {body && !body.history_complete ? (
              <p className="ccd-history" role="status">
                Older history is still being added. Totals for longer periods grow until it is
                complete.
              </p>
            ) : null}
            <div className="ccd-kpis">
              {kpis.map((k) => (
                <Kpi key={k.label} {...k} />
              ))}
            </div>
          </div>
        </div>

        <div className="ccd-inner ccd-body">
          {!body && failed ? (
            <p className="ccd-muted">The dashboard did not load. It tries again in 15 s.</p>
          ) : null}
          <div className="ccd-row2">
            <Card title="Activity" className="ccd-activity">
              <div className="ccd-activity-head">
                <div className="ccd-total">
                  <span className="ccd-num">{total}</span>
                  <span className="ccd-muted">
                    {SERIES_LABELS[series].toLowerCase()} this period
                  </span>
                </div>
                <Segmented
                  className="ccd-toggle"
                  label="Series"
                  options={[
                    { id: 'calls' as SeriesKey, label: 'Calls' },
                    { id: 'active' as SeriesKey, label: 'Active agents' },
                  ]}
                  value={series}
                  onChange={setSeries}
                />
              </div>
              {body ? (
                <ActivityChart body={body} series={series} />
              ) : (
                <div className="ccd-chart-empty" />
              )}
            </Card>
            <Card title="Agent clock" className="ccd-clock-card">
              <AgentClock hours={body?.hour_of_day ?? Array.from({ length: 24 }, () => 0)} />
            </Card>
          </div>

          <div className="ccd-row-market">
            <Card title="Who trades">
              <Donut
                parts={[
                  { label: 'Only buy', value: sides?.buyers_only ?? 0, tone: 'blue' },
                  { label: 'Only sell', value: sides?.sellers_only ?? 0, tone: 'teal' },
                  { label: 'Both', value: sides?.both ?? 0, tone: 'violet' },
                ]}
              />
              <h3 className="ccd-sub">What a call costs</h3>
              <div className="ccd-cols" role="img" aria-label="Paid calls by price, USDC">
                {(body?.prices ?? []).map((p) => (
                  <div key={p.key} className="ccd-col">
                    <span className="ccd-col-pct ccd-num">
                      {priceTotal ? Math.round((p.calls / priceTotal) * 100) : 0} %
                    </span>
                    <span className="ccd-col-bar">
                      <span style={{ height: `${Math.max(2, (p.calls / priceMax) * 100)}%` }} />
                    </span>
                    <span className="ccd-col-label">{p.label}</span>
                  </div>
                ))}
              </div>
            </Card>
            <Card title="Most used services">
              {body && body.top_services.length ? (
                <ol className="ccd-top">
                  {body.top_services.map((s, i) => (
                    <li key={`${s.title}-${i}`}>
                      <span className="ccd-rank ccd-num">{i + 1}</span>
                      <span className="ccd-top-main">
                        <span className="ccd-top-title" title={s.title}>
                          {s.title}
                        </span>
                        <span className="ccd-bar">
                          <span style={{ width: `${(s.calls / topMax) * 100}%` }} />
                        </span>
                      </span>
                      <span className="ccd-num ccd-top-calls">{compactNumber(s.calls)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="ccd-muted">No paid calls in this period yet.</p>
              )}
            </Card>
          </div>

          <Wallets wallets={wallets} view={view} />
          <Track range={range} view={view} />
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
