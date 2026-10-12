import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { applyPageTitle } from '../shell/usePageTitle';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  LayoutGrid,
  LayoutList,
  LoaderCircle,
  LogIn,
  Menu,
  Moon,
  PanelLeft,
  Plus,
  Sparkles,
  Sun,
  X,
  LogOut,
  UserRound,
} from 'lucide-react';
import {
  getElricStatus,
  markRoomSeen,
  withRoomDeadline,
  type ReadPage,
  type Room,
  type RoomsClient,
} from './api';
import { JoinRoomSheet } from './JoinRoomSheet';
import { JoinScreen } from './JoinScreen';
import { roomSlugOf } from './pendingJoin';
import { RoomView } from './RoomView';
import { useRoomsV2 } from './roomsV2';
import { NewRoomSheet } from './NewRoomSheet';
import { describe } from './useRoomThread';
import { ApiError } from '../api';
import { navigate } from '../shell/navigation';
import { useTheme } from '../shell/theme';
import { SidebarRoomList } from '../shell/SidebarRoomList';
import {
  claimSidebarRooms,
  openSidebar,
  takeRoomsSheet,
  useSidebarRoomsSlot,
} from '../shell/sidebarRooms';
import {
  readRoomActivity,
  recordRoomActivity,
  roomActivityAt,
  sortRoomsByActivity,
} from '../shell/roomActivity';
import './rooms.css';
import './task-stages.css';
import { clearPendingDraft } from '../elric/pendingDraft';
import './sidebar.css';
import './rooms-v2.css';
import './rooms-v2-thread.css';
import './rooms-v2-tasks.css';
import './rooms-v2-members.css';
import './rooms-v2-pins.css';
import './rooms-v2-header.css';
// Workspace v3 room view (top bar, messages, composer).
import './rooms-v3.css';
// Workspace v3 panels and sheets: last, so they win over the v2 rules they restyle.
import './rooms-v3-panels.css';

const LIST_POLL_MS = 10_000;
/** Under this width the sidebar is an off-canvas drawer (matches sidebar.css). */
const PHONE_QUERY = '(max-width: 899px)';

/** Typing in a field, a select or an editable region: global shortcuts stay out of the way. */
function isEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

/**
 * The account card at the bottom of the sidebar. Signed in, it opens a small menu with the
 * Sign out (Workspace, at the top of the sidebar, leads to the main overview).
 */
function ProfileMenu({ name, signedIn }: { name: string; signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);
  if (!signedIn)
    return (
      <div className="rm-sidebar-profile-card">
        <span className="rm-profile-card-name profile-card-name">{name}</span>
      </div>
    );
  const signOut = async () => {
    setBusy(true);
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-City-Request': '1' },
        body: '{}',
      });
      // Cached conversations stay on this device otherwise.
      await import('../Messages').then((module) => module.forgetMessagesState()).catch(() => {});
      // A message typed for Elric before signing in must not reach the next person.
      clearPendingDraft();
    } finally {
      window.location.assign('/');
    }
  };
  return (
    <div className="rm-profile-menu" ref={root}>
      {open ? (
        <div className="rm-profile-menu-list" role="menu" aria-label="Account">
          <button
            type="button"
            role="menuitem"
            className="rm-profile-menu-item"
            disabled={busy}
            onClick={() => void signOut()}
          >
            <LogOut size={15} aria-hidden="true" />
            Sign out
          </button>
        </div>
      ) : null}
      <button
        ref={button}
        type="button"
        className="rm-sidebar-profile-card rm-profile-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={name}
        title={name}
        onClick={() => setOpen((value) => !value)}
      >
        {/* The collapsed rail shows only this icon; the card shows the name and a menu chevron. */}
        <UserRound className="rm-profile-rail-icon" size={18} aria-hidden="true" />
        <span className="rm-profile-card-name profile-card-name">{name}</span>
        <ChevronUp className="rm-profile-chevron" size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The name shown in the sidebar footer: the account name, never a placeholder person. */
function displayNameOf(accountName: string) {
  const name = accountName.trim();
  if (!name) return 'Account';
  return name.includes('@') ? name.slice(0, name.indexOf('@')) || 'Account' : name;
}
const ROOM_PATH = /^\/rooms\/([A-Za-z0-9_-]{1,64})\/?$/;

type View = { kind: 'rooms'; id: string | null } | { kind: 'join'; slug: string };
function viewOf(pathname: string): View {
  const slug = roomSlugOf(pathname);
  if (slug) return { kind: 'join', slug };
  return { kind: 'rooms', id: ROOM_PATH.exec(pathname)?.[1] ?? null };
}

/** Last-read seq per room: a per-device convenience. */
const readKey = (workspace: string) => `cc.rooms.read.${workspace}`;
function readMarks(workspace: string): Record<string, number> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(readKey(workspace)) ?? '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    // Only finite whole numbers ≥ 0 are marks; anything else is ignored (read from the start).
    return Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && entry[1] >= 0,
      ),
    );
  } catch {
    return {};
  }
}
function writeMarks(workspace: string, marks: Record<string, number>) {
  try {
    window.localStorage.setItem(readKey(workspace), JSON.stringify(marks));
  } catch {
    // Storage unavailable: unread counts reset on reload.
  }
}

/**
 * Unread counts (plan A, audits room-a-live FINDINGS "Unread count plan"). The read marks stay
 * per device; for a room with messages after its mark, a lookup read (an explicit `since`, which
 * never moves any cursor, and the console has none) fetches them, and only messages from others
 * count: never your own posts, never a system line ("The host closed the room.").
 * room_members.last_read_seq is the AI's cursor and is not used here.
 */
type UnreadLookup = {
  /** The room's latest_seq this lookup has covered. */
  latest: number;
  /** Seqs of fetched messages that count (not your own, not a system line). */
  counted: number[];
  /** More than one page was waiting: the count is a lower bound. */
  more: boolean;
  /** When the newest fetched message was written (latest activity), ms. */
  at: number | null;
};
const LOOKUP_PAGE = 100;
/** The server read mark (person cursor) is sent at most this often per room, newest seq last. */
const SEEN_SEND_MS = 3_000;
const LOOKUP_PARALLEL = 4;
/** Lookups started per rooms list (one poll); the rest wait for the next poll. */
const LOOKUP_PER_POLL = 10;
const LOOKUP_BACKOFF_MS = 5_000;
const LOOKUP_BACKOFF_MAX_MS = 60_000;
/** The 429 carries no Retry-After the client can read (ApiError has the status only). */
const LOOKUP_PAUSE_429_MS = 60_000;

function countsAsUnread(message: ReadPage['messages'][number]) {
  return !message.own && (message as { sender_kind?: string }).sender_kind !== 'system';
}

/** Badge text: the count, "99+" above 99, and "+" when only a lower bound is known. */
function unreadLabel(count: number, more: boolean) {
  if (count > 99) return '99+';
  return more ? `${count}+` : String(count);
}

function useUnreadLookups(
  client: RoomsClient,
  rooms: Room[] | null,
  marks: Record<string, number>,
) {
  const [lookups, setLookups] = useState<Record<string, UnreadLookup>>({});
  const known = useRef(lookups);
  known.current = lookups;
  const running = useRef(new Set<string>());
  // A failed lookup waits (per room and latest_seq, backoff 5 s → 60 s) and is retried only
  // when the effect runs again (the next rooms poll or read mark), never from its own failure.
  const failures = useRef(new Map<string, { latest: number; attempts: number; until: number }>());
  // A 429 pauses every lookup: the per-address limiter is shared with the rest of the app.
  const pausedUntil = useRef(0);
  // At most LOOKUP_PER_POLL lookups start per rooms list (one poll).
  const cycle = useRef<{ rooms: Room[] | null; started: number }>({ rooms: null, started: 0 });
  useEffect(() => {
    if (!rooms) return;
    const now = Date.now();
    if (now < pausedUntil.current) return;
    if (cycle.current.rooms !== rooms) cycle.current = { rooms, started: 0 };
    for (const room of rooms) {
      if (running.current.size >= LOOKUP_PARALLEL) break;
      if (cycle.current.started >= LOOKUP_PER_POLL) break;
      const mark = marks[room.id] ?? 0;
      const previous = known.current[room.id];
      if (room.latest_seq <= mark || running.current.has(room.id)) continue;
      if (previous && previous.latest >= room.latest_seq) continue;
      const failed = failures.current.get(room.id);
      if (failed && failed.latest >= room.latest_seq && now < failed.until) continue;
      // Continue after the last lookup when it reaches the mark; otherwise start at the mark.
      const since = previous && previous.latest >= mark ? previous.latest : mark;
      running.current.add(room.id);
      cycle.current.started++;
      void withRoomDeadline(client.read({ room_id: room.id, since, limit: LOOKUP_PAGE }))
        .then((page) => {
          failures.current.delete(room.id);
          setLookups((current) => {
            const before = current[room.id];
            const base = before && before.latest === since ? before : null;
            const last = page.messages.at(-1);
            return {
              ...current,
              [room.id]: {
                latest: Math.max(page.latest_seq, room.latest_seq),
                counted: [
                  ...(base?.counted ?? []),
                  ...page.messages.filter(countsAsUnread).map((message) => message.seq),
                ],
                more: Boolean(base?.more) || page.has_more,
                at: last ? Date.parse(last.created_at) : (base?.at ?? null),
              },
            };
          });
        })
        .catch((error: unknown) => {
          // The last known count stays. No state change here, so a failure never re-runs the
          // effect by itself.
          const attempts = (failures.current.get(room.id)?.attempts ?? 0) + 1;
          failures.current.set(room.id, {
            latest: room.latest_seq,
            attempts,
            until:
              Date.now() + Math.min(LOOKUP_BACKOFF_MS * 2 ** (attempts - 1), LOOKUP_BACKOFF_MAX_MS),
          });
          if (error instanceof ApiError && error.status === 429)
            pausedUntil.current = Date.now() + LOOKUP_PAUSE_429_MS;
        })
        .finally(() => running.current.delete(room.id));
    }
  }, [client, rooms, marks, lookups]);
  return lookups;
}

/**
 * The Rooms experience: a sidebar of your rooms and the open room as a chat, plus the join flow
 * on /r/<slug>. Mount it for /rooms, /rooms/:id and /r/:slug, after capturePendingJoin() has
 * run (see docs/ROOMS_UX.md).
 */
export function RoomsApp({
  client,
  signedIn,
  workspaceId,
  accountName,
  onSignIn,
  embedded = false,
  shellMenu: shellMenuProp = false,
}: {
  client: RoomsClient;
  /** The active workspace: read marks are kept per workspace. Remount RoomsApp when it changes. */
  workspaceId: string;
  signedIn: boolean;
  /** Prefills the new agent name on the join screen ("{name}'s agent"). */
  accountName: string;
  /** Start sign-in and come back to `next` (a room path; never carries the invite secret). */
  onSignIn: (next: string) => void;
  /**
   * Accepted for compatibility with the app shell and not rendered: the sidebar footer holds
   * only the theme toggle and the account name.
   */
  nav?: React.ReactNode;
  /**
   * Render inside an app shell that draws its own global navigation. Default false: with no
   * prop, RoomsApp draws its full chrome as before.
   *
   * Hidden when true (global chrome the shell owns):
   * - the Central City brand at the top of the sidebar;
   * - the links to non-room areas: Workspace and Elric;
   * - the sidebar footer: the theme toggle and the account menu (Sign out);
   * - the desktop collapse control and its Ctrl+\ (Cmd+\) shortcut (the shell owns sidebar layout;
   *   the rooms sidebar always shows expanded).
   *
   * Kept (room-specific): the Room list link, New room and Join a room, the rooms list
   * (Hosting, Joined and Closed sections), the open room with its header, actions, search,
   * panels and sheets, the join flow on /r/<slug>, and the phone drawer (the menu button that
   * opens the rooms list and its close button), unless `shellMenu` is set.
   *
   * The `.rm-app` root carries `data-embedded="true"` while embedded.
   */
  embedded?: boolean;
  /**
   * With `embedded`: the shell's own menu button is the only one on a phone (the workspace
   * preview shell, whose drawer lists Rooms and recent rooms). RoomsApp then draws no menu button,
   * so the rooms drawer is never opened, and the room list page shows New room and Join a room
   * itself. Default false: the phone keeps the rooms drawer and its menu button.
   */
  shellMenu?: boolean;
}) {
  const [view, setView] = useState<View>(() => viewOf(window.location.pathname));
  const shellMenu = embedded && shellMenuProp;
  // Smart Rooms v2 preview (src/rooms/roomsV2.ts): rooms.css scopes the v2 look to data-rooms.
  const roomsFlag = useRoomsV2() ? 'v2' : undefined;
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [listError, setListError] = useState('');
  const [drawer, setDrawer] = useState(false);
  // Elric's home in the sidebar: shown when Elric is on for this account. Hidden while it loads,
  // when Elric is off on this deployment (no status), and for an under-18 account.
  const [elricEntry, setElricEntry] = useState(false);
  useEffect(() => {
    // Embedded, the shell owns the Elric entry: no status read for a link that is not drawn.
    if (embedded) return;
    let active = true;
    void getElricStatus().then((status) => {
      if (active) setElricEntry(Boolean(status) && status?.eligibility_reason !== 'age_under_18');
    });
    return () => {
      active = false;
    };
  }, [embedded]);
  // New room or Join a room chosen in the workspace sidebar on another page (shellMenu only).
  const [askedSheet] = useState(() => (embedded && shellMenuProp ? takeRoomsSheet() : null));
  const [creating, setCreating] = useState(askedSheet === 'new');
  const [joining, setJoining] = useState(askedSheet === 'join');
  const [marks, setMarks] = useState(() => readMarks(workspaceId));
  // In the workspace shell the room list lives in the shell's sidebar (WORKSPACE_V3.md §3):
  // RoomsApp draws it there through a portal and has no list column of its own.
  const sidebarSlot = useSidebarRoomsSlot();
  useEffect(() => (shellMenu ? claimSidebarRooms() : undefined), [shellMenu]);
  const lookups = useUnreadLookups(client, rooms, marks);
  // Activity this session saw in the rooms list (latest_seq grew between two polls), in ms.
  const observed = useRef(new Map<string, number>());
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  const drafts = useRef(new Map<string, string>());
  const [, setDraftVersion] = useState(0);

  // Collapsible icon rail on desktop (remembered per device).
  const [storedCollapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('cc.rooms.sidebar.collapsed') === '1';
    } catch {
      return false;
    }
  });
  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('cc.rooms.sidebar.collapsed', next ? '1' : '0');
      } catch {
        // Storage unavailable
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (embedded) return;
      if ((e.ctrlKey || e.metaKey) && e.key === '\\' && !isEditable(e.target)) {
        e.preventDefault();
        toggleCollapse();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleCollapse, embedded]);
  // Embedded, the rooms sidebar never collapses to a rail (its expand control is the brand).
  const collapsed = storedCollapsed && !embedded;

  const [closedExpanded, setClosedExpanded] = useState(false);
  const { isDark, toggleTheme } = useTheme();

  // Phone drawer: inert while closed, focus moves in on open and back to the opener on close,
  // Escape closes it and Tab stays inside while it is open.
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE_QUERY).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(PHONE_QUERY);
    if (!query) return;
    const change = () => setPhone(query.matches);
    change();
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  const sidebarRef = useRef<HTMLElement>(null);
  const closeDrawerRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const drawerWasOpen = useRef(false);
  const skipFocusReturn = useRef(false);
  // The menu button opens the drawer on a phone; on a wider screen the sidebar is always there,
  // so the same button collapses or expands the rail instead.
  const openDrawer = useCallback(() => {
    if (!phone) {
      toggleCollapse();
      return;
    }
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDrawer(true);
  }, [phone, toggleCollapse]);
  useEffect(() => {
    if (!phone) setDrawer(false);
  }, [phone]);
  useEffect(() => {
    if (drawer) {
      drawerWasOpen.current = true;
      closeDrawerRef.current?.focus();
      return;
    }
    if (!drawerWasOpen.current) return;
    drawerWasOpen.current = false;
    const back = opener.current;
    opener.current = null;
    if (skipFocusReturn.current) {
      skipFocusReturn.current = false;
      return;
    }
    // The opener can be gone (a room link swapped the view): use the menu button now shown.
    const target =
      back?.isConnected && back.getClientRects().length
        ? back
        : Array.from(document.querySelectorAll<HTMLElement>('.rm-menu')).find(
            (button) => button.getClientRects().length > 0,
          );
    target?.focus();
  }, [drawer]);
  useEffect(() => {
    if (!drawer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDrawer(false);
        return;
      }
      const sidebar = sidebarRef.current;
      if (event.key !== 'Tab' || !sidebar) return;
      const items = Array.from(
        sidebar.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((item) => item.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && sidebar.contains(active);
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawer]);
  // A sheet opened from the drawer takes focus itself; the drawer closes underneath it.
  const openSheet = useCallback(
    (show: (value: boolean) => void) => {
      if (drawer) {
        skipFocusReturn.current = true;
        setDrawer(false);
      }
      show(true);
    },
    [drawer],
  );

  const go = useCallback((path: string, replace = false) => {
    if (replace) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
    setView(viewOf(path));
    setDrawer(false);
  }, []);
  useEffect(() => {
    const pop = () => setView(viewOf(window.location.pathname));
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  const listRetry = useRef({ timer: 0, failures: 0 });
  // Reads overlap (the 10 s poll, a refresh after a change); an older answer that lands after a
  // newer one is stale (a room setting would flip back), so it is dropped.
  const listOrder = useRef({ started: 0, applied: 0 });
  const loadRooms = useCallback(async () => {
    window.clearTimeout(listRetry.current.timer);
    const order = ++listOrder.current.started;
    try {
      const list = await withRoomDeadline(client.listRooms());
      if (order < listOrder.current.applied) return;
      listOrder.current.applied = order;
      const before = new Map((roomsRef.current ?? []).map((room) => [room.id, room.latest_seq]));
      const now = Date.now();
      for (const room of list) {
        const seq = before.get(room.id);
        if (seq !== undefined && room.latest_seq > seq) observed.current.set(room.id, now);
      }
      setRooms(list);
      setListError('');
      listRetry.current.failures = 0;
    } catch (err) {
      setListError(describe(err));
      // A failed read (429, 503, network) retries with backoff, not only on the 10 s poll.
      const delay = Math.min(1000 * 2 ** listRetry.current.failures++, 8000);
      listRetry.current.timer = window.setTimeout(() => void loadRooms(), delay);
    }
  }, [client]);
  useEffect(() => () => window.clearTimeout(listRetry.current.timer), []);
  useEffect(() => {
    if (!signedIn) return;
    void loadRooms();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadRooms();
    }, LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [signedIn, loadRooms]);

  // Open rooms before closed ones, then the latest activity (the newest message a lookup saw, or
  // new messages a poll saw, else the room's creation). Read marks play no part, so opening a
  // room never reorders the list. The times are recorded per device (shell/roomActivity.ts), so
  // the sidebar on every other page, and after a reload, shows the same order.
  const activityKey = Object.entries(lookups)
    .map(([id, lookup]) => `${id}:${lookup.at ?? ''}`)
    .join(',');
  const [storedActivity, setStoredActivity] = useState(() => readRoomActivity(workspaceId));
  useEffect(() => setStoredActivity(readRoomActivity(workspaceId)), [workspaceId]);
  useEffect(() => {
    const seen: Record<string, number> = {};
    for (const [id, lookup] of Object.entries(lookups)) if (lookup.at) seen[id] = lookup.at;
    for (const [id, at] of observed.current) seen[id] = Math.max(seen[id] ?? 0, at);
    setStoredActivity((current) => recordRoomActivity(workspaceId, seen, current));
    // `lookups` enters through activityKey; `observed` changes with `rooms`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, rooms, activityKey]);
  const ordered = useMemo(
    () =>
      sortRoomsByActivity(rooms ?? [], (room) =>
        roomActivityAt(
          room,
          lookups[room.id]?.at,
          observed.current.get(room.id),
          storedActivity[room.id],
        ),
      ),
    // `lookups` enters through activityKey: only a changed activity time reorders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rooms, activityKey, storedActivity],
  );

  const hostingRooms = useMemo(
    () => ordered.filter((room) => room.role === 'host' && !room.closed),
    [ordered],
  );
  const joinedRooms = useMemo(
    () => ordered.filter((room) => room.role !== 'host' && !room.closed),
    [ordered],
  );
  const closedRooms = useMemo(() => ordered.filter((room) => room.closed), [ordered]);

  // The person's server-side read cursor (POST /api/rooms/:room/read): @mentions they saw stop
  // waiting in Needs you. Throttled per room; the newest seq wins; best effort.
  const seenSent = useRef(new Map<string, { sent: number; want: number; timer: number }>());
  useEffect(() => {
    const pending = seenSent.current;
    return () => pending.forEach((entry) => window.clearTimeout(entry.timer));
  }, []);
  const sendSeen = useCallback((roomId: string, seq: number) => {
    const entry = seenSent.current.get(roomId) ?? { sent: 0, want: 0, timer: 0 };
    if (seq <= entry.want) return;
    entry.want = seq;
    seenSent.current.set(roomId, entry);
    if (entry.timer) return;
    entry.timer = window.setTimeout(
      () => {
        entry.timer = 0;
        if (entry.want <= entry.sent) return;
        entry.sent = entry.want;
        void markRoomSeen(roomId, entry.want).catch(() => {});
      },
      entry.sent ? SEEN_SEND_MS : 0,
    );
  }, []);

  const onRead = useCallback(
    (roomId: string, seq: number) => {
      sendSeen(roomId, seq);
      setMarks((current) => {
        if ((current[roomId] ?? 0) >= seq) return current;
        const next = { ...current, [roomId]: seq };
        writeMarks(workspaceId, next);
        return next;
      });
    },
    [workspaceId, sendSeen],
  );

  // The tab is named after the page: the open room's name, or Rooms on the list.
  const titleRoom =
    view.kind === 'rooms' && view.id
      ? (rooms?.find((room) => room.id === view.id || room.slug === view.id)?.name ?? '')
      : '';
  useEffect(() => {
    if (view.kind === 'join') return;
    return applyPageTitle(document, `${titleRoom || 'Rooms'} · Central City`);
  }, [view.kind, titleRoom]);

  if (view.kind === 'join')
    return (
      <div
        className="rm-app rm-app-join"
        data-rooms={roomsFlag}
        data-embedded={embedded ? 'true' : undefined}
      >
        <JoinScreen
          client={client}
          slug={view.slug}
          signedIn={signedIn}
          accountName={accountName}
          onSignIn={onSignIn}
          onJoined={(room) => {
            void loadRooms();
            go(`/rooms/${room.id}`, true);
          }}
          onRooms={() => go('/rooms', true)}
        />
      </div>
    );
  if (!signedIn)
    return (
      <div
        className="rm-app rm-app-join"
        data-rooms={roomsFlag}
        data-embedded={embedded ? 'true' : undefined}
      >
        <main className="rm-join">
          <h1>Your rooms</h1>
          <button type="button" className="rm-primary" onClick={() => onSignIn('/rooms')}>
            Sign in
          </button>
        </main>
      </div>
    );

  // A room in the address opens at once, without waiting for the rooms list: the thread's own
  // first read supplies its name and state (first paint does not depend on two requests).
  const listed = rooms?.find((room) => room.id === view.id || room.slug === view.id) ?? null;
  const open: Room | null =
    listed ??
    (view.kind === 'rooms' && view.id && rooms === null
      ? {
          id: view.id,
          slug: view.id,
          name: '',
          topic: '',
          role: 'member',
          closed: false,
          readOnly: false,
          history: 'full',
          member_count: 0,
          latest_seq: 0,
          created_at: '',
        }
      : null);

  /** Messages from others after this device's read mark (0 until a lookup has counted them). */
  const unreadOf = (room: Room) => {
    const mark = marks[room.id] ?? 0;
    const lookup = lookups[room.id];
    if (room.latest_seq <= mark || !lookup) return { count: 0, more: false };
    const count = lookup.counted.filter((seq) => seq > mark).length;
    return { count, more: lookup.more && lookup.latest >= mark };
  };
  const openRoom = (event: React.MouseEvent, room: Room) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
    event.preventDefault();
    go(`/rooms/${room.id}`);
  };

  const isClosedOpen = closedExpanded || Boolean(open?.closed);

  // New room and Join a room for a phone's room list page, where the sidebar that holds them is a
  // drawer: shown when the list is empty, and always with shellMenu (the drawer has no opener).
  const roomActions = (
    <div className="rm-overview-empty-actions">
      <button type="button" className="rm-primary" onClick={() => openSheet(setCreating)}>
        <Plus size={15} aria-hidden="true" />
        New room
      </button>
      <button type="button" className="rm-quiet" onClick={() => openSheet(setJoining)}>
        <LogIn size={15} aria-hidden="true" />
        Join a room
      </button>
    </div>
  );

  const renderRoomItem = (room: Room) => {
    const { count: unread, more } = unreadOf(room);
    const current = room.id === open?.id;
    return (
      <li key={room.id}>
        <a
          href={`/rooms/${room.id}`}
          aria-current={current ? 'page' : undefined}
          className={`rm-sidebar-room-item rm-room-item${current ? ' active' : ''}${room.closed ? ' closed-item' : ''}${unread && !current ? ' unread' : ''}`}
          title={`${room.name}${room.closed ? ' (Closed)' : ''}`}
          onClick={(event) => openRoom(event, room)}
        >
          <span className={`rm-room-item-dot${room.closed ? ' closed' : ''}`} />
          <span className="rm-room-item-name rm-room-name">{room.name}</span>
          {room.closed ? <span className="rm-meta rm-closed-tag">(closed)</span> : null}
          {unread && !current ? (
            <span
              className="rm-room-item-badge rm-badge"
              aria-label={`${unreadLabel(unread, more)} unread`}
            >
              {unreadLabel(unread, more)}
            </span>
          ) : null}
        </a>
      </li>
    );
  };

  return (
    <div
      className="rm-app"
      data-rooms={roomsFlag}
      data-embedded={embedded ? 'true' : undefined}
      data-sidebar={shellMenu ? 'shell' : undefined}
    >
      {shellMenu && sidebarSlot
        ? createPortal(
            <SidebarRoomList
              hosting={hostingRooms}
              joined={joinedRooms}
              ended={closedRooms}
              loading={rooms === null && !listError}
              error={Boolean(listError)}
              onRetry={() => void loadRooms()}
              currentId={open?.id ?? null}
              badge={(room) => {
                const { count, more } = unreadOf(room as Room);
                return count
                  ? { text: unreadLabel(count, more), label: `${unreadLabel(count, more)} unread` }
                  : null;
              }}
              onOpen={(room) => go(`/rooms/${room.id}`)}
              onNew={() => openSheet(setCreating)}
              onJoin={() => openSheet(setJoining)}
            />,
            sidebarSlot,
          )
        : null}
      {shellMenu ? null : (
        <nav
          ref={sidebarRef}
          className={`rm-sidebar${drawer ? ' open mobile-open' : ''}${collapsed ? ' collapsed' : ''}`}
          aria-label="Rooms"
          inert={phone && !drawer}
        >
          {/* Embedded, only the phone drawer's close button is left here: no header otherwise. */}
          {!embedded || phone ? (
            <div className="rm-sidebar-header">
              {!embedded ? (
                <>
                  <div
                    className="rm-sidebar-brand-wrap"
                    onClick={() => {
                      if (collapsed) toggleCollapse();
                    }}
                    title="Central City"
                    role={collapsed ? 'button' : undefined}
                    tabIndex={collapsed ? 0 : undefined}
                    aria-label={collapsed ? 'Expand sidebar' : undefined}
                    onKeyDown={(e) => {
                      if (collapsed && (e.key === 'Enter' || e.key === ' ')) toggleCollapse();
                    }}
                  >
                    <img
                      src="/brand/central-city-mark.png"
                      alt="Central City"
                      className="rm-sidebar-brand-mark"
                    />
                    <span className="rm-sidebar-brand-text">Central City</span>
                  </div>
                  <button
                    type="button"
                    className="rm-sidebar-collapse-btn"
                    onClick={toggleCollapse}
                    title="Collapse sidebar"
                    aria-label="Collapse sidebar"
                  >
                    <PanelLeft size={18} aria-hidden="true" />
                  </button>
                </>
              ) : null}
              <button
                ref={closeDrawerRef}
                type="button"
                className="rm-icon rm-close-drawer"
                aria-label="Close rooms"
                onClick={() => setDrawer(false)}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
          ) : null}

          {!embedded ? (
            <>
              <a
                href="/"
                className="rm-sidebar-nav-action"
                title="Workspace"
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
                  event.preventDefault();
                  setDrawer(false);
                  navigate('/');
                }}
              >
                <LayoutGrid size={18} aria-hidden="true" />
                <span>Workspace</span>
              </a>
              {elricEntry ? (
                <a
                  href="/elric"
                  className="rm-sidebar-nav-action rm-sidebar-elric"
                  title="Elric, your AI assistant"
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
                    event.preventDefault();
                    setDrawer(false);
                    navigate('/elric');
                  }}
                >
                  <Sparkles size={18} aria-hidden="true" />
                  <span>Elric</span>
                </a>
              ) : null}
            </>
          ) : null}
          <a
            href="/rooms"
            className={`rm-sidebar-nav-action${!open ? ' active' : ''}`}
            title="Room list"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
              event.preventDefault();
              go('/rooms');
            }}
          >
            <LayoutList size={18} aria-hidden="true" />
            <span>Room list</span>
          </a>

          <div className="rm-sidebar-actions-row">
            <button
              type="button"
              className="rm-sidebar-act-btn primary rm-new"
              onClick={() => openSheet(setCreating)}
              title="New room"
            >
              <Plus size={15} aria-hidden="true" />
              <span>New room</span>
            </button>
            <button
              type="button"
              className="rm-sidebar-act-btn rm-quiet rm-join-room"
              onClick={() => openSheet(setJoining)}
              title="Join a room"
              aria-label="Join a room"
            >
              <LogIn size={15} aria-hidden="true" />
              <span>Join a room</span>
            </button>
          </div>

          <div className="rm-sidebar-rooms-scroll">
            {rooms === null && !listError ? (
              <div className="rm-row-skeletons" role="status" aria-label="Loading rooms">
                {[0, 1, 2, 3, 4].map((index) => (
                  <span key={index} />
                ))}
              </div>
            ) : null}
            {listError ? (
              <div className="rm-inline-error" role="alert">
                <span>Rooms couldn't load.</span>
                <button type="button" className="rm-quiet" onClick={() => void loadRooms()}>
                  Retry
                </button>
              </div>
            ) : null}
            {rooms && !rooms.length ? <p className="rm-muted rm-no-rooms">No rooms yet</p> : null}

            {hostingRooms.length > 0 ? (
              <div className="rm-sidebar-room-group" id="groupHosting">
                <div className="rm-sidebar-group-header">
                  <span>Hosting ({hostingRooms.length})</span>
                </div>
                <ul className="rm-rooms">{hostingRooms.map(renderRoomItem)}</ul>
              </div>
            ) : null}

            {joinedRooms.length > 0 ? (
              <div className="rm-sidebar-room-group" id="groupJoined">
                <div className="rm-sidebar-group-header">
                  <span>Joined Rooms ({joinedRooms.length})</span>
                </div>
                <ul className="rm-rooms">{joinedRooms.map(renderRoomItem)}</ul>
              </div>
            ) : null}

            {closedRooms.length > 0 ? (
              <div className="rm-sidebar-room-group" id="groupClosed">
                <button
                  type="button"
                  className="rm-sidebar-group-header rm-closed-accordion-header"
                  onClick={() => setClosedExpanded((prev) => !prev)}
                  aria-expanded={isClosedOpen}
                  title="Toggle closed rooms"
                >
                  <span className="rm-group-header-title">
                    {isClosedOpen ? (
                      <ChevronDown size={12} aria-hidden="true" className="rm-chevron" />
                    ) : (
                      <ChevronRight size={12} aria-hidden="true" className="rm-chevron" />
                    )}
                    <span>Closed Rooms ({closedRooms.length})</span>
                  </span>
                </button>
                {isClosedOpen ? (
                  <ul className="rm-rooms rm-closed-rooms-list" id="closedRoomsList">
                    {closedRooms.map(renderRoomItem)}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>

          {!embedded ? (
            <div className="rm-sidebar-footer">
              <button
                type="button"
                className="rm-sidebar-footer-link"
                data-theme-toggle=""
                onClick={toggleTheme}
                title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
                aria-label={isDark ? 'Light mode' : 'Dark mode'}
              >
                {isDark ? (
                  <Sun size={16} aria-hidden="true" />
                ) : (
                  <Moon size={16} aria-hidden="true" />
                )}
                <span className="theme-label">{isDark ? 'Light mode' : 'Dark mode'}</span>
              </button>

              <ProfileMenu name={displayNameOf(accountName)} signedIn={signedIn} />
            </div>
          ) : null}
        </nav>
      )}
      {drawer ? <div className="rm-drawer-backdrop" onClick={() => setDrawer(false)} /> : null}
      <div className="rm-main" inert={phone && drawer}>
        {open ? (
          <RoomView
            key={open.id}
            client={client}
            room={open}
            draft={drafts.current.get(open.id) ?? ''}
            onDraft={(text) => {
              drafts.current.set(open.id, text);
              setDraftVersion((value) => value + 1);
            }}
            // In the workspace shell the ☰ chip opens the shell's drawer, from the room's own
            // top bar (the shell's phone row steps aside on room pages).
            onOpenMenu={shellMenu ? openSidebar : openDrawer}
            menuLabel={shellMenu ? 'Open navigation' : 'Open menu'}
            onRoomChanged={() => void loadRooms()}
            onRead={onRead}
            userId={workspaceId || accountName}
            readMark={roomsFlag ? marks[open.id] : undefined}
            v2={roomsFlag === 'v2'}
          />
        ) : rooms === null ? (
          <div className="rm-center" role="status">
            <LoaderCircle className="spin" size={18} aria-hidden="true" />
            {/* Text for the status (the list column that used to fill this moment moved to the
                workspace sidebar). */}
            <span className="visually-hidden">Loading rooms</span>
          </div>
        ) : (
          <section className="rm-overview" aria-labelledby="rm-overview-title">
            <header className="rm-overview-head">
              {/* Under 900 px the sidebar is a drawer: this button opens it (desktop has none).
                  With shellMenu, the shell's menu button is the only one. */}
              {!shellMenu ? (
                <button
                  type="button"
                  className="rm-icon rm-menu"
                  aria-label="Open menu"
                  onClick={openDrawer}
                >
                  <Menu size={20} aria-hidden="true" />
                </button>
              ) : null}
              <h1 id="rm-overview-title">Your rooms</h1>
            </header>
            {shellMenu && phone && rooms.length ? roomActions : null}
            {rooms.length ? (
              <ul className="rm-overview-list" aria-label="All rooms">
                {ordered.map((room) => {
                  const { count: unread, more } = unreadOf(room);
                  const role = room.closed ? 'Closed' : room.role === 'host' ? 'Hosting' : 'Joined';
                  return (
                    <li key={room.id}>
                      <a
                        href={`/rooms/${room.id}`}
                        className={`rm-overview-room${room.closed ? ' closed' : ''}${unread ? ' unread' : ''}`}
                        onClick={(event) => openRoom(event, room)}
                      >
                        <span
                          className={`rm-room-item-dot${room.closed ? ' closed' : ''}`}
                          aria-hidden="true"
                        />
                        <span className="rm-overview-room-name">{room.name}</span>
                        <span className="rm-overview-room-role">{role}</span>
                        {unread ? (
                          <span
                            className="rm-room-item-badge"
                            aria-label={`${unreadLabel(unread, more)} unread`}
                          >
                            {unreadLabel(unread, more)}
                          </span>
                        ) : null}
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="rm-overview-empty">
                <h2>No rooms yet</h2>
                <p className="rm-muted">
                  A room is a shared space where AI agents and people meet, work and collaborate.
                  Start one, or join one with an invite link or code.
                </p>
                {/* On a phone the sidebar's buttons sit behind the menu: the same dialogs, here. */}
                {phone ? roomActions : null}
              </div>
            )}
          </section>
        )}
      </div>
      {joining ? (
        <JoinRoomSheet
          client={client}
          accountName={accountName}
          onClose={() => setJoining(false)}
          onJoined={(room) => {
            setJoining(false);
            setRooms((list) => [room, ...(list ?? []).filter((item) => item.id !== room.id)]);
            go(`/rooms/${room.id}`);
            // The room shows who invited the person and how to bring their own AI.
            window.history.replaceState({ ...(window.history.state ?? {}), joined: true }, '');
          }}
        />
      ) : null}
      {creating ? (
        <NewRoomSheet
          client={client}
          onClose={() => setCreating(false)}
          onCreated={(room) => {
            setCreating(false);
            setRooms((list) => [room, ...(list ?? []).filter((item) => item.id !== room.id)]);
            go(`/rooms/${room.id}`);
          }}
        />
      ) : null}
    </div>
  );
}
