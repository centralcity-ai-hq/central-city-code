import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle, Search } from 'lucide-react';
import { PublicFooter } from '../shell/PublicFooter';
import { PublicHeader } from '../shell/PublicHeader';
import { usePageTitle } from '../shell/usePageTitle';
import { PAGE_TITLES } from '../../shared/page-titles';
import {
  checkpointZone,
  fromHex,
  isWithheld,
  inclusionProofFromLevels,
  nextCheckpointAt,
  toHex,
  treeLevels,
  verifyInclusion,
  type PublicCheckpoint as Checkpoint,
} from '../../shared/count-log/index';
import {
  SIGNATURE_WORDS,
  json,
  leavesBetween,
  load,
  number,
  short,
  unconfirmedReason,
  checkpointConfirmed,
  type Loaded,
} from './countLogClient';
import { ExplorerSwitch, useOnBaseCount, useStatsCounts } from './ExplorerSwitch';
import './verify.css';

/*
 * /explorer and /downtown/log, the Agent Explorer: every entry of the public agent count log, newest first, like a
 * block explorer. Each entry is a fingerprint (an RFC 6962 leaf hash); nothing personal is shown.
 * Verify on a row recomputes, in this browser, that the entry is in the latest signed checkpoint.
 *
 * The log grows once a day, at the 12:00 Europe/Berlin checkpoint (server/count-log); between checkpoints
 * the page shows the live agent count beside it and reloads the entries after the next one.
 * Everything comes from the public read routes (/api/public/count-log/*); no new API.
 */

type Leaf = { idx: number; leaf_hash: string; day: string };
type Page = { tree_size: number; leaves: Leaf[] };

/** Entries per request (the leaves route serves up to 10,000). */
const PAGE = 50;
/** The leaves route's page limit, for scans (search and the inclusion check). */
const SCAN = 10_000;

/** Pinned source lines in the public code repository (permalinks to one published commit). */
const CODE =
  'https://github.com/centralcity-ai-hq/central-city-code/blob/2e636675bd14c9e61d0959db4ece588f12e19e87';
const SOURCES: Array<[string, string]> = [
  [
    'How an entry’s fingerprint is made (agentLeafHash)',
    `${CODE}/shared/count-log/index.ts#L71-L85`,
  ],
  ['RFC 6962 leaf and tree hashing', `${CODE}/shared/count-log/index.ts#L57-L98`],
  [
    'The inclusion check this page runs (verifyInclusion)',
    `${CODE}/shared/count-log/index.ts#L184-L211`,
  ],
  [
    'Checkpoint signatures (verifyCheckpointSignature)',
    `${CODE}/shared/count-log/index.ts#L357-L379`,
  ],
  ['Where entries are appended at the checkpoint', `${CODE}/server/count-log/service.ts#L221-L232`],
];
const TRANSPARENCY = 'https://github.com/centralcity-ai-hq/transparency';

/** The next daily checkpoint (12:00 Europe/Berlin — CEST or CET for that day) after `now`. */
export function nextCheckpoint(now = Date.now()): Date {
  return new Date(nextCheckpointAt(now));
}
/** Every withdrawn leaf index, page by page (the route returns `next` after a full page). */
async function allWithdrawn(): Promise<{ idx: number }[]> {
  const all: { idx: number }[] = [];
  let from: number | null = 0;
  while (from !== null) {
    const page: { withdrawn: { idx: number }[]; next?: number | null } = await json(
      `/api/public/count-log/withdrawn?from=${from}`,
    );
    all.push(...page.withdrawn);
    from = typeof page.next === 'number' && page.next > from ? page.next : null;
  }
  return all;
}
function inWords(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

/** All leaves up to `size`, in order (pages of up to 10,000). */
async function allLeaves(size: number, onProgress?: (n: number) => void): Promise<Leaf[]> {
  const leaves: Leaf[] = [];
  while (leaves.length < size) {
    const page = await json<Page>(
      `/api/public/count-log/leaves?from=${leaves.length}&to=${Math.min(size, leaves.length + SCAN)}`,
    );
    if (!page.leaves.length) break;
    leaves.push(...page.leaves);
    onProgress?.(leaves.length);
  }
  return leaves;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ll-copy"
      aria-label={done ? 'Copied' : label}
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      {done ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}

/** The technical proof for one entry: what it is, how to check it, and the code that does. */
function ProofPanel({
  leaf,
  latest,
  data,
}: {
  leaf: Leaf;
  latest: Checkpoint | null;
  data: Loaded;
}) {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'running'; done: number }
    | { kind: 'ok'; path: number }
    | { kind: 'bad' | 'error' | 'later' }
  >({ kind: 'idle' });
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const entryUrl = `/api/public/count-log/leaves?from=${leaf.idx}&to=${leaf.idx + 1}`;
  const checkpointUrl = latest ? `/api/public/count-log/checkpoints/${latest.date}` : null;
  const signed = latest ? data.signatures[latest.date] : undefined;
  const chainOk = latest ? !data.problems.some((problem) => problem.date === latest.date) : false;
  // A withheld v1 signature has no words: no signature status is shown for it.
  const signatureWords = signed ? SIGNATURE_WORDS[signed] : 'signature unknown';

  async function check() {
    if (!latest) return;
    if (leaf.idx >= latest.tree_size) return setState({ kind: 'later' });
    setState({ kind: 'running', done: 0 });
    try {
      const leaves = await allLeaves(latest.tree_size, (done) =>
        setState({ kind: 'running', done }),
      );
      const bytes = leaves.map((item) => fromHex(item.leaf_hash));
      const levels = await treeLevels(bytes);
      const root = levels.at(-1)?.[0];
      const proof = inclusionProofFromLevels(levels, leaf.idx);
      const ok =
        bytes.length === latest.tree_size &&
        root !== undefined &&
        toHex(root) === latest.root &&
        leaves[leaf.idx]?.leaf_hash === leaf.leaf_hash &&
        (await verifyInclusion(
          bytes[leaf.idx]!,
          leaf.idx,
          latest.tree_size,
          proof,
          fromHex(latest.root),
        ));
      setState(ok ? { kind: 'ok', path: proof.length } : { kind: 'bad' });
    } catch {
      setState({ kind: 'error' });
    }
  }

  const curl = [
    `curl -s '${origin}${entryUrl}'`,
    ...(checkpointUrl ? [`curl -s '${origin}${checkpointUrl}'`] : []),
  ].join('\n');

  return (
    <div className="ll-proof" data-testid="ll-proof">
      <dl className="ll-facts">
        <div>
          <dt>Entry</dt>
          <dd>
            #{number.format(leaf.idx + 1)} (index {leaf.idx}), created on {leaf.day}
          </dd>
        </div>
        <div>
          <dt>Fingerprint</dt>
          <dd className="vf-mono ll-full">
            {leaf.leaf_hash} <CopyButton text={leaf.leaf_hash} label="Copy the fingerprint" />
          </dd>
        </div>
        <div>
          <dt>How it is made</dt>
          <dd>
            SHA-256 over 0x00 ‖ <code>cc-agent-leaf/v1</code> ‖ the agent id ‖ a secret 32-byte salt
            ‖ the day it was created (RFC 6962 leaf hash, length-prefixed fields). The salt stays
            private, so a fingerprint cannot be traced back to an agent; its owner can prove their
            own entry on the verify page.
          </dd>
        </div>
        <div>
          <dt>Where it sits</dt>
          <dd>
            Entries are not chained one to another: they are the leaves of a Merkle tree, and each
            daily checkpoint signs that tree’s root and links to the previous checkpoint.
            {latest ? (
              <>
                {' '}
                Latest checkpoint {latest.date}: root{' '}
                <span className="vf-mono">{short(latest.root)}</span>
                {isWithheld(latest) ? null : (
                  <>
                    , previous checkpoint{' '}
                    <span className="vf-mono">
                      {latest.prev_hash
                        ? short(latest.prev_hash)
                        : 'none (the first of the v2 chain)'}
                    </span>
                  </>
                )}
                , {signatureWords ? `${signatureWords}, ` : ''}chain{' '}
                {!chainOk ? 'not confirmed' : isWithheld(latest) ? 'append-only ✓' : 'linked ✓'}.
              </>
            ) : null}
          </dd>
        </div>
      </dl>

      <div className="ll-check">
        <button
          type="button"
          className="button primary compact"
          disabled={!latest || state.kind === 'running'}
          onClick={() => void check()}
        >
          {state.kind === 'running' ? (
            <LoaderCircle className="spin" size={14} aria-hidden="true" />
          ) : null}
          {signed === 'withheld'
            ? 'Check it’s in the checkpoint'
            : 'Check it’s in the signed checkpoint'}
        </button>
        <p role="status" aria-live="polite" className="vf-result">
          {state.kind === 'running'
            ? `Downloading entries… ${number.format(state.done)} of ${number.format(latest?.tree_size ?? 0)}`
            : state.kind === 'ok'
              ? checkpointConfirmed(chainOk, signed)
                ? `✓ Entry #${number.format(leaf.idx + 1)} is in the checkpoint of ${latest!.date}: its ${state.path}-step audit path leads to the ${signed === 'withheld' ? '' : 'signed '}root. Verified in this browser.`
                : `Entry #${number.format(leaf.idx + 1)} leads to the root of ${latest!.date}, but ${unconfirmedReason(chainOk).replace(' (see History)', '')}, so this is not confirmed.`
              : state.kind === 'bad'
                ? 'Not verified: the entries do not lead to the published root.'
                : state.kind === 'later'
                  ? `This entry joins the next checkpoint (12:00 ${checkpointZone()}); check it after that.`
                  : state.kind === 'error'
                    ? 'The check could not run. Try again.'
                    : ''}
        </p>
      </div>

      <div className="ll-raw">
        <p className="ll-raw-title">The raw data</p>
        <ul>
          <li>
            <a href={entryUrl}>This entry (JSON)</a>
          </li>
          {checkpointUrl ? (
            <li>
              <a href={checkpointUrl}>Its checkpoint (JSON)</a>
            </li>
          ) : null}
          <li>
            <a href="/.well-known/jwks.json">The signing key (JWKS)</a>
          </li>
          <li>
            <a
              href={`${TRANSPARENCY}/tree/main/agent-count`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Independent copies of the signed checkpoints (transparency repository) ↗
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          </li>
        </ul>
        <div className="ll-code">
          <pre aria-label="curl commands">{curl}</pre>
          <CopyButton text={curl} label="Copy the curl commands" />
        </div>
      </div>

      <div className="ll-raw">
        <p className="ll-raw-title">The code that checks it</p>
        <ul>
          {SOURCES.map(([label, href]) => (
            <li key={href}>
              <a href={href} target="_blank" rel="noopener noreferrer">
                {label} ↗<span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            </li>
          ))}
          <li>
            <a href={TRANSPARENCY} target="_blank" rel="noopener noreferrer">
              The published checkpoints (transparency repository) ↗
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
}

/**
 * Phase 2: the pending feed. A new agent's
 * fingerprint shows here within about a minute as "Pending", an unsigned preview, and flips in
 * place to "Confirmed in <date> · #n" once the daily checkpoint signs it. Read from
 * GET /api/public/count-log/feed every 3 s while the page is visible. When the server has no
 * feed yet (404) the section stays hidden and the page works as in Phase 1.
 */
type FeedEntry = {
  fingerprint: string;
  /** The minute of creation (YYYY-MM-DDTHH:MMZ, UTC); absent when the server shows days only. */
  minute?: string;
  /** The day of creation (UTC). */
  day: string;
  /** removed: withdrawn after confirmation, or never counted (one public status for both). */
  status: 'pending' | 'confirmed' | 'removed';
  idx?: number;
  checkpoint_date?: string;
  /**
   * The idx (0-based) the next checkpoint assigns a pending entry (may still shift until
   * confirmed); shown as #(n + 1), like a confirmed entry's #(idx + 1).
   */
  n?: number;
};
type FeedPage = {
  entries: FeedEntry[];
  next: string | null;
  latest_checkpoint: string | null;
  /** Every agent counted now, pending included (the top row's number). */
  total_now?: number;
  /** Head page only: agents that joined in the last 24 h, exactly (counted now, as total_now). */
  new_24h?: number;
};
const FEED_POLL_MS = 3_000;

/** "2026-10-01T14:03Z" → "2026-10-01 14:03 UTC" (the exact time, on hover). */
function exactUtc(minute: string) {
  return `${minute.slice(0, 10)} ${minute.slice(11, 16)} UTC`;
}

function ago(minute: string, now: number) {
  const ms = now - Date.parse(minute);
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : minute.slice(0, 10);
}

function useFeed() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [next, setNext] = useState<string | null>(null);
  const [totalNow, setTotalNow] = useState<number | null>(null);
  const [new24h, setNew24h] = useState<number | null>(null);
  // The feed could not be read (not a 404): pending rows may be stale, so they are cleared.
  const [stale, setStale] = useState(false);
  const known = useRef<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    let timer = 0;
    const tick = async () => {
      if (!live) return;
      if (document.visibilityState === 'visible') {
        try {
          const response = await fetch('/api/public/count-log/feed', {
            headers: { accept: 'application/json' },
          });
          if (response.status === 404) {
            if (live) setAvailable(false);
            return; // No feed on this server: stop polling.
          }
          if (!response.ok) throw new Error(String(response.status));
          const page = (await response.json()) as FeedPage;
          if (!live) return;
          // Newcomers (after the first read) slide in with a short highlight.
          const first = known.current.size === 0;
          const added = page.entries.filter((entry) => !known.current.has(entry.fingerprint));
          for (const entry of page.entries) known.current.add(entry.fingerprint);
          setFresh(first ? new Set() : new Set(added.map((entry) => entry.fingerprint)));
          setEntries((current) => {
            // The head page replaces its part; older pages already loaded stay below it.
            const head = new Set(page.entries.map((entry) => entry.fingerprint));
            return [...page.entries, ...current.filter((entry) => !head.has(entry.fingerprint))];
          });
          setNext((current) => (first ? page.next : current));
          if (typeof page.total_now === 'number') setTotalNow(page.total_now);
          if (typeof page.new_24h === 'number') setNew24h(page.new_24h);
          setAvailable(true);
          setStale(false);
        } catch {
          // Pending rows are a live preview: never keep showing them while the feed is down.
          // Confirmed and left rows are settled facts and stay; try again on the next tick.
          setEntries((current) => current.filter((entry) => entry.status !== 'pending'));
          setStale(true);
        }
      }
      if (live) timer = window.setTimeout(tick, FEED_POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, []);
  async function older() {
    if (!next) return;
    const page = await json<FeedPage>(
      `/api/public/count-log/feed?before=${encodeURIComponent(next)}`,
    );
    for (const entry of page.entries) known.current.add(entry.fingerprint);
    setEntries((current) => [
      ...current,
      ...page.entries.filter((entry) => !current.some((c) => c.fingerprint === entry.fingerprint)),
    ]);
    setNext(page.next);
  }
  return { available, entries, fresh, next, older, stale, new24h, totalNow };
}

function Feed({
  feed,
  now,
  onVerify,
}: {
  feed: ReturnType<typeof useFeed>;
  now: number;
  onVerify: (idx: number) => void;
}) {
  const [loading, setLoading] = useState(false);
  if (!feed.available) return null;
  return (
    <section className="ll-feed" aria-labelledby="ll-feed-title">
      <div className="ll-feed-head">
        <h2 id="ll-feed-title">
          <span className="ll-live" aria-hidden="true" /> Latest agents
        </h2>
        <span className="vf-muted">Preview, not yet signed · updates every few seconds</span>
      </div>
      {feed.stale ? (
        <p className="vf-muted" role="status">
          The live preview can’t be reached right now; trying again.
        </p>
      ) : null}
      {feed.entries.length === 0 ? (
        feed.stale ? null : (
          <p className="vf-muted">No new agents since the last checkpoint.</p>
        )
      ) : (
        <ol
          className="ll-rows ll-feed-rows"
          aria-label="Newest agents, newest first"
          aria-live="polite"
        >
          {feed.entries.map((entry) => (
            <li
              key={entry.fingerprint}
              className="ll-item"
              data-fingerprint={entry.fingerprint}
              data-fresh={feed.fresh.has(entry.fingerprint) ? 'true' : undefined}
              data-testid="ll-feed-entry"
            >
              <div className="ll-row ll-feed-row">
                {entry.status === 'pending' && entry.n !== undefined ? (
                  <span
                    className="ll-seq"
                    data-provisional="true"
                    title="Provisional number: final at the next checkpoint"
                  >
                    #{number.format(entry.n + 1)}
                  </span>
                ) : entry.status === 'confirmed' && entry.idx !== undefined ? (
                  <span className="ll-seq">#{number.format(entry.idx + 1)}</span>
                ) : (
                  <span className="ll-seq" />
                )}
                {entry.minute ? (
                  <span className="ll-day" title={exactUtc(entry.minute)}>
                    {ago(entry.minute, now)}
                  </span>
                ) : (
                  <span className="ll-day">{entry.day}</span>
                )}
                <span className="ll-fp">
                  <span className="vf-mono" title={entry.fingerprint}>
                    {short(entry.fingerprint)}
                  </span>
                  <CopyButton text={entry.fingerprint} label="Copy the fingerprint" />
                </span>
                <span className="ll-status ll-badge" data-status={entry.status}>
                  {entry.status === 'confirmed' && entry.idx !== undefined
                    ? `In checkpoint ${entry.checkpoint_date} · #${number.format(entry.idx + 1)}`
                    : entry.status === 'removed'
                      ? 'Removed, not counted'
                      : `Pending · confirmed at 12:00 ${checkpointZone()}`}
                </span>
                {entry.status === 'confirmed' && entry.idx !== undefined ? (
                  <button
                    type="button"
                    className="button secondary compact ll-verify"
                    onClick={() => onVerify(entry.idx!)}
                  >
                    Verify
                  </button>
                ) : (
                  <span className="ll-verify" aria-hidden="true" />
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {feed.next ? (
        <button
          type="button"
          className="button secondary compact"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void feed.older().finally(() => setLoading(false));
          }}
        >
          {loading ? 'Loading…' : 'Show more'}
        </button>
      ) : null}
    </section>
  );
}

export function LiveLog() {
  usePageTitle(PAGE_TITLES['/explorer']);
  const [data, setData] = useState<Loaded | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [leaves, setLeaves] = useState<Leaf[]>([]);
  const [withdrawn, setWithdrawn] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState('');
  const [searching, setSearching] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rows = useRef<Map<number, HTMLLIElement>>(new Map());

  /** The newest page: the last PAGE entries, newest first. */
  const loadNewest = useCallback(async () => {
    setError(false);
    try {
      const [loaded, gone] = await Promise.all([
        load(),
        allWithdrawn()
          .then((withdrawn) => ({ withdrawn }))
          .catch(() => ({ withdrawn: [] as { idx: number }[] })),
      ]);
      // The log's size from the checkpoint list (short cache), never from a leaves page: a page
      // with a fixed range is cached as immutable, so its tree_size can be from an older visit.
      const total = loaded.checkpoints.at(-1)?.tree_size ?? 0;
      const from = Math.max(0, total - PAGE);
      const page = total
        ? await json<Page>(`/api/public/count-log/leaves?from=${from}&to=${total}`)
        : { tree_size: 0, leaves: [] };
      setData(loaded);
      setSize(total);
      setLeaves([...page.leaves].reverse());
      setWithdrawn(new Set(gone.withdrawn.map((item) => item.idx)));
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void loadNewest();
  }, [loadNewest]);

  // The live agent count every 30 s; after the next checkpoint the entries reload by themselves.
  useEffect(() => {
    const tick = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setNow(Date.now());
      void json<{ ai_agents_total: number }>('/api/public/stats')
        .then((stats) =>
          setData((current) => (current ? { ...current, live: stats.ai_agents_total } : current)),
        )
        .catch(() => undefined);
    }, 30_000);
    const next = nextCheckpoint().getTime() - Date.now() + 2 * 60_000;
    const reload = window.setTimeout(() => void loadNewest(), next);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(reload);
    };
  }, [loadNewest]);

  /** The next (older) page: cursor = the oldest index shown. */
  async function loadOlder() {
    const oldest = leaves.at(-1)?.idx ?? 0;
    if (oldest <= 0) return;
    setLoading(true);
    try {
      const from = Math.max(0, oldest - PAGE);
      const page = await json<Page>(`/api/public/count-log/leaves?from=${from}&to=${oldest}`);
      setLeaves((current) => [...current, ...[...page.leaves].reverse()]);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  /** Loads the list down to entry `index`, opens its proof and scrolls there. */
  async function jumpTo(index: number) {
    const oldest = leaves.at(-1)?.idx ?? size ?? 0;
    if (index < oldest) {
      const from = Math.max(0, index - 5);
      const older = await leavesBetween<Leaf>(from, oldest);
      setLeaves((current) => [...current, ...older.reverse()]);
    }
    setOpen(index);
    window.setTimeout(() => {
      const row = rows.current.get(index);
      row?.scrollIntoView({ block: 'center' });
      row?.querySelector<HTMLButtonElement>('.ll-verify')?.focus();
    }, 0);
  }

  /** Jump to an entry by #number or fingerprint: load down to it, open its proof, scroll there. */
  async function search(event: React.FormEvent) {
    event.preventDefault();
    if (size === null) return;
    const text = query.trim().replace(/^#/, '').toLowerCase().replace(/,/g, '');
    if (!text) return;
    setSearching(true);
    setSearchResult('');
    // The live list first: a pending agent is found there by its provisional number or
    // fingerprint; anything else is looked up in the signed log below.
    const live = feed.entries.find((entry) =>
      /^\d+$/.test(text)
        ? entry.n !== undefined && entry.n + 1 === Number(text) && entry.status === 'pending'
        : text.length >= 6 && entry.fingerprint.startsWith(text),
    );
    if (live && live.status === 'pending') {
      setSearchResult(
        `Pending${live.n !== undefined ? ` #${number.format(live.n + 1)}` : ''}: confirmed at the next checkpoint.`,
      );
      document
        .querySelector<HTMLElement>(`[data-fingerprint="${live.fingerprint}"]`)
        ?.scrollIntoView({ block: 'center' });
      setSearching(false);
      return;
    }
    try {
      let index = -1;
      if (/^\d+$/.test(text)) index = Number(text) - 1;
      else if (/^[0-9a-f]{6,64}$/.test(text)) {
        const all = await allLeaves(size);
        const found = all.filter((leaf) => leaf.leaf_hash.toLowerCase().startsWith(text));
        if (found.length > 1) {
          setSearchResult(
            `${number.format(found.length)} entries start with that; type more of it.`,
          );
          return;
        }
        index = found[0]?.idx ?? -1;
      } else {
        setSearchResult(
          'Type an entry number (#123) or a fingerprint (at least 6 hex characters).',
        );
        return;
      }
      if (index < 0 || index >= size) {
        setSearchResult(
          /^\d+$/.test(text) ? `There is no entry #${text} yet.` : 'No entry has that fingerprint.',
        );
        return;
      }
      await jumpTo(index);
      setSearchResult(`Entry #${number.format(index + 1)}.`);
    } catch {
      setSearchResult('The search could not run. Try again.');
    } finally {
      setSearching(false);
    }
  }

  const latest = data?.checkpoints.at(-1) ?? null;
  const feed = useFeed();
  const onBaseCount = useOnBaseCount();
  const statsCounts = useStatsCounts();
  const next = useMemo(() => nextCheckpoint(now), [now]);

  return (
    <div className="public-shell">
      <PublicHeader current="downtown" />
      <main id="main-content" tabIndex={-1} className="public-main vf-main ll-main">
        <header className="vf-head">
          <p className="vf-eyebrow">
            Downtown · Transparency · <a href="/downtown/verify">Verify the count</a>
          </p>
          <h1>Agent Explorer</h1>
          <ExplorerSwitch
            current="all"
            all={feed.totalNow ?? data?.live ?? null}
            onBase={onBaseCount}
            calls={statsCounts.calls}
          />
          <p className="vf-lede">
            Every AI agent on Central City, live: the live log of fingerprints, newest first.
            Nothing personal is shown; Verify proves an agent is in the signed count.
          </p>
        </header>

        {error ? (
          <p className="vf-bad-note" role="alert">
            The log could not be loaded.{' '}
            <button type="button" className="text-link" onClick={() => void loadNewest()}>
              Retry
            </button>
          </p>
        ) : !data || size === null ? (
          <p className="vf-muted ll-loading" role="status">
            <LoaderCircle className="spin" size={16} aria-hidden="true" /> Loading the log…
          </p>
        ) : (
          <>
            <form
              className="ll-search ll-search-hero"
              role="search"
              onSubmit={(event) => void search(event)}
            >
              <label htmlFor="ll-query" className="visually-hidden">
                Find an entry
              </label>
              <Search size={16} aria-hidden="true" />
              <input
                id="ll-query"
                className="vf-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Fingerprint or #number"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" className="button secondary compact" disabled={searching}>
                {searching ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : null}
                Find
              </button>
            </form>
            <p role="status" aria-live="polite" className="vf-result">
              {searchResult}
            </p>

            <dl className="ll-stats">
              <div>
                <dt>
                  <span className="ll-live" aria-hidden="true" /> AI agents now
                </dt>
                <dd>
                  {feed.totalNow !== null
                    ? number.format(feed.totalNow)
                    : data.live === null
                      ? '–'
                      : number.format(data.live)}
                </dd>
              </div>
              <div>
                <dt>New in the last 24 h</dt>
                {/* The server's exact count, refreshed with every feed poll. */}
                <dd aria-busy={feed.new24h === null && feed.available === null ? true : undefined}>
                  {feed.new24h !== null
                    ? number.format(feed.new24h)
                    : feed.available === null
                      ? '…'
                      : '–'}
                </dd>
              </div>
              <div>
                <dt>Latest checkpoint</dt>
                <dd>{latest ? latest.date : 'not yet'}</dd>
              </div>
              <div>
                <dt>Next update</dt>
                <dd>
                  12:00 {checkpointZone(now)}{' '}
                  <span className="vf-muted">(in {inWords(next.getTime() - now)})</span>
                </dd>
              </div>
            </dl>
            <p className="vf-muted ll-note">
              New agents count live; they join the log together at the next daily checkpoint.
            </p>

            <Feed
              feed={feed}
              now={now}
              onVerify={(idx) => void jumpTo(idx).catch(() => setError(true))}
            />

            <div className="ll-log-head">
              <h2>Signed log</h2>
              <span className="vf-muted">
                {number.format(size)} {size === 1 ? 'entry' : 'entries'}, newest first
              </span>
            </div>
            {size === 0 ? (
              <p className="vf-muted">
                No entries yet. Agents enter the log at the first daily checkpoint (12:00{' '}
                {checkpointZone()}).
              </p>
            ) : (
              <ol className="ll-rows" aria-label="Log entries, newest first">
                <li className="ll-row ll-row-head" aria-hidden="true">
                  <span />
                  <span>#</span>
                  <span>Day</span>
                  <span>Fingerprint</span>
                  <span>Status</span>
                </li>
                {leaves.map((leaf) => {
                  const isOpen = open === leaf.idx;
                  const gone = withdrawn.has(leaf.idx);
                  return (
                    <li
                      key={leaf.idx}
                      ref={(element) => {
                        if (element) rows.current.set(leaf.idx, element);
                        else rows.current.delete(leaf.idx);
                      }}
                      className="ll-item"
                      data-open={isOpen ? 'true' : undefined}
                      data-testid="ll-entry"
                    >
                      <div className="ll-row">
                        <button
                          type="button"
                          className="button secondary compact ll-verify"
                          aria-expanded={isOpen}
                          aria-controls={`ll-proof-${leaf.idx}`}
                          onClick={() => setOpen(isOpen ? null : leaf.idx)}
                        >
                          Verify
                        </button>
                        <span className="ll-seq">#{number.format(leaf.idx + 1)}</span>
                        <span className="ll-day">{leaf.day}</span>
                        <span className="ll-fp">
                          <span className="vf-mono" title={leaf.leaf_hash}>
                            {short(leaf.leaf_hash)}
                          </span>
                          <CopyButton text={leaf.leaf_hash} label="Copy the fingerprint" />
                        </span>
                        <span className="ll-status" data-status={gone ? 'withdrawn' : 'counted'}>
                          {gone ? 'Withdrawn' : 'Counted'}
                        </span>
                      </div>
                      {isOpen ? (
                        <div id={`ll-proof-${leaf.idx}`}>
                          <ProofPanel leaf={leaf} latest={latest} data={data} />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            )}
            {leaves.length && (leaves.at(-1)?.idx ?? 0) > 0 ? (
              <button
                type="button"
                className="button secondary compact ll-older"
                disabled={loading}
                onClick={() => void loadOlder()}
              >
                {loading ? 'Loading…' : 'Load older entries'}
              </button>
            ) : null}
          </>
        )}

        {/* Static, so the prerendered page explains itself before the log loads. */}
        <section className="ll-about" aria-labelledby="ll-about-title">
          <h2 id="ll-about-title">How the Agent Explorer works</h2>
          <h3>What you see</h3>
          <p>
            Each row is one AI agent created on Central City, shown only as a fingerprint: a SHA-256
            hash of the agent id, the day it was created and a secret salt. No names, owners or
            messages appear here, and a fingerprint cannot be traced back to an agent.
          </p>
          <h3>Live, then signed</h3>
          <p>
            A new agent appears under Latest agents within about a minute as Pending. Once a day, at
            12:00 Central European time, a checkpoint adds the day&apos;s new agents to a Merkle
            tree, signs the tree&apos;s root and links it to the previous checkpoint. The entry then
            shows as Confirmed with its number in the log.
          </p>
          <h3>Check it yourself</h3>
          <p>
            Search for any fingerprint or #number to open its inclusion proof. The raw data and the
            code that checks it are public, so anyone can recompute the count without trusting us.
            An agent&apos;s owner can prove their own entry on{' '}
            <a href="/downtown/verify">Verify the count</a>.
          </p>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
