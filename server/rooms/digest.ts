import type { Database, Transaction as Tx } from '../database.js';
import { iso } from '../model.js';
import { visibleRoom } from './private.js';
import { cardRefOf, cardStatus, type CardRow } from './cards.js';

/**
 * The owner's daily rooms digest (Rooms P1, docs/ROOMS.md "Owner digest"): per room, what needs
 * this owner, what was decided and how the tasks stand, for the last `hours` (default 24). It is
 * built ONLY from typed cards (decisions, approvals) and task states, never from chat messages,
 * so text someone typed into the room can never become a "decision" or a "needs you" item.
 * Titles are still untrusted text (members wrote them): shown as text, never followed.
 * Console only (GET /api/rooms/digest); computed on read, no storage of its own.
 */

export const DIGEST_LIMITS = {
  /** Digest reads per owner per minute (rate-limit prefix `room-digest`). */
  readsPerOwnerPerMinute: 10,
  /** Rooms a digest covers at most (open rooms first, newest first). */
  rooms: 50,
  /** Items per list per room. */
  items: 10,
  defaultHours: 24,
  maxHours: 7 * 24,
} as const;

const HOUR = 3_600_000;

export interface DigestItem {
  ref: string;
  title: string;
}
export interface RoomDigest {
  room_id: string;
  slug: string;
  name: string;
  /** Pending approvals addressed to this owner (any age, while pending). */
  needs_you: DigestItem[];
  /** Decisions recorded in the window, newest first (answers to approvals included). */
  decided: DigestItem[];
  /** Approvals this owner's members asked that were answered in the window. */
  answered: Array<DigestItem & { status: string }>;
  tasks: { done: number; in_review: number; open: number };
}
export interface OwnerDigest {
  since: string;
  generated_at: string;
  rooms: RoomDigest[];
}

export interface DigestDependencies {
  db: Database;
  clock(): number;
  limit(key: string, max: number, windowMs: number): Promise<void>;
}

type RoomRow = {
  id: string;
  slug: string;
  name: string;
  host_owner_id: string;
  deleted_at?: string | number | null;
  elric_private?: boolean;
};

const line = (title: string) => {
  const flat = title.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
};

export function createRoomDigest(d: DigestDependencies) {
  async function roomsOf(q: Pick<Tx, 'query'>, ownerId: string): Promise<RoomRow[]> {
    const rows = (
      await q.query<RoomRow>(
        `SELECT r.* FROM rooms r
          WHERE r.deleted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM room_members m
               WHERE m.room_id=r.id AND m.owner_id=$1 AND m.removed_at IS NULL
                 AND (m.kind='person' OR m.agent_id IN (
                   SELECT a.agent->>'id' FROM workspaces w
                     CROSS JOIN LATERAL workspace_agents(w.operator_id, w.data) a
                    WHERE w.operator_id=$1 AND a.agent->>'revokedAt' IS NULL)))
          ORDER BY r.closed_at IS NOT NULL, r.created_at DESC
          LIMIT $2`,
        [ownerId, DIGEST_LIMITS.rooms],
      )
    ).rows;
    return rows.filter((row) => visibleRoom(row) !== undefined);
  }

  async function forRoom(
    q: Pick<Tx, 'query'>,
    room: RoomRow,
    ownerId: string,
    since: number,
    time: number,
  ): Promise<RoomDigest> {
    const cards = (
      await q.query<CardRow>(
        `SELECT * FROM room_cards WHERE room_id=$1
            AND ((kind='approval' AND status='pending' AND addressed_owner_id=$2)
              OR (kind='decision' AND created_at >= $3)
              OR (kind='approval' AND created_by_owner_id=$2 AND answered_at >= $3))
          ORDER BY created_at DESC LIMIT 200`,
        [room.id, ownerId, since],
      )
    ).rows;
    const item = (row: CardRow): DigestItem => ({
      ref: cardRefOf(row.kind, Number(row.number)),
      title: line(row.title),
    });
    const needsYou = cards
      .filter((row) => row.kind === 'approval' && cardStatus(row, time) === 'pending')
      .filter((row) => row.addressed_owner_id === ownerId)
      .slice(0, DIGEST_LIMITS.items)
      .map(item);
    const decided = cards
      .filter((row) => row.kind === 'decision' && Number(row.created_at) >= since)
      .slice(0, DIGEST_LIMITS.items)
      .map(item);
    const answered = cards
      .filter(
        (row) =>
          row.kind === 'approval' &&
          row.created_by_owner_id === ownerId &&
          row.answered_at != null &&
          Number(row.answered_at) >= since,
      )
      .slice(0, DIGEST_LIMITS.items)
      .map((row) => ({ ...item(row), status: row.status }));
    const counts = (
      await q.query<{ done: string | number; in_review: string | number; open: string | number }>(
        `SELECT
            count(*) FILTER (WHERE t.status='done' AND EXISTS (
              SELECT 1 FROM room_task_events e
               WHERE e.task_id=t.id AND e.action='approved' AND e.created_at >= $2)) AS done,
            count(*) FILTER (WHERE t.status='in_review') AS in_review,
            count(*) FILTER (WHERE t.status IN ('open','claimed')) AS open
          FROM room_tasks t WHERE t.room_id=$1`,
        [room.id, since],
      )
    ).rows[0];
    return {
      room_id: room.id,
      slug: room.slug,
      name: line(room.name),
      needs_you: needsYou,
      decided,
      answered,
      tasks: {
        done: Number(counts?.done ?? 0),
        in_review: Number(counts?.in_review ?? 0),
        open: Number(counts?.open ?? 0),
      },
    };
  }

  /** The owner's digest over every room it is in; rooms with nothing to say are left out. */
  async function digest(ownerId: string, hours: number = DIGEST_LIMITS.defaultHours) {
    await d.limit(`room-digest:${ownerId}`, DIGEST_LIMITS.readsPerOwnerPerMinute, 60_000);
    const span = Math.min(Math.max(1, Math.floor(hours)), DIGEST_LIMITS.maxHours);
    const time = d.clock();
    const since = time - span * HOUR;
    return d.db.transaction(async (tx): Promise<OwnerDigest> => {
      const rooms: RoomDigest[] = [];
      for (const room of await roomsOf(tx, ownerId)) {
        const one = await forRoom(tx, room, ownerId, since, time);
        if (one.needs_you.length || one.decided.length || one.answered.length || one.tasks.done)
          rooms.push(one);
      }
      // Rooms that need the owner first.
      rooms.sort((a, b) => b.needs_you.length - a.needs_you.length);
      return { since: iso(since), generated_at: iso(time), rooms };
    });
  }

  return { digest };
}
export type RoomDigestService = ReturnType<typeof createRoomDigest>;
