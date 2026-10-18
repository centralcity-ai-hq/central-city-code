/**
 * The rooms UI transport contract. The `RoomsClient` shape, the
 * mock and `withRoomDeadline` come from the first rooms UI, extended with
 * `parts`, `own`, `sender_owner_label`, `created_at`, `member_count` and `latest_seq`, and adapted
 * to the live REST routes (docs/ROOMS.md, docs/JOIN_LINKS.md).
 *
 * Every call goes through api(), which keeps X-City-Workspace. Server text is never shown: errors
 * surface as RoomsError (a code for the UI) or ApiError (status only) and are described with
 * describeError. Invite secrets travel only in request bodies, never in a URL.
 */
import { api, ApiError, selectedWorkspaceId } from '../api';
import { isPagedWorkspace, noteSnapshotPaging, snapshotPage } from '../agents/agentPages';
import { searchLiveAgents } from '../agents/ownAgents';
import type { AgentsPageInfo } from '../../shared/types';
import type { MessagePart } from '../../server/messaging/contract';
import { ELRIC_HOST_ONLY_CODE, ELRIC_HOST_ONLY_MESSAGE } from '../../shared/elric-copy';

export type Agent = { id: string; name: string };
export type Role = 'host' | 'member' | 'guest';
export type MessageFormat = 'plain' | 'markdown';
/** A member that left on its own (host view). */
export type LeftMember = { id: string; name: string; owner_label: string; left_at: string };
/** A member the host removed whose owner cannot rejoin (host only; account-less guests excluded:
 * their block is their network's, lifted from Room settings). */
export type RemovedMember = { id: string; name: string; owner_label: string; removed_at: string };
/** A member the host muted (active or left): it still reads, but cannot post. */
export type MutedMember = {
  agent_id: string;
  muted_at: string;
  reason: string | null;
  active: boolean;
};
/** Older servers send no format: that is plain text. */
const withFormat = (message: RoomMessage): RoomMessage => ({
  ...message,
  format: message.format === 'markdown' ? 'markdown' : 'plain',
});
/** 'full': people and AIs who join read the whole conversation; 'from_join': only later messages. */
export type History = 'from_join' | 'full';
/** Server-derived member status (docs/MEMBER_STATUS.md); never reported by the member itself. */
export type MemberStatus = 'active' | 'idle' | 'offline' | 'access_expired';
export type Member = Agent & {
  /** 'person': a signed-in person in the room as themselves. */
  kind?: 'agent' | 'person';
  role: Role;
  owner_label: string;
  own: boolean;
  joined_at: string;
  /** Absent from older servers and the mock. */
  status?: MemberStatus;
  /** Last room activity (minute precision); null unless you host the room or own the member. */
  last_active_at?: string | null;
  /**
   * An AI active now (one server rule; the overview's ais_active_now counts exactly these).
   * Absent from older servers and the mock.
   */
  active_now?: boolean;
  /**
   * True for a guest without an account (joined through an invite link); such a guest gets a new
   * identity on every join. Absent from servers that don't mark guests yet: treated as false.
   */
  guest?: boolean;
  /** Server-stamped auto-reply metadata (e.g. { provider: 'elric' }). */
  auto_reply?: { provider: 'openai' | 'anthropic' | 'elric'; label?: string } | null;
  /**
   * The member's posts today (UTC); null when this viewer may not see it, absent from servers
   * without the room overview.
   */
  messages_today?: number | null;
  /**
   * An AI's self-reported status, shown as `says: "…"` (untrusted text, never verified); null
   * when none is set, absent from servers without it.
   */
  says?: MemberSays | null;
};
/** One page of members (`GET /api/rooms/:room/members`); next_cursor while more follow. */
export type MembersPage = { members: Member[]; next_cursor?: string };
/** An AI member's own status line (self-reported; plain text only). */
export type MemberSays = {
  text: string;
  eta: string | null;
  set_at: string;
  expires_at: string;
  self_reported: true;
};
/** Cached counters for one room (`GET /api/rooms/:room/overview`). */
export type RoomOverview = {
  room_id: string;
  members: {
    total: number;
    people: number;
    ais: number;
    ais_active_15m: number;
    /** AI members with active_now; absent from older servers (then ais_active_15m). */
    ais_active_now?: number;
  };
  /** Null while room tasks are off. */
  tasks: { open: number; claimed: number; in_review: number; done: number } | null;
  unread: { messages: number | null; mentions: number; mentions_capped: boolean };
  latest_seq: number;
  as_of: string;
};
export type NeedsYouKind =
  'approval' | 'task_to_review' | 'review_request' | 'mention' | 'task_unclaimed';
/** One entry of the caller's "Needs you" queue. Excerpts and titles are untrusted room text. */
export type NeedsYouItem = {
  kind: NeedsYouKind;
  id: string;
  since: string;
  task?: { id: string; number: number; title: string; status: string };
  agent_id?: string;
  message_seq?: number;
  from_name?: string;
  excerpt?: string;
  approval?: { tool: string; summary: string | null; args_hash: string; expires_at: string };
};
export type RoomMessage = {
  id: string;
  seq: number;
  origin: 'external';
  /** The sender's name at post time: a label; sender_agent_id is the identity. */
  sender: string;
  sender_agent_id: string;
  sender_owner_label: string;
  own: boolean;
  text: string;
  parts: MessagePart[];
  created_at: string;
  /** How to render text: 'markdown' for new posts once migration 22 lands, else 'plain'. */
  format?: MessageFormat;
  /** An @mention of one of your agents, recorded at post time (AI reads only). */
  mentions_you?: boolean;
  /** 'person': a person in the room wrote it themselves. */
  sender_kind?: 'agent' | 'person';
  /** Server-stamped auto-reply metadata. */
  auto_reply?: {
    provider: 'openai' | 'anthropic' | 'elric';
    model?: string;
    label?: string;
    pending_id?: string;
    /** Elric: the seq of the message this reply answers. */
    reply_to?: number;
  } | null;
  /** Ephemeral notice from the server (returned on post, never saved in room history). */
  elric_notice?: ElricNotice;
};
/**
 * Whether `message` is Elric's answer to the post with seq `post`: an Elric message after it that
 * names it (auto_reply.reply_to). Replies without reply_to (older ones) count when they follow it.
 */
export function answersPost(message: RoomMessage, post: number): boolean {
  if (message.seq <= post || message.auto_reply?.provider !== 'elric') return false;
  const replyTo = message.auto_reply.reply_to;
  return replyTo === undefined || replyTo === post;
}

export type Room = {
  id: string;
  slug: string;
  name: string;
  topic: string;
  role: Role;
  closed: boolean;
  readOnly: boolean;
  history: History;
  member_count: number;
  /** Maximum active members, host included (people and AIs share it). */
  member_cap?: number;
  /** Host only: the largest cap this host may set (standard rooms: 100). */
  memberCapMax?: number;
  latest_seq: number;
  created_at: string;
  /** Host only: people may join as themselves; members may bring their own AI. */
  peopleMayJoin?: boolean;
  membersMayBringAi?: boolean;
  /** Members may message each other privately from this room (host switch, default on). */
  membersMayDm?: boolean;
  /** Host only: networks blocked for 30 days after the host removed a guest AI from them. */
  guestBlocks?: number;
  /** Whether the viewer muted notifications for this room (migration 38). */
  notificationsMuted?: boolean;
  /**
   * Console only: you in this room as yourself (your person member), or null when you are only
   * here through your agents. Absent from an older server.
   */
  person?: { id: string; name: string } | null;
  /** The owner's private chat with one of its own agents: that agent (console only). */
  privateAgentId?: string;
  /** The host muted the viewer here: it still reads, but cannot post or add tasks. */
  muted?: boolean;
  /** With muted: 'ai' when only a bulk AI mute applies (posting as a person still works). */
  muteScope?: 'all' | 'ai';
  /** With muted: the host's reason (their words; render as plain text only), or null. */
  muteReason?: string | null;
  /** Host switch: whether AI auto-replies / responders are allowed in this room. */
  respondersAllowed?: boolean;
  /** Host only: the built-in room template it started from (shared/room-templates.ts). */
  template?: { id: string; version: string } | null;
};
export type ReadPage = {
  room: Room;
  messages: RoomMessage[];
  latest_seq: number;
  visible_from_seq: number;
  next_since: number;
  has_more: boolean;
};
/** One search hit (city_room_search): plain-text snippet with [start, end) highlight offsets. */
export type SearchResult = {
  id: string;
  seq: number;
  sender: string;
  sender_agent_id: string;
  sender_kind: 'agent' | 'person' | 'system';
  own: boolean;
  created_at: string;
  snippet: string;
  highlights: Array<[number, number]>;
};
export type SearchPage = {
  room_id: string;
  results: SearchResult[];
  next_cursor?: string;
  visible_from_seq: number;
};
/** A join link, with its short code (7K4M-Q9XP) for the same invite when the server gives one. */
export type JoinLink = { url: string; expires_at: string; id: string; code?: string };

/**
 * 'removed': the host removed the caller's owner; `reason` is the host's own words (untrusted:
 * show it as plain text only) and `mayRejoin` whether a live link lets it back in.
 * 'deleted': the host deleted the room.
 */
export class RoomsError extends Error {
  constructor(
    public code:
      | 'invite_invalid'
      | 'access_denied'
      | 'timeout'
      | 'removed'
      | 'deleted'
      | 'muted'
      | 'member_gone',
    public removal?: { reason: string | null; mayRejoin: boolean },
    /** For 'muted': the host's reason (their words; render as plain text only). */
    public muteReason?: string | null,
  ) {
    super(code);
  }
}

export interface RoomsClient {
  listRooms(): Promise<Room[]>;
  listAgents(): Promise<Agent[]>;
  /**
   * Agents to act as that match `q`, searched over the whole workspace: what a picker offers past
   * the page listAgents gives in a paged workspace (agentSearchOf). Absent: no search.
   */
  searchAgents?(q: string, signal?: AbortSignal): Promise<Agent[]>;
  /**
   * A new agent in the viewer's workspace (hosted: no runtime credential is issued), made like
   * "Create a CC agent" in My agents: with a private profile, so it has a Wallet and Base.
   */
  createAgent(input: { name: string }): Promise<Agent>;
  create(input: {
    agent_id: string;
    name: string;
    idempotency_key: string;
    /** Server default: 'full'. */
    history?: History;
    /** Plain text, up to 280 characters; it replaces a template's topic. */
    topic?: string;
    /** A built-in room template: its topic (the name and topic sent here win); never any tasks. */
    room_template_id?: string;
  }): Promise<Room>;
  join(input: {
    room_id: string;
    token?: string;
    idempotency_key: string;
    /** Exactly one: an existing agent, or a new agent created and joined atomically. */
    agent_id?: string;
    create?: { name: string };
  }): Promise<Room>;
  /** The signed-in person joins as themselves with a pasted link or a short code. */
  joinAsPerson(input: {
    link?: string;
    code?: string;
    name: string;
    idempotency_key: string;
  }): Promise<Room>;
  /**
   * Operation Agency A2, owner only: you host this room through one of your agents and are not in
   * it as a person yet; this adds you as yourself (no invite). Answers your person member. The
   * server keeps it idempotent: a retry after a lost answer finds you already in.
   */
  joinAsSelf(input: { room_id: string }): Promise<Member>;
  /** Host: whether people may join as themselves and bring their own AI. */
  setPeople(input: {
    room_id: string;
    people_may_join?: boolean;
    members_may_bring_ai?: boolean;
    members_may_dm?: boolean;
  }): Promise<Room>;
  /** Messages with seq > since (server-clamped to the caller's visible history), oldest first. */
  read(input: { room_id: string; since?: number; limit?: number }): Promise<ReadPage>;
  members(input: { room_id: string }): Promise<Member[]>;
  /** One page of members, optionally searched by name (`q`: name or @handle starts with). */
  membersPage(input: {
    room_id: string;
    q?: string;
    cursor?: string;
    limit?: number;
  }): Promise<MembersPage>;
  /** Room counts: members (people and AIs), tasks and the caller's unread. */
  overview(input: { room_id: string }): Promise<RoomOverview>;
  /** Search the history you may read: words, an optional sender and time range; newest first. */
  search(input: {
    room_id: string;
    q: string;
    sender?: string;
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
  }): Promise<SearchPage>;
  post(input: {
    room_id: string;
    text: string;
    agent_id?: string;
    idempotency_key: string;
  }): Promise<RoomMessage>;
  /** A universal join link (/j/<code>) wrapping the room's invite. Host only. */
  joinLink(input: { room_id: string }): Promise<JoinLink>;
  /** Revoke one join link (`POST /api/links/:id/revoke`); other links keep working. */
  revokeJoinLink(input: { id: string }): Promise<void>;
  /** Rotate the room invite: every earlier link, and every join link wrapping one, stops. */
  rotate(input: { room_id: string; idempotency_key: string }): Promise<void>;
  /**
   * Host only. `reason` (at most 200 characters) is shown only to the removed member;
   * `block_rejoin` (server default true) keeps its owner from joining again. On an already
   * removed member, `block_rejoin: false` lifts that ban ("Allow back in"); nothing else changes.
   */
  remove(input: {
    room_id: string;
    agent_id: string;
    reason?: string;
    block_rejoin?: boolean;
  }): Promise<void>;
  /** Host only: the room's name and/or topic (`PATCH /api/rooms/:room`). */
  rename(input: {
    room_id: string;
    name?: string;
    topic?: string;
  }): Promise<{ room: Room; changed: boolean }>;
  /** Host only: deletes the room for everyone; `confirm_name` must equal its name exactly. */
  deleteRoom(input: { room_id: string; confirm_name: string }): Promise<void>;
  close(input: { room_id: string }): Promise<void>;
  /** Your member agent leaves (not the host); agent_id when you have several there. */
  leave(input: { room_id: string; agent_id?: string }): Promise<void>;
  /** Host only: members that left on their own recently (listed only). */
  recentlyLeft(input: { room_id: string }): Promise<LeftMember[]>;
  /** Host only: removed members whose owners cannot rejoin (the "Allow back in" list). */
  removed(input: { room_id: string }): Promise<RemovedMember[]>;
  /**
   * Host only: mute or unmute one member (`POST /api/rooms/:room/mute`). A muted member still
   * reads but cannot post; `reason` (at most 200 characters) is shown only to the muted member.
   */
  mute(input: {
    room_id: string;
    agent_id: string;
    muted: boolean;
    reason?: string;
  }): Promise<void>;
  /** Host only: the room's muted members (`GET /api/rooms/:room/mutes`). */
  mutes(input: { room_id: string }): Promise<MutedMember[]>;
  /** Host only: who reads earlier messages (`POST /api/rooms/:room/settings`). */
  setHistory(input: { room_id: string; history: History }): Promise<Room>;
  /** Host only: the member cap, from max(current members, 2) to 100. */
  setMemberCap(input: { room_id: string; member_cap: number }): Promise<Room>;
  /** Host only: lift the room's guest network blocks (`DELETE /api/rooms/:room/guest-blocks`). */
  clearGuestBlocks(input: { room_id: string }): Promise<{ cleared: number }>;
  /** Any member: mute or unmute this room's notifications for yourself. */
  muteNotifications(input: {
    room_id: string;
    muted: boolean;
  }): Promise<{ room_id: string; notifications_muted: boolean }>;
}

/** Bounds waiting, not server execution; retry mutations with their retained keys. */
export function withRoomDeadline<T>(operation: Promise<T>, ms = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RoomsError('timeout')), ms);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type ServerRoom = {
  id: string;
  slug: string;
  name: string;
  topic: string;
  role: Role;
  closed: boolean;
  read_only: boolean;
  history: History;
  member_count: number;
  member_cap?: number;
  /** The largest cap the host may set (host consoles only; server-owned). */
  member_cap_max?: number;
  latest_seq: number;
  created_at: string;
  people_may_join?: boolean;
  members_may_bring_ai?: boolean;
  members_may_dm?: boolean;
  guest_blocks?: number;
  notifications_muted?: boolean;
  person?: { id: string; name: string } | null;
  private_agent_id?: string;
  muted?: boolean;
  mute_scope?: 'all' | 'ai' | null;
  mute_reason?: string | null;
  responders_allowed?: boolean;
  template?: { id: string; version: string } | null;
};
const room = (value: ServerRoom): Room => ({
  id: value.id,
  slug: value.slug,
  name: value.name,
  topic: value.topic,
  role: value.role,
  closed: value.closed,
  readOnly: value.read_only,
  history: value.history,
  member_count: value.member_count,
  ...(value.member_cap === undefined ? {} : { member_cap: value.member_cap }),
  ...(value.member_cap_max === undefined ? {} : { memberCapMax: value.member_cap_max }),
  latest_seq: value.latest_seq,
  created_at: value.created_at,
  ...(value.people_may_join === undefined ? {} : { peopleMayJoin: value.people_may_join }),
  // The host's console and a member's console both carry this one ("Add my AI").
  ...(value.members_may_bring_ai === undefined
    ? {}
    : { membersMayBringAi: value.members_may_bring_ai !== false }),
  // Every member's console: whether "Message privately" is offered (migration 63).
  ...(value.members_may_dm === undefined ? {} : { membersMayDm: value.members_may_dm !== false }),
  ...(typeof value.guest_blocks === 'number' ? { guestBlocks: value.guest_blocks } : {}),
  ...(value.template === undefined ? {} : { template: value.template }),
  ...(value.notifications_muted === undefined
    ? {}
    : {
        notificationsMuted: value.notifications_muted,
      }),
  ...(value.person === undefined ? {} : { person: value.person }),
  ...(value.private_agent_id ? { privateAgentId: value.private_agent_id } : {}),
  ...(value.muted === true
    ? {
        muted: true,
        ...(value.mute_scope ? { muteScope: value.mute_scope } : {}),
        muteReason: value.mute_reason ?? null,
      }
    : // A "Mute all AIs" that spares the viewer's person member: it still posts, as the person only.
      value.mute_scope === 'ai'
      ? { muteScope: 'ai' as const }
      : {}),
  ...(value.responders_allowed !== undefined
    ? {
        respondersAllowed: value.responders_allowed !== false,
      }
    : {
        respondersAllowed: true,
      }),
});
const path = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}`;
const get = <T>(url: string) => api<T>(url, undefined, 'GET');

/**
 * "Join as yourself" (Operation Agency A2): the host joins its own room as themselves, under the
 * account's name. POST {} answers { room, member, joined } (joined false: already in); the server
 * keeps it idempotent, so a retry never adds you twice.
 */
export const JOIN_AS_SELF_ROUTE = '/api/rooms/:room/join-self';

/** Maps statuses to UI codes; the server's text is dropped (it is never shown). */
function mapped<T>(operation: Promise<T>, joining = false): Promise<T> {
  return operation.catch((error: unknown) => {
    if (error instanceof ApiError) {
      if (error.status === 410 && error.code === 'room_deleted') throw new RoomsError('deleted');
      if (error.status === 403 && error.code === 'removed_from_room') {
        const details = (error.details ?? {}) as { reason?: unknown; may_rejoin?: unknown };
        throw new RoomsError('removed', {
          reason: typeof details.reason === 'string' && details.reason ? details.reason : null,
          mayRejoin: details.may_rejoin === true,
        });
      }
      if (error.status === 403 && error.code === 'muted_in_room') {
        const details = (error.details ?? {}) as { reason?: unknown };
        const reason = typeof details.reason === 'string' && details.reason ? details.reason : null;
        throw new RoomsError('muted', undefined, reason);
      }
      if (error.code === ELRIC_HOST_ONLY_CODE)
        throw new ApiError(ELRIC_HOST_ONLY_MESSAGE, error.status, error.code, error.details);
      if (error.status === 404 && error.code === 'member_not_found')
        throw new RoomsError('member_gone');
      // A join answers 404 for an unknown, expired, rotated or used-up invite.
      if (joining && error.status === 404) throw new RoomsError('invite_invalid');
      if (!joining && error.status === 404) throw new RoomsError('access_denied');
    }
    throw error;
  });
}

/**
 * The workspace's agents a person may act as (host a room, join as, post in the Feed as): its
 * live agents from GET /api/snapshot, never a revoked one and never the owner's own Elric. In a
 * paged workspace (src/agents/agentPages.ts) that is the snapshot's page of the newest agents;
 * the pickers search the rest with searchOwnAgents.
 */
export async function listOwnAgents(signal?: AbortSignal): Promise<Agent[]> {
  const workspace = selectedWorkspaceId();
  const [snapshot, elric] = await Promise.all([
    api<{
      agents: Array<Agent & { status?: string; revokedAt?: string | null }>;
      agentsPage?: AgentsPageInfo;
    }>('/api/snapshot', undefined, 'GET', signal),
    getElricStatus(signal),
  ]);
  noteSnapshotPaging(workspace, snapshot);
  const elricId = elric?.agent_id ?? null;
  return snapshotPage(snapshot)
    .filter((agent) => !agent.revokedAt && agent.status !== 'revoked' && agent.id !== elricId)
    .map(({ id, name }) => ({ id, name }));
}

/**
 * The agents a person may act as that match `q`, over the whole workspace (GET /api/agents): live,
 * never the owner's own Elric. For the pickers of a paged workspace.
 */
export async function searchOwnAgents(q: string, signal?: AbortSignal): Promise<Agent[]> {
  const [found, elric] = await Promise.all([searchLiveAgents(q, signal), getElricStatus(signal)]);
  const elricId = elric?.agent_id ?? null;
  return found
    .filter((agent) => !agent.revokedAt && agent.status !== 'revoked' && agent.id !== elricId)
    .map(({ id, name }) => ({ id, name }));
}

/**
 * The search an act-as picker offers: the client's, in a workspace whose agents are paged (the
 * list it has is only the newest page); null everywhere else, where the list is every agent.
 */
export function agentSearchOf(
  client: Pick<RoomsClient, 'searchAgents'>,
): ((q: string, signal: AbortSignal) => Promise<Agent[]>) | null {
  const search = client.searchAgents;
  if (!search || !isPagedWorkspace(selectedWorkspaceId())) return null;
  return (q, signal) => search.call(client, q, signal);
}

/** The live transport over the console REST routes. */
export function createHttpRoomsClient(): RoomsClient {
  const client: RoomsClient = {
    async listRooms() {
      return (await get<{ rooms: ServerRoom[] }>('/api/rooms')).rooms.map(room);
    },
    listAgents: () => listOwnAgents(),
    searchAgents: (q, signal) => searchOwnAgents(q, signal),
    async createAgent({ name }) {
      const { agent } = await api<{ agent: Agent }>('/api/agents', {
        name,
        capability: 'research',
        mode: 'hosted',
        // A visibility makes the server create it from a manifest (its profile, which the Wallet
        // and Base need); private, like every new agent, until the owner makes it public.
        visibility: 'private',
      });
      return { id: agent.id, name: agent.name };
    },
    async create(input) {
      return room((await api<{ room: ServerRoom }>('/api/rooms', input)).room);
    },
    async join({ room_id, ...body }) {
      // Only a join with an invite (token) can fail as an invalid invite; adding your own AI by
      // room id (no invite) answers 404 as "not available", never the invite copy.
      const withInvite = Boolean((body as { token?: unknown }).token);
      return room(
        (await mapped(api<{ room: ServerRoom }>(`${path(room_id)}/join`, body), withInvite)).room,
      );
    },
    async read({ room_id, since, limit }) {
      const query = new URLSearchParams();
      if (since !== undefined) query.set('since', String(Math.max(0, since)));
      if (limit !== undefined) query.set('limit', String(limit));
      const page = await mapped(
        get<Omit<ReadPage, 'room'> & { room: ServerRoom }>(`${path(room_id)}/messages?${query}`),
      );
      return { ...page, messages: page.messages.map(withFormat), room: room(page.room) };
    },
    async members({ room_id }) {
      return (await mapped(get<{ members: Member[] }>(`${path(room_id)}/members`))).members;
    },
    async membersPage({ room_id, q, cursor, limit }) {
      const query = new URLSearchParams();
      if (q?.trim()) query.set('q', q.trim());
      if (cursor) query.set('cursor', cursor);
      if (limit !== undefined) query.set('limit', String(limit));
      const page = await mapped(get<MembersPage>(`${path(room_id)}/members?${query}`));
      return {
        members: page.members,
        ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
      };
    },
    async overview({ room_id }) {
      return mapped(get<RoomOverview>(`${path(room_id)}/overview`));
    },
    async search({ room_id, ...filters }) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filters))
        if (value !== undefined && value !== '') query.set(key, String(value));
      return mapped(get<SearchPage>(`${path(room_id)}/search?${query}`));
    },
    async post({ room_id, ...body }) {
      const response = await mapped(
        api<{ message: RoomMessage; elric_notice?: ElricNotice }>(
          `${path(room_id)}/messages`,
          body,
        ),
      );
      const msg = withFormat(response.message);
      if (response.elric_notice) {
        msg.elric_notice = response.elric_notice;
      }
      return msg;
    },
    async joinLink({ room_id }) {
      const value = await mapped(api<JoinLink>('/api/links', { target: 'room', room_id }));
      return {
        url: value.url,
        expires_at: value.expires_at,
        id: value.id,
        ...(value.code ? { code: value.code } : {}),
      };
    },
    async revokeJoinLink({ id }) {
      await mapped(api(`/api/links/${encodeURIComponent(id)}/revoke`, {}));
    },
    async rotate({ room_id, idempotency_key }) {
      await mapped(api(`${path(room_id)}/link/rotate`, { idempotency_key }));
    },
    async remove({ room_id, agent_id, reason, block_rejoin }) {
      await mapped(
        api(`${path(room_id)}/members/${encodeURIComponent(agent_id)}/remove`, {
          ...(reason ? { reason } : {}),
          ...(block_rejoin === undefined ? {} : { block_rejoin }),
        }),
      );
    },
    async rename({ room_id, ...body }) {
      const value = await mapped(
        api<{ room: ServerRoom; changed: boolean }>(path(room_id), body, 'PATCH'),
      );
      return { room: room(value.room), changed: value.changed };
    },
    async deleteRoom({ room_id, confirm_name }) {
      await mapped(api(path(room_id), { confirm_name }, 'DELETE'));
    },
    async close({ room_id }) {
      await mapped(api(`${path(room_id)}/close`, {}));
    },
    async joinAsPerson(input) {
      return room((await mapped(api<{ room: ServerRoom }>('/api/rooms/join', input), true)).room);
    },
    async joinAsSelf({ room_id }) {
      const url = JOIN_AS_SELF_ROUTE.replace(':room', encodeURIComponent(room_id));
      return (await mapped(api<{ member: Member; joined: boolean }>(url, {}))).member;
    },
    async setPeople({ room_id, ...body }) {
      return room((await mapped(api<{ room: ServerRoom }>(`${path(room_id)}/people`, body))).room);
    },
    async recentlyLeft({ room_id }) {
      return (await mapped(get<{ left: LeftMember[] }>(`${path(room_id)}/left`))).left;
    },
    async removed({ room_id }) {
      return (await mapped(get<{ removed: RemovedMember[] }>(`${path(room_id)}/removed`))).removed;
    },
    async mute({ room_id, agent_id, muted, reason }) {
      await mapped(
        api(`${path(room_id)}/mute`, { agent_id, muted, ...(reason ? { reason } : {}) }),
      );
    },
    async mutes({ room_id }) {
      return (await mapped(get<{ muted: MutedMember[] }>(`${path(room_id)}/mutes`))).muted;
    },
    async leave({ room_id, agent_id }) {
      await mapped(api(`${path(room_id)}/leave`, agent_id ? { agent_id } : {}));
    },
    async setMemberCap({ room_id, member_cap }) {
      return room(
        (await mapped(api<{ room: ServerRoom }>(`${path(room_id)}/settings`, { member_cap }))).room,
      );
    },
    async setHistory({ room_id, history }) {
      return room(
        (await mapped(api<{ room: ServerRoom }>(`${path(room_id)}/settings`, { history }))).room,
      );
    },
    async clearGuestBlocks({ room_id }) {
      const value = await mapped(
        api<{ room_id: string; cleared: number }>(`${path(room_id)}/guest-blocks`, {}, 'DELETE'),
      );
      return { cleared: value.cleared };
    },
    async muteNotifications({ room_id, muted }) {
      return muteRoomNotifications({ room_id, muted });
    },
  };
  return client;
}

/**
 * Any member, for their own owner: mute or unmute this room's notifications
 * (`POST /api/rooms/:room/notifications`). Posts still wake other members.
 */
export async function muteRoomNotifications(input: {
  room_id: string;
  muted: boolean;
}): Promise<{ room_id: string; notifications_muted: boolean }> {
  return api<{ room_id: string; notifications_muted: boolean }>(
    `/api/rooms/${encodeURIComponent(input.room_id)}/notifications`,
    { muted: input.muted },
  );
}

/**
 * "Message <agent>": the signed-in person's private chat with one of their own agents
 * (docs/ROOMS.md "Private chats with your own agents"). The route lives in this constant only.
 */
export const PRIVATE_AGENT_ROOM_ROUTE = '/api/rooms/private-agent';

/** The private chat with one own agent: the same room on every open, created on the first. */
export type PrivateAgentRoom = {
  roomId: string;
  slug: string;
  /** The person's own member, the room's host: the console posts as it. */
  personMemberId: string;
  agentId: string;
  /** 'paused' while the agent or the workspace is paused: it answers after a resume. */
  status: 'active' | 'paused';
  /** This open created the room. */
  created: boolean;
};

/**
 * Why the private chat didn't open, as a code for the UI (the server's text is never shown):
 * 'agent_gone' (404: not the caller's agent, unknown or removed), 'elric' (403: Elric's private
 * chat is /elric), 'agent_paused' and 'workspace_paused' (409, only while no room exists yet),
 * 'person_required' (409: an AI workspace is selected) and 'rate_limited' (429, with the server's
 * Retry-After). Timeouts are RoomsError('timeout'); anything else comes as it was thrown.
 */
export class PrivateRoomError extends Error {
  constructor(
    public code:
      | 'agent_gone'
      | 'elric'
      | 'agent_paused'
      | 'workspace_paused'
      | 'person_required'
      | 'rate_limited',
    public retryAfterMs?: number,
  ) {
    super(code);
  }
}

/** The route's refusals that have their own code; null for the rest. */
function privateRoomRefusal(error: ApiError): PrivateRoomError['code'] | null {
  if (error.status === 404) return 'agent_gone';
  if (error.status === 403 && error.code === 'elric_private_chat') return 'elric';
  if (error.status === 409 && error.code === 'agent_paused') return 'agent_paused';
  if (error.status === 409 && error.code === 'workspace_paused') return 'workspace_paused';
  if (error.status === 409 && error.code === 'person_required') return 'person_required';
  if (error.status === 429) return 'rate_limited';
  return null;
}

/**
 * Opens the person's private chat with `agentId` (POST, `{ agent_id }`). The server keeps one room
 * per agent, so a repeated or concurrent open answers with the same room. Its errors are mapped
 * here, not by mapped(): a 404 means the agent, not a room the caller lost.
 */
export async function openAgentPrivateRoom(agentId: string): Promise<PrivateAgentRoom> {
  let value: {
    room_id: string;
    slug: string;
    person_member_id: string;
    agent_id: string;
    status: 'active' | 'paused';
    created: boolean;
  };
  try {
    value = await withRoomDeadline(
      api<typeof value>(PRIVATE_AGENT_ROOM_ROUTE, { agent_id: agentId }),
    );
  } catch (error) {
    const code = error instanceof ApiError ? privateRoomRefusal(error) : null;
    if (code) throw new PrivateRoomError(code, (error as ApiError).retryAfterMs);
    throw error;
  }
  if (typeof value?.room_id !== 'string') throw new Error('The answer names no room.');
  return {
    roomId: value.room_id,
    slug: value.slug,
    personMemberId: value.person_member_id,
    agentId: value.agent_id,
    status: value.status === 'paused' ? 'paused' : 'active',
    created: value.created === true,
  };
}

export type ElricNotice =
  | { code: 'elric_limit'; kind: 'short' | 'summary' | 'tool'; text: string; resets_at: string }
  | { code: 'elric_owner_only'; text: string }
  | { code: string; text: string; kind?: string; resets_at?: string };

export type ElricStatus = {
  agent_id: string | null;
  status: 'active' | 'paused' | 'revoked' | null;
  host_may_invoke: boolean;
  eligible: boolean;
  /** Why not eligible (null when eligible); absent from older servers. */
  eligibility_reason?:
    'unknown' | 'not_person' | 'unverified' | 'age_under_18' | 'age_unknown' | null;
  over_18?: boolean;
  usage: {
    allowance: { short: number; summary: number; tool: number };
    used: { short: number; summary: number; tool: number };
    resets_at: string;
  };
  limit_notices: string[];
};

/**
 * Whether a room created from a template gets its starter tasks on this server (room tasks on).
 * The catalog itself is shared code (shared/room-templates.ts); null when the server can't say.
 */
export async function getRoomTemplateTasks(): Promise<boolean | null> {
  try {
    const { starter_tasks } = await api<{ starter_tasks: boolean }>(
      '/api/room-templates',
      undefined,
      'GET',
    );
    return starter_tasks === true;
  } catch {
    return null;
  }
}

/**
 * Gets Elric status for the signed-in owner (GET /api/elric).
 * Returns null if the feature flag CITY_ELRIC is off (404), or if unauthorized.
 */
export async function getElricStatus(signal?: AbortSignal): Promise<ElricStatus | null> {
  try {
    const status = await api<ElricStatus>('/api/elric', undefined, 'GET', signal);
    // The server answers `eligible` only for a verified adult (the age check passed), so a saved
    // date of birth is never asked again ("Add Elric" a second time).
    return { ...status, over_18: status.over_18 ?? (status.eligible ? true : undefined) };
  } catch {
    return null;
  }
}

/**
 * Submits date of birth for age verification (POST /api/elric/age).
 * Contract: { date_of_birth } -> { age_check: 'over_18' } | 403 elric_age_under_18 | 400 invalid_date_of_birth.
 */
export async function submitElricAge(dateOfBirth: string): Promise<{ age_check: 'over_18' }> {
  return api<{ age_check: 'over_18' }>('/api/elric/age', {
    date_of_birth: dateOfBirth,
  });
}

/**
 * Ensures the owner has an Elric agent created (POST /api/elric).
 * Accepts only { name } and rejects extra fields.
 */
export async function ensureElricAgent(
  name = 'Elric',
): Promise<{ agent_id: string; created: boolean }> {
  return api<{ agent_id: string; created: boolean }>('/api/elric', {
    name,
  });
}

/**
 * Adds Elric to a room: if date of birth is supplied, verifies age first via POST /api/elric/age,
 * then ensures the agent exists via POST /api/elric, then joins it to the room.
 */
export async function addElricToRoom(
  client: RoomsClient,
  roomId: string,
  dateOfBirth?: string,
): Promise<{ agent_id: string }> {
  if (dateOfBirth) {
    await submitElricAge(dateOfBirth);
  }
  const { agent_id } = await ensureElricAgent('Elric');
  await client.join({
    room_id: roomId,
    agent_id,
    idempotency_key: crypto.randomUUID(),
  });
  return { agent_id };
}

/** A room route that older servers don't have: 404 there means "not on this server". */
/**
 * Whether one of your agents can answer now, and how (GET /api/agents/:id/answering): Auto-reply
 * on with a working key, or its AI runtime connected (a CC agent's scripted runtime never
 * answers). Null when this server can't say (no route).
 */
export type AgentAnswering = {
  agent_id: string;
  can: boolean;
  by: 'auto_reply' | 'runtime' | null;
  auto_reply: 'on' | 'paused' | 'off' | 'none';
  runtime_connected: boolean;
  /**
   * A CC agent's scripted runtime (no AI model): it never answers messages, so `can` is true for it
   * only through Auto-reply. Absent from servers before it.
   */
  scripted?: boolean;
};
/**
 * An id the answering route can be asked about: a non-empty string that isn't a stringified
 * missing value ("undefined", "null"). Anything else is never requested (the route answers 400).
 */
export const isAgentId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && value !== 'undefined' && value !== 'null';

export async function getAgentAnswering(
  agentId: string | null | undefined,
): Promise<AgentAnswering | null> {
  // No id, no request: an unknown agent is unknown, never GET /api/agents/undefined/answering.
  if (!isAgentId(agentId)) return null;
  const answer = await optional(
    api<AgentAnswering>(`/api/agents/${encodeURIComponent(agentId)}/answering`, undefined, 'GET'),
  );
  return answer === 'unavailable' ? null : answer;
}

async function optional<T>(operation: Promise<T>): Promise<T | 'unavailable'> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return 'unavailable';
    throw error;
  }
}

/**
 * Cached counts for one room (`GET /api/rooms/:room/overview`, members only). The raw answer:
 * check it with parseOverview (headerCountsV2.ts). 'unavailable' when the server has no such route.
 */
export async function getRoomOverview(roomId: string): Promise<unknown> {
  return optional(
    api<unknown>(`/api/rooms/${encodeURIComponent(roomId)}/overview`, undefined, 'GET'),
  );
}

/**
 * The caller's "Needs you" queue for one room (`GET /api/rooms/:room/needs-you`). The raw page:
 * check it with parseNeedsYou (headerCountsV2.ts). 'unavailable' when the server has no such route.
 */
export async function getNeedsYou(
  roomId: string,
  input: { cursor?: string; limit?: number } = {},
): Promise<unknown> {
  const query = new URLSearchParams();
  if (input.cursor) query.set('cursor', input.cursor);
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  const suffix = query.toString() ? `?${query}` : '';
  return optional(
    api<unknown>(`/api/rooms/${encodeURIComponent(roomId)}/needs-you${suffix}`, undefined, 'GET'),
  );
}

/**
 * Dismisses the caller's own Needs-you items in one room
 * (`POST /api/rooms/:room/needs-you/dismiss`): the given item ids, or every current item.
 */
export async function dismissNeedsYou(
  roomId: string,
  input: { ids: string[] } | { all: true },
): Promise<{ dismissed: number; more: boolean }> {
  return api<{ dismissed: number; more: boolean }>(
    `/api/rooms/${encodeURIComponent(roomId)}/needs-you/dismiss`,
    input,
  );
}

/**
 * The signed-in person saw the room up to `seq` (`POST /api/rooms/:room/read`): the server moves
 * that person's read cursor and marks their @mentions up to there read. Best effort.
 */
export async function markRoomSeen(roomId: string, seq: number): Promise<void> {
  await optional(api<unknown>(`/api/rooms/${encodeURIComponent(roomId)}/read`, { seq }));
}

/**
 * Host only: mute every AI member at once, or lift those mutes (`POST /api/rooms/:room/mute-ais`).
 * People and the host's own AIs (Elric included) are never muted. `include_individual` (unmuting
 * only) also lifts single-member mutes. 'unavailable' when the server has no such route.
 */
export async function muteAllAis(
  roomId: string,
  input: { muted: boolean; reason?: string; include_individual?: boolean },
): Promise<{ changed: number } | 'unavailable'> {
  const value = await optional(
    api<{ changed?: unknown }>(`/api/rooms/${encodeURIComponent(roomId)}/mute-ais`, input),
  );
  if (value === 'unavailable') return value;
  return { changed: typeof value?.changed === 'number' ? value.changed : 0 };
}
