import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Copy, Search } from 'lucide-react';
import { PublicHeader } from '../shell/PublicHeader';
import { subscribeStats, type StatsResponse } from '../agentCount';
import { number } from '../verify/countLogClient';
import {
  basescanAddress,
  basescanRegistry,
  basescanToken,
  basescanTx,
  initial,
  incompleteNote,
  loadOnBase,
  refusedSearchNote,
  searchNotes,
  passportPath,
  shortWallet,
  shownName,
  verifyOnBase,
  type OnBaseList,
  type OnBaseRow,
} from '../verify/onBaseData';
import { OnBaseVerifyPanel, type VerifyState } from '../verify/OnBaseVerifyPanel';
import {
  agoText,
  loadServiceCalls,
  shortHex,
  utcTime,
  type ServiceCall,
} from '../verify/serviceCallsData';
import { BASE_MAINNET, BASE_NETWORKS } from '../../shared/base/chains';
import {
  couldBeName,
  createPollState,
  feedStatus,
  mergeStats,
  searchKind,
  typedKind,
  type FeedState,
  type TypedKind,
} from './homeModel';
import {
  countText,
  loadAgentMetrics,
  loadHistory,
  loadTypedSearch,
  priceRangeText,
  type AgentMetric,
  type HistoryMetric,
  type HistorySeries,
  type RatingEvents,
  type X3,
} from './x3Client';
import { DisclosureLine } from './proofParts';
import '../verify/on-base.css';
import './explorer.css';

/*
 * Explorer v2 home (/explorer), the approved design of 24 Oct 2026: search, the five counters each
 * with its source and its own proof page, the line saying which Base block the numbers were read
 * at, live paid calls, the newest agents on Base with Verify in the row, and "Verify it yourself".
 * Every number comes from an existing public route; nothing here writes.
 */

const REFRESH_MS = 15_000;
const REPUTATION_REGISTRY = BASE_NETWORKS[BASE_MAINNET].contracts.reputationRegistry;
const FEE_ROUTER_3 = '0xe807a76385ec3d76d17ab955091c12329d0a1403';
const AVATARS = ['#0A5CFF', '#7A5AF8', '#12B76A', '#F79009', '#E5484D', '#0B1220'];

export const PROOF_ROUTES = {
  agents: '/explorer/proof/agents',
  base: '/explorer/proof/base',
  finalizing: '/explorer/proof/finalizing',
  calls: '/explorer/proof/calls',
  ratings: '/explorer/proof/ratings',
} as const;

type Stat = {
  key: keyof typeof PROOF_ROUTES;
  label: string;
  value: number | null;
  sub: string;
  source: string;
  /** Growth per second when known from a 24 h figure; else from the recorded hourly readings. */
  rate?: number | null;
};

const HISTORY_REFRESH_MS = 60_000;
/** How a typed search's kind reads in the results bar. */
const KIND_LABEL: Record<TypedKind, string> = {
  baseId: 'Base ID',
  shortId: 'passport id',
  address: 'agent wallet',
  txHash: 'registration transaction',
  name: 'name',
};
/** A poll read older than this no longer blocks the next one. */
const POLL_STUCK_MS = 30_000;
const METRICS_REFRESH_MS = 60_000;

type RatingEventsRead = RatingEvents & { exhausted: boolean };
/** The last answer of an X3 read, and whether the latest refresh failed after it. */
type Kept<T> = { last: X3<T>; failing: boolean };
/** A failed refresh keeps the last good answer, marked failing; anything else replaces it. */
const keep =
  <T,>(next: X3<T>) =>
  (prev: Kept<T> | null): Kept<T> =>
    next.state === 'unavailable' && prev?.last.state === 'ok'
      ? { last: prev.last, failing: true }
      : {
          last: next,
          // A 200 the server marked stale is shown as not refreshed too, never as live.
          failing: next.state === 'unavailable' || (next.state === 'ok' && next.stale),
        };
const fmt = (n: number | null | undefined) => (typeof n === 'number' ? number.format(n) : null);

function avatarColour(row: OnBaseRow) {
  if (row.colour) return row.colour;
  const n = Number(row.baseId.slice(-3)) || 0;
  return AVATARS[n % AVATARS.length];
}

/** Read now, then again while the tab is visible; one read at once; a hidden tab reads again when shown. */
function useVisiblePoll(read: (isCurrent: () => boolean) => Promise<void>, everyMs: number) {
  // One read at a time; a read stuck past POLL_STUCK_MS no longer blocks the next; a superseded
  // read that settles late commits nothing (createPollState, homeModel.ts).
  useEffect(() => {
    const poll = createPollState(POLL_STUCK_MS);
    let stopped = false;
    let first = true;
    const tick = async () => {
      // The first read always runs (a page opened in a background tab still fills in);
      // repeats pause while the tab is hidden.
      if (stopped || (!first && document.visibilityState === 'hidden')) return;
      const run = poll.begin(Date.now());
      if (!run) return;
      first = false;
      try {
        await read(run.isCurrent);
      } finally {
        run.done();
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), everyMs);
    const onShow = () => void tick();
    document.addEventListener('visibilitychange', onShow);
    return () => {
      stopped = true;
      poll.stop();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [read, everyMs]);
}

export function ExplorerHome() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [list, setList] = useState<OnBaseList | null>(null);
  const [calls, setCalls] = useState<ServiceCall[] | null>(null);
  const [callsDay, setCallsDay] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // X3 reads (#635, #636, #637): null until the first answer; 'absent' while not deployed.
  // A failed refresh keeps the last good answer on screen, marked failing (never shown as live).
  const [metrics, setMetrics] = useState<Kept<Map<string, AgentMetric>> | null>(null);
  const [history, setHistory] = useState<Kept<Map<HistoryMetric, HistorySeries>> | null>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{
    q: string;
    rows: OnBaseRow[];
    calls: ServiceCall[];
    /** The list search's note that names may be missing (incompleteNote), '' when complete. */
    incomplete?: string;
    /** Why names were not searched (refusedSearchNote, or the list's notice), '' when they were. */
    note?: string;
    /** True when the text was not searched at all (the list refuses it): `note` says why. */
    refused?: boolean;
    /** Set when the typed search (#630) answered: its kind and continuation. */
    typed?: {
      kind: TypedKind;
      nextBefore: string | null;
      stale: boolean;
      asOf: number | null;
      /** No passport id matched, so the name search ran by itself. */
      fellBack?: boolean;
    };
  } | null>(null);
  const [searching, setSearching] = useState(false);
  // The failed search as asked, its forced kind included, so Try again repeats exactly that.
  const [searchFailed, setSearchFailed] = useState<{ q: string; force: TypedKind | null } | null>(
    null,
  );
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  /** The query whose registration search found the typed search not deployed (404). */
  const [registrationAbsent, setRegistrationAbsent] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, VerifyState>>({});
  const attempts = useRef<Record<string, number>>({});
  const [listFeed, setListFeed] = useState<FeedState>({ lastOk: null, failed: false });
  const [callsFeed, setCallsFeed] = useState<FeedState>({ lastOk: null, failed: false });

  useEffect(() => subscribeStats((next) => next && setStats((prev) => mergeStats(prev, next))), []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  // A failed read keeps the last good data on screen and marks the feed stale (feedStatus).
  // Each read commits its answer (or its failure) only while it is still the newest one.
  const readList = useCallback(async (isCurrent: () => boolean) => {
    try {
      const page = await loadOnBase({ timeoutMs: 12_000 });
      if (!isCurrent()) return;
      setList(page);
      setListFeed({ lastOk: Date.now(), failed: false });
    } catch {
      if (isCurrent()) setListFeed((f) => ({ ...f, failed: true }));
    }
  }, []);
  const readCalls = useCallback(async (isCurrent: () => boolean) => {
    try {
      const page = await loadServiceCalls();
      if (!isCurrent()) return;
      setCalls(page.items);
      if (typeof page.last24h === 'number') setCallsDay(page.last24h);
      setCallsFeed({ lastOk: Date.now(), failed: false });
    } catch {
      if (isCurrent()) setCallsFeed((f) => ({ ...f, failed: true }));
    }
  }, []);
  useVisiblePoll(readList, REFRESH_MS);
  useVisiblePoll(readCalls, REFRESH_MS);
  const readHistory = useCallback(async (isCurrent: () => boolean) => {
    const next = await loadHistory();
    if (isCurrent()) setHistory(keep(next));
  }, []);
  useVisiblePoll(readHistory, HISTORY_REFRESH_MS);

  // One Verify per row at a time: each start gets a number, and an answer for an older number
  // (closed or retried meanwhile) is dropped. Side effects stay outside the state updaters.
  const verify = useCallback((row: OnBaseRow) => {
    const attempt = (attempts.current[row.baseId] ?? 0) + 1;
    attempts.current[row.baseId] = attempt;
    setChecks((all) => ({ ...all, [row.baseId]: { phase: 'checking' } }));
    void verifyOnBase(row).then((result) => {
      if (attempts.current[row.baseId] !== attempt) return;
      setChecks((all) =>
        all[row.baseId] ? { ...all, [row.baseId]: { phase: 'done', result } } : all,
      );
    });
  }, []);
  const toggle = (row: OnBaseRow) => {
    if (checks[row.baseId]) {
      attempts.current[row.baseId] = (attempts.current[row.baseId] ?? 0) + 1;
      setChecks((all) => {
        const next = { ...all };
        delete next[row.baseId];
        return next;
      });
    } else verify(row);
  };

  // The typed search (#630) when it is deployed; until then (404) the list search as before.
  // Only the newest search (or Load more) may commit anything, its finally included; Clear and
  // leaving the page make every search in flight stale.
  const searchGeneration = useRef(0);
  useEffect(() => () => void (searchGeneration.current += 1), []);
  const clearSearch = () => {
    searchGeneration.current += 1;
    setSearching(false);
    setSearchFailed(null);
    setLoadMoreFailed(false);
    setRegistrationAbsent(null);
    setFound(null);
    setQuery('');
  };
  /**
   * force: read the query as that kind (a name instead of a number, a registration instead of a
   * paid call). before: Load more from that continuation, appended to the same query AND kind.
   */
  const runSearch = async (
    q: string,
    force: TypedKind | null = null,
    before: string | null = null,
  ) => {
    const kind = searchKind(q);
    if (kind === 'empty') {
      clearSearch();
      return;
    }
    const mine = ++searchGeneration.current;
    const current = () => searchGeneration.current === mine;
    setSearching(true);
    if (before) setLoadMoreFailed(false);
    setRegistrationAbsent(null);
    try {
      if (kind === 'tx' && !force) {
        const page = await loadServiceCalls({ q });
        if (!current()) return;
        setFound({ q, rows: [], calls: page.items });
        setSearchFailed(null);
        return;
      }
      let typed = force ?? typedKind(q);
      let answer = typed ? await loadTypedSearch(typed, q, before) : null;
      if (!current()) return;
      // A six-character query read as a passport id that matches none: it may well be a name
      // ("Vemino"), so the name search runs by itself and the bar says so (product decision, 25 Oct).
      let fellBack = false;
      if (
        typed === 'shortId' &&
        !force &&
        !before &&
        answer?.state === 'ok' &&
        !answer.value.rows.length &&
        !answer.value.nextBefore
      ) {
        typed = 'name';
        fellBack = true;
        answer = await loadTypedSearch('name', q, null);
        if (!current()) return;
      }
      if (typed && answer?.state === 'ok') {
        const rows = answer.value.rows as unknown as OnBaseRow[];
        setFound((prev) => {
          const append = !!before && prev?.q === q && prev.typed?.kind === typed;
          return {
            q,
            rows: append ? [...prev!.rows, ...rows] : rows,
            calls: [],
            typed: {
              kind: typed,
              fellBack: !append ? fellBack : !!prev!.typed?.fellBack,
              nextBefore: answer.value.nextBefore,
              stale: answer.stale || (append && !!prev!.typed?.stale),
              // The oldest observation among the pages shown; unknown if any page did not say.
              asOf: !append
                ? answer.value.asOf
                : prev!.typed!.asOf === null || answer.value.asOf === null
                  ? null
                  : Math.min(prev!.typed!.asOf, answer.value.asOf),
            },
          };
        });
        setSearchFailed(null);
      } else if (answer?.state === 'unavailable') {
        // A failed search is not an empty result: keep what was shown and say so, next to it.
        if (before) setLoadMoreFailed(true);
        else setSearchFailed({ q, force });
      } else if (typed === 'txHash') {
        // Not deployed yet, and the list search cannot find a registration by its transaction:
        // keep the paid calls shown and say so, never a "Nothing found." for a search not made.
        setRegistrationAbsent(q);
      } else if (refusedSearchNote(q)) {
        // A text the list refuses (a 1-2 character name): not searched, and it says why.
        setFound({ q, rows: [], calls: [], note: refusedSearchNote(q), refused: true });
        setSearchFailed(null);
      } else {
        // Not deployed yet: the list search, which can take about 20 s for a name.
        const page = await loadOnBase({ q, timeoutMs: 25_000 });
        if (!current()) return;
        setFound({
          q,
          rows: page.rows,
          calls: [],
          incomplete: incompleteNote(page),
          note: searchNotes({ notice: page.notice }),
        });
        setSearchFailed(null);
      }
    } catch {
      if (!current()) return;
      if (before) setLoadMoreFailed(true);
      else setSearchFailed({ q, force });
    } finally {
      if (current()) setSearching(false);
    }
  };

  const onSearch = async (event: FormEvent) => {
    event.preventDefault();
    await runSearch(query.trim());
  };

  const listStatus = feedStatus(listFeed, now, REFRESH_MS);
  const callsStatus = feedStatus(callsFeed, now, REFRESH_MS);

  const totals = list?.totals;
  const statCards: Stat[] = [
    {
      key: 'agents',
      label: 'AI agents',
      value: stats?.agents?.total ?? null,
      sub: 'live count',
      source: 'Signed checkpoint',
    },
    {
      key: 'base',
      label: 'On Base now',
      // One source, the On Base list (as its proof page): the stats' base total differs a little,
      // and switching from it to the list's number showed as a second, long count. The stats
      // total stands in only when the list did not answer.
      value: totals?.onBase ?? (listStatus === 'failed' ? (stats?.base?.total ?? null) : null),
      sub: totals ? `+${number.format(totals.new24h)} in 24 h` : '',
      source: 'Identity Registry',
      rate: totals ? totals.new24h / 86_400 : null,
    },
    {
      key: 'finalizing',
      label: 'Finalizing now',
      value: totals?.finalizingNow ?? null,
      sub: 'final in 15 to 30 min',
      source: 'Base blocks',
      // A backlog, not a total: it rises and falls, so it is never run ahead of a read.
      rate: 0,
    },
    {
      key: 'calls',
      label: 'Paid service calls',
      value: stats?.paid?.total ?? null,
      sub: callsDay !== null ? `${number.format(callsDay)} in 24 h` : '',
      source: 'Fee routers',
      rate: callsDay !== null ? callsDay / 86_400 : null,
    },
    {
      key: 'ratings',
      label: 'Rated agents',
      value: totals?.ratedAgents ?? null,
      sub: 'final on Base',
      source: 'Reputation Registry',
    },
  ];

  const rows = found ? found.rows : (list?.rows ?? []).slice(0, 12);
  // A sparse name page can be empty and still have more behind it: that is not "nothing found".
  const emptySearchText = found?.typed?.nextBefore
    ? loadMoreFailed
      ? 'No match yet, and the next part did not load. Use Try again above.'
      : 'No match in this part yet. Use Load more to keep looking.'
    : found && !found.typed && searchKind(found.q) === 'tx'
      ? // A transaction hash searched paid calls only: agents were not searched at all.
        registrationAbsent === found.q
        ? 'A transaction hash searches paid calls; registration search is not available yet.'
        : 'A transaction hash searches paid calls. Use Search registrations instead for an agent.'
      : found?.refused
        ? `${found.note}.`
        : found?.incomplete
          ? // The name index is still building: an empty page is not proof the agent is absent.
            'No matches in the results available so far.'
          : 'Nothing found.';
  const shownCalls = found ? found.calls : (calls ?? []).slice(0, 10);
  const registry = list?.registry;
  const rowIds = rows.map((row) => row.baseId).join(',');
  // The listed agents' metrics: read when the list changes and again every METRICS_REFRESH_MS
  // while visible; only the newest read (generation) may set the answer.
  const metricsFor = useRef(rowIds);
  metricsFor.current = rowIds;
  const metricsGeneration = useRef(0);
  // Called by the poller (with isCurrent) and on a list change (without): its own generation
  // already drops any answer that is not the newest for the current IDs.
  const readMetrics = useCallback(async (isCurrent: () => boolean = () => true) => {
    const ids = metricsFor.current;
    if (!ids) return;
    const mine = ++metricsGeneration.current;
    const next = await loadAgentMetrics(ids.split(','));
    if (isCurrent() && mine === metricsGeneration.current && metricsFor.current === ids)
      setMetrics(keep(next));
  }, []);
  useVisiblePoll(readMetrics, METRICS_REFRESH_MS);
  useEffect(() => {
    void readMetrics();
  }, [rowIds, readMetrics]);
  const showMetrics = !!metrics?.last && metrics.last.state !== 'absent';

  return (
    <div className="xp">
      <PublicHeader current="downtown" />
      <main className="xp-main">
        <section className="xp-hero">
          <div className="xp-eyebrow">
            <span className="xp-dot" aria-hidden="true" />
            Live on Base mainnet
          </div>
          <h1 className="xp-title">Every AI agent on Central City, live and verifiable.</h1>
          <p className="xp-lede">
            Agents, their Base IDs, every paid call and every rating. Each number links to its
            proof.
          </p>
          <form id="xp-search-form" role="search" className="xp-search" onSubmit={onSearch}>
            <label htmlFor="xp-q" className="visually-hidden">
              Search the Explorer
            </label>
            <div className="xp-search-box">
              <Search size={20} aria-hidden="true" />
              <input
                id="xp-q"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Agent name, Base ID, wallet or transaction"
              />
            </div>
            <button type="submit" className="xp-btn" disabled={searching}>
              {searching ? 'Searching…' : 'Search'}
            </button>
          </form>
          {searching ? (
            <div className="xp-tries" role="status">
              <span>Searching. A name search can take up to 20 seconds.</span>
            </div>
          ) : null}
          {searchFailed ? (
            <div className="xp-tries" role="alert">
              <span>
                The search for <b className="xp-mono">{searchFailed.q}</b>
                {searchFailed.force ? ` (${KIND_LABEL[searchFailed.force]})` : ''} did not get an
                answer.
              </span>
              <button
                type="button"
                className="xp-chip"
                onClick={() => void runSearch(searchFailed.q, searchFailed.force)}
                disabled={searching}
              >
                Try again
              </button>
            </div>
          ) : null}
          {found ? (
            <div className="xp-tries">
              <span>
                Results for <b className="xp-mono">{found.q}</b>
                {found.typed
                  ? found.typed.fellBack
                    ? ' (name; no passport id matched)'
                    : ` (${KIND_LABEL[found.typed.kind]})`
                  : ''}
                {found.incomplete ? ` · ${found.incomplete}` : ''}
                {found.note ? ` · ${found.note}` : ''}
                {found.typed?.stale ? ' · not refreshed, showing the last answer' : ''}
                {found.typed?.asOf != null ? ` · as of ${utcTime(found.typed.asOf)}` : ''}
              </span>
              {found.typed && found.typed.kind !== 'name' && couldBeName(found.q) ? (
                <button
                  type="button"
                  className="xp-chip"
                  onClick={() => void runSearch(found.q, 'name')}
                  disabled={searching}
                >
                  Search names instead
                </button>
              ) : null}
              {registrationAbsent === found.q ? (
                <span role="status">Registration search is not available yet.</span>
              ) : null}
              {!found.typed && searchKind(found.q) === 'tx' && registrationAbsent !== found.q ? (
                <button
                  type="button"
                  className="xp-chip"
                  onClick={() => void runSearch(found.q, 'txHash')}
                  disabled={searching}
                >
                  Search registrations instead
                </button>
              ) : null}
              {found.typed?.kind === 'txHash' ? (
                <button
                  type="button"
                  className="xp-chip"
                  onClick={() => void runSearch(found.q)}
                  disabled={searching}
                >
                  Search paid calls instead
                </button>
              ) : null}
              {found.typed?.nextBefore ? (
                <button
                  type="button"
                  className="xp-chip"
                  onClick={() =>
                    void runSearch(found.q, found.typed!.kind, found.typed!.nextBefore)
                  }
                  disabled={searching}
                >
                  {loadMoreFailed ? 'Load more did not get an answer · Try again' : 'Load more'}
                </button>
              ) : null}
              <button type="button" className="xp-chip" onClick={clearSearch}>
                Clear
              </button>
            </div>
          ) : null}
        </section>

        <section aria-label="Counts" className="xp-stats">
          {statCards.map((stat) => (
            <StatCard
              key={stat.key}
              stat={stat}
              series={history?.last.state === 'ok' ? history.last.value.get(stat.key) : undefined}
            />
          ))}
        </section>
        <DisclosureLine />

        <section aria-label="Proof" className="xp-proofline">
          <div className="xp-proofbar">
            <strong>
              <span className="xp-dot" aria-hidden="true" />
              {totals?.readAtBlock
                ? `Agents on Base read at Base block ${number.format(totals.readAtBlock)}${
                    totals.readAt ? ` · ${agoText(Math.max(0, now - totals.readAt))}` : ''
                  }`
                : listStatus === 'failed'
                  ? 'Agents on Base: no answer yet'
                  : 'Reading Base…'}
            </strong>
            {registry ? (
              <span>
                Identity Registry{' '}
                <a className="xp-mono" href={basescanRegistry(registry)}>
                  {shortHex(registry)}
                </a>
                <CopyAddress address={registry} iconOnly />
              </span>
            ) : null}
            <span>
              Reputation Registry{' '}
              <a className="xp-mono" href={basescanAddress(REPUTATION_REGISTRY)}>
                {shortHex(REPUTATION_REGISTRY)}
              </a>
              <CopyAddress address={REPUTATION_REGISTRY} iconOnly />
            </span>
            <span>
              Fee router 3{' '}
              <a className="xp-mono" href={basescanAddress(FEE_ROUTER_3)}>
                {shortHex(FEE_ROUTER_3)}
              </a>
              <CopyAddress address={FEE_ROUTER_3} iconOnly />
            </span>
            <span>
              <a href={PROOF_ROUTES.agents}>Latest signed daily checkpoint</a>
            </span>
          </div>
        </section>

        {found && searchKind(found.q) === 'tx' ? (
          <section className="xp-panel" aria-label="Paid calls found">
            <div className="xp-panel-head">
              <h2>Paid calls</h2>
              <span className="xp-panel-note">for this transaction</span>
            </div>
            {shownCalls.length ? (
              shownCalls.map((call) => (
                <div className="xp-row" key={`${call.tx_hash}-${call.ref}`}>
                  <span className="xp-pill xp-pill-ok">Paid call</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="xp-row-title">{call.service}</div>
                    <a className="xp-row-meta" href={basescanTx(call.tx_hash)}>
                      {shortHex(call.tx_hash, 10, 4)}
                      {call.fee
                        ? ` · ${call.provider_amount} to seller, ${call.fee.amount} fee`
                        : ''}
                    </a>
                  </div>
                  <div className="xp-row-end">
                    <div className="xp-row-amount">{call.amount} USDC</div>
                    <div className="xp-row-when">{agoText(Math.max(0, now - call.time))}</div>
                  </div>
                </div>
              ))
            ) : (
              <div className="xp-empty">
                {found && searchKind(found.q) !== 'tx'
                  ? 'Paid calls are found by their transaction hash.'
                  : callsStatus === 'failed'
                    ? 'Paid calls did not load. Retrying every 15 s.'
                    : calls === null
                      ? 'Loading…'
                      : 'Nothing found.'}
              </div>
            )}
            <div className="xp-panel-foot">
              <a href={PROOF_ROUTES.calls}>All paid calls</a>
            </div>
          </section>
        ) : null}

        <section className="xp-panel" aria-label="Agents on Base">
          <div className="xp-panel-head">
            <h2>Agents on Base</h2>
            <span className="xp-live" data-state={found ? 'search' : listStatus}>
              <span className="xp-dot" aria-hidden="true" />
              {found
                ? 'Search results'
                : listStatus === 'live'
                  ? 'Live'
                  : listStatus === 'loading'
                    ? 'Loading'
                    : listStatus === 'stale'
                      ? 'Not refreshed'
                      : 'No answer, retrying'}
            </span>
            <span className="xp-panel-note">newest first · Verify reads Base in your browser</span>
          </div>
          <div className="xp-table-wrap">
            <table className="xp-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Base ID</th>
                  <th>Owner</th>
                  {showMetrics ? (
                    <>
                      <th title="Services this agent offers for sale">Services</th>
                      <th
                        className="xp-num"
                        title="Settled paid calls this agent sold, all recorded time"
                      >
                        Paid calls
                      </th>
                    </>
                  ) : null}
                  <th>Proof</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const state = checks[row.baseId];
                  return (
                    <AgentRow
                      key={row.baseId}
                      row={row}
                      state={state}
                      registry={registry}
                      onToggle={() => toggle(row)}
                      onRetry={() => verify(row)}
                      metricCells={showMetrics ? metricCells(metrics, row.baseId) : null}
                    />
                  );
                })}
                {!rows.length ? (
                  <tr>
                    <td colSpan={showMetrics ? 6 : 4} className="xp-empty">
                      {found
                        ? emptySearchText
                        : listStatus === 'failed'
                          ? 'Agents on Base did not load. Retrying every 15 s.'
                          : list === null
                            ? 'Loading…'
                            : 'Nothing found.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="xp-dark">
          <div style={{ flex: '1 1 420px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="xp-eyebrow">Verify it yourself</div>
            <h2>Don't trust our numbers. Check them.</h2>
            <p>
              The agent count is signed every day at 12:00 CET and witnessed in a public repository.
              Any Base ID is checked straight on Base in your browser.
            </p>
            <div className="xp-dark-actions">
              <a className="xp-dark-primary" href={PROOF_ROUTES.base}>
                Verify a Base ID
              </a>
              <a className="xp-dark-secondary" href={PROOF_ROUTES.agents}>
                Check today's checkpoint
              </a>
            </div>
          </div>
          <div className="xp-dark-grid">
            <div className="xp-dark-cell">
              <span>Identity Registry</span>
              {registry ? <CopyAddress address={registry} /> : <b>–</b>}
            </div>
            <div className="xp-dark-cell">
              <span>Reputation Registry</span>
              <CopyAddress address={REPUTATION_REGISTRY} />
            </div>
            <div className="xp-dark-cell">
              <span>Fee router 3</span>
              <CopyAddress address={FEE_ROUTER_3} />
            </div>
            <div className="xp-dark-cell">
              <span>Checkpoint</span>
              <b>daily 12:00 CET</b>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function AgentRow({
  row,
  state,
  registry,
  onToggle,
  onRetry,
  metricCells,
}: {
  row: OnBaseRow;
  state: VerifyState | undefined;
  registry: string | undefined;
  onToggle: () => void;
  onRetry: () => void;
  /** The Services and Paid calls cells when the metrics endpoint is deployed; else null. */
  metricCells: ReactNode;
}) {
  return (
    <>
      <tr>
        <td>
          <div className="xp-agent">
            <span
              className="xp-avatar"
              style={{ background: avatarColour(row) }}
              aria-hidden="true"
            >
              {initial(row.name) || '?'}
            </span>
            <div>
              <a className="xp-agent-name" href={`/explorer/agents/${row.baseId}`}>
                {shownName(row.name)}
              </a>
              <div className="xp-sub">/a/{row.short}</div>
            </div>
          </div>
        </td>
        <td className="xp-mono">{row.baseId}</td>
        <td>
          <a className="xp-mono" href={basescanAddress(row.owner)}>
            {shortWallet(row.owner)}
          </a>
        </td>
        {metricCells}
        <td>
          <div className="xp-proof-cell">
            <span className={`xp-pill ${row.status === 'final' ? 'xp-pill-ok' : 'xp-pill-wait'}`}>
              {row.status === 'final' ? 'Final' : 'Finalizing'}
            </span>
            <button
              type="button"
              className="xp-verify-btn"
              aria-expanded={state !== undefined}
              onClick={onToggle}
            >
              {state ? 'Hide' : 'Verify'}
            </button>
          </div>
        </td>
      </tr>
      {state ? (
        <tr className="xp-verify-row">
          <td colSpan={metricCells ? 6 : 4}>
            <OnBaseVerifyPanel
              row={row}
              state={state}
              onRetry={onRetry}
              basescanHref={
                registry ? basescanToken(registry, row.baseId) : basescanAddress(row.owner)
              }
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** The Services and Paid calls cells of one agent: unknown is "–", a lower bound keeps its +. */
function metricCells(metrics: Kept<Map<string, AgentMetric>> | null, baseId: string): ReactNode {
  const last = metrics?.last;
  const metric = last?.state === 'ok' ? last.value.get(baseId) : undefined;
  const unavailable = last?.state !== 'ok';
  const staleNote =
    metrics?.failing && !unavailable ? 'Not refreshed, showing the last answer' : null;
  const range = metric?.offeredServices
    ? priceRangeText(metric.offeredServices.priceRangeRaw)
    : null;
  return (
    <>
      <td
        className="xp-num"
        title={
          unavailable
            ? 'Not available right now'
            : [range, staleNote].filter(Boolean).join(' · ') || undefined
        }
      >
        {countText(metric?.offeredServices)}
      </td>
      <td
        className="xp-num"
        title={unavailable ? 'Not available right now' : (staleNote ?? undefined)}
      >
        {countText(metric?.paidCallsSold)}
      </td>
    </>
  );
}

/**
 * A counter's recorded hourly totals since collection began: broken at every missing hour, never
 * interpolated, nothing drawn with fewer than two observed hours. A total over time, never a rate.
 */

/** The first answer counts up fast to where the counter stood LAG_S ago, then at its real rate. */
const COUNT_FIRST_MS = 1_200;
const LAG_S = 40;
/** Each later answer is reached over two polls: the stats may repeat a cached value for one. */
const COUNT_STEP_MS = 30_000;
/**
 * A counter's shown value. It never runs ahead of the last answer: on the first answer it counts
 * up fast to the value LAG_S seconds earlier (from the counter's recorded growth rate) and then
 * moves at that rate to the answer; each later answer is reached steadily over two polls. So a
 * number keeps moving between reads instead of jumping and then standing still.
 */
function useCountUp(value: number | null, ratePerSecond: number | null): number | null {
  const [shown, setShown] = useState<number | null>(null);
  const shownRef = useRef<number | null>(null);
  shownRef.current = shown;
  const rateRef = useRef(ratePerSecond);
  rateRef.current = ratePerSecond;
  useEffect(() => {
    if (value === null) return;
    const from = shownRef.current;
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // A lower value (a backlog that shrank, a correction) is set at once, never counted down.
    if (reduce || (from !== null && value <= from)) {
      setShown(value);
      return;
    }
    const rate = rateRef.current ?? 0;
    const lag = from === null && rate > 0 ? Math.min(value, Math.round(rate * LAG_S)) : 0;
    const mid = value - lag;
    const began = performance.now();
    const length = from === null ? COUNT_FIRST_MS + (lag ? LAG_S * 1_000 : 0) : COUNT_STEP_MS;
    let frame = 0;
    let ticked = false;
    const tick = (now: number) => {
      ticked = true;
      const t = now - began;
      let next: number;
      if (from !== null) next = from + (value - from) * Math.min(1, t / COUNT_STEP_MS);
      else if (t < COUNT_FIRST_MS) next = mid * (1 - Math.pow(1 - t / COUNT_FIRST_MS, 4));
      else next = mid + lag * Math.min(1, (t - COUNT_FIRST_MS) / (LAG_S * 1_000));
      setShown(Math.round(next));
      if (t < length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // Where animation frames never run (a background or embedded view), show the value directly.
    const guard = window.setTimeout(() => {
      if (!ticked) setShown(value);
    }, 1_500);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(guard);
    };
  }, [value]);
  return shown;
}

/** One counter: its number counts, and its bars' running hour grows with the same number. */
/** How long the first count waits for a counter's growth rate (its 24 h figure or history). */
const RATE_WAIT_MS = 2_000;
function StatCard({ stat, series }: { stat: Stat; series: HistorySeries | undefined }) {
  const rate = stat.rate ?? growthRate(series);
  // The first count starts once the rate is known (or after RATE_WAIT_MS), so the number can be
  // shown moving from the start instead of standing still until the next answer.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setWaited(true), RATE_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const shown = useCountUp(rate !== null || waited ? stat.value : null, rate);
  return (
    <div className="xp-card xp-stat" data-stat={stat.key}>
      <div className="xp-stat-label">{stat.label}</div>
      <div className="xp-stat-value">{shown === null ? '–' : number.format(shown)}</div>
      <div className="xp-stat-sub">{stat.sub}</div>
      <div className="xp-stat-foot">
        <span>{stat.source}</span>
        <a href={PROOF_ROUTES[stat.key]}>Verify</a>
      </div>
    </div>
  );
}

/**
 * A contract address shown short, copied whole: the full address is the button's title and what
 * the clipboard gets; where the clipboard is refused, the full address is selected instead.
 */
function CopyAddress({ address, iconOnly = false }: { address: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  const fallback = useRef<HTMLSpanElement>(null);
  const copy = () => {
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    };
    const select = () => {
      const node = fallback.current;
      if (!node) return;
      node.hidden = false;
      const range = document.createRange();
      range.selectNodeContents(node);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    };
    try {
      void navigator.clipboard.writeText(address).then(done, select);
    } catch {
      select();
    }
  };
  return (
    <span className="xp-copy">
      {iconOnly ? null : <b className="xp-mono">{shortHex(address)}</b>}
      <button
        type="button"
        className="xp-copy-btn"
        onClick={copy}
        title={address}
        aria-label={`Copy ${address}`}
      >
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        {iconOnly ? null : <span>{copied ? 'Copied' : 'Copy'}</span>}
      </button>
      <span ref={fallback} className="xp-mono xp-copy-full" hidden>
        {address}
      </span>
    </span>
  );
}

/** A running total's growth per second between its first and last recorded hourly readings. */
function growthRate(series: HistorySeries | undefined): number | null {
  const read = series?.points.filter((p) => p.value !== null) ?? [];
  if (read.length < 2) return null;
  const first = read[0];
  const last = read[read.length - 1];
  const seconds = (last.hour - first.hour) / 1_000;
  return seconds > 0 && last.value! >= first.value! ? (last.value! - first.value!) / seconds : null;
}
