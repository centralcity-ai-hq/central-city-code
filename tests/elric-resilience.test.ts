import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  AdapterError,
  MockAdapter,
  type FetchLike,
  type ModelAdapter,
} from '../server/elric/adapter.js';
import { FallbackAdapter } from '../server/elric/anthropic.js';
import { elricModels } from '../server/elric/endpoints.js';
import { messageAsEventStream } from './elric-sse.js';
import {
  ELRIC_PRIOR_REPLY_CHARS,
  ELRIC_TRANSCRIPT_TOKENS,
  transcript,
} from '../server/elric/context.js';
import { ELRIC_MODEL_FAILED_REPLY } from '../server/elric/service.js';
import { estimateTokens } from '../server/elric/token-cost.js';
import type { PromptMessage } from '../server/responder/prompt.js';
import { elricFixture } from './elric-fixture.js';

const msg = (seq: number, text: string, autoReply = false): PromptMessage => ({
  seq,
  sender: autoReply ? 'Elric' : 'Dana',
  owner: 'Dana',
  autoReply,
  parts: [{ type: 'text', text }],
});

test('the transcript is bounded by estimated tokens, not by the message count', () => {
  // 100 long messages (about 3,900 characters each), the trigger last.
  const messages = Array.from({ length: 100 }, (_, i) => msg(i + 1, 'x'.repeat(3_900)));
  const lines = transcript(messages, 100, 1_000_000);
  const tokens = lines.reduce((sum, line) => sum + estimateTokens(line.length + 1), 0);
  assert.ok(tokens <= ELRIC_TRANSCRIPT_TOKENS, `${tokens} tokens`);
  assert.ok(lines.length < 100 && lines.length > 10, `${lines.length} lines`);
  // The newest messages win, and the trigger is always there.
  assert.equal(JSON.parse(lines.at(-1)!).seq, 100);
  // The character bound still applies when it is the smaller one.
  assert.ok(transcript(messages, 100, 10_000).join('\n').length <= 10_000 + 4_100);
});

test('earlier long AI replies are shortened in the context; people and the trigger are not', () => {
  const report = `## Testing report\n${'line of a long report\n'.repeat(400)}`;
  const person = 'y'.repeat(3_000);
  const lines = transcript(
    [msg(1, report, true), msg(2, person), msg(3, report, true)],
    3,
    1_000_000,
  );
  const [first, second, third] = lines.map((line) => JSON.parse(line) as { text: string });
  assert.ok(first!.text.length <= ELRIC_PRIOR_REPLY_CHARS + 40, `${first!.text.length}`);
  assert.match(first!.text, /^## Testing report/);
  assert.match(first!.text, /\[earlier reply shortened\]$/);
  assert.equal(second!.text, person);
  // The trigger itself is never shortened beyond the usual per-message clip.
  assert.ok(third!.text.length > ELRIC_PRIOR_REPLY_CHARS * 2);
});

test('a transient model error is retried once, then the answer is posted', async (t) => {
  const logs: string[] = [];
  const f = await elricFixture(t, { log: (line) => logs.push(line) });
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric are you there?', s.person);
  f.small.push({ error: 'server_error' }, { text: 'Yes, here.' });
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.equal(result?.outcome, 'ok');
  assert.equal(f.small.calls, 2);
  const fromElric = (await f.messages(s.room.id)).filter(
    (row) => row.sender_agent_id === s.elricId,
  );
  assert.deepEqual(
    fromElric.map((row) => row.parts[0]?.text),
    ['Yes, here.'],
  );
  assert.deepEqual(logs, []);
});

for (const code of ['rate_limited', 'timeout', 'unreachable'] as const)
  test(`${code} is retried too`, async (t) => {
    const f = await elricFixture(t);
    const s = await f.scene();
    const trigger = await f.say(s.owner, s.room, '@Elric hi', s.person);
    f.small.push({ error: code }, { text: 'Hi!' });
    const result = await f.elric.run({
      agentId: s.elricId,
      roomId: s.room.id,
      sourceSeq: trigger.message.seq,
    });
    assert.equal(result?.outcome, 'ok');
    assert.equal(f.small.calls, 2);
  });

test('a persistent failure posts the fallback line and logs the code, nothing else', async (t) => {
  const logs: string[] = [];
  const f = await elricFixture(t, { log: (line) => logs.push(line) });
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric secret plans for Dana?', s.person);
  f.small.push({ error: 'server_error' }, { error: 'server_error' });
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.deepEqual([result?.outcome, result?.reason], ['error', 'server_error']);
  assert.equal(f.small.calls, 2);
  const fromElric = (await f.messages(s.room.id)).filter(
    (row) => row.sender_agent_id === s.elricId,
  );
  assert.deepEqual(
    fromElric.map((row) => row.parts[0]?.text),
    [ELRIC_MODEL_FAILED_REPLY],
  );
  assert.equal(logs.length, 1);
  const line = JSON.parse(logs[0]!) as Record<string, unknown>;
  assert.equal(line.event, 'elric_turn_failed');
  assert.equal(line.code, 'server_error');
  assert.equal(line.retried, 'server_error');
  // Codes only: no prompt text, no names, no ids.
  assert.doesNotMatch(logs[0]!, /secret|Dana|mock|[0-9a-f]{8}-[0-9a-f]{4}/i);
});

test('a non-transient error (bad request) is not retried', async (t) => {
  const logs: string[] = [];
  const f = await elricFixture(t, { log: (line) => logs.push(line) });
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric hi', s.person);
  f.small.push({ error: 'bad_request' });
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.deepEqual([result?.outcome, result?.reason], ['error', 'bad_request']);
  assert.equal(f.small.calls, 1);
  assert.equal((JSON.parse(logs[0]!) as { retried: unknown }).retried, null);
});

test('no retry when the run has too little time left for one', async (t) => {
  let now = 0;
  const f = await elricFixture(t, {
    wallClock: () => now,
    config: { runBudgetMs: 10_000, minCallMs: 4_000, callMarginMs: 2_000 },
  });
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric hi', s.person);
  f.small.push(() => {
    now += 3_000; // the failed call used most of the run
    return { error: 'server_error' };
  });
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.deepEqual([result?.outcome, result?.reason], ['error', 'server_error']);
  assert.equal(f.small.calls, 1);
});

type Fixture = Awaited<ReturnType<typeof elricFixture>>;
const scenes = new WeakMap<Fixture, Awaited<ReturnType<Fixture['scene']>>>();
const run = async (f: Fixture, text: string) => {
  if (!scenes.has(f)) scenes.set(f, await f.scene());
  const s = scenes.get(f)!;
  const trigger = await f.say(s.owner, s.room, text, s.person);
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  const posted = (await f.messages(s.room.id))
    .filter((row) => row.sender_agent_id === s.elricId)
    .map((row) => row.parts[0]?.text);
  return { result, posted };
};

test('a charged failure is recorded before the retry, so a cut-off run settles both attempts', async (t) => {
  let f: Awaited<ReturnType<typeof elricFixture>> | undefined;
  let calls = 0;
  let during: { spent_units: string; inflight_units: string } | undefined;
  const flaky: ModelAdapter = {
    model: 'm',
    complete: async () => {
      calls++;
      if (calls === 1) throw new AdapterError('server_error', true);
      during = (
        await f!.db.query<{ spent_units: string; inflight_units: string }>(
          'SELECT spent_units, inflight_units FROM elric_invocations',
        )
      ).rows[0];
      return {
        text: 'Done.',
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'm',
      };
    },
  };
  f = await elricFixture(t, { models: { adapterFor: () => flaky, adapters: {} } });
  const { result } = await run(f, '@Elric hi');
  assert.equal(result?.outcome, 'ok');
  assert.ok(Number(during!.spent_units) > 0, 'the failed attempt is counted');
  assert.equal(during!.inflight_units, during!.spent_units, 'the retry is in flight');
});

test('a timeout is retried only when the run has as long again left', async (t) => {
  let now = 0;
  const f = await elricFixture(t, {
    wallClock: () => now,
    config: { runBudgetMs: 20_000, minCallMs: 1_000, callMarginMs: 500 },
  });
  // A slow timeout (12 s of 20 s): no room for another such call.
  f.small.push(() => {
    now += 12_000;
    return { error: 'timeout' };
  });
  assert.equal((await run(f, '@Elric one')).result?.reason, 'timeout');
  assert.equal(f.small.calls, 1);
  // A quick one (3 s): retried.
  now = 0;
  f.small.push(
    () => {
      now += 3_000;
      return { error: 'timeout' };
    },
    { text: 'Two.' },
  );
  const second = await run(f, '@Elric two');
  assert.equal(second.result?.outcome, 'ok');
  assert.equal(f.small.calls, 3);
});

test('a 429 waits its Retry-After when the run has the time, else it is not retried', async (t) => {
  const waits: number[] = [];
  let calls = 0;
  const limited = (retryAfterMs: number): ModelAdapter => ({
    model: 'm',
    complete: async () => {
      calls++;
      if (calls % 2 === 1) throw new AdapterError('rate_limited', false, { retryAfterMs });
      return { text: 'Ok.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: 'm' };
    },
  });
  let current = limited(3_000);
  const f = await elricFixture(t, {
    models: { adapterFor: () => current, adapters: {} },
    sleep: async (ms) => void waits.push(ms),
  });
  assert.equal((await run(f, '@Elric a')).result?.outcome, 'ok');
  assert.deepEqual(waits, [3_000]);
  calls = 0;
  current = limited(120_000);
  assert.equal((await run(f, '@Elric b')).result?.reason, 'rate_limited');
  assert.equal(calls, 1);
});

test('a failure in the middle of the stream is retried; the retry answers', async (t) => {
  const stream = (events: unknown[]) =>
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const replies = [
    stream([
      {
        type: 'message_start',
        message: { type: 'message', content: [], usage: { input_tokens: 5 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half an' } },
      { type: 'error', error: { type: 'overloaded_error' } },
    ]),
    messageAsEventStream({
      type: 'message',
      content: [{ type: 'text', text: 'The whole answer.' }],
      usage: { input_tokens: 5, output_tokens: 4 },
    }),
  ];
  const fetch: FetchLike = async () => {
    const body = replies.shift()!;
    return { status: 200, text: async () => body };
  };
  const models = elricModels(
    {
      CITY_ELRIC_PROVIDER: 'anthropic',
      CITY_ELRIC_ANTHROPIC_KEY: randomBytes(24).toString('hex'),
      CITY_ELRIC_T1_MODEL: 'hosted-model-1',
    },
    { fetch },
  )!;
  const f = await elricFixture(t, { models });
  const { result, posted } = await run(f, '@Elric are you there?');
  assert.equal(result?.outcome, 'ok');
  assert.deepEqual(posted, ['The whole answer.']);
});

test('fallback down: the primary cause and the fallback code are both logged', async (t) => {
  const logs: string[] = [];
  const primary = new MockAdapter('hosted-model-1');
  primary.push({ error: 'server_error' }, { error: 'server_error' });
  const fallback = new MockAdapter('fallback-model');
  fallback.push({ error: 'unreachable' }, { error: 'unreachable' });
  const wrapped = new FallbackAdapter(primary, fallback);
  const f = await elricFixture(t, {
    models: { adapterFor: () => wrapped, adapters: {} },
    log: (line) => logs.push(line),
  });
  const { result, posted } = await run(f, '@Elric hi');
  assert.deepEqual([result?.outcome, result?.reason], ['error', 'server_error']);
  assert.deepEqual(posted, [ELRIC_MODEL_FAILED_REPLY]);
  // The retry skips the fallback that was just down (circuit breaker).
  assert.deepEqual([primary.calls, fallback.calls], [2, 1]);
  const line = JSON.parse(logs[0]!) as Record<string, unknown>;
  assert.deepEqual([line.primary_code, line.fallback_code], ['server_error', 'unreachable']);
});
