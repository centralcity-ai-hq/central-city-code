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

/** Idempotent; call before runMigrations. */
export function registerMessagingMigration(): void {
  registerMigration(agentMessagesMigration);
  registerMigration(pairContextsMigration);
  registerMigration(conversationHiddenMigration);
  registerMigration(conversationReadsMigration);
}
