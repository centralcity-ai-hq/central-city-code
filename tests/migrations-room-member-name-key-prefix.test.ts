import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { listMigrations, runMigrations } from '../server/migrations.js';
import {
  registerRoomsMigration,
  roomMemberNameKeyPrefixMigration,
} from '../server/rooms/schema.js';

registerRoomsMigration();

/**
 * Migration 69 `room_member_name_key_prefix`: the members search's "starts with" match
 * (`name_key LIKE 'ann%'`, server/rooms/service.ts memberSearch) gets (room_id, key
 * text_pattern_ops) indexes, which serve a LIKE prefix whatever the database collation. The test
 * rolls the migration back on a migrated database and lets the real runner apply it again.
 */
const INDEXES = ['room_members_name_key_prefix', 'room_members_slug_key_prefix'];

async function indexDefs(db: Awaited<ReturnType<typeof createApp>>['city']['db']) {
  const rows = (
    await db.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename='room_members' AND indexname = ANY($1::text[]) ORDER BY indexname`,
      [INDEXES],
    )
  ).rows;
  return Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));
}

test('migration 69 is registered after the mention keys it indexes (62)', () => {
  const versions = listMigrations().map((item) => item.version);
  assert.ok(versions.includes(69));
  assert.equal(roomMemberNameKeyPrefixMigration.name, 'room_member_name_key_prefix');
  assert.ok(versions.indexOf(62) < versions.indexOf(69));
  assert.equal(versions.filter((version) => version === 69).length, 1);
});

test('migration 69 adds text_pattern_ops prefix indexes, idempotently', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const db = app.city.db;
  // Roll 69 back so the runner applies it again.
  await db.exec(
    `DROP INDEX ${INDEXES.join(', ')}; DELETE FROM schema_migrations WHERE version=69;`,
  );
  assert.deepEqual(await indexDefs(db), {});
  assert.deepEqual((await runMigrations(db)).applied, [69]);
  const defs = await indexDefs(db);
  assert.match(defs.room_members_name_key_prefix!, /\(room_id, name_key text_pattern_ops\)/);
  assert.match(defs.room_members_slug_key_prefix!, /\(room_id, slug_key text_pattern_ops\)/);
  // CREATE INDEX IF NOT EXISTS: running the SQL again changes nothing.
  await db.exec(roomMemberNameKeyPrefixMigration.sql);
  assert.deepEqual(await indexDefs(db), defs);
  assert.deepEqual((await runMigrations(db)).applied, []);
});

test('a LIKE prefix on name_key is an index range on the pattern-ops index', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const db = app.city.db;
  const plan = await db
    .transaction(async (tx) => {
      // Only the new index may serve the range: every other secondary index on room_members (the
      // collation-bound migration 62 ones too) is dropped in this rolled-back transaction, and a
      // sequential scan is not an option. The primary key goes too (CASCADE: also rolled back).
      const others = (
        await tx.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes WHERE tablename='room_members'
            AND indexname NOT IN ('room_members_pkey', 'room_members_name_key_prefix')`,
        )
      ).rows.map((row) => row.indexname);
      await tx.exec(
        `ALTER TABLE room_members DROP CONSTRAINT room_members_pkey CASCADE;
         DROP INDEX ${others.join(', ')}; SET LOCAL enable_seqscan = off;`,
      );
      const rows = (
        await tx.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT agent_id FROM room_members
            WHERE room_id = 'synthetic-room' AND name_key LIKE 'ann%'`,
        )
      ).rows;
      throw Object.assign(new Error('rollback'), {
        plan: rows.map((row) => row['QUERY PLAN']).join('\n'),
      });
    })
    .catch((error: Error & { plan?: string }) => {
      if (error.plan === undefined) throw error;
      return error.plan;
    });
  assert.match(plan, /room_members_name_key_prefix/);
  // The pattern-ops range operators: a byte-wise range, whatever the collation.
  assert.match(plan, /name_key ~>=~ 'ann'::text/);
  assert.match(plan, /name_key ~<~ 'ano'::text/);
  // The rollback kept the migration 62 index.
  const kept = await db.query(
    "SELECT 1 FROM pg_indexes WHERE tablename='room_members' AND indexname='room_members_name_key'",
  );
  assert.equal(kept.rows.length, 1);
});
