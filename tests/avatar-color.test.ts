import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AVATAR_PALETTE,
  AVATAR_TEXT,
  assignAvatarColors,
  avatarColor,
  avatarSlot,
  avatarStyle,
} from '../src/shell/avatarColor';
import { roomAvatarEntries } from '../src/rooms/Avatar';

/*
 * Avatar colours: one per stable id (never per name), accessible white initials, and a different
 * colour for every member of one room or list.
 */

const ELRIC_PRIMARY = '#2563eb';

function rgb(hex: string) {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
}
function linear(value: number) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string) {
  const [r, g, b] = rgb(hex).map(linear);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
/** CIELAB (daylight white point) for a CIE76 colour difference. */
function lab(hex: string) {
  const [r, g, b] = rgb(hex).map(linear);
  const x = (r! * 0.4124 + g! * 0.3576 + b! * 0.1805) / 0.95047;
  const y = r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
  const z = (r! * 0.0193 + g! * 0.1192 + b! * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
function difference(a: string, b: string) {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1! - l2!, a1! - a2!, b1! - b2!);
}

test('the avatar palette has 16 distinct colours, each with white text at 4.5:1 or more', () => {
  assert.equal(AVATAR_PALETTE.length, 16);
  assert.equal(new Set(AVATAR_PALETTE).size, 16);
  for (const colour of AVATAR_PALETTE) {
    assert.match(colour, /^#[0-9a-f]{6}$/);
    const ratio = (luminance(AVATAR_TEXT) + 0.05) / (luminance(colour) + 0.05);
    assert.ok(ratio >= 4.5, `${colour} on white text: ${ratio.toFixed(2)}`);
  }
});

test('no two palette colours are near-duplicates, and none is close to Elric blue', () => {
  for (let i = 0; i < AVATAR_PALETTE.length; i++) {
    for (let j = i + 1; j < AVATAR_PALETTE.length; j++) {
      const delta = difference(AVATAR_PALETTE[i]!, AVATAR_PALETTE[j]!);
      assert.ok(delta >= 18, `${AVATAR_PALETTE[i]} vs ${AVATAR_PALETTE[j]}: ${delta.toFixed(1)}`);
    }
    const fromElric = difference(AVATAR_PALETTE[i]!, ELRIC_PRIMARY);
    assert.ok(fromElric >= 30, `${AVATAR_PALETTE[i]} vs Elric: ${fromElric.toFixed(1)}`);
  }
});

test('neighbouring palette slots differ clearly, so a stepped member never looks alike', () => {
  for (let i = 0; i < AVATAR_PALETTE.length; i++) {
    const next = AVATAR_PALETTE[(i + 1) % AVATAR_PALETTE.length]!;
    assert.ok(difference(AVATAR_PALETTE[i]!, next) >= 35, `${AVATAR_PALETTE[i]} then ${next}`);
  }
});

test('a home colour is steady per id and comes from the palette', () => {
  assert.equal(avatarColor('agent_7f3a'), avatarColor('agent_7f3a'));
  assert.equal(avatarColor(' agent_7f3a '), avatarColor('agent_7f3a'));
  assert.equal(avatarColor('agent_7f3a'), AVATAR_PALETTE[avatarSlot('agent_7f3a')]);
  assert.ok((AVATAR_PALETTE as readonly string[]).includes(avatarColor('')));
  assert.deepEqual(avatarStyle('agent_7f3a'), {
    backgroundColor: avatarColor('agent_7f3a'),
    color: '#ffffff',
  });
  assert.deepEqual(avatarStyle('agent_7f3a', '#15803d'), {
    backgroundColor: '#15803d',
    color: '#ffffff',
  });
});

test('ids spread over the palette instead of sharing one colour', () => {
  const ids = Array.from({ length: 40 }, (_, index) => `agent_${index.toString(16)}`);
  assert.ok(new Set(ids.map(avatarColor)).size >= 12);
});

test('16 members of one room get 16 different colours', () => {
  const ids = Array.from({ length: 16 }, (_, index) => `member-${index}`);
  const colours = assignAvatarColors(ids);
  assert.equal(colours.size, 16);
  assert.equal(new Set(colours.values()).size, 16);
  // Even when every id hashes to the same home slot, the probe hands out every colour.
  const clashing = Array.from({ length: 200 }, (_, index) => `agent-${index}`).filter(
    (id) => avatarSlot(id) === avatarSlot('agent-0'),
  );
  assert.ok(clashing.length >= 3);
  assert.equal(new Set(assignAvatarColors(clashing.slice(0, 3)).values()).size, 3);
});

test('two members with the same name but different ids get different colours', () => {
  // Two agents both called "Helper": the name never picks the colour, the member id does.
  const members = [
    { id: 'agent-helper-a', name: 'Helper', joined_at: '2026-10-01T09:00:00.000Z' },
    { id: 'agent-helper-b', name: 'Helper', joined_at: '2026-10-01T09:05:00.000Z' },
  ];
  const colours = assignAvatarColors(
    members.map((member) => ({ id: member.id, joinedAt: member.joined_at })),
  );
  assert.notEqual(colours.get('agent-helper-a'), colours.get('agent-helper-b'));
  // Whatever the ids, two members in one room never share a colour.
  for (let index = 0; index < 50; index++) {
    const pair = assignAvatarColors([`a-${index}`, `b-${index}`]);
    assert.notEqual(pair.get(`a-${index}`), pair.get(`b-${index}`));
  }
});

test('someone joining never changes the colours of the members already there', () => {
  const base = Array.from({ length: 10 }, (_, index) => ({
    id: `member-${index}`,
    joinedAt: `2026-10-01T09:${String(index).padStart(2, '0')}:00.000Z`,
  }));
  const before = assignAvatarColors(base);
  for (let index = 0; index < 6; index++) {
    const newcomer = { id: `new-${index}`, joinedAt: '2026-10-02T09:00:00.000Z' };
    const after = assignAvatarColors([newcomer, ...base]);
    for (const member of base) assert.equal(after.get(member.id), before.get(member.id));
    assert.equal(new Set(after.values()).size, 11);
  }
  // The list order does not matter: join time (then id) decides who keeps the home slot.
  assert.deepEqual(
    [...assignAvatarColors([...base].reverse()).entries()].sort(),
    [...before.entries()].sort(),
  );
});

test('past 16 members colours repeat only then, and duplicate ids keep one colour', () => {
  const ids = Array.from({ length: 20 }, (_, index) => `member-${index}`);
  const colours = assignAvatarColors([...ids, 'member-3']);
  assert.equal(colours.size, 20);
  assert.equal(new Set(ids.slice(0, 16).map((id) => colours.get(id))).size, 16);
  assert.equal(colours.get('member-3'), assignAvatarColors(ids).get('member-3'));
});

test('a room colours members by join time, then senders who left, and skips Elric', () => {
  const entries = roomAvatarEntries(
    [
      { id: 'helper-b', joined_at: '2026-10-01T09:05:00.000Z' },
      { id: 'elric', joined_at: '2026-10-01T08:00:00.000Z', auto_reply: { provider: 'elric' } },
      { id: 'helper-a', joined_at: '2026-10-01T09:00:00.000Z' },
    ],
    [
      { sender_agent_id: 'helper-a' },
      { sender_agent_id: 'gone-1' },
      { sender_agent_id: 'elric', auto_reply: { provider: 'elric' } },
      { sender_agent_id: 'system', sender_kind: 'system' },
      { sender_agent_id: 'gone-1' },
    ],
  );
  assert.deepEqual(entries, [
    { id: 'helper-b', joinedAt: '2026-10-01T09:05:00.000Z' },
    { id: 'helper-a', joinedAt: '2026-10-01T09:00:00.000Z' },
    'gone-1',
  ]);
  assert.equal(new Set(assignAvatarColors(entries).values()).size, 3);
});
