/** Public Explorer counters only. No private checkpoint subcounts or identifiers. */
export const HISTORY_METRICS = ['agents', 'base', 'finalizing', 'calls', 'ratings'] as const;
export type HistoryMetric = (typeof HISTORY_METRICS)[number];
export const HISTORY_HOUR_MS = 3_600_000;

export interface HistoryObservation {
  metric: HistoryMetric;
  value: number;
  observedAt: number;
}

/**
 * Last actual observation per UTC hour. Missing hours stay null, including hours before
 * collection began. A lower later value is retained: corrections are not forced monotonic.
 * Collection/read code must provide successful source observations, never stale cache reads.
 */
export function historySeries(observations: readonly HistoryObservation[], now: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid history clock');
  const end = Math.floor(now / HISTORY_HOUR_MS) * HISTORY_HOUR_MS;
  const start = end - 23 * HISTORY_HOUR_MS;
  return HISTORY_METRICS.map((metric) => {
    const points: Array<{ hour: number; value: number | null; observedAt: number | null }> =
      Array.from({ length: 24 }, (_, index) => ({
        hour: start + index * HISTORY_HOUR_MS,
        value: null,
        observedAt: null,
      }));
    for (const row of observations) {
      if (
        row.metric !== metric ||
        !Number.isSafeInteger(row.value) ||
        row.value < 0 ||
        !Number.isSafeInteger(row.observedAt) ||
        row.observedAt < start ||
        row.observedAt > now
      )
        continue;
      const index = Math.floor((row.observedAt - start) / HISTORY_HOUR_MS);
      const point = points[index]!;
      if (point.observedAt === null || row.observedAt > point.observedAt) {
        point.value = row.value;
        point.observedAt = row.observedAt;
      }
    }
    return { metric, points, observedHours: points.filter((point) => point.value !== null).length };
  });
}
