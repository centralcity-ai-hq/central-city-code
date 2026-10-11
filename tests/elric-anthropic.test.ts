import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { AdapterError, type FetchLike, type ModelRequest } from '../server/elric/adapter.js';
import {
  ANTHROPIC_VERSION,
  AnthropicAdapter,
  FallbackAdapter,
  elricAnthropicModels,
  toAnthropicWire,
} from '../server/elric/anthropic.js';
import { elricEndpoints, elricModels } from '../server/elric/endpoints.js';
import { ELRIC_MODEL_FAILED_REPLY } from '../server/elric/service.js';
import { toolSpecs } from '../server/elric/tools.js';
import { elricPublicModel, elricReplyLabel, ELRIC_PUBLIC_MODEL } from '../shared/elric-copy.js';
import { elricFixture } from './elric-fixture.js';
import { messageAsEventStream } from './elric-sse.js';

/**
 * The hosted Messages API provider against a mocked API (no network): the wire format (headers,
 * caching breakpoints, native tool use), fixed error codes, the self-hosted fallback, the env wiring,
 * the label invariant, and that the key never leaves the request header.
 */
const key = () => randomBytes(24).toString('hex');
type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function api(...replies: Array<{ status?: number; json?: unknown } | Error>) {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body ?? '{}') });
    const next = replies.shift() ?? { json: message([{ type: 'text', text: 'Default.' }]) };
    if (next instanceof Error) throw next;
    const text = JSON.stringify(
      next.json ?? { type: 'error', error: { message: 'provider detail' } },
    );
    // The service streams (stream: true): a 200 answers as an event stream then.
    const streamed =
      (next.status ?? 200) === 200 && JSON.parse(init.body ?? '{}').stream && next.json
        ? messageAsEventStream(next.json as Parameters<typeof messageAsEventStream>[0])
        : text;
    return { status: next.status ?? 200, text: async () => streamed };
  };
  return { fetch, sent };
}
const message = (content: unknown[], usage: Record<string, number> = {}) => ({
  type: 'message',
  role: 'assistant',
  model: 'some-provider-string',
  content,
  stop_reason: 'end_turn',
  usage: { input_tokens: 100, output_tokens: 20, ...usage },
});
const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
  system: 'You are Elric.',
  messages: [{ role: 'user', content: 'What is new here?' }],
  maxOutputTokens: 600,
  ...extra,
});
const adapter = (fetch: FetchLike, apiKey = key(), maxTokens = 400) =>
  new AnthropicAdapter({ apiKey, model: 'hosted-model-1', maxTokens, fetch });
const rejectsWith = (promise: Promise<unknown>, code: string, sent?: boolean, secret?: string) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof AdapterError, String(error));
    assert.equal(error.code, code);
    if (sent !== undefined) assert.equal(error.sent, sent);
    assert.doesNotMatch(error.message, /provider detail/);
    if (secret) assert.ok(!inspect(error).includes(secret));
    return true;
  });

test('wire: one POST /v1/messages with x-api-key and anthropic-version, per-tier max_tokens', async () => {
  const k = key();
  const { fetch, sent } = api();
  const answer = await adapter(fetch, k).complete(request());
  assert.equal(answer.text, 'Default.');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent[0]!.headers['x-api-key'], k);
  assert.equal(sent[0]!.headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(sent[0]!.headers.authorization, undefined);
  assert.equal(sent[0]!.body.model, 'hosted-model-1');
  assert.equal(sent[0]!.body.max_tokens, 400);
  assert.equal(sent[0]!.body.stream, undefined);
  // The request's own cap can only lower the tier's.
  assert.equal(toAnthropicWire(request({ maxOutputTokens: 100 }), 'm', 400).max_tokens, 100);
});

test('wire: cache breakpoints on the system prompt and on the newest history block', () => {
  const wire = toAnthropicWire(
    request({
      messages: [
        { role: 'user', content: 'Room history and trigger' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'toolu_1', name: 'room_read', args: { limit: 5 } }],
        },
        { role: 'tool', toolCallId: 'toolu_1', name: 'room_read', content: '{"messages":[]}' },
      ],
      tools: toolSpecs(true),
    }),
    'hosted-model-1',
    600,
  );
  assert.deepEqual(wire.system, [
    { type: 'text', text: 'You are Elric.', cache_control: { type: 'ephemeral' } },
  ]);
  assert.deepEqual(wire.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Room history and trigger' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'room_read', input: { limit: 5 } }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: '{"messages":[]}',
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
  ]);
  assert.deepEqual(wire.tool_choice, { type: 'auto' });
  const names = wire.tools!.map((tool) => tool.name);
  assert.ok(names.includes('room_read'));
  for (const tool of wire.tools!) assert.equal(typeof tool.input_schema, 'object');
  // Exactly two breakpoints (the API allows four).
  assert.equal(JSON.stringify(wire).match(/cache_control/g)!.length, 2);
});

test('wire: consecutive tool results merge into one user turn', () => {
  const wire = toAnthropicWire(
    request({
      messages: [
        { role: 'user', content: 'Go' },
        {
          role: 'assistant',
          content: 'Checking.',
          toolCalls: [
            { id: 'a', name: 'room_read', args: {} },
            { id: 'b', name: 'room_task_create', args: { title: 'x' } },
          ],
        },
        { role: 'tool', toolCallId: 'a', name: 'room_read', content: '{}' },
        { role: 'tool', toolCallId: 'b', name: 'room_task_create', content: '{}' },
      ],
    }),
    'm',
    400,
  );
  assert.deepEqual(
    wire.messages.map((m) => [m.role, m.content.map((b) => b.type)]),
    [
      ['user', ['text']],
      ['assistant', ['text', 'tool_use', 'tool_use']],
      ['user', ['tool_result', 'tool_result']],
    ],
  );
  assert.equal(wire.tools, undefined);
});

test('response: text, native tool_use as tool requests, cached tokens counted, configured model', async () => {
  const { fetch } = api({
    json: message(
      [
        { type: 'text', text: 'Let me look.' },
        { type: 'tool_use', id: 'toolu_9', name: 'room_task_create', input: { title: 'Ship' } },
        { type: 'tool_use', id: 'toolu_10', name: 'room_read', input: 'not an object' },
      ],
      { input_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 10 },
    ),
  });
  const answer = await adapter(fetch).complete(request());
  assert.equal(answer.text, 'Let me look.');
  assert.deepEqual(answer.toolCalls, [
    { id: 'toolu_9', name: 'room_task_create', args: { title: 'Ship' } },
    { id: 'toolu_10', name: 'room_read', args: null },
  ]);
  // As the API reports them: input_tokens is the uncached part; cache counts are separate.
  assert.deepEqual(answer.usage, {
    inputTokens: 50,
    outputTokens: 20,
    cacheReadInputTokens: 4000,
    cacheCreationInputTokens: 10,
    reported: true,
  });
  assert.equal(answer.pricing, 'anthropic');
  assert.equal(answer.model, 'hosted-model-1');
});

test('errors: fixed codes, nothing of the provider text, 429/529 not charged', async () => {
  const cases: Array<[number, string, boolean]> = [
    [429, 'rate_limited', false],
    [529, 'server_error', false],
    [500, 'server_error', true],
    [401, 'unauthorized', false],
    [404, 'model_unavailable', false],
    [400, 'bad_request', false],
    [413, 'too_large', false],
  ];
  for (const [status, code, sent] of cases)
    await rejectsWith(adapter(api({ status }).fetch).complete(request()), code, sent);
  await rejectsWith(
    adapter(api({ json: { type: 'message', content: [] } }).fetch).complete(request()),
    'bad_response',
    true,
  );
  await rejectsWith(adapter(api({ json: 'nope' }).fetch).complete(request()), 'bad_response');
  // A connection that cannot be opened is unreachable: there is no waking state for a hosted API.
  await rejectsWith(
    adapter(api(new AdapterError('waking')).fetch).complete(request()),
    'unreachable',
  );
  await rejectsWith(
    adapter(api(new Error('socket hang up')).fetch).complete(request()),
    'unreachable',
  );
});

test('the key never appears in errors, inspect or JSON of the adapter or its wiring', async () => {
  const k = key();
  const a = adapter(api({ status: 401 }).fetch, k);
  assert.ok(!inspect(a, { depth: 10, showHidden: true }).includes(k));
  assert.ok(!JSON.stringify(a).includes(k));
  await rejectsWith(a.complete(request()), 'unauthorized', false, k);
  const wiring = elricAnthropicModels({
    CITY_ELRIC_PROVIDER: 'anthropic',
    CITY_ELRIC_T1_MODEL: 'hosted-model-1',
    CITY_ELRIC_ANTHROPIC_KEY: k,
  });
  assert.ok(!inspect(wiring.adapterFor(1), { depth: 10, showHidden: true }).includes(k));
  // A malformed key fails startup without echoing it.
  const bad = 'short\u0001' + k;
  assert.throws(
    () =>
      elricAnthropicModels({
        CITY_ELRIC_PROVIDER: 'anthropic',
        CITY_ELRIC_ANTHROPIC_KEY: bad,
        CITY_ELRIC_T1_MODEL: 'hosted-model-1',
      }),
    (error: Error) => !error.message.includes(k),
  );
});

test('fallback: a 429 goes once to the fallback endpoint; the public model stays the primary', async () => {
  const { fetch, sent } = api({ status: 429 });
  const fallbackCalls: ModelRequest[] = [];
  const fallback = {
    model: 'fallback-model',
    complete: async (r: ModelRequest) => {
      fallbackCalls.push(r);
      return {
        text: 'From the fallback.',
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'fallback-model',
      };
    },
  };
  const wrapped = new FallbackAdapter(adapter(fetch), fallback);
  // The reservation covers the primary (per-token); a fallback answer is GPU-priced.
  assert.equal(wrapped.pricing, 'anthropic');
  const answer = await wrapped.complete(request());
  assert.equal(answer.pricing, 'gpu');
  assert.equal(sent.length, 1);
  assert.equal(fallbackCalls.length, 1);
  assert.equal(answer.text, 'From the fallback.');
  assert.equal(answer.model, 'hosted-model-1');
  // Both fail: the primary's code stays the cause (529 overloaded), the fallback's travels with
  // it, and a cold fallback is unreachable (never waited for).
  const cold = {
    model: 'g',
    complete: async () => {
      throw new AdapterError('waking');
    },
  };
  await assert.rejects(
    new FallbackAdapter(adapter(api({ status: 529 }).fetch), cold).complete(request()),
    (error) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, 'server_error');
      assert.equal(error.sent, false);
      assert.equal(error.detail.fallbackCode, 'unreachable');
      return true;
    },
  );
  // A bad request is the request's fault: no fallback.
  let called = false;
  const spy = {
    model: 'g',
    complete: async () => {
      called = true;
      throw new Error('x');
    },
  };
  await rejectsWith(
    new FallbackAdapter(adapter(api({ status: 400 }).fetch), spy).complete(request()),
    'bad_request',
  );
  assert.equal(called, false);
});

test('wiring: CITY_ELRIC_PROVIDER selects the provider; no health probe; T1 model without a URL', async () => {
  const k = key();
  const env = {
    CITY_ELRIC_PROVIDER: 'anthropic',
    CITY_ELRIC_ANTHROPIC_KEY: k,
    CITY_ELRIC_T1_MODEL: 'hosted-model-1',
  };
  assert.deepEqual(elricEndpoints(env), {});
  const { fetch, sent } = api();
  const wiring = elricModels(env, { fetch })!;
  assert.deepEqual(wiring.adapters, {});
  assert.equal(wiring.adapterFor(1).model, 'hosted-model-1');
  assert.equal(wiring.adapterFor(2).model, 'hosted-model-1');
  await wiring.adapterFor(2).complete(request({ maxOutputTokens: 5000 }));
  assert.equal(sent[0]!.body.max_tokens, 2400);
  // The builder refuses invalid values (no values in the messages)...
  assert.throws(
    () => elricAnthropicModels({ CITY_ELRIC_PROVIDER: 'anthropic' }),
    /CITY_ELRIC_ANTHROPIC_KEY/,
  );
  assert.throws(
    () => elricAnthropicModels({ ...env, CITY_ELRIC_FALLBACK_URL: 'https://fallback.example' }),
    /set together/,
  );
  const withFallback = elricModels({
    ...env,
    CITY_ELRIC_FALLBACK_URL: 'https://fallback.example',
    CITY_ELRIC_FALLBACK_MODEL: 'fallback-model',
  })!;
  assert.ok(withFallback.adapterFor(1) instanceof FallbackAdapter);
  // openai (or unset) keeps the self-hosted wiring.
  assert.equal(elricModels({ CITY_ELRIC_PROVIDER: 'openai' }), null);
});

test('label invariant: a hosted-model reply is "Elric · AI" with the public model elric-1.0', () => {
  assert.equal(elricReplyLabel('hosted-model-1'), 'Elric · AI');
  assert.equal(elricPublicModel('hosted-model-1'), ELRIC_PUBLIC_MODEL);
  assert.equal(ELRIC_PUBLIC_MODEL, 'elric-1.0');
});

test('end to end: a tool step and a reply through the service; no model name in the room', async (t) => {
  const { fetch, sent } = api(
    { json: message([{ type: 'tool_use', id: 'toolu_1', name: 'room_read', input: {} }]) },
    { json: message([{ type: 'text', text: 'All quiet here.' }]) },
  );
  const models = elricModels(
    {
      CITY_ELRIC_PROVIDER: 'anthropic',
      CITY_ELRIC_ANTHROPIC_KEY: key(),
      CITY_ELRIC_T1_MODEL: 'hosted-model-1',
    },
    { fetch },
  )!;
  const f = await elricFixture(t, { models });
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric summarize the room', s.person);
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.equal(result?.outcome, 'ok');
  assert.equal(sent.length, 2);
  // The second call carries the tool result as a native tool_result block.
  const second = sent[1]!.body.messages as Array<{ content: Array<{ type: string }> }>;
  assert.equal(second.at(-1)!.content.at(-1)!.type, 'tool_result');
  const rows = await f.messages(s.room.id);
  const reply = rows.find((row) => row.sender_agent_id === s.elricId)!;
  assert.equal(reply.parts[0]!.text, 'All quiet here.');
  assert.doesNotMatch(JSON.stringify(rows), /claude|haiku|anthropic/i);
});

test('end to end: provider down and no fallback → the plain failure line, allowance refunded', async (t) => {
  // Overloaded on the first try and on its one retry.
  const { fetch } = api({ status: 529 }, { status: 529 });
  const models = elricModels(
    {
      CITY_ELRIC_PROVIDER: 'anthropic',
      CITY_ELRIC_ANTHROPIC_KEY: key(),
      CITY_ELRIC_T1_MODEL: 'hosted-model-1',
    },
    { fetch },
  )!;
  const f = await elricFixture(t, { models });
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric are you there?', s.person);
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.deepEqual([result?.outcome, result?.reason], ['error', 'server_error']);
  const fromElric = (await f.messages(s.room.id)).filter(
    (row) => row.sender_agent_id === s.elricId,
  );
  assert.deepEqual(
    fromElric.map((row) => row.parts[0]?.text),
    [ELRIC_MODEL_FAILED_REPLY],
  );
  assert.equal((await f.usage(s.owner.operatorId))!.short, 0);
});

test('a refused key (401/403) alerts ops through the webhook, then falls back', async () => {
  const k = key();
  const posts: Array<{ url: string; body: string }> = [];
  const logs: string[] = [];
  const { fetch } = api({ status: 401 }, { status: 403 });
  const answered: string[] = [];
  const wiring = elricAnthropicModels(
    {
      CITY_ELRIC_PROVIDER: 'anthropic',
      CITY_ELRIC_T1_MODEL: 'hosted-model-1',
      CITY_ELRIC_ANTHROPIC_KEY: k,
      CITY_ELRIC_FALLBACK_URL: 'https://fallback.example',
      CITY_ELRIC_FALLBACK_MODEL: 'fallback-model',
      CITY_OPS_ALERT_WEBHOOK: 'https://hooks.example/ops',
    },
    {
      fetch: async (url, init) => {
        if (url.startsWith('https://fallback.example')) {
          answered.push(url);
          const json = JSON.stringify({
            model: 'fallback-model',
            choices: [{ message: { content: 'From the fallback.' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          });
          return { status: 200, text: async () => json };
        }
        return fetch(url, init);
      },
      alertTransport: async (url, body) => {
        posts.push({ url, body });
        return { status: 200 };
      },
      log: (line) => logs.push(line),
    },
  );
  const first = await wiring.adapterFor(1).complete(request());
  assert.equal(first.text, 'From the fallback.');
  await wiring.adapterFor(1).complete(request());
  assert.equal(answered.length, 2);
  // One alert (throttled), to the webhook, naming no key.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.url, 'https://hooks.example/ops');
  assert.match(posts[0]!.body, /refused the key/);
  assert.ok(!posts[0]!.body.includes(k));
  assert.ok(logs.some((line) => line.includes('elric_provider_key_refused')));
  assert.ok(!logs.join('\n').includes(k));
});

test('the fallback URL must be https on a deployment', () => {
  const env = {
    CITY_ELRIC_PROVIDER: 'anthropic',
    CITY_ELRIC_T1_MODEL: 'hosted-model-1',
    CITY_ELRIC_ANTHROPIC_KEY: key(),
    CITY_ELRIC_FALLBACK_URL: 'http://127.0.0.1:8000',
    CITY_ELRIC_FALLBACK_MODEL: 'fallback-model',
  };
  assert.throws(() => elricAnthropicModels(env, { hosted: true, allowLoopback: true }), /loopback/);
  assert.throws(
    () =>
      elricAnthropicModels(
        { ...env, CITY_ELRIC_FALLBACK_URL: 'http://fallback.example' },
        { hosted: true },
      ),
    /https/,
  );
  assert.throws(
    () =>
      elricAnthropicModels({
        ...env,
        VERCEL: '1',
        CITY_ELRIC_FALLBACK_URL: 'http://fallback.example',
      }),
    /https/,
  );
  // Local development may use a loopback fallback.
  assert.ok(elricAnthropicModels(env, { hosted: false }));
});

test('the model id comes only from the environment: Tier 1 or unavailable, Tier 2 defaults to it', async () => {
  const base = { CITY_ELRIC_PROVIDER: 'anthropic', CITY_ELRIC_ANTHROPIC_KEY: key() };
  // Unset: no startup failure; every call is model_unavailable.
  const none = elricAnthropicModels(base);
  await assert.rejects(
    none.adapterFor(1).complete(request()),
    (error) => error instanceof AdapterError && error.code === 'model_unavailable',
  );
  const one = elricAnthropicModels({ ...base, CITY_ELRIC_T1_MODEL: 'model-one' });
  assert.equal(one.adapterFor(1).model, 'model-one');
  assert.equal(one.adapterFor(2).model, 'model-one');
  const two = elricAnthropicModels({
    ...base,
    CITY_ELRIC_T1_MODEL: 'model-one',
    CITY_ELRIC_T2_MODEL: 'model-two',
  });
  assert.equal(two.adapterFor(2).model, 'model-two');
});

test('an invalid Elric configuration never stops the app: Elric is unavailable and ops get one log line', async () => {
  const k = key();
  for (const env of [
    { CITY_ELRIC_PROVIDER: 'anthropic' },
    { CITY_ELRIC_PROVIDER: 'anthropic', CITY_ELRIC_ANTHROPIC_KEY: 'short' },
    { CITY_ELRIC_PROVIDER: 'anthropic', CITY_ELRIC_ANTHROPIC_KEY: `bad key ${k}` },
    { CITY_ELRIC_PROVIDER: 'other' },
    {
      CITY_ELRIC_PROVIDER: 'anthropic',
      CITY_ELRIC_ANTHROPIC_KEY: k,
      CITY_ELRIC_FALLBACK_URL: 'https://fallback.example',
    },
  ]) {
    const logs: string[] = [];
    const wiring = elricModels(env, { log: (line) => logs.push(line) })!;
    await assert.rejects(
      wiring.adapterFor(1).complete(request()),
      (error) => error instanceof AdapterError && error.code === 'model_unavailable',
    );
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /"event":"elric_config_invalid"/);
    assert.ok(!logs[0]!.includes(k), 'no key value in the log');
  }
});

test('a 429 carries its Retry-After; a fallback that was down is skipped for a minute', async () => {
  const limited: FetchLike = async () => ({
    status: 429,
    headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '3' : null) },
    text: async () => '{}',
  });
  await assert.rejects(adapter(limited).complete(request()), (error) => {
    assert.ok(error instanceof AdapterError);
    assert.deepEqual([error.code, error.detail.retryAfterMs], ['rate_limited', 3000]);
    return true;
  });
  let now = 0;
  let fallbackCalls = 0;
  const down = {
    model: 'g',
    complete: async (r: ModelRequest) => {
      fallbackCalls++;
      // Never more than its share of the time left.
      assert.ok((r.timeoutMs ?? 0) <= 10_000, `${r.timeoutMs}`);
      throw new AdapterError('timeout', true);
    },
  };
  const wrapped = new FallbackAdapter(
    adapter(api({ status: 529 }, { status: 529 }, { status: 529 }).fetch),
    down,
    () => now,
  );
  const codes = async () =>
    wrapped
      .complete(request({ timeoutMs: 20_000 }))
      .catch((error: AdapterError) => [error.code, error.detail.fallbackCode ?? null]);
  assert.deepEqual(await codes(), ['server_error', 'timeout']);
  now += 30_000;
  assert.deepEqual(await codes(), ['server_error', null]);
  assert.equal(fallbackCalls, 1);
  now += 31_000;
  await codes();
  assert.equal(fallbackCalls, 2);
});
