import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { responderActionsMigration } from '../server/responder/action-schema.js';

test('action journal binds one immutable proposal and terminal outcome to a durable reply', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE responder_replies (
      agent_id text, mention_seq bigint, PRIMARY KEY(agent_id, mention_seq));
      INSERT INTO responder_replies VALUES ('test-agent',1);`);
    await db.exec(responderActionsMigration.sql!);
    const insert = `INSERT INTO responder_actions(agent_id,mention_seq,action,created_at)
      VALUES ('test-agent',1,'{"name":"room_pin","arguments":{"seq":1}}',10)`;
    await db.exec(insert);
    await assert.rejects(db.exec(insert), /duplicate key/);
    await assert.rejects(db.exec(`UPDATE responder_actions SET action='{}'`), /immutable/);
    await assert.rejects(
      db.exec(`UPDATE responder_actions SET state='executed'`),
      /check constraint/,
    );
    await db.exec('BEGIN');
    await db.exec(
      `UPDATE responder_actions SET state='executed',outcome='{"seq":1}',finished_at=11`,
    );
    await db.exec('ROLLBACK');
    assert.equal(
      (await db.query<{ state: string }>('SELECT state FROM responder_actions')).rows[0].state,
      'proposed',
    );
    await db.exec(
      `UPDATE responder_actions SET state='refused',outcome='{"code":"paused"}',finished_at=11`,
    );
    await assert.rejects(
      db.exec(`UPDATE responder_actions SET state='proposed',outcome=NULL,finished_at=NULL`),
      /terminal/,
    );
    await assert.rejects(
      db.exec(`INSERT INTO responder_actions(agent_id,mention_seq,action,created_at)
      VALUES ('test-agent',2,'{}',10)`),
      /foreign key/,
    );
  } finally {
    await db.close();
  }
});
