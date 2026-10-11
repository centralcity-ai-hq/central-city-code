import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { listMigrations, runMigrations } from '../server/migrations.js';
import {
  registerRoomTasksMigration,
  roomTaskSubmittedByMigration,
} from '../server/rooms/tasks-schema.js';

registerRoomTasksMigration();

/**
 * Migration 67 `room_task_submitted_by` (docs/ROOM_TASKS.md): adds the nullable column and
 * backfills it from each task's latest `result_posted` event. The test rolls the migration back
 * on a migrated database, writes synthetic rows, and lets the real runner apply it again.
 */
type Db = Awaited<ReturnType<typeof createApp>>['city']['db'];

async function seed(db: Db) {
  const owner = `op-${randomUUID()}`;
  const roomId = randomUUID();
  await db.query(
    'INSERT INTO operators(id,name,name_key,password_hash,salt) VALUES($1,$2,$3,$4,$5)',
    [owner, 'Synthetic host', owner, 'x', 'x'],
  );
  await db.query(
    `INSERT INTO rooms(id,slug,name,host_owner_id,host_agent_id,member_cap,history,link_ttl_ms,
      created_at,idempotency_key,request_hash)
     VALUES($1,$2,'Synthetic room',$3,'agent-host',8,'full',60000,1,$4,'h')`,
    [roomId, `room-${roomId.slice(0, 8)}`, owner, randomUUID()],
  );
  let number = 0;
  const task = async () => {
    const id = randomUUID();
    number += 1;
    await db.query(
      `INSERT INTO room_tasks(id,room_id,number,title,status,created_by_agent_id,
        created_by_owner_id,created_at,updated_at,idempotency_key,request_hash)
       VALUES($1,$2,$3,'Synthetic task','done','agent-host',$4,1,1,$5,'h')`,
      [id, roomId, number, owner, randomUUID()],
    );
    return id;
  };
  const event = (taskId: string, action: string, agentId: string | null, at: number) =>
    db.query(
      `INSERT INTO room_task_events(id,task_id,action,generation,actor,agent_id,created_at)
       VALUES($1,$2,$3,1,'the owner',$4,$5)`,
      [randomUUID(), taskId, action, agentId, at],
    );
  const twice = await task();
  await event(twice, 'claimed', 'agent-first', 10);
  await event(twice, 'result_posted', 'agent-first', 20);
  await event(twice, 'rejected', null, 30);
  await event(twice, 'claimed', 'agent-second', 40);
  await event(twice, 'result_posted', 'agent-second', 50);
  const never = await task();
  await event(never, 'claimed', 'agent-first', 10);
  const anonymous = await task();
  await event(anonymous, 'result_posted', null, 10);
  return { twice, never, anonymous };
}

async function submitted(db: Db, id: string) {
  return (
    await db.query<{ submitted_by: string | null }>(
      'SELECT submitted_by FROM room_tasks WHERE id=$1',
      [id],
    )
  ).rows[0]?.submitted_by;
}

test('migration 67 is registered after the earlier task migrations', () => {
  const versions = listMigrations().map((item) => item.version);
  assert.ok(versions.includes(67));
  assert.equal(roomTaskSubmittedByMigration.name, 'room_task_submitted_by');
  assert.ok(versions.indexOf(57) < versions.indexOf(67));
});

test('migration 67 adds a nullable column and backfills it from the latest hand-in', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const db = app.city.db;
  // Roll 67 back so the runner applies it to rows that predate it.
  await db.exec(
    'ALTER TABLE room_tasks DROP COLUMN submitted_by; DELETE FROM schema_migrations WHERE version=67;',
  );
  const ids = await seed(db);
  const result = await runMigrations(db);
  assert.deepEqual(result.applied, [67]);
  const column = (
    await db.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_name='room_tasks' AND column_name='submitted_by'`,
    )
  ).rows[0];
  assert.deepEqual(column, { is_nullable: 'YES', data_type: 'text' });
  assert.equal(await submitted(db, ids.twice), 'agent-second', 'the latest hand-in wins');
  assert.equal(await submitted(db, ids.never), null, 'no hand-in, no submitter');
  assert.equal(await submitted(db, ids.anonymous), null, 'an event without an agent fills nothing');

  // Re-running the SQL never overwrites a value that is already set.
  await db.query('UPDATE room_tasks SET submitted_by=$2 WHERE id=$1', [ids.twice, 'agent-kept']);
  await db.exec(roomTaskSubmittedByMigration.sql);
  assert.equal(await submitted(db, ids.twice), 'agent-kept');
  assert.deepEqual((await runMigrations(db)).applied, []);
});
