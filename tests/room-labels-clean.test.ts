import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { createApp } from '../server/app.js';
import type { Database } from '../server/database.js';
import { cleanRoomLabels, UNTITLED_ROOM } from '../server/rooms/clean-labels.js';
import { cleanName } from '../server/rooms/person.js';

/*
 * CCA-628, stored rooms: rooms created before create() cleaned names and topics keep bidi,
 * zero-width and tag characters until this one-off data migration cleans them, with the same
 * cleaner, in batches, with one audit row per changed room, and idempotently.
 */
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-cf-migrations-test-stand-in';
const ORIGIN = 'https://centralcity.ai';

async function appDatabase(t: { after: (fn: () => Promise<unknown>) => void }) {
  const db = await PGlite.create('memory://', { extensions: { btree_gin, pg_trgm } });
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
  return db as unknown as Database;
}

const RLO = '‮';
const ZWSP = '​';
const TAG = (text: string) =>
  [...text].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');

/** Rooms as an older build stored them: name and topic exactly as sent. */
const ROOMS: Array<[id: string, name: string, topic: string]> = [
  ['room-a', `Pay${RLO}gnp.exe`, 'plain topic'],
  ['room-b', 'Clean name', `Topic with ${ZWSP}zero width and ${TAG('hidden')}tags`],
  ['room-c', 'Already clean', 'Nothing to do'],
  ['room-d', `${ZWSP}${RLO} `, ''],
  ['room-e', `Two lines  and   spaces`, `Line break`],
];

async function seed(db: Database) {
  await db.query(
    "INSERT INTO operators(id,name,name_key,password_hash,salt) VALUES('host-1','Host','host','x','x')",
  );
  for (const [id, name, topic] of ROOMS)
    await db.query(
      `INSERT INTO rooms(id, slug, name, topic, host_owner_id, host_agent_id, member_cap, history,
         link_ttl_ms, created_at, idempotency_key, request_hash)
       VALUES ($1, $1, $2, $3, 'host-1', 'agent-1', 10, 'full', 60000, 1, $1, 'h')`,
      [id, name, topic],
    );
}
const rooms = async (db: Database) =>
  (
    await db.query<{ id: string; name: string; topic: string }>(
      'SELECT id, name, topic FROM rooms ORDER BY id',
    )
  ).rows;
const audits = async (db: Database) =>
  (
    await db.query<{ room_id: string; action: string; actor: string; detail: unknown }>(
      "SELECT room_id, action, actor, detail FROM room_events WHERE action = 'room.labels_cleaned' ORDER BY room_id",
    )
  ).rows;

test('CCA-628: stored room names and topics are cleaned in batches, one audit row per changed room, idempotently', async (t) => {
  const db = await appDatabase(t);
  await seed(db);
  const before = await rooms(db);

  // Dry run: counts, changes nothing, writes nothing.
  const dry = await cleanRoomLabels(db, { confirm: false, batchSize: 2 });
  assert.deepEqual(dry, {
    scanned: 5,
    changed: 4,
    names: 3,
    topics: 2,
    emptied: 1,
    credential: 0,
    batches: 3,
  });
  assert.deepEqual(await rooms(db), before);
  assert.deepEqual(await audits(db), []);

  const progress: number[] = [];
  const run = await cleanRoomLabels(db, {
    confirm: true,
    batchSize: 2,
    now: () => 1_000,
    onBatch: (counts) => progress.push(counts.scanned),
  });
  assert.deepEqual(run, dry);
  assert.deepEqual(progress, [2, 4, 5], 'three batches of at most two rooms');
  const after = new Map((await rooms(db)).map((row) => [row.id, row]));
  assert.equal(after.get('room-a')!.name, 'Paygnp.exe');
  // Nothing invisible is left (the exact spacing is the cleaner's, checked below).
  for (const row of after.values())
    assert.doesNotMatch(`${row.name}${row.topic}`, /[\p{Cc}\p{Cf}\u2028\u2029]/u, row.id);
  assert.deepEqual(after.get('room-c'), {
    id: 'room-c',
    name: 'Already clean',
    topic: 'Nothing to do',
  });
  assert.equal(after.get('room-d')!.name, UNTITLED_ROOM);
  // Exactly the cleaner create() and renameIn use.
  for (const [id, name, topic] of ROOMS) {
    assert.equal(after.get(id)!.name, cleanName(name, 80) || UNTITLED_ROOM, id);
    assert.equal(after.get(id)!.topic, cleanName(topic, 280), id);
  }
  // One audit row per changed room: which field changed, never the text.
  assert.deepEqual(await audits(db), [
    {
      room_id: 'room-a',
      action: 'room.labels_cleaned',
      actor: 'Central City',
      detail: { name: true, topic: false },
    },
    {
      room_id: 'room-b',
      action: 'room.labels_cleaned',
      actor: 'Central City',
      detail: { name: false, topic: true },
    },
    {
      room_id: 'room-d',
      action: 'room.labels_cleaned',
      actor: 'Central City',
      detail: { name: true, topic: false },
    },
    {
      room_id: 'room-e',
      action: 'room.labels_cleaned',
      actor: 'Central City',
      detail: { name: true, topic: true },
    },
  ]);
  // No system line in any room.
  const lines = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM room_messages');
  assert.equal(lines.rows[0]!.n, 0);

  // Idempotent: a second run finds nothing and writes nothing.
  const again = await cleanRoomLabels(db, { confirm: true, batchSize: 2 });
  assert.equal(again.changed, 0);
  assert.equal(again.scanned, 5);
  assert.equal((await audits(db)).length, 4);
});

test('CCA-628: a room name or topic holding a credential is counted, not rewritten', async (t) => {
  const db = await appDatabase(t);
  await seed(db);
  const pasted = `cca_${'A1b2C3d4'.repeat(3)}`;
  await db.query('UPDATE rooms SET topic = $2 WHERE id = $1', ['room-a', `${RLO} ${pasted}`]);
  const run = await cleanRoomLabels(db, { confirm: true });
  assert.equal(run.credential, 1);
  const kept = (await rooms(db)).find((row) => row.id === 'room-a')!;
  assert.equal(kept.topic, `${RLO} ${pasted}`, 'left for the owner');
  assert.ok(!(await audits(db)).some((row) => row.room_id === 'room-a'));
});
