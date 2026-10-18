import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AGENT_PAGES } from '../../shared/agent-pages';

/*
 * The search of an agent picker in a paged workspace (src/agents/agentPages.ts). There the list a
 * picker starts from is a page of the newest agents, so it gets a search box that asks the server
 * over every agent; the agents already chosen stay offered whatever the search shows. Without a
 * search (a workspace that is not paged) the picker lists exactly what it did before.
 */

export type Pickable = { id: string; name: string };

/** Search waits this long after the last keystroke before it asks the server. */
export const PICKER_SEARCH_DELAY_MS = 300;

/**
 * What a picker offers: the search results while there is a search (null until they arrive),
 * else its own list; either way led by the chosen agents it would otherwise leave out.
 */
export function pickerAgents<T extends Pickable>(
  base: readonly T[] | null,
  results: readonly T[] | null,
  chosen: readonly string[],
  known: ReadonlyMap<string, T>,
): T[] | null {
  if (base === null) return null;
  const listed = results ?? base;
  const ids = new Set(listed.map((agent) => agent.id));
  const kept: T[] = [];
  for (const id of chosen) {
    if (!id || ids.has(id)) continue;
    const agent = known.get(id);
    if (!agent) continue;
    ids.add(id);
    kept.push(agent);
  }
  return [...kept, ...listed];
}

export interface AgentPicker<T extends Pickable> {
  /** The agents to offer (null while the picker's own list loads). */
  agents: T[] | null;
  /** The search box, or null when the picker has no search (not a paged workspace). */
  field: ReactNode;
  /** Every agent this picker has seen, by id (for the name of a chosen one). */
  known: ReadonlyMap<string, T>;
}

/**
 * `base` is the picker's own list; `search`, when given, finds agents of the whole workspace
 * (src/agents/ownAgents.ts); `chosen` are the ids selected now.
 */
export function useAgentPicker<T extends Pickable>(
  base: readonly T[] | null,
  search: ((q: string, signal: AbortSignal) => Promise<T[]>) | null,
  chosen: readonly string[],
  options: { label?: string; className?: string } = {},
): AgentPicker<T> {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ q: string; agents: T[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const known = useRef(new Map<string, T>());
  for (const agent of base ?? []) known.current.set(agent.id, agent);
  for (const agent of found?.agents ?? []) known.current.set(agent.id, agent);
  const q = search ? query.trim().slice(0, AGENT_PAGES.query) : '';
  // Callers may pass a new function each render; the search runs again only for a new text.
  const searchRef = useRef(search);
  searchRef.current = search;
  const searching = Boolean(search);

  useEffect(() => {
    setFailed(null);
    const run = searchRef.current;
    if (!q || !run) {
      setFound(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      run(q, controller.signal)
        .then((agents) => {
          if (!controller.signal.aborted) setFound({ q, agents });
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(q);
        });
    }, PICKER_SEARCH_DELAY_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [q, searching]);

  const results = q ? (found?.q === q ? found.agents : null) : null;
  const agents = pickerAgents(base, q ? (results ?? []) : null, chosen, known.current);
  const label = options.label ?? 'Search all your agents';
  const status = !q
    ? ''
    : failed === q
      ? 'The search failed. Try again.'
      : results === null
        ? 'Searching…'
        : results.length
          ? ''
          : 'No agents match.';
  const field = search ? (
    <div className={options.className ?? 'agent-picker-search'}>
      <input
        type="search"
        value={query}
        placeholder={label}
        aria-label={label}
        maxLength={AGENT_PAGES.query}
        style={{ width: '100%', boxSizing: 'border-box' }}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // Enter searches; it must not submit the form the picker is in.
          if (event.key === 'Enter') event.preventDefault();
        }}
      />
      {status ? (
        <small role="status" className="agent-picker-status">
          {status}
        </small>
      ) : null}
    </div>
  ) : null;
  return { agents, field, known: known.current };
}
