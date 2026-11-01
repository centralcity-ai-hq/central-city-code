import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { createApp } from '../server/app.js';
import { indexState, prebuildIndexes } from '../server/concurrent-index.js';
import { listMigrations, runMigrations } from '../server/migrations.js';
import {
  GUARD_ROWS,
  ROOM_PURGE_INDEXES,
  ROOM_PURGE_INDEXES_SQL,
} from '../server/rooms/purge-indexes-schema.js';

/*
 * CCA-517: a room delete and the hard purge of private rooms delete by room_id from mentions,
 * room_task_comments, room_join_receipts and elric_catch_ups, which had no index starting with
 * room_id (each delete read the whole table). Migration 301 names those indexes; on a large
 * production table the owner builds them CONCURRENTLY (scripts/room-purge-indexes.ts).
 */
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-cf-migrations-test-stand-in';
const ORIGIN = 'https://centralcity.ai';
const extensions = { btree_gin, pg_trgm };

async function appDatabase(t: { after: (fn: () => Promise<unknown>) => void }) {
  const db = await PGlite.create('memory://', { extensions });
  const app = await createApp({
    database: db,
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
  });
  // The app closes its database.
  t.after(() => app.close());
  return db;
}
const query = (db: PGlite) => async (sql: string) =>
  (await db.query(sql)) as { rows: Array<Record<string, unknown>> };

/** The purge statements, as rooms/service.ts, rooms/mention-purge.ts and elric/erase.ts run them. */
const PURGES: Array<[string, string]> = [
  ['mentions_room', "DELETE FROM mentions WHERE room_id = ANY(ARRAY['r-1'])"],
  ['mentions_room', "SELECT DISTINCT agent_id FROM mentions WHERE room_id = ANY(ARRAY['r-1'])"],
  ['room_task_comments_room', "DELETE FROM room_task_comments WHERE room_id = 'r-1'"],
  ['room_join_receipts_room', "DELETE FROM room_join_receipts WHERE room_id = 'r-1'"],
  ['elric_catch_ups_room', "DELETE FROM elric_catch_ups WHERE room_id = ANY(ARRAY['r-1'])"],
];

test('CCA-517: a migrated database has an index starting with room_id behind every room purge', async (t) => {
  const db = await appDatabase(t);
  for (const index of ROOM_PURGE_INDEXES)
    assert.equal(await indexState(query(db), index.name), 'valid', index.name);
  // The planner can use them (sequential scans off: on a tiny table it would rightly scan).
  await db.exec('SET enable_seqscan = off');
  for (const [name, sql] of PURGES) {
    const plan = (await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`)).rows
      .map((row) => row['QUERY PLAN'])
      .join('\n');
    assert.match(plan, new RegExp(`(using|on) ${name}\\b`), `${sql}\n${plan}`);
  }
});

/** A database on the schema before migration 301, with more than GUARD_ROWS mentions. */
async function largeMentions(t: { after: (fn: () => Promise<unknown>) => void }) {
  await appDatabase(t); // registers every migration
  const db = await PGlite.create('memory://', { extensions });
  t.after(async () => (db.closed ? undefined : db.close()));
  await runMigrations(
    db,
    listMigrations().filter((migration) => migration.version !== 301),
  );
  await db.query(
    `INSERT INTO mentions (agent_id, seq, owner_id, source_kind, source_id, room_id, source_seq,
       from_agent_id, from_name, excerpt, created_at)
     SELECT 'agent-' || (g % 50), g, 'op', 'room', 'm-' || g, 'r-' || (g % 300), g, 'from', 'From',
       'hi', g FROM generate_series(1, ${GUARD_ROWS + 1}) g`,
  );
  return db;
}

test('CCA-517: migration 301 never builds on a large table and never fails; the owner script builds CONCURRENTLY', async (t) => {
  const db = await largeMentions(t);
  const logged: Array<[string, Record<string, number>]> = [];
  const result = await runMigrations(db, listMigrations(), Date.now, true, (event, fields) =>
    logged.push([event, fields]),
  );
  assert.ok(result.applied.includes(301));
  // The large table is left for the script; the small ones are built by the migration.
  assert.equal(await indexState(query(db), 'mentions_room'), 'missing');
  for (const name of ['room_task_comments_room', 'room_join_receipts_room', 'elric_catch_ups_room'])
    assert.equal(await indexState(query(db), name), 'valid', name);
  assert.deepEqual(logged.find(([event]) => event === 'room_purge_indexes')?.[1], {
    valid: 0,
    build_now: 3,
    left_for_script: 1,
    invalid: 0,
  });

  const statements: string[] = [];
  const run = async (sql: string) => {
    statements.push(sql);
    return query(db)(sql);
  };
  // Dry run: reports, builds nothing.
  const dry = await prebuildIndexes(run, ROOM_PURGE_INDEXES, { confirm: false });
  assert.deepEqual(
    dry.map((step) => [step.name, step.action]),
    [
      ['mentions_room', 'would build'],
      ['room_task_comments_room', 'kept'],
      ['room_join_receipts_room', 'kept'],
      ['elric_catch_ups_room', 'kept'],
    ],
  );
  assert.equal(statements.filter((sql) => /CREATE|DROP/.test(sql)).length, 0);
  const built = await prebuildIndexes(run, ROOM_PURGE_INDEXES, { confirm: true });
  assert.deepEqual(
    built.map((step) => [step.name, step.action, step.after]),
    [
      ['mentions_room', 'built', 'valid'],
      ['room_task_comments_room', 'kept', 'valid'],
      ['room_join_receipts_room', 'kept', 'valid'],
      ['elric_catch_ups_room', 'kept', 'valid'],
    ],
  );
  assert.ok(
    statements
      .filter((sql) => /CREATE INDEX/.test(sql))
      .every((sql) => sql.startsWith('CREATE INDEX CONCURRENTLY IF NOT EXISTS')),
  );

  // A failed concurrent build leaves its index invalid: the migration leaves it, the script
  // drops and rebuilds it.
  await db.query(
    "UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'mentions_room'::regclass",
  );
  await db.exec(ROOM_PURGE_INDEXES_SQL);
  assert.equal(await indexState(query(db), 'mentions_room'), 'invalid');
  statements.length = 0;
  const again = await prebuildIndexes(run, ROOM_PURGE_INDEXES, { confirm: true });
  assert.equal(again[0]!.action, 'rebuilt');
  assert.ok(statements.includes('DROP INDEX CONCURRENTLY IF EXISTS mentions_room'));
  assert.equal(await indexState(query(db), 'mentions_room'), 'valid');
  // Over the prebuilt indexes the migration's SQL changes nothing.
  await db.exec(ROOM_PURGE_INDEXES_SQL);
});

test('CCA-517: the prebuild skips a table this database does not have', async (t) => {
  const db = await PGlite.create('memory://');
  t.after(async () => (db.closed ? undefined : db.close()));
  const steps = await prebuildIndexes(query(db), ROOM_PURGE_INDEXES, { confirm: true });
  assert.deepEqual(
    steps.map((step) => step.action),
    ROOM_PURGE_INDEXES.map(() => 'skipped'),
  );
  // And the migration's SQL is a no-op there too.
  await db.exec(ROOM_PURGE_INDEXES_SQL);
});
