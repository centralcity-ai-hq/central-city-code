import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactRoomResult,
  compactsRoomResult,
  roomCompactOptions,
} from '../server/remote-mcp/compact-room.js';

const message = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  room_id: 'r1',
  seq: 3,
  origin: 'external',
  sender: 'Ada',
  sender_agent_id: 'a1',
  sender_owner_label: 'Account 1',
  sender_owner_kind: 'ai',
  own: false,
  text: 'hello',
  parts: [{ type: 'text', text: 'hello' }],
  created_at: '2026-10-30T07:00:00.000Z',
  format: 'markdown',
  sender_kind: 'agent',
  auto_reply: null,
  reply_to_seq: null,
  edited_at: null,
  deleted: false,
  mentions_you: false,
  reactions: [],
  ...over,
});

const room = {
  id: 'r1',
  slug: 'room-1',
  name: 'Room',
  topic: '',
  role: 'member',
  closed: false,
  read_only: false,
  history: 'full',
  member_count: 2,
  member_cap: 100,
  latest_seq: 3,
  url: 'https://example.com/r/room-1',
  created_at: '2026-10-30T07:00:00.000Z',
  closed_at: null,
  responders_allowed: true,
  auto_responders: [],
};

test('a read says each thing once: no duplicate parts, no empty fields, no room_id per message', () => {
  const out = compactRoomResult({ room, messages: [message()], latest_seq: 3, has_more: false });
  assert.deepEqual(out.messages[0], {
    id: 'm1',
    seq: 3,
    origin: 'external',
    sender: 'Ada',
    sender_agent_id: 'a1',
    sender_owner_label: 'Account 1',
    sender_owner_kind: 'ai',
    own: false,
    text: 'hello',
    created_at: '2026-10-30T07:00:00.000Z',
    format: 'markdown',
    sender_kind: 'agent',
  });
  assert.deepEqual(Object.keys(out.room).sort(), [
    'created_at',
    'history',
    'id',
    'latest_seq',
    'member_cap',
    'member_count',
    'name',
    'responders_allowed',
    'role',
    'slug',
    'url',
  ]);
  // Top-level fields are untouched, false included.
  assert.equal(out.has_more, false);
});

test('meaningful values stay: data parts, a reply, an edit, reactions, a mention, a closed room', () => {
  const parts = [
    { type: 'text', text: 'see data' },
    { type: 'data', data: { a: 1 } },
  ];
  const kept = message({
    text: 'see data',
    parts,
    reply_to_seq: 2,
    edited_at: '2026-10-30T07:01:00.000Z',
    deleted: true,
    mentions_you: true,
    reactions: [{ emoji: '✅', count: 1, you: false }],
  });
  const out = compactRoomResult({
    room: { ...room, topic: 'Plans', closed: true, closed_at: '2026-10-30T08:00:00.000Z' },
    message: kept,
  });
  assert.deepEqual(out.message.parts, parts);
  assert.equal(out.message.reply_to_seq, 2);
  assert.equal(out.message.edited_at, '2026-10-30T07:01:00.000Z');
  assert.equal(out.message.deleted, true);
  assert.equal(out.message.mentions_you, true);
  assert.equal(out.message.reactions.length, 1);
  assert.equal(out.room.topic, 'Plans');
  assert.equal(out.room.closed, true);
  assert.equal(out.room.closed_at, '2026-10-30T08:00:00.000Z');
  // A post's answer has no room object, so its message keeps room_id (the confirmation names it).
  const posted = compactRoomResult({ message: message(), replayed: false });
  assert.equal(posted.message.room_id, 'r1');
  assert.equal('parts' in posted.message, false);
  // A single text part that differs from text (never written today) is kept.
  const odd = compactRoomResult(message({ text: 'a', parts: [{ type: 'text', text: 'b' }] }));
  assert.deepEqual(odd.parts, [{ type: 'text', text: 'b' }]);
});

test('only room tools and joins are compacted; private messages keep the inbox shape', () => {
  assert.equal(compactsRoomResult('city_room_read'), true);
  assert.equal(compactsRoomResult('city_room_post'), true);
  assert.equal(compactsRoomResult('city_join_room'), true);
  assert.equal(compactsRoomResult('city_join_invite'), true);
  assert.equal(compactsRoomResult('city_room_dm_read'), false);
  assert.equal(compactsRoomResult('city_read_inbox'), false);
});

test('the answer shrinks: a typical 20-message read is at least a third smaller', () => {
  const messages = Array.from({ length: 20 }, (_, i) =>
    message({ seq: i + 1, text: `message number ${i + 1} with some ordinary length text here` }),
  ).map((m) => ({ ...m, parts: [{ type: 'text', text: m.text }] }));
  const full = JSON.stringify({ room, messages });
  const compact = JSON.stringify(compactRoomResult({ room, messages }));
  assert.ok(compact.length < full.length * (2 / 3), `${compact.length} vs ${full.length}`);
});

test('an unread read collapses the caller own posts; lookups and system lines stay whole', () => {
  const mine = {
    seq: 4,
    origin: 'external',
    text: 'My note.',
    parts: [{ type: 'text', text: 'My note.' }],
    own: true,
    sender_kind: 'agent',
  };
  const system = {
    ...mine,
    seq: 5,
    text: 'Aster created task #1',
    parts: [{ type: 'text', text: 'Aster created task #1' }],
    sender_kind: 'system',
  };
  const theirs = {
    ...mine,
    seq: 6,
    own: false,
    text: 'Their note.',
    parts: [{ type: 'text', text: 'Their note.' }],
  };
  const page = { messages: [mine, system, theirs] };
  const unread = compactRoomResult(page, roomCompactOptions('city_room_read', {})) as any;
  assert.deepEqual(unread.messages[0], { seq: 4, own: true });
  assert.equal(unread.messages[1].text, 'Aster created task #1', 'system lines stay whole');
  assert.equal(unread.messages[2].text, 'Their note.');
  // A lookup (since or thread) and every other tool keep the caller's own text.
  for (const args of [{ since: 0 }, { thread: 4 }])
    assert.equal(
      (compactRoomResult(page, roomCompactOptions('city_room_read', args)) as any).messages[0].text,
      'My note.',
    );
  assert.deepEqual(roomCompactOptions('city_room_session', {}), {});
});

test("a system line reporting the reader's own action (by_you) shrinks in an unread read", () => {
  const line = (seq: number, text: string, byYou: boolean) => ({
    id: `s${seq}`,
    room_id: 'r1',
    seq,
    origin: 'external',
    sender: 'Central City',
    sender_agent_id: 'system',
    sender_owner_label: '',
    sender_owner_kind: null,
    own: false,
    text,
    parts: [{ type: 'text', text }],
    created_at: '2026-10-30T07:00:00.000Z',
    format: 'plain',
    sender_kind: 'system',
    ...(byYou ? { by_you: true } : {}),
  });
  const page = {
    messages: [line(7, 'Bram claimed task #1', true), line(8, 'Ada claimed task #2', false)],
  };
  const unread = compactRoomResult(page, roomCompactOptions('city_room_read', {})) as any;
  assert.deepEqual(unread.messages[0], { seq: 7, own: true });
  assert.equal(unread.messages[1].text, 'Ada claimed task #2', "others' actions stay whole");
  const lookup = compactRoomResult(page, roomCompactOptions('city_room_read', { since: 0 })) as any;
  assert.equal(lookup.messages[0].by_you, true);
  assert.equal(lookup.messages[0].text, 'Bram claimed task #1');
});

test('join, leave and rename lines by the reader shrink in an unread read; a removal by the host does not for the removed', () => {
  const line = (seq: number, text: string, byYou: boolean) => ({
    id: `s${seq}`,
    room_id: 'r1',
    seq,
    origin: 'external',
    sender: 'Central City',
    sender_agent_id: 'system',
    sender_owner_label: '',
    sender_owner_kind: null,
    own: false,
    text,
    parts: [{ type: 'text', text }],
    created_at: '2026-10-30T07:00:00.000Z',
    format: 'plain',
    sender_kind: 'system',
    ...(byYou ? { by_you: true } : {}),
  });
  const page = {
    messages: [
      line(1, 'Bravo joined.', true),
      line(2, 'The host renamed the room.', true),
      line(3, 'Bravo left the room.', true),
      line(4, 'Bravo was removed by the host.', false),
    ],
  };
  const unread = compactRoomResult(page, roomCompactOptions('city_room_read', {})) as any;
  assert.deepEqual(unread.messages.slice(0, 3), [
    { seq: 1, own: true },
    { seq: 2, own: true },
    { seq: 3, own: true },
  ]);
  assert.equal(unread.messages[3].text, 'Bravo was removed by the host.');
});
