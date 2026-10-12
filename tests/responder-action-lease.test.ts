import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { checkActionLease, executeLeasedAction } from '../server/responder/action-lease.js';
import { responderActionsMigration } from '../server/responder/action-schema.js';

test('stale workers cannot settle the journal or prevent the valid lease from executing', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE responder_replies (
      agent_id text, mention_seq bigint, owner_id text, room_id text,
      lease_id text, status text, locked_until bigint, PRIMARY KEY(agent_id,mention_seq));
      INSERT INTO responder_replies VALUES ('a',1,'o','r','new','generated',100);
      CREATE TABLE effects (id integer PRIMARY KEY);`);
    await db.exec(responderActionsMigration.sql!);
    await db.exec(`INSERT INTO responder_actions(agent_id,mention_seq,action,created_at)
      VALUES ('a',1,'{"name":"room_pin","arguments":{"seq":1}}',1);`);
    const key = { agentId: 'a', mentionSeq: 1, ownerId: 'o', roomId: 'r', leaseId: 'new' };
    const run = (leaseId: string) =>
      db.transaction((tx) =>
        executeLeasedAction(tx, { ...key, leaseId }, () => 10, {
          enabled: true,
          authorize: async () => null,
          effect: async (tx) => {
            await tx.query('INSERT INTO effects VALUES (1)');
            return { id: 1 };
          },
        }),
      );
    await assert.rejects(run('old'), /lease lost/);
    let now = 10;
    await assert.rejects(
      db.transaction((tx) =>
        executeLeasedAction(tx, key, () => now, {
          enabled: true,
          authorize: async () => {
            now = 100;
            return null;
          },
          effect: async () => assert.fail('expired authority must not execute'),
        }),
      ),
      /lease lost/,
    );
    assert.deepEqual((await db.query('SELECT state FROM responder_actions')).rows, [
      { state: 'proposed' },
    ]);
    assert.equal((await db.query('SELECT * FROM responder_action_usage')).rows.length, 0);
    assert.equal((await run('new')).state, 'executed');
    assert.equal((await run('new')).state, 'executed');
    assert.equal((await db.query('SELECT * FROM effects')).rows.length, 1);
  } finally {
    await db.close();
  }
});

test('action lease binds durable owner, room, generation and generated state', async () => {
  const db = new PGlite();
  const key = {
    agentId: 'test-agent',
    mentionSeq: 1,
    ownerId: 'test-owner',
    roomId: 'test-room',
    leaseId: 'test-lease',
  };
  try {
    await db.exec(`CREATE TABLE responder_replies (
      agent_id text, mention_seq bigint, owner_id text, room_id text,
      lease_id text, status text, locked_until bigint);
      INSERT INTO responder_replies VALUES ('test-agent',1,'test-owner','test-room','test-lease','generated',20);`);
    const check = (override = {}, now = 10) =>
      db.transaction((tx) => checkActionLease(tx, { ...key, ...override }, () => now));
    assert.equal(await check(), null);
    for (const override of [
      { ownerId: 'other' },
      { roomId: 'other' },
      { leaseId: 'old' },
      { leaseId: '' },
      { mentionSeq: 2 },
    ])
      assert.equal(await check(override), 'lease_lost');
    for (const now of [20, 21, NaN, Infinity, -1]) assert.equal(await check({}, now), 'lease_lost');
    for (const status of ['pending', 'posted', 'cancelled', 'failed']) {
      await db.query('UPDATE responder_replies SET status=$1', [status]);
      assert.equal(await check(), 'lease_lost');
    }
  } finally {
    await db.close();
  }
});

test('lease expiry uses time after the row lock resolves', async () => {
  let now = 10;
  const result = await checkActionLease(
    {
      query: async () => {
        now = 20;
        return {
          rows: [
            { owner_id: 'o', room_id: 'r', lease_id: 'l', status: 'generated', locked_until: 20 },
          ],
        } as never;
      },
    },
    { agentId: 'a', mentionSeq: 1, ownerId: 'o', roomId: 'r', leaseId: 'l' },
    () => now,
  );
  assert.equal(result, 'lease_lost');
});
