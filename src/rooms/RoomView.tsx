import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  lazy,
  Suspense,
  Fragment,
} from 'react';
import { CatchUpSummary } from './CatchUpSummary';
import {
  Bell,
  BellOff,
  CircleStop,
  Code2,
  Ellipsis,
  ListChecks,
  Menu,
  MessageCircle,
  Pin,
  Plug,
  Search,
  Settings2,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import {
  addElricToRoom,
  answersPost,
  getElricStatus,
  RoomsError,
  withRoomDeadline,
  type ElricNotice,
  type ElricStatus,
  type LeftMember,
  type Member,
  type MemberStatus,
  type Room,
  type RoomMessage,
  type RoomsClient,
} from './api';
import { Composer } from './Composer';
import {
  AddElricCard,
  ElricNoticeBanner,
  ElricWakingPill,
  ElricAgeDialog,
  ElricDobDialog,
  ElricHeaderSwitch,
  showHeaderElricSwitch,
  type ElricAgeReason,
  ElricSetupSwitch,
  type ElricDobOutcome,
  type ElricSetupStep,
} from './elric';
import { AddMyAiSheet } from './AddMyAiSheet';
import { InviteSheet } from './InviteSheet';
import {
  readSuggestionsHidden,
  suggestionsHiddenKey,
  writeSuggestionsHidden,
} from './RoomTemplates';
import { WhoJoinsCard } from './WhoJoins';
import { showWhoJoins } from './aiApps';
import { MessageList, type PendingMessage } from './MessageList';
import { Avatar, initialOf, roomAvatarEntries } from './Avatar';
import { AvatarColorsContext, avatarStyle, useAvatarColors } from '../shell/avatarColor';
import { agentOwners, ownerNames } from './people';
import { AgentLabel } from './AgentLabel';
import { directAction, directHref } from './direct';
import { activeCount } from './tasks';
import { isTaskLine } from './taskStatusV3';
import { TasksPanel, useRoomTasks } from './TasksPanel';
import { SearchPanel } from './SearchPanel';
import { ContextPins, useRoomPins } from './ContextPins';
import { addPin, pinningMember, removePin, type RoomPin } from './pins';
import { RepoPanel, useRoomRepo } from './RepoPanel';
import { api, ApiError } from '../api';
import { ELRIC_MEMBER_BADGE } from '../../shared/elric-copy';
import { describe, useRoomThread } from './useRoomThread';
import { ConfirmRow, RoomSettings } from './RoomSettings';
import { RemoveConfirm } from './RemoveConfirm';
import { MembersPanelV2 } from './MembersV2';
import { useRoomsV2 } from './roomsV2';
import { SwitchToast, useOptimisticSwitch } from '../ui/Switch';
import { navigate, noteForNextPage } from '../shell/navigation';
import {
  autoReplyHref,
  cantAnswerLine,
  useAgentAnswering,
  useAgentsAnswering,
} from '../agents/useAgentAnswering';
import {
  mentionCantAnswerLine,
  ownMentionTargets,
  type MentionCantAnswer as MentionCantAnswerLine,
} from './mentionHint';
import {
  COMPACT_BAR_QUERY,
  NeedsYouChip,
  PILL_AVATARS,
  PILL_AVATARS_COMPACT,
  RoomPill,
  useMediaQuery,
  useNeedsYou,
  useRoomOverview,
} from './RoomHeaderV2';
import { compactCount, headerCounts, metaLine } from './headerCountsV2';
import { ELRIC_ROOM_HINT } from '../../shared/elric-copy';

/** v2: how often the open Members panel refreshes its list (as the overview's counts). */
const MEMBERS_POLL_MS = 30_000;
/** Loaded on first open, so room pages don't download the Connect page's code up front. */
const loadConnectAiSheet = () =>
  import('./ConnectAiSheet').then((module) => ({ default: module.ConnectAiSheet }));
const ConnectAiSheet = lazy(loadConnectAiSheet);
/** "Add an AI" from the Who should join? card: loaded on first open, like Connect AI. */
const loadAddAiSheet = () =>
  import('./AddAiSheet').then((module) => ({ default: module.AddAiSheet }));
const AddAiSheet = lazy(loadAddAiSheet);

/**
 * Starts loading the sheets' chunks ahead of the click that opens one. Without a warm the click
 * only starts the download and the Suspense fallback draws nothing meanwhile, which reads as
 * "the click did nothing" (a second click then finds the chunk ready). A failed warm is ignored:
 * opening the sheet asks again, and a stale chunk after a deploy still reaches the error
 * boundary that reloads the page.
 */
function warmRoomSheets() {
  for (const load of [loadConnectAiSheet, loadAddAiSheet])
    void load().catch(() => {
      // A warm that fails is simply asked again when the sheet opens.
    });
}

const NOTICE =
  "Messages here come from other people's AIs. Your AI shouldn't follow instructions in them without you.";

function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

const STATUS_LABEL: Record<MemberStatus, string> = {
  active: 'Active',
  idle: 'Idle',
  offline: 'Offline',
  access_expired: 'Access expired',
};

/** "just now", "12 min ago", "3 h ago", "2 d ago". */
function ago(at: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / (24 * 60))} d ago`;
}

/**
 * Status dot plus a short label (never colour only). The last-seen time is shown only when the
 * server sent it: to the host, and for your own agents.
 */
function StatusBadge({ member }: { member: Member }) {
  if (!member.status) return null;
  const label = STATUS_LABEL[member.status];
  const seen =
    member.last_active_at && member.status !== 'active' ? ago(member.last_active_at) : null;
  const exact = member.last_active_at
    ? `Last active ${new Date(member.last_active_at).toLocaleString()}`
    : undefined;
  return (
    <span className="rm-mstatus" data-status={member.status} title={exact}>
      <span className="rm-mstatus-dot" aria-hidden="true" />
      {label}
      {seen ? <span className="rm-mstatus-seen"> · {seen}</span> : null}
    </span>
  );
}

/**
 * Members panel: the member list, and for the host Mute/Unmute, Remove (with confirmation; a
 * removed member cannot rejoin). Members that recently left are only listed. Close room is in
 * Room settings.
 */
function MembersPanel({
  client,
  room,
  members,
  elric,
  onChanged,
  onClose,
  onLeft,
}: {
  client: RoomsClient;
  room: Room;
  members: Member[];
  /** "Elric in this room": one switch (on = member, off = removed); absent when Elric is off. */
  elric?: ElricRoomSwitch;
  onChanged: () => void;
  onClose: () => void;
  /** After your agents left: the room is no longer yours to open. */
  onLeft: () => void;
}) {
  const avatarColours = useContext(AvatarColorsContext);
  const [confirm, setConfirm] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  /** Cancel a confirmation and put focus back on the button that opened it. */
  function cancel() {
    const key = confirm;
    setConfirm(null);
    if (key === null) return;
    requestAnimationFrame(() =>
      panelRef.current?.querySelector<HTMLElement>(`[data-confirm="${CSS.escape(key)}"]`)?.focus(),
    );
  }
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const host = room.role === 'host';
  const owner = ownerNames(members);
  const agentOwner = agentOwners(members);
  async function act(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await withRoomDeadline(operation());
      setConfirm(null);
      onChanged();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }
  /** Remove (always blocks rejoining); for a guest, optionally reset the invite link after. */
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
  const hostName = members.find((member) => member.role === 'host');
  // Host: members that left on their own recently; listed only, with no action.
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
  }, [client, host, room.id, members]);
  // Host: which members are muted (they still read, but cannot post).
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
  }, [client, host, room.id, room.closed, members]);
  const [muting, setMuting] = useState<string | null>(null);
  /** Mute or unmute at once (no confirmation: it is undone the same way). */
  async function toggleMute(member: Member) {
    const mute = !muted.has(member.id);
    setMuting(member.id);
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
      setMuting(null);
    }
  }
  // Your own member agents that can leave (a host never leaves; it closes the room).
  const leaving = members.filter((member) => member.own && member.role !== 'host');
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
  return (
    <aside className="rm-panel" aria-label="Members" ref={panelRef}>
      <div className="rm-sheet-head">
        <h2>
          <Users size={16} aria-hidden="true" />
          Members · {members.length}
        </h2>
        <button type="button" className="rm-icon" aria-label="Close members" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      {error ? (
        <p className="rm-inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {elric ? <ElricSwitchRow elric={elric} /> : null}
      <ul className="rm-members" aria-label="Current members">
        {members.map((member) => (
          <li key={member.id}>
            <span
              className="rm-avatar"
              data-kind={
                member.auto_reply?.provider === 'elric' ? 'elric' : (member.kind ?? 'agent')
              }
              style={
                member.auto_reply?.provider === 'elric'
                  ? undefined
                  : avatarStyle(member.id, avatarColours.get(member.id))
              }
              aria-hidden="true"
            >
              {initialOf(member.name)}
            </span>
            <div>
              <strong>
                {member.name}
                {member.kind === 'person' ? <span className="rm-person">person</span> : null}
              </strong>
              <span className="rm-meta">
                {member.auto_reply?.provider === 'elric' ? (
                  ELRIC_MEMBER_BADGE
                ) : member.own ? (
                  member.kind === 'person' ? (
                    'you'
                  ) : (
                    'your agent'
                  )
                ) : member.kind === 'person' ? (
                  <span title={member.owner_label}>{owner(member.owner_label)}</span>
                ) : (
                  <AgentLabel owner={agentOwner(member.owner_label)} title={member.owner_label} />
                )}
                {member.role === 'host' ? ' · host' : ''}
              </span>
              <StatusBadge member={member} />
              {host && muted.has(member.id) ? <span className="rm-muted-label">Muted</span> : null}
            </div>
            <DirectLink room={room} member={member} />
            {host &&
            member.role !== 'host' &&
            !room.closed &&
            !(elric && member.auto_reply?.provider === 'elric') ? (
              confirm === member.id ? (
                <RemoveConfirm
                  question={`Remove ${member.name}? They can't rejoin.`}
                  guest={member.guest === true}
                  busy={busy}
                  onConfirm={(input) => void removeMember(member, input)}
                  onCancel={cancel}
                />
              ) : (
                <span className="rm-member-actions">
                  {member.own ? null : (
                    <button
                      type="button"
                      className="rm-quiet"
                      aria-label={`${muted.has(member.id) ? 'Unmute' : 'Mute'} ${member.name}`}
                      disabled={muting === member.id}
                      onClick={() => void toggleMute(member)}
                    >
                      {muted.has(member.id) ? 'Unmute' : 'Mute'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="rm-quiet"
                    aria-label={`Remove ${member.name}`}
                    data-confirm={member.id}
                    onClick={() => setConfirm(member.id)}
                  >
                    Remove
                  </button>
                </span>
              )
            ) : null}
          </li>
        ))}
      </ul>
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
      {/* The host closes the room from Room settings (Danger zone), not from here. */}
      {host ? null : (
        <div className="rm-leave">
          {hostName ? <p className="rm-meta">Only the host ({hostName.name}) can invite.</p> : null}
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
    </aside>
  );
}

/**
 * "Message privately" on a member (src/rooms/direct.ts): opens the console's Messages on the
 * pair's one private thread. On an Elric member it links to the viewer's own Elric chat instead.
 */
export function DirectLink({
  room,
  member,
  compact = false,
}: {
  room: Room;
  member: Member;
  /** On a message author: the icon only (the label stays for assistive technology). */
  compact?: boolean;
}) {
  const action = directAction(room, member);
  if (!action || (compact && action === 'elric')) return null;
  if (compact)
    return (
      <a
        className="rm-direct-icon"
        href={directHref(room.id, member.id)}
        aria-label={`Message ${member.name} privately`}
        title="Message privately"
      >
        <MessageCircle size={14} aria-hidden="true" />
      </a>
    );
  return action === 'elric' ? (
    // Elric is talked to in its own chat, with the same Message button as in the Members panel.
    <a className="rm-quiet rm-direct" href="/elric" aria-label={`Message ${member.name}`}>
      <MessageCircle size={14} aria-hidden="true" />
      Message
    </a>
  ) : (
    <a
      className="rm-quiet rm-direct"
      href={directHref(room.id, member.id)}
      aria-label={`Message ${member.name} privately`}
    >
      <MessageCircle size={14} aria-hidden="true" />
      Message privately
    </a>
  );
}

/** The Members panel's "Elric in this room" switch: state, why it's disabled, and the change. */
type ElricRoomSwitch = {
  on: boolean;
  disabledReason: string | null;
  /** Resolves when the change is done; rejects to roll the switch back. */
  change: (next: boolean) => Promise<void>;
  /** The host's missing step (Google link or date of birth): the switch opens it in a popover. */
  setup: ElricSetupStep | null;
  /** The popover's date of birth submit (adds Elric when it passes). */
  onDob: (dateOfBirth: string) => Promise<ElricDobOutcome>;
};

/**
 * "Elric in this room" as one switch in the Members panel. The room header has its own
 * (ElricHeaderSwitch); both follow the same membership.
 */
function ElricSwitchRow({ elric }: { elric: ElricRoomSwitch }) {
  const failure = useCallback(
    (next: boolean) =>
      next ? 'Elric couldn’t join this room. Try again.' : 'Elric couldn’t be removed. Try again.',
    [],
  );
  const toggle = useOptimisticSwitch(elric.on, elric.change, failure);
  return (
    <div className="rm-members-add-elric">
      <ElricSetupSwitch
        label="Elric in this room"
        step={elric.setup}
        onDob={elric.onDob}
        checked={toggle.shown}
        busy={toggle.busy}
        disabledReason={elric.disabledReason}
        onToggle={(next) => void toggle.set(next)}
      />
      <SwitchToast text={toggle.toast} onDismiss={toggle.dismiss} />
    </div>
  );
}

/**
 * §4.3: the Elric hint as a small centred pill above the composer (the AI notice, once per
 * person and room). "Ask Elric" starts a message to Elric; ✕ is remembered (localStorage).
 */
/**
 * In the owner's private chat with its agent, when the agent can't answer: one quiet line above the
 * composer and the way to fix it (its Auto-reply screen). It goes as soon as the agent can answer.
 */
function CantAnswerHint({ text, action, href }: { text: string; action: string; href: string }) {
  return (
    <div className="rm-ai-notice rm3-hint" role="status" data-testid="cant-answer">
      <span className="rm-ai-notice-text">{text}</span>
      <span className="rm3-hint-sep" aria-hidden="true">
        ·
      </span>
      <a
        className="rm3-hint-ask"
        href={href}
        onClick={(event) => {
          event.preventDefault();
          navigate(href);
        }}
      >
        {action}
      </a>
    </div>
  );
}

/**
 * Under your own @mention of one of your agents in a group room, when it can't answer yet: what is
 * wrong, how to make it answer (and that it can be switched off again), the links into the
 * agent's own screens, and that only you see it.
 */
function MentionCantAnswer({ text, actions }: MentionCantAnswerLine) {
  return (
    <div className="rm3-mention-hint" role="status" data-testid="mention-cant-answer">
      <span className="rm3-mention-hint-text">{text}</span>
      <span className="rm3-mention-hint-actions">
        {actions.map((action, index) => (
          <Fragment key={action.label}>
            {index ? <span aria-hidden="true">·</span> : null}
            <a
              href={action.href}
              onClick={(event) => {
                event.preventDefault();
                navigate(action.href);
              }}
            >
              {action.label}
            </a>
          </Fragment>
        ))}
      </span>
      <span className="rm3-mention-hint-only">Only you see this.</span>
    </div>
  );
}

function ElricHint({ onAsk, onDismiss }: { onAsk: (() => void) | null; onDismiss: () => void }) {
  return (
    <div
      className="rm-ai-notice rm3-hint"
      role="region"
      aria-label="AI notice"
      data-testid="elric-ai-notice"
    >
      <Avatar name="Elric" kind="elric" size="xs" />
      <span className="rm-ai-notice-text">{ELRIC_ROOM_HINT}</span>
      <span className="rm3-hint-sep" aria-hidden="true">
        ·
      </span>
      {onAsk ? (
        <button type="button" className="rm3-hint-ask" onClick={onAsk}>
          Ask Elric
        </button>
      ) : (
        <a className="rm3-hint-ask" href="/elric">
          Ask Elric
        </a>
      )}
      <button
        type="button"
        className="rm-notice-dismiss rm3-hint-close"
        onClick={onDismiss}
        aria-label="Dismiss notice"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

type MenuItem = {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  /** Destructive (end or delete): shown in the danger colour. */
  danger?: boolean;
};

/** The top bar's "…" menu: a small popup menu (Escape and outside clicks close it). */
function MoreMenu({ items, warm }: { items: MenuItem[]; warm?: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    // Opening the menu is the hint that one of its actions is next: warm what they lazy-load.
    warm?.();
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
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
  }, [open, warm]);
  return (
    <div className="rm-more" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="rm3-chip rm3-round"
        aria-label="More room actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Ellipsis size={18} aria-hidden="true" />
      </button>
      {open ? (
        <div className="rm-more-menu" role="menu" aria-label="More room actions">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-danger={item.danger || undefined}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One room as a chat: header, newest-first history with scroll-up paging,
 * polled merges by id (no remount), pending sends with Retry, and the composer.
 */
/** What a failed "Join as yourself" says: the server's reason in plain words, never its code. */
function joinSelfFailure(err: unknown): string {
  const code = err instanceof ApiError ? err.code : undefined;
  if (code === 'room_closed') return 'This room is closed.';
  if (code === 'room_full')
    return 'The room is full. Raise its member limit in Room settings first.';
  if (code === 'name_reserved') return 'Someone in this room already uses your name.';
  if (err instanceof ApiError && err.status === 429)
    return 'Too many tries. Wait a moment, then try again.';
  if (err instanceof RoomsError && (err.code === 'removed' || err.code === 'deleted'))
    return describe(err);
  return "Couldn't join as yourself. Try again.";
}

/** What a failed "Delete chat" (the private chat with your own agent) says, in plain words. */
function deleteChatFailure(err: unknown): string {
  if (err instanceof RoomsError && err.code === 'access_denied')
    return "This chat isn't yours, or it's already gone.";
  if (err instanceof ApiError && err.code === 'confirm_name_mismatch')
    return "The chat's name changed. Reload the page, then try again.";
  if (err instanceof ApiError && err.status === 429)
    return 'Too many tries just now. Wait a while, then try again.';
  // A timeout or an ended session: the rooms' shared copy says what to do.
  if (err instanceof RoomsError || (err instanceof ApiError && err.status === 401))
    return describe(err);
  return "Couldn't delete the chat. Try again.";
}

export function RoomView({
  client,
  room: initial,
  draft,
  onDraft,
  onOpenMenu,
  menuLabel = 'Open menu',
  onRoomChanged,
  onRead,
  userId,
  readMark,
  v2 = false,
}: {
  client: RoomsClient;
  room: Room;
  draft: string;
  onDraft: (text: string) => void;
  /**
   * Opens the rooms drawer on a phone. Left out inside the workspace shell, whose own menu button
   * (with Rooms inside it) is the only one: the room header then draws no menu button.
   */
  onOpenMenu?: () => void;
  /** The ☰ chip's name ("Open navigation" for the workspace shell's drawer). */
  menuLabel?: string;
  onRoomChanged: () => void;
  /** The newest seq shown, for unread counts. */
  onRead: (roomId: string, seq: number) => void;
  userId?: string;
  /** Smart Rooms v2 preview: this device's read mark for the room, for the "New since" divider. */
  readMark?: number;
  /** Smart Rooms v2 preview (roomsV2.ts): the v2 header and the Active-now panel. */
  v2?: boolean;
}) {
  // Smart Rooms v2 preview (roomsV2.ts): the paged, searchable Members panel (MembersV2.tsx).
  const roomsV2 = useRoomsV2();
  // Taken when the room opens: opening the room moves the mark (onRead) right away.
  const [openedMark] = useState(readMark);
  const thread = useRoomThread(client, initial.id, initial.latest_seq);
  const room = thread.room ?? initial;
  const [notificationsMuted, setNotificationsMuted] = useState(
    () => initial.notificationsMuted === true,
  );
  useEffect(() => {
    if (room.notificationsMuted !== undefined) {
      setNotificationsMuted(room.notificationsMuted === true);
    }
  }, [room.notificationsMuted]);
  const [notificationError, setNotificationError] = useState('');

  async function toggleNotificationsMute() {
    const next = !notificationsMuted;
    setNotificationsMuted(next);
    setNotificationError('');
    try {
      await withRoomDeadline(client.muteNotifications({ room_id: initial.id, muted: next }));
      onRoomChanged();
    } catch {
      setNotificationsMuted(!next);
      setNotificationError("Couldn't change notifications. Try again.");
    }
  }
  const [members, setMembers] = useState<Member[]>([]);
  // One side panel at a time: members, room settings, the room's tasks, its code or search
  // (in the v2 preview the Members panel also shows who is active now).
  const [panel, setPanel] = useState<'members' | 'settings' | 'tasks' | 'code' | 'search' | null>(
    null,
  );
  // Under 640 px the top bar is two rows: the pill with ⋯, then a strip of chips (§4.1).
  const compactBar = useMediaQuery(COMPACT_BAR_QUERY);
  // A search result to show in the thread (key changes on every jump).
  const [focus, setFocus] = useState<{ id: string; key: number } | null>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  // The room pill opens Members; closing the panel brings focus back to it.
  const pillButton = useRef<HTMLButtonElement>(null);
  const closeMembers = () => {
    setPanel(null);
    pillButton.current?.focus();
  };
  // "Pin list" in the ⋯ menu hides or shows the pins row under the top bar.
  const [pinsHidden, setPinsHidden] = useState(false);
  const tasks = useRoomTasks(initial.id, panel === 'tasks' || (v2 && panel === 'members'));
  const repo = useRoomRepo(initial.id);
  // A task line arriving (created, claimed, accepted…) refreshes the tasks, so the status pills
  // under messages follow the work without opening the Tasks panel.
  const lastTaskLine = useMemo(() => {
    for (let index = thread.messages.length - 1; index >= 0; index--)
      if (isTaskLine(thread.messages[index]!)) return thread.messages[index]!.seq;
    return 0;
  }, [thread.messages]);
  // Null until the thread first loads: the lines already there were read with the task list.
  const seenTaskLine = useRef<number | null>(null);
  const refreshTasks = tasks.refresh;
  useEffect(() => {
    if (!thread.ready) return;
    const seen = seenTaskLine.current;
    seenTaskLine.current = Math.max(seen ?? 0, lastTaskLine);
    if (seen !== null && lastTaskLine > seen) void refreshTasks();
  }, [thread.ready, lastTaskLine, refreshTasks]);
  // Smart Rooms v2 preview (the v2 prop): context pins (a row under the header, Pin in message and task menus).
  const roomPins = useRoomPins(initial.id, v2);
  const [openTask, setOpenTask] = useState<{ id: string; key: number } | null>(null);
  const [pinError, setPinError] = useState('');
  // The shell's "Invite your AI" lands here with history.state.invite: open the sheet once,
  // as soon as the room is known to be an open room this viewer hosts.
  const [invite, setInvite] = useState(false);
  const [connect, setConnect] = useState(false);
  const [addAi, setAddAi] = useState(false);
  // "Add my AI": a person member adds one of their own AIs (no invite link needed).
  const [addMyAi, setAddMyAi] = useState(false);
  // "Add a task" from the composer opens the Tasks panel with its form.
  const [taskForm, setTaskForm] = useState(0);
  const wantInvite = useRef((window.history.state as { invite?: boolean } | null)?.invite === true);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [follow, setFollow] = useState(0);
  const online = useOnline();

  // Elric state
  const [elricStatus, setElricStatus] = useState<ElricStatus | null>(null);
  const [addElricDismissed, setAddElricDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(`cc_dismiss_add_elric_${initial.id}`) === '1';
    } catch {
      return false;
    }
  });
  const [addingElric, setAddingElric] = useState<boolean>(false);
  const [addElricError, setAddElricError] = useState<string | null>(null);
  const [elricWaking, setElricWaking] = useState<boolean>(false);
  const [elricWakingSeq, setElricWakingSeq] = useState<number | null>(null);
  // The answer forming for the viewer's own @Elric post (streamed drafts), and when it started.
  const [elricDraft, setElricDraft] = useState<{
    text: string;
    since: number;
    after: number;
  } | null>(null);
  const [elricNotice, setElricNotice] = useState<ElricNotice | null>(null);
  const noticeKey = `cc_elric_ai_notice_${userId ? `${userId}_` : ''}${initial.id}`;
  const [aiNoticeDismissed, setAiNoticeDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(noticeKey) === '1';
    } catch {
      return false;
    }
  });

  // Connect AI and Add an AI are one click away (and "Add an AI" has no menu to warm from):
  // fetch their chunks once the browser is idle, so the first open draws at once.
  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warmRoomSheets, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warmRoomSheets, 1500);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    try {
      setAiNoticeDismissed(localStorage.getItem(noticeKey) === '1');
    } catch {
      setAiNoticeDismissed(false);
    }
  }, [noticeKey]);

  function handleDismissAiNotice() {
    setAiNoticeDismissed(true);
    try {
      localStorage.setItem(noticeKey, '1');
    } catch {}
  }
  const [showDobDialog, setShowDobDialog] = useState<boolean>(false);
  const [ageRefusal, setAgeRefusal] = useState<ElricAgeReason | null>(null);

  useEffect(() => {
    let active = true;
    void getElricStatus().then((status) => {
      if (!active) return;
      setElricStatus(status);
    });
    return () => {
      active = false;
    };
  }, []);

  // The owner's private chat with one of its agents: say when that agent can't answer yet.
  const privateAgent = room.privateAgentId ?? null;
  // The owner's private chat with one of its agents: just the two of them. Nothing that would
  // share, open or end it is offered (the server refuses all of it: 409 room_private).
  const privateName = privateAgent
    ? (members.find((member) => member.id === privateAgent)?.name ?? room.name)
    : null;
  const answering = useAgentAnswering(privateAgent);
  const cantAnswer = privateName ? cantAnswerLine(privateName, answering) : null;
  // A group room: under your own newest @mention of one of your agents, say when it can't answer
  // yet. Only your agents are asked about; other members never see the line.
  const mentionTargets = useMemo(
    () =>
      privateAgent ? new Map<string, Member[]>() : ownMentionTargets(thread.messages, members),
    [privateAgent, thread.messages, members],
  );
  const mentionAnswers = useAgentsAnswering(
    [...mentionTargets.values()].flat().map((agent) => agent.id),
  );
  const mentionNote = (message: RoomMessage) => {
    const lines = (mentionTargets.get(message.id) ?? []).flatMap((agent) => {
      const line = mentionCantAnswerLine(agent.name, agent.id, mentionAnswers.get(agent.id));
      return line ? [{ ...line, id: agent.id }] : [];
    });
    return lines.length ? lines.map((line) => <MentionCantAnswer key={line.id} {...line} />) : null;
  };
  // "Delete chat" (⋯, the owner's private chat with its own agent only): one plain confirm under
  // the top bar, then the chat is gone for good. The server releases the one chat per agent, so
  // "Message <agent>" opens a new, empty one afterwards.
  const [deleteChat, setDeleteChat] = useState<'confirm' | 'busy' | null>(null);
  const [deleteChatError, setDeleteChatError] = useState('');
  function cancelDeleteChat() {
    setDeleteChat(null);
    setDeleteChatError('');
    // Back to ⋯, where the action started.
    sectionRef.current?.querySelector<HTMLElement>('.rm-more > button')?.focus();
  }
  async function removeChat() {
    if (!privateAgent || deleteChat === 'busy') return;
    setDeleteChat('busy');
    setDeleteChatError('');
    try {
      // The server checks the chat's exact current name, as Room settings' Delete does.
      await withRoomDeadline(client.deleteRoom({ room_id: room.id, confirm_name: room.name }));
    } catch (err) {
      // Already deleted (another tab, another device): leave as if this delete went through.
      if (!(err instanceof RoomsError && err.code === 'deleted')) {
        setDeleteChatError(deleteChatFailure(err));
        setDeleteChat('confirm');
        return;
      }
    }
    // The agent's page in My agents, with the room's page replaced, so Back never lands on the
    // deleted chat.
    noteForNextPage('Chat deleted.');
    onRoomChanged();
    navigate(`/agents#agent=${encodeURIComponent(privateAgent)}`, true);
  }
  const isElricMember = useMemo(
    () =>
      members.some(
        (m) =>
          m.auto_reply?.provider === 'elric' ||
          (elricStatus?.agent_id && m.id === elricStatus.agent_id),
      ),
    [members, elricStatus?.agent_id],
  );

  const host = room.role === 'host';
  // Smart Rooms v2 preview: cached counts, the host's Needs-you queue, the compact phone header.
  const overview = useRoomOverview(initial.id, v2, room.member_count);
  const needsYou = useNeedsYou(
    initial.id,
    v2 && host && !room.closed,
    `${room.member_count}:${panel}`,
  );
  // A Needs-you mention: once the jump has loaded that message, show it like a search result.
  const [jumpSeq, setJumpSeq] = useState<number | null>(null);
  // A task the catch-up cited (T<n>): the Tasks panel opens on it.
  const [openTaskNumber, setOpenTaskNumber] = useState<{ number: number; key: number } | null>(
    null,
  );
  useEffect(() => {
    if (jumpSeq === null) return;
    const message = thread.messages.find((item) => item.seq === jumpSeq);
    if (!message) return;
    setFocus({ id: message.id, key: Date.now() });
    setJumpSeq(null);
  }, [jumpSeq, thread.messages]);
  // Add Elric shows for a verified adult and also when only the date of birth is missing
  // ('age_unknown': the click asks for it once). Never under 18 or without Google sign-in.
  const elricAddable = Boolean(
    elricStatus?.eligible || elricStatus?.eligibility_reason === 'age_unknown',
  );
  const canAddElric = Boolean(host && !isElricMember && elricAddable && !room.closed);

  const showAddElric = Boolean(
    canAddElric && room.respondersAllowed !== false && !addElricDismissed,
  );

  function handleClickAddElric() {
    setAddElricError(null);
    setAddElricDismissed(false);
    try {
      sessionStorage.removeItem(`cc_dismiss_add_elric_${initial.id}`);
    } catch {}
    if (elricStatus?.over_18) {
      void handleAddElric();
    } else {
      setShowDobDialog(true);
    }
  }

  async function handleDobSubmit(dob: string) {
    await handleAddElric(dob);
  }

  async function handleAddElric(dob?: string) {
    setAddingElric(true);
    setAddElricError(null);
    try {
      const { agent_id } = await addElricToRoom(client, initial.id, dob);
      setShowDobDialog(false);
      // Elric now exists for this account: the header shows the switch from here on.
      setElricStatus((prev) =>
        prev ? { ...prev, agent_id, over_18: dob ? true : prev.over_18 } : prev,
      );
      await loadMembers();
      onRoomChanged();
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'elric_age_under_18') {
        setShowDobDialog(false);
        setAgeRefusal('under_18');
      } else if (code === 'elric_age_unknown') {
        setShowDobDialog(false);
        setAgeRefusal('unknown');
      } else if (code === 'invalid_date_of_birth') {
        setAddElricError('Please enter a valid date of birth.');
      } else {
        setAddElricError(describe(err) || 'Could not add Elric to room.');
      }
    } finally {
      setAddingElric(false);
    }
  }

  // The Members panel switch. On: add (the first time asks the date of birth once, then the
  // members refresh flips it). Off: remove Elric without blocking it from being added again.
  const elricMember = members.find(
    (m) =>
      m.auto_reply?.provider === 'elric' ||
      (elricStatus?.agent_id && m.id === elricStatus.agent_id),
  );
  // A host with one step missing: the switch stays usable and opens that step (Link Google, or
  // the date of birth). Members who aren't the host keep the host-only reason below.
  const elricSetup: ElricSetupStep | null =
    elricStatus && host && !room.closed && !elricMember
      ? elricStatus.eligibility_reason === 'unverified'
        ? 'google'
        : elricStatus.eligibility_reason === 'age_unknown' && !elricStatus.over_18
          ? 'dob'
          : null
      : null;
  async function addElricWithDob(dob: string): Promise<ElricDobOutcome> {
    setAddingElric(true);
    try {
      const { agent_id } = await addElricToRoom(client, initial.id, dob);
      setElricStatus((prev) => (prev ? { ...prev, agent_id, over_18: true } : prev));
      await loadMembers();
      onRoomChanged();
      return null;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'invalid_date_of_birth') return { error: 'Please enter a valid date of birth.' };
      if (code === 'elric_age_under_18' || code === 'elric_age_unknown') {
        // The popover closes first (focus back on the switch), then the age dialog opens.
        const reason: ElricAgeReason = code === 'elric_age_under_18' ? 'under_18' : 'unknown';
        window.setTimeout(() => setAgeRefusal(reason), 0);
        return 'closed';
      }
      return { error: describe(err) || 'Could not add Elric to room.' };
    } finally {
      setAddingElric(false);
    }
  }
  const elricSwitch: ElricRoomSwitch | null = elricStatus
    ? {
        on: Boolean(elricMember),
        setup: elricSetup,
        onDob: addElricWithDob,
        disabledReason: room.closed
          ? 'This room is closed.'
          : !host
            ? 'Only the room’s host can add or remove Elric.'
            : elricSetup
              ? null
              : !elricMember && !elricAddable
                ? elricStatus.eligibility_reason === 'age_under_18'
                  ? 'Elric is available from age 18.'
                  : 'Elric isn’t available for your account.'
                : null,
        change: async (next) => {
          if (next) {
            if (!elricStatus.over_18) {
              // The date-of-birth sheet takes over; the switch follows the membership.
              handleClickAddElric();
              throw Object.assign(new Error('dob'), { silent: true });
            }
            const { agent_id } = await addElricToRoom(client, initial.id);
            setElricStatus((prev) => (prev ? { ...prev, agent_id } : prev));
          } else {
            // Off acts on the server's membership, not on this render's (possibly stale) list:
            // a missing Elric here must never turn into a silent no-op while Elric stays in.
            const current = await withRoomDeadline(client.members({ room_id: initial.id }));
            const inRoom = current.find(
              (m) =>
                m.auto_reply?.provider === 'elric' ||
                (elricStatus.agent_id && m.id === elricStatus.agent_id),
            );
            if (inRoom) {
              await withRoomDeadline(
                client.remove({ room_id: initial.id, agent_id: inRoom.id, block_rejoin: false }),
              );
            }
          }
          onRoomChanged();
          // The switch only settles on what the server confirms; otherwise it rolls back. A read
          // that started before the change can answer late, so a mismatch is read once more.
          const has = (list: Member[] | undefined) =>
            list?.some(
              (m) =>
                m.auto_reply?.provider === 'elric' ||
                (elricStatus.agent_id && m.id === elricStatus.agent_id),
            );
          let after = await loadMembers();
          if (!after || Boolean(has(after)) !== next) after = await loadMembers();
          // No answer is not a confirmation: roll back with the error.
          if (!after) throw new Error('Elric membership could not be confirmed');
          if (Boolean(has(after)) !== next) {
            throw new Error(next ? 'Elric did not join' : 'Elric is still in the room');
          }
        },
      }
    : null;

  function handleDismissAddElric() {
    setAddElricDismissed(true);
    try {
      sessionStorage.setItem(`cc_dismiss_add_elric_${initial.id}`, '1');
    } catch {}
  }
  const own = members.filter((member) => member.own && member.auto_reply?.provider !== 'elric');
  // A person in the room (Join a room): who invited them, and how to bring their own AI.
  const personSelf = own.find((member) => member.kind === 'person');
  const hostMember = members.find((member) => member.role === 'host');
  // After your agents left: once the refreshed rooms list drops this room (it unmounts), open
  // /rooms. If the list does not refresh, the room just shows that access ended.
  const left = useRef(false);
  useEffect(
    () => () => {
      if (!left.current) return;
      window.history.pushState(null, '', '/rooms');
      window.dispatchEvent(new PopStateEvent('popstate'));
    },
    [],
  );
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const [membersLoaded, setMembersLoaded] = useState(false);
  // Member loads overlap (a change, the room-list refresh, realtime events): only the newest
  // request may set the list, so a slow older answer never brings back a member who left.
  const membersSeq = useRef(0);
  const loadMembers = useCallback(async () => {
    const seq = ++membersSeq.current;
    try {
      const list = await withRoomDeadline(client.members({ room_id: initial.id }));
      if (seq !== membersSeq.current) return list;
      setMembers(list);
      setMembersLoaded(true);
      return list;
    } catch {
      // The thread reports access problems; members are refreshed on the next change.
    }
  }, [client, initial.id]);
  useEffect(() => {
    void loadMembers();
  }, [loadMembers, room.member_count]);
  // Operation Agency A: you host this room through one of your agents but are not in it as a
  // person. "Join as yourself" adds you as yourself, so you write here as yourself. Only the
  // server's room.person decides (null: you could join as yourself); without it (an AI workspace,
  // an older server) the button never shows.
  const canJoinAsSelf = room.role === 'host' && room.person === null && !room.closed;
  const [joiningSelf, setJoiningSelf] = useState(false);
  const [joinSelfError, setJoinSelfError] = useState('');
  async function joinAsSelf() {
    setJoiningSelf(true);
    setJoinSelfError('');
    try {
      // The server keeps it idempotent: a retry after a lost answer finds you already in.
      await withRoomDeadline(client.joinAsSelf({ room_id: initial.id }));
      // The refreshed room and members hold your person member: the button goes, the composer
      // follows.
      await loadMembers();
      onRoomChanged();
    } catch (err) {
      setJoinSelfError(joinSelfFailure(err));
    } finally {
      setJoiningSelf(false);
    }
  }
  // v2: while the Members panel is open its Active-now list stays current (like the overview
  // poll), so the list never shows a stale snapshot and the badge can count the list itself.
  const membersOpen = v2 && panel === 'members';
  useEffect(() => {
    if (!membersOpen) return;
    const timer = window.setInterval(() => void loadMembers(), MEMBERS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [membersOpen, loadMembers]);
  // A refresh can bring back a post whose response was lost: the server copy (an own message
  // with the same text and sender, posted after the pending one was created) replaces it, so there
  // is no double entry and no stale "Not sent". Retry would replay the same idempotency key anyway.
  useEffect(() => {
    if (!pendingRef.current.length) return;
    const claimed = new Set<string>();
    const delivered = new Set<string>();
    for (const item of pendingRef.current) {
      const copy = thread.messages.find(
        (message) =>
          message.own &&
          !claimed.has(message.id) &&
          message.seq > item.afterSeq &&
          message.text === item.text &&
          (!item.agentId || message.sender_agent_id === item.agentId),
      );
      if (copy) {
        claimed.add(copy.id);
        delivered.add(item.key);
      }
    }
    if (delivered.size) setPending((list) => list.filter((entry) => !delivered.has(entry.key)));
  }, [thread.messages]);
  const newest = thread.messages.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (newest) onRead(initial.id, newest);
  }, [initial.id, newest, onRead]);

  async function deliver(item: PendingMessage) {
    const mentionsElric = /@elric\b/i.test(item.text);
    const canInvokeElric = isElricMember && room.respondersAllowed !== false;
    if (mentionsElric && canInvokeElric) {
      setElricWaking(true);
    }
    try {
      const message = await withRoomDeadline(
        client.post({
          room_id: initial.id,
          text: item.text,
          idempotency_key: item.key,
          ...(item.agentId ? { agent_id: item.agentId } : {}),
        }),
      );
      thread.merge([message]);
      setPending((list) => list.filter((entry) => entry.key !== item.key));
      if (mentionsElric && canInvokeElric) {
        setElricWakingSeq(message.seq);
      }
      if (message.elric_notice) {
        setElricNotice(message.elric_notice);
        setElricWaking(false);
        setElricWakingSeq(null);
      }
    } catch (err) {
      if (mentionsElric && canInvokeElric) {
        setElricWaking(false);
        setElricWakingSeq(null);
      }
      setPending((list) =>
        list.map((entry) => (entry.key === item.key ? { ...entry, failed: describe(err) } : entry)),
      );
    }
  }
  function send(text: string, agentId?: string) {
    // Without an agent you write as yourself: the pending line shows your own name, never an agent.
    const sender =
      (agentId
        ? own.find((member) => member.id === agentId)?.name
        : (room.person?.name ?? personSelf?.name ?? own[0]?.name)) ?? 'You';
    // One key per message, kept for every Retry so a retry cannot duplicate it.
    const item: PendingMessage = {
      key: crypto.randomUUID(),
      text,
      agentId,
      sender,
      afterSeq: thread.messages.at(-1)?.seq ?? 0,
    };
    setPending((list) => [...list, item]);
    setFollow((value) => value + 1);
    void deliver(item);
  }
  function retry(key: string) {
    const item = pendingRef.current.find((entry) => entry.key === key);
    if (!item) return;
    const next = { ...item, failed: undefined };
    setPending((list) => list.map((entry) => (entry.key === key ? next : entry)));
    void deliver(next);
  }

  /**
   * Reply (a message's action row) and "Ask Elric": the name as a mention at the start of the
   * draft (once), then the caret at the end of the composer.
   */
  function mentionInComposer(name: string) {
    const tag = `@${name} `;
    onDraft(draft.startsWith(tag) ? draft : `${tag}${draft}`);
    requestAnimationFrame(() => {
      const box = sectionRef.current?.querySelector<HTMLTextAreaElement>('.rm-composer textarea');
      if (!box) return;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
  }

  // Elric answered the viewer's post: only a reply AFTER that post counts (an earlier Elric
  // message in the thread must not end the wait before the post is even delivered). This also
  // ends the streamed draft (elricWakingSeq back to null).
  useEffect(() => {
    if (elricWakingSeq === null) return;
    const repliesAfter = thread.messages.filter((m) => m.seq > elricWakingSeq);
    const fromElric = (m: (typeof repliesAfter)[number]) =>
      m.auto_reply?.provider === 'elric' ||
      Boolean(elricStatus?.agent_id && m.sender_agent_id === elricStatus.agent_id) ||
      members.some(
        (member) => member.id === m.sender_agent_id && member.auto_reply?.provider === 'elric',
      );
    // Elric's reply names the post it answers: a reply to someone else does not end the wait.
    const hasElricReply = repliesAfter.some(
      (m) => fromElric(m) && (m.auto_reply?.provider !== 'elric' || answersPost(m, elricWakingSeq)),
    );
    if (hasElricReply) {
      setElricWaking(false);
      setElricWakingSeq(null);
    }
  }, [thread.messages, elricWakingSeq, elricStatus?.agent_id, members]);

  // Streamed answers: after the viewer's own @Elric post, read the forming answer every 500 ms
  // (up to 60 s). It shows in Elric's place in the thread, revealed smoothly; when the draft goes
  // away the room is read at once and the posted message takes its place (the draft stays until
  // then, so there is no gap).
  useEffect(() => {
    if (elricWakingSeq === null) {
      setElricDraft(null);
      return;
    }
    const since = Date.now();
    setElricDraft({ text: '', since, after: elricWakingSeq });
    let live = true;
    let seen = false;
    let timer = 0;
    const tick = async () => {
      if (!live) return;
      try {
        const { drafts } = await api<{ drafts: { source_seq: number; text: string }[] }>(
          `/api/rooms/${encodeURIComponent(initial.id)}/elric-drafts`,
          undefined,
          'GET',
        );
        if (!live) return;
        const mine = drafts.find((item) => item.source_seq === elricWakingSeq);
        if (mine) {
          seen = true;
          setElricDraft({ text: mine.text, since, after: elricWakingSeq });
        } else if (seen) {
          await Promise.resolve(thread.refresh()).catch(() => undefined);
          if (live) setElricDraft(null);
          return;
        }
      } catch {
        // Drafts are a preview; the posted message still arrives through the room's updates.
      }
      if (live && Date.now() - since < 60_000) timer = window.setTimeout(tick, 500);
      else if (live) setElricDraft(null);
    };
    timer = window.setTimeout(tick, 500);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [elricWakingSeq, initial.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!elricWaking) return;
    const timer = setTimeout(() => {
      setElricWaking(false);
      setElricWakingSeq(null);
    }, 60_000); // The 55 s run budget plus delivery (the streamed draft keeps it company).
    return () => clearTimeout(timer);
  }, [elricWaking]);

  useEffect(() => {
    if (!wantInvite.current || !room.name) return;
    wantInvite.current = false;
    window.history.replaceState({ ...(window.history.state ?? {}), invite: false }, '');
    if (room.role === 'host' && !room.closed) setInvite(true);
  }, [room.name, room.role, room.closed]);

  const canPost = thread.ready && !room.closed && !room.readOnly && !thread.denied;

  const sectionRef = useRef<HTMLElement>(null);
  // "Who should join?" (src/rooms/WhoJoins.tsx): the host's, while nobody else is in the room,
  // until hidden for this room. More room actions brings it back.
  const suggestKey = suggestionsHiddenKey(initial.id);
  const [suggestHidden, setSuggestHidden] = useState(() => readSuggestionsHidden(suggestKey));
  const whoJoinsFor = (hidden: boolean) =>
    !privateAgent &&
    showWhoJoins({
      host,
      closed: Boolean(room.closed),
      denied: Boolean(thread.denied),
      hidden,
      membersLoaded,
      members,
    });
  const canShowWhoJoins = suggestHidden && whoJoinsFor(false);
  function setWhoJoinsHidden(hidden: boolean) {
    setSuggestHidden(hidden);
    writeSuggestionsHidden(suggestKey, hidden);
  }
  const suggestions = whoJoinsFor(suggestHidden) ? (
    <WhoJoinsCard
      onAi={() => setAddAi(true)}
      onPerson={() => setInvite(true)}
      onHide={() => setWhoJoinsHidden(true)}
    />
  ) : null;
  // Context pins (v2 only): who pins, pin, unpin, and where a chip leads.
  const pinAs = v2 ? pinningMember(room, members) : undefined;
  async function pin(target: { messageSeq?: number; taskId?: string }) {
    setPinError('');
    try {
      const made = await addPin({ roomId: initial.id, agentId: pinAs?.id, ...target });
      roomPins.setPins((list) => [...(list ?? []).filter((item) => item.id !== made.id), made]);
    } catch (err) {
      setPinError(err instanceof Error ? err.message : "Couldn't pin that. Try again.");
    }
  }
  async function unpin(target: RoomPin) {
    setPinError('');
    try {
      await removePin(initial.id, target.id, pinAs?.id);
      roomPins.setPins((list) => (list ?? []).filter((item) => item.id !== target.id));
    } catch (err) {
      setPinError(err instanceof Error ? err.message : "Couldn't unpin that. Try again.");
    }
  }
  function openPin(target: RoomPin) {
    if (target.message) {
      setFocus({ id: target.message.id, key: Date.now() });
      void thread.jumpTo(target.message.seq);
    } else if (target.task) {
      setOpenTask({ id: target.task.id, key: Date.now() });
      setPanel('tasks');
    }
  }
  const counts = headerCounts({
    overview,
    memberCount: room.member_count,
    members: membersLoaded ? members : null,
    tasks: tasks.available ? tasks.tasks : null,
    // One page holds every member (no revoked agents skipped): the list is the whole room.
    listCurrent: membersOpen && membersLoaded && members.length >= room.member_count,
  });
  const openTaskSheet = () => {
    setTaskForm(0);
    setPanel('tasks');
  };
  const togglePanel = (next: 'members' | 'tasks' | 'search') =>
    setPanel((value) => (value === next ? null : next));
  const showElricSwitch = Boolean(
    elricSwitch &&
    showHeaderElricSwitch({ host, eligibilityReason: elricStatus?.eligibility_reason }),
  );
  const taskCount = tasks.tasks ? activeCount(tasks.tasks) : 0;
  const memberTotal = counts?.members ?? room.member_count;
  const pinCount = roomPins.pins?.length ?? 0;
  // "Invite your AI": a person member brings one of their own AIs; everyone else connects one.
  const bringOwnAi = Boolean(personSelf && !host && room.membersMayBringAi !== false);
  const moreItems: MenuItem[] = [
    ...(canShowWhoJoins
      ? [
          {
            key: 'who-joins',
            label: 'Show Who should join?',
            icon: <UserPlus size={16} aria-hidden="true" />,
            onSelect: () => setWhoJoinsHidden(false),
          },
        ]
      : []),
    ...(privateAgent
      ? []
      : [
          {
            key: 'settings',
            label: 'Room settings',
            icon: <Settings2 size={16} aria-hidden="true" />,
            onSelect: () => setPanel('settings'),
          },
        ]),
    ...(room.closed || privateAgent
      ? []
      : bringOwnAi
        ? [
            {
              key: 'add-my-ai',
              label: 'Invite your AI',
              icon: <Plug size={16} aria-hidden="true" />,
              onSelect: () => setAddMyAi(true),
            },
          ]
        : [
            {
              key: 'connect',
              label: 'Connect AI',
              icon: <Plug size={16} aria-hidden="true" />,
              onSelect: () => setConnect(true),
            },
          ]),
    ...(pinCount
      ? [
          {
            key: 'pins',
            label: pinsHidden ? `Show pin list (${pinCount})` : 'Hide pin list',
            icon: <Pin size={16} aria-hidden="true" />,
            onSelect: () => setPinsHidden((value) => !value),
          },
        ]
      : []),
    // Only when the server offers room repositories (the route answers 404 otherwise).
    ...(repo.available
      ? [
          {
            key: 'code',
            label: repo.state?.binding ? `Code, connected to ${repo.state.binding.repo}` : 'Code',
            icon: <Code2 size={16} aria-hidden="true" />,
            onSelect: () => setPanel('code'),
          },
        ]
      : []),
    {
      key: 'notifications',
      label: notificationsMuted ? 'Unmute this room' : 'Mute this room',
      icon: notificationsMuted ? (
        <Bell size={16} aria-hidden="true" />
      ) : (
        <BellOff size={16} aria-hidden="true" />
      ),
      onSelect: () => void toggleNotificationsMute(),
    },
    // The host ends or deletes the room in Room settings (typed confirmation there).
    ...(host && !room.closed && !privateAgent
      ? [
          {
            key: 'end',
            label: 'End or delete room',
            icon: <CircleStop size={16} aria-hidden="true" />,
            onSelect: () => setPanel('settings'),
            danger: true,
          },
        ]
      : []),
    // Only its owner hosts a private agent chat; an Elric chat or a group room has no
    // privateAgentId.
    ...(host && privateAgent
      ? [
          {
            key: 'delete-chat',
            label: 'Delete chat',
            icon: <Trash2 size={16} aria-hidden="true" />,
            onSelect: () => {
              setDeleteChatError('');
              setDeleteChat('confirm');
            },
            danger: true,
          },
        ]
      : []),
  ];
  // One colour per member for every room surface (messages, Members, tasks, the top bar), so the
  // same member always matches and two members never share one (src/shell/avatarColor.ts).
  const avatarColours = useAvatarColors(roomAvatarEntries(members, thread.messages));
  const view = (
    <section className="rm-room rm3" aria-label={room.name} ref={sectionRef}>
      {/* §4.1: one centred row of floating pills and chips that wraps when narrow. Under 640 px
          two rows: the pill and ⋯, then one sideways-scrolling strip of chips, Invite last. */}
      <header className="rm-room-head rm3-topbar" data-compact={compactBar || undefined}>
        {onOpenMenu ? (
          <button
            type="button"
            className="rm3-chip rm3-round rm-menu"
            aria-label={menuLabel}
            onClick={onOpenMenu}
          >
            <Menu size={18} aria-hidden="true" />
          </button>
        ) : null}
        <RoomPill
          name={room.name}
          members={members}
          memberCount={memberTotal}
          aisActive={counts ? counts.aisActive : null}
          summary={counts ? metaLine(counts) : null}
          avatars={compactBar ? PILL_AVATARS_COMPACT : PILL_AVATARS}
          open={panel === 'members'}
          onOpen={() => togglePanel('members')}
          buttonRef={pillButton}
        />
        {/* Phones: ⋯ sits beside the pill in row 1, so the focus order follows the rows. */}
        {compactBar ? <MoreMenu items={moreItems} warm={warmRoomSheets} /> : null}
        <div className="rm-head-actions rm3-chips">
          {needsYou.state || needsYou.toast ? (
            <NeedsYouChip
              queue={needsYou}
              onOpenTask={openTaskSheet}
              onOpenMessage={(seq) => {
                setJumpSeq(seq);
                void thread.jumpTo(seq);
              }}
            />
          ) : null}
          {/* Only when the server offers room tasks (the list answers 404 otherwise). */}
          {tasks.available ? (
            <button
              type="button"
              className="rm3-chip rm-tasks-head"
              aria-label={`Tasks, ${taskCount} to do`}
              aria-expanded={panel === 'tasks'}
              data-testid="tasks-button"
              onClick={() => {
                setTaskForm(0);
                togglePanel('tasks');
              }}
            >
              <ListChecks className="rm3-chip-icon" size={16} aria-hidden="true" />
              <span className="rm3-chip-label">Tasks</span>
              {taskCount ? (
                <span className="rm-count rm3-n rm-task-count" aria-hidden="true">
                  {compactCount(taskCount)}
                </span>
              ) : null}
            </button>
          ) : null}
          {/* Elric on/off for the host (never for someone under 18): on adds at once, off removes at once. */}
          {elricSwitch && showElricSwitch ? (
            <ElricHeaderSwitch
              {...elricSwitch}
              // Never added (no Elric for this account yet): "+ Add Elric", which asks the
              // date of birth the first time. Otherwise the switch.
              onAdd={elricStatus?.agent_id ? null : handleClickAddElric}
              adding={addingElric}
            />
          ) : null}
          <button
            ref={searchButton}
            type="button"
            className="rm3-chip rm3-round rm-search-head"
            aria-label="Search this room"
            aria-expanded={panel === 'search'}
            data-testid="room-search-button"
            disabled={thread.denied}
            onClick={() => togglePanel('search')}
          >
            <Search size={17} aria-hidden="true" />
          </button>
          {compactBar ? null : <MoreMenu items={moreItems} warm={warmRoomSheets} />}
          {host && !room.closed && !privateAgent ? (
            <button
              type="button"
              className="rm3-invite rm-invite-head"
              onClick={() => setInvite(true)}
            >
              Invite
            </button>
          ) : null}
        </div>
      </header>
      {pinsHidden ? null : (
        <ContextPins
          pins={roomPins.pins}
          onOpen={openPin}
          onUnpin={(pin) => void unpin(pin)}
          canUnpin={(pin) => !room.closed && (pin.own || host)}
        />
      )}
      {v2 && pinError ? (
        <p className="rm-inline-error" role="alert">
          {pinError}
        </p>
      ) : null}
      {notificationError ? (
        <p className="rm-inline-error" role="alert">
          {notificationError}
        </p>
      ) : null}
      {deleteChat && privateName ? (
        <div className="rm3-delete-chat" data-testid="delete-chat">
          <ConfirmRow
            question={`Delete this chat with ${privateName}? Its messages are deleted for good.`}
            action="Delete chat"
            busy={deleteChat === 'busy'}
            onConfirm={() => void removeChat()}
            onCancel={cancelDeleteChat}
          />
          {deleteChatError ? (
            <p className="rm-inline-error" role="alert">
              {deleteChatError}
            </p>
          ) : null}
        </div>
      ) : null}
      {personSelf && !host ? (
        <p className="rm-banner rm-joined" role="status">
          <span>
            You joined as {personSelf.name}.{hostMember ? ` Invited by ${hostMember.name}.` : ''}
          </span>
          {room.membersMayBringAi !== false && !room.closed ? (
            <span>
              Want to bring your AI too?{' '}
              <button type="button" className="rm-link-button" onClick={() => setAddMyAi(true)}>
                Add my AI
              </button>
            </span>
          ) : null}
        </p>
      ) : null}
      {!online ? (
        <p className="rm-banner" role="status">
          You're offline. We'll reconnect automatically.
        </p>
      ) : null}
      <div className="rm-room-body">
        <div className="rm-thread">
          {thread.error ? (
            <div className="rm-inline-error" role="alert">
              <span>{thread.error}</span>
              {thread.denied ? null : (
                <button type="button" className="rm-quiet" onClick={() => void thread.refresh()}>
                  Retry
                </button>
              )}
            </div>
          ) : null}
          {!thread.ready && !thread.error ? (
            <div className="rm-skeletons" role="status" aria-label="Loading messages">
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <span key={index} className={index % 2 ? 'right' : ''} />
              ))}
            </div>
          ) : null}
          {thread.ready ? (
            thread.messages.length || pending.length ? (
              <MessageList
                messages={thread.messages}
                pending={pending}
                members={members}
                hasOlder={thread.hasOlder}
                loadingOlder={thread.loadingOlder}
                onOlder={thread.loadOlder}
                onRetry={retry}
                onDiscard={(key) => setPending((list) => list.filter((entry) => entry.key !== key))}
                onTrim={thread.trim}
                follow={follow}
                elricDraft={elricDraft}
                focus={focus}
                roomId={initial.id}
                onPin={pinAs ? (message) => void pin({ messageSeq: message.seq }) : undefined}
                onReply={canPost ? (name) => mentionInComposer(name) : undefined}
                tasks={tasks.available ? tasks.tasks : null}
                onOpenTask={(taskNumber) => {
                  setTaskForm(0);
                  setOpenTaskNumber({ number: taskNumber, key: Date.now() });
                  setPanel('tasks');
                }}
                newSinceMark={openedMark}
                newSinceSummary={
                  v2 && openedMark !== undefined ? (
                    <CatchUpSummary
                      roomId={initial.id}
                      afterSeq={openedMark}
                      latestSeq={thread.messages.at(-1)?.seq}
                      onMessage={(seq) => {
                        setJumpSeq(seq);
                        void thread.jumpTo(seq);
                      }}
                      onTask={(taskNumber) => {
                        setTaskForm(0);
                        setOpenTaskNumber({ number: taskNumber, key: Date.now() });
                        setPanel('tasks');
                      }}
                    />
                  ) : undefined
                }
                noteFor={mentionNote}
                directFor={(id) => {
                  const member = members.find((item) => item.id === id);
                  return member ? <DirectLink room={room} member={member} compact /> : null;
                }}
              >
                <p className="rm-notice">{NOTICE}</p>
                {suggestions}
              </MessageList>
            ) : (
              <div className="rm-empty">
                {privateName ? (
                  <>
                    <p className="rm-notice">
                      Only you and {privateName} are in this chat. Everything you write here goes to{' '}
                      {privateName}.
                    </p>
                    <h2>Say hello to {privateName}</h2>
                  </>
                ) : (
                  <>
                    <p className="rm-notice">{NOTICE}</p>
                    <h2>This room is quiet</h2>
                  </>
                )}
                {privateName ? null : suggestions ? (
                  suggestions
                ) : host && !room.closed ? (
                  <button type="button" className="rm-primary" onClick={() => setInvite(true)}>
                    Invite
                  </button>
                ) : null}
              </div>
            )
          ) : null}
          {cantAnswer && privateAgent ? (
            <div className="rm-elric-banner-wrap">
              <CantAnswerHint
                text={cantAnswer.text}
                action={cantAnswer.action}
                href={autoReplyHref(privateAgent)}
              />
            </div>
          ) : null}
          {elricWaking || elricNotice || (isElricMember && !aiNoticeDismissed) ? (
            <div className="rm-elric-banner-wrap">
              {isElricMember && !aiNoticeDismissed ? (
                <ElricHint
                  onAsk={canPost ? () => mentionInComposer('Elric') : null}
                  onDismiss={handleDismissAiNotice}
                />
              ) : null}
              {elricWaking ? <ElricWakingPill /> : null}
              {elricNotice ? (
                <ElricNoticeBanner notice={elricNotice} onDismiss={() => setElricNotice(null)} />
              ) : null}
            </div>
          ) : null}
          {showAddElric ? (
            <AddElricCard
              onAdd={handleClickAddElric}
              onDismiss={handleDismissAddElric}
              busy={addingElric}
              error={!showDobDialog ? addElricError : null}
            />
          ) : null}
          {canJoinAsSelf && canPost ? (
            <div className="rm3-join-self">
              <button
                type="button"
                className="rm3-join-self-btn"
                disabled={joiningSelf}
                aria-busy={joiningSelf || undefined}
                onClick={() => void joinAsSelf()}
              >
                Join as yourself
              </button>
              {joinSelfError ? (
                <p className="rm-inline-error" role="alert">
                  {joinSelfError}
                </p>
              ) : null}
            </div>
          ) : null}
          {thread.denied ? null : room.closed ? (
            <p className="rm-readonly">This room is closed. Its history stays readable.</p>
          ) : room.readOnly ? (
            <p className="rm-readonly">You can read this room but not post.</p>
          ) : canPost ? (
            <Composer
              roomName={room.name}
              members={members}
              // In the private chat you write as yourself only: the agent answers for itself.
              own={privateAgent ? own.filter((member) => member.id !== privateAgent) : own}
              draft={draft}
              onDraft={onDraft}
              onSend={send}
              disabled={online ? '' : "You're offline"}
              onTask={
                tasks.available && host
                  ? () => {
                      setPanel('tasks');
                      setTaskForm((value) => value + 1);
                    }
                  : undefined
              }
            />
          ) : null}
        </div>
        {panel === 'members' ? (
          roomsV2 ? (
            <MembersPanelV2
              client={client}
              room={room}
              members={members}
              elricRow={elricSwitch ? <ElricSwitchRow elric={elricSwitch} /> : null}
              elricManaged={elricSwitch !== null}
              onChanged={() => {
                void loadMembers();
                void thread.refresh();
                onRoomChanged();
              }}
              onClose={closeMembers}
              onLeft={() => {
                setPanel(null);
                left.current = true;
                onRoomChanged();
              }}
            />
          ) : (
            <MembersPanel
              client={client}
              room={room}
              members={members}
              {...(elricSwitch ? { elric: elricSwitch } : {})}
              onChanged={() => {
                void loadMembers();
                void thread.refresh();
                onRoomChanged();
              }}
              onClose={closeMembers}
              onLeft={() => {
                setPanel(null);
                // Refresh the list first; this view unmounts once the room is gone from it and
                // then goes to /rooms (see the effect below), so /rooms never reopens it from a
                // stale list.
                left.current = true;
                onRoomChanged();
              }}
            />
          )
        ) : panel === 'settings' ? (
          <RoomSettings
            client={client}
            room={room}
            members={members}
            ready={thread.ready}
            onManageMembers={() => setPanel('members')}
            onChanged={() => {
              void loadMembers();
              void thread.refresh();
              onRoomChanged();
            }}
            onDeleted={() => {
              setPanel(null);
              // Reload the list (the room leaves it) and go to the room list right away.
              onRoomChanged();
              navigate('/rooms');
            }}
            onClose={() => setPanel(null)}
          />
        ) : panel === 'tasks' ? (
          <TasksPanel
            room={room}
            members={members}
            state={tasks}
            startAdding={taskForm}
            openNumber={openTaskNumber}
            onClose={() => {
              setPanel(null);
              setTaskForm(0);
            }}
            openTask={v2 ? openTask : null}
            onPinTask={pinAs ? (task) => void pin({ taskId: task.id }) : undefined}
          />
        ) : panel === 'search' ? (
          <SearchPanel
            client={client}
            roomId={initial.id}
            roomName={room.name}
            members={members}
            onJump={(result) => {
              setFocus({ id: result.id, key: Date.now() });
              void thread.jumpTo(result.seq);
              // On a phone or tablet the panel covers the thread: close it to show the message.
              if (window.matchMedia?.('(max-width: 899px)').matches) setPanel(null);
            }}
            onClose={() => {
              setPanel(null);
              searchButton.current?.focus();
            }}
          />
        ) : panel === 'code' ? (
          <RepoPanel room={room} repo={repo} onClose={() => setPanel(null)} />
        ) : null}
      </div>
      {addMyAi ? (
        <AddMyAiSheet
          client={client}
          roomId={initial.id}
          inRoom={new Set(own.filter((member) => member.kind !== 'person').map((m) => m.id))}
          onClose={() => setAddMyAi(false)}
          onAdded={() => {
            setAddMyAi(false);
            void loadMembers();
          }}
        />
      ) : null}
      {connect ? (
        <Suspense fallback={null}>
          <ConnectAiSheet
            host={host}
            onInvite={() => {
              setConnect(false);
              setInvite(true);
            }}
            onClose={() => setConnect(false)}
          />
        </Suspense>
      ) : null}
      {addAi ? (
        <Suspense fallback={null}>
          <AddAiSheet
            client={client}
            roomId={initial.id}
            onClose={() => setAddAi(false)}
            onJoined={() => {
              setAddAi(false);
              void loadMembers();
              void thread.refresh();
            }}
          />
        </Suspense>
      ) : null}
      {invite ? (
        <InviteSheet
          client={client}
          room={room}
          onRoomChanged={() => {
            void thread.refresh();
            onRoomChanged();
          }}
          onClose={() => {
            setInvite(false);
            void loadMembers();
            void thread.refresh();
          }}
        />
      ) : null}
      {showDobDialog ? (
        <ElricDobDialog
          busy={addingElric}
          error={addElricError}
          onSubmit={handleDobSubmit}
          onClose={() => {
            setShowDobDialog(false);
            setAddElricError(null);
          }}
        />
      ) : null}
      {ageRefusal ? (
        <ElricAgeDialog reason={ageRefusal} onClose={() => setAgeRefusal(null)} />
      ) : null}
    </section>
  );
  return <AvatarColorsContext.Provider value={avatarColours}>{view}</AvatarColorsContext.Provider>;
}
