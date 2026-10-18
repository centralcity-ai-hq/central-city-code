import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AdapterError, type FetchLike, type ModelRequest } from '../server/elric/adapter.js';
import { AnthropicAdapter, readMessageStream } from '../server/elric/anthropic.js';
import { DRAFT_LIMITS, draftWriter, sweepStaleDrafts } from '../server/elric/draft.js';
import { eraseElricOwner } from '../server/elric/erase.js';
import { E2E_STREAM_CHUNKS, e2eMockAdapter } from '../server/elric/endpoints.js';
import { elricFixture } from './elric-fixture.js';

/**
 * Streamed Elric replies: the Messages API event stream is rebuilt into the same message, text
 * arrives as it is generated (never thinking), the run keeps a draft that room members can poll,
 * and the draft is gone when the run ends. The posted reply is unchanged. Synthetic data.
 */
const sse = (events: unknown[]) =>
  events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join('');
const SECRET_THOUGHT = 'private reasoning never shown';
const streamEvents = [
  {
    type: 'message_start',
    message: {
      type: 'message',
      role: 'assistant',
      content: [],
      usage: { input_tokens: 50, cache_read_input_tokens: 10 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: SECRET_THOUGHT },
  },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } },
  { type: 'ping' },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world.' } },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'room_read', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '{"room_id":' },
  },
  {
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '"r1"}' },
  },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } },
  { type: 'message_stop' },
];
/** A body that arrives in small pieces, split mid-event. */
const chunked = (text: string, size = 17) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(text);
      for (let at = 0; at < bytes.length; at += size)
        controller.enqueue(bytes.slice(at, at + size));
      controller.close();
    },
  });
const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
  system: 'S',
  messages: [{ role: 'user', content: 'Q' }],
  maxOutputTokens: 600,
  ...extra,
});

test('the event stream rebuilds the message; text arrives as it forms, thinking never does', async () => {
  const seen: string[] = [];
  const json = await readMessageStream(
    { status: 200, body: chunked(sse(streamEvents)) },
    1_000_000,
    (text) => seen.push(text),
  );
  assert.deepEqual(seen, ['Hello ', 'Hello world.']);
  const message = JSON.parse(json!);
  assert.deepEqual(message.content, [
    { type: 'thinking', thinking: SECRET_THOUGHT, signature: 'sig-1' },
    { type: 'text', text: 'Hello world.' },
    { type: 'tool_use', id: 'toolu_1', name: 'room_read', input: { room_id: 'r1' } },
  ]);
  assert.deepEqual(message.usage, {
    input_tokens: 50,
    cache_read_input_tokens: 10,
    output_tokens: 42,
  });
  // Over the size cap: refused.
  assert.equal(
    await readMessageStream({ status: 200, body: chunked(sse(streamEvents)) }, 100),
    null,
  );
});

test('adapter: onText switches to stream: true; the answer equals the non-streamed one; errors stay fixed codes', async () => {
  const sent: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetch =
    (body: string): FetchLike =>
    async (_url, init) => {
      sent.push({ headers: init.headers, body: JSON.parse(init.body ?? '{}') });
      return { status: 200, body: chunked(body) };
    };
  const adapter = (body: string) =>
    new AnthropicAdapter({
      apiKey: randomBytes(16).toString('hex'),
      model: 'hosted-model-1',
      maxTokens: 1_600,
      fetch: fetch(body),
    });
  const seen: string[] = [];
  const answer = await adapter(sse(streamEvents)).complete(
    request({ onText: (t) => seen.push(t) }),
  );
  assert.equal(sent[0]!.body.stream, true);
  assert.equal(sent[0]!.headers.accept, 'text/event-stream');
  assert.equal(answer.text, 'Hello world.');
  assert.deepEqual(answer.toolCalls, [
    { id: 'toolu_1', name: 'room_read', args: { room_id: 'r1' } },
  ]);
  assert.deepEqual(answer.thinking, [
    { type: 'thinking', thinking: SECRET_THOUGHT, signature: 'sig-1' },
  ]);
  assert.equal(answer.usage.outputTokens, 42);
  assert.ok(seen.every((text) => !text.includes(SECRET_THOUGHT)));
  // Without onText nothing streams.
  const plain = new AnthropicAdapter({
    apiKey: randomBytes(16).toString('hex'),
    model: 'hosted-model-1',
    maxTokens: 1_600,
    fetch: async (_url, init) => {
      sent.push({ headers: init.headers, body: JSON.parse(init.body ?? '{}') });
      const json = JSON.stringify({
        type: 'message',
        content: [{ type: 'text', text: 'Hi' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      return { status: 200, text: async () => json };
    },
  });
  await plain.complete(request());
  assert.equal(sent.at(-1)!.body.stream, undefined);
  // An error event mid-stream (for example overloaded) is a fixed code.
  await assert.rejects(
    adapter(
      sse([
        streamEvents[0],
        { type: 'error', error: { type: 'overloaded_error', message: 'detail' } },
      ]),
    ).complete(request({ onText: () => {} })),
    (error) =>
      error instanceof AdapterError &&
      error.code === 'server_error' &&
      !error.message.includes('detail'),
  );
});

test('draft writer: throttled, chained, nothing written after close', async () => {
  const writes: string[] = [];
  let now = 0;
  const writer = draftWriter(
    async (text) => void writes.push(text),
    () => now,
  );
  const burst = (n: number) => `abc${'x'.repeat(n * DRAFT_LIMITS.chars)}`;
  writer.update('a');
  writer.update('ab'); // inside the interval, few new characters: skipped
  now += DRAFT_LIMITS.intervalMs;
  writer.update('abc');
  writer.update(burst(1)); // a burst right after a write: held back (at most 4 writes a second)
  now += DRAFT_LIMITS.minIntervalMs;
  writer.update(burst(2)); // a burst after the minimum gap: written before the usual interval
  now += DRAFT_LIMITS.minIntervalMs - 1;
  writer.update(burst(3)); // still a burst, but too soon: skipped
  await writer.close();
  writer.update('late');
  assert.deepEqual(writes, ['a', 'abc', burst(2)]);
  assert.ok(DRAFT_LIMITS.minIntervalMs >= 250, 'at most 4 writes a second');
});

test('end to end: members watch the draft form; strangers get 404; the draft is gone after the post', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const stranger = await f.account('Stranger');
  const trigger = await f.say(s.owner, s.room, '@Elric tell me something', s.person);
  const url = `/api/rooms/${s.room.id}/elric-drafts`;
  const observed: string[] = [];
  f.small.push(async (req) => {
    req.onText!('Once upon');
    await new Promise((resolve) => setTimeout(resolve, DRAFT_LIMITS.intervalMs + 50));
    const mid = await f.call(s.owner.cookie, 'GET', url);
    assert.equal(mid.statusCode, 200);
    assert.equal(mid.headers['cache-control'], 'no-store');
    observed.push(...mid.json().drafts.map((draft: { text: string }) => draft.text));
    // The room host (a member) sees it too; a stranger does not.
    const host = await f.call(s.host.cookie, 'GET', url);
    assert.equal(host.json().drafts[0].agent_id, s.elricId);
    assert.equal(host.json().drafts[0].source_seq, trigger.message.seq);
    assert.equal((await f.call(stranger.cookie, 'GET', url)).statusCode, 404);
    req.onText!('Once upon a time @Host there was a room.');
    await new Promise((resolve) => setTimeout(resolve, DRAFT_LIMITS.intervalMs + 50));
    observed.push(
      ...(await f.call(s.owner.cookie, 'GET', url))
        .json()
        .drafts.map((d: { text: string }) => d.text),
    );
    return { text: 'Once upon a time there was a room.' };
  });
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.equal(result?.outcome, 'ok');
  // Mentions are defused in the draft as in the reply (no live @).
  assert.deepEqual(observed, ['Once upon', 'Once upon a time Host there was a room.']);
  assert.deepEqual((await f.call(s.owner.cookie, 'GET', url)).json(), { drafts: [] });
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM elric_drafts')).rows[0].n, 0);
  const posted = (await f.messages(s.room.id)).find((row) => row.sender_agent_id === s.elricId)!;
  assert.equal(f.textOf(posted), 'Once upon a time there was a room.');
});

test('a credential in the forming answer is never shown: drafting stops and the reply is refused', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric show me a key', s.person);
  const url = `/api/rooms/${s.room.id}/elric-drafts`;
  const leaked = `sk-ant-api03-${'A'.repeat(90)}`;
  let during: unknown;
  f.small.push(async (req) => {
    req.onText!(`Here: ${leaked}`);
    await new Promise((resolve) => setTimeout(resolve, DRAFT_LIMITS.intervalMs + 50));
    during = (await f.call(s.owner.cookie, 'GET', url)).json();
    return { text: `Here: ${leaked}` };
  });
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.deepEqual(during, { drafts: [] });
  assert.equal(result?.outcome, 'refused_credential');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM elric_drafts')).rows[0].n, 0);
});

test('a failed run leaves no draft behind', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric go', s.person);
  f.small.push(async (req) => {
    req.onText!('Partial answer');
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { error: 'server_error' };
  });
  await f.elric.run({ agentId: s.elricId, roomId: s.room.id, sourceSeq: trigger.message.seq });
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM elric_drafts')).rows[0].n, 0);
});

test('CITY_ELRIC_MOCK: "stream please" streams the three e2e chunks', async () => {
  const seen: string[] = [];
  const adapter = e2eMockAdapter('mock');
  const prompt = [
    'Room (untrusted labels): {"room_id":"r1"}',
    '{"seq":3,"text":"@Elric stream please"}',
    'Answer your owner\'s message seq 3 (from "Ann").',
  ].join('\n');
  const answer = await adapter.complete(
    request({ messages: [{ role: 'user', content: prompt }], onText: (t) => seen.push(t) }),
  );
  assert.deepEqual(seen, [
    'Streaming reply, ',
    'Streaming reply, part two, ',
    E2E_STREAM_CHUNKS.join(''),
  ]);
  assert.equal(answer.text, E2E_STREAM_CHUNKS.join(''));
});

test('stale drafts: removed when a member reads the room, and by the drain sweep', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const old = f.now() - DRAFT_LIMITS.staleMs - 1_000;
  const insert = (seq: number, at: number) =>
    f.db.query(
      'INSERT INTO elric_drafts(agent_id,room_id,source_seq,text,updated_at) VALUES($1,$2,$3,$4,$5)',
      [s.elricId, s.room.id, seq, 'left over', at],
    );
  await insert(900, old);
  const read = await f.call(s.owner.cookie, 'GET', `/api/rooms/${s.room.id}/elric-drafts`);
  assert.deepEqual(read.json(), { drafts: [] });
  const count = async () =>
    Number((await f.db.query('SELECT count(*)::int AS n FROM elric_drafts')).rows[0].n);
  assert.equal(await count(), 0);
  await insert(901, old);
  assert.equal(await sweepStaleDrafts(f.db, f.now()), 1);
  assert.equal(await count(), 0);
});

test('a revoked agent membership opens neither the drafts nor the room list', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const guest = await f.account('Guest owner');
  const guestAgent = await f.agent(guest, 'Guest desk');
  await f.joinAgent(guest, s.room, guestAgent);
  await f.db.query(
    'INSERT INTO elric_drafts(agent_id,room_id,source_seq,text,updated_at) VALUES($1,$2,$3,$4,$5)',
    [s.elricId, s.room.id, 1_000_000, 'forming', f.now()],
  );
  const url = `/api/rooms/${s.room.id}/elric-drafts`;
  const listed = async () =>
    ((await f.call(guest.cookie, 'GET', '/api/rooms')).json().rooms as Array<{ id: string }>).some(
      (room) => room.id === s.room.id,
    );
  const before = await f.call(guest.cookie, 'GET', url);
  assert.equal(before.statusCode, 200, before.body);
  assert.equal(before.json().drafts.length, 1);
  assert.equal(await listed(), true);
  const revoked = await f.call(guest.cookie, 'POST', `/api/agents/${guestAgent}/revoke`, {});
  assert.equal(revoked.statusCode, 200, revoked.body);
  // The room's own reads refuse the revoked member; the drafts and the list follow the same rule.
  assert.equal(
    (await f.call(guest.cookie, 'GET', `/api/rooms/${s.room.id}/members`)).statusCode,
    404,
  );
  const after = await f.call(guest.cookie, 'GET', url);
  assert.equal(after.statusCode, 404, after.body);
  assert.equal(await listed(), false);
  // A person member still reads the drafts.
  assert.equal((await f.call(s.owner.cookie, 'GET', url)).json().drafts.length, 1);
});

test('erasing an owner removes the drafts of their Elric', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  await f.db.query(
    'INSERT INTO elric_drafts(agent_id,room_id,source_seq,text,updated_at) VALUES($1,$2,$3,$4,$5)',
    [s.elricId, s.room.id, 1, 'forming', f.now()],
  );
  await eraseElricOwner(f.db, s.owner.operatorId);
  assert.equal(
    Number((await f.db.query('SELECT count(*)::int AS n FROM elric_drafts')).rows[0].n),
    0,
  );
});
