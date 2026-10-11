import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, Copy, LoaderCircle, Search } from 'lucide-react';
import { scoreLine } from '../../shared/base/rating-score';
import { PublicHeader } from '../shell/PublicHeader';
import { json, number } from './countLogClient';
import { ExplorerSwitch } from './ExplorerSwitch';
import { OnBaseVerifyPanel, type VerifyState } from './OnBaseVerifyPanel';
import {
  basescanRegistry,
  basescanToken,
  finalizingMinutes,
  loadOnBase,
  initial,
  shortWallet,
  shownName,
  verifyKey,
  verifyOnBase,
  type OnBaseList,
  type OnBaseRow,
} from './onBaseData';
import './verify.css';
import './on-base.css';

/*
 * /explorer/base, the Agent Explorer's "On Base" view (docs/design/on-base-mockup.html, approved by
 * the product owner 10 Oct 2026): only Central City agents with a Base ID, read from Base by the
 * server, newest first. Verify on a row re-reads that Base ID from Base in this browser. "All
 * agents" (/explorer) stays as it is; only the switch above the search is shared.
 */

/** The server's read lagging its answer by more than this means Base isn't answering it. */
const STALE_MS = 60_000;
/** While the tab is visible the list is read again this often, so the block stays live. */
const REFRESH_MS = 30_000;

type Load =
  | { phase: 'loading' }
  | { phase: 'ready'; data: OnBaseList; query: string; fetchedAt: number }
  | { phase: 'error' };

/** A fresh first page over what is shown: new rows first, changed rows updated, older pages kept. */
function mergeRows(fresh: OnBaseList, shown: OnBaseList): OnBaseList {
  const ids = new Set(fresh.rows.map((row) => row.baseId));
  const older = shown.rows.filter((row) => !ids.has(row.baseId));
  return {
    ...fresh,
    rows: [...fresh.rows, ...older],
    nextBefore: shown.rows.length > fresh.rows.length ? shown.nextBefore : fresh.nextBefore,
  };
}

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function CopyWallet({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ll-copy ob-copy"
      aria-label={copied ? 'Copied' : 'Copy owner wallet'}
      title={address}
      onClick={() => {
        navigator.clipboard?.writeText(address).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          },
          () => undefined,
        );
      }}
    >
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}

function Status({ row, now }: { row: OnBaseRow; now: number }) {
  if (row.status === 'final')
    return (
      <span className="ob-status" data-state="final">
        <Check size={14} strokeWidth={2.6} aria-hidden="true" /> Final
      </span>
    );
  const minutes = finalizingMinutes(row.finalizingSince, now);
  return (
    <span className="ob-status" data-state="finalizing">
      <i className="ob-pulse" aria-hidden="true" />
      <span>
        Finalizing
        <small>{minutes === null ? 'usually 15–30 min' : `${minutes} min · usually 15–30`}</small>
      </span>
    </span>
  );
}

export function OnBase() {
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, VerifyState>>({});
  const [more, setMore] = useState(false);
  const [all, setAll] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const generation = useRef(0);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    json<{ ai_agents_total: number }>('/api/public/stats')
      .then((stats) => setAll(stats.ai_agents_total))
      .catch(() => undefined);
  }, []);

  const read = useCallback(async (q: string) => {
    const mine = ++generation.current;
    setLoad({ phase: 'loading' });
    setOpen(null);
    try {
      const data = await loadOnBase({ q });
      if (mine === generation.current)
        setLoad({ phase: 'ready', data, query: q, fetchedAt: Date.now() });
    } catch {
      if (mine === generation.current) setLoad({ phase: 'error' });
    }
  }, []);
  useEffect(() => {
    void read('');
  }, [read]);

  // Read again while the tab is visible: the block and the finalizing rows stay live. A newer
  // search wins (generation), and the open Verify and loaded older rows stay as they are.
  const shownRef = useRef(load);
  shownRef.current = load;
  useEffect(() => {
    const timer = window.setInterval(() => {
      const shown = shownRef.current;
      if (document.visibilityState !== 'visible' || shown.phase !== 'ready') return;
      const mine = generation.current;
      loadOnBase({ q: shown.query })
        .then((fresh) => {
          const current = shownRef.current;
          if (mine !== generation.current || current.phase !== 'ready') return;
          setLoad({
            phase: 'ready',
            query: current.query,
            data: mergeRows(fresh, current.data),
            fetchedAt: Date.now(),
          });
        })
        .catch(() => undefined);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  async function older() {
    if (load.phase !== 'ready' || !load.data.nextBefore || more) return;
    const mine = generation.current;
    setMore(true);
    try {
      const page = await loadOnBase({ q: load.query, before: load.data.nextBefore });
      if (mine !== generation.current) return;
      setLoad({
        phase: 'ready',
        query: load.query,
        fetchedAt: load.fetchedAt,
        data: { ...page, totals: load.data.totals, rows: [...load.data.rows, ...page.rows] },
      });
    } catch {
      // The button stays: pressing it again retries.
    } finally {
      setMore(false);
    }
  }

  // A result is kept under the facts it checked (verifyKey): a re-read that changes the open row
  // (a new owner, now final) shows no earlier result beside it, and checks the new facts.
  async function verify(row: OnBaseRow) {
    const key = verifyKey(row);
    setChecks((all) => ({ ...all, [key]: { phase: 'checking' } }));
    const result = await verifyOnBase(row);
    setChecks((all) => ({ ...all, [key]: { phase: 'done', result } }));
  }
  const openRow =
    open === null || load.phase !== 'ready'
      ? undefined
      : load.data.rows.find((row) => row.baseId === open);
  const openKey = openRow ? verifyKey(openRow) : null;
  useEffect(() => {
    if (openRow && openKey && !checks[openKey]) void verify(openRow);
    // Only a change of the open row's facts starts a check; verify itself fills `checks`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);
  function toggle(row: OnBaseRow) {
    if (open === row.baseId) return setOpen(null);
    setOpen(row.baseId);
    void verify(row);
  }

  const data = load.phase === 'ready' ? load.data : null;
  // How far the server's Base read lagged when it answered: both times are the server's clock, so a
  // viewer's fast or slow device never makes or hides an outage. The shown age adds the time since.
  const fetchedAt = load.phase === 'ready' ? load.fetchedAt : now;
  const readAt = data?.totals.readAt ?? null;
  const lag = data && readAt !== null ? Math.max(0, data.totals.servedAt - readAt) : 0;
  const stale = lag > STALE_MS;

  return (
    <div className="public-shell">
      <PublicHeader current="downtown" />
      <main id="main-content" tabIndex={-1} className="public-main vf-main ll-main ob-main">
        <header className="vf-head">
          <p className="vf-eyebrow">
            Downtown · Transparency · <a href="/downtown/verify">Verify the count</a>
          </p>
          <h1>Agent Explorer</h1>
          <ExplorerSwitch current="base" all={all} onBase={data?.totals.onBase ?? null} />
          <p className="vf-lede">
            Every Central City agent with a Base ID. Owners are read from Base, and Verify checks
            any agent again in your own browser, directly on Base.
          </p>
        </header>

        {stale && data ? (
          <div className="ob-banner" data-tone="warn" role="status">
            <div>
              <b>Base isn't answering right now</b>
              <p>
                The list shows the last block we read, {number.format(data.totals.readAtBlock ?? 0)}
                , {ago(lag + Math.max(0, now - fetchedAt))}. Verify needs Base itself, so try it
                again in a moment.
              </p>
            </div>
            <button
              type="button"
              className="ob-pill"
              onClick={() => void read(load.phase === 'ready' ? load.query : '')}
            >
              Try again
            </button>
          </div>
        ) : null}

        <form
          className="ll-search ll-search-hero"
          role="search"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void read(query);
          }}
        >
          <label htmlFor="ob-query" className="visually-hidden">
            Search agents on Base
          </label>
          <Search size={16} aria-hidden="true" />
          <input
            id="ob-query"
            className="vf-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Base ID, wallet or agent name"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="ob-pill ink" disabled={load.phase === 'loading'}>
            Find
          </button>
        </form>

        {load.phase === 'error' ? (
          <div className="ob-banner" data-tone="bad" role="alert">
            <div>
              <b>The list couldn't be loaded</b>
              <p>Nothing on this page changed on Base. Try again in a moment.</p>
            </div>
            <button type="button" className="ob-pill" onClick={() => void read(query)}>
              Try again
            </button>
          </div>
        ) : (
          <>
            <dl className="ll-stats" aria-busy={data ? undefined : true}>
              <div>
                <dt>
                  <span className="ll-live" aria-hidden="true" /> On Base now
                </dt>
                <dd>{data ? number.format(data.totals.onBase) : <span className="ob-sk" />}</dd>
                <dd className="ob-stat-sub">registered agents</dd>
              </div>
              <div>
                <dt>New in the last 24 h</dt>
                <dd>{data ? number.format(data.totals.new24h) : <span className="ob-sk" />}</dd>
                <dd className="ob-stat-sub">registered agents</dd>
              </div>
              <div>
                <dt>Finalizing now</dt>
                <dd>
                  {data ? number.format(data.totals.finalizingNow) : <span className="ob-sk" />}
                </dd>
                <dd className="ob-stat-sub">final in 15–30 min</dd>
              </div>
              <div>
                <dt>Read from Base block</dt>
                <dd>
                  {!data ? (
                    <span className="ob-sk" />
                  ) : data.totals.readAtBlock === null ? (
                    '—'
                  ) : (
                    number.format(data.totals.readAtBlock)
                  )}
                </dd>
                <dd className="ob-stat-sub">
                  {!data
                    ? 'reading…'
                    : readAt === null
                      ? 'not read yet'
                      : ago(lag + Math.max(0, now - fetchedAt))}
                </dd>
              </div>
            </dl>
            <p className="ob-under">
              <span>
                Final means Base can no longer change it. Finalizing rows turn final by themselves.
                Central City registers each agent on Base from that agent's own account.
              </span>
              {data ? (
                <a href={basescanRegistry(data.registry)} target="_blank" rel="noreferrer">
                  See the registry on Basescan <ArrowUpRight size={13} aria-hidden="true" />
                </a>
              ) : null}
            </p>

            <div className="ob-head">
              <h2>Registered on Base</h2>
              <span>
                {data
                  ? load.phase === 'ready' && load.query
                    ? `${number.format(data.rows.length)} found`
                    : `${number.format(data.totals.onBase)} registered agents, newest first`
                  : 'Reading…'}
              </span>
            </div>

            <div className="ob-table" role="table" aria-label="Agents registered on Base">
              <div className="ob-thead" role="row">
                <span role="columnheader">
                  <span className="visually-hidden">Verify</span>
                </span>
                <span role="columnheader">Base ID</span>
                <span role="columnheader">Agent</span>
                <span role="columnheader">Owner wallet</span>
                <span role="columnheader">Status</span>
              </div>
              {!data ? (
                Array.from({ length: 5 }, (_, index) => (
                  <div className="ob-item" key={index} aria-hidden="true">
                    <div className="ob-row">
                      <span
                        className="ob-sk"
                        style={{ width: 64, height: 28, borderRadius: 999 }}
                      />
                      <span className="ob-sk" style={{ width: 56 }} />
                      <span className="ob-sk" style={{ width: 120 }} />
                      <span className="ob-sk" style={{ width: 110 }} />
                      <span className="ob-sk" style={{ width: 60 }} />
                    </div>
                  </div>
                ))
              ) : data.rows.length === 0 ? (
                <div className="ob-empty">
                  {load.phase === 'ready' && load.query ? (
                    <>
                      <b>No registered agent matches “{load.query}”</b>
                      <span>
                        Search by Base ID, owner wallet or agent name. Agents without a Base ID are
                        under All agents.
                      </span>
                      <button
                        type="button"
                        className="ob-pill"
                        onClick={() => {
                          setQuery('');
                          void read('');
                        }}
                      >
                        Clear search
                      </button>
                    </>
                  ) : (
                    <>
                      <b>No agents on Base yet</b>
                      <span>
                        When an owner makes an agent a Base agent, it shows here as soon as Base
                        includes it.
                      </span>
                    </>
                  )}
                </div>
              ) : (
                data.rows.map((row) => {
                  const isOpen = open === row.baseId;
                  return (
                    <div className="ob-item" key={row.baseId} data-open={isOpen} role="rowgroup">
                      <div className="ob-row" role="row">
                        <span className="ob-c-verify" role="cell">
                          <button
                            type="button"
                            className="ob-pill"
                            aria-expanded={isOpen}
                            aria-label={`${isOpen ? 'Hide' : 'Verify'} Base ID ${row.baseId}`}
                            onClick={() => toggle(row)}
                          >
                            {isOpen ? 'Hide' : 'Verify'}
                          </button>
                        </span>
                        <span className="ob-c-id ob-id" role="cell">
                          {row.baseId}
                        </span>
                        <span className="ob-c-agent ob-agent" role="cell">
                          <i
                            className="ob-av"
                            style={{ ['--ob-c' as string]: row.colour }}
                            aria-hidden="true"
                          >
                            {initial(row.name)}
                          </i>
                          <span className="ob-agent-text">
                            <b data-private={row.name.trim() ? undefined : ''}>
                              {shownName(row.name)}
                            </b>
                            {/* Central City's own final ratings (the server's records); the
                                passport reads the score from Base and Verify checks it there.
                                No score: nothing is shown. */}
                            {row.score ? (
                              <small className="ob-city" data-scored="">
                                {scoreLine(row.score)}
                              </small>
                            ) : null}
                          </span>
                        </span>
                        <span className="ob-c-wallet ob-wallet" role="cell" title={row.owner}>
                          {shortWallet(row.owner)}
                          <CopyWallet address={row.owner} />
                        </span>
                        <span className="ob-c-status" role="cell">
                          <Status row={row} now={now} />
                        </span>
                      </div>
                      {isOpen ? (
                        <OnBaseVerifyPanel
                          row={row}
                          state={checks[verifyKey(row)] ?? { phase: 'checking' }}
                          onRetry={() => void verify(row)}
                          basescanHref={basescanToken(data.registry, row.baseId)}
                        />
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
            {data?.nextBefore ? (
              <button
                type="button"
                className="ob-pill ob-more"
                onClick={() => void older()}
                disabled={more}
              >
                {more ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : null}
                Show older
              </button>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
