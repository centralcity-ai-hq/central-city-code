import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import type { Agent } from '../shared/types.js';
import type { AgentMessage, ConversationSummary } from '../server/messaging/contract.js';
import { CONVERSATION_SEND_SCAN, pairKey } from '../server/messaging/service.js';
import { legacyPairContextId } from '../scripts/remediate-pair-contexts.js';

/**
 * Conversations (UX audit #6): a message without context_id continues the pair's latest
 * conversation instead of opening one conversation per message. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

function call(app: App, cookie: string, method: 'GET' | 'POST', url: string, body?: unknown) {
  return app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  let now = 1_800_000_000_000;
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => now });
  t.after(() => app.close());
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Thread owner', password: 'Synthetic thread password' }),
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const agent = async (name: string) => {
    const res = await call(app, cookie, 'POST', '/api/agents', {
      name,
      description: 'Synthetic thread agent',
      capability: 'research',
      mode: 'external',
    });
    assert.equal(res.statusCode, 201, res.body);
    return (res.json() as { agent: Agent }).agent;
  };
  const a = await agent('Thread A');
  const b = await agent('Thread B');
  const c = await agent('Thread C');
  for (const [from, to] of [
    [a, b],
    [b, a],
    [a, c],
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
    // Distinct timestamps keep "latest" unambiguous, as in real traffic.
    now += 1000;
    return res.json().message as AgentMessage;
  };
  const conversations = async () =>
    (await call(app, cookie, 'GET', '/api/messages/conversations?limit=100')).json()
      .conversations as ConversationSummary[];
  const pairId = (x: Agent, y: Agent) => storedPairId(app, x.id, y.id);
  return { app, cookie, a, b, c, send, conversations, pairId, tick: () => (now += 1000) };
}

/** The pair's stored default conversation (pair_contexts), or undefined before its first use. */
async function storedPairId(app: App, x: string, y: string): Promise<string | undefined> {
  const [low, high] = pairKey(x, y);
  return (
    await app.city.db.query<{ context_id: string }>(
      'SELECT context_id FROM pair_contexts WHERE low_id=$1 AND high_id=$2',
      [low, high],
    )
  ).rows[0]?.context_id;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('two messages without context_id land in one conversation', async (t) => {
  const { a, b, send, conversations, pairId } = await setup(t);
  const first = await send(a, { to_agent_id: b.id, text: 'First' });
  const second = await send(a, { to_agent_id: b.id, text: 'Second' });
  assert.equal(first.context_id, await pairId(a, b));
  assert.match(first.context_id, UUID, 'a random (version 4) id, grouped by participants');
  assert.notEqual(first.context_id, legacyPairContextId(a.id, b.id), 'not derivable');
  assert.equal(second.context_id, first.context_id);
  const list = await conversations();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.message_count, 2);
});

test('a message from the other side without context_id joins the same conversation', async (t) => {
  const { a, b, send, conversations, pairId } = await setup(t);
  const first = await send(a, { to_agent_id: b.id, text: 'Question' });
  const answer = await send(b, { to_agent_id: a.id, text: 'Answer, no reply_to' });
  assert.equal(answer.context_id, first.context_id);
  assert.equal(await pairId(b, a), await pairId(a, b), 'direction-independent');
  assert.equal((await conversations()).length, 1);
});

test('an explicit context_id starts or joins that thread and always wins', async (t) => {
  const { app, cookie, a, b, c, send, conversations, pairId } = await setup(t);
  const plain = await send(a, { to_agent_id: b.id, text: 'Default thread' });
  const topic = await send(a, { to_agent_id: b.id, text: 'Topic', context_id: 'leads:fabric' });
  assert.equal(topic.context_id, 'leads:fabric');
  // Without a context_id the pair continues its latest conversation, which is now the topic.
  const next = await send(b, { to_agent_id: a.id, text: 'Continuing' });
  assert.equal(next.context_id, 'leads:fabric');
  // An explicit id wins over the latest conversation, including returning to the default one.
  const back = await send(a, { to_agent_id: b.id, text: 'Back', context_id: plain.context_id });
  assert.equal(back.context_id, plain.context_id);
  // A third agent can start its own named thread, but never write into one it is not part of.
  const own = await send(c, { to_agent_id: b.id, text: 'Separate', context_id: 'research:c' });
  assert.equal(own.context_id, 'research:c');
  const intrude = await call(app, cookie, 'POST', `/api/agents/${c.id}/messages`, {
    to_agent_id: b.id,
    text: 'Intrude',
    context_id: 'leads:fabric',
    idempotency_key: randomUUID(),
  });
  assert.equal(intrude.statusCode, 403, intrude.body);
  assert.equal(intrude.json().code, 'context_forbidden');
  // Another pair is a separate conversation.
  const other = await send(a, { to_agent_id: c.id, text: 'Hello C' });
  assert.equal(other.context_id, await pairId(a, c));
  assert.notEqual(other.context_id, plain.context_id);
  assert.equal((await conversations()).length, 4);
});

test('a reply without context_id still joins the thread of the message it answers', async (t) => {
  const { a, b, send } = await setup(t);
  const topic = await send(a, { to_agent_id: b.id, text: 'Topic', context_id: 'plan:m3' });
  await send(a, { to_agent_id: b.id, text: 'Other', context_id: 'plan:m4' });
  const reply = await send(b, { to_agent_id: a.id, text: 'Re M3', reply_to: topic.id });
  assert.equal(reply.context_id, 'plan:m3');
});

test('concurrent sends in both directions converge on one conversation', async (t) => {
  const { app, cookie, a, b, conversations, pairId } = await setup(t);
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) => {
      const [from, to] = index % 2 ? [b, a] : [a, b];
      return call(app, cookie, 'POST', `/api/agents/${from.id}/messages`, {
        to_agent_id: to.id,
        text: `Parallel ${index}`,
        idempotency_key: randomUUID(),
      });
    }),
  );
  for (const res of results) assert.equal(res.statusCode, 201, res.body);
  const contexts = new Set(results.map((res) => res.json().message.context_id as string));
  assert.deepEqual([...contexts], [await pairId(a, b)]);
  const list = await conversations();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.message_count, 12);
});

test('a replay returns the original message with its original context_id', async (t) => {
  const { app, cookie, a, b, send, pairId } = await setup(t);
  const key = randomUUID();
  const body = { to_agent_id: b.id, text: 'Once', idempotency_key: key };
  const first = await call(app, cookie, 'POST', `/api/agents/${a.id}/messages`, body);
  assert.equal(first.statusCode, 201, first.body);
  // The pair moves on to another thread; the replay must not follow it.
  await send(a, { to_agent_id: b.id, text: 'Later', context_id: 'moved:on' });
  const replay = await call(app, cookie, 'POST', `/api/agents/${a.id}/messages`, body);
  assert.equal(replay.statusCode, 201, replay.body);
  assert.deepEqual(replay.json(), first.json());
  assert.equal(replay.json().message.context_id, await pairId(a, b));
});

test('the old derivable pair id means nothing: using it neither blocks nor joins the pair', async (t) => {
  const { a, b, c, send, pairId } = await setup(t);
  // C writes to B under the id #61 would have given the A–B pair, before A and B ever talk.
  const legacy = legacyPairContextId(a.id, b.id);
  await send(c, { to_agent_id: b.id, text: 'Squat', context_id: legacy });
  const first = await send(a, { to_agent_id: b.id, text: 'Hello B' });
  assert.notEqual(first.context_id, legacy);
  assert.equal(first.context_id, await pairId(a, b));
  const second = await send(b, { to_agent_id: a.id, text: 'Hi A' });
  assert.equal(second.context_id, first.context_id);
});

/** Adds `count` filler messages from a third agent to `recipient`'s inbox, directly in SQL. */
async function fill(app: App, recipient: Agent, count: number) {
  const db = app.city.db;
  const cursor = (
    await db.query<{ next_seq: number | string }>(
      'SELECT next_seq FROM inbox_cursors WHERE agent_id=$1',
      [recipient.id],
    )
  ).rows[0]!;
  const start = Number(cursor.next_seq);
  const owner = (
    await db.query<{ recipient_owner_id: string }>(
      'SELECT recipient_owner_id FROM messages WHERE recipient_id=$1 LIMIT 1',
      [recipient.id],
    )
  ).rows[0]!.recipient_owner_id;
  await db.query(
    `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,context_id,parts,created_at)
     SELECT $1, s, gen_random_uuid(), 'synthetic-filler', $2, $2, 'filler', '[{"type":"text","text":"filler"}]'::jsonb, 1
       FROM generate_series($3::bigint, $4::bigint) AS s`,
    [recipient.id, owner, start, start + count - 1],
  );
  // Acknowledged, so the inbox depth limit does not interfere; the lookback counts seqs only.
  await db.query(
    'UPDATE inbox_cursors SET next_seq=$2::bigint, acked_seq=$2::bigint - 1 WHERE agent_id=$1',
    [recipient.id, start + count],
  );
}

test('the lookback covers exactly the last 1,000 messages of each inbox', async (t) => {
  // Inside: the pair's topic message is the 1,000th newest in B's inbox, so A continues it.
  {
    const { app, a, b, send } = await setup(t);
    const topic = await send(a, { to_agent_id: b.id, text: 'Topic', context_id: 'topic:in' });
    await fill(app, b, 999);
    const next = await send(a, { to_agent_id: b.id, text: 'Continue' });
    assert.equal(next.context_id, topic.context_id, 'within the lookback');
  }
  // Just outside: one more message pushes it out, so A gets the pair's stored default instead.
  {
    const { app, a, b, send, pairId } = await setup(t);
    await send(a, { to_agent_id: b.id, text: 'Topic', context_id: 'topic:out' });
    await fill(app, b, 1000);
    const next = await send(a, { to_agent_id: b.id, text: 'Continue' });
    assert.notEqual(next.context_id, 'topic:out', 'outside the lookback');
    assert.equal(next.context_id, await pairId(a, b));
  }
});

/** Another owner (a second console account) with two connected agents, for outsider probes. */
async function outsider(app: App) {
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Outsider owner', password: 'Synthetic outsider password' }),
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const make = async (name: string) =>
    (
      (
        await call(app, cookie, 'POST', '/api/agents', {
          name,
          description: 'Synthetic outsider agent',
          capability: 'research',
          mode: 'external',
        })
      ).json() as { agent: Agent }
    ).agent;
  const p = await make('Probe P');
  const q = await make('Probe Q');
  const linked = await call(app, cookie, 'POST', '/api/connections', {
    fromAgentId: p.id,
    toAgentId: q.id,
  });
  assert.equal(linked.statusCode, 201, linked.body);
  /** What an outsider learns from one probe: the status and, on refusal, the error. */
  return async (contextId: string) => {
    const res = await call(app, cookie, 'POST', `/api/agents/${p.id}/messages`, {
      to_agent_id: q.id,
      text: 'Probe',
      context_id: contextId,
      idempotency_key: randomUUID(),
    });
    return res.statusCode === 201
      ? { status: 201 }
      : { status: res.statusCode, code: res.json().code, error: res.json().error };
  };
}

test('an outsider cannot tell whether two other agents have talked, including after remediation', async (t) => {
  const { app, a, b, c, send } = await setup(t);
  const probe = await outsider(app);
  // A and B talk (a stored random default); A and C never do.
  await send(a, { to_agent_id: b.id, text: 'Hello' });
  await send(b, { to_agent_id: a.id, text: 'Hi' });
  const talked = await probe(legacyPairContextId(a.id, b.id));
  const silent = await probe(legacyPairContextId(a.id, c.id));
  assert.deepEqual(talked, { status: 201 });
  assert.deepEqual(silent, talked, 'the old derivable ids reveal nothing');
  assert.deepEqual(await probe(randomUUID()), talked, 'the same as any fresh id');

  // A pair that talked while #61 was live sits under its derivable id (simulated here); an
  // outsider can see that (403) until the remediation moves it to the pair's random id.
  const { app: old, a: x, b: y, c: z, send: oldSend, pairId: oldPairId } = await setup(t);
  const oldProbe = await outsider(old);
  const legacy = legacyPairContextId(x.id, y.id);
  await oldSend(x, { to_agent_id: y.id, text: 'From #61 days, @Thread B', context_id: 'era:61' });
  await oldSend(y, { to_agent_id: x.id, text: 'Reply from #61 days', context_id: 'era:61' });
  await old.city.db.query("UPDATE mentions SET context_id=$1 WHERE context_id='era:61'", [legacy]);
  await old.city.db.query("UPDATE messages SET context_id=$1 WHERE context_id='era:61'", [legacy]);
  const leaked = await oldProbe(legacy);
  assert.equal(leaked.status, 403, 'the leak this remediation closes');
  const { remediatePairContexts } = await import('../scripts/remediate-pair-contexts.js');
  const counts = await remediatePairContexts(old.city.db, { confirm: true, since: 0 });
  assert.equal(counts.pairs, 1);
  assert.equal(counts.messages, 2);
  assert.deepEqual(await oldProbe(legacy), { status: 201 }, 'remediated: indistinguishable');
  assert.deepEqual(await oldProbe(legacyPairContextId(x.id, z.id)), { status: 201 });
  // The pair continues its (moved) thread under its stored random id, even when an agent still
  // passes the old id it remembered: that id is never written again, so the probe stays blind.
  const next = await oldSend(x, { to_agent_id: y.id, text: 'After remediation' });
  assert.equal(next.context_id, await oldPairId(x, y));
  assert.notEqual(next.context_id, legacy);
  const remembered = await oldSend(y, { to_agent_id: x.id, text: 'Old id', context_id: legacy });
  assert.equal(remembered.context_id, next.context_id);
  assert.deepEqual(await oldProbe(legacy), { status: 201 });
});

test('before remediation, sends never write the old derivable id; remediation then converges on one thread', async (t) => {
  // A pair whose older messages still sit under its derivable
  // id must not keep writing that id (omitted context_id, the remembered id, or a reply), so the
  // probe cannot grow and a send racing the remediation cannot leave a straggler under it.
  const { app, a: x, b: y, send, conversations, pairId } = await setup(t);
  const legacy = legacyPairContextId(x.id, y.id);
  const seeded = await send(x, { to_agent_id: y.id, text: 'From #61 days', context_id: 'era:61' });
  await send(y, { to_agent_id: x.id, text: 'Reply from #61 days', context_id: 'era:61' });
  await app.city.db.query("UPDATE messages SET context_id=$1 WHERE context_id='era:61'", [legacy]);
  const underLegacy = async () =>
    Number(
      (
        await app.city.db.query<{ n: number | string }>(
          'SELECT count(*) AS n FROM messages WHERE context_id=$1',
          [legacy],
        )
      ).rows[0]!.n,
    );

  const omitted = await send(x, { to_agent_id: y.id, text: 'No context, before remediation' });
  const remembered = await send(y, {
    to_agent_id: x.id,
    text: 'Remembered id',
    context_id: legacy,
  });
  const reply = await send(y, {
    to_agent_id: x.id,
    text: 'Reply to an old one',
    reply_to: seeded.id,
  });
  const stored = await pairId(x, y);
  assert.ok(stored, 'the pair got its stored random id');
  for (const message of [omitted, remembered, reply]) {
    assert.equal(message.context_id, stored);
    assert.notEqual(message.context_id, legacy);
  }
  assert.equal(reply.reply_to, seeded.id, 'reply_to is kept');
  assert.equal(await underLegacy(), 2, 'nothing new under the derivable id');

  // The remediation reuses the stored id, so old and new messages end in one conversation, and the
  // order of deploy and remediation does not matter.
  const { remediatePairContexts } = await import('../scripts/remediate-pair-contexts.js');
  const counts = await remediatePairContexts(app.city.db, { confirm: true, since: 0 });
  assert.equal(counts.pairs, 1);
  assert.equal(counts.messages, 2);
  assert.equal(await underLegacy(), 0);
  assert.equal(await pairId(x, y), stored, 'the stored id is unchanged');
  const list = await conversations();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.context_id, stored);
  assert.equal(list[0]!.message_count, 5);
});

/** Cross-owner helpers (AI-owned workspaces acting through workspace keys, as tests/cross-owner). */
function tool(app: App, key: string, name: string, args: unknown = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify(args),
  });
}
async function ok(app: App, key: string, name: string, args: unknown = {}) {
  const res = await tool(app, key, name, args);
  assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
  return res.json();
}
let addressCounter = 1;
async function workspace(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.7`,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().workspace_key as string;
}
async function hostedAgent(app: App, key: string, name: string) {
  const body = await ok(app, key, 'city_create_agent', {
    template: 'template:research-analyst@1.0.0',
    overrides: { metadata: { name } },
    idempotency_key: randomUUID(),
  });
  return body.agent.id as string;
}
async function connectAcross(app: App, fromKey: string, from: string, toKey: string, to: string) {
  const invite = (await ok(app, toKey, 'city_create_invite', { agent_id: to }))
    .invite_token as string;
  const requested = await ok(app, fromKey, 'city_request_connection', {
    from_agent_id: from,
    invite_token: invite,
    idempotency_key: randomUUID(),
  });
  await ok(app, toKey, 'city_decide_connection', {
    request_id: requested.request.id,
    decision: 'approve',
  });
}

test('a cross-owner pair continues one conversation in both directions', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const aKey = await workspace(app, 'Owner A');
  const bKey = await workspace(app, 'Owner B');
  const a1 = await hostedAgent(app, aKey, 'alpha');
  const b1 = await hostedAgent(app, bKey, 'bravo');
  await connectAcross(app, aKey, a1, bKey, b1);
  await connectAcross(app, bKey, b1, aKey, a1);
  const say = async (key: string, from: string, to: string, text: string) =>
    (
      await ok(app, key, 'city_send_message', {
        from_agent_id: from,
        to_agent_id: to,
        text,
        idempotency_key: randomUUID(),
      })
    ).message as AgentMessage;
  const first = await say(aKey, a1, b1, 'Hello across owners');
  const answer = await say(bKey, b1, a1, 'Hello back');
  const again = await say(aKey, a1, b1, 'Continuing');
  assert.equal(first.origin, 'external');
  assert.equal(answer.context_id, first.context_id);
  assert.equal(again.context_id, first.context_id);
  assert.equal(first.context_id, await storedPairId(app, a1, b1));
  assert.notEqual(first.context_id, legacyPairContextId(a1, b1));
});

test('agent_id narrows the list to that agent, so newer threads of other agents never push it out', async (t) => {
  const { app, cookie, a, b, c, send } = await setup(t);
  const old = await send(a, { to_agent_id: c.id, text: 'Older, with C' });
  await send(a, { to_agent_id: b.id, text: 'Newer, A and B only' });
  const list = async (query: string) => {
    const res = await call(app, cookie, 'GET', `/api/messages/conversations?${query}`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().conversations as ConversationSummary[];
  };
  // Without the filter the newest thread (A and B) fills a one-thread page.
  assert.notEqual((await list('limit=1'))[0]!.context_id, old.context_id);
  const forC = await list(`agent_id=${c.id}&limit=1`);
  assert.deepEqual(
    forC.map((item) => item.context_id),
    [old.context_id],
  );
  assert.equal(forC[0]!.message_count, 1, 'counts stay those of the whole thread');
  assert.equal((await list(`agent_id=${a.id}`)).length, 2);
  assert.deepEqual(await list(`agent_id=${randomUUID()}`), [], 'an unknown id matches nothing');
});

test('the thread list never aggregates the whole history: a busy thread does not hide older ones', async (t) => {
  const { app, cookie, a, b, c, send, conversations } = await setup(t);
  const older = await send(a, { to_agent_id: c.id, text: 'Older, with C' });
  const busy = await send(a, { to_agent_id: b.id, text: 'Busy, A and B' });
  // More traffic in the busy thread than the sent-row scan covers.
  await app.city.db.query(
    `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,
       context_id,reply_to,kind,parts,created_at,origin,sender_owner_label,room_id)
     SELECT recipient_id, seq + g, gen_random_uuid(), sender_id, sender_owner_id,
       recipient_owner_id, context_id, reply_to, kind, parts, created_at + g, origin,
       sender_owner_label, room_id
       FROM messages, generate_series(1, $2::int) AS g WHERE id=$1`,
    [busy.id, CONVERSATION_SEND_SCAN + 500],
  );
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
  const list = await conversations();
  db.transaction = transaction;
  assert.deepEqual(
    list.map((item) => item.context_id),
    [busy.context_id, older.context_id],
  );
  assert.equal(list[0]!.message_count, CONVERSATION_SEND_SCAN + 501);
  assert.equal(list[1]!.message_count, 1);
  // The per-thread aggregate (counts, participants) reads only the threads of the page.
  const aggregates = statements.filter(
    (sql) => sql.includes('jsonb_agg') && sql.includes('FROM messages'),
  );
  assert.ok(aggregates.length > 0, 'the list aggregated nothing');
  for (const sql of aggregates) assert.match(sql, /context_id = ANY\(\$2::text\[\]\)/);
});
