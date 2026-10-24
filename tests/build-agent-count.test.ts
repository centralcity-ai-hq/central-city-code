import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUILD_AGENT_COUNT_TIMEOUT_MS,
  BUILD_AGENT_COUNT_URL,
  fetchBuildAgentCount,
  fetchBuildHomeStats,
} from '../scripts/prerender/agent-count.js';

/*
 * The landing's agent count, read once at build time (scripts/prerender/agent-count.ts). Every
 * failure gives null (the landing is built without a number) and never throws, so it can never
 * fail the build.
 */

type Fetch = typeof globalThis.fetch;

const json = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function recorder(answer: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return answer(url, init);
  }) as unknown as Fetch;
  return { calls, fetch };
}

function quiet() {
  const messages: string[] = [];
  return { messages, warn: (message: string) => messages.push(message) };
}

test('success: the count and its time from the production endpoint', async () => {
  const { calls, fetch } = recorder(async () =>
    json({ ai_agents_total: 114_251, updated_at: '2026-10-05T12:00:00.000Z' }),
  );
  const log = quiet();
  const count = await fetchBuildAgentCount({ env: {}, fetch, warn: log.warn });
  assert.deepEqual(count, { total: 114_251, at: Date.parse('2026-10-05T12:00:00.000Z') });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, BUILD_AGENT_COUNT_URL);
  assert.equal(BUILD_AGENT_COUNT_URL, 'https://centralcity.ai/api/public/stats');
  assert.ok(calls[0]!.init?.signal, 'the request can be aborted');
  assert.deepEqual(log.messages, []);
});

test('CC_BUILD_AGENT_COUNT_URL points the build at another endpoint', async () => {
  const { calls, fetch } = recorder(async () =>
    json({ ai_agents_total: 7, updated_at: '2026-10-05T12:00:00.000Z' }),
  );
  const env = { CC_BUILD_AGENT_COUNT_URL: 'http://127.0.0.1:4310/api/public/stats' };
  assert.equal((await fetchBuildAgentCount({ env, fetch, warn: quiet().warn }))?.total, 7);
  assert.equal(calls[0]!.url, 'http://127.0.0.1:4310/api/public/stats');
});

test('timeout: a hanging endpoint gives null after the timeout and the request is aborted', async () => {
  assert.equal(BUILD_AGENT_COUNT_TIMEOUT_MS, 5_000);
  let aborted = false;
  const { fetch } = recorder(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
  );
  const log = quiet();
  const started = Date.now();
  const count = await fetchBuildAgentCount({ env: {}, fetch, timeoutMs: 50, warn: log.warn });
  assert.equal(count, null);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(aborted, true);
  assert.match(log.messages.join('\n'), /no answer within 50 ms/);
});

test('timeout: a fetch that ignores its signal still cannot hold the build', async () => {
  const { fetch } = recorder(() => new Promise<Response>(() => undefined));
  const count = await fetchBuildAgentCount({
    env: {},
    fetch,
    timeoutMs: 50,
    warn: quiet().warn,
  });
  assert.equal(count, null);
});

test('timeout: a body that never finishes counts against the same timeout', async () => {
  const { fetch } = recorder(async () => {
    const response = json({});
    return Object.assign(response, { json: () => new Promise(() => undefined) }) as Response;
  });
  const count = await fetchBuildAgentCount({
    env: {},
    fetch,
    timeoutMs: 50,
    warn: quiet().warn,
  });
  assert.equal(count, null);
});

test('invalid JSON and unusable bodies give null, with a warning, never a throw', async () => {
  const bodies: unknown[] = [
    'not json{',
    '',
    null,
    [],
    {},
    { ai_agents_total: '114251', updated_at: '2026-10-05T12:00:00.000Z' },
    { ai_agents_total: 1.5, updated_at: '2026-10-05T12:00:00.000Z' },
    { ai_agents_total: -3, updated_at: '2026-10-05T12:00:00.000Z' },
    // A 0 is never baked into the page.
    { ai_agents_total: 0, updated_at: '2026-10-05T12:00:00.000Z' },
    { ai_agents_total: 12, updated_at: 'yesterday' },
    { ai_agents_total: 12 },
  ];
  for (const body of bodies) {
    const { fetch } = recorder(async () => json(body === null ? 'null' : body));
    const log = quiet();
    assert.equal(
      await fetchBuildAgentCount({ env: {}, fetch, warn: log.warn }),
      null,
      JSON.stringify(body),
    );
    assert.equal(log.messages.length, 1, JSON.stringify(body));
  }
});

test('an error status or a network failure gives null', async () => {
  for (const answer of [
    async () => json({ ai_agents_total: 5, updated_at: '2026-10-05T12:00:00.000Z' }, 503),
    async () => {
      throw new TypeError('fetch failed');
    },
  ]) {
    const { fetch } = recorder(answer);
    const log = quiet();
    assert.equal(await fetchBuildAgentCount({ env: {}, fetch, warn: log.warn }), null);
    assert.match(log.messages[0]!, /the landing is built without one/);
  }
  // A fetch that throws synchronously, too.
  const throwing = (() => {
    throw new Error('boom');
  }) as unknown as Fetch;
  assert.equal(await fetchBuildAgentCount({ env: {}, fetch: throwing, warn: quiet().warn }), null);
});

test('CC_BUILD_AGENT_COUNT fixes the count without any request', async () => {
  const { calls, fetch } = recorder(async () => {
    throw new Error('no request expected');
  });
  const now = () => Date.parse('2026-10-05T12:00:00.000Z');
  assert.deepEqual(
    await fetchBuildAgentCount({ env: { CC_BUILD_AGENT_COUNT: '123456' }, fetch, now }),
    { total: 123_456, at: now() },
  );
  // 0, "off" or anything that is not a positive integer: built without a count.
  for (const value of ['0', 'off', '-5', '1.5', '12abc', '99999999999999999999'])
    assert.equal(
      await fetchBuildAgentCount({ env: { CC_BUILD_AGENT_COUNT: value }, fetch, now }),
      null,
      value,
    );
  assert.equal(calls.length, 0);
});

test('paid_calls in the response reserves the paid calls line; no paid number is carried', async () => {
  const at = '2026-10-15T12:00:00.000Z';
  const paid = (total: unknown) => ({
    ai_agents_total: 114_251,
    updated_at: at,
    paid_calls: { total, as_of: at, recent_ms: [1_200], recent_complete: true },
  });
  const cases: Array<[string, unknown, boolean]> = [
    ['shown', paid(1_284), true],
    ['a total of 1', paid(1), true],
    ['a total of 0 (hidden on the page)', paid(0), false],
    ['not a count', paid('1284'), false],
    ['no field (switched off, or no count yet)', { ai_agents_total: 7, updated_at: at }, false],
    [
      'only the Base agents number',
      { ai_agents_total: 7, updated_at: at, base_agents: { total: 31_452, as_of: at } },
      true,
    ],
    [
      'Base agents 0 and no paid calls',
      { ai_agents_total: 7, updated_at: at, base_agents: { total: 0, as_of: at } },
      false,
    ],
  ];
  for (const [label, body, reserved] of cases) {
    const { fetch } = recorder(async () => json(body));
    const stats = await fetchBuildHomeStats({ env: {}, fetch, warn: quiet().warn });
    assert.equal(stats.paidCalls, reserved, label);
    // Only whether to reserve the line: the build never holds the paid calls number (or the
    // value settled); only the agent count and the Base agents number are carried.
    assert.deepEqual(Object.keys(stats).sort(), ['base', 'count', 'paidCalls'], label);
    assert.equal(typeof stats.paidCalls, 'boolean', label);
  }
  // The agent count is unchanged by the field, and a failure reserves nothing.
  const { fetch } = recorder(async () => json(paid(1_284)));
  assert.deepEqual(await fetchBuildAgentCount({ env: {}, fetch, warn: quiet().warn }), {
    total: 114_251,
    at: Date.parse(at),
  });
  const failing = recorder(async () => json({ error: 'down' }, 503));
  assert.deepEqual(
    await fetchBuildHomeStats({ env: {}, fetch: failing.fetch, warn: quiet().warn }),
    {
      count: null,
      base: null,
      paidCalls: false,
    },
  );
  // A body without a usable agent count still says whether to reserve the paid line.
  const noCount = recorder(async () =>
    json({ paid_calls: { total: 5, as_of: at, recent_ms: [], recent_complete: true } }),
  );
  assert.deepEqual(
    await fetchBuildHomeStats({ env: {}, fetch: noCount.fetch, warn: quiet().warn }),
    {
      count: null,
      base: null,
      paidCalls: true,
    },
  );
});

test('offline builds: CC_BUILD_PAID_CALLS=1 reserves the line with a fixed count, without any request', async () => {
  const { calls, fetch } = recorder(async () => {
    throw new Error('no request expected');
  });
  const now = () => Date.parse('2026-10-15T12:00:00.000Z');
  assert.deepEqual(
    await fetchBuildHomeStats({
      env: { CC_BUILD_AGENT_COUNT: '123456', CC_BUILD_PAID_CALLS: '1' },
      fetch,
      now,
    }),
    { count: { total: 123_456, at: now() }, base: null, paidCalls: true },
  );
  for (const value of [undefined, '0', 'yes', '2'])
    assert.equal(
      (
        await fetchBuildHomeStats({
          env: { CC_BUILD_AGENT_COUNT: 'off', CC_BUILD_PAID_CALLS: value },
          fetch,
          now,
        })
      ).paidCalls,
      false,
      String(value),
    );
  assert.equal(calls.length, 0);
});

test('the Base agents number is carried from 1 up, with its time; a 0 or no field carries none', async () => {
  const at = '2026-10-15T12:00:00.000Z';
  const body = (base: unknown) => ({
    ai_agents_total: 114_251,
    updated_at: at,
    ...(base === undefined ? {} : { base_agents: base }),
  });
  const cases: Array<[string, unknown, { total: number; asOf: number } | null]> = [
    ['a number', { total: 31_452, as_of: at }, { total: 31_452, asOf: Date.parse(at) }],
    ['1', { total: 1, as_of: at }, { total: 1, asOf: Date.parse(at) }],
    ['0 (never a 0 in the HTML)', { total: 0, as_of: at }, null],
    ['not a count', { total: '31452', as_of: at }, null],
    ['no time', { total: 31_452 }, null],
    ['no field', undefined, null],
  ];
  for (const [label, base, expected] of cases) {
    const { fetch } = recorder(async () => json(body(base)));
    assert.deepEqual(
      (await fetchBuildHomeStats({ env: {}, fetch, warn: quiet().warn })).base,
      expected,
      label,
    );
  }
  // Without a usable agent count the Base agents number is still carried.
  const noCount = recorder(async () => json({ base_agents: { total: 9, as_of: at } }));
  assert.deepEqual(
    (await fetchBuildHomeStats({ env: {}, fetch: noCount.fetch, warn: quiet().warn })).base,
    { total: 9, asOf: Date.parse(at) },
  );
});

test('offline builds: CC_BUILD_BASE_AGENTS bakes a fixed Base agents number, without any request', async () => {
  const { calls, fetch } = recorder(async () => {
    throw new Error('no request expected');
  });
  const now = () => Date.parse('2026-10-15T12:00:00.000Z');
  assert.deepEqual(
    await fetchBuildHomeStats({
      env: { CC_BUILD_AGENT_COUNT: '123456', CC_BUILD_BASE_AGENTS: '31452' },
      fetch,
      now,
    }),
    {
      count: { total: 123_456, at: now() },
      base: { total: 31_452, asOf: now() },
      paidCalls: false,
    },
  );
  for (const value of [undefined, '', '0', 'off', '-3', '1.5'])
    assert.equal(
      (
        await fetchBuildHomeStats({
          env: { CC_BUILD_AGENT_COUNT: '7', CC_BUILD_BASE_AGENTS: value },
          fetch,
          now,
        })
      ).base,
      null,
      String(value),
    );
  assert.equal(calls.length, 0);
});
