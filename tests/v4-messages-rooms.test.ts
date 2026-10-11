import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentMessage, ConversationSummary, DirectThread } from '../server/messaging/contract';
import {
  addableRooms,
  agentConversations,
  agentRooms,
  agentUnread,
  canAddToRoom,
  directView,
  membersLabel,
  mergeMessages,
  messageText,
  newMessageRoom,
  roomStatus,
  shortAgo,
  threadView,
  type MemberLite,
  type RoomLite,
} from '../src/agents/v4/messagesRoomsModel';

/* My agents v4: the pure rules behind the agent pane's Messages and Rooms screens. */

const AGENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PERSON = '33333333-3333-4333-8333-333333333333';
const STRANGER = '44444444-4444-4444-8444-444444444444';

function message(over: Partial<AgentMessage> = {}): AgentMessage {
  return {
    origin: 'internal',
    from_owner_label: null,
    id: over.id ?? 'm1',
    seq: 1,
    kind: 'message',
    from_agent_id: OTHER,
    from_agent_name: 'Courier',
    to_agent_id: AGENT,
    to_agent_name: 'Winry',
    context_id: 'ctx',
    reply_to: null,
    parts: [{ type: 'text', text: 'Sources extracted, 12 links.' }],
    created_at: '2026-10-10T07:10:00.000Z',
    ...over,
  };
}
function conversation(over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    context_id: 'ctx',
    message_count: 1,
    participants: [AGENT, OTHER],
    last_message: message(),
    unread: 0,
    unread_capped: false,
    ...over,
  };
}
const direct = (self: string, peer: string, selfKind: 'agent' | 'person'): DirectThread => ({
  context_id: 'dm',
  room_id: 'room-1',
  room_name: 'Q4 review',
  self: {
    id: self,
    name: selfKind === 'person' ? 'Lustig' : 'Winry',
    kind: selfKind,
    owner_label: null,
    is_self: true,
    own: true,
  },
  peer: {
    id: peer,
    name: peer === AGENT ? 'Winry' : 'Mira',
    kind: peer === AGENT ? 'agent' : 'person',
    owner_label: 'Account 1a2b3c4d',
    is_self: false,
    own: peer === AGENT,
  },
});

test('agentConversations keeps only threads the agent is in, newest first', () => {
  const rows = agentConversations(
    [
      conversation({
        context_id: 'old',
        last_message: message({ created_at: '2026-10-10T07:00:00.000Z' }),
      }),
      conversation({ context_id: 'not-mine', participants: [OTHER, STRANGER] }),
      conversation({
        context_id: 'new',
        unread: 2,
        last_message: message({ created_at: '2026-10-10T08:04:00.000Z' }),
      }),
    ],
    AGENT,
  );
  assert.deepEqual(
    rows.map((row) => row.contextId),
    ['new', 'old'],
  );
  assert.equal(rows[0]!.unread, 2);
  assert.equal(rows[0]!.with.name, 'Courier');
  assert.equal(rows[0]!.last, 'Sources extracted, 12 links.');
});

test('a private thread where the agent writes: with the peer, sent from the agent', () => {
  const view = directView(direct(AGENT, PERSON, 'agent'), AGENT);
  assert.equal(view.with.name, 'Mira');
  assert.equal(view.with.kind, 'person');
  assert.equal(view.mine, AGENT);
  assert.deepEqual(
    view.send.mode === 'direct' && [view.send.room, view.send.from, view.send.to.id],
    ['room-1', AGENT, PERSON],
  );
});

test('a private thread between the person and the agent: with You, the person writes to it', () => {
  const view = directView(direct(PERSON, AGENT, 'person'), AGENT);
  assert.equal(view.with.name, 'You');
  assert.equal(view.mine, PERSON);
  assert.equal(view.send.from, PERSON);
  assert.equal(view.send.to.id, AGENT);
  assert.equal(view.send.to.name, 'Winry');
});

test('a connection thread replies as the agent', () => {
  const view = threadView(conversation(), AGENT)!;
  assert.equal(view.send.mode, 'agent');
  assert.equal(view.send.from, AGENT);
  assert.equal(view.send.to.id, OTHER);
  assert.equal(threadView(conversation({ participants: [OTHER, STRANGER] }), AGENT), null);
});

test('messageText joins text parts and names data-only messages', () => {
  assert.equal(messageText(message()), 'Sources extracted, 12 links.');
  assert.equal(messageText({ parts: [{ type: 'data', data: { a: 1 } }] }), 'Shared data');
});

test('mergeMessages orders oldest first and collapses duplicates', () => {
  const a = message({ id: 'a', created_at: '2026-10-10T08:00:00.000Z' });
  const b = message({ id: 'b', created_at: '2026-10-10T08:01:00.000Z' });
  assert.deepEqual(
    mergeMessages([b], [a, b]).map((item) => item.id),
    ['a', 'b'],
  );
});

test('agentUnread reads the agent inbox from the summary', () => {
  const inboxes = [{ agent_id: AGENT, unread: 3, latest_seq: 9, acked_seq: 6 }];
  assert.equal(agentUnread(inboxes, AGENT), 3);
  assert.equal(agentUnread(inboxes, OTHER), 0);
});

test('newMessageRoom: only a shared room that lists the agent as a recipient', () => {
  const recipient = {
    room_id: 'room-1',
    room_name: 'Q4 review',
    member_id: AGENT,
    name: 'Winry',
    kind: 'agent' as const,
    owner_label: null,
    own: true,
  };
  assert.equal(newMessageRoom([recipient], AGENT), 'room-1');
  assert.equal(newMessageRoom([{ ...recipient, member_id: OTHER }], AGENT), null);
  assert.equal(newMessageRoom([], AGENT), null);
});

test('shortAgo uses the mockup words', () => {
  const now = new Date(2026, 9, 10, 12, 0).getTime();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  assert.equal(shortAgo(at(0), now), 'now');
  assert.equal(shortAgo(at(4), now), '4 min');
  assert.equal(shortAgo(at(60), now), '1 h');
  assert.equal(shortAgo(new Date(2026, 9, 9, 18, 0).toISOString(), now), 'yesterday');
  assert.equal(shortAgo('nope', now), '');
});

const room = (over: Partial<RoomLite> = {}): RoomLite => ({
  id: 'r1',
  name: 'Q4 review',
  closed: false,
  member_count: 4,
  role: 'member',
  members_may_bring_ai: true,
  ...over,
});
const member = (id: string, over: Partial<MemberLite> = {}): MemberLite => ({
  id,
  kind: 'agent',
  role: 'member',
  own: false,
  ...over,
});

test('roomStatus: open is live, closed is ended', () => {
  assert.equal(roomStatus({ closed: false }), 'live');
  assert.equal(roomStatus({ closed: true }), 'ended');
  assert.equal(membersLabel(4), '4 members');
  assert.equal(membersLabel(1), '1 member');
});

test('agentRooms keeps closed rooms as ended, live first, and never offers Leave to the host agent', () => {
  const rooms = [
    room({ id: 'r2', name: 'Research desk', closed: true, member_count: 2 }),
    room(),
    room({ id: 'r3', name: 'Elsewhere' }),
    room({ id: 'r4', name: 'Hosted', role: 'host' }),
  ];
  const members = new Map([
    ['r1', [member(AGENT, { own: true })]],
    ['r2', [member(AGENT, { own: true })]],
    ['r3', [member(OTHER)]],
    ['r4', [member(AGENT, { own: true, role: 'host' })]],
  ]);
  const rows = agentRooms(rooms, members, AGENT);
  assert.deepEqual(
    rows.map((row) => [row.name, row.status, row.memberCount, row.canLeave]),
    [
      ['Hosted', 'live', 4, false],
      ['Q4 review', 'live', 4, true],
      ['Research desk', 'ended', 2, true],
    ],
  );
});

test('canAddToRoom follows the server rule', () => {
  const withPerson = [member(PERSON, { kind: 'person', own: true })];
  // The owner hosts the room: always (open rooms).
  assert.equal(canAddToRoom(room({ role: 'host' }), [], AGENT), true);
  // In the room as a person, the host allows AIs.
  assert.equal(canAddToRoom(room(), withPerson, AGENT), true);
  // The host turned bringing an AI off.
  assert.equal(canAddToRoom(room({ members_may_bring_ai: false }), withPerson, AGENT), false);
  // Only through another AI, not as a person.
  assert.equal(canAddToRoom(room(), [member(OTHER, { own: true })], AGENT), false);
  // Closed, already in, or members unknown.
  assert.equal(canAddToRoom(room({ role: 'host', closed: true }), [], AGENT), false);
  assert.equal(canAddToRoom(room({ role: 'host' }), [member(AGENT, { own: true })], AGENT), false);
  assert.equal(canAddToRoom(room({ role: 'host' }), undefined, AGENT), false);
});

test('addableRooms lists qualifying rooms by name', () => {
  const rooms = [
    room({ id: 'b', name: 'Beta', role: 'host' }),
    room({ id: 'a', name: 'Alpha' }),
    room({ id: 'c', name: 'Gamma' }),
  ];
  const members = new Map([
    ['a', [member(PERSON, { kind: 'person', own: true })]],
    ['b', []],
    ['c', []],
  ]);
  assert.deepEqual(
    addableRooms(rooms, members, AGENT).map((item) => item.name),
    ['Alpha', 'Beta'],
  );
});
