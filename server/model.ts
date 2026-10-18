import { randomUUID } from 'node:crypto';
import type {
  Agent,
  AgentListPage,
  CityEvent,
  Connection,
  Job,
  Snapshot,
  Operator,
  Workflow,
} from '../shared/types.js';
import { AGENT_PAGES } from '../shared/agent-pages.js';
import { liveDescendants, pageAgents, relatedAgents } from './agent-pages.js';

/** An external agent counts as reachable this long after its last signed heartbeat. */
export const PRESENCE_TTL = 90_000;
/**
 * A hosted agent's heartbeat is synthetic (the platform runs it, server/app.ts refreshPresence):
 * it is renewed for all of the workspace's hosted agents together once the oldest is this old, so
 * presence alone rewrites the workspace document at most once per interval.
 */
export const HOSTED_HEARTBEAT_MS = 10 * 60_000;
/** A hosted agent counts as reachable this long after its last synthetic heartbeat. */
export const HOSTED_PRESENCE_TTL = 3 * HOSTED_HEARTBEAT_MS;
/** Reads show a reachable hosted agent's lastSeenAt as the start of the current window this long. */
export const HOSTED_SEEN_WINDOW_MS = 30_000;
export const LEASE_TTL = 60_000;
export interface StoredAgent extends Omit<Agent, 'status' | 'credentialHint'> {
  lastSequence: number;
  announcedOnline: boolean;
  demoKey?: string;
  /** Last 4 characters of the current runtime credential; only ownerAgent shows it. */
  credentialHint?: string;
}
export interface StoredJob extends Job {
  idempotencyKey: string;
  requestHash: string;
  attempts: number;
  leaseHash: string | null;
  leaseExpiresAt: number | null;
  outputHash: string | null;
}
export interface StoredWorkflow extends Workflow {
  idempotencyKey: string;
  requestHash: string;
}
export interface Workspace {
  paused: boolean;
  agents: StoredAgent[];
  connections: Connection[];
  jobs: StoredJob[];
  events: CityEvent[];
  workflows?: StoredWorkflow[];
  /**
   * Accepted cross-workspace connections into this workspace (docs/AI_WORKSPACES.md). Loaded from
   * connection_requests with every locked read and attached as a NON-enumerable property, so it is
   * never persisted in the workspace document, exported or backed up: the table row is the only
   * authority, and a restored backup without it grants nothing.
   */
  inbound?: InboundConnection[];
}
export interface InboundConnection {
  /** Requesting agent in another workspace. */
  fromAgentId: string;
  fromOperatorId: string;
  /** Agent of this workspace that accepted work and messages from it. */
  toAgentId: string;
}
/** Attaches inbound cross-workspace connections without making them part of the stored JSON. */
export function attachInbound(workspace: Workspace, inbound: InboundConnection[]): void {
  Object.defineProperty(workspace, 'inbound', {
    value: inbound,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}
export function emptyWorkspace(): Workspace {
  return { paused: false, agents: [], connections: [], jobs: [], events: [] };
}
export const iso = (time: number) => new Date(time).toISOString();
export const active = (job: Job) => job.status === 'queued' || job.status === 'running';
/** The reachability window of an agent's last heartbeat: signed (external) or synthetic (hosted). */
export function presenceTtl(agent: Pick<StoredAgent, 'mode'>): number {
  return agent.mode === 'hosted' ? HOSTED_PRESENCE_TTL : PRESENCE_TTL;
}
/** A hosted agent's synthetic heartbeat must be renewed now (refreshPresence renews them all). */
export function hostedHeartbeatDue(agent: StoredAgent, time: number): boolean {
  return (
    agent.mode === 'hosted' &&
    !agent.revokedAt &&
    (!agent.announcedOnline ||
      !agent.lastSeenAt ||
      !(time - Date.parse(agent.lastSeenAt) < HOSTED_HEARTBEAT_MS))
  );
}
export function reachable(agent: StoredAgent, time: number): boolean {
  return (
    !agent.revokedAt &&
    agent.lastSeenAt !== null &&
    time - Date.parse(agent.lastSeenAt) < presenceTtl(agent)
  );
}
/**
 * The lastSeenAt that reads report. The platform runs a hosted agent, so while it is reachable it
 * is seen now, but its stored synthetic heartbeat is renewed only once per HOSTED_HEARTBEAT_MS:
 * reads report the start of the current HOSTED_SEEN_WINDOW_MS window instead. Computed on read
 * only; nothing is written.
 */
export function shownLastSeenAt(agent: StoredAgent, time: number): string | null {
  if (agent.mode === 'hosted' && reachable(agent, time))
    return iso(time - (time % HOSTED_SEEN_WINDOW_MS));
  return agent.lastSeenAt;
}
export function publicAgent(agent: StoredAgent, jobs: StoredJob[], time: number): Agent {
  const {
    lastSequence: _sequence,
    announcedOnline: _online,
    demoKey: _demoKey,
    credentialHint: _hint,
    ...fields
  } = agent;
  return {
    ...fields,
    lastSeenAt: shownLastSeenAt(agent, time),
    status: agent.revokedAt
      ? 'revoked'
      : !reachable(agent, time)
        ? 'offline'
        : jobs.some((job) => job.providerId === agent.id && job.status === 'running')
          ? 'working'
          : 'online',
  };
}
/** publicAgent plus what only the owner sees: the masked runtime credential hint. */
export function ownerAgent(agent: StoredAgent, jobs: StoredJob[], time: number): Agent {
  return {
    ...publicAgent(agent, jobs, time),
    credentialHint: agent.credentialHint ? `…${agent.credentialHint}` : null,
  };
}
export function publicJob(job: StoredJob): Job {
  const {
    idempotencyKey: _key,
    requestHash: _request,
    attempts: _attempts,
    leaseHash: _lease,
    leaseExpiresAt: _expires,
    outputHash: _output,
    ...fields
  } = job;
  return fields;
}
export function event(
  workspace: Workspace,
  time: number,
  type: string,
  message: string,
  agentId: string | null = null,
  jobId: string | null = null,
): void {
  workspace.events.push({ id: randomUUID(), type, message, agentId, jobId, createdAt: iso(time) });
  workspace.events = workspace.events.slice(-1000);
}
export function hasPermission(
  workspace: Workspace,
  job: Pick<Job, 'requesterId' | 'providerId'>,
): boolean {
  // A requester in another workspace needs a current accepted cross-workspace connection; its own
  // liveness is enforced where it acts (its workspace), and revoking it revokes the connection.
  if (
    !workspace.agents.some((agent) => agent.id === job.requesterId) &&
    workspace.inbound?.some(
      (item) => item.fromAgentId === job.requesterId && item.toAgentId === job.providerId,
    )
  )
    return workspace.agents.some(
      (agent) => agent.id === job.providerId && !agent.revokedAt && !agent.pausedAt,
    );
  return (
    workspace.connections.some(
      (connection) =>
        connection.fromAgentId === job.requesterId && connection.toAgentId === job.providerId,
    ) &&
    [job.requesterId, job.providerId].every((id) =>
      workspace.agents.some((agent) => agent.id === id && !agent.revokedAt && !agent.pausedAt),
    )
  );
}
export function stopJob(workspace: Workspace, job: StoredJob, time: number, reason: string): void {
  if (!active(job)) return;
  job.status = 'canceled';
  job.updatedAt = iso(time);
  job.completedAt = iso(time);
  job.error = reason;
  job.leaseExpiresAt = null;
  event(workspace, time, 'job.canceled', reason, job.providerId, job.id);
}
/** Explicit allowlist: workflow retry hashes and future private storage fields stay private. */
export function publicWorkflow(workflow: StoredWorkflow): Workflow {
  return {
    id: workflow.id,
    requesterId: workflow.requesterId,
    researcherId: workflow.researcherId,
    reviewerId: workflow.reviewerId,
    source: workflow.source,
    briefJobId: workflow.briefJobId,
    checkJobId: workflow.checkJobId,
    status: workflow.status,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    error: workflow.error,
  };
}

/** Reconcile only existing jobs. This never admits a second stage or accepts a result. */
export function syncWorkflows(workspace: Workspace, time: number): void {
  for (const workflow of workspace.workflows ?? []) {
    if (['accepted', 'failed', 'canceled'].includes(workflow.status)) continue;
    const brief = workspace.jobs.find((job) => job.id === workflow.briefJobId);
    const check = workflow.checkJobId
      ? workspace.jobs.find((job) => job.id === workflow.checkJobId)
      : undefined;
    let status = workflow.status;
    let error: string | null = null;
    if (!brief || (workflow.checkJobId && !check)) {
      status = 'failed';
      error = 'A linked workflow job is missing.';
    } else if (
      !hasPermission(workspace, {
        requesterId: workflow.requesterId,
        providerId: workflow.researcherId,
      }) ||
      !hasPermission(workspace, {
        requesterId: workflow.researcherId,
        providerId: workflow.reviewerId,
      })
    ) {
      status = 'canceled';
      error = 'Workflow stopped because an agent or directional connection was revoked.';
    } else if ([brief, check].some((job) => job?.status === 'canceled')) {
      status = 'canceled';
      error = 'A linked workflow job was canceled.';
    } else if ([brief, check].some((job) => job?.status === 'failed')) {
      status = 'failed';
      error = 'A linked workflow job failed. Inspect its result and error.';
    } else if (check) status = check.status === 'completed' ? 'completed' : 'checking';
    else status = brief?.status === 'completed' ? 'awaiting_review' : 'briefing';
    if (status !== workflow.status || error !== workflow.error) {
      workflow.status = status;
      workflow.error = error;
      workflow.updatedAt = iso(time);
      event(
        workspace,
        time,
        `workflow.${status}`,
        `Source brief workflow is ${status.replaceAll('_', ' ')}.`,
        workflow.reviewerId,
        workflow.checkJobId ?? workflow.briefJobId,
      );
    } else {
      const latestJobUpdate = [brief, check].reduce(
        (latest, job) =>
          job && Date.parse(job.updatedAt) > Date.parse(latest) ? job.updatedAt : latest,
        workflow.updatedAt,
      );
      workflow.updatedAt = latestJobUpdate;
    }
    if (status === 'failed' || status === 'canceled') {
      for (const job of [brief, check]) if (job) stopJob(workspace, job, time, error!);
    }
  }
}
/**
 * The owner's view of the workspace (GET /api/snapshot). Up to AGENT_PAGES.threshold agents it is
 * the whole workspace, unchanged; above that it is paged (pagedSnapshot). `include` names agents a
 * paged snapshot must carry (a screen of one agent); a full one carries every agent anyway.
 */
export function snapshot(
  workspace: Workspace,
  operator: Operator,
  time: number,
  options: { include?: readonly string[] } = {},
): Snapshot {
  if (workspace.agents.length > AGENT_PAGES.threshold)
    return pagedSnapshot(workspace, operator, time, options.include ?? []);
  const agents = workspace.agents.map((agent) => ownerAgent(agent, workspace.jobs, time));
  return {
    operator,
    paused: workspace.paused,
    agents,
    connections: workspace.connections,
    jobs: workspace.jobs.slice(-50).reverse().map(publicJob),
    workflows: (workspace.workflows ?? []).slice().reverse().map(publicWorkflow),
    events: workspace.events.slice(-100).reverse(),
    stats: {
      registered: agents.length,
      reachable: agents.filter((agent) => agent.status === 'online' || agent.status === 'working')
        .length,
      working: agents.filter((agent) => agent.status === 'working').length,
      accepted: workspace.jobs.filter((job) => job.acceptance === 'accepted').length,
      operatorAccounts: 1,
    },
    serverTime: iso(time),
  };
}

/** An agent's status as publicAgent computes it, with the running providers looked up once. */
function statusOf(agent: StoredAgent, working: ReadonlySet<string>, time: number): Agent['status'] {
  if (agent.revokedAt) return 'revoked';
  if (!reachable(agent, time)) return 'offline';
  return working.has(agent.id) ? 'working' : 'online';
}

function runningProviders(jobs: readonly StoredJob[]): Set<string> {
  const working = new Set<string>();
  for (const job of jobs) if (job.status === 'running') working.add(job.providerId);
  return working;
}

/**
 * The snapshot of a workspace above AGENT_PAGES.threshold agents: the first page of agents
 * (newest first) and the agents the rest of the snapshot names, with agentsPage saying which is
 * which; stats still count every agent. Jobs, workflows, events and connections are as in full.
 */
function pagedSnapshot(
  workspace: Workspace,
  operator: Operator,
  time: number,
  include: readonly string[],
): Snapshot {
  const working = runningProviders(workspace.jobs);
  let reachableCount = 0;
  let workingCount = 0;
  let live = 0;
  let online = 0;
  for (const agent of workspace.agents) {
    const status = statusOf(agent, working, time);
    if (status === 'online' || status === 'working') reachableCount += 1;
    if (status === 'working') workingCount += 1;
    if (status === 'revoked') continue;
    live += 1;
    if (!agent.pausedAt && (status === 'online' || status === 'working')) online += 1;
  }
  const jobs = workspace.jobs.slice(-50).reverse().map(publicJob);
  const workflows = (workspace.workflows ?? []).slice().reverse().map(publicWorkflow);
  const events = workspace.events.slice(-100).reverse();
  const page = pageAgents(workspace.agents, { limit: AGENT_PAGES.size });
  const related = relatedAgents(workspace, {
    pageIds: new Set(page.items.map((agent) => agent.id)),
    include,
    jobs,
    workflows,
    events,
  });
  const view = (agent: StoredAgent) => ownerAgent(agent, workspace.jobs, time);
  return {
    operator,
    paused: workspace.paused,
    agents: [...page.items.map(view), ...related.map(view)],
    agentsPage: {
      total: workspace.agents.length,
      live,
      online,
      limit: AGENT_PAGES.size,
      count: page.items.length,
      nextCursor: page.nextCursor,
    },
    connections: workspace.connections,
    jobs,
    workflows,
    events,
    stats: {
      registered: workspace.agents.length,
      reachable: reachableCount,
      working: workingCount,
      accepted: workspace.jobs.filter((job) => job.acceptance === 'accepted').length,
      operatorAccounts: 1,
    },
    serverTime: iso(time),
  };
}

export interface AgentListQuery {
  limit?: number;
  cursor?: { createdAt: string; id: string } | null;
  /** Search text (name, description, capability). */
  q?: string;
  /** Only these agents. */
  ids?: readonly string[];
  /** Only the live agents a removal of this agent would take with it. */
  under?: string;
  /** Only agents that are not removed (the pickers of an agent to act as). */
  live?: boolean;
}

/**
 * One page of the owner's agents (GET /api/agents), newest first, for any workspace size: the
 * console pages through a large workspace with it and searches it server-side.
 */
export function listAgents(
  workspace: Workspace,
  time: number,
  query: AgentListQuery,
): AgentListPage {
  const limit = query.limit ?? AGENT_PAGES.size;
  let candidates: StoredAgent[] = workspace.agents;
  if (query.ids) {
    const wanted = new Set(query.ids);
    candidates = candidates.filter((agent) => wanted.has(agent.id));
  }
  if (query.under !== undefined) candidates = liveDescendants(candidates, query.under);
  if (query.live) candidates = candidates.filter((agent) => !agent.revokedAt);
  const page = pageAgents(candidates, {
    limit,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.q ? { query: query.q } : {}),
  });
  return {
    agents: page.items.map((agent) => ownerAgent(agent, workspace.jobs, time)),
    total: workspace.agents.length,
    matched: page.matched,
    limit,
    nextCursor: page.nextCursor,
  };
}
