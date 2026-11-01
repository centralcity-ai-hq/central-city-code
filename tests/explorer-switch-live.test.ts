import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { subscribeStats, type StatsResponse } from '../src/agentCount.js';

/*
 * The Agent Explorer's switch counts (All agents, On Base, Service calls) stay current on a page
 * left open: both hooks follow the shared stats poller (subscribeStats) instead of reading
 * /api/public/stats once at mount, and the On Base page takes its two sibling counts from that hook
 * instead of its own one-off read. The tests have no DOM, so the hooks' wiring is pinned in the
 * source and the poller itself is shown delivering every new answer to a subscriber.
 */

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the switch hooks follow the shared poller; the On Base page has no one-off stats read', () => {
  const sw = source('src/verify/ExplorerSwitch.tsx');
  for (const hook of ['useOnBaseCount', 'useStatsCounts']) {
    const body = sw.slice(sw.indexOf(`export function ${hook}`));
    const end = body.indexOf('\nexport function', 1);
    const fn = end > 0 ? body.slice(0, end) : body;
    assert.match(fn, /subscribeStats\(/, `${hook} subscribes to the shared poller`);
    assert.match(fn, /stop\(\)/, `${hook} unsubscribes on unmount`);
    assert.doesNotMatch(fn, /fetchStats\(/, `${hook} never reads just once`);
  }
  const onBase = source('src/verify/OnBase.tsx');
  assert.match(onBase, /useStatsCounts\(\)/);
  assert.doesNotMatch(onBase, /['"]\/api\/public\/stats['"]/, 'no direct one-off stats read');
});

test('a subscriber gets every new answer, so the switch numbers move without a reload', async (t) => {
  const AT = '2026-10-24T14:00:00.000Z';
  const answers = [
    { ai_agents_total: 3_001_114, updated_at: AT, base_agents: { total: 1_012_261, as_of: AT } },
    { ai_agents_total: 3_002_500, updated_at: AT, base_agents: { total: 1_012_910, as_of: AT } },
  ].map((body, i) => ({
    ...body,
    paid_calls: {
      total: 616_557 + i * 14_000,
      as_of: AT,
      recent_ms: [],
      recent_complete: true,
      value_settled_raw: '1',
    },
  }));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const body = answers[Math.min(calls, answers.length - 1)];
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
  assert.equal(seen.at(-1)?.agents?.total, 3_001_114);
  assert.equal(seen.at(-1)?.paid?.total, 616_557);
  t.mock.timers.tick(15_000);
  await flush();
  // The next poll: All agents and Service calls moved, as the switch now shows them.
  assert.equal(seen.at(-1)?.agents?.total, 3_002_500);
  assert.equal(seen.at(-1)?.paid?.total, 630_557);
  assert.equal(seen.at(-1)?.base?.total, 1_012_910);
});
