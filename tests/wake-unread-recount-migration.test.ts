import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { wakeMigration, wakeUnreadRecountMigration } from '../server/wake/schema.js';

/**
 * Migration 142 recounts `wake_cursors.unread_count` from the mentions and moves the mention
 * cursor to just below the lowest unread mention. Synthetic rows only.
 */
test('migration 142 recounts drifted unread counts and leaves correct ones alone', async (t) => {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec('CREATE TABLE operators (id text PRIMARY KEY);');
  await pg.exec(wakeMigration.sql);
  await pg.exec('ALTER TABLE wake_cursors ADD COLUMN unread_count integer NOT NULL DEFAULT 0;');
  const mention = (agent: string, seq: number, read: boolean) =>
    pg.query(
      `INSERT INTO mentions(agent_id,seq,owner_id,source_kind,source_id,room_id,source_seq,
         from_agent_id,from_name,excerpt,created_at,read_at)
       VALUES($1,$2,'ws','room',$3,'room-1',$2,'from-1','Synthetic','hi',1,$4)`,
      [agent, seq, `${agent}-${seq}`, read ? 2 : null],
    );
  // A person who read everything but whose count kept growing.
  await pg.query(
    "INSERT INTO wake_cursors(agent_id,next_mention_seq,acked_mention_seq,updated_at,unread_count) VALUES('person-1',4,0,1,3)",
  );
  for (const seq of [1, 2, 3]) await mention('person-1', seq, true);
  // Two read, one unread: the count drifted to 3; the cursor stops below seq 3.
  await pg.query(
    "INSERT INTO wake_cursors(agent_id,next_mention_seq,acked_mention_seq,updated_at,unread_count) VALUES('person-2',4,0,1,3)",
  );
  await mention('person-2', 1, true);
  await mention('person-2', 2, true);
  await mention('person-2', 3, false);
  // Already in step.
  await pg.query(
    "INSERT INTO wake_cursors(agent_id,next_mention_seq,acked_mention_seq,updated_at,unread_count) VALUES('agent-1',3,0,1,2)",
  );
  await mention('agent-1', 1, false);
  await mention('agent-1', 2, false);

  assert.deepEqual(await wakeUnreadRecountMigration.report!.measure(pg), { drifted: 2 });
  await pg.exec(wakeUnreadRecountMigration.sql);
  const rows = (
    await pg.query<{ agent_id: string; unread_count: number; acked_mention_seq: string | number }>(
      'SELECT agent_id, unread_count, acked_mention_seq FROM wake_cursors ORDER BY agent_id',
    )
  ).rows.map((row) => [row.agent_id, row.unread_count, Number(row.acked_mention_seq)]);
  assert.deepEqual(rows, [
    ['agent-1', 2, 0],
    ['person-1', 0, 3],
    ['person-2', 1, 2],
  ]);
  assert.deepEqual(await wakeUnreadRecountMigration.report!.measure(pg), { drifted: 0 });
});
