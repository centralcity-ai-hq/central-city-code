import { AGENT_PAGES } from '../shared/agent-pages.js';
import type { StoredAgent, Workspace } from './model.js';

/*
 * Paging helpers for owner agent lists (shared/agent-pages.ts). Pure: no database, no clock. The
 * workspace document is still read once per request (JSONB storage); what these spare is building,
 * serializing and sending every agent when only a page is shown.
 */

type Keyed = Pick<StoredAgent, 'id' | 'createdAt'>;

/** Newest first: createdAt descending, then id descending, so the order is total and stable. */
export function newestFirst(a: Keyed, b: Keyed): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Whether `agent` comes after the cursor's agent in newest-first order. */
function after(agent: Keyed, cursor: Keyed): boolean {
  return newestFirst(cursor, agent) < 0;
}

/** Opaque to callers: the createdAt and id of the last agent of the page. */
export function encodeAgentCursor(agent: Keyed): string {
  return Buffer.from(JSON.stringify([agent.createdAt, agent.id])).toString('base64url');
}

/** The cursor is ours (two short strings); anything else is null. */
export function decodeAgentCursor(cursor: string): Keyed | null {
  if (cursor.length > AGENT_PAGES.cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string' &&
      value[0].length <= 64 &&
      value[1].length <= 64
    )
      return { createdAt: value[0], id: value[1] };
  } catch {
    // fall through
  }
  return null;
}

/** The same match as the console's own search (src/agents/myAgentsModel.ts visibleAgents). */
export function agentMatches(
  agent: Pick<StoredAgent, 'name' | 'description' | 'capability'>,
  needle: string,
): boolean {
  return `${agent.name} ${agent.description} ${agent.capability}`.toLowerCase().includes(needle);
}

export interface AgentPageOptions {
  limit: number;
  cursor?: Keyed | null;
  /** Search text; matched case-insensitively against name, description and capability. */
  query?: string;
}

/** One page of `agents`, newest first, after `cursor`; `matched` counts every match. */
export function pageAgents<T extends StoredAgent>(
  agents: readonly T[],
  options: AgentPageOptions,
): { items: T[]; matched: number; nextCursor: string | null } {
  const needle = options.query?.trim().toLowerCase() ?? '';
  const matching = needle ? agents.filter((agent) => agentMatches(agent, needle)) : agents;
  const cursor = options.cursor;
  const rest = cursor ? matching.filter((agent) => after(agent, cursor)) : matching.slice();
  rest.sort(newestFirst);
  const items = rest.slice(0, options.limit);
  return {
    items,
    matched: matching.length,
    nextCursor: rest.length > items.length ? encodeAgentCursor(items[items.length - 1]!) : null,
  };
}

/**
 * Live agents below `rootId` in the parentAgentId lineage, walking through live agents only, in
 * breadth-first order: the agents a removal takes with it, as the console lists them
 * (removalDescendants in src/agents/myAgentsModel.ts). Linear in the workspace; at most `max`.
 */
export function liveDescendants<T extends StoredAgent>(
  agents: readonly T[],
  rootId: string,
  max = Number.POSITIVE_INFINITY,
): T[] {
  const children = new Map<string, T[]>();
  for (const agent of agents) {
    if (!agent.parentAgentId || agent.revokedAt) continue;
    const list = children.get(agent.parentAgentId);
    if (list) list.push(agent);
    else children.set(agent.parentAgentId, [agent]);
  }
  const found: T[] = [];
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length && found.length < max) {
    for (const agent of children.get(queue.shift()!) ?? []) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      found.push(agent);
      queue.push(agent.id);
      if (found.length >= max) break;
    }
  }
  return found;
}

/**
 * The other agents a paged snapshot carries so what it shows has names: the agents asked for
 * with include= (with their parent, the agents removed with them and the agents they are
 * connected to), then the agents of the jobs, workflows and events it sends, then those of the
 * connections. Agents of the page are left out; at most AGENT_PAGES.related.
 */
export function relatedAgents<T extends StoredAgent>(
  workspace: { agents: readonly T[]; connections: Workspace['connections'] },
  sent: {
    pageIds: ReadonlySet<string>;
    include: readonly string[];
    jobs: ReadonlyArray<{ requesterId: string; providerId: string }>;
    workflows: ReadonlyArray<{ requesterId: string; researcherId: string; reviewerId: string }>;
    events: ReadonlyArray<{ agentId: string | null }>;
  },
  max: number = AGENT_PAGES.related,
): T[] {
  const byId = new Map(workspace.agents.map((agent) => [agent.id, agent]));
  const out: T[] = [];
  const taken = new Set<string>();
  const add = (id: string | null | undefined) => {
    if (!id || out.length >= max || taken.has(id) || sent.pageIds.has(id)) return;
    const agent = byId.get(id);
    if (!agent) return;
    taken.add(id);
    out.push(agent);
  };
  const included = sent.include.filter((id) => byId.has(id));
  for (const id of included) add(id);
  for (const id of included) add(byId.get(id)!.parentAgentId);
  for (const id of included)
    for (const agent of liveDescendants(workspace.agents, id, max)) add(agent.id);
  if (included.length) {
    const wanted = new Set(included);
    for (const connection of workspace.connections) {
      if (wanted.has(connection.fromAgentId)) add(connection.toAgentId);
      if (wanted.has(connection.toAgentId)) add(connection.fromAgentId);
    }
  }
  for (const job of sent.jobs) {
    add(job.requesterId);
    add(job.providerId);
  }
  for (const workflow of sent.workflows) {
    add(workflow.requesterId);
    add(workflow.researcherId);
    add(workflow.reviewerId);
  }
  for (const item of sent.events) add(item.agentId);
  for (const connection of workspace.connections) {
    if (out.length >= max) break;
    add(connection.fromAgentId);
    add(connection.toAgentId);
  }
  return out;
}
