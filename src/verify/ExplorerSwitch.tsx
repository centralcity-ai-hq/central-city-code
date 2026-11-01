import { useEffect, useState } from 'react';
import { subscribeStats } from '../agentCount';
import { number } from './countLogClient';
import { loadOnBase } from './onBaseData';
import { arcEnabled } from '../explorer/chain';
import './on-base.css';

/** The Agent Explorer's three views, under its title; each has its own address to share. */
export function ExplorerSwitch({
  current,
  all,
  onBase,
  calls = null,
}: {
  current: 'all' | 'base' | 'arc' | 'calls';
  /** The counts beside each view, when known. */
  all: number | null;
  onBase: number | null;
  calls?: number | null;
}) {
  const arc = useOnArc();
  const count = (value: number | null) =>
    value === null ? null : <small>{number.format(value)}</small>;
  return (
    <nav className="ob-switch" aria-label="Explorer views">
      <a href="/explorer" aria-current={current === 'all' ? 'page' : undefined}>
        <span className="ob-l-long">All agents</span><span className="ob-l-short">All</span>{count(all)}
      </a>
      <a href="/explorer/base" aria-current={current === 'base' ? 'page' : undefined}>
        <span className="ob-chain ob-chain-base" aria-hidden="true" />
        <span className="ob-l-long">On Base</span><span className="ob-l-short">Base</span>{count(onBase)}
      </a>
      {arc.on ? (
        <a href="/explorer/arc" aria-current={current === 'arc' ? 'page' : undefined}>
          <span className="ob-chain ob-chain-arc" aria-hidden="true" />
          <span className="ob-l-long">On Arc</span><span className="ob-l-short">Arc</span>{count(arc.count)}
        </a>
      ) : null}
      <a href="/explorer/calls" aria-current={current === 'calls' ? 'page' : undefined}>
        <span className="ob-l-long">Service calls</span><span className="ob-l-short">Calls</span>{count(calls)}
      </a>
    </nav>
  );
}

// The switch's counts follow the shared stats poller (agentCount.ts subscribeStats): one request
// every STATS_POLL_MS for every subscriber on the page, none while the tab is hidden, and a fresh
// read as soon as it is shown again, so a page left open keeps all three numbers current.

/**
 * How many registered agents are on Base, for the switch on the other views (null until known).
 * `enabled` false reads nothing (On Base itself has the number from its own list).
 */
export function useOnBaseCount(enabled = true) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let fallback = false;
    const stop = subscribeStats((stats) => {
      if (!live || !stats) return;
      const total = stats.base?.total;
      if (typeof total === 'number') {
        setCount(total);
        return;
      }
      // Older deployments may omit the optional field: the directory's own total, read once.
      // Never turn missing data into zero.
      if (fallback) return;
      fallback = true;
      loadOnBase()
        .then((data) => {
          if (live) setCount((known) => known ?? data.totals.onBase);
        })
        .catch(() => undefined);
    });
    return () => {
      live = false;
      stop();
    };
  }, [enabled]);
  return count;
}

/**
 * The public stats' counts for the switch, kept current: every agent, and the paid service calls
 * on Base mainnet (the `paid_calls` field; null while the server leaves it out). A number the
 * server leaves out keeps its last known value.
 */
export function useStatsCounts() {
  const [counts, setCounts] = useState<{ all: number | null; calls: number | null }>({
    all: null,
    calls: null,
  });
  useEffect(() => {
    let live = true;
    const stop = subscribeStats((stats) => {
      if (!live || !stats) return;
      setCounts((known) => ({
        all: stats.agents?.total ?? known.all,
        calls: stats.paid?.total ?? known.calls,
      }));
    });
    return () => {
      live = false;
      stop();
    };
  }, []);
  return counts;
}

/**
 * The On Arc tab: shown only while the server has Arc on (the same probe as the Arc pages), with
 * the stats' `arc_agents` total beside it when the server sends it.
 */
export function useOnArc() {
  const [arc, setArc] = useState<{ on: boolean; count: number | null }>({ on: false, count: null });
  useEffect(() => {
    let live = true;
    arcEnabled()
      .then((on) => {
        if (live && on) setArc((known) => ({ ...known, on: true }));
      })
      .catch(() => undefined);
    const stop = subscribeStats((stats) => {
      if (!live || !stats) return;
      const total = stats.arc?.total;
      if (typeof total === 'number') setArc((known) => ({ ...known, count: total }));
    });
    return () => {
      live = false;
      stop();
    };
  }, []);
  return arc;
}
