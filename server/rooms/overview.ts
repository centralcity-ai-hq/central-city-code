import type { Transaction as Tx } from '../database.js';
import { iso } from '../model.js';
import { registerMigration, type Migration } from '../migrations.js';
import { MEMBER_LOCK_ORDER, MEMBER_STATUS, activeNowSince } from './member-status.js';
import { pendingSummary } from '../elric/activity.js';

/**
 * Room overview, member activity and the "Needs you" queue (docs/ROOMS.md "Room overview").
 *
 * Everything here is read from rows the server already writes; nothing is estimated.
 *
 * - Counts come from `room_counts`, one row per room kept by triggers on `room_members` and
 *   `room_tasks` in the same transaction as every membership or task write (like
 *   `counted_agent_ids`, migration 59), so an overview never counts members per request.
 *   `checkRoomCounts` compares them with a scan.
 * - AIs active in the last 15 minutes, and AIs active now (member-status.ts isActiveNow, the rule
 *   behind each member's active_now): one range scan of a partial expression index over active
 *   AI members (the same "last activity" as member status: recorded activity, else the join).
 *   Only members the member list shows count: a revoked agent, or an invite guest whose room
 *   credential expired or was revoked, is left out of both counts.
 * - Messages today: `room_members.posts_today` for the UTC day `posts_day`, bumped in the post's
 *   own member update (no extra statement per post).
 */

/** "Active" in the overview: room activity within this window. */
export const OVERVIEW_ACTIVE_MS = 15 * 60_000;
/** Unread mention counts stop at this (the overview says `capped`). */
export const OVERVIEW_COUNT_CAP = 999;
/** An open task nobody claimed for this long is listed for the host in "Needs you". */
export const NEEDS_YOU_UNCLAIMED_MS = 24 * 60 * 60_000;
export const NEEDS_YOU_PAGE_DEFAULT = 20;
const DAY_MS = 86_400_000;

/** The UTC day number of an epoch-ms time (posts_day). */
export const dayOf = (time: number) => Math.floor(time / DAY_MS);

/** Derived data: recomputed from room_members and room_tasks, never exported or restored. */
export const ROOM_COUNTS_SQL = `
CREATE TABLE IF NOT EXISTS room_counts (
  room_id text PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  people integer NOT NULL DEFAULT 0,
  agents integer NOT NULL DEFAULT 0,
  tasks_open integer NOT NULL DEFAULT 0,
  tasks_claimed integer NOT NULL DEFAULT 0,
  tasks_in_review integer NOT NULL DEFAULT 0,
  tasks_done integer NOT NULL DEFAULT 0,
  tasks_cancelled integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION room_counts_add(r text, dp integer, da integer, o integer, c integer,
  v integer, d integer, x integer) RETURNS void LANGUAGE sql AS $$
  -- A write that runs after its room row was deleted (erasure order) keeps no counts row.
  INSERT INTO room_counts AS k(room_id,people,agents,tasks_open,tasks_claimed,tasks_in_review,tasks_done,tasks_cancelled)
    SELECT r,dp,da,o,c,v,d,x WHERE EXISTS (SELECT 1 FROM rooms WHERE id = r)
  ON CONFLICT (room_id) DO UPDATE SET
    people = k.people + EXCLUDED.people, agents = k.agents + EXCLUDED.agents,
    tasks_open = k.tasks_open + EXCLUDED.tasks_open,
    tasks_claimed = k.tasks_claimed + EXCLUDED.tasks_claimed,
    tasks_in_review = k.tasks_in_review + EXCLUDED.tasks_in_review,
    tasks_done = k.tasks_done + EXCLUDED.tasks_done,
    tasks_cancelled = k.tasks_cancelled + EXCLUDED.tasks_cancelled
$$;

-- Active members (removed_at IS NULL), people and AIs.
CREATE OR REPLACE FUNCTION room_counts_members() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.removed_at IS NULL THEN
    PERFORM room_counts_add(OLD.room_id, CASE WHEN OLD.kind = 'person' THEN -1 ELSE 0 END,
      CASE WHEN OLD.kind = 'person' THEN 0 ELSE -1 END, 0, 0, 0, 0, 0);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.removed_at IS NULL THEN
    PERFORM room_counts_add(NEW.room_id, CASE WHEN NEW.kind = 'person' THEN 1 ELSE 0 END,
      CASE WHEN NEW.kind = 'person' THEN 0 ELSE 1 END, 0, 0, 0, 0, 0);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS room_counts_members_write ON room_members;
CREATE TRIGGER room_counts_members_write AFTER INSERT OR DELETE ON room_members
  FOR EACH ROW EXECUTE FUNCTION room_counts_members();
DROP TRIGGER IF EXISTS room_counts_members_update ON room_members;
CREATE TRIGGER room_counts_members_update AFTER UPDATE ON room_members FOR EACH ROW
  WHEN ((OLD.removed_at IS NULL) IS DISTINCT FROM (NEW.removed_at IS NULL)
    OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.room_id IS DISTINCT FROM NEW.room_id)
  EXECUTE FUNCTION room_counts_members();

-- Tasks per status.
CREATE OR REPLACE FUNCTION room_counts_task(r text, s text, n integer) RETURNS void LANGUAGE sql AS $$
  SELECT room_counts_add(r, 0, 0,
    CASE WHEN s = 'open' THEN n ELSE 0 END, CASE WHEN s = 'claimed' THEN n ELSE 0 END,
    CASE WHEN s = 'in_review' THEN n ELSE 0 END, CASE WHEN s = 'done' THEN n ELSE 0 END,
    CASE WHEN s = 'cancelled' THEN n ELSE 0 END)
$$;
CREATE OR REPLACE FUNCTION room_counts_tasks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM room_counts_task(OLD.room_id, OLD.status, -1); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM room_counts_task(NEW.room_id, NEW.status, 1); END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS room_counts_tasks_write ON room_tasks;
CREATE TRIGGER room_counts_tasks_write AFTER INSERT OR DELETE ON room_tasks
  FOR EACH ROW EXECUTE FUNCTION room_counts_tasks();
DROP TRIGGER IF EXISTS room_counts_tasks_update ON room_tasks;
CREATE TRIGGER room_counts_tasks_update AFTER UPDATE ON room_tasks FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.room_id IS DISTINCT FROM NEW.room_id)
  EXECUTE FUNCTION room_counts_tasks();
`;

/** The counts as a scan computes them (backfill, drift check and tests). */
export const ROOM_COUNTS_SCAN_SQL = `
SELECT r.id AS room_id,
  (SELECT count(*) FROM room_members m WHERE m.room_id = r.id AND m.removed_at IS NULL AND m.kind = 'person')::int AS people,
  (SELECT count(*) FROM room_members m WHERE m.room_id = r.id AND m.removed_at IS NULL AND m.kind <> 'person')::int AS agents,
  (SELECT count(*) FROM room_tasks t WHERE t.room_id = r.id AND t.status = 'open')::int AS tasks_open,
  (SELECT count(*) FROM room_tasks t WHERE t.room_id = r.id AND t.status = 'claimed')::int AS tasks_claimed,
  (SELECT count(*) FROM room_tasks t WHERE t.room_id = r.id AND t.status = 'in_review')::int AS tasks_in_review,
  (SELECT count(*) FROM room_tasks t WHERE t.room_id = r.id AND t.status = 'done')::int AS tasks_done,
  (SELECT count(*) FROM room_tasks t WHERE t.room_id = r.id AND t.status = 'cancelled')::int AS tasks_cancelled
FROM rooms r`;

/**
 * Migration 64 `room_overview`:
 * - `room_counts` and its triggers (above), backfilled from the current rows;
 * - `room_members.posts_day` / `posts_today`: the member's posts on that UTC day (0/0 until it
 *   posts; earlier days are not backfilled, so "today" starts counting at deploy);
 * - two partial indexes, kept minimal because they are built inside the migration transaction:
 *   active AI members by last activity (room_members, ~80k rows in production from stress rooms;
 *   only rows with removed_at IS NULL and kind <> 'person'), and open review requests per
 *   reviewer (room_task_reviews, status 'requested' only). The other "Needs you" queries use
 *   existing indexes: mentions by (agent_id, ...) primary key, room_tasks by UNIQUE (room_id,
 *   number), elric_pending_actions by (owner_id, status). room_counts is FK'd to rooms with
 *   ON DELETE CASCADE, so erasing a room erases its counts.
 */
export const roomOverviewMigration: Migration = {
  version: 64,
  name: 'room_overview',
  sql: `${ROOM_COUNTS_SQL}
DELETE FROM room_counts k WHERE NOT EXISTS (SELECT 1 FROM rooms r WHERE r.id = k.room_id);
INSERT INTO room_counts(room_id,people,agents,tasks_open,tasks_claimed,tasks_in_review,tasks_done,tasks_cancelled)
  SELECT * FROM (${ROOM_COUNTS_SCAN_SQL}) s
  ON CONFLICT (room_id) DO UPDATE SET people = EXCLUDED.people, agents = EXCLUDED.agents,
    tasks_open = EXCLUDED.tasks_open, tasks_claimed = EXCLUDED.tasks_claimed,
    tasks_in_review = EXCLUDED.tasks_in_review, tasks_done = EXCLUDED.tasks_done,
    tasks_cancelled = EXCLUDED.tasks_cancelled;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS posts_day integer NOT NULL DEFAULT 0;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS posts_today integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS room_members_ai_activity
  ON room_members(room_id, (GREATEST(COALESCE(last_active_at, 0), joined_at)))
  WHERE removed_at IS NULL AND kind <> 'person';
CREATE INDEX IF NOT EXISTS room_task_reviews_reviewer
  ON room_task_reviews(room_id, reviewer_owner_id, requested_at, id) WHERE status = 'requested';
`,
};

/**
 * Migration 71 `needs_you_dismissed`: the "Needs you" items each person dismissed, one row per
 * (room, owner, kind, item). `item_id` is the item's id, or `<task id>@<updated_at>` for task
 * items (a changed task is due again). Erased with the room (ON DELETE CASCADE, and deleteRoom's
 * purge). Not exported by backups: a restore simply shows dismissed items again.
 */
export const needsYouDismissedMigration: Migration = {
  version: 71,
  name: 'needs_you_dismissed',
  sql: `
CREATE TABLE IF NOT EXISTS needs_you_dismissed (
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('approval','task_to_review','review_request','mention','task_unclaimed')),
  item_id text NOT NULL CHECK (char_length(item_id) <= 240),
  created_at bigint NOT NULL,
  CONSTRAINT needs_you_dismissed_item UNIQUE (room_id, owner_id, kind, item_id)
);
CREATE INDEX IF NOT EXISTS needs_you_dismissed_owner ON needs_you_dismissed(room_id, owner_id);
`,
};

/** Idempotent; registered by server/app.ts after the Elric migrations. */
export function registerRoomOverviewMigration(): void {
  registerMigration(roomOverviewMigration);
  registerMigration(needsYouDismissedMigration);
}

/**
 * A member posted: counts the post for its UTC day and records activity (throttled exactly like
 * touchMembers). One statement, replacing the post's touchMembers call.
 *
 * No wake on your own post: with `ownPost` (an AI's own post), every live member of the posting
 * owner whose read cursor is at the previous head (`seq - 1`) moves to `seq`, so the owner's next
 * unread read or long-poll does not return its own message. Reads are per owner (the least
 * advanced of its cursors, a person member included), hence the owner's members, not only the
 * sender. A cursor behind the previous head stays where it is, so unread messages from others are
 * still delivered (with the post after them). Without `ownPost` (a person's post, a console post
 * in an AI's name, Elric or a hosted auto-reply) no cursor moves: the owner's AIs still read what
 * their person wrote. Call under the room lock, right after `seq` was assigned.
 *
 * The rows are locked in agent_id order first (`MEMBER_LOCK_ORDER`, as touchMembers), so this
 * post and a read of the same owner touching several members never deadlock.
 */
export async function recordPost(
  q: Pick<Tx, 'query'>,
  roomId: string,
  agentId: string,
  time: number,
  ownPost?: { seq: number; ownerId: string },
): Promise<void> {
  const target = `m.room_id=$1 AND m.removed_at IS NULL
        AND (m.agent_id = $2 OR (m.owner_id = $7::text AND m.last_read_seq = $6::bigint - 1))`;
  await q.query(
    `WITH locked AS (SELECT m.agent_id AS id FROM room_members m WHERE ${target} ${MEMBER_LOCK_ORDER})
     UPDATE room_members m
        SET posts_today = CASE WHEN m.agent_id <> $2 THEN m.posts_today
                               WHEN m.posts_day = $4 THEN m.posts_today + 1 ELSE 1 END,
            posts_day = CASE WHEN m.agent_id = $2 THEN $4 ELSE m.posts_day END,
            last_active_at = CASE WHEN m.agent_id = $2
                                   AND (m.last_active_at IS NULL OR m.last_active_at <= $5)
                                  THEN $3 ELSE m.last_active_at END,
            last_read_seq = CASE WHEN m.owner_id = $7::text AND m.last_read_seq = $6::bigint - 1
                                 THEN $6::bigint ELSE m.last_read_seq END
       FROM locked l
      WHERE m.agent_id = l.id AND ${target}`,
    [
      roomId,
      agentId,
      time,
      dayOf(time),
      time - MEMBER_STATUS.touchThrottleMs,
      ownPost?.seq ?? null,
      ownPost?.ownerId ?? null,
    ],
  );
}

/** Messages a member posted today (UTC), from its row. */
export function messagesToday(
  row: { posts_day?: number | string | null; posts_today?: number | string | null },
  time: number,
): number {
  return Number(row.posts_day ?? -1) === dayOf(time) ? Number(row.posts_today ?? 0) : 0;
}

export interface RoomOverview {
  room_id: string;
  /** Active members (people and AIs); revoked agents not yet removed still count, as in member_count. */
  members: {
    total: number;
    people: number;
    ais: number;
    ais_active_15m: number;
    /** AI members with active_now (the header badge and the Active-now list; isActiveNow). */
    ais_active_now: number;
  };
  /** Null while room tasks are off on this server. */
  tasks: { open: number; claimed: number; in_review: number; done: number } | null;
  unread: {
    /**
     * Messages after the caller's read cursor (what city_room_read without since returns). Null
     * in the owner console: a person looking is not an AI reading, so the console keeps no cursor.
     */
    messages: number | null;
    /** Unread @mentions of the caller's members here; stops at 999 (then `mentions_capped`). */
    mentions: number;
    mentions_capped: boolean;
  };
  latest_seq: number;
  as_of: string;
}

type CountsRow = {
  people: number | null;
  agents: number | null;
  tasks_open: number | null;
  tasks_claimed: number | null;
  tasks_in_review: number | null;
  tasks_done: number | null;
  active: string | number;
  active_now: string | number;
  mentions: string | number;
};

/**
 * Counts for one room, two statements' worth of work in one: the kept counters, one index range
 * for active AIs, and the caller's unread mentions (index on agent, room). The active window
 * starts on a whole minute, so the count reveals activity only to the minute, like member status.
 */
export async function roomOverview(
  q: Pick<Tx, 'query'>,
  input: {
    room: { id: string; next_seq: number | string };
    /** The caller's active members here (agent and person rows). */
    members: ReadonlyArray<{
      agent_id: string;
      last_read_seq: number | string;
      visible_from_seq: number | string;
    }>;
    console: boolean;
    tasks: boolean;
    time: number;
  },
): Promise<RoomOverview> {
  const since = Math.floor((input.time - OVERVIEW_ACTIVE_MS) / 60_000) * 60_000;
  const row = (
    await q.query<CountsRow>(
      `SELECT k.people, k.agents, k.tasks_open, k.tasks_claimed, k.tasks_in_review, k.tasks_done,
         act.active, act.active_now,
         (SELECT count(*) FROM (SELECT 1 FROM mentions n
             JOIN room_members m ON m.room_id=n.room_id AND m.agent_id=n.agent_id AND m.removed_at IS NULL
            WHERE n.agent_id = ANY($3::text[]) AND n.room_id=$1 AND n.source_kind='room'
              AND n.read_at IS NULL AND n.source_seq > m.visible_from_seq
            LIMIT $4) s) AS mentions
         FROM (SELECT 1) one LEFT JOIN room_counts k ON k.room_id=$1
         CROSS JOIN LATERAL (
           SELECT count(*) AS active,
                  count(*) FILTER (
                    WHERE GREATEST(COALESCE(m.last_active_at, 0), m.joined_at) >= $5) AS active_now
             FROM room_members m
            WHERE m.room_id=$1 AND m.removed_at IS NULL AND m.kind <> 'person'
              AND GREATEST(COALESCE(m.last_active_at, 0), m.joined_at) >= $2
              -- Only members the member list shows (and isActiveNow accepts): live agents, and
              -- invite guests whose room credential is still valid.
              AND NOT EXISTS (SELECT 1 FROM room_invite_credentials c
                               WHERE c.room_id=m.room_id AND c.agent_id=m.agent_id
                                 AND (c.revoked_at IS NOT NULL OR c.expires_at <= $6))
              AND EXISTS (SELECT 1 FROM workspaces w, jsonb_array_elements(w.data->'agents') a
                           WHERE w.operator_id=m.owner_id AND a->>'id'=m.agent_id
                             AND COALESCE(a->>'revokedAt', '') = '')) act`,
      [
        input.room.id,
        since,
        input.members.map((m) => m.agent_id),
        OVERVIEW_COUNT_CAP + 1,
        Math.max(since, activeNowSince(input.time)),
        input.time,
      ],
    )
  ).rows[0]!;
  const latest = Number(input.room.next_seq) - 1;
  const from = Math.min(...input.members.map((m) => Number(m.visible_from_seq)));
  const cursor = Math.min(...input.members.map((m) => Number(m.last_read_seq)));
  const people = Number(row.people ?? 0);
  const ais = Number(row.agents ?? 0);
  const mentions = Number(row.mentions);
  return {
    room_id: input.room.id,
    members: {
      total: people + ais,
      people,
      ais,
      ais_active_15m: Number(row.active),
      ais_active_now: Number(row.active_now),
    },
    tasks: input.tasks
      ? {
          open: Number(row.tasks_open ?? 0),
          claimed: Number(row.tasks_claimed ?? 0),
          in_review: Number(row.tasks_in_review ?? 0),
          done: Number(row.tasks_done ?? 0),
        }
      : null,
    unread: {
      // Room seqs are gap-free, so this needs no count.
      messages: input.console ? null : Math.max(0, latest - Math.max(cursor, from)),
      mentions: Math.min(mentions, OVERVIEW_COUNT_CAP),
      mentions_capped: mentions > OVERVIEW_COUNT_CAP,
    },
    latest_seq: latest,
    as_of: iso(input.time),
  };
}

// ---------------------------------------------------------------------------------------------
// Needs you

export type NeedsYouKind =
  'approval' | 'task_to_review' | 'review_request' | 'mention' | 'task_unclaimed';
/** Queue order: kinds in this order, each oldest first. */
const KIND_ORDER: readonly NeedsYouKind[] = [
  'approval',
  'task_to_review',
  'review_request',
  'mention',
  'task_unclaimed',
];

export interface NeedsYouTask {
  id: string;
  number: number;
  title: string;
  status: string;
}
export interface NeedsYouItem {
  kind: NeedsYouKind;
  /** Stable id of the item (pending action id, task id, review id, or `<agent>:<mention seq>`). */
  id: string;
  /** Since when it waits: approval/mention created, review requested, task last changed. */
  since: string;
  task?: NeedsYouTask;
  /** review_request: the caller's agent asked to review. mention: the caller's member mentioned. */
  agent_id?: string;
  /** mention: the message seq, sender label and the stored excerpt (untrusted room text). */
  message_seq?: number;
  from_name?: string;
  excerpt?: string;
  /** approval: Elric's pending action (console only); the arguments never leave the server. */
  approval?: { tool: string; summary: string | null; args_hash: string; expires_at: string };
}
export interface NeedsYouPage {
  room_id: string;
  items: NeedsYouItem[];
  next_cursor?: string;
}

type Cursor = { rank: number; at: number; id: string };
export function encodeNeedsYouCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.rank, c.at, c.id])).toString('base64url');
}
export function decodeNeedsYouCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      Number.isInteger(value[0]) &&
      value[0] >= 0 &&
      value[0] < KIND_ORDER.length &&
      Number.isSafeInteger(value[1]) &&
      typeof value[2] === 'string' &&
      value[2].length <= 200
    )
      return { rank: value[0], at: value[1], id: value[2] };
  } catch {
    // invalid
  }
  return null;
}

type Fetched = { at: number; key: string; item: NeedsYouItem };
const MIN_KEY = '';

/**
 * One page of the caller's queue in one room. Each kind is one indexed, LIMITed query; kinds are
 * read in queue order only until the page is full. `host` and `console` decide which kinds apply:
 * tasks to approve and stale open tasks are the host's (only the host approves or cancels);
 * Elric approvals only in the owner console (the owner decides them there). A muted caller gets
 * no review requests (it cannot submit a review).
 */
export interface NeedsYouQueueInput {
  roomId: string;
  operatorId: string;
  memberIds: readonly string[];
  host: boolean;
  console: boolean;
  muted: boolean;
  tasks: boolean;
  time: number;
  limit: number;
  after: Cursor | null;
}

/** Up to `limit + 1` undismissed rows after `after`, in queue order (the extra one means more). */
async function queueRows(
  q: Pick<Tx, 'query'>,
  input: NeedsYouQueueInput,
): Promise<Array<Fetched & { rank: number }>> {
  const items: Array<Fetched & { rank: number }> = [];
  const start = input.after?.rank ?? 0;
  for (let rank = start; rank < KIND_ORDER.length && items.length <= input.limit; rank++) {
    const kind = KIND_ORDER[rank]!;
    const at = rank === start && input.after ? input.after.at : -1;
    const key = rank === start && input.after ? input.after.id : MIN_KEY;
    const want = input.limit + 1 - items.length;
    for (const row of await fetchKind(q, kind, input, at, key, want)) items.push({ ...row, rank });
  }
  return items;
}

export async function needsYou(
  q: Pick<Tx, 'query'>,
  input: NeedsYouQueueInput,
): Promise<NeedsYouPage> {
  const items = await queueRows(q, input);
  const page = items.slice(0, input.limit);
  const last = page.at(-1);
  return {
    room_id: input.roomId,
    items: page.map((row) => row.item),
    ...(items.length > input.limit && last
      ? { next_cursor: encodeNeedsYouCursor({ rank: last.rank, at: last.at, id: last.key }) }
      : {}),
  };
}

/** Queue rows read per page while a dismiss looks for its items. */
const DISMISS_SCAN_PAGE = 200;
/** A dismiss looks at most this far into the queue (`all: true` then answers `more: true`). */
export const NEEDS_YOU_DISMISS_SCAN_MAX = 2_000;

/**
 * The key a dismissal is stored under. A task item's key carries the task's last change, so a
 * task dismissed while in review comes back when it changes and is due again (a new hand-in, or
 * open again and unclaimed for another day). Approvals, reviews and mentions are one-off items.
 */
const dismissKey = (row: Fetched) =>
  row.item.kind === 'task_to_review' || row.item.kind === 'task_unclaimed'
    ? `${row.item.id}@${row.at}`
    : row.item.id;

/**
 * Dismisses the caller's own current items in one room: `ids` (items not in the caller's queue
 * are ignored, so nobody can dismiss another person's items) or every current item (`all`).
 * Items that arrive later are not dismissed. Idempotent.
 */
export async function dismissNeedsYou(
  q: Pick<Tx, 'query'>,
  input: Omit<NeedsYouQueueInput, 'limit' | 'after'> & { ids?: readonly string[]; all?: boolean },
): Promise<{ room_id: string; dismissed: number; more: boolean }> {
  const wanted = new Set(input.ids ?? []);
  const found: Array<{ kind: NeedsYouKind; key: string }> = [];
  let after: Cursor | null = null;
  let scanned = 0;
  let more = false;
  for (;;) {
    const limit = Math.min(DISMISS_SCAN_PAGE, NEEDS_YOU_DISMISS_SCAN_MAX - scanned);
    const rows = await queueRows(q, { ...input, limit, after });
    const page = rows.slice(0, limit);
    for (const row of page)
      if (input.all || wanted.has(row.item.id))
        found.push({ kind: row.item.kind, key: dismissKey(row) });
    scanned += page.length;
    const last = page.at(-1);
    if (rows.length <= limit || !last) break;
    if (scanned >= NEEDS_YOU_DISMISS_SCAN_MAX) {
      more = true;
      break;
    }
    // Each id names at most one current item (a task is in review or open, not both).
    if (!input.all && found.length >= wanted.size) break;
    after = { rank: last.rank, at: last.at, id: last.key };
  }
  let dismissed = 0;
  if (found.length)
    dismissed = (
      await q.query(
        `INSERT INTO needs_you_dismissed(room_id,owner_id,kind,item_id,created_at)
           SELECT $1, $2, u.kind, u.item_id, $3
             FROM unnest($4::text[], $5::text[]) AS u(kind, item_id)
         ON CONFLICT (room_id, owner_id, kind, item_id) DO NOTHING RETURNING 1`,
        [
          input.roomId,
          input.operatorId,
          input.time,
          found.map((row) => row.kind),
          found.map((row) => row.key),
        ],
      )
    ).rows.length;
  return { room_id: input.roomId, dismissed, more: Boolean(input.all) && more };
}

/** SQL: the caller dismissed this item (a unique-key lookup on needs_you_dismissed). */
const dismissed = (kind: NeedsYouKind, room: string, owner: string, item: string) =>
  `EXISTS (SELECT 1 FROM needs_you_dismissed d WHERE d.room_id=${room} AND d.owner_id=${owner}
    AND d.kind='${kind}' AND d.item_id=${item})`;

async function fetchKind(
  q: Pick<Tx, 'query'>,
  kind: NeedsYouKind,
  input: NeedsYouQueueInput,
  at: number,
  key: string,
  limit: number,
): Promise<Fetched[]> {
  const task = (row: { task_id: string; number: number; title: string; status: string }) => ({
    id: row.task_id,
    number: Number(row.number),
    title: row.title,
    status: row.status,
  });
  if (kind === 'approval') {
    if (!input.console) return [];
    const rows = (
      await q.query<{
        id: string;
        tool: string;
        args: unknown;
        args_hash: string;
        created_at: string | number;
        expires_at: string | number;
      }>(
        `SELECT a.id, a.tool, a.args, a.args_hash, a.created_at, a.expires_at
           FROM elric_pending_actions a
          WHERE a.owner_id=$1 AND a.room_id=$2 AND a.status='pending' AND a.expires_at > $3
            AND (a.created_at, a.id) > ($4::bigint, $5::text)
            AND NOT ${dismissed('approval', '$2', '$1', 'a.id')}
          ORDER BY a.created_at, a.id LIMIT $6`,
        [input.operatorId, input.roomId, input.time, at, key, limit],
      )
    ).rows;
    return rows.map((row) => ({
      at: Number(row.created_at),
      key: row.id,
      item: {
        kind,
        id: row.id,
        since: iso(Number(row.created_at)),
        approval: {
          tool: row.tool,
          summary: pendingSummary(row.tool, row.args),
          args_hash: row.args_hash,
          expires_at: iso(Number(row.expires_at)),
        },
      },
    }));
  }
  if (kind === 'task_to_review' || kind === 'task_unclaimed') {
    if (!input.host || !input.tasks) return [];
    const stale = kind === 'task_unclaimed';
    const rows = (
      await q.query<{
        task_id: string;
        number: number;
        title: string;
        status: string;
        updated_at: string | number;
      }>(
        `SELECT t.id AS task_id, t.number, t.title, t.status, t.updated_at FROM room_tasks t
          WHERE t.room_id=$1 AND t.status=$2 AND t.updated_at <= $3
            AND (t.updated_at, t.id) > ($4::bigint, $5::text)
            AND NOT ${dismissed(kind, '$1', '$7', "t.id || '@' || t.updated_at::text")}
          ORDER BY t.updated_at, t.id LIMIT $6`,
        [
          input.roomId,
          stale ? 'open' : 'in_review',
          stale ? input.time - NEEDS_YOU_UNCLAIMED_MS : Number.MAX_SAFE_INTEGER,
          at,
          key,
          limit,
          input.operatorId,
        ],
      )
    ).rows;
    return rows.map((row) => ({
      at: Number(row.updated_at),
      key: row.task_id,
      item: { kind, id: row.task_id, since: iso(Number(row.updated_at)), task: task(row) },
    }));
  }
  if (kind === 'review_request') {
    if (input.muted || !input.tasks) return [];
    const rows = (
      await q.query<{
        id: string;
        requested_at: string | number;
        reviewer_agent_id: string;
        task_id: string;
        number: number;
        title: string;
        status: string;
      }>(
        `SELECT v.id, v.requested_at, v.reviewer_agent_id, t.id AS task_id, t.number, t.title, t.status
           FROM room_task_reviews v JOIN room_tasks t ON t.id = v.task_id AND t.room_id = v.room_id
          WHERE v.room_id=$1 AND v.reviewer_owner_id=$2 AND v.status='requested'
            AND v.reviewer_agent_id = ANY($3::text[])
            AND (v.requested_at, v.id) > ($4::bigint, $5::text)
            AND NOT ${dismissed('review_request', '$1', '$2', 'v.id')}
          ORDER BY v.requested_at, v.id LIMIT $6`,
        [input.roomId, input.operatorId, [...input.memberIds], at, key, limit],
      )
    ).rows;
    return rows.map((row) => ({
      at: Number(row.requested_at),
      key: row.id,
      item: {
        kind,
        id: row.id,
        since: iso(Number(row.requested_at)),
        task: task(row),
        agent_id: row.reviewer_agent_id,
      },
    }));
  }
  // Mentions: keyset on (created_at, agent_id, seq); the key is "<agent_id>:<seq>".
  const split = key.lastIndexOf(':');
  const agentKey = split < 0 ? '' : key.slice(0, split);
  const seqKey = split < 0 ? -1 : Number(key.slice(split + 1));
  const rows = (
    await q.query<{
      agent_id: string;
      seq: string | number;
      source_seq: string | number;
      from_name: string;
      excerpt: string;
      created_at: string | number;
    }>(
      `SELECT n.agent_id, n.seq, n.source_seq, n.from_name, n.excerpt, n.created_at FROM mentions n
         JOIN room_members m ON m.room_id=n.room_id AND m.agent_id=n.agent_id AND m.removed_at IS NULL
        WHERE n.agent_id = ANY($1::text[]) AND n.room_id=$2 AND n.source_kind='room'
          AND n.read_at IS NULL AND n.source_seq > m.visible_from_seq
          AND (n.created_at, n.agent_id, n.seq) > ($3::bigint, $4::text, $5::bigint)
          AND NOT ${dismissed('mention', '$2', '$7', "n.agent_id || ':' || n.seq::text")}
        ORDER BY n.created_at, n.agent_id, n.seq LIMIT $6`,
      [
        [...input.memberIds],
        input.roomId,
        at,
        agentKey,
        Number.isSafeInteger(seqKey) ? seqKey : -1,
        limit,
        input.operatorId,
      ],
    )
  ).rows;
  return rows.map((row) => {
    const id = `${row.agent_id}:${Number(row.seq)}`;
    return {
      at: Number(row.created_at),
      key: id,
      item: {
        kind: 'mention' as const,
        id,
        since: iso(Number(row.created_at)),
        agent_id: row.agent_id,
        message_seq: Number(row.source_seq),
        from_name: row.from_name,
        excerpt: row.excerpt,
      },
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Drift check (daily, inside the fast-count-check cron; server/stats/fast-count-check.ts)

/** The room check's own time budget inside the daily cron run (after the agent count check). */
export const ROOM_COUNTS_CHECK_BUDGET_MS = 5_000;
/** At most this many differing rooms are repaired per run; the rest wait for the next run. */
export const ROOM_COUNTS_REPAIR_MAX_ROOMS = 1_000;

export interface RoomCountsDrift {
  /** Rooms whose kept counts differ from the scan, plus kept rows without a room. */
  rooms: number;
  /** Rooms repaired (set to the scan, or orphan rows deleted) when `repair` was asked. */
  repaired: number;
  /** False when the budget ran out (or a statement failed) before every room was repaired. */
  complete: boolean;
  /** SQLSTATE or `budget_exhausted` when it stopped early; null otherwise. */
  stopped: string | null;
}

const DIFFERING_ROOMS_SQL = `
SELECT COALESCE(s.room_id, k.room_id) AS room_id
  FROM (${ROOM_COUNTS_SCAN_SQL}) s FULL JOIN room_counts k ON k.room_id = s.room_id
 WHERE s.room_id IS NULL
    OR (s.people, s.agents, s.tasks_open, s.tasks_claimed, s.tasks_in_review, s.tasks_done, s.tasks_cancelled)
       IS DISTINCT FROM (COALESCE(k.people,0), COALESCE(k.agents,0), COALESCE(k.tasks_open,0),
         COALESCE(k.tasks_claimed,0), COALESCE(k.tasks_in_review,0), COALESCE(k.tasks_done,0),
         COALESCE(k.tasks_cancelled,0))
 ORDER BY 1 LIMIT $1`;
const REPAIR_ROOM_SQL = `
INSERT INTO room_counts(room_id,people,agents,tasks_open,tasks_claimed,tasks_in_review,tasks_done,tasks_cancelled)
  SELECT * FROM (${ROOM_COUNTS_SCAN_SQL}) s WHERE s.room_id=$1
ON CONFLICT (room_id) DO UPDATE SET people = EXCLUDED.people, agents = EXCLUDED.agents,
  tasks_open = EXCLUDED.tasks_open, tasks_claimed = EXCLUDED.tasks_claimed,
  tasks_in_review = EXCLUDED.tasks_in_review, tasks_done = EXCLUDED.tasks_done,
  tasks_cancelled = EXCLUDED.tasks_cancelled`;

/**
 * Compares `room_counts` with ROOM_COUNTS_SCAN_SQL in one READ ONLY snapshot and, with `repair`,
 * fixes each differing room in its own short transaction (room row lock, like a join). Bounded:
 * one time budget for the whole run, and statement_timeout set to what is left before every
 * statement. Logs and returns counts only, never ids.
 */
export async function checkRoomCounts(
  db: { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> },
  options: {
    repair?: boolean;
    budgetMs?: number;
    now?: () => number;
    log?: (level: 'info' | 'error', fields: Record<string, unknown>) => void;
  } = {},
): Promise<RoomCountsDrift> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? ROOM_COUNTS_CHECK_BUDGET_MS);
  const log = options.log ?? (() => {});
  const bounded = async <T>(tx: Pick<Tx, 'query'>, sql: string, params?: unknown[]) => {
    const left = deadline - now();
    if (left <= 0) throw Object.assign(new Error('budget'), { code: 'budget_exhausted' });
    await tx.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(left))}`);
    return tx.query<T>(sql, params);
  };
  const code = (error: unknown) => {
    const c = (error as { code?: unknown } | null)?.code;
    return typeof c === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(c) ? c : 'error';
  };
  let differing: string[];
  try {
    const present = await db.transaction(
      async (tx) =>
        (await tx.query<{ t: string | null }>("SELECT to_regclass('room_counts')::text AS t"))
          .rows[0]?.t != null,
    );
    // Before migration 64 (or a database without rooms) there is nothing to check.
    if (!present) return { rooms: 0, repaired: 0, complete: true, stopped: null };
    differing = await db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      return (
        await bounded<{ room_id: string }>(tx, DIFFERING_ROOMS_SQL, [ROOM_COUNTS_REPAIR_MAX_ROOMS])
      ).rows.map((row) => row.room_id);
    });
  } catch (error) {
    const stopped = code(error);
    log('error', { event: 'room_counts_check_failed', error: stopped });
    return { rooms: 0, repaired: 0, complete: false, stopped };
  }
  if (!differing.length) {
    log('info', { event: 'room_counts_ok' });
    return { rooms: 0, repaired: 0, complete: true, stopped: null };
  }
  log('error', { event: 'room_counts_drift', rooms: differing.length });
  let repaired = 0;
  let stopped: string | null = null;
  if (options.repair)
    for (const roomId of differing) {
      try {
        await db.transaction(async (tx) => {
          // The room row lock orders the repair with joins, removals and task writes.
          const room = await bounded(tx, 'SELECT 1 FROM rooms WHERE id=$1 FOR UPDATE', [roomId]);
          if (room.rows.length) await bounded(tx, REPAIR_ROOM_SQL, [roomId]);
          else await bounded(tx, 'DELETE FROM room_counts WHERE room_id=$1', [roomId]);
        });
        repaired++;
      } catch (error) {
        stopped = code(error);
        break;
      }
    }
  const complete =
    !!options.repair &&
    stopped === null &&
    repaired === differing.length &&
    differing.length < ROOM_COUNTS_REPAIR_MAX_ROOMS;
  if (options.repair)
    log(complete ? 'info' : 'error', {
      event: complete ? 'room_counts_reconciled' : 'room_counts_repair_partial',
      repaired,
      remaining_rooms: differing.length - repaired,
      ...(stopped ? { error: stopped } : {}),
    });
  return { rooms: differing.length, repaired, complete, stopped };
}
