import type { Transaction as Tx } from '../database.js';
import { lockMentionCursor } from './cursor-lock.js';

/**
 * Whether `agentId` has an unread room mention in message `seq` of `roomId`: one indexed probe
 * (mentions_source) without a lock, so the usual reply, which answers no mention, takes none.
 */
export async function hasUnreadRoomMention(
  q: Pick<Tx, 'query'>,
  agentId: string,
  roomId: string,
  seq: number,
): Promise<boolean> {
  return (
    (
      await q.query(
        `SELECT 1 FROM mentions
          WHERE agent_id=$1 AND source_kind='room' AND read_at IS NULL
            AND source_id=(SELECT id::text FROM room_messages WHERE room_id=$2 AND seq=$3)
          LIMIT 1`,
        [agentId, roomId, seq],
      )
    ).rows.length > 0
  );
}

/**
 * Marks one room mention of `agentId` read: the mention in message `seq` of `roomId`, if any
 * and still unread. Called after an AI answers that message (a post with reply_to, or a ✅
 * reaction), in its own short transaction after the post committed, so it holds only this
 * agent's cursor lock (cursor before mention rows, as ackMentions) and never meets the sorted
 * cursor locks roomPosted takes for the agents a post mentions. The cursor itself does not move:
 * earlier unread mentions stay unread, and city_ack_mentions later skips this one.
 */
export async function ackRoomMention(
  tx: Pick<Tx, 'query'>,
  agentId: string,
  roomId: string,
  seq: number,
  time: number,
): Promise<boolean> {
  await lockMentionCursor(tx, agentId);
  const marked = await tx.query(
    `UPDATE mentions SET read_at=$4
      WHERE agent_id=$1 AND source_kind='room' AND read_at IS NULL
        AND source_id=(SELECT id::text FROM room_messages WHERE room_id=$2 AND seq=$3)
      RETURNING seq`,
    [agentId, roomId, seq, time],
  );
  if (!marked.rows.length) return false;
  // The backlog counts unread mentions (migration 26).
  await tx.query(
    'UPDATE wake_cursors SET unread_count=GREATEST(0, unread_count-$2), updated_at=$3 WHERE agent_id=$1',
    [agentId, marked.rows.length, time],
  );
  return true;
}
