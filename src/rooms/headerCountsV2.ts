/**
 * Smart Rooms v2 (preview): the pure parts of the room header and the Active-now panel.
 * No React here, so the rules are unit tested (tests/rooms-v2-header.test.ts).
 *
 * Only real data: every number comes from the server (the overview counters, the member list or
 * the task list). When a source is missing (an older server answers 404, or a field is absent),
 * the parsers return null and the UI hides that element; nothing is estimated or made up.
 */
import type { Member, MemberSays, NeedsYouItem, RoomOverview } from './api';
import type { RoomTask } from './tasks';

/**
 * The window older servers' "active" covered (the overview's ais_active_15m), used only when the
 * server does not send the shared active_now rule (members' active_now, overview ais_active_now).
 */
export const ACTIVE_WINDOW_MS = 15 * 60_000;

/**
 * A compact count: 999, 1k, 1.2k, 10.5k, 250k, 1.3M. Rounded down, so a count is never shown
 * larger than it is (10,549 is 10.5k; 999,999 is 999k).
 */
export function compactCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  const n = Math.floor(value);
  if (n < 1000) return String(n);
  const scaled = (amount: number, unit: string) => {
    // One decimal below 100 of a unit, none above; trailing ".0" dropped.
    const digits = amount < 100 ? Math.floor(amount * 10) / 10 : Math.floor(amount);
    return `${digits.toFixed(amount < 100 ? 1 : 0).replace(/\.0$/, '')}${unit}`;
  };
  if (n < 1_000_000) return scaled(n / 1000, 'k');
  if (n < 1_000_000_000) return scaled(n / 1_000_000, 'M');
  return scaled(n / 1_000_000_000, 'B');
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * The overview as the UI may use it, or null when the answer does not have the shape of
 * GET /api/rooms/:room/overview (an older server, or a page that is not JSON).
 * `tasks` is null when room tasks are off or the field is malformed.
 */
export function parseOverview(value: unknown): RoomOverview | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<RoomOverview>;
  const m = v.members;
  if (
    !m ||
    typeof m !== 'object' ||
    !isCount(m.total) ||
    !isCount(m.ais) ||
    !isCount(m.ais_active_15m)
  )
    return null;
  const t = v.tasks;
  const tasks =
    t &&
    typeof t === 'object' &&
    isCount(t.open) &&
    isCount(t.claimed) &&
    isCount(t.in_review) &&
    isCount(t.done)
      ? { open: t.open, claimed: t.claimed, in_review: t.in_review, done: t.done }
      : null;
  const u = v.unread;
  return {
    room_id: typeof v.room_id === 'string' ? v.room_id : '',
    members: {
      total: m.total,
      people: isCount(m.people) ? m.people : Math.max(0, m.total - m.ais),
      ais: m.ais,
      ais_active_15m: m.ais_active_15m,
      ...(isCount(m.ais_active_now) ? { ais_active_now: m.ais_active_now } : {}),
    },
    tasks,
    unread: {
      messages: u && isCount(u.messages) ? u.messages : null,
      mentions: u && isCount(u.mentions) ? u.mentions : 0,
      mentions_capped: u?.mentions_capped === true,
    },
    latest_seq: isCount(v.latest_seq) ? v.latest_seq : 0,
    as_of: typeof v.as_of === 'string' ? v.as_of : '',
  };
}

const NEEDS_YOU_KINDS = new Set([
  'approval',
  'task_to_review',
  'review_request',
  'mention',
  'task_unclaimed',
]);

/**
 * The Needs-you page's items the UI knows how to show, or null when the answer is not a page
 * (an older server). Unknown kinds and items without an id are dropped.
 */
export function parseNeedsYou(value: unknown): { items: NeedsYouItem[]; more: boolean } | null {
  if (!value || typeof value !== 'object') return null;
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const known = items.filter(
    (item): item is NeedsYouItem =>
      Boolean(item) &&
      typeof item === 'object' &&
      NEEDS_YOU_KINDS.has((item as NeedsYouItem).kind) &&
      typeof (item as NeedsYouItem).id === 'string' &&
      typeof (item as NeedsYouItem).since === 'string',
  );
  const more = typeof (value as { next_cursor?: unknown }).next_cursor === 'string';
  return { items: known, more };
}

/** The badge number: the real count up to 99, then "99+". */
export const NEEDS_YOU_BADGE_MAX = 99;
export function needsYouBadge(count: number, more: boolean): string {
  if (count > NEEDS_YOU_BADGE_MAX) return `${NEEDS_YOU_BADGE_MAX}+`;
  return `${count}${more ? '+' : ''}`;
}

/** "Needs you (3)", or "(99+)" beyond 99 waiting items. */
export function needsYouLabel(count: number, more: boolean): string {
  return `Needs you (${needsYouBadge(count, more)})`;
}

/** One Needs-you item as one plain line (the UI renders it as text, never as markup). */
export function needsYouText(item: NeedsYouItem): string {
  const task = item.task ? `T${item.task.number}: ${item.task.title}` : 'a task';
  switch (item.kind) {
    case 'approval':
      return `Elric is waiting for your approval: ${item.approval?.summary || item.approval?.tool || 'an action'}`;
    case 'task_to_review':
      return `Review ${task}`;
    case 'review_request':
      return `You were asked to review ${task}`;
    case 'mention':
      return `${item.from_name || 'Someone'} mentioned you${item.excerpt ? `: "${item.excerpt}"` : ''}`;
    case 'task_unclaimed':
      return `Nobody has claimed ${task} for a day`;
  }
}

/** A person, or an AI (any agent member, Elric included). */
export const isAi = (member: Member) => member.kind !== 'person';

/**
 * Whether an AI member counts as active now: the server's active_now, the same rule as the
 * overview's ais_active_now, so the header badge always equals this list (docs/MEMBER_STATUS.md).
 * Older servers without it: last_active_at within the 15-minute window (the host, or the member's
 * owner, sees it), else the server's status is "active". Nothing else is guessed.
 */
export function isActiveNow(member: Member, now = Date.now()): boolean {
  if (!isAi(member)) return false;
  if (typeof member.active_now === 'boolean') return member.active_now;
  if (member.last_active_at) {
    const at = Date.parse(member.last_active_at);
    if (Number.isFinite(at)) return now - at < ACTIVE_WINDOW_MS;
  }
  return member.status === 'active';
}

/** Active AIs, most recent first (members without a time keep their order, after timed ones). */
export function activeAis(members: readonly Member[], now = Date.now()): Member[] {
  const time = (m: Member) => (m.last_active_at ? Date.parse(m.last_active_at) || 0 : 0);
  return members.filter((m) => isActiveNow(m, now)).sort((a, b) => time(b) - time(a));
}

/**
 * "Active now" when the server says the AI is active now (active_now: a connected AI records room
 * activity at least every 30 seconds, so a minutes-old time would only be a stale snapshot).
 * Otherwise "active just now", "active 3 min ago", "active 2 h ago"; "active now" from the
 * status only (older servers).
 */
export function activeAgo(member: Member, now = Date.now()): string {
  if (member.active_now === true) return 'Active now';
  if (member.last_active_at) {
    const at = Date.parse(member.last_active_at);
    if (Number.isFinite(at)) {
      const minutes = Math.max(0, Math.floor((now - at) / 60_000));
      if (minutes < 1) return 'active just now';
      if (minutes < 60) return `active ${minutes} min ago`;
      return `active ${Math.floor(minutes / 60)} h ago`;
    }
  }
  return member.status === 'active' ? 'active now' : '';
}

/** "active 3 min ago · 12 msgs today"; the count only when the server sent one. */
export function activityLine(member: Member, now = Date.now()): string {
  const today = isCount(member.messages_today)
    ? `${compactCount(member.messages_today)} ${plural(member.messages_today, 'msg', 'msgs')} today`
    : '';
  return [activeAgo(member, now), today].filter(Boolean).join(' · ');
}

/**
 * The counts the header shows. Prefers the overview (cached server counters); without it, the
 * room's own member_count and the member list it already loaded. Null parts are hidden.
 */
export type HeaderCounts = {
  members: number;
  aisActive: number;
  /** AIs in the room; null when unknown. */
  aisInRoom: number | null;
  /** Open (unclaimed) tasks; null when room tasks are off or unknown. */
  openTasks: number | null;
};

export function headerCounts(input: {
  overview: RoomOverview | null;
  memberCount: number;
  members: readonly Member[] | null;
  tasks: readonly RoomTask[] | null;
  now?: number;
  /**
   * The member list is fresh (polled while the Members panel is open) and holds every member:
   * the badge then counts the list itself, so it always equals the Active-now entries shown.
   */
  listCurrent?: boolean;
}): HeaderCounts | null {
  const { overview } = input;
  const listActive =
    input.listCurrent && input.members ? activeAis(input.members, input.now).length : null;
  if (overview)
    return {
      members: overview.members.total,
      aisActive: listActive ?? overview.members.ais_active_now ?? overview.members.ais_active_15m,
      aisInRoom: overview.members.ais,
      openTasks:
        overview.tasks?.open ??
        (input.tasks ? input.tasks.filter((t) => t.status === 'open').length : null),
    };
  if (!input.members) return null;
  return {
    members: input.memberCount,
    aisActive: activeAis(input.members, input.now).length,
    aisInRoom: input.members.filter(isAi).length,
    openTasks: input.tasks ? input.tasks.filter((t) => t.status === 'open').length : null,
  };
}

/** "10.5k members · 6 AIs active now (20 in room)". */
export function metaLine(counts: HeaderCounts): string {
  const members = `${compactCount(counts.members)} ${plural(counts.members, 'member', 'members')}`;
  const active = `${compactCount(counts.aisActive)} ${plural(counts.aisActive, 'AI', 'AIs')} active now`;
  const inRoom = counts.aisInRoom === null ? '' : ` (${compactCount(counts.aisInRoom)} in room)`;
  return `${members} · ${active}${inRoom}`;
}

/**
 * The room pill's accessible name (the pill is the top bar's way to open Members):
 * "Members of Design: 10.5k members, 6 AIs active". Without the active count: the members only.
 */
export function roomPillLabel(name: string, members: number, aisActive: number | null): string {
  const count = `${compactCount(members)} ${plural(members, 'member', 'members')}`;
  if (aisActive === null) return `Members of ${name}: ${count}`;
  return `Members of ${name}: ${count}, ${compactCount(aisActive)} ${plural(aisActive, 'AI', 'AIs')} active`;
}

/**
 * The panel's one-line task summary, "3 in progress · 1 in review · 2 done". From the overview
 * counters, else from the task list; null when tasks are off or unknown.
 */
export function taskSummary(
  overview: RoomOverview | null,
  tasks: readonly RoomTask[] | null,
): { inProgress: number; inReview: number; done: number } | null {
  if (overview?.tasks)
    return {
      inProgress: overview.tasks.claimed,
      inReview: overview.tasks.in_review,
      done: overview.tasks.done,
    };
  if (!tasks) return null;
  const count = (status: RoomTask['status']) => tasks.filter((t) => t.status === status).length;
  return { inProgress: count('claimed'), inReview: count('in_review'), done: count('done') };
}

/** The task an AI has claimed now (claimed or in review under its claim), if any. */
export function claimedTask(member: Member, tasks: readonly RoomTask[] | null): RoomTask | null {
  if (!tasks) return null;
  return (
    tasks.find(
      (t) =>
        t.claim?.agent_id === member.id && (t.status === 'claimed' || t.status === 'in_review'),
    ) ?? null
  );
}

// Control characters, bidi overrides/isolates and zero-width characters: never shown.
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
/** The longest `says` text the server accepts. */
export const SAYS_MAX = 120;

/**
 * A member's self-reported status as plain text for `says: "…"`, or null when there is none or
 * it has expired. The server already cleans it; this repeats the cleaning so the client never
 * depends on that. The caller renders the result as a text node: never as HTML, never linkified.
 */
export function saysText(says: MemberSays | null | undefined, now = Date.now()): string | null {
  if (!says || typeof says.text !== 'string') return null;
  const expires = Date.parse(says.expires_at);
  if (Number.isFinite(expires) && expires <= now) return null;
  const clean = says.text.replace(HIDDEN_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > SAYS_MAX ? `${clean.slice(0, SAYS_MAX - 1)}…` : clean;
}

/** Whether the server sends `says` on members (then it also has the bulk "Mute all AIs"). */
export const serverHasSays = (members: readonly Member[]) =>
  members.some((member) => Object.prototype.hasOwnProperty.call(member, 'says'));
