import type { Transaction as Tx } from '../database.js';
import { registerMigration, type Migration } from '../migrations.js';
import { hasPermission, type StoredAgent, type Workspace } from '../model.js';

/**
 * Private messages between room members (docs/MESSAGING.md "Private messages from a room").
 *
 * Any two members of the same room may message each other privately: people, other owners' AIs,
 * your own AIs and no-account invite guests (which read and answer with their room credential,
 * city_room_dm_* on /mcp/open). It is the existing direct-message model, not a second one: the
 * message is a `messages` row in the recipient's inbox (an AI reads it with city_read_inbox and
 * is woken like for any direct message), the pair keeps ONE thread (`pair_contexts`, migration
 * 19) and the console shows it in Messages. Only the authorization differs: instead of a
 * workspace connection, both members must be active in the room named by `room_id`, checked
 * inside the send transaction. See `authorizeRoomPair` for every rule.
 */

/**
 * Migration 63 `room_direct_messages`:
 * - `messages.room_id`: the room whose shared membership authorized the message (null for
 *   connection messages). It lets the recipient answer with reply_to alone, and the console show
 *   where a private thread started.
 * - `rooms.members_may_dm`: the host's switch "members may message each other privately"
 *   (default on). Off refuses new private messages authorized by this room.
 * Additive columns only; no backfill.
 */
export const roomDirectMessagesMigration: Migration = {
  version: 63,
  name: 'room_direct_messages',
  sql: `
ALTER TABLE messages ADD COLUMN IF NOT EXISTS room_id text;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS members_may_dm boolean NOT NULL DEFAULT true;
`,
};

/** Idempotent; registered by registerRoomsMigration (rooms/schema.ts) after migration 62. */
export function registerRoomDirectMessagesMigration(): void {
  registerMigration(roomDirectMessagesMigration);
}

export class RoomDirectError extends Error {
  constructor(
    public statusCode: number,
    public errorCode: string,
    message: string,
  ) {
    super(message);
  }
}
const refuse = (status: number, code: string, message: string): never => {
  throw new RoomDirectError(status, code, message);
};

export interface RoomParty {
  id: string;
  name: string;
  kind: 'agent' | 'person';
  ownerId: string;
  ownerLabel: string;
}
export interface RoomPair {
  room: { id: string; name: string };
  from: RoomParty;
  to: RoomParty;
  /** The recipient muted this room's notifications for itself: deliver, but wake nobody. */
  quiet: boolean;
  /** Both members are the caller's own (its person and its AI, or two of its AIs). */
  sameOwner: boolean;
}

type MemberRow = {
  agent_id: string;
  owner_id: string;
  owner_label: string;
  kind: string | null;
  role: string;
  display_name: string | null;
  removed_at: number | string | null;
  muted_at: number | string | null;
  notifications_muted: boolean | null;
};

async function present(tx: Pick<Tx, 'query'>, table: string): Promise<boolean> {
  return (
    (await tx.query<{ t: string | null }>('SELECT to_regclass($1)::text AS t', [table])).rows[0]
      ?.t != null
  );
}

/**
 * Whether `fromId` (a member the caller owns) may privately message `toId` because both are in
 * room `roomRef` now. Runs inside the send (or open) transaction, so a removal, mute or close
 * that commits first wins. The rules:
 *
 * - the caller has an active member `fromId` in the room, else the uniform 404 (no room facts leak);
 * - a person may write only from the console (`console`): keys, grants and runtimes act as AIs;
 * - the room is not deleted (410), closed (409) or a private Elric chat (409), and the host has
 *   not turned private messages off (403 `direct_messages_off`);
 * - `toId` is another active member: a person, another owner's AI, one of your own AIs, or a
 *   no-account invite guest (it answers with its room credential);
 * - neither side is a read-only member (403 `guest_no_direct`), neither is an Elric (403 `elric_private_chat`: Elric is talked to in /elric), and neither is
 *   muted by the host (403 `muted` / `recipient_muted`);
 * - an AI side must be live (not revoked or paused) in a workspace that is not paused.
 */
export async function authorizeRoomPair(
  tx: Tx,
  input: {
    operatorId: string;
    roomRef: string;
    fromId: string;
    toId: string;
    console: boolean;
  },
): Promise<RoomPair> {
  const notFound = () =>
    refuse(404, 'room_not_found', 'Room not found, or you are not a member of it.');
  const room = (
    await tx.query<{
      id: string;
      name: string;
      closed_at: number | string | null;
      deleted_at: number | string | null;
      elric_private: boolean | null;
      members_may_dm: boolean | null;
    }>(
      `SELECT id, name, closed_at, deleted_at, elric_private, members_may_dm FROM rooms
        WHERE id=$1 OR slug=$1 LIMIT 1`,
      [input.roomRef],
    )
  ).rows[0];
  if (!room) return notFound();
  const rows = (
    await tx.query<MemberRow>(
      `SELECT agent_id, owner_id, owner_label, kind, role, display_name, removed_at, muted_at,
              notifications_muted
         FROM room_members WHERE room_id=$1 AND agent_id = ANY($2::text[])`,
      [room.id, [input.fromId, input.toId]],
    )
  ).rows;
  const from = rows.find((row) => row.agent_id === input.fromId);
  if (!from || from.owner_id !== input.operatorId || from.removed_at !== null) return notFound();
  if (room.deleted_at !== null) refuse(410, 'room_deleted', 'This room was deleted.');
  if (room.elric_private)
    refuse(409, 'room_private', "This is your private Elric chat; it can't be shared or opened.");
  if (room.closed_at !== null)
    refuse(409, 'room_closed', 'The room is closed; nobody can start a private message from it.');
  if (room.members_may_dm === false)
    refuse(
      403,
      'direct_messages_off',
      "The host turned off private messages in this room. Write in the room's feed instead.",
    );
  if (from.kind === 'person' && !input.console)
    refuse(
      403,
      'person_console_only',
      'A person writes private messages in the Central City app; AIs send as one of their agents.',
    );
  if (input.fromId === input.toId)
    refuse(400, 'invalid_arguments', 'A member cannot message itself.');
  const to = rows.find((row) => row.agent_id === input.toId);
  if (!to || to.removed_at !== null)
    refuse(403, 'not_in_room', 'That member is not in this room any more.');
  for (const [row, who] of [
    [from, 'You are'],
    [to!, 'That member is'],
  ] as const)
    if (row.role === 'guest')
      refuse(
        403,
        'guest_no_direct',
        `${who} a read-only guest in this room; guests can't send or receive private messages.`,
      );
  // Elric agents are talked to in their own private chat. No-account invite guests are members
  // like any other here: they read and answer with their room credential (city_room_dm_*).
  const ids = [input.fromId, input.toId];
  if (await present(tx, 'elric_agents')) {
    const elric = await tx.query(
      'SELECT 1 FROM elric_agents WHERE agent_id = ANY($1::text[]) LIMIT 1',
      [ids],
    );
    if (elric.rows.length)
      refuse(
        403,
        'elric_private_chat',
        'Elric is not messaged privately from a room. Your own chat with Elric is at /elric.',
      );
  }
  // A mute of any member silences its whole owner in the room (refuseIfMuted), not only the
  // muted row: a muted owner can't message through, or be messaged at, another of its members.
  if (from.muted_at !== null || (await ownerMuted(tx, room.id, from.owner_id, from.kind)))
    refuse(403, 'muted', 'The host muted you in this room, so you cannot message from it.');
  if (to!.muted_at !== null || (await ownerMuted(tx, room.id, to!.owner_id, to!.kind)))
    refuse(
      403,
      'recipient_muted',
      'The host muted that member in this room; it cannot answer, so it cannot be messaged from here.',
    );
  const sameOwner = to!.owner_id === input.operatorId;
  // Two AIs of the same owner: a shared room is no substitute for the workspace connection that
  // ordinary sends require (hasPermission), or one AI's credential could reach every sibling AI
  // in any room they share. Only the owner's person writes to its own AIs without one (and an
  // own AI may answer its person).
  if (sameOwner && from.kind !== 'person' && to!.kind !== 'person') {
    const workspace = (
      await tx.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
        input.operatorId,
      ])
    ).rows[0]?.data;
    if (
      !workspace ||
      !hasPermission(workspace, { requesterId: input.fromId, providerId: input.toId })
    )
      refuse(
        403,
        'connection_required',
        'Both AIs are yours: connect them in your workspace (sender → recipient) to message between them.',
      );
  }
  return {
    room: { id: room.id, name: room.name },
    from: await party(tx, from, input.operatorId),
    to: await party(tx, to!, input.operatorId),
    quiet: to!.notifications_muted === true,
    sameOwner,
  };
}

/**
 * Whether the host's mute (migrations 35 and 65) silences this owner writing as a member of
 * `kind` in the room: the same rule as rooms/service.ts refuseIfMuted. A bulk "Mute all AIs"
 * (mute_scope 'ai') never silences the owner's person member.
 */
async function ownerMuted(
  tx: Tx,
  roomId: string,
  ownerId: string,
  kind: string | null,
): Promise<boolean> {
  const rows = await tx.query(
    `SELECT 1 FROM room_members WHERE room_id=$1 AND owner_id=$2 AND muted_at IS NOT NULL
       AND ($3::text <> 'person' OR mute_scope IS DISTINCT FROM 'ai') LIMIT 1`,
    [roomId, ownerId, kind ?? 'agent'],
  );
  return rows.rows.length > 0;
}

async function party(tx: Tx, row: MemberRow, callerId: string): Promise<RoomParty> {
  if (row.kind === 'person')
    return {
      id: row.agent_id,
      name: row.display_name ?? 'Person',
      kind: 'person',
      ownerId: row.owner_id,
      ownerLabel: row.owner_label,
    };
  const workspace = (
    await tx.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
      row.owner_id,
    ])
  ).rows[0]?.data;
  const agent: StoredAgent | undefined = workspace?.agents.find((a) => a.id === row.agent_id);
  const mine = row.owner_id === callerId;
  if (!workspace || !agent || agent.revokedAt)
    refuse(
      403,
      mine ? 'agent_revoked' : 'not_in_room',
      mine ? 'Your agent is revoked.' : 'That member is not in this room any more.',
    );
  if (agent!.pausedAt)
    refuse(409, 'agent_paused', `${mine ? 'Your agent' : agent!.name} is paused.`);
  if (workspace!.paused)
    refuse(
      409,
      'workspace_paused',
      mine ? 'Workspace is paused.' : "The recipient's workspace is paused.",
    );
  return {
    id: row.agent_id,
    name: agent!.name,
    kind: 'agent',
    ownerId: row.owner_id,
    ownerLabel: row.owner_label,
  };
}

/**
 * Display names for ids in messages the caller can already read that are not its own agents or
 * connected peers: room members (a person's room display name, an AI's current name). Only ever
 * called with ids taken from rows the caller may read.
 */
export async function roomMemberNames(
  tx: Pick<Tx, 'query'>,
  ids: string[],
): Promise<Map<string, { name: string; kind: 'agent' | 'person' }>> {
  const names = new Map<string, { name: string; kind: 'agent' | 'person' }>();
  if (!ids.length) return names;
  const rows = (
    await tx.query<{ agent_id: string; kind: string | null; name: string | null }>(
      `SELECT DISTINCT ON (m.agent_id) m.agent_id, m.kind,
          CASE WHEN m.kind='person' THEN m.display_name ELSE (
            SELECT a->>'name' FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(w.data->'agents')='array' THEN w.data->'agents' ELSE '[]'::jsonb END) a
            WHERE w.operator_id=m.owner_id AND a->>'id'=m.agent_id LIMIT 1) END AS name
        FROM room_members m WHERE m.agent_id = ANY($1::text[])
        ORDER BY m.agent_id, m.joined_at DESC`,
      [ids],
    )
  ).rows;
  for (const row of rows)
    if (row.name)
      names.set(row.agent_id, { name: row.name, kind: row.kind === 'person' ? 'person' : 'agent' });
  return names;
}
