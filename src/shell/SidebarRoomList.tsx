import { useEffect, useState, type MouseEvent } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { api } from '../api';
import { navigate } from './navigation';
import { markInAppChange } from './pageNavigation';
import { closeSidebar, ROOMS_SHEET_STATE, type RoomsSheet } from './sidebarRooms';
import { recordRoomActivity, roomActivityAt, sortRoomsByActivity } from './roomActivity';

/** The fields the sidebar needs from a room (src/rooms/api.ts Room). */
export type SidebarRoom = {
  id: string;
  name: string;
  role: string;
  closed: boolean;
  created_at: string;
  /** The newest message's seq (new messages since the last poll count as activity). */
  latest_seq?: number;
};

export type SidebarRoomBadge = { text: string; label: string };

/**
 * The room list under Rooms in the workspace sidebar (WORKSPACE_V3.md §3): one row per room,
 * a green dot for a live room and a grey one for an ended room, the open room highlighted, then
 * New room and Join a room. Hosting and Joined keep their grouping; their labels show only when
 * the person has rooms in both. Ended rooms sit behind "Show ended rooms".
 */
export function SidebarRoomList({
  hosting,
  joined,
  ended,
  loading,
  error,
  onRetry,
  currentId,
  badge,
  onOpen,
  onNew,
  onJoin,
}: {
  hosting: SidebarRoom[];
  joined: SidebarRoom[];
  ended: SidebarRoom[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  currentId: string | null;
  badge?: (room: SidebarRoom) => SidebarRoomBadge | null;
  /** A plain click on a row (modified clicks follow the link). */
  onOpen: (room: SidebarRoom) => void;
  onNew: () => void;
  onJoin: () => void;
}) {
  const currentEnded = ended.some((room) => room.id === currentId);
  const [showEnded, setShowEnded] = useState(false);
  const endedOpen = showEnded || currentEnded;
  // Ended rooms have their own toggle, so only Hosting and Joined together need labels.
  const labelled = hosting.length > 0 && joined.length > 0;

  const row = (room: SidebarRoom) => {
    const current = room.id === currentId;
    const unread = current ? null : (badge?.(room) ?? null);
    return (
      <li key={room.id}>
        <a
          href={`/rooms/${room.id}`}
          aria-current={current ? 'page' : undefined}
          className={`ws-room rm-room-item${current ? ' active' : ''}${room.closed ? ' closed-item' : ''}${unread ? ' unread' : ''}`}
          title={room.closed ? `${room.name} (ended)` : room.name}
          onClick={(event: MouseEvent) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button)
              return;
            event.preventDefault();
            closeSidebar();
            onOpen(room);
          }}
        >
          <span className={`ws-room-dot${room.closed ? ' ended' : ''}`} aria-hidden="true" />
          <span className="ws-room-name rm-room-item-name">{room.name}</span>
          {room.closed ? <span className="visually-hidden"> (ended)</span> : null}
          {unread ? (
            <span className="ws-room-badge rm-room-item-badge" aria-label={unread.label}>
              {unread.text}
            </span>
          ) : null}
        </a>
      </li>
    );
  };

  return (
    <nav className="ws-rooms" aria-label="Rooms">
      {loading ? (
        <div className="ws-rooms-loading" role="status" aria-label="Loading rooms">
          <span />
          <span />
        </div>
      ) : null}
      {error ? (
        <p className="ws-rooms-error" role="alert">
          Rooms couldn't load.{' '}
          <button type="button" className="text-link" onClick={onRetry}>
            Retry
          </button>
        </p>
      ) : null}
      {hosting.length ? (
        <div className="ws-room-group" id="groupHosting">
          {labelled ? <p className="ws-room-group-label">Hosting</p> : null}
          <ul className="ws-room-rows" aria-label={labelled ? 'Hosting' : undefined}>
            {hosting.map(row)}
          </ul>
        </div>
      ) : null}
      {joined.length ? (
        <div className="ws-room-group" id="groupJoined">
          {labelled ? <p className="ws-room-group-label">Joined</p> : null}
          <ul className="ws-room-rows" aria-label={labelled ? 'Joined' : undefined}>
            {joined.map(row)}
          </ul>
        </div>
      ) : null}
      {ended.length ? (
        <div className="ws-room-group" id="groupEnded">
          <button
            type="button"
            className="ws-room-ended-toggle"
            aria-expanded={endedOpen}
            aria-controls="endedRoomsList"
            onClick={() => setShowEnded(!endedOpen)}
          >
            <ChevronRight size={14} aria-hidden="true" className="ws-chevron" />
            {endedOpen ? 'Hide ended rooms' : 'Show ended rooms'}
            <span className="ws-room-ended-count">{ended.length}</span>
          </button>
          {endedOpen ? (
            <ul className="ws-room-rows" id="endedRoomsList" aria-label="Ended rooms">
              {ended.map(row)}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="ws-room-actions">
        <button type="button" className="ws-mini primary rm-new" onClick={onNew}>
          <Plus size={14} aria-hidden="true" />
          New room
        </button>
        <button type="button" className="ws-mini rm-join-room" onClick={onJoin}>
          Join a room
        </button>
      </div>
    </nav>
  );
}

/** Open rooms by role, ended rooms last; the newest first inside each group. */
export function groupRooms<T extends SidebarRoom>(rooms: T[]) {
  return {
    hosting: rooms.filter((room) => room.role === 'host' && !room.closed),
    joined: rooms.filter((room) => room.role !== 'host' && !room.closed),
    ended: rooms.filter((room) => room.closed),
  };
}

const LIST_POLL_MS = 30_000;

/**
 * The sidebar's own room list on pages other than Rooms (RoomsApp draws it on room pages).
 * Rows open the room; New room and Join a room open the rooms page with that sheet. The order is
 * the rooms pages' order: latest activity first (shell/roomActivity.ts), from the activity those
 * pages recorded and the new messages this list's own polls see.
 */
export function ShellRoomList({ workspaceId }: { workspaceId: string }) {
  const [rooms, setRooms] = useState<SidebarRoom[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let seqs: Map<string, number> | null = null;
    const load = () =>
      api<{ rooms: SidebarRoom[] }>(
        '/api/rooms',
        undefined,
        'GET',
        AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
      )
        .then((value) => {
          if (!active) return;
          const now = Date.now();
          const seen: Record<string, number> = {};
          for (const room of value.rooms) {
            const before = seqs?.get(room.id);
            if (before !== undefined && (room.latest_seq ?? 0) > before) seen[room.id] = now;
          }
          seqs = new Map(value.rooms.map((room) => [room.id, room.latest_seq ?? 0]));
          const activity = recordRoomActivity(workspaceId, seen);
          setRooms(
            sortRoomsByActivity(value.rooms, (room) => roomActivityAt(room, activity[room.id])),
          );
          setError(false);
        })
        .catch(() => {
          if (active) setError(true);
        });
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, LIST_POLL_MS);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [workspaceId, attempt]);
  const go = (path: string, sheet?: RoomsSheet) => {
    closeSidebar();
    markInAppChange();
    window.history.pushState(sheet ? { [ROOMS_SHEET_STATE]: sheet } : null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  return (
    <SidebarRoomList
      {...groupRooms(rooms ?? [])}
      loading={rooms === null && !error}
      error={error}
      onRetry={() => setAttempt((value) => value + 1)}
      currentId={null}
      onOpen={(room) => {
        markInAppChange();
        navigate(`/rooms/${room.id}`);
      }}
      onNew={() => go('/rooms', 'new')}
      onJoin={() => go('/rooms', 'join')}
    />
  );
}
