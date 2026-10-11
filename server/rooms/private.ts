import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Transaction as Tx } from '../database.js';
import { ownerLabel } from '../connections/service.js';

/**
 * Private Elric chat rooms (docs/ELRIC.md "Dashboard chat"; migration 43 `rooms.elric_private`).
 *
 * A private room is created only here, for one owner: the owner's PERSON is the host member, the
 * owner's Elric a normal member, member_cap 2, nobody may join and no join link exists. The rooms
 * service keeps it locked for its whole life:
 *
 * - every path that could open it (links, joins, people/AI settings, member cap, history, rename,
 *   topic, close, delete, removing Elric, host invites) is refused with 409 `room_private`;
 * - only the owner's console session and Elric itself reach it: any other principal of the same
 *   owner (MCP, OAuth grant, workspace key) gets the uniform 404, and it never appears in their
 *   room lists. The rooms service runs each call inside `withRoomPrincipal`, so `findRoom` knows
 *   who asks without changing every signature.
 *
 * A private chat with one of the owner's own agents is built the same way and kept locked the
 * same way (createAgentChat below); it differs only in who may reach it.
 */
export const PRIVATE_ROOM_CODE = 'room_private';
export const PRIVATE_ROOM_MESSAGE =
  "This is your private Elric chat; it can't be shared or opened.";
export const PRIVATE_ROOM_NAME = 'Elric';

const reach = new AsyncLocalStorage<{ private: boolean; console: boolean; elric: boolean }>();

/** The owner console (a person, cookie session) or Elric's own server-side calls (typed flag). */
export function mayReachPrivate(p: { console?: boolean; elric?: true }): boolean {
  return p.console === true || p.elric === true;
}
export function withRoomPrincipal<T>(p: { console?: boolean; elric?: true }, run: () => T): T {
  return reach.run(
    { private: mayReachPrivate(p), console: p.console === true, elric: p.elric === true },
    run,
  );
}
/**
 * Whether the current room call comes from the owner console (a signed-in person acting in the web
 * app), not from an agent, MCP, a grant or a key. Used by Elric's invocation gate.
 */
export function roomCallIsElric(): boolean {
  return reach.getStore()?.elric === true;
}
/**
 * The member rows minus every agent that is or ever was an Elric (any status): only Elric's own
 * runtime (principal `elric`) may act as it. A no-op when the Elric schema is absent.
 */
export async function withoutElricAgents<T extends { agent_id: string }>(
  q: Pick<Tx, 'query'>,
  rows: T[],
  allowElric = roomCallIsElric(),
): Promise<T[]> {
  if (allowElric || !rows.length) return rows;
  const elric = new Set(
    (
      await q.query<{ agent_id: string }>(
        'SELECT agent_id FROM elric_agents WHERE agent_id = ANY($1::text[])',
        [rows.map((row) => row.agent_id)],
      )
    ).rows.map((row) => row.agent_id),
  );
  return rows.filter((row) => !elric.has(row.agent_id));
}
export function roomCallFromConsole(): boolean {
  return reach.getStore()?.console === true;
}
/** Whether the current room call may see private rooms (false outside any room call). */
export function privateRoomsVisible(): boolean {
  return reach.getStore()?.private === true;
}
/** A room row as the current caller may see it: a private room only for the console or Elric. */
export function visibleRoom<T extends { elric_private?: boolean } | undefined>(
  row: T,
): T | undefined {
  return row?.elric_private && !privateRoomsVisible() ? undefined : row;
}
/**
 * Runs every method of a room service inside `withRoomPrincipal` (the first argument that is a
 * RoomPrincipal decides), so `visibleRoom` knows who asks without changing signatures.
 */
export function scopedByPrincipal<S extends object>(service: S): S {
  for (const [key, value] of Object.entries(service))
    if (typeof value === 'function')
      (service as Record<string, unknown>)[key] = (...args: unknown[]) => {
        const p = args.find(
          (arg): arg is { console?: boolean; elric?: true; actor: string } =>
            !!arg &&
            typeof arg === 'object' &&
            typeof (arg as { operatorId?: unknown }).operatorId === 'string' &&
            typeof (arg as { actor?: unknown }).actor === 'string',
        );
        const call = () => (value as (...a: unknown[]) => unknown)(...args);
        return p ? withRoomPrincipal(p, call) : call();
      };
  return service;
}

export interface PrivateRoom {
  room_id: string;
  slug: string;
  person_member_id: string;
}

/**
 * Inserts a private room: the owner's person hosts it, the given agent is its only other member,
 * member_cap 2, full history, no link, nobody may join. Shared by Elric chats (`elric: true`) and
 * private chats with an own agent; only the name, slug, key and the Elric flag differ.
 */
async function insertPrivateRoom(
  tx: Pick<Tx, 'query'>,
  input: {
    ownerId: string;
    agentId: string;
    time: number;
    name: string;
    slugPrefix: string;
    key: (roomId: string) => string;
    elric: boolean;
  },
): Promise<PrivateRoom> {
  const owner = (
    await tx.query<{ id: string; name: string; kind: string }>(
      'SELECT id,name,kind FROM operators WHERE id=$1',
      [input.ownerId],
    )
  ).rows[0];
  if (!owner || owner.kind !== 'owner') throw new Error('private rooms are for person owners');
  const label = ownerLabel(owner);
  const personId = randomUUID();
  const roomId = randomUUID();
  const slug = `${input.slugPrefix}-${randomBytes(6).toString('hex')}`;
  await tx.query(
    `INSERT INTO rooms(id,slug,name,topic,host_owner_id,host_agent_id,member_cap,history,link_ttl_ms,
       link_max_uses,created_at,idempotency_key,request_hash,people_may_join,members_may_bring_ai,
       elric_private)
     VALUES($1,$2,$3,'',$4,$5,2,'full',0,0,$6,$7,$7,false,false,$8)`,
    [roomId, slug, input.name, input.ownerId, personId, input.time, input.key(roomId), input.elric],
  );
  // The owner's person hosts; the agent is a normal member. Both see the whole (private) history.
  await tx.query(
    `INSERT INTO room_members(room_id,agent_id,owner_id,role,owner_label,visible_from_seq,joined_at,
       joined_by,last_read_seq,kind,display_name)
     VALUES($1,$2,$3,'host',$4,0,$5,'the owner',0,'person',$6),
           ($1,$7,$3,'member',$4,0,$5,'the owner',0,'agent',NULL)`,
    [roomId, personId, input.ownerId, label, input.time, owner.name, input.agentId],
  );
  return { room_id: roomId, slug, person_member_id: personId };
}

/**
 * Creates the private chat room of `elricAgentId` for `ownerId` in the caller's transaction (the
 * caller holds the Elric row FOR UPDATE and records the room on it). Server-only: no route reaches
 * this function, and it only ever adds the given owner's own person and the given Elric.
 */
export async function createPrivateRoom(
  tx: Pick<Tx, 'query'>,
  input: { ownerId: string; elricAgentId: string; time: number },
): Promise<PrivateRoom> {
  return insertPrivateRoom(tx, {
    ownerId: input.ownerId,
    agentId: input.elricAgentId,
    time: input.time,
    name: PRIVATE_ROOM_NAME,
    slugPrefix: 'elric',
    key: (roomId) => `elric-chat:${roomId}`,
    elric: true,
  });
}

/**
 * Private chats with one of the owner's own agents ("Message <agent>", POST
 * /api/rooms/private-agent). The same room shape as an Elric chat (insertPrivateRoom) and the same
 * lock in the rooms service: every link, join, setting, rename, close, remove, leave and
 * host-invite path answers 409 `room_private`. Only its owner's console may delete it, like any
 * room it hosts; its key is released then, so the next open makes a new chat. Unlike an Elric chat
 * it is not hidden from the owner's other principals: the agent's own runtime (MCP, a key, its
 * hosted responder) must read and answer it, and every principal that reaches it is that same
 * owner. Every post of the owner's person there is addressed to the agent, "@" or not
 * (server/wake/hooks.ts roomPosted).
 *
 * One room per owner and agent: its idempotency key is `agent-chat:<agent id>`, unique per host
 * owner (migration 13 `rooms_idempotency`), and the open runs under the owner's workspace lock.
 * A client's create key is always stored hashed (rooms/service.ts create), so only this function
 * writes a key with that prefix, and the key marks the room.
 */
export const AGENT_CHAT_KEY_PREFIX = 'agent-chat:';
export const AGENT_CHAT_MESSAGE =
  "This is your private chat with your agent; it can't be shared or opened.";

/** The agent of a private agent chat; null for every other room (an Elric chat included). */
export function privateAgentOf(room: { idempotency_key?: string } | undefined): string | null {
  const key = room?.idempotency_key;
  return key?.startsWith(AGENT_CHAT_KEY_PREFIX) ? key.slice(AGENT_CHAT_KEY_PREFIX.length) : null;
}

export interface AgentChatRoom extends PrivateRoom {
  latest_seq: number;
}

/** The owner's private chat with `agentId`, if it exists. */
export async function findAgentChat(
  q: Pick<Tx, 'query'>,
  ownerId: string,
  agentId: string,
): Promise<AgentChatRoom | undefined> {
  const row = (
    await q.query<{ id: string; slug: string; host_agent_id: string; next_seq: string | number }>(
      'SELECT id,slug,host_agent_id,next_seq FROM rooms WHERE host_owner_id=$1 AND idempotency_key=$2',
      [ownerId, `${AGENT_CHAT_KEY_PREFIX}${agentId}`],
    )
  ).rows[0];
  // The host member is the owner's person (insertPrivateRoom).
  return row
    ? {
        room_id: row.id,
        slug: row.slug,
        person_member_id: row.host_agent_id,
        latest_seq: Number(row.next_seq) - 1,
      }
    : undefined;
}

/**
 * Creates the owner's private chat with its own agent in the caller's transaction. The caller
 * holds the owner's workspace FOR UPDATE and has checked that the agent is its own, live and not
 * an Elric; the unique key makes a second room for the same agent fail rather than exist.
 */
export async function createAgentChat(
  tx: Pick<Tx, 'query'>,
  input: { ownerId: string; agentId: string; agentName: string; time: number },
): Promise<PrivateRoom> {
  return insertPrivateRoom(tx, {
    ownerId: input.ownerId,
    agentId: input.agentId,
    time: input.time,
    name: input.agentName,
    slugPrefix: 'chat',
    key: () => `${AGENT_CHAT_KEY_PREFIX}${input.agentId}`,
    elric: false,
  });
}

/** Closes a private room (Elric revoked or gone): read-only for the owner, never deleted. */
export async function closePrivateRoom(tx: Pick<Tx, 'query'>, roomId: string, time: number) {
  await tx.query(
    `UPDATE rooms SET closed_at=$2, closed_by='Elric removed' WHERE id=$1 AND elric_private AND closed_at IS NULL`,
    [roomId, time],
  );
}

/** Close the removed agent's private chat without deleting its owner's history. */
export async function closeAgentChat(
  tx: Pick<Tx, 'query'>,
  ownerId: string,
  agentId: string,
  time: number,
) {
  await tx.query(
    `UPDATE rooms SET closed_at=$3, closed_by='Agent removed'
     WHERE host_owner_id=$1 AND idempotency_key=$2 AND closed_at IS NULL`,
    [ownerId, `${AGENT_CHAT_KEY_PREFIX}${agentId}`, time],
  );
}
