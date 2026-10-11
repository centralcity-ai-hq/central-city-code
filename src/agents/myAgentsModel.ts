import type { ConnectionRequest } from '../../shared/assistant';
import type { Agent } from '../../shared/types';

/** The four states the My agents page shows, derived only from fields the server sends. */
export type AgentStateV2 = 'online' | 'offline' | 'paused' | 'revoked';

/** Removal wins over a pause, a pause wins over presence; "working" counts as online. */
export function agentStateV2(
  agent: Pick<Agent, 'status' | 'revokedAt'> & { pausedAt?: string | null },
): AgentStateV2 {
  if (agent.revokedAt || agent.status === 'revoked') return 'revoked';
  if (agent.pausedAt) return 'paused';
  if (agent.status === 'online' || agent.status === 'working') return 'online';
  return 'offline';
}

/**
 * How the agent runs, from real fields only (no model or runtime names are stored, so the roster
 * shows no "model · self-reported" line). A hosted agent is one started from a template.
 */
export function agentKindLabel(agent: Pick<Agent, 'mode' | 'isDemo'>): string {
  if (agent.isDemo) return 'CC agent';
  return agent.mode === 'external' ? 'Runs on your computer' : 'Template agent';
}

/**
 * Elric, the first-party assistant, by its agent id from GET /api/elric (never by name). Its card
 * offers only "Manage Elric": it is never removed or given a rotated credential from My agents.
 */
export function isElricAgent(agent: Pick<Agent, 'id'>, elricAgentId: string | null | undefined) {
  return Boolean(elricAgentId) && agent.id === elricAgentId;
}

export type AgentFilterV2 = 'all' | AgentStateV2;
export const agentFilters: AgentFilterV2[] = ['all', 'online', 'offline', 'paused', 'revoked'];

export function countAgentStates(agents: Agent[]): Record<AgentFilterV2, number> {
  const counts: Record<AgentFilterV2, number> = {
    all: agents.length,
    online: 0,
    offline: 0,
    paused: 0,
    revoked: 0,
  };
  for (const agent of agents) counts[agentStateV2(agent)] += 1;
  return counts;
}

/** Filter, search and order: live agents first (online, paused, offline), removed ones last. */
export function visibleAgents(agents: Agent[], filter: AgentFilterV2, query: string): Agent[] {
  const needle = query.trim().toLowerCase();
  const rank: Record<AgentStateV2, number> = { online: 0, paused: 1, offline: 2, revoked: 3 };
  return agents
    .filter((agent) => filter === 'all' || agentStateV2(agent) === filter)
    .filter(
      (agent) =>
        !needle ||
        `${agent.name} ${agent.description} ${agent.capability}`.toLowerCase().includes(needle),
    )
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => rank[agentStateV2(a.agent)] - rank[agentStateV2(b.agent)] || a.index - b.index)
    .map(({ agent }) => agent);
}

/** Agents removed together with this one (removal cascades down the parentAgentId lineage). */
export function removalDescendants(agents: Agent[], id: string): Agent[] {
  const found: Agent[] = [];
  const queue = [id];
  const seen = new Set(queue);
  while (queue.length) {
    const parent = queue.shift()!;
    for (const agent of agents)
      if (agent.parentAgentId === parent && !seen.has(agent.id) && !agent.revokedAt) {
        seen.add(agent.id);
        found.push(agent);
        queue.push(agent.id);
      }
  }
  return found;
}

export interface PendingRequestV2 {
  id: string;
  agentName: string;
  ownerLabel: string;
  /** The agent of yours it wants to reach (its name, when it is in this workspace). */
  toAgentName: string | null;
  note: string;
  expiresAt: string;
}

/** Incoming cross-owner requests still waiting for a decision, soonest deadline first. */
export function pendingRequests(
  incoming: ConnectionRequest[],
  agents: Pick<Agent, 'id' | 'name'>[],
  now: number,
): PendingRequestV2[] {
  return incoming
    .filter(
      (item) =>
        item.direction === 'incoming' &&
        item.status === 'pending' &&
        !(Date.parse(item.expires_at) <= now),
    )
    .sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at))
    .map((item) => ({
      id: item.id,
      agentName: item.from_agent_name?.trim() || 'An agent',
      ownerLabel: item.from_owner_label?.trim() || 'Another owner',
      toAgentName:
        item.to_agent_name ?? agents.find((agent) => agent.id === item.to_agent_id)?.name ?? null,
      note: item.note,
      expiresAt: item.expires_at,
    }));
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** "Expires in 5 days", "Expires in 3 hours", "Expires in under an hour", "Expired". */
export function expiryLabel(expiresAt: string, now: number): string {
  const left = Date.parse(expiresAt) - now;
  if (!Number.isFinite(left)) return 'No expiry date';
  if (left <= 0) return 'Expired';
  if (left >= DAY) {
    const days = Math.floor(left / DAY);
    return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`;
  }
  if (left >= HOUR) {
    const hours = Math.floor(left / HOUR);
    return `Expires in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  return 'Expires in under an hour';
}

/**
 * Workspace v3 roster tabs (WORKSPACE_V3_ELRIC_AGENTS.md §2). The server knows four states;
 * "Active" is every live agent that is not paused (online or offline), "Removed" is revoked.
 */
export type RosterTab = 'all' | 'active' | 'paused' | 'removed';
export const rosterTabs: RosterTab[] = ['all', 'active', 'paused', 'removed'];
export const rosterTabLabels: Record<RosterTab, string> = {
  all: 'All',
  active: 'Active',
  paused: 'Paused',
  removed: 'Removed',
};

export function inRosterTab(state: AgentStateV2, tab: RosterTab): boolean {
  if (tab === 'all') return true;
  if (tab === 'removed') return state === 'revoked';
  if (tab === 'paused') return state === 'paused';
  return state === 'online' || state === 'offline';
}

/** The roster's rows: Elric is pinned on its own row, so it is left out here. */
export function rosterAgents(
  agents: Agent[],
  tab: RosterTab,
  query: string,
  elricAgentId: string | null | undefined,
): Agent[] {
  return visibleAgents(
    agents.filter((agent) => !isElricAgent(agent, elricAgentId)),
    'all',
    query,
  ).filter((agent) => inRosterTab(agentStateV2(agent), tab));
}

/** The page pill: "My agents N · M online", over live agents other than Elric. */
export function rosterCounts(agents: Agent[], elricAgentId: string | null | undefined) {
  let total = 0;
  let online = 0;
  for (const agent of agents) {
    if (isElricAgent(agent, elricAgentId)) continue;
    const state = agentStateV2(agent);
    if (state === 'revoked') continue;
    total += 1;
    if (state === 'online') online += 1;
  }
  return { total, online };
}

/** Elric's own state (GET /api/elric): 'active' is shown as "On". */
export type ElricState = 'active' | 'paused' | 'revoked' | null | undefined;

/** Elric's pinned row: shown while Elric is on or paused, on the tabs that state belongs to. */
export function showElricRow(status: ElricState, tab: RosterTab, query: string): boolean {
  if (status !== 'active' && status !== 'paused') return false;
  const needle = query.trim().toLowerCase();
  if (needle && !'elric'.includes(needle)) return false;
  if (tab === 'all') return true;
  return status === 'active' ? tab === 'active' : tab === 'paused';
}

/** One room one of your agents is in (GET /api/rooms plus that room's members). */
export interface AgentRoom {
  roomId: string;
  name: string;
  /** The agent's role there: a host agent cannot leave its own room (close it instead). */
  role: 'host' | 'member' | 'guest';
  joinedAt: string | null;
  /** Its posts in the room today (UTC); null when the server does not say. */
  messagesToday: number | null;
}

/** Room chips: at most two names, then "+N". */
export function roomChips(rooms: Pick<AgentRoom, 'name'>[], max = 2) {
  return {
    shown: rooms.slice(0, max).map((room) => room.name),
    more: Math.max(0, rooms.length - max),
  };
}

/** The sum of today's posts across rooms, or null when no room reports it. */
export function messagesToday(rooms: Pick<AgentRoom, 'messagesToday'>[]): number | null {
  let known = false;
  let sum = 0;
  for (const room of rooms)
    if (typeof room.messagesToday === 'number') {
      known = true;
      sum += room.messagesToday;
    }
  return known ? sum : null;
}

/** The typed confirm: the agent's exact name (outer spaces ignored, case counts). */
export function confirmsName(typed: string, name: string): boolean {
  return name.trim().length > 0 && typed.trim() === name.trim();
}
