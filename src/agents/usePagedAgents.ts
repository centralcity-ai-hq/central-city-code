import { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_PAGES } from '../../shared/agent-pages';
import type { Agent, AgentListPage, Snapshot } from '../../shared/types';
import { api, selectedWorkspaceId } from '../api';
import { agentsPath, mergeAgents, snapshotPage } from './agentPages';

/** Search waits this long after the last keystroke before it asks the server. */
export const SEARCH_DELAY_MS = 300;

export interface PagedAgents {
  /** The workspace is paged (more than 500 agents); false: everything below is the snapshot's. */
  paged: boolean;
  /** The roster's agents: the loaded pages, or the search results while searching. */
  listed: Agent[];
  /** Every agent read so far, for looking one up by id (an open agent, a name). */
  known: Agent[];
  /** Agents of the workspace (paged), or of the search (searching). */
  of: number;
  /** A search of the whole workspace is shown (paged and the search box has text). */
  searching: boolean;
  /** A page or a search is on its way. */
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  /** After an error: asks again for what failed (the search, or the next page). */
  retry: () => void;
}

type More = { agents: Agent[]; cursor: string | null };
type Search = { q: string; agents: Agent[]; matched: number; cursor: string | null };

const message = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'The agents could not be loaded.';

/**
 * My agents in a paged workspace (src/agents/agentPages.ts): the snapshot's first page, older
 * pages on "Load more", the search run on the server over every agent (a page holds too few to
 * search in), and single agents read by id when one is opened from elsewhere, with the agents a
 * removal of the open agent takes. In a workspace that is not paged it reads nothing.
 */
export function usePagedAgents(
  snapshot: Pick<Snapshot, 'agents' | 'agentsPage'>,
  query: string,
  openId: string | null,
): PagedAgents {
  const page = snapshot.agentsPage;
  const paged = Boolean(page);
  const workspace = selectedWorkspaceId();
  const [more, setMore] = useState<More | null>(null);
  const [search, setSearch] = useState<Search | null>(null);
  const [extra, setExtra] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by retry() to run a failed search again. */
  const [attempt, setAttempt] = useState(0);
  /** Bumped on a workspace switch or when paging stops: answers of an older one are dropped. */
  const generation = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const q = paged ? query.trim().slice(0, AGENT_PAGES.query) : '';

  useEffect(() => {
    generation.current += 1;
    inFlight.current?.abort();
    setMore(null);
    setSearch(null);
    setExtra([]);
    setLoading(false);
    setError(null);
  }, [workspace, paged]);

  /** One GET /api/agents in the current generation; null when its answer no longer counts. */
  const read = useCallback(async (path: string, signal?: AbortSignal) => {
    const current = generation.current;
    const value = await api<AgentListPage>(path, undefined, 'GET', signal);
    return current === generation.current ? value : null;
  }, []);

  // The search: asked of the server shortly after typing stops; a newer one replaces it.
  useEffect(() => {
    if (!paged || !q) {
      setSearch(null);
      return;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      inFlight.current?.abort();
      inFlight.current = abort;
      setLoading(true);
      setError(null);
      read(agentsPath({ q, limit: AGENT_PAGES.size }), abort.signal)
        .then((found) => {
          if (!found || abort.signal.aborted) return;
          setSearch({ q, agents: found.agents, matched: found.matched, cursor: found.nextCursor });
        })
        .catch((err) => {
          if (!abort.signal.aborted) setError(message(err));
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, SEARCH_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
      setLoading(false);
    };
  }, [paged, q, read, attempt]);

  // An agent opened from elsewhere (a link, Messages) that no loaded page has: read it by id.
  // The open agent's sub-agents too, so Remove names every agent it takes with it.
  const knownNow = mergeAgents(snapshot.agents, more?.agents ?? [], search?.agents ?? [], extra);
  const openKnown = openId ? knownNow.some((agent) => agent.id === openId) : true;
  useEffect(() => {
    if (!paged || !openId) return;
    const abort = new AbortController();
    const reads = [agentsPath({ under: openId, limit: AGENT_PAGES.max })];
    if (!openKnown) reads.unshift(agentsPath({ ids: [openId] }));
    void Promise.all(reads.map((path) => read(path, abort.signal).catch(() => null))).then(
      (pages) => {
        if (abort.signal.aborted) return;
        const found = pages.flatMap((item) => item?.agents ?? []);
        if (found.length) setExtra((old) => mergeAgents(found, old));
      },
    );
    return () => abort.abort();
    // openKnown is read once per open agent (left out of the dependencies on purpose): an agent
    // found by this read does not read again.
  }, [paged, openId, read]);

  const searching = paged && Boolean(q);
  const cursor = searching
    ? (search?.cursor ?? null)
    : more
      ? more.cursor
      : (page?.nextCursor ?? null);

  const loadMore = useCallback(() => {
    if (!paged || !cursor || loading) return;
    const abort = new AbortController();
    inFlight.current?.abort();
    inFlight.current = abort;
    setLoading(true);
    setError(null);
    const pinned = snapshotPage(snapshot);
    read(agentsPath({ cursor, limit: AGENT_PAGES.size, ...(searching ? { q } : {}) }), abort.signal)
      .then((next) => {
        if (!next || abort.signal.aborted) return;
        if (searching)
          setSearch((old) =>
            old && old.q === q
              ? {
                  ...old,
                  agents: mergeAgents(old.agents, next.agents),
                  cursor: next.nextCursor,
                }
              : old,
          );
        // The first older page keeps the page it follows: a snapshot read later starts at newer
        // agents, and the ones it no longer has must stay listed.
        else
          setMore((old) => ({
            agents: mergeAgents(old?.agents ?? pinned, next.agents),
            cursor: next.nextCursor,
          }));
      })
      .catch((err) => {
        if (!abort.signal.aborted) setError(message(err));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
  }, [paged, cursor, loading, snapshot, read, searching, q]);

  if (!page)
    return {
      paged: false,
      listed: snapshot.agents,
      known: snapshot.agents,
      of: snapshot.agents.length,
      searching: false,
      loading: false,
      error: null,
      hasMore: false,
      loadMore,
      retry: loadMore,
    };
  const listed = searching
    ? search?.q === q
      ? search.agents
      : []
    : mergeAgents(snapshotPage(snapshot), more?.agents ?? []);
  // The snapshot's own copy is the freshest: it wins where an agent is in both.
  const fresh = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  return {
    paged: true,
    listed: listed.map((agent) => fresh.get(agent.id) ?? agent),
    known: knownNow,
    of: searching ? (search?.q === q ? search.matched : 0) : page.total,
    searching,
    loading: loading || (searching && search?.q !== q && !error),
    error,
    hasMore: Boolean(cursor) && (!searching || search?.q === q),
    loadMore,
    retry: () => {
      if (searching && search?.q !== q) setAttempt((count) => count + 1);
      else loadMore();
    },
  };
}
