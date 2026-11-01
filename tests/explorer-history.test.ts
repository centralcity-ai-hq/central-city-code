import assert from 'node:assert/strict';
import test from 'node:test';
import { historySeries, HISTORY_HOUR_MS as H } from '../server/base/explorer/history.js';

test('history retains real zero, gaps, latest corrections and UTC bucket boundaries', () => {
  const now = 100 * H + 1000;
  const series = historySeries(
    [
      { metric: 'agents', value: 20, observedAt: 99 * H + 50 },
      { metric: 'agents', value: 18, observedAt: 99 * H + 100 },
      { metric: 'agents', value: 0, observedAt: 100 * H },
      { metric: 'calls', value: 7, observedAt: 77 * H },
      { metric: 'calls', value: 6, observedAt: 77 * H - 1 },
    ],
    now,
  );
  assert.equal(series[0]!.observedHours, 2);
  assert.deepEqual(
    series[0]!.points.slice(-3).map((p) => p.value),
    [null, 18, 0],
  );
  assert.equal(series[3]!.points[0]!.value, 7);
  assert.equal(series[4]!.observedHours, 0);
  assert.equal(series[4]!.points.length, 24);
});

test('history excludes future and invalid values rather than manufacturing observations', () => {
  const now = 100 * H;
  const series = historySeries(
    [
      { metric: 'base', value: 3, observedAt: now + 1 },
      { metric: 'base', value: -1, observedAt: now },
      { metric: 'base', value: NaN, observedAt: now },
      { metric: 'base', value: Number.MAX_SAFE_INTEGER + 1, observedAt: now },
    ],
    now,
  );
  assert.ok(series.every((s) => s.observedHours === 0));
});

test('history storage keeps latest corrections, bounds retention and rejects stale cache replay', async (t) => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { EXPLORER_HISTORY_SQL } = await import('../server/base/explorer/history-schema.js');
  const { recordHistory, readHistory } = await import('../server/base/explorer/history-store.js');
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  await db.exec(EXPLORER_HISTORY_SQL);
  for (let hour = 100; hour < 130; hour++) {
    await recordHistory(db, { metric: 'agents', value: hour, observedAt: hour * H }, hour * H);
  }
  await recordHistory(db, { metric: 'agents', value: 1, observedAt: 129 * H + 10 }, 129 * H + 10);
  await recordHistory(db, { metric: 'agents', value: 999, observedAt: 129 * H + 5 }, 129 * H + 10);
  await recordHistory(db, { metric: 'agents', value: 999, observedAt: 100 * H }, 129 * H);
  const rows = (
    await db.query<{ value: string; hour: string }>('SELECT * FROM explorer_history ORDER BY hour')
  ).rows;
  assert.equal(rows.length, 25);
  assert.equal(Number(rows.at(-1)!.value), 1);
  assert.equal(Number(rows[0]!.hour), 105 * H);
  const start = (
    await db.query<{ collected_at: string }>('SELECT collected_at FROM explorer_history_start')
  ).rows[0]!;
  assert.equal(Number(start.collected_at), 100 * H);
  const history = await readHistory(db, 129 * H + 10);
  assert.equal(history.kind, 'observed_counter_snapshots');
  assert.equal(history.series[0]!.collectionStart, 100 * H);
  assert.equal(history.series[0]!.observedHours, 24);
  assert.equal(history.series[1]!.collectionStart, null);
  assert.equal(history.series[1]!.observedHours, 0);
});

test('observer ignores unknown/stale sources and contains storage failures', async () => {
  const { createHistoryObserver } = await import('../server/base/explorer/history-observer.js');
  let writes = 0;
  const db = {
    query: async () => ({ rows: [] }),
    exec: async () => {},
    close: async () => {},
    transaction: async () => {
      writes++;
      throw new Error('storage unavailable');
    },
  };
  const observe = createHistoryObserver(db, () => 100_000);
  observe('private_counter', 9, 100_000);
  observe('ai_agents_total', 9, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
  assert.doesNotThrow(() => observe('ai_agents_total', 9, 100_000));
  observe('ai_agents_total', 10, 100_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);
});

test('observer contains synchronous clock failures', async () => {
  const { createHistoryObserver } = await import('../server/base/explorer/history-observer.js');
  const observe = createHistoryObserver({} as import('../server/database.js').Database, () => {
    throw new Error('clock failed');
  });
  assert.doesNotThrow(() => observe('ai_agents_total', 1, 100));
});

test('paid observations use local arrival time despite a database clock ahead', async () => {
  const { createPaidCallsReader } = await import('../server/stats/paid-calls.js');
  const observed: Array<[number, number]> = [];
  const reader = createPaidCallsReader({
    db: {
      async query<T>() {
        return { rows: [{ total: 7, recent: [], value_raw: '0', now_ms: 105000 }] as T[] };
      },
    },
    clock: () => 100000,
    observe: (value, at) => {
      observed.push([value, at]);
    },
  });
  await reader.read();
  await reader.read();
  assert.deepEqual(observed, [[7, 100000]]);
});
