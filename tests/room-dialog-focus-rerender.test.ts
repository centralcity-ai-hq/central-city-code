import test from 'node:test';
import assert from 'node:assert/strict';
import { TestRoot } from './helpers/hook-render.js';
import type { Room, RoomsClient } from '../src/rooms/api.js';

const { InviteSheet } = await import('../src/rooms/InviteSheet.js');
const { ElricDobDialog } = await import('../src/rooms/elric/ElricDobDialog.js');

/*
 * The room re-renders while a sheet is open (polls, a saved setting) and passes a new inline
 * onClose each time. That must not move focus: it stays on the control the person is on inside
 * the dialog, and Escape still closes with the newest onClose.
 */

type Listener = (event: { key: string; shiftKey?: boolean; preventDefault(): void }) => void;

function fakePage() {
  const listeners = new Map<string, Set<Listener>>();
  const page = {
    activeElement: null as unknown,
    focused: [] as string[],
    on(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    off(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    key(key: string) {
      for (const listener of listeners.get('keydown') ?? []) listener({ key, preventDefault() {} });
    },
    node(name: string) {
      const node = {
        name,
        isConnected: true,
        focus() {
          page.activeElement = node;
          page.focused.push(name);
        },
        contains: (other: unknown) => other === node,
        querySelectorAll: () => [],
        querySelector: () => null,
      };
      return node;
    },
  };
  const scope = globalThis as Record<string, unknown>;
  const saved = { document: scope.document, window: scope.window };
  scope.document = {
    get activeElement() {
      return page.activeElement;
    },
    addEventListener: page.on,
    removeEventListener: page.off,
  };
  scope.window = {
    addEventListener: page.on,
    removeEventListener: page.off,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  return {
    page,
    restore() {
      scope.document = saved.document;
      scope.window = saved.window;
    },
  };
}

const room = {
  id: 'room_1',
  history: 'full',
  member_count: 2,
  member_cap: 10,
  memberCapMax: 100,
  role: 'host',
} as unknown as Room;
const client = { joinLink: () => new Promise(() => undefined) } as unknown as RoomsClient;

test('Invite sheet: a room re-render with a new onClose keeps focus inside the sheet', () => {
  const { page, restore } = fakePage();
  try {
    const opener = page.node('opener');
    opener.focus();
    let closedBy = '';
    const sheet = new TestRoot(
      InviteSheet,
      { client, room, onClose: () => (closedBy = 'first') },
      (type) => page.node(type),
    );
    assert.notEqual(page.activeElement, opener, 'the sheet takes focus when it opens');
    const control = page.node('copy button');
    control.focus();
    page.focused.length = 0;

    sheet.render({ client, room, onClose: () => (closedBy = 'second') });
    assert.equal(page.activeElement, control, 'focus stays on the control the person is on');
    assert.deepEqual(page.focused, [], 'nothing is focused by a re-render');

    page.key('Escape');
    assert.equal(closedBy, 'second', 'Escape closes with the newest onClose');
    sheet.unmount();
    assert.equal(page.activeElement, opener, 'closing returns focus to the opener');
  } finally {
    restore();
  }
});

test('Date of birth dialog: a room re-render with a new onClose keeps focus in the form', () => {
  const { page, restore } = fakePage();
  try {
    const opener = page.node('opener');
    opener.focus();
    let closedBy = '';
    const props = { onSubmit: () => undefined, busy: false, error: null };
    const dialog = new TestRoot(
      ElricDobDialog,
      { ...props, onClose: () => (closedBy = 'first') },
      (type) => page.node(type),
    );
    const field = page.node('date field');
    field.focus();
    page.focused.length = 0;

    dialog.render({ ...props, busy: true, onClose: () => (closedBy = 'second') });
    assert.equal(page.activeElement, field, 'focus stays in the open form');
    assert.deepEqual(page.focused, [], 'nothing is focused by a re-render');

    page.key('Escape');
    assert.equal(closedBy, 'second', 'Escape closes with the newest onClose');
    dialog.unmount();
    assert.equal(page.activeElement, opener, 'closing returns focus to the opener');
  } finally {
    restore();
  }
});
