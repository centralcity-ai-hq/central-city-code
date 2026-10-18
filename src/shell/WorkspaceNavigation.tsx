import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ChevronDown,
  ChevronUp,
  CircleHelp,
  DoorOpen,
  Layers3,
  LogOut,
  MessagesSquare,
  Network,
  Pause,
  Play,
  Plug,
  RefreshCw,
  Rss,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  SunMoon,
  X,
} from 'lucide-react';
import { api } from '../api';
import { Lockup } from '../brand';
import { navigate } from './navigation';
import { markInAppChange } from './pageNavigation';
import { prefetchElric, prefetchElricIdle } from '../elric/prefetch';
import { useFeedOn } from '../feed/feedStatus';
import { waitingLabel } from '../elric/elricV3';
import { type WorkspaceView } from './workspaceDestinations';
import { nextThemePreference, useTheme, type ThemePreference } from './theme';
import { ShellRoomList } from './SidebarRoomList';
import { avatarStyle } from './avatarColor';
import { setSidebarClose, setSidebarRoomsSlot, useSidebarRoomsClaimed } from './sidebarRooms';
import { messagesBadgeLabel } from './badgeLabels';
import { timeoutSignal } from './timeoutSignal';
import { pageVisible } from '../rooms/readMark';
import '../rooms/rooms-v2.css';
import './workspace-navigation.css';

/** "1 pending connection request", "2 pending connection requests". */
export const pendingRequestsLabel = (count: number) =>
  `${count} pending connection ${count === 1 ? 'request' : 'requests'}`;
/** "1 room invitation", "2 room invitations" (open invitations to your agents). */
export const roomInvitationsLabel = (count: number) =>
  `${count} room ${count === 1 ? 'invitation' : 'invitations'}`;
export { messagesBadgeLabel, unreadMessagesLabel } from './badgeLabels';

const THEME_NAME: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/** Where the ADVANCED group's open state is kept, per workspace. */
export const advancedStorageKey = (workspaceId: string) => `cc.nav.advanced:${workspaceId}`;
function readAdvanced(workspaceId: string) {
  try {
    return window.localStorage.getItem(advancedStorageKey(workspaceId)) !== '0';
  } catch {
    return true;
  }
}

const ICON = { size: 18, strokeWidth: 1.9, 'aria-hidden': true } as const;

/** The Feed's code, fetched on the way to a click on its entry. */
const warmFeed = () => void import('../feed/Feed').catch(() => undefined);

/**
 * The workspace sidebar (docs/design/WORKSPACE_V3.md §3): brand, Rooms with the room list,
 * Messages, Elric, My agents, the Feed (only while GET /api/public/feed answers 200), Connect AI,
 * the ADVANCED group, and the account card with its menu.
 * Global navigation only. Room membership and console permissions remain server-owned.
 */
export function WorkspaceNavigation({
  workspaceId,
  view,
  unreadMessages = 0,
  requestResponses = 0,
  roomInvitations = 0,
  onView,
  showElric,
  onClose,
  mobileOpen,
  accountName,
  accountDetail,
  workspaceSwitch,
  refreshing,
  onRefresh,
  signingOut,
  onSignOut,
  paused = null,
  pausing = false,
  onTogglePause,
}: {
  workspaceId: string;
  view: WorkspaceView | null;
  /** Unread messages across the workspace's inboxes, shown on Messages as in the classic nav. */
  unreadMessages?: number;
  /** Open responses to your Feed requests: counted on Messages' badge too, and said so. */
  requestResponses?: number;
  /** Open room invitations to your agents (the inbox summary): on My agents' badge. */
  roomInvitations?: number;
  onView: (view: WorkspaceView) => void;
  showElric: boolean;
  onClose: () => void;
  mobileOpen: boolean;
  /** The account card: the workspace's name and its kind ("Private workspace"). */
  accountName: string;
  accountDetail: string;
  /** The workspace switcher (a select), shown in the account menu when there is a choice. */
  workspaceSwitch?: ReactNode;
  refreshing: boolean;
  onRefresh: () => void;
  signingOut: boolean;
  onSignOut: () => void;
  /**
   * Whether the workspace is paused (null while it loads). The account menu shows it as
   * "Workspace running" / "Workspace paused"; choosing it pauses or resumes the workspace.
   */
  paused?: boolean | null;
  pausing?: boolean;
  onTogglePause?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [requests, setRequests] = useState<number | null>(null);
  const [requestError, setRequestError] = useState(false);
  // Elric's pending approvals (GET /api/elric/pending): the Elric entry's badge. Read on the
  // same cycle as the connection requests — no timer of its own — and only when the account
  // has the Elric entry at all.
  const [approvals, setApprovals] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [advanced, setAdvanced] = useState(() => readAdvanced(workspaceId));
  const [accountOpen, setAccountOpen] = useState(false);
  const accountButton = useRef<HTMLButtonElement>(null);
  const accountMenu = useRef<HTMLDivElement>(null);
  const advancedId = useId();
  const accountMenuId = useId();
  const pauseStateId = useId();
  // The count badges are drawn aria-hidden so the entries keep their plain names ("Elric", "My
  // agents", "Messages"); the words behind a count ride along as the button's description.
  const messagesHintId = useId();
  const elricHintId = useId();
  const agentsHintId = useId();
  const { preference, setPreference } = useTheme();
  const roomsClaimed = useSidebarRoomsClaimed();
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const onRooms = path.startsWith('/rooms') || path.startsWith('/r/');
  const onFeed = path === '/feed' || path.startsWith('/feed/');
  // The Feed's entry: only once the Feed answers that it is on (unless CITY_FEED is '0').
  const feedOn = useFeedOn();
  useEffect(() => setAdvanced(readAdvanced(workspaceId)), [workspaceId]);
  useEffect(() => {
    // The removed room shortcuts kept their state here; drop the leftover key.
    try {
      window.localStorage.removeItem(`cc.workspace-rooms:${workspaceId}`);
    } catch {
      // Storage can be unavailable (private mode, blocked site data): nothing to clean up.
    }
  }, [workspaceId]);
  useEffect(() => {
    setSidebarClose(onClose);
    return () => setSidebarClose(() => {});
  }, [onClose]);
  const slot = useCallback((element: HTMLDivElement | null) => setSidebarRoomsSlot(element), []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function load() {
      const signal = timeoutSignal(controller.signal, 12_000);
      await Promise.allSettled([
        api<{ incoming: { status: string }[] }>(
          '/api/v2/connections/requests',
          undefined,
          'GET',
          signal,
        )
          .then((value) => {
            if (active) {
              setRequests(value.incoming.filter((item) => item.status === 'pending').length);
              setRequestError(false);
            }
          })
          .catch(() => {
            if (active) {
              setRequests(null);
              setRequestError(true);
            }
          }),
        showElric
          ? api<{ pending: { id: string }[] }>('/api/elric/pending', undefined, 'GET', signal)
              .then((value) => {
                if (active) setApprovals(value.pending.length);
              })
              .catch(() => {
                // Best effort: a failed read shows no badge, never an error line.
                if (active) setApprovals(null);
              })
          : Promise.resolve(),
      ]);
    }
    void load();
    // Badges refresh only while the tab is showing; coming back reads them at once.
    const timer = window.setInterval(() => {
      if (pageVisible()) void load();
    }, 30_000);
    const shown = () => {
      if (pageVisible()) void load();
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [workspaceId, attempt, view, path, showElric]);
  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const aside = root.current?.closest('aside');
    root.current?.querySelector<HTMLButtonElement>('.wv2-close')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }
      if (event.key === 'Tab' && aside) {
        const items = [
          ...aside.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], select, summary'),
        ].filter((item) => item.getClientRects().length);
        const first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [mobileOpen, onClose]);
  // The account menu closes on a click outside it; Escape closes it and returns focus.
  useEffect(() => {
    if (!accountOpen) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (accountMenu.current?.contains(target) || accountButton.current?.contains(target)) return;
      setAccountOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [accountOpen]);
  // The account menu takes focus when it opens: its first item (the switcher or Settings).
  const menuItems = () =>
    [
      ...(accountMenu.current?.querySelectorAll<HTMLElement>(
        'select, a[href], button:not(:disabled)',
      ) ?? []),
    ].filter((element) => element.getClientRects().length);
  useEffect(() => {
    if (accountOpen) menuItems()[0]?.focus();
  }, [accountOpen]);
  // Arrow keys, Home and End move through the menu (Tab works too; Escape is handled below).
  const menuKey = (event: ReactKeyboardEvent) => {
    if (event.key === 'Tab' && !event.shiftKey) {
      // Tab past the last item: focus moves on as usual (the phone drawer wraps it), then the
      // menu closes.
      const items = menuItems();
      if (document.activeElement === items.at(-1)) window.setTimeout(() => setAccountOpen(false));
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if ((event.target as HTMLElement).tagName === 'SELECT') return;
    const items = menuItems();
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  // Elric's page is one click away: fetch its chunk (and its first chat) once the browser is idle.
  useEffect(() => {
    if (!showElric) return;
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(prefetchElricIdle, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(prefetchElricIdle, 1500);
    return () => window.clearTimeout(id);
  }, [showElric]);
  // On a phone there is no hover: opening the navigation is the hint that Elric may be next.
  useEffect(() => {
    if (mobileOpen && showElric) prefetchElric();
  }, [mobileOpen, showElric]);
  // Already on Elric: nothing to read ahead.
  const warmElric = path === '/elric' ? undefined : prefetchElric;
  const go = (target: string) => {
    onClose();
    setAccountOpen(false);
    // A page change inside the workspace: the shell and this navigation stay, and a page whose
    // code is still loading keeps the current one on screen instead of a loading screen.
    markInAppChange();
    navigate(target);
  };
  const toggleAdvanced = () => {
    const next = !advanced;
    setAdvanced(next);
    try {
      window.localStorage.setItem(advancedStorageKey(workspaceId), next ? '1' : '0');
    } catch {
      // Storage unavailable: the group still opens and closes for this visit.
    }
  };
  const link = (target: string, label: string, icon: ReactNode) => (
    <a
      className="ws-menu-item"
      href={target}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button)
          return;
        event.preventDefault();
        go(target);
      }}
    >
      {icon}
      {label}
    </a>
  );
  const item = (
    label: string,
    icon: ReactNode,
    active: boolean,
    onClick: () => void,
    extra?: {
      className?: string;
      badge?: ReactNode;
      /** What a shown badge means, as the button's accessible description (its name stays plain). */
      badgeHint?: { id: string; text: string };
      warm?: () => void;
    },
  ) => (
    <>
      <button
        type="button"
        className={`nav-item ws-nav${active ? ' active' : ''}${extra?.className ? ` ${extra.className}` : ''}`}
        aria-current={active ? 'page' : undefined}
        aria-describedby={extra?.badgeHint?.id}
        onClick={onClick}
        onPointerEnter={extra?.warm}
        onFocus={extra?.warm}
        onPointerDown={extra?.warm}
      >
        {icon}
        <span className="ws-nav-label">{label}</span>
        {extra?.badge}
      </button>
      {extra?.badgeHint ? (
        <span id={extra.badgeHint.id} className="visually-hidden">
          {extra.badgeHint.text}
        </span>
      ) : null}
    </>
  );
  return (
    <div
      ref={root}
      className="wv2-navigation"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !accountOpen) return;
        event.preventDefault();
        event.stopPropagation();
        setAccountOpen(false);
        accountButton.current?.focus();
      }}
    >
      <div className="ws-brand">
        <Lockup onClick={() => go('/rooms')} label="Central City rooms" />
        <button
          type="button"
          className="wv2-close ws-chip-round"
          onClick={onClose}
          aria-label="Close navigation"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <nav aria-label="Workspace" className="ws-nav-list">
        {item('Rooms', <DoorOpen {...ICON} />, onRooms, () => go('/rooms'))}
        {/* Room pages draw their own list here (RoomsApp, through a portal). */}
        <div ref={slot} className="ws-rooms-slot" />
        {roomsClaimed || onRooms ? null : <ShellRoomList workspaceId={workspaceId} />}
        {item(
          'Messages',
          <MessagesSquare {...ICON} />,
          view === 'messages',
          () => {
            setAccountOpen(false);
            onView('messages');
          },
          {
            badge:
              unreadMessages + requestResponses > 0 ? (
                <span className="nav-count" aria-hidden="true">
                  {unreadMessages + requestResponses}
                </span>
              ) : null,
            badgeHint:
              unreadMessages + requestResponses > 0
                ? {
                    id: messagesHintId,
                    text: messagesBadgeLabel(unreadMessages, requestResponses),
                  }
                : undefined,
          },
        )}
        {showElric
          ? item('Elric', <Sparkles {...ICON} />, path === '/elric', () => go('/elric'), {
              // Elric opens without a wait: its chunk and status load on the way to the click.
              warm: warmElric,
              badge:
                approvals !== null && approvals > 0 ? (
                  <span className="nav-count wv2-pending" aria-hidden="true">
                    {approvals}
                  </span>
                ) : null,
              badgeHint:
                approvals !== null && approvals > 0
                  ? { id: elricHintId, text: waitingLabel(approvals) }
                  : undefined,
            })
          : null}
        {item('My agents', <Layers3 {...ICON} />, view === 'agents', () => onView('agents'), {
          badge:
            (requests ?? 0) + roomInvitations > 0 ? (
              <span className="nav-count wv2-pending" aria-hidden="true">
                {(requests ?? 0) + roomInvitations}
              </span>
            ) : null,
          badgeHint:
            (requests ?? 0) + roomInvitations > 0
              ? {
                  id: agentsHintId,
                  text: [
                    requests ? pendingRequestsLabel(requests) : '',
                    roomInvitations ? roomInvitationsLabel(roomInvitations) : '',
                  ]
                    .filter(Boolean)
                    .join(', '),
                }
              : undefined,
        })}
        {feedOn
          ? item('Feed', <Rss {...ICON} />, onFeed, () => go('/feed'), { warm: warmFeed })
          : null}
        {item('Connect AI', <Plug {...ICON} />, view === 'connect', () => onView('connect'), {
          className: 'nav-connect',
        })}
      </nav>
      {requestError ? (
        <p className="wv2-hint" role="status">
          Connection requests unavailable ·{' '}
          <button className="text-link" onClick={() => setAttempt((value) => value + 1)}>
            Retry connection requests
          </button>
        </p>
      ) : null}
      <button
        type="button"
        className="ws-group"
        aria-expanded={advanced}
        aria-controls={advancedId}
        onClick={toggleAdvanced}
      >
        <span>Advanced</span>
        <ChevronDown size={14} aria-hidden="true" className="ws-chevron" />
      </button>
      <nav id={advancedId} aria-label="Advanced" hidden={!advanced}>
        {item('Research & review', <Search {...ICON} />, view === 'collaborations', () =>
          onView('collaborations'),
        )}
        {item('Agent permissions', <ShieldCheck {...ICON} />, view === 'connections', () =>
          onView('connections'),
        )}
        {item('Network map', <Network {...ICON} />, view === 'network', () => onView('network'))}
      </nav>
      <div className="ws-spacer" />
      <div
        className="ws-account"
        onBlur={(event) => {
          // Focus leaving the card and its menu (Tab past the last item) closes the menu.
          const next = event.relatedTarget as Node | null;
          if (accountOpen && next && !event.currentTarget.contains(next)) setAccountOpen(false);
        }}
      >
        <button
          ref={accountButton}
          type="button"
          className="ws-account-card"
          aria-expanded={accountOpen}
          aria-controls={accountOpen ? accountMenuId : undefined}
          aria-label={`Account: ${accountName}`}
          onClick={() => setAccountOpen((open) => !open)}
        >
          <span
            className="workspace-avatar"
            aria-hidden="true"
            style={avatarStyle(workspaceId || accountName)}
          >
            {accountName.slice(0, 1).toUpperCase()}
          </span>
          <span className="ws-account-text">
            <strong>{accountName}</strong>
            <small>{accountDetail}</small>
          </span>
          <ChevronUp size={16} aria-hidden="true" className="ws-account-chevron" />
        </button>
        {accountOpen ? (
          <div ref={accountMenu} id={accountMenuId} className="ws-account-menu" onKeyDown={menuKey}>
            {workspaceSwitch}
            <nav aria-label="Account">
              {link('/settings/account', 'Settings', <Settings {...ICON} />)}
              {link('/docs', 'Help', <CircleHelp {...ICON} />)}
              <button
                type="button"
                className="ws-menu-item"
                aria-label={`Theme: ${THEME_NAME[preference]}`}
                onClick={() => setPreference(nextThemePreference(preference))}
              >
                <SunMoon {...ICON} />
                Theme
                <span className="ws-menu-value">{THEME_NAME[preference]}</span>
              </button>
              {/* aria-disabled, not disabled: the snapshot refreshes on its own (on load, every
                  15 s, on server events), and a disabled item would drop out of the arrow-key
                  order mid-menu, or drop the keyboard focus when it sits on it. */}
              <button
                type="button"
                className="ws-menu-item"
                aria-disabled={refreshing || undefined}
                onClick={() => {
                  if (!refreshing) onRefresh();
                }}
              >
                <RefreshCw {...ICON} className={refreshing ? 'spin' : ''} />
                Refresh
              </button>
              {paused !== null && onTogglePause ? (
                <button
                  type="button"
                  className="ws-menu-item"
                  data-paused={paused || undefined}
                  // aria-disabled, not disabled: focus stays on the item while the change runs.
                  aria-disabled={pausing || undefined}
                  aria-label={paused ? 'Resume workspace' : 'Pause workspace'}
                  aria-describedby={pauseStateId}
                  onClick={() => {
                    if (!pausing) onTogglePause();
                  }}
                >
                  {paused ? <Play {...ICON} /> : <Pause {...ICON} />}
                  {paused ? 'Resume workspace' : 'Pause workspace'}
                  <span id={pauseStateId} className="ws-menu-value">
                    {paused ? 'Paused' : 'Running'}
                  </span>
                </button>
              ) : null}
              <hr />
              <button
                type="button"
                className="ws-menu-item danger"
                disabled={signingOut}
                onClick={onSignOut}
              >
                <LogOut {...ICON} />
                Sign out
              </button>
            </nav>
          </div>
        ) : null}
      </div>
    </div>
  );
}
