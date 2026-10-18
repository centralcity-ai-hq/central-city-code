import assert from 'node:assert/strict';
import test from 'node:test';
import { pageVisible, shouldMarkRead } from '../src/rooms/readMark.js';

/*
 * An open room is marked read (device mark, POST /read, @mentions cleared) only while the person
 * can see the newest message: the tab is visible and the list follows the bottom (readMark.ts).
 */

test('an open room is read only when visible and at the bottom', () => {
  assert.equal(shouldMarkRead({ newest: 12, visible: true, atBottom: true }), true);
  // A mention that arrives in a background tab stays in Needs you.
  assert.equal(shouldMarkRead({ newest: 12, visible: false, atBottom: true }), false);
  // Scrolled up reading older messages: the new ones below are not read yet.
  assert.equal(shouldMarkRead({ newest: 12, visible: true, atBottom: false }), false);
  // No messages loaded yet: nothing to mark.
  assert.equal(shouldMarkRead({ newest: 0, visible: true, atBottom: true }), false);
});

test('pageVisible follows document.visibilityState', () => {
  assert.equal(pageVisible(), true); // no document under node
  let state = 'hidden';
  const scope = globalThis as { document?: unknown };
  scope.document = {
    get visibilityState() {
      return state;
    },
  };
  try {
    assert.equal(pageVisible(), false);
    state = 'visible';
    assert.equal(pageVisible(), true);
  } finally {
    delete scope.document;
  }
});
