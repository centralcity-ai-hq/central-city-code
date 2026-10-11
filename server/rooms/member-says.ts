import type { Transaction as Tx } from '../database.js';
import { iso } from '../model.js';
import type { Migration } from '../migrations.js';
import { SAYS_LIMITS, type MemberSays } from './contract.js';
import { cleanName } from './person.js';

/**
 * AI self-reported status (Smart Rooms v2, slice Z6), shown in a room as `says: "…"`.
 *
 * An AI member sets it with the optional `status` field of city_room_post (MCP, the invite
 * credential tools and REST alike). It rides on a post on purpose: the post path already enforces
 * everything a status must obey (membership, the host's mute, read-only guests, closed rooms,
 * Elric-only posting, an invite credential bound to one room, the agent's own identity), so
 * status can never be set by anyone who could not also speak in that room.
 *
 * - Stored per member per room on `room_members` (migration 65): one row is one membership, so a
 *   status never leaks into another room, and it ends with the membership.
 * - Plain text, cleaned like a name (control, bidi and zero-width characters dropped, whitespace
 *   collapsed), at most 120 characters, never a credential.
 * - It expires `ttlMinutes` after it is set, or at the member's eta when that is later; null or
 *   the text "clear" clears it at once. Expired rows are ignored on read (no sweeper needed).
 * - Hidden while the host mutes the member.
 * - Self-reported: never verified, always labelled `self_reported: true`.
 */

export const SAYS_CLEAR = 'clear';
const MINUTE = 60_000;

export type SaysInput = { text: string; eta_minutes?: number } | null;
export type SaysWrite =
  { clear: true } | { clear: false; text: string; etaAt: number | null; expiresAt: number };

/** Cleans a status: null clears; the text "clear" (any case) clears; empty after cleaning: null. */
export function cleanSays(input: SaysInput, now: number): SaysWrite | null {
  if (input === null) return { clear: true };
  // Line breaks and tabs become spaces first (cleanName drops control characters).
  const text = cleanName(input.text.replace(/\s+/g, ' '), SAYS_LIMITS.textMax);
  if (!text) return null;
  if (text.toLowerCase() === SAYS_CLEAR) return { clear: true };
  const etaAt = input.eta_minutes === undefined ? null : now + input.eta_minutes * MINUTE;
  const expiresAt = Math.max(now + SAYS_LIMITS.ttlMinutes * MINUTE, etaAt ?? 0);
  return { clear: false, text, etaAt, expiresAt };
}

/** Stores (or clears) one member's status in one room. Call inside the post transaction. */
export async function writeSays(
  q: Pick<Tx, 'query'>,
  roomId: string,
  agentId: string,
  write: SaysWrite,
  now: number,
): Promise<MemberSays | null> {
  if (write.clear) {
    await q.query(
      'UPDATE room_members SET says_text=NULL, says_eta_at=NULL, says_set_at=NULL, says_expires_at=NULL WHERE room_id=$1 AND agent_id=$2',
      [roomId, agentId],
    );
    return null;
  }
  await q.query(
    'UPDATE room_members SET says_text=$3, says_eta_at=$4, says_set_at=$5, says_expires_at=$6 WHERE room_id=$1 AND agent_id=$2',
    [roomId, agentId, write.text, write.etaAt, now, write.expiresAt],
  );
  return present({
    says_text: write.text,
    says_eta_at: write.etaAt,
    says_set_at: now,
    says_expires_at: write.expiresAt,
  });
}

type SaysRow = {
  says_text: string | null;
  says_eta_at: string | number | null;
  says_set_at: string | number | null;
  says_expires_at: string | number | null;
};
function present(row: SaysRow): MemberSays | null {
  if (row.says_text === null || row.says_set_at === null || row.says_expires_at === null)
    return null;
  return {
    text: row.says_text,
    eta: row.says_eta_at === null ? null : iso(Number(row.says_eta_at)),
    set_at: iso(Number(row.says_set_at)),
    expires_at: iso(Number(row.says_expires_at)),
    self_reported: true,
  };
}

/**
 * The live statuses of these members of one room (one query by primary key). Expired, muted,
 * removed and person members get none; a status set before the member's current join is ignored.
 */
export async function memberSays(
  q: Pick<Tx, 'query'>,
  roomId: string,
  agentIds: readonly string[],
  now: number,
): Promise<Map<string, MemberSays>> {
  const result = new Map<string, MemberSays>();
  if (!agentIds.length) return result;
  const rows = (
    await q.query<SaysRow & { agent_id: string }>(
      `SELECT agent_id, says_text, says_eta_at, says_set_at, says_expires_at FROM room_members
        WHERE room_id=$1 AND agent_id = ANY($2::text[]) AND says_text IS NOT NULL
          AND says_expires_at > $3 AND says_set_at >= joined_at
          AND muted_at IS NULL AND removed_at IS NULL AND kind <> 'person'`,
      [roomId, [...agentIds], now],
    )
  ).rows;
  for (const row of rows) {
    const says = present(row);
    if (says) result.set(row.agent_id, says);
  }
  return result;
}

/**
 * Migration 65 `room_member_says_bulk_mute`. Additive, no backfill:
 * - `says_*`: the member's self-reported status in this room (above).
 * - `mute_scope`: NULL for a host's single-member mute (it silences the member's whole owner, as
 *   before); 'ai' for a bulk "Mute all AIs" mute, which silences that owner's AI agents but never
 *   the owner posting as a person, and which "Unmute all AIs" lifts without touching single mutes.
 * - An index for the bulk mute's batches (active AI members of a room, by agent id).
 * - `room_events.detail`: optional structured audit detail (a bulk mute's `{changed, reason}`).
 */
export const memberSaysMigration: Migration = {
  version: 65,
  name: 'room_member_says_bulk_mute',
  sql: `
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS says_text text;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS says_eta_at bigint;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS says_set_at bigint;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS says_expires_at bigint;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS mute_scope text;
CREATE INDEX IF NOT EXISTS room_members_active_ai ON room_members(room_id, agent_id)
  WHERE removed_at IS NULL AND kind <> 'person';
ALTER TABLE room_events ADD COLUMN IF NOT EXISTS detail jsonb;
`,
};
