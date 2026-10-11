import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../server/app.js';

/**
 * My agents' Overview totals (GET /api/agents/:id/totals): tasks the agent handed in that were
 * approved. Owner only. Synthetic data only.
 */
process.env.CITY_ROOM_TASKS = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-agent-totals-test-root-secret';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};

test('totals: tasks done for one agent, owner only', async (t) => {
  const database = await PGlite.create('memory://');
  const app = await createApp({
    database,
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  let address = 10;
  const call = (method: 'GET' | 'POST', url: string, cookie: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...headers, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      remoteAddress: `203.0.113.${address++}`,
    });
  const register = async (name: string) => {
    const response = await call('POST', '/api/auth/register', '', {
      name,
      password: `Synthetic totals test password ${name}`,
    });
    assert.equal(response.statusCode, 201, response.body);
    return `cc_session=${response.cookies.find((c) => c.name === 'cc_session')!.value}`;
  };
  const cookie = await register('Totals owner');
  const created = await call('POST', '/api/agents', cookie, {
    name: 'Worker',
    capability: 'research',
    mode: 'hosted',
  });
  assert.equal(created.statusCode, 201, created.body);
  const agentId = created.json().agent.id as string;
  const idle = await call('POST', '/api/agents', cookie, {
    name: 'Idle',
    capability: 'research',
    mode: 'hosted',
  });
  const idleId = idle.json().agent.id as string;

  const zero = await call('GET', `/api/agents/${agentId}/totals`, cookie);
  assert.equal(zero.statusCode, 200, zero.body);
  assert.deepEqual(zero.json(), { tasks_done: 0, messages_sent: 0 });

  const room = await call('POST', '/api/rooms', cookie, {
    name: 'Totals room',
    agent_id: agentId,
    idempotency_key: randomUUID(),
  });
  assert.equal(room.statusCode, 201, room.body);
  const roomId = room.json().room.id as string;
  for (const text of ['One', 'Two', 'Three']) {
    const posted = await call('POST', `/api/rooms/${roomId}/messages`, cookie, {
      agent_id: agentId,
      text,
      idempotency_key: randomUUID(),
    });
    assert.equal(posted.statusCode, 201, posted.body);
  }

  const task = await call('POST', `/api/rooms/${roomId}/tasks`, cookie, {
    agent_id: agentId,
    title: 'Count things',
    idempotency_key: randomUUID(),
  });
  assert.equal(task.statusCode, 201, task.body);
  const taskId = task.json().task.id as string;
  const base = `/api/rooms/${roomId}/tasks/${taskId}`;
  const claimed = await call('POST', `${base}/claim`, cookie, {
    agent_id: agentId,
    idempotency_key: randomUUID(),
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const result = await call('POST', `${base}/result`, cookie, {
    claim_token: claimed.json().claim_token,
    evidence: { kind: 'proposal', ref: 'proposal-1', revision: 'rev-1' },
  });
  assert.equal(result.statusCode, 200, result.body);
  const before = (await call('GET', `/api/agents/${agentId}/totals`, cookie)).json();
  assert.equal(before.tasks_done, 0, 'in review is not done');
  const approved = await call('POST', `${base}/update`, cookie, { decision: 'approve' });
  assert.equal(approved.statusCode, 200, approved.body);

  const totals = await call('GET', `/api/agents/${agentId}/totals`, cookie);
  assert.equal(totals.statusCode, 200, totals.body);
  assert.equal(totals.json().tasks_done, 1);
  // The three posts; the room's system lines (created, claimed, ...) never count.
  assert.equal(totals.json().messages_sent, 3, totals.body);
  assert.deepEqual((await call('GET', `/api/agents/${idleId}/totals`, cookie)).json(), {
    tasks_done: 0,
    messages_sent: 0,
  });

  // A failed insert never bumps the count: the trigger runs in the insert's own transaction.
  const row = (
    await database.query<Record<string, unknown>>(
      'SELECT * FROM room_messages WHERE room_id=$1 AND sender_agent_id=$2 LIMIT 1',
      [roomId, agentId],
    )
  ).rows[0]!;
  await assert.rejects(
    database.transaction(async (tx) => {
      // Same (room_id, seq): the primary key refuses it.
      await tx.query(
        `INSERT INTO room_messages(room_id,seq,id,sender_agent_id,sender_owner_id,sender_name,sender_owner_label,parts,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
        [
          roomId,
          row.seq,
          randomUUID(),
          agentId,
          row.sender_owner_id,
          'Worker',
          'x',
          '[]',
          Date.now(),
        ],
      );
    }),
  );
  assert.equal(
    (await call('GET', `/api/agents/${agentId}/totals`, cookie)).json().messages_sent,
    3,
    'a refused insert left the count alone',
  );

  // The off-peak backfill adds messages from before counting began, once. Simulate a server whose
  // counting started after these posts: the counter is empty and counting_since is later.
  await database.exec(`DELETE FROM agent_message_counts;
    UPDATE agent_message_counts_meta SET counting_since = counting_since + 3600000, backfilled_at = NULL;`);
  const backfill = readFileSync(
    new URL('../scripts/ops/backfill-message-counts.sql', import.meta.url),
    'utf8',
  );
  await database.exec(backfill);
  const sent = async () =>
    (await call('GET', `/api/agents/${agentId}/totals`, cookie)).json().messages_sent;
  assert.equal(await sent(), 3, 'history counted once');
  await database.exec(backfill);
  assert.equal(await sent(), 3, 'a second run changes nothing');

  const stranger = await register('Totals stranger');
  assert.equal((await call('GET', `/api/agents/${agentId}/totals`, stranger)).statusCode, 404);
});
