import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 10 `agent_messages` (reserved for agent messaging v0, docs/MESSAGING.md), registered by
 * this feature module through `registerMigration` before the app runs migrations.
 *
 * Free-form messages live in per-recipient inboxes keyed by (recipient_id, seq); sequence numbers
 * come from the recipient's `inbox_cursors` row (`UPDATE ... RETURNING`), so each inbox is
 * gap-free and totally ordered without a global sequence. Not partitioned yet: monthly RANGE
 * partitions by created_at arrive with storage normalization, and these keys stay compatible with
 * that layout. `message_receipts` makes sends idempotent per sender agent.
 */
export const agentMessagesMigration: Migration = {
  version: 10,
  name: 'agent_messages',
  sql: `
CREATE TABLE IF NOT EXISTS messages (
  recipient_id text NOT NULL, seq bigint NOT NULL, id uuid NOT NULL,
  sender_id text NOT NULL, sender_owner_id text NOT NULL, recipient_owner_id text NOT NULL,
  context_id text NOT NULL, reply_to uuid,
  kind text NOT NULL DEFAULT 'message' CHECK (kind IN ('message')),
  parts jsonb NOT NULL, created_at bigint NOT NULL,
  PRIMARY KEY(recipient_id, seq)
);
CREATE INDEX IF NOT EXISTS messages_owner_created ON messages(recipient_owner_id, created_at);
CREATE INDEX IF NOT EXISTS messages_owner_context ON messages(recipient_owner_id, context_id, created_at);
CREATE INDEX IF NOT EXISTS messages_id ON messages(id);
CREATE TABLE IF NOT EXISTS inbox_cursors (
  agent_id text PRIMARY KEY, next_seq bigint NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  acked_seq bigint NOT NULL DEFAULT 0 CHECK (acked_seq >= 0 AND acked_seq < next_seq),
  updated_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS message_receipts (
  sender_id text NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL,
  message_id uuid NOT NULL, recipient_id text NOT NULL, seq bigint NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY(sender_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS message_receipts_created ON message_receipts(created_at);
`,
};

/**
 * Migration 19 `pair_contexts` (docs/MESSAGING.md "Threads"). A message sent without context_id or reply_to continues the pair's latest
 * conversation, else the pair's default conversation. That default is a random id stored once per
 * pair (low_id, high_id sorted), so it cannot be derived from the public agent ids. The two
 * indexes let the send path check an explicit context_id with index-only probes instead of a
 * count over the whole thread (created_at keeps the planner on them for very long threads).
 */
export const pairContextsMigration: Migration = {
  version: 19,
  name: 'pair_contexts',
  sql: `
CREATE TABLE IF NOT EXISTS pair_contexts (
  low_id text NOT NULL, high_id text NOT NULL, context_id text NOT NULL, created_at bigint NOT NULL,
  PRIMARY KEY(low_id, high_id)
);
CREATE INDEX IF NOT EXISTS messages_context_sender ON messages(context_id, sender_id, created_at);
CREATE INDEX IF NOT EXISTS messages_context_recipient ON messages(context_id, recipient_id, created_at);
`,
};

/**
 * Migration 70 `conversation_hidden` (docs/MESSAGING.md "Archive a conversation"): a person's
 * "Delete conversation" in Messages hides one thread from their own list only. One row per
 * (owner, thread); hidden_at is when it was last hidden, and the thread shows again as soon as
 * a message newer than hidden_at arrives. No message is deleted, for either side.
 */
export const conversationHiddenMigration: Migration = {
  version: 70,
  name: 'conversation_hidden',
  sql: `
CREATE TABLE IF NOT EXISTS conversation_hidden (
  owner_id text NOT NULL, context_id text NOT NULL, hidden_at bigint NOT NULL,
  PRIMARY KEY(owner_id, context_id)
);
`,
};

/**
 * Migration 73 `conversation_reads` (docs/MESSAGING.md "In the conversation list"): when an owner
 * last read a thread in the console. A message one of its members received from someone else is
 * unread for the owner only while it is newer than this mark (and its inbox has not acknowledged
 * it). One row per (owner, thread); read_at is the newest message the owner had then. An AI's own
 * inbox cursor is never moved by it, so the AI still receives every message.
 */
export const conversationReadsMigration: Migration = {
  version: 73,
  name: 'conversation_reads',
  sql: `
CREATE TABLE IF NOT EXISTS conversation_reads (
  owner_id text NOT NULL, context_id text NOT NULL, read_at bigint NOT NULL,
  PRIMARY KEY(owner_id, context_id)
);
`,
};

/**
 * Migration 302 `conversation_summaries` (R8-2): one summary row per (owner, thread), so the
 * conversation list (GET /api/messages/conversations, polled every 10 s) never counts or groups a
 * thread's messages and picks its page from an index ordered by the newest message.
 *
 * - `conversation_summaries`: what the list's per-thread aggregate computed (message_count, the
 *   distinct senders and recipients, the newest created_at overall and received) plus the newest
 *   message's key (last_recipient_id, last_seq, last_id: the list's "latest" order created_at,
 *   seq, id), over the messages the owner sends or receives in the thread.
 * - Kept by statement-level triggers on messages (transition tables), in the writing
 *   transaction, for every write path and for older instances during a deploy: each INSERT
 *   statement does one upsert per (owner, thread) it touches, however many rows it writes. An update
 *   that moves a message to another thread or another owner (the pair-context remediation,
 *   account erasure's pseudonym) marks the rows it leaves incomplete and bumps the ones it joins
 *   as incomplete. Messages are deleted only by account erasure, with the erased owner's
 *   summaries (server/account/erase.ts).
 * - `complete`: the row counts every message of the thread for its owner. A row created for a
 *   thread that already had messages (older than this migration, or an owner new to it), or
 *   touched by such an update, is not complete: the list aggregates that thread as before, until
 *   scripts/backfill-conversation-summaries.ts recounts it exactly.
 * - `conversation_summaries_meta.backfilled_at`: every thread has its row (set by the backfill;
 *   by this migration itself when messages is empty). Only then does the list pick its page from
 *   conversation_summaries_recent instead of walking every thread the owner ever received in.
 *
 * Additive: two new tables, three functions, two triggers; nothing in messages changes. An older
 * build ignores them (its writes still fire the triggers, so the rows stay right). Cost: each
 * send adds one upsert; every UPDATE statement on messages (none on a send path: remediation,
 * relabelling, erasure) also builds its transition tables. Lock: CREATE TRIGGER takes SHARE ROW
 * EXCLUSIVE on messages (it waits for running writes and new sends queue behind it until it
 * commits; the migration's lock timeout bounds the wait); nothing scans messages except one
 * EXISTS probe.
 */
export const conversationSummariesMigration: Migration = {
  version: 302,
  name: 'conversation_summaries',
  sql: `
CREATE TABLE IF NOT EXISTS conversation_summaries (
  owner_id text NOT NULL, context_id text NOT NULL,
  message_count bigint NOT NULL CHECK (message_count >= 1),
  senders text[] NOT NULL, recipients text[] NOT NULL,
  last_at bigint NOT NULL, last_received_at bigint,
  last_recipient_id text NOT NULL, last_seq bigint NOT NULL, last_id uuid NOT NULL,
  complete boolean NOT NULL,
  PRIMARY KEY(owner_id, context_id)
);
CREATE INDEX IF NOT EXISTS conversation_summaries_recent
  ON conversation_summaries(owner_id, last_at DESC, context_id);
CREATE TABLE IF NOT EXISTS conversation_summaries_meta (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  counting_since bigint NOT NULL,
  backfilled_at bigint
);
INSERT INTO conversation_summaries_meta(id, counting_since, backfilled_at)
  SELECT true, (extract(epoch from now()) * 1000)::bigint,
    CASE WHEN EXISTS (SELECT 1 FROM messages) THEN NULL ELSE (extract(epoch from now()) * 1000)::bigint END
  ON CONFLICT (id) DO NOTHING;
-- Counts the rows of one statement (a transition table) into the summary of each owner they
-- involve: one upsert per (owner, thread) per statement, however many rows it wrote. A new row is
-- complete only when complete_ok and the thread has no message besides these rows; an existing
-- row keeps its completeness when complete_ok, else it becomes incomplete.
CREATE OR REPLACE FUNCTION conversation_summaries_add(rows_json jsonb, complete_ok boolean)
RETURNS void LANGUAGE sql AS $$
  WITH r AS (
    SELECT x.recipient_id, x.seq, x.id, x.sender_id, x.sender_owner_id, x.recipient_owner_id,
           x.context_id, x.created_at
      FROM jsonb_to_recordset(rows_json) AS x(recipient_id text, seq bigint, id uuid, sender_id text,
           sender_owner_id text, recipient_owner_id text, context_id text, created_at bigint)
  ), owned AS (
    SELECT r.*, o.owner_id FROM r,
      LATERAL (SELECT DISTINCT y FROM unnest(ARRAY[r.sender_owner_id, r.recipient_owner_id]) y) o(owner_id)
  ), g AS (
    SELECT owner_id, context_id, count(*) AS n,
      array_agg(DISTINCT sender_id ORDER BY sender_id) AS senders,
      array_agg(DISTINCT recipient_id ORDER BY recipient_id) AS recipients,
      max(created_at) AS last_at,
      max(created_at) FILTER (WHERE recipient_owner_id = owner_id) AS last_received_at,
      (array_agg(recipient_id ORDER BY created_at DESC, seq DESC, id DESC))[1] AS last_recipient_id,
      (array_agg(seq ORDER BY created_at DESC, seq DESC, id DESC))[1] AS last_seq,
      (array_agg(id ORDER BY created_at DESC, seq DESC, id DESC))[1] AS last_id
    FROM owned GROUP BY owner_id, context_id
  )
  INSERT INTO conversation_summaries AS s (owner_id, context_id, message_count, senders, recipients,
      last_at, last_received_at, last_recipient_id, last_seq, last_id, complete)
  SELECT g.owner_id, g.context_id, g.n, g.senders, g.recipients, g.last_at, g.last_received_at,
    g.last_recipient_id, g.last_seq, g.last_id,
    complete_ok AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.context_id = g.context_id
      AND NOT EXISTS (SELECT 1 FROM r WHERE r.recipient_id = x.recipient_id AND r.seq = x.seq))
  FROM g
  ON CONFLICT (owner_id, context_id) DO UPDATE SET
    message_count = s.message_count + EXCLUDED.message_count,
    senders = (SELECT array_agg(DISTINCT y ORDER BY y) FROM unnest(s.senders || EXCLUDED.senders) y),
    recipients = (SELECT array_agg(DISTINCT y ORDER BY y) FROM unnest(s.recipients || EXCLUDED.recipients) y),
    last_received_at = GREATEST(s.last_received_at, EXCLUDED.last_received_at),
    last_at = GREATEST(s.last_at, EXCLUDED.last_at),
    last_recipient_id = CASE WHEN (EXCLUDED.last_at, EXCLUDED.last_seq, EXCLUDED.last_id) > (s.last_at, s.last_seq, s.last_id)
      THEN EXCLUDED.last_recipient_id ELSE s.last_recipient_id END,
    last_seq = CASE WHEN (EXCLUDED.last_at, EXCLUDED.last_seq, EXCLUDED.last_id) > (s.last_at, s.last_seq, s.last_id)
      THEN EXCLUDED.last_seq ELSE s.last_seq END,
    last_id = CASE WHEN (EXCLUDED.last_at, EXCLUDED.last_seq, EXCLUDED.last_id) > (s.last_at, s.last_seq, s.last_id)
      THEN EXCLUDED.last_id ELSE s.last_id END,
    complete = s.complete AND complete_ok;
$$;
CREATE OR REPLACE FUNCTION conversation_summaries_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM conversation_summaries_add(
    (SELECT COALESCE(jsonb_agg(to_jsonb(n)), '[]'::jsonb) FROM new_rows n), true);
  RETURN NULL;
END $$;
-- An update that moves messages to another thread or owner: the rows they leave become
-- incomplete, the rows they join are bumped and incomplete (the backfill recounts both).
CREATE OR REPLACE FUNCTION conversation_summaries_moved() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE moved jsonb;
BEGIN
  SELECT jsonb_agg(to_jsonb(n)) INTO moved
    FROM new_rows n JOIN old_rows o ON o.recipient_id = n.recipient_id AND o.seq = n.seq
   WHERE o.context_id IS DISTINCT FROM n.context_id
      OR o.sender_owner_id IS DISTINCT FROM n.sender_owner_id
      OR o.recipient_owner_id IS DISTINCT FROM n.recipient_owner_id;
  IF moved IS NULL THEN RETURN NULL; END IF;
  UPDATE conversation_summaries s SET complete = false
    FROM new_rows n JOIN old_rows o ON o.recipient_id = n.recipient_id AND o.seq = n.seq
   WHERE (o.context_id IS DISTINCT FROM n.context_id
          OR o.sender_owner_id IS DISTINCT FROM n.sender_owner_id
          OR o.recipient_owner_id IS DISTINCT FROM n.recipient_owner_id)
     AND s.context_id = o.context_id AND s.owner_id IN (o.sender_owner_id, o.recipient_owner_id)
     AND s.complete;
  PERFORM conversation_summaries_add(moved, false);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS conversation_summaries_inserted ON messages;
CREATE TRIGGER conversation_summaries_inserted AFTER INSERT ON messages
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION conversation_summaries_inserted();
DROP TRIGGER IF EXISTS conversation_summaries_moved ON messages;
CREATE TRIGGER conversation_summaries_moved AFTER UPDATE ON messages
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION conversation_summaries_moved();
`,
};

/** Idempotent; call before runMigrations. */
export function registerMessagingMigration(): void {
  registerMigration(agentMessagesMigration);
  registerMigration(pairContextsMigration);
  registerMigration(conversationHiddenMigration);
  registerMigration(conversationReadsMigration);
  registerMigration(conversationSummariesMigration);
}
