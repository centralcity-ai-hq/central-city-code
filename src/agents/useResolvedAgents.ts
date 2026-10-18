import { useEffect, useMemo, useState } from 'react';
import type { Agent, Snapshot } from '../../shared/types';
import { mergeAgents } from './agentPages';
import { readAgentsById } from './ownAgents';

/**
 * The snapshot's agents plus the agents named by `ids` that it does not carry, read by id
 * (GET /api/agents?ids=, 50 at a time). Only a paged snapshot (src/agents/agentPages.ts) can
 * miss an agent; for any other this is snapshot.agents and nothing is read. An id is asked for
 * once: one that is not found (a removed agent's message) is not asked for again.
 */
export function useResolvedAgents(
  snapshot: Pick<Snapshot, 'agents' | 'agentsPage'>,
  ids: readonly string[],
): Agent[] {
  const paged = Boolean(snapshot.agentsPage);
  const [read, setRead] = useState<{ asked: ReadonlySet<string>; agents: Agent[] }>(() => ({
    asked: new Set(),
    agents: [],
  }));
  const carried = useMemo(
    () => new Set(snapshot.agents.map((agent) => agent.id)),
    [snapshot.agents],
  );
  const missing = paged
    ? [...new Set(ids)].filter((id) => id && !carried.has(id) && !read.asked.has(id)).sort()
    : [];
  const key = missing.join(',');
  useEffect(() => {
    if (!key) return;
    const wanted = key.split(',');
    const controller = new AbortController();
    readAgentsById(wanted, controller.signal).then(
      (found) => {
        if (controller.signal.aborted) return;
        setRead((current) => ({
          asked: new Set([...current.asked, ...wanted]),
          agents: mergeAgents(found, current.agents),
        }));
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [key]);
  return useMemo(
    () =>
      paged && read.agents.length ? mergeAgents(snapshot.agents, read.agents) : snapshot.agents,
    [paged, snapshot.agents, read.agents],
  );
}
