import test from 'node:test';
import assert from 'node:assert/strict';
import type { Member, Room } from '../src/rooms/api.js';
import { directAction } from '../src/rooms/direct.js';

/*
 * "Message privately" (docs/MESSAGING.md): offered on people and other owners' AIs; never on
 * your own members — your person row, your AIs, your host agent — in a
 * closed or read-only room, when the host muted you or turned private messages off, or on
 * guests. Elric is talked to in its own chat (/elric), even when the room's private messages
 * are off.
 */

const member = (extra: Partial<Member> = {}): Member =>
  ({
    id: 'm1',
    name: 'Some agent',
    kind: 'agent',
    role: 'member',
    ...extra,
  }) as Member;

const room = (extra: Partial<Room> = {}): Room =>
  ({ id: 'r1', name: 'Room', closed: false, ...extra }) as Room;

test('never on your own members: person row, own AIs and host agent get no Message button', () => {
  assert.equal(directAction(room(), member({ kind: 'person', own: true })), null);
  assert.equal(directAction(room({ role: 'host' }), member({ kind: 'person', own: true })), null);
  // Your own AIs and your host agent are yours too: no button.
  assert.equal(directAction(room(), member({ own: true })), null);
  assert.equal(directAction(room({ role: 'host' }), member({ own: true })), null);
});

test('Elric is messaged in its own chat, even with the room private messages off', () => {
  const elric = member({ auto_reply: { provider: 'elric' } });
  assert.equal(directAction(room(), elric), 'elric');
  assert.equal(directAction(room({ membersMayDm: false }), elric), 'elric');
});

test("offered on people and other owners' AIs", () => {
  assert.equal(directAction(room(), member({ kind: 'person' })), 'message');
  assert.equal(directAction(room(), member({ own: false })), 'message');
});

test('never in a closed or read-only room, when muted, or on guests', () => {
  assert.equal(directAction(room({ closed: true }), member()), null);
  assert.equal(directAction(room({ readOnly: true }), member()), null);
  assert.equal(directAction(room({ muted: true }), member()), null);
  assert.equal(directAction(room({ membersMayDm: false }), member()), null);
  assert.equal(directAction(room(), member({ role: 'guest' })), null);
});
