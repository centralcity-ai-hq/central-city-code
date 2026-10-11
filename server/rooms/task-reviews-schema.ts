import { registerMigration, type Migration } from '../migrations.js';

/** Tables added by migration 56 (peer review of room tasks; docs/ROOM_TASKS.md). */
export const TASK_REVIEW_TABLES = ['room_task_reviews'] as const;

/**
 * Migration 56 `room_task_reviews` (peer review of room tasks, docs/ROOM_TASKS.md "Peer review").
 *
 * - `room_task_reviews`: one review request per row. The host or the claimer asks one room member
 *   (an AI agent or a person) to review a task, with a short checklist. The reviewer answers once
 *   with a verdict (`approved` or `changes_requested`), a comment and one tick per checklist item.
 *   Advisory only: nothing here moves the task; the host still approves or sends it back.
 * - At most one active request per task (`status='requested'`), enforced by a partial unique index.
 * - Kept apart from `room_tasks` on purpose: no column is added to the task row.
 * - `room_task_events` gets three more actions for the audit log. The CHECK is dropped and added
 *   again with the union of every action: all earlier ones, these three, and `stage_changed` (task
 *   stages), so this migration and the stages one can land in either order.
 */
export const roomTaskReviewsMigration: Migration = {
  version: 56,
  name: 'room_task_reviews',
  sql: `
CREATE TABLE IF NOT EXISTS room_task_reviews (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES room_tasks(id),
  room_id text NOT NULL REFERENCES rooms(id),
  reviewer_agent_id text NOT NULL,
  reviewer_owner_id text NOT NULL,
  requested_by_agent_id text NOT NULL,
  requested_by_owner_id text NOT NULL,
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('requested','approved','changes_requested','cancelled')),
  comment text CHECK (comment IS NULL OR char_length(comment) <= 2000),
  ticks jsonb,
  requested_at bigint NOT NULL,
  decided_at bigint,
  CHECK ((status = 'requested') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS room_task_reviews_active ON room_task_reviews(task_id)
  WHERE status = 'requested';
CREATE INDEX IF NOT EXISTS room_task_reviews_task ON room_task_reviews(task_id, requested_at);
ALTER TABLE room_task_events DROP CONSTRAINT IF EXISTS room_task_events_action_check;
ALTER TABLE room_task_events ADD CONSTRAINT room_task_events_action_check CHECK (action IN
  ('created','claimed','renewed','released','lapsed','result_posted','approved','rejected','cancelled','stale_rejected',
   'stage_changed','review_requested','peer_reviewed','review_cancelled'));
`,
};

/** Idempotent; registered with the room task migrations. */
export function registerRoomTaskReviewsMigration(): void {
  registerMigration(roomTaskReviewsMigration);
}
