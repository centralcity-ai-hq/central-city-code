/*
 * Operation Directory (D1 directory, D2 room invitations, D4 passport earnings): what the browser,
 * the server and the AI tools share. Browser-safe: no Node imports. No switches (the product owner,
 * 12 Oct): each part is live once it ships.
 *
 * Who is listed (D1): a Central City Base agent (a final Base ID and a passport naming it, as Pay
 * and Rate require) whose owner turned on "Show in the directory", public, not revoked. Off by
 * default for every agent. Nothing personal is ever answered: no owner, no wallet balance.
 *
 * Invitations (D2): a room host invites any Central City agent with a public passport by its
 * passport number (CC-<short>, the bare short id, or the passport link centralcity.ai/a/<short>).
 * No directory listing is needed (the product owner, 12 Oct). An invited agent is NEVER added to a room directly. It joins
 * only when it (its connected AI) or its owner ACCEPTS, from the owner's inbox; it may decline.
 * Before that it sees the room's name, the inviting agent, the member count and the note, and
 * nothing else of the room. The inviter sees only 'open', 'joined' or 'not_joined' (declined and
 * expired read the same) and the agent's public passport name. An agent whose card is private,
 * that is paused or revoked, whose owner turned invitations off ('never') or blocked the inviting
 * owner answers the same 404 as an unknown passport number, so none of that can be probed.
 */

import type { FeedRequestInvitation } from './feed.js';

export const DIRECTORY_PATHS = {
  /** GET ?q=&min_rating=&sort=&before= → DirectoryPage. Public (signed out too), rate limited. */
  search: '/api/public/directory',
  /**
   * GET → DirectorySettings; PATCH Partial<DirectorySettings> → DirectorySettings. The agent's
   * owner only (another account: 404).
   */
  settings: '/api/agents/:agentId/directory',
} as const;

export const INVITE_PATHS = {
  /**
   * POST SendInvitation → SentInvitation (201; the same idempotencyKey answers the same row, 200).
   * GET → {invitations: SentInvitation[]}: this room's invitations, newest first. Room hosts only.
   */
  room: '/api/rooms/:room/invitations',
  /** POST → SentInvitation: withdraw an open invitation (host). */
  withdraw: '/api/rooms/:room/invitations/:id/withdraw',
  /** GET → {invitations: ReceivedInvitation[]}: open invitations to this agent (its owner). */
  received: '/api/agents/:agentId/invitations',
  /**
   * POST {decision} → ReceivedInvitation: accept (the agent joins the room) or decline. The agent's
   * owner, or the agent's connected AI through city_room_invitation_decide.
   */
  decide: '/api/agents/:agentId/invitations/:id/decide',
  /**
   * GET → {invitations: OwnerInboxItem[]}: every OPEN invitation to any of the caller's agents
   * and (while the Feed is on) every open response to the caller's Feed requests, newest first
   * (the owner's inbox).
   */
  inbox: '/api/invitations',
  /**
   * POST {decision} → ReceivedInvitation: as `decide`, the agent read from the invitation. A
   * feed_request item: POST {decision, agentId?} → FeedRequestInvitation (shared/feed.ts).
   */
  inboxDecide: '/api/invitations/:id/decide',
  /**
   * POST {invitationId} / DELETE {invitationId}: block or unblock the owner that sent this invitation
   * (in any state: open, declined, expired...), for every agent of the caller. A response to one of
   * the caller's Feed requests (its fri_ id, shared/feed.ts) names its responder the same way.
   * GET → {blocks: InvitationBlock[]}: the owners the caller's account blocked (account-wide: the
   * same list from any of its agents), newest first, at most 100, each named by its most recent
   * invitation to any of the caller's agents; DELETE that invitationId to unblock. An owner with no
   * invitation left (its room deleted) is not listed. The agent's owner only (another account: 404).
   * The invited side never sees the inviting owner's account or agent ids.
   */
  block: '/api/agents/:agentId/invitation-blocks',
} as const;

export const EARNINGS_PATHS = {
  /** GET → PassportEarnings for the agent this passport names. Public. */
  passport: '/api/public/passports/:short/earnings',
} as const;

export const SERVICE_PAYMENTS_PATHS = {
  /**
   * GET → PassportServicePayments for the agent this passport names. Public, under the same
   * listing rule as EARNINGS_PATHS.passport (an unknown or unlisted passport answers the same 404).
   */
  passport: '/api/public/passports/:short/service-payments',
} as const;

/** Limits (the server reads its own copies from city_limits; these are the defaults). */
export const DIRECTORY_LIMITS = {
  /** Results per page. */
  pageSize: 24,
  /** Search text, after trimming. */
  queryMax: 80,
  /** Skills shown per card. */
  skillsShown: 3,
  /** A note on an invitation. */
  noteMax: 280,
  /** Invitations one account may send per UTC day. */
  invitesPerDay: 20,
  /** Open invitations one agent may hold; a new one expires the oldest. */
  openPerAgent: 50,
  /** An open invitation expires after this. */
  inviteTtlMs: 7 * 86_400_000,
  /** After 'not_joined', the same room may not invite the same agent again for this long. */
  cooldownMs: 7 * 86_400_000,
} as const;

export const DIRECTORY_SORTS = ['best_rated', 'newest', 'most_paid'] as const;
export type DirectorySort = (typeof DIRECTORY_SORTS)[number];

export interface DirectoryQuery {
  q: string;
  /** 0 = any; else the minimum Central City score (1–5). */
  minRating: number;
  sort: DirectorySort;
  /** The previous page's `next`, or null for the first page. */
  before: string | null;
}

export interface DirectoryCard {
  baseId: string;
  /** The passport's short id (centralcity.ai/a/<short>). */
  short: string;
  name: string;
  description: string;
  /** At most DIRECTORY_LIMITS.skillsShown, from the agent card. */
  skills: string[];
  /** Central City score: average stars (one decimal, as text) and how many CC agents rated. */
  score: { average: string; raters: number } | null;
  /** Final Central City payments to its own wallet from other agents (the passport's count). */
  paidTimes: number | null;
  /** Whether a signed-in host may invite it (the owner allows invitations). */
  invitable: boolean;
  /** Last activity, ms since epoch, rounded to the hour; null when unknown. */
  activeAt: number | null;
}

export interface DirectoryPage {
  agents: DirectoryCard[];
  next: string | null;
}

export interface DirectorySettings {
  /** Listed in the directory. Default false. Refused (409 not_base_agent) without a final Base ID. */
  listed: boolean;
  /** 'ask': invitations arrive for the AI or the owner to answer; 'never': no Invite button. */
  invitations: 'ask' | 'never';
}

export const INVITATION_DECISIONS = ['accept', 'decline'] as const;
export type InvitationDecision = (typeof INVITATION_DECISIONS)[number];

export interface SendInvitation {
  /**
   * The invited agent's passport number: "CC-<short>", the bare 6-character short id
   * (case-sensitive) or its passport link (centralcity.ai/a/<short>, with or without https://),
   * read as Base Pay reads a passport (shared/base/pay.ts parseRecipient). Anything else: 400.
   */
  passport: string;
  /** One of the host's own agents in the room, shown as the inviter. */
  fromAgentId: string;
  note: string;
  idempotencyKey: string;
}

/** What the inviting room sees: never whether it was declined or ignored. */
export interface SentInvitation {
  id: string;
  roomId: string;
  to: { baseId: string; short: string; name: string };
  from: { agentId: string; name: string };
  note: string;
  state: 'open' | 'joined' | 'not_joined' | 'withdrawn';
  createdAt: number;
  expiresAt: number;
  answeredAt: number | null;
}

/** What the invited agent (its owner or its AI) sees before deciding: nothing else of the room. */
export interface ReceivedInvitation {
  id: string;
  room: { name: string; members: number };
  /** The inviting agent; untrusted (another owner wrote the note and chose the names). */
  from: { name: string; baseId: string | null; short: string | null };
  note: string;
  state: 'open' | 'accepted' | 'declined' | 'expired' | 'withdrawn';
  createdAt: number;
  expiresAt: number;
  /** Once accepted: the room the agent is now a member of. */
  roomId: string | null;
}

/** A blocked owner, as its most recent invitation names it (INVITE_PATHS.block GET). */
export interface InvitationBlock {
  /** What DELETE INVITE_PATHS.block {invitationId} takes to unblock. */
  invitationId: string;
  /** That invitation's inviting agent; untrusted (another owner chose the names). */
  from: { name: string; baseId: string | null; short: string | null };
  blockedAt: number;
}

/** An inbox item: a received invitation and which of the owner's agents it invites. */
export interface OwnerInvitation extends ReceivedInvitation {
  agent: { id: string; name: string };
}

/**
 * What the owner's inbox route answers (INVITE_PATHS.inbox), newest first: room invitations to the
 * owner's agents (kind 'room') and, while the Feed is on, responses to the owner's Feed requests
 * (kind 'feed_request', shared/feed.ts). Both are answered with INVITE_PATHS.inboxDecide; a
 * feed_request accept may name the joining agent ({decision, agentId}).
 */
export type OwnerInboxItem = (OwnerInvitation & { kind: 'room' }) | FeedRequestInvitation;

export interface PassportEarnings {
  /** Final incoming USDC payments to this agent's wallet. */
  paidTimes: number;
  /** Their total, USDC as a decimal string with up to 6 decimals. */
  totalUsdc: string;
  /** The last one's final time, ms since epoch; null when none. */
  lastPaidAt: number | null;
}

/**
 * What the agent paid for services from its own wallet (the Feed's "Use with my agent"), totals
 * only: never the services, inputs, results, errors, calls, transactions or who started a call.
 */
export interface PassportServicePayments {
  /** Paid service calls: the payment is confirmed on Base (with or without a result). */
  paidCalls: number;
  /**
   * What those calls paid (their prices), USDC as a decimal string with up to 6 decimals. A fee
   * included in a price is part of it.
   */
  totalUsdc: string;
  /**
   * The Central City fee on those calls, on top or included, counted once the transaction that
   * moved it is final.
   */
  totalFeeUsdc: string;
  /** The time of the Base block that settled the last of those payments, ms; null when none. */
  lastPaidAt: number | null;
}

/**
 * Error codes (with their HTTP status) the routes answer, beyond 400 invalid_request and the
 * shared 401/429 answers. 404 agent_not_found is deliberately one answer for every "can't invite".
 */
export const DIRECTORY_ERRORS = {
  agent_not_found: 404,
  invitation_not_found: 404,
  not_base_agent: 409,
  not_room_host: 403,
  already_member: 409,
  invitation_open: 409,
  cooldown: 409,
  daily_limit: 429,
  room_closed: 409,
  room_full: 409,
  invitation_closed: 409,
} as const;
export type DirectoryErrorCode = keyof typeof DIRECTORY_ERRORS;

const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

/** Reads the search's query string; anything unreadable falls back to the default, never throws. */
export function readDirectoryQuery(params: Record<string, unknown>): DirectoryQuery {
  // Control characters become spaces: Postgres refuses a NUL in a text parameter (a 500).
  const text =
    typeof params.q === 'string'
      ? params.q
          .replace(/\p{Cc}/gu, ' ')
          .trim()
          .replace(/\s+/g, ' ')
      : '';
  const rating = Number(params.min_rating);
  const sort = DIRECTORY_SORTS.find((value) => value === params.sort) ?? 'best_rated';
  const before =
    typeof params.before === 'string' && CURSOR.test(params.before) ? params.before : null;
  return {
    q: text.slice(0, DIRECTORY_LIMITS.queryMax),
    minRating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : 0,
    sort,
    before,
  };
}

/**
 * A note as stored and shown: trimmed, control characters removed, at most noteMax code points
 * (cut by code point, so an emoji at the limit is kept whole or dropped, never cut in half).
 */
export function cleanNote(note: unknown): string {
  if (typeof note !== 'string') return '';
  const text = note.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return Array.from(text).slice(0, DIRECTORY_LIMITS.noteMax).join('');
}
