/**
 * The "New since HH:MM · N updates" divider (Smart Rooms v2 preview).
 *
 * The person's read position is the per-device read mark the room list keeps for its unread
 * badges (RoomsApp readMarks, localStorage `cc.rooms.read.<workspace>`): the newest seq this device
 * showed in the room. room_members.last_read_seq is the AI's cursor and is not used. The mark is
 * taken once, when the room opens, so the divider stays where it was while the room is open.
 *
 * Only messages the unread badge counts are counted here too: never your own posts, never a
 * system line. No mark (the room was never opened on this device) means no divider.
 */

type Countable = {
  id: string;
  seq: number;
  own: boolean;
  created_at: string;
  sender_kind?: string;
};

/** Same rule as the room list's unread badge: messages from others, not system lines. */
export function countsAsNew(message: Countable): boolean {
  return !message.own && message.sender_kind !== 'system';
}

export type NewSince = {
  /** The message the divider sits above: the first one after the mark that counts. */
  firstId: string;
  /** Messages after the mark that count. */
  count: number;
  /** Older messages after the mark are not loaded yet: the count is a lower bound. */
  more: boolean;
  /** When the last message the person had seen was written; else the first new one. */
  since: Date;
};

export function newSinceOf(
  messages: readonly Countable[],
  mark: number | undefined,
  hasOlder: boolean,
): NewSince | null {
  if (mark === undefined || !Number.isSafeInteger(mark) || mark < 0) return null;
  let first: Countable | undefined;
  let lastSeen: Countable | undefined;
  let count = 0;
  for (const message of messages) {
    if (message.seq <= mark) {
      lastSeen = message;
      continue;
    }
    if (!countsAsNew(message)) continue;
    count++;
    first ??= message;
  }
  if (!first) return null;
  const since = new Date((lastSeen ?? first).created_at);
  if (Number.isNaN(since.getTime())) return null;
  return { firstId: first.id, count, more: hasOlder && !lastSeen, since };
}

/** "3 updates", "1 update", "100+ updates". */
export function updatesLabel(count: number, more: boolean): string {
  return `${count}${more ? '+' : ''} ${count === 1 && !more ? 'update' : 'updates'}`;
}
