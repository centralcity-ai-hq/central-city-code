import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { signedHeaders } from '../connector/signing.js';
import { createApp } from '../server/app.js';
import { postgresDatabase } from '../server/database.js';
import { loadHostedConfig } from '../server/hosted.js';
import { findMentions, slugOf } from '../server/wake/mentions.js';
import {
  httpsWebhookTransport,
  validateWebhookUrl,
  verifyWebhook,
  type WebhookTransport,
} from '../server/wake/webhooks.js';
import { decodeCursor } from '../server/wake/routes.js';
import type { AssistantScope } from '../shared/assistant.js';
import type { WakeOptions } from '../server/wake/service.js';

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-test-only-rate-limit-secret-0000';

type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const PASSWORD = 'Synthetic wake owner password';
/** Acceptance: an idle agent is woken within 5 s. */
const WAKE_BUDGET_MS = 5000;

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, wake: WakeOptions = {}) {
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    // A 200 ms settle window keeps the suite's wake-latency assertions meaningful; the settle
    // behavior itself gets a dedicated test with a larger window.
    wake: { pollMs: 100, settleMs: 200, ...wake },
  });
  t.after(() => app.close());
  return app;
}
function http(
  app: App,
  cookie: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
let accounts = 0;
async function account(app: App, name = `Wake owner ${++accounts}`) {
  const res = await http(app, '', 'POST', '/api/auth/register', { name, password: PASSWORD });
  assert.equal(res.statusCode, 201, res.body);
  return `cc_session=${res.cookies.find((cookie) => cookie.name === 'cc_session')!.value}`;
}
async function agent(app: App, cookie: string, name: string) {
  const res = await http(app, cookie, 'POST', '/api/agents', {
    name,
    description: 'Synthetic wake agent',
    capability: 'research',
    mode: 'external',
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().agent.id as string;
}
async function connect(app: App, cookie: string, from: string, to: string) {
  const res = await http(app, cookie, 'POST', '/api/connections', {
    fromAgentId: from,
    toAgentId: to,
  });
  assert.equal(res.statusCode, 201, res.body);
}
async function grant(app: App, cookie: string, scopes: AssistantScope[]) {
  const res = await http(app, cookie, 'POST', '/api/assistant-access', {
    label: 'Synthetic wake client',
    scopes,
    expiresInDays: 1,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().token as string;
}
function tool(app: App, token: string, name: string, args: unknown) {
  return app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
    payload: JSON.stringify(args),
  });
}
const send = (app: App, cookie: string, from: string, to: string, text: string) =>
  http(app, cookie, 'POST', `/api/agents/${from}/messages`, {
    to_agent_id: to,
    text,
    idempotency_key: randomUUID(),
  });
/** Two agents of one owner, a -> b connected. */
async function pair(app: App) {
  const cookie = await account(app);
  const a = await agent(app, cookie, 'Alpha agent');
  const b = await agent(app, cookie, 'City Hall');
  await connect(app, cookie, a, b);
  return { cookie, a, b };
}
/** A room hosted by owner A's agent, joined by owner B's agent. */
async function roomScene(app: App) {
  const hostCookie = await account(app);
  const host = await agent(app, hostCookie, 'Host desk');
  const bystander = await agent(app, hostCookie, 'Scout');
  const memberCookie = await account(app);
  const member = await agent(app, memberCookie, 'Bravo');
  const created = await http(app, hostCookie, 'POST', '/api/rooms', {
    agent_id: host,
    name: 'Wake room',
    idempotency_key: randomUUID(),
  });
  assert.equal(created.statusCode, 201, created.body);
  const roomId = created.json().room.id as string;
  const joined = await http(app, memberCookie, 'POST', `/api/rooms/${roomId}/join`, {
    link: created.json().link.link,
    agent_id: member,
    idempotency_key: randomUUID(),
  });
  assert.equal(joined.statusCode, 200, joined.body);
  const post = (cookie: string, text: string, agentId?: string) =>
    http(app, cookie, 'POST', `/api/rooms/${roomId}/messages`, {
      text,
      idempotency_key: randomUUID(),
      ...(agentId ? { agent_id: agentId } : {}),
    });
  return { hostCookie, host, bystander, memberCookie, member, roomId, post };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('mention parsing: slugs, names, quotes, ids; ambiguity-safe, bounded and never self', () => {
  const desk = { id: '11111111-1111-4111-8111-111111111111', name: 'City Hall' };
  const city = { id: '22222222-2222-4222-8222-222222222222', name: 'City' };
  const twin1 = { id: '33333333-3333-4333-8333-333333333333', name: 'Scout' };
  const twin2 = { id: '44444444-4444-4444-8444-444444444444', name: 'scout' };
  assert.equal(slugOf('City Hall!'), 'city-hall');
  const all = [desk, city, twin1, twin2];
  assert.deepEqual(findMentions('ping @city-hall now', all).ids, [desk.id]);
  assert.deepEqual(findMentions('@City Hall: please look', all).ids, [desk.id], 'longest name');
  assert.deepEqual(findMentions('(@city) and @"City Hall"', all).ids, [city.id, desk.id]);
  assert.deepEqual(findMentions(`hi @${desk.id.toUpperCase()}`, all).ids, [desk.id]);
  assert.deepEqual(findMentions('mail pat@city-hall.example', all).ids, [], 'emails are not');
  assert.deepEqual(findMentions('@Cityscape is not @City', all).ids, [city.id], 'word boundary');
  const ambiguous = findMentions('@scout look', all);
  assert.deepEqual(ambiguous.ids, [], 'two agents named scout: neither is mentioned');
  assert.deepEqual(ambiguous.ambiguous, ['scout']);
  assert.deepEqual(findMentions('@city-hall hi', all, { exclude: desk.id }).ids, []);
  const many = Array.from({ length: 15 }, (_, index) => ({
    id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
    name: `Agent ${index}`,
  }));
  const text = many.map((item) => `@agent-${many.indexOf(item)}`).join(' ');
  assert.equal(findMentions(text, many).ids.length, 10, 'at most 10 agents per message');
});

test('direct-message mentions: recorded for the recipient only, listed, acknowledged', async (t) => {
  const app = await fixture(t);
  const { cookie, a, b } = await pair(app);
  const other = await agent(app, cookie, 'Beta agent');
  // Mentions a bystander (cannot read this DM) and the recipient.
  const sent = await send(app, cookie, a, b, 'Hey @beta-agent and @City Hall: review M3?');
  assert.equal(sent.statusCode, 201, sent.body);
  assert.equal(
    (await send(app, cookie, a, b, 'no mention, just mail x@city-hall')).statusCode,
    201,
  );
  const listed = await http(app, cookie, 'GET', `/api/agents/${b}/mentions`);
  assert.equal(listed.statusCode, 200, listed.body);
  const page = listed.json();
  assert.equal(page.mentions.length, 1);
  const [mention] = page.mentions;
  assert.equal(mention.source, 'message');
  assert.equal(mention.message_id, sent.json().message.id);
  assert.equal(mention.source_seq, 1);
  assert.equal(mention.from_agent_name, 'Alpha agent');
  assert.equal(mention.origin, 'internal');
  assert.match(mention.excerpt, /@City Hall/);
  assert.equal(page.unread, 1);
  const bystander = await http(app, cookie, 'GET', `/api/agents/${other}/mentions`);
  assert.deepEqual(bystander.json().mentions, [], 'a mention never grants access');
  const summary = await http(app, cookie, 'GET', '/api/mentions/summary');
  assert.deepEqual(summary.json().agents, [
    { agent_id: b, latest_seq: 1, acked_seq: 0, unread: 1 },
  ]);
  const ack = await http(app, cookie, 'POST', `/api/agents/${b}/mentions/ack`, { seq: 1 });
  assert.deepEqual(ack.json(), { agent_id: b, acked_seq: 1, latest_seq: 1, unread: 0 });
  assert.equal(
    (await http(app, cookie, 'POST', `/api/agents/${b}/mentions/ack`, { seq: 5 })).json().code,
    'ack_beyond_latest',
  );
  const after = await http(app, cookie, 'GET', `/api/agents/${b}/mentions?since=0`);
  assert.equal(after.json().mentions[0].read, true);

  // MCP: city_mentions and city_ack_mentions under a grant.
  const token = await grant(app, cookie, ['workspace:read', 'messages:read']);
  const viaTool = await tool(app, token, 'city_mentions', { agent_id: b, since: 0 });
  assert.equal(viaTool.statusCode, 200, viaTool.body);
  assert.equal(viaTool.json().mentions.length, 1);
  // Room-only authority does not see direct-message mentions.
  const roomsOnly = await grant(app, cookie, ['workspace:read', 'rooms:join']);
  const hidden = await tool(app, roomsOnly, 'city_mentions', { agent_id: b, since: 0 });
  assert.deepEqual(hidden.json().mentions, []);
});

test('room mentions: only active members that can read the post; removal hides them', async (t) => {
  const app = await fixture(t);
  const scene = await roomScene(app);
  // Scout (host's agent) is not a member; Bravo is. The host writes in its host AI's name
  // (without agent_id the post would be the host's own, as a person).
  const posted = await scene.post(
    scene.hostCookie,
    '@Bravo and @Scout: please check the plan',
    scene.host,
  );
  assert.equal(posted.statusCode, 201, posted.body);
  const bravo = await http(app, scene.memberCookie, 'GET', `/api/agents/${scene.member}/mentions`);
  assert.equal(bravo.json().mentions.length, 1);
  const mention = bravo.json().mentions[0];
  assert.equal(mention.source, 'room');
  assert.equal(mention.room_id, scene.roomId);
  assert.equal(mention.source_seq, posted.json().message.seq);
  assert.equal(mention.origin, 'external');
  assert.equal(mention.from_agent_name, 'Host desk');
  const scout = await http(app, scene.hostCookie, 'GET', `/api/agents/${scene.bystander}/mentions`);
  assert.deepEqual(scout.json().mentions, [], 'non-members are never mentioned');
  // Self-mention by the sender does not count.
  await scene.post(scene.memberCookie, 'I am @Bravo');
  assert.equal(
    (await http(app, scene.memberCookie, 'GET', `/api/agents/${scene.member}/mentions`)).json()
      .mentions.length,
    1,
  );
  // Another owner cannot list Bravo's mentions.
  const foreign = await http(app, scene.hostCookie, 'GET', `/api/agents/${scene.member}/mentions`);
  assert.equal(foreign.statusCode, 404);
  // After removal the room mention is no longer shown.
  const removed = await http(
    app,
    scene.hostCookie,
    'POST',
    `/api/rooms/${scene.roomId}/members/${scene.member}/remove`,
    {},
  );
  assert.equal(removed.statusCode, 200, removed.body);
  const gone = await http(app, scene.memberCookie, 'GET', `/api/agents/${scene.member}/mentions`);
  assert.deepEqual(gone.json().mentions, []);
});

test('long-poll wakes an idle inbox reader within 5 s and holds its answer until then', async (t) => {
  const app = await fixture(t);
  const { cookie, a, b } = await pair(app);
  const token = await grant(app, cookie, ['workspace:read', 'messages:read']);
  // Empty inbox and a short wait: empty page on timeout.
  const started = performance.now();
  const empty = await http(app, cookie, 'GET', `/api/agents/${b}/inbox?since=0&wait=1`);
  assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(empty.json().messages, []);
  assert.ok(performance.now() - started >= 900, 'waited for the timeout');

  // REST long-poll: woken by a send.
  const waiting = http(app, cookie, 'GET', `/api/agents/${b}/inbox?since=0&wait=20`);
  // MCP long-poll on the same inbox.
  const mcpWaiting = tool(app, token, 'city_read_inbox', { agent_id: b, wait: 20 });
  await sleep(400);
  const sentAt = performance.now();
  assert.equal((await send(app, cookie, a, b, 'Wake up')).statusCode, 201);
  const [rest, mcp] = await Promise.all([waiting, mcpWaiting]);
  const latency = performance.now() - sentAt;
  assert.equal(rest.json().messages[0].parts[0].text, 'Wake up');
  assert.equal(mcp.json().messages[0].parts[0].text, 'Wake up');
  assert.ok(latency < WAKE_BUDGET_MS, `long-poll wake latency ${latency.toFixed(0)} ms`);
  t.diagnostic(`long-poll wake latency (same instance): ${latency.toFixed(1)} ms`);

  // Data already present: no waiting at all.
  const quick = performance.now();
  const present = await http(app, cookie, 'GET', `/api/agents/${b}/inbox?since=0&wait=20`);
  assert.equal(present.json().messages.length, 1);
  assert.ok(performance.now() - quick < 1000);
  assert.equal(
    (await http(app, cookie, 'GET', `/api/agents/${b}/inbox?wait=26`)).statusCode,
    400,
    'wait is capped at 25 s',
  );
});

test('a woken tool wait collects a burst into one answer; browser reads answer at once', async (t) => {
  const app = await fixture(t, { settleMs: 1500 });
  const { cookie, a, b } = await pair(app);
  const token = await grant(app, cookie, ['workspace:read', 'messages:read']);
  const rest = http(app, cookie, 'GET', `/api/agents/${b}/inbox?since=0&wait=20`);
  const mcp = tool(app, token, 'city_read_inbox', { agent_id: b, wait: 20 });
  await sleep(400);
  const sentAt = performance.now();
  assert.equal((await send(app, cookie, a, b, 'burst 1')).statusCode, 201);
  await sleep(500);
  assert.equal((await send(app, cookie, a, b, 'burst 2')).statusCode, 201);
  const [restPage, mcpPage] = await Promise.all([rest, mcp]);
  const mcpLatency = performance.now() - sentAt;
  type Row = { parts: { text: string }[] };
  assert.deepEqual(
    restPage.json().messages.map((m: Row) => m.parts[0]!.text),
    ['burst 1'],
    'the browser read answered at once with the first message only',
  );
  assert.deepEqual(
    mcpPage.json().messages.map((m: Row) => m.parts[0]!.text),
    ['burst 1', 'burst 2'],
    'the tool wait collected the burst into one page (one client turn)',
  );
  assert.ok(
    mcpLatency >= 1400 && mcpLatency < WAKE_BUDGET_MS,
    `the tool answer waited out the settle window (${mcpLatency.toFixed(0)} ms)`,
  );
});

test('waiting tool reads are capped per agent, beside the per-owner budget', async (t) => {
  const app = await fixture(t, { rateLimits: { waitsPerMinutePerAgent: 2 } });
  const { cookie, a, b } = await pair(app);
  const token = await grant(app, cookie, ['workspace:read', 'messages:read']);
  // Only waits that find nothing new are charged (a wait that answers news must never 429
  // after the read advanced the caller's cursor, or the messages would be lost). News
  // deliveries arrive via a woken 25 s wait (no settle window here); the empty waits are 1 s,
  // so the 60 s bucket window (started by the first charge) is always open at the cap.
  assert.equal(
    (await tool(app, token, 'city_read_inbox', { agent_id: b, wait: 1 })).statusCode,
    200,
    'the first empty wait',
  );
  assert.equal((await send(app, cookie, a, b, 'one')).statusCode, 201);
  const first = await tool(app, token, 'city_read_inbox', { agent_id: b, wait: 25 });
  assert.equal(first.statusCode, 200, 'a wait that answers news is not charged');
  // A tool read starts after the acknowledged seq and does not ack by itself: without an
  // explicit city_ack_inbox the delivered message is returned again, so the next wait would
  // find news and never be charged.
  assert.equal(
    (await tool(app, token, 'city_ack_inbox', { agent_id: b, seq: first.json().next_since }))
      .statusCode,
    200,
  );
  assert.equal(
    (await tool(app, token, 'city_read_inbox', { agent_id: b, wait: 1 })).statusCode,
    200,
    'the second empty wait',
  );
  // Two charges are spent; a new message is still delivered (a charge never precedes
  // delivery), and only the next empty wait 429s.
  assert.equal((await send(app, cookie, a, b, 'two')).statusCode, 201);
  const delivered = await tool(app, token, 'city_read_inbox', { agent_id: b, wait: 25 });
  assert.equal(delivered.statusCode, 200, 'news is delivered over charged waits');
  assert.equal(
    (await tool(app, token, 'city_ack_inbox', { agent_id: b, seq: delivered.json().next_since }))
      .statusCode,
    200,
  );
  const capped = await tool(app, token, 'city_read_inbox', { agent_id: b, wait: 1 });
  assert.equal(capped.statusCode, 429, 'the third empty waiting read of this agent in a minute');
  assert.match(capped.body, /stop polling/i, 'the 429 tells the looping client to stop');
  assert.ok(capped.headers['retry-after'], 'the 429 carries a retry-after');
  // A 429 lands before any read, so a capped wait can never lose messages; a read without a
  // wait still fetches them.
  assert.equal(
    (await tool(app, token, 'city_read_inbox', { agent_id: b })).statusCode,
    200,
    'reads without wait are not charged',
  );
  // REST waits answer per message: they stay on the owner budget, no per-agent cap.
  const rest = await fixture(t, { rateLimits: { waitsPerMinutePerAgent: 2 } });
  const third = await pair(rest);
  for (let index = 0; index < 4; index++)
    assert.equal(
      (await http(rest, third.cookie, 'GET', `/api/agents/${third.b}/inbox?since=0&wait=1`))
        .statusCode,
      200,
      'REST waits are not charged the agent bucket',
    );
  // Another agent of the same owner has its own bucket; inbox and mentions waits share it.
  // With a per-agent cap of 1 the two empty waits are one charge each — no 60 s window race.
  const solo = await fixture(t, { rateLimits: { waitsPerMinutePerAgent: 1 } });
  const second = await pair(solo);
  const soloToken = await grant(solo, second.cookie, ['workspace:read', 'messages:read']);
  assert.equal(
    (await tool(solo, soloToken, 'city_read_inbox', { agent_id: second.a, wait: 1 })).statusCode,
    200,
    'an empty wait on the other agent: its own bucket',
  );
  assert.equal(
    (await tool(solo, soloToken, 'city_mentions', { agent_id: second.a, wait: 1 })).statusCode,
    429,
    'inbox and mentions tool waits share the agent bucket',
  );
});

test('a denied wait never spends the agent bucket: the charge follows the permission check', async (t) => {
  const app = await fixture(t, { rateLimits: { waitsPerMinutePerAgent: 2 } });
  const { cookie, b } = await pair(app);
  // A stranger's connector loops a waiting read of an agent it cannot see: every read 404s.
  const strangerCookie = await account(app);
  const strangerToken = await grant(app, strangerCookie, ['workspace:read', 'messages:read']);
  for (let index = 0; index < 4; index++)
    assert.equal(
      (await tool(app, strangerToken, 'city_read_inbox', { agent_id: b, wait: 1 })).statusCode,
      404,
      'no access, no answer',
    );
  // The victim's bucket is untouched: the owner's own client still gets its full budget.
  const token = await grant(app, cookie, ['workspace:read', 'messages:read']);
  for (let index = 0; index < 2; index++)
    assert.equal(
      (await tool(app, token, 'city_read_inbox', { agent_id: b, wait: 1 })).statusCode,
      200,
      "the stranger's denied waits did not burn the agent's budget",
    );
  // (Asserting the cap itself here would race the bucket's 60 s wall-clock window; the
  // per-agent cap is pinned by the test above on an agent with a fresh bucket.)
});

test('waiting room reads are capped per connector grant and room', async (t) => {
  const app = await fixture(t, { rateLimits: { waitsPerMinutePerAgent: 2 } });
  const { hostCookie, host, memberCookie, member, roomId, post } = await roomScene(app);
  const token = await grant(app, memberCookie, ['workspace:read', 'rooms:join']);
  const read = (room: string, wait = 1) =>
    tool(app, token, 'city_room_read', { room_id: room, wait });
  assert.equal((await read(roomId)).statusCode, 200, 'the first read marks the join news read');
  // The two empty waits each charge once: after the second, a new post is still delivered
  // (a charge never precedes delivery), and only then is the bucket spent.
  assert.equal((await read(roomId)).statusCode, 200, 'first empty wait');
  assert.equal((await read(roomId)).statusCode, 200, 'second empty wait');
  assert.equal((await post(hostCookie, 'while charged')).statusCode, 201);
  assert.equal((await read(roomId)).statusCode, 200, 'news is delivered over charged waits');
  assert.equal(
    (await read(roomId)).statusCode,
    429,
    'the third empty waiting read of one room in a minute',
  );
  // A second room of the same connector has its own bucket.
  const second = await http(app, hostCookie, 'POST', '/api/rooms', {
    agent_id: host,
    name: 'Second wake room',
    idempotency_key: randomUUID(),
  });
  assert.equal(second.statusCode, 201, second.body);
  const joined = await http(app, memberCookie, 'POST', `/api/rooms/${second.json().room.id}/join`, {
    link: second.json().link.link,
    agent_id: member,
    idempotency_key: randomUUID(),
  });
  assert.equal(joined.statusCode, 200, joined.body);
  assert.equal(
    (await read(second.json().room.id)).statusCode,
    200,
    'one connector may poll its rooms in parallel',
  );
});

test('the batched cursor poll wakes waiters when the write came from another instance', async (t) => {
  const app = await fixture(t, { pollMs: 200 });
  const { cookie, a, b } = await pair(app);
  assert.equal((await send(app, cookie, a, b, 'first')).statusCode, 201);
  const waiting = http(app, cookie, 'GET', `/api/agents/${b}/inbox?since=1&wait=20`);
  await sleep(300);
  // Simulate another instance: write directly, with no in-process after-commit signal.
  const wroteAt = performance.now();
  await app.city.db.transaction(async (tx) => {
    const seq = Number(
      (
        await tx.query<{ seq: number }>(
          'UPDATE inbox_cursors SET next_seq=next_seq+1 WHERE agent_id=$1 RETURNING next_seq-1 AS seq',
          [b],
        )
      ).rows[0]!.seq,
    );
    const owner = (
      await tx.query<{ operator_id: string }>(
        "SELECT operator_id FROM workspaces WHERE data->'agents' @> $1::jsonb",
        [JSON.stringify([{ id: b }])],
      )
    ).rows[0]!.operator_id;
    await tx.query(
      `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,context_id,kind,parts,created_at)
       VALUES($1,$2,$3,$4,$5,$5,$6,'message',$7::jsonb,$8)`,
      [
        b,
        seq,
        randomUUID(),
        a,
        owner,
        'other-instance',
        '[{"type":"text","text":"remote"}]',
        Date.now(),
      ],
    );
  });
  const res = await waiting;
  const latency = performance.now() - wroteAt;
  assert.equal(res.json().messages[0].parts[0].text, 'remote');
  assert.ok(latency < WAKE_BUDGET_MS, `cross-instance latency ${latency.toFixed(0)} ms`);
  t.diagnostic(`long-poll wake latency via 200 ms batched poll: ${latency.toFixed(1)} ms`);
});

test('room and mention long-polls: REST, city_room_read and city_mentions wake within 5 s', async (t) => {
  const app = await fixture(t);
  const scene = await roomScene(app);
  const token = await grant(app, scene.memberCookie, ['workspace:read', 'rooms:join']);
  // The first city_room_read carries the handoff brief (docs/ROOMS.md) and a long-poll would
  // answer at once with it: a plain read consumes it, and it is delivered only once.
  const first = await tool(app, token, 'city_room_read', { room_id: scene.roomId });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(typeof first.json().handoff_brief, 'string');
  const second = await tool(app, token, 'city_room_read', { room_id: scene.roomId });
  assert.equal(second.json().handoff_brief, undefined, 'the brief is delivered once');
  const roomRest = http(
    app,
    scene.memberCookie,
    'GET',
    `/api/rooms/${scene.roomId}/messages?since=0&wait=20`,
  );
  const roomTool = tool(app, token, 'city_room_read', { room_id: scene.roomId, wait: 20 });
  const mentionTool = tool(app, token, 'city_mentions', { agent_id: scene.member, wait: 20 });
  await sleep(400);
  const postedAt = performance.now();
  assert.equal((await scene.post(scene.hostCookie, 'Heads up @bravo')).statusCode, 201);
  const [rest, read, mentions] = await Promise.all([roomRest, roomTool, mentionTool]);
  const latency = performance.now() - postedAt;
  assert.equal(rest.statusCode, 200, rest.body);
  assert.equal(rest.json().messages.at(-1).text, 'Heads up @bravo');
  assert.equal(read.json().messages.at(-1).text, 'Heads up @bravo');
  assert.equal(read.json().handoff_brief, undefined, 'the woken read has no second brief');
  assert.equal(mentions.json().mentions[0].excerpt, 'Heads up @bravo');
  assert.ok(latency < WAKE_BUDGET_MS, `room wake latency ${latency.toFixed(0)} ms`);
  t.diagnostic(`room + mention long-poll wake latency: ${latency.toFixed(1)} ms`);
  // A non-member cannot use wait to observe the room.
  const outsider = await account(app);
  const probe = await http(app, outsider, 'GET', `/api/rooms/${scene.roomId}/messages?wait=1`);
  assert.equal(probe.statusCode, 404);
});

test('a first waiting city_room_read with an undelivered handoff brief answers at once with it', async (t) => {
  const app = await fixture(t);
  const scene = await roomScene(app);
  const token = await grant(app, scene.memberCookie, ['workspace:read', 'rooms:join']);
  const startedAt = performance.now();
  const read = await tool(app, token, 'city_room_read', { room_id: scene.roomId, wait: 20 });
  const elapsed = performance.now() - startedAt;
  assert.equal(read.statusCode, 200, read.body);
  assert.match(read.json().handoff_brief, /handoff brief/);
  assert.ok(elapsed < WAKE_BUDGET_MS, `brief long-poll answered after ${elapsed.toFixed(0)} ms`);
});

/** Reads Server-Sent Events from a fetch response body. */
function sseReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: Array<{ id?: string; event: string; data: any; at: number }> = [];
  let comments = 0;
  let closed = false;
  const done = (async () => {
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const entry: { id?: string; event: string; data: any; at: number } = {
          event: 'message',
          data: null,
          at: performance.now(),
        };
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) comments++;
          else if (line.startsWith('id: ')) entry.id = line.slice(4);
          else if (line.startsWith('event: ')) entry.event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (data) {
          entry.data = JSON.parse(data);
          events.push(entry);
        }
      }
    }
    closed = true;
  })();
  return {
    events,
    get comments() {
      return comments;
    },
    get closed() {
      return closed;
    },
    done,
    async next(event: string, after = 0) {
      const deadline = performance.now() + 10_000;
      for (;;) {
        const found = events.find((item) => item.event === event && item.at >= after);
        if (found) return found;
        if (closed || performance.now() > deadline) throw new Error(`no ${event} event`);
        await sleep(10);
      }
    },
    cancel: () => reader.cancel(),
  };
}

test('SSE stream: messages, mentions and room posts arrive within 5 s; heartbeat, self-close, resume', async (t) => {
  const app = await fixture(t, { streamMs: 3500, heartbeatMs: 700 });
  const scene = await roomScene(app);
  // A sender with a connection to the member (same owner as the member).
  const sender = await agent(app, scene.memberCookie, 'Planner');
  await connect(app, scene.memberCookie, sender, scene.member);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const open = (headers: Record<string, string> = {}) =>
    fetch(`${base}/api/v2/stream?agent=${scene.member}`, {
      headers: { cookie: scene.memberCookie, ...headers },
    });
  const res = await open();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
  const stream = sseReader(res.body!);
  const ready = await stream.next('ready');
  assert.deepEqual(ready.data.events, ['message', 'mention', 'room_post']);

  const sentAt = performance.now();
  assert.equal(
    (await send(app, scene.memberCookie, sender, scene.member, 'Stream me @bravo')).statusCode,
    201,
  );
  const message = await stream.next('message', sentAt);
  const mention = await stream.next('mention', sentAt);
  assert.equal(message.data.parts[0].text, 'Stream me @bravo');
  assert.equal(mention.data.source, 'message');
  const postedAt = performance.now();
  assert.equal((await scene.post(scene.hostCookie, 'Room news')).statusCode, 201);
  const post = await stream.next('room_post', postedAt);
  assert.equal(post.data.text, 'Room news');
  const latencies = [message.at - sentAt, mention.at - sentAt, post.at - postedAt];
  for (const latency of latencies) assert.ok(latency < WAKE_BUDGET_MS, `SSE latency ${latency}`);
  t.diagnostic(`SSE wake latencies (ms): ${latencies.map((value) => value.toFixed(1)).join(', ')}`);
  // Own posts do not wake the agent.
  await scene.post(scene.memberCookie, 'my own post');

  await stream.done;
  assert.ok(stream.comments >= 1, 'heartbeat comments while idle');
  const close = stream.events.at(-1)!;
  assert.equal(close.event, 'close');
  assert.equal(close.data.resume, true);
  assert.ok(!stream.events.some((item) => item.data?.text === 'my own post'));

  // Resume with Last-Event-ID: only what happened after the stream closed.
  const cursor = decodeCursor(close.id);
  assert.ok(cursor && cursor.i === 1 && cursor.m === 1);
  assert.equal(
    (await send(app, scene.memberCookie, sender, scene.member, 'while away')).statusCode,
    201,
  );
  const resumed = sseReader((await open({ 'last-event-id': close.id! })).body!);
  const missed = await resumed.next('message');
  assert.equal(missed.data.parts[0].text, 'while away');
  assert.equal(resumed.events.filter((item) => item.event === 'message').length, 1);
  await resumed.cancel();

  // Authentication and limits.
  const anonymous = await fetch(`${base}/api/v2/stream?agent=${scene.member}`);
  assert.equal(anonymous.status, 401);
  const foreign = await fetch(`${base}/api/v2/stream?agent=${scene.member}`, {
    headers: { cookie: scene.hostCookie },
  });
  assert.equal(foreign.status, 404);
  const first = await open();
  const second = await open();
  const third = await open();
  assert.equal(third.status, 429, 'at most two streams per agent');
  await first.body!.cancel();
  await second.body!.cancel();
});

test('SSE stream under a grant: scopes select events and a bearer without read scopes is refused', async (t) => {
  const app = await fixture(t, { streamMs: 2000, heartbeatMs: 500 });
  const scene = await roomScene(app);
  const roomsOnly = await grant(app, scene.memberCookie, ['workspace:read', 'rooms:join']);
  const readOnly = await grant(app, scene.memberCookie, ['workspace:read']);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const refused = await fetch(`${base}/api/v2/stream?agent=${scene.member}`, {
    headers: { authorization: `Bearer ${readOnly}` },
  });
  assert.equal(refused.status, 403);
  const res = await fetch(`${base}/api/v2/stream?agent=${scene.member}`, {
    headers: { authorization: `Bearer ${roomsOnly}` },
  });
  assert.equal(res.status, 200);
  const stream = sseReader(res.body!);
  assert.deepEqual((await stream.next('ready')).data.events, ['mention', 'room_post']);
  const at = performance.now();
  await scene.post(scene.hostCookie, 'granted @Bravo');
  assert.equal((await stream.next('room_post', at)).data.text, 'granted @Bravo');
  assert.equal((await stream.next('mention', at)).data.source, 'room');
  await stream.cancel();
});

test('SSE stream for a signed runtime: its own agent only, and a bad signature never falls back to a grant', async (t) => {
  const app = await fixture(t, { streamMs: 2000, heartbeatMs: 500 });
  const cookie = await account(app);
  const created = await http(app, cookie, 'POST', '/api/agents', {
    name: 'Runtime reader',
    description: 'Synthetic wake agent',
    capability: 'research',
    mode: 'external',
  });
  assert.equal(created.statusCode, 201, created.body);
  const { agent: self, token } = created.json() as { agent: { id: string }; token: string };
  const other = await agent(app, cookie, 'Other desk');
  const owned = await grant(app, cookie, ['workspace:read', 'messages:read']);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const signed = (url: string, credential = token) =>
    fetch(base + url, { headers: signedHeaders(credential, 'GET', url, '') });
  const res = await signed(`/api/v2/stream?agent=${self.id}`);
  assert.equal(res.status, 200);
  const stream = sseReader(res.body!);
  assert.deepEqual((await stream.next('ready')).data.events, ['message', 'mention', 'room_post']);
  await stream.cancel();
  const foreign = await signed(`/api/v2/stream?agent=${other}`);
  assert.equal(foreign.status, 403, 'a runtime may only stream its own agent');
  // A valid grant token with a forged signature is refused, not treated as a bearer grant.
  const forged = await fetch(`${base}/api/v2/stream?agent=${self.id}`, {
    headers: { ...signedHeaders(token, 'GET', '/other', ''), authorization: `Bearer ${owned}` },
  });
  assert.equal(forged.status, 401);
  // The runtime's own token with a bad signature is refused, and a signed URL cannot be replayed.
  const badSignature = await fetch(`${base}/api/v2/stream?agent=${self.id}`, {
    headers: signedHeaders(token, 'GET', `/api/v2/stream?agent=${other}`, ''),
  });
  assert.equal(badSignature.status, 401);
  const url = `/api/v2/stream?agent=${self.id}`;
  const headers = signedHeaders(token, 'GET', url, '');
  const once = await fetch(base + url, { headers });
  assert.equal(once.status, 200);
  await once.body!.cancel();
  const replayed = await fetch(base + url, { headers });
  assert.equal(replayed.status, 409);
});

test('webhooks: pending wake-ups of disabled webhooks never block live ones', async (t) => {
  const calls: string[] = [];
  const transport: WebhookTransport = async (url) => {
    calls.push(url);
    return { status: 204 };
  };
  const app = await fixture(t, { transport });
  const { cookie, a, b } = await pair(app);
  const key = await grant(app, cookie, ['workspace:read', 'agents:wake']);
  const set = await tool(app, key, 'city_set_wake_webhook', {
    agent_id: b,
    url: 'https://hooks.example.com/live',
  });
  assert.equal(set.statusCode, 200, set.body);
  // 25 disabled webhooks with overdue wake-ups, older than anything live: more than one claim window.
  const owner = (
    await app.city.db.query<{ owner_id: string }>('SELECT owner_id FROM wake_webhooks')
  ).rows[0]!.owner_id;
  const old = Date.now() - 60_000;
  for (let i = 0; i < 25; i++) {
    const id = `whk_disabled_${String(i).padStart(2, '0')}`;
    await app.city.db.query(
      `INSERT INTO wake_webhooks(id,agent_id,owner_id,url,events,salt,created_at,created_by,disabled_at)
       VALUES ($1,$2,$3,'https://hooks.example.com/dead',ARRAY['message'],'salt',$4,'test',$4)`,
      [id, `agent-disabled-${i}`, owner, old],
    );
    await app.city.db.query(
      `INSERT INTO wake_outbox(webhook_id,agent_id,kinds,event,pending,version,attempts,first_at,next_attempt_at)
       VALUES ($1,$2,ARRAY['message'],'{}'::jsonb,1,1,1,$3,$3)`,
      [id, `agent-disabled-${i}`, old],
    );
  }
  const sent = await send(app, cookie, a, b, 'Live despite dead webhooks');
  assert.equal(sent.statusCode, 201);
  const deadline = performance.now() + WAKE_BUDGET_MS;
  while (!calls.length && performance.now() < deadline) await sleep(10);
  assert.deepEqual(calls, ['https://hooks.example.com/live'], 'the live webhook is delivered');
});

test('webhooks: signed POST within 5 s, coalesced, retried with backoff; SSRF rules', async (t) => {
  const calls: Array<{ url: string; body: string; headers: Record<string, string>; at: number }> =
    [];
  let fail = 0;
  const transport: WebhookTransport = async (url, body, headers) => {
    calls.push({ url, body, headers, at: performance.now() });
    if (fail > 0) {
      fail--;
      return { status: 503 };
    }
    return { status: 204 };
  };
  const app = await fixture(t, { transport });
  const { cookie, a, b } = await pair(app);
  const key = await grant(app, cookie, ['workspace:read', 'agents:wake']);
  const noScope = await grant(app, cookie, ['workspace:read', 'messages:read']);
  const denied = await tool(app, noScope, 'city_set_wake_webhook', {
    agent_id: b,
    url: 'https://hooks.example.com/wake',
  });
  assert.equal(denied.statusCode, 403);
  for (const url of [
    'http://hooks.example.com/wake',
    'https://127.0.0.1/wake',
    'https://10.1.2.3/wake',
    'https://[::1]/wake',
    'https://localhost/wake',
    'https://hooks.example.com:8443/wake',
    'https://user:pw@hooks.example.com/wake',
    'https://printer.local/wake',
  ]) {
    const res = await tool(app, key, 'city_set_wake_webhook', { agent_id: b, url });
    assert.equal(res.statusCode, 400, url);
    assert.equal(res.json().code, 'invalid_webhook_url', url);
  }
  const set = await tool(app, key, 'city_set_wake_webhook', {
    agent_id: b,
    url: 'https://hooks.example.com/wake',
    events: ['message', 'mention'],
  });
  assert.equal(set.statusCode, 200, set.body);
  const { secret, webhook } = set.json();
  assert.match(secret, /^whsec_[A-Za-z0-9+/]{43}=$/);
  assert.equal(webhook.url, 'https://hooks.example.com/wake');
  const status = await http(app, cookie, 'GET', `/api/agents/${b}/wake-webhook`);
  assert.equal(status.json().webhook.url, webhook.url);
  assert.ok(!status.body.includes(secret), 'the secret is shown once');
  const stored = await app.city.db.query('SELECT * FROM wake_webhooks');
  assert.ok(!JSON.stringify(stored.rows).includes(secret.slice(6)), 'never stored');

  const sentAt = performance.now();
  const sent = await send(app, cookie, a, b, 'Webhook @city-hall');
  assert.equal(sent.statusCode, 201);
  const deadline = performance.now() + WAKE_BUDGET_MS;
  while (!calls.length && performance.now() < deadline) await sleep(10);
  assert.equal(calls.length, 1, 'one signed POST');
  const call = calls[0]!;
  const latency = call.at - sentAt;
  assert.ok(latency < WAKE_BUDGET_MS, `webhook dispatch latency ${latency}`);
  t.diagnostic(`webhook dispatch latency: ${latency.toFixed(1)} ms`);
  assert.equal(call.url, 'https://hooks.example.com/wake');
  assert.ok(verifyWebhook(secret, call.headers, call.body), 'valid Standard Webhooks signature');
  assert.ok(!verifyWebhook(secret, call.headers, call.body.replace('city.wake', 'city.wakf')));
  assert.ok(
    !verifyWebhook(
      secret,
      call.headers,
      call.body,
      Number(call.headers['webhook-timestamp']) + 301,
    ),
    'replay window',
  );
  const payload = JSON.parse(call.body);
  assert.equal(payload.type, 'city.wake');
  assert.equal(payload.agent_id, b);
  assert.deepEqual(payload.kinds, ['mention', 'message']);
  assert.equal(payload.latest.message_id, sent.json().message.id);
  assert.ok(!call.body.includes('Webhook @city-hall'), 'no message contents');

  // Failure then success: retried after the 2 s backoff, within the drain window.
  fail = 1;
  calls.length = 0;
  assert.equal((await send(app, cookie, a, b, 'again')).statusCode, 201);
  const retryDeadline = performance.now() + 8000;
  while (calls.length < 2 && performance.now() < retryDeadline) await sleep(20);
  assert.equal(calls.length, 2, 'failed once, delivered on retry');
  assert.ok(calls[1]!.at - calls[0]!.at >= 1500, 'backoff before the retry');
  assert.equal(calls[1]!.headers['webhook-id'], calls[0]!.headers['webhook-id']);
  const after = (await http(app, cookie, 'GET', `/api/agents/${b}/wake-webhook`)).json().webhook;
  assert.equal(after.last_status, '204');
  assert.equal((await app.city.db.query('SELECT * FROM wake_outbox')).rows.length, 0);

  const cleared = await tool(app, key, 'city_clear_wake_webhook', { agent_id: b });
  assert.deepEqual(cleared.json(), { agent_id: b, cleared: true });
  calls.length = 0;
  await send(app, cookie, a, b, 'no webhook now');
  await sleep(300);
  assert.equal(calls.length, 0);
});

test('review 1: waits and stream opens are charged per owner in the shared limiter', async (t) => {
  const app = await fixture(t, {
    rateLimits: { waitsPerMinute: 2, streamOpensPerMinute: 1 },
    streamMs: 300,
  });
  const { cookie, a, b } = await pair(app);
  // A wait that answers news is never charged (the read advanced the caller's cursor, so a
  // 429 there would lose the messages it just marked read).
  assert.equal((await send(app, cookie, a, b, 'news')).statusCode, 201);
  assert.equal(
    (await http(app, cookie, 'GET', `/api/agents/${b}/inbox?since=0&wait=25`)).statusCode,
    200,
    'a wait with news is not charged',
  );
  // The charges come from empty waits. b's inbox now has history, and a REST inbox read
  // returns its latest page (read or not), so it never finds that inbox empty again; a's
  // inbox is empty and stays empty.
  assert.equal(
    (await http(app, cookie, 'GET', `/api/agents/${a}/inbox?since=0&wait=1`)).statusCode,
    200,
    'first empty wait',
  );
  assert.equal(
    (await http(app, cookie, 'GET', `/api/agents/${a}/inbox?since=0&wait=1`)).statusCode,
    200,
    'second empty wait',
  );
  // Two owner charges are spent; a new mention is still delivered (a charge never precedes
  // delivery), and only the next empty wait 429s.
  assert.equal((await send(app, cookie, a, b, 'ping @City Hall')).statusCode, 201);
  assert.equal(
    (await http(app, cookie, 'GET', `/api/agents/${b}/mentions?wait=25`)).statusCode,
    200,
    'news is delivered over charged waits',
  );
  const limited = await http(app, cookie, 'GET', `/api/agents/${a}/mentions?wait=1`);
  assert.equal(limited.statusCode, 429, 'third empty waiting read of this owner');
  assert.equal(
    (await http(app, cookie, 'GET', `/api/agents/${b}/inbox?since=0`)).statusCode,
    200,
    'reads without wait are not charged',
  );
  // The owner-cookie stream path is charged too.
  const first = await http(app, cookie, 'GET', `/api/v2/stream?agent=${b}`);
  assert.equal(first.statusCode, 200);
  const second = await http(app, cookie, 'GET', `/api/v2/stream?agent=${b}`);
  assert.equal(second.statusCode, 429);
});

test('review 1b: waiting reads are also charged per source address', async (t) => {
  // The owner and the source-address buckets share the configured per-minute budget, and an
  // address collects the charges of every owner behind it.
  const app = await fixture(t, { rateLimits: { waitsPerMinute: 2 } });
  // The first owner spends its two waits from the default address (127.0.0.1): its owner
  // bucket and the address bucket are both spent. (A wait that answers news is never charged;
  // that is pinned by review 1 above — these inboxes are empty and stay empty.)
  const first = await pair(app);
  assert.equal(
    (await http(app, first.cookie, 'GET', `/api/agents/${first.b}/inbox?since=0&wait=1`))
      .statusCode,
    200,
    'first empty wait charged',
  );
  assert.equal(
    (await http(app, first.cookie, 'GET', `/api/agents/${first.b}/inbox?since=0&wait=1`))
      .statusCode,
    200,
    'second empty wait charged',
  );
  // A second owner behind the same address has a fresh owner budget, but the address budget
  // is spent; from a fresh address it gets its full budget.
  const other = await pair(app);
  const from = (remoteAddress: string) =>
    app.inject({
      method: 'GET',
      url: `/api/agents/${other.b}/inbox?since=0&wait=1`,
      headers: { ...jsonHeaders, cookie: other.cookie },
      remoteAddress,
    });
  assert.equal((await from('127.0.0.1')).statusCode, 429, 'same source address');
  assert.equal((await from('198.51.100.7')).statusCode, 200, 'own owner budget, new address');
});

test('review 3: acknowledging needs a read scope and never skips unseen mentions', async (t) => {
  const app = await fixture(t);
  const scene = await roomScene(app);
  const planner = await agent(app, scene.memberCookie, 'Planner');
  await connect(app, scene.memberCookie, planner, scene.member);
  // Mention 1: a direct message; mention 2: a room post.
  assert.equal(
    (await send(app, scene.memberCookie, planner, scene.member, 'DM for @bravo')).statusCode,
    201,
  );
  assert.equal((await scene.post(scene.hostCookie, 'Room ping @bravo')).statusCode, 201);
  const readOnly = await grant(app, scene.memberCookie, ['workspace:read']);
  const refused = await tool(app, readOnly, 'city_ack_mentions', {
    agent_id: scene.member,
    seq: 2,
  });
  assert.equal(refused.statusCode, 403);
  const roomsOnly = await grant(app, scene.memberCookie, ['workspace:read', 'rooms:join']);
  const ack = await tool(app, roomsOnly, 'city_ack_mentions', { agent_id: scene.member, seq: 2 });
  assert.equal(ack.statusCode, 200, ack.body);
  assert.equal(ack.json().acked_seq, 0, 'the cursor stops before the unseen DM mention');
  assert.equal(ack.json().unread, 0, 'everything this grant can see is read');
  const owner = (
    await http(app, scene.memberCookie, 'GET', `/api/agents/${scene.member}/mentions`)
  ).json();
  assert.deepEqual(
    owner.mentions.map((item: { source: string; read: boolean }) => [item.source, item.read]),
    [
      ['message', false],
      ['room', true],
    ],
  );
  assert.equal(owner.unread, 1);
  const all = await http(
    app,
    scene.memberCookie,
    'POST',
    `/api/agents/${scene.member}/mentions/ack`,
    {
      seq: 2,
    },
  );
  assert.deepEqual(all.json(), { agent_id: scene.member, acked_seq: 2, latest_seq: 2, unread: 0 });
});

test('review 4: a room mention from before the current membership is not shown again', async (t) => {
  const app = await fixture(t);
  const scene = await roomScene(app);
  assert.equal((await scene.post(scene.hostCookie, 'Before @bravo')).statusCode, 201);
  const list = () =>
    http(app, scene.memberCookie, 'GET', `/api/agents/${scene.member}/mentions?since=0`);
  assert.equal((await list()).json().mentions.length, 1);
  // Re-join with hidden history: the membership now starts after that post.
  await app.city.db.query(
    'UPDATE room_members SET visible_from_seq=(SELECT next_seq-1 FROM rooms WHERE id=$1) WHERE room_id=$1 AND agent_id=$2',
    [scene.roomId, scene.member],
  );
  assert.deepEqual((await list()).json().mentions, []);
  assert.equal((await scene.post(scene.hostCookie, 'After @bravo')).statusCode, 201);
  assert.deepEqual(
    (await list()).json().mentions.map((item: { excerpt: string }) => item.excerpt),
    ['After @bravo'],
  );
});

test('review 5 and 6: disabled webhooks are skipped; a final failure keeps a newer wake-up', async (t) => {
  const calls: Array<{ body: string; headers: Record<string, string> }> = [];
  let onCall: (() => Promise<number>) | undefined;
  const transport: WebhookTransport = async (_url, body, headers) => {
    calls.push({ body, headers });
    return { status: onCall ? await onCall() : 204 };
  };
  const app = await fixture(t, { transport, webhookAttempts: 1 });
  const { cookie, a, b } = await pair(app);
  const key = await grant(app, cookie, ['workspace:read', 'agents:wake']);
  const set = await tool(app, key, 'city_set_wake_webhook', {
    agent_id: b,
    url: 'https://hooks.example.com/wake',
  });
  assert.equal(set.statusCode, 200, set.body);
  const waitFor = async (count: number) => {
    const deadline = performance.now() + WAKE_BUDGET_MS;
    while (calls.length < count && performance.now() < deadline) await sleep(10);
  };
  // Key id travels with the signature.
  await send(app, cookie, a, b, 'first');
  await waitFor(1);
  assert.equal(calls[0]!.headers['webhook-key-id'], set.json().key_id);
  assert.match(set.json().key_id, /^k_[0-9a-f]{12}$/);

  // 6: the only allowed attempt fails, but a newer event coalesced meanwhile: it is still sent.
  calls.length = 0;
  let first = true;
  onCall = async () => {
    if (!first) return 204;
    first = false;
    assert.equal((await send(app, cookie, a, b, 'during delivery')).statusCode, 201);
    return 500;
  };
  await send(app, cookie, a, b, 'fails');
  await waitFor(2);
  assert.equal(calls.length, 2, 'the newer wake-up survived the final failure');
  assert.notEqual(calls[1]!.headers['webhook-id'], calls[0]!.headers['webhook-id']);
  const outbox = async () => (await app.city.db.query('SELECT * FROM wake_outbox')).rows.length;
  await sleep(100);
  assert.equal(await outbox(), 0);
  // Without a newer event, the final failure drops the wake-up.
  calls.length = 0;
  onCall = async () => 500;
  await send(app, cookie, a, b, 'dropped');
  await waitFor(1);
  await sleep(200);
  assert.equal(calls.length, 1);
  assert.equal(await outbox(), 0);

  // 5: a disabled webhook is never claimed.
  onCall = undefined;
  calls.length = 0;
  await app.city.db.query('UPDATE wake_webhooks SET disabled_at=1 WHERE agent_id=$1', [b]);
  await send(app, cookie, a, b, 'while disabled');
  await sleep(500);
  assert.equal(calls.length, 0);
});

test('the production webhook transport refuses private and loopback targets', async () => {
  for (const url of ['https://127.0.0.1/x', 'https://192.168.1.10/x', 'http://example.com/x'])
    await assert.rejects(httpsWebhookTransport(url, '{}', {}, 1000));
  assert.throws(() => validateWebhookUrl('https://169.254.169.254/latest/meta-data'));
  assert.equal(validateWebhookUrl('https://hooks.example.com/a?b=1').host, 'hooks.example.com');
});

/**
 * Bounded pool of three clients, modelled on PGlite like tests/cross-owner-pool.test.ts: each
 * transaction holds a client and runs exclusively; a plain query borrows a client for one
 * statement; acquisitions wait for a free client (as pg does). `inTransaction` counts clients
 * held by transactions, the only way a request can keep a client while it waits.
 */
function boundedPool(pg: PGlite) {
  const stats = { held: 0, inTransaction: 0, peak: 0, queries: 0 };
  let chain: Promise<void> = Promise.resolve();
  const turn = async () => {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const previous = chain;
    chain = previous.then(() => mine);
    await previous;
    return release;
  };
  const run = async (sql: string, params?: unknown[]) =>
    params === undefined && /;\s*\S/.test(sql)
      ? (await pg.exec(sql), { rows: [] })
      : pg.query(sql, params ?? []);
  const waiting: Array<() => void> = [];
  const acquire = async () => {
    while (stats.held >= 3) await new Promise<void>((resolve) => waiting.push(resolve));
    stats.held++;
    stats.peak = Math.max(stats.peak, stats.held);
  };
  const free = () => {
    stats.held--;
    waiting.shift()?.();
  };
  const pool = {
    on() {},
    async connect() {
      await acquire();
      stats.inTransaction++;
      let release: (() => void) | undefined;
      return {
        async query(sql: string, params?: unknown[]) {
          if (sql === 'BEGIN') release = await turn();
          const result = await run(sql, params);
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            release?.();
            release = undefined;
          }
          return result;
        },
        release() {
          release?.();
          release = undefined;
          stats.inTransaction--;
          free();
        },
      };
    },
    async query(sql: string, params?: unknown[]) {
      stats.queries++;
      await acquire();
      const release = await turn();
      try {
        return await run(sql, params);
      } finally {
        release();
        free();
      }
    },
    async end() {
      await pg.close();
    },
  };
  return { db: postgresDatabase(pool as unknown as Pool), stats };
}

test(
  'pool safety: eight waiting long-polls and a stream hold zero pool clients',
  { timeout: 60_000 },
  async (t) => {
    const hosted = loadHostedConfig({
      CITY_HOSTED: '1',
      DATABASE_URL: 'postgresql://db.example.com/staging',
      CITY_PUBLIC_ORIGIN: 'https://city.example.com',
    });
    const pool = boundedPool(await PGlite.create('memory://'));
    const app = await createApp({
      hosted,
      database: pool.db,
      rateLimiter: 'postgres',
      wake: { pollMs: 250, streamMs: 4000, heartbeatMs: 10_000 },
    });
    t.after(() => app.close());
    const headers = {
      host: 'city.example.com',
      origin: 'https://city.example.com',
      'content-type': 'application/json',
      'x-city-request': '1',
    };
    const call = (cookie: string, method: 'GET' | 'POST', url: string, body?: unknown) =>
      app.inject({
        method,
        url,
        headers: { ...headers, cookie },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    const res = await call('', 'POST', '/api/auth/register', {
      name: 'Pool owner',
      password: PASSWORD,
    });
    assert.equal(res.statusCode, 201, res.body);
    const cookie = `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
    const ids: string[] = [];
    for (const name of ['Sender', 'Reader 1', 'Reader 2', 'Reader 3']) {
      const created = await call(cookie, 'POST', '/api/agents', {
        name,
        capability: 'research',
        mode: 'hosted',
      });
      assert.equal(created.statusCode, 201, created.body);
      ids.push(created.json().agent.id);
    }
    const [sender, ...readers] = ids as [string, ...string[]];
    for (const reader of readers)
      assert.equal(
        (await call(cookie, 'POST', '/api/connections', { fromAgentId: sender, toAgentId: reader }))
          .statusCode,
        201,
      );
    // Eight long-polls (more than the pool's three clients) plus one SSE stream.
    const polls = Array.from({ length: 8 }, (_, index) =>
      call(cookie, 'GET', `/api/agents/${readers[index % 3]}/inbox?since=0&wait=15`),
    );
    const stream = call(cookie, 'GET', `/api/v2/stream?agent=${readers[0]}`);
    await sleep(700);
    const queriesBefore = pool.stats.queries;
    const samples: number[] = [];
    for (let index = 0; index < 40; index++) {
      samples.push(pool.stats.inTransaction);
      await sleep(20);
    }
    assert.deepEqual(new Set(samples), new Set([0]), 'no pool client held while waiting');
    const polled = pool.stats.queries - queriesBefore;
    // 9 waiters x ~3 intervals would be ~27 per-waiter queries; batched polling plus the
    // throttled outbox drain stays near one or two statements per interval.
    assert.ok(polled <= 12, `one batched cursor query per interval, not per waiter (${polled})`);
    // Sends still get through while everyone waits.
    const sentAt = performance.now();
    const sends = await Promise.all(
      readers.map((reader) =>
        call(cookie, 'POST', `/api/agents/${sender}/messages`, {
          to_agent_id: reader,
          text: 'pool wake',
          idempotency_key: randomUUID(),
        }),
      ),
    );
    for (const sent of sends) assert.equal(sent.statusCode, 201, sent.body);
    const answers = await Promise.all(polls);
    const latency = performance.now() - sentAt;
    for (const answer of answers)
      assert.equal(answer.json().messages[0].parts[0].text, 'pool wake');
    assert.ok(latency < WAKE_BUDGET_MS, `pool long-poll latency ${latency}`);
    const streamed = await stream;
    assert.match(streamed.body, /event: message/);
    assert.equal(pool.stats.held, 0, 'every client returned');
    assert.ok(pool.stats.peak <= 3);
    t.diagnostic(
      `bounded pool: 0 clients held by 9 waiters; ${polled} pool statements (cursor polls + outbox checks) in 800 ms; peak ${pool.stats.peak} clients; wake latency ${latency.toFixed(1)} ms`,
    );
  },
);
