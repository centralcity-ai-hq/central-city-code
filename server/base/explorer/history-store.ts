import type { Database } from '../../database.js';
import {
  HISTORY_HOUR_MS,
  HISTORY_METRICS,
  historySeries,
  type HistoryMetric,
  type HistoryObservation,
} from './history.js';

/**
 * Persist a successful observation, not a stale response. Atomic per-metric retention keeps
 * at most 25 buckets; old/out-of-order observations cannot replace newer samples or revive
 * expired buckets. The collection start survives retention and resets on recovery.
 */
export async function recordHistory(db: Database, observation: HistoryObservation, now: number) {
  const { metric, value, observedAt } = observation;
  if (
    !HISTORY_METRICS.includes(metric) ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0 ||
    observedAt > now ||
    now - observedAt > HISTORY_HOUR_MS
  )
    return;
  const hour = Math.floor(observedAt / HISTORY_HOUR_MS) * HISTORY_HOUR_MS;
  await db.transaction(async (tx) => {
    await tx.query("SET LOCAL statement_timeout = '2s'");
    await tx.query("SET LOCAL lock_timeout = '250ms'");
    await tx.query(
      `INSERT INTO explorer_history_start(metric,collected_at) VALUES ($1,$2)
      ON CONFLICT (metric) DO NOTHING`,
      [metric, now],
    );
    // Serialize retention and upserts across instances for this metric.
    await tx.query('SELECT metric FROM explorer_history_start WHERE metric=$1 FOR UPDATE', [
      metric,
    ]);
    await tx.query(
      `INSERT INTO explorer_history(metric,hour,value,observed_at) VALUES ($1,$2,$3,$4)
      ON CONFLICT(metric,hour) DO UPDATE SET value=EXCLUDED.value,observed_at=EXCLUDED.observed_at
      WHERE explorer_history.observed_at < EXCLUDED.observed_at`,
      [metric, hour, value, observedAt],
    );
    await tx.query(
      `DELETE FROM explorer_history WHERE metric=$1 AND hour <
      (SELECT max(hour)-24*3600000::bigint FROM explorer_history WHERE metric=$1)`,
      [metric],
    );
  });
}

/** Bounded public read: at most five metrics × 24 hourly observations. */
export async function readHistory(db: Pick<Database, 'query'>, now: number) {
  const start = Math.floor(now / HISTORY_HOUR_MS) * HISTORY_HOUR_MS - 23 * HISTORY_HOUR_MS;
  const result = await db.query<{
    metric: HistoryMetric;
    value: string;
    observed_at: string;
    collected_at: string;
  }>(
    `SELECT h.metric,h.value,h.observed_at,s.collected_at
    FROM explorer_history h JOIN explorer_history_start s USING(metric)
    WHERE h.hour >= $1 AND h.observed_at <= $2 ORDER BY h.metric,h.hour LIMIT 120`,
    [start, now],
  );
  const starts = await db.query<{ metric: HistoryMetric; collected_at: string }>(
    'SELECT metric,collected_at FROM explorer_history_start ORDER BY metric LIMIT 5',
  );
  const series = historySeries(
    result.rows.map((row) => ({
      metric: row.metric,
      value: Number(row.value),
      observedAt: Number(row.observed_at),
    })),
    now,
  );
  return {
    kind: 'observed_counter_snapshots' as const,
    bucketMs: HISTORY_HOUR_MS,
    asOf: now,
    series: series.map((row) => {
      const first = starts.rows.find((s) => s.metric === row.metric);
      return { ...row, collectionStart: first ? Number(first.collected_at) : null };
    }),
  };
}
