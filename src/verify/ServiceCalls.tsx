import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Search, X } from 'lucide-react';
import {
  dayIsStale,
  keepKnownDay,
  parseServiceCallsSearch,
  SERVICE_CALLS_PAGE_SIZE,
} from '../../shared/explorer-calls';
import { PublicHeader } from '../shell/PublicHeader';
import { number } from './countLogClient';
import { ExplorerSwitch, useOnBaseCount, useStatsCounts } from './ExplorerSwitch';
import { basescanTx } from './onBaseData';
import {
  agoText,
  basescanBlock,
  callKey,
  loadServiceCalls,
  SearchRefused,
  SERVICE_CALLS_POLL_MS,
  shortHex,
  utcTime,
  type ServiceCall,
  type ServiceCallsPage,
} from './serviceCallsData';
import './verify.css';
import './on-base.css';
import './service-calls.css';

/*
 * /explorer/calls, the Agent Explorer's "Service calls" view (the approved mockup
 * explorer-service-calls.html, Operation DESIGN): every paid service call on Central City as the
 * Base transaction that paid for it, newest first, 15 per page. Only the first page is live: it is
 * read again every few seconds while the tab is visible, and rows that arrive flash once. A row
 * opens a side sheet with the transaction and where the payment went. Only what Base itself shows
 * anyone is on this page (shared/explorer-calls.ts).
 */

const SEARCH_HELP = 'Search by a transaction hash, a block number or a 0x address.';

type Load =
  | { phase: 'loading' }
  | {
      phase: 'ready';
      data: ServiceCallsPage;
      query: string;
      /** The cursors of the pages reached so far: [null (page 1), page 2's, ...]. */
      cursors: (string | null)[];
      page: number;
    }
  | { phase: 'error' };

export function CallSheet({
  call,
  now,
  onClose,
}: {
  call: ServiceCall;
  now: number;
  onClose: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, [onClose]);
  return (
    <div
      className="sc-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="sc-sheet" role="dialog" aria-modal="true" aria-labelledby="sc-sheet-title">
        <div className="sc-sheet-head">
          <h2 id="sc-sheet-title">Service call</h2>
          <button type="button" className="sc-x" aria-label="Close" onClick={onClose} ref={close}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <span className="sc-pill">Settled on Base</span>
        <p className="sc-amount">
          {call.amount} <small>USDC</small>
        </p>
        <p className="sc-svc">{call.service}</p>
        <dl className="sc-dl">
          <dt>Transaction</dt>
          <dd className="sc-mono">
            <a
              href={basescanTx(call.tx_hash)}
              target="_blank"
              rel="noreferrer"
              title={call.tx_hash}
            >
              {shortHex(call.tx_hash, 10, 8)}
            </a>
          </dd>
          <dt>Block</dt>
          <dd className="sc-num">
            {call.block === null ? (
              '—'
            ) : (
              <a href={basescanBlock(call.block)} target="_blank" rel="noreferrer">
                {number.format(call.block)}
              </a>
            )}
          </dd>
          <dt>Time</dt>
          <dd>
            {utcTime(call.time)}, {agoText(now - call.time)}
          </dd>
          <dt>Payer</dt>
          <dd className="sc-mono" title={call.payer}>
            {shortHex(call.payer, 8, 6)}
          </dd>
          <dt>Provider</dt>
          <dd className="sc-mono" title={call.provider}>
            {shortHex(call.provider, 8, 6)}
          </dd>
          <dt>Network</dt>
          <dd>Base mainnet</dd>
        </dl>
        <div className="sc-legs">
          <h3>Where the payment went</h3>
          <div className="sc-leg">
            <span>
              Provider
              <em>
                {call.fee?.model === 'included' ? 'Service price, less the fee' : 'Service price'}
              </em>
            </span>
            <b className="sc-num">{call.provider_amount} USDC</b>
          </div>
          {call.fee ? (
            <div className="sc-leg">
              <span>
                Central City protocol
                <em>
                  {call.fee.model === 'included'
                    ? '10% fee, included in the price'
                    : '10% fee, on top of the price'}
                </em>
              </span>
              <b className="sc-num">{call.fee.amount} USDC</b>
            </div>
          ) : null}
          {call.fee && call.fee.tx_hash !== call.tx_hash ? (
            <p className="sc-leg-note">
              The fee moved in its own transaction,{' '}
              <a href={basescanTx(call.fee.tx_hash)} target="_blank" rel="noreferrer">
                {shortHex(call.fee.tx_hash, 10, 8)}
              </a>
              .
            </p>
          ) : null}
        </div>
        <a className="sc-scan" href={basescanTx(call.tx_hash)} target="_blank" rel="noreferrer">
          View on BaseScan
        </a>
      </aside>
    </div>
  );
}

/** The page numbers to show: every page up to 7, else the first, the current one's neighbours. */
function pagerItems(known: number, current: number): (number | 'gap')[] {
  if (known <= 7) return Array.from({ length: known }, (_, index) => index);
  const shown = new Set([0, current - 1, current, current + 1, known - 1]);
  const items: (number | 'gap')[] = [];
  let last = -1;
  for (const page of [...shown].filter((p) => p >= 0 && p < known).sort((a, b) => a - b)) {
    if (page > last + 1) items.push('gap');
    items.push(page);
    last = page;
  }
  return items;
}

export function ServiceCalls() {
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [query, setQuery] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [open, setOpen] = useState<ServiceCall | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const stats = useStatsCounts();
  const onBase = useOnBaseCount();
  const generation = useRef(0);
  // Stable, so the open sheet keeps its focus while the seconds tick.
  const closeSheet = useCallback(() => setOpen(null), []);

  // "x sec ago" ticks each second.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const read = useCallback(async (q: string) => {
    const mine = ++generation.current;
    setLoad({ phase: 'loading' });
    setOpen(null);
    setFresh(new Set());
    try {
      const data = await loadServiceCalls({ q });
      if (mine === generation.current)
        setLoad({
          phase: 'ready',
          data,
          query: q,
          cursors: [null, ...(data.next_cursor ? [data.next_cursor] : [])],
          page: 0,
        });
    } catch (error) {
      if (mine !== generation.current) return;
      if (error instanceof SearchRefused) {
        setHint(SEARCH_HELP);
        void read('');
      } else setLoad({ phase: 'error' });
    }
  }, []);
  useEffect(() => {
    void read('');
  }, [read]);

  // Page 1 is live: read again while the tab is visible; rows not shown before flash once. Other
  // pages and an open search page stay as read. A newer search or page wins (generation).
  const shownRef = useRef(load);
  shownRef.current = load;
  useEffect(() => {
    const timer = window.setInterval(() => {
      const shown = shownRef.current;
      if (document.visibilityState !== 'visible' || shown.phase !== 'ready' || shown.page !== 0)
        return;
      const mine = generation.current;
      loadServiceCalls({ q: shown.query })
        .then((data) => {
          const current = shownRef.current;
          if (mine !== generation.current || current.phase !== 'ready' || current.page !== 0)
            return;
          const before = new Set(current.data.items.map(callKey));
          setFresh(new Set(data.items.map(callKey).filter((key) => !before.has(key))));
          setLoad({
            ...current,
            data: keepKnownDay(current.data, data),
            cursors: [null, ...(data.next_cursor ? [data.next_cursor] : [])],
          });
        })
        .catch(() => undefined);
    }, SERVICE_CALLS_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  async function goTo(page: number) {
    if (load.phase !== 'ready' || page === load.page) return;
    const cursor = load.cursors[page];
    if (cursor === undefined) return;
    const mine = ++generation.current;
    const { query: q, cursors } = load;
    try {
      const data = await loadServiceCalls({ q, cursor });
      if (mine !== generation.current) return;
      const next = cursors.slice(0, page + 1);
      if (data.next_cursor) next.push(data.next_cursor);
      setFresh(new Set());
      setOpen(null);
      setLoad({
        phase: 'ready',
        query: q,
        page,
        cursors: next,
        // A later page carries no search count; keep the first page's.
        data: { ...keepKnownDay(load.data, data), matches: data.matches ?? load.data.matches },
      });
    } catch {
      // The page stays as it was; pressing the number again retries.
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (q && !parseServiceCallsSearch(q)) {
      setHint(SEARCH_HELP);
      return;
    }
    setHint(null);
    void read(q);
  }

  const data = load.phase === 'ready' ? load.data : null;
  const searching = load.phase === 'ready' && load.query !== '';
  const live = load.phase === 'ready' && load.page === 0 && !searching;
  const of = searching ? (data?.matches ?? null) : (data?.total ?? null);
  const from = load.phase === 'ready' ? load.page * SERVICE_CALLS_PAGE_SIZE + 1 : 0;
  const to = data ? from + data.items.length - 1 : 0;
  // USDC, 2 decimals, from 6-decimal raw units (the price buyers paid, fee included).
  const usdc = (raw: string | null | undefined) =>
    raw == null
      ? stat(null)
      : `${(Number(BigInt(raw)) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
  const stat = (value: number | null | undefined) =>
    !data ? (
      <span className="ob-sk" />
    ) : value === null || value === undefined ? (
      '—'
    ) : (
      number.format(value)
    );

  return (
    <div className="public-shell">
      <PublicHeader current="downtown" />
      <main id="main-content" tabIndex={-1} className="public-main vf-main ll-main ob-main sc-main">
        <header className="vf-head">
          <p className="vf-eyebrow">
            Downtown · Transparency · <a href="/downtown/verify">Verify the count</a>
          </p>
          <h1>Agent Explorer</h1>
          <ExplorerSwitch
            current="calls"
            all={stats.all}
            onBase={onBase}
            calls={data?.total ?? stats.calls}
          />
          <p className="vf-lede">
            Every paid service call on Central City, live from Base. Each row is the onchain
            transaction that paid for it; open any of them on BaseScan.
          </p>
        </header>

        <form className="ll-search ll-search-hero" role="search" onSubmit={submit}>
          <label htmlFor="sc-query" className="visually-hidden">
            Search paid service calls
          </label>
          <Search size={16} aria-hidden="true" />
          <input
            id="sc-query"
            className="vf-input sc-query"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHint(null);
            }}
            maxLength={80}
            placeholder="Transaction hash, block or address"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={hint ? 'sc-hint' : undefined}
          />
          <button type="submit" className="ob-pill ink" disabled={load.phase === 'loading'}>
            Find
          </button>
        </form>
        {hint ? (
          <p className="sc-hint" id="sc-hint" role="status">
            {hint}
          </p>
        ) : null}

        {load.phase === 'error' ? (
          <div className="ob-banner" data-tone="bad" role="alert">
            <div>
              <b>The service calls couldn't be loaded</b>
              <p>Every payment is still on Base. Try again in a moment.</p>
            </div>
            <button type="button" className="ob-pill" onClick={() => void read(query.trim())}>
              Try again
            </button>
          </div>
        ) : (
          <>
            <dl className="ll-stats" aria-busy={data ? undefined : true}>
              <div>
                <dt>
                  <span className="ll-live" aria-hidden="true" /> Paid service calls
                </dt>
                <dd>{stat(data?.total)}</dd>
              </div>
              <div>
                <dt>Last 24 h</dt>
                <dd>{stat(data?.last24h)}</dd>
              </div>
              <div>
                <dt>Per minute now</dt>
                <dd>{stat(data?.perMinute)}</dd>
              </div>
              <div>
                <dt>Value settled (24h)</dt>
                <dd>{usdc(data?.value24hRaw)}</dd>
              </div>
              <div>
                <dt>Protocol revenue (24h)</dt>
                <dd>{usdc(data?.fee24hRaw)}</dd>
              </div>
            </dl>
            <p className="ob-under">
              <span>Paid in USDC on Base mainnet. New payments appear within seconds.</span>
              {data && dayIsStale(data, now) && data.day_as_of ? (
                <span>
                  {' '}
                  24 h numbers as of{' '}
                  {new Date(data.day_as_of).toLocaleString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: 'UTC',
                  })}{' '}
                  UTC, counting again.
                </span>
              ) : null}
            </p>

            <section className="sc-panel" aria-labelledby="sc-latest">
              <div className="sc-panel-head">
                <h2 id="sc-latest">
                  {searching ? 'Matching transactions' : 'Latest transactions'}
                </h2>
                <span className="sc-shown">
                  {!data
                    ? 'Reading…'
                    : data.items.length === 0
                      ? ''
                      : `Showing ${number.format(from)}–${number.format(to)}${
                          of === null ? '' : ` of ${number.format(of)}`
                        }`}
                </span>
                {live ? (
                  <span className="sc-live">
                    <span className="ll-live" aria-hidden="true" />
                    Live
                  </span>
                ) : null}
              </div>
              <div className="sc-tbl">
                <table aria-label="Paid service calls on Base">
                  <thead>
                    <tr>
                      <th scope="col">Tx hash</th>
                      <th scope="col">Service</th>
                      <th scope="col">Time</th>
                      <th scope="col">Block</th>
                      <th scope="col">Payer</th>
                      <th scope="col">Provider</th>
                      <th scope="col" className="sc-r">
                        Amount
                      </th>
                      <th scope="col" className="sc-r">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {!data
                      ? Array.from({ length: 5 }, (_, index) => (
                          <tr key={index} aria-hidden="true" className="sc-sk-row">
                            {[96, 140, 64, 72, 88, 88, 60, 56].map((width, cell) => (
                              <td key={cell}>
                                <span
                                  className="ob-sk"
                                  style={{ width, display: 'inline-block' }}
                                />
                              </td>
                            ))}
                          </tr>
                        ))
                      : data.items.map((call) => {
                          const key = callKey(call);
                          return (
                            <tr
                              key={key}
                              className={fresh.has(key) ? 'sc-fresh' : undefined}
                              onClick={() => setOpen(call)}
                            >
                              <td className="sc-mono">
                                <a
                                  href={basescanTx(call.tx_hash)}
                                  target="_blank"
                                  rel="noreferrer"
                                  title={call.tx_hash}
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  {shortHex(call.tx_hash, 8, 6)}
                                </a>
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="sc-open"
                                  title={call.service}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setOpen(call);
                                  }}
                                >
                                  {call.service}
                                </button>
                              </td>
                              <td className="sc-ago">{agoText(now - call.time)}</td>
                              <td className="sc-num">
                                {call.block === null ? (
                                  '—'
                                ) : (
                                  <a
                                    href={basescanBlock(call.block)}
                                    target="_blank"
                                    rel="noreferrer"
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    {number.format(call.block)}
                                  </a>
                                )}
                              </td>
                              <td className="sc-mono" title={call.payer}>
                                {shortHex(call.payer)}
                              </td>
                              <td className="sc-mono" title={call.provider}>
                                {shortHex(call.provider)}
                              </td>
                              <td className="sc-r sc-num">
                                <b>{call.amount}</b> <span className="sc-ago">USDC</span>
                              </td>
                              <td className="sc-r">
                                <span className="sc-pill">Settled</span>
                              </td>
                            </tr>
                          );
                        })}
                  </tbody>
                </table>
                {data && data.items.length === 0 ? (
                  <div className="ob-empty">
                    {searching && load.phase === 'ready' ? (
                      <>
                        <b>No paid service call matches “{load.query}”</b>
                        <span>{SEARCH_HELP}</span>
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
                        <b>No paid service calls yet</b>
                        <span>Each paid call shows here as soon as Base settles its payment.</span>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
              {load.phase === 'ready' && load.cursors.length > 1 ? (
                <nav className="sc-pager" aria-label="Pages">
                  {pagerItems(load.cursors.length, load.page).map((item, index) =>
                    item === 'gap' ? (
                      <span key={`gap-${index}`} className="sc-gap" aria-hidden="true">
                        …
                      </span>
                    ) : (
                      <button
                        key={item}
                        type="button"
                        aria-current={item === load.page ? 'page' : undefined}
                        aria-label={`Page ${item + 1}`}
                        onClick={() => void goTo(item)}
                      >
                        {item + 1}
                      </button>
                    ),
                  )}
                </nav>
              ) : null}
            </section>
          </>
        )}
      </main>
      {open ? <CallSheet call={open} now={now} onClose={closeSheet} /> : null}
    </div>
  );
}
