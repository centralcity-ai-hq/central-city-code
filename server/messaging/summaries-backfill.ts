import type { Database, Transaction } from '../database.js';

/*
 * The one-off backfill of migration 302 (messaging/schema.ts conversation_summaries, R8-2), run by
 * the owner (scripts/backfill-conversation-summaries.ts), never at startup: it reads every message
 * once. It gives every (owner, thread) a complete summary row, then sets
 * conversation_summaries_meta.backfilled_at, after which the conversation list picks its page from
 * the summaries.
 *
 * Exact while messages keep arriving (READ COMMITTED, every step its own statement):
 *   1. the row is created from an aggregate if it is missing (ON CONFLICT DO NOTHING);
 *   2. the row is locked (FOR UPDATE): a send into this thread bumps the row in its own
 *      transaction (the trigger), so it either committed before the lock was granted, or it waits
 *      for this transaction;
 *   3. the row is recounted with a new snapshot and marked complete. A send that committed before
 *      3 is in the count; one still waiting bumps the recounted row after this commits.
 * Each (owner, thread) is its own short transaction (lock_timeout 2 s; statement_timeout 60 s, so
 * one very long thread is recounted, not cut off). Safe to run again: complete rows are skipped.
 */
export interface BackfillCounts {
  /** Threads read from messages. */
  threads: number;
  /** (owner, thread) pairs that already had a complete row. */
  complete: number;
  /** Pairs recounted (to be recounted, in a dry run). */
  recounted: number;
  /** Pairs whose recount failed (a lock or statement timeout): run again. */
  failed: number;
  /** Whether backfilled_at is set at the end. */
  backfilled: boolean;
  batches: number;
}

const OWNER_ROWS = `m.context_id = $2 AND (m.recipient_owner_id = $1 OR m.sender_owner_id = $1)`;
const AGGREGATE = `
  SELECT count(*) AS message_count,
    array_agg(DISTINCT m.sender_id ORDER BY m.sender_id) AS senders,
    array_agg(DISTINCT m.recipient_id ORDER BY m.recipient_id) AS recipients,
    max(m.created_at) AS last_at,
    max(m.created_at) FILTER (WHERE m.recipient_owner_id = $1) AS last_received_at
  FROM messages m WHERE ${OWNER_ROWS}`;
const NEWEST = `
  SELECT m.recipient_id, m.seq, m.id FROM messages m WHERE ${OWNER_ROWS}
  ORDER BY m.created_at DESC, m.seq DESC, m.id DESC LIMIT 1`;

/**
 * Recounts one (owner, thread) exactly and marks it complete, or deletes its row when no message
 * is left in it. False when there is neither a row nor a message.
 */
export async function recountSummary(
  tx: Pick<Transaction, 'query' | 'exec'>,
  ownerId: string,
  contextId: string,
): Promise<boolean> {
  await tx.query(
    `INSERT INTO conversation_summaries(owner_id, context_id, message_count, senders, recipients,
       last_at, last_received_at, last_recipient_id, last_seq, last_id, complete)
     SELECT $1, $2, a.message_count, a.senders, a.recipients, a.last_at, a.last_received_at,
       n.recipient_id, n.seq, n.id, false
       FROM (${AGGREGATE}) a, (${NEWEST}) n
      WHERE a.message_count > 0
     ON CONFLICT (owner_id, context_id) DO NOTHING`,
    [ownerId, contextId],
  );
  const locked = await tx.query(
    'SELECT 1 FROM conversation_summaries WHERE owner_id = $1 AND context_id = $2 FOR UPDATE',
    [ownerId, contextId],
  );
  if (!locked.rows.length) return false;
  // Every message moved away (the pair-context remediation): the row goes.
  const left = await tx.query(`SELECT 1 FROM messages m WHERE ${OWNER_ROWS} LIMIT 1`, [
    ownerId,
    contextId,
  ]);
  if (!left.rows.length) {
    await tx.query('DELETE FROM conversation_summaries WHERE owner_id = $1 AND context_id = $2', [
      ownerId,
      contextId,
    ]);
    return true;
  }
  await tx.query(
    `UPDATE conversation_summaries s SET
       message_count = a.message_count, senders = a.senders, recipients = a.recipients,
       last_at = a.last_at, last_received_at = a.last_received_at,
       last_recipient_id = n.recipient_id, last_seq = n.seq, last_id = n.id, complete = true
       FROM (${AGGREGATE}) a, (${NEWEST}) n
      WHERE s.owner_id = $1 AND s.context_id = $2`,
    [ownerId, contextId],
  );
  return true;
}

export async function backfillConversationSummaries(
  db: Database,
  options: {
    confirm: boolean;
    threadsPerBatch?: number;
    now?: () => number;
    onBatch?: (counts: BackfillCounts) => void;
  },
): Promise<BackfillCounts> {
  const perBatch = Math.min(Math.max(Math.trunc(options.threadsPerBatch ?? 100), 1), 1000);
  const now = options.now ?? Date.now;
  const counts: BackfillCounts = {
    threads: 0,
    complete: 0,
    recounted: 0,
    failed: 0,
    backfilled: false,
    batches: 0,
  };
  const recount = async (ownerId: string, contextId: string) => {
    if (!options.confirm) {
      counts.recounted += 1;
      return;
    }
    try {
      await db.transaction(async (tx) => {
        await tx.exec("SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '60s'");
        if (await recountSummary(tx, ownerId, contextId)) counts.recounted += 1;
      });
    } catch {
      counts.failed += 1;
    }
  };
  // Pass 1: every thread in messages, by context_id (keyset).
  let after = '';
  for (;;) {
    const threads = (
      await db.query<{ context_id: string }>(
        'SELECT DISTINCT context_id FROM messages WHERE context_id > $1 ORDER BY context_id LIMIT $2',
        [after, perBatch],
      )
    ).rows.map((row) => row.context_id);
    if (!threads.length) break;
    after = threads[threads.length - 1]!;
    counts.threads += threads.length;
    const pairs = (
      await db.query<{ owner_id: string; context_id: string }>(
        `SELECT DISTINCT o.owner_id, m.context_id FROM messages m,
           LATERAL (VALUES (m.sender_owner_id), (m.recipient_owner_id)) AS o(owner_id)
          WHERE m.context_id = ANY($1::text[])
          ORDER BY m.context_id, o.owner_id`,
        [threads],
      )
    ).rows;
    const done = new Set(
      (
        await db.query<{ owner_id: string; context_id: string }>(
          `SELECT owner_id, context_id FROM conversation_summaries
            WHERE context_id = ANY($1::text[]) AND complete`,
          [threads],
        )
      ).rows.map((row) => `${row.owner_id}\n${row.context_id}`),
    );
    for (const pair of pairs)
      if (done.has(`${pair.owner_id}\n${pair.context_id}`)) counts.complete += 1;
      else await recount(pair.owner_id, pair.context_id);
    counts.batches += 1;
    options.onBatch?.({ ...counts });
  }
  // Pass 2: rows a send created as incomplete after pass 1 read their thread (an owner new to an
  // old thread).
  if (options.confirm)
    for (const row of (
      await db.query<{ owner_id: string; context_id: string }>(
        'SELECT owner_id, context_id FROM conversation_summaries WHERE NOT complete ORDER BY 2, 1',
      )
    ).rows)
      await recount(row.owner_id, row.context_id);
  if (options.confirm && counts.failed === 0)
    await db.query(
      'UPDATE conversation_summaries_meta SET backfilled_at = $1 WHERE id AND backfilled_at IS NULL',
      [now()],
    );
  counts.backfilled =
    (
      await db.query<{ done: boolean }>(
        'SELECT backfilled_at IS NOT NULL AS done FROM conversation_summaries_meta WHERE id',
      )
    ).rows[0]?.done === true;
  return counts;
}
