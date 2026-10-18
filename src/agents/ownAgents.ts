import { AGENT_PAGES } from '../../shared/agent-pages';
import type { Agent, AgentListPage } from '../../shared/types';
import { api } from '../api';
import { agentsPath } from './agentPages';

/*
 * Reads of the owner's agents for the screens that pick one or name one, in a paged workspace
 * (src/agents/agentPages.ts): there the snapshot carries only a page of agents, so a picker
 * searches GET /api/agents on the server and a name not in the snapshot is read by id. A workspace
 * that is not paged never calls these: its snapshot has every agent. No React here.
 */

/** Matches a picker shows for one search. */
export const PICKER_RESULTS = 50;

/** The workspace's live agents matching `q` (name, description, capability), newest first. */
export async function searchLiveAgents(q: string, signal?: AbortSignal): Promise<Agent[]> {
  const page = await api<AgentListPage>(
    agentsPath({ q, live: true, limit: PICKER_RESULTS }),
    undefined,
    'GET',
    signal,
  );
  return page.agents;
}

/**
 * The owner's agents with these ids (removed ones included), read AGENT_PAGES.ids at a time and
 * one request after the other: every GET /api/agents reads the whole workspace document, so
 * parallel batches would take several database connections at once for one screen.
 */
export async function readAgentsById(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Agent[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  const found: Agent[] = [];
  for (let start = 0; start < unique.length; start += AGENT_PAGES.ids) {
    const batch = unique.slice(start, start + AGENT_PAGES.ids);
    const page = await api<AgentListPage>(
      agentsPath({ ids: batch, limit: AGENT_PAGES.ids }),
      undefined,
      'GET',
      signal,
    );
    found.push(...page.agents);
  }
  return found;
}
