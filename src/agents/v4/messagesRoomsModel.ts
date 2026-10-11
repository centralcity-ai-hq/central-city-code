import type {
  AgentMessage,
  ConversationSummary,
  DirectParty,
  DirectRecipient,
  DirectThread,
  InboxSummary,
} from '../../../server/messaging/contract';
import type { RoomRole, RoomView } from '../../../server/rooms/contract';

/*
 * My agents v4, Messages and Rooms of one agent (docs/design/my-agents-v4-mockup.html). Pure, so
 * the screens stay thin and tests/v4-messages-rooms.test.ts covers every rule here.
 */

/** One party of a thread as the agent's screen shows it. */
export type ThreadParty = { id: string; name: string; kind: 'agent' | 'person' };

/**
 * Who a thread is with, seen from one agent, and how a reply is sent.
 * - `direct`: a private room thread; the reply goes exactly as Messages does it
 *   (POST /api/rooms/:room/direct/messages, from the viewer's side `self` to `peer`).
 * - `agent`: a thread along a connection; the owner answers as this agent
 *   (POST /api/agents/:agent/messages with the thread's context).
 */
export type ThreadView = {
  contextId: string;
  with: ThreadParty;
  /** The member whose messages are drawn on the right ("me" bubbles). */
  mine: string;
  send:
    | { mode: 'direct'; room: string; from: string; to: ThreadParty }
    | { mode: 'agent'; from: string; to: ThreadParty };
};

const youOrName = (party: Pick<DirectParty, 'name' | 'is_self' | 'kind'>) =>
  party.is_self && party.kind === 'person' ? 'You' : party.name;

/** The viewer's private thread, seen from `agentId` (one of its two members). */
export function directView(direct: DirectThread, agentId: string): ThreadView {
  const other = direct.self.id === agentId ? direct.peer : direct.self;
  return {
    contextId: direct.context_id,
    with: { id: other.id, name: youOrName(other), kind: other.kind },
    mine: direct.self.id,
    send: {
      mode: 'direct',
      room: direct.room_id,
      from: direct.self.id,
      to: { id: direct.peer.id, name: direct.peer.name, kind: direct.peer.kind },
    },
  };
}

/** A thread of `agentId` from the conversation list, or null when the agent is not in it. */
export function threadView(summary: ConversationSummary, agentId: string): ThreadView | null {
  if (!summary.participants.includes(agentId)) return null;
  if (summary.direct) return directView(summary.direct, agentId);
  const last = summary.last_message;
  const otherId =
    summary.participants.find((id) => id !== agentId) ??
    (last.from_agent_id === agentId ? last.to_agent_id : last.from_agent_id);
  const otherName =
    last.from_agent_id === otherId
      ? last.from_agent_name
      : last.to_agent_id === otherId
        ? last.to_agent_name
        : 'Unknown agent';
  const other: ThreadParty = { id: otherId, name: otherName, kind: 'agent' };
  return {
    contextId: summary.context_id,
    with: other,
    mine: agentId,
    send: { mode: 'agent', from: agentId, to: other },
  };
}

/** One row of the agent's Messages list. */
export type MessageRow = {
  contextId: string;
  with: ThreadParty;
  last: string;
  at: string;
  unread: number;
  unreadCapped: boolean;
};

/**
 * The conversations this agent takes part in (its id among the participants), newest first.
 * The unread count of a thread is the owner's (every own member in it), as the server reports it.
 */
export function agentConversations(
  conversations: readonly ConversationSummary[],
  agentId: string,
): MessageRow[] {
  const rows: MessageRow[] = [];
  for (const item of conversations) {
    const view = threadView(item, agentId);
    if (!view) continue;
    rows.push({
      contextId: item.context_id,
      with: view.with,
      last: messageText(item.last_message),
      at: item.last_message.created_at,
      unread: item.unread,
      unreadCapped: item.unread_capped,
    });
  }
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** The words of a message: its text parts, or "Shared data" for data only. */
export function messageText(message: Pick<AgentMessage, 'parts'>): string {
  const text = message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join(' ')
    .trim();
  return text || 'Shared data';
}

/** Oldest first, ties by id; duplicates (a poll and a send) collapse by message id. */
export function mergeMessages(
  current: readonly AgentMessage[],
  incoming: readonly AgentMessage[],
): AgentMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
}

/** The agent's unread total from GET /api/messages/summary (owner-wide per inbox). */
export function agentUnread(inboxes: readonly InboxSummary[], agentId: string): number {
  return inboxes.find((item) => item.agent_id === agentId)?.unread ?? 0;
}

/**
 * Where "New message" opens a thread with this agent: a shared room in which the person can
 * message it (GET /api/messages/recipients lists the agent), or null (no button).
 */
export function newMessageRoom(
  recipients: readonly DirectRecipient[],
  agentId: string,
): string | null {
  return recipients.find((item) => item.member_id === agentId)?.room_id ?? null;
}

/** The list's time: "now", "4 min", "1 h" (today), "yesterday", then the date. */
export function shortAgo(iso: string, now = Date.now(), locale?: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min`;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (then >= start.getTime()) return `${Math.floor(minutes / 60)} h`;
  if (then >= start.getTime() - 86_400_000) return 'yesterday';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(then);
}

/* ---------- Rooms ---------- */

/** One member of GET /api/rooms/:room/members, the fields these screens read. */
export type MemberLite = {
  id: string;
  kind?: 'agent' | 'person';
  role: RoomRole;
  own: boolean;
};

/** The room fields these screens read (server/rooms/contract.ts RoomView). */
export type RoomLite = Pick<RoomView, 'id' | 'name' | 'closed' | 'member_count' | 'role'> & {
  members_may_bring_ai?: boolean;
};

export type RoomStatus = 'live' | 'ended';

/** The mockup's room state: an open room is live, a closed one ended. */
export function roomStatus(room: Pick<RoomView, 'closed'>): RoomStatus {
  return room.closed ? 'ended' : 'live';
}

/** "4 members" (one: "1 member"). */
export function membersLabel(count: number): string {
  return `${count} ${count === 1 ? 'member' : 'members'}`;
}

export type AgentRoomRow = {
  id: string;
  name: string;
  status: RoomStatus;
  memberCount: number;
  /** The host agent cannot leave its own room (the server refuses host_cannot_leave). */
  canLeave: boolean;
};

/**
 * The rooms this agent is in, open and closed (closed shows as ended), open rooms first, then by
 * name. Leaving works in either; only the room's host agent cannot leave.
 */
export function agentRooms(
  rooms: readonly RoomLite[],
  members: ReadonlyMap<string, readonly MemberLite[]>,
  agentId: string,
): AgentRoomRow[] {
  const rows: AgentRoomRow[] = [];
  for (const room of rooms) {
    const member = members.get(room.id)?.find((item) => item.id === agentId);
    if (!member) continue;
    rows.push({
      id: room.id,
      name: room.name,
      status: roomStatus(room),
      memberCount: room.member_count,
      canLeave: member.role !== 'host',
    });
  }
  return rows.sort(
    (a, b) =>
      Number(a.status === 'ended') - Number(b.status === 'ended') || a.name.localeCompare(b.name),
  );
}

/**
 * Whether the server lets the owner add this agent to the room (POST /api/rooms/:room/join
 * {agent_id}; rooms/service.ts): the room is open, the agent is not in it, and the owner hosts it,
 * or is in it as a person while the host lets members bring their AI.
 */
export function canAddToRoom(
  room: RoomLite,
  members: readonly MemberLite[] | undefined,
  agentId: string,
): boolean {
  if (room.closed || !members) return false;
  if (members.some((item) => item.id === agentId)) return false;
  if (room.role === 'host') return true;
  const asPerson = members.some((item) => item.own && item.kind === 'person');
  return asPerson && room.members_may_bring_ai !== false;
}

/** The rooms "Add to a room" offers, by name. */
export function addableRooms(
  rooms: readonly RoomLite[],
  members: ReadonlyMap<string, readonly MemberLite[]>,
  agentId: string,
): RoomLite[] {
  return rooms
    .filter((room) => canAddToRoom(room, members.get(room.id), agentId))
    .sort((a, b) => a.name.localeCompare(b.name));
}
