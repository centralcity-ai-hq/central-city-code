import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { postgresDatabase, type Database } from '../server/database.js';
import {
  listMigrations,
  migrationChecksum,
  registerMigration,
  runMigrations,
  type Migration,
} from '../server/migrations.js';

// The exact DDL the v0.5 application executed at startup before versioned migrations.
const V05_CORE = `
    CREATE TABLE IF NOT EXISTS operators (id text PRIMARY KEY, name text NOT NULL, name_key text NOT NULL UNIQUE, password_hash text NOT NULL, salt text NOT NULL);
    CREATE TABLE IF NOT EXISTS workspaces (operator_id text PRIMARY KEY REFERENCES operators(id), data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, operator_id text NOT NULL REFERENCES operators(id), expires_at bigint NOT NULL, created_at bigint NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(operator_id);
    CREATE TABLE IF NOT EXISTS credentials (token_hash text PRIMARY KEY, operator_id text NOT NULL REFERENCES operators(id), agent_id text NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS replay_nonces (agent_id text NOT NULL, nonce text NOT NULL, expires_at bigint NOT NULL, PRIMARY KEY(agent_id, nonce));
    CREATE INDEX IF NOT EXISTS replay_expiry ON replay_nonces(expires_at);
`;
const V05_ASSISTANT = `
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
`;

async function catalog(db: Pick<Database, 'query'>) {
  const columns = (
    await db.query(
      "SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name<>'schema_migrations' ORDER BY table_name,ordinal_position",
    )
  ).rows;
  const indexes = (
    await db.query(
      "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename<>'schema_migrations' ORDER BY tablename,indexname",
    )
  ).rows;
  const constraints = (
    await db.query(
      "SELECT conrelid::regclass::text AS tbl,conname,pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace='public'::regnamespace AND conrelid::regclass::text<>'schema_migrations' ORDER BY 1,2",
    )
  ).rows;
  return { columns, indexes, constraints };
}
async function ledger(db: Pick<Database, 'query'>) {
  return (
    await db.query<{ version: number; name: string; checksum: string }>(
      'SELECT version,name,checksum FROM schema_migrations ORDER BY version',
    )
  ).rows;
}
async function fresh(t: { after: (fn: () => Promise<unknown>) => void }) {
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  return db;
}

test('a fresh database applies every migration once and records checksums', async (t) => {
  const db = await fresh(t);
  const result = await runMigrations(db);
  assert.deepEqual(
    result.applied,
    listMigrations().map((migration) => migration.version),
  );
  assert.deepEqual(
    await ledger(db),
    listMigrations().map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: migrationChecksum(migration),
    })),
  );
  const tables = (
    await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    )
  ).rows.map((row) => row.table_name);
  assert.deepEqual(tables, [
    'agent_manifests',
    'agent_presence',
    'anonymous_receipts',
    'assistant_grants',
    'assistant_receipts',
    'claim_tokens',
    'credentials',
    'oauth_clients',
    'oauth_codes',
    'oauth_families',
    'oauth_pending',
    'oauth_tokens',
    'operators',
    'rate_limits',
    'replay_nonces',
    'runtime_enrollments',
    'schema_migrations',
    'sessions',
    'unclaimed_buckets',
    'unclaimed_stats',
    'workspaces',
  ]);
});

test('migration 001 reproduces the v0.5 startup schema exactly', async (t) => {
  const legacy = await fresh(t);
  await legacy.exec(V05_CORE);
  await legacy.exec(V05_ASSISTANT);
  const migrated = await fresh(t);
  await runMigrations(migrated, listMigrations().slice(0, 1));
  assert.deepEqual(await catalog(migrated), await catalog(legacy));
});

test('re-running is idempotent and leaves the ledger unchanged', async (t) => {
  const db = await fresh(t);
  await runMigrations(db);
  const before = await ledger(db);
  const appliedAt = (await db.query('SELECT applied_at FROM schema_migrations')).rows;
  assert.deepEqual((await runMigrations(db)).applied, []);
  assert.deepEqual(await ledger(db), before);
  assert.deepEqual((await db.query('SELECT applied_at FROM schema_migrations')).rows, appliedAt);
});

test('an existing v0.5 database with data upgrades in place without rewriting rows', async (t) => {
  for (const withAssistant of [false, true]) {
    await t.test(withAssistant ? 'core and assistant tables' : 'core tables only', async (st) => {
      const db = await fresh(st);
      await db.exec(V05_CORE);
      if (withAssistant) await db.exec(V05_ASSISTANT);
      const workspace = {
        paused: false,
        agents: [{ id: 'agent-1', name: 'Existing', lastSequence: 8 }],
        connections: [],
        jobs: [],
        events: [{ id: 'e1', type: 'operator.created' }],
      };
      await db.query('INSERT INTO operators VALUES($1,$2,$3,$4,$5)', [
        'owner-1',
        'Owner',
        'owner',
        'hash',
        'salt',
      ]);
      await db.query('INSERT INTO workspaces VALUES($1,$2::jsonb)', [
        'owner-1',
        JSON.stringify(workspace),
      ]);
      await db.query('INSERT INTO credentials VALUES($1,$2,$3)', ['token', 'owner-1', 'agent-1']);
      await db.query('INSERT INTO sessions VALUES($1,$2,$3,$4)', ['session', 'owner-1', 9, 1]);
      await db.query('INSERT INTO replay_nonces VALUES($1,$2,$3)', ['agent-1', 'nonce', 5]);
      if (withAssistant)
        await db.query(
          "INSERT INTO assistant_grants VALUES('g1','owner-1','gh','label','[\"workspace:read\"]'::jsonb,1,2,NULL,NULL)",
        );
      const dump = async () => {
        const out: Record<string, unknown[]> = {};
        // Migration 7 adds operators.kind; existing columns and rows are otherwise untouched.
        out.operators = (
          await db.query('SELECT id,name,name_key,password_hash,salt FROM operators')
        ).rows;
        for (const table of ['workspaces', 'credentials', 'sessions', 'replay_nonces'])
          out[table] = (await db.query(`SELECT * FROM ${table}`)).rows;
        if (withAssistant) out.grants = (await db.query('SELECT * FROM assistant_grants')).rows;
        return out;
      };
      const before = await dump();
      const result = await runMigrations(db);
      assert.deepEqual(result.applied, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      assert.deepEqual(await dump(), before);
      assert.deepEqual((await db.query('SELECT kind FROM operators')).rows, [{ kind: 'owner' }]);
      assert.equal((await ledger(db)).length, 9);
    });
  }
});

test('a changed applied migration or an unknown applied version refuses to start', async (t) => {
  const db = await fresh(t);
  await runMigrations(db);
  const edited: Migration[] = listMigrations().map((migration) =>
    migration.version === 2 ? { ...migration, sql: `${migration.sql}\n-- edited` } : migration,
  );
  await assert.rejects(runMigrations(db, edited), /Applied migration 2 .*checksum mismatch/);
  await db.query("UPDATE schema_migrations SET checksum='tampered' WHERE version=1");
  await assert.rejects(runMigrations(db), /Applied migration 1 .*checksum mismatch/);
  await db.query('UPDATE schema_migrations SET checksum=$1 WHERE version=1', [
    migrationChecksum(listMigrations()[0]!),
  ]);
  await db.query("INSERT INTO schema_migrations VALUES(999,'from_the_future',now(),'unknown')");
  await assert.rejects(runMigrations(db), /999 is unknown to this build/);
});

test('a failing migration rolls back entirely and records nothing', async (t) => {
  const db = await fresh(t);
  const broken: Migration[] = [
    ...listMigrations(),
    { version: 50, name: 'broken', sql: 'CREATE TABLE later_table (id text); SELECT missing();' },
  ];
  await assert.rejects(runMigrations(db, broken));
  const tables = (
    await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")
  ).rows;
  assert.deepEqual(tables, []);
});

test('concurrent startups apply each migration exactly once', async (t) => {
  const db = await fresh(t);
  const results = await Promise.all([runMigrations(db), runMigrations(db), runMigrations(db)]);
  assert.deepEqual(results.map((result) => result.applied.length).sort(), [0, 0, 9]);
  assert.equal((await ledger(db)).length, 9);
});

test('the managed PostgreSQL adapter runs migrations under the advisory lock (PGlite-backed pool)', async (t) => {
  // No real PostgreSQL server is available locally; a pg.Pool double forwards to PGlite so the
  // postgresDatabase transaction path, advisory lock SQL and multi-statement DDL are exercised.
  const pglite = await fresh(t);
  const statements: string[] = [];
  const run = async (sql: string, params?: unknown[]) => {
    statements.push(sql);
    if (params === undefined && sql.includes(';')) {
      const results = await pglite.exec(sql);
      return { rows: results.at(-1)?.rows ?? [] };
    }
    return { rows: (await pglite.query(sql, params)).rows };
  };
  const pool = {
    on: () => {},
    connect: async () => ({ query: run, release: () => {} }),
    query: run,
    end: async () => {},
  };
  const db = postgresDatabase(pool as unknown as Pool);
  assert.deepEqual((await runMigrations(db)).applied, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // The unlocked check finds no ledger, so the locked path runs.
  assert.equal(statements[0], 'SELECT version,name,checksum FROM schema_migrations');
  assert.equal(statements[1], 'BEGIN');
  assert.match(statements[2]!, /pg_advisory_xact_lock/);
  assert.equal(statements.at(-1), 'COMMIT');
  // On a current schema a start-up is that one read: no transaction, no lock.
  statements.length = 0;
  assert.deepEqual((await runMigrations(db)).applied, []);
  assert.deepEqual(statements, ['SELECT version,name,checksum FROM schema_migrations']);
  assert.equal((await ledger(pglite)).length, 9);
});

test('feature modules register later forward-only migrations', async (t) => {
  assert.throws(
    () => registerMigration({ version: 1, name: 'other', sql: 'SELECT 1' }),
    /already registered/,
  );
  assert.throws(() => registerMigration({ version: 0, name: 'zero', sql: '' }), /positive/);
  assert.throws(() => registerMigration({ version: 7, name: 'Bad Name', sql: '' }), /names/);
  const db = await fresh(t);
  await runMigrations(db);
  registerMigration({
    version: 100,
    name: 'feature_table',
    sql: 'CREATE TABLE IF NOT EXISTS feature_table (id text PRIMARY KEY);',
  });
  assert.deepEqual((await runMigrations(db)).applied, [100]);
  assert.equal((await ledger(db)).at(-1)?.name, 'feature_table');
});

test('preview deployments never apply pending migrations to the shared database', async (t) => {
  const db = await fresh(t);
  await assert.rejects(
    runMigrations(db, listMigrations(), Date.now, false),
    /only applied by production deployments/,
  );
  // The refused attempt rolls back entirely: not even the ledger table is created.
  const tables = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
  );
  assert.equal(tables.rows.length, 0);
  assert.deepEqual(
    (await runMigrations(db)).applied,
    listMigrations().map((item) => item.version),
  );
  // Once production has migrated, a preview of the same build starts normally.
  assert.deepEqual((await runMigrations(db, listMigrations(), Date.now, false)).applied, []);
});

test('on Vercel only an explicit production deployment applies migrations', async (t) => {
  const saved = { VERCEL: process.env.VERCEL, VERCEL_ENV: process.env.VERCEL_ENV };
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  process.env.VERCEL = '1';
  for (const env of [undefined, 'preview', 'development']) {
    if (env === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = env;
    await assert.rejects(runMigrations(await fresh(t)), /only applied by production deployments/);
  }
  process.env.VERCEL_ENV = 'production';
  assert.ok((await runMigrations(await fresh(t))).applied.length > 0);
  // Isolated previews (per-preview database branch) may migrate their own branch; the flag is
  // ignored outside preview.
  const savedIsolated = process.env.CITY_PREVIEW_DB_ISOLATED;
  t.after(() => {
    if (savedIsolated === undefined) delete process.env.CITY_PREVIEW_DB_ISOLATED;
    else process.env.CITY_PREVIEW_DB_ISOLATED = savedIsolated;
  });
  process.env.CITY_PREVIEW_DB_ISOLATED = '1';
  process.env.VERCEL_ENV = 'preview';
  assert.ok((await runMigrations(await fresh(t))).applied.length > 0);
  process.env.VERCEL_ENV = 'development';
  await assert.rejects(runMigrations(await fresh(t)), /only applied by production deployments/);
});
