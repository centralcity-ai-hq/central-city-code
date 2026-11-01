import { registerMigration } from '../migrations.js';
import '../autonomy/expiry-schema.js';
export function registerRoomInviteMigration() {
  registerMigration({
    version: 18,
    name: 'room_only_invites',
    sql: `
CREATE TABLE IF NOT EXISTS room_invite_bootstrap (
 handle_hash text PRIMARY KEY, code_hash text NOT NULL, source_hash text NOT NULL,
 expires_at bigint NOT NULL, used_at bigint
);
CREATE INDEX IF NOT EXISTS room_invite_bootstrap_expiry ON room_invite_bootstrap(expires_at);
CREATE INDEX IF NOT EXISTS room_invite_bootstrap_code ON room_invite_bootstrap(code_hash,expires_at);
CREATE INDEX IF NOT EXISTS room_invite_bootstrap_source ON room_invite_bootstrap(source_hash,expires_at);
CREATE TABLE IF NOT EXISTS room_invite_credentials (
 token_hash text PRIMARY KEY, operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
 agent_id text NOT NULL UNIQUE REFERENCES unclaimed_agent_expiry(agent_id) ON DELETE CASCADE,
 room_id text NOT NULL REFERENCES rooms(id), host_owner_id text NOT NULL REFERENCES operators(id),
 source_hash text NOT NULL, created_at bigint NOT NULL, expires_at bigint NOT NULL, revoked_at bigint
);
-- Membership is historical identity data, like room messages and events. Keep tombstones
-- after an empty anonymous operator is evicted rather than retaining a dangling FK.
ALTER TABLE room_members DROP CONSTRAINT IF EXISTS room_members_owner_id_fkey;
CREATE OR REPLACE FUNCTION retire_room_invite_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE room_members SET removed_at=OLD.expires_at, removed_by='invitation expired'
 WHERE room_id=OLD.room_id AND agent_id=OLD.agent_id AND owner_id=OLD.operator_id AND removed_at IS NULL;
 RETURN OLD;
END;
$$;
CREATE TRIGGER room_invite_retire BEFORE DELETE ON room_invite_credentials
 FOR EACH ROW EXECUTE FUNCTION retire_room_invite_membership();
CREATE INDEX IF NOT EXISTS room_invite_credentials_source ON room_invite_credentials(source_hash,expires_at);
CREATE INDEX IF NOT EXISTS room_invite_credentials_host ON room_invite_credentials(host_owner_id,expires_at);
`,
  });
  // The inbox_floor column of the earlier rejoin design. Rejoins no longer read it, but databases
  // that applied this version must still find it registered (the runner refuses unknown versions),
  // so it stays, unchanged.
  registerMigration({
    version: 271,
    name: 'room_invite_inbox_floor',
    sql: `ALTER TABLE room_invite_credentials ADD COLUMN IF NOT EXISTS inbox_floor bigint NOT NULL DEFAULT 0;`,
  });
  // The hash of the guest's recovery code: a rejoin link is redeemed only together with it. Null
  // for a guest that joined before (it gets one at its next renew).
  registerMigration({
    version: 272,
    name: 'room_invite_recovery',
    sql: `ALTER TABLE room_invite_credentials ADD COLUMN IF NOT EXISTS recovery_hash text;`,
  });
  // Durable guest credentials: absolute_expires_at caps the sliding expiry (null: created_at plus
  // 30 days); prev_token_hash/prev_until keep the previous credential of a renew readable for a
  // short grace period.
  registerMigration({
    version: 308,
    name: 'room_invite_durable_credentials',
    sql: `
ALTER TABLE room_invite_credentials ADD COLUMN IF NOT EXISTS absolute_expires_at bigint;
ALTER TABLE room_invite_credentials ADD COLUMN IF NOT EXISTS prev_token_hash text;
ALTER TABLE room_invite_credentials ADD COLUMN IF NOT EXISTS prev_until bigint;
CREATE INDEX IF NOT EXISTS room_invite_credentials_prev ON room_invite_credentials(prev_token_hash) WHERE prev_token_hash IS NOT NULL;
`,
  });
}
