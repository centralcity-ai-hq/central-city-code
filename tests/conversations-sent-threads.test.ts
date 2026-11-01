import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import type { Agent } from '../shared/types.js';
import type { AgentMessage, ConversationSummary } from '../server/messaging/contract.js';
import { SENDER_CONTEXT_INDEX } from '../server/messaging/sender-index-schema.js';

/*
 * R1-6 (migration 305): until the conversation summaries are backfilled, the conversation list
 * found the threads an owner only sent into from its newest 2,000 sent rows, so an older thread
 * with no reply vanished behind a busy one. It now walks messages (sender_owner_id, context_id,
 * created_at) like the received side; without that index (a large table the owner has not
 * indexed yet) one grouped read of the owner's sent rows gives the same list. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const call = (app: App, cookie: string, method: 'GET' | 'POST', url: string, body?: unknown) =>
  app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });

/** More sent rows in one recent thread than the old bounded window (2,000) covered. */
const BUSY_ROWS = 2_500;
/** Messages of other owners in other threads. */
const NOISE_ROWS = 20_000;

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  let now = 1_800_000_000_000;
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => now });
  t.after(() => app.close());
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Sender owner', password: 'Synthetic sender password' }),
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const agent = async (name: string) => {
    const res = await call(app, cookie, 'POST', '/api/agents', {
      name,
      description: 'Synthetic sender agent',
      capability: 'research',
      mode: 'external',
    });
    assert.equal(res.statusCode, 201, res.body);
    return (res.json() as { agent: Agent }).agent;
  };
  const a = await agent('Sender A');
  const b = await agent('Sender B');
  const c = await agent('Sender C');
  for (const [from, to] of [
    [a, b],
    [a, c],
  ] as const) {
    const res = await call(app, cookie, 'POST', '/api/connections', {
      fromAgentId: from.id,
      toAgentId: to.id,
    });
    assert.equal(res.statusCode, 201, res.body);
  }
  const send = async (from: Agent, body: Record<string, unknown>) => {
    const res = await call(app, cookie, 'POST', `/api/agents/${from.id}/messages`, {
      idempotency_key: randomUUID(),
      ...body,
    });
    assert.equal(res.statusCode, 201, res.body);
    now += 1000;
    return res.json().message as AgentMessage;
  };
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const db = app.city.db as { transaction: (fn: (tx: unknown) => Promise<unknown>) => unknown };
  const transaction = db.transaction.bind(db);
  db.transaction = (fn) =>
    transaction((tx) => {
      const inner = tx as { query: (sql: string, params?: unknown[]) => unknown };
      return fn(
        new Proxy(inner, {
          get: (target, key) =>
            key === 'query'
              ? (sql: string, params?: unknown[]) => {
                  statements.push({ sql, params });
                  return target.query(sql, params);
                }
              : Reflect.get(target, key),
        }),
      );
    });
  const list = async (query = '') => {
    statements.length = 0;
    const params = query.includes('limit=') ? query.slice(1) : `limit=100${query}`;
    const res = await call(app, cookie, 'GET', `/api/messages/conversations?${params}`);
    assert.equal(res.statusCode, 200, res.body);
    return (res.json().conversations as ConversationSummary[]).map((item) => ({
      context_id: item.context_id,
      message_count: item.message_count,
      participants: item.participants,
      last: item.last_message.id,
      unread: item.unread,
    }));
  };
  return { app, a, b, c, send, list, statements };
}

/**
 * An owner with an old thread it only sent into (the other side belongs to someone else) and a
 * recent thread with more sent rows than the old window, before the summaries are backfilled.
 */
async function sentOnlyBehindBusy(t: { after: (fn: () => Promise<unknown>) => void }) {
  const s = await setup(t);
  const old = await s.send(s.a, { to_agent_id: s.c.id, text: 'Older, sent only' });
  // The recipient's side belongs to another owner: this owner never received in that thread.
  await s.app.city.db.query("UPDATE messages SET recipient_owner_id = 'op-elsewhere' WHERE id=$1", [
    old.id,
  ]);
  const busy = await s.send(s.a, { to_agent_id: s.b.id, text: 'Busy, A and B' });
  await s.app.city.db.query(
    `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,
       context_id,reply_to,kind,parts,created_at,origin,sender_owner_label,room_id)
     SELECT recipient_id, seq + g, gen_random_uuid(), sender_id, sender_owner_id,
       recipient_owner_id, context_id, reply_to, kind, parts, created_at + g, origin,
       sender_owner_label, room_id
       FROM messages, generate_series(1, $2::int) AS g WHERE id=$1`,
    [busy.id, BUSY_ROWS],
  );
  // Other owners' traffic over many threads, so the planner sees a table like production's
  // (many owners, many threads) rather than two threads.
  await s.app.city.db.query(
    `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,
       context_id,reply_to,kind,parts,created_at,origin,sender_owner_label,room_id)
     SELECT 'noise-agent-' || (g % 400), g, gen_random_uuid(), 'noise-sender-' || (g % 400),
       'op-noise-' || (g % 200), 'op-noise-' || ((g + 1) % 200), 'ctx-noise-' || (g % 4000), NULL,
       kind, parts, created_at - g, origin, NULL, NULL
       FROM messages, generate_series(1, $2::int) AS g WHERE id=$1`,
    [busy.id, NOISE_ROWS],
  );
  // The path before the owner's backfill (migration 302): the list walks the messages.
  await s.app.city.db.query('UPDATE conversation_summaries_meta SET backfilled_at = NULL');
  await s.app.city.db.query('ANALYZE messages');
  return { ...s, old, busy };
}

const walk = (statements: Array<{ sql: string; params?: unknown[] }>) =>
  statements.find(({ sql }) => sql.includes('WITH RECURSIVE'));

test('R1-6: a thread the owner only sent into stays listed behind more than 2,000 newer sent rows, with and without the agent filter', async (t) => {
  const s = await sentOnlyBehindBusy(t);
  const all = await s.list();
  assert.deepEqual(
    all.map((item) => item.context_id),
    [s.busy.context_id, s.old.context_id],
  );
  assert.equal(all[0]!.message_count, BUSY_ROWS + 1);
  assert.equal(all[1]!.message_count, 1);
  assert.equal(all[1]!.last, s.old.id);
  assert.deepEqual(
    (await s.list(`&agent_id=${s.a.id}`)).map((item) => item.context_id),
    [s.busy.context_id, s.old.context_id],
  );
  assert.deepEqual(
    (await s.list(`&agent_id=${s.a.id}&limit=1`)).map((item) => item.context_id),
    [s.busy.context_id],
  );
  assert.deepEqual(
    (await s.list(`&agent_id=${s.b.id}`)).map((item) => item.context_id),
    [s.busy.context_id],
  );
});

test('R1-6: the sent side is an index walk over messages_sender_owner_context, never a sequential scan of messages', async (t) => {
  const s = await sentOnlyBehindBusy(t);
  for (const filter of ['', `&agent_id=${s.a.id}`]) {
    await s.list(filter);
    const statement = walk(s.statements);
    assert.ok(statement, 'the list walks the threads');
    assert.match(statement.sql, /m\.sender_owner_id=\$1\s+AND m\.context_id > sent\.context_id/);
    const plan = (
      await s.app.city.db.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN ${statement.sql}`,
        statement.params,
      )
    ).rows
      .map((row) => row['QUERY PLAN'])
      .join('\n');
    assert.match(plan, new RegExp(`(using|on) ${SENDER_CONTEXT_INDEX}\\b`), plan);
    assert.doesNotMatch(plan, /Seq Scan on messages\b/, plan);
  }
});

test('R1-6: without the index (a large table not indexed yet) the list is the same, from one grouped read of the sent rows', async (t) => {
  const s = await sentOnlyBehindBusy(t);
  const filters = ['', `&agent_id=${s.a.id}`, `&agent_id=${s.c.id}`, `&limit=1`];
  const withIndex = [];
  for (const filter of filters) withIndex.push(await s.list(filter));
  await s.app.city.db.query(`DROP INDEX ${SENDER_CONTEXT_INDEX}`);
  const without = [];
  for (const filter of filters) {
    without.push(await s.list(filter));
    const statement = walk(s.statements);
    assert.ok(statement);
    assert.doesNotMatch(statement.sql, /sent\.context_id/, 'no walk without its index');
    assert.match(statement.sql, /WHERE sender_owner_id=\$1 GROUP BY context_id/);
  }
  assert.deepEqual(without, withIndex);
  assert.deepEqual(
    without[0]!.map((item) => item.context_id),
    [s.busy.context_id, s.old.context_id],
  );
  // An index a failed concurrent build left invalid is not used either.
  await s.app.city.db.query(
    `CREATE INDEX ${SENDER_CONTEXT_INDEX} ON messages (sender_owner_id, context_id, created_at)`,
  );
  await s.app.city.db.query(
    `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${SENDER_CONTEXT_INDEX}'::regclass`,
  );
  assert.deepEqual(await s.list(), withIndex[0]);
  assert.doesNotMatch(walk(s.statements)!.sql, /sent\.context_id/);
});
