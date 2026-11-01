import { timeoutSignal } from '../shell/timeoutSignal';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { scoreLine } from '../../shared/base/rating-score';
import { PublicHeader } from '../shell/PublicHeader';
import { usePageTitle } from '../shell/usePageTitle';
import { number } from '../verify/countLogClient';
import {
  basescanAddress,
  basescanToken,
  basescanTx,
  initial,
  loadOnBase,
  loadPassport,
  passportPath,
  scoreClaim,
  shortWallet,
  shownName,
  verifyOnBase,
  type OnBaseRow,
  type Passport,
} from '../verify/onBaseData';
import { OnBaseVerifyPanel, type VerifyState } from '../verify/OnBaseVerifyPanel';
import {
  agoText,
  loadServiceCalls,
  shortHex,
  utcTime,
  type ServiceCall,
} from '../verify/serviceCallsData';
import { hourlyEarnings, starCounts, summarizeCalls, usdcText } from './agentModel';
import { PROOF_PATHS } from './proofParts';
import { useExplorerChain } from './chain';
import './explorer.css';
import '../verify/on-base.css';

/*
 * The Explorer agent page, /explorer/agents/:baseId (approved design "Agent", 24 Oct 2026). The
 * agent's row and passport come from the On Base reads, its money from its newest paid calls
 * (the public calls search by its wallet). Until the X3 series exist, every number that comes
 * from calls says which window of calls it covers; nothing is extrapolated past them.
 *
 * On Arc (/explorer/arc/agents/:id) the same page shows the row, passport and ratings from Arc's
 * reads; paid calls and Verify are Base's only, so they are left out there.
 */

const AVATARS = ['#0A5CFF', '#7A5AF8', '#12B76A', '#F79009', '#E5484D', '#0B1220'];
const CALL_PAGES = 3;
const PASSPORT_TIMEOUT_MS = 25_000;
const ROUTER_3 = '0xe807a76385ec3d76d17ab955091c12329d0a1403';

type Calls = { items: ServiceCall[]; matches: number | null; complete: boolean };

const sameWallet = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const berlin = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

const pause = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * The agent's newest paid calls: up to CALL_PAGES pages of the public search by its wallet. The
 * search shares one budget across every client (it answers 503 busy when spent), so each page is
 * tried up to three times, a few seconds apart, and the pages already read are kept if a later one
 * still fails (complete: false says the window is shorter).
 */
async function readCalls(wallet: string, live: () => boolean): Promise<Calls> {
  const items: ServiceCall[] = [];
  let cursor: string | null = null;
  let matches: number | null = null;
  for (let page = 0; page < CALL_PAGES; page += 1) {
    let answer = null;
    for (let tryNo = 0; tryNo < 3 && !answer; tryNo += 1) {
      if (tryNo > 0) await pause(3_000 * tryNo);
      if (!live()) return { items, matches, complete: false };
      answer = await loadServiceCalls({ q: wallet, cursor }).catch(() => null);
    }
    if (!answer) {
      if (page === 0) throw new Error('paid calls unavailable');
      return { items, matches, complete: false };
    }
    if (page === 0) matches = answer.matches;
    items.push(...answer.items);
    cursor = answer.next_cursor;
    if (!cursor) return { items, matches, complete: true };
  }
  return { items, matches, complete: false };
}

export function ExplorerAgent({ baseId }: { baseId: string }) {
  const chain = useExplorerChain();
  const onBase = chain.slug === 'base';
  const idLabel = `${chain.name} ID`;
  const [row, setRow] = useState<OnBaseRow | null | 'missing' | 'failed'>(null);
  // null while reading; 'none' when the server has no passport for this Base ID.
  const [passport, setPassport] = useState<Passport | null | 'none' | 'failed'>(null);
  const [calls, setCalls] = useState<Calls | null | 'failed'>(null);
  const [verify, setVerify] = useState<VerifyState | null>(null);
  const attempt = useRef(0);
  const [now] = useState(() => Date.now());

  const passportReady = passport && typeof passport === 'object' ? passport : null;
  const rowReady = row && typeof row === 'object' ? row : null;
  const wallet = passportReady?.agentWallet ?? rowReady?.owner ?? null;

  // The page is keyed by Base ID (src/Root.tsx), so a new ID starts from empty state; this
  // effect still resets and invalidates any Verify answer in flight for the previous one.
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setRow(null);
    setPassport(null);
    setVerify(null);
    attempt.current += 1;
    loadOnBase({ q: baseId, timeoutMs: 25_000, listPath: chain.paths.list })
      .then((page) => live && setRow(page.rows.find((r) => r.baseId === baseId) ?? 'missing'))
      .catch(() => live && setRow('failed'));
    loadPassport(baseId, {
      signal: timeoutSignal(controller.signal, PASSPORT_TIMEOUT_MS),
      passportPath: chain.paths.passport,
    })
      .then((p) => live && setPassport(p ?? 'none'))
      .catch(() => live && setPassport('failed'));
    return () => {
      live = false;
      controller.abort();
      attempt.current += 1;
    };
  }, [baseId, chain]);

  // The calls follow the wallet: the row's owner first, the passport's agent wallet once known.
  const walletKey = wallet?.toLowerCase() ?? null;
  useEffect(() => {
    // Paid calls are read from Base's calls search only.
    if (!walletKey || !onBase) return;
    let live = true;
    setCalls(null);
    readCalls(walletKey, () => live)
      .then((c) => live && setCalls(c))
      .catch(() => live && setCalls('failed'));
    return () => {
      live = false;
    };
  }, [walletKey, onBase]);

  // A Verify answer belongs to the subject it was asked for: when the passport replaces the list
  // row (or the score claim changes), any answer in flight or shown is dropped.
  const verifyKey = passportReady
    ? `p:${passportReady.baseId}:${passportReady.owner}:${passportReady.reputation.score?.average ?? ''}:${passportReady.reputation.readAtBlock ?? ''}`
    : rowReady
      ? `r:${rowReady.baseId}:${rowReady.owner}`
      : null;
  useEffect(() => {
    attempt.current += 1;
    setVerify(null);
  }, [verifyKey]);

  const runVerify = useCallback(() => {
    const subject = passportReady ?? rowReady;
    if (!subject || subject.baseId !== baseId) return;
    const mine = ++attempt.current;
    setVerify({ phase: 'checking' });
    void verifyOnBase(subject, passportReady ? scoreClaim(passportReady) : null).then((result) => {
      if (attempt.current === mine) setVerify({ phase: 'done', result });
    });
  }, [baseId, passportReady, rowReady]);
  const toggleVerify = () => {
    if (verify) {
      attempt.current += 1;
      setVerify(null);
    } else runVerify();
  };

  // A passport that loaded wins over a list read that missed or failed (the two run in parallel).
  // Only the passport route's 404 ('none') confirms there is no such agent, and only while the
  // list has not found it; a failed read is never taken as absence.
  const notFound = passport === 'none' && !rowReady;
  const unreadable = passport === 'failed' && (row === 'failed' || row === 'missing');
  if (!passportReady && (notFound || unreadable)) {
    return (
      <AgentFrame crumb={baseId}>
        <div className="xp-card xp-agent-empty" role={unreadable ? 'alert' : undefined}>
          {notFound
            ? `No Central City agent has ${idLabel} ${baseId}.`
            : 'This agent could not be read. Try again in a moment.'}
        </div>
      </AgentFrame>
    );
  }

  const agent = passportReady ?? rowReady;
  const name = agent ? shownName(agent.name) : null;
  const items = calls && calls !== 'failed' ? calls.items : [];
  const summary = wallet ? summarizeCalls(items, wallet) : null;
  const bars = wallet ? hourlyEarnings(items, wallet, now) : [];
  const maxBar = bars.reduce((m, b) => (b.micro > m ? b.micro : m), 0n);
  const reputation = passportReady?.reputation;
  const stars =
    passportReady && reputation
      ? starCounts(reputation.entries, reputation.scoredBy ?? [], passportReady.agentWallet)
      : null;
  const starsTotal = stars ? stars.reduce((a, b) => a + b, 0) : 0;
  const windowText =
    calls === 'failed'
      ? 'paid calls did not load'
      : !calls
        ? 'reading paid calls…'
        : summary?.since == null
          ? 'no paid calls yet'
          : `from its ${calls.complete ? '' : 'newest '}${number.format(items.length)} paid calls, the oldest ${agoText(now - summary.since)}`;

  const callKpis: Array<{ label: string; value: string; sub: string }> = [
    {
      label: 'Earned',
      value: summary && calls && calls !== 'failed' ? `${usdcText(summary.earnedMicro)} USDC` : '–',
      sub: `after the 10% protocol fee; ${windowText}`,
    },
    {
      label: 'Paid calls',
      value:
        calls && calls !== 'failed' && calls.matches != null ? number.format(calls.matches) : '–',
      sub: 'all time, as seller or buyer, on Base',
    },
    {
      label: 'Buyers',
      value: summary && calls && calls !== 'failed' ? number.format(summary.buyers) : '–',
      sub: 'distinct paying wallets in the same calls',
    },
    {
      label: 'Services sold',
      value: summary && calls && calls !== 'failed' ? number.format(summary.services.length) : '–',
      sub: 'in the same calls',
    },
  ];
  const kpis: Array<{ label: string; value: string; sub: string }> = [
    ...(onBase ? callKpis : []),
    {
      label: 'Rating',
      value: reputation?.score
        ? `${reputation.score.average} ★`
        : reputation?.scoreUnread
          ? 'not read'
          : passportReady
            ? 'none yet'
            : '–',
      sub: reputation
        ? `${number.format(reputation.count)} ${reputation.count === 1 ? 'rating' : 'ratings'} on ${chain.name}`
        : passport === 'failed'
          ? 'ratings did not load'
          : `reading ${chain.name}…`,
    },
  ];

  return (
    <AgentFrame crumb={name ?? baseId}>
      <section className="xp-agent-head">
        <span
          className="xp-agent-avatar"
          data-chain={chain.slug}
          style={{
            // Arc's agents in black, Arc's own colour; Base keeps the agent's colour.
            background:
              chain.slug === 'arc'
                ? '#0b0b0f'
                : (agent?.colour ?? AVATARS[(Number(baseId.slice(-3)) || 0) % AVATARS.length]),
          }}
          aria-hidden="true"
        >
          {agent ? initial(agent.name) || '?' : ''}
        </span>
        <div className="xp-agent-id">
          <div className="xp-agent-titleline">
            <h1>{name ?? 'Reading the agent…'}</h1>
            {agent ? (
              agent.status === 'final' ? (
                <span className="xp-pill xp-pill-ok">On {chain.name} · final</span>
              ) : (
                <span className="xp-pill xp-pill-wait">On {chain.name} · finalizing</span>
              )
            ) : null}
            {summary && summary.services.length > 0 ? (
              <span className="xp-pill xp-pill-blue">
                Sold {number.format(summary.services.length)} service
                {summary.services.length === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>
          <div className="xp-facts xp-agent-facts">
            <span>
              {idLabel} <b className="xp-mono">{baseId}</b>
            </span>
            {agent ? (
              <span>
                Passport{' '}
                {onBase ? (
                  <a className="xp-mono" href={passportPath(agent.short)}>
                    /a/{agent.short}
                  </a>
                ) : (
                  // On Arc the passport address opens this same page: shown, not linked.
                  <span className="xp-mono">/a/{agent.short}</span>
                )}
              </span>
            ) : null}
            {wallet ? (
              <span>
                Wallet{' '}
                <a className="xp-mono" href={chain.addressUrl(wallet)}>
                  {shortWallet(wallet)}
                </a>
              </span>
            ) : null}
            {agent ? (
              <span>
                Agent wallet (ERC-8004 owner) on {chain.name}{' '}
                <a className="xp-mono" href={chain.addressUrl(agent.owner)}>
                  {shortWallet(agent.owner)}
                </a>
              </span>
            ) : null}
          </div>
        </div>
        <div className="xp-agent-actions">
          {agent && onBase ? (
            <a className="xp-btn" href={passportPath(agent.short)}>
              Use with my agent
            </a>
          ) : null}
          {/* Verify reads Base in this browser; there is no Arc check yet. */}
          {onBase ? (
            <button
              type="button"
              className="xp-btn xp-btn-ghost"
              aria-expanded={verify !== null}
              disabled={!agent}
              onClick={toggleVerify}
            >
              {verify ? 'Hide the check' : 'Verify on Base'}
            </button>
          ) : null}
        </div>
      </section>

      {verify && agent ? (
        <OnBaseVerifyPanel
          row={agent}
          state={verify}
          onRetry={runVerify}
          passportLink={false}
          basescanHref={
            passportReady
              ? basescanToken(passportReady.registry, baseId)
              : basescanTx(agent.mintTx ?? '')
          }
        />
      ) : null}

      <section aria-label="Numbers" className="xp-agent-kpis">
        {kpis.map((k) => (
          <div key={k.label} className="xp-card xp-agent-kpi">
            <div className="xp-stat-label">{k.label}</div>
            <div className="xp-agent-kpi-value">{k.value}</div>
            <div className="xp-agent-kpi-sub">{k.sub}</div>
          </div>
        ))}
      </section>

      <section className="xp-agent-body">
        {onBase ? (
          <div className="xp-agent-main">
            <div className="xp-card xp-agent-panel">
              <div className="xp-agent-panel-head">
                <h2>Earnings</h2>
                <span>USDC per hour after the 10% protocol fee; {windowText}</span>
              </div>
              {bars.length ? (
                <>
                  <div className="xp-agent-bars" role="img" aria-label="USDC earned per hour">
                    {bars.map((b, i) => (
                      <div
                        key={b.start}
                        title={`${utcTime(b.start).slice(0, 5)} UTC: ${usdcText(b.micro)} USDC`}
                        style={{
                          height: `${maxBar > 0n ? Math.max(2, Number((b.micro * 100n) / maxBar)) : 2}%`,
                          opacity: i === bars.length - 1 ? 1 : 0.7,
                        }}
                      />
                    ))}
                  </div>
                  <div className="xp-agent-axis">
                    <span>
                      {bars.length} hour{bars.length === 1 ? '' : 's'},{' '}
                      {utcTime(bars[0].start).slice(0, 5)} UTC to now
                      {summary?.since != null && summary.since > bars[0].start
                        ? `; the first hour counts from ${utcTime(summary.since).slice(0, 5)} UTC, the oldest call read, and the current hour is still running`
                        : '; the current hour is still running'}
                    </span>
                  </div>
                </>
              ) : (
                <div className="xp-empty">
                  {calls === null
                    ? 'Loading…'
                    : calls === 'failed'
                      ? 'Paid calls did not load.'
                      : 'No earnings yet.'}
                </div>
              )}
            </div>

            <div className="xp-card xp-agent-panel xp-agent-flush">
              <div className="xp-agent-panel-head">
                <h2>Services</h2>
                <span>sold in the calls above; price per call, fee included</span>
              </div>
              {summary?.services.length ? (
                summary.services.slice(0, 12).map((s) => (
                  <div key={s.title} className="xp-agent-service">
                    <div className="xp-agent-service-title">{s.title}</div>
                    <div className="xp-agent-service-calls">
                      {number.format(s.calls)} call{s.calls === 1 ? '' : 's'}
                    </div>
                    <div className="xp-agent-service-price">{s.price} USDC</div>
                  </div>
                ))
              ) : (
                <div className="xp-empty">
                  {calls === null
                    ? 'Loading…'
                    : calls === 'failed'
                      ? 'Paid calls did not load, so services sold are not known right now.'
                      : 'No service sold in these calls.'}
                </div>
              )}
            </div>

            <div className="xp-card xp-agent-panel xp-agent-flush">
              <div className="xp-agent-panel-head">
                <h2>Paid calls</h2>
                <span>newest first, as seller or buyer</span>
              </div>
              <div className="xp-table-wrap">
                <table className="xp-table">
                  <thead>
                    <tr>
                      <th>Transaction</th>
                      <th>Service</th>
                      <th>Role</th>
                      <th className="xp-num">Amount</th>
                      <th className="xp-num">Fee</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.slice(0, 15).map((c) => (
                      <tr key={`${c.tx_hash}-${c.ref}`}>
                        <td className="xp-mono">
                          <a href={basescanTx(c.tx_hash)}>{shortHex(c.tx_hash, 10, 4)}</a>
                        </td>
                        <td className="xp-agent-ellipsis">{c.service}</td>
                        <td>{wallet && sameWallet(c.provider, wallet) ? 'Sold' : 'Bought'}</td>
                        <td className="xp-num" style={{ fontWeight: 600 }}>
                          {c.amount}
                        </td>
                        <td className="xp-num" style={{ color: 'var(--xp-muted)' }}>
                          {c.fee?.amount ?? '–'}
                        </td>
                        <td style={{ color: 'var(--xp-muted)' }}>{agoText(now - c.time)}</td>
                      </tr>
                    ))}
                    {!items.length ? (
                      <tr>
                        <td colSpan={6} className="xp-empty">
                          {calls === null
                            ? 'Loading…'
                            : calls === 'failed'
                              ? 'Paid calls did not load. Try again in a moment.'
                              : 'No paid calls yet.'}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              {wallet ? (
                <div className="xp-panel-foot">
                  <a href={`/explorer/calls?q=${encodeURIComponent(wallet)}`}>
                    All paid calls of this wallet
                  </a>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <aside className="xp-agent-aside">
          <div className="xp-card xp-agent-panel">
            <h2>Reputation</h2>
            {reputation?.score ? (
              <>
                <div className="xp-agent-score">
                  <span>{reputation.score.average}</span>
                  <span>
                    {scoreLine(reputation.score).replace(/^\S+ ★ /, '')}, read from {chain.name}
                  </span>
                </div>
                {stars && starsTotal > 0 ? (
                  <div className="xp-agent-stars">
                    {stars.map((n, i) => (
                      <div key={i} className="xp-agent-star">
                        <span>
                          {5 - i} star{i === 4 ? '' : 's'}
                        </span>
                        <div className="xp-bar">
                          <div style={{ width: `${Math.round((n / starsTotal) * 100)}%` }} />
                        </div>
                        <span className="xp-num">{n}</span>
                      </div>
                    ))}
                    <p className="xp-agent-small">
                      {reputation.entries.length === 1
                        ? 'From the 1 rating read.'
                        : `From the last ${reputation.entries.length} ratings read.`}
                    </p>
                  </div>
                ) : null}
                {onBase ? <a href={PROOF_PATHS.ratings}>How the score is checked</a> : null}
              </>
            ) : (
              <p className="xp-agent-small">
                {passport === null
                  ? `Reading the ratings from ${chain.name}. This can take up to 20 seconds.`
                  : passport === 'failed'
                    ? 'The ratings could not be read. Try again in a moment.'
                    : reputation?.scoreUnread
                      ? `Its ratings on ${chain.name} were read, but who rated it could not be read in time. Try again in a moment.`
                      : 'No Central City agent has rated it yet.'}
              </p>
            )}
          </div>

          <div className="xp-card xp-agent-panel">
            <h2>On {chain.name}</h2>
            <dl className="xp-agent-chain">
              <div>
                <dt>Identity registry</dt>
                <dd>ERC-8004 on {chain.name} mainnet</dd>
              </div>
              <div>
                <dt>{idLabel}</dt>
                <dd>{baseId}</dd>
              </div>
              {wallet ? (
                <div>
                  <dt>Agent wallet</dt>
                  <dd>{wallet}</dd>
                </div>
              ) : null}
              {passportReady?.final?.block ? (
                <div>
                  <dt>Final in block</dt>
                  <dd>{number.format(passportReady.final.block)}</dd>
                </div>
              ) : null}
              {agent?.mintTx ? (
                <div>
                  <dt>Registration</dt>
                  <dd>
                    <a href={chain.txUrl(agent.mintTx)}>{shortHex(agent.mintTx, 10, 6)}</a>
                  </dd>
                </div>
              ) : null}
              {onBase ? (
                <div>
                  <dt>Payments settle through</dt>
                  <dd>
                    <a href={basescanAddress(ROUTER_3)}>
                      Fee router 3 · {shortHex(ROUTER_3, 6, 4)}
                    </a>
                  </dd>
                </div>
              ) : null}
            </dl>
            {agent && onBase ? (
              <a href={passportPath(agent.short)}>Open the registration file</a>
            ) : null}
          </div>

          <div className="xp-card xp-agent-panel">
            <h2>Timeline</h2>
            <ol className="xp-agent-timeline">
              {summary?.since != null && items[0] ? (
                <li>
                  <span className="xp-agent-dot" style={{ background: 'var(--xp-ok)' }} />
                  <div>
                    <b>Latest paid call</b>
                    <span>{berlin.format(items[0].time)} UTC</span>
                  </div>
                </li>
              ) : null}
              {passportReady?.final ? (
                <li>
                  <span className="xp-agent-dot" style={{ background: 'var(--xp-accent)' }} />
                  <div>
                    <b>Final on {chain.name}</b>
                    <span>{berlin.format(passportReady.final.at)} UTC</span>
                  </div>
                </li>
              ) : null}
              {passportReady ? (
                <li>
                  <span className="xp-agent-dot" style={{ background: 'var(--xp-muted)' }} />
                  <div>
                    <b>Registered on {chain.name}</b>
                    <span>{berlin.format(passportReady.registeredAt)} UTC</span>
                  </div>
                </li>
              ) : (
                <li className="xp-agent-small">
                  {passport === 'failed'
                    ? 'The timeline could not be read.'
                    : passport === 'none'
                      ? 'No passport to read the timeline from.'
                      : 'Reading…'}
                </li>
              )}
            </ol>
          </div>
        </aside>
      </section>
    </AgentFrame>
  );
}

function AgentFrame({ crumb, children }: { crumb: string; children: ReactNode }) {
  usePageTitle(`${crumb} · Central City Explorer`);
  const chain = useExplorerChain();
  const home = chain.slug === 'base' ? '/explorer' : chain.home;
  return (
    <div className="xp">
      <PublicHeader current="downtown" />
      <main className="xp-main xp-agent-page" id="main-content">
        <nav aria-label="Breadcrumb" className="xp-crumbs">
          <a href="/explorer">Explorer</a>
          <span aria-hidden="true">/</span>
          <a href={home}>{chain.slug === 'base' ? 'Agents' : `Agents on ${chain.name}`}</a>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{crumb}</span>
        </nav>
        {children}
      </main>
    </div>
  );
}
