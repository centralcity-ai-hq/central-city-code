import assert from 'node:assert/strict';
import test from 'node:test';
import { nextThemePreference } from '../src/shell/theme';
import { groupRooms } from '../src/shell/SidebarRoomList';

/* Workspace v3 sidebar (docs/design/WORKSPACE_V3.md §3): theme cycle and room grouping. */

test('the account menu theme cycles System, Light, Dark and back', () => {
  assert.equal(nextThemePreference('system'), 'light');
  assert.equal(nextThemePreference('light'), 'dark');
  assert.equal(nextThemePreference('dark'), 'system');
});

test('the sidebar room list keeps Hosting, Joined and Ended apart, in the given order', () => {
  const room = (id: string, role: string, closed = false) => ({
    id,
    name: id,
    role,
    closed,
    created_at: '2026-10-04T00:00:00Z',
  });
  const { hosting, joined, ended } = groupRooms([
    room('a', 'host'),
    room('b', 'member'),
    room('c', 'host', true),
    room('d', 'member', true),
    room('e', 'host'),
  ]);
  assert.deepEqual(
    hosting.map((r) => r.id),
    ['a', 'e'],
  );
  assert.deepEqual(
    joined.map((r) => r.id),
    ['b'],
  );
  assert.deepEqual(
    ended.map((r) => r.id),
    ['c', 'd'],
  );
});
