import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../database.js';
import { registerMigration, type Migration } from '../migrations.js';

/**
 * Streamed Elric replies (docs/ELRIC.md). While a run answers, the text of the current model step
 * is kept as a DRAFT in `elric_drafts` (one row per invocation), written about every
 * DRAFT_LIMITS.intervalMs (never more than 4 times a second) under the run's lease, and deleted when the run finishes, whatever the
 * outcome. Room members poll `GET /api/rooms/:room/elric-drafts` to watch the answer form; the
 * posted message (checked, cleaned, labelled) is unchanged. A draft is never logged or kept, never
 * holds thinking, passes the same credential check as a reply, and has its @mentions stripped.
 */
/** The tables of migration 46: recognized by backups and never exported (drafts are transient). */
export const ELRIC_DRAFT_TABLES = ['elric_drafts'] as const;

export const elricDraftMigration: Migration = {
  version: 46,
  name: 'elric_drafts',
  sql: `
CREATE TABLE IF NOT EXISTS elric_drafts (
  agent_id text NOT NULL, room_id text NOT NULL, source_seq bigint NOT NULL,
  text text NOT NULL, updated_at bigint NOT NULL,
  PRIMARY KEY(agent_id, room_id, source_seq)
);
CREATE INDEX IF NOT EXISTS elric_drafts_room ON elric_drafts(room_id);
`,
};
export function registerElricDraftMigration(): void {
  registerMigration(elricDraftMigration);
}

export const DRAFT_LIMITS = {
  /** Usual time between two writes of one draft (the page reveals the text smoothly between). */
  intervalMs: 500,
  /** A write also happens once this many new characters arrived, but never more often than: */
  chars: 200,
  /** The least time between two writes, even for bursts (at most 4 writes a second). */
  minIntervalMs: 250,
  /** Drafts older than this are ignored by readers (a run that died without cleaning up). */
  staleMs: 120_000,
} as const;

type Q = Pick<Database, 'query'>;
export interface DraftKey {
  agentId: string;
  roomId: string;
  sourceSeq: number;
  /** The run's lease: a write only lands while this run still holds the invocation. */
  leaseId: string;
}

/**
 * SQL: the Elric `agent` may still write in `room`, as elricRoomAccess's write check reads it
 * (Elric active, its member row there not removed, the room open with responders allowed, the
 * owner not muted there). A draft is shown and written only while this holds, so a pause, a
 * removal or the host's off switch stops the draft at once, not when the model call ends.
 */
const elricMayWrite = (agent: string, room: string) => `EXISTS (
  SELECT 1 FROM elric_agents e
    JOIN room_members m ON m.room_id=${room} AND m.agent_id=e.agent_id AND m.kind='agent'
     AND m.owner_id=e.owner_id AND m.removed_at IS NULL
    JOIN rooms r ON r.id=${room} AND r.deleted_at IS NULL AND r.closed_at IS NULL
     AND r.responders_allowed
   WHERE e.agent_id=${agent} AND e.status='active'
     AND NOT EXISTS (SELECT 1 FROM room_members x WHERE x.room_id=${room} AND x.owner_id=e.owner_id
                       AND (x.muted_at IS NOT NULL OR x.notifications_muted)))`;

/** Writes (or replaces) the draft, only while the run holds its lease and Elric may write. */
export async function writeDraft(db: Q, key: DraftKey, text: string, time: number): Promise<void> {
  await db.query(
    `INSERT INTO elric_drafts(agent_id,room_id,source_seq,text,updated_at)
     SELECT $1,$2,$3,$4,$5 WHERE EXISTS (
       SELECT 1 FROM elric_invocations
        WHERE agent_id=$1 AND room_id=$2 AND source_seq=$3 AND lease_id=$6)
       AND ${elricMayWrite('$1::text', '$2::text')}
     ON CONFLICT (agent_id,room_id,source_seq) DO UPDATE SET text=$4, updated_at=$5`,
    [key.agentId, key.roomId, key.sourceSeq, text, time, key.leaseId],
  );
}

/** Deletes every draft of one Elric (paused or revoked: nothing it was writing stays shown). */
export async function deleteElricDrafts(db: Q, agentId: string): Promise<void> {
  await db.query('DELETE FROM elric_drafts WHERE agent_id=$1', [agentId]);
}

/** Deletes drafts older than staleMs (a run that died without its finish). */
export async function sweepStaleDrafts(db: Q, time: number): Promise<number> {
  return (
    await db.query('DELETE FROM elric_drafts WHERE updated_at <= $1 RETURNING 1', [
      time - DRAFT_LIMITS.staleMs,
    ])
  ).rows.length;
}

export async function deleteDraft(
  db: Q,
  key: Pick<DraftKey, 'agentId' | 'roomId' | 'sourceSeq'>,
): Promise<void> {
  await db.query('DELETE FROM elric_drafts WHERE agent_id=$1 AND room_id=$2 AND source_seq=$3', [
    key.agentId,
    key.roomId,
    key.sourceSeq,
  ]);
}

export interface PublicDraft {
  agent_id: string;
  source_seq: number;
  text: string;
  updated_at: string;
}

/**
 * The live drafts of a room, for an operator with an active member in it (else null: 404).
 * Only drafts answering a message the operator's member may see, of an Elric that may still
 * write there. As the room's access rule, a
 * member counts only when it is a person or a live (not revoked) agent of the operator.
 */
export async function roomDrafts(
  db: Q,
  roomId: string,
  operatorId: string,
  time: number,
): Promise<PublicDraft[] | null> {
  const member = (
    await db.query<{ from_seq: string | number }>(
      `SELECT min(m.visible_from_seq) AS from_seq FROM room_members m JOIN rooms r ON r.id=m.room_id
        WHERE m.room_id=$1 AND m.owner_id=$2 AND m.removed_at IS NULL AND r.deleted_at IS NULL
          AND (m.kind='person' OR EXISTS (
            SELECT 1 FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a
             WHERE w.operator_id=m.owner_id AND a->>'id'=m.agent_id
               AND COALESCE(a->>'revokedAt', '') = ''))`,
      [roomId, operatorId],
    )
  ).rows[0];
  if (member?.from_seq === null || member?.from_seq === undefined) return null;
  // Stale drafts of this room are removed when met (and by the drain's sweep).
  await db.query('DELETE FROM elric_drafts WHERE room_id=$1 AND updated_at <= $2', [
    roomId,
    time - DRAFT_LIMITS.staleMs,
  ]);
  const rows = (
    await db.query<{
      agent_id: string;
      source_seq: string | number;
      text: string;
      updated_at: string | number;
    }>(
      `SELECT d.agent_id,d.source_seq,d.text,d.updated_at FROM elric_drafts d
        WHERE d.room_id=$1 AND d.source_seq > $2 AND d.updated_at > $3
          AND ${elricMayWrite('d.agent_id', 'd.room_id')}
        ORDER BY d.source_seq`,
      [roomId, member.from_seq, time - DRAFT_LIMITS.staleMs],
    )
  ).rows;
  return rows.map((row) => ({
    agent_id: row.agent_id,
    source_seq: Number(row.source_seq),
    text: row.text,
    updated_at: new Date(Number(row.updated_at)).toISOString(),
  }));
}

/** `GET /api/rooms/:room/elric-drafts`: members only, never cached. */
export function registerElricDraftRoutes(
  app: FastifyInstance,
  d: {
    db: Q;
    clock: () => number;
    owner: (request: FastifyRequest) => Promise<string>;
  },
): void {
  app.get<{ Params: { room: string } }>('/api/rooms/:room/elric-drafts', async (request, reply) => {
    const operatorId = await d.owner(request);
    const room = String(request.params.room).slice(0, 200);
    const drafts = await roomDrafts(d.db, room, operatorId, d.clock());
    if (!drafts)
      throw Object.assign(new Error('Room not found.'), {
        statusCode: 404,
        errorCode: 'room_not_found',
      });
    reply.header('cache-control', 'no-store');
    return { drafts };
  });
}

/**
 * Throttled draft writer for one run: `update(text)` records the latest text of the current step
 * and writes it at most every intervalMs (or after `chars` new characters); writes are chained,
 * so `close()` (awaited before the run finishes) leaves nothing in flight.
 */
export function draftWriter(
  write: (text: string) => Promise<void>,
  clock: () => number = Date.now,
): { update(text: string): void; close(): Promise<void> } {
  let chain = Promise.resolve();
  let last = -Infinity;
  let written = '';
  let closed = false;
  return {
    update(text) {
      if (closed || text === written) return;
      const now = clock();
      if (now - last < DRAFT_LIMITS.minIntervalMs) return;
      if (now - last < DRAFT_LIMITS.intervalMs && text.length - written.length < DRAFT_LIMITS.chars)
        return;
      last = now;
      written = text;
      chain = chain.then(() => write(text)).catch(() => {});
    },
    async close() {
      closed = true;
      await chain;
    },
  };
}
