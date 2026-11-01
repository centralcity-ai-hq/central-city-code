import type { Database } from '../../database.js';
import type { HistoryMetric } from './history.js';
import { recordHistory } from './history-store.js';

const KEYS: Readonly<Record<string, HistoryMetric>> = {
  ai_agents_total: 'agents',
  base_explorer_totals_mainnet: 'base',
  base_explorer_totals_mainnet_finalizing: 'finalizing',
  base_rated_agents_mainnet: 'ratings',
  paid_calls_mainnet: 'calls',
};

/** Best-effort chart storage never delays or fails the authoritative counter response. */
export function createHistoryObserver(db: Database, clock: () => number = Date.now) {
  const active = new Set<HistoryMetric>();
  const last = new Map<HistoryMetric, number>();
  return (key: string, value: number, at: number): void => {
    try {
      const metric = KEYS[key];
      const now = clock();
      if (!metric || active.has(metric) || now - (last.get(metric) ?? -Infinity) < 60_000) return;
      active.add(metric);
      // Use collection time for the bucket; old source timestamps never become new observations.
      const work = (async () => {
        if (at > now || now - at > 60_000) return;
        await recordHistory(db, { metric, value, observedAt: now }, now);
        last.set(metric, now);
      })()
        .catch(() => {})
        .finally(() => active.delete(metric));
      const context = (
        globalThis as {
          [key: symbol]: { get?: () => { waitUntil?: (p: Promise<unknown>) => void } };
        }
      )[Symbol.for('@vercel/request-context')];
      context?.get?.()?.waitUntil?.(work);
    } catch {
      // Even request-context or clock failures must not escape into a counter writer.
    }
  };
}
