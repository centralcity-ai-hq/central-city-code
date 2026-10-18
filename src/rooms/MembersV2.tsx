import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { MemberSaysLine } from './MemberSays';
import { Ellipsis, MessageCircle, Search, Volume2, VolumeX, X } from 'lucide-react';
import {
  withRoomDeadline,
  type LeftMember,
  type Member,
  type RemovedMember,
  type Room,
  type RoomOverview,
  type RoomsClient,
} from './api';
import { directAction, directHref } from './direct';
import { initialOf } from './MessageList';
import { agentOwners } from './people';
import { RemoveConfirm } from './RemoveConfirm';
import { ConfirmRow } from './RoomSettings';
import { describe } from './useRoomThread';
import { AvatarColorsContext, avatarStyle } from '../shell/avatarColor';
import { isActiveNow } from './headerCountsV2';
import { PanelHead } from './PanelV3';
import {
  MEMBERS_PAGE_V2,
  activityText,
  countText,
  groupMembers,
  isElric,
  memberBadges,
  mergePage,
  saysText,
  withActivity,
} from './membersViewV2';
import { RoomInvitations } from './RoomInvitations';

/**
 * Smart Rooms v2 (preview) Members panel (SPEC 2.7, 2.8 entry): server-paged and server-searched,
 * so a room of 10,000 members never loads everyone. People and AIs are grouped with their room
 * counts; each row shows its badges, activity and (when the server sends it) what an AI says it is
 * doing. "Message privately" follows direct.ts; the host's Mute and Remove sit in a row menu.
 * Ctrl/Cmd+K focuses the search while the panel is open. Styles: rooms-v2-members.css.
 */

const SEARCH_DELAY_MS = 250;
/** Extra pages a search asks for on its own while pages come back empty with more to follow. */
const SEARCH_EMPTY_PAGES = 4;
/** The search shortcut hint: Cmd+K on Apple devices, Ctrl+K elsewhere (both work everywhere). */
const SHORTCUT =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '')
    ? '⌘K'
    : 'Ctrl K';

type Load = 'loading' | 'more' | 'ready' | 'error';

export function MembersPanelV2({
  client,
  room,
  members,
  elricRow,
  elricManaged,
  onChanged,
  onClose,
  onLeft,
}: {
  client: RoomsClient;
  room: Room;
  /** The room view's first page: your own members (Leave) and the host's name. */
  members: Member[];
  /** "Elric in this room" switch row, when Elric is on for this room. */
  elricRow: ReactNode;
  /** Elric is added and removed with that switch, so its row has no Remove. */
  elricManaged: boolean;
  onChanged: () => void;
  onClose: () => void;
  onLeft: () => void;
}) {
  const avatarColours = useContext(AvatarColorsContext);
  const panelRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const host = room.role === 'host';

  // Ctrl/Cmd+K focuses the member search, only while this panel is open.
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'k')
        return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, []);

  // Search: typed text, then the debounced term the server is asked for.
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const [rows, setRows] = useState<Member[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [load, setLoad] = useState<Load>('loading');
  const [reload, setReload] = useState(0);
  const request = useRef(0);
  const fetchPage = useCallback(
    async (after?: string) => {
      const id = ++request.current;
      setLoad(after ? 'more' : 'loading');
      try {
        const ask = (cursor?: string) =>
          withRoomDeadline(
            client.membersPage({
              room_id: room.id,
              limit: MEMBERS_PAGE_V2,
              ...(term ? { q: term } : {}),
              ...(cursor ? { cursor } : {}),
            }),
          );
        let page = await ask(after);
        // A searched page can come back empty while more follow (members whose name keys are not
        // known yet are checked on the server page by page): keep going a few pages before
        // showing an empty result.
        for (
          let extra = 0;
          term && !page.members.length && page.next_cursor && extra < SEARCH_EMPTY_PAGES;
          extra++
        ) {
          if (id !== request.current) return;
          page = await ask(page.next_cursor);
        }
        if (id !== request.current) return;
        setRows((current) => (after ? mergePage(current, page.members) : page.members));
        setCursor(page.next_cursor);
        setLoad('ready');
      } catch {
        if (id === request.current) setLoad('error');
      }
    },
    [client, room.id, term],
  );
  useEffect(() => {
    void fetchPage();
  }, [fetchPage, room.member_count, reload]);

  // Room counts for the group headings; the loaded rows stand in while they are unknown.
  const [overview, setOverview] = useState<RoomOverview['members'] | null>(null);
  useEffect(() => {
    let active = true;
    withRoomDeadline(client.overview({ room_id: room.id }))
      .then((value) => active && setOverview(value.members))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, room.id, room.member_count, reload]);

  // Host: who is muted, and who left on their own recently (listed only).
  const [muted, setMuted] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!host || room.closed) return;
    let active = true;
    withRoomDeadline(client.mutes({ room_id: room.id }))
      .then((list) => active && setMuted(new Set(list.map((entry) => entry.agent_id))))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, host, room.id, room.closed, reload]);
  const [left, setLeft] = useState<LeftMember[]>([]);
  useEffect(() => {
    if (!host) return;
    let active = true;
    withRoomDeadline(client.recentlyLeft({ room_id: room.id }))
      .then((list) => active && setLeft(list))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, host, room.id, room.member_count]);
  // Host: removed members whose owners cannot rejoin. "Allow back in" lifts that (the server's
  // remove route with block_rejoin: false); the row then leaves the list.
  const [removed, setRemoved] = useState<RemovedMember[]>([]);
  useEffect(() => {
    if (!host) return;
    let active = true;
    withRoomDeadline(client.removed({ room_id: room.id }))
      .then((list) => active && setRemoved(list))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, host, room.id, room.member_count]);

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  function cancel() {
    const key = confirm;
    setConfirm(null);
    if (key === null) return;
    requestAnimationFrame(() =>
      panelRef.current?.querySelector<HTMLElement>(`[data-confirm="${CSS.escape(key)}"]`)?.focus(),
    );
  }

  async function toggleMute(member: Member) {
    const mute = !muted.has(member.id);
    setBusy(true);
    setError('');
    try {
      await withRoomDeadline(client.mute({ room_id: room.id, agent_id: member.id, muted: mute }));
      setMuted((current) => {
        const next = new Set(current);
        if (mute) next.add(member.id);
        else next.delete(member.id);
        return next;
      });
    } catch (err) {
      setError(`Couldn't ${mute ? 'mute' : 'unmute'} ${member.name}. ${describe(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(member: Member, input: { reason: string; resetLink: boolean }) {
    setBusy(true);
    setError('');
    try {
      await withRoomDeadline(
        client.remove({
          room_id: room.id,
          agent_id: member.id,
          ...(input.reason ? { reason: input.reason } : {}),
          block_rejoin: true,
        }),
      );
    } catch (err) {
      setError(describe(err));
      setBusy(false);
      return;
    }
    setConfirm(null);
    setRows((current) => current.filter((row) => row.id !== member.id));
    onChanged();
    if (input.resetLink)
      try {
        await withRoomDeadline(
          client.rotate({ room_id: room.id, idempotency_key: crypto.randomUUID() }),
        );
      } catch {
        setError(
          `${member.name} was removed, but the invite link wasn't reset. Reset it from Invite.`,
        );
      }
    setBusy(false);
  }

  // "Allow back in": a second remove with block_rejoin: false lifts the ban (nothing else
  // changes; the audit line is the server's). The row leaves the list on success.
  async function allowBack(member: RemovedMember) {
    setBusy(true);
    setError('');
    try {
      await withRoomDeadline(
        client.remove({ room_id: room.id, agent_id: member.id, block_rejoin: false }),
      );
    } catch (err) {
      setError(`Couldn't allow ${member.name} back in. ${describe(err)}`);
      setBusy(false);
      return;
    }
    setConfirm(null);
    setRemoved((current) => current.filter((entry) => entry.id !== member.id));
    setBusy(false);
  }

  // Your own members that can leave (a host never leaves; it closes the room).
  const leaving = members.filter((member) => member.own && member.role !== 'host');
  const hostMember = members.find((member) => member.role === 'host');
  async function leave() {
    setBusy(true);
    setError('');
    try {
      for (const member of leaving)
        await withRoomDeadline(
          client.leave({
            room_id: room.id,
            ...(leaving.length > 1 ? { agent_id: member.id } : {}),
          }),
        );
      setConfirm(null);
      onLeft();
    } catch (err) {
      setError(describe(err));
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const ownerOf = useMemo(() => agentOwners([...members, ...rows]), [members, rows]);
  // The room view refreshes its member list while this panel is open: its activity fields
  // (status, active_now, last_active_at) are newer than these pages, so the rows show them and
  // agree with the Active-now list and the header badge.
  const current = useMemo(() => withActivity(rows, members), [rows, members]);
  const { people, ais } = groupMembers(current);
  const searching = term !== '';
  const total = overview?.total ?? room.member_count;
  const groupCount = (loaded: number, known: number | undefined) =>
    searching || known === undefined
      ? `${countText(loaded)}${cursor ? '+' : ''}`
      : countText(Math.max(known, loaded));
  const now = Date.now();
  const empty = load === 'ready' && rows.length === 0;

  const renderRow = (member: Member) => {
    const direct = directAction(room, member);
    const badges = memberBadges(member, ownerOf);
    const activity = activityText(member, now);
    const says = saysText(member);
    const isMuted = host && muted.has(member.id);
    const hostActions =
      host && member.role !== 'host' && !room.closed && !(elricManaged && isElric(member));
    return (
      <li key={member.id} className="rm-v2-member" data-testid="member-row">
        <span
          className="rm-avatar"
          data-kind={isElric(member) ? 'elric' : (member.kind ?? 'agent')}
          data-offline={member.status === 'offline' || undefined}
          style={isElric(member) ? undefined : avatarStyle(member.id, avatarColours.get(member.id))}
          aria-hidden="true"
        >
          {initialOf(member.name)}
        </span>
        <div className="rm-v2-member-info">
          <span className="rm-v2-member-line">
            <strong className="rm-v2-member-name" title={member.name}>
              {member.name}
            </strong>
            {badges.map((badge) => (
              <Fragment key={badge.kind}>
                {badge.spoken ? <span className="rm-visually-hidden">{badge.spoken}</span> : null}
                <span
                  className="rm-v2-mbadge"
                  data-kind={badge.kind}
                  data-testid="member-badge"
                  aria-hidden={badge.spoken ? true : undefined}
                >
                  {badge.text}
                </span>
              </Fragment>
            ))}
            {isMuted ? (
              <span className="rm-v2-mbadge" data-kind="muted">
                Muted
              </span>
            ) : null}
          </span>
          {activity ? (
            <span
              className="rm-v2-member-activity"
              data-status={member.status}
              // The active pill follows the header badge's rule (headerCountsV2 isActiveNow).
              data-active={isActiveNow(member, now) || undefined}
              data-testid="member-activity"
              title={
                member.last_active_at && Number.isFinite(Date.parse(member.last_active_at))
                  ? `Last active ${new Date(member.last_active_at).toLocaleString()}`
                  : undefined
              }
            >
              <span className="rm-v2-member-dot" aria-hidden="true" />
              <span className="rm-v2-member-activity-text">{activity}</span>
            </span>
          ) : null}
          {says ? <MemberSaysLine text={says} /> : null}
        </div>
        <span className="rm-v2-member-actions">
          {direct === 'message' ? (
            <a
              className="rm-v2-dm"
              href={directHref(room.id, member.id)}
              aria-label={`Message ${member.name} privately`}
            >
              <MessageCircle size={14} aria-hidden="true" />
              <span className="rm-v2-dm-label">Message</span>
            </a>
          ) : direct === 'elric' ? (
            // Elric is talked to in its own chat, with the same Message button as every member.
            <a className="rm-v2-dm" href="/elric" aria-label="Message Elric">
              <MessageCircle size={14} aria-hidden="true" />
              <span className="rm-v2-dm-label">Message</span>
            </a>
          ) : null}
          {hostActions ? (
            <RowMenu
              name={member.name}
              confirmKey={member.id}
              items={[
                ...(direct === 'message'
                  ? [
                      {
                        key: 'dm',
                        label: 'Message privately',
                        icon: <MessageCircle size={14} aria-hidden="true" />,
                        href: directHref(room.id, member.id),
                      },
                    ]
                  : []),
                ...(member.own
                  ? []
                  : [
                      {
                        key: 'mute',
                        label: isMuted ? 'Unmute' : 'Mute',
                        icon: isMuted ? (
                          <Volume2 size={14} aria-hidden="true" />
                        ) : (
                          <VolumeX size={14} aria-hidden="true" />
                        ),
                        onSelect: () => void toggleMute(member),
                      },
                    ]),
                {
                  key: 'remove',
                  label: 'Remove',
                  danger: true,
                  icon: <X size={14} aria-hidden="true" />,
                  onSelect: () => setConfirm(member.id),
                },
              ]}
            />
          ) : null}
        </span>
        {confirm === member.id ? (
          <RemoveConfirm
            question={`Remove ${member.name}? They can't rejoin.`}
            guest={member.guest === true}
            busy={busy}
            onConfirm={(input) => void removeMember(member, input)}
            onCancel={cancel}
          />
        ) : null}
      </li>
    );
  };

  return (
    <aside className="rm-panel rm-v2-members rm-v3-panel" aria-label="Members" ref={panelRef}>
      <PanelHead closeLabel="Close members" onClose={onClose}>
        <h2>Members</h2>
        <p className="rm-v2-subtitle" data-testid="members-total">
          {countText(total)} {total === 1 ? 'member' : 'members'}
          {overview
            ? ` · ${countText(overview.people)} ${overview.people === 1 ? 'person' : 'people'} · ${countText(overview.ais)} ${overview.ais === 1 ? 'AI' : 'AIs'}`
            : ''}
        </p>
      </PanelHead>
      <div className="rm-v3-body">
        <div className="rm-v2-members-search" role="search" aria-label="Members">
          <Search size={16} aria-hidden="true" className="rm-v2-search-icon" />
          <label className="rm-visually-hidden" htmlFor={searchId}>
            Search members
          </label>
          <input
            id={searchId}
            ref={searchRef}
            type="search"
            className="rm-input"
            placeholder="Name or handle starts with…"
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.stopPropagation();
                setQuery('');
              }
            }}
          />
          {load === 'loading' && rows.length ? (
            <span className="rm-v2-spinner" role="status" aria-label="Searching" />
          ) : (
            <kbd className="rm-v2-kbd" aria-hidden="true">
              {SHORTCUT}
            </kbd>
          )}
        </div>

        {error ? (
          <p className="rm-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        {elricRow}

        {load === 'error' ? (
          <p className="rm-v2-members-error" role="alert">
            Unable to load member directory.{' '}
            <button type="button" className="rm-v2-link" onClick={() => setReload((n) => n + 1)}>
              Retry
            </button>
          </p>
        ) : null}
        {load === 'loading' && !rows.length ? (
          <p className="rm-v2-members-note" role="status">
            Loading members…
          </p>
        ) : null}
        {empty && searching && cursor ? (
          <p className="rm-v2-members-note" role="status">
            No matches on this page yet. Show more to keep looking.
          </p>
        ) : null}
        {empty && searching && !cursor ? (
          <p className="rm-v2-members-note" role="status">
            No members match “{term}”.{' '}
            <button
              type="button"
              className="rm-v2-link"
              onClick={() => {
                setQuery('');
                searchRef.current?.focus();
              }}
            >
              Clear search
            </button>
          </p>
        ) : null}

        {people.length ? (
          <section className="rm-v2-member-group" aria-labelledby={`${searchId}-people`}>
            <h3 id={`${searchId}-people`} className="rm-v2-group-title">
              People{' '}
              <span className="rm-v2-group-count">
                {groupCount(people.length, overview?.people)}
              </span>
            </h3>
            <ul className="rm-v2-member-list" aria-label="People">
              {people.map(renderRow)}
            </ul>
          </section>
        ) : null}
        {ais.length ? (
          <section className="rm-v2-member-group" aria-labelledby={`${searchId}-ais`}>
            <h3 id={`${searchId}-ais`} className="rm-v2-group-title">
              AIs <span className="rm-v2-group-count">{groupCount(ais.length, overview?.ais)}</span>
            </h3>
            <ul className="rm-v2-member-list" aria-label="AIs">
              {ais.map(renderRow)}
            </ul>
          </section>
        ) : null}
        {load === 'ready' && !searching && rows.length <= 1 ? (
          <p className="rm-v2-members-note">Invite people or connect AI agents to work together.</p>
        ) : null}

        {cursor ? (
          <button
            type="button"
            className="rm-v2-more"
            disabled={load === 'more' || load === 'loading'}
            onClick={() => void fetchPage(cursor)}
          >
            {load === 'more' ? 'Loading…' : 'Show more'}
          </button>
        ) : null}
        {rows.length && !searching ? (
          <p className="rm-v2-members-note" data-testid="members-shown">
            Showing {countText(rows.length)} of {countText(Math.max(total, rows.length))}
          </p>
        ) : null}

        {host && left.length ? (
          <div className="rm-left">
            <h3 className="rm-meta">Recently left</h3>
            <ul className="rm-members" aria-label="Recently left">
              {left.map((member) => (
                <li key={member.id}>
                  <div>
                    <strong>{member.name}</strong>
                    <span className="rm-meta">
                      left {new Date(member.left_at).toLocaleDateString()}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {host && removed.length ? (
          <div className="rm-left rm-removed">
            <h3 className="rm-meta">Removed</h3>
            <ul className="rm-members" aria-label="Removed">
              {removed.map((member) => (
                <li key={member.id}>
                  <div>
                    <strong>{member.name}</strong>
                    <span className="rm-meta">
                      removed {new Date(member.removed_at).toLocaleDateString()} · cannot rejoin
                    </span>
                  </div>
                  {confirm === `allow:${member.id}` ? (
                    <ConfirmRow
                      question={`${member.name}'s owner may join again with a live invite link.`}
                      action="Allow back in"
                      busy={busy}
                      onConfirm={() => void allowBack(member)}
                      onCancel={cancel}
                    />
                  ) : (
                    <button
                      type="button"
                      className="rm-quiet"
                      data-confirm={`allow:${member.id}`}
                      disabled={busy}
                      onClick={() => setConfirm(`allow:${member.id}`)}
                    >
                      Allow back in
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {host ? <RoomInvitations roomId={room.id} closed={room.closed} /> : null}

        {ais.length ? (
          <p className="rm-v3-note">Model names are self-reported by each AI, not verified.</p>
        ) : null}

        {/* The host closes the room from Room settings (Danger zone), not from here. */}
        {host ? null : (
          <div className="rm-leave">
            {hostMember ? (
              <p className="rm-meta">Only the host ({hostMember.name}) can invite.</p>
            ) : null}
            {leaving.length ? (
              confirm === 'leave' ? (
                <ConfirmRow
                  question={`${leaving.length > 1 ? 'Your agents stop' : 'Your agent stops'} reading and posting here. You can rejoin with an invite link.`}
                  action="Confirm leave"
                  busy={busy}
                  onConfirm={() => void leave()}
                  onCancel={cancel}
                />
              ) : (
                <button
                  type="button"
                  className="rm-quiet danger"
                  data-confirm="leave"
                  onClick={() => setConfirm('leave')}
                >
                  Leave room
                </button>
              )
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}

type RowMenuItem = {
  key: string;
  label: string;
  icon: ReactNode;
  danger?: boolean;
} & ({ href: string; onSelect?: never } | { onSelect: () => void; href?: never });

/** A member row's action menu (host): Escape and outside clicks close it; arrows move. */
function RowMenu({
  name,
  confirmKey,
  items,
}: {
  name: string;
  /** Focus returns here when a confirmation opened from the menu is cancelled. */
  confirmKey: string;
  items: RowMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const list = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      const index = list.indexOf(document.activeElement as HTMLElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      list[(index + step + list.length) % list.length]?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keys);
    };
  }, [open]);
  return (
    <span className="rm-v2-row-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="rm-v2-row-menu-btn"
        aria-label={`Actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-confirm={confirmKey}
        onClick={() => setOpen((value) => !value)}
      >
        <Ellipsis size={16} aria-hidden="true" />
      </button>
      {open ? (
        <span className="rm-v2-row-menu-list" role="menu" aria-label={`Actions for ${name}`}>
          {items.map((item) =>
            item.href ? (
              <a
                key={item.key}
                role="menuitem"
                tabIndex={-1}
                href={item.href}
                onClick={() => setOpen(false)}
              >
                {item.icon}
                {item.label}
              </a>
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-danger={item.danger || undefined}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
              >
                {item.icon}
                {item.label}
              </button>
            ),
          )}
        </span>
      ) : null}
    </span>
  );
}
