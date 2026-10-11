import {
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Play,
} from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { Agent, Snapshot } from '../../../shared/types';
import { api } from '../../api';
import { relativeTime } from '../../messagesV2';
import { AgentAvatar } from '../AgentAvatar';
import {
  agentKindLabel,
  agentStateV2,
  confirmsName,
  removalDescendants,
  type AgentRoom,
} from '../myAgentsModel';
import { screenName, type AgentScreens } from './screens';
import { usePrivateRoom } from './usePrivateRoom';
import {
  autoReplyRowState,
  useAgentAnswering,
  useAutoReplyModel,
  type AutoReplyRowState,
} from '../useAgentAnswering';
import { useWalletRow } from '../../base/wallet/useWalletRow';
import './agent-pane.css';

export interface AgentPaneHandle {
  focus: () => void;
}

export interface AgentPaneProps {
  id: string;
  agent: Agent;
  snapshot: Pick<Snapshot, 'agents' | 'connections' | 'events'>;
  /** The rooms this agent is in, once read (null while unknown). */
  rooms: AgentRoom[] | null;
  busy: boolean;
  onPause: (paused: boolean) => void;
  /** Removes the agent; resolves to null once it is removed, or to why it was not. */
  onRemove: () => Promise<string | null>;
  screens?: AgentScreens;
  /** A screen shown over the home screen on arrival ('messages' from an unread chip in Messages);
   * back returns home. Read when the pane mounts. */
  initialScreen?: string;
  /** The Base row as the Base screen summarises it (live status), when that screen exists. */
  baseRow?: (open: () => void) => ReactNode;
  /** Unread messages in this agent's inbox (GET /api/messages/summary). */
  unread?: number;
  /** Re-reads the workspace after the pane changed the agent (rename, made public). */
  onChanged?: () => void;
  /** Shows the person's private chat with this agent (Message <name>): the room's page. */
  onOpenRoom: (roomId: string) => void;
  /** Elric's private chat (/elric), for an agent the server says is an Elric. */
  onOpenElric: () => void;
}

/** The quiet status line: what the agent is doing now, then how it runs. */
function statusLine(agent: Agent, now: number): string {
  const state = agentStateV2(agent);
  const doing =
    state === 'revoked'
      ? 'Removed'
      : state === 'paused'
        ? 'Paused'
        : state === 'online'
          ? 'Active now'
          : agent.lastSeenAt
            ? `Active ${relativeTime(agent.lastSeenAt, now)}`
            : 'Offline';
  return `${doing} · ${agentKindLabel(agent)}`;
}

/**
 * One agent in the v4 pane (docs/design/my-agents-v4-mockup.html): a small header, Message <name>
 * · Pause · ⋯, three groups of rows, and every row's screen pushed inside the same pane with a
 * back link. Message opens the person's private chat with the agent; its inbox is the Messages
 * row.
 */
export const AgentPane = forwardRef<AgentPaneHandle, AgentPaneProps>(function AgentPane(
  {
    id,
    agent,
    snapshot,
    rooms,
    busy,
    onPause,
    onRemove,
    screens = {},
    initialScreen,
    baseRow,
    unread = 0,
    onChanged,
    onOpenRoom,
    onOpenElric,
  },
  ref,
) {
  const arrival = initialScreen && screens[screenName(initialScreen)] ? initialScreen : null;
  const [stack, setStack] = useState<string[]>(() => (arrival ? ['home', arrival] : ['home']));
  const [menu, setMenu] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const message = useRef<HTMLButtonElement>(null);
  const chat = usePrivateRoom(agent, onOpenRoom, onOpenElric);
  // Whether the agent can reply (the Auto-reply row): the server's word on Auto-reply and the
  // runtime, read while open. The model's name is read only while Auto-reply answers.
  const answering = useAgentAnswering(agent.revokedAt ? null : agent.id);
  // The agent's wallet (test network): its balance or "Set up"; no row while wallets are off.
  const wallet = useWalletRow(agent.revokedAt ? null : agent.id);
  const pane = useRef<HTMLElement>(null);
  const top = stack[stack.length - 1]!;
  const autoReplyOn = Boolean(answering?.can && answering.auto_reply === 'on');
  const modelLabel = useAutoReplyModel(agent.id, autoReplyOn && !agent.revokedAt && top === 'home');
  const autoReply = autoReplyRowState(agent.name, agent.revokedAt ? null : answering, modelLabel);
  // The pane takes focus on its name, or on the title of the screen it arrived on.
  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        const title = heading.current ?? pane.current?.querySelector<HTMLElement>('h2, h3');
        if (title && !title.hasAttribute('tabindex')) title.tabIndex = -1;
        title?.focus();
      },
    }),
    [],
  );
  // A new agent starts at its home screen (the first one on the screen it arrived on).
  const shownAgent = useRef(agent.id);
  useEffect(() => {
    if (shownAgent.current === agent.id) return;
    shownAgent.current = agent.id;
    setStack(['home']);
  }, [agent.id]);
  // Focus follows the screens: an opened screen's title takes it (unless the screen focused a
  // field itself), and coming back home returns it to the control that opened the screen (the
  // name when there is none). The first mount leaves focus to the list (it focuses the pane
  // itself when a row opened it).
  /** For each pushed screen, the data-k of the home control that opened it (for the screen the
   * pane arrived on, that screen's row). */
  const openers = useRef<(string | null)[]>(arrival ? [`row-${screenName(arrival)}`] : []);
  const returning = useRef<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const root = pane.current;
    if (!root) return;
    if (top === 'home') {
      const key = returning.current;
      returning.current = null;
      const holder = key ? root.querySelector<HTMLElement>(`[data-k="${key}"]`) : null;
      const target = holder?.matches('button, a')
        ? holder
        : holder?.querySelector<HTMLElement>('button, a');
      (target ?? heading.current)?.focus({ preventScroll: true });
      return;
    }
    if (root.contains(document.activeElement)) return;
    const title = root.querySelector<HTMLElement>('h2, h3');
    if (!title) return;
    if (!title.hasAttribute('tabindex')) title.tabIndex = -1;
    title.focus({ preventScroll: true });
  }, [top]);

  const open = (screen: string) => {
    setMenu(false);
    if (screen !== 'remove' && screen !== 'rename' && !screens[screenName(screen)]) return;
    const from = document.activeElement?.closest<HTMLElement>('[data-k]')?.dataset.k ?? null;
    openers.current = [...openers.current.slice(0, stack.length - 1), from];
    setStack((s) => [...s, screen]);
  };
  const back = () => {
    returning.current = openers.current[stack.length - 2] ?? null;
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  };
  const backLabel = (() => {
    const previous = stack[stack.length - 2];
    if (!previous || previous === 'home') return agent.name;
    const name = screenName(previous);
    return name.charAt(0).toUpperCase() + name.slice(1);
  })();

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    // An Escape a field or menu inside a screen already handled stays theirs.
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (menu) {
      event.preventDefault();
      setMenu(false);
    } else if (stack.length > 1) {
      // A pushed screen goes back first; the pane itself closes from the home screen.
      event.preventDefault();
      back();
    }
  }

  const state = agentStateV2(agent);
  const removed = state === 'revoked';
  const paused = state === 'paused';
  const now = Date.now();
  let body: ReactNode;
  if (top === 'home') {
    const connections = snapshot.connections.filter(
      (connection) => connection.fromAgentId === agent.id || connection.toAgentId === agent.id,
    ).length;
    const latest = snapshot.events
      .filter((event) => event.agentId === agent.id)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    body = (
      <div className="ap4-wrap">
        <div className="ap4-head">
          <span className="ap4-avatar">
            <AgentAvatar id={agent.id} name={agent.name} size="lg" />
            {removed ? null : <i className="ap4-presence" data-state={state} />}
          </span>
          <div className="ap4-who">
            <h2 ref={heading} tabIndex={-1}>
              {agent.name}
            </h2>
            <p>{statusLine(agent, now)}</p>
          </div>
        </div>
        {removed ? null : (
          <div className="ap4-actions">
            {/* The private chat with this agent. It stays focusable while it opens (aria-disabled),
                so focus stays put, also when it fails. A long name ends in an ellipsis. */}
            <button
              ref={message}
              type="button"
              className="ap4-btn ap4-message"
              data-k="message"
              title={`Message ${agent.name}`}
              aria-busy={chat.state === 'opening' || undefined}
              aria-disabled={chat.state === 'opening' || undefined}
              onClick={() => void chat.open()}
            >
              <MessageSquare size={16} aria-hidden="true" />
              <span className="ap4-label">
                {chat.state === 'opening' ? 'Opening…' : `Message ${agent.name}`}
              </span>
            </button>
            <button
              type="button"
              className="ap4-btn ap4-ghost"
              disabled={busy}
              onClick={() => onPause(!paused)}
            >
              {paused ? (
                <Play size={16} aria-hidden="true" />
              ) : (
                <Pause size={16} aria-hidden="true" />
              )}
              {paused ? 'Resume' : 'Pause'}
            </button>
            <div className="ap4-menuwrap">
              <button
                type="button"
                data-k="more"
                className="ap4-btn ap4-ghost ap4-sq"
                aria-label={`More for ${agent.name}`}
                aria-haspopup="menu"
                aria-expanded={menu}
                onClick={() => setMenu((on) => !on)}
              >
                <MoreHorizontal size={16} aria-hidden="true" />
              </button>
              {menu ? (
                <div className="ap4-menu" role="menu" data-k="more">
                  <button type="button" role="menuitem" onClick={() => open('rename')}>
                    Rename
                  </button>
                  <button type="button" role="menuitem" onClick={() => open('developer')}>
                    Developer details
                  </button>
                  <hr />
                  <button
                    type="button"
                    role="menuitem"
                    className="ap4-danger"
                    onClick={() => open('remove')}
                  >
                    Remove agent
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        )}
        {removed ? null : chat.state === 'error' ? (
          <div className="ap4-retry">
            <p className="ap4-note ap4-error" role="alert">
              {chat.message}
            </p>
            {/* Focus moves to Message, which says Opening… meanwhile. */}
            <button
              type="button"
              className="ap4-btn ap4-ghost"
              onClick={() => {
                message.current?.focus();
                void chat.open();
              }}
            >
              Try again
            </button>
          </div>
        ) : paused ? (
          <p className="ap4-note ap4-wraps">{agent.name} is paused. It answers after you resume.</p>
        ) : null}
        <div className="ap4-group">
          {wallet ? (
            <Row label="Wallet" k="row-wallet" value={wallet} onClick={() => open('wallet')} />
          ) : null}
          {baseRow ? (
            <div data-k="row-base">{baseRow(() => open('base'))}</div>
          ) : (
            <Row label="Base" k="row-base" onClick={() => open('base')} />
          )}
        </div>
        <div className="ap4-group">
          <Row
            label="Messages"
            k="row-messages"
            badge={unread ? (unread > 99 ? '99+' : String(unread)) : undefined}
            onClick={() => open('messages')}
          />
          <Row
            label="Rooms"
            k="row-rooms"
            value={rooms === null ? undefined : rooms.length ? String(rooms.length) : 'None'}
            onClick={() => open('rooms')}
          />
          <Row
            label="Activity"
            k="row-activity"
            value={latest ? relativeTime(latest.createdAt, now) : 'Nothing yet'}
            onClick={() => open('activity')}
          />
        </div>
        <div className="ap4-group">
          <Row
            label="Auto-reply"
            k="row-autoreply"
            status={autoReply}
            onClick={() => open('autoreply')}
          />
          <Row
            label="Permissions"
            k="row-permissions"
            value={
              connections ? `${connections} ${connections === 1 ? 'agent' : 'agents'}` : 'None'
            }
            onClick={() => open('permissions')}
          />
        </div>
      </div>
    );
  } else if (top === 'remove') {
    body = (
      <RemoveScreen
        agent={agent}
        descendants={removalDescendants(snapshot.agents, agent.id)}
        onBack={back}
        backLabel={backLabel}
        onRemove={async () => {
          const failure = await onRemove();
          if (failure === null) setStack(['home']);
          return failure;
        }}
      />
    );
  } else if (top === 'rename') {
    body = (
      <RenameScreen
        agent={agent}
        onBack={back}
        backLabel={backLabel}
        onDone={() => {
          onChanged?.();
          back();
        }}
      />
    );
  } else {
    const render = screens[screenName(top)]!;
    const at = top.indexOf(':');
    body = render({
      agent: { id: agent.id, name: agent.name },
      full: agent,
      param: at < 0 ? undefined : top.slice(at + 1),
      onChanged: () => onChanged?.(),
      onBack: back,
      onOpen: open,
      backLabel,
    });
  }

  return (
    <aside
      ref={pane}
      id={id}
      className="ap4"
      aria-label={`${agent.name} details`}
      onKeyDown={onKeyDown}
    >
      {body}
    </aside>
  );
});

function Row({
  label,
  k,
  value,
  badge,
  status,
  onClick,
}: {
  label: string;
  /** Names the row so focus can come back to it. */
  k?: string;
  value?: string;
  badge?: string;
  /**
   * A status row (Auto-reply): a dot, a hint under the label, and an action word or a value on
   * the right. Still one button; its name reads label, hint, then the action or value.
   */
  status?: AutoReplyRowState;
  onClick: () => void;
}) {
  if (status?.tone) {
    const end = status.tone === 'on' ? status.value : status.action;
    return (
      <button
        type="button"
        className="ap4-row ap4-row-status"
        data-k={k}
        data-tone={status.tone}
        aria-label={`${label}, ${status.hint}, ${end}`}
        onClick={onClick}
      >
        <span className="ap4-dot" aria-hidden="true" />
        <span className="ap4-k">
          <span className="ap4-k-label">{label}</span>
          <span className="ap4-hint">{status.hint}</span>
        </span>
        {status.tone === 'on' ? (
          <span className="ap4-v">{status.value}</span>
        ) : (
          <span className="ap4-act">{status.action}</span>
        )}
        <ChevronRight className="ap4-chev" size={14} aria-hidden="true" />
      </button>
    );
  }
  return (
    <button type="button" className="ap4-row" data-k={k} onClick={onClick}>
      <span className="ap4-k">{label}</span>
      {value ? <span className="ap4-v">{value}</span> : null}
      {badge ? <span className="ap4-badge">{badge}</span> : null}
      <ChevronRight className="ap4-chev" size={14} aria-hidden="true" />
    </button>
  );
}

/** Rename (PATCH /api/agents/:id): the new name shows everywhere the agent does. */
function RenameScreen({
  agent,
  onBack,
  backLabel,
  onDone,
}: {
  agent: Agent;
  onBack: () => void;
  backLabel: string;
  onDone: () => void;
}) {
  const [name, setName] = useState(agent.name);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const next = name.trim();
  return (
    <div className="ap4-wrap">
      <button type="button" className="ap4-back" onClick={onBack}>
        <ChevronLeft size={16} aria-hidden="true" />
        {backLabel}
      </button>
      <h3 className="ap4-title">Rename</h3>
      <form
        className="ap4-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!next || next === agent.name || working) return;
          setWorking(true);
          setError('');
          try {
            await api(`/api/agents/${encodeURIComponent(agent.id)}`, { name: next }, 'PATCH');
            onDone();
          } catch (err) {
            setError(err instanceof Error ? err.message : "The name couldn't be changed.");
          } finally {
            setWorking(false);
          }
        }}
      >
        <input
          className="ap4-field"
          aria-label="Name"
          autoFocus
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {error ? (
          <p className="ap4-note ap4-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          className="ap4-btn ap4-block"
          disabled={!next || next === agent.name || working}
        >
          Save
        </button>
      </form>
    </div>
  );
}

/** Remove, inside the pane: what goes, the sub-agents that go with it, and the typed name. */
function RemoveScreen({
  agent,
  descendants,
  onBack,
  backLabel,
  onRemove,
}: {
  agent: Agent;
  descendants: Agent[];
  onBack: () => void;
  backLabel: string;
  onRemove: () => Promise<string | null>;
}) {
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState('');
  const field = useId();
  const ok = confirmsName(typed, agent.name);
  return (
    <div className="ap4-wrap">
      <button type="button" className="ap4-back" onClick={onBack}>
        <ChevronLeft size={16} aria-hidden="true" />
        {backLabel}
      </button>
      <h3 className="ap4-title">Remove {agent.name}</h3>
      <p className="ap4-note">
        It leaves every room and its key stops working. Messages stay.
        {descendants.length
          ? ` ${descendants.length === 1 ? '1 agent created under it goes' : `${descendants.length} agents created under it go`} too: ${descendants.map((item) => item.name).join(', ')}.`
          : ''}
      </p>
      <form
        className="ap4-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!ok || working) return;
          setWorking(true);
          setFailure('');
          try {
            // Stays on this screen until the agent is really removed: a refused or failed revoke
            // shows why, with the typed name kept for another try.
            const why = await onRemove();
            if (why !== null) setFailure(why);
          } finally {
            setWorking(false);
          }
        }}
      >
        <input
          id={field}
          className="ap4-field"
          aria-label={`Type ${agent.name} to confirm`}
          placeholder={`Type ${agent.name} to confirm`}
          autoComplete="off"
          autoFocus
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        <button
          type="submit"
          className="ap4-btn ap4-danger-btn ap4-block"
          disabled={!ok || working}
        >
          Remove agent
        </button>
      </form>
      {failure ? (
        <p className="ap4-note ap4-error" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
