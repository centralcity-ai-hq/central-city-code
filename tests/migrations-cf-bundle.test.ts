import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { createApp } from '../server/app.js';
import { listMigrations, runMigrations, type Migration } from '../server/migrations.js';
import { PAUSE_REASONS } from '../src/responder/contract.js';

/*
 * The carry-forward migration bundle (its own gate). Every migration here is additive: new
 * nullable columns or columns with a constant default, new tables, indexes, functions and
 * triggers, and one CHECK replaced by a strictly wider one. An older build's statements therefore
 * keep working on the new schema. Each migration also applies alone, in any order, on the schema
 * before the bundle, so it is compatible with one transaction per migration (CCA-518).
 */
const BUNDLE = [300, 301, 302, 303, 304, 305];

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-cf-migrations-test-stand-in';
const ORIGIN = 'https://centralcity.ai';
const extensions = { btree_gin, pg_trgm };

let registered: Promise<{ before: Migration[]; bundle: Migration[]; dump: Blob }> | undefined;
/** Registers every migration (one hosted app), then dumps a database on the schema before the bundle. */
function schemas() {
  registered ??= (async () => {
    const builder = await PGlite.create('memory://', { extensions });
    const app = await createApp({
      database: builder,
      hosted: {
        databaseUrl: 'postgres://unused.invalid/test',
        publicOrigin: ORIGIN,
        allowedOrigins: [ORIGIN],
      },
      startWorkers: false,
    });
    await app.close();
    if (!builder.closed) await builder.close();
    const all = listMigrations();
    const bundle = all.filter((migration) => BUNDLE.includes(migration.version));
    const before = all.filter((migration) => !BUNDLE.includes(migration.version));
    assert.deepEqual(
      bundle.map((migration) => migration.version),
      BUNDLE,
      'every bundle migration is registered by createApp',
    );
    const db = await PGlite.create('memory://', { extensions });
    await runMigrations(db, before);
    const dump = await db.dumpDataDir('none');
    await db.close();
    return { before, bundle, dump };
  })();
  return registered;
}

/** A database on the schema before the bundle (live main's), closed after the test. */
async function preBundle(t: { after: (fn: () => Promise<unknown>) => void }) {
  const { dump } = await schemas();
  const db = await PGlite.create('memory://', { extensions, loadDataDir: dump });
  t.after(async () => (db.closed ? undefined : db.close()));
  return db;
}

async function catalog(db: PGlite) {
  const rows = async <T>(sql: string) => (await db.query<T>(sql)).rows;
  return {
    columns: await rows<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      "SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name<>'schema_migrations' ORDER BY 1,2",
    ),
    indexes: await rows<{ indexname: string; indexdef: string }>(
      "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1",
    ),
    constraints: await rows<{ rel: string; conname: string; def: string }>(
      "SELECT conrelid::regclass::text AS rel,conname,pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype<>'n' ORDER BY 1,2",
    ),
    triggers: await rows<{ tgname: string; rel: string }>(
      'SELECT tgname, tgrelid::regclass::text AS rel FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2',
    ),
  };
}

/** CHECK constraints the bundle replaces with a strictly wider one: [table, name, values added]. */
const WIDENED: Array<[string, string, string[]]> = [
  ['responder_settings', 'responder_settings_pause_reason_check', ['root_key_unavailable']],
];

test('the bundle is additive: every column, index, constraint and trigger of the old schema stays as it was', async (t) => {
  const db = await preBundle(t);
  const before = await catalog(db);
  const { before: old, bundle } = await schemas();
  assert.deepEqual(
    (await runMigrations(db, [...old, ...bundle])).applied,
    bundle.map((migration) => migration.version),
  );
  const after = await catalog(db);
  const key = (row: object) => JSON.stringify(row);
  // Columns: none dropped, renamed or retyped; new ones are nullable or have a default.
  const afterColumns = new Set(after.columns.map(key));
  for (const column of before.columns) assert.ok(afterColumns.has(key(column)), key(column));
  const beforeColumns = new Set(before.columns.map(key));
  const oldTables = new Set(before.columns.map((row) => row.table_name));
  // New columns on existing tables (new tables are only written by this build).
  for (const column of after.columns.filter(
    (row) => oldTables.has(row.table_name) && !beforeColumns.has(key(row)),
  ))
    assert.ok(
      column.is_nullable === 'YES' || column.column_default !== null,
      `${column.table_name}.${column.column_name}: an older build's inserts do not name it`,
    );
  const afterIndexes = new Set(after.indexes.map(key));
  for (const index of before.indexes) assert.ok(afterIndexes.has(key(index)), index.indexname);
  const afterTriggers = new Set(after.triggers.map(key));
  for (const trigger of before.triggers) assert.ok(afterTriggers.has(key(trigger)), trigger.tgname);
  const afterConstraints = new Map(
    after.constraints.map((row) => [`${row.rel}.${row.conname}`, row]),
  );
  for (const constraint of before.constraints) {
    const name = `${constraint.rel}.${constraint.conname}`;
    const now = afterConstraints.get(name);
    assert.ok(now, `${name} stays`);
    const widened = WIDENED.find(
      ([rel, conname]) => rel === constraint.rel && conname === constraint.conname,
    );
    if (!widened) {
      assert.equal(now.def, constraint.def, name);
      continue;
    }
    const values = (def: string) =>
      [...def.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]);
    assert.deepEqual(
      values(now.def).sort(),
      [...values(constraint.def), ...widened[2]].sort(),
      `${name} is the old list plus ${widened[2].join(', ')}`,
    );
  }
  // Applied again (a restart): nothing pending, nothing changes.
  assert.deepEqual((await runMigrations(db, [...old, ...bundle])).applied, []);
  assert.deepEqual(await catalog(db), after);
});

test('each bundle migration applies alone on the old schema (one transaction per migration, any order)', async (t) => {
  const { before: old, bundle } = await schemas();
  for (const migration of bundle) {
    const db = await preBundle(t);
    assert.deepEqual((await runMigrations(db, [...old, migration])).applied, [migration.version]);
    // Its SQL is safe to run twice (IF NOT EXISTS / replace by definition).
    await db.exec(migration.sql);
    await db.close();
  }
});

async function owner(db: PGlite, id = 'op-1') {
  await db.query(
    "INSERT INTO operators(id,name,name_key,password_hash,salt) VALUES($1,$1,$1,'x','x') ON CONFLICT DO NOTHING",
    [id],
  );
  return id;
}
const settingsRow = (db: PGlite, agent: string, reason: string | null) =>
  db.query(
    `INSERT INTO responder_settings(agent_id,owner_id,provider,model,status,pause_reason,created_at,updated_at,updated_by)
     VALUES($1,'op-1','openai','gpt',$2,$3,1,1,'test')`,
    [agent, reason === null ? 'active' : 'paused', reason],
  );

test('CCA-641 (c), migration 303: root_key_unavailable is a stored pause reason; every older reason and row stays valid', async (t) => {
  const db = await preBundle(t);
  await owner(db);
  const older = PAUSE_REASONS.filter((reason) => reason !== 'root_key_unavailable');
  // Rows an older build wrote, one per reason it knows.
  for (const [i, reason] of [...older, null].entries()) await settingsRow(db, `old-${i}`, reason);
  await assert.rejects(settingsRow(db, 'new-0', 'root_key_unavailable'), /pause_reason_check/);
  const { before: old, bundle } = await schemas();
  await runMigrations(db, [...old, ...bundle.filter((migration) => migration.version === 303)]);
  const kept = await db.query<{ agent_id: string; pause_reason: string | null }>(
    'SELECT agent_id, pause_reason FROM responder_settings ORDER BY agent_id',
  );
  assert.equal(kept.rows.length, older.length + 1, 'no row changed or dropped');
  await settingsRow(db, 'new-0', 'root_key_unavailable');
  // An older build's writes (every reason it knows) are still accepted.
  for (const [i, reason] of older.entries()) await settingsRow(db, `old-again-${i}`, reason);
  await assert.rejects(settingsRow(db, 'new-1', 'something_else'), /pause_reason_check/);
  // Exactly one pause_reason CHECK, listing exactly the client's reasons.
  const checks = await db.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid='responder_settings'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%pause_reason%'`,
  );
  assert.equal(checks.rows.length, 1);
  assert.deepEqual(
    [...checks.rows[0]!.def.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]).sort(),
    [...PAUSE_REASONS].sort(),
  );
});

test('migration 303 replaces the pause_reason CHECK by its definition, whatever its name', async (t) => {
  const db = await preBundle(t);
  await db.exec(
    'ALTER TABLE responder_settings RENAME CONSTRAINT responder_settings_pause_reason_check TO some_other_name',
  );
  const { before: old, bundle } = await schemas();
  await runMigrations(db, [...old, ...bundle.filter((migration) => migration.version === 303)]);
  const names = await db.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conrelid='responder_settings'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%pause_reason%'`,
  );
  assert.deepEqual(
    names.rows.map((row) => row.conname),
    ['responder_settings_pause_reason_check'],
  );
});

const oldInsert = (db: PGlite, seq: number, created: number) =>
  // Exactly the column list an older build's send names (server/messaging/service.ts).
  db.query(
    `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,context_id,reply_to,kind,parts,created_at,origin,sender_owner_label,room_id)
     VALUES('agent-b',$1,gen_random_uuid(),'agent-a','op-1','op-1','ctx-1',NULL,'message','[]'::jsonb,$2,'internal',NULL,NULL)`,
    [seq, created],
  );

test('R8-2, migration 302: on a database with messages it waits for the backfill; an older build’s sends keep the rows right', async (t) => {
  const db = await preBundle(t);
  await owner(db);
  await oldInsert(db, 1, 1_000);
  const { before: old, bundle } = await schemas();
  await runMigrations(db, [...old, ...bundle.filter((migration) => migration.version === 302)]);
  const meta = await db.query<{ backfilled: boolean }>(
    'SELECT backfilled_at IS NOT NULL AS backfilled FROM conversation_summaries_meta',
  );
  assert.deepEqual(meta.rows, [{ backfilled: false }]);
  // Older build's send after the migration: the trigger counts it, not complete (an older one exists).
  await oldInsert(db, 2, 2_000);
  const rows = await db.query<{ message_count: string; complete: boolean; last_at: string }>(
    'SELECT message_count::text, complete, last_at::text FROM conversation_summaries',
  );
  assert.deepEqual(rows.rows, [{ message_count: '1', complete: false, last_at: '2000' }]);
});

test('R8-2, migration 302: on an empty messages table it is backfilled at once', async (t) => {
  const db = await preBundle(t);
  const { before: old, bundle } = await schemas();
  await runMigrations(db, [...old, ...bundle.filter((migration) => migration.version === 302)]);
  const meta = await db.query<{ backfilled: boolean }>(
    'SELECT backfilled_at IS NOT NULL AS backfilled FROM conversation_summaries_meta',
  );
  assert.deepEqual(meta.rows, [{ backfilled: true }]);
});

/** Rows past a guarded migration's GUARD_ROWS (10,000), inserted without foreign keys. */
async function largeTable(db: PGlite, sql: string) {
  await db.exec("SET session_replication_role = 'replica'");
  await db.query(sql);
  await db.exec("SET session_replication_role = 'origin'");
}
const indexNames = async (db: PGlite, names: string[]) =>
  (
    await db.query<{ indexname: string }>(
      'SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[]) ORDER BY 1',
      [names],
    )
  ).rows.map((row) => row.indexname);

test('MPR1-01, migration 304: guarded on a large table (left for the owner script, never fails); built on a small one', async (t) => {
  const { before: old, bundle } = await schemas();
  const only304 = [...old, ...bundle.filter((migration) => migration.version === 304)];
  const names = ['base_audit_events_payment', 'base_wallet_reservations_wallet_token_created'];
  const small = await preBundle(t);
  assert.deepEqual((await runMigrations(small, only304)).applied, [304]);
  assert.deepEqual(await indexNames(small, names), names);
  const large = await preBundle(t);
  await largeTable(
    large,
    `INSERT INTO base_wallet_reservations (reservation_id, wallet_id, chain_id, token, amount,
       holder_kind, holder_ref, intent_hash, state, op_id, created_at, updated_at)
     SELECT 'r-' || g, 'w-' || (g % 50), 8453, '0x${'a'.repeat(40)}', 1, 'payment', 'h-' || g,
       '0xi', 'consumed', NULL, g, g FROM generate_series(1, 10001) g`,
  );
  assert.deepEqual((await runMigrations(large, only304)).applied, [304]);
  assert.deepEqual(await indexNames(large, names), ['base_audit_events_payment']);
});

test('R1-6, migration 305: guarded on a large messages table (left for the owner script, never fails); built on a small one', async (t) => {
  const { before: old, bundle } = await schemas();
  const only305 = [...old, ...bundle.filter((migration) => migration.version === 305)];
  const small = await preBundle(t);
  assert.deepEqual((await runMigrations(small, only305)).applied, [305]);
  assert.deepEqual(await indexNames(small, ['messages_sender_owner_context']), [
    'messages_sender_owner_context',
  ]);
  const large = await preBundle(t);
  await owner(large);
  await largeTable(
    large,
    `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,
       context_id,reply_to,kind,parts,created_at,origin,sender_owner_label,room_id)
     SELECT 'agent-b', g, gen_random_uuid(), 'agent-a', 'op-1', 'op-1', 'ctx-' || (g % 40), NULL,
       'message', '[]'::jsonb, g, 'internal', NULL, NULL FROM generate_series(1, 10001) g`,
  );
  assert.deepEqual((await runMigrations(large, only305)).applied, [305]);
  assert.deepEqual(await indexNames(large, ['messages_sender_owner_context']), []);
});

test('migrations 304 and 305 apply in either order, each on top of the other', async (t) => {
  const { before: old, bundle } = await schemas();
  const pick = (version: number) => bundle.find((migration) => migration.version === version)!;
  for (const [first, second] of [
    [304, 305],
    [305, 304],
  ] as const) {
    const db = await preBundle(t);
    assert.deepEqual((await runMigrations(db, [...old, pick(first)])).applied, [first]);
    assert.deepEqual((await runMigrations(db, [...old, pick(first), pick(second)])).applied, [
      second,
    ]);
    assert.deepEqual(
      await indexNames(db, [
        'base_audit_events_payment',
        'base_wallet_reservations_wallet_token_created',
        'messages_sender_owner_context',
      ]),
      [
        'base_audit_events_payment',
        'base_wallet_reservations_wallet_token_created',
        'messages_sender_owner_context',
      ],
    );
  }
});
