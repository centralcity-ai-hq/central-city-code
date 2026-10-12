import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { responderActionsMigration } from '../server/responder/action-schema.js';
import {
  executeJournaledAction,
  proposeJournaledAction,
} from '../server/responder/action-journal.js';

test('action execution is disabled by default before database or authority access', async () => {
  for (const enabled of [undefined, false]) {
    await assert.rejects(
      executeJournaledAction(
        { query: async () => assert.fail('disabled execution must not query') },
        { agentId: 'test-agent', mentionSeq: 1 },
        {
          enabled,
          now: 1,
          authorize: async () => assert.fail('disabled execution must not authorize'),
          effect: async () => assert.fail('disabled execution must not mutate'),
        },
      ),
      /Responder actions are disabled/,
    );
  }
});

test('authority refusals neither charge nor execute and remain terminal on retry', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE responder_replies (
      agent_id text, mention_seq bigint, PRIMARY KEY(agent_id, mention_seq));
      INSERT INTO responder_replies SELECT 'test-agent',n FROM generate_series(1,5) n;`);
    await db.exec(responderActionsMigration.sql!);
    const reasons = ['lease_lost', 'owner_changed', 'paused', 'agent_not_visible', 'room_closed'];
    for (const [index, code] of reasons.entries()) {
      const key = { agentId: 'test-agent', mentionSeq: index + 1 };
      const result = await db.transaction(async (tx) => {
        await proposeJournaledAction(tx, key, [{ name: 'room_pin', arguments: { seq: 1 } }], 1);
        return executeJournaledAction(tx, key, {
          enabled: true,
          now: 1,
          authorize: async () => code,
          effect: async () => assert.fail('refused authority must not execute'),
        });
      });
      assert.deepEqual(result, { state: 'refused', outcome: { code } });
      assert.equal((await db.query('SELECT * FROM responder_action_usage')).rows.length, 0);
      const replay = await db.transaction((tx) =>
        executeJournaledAction(tx, key, {
          enabled: true,
          now: 2,
          authorize: async () => null,
          effect: async () => assert.fail('restored authority must not revive a refusal'),
        }),
      );
      assert.deepEqual(replay, result);
    }
  } finally {
    await db.close();
  }
});

test('daily action budget commits with effects, does not recharge replay, and resets at UTC midnight', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE responder_replies (
      agent_id text, mention_seq bigint, PRIMARY KEY(agent_id, mention_seq));
      INSERT INTO responder_replies SELECT 'test-agent',n FROM generate_series(1,12) n;`);
    await db.exec(responderActionsMigration.sql!);
    let effects = 0;
    const run = (seq: number, now: number, crash = false) =>
      db.transaction(async (tx) => {
        const key = { agentId: 'test-agent', mentionSeq: seq };
        await proposeJournaledAction(tx, key, [{ name: 'room_pin', arguments: { seq } }], now);
        return executeJournaledAction(tx, key, {
          enabled: true,
          now,
          authorize: async () => null,
          effect: async () => {
            if (crash) throw new Error('effect failed');
            effects++;
            return { seq };
          },
        });
      });
    await assert.rejects(run(1, 1, true), /effect failed/);
    assert.equal((await db.query('SELECT * FROM responder_action_usage')).rows.length, 0);
    for (let seq = 1; seq <= 10; seq++) assert.equal((await run(seq, 1)).state, 'executed');
    assert.equal((await run(1, 1)).state, 'executed');
    assert.deepEqual(await run(11, 1), {
      state: 'refused',
      outcome: { code: 'action_daily_limit' },
    });
    assert.equal(effects, 10);
    assert.equal((await run(12, 86_400_000)).state, 'executed');
    assert.equal((await run(11, 86_400_000)).state, 'refused', 'a refusal is terminal across days');
    assert.deepEqual(
      (await db.query('SELECT actions FROM responder_action_usage ORDER BY day')).rows,
      [{ actions: 10 }, { actions: 1 }],
    );
  } finally {
    await db.close();
  }
});

test('proposal retries preserve the first action and reject malformed input', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE responder_replies (
      agent_id text, mention_seq bigint, PRIMARY KEY(agent_id, mention_seq));
      INSERT INTO responder_replies VALUES ('test-agent',1);`);
    await db.exec(responderActionsMigration.sql!);
    const key = { agentId: 'test-agent', mentionSeq: 1 };
    const first = { name: 'room_pin', arguments: { seq: 10 } };
    const propose = (input: unknown, now: number) =>
      db.transaction((tx) => proposeJournaledAction(tx, key, input, now));
    await assert.rejects(propose([], 1), /Invalid responder action proposal/);
    assert.equal((await db.query('SELECT * FROM responder_actions')).rows.length, 0);
    await assert.rejects(
      db.transaction(async (tx) => {
        await proposeJournaledAction(tx, key, [first], 1);
        throw new Error('lease transaction aborted');
      }),
      /lease transaction aborted/,
    );
    assert.equal((await db.query('SELECT * FROM responder_actions')).rows.length, 0);
    await assert.rejects(
      db.transaction((tx) => proposeJournaledAction(tx, { ...key, mentionSeq: 2 }, [first], 1)),
      /foreign key/i,
    );
    assert.deepEqual(await propose([first], 2), first);
    assert.deepEqual(await propose([{ name: 'room_pin', arguments: { seq: 99 } }], 3), first);
    assert.deepEqual((await db.query('SELECT action,created_at FROM responder_actions')).rows, [
      { action: first, created_at: 2 },
    ]);
  } finally {
    await db.close();
  }
});

test('effect and outcome roll back together; replay never repeats a removed effect', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE responder_replies (
      agent_id text, mention_seq bigint, PRIMARY KEY(agent_id, mention_seq));
      INSERT INTO responder_replies VALUES ('test-agent',1),('test-agent',2);
      CREATE TABLE effects (id integer PRIMARY KEY);`);
    await db.exec(responderActionsMigration.sql!);
    await db.exec(`INSERT INTO responder_actions(agent_id,mention_seq,action,created_at)
      SELECT 'test-agent',n,'{"name":"room_pin","arguments":{"seq":1}}',10
      FROM generate_series(1,2) n`);
    const key = { agentId: 'test-agent', mentionSeq: 1 };
    await assert.rejects(
      db.transaction((tx) =>
        executeJournaledAction(tx, key, {
          enabled: true,
          now: 11,
          authorize: async () => {
            throw new Error('authorization unavailable');
          },
          effect: async () => {
            assert.fail('authorization failure must not execute an effect');
          },
        }),
      ),
      /authorization unavailable/,
    );
    assert.deepEqual(
      (await db.query('SELECT state,outcome FROM responder_actions WHERE mention_seq=1')).rows,
      [{ state: 'proposed', outcome: null }],
    );
    // A mutation without a serializable durable result must not survive a retry.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const outcome of [undefined, null, NaN, Infinity, { toJSON: () => null }, 1n, circular]) {
      await assert.rejects(
        db.transaction((tx) =>
          executeJournaledAction(tx, key, {
            enabled: true,
            now: 11,
            authorize: async () => null,
            effect: async (tx) => {
              await tx.query('INSERT INTO effects VALUES (1)');
              return outcome;
            },
          }),
        ),
      );
      assert.equal((await db.query('SELECT * FROM effects')).rows.length, 0);
      const pending = await db.query<{ state: string; outcome: unknown }>(
        'SELECT state,outcome FROM responder_actions WHERE mention_seq=1',
      );
      assert.deepEqual(pending.rows[0], { state: 'proposed', outcome: null });
    }
    await assert.rejects(
      db.transaction((tx) =>
        executeJournaledAction(tx, key, {
          enabled: true,
          now: 11,
          authorize: async () => null,
          effect: async (tx) => {
            await tx.query('INSERT INTO effects VALUES (1)');
            throw new Error('interrupted');
          },
        }),
      ),
      /interrupted/,
    );
    assert.equal((await db.query('SELECT * FROM effects')).rows.length, 0);
    assert.equal(
      (await db.query<{ state: string }>('SELECT state FROM responder_actions WHERE mention_seq=1'))
        .rows[0].state,
      'proposed',
    );
    const done = await db.transaction((tx) =>
      executeJournaledAction(tx, key, {
        enabled: true,
        now: 12,
        authorize: async () => null,
        effect: async (tx) => {
          await tx.query('INSERT INTO effects VALUES (1)');
          return { id: 1 };
        },
      }),
    );
    assert.equal(done.state, 'executed');
    await db.exec('DELETE FROM effects');
    const replay = await db.transaction((tx) =>
      executeJournaledAction(tx, key, {
        enabled: true,
        now: 13,
        authorize: async () => {
          throw new Error('replay must not authorize a new effect');
        },
        effect: async () => {
          throw new Error('replay must not repeat effect');
        },
      }),
    );
    assert.deepEqual(replay, done);
    const refused = await db.transaction((tx) =>
      executeJournaledAction(
        tx,
        { ...key, mentionSeq: 2 },
        {
          enabled: true,
          now: 14,
          authorize: async () => 'paused',
          effect: async () => {
            throw new Error('refused action must not execute');
          },
        },
      ),
    );
    assert.deepEqual(refused, { state: 'refused', outcome: { code: 'paused' } });
  } finally {
    await db.close();
  }
});
