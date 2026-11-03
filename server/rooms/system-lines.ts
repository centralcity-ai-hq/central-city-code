import { randomUUID } from 'node:crypto';
import type { Transaction as Tx } from '../database.js';
import { registerMigration, type Migration } from '../migrations.js';
import { cleanName } from './person.js';
import { agentsArraySql } from '../agent-rows/sql.js';

/**
 * Room system lines (task and membership changes appear as short lines in
 * the thread). The server writes them, in the same transaction as the change, for a member leaving,
 * a removal, the room closing and task changes (created, claimed, submitted, accepted, sent back,
 * cancelled). They are plain language, never carry ids or tokens, and are stamped
 * `sender_kind: 'system'` so clients can style them.
 *
 * A system line never wakes anyone, is never scanned for @mentions and never triggers an automatic
 * reply: it is inserted directly, without the post hook (wake/hooks.ts roomPosted). Readers see it
 * on their next read like any message. It never blocks the change it reports: a full room simply
 * gets no line.
 */
export const SYSTEM_SENDER = {
  agentId: 'system',
  ownerId: 'system',
  name: 'Central City',
  ownerLabel: '',
} as const;

/**
 * Migration 33 `room_system_lines`: widen the
 * room_messages.sender_kind CHECK of migration 31 to allow 'system'. NOT VALID like the original
 * (enforced for new rows, no scan).
 */
export const roomSystemLinesMigration: Migration = {
  version: 33,
  name: 'room_system_lines',
  sql: `
ALTER TABLE room_messages DROP CONSTRAINT IF EXISTS room_messages_sender_kind_check;
ALTER TABLE room_messages ADD CONSTRAINT room_messages_sender_kind_check
  CHECK (sender_kind IN ('agent','person','system')) NOT VALID;
`,
};

/** Idempotent; registered by registerRoomsMigration (rooms/schema.ts) after migration 31. */
export function registerRoomSystemLinesMigration(): void {
  registerMigration(roomSystemLinesMigration);
}

/** A member's display label for a line: sanitized, short, never an id. */
export function lineName(name: string | null | undefined, fallback = 'A member'): string {
  const clean = cleanName(name ?? '', 64);
  return clean || fallback;
}

/** A task title for a line: one line, at most 80 characters. */
export function lineTitle(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/** The label of a room member (person display name, or the agent's name), sanitized. */
export async function memberLabel(
  q: Pick<Tx, 'query'>,
  roomId: string,
  agentId: string | null | undefined,
): Promise<string> {
  if (!agentId) return 'A member';
  const row = (
    await q.query<{ kind: string; display_name: string | null; name: string | null }>(
      `SELECT m.kind, m.display_name,
          (SELECT a->>'name' FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(${agentsArraySql('w.operator_id', 'w.data')}) a
            WHERE w.operator_id=m.owner_id AND a->>'id'=m.agent_id LIMIT 1) AS name
        FROM room_members m WHERE m.room_id=$1 AND m.agent_id=$2`,
      [roomId, agentId],
    )
  ).rows[0];
  if (!row) return 'A member';
  return row.kind === 'person'
    ? lineName(row.display_name, 'A person')
    : lineName(row.name, 'A member');
}

/**
 * Appends one system line to a room inside the caller's transaction. Takes the room row lock
 * (seq allocation); callers that also lock task rows take the room lock first. Returns the seq,
 * or null when the room is at its message limit (the change still happens, without a line).
 */
export async function postSystemLine(
  tx: Pick<Tx, 'query'>,
  roomId: string,
  text: string,
  time: number,
  messagesPerRoom: number,
  /** The owner whose own action this line reports (migration 334), when one did; else null. */
  actorOwnerId: string | null = null,
): Promise<number | null> {
  const seq = (
    await tx.query<{ seq: string | number }>(
      'UPDATE rooms SET next_seq=next_seq+1 WHERE id=$1 AND next_seq <= $2 RETURNING next_seq-1 AS seq',
      [roomId, messagesPerRoom],
    )
  ).rows[0]?.seq;
  if (seq === undefined) return null;
  await tx.query(
    `INSERT INTO room_messages(room_id,seq,id,sender_agent_id,sender_owner_id,sender_name,sender_owner_label,parts,created_at,format,sender_kind,auto_reply,actor_owner_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'plain','system',NULL,$10)`,
    [
      roomId,
      Number(seq),
      randomUUID(),
      SYSTEM_SENDER.agentId,
      SYSTEM_SENDER.ownerId,
      SYSTEM_SENDER.name,
      SYSTEM_SENDER.ownerLabel,
      JSON.stringify([{ type: 'text', text }]),
      time,
      actorOwnerId,
    ],
  );
  return Number(seq);
}
