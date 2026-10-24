import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextStatsDelay,
  STATS_PARTIAL_RETRIES,
  STATS_PARTIAL_RETRY_MS,
  STATS_POLL_MS,
  statsIncomplete,
  subscribeStats,
  type StatsResponse,
} from '../src/agentCount.js';

/*
 * The shared stats poller (src/agentCount.ts) reads again sooner when an answer leaves out one of
 * the homepage's numbers (paid_calls, its value_settled_raw, base_agents): after 2 s, then 4 s,
 * then at the normal 15 s poll, and a full answer resets that. Each listener still gets every
 * answer, so a missing field never blanks a known number (LiveNumbers keeps it). The browser
 * globals and the timers are stubbed per test.
 */

const AT = '2026-10-23T12:00:00.000Z';
const FULL = {
  ai_agents_total: 512_846,
  updated_at: AT,
  base_agents: { total: 31_452, as_of: AT },
  paid_calls: {
    total: 1_284,
    as_of: AT,
    recent_ms: [],
    recent_complete: true,
    value_settled_raw: '1284093500000',
  },
};
const NO_PAID = { ai_agents_total: 512_846, updated_at: AT, base_agents: FULL.base_agents };

test('an answer is incomplete when it leaves out any homepage number', () => {
  const paid = { total: 1, asOf: 1, recentMs: [], recentComplete: true, valueRaw: '1' };
  const base = { total: 1, asOf: 1 };
  assert.equal(statsIncomplete({ paid, base }), false);
  assert.equal(statsIncomplete({ paid: null, base }), true);
  assert.equal(statsIncomplete({ paid, base: null }), true);
  assert.equal(statsIncomplete({ paid: { ...paid, valueRaw: null }, base }), true);
});

test('incomplete answers in a row: 2 s, then 4 s, then the normal poll', () => {
  assert.equal(STATS_PARTIAL_RETRY_MS, 2_000);
  assert.equal(STATS_PARTIAL_RETRIES, 2);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 20].map((partial) => nextStatsDelay(partial, STATS_POLL_MS)),
    [15_000, 2_000, 4_000, 15_000, 15_000, 15_000],
  );
  // Never longer than the poll itself.
  assert.equal(nextStatsDelay(2, 3_000), 3_000);
});

test('the poller reads again 2 s after an answer without paid_calls, and keeps polling', async (t) => {
  const bodies = [NO_PAID, NO_PAID, NO_PAID, FULL, NO_PAID];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const body = bodies[Math.min(calls, bodies.length - 1)];
    calls++;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  (globalThis as { document?: unknown }).document = {
    hidden: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const seen: (StatsResponse | null)[] = [];
  const stop = subscribeStats((stats) => seen.push(stats));
  t.after(() => {
    stop();
    delete (globalThis as { document?: unknown }).document;
  });
  await flush();
  assert.equal(calls, 1);
  assert.equal(seen.at(-1)?.paid, null);
  // Incomplete: 2 s later, then 4 s later.
  t.mock.timers.tick(1_999);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);
  t.mock.timers.tick(4_000);
  await flush();
  assert.equal(calls, 3);
  // A third incomplete answer in a row: back to the normal poll.
  t.mock.timers.tick(14_999);
  await flush();
  assert.equal(calls, 3);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 4);
  assert.equal(seen.at(-1)?.paid?.total, 1_284);
  // The full answer reset the count: the next incomplete one is read again after 2 s once more.
  t.mock.timers.tick(15_000);
  await flush();
  assert.equal(calls, 5);
  t.mock.timers.tick(2_000);
  await flush();
  assert.equal(calls, 6);
  // Every answer reached the listener; none was a failure.
  assert.equal(seen.length, 6);
  assert.ok(seen.every((stats) => stats !== null));
});
