import test from 'node:test';
import assert from 'node:assert/strict';
import type { Member, RoomMessage } from '../src/rooms/api.js';
import { getAgentAnswering, isAgentId } from '../src/rooms/api.js';
import {
  autoReplyRowState,
  cantAnswerLine,
  type MentionAnswering,
} from '../src/agents/useAgentAnswering.js';
import { autoReplyModelName } from '../src/agents/v4/settingsActionsModel.js';
import { autoReplyPause } from '../src/agents/v4/settingsActionsModel.js';
import type { ResponderSettingsView } from '../src/responder/contract.js';
import {
  mentionCantAnswerLine,
  mentionedNames,
  ownMentionTargets,
  pauseReason,
} from '../src/rooms/mentionHint.js';

/*
 * "<agent> can’t answer yet" under your own @mention in a group room (src/rooms/mentionHint.ts):
 * which of your messages and agents it is about, and the line it shows. Synthetic data, plus the
 * exact shapes production sent (the live regression at the end).
 */

const member = (id: string, name: string, extra: Partial<Member> = {}): Member => ({
  id,
  name,
  role: 'member',
  owner_label: 'Account 00000001',
  own: false,
  joined_at: '2026-10-01T00:00:00.000Z',
  ...extra,
});
let seq = 0;
const message = (sender: Member, text: string, extra: Partial<RoomMessage> = {}): RoomMessage => ({
  id: `m${++seq}`,
  seq,
  origin: 'external',
  sender: sender.name,
  sender_agent_id: sender.id,
  sender_owner_label: sender.owner_label,
  own: sender.own,
  text,
  parts: [{ type: 'text', text }],
  created_at: '2026-10-01T00:00:00.000Z',
  sender_kind: sender.kind ?? 'agent',
  ...extra,
});

const me = member('p1', 'Hana', { kind: 'person', own: true });
const lion = member('a1', 'Lion', { role: 'host', own: true });
const scout = member('a2', 'Scout', { own: true });
const lionKing = member('a3', 'Lion King', { owner_label: 'Account 00000002' });
const bea = member('p2', 'Bea', { kind: 'person', owner_label: 'Account 00000002' });
const members = [me, lion, scout, lionKing, bea];
const answer = (extra: Partial<MentionAnswering>): MentionAnswering => ({
  agent_id: 'a1',
  can: false,
  by: null,
  auto_reply: 'none',
  runtime_connected: false,
  ...extra,
});

test('mentionedNames: @Name at a word start, longest name first, any case, no emails', () => {
  const names = ['Lion', 'Lion King', 'Scout'];
  assert.deepEqual(
    [...mentionedNames('hi @lion, and @Lion King too', names)],
    ['lion', 'lion king'],
  );
  assert.deepEqual([...mentionedNames('@Lion King only', names)], ['lion king']);
  assert.deepEqual([...mentionedNames('mail me at x@Lion or @Lionel', names)], []);
  assert.deepEqual([...mentionedNames('no mention of Lion', names)], []);
});

test('ownMentionTargets: your newest own mention of each of your agents', () => {
  const first = message(me, '@Lion are you there?');
  const second = message(me, '@Lion hello again, and @Scout');
  const targets = ownMentionTargets([first, second], members);
  assert.deepEqual([...targets.keys()], [second.id]);
  assert.deepEqual(
    targets.get(second.id)!.map((agent) => agent.id),
    ['a1', 'a2'],
  );
});

test('ownMentionTargets: nothing once the agent has posted after the mention', () => {
  const ask = message(me, '@Lion summarize please');
  const reply = message(lion, 'Here is the summary.');
  assert.equal(ownMentionTargets([ask, reply], members).size, 0);
});

test('ownMentionTargets: never another owner’s agent, nor someone else’s message', () => {
  // Bea mentions your Lion; you mention another owner's Lion King.
  const theirs = message(bea, '@Lion what do you think?');
  const other = message(me, '@Lion King what do you think?');
  assert.equal(ownMentionTargets([theirs, other], members).size, 0);
});

test('ownMentionTargets: written as one of your agents, your own host is no mention', () => {
  const asScout = message(scout, '@Lion take a look');
  assert.equal(ownMentionTargets([asScout], members).size, 0);
  // Written as Lion, @Scout mentions Scout (not the host).
  const asLion = message(lion, '@Scout take a look');
  assert.deepEqual(
    ownMentionTargets([asLion], members)
      .get(asLion.id)!
      .map((agent) => agent.id),
    ['a2'],
  );
});

test('ownMentionTargets: Elric and your own auto-replies are left out', () => {
  const elric = member('e1', 'Elric', { own: true, auto_reply: { provider: 'elric' } });
  const ask = message(me, '@Elric help');
  assert.equal(ownMentionTargets([ask], [...members, elric]).size, 0);
  const auto = message(scout, '@Lion done', { auto_reply: { provider: 'anthropic' } });
  assert.equal(ownMentionTargets([auto], members).size, 0);
});

const AUTO = '/agents#agent=a1:autoreply';

test('mentionCantAnswerLine: no Auto-reply and no AI: how to make it answer, both fixes', () => {
  assert.deepEqual(mentionCantAnswerLine('Lion', 'a1', answer({})), {
    text: 'Lion can’t reply here yet. To have Lion answer @mentions, set up Auto-reply (it replies with an AI model you choose) or connect an AI app to Lion. You can turn either off again at any time.',
    actions: [
      { label: 'Set up Auto-reply', href: AUTO },
      { label: 'Connect an AI app', href: '/#connect' },
    ],
  });
});

test('mentionCantAnswerLine: Auto-reply off says so and turns it on', () => {
  assert.deepEqual(mentionCantAnswerLine('Lion', 'a1', answer({ auto_reply: 'off' })), {
    text: 'Lion can’t reply here because its Auto-reply is off. Turn it on to have Lion answer @mentions; you can switch it off again at any time.',
    actions: [{ label: 'Turn on Auto-reply', href: AUTO }],
  });
});

test('mentionCantAnswerLine: a paused Auto-reply says why (pauseCopy) and its one fix', () => {
  const settings = (extra: Partial<ResponderSettingsView>): ResponderSettingsView =>
    ({
      agent_id: 'a1',
      enabled: true,
      status: 'paused',
      pause_reason: null,
      paused_until: null,
      provider: 'openai',
      model: 'm',
      instructions: '',
      daily_reply_cap: 100,
      daily_spend_cap_usd: 2,
      key: {
        provider: 'openai',
        added_at: '2026-10-01T00:00:00.000Z',
        validated_at: null,
        status: 'active',
      },
      replies_available: true,
      ...extra,
    }) as ResponderSettingsView;
  const paused = (extra: Partial<ResponderSettingsView>) =>
    mentionCantAnswerLine(
      'Lion',
      'a1',
      answer({ auto_reply: 'paused', pause: autoReplyPause(settings(extra), 0) }),
    );
  assert.deepEqual(paused({ pause_reason: 'quota' }), {
    text: 'Lion’s Auto-reply is paused: your OpenAI quota is used up. Resume it to have Lion answer @mentions again.',
    actions: [{ label: 'Resume', href: AUTO }],
  });
  assert.deepEqual(paused({ pause_reason: 'model_unavailable' }), {
    text: "Lion’s Auto-reply is paused: this key can't use the chosen model. Pick a model to have Lion answer @mentions again.",
    actions: [{ label: 'Pick a model', href: AUTO }],
  });
  assert.deepEqual(paused({ pause_reason: 'invalid_key' }), {
    text: 'Lion’s Auto-reply is paused: OpenAI rejected the key. Change the key to have Lion answer @mentions again.',
    actions: [{ label: 'Change key', href: AUTO }],
  });
  assert.deepEqual(paused({ pause_reason: 'invalid_key', key: null }), {
    text: 'Lion’s Auto-reply is paused: OpenAI rejected the key. Add a key to have Lion answer @mentions again.',
    actions: [{ label: 'Add a key', href: AUTO }],
  });
  assert.deepEqual(paused({ pause_reason: 'repeated_failures' }), {
    text: 'Lion’s Auto-reply is paused: repeated errors from OpenAI. Resume it to have Lion answer @mentions again.',
    actions: [{ label: 'Resume', href: AUTO }],
  });
  // Without a readable reason (settings unreadable, or none): paused, and Resume.
  assert.deepEqual(mentionCantAnswerLine('Lion', 'a1', answer({ auto_reply: 'paused' })), {
    text: 'Lion’s Auto-reply is paused. Resume it to have Lion answer @mentions again.',
    actions: [{ label: 'Resume', href: AUTO }],
  });
});

test('mentionCantAnswerLine: nothing when it can, or when the server can’t say', () => {
  assert.equal(
    mentionCantAnswerLine(
      'Lion',
      'a1',
      answer({ can: true, by: 'runtime', runtime_connected: true }),
    ),
    null,
  );
  // The server couldn't say (404, not your agent): nothing is guessed.
  assert.equal(mentionCantAnswerLine('Lion', 'a1', null), null);
  assert.equal(mentionCantAnswerLine('Lion', 'a1', undefined), null);
});

test('pauseReason: the reason inside pauseCopy’s words', () => {
  assert.equal(
    pauseReason('Paused: your OpenAI quota is used up.'),
    'your OpenAI quota is used up',
  );
  assert.equal(
    pauseReason('Paused for 5 min: OpenAI rate limit. It resumes by itself.'),
    'OpenAI rate limit',
  );
  assert.equal(pauseReason('Off: the key was removed.'), 'the key was removed');
  assert.equal(
    pauseReason('Paused after repeated errors from OpenAI.'),
    'repeated errors from OpenAI',
  );
  assert.equal(pauseReason('Paused.'), null);
});

/*
 * Regression (live, 11 Oct): the exact shapes production sent for a group room "Test" hosted by
 * the owner's own agent "Lion", where the owner, as a person, wrote "hey @Lion". Member ids are
 * agent ids (no agent_id field); the message carries mentions_you and no mentions list.
 */
const LIVE_LION = '2c9b7605-2823-4842-826e-9e109362c529';
const LIVE_ME = '89e9fc6a-df13-5757-88f5-bc2298a2d9e9';
const liveMembers = [
  {
    id: LIVE_LION,
    name: 'Lion',
    kind: 'agent',
    role: 'host',
    owner_label: 'Account a611f94b',
    own: true,
    joined_at: '2026-10-11T06:00:00.000Z',
    status: 'offline',
    active_now: false,
    auto_reply: null,
    guest: false,
    says: null,
  },
  {
    id: LIVE_ME,
    name: 'Basetester',
    kind: 'person',
    role: 'member',
    owner_label: 'Account a611f94b',
    own: true,
    joined_at: '2026-10-11T06:00:00.000Z',
    status: 'offline',
    active_now: false,
    auto_reply: null,
    guest: false,
    says: null,
  },
] as unknown as Member[];
const liveMessage = {
  id: '6f0e2b0c-0000-4000-8000-000000000001',
  seq: 1,
  origin: 'external',
  sender: 'Basetester',
  sender_agent_id: LIVE_ME,
  sender_owner_label: 'Account a611f94b',
  own: true,
  text: 'hey @Lion',
  parts: [{ text: 'hey @Lion', type: 'text' }],
  created_at: '2026-10-11T06:03:08.247Z',
  format: 'markdown',
  sender_kind: 'person',
  auto_reply: null,
  mentions_you: true,
} as unknown as RoomMessage;

test('live shapes: your "hey @Lion" as yourself names your host Lion; its line says why', () => {
  const targets = ownMentionTargets([liveMessage], liveMembers);
  assert.deepEqual(
    targets.get(liveMessage.id)!.map((agent) => agent.id),
    [LIVE_LION],
  );
  const live = {
    agent_id: LIVE_LION,
    can: false,
    by: null,
    auto_reply: 'none',
    runtime_connected: false,
  } as const;
  assert.equal(
    mentionCantAnswerLine('Lion', LIVE_LION, live)!.text,
    'Lion can’t reply here yet. To have Lion answer @mentions, set up Auto-reply (it replies with an AI model you choose) or connect an AI app to Lion. You can turn either off again at any time.',
  );
});

/*
 * Regression (live, 11 Oct): Lion is a CC agent; its scripted runtime's heartbeat made the route
 * answer can:true by:'runtime', so no line came under "hey @Lion" and Lion never replied. The
 * route now answers can:false for it, scripted, with the heartbeat still reported: the line shows,
 * and the private chat (and Lion's pane) say it can't answer yet, the same way.
 */
test('live shapes: a CC agent with a live scripted runtime gets the line; with Auto-reply on, none', () => {
  const scripted = {
    agent_id: LIVE_LION,
    can: false,
    by: null,
    auto_reply: 'none',
    runtime_connected: true,
    scripted: true,
  } as const;
  assert.deepEqual(mentionCantAnswerLine('Lion', LIVE_LION, scripted), {
    text: 'Lion can’t reply here yet. To have Lion answer @mentions, set up Auto-reply (it replies with an AI model you choose) or connect an AI app to Lion. You can turn either off again at any time.',
    actions: [
      { label: 'Set up Auto-reply', href: `/agents#agent=${LIVE_LION}:autoreply` },
      { label: 'Connect an AI app', href: '/#connect' },
    ],
  });
  assert.deepEqual(cantAnswerLine('Lion', scripted), {
    text: "Lion can't answer yet.",
    action: 'Set up Auto-reply',
  });
  const autoReply = { ...scripted, can: true, by: 'auto_reply', auto_reply: 'on' } as const;
  assert.equal(mentionCantAnswerLine('Lion', LIVE_LION, autoReply), null);
  assert.equal(cantAnswerLine('Lion', autoReply), null);
  // An AI runtime that is connected (not scripted) answers itself: no line anywhere.
  const ai = { ...scripted, can: true, by: 'runtime', scripted: false } as const;
  assert.equal(mentionCantAnswerLine('Lion', LIVE_LION, ai), null);
  assert.equal(cantAnswerLine('Lion', ai), null);
});

test("autoReplyRowState: the agent pane's Auto-reply row, one state per answer", () => {
  const base = {
    agent_id: LIVE_LION,
    can: false,
    by: null,
    auto_reply: 'none',
    runtime_connected: false,
    scripted: false,
  } as const;
  // 1. Can't answer, Auto-reply never set up or off (a CC agent's scripted runtime too).
  for (const answer of [
    base,
    { ...base, auto_reply: 'off' },
    { ...base, runtime_connected: true, scripted: true },
  ] as const)
    assert.deepEqual(autoReplyRowState('Hugo', answer), {
      tone: 'off',
      hint: "Hugo can't reply yet",
      action: 'Set up',
    });
  // 2. Can't answer because Auto-reply is paused.
  assert.deepEqual(autoReplyRowState('Hugo', { ...base, auto_reply: 'paused' }), {
    tone: 'paused',
    hint: "Hugo won't reply",
    action: 'Resume',
  });
  // 3. Answers through Auto-reply: with the model's name when it was read, else without.
  const on = { ...base, can: true, by: 'auto_reply', auto_reply: 'on' } as const;
  assert.deepEqual(autoReplyRowState('Hugo', on, 'Model A'), {
    tone: 'on',
    hint: 'Hugo replies with Model A',
    value: 'On',
  });
  for (const label of [undefined, null, '', '  '])
    assert.deepEqual(autoReplyRowState('Hugo', on, label), {
      tone: 'on',
      hint: 'Hugo replies',
      value: 'On',
    });
  // Auto-reply on while an AI app is connected too: Auto-reply is what answers.
  assert.deepEqual(autoReplyRowState('Hugo', { ...on, runtime_connected: true }, 'Model B'), {
    tone: 'on',
    hint: 'Hugo replies with Model B',
    value: 'On',
  });
  // 4. Answers through a connected AI app, Auto-reply not on (the model is never named).
  // The value is Auto-reply's own state: Off, or Paused when it was paused.
  for (const autoReply of ['none', 'off', 'paused'] as const)
    assert.deepEqual(
      autoReplyRowState(
        'Hugo',
        { ...base, can: true, by: 'runtime', auto_reply: autoReply, runtime_connected: true },
        'Model A',
      ),
      {
        tone: 'on',
        hint: 'Hugo replies through an AI app',
        value: autoReply === 'paused' ? 'Paused' : 'Off',
      },
    );
  // Auto-reply set up and on, but it can't answer right now (a key or limit problem): Fix.
  assert.deepEqual(autoReplyRowState('Hugo', { ...base, auto_reply: 'on' }), {
    tone: 'off',
    hint: "Hugo can't reply right now",
    action: 'Fix',
  });
  // A scripted runtime (CC agent) never counts as an AI app, even if a server said it answers.
  const scripted = {
    ...base,
    can: true,
    by: 'runtime',
    runtime_connected: true,
    scripted: true,
  } as const;
  assert.deepEqual(autoReplyRowState('Lion', scripted, 'Model A'), {
    tone: 'off',
    hint: "Lion can't reply yet",
    action: 'Set up',
  });
  assert.deepEqual(autoReplyRowState('Lion', { ...scripted, auto_reply: 'paused' }), {
    tone: 'paused',
    hint: "Lion won't reply",
    action: 'Resume',
  });
  // A scripted CC agent with Auto-reply on replies with its model.
  assert.deepEqual(
    autoReplyRowState('Lion', { ...on, runtime_connected: true, scripted: true }, 'Model A'),
    { tone: 'on', hint: 'Lion replies with Model A', value: 'On' },
  );
  // 5. Unknown (or removed: no answer is asked for): the plain row, nothing guessed.
  assert.deepEqual(autoReplyRowState('Hugo', null), { tone: null });
  assert.deepEqual(autoReplyRowState('Hugo', { ...base, can: true }), { tone: null });
  // No hint ends in a full stop.
  for (const answer of [base, { ...base, auto_reply: 'paused' }, on] as const) {
    const row = autoReplyRowState('Hugo', answer);
    assert.ok(row.tone && !row.hint.endsWith('.'));
  }
});

test('autoReplyModelName: the model as the Auto-reply screen names it', () => {
  const models = [
    {
      provider: 'anthropic',
      id: 'model-a',
      name: 'Model A',
      est_cost_per_reply_usd: 0.01,
      default: true,
    },
  ] as const;
  assert.equal(autoReplyModelName({ provider: 'anthropic', model: 'model-a' }, models), 'Model A');
  assert.equal(autoReplyModelName({ provider: 'anthropic', model: 'model-b' }, models), 'model-b');
  assert.equal(autoReplyModelName({ provider: 'openai', model: 'model-a' }, models), 'model-a');
  assert.equal(autoReplyModelName({ provider: 'anthropic', model: null }, []), null);
});

test('getAgentAnswering: never asks without a real id (no GET /api/agents/undefined/answering)', async () => {
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return new Response(JSON.stringify({}), { status: 400 });
  }) as typeof fetch;
  try {
    for (const id of [undefined, null, '', ' ', 'undefined', 'null'])
      assert.equal(await getAgentAnswering(id as string | undefined), null);
    assert.deepEqual(asked, []);
    assert.equal(isAgentId(LIVE_LION), true);
  } finally {
    globalThis.fetch = original;
  }
});
