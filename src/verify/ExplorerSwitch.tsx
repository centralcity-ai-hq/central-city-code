import { useEffect, useState } from 'react';
import { fetchStats } from '../agentCount';
import { number } from './countLogClient';
import { loadOnBase } from './onBaseData';
import './on-base.css';

/** The Agent Explorer's three views, under its title; each has its own address to share. */
export function ExplorerSwitch({
  current,
  all,
  onBase,
  calls = null,
}: {
  current: 'all' | 'base' | 'calls';
  /** The counts beside each view, when known. */
  all: number | null;
  onBase: number | null;
  calls?: number | null;
}) {
  const count = (value: number | null) =>
    value === null ? null : <small> · {number.format(value)}</small>;
  return (
    <nav className="ob-switch" aria-label="Explorer views">
      <a href="/explorer" aria-current={current === 'all' ? 'page' : undefined}>
        All agents{count(all)}
      </a>
      <a href="/explorer/base" aria-current={current === 'base' ? 'page' : undefined}>
        On Base{count(onBase)}
      </a>
      <a href="/explorer/calls" aria-current={current === 'calls' ? 'page' : undefined}>
        Service calls{count(calls)}
      </a>
    </nav>
  );
}

// Both count hooks mount together. Share their lightweight stats request instead of
// fetching the full Base directory (including cards and ratings) just for one number.
let pendingStats: ReturnType<typeof fetchStats> | null = null;
function explorerStats() {
  if (!pendingStats) {
    pendingStats = fetchStats().finally(() => {
      pendingStats = null;
    });
  }
  return pendingStats;
}

/** How many registered agents are on Base, for the switch on the other views (null until known). */
export function useOnBaseCount() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    explorerStats()
      .catch(() => null)
      .then(async (stats) => {
        // Older deployments may omit the optional field. Never turn missing data into zero.
        const total = stats?.base?.total ?? (await loadOnBase()).totals.onBase;
        if (live) setCount(total);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return count;
}

/**
 * The public stats' counts for the switch, read once: every agent, and the paid service calls on
 * Base mainnet (the `paid_calls` field; null while the server leaves it out).
 */
export function useStatsCounts() {
  const [counts, setCounts] = useState<{ all: number | null; calls: number | null }>({
    all: null,
    calls: null,
  });
  useEffect(() => {
    let live = true;
    explorerStats()
      .then((stats) => {
        if (live && stats)
          setCounts({ all: stats.agents?.total ?? null, calls: stats.paid?.total ?? null });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return counts;
}
