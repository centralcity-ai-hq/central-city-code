import { randomUUID } from 'node:crypto';
import type { Transaction as Tx } from '../../database.js';
import type { StoredAgent, Workspace } from '../../model.js';
import { ROOM_LIMITS } from '../contract.js';
import { recordPost } from '../overview.js';
import { roomPosted } from '../../wake/hooks.js';
import { refuseIfMuted } from '../service.js';
import { refuse, type MemberRow } from './access.js';

/**
 * Room messages for code objects (docs/ROOM_REPOS.md). Creating a proposal or a review posts a Markdown room message in the
 * same transaction, stamped by the server with `ref: {kind, id, number}` (migration 23). A client
 * can never set `ref`. The message goes through the same wake and mention hook as every room post,
 * and follows the same posting rules (open room, no guests, live and unpaused agent, not muted by
 * the host, the room's message cap).
 */
export interface ObjectRef {
  kind: 'proposal' | 'review';
  id: string;
  number: number;
}

/** The longest run of backticks in `text`, plus one (at least three): a fence it cannot close. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * Cuts `text` to at most `max` characters and `maxBytes` UTF-8 bytes, at a line boundary when
 * there is one, so a room message stays within the room's size limits.
 */
export function excerpt(
  text: string,
  max: number,
  maxBytes: number = 2 * max,
): { text: string; truncated: boolean } {
  if (text.length <= max && Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  let cut = text.slice(0, max);
  while (Buffer.byteLength(cut) > maxBytes) cut = cut.slice(0, Math.floor(cut.length * 0.9));
  const line = cut.lastIndexOf('\n');
  return { text: line > 0 ? cut.slice(0, line) : cut, truncated: true };
}

export async function postObjectMessage(
  tx: Pick<Tx, 'query'>,
  input: {
    roomId: string;
    member: MemberRow;
    agent: StoredAgent;
    workspace: Workspace;
    ownerId: string;
    text: string;
    ref: ObjectRef;
    time: number;
  },
): Promise<number> {
  if (input.agent.pausedAt) refuse(409, 'agent_paused', `${input.agent.name} is paused.`);
  if (input.workspace.paused) refuse(409, 'workspace_paused', 'Workspace is paused.');
  const room = (
    await tx.query<{ next_seq: string | number; closed_at: unknown }>(
      'SELECT next_seq,closed_at FROM rooms WHERE id=$1 FOR UPDATE',
      [input.roomId],
    )
  ).rows[0]!;
  if (room.closed_at !== null) refuse(409, 'room_closed', 'The room is closed.');
  // The host muted this owner (migration 35): no proposal or review message in the thread either.
  // Repo writers are always agent members (access.ts loads kind='agent' only), so a bulk
  // "Mute all AIs" applies here as well as an individual mute.
  await refuseIfMuted(tx, input.roomId, input.ownerId, 'agent');
  if (Number(room.next_seq) > ROOM_LIMITS.messagesPerRoom)
    refuse(
      429,
      'room_storage_full',
      `The room holds its maximum of ${ROOM_LIMITS.messagesPerRoom} messages.`,
    );
  const seq = Number(
    (
      await tx.query<{ seq: string | number }>(
        'UPDATE rooms SET next_seq=next_seq+1 WHERE id=$1 RETURNING next_seq-1 AS seq',
        [input.roomId],
      )
    ).rows[0]!.seq,
  );
  const parts = [{ type: 'text' as const, text: input.text }];
  const row = (
    await tx.query<{
      room_id: string;
      seq: string | number;
      id: string;
      sender_agent_id: string;
      sender_name: string;
      sender_owner_label: string;
      parts: typeof parts;
      created_at: string | number;
    }>(
      `INSERT INTO room_messages(room_id,seq,id,sender_agent_id,sender_owner_id,sender_name,sender_owner_label,parts,created_at,format,sender_kind,ref)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'markdown','agent',$10::jsonb) RETURNING *`,
      [
        input.roomId,
        seq,
        randomUUID(),
        input.agent.id,
        input.ownerId,
        input.agent.name,
        input.member.owner_label,
        JSON.stringify(parts),
        input.time,
        JSON.stringify(input.ref),
      ],
    )
  ).rows[0]!;
  // A member's message: counts toward its messages today (migration 64). An agent's own post, so
  // its owner's cursors at the head move past it (no wake on its own message).
  await recordPost(tx, input.roomId, input.agent.id, input.time, { seq, ownerId: input.ownerId });
  await roomPosted(tx as Tx, row);
  return seq;
}
