import type { Member, MemberStatus } from './api';
import { agentLabel } from './people';
import { ELRIC_MEMBER_BADGE } from '../../shared/elric-copy';

/**
 * Smart Rooms v2 Members panel (MembersV2.tsx): the text each member row shows, as pure functions
 * so they are tested on their own (tests/rooms-v2-members.test.ts). Names, owner labels and
 * `says` are untrusted text: they are returned as strings and rendered as text, never as markup.
 */

/** Members per page in the v2 panel (the server allows up to 1000). */
export const MEMBERS_PAGE_V2 = 50;

export type MemberBadgeKind = 'host' | 'you' | 'ai' | 'elric' | 'guest';
/** `spoken`: what screen readers hear instead of `text`, when the two differ. */
export type MemberBadge = { kind: MemberBadgeKind; text: string; spoken?: string };

export const isElric = (member: Member) => member.auto_reply?.provider === 'elric';
export const isAi = (member: Member) => (member.kind ?? 'agent') === 'agent';

/**
 * The row's badges, in order: Host (the room host), You (the viewer as a person in the room),
 * Guest (a read-only guest or a no-account invite guest), then for an AI its label: Elric's
 * "AI assistant", "AI · your agent" for the viewer's own, "AI · Ana's agent" when the owner's
 * name is known (people.ts agentOwners), else "AI agent". Another account's AI is heard as
 * "AI agent owned by Ana" or "AI agent", as in AgentLabel.tsx.
 */
export function memberBadges(
  member: Member,
  ownerOf: (label: string) => string | null,
): MemberBadge[] {
  const badges: MemberBadge[] = [];
  if (member.role === 'host') badges.push({ kind: 'host', text: 'Host' });
  if (member.own && !isAi(member)) badges.push({ kind: 'you', text: 'You' });
  if (member.role !== 'host' && (member.role === 'guest' || member.guest === true))
    badges.push({ kind: 'guest', text: 'Guest' });
  if (isAi(member)) {
    if (isElric(member)) badges.push({ kind: 'elric', text: ELRIC_MEMBER_BADGE });
    else if (member.own) badges.push({ kind: 'ai', text: 'AI · your agent' });
    else {
      const owner = ownerOf(member.owner_label);
      badges.push({
        kind: 'ai',
        text: agentLabel(owner),
        spoken: owner ? `AI agent owned by ${owner}` : 'AI agent',
      });
    }
  }
  return badges;
}

const STATUS_TEXT: Record<MemberStatus, string> = {
  active: 'Active',
  idle: 'Idle',
  offline: 'Offline',
  access_expired: 'Access expired',
};

/** "just now", "3 min ago", "5 h ago", "2 d ago" (future times count as now). */
export function agoText(at: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / (24 * 60))} d ago`;
}

/**
 * The activity line: "active 3 min ago · 12 today" where the server sent the exact time (the host
 * and the member's owner), otherwise the server's status label ("Idle · 4 today"). The count is
 * shown when the server sent one above zero (null means the viewer may not see it). An expired guest
 * always reads "Access expired". Empty when the server sent neither.
 */
export function activityText(member: Member, now: number): string {
  const parts: string[] = [];
  const at = member.last_active_at;
  if (member.status === 'access_expired') parts.push(STATUS_TEXT.access_expired);
  // Active now (the server's shared rule, as the header badge): never a stale "10 min ago".
  else if (member.active_now === true) parts.push('Active now');
  else if (at && Number.isFinite(Date.parse(at))) parts.push(`active ${agoText(at, now)}`);
  else if (member.status) parts.push(STATUS_TEXT[member.status]);
  const today = member.messages_today;
  if (typeof today === 'number' && Number.isFinite(today) && today >= 1)
    parts.push(`${Math.floor(today)} today`);
  return parts.join(' · ');
}

/**
 * The AI's self-reported status, when the server sends one: `says` as plain text ({ text } from
 * servers with self-reported status, or a bare string), trimmed, at most 120 characters. Null when
 * absent, empty or of an unknown shape, so older servers render nothing.
 */
export function saysText(member: Member): string | null {
  const value = member.says;
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string'
        ? (value as { text: string }).text
        : null;
  const text = raw?.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/**
 * The rows with the activity fields (status, active_now, last_active_at, messages_today) of a
 * newer list of the same members; rows not in it are kept as they are.
 */
export function withActivity(rows: readonly Member[], fresh: readonly Member[]): Member[] {
  const byId = new Map(fresh.map((member) => [member.id, member]));
  return rows.map((row) => {
    const next = byId.get(row.id);
    if (!next) return row;
    return {
      ...row,
      status: next.status,
      last_active_at: next.last_active_at,
      active_now: next.active_now,
      messages_today: next.messages_today,
    };
  });
}

/** People first, then AIs; each in the server's order (join order). */
export function groupMembers(members: readonly Member[]): { people: Member[]; ais: Member[] } {
  const people: Member[] = [];
  const ais: Member[] = [];
  for (const member of members) (isAi(member) ? ais : people).push(member);
  return { people, ais };
}

/** "9", "1,204", "10.5k" (one decimal under 100k). */
export function countText(count: number): string {
  if (count < 10_000) return count.toLocaleString('en-US');
  if (count < 100_000) return `${(Math.floor(count / 100) / 10).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.floor(count / 1000)}k`;
}

/** Appends a page, keeping the first copy of a member that moved between pages. */
export function mergePage(current: readonly Member[], page: readonly Member[]): Member[] {
  const seen = new Set(current.map((member) => member.id));
  return [...current, ...page.filter((member) => !seen.has(member.id))];
}
