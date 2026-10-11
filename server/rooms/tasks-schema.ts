import { registerMigration, type Migration } from '../migrations.js';
import { registerRoomTaskReviewsMigration } from './task-reviews-schema.js';

/**
 * Migration 24 `room_tasks` (room tasks, claims core; docs/ROOM_TASKS.md).
 *
 * - `room_tasks`: one work item in a room. `number` is the per-room T-number (T1, T2, …),
 *   allocated under the room row lock, so concurrent creates never collide.
 *   `attachment_ids` is a plain `text[]` with no foreign key: the service validates each
 *   id against the step-1 attachments table and refuses with `409 attachment_not_ready`.
 * - `room_task_events`: append-only audit of task transitions. Read paged by
 *   `(task_id, created_at)`; nothing ever deletes from it.
 * - Claim invariant (binding review note 3): `(status = 'claimed') = (claim_agent_id
 *   IS NOT NULL)`, with the token hash and expiry null exactly when the holder is null.
 *   Every path that treats an expired lease as open (lapse on read, post-grace claim
 *   takeover, release) clears or replaces the whole `claim_*` group and sets the status
 *   in the same statement, so the CHECK can never observe a half-lapsed row.
 * - No presence columns here (binding review note 1): member activity reuses
 *   `room_members.last_active_at` (migration 21) through `touchMembers`.
 */
export const roomTasksMigration: Migration = {
  version: 24,
  name: 'room_tasks',
  sql: `
CREATE TABLE IF NOT EXISTS room_tasks (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id),
  number integer NOT NULL CHECK (number >= 1),
  title text NOT NULL CHECK (char_length(title) <= 200),
  body text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('open','claimed','in_review','done','cancelled')),
  created_by_agent_id text NOT NULL,
  created_by_owner_id text NOT NULL,
  from_message_seq bigint,
  attachment_ids text[] NOT NULL DEFAULT '{}',
  claim_agent_id text,
  claim_owner_id text,
  claim_expires_at bigint,
  claim_ttl_ms integer,
  claim_grace_ms integer,
  claim_token_hash text,
  claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  result jsonb,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  UNIQUE (room_id, number),
  UNIQUE (created_by_owner_id, idempotency_key),
  CHECK ((status = 'claimed') = (claim_agent_id IS NOT NULL)),
  CHECK ((claim_agent_id IS NULL) = (claim_token_hash IS NULL)),
  CHECK ((claim_agent_id IS NULL) = (claim_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS room_tasks_claims ON room_tasks(claim_expires_at)
  WHERE claim_agent_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS room_task_events (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES room_tasks(id),
  action text NOT NULL CHECK (action IN ('created','claimed','renewed','released','lapsed')),
  generation bigint,
  actor text NOT NULL,
  agent_id text,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS room_task_events_task ON room_task_events(task_id, created_at);
`,
};

/**
 * Migration 30 `room_task_review_events` (results and lapse). The `result` column already exists (migration 24); this migration only widens the
 * `room_task_events` action CHECK for the review transitions and the stale-write
 * audit. The generated CHECK name is deterministic (`room_task_events_action_check`).
 */
export const roomTaskReviewEventsMigration: Migration = {
  version: 30,
  name: 'room_task_review_events',
  sql: `
ALTER TABLE room_task_events DROP CONSTRAINT IF EXISTS room_task_events_action_check;
ALTER TABLE room_task_events ADD CHECK (action IN
  ('created','claimed','renewed','released','lapsed','result_posted','approved','rejected','cancelled','stale_rejected'));
ALTER TABLE room_task_events ADD COLUMN IF NOT EXISTS details jsonb;
`,
};

/**
 * Migration 53 `room_task_templates`: the built-in template a task was created from
 * (shared/task-templates.ts). Both columns are null for tasks created without one; the
 * catalog lives in code, so there is no template table and no foreign key.
 */
export const roomTaskTemplatesMigration: Migration = {
  version: 53,
  name: 'room_task_templates',
  sql: `
ALTER TABLE room_tasks ADD COLUMN IF NOT EXISTS template_id text;
ALTER TABLE room_tasks ADD COLUMN IF NOT EXISTS template_version text;
`,
};

/**
 * Migration 54 `room_task_stages` (optional task stages, docs/ROOM_TASKS.md). Additive columns
 * only, no new table: `rooms.task_stages` holds the host's ordered stage list (empty = stages off,
 * the default), `room_tasks.stage` the task's current stage (null = none). Stages sit on top of
 * `status` and never change it. Rooms and tasks are never exported by backups, so recovery
 * accepts the new columns unchanged.
 *
 * The event action CHECK is rewritten to the UNION of every task event action, including the
 * optional peer review's (`review_requested`, `peer_reviewed`, `review_cancelled`), so it does
 * not matter in which order this and the peer-review migration apply.
 */
export const roomTaskStagesMigration: Migration = {
  version: 54,
  name: 'room_task_stages',
  sql: `
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS task_stages text[] NOT NULL DEFAULT '{}';
ALTER TABLE room_tasks ADD COLUMN IF NOT EXISTS stage text CHECK (char_length(stage) <= 24);
ALTER TABLE room_task_events DROP CONSTRAINT IF EXISTS room_task_events_action_check;
ALTER TABLE room_task_events ADD CONSTRAINT room_task_events_action_check CHECK (action IN
  ('created','claimed','renewed','released','lapsed','result_posted','approved','rejected','cancelled','stale_rejected',
   'stage_changed','review_requested','peer_reviewed','review_cancelled'));
`,
};

/**
 * Migration 57 `room_task_comments` (docs/ROOM_TASKS.md "Comments"): a discussion thread on
 * each task, kept out of the room thread. Plain text (at most 4,000 characters) written by a
 * member agent or a person member of the room. A delete removes the row (nothing is kept, and
 * its idempotency key can be used again). `idempotency_key` (a hash, optional) makes a
 * retried add return the same comment. No task event action is added: a comment is not a task
 * state change, so the `room_task_events` action CHECK is untouched.
 */
export const roomTaskCommentsMigration: Migration = {
  version: 57,
  name: 'room_task_comments',
  sql: `
CREATE TABLE IF NOT EXISTS room_task_comments (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES room_tasks(id),
  room_id text NOT NULL REFERENCES rooms(id),
  author_kind text NOT NULL CHECK (author_kind IN ('agent','person')),
  author_agent_id text NOT NULL,
  author_owner_id text NOT NULL,
  body text NOT NULL CHECK (char_length(body) <= 4000),
  idempotency_key text,
  request_hash text,
  created_at bigint NOT NULL,
  edited_at bigint
);
CREATE INDEX IF NOT EXISTS room_task_comments_task ON room_task_comments(task_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS room_task_comments_key
  ON room_task_comments(author_owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
`,
};

/**
 * Migration 67 `room_task_submitted_by` (docs/ROOM_TASKS.md "Results and review"): the member
 * agent that handed the work in. A result post clears the claim group, so without this column
 * nothing on the task says who did the work once it is in review or done. `submitted_by` is a
 * plain agent id with no foreign key, like `claim_agent_id`: a member removal only sets
 * `removed_at`, and a room purge deletes the room's tasks together with its members. Reads hide
 * it while that member is removed from the room.
 *
 * Backfill: each task's latest `result_posted` event names the holder that posted it. One pass
 * over the `result_posted` rows only, into rows that are still null, so a re-run changes nothing.
 */
export const roomTaskSubmittedByMigration: Migration = {
  version: 67,
  name: 'room_task_submitted_by',
  sql: `
ALTER TABLE room_tasks ADD COLUMN IF NOT EXISTS submitted_by text;
UPDATE room_tasks t SET submitted_by = latest.agent_id
  FROM (
    SELECT DISTINCT ON (task_id) task_id, agent_id FROM room_task_events
      WHERE action = 'result_posted' AND agent_id IS NOT NULL
      ORDER BY task_id, created_at DESC, id DESC
  ) latest
  WHERE t.id = latest.task_id AND t.submitted_by IS NULL;
`,
};

/** Idempotent; call before runMigrations (after the room format migration). */
export function registerRoomTasksMigration(): void {
  registerMigration(roomTasksMigration);
  registerMigration(roomTaskReviewEventsMigration);
  registerRoomTaskReviewsMigration();
  registerMigration(roomTaskTemplatesMigration);
  registerMigration(roomTaskStagesMigration);
  registerMigration(roomTaskCommentsMigration);
  registerMigration(roomTaskSubmittedByMigration);
}
