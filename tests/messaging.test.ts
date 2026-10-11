import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../server/app.js';
import { signedHeaders } from '../connector/signing.js';
import type { Agent } from '../shared/types.js';
import type { AgentMessage, InboxPage } from '../server/messaging/contract.js';
import { pairKey } from '../server/messaging/service.js';
import {
  consent,
  fullFlow,
  mcpCall,
  OWNER,
  PASSWORD,
  rpcResult,
  TestProvider,
} from './oauth-helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const MESSAGE_SCOPES = ['workspace:read', 'messages:send', 'messages:read'];

async function account(app: App, name: string, password = PASSWORD) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name, password }),
  });
  assert.equal(res.statusCode, 201, res.body);
  return `cc_session=${res.cookies.find((cookie) => cookie.name === 'cc_session')!.value}`;
}
function owner(
  app: App,
  cookie: string,
  method: 'GET' | 'POST' | 'DELETE',
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
async function agent(app: App, cookie: string, name: string) {
  const res = await owner(app, cookie, 'POST', '/api/agents', {
    name,
    description: 'Synthetic messaging agent',
    capability: 'research',
    mode: 'external',
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { agent: Agent; token: string };
}
async function connect(app: App, cookie: string, from: string, to: string) {
  const res = await owner(app, cookie, 'POST', '/api/connections', {
    fromAgentId: from,
    toAgentId: to,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().connection as { id: string };
}

async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  messaging: { inboxDepth?: number; sendsPerMinute?: number } = {},
) {
  let now = 1_800_000_000_000;
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    now: () => now,
    messaging,
  });
  t.after(() => app.close());
  const cookie = await account(app, OWNER);
  const a = await agent(app, cookie, 'Alpha agent');
  const b = await agent(app, cookie, 'Beta agent');
  await connect(app, cookie, a.agent.id, b.agent.id);
  const send = (from: string, body: Record<string, unknown>, as = cookie) =>
    owner(app, as, 'POST', `/api/agents/${from}/messages`, {
      idempotency_key: randomUUID(),
      ...body,
    });
  const inbox = (id: string, query = '', as = cookie) =>
    owner(app, as, 'GET', `/api/agents/${id}/inbox${query}`);
  const runtime = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    return app.inject({
      method,
      url,
      headers: signedHeaders(token, method, url, body, String(now)),
      ...(method === 'POST' ? { payload: body } : {}),
    });
  };
  return {
    app,
    cookie,
    a,
    b,
    send,
    inbox,
    runtime,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const codeOf = (res: { json: () => any }) => res.json().code as string;

test('owner sends as an agent; the recipient reads in order and acknowledges monotonically', async (t) => {
  const { a, b, send, inbox, cookie, app } = await setup(t);
  const first = await send(a.agent.id, { to_agent_id: b.agent.id, text: 'Morning sync: M3 plan?' });
  assert.equal(first.statusCode, 201, first.body);
  const message = first.json().message as AgentMessage;
  assert.equal(message.seq, 1);
  assert.equal(message.kind, 'message');
  assert.equal(message.from_agent_id, a.agent.id);
  assert.equal(message.from_agent_name, 'Alpha agent');
  assert.equal(message.to_agent_name, 'Beta agent');
  const [low, high] = pairKey(a.agent.id, b.agent.id);
  const stored = await app.city.db.query<{ context_id: string }>(
    'SELECT context_id FROM pair_contexts WHERE low_id=$1 AND high_id=$2',
    [low, high],
  );
  assert.equal(
    message.context_id,
    stored.rows[0]?.context_id,
    "a first message without context_id opens the pair's stored default conversation",
  );
  assert.deepEqual(message.parts, [{ type: 'text', text: 'Morning sync: M3 plan?' }]);
  for (let index = 2; index <= 5; index++) {
    const res = await send(a.agent.id, {
      to_agent_id: b.agent.id,
      parts: [
        { type: 'text', text: `Item ${index}` },
        { type: 'data', data: { index, ok: true }, mimeType: 'application/json' },
      ],
      context_id: message.context_id,
    });
    assert.equal(res.json().message.seq, index);
    assert.deepEqual(res.json().message.parts[1], {
      type: 'data',
      data: { index, ok: true },
      mimeType: 'application/json',
    });
  }
  // Owner view defaults to the newest page, ascending.
  const latest = (await inbox(b.agent.id, '?limit=2')).json() as InboxPage;
  assert.deepEqual(
    latest.messages.map((item) => item.seq),
    [4, 5],
  );
  assert.equal(latest.has_more, true);
  const older = (await inbox(b.agent.id, '?before=4&limit=10')).json() as InboxPage;
  assert.deepEqual(
    older.messages.map((item) => item.seq),
    [1, 2, 3],
  );
  // Keyset paging forward.
  const page = (await inbox(b.agent.id, '?since=1&limit=2')).json() as InboxPage;
  assert.deepEqual(
    page.messages.map((item) => item.seq),
    [2, 3],
  );
  assert.equal(page.next_since, 3);
  assert.equal(page.has_more, true);
  assert.equal(page.unread, 5);
  assert.equal((await inbox(a.agent.id)).json().messages.length, 0, 'sender inbox is separate');

  const ack = await owner(app, cookie, 'POST', `/api/agents/${b.agent.id}/inbox/ack`, { seq: 3 });
  assert.equal(ack.statusCode, 200, ack.body);
  assert.deepEqual(ack.json(), { agent_id: b.agent.id, acked_seq: 3, latest_seq: 5, unread: 2 });
  const back = await owner(app, cookie, 'POST', `/api/agents/${b.agent.id}/inbox/ack`, { seq: 1 });
  assert.equal(back.json().acked_seq, 3, 'acknowledgement never moves backwards');
  const beyond = await owner(app, cookie, 'POST', `/api/agents/${b.agent.id}/inbox/ack`, {
    seq: 9,
  });
  assert.equal(beyond.statusCode, 400);
  assert.equal(codeOf(beyond), 'ack_beyond_latest');

  // Beta's two unacknowledged messages came from Alpha, another of the owner's own agents: the
  // AI's inbox still holds them, but they are not unread for the owner.
  const summary = (await owner(app, cookie, 'GET', '/api/messages/summary')).json();
  assert.deepEqual(summary.inboxes, [
    { agent_id: b.agent.id, latest_seq: 5, acked_seq: 3, unread: 0, unread_capped: false },
  ]);
  const conversations = (await owner(app, cookie, 'GET', '/api/messages/conversations')).json();
  assert.equal(conversations.conversations.length, 1);
  assert.equal(conversations.conversations[0].message_count, 5);
  assert.deepEqual(conversations.conversations[0].participants, [a.agent.id, b.agent.id].sort());
  assert.equal(conversations.conversations[0].last_message.seq, 5);
  const thread = (
    await owner(app, cookie, 'GET', `/api/messages/conversations/${message.context_id}?limit=3`)
  ).json();
  assert.deepEqual(
    thread.messages.map((item: AgentMessage) => item.seq),
    [3, 4, 5],
  );
  assert.equal(thread.has_more, true);
  const rest = (
    await owner(
      app,
      cookie,
      'GET',
      `/api/messages/conversations/${message.context_id}?before=${encodeURIComponent(thread.next_before)}`,
    )
  ).json();
  assert.deepEqual(
    rest.messages.map((item: AgentMessage) => item.seq),
    [1, 2],
  );
});

test('messages from before an agent was claimed are not unread for its new owner', async (t) => {
  const { a, b, send, cookie, app } = await setup(t);
  const res = await send(a.agent.id, { to_agent_id: b.agent.id, text: 'Sent while unclaimed' });
  assert.equal(res.statusCode, 201, res.body);
  // A claim moves the agents to the new owner but leaves their stored messages under the old
  // owner ids (server/autonomy/index.ts): the message stays in Beta's inbox, unacknowledged.
  await app.city.db.query(
    "UPDATE messages SET sender_owner_id='previous-owner', recipient_owner_id='previous-owner' WHERE recipient_id=$1",
    [b.agent.id],
  );
  const summary = (await owner(app, cookie, 'GET', '/api/messages/summary')).json();
  assert.deepEqual(summary.inboxes, [
    { agent_id: b.agent.id, latest_seq: 1, acked_seq: 0, unread: 0, unread_capped: false },
  ]);
  // The same as the list, which has no thread for it to open.
  const list = (await owner(app, cookie, 'GET', '/api/messages/conversations')).json();
  assert.deepEqual(list.conversations, []);
});

test('a conversation hidden before hides marked it read is not unread either', async (t) => {
  const { a, b, send, cookie, app } = await setup(t);
  const res = await send(a.agent.id, { to_agent_id: b.agent.id, text: 'From someone else' });
  assert.equal(res.statusCode, 201, res.body);
  // A message from another owner, so it counts as unread for this owner.
  await app.city.db.query(
    "UPDATE messages SET sender_owner_id='someone-else' WHERE recipient_id=$1",
    [b.agent.id],
  );
  const before = (await owner(app, cookie, 'GET', '/api/messages/summary')).json();
  assert.equal(
    before.inboxes.find((i: { agent_id: string }) => i.agent_id === b.agent.id).unread,
    1,
  );
  // Hidden without a read mark (hides from before the read mark was written with them).
  const operator = (await owner(app, cookie, 'GET', '/api/session')).json().operator.id;
  await app.city.db.query(
    `INSERT INTO conversation_hidden(owner_id,context_id,hidden_at)
       SELECT $1, context_id, created_at FROM messages WHERE recipient_id=$2`,
    [operator, b.agent.id],
  );
  const list = (await owner(app, cookie, 'GET', '/api/messages/conversations')).json();
  assert.deepEqual(list.conversations, []);
  // The Messages count agrees with the list: nothing to open, nothing unread.
  const after = (await owner(app, cookie, 'GET', '/api/messages/summary')).json();
  assert.equal(
    after.inboxes.find((i: { agent_id: string }) => i.agent_id === b.agent.id).unread,
    0,
  );
});

test('replies inherit the thread; idempotent replays return the same message; changed arguments conflict', async (t) => {
  const { app, a, b, send, cookie } = await setup(t);
  await connect(app, cookie, b.agent.id, a.agent.id);
  const key = randomUUID();
  const first = await send(a.agent.id, {
    to_agent_id: b.agent.id,
    text: 'Proposal',
    idempotency_key: key,
  });
  const replay = await send(a.agent.id, {
    to_agent_id: b.agent.id,
    parts: [{ type: 'text', text: 'Proposal' }],
    idempotency_key: key,
  });
  assert.equal(replay.statusCode, 201);
  assert.deepEqual(replay.json(), first.json(), 'text shorthand and parts are the same message');
  const changed = await send(a.agent.id, {
    to_agent_id: b.agent.id,
    text: 'Different',
    idempotency_key: key,
  });
  assert.equal(changed.statusCode, 409);
  assert.equal(codeOf(changed), 'idempotency_conflict');
  // The same key from another sender is independent.
  const other = await send(b.agent.id, {
    to_agent_id: a.agent.id,
    text: 'Reply',
    reply_to: first.json().message.id,
    idempotency_key: key,
  });
  assert.equal(other.statusCode, 201, other.body);
  assert.equal(other.json().message.context_id, first.json().message.context_id);
  assert.equal(other.json().message.reply_to, first.json().message.id);
  const unknownReply = await send(b.agent.id, {
    to_agent_id: a.agent.id,
    text: 'x',
    reply_to: randomUUID(),
  });
  assert.equal(codeOf(unknownReply), 'reply_not_found');
  const explicit = await send(b.agent.id, {
    to_agent_id: a.agent.id,
    text: 'New topic',
    context_id: 'lead-sync:2026-09-26',
  });
  assert.equal(explicit.json().message.context_id, 'lead-sync:2026-09-26');
  const inboxA = (await owner(app, cookie, 'GET', `/api/agents/${a.agent.id}/inbox`)).json();
  assert.deepEqual(
    inboxA.messages.map((item: AgentMessage) => item.seq),
    [1, 2],
  );
});

test('a directional connection is required and current; revoked and paused agents are denied', async (t) => {
  const { app, a, b, send, cookie } = await setup(t);
  const reverse = await send(b.agent.id, { to_agent_id: a.agent.id, text: 'No route back' });
  assert.equal(reverse.statusCode, 403);
  assert.equal(codeOf(reverse), 'connection_required');
  const self = await send(a.agent.id, { to_agent_id: a.agent.id, text: 'Me' });
  assert.equal(self.statusCode, 400);
  const connection = await connect(app, cookie, b.agent.id, a.agent.id);
  assert.equal((await send(b.agent.id, { to_agent_id: a.agent.id, text: 'Now' })).statusCode, 201);
  await owner(app, cookie, 'DELETE', `/api/connections/${connection.id}`);
  assert.equal(
    codeOf(await send(b.agent.id, { to_agent_id: a.agent.id, text: 'x' })),
    'connection_required',
  );

  // Pause through the assistant control tool (local bearer transport).
  const grant = await owner(app, cookie, 'POST', '/api/assistant-access', {
    label: 'Control',
    scopes: ['workspace:read', 'agents:control'],
    expiresInDays: 1,
  });
  const token = grant.json().token as string;
  const control = (action: 'pause' | 'resume') =>
    app.inject({
      method: 'POST',
      url: '/api/assistant/tools/city_control',
      headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
      payload: JSON.stringify({ agent_id: b.agent.id, action }),
    });
  assert.equal((await control('pause')).statusCode, 200);
  const paused = await send(a.agent.id, { to_agent_id: b.agent.id, text: 'x' });
  assert.equal(paused.statusCode, 409);
  assert.equal(codeOf(paused), 'agent_paused');
  assert.equal((await control('resume')).statusCode, 200);
  assert.equal((await send(a.agent.id, { to_agent_id: b.agent.id, text: 'ok' })).statusCode, 201);

  await owner(app, cookie, 'POST', '/api/workspace/pause', { paused: true });
  assert.equal(
    codeOf(await send(a.agent.id, { to_agent_id: b.agent.id, text: 'x' })),
    'workspace_paused',
  );
  await owner(app, cookie, 'POST', '/api/workspace/pause', { paused: false });

  await owner(app, cookie, 'POST', `/api/agents/${b.agent.id}/revoke`, {});
  const revoked = await send(a.agent.id, { to_agent_id: b.agent.id, text: 'x' });
  assert.equal(revoked.statusCode, 403);
  assert.equal(codeOf(revoked), 'agent_revoked');
  // History stays readable for the owner after revocation.
  assert.equal(
    (await owner(app, cookie, 'GET', `/api/agents/${b.agent.id}/inbox`)).json().messages.length,
    1,
  );
});

test('agents of other owners are indistinguishable from unknown ids, and inboxes are tenant-isolated', async (t) => {
  const { app, a, b, send, inbox, cookie } = await setup(t);
  await send(a.agent.id, { to_agent_id: b.agent.id, text: 'Private to this workspace' });
  const other = await account(app, 'Other owner', 'Another synthetic password');
  const x = await agent(app, other, 'Outsider');
  const cross = await send(a.agent.id, { to_agent_id: x.agent.id, text: 'Hello?' });
  // Same answer as an unknown id, so public Agent Card ids cannot be probed for existence: without
  // an approved cross-owner connection (F4) both are connection_required.
  const unknown = await send(a.agent.id, { to_agent_id: randomUUID(), text: 'Hello?' });
  assert.equal(cross.statusCode, 403);
  assert.equal(codeOf(cross), 'connection_required');
  assert.equal(unknown.statusCode, cross.statusCode);
  assert.equal(codeOf(unknown), codeOf(cross));
  const inbound = await send(x.agent.id, { to_agent_id: a.agent.id, text: 'Hi' }, other);
  assert.equal(codeOf(inbound), 'connection_required');
  // The other owner cannot send as, read or acknowledge this owner's agents.
  const impersonate = await send(a.agent.id, { to_agent_id: b.agent.id, text: 'x' }, other);
  assert.equal(impersonate.statusCode, 404);
  assert.equal((await inbox(b.agent.id, '', other)).statusCode, 404);
  const ack = await owner(app, other, 'POST', `/api/agents/${b.agent.id}/inbox/ack`, { seq: 1 });
  assert.equal(ack.statusCode, 404);
  assert.deepEqual((await owner(app, other, 'GET', '/api/messages/summary')).json().inboxes, []);
  assert.deepEqual(
    (await owner(app, other, 'GET', '/api/messages/conversations')).json().conversations,
    [],
  );
  const leaked = await send(a.agent.id, { to_agent_id: b.agent.id, text: 'y' });
  const contextId = leaked.json().message.context_id;
  assert.deepEqual(
    (await owner(app, other, 'GET', `/api/messages/conversations/${contextId}`)).json().messages,
    [],
  );
  assert.equal((await inbox(b.agent.id, '', cookie)).json().messages.length, 2);
  // Unauthenticated callers get nothing.
  const anonymous = await app.inject({ method: 'GET', url: `/api/agents/${b.agent.id}/inbox` });
  assert.equal(anonymous.statusCode, 401);
});

test('inbox depth, message size and per-sender rate limits', async (t) => {
  const { a, b, send, app, cookie, advance } = await setup(t, {
    inboxDepth: 3,
    sendsPerMinute: 5,
  });
  for (let index = 0; index < 3; index++)
    assert.equal(
      (await send(a.agent.id, { to_agent_id: b.agent.id, text: `m${index}` })).statusCode,
      201,
    );
  const full = await send(a.agent.id, { to_agent_id: b.agent.id, text: 'overflow' });
  assert.equal(full.statusCode, 429);
  assert.equal(codeOf(full), 'inbox_full');
  assert.ok(full.headers['retry-after']);
  await owner(app, cookie, 'POST', `/api/agents/${b.agent.id}/inbox/ack`, { seq: 1 });
  const after = await send(a.agent.id, { to_agent_id: b.agent.id, text: 'room again' });
  assert.equal(after.statusCode, 201);
  assert.equal(after.json().message.seq, 4, 'a rejected send leaves no sequence gap');
  // The sixth send in this minute exceeds the per-sender budget.
  const limited = await send(a.agent.id, { to_agent_id: b.agent.id, text: 'too fast' });
  assert.equal(limited.statusCode, 429);
  assert.notEqual(limited.json().code, 'inbox_full');
  advance(61_000);
  await owner(app, cookie, 'POST', `/api/agents/${b.agent.id}/inbox/ack`, { seq: 4 });

  const tooLongText = await send(a.agent.id, { to_agent_id: b.agent.id, text: 'x'.repeat(16_385) });
  assert.equal(tooLongText.statusCode, 400);
  const bigData = await send(a.agent.id, {
    to_agent_id: b.agent.id,
    parts: [{ type: 'data', data: { blob: 'y'.repeat(33_000) } }],
  });
  assert.equal(bigData.statusCode, 400);
  const bigTotal = await send(a.agent.id, {
    to_agent_id: b.agent.id,
    parts: [
      { type: 'text', text: 'a'.repeat(16_000) },
      { type: 'text', text: 'b'.repeat(16_000) },
      { type: 'text', text: 'c'.repeat(1_000) },
    ],
  });
  assert.equal(bigTotal.statusCode, 400);
  const multibyte = await send(a.agent.id, { to_agent_id: b.agent.id, text: '€'.repeat(16_000) });
  assert.equal(multibyte.statusCode, 413);
  assert.equal(codeOf(multibyte), 'message_too_large');
  const both = await send(a.agent.id, {
    to_agent_id: b.agent.id,
    text: 'x',
    parts: [{ type: 'text', text: 'x' }],
  });
  assert.equal(both.statusCode, 400);
  const badMime = await send(a.agent.id, {
    to_agent_id: b.agent.id,
    parts: [{ type: 'data', data: 1, mimeType: 'not a media type' }],
  });
  assert.equal(badMime.statusCode, 400);
  const unknownPart = await send(a.agent.id, {
    to_agent_id: b.agent.id,
    parts: [{ type: 'file', uri: 'https://example.com' }],
  });
  assert.equal(unknownPart.statusCode, 400);
  const ok = await send(a.agent.id, {
    to_agent_id: b.agent.id,
    parts: [
      { type: 'text', text: 'a'.repeat(16_000) },
      { type: 'data', data: [1, 'two', null, { three: 3 }] },
    ],
  });
  assert.equal(ok.statusCode, 201, ok.body);
});

test('external runtimes send, read and acknowledge with signed requests', async (t) => {
  const { a, b, runtime, app, cookie } = await setup(t);
  const sent = await runtime(a.token, 'POST', '/api/runtime/messages', {
    to_agent_id: b.agent.id,
    text: 'From the runtime',
    idempotency_key: 'runtime-key-0001',
  });
  assert.equal(sent.statusCode, 201, sent.body);
  assert.equal(sent.json().message.from_agent_id, a.agent.id);
  const second = await runtime(a.token, 'POST', '/api/runtime/messages', {
    to_agent_id: b.agent.id,
    parts: [{ type: 'data', data: { status: 'green' } }],
    idempotency_key: 'runtime-key-0002',
  });
  assert.equal(second.json().message.seq, 2);
  // The query string is part of the signed request target.
  const read = await runtime(b.token, 'GET', '/api/runtime/inbox?limit=10');
  assert.equal(read.statusCode, 200, read.body);
  const page = read.json() as InboxPage;
  assert.deepEqual(
    page.messages.map((item) => item.seq),
    [1, 2],
  );
  assert.equal(page.messages[0]!.from_agent_name, 'Alpha agent');
  const tampered = await app.inject({
    method: 'GET',
    url: '/api/runtime/inbox?limit=1',
    headers: signedHeaders(
      b.token,
      'GET',
      '/api/runtime/inbox?limit=10',
      '',
      String(1_800_000_000_000),
    ),
  });
  assert.equal(tampered.statusCode, 401);
  const acked = await runtime(b.token, 'POST', '/api/runtime/inbox/ack', { seq: 1 });
  assert.deepEqual(acked.json(), { agent_id: b.agent.id, acked_seq: 1, latest_seq: 2, unread: 1 });
  // Default since is the acknowledged seq.
  const next = (await runtime(b.token, 'GET', '/api/runtime/inbox')).json() as InboxPage;
  assert.deepEqual(
    next.messages.map((item) => item.seq),
    [2],
  );
  // No route back from b to a.
  const denied = await runtime(b.token, 'POST', '/api/runtime/messages', {
    to_agent_id: a.agent.id,
    text: 'x',
    idempotency_key: 'runtime-key-0003',
  });
  assert.equal(denied.statusCode, 403);
  // A revoked runtime loses its credential.
  await owner(app, cookie, 'POST', `/api/agents/${a.agent.id}/revoke`, {});
  const gone = await runtime(a.token, 'POST', '/api/runtime/messages', {
    to_agent_id: b.agent.id,
    text: 'x',
    idempotency_key: 'runtime-key-0004',
  });
  assert.equal(gone.statusCode, 401);
});

const callTool = async (app: App, token: string, name: string, args: unknown) => {
  const res = await mcpCall(app, token, 'tools/call', { name, arguments: args });
  return res;
};
const structured = (res: { statusCode: number; body: string }) => {
  assert.equal(res.statusCode, 200, res.body);
  const result = rpcResult(res.body).result;
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent;
};

test('MCP tools: scopes are enforced separately for send and read, with machine-readable errors', async (t) => {
  let now = 1_800_000_000_000;
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => now });
  t.after(() => app.close());
  const cookie = await account(app, OWNER);
  const a = await agent(app, cookie, 'Alpha agent');
  const b = await agent(app, cookie, 'Beta agent');
  await connect(app, cookie, a.agent.id, b.agent.id);

  const sendOnly = (
    await fullFlow(app, { scope: 'workspace:read messages:send', scopes: ['messages:send'] })
  ).tokens.access_token;
  const list = rpcResult((await mcpCall(app, sendOnly, 'tools/list')).body).result.tools as {
    name: string;
    annotations: Record<string, boolean>;
    outputSchema: { type: string };
  }[];
  const byName = Object.fromEntries(list.map((tool) => [tool.name, tool]));
  // tools/list offers only what the grant can call: no inbox tools without messages:read.
  assert.equal(byName.city_read_inbox, undefined);
  assert.equal(byName.city_ack_inbox, undefined);
  assert.equal(byName.city_send_message!.annotations.readOnlyHint, false);
  assert.equal(byName.city_send_message!.annotations.destructiveHint, false);
  const sent = structured(
    await callTool(app, sendOnly, 'city_send_message', {
      from_agent_id: a.agent.id,
      to_agent_id: b.agent.id,
      text: 'Via MCP',
      idempotency_key: 'mcp-send-0001',
    }),
  );
  assert.equal(sent.message.seq, 1);
  const read = await callTool(app, sendOnly, 'city_read_inbox', { agent_id: b.agent.id });
  assert.equal(read.statusCode, 403, read.body);
  assert.match(String(read.headers['www-authenticate']), /insufficient_scope/);

  const readOnly = (
    await fullFlow(app, { scope: 'workspace:read messages:read', scopes: ['messages:read'] })
  ).tokens.access_token;
  const readList = rpcResult((await mcpCall(app, readOnly, 'tools/list')).body).result.tools as {
    name: string;
    annotations: Record<string, boolean>;
    outputSchema: { type: string };
  }[];
  const readByName = Object.fromEntries(readList.map((tool) => [tool.name, tool]));
  assert.equal(readByName.city_read_inbox!.annotations.readOnlyHint, true);
  assert.equal(readByName.city_ack_inbox!.outputSchema.type, 'object');
  assert.equal(readByName.city_send_message, undefined);
  const denied = await callTool(app, readOnly, 'city_send_message', {
    from_agent_id: a.agent.id,
    to_agent_id: b.agent.id,
    text: 'x',
    idempotency_key: 'mcp-send-0002',
  });
  assert.equal(denied.statusCode, 403);
  const inbox = structured(
    await callTool(app, readOnly, 'city_read_inbox', { agent_id: b.agent.id }),
  );
  assert.equal(inbox.messages[0].parts[0].text, 'Via MCP');
  assert.deepEqual(
    structured(await callTool(app, readOnly, 'city_ack_inbox', { agent_id: b.agent.id, seq: 1 })),
    { agent_id: b.agent.id, acked_seq: 1, latest_seq: 1, unread: 0 },
  );

  // Machine-readable error codes in tool results.
  const both = (
    await fullFlow(app, {
      scope: 'workspace:read messages:send messages:read',
      scopes: ['messages:send', 'messages:read'],
    })
  ).tokens.access_token;
  const reverse = rpcResult(
    (
      await callTool(app, both, 'city_send_message', {
        from_agent_id: b.agent.id,
        to_agent_id: a.agent.id,
        text: 'x',
        idempotency_key: 'mcp-send-0003',
      })
    ).body,
  ).result;
  assert.equal(reverse.isError, true);
  assert.deepEqual(JSON.parse(reverse.content[0].text).error.code, 'connection_required');
  const conflict = rpcResult(
    (
      await callTool(app, both, 'city_send_message', {
        from_agent_id: a.agent.id,
        to_agent_id: b.agent.id,
        text: 'Changed',
        idempotency_key: 'mcp-send-0001',
      })
    ).body,
  ).result;
  assert.equal(JSON.parse(conflict.content[0].text).error.code, 'idempotency_conflict');
  // Anonymous /mcp/open does not expose messaging.
  const open = await app.inject({
    method: 'POST',
    url: '/mcp/open',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const openTools = (rpcResult(open.body).result.tools as { name: string }[]).map(
    (tool) => tool.name,
  );
  assert.ok(!openTools.some((name) => /message|inbox/.test(name)), openTools.join(','));
  // A revoked grant stops messaging immediately.
  const grants = (await owner(app, cookie, 'GET', '/api/assistant-access')).json().grants as {
    id: string;
  }[];
  for (const grant of grants)
    await owner(app, cookie, 'DELETE', `/api/assistant-access/${grant.id}`);
  const afterRevoke = await callTool(app, both, 'city_read_inbox', { agent_id: b.agent.id });
  assert.equal(afterRevoke.statusCode === 401 || rpcResult(afterRevoke.body).result?.isError, true);
  now += 1;
});

test('end to end: two AI clients talk through their agents with the official MCP SDK', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const registered = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name: OWNER, password: PASSWORD }),
  });
  const cookie = registered.headers.getSetCookie()[0]!.split(';')[0]!;
  const ownerFetch = (url: string, body: unknown) =>
    fetch(`${base}${url}`, {
      method: 'POST',
      headers: { ...jsonHeaders, cookie },
      body: JSON.stringify(body),
    }).then((res) => res.json());
  const create = (name: string) =>
    ownerFetch('/api/agents', {
      name,
      description: 'AI lead',
      capability: 'research',
      mode: 'external',
    });
  const alpha = (await create('Alpha')).agent as Agent;
  const beta = (await create('Beta')).agent as Agent;
  await ownerFetch('/api/connections', { fromAgentId: alpha.id, toAgentId: beta.id });
  await ownerFetch('/api/connections', { fromAgentId: beta.id, toAgentId: alpha.id });

  async function aiClient(name: string) {
    const provider = new TestProvider();
    const endpoint = new URL(`${base}/mcp`);
    const probe = new Client({ name, version: '1.0.0' });
    await probe
      .connect(
        new StreamableHTTPClientTransport(endpoint, {
          authProvider: provider,
        }),
      )
      .catch(() => undefined);
    assert.ok(provider.authorizationUrl);
    provider.authorizationUrl.searchParams.set('scope', MESSAGE_SCOPES.join(' '));
    const callback = await consent(provider.authorizationUrl, ['messages:send', 'messages:read']);
    await new StreamableHTTPClientTransport(endpoint, { authProvider: provider }).finishAuth(
      callback.searchParams,
    );
    const client = new Client({ name, version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: provider }));
    t.after(() => client.close());
    return client;
  }
  const first = await aiClient('lead-one');
  const second = await aiClient('lead-two');
  const opened = await first.callTool({
    name: 'city_send_message',
    arguments: {
      from_agent_id: alpha.id,
      to_agent_id: beta.id,
      text: 'Session start: please review the fabric plan.',
      context_id: 'leads:fabric',
      idempotency_key: 'lead-one-0001',
    },
  });
  assert.ok(!opened.isError, JSON.stringify(opened));
  const inbox = await second.callTool({
    name: 'city_read_inbox',
    arguments: { agent_id: beta.id },
  });
  const page = inbox.structuredContent as unknown as InboxPage;
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0]!.from_agent_name, 'Alpha');
  const reply = await second.callTool({
    name: 'city_send_message',
    arguments: {
      from_agent_id: beta.id,
      to_agent_id: alpha.id,
      text: 'Reviewed. Two comments inline.',
      reply_to: page.messages[0]!.id,
      idempotency_key: 'lead-two-0001',
    },
  });
  assert.equal((reply.structuredContent as any).message.context_id, 'leads:fabric');
  await second.callTool({
    name: 'city_ack_inbox',
    arguments: { agent_id: beta.id, seq: page.next_since },
  });
  const answer = await first.callTool({
    name: 'city_read_inbox',
    arguments: { agent_id: alpha.id },
  });
  assert.equal(
    (answer.structuredContent as any).messages[0].parts[0].text,
    'Reviewed. Two comments inline.',
  );
  const after = await second.callTool({
    name: 'city_read_inbox',
    arguments: { agent_id: beta.id },
  });
  assert.equal((after.structuredContent as any).messages.length, 0);
  assert.equal((after.structuredContent as any).unread, 0);
});

test('a single data part may use the whole message budget (large structured claims)', async (t) => {
  const { a, b, send, inbox } = await setup(t);
  // ~28 KB structured claim: 32 scopes, 32 exclusions, a 2,000-character task.
  const claim = {
    kind: 'claim.request',
    v: 1,
    task: 'x'.repeat(2000),
    paths: Array.from(
      { length: 32 },
      (_, i) => `central-city/server/area-${i}/${'p'.repeat(300)}/**`,
    ),
    excluded: Array.from(
      { length: 32 },
      (_, i) => `central-city/server/area-${i}/${'e'.repeat(300)}.ts`,
    ),
  };
  const bytes = Buffer.byteLength(JSON.stringify(claim));
  assert.ok(bytes > 20_000 && bytes < 32_000, `fixture is ${bytes} bytes`);
  const sent = await send(a.agent.id, {
    to_agent_id: b.agent.id,
    parts: [{ type: 'data', data: claim, mimeType: 'application/vnd.city.desk+json' }],
  });
  assert.equal(sent.statusCode, 201, sent.body);
  const page = (await inbox(b.agent.id)).json() as InboxPage;
  assert.deepEqual((page.messages[0]!.parts[0] as any).data, claim);
  // The whole message still has one total budget.
  const over = await send(a.agent.id, {
    to_agent_id: b.agent.id,
    parts: [{ type: 'data', data: { blob: 'y'.repeat(33_000) } }],
  });
  assert.ok([400, 413].includes(over.statusCode), over.body);
});

test('a replay returns the original message even after the connection was removed', async (t) => {
  const { app, cookie, a, b, send } = await setup(t);
  const key = randomUUID();
  const first = await send(a.agent.id, {
    to_agent_id: b.agent.id,
    text: 'Once',
    idempotency_key: key,
  });
  assert.equal(first.statusCode, 201, first.body);
  const snapshot = (await owner(app, cookie, 'GET', '/api/snapshot')).json();
  const route = snapshot.connections.find((c: any) => c.fromAgentId === a.agent.id);
  assert.equal(
    (await owner(app, cookie, 'DELETE', `/api/connections/${route.id}`)).statusCode,
    200,
  );
  const retry = await send(a.agent.id, {
    to_agent_id: b.agent.id,
    text: 'Once',
    idempotency_key: key,
  });
  assert.ok([200, 201].includes(retry.statusCode), retry.body);
  assert.equal(retry.json().message.id, first.json().message.id);
  // A new message still needs the connection.
  const fresh = await send(a.agent.id, { to_agent_id: b.agent.id, text: 'Again' });
  assert.equal(codeOf(fresh), 'connection_required');
});
