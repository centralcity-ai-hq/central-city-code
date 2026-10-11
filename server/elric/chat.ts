import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { registerElricDraftRoutes } from './draft.js';
import { assertConversationCaps, registerElricConversations } from './conversations.js';
import type { Database } from '../database.js';
import { AGENT_CHAT_KEY_PREFIX, closePrivateRoom, createPrivateRoom } from '../rooms/private.js';
import { RoomError } from '../rooms/service.js';

/**
 * The dashboard chat with Elric (docs/ELRIC.md "Dashboard chat"). A chat is a private room
 * (rooms/private.ts): the owner's person hosts it, the owner's Elric is its only other member, and
 * the rooms service keeps it locked. The dashboard posts `@Elric <text>` there through the normal
 * room routes, so every Elric guarantee applies unchanged (room-only context, the gate, budgets,
 * approvals, the turn log and the label). Owner console session only, like every /api/elric route.
 *
 * - `GET /api/elric/chat[?since=<seq>]`: the chat room, created on the first visit (atomic, one per
 *   Elric), plus a cheap poll state: latest_seq, waking and open pending actions. A revoked or
 *   deleted Elric's chat is closed here (read-only history; a re-added Elric gets a new room).
 * - `GET /api/elric/rooms`: the "@ room" picker: open shared rooms where the owner's person is an
 *   active member, with whether this Elric (active, not paused) is a member too. No names of
 *   other members, no content.
 * - `POST /api/elric/ask` `{ room_id }`: the server check before an "@ room" post: both the
 *   owner's person and this Elric must be members of that open room, else a typed refusal
 *   (409 elric_room_requires_membership, `missing`). The post itself goes through the room route
 *   and the invocation gate, which check the same again.
 */
type Q = Pick<Database, 'query'>;

const DAY_MS = 86_400_000;
/** New private chats per owner and 24 hours (each revoke + re-add makes one). */
export const CHAT_ROOMS_PER_DAY = 5;

export interface ChatState {
  room_id: string;
  slug: string;
  person_member_id: string;
  status: 'active' | 'paused';
  latest_seq: number;
  waking: boolean;
  pending_count: number;
}

const refuse = (statusCode: number, errorCode: string, message: string, details?: unknown) => {
  const error = new RoomError(statusCode, errorCode, message);
  if (details !== undefined) error.details = details;
  return error;
};

const chatQuery = z
  .object({ since: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() })
  .strict();
const askBody = z.object({ room_id: z.string().min(1).max(200) }).strict();

/** Closes the chats of this owner's revoked Elrics, or of an Elric whose agent is gone. */
async function closeEndedChats(db: Q, ownerId: string, time: number) {
  const ended = (
    await db.query<{ chat_room_id: string }>(
      `SELECT e.chat_room_id FROM elric_agents e JOIN rooms r ON r.id=e.chat_room_id
        WHERE e.owner_id=$1 AND e.chat_room_id IS NOT NULL AND r.closed_at IS NULL
          AND (e.status='revoked' OR NOT EXISTS (
            SELECT 1 FROM workspaces w, jsonb_array_elements(w.data->'agents') a
             WHERE w.operator_id=e.owner_id AND a->>'id'=e.agent_id AND (a->>'revokedAt') IS NULL))`,
      [ownerId],
    )
  ).rows;
  for (const row of ended) await closePrivateRoom(db, row.chat_room_id, time);
}

export async function elricChat(
  db: Pick<Database, 'query' | 'transaction'>,
  ownerId: string,
  time: number,
  poll = false,
): Promise<ChatState | null> {
  // A poll is one cheap read once the chat exists; the full visit also closes ended chats.
  const existing = (
    await db.query<{ agent_id: string; status: 'active' | 'paused'; chat_room_id: string | null }>(
      `SELECT agent_id,status,chat_room_id FROM elric_agents WHERE owner_id=$1 AND status <> 'revoked'`,
      [ownerId],
    )
  ).rows[0];
  if (!poll) await closeEndedChats(db, ownerId, time);
  const created =
    existing?.chat_room_id && poll
      ? existing
      : await db.transaction(async (tx) => {
          const own = (
            await tx.query<{
              agent_id: string;
              status: 'active' | 'paused';
              chat_room_id: string | null;
            }>(
              `SELECT agent_id,status,chat_room_id FROM elric_agents
          WHERE owner_id=$1 AND status <> 'revoked' FOR UPDATE`,
              [ownerId],
            )
          ).rows[0];
          if (!own) return null;
          if (own.chat_room_id) return own;
          // First visit: one room per Elric, under the Elric row lock (concurrent visits wait here).
          // Revoke and re-add churn is bounded: at most CHAT_ROOMS_PER_DAY Elrics of this owner
          // got their first chat in 24 hours. New conversations of the same Elric
          // (conversations.ts) do not count here; they have their own caps.
          const recent = (
            await tx.query<{ n: string | number; oldest: string | number | null }>(
              `SELECT count(*) AS n, min(first) AS oldest FROM (
                 SELECT (SELECT min(r.created_at) FROM rooms r JOIN room_members m
                           ON m.room_id=r.id AND m.agent_id=e.agent_id
                          WHERE r.elric_private AND r.host_owner_id=$1) AS first
                   FROM elric_agents e WHERE e.owner_id=$1) f
                WHERE first > $2`,
              [ownerId, time - DAY_MS],
            )
          ).rows[0];
          if (Number(recent?.n ?? 0) >= CHAT_ROOMS_PER_DAY)
            throw Object.assign(
              refuse(429, 'too_many_chats', 'Too many new Elric chats today. Try again later.'),
              // The real wait: until the oldest chat of the window is 24 hours old.
              { retryAfterMs: Math.max(1_000, Number(recent!.oldest) + DAY_MS - time) },
            );
          await assertConversationCaps(tx, ownerId, time);
          const room = await createPrivateRoom(tx, { ownerId, elricAgentId: own.agent_id, time });
          await tx.query('UPDATE elric_agents SET chat_room_id=$2 WHERE agent_id=$1', [
            own.agent_id,
            room.room_id,
          ]);
          return { ...own, chat_room_id: room.room_id };
        });
  if (!created?.chat_room_id) return null;
  const row = (
    await db.query<{
      slug: string;
      next_seq: string | number;
      person: string;
      waking: boolean;
      pending: string | number;
    }>(
      `SELECT r.slug, r.next_seq,
              (SELECT m.agent_id FROM room_members m WHERE m.room_id=r.id AND m.kind='person'
                 AND m.owner_id=$2 AND m.role='host' LIMIT 1) AS person,
              EXISTS (SELECT 1 FROM elric_invocations i WHERE i.agent_id=$3 AND i.room_id=r.id
                 AND i.status IN ('queued','running') AND i.waking_since IS NOT NULL) AS waking,
              (SELECT count(*) FROM elric_pending_actions p WHERE p.owner_id=$2
                 AND p.status='pending' AND p.expires_at > $4) AS pending
         FROM rooms r WHERE r.id=$1`,
      [created.chat_room_id, ownerId, created.agent_id, time],
    )
  ).rows[0]!;
  return {
    room_id: created.chat_room_id,
    slug: row.slug,
    person_member_id: row.person,
    status: created.status,
    latest_seq: Number(row.next_seq) - 1,
    waking: row.waking,
    pending_count: Number(row.pending),
  };
}

export interface PickerRoom {
  id: string;
  name: string;
  member_count: number;
  hosting: boolean;
  person_member: true;
  elric_member: boolean;
}

/**
 * The "@ room" picker: open shared rooms with the owner's active person member. Never a private
 * chat (Elric's own, or one with an own agent: Elric can never join it).
 */
export async function elricRooms(db: Q, ownerId: string): Promise<{ rooms: PickerRoom[] }> {
  const rows = (
    await db.query<{
      id: string;
      name: string;
      members: string | number;
      hosting: boolean;
      elric: boolean;
    }>(
      `SELECT r.id, r.name, r.host_owner_id=$1 AS hosting,
              (SELECT count(*) FROM room_members c WHERE c.room_id=r.id AND c.removed_at IS NULL) AS members,
              EXISTS (SELECT 1 FROM room_members e JOIN elric_agents a ON a.agent_id=e.agent_id
                 WHERE e.room_id=r.id AND e.removed_at IS NULL AND a.owner_id=$1
                   AND a.status='active') AS elric
         FROM rooms r
        WHERE r.closed_at IS NULL AND r.deleted_at IS NULL AND NOT r.elric_private
          AND r.idempotency_key NOT LIKE '${AGENT_CHAT_KEY_PREFIX}%'
          AND EXISTS (SELECT 1 FROM room_members p WHERE p.room_id=r.id AND p.owner_id=$1
                        AND p.kind='person' AND p.removed_at IS NULL)
        ORDER BY r.created_at DESC, r.id LIMIT 100`,
      [ownerId],
    )
  ).rows;
  return {
    rooms: rows.map((row) => ({
      id: row.id,
      name: row.name,
      member_count: Number(row.members),
      hosting: row.hosting,
      person_member: true as const,
      elric_member: row.elric,
    })),
  };
}

/** The server check before an "@ room" post (typed refusal when a membership is missing). */
export async function elricAskCheck(db: Q, ownerId: string, roomRef: string) {
  const row = (
    await db.query<{ id: string; person: string | null; elric: boolean }>(
      `SELECT r.id,
              (SELECT p.agent_id FROM room_members p WHERE p.room_id=r.id AND p.owner_id=$2
                 AND p.kind='person' AND p.removed_at IS NULL LIMIT 1) AS person,
              EXISTS (SELECT 1 FROM room_members e JOIN elric_agents a ON a.agent_id=e.agent_id
                 WHERE e.room_id=r.id AND e.removed_at IS NULL AND a.owner_id=$2
                   AND a.status='active') AS elric
         FROM rooms r
        WHERE (r.id=$1 OR r.slug=$1) AND r.closed_at IS NULL AND r.deleted_at IS NULL
          AND NOT r.elric_private AND r.idempotency_key NOT LIKE '${AGENT_CHAT_KEY_PREFIX}%'
          AND EXISTS (SELECT 1 FROM room_members m WHERE m.room_id=r.id AND m.owner_id=$2
                        AND m.removed_at IS NULL)`,
      [roomRef, ownerId],
    )
  ).rows[0];
  // A room the owner is not in at all (or a private chat) is the uniform not found.
  if (!row) throw refuse(404, 'room_not_found', 'Room not found.');
  const missing =
    !row.person && !row.elric ? 'both' : !row.person ? 'person' : !row.elric ? 'elric' : null;
  if (missing)
    throw refuse(
      409,
      'elric_room_requires_membership',
      missing === 'person'
        ? 'Join this room as yourself first.'
        : missing === 'elric'
          ? 'Add Elric to this room first.'
          : 'Join this room as yourself and add Elric first.',
      { missing },
    );
  return { room_id: row.id, person_member_id: row.person!, posts_publicly: true as const };
}

export function registerElricChat(
  app: FastifyInstance,
  d: {
    db: Pick<Database, 'query' | 'transaction'>;
    clock: () => number;
    owner: (request: FastifyRequest) => Promise<string>;
  },
): void {
  app.get('/api/elric/chat', async (request) => {
    const ownerId = await d.owner(request);
    const { since } = chatQuery.parse(request.query);
    const chat = await elricChat(d.db, ownerId, d.clock(), since !== undefined);
    if (!chat) throw refuse(404, 'elric_not_found', 'You have no Elric.');
    return chat;
  });
  app.get('/api/elric/rooms', async (request) => elricRooms(d.db, await d.owner(request)));
  // Streamed reply drafts (draft.ts): room members watch an answer form.
  registerElricDraftRoutes(app, d);
  // Several private conversations per owner (conversations.ts).
  registerElricConversations(app, d);
  app.post('/api/elric/ask', async (request) => {
    const ownerId = await d.owner(request);
    const { room_id } = askBody.parse(request.body ?? {});
    return elricAskCheck(d.db, ownerId, room_id);
  });
}
