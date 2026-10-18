import { AGENT_PAGES, AGENTS_PATH } from '../../shared/agent-pages';
import type { Agent, AgentsPageInfo, Snapshot } from '../../shared/types';

/*
 * Paged owner agent lists in the console (shared/agent-pages.ts). A workspace of more than 500
 * agents gets a paged snapshot: its first page of agents (newest first) plus the agents the rest
 * of the snapshot names. My agents lists that page and loads older pages and search results from
 * GET /api/agents; a screen of one agent asks the snapshot to include it. A smaller workspace
 * sends and reads exactly what it did before. No React here.
 */

/** Workspaces whose latest snapshot was paged (null: the person's own). */
/** An agent id: a UUID (the server refuses anything else in include=). */
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const paged = new Set<string | null>();

/** Remembers whether the workspace's latest snapshot was paged (useSnapshot calls this). */
export function noteSnapshotPaging(
  workspace: string | null,
  snapshot: Pick<Snapshot, 'agentsPage'>,
): void {
  if (snapshot.agentsPage) paged.add(workspace);
  else paged.delete(workspace);
}

export function isPagedWorkspace(workspace: string | null): boolean {
  return paged.has(workspace);
}

/** The agent open in My agents, if any: the console's snapshot poll includes it. */
let openAgent: string | null = null;

/** My agents notes the agent it has open (null when none is, or it closes). */
export function noteOpenAgent(id: string | null): void {
  openAgent = id || null;
}

/**
 * The console's snapshot poll (src/useSnapshot.ts): with include=<open agent> in a paged
 * workspace, so an open agent of a later page keeps a fresh status; '/api/snapshot' otherwise.
 */
export function pollSnapshotPath(workspace: string | null): string {
  return snapshotPath(workspace, openAgent ? [openAgent] : []);
}

/**
 * GET /api/snapshot for a screen of these agents: with include= only in a paged workspace, so an
 * agent of a later page is in it; unchanged ('/api/snapshot') everywhere else.
 */
export function snapshotPath(workspace: string | null, include: readonly string[]): string {
  // Only agent ids (UUIDs): a hand-typed #agent=<anything> must never make every poll answer 400.
  const ids = [...new Set(include.filter((id) => AGENT_ID.test(id)))].slice(0, AGENT_PAGES.include);
  if (!isPagedWorkspace(workspace) || !ids.length) return '/api/snapshot';
  return `/api/snapshot?include=${ids.map(encodeURIComponent).join(',')}`;
}

export interface AgentsQuery {
  limit?: number;
  cursor?: string | null;
  q?: string;
  ids?: readonly string[];
  under?: string;
  /** Only agents that are not removed. */
  live?: boolean;
}

/** GET /api/agents with only the parameters given (an empty search is no search). */
export function agentsPath(query: AgentsQuery = {}): string {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const q = query.q?.trim().slice(0, AGENT_PAGES.query);
  if (q) params.set('q', q);
  if (query.ids?.length) params.set('ids', query.ids.slice(0, AGENT_PAGES.ids).join(','));
  if (query.under) params.set('under', query.under);
  if (query.live) params.set('live', '1');
  const text = params.toString();
  return text ? `${AGENTS_PATH}?${text}` : AGENTS_PATH;
}

/** Agents of several lists, each once: the first list an agent is in wins (the freshest first). */
export function mergeAgents(...lists: ReadonlyArray<readonly Agent[]>): Agent[] {
  const seen = new Set<string>();
  const out: Agent[] = [];
  for (const list of lists)
    for (const agent of list) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      out.push(agent);
    }
  return out;
}

/** The page at the start of a paged snapshot's agents (all of them when it is not paged). */
export function snapshotPage<T = Agent>(snapshot: {
  agents: T[];
  agentsPage?: AgentsPageInfo | undefined;
}): T[] {
  return snapshot.agentsPage
    ? snapshot.agents.slice(0, snapshot.agentsPage.count)
    : snapshot.agents;
}

/**
 * The page pill of a paged workspace ("N online"), from the server's counts over every agent,
 * without Elric (pinned on its own row) when the snapshot has it.
 */
export function pagedRosterCounts(
  page: AgentsPageInfo,
  agents: readonly Agent[],
  elricAgentId: string | null | undefined,
): { total: number; online: number } {
  const elric = elricAgentId ? agents.find((agent) => agent.id === elricAgentId) : undefined;
  const elricLive = Boolean(elric && !elric.revokedAt && elric.status !== 'revoked');
  const elricOnline =
    elricLive && !elric!.pausedAt && (elric!.status === 'online' || elric!.status === 'working');
  return {
    total: Math.max(0, page.live - (elricLive ? 1 : 0)),
    online: Math.max(0, page.online - (elricOnline ? 1 : 0)),
  };
}

/** "Showing 200 of 12,345 agents" / "12 of 40 matches". */
export function pageSummary(shown: number, of: number, searching: boolean): string {
  const total = of.toLocaleString('en-US');
  if (searching)
    return `${shown.toLocaleString('en-US')} of ${total} ${of === 1 ? 'match' : 'matches'}`;
  return `Showing ${shown.toLocaleString('en-US')} of ${total} agents`;
}
