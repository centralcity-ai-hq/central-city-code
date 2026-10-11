import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AdapterError, type ModelAdapter, type ModelRequest } from '../server/elric/adapter.js';
import {
  ELRIC_CUT_SHORT_MARKER,
  ELRIC_PARTIAL_MIN_CHARS,
  closeOpenFence,
  cutPartial,
} from '../server/elric/reply.js';
import { ELRIC_MODEL_FAILED_REPLY } from '../server/elric/service.js';
import { elricFixture } from './elric-fixture.js';

type Fixture = Awaited<ReturnType<typeof elricFixture>>;

/** A model that streams `text` and then fails, on every call (so the one retry fails too). */
function breaksOff(text: string, code: 'server_error' | 'timeout' = 'server_error', then?: string) {
  const adapter: ModelAdapter & { calls: number } = {
    model: 'mock-small',
    calls: 0,
    complete: async (request: ModelRequest) => {
      adapter.calls++;
      // After the failing call and its retry: an answer (the title call of a private chat).
      if (then !== undefined && adapter.calls > 2)
        return {
          text: then,
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 3 },
          model: 'mock-small',
        };
      for (let end = 8; end < text.length + 8; end += 8)
        request.onText?.(text.slice(0, Math.min(end, text.length)));
      throw new AdapterError(code, true);
    },
  };
  return adapter;
}

async function ask(t: Parameters<typeof elricFixture>[0], adapter: ModelAdapter, ask = 'hi') {
  const logs: string[] = [];
  const f = await elricFixture(t, {
    models: { adapterFor: () => adapter, adapters: {} },
    log: (line) => logs.push(line),
  });
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, `@Elric ${ask}`, s.person);
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  const posted = (await f.messages(s.room.id))
    .filter((row) => row.sender_agent_id === s.elricId)
    .map((row) => row.parts[0]?.text);
  return { f, s, result, posted, logs };
}

const drafts = async (f: Fixture) =>
  Number((await f.db.query<{ n: string }>('SELECT count(*) AS n FROM elric_drafts')).rows[0]!.n);

test('cutPartial: back to the last complete sentence, fences closed, graphemes whole', () => {
  const long = 'The plan has three parts and Dana owns the first one. The second is still op';
  assert.equal(cutPartial(long), 'The plan has three parts and Dana owns the first one.');
  // No sentence or line boundary: no partial at all (never the raw stream).
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicr';
  assert.equal(cutPartial(words), null);
  assert.equal(cutPartial(`キーは${'あ'.repeat(50)}sk-ant-api03-Ab`), null);
  // A "." as the last character of the stream is not a sentence end ("3." of "3.50").
  const price = 'Dana asked about the plan. The total for the whole team this month is 3.';
  assert.equal(cutPartial(price), null);
  assert.equal(cutPartial(`${price}5`), null);
  const twoSentences = `${'The first sentence is complete and long enough here. '}The cost is 3.`;
  assert.equal(cutPartial(twoSentences), 'The first sentence is complete and long enough here.');
  // Full-width sentence ends count (with something after them).
  const cjk = `${'今日の会議は午後三時に始まり、資料は共有フォルダにあります'.repeat(2)}。次に`;
  assert.equal(cutPartial(cjk), cjk.slice(0, -2));
  // A ZWJ emoji sequence is never split.
  const family = '👩‍👩‍👧';
  // The stream ends inside a second ZWJ sequence: the cut keeps the first one whole.
  const zwj = `${'word '.repeat(8)}see ${family}\nand ${family}`.slice(0, -3);
  assert.equal(cutPartial(zwj), `${'word '.repeat(8)}see ${family}`);
  assert.equal(cutPartial(`${'word '.repeat(8)}see ${family}`), null);
  // An open fence is closed with the same fence.
  const code = 'Here is the script you asked for:\n```ts\nconst a = 1;\nconst b =';
  assert.equal(cutPartial(code), 'Here is the script you asked for:\n```ts\nconst a = 1;\n```');
  assert.equal(closeOpenFence('a\n```\nb\n```'), 'a\n```\nb\n```');
  assert.equal(closeOpenFence('a\n~~~~\nb'), 'a\n~~~~\nb\n~~~~');
});

test('a stream that breaks off after real text posts that text, marked cut short', async (t) => {
  const text =
    'Here is the summary for Dana. The launch moved to Friday because the review ran long. Then th';
  const adapter = breaksOff(text);
  const { f, s, result, posted, logs } = await ask(t, adapter);
  assert.equal(adapter.calls, 2, 'the retry ran and failed too');
  assert.deepEqual([result?.outcome, result?.reason], ['error', 'partial:server_error']);
  assert.deepEqual(posted, [
    `Here is the summary for Dana. The launch moved to Friday because the review ran long.\n\n${ELRIC_CUT_SHORT_MARKER}`,
  ]);
  // The model wrote it: the AI label, not the automated one.
  const stamp = (
    await f.db.query<{ auto_reply: { label?: string; model?: string } | null }>(
      'SELECT auto_reply FROM room_messages WHERE room_id=$1 AND sender_agent_id=$2',
      [s.room.id, s.elricId],
    )
  ).rows[0]?.auto_reply;
  assert.equal(stamp?.label, 'Elric · AI');
  // The draft became the message: nothing of it is left.
  assert.equal(await drafts(f), 0);
  // Logged with the code and a length, never the content.
  const line = logs
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((l) => l.event === 'elric_turn_partial');
  assert.ok(line, logs.join('\n'));
  assert.equal(line.code, 'server_error');
  assert.equal(typeof line.chars, 'number');
  assert.doesNotMatch(logs.join('\n'), /launch|Dana/);
});

test('the partial goes through the reply checks: mentions stripped, open code fence closed', async (t) => {
  const text =
    'Ask @Dana about it. Here is the snippet:\n```js\nconst total = items.length;\nconsole.lo';
  const { posted } = await ask(t, breaksOff(text));
  assert.deepEqual(posted, [
    `Ask Dana about it. Here is the snippet:\n\`\`\`js\nconst total = items.length;\n\`\`\`\n\n${ELRIC_CUT_SHORT_MARKER}`,
  ]);
});

test('a partial with a credential fails the checks: the plain fallback line, nothing of it', async (t) => {
  const key = `sk-ant-${'a1B2'.repeat(8)}`;
  const text = `Sure, the deploy key is ${key} and you can use it now. And then the ot`;
  const { result, posted } = await ask(t, breaksOff(text));
  assert.deepEqual([result?.outcome, result?.reason], ['error', 'server_error']);
  assert.deepEqual(posted, [ELRIC_MODEL_FAILED_REPLY]);
});

test('a credential after the cut point still refuses the partial: the fallback line', async (t) => {
  const key = `sk-ant-${'a1B2'.repeat(8)}`;
  const text = `Here is the summary for Dana. The launch moved to Friday. The key is ${key} so`;
  const { result, posted } = await ask(t, breaksOff(text));
  assert.deepEqual([result?.outcome, result?.reason], ['error', 'server_error']);
  assert.deepEqual(posted, [ELRIC_MODEL_FAILED_REPLY]);
});

test('a CJK stream with a key fragment and no boundary: the fallback line', async (t) => {
  const text = `キーは${'あ'.repeat(50)}sk-ant-api03-Ab`;
  const { posted } = await ask(t, breaksOff(text));
  assert.deepEqual(posted, [ELRIC_MODEL_FAILED_REPLY]);
});

test('a stream ending on "3." is not cut there', async (t) => {
  const text = 'Dana asked about the plan for the whole team today. The total this month is 3.';
  const { posted } = await ask(t, breaksOff(text));
  assert.deepEqual(posted, [
    `Dana asked about the plan for the whole team today.\n\n${ELRIC_CUT_SHORT_MARKER}`,
  ]);
});

test(`below ${ELRIC_PARTIAL_MIN_CHARS} visible characters: the plain fallback line`, async (t) => {
  const { result, posted } = await ask(t, breaksOff('Sure. The answer is'));
  assert.deepEqual([result?.outcome, result?.reason], ['error', 'server_error']);
  assert.deepEqual(posted, [ELRIC_MODEL_FAILED_REPLY]);
});

test('billing: a partial costs what the calls consumed, once, and keeps the allowance count', async (t) => {
  const long =
    'Here is the summary for Dana. The launch moved to Friday because the review ran long. x';
  const partial = await ask(t, breaksOff(long));
  const fallback = await ask(t, breaksOff('Too short'));
  const [pTurn] = await partial.f.turns(partial.s.owner.operatorId);
  const [fTurn] = await fallback.f.turns(fallback.s.owner.operatorId);
  // Two charged attempts (the failure and its retry) either way: the same units, recorded once.
  assert.ok(Number(pTurn!.cost_units) > 0);
  assert.equal(pTurn!.cost_units, fTurn!.cost_units);
  assert.equal((await partial.f.turns(partial.s.owner.operatorId)).length, 1);
  const pUsage = await partial.f.usage(partial.s.owner.operatorId);
  const fUsage = await fallback.f.usage(fallback.s.owner.operatorId);
  assert.equal(Number(pUsage!.spent_units), Math.ceil(Number(pTurn!.cost_units)));
  assert.equal(pUsage!.spent_units, fUsage!.spent_units);
  assert.equal(Number(pUsage!.reserved_units), 0);
  // The owner got an answer: the allowance count stays used. The fallback gives it back.
  const count = (u: typeof pUsage) => u!.short + u!.summary + u!.tool;
  assert.equal(count(pUsage), 1);
  assert.equal(count(fUsage), 0);
});

test('the private /elric chat gets the cut-short answer too', async (t) => {
  const text =
    'Your week has two deadlines for Dana and one review on Thursday. The second deadline i';
  const adapter = breaksOff(text, 'server_error', '"Week plan"');
  const f = await elricFixture(t, { models: { adapterFor: () => adapter, adapters: {} } });
  const owner = await f.account('Chat owner');
  await f.verify(owner);
  const added = await f.call(owner.cookie, 'POST', '/api/elric', {});
  assert.ok(added.statusCode < 300, added.body);
  const elricId = added.json().agent_id as string;
  const chat = await f.call(owner.cookie, 'GET', '/api/elric/chat');
  assert.equal(chat.statusCode, 200, chat.body);
  const roomId = chat.json().room_id as string;
  const members = (await f.call(owner.cookie, 'GET', `/api/rooms/${roomId}/members`)).json()
    .members as Array<{ id: string; kind: string; own: boolean }>;
  const person = members.find((m) => m.own && m.kind === 'person')!;
  const sent = await f.call(owner.cookie, 'POST', `/api/rooms/${roomId}/messages`, {
    text: '@Elric what is on this week?',
    agent_id: person.id,
    idempotency_key: randomUUID(),
  });
  assert.equal(sent.statusCode, 201, sent.body);
  await f.elric.drain();
  const posted = (await f.messages(roomId))
    .filter((row) => row.sender_agent_id === elricId)
    .map((row) => row.parts[0]?.text);
  // The first reply, though cut short, still names the conversation.
  const conversations = (await f.call(owner.cookie, 'GET', '/api/elric/conversations')).json()
    .conversations as Array<{ id: string; title: string }>;
  assert.equal(conversations.find((c) => c.id === roomId)?.title, 'Week plan');
  assert.deepEqual(posted.slice(-1), [
    `Your week has two deadlines for Dana and one review on Thursday.\n\n${ELRIC_CUT_SHORT_MARKER}`,
  ]);
});
