import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pinLabel, pinningMember, type RoomPin } from '../src/rooms/pins.js';
import type { Member, Room } from '../src/rooms/api.js';

/**
 * Smart Rooms v2 (preview) context pins in the console: who pins, chip labels, and the stylesheet
 * scoped to the preview with no orange.
 */
const room = (over: Partial<Room>) => ({ id: 'r', role: 'member', closed: false, ...over }) as Room;
const member = (over: Partial<Member>) =>
  ({
    id: 'm',
    name: 'M',
    role: 'member',
    owner_label: '',
    own: true,
    joined_at: '',
    ...over,
  }) as Member;

test('the viewer pins as its host member, else its person member or first own poster', () => {
  const members = [
    member({ id: 'host', role: 'host' }),
    member({ id: 'elric', role: 'member', auto_reply: { provider: 'elric' } }),
    member({ id: 'other', own: false }),
  ];
  assert.equal(pinningMember(room({ role: 'host' }), members)?.id, 'host');
  assert.equal(
    pinningMember(room({}), [
      member({ id: 'ai' }),
      member({ id: 'me', kind: 'person' }),
      member({ id: 'g', role: 'guest' }),
    ])?.id,
    'me',
  );
  // Read-only guests, muted members and closed rooms cannot pin.
  assert.equal(pinningMember(room({}), [member({ role: 'guest' })]), undefined);
  assert.equal(pinningMember(room({ muted: true }), [member({})]), undefined);
  assert.equal(pinningMember(room({ closed: true }), [member({})]), undefined);
});

test('a chip shows the note, else T-number and title, else the excerpt', () => {
  const base: RoomPin = {
    id: 'p',
    room_id: 'r',
    kind: 'message',
    note: '',
    pinned_by_agent_id: 'a',
    pinned_by: 'A',
    own: true,
    created_at: '',
    message: { id: 'x', seq: 3, sender: 'S', excerpt: 'Use staging' },
    task: null,
  };
  assert.equal(pinLabel(base), 'Use staging');
  assert.equal(pinLabel({ ...base, note: 'Setup' }), 'Setup');
  assert.equal(
    pinLabel({
      ...base,
      kind: 'task',
      message: null,
      task: { id: 't', number: 4, title: 'Tag it', status: 'open' },
    }),
    'T4 Tag it',
  );
});

test('rooms-v2-pins.css is scoped to the preview and has no orange', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/rooms/rooms-v2-pins.css'), 'utf8');
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of withoutComments.matchAll(/([^{}]+)\{/g)) {
    for (const selector of rule[1]!.split(',')) {
      const text = selector.trim();
      if (!text || text.startsWith('@') || /^(to|from|\d+%)$/.test(text)) continue;
      assert.match(text, /\.rm-app\[data-rooms='v2'\]/, `unscoped selector: ${text}`);
    }
  }
  for (const hex of withoutComments.matchAll(/#([0-9a-f]{6})\b/gi)) {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16));
    assert.ok(!(r! > 200 && g! > 80 && g! < 190 && b! < 90), `orange colour: #${hex[1]}`);
  }
  assert.doesNotMatch(withoutComments, /orange/i);
});
