import type { Transaction as Tx } from '../database.js';

/**
 * Row-locks an agent's mention cursor for the rest of the transaction. Every path that marks
 * mentions read and then moves `acked_mention_seq` takes this lock first, as ackMentions does.
 * insertMention holds the same row lock while it allocates and writes a mention, so a concurrent
 * mention commits before the later statements take their snapshots. Without it the cursor update
 * can see the new next_mention_seq but not the new mention, and skip past it. Taking the cursor
 * before the mention rows also keeps one lock order with ackMentions.
 */
export async function lockMentionCursor(q: Pick<Tx, 'query'>, agentId: string): Promise<void> {
  await q.query('SELECT 1 FROM wake_cursors WHERE agent_id=$1 FOR UPDATE', [agentId]);
}
