import {
  AlertCircle,
  Check,
  ChevronLeft,
  Inbox,
  LayoutGrid,
  Link2,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ConnectionRequest } from '../../shared/assistant';
import type { Agent, Snapshot } from '../../shared/types';
import { api, selectedWorkspaceId } from '../api';
import { formatDate, Modal } from '../components';
import { ElricMark } from '../elric/ElricMark';
import '../elric/elric-tokens.css';
import { AgentAvatar } from './AgentAvatar';
import { AddPane } from './v4/AddPane';
import { AgentPane, type AgentPaneHandle } from './v4/AgentPane';
import { ActivityScreen } from './v4/ActivityScreen';
import { AutoReplyScreen } from './v4/AutoReplyScreen';
import { WalletAddScreen, WalletScreen } from './v4/WalletScreen';
import { WalletLimitsScreen } from './v4/WalletLimitsScreen';
import { WalletPayScreen } from './v4/WalletPayScreen';
import { WalletRateScreen } from './v4/WalletRateScreen';
import { WalletWithdrawScreen } from './v4/WalletWithdrawScreen';
import { BaseRowSummary, BaseScreen } from './v4/BaseScreen';
import { baseProfileOf } from './v4/baseScreenModel';
import { DeveloperScreen } from './v4/DeveloperScreen';
import { ElricPane, type ElricPlace } from './v4/ElricPane';
import { MessagesScreen } from './v4/MessagesScreen';
import { ConnectAgentScreen, PermissionsScreen } from './v4/PermissionsScreen';
import { AddToRoomScreen, RoomsScreen } from './v4/RoomsScreen';
import { RotateKeyScreen } from './v4/RotateKeyScreen';
import { ThreadScreen } from './v4/ThreadScreen';
import { useMediaQuery } from '../rooms/RoomHeaderV2';
import type { AgentScreens } from './v4/screens';

/** The agent pane's screens that have landed (each area adds its own). */
const SCREENS: AgentScreens = {
  base: ({ agent, full, onBack, onChanged, onOpen }) => (
    <BaseScreen
      agentId={agent.id}
      agentName={agent.name}
      onBack={onBack}
      {...baseProfileOf(full)}
      onChanged={onChanged}
      onOpenWallet={() => onOpen('wallet')}
    />
  ),
  messages: (props) => <MessagesScreen {...props} />,
  thread: ({ param, ...props }) => <ThreadScreen {...props} contextId={param ?? ''} />,
  rooms: (props) => <RoomsScreen {...props} />,
  'rooms-add': (props) => <AddToRoomScreen {...props} />,
  activity: (props) => <ActivityScreen {...props} />,
  developer: (props) => <DeveloperScreen {...props} />,
  rotate: (props) => <RotateKeyScreen {...props} />,
  autoreply: (props) => <AutoReplyScreen {...props} />,
  wallet: (props) => <WalletScreen {...props} />,
  'wallet-add': (props) => <WalletAddScreen {...props} />,
  'wallet-withdraw': (props) => <WalletWithdrawScreen {...props} />,
  'wallet-limits': (props) => <WalletLimitsScreen {...props} />,
  'wallet-pay': (props) => <WalletPayScreen {...props} />,
  'wallet-rate': (props) => <WalletRateScreen {...props} />,
  permissions: (props) => <PermissionsScreen {...props} />,
  'permissions-add': (props) => <ConnectAgentScreen {...props} />,
};
import { AvatarColorsContext, useAvatarColors } from '../shell/avatarColor';
import {
  agentStateV2,
  expiryLabel,
  isElricAgent,
  pendingRequests,
  rosterAgents,
  rosterCounts,
  showElricRow,
  type ElricState,
  type PendingRequestV2,
} from './myAgentsModel';
import { useAgentRooms } from './useAgentRooms';
import { useInboxSummary } from '../Messages';
import './my-agents-v3.css';
import './my-agents-v4.css';

const ManageElricHost = lazy(() => import('./ManageElricHost'));

const REQUESTS = '/api/v2/connections/requests';

/** An agent to show in the pane, and optionally the screen to show over its home ('messages'). */
export interface AgentRequest {
  id: string;
  screen?: string;
}

export interface MyAgentsV2Props {
  snapshot: Pick<Snapshot, 'agents' | 'connections' | 'paused' | 'events'>;
  /** Shared busy flag of the console (any running action disables the others). */
  busy: boolean;
  /** Runs an action through the console: busy state, error banner, refresh and notice. */
  run: (key: string, fn: () => Promise<unknown>, message?: string) => Promise<void>;
  onAddAgent: () => void;
  /** Opens Exchanges, the ledger of work between agents (it has no sidebar entry). */
  onExchanges?: () => void;
  /** Elric's agent id (GET /api/elric): pinned first, never removed or rotated from here. */
  elricAgentId?: string | null;
  /** Elric's own state (GET /api/elric); its row shows only while Elric is on or paused. */
  elricStatus?: ElricState;
  /** Elric was paused or resumed (in its pane or in Manage Elric). */
  onElricStatus?: (status: 'active' | 'paused') => void;
  /** Opens the Elric page: its chat (/elric) or the console's Elric view (approvals, activity). */
  onOpenElric: (place: ElricPlace) => void;
  /** Opens a room's page (/rooms/<id>): an agent's private chat, from its Message button. */
  onOpenRoom: (roomId: string) => void;
  /** Today's claim form, opened from the list's "Claim from a link" row; it calls back once a
   * claim went through, so the sheet closes. */
  claimForm?: (onClaimed: () => void) => ReactNode;
  /** Something outside (Connect AI's "Claim agents") asked for the claim sheet. */
  claimRequested?: boolean;
  /** The requested claim sheet is open; the request can be cleared. */
  onClaimOpened?: () => void;
  /** The console shows a dialog over the page (Add an agent, a new key, …). */
  dialogOpen?: boolean;
  /** Something outside asked to show this agent (the network map's "Open agent", a new template
   * agent), or one of its screens (an unread chip in Messages opens its Messages). */
  agentRequested?: AgentRequest | null;
  /** The requested agent is shown; the request can be cleared. */
  onAgentOpened?: () => void;
  /** Adds the three example agents (POST /api/demo/start through the console). */
  onTryExamples?: () => void;
  /** Re-reads the workspace after the pane changed an agent (renamed it, made it public). */
  onChanged?: () => void;
}

type RequestRead =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; items: ConnectionRequest[] };

/** Incoming cross-owner connection requests that wait for this workspace's decision. */
function useIncomingRequests() {
  const [read, setRead] = useState<RequestRead>({ state: 'loading' });
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const workspace = selectedWorkspaceId();
    setRead((old) => (old.state === 'ready' ? old : { state: 'loading' }));
    try {
      const query = new URLSearchParams({ direction: 'incoming', status: 'pending', limit: '100' });
      const result = await api<{ incoming: ConnectionRequest[] }>(
        `${REQUESTS}?${query}`,
        undefined,
        'GET',
        AbortSignal.any([abort.signal, AbortSignal.timeout(12_000)]),
      );
      if (abort.signal.aborted || selectedWorkspaceId() !== workspace) return;
      setRead({ state: 'ready', items: result.incoming });
    } catch (err) {
      if (abort.signal.aborted) return;
      setRead({
        state: 'error',
        message:
          err instanceof Error && err.name !== 'TimeoutError'
            ? err.message
            : 'The request took too long.',
      });
    }
  }, []);
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);
  return { read, reload: load };
}

/**
 * My agents v4 (mockup: docs/design/my-agents-v4-mockup.html). A list column (Agents · N online,
 * search, requests, add; Elric pinned first; removed agents under Removed) and the open agent
 * filling the rest of the page. On a phone the agent opens full screen with "‹ Agents".
 */
export function MyAgentsV2({
  snapshot,
  busy,
  run,
  onAddAgent,
  onExchanges,
  elricAgentId,
  elricStatus,
  onElricStatus,
  onOpenElric,
  onOpenRoom,
  claimForm,
  claimRequested,
  onClaimOpened,
  agentRequested,
  onAgentOpened,
  dialogOpen = false,
  onTryExamples,
  onChanged,
}: MyAgentsV2Props) {
  const [searching, setSearching] = useState(false);
  // A claim link (#claim=…) opens the claim sheet with its code filled in.
  /** The detail side shows an agent (null), Add an agent, or the connection requests. */
  const [side, setSide] = useState<'add' | 'requests' | null>(null);
  const sideTrigger = useRef<HTMLElement | null>(null);
  const openSide = (which: 'add' | 'requests', from: HTMLElement) => {
    sideTrigger.current = from;
    setSide(which);
  };
  const closeSide = () => {
    setSide(null);
    if (listColumn.current) listColumn.current.inert = false;
    const back = sideTrigger.current;
    if (back?.isConnected) back.focus();
  };
  const [claiming, setClaiming] = useState(() => window.location.hash.startsWith('#claim='));
  useEffect(() => {
    if (!claimRequested) return;
    setClaiming(true);
    onClaimOpened?.();
  }, [claimRequested, onClaimOpened]);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const listColumn = useRef<HTMLDivElement>(null);
  const inbox = useInboxSummary(true);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  /** The last agent asked for from elsewhere, with the screen it should open on. */
  const [requested, setRequested] = useState<AgentRequest | null>(null);
  const [sheet, setSheet] = useState<'elric' | null>(null);
  /** Pause or resume one agent (same change as city_control, without the cascade). */
  const setPaused = (agent: Agent, paused: boolean) =>
    run(
      `${paused ? 'pause' : 'resume'}-${agent.id}`,
      () => api(`/api/agents/${agent.id}/${paused ? 'pause' : 'resume'}`, {}),
      paused ? `${agent.name} is paused.` : `${agent.name} is working again.`,
    );
  /** Pause or resume Elric (the same calls as Manage Elric); its row and pane follow at once. */
  const setElricPaused = (paused: boolean) =>
    run(
      paused ? 'elric-pause' : 'elric-resume',
      async () => {
        await api(`/api/elric/${paused ? 'pause' : 'resume'}`, {});
        onElricStatus?.(paused ? 'paused' : 'active');
      },
      paused ? 'Elric is paused.' : 'Elric is on again.',
    );
  // A dialog or sheet over the page: the Base row stops reading until it is uncovered.
  const covered = dialogOpen || claiming || sheet !== null;
  const trigger = useRef<HTMLElement | null>(null);
  const panel = useRef<AgentPaneHandle>(null);
  const focusPanel = useRef(false);
  const panelId = useId();
  const { read, reload } = useIncomingRequests();
  const agentKey = snapshot.agents.map((agent) => agent.id).join(',');
  const rooms = useAgentRooms(agentKey);
  const now = Date.now();
  const pending = read.state === 'ready' ? pendingRequests(read.items, snapshot.agents, now) : [];
  const counts = rosterCounts(snapshot.agents, elricAgentId);
  const shown = rosterAgents(snapshot.agents, 'all', query, elricAgentId);
  const elricRow = Boolean(elricAgentId) && showElricRow(elricStatus, 'all', query);
  const elricAgent = snapshot.agents.find((agent) => isElricAgent(agent, elricAgentId));
  const others = snapshot.agents.filter((agent) => !isElricAgent(agent, elricAgentId));
  // Every agent in the list gets its own colour (src/shell/avatarColor.ts), oldest first, so a new
  // agent never changes the colour of the ones already there.
  const avatarColours = useAvatarColors(
    others.map((agent) => ({ id: agent.id, joinedAt: agent.createdAt })),
  );
  // Elric opens its own pane (ElricPane), never an agent's, and only while it is on or paused.
  const open = openId
    ? snapshot.agents.find((agent) => agent.id === openId && !isElricAgent(agent, elricAgentId))
    : undefined;
  const elricOpen =
    Boolean(elricAgentId) &&
    openId === elricAgentId &&
    (elricStatus === 'active' || elricStatus === 'paused');
  const openKey = open ? open.id : elricOpen ? openId : null;

  const closePanel = useCallback(() => {
    setOpenId(null);
    setRequested(null);
    // The list must take focus again at once (on a phone it was inert behind the agent).
    if (listColumn.current) listColumn.current.inert = false;
    const back = trigger.current;
    if (back?.isConnected) back.focus();
  }, []);

  useEffect(() => {
    if (searching) searchInput.current?.focus();
  }, [searching]);

  useEffect(() => {
    if (claiming) document.getElementById('claim-token')?.focus();
  }, [claiming]);
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash.startsWith('#claim=')) setClaiming(true);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Phone: the open agent covers the page; the list behind it is inert and does not scroll.
  // This follows the width, so a rotated tablet or a resized window locks or frees the list.
  const panelOpen = openKey !== null;
  const phone = useMediaQuery('(max-width: 900px)');
  useEffect(() => {
    const list = listColumn.current;
    if ((!panelOpen && !side) || !list || !phone) return;
    // The app header's menu button sits under the agent's "‹ Agents"; Tab must not reach it.
    const header = document.querySelector<HTMLElement>('.cc-app-header');
    const headerInert = header?.inert ?? false;
    list.inert = true;
    if (header) header.inert = true;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      list.inert = false;
      if (header) header.inert = headerInert;
      document.body.style.overflow = overflow;
    };
  }, [panelOpen, side, phone]);

  // An agent asked for from elsewhere opens instead of the first one (this runs first), on the
  // screen asked for if any; opening another agent from the list starts at its home again.
  const preselected = useRef(false);
  /** Counts requests, so the pane takes focus even when it already showed the requested agent
   * (a new agent in an empty list opens as the first one before its request arrives). */
  const [requests, setRequests] = useState(0);
  useEffect(() => {
    if (!agentRequested) return;
    preselected.current = true;
    focusPanel.current = true;
    setRequests((count) => count + 1);
    setSide(null);
    setRequested(agentRequested);
    setOpenId(agentRequested.id);
    onAgentOpened?.();
  }, [agentRequested, onAgentOpened]);
  // A link from elsewhere in the app to one agent's screen: /agents#agent=<id>:<screen> (a private
  // chat's "Set up Auto-reply"). Opened like a request, then the address is cleaned.
  useEffect(() => {
    const fromHash = () => {
      const match = /^#agent=([^:&]+)(?::([a-z-]+))?$/.exec(window.location.hash);
      if (!match) return;
      const id = decodeURIComponent(match[1]!);
      preselected.current = true;
      focusPanel.current = true;
      setRequests((count) => count + 1);
      setSide(null);
      setRequested({ id, ...(match[2] ? { screen: match[2] } : {}) });
      setOpenId(id);
      try {
        history.replaceState(history.state, '', window.location.pathname + window.location.search);
      } catch {}
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);
  // On a wide screen the detail side is never blank: the first agent opens once, on arrival.
  const firstLive = snapshot.agents.find(
    (agent) => !isElricAgent(agent, elricAgentId) && agentStateV2(agent) !== 'revoked',
  )?.id;
  useEffect(() => {
    if (preselected.current || !firstLive) return;
    preselected.current = true;
    if (window.matchMedia?.('(min-width: 901px)').matches) setOpenId(firstLive);
  }, [firstLive]);

  // Escape closes the panel (a sheet above it closes first: it is modal and takes Escape).
  useEffect(() => {
    if (!side) return;
    const keys = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      closeSide();
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, [side]);
  useEffect(() => {
    if (!panelOpen || side) return;
    const keys = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      closePanel();
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, [panelOpen, side, closePanel]);

  useEffect(() => {
    if (openKey && focusPanel.current) {
      focusPanel.current = false;
      panel.current?.focus();
    }
  }, [openKey, requests]);

  function openAgent(id: string, from: HTMLElement) {
    trigger.current = from;
    // The open agent's detail takes focus (at once when it is already the one shown).
    if (openId === id) panel.current?.focus();
    else focusPanel.current = true;
    // Master–detail: a row always shows its agent (it never closes it); Escape or ‹ Agents does.
    setSide(null);
    setRequested(null);
    setOpenId(id);
  }

  function focusClaim() {
    setClaiming(true);
  }

  async function decide(item: PendingRequestV2, decision: 'approve' | 'deny') {
    await run(
      `decide-${item.id}`,
      () => api(`${REQUESTS}/${item.id}/decide`, { decision }),
      decision === 'approve'
        ? `Connection from ${item.agentName} approved.`
        : 'Request denied. They can ask again after 7 days.',
    );
    await reload();
  }

  const empty = !others.length;
  const live = shown.filter((agent) => agentStateV2(agent) !== 'revoked');
  const removed = shown.filter((agent) => agentStateV2(agent) === 'revoked');
  // The Removed group is part of the full list only, never of a search.
  const removedShown = query.trim() ? [] : removed;
  const view = (
    <section
      className="ma3 ma4"
      aria-label="Agents"
      data-panel={panelOpen || side ? 'open' : undefined}
    >
      <div className="ma4-list" ref={listColumn}>
        <div className="ma4-head">
          <div className="ma4-title">
            <h1>My agents</h1>
            {counts.total || elricStatus === 'active' ? (
              <small>{counts.online + (elricStatus === 'active' ? 1 : 0)} online</small>
            ) : null}
          </div>
          <button
            ref={searchButton}
            type="button"
            className="ma4-icon"
            aria-label="Search agents"
            aria-expanded={searching}
            onClick={() => {
              setSearching((on) => !on);
              if (searching) setQuery('');
            }}
          >
            <Search size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ma4-icon"
            aria-haspopup="dialog"
            aria-label={pending.length ? `Requests, ${pending.length} pending` : 'Requests'}
            aria-expanded={side === 'requests'}
            onClick={(event) => openSide('requests', event.currentTarget)}
          >
            <Inbox size={16} aria-hidden="true" />
            {pending.length ? <i className="ma4-dot" aria-hidden="true" /> : null}
          </button>
          <button
            type="button"
            className="ma4-icon"
            aria-label="Add an agent"
            title="Add an agent"
            aria-expanded={side === 'add'}
            onClick={(event) => openSide('add', event.currentTarget)}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        {searching ? (
          <label className="ma4-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchInput}
              type="text"
              aria-label="Search agents"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setQuery('');
                  setSearching(false);
                  searchButton.current?.focus();
                }
              }}
            />
          </label>
        ) : null}

        {elricRow || live.length || removedShown.length ? (
          <ul className="ma4-rows" aria-label="Agents">
            {elricRow && elricAgentId ? (
              <ElricRow
                status={elricStatus === 'paused' ? 'paused' : 'active'}
                open={elricOpen}
                panelId={panelId}
                onToggle={(from) => openAgent(elricAgentId, from)}
              />
            ) : null}
            {live.map((agent) => (
              <RosterRow
                key={agent.id}
                agent={agent}
                now={now}
                unread={inbox.unread.get(agent.id) ?? 0}
                capped={inbox.capped.has(agent.id)}
                open={open?.id === agent.id}
                panelId={panelId}
                onToggle={(from) => openAgent(agent.id, from)}
              />
            ))}
            {removedShown.length ? (
              <li className="ma4-label" aria-hidden="true">
                Removed
              </li>
            ) : null}
            {removedShown.map((agent) => (
              <RemovedRow key={agent.id} agent={agent} now={now} />
            ))}
          </ul>
        ) : null}

        {empty ? (
          <div className="ma3-state ma4-first">
            <h3>Your agents live here.</h3>
            <div className="ma3-state-actions">
              <button
                type="button"
                className="ma3-btn ma3-btn-primary"
                onClick={(event) => openSide('add', event.currentTarget)}
              >
                Add an agent
              </button>
              {onTryExamples ? (
                <button
                  type="button"
                  className="ma3-btn ma3-btn-ghost"
                  disabled={busy}
                  onClick={onTryExamples}
                >
                  Try example agents
                </button>
              ) : null}
            </div>
            <button type="button" className="ma3-link" onClick={focusClaim}>
              Claim from a link
            </button>
          </div>
        ) : !live.length && !removedShown.length && !elricRow ? (
          <p className="ma4-none" role="status">
            No agent called “{query}”.
          </p>
        ) : null}

        {read.state === 'error' ? (
          <div className="ma3-requests-error" role="alert">
            <AlertCircle size={18} aria-hidden="true" />
            <p>Connection requests could not be loaded. {read.message}</p>
            <button type="button" className="ma3-btn ma3-btn-ghost ma3-btn-sm" onClick={reload}>
              <RefreshCw size={15} aria-hidden="true" />
              Retry
            </button>
          </div>
        ) : null}

        {empty ? null : (
          <ul className="ma4-rows ma4-extra" aria-label="More ways to add agents">
            <li>
              <button type="button" className="ma4-row-open ma4-plain" onClick={focusClaim}>
                <span className="ma4-mark" aria-hidden="true">
                  <Link2 size={15} />
                </span>
                <span className="ma4-name">Claim from a link</span>
              </button>
            </li>
            {onTryExamples ? (
              <li>
                <button
                  type="button"
                  className="ma4-row-open ma4-plain"
                  disabled={busy}
                  onClick={onTryExamples}
                >
                  <span className="ma4-mark" aria-hidden="true">
                    <LayoutGrid size={15} />
                  </span>
                  <span className="ma4-name">Try example agents</span>
                </button>
              </li>
            ) : null}
          </ul>
        )}
        {onExchanges ? (
          <div className="ma4-more">
            <button type="button" className="ma3-link" onClick={onExchanges}>
              Exchanges
            </button>
          </div>
        ) : null}
      </div>

      <div className="ma4-detail" data-open={panelOpen || side ? 'true' : undefined}>
        {side ? (
          <>
            <button type="button" className="ma4-back" onClick={closeSide}>
              <ChevronLeft size={18} aria-hidden="true" />
              Agents
            </button>
            {side === 'add' ? (
              <AddPane
                busy={busy}
                claimForm={claimForm?.(() => setSide(null))}
                onTryExamples={onTryExamples}
                onOwnAgent={onAddAgent}
                onCreated={async (agent) => {
                  await run(`create-${agent.id}`, async () => undefined, `${agent.name} is ready.`);
                  setSide(null);
                  setOpenId(agent.id);
                }}
              />
            ) : (
              <aside className="ap4" aria-label="Connection requests">
                <div className="ap4-wrap">
                  <h2 className="ap4-title">Requests</h2>
                  <RequestsSheetBody
                    read={read}
                    items={pending}
                    busy={busy}
                    now={now}
                    onRetry={() => void reload()}
                    onDecide={(item, decision) => void decide(item, decision)}
                  />
                </div>
              </aside>
            )}
          </>
        ) : open ? (
          <>
            <button type="button" className="ma4-back" onClick={closePanel}>
              <ChevronLeft size={18} aria-hidden="true" />
              Agents
            </button>
            <AgentPane
              key={open.id}
              ref={panel}
              id={panelId}
              agent={open}
              snapshot={snapshot}
              rooms={rooms.read.state === 'ready' ? (rooms.read.byAgent.get(open.id) ?? []) : null}
              busy={busy}
              screens={SCREENS}
              initialScreen={requested?.id === open.id ? requested.screen : undefined}
              onChanged={onChanged}
              onOpenRoom={onOpenRoom}
              onOpenElric={() => onOpenElric('chat')}
              unread={inbox.unread.get(open.id) ?? 0}
              baseRow={(go) => (
                <BaseRowSummary
                  agentId={open.id}
                  onOpen={go}
                  {...baseProfileOf(open)}
                  paused={covered}
                />
              )}
              onPause={(paused) => void setPaused(open, paused)}
              onRemove={async () => {
                // The revoke itself, not through run(): run() reports a failure in the page's
                // banner and resolves anyway, so the pane would leave Remove as if it went through.
                try {
                  await api(`/api/agents/${open.id}/revoke`, {});
                } catch (err) {
                  return err instanceof Error ? err.message : 'The agent could not be removed.';
                }
                await run(`removed-${open.id}`, async () => undefined, `${open.name} was removed.`);
                void rooms.reload();
                return null;
              }}
            />
          </>
        ) : elricOpen ? (
          <>
            <button type="button" className="ma4-back" onClick={closePanel}>
              <ChevronLeft size={18} aria-hidden="true" />
              Agents
            </button>
            <ElricPane
              ref={panel}
              id={panelId}
              status={elricStatus === 'paused' ? 'paused' : 'active'}
              busy={busy}
              onPause={(paused) => void setElricPaused(paused)}
              onOpen={onOpenElric}
              onSettings={() => setSheet('elric')}
            />
          </>
        ) : empty ? null : (
          <div className="ma4-pick" role="status">
            <b>No agent selected</b>
            <span>Pick one from the list.</span>
          </div>
        )}
      </div>

      {claiming && claimForm ? (
        <Modal title="Claim from a link" onClose={() => setClaiming(false)}>
          <div className="modal-body ma4-claim">{claimForm(() => setClaiming(false))}</div>
        </Modal>
      ) : null}
      {sheet === 'elric' ? (
        <Suspense fallback={null}>
          <ManageElricHost
            onClose={() => setSheet(null)}
            onStatus={(status) => onElricStatus?.(status)}
          />
        </Suspense>
      ) : null}
    </section>
  );
  return <AvatarColorsContext.Provider value={avatarColours}>{view}</AvatarColorsContext.Provider>;
}

/** "2 min ago", "3 h ago", "5 d ago": how long since the agent was last active. */
export function agoLabel(iso: string, now: number): string {
  const minutes = Math.max(1, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** The quiet line under a name: what the agent is doing, in one or two words. */
function rowLine(agent: Agent, now: number): string {
  const state = agentStateV2(agent);
  if (state === 'revoked')
    return agent.revokedAt ? `Removed ${agoLabel(agent.revokedAt, now)}` : 'Removed';
  if (state === 'paused') return 'Paused';
  if (state === 'online') return 'Active now';
  return agent.lastSeenAt ? `Active ${agoLabel(agent.lastSeenAt, now)}` : 'Offline';
}

function RosterRow({
  agent,
  now,
  unread,
  capped,
  open,
  panelId,
  onToggle,
}: {
  agent: Agent;
  now: number;
  /** Messages the owner has not read in this agent's inbox (GET /api/messages/summary). */
  unread: number;
  capped: boolean;
  open: boolean;
  panelId: string;
  onToggle: (from: HTMLElement) => void;
}) {
  const state = agentStateV2(agent);
  const line = rowLine(agent, now);
  const count = capped || unread > 99 ? '99+' : unread ? String(unread) : '';
  return (
    <li className="ma4-row" data-state={state} data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="ma4-row-open"
        aria-label={`${agent.name}, ${line}${count ? `, ${count} unread` : ''}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={(event) => onToggle(event.currentTarget)}
      >
        <span className="ma4-avatar">
          <AgentAvatar id={agent.id} name={agent.name} />
          <i className="ma4-presence" data-state={state} />
        </span>
        <span className="ma4-who">
          <span className="ma4-name">{agent.name}</span>
          <small>{line}</small>
        </span>
        {count ? (
          <span className="ma4-badge" aria-hidden="true">
            {count}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** A removed agent: shown, faded, and not opened (there is nothing left to manage). */
function RemovedRow({ agent, now }: { agent: Agent; now: number }) {
  return (
    <li className="ma4-row" data-state="revoked">
      <span className="ma4-row-open ma4-row-static">
        <span className="ma4-avatar">
          <AgentAvatar id={agent.id} name={agent.name} />
        </span>
        <span className="ma4-who">
          <span className="ma4-name">{agent.name}</span>
          <small>{rowLine(agent, now)}</small>
        </span>
      </span>
    </li>
  );
}

/** Elric, pinned first: it opens Elric's own pane, like any other row opens its agent. */
function ElricRow({
  status,
  open,
  panelId,
  onToggle,
}: {
  status: 'active' | 'paused';
  open: boolean;
  panelId: string;
  onToggle: (from: HTMLElement) => void;
}) {
  const line = status === 'active' ? 'Built in' : 'Paused · Built in';
  return (
    <li
      className="ma4-row ma4-row-elric"
      data-state={status === 'active' ? 'online' : 'paused'}
      data-open={open ? 'true' : undefined}
    >
      <button
        type="button"
        className="ma4-row-open"
        aria-label={`Elric, ${line}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={(event) => onToggle(event.currentTarget)}
      >
        <span className="ma4-avatar">
          <ElricMark size="md" />
          <i className="ma4-presence" data-state={status === 'active' ? 'online' : 'paused'} />
        </span>
        <span className="ma4-who">
          <span className="ma4-name">Elric</span>
          <small>{line}</small>
        </span>
      </button>
    </li>
  );
}

function RequestsSheetBody({
  read,
  items,
  busy,
  now,
  onRetry,
  onDecide,
}: {
  read: RequestRead;
  items: PendingRequestV2[];
  busy: boolean;
  now: number;
  onRetry: () => void;
  onDecide: (item: PendingRequestV2, decision: 'approve' | 'deny') => void;
}) {
  if (read.state === 'loading')
    return (
      <p className="ma3-sheet-note" role="status">
        Loading connection requests…
      </p>
    );
  if (read.state === 'error')
    return (
      <div className="ma3-sheet-note" role="alert">
        <p>Connection requests could not be loaded. {read.message}</p>
        <button type="button" className="ma3-btn ma3-btn-ghost ma3-btn-sm" onClick={onRetry}>
          <RefreshCw size={15} aria-hidden="true" />
          Retry
        </button>
      </div>
    );
  return (
    <div className="ma3-requests">
      <p className="ma3-sheet-note">
        An approved connection lets their agent send work to yours. Requests expire after 7 days.
      </p>
      {items.length ? (
        <ul className="ma3-request-list" aria-label="Pending connection requests">
          {items.map((item) => (
            <li key={item.id} className="ma3-request">
              <div className="ma3-request-who">
                <strong>{item.agentName}</strong>
                <span>{item.ownerLabel}</span>
                {item.toAgentName ? <span>Wants to reach {item.toAgentName}</span> : null}
                {item.note ? <span className="ma3-request-note">“{item.note}”</span> : null}
                <time className="ma3-expiry" dateTime={item.expiresAt}>
                  {expiryLabel(item.expiresAt, now)} · {formatDate(item.expiresAt)}
                </time>
              </div>
              <div className="ma3-request-actions">
                <button
                  type="button"
                  className="ma3-btn ma3-btn-primary ma3-btn-sm"
                  disabled={busy}
                  aria-label={`Approve connection request from ${item.agentName}`}
                  onClick={() => onDecide(item, 'approve')}
                >
                  <Check size={15} aria-hidden="true" />
                  Approve
                </button>
                <button
                  type="button"
                  className="ma3-btn ma3-btn-ghost ma3-btn-sm"
                  disabled={busy}
                  aria-label={`Deny connection request from ${item.agentName}`}
                  onClick={() => onDecide(item, 'deny')}
                >
                  <X size={15} aria-hidden="true" />
                  Deny
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ma3-sheet-empty" role="status">
          No pending connection requests.
        </p>
      )}
    </div>
  );
}
