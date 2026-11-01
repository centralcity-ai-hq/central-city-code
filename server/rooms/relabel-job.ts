import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { registerMigration, type Migration } from '../migrations.js';
import { relabelRoomOwners, type RelabelCounts, type RelabelDb } from './relabel-owners.js';

/**
 * The owner relabel, run once on production by the server itself (relabel-owners.ts). The
 * database URL and the label key are Sensitive in the hosting settings, so the script cannot run
 * outside the server. The cron (vercel.json, hourly) applies the relabel once, records its counts
 * in room_relabel_runs and answers `skipped` from then on. Output is counts only.
 */
export const ROOM_RELABEL_PATH = '/api/cron/room-relabel';
/** The run's name in room_relabel_runs; a later relabel would use a new one. */
export const ROOM_RELABEL_RUN = 'owner_labels_v1';

/**
 * Migration 335 `room_relabel_runs`: one row per finished one-time relabel (name, when, counts).
 * Additive only: a new, empty table.
 */
export const roomRelabelRunsMigration: Migration = {
  version: 335,
  name: 'room_relabel_runs',
  sql: `
CREATE TABLE IF NOT EXISTS room_relabel_runs (
  name text PRIMARY KEY,
  finished_at bigint NOT NULL,
  counts jsonb NOT NULL
);
`,
};

/** Idempotent; call before runMigrations (after the rooms migrations). */
export function registerRoomRelabelRunsMigration(): void {
  registerMigration(roomRelabelRunsMigration);
}

export type RelabelJobResult =
  { skipped: true; finished_at: number } | { skipped: false; counts: RelabelCounts };

/** Applies the relabel unless it already finished; records the counts when it does. */
export async function runRoomRelabelOnce(
  db: RelabelDb,
  secret: string,
  clock: () => number,
): Promise<RelabelJobResult> {
  const done = (
    await db.query<{ finished_at: string | number }>(
      'SELECT finished_at FROM room_relabel_runs WHERE name=$1',
      [ROOM_RELABEL_RUN],
    )
  ).rows[0];
  if (done) return { skipped: true, finished_at: Number(done.finished_at) };
  const counts = await relabelRoomOwners(db, { secret, confirm: true });
  await db.query(
    'INSERT INTO room_relabel_runs(name,finished_at,counts) VALUES($1,$2,$3::jsonb) ON CONFLICT (name) DO NOTHING',
    [ROOM_RELABEL_RUN, clock(), JSON.stringify(counts)],
  );
  return { skipped: false, counts };
}

function bearerMatches(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The cron route; without CRON_SECRET (or with a wrong bearer) it answers 404. */
export function registerRoomRelabelRoute(
  app: FastifyInstance,
  d: { db: RelabelDb; secret: string; clock: () => number; cronSecret?: string | undefined },
): void {
  app.get(ROOM_RELABEL_PATH, async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, d.cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    try {
      const result = await runRoomRelabelOnce(d.db, d.secret, d.clock);
      console.log(JSON.stringify({ event: 'room_relabel', ...result }));
      return reply.header('Cache-Control', 'no-store').send(result);
    } catch {
      // Database errors can quote SQL parameters: a fixed line only. Applied batches stay applied;
      // the next run continues (rows that already match are left alone).
      console.error(JSON.stringify({ event: 'room_relabel_failed' }));
      return reply.code(500).send({ error: 'The relabel failed; the next run continues it.' });
    }
  });
}
