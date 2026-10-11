import type { Database } from '../database.js';
import type { Migration } from '../migrations.js';

/**
 * The live log: a public PENDING feed of new agents' fingerprints.
 *
 * When a workspace write adds a counted agent (not a demo seed), a trigger on `workspaces` records
 * it in `count_log_pending` in the same transaction: a fresh secret salt and the agent's v1 leaf
 * (the same bytes as shared/count-log agentLeafHash), its creation day and minute (UTC). The 12:00 Europe/Berlin
 * checkpoint reuses that salt and leaf, so the fingerprint shown as pending is exactly the leaf
 * that gets confirmed; the checkpoint itself (body, hash, signature, proofs) is unchanged and
 * stays the only source of truth. Status is derived by joins, never updated: the table is
 * append-only like the other count-log tables.
 *
 * Never public: agent ids, owner ids, names, kinds, salts. `operator_id` is kept only to apply
 * CITY_STATS_EXCLUDED_OPERATORS at read time.
 */

/**
 * Whether the public feed shows the minute of creation (UTC): pending and confirmed entries
 * show the minute; fingerprints still link to no account. `false` publishes the day only.
 */
export const LIVE_LOG_MINUTE = true;

export const COUNT_LOG_PENDING_TABLES = ['count_log_pending'] as const;

export const countLogPendingMigration: Migration = {
  version: 47,
  name: 'count_log_pending',
  sql: `
CREATE TABLE IF NOT EXISTS count_log_pending (
  seq bigserial PRIMARY KEY,
  agent_id text NOT NULL UNIQUE,
  operator_id text NOT NULL,
  salt bytea NOT NULL CHECK (octet_length(salt) = 32),
  leaf_hash bytea NOT NULL UNIQUE CHECK (octet_length(leaf_hash) = 32),
  created_day text NOT NULL CHECK (created_day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  created_minute text NOT NULL CHECK (created_minute ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$'),
  recorded_at bigint NOT NULL
);
CREATE TRIGGER count_log_pending_append_only BEFORE UPDATE OR DELETE ON count_log_pending
  FOR EACH ROW EXECUTE FUNCTION count_log_append_only();
CREATE TRIGGER count_log_pending_no_truncate BEFORE TRUNCATE ON count_log_pending
  FOR EACH STATEMENT EXECUTE FUNCTION count_log_append_only();

-- The v1 leaf, byte for byte as shared/count-log agentLeafHash:
-- SHA-256(0x00 || "cc-agent-leaf/v1" || u16(len id) || id || salt || u16(len day) || day).
CREATE OR REPLACE FUNCTION count_log_leaf_v1(agent_id text, salt bytea, created_day text)
RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT sha256(
    '\\x00'::bytea || convert_to('cc-agent-leaf/v1', 'UTF8')
    || substring(int4send(octet_length(convert_to(agent_id, 'UTF8'))) from 3 for 2)
    || convert_to(agent_id, 'UTF8') || salt
    || substring(int4send(octet_length(convert_to(created_day, 'UTF8'))) from 3 for 2)
    || convert_to(created_day, 'UTF8'))
$$;

CREATE OR REPLACE FUNCTION count_log_record_pending() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  agent jsonb;
  aid text;
  created timestamptz;
  salt bytea;
  day text;
BEGIN
  FOR agent IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.data->'agents', '[]'::jsonb)) LOOP
    aid := agent->>'id';
    CONTINUE WHEN aid IS NULL OR agent->>'demoKey' IS NOT NULL;
    -- Only agents this write added.
    CONTINUE WHEN TG_OP = 'UPDATE'
      AND COALESCE(OLD.data->'agents', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', aid));
    -- The log must never fail an agent's creation: any error here skips this agent (the daily
    -- checkpoint still counts it, with a fresh salt), and the workspace write goes on.
    BEGIN
      CONTINUE WHEN EXISTS (SELECT 1 FROM count_log_pending WHERE agent_id = aid)
        OR EXISTS (SELECT 1 FROM count_log_leaves WHERE agent_id = aid);
      BEGIN
        created := (agent->>'createdAt')::timestamptz;
      EXCEPTION WHEN others THEN
        created := NULL;
      END;
      -- Missing, unparsable, infinite or out-of-range (beyond year 9999) times: now.
      IF created IS NULL OR NOT isfinite(created)
          OR extract(year FROM created AT TIME ZONE 'UTC') NOT BETWEEN 1970 AND 9999 THEN
        created := clock_timestamp();
      END IF;
      -- 32 bytes from two random UUIDs (about 244 random bits) through SHA-256.
      salt := sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()));
      day := to_char(created AT TIME ZONE 'UTC', 'YYYY-MM-DD');
      INSERT INTO count_log_pending(agent_id, operator_id, salt, leaf_hash, created_day,
          created_minute, recorded_at)
        VALUES (aid, NEW.operator_id, salt, count_log_leaf_v1(aid, salt, day), day,
          to_char(created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'),
          floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
        ON CONFLICT DO NOTHING;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'count_log_pending skipped an agent: %', SQLSTATE;
    END;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER count_log_pending_on_insert AFTER INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION count_log_record_pending();
CREATE TRIGGER count_log_pending_on_update AFTER UPDATE OF data ON workspaces
  FOR EACH ROW WHEN (OLD.data->'agents' IS DISTINCT FROM NEW.data->'agents')
  EXECUTE FUNCTION count_log_record_pending();
`,
};

/**
 * Migration 51: one per-agent recorder shared by the trigger and a one-time backfill, and the
 * creation-order index. The backfill records every counted agent that is neither in the log nor
 * pending (the agents created since the last checkpoint before the trigger existed), in creation
 * order, with its real creation minute. Idempotent: an agent already recorded is skipped.
 */
export const countLogPendingBackfillMigration: Migration = {
  version: 51,
  name: 'count_log_pending_backfill',
  sql: `
-- The exact creation time (ms), for the order within a minute; rows from before have none.
ALTER TABLE count_log_pending ADD COLUMN IF NOT EXISTS created_ms bigint;
CREATE INDEX IF NOT EXISTS count_log_pending_created ON count_log_pending(created_minute, created_ms, seq);

CREATE OR REPLACE FUNCTION count_log_record_agent(agent jsonb, operator text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  aid text := agent->>'id';
  created timestamptz;
  salt bytea;
  day text;
BEGIN
  IF aid IS NULL OR agent->>'demoKey' IS NOT NULL THEN
    RETURN;
  END IF;
  -- The log must never fail an agent's creation: any error skips this agent (the daily
  -- checkpoint still counts it, with a fresh salt).
  BEGIN
    IF EXISTS (SELECT 1 FROM count_log_pending WHERE agent_id = aid)
        OR EXISTS (SELECT 1 FROM count_log_leaves WHERE agent_id = aid) THEN
      RETURN;
    END IF;
    BEGIN
      created := (agent->>'createdAt')::timestamptz;
    EXCEPTION WHEN others THEN
      created := NULL;
    END;
    -- Missing, unparsable, infinite or out-of-range (beyond year 9999) times: now.
    IF created IS NULL OR NOT isfinite(created)
        OR extract(year FROM created AT TIME ZONE 'UTC') NOT BETWEEN 1970 AND 9999 THEN
      created := clock_timestamp();
    END IF;
    -- 32 bytes from two random UUIDs (about 244 random bits) through SHA-256.
    salt := sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()));
    day := to_char(created AT TIME ZONE 'UTC', 'YYYY-MM-DD');
    INSERT INTO count_log_pending(agent_id, operator_id, salt, leaf_hash, created_day,
        created_minute, recorded_at, created_ms)
      VALUES (aid, operator, salt, count_log_leaf_v1(aid, salt, day), day,
        to_char(created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'),
        floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
        floor(extract(epoch FROM created) * 1000)::bigint)
      ON CONFLICT DO NOTHING;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'count_log_pending skipped an agent: %', SQLSTATE;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION count_log_record_pending() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  agent jsonb;
BEGIN
  FOR agent IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.data->'agents', '[]'::jsonb)) LOOP
    -- Only agents this write added.
    CONTINUE WHEN TG_OP = 'UPDATE' AND agent->>'id' IS NOT NULL
      AND COALESCE(OLD.data->'agents', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', agent->>'id'));
    PERFORM count_log_record_agent(agent, NEW.operator_id);
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION count_log_backfill_pending() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  rec record;
  before_count bigint := (SELECT count(*) FROM count_log_pending);
BEGIN
  FOR rec IN
    SELECT a.value AS agent, w.operator_id
      FROM workspaces w
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'agents', '[]'::jsonb)) AS a(value)
     WHERE a.value->>'demoKey' IS NULL
     ORDER BY a.value->>'createdAt' NULLS LAST, a.value->>'id'
  LOOP
    PERFORM count_log_record_agent(rec.agent, rec.operator_id);
  END LOOP;
  RETURN (SELECT count(*) FROM count_log_pending) - before_count;
END;
$$;
SELECT count_log_backfill_pending();
`,
};

type Q = Pick<Database, 'query'>;

/**
 * Migration 60: indexes for the live log feed, so its head page reads about one page of rows
 * instead of every recorded agent: the feed's exact order (the page walks it backwards from its
 * cursor) and the leaf hash it joins confirmed entries on (count_log_leaves had only idx and
 * agent_id).
 */
export const countLogFeedIndexesMigration: Migration = {
  version: 60,
  name: 'count_log_feed_indexes',
  sql: `
CREATE INDEX IF NOT EXISTS count_log_pending_order
  ON count_log_pending(created_minute, (COALESCE(created_ms, -1)), seq);
CREATE INDEX IF NOT EXISTS count_log_leaves_leaf ON count_log_leaves(leaf_hash);
`,
};

export const FEED_LIMITS = { default: 50, max: 100 } as const;

export interface FeedEntry {
  fingerprint: string;
  /** The minute (YYYY-MM-DDTHH:MMZ) or, with LIVE_LOG_MINUTE off, the day of creation (UTC). */
  minute?: string;
  day: string;
  /** removed: confirmed then withdrawn, or never counted (one public status for both). */
  status: 'pending' | 'confirmed' | 'removed';
  /** The agent's number: its log index once confirmed. */
  idx?: number;
  /**
   * Pending only: the provisional number, (agents in the latest checkpoint) + its place among the
   * pending agents in creation order. The next checkpoint assigns exactly this idx unless an
   * earlier pending agent is removed first (then later numbers move down by one).
   */
  n?: number;
  checkpoint_date?: string;
}
export interface Feed {
  entries: FeedEntry[];
  /** Cursor for the next (older) page, or null at the end. */
  next: string | null;
  latest_checkpoint: string | null;
  /** Agents counted right now: the latest checkpoint's (minus withdrawn) plus the pending ones. */
  total_now: number;
  /**
   * The head page only (no cursor): agents that joined in the last 24 h, exactly (see
   * countNew24h). Absent on older pages.
   */
  new_24h?: number;
  /**
   * How long the page may be cached: 'final' when every entry is removed (it never changes),
   * 'checkpoint' when none is pending (it can change only at the next 12:00 Europe/Berlin checkpoint),
   * 'live' otherwise.
   */
  stability: 'final' | 'checkpoint' | 'live';
}

/**
 * The page cursor is the last entry's sequence number only: it carries no time. The server looks
 * up that entry's place in the creation order.
 */
function parseCursor(raw: string | undefined): number | null {
  return raw !== undefined && /^\d{1,18}$/.test(raw) ? Number(raw) : null;
}

/**
 * Each pending page row's rank: its place (0-based) in the creation order of all pending entries,
 * as `row_number() OVER (ORDER BY created_minute, created_ms, seq) - 1` over the pending set.
 * Computed as (number of pending entries) - (its place counting from the newest), so only the
 * entries from the page's oldest row up to the newest are numbered, not every pending entry: for
 * the head page that is about one page of rows.
 */
async function rankPending(
  db: Q,
  page: {
    seq: string | number;
    created_minute: string;
    created_ms: string | number | null;
    rank: string | number | null;
  }[],
  options: {
    excluded: string[];
    latest: { date: string; tree_size: number } | undefined;
    pendingWhere: (size: string) => string;
  },
): Promise<void> {
  const last = page.at(-1);
  if (!last) return;
  const { excluded, latest, pendingWhere } = options;
  const ranks = (
    await db.query<{ seq: string | number; rank: string | number }>(
      `WITH newer AS (
         SELECT p.seq, row_number() OVER (
                  ORDER BY p.created_minute DESC, COALESCE(p.created_ms, -1) DESC, p.seq DESC) AS pos
           FROM count_log_pending p
          WHERE ${pendingWhere('$3::int')}
            AND p.created_minute >= $4::text
            AND (p.created_minute, COALESCE(p.created_ms, -1), p.seq) >= ($4::text, $5::bigint, $6::bigint))
       SELECT n.seq,
              (SELECT count(*) FROM count_log_pending p WHERE ${pendingWhere('$3::int')}) - n.pos AS rank
         FROM newer n
        WHERE n.seq = ANY($7::bigint[])`,
      [
        excluded,
        latest?.date ?? null,
        latest?.tree_size ?? 0,
        last.created_minute,
        last.created_ms === null ? -1 : Number(last.created_ms),
        Number(last.seq),
        page.map((row) => Number(row.seq)),
      ],
    )
  ).rows;
  const bySeq = new Map(ranks.map((row) => [Number(row.seq), row.rank]));
  for (const row of page) row.rank = bySeq.get(Number(row.seq)) ?? null;
}

/** One page of the feed, newest created first. */
export async function pendingFeed(
  db: Q,
  options: { before?: string; limit?: number; excluded: readonly string[] },
): Promise<Feed> {
  const limit = Math.min(Math.max(options.limit ?? FEED_LIMITS.default, 1), FEED_LIMITS.max);
  const latest = (
    await db.query<{ date: string; tree_size: number; withdrawn: number }>(
      'SELECT date, tree_size, withdrawn FROM count_log_checkpoints ORDER BY date DESC LIMIT 1',
    )
  ).rows[0];
  const excluded = [...options.excluded];
  // Pending = not in a checkpoint yet and not left behind by a checkpoint dated after its day. A
  // leaf already appended by an unfinished (resumable) checkpoint run is still pending.
  // `created_minute >= day` holds exactly when `created_day >= day` (the minute is the day
  // followed by "T…", both checked formats), and lets count_log_pending_created bound the scan to
  // the days since the latest checkpoint instead of every agent ever recorded.
  const pendingWhere = (size: string) => `NOT EXISTS (SELECT 1 FROM count_log_leaves l
        WHERE l.agent_id = p.agent_id AND l.idx < ${size})
      AND NOT (p.operator_id = ANY($1::text[]))
      AND ($2::text IS NULL OR (p.created_day >= $2 AND p.created_minute >= $2))`;
  const pendingCount = Number(
    (
      await db.query<{ n: string | number }>(
        `SELECT count(*) AS n FROM count_log_pending p WHERE ${pendingWhere('$3::int')}`,
        [excluded, latest?.date ?? null, latest?.tree_size ?? 0],
      )
    ).rows[0]?.n ?? 0,
  );
  const cursorSeq = parseCursor(options.before);
  const cursor =
    cursorSeq === null
      ? null
      : ((
          await db.query<{ minute: string; ms: string | number; seq: string | number }>(
            `SELECT created_minute AS minute, COALESCE(created_ms, -1) AS ms, seq
               FROM count_log_pending WHERE seq = $1`,
            [cursorSeq],
          )
        ).rows[0] ?? null);
  const rows = (
    await db.query<{
      seq: string | number;
      leaf_hash: Buffer;
      created_day: string;
      created_minute: string;
      created_ms: string | number | null;
      idx: number | null;
      withdrawn: boolean;
      checkpoint_date: string | null;
      rank: string | number | null;
    }>(
      `SELECT p.seq, p.leaf_hash, p.created_day, p.created_minute, p.created_ms, l.idx,
              (w.idx IS NOT NULL) AS withdrawn,
              (SELECT c.date FROM count_log_checkpoints c WHERE c.tree_size > l.idx
                ORDER BY c.date LIMIT 1) AS checkpoint_date,
              NULL::bigint AS rank -- filled by rankPending
         FROM count_log_pending p
         LEFT JOIN count_log_leaves l ON l.leaf_hash = p.leaf_hash
         LEFT JOIN count_log_withdrawn w ON w.idx = l.idx
        WHERE ($2::text IS NULL OR (p.created_minute, COALESCE(p.created_ms, -1), p.seq) < ($2::text, $3::bigint, $4::bigint))
          AND NOT (p.operator_id = ANY($1::text[]))
        ORDER BY p.created_minute DESC, COALESCE(p.created_ms, -1) DESC, p.seq DESC LIMIT $5`,
      [
        excluded,
        // An unknown cursor matches nothing (an empty page), never the first page again.
        cursor?.minute ?? (cursorSeq === null ? null : ''),
        cursor === null ? null : Number(cursor.ms),
        cursor === null ? null : Number(cursor.seq),
        limit + 1,
      ],
    )
  ).rows;
  const page = rows.slice(0, limit);
  await rankPending(db, page, { excluded, latest, pendingWhere });
  const entries = page.map((row): FeedEntry => {
    const confirmed = row.idx !== null && row.checkpoint_date !== null;
    // A checkpoint dated after the creation day ran without it: it will not be counted.
    const dropped = !confirmed && latest !== undefined && latest.date > row.created_day;
    return {
      fingerprint: Buffer.from(row.leaf_hash).toString('hex'),
      ...(LIVE_LOG_MINUTE ? { minute: row.created_minute } : {}),
      day: row.created_day,
      // Withdrawn after confirmation and never counted are one public status: removed.
      status: confirmed
        ? row.withdrawn
          ? 'removed'
          : 'confirmed'
        : dropped
          ? 'removed'
          : 'pending',
      ...(confirmed && !row.withdrawn
        ? { idx: Number(row.idx), checkpoint_date: row.checkpoint_date! }
        : {}),
      ...(!confirmed && !dropped && row.rank !== null
        ? { n: (latest?.tree_size ?? 0) + Number(row.rank) }
        : {}),
    };
  });
  return {
    entries,
    next: rows.length > limit ? String(page.at(-1)!.seq) : null,
    latest_checkpoint: latest?.date ?? null,
    total_now: (latest ? latest.tree_size - latest.withdrawn : 0) + pendingCount,
    stability:
      entries.length === 0 || entries.some((entry) => entry.status === 'pending')
        ? 'live'
        : entries.every((entry) => entry.status === 'removed')
          ? 'final'
          : 'checkpoint',
  };
}

export const DAY_MS = 86_400_000;

const minuteOf = (time: number) => `${new Date(time).toISOString().slice(0, 16)}Z`;

/**
 * "New in the last 24 h": the feed entries created in [now - 24 h, now], with the same rule as
 * total_now, so it counts agents that are counted right now. Pending and confirmed entries count;
 * removed ones (withdrawn after confirmation, or left behind by a checkpoint) do not, and neither
 * do excluded operators. The creation time is created_ms; rows from before migration 51 have only
 * the minute and count from the start of that minute. Created exactly 24 h ago counts.
 *
 * One COUNT: an index range on count_log_pending_created (created_minute, ...) over the last day,
 * then unique-key probes into count_log_leaves (agent_id) and count_log_withdrawn (idx).
 * Aggregate only: no per-agent data leaves the query.
 */
export async function countNew24h(
  db: Q,
  options: { now: number; excluded: readonly string[] },
): Promise<number> {
  const since = options.now - DAY_MS;
  const latest = (
    await db.query<{ date: string }>(
      'SELECT date FROM count_log_checkpoints ORDER BY date DESC LIMIT 1',
    )
  ).rows[0];
  const row = (
    await db.query<{ n: string | number }>(
      `SELECT count(*) AS n
         FROM count_log_pending p
         LEFT JOIN count_log_leaves l ON l.agent_id = p.agent_id
        WHERE p.created_minute >= $1
          AND (p.created_ms >= $2 OR (p.created_ms IS NULL AND p.created_minute >= $3))
          AND NOT (p.operator_id = ANY($4::text[]))
          AND CASE WHEN l.idx IS NOT NULL
                THEN NOT EXISTS (SELECT 1 FROM count_log_withdrawn w WHERE w.idx = l.idx)
                ELSE ($5::text IS NULL OR p.created_day >= $5) END`,
      [
        minuteOf(since),
        since,
        // A minute-only row counts when its minute starts at or after `since`.
        minuteOf(Math.ceil(since / 60_000) * 60_000),
        [...options.excluded],
        latest?.date ?? null,
      ],
    )
  ).rows[0];
  return Number(row?.n ?? 0);
}

/** The pending salts and leaves of agents not yet in the log, for the checkpoint. */
export async function pendingLeaves(
  db: Q,
): Promise<
  Map<string, { salt: Buffer; leaf: Buffer; created_day: string; order: [string, number, number] }>
> {
  const rows = (
    await db.query<{
      agent_id: string;
      salt: Buffer;
      leaf_hash: Buffer;
      created_day: string;
      created_minute: string;
      created_ms: string | number | null;
      seq: string | number;
    }>(
      `SELECT p.agent_id, p.salt, p.leaf_hash, p.created_day, p.created_minute, p.created_ms, p.seq
         FROM count_log_pending p
        WHERE NOT EXISTS (SELECT 1 FROM count_log_leaves l WHERE l.agent_id = p.agent_id)`,
    )
  ).rows;
  return new Map(
    rows.map((row) => [
      row.agent_id,
      {
        salt: Buffer.from(row.salt),
        leaf: Buffer.from(row.leaf_hash),
        created_day: row.created_day,
        // The feed's creation order (minute, then sequence): the checkpoint appends in it, so
        // a pending entry's provisional number becomes its idx.
        order: [row.created_minute, Number(row.created_ms ?? -1), Number(row.seq)],
      },
    ]),
  );
}
