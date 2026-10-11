import { memberSaysMigration } from './member-says.js';
import { registerMigration, type Migration } from '../migrations.js';
import { registerMemberActivityMigration } from './member-status.js';
import { registerRoomPeopleMigration } from './person.js';
import { registerRoomSystemLinesMigration } from './system-lines.js';
import {
  registerRoomMemberCap100Migration,
  registerRoomMemberCap10000Migration,
  registerRoomMemberCapStandard100Migration,
} from './cap-schema.js';
import {
  registerRoomGuestBlocksMigration,
  registerRoomNotificationMuteMigration,
  registerRoomManagementMigration,
} from './management-schema.js';
import { registerRoomMessageSearchMigration } from './search-schema.js';
import { registerRoomDirectMessagesMigration } from '../messaging/room-direct.js';

/**
 * Migration 13 `rooms` (Rooms; the ROOMS-SEC-001 threat model; docs/ROOMS.md).
 *
 * - `rooms`: one shared thread. `next_seq` is the per-room sequence allocator (`UPDATE ... RETURNING`,
 *   like `inbox_cursors`), so room messages are gap-free and visible in commit order. The host is an
 *   owner (`host_owner_id`) acting through one of its agents (`host_agent_id`).
 * - `room_members`: membership of one agent (of any owner) in one room. It grants the room only,
 *   never the member's or the host's workspace. `visible_from_seq` is the server-assigned history
 *   start (messages with a greater seq are visible). Removal is a timestamp, never a delete.
 * - `room_messages`: sender id, owner and the display labels are stamped by the server at post time.
 * - `room_receipts`: post idempotency per (room, owner, key), bound to the request hash.
 * - `room_links`: invite links. The token is derived (HMAC under the server secret) from a random
 *   salt and only its SHA-256 is stored; `rotate_key` makes a rotation idempotent per room.
 * - `room_join_receipts`: join idempotency per (owner, key), bound to the request hash.
 * - `room_events`: append-only security audit with server-derived actor and action.
 */
export const ROOM_TABLES = [
  'room_events',
  'room_join_receipts',
  'room_links',
  'room_members',
  'room_messages',
  'room_receipts',
  'rooms',
] as const;

export const roomsMigration: Migration = {
  version: 13,
  name: 'rooms',
  sql: `
CREATE TABLE IF NOT EXISTS rooms (
  id text PRIMARY KEY, slug text NOT NULL UNIQUE,
  name text NOT NULL, topic text NOT NULL DEFAULT '',
  host_owner_id text NOT NULL REFERENCES operators(id), host_agent_id text NOT NULL,
  member_cap integer NOT NULL CHECK (member_cap >= 2),
  history text NOT NULL CHECK (history IN ('from_join','full')),
  link_ttl_ms bigint NOT NULL, link_max_uses integer,
  next_seq bigint NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  created_at bigint NOT NULL, closed_at bigint, closed_by text,
  idempotency_key text NOT NULL, request_hash text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rooms_idempotency ON rooms(host_owner_id, idempotency_key);
CREATE INDEX IF NOT EXISTS rooms_host ON rooms(host_owner_id, closed_at);
CREATE TABLE IF NOT EXISTS room_members (
  room_id text NOT NULL REFERENCES rooms(id), agent_id text NOT NULL,
  owner_id text NOT NULL REFERENCES operators(id),
  role text NOT NULL CHECK (role IN ('host','member','guest')),
  owner_label text NOT NULL, visible_from_seq bigint NOT NULL CHECK (visible_from_seq >= 0),
  joined_at bigint NOT NULL, joined_by text NOT NULL,
  removed_at bigint, removed_by text,
  PRIMARY KEY(room_id, agent_id)
);
CREATE INDEX IF NOT EXISTS room_members_owner ON room_members(owner_id, room_id);
CREATE TABLE IF NOT EXISTS room_messages (
  room_id text NOT NULL REFERENCES rooms(id), seq bigint NOT NULL, id uuid NOT NULL,
  sender_agent_id text NOT NULL, sender_owner_id text NOT NULL,
  sender_name text NOT NULL, sender_owner_label text NOT NULL,
  parts jsonb NOT NULL, created_at bigint NOT NULL,
  PRIMARY KEY(room_id, seq)
);
CREATE TABLE IF NOT EXISTS room_receipts (
  room_id text NOT NULL, owner_id text NOT NULL, idempotency_key text NOT NULL,
  request_hash text NOT NULL, seq bigint NOT NULL, created_at bigint NOT NULL,
  PRIMARY KEY(room_id, owner_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS room_links (
  id text PRIMARY KEY, room_id text NOT NULL REFERENCES rooms(id),
  salt text NOT NULL, token_hash text NOT NULL UNIQUE,
  created_at bigint NOT NULL, expires_at bigint NOT NULL,
  max_uses integer, uses integer NOT NULL DEFAULT 0, revoked_at bigint,
  created_by text NOT NULL, rotate_key text
);
CREATE UNIQUE INDEX IF NOT EXISTS room_links_rotation ON room_links(room_id, rotate_key);
CREATE INDEX IF NOT EXISTS room_links_room ON room_links(room_id, created_at);
CREATE TABLE IF NOT EXISTS room_join_receipts (
  owner_id text NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL,
  room_id text NOT NULL, agent_id text NOT NULL, created_agent boolean NOT NULL,
  joined boolean NOT NULL, created_at bigint NOT NULL,
  PRIMARY KEY(owner_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS room_events (
  id text PRIMARY KEY, room_id text NOT NULL, actor_owner_id text NOT NULL, actor text NOT NULL,
  action text NOT NULL, agent_id text, created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS room_events_room ON room_events(room_id, created_at);
`,
};

/**
 * Migration 58 `room_templates`: the built-in room template a room was created from
 * (shared/room-templates.ts). Both columns are null for rooms created without one; the catalog
 * lives in code, so there is no template table and no foreign key.
 */
export const roomTemplatesMigration: Migration = {
  version: 58,
  name: 'room_templates',
  sql: `
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS template_id text;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS template_version text;
`,
};

/**
 * Migration 62 `room_member_name_keys`: indexed mention keys per member, so an @mention in a big
 * room loads only the members it can match (server/wake/hooks.ts roomPosted) instead of every
 * member. name_key and slug_key are nameKeyOf and slugOf (server/wake/mentions.ts) of the
 * member's display name: the agent's name in its owner's workspace, or a person's display_name.
 * They are computed in the application (Unicode NFKC folding), so SQL only ever clears them:
 * NULL means "not known", and a member with NULL keys is always a candidate. Triggers clear them
 * (and bump name_rev) whenever the source name can have changed, so a non-NULL key is never
 * stale; roomPosted fills NULL keys of active members, guarded by name_rev. No backfill is
 * needed: existing rows start NULL and are filled by the first @mention in their room.
 */
export const roomMemberNameKeysMigration: Migration = {
  version: 62,
  name: 'room_member_name_keys',
  sql: `
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS name_key text;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS slug_key text;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS name_rev integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS room_members_name_key ON room_members(room_id, name_key);
CREATE INDEX IF NOT EXISTS room_members_slug_key ON room_members(room_id, slug_key);
CREATE INDEX IF NOT EXISTS room_members_id_key ON room_members(room_id, lower(agent_id));
CREATE OR REPLACE FUNCTION room_members_name_keys_reset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.name_key := NULL;
  NEW.slug_key := NULL;
  NEW.name_rev := OLD.name_rev + 1;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS room_members_name_keys_reset ON room_members;
CREATE TRIGGER room_members_name_keys_reset BEFORE UPDATE ON room_members FOR EACH ROW
  WHEN (OLD.display_name IS DISTINCT FROM NEW.display_name OR OLD.kind IS DISTINCT FROM NEW.kind
    OR OLD.owner_id IS DISTINCT FROM NEW.owner_id)
  EXECUTE FUNCTION room_members_name_keys_reset();
CREATE OR REPLACE FUNCTION workspaces_agent_names_reset() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  before jsonb := CASE WHEN jsonb_typeof(OLD.data->'agents') = 'array' THEN OLD.data->'agents' ELSE '[]'::jsonb END;
  after jsonb := CASE WHEN jsonb_typeof(NEW.data->'agents') = 'array' THEN NEW.data->'agents' ELSE '[]'::jsonb END;
BEGIN
  IF (SELECT jsonb_object_agg(COALESCE(a->>'id', ''), a->'name') FROM jsonb_array_elements(before) a)
     IS DISTINCT FROM
     (SELECT jsonb_object_agg(COALESCE(a->>'id', ''), a->'name') FROM jsonb_array_elements(after) a) THEN
    UPDATE room_members SET name_key = NULL, slug_key = NULL, name_rev = name_rev + 1
      WHERE owner_id = NEW.operator_id AND kind = 'agent';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS workspaces_agent_names_reset ON workspaces;
CREATE TRIGGER workspaces_agent_names_reset AFTER UPDATE ON workspaces FOR EACH ROW
  WHEN (OLD.data->'agents' IS DISTINCT FROM NEW.data->'agents')
  EXECUTE FUNCTION workspaces_agent_names_reset();
`,
};

/**
 * Migration 69 `room_member_name_key_prefix`: "starts with" indexes for the members search
 * (service.ts memberSearch, `name_key LIKE 'ann%'`). A plain btree on text serves LIKE prefixes
 * only under the C collation; with any other database collation the planner cannot use the
 * migration 62 indexes for them. text_pattern_ops compares byte-wise whatever the collation, so
 * these serve the prefix match everywhere (and equality too). Migration 62's indexes stay for the
 * @mention lookups.
 */
export const roomMemberNameKeyPrefixMigration: Migration = {
  version: 69,
  name: 'room_member_name_key_prefix',
  sql: `
CREATE INDEX IF NOT EXISTS room_members_name_key_prefix ON room_members(room_id, name_key text_pattern_ops);
CREATE INDEX IF NOT EXISTS room_members_slug_key_prefix ON room_members(room_id, slug_key text_pattern_ops);
`,
};

/** Idempotent; call before runMigrations (after the cross-connections migration). */
export function registerRoomsMigration(): void {
  registerMigration(roomsMigration);
  // 21: room_members.last_read_seq (read cursor) and last_active_at (member status),
  // server/rooms/member-status.ts.
  registerMemberActivityMigration();
  // 31: people in rooms (kind, display name, host toggles) and short join codes (person.ts).
  registerRoomPeopleMigration();
  // 32: member cap 100 for open rooms still at the old default of 20 (cap-schema.ts).
  registerRoomMemberCap100Migration();
  // 33: server-written system lines in the thread (sender_kind 'system', system-lines.ts).
  registerRoomSystemLinesMigration();
  // 34: member cap 10,000 for open rooms still at the previous default of 100 (cap-schema.ts).
  registerRoomMemberCap10000Migration();
  // 35: host delete (tombstone), removal reason and rejoin, per-member mute (management-schema.ts).
  registerRoomManagementMigration();
  // 36: normal rooms back to 100 members (open rooms above 100: GREATEST(100, active); cap-schema.ts).
  registerRoomMemberCapStandard100Migration();
  // 37: a removed no-account guest's join source is blocked from that room (management-schema.ts).
  registerRoomGuestBlocksMigration();
  // 38: a member mutes a room's wake-ups for itself (management-schema.ts).
  registerRoomNotificationMuteMigration();
  // 55: full-text search inside a room (generated tsvector + GIN index; search-schema.ts).
  registerRoomMessageSearchMigration();
  // 58: the built-in room template a room started from (shared/room-templates.ts).
  registerMigration(roomTemplatesMigration);
  // 62: indexed mention keys per member (server/wake/hooks.ts roomPosted).
  registerMigration(roomMemberNameKeysMigration);
  // 63: private messages between room members (messages.room_id, rooms.members_may_dm;
  // server/messaging/room-direct.ts).
  registerRoomDirectMessagesMigration();
  // 65: AI self-reported status (says) and the host's bulk "Mute all AIs" (member-says.ts).
  registerMigration(memberSaysMigration);
  // 69: collation-proof "starts with" indexes for the members search (service.ts memberSearch).
  registerMigration(roomMemberNameKeyPrefixMigration);
}
