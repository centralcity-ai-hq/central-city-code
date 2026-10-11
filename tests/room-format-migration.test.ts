import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { listMigrations, runMigrations } from '../server/migrations.js';
import { registerMessagingMigration } from '../server/messaging/schema.js';
import { registerAiWorkspacesMigration } from '../server/workspaces/schema.js';
import { registerCrossConnectionsMigration } from '../server/connections/schema.js';
import { registerRoomsMigration } from '../server/rooms/schema.js';
import { registerJoinLinksMigration } from '../server/links/schema.js';
import { registerWakeMigration } from '../server/wake/schema.js';
import { registerResultsMigration } from '../server/results/schema.js';
import { registerRoomFormatMigration, roomFormatMigration } from '../server/rooms/format-schema.js';
import { roomMessageSearchMigration } from '../server/rooms/search-schema.js';

/**
 * Migration 22 `room_messages_format` (server/rooms/format-schema.ts): existing room messages
 * become 'plain' without a table rewrite, and only 'plain' or 'markdown' can be stored afterwards.
 * Synthetic data only.
 */
registerMessagingMigration();
registerAiWorkspacesMigration();
registerCrossConnectionsMigration();
registerRoomsMigration();
registerJoinLinksMigration();
registerWakeMigration();
registerResultsMigration();
registerRoomFormatMigration();

const ROOM = 'room-format-fixture';

async function beforeFormat(t: { after: (fn: () => Promise<unknown>) => void }) {
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  await runMigrations(
    db,
    listMigrations().filter((migration) => migration.version < roomFormatMigration.version),
  );
  await db.query(
    `INSERT INTO operators(id,name,name_key,password_hash,salt) VALUES('owner-1','Owner','owner','x','x')`,
  );
  await db.query(
    `INSERT INTO rooms(id,slug,name,host_owner_id,host_agent_id,member_cap,history,link_ttl_ms,created_at,idempotency_key,request_hash)
     VALUES($1,'format-room','Format room','owner-1','agent-1',8,'full',60000,1,'key-1','hash-1')`,
    [ROOM],
  );
  for (let seq = 1; seq <= 3; seq++) await post(db, seq);
  return db;
}

function post(db: PGlite, seq: number, format?: string) {
  const columns = format === undefined ? '' : ',format';
  const values = format === undefined ? '' : ',$4';
  return db.query(
    `INSERT INTO room_messages(room_id,seq,id,sender_agent_id,sender_owner_id,sender_name,sender_owner_label,parts,created_at${columns})
     VALUES($1,$2,$3,'agent-1','owner-1','Agent','Owner','[{"type":"text","text":"hi"}]',1${values})`,
    format === undefined
      ? [ROOM, seq, `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`]
      : [ROOM, seq, `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, format],
  );
}

async function formats(db: PGlite) {
  return (
    await db.query<{ seq: number; format: string }>(
      'SELECT seq::int AS seq,format FROM room_messages ORDER BY seq',
    )
  ).rows.map((row) => [row.seq, row.format]);
}

async function storage(db: PGlite) {
  return (
    await db.query<{ node: number }>("SELECT pg_relation_filenode('room_messages')::int AS node")
  ).rows[0]!.node;
}

test('migration 22 applies on PGlite, old rows become plain, and no rewrite happens', async (t) => {
  const db = await beforeFormat(t);
  const node = await storage(db);
  // Later migrations (31: people in rooms) may apply in the same run. Migration 55 (search) adds
  // a stored generated column, which rewrites room_messages by design, so it is left out here.
  const result = await runMigrations(
    db,
    listMigrations().filter((migration) => migration.version < roomMessageSearchMigration.version),
  );
  assert.deepEqual(
    result.applied.filter((version) => version <= 22),
    [22],
  );
  assert.deepEqual(await formats(db), [
    [1, 'plain'],
    [2, 'plain'],
    [3, 'plain'],
  ]);
  // Metadata-only: same storage file, the constant is the attribute's missing value.
  assert.equal(await storage(db), node, 'room_messages was not rewritten');
  const column = (
    await db.query<{ notnull: boolean; missing: boolean; def: string }>(
      `SELECT a.attnotnull AS notnull, a.atthasmissing AS missing, pg_get_expr(d.adbin,d.adrelid) AS def
         FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid='room_messages'::regclass AND a.attname='format'`,
    )
  ).rows[0]!;
  assert.deepEqual(column, { notnull: true, missing: true, def: "'plain'::text" });
  // The CHECK is NOT VALID: enforced for new writes, no scan of existing rows.
  const check = (
    await db.query<{ def: string; validated: boolean }>(
      `SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated FROM pg_constraint
        WHERE conrelid='room_messages'::regclass AND conname='room_messages_format_check'`,
    )
  ).rows[0]!;
  assert.equal(check.validated, false);
  assert.match(check.def, /format = ANY \(ARRAY\['plain'::text, 'markdown'::text\]\).*NOT VALID/);
});

test('after migration 22 only plain or markdown can be stored; the default stays plain', async (t) => {
  const db = await beforeFormat(t);
  await runMigrations(db, listMigrations());
  await post(db, 4);
  await post(db, 5, 'markdown');
  await post(db, 6, 'plain');
  for (const bad of ['html', 'Markdown', ''])
    await assert.rejects(post(db, 7, bad), /room_messages_format_check/);
  await assert.rejects(post(db, 7, null as unknown as string), /null value/);
  await assert.rejects(
    db.query(`UPDATE room_messages SET format='rich' WHERE room_id=$1 AND seq=1`, [ROOM]),
    /room_messages_format_check/,
  );
  await db.query(`UPDATE room_messages SET format='markdown' WHERE room_id=$1 AND seq=1`, [ROOM]);
  assert.deepEqual(await formats(db), [
    [1, 'markdown'],
    [2, 'plain'],
    [3, 'plain'],
    [4, 'plain'],
    [5, 'markdown'],
    [6, 'plain'],
  ]);
});

test('the migration SQL is idempotent and can be validated later without errors', async (t) => {
  const db = await beforeFormat(t);
  await runMigrations(db, listMigrations());
  await db.exec(roomFormatMigration.sql);
  const checks = (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conrelid='room_messages'::regclass AND contype='c' AND conname LIKE 'room_messages_format%'`,
    )
  ).rows[0]!.n;
  assert.equal(checks, 1);
  // Every existing row satisfies the check by construction, so an online VALIDATE succeeds.
  await db.exec('ALTER TABLE room_messages VALIDATE CONSTRAINT room_messages_format_check');
});
