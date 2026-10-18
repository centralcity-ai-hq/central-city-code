import { registerMigration, type Migration } from '../migrations.js';

/** Recognized by backups and never exported (server/recovery.ts). */
export const ROOM_INVITATION_TABLES = ['room_invitation_blocks', 'room_invitations'] as const;

/**
 * Migration 101 `room_invitations` (Operation Directory D2, shared/directory.ts; the service is
 * rooms/invitations.ts). Times are ms since epoch, like the rooms tables.
 *
 * - `room_invitations`: a room host invites a listed Central City Base agent of any owner. The
 *   agent is never added: it joins only when it (its connected AI) or its owner accepts.
 *   `invited_owner_id` is the agent's owner when invited (its owner answers, and blocks are per
 *   owner); `inviting_operator_id` is the host account. The `to_*` and `from_*` columns are what
 *   each side was shown when it was sent (names are untrusted: other owners chose them). `state`:
 *   open, then accepted, declined, expired (no answer in 7 days, the room closed or the agent's
 *   50 open invitations overflowed) or withdrawn (the host). `answered_at` is when it left
 *   'open' (an expiry's own time for an expired one). The idempotency key is per host account,
 *   bound to the request hash; one OPEN invitation per (room, agent).
 * - `room_invitation_blocks`: an owner blocked invitations from another owner (every agent of
 *   it, to every agent of the blocker). Never shown to the blocked owner: it reads as 404.
 *
 * The directory settings it reads (`agent_directory`: listed, invitations 'ask' | 'never') are
 * migration 100 (Operation Directory D1, server/directory/schema.ts).
 */
export const ROOM_INVITATIONS_SQL = `
CREATE TABLE IF NOT EXISTS room_invitations (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id),
  invited_agent_id text NOT NULL,
  invited_owner_id text NOT NULL REFERENCES operators(id),
  inviting_agent_id text NOT NULL,
  inviting_operator_id text NOT NULL REFERENCES operators(id),
  to_base_id text NOT NULL, to_short text NOT NULL, to_name text NOT NULL,
  from_name text NOT NULL, from_base_id text, from_short text,
  note text NOT NULL DEFAULT '',
  state text NOT NULL CHECK (state IN ('open','accepted','declined','expired','withdrawn')),
  idempotency_key text NOT NULL, request_hash text NOT NULL,
  created_at bigint NOT NULL, expires_at bigint NOT NULL, answered_at bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS room_invitations_idempotency
  ON room_invitations(inviting_operator_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS room_invitations_one_open
  ON room_invitations(room_id, invited_agent_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS room_invitations_room ON room_invitations(room_id, created_at);
CREATE INDEX IF NOT EXISTS room_invitations_agent
  ON room_invitations(invited_agent_id, state, created_at);
CREATE INDEX IF NOT EXISTS room_invitations_sender
  ON room_invitations(inviting_operator_id, created_at);
CREATE TABLE IF NOT EXISTS room_invitation_blocks (
  blocker_owner_id text NOT NULL REFERENCES operators(id),
  blocked_owner_id text NOT NULL REFERENCES operators(id),
  created_at bigint NOT NULL,
  PRIMARY KEY(blocker_owner_id, blocked_owner_id)
);
`;

export const roomInvitationsMigration: Migration = {
  version: 101,
  name: 'room_invitations',
  sql: ROOM_INVITATIONS_SQL,
};

/** Idempotent; call before runMigrations (after the rooms migrations and migration 100). */
export function registerRoomInvitationsMigration(): void {
  registerMigration(roomInvitationsMigration);
}
