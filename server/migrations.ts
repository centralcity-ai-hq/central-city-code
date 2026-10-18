import { createHash } from 'node:crypto';
import type { Database, Transaction } from './database.js';

/**
 * Versioned, forward-only schema migrations. Each migration runs once, in version order,
 * inside a single transaction that holds the schema advisory lock, and is recorded with a
 * checksum. Editing an applied migration is a startup error: add a new migration instead.
 * The same SQL runs on PGlite and managed PostgreSQL.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * Optional counts measured just before `sql` runs, in the same transaction, and written as one
   * structured log line (`event`), so a data migration shows what it changed in the runtime logs
   * without anyone reading the database. Counts only: never ids or other row data. Not part of the
   * checksum.
   */
  report?: {
    event: string;
    measure(tx: Pick<Transaction, 'query'>): Promise<Record<string, number>>;
  };
}

/** Where migration reports go: one JSON line on stdout (Vercel runtime logs). */
export type MigrationLog = (event: string, fields: Record<string, number>) => void;
const logMigration: MigrationLog = (event, fields) =>
  console.info(JSON.stringify({ event, ...fields }));

/** Shared with the previous ad-hoc startup DDL so old and new instances serialize. */
export const SCHEMA_LOCK_KEY = 1128485465;

/**
 * v0.5 schema exactly as the previous startup DDL created it (server/app.ts and
 * server/assistant-access.ts). IF NOT EXISTS makes it a no-op on databases that already
 * have these tables, so existing data is adopted without rewrite.
 */
const baseline: Migration = {
  version: 1,
  name: 'baseline_v0_5',
  sql: `
CREATE TABLE IF NOT EXISTS operators (id text PRIMARY KEY, name text NOT NULL, name_key text NOT NULL UNIQUE, password_hash text NOT NULL, salt text NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces (operator_id text PRIMARY KEY REFERENCES operators(id), data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, operator_id text NOT NULL REFERENCES operators(id), expires_at bigint NOT NULL, created_at bigint NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(operator_id);
CREATE TABLE IF NOT EXISTS credentials (token_hash text PRIMARY KEY, operator_id text NOT NULL REFERENCES operators(id), agent_id text NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS replay_nonces (agent_id text NOT NULL, nonce text NOT NULL, expires_at bigint NOT NULL, PRIMARY KEY(agent_id, nonce));
CREATE INDEX IF NOT EXISTS replay_expiry ON replay_nonces(expires_at);
CREATE TABLE IF NOT EXISTS assistant_grants (
  id text PRIMARY KEY, operator_id text NOT NULL REFERENCES operators(id),
  token_hash text NOT NULL UNIQUE, label text NOT NULL, scopes jsonb NOT NULL,
  created_at bigint NOT NULL, expires_at bigint NOT NULL, last_used_at bigint, revoked_at bigint
);
CREATE INDEX IF NOT EXISTS assistant_grants_owner ON assistant_grants(operator_id);
CREATE TABLE IF NOT EXISTS assistant_receipts (
  grant_id text NOT NULL REFERENCES assistant_grants(id) ON DELETE CASCADE,
  tool text NOT NULL, request_key text NOT NULL, request_hash text NOT NULL, resource_id text NOT NULL,
  PRIMARY KEY(grant_id,tool,request_key)
);
`,
};

/** Runtime presence and heartbeat sequence, outside the workspace JSON row. */
const agentPresence: Migration = {
  version: 2,
  name: 'agent_presence',
  sql: `
CREATE TABLE IF NOT EXISTS agent_presence (
  agent_id text PRIMARY KEY, operator_id text NOT NULL REFERENCES operators(id),
  last_seen_at bigint, sequence bigint NOT NULL DEFAULT -1, updated_at bigint NOT NULL,
  credential_hash text
);
CREATE INDEX IF NOT EXISTS agent_presence_owner ON agent_presence(operator_id);
`,
};

/** Fixed-window counters shared by every hosted instance. Keys are stored hashed. */
const rateLimits: Migration = {
  version: 3,
  name: 'rate_limits',
  sql: `
CREATE TABLE IF NOT EXISTS rate_limits (
  key_hash text PRIMARY KEY, window_start bigint NOT NULL, count integer NOT NULL, expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires_at);
`,
};

/** OAuth 2.1 authority for the remote MCP front door (server/oauth). Never exported by backups. */
const oauth: Migration = {
  version: 4,
  name: 'oauth',
  sql: `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id text PRIMARY KEY, client_name text NOT NULL, redirect_uris jsonb NOT NULL,
  created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_pending (
  id text PRIMARY KEY, form_hash text NOT NULL, browser_hash text NOT NULL,
  client_id text NOT NULL, client_name text NOT NULL, client_verified boolean NOT NULL,
  redirect_uri text NOT NULL, code_challenge text NOT NULL, resource text NOT NULL,
  scopes jsonb NOT NULL, state text, operator_id text REFERENCES operators(id) ON DELETE CASCADE,
  created_at bigint NOT NULL, expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_pending_expiry ON oauth_pending(expires_at);
CREATE TABLE IF NOT EXISTS oauth_families (
  id text PRIMARY KEY, grant_id text NOT NULL REFERENCES assistant_grants(id) ON DELETE CASCADE,
  client_id text NOT NULL, resource text NOT NULL, scopes jsonb NOT NULL,
  created_at bigint NOT NULL, revoked_at bigint
);
CREATE INDEX IF NOT EXISTS oauth_families_grant ON oauth_families(grant_id);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash text PRIMARY KEY, grant_id text NOT NULL REFERENCES assistant_grants(id) ON DELETE CASCADE,
  client_id text NOT NULL, redirect_uri text NOT NULL, code_challenge text NOT NULL,
  resource text NOT NULL, scopes jsonb NOT NULL, expires_at bigint NOT NULL, used_at bigint,
  family_id text REFERENCES oauth_families(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS oauth_codes_expiry ON oauth_codes(expires_at);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash text PRIMARY KEY, family_id text NOT NULL REFERENCES oauth_families(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('access','refresh')), created_at bigint NOT NULL,
  expires_at bigint NOT NULL, used_at bigint, revoked_at bigint
);
CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens(family_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_expiry ON oauth_tokens(expires_at);
`,
};

/**
 * Resolved agent manifests, one row per applied revision (server/autonomy). Workspace JSON keeps
 * only the name, hash, revision and lineage; the full resolved document lives here.
 * `operator_id` follows the agent when an unclaimed agent is claimed.
 */
const agentManifests: Migration = {
  version: 5,
  name: 'agent_manifests',
  sql: `
CREATE TABLE IF NOT EXISTS agent_manifests (
  agent_id text NOT NULL, revision integer NOT NULL, manifest_hash text NOT NULL,
  manifest jsonb NOT NULL, created_at bigint NOT NULL,
  operator_id text NOT NULL REFERENCES operators(id),
  PRIMARY KEY(agent_id, revision)
);
CREATE INDEX IF NOT EXISTS agent_manifests_owner ON agent_manifests(operator_id);
`,
};

/** Single-use, short-lived runtime enrollment codes (stored hashed). Authority, never exported. */
const runtimeEnrollment: Migration = {
  version: 6,
  name: 'runtime_enrollment',
  sql: `
CREATE TABLE IF NOT EXISTS runtime_enrollments (
  code_hash text PRIMARY KEY, operator_id text NOT NULL REFERENCES operators(id),
  agent_id text NOT NULL, created_at bigint NOT NULL, expires_at bigint NOT NULL, used_at bigint
);
CREATE INDEX IF NOT EXISTS runtime_enrollments_agent ON runtime_enrollments(agent_id);
CREATE INDEX IF NOT EXISTS runtime_enrollments_expiry ON runtime_enrollments(expires_at);
`,
};

/**
 * Open anonymous creation. Unclaimed agents live in system-owned partition rows of the
 * operators table (`kind = 'unclaimed'`, one per source bucket) that can never sign in, each with
 * its own workspace row, so the existing per-workspace lock and isolation apply unchanged.
 * Claim tokens and anonymous idempotency receipts are stored hashed.
 */
const unclaimedAgents: Migration = {
  version: 7,
  name: 'unclaimed_agents',
  sql: `
ALTER TABLE operators ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'owner' CHECK (kind IN ('owner','unclaimed'));
CREATE TABLE IF NOT EXISTS claim_tokens (
  token_hash text PRIMARY KEY, bucket_id text NOT NULL REFERENCES operators(id),
  agent_ids jsonb NOT NULL, created_at bigint NOT NULL, claimed_at bigint,
  claimed_by text REFERENCES operators(id)
);
CREATE INDEX IF NOT EXISTS claim_tokens_bucket ON claim_tokens(bucket_id);
CREATE TABLE IF NOT EXISTS anonymous_receipts (
  bucket_id text NOT NULL REFERENCES operators(id), tool text NOT NULL, request_key text NOT NULL,
  request_hash text NOT NULL, resource_id text NOT NULL, created_at bigint NOT NULL,
  PRIMARY KEY(bucket_id, tool, request_key)
);
`,
};

/**
 * Atomically updated counters for unclaimed capacity (global agents and partitions, per-site
 * and per-network agents) so anonymous creation never scans or globally locks workspaces, and
 * the scope keys of each unclaimed partition (HMAC of the address prefix, never the address).
 */
const unclaimedCapacity: Migration = {
  version: 8,
  name: 'unclaimed_capacity',
  sql: `
CREATE TABLE IF NOT EXISTS unclaimed_stats (
  scope_key text PRIMARY KEY, agents integer NOT NULL DEFAULT 0 CHECK (agents >= 0),
  buckets integer NOT NULL DEFAULT 0 CHECK (buckets >= 0)
);
CREATE TABLE IF NOT EXISTS unclaimed_buckets (
  operator_id text PRIMARY KEY REFERENCES operators(id), site_key text NOT NULL,
  network_key text NOT NULL, created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS unclaimed_buckets_created ON unclaimed_buckets(created_at);
INSERT INTO unclaimed_stats(scope_key,agents,buckets)
  SELECT 'global', COALESCE(sum(jsonb_array_length(w.data->'agents')),0), count(*)
  FROM workspaces w JOIN operators o ON o.id=w.operator_id WHERE o.kind='unclaimed'
  ON CONFLICT (scope_key) DO NOTHING;
`,
};

/**
 * Partition activity and the wider region scope: `last_used_at` is refreshed under the partition
 * lock whenever a create uses it, and eviction requires idleness by it; `region_key` is the HMAC
 * of the IPv6 /32 (IPv4 /8) for region counters.
 */
const unclaimedPartitionActivity: Migration = {
  version: 9,
  name: 'unclaimed_partition_activity',
  sql: `
ALTER TABLE unclaimed_buckets ADD COLUMN IF NOT EXISTS last_used_at bigint;
ALTER TABLE unclaimed_buckets ADD COLUMN IF NOT EXISTS region_key text;
UPDATE unclaimed_buckets SET last_used_at=created_at WHERE last_used_at IS NULL;
CREATE INDEX IF NOT EXISTS unclaimed_buckets_last_used ON unclaimed_buckets(last_used_at);
`,
};

/**
 * Migration 61: an index for the expiry deletes of sessions (the per-instance sweep and every
 * sign-in delete expired sessions by expires_at; without it each one scanned all sessions).
 */
export const sessionsExpiryMigration: Migration = {
  version: 61,
  name: 'sessions_expiry',
  sql: `
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
`,
};

/**
 * Migration 74: the index behind My agents' Overview "Tasks done" (GET /api/agents/:id/totals):
 * tasks an agent handed in that were approved. A messages-sent total waits: an index on
 * room_messages would lock its writes while it builds inside this transaction.
 */
export const agentTotalsMigration: Migration = {
  version: 74,
  name: 'agent_totals',
  sql: `
CREATE INDEX IF NOT EXISTS room_tasks_done_by ON room_tasks(submitted_by) WHERE status = 'done';
`,
};

/**
 * Migration 75: messages each agent sent in rooms (My agents' Overview "Messages"). A counter row
 * per agent, bumped by a trigger in the same transaction as every room message insert (all
 * insert paths, and older instances during a deploy), so the total never scans room_messages and
 * no index on it is needed. Only AI posts count (sender_kind 'agent'): no system lines, no
 * people's posts. The total means "ever sent": deleting a room removes its messages, but the
 * counter never goes down. `counting_since` marks when counting
 * began; messages created before it are added once by scripts/ops/backfill-message-counts.sql
 * (run off-peak: it scans room_messages, so it is never part of a migration).
 */
export const agentMessageCountsMigration: Migration = {
  version: 75,
  name: 'agent_message_counts',
  sql: `
CREATE TABLE IF NOT EXISTS agent_message_counts (
  agent_id text PRIMARY KEY,
  sent bigint NOT NULL DEFAULT 0 CHECK (sent >= 0)
);
CREATE TABLE IF NOT EXISTS agent_message_counts_meta (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  counting_since bigint NOT NULL,
  backfilled_at bigint
);
INSERT INTO agent_message_counts_meta(id, counting_since)
  VALUES (true, (extract(epoch from now()) * 1000)::bigint)
  ON CONFLICT (id) DO NOTHING;
CREATE OR REPLACE FUNCTION agent_message_counts_bump() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sender_kind = 'agent' THEN
    INSERT INTO agent_message_counts(agent_id, sent) VALUES (NEW.sender_agent_id, 1)
      ON CONFLICT (agent_id) DO UPDATE SET sent = agent_message_counts.sent + 1;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS agent_message_counts_bump ON room_messages;
CREATE TRIGGER agent_message_counts_bump AFTER INSERT ON room_messages
  FOR EACH ROW EXECUTE FUNCTION agent_message_counts_bump();
`,
};

const registry: Migration[] = [
  baseline,
  agentPresence,
  rateLimits,
  oauth,
  agentManifests,
  runtimeEnrollment,
  unclaimedAgents,
  unclaimedCapacity,
  unclaimedPartitionActivity,
];

/** Adds a later migration (e.g. a feature module's tables). Call before createApp. */
export function registerMigration(migration: Migration): void {
  if (!Number.isSafeInteger(migration.version) || migration.version < 1)
    throw new Error('Migration versions are positive integers.');
  if (!/^[a-z0-9_]{1,64}$/.test(migration.name))
    throw new Error('Migration names use lowercase letters, digits and underscores.');
  const existing = registry.find((item) => item.version === migration.version);
  if (existing) {
    if (existing.name === migration.name && existing.sql === migration.sql) return;
    throw new Error(`Migration version ${migration.version} is already registered.`);
  }
  registry.push(migration);
  registry.sort((a, b) => a.version - b.version);
}

export function listMigrations(): readonly Migration[] {
  return [...registry];
}

export function migrationChecksum(migration: Migration): string {
  return createHash('sha256').update(migration.sql).digest('hex');
}

/**
 * Applies pending migrations atomically under the schema advisory lock. Refuses to start when
 * an applied migration's checksum changed or the database has a version this build lacks.
 */
/** Refuses a Vercel preview that has no isolated database of its own (fails closed). */
export function previewIsolated(env: Record<string, string | undefined> = process.env): void {
  if (env.VERCEL === '1' && env.VERCEL_ENV === 'preview' && env.CITY_PREVIEW_DB_ISOLATED !== '1')
    throw new Error(
      'A preview deployment needs its own database branch (CITY_PREVIEW_DB_ISOLATED=1); refusing to start.',
    );
}

export async function runMigrations(
  db: Database,
  migrations: readonly Migration[] = listMigrations(),
  now: () => number = Date.now,
  // Unreleased code must never change the production schema. On Vercel only an explicit
  // production deployment applies migrations
  // (fails closed if VERCEL_ENV is missing); previews start only when the schema is current.
  // A preview may migrate only when CITY_PREVIEW_DB_ISOLATED=1 is set for the Preview
  // environment, which is valid only while the Neon integration's required per-preview database
  // branching is enabled (a preview without its own branch then fails to deploy at all). Remove
  // the variable before ever disabling preview branching.
  applyPending: boolean = process.env.VERCEL !== '1' ||
    process.env.VERCEL_ENV === 'production' ||
    (process.env.VERCEL_ENV === 'preview' && process.env.CITY_PREVIEW_DB_ISOLATED === '1'),
  log: MigrationLog = logMigration,
): Promise<{ applied: number[] }> {
  // A Vercel preview runs branch code before review: it may start only on its own database branch
  // (CITY_PREVIEW_DB_ISOLATED=1, set only for the Preview environment), never on a shared one.
  previewIsolated();
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  if (new Set(ordered.map((item) => item.version)).size !== ordered.length)
    throw new Error('Duplicate migration version.');
  // Every cold start runs this. When the schema is already exactly this build's, one unlocked read
  // proves it (one round trip instead of five, and no wait on the lock behind other starting
  // instances). Anything else (a missing table, a pending, unknown or changed migration) takes
  // the locked path below, which applies or refuses exactly as before.
  if (await schemaCurrent(db, ordered)) return { applied: [] };
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
    await tx.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL, checksum text NOT NULL)',
    );
    const rows = (
      await tx.query<{ version: number | string; name: string; checksum: string }>(
        'SELECT version,name,checksum FROM schema_migrations ORDER BY version',
      )
    ).rows;
    const done = new Set<number>();
    for (const row of rows) {
      const version = Number(row.version);
      const known = ordered.find((item) => item.version === version);
      if (!known)
        throw new Error(
          `Database schema migration ${version} is unknown to this build; refusing to start.`,
        );
      if (known.name !== row.name || migrationChecksum(known) !== row.checksum)
        throw new Error(
          `Applied migration ${version} (${row.name}) checksum mismatch; refusing to start.`,
        );
      done.add(version);
    }
    const pending = ordered.filter((item) => !done.has(item.version));
    if (pending.length && !applyPending)
      throw new Error(
        `Pending schema migrations ${pending.map((item) => item.version).join(', ')} are only applied by production deployments; refusing to start.`,
      );
    const applied: number[] = [];
    for (const migration of ordered) {
      if (done.has(migration.version)) continue;
      const report = migration.report
        ? { event: migration.report.event, fields: await migration.report.measure(tx) }
        : null;
      await tx.exec(migration.sql);
      await tx.query(
        'INSERT INTO schema_migrations(version,name,applied_at,checksum) VALUES($1,$2,$3,$4)',
        [
          migration.version,
          migration.name,
          new Date(now()).toISOString(),
          migrationChecksum(migration),
        ],
      );
      applied.push(migration.version);
      // Logged once the migration is recorded; the transaction commits right after the loop.
      if (report) log(report.event, report.fields);
    }
    return { applied };
  });
}

/** True only when schema_migrations lists exactly `ordered`, each with its name and checksum. */
async function schemaCurrent(db: Database, ordered: readonly Migration[]): Promise<boolean> {
  let rows: { version: number | string; name: string; checksum: string }[];
  try {
    rows = (
      await db.query<{ version: number | string; name: string; checksum: string }>(
        'SELECT version,name,checksum FROM schema_migrations',
      )
    ).rows;
  } catch {
    return false;
  }
  if (rows.length !== ordered.length) return false;
  const applied = new Map(rows.map((row) => [Number(row.version), row]));
  return ordered.every((migration) => {
    const row = applied.get(migration.version);
    return !!row && row.name === migration.name && row.checksum === migrationChecksum(migration);
  });
}
