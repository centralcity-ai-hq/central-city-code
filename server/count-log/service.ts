import { randomBytes, sign } from 'node:crypto';
import { rootAndConsistency } from './tree.js';
import type { Database, Transaction as Tx } from '../database.js';
import type { SigningKey } from '../manifest/keys.js';
import { countNew24h, pendingFeed, type Feed } from './pending.js';
import {
  agentLeafHash,
  checkpointHash,
  checkpointSigningInput,
  inclusionProofFromLevels,
  treeLevels,
  toHex,
  type AgentProof,
  type Checkpoint,
  type CheckpointBodyV2,
  type PublicCheckpoint,
  type Subcounts,
  subcountsCommitment,
  toPublicCheckpoint,
  V2_GENESIS_PREV_HASH,
} from '../../shared/count-log/index.js';

/*
 * The verifiable agent count. Once a
 * day the checkpoint job appends every newly counted agent as a salted leaf, lists agents that are
 * no longer counted as withdrawn (never erased), and publishes a hash-chained, signed checkpoint
 * with the consistency proof from the previous one. Agents recorded from the noon cut
 * (12:00 Europe/Berlin) on wait for the next day's checkpoint. The counting rule is the ticker's
 * (server/stats/public-stats.ts): every agent in any workspace document except the console demo
 * seed (demoKey) and operators listed in CITY_STATS_EXCLUDED_OPERATORS.
 */

/** Serializes checkpoint runs across instances (distinct from the schema lock). */
export const COUNT_LOG_LOCK_KEY = 1128485529;
export const LEAVES_PAGE_MAX = 10_000;
/**
 * How long one instance reuses the "new in the last 24 h" count: the feed head's edge cache
 * (routes.ts LIVE, s-maxage=2). At most one COUNT per instance per window however many viewers
 * poll; concurrent requests share the one in flight.
 */
export const NEW_24H_CACHE_MS = 2_000;

/** Leaves per INSERT and per committed transaction. */
export const APPEND_BATCH = 1_000;
/** Leaf hashes read per query when the tree is hashed. */
export const TREE_PAGE = 50_000;
/**
 * Wall time one checkpoint() call spends appending before it stops and leaves the rest to the
 * next call. The function stops at 300 s (vercel.json maxDuration); the rest of that is kept for
 * the listing scan and the final tree hash, and the cron retries every 5 minutes until midnight.
 */
export const CHECKPOINT_BUDGET_MS = 150_000;
/**
 * Limits each checkpoint transaction sets for itself (SET LOCAL), whatever startup settings the
 * pooled connection kept (the pool's are 8 s, 5 s and 10 s). The listing scans every workspace
 * and the seal streams the whole tree, so they get more room than one append batch. The lock
 * wait is bounded too: a run stuck behind another instance fails, and the next cron call retries.
 */
export const CHECKPOINT_TX_LIMITS = {
  listing: { statement: '120s', lock: '60s', idle: '60s' },
  batch: { statement: '30s', lock: '10s', idle: '30s' },
} as const;

/**
 * Thrown when a run stopped at its time budget with agents still to append. Everything appended
 * so far is committed; the next call continues and only then signs today's checkpoint.
 */
export class CheckpointInProgress extends Error {
  constructor(
    readonly appended: number,
    readonly remaining: number | null,
    /** Another run holds the count-log lock; this run did nothing and did not wait for it. */
    readonly busy = false,
  ) {
    super('The checkpoint is not finished; the next run continues it.');
  }
}

/**
 * Takes the count-log lock without waiting. A run that finds it held (another run, or a run whose
 * function was stopped while its statement still executes) stops at once instead of queueing
 * behind it until its own time limit; the next cron firing tries again.
 */
async function tryCountLogLock(tx: Pick<Tx, 'query'>): Promise<boolean> {
  const row = (
    await tx.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [
      COUNT_LOG_LOCK_KEY,
    ])
  ).rows[0];
  return row?.ok === true;
}

const day = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Current state of every counted agent (one row per agent id). */
const COUNTED_SQL = `SELECT DISTINCT ON (a.value->>'id')
    a.value->>'id' AS agent_id,
    a.value->>'createdAt' AS created_at,
    o.kind AS kind,
    (a.value->>'revokedAt') IS NOT NULL AS revoked
  FROM workspaces w
  JOIN operators o ON o.id = w.operator_id
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'agents','[]'::jsonb)) AS a(value)
  WHERE a.value->>'demoKey' IS NULL
    AND NOT (w.operator_id = ANY($1::text[]))
  ORDER BY a.value->>'id'`;

/**
 * The shape of a creation time the noon cut reads (ISO 8601 date-time with an explicit zone, offsets
 * within PostgreSQL's +-15:59): anything else counts as having no creation time, so no stored value
 * can make the listing fail. Shared with the test oracle.
 */
export const CREATED_AT_PATTERN =
  '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]' +
  '(:[0-5][0-9]([.][0-9]{1,6})?)?(Z|[+-](0[0-9]|1[0-5]):[0-5][0-9])$';

/**
 * An agent's createdAt (c.created_at) in epoch ms, or NULL when it is missing or not a valid
 * creation time. Guarded so no stored value can make the cast fail: the shape first, then the day
 * against the length of its month, and only then the cast.
 */
const CREATED_MS_SQL = `CASE WHEN c.created_at ~ '${CREATED_AT_PATTERN}' THEN
    CASE WHEN substr(c.created_at, 9, 2)::int <= extract(day FROM
           (substr(c.created_at, 1, 7) || '-01')::date + interval '1 month' - interval '1 day')
         THEN floor(extract(epoch FROM c.created_at::timestamptz) * 1000)::bigint END
  END`;

/**
 * The scan of every workspace runs ONCE per listing transaction, into a transaction-scoped table
 * that the listing, the withdrawals and the sub-counts then read (it used to run three times, and
 * at scale each pass is the most expensive statement of the checkpoint).
 */
const COUNTED_TABLE_SQL = [
  'DROP TABLE IF EXISTS pg_temp.count_log_counted',
  `CREATE TEMP TABLE count_log_counted (
     agent_id text PRIMARY KEY, created_at text, kind text, revoked boolean
   ) ON COMMIT DROP`,
];
const COUNTED_FILL_SQL = `INSERT INTO pg_temp.count_log_counted(agent_id,created_at,kind,revoked) ${COUNTED_SQL}`;

/**
 * Counted agents not yet in the log, with their pending-feed record when there is one. With a cut
 * ($2, epoch ms), an agent the feed recorded at or after it is left for the next day's
 * checkpoint. An agent the feed missed (no pending row) goes by its own createdAt instead (an
 * app-written creation time, not its commit time); agents without a usable createdAt stay
 * included. Eligibility is decided by whichever listing sees the agent: one that becomes visible
 * after a listing is appended by a later run of the same day, or by the next day's checkpoint.
 * The cut keeps agents created continuously after noon from extending the seal; the checkpoint
 * signs exactly the leaves appended when it seals.
 */
const FRESH_SQL = `SELECT c.agent_id, c.created_at, p.salt, p.leaf_hash, p.created_day, p.created_minute,
         p.created_ms, p.seq
    FROM pg_temp.count_log_counted c
    LEFT JOIN count_log_pending p ON p.agent_id = c.agent_id
   WHERE NOT EXISTS (SELECT 1 FROM count_log_leaves l WHERE l.agent_id = c.agent_id)
     AND ($1::bigint IS NULL OR CASE
           WHEN p.seq IS NOT NULL THEN p.recorded_at < $1::bigint
           ELSE COALESCE((${CREATED_MS_SQL}) < $1::bigint, true)
         END)`;

/** Leaves whose agent is no longer counted and not yet withdrawn. */
const WITHDRAW_SQL = `INSERT INTO count_log_withdrawn(idx,reason,day,recorded_at)
  SELECT l.idx, 'no_longer_counted', $1, $2 FROM count_log_leaves l
   WHERE NOT EXISTS (SELECT 1 FROM count_log_withdrawn w WHERE w.idx = l.idx)
     AND NOT EXISTS (SELECT 1 FROM pg_temp.count_log_counted c WHERE c.agent_id = l.agent_id)`;

/**
 * Sub-counts over counted agents whose leaf is not withdrawn. Agents the noon cut left for the
 * next day have no leaf yet and are not in the split, so it still adds up to tree_size - withdrawn.
 */
const SUBCOUNTS_SQL = `SELECT count(*) AS total,
         count(*) FILTER (WHERE c.kind = 'ai') AS ai,
         count(*) FILTER (WHERE c.kind = 'unclaimed') AS unclaimed,
         count(*) FILTER (WHERE c.revoked) AS revoked
    FROM pg_temp.count_log_counted c
    JOIN count_log_leaves l ON l.agent_id = c.agent_id
   WHERE NOT EXISTS (SELECT 1 FROM count_log_withdrawn w WHERE w.idx = l.idx)`;

type FreshRow = {
  agent_id: string;
  created_at: string | null;
  salt: Uint8Array | null;
  leaf_hash: Uint8Array | null;
  created_day: string | null;
  created_minute: string | null;
  created_ms: string | number | null;
  seq: string | number | null;
};
type Fresh = {
  agent_id: string;
  created_day: string;
  pending: { salt: Uint8Array; leaf: Uint8Array; order: [string, number, number] } | null;
};
type CheckpointRow = {
  date: string;
  tree_size: number;
  withdrawn: number;
  root: string;
  prev_hash: string | null;
  hash: string;
  subcounts: Subcounts;
  consistency: string[];
  signature: { kid: string; sig: string } | null;
  v?: number | null;
  subcounts_commitment?: string | null;
};

async function setLimits(
  tx: Pick<Tx, 'query'>,
  limits: (typeof CHECKPOINT_TX_LIMITS)[keyof typeof CHECKPOINT_TX_LIMITS],
): Promise<void> {
  await tx.query(`SET LOCAL statement_timeout = '${limits.statement}'`);
  await tx.query(`SET LOCAL lock_timeout = '${limits.lock}'`);
  await tx.query(`SET LOCAL idle_in_transaction_session_timeout = '${limits.idle}'`);
}

/** The stored checkpoint (internal: a v1 body still carries the split). */
function toCheckpoint(row: CheckpointRow): Checkpoint {
  const common = {
    date: row.date,
    tree_size: Number(row.tree_size),
    withdrawn: Number(row.withdrawn),
    root: row.root,
    prev_hash: row.prev_hash,
    hash: row.hash,
    signature: row.signature,
    consistency: row.consistency,
  };
  if (Number(row.v ?? 1) === 2)
    return { ...common, v: 2, subcounts_commitment: row.subcounts_commitment! };
  return { ...common, v: 1, subcounts: row.subcounts };
}

export interface CheckpointOptions {
  /**
   * The noon cut (shared/count-log cutInstant of the checkpoint's day, epoch ms): agents the
   * pending feed recorded at or after it wait for the next day's checkpoint, so agents created
   * after noon cannot keep the seal running. Agents the feed missed go by their createdAt the same
   * way (those without a usable one are included). Each listing decides by what it can see. Without it, every agent counted at listing time is included.
   */
  cut?: number;
}

export interface CountLog {
  /**
   * Runs today's checkpoint (UTC day of the clock); a second run for the same day is a no-op.
   * Throws CheckpointInProgress when the time budget ran out with agents still to append (the
   * appended ones are committed; call again to continue).
   */
  checkpoint(options?: CheckpointOptions): Promise<{ checkpoint: Checkpoint; created: boolean }>;
  /** Public form: never carries the split (v1 entries are marked subcounts_withheld). */
  checkpoints(): Promise<PublicCheckpoint[]>;
  /**
   * Internal only (ops/admin, never a public route): the private split of one day's checkpoint
   * and, for v2, the salt that opens its commitment.
   */
  subcountsOn(date: string): Promise<{ subcounts: Subcounts; salt: string | null } | null>;
  /** The live pending feed (pending.ts), newest first. */
  feed(options: { before?: string; limit?: number }): Promise<Feed>;
  checkpointOn(date: string): Promise<PublicCheckpoint | null>;
  /** Public leaves under the latest checkpoint only, [from, to). */
  leaves(
    from: number,
    to: number,
  ): Promise<{ tree_size: number; leaves: { idx: number; leaf_hash: string; day: string }[] }>;
  /** Withdrawn leaves with from <= idx < to, in idx order, at most `limit` (LEAVES_PAGE_MAX). */
  withdrawn(
    from?: number,
    to?: number,
    limit?: number,
  ): Promise<{ idx: number; reason: string; day: string }[]>;
  /**
   * The owner's proof for one of their own agents, or null when the agent is not theirs (the
   * caller answers 404 for both "not yours" and "does not exist").
   */
  /** The caller's own agents, id and name only (for "Check my agent"; no workspace tick). */
  ownerAgents(operatorId: string): Promise<{ id: string; name: string }[]>;
  ownerProof(
    operatorId: string,
    agentId: string,
  ): Promise<
    | null
    | { pending: true }
    | { pending: false; excluded: 'demo' | 'not_counted' }
    | { pending: false; proof: AgentProof }
  >;
}

export function createCountLog(deps: {
  db: Database;
  clock: () => number;
  excludedOperators?: readonly string[];
  /** The platform signing key; null serves unsigned checkpoints (and says so). */
  signingKey?: SigningKey | null;
  /** Wall-time budget of one checkpoint() call (CHECKPOINT_BUDGET_MS). */
  budgetMs?: number;
  /** Salt source for agents missing from the pending feed (tests make it deterministic). */
  salt?: () => Uint8Array;
  /** Phase timings of checkpoint() (one JSON line each in production, for the function logs). */
  log?: (event: string, fields: Record<string, number>) => void;
}): CountLog {
  const log = deps.log ?? ((event, fields) => console.info(JSON.stringify({ event, ...fields })));
  const excluded = [...(deps.excludedOperators ?? [])];
  const newSalt = deps.salt ?? (() => randomBytes(32));
  let new24h: { at: number; value: Promise<number> } | null = null;
  function newIn24h(): Promise<number> {
    const now = deps.clock();
    if (new24h && now >= new24h.at && now - new24h.at < NEW_24H_CACHE_MS) return new24h.value;
    const entry = { at: now, value: countNew24h(deps.db, { now, excluded }) };
    // A failed count is not kept: the next request tries again.
    entry.value.catch(() => {
      if (new24h === entry) new24h = null;
    });
    new24h = entry;
    return entry.value;
  }

  async function allLeafHashes(tx: Pick<Tx, 'query'>, size?: number): Promise<Uint8Array[]> {
    const rows = (
      await tx.query<{ leaf_hash: Uint8Array }>(
        `SELECT leaf_hash FROM count_log_leaves${size === undefined ? '' : ' WHERE idx < $1'} ORDER BY idx`,
        size === undefined ? [] : [size],
      )
    ).rows;
    return rows.map((row) => new Uint8Array(row.leaf_hash));
  }

  async function latest(tx: Pick<Tx, 'query'>): Promise<Checkpoint | null> {
    const row = (
      await tx.query<CheckpointRow>(
        'SELECT * FROM count_log_checkpoints ORDER BY date DESC LIMIT 1',
      )
    ).rows[0];
    return row ? toCheckpoint(row) : null;
  }

  /**
   * The latest checkpoint's tree, built once per checkpoint and instance: an
   * owner proof then reads its path from memory instead of loading and hashing every leaf. The
   * rebuilt root must equal the published one, or no proof is served from it.
   */
  let tree: { date: string; size: number; levels: Uint8Array[][] } | null = null;
  let building: { date: string; promise: Promise<Uint8Array[][]> } | null = null;
  async function levelsFor(checkpoint: Checkpoint): Promise<Uint8Array[][]> {
    if (tree && tree.date === checkpoint.date && tree.size === checkpoint.tree_size)
      return tree.levels;
    if (building?.date !== checkpoint.date) {
      const promise = (async () => {
        const levels = await treeLevels(await allLeafHashes(deps.db, checkpoint.tree_size));
        const root = levels.at(-1)?.[0];
        if (checkpoint.tree_size && (!root || toHex(root) !== checkpoint.root))
          throw new Error('The stored leaves do not match the published checkpoint.');
        tree = { date: checkpoint.date, size: checkpoint.tree_size, levels };
        return levels;
      })().finally(() => {
        building = null;
      });
      building = { date: checkpoint.date, promise };
    }
    return building!.promise;
  }

  function signHash(hash: string): Checkpoint['signature'] {
    const key = deps.signingKey;
    if (!key) return null;
    return {
      kid: key.kid,
      sig: sign(null, checkpointSigningInput(hash), key.privateKey).toString('base64url'),
    };
  }

  async function leafCount(tx: Pick<Tx, 'query'>): Promise<number> {
    // idx is dense from 0, so the size is the last idx + 1 (one primary-key probe).
    const row = (
      await tx.query<{ idx: number }>('SELECT idx FROM count_log_leaves ORDER BY idx DESC LIMIT 1')
    ).rows[0];
    return row ? Number(row.idx) + 1 : 0;
  }

  /**
   * Newly counted agents in log order: by creation day and, within a day, agents in the pending
   * feed (pending.ts) first, in its creation order (minute, then ms, then sequence), so their
   * provisional numbers become their idx; then any others by agent id. A pending agent keeps
   * its salt, day and leaf, so the fingerprint shown as pending is exactly the leaf confirmed.
   */
  async function freshAgents(
    tx: Pick<Tx, 'query'>,
    today: string,
    cut: number | undefined,
  ): Promise<Fresh[]> {
    for (const sql of COUNTED_TABLE_SQL) await tx.query(sql);
    await tx.query(COUNTED_FILL_SQL, [excluded]);
    await tx.query('ANALYZE pg_temp.count_log_counted');
    const rows = (await tx.query<FreshRow>(FRESH_SQL, [cut ?? null])).rows;
    return rows
      .map((row): Fresh => ({
        agent_id: row.agent_id,
        created_day:
          row.created_day ??
          (row.created_at && !Number.isNaN(Date.parse(row.created_at))
            ? day(Date.parse(row.created_at))
            : today),
        pending:
          row.leaf_hash && row.salt && row.created_minute !== null && row.seq !== null
            ? {
                salt: new Uint8Array(row.salt),
                leaf: new Uint8Array(row.leaf_hash),
                order: [row.created_minute, Number(row.created_ms ?? -1), Number(row.seq)],
              }
            : null,
      }))
      .sort((a, b) => {
        if (a.created_day !== b.created_day) return a.created_day < b.created_day ? -1 : 1;
        const pa = a.pending?.order;
        const pb = b.pending?.order;
        if (pa && pb) {
          if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
          return pa[1] !== pb[1] ? pa[1] - pb[1] : pa[2] - pb[2];
        }
        if (pa || pb) return pa ? -1 : 1;
        return a.agent_id < b.agent_id ? -1 : 1;
      });
  }

  /** One multi-row INSERT of consecutive leaves from idx `from`. */
  async function appendLeaves(tx: Pick<Tx, 'query'>, batch: Fresh[], from: number, now: number) {
    const values: string[] = [];
    const params: unknown[] = [now];
    for (const [i, agent] of batch.entries()) {
      const salt = agent.pending?.salt ?? newSalt();
      const leaf =
        agent.pending?.leaf ?? (await agentLeafHash(agent.agent_id, salt, agent.created_day));
      const p = params.length;
      values.push(`($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$1)`);
      params.push(
        from + i,
        agent.agent_id,
        Buffer.from(salt),
        agent.created_day,
        Buffer.from(leaf),
      );
    }
    await tx.query(
      `INSERT INTO count_log_leaves(idx,agent_id,salt,created_day,leaf_hash,appended_at) VALUES ${values.join(',')}`,
      params,
    );
  }

  async function* leafPages(tx: Pick<Tx, 'query'>, size: number): AsyncGenerator<Uint8Array[]> {
    for (let from = 0; from < size; from += TREE_PAGE)
      yield (
        await tx.query<{ leaf_hash: Uint8Array }>(
          'SELECT leaf_hash FROM count_log_leaves WHERE idx >= $1 AND idx < $2 ORDER BY idx',
          [from, Math.min(from + TREE_PAGE, size)],
        )
      ).rows.map((row) => new Uint8Array(row.leaf_hash));
  }

  /**
   * With every counted agent in the log: withdraw leaves no longer counted (never erased), count
   * the sub-counts, hash the tree in one streamed pass, then sign and store the checkpoint.
   */
  async function finalize(
    tx: Pick<Tx, 'query'>,
    previous: Checkpoint | null,
    size: number,
    now: number,
  ): Promise<Checkpoint> {
    const today = day(now);
    let mark = Date.now();
    const phase = (name: string, fields: Record<string, number> = {}) => {
      log(`count_log.checkpoint.${name}`, { ms: Date.now() - mark, ...fields });
      mark = Date.now();
    };
    await tx.query(WITHDRAW_SQL, [today, now]);
    phase('withdraw');
    const withdrawn = Number(
      (await tx.query<{ n: string | number }>('SELECT count(*) AS n FROM count_log_withdrawn'))
        .rows[0]!.n,
    );
    const counts = (
      await tx.query<{
        total: string | number;
        ai: string | number;
        unclaimed: string | number;
        revoked: string | number;
      }>(SUBCOUNTS_SQL)
    ).rows[0]!;
    phase('subcounts', { withdrawn });
    const subcounts: Subcounts = {
      in_person_accounts: Number(counts.total) - Number(counts.ai) - Number(counts.unclaimed),
      in_ai_workspaces: Number(counts.ai),
      unclaimed: Number(counts.unclaimed),
      revoked: Number(counts.revoked),
    };
    const { root, consistency: proof } = await rootAndConsistency(
      size,
      previous ? previous.tree_size : null,
      leafPages(tx, size),
    );
    phase('tree_hash', { size });
    // v2: only a salted commitment to the split is signed and published; the split and its salt
    // stay in this table, which no public route reads. v2 starts a new chain: the first v2
    // checkpoint links to no v1 hash (V2_GENESIS_PREV_HASH), since v1 hashes are not published.
    const commitmentSalt = newSalt();
    const body: CheckpointBodyV2 = {
      v: 2,
      date: today,
      tree_size: size,
      withdrawn,
      root: toHex(root),
      prev_hash: previous?.v === 2 ? previous.hash : V2_GENESIS_PREV_HASH,
      subcounts_commitment: await subcountsCommitment(subcounts, commitmentSalt),
    };
    const hash = await checkpointHash(body);
    const consistency = proof.map(toHex);
    const checkpoint: Checkpoint = { ...body, hash, signature: signHash(hash), consistency };
    await tx.query(
      `INSERT INTO count_log_checkpoints(date,tree_size,withdrawn,root,prev_hash,hash,subcounts,consistency,signature,created_at,v,subcounts_commitment,subcounts_salt)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,2,$11,$12)`,
      [
        today,
        body.tree_size,
        body.withdrawn,
        body.root,
        body.prev_hash,
        hash,
        JSON.stringify(subcounts),
        JSON.stringify(consistency),
        checkpoint.signature ? JSON.stringify(checkpoint.signature) : null,
        now,
        body.subcounts_commitment,
        Buffer.from(commitmentSalt),
      ],
    );
    return checkpoint;
  }

  return {
    async checkpoint(options = {}) {
      if (options.cut !== undefined && !Number.isSafeInteger(options.cut))
        throw new Error('The cut must be an epoch time in milliseconds.');
      const started = Date.now();
      const budget = deps.budgetMs ?? CHECKPOINT_BUDGET_MS;
      const now = deps.clock();
      const today = day(now);
      let appended = 0;
      for (;;) {
        // Every pass after a commit checks the budget, so a run always hands over (202) instead of
        // listing again until the function limit while new agents keep arriving.
        if (appended > 0 && Date.now() - started > budget)
          throw new CheckpointInProgress(appended, null);
        // 1. Under the lock: today's checkpoint if it exists; otherwise the agents still to append,
        //    in log order, or (when at most one batch is left) the finished checkpoint.
        const step = await deps.db.transaction(async (tx) => {
          // The scan of every workspace and the streamed tree hash outgrow the pool's 8 s at
          // scale; the run is still bounded by its budget and the function limit.
          await setLimits(tx, CHECKPOINT_TX_LIMITS.listing);
          let mark = Date.now();
          const locked = await tryCountLogLock(tx);
          log('count_log.checkpoint.locked', {
            ms: Date.now() - mark,
            elapsed: Date.now() - started,
            busy: locked ? 0 : 1,
          });
          if (!locked) throw new CheckpointInProgress(appended, null, true);
          mark = Date.now();
          const existing = (
            await tx.query<CheckpointRow>('SELECT * FROM count_log_checkpoints WHERE date=$1', [
              today,
            ])
          ).rows[0];
          if (existing) return { done: { checkpoint: toCheckpoint(existing), created: false } };
          const previous = await latest(tx);
          if (previous && previous.date > today)
            throw new Error('A checkpoint exists for a later day; the clock is behind.');
          const fresh = await freshAgents(tx, today, options.cut);
          const size = await leafCount(tx);
          log('count_log.checkpoint.listed', {
            ms: Date.now() - mark,
            fresh: fresh.length,
            size,
            elapsed: Date.now() - started,
          });
          // The last batch is appended and signed in this same locked transaction. Waiting for a
          // listing that finds nobody never ends while agents are being created all the time
          // (each pass found a few, appended them and listed again until the function limit);
          // agents created after this listing (or recorded after the cut) go into tomorrow's.
          if (fresh.length <= APPEND_BATCH) {
            const tailStart = Date.now();
            if (fresh.length > 0) await appendLeaves(tx, fresh, size, now);
            log('count_log.checkpoint.tail', {
              ms: Date.now() - tailStart,
              fresh: fresh.length,
              elapsed: Date.now() - started,
            });
            return {
              done: {
                checkpoint: await finalize(tx, previous, size + fresh.length, now),
                created: true,
              },
            };
          }
          return { fresh, size };
        });
        if ('done' in step) return step.done!;
        // 2. Append in committed batches, each under the lock and only if the log has not moved
        //    since the list was made (otherwise list again). A run that hits its time budget
        //    stops here; the next run continues from the committed leaves.
        let size = step.size;
        for (let i = 0; i < step.fresh.length; i += APPEND_BATCH) {
          const batch = step.fresh.slice(i, i + APPEND_BATCH);
          const moved = await deps.db.transaction(async (tx) => {
            // Bounded on their own, not by whatever startup settings the pooled connection kept.
            await setLimits(tx, CHECKPOINT_TX_LIMITS.batch);
            if (!(await tryCountLogLock(tx))) {
              log('count_log.checkpoint.busy', { appended, elapsed: Date.now() - started });
              throw new CheckpointInProgress(appended, null, true);
            }
            if (
              (await tx.query('SELECT 1 FROM count_log_checkpoints WHERE date=$1', [today])).rows
                .length ||
              (await leafCount(tx)) !== size
            )
              return true;
            await appendLeaves(tx, batch, size, now);
            return false;
          });
          if (moved) {
            log('count_log.checkpoint.moved', { appended, elapsed: Date.now() - started });
            break;
          }
          size += batch.length;
          appended += batch.length;
          if (appended % (APPEND_BATCH * 25) === 0)
            log('count_log.checkpoint.appended', { appended, size, elapsed: Date.now() - started });
          // Every call commits at least one batch, so repeated calls always make progress.
          if (Date.now() - started > budget && i + APPEND_BATCH < step.fresh.length)
            throw new CheckpointInProgress(appended, step.fresh.length - i - APPEND_BATCH);
        }
      }
    },

    async feed(options) {
      if (options.before !== undefined) return pendingFeed(deps.db, { ...options, excluded });
      // The head page (polled live) also carries the exact count of the last 24 h.
      const [feed, new_24h] = await Promise.all([
        pendingFeed(deps.db, { ...options, excluded }),
        newIn24h(),
      ]);
      return { ...feed, new_24h };
    },
    async checkpoints() {
      return (
        await deps.db.query<CheckpointRow>('SELECT * FROM count_log_checkpoints ORDER BY date')
      ).rows.map((row) => toPublicCheckpoint(toCheckpoint(row)));
    },

    async checkpointOn(date) {
      const row = (
        await deps.db.query<CheckpointRow>('SELECT * FROM count_log_checkpoints WHERE date=$1', [
          date,
        ])
      ).rows[0];
      return row ? toPublicCheckpoint(toCheckpoint(row)) : null;
    },

    async subcountsOn(date) {
      const row = (
        await deps.db.query<{ subcounts: Subcounts; subcounts_salt: Uint8Array | null }>(
          'SELECT subcounts, subcounts_salt FROM count_log_checkpoints WHERE date=$1',
          [date],
        )
      ).rows[0];
      if (!row) return null;
      return {
        subcounts: row.subcounts,
        salt: row.subcounts_salt ? toHex(new Uint8Array(row.subcounts_salt)) : null,
      };
    },

    async leaves(from, to) {
      const size = (await latest(deps.db))?.tree_size ?? 0;
      const end = Math.min(to, size, from + LEAVES_PAGE_MAX);
      if (from >= end) return { tree_size: size, leaves: [] };
      const rows = (
        await deps.db.query<{ idx: number; leaf_hash: Uint8Array; created_day: string }>(
          'SELECT idx, leaf_hash, created_day FROM count_log_leaves WHERE idx >= $1 AND idx < $2 ORDER BY idx',
          [from, end],
        )
      ).rows;
      return {
        tree_size: size,
        leaves: rows.map((row) => ({
          idx: Number(row.idx),
          leaf_hash: toHex(new Uint8Array(row.leaf_hash)),
          day: row.created_day,
        })),
      };
    },

    async withdrawn(from = 0, to = 2_147_483_647, limit = LEAVES_PAGE_MAX) {
      return (
        await deps.db.query<{ idx: number; reason: string; day: string }>(
          'SELECT idx, reason, day FROM count_log_withdrawn WHERE idx >= $1 AND idx < $2 ORDER BY idx LIMIT $3',
          [from, to, Math.min(Math.max(1, limit), LEAVES_PAGE_MAX)],
        )
      ).rows.map((row) => ({ idx: Number(row.idx), reason: row.reason, day: row.day }));
    },

    async ownerAgents(operatorId) {
      return (
        await deps.db.query<{ id: string; name: string }>(
          `SELECT a.value->>'id' AS id, a.value->>'name' AS name FROM workspaces w
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'agents','[]'::jsonb))
              WITH ORDINALITY AS a(value, ordinality)
            WHERE w.operator_id=$1 ORDER BY a.ordinality`,
          [operatorId],
        )
      ).rows.map((row) => ({ id: row.id, name: row.name }));
    },

    async ownerProof(operatorId, agentId) {
      // Ownership first: the agent must be in the caller's own workspace document.
      const owned = (
        await deps.db.query<{ demo: boolean }>(
          `SELECT (a.value->>'demoKey') IS NOT NULL AS demo FROM workspaces w
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'agents','[]'::jsonb)) AS a(value)
            WHERE w.operator_id=$1 AND a.value->>'id'=$2 LIMIT 1`,
          [operatorId, agentId],
        )
      ).rows[0];
      if (!owned) return null;
      // Agents the count never includes are told so, not promised a later checkpoint.
      if (owned.demo) return { pending: false, excluded: 'demo' };
      if (excluded.includes(operatorId)) return { pending: false, excluded: 'not_counted' };
      const leaf = (
        await deps.db.query<{ idx: number; salt: Uint8Array; created_day: string }>(
          'SELECT idx, salt, created_day FROM count_log_leaves WHERE agent_id=$1',
          [agentId],
        )
      ).rows[0];
      const checkpoint = await latest(deps.db);
      if (!leaf || !checkpoint || Number(leaf.idx) >= checkpoint.tree_size)
        return { pending: true };
      const idx = Number(leaf.idx);
      const levels = await levelsFor(checkpoint);
      return {
        pending: false,
        proof: {
          idx,
          salt: toHex(new Uint8Array(leaf.salt)),
          created_day: leaf.created_day,
          checkpoint_date: checkpoint.date,
          tree_size: checkpoint.tree_size,
          audit_path: inclusionProofFromLevels(levels, idx).map(toHex),
        },
      };
    },
  };
}
