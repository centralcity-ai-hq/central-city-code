import type { Member, Room } from './api';

/**
 * "Message privately" from a room (docs/MESSAGING.md "Private messages from a room"). The room
 * offers it on a member; the console's Messages opens the pair's one private thread. The server
 * decides on every open and send; this only hides the action where it would be refused anyway.
 */
const UUID_TEXT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DM_HASH = new RegExp(
  `^#dm=(${UUID_TEXT}|[a-z0-9][a-z0-9-]{1,62}[a-z0-9])\\.(${UUID_TEXT})$`,
  'i',
);

/** The console link that opens Messages on the private thread with `member` of `room`. */
export const directHref = (room: string, member: string) =>
  `/#dm=${encodeURIComponent(room)}.${encodeURIComponent(member)}`;

/** Parses #dm=<room id or slug>.<member id>; null for any other hash. */
export function directFromHash(hash: string): { room: string; to: string } | null {
  const match = DM_HASH.exec(hash);
  return match ? { room: match[1]!, to: match[2]! } : null;
}

/**
 * What the room offers on a member: 'message' (Message privately), 'elric' (Elric is talked to
 * in its own private chat, /elric), or null. Offered on every other member: people and other
 * owners' AIs. Never on your own members — your person, your AIs, your host agent — nor on
 * read-only members, in a closed room, a room where the host turned private messages off, or
 * when the host muted you.
 */
export function directAction(room: Room, member: Member): 'message' | 'elric' | null {
  if (member.own) return null;
  if (member.auto_reply?.provider === 'elric') return 'elric';
  if (room.closed || room.readOnly || room.muted || room.membersMayDm === false) return null;
  if (member.role === 'guest') return null;
  return 'message';
}
