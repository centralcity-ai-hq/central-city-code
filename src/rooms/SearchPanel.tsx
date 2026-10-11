import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { withRoomDeadline, type Member, type RoomsClient, type SearchResult } from './api';
import { describe } from './useRoomThread';
import { PanelHead } from './PanelV3';

/*
 * Search inside a room (city_room_search): words, an optional sender and a date range, newest
 * first. Only the history the viewer may read is searched (the server applies the same rule as
 * reading). Snippets are untrusted text from other people's AIs: rendered as plain text, the
 * highlights are offsets into it (never HTML from the server).
 */

/** Typing pauses this long before searching; Enter searches at once. */
const DEBOUNCE_MS = 350;
/** The server's query cap (ROOM_LIMITS.searchQueryMax). */
const QUERY_MAX = 200;

type Filters = { q: string; sender: string; from: string; to: string };
type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; results: SearchResult[]; next?: string; more: boolean };

/** A local date (YYYY-MM-DD from a date input) as the ISO time of its local midnight. */
function startOfDay(value: string, plusDays = 0): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + plusDays);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** The snippet with its matched words in <mark>, as text nodes only. */
function Snippet({ text, highlights }: { text: string; highlights: Array<[number, number]> }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of highlights) {
    if (start < at || end > text.length) continue;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <span className="rm-search-snippet">{parts}</span>;
}

export function SearchPanel({
  client,
  roomId,
  roomName,
  members,
  onJump,
  onClose,
}: {
  client: RoomsClient;
  roomId: string;
  /** The room's name, in the field's placeholder ("Search The ROOM"). */
  roomName: string;
  members: Member[];
  /** Show this message in the thread. */
  onJump: (result: SearchResult) => void;
  onClose: () => void;
}) {
  const [filters, setFilters] = useState<Filters>({ q: '', sender: '', from: '', to: '' });
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [loadingMore, setLoadingMore] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const ids = useId();
  const statusId = `${ids}-status`;

  useEffect(() => {
    input.current?.focus();
  }, []);

  const query = (value: Filters, cursor?: string) => ({
    room_id: roomId,
    q: value.q.trim(),
    ...(value.sender ? { sender: value.sender } : {}),
    ...(startOfDay(value.from) ? { from: startOfDay(value.from) } : {}),
    // The "to" date includes that whole day.
    ...(startOfDay(value.to, 1) ? { to: startOfDay(value.to, 1) } : {}),
    ...(cursor ? { cursor } : {}),
  });

  async function run(value: Filters) {
    const mine = ++request.current;
    if (!value.q.trim()) {
      setState({ kind: 'idle' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const page = await withRoomDeadline(client.search(query(value)));
      if (mine !== request.current) return;
      setState({
        kind: 'done',
        results: page.results,
        ...(page.next_cursor ? { next: page.next_cursor } : {}),
        more: Boolean(page.next_cursor),
      });
    } catch (err) {
      if (mine === request.current) setState({ kind: 'error', message: describe(err) });
    }
  }

  // Search as the person types (debounced) and whenever a filter changes.
  useEffect(() => {
    const timer = window.setTimeout(() => void run(filters), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [filters.q, filters.sender, filters.from, filters.to]); // eslint-disable-line react-hooks/exhaustive-deps

  async function more() {
    if (state.kind !== 'done' || !state.next) return;
    const mine = request.current;
    setLoadingMore(true);
    try {
      const page = await withRoomDeadline(client.search(query(filters, state.next)));
      if (mine !== request.current) return;
      setState({
        kind: 'done',
        results: [...state.results, ...page.results],
        ...(page.next_cursor ? { next: page.next_cursor } : {}),
        more: Boolean(page.next_cursor),
      });
    } catch (err) {
      if (mine === request.current) setState({ kind: 'error', message: describe(err) });
    } finally {
      setLoadingMore(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(filters);
  }

  const set = (key: keyof Filters) => (value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const filtered = Boolean(filters.sender || filters.from || filters.to);
  const senders = members.filter((member) => member.name);

  return (
    <aside
      className="rm-panel rm-search-panel rm-v3-panel"
      aria-label="Search this room"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <PanelHead closeLabel="Close search" onClose={onClose}>
        <h2>Search messages</h2>
      </PanelHead>
      <div className="rm-v3-body">
        <form className="rm-search-form" role="search" onSubmit={submit}>
          <label className="rm-search-box">
            <Search size={16} aria-hidden="true" />
            <span className="rm-visually-hidden">Search messages</span>
            <input
              ref={input}
              className="rm-input"
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              maxLength={QUERY_MAX}
              placeholder={`Search ${roomName}`}
              value={filters.q}
              aria-describedby={statusId}
              onChange={(event) => set('q')(event.target.value)}
            />
          </label>
          <details className="rm-search-filters" open={filtered || undefined}>
            <summary>Filters{filtered ? ' (on)' : ''}</summary>
            <label className="rm-field">
              <span>From</span>
              <select
                className="rm-input"
                value={filters.sender}
                onChange={(event) => set('sender')(event.target.value)}
              >
                <option value="">Anyone</option>
                {senders.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                    {member.own ? ' (you)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="rm-search-dates">
              <label className="rm-field">
                <span>After</span>
                <input
                  className="rm-input"
                  type="date"
                  value={filters.from}
                  max={filters.to || undefined}
                  onChange={(event) => set('from')(event.target.value)}
                />
              </label>
              <label className="rm-field">
                <span>Before</span>
                <input
                  className="rm-input"
                  type="date"
                  value={filters.to}
                  min={filters.from || undefined}
                  onChange={(event) => set('to')(event.target.value)}
                />
              </label>
            </div>
            {filtered ? (
              <button
                type="button"
                className="rm-quiet"
                onClick={() =>
                  setFilters((current) => ({ ...current, sender: '', from: '', to: '' }))
                }
              >
                Clear filters
              </button>
            ) : null}
          </details>
        </form>
        {/* One live region for every state; while nothing is typed it is the empty state. */}
        <div
          id={statusId}
          className={
            state.kind === 'idle' ? 'rm-v3-empty rm-search-status' : 'rm-meta rm-search-status'
          }
          role="status"
          aria-live="polite"
        >
          {state.kind === 'idle' ? (
            <>
              <strong>Type to search</strong>
              <span>Find words in this room. Use "quotes" for a phrase.</span>
            </>
          ) : state.kind === 'loading' ? (
            'Searching…'
          ) : state.kind === 'done' ? (
            state.results.length ? (
              `${state.results.length}${state.more ? '+' : ''} result${state.results.length === 1 && !state.more ? '' : 's'}, newest first.`
            ) : (
              ''
            )
          ) : (
            ''
          )}
        </div>
        {state.kind === 'error' ? (
          <div className="rm-inline-error" role="alert">
            <span>{state.message}</span>
            <button type="button" className="rm-quiet" onClick={() => void run(filters)}>
              Retry
            </button>
          </div>
        ) : null}
        {state.kind === 'done' && !state.results.length ? (
          <div className="rm-search-empty" data-testid="room-search-empty">
            <strong>No messages found</strong>
            <span>
              {filtered
                ? 'Try other words, or clear the filters.'
                : 'Try other or fewer words. Search finds whole words.'}
            </span>
          </div>
        ) : null}
        {state.kind === 'done' && state.results.length ? (
          <ol className="rm-search-results" aria-label="Search results">
            {state.results.map((result) => (
              <li key={result.id}>
                <button
                  type="button"
                  className="rm-search-result"
                  data-testid="room-search-result"
                  onClick={() => onJump(result)}
                >
                  <span className="rm-search-byline">
                    <strong>
                      {result.sender}
                      {result.own ? ' (you)' : ''}
                    </strong>
                    <time dateTime={result.created_at}>
                      {timeFormat.format(new Date(result.created_at))}
                    </time>
                  </span>
                  <Snippet text={result.snippet} highlights={result.highlights} />
                </button>
              </li>
            ))}
          </ol>
        ) : null}
        {state.kind === 'done' && state.more ? (
          <button
            type="button"
            className="rm-quiet rm-search-more"
            disabled={loadingMore}
            onClick={() => void more()}
          >
            {loadingMore ? 'Loading…' : 'Show older results'}
          </button>
        ) : null}
      </div>
    </aside>
  );
}
