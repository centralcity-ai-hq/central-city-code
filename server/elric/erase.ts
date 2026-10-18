import { registerMigration, type Migration } from '../migrations.js';
import type { Database, Transaction as Tx } from '../database.js';
import { purgeRoomMentions } from '../rooms/mention-purge.js';
import { settle } from './budget.js';
import { DAY_MS, type ElricKind } from './config.js';
import { registerElricTokenCostMigration } from './token-cost.js';

/**
 * Erasing an owner's Elric data when their account is deleted (Privacy Policy: account data is
 * removed from the live database). `elric_turns` stays append-only for every other path: migration
 * 44 lets the trigger allow a DELETE only for rows of the owner named by the transaction-local
 * setting `elric.erase_owner`, which only eraseElricOwner sets. UPDATE and TRUNCATE stay refused.
 *
 * The cost report keeps its history without any owner: before the turns go, their per-day and
 * per-tier totals (turn count and cost units only) are added to `elric_cost_erased`, which has no
 * owner, agent, room or text column. `elric_global_usage` (per-day totals, no owner) is kept.
 *
 * Tier NULL (refused before routing) is stored as -1 so it can be part of the key.
 */
/** The tables migration 44 adds (recognized by the offline backup, never exported). */
export const ELRIC_ERASE_TABLES = ['elric_cost_erased'] as const;

export const elricEraseMigration: Migration = {
  version: 44,
  name: 'elric_erase_owner',
  sql: `
CREATE TABLE IF NOT EXISTS elric_cost_erased (
  day_index integer NOT NULL,
  tier smallint NOT NULL CHECK (tier IN (-1,0,1,2)),
  turns integer NOT NULL DEFAULT 0 CHECK (turns >= 0),
  cost_units bigint NOT NULL DEFAULT 0 CHECK (cost_units >= 0),
  PRIMARY KEY (day_index, tier)
);
CREATE OR REPLACE FUNCTION elric_turns_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND OLD.owner_id = NULLIF(current_setting('elric.erase_owner', true), '') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'elric_turns is append-only';
END;
$$;
`,
};

/** Registered next to Elric's schema (registerElricMigration), never on import. */
export function registerElricEraseMigration(): void {
  registerMigration(elricEraseMigration);
  // Migration 45 (per-token cost, token-cost.ts) rides on the same registration point.
  registerElricTokenCostMigration();
}

export interface ElricEraseResult {
  turns: number;
  posts: number;
  pending_actions: number;
  invocations: number;
  usage_rows: number;
  agents: number;
  identities: number;
  /** Private Elric chat rooms deleted with all their content (rows and the room itself). */
  private_rooms: number;
}

/** A table name from the catalog, quoted as a SQL identifier. */
const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Room content keyed through a parent row rather than room_id: deleted first. */
const ROOM_GRANDCHILDREN = [
  'DELETE FROM room_task_events WHERE task_id IN (SELECT id FROM room_tasks WHERE room_id = ANY($1))',
  `DELETE FROM room_comments WHERE proposal_id IN (SELECT id FROM room_proposals WHERE room_id = ANY($1))
     OR file_id IN (SELECT id FROM room_files WHERE room_id = ANY($1))`,
  'DELETE FROM room_reviews WHERE proposal_id IN (SELECT id FROM room_proposals WHERE room_id = ANY($1))',
  'DELETE FROM room_evidence WHERE proposal_id IN (SELECT id FROM room_proposals WHERE room_id = ANY($1))',
  'DELETE FROM room_proposal_revisions WHERE proposal_id IN (SELECT id FROM room_proposals WHERE room_id = ANY($1))',
  'DELETE FROM room_file_versions WHERE file_id IN (SELECT id FROM room_files WHERE room_id = ANY($1))',
];

/**
 * Hard-deletes rooms with all their content in the caller's transaction: every table with a
 * room_id column (messages, members, mentions, receipts, events, Elric turns and posts...), after
 * the rows that hang off those tables, then the room rows. Elric turns of an owner can only go
 * while the transaction names that owner in `elric.erase_owner` (the caller sets it).
 */
export async function purgeRooms(tx: Pick<Tx, 'query'>, rooms: string[]): Promise<void> {
  if (rooms.length === 0) return;
  // A private room is hard-deleted, not tombstoned: nothing of it is kept. Every table with a
  // room_id column (messages, members, mentions, receipts, events, results...), after the
  // rows that hang off those tables, then the room row.
  const tables = new Set(
    (
      await tx.query<{ table_name: string }>(
        `SELECT c.table_name FROM information_schema.columns c
             JOIN information_schema.tables t
               ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            WHERE c.table_schema = current_schema() AND c.column_name = 'room_id'
              AND t.table_type = 'BASE TABLE'`,
      )
    ).rows.map((row) => row.table_name),
  );
  for (const sql of ROOM_GRANDCHILDREN)
    if (tables.has(/FROM (\w+)/.exec(sql)![1])) await tx.query(sql, [rooms]);
  // @mentions go first, and each agent's unread backlog follows (wake_cursors rows in sorted
  // order, like the room-delete path): a mention still unread, such as an owner post whose
  // Elric run was pending, would otherwise stay counted against the agent's unread cap.
  // The cursors are locked before the mention rows (purgeRoomMentions), like every ack path.
  if (tables.has('mentions')) await purgeRoomMentions(tx, rooms);
  // Tables referencing another room_id table go first (foreign keys have no cascade).
  const order = [...tables].filter((t) => t !== 'rooms' && t !== 'mentions').sort();
  const refs = (
    await tx.query<{ child: string; parent: string }>(
      `SELECT tc.table_name AS child, ccu.table_name AS parent
           FROM information_schema.table_constraints tc
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema()`,
    )
  ).rows;
  const done = new Set<string>();
  const visit = (table: string) => {
    if (done.has(table)) return;
    done.add(table);
    for (const r of refs) if (r.parent === table && order.includes(r.child)) visit(r.child);
    sequence.push(table);
  };
  const sequence: string[] = [];
  for (const table of order) visit(table);
  // visit() pushes a table after the tables that reference it: children are deleted first.
  for (const table of sequence)
    await tx.query(`DELETE FROM ${quoteIdent(table)} WHERE room_id = ANY($1)`, [rooms]);
  await tx.query('DELETE FROM rooms WHERE id = ANY($1)', [rooms]);
}

/**
 * Releases the reservations of invocations about to be deleted (queued, deferred or running): a
 * run's finish() settles only while its row exists, so without this the units would stay counted
 * against the global ceiling (and the owner's allowance) until the day rolls over. What a row
 * already spent, plus a model call in flight, counts as spent; the allowance comes back only when
 * nothing was spent and no call was in flight (as a run cut off mid-flight settles).
 */
async function settleDeleted(tx: Pick<Tx, 'query'>, where: string, params: unknown[]) {
  const rows = (
    await tx.query<{
      owner_id: string;
      kind: ElricKind | null;
      usage_day: string | null;
      reserved_units: string | number;
      spent_units: string | number;
      inflight_units: string | number;
    }>(
      `SELECT owner_id, kind, usage_day, reserved_units, spent_units, inflight_units
         FROM elric_invocations WHERE ${where} AND reserved_units > 0 FOR UPDATE`,
      params,
    )
  ).rows;
  for (const row of rows) {
    if (!row.kind || !row.usage_day) continue;
    await settle(tx, {
      ownerId: row.owner_id,
      kind: row.kind,
      day: row.usage_day,
      reserved: Number(row.reserved_units),
      spent: Number(row.spent_units) + Number(row.inflight_units),
      refund: Number(row.spent_units) + Number(row.inflight_units) === 0,
    });
  }
}

/**
 * Deletes every Elric row of one owner in one transaction: turns (after folding their cost into
 * the anonymous totals), posts attribution, pending actions, invocations, per-owner usage, the
 * agent markers and the verified identity. Idempotent. Call it from the account-deletion path.
 */
export async function eraseElricOwner(
  db: Pick<Database, 'transaction'>,
  ownerId: string,
): Promise<ElricEraseResult> {
  return db.transaction(async (tx) => {
    await tx.query("SELECT set_config('elric.erase_owner', $1, true)", [ownerId]);
    await tx.query(
      `INSERT INTO elric_cost_erased(day_index,tier,turns,cost_units)
       SELECT floor(created_at / ${DAY_MS})::int, COALESCE(tier,-1), count(*)::int,
              COALESCE(sum(cost_units),0)
         FROM elric_turns WHERE owner_id=$1 GROUP BY 1,2
       ON CONFLICT (day_index,tier) DO UPDATE SET
         turns = elric_cost_erased.turns + EXCLUDED.turns,
         cost_units = elric_cost_erased.cost_units + EXCLUDED.cost_units`,
      [ownerId],
    );
    // The owner's private Elric chat rooms (migration 43): found before elric_agents goes.
    const rooms = (
      await tx.query<{ id: string }>(
        `SELECT id FROM rooms WHERE elric_private AND (host_owner_id=$1
           OR id IN (SELECT chat_room_id FROM elric_agents WHERE owner_id=$1))`,
        [ownerId],
      )
    ).rows.map((row) => row.id);
    const del = async (sql: string) =>
      (await tx.query(`${sql} RETURNING 1`, [ownerId])).rows.length;
    // Streamed drafts of this owner's Elrics (migration 46): transient, removed with them.
    await tx.query(
      'DELETE FROM elric_drafts WHERE agent_id IN (SELECT agent_id FROM elric_agents WHERE owner_id=$1)',
      [ownerId],
    );
    // The owner's cached room catch-ups (migration 66): summaries for this owner only.
    await tx.query('DELETE FROM elric_catch_ups WHERE owner_id=$1', [ownerId]);
    // Before the invocations go: their reservations leave the global ceiling.
    await settleDeleted(tx, 'owner_id=$1', [ownerId]);
    const result: ElricEraseResult = {
      turns: await del('DELETE FROM elric_turns WHERE owner_id=$1'),
      posts: await del('DELETE FROM elric_posts WHERE owner_id=$1'),
      pending_actions: await del('DELETE FROM elric_pending_actions WHERE owner_id=$1'),
      invocations: await del('DELETE FROM elric_invocations WHERE owner_id=$1'),
      usage_rows: await del('DELETE FROM elric_usage WHERE owner_id=$1'),
      agents: await del('DELETE FROM elric_agents WHERE owner_id=$1'),
      identities: await del('DELETE FROM elric_verified_identities WHERE operator_id=$1'),
      private_rooms: rooms.length,
    };
    await purgeRooms(tx, rooms);
    await tx.query("SELECT set_config('elric.erase_owner', '', true)");
    return result;
  });
}

/**
 * Deletes one private Elric conversation of `ownerId` for good, in one transaction: its turns'
 * cost goes into the anonymous totals first (the cost report keeps its history), then the room
 * and everything in it. Returns false when the room is not a private room of this owner.
 */
export async function purgeElricConversation(
  db: Pick<Database, 'transaction'>,
  ownerId: string,
  roomId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const room = (
      await tx.query<{ id: string }>(
        'SELECT id FROM rooms WHERE id=$1 AND elric_private AND host_owner_id=$2 FOR UPDATE',
        [roomId, ownerId],
      )
    ).rows[0];
    if (!room) return false;
    await tx.query("SELECT set_config('elric.erase_owner', $1, true)", [ownerId]);
    await tx.query(
      `INSERT INTO elric_cost_erased(day_index,tier,turns,cost_units)
       SELECT floor(created_at / ${DAY_MS})::int, COALESCE(tier,-1), count(*)::int,
              COALESCE(sum(cost_units),0)
         FROM elric_turns WHERE owner_id=$1 AND room_id=$2 GROUP BY 1,2
       ON CONFLICT (day_index,tier) DO UPDATE SET
         turns = elric_cost_erased.turns + EXCLUDED.turns,
         cost_units = elric_cost_erased.cost_units + EXCLUDED.cost_units`,
      [ownerId, roomId],
    );
    await tx.query(
      'UPDATE elric_agents SET chat_room_id=NULL WHERE owner_id=$1 AND chat_room_id=$2',
      [ownerId, roomId],
    );
    // Before the room's invocations go: an in-flight or deferred run releases its reservation.
    await settleDeleted(tx, 'room_id=$1', [roomId]);
    await purgeRooms(tx, [roomId]);
    await tx.query("SELECT set_config('elric.erase_owner', '', true)");
    return true;
  });
}
