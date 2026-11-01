import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import type { Agent } from '../shared/types.js';
import type { AgentMessage, ConversationSummary } from '../server/messaging/contract.js';
import { backfillConversationSummaries } from '../server/messaging/summaries-backfill.js';

/*
 * R8-2 (migration 302): the conversation list reads one summary row per (owner, thread) instead
 * of counting and grouping the thread's messages on every poll. The rows are kept by triggers and
 * must always equal what the old aggregate computed; threads older than the summaries are
 * aggregated as before until the owner's backfill recounts them.
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

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  let now = 1_800_000_000_000;
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => now });
  t.after(() => app.close());
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Summary owner', password: 'Synthetic summary password' }),
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const agent = async (name: string) => {
    const res = await call(app, cookie, 'POST', '/api/agents', {
      name,
      description: 'Synthetic summary agent',
      capability: 'research',
      mode: 'external',
    });
    assert.equal(res.statusCode, 201, res.body);
    return (res.json() as { agent: Agent }).agent;
  };
  const a = await agent('Summary A');
  const b = await agent('Summary B');
  const c = await agent('Summary C');
  for (const [from, to] of [
    [a, b],
    [b, a],
    [a, c],
    [c, a],
    [b, c],
    [c, b],
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
  const conversations = async () =>
    (await call(app, cookie, 'GET', '/api/messages/conversations?limit=100')).json()
      .conversations as ConversationSummary[];
  const db = app.city.db;
  /** What the old per-thread aggregate computes, for every (owner, thread). */
  const truth = async () =>
    (
      await db.query<Record<string, unknown>>(
        `SELECT o.owner_id, m.context_id, count(*)::int AS message_count,
           array_agg(DISTINCT m.sender_id ORDER BY m.sender_id) AS senders,
           array_agg(DISTINCT m.recipient_id ORDER BY m.recipient_id) AS recipients,
           max(m.created_at)::text AS last_at,
           (max(m.created_at) FILTER (WHERE m.recipient_owner_id = o.owner_id))::text AS last_received_at,
           (array_agg(m.recipient_id || ':' || m.seq ORDER BY m.created_at DESC, m.seq DESC, m.id DESC))[1] AS last
         FROM messages m, LATERAL (SELECT DISTINCT x FROM unnest(ARRAY[m.sender_owner_id, m.recipient_owner_id]) x) o(owner_id)
         GROUP BY o.owner_id, m.context_id ORDER BY 1, 2`,
      )
    ).rows;
  const stored = async (where = 'true') =>
    (
      await db.query<Record<string, unknown>>(
        `SELECT owner_id, context_id, message_count::int AS message_count, senders, recipients,
           last_at::text AS last_at, last_received_at::text AS last_received_at,
           last_recipient_id || ':' || last_seq AS last
         FROM conversation_summaries WHERE ${where} ORDER BY 1, 2`,
      )
    ).rows;
  return { app, db, a, b, c, send, conversations, truth, stored, tick: () => (now += 1000) };
}

/** Records the statements the app's transactions run while `action` runs. */
async function recording<T>(app: App, action: () => Promise<T>) {
  const statements: string[] = [];
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
                  statements.push(sql);
                  return target.query(sql, params);
                }
              : Reflect.get(target, key),
        }),
      );
    });
  try {
    return { result: await action(), statements };
  } finally {
    db.transaction = transaction;
  }
}
const aggregatesMessages = (statements: string[]) =>
  statements.filter(
    (sql) =>
      /FROM messages/.test(sql) &&
      /count\(\*\)|jsonb_agg|GROUP BY|DISTINCT ON|WITH RECURSIVE/.test(sql) &&
      !/ORDER BY m\.seq LIMIT \$4\) x/.test(sql),
  );

test('R8-2: the triggers keep every summary equal to the old aggregate, and the list reads only them', async (t) => {
  const s = await setup(t);
  const first = await s.send(s.a, { to_agent_id: s.b.id, text: 'A to B' });
  await s.send(s.b, { to_agent_id: s.a.id, text: 'B to A', reply_to: first.id });
  await s.send(s.a, { to_agent_id: s.c.id, text: 'A to C' });
  const fresh = await s.send(s.c, {
    to_agent_id: s.b.id,
    text: 'C to B, new thread',
    context_id: 'topic-1',
  });
  await s.send(s.b, { to_agent_id: s.c.id, text: 'B to C', reply_to: fresh.id });
  for (let i = 0; i < 12; i++)
    await s.send([s.a, s.b, s.c][i % 3]!, {
      to_agent_id: [s.b, s.c, s.a][i % 3]!.id,
      text: `round ${i}`,
    });
  const rows = await s.stored();
  // Three threads: A-B, A-C, and B-C (which continues its latest, topic-1).
  assert.equal(rows.length, 3);
  assert.deepEqual(rows, await s.truth());
  assert.deepEqual(
    (
      await s.db.query<{ complete: boolean }>(
        'SELECT DISTINCT complete FROM conversation_summaries',
      )
    ).rows,
    [{ complete: true }],
  );
  const { result: list, statements } = await recording(s.app, s.conversations);
  assert.deepEqual(aggregatesMessages(statements), []);
  // The list says what the rows say.
  const byContext = new Map(rows.map((row) => [row.context_id, row]));
  assert.equal(list.length, rows.length);
  for (const item of list) {
    const row = byContext.get(item.context_id)!;
    assert.equal(item.message_count, row.message_count);
    assert.deepEqual(
      item.participants,
      [...new Set([...(row.senders as string[]), ...(row.recipients as string[])])].sort(),
    );
    const newest = await s.db.query<{ id: string }>(
      "SELECT id::text AS id FROM messages WHERE recipient_id || ':' || seq = $1",
      [row.last],
    );
    assert.equal(item.last_message.id, newest.rows[0]!.id);
  }
  // Newest first.
  const order = list.map((item) => Number(byContext.get(item.context_id)!.last_at));
  assert.deepEqual(
    order,
    [...order].sort((x, y) => y - x),
  );
});

test('R8-2: threads older than the summaries list as before; the backfill recounts them exactly, then the list reads only summaries', async (t) => {
  const s = await setup(t);
  await s.send(s.a, { to_agent_id: s.b.id, text: 'one' });
  await s.send(s.b, { to_agent_id: s.a.id, text: 'two' });
  await s.send(s.a, { to_agent_id: s.c.id, text: 'three' });
  await s.send(s.c, { to_agent_id: s.b.id, text: 'four', context_id: 'topic-2' });
  const expected = await s.truth();
  // A database migrated with messages already in it: no summaries yet, not backfilled.
  await s.db.query('DELETE FROM conversation_summaries');
  await s.db.query('UPDATE conversation_summaries_meta SET backfilled_at = NULL');
  const before = await recording(s.app, s.conversations);
  assert.equal(before.result.length, 3);
  assert.ok(
    before.statements.some((sql) => sql.includes('WITH RECURSIVE')),
    'the old page walk',
  );
  // A send into an old thread: its row is not complete (it misses the older messages).
  await s.send(s.a, { to_agent_id: s.b.id, text: 'five' });
  const partial = await s.stored();
  assert.equal(
    partial.length,
    1,
    'one row: the thread has one owner (all three agents are theirs)',
  );
  assert.deepEqual(
    (
      await s.db.query<{ complete: boolean }>(
        'SELECT DISTINCT complete FROM conversation_summaries',
      )
    ).rows,
    [{ complete: false }],
  );
  const mixed = await s.conversations();
  // Still exact: the incomplete thread is aggregated as before.
  const truthNow = await s.truth();
  const count = (contextId: string) =>
    truthNow.find((row) => row.context_id === contextId)!.message_count;
  for (const item of mixed) assert.equal(item.message_count, count(item.context_id));

  const dry = await backfillConversationSummaries(s.db, { confirm: false });
  assert.equal(dry.backfilled, false);
  assert.equal((await s.stored()).length, 1, 'a dry run writes nothing');
  const run = await backfillConversationSummaries(s.db, { confirm: true, threadsPerBatch: 1 });
  assert.equal(run.failed, 0);
  assert.equal(run.backfilled, true);
  assert.equal(run.threads, 3);
  assert.deepEqual(await s.stored(), truthNow);
  assert.notDeepEqual(truthNow, expected, 'the send after the migration is counted');
  const after = await recording(s.app, s.conversations);
  assert.deepEqual(aggregatesMessages(after.statements), []);
  assert.deepEqual(
    after.result.map((item) => [item.context_id, item.message_count, item.last_message.id]),
    mixed.map((item) => [item.context_id, item.message_count, item.last_message.id]),
  );
  // Running it again changes nothing.
  const again = await backfillConversationSummaries(s.db, { confirm: true });
  assert.equal(again.recounted, 0);
  assert.deepEqual(await s.stored(), truthNow);
});

test('R8-2: a message moved to another thread (pair-context remediation) is never miscounted', async (t) => {
  const s = await setup(t);
  const old = await s.send(s.a, { to_agent_id: s.b.id, text: 'old id', context_id: 'legacy-1' });
  await s.send(s.b, { to_agent_id: s.a.id, text: 'old id again', context_id: 'legacy-1' });
  const kept = await s.send(s.a, {
    to_agent_id: s.b.id,
    text: 'stored id',
    context_id: 'stored-1',
  });
  await s.db.query("UPDATE messages SET context_id = 'stored-1' WHERE context_id = 'legacy-1'");
  // Both rows are incomplete now; the list aggregates them and is exact.
  const list = await s.conversations();
  assert.deepEqual(
    list.map((item) => [item.context_id, item.message_count]),
    [['stored-1', 3]],
  );
  assert.equal(list[0]!.last_message.id, kept.id);
  assert.ok(old.id);
  // The backfill recounts the thread and drops the row of the emptied one.
  const run = await backfillConversationSummaries(s.db, { confirm: true });
  assert.equal(run.failed, 0);
  assert.deepEqual(await s.stored(), await s.truth());
  assert.equal((await s.stored("context_id = 'legacy-1'")).length, 0);
});
