import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { sessionPair } from './session-cookie-pair.js';
import type { Transaction } from '../server/database.js';

/**
 * Agents as rows, phase 2a (TypeScript readers): the unlocked document reads go through
 * workspace_document() (migration 245, server/agent-rows/schema.ts). A workspace switched to rows by hand keeps an empty `agents`
 * array in its document, so any reader still on `data->'agents'` would answer differently. Each
 * representative reader is read in document mode, then again after the switch, and must answer
 * the same. Synthetic data.
 */
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-agent-rows-readers-root-secret';
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
type Q = Pick<Transaction, 'query'>;

/** The same hand switch as tests/agent-rows-migration.test.ts. */
async function switchToRows(db: Q, operatorId: string) {
  await db.query(
    `INSERT INTO agents(operator_id, agent_id, ordinal, agent)
       SELECT w.operator_id, e.agent->>'id', e.ordinal, e.agent
         FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents')
              WITH ORDINALITY AS e(agent, ordinal)
        WHERE w.operator_id = $1`,
    [operatorId],
  );
  await db.query(`INSERT INTO workspace_storage VALUES ($1, 'rows', 1)`, [operatorId]);
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', '[]') WHERE operator_id = $1`,
    [operatorId],
  );
}

test('converted readers answer the same in document mode and after a switch to rows', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const db = app.city.db;
  let address = 10;
  const call = (method: 'GET' | 'POST', url: string, cookie: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...headers, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      remoteAddress: `203.0.113.${address++}`,
    });
  const registered = await call('POST', '/api/auth/register', '', {
    name: 'Rows readers owner',
    password: 'Synthetic rows readers password',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = sessionPair(registered.cookies);
  const operatorId = registered.json().operator.id as string;
  const ids: string[] = [];
  for (const name of ['Reader one', 'Reader two', 'Reader three']) {
    const created = await call('POST', '/api/agents', cookie, {
      name,
      capability: 'research',
      mode: 'hosted',
    });
    assert.equal(created.statusCode, 201, created.body);
    ids.push(created.json().agent.id as string);
  }
  const [first, second, third] = ids as [string, string, string];
  const connected = await call('POST', '/api/connections', cookie, {
    fromAgentId: first,
    toAgentId: second,
  });
  assert.ok(connected.statusCode < 300, connected.body);
  const room = await call('POST', '/api/rooms', cookie, {
    name: 'Rows readers room',
    agent_id: first,
    idempotency_key: randomUUID(),
  });
  assert.equal(room.statusCode, 201, room.body);
  const roomId = room.json().room.id as string;

  const read = async () => {
    // messaging/service.ts: the sender's workspace and the recipient lookup.
    const sent = await call('POST', `/api/agents/${first}/messages`, cookie, {
      to_agent_id: second,
      text: 'Synthetic hello',
      idempotency_key: randomUUID(),
    });
    assert.equal(sent.statusCode, 201, sent.body);
    // rooms/service.ts access(): the caller's live agents among the room's members.
    const posted = await call('POST', `/api/rooms/${roomId}/messages`, cookie, {
      agent_id: first,
      text: 'Synthetic room line',
      idempotency_key: randomUUID(),
    });
    assert.equal(posted.statusCode, 201, posted.body);
    // Read after the send, so both modes list the same inboxes with unread messages.
    const summary = await call('GET', '/api/messages/summary', cookie);
    assert.equal(summary.statusCode, 200, summary.body);
    const opened = await call('GET', `/api/rooms/${roomId}/messages`, cookie);
    assert.equal(opened.statusCode, 200, opened.body);
    return {
      inboxes: (summary.json().inboxes as Array<{ agent_id?: string }> | undefined)
        ?.map((item) => item.agent_id)
        .sort(),
      sent: sent.statusCode,
      posted: posted.statusCode,
      roomRead: opened.statusCode,
    };
  };

  const before = await read();
  assert.equal(before.sent, 201);

  await switchToRows(db, operatorId);
  const stored = (
    await db.query<{ data: { agents: unknown[] } }>(
      'SELECT data FROM workspaces WHERE operator_id=$1',
      [operatorId],
    )
  ).rows[0]!.data;
  assert.deepEqual(stored.agents, [], 'the document no longer holds the agents');
  const after = await read();
  assert.deepEqual(after, before);
  assert.ok(third);
});
