export type Capability = 'research' | 'extract' | 'verify';
export interface Operator {
  id: string;
  name: string;
}
/** Who created an agent. Absent on agents created before Phase 2 (owner console or legacy tools). */
export interface AgentCreator {
  kind: 'owner' | 'assistant' | 'oauth-client' | 'agent' | 'anonymous-client' | 'workspace-key';
  /** Operator id, assistant grant id or workspace key id. Never recorded for anonymous clients. */
  id?: string;
  /** OAuth client id when the creator is a remote MCP client. */
  clientId?: string;
}
export interface Agent {
  id: string;
  name: string;
  description: string;
  capability: Capability;
  mode: 'hosted' | 'external';
  isDemo: boolean;
  status: 'online' | 'working' | 'offline' | 'revoked';
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** Set while the agent is paused (city_control); paused agents cannot send or receive work. */
  pausedAt?: string | null;
  /** Manifest identity (centralcity.agent/v1) for agents applied from a manifest. */
  manifestName?: string;
  manifestHash?: string;
  revision?: number;
  createdBy?: AgentCreator;
  /** Card visibility chosen at creation; absent for agents created without a manifest. */
  visibility?: 'private' | 'public';
  /** Lineage: the agent this one was created under, and its distance from the lineage root. */
  parentAgentId?: string | null;
  depth?: number;
  /** Accountable principal at the root of the lineage: an operator id or an unclaimed source. */
  rootSponsor?: string;
  /** When an unclaimed agent was claimed into this workspace. */
  claimedAt?: string;
  /**
   * Owner views only: the last 4 characters of the current runtime credential (e.g. "…a91f"), or
   * null when the agent has none or it was issued before hints were kept.
   */
  credentialHint?: string | null;
}
export interface Connection {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  createdAt: string;
}
export interface Job {
  id: string;
  requesterId: string;
  providerId: string;
  capability: Capability;
  input: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  acceptance: 'pending' | 'accepted';
  output: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  acceptedAt: string | null;
  costCents: number | null;
  error: string | null;
  isDemo: boolean;
}
export interface CityEvent {
  id: string;
  type: string;
  message: string;
  agentId: string | null;
  jobId: string | null;
  createdAt: string;
}
export interface Workflow {
  id: string;
  requesterId: string;
  researcherId: string;
  reviewerId: string;
  source: string;
  briefJobId: string;
  checkJobId: string | null;
  status:
    'briefing' | 'awaiting_review' | 'checking' | 'completed' | 'accepted' | 'failed' | 'canceled';
  createdAt: string;
  updatedAt: string;
  error: string | null;
}
export interface WorkflowDetail {
  workflow: Workflow;
  briefJob: Job;
  checkJob: Job | null;
}
export interface Snapshot {
  operator: Operator;
  paused: boolean;
  agents: Agent[];
  connections: Connection[];
  jobs: Job[];
  workflows: Workflow[];
  events: CityEvent[];
  stats: {
    registered: number;
    reachable: number;
    working: number;
    accepted: number;
    operatorAccounts: number;
  };
  serverTime: string;
}

/** One line of an agent's Activity feed (GET /api/agents/:id/activity), newest first. */
export type AgentActivityItem =
  | {
      kind: 'event';
      id: string;
      at: string;
      type: string;
      text: string;
      jobId: string | null;
    }
  | {
      kind: 'run';
      id: string;
      /** When the run was requested; the feed is ordered by this, so pages never shift. */
      at: string;
      updatedAt: string;
      completedAt: string | null;
      status: 'done' | 'running' | 'failed';
      capability: Capability;
      /** This agent did the work ('provider') or asked for it ('requester'). */
      role: 'provider' | 'requester';
      counterpart: { id: string; name: string | null };
      error: string | null;
    };
export interface AgentActivityPage {
  items: AgentActivityItem[];
  /** Pass as ?before= for the next (older) page; null when there is nothing older. */
  nextBefore: string | null;
}

export interface WorkspaceExport {
  format: 'central-city-workspace';
  version: 1;
  exportedAt: string;
  operator: Operator;
  paused: boolean;
  agents: Agent[];
  connections: Connection[];
  jobs: Job[];
  workflows: Workflow[];
  events: CityEvent[];
  retention: {
    jobs: 'all-retained';
    events: 'all-retained';
    jobLimit: 1000;
    eventLimit: 1000;
  };
  purpose: 'portable-records-not-a-recovery-backup';
}
