/*
 * One poll per address, shared by every component that shows it. The header's unread count, the
 * My agents list and each agent's pane all read GET /api/messages/summary; each used to run its own
 * 10-second timer, so the same request went out three or four times at once. Now the first
 * subscriber starts one poll, later ones share its answer, a refresh from any of them asks once
 * for all, and the poll stops when the last one leaves. Same rules as a single poll: one bounded
 * read at a time (a refresh during a read asks again right after it), a timeout, and a read when
 * the page becomes visible again.
 */

export type PollState<T> = { data: T | null; error: string; loading: boolean };

export interface PollEnv {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  /** Calls `fn` whenever the page becomes visible; returns the unsubscribe. */
  onVisible(fn: () => void): () => void;
}

export interface PollOptions<T> {
  read: (path: string, signal: AbortSignal) => Promise<unknown>;
  /** The message for a failed read. */
  describe: (err: unknown, timedOut: boolean) => string;
  /** A read that means the data is gone (no access any more): it is cleared, not kept. */
  lost?: (err: unknown) => boolean;
  everyMs: number;
  timeoutMs?: number;
  env?: PollEnv;
  /** Only for the type parameter. */
  sample?: T;
}

type Entry = {
  state: PollState<unknown>;
  listeners: Set<() => void>;
  run: (queue?: boolean) => Promise<void>;
  stop: () => void;
};

const entries = new Map<string, Entry>();

export const browserEnv: PollEnv = {
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (id) => window.clearInterval(id as number),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id as number),
  onVisible: (fn) => {
    const handler = () => {
      if (document.visibilityState === 'visible') fn();
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  },
};

function start<T>(key: string, path: string, options: PollOptions<T>): Entry {
  const env = options.env ?? browserEnv;
  const entry: Entry = {
    state: { data: null, error: '', loading: true },
    listeners: new Set(),
    run: () => Promise.resolve(),
    stop: () => undefined,
  };
  let active = true;
  let flight: Promise<void> | null = null;
  let again = false;
  let controller: AbortController | null = null;
  const set = (next: Partial<PollState<unknown>>) => {
    entry.state = { ...entry.state, ...next };
    for (const listener of [...entry.listeners]) listener();
  };
  entry.run = (queue = false) => {
    if (!active) return Promise.resolve();
    if (flight) {
      if (queue) again = true;
      return flight;
    }
    if (!entry.state.loading) set({ loading: true });
    flight = (async () => {
      do {
        again = false;
        controller = new AbortController();
        const request = controller;
        let timedOut = false;
        const timer = env.setTimeout(() => {
          timedOut = true;
          request.abort();
        }, options.timeoutMs ?? 15_000);
        try {
          const value = await options.read(path, request.signal);
          if (active) set({ data: value, error: '' });
        } catch (err) {
          if (active)
            set({
              ...(options.lost?.(err) ? { data: null } : {}),
              error: options.describe(err, timedOut),
            });
        } finally {
          env.clearTimeout(timer);
        }
      } while (again && active);
    })().finally(() => {
      flight = null;
      if (active) set({ loading: false });
    });
    return flight;
  };
  const interval = env.setInterval(() => void entry.run(), options.everyMs);
  const unvisible = env.onVisible(() => void entry.run());
  entry.stop = () => {
    active = false;
    controller?.abort();
    env.clearInterval(interval);
    unvisible();
    entries.delete(key);
  };
  entries.set(key, entry);
  void entry.run();
  return entry;
}

/**
 * Joins (or starts) the shared poll of `path` under `key` (the address plus whatever else makes
 * an answer different, such as the workspace). `onChange` is called on every change.
 */
export function subscribePoll<T>(
  key: string,
  path: string,
  options: PollOptions<T>,
  onChange: () => void,
): { get: () => PollState<T>; refresh: () => Promise<void>; unsubscribe: () => void } {
  const entry = entries.get(key) ?? start(key, path, options);
  entry.listeners.add(onChange);
  return {
    get: () => entry.state as PollState<T>,
    refresh: () => entry.run(true),
    unsubscribe: () => {
      entry.listeners.delete(onChange);
      if (entry.listeners.size === 0) entry.stop();
    },
  };
}

/** For tests: how many polls are running. */
export const runningPolls = () => entries.size;
