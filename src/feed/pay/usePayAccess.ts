import { useEffect, useSyncExternalStore } from 'react';
import type { FeedPayAgent, FeedPayAgentList } from '../../../shared/feed-pay';
import { onFeedForget } from '../feedPaths';
import {
  getPayAgents,
  payFailure,
  setFloatTarget,
  setPerCallMax,
  type PayFailure,
} from '../payApi';

/*
 * Whether "Use with my agent" is there for the signed-in person, and their agents that could pay:
 * one read of GET /api/feed/pay/agents (404 not_found = Feed pay off, or not allowed for this
 * person yet). Kept for the page load and read again when the use sheet opens, since balances
 * change; dropped on sign-out. Until it answers (and on a server render) the drawer is today's
 * drawer, so nothing about paying shows to someone it isn't for.
 */

export type PayAccess =
  | { phase: 'unknown' }
  | { phase: 'off' }
  | { phase: 'signed_out' }
  | { phase: 'on'; list: FeedPayAgentList; loading: boolean }
  | { phase: 'error'; failure: PayFailure };

const UNKNOWN: PayAccess = { phase: 'unknown' };
/** A read older than this is renewed when a drawer opens. */
const FRESH_MS = 60_000;

let access: PayAccess = UNKNOWN;
let readAt = 0;
let reading: Promise<void> | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function set(next: PayAccess) {
  access = next;
  for (const listener of listeners) listener();
}

/** Reads the agents (again); one read at a time. `fresh` renews a recent answer too. */
export function loadPayAccess(fresh = false): Promise<void> {
  if (reading) return reading;
  if (
    !fresh &&
    access.phase !== 'unknown' &&
    access.phase !== 'error' &&
    Date.now() - readAt < FRESH_MS
  )
    return Promise.resolve();
  const started = generation;
  if (access.phase === 'on') set({ ...access, loading: true });
  reading = getPayAgents()
    .then(
      (list) => {
        if (started !== generation) return;
        readAt = Date.now();
        set({ phase: 'on', list, loading: false });
      },
      (error: unknown) => {
        if (started !== generation) return;
        const failure = payFailure(error);
        readAt = Date.now();
        if (failure.code === 'not_found') return set({ phase: 'off' });
        if (failure.code === 'signed_out') return set({ phase: 'signed_out' });
        // A failed read keeps a list already shown (marked as not loading); else it is an error.
        set(access.phase === 'on' ? { ...access, loading: false } : { phase: 'error', failure });
      },
    )
    .finally(() => {
      reading = null;
    });
  return reading;
}

/** One agent changed (its per-call maximum): the list shows it at once. */
export function updatePayAgent(agent: FeedPayAgent) {
  if (access.phase !== 'on') return;
  set({
    ...access,
    list: {
      ...access.list,
      agents: access.list.agents.map((item) => (item.agentId === agent.agentId ? agent : item)),
    },
  });
}

/**
 * Saves an agent's per-call maximum (null: the default), and every screen that shows it (the use
 * sheet, the wallet) has the new one at once.
 */
export async function savePerCallMax(agentId: string, raw: string | null): Promise<FeedPayAgent> {
  const saved = await setPerCallMax(agentId, raw);
  updatePayAgent(saved);
  return saved;
}

/** A new pot target for one agent; the cached list shows it at once. */
export async function saveFloatTarget(agentId: string, raw: string | null): Promise<FeedPayAgent> {
  const saved = await setFloatTarget(agentId, raw);
  updatePayAgent(saved);
  return saved;
}

/** Sign-out, or another account in this tab. */
export function forgetPayAccess() {
  generation += 1;
  reading = null;
  readAt = 0;
  set(UNKNOWN);
}
onFeedForget(forgetPayAccess);

/** The access, read when a component that needs it mounts (a drawer, a page). */
export function usePayAccess(load = true): PayAccess {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => access,
    () => UNKNOWN,
  );
  useEffect(() => {
    if (load) void loadPayAccess();
  }, [load]);
  return value;
}
