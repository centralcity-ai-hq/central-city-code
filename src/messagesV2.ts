import type { ConversationSummary, DirectParty } from '../server/messaging/contract';

/*
 * Labels of the workspace preview Messages page (?workspace=v2). Pure, so they are unit tested
 * (tests/messages-v2.test.ts); the legacy page does not use them.
 */

/** The server caps per-thread unread at 99 (UNREAD_CAP) and flags anything above it. */
export const UNREAD_CAP = 99;

/** Badge text: '' for none, '99+' when the server capped the count or a sum passes the cap. */
export function formatUnread(count: number, capped = false): string {
  if (capped || count > UNREAD_CAP) return `${UNREAD_CAP}+`;
  return count > 0 ? String(Math.floor(count)) : '';
}

/** Unread across the summaries one chat groups (legacy UUID contexts can share a chat). */
export function sumUnread(items: Pick<ConversationSummary, 'unread' | 'unread_capped'>[]): {
  count: number;
  capped: boolean;
} {
  let count = 0;
  let capped = false;
  for (const item of items) {
    count += Math.max(0, item.unread ?? 0);
    capped ||= Boolean(item.unread_capped);
  }
  return { count: Math.min(count, UNREAD_CAP), capped: capped || count > UNREAD_CAP };
}

/** Screen-reader text for a badge: "3 unread", "More than 99 unread". */
export function unreadLabel(count: number, capped = false): string {
  if (capped || count > UNREAD_CAP) return `More than ${UNREAD_CAP} unread`;
  return `${count} unread`;
}

/** The room a private thread started in, as a chip: "From #research". */
export function roomOrigin(roomName: string): string {
  return `From #${roomName.trim().replace(/^#+/, '')}`;
}

/** Display name of a private-thread party: the viewer's own member is "You". */
export function partyName(party: Pick<DirectParty, 'name' | 'is_self'>): string {
  return party.is_self === true ? 'You' : party.name;
}

/**
 * Role label of a private-thread party. An AI shows whose it is from the room's owner_label
 * ("AI · Acme"). The viewer's own member is already named "You" (partyName) and a person has
 * no role label, so both return null.
 */
export function partyRole(
  party: Pick<DirectParty, 'kind' | 'owner_label' | 'is_self' | 'own'>,
): string | null {
  if (party.is_self === true || party.kind !== 'agent') return null;
  if (party.own === true) return 'Your AI';
  return party.owner_label ? `AI · ${party.owner_label}` : 'AI agent';
}

type PrivacyParty = Pick<DirectParty, 'name' | 'kind' | 'owner_label' | 'own'>;

/**
 * Who can read a private thread, stated without claiming more privacy than there is. Both owners
 * read a private thread (docs/MESSAGING.md "Private messages from a room"): the viewer reads
 * their own agent's threads, and an AI peer's owner reads the AI's. A person peer reads it
 * themselves.
 */
export function privacyNote(self: PrivacyParty, peer: PrivacyParty): string {
  // One of your own AIs: only you (its owner) read it.
  if (peer.own === true)
    return self.kind !== 'agent'
      ? `Private: you and your AI ${peer.name}. Only you can read it.`
      : `Private between your agents ${self.name} and ${peer.name}. Only you can read it.`;
  const peerOwner =
    peer.kind === 'agent'
      ? peer.owner_label
        ? `${peer.name}'s owner (${peer.owner_label})`
        : `${peer.name}'s owner`
      : null;
  if (self.kind !== 'agent') {
    return peerOwner
      ? `Private: you and ${peer.name}. ${peerOwner} can read it too.`
      : `Private: you and ${peer.name}.`;
  }
  const lead = `Private between your agent ${self.name} and ${peer.name}.`;
  return peerOwner
    ? `${lead} You can read it as its owner, and so can ${peerOwner}.`
    : `${lead} You can read it as its owner.`;
}

/*
 * Workspace v3 Messages (docs/design/WORKSPACE_V3.md §5): inbox tabs, relative times and the
 * small message format (fenced code blocks and @mentions; private messages are plain text).
 */

/** The inbox tabs: everything, chats with unread messages, and chats with an AI. */
export type InboxFilter = 'all' | 'unread' | 'agents';
export function matchesFilter(
  filter: InboxFilter,
  chat: { unread: number; capped?: boolean; ai: boolean },
): boolean {
  if (filter === 'unread') return chat.unread > 0 || chat.capped === true;
  if (filter === 'agents') return chat.ai;
  return true;
}

/**
 * "now" (under a minute), "5m", "3h" (under 24 hours), then by local calendar day: "Yesterday"
 * (the day before today in the viewer's time zone), "2d" up to six days back, then the date
 * ("4 Oct"). A future time (clock skew) is "now".
 */
export function relativeTime(iso: string, now = Date.now(), locale?: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = calendarDaysBetween(then, now);
  if (days <= 1) return 'Yesterday';
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(then);
}

/** Whole local calendar days from `from` to `to` (midnight to midnight; DST-safe). */
function calendarDaysBetween(from: number, to: number): number {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/** A message's time: the clock time today, the date and time on other days. */
export function messageTime(iso: string, now = Date.now(), locale?: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const today = new Date(now);
  const sameDay =
    then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate();
  return new Intl.DateTimeFormat(
    locale,
    sameDay
      ? { hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' },
  ).format(then);
}

export type TextSegment = { type: 'text'; text: string } | { type: 'code'; code: string };
/**
 * Splits a plain-text message into text and fenced code blocks (```…```). An unclosed fence
 * stays text. Nothing is interpreted as HTML or Markdown beyond the fence itself.
 */
export function splitCode(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  const fence = /```[^\n`]*\n([\s\S]*?)\n?```/g;
  let last = 0;
  for (const match of text.matchAll(fence)) {
    const before = text.slice(last, match.index).replace(/\n$/, '');
    if (before) out.push({ type: 'text', text: before });
    out.push({ type: 'code', code: match[1]! });
    last = match.index + match[0].length;
  }
  const rest = text.slice(last).replace(/^\n/, '');
  if (rest || !out.length) out.push({ type: 'text', text: last ? rest : text });
  return out;
}
