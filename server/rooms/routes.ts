import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../shared/types.js';
import {
  MEMBERS_CURSOR,
  MEMBERS_QUERY_MAX,
  NEEDS_YOU_CURSOR,
  NEEDS_YOU_PAGE_MAX,
  ROOM_LIMITS,
  SEARCH_CURSOR,
  roomRefSchema,
  roomRemoveBody,
} from './contract.js';
import { clientAddressKey } from '../rate-limit.js';
import type { RoomPrincipal, Rooms } from './service.js';

export interface RoomRouteDependencies {
  rooms: Rooms;
  /** The workspace the console request acts in (own or co-owned AI workspace). */
  owner(request: FastifyRequest): Promise<Operator>;
  originOf(request: FastifyRequest): string;
  /** The shared request limiter (429 when spent); absent in tests that build routes alone. */
  limit?(key: string, max: number, windowMs: number): Promise<void>;
}

/** Console writes on the caller's own room state, per account per minute. */
export const ROOM_CONSOLE_LIMITS = {
  /** "Needs you" dismissals (one per click, "Dismiss", "Dismiss all"). */
  dismissPerMinute: 60,
  /** Read marks (the console sends one when the newest seen message changes). */
  readsPerMinute: 120,
} as const;

/**
 * Owner console REST for rooms (docs/ROOMS.md): the same operations and authorization as the MCP
 * tools, with a console session (the owner acts with full authority). Room text is untrusted.
 */
export function registerRoomRoutes(app: FastifyInstance, d: RoomRouteDependencies): void {
  const principal = async (request: FastifyRequest): Promise<RoomPrincipal> => ({
    operatorId: (await d.owner(request)).id,
    actor: 'the owner',
    origin: d.originOf(request),
    console: true,
    address: clientAddressKey(request.ip),
  });
  const roomParams = z.object({ room: roomRefSchema }).strict();
  const memberParams = z.object({ room: roomRefSchema, agentId: z.string().uuid() }).strict();
  const body = (request: FastifyRequest) =>
    z.record(z.string(), z.unknown()).parse(request.body ?? {});
  const seq = z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number);

  app.get('/api/rooms', async (request) => d.rooms.list(await principal(request)));
  // The built-in room templates (shared/room-templates.ts): the same for every signed-in owner.
  app.get('/api/room-templates', async (request) =>
    d.rooms.templates(await principal(request), {}),
  );
  app.post('/api/rooms', async (request, reply) =>
    reply.code(201).send(await d.rooms.create(await principal(request), request.body)),
  );
  // The signed-in person joins as themselves with a link or a short code ("Join a room").
  app.post('/api/rooms/join', async (request) => {
    const p = await principal(request);
    return d.rooms.joinPerson(p, request.body ?? {});
  });
  // "Message <agent>": the signed-in person's private chat with one of their own agents
  // ({ agent_id }); the same room every time, created on the first call (rooms/private.ts).
  app.post('/api/rooms/private-agent', async (request) => {
    const p = await principal(request);
    return d.rooms.privateChat(p, request.body ?? {});
  });
  // The host joins its own room as themselves, without an invite ("Join as yourself"):
  // {name?} → {room, member, joined}. Idempotent; anyone else gets 404 (docs/ROOMS.md).
  app.post('/api/rooms/:room/join-self', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.joinSelf(p, room, request.body ?? {});
  });
  // Host: whether people may join as themselves and bring their own AI (migration 31).
  app.post('/api/rooms/:room/people', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.peopleSettings(p, room, request.body ?? {});
  });
  app.post('/api/rooms/:room/join', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.join(p, { ...body(request), room_id: room });
  });
  app.get('/api/rooms/:room/messages', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    const query = z
      .object({
        since: seq.optional(),
        limit: seq.pipe(z.number().int().min(1).max(ROOM_LIMITS.pageSize)).optional(),
      })
      .strict()
      .parse(request.query);
    return d.rooms.read(p, { room_id: room, ...query });
  });
  // Search inside the room (members only, the history they may read): ?q=&sender=&from=&to=
  // &limit=&cursor=; newest first, next_cursor while more follow.
  app.get('/api/rooms/:room/search', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    const query = z
      .object({
        q: z.string().max(ROOM_LIMITS.searchQueryMax * 4),
        sender: z.string().max(64).optional(),
        from: z.string().max(40).optional(),
        to: z.string().max(40).optional(),
        limit: seq.pipe(z.number().int().min(1).max(ROOM_LIMITS.searchPageSize)).optional(),
        cursor: z.string().regex(SEARCH_CURSOR).optional(),
      })
      .strict()
      .parse(request.query ?? {});
    // Empty filters from a form mean "no filter".
    const values = Object.fromEntries(
      Object.entries(query).filter(([, value]) => value !== undefined && value !== ''),
    );
    return d.rooms.search(p, { ...values, q: query.q, room_id: room });
  });
  app.post('/api/rooms/:room/messages', async (request, reply) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return reply.code(201).send(await d.rooms.post(p, { ...body(request), room_id: room }));
  });
  app.get('/api/rooms/:room/members', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    // Paginated (docs/ROOMS.md): ?cursor=<next_cursor>&limit=<1..1000>; without them, the first page.
    // ?q= searches names ("starts with", case-insensitive, NFKC); an empty q lists everyone.
    const query = z
      .object({
        cursor: z.string().regex(MEMBERS_CURSOR).optional(),
        limit: seq.pipe(z.number().int().min(1).max(ROOM_LIMITS.membersPageSize)).optional(),
        q: z.string().max(MEMBERS_QUERY_MAX).optional(),
      })
      .strict()
      .parse(request.query ?? {});
    const { q, ...page } = query;
    return d.rooms.members(p, { room_id: room, ...page, ...(q?.trim() ? { q } : {}) });
  });
  // Room overview (members only): counts, active AIs, task counts and the caller's unread.
  app.get('/api/rooms/:room/overview', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    z.object({})
      .strict()
      .parse(request.query ?? {});
    return d.rooms.overview(p, { room_id: room });
  });
  // The caller's "Needs you" queue in the room: ?cursor=<next_cursor>&limit=<1..50>.
  app.get('/api/rooms/:room/needs-you', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    const query = z
      .object({
        cursor: z.string().regex(NEEDS_YOU_CURSOR).optional(),
        limit: seq.pipe(z.number().int().min(1).max(NEEDS_YOU_PAGE_MAX)).optional(),
      })
      .strict()
      .parse(request.query ?? {});
    return d.rooms.needsYou(p, { room_id: room, ...query });
  });
  // Dismiss the caller's own Needs-you items: { ids: string[] } (1-100) or { all: true }.
  app.post('/api/rooms/:room/needs-you/dismiss', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    await d.limit?.(`room-needs-you:${p.operatorId}`, ROOM_CONSOLE_LIMITS.dismissPerMinute, 60_000);
    return d.rooms.dismissNeedsYou(p, { ...body(request), room_id: room });
  });
  // The person saw the room up to { seq }: their read cursor and @mentions follow (person row only).
  app.post('/api/rooms/:room/read', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    await d.limit?.(`room-read:${p.operatorId}`, ROOM_CONSOLE_LIMITS.readsPerMinute, 60_000);
    return d.rooms.personRead(p, { ...body(request), room_id: room });
  });
  app.post('/api/rooms/:room/link', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.link(p, { room_id: room });
  });
  app.post('/api/rooms/:room/link/rotate', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    const { idempotency_key } = z
      .object({ idempotency_key: z.string().min(8).max(128) })
      .strict()
      .parse(request.body);
    return d.rooms.link(p, { room_id: room, rotate: true, idempotency_key });
  });
  app.post('/api/rooms/:room/members/:agentId/remove', async (request) => {
    const p = await principal(request);
    const { room, agentId } = memberParams.parse(request.params);
    // Optional { reason (<= 200 characters, shown only to the removed member), block_rejoin }.
    const extra = roomRemoveBody.parse(request.body ?? {});
    return d.rooms.remove(p, { ...extra, room_id: room, agent_id: agentId });
  });
  // Host: rename the room and/or change its topic ({ name?, topic? }).
  app.patch('/api/rooms/:room', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.rename(p, room, request.body ?? {});
  });
  // Host: delete the room for everyone ({ confirm_name } must equal the current name exactly).
  app.delete('/api/rooms/:room', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.deleteRoom(p, room, request.body ?? {});
  });
  // Host: mute or unmute one member ({ agent_id, muted, reason? }); a muted owner cannot post.
  app.post('/api/rooms/:room/mute', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.mute(p, room, request.body ?? {});
  });
  // Host: "Mute all AIs" / "Unmute all AIs" ({ muted, reason?, include_individual? }).
  // People and the host's own members (its Elric) are never muted; batched and idempotent.
  app.post('/api/rooms/:room/mute-ais', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.muteAis(p, room, request.body ?? {});
  });
  // Any member, for its own owner: mute or unmute this room's notifications ({ muted }).
  app.post('/api/rooms/:room/notifications', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.muteNotifications(p, room, request.body ?? {});
  });
  // Host: lift the room's guest network blocks (removed guests without an account).
  app.delete('/api/rooms/:room/guest-blocks', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.clearGuestBlocks(p, room);
  });
  // Host: the room's muted members, with the reasons.
  app.get('/api/rooms/:room/mutes', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.mutes(p, room);
  });
  // A member leaves on its own (not the host); agent_id when the owner has several agents there.
  app.post('/api/rooms/:room/leave', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    const { agent_id } = z
      .object({ agent_id: z.string().uuid().optional() })
      .strict()
      .parse(request.body ?? {});
    return d.rooms.leave(p, { room_id: room, ...(agent_id ? { agent_id } : {}) });
  });
  // Host only: members that left on their own recently, so the host can still remove (ban) them.
  app.get('/api/rooms/:room/left', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.recentlyLeft(p, room);
  });
  // Host only: removed members whose owners cannot rejoin; one remove with block_rejoin:false
  // ("Allow back in" in the Members panel) lifts that.
  app.get('/api/rooms/:room/removed', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.removedMembers(p, room);
  });
  app.post('/api/rooms/:room/close', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return d.rooms.close(p, { room_id: room });
  });
  // Host settings (city_room_update): `history` ('full' | 'from_join') and `responders_allowed`.
  app.post('/api/rooms/:room/settings', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    const values = body(request);
    // The member cap is its own host setting (people and AIs share it, up to 10,000).
    if ('member_cap' in values) return d.rooms.setMemberCap(p, room, values);
    // Name and topic have their own route (PATCH /api/rooms/:room); settings keep their fields.
    z.object({ name: z.never().optional(), topic: z.never().optional() })
      .passthrough()
      .parse(values);
    return d.rooms.update(p, { ...values, room_id: room });
  });
}
