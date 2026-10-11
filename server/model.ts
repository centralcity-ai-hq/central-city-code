import { randomUUID } from 'node:crypto';
import type {
  Agent,
  CityEvent,
  Connection,
  Job,
  Snapshot,
  Operator,
  Workflow,
} from '../shared/types.js';

export const PRESENCE_TTL = 90_000;
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
export function reachable(agent: StoredAgent, time: number): boolean {
  return (
    !agent.revokedAt &&
    agent.lastSeenAt !== null &&
    time - Date.parse(agent.lastSeenAt) < PRESENCE_TTL
  );
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
export function snapshot(workspace: Workspace, operator: Operator, time: number): Snapshot {
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
