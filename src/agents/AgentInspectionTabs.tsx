import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { ConnectionRequest } from '../../shared/assistant';
import type { Agent, Snapshot } from '../../shared/types';
import { api, ApiError, selectedWorkspaceId } from '../api';
import { exchangeLabels, jobExchangeState } from '../circle';
import { capabilityLabels, formatDate } from '../components';
import { BaseRegistration } from '../base/BaseRegistration';
import './agent-inspection.css';

export interface AgentInspectionTabsProps {
  agent: Agent;
  snapshot: Pick<Snapshot, 'agents' | 'jobs' | 'connections' | 'paused'>;
  onOpenJob: (jobId: string) => void;
  onManageConnections: () => void;
  onConnectedApps: () => void;
}

type InspectionTab = 'runs' | 'permissions' | 'base';
const tabLabels: Record<InspectionTab, string> = {
  runs: 'Runs',
  permissions: 'Permissions',
  base: 'Base',
};

function agentAvailability(agent: Agent | undefined) {
  if (!agent) return 'Agent unavailable in this list';
  if (agent.status === 'revoked') return 'Revoked';
  if (agent.pausedAt) return 'Paused';
  if (agent.status === 'offline') return 'Offline';
  return null;
}

type ConnectionDirection = ConnectionRequest['direction'];
type ConnectionPage = {
  incoming: ConnectionRequest[];
  outgoing: ConnectionRequest[];
  next_before: string | null;
};
type ApprovedPages = Record<
  ConnectionDirection,
  { connections: ConnectionRequest[]; nextBefore: string | null }
>;
type ConnectionRead = {
  agentId: string;
  workspaceId: string | null;
  pages: ApprovedPages | null;
  loading: 'refresh' | 'more' | null;
  error: string;
};
const connectionDirections: ConnectionDirection[] = ['incoming', 'outgoing'];

function CrossWorkspacePermissions({ agent }: { agent: Agent }) {
  const workspaceId = selectedWorkspaceId();
  const [read, setRead] = useState<ConnectionRead>({
    agentId: agent.id,
    workspaceId,
    pages: null,
    loading: 'refresh',
    error: '',
  });
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const matchesScope = read.agentId === agent.id && read.workspaceId === workspaceId;
  const pages = matchesScope ? read.pages : null;
  const loading = matchesScope ? read.loading : 'refresh';
  const error = matchesScope ? read.error : '';
  const hasMore = Boolean(
    pages && connectionDirections.some((direction) => pages[direction].nextBefore),
  );
  const connections = pages ? [...pages.incoming.connections, ...pages.outgoing.connections] : [];

  const load = useCallback(
    async (mode: 'refresh' | 'more', previous: ApprovedPages | null) => {
      if (
        pending.current ||
        selectedWorkspaceId() !== workspaceId ||
        (mode === 'more' && !previous)
      )
        return;
      pending.current = true;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const version = ++generation.current;
      const isCurrent = () =>
        !abort.signal.aborted &&
        generation.current === version &&
        selectedWorkspaceId() === workspaceId;
      setRead({ agentId: agent.id, workspaceId, pages: previous, loading: mode, error: '' });
      try {
        const directions = connectionDirections.filter(
          (direction) => mode === 'refresh' || previous?.[direction].nextBefore,
        );
        const results = await Promise.all(
          directions.map(async (direction) => {
            const query = new URLSearchParams({ direction, status: 'approved', limit: '100' });
            const before = mode === 'more' ? previous?.[direction].nextBefore : null;
            if (before) query.set('before', before);
            const result = await api<ConnectionPage>(
              `/api/v2/connections/requests?${query}`,
              undefined,
              'GET',
              abort.signal,
            );
            return { direction, result };
          }),
        );
        if (!isCurrent()) return;
        const next: ApprovedPages =
          mode === 'more' && previous
            ? { ...previous }
            : {
                incoming: { connections: [], nextBefore: null },
                outgoing: { connections: [], nextBefore: null },
              };
        for (const { direction, result } of results) {
          const matches = result[direction].filter(
            (connection) =>
              connection.status === 'approved' &&
              connection.direction === direction &&
              (direction === 'incoming'
                ? connection.to_agent_id === agent.id
                : connection.from_agent_id === agent.id),
          );
          next[direction] = {
            connections: Array.from(
              new Map(
                [...next[direction].connections, ...matches].map((connection) => [
                  connection.id,
                  connection,
                ]),
              ).values(),
            ),
            nextBefore: result.next_before,
          };
        }
        if (
          mode === 'more' &&
          !connectionDirections.some((direction) => next[direction].nextBefore) &&
          document.activeElement === moreButton.current
        )
          refreshButton.current?.focus();
        setRead({ agentId: agent.id, workspaceId, pages: next, loading: null, error: '' });
      } catch (cause) {
        if (!isCurrent()) return;
        const message =
          mode === 'more'
            ? 'More connections could not be loaded. Showing previously loaded results.'
            : previous
              ? 'Connections could not be refreshed. Showing previously loaded results; they may have changed.'
              : 'Connections with other workspaces could not be loaded.';
        setRead({
          agentId: agent.id,
          workspaceId,
          pages: previous,
          loading: null,
          error: `${message}${cause instanceof ApiError ? ` ${cause.message}` : ''}`,
        });
      } finally {
        if (generation.current === version) pending.current = false;
      }
    },
    [agent.id, workspaceId],
  );

  useEffect(() => {
    void load('refresh', null);
    return () => {
      controller.current?.abort();
      generation.current++;
      pending.current = false;
    };
  }, [load]);

  return (
    <section className="agent-inspection-cross" aria-label="Connections with other workspaces">
      <div className="agent-inspection-cross-heading">
        <h4>Connections with other workspaces</h4>
        <button
          ref={refreshButton}
          type="button"
          className="agent-inspection-button"
          aria-disabled={Boolean(loading)}
          onClick={() => void load('refresh', pages)}
        >
          {error && !pages ? 'Retry connections' : 'Refresh connections'}
        </button>
      </div>
      <p className="agent-inspection-description">
        Approved one-way connections can allow messages and eligible CC agent work. They do not
        confirm that the other agent is available.
      </p>
      {loading ? (
        <p className="agent-inspection-meta" role="status">
          {loading === 'more'
            ? 'Loading more approved connections…'
            : pages
              ? 'Refreshing approved connections…'
              : 'Loading approved connections…'}
        </p>
      ) : null}
      {error ? (
        <p className="agent-inspection-notice agent-inspection-error" role="alert">
          {error}
        </p>
      ) : null}
      {pages ? (
        <>
          {connections.length ? (
            <ul className="agent-inspection-list" aria-label="Approved cross-workspace connections">
              {connections.map((connection) => {
                const outgoing = connection.direction === 'outgoing';
                const peerName =
                  (outgoing ? connection.to_agent_name : connection.from_agent_name) ??
                  'Agent name unavailable';
                return (
                  <li className="agent-inspection-row" key={connection.id}>
                    <div className="agent-inspection-row-content">
                      <div className="agent-inspection-row-heading">
                        <h4>{peerName}</h4>
                        <span className="agent-inspection-badge">
                          {outgoing ? 'Outgoing' : 'Incoming'}
                        </span>
                        <span className="agent-inspection-badge" data-state="approved">
                          Approved
                        </span>
                      </div>
                      <p className="agent-inspection-route">
                        {outgoing
                          ? `Route from ${agent.name} to ${peerName}`
                          : `Route from ${peerName} to ${agent.name}`}
                      </p>
                      {!outgoing ? (
                        <p className="agent-inspection-meta">
                          Requesting workspace: {connection.from_owner_label}
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="agent-inspection-empty">
              <h4>No matching approved connections in the loaded results</h4>
              <p>Only connections involving this agent are shown here.</p>
            </div>
          )}
          <p className="agent-inspection-meta">
            Each page checks up to 100 approved connections per direction for this workspace.
            {hasMore ? ' More workspace connections are available to check.' : ''}
          </p>
          {hasMore ? (
            <button
              ref={moreButton}
              type="button"
              className="agent-inspection-button agent-inspection-more"
              aria-disabled={Boolean(loading)}
              onClick={() => void load('more', pages)}
            >
              Load more connections
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function AgentInspectionTabs({
  agent,
  snapshot,
  onOpenJob,
  onManageConnections,
  onConnectedApps,
}: AgentInspectionTabsProps) {
  // Base: make the agent a Base agent (this dialog only opens the workspace's own agents).
  const tabs: InspectionTab[] = agent.revokedAt
    ? ['runs', 'permissions']
    : ['runs', 'permissions', 'base'];
  const [pickedTab, setActiveTab] = useState<InspectionTab>('runs');
  // A tab that disappears (Base, once the agent is removed) falls back to Runs: one panel stays open.
  const activeTab: InspectionTab = tabs.includes(pickedTab) ? pickedTab : 'runs';
  const id = useId();
  const tabButtons = useRef<Partial<Record<InspectionTab, HTMLButtonElement | null>>>({});
  const agentsById = new Map(snapshot.agents.map((item) => [item.id, item]));
  const runs = snapshot.jobs
    .slice(0, 50)
    .filter((job) => job.requesterId === agent.id || job.providerId === agent.id);

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>, tab: InspectionTab) {
    let next: InspectionTab;
    if (event.key === 'Home') next = tabs[0];
    else if (event.key === 'End') next = tabs[tabs.length - 1];
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      next = tabs[(tabs.indexOf(tab) + direction + tabs.length) % tabs.length];
    } else return;
    event.preventDefault();
    setActiveTab(next);
    tabButtons.current[next]?.focus();
  }

  return (
    <section className="agent-inspection" aria-label="Agent runs and permissions">
      <div className="agent-inspection-tabs" role="tablist" aria-label="Agent details">
        {tabs.map((tab) => (
          <button
            key={tab}
            ref={(element) => {
              tabButtons.current[tab] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-${tab}-tab`}
            aria-controls={`${id}-${tab}-panel`}
            aria-selected={activeTab === tab}
            tabIndex={activeTab === tab ? 0 : -1}
            onClick={() => setActiveTab(tab)}
            onKeyDown={(event) => handleTabKey(event, tab)}
          >
            {tabLabels[tab]}
          </button>
        ))}
      </div>

      {tabs.map((tab) => (
        <div
          key={tab}
          className="agent-inspection-panel"
          role="tabpanel"
          id={`${id}-${tab}-panel`}
          aria-labelledby={`${id}-${tab}-tab`}
          hidden={activeTab !== tab}
          tabIndex={activeTab === tab ? 0 : -1}
        >
          {activeTab !== tab ? null : tab === 'runs' ? (
            <>
              <p className="agent-inspection-description">
                Showing matching runs from the latest 50 workspace exchanges. Older runs may not
                appear here.
              </p>
              {runs.length ? (
                <ul className="agent-inspection-list" aria-label="Recent runs">
                  {runs.map((job) => {
                    const requested = job.requesterId === agent.id;
                    const performed = job.providerId === agent.id;
                    const peerId = requested ? job.providerId : job.requesterId;
                    const peerName = agentsById.get(peerId)?.name ?? 'An agent outside this list';
                    const state = jobExchangeState(job);
                    return (
                      <li className="agent-inspection-row" key={job.id}>
                        <div className="agent-inspection-row-content">
                          <div className="agent-inspection-row-heading">
                            <h4>{capabilityLabels[job.capability]} run</h4>
                            <span className="agent-inspection-badge" data-state={state}>
                              {exchangeLabels[state]}
                            </span>
                            {job.isDemo ? <span className="agent-inspection-badge">CC</span> : null}
                          </div>
                          <p className="agent-inspection-route">
                            <strong>
                              {requested && performed
                                ? 'Requester and performer'
                                : requested
                                  ? 'Requested'
                                  : 'Performer'}
                            </strong>
                            <span>
                              {requested && performed
                                ? 'This agent fills both roles'
                                : requested
                                  ? `From ${peerName}`
                                  : `Requested by ${peerName}`}
                            </span>
                          </p>
                          <p className="agent-inspection-meta">
                            Created{' '}
                            <time dateTime={job.createdAt}>{formatDate(job.createdAt)}</time>
                          </p>
                        </div>
                        <button
                          className="agent-inspection-button"
                          type="button"
                          aria-label={`Open ${capabilityLabels[job.capability]} run with ${peerName}`}
                          onClick={() => onOpenJob(job.id)}
                        >
                          Open run
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="agent-inspection-empty">
                  <h4>No runs in recent workspace history</h4>
                  <p>No exchanges in the current history window involve this agent.</p>
                </div>
              )}
            </>
          ) : tab === 'base' ? (
            <BaseRegistration agent={agent} />
          ) : (
            <AgentConnectionsPanel
              agent={agent}
              snapshot={snapshot}
              onManageConnections={onManageConnections}
              onConnectedApps={onConnectedApps}
            />
          )}
        </div>
      ))}
    </section>
  );
}

/**
 * An agent's connections: routes inside this workspace and approved cross-workspace ones, with
 * the ways to manage them. The inspection dialog's Permissions tab and the My agents detail panel
 * show the same panel.
 */
export function AgentConnectionsPanel({
  agent,
  snapshot,
  onManageConnections,
  onConnectedApps,
}: {
  agent: Agent;
  snapshot: Pick<Snapshot, 'agents' | 'connections' | 'paused'>;
  onManageConnections: () => void;
  onConnectedApps: () => void;
}) {
  const agentsById = new Map(snapshot.agents.map((item) => [item.id, item]));
  const connections = snapshot.connections.filter(
    (connection) => connection.fromAgentId === agent.id || connection.toAgentId === agent.id,
  );
  const availability = agentAvailability(agent);
  return (
    <>
      <p className="agent-inspection-description">
        Workspace connections are one-way routes for requesting work. They do not share tools or
        credentials, and workspace and agent controls still apply.
      </p>
      {snapshot.paused || availability ? (
        <p className="agent-inspection-notice">
          {snapshot.paused
            ? 'This workspace is paused. Recorded connections do not mean work can run now.'
            : availability === 'Revoked'
              ? 'This agent is revoked and cannot send or receive work.'
              : availability === 'Paused'
                ? 'This agent is paused and cannot send or receive work.'
                : 'This agent is offline. A recorded connection does not confirm availability.'}
        </p>
      ) : null}
      {connections.length ? (
        <ul className="agent-inspection-list" aria-label="Workspace connections">
          {connections.map((connection) => {
            const outgoing = connection.fromAgentId === agent.id;
            const peer = agentsById.get(outgoing ? connection.toAgentId : connection.fromAgentId);
            const peerName = peer?.name ?? 'An agent outside this list';
            const peerAvailability = agentAvailability(peer);
            return (
              <li className="agent-inspection-row" key={connection.id}>
                <div className="agent-inspection-row-content">
                  <div className="agent-inspection-row-heading">
                    <h4>{peerName}</h4>
                    <span className="agent-inspection-badge">
                      {outgoing ? 'Outgoing' : 'Incoming'}
                    </span>
                    {peerAvailability ? (
                      <span className="agent-inspection-badge">{peerAvailability}</span>
                    ) : null}
                  </div>
                  <p className="agent-inspection-route">
                    {outgoing
                      ? `Route from ${agent.name} to ${peerName}`
                      : `Route from ${peerName} to ${agent.name}`}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="agent-inspection-empty">
          <h4>No workspace connections</h4>
          <p>No connections within this workspace are recorded for this agent.</p>
        </div>
      )}
      <CrossWorkspacePermissions agent={agent} />
      <div className="agent-inspection-destinations">
        <div>
          <h4>Connection management</h4>
          <p>Manage workspace connections and connection requests with other workspaces.</p>
          <button type="button" className="agent-inspection-button" onClick={onManageConnections}>
            Manage connections
          </button>
        </div>
        <div>
          <h4>App access</h4>
          <p>
            Connected apps manages AI access across this workspace. These permissions are separate
            from this agent’s connections. Agent tool and credential permissions are not shown here.
          </p>
          <button type="button" className="agent-inspection-button" onClick={onConnectedApps}>
            Connected apps
          </button>
        </div>
      </div>
    </>
  );
}
