import { useCallback, useEffect, useRef, useState, type Ref } from 'react';
import { ChevronDown, Inbox, ListChecks, MessageSquare, ShieldCheck } from 'lucide-react';
import type { Member } from './api';
import { Avatar } from './Avatar';
import {
  dismissNeedsYou,
  getNeedsYou,
  getRoomOverview,
  type NeedsYouItem,
  type RoomOverview,
} from './api';
import { SwitchToast } from '../ui/Switch';
import {
  compactCount,
  isActiveNow,
  needsYouBadge,
  needsYouLabel,
  needsYouText,
  parseNeedsYou,
  parseOverview,
  roomPillLabel,
} from './headerCountsV2';

/*
 * Workspace v3 room top bar (docs/design/WORKSPACE_V3.md §4.1): the room pill (name, member
 * avatars, the live line), the Needs-you chip and the data behind them (overview counters, the
 * Needs-you queue). Real data only: every number comes from the server. Styles: rooms-v3.css
 * (the Needs-you list keeps rooms-v2-header.css).
 */

const OVERVIEW_POLL_MS = 30_000;
/** What the room pill's active count covers (its tooltip). */
export const ACTIVE_HINT = 'AIs connected to this room now';
const NEEDS_YOU_POLL_MS = 60_000;
/** One server page; the header reads two (100 items), enough to show 1-99 exactly, then 99+. */
const NEEDS_YOU_LIMIT = 50;
const NEEDS_YOU_PAGES = 2;
export const NEEDS_YOU_DISMISS_FAILED = 'Could not dismiss. Try again.';

/**
 * Phones (under 640 px): the top bar is two rows, the pill with ⋯ and then one strip of chips
 * that scrolls sideways (rooms-v3.css uses the same width).
 */
export const COMPACT_BAR_QUERY = '(max-width: 639px)';

/** Whether a media query matches, following changes. */
export function useMediaQuery(query: string): boolean {
  const list = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query)
      : null;
  const [matches, setMatches] = useState(() => list()?.matches ?? false);
  useEffect(() => {
    const media = list();
    if (!media) return;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  return matches;
}

/** Repeats `load` every `ms` while the page is visible, until it answers false (stop). */
function usePoll(load: () => Promise<boolean>, ms: number, enabled: boolean, key: unknown) {
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer = 0;
    const tick = async () => {
      let again = true;
      if (document.visibilityState !== 'hidden') again = await load().catch(() => true);
      if (live && again) timer = window.setTimeout(tick, ms);
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [load, ms, enabled, key]);
}

/**
 * The room's cached counters (GET /api/rooms/:room/overview). Null until loaded and whenever the
 * server has no overview (404 or a different shape): the header then uses the member list.
 * `refreshKey` changing reloads at once (a join, a leave, a mute).
 */
export function useRoomOverview(
  roomId: string,
  enabled: boolean,
  refreshKey: unknown,
): RoomOverview | null {
  const [overview, setOverview] = useState<RoomOverview | null>(null);
  useEffect(() => setOverview(null), [roomId]);
  const load = useCallback(async () => {
    const value = await getRoomOverview(roomId);
    if (value === 'unavailable') {
      setOverview(null);
      return false;
    }
    // A later failure keeps the last good counts (they carry as_of).
    const parsed = parseOverview(value);
    setOverview(parsed);
    return parsed !== null;
  }, [roomId]);
  usePoll(load, OVERVIEW_POLL_MS, enabled, refreshKey);
  return overview;
}

export type NeedsYouState = { items: NeedsYouItem[]; more: boolean };
export type NeedsYouQueue = {
  /** Null when not loaded, not asked for, or not on this server. */
  state: NeedsYouState | null;
  /** Dismiss these items (optimistic; restored with a toast when the server refuses). */
  dismiss: (ids: string[]) => void;
  /** Dismiss every current item. */
  dismissAll: () => void;
  toast: string;
  clearToast: () => void;
};
const itemKey = (item: NeedsYouItem) => `${item.kind}:${item.id}`;

/**
 * The caller's Needs-you queue (up to two pages), with dismissals. A dismissal hides its items at
 * once. They stay hidden while it is in flight and until a load that started after it succeeded
 * (an earlier poll may still carry them); a failure puts them back where they were, with a toast.
 */
export function useNeedsYou(roomId: string, enabled: boolean, refreshKey: unknown): NeedsYouQueue {
  const [state, setState] = useState<NeedsYouState | null>(null);
  const [toast, setToast] = useState('');
  // Hidden item ids: null while the dismissal is in flight, else the load number it settled at.
  const hidden = useRef(new Map<string, number | null>());
  const loads = useRef(0);
  const latest = useRef<NeedsYouState | null>(null);
  latest.current = state;
  useEffect(() => {
    setState(null);
    hidden.current = new Map();
  }, [roomId, enabled]);
  const load = useCallback(async () => {
    const started = ++loads.current;
    const items: NeedsYouItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < NEEDS_YOU_PAGES; page++) {
      const value = await getNeedsYou(roomId, {
        limit: NEEDS_YOU_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      const parsed = value === 'unavailable' ? null : parseNeedsYou(value);
      if (!parsed) {
        setState(null);
        return false;
      }
      items.push(...parsed.items);
      const next = (value as { next_cursor?: unknown }).next_cursor;
      cursor = typeof next === 'string' ? next : undefined;
      if (!cursor) break;
    }
    // Dismissals that settled before this load began are reflected by the server now.
    for (const [id, settled] of hidden.current)
      if (settled !== null && settled < started) hidden.current.delete(id);
    const seen = new Set<string>();
    setState({
      items: items.filter(
        (item) =>
          !hidden.current.has(item.id) && !seen.has(itemKey(item)) && !!seen.add(itemKey(item)),
      ),
      more: Boolean(cursor),
    });
    return true;
  }, [roomId]);
  usePoll(load, NEEDS_YOU_POLL_MS, enabled, refreshKey);

  const run = useCallback(
    (ids: string[], input: { ids: string[] } | { all: true }) => {
      const before = latest.current;
      if (!ids.length || !before) return;
      const gone = new Set(ids);
      for (const id of ids) hidden.current.set(id, null);
      setState({ ...before, items: before.items.filter((item) => !gone.has(item.id)) });
      setToast('');
      dismissNeedsYou(roomId, input).then(
        () => {
          for (const id of ids) hidden.current.set(id, loads.current);
        },
        () => {
          for (const id of ids) hidden.current.delete(id);
          // Back where they were; items that arrived meanwhile stay too.
          setState((current) => {
            const now = new Set((current?.items ?? []).map(itemKey));
            const restored = before.items.filter(
              (item) => gone.has(item.id) || now.has(itemKey(item)),
            );
            const kept = new Set(restored.map(itemKey));
            const added = (current?.items ?? []).filter((item) => !kept.has(itemKey(item)));
            return { items: [...restored, ...added], more: current?.more ?? before.more };
          });
          setToast(NEEDS_YOU_DISMISS_FAILED);
        },
      );
    },
    [roomId],
  );
  const dismiss = useCallback(
    (ids: string[]) => {
      // The server takes up to 100 ids per call: as many as the header ever shows.
      const some = ids.slice(0, NEEDS_YOU_LIMIT * NEEDS_YOU_PAGES);
      run(some, { ids: some });
    },
    [run],
  );
  const dismissAll = useCallback(
    () =>
      run(
        (latest.current?.items ?? []).map((item) => item.id),
        { all: true },
      ),
    [run],
  );
  const clearToast = useCallback(() => setToast(''), []);
  return { state, dismiss, dismissAll, toast, clearToast };
}

const ago = (at: string, now = Date.now()) => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / (24 * 60))} d ago`;
};

/**
 * The host's "Needs you (n)" chip, only when something waits. It opens a short list: opening an
 * entry (a task opens the Tasks panel, a mention jumps to the message) also dismisses it; tick
 * boxes and "Dismiss" dismiss the chosen ones, "Dismiss all" every current one. All text is
 * plain (titles and excerpts are other members' words).
 */
export function NeedsYouChip({
  queue,
  onOpenTask,
  onOpenMessage,
}: {
  queue: NeedsYouQueue;
  onOpenTask: (taskId: string) => void;
  onOpenMessage: (seq: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { state, toast, clearToast } = queue;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keys);
    };
  }, [open]);
  const items = state?.items ?? [];
  // Ticks only for items still listed (a poll or a dismissal may have removed some).
  const chosen = items.filter((item) => picked.has(item.id)).map((item) => item.id);
  const count = items.length;
  const toastView = <SwitchToast text={toast} onDismiss={clearToast} />;
  if (!count) return toastView;
  const more = state?.more ?? false;
  const label = needsYouLabel(count, more);
  const badge = needsYouBadge(count, more);
  const choose = (item: NeedsYouItem) => {
    setOpen(false);
    queue.dismiss([item.id]);
    if (item.task) onOpenTask(item.task.id);
    else if (typeof item.message_seq === 'number') onOpenMessage(item.message_seq);
  };
  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const dismissChosen = () => {
    queue.dismiss(chosen);
    setPicked(new Set());
  };
  const dismissAll = () => {
    queue.dismissAll();
    setPicked(new Set());
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div className="rv2-needs" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="rm3-chip rv2-needs-chip"
        aria-label={label}
        aria-expanded={open}
        aria-controls="rv2-needs-list"
        data-testid="needs-you-chip"
        onClick={() => setOpen((value) => !value)}
      >
        {/* Phones show the inbox icon and the count; wider screens "Needs you" and the count. */}
        <Inbox className="rv2-chip-icon" size={16} aria-hidden="true" />
        <span className="rv2-chip-full" aria-hidden="true">
          Needs you
        </span>
        <span className="rm3-n rv2-chip-short" aria-hidden="true">
          {badge}
        </span>
      </button>
      {open ? (
        <div className="rv2-needs-pop" id="rv2-needs-list" role="region" aria-label="Needs you">
          <div className="rv2-needs-bar">
            <p className="rv2-needs-head">Needs you</p>
            <button type="button" className="rv2-needs-action" onClick={dismissAll}>
              Dismiss all
            </button>
          </div>
          <ul className="rv2-needs-list">
            {items.map((item) => {
              const linked = Boolean(item.task) || typeof item.message_seq === 'number';
              const text = needsYouText(item);
              const Icon = item.task
                ? ListChecks
                : item.kind === 'approval'
                  ? ShieldCheck
                  : MessageSquare;
              const body = (
                <>
                  <Icon size={16} aria-hidden="true" />
                  <span className="rv2-needs-text">{text}</span>
                  <span className="rv2-needs-since">{ago(item.since)}</span>
                </>
              );
              return (
                <li key={`${item.kind}:${item.id}`} className="rv2-needs-row">
                  <input
                    type="checkbox"
                    className="rv2-needs-tick"
                    aria-label={`Select: ${text}`}
                    checked={picked.has(item.id)}
                    onChange={() => toggle(item.id)}
                  />
                  {linked ? (
                    <button type="button" className="rv2-needs-item" onClick={() => choose(item)}>
                      {body}
                    </button>
                  ) : (
                    <div className="rv2-needs-item">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
          {more ? <p className="rv2-needs-more">Showing the first {count}.</p> : null}
          {chosen.length ? (
            <div className="rv2-needs-foot">
              <button
                type="button"
                className="rv2-needs-action rv2-needs-dismiss"
                onClick={dismissChosen}
              >
                Dismiss ({chosen.length})
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {toastView}
    </div>
  );
}

/** How many member avatars the room pill shows before "+N" (phones: PILL_AVATARS_COMPACT). */
export const PILL_AVATARS = 6;
export const PILL_AVATARS_COMPACT = 3;

/**
 * The room pill (§4.1): "# Room name", up to six overlapping member avatars (three on phones; AIs active now
 * first, then the host, then the rest in list order) and "+N" for the others, and the live line
 * ("1 AI active", the #580 active-now rule: the same count as the Members panel's Active now).
 * The heading stays the page's h1; one button covers the pill and is the top bar's only way to
 * open and close the Members panel ("Members of <room>: 12 members, 3 AIs active").
 */
export function RoomPill({
  name,
  members,
  memberCount,
  aisActive,
  summary = null,
  avatars = PILL_AVATARS,
  open,
  onOpen,
  buttonRef,
}: {
  name: string;
  members: readonly Member[];
  /** The room's member total (the list may still be loading). */
  memberCount: number;
  /** AIs active now; null while unknown (the live line is hidden then). */
  aisActive: number | null;
  /**
   * The full counts line ("10.5k members · 6 AIs active now (20 in room)", headerCountsV2
   * metaLine) for the pill's tooltip and description; null while unknown.
   */
  summary?: string | null;
  /** How many avatars to show before "+N" (fewer on phones, where ⋯ shares the row). */
  avatars?: number;
  /** The Members panel is open. */
  open: boolean;
  onOpen: () => void;
  /** The pill's button (focus comes back to it when the Members panel closes). */
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const now = Date.now();
  const rank = (member: Member) => (isActiveNow(member, now) ? 0 : member.role === 'host' ? 1 : 2);
  const shown = [...members]
    .map((member, index) => ({ member, index }))
    .sort((a, b) => rank(a.member) - rank(b.member) || a.index - b.index)
    .slice(0, avatars)
    .map(({ member }) => member);
  const total = Math.max(memberCount, members.length);
  const rest = total - shown.length;
  const live =
    aisActive === null
      ? null
      : `${compactCount(aisActive)} ${aisActive === 1 ? 'AI' : 'AIs'} active`;
  const label = roomPillLabel(name, total, aisActive);
  // The tooltip (also the button's description): the whole counts line and what "active" means.
  const hint = `${summary ?? label}. ${ACTIVE_HINT}`;
  return (
    <div className="rm3-pill" data-open={open || undefined}>
      <h1 className="rm3-pill-name" title={name}>
        <span className="rm3-hash" aria-hidden="true">
          #
        </span>
        <span className="rm3-pill-text">{name}</span>
      </h1>
      {shown.length ? (
        <span className="rm3-stack" aria-hidden="true">
          {shown.map((member) => (
            <Avatar
              key={member.id}
              id={member.id}
              name={member.name}
              kind={
                member.auto_reply?.provider === 'elric'
                  ? 'elric'
                  : member.kind === 'person'
                    ? 'person'
                    : 'agent'
              }
              size="sm"
            />
          ))}
          {rest > 0 ? (
            <span className="rm3-av rm3-av-sm rm3-more">+{compactCount(rest)}</span>
          ) : null}
        </span>
      ) : null}
      {live ? (
        <span className="rm3-live" data-idle={aisActive === 0 || undefined} data-testid="room-live">
          <i aria-hidden="true" />
          <span className="rm3-live-text">{live}</span>
        </span>
      ) : null}
      <ChevronDown className="rm3-pill-caret" size={16} aria-hidden="true" />
      <button
        ref={buttonRef}
        type="button"
        className="rm3-pill-hit"
        aria-label={label}
        aria-expanded={open}
        title={hint}
        data-testid="room-pill"
        onClick={onOpen}
      />
    </div>
  );
}
