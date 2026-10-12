import { noteElricStatus } from './elric/prefetch';
import { PageArea } from './shell/PageArea';
import { DataExport } from './settings/DataExport';
import { ActivityLog } from './settings/ActivityLog';
import { isSettingsSection, SettingsLayout } from './settings/SettingsLayout';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  CheckCheck,
  CircleHelp,
  DoorOpen,
  FileText,
  Layers3,
  Link2,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MessagesSquare,
  Network,
  Pause,
  Play,
  Plug,
  Plus,
  Radio,
  RefreshCw,
  Scale,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Unplug,
  X,
} from 'lucide-react';
import type { Agent, Capability, Job, Operator, Snapshot } from '../shared/types';
import { api, selectWorkspace, selectedWorkspaceId } from './api';
import { useWorkspaceV2 } from './shell/workspaceV2';
import { setSidebarOpen } from './shell/sidebarRooms';
import { MyAgentsV2, type AgentRequest } from './agents/MyAgentsV2';
import { unreadMessagesLabel, WorkspaceNavigation } from './shell/WorkspaceNavigation';
import { openWorkspaceView, workspaceView } from './shell/workspaceDestinations';
import { useSnapshot } from './useSnapshot';
import { Workflows } from './Workflows';
import { AssistantAccess, permissionLabel } from './AssistantAccess';

import { CrossWorkspaceConnections } from './Connections';
import { WorkspaceKeys } from './WorkspaceKeys';
import type { WorkspaceMembership } from '../shared/assistant';
import { forgetMessagesState, MessagesView, useInboxSummary } from './Messages';
import { directFromHash } from './rooms/direct';
import { INVITE_ROOMS_PATH, navigate, takeNextPageNote } from './shell/navigation';
import { markInAppChange } from './shell/pageNavigation';
import {
  AgentGlyph,
  capabilityLabels,
  CopyButton,
  creatorLabel,
  EmptyState,
  formatDate,
  formatTime,
  Modal,
  SectionHeading,
  Status,
  TextLink,
} from './components';
import { Lockup, SkipLink, ThemeToggle } from './brand';
import { FormError } from './Auth';
import {
  aiCreated,
  budgetLabel,
  capabilityFigure,
  CityCircle,
  CourtIllustration,
  ExchangeCircle,
  exchangeLabels,
  jobExchangeState,
  lineageDepth,
  type ExchangeState,
} from './circle';
import { ConnectAIApp } from './ConnectApp';
import { AppHeader } from './shell/AppHeader';
import { applyPageTitle } from './shell/usePageTitle';
import { codeFromPaste, eventTypeLabel, plainEvent } from './ui/plainText';
import { ReadableData } from './ui/ReadableData';
import { elricEntry, type ElricEntryStatus } from './elric/entry';
import { clearPendingDraft } from './elric/pendingDraft';
import { PublicFooter } from './shell/PublicFooter';
import { PublicHeader } from './shell/PublicHeader';
import './advanced-v2.css';
import { NetworkMap } from './network/NetworkMap';

/** Its own chunk: only owners on a server with Elric open it. */
const ElricActivity = lazy(() =>
  import('./elric/ElricActivity').then((module) => ({ default: module.ElricActivity })),
);

type View =
  | 'network'
  | 'connect'
  | 'agents'
  | 'jobs'
  | 'connections'
  | 'activity'
  | 'data'
  | 'collaborations'
  | 'messages'
  | 'assistants'
  | 'elric';
type Dialog =
  | { kind: 'create' }
  | { kind: 'connection' }
  | { kind: 'job'; connectionId?: string }
  | { kind: 'result'; id: string }
  | { kind: 'token'; token: string; agent: Agent }
  | null;
const navigation = [
  { id: 'network', label: 'Overview', icon: Network },
  { id: 'connect', label: 'Connect your AI', icon: Plug },
  { id: 'agents', label: 'Agents', icon: Layers3 },
  { id: 'jobs', label: 'Exchanges', icon: Scale },
  { id: 'collaborations', label: 'Collaborations', icon: FileText },
  { id: 'messages', label: 'Messages', icon: MessagesSquare },
  { id: 'connections', label: 'Connections', icon: Link2 },
  { id: 'assistants', label: 'AI connections', icon: Sparkles },
  // Shown only when the server has Elric (GET /api/elric answers; CITY_ELRIC=1).
  { id: 'elric', label: 'Elric', icon: Bot },
  { id: 'activity', label: 'Activity', icon: Activity },
] as const;

/**
 * The person's own workspace plus the AI-owned workspaces they co-own (docs/AI_WORKSPACES.md).
 * Switching remounts the console for the selected workspace; every request then carries
 * X-City-Workspace, which the server honors only for co-owned workspaces.
 */
export function Workspaces({
  person,
  onLogout,
  children,
  pageTitle,
}: {
  person: Operator;
  onLogout: () => void;
  children?: ReactNode;
  pageTitle?: string;
}) {
  const workspaceV2 = useWorkspaceV2();
  const own: WorkspaceMembership = {
    id: person.id,
    name: person.name,
    kind: 'owner',
    role: 'owner',
  };
  const [memberships, setMemberships] = useState<WorkspaceMembership[]>([own]);
  const [activeId, setActiveId] = useState(
    () => (workspaceV2 ? selectedWorkspaceId() : null) ?? person.id,
  );
  const [membershipError, setMembershipError] = useState(false);
  const reload = useCallback(async () => {
    try {
      const value = await api<{ workspaces: WorkspaceMembership[] }>('/api/workspaces');
      setMemberships(value.workspaces);
      setMembershipError(false);
    } catch {
      setMembershipError(true);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const active =
    memberships.find((item) => item.id === activeId) ?? (workspaceV2 ? undefined : own);
  if (!active)
    return (
      <div role="status">
        <p>{membershipError ? 'Workspace list unavailable.' : 'Loading workspace…'}</p>
        <button onClick={() => void reload()}>Retry</button>
        <button onClick={() => switchTo(person.id)}>Return to your workspace</button>
      </div>
    );
  function switchTo(id: string) {
    selectWorkspace(id === person.id ? null : id);
    setActiveId(id);
    if (workspaceV2) window.dispatchEvent(new PopStateEvent('popstate'));
  }
  return (
    <Console
      key={active.id}
      pageContent={children}
      pageTitle={pageTitle}
      operator={{ id: active.id, name: active.name }}
      kind={active.kind}
      workspaces={memberships}
      onSwitch={switchTo}
      onWorkspacesChanged={() => void reload()}
      onLogout={() => {
        selectWorkspace(null);
        onLogout();
      }}
    />
  );
}

/**
 * The workspace preview (`?workspace=v2`) names some views differently in its navigation. Each
 * view's heading, header title and tab title use the same name as its menu entry. Routes and
 * view ids stay as they are, so existing links and history entries keep working.
 */
const previewTitles: Partial<Record<View, string>> = {
  network: 'Network map',
  connect: 'Connect AI',
  agents: 'My agents',
  collaborations: 'Research & review',
  connections: 'Agent permissions',
  assistants: 'Connected apps',
  data: 'Data & export',
  activity: 'Activity log',
};

const headings: Record<View, { title: ReactNode; lede: string }> = {
  network: {
    title: (
      <>
        Everything, <span>at a glance.</span>
      </>
    ),
    lede: 'Your agents, who may work with whom, and the work waiting for your decision.',
  },
  connect: {
    title: 'Connect your AI.',
    lede: 'Add Central City to ChatGPT, Claude, Gemini CLI, Cursor, VS Code or Codex once. After that, you only paste links.',
  },
  agents: {
    title: 'Your agents.',
    lede: 'Each agent has its own identity here. See who created it and what it does.',
  },
  jobs: {
    title: 'Exchanges.',
    lede: 'Work one agent sent to another, what came back, and whether you accepted it.',
  },
  collaborations: {
    title: 'Collaborations.',
    lede: 'One agent drafts a brief from your source, a second checks it, and you decide.',
  },
  messages: {
    title: 'Messages.',
    lede: 'Conversations between your agents, one thread at a time.',
  },
  assistants: {
    title: 'AI connections.',
    lede: 'The AI apps that can act in your account. Remove their access at any time.',
  },
  connections: {
    title: 'Connections.',
    lede: 'Choose which agents may send work to each other, and in which direction.',
  },
  elric: {
    title: 'Elric.',
    lede: 'What your Elric did, and what it may do.',
  },
  data: { title: 'Data & export', lede: 'Download the records for this workspace.' },
  activity: {
    title: 'Activity.',
    lede: 'Everything that happened in your account, newest first.',
  },
};

/** Tracks agents that appear after the first snapshot so they can be drawn into the city. */
function useTransmutations(snapshot: Snapshot | null) {
  const known = useRef<Set<string> | null>(null);
  const timers = useRef<number[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  useEffect(() => {
    if (!snapshot) return;
    if (!known.current) {
      known.current = new Set(snapshot.agents.map((agent) => agent.id));
      return;
    }
    const added = snapshot.agents.filter((agent) => !known.current!.has(agent.id));
    if (!added.length) return;
    for (const agent of added) known.current.add(agent.id);
    setFresh((current) => new Set([...current, ...added.map((agent) => agent.id)]));
    const claimed = added.every((agent) => agent.claimedAt);
    const byAi = added.some(aiCreated);
    const subject = added.length === 1 ? added[0]!.name : `${added.length} agents`;
    setAnnouncement(
      claimed
        ? `${subject} claimed into your account.`
        : `${subject} added${byAi ? ' by an AI app' : ''}.`,
    );
    timers.current.push(
      window.setTimeout(() => {
        setFresh((current) => {
          const next = new Set(current);
          for (const agent of added) next.delete(agent.id);
          return next;
        });
      }, 2600),
    );
  }, [snapshot]);
  return { fresh, announcement };
}

function Console({
  operator,
  kind,
  workspaces,
  onSwitch,
  onWorkspacesChanged,
  onLogout,
  pageContent,
  pageTitle,
}: {
  pageContent?: ReactNode;
  pageTitle?: string;
  operator: Operator;
  kind: 'owner' | 'ai';
  workspaces: WorkspaceMembership[];
  onSwitch: (id: string) => void;
  onWorkspacesChanged: () => void;
  onLogout: () => void;
}) {
  const { snapshot, error, streamLive, refreshing, refresh } = useSnapshot(
    true,
    operator.id,
    onLogout,
  );
  const workspaceV2 = useWorkspaceV2();
  // A claim link (#claim=<token>) opens the agents view with the token prefilled.
  // "Message privately" from a room opens Messages on the pair's thread (#dm=<room>.<member>).
  const [direct, setDirect] = useState(() => directFromHash(window.location.hash));
  const [view, setView] = useState<View>(() =>
    direct
      ? 'messages'
      : window.location.hash.startsWith('#claim=')
        ? 'agents'
        : window.location.hash === '#connect'
          ? 'connect'
          : window.location.hash === '#elric'
            ? 'elric'
            : // A console view with its own address (/settings, /agents; see Root) or Back/Forward.
              (workspaceView(window.history.state, operator.id) ?? 'network'),
  );
  useEffect(() => {
    // The claim form removes its secret fragment after reading it. Preserve the console
    // destination before that happens so Root cannot mistake it for a fresh home entry.
    if (workspaceV2 && !pageContent)
      window.history.replaceState(
        { ...window.history.state, workspaceView: view, workspaceId: operator.id },
        '',
      );
    if (
      ['#signin', '#create', '#connect', '#elric'].includes(window.location.hash) ||
      window.location.hash.startsWith('#dm=')
    )
      window.history.replaceState(
        workspaceV2 ? { workspaceView: view, workspaceId: operator.id } : null,
        '',
        window.location.pathname + window.location.search,
      );
  }, []);
  useEffect(() => {
    if (!workspaceV2) return;
    const sync = () => {
      const hash = window.location.hash;
      const directEntry = directFromHash(hash);
      if (directEntry) setDirect(directEntry);
      const next = directEntry
        ? 'messages'
        : hash === '#connect'
          ? 'connect'
          : hash === '#elric'
            ? 'elric'
            : hash.startsWith('#claim=')
              ? 'agents'
              : workspaceView(window.history.state, operator.id);
      if (next) {
        window.history.replaceState(
          { ...window.history.state, workspaceView: next, workspaceId: operator.id },
          '',
        );
        setView(next);
      }
      setMobileNav(false);
    };
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, [workspaceV2, operator.id]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const closeNavigation = useCallback(() => setMobileNav(false), []);
  // A room page's top bar opens the drawer with its own ☰ chip (the shell row steps aside).
  useEffect(() => {
    if (!workspaceV2) return;
    setSidebarOpen(() => setMobileNav(true));
    return () => setSidebarOpen(null);
  }, [workspaceV2]);
  // Elric lives in the person's own workspace, and only when the server has it.
  // An account that cannot use Elric yet (no Google sign-in, no date of birth) goes to /elric,
  // which shows the step it needs; under 18 sees no entry at all (src/elric/entry.ts).
  const [elric, setElric] = useState<'hidden' | 'activity' | 'setup' | null>(null);
  // Elric's agent id, so My agents can tell the first-party assistant apart from added agents.
  const [elricAgentId, setElricAgentId] = useState<string | null>(null);
  // Elric's own state, for its pinned row in My agents (On / Paused).
  const [elricStatus, setElricStatus] = useState<'active' | 'paused' | 'revoked' | null>(null);
  useEffect(() => {
    if (kind === 'ai') return;
    let active = true;
    api<ElricEntryStatus & { status?: 'active' | 'paused' | 'revoked' | null }>('/api/elric')
      .then((status) => {
        if (!active) return;
        setElric(elricEntry(status));
        setElricAgentId(status.agent_id ?? null);
        setElricStatus(status.status ?? null);
        noteElricStatus(status);
      })
      .catch(() => active && setElric('hidden'));
    return () => {
      active = false;
    };
  }, [kind]);
  const elricOn = elric === 'activity';
  // Opened as /#elric (or still on the view) while the account needs a setup step: /elric.
  // No entry (under 18, Elric off, status failed): the overview.
  useEffect(() => {
    if (view !== 'elric') return;
    if (elric === 'setup') navigate('/elric', true);
    else if (elric === 'hidden') changeView('network');
  }, [view, elric]);
  const shownNavigation = navigation.filter(
    (item) => item.id !== 'elric' || elric === 'activity' || elric === 'setup',
  );
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState('');
  const noticeTimer = useRef<number | undefined>(undefined);
  const { fresh, announcement } = useTransmutations(snapshot);
  const inboxes = useInboxSummary(true);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  function notify(message: string) {
    setNotice(message);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 6500);
  }
  // A note the last page left ("Chat deleted."): shown once the next page has rendered, whether
  // the console stayed or mounted fresh.
  useEffect(() => {
    const note = takeNextPageNote();
    if (note) notify(note);
  }, [pageContent, view]);
  async function action(key: string, fn: () => Promise<unknown>, message?: string) {
    await attempt(key, fn, message);
  }
  /** Runs an action; resolves to its error message ('' when it went through or did not run). */
  async function attempt(key: string, fn: () => Promise<unknown>, message?: string) {
    if (busy) return '';
    setBusy(key);
    setActionError('');
    try {
      await fn();
      await refresh();
      if (message) notify(message);
      return '';
    } catch (err) {
      const failure = err instanceof Error ? err.message : 'That action could not be completed.';
      setActionError(failure);
      return failure;
    } finally {
      setBusy('');
    }
  }
  function changeView(next: View) {
    if (workspaceV2) openWorkspaceView(next, operator.id);
    setView(next);
    setQuery('');
    setMobileNav(false);
  }
  const activeJobs =
    snapshot?.jobs.filter((job) => job.status === 'running' || job.status === 'queued') || [];
  const reviewJobs =
    snapshot?.jobs.filter((job) => job.status === 'completed' && job.acceptance !== 'accepted') ||
    [];
  const hasAgents = Boolean(snapshot?.agents.some((agent) => agent.status !== 'revoked'));
  const agents =
    snapshot?.agents.filter((agent) =>
      `${agent.name} ${agent.description} ${agent.capability}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) || [];
  const nameOf = (id: string) => snapshot?.agents.find((agent) => agent.id === id)?.name || 'Agent';
  const maybeName = (id: string) => snapshot?.agents.find((agent) => agent.id === id)?.name;
  // In My agents' claim sheet the page's error banner sits behind the backdrop, so a failed
  // claim is shown in the sheet instead.
  const [claimSheetError, setClaimSheetError] = useState('');
  /** The claim form; `onClaimed` runs only after a claim went through (My agents closes its sheet). */
  const claimAgentsFor = (onClaimed?: () => void) => (
    <ClaimAgents
      busy={Boolean(busy)}
      error={onClaimed ? claimSheetError : ''}
      onClaim={async (token) => {
        let claimed = false;
        if (onClaimed) setClaimSheetError('');
        const failure = await (token.startsWith('ccwclaim_')
          ? attempt(
              'claim',
              async () => {
                await api('/api/workspaces/claim', { claim_token: token });
                claimed = true;
                onWorkspacesChanged();
              },
              'AI workspace claimed. You now co-own it; switch to it from the menu at the top left.',
            )
          : attempt(
              'claim',
              async () => {
                await api('/api/agents/claim', { claim_token: token });
                claimed = true;
              },
              'The agents are now in your workspace.',
            ));
        if (claimed) onClaimed?.();
        else if (onClaimed && failure) {
          setActionError('');
          setClaimSheetError(failure);
        }
      }}
    />
  );
  const claimAgents = claimAgentsFor();
  // Connect AI's "Claim agents" opens My agents with its claim sheet (My agents v4 has no form
  // on the page); My agents clears the request once the sheet is open.
  const [claimRequested, setClaimRequested] = useState(false);
  // The network map's "Open agent", an unread chip in Messages (on the agent's Messages) and a new
  // template agent show that agent in My agents' pane.
  const [agentRequested, setAgentRequested] = useState<AgentRequest | null>(null);
  const showAgent = (id: string, screen?: 'messages') => {
    if (view !== 'agents') changeView('agents');
    setAgentRequested({ id, screen });
  };
  const agentsFooter = (
    <>
      <div className="list-panel-footer">
        <span>Adds 3 example agents. Scripted, no AI. Remove anytime.</span>
        <button
          className="text-link"
          disabled={Boolean(busy)}
          onClick={() =>
            void action('demo', () => api('/api/demo/start', {}), 'The CC agents are ready.')
          }
        >
          Generate your first CC agents
          <Play size={13} />
        </button>
      </div>
      {claimAgents}
    </>
  );
  const signOut = () =>
    void action('logout', async () => {
      await api('/api/auth/logout', {});
      // Cached conversations and the prefetch stay on this device otherwise.
      forgetMessagesState();
      // A message typed for Elric before signing in must not reach the next person.
      clearPendingDraft();
      onLogout();
    });
  const workspaceSelect =
    workspaces.length > 1 ? (
      <select
        className="workspace-select"
        aria-label="Switch workspace"
        value={operator.id}
        onChange={(event) => onSwitch(event.target.value)}
      >
        {workspaces.map((item) => (
          <option key={item.id} value={item.id}>
            {item.kind === 'ai' ? `${item.name} (AI workspace)` : `${item.name} (yours)`}
          </option>
        ))}
      </select>
    ) : null;
  const accountDetail = kind === 'ai' ? 'AI workspace · you co-own it' : 'Private workspace';
  const accountControls = (
    <div className="sidebar-bottom">
      <div className="sidebar-account">
        <span>Theme</span>
        <ThemeToggle />
      </div>
      <button className="signout" disabled={refreshing} onClick={() => void refresh()}>
        <RefreshCw size={15} className={refreshing ? 'spin' : ''} aria-hidden="true" />
        Refresh
      </button>
      <button className="signout" disabled={Boolean(busy)} onClick={signOut}>
        <LogOut size={15} aria-hidden="true" />
        Sign out
      </button>
    </div>
  );
  // Workspace v2 Advanced views (Research & review, Agent permissions, Network map) take the
  // Rooms v2 look from advanced-v2.css; their markup, data and actions stay the same.
  const advancedV2 =
    workspaceV2 && (view === 'network' || view === 'collaborations' || view === 'connections');
  // Workspace v2 Settings sections render their own header and section rail.
  const settingsSection = workspaceV2 && isSettingsSection(view) ? view : null;
  const heading =
    workspaceV2 && view === 'activity'
      ? { title: 'Activity log', lede: 'Recent events in this workspace.' }
      : workspaceV2 && view === 'messages'
        ? {
            title: 'Messages',
            lede: 'Private messages from rooms, and conversations between your agents.',
          }
        : workspaceV2 &&
            (view === 'network' ||
              view === 'collaborations' ||
              view === 'connections' ||
              view === 'connect')
          ? {
              title: previewTitles[view],
              // The v2 Network map shows only the map, so its lede names only agents and routes.
              lede:
                view === 'network'
                  ? 'Your agents and who can send work to whom.'
                  : view === 'connect'
                    ? 'Add Central City to your AI app once. After that, you only paste room links.'
                    : headings[view].lede,
            }
          : workspaceV2 && view === 'agents'
            ? { title: 'Your agents', lede: headings.agents.lede }
            : headings[view];
  const headerTitle =
    pageTitle ??
    (workspaceV2 ? previewTitles[view] : undefined) ??
    navigation.find((item) => item.id === view)?.label ??
    'Workspace';
  // The preview's console views name the tab after the view, as its menu does. Pages shown inside
  // the console (pageContent) set their own title.
  useEffect(() => {
    if (!workspaceV2 || pageContent) return;
    return applyPageTitle(document, `${headerTitle} · Central City`);
  }, [workspaceV2, pageContent, headerTitle]);
  return (
    // data-live: the live event stream is connected (no header label shows it: WORKSPACE_V3 §6).
    <div
      className="app-shell"
      data-workspace={workspaceV2 ? 'v2' : undefined}
      data-live={streamLive ? 'true' : 'false'}
    >
      {pageContent ? (
        <a
          className="skip-link"
          href="#workspace-page-content"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById('workspace-page-content')?.focus();
          }}
        >
          Skip to content
        </a>
      ) : (
        <SkipLink />
      )}
      {mobileNav ? (
        <button
          className="nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      ) : null}
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        {!workspaceV2 ? (
          <>
            <Lockup onClick={() => changeView('network')} label="Central City overview" />
            <div className="workspace-switch">
              <span className="workspace-avatar" aria-hidden="true">
                {operator.name.slice(0, 1).toUpperCase()}
              </span>
              <div>
                <strong>{operator.name}</strong>
                <span>{accountDetail}</span>
              </div>
              <LockKeyhole size={13} aria-hidden="true" />
              {workspaceSelect}
            </div>
          </>
        ) : null}
        {workspaceV2 ? (
          <WorkspaceNavigation
            workspaceId={operator.id}
            accountName={operator.name}
            accountDetail={accountDetail}
            workspaceSwitch={workspaceSelect}
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            signingOut={Boolean(busy)}
            onSignOut={signOut}
            paused={snapshot ? snapshot.paused : null}
            pausing={Boolean(busy)}
            onTogglePause={() => {
              if (!snapshot) return;
              void action(
                'pause',
                () => api('/api/workspace/pause', { paused: !snapshot.paused }),
                snapshot.paused
                  ? 'Workspace resumed.'
                  : 'Workspace paused. No new work starts until you resume.',
              );
            }}
            view={pageContent ? null : view}
            unreadMessages={inboxes.total}
            onView={changeView}
            showElric={elric === 'activity' || elric === 'setup'}
            mobileOpen={mobileNav}
            onClose={closeNavigation}
          />
        ) : (
          <>
            <p className="nav-label">Workspace</p>
            <nav aria-label="Workspace">
              <a
                className="nav-item"
                href="/rooms"
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
                  event.preventDefault();
                  navigate('/rooms');
                }}
              >
                <DoorOpen size={18} strokeWidth={1.6} aria-hidden="true" />
                <span>Rooms</span>
              </a>
              {shownNavigation.map((item) => (
                <button
                  key={item.id}
                  className={`nav-item ${view === item.id ? 'active' : ''} ${item.id === 'connect' ? 'nav-connect' : ''}`}
                  aria-current={view === item.id ? 'page' : undefined}
                  aria-describedby={
                    item.id === 'jobs' && activeJobs.length + reviewJobs.length
                      ? 'exchange-count'
                      : undefined
                  }
                  onClick={() => {
                    if (item.id === 'elric' && elric === 'setup') navigate('/elric');
                    else changeView(item.id);
                  }}
                >
                  <item.icon size={18} strokeWidth={1.6} aria-hidden="true" />
                  <span>{item.label}</span>
                  {item.id === 'messages' && inboxes.total ? (
                    <span className="nav-count" aria-label={unreadMessagesLabel(inboxes.total)}>
                      {inboxes.total}
                    </span>
                  ) : null}
                  {item.id === 'jobs' && activeJobs.length + reviewJobs.length ? (
                    <>
                      <span className="nav-count" aria-hidden="true">
                        {activeJobs.length + reviewJobs.length}
                      </span>
                      <span id="exchange-count" className="visually-hidden" aria-hidden="true">
                        {activeJobs.length} open, {reviewJobs.length} to review
                      </span>
                    </>
                  ) : null}
                </button>
              ))}
            </nav>
            <div className="sidebar-note">
              <AgentGlyph agent={{ capability: 'research' }} />
              <h3>Work with your AI.</h3>
              <p>Invite it into a room, or add an agent of your own.</p>
              <a
                className="text-link"
                href={INVITE_ROOMS_PATH}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
                  event.preventDefault();
                  navigate(INVITE_ROOMS_PATH);
                }}
              >
                Invite your AI
                <ArrowUpRight size={14} />
              </a>
              <button className="text-link" onClick={() => setDialog({ kind: 'create' })}>
                Add an agent
                <ArrowUpRight size={14} />
              </button>
            </div>
          </>
        )}
        {!workspaceV2 ? accountControls : null}
      </aside>
      <div className="workspace-content">
        {/* Messages' own pill already names the page on a phone: the top row shows only ☰. */}
        <AppHeader
          title={headerTitle}
          showTitle={!(workspaceV2 && !pageContent && (view === 'messages' || view === 'agents'))}
          onOpenNavigation={() => setMobileNav(true)}
        />
        {pageContent ? (
          <PageArea page={pageTitle}>{pageContent}</PageArea>
        ) : (
          <main
            id="main-content"
            tabIndex={-1}
            className={`main-content${advancedV2 ? ' adv2' : ''}`}
            data-adv2-view={advancedV2 ? view : undefined}
          >
            {/* Settings sections and Messages (its floating top bar) render their own header. */}
            {settingsSection ||
            (workspaceV2 && (view === 'messages' || view === 'agents')) ? null : (
              <div className="page-heading">
                <div>
                  {/* The calm canvas (Workspace v3) has no breadcrumb label above the title;
                      Elric keeps its header for its own design track. */}
                  {!workspaceV2 || view === 'elric' ? (
                    <p className="page-kicker">
                      Central City / {kind === 'ai' ? 'AI workspace' : 'Private workspace'}
                    </p>
                  ) : null}
                  {/* The Elric view shows nothing until the account may use it (no flash). */}
                  {view !== 'elric' || elricOn ? (
                    <>
                      <h1>{heading.title}</h1>
                      <p>{heading.lede}</p>
                    </>
                  ) : null}
                </div>
                <div className="page-actions">
                  {view === 'connections' ? (
                    <button
                      className="button primary"
                      onClick={() => setDialog({ kind: 'connection' })}
                      disabled={!hasAgents}
                    >
                      <Plus size={16} />
                      New connection
                    </button>
                  ) : view === 'jobs' ? (
                    <button
                      className="button primary"
                      onClick={() => setDialog({ kind: 'job' })}
                      disabled={!hasAgents || snapshot?.paused}
                    >
                      <Plus size={16} />
                      Send work
                    </button>
                  ) : view === 'collaborations' ||
                    view === 'messages' ||
                    view === 'assistants' ||
                    view === 'elric' ||
                    view === 'connect' ||
                    (workspaceV2 &&
                      (view === 'data' || view === 'activity' || view === 'agents')) ? null : (
                    <>
                      <button className="button secondary" onClick={() => changeView('jobs')}>
                        <Scale size={16} />
                        Exchanges
                      </button>
                      <button
                        className="button primary"
                        onClick={() => setDialog({ kind: 'create' })}
                      >
                        <Plus size={16} />
                        Add agent
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
            {error || actionError ? (
              <div className="error-banner" role="alert">
                <CircleHelp size={17} aria-hidden="true" />
                <span>{actionError || error}</span>
                <button
                  className="icon-button"
                  aria-label="Dismiss error"
                  onClick={() => {
                    setActionError('');
                    void refresh();
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            ) : null}
            {snapshot?.paused ? (
              <div className="pause-banner">
                <Pause size={16} aria-hidden="true" />
                <span>
                  <strong>Workspace paused.</strong> No new work starts. Agents on your own
                  computers may keep running, but their results wait until you resume.
                </span>
                <button
                  className="button secondary compact"
                  onClick={() =>
                    void action(
                      'resume',
                      () => api('/api/workspace/pause', { paused: false }),
                      'Workspace resumed.',
                    )
                  }
                  disabled={Boolean(busy)}
                >
                  Resume workspace
                  <Play size={14} />
                </button>
              </div>
            ) : null}
            {settingsSection ? (
              <SettingsLayout
                section={settingsSection}
                onSection={(next) =>
                  next === 'account' ? navigate('/settings/account') : changeView(next)
                }
              >
                {settingsSection === 'data' ? (
                  <DataExport operatorId={operator.id} />
                ) : settingsSection === 'activity' ? (
                  <ActivityLog
                    snapshot={snapshot}
                    refreshing={refreshing}
                    error={error}
                    onRefresh={refresh}
                    onJob={(id) => setDialog({ kind: 'result', id })}
                    onExport={() => changeView('data')}
                  />
                ) : (
                  <>
                    {kind === 'ai' ? <WorkspaceKeys workspaceName={operator.name} /> : null}
                    <AssistantAccess key={operator.id} onConnect={() => changeView('connect')} />
                  </>
                )}
              </SettingsLayout>
            ) : view === 'connect' ? (
              <ConnectAIApp
                key={operator.id}
                onOpenAgents={() => {
                  changeView('agents');
                  setClaimRequested(true);
                }}
                onOpenConnectedApps={() => changeView('assistants')}
                connectedAppsLabel={workspaceV2 ? 'Settings → Connected apps' : 'Connected AI apps'}
              />
            ) : !snapshot ? (
              <div className="loading-panel" role="status">
                <LoaderCircle className="spin" />
                <p>Loading your agents…</p>
              </div>
            ) : (
              <>
                {view === 'network' && workspaceV2 ? (
                  <NetworkMap
                    agents={snapshot.agents}
                    connections={snapshot.connections}
                    onOpenAgent={(id) => showAgent(id)}
                    onOpenPermissions={() => changeView('connections')}
                    onOpenAgents={() => changeView('agents')}
                  />
                ) : view === 'network' ? (
                  <>
                    <div className="stats-grid">
                      <Stat
                        label="Agents online"
                        value={snapshot.stats.reachable}
                        icon={<Radio size={17} />}
                        detail={`${snapshot.stats.registered} in your workspace`}
                      />
                      <Stat
                        label="Work in progress"
                        value={activeJobs.length}
                        icon={<Scale size={17} />}
                        detail={`${reviewJobs.length} waiting for your review`}
                      />
                      <Stat
                        label="Accepted results"
                        value={snapshot.stats.accepted}
                        icon={<CheckCheck size={17} />}
                        detail="Accepted by you, CC agents included"
                      />
                      <Stat
                        label="Connections"
                        value={snapshot.connections.length}
                        icon={<Link2 size={17} />}
                        detail="One-way routes you allowed"
                      />
                    </div>
                    {/* Workspace v2 Network map shows only the counts and the map; agents, activity and
                        connecting your AI each have their own page. */}
                    <div className={workspaceV2 ? 'network-layout map-only' : 'network-layout'}>
                      <section className="panel network-panel" aria-labelledby="circle-title">
                        <div className="panel-heading">
                          <div className="panel-title">
                            <h2 id="circle-title">Agent map</h2>
                            <span className="small-tag">Private</span>
                          </div>
                          <div className="graph-tools">
                            <button
                              className="icon-button"
                              onClick={() => setDialog({ kind: 'connection' })}
                              disabled={!hasAgents}
                              aria-label="Add connection"
                            >
                              <Link2 size={16} />
                            </button>
                            <button
                              className="icon-button"
                              aria-label="View all agents"
                              onClick={() => changeView('agents')}
                            >
                              <ArrowUpRight size={17} />
                            </button>
                          </div>
                        </div>
                        {snapshot.agents.some((agent) => !agent.revokedAt) ? (
                          <CityCircle
                            agents={snapshot.agents}
                            connections={snapshot.connections}
                            selectedId={null}
                            onSelect={(id) => showAgent(id)}
                            fresh={fresh}
                            labels={(agent) => ({
                              name:
                                agent.name.length > 18 ? `${agent.name.slice(0, 17)}…` : agent.name,
                              detail: `${capabilityLabels[agent.capability]}${agent.isDemo ? ' · demo' : ''}`,
                              aria: `${agent.name}, ${agent.pausedAt ? 'paused' : agent.status}, ${capabilityLabels[agent.capability]}. ${creatorLabel(agent, maybeName)}. View agent.`,
                            })}
                          />
                        ) : (
                          <div className="graph-empty" role={workspaceV2 ? 'status' : undefined}>
                            <CourtIllustration />
                            <p>Start with one agent.</p>
                            <span>
                              Add an agent, connect your AI, or generate your first CC agents.
                            </span>
                          </div>
                        )}
                        <div className="graph-legend">
                          <span>
                            <AgentGlyph agent={{ capability: 'research' }} size="small" /> Research
                          </span>
                          <span>
                            <AgentGlyph agent={{ capability: 'extract' }} size="small" /> Extraction
                          </span>
                          <span>
                            <AgentGlyph agent={{ capability: 'verify' }} size="small" />{' '}
                            Verification
                          </span>
                          <span>
                            <span className="legend-line" aria-hidden="true" />
                            Connection
                          </span>
                          <span className="graph-limit">
                            {snapshot.agents.filter((agent) => !agent.revokedAt).length > 24
                              ? 'First 24 agents shown'
                              : 'Inner rings: created by another agent · Seal: created by an AI'}
                          </span>
                        </div>
                        <div className="network-footer">
                          <span>
                            <ShieldCheck size={14} aria-hidden="true" />
                            Online means the agent checked in during the last 90 seconds.
                          </span>
                        </div>
                      </section>
                      {workspaceV2 ? null : (
                        <section className="panel activity-panel" aria-labelledby="activity-title">
                          <div className="panel-heading">
                            <div className="panel-title">
                              <Activity size={16} aria-hidden="true" />
                              <h2 id="activity-title">Recent activity</h2>
                            </div>
                          </div>
                          <EventList
                            snapshot={snapshot}
                            limit={5}
                            compact
                            onJob={(id) => setDialog({ kind: 'result', id })}
                          />
                          <div className="panel-bottom">
                            <TextLink onClick={() => changeView('activity')}>All activity</TextLink>
                          </div>
                        </section>
                      )}
                    </div>
                    {workspaceV2 ? null : (
                      <div className="lower-layout">
                        <section className="panel roster-panel">
                          <SectionHeading
                            eyebrow="Agents"
                            title="Your agents"
                            action={
                              <TextLink onClick={() => changeView('agents')}>View all</TextLink>
                            }
                          />
                          {snapshot.agents.length ? (
                            <AgentRows
                              agents={snapshot.agents.slice(0, 4)}
                              onSelect={(id) => showAgent(id)}
                              fresh={fresh}
                            />
                          ) : (
                            <div className="first-agents">
                              <div className="stacked-glyphs" aria-hidden="true">
                                <AgentGlyph agent={{ capability: 'research' }} />
                                <AgentGlyph agent={{ capability: 'extract' }} />
                                <AgentGlyph agent={{ capability: 'verify' }} />
                              </div>
                              <div>
                                <h3>Meet your first collaborators.</h3>
                                <p>Adds 3 example agents. Watch a task move between them.</p>
                                <span className="field-note">Scripted. No AI model is used.</span>
                              </div>
                              <button
                                className="button secondary"
                                disabled={Boolean(busy)}
                                onClick={() =>
                                  void action(
                                    'demo',
                                    () => api('/api/demo/start', {}),
                                    'The three CC agents are ready. Send them some work to begin.',
                                  )
                                }
                              >
                                <Play size={14} />
                                {busy === 'demo' ? 'Generating…' : 'Generate your first CC agents'}
                              </button>
                            </div>
                          )}
                        </section>
                        <section className="next-step-panel" aria-labelledby="next-step-title">
                          <p className="eyebrow">Next step</p>
                          <h2 id="next-step-title">Bring your AI in.</h2>
                          <p>
                            Connect ChatGPT, Claude, Cursor or Codex once. Your AI can join rooms,
                            plan teams and create agents; you make the decisions.
                          </p>
                          <button className="button primary" onClick={() => changeView('connect')}>
                            <Plug size={16} />
                            Connect your AI
                          </button>
                        </section>
                      </div>
                    )}
                  </>
                ) : null}
                {view === 'agents' && workspaceV2 ? (
                  <MyAgentsV2
                    snapshot={snapshot}
                    busy={Boolean(busy)}
                    run={action}
                    onChanged={() => void refresh()}
                    dialogOpen={dialog !== null}
                    onAddAgent={() => setDialog({ kind: 'create' })}
                    onExchanges={() => changeView('jobs')}
                    elricAgentId={elricAgentId}
                    elricStatus={elricStatus}
                    onElricStatus={setElricStatus}
                    onOpenElric={(place) => {
                      if (place === 'activity') return changeView('elric');
                      // Elric's chat: a page change inside the workspace, as from the sidebar.
                      markInAppChange();
                      navigate('/elric');
                    }}
                    onOpenRoom={(id) => {
                      // An agent's private chat: its room's page, as from the sidebar.
                      markInAppChange();
                      navigate('/rooms/' + encodeURIComponent(id));
                    }}
                    claimForm={claimAgentsFor}
                    claimRequested={claimRequested}
                    onClaimOpened={() => setClaimRequested(false)}
                    agentRequested={agentRequested}
                    onAgentOpened={() => setAgentRequested(null)}
                    onTryExamples={() =>
                      void action(
                        'demo',
                        () => api('/api/demo/start', {}),
                        'The CC agents are ready.',
                      )
                    }
                  />
                ) : view === 'agents' ? (
                  <section className="panel" aria-label="Agents">
                    <div className="list-toolbar">
                      <div className="filter-label">
                        <Layers3 size={16} aria-hidden="true" />
                        All agents<span>{snapshot.agents.length}</span>
                      </div>
                      <label className="search-field">
                        <Search size={16} aria-hidden="true" />
                        <input
                          aria-label="Search agents"
                          placeholder="Search agents…"
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                        />
                      </label>
                    </div>
                    {agents.length ? (
                      <div className="agent-card-grid">
                        {agents.map((agent) => (
                          <AgentCard
                            key={agent.id}
                            agent={agent}
                            transmuting={fresh.has(agent.id)}
                            parentName={
                              agent.parentAgentId ? maybeName(agent.parentAgentId) : undefined
                            }
                            provenance={creatorLabel(agent, maybeName)}
                            onOpen={() => showAgent(agent.id)}
                          />
                        ))}
                      </div>
                    ) : (
                      <EmptyState title={query ? 'No matching agents' : 'Add your first agent'}>
                        {query
                          ? 'Try a different name or capability.'
                          : 'Start from a template, connect your AI, or run an agent on your own computer.'}
                      </EmptyState>
                    )}
                    {agentsFooter}
                  </section>
                ) : null}
                {view === 'collaborations' ? (
                  <Workflows snapshot={snapshot} refresh={refresh} v2={workspaceV2} />
                ) : null}
                {view === 'messages' ? (
                  <MessagesView
                    snapshot={snapshot}
                    unread={inboxes.unread}
                    onOpenAgent={(id) => showAgent(id, 'messages')}
                    onSummaryChanged={() => void inboxes.refresh()}
                    direct={direct}
                    onOpenConnections={() => changeView('connections')}
                  />
                ) : null}
                {view === 'elric' && elricOn ? (
                  <Suspense fallback={null}>
                    <ElricActivity />
                  </Suspense>
                ) : null}
                {view === 'assistants' ? (
                  <>
                    {kind === 'ai' ? <WorkspaceKeys workspaceName={operator.name} /> : null}
                    <AssistantAccess key={operator.id} onConnect={() => changeView('connect')} />
                  </>
                ) : null}
                {view === 'connections' ? (
                  <>
                    <section className="panel" aria-label="Connections">
                      <div className="list-toolbar">
                        <div className="filter-label">
                          <Link2 size={16} aria-hidden="true" />
                          Connections<span>{snapshot.connections.length}</span>
                        </div>
                        <span className="muted small">
                          A connection lets one agent send work to another. It shares no tools or
                          passwords.
                        </span>
                      </div>
                      {snapshot.connections.length ? (
                        <div className="connection-list">
                          {snapshot.connections.map((connection) => {
                            const from = snapshot.agents.find(
                              (agent) => agent.id === connection.fromAgentId,
                            );
                            const to = snapshot.agents.find(
                              (agent) => agent.id === connection.toAgentId,
                            );
                            return (
                              <div className="connection-row" key={connection.id}>
                                <div className="connection-path">
                                  <span>
                                    {from ? <AgentGlyph agent={from} /> : null}
                                    <strong>{nameOf(connection.fromAgentId)}</strong>
                                  </span>
                                  <svg className="route-arc" viewBox="0 0 64 24" aria-hidden="true">
                                    <path d="M4 18 Q32 -2 58 16" />
                                    <path d="M52 11 L58 16 L51 19" />
                                  </svg>
                                  <span className="visually-hidden">sends work to</span>
                                  <span>
                                    {to ? <AgentGlyph agent={to} /> : null}
                                    <strong>{nameOf(connection.toAgentId)}</strong>
                                  </span>
                                </div>
                                <span className="connection-capability">
                                  {to ? capabilityLabels[to.capability] : ''}
                                </span>
                                <div className="row-actions">
                                  <button
                                    className="button secondary compact"
                                    disabled={snapshot.paused}
                                    onClick={() =>
                                      setDialog({ kind: 'job', connectionId: connection.id })
                                    }
                                  >
                                    Send work
                                    <ArrowUpRight size={14} />
                                  </button>
                                  <button
                                    className="icon-button danger-text"
                                    disabled={Boolean(busy)}
                                    aria-label={`Remove connection from ${nameOf(connection.fromAgentId)} to ${nameOf(connection.toAgentId)}`}
                                    onClick={() =>
                                      void action(
                                        connection.id,
                                        () =>
                                          api(`/api/connections/${connection.id}`, {}, 'DELETE'),
                                        'Connection removed. No new work can be sent this way.',
                                      )
                                    }
                                  >
                                    <Unplug size={16} />
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <EmptyState
                          icon={<Link2 size={25} />}
                          title="Connect two agents"
                          live={workspaceV2}
                          action={
                            <button
                              className="button primary"
                              disabled={!hasAgents}
                              onClick={() => setDialog({ kind: 'connection' })}
                            >
                              <Plus size={15} />
                              New connection
                            </button>
                          }
                        >
                          Choose which agent asks and which one does the work. Work only travels in
                          the direction you allow.
                        </EmptyState>
                      )}
                    </section>
                    <CrossWorkspaceConnections
                      agents={snapshot.agents}
                      onChanged={() => void refresh()}
                    />
                  </>
                ) : null}
                {view === 'jobs' ? (
                  <ExchangeLedger
                    snapshot={snapshot}
                    nameOf={nameOf}
                    onOpen={(id) => setDialog({ kind: 'result', id })}
                    empty={
                      <EmptyState
                        icon={<ExchangeCircle state="requested" />}
                        title="No exchanges yet"
                        action={
                          <button
                            className="button primary"
                            disabled={!hasAgents || snapshot.paused}
                            onClick={() => setDialog({ kind: 'job' })}
                          >
                            <Plus size={15} />
                            Send work
                          </button>
                        }
                      >
                        Send some text from one connected agent to another. Check what comes back,
                        then decide whether to accept it.
                      </EmptyState>
                    }
                  />
                ) : null}
                {view === 'activity' ? (
                  <section className="panel full-activity" aria-label="Activity">
                    <div className="list-toolbar">
                      <div className="filter-label">
                        <Activity size={16} aria-hidden="true" />
                        Activity<span>{snapshot.events.length}</span>
                      </div>
                      <span className="muted small">
                        The latest 100 events · only you can see them
                      </span>
                    </div>
                    <EventList
                      snapshot={snapshot}
                      onJob={(id) => setDialog({ kind: 'result', id })}
                    />
                  </section>
                ) : null}
              </>
            )}
          </main>
        )}
      </div>
      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
      <div className="toast-region" aria-live="polite" aria-atomic="true">
        {notice ? (
          <div className="toast">
            <Check size={17} aria-hidden="true" />
            <span>{notice}</span>
            <button
              className="icon-button"
              onClick={() => setNotice('')}
              aria-label="Dismiss notification"
            >
              <X size={15} />
            </button>
          </div>
        ) : null}
      </div>
      {dialog && snapshot ? (
        <Dialogs
          dialog={dialog}
          snapshot={snapshot}
          setDialog={setDialog}
          onShowAgent={showAgent}
          onChanged={async (message) => {
            await refresh();
            if (message) notify(message);
          }}
        />
      ) : null}
    </div>
  );
}

interface ClaimPreview {
  workspace: { name: string; agents: number };
  active_keys: Array<{ label: string; scopes: string[]; primary: boolean }>;
}
/** The one-time code inside a claim link (#claim=…). */
const CLAIM_CODE = /ccw?claim_[A-Za-z0-9_-]{43}/;

/** Claims agents an AI created without an account, from the claim link it gave the person. */
function ClaimAgents({
  busy,
  error = '',
  onClaim,
}: {
  busy: boolean;
  /** A failed claim, shown with the form (in a sheet the page's banner is hidden). */
  error?: string;
  onClaim: (token: string) => Promise<void>;
}) {
  const [token, setToken] = useState(
    () => /^#claim=(ccw?claim_[A-Za-z0-9_-]{43})$/.exec(window.location.hash)?.[1] ?? '',
  );
  const [preview, setPreview] = useState<{ token: string; data: ClaimPreview } | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [previewError, setPreviewError] = useState('');
  const workspaceV2 = useWorkspaceV2();
  useEffect(() => {
    const consumeClaim = () => {
      if (!window.location.hash.startsWith('#claim=')) return;
      const value = /^#claim=(ccw?claim_[A-Za-z0-9_-]{43})$/.exec(window.location.hash)?.[1] ?? '';
      tokenRef.current = value;
      setToken(value);
      setPreview(null);
      setPreviewError('');
      // Keep the one-time token out of the address and history after reading it.
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search,
      );
    };
    consumeClaim();
    if (!workspaceV2) return;
    window.addEventListener('hashchange', consumeClaim);
    return () => window.removeEventListener('hashchange', consumeClaim);
  }, [workspaceV2]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    // People paste the whole claim link their AI gave them; the one-time code is inside it.
    const value = codeFromPaste(token, CLAIM_CODE);
    if (!value) return;
    // An AI workspace is claimed only after the person has seen which AI keys keep access.
    // The preview is bound to the exact token it was fetched for; a late response for an
    // earlier token is dropped, so a person never confirms a claim they have not previewed.
    if (value.startsWith('ccwclaim_') && preview?.token !== value) {
      setPreviewError('');
      try {
        const data = await api<ClaimPreview>('/api/workspaces/claim/preview', {
          claim_token: value,
        });
        if (codeFromPaste(tokenRef.current, CLAIM_CODE) === value)
          setPreview({ token: value, data });
      } catch (err) {
        if (codeFromPaste(tokenRef.current, CLAIM_CODE) === value)
          setPreviewError(
            err instanceof Error ? err.message : 'This claim link could not be checked.',
          );
      }
      return;
    }
    await onClaim(value);
    setToken('');
    setPreview(null);
  }
  return (
    <form className="claim-form" onSubmit={(event) => void submit(event)}>
      <ExchangeCircle state={token ? 'review' : 'requested'} size="small" />
      <div className="claim-fields">
        <label htmlFor="claim-token">Claim agents your AI created</label>
        <div className="claim-row">
          <input
            id="claim-token"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the claim link"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              setPreview(null);
            }}
          />
          <button className="button primary compact" type="submit" disabled={busy || !token.trim()}>
            {preview && preview.token === codeFromPaste(token, CLAIM_CODE)
              ? 'Confirm claim'
              : 'Claim'}
          </button>
        </div>
        {previewError || error ? (
          <p className="form-error" role="alert">
            {previewError || error}
          </p>
        ) : null}
        {preview && preview.token === codeFromPaste(token, CLAIM_CODE) ? (
          <div className="claim-preview" role="status">
            <strong>
              {preview.data.workspace.name}: an AI workspace with {preview.data.workspace.agents}{' '}
              agent
              {preview.data.workspace.agents === 1 ? '' : 's'}
            </strong>
            <p>
              These AIs keep their access after you claim it. Once you co-own it, remove any you
              don't trust under AI connections:
            </p>
            <ul>
              {preview.data.active_keys.map((key, index) => (
                <li key={index}>
                  {key.label}
                  {key.primary ? ' (main key)' : ''} · {key.scopes.map(permissionLabel).join(', ')}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <span className="muted small">
          Moves the agents, their connections and history into this workspace. A claim link for a
          whole AI workspace makes you its co-owner instead. Each link works once.
        </span>
      </div>
    </form>
  );
}

function Stat({
  label,
  value,
  icon,
  detail,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  detail: string;
}) {
  return (
    <div className="stat">
      <div className="stat-top">
        <span>{label}</span>
        <span aria-hidden="true">{icon}</span>
      </div>
      <strong>{value.toString().padStart(2, '0')}</strong>
      <p>{detail}</p>
    </div>
  );
}

/** The ring drawn over a new agent's card before it resolves into the card. */
function TransmuteRing({ capability }: { capability: Capability }) {
  const sides = capabilityFigure[capability];
  return (
    <svg className="transmute-ring" viewBox="-50 -50 100 100" aria-hidden="true">
      <circle r="46" pathLength={1} />
      <circle r="38" pathLength={1} className="inner" />
      <polygon
        pathLength={1}
        points={
          sides === 'triangle'
            ? '0,-38 32.9,19 -32.9,19'
            : sides === 'square'
              ? '26.9,-26.9 26.9,26.9 -26.9,26.9 -26.9,-26.9'
              : '0,-38 32.9,-19 32.9,19 0,38 -32.9,19 -32.9,-19'
        }
      />
    </svg>
  );
}

function AgentCard({
  agent,
  transmuting,
  parentName,
  provenance,
  onOpen,
}: {
  agent: Agent;
  transmuting: boolean;
  parentName?: string;
  provenance: string;
  onOpen: () => void;
}) {
  const depth = lineageDepth(agent);
  return (
    <button className={`agent-card ${transmuting ? 'transmuting' : ''}`} onClick={onOpen}>
      {transmuting ? <TransmuteRing capability={agent.capability} /> : null}
      <div className="agent-card-top">
        <AgentGlyph agent={agent} size="large" transmuting={transmuting} />
        <ArrowUpRight size={17} aria-hidden="true" />
      </div>
      <h3>{agent.name}</h3>
      <p>{agent.description || `${capabilityLabels[agent.capability]} specialist`}</p>
      <div className="agent-card-tags">
        <span className="small-tag">{capabilityLabels[agent.capability]}</span>
        {agent.isDemo ? (
          <span className="small-tag demo">CC</span>
        ) : (
          <span className="small-tag">Your own</span>
        )}
        {aiCreated(agent) ? <span className="small-tag ai">AI-created</span> : null}
        {agent.pausedAt ? <span className="small-tag">Paused</span> : null}
      </div>
      <dl className="lineage">
        <div>
          <dt>Created</dt>
          <dd>{provenance}</dd>
        </div>
        {agent.parentAgentId ? (
          <div>
            <dt>Under</dt>
            <dd>
              {parentName ?? 'An agent not listed here'} · level {depth}
            </dd>
          </div>
        ) : null}
        {agent.claimedAt ? (
          <div>
            <dt>Claimed</dt>
            <dd>{formatDate(agent.claimedAt)}</dd>
          </div>
        ) : null}
      </dl>
      <div className="agent-card-footer">
        <Status value={agent.pausedAt ? 'paused' : agent.status} />
        <span>{agent.lastSeenAt ? `Seen ${formatTime(agent.lastSeenAt)}` : 'Not seen yet'}</span>
      </div>
    </button>
  );
}

function AgentRows({
  agents,
  onSelect,
  fresh,
}: {
  agents: Agent[];
  onSelect: (id: string) => void;
  fresh: Set<string>;
}) {
  return (
    <div className="agent-rows">
      {agents.map((agent) => (
        <button key={agent.id} className="agent-row" onClick={() => onSelect(agent.id)}>
          <AgentGlyph agent={agent} transmuting={fresh.has(agent.id)} />
          <span className="agent-row-name">
            <strong>{agent.name}</strong>
            <span>{capabilityLabels[agent.capability]}</span>
          </span>
          {agent.isDemo ? (
            <span className="small-tag demo">CC</span>
          ) : aiCreated(agent) ? (
            <span className="small-tag ai">AI-created</span>
          ) : (
            <span className="small-tag">Your own</span>
          )}
          <Status value={agent.pausedAt ? 'paused' : agent.status} />
          <ArrowUpRight size={16} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

function returnedSummary(job: Job) {
  if (job.acceptance === 'accepted') return 'Result accepted';
  if (job.status === 'completed') return job.output ? 'Result ready' : 'Done';
  if (job.status === 'failed') return job.error ?? 'No result';
  if (job.status === 'canceled') return 'Nothing returned';
  if (job.status === 'running') return 'In progress';
  return 'Not yet';
}

const ledgerStates: ExchangeState[] = [
  'requested',
  'in_progress',
  'review',
  'accepted',
  'failed',
  'canceled',
];

function ExchangeLedger({
  snapshot,
  nameOf,
  onOpen,
  empty,
}: {
  snapshot: Snapshot;
  nameOf: (id: string) => string;
  onOpen: (id: string) => void;
  empty: ReactNode;
}) {
  return (
    <section className="panel ledger" aria-label="Exchanges">
      <div className="list-toolbar">
        <div className="filter-label">
          <Scale size={16} aria-hidden="true" />
          Exchanges<span>{snapshot.jobs.length}</span>
        </div>
        <span className="small muted">The latest 50 · a finished result still needs your OK</span>
      </div>
      <ul className="ledger-legend" aria-label="What each state means">
        {ledgerStates.map((state) => (
          <li key={state}>
            <ExchangeCircle state={state} size="small" />
            {exchangeLabels[state]}
          </li>
        ))}
      </ul>
      {snapshot.jobs.length ? (
        <div className="ledger-list">
          <div className="ledger-head" aria-hidden="true">
            <span />
            <span>Sent</span>
            <span>Came back</span>
            <span>State</span>
            <span>Started</span>
          </div>
          {snapshot.jobs.map((job) => {
            const state = jobExchangeState(job);
            return (
              <button
                className={`exchange-row state-${state}`}
                key={job.id}
                onClick={() => onOpen(job.id)}
              >
                <ExchangeCircle state={state} size="small" />
                <span className="exchange-side given">
                  <strong>
                    {job.input.slice(0, 75)}
                    {job.input.length > 75 ? '…' : ''}
                  </strong>
                  <span>
                    {nameOf(job.requesterId)} · {budgetLabel(job)}
                    {job.isDemo ? <span className="small-tag demo">CC</span> : null}
                  </span>
                </span>
                <span className="exchange-side returned">
                  <strong>{returnedSummary(job)}</strong>
                  <span>{nameOf(job.providerId)}</span>
                </span>
                <span className={`exchange-state state-${state}`}>{exchangeLabels[state]}</span>
                <span className="job-row-time">{formatDate(job.createdAt)}</span>
              </button>
            );
          })}
        </div>
      ) : (
        empty
      )}
    </section>
  );
}

function EventList({
  snapshot,
  limit,
  compact = false,
  onJob,
}: {
  snapshot: Snapshot;
  limit?: number;
  compact?: boolean;
  onJob: (id: string) => void;
}) {
  const events = limit ? snapshot.events.slice(0, limit) : snapshot.events;
  if (!events.length)
    return (
      <div className="activity-empty">
        <Radio size={25} strokeWidth={1.3} aria-hidden="true" />
        <h3>Nothing yet.</h3>
        <p>New agents, connections and work will appear here as they happen.</p>
      </div>
    );
  return (
    <ol className={`event-list ${compact ? 'compact' : ''}`}>
      {events.map((event) => (
        <li key={event.id}>
          <span
            className={`event-icon ${event.type.includes('job') ? 'exchange' : ''}`}
            aria-hidden="true"
          >
            {event.type.includes('job') ? (
              <Scale size={14} />
            ) : event.type.includes('connection') ? (
              <Link2 size={14} />
            ) : event.type.includes('agent') ? (
              <Layers3 size={14} />
            ) : (
              <Activity size={14} />
            )}
          </span>
          <div className="event-content">
            <p>
              {event.jobId && snapshot.jobs.some((job) => job.id === event.jobId) ? (
                <button onClick={() => onJob(event.jobId!)}>{plainEvent(event.message)}</button>
              ) : (
                plainEvent(event.message)
              )}
            </p>
            <span>
              {formatTime(event.createdAt)}
              <span className="event-type">{eventTypeLabel(event.type)}</span>
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Dialogs({
  dialog,
  snapshot,
  setDialog,
  onShowAgent,
  onChanged,
}: {
  dialog: Exclude<Dialog, null>;
  snapshot: Snapshot;
  setDialog: (dialog: Dialog) => void;
  /** Shows an agent in My agents' pane. */
  onShowAgent: (id: string) => void;
  onChanged: (message?: string) => Promise<void>;
}) {
  const close = () => setDialog(null);
  if (dialog.kind === 'create')
    return (
      <CreateAgent
        onClose={close}
        onCreate={async (agent, token) => {
          await onChanged(`${agent.name} added to your workspace.`);
          // An agent you run yourself shows its token once; a template agent opens at once.
          if (token) setDialog({ kind: 'token', agent, token });
          else {
            close();
            onShowAgent(agent.id);
          }
        }}
      />
    );
  if (dialog.kind === 'token')
    return (
      <Modal
        title={`${dialog.agent.name} is added.`}
        subtitle="Save its access token now. It is shown only once."
        onClose={close}
      >
        <div className="token-content">
          <div className="credential-box">
            <label htmlFor="connector-token">Access token</label>
            <textarea
              id="connector-token"
              readOnly
              value={dialog.token}
              spellCheck={false}
              autoComplete="off"
            />
            <CopyButton value={dialog.token} label="Copy token" />
          </div>
          <p className="field-note">
            Anyone with this token can act as this agent. Keep it private and never paste it into a
            chat. You can replace it later in the agent's settings; the agent stays the same.
          </p>
          {!['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) ? (
            <p className="field-note">
              The setup below is for a copy of Central City running on your own computer. It does
              not connect to centralcity.ai.
            </p>
          ) : null}
          <details className="setup-details">
            <summary>Developer setup</summary>
            <div className="setup-step">
              <span>01</span>
              <div>
                <strong>Start your connector</strong>
                <p>
                  Save the configuration below to .local/my-agent.json in the application directory.
                  Keep the file private, then run this command.
                </p>
                <code>pnpm connector connect .local/my-agent.json</code>
                <label className="connector-config-label" htmlFor="connector-config">
                  Private connector configuration
                </label>
                <textarea
                  id="connector-config"
                  className="connector-config"
                  readOnly
                  spellCheck={false}
                  value={JSON.stringify(
                    {
                      baseUrl: window.location.origin,
                      token: dialog.token,
                      sequenceFile: './my-agent.sequence',
                    },
                    null,
                    2,
                  )}
                />
                <CopyButton
                  value={JSON.stringify(
                    {
                      baseUrl: window.location.origin,
                      token: dialog.token,
                      sequenceFile: './my-agent.sequence',
                    },
                    null,
                    2,
                  )}
                  label="Copy configuration"
                />
              </div>
            </div>
            <div className="setup-step">
              <span>02</span>
              <div>
                <strong>Wait until it shows as online</strong>
                <p>
                  The agent shows as online once it signs in with its token. Keep the connector
                  running so it can take work.
                </p>
              </div>
            </div>
            <div className="detail-pair">
              <span>Agent ID</span>
              <code>{dialog.agent.id}</code>
            </div>
          </details>
          <button className="button primary full" onClick={close}>
            I have saved the token
            <ArrowRight size={15} />
          </button>
        </div>
      </Modal>
    );
  if (dialog.kind === 'connection')
    return (
      <ConnectionForm
        snapshot={snapshot}
        onClose={close}
        onCreated={async () => {
          await onChanged('Connection created.');
          close();
        }}
      />
    );
  if (dialog.kind === 'job')
    return (
      <JobForm
        snapshot={snapshot}
        connectionId={dialog.connectionId}
        onClose={close}
        onCreated={async (job) => {
          await onChanged('Work sent. Follow its progress here.');
          setDialog({ kind: 'result', id: job.id });
        }}
      />
    );
  const job = snapshot.jobs.find((item) => item.id === dialog.id);
  return job ? (
    <JobDetail key={job.id} job={job} snapshot={snapshot} onClose={close} onChanged={onChanged} />
  ) : (
    <Modal title="This exchange is no longer listed" onClose={close}>
      <p className="modal-body">
        Only the latest 50 exchanges are listed here. Refresh to see the latest activity.
      </p>
    </Modal>
  );
}

function CreateAgent({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (agent: Agent, token?: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'hosted' | 'external'>('hosted');
  const [capability, setCapability] = useState<Capability>('research');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ agent: Agent; token?: string }>('/api/agents', {
        name: name.trim(),
        description: description.trim(),
        capability,
        mode,
        // Only template agents get a manifest and card, so only they carry a visibility.
        ...(mode === 'hosted' ? { visibility } : {}),
      });
      await onCreate(result.agent, result.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The agent couldn't be added.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Add an agent."
      subtitle="Start from a template, or connect an agent you run yourself."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="form-stack modal-body" onSubmit={submit}>
        <div className="mode-picker">
          <button
            disabled={busy}
            type="button"
            className={mode === 'hosted' ? 'selected' : ''}
            aria-pressed={mode === 'hosted'}
            onClick={() => setMode('hosted')}
          >
            <Sparkles size={21} />
            <strong>Use a template</strong>
            <span>Free CC agents that run here</span>
          </button>
          <button
            disabled={busy}
            type="button"
            className={mode === 'external' ? 'selected' : ''}
            aria-pressed={mode === 'external'}
            onClick={() => setMode('external')}
          >
            <Terminal size={21} />
            <strong>Connect your own</strong>
            <span>Runs on your computer or server</span>
          </button>
        </div>
        <label>
          Agent name
          <input
            autoComplete="off"
            required
            minLength={2}
            maxLength={64}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
            placeholder="e.g. Scout"
          />
        </label>
        <label>
          Description <span className="optional">optional</span>
          <input
            maxLength={300}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={busy}
            placeholder="What does this agent help with?"
          />
        </label>
        <fieldset className="capability-fieldset">
          <legend>What it does</legend>
          <div className="capability-picker">
            {(['research', 'extract', 'verify'] as const).map((value) => {
              return (
                <label key={value} className={capability === value ? 'selected' : ''}>
                  <input
                    disabled={busy}
                    type="radio"
                    name="capability"
                    value={value}
                    checked={capability === value}
                    onChange={() => setCapability(value)}
                  />
                  <AgentGlyph agent={{ capability: value }} size="small" />
                  <strong>{capabilityLabels[value]}</strong>
                </label>
              );
            })}
          </div>
        </fieldset>
        {mode === 'hosted' ? (
          <fieldset className="capability-fieldset">
            <legend>Who can see it</legend>
            <div className="capability-picker visibility-picker">
              {(['private', 'public'] as const).map((value) => (
                <label key={value} className={visibility === value ? 'selected' : ''}>
                  <input
                    disabled={busy}
                    type="radio"
                    name="visibility"
                    value={value}
                    checked={visibility === value}
                    onChange={() => setVisibility(value)}
                  />
                  <strong>{value === 'private' ? 'Private' : 'Public'}</strong>
                </label>
              ))}
            </div>
            <p className="field-hint">
              Public agents get a public profile and can be listed in agent explorers.
            </p>
          </fieldset>
        ) : null}
        <div className="info-note">
          <CircleHelp size={17} />
          <p>
            {mode === 'hosted'
              ? 'Template agents show research, extraction or checking on text you give them. They follow a script; no AI model is used.'
              : "You'll get an access token once. The agent can take work as soon as it's running and signed in with that token."}
          </p>
        </div>
        <FormError error={error} />
        <button className="button primary large" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
          {mode === 'hosted' ? 'Add template agent' : 'Add your agent'}
        </button>
      </form>
    </Modal>
  );
}

function ConnectionForm({
  snapshot,
  onClose,
  onCreated,
}: {
  snapshot: Snapshot;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const candidates = snapshot.agents.filter((agent) => !agent.revokedAt);
  const [from, setFrom] = useState(candidates[0]?.id || '');
  const [to, setTo] = useState(candidates[1]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/connections', { fromAgentId: from, toAgentId: to });
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "These agents couldn't be connected.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Create a connection."
      subtitle="Give one agent permission to send work to another."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="form-stack modal-body" onSubmit={submit}>
        {candidates.length < 2 ? (
          <div className="info-note">
            <CircleHelp size={18} />
            <p>Add at least two agents to create a connection.</p>
          </div>
        ) : null}
        <label>
          From · asks for the work
          <select
            disabled={busy}
            required
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              if (to === event.target.value) setTo('');
            }}
          >
            <option value="" disabled>
              Choose an agent
            </option>
            {candidates.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} · {capabilityLabels[agent.capability]}
              </option>
            ))}
          </select>
        </label>
        <div className="form-route-arrow">
          <ArrowDownLeft size={21} />
          One way only
        </div>
        <label>
          To · does the work
          <select
            disabled={busy}
            required
            value={to}
            onChange={(event) => setTo(event.target.value)}
          >
            <option value="" disabled>
              Choose an agent
            </option>
            {candidates
              .filter((agent) => agent.id !== from)
              .map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {capabilityLabels[agent.capability]}
                </option>
              ))}
          </select>
        </label>
        <div className="info-note">
          <ShieldCheck size={18} />
          <p>
            The first agent may send work to the second. No passwords or tools are shared. You can
            remove the connection at any time.
          </p>
        </div>
        <FormError error={error} />
        <button
          className="button primary large"
          disabled={busy || candidates.length < 2 || !from || !to}
        >
          <Link2 size={16} />
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </Modal>
  );
}

function JobForm({
  snapshot,
  connectionId,
  onClose,
  onCreated,
}: {
  snapshot: Snapshot;
  connectionId?: string;
  onClose: () => void;
  onCreated: (job: Job) => Promise<void>;
}) {
  const candidates = snapshot.connections.filter((connection) =>
    [connection.fromAgentId, connection.toAgentId].every((id) =>
      snapshot.agents.some(
        (agent) => agent.id === id && (agent.status === 'online' || agent.status === 'working'),
      ),
    ),
  );
  const [route, setRoute] = useState(connectionId || candidates[0]?.id || '');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  const connection = candidates.find((item) => item.id === route);
  const provider = snapshot.agents.find((agent) => agent.id === connection?.toAgentId);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!connection) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ job: Job }>('/api/jobs', {
        requesterId: connection.fromAgentId,
        providerId: connection.toAgentId,
        input: input.trim(),
        idempotencyKey: key.current,
      });
      await onCreated(result.job);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The work couldn't be sent.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Send work."
      subtitle="Give a connected agent some text to work on."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="form-stack modal-body" onSubmit={submit}>
        <label>
          Connection
          <select
            disabled={busy}
            required
            value={route}
            onChange={(event) => {
              setRoute(event.target.value);
              key.current = crypto.randomUUID();
            }}
          >
            <option value="" disabled>
              Choose a connection
            </option>
            {candidates.map((item) => (
              <option key={item.id} value={item.id}>
                {snapshot.agents.find((agent) => agent.id === item.fromAgentId)?.name} →{' '}
                {snapshot.agents.find((agent) => agent.id === item.toAgentId)?.name}
              </option>
            ))}
          </select>
        </label>
        {!candidates.length ? (
          <div className="info-note">
            <CircleHelp size={18} />
            <p>
              You need two online agents and a connection between them. Generate your first CC
              agents, or connect your own agents first.
            </p>
          </div>
        ) : null}
        {provider ? (
          <div className="provider-preview">
            <AgentGlyph agent={provider} />
            <div>
              <strong>{provider.name}</strong>
              <span>
                {capabilityLabels[provider.capability]}
                {provider.isDemo ? ' · demo' : ' · runs on your computer'}
              </span>
            </div>
            <Status value={provider.status} />
          </div>
        ) : null}
        <label>
          Text to work on
          <textarea
            disabled={busy}
            required
            maxLength={12000}
            rows={7}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              key.current = crypto.randomUUID();
            }}
            placeholder="Paste the text you want this agent to work with…"
          />
        </label>
        <div className="sample-input-row">
          <span>No text at hand?</span>
          <button
            type="button"
            className="text-link"
            disabled={busy}
            onClick={() => {
              setInput(
                'Project: Sample observatory\nMilestone: 12 sources indexed\nSource: https://example.com/sample',
              );
              key.current = crypto.randomUUID();
            }}
          >
            Use sample text
            <Sparkles size={13} />
          </button>
        </div>
        <div className="field-counter">
          <span>Only share text you're allowed to share.</span>
          <span>{input.length.toLocaleString()} / 12,000</span>
        </div>
        <div className="info-note">
          <ShieldCheck size={17} />
          <p>
            {provider?.mode === 'external'
              ? 'Review the result before accepting it. Your agent runs on your own computer, so any costs are yours; Central City never moves money.'
              : 'Review the result before accepting it. CC agents are free: no AI model, no tools, no payments.'}
          </p>
        </div>
        <FormError error={error} />
        <button
          className="button primary large"
          disabled={busy || !connection || snapshot.paused || !input.trim()}
        >
          {busy ? <LoaderCircle className="spin" size={16} /> : <ArrowUpRight size={16} />}
          {snapshot.paused ? 'Workspace is paused' : busy ? 'Sending…' : 'Send work'}
        </button>
      </form>
    </Modal>
  );
}

function JobDetail({
  job,
  snapshot,
  onClose,
  onChanged,
}: {
  job: Job;
  snapshot: Snapshot;
  onClose: () => void;
  onChanged: (message?: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requester = snapshot.agents.find((agent) => agent.id === job.requesterId);
  const provider = snapshot.agents.find((agent) => agent.id === job.providerId);
  const state = jobExchangeState(job);
  async function mutate(kind: 'accept' | 'cancel') {
    setBusy(true);
    setError('');
    try {
      await api(`/api/jobs/${job.id}/${kind}`, {});
      await onChanged(
        kind === 'accept' ? 'Result accepted. Your decision is recorded.' : 'Work canceled.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Exchange"
      subtitle={`${requester?.name || 'An agent'} → ${provider?.name || 'another agent'}`}
      onClose={onClose}
      wide
    >
      <div className="modal-body detail-body">
        <div className="job-detail-status">
          <ExchangeCircle state={state} size="large" label={`Exchange ${exchangeLabels[state]}`} />
          <div>
            <span className={`exchange-state state-${state}`}>{exchangeLabels[state]}</span>
            <div className="job-detail-tags">
              {job.isDemo ? (
                <span className="small-tag demo">CC</span>
              ) : (
                <span className="small-tag">Your own agent</span>
              )}
              <span className="muted small">Started {formatDate(job.createdAt)}</span>
            </div>
          </div>
        </div>
        <ol className="job-stages" aria-label="Progress">
          <li className="done">
            <Check size={14} aria-hidden="true" />
            Requested
          </li>
          <li className={job.status === 'completed' ? 'done' : ''}>
            {job.status === 'completed' ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <CircleHelp size={14} aria-hidden="true" />
            )}
            Work done
          </li>
          <li className={job.acceptance === 'accepted' ? 'done' : ''}>
            {job.acceptance === 'accepted' ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <CircleHelp size={14} aria-hidden="true" />
            )}
            You accepted
          </li>
        </ol>
        <div className="exchange-grid">
          <section className="exchange-panel given" aria-labelledby="given-title">
            <header>
              <span className="eyebrow">Sent</span>
              <h3 id="given-title">
                {requester ? <AgentGlyph agent={requester} size="small" /> : null}
                {requester?.name ?? 'An agent'}
              </h3>
            </header>
            <h4>Text</h4>
            <pre className="input-preview">{job.input}</pre>
            <dl className="exchange-terms">
              <div>
                <dt>Budget</dt>
                <dd>{budgetLabel(job)}</dd>
              </div>
              <div>
                <dt>Asked for</dt>
                <dd>{capabilityLabels[job.capability]}</dd>
              </div>
            </dl>
          </section>
          <section className="exchange-panel returned" aria-labelledby="returned-title">
            <header>
              <span className="eyebrow">Came back</span>
              <h3 id="returned-title">
                {provider ? <AgentGlyph agent={provider} size="small" /> : null}
                {provider?.name ?? 'Another agent'}
              </h3>
            </header>
            <div className="result-title">
              <h4>Result</h4>
              {job.output ? (
                <CopyButton
                  value={JSON.stringify(job.output, null, 2)}
                  label="Copy result"
                  describedAs="Result"
                />
              ) : null}
            </div>
            {job.output ? (
              <ReadableData data={job.output} label="Result" />
            ) : (
              <div className="result-pending">
                {job.status === 'queued' || job.status === 'running' ? (
                  <LoaderCircle size={20} className="spin" aria-hidden="true" />
                ) : (
                  <Square size={18} aria-hidden="true" />
                )}
                <p>
                  {job.status === 'queued'
                    ? 'Waiting for the agent to start.'
                    : job.status === 'running'
                      ? 'The agent is working. This page updates by itself.'
                      : 'Nothing came back.'}
                </p>
              </div>
            )}
            {job.error ? <div className="form-error">{job.error}</div> : null}
          </section>
        </div>
        <FormError error={error} />
        <div className={`result-actions decision-${state}`}>
          {job.status === 'completed' && job.acceptance !== 'accepted' ? (
            <>
              <p>
                The agent sent its result. Accept it only if it meets your needs. Accepting records
                your decision; it never publishes anything.
              </p>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void mutate('accept')}
              >
                <CheckCheck size={16} />
                Accept result
              </button>
            </>
          ) : job.status === 'queued' || job.status === 'running' ? (
            <>
              <p>Canceling stops this work. Its history stays.</p>
              <button
                className="button danger"
                disabled={busy}
                onClick={() => void mutate('cancel')}
              >
                <Square size={13} />
                Cancel work
              </button>
            </>
          ) : job.acceptance === 'accepted' ? (
            <p className="accepted-message">
              <ShieldCheck size={18} aria-hidden="true" />
              You accepted this result {job.acceptedAt ? formatDate(job.acceptedAt) : ''}.
            </p>
          ) : (
            <p>
              This exchange {job.status === 'failed' ? 'failed' : 'was canceled'}. Nothing was
              accepted; its history stays.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
