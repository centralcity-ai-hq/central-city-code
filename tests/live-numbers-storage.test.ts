import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_COUNT_STORAGE_KEY,
  captureBuildAgentCount,
  LIVE_NUMBERS_STORAGE_KEY,
  markPrerenderedAgentCountShown,
  prerenderedAgentCount,
  prerenderedBaseAgents,
  readStoredAgentCount,
  readStoredLiveNumbers,
  setBuildAgentCount,
  setBuildBaseAgents,
  storeAgentCount,
  storeLiveNumbers,
  type PaidCalls,
} from '../src/agentCount.js';

/*
 * The homepage's live numbers as this browser last saw them (src/agentCount.ts): the agent count
 * under its old key, the value settled, paid service calls and Base agents under their own. A
 * field one answer left out keeps its stored value, an older answer never replaces a newer stored
 * one, and any storage failure simply means nothing stored. Also the build's Base agents number,
 * read from the prerendered cell before the app mounts. The browser globals are stubbed per test
 * and removed after.
 */

function stubStorage(options: { throws?: boolean } = {}) {
  const store = new Map<string, string>();
  const fail = () => {
    throw new Error('blocked');
  };
  (globalThis as { window?: unknown }).window = {
    localStorage: options.throws
      ? { getItem: fail, setItem: fail }
      : {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => void store.set(key, value),
        },
  };
  return store;
}

function restore() {
  delete (globalThis as { window?: unknown }).window;
}

const T1 = Date.parse('2026-10-23T12:00:00.000Z');
const T2 = T1 + 15_000;

function paid(total: number, asOf: number, valueRaw: string | null = null): PaidCalls {
  return { total, asOf, recentMs: [], recentComplete: true, valueRaw };
}

test('nothing stored: every number is null', (t) => {
  t.after(restore);
  stubStorage();
  assert.deepEqual(readStoredLiveNumbers(), { paid: null, base: null, value: null });
});

test('an answer is stored with its times and read back', (t) => {
  t.after(restore);
  const store = stubStorage();
  storeLiveNumbers({ paid: paid(1_284, T1, '1284093500000'), base: { total: 31_452, asOf: T1 } });
  assert.deepEqual(readStoredLiveNumbers(), {
    paid: { total: 1_284, at: T1 },
    base: { total: 31_452, at: T1 },
    value: { raw: '1284093500000', at: T1 },
  });
  assert.ok(store.has(LIVE_NUMBERS_STORAGE_KEY));
  // The agent count keeps its own, older key.
  assert.equal(store.has(AGENT_COUNT_STORAGE_KEY), false);
});

test('a field an answer leaves out keeps the stored one', (t) => {
  t.after(restore);
  stubStorage();
  storeLiveNumbers({ paid: paid(1_284, T1, '1284093500000'), base: { total: 31_452, asOf: T1 } });
  // No paid_calls (so no value either), only the Base agents.
  storeLiveNumbers({ paid: null, base: { total: 31_460, asOf: T2 } });
  assert.deepEqual(readStoredLiveNumbers(), {
    paid: { total: 1_284, at: T1 },
    base: { total: 31_460, at: T2 },
    value: { raw: '1284093500000', at: T1 },
  });
  // Paid calls without their value: the value stays.
  storeLiveNumbers({ paid: paid(1_290, T2), base: null });
  assert.deepEqual(readStoredLiveNumbers().value, { raw: '1284093500000', at: T1 });
  assert.deepEqual(readStoredLiveNumbers().paid, { total: 1_290, at: T2 });
  // An answer with none of them stores nothing new.
  storeLiveNumbers({ paid: null, base: null });
  assert.deepEqual(readStoredLiveNumbers().base, { total: 31_460, at: T2 });
});

test('an older answer never replaces a newer stored number; a validated zero is kept', (t) => {
  t.after(restore);
  stubStorage();
  storeLiveNumbers({ paid: paid(1_290, T2, '1290000000000'), base: { total: 31_460, asOf: T2 } });
  storeLiveNumbers({ paid: paid(1_284, T1, '1284000000000'), base: { total: 31_452, asOf: T1 } });
  assert.deepEqual(readStoredLiveNumbers(), {
    paid: { total: 1_290, at: T2 },
    base: { total: 31_460, at: T2 },
    value: { raw: '1290000000000', at: T2 },
  });
  // A correction to zero is a real answer: it replaces the higher number.
  storeLiveNumbers({ paid: paid(0, T2 + 1, '0'), base: { total: 0, asOf: T2 + 1 } });
  assert.deepEqual(readStoredLiveNumbers(), {
    paid: { total: 0, at: T2 + 1 },
    base: { total: 0, at: T2 + 1 },
    value: { raw: '0', at: T2 + 1 },
  });
});

test('unreadable stored data counts as nothing stored, field by field', (t) => {
  t.after(restore);
  const store = stubStorage();
  for (const raw of ['not json', 'null', '42', '"text"', '[]']) {
    store.set(LIVE_NUMBERS_STORAGE_KEY, raw);
    assert.deepEqual(readStoredLiveNumbers(), { paid: null, base: null, value: null }, raw);
  }
  store.set(
    LIVE_NUMBERS_STORAGE_KEY,
    JSON.stringify({
      paid: { total: -1, at: T1 },
      base: { total: 31_452, at: 'yesterday' },
      value: { raw: '12.5', at: T1 },
    }),
  );
  assert.deepEqual(readStoredLiveNumbers(), { paid: null, base: null, value: null });
  store.set(
    LIVE_NUMBERS_STORAGE_KEY,
    JSON.stringify({ paid: { total: 7, at: T1 }, base: 'x', value: { raw: '0123', at: T1 } }),
  );
  assert.deepEqual(readStoredLiveNumbers(), {
    paid: { total: 7, at: T1 },
    base: null,
    value: null,
  });
});

test('blocked storage: nothing stored, nothing thrown', (t) => {
  t.after(restore);
  stubStorage({ throws: true });
  assert.deepEqual(readStoredLiveNumbers(), { paid: null, base: null, value: null });
  assert.doesNotThrow(() =>
    storeLiveNumbers({ paid: paid(1, T1, '1'), base: { total: 1, asOf: T1 } }),
  );
  assert.equal(readStoredAgentCount(), null);
  assert.doesNotThrow(() => storeAgentCount({ total: 5, at: T1 }));
  // No window at all (the prerender).
  restore();
  assert.deepEqual(readStoredLiveNumbers(), { paid: null, base: null, value: null });
});

test('the old agent count key stays readable as before', (t) => {
  t.after(restore);
  const store = stubStorage();
  store.set(AGENT_COUNT_STORAGE_KEY, JSON.stringify({ total: 29_000, at: T1 }));
  assert.deepEqual(readStoredAgentCount(), { total: 29_000, at: T1 });
  storeLiveNumbers({ paid: paid(3, T2), base: null });
  assert.deepEqual(readStoredAgentCount(), { total: 29_000, at: T1 });
});

/** A root whose querySelector answers the two prerendered cells from their attributes. */
function root(cells: { agents?: Record<string, string>; base?: Record<string, string> }) {
  const node = (attributes?: Record<string, string>) =>
    attributes ? { getAttribute: (name: string) => attributes[name] ?? null } : null;
  return {
    querySelector: (selector: string) =>
      selector.includes('data-agent-ticker')
        ? node(cells.agents)
        : selector.includes('data-stat="base"')
          ? node(cells.base)
          : null,
  } as unknown as ParentNode;
}

test("the build's Base agents number is read from its cell before the app mounts, once", () => {
  const at = '2026-10-05T12:00:00.000Z';
  try {
    captureBuildAgentCount(
      root({
        agents: { 'data-build-count': '114251', 'data-build-at': at },
        base: { 'data-build-base': '31452', 'data-build-base-at': at },
      }),
    );
    assert.deepEqual(prerenderedAgentCount(), { total: 114_251, at: Date.parse(at) });
    assert.deepEqual(prerenderedBaseAgents(), { total: 31_452, asOf: Date.parse(at) });
    // Once the first view has mounted over the prerendered markup, neither starts a later one.
    markPrerenderedAgentCountShown();
    assert.equal(prerenderedBaseAgents(), null);
    assert.equal(prerenderedAgentCount(), null);
    // A page without the cell, or with an unreadable one, has none.
    captureBuildAgentCount(root({ agents: { 'data-build-count': '7', 'data-build-at': at } }));
    assert.equal(prerenderedBaseAgents(), null);
    captureBuildAgentCount(root({ base: { 'data-build-base': 'many', 'data-build-base-at': at } }));
    assert.equal(prerenderedBaseAgents(), null);
    // Never a 0 from the build.
    setBuildAgentCount(null);
    setBuildBaseAgents({ total: 0, asOf: Date.parse(at) });
    assert.equal(prerenderedBaseAgents(), null);
  } finally {
    setBuildAgentCount(null);
    setBuildBaseAgents(null);
  }
});
