import assert from 'node:assert/strict';
import test from 'node:test';
import type { OnBaseTotals } from '../src/verify/onBaseData.js';
import {
  mergeTotals,
  ON_BASE_TOTALS_STORAGE_KEY,
  onBaseRetryMs,
  readStoredOnBaseTotals,
  storeOnBaseTotals,
} from '../src/verify/onBaseTotals.js';

/*
 * The On Base view's numbers as last known in this browser (src/verify/onBaseTotals.ts): a fresh
 * answer replaces them, a count it could not give keeps the last known one, they survive a reload
 * through storage (any storage failure: nothing stored), and a failed load is read again after
 * 1 s, doubling up to the page's refresh.
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

const NOW = Date.parse('2026-10-23T12:00:00.000Z');

function totals(over: Partial<OnBaseTotals> = {}): OnBaseTotals {
  return {
    onBase: 1_284,
    new24h: 37,
    finalizingNow: 1,
    ratedAgents: 412,
    readAtBlock: 52_431_170,
    readAt: NOW - 2_000,
    servedAt: NOW,
    ...over,
  };
}

test('a first answer gives every number, with the read lag and when it arrived', () => {
  assert.deepEqual(mergeTotals(null, totals(), NOW + 300), {
    onBase: 1_284,
    new24h: 37,
    finalizingNow: 1,
    ratedAgents: 412,
    read: { block: 52_431_170, lagMs: 2_000, fetchedAt: NOW + 300 },
  });
});

test('a fresh answer replaces the counts; one it could not give keeps the last known', () => {
  const known = mergeTotals(null, totals(), NOW);
  const next = mergeTotals(
    known,
    totals({ onBase: 1_290, new24h: 0, finalizingNow: 0, ratedAgents: null, readAtBlock: null }),
    NOW + 30_000,
  );
  assert.equal(next.onBase, 1_290);
  // A validated zero replaces the last number.
  assert.equal(next.new24h, 0);
  assert.equal(next.finalizingNow, 0);
  // Not counted (null), or absent from an older server: the last known.
  assert.equal(next.ratedAgents, 412);
  assert.deepEqual(next.read, known.read);
  const older = totals();
  delete older.ratedAgents;
  assert.equal(mergeTotals(known, older, NOW).ratedAgents, 412);
  // Nothing known and nothing counted: still unknown (the page keeps its skeleton).
  const none = mergeTotals(null, totals({ ratedAgents: null, readAtBlock: null, readAt: null }), 1);
  assert.equal(none.ratedAgents, null);
  assert.equal(none.read, null);
  // A block without its time is not a read the age can be told from.
  assert.equal(mergeTotals(null, totals({ readAt: null }), NOW).read, null);
});

test('the last known numbers survive a reload; unreadable data is nothing stored', (t) => {
  t.after(restore);
  const store = stubStorage();
  assert.equal(readStoredOnBaseTotals(), null);
  const known = mergeTotals(null, totals(), NOW);
  storeOnBaseTotals(known);
  assert.deepEqual(readStoredOnBaseTotals(), known);
  assert.ok(store.has(ON_BASE_TOTALS_STORAGE_KEY));
  for (const raw of ['not json', 'null', '[]', JSON.stringify({ onBase: -1, new24h: 0 })]) {
    store.set(ON_BASE_TOTALS_STORAGE_KEY, raw);
    assert.equal(readStoredOnBaseTotals(), null, raw);
  }
  // The main counts readable, the optional ones not: those are unknown, the rest stays.
  store.set(
    ON_BASE_TOTALS_STORAGE_KEY,
    JSON.stringify({
      onBase: 5,
      new24h: 1,
      finalizingNow: 0,
      ratedAgents: 'many',
      read: { block: 1 },
    }),
  );
  assert.deepEqual(readStoredOnBaseTotals(), {
    onBase: 5,
    new24h: 1,
    finalizingNow: 0,
    ratedAgents: null,
    read: null,
  });
});

test('blocked storage: nothing stored, nothing thrown', (t) => {
  t.after(restore);
  stubStorage({ throws: true });
  assert.equal(readStoredOnBaseTotals(), null);
  assert.doesNotThrow(() => storeOnBaseTotals(mergeTotals(null, totals(), NOW)));
  restore();
  assert.equal(readStoredOnBaseTotals(), null);
});

test('a failed load is read again after 1 s, doubling up to the refresh', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 50].map((attempt) => onBaseRetryMs(attempt, 30_000)),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000],
  );
});

test('the read block never goes back: a search answer keeps the known read, an older block too', () => {
  const known = mergeTotals(null, totals(), NOW);
  assert.equal(known.read?.block, 52_431_170);
  // A search page whose oldest owner read is older: the known read stays.
  const searched = mergeTotals(known, totals({ readAtBlock: 52_400_000 }), NOW + 1_000, true);
  assert.equal(searched.read?.block, 52_431_170);
  // An unsearched answer naming an older block (another instance's cache): the known read stays.
  const older = mergeTotals(known, totals({ readAtBlock: 52_431_000 }), NOW + 2_000);
  assert.equal(older.read?.block, 52_431_170);
  // A newer unsearched read moves it forward.
  const newer = mergeTotals(known, totals({ readAtBlock: 52_431_200 }), NOW + 3_000);
  assert.equal(newer.read?.block, 52_431_200);
  // A search still updates the counts it gives.
  assert.equal(mergeTotals(known, totals({ onBase: 1_300 }), NOW, true).onBase, 1_300);
});
