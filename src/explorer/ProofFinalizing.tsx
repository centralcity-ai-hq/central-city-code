import { useCallback, useEffect, useRef, useState } from 'react';
import { number } from '../verify/countLogClient';
import {
  finalizingMinutes,
  loadOnBase,
  passportPath,
  shownName,
  type OnBaseList,
  type OnBaseRow,
} from '../verify/onBaseData';
import { CodeBox, NumberCard, Panel, Pill, ProofCard, ProofLayout } from './proofParts';
import { loadFinalizing, loadHeads, type FinalizingPage } from './x3Client';

/*
 * Proof page for "Finalizing" (approved design, 24 Oct 2026). A registration is on Base once it is
 * in a block and final once Base finalizes that block. Typical wait: 15 to 30 minutes.
 *
 * Heads: Central City's own Base read (/api/public/base/heads, #621) when it is deployed; while it
 * answers 404 this browser reads Base's latest, safe and finalized heads from a public Base node,
 * as before. Waiting registrations: /api/public/base/finalizing (#621), every waiting registration
 * page by page; while it answers 404, the waiting rows among the newest On Base list rows. Only a
 * 404 falls back: a 503 or a stale answer is said as such, never replaced by another source.
 */

const BASE_RPC = 'https://mainnet.base.org';
const TYPICAL_MIN = 25;
const REFRESH_MS = 20_000;
const HEADS_TIMEOUT_MS = 8_000;
/** At most this many waiting-list pages (50 candidates each) are followed with "Show older". */
export const FINALIZING_PAGES_MAX = 20;
type Heads = {
  latest: bigint;
  safe: bigint;
  finalized: bigint;
  at: number;
  /** node: Central City's Base read (a node observation); browser: read here from mainnet.base.org. */
  source: 'node' | 'browser';
  stale: boolean;
};
/** false, or why the last read failed: Base did not answer, answered out of order, or Central
 * City's read is deployed but did not answer. */
type HeadsFailure = false | 'silent' | 'disorder' | 'unavailable';
/** The waiting list as /api/public/base/finalizing answers it, with any older pages shown. */
type Waiting = {
  first: FinalizingPage;
  older: OnBaseRow[];
  /** The cursor for the next older page; null at the end. */
  next: string | null;
  pages: number;
  /** The first page's answer was stale (it is read again every refresh). */
  stale: boolean;
  /** Any older page shown was stale; kept until the older pages are dropped. */
  olderStale: boolean;
};

/** Base's three heads, or an error: block numbers in order finalized <= safe <= latest. */
async function readHeads(signal: AbortSignal): Promise<Heads> {
  const tags = ['latest', 'safe', 'finalized'] as const;
  const response = await fetch(BASE_RPC, {
    signal,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      tags.map((tag, id) => ({
        jsonrpc: '2.0',
        id,
        method: 'eth_getBlockByNumber',
        params: [tag, false],
      })),
    ),
  });
  if (!response.ok) throw new Error(`Base ${response.status}`);
  const answers = (await response.json()) as Array<{ id: number; result?: { number?: string } }>;
  const block = (id: number) => {
    const hex = Array.isArray(answers) ? answers.find((a) => a.id === id)?.result?.number : null;
    if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(hex)) throw new Error('no block');
    return BigInt(hex);
  };
  const heads: Heads = {
    latest: block(0),
    safe: block(1),
    finalized: block(2),
    at: Date.now(),
    source: 'browser',
    stale: false,
  };
  if (!(heads.finalized <= heads.safe && heads.safe <= heads.latest)) throw new HeadsOutOfOrder();
  return heads;
}

/** Central City's heads; null while the endpoint is not deployed (404), so the caller reads Base. */
async function readNodeHeads(signal: AbortSignal): Promise<Heads | 'unavailable' | null> {
  const answer = await loadHeads(signal);
  if (answer.state === 'absent') return null;
  if (answer.state === 'unavailable') return 'unavailable';
  const { latest, safe, finalized, asOf } = answer.value;
  return { latest, safe, finalized, at: asOf, source: 'node', stale: answer.stale };
}

/** The rows of the first page and the older pages, each Base ID once, waiting ones only. */
function waitingRows(waiting: Waiting): OnBaseRow[] {
  const seen = new Set<string>();
  return [...waiting.first.rows, ...waiting.older].filter((row) => {
    if (row.status !== 'finalizing' || seen.has(row.baseId)) return false;
    seen.add(row.baseId);
    return true;
  });
}

/** Base answered, but its heads are not finalized <= safe <= latest: a failed check, not silence. */
class HeadsOutOfOrder extends Error {}

export function ProofFinalizing() {
  const [list, setList] = useState<OnBaseList | null>(null);
  const [heads, setHeads] = useState<Heads | null>(null);
  const [headsFailed, setHeadsFailed] = useState<HeadsFailure>(false);
  const [listFailed, setListFailed] = useState(false);
  // null until the first answer; 'absent' while /finalizing is not deployed (the list rows stand in).
  const [waiting, setWaiting] = useState<Waiting | 'absent' | null>(null);
  const [waitingFailed, setWaitingFailed] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const live = useRef(true);
  // While older pages are open the list is a snapshot: the first page is not polled underneath
  // older rows that may have finalized since (they would read as still waiting). "Back to live"
  // drops the older pages and reads the first page again at once.
  const snapshot = useRef(false);
  const readWaitingNow = useRef<() => void>(() => {});
  // The pagination generation: a new first page, "Back to live" or leaving the page starts a new
  // one. Only an older-page answer of the current generation may append rows, open the snapshot,
  // or change the loading/failed state; an answer from an earlier generation is dropped whole.
  const pageGen = useRef(0);
  const newPagination = useCallback(() => {
    pageGen.current += 1;
    setLoadingOlder(false);
    setOlderFailed(false);
  }, []);

  // One read of each kind at a time, each with a deadline, so a hung node never piles up reads.
  useEffect(() => {
    live.current = true;
    let first = true;
    const controllers = new Set<AbortController>();
    const inFlight = { heads: false, list: false, waiting: false };
    const withDeadline = <T,>(work: (signal: AbortSignal) => Promise<T>) => {
      const controller = new AbortController();
      controllers.add(controller);
      const deadline = window.setTimeout(() => controller.abort(), HEADS_TIMEOUT_MS);
      return work(controller.signal).finally(() => {
        window.clearTimeout(deadline);
        controllers.delete(controller);
      });
    };
    const readWaiting = () => {
      if (inFlight.waiting) return;
      inFlight.waiting = true;
      loadFinalizing()
        .then((answer) => {
          if (!live.current || snapshot.current) return;
          if (answer.state === 'absent') {
            newPagination();
            return setWaiting('absent');
          }
          if (answer.state === 'unavailable') {
            setWaitingFailed(true);
            // Deployed but failing (after a 404 cooldown ran out, say): no longer "not deployed",
            // so the list rows stop standing in and the page says "not available". A node answer
            // already shown stays, marked not refreshed.
            return setWaiting((prev) => (prev === 'absent' ? null : prev));
          }
          setWaitingFailed(false);
          // A new first page: any older-page request still in flight belongs to the old one.
          newPagination();
          setWaiting({
            first: answer.value,
            older: [],
            next: answer.value.nextBefore,
            pages: 1,
            stale: answer.stale,
            olderStale: false,
          });
        })
        .finally(() => {
          inFlight.waiting = false;
        });
    };
    readWaitingNow.current = readWaiting;
    const read = () => {
      setNow(Date.now());
      if (!first && document.visibilityState === 'hidden') return;
      first = false;
      if (!inFlight.heads) {
        inFlight.heads = true;
        // Central City's read first; only a 404 (not deployed) falls back to reading Base here.
        withDeadline(async (signal) => (await readNodeHeads(signal)) ?? readHeads(signal))
          .then((h) => {
            if (!live.current) return;
            if (h === 'unavailable') return setHeadsFailed('unavailable');
            setHeads(h);
            setHeadsFailed(false);
          })
          .catch(
            (error: unknown) =>
              live.current &&
              setHeadsFailed(error instanceof HeadsOutOfOrder ? 'disorder' : 'silent'),
          )
          .finally(() => {
            inFlight.heads = false;
          });
      }
      if (!snapshot.current) readWaiting();
      if (!inFlight.list) {
        inFlight.list = true;
        loadOnBase({ timeoutMs: 15_000 })
          .then((page) => {
            if (!live.current) return;
            setList(page);
            setListFailed(false);
          })
          .catch(() => live.current && setListFailed(true))
          .finally(() => {
            inFlight.list = false;
          });
      }
    };
    read();
    const timer = window.setInterval(read, REFRESH_MS);
    return () => {
      live.current = false;
      pageGen.current += 1;
      window.clearInterval(timer);
      for (const c of controllers) c.abort();
    };
  }, [newPagination]);

  // "Show older": the next page after the last one shown, at most FINALIZING_PAGES_MAX pages.
  const showOlder = useCallback(() => {
    if (loadingOlder || !waiting || waiting === 'absent' || waiting.next === null) return;
    if (waiting.pages >= FINALIZING_PAGES_MAX) return;
    const cursor = waiting.next;
    const gen = pageGen.current;
    const current = () => live.current && gen === pageGen.current;
    setLoadingOlder(true);
    setOlderFailed(false);
    void loadFinalizing(cursor)
      .then((answer) => {
        // Superseded (new first page, Back to live, left the page): nothing of it is used.
        if (!current()) return;
        // A failed older page keeps every row already shown; the button offers it again.
        if (answer.state !== 'ok') return setOlderFailed(true);
        // Accepted: the same generation means the first page, and so this cursor, is unchanged.
        snapshot.current = true;
        setWaiting((prev) =>
          prev && prev !== 'absent' && prev.next === cursor
            ? {
                ...prev,
                older: [...prev.older, ...answer.value.rows],
                next: answer.value.nextBefore,
                pages: prev.pages + 1,
                olderStale: prev.olderStale || answer.stale,
              }
            : prev,
        );
      })
      .finally(() => current() && setLoadingOlder(false));
  }, [loadingOlder, waiting]);

  // Leave the snapshot: drop the older pages and read the first page again now.
  const backToLive = useCallback(() => {
    snapshot.current = false;
    newPagination();
    setWaiting((prev) =>
      prev && prev !== 'absent'
        ? { ...prev, older: [], next: prev.first.nextBefore, pages: 1, olderStale: false }
        : prev,
    );
    readWaitingNow.current();
  }, [newPagination]);

  const fromNode = waiting !== null && waiting !== 'absent';
  // Which rows the table shows: the waiting list, the list rows (only while /finalizing is not
  // deployed), or none yet (loading, or a 503 before any answer: never the list in its place).
  const mode = fromNode
    ? 'node'
    : waiting === 'absent'
      ? 'list'
      : waitingFailed
        ? 'unavailable'
        : 'loading';
  const rows =
    mode === 'node'
      ? waitingRows(waiting as Waiting)
      : mode === 'list'
        ? (list?.rows ?? []).filter((r) => r.status === 'finalizing')
        : [];
  const total = list?.totals.finalizingNow;
  const ago = (at: number) => `${Math.max(0, Math.round((now - at) / 1000))} s ago`;
  const status =
    headsFailed === 'disorder' ? (
      <Pill tone="bad">Base answered heads out of order</Pill>
    ) : headsFailed === 'unavailable' ? (
      <Pill tone="muted">
        {heads
          ? `Central City's Base read did not answer, last read ${ago(heads.at)}`
          : "Central City's Base read is not available right now"}
      </Pill>
    ) : headsFailed ? (
      <Pill tone="muted">
        {heads ? `Base did not answer, last read ${ago(heads.at)}` : 'Base did not answer'}
      </Pill>
    ) : heads?.source === 'node' ? (
      <Pill tone={heads.stale ? 'muted' : 'ok'}>
        {heads.stale ? "Central City's Base read, not refreshed" : "Central City's Base read"}
      </Pill>
    ) : heads ? (
      <Pill tone="ok">Read from Base</Pill>
    ) : (
      <Pill tone="muted">Reading Base…</Pill>
    );
  const notRefreshed = fromNode ? waitingFailed || waiting.stale || waiting.olderStale : listFailed;
  const utc = (at: number) => `${new Date(at).toISOString().slice(11, 19)} UTC`;
  const note = fromNode
    ? `${number.format(rows.length)} waiting shown, newest first${
        waiting.pages > 1
          ? `; a snapshot as of ${utc(waiting.first.asOf)}, not refreshed while older pages are open`
          : waiting.next !== null
            ? '; older ones below'
            : ''
      }${typeof total === 'number' ? `; last reported total waiting ${number.format(total)}` : ''}${
        notRefreshed ? '; not refreshed, showing the last answer' : ''
      }`
    : mode === 'list' && list
      ? `the newest ${list.rows.length} registrations only${
          typeof total === 'number' ? `; last reported total waiting ${number.format(total)}` : ''
        }${listFailed ? '; not refreshed, showing the last answer' : ''}`
      : undefined;
  const empty = fromNode
    ? waiting.next !== null
      ? 'None of these is public and waiting. Older waiting registrations may follow.'
      : total === 0
        ? 'Nothing is waiting: the last reported total is 0.'
        : 'Nothing public is waiting right now.'
    : mode === 'unavailable'
      ? 'The waiting list is not available right now. Retrying every 20 s.'
      : mode === 'loading'
        ? 'Loading…'
        : list === null
          ? listFailed
            ? 'The list did not load. Retrying every 20 s.'
            : 'Loading…'
          : total === 0
            ? 'Nothing is waiting: the last reported total is 0.'
            : typeof total === 'number'
              ? `None of the newest registrations is waiting. Last reported total waiting: ${number.format(total)}.`
              : 'None of the newest registrations is waiting. The total waiting is not known right now.';

  return (
    <ProofLayout
      crumb="Finalizing"
      title="Finalizing"
      lede="A registration is on Base as soon as it is in a block, and final once Base finalizes that block, typically 15 to 30 minutes later (an estimate, not a guarantee). Base does not reorganize a finalized block."
    >
      <div className="xp-two">
        <NumberCard
          label="Registrations waiting to be final"
          value={typeof total === 'number' ? number.format(total) : null}
          facts={[
            ['Typical wait (estimate)', '15 to 30 min'],
            ['Blocks not yet final', heads ? number.format(heads.latest - heads.finalized) : null],
          ]}
        />
        <ProofCard
          title="Base block heads"
          status={status}
          rows={[
            ['Final', heads ? number.format(heads.finalized) : '–'],
            ['Safe', heads ? number.format(heads.safe) : '–'],
            ['Latest', heads ? number.format(heads.latest) : '–'],
            [
              'Source',
              heads?.source === 'node'
                ? "Central City's Base node (node observations)"
                : 'eth_getBlockByNumber at mainnet.base.org',
            ],
            ['Read', heads ? ago(heads.at) : '–'],
          ]}
        />
      </div>

      <Panel title="Waiting to be final" note={note}>
        <div className="xp-table-wrap">
          <table className="xp-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Base ID</th>
                <th>Waiting</th>
                <th>Elapsed of a typical 25 min wait</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const mins = finalizingMinutes(row.finalizingSince, now);
                const pct = Math.min(100, Math.round(((mins ?? 0) / TYPICAL_MIN) * 100));
                return (
                  <tr key={row.baseId}>
                    <td>
                      <a className="xp-agent-name" href={passportPath(row.short)}>
                        {shownName(row.name)}
                      </a>
                    </td>
                    <td className="xp-mono">{row.baseId}</td>
                    <td>{mins === null || mins === undefined ? '–' : `${mins} min`}</td>
                    <td>
                      <div className="xp-bar" aria-label={`${pct}% of a typical wait, an estimate`}>
                        <div style={{ width: `${pct}%` }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!rows.length ? (
                <tr>
                  <td colSpan={4} className="xp-empty">
                    {empty}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {fromNode && (waiting.next !== null || waiting.pages > 1) ? (
          <div className="xp-panel-foot">
            {waiting.pages > 1 ? (
              <button type="button" className="xp-btn xp-btn-ghost" onClick={backToLive}>
                Back to live
              </button>
            ) : null}
            {waiting.next === null ? null : waiting.pages < FINALIZING_PAGES_MAX ? (
              <>
                {olderFailed && !loadingOlder ? (
                  <span role="status">Older waiting registrations did not load.</span>
                ) : null}
                <button
                  type="button"
                  className="xp-btn xp-btn-ghost"
                  onClick={showOlder}
                  disabled={loadingOlder}
                >
                  {loadingOlder
                    ? 'Loading…'
                    : olderFailed
                      ? 'Try again'
                      : 'Show older waiting registrations'}
                </button>
              </>
            ) : (
              <span>
                Showing the newest {number.format(FINALIZING_PAGES_MAX * 50)} candidates; more
                waiting registrations may remain and are not shown here.
              </span>
            )}
          </div>
        ) : null}
      </Panel>

      <CodeBox
        title="Check without this website"
        text={`curl -s https://mainnet.base.org -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["finalized",false]}'`}
      >
        <p>A registration whose block is at or below the finalized block is final.</p>
      </CodeBox>
    </ProofLayout>
  );
}
