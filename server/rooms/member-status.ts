import { createHmac, hkdfSync } from 'node:crypto';
import type { Transaction as Tx } from '../database.js';
import { iso } from '../model.js';
import { registerMigration, type Migration } from '../migrations.js';

/**
 * Room member status (roadmap P2a, Codex feedback C4; docs/MEMBER_STATUS.md).
 *
 * Status is derived only from facts the server records itself, never from anything a client
 * claims about itself:
 * - `room_members.last_active_at` (migration 21): the last room read, post or members call the
 *   server served for that member agent through an AI credential (MCP /mcp and /mcp/open, the
 *   assistant tool REST and invite credentials). Posts count from the owner console too; console
 *   reads do not, so a person looking at the room never makes their AI look active.
 * - `room_invite_credentials.expires_at` / `revoked_at`: an invited guest whose room credential
 *   expired or was revoked has `access_expired` until the expiry sweep retires its membership.
 * - `joined_at`: joining is activity, so a member that never called again is dated from its join.
 *
 * Runtime presence (`agent_presence.last_seen_at`) is deliberately not used: it is a workspace-wide
 * heartbeat, so showing it to another owner in a room would reveal activity outside the room.
 *
 * Writes are throttled per member (`TOUCH_THROTTLE_MS`), so long-polling AIs write at most about
 * twice a minute whatever their read rate.
 */
export const MEMBER_STATUS = {
  /** Seen within 5 minutes: active. An AI long-polling city_room_read stays active. */
  activeMs: 5 * 60_000,
  /** Seen within 1 hour: idle. Older: offline. */
  idleMs: 60 * 60_000,
  /** At most one activity write per member per 30 seconds. */
  touchThrottleMs: 30_000,
  /**
   * Viewers without the exact time (neither host nor owner) get status on a coarser clock: times
   * snap to 1-minute buckets shifted by a secret per-member offset, so the active→idle edge
   * reveals the last activity only to within a minute.
   */
  coarseBucketMs: 60_000,
} as const;

export type MemberStatus = 'active' | 'idle' | 'offline' | 'access_expired';
/** Short labels for UIs (text next to the dot, so status is never colour only). */
export const MEMBER_STATUS_LABEL: Record<MemberStatus, string> = {
  active: 'Active',
  idle: 'Idle',
  offline: 'Offline',
  access_expired: 'Access expired',
};

/**
 * "Active now": the one definition behind both the room overview's `ais_active_now` count and
 * each member's `active_now` flag (the header badge and the Active-now list). An AI member (any
 * non-person member, Elric and the host's own agent included) counts when it is still listed
 * (in the room, agent not revoked), its room credential (invite guests) is still valid, and its
 * last room activity (or join) is at or after `activeNowSince(now)`: the start of the minute
 * 5 minutes ago (`MEMBER_STATUS.activeMs`). An AI long-polling the room records activity at least
 * every 30 seconds (`touchThrottleMs`), so a connected AI always counts. The window starts on a
 * whole minute, so it reveals activity only to the minute, like the overview always did.
 */
export function activeNowSince(now: number): number {
  return Math.floor((now - MEMBER_STATUS.activeMs) / 60_000) * 60_000;
}

export function isActiveNow(input: StatusInput & { kind?: string | null }): boolean {
  if (input.kind === 'person') return false;
  const credential = input.credential;
  if (credential && (credential.revokedAt !== null || credential.expiresAt <= input.now))
    return false;
  return lastActivity(input) >= activeNowSince(input.now);
}

export interface MemberStatusFields {
  /** Coarse, server-derived: 'active' | 'idle' | 'offline' | 'access_expired'. */
  status: MemberStatus;
  /**
   * Last server-recorded room activity (minute precision). Only the room host and the member's
   * own owner see it; other members get null (they see the coarse status only).
   */
  last_active_at: string | null;
  /** The shared "active now" rule (isActiveNow), the same for every viewer. */
  active_now: boolean;
}

export interface StatusInput {
  /** Epoch ms of the last recorded room activity, or null when none was recorded. */
  lastActiveAt: number | null;
  joinedAt: number;
  /** The member's room invite credential, when it joined through an open invite. */
  credential?: { expiresAt: number; revokedAt: number | null } | null;
  now: number;
}

/** The last activity the server knows of: recorded activity, else the join. */
export function lastActivity(input: Pick<StatusInput, 'lastActiveAt' | 'joinedAt'>): number {
  return Math.max(input.lastActiveAt ?? 0, input.joinedAt);
}

export function deriveMemberStatus(input: StatusInput): MemberStatus {
  const credential = input.credential;
  if (credential && (credential.revokedAt !== null || credential.expiresAt <= input.now))
    return 'access_expired';
  const age = input.now - lastActivity(input);
  if (age < MEMBER_STATUS.activeMs) return 'active';
  if (age < MEMBER_STATUS.idleMs) return 'idle';
  return 'offline';
}

/** Minute precision: enough for "last seen", without exposing exact request timing. */
export function coarseTime(ms: number): string {
  return iso(Math.floor(ms / 60_000) * 60_000);
}

/** Snaps a time down to its bucket boundary; boundaries are shifted by `offset` (0..bucket). */
export function snap(ms: number, offset: number, bucket = MEMBER_STATUS.coarseBucketMs): number {
  return Math.floor((ms - offset) / bucket) * bucket + offset;
}

/** A dedicated subkey (HKDF of the rooms root secret), cached per secret. */
const bucketKeys = new Map<string, Buffer>();
function bucketKey(secret: string): Buffer {
  let key = bucketKeys.get(secret);
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', secret, '', 'central-city/member-status-bucket/v1', 32));
    bucketKeys.set(secret, key);
  }
  return key;
}
/**
 * A per-member bucket offset in [0, bucket), keyed with a dedicated HKDF subkey of the rooms
 * secret, so another member cannot align to it.
 */
export function bucketOffset(secret: string, roomId: string, agentId: string): number {
  const digest = createHmac('sha256', bucketKey(secret)).update(`${roomId}:${agentId}`).digest();
  return digest.readUInt32BE(0) % MEMBER_STATUS.coarseBucketMs;
}

/**
 * The status fields one viewer may see for one member. `exact` is true for the room host and
 * for the member's own owner. Everyone else gets the status on the coarse clock (`offset` is the
 * member's bucket offset): activity, join and "now" all snap to the same shifted 1-minute grid,
 * so idle and offline edges fall only on bucket boundaries. Credential expiry is not activity
 * and stays exact.
 */
export function presentMemberStatus(
  input: StatusInput & { kind?: string | null },
  exact: boolean,
  offset = 0,
): MemberStatusFields {
  // The same minute-aligned rule as the overview count, so the badge equals the list. For an AI,
  // "active" is exactly active_now, so the status dot never disagrees with the Active-now list.
  const active_now = isActiveNow(input);
  const aligned = (status: MemberStatus): MemberStatus =>
    input.kind === 'person' || status === 'access_expired'
      ? status
      : active_now
        ? 'active'
        : status === 'active'
          ? 'idle'
          : status;
  if (exact)
    return {
      status: aligned(deriveMemberStatus(input)),
      last_active_at: coarseTime(lastActivity(input)),
      active_now,
    };
  return {
    status: aligned(
      deriveMemberStatus({
        ...input,
        lastActiveAt: input.lastActiveAt === null ? null : snap(input.lastActiveAt, offset),
        joinedAt: snap(input.joinedAt, offset),
        now: snap(input.now, offset),
        credential: input.credential
          ? {
              ...input.credential,
              // Compare expiry against the real clock, not the snapped one.
              expiresAt: input.credential.expiresAt - (input.now - snap(input.now, offset)),
            }
          : input.credential,
      }),
    ),
    last_active_at: null,
    active_now,
  };
}

type Row = {
  agent_id: string;
  owner_id: string;
  joined_at: string | number;
  kind?: string | null;
};
type Room = { id: string; host_owner_id: string };

/**
 * Status fields for the given member rows as seen by `viewerOperatorId`. One query for the
 * activity column and one for invite credentials, both by primary key or unique index.
 */
export async function memberStatuses(
  q: Pick<Tx, 'query'>,
  room: Room,
  rows: readonly Row[],
  viewerOperatorId: string,
  now: number,
  /** Keys the per-member bucket offsets for non-exact viewers (the rooms secret). */
  secret: string,
): Promise<Map<string, MemberStatusFields>> {
  const ids = rows.map((row) => row.agent_id);
  const result = new Map<string, MemberStatusFields>();
  if (!ids.length) return result;
  const active = new Map<string, number | null>();
  for (const row of (
    await q.query<{ agent_id: string; last_active_at: string | number | null }>(
      'SELECT agent_id,last_active_at FROM room_members WHERE room_id=$1 AND agent_id = ANY($2::text[])',
      [room.id, ids],
    )
  ).rows)
    active.set(row.agent_id, row.last_active_at === null ? null : Number(row.last_active_at));
  const credentials = new Map<string, { expiresAt: number; revokedAt: number | null }>();
  for (const row of (
    await q.query<{
      agent_id: string;
      expires_at: string | number;
      revoked_at: string | number | null;
    }>(
      'SELECT agent_id,expires_at,revoked_at FROM room_invite_credentials WHERE room_id=$1 AND agent_id = ANY($2::text[])',
      [room.id, ids],
    )
  ).rows)
    credentials.set(row.agent_id, {
      expiresAt: Number(row.expires_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    });
  const host = viewerOperatorId === room.host_owner_id;
  for (const row of rows)
    result.set(
      row.agent_id,
      presentMemberStatus(
        {
          lastActiveAt: active.get(row.agent_id) ?? null,
          joinedAt: Number(row.joined_at),
          credential: credentials.get(row.agent_id) ?? null,
          now,
          kind: row.kind ?? null,
        },
        host || row.owner_id === viewerOperatorId,
        bucketOffset(secret, room.id, row.agent_id),
      ),
    );
  return result;
}

/**
 * How every statement that writes several room_members rows of one room locks them: in agent_id
 * order, inside a CTE (a SELECT ending in MEMBER_LOCK_ORDER) before the UPDATE. Two writers that
 * each take rows in their own order (a plain multi-row UPDATE has none) can deadlock.
 */
export const MEMBER_LOCK_ORDER = 'ORDER BY m.agent_id FOR UPDATE OF m';

/**
 * Records room activity for the given member agents (throttled; a no-op for removed members)
 * and, with `readThrough`, advances their read cursor to that seq (never backwards). One
 * statement, and no write at all when neither changes. Call inside the transaction that verified
 * the membership, after the read or post succeeded, so a failed read never moves the cursor.
 *
 * `seen` maps each agent to the `visible_from_seq` the read used. The cursor moves only while that
 * is still current: a history-to-full switch committing mid-read lowers `visible_from_seq` and
 * resets the cursor, and this UPDATE (which waits on that row lock and re-checks the row) then
 * leaves the reset cursor alone, so the newly opened messages still arrive as unread.
 *
 * Lock order: the rows are locked in agent_id order first (`MEMBER_LOCK_ORDER`), the same order as
 * recordPost (overview.ts), so a read touching several of an owner's members and a post moving
 * that owner's cursors never wait on each other in a cycle.
 */
export async function touchMembers(
  q: Pick<Tx, 'query'>,
  roomId: string,
  agentIds: readonly string[],
  time: number,
  readThrough = 0,
  seen: ReadonlyMap<string, number> = new Map(),
): Promise<void> {
  if (!agentIds.length) return;
  const due = time - MEMBER_STATUS.touchThrottleMs;
  const ids = [...agentIds];
  const from = ids.map((id) => (seen.has(id) ? String(seen.get(id)) : null));
  const changes = `(m.last_active_at IS NULL OR m.last_active_at <= $4
             OR (m.last_read_seq < $5 AND m.visible_from_seq = r.seen))`;
  await q.query(
    `WITH locked AS (
       SELECT m.agent_id AS id FROM room_members m
         JOIN unnest($2::text[], $6::bigint[]) AS r(agent_id, seen) ON m.agent_id = r.agent_id
        WHERE m.room_id=$1 AND m.removed_at IS NULL AND ${changes}
        ${MEMBER_LOCK_ORDER})
     UPDATE room_members m
        SET last_read_seq = CASE WHEN m.visible_from_seq = r.seen
                                 THEN GREATEST(m.last_read_seq, $5) ELSE m.last_read_seq END,
            last_active_at = CASE WHEN m.last_active_at IS NULL OR m.last_active_at <= $4
                                  THEN $3 ELSE m.last_active_at END
       FROM locked l, unnest($2::text[], $6::bigint[]) AS r(agent_id, seen)
      WHERE m.room_id=$1 AND m.agent_id = l.id AND m.agent_id = r.agent_id
        AND m.removed_at IS NULL AND ${changes}`,
    [roomId, ids, time, due, readThrough, from],
  );
}

/** Which of these room messages @mention one of `agentIds` (as recorded at post time). */
export async function mentionedMessages(
  q: Pick<Tx, 'query'>,
  agentIds: readonly string[],
  messageIds: readonly string[],
): Promise<Set<string>> {
  if (!agentIds.length || !messageIds.length) return new Set();
  const rows = await q.query<{ source_id: string }>(
    `SELECT DISTINCT source_id FROM mentions
      WHERE agent_id = ANY($1::text[]) AND source_kind='room' AND source_id = ANY($2::text[])`,
    [[...agentIds], [...messageIds]],
  );
  return new Set(rows.rows.map((row) => String(row.source_id)));
}

/**
 * Migration 21 `room_member_cursor_activity` (the
 * read cursor and member activity share one migration). Additive:
 * - `last_read_seq`: the member's read cursor. city_room_read without `since` returns messages
 *   after it (unread by default) and every successful AI read advances it. Existing members are
 *   backfilled to their own last post in the room (anything up to it was certainly seen; later
 *   messages stay unread), and never below their history start. Members that never posted start
 *   at their history start. Marking everything read at migration time was rejected: it would
 *   silently hide messages an AI has not seen.
 * - `last_active_at`: nullable; existing members are backfilled from their last post in the room.
 */
export const memberActivityMigration: Migration = {
  version: 21,
  name: 'room_member_cursor_activity',
  sql: `
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS last_read_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS last_active_at bigint;
UPDATE room_members m
   SET last_active_at = GREATEST(COALESCE(m.last_active_at, 0), s.last_post_at),
       last_read_seq = GREATEST(m.last_read_seq, m.visible_from_seq, s.last_post_seq)
  FROM (SELECT room_id, sender_agent_id, max(created_at) AS last_post_at, max(seq) AS last_post_seq
          FROM room_messages GROUP BY room_id, sender_agent_id) s
 WHERE m.room_id = s.room_id AND m.agent_id = s.sender_agent_id;
UPDATE room_members SET last_read_seq = visible_from_seq WHERE last_read_seq < visible_from_seq;
`,
};

/** Idempotent; registered by registerRoomsMigration (rooms/schema.ts). */
export function registerMemberActivityMigration(): void {
  registerMigration(memberActivityMigration);
}
