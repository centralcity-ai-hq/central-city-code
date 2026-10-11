-- One-off backfill for migration 75 (agent_message_counts): adds every AI's room messages
-- sent BEFORE counting began (sender_kind 'agent' only, like the trigger).
-- Runbook: run once after migration 75 is live, at a quiet hour, by the owner or with the owner's
-- OK. It scans room_messages once (reads only, no write lock on it). Safe to repeat: the
-- backfilled_at guard makes a second run change nothing.
--   psql "$DATABASE_URL" -f scripts/ops/backfill-message-counts.sql
BEGIN;
WITH meta AS (
  SELECT counting_since FROM agent_message_counts_meta
    WHERE id AND backfilled_at IS NULL
    FOR UPDATE
), earlier AS (
  SELECT m.sender_agent_id AS agent_id, count(*) AS sent
    FROM room_messages m, meta
    WHERE m.created_at < meta.counting_since AND m.sender_kind = 'agent'
    GROUP BY m.sender_agent_id
)
INSERT INTO agent_message_counts(agent_id, sent)
  SELECT agent_id, sent FROM earlier
  ON CONFLICT (agent_id) DO UPDATE SET sent = agent_message_counts.sent + EXCLUDED.sent;
UPDATE agent_message_counts_meta SET backfilled_at = (extract(epoch from now()) * 1000)::bigint
  WHERE id AND backfilled_at IS NULL;
COMMIT;
