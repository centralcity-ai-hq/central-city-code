import type { Operator, WorkspaceExport, Agent, Job } from '../shared/types.js';
import { publicAgent, publicWorkflow, shownLastSeenAt, type Workspace } from './model.js';

/** Explicit fields prevent future private storage fields entering portable records. */
export function exportWorkspace(
  workspace: Workspace,
  operator: Operator,
  time: number,
): WorkspaceExport {
  return {
    format: 'central-city-workspace',
    version: 1,
    exportedAt: new Date(time).toISOString(),
    operator: { id: operator.id, name: operator.name },
    paused: workspace.paused,
    agents: workspace.agents.map((agent): Agent => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      capability: agent.capability,
      mode: agent.mode,
      isDemo: agent.isDemo,
      status: publicAgent(agent, workspace.jobs, time).status,
      lastSeenAt: shownLastSeenAt(agent, time),
      createdAt: agent.createdAt,
      revokedAt: agent.revokedAt,
    })),
    connections: workspace.connections.map((connection) => ({
      id: connection.id,
      fromAgentId: connection.fromAgentId,
      toAgentId: connection.toAgentId,
      createdAt: connection.createdAt,
    })),
    jobs: workspace.jobs.map((job): Job => ({
      id: job.id,
      requesterId: job.requesterId,
      providerId: job.providerId,
      capability: job.capability,
      input: job.input,
      status: job.status,
      acceptance: job.acceptance,
      output: job.output,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      acceptedAt: job.acceptedAt,
      costCents: job.costCents,
      error: job.error,
      isDemo: job.isDemo,
    })),
    workflows: (workspace.workflows ?? []).map(publicWorkflow),
    events: workspace.events.map((entry) => ({
      id: entry.id,
      type: entry.type,
      message: entry.message,
      agentId: entry.agentId,
      jobId: entry.jobId,
      createdAt: entry.createdAt,
    })),
    retention: { jobs: 'all-retained', events: 'all-retained', jobLimit: 1000, eventLimit: 1000 },
    purpose: 'portable-records-not-a-recovery-backup',
  };
}
