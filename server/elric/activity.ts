import type { Transaction as Tx } from '../database.js';

/**
 * The owner's open pending actions (docs/ELRIC.md "Pending actions"), for the console's approval
 * list and the in-room approval card: only `pending` rows that have not expired, newest first.
 * Only what the owner approves leaves the server: the task title (`summary`) and its description
 * (`detail`), both cleaned and capped, the tool name and the hash it must name to approve; no
 * other stored argument. The room comes with
 * its name only while the owner can still see it, like the turn log.
 */
export interface PendingView {
  id: string;
  tool: string;
  summary: string | null;
  /** The task description the action would create, cleaned (line breaks kept); null when none. */
  detail: string | null;
  args_hash: string;
  room: { id: string; name: string } | null;
  created_at: string;
  expires_at: string;
}

/** Longest summary shown for a pending action (the longest task title Elric may propose). */
export const PENDING_SUMMARY_CHARS = 200;
/** Longest detail shown for a pending action (the longest task body Elric may propose). */
export const PENDING_DETAIL_CHARS = 4_000;
/** Most open pending actions listed at once. */
export const PENDING_LIST_LIMIT = 50;

/** A task title only, without control or bidi characters, capped; nothing else of the args. */
export function pendingSummary(tool: string, args: unknown): string | null {
  if (tool !== 'room_task_create' || !args || typeof args !== 'object') return null;
  const title = (args as { title?: unknown }).title;
  if (typeof title !== 'string') return null;
  const clean = title
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  const chars = Array.from(clean);
  return chars.length > PENDING_SUMMARY_CHARS
    ? `${chars.slice(0, PENDING_SUMMARY_CHARS - 1).join('')}…`
    : clean;
}

/**
 * A task body, so the owner sees everything the task would say before approving: control, bidi
 * and zero-width characters removed (line breaks kept, at most one blank line), capped.
 */
export function pendingDetail(tool: string, args: unknown): string | null {
  if (tool !== 'room_task_create' || !args || typeof args !== 'object') return null;
  const body = (args as { body?: unknown }).body;
  if (typeof body !== 'string') return null;
  const clean = body
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
      ' ',
    )
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean) return null;
  const chars = Array.from(clean);
  return chars.length > PENDING_DETAIL_CHARS
    ? `${chars.slice(0, PENDING_DETAIL_CHARS - 1).join('')}…`
    : clean;
}

type PendingRow = {
  id: string;
  tool: string;
  args: unknown;
  args_hash: string;
  room_id: string;
  room_name: string | null;
  created_at: string | number;
  expires_at: string | number;
};

export async function listPendingActions(
  q: Pick<Tx, 'query'>,
  ownerId: string,
  time: number,
): Promise<{ pending: PendingView[] }> {
  const rows = (
    await q.query<PendingRow>(
      `SELECT p.id, p.tool, p.args, p.args_hash, p.room_id, p.created_at, p.expires_at,
              (SELECT r.name FROM rooms r
                WHERE r.id=p.room_id AND r.deleted_at IS NULL
                  AND EXISTS (SELECT 1 FROM room_members m WHERE m.room_id=r.id
                                AND m.owner_id=p.owner_id AND m.removed_at IS NULL)) AS room_name
         FROM elric_pending_actions p
        WHERE p.owner_id=$1 AND p.status='pending' AND p.expires_at > $2
        ORDER BY p.created_at DESC, p.id DESC LIMIT $3`,
      [ownerId, time, PENDING_LIST_LIMIT],
    )
  ).rows;
  return {
    pending: rows.map((row) => ({
      id: row.id,
      tool: row.tool,
      summary: pendingSummary(row.tool, row.args),
      detail: pendingDetail(row.tool, row.args),
      args_hash: row.args_hash,
      room: row.room_name === null ? null : { id: row.room_id, name: row.room_name },
      created_at: new Date(Number(row.created_at)).toISOString(),
      expires_at: new Date(Number(row.expires_at)).toISOString(),
    })),
  };
}

/**
 * Whether this owner's action is already rejected: a repeated reject is answered like the first
 * (idempotent), while a foreign or unknown id stays a uniform not_found.
 */
export async function alreadyRejected(
  q: Pick<Tx, 'query'>,
  ownerId: string,
  id: string,
): Promise<boolean> {
  const row = (
    await q.query<{ status: string }>(
      'SELECT status FROM elric_pending_actions WHERE id=$1 AND owner_id=$2',
      [id, ownerId],
    )
  ).rows[0];
  return row?.status === 'rejected';
}
