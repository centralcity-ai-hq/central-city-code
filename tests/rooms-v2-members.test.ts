import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import type { Member } from '../src/rooms/api.js';
import {
  activityText,
  agoText,
  countText,
  groupMembers,
  memberBadges,
  mergePage,
  saysText,
} from '../src/rooms/membersViewV2.js';

/** Smart Rooms v2 Members panel: badge, activity and says text (src/rooms/membersViewV2.ts). */
const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const member = (extra: Partial<Member> = {}): Member => ({
  id: crypto.randomUUID(),
  name: 'Scout',
  kind: 'agent',
  role: 'member',
  owner_label: 'Account 1234abcd',
  own: false,
  joined_at: '2026-10-01T00:00:00.000Z',
  ...extra,
});
const noOwner = () => null;
const texts = (m: Member, ownerOf: (label: string) => string | null = noOwner) =>
  memberBadges(m, ownerOf).map((badge) => badge.text);

test("badges: another account's AI is heard as an AI agent, with the owner when known", () => {
  const spoken = (ownerOf: (label: string) => string | null) =>
    memberBadges(member(), ownerOf).map((badge) => badge.spoken);
  assert.deepEqual(spoken(noOwner), ['AI agent']);
  assert.deepEqual(
    spoken(() => 'Ana'),
    ['AI agent owned by Ana'],
  );
  // Badges whose text reads well aloud have no separate spoken text.
  assert.deepEqual(
    memberBadges(member({ own: true, role: 'host' }), noOwner).map((badge) => badge.spoken),
    [undefined, undefined],
  );
});

test('badges: Host, You, Guest and the AI label', () => {
  // Another account's AI: owner name when known, else "AI agent".
  assert.deepEqual(texts(member()), ['AI agent']);
  assert.deepEqual(
    texts(member(), () => 'Ana'),
    ["AI · Ana's agent"],
  );
  // Your own AI, and your own AI hosting the room.
  assert.deepEqual(texts(member({ own: true })), ['AI · your agent']);
  assert.deepEqual(texts(member({ own: true, role: 'host' })), ['Host', 'AI · your agent']);
  // People: you, another person, a person hosting.
  assert.deepEqual(texts(member({ kind: 'person', own: true })), ['You']);
  assert.deepEqual(texts(member({ kind: 'person' })), []);
  assert.deepEqual(texts(member({ kind: 'person', role: 'host', own: true })), ['Host', 'You']);
  // Guests: a read-only guest role, and an invite guest without an account.
  assert.deepEqual(texts(member({ role: 'guest' })), ['Guest', 'AI agent']);
  assert.deepEqual(
    texts(member({ guest: true }), () => 'Lab'),
    ['Guest', "AI · Lab's agent"],
  );
  // Elric: its own label, never "your agent".
  assert.deepEqual(texts(member({ own: true, auto_reply: { provider: 'elric' } })), [
    'AI assistant',
  ]);
  // A kind-less member from an older server is an AI.
  const legacy = member();
  delete legacy.kind;
  assert.deepEqual(texts(legacy), ['AI agent']);
});

test('activity: exact time where visible, else the status label; today count when sent', () => {
  assert.equal(
    activityText(
      member({ status: 'active', last_active_at: minutesAgo(3), messages_today: 12 }),
      NOW,
    ),
    'active 3 min ago · 12 today',
  );
  assert.equal(
    activityText(member({ status: 'active', last_active_at: minutesAgo(0) }), NOW),
    'active just now',
  );
  assert.equal(
    activityText(member({ status: 'offline', last_active_at: minutesAgo(5 * 60) }), NOW),
    'active 5 h ago',
  );
  // No exact time (not the host or the owner): the server's status label.
  assert.equal(
    activityText(member({ status: 'idle', last_active_at: null, messages_today: 4 }), NOW),
    'Idle · 4 today',
  );
  assert.equal(activityText(member({ status: 'active' }), NOW), 'Active');
  assert.equal(activityText(member({ status: 'offline', messages_today: null }), NOW), 'Offline');
  assert.equal(activityText(member({ status: 'idle', messages_today: 0 }), NOW), 'Idle');
  // An expired guest reads "Access expired" even with an exact time.
  assert.equal(
    activityText(member({ status: 'access_expired', last_active_at: minutesAgo(2) }), NOW),
    'Access expired',
  );
  // Older servers: nothing to show.
  assert.equal(activityText(member(), NOW), '');
  // A bad timestamp falls back to the label.
  assert.equal(activityText(member({ status: 'idle', last_active_at: 'not a date' }), NOW), 'Idle');
});

test('ago text: minutes, hours, days; the future is now', () => {
  assert.equal(agoText(minutesAgo(59), NOW), '59 min ago');
  assert.equal(agoText(minutesAgo(60), NOW), '1 h ago');
  assert.equal(agoText(minutesAgo(47 * 60), NOW), '47 h ago');
  assert.equal(agoText(minutesAgo(3 * 24 * 60), NOW), '3 d ago');
  assert.equal(agoText(minutesAgo(-10), NOW), 'just now');
});

test('says: feature-detected plain text, trimmed and bounded', () => {
  // Older or newer servers may send other shapes; the parser must cope with any value.
  const raw = (value: unknown) => value as Member['says'];
  assert.equal(saysText(member()), null);
  assert.equal(saysText(member({ says: null })), null);
  assert.equal(
    saysText(member({ says: raw({ text: 'running tests', self_reported: true }) })),
    'running tests',
  );
  assert.equal(saysText(member({ says: raw('  verifying\n fixtures ') })), 'verifying fixtures');
  assert.equal(saysText(member({ says: raw({ text: '   ' }) })), null);
  assert.equal(saysText(member({ says: raw(42) })), null);
  assert.equal(saysText(member({ says: raw({ text: 7 }) })), null);
  const long = saysText(member({ says: raw('x'.repeat(300)) }))!;
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
  // Markup stays text (React renders it as text; nothing here parses it).
  assert.equal(saysText(member({ says: raw('<b>hi</b>') })), '<b>hi</b>');
});

test('grouping, counts and page merging', () => {
  const ann = member({ kind: 'person', name: 'Ann' });
  const bot = member({ name: 'Bot' });
  const bea = member({ kind: 'person', name: 'Bea' });
  const { people, ais } = groupMembers([ann, bot, bea]);
  assert.deepEqual(
    people.map((m) => m.name),
    ['Ann', 'Bea'],
  );
  assert.deepEqual(
    ais.map((m) => m.name),
    ['Bot'],
  );
  assert.equal(countText(9), '9');
  assert.equal(countText(1204), '1,204');
  assert.equal(countText(10_000), '10k');
  assert.equal(countText(10_549), '10.5k');
  assert.equal(countText(250_000), '250k');
  assert.deepEqual(
    mergePage([ann, bot], [bot, bea]).map((m) => m.name),
    ['Ann', 'Bot', 'Bea'],
  );
});

test('stylesheet: scoped to the v2 flag, no orange', () => {
  // Rules only: comments may name the colours they avoid.
  const css = readFileSync(resolve('src/rooms/rooms-v2-members.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  for (const rule of css.match(/^[^@\s/*}][^{]*\{/gm) ?? [])
    if (!/^(to|from)\b/.test(rule.trim()))
      assert.match(rule, /\.rm-app\[data-rooms='v2'\]/, `unscoped rule: ${rule}`);
  for (const orange of ['#8a5200', '#f0b35a', '#ea580c', '#f97316', '#fb923c', 'orange', 'amber'])
    assert.ok(!css.toLowerCase().includes(orange), `orange colour ${orange}`);
});
