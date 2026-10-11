import { test } from 'node:test';
import assert from 'node:assert/strict';

// A per-test localStorage (the module reads window.localStorage).
const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
};

const { readRoomActivity, recordRoomActivity, roomActivityAt, sortRoomsByActivity } =
  await import('../src/shell/roomActivity.js');

const room = (id: string, created: string, closed = false) => ({
  id,
  closed,
  created_at: `2026-10-0${created}T10:00:00Z`,
});

test('rooms sort open first, then latest activity, then newest; the same order everywhere', () => {
  const rooms = [room('old', '1'), room('new', '3'), room('ended', '4', true), room('mid', '2')];
  const activity: Record<string, number> = { old: Date.parse('2026-10-05T09:00:00Z') };
  const order = sortRoomsByActivity(rooms, (item) => roomActivityAt(item, activity[item.id]));
  assert.deepEqual(
    order.map((item) => item.id),
    ['old', 'new', 'mid', 'ended'],
  );
  // Without activity: the newest room first.
  assert.deepEqual(
    sortRoomsByActivity(rooms, (item) => roomActivityAt(item)).map((item) => item.id),
    ['new', 'mid', 'old', 'ended'],
  );
});

test('recorded activity only moves forward and survives a re-read', () => {
  store.clear();
  const first = recordRoomActivity('ws', { a: 2000, b: 1000 });
  assert.deepEqual(first, { a: 2000, b: 1000 });
  // An older time and an invalid one change nothing (the same object comes back).
  assert.equal(recordRoomActivity('ws', { a: 1500, c: -1 }, first), first);
  const next = recordRoomActivity('ws', { b: 3000 }, first);
  assert.deepEqual(next, { a: 2000, b: 3000 });
  assert.deepEqual(readRoomActivity('ws'), { b: 3000, a: 2000 });
  // Another workspace keeps its own record; junk in storage reads as nothing.
  assert.deepEqual(readRoomActivity('other'), {});
  store.set('cc.rooms.activity.bad', '[1,2]');
  assert.deepEqual(readRoomActivity('bad'), {});
});
