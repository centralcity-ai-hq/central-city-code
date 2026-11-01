import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdapterError,
  checkBaseUrl,
  MockAdapter,
  OpenAICompatibleAdapter,
  type FetchLike,
} from '../server/elric/adapter.js';
import { route } from '../server/elric/router.js';
import { checkToolCall, toolSpecs } from '../server/elric/tools.js';
import { containsCredential, stripMentions } from '../server/elric/reply.js';
import { argsHash } from '../server/elric/turns.js';
import {
  ELRIC_CONFIG,
  ELRIC_COST_UNIT_USD,
  ELRIC_GLOBAL_DAILY_UNITS,
  ELRIC_GLOBAL_DAILY_USD,
  resetAt,
} from '../server/elric/config.js';
import { isReservedElricName } from '../server/elric/names.js';
import { killSwitchOn, reserve } from '../server/elric/budget.js';

/** Elric pure units: router, tool gate, reply checks, and the OpenAI-compatible adapter. */

test('router: Tier 0 lookups need no model; summaries and tool tasks go to Tier 2', () => {
  for (const text of ['@Elric who is here?', "@Elric who's here", 'who is in this room @Elric'])
    assert.deepEqual(route(text), { tier: 0, handler: 'members' }, text);
  for (const text of [
    '@Elric open tasks',
    '@Elric list open tasks',
    '@Elric what are the open tasks?',
  ])
    assert.deepEqual(route(text), { tier: 0, handler: 'tasks' }, text);
  assert.deepEqual(route('@Elric please summarize the thread'), { tier: 2, kind: 'summary' });
  assert.deepEqual(route('@Elric riassumi la discussione'), { tier: 2, kind: 'summary' });
  assert.deepEqual(route('@Elric create a task for the deploy fix'), { tier: 2, kind: 'tool' });
  assert.deepEqual(route('@Elric what port did the e2e run use?'), { tier: 1, kind: 'short' });
  // Not an exact lookup: goes to a model.
  assert.deepEqual(route('@Elric who is here and what did they decide?'), {
    tier: 1,
    kind: 'short',
  });
});

test('tool gate: two room tools bound to the invoking room, the unbound help tool; everything else refused', () => {
  const room = 'room-1';
  assert.deepEqual(
    toolSpecs(true).map((tool) => tool.name),
    ['room_read', 'city_help', 'room_task_create'],
  );
  assert.deepEqual(
    toolSpecs(false).map((tool) => tool.name),
    ['room_read', 'city_help'],
  );
  for (const name of [
    'city_control',
    'city_create_room',
    'city_request_connection',
    'city_set_wake_webhook',
    'city_room_apply',
    'city_room_post',
    'room_post',
    '',
  ])
    assert.deepEqual(checkToolCall({ id: 'c', name, args: { room_id: room } }, room, true), {
      ok: false,
      status: 'refused_not_allowed',
    });
  // The name is allowed, the room is not: refused before argument validation.
  assert.deepEqual(
    checkToolCall(
      { id: 'c', name: 'room_task_create', args: { room_id: 'room-2', title: 'x' } },
      room,
      true,
    ),
    { ok: false, status: 'refused_room' },
  );
  assert.deepEqual(checkToolCall({ id: 'c', name: 'room_read', args: null }, room, true), {
    ok: false,
    status: 'refused_room',
  });
  assert.deepEqual(
    checkToolCall(
      { id: 'c', name: 'room_task_create', args: { room_id: room, title: 'x' } },
      room,
      false,
    ),
    { ok: false, status: 'refused_disabled' },
  );
  assert.deepEqual(
    checkToolCall({ id: 'c', name: 'room_read', args: { room_id: room, extra: 1 } }, room, true),
    { ok: false, status: 'refused_args' },
  );
  const ok = checkToolCall(
    { id: 'c', name: 'room_task_create', args: { room_id: room, title: ' Fix it ' } },
    room,
    true,
  );
  assert.deepEqual(ok, {
    ok: true,
    name: 'room_task_create',
    args: { room_id: room, title: 'Fix it' },
  });
});

test('reply checks: no live mentions, no credentials; argument hashes are canonical', () => {
  assert.equal(stripMentions('Ping @Host desk and @"Ann Lee"'), 'Ping Host desk and "Ann Lee"');
  assert.equal(stripMentions('mail ann@example.com'), 'mail ann@example.com');
  assert.equal(containsCredential(`here: crc_${'a'.repeat(24)}`), true);
  assert.equal(containsCredential(`key sk-${'b'.repeat(24)}`), true);
  assert.equal(containsCredential('nothing secret here'), false);
  assert.equal(
    argsHash({ b: 1, a: [1, { d: 2, c: 3 }] }),
    argsHash({ a: [1, { c: 3, d: 2 }], b: 1 }),
  );
  assert.notEqual(argsHash({ a: 1 }), argsHash({ a: 2 }));
  assert.equal(
    new Date(resetAt(Date.UTC(2026, 8, 30, 23, 59))).toISOString(),
    '2026-10-01T00:00:00.000Z',
  );
});

test('MockAdapter records what it received and can be scripted with tool calls and errors', async () => {
  const mock = new MockAdapter('m');
  mock.push(
    { toolCalls: [{ name: 'city_control', args: { action: 'revoke' } }] },
    { error: 'timeout' },
  );
  const request = {
    system: 's',
    messages: [{ role: 'user' as const, content: 'u' }],
    maxOutputTokens: 10,
  };
  const first = await mock.complete(request);
  assert.equal(first.toolCalls[0]!.name, 'city_control');
  await assert.rejects(
    mock.complete(request),
    (error) => (error as AdapterError).code === 'timeout',
  );
  assert.equal((await mock.complete(request)).text, 'Mock reply.');
  assert.equal(mock.calls, 3);
  assert.equal(mock.requests[0]!.messages[0]!.role, 'user');
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => text,
  };
}

test('OpenAI-compatible adapter: fixed URL, no redirects, text and tool calls parsed', async () => {
  const seen: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({ url, init });
    return jsonResponse(200, {
      model: 'served-model',
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 't1',
                type: 'function',
                function: { name: 'room_read', arguments: '{"room_id":"r"}' },
              },
              {
                id: 't2',
                type: 'function',
                function: { name: 'room_read', arguments: 'not json' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 7 },
    });
  };
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: 'https://models.example.test/serve',
    model: 'elric-small',
    fetch,
  });
  const result = await adapter.complete({
    system: 'sys',
    messages: [{ role: 'user', content: 'hello' }],
    tools: toolSpecs(false),
    maxOutputTokens: 600,
  });
  assert.equal(seen[0]!.url, 'https://models.example.test/serve/v1/chat/completions');
  assert.equal(seen[0]!.init.redirect, 'error');
  assert.equal(seen[0]!.init.headers.authorization, undefined, 'no bearer unless configured');
  const sent = JSON.parse(seen[0]!.init.body!);
  assert.equal(sent.model, 'elric-small');
  assert.equal(sent.max_tokens, 600);
  assert.equal(sent.messages[0].role, 'system');
  assert.equal(sent.tools[0].function.name, 'room_read');
  assert.deepEqual(result.toolCalls, [
    { id: 't1', name: 'room_read', args: { room_id: 'r' } },
    { id: 't2', name: 'room_read', args: null },
  ]);
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 7, reported: true });
  assert.equal(result.model, 'served-model');
});

test('OpenAI-compatible adapter: every failure is a fixed code', async () => {
  const cases: Array<[FetchLike, string]> = [
    [async () => jsonResponse(401, { error: { message: 'secret detail' } }), 'unauthorized'],
    [async () => jsonResponse(403, {}), 'unauthorized'],
    [async () => jsonResponse(404, {}), 'model_unavailable'],
    [async () => jsonResponse(413, {}), 'too_large'],
    [async () => jsonResponse(429, {}), 'rate_limited'],
    [async () => jsonResponse(500, {}), 'server_error'],
    // 503 is a scale-from-zero endpoint starting: the service waits and retries (elric-wake).
    [async () => jsonResponse(503, {}), 'waking'],
    [async () => jsonResponse(502, {}), 'server_error'],
    [async () => jsonResponse(504, {}), 'server_error'],
    [async () => jsonResponse(400, {}), 'bad_request'],
    [async () => jsonResponse(302, {}, { location: 'https://elsewhere.test/' }), 'bad_response'],
    [async () => jsonResponse(200, 'not json'), 'bad_response'],
    [async () => jsonResponse(200, { choices: [] }), 'bad_response'],
    [async () => jsonResponse(200, { choices: [{ message: { content: null } }] }), 'bad_response'],
    [async () => jsonResponse(200, 'x', { 'content-length': '5000000' }), 'too_large'],
    [
      async () => ({
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array(100_000));
            controller.close();
          },
        }),
      }),
      'too_large',
    ],
    [
      async () => {
        throw new TypeError('getaddrinfo ENOTFOUND secret-host');
      },
      'unreachable',
    ],
    [
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
      'timeout',
    ],
  ];
  for (const [fetch, code] of cases) {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://models.example.test',
      model: 'm',
      fetch,
      timeoutMs: 30,
    });
    await assert.rejects(
      adapter.complete({
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        maxOutputTokens: 5,
      }),
      (error) => {
        assert.ok(error instanceof AdapterError);
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /secret/);
        return true;
      },
    );
  }
  // An oversized request is refused before any network call.
  let called = false;
  const big = new OpenAICompatibleAdapter({
    baseUrl: 'https://models.example.test',
    model: 'm',
    fetch: async () => {
      called = true;
      return jsonResponse(200, {});
    },
  });
  await assert.rejects(
    big.complete({ system: 'x'.repeat(600_000), messages: [], maxOutputTokens: 5 }),
    (error) => (error as AdapterError).code === 'too_large',
  );
  assert.equal(called, false);
});

test('OpenAI-compatible adapter: only https (http on loopback), no credentials in the URL', () => {
  assert.throws(() => checkBaseUrl('http://models.example.test'));
  assert.throws(() => checkBaseUrl('https://user:pass@models.example.test'));
  assert.throws(() => checkBaseUrl('https://models.example.test/?key=1'));
  assert.throws(() => checkBaseUrl('ftp://models.example.test'));
  assert.throws(() => checkBaseUrl('not a url'));
  assert.equal(checkBaseUrl('http://127.0.0.1:8000').host, '127.0.0.1:8000');
  assert.equal(checkBaseUrl('https://models.example.test').host, 'models.example.test');
  const withKey = new OpenAICompatibleAdapter({
    baseUrl: 'http://localhost:8000',
    model: 'm',
    apiKey: 'test-token-0001',
    fetch: async (_url, init) => {
      assert.equal(init.headers.authorization, 'Bearer test-token-0001');
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    },
  });
  return withKey
    .complete({ system: 's', messages: [], maxOutputTokens: 5 })
    .then((result) => assert.equal(result.text, 'ok'));
});

test('money controls fail closed: a database error is a refusal and a killed switch', async () => {
  const broken = {
    transaction: async () => {
      throw new Error('database unavailable');
    },
    query: async () => {
      throw new Error('database unavailable');
    },
  };
  const result = await reserve(
    broken,
    ELRIC_CONFIG,
    {
      ownerId: 'o',
      kind: 'short',
      units: 16,
      day: '2026-09-30',
      invocation: { agentId: 'a', roomId: 'r', sourceSeq: 1, leaseId: 'l' },
    },
    {},
  );
  assert.deepEqual(result, { ok: false, reason: 'unavailable' });
  assert.equal(await killSwitchOn(broken, {}), true);
  assert.equal(await killSwitchOn(broken, { CITY_ELRIC_KILL: '1' }), true);
});

test('the global ceiling in cost units equals the USD 50/day budget (H3)', () => {
  assert.equal(ELRIC_COST_UNIT_USD, 0.000001);
  assert.equal(ELRIC_GLOBAL_DAILY_UNITS, 50_000_000);
  assert.equal(
    Math.round(ELRIC_CONFIG.globalDailyUnits * ELRIC_COST_UNIT_USD),
    ELRIC_GLOBAL_DAILY_USD,
  );
  assert.equal(ELRIC_GLOBAL_DAILY_USD, 50);
  // The lease outlives a full run of adapter calls (8 × 20 s) plus a margin.
  assert.ok(ELRIC_CONFIG.leaseMs >= ELRIC_CONFIG.maxSteps * 20_000 + 10_000);
});

test('reserved name folding: case, NFKC, invisibles, punctuation and look-alikes', () => {
  for (const name of [
    'Elric',
    'eLrIc',
    'ＥＬＲＩＣ',
    'E|ric',
    'E1ric',
    'EIric',
    'E.l.r.i.c',
    'Еlгіс',
    'Élric',
    'ᴇʟʀɪᴄ',
  ])
    assert.equal(isReservedElricName(name), true, name);
  for (const name of ['Elric Fan', 'Eric', 'Elrico', 'Alric', ''])
    assert.equal(isReservedElricName(name), false, name);
});

test('reserved name folding: whole look-alike scripts (Lisu, Cherokee in both cases)', () => {
  for (const name of [
    '\ua4f0\ua4e1\ua4e3\ua4f2\ua4da', // Lisu
    '\u13ac\u13de\u13a1\u13a5\u13df', // Cherokee
    '\uab7c\uabae\uab71\uab75\uabaf', // Cherokee small letters
    'E\ua4e1r\u13a5c', // mixed with Latin
  ])
    assert.equal(isReservedElricName(name), true, JSON.stringify(name));
  // Ordinary names in these scripts stay free.
  for (const name of ['\u13e3\u13b3\u13a9', '\ua4e1\ua4f2\ua4e2\ua4ee'])
    assert.equal(isReservedElricName(name), false, JSON.stringify(name));
});
