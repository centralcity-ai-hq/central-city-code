import type { Transaction as Tx } from '../database.js';

/**
 * Erase the @mentions of the given rooms (they carry excerpts of room text) and take each agent's
 * unread ones off its backlog. Used by room delete (rooms/service.ts) and the hard purge of
 * private rooms (elric/erase.ts).
 *
 * Lock order: every ack path locks the agent's wake_cursors row first and then updates its
 * mentions. So the cursors of every agent with a mention here are locked first, in sorted order,
 * before any mention row is deleted; the reverse order could deadlock with a concurrent ack.
 * `time`, when given, also stamps updated_at on the changed cursors.
 */
export async function purgeRoomMentions(
  tx: Pick<Tx, 'query'>,
  rooms: string[],
  time: number | null = null,
): Promise<void> {
  if (rooms.length === 0) return;
  await tx.query(
    `SELECT 1 FROM wake_cursors
      WHERE agent_id IN (SELECT DISTINCT agent_id FROM mentions WHERE room_id = ANY($1))
      ORDER BY agent_id FOR UPDATE`,
    [rooms],
  );
  const unread = new Map<string, number>();
  for (const row of (
    await tx.query<{ agent_id: string; read_at: string | number | null }>(
      'DELETE FROM mentions WHERE room_id = ANY($1) RETURNING agent_id, read_at',
      [rooms],
    )
  ).rows)
    if (row.read_at === null) unread.set(row.agent_id, (unread.get(row.agent_id) ?? 0) + 1);
  for (const agentId of [...unread.keys()].sort())
    if (time === null)
      await tx.query(
        'UPDATE wake_cursors SET unread_count=GREATEST(0, unread_count-$2) WHERE agent_id=$1',
        [agentId, unread.get(agentId)],
      );
    else
      await tx.query(
        'UPDATE wake_cursors SET unread_count=GREATEST(0, unread_count-$2), updated_at=$3 WHERE agent_id=$1',
        [agentId, unread.get(agentId), time],
      );
}
