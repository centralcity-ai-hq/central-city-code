import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRoomsV2, withoutRoomsV2Param } from '../src/rooms/roomsV2';
import { isWorkspaceV2, withoutWorkspaceV2Param } from '../src/shell/workspaceV2';

/* The new workspace and rooms designs are the only ones: the old opt-outs are ignored. */

function withWindow(
  location: { pathname: string; search: string; hash: string },
  stored: Record<string, string>,
  run: () => void,
) {
  const state = { retained: true };
  const history = {
    state,
    replaceState: (value: unknown, _title: string, target: string) => {
      assert.equal(value, state);
      const url = new URL(target, 'https://example.invalid');
      Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash });
    },
  };
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location,
      history,
      localStorage: { getItem: (key: string) => stored[key] ?? null },
    },
  });
  try {
    run();
  } finally {
    if (prior) Object.defineProperty(globalThis, 'window', prior);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('workspace and rooms are always v2, even with an old opt-out stored', () => {
  const location = { pathname: '/', search: '', hash: '' };
  withWindow(location, { 'cc-workspace-v2': 'v1', 'cc-rooms-v2': 'v1' }, () => {
    assert.equal(isWorkspaceV2(), true);
    assert.equal(isRoomsV2(), true);
  });
});

test('?workspace=v1 and ?rooms=v1 no longer switch back and leave the address', () => {
  const location = {
    pathname: '/rooms/test-room',
    search: '?workspace=v1&next=%2Frooms&rooms=v1',
    hash: '#claim=test-placeholder',
  };
  withWindow(location, {}, () => {
    assert.equal(isWorkspaceV2(), true);
    assert.equal(location.search, '?next=%2Frooms&rooms=v1');
    assert.equal(isRoomsV2(), true);
    assert.equal(location.search, '?next=%2Frooms');
    assert.equal(location.hash, '#claim=test-placeholder');
  });
});

test('without a window (prerender) both flags are on', () => {
  assert.equal(isWorkspaceV2(), true);
  assert.equal(isRoomsV2(), true);
});

test('the old parameters are removed and the rest of the query is kept', () => {
  assert.equal(withoutWorkspaceV2Param('?workspace=v2'), '');
  assert.equal(withoutWorkspaceV2Param('?theme=dark&workspace=v1'), '?theme=dark');
  assert.equal(withoutRoomsV2Param('?rooms=v1&a=1&b=2'), '?a=1&b=2');
});
