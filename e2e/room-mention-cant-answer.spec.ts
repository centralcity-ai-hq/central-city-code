import { test, expect, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/*
 * In a group room, your own @mention of one of YOUR agents that can't answer yet gets one quiet
 * line under it: what is wrong, how to make the agent answer (and that it can be switched off
 * again), links into the agent's screens (Auto-reply) or Connect AI, and "Only you see this."
 * Not for an agent that can answer, not for another owner's agent (it is never even asked about),
 * not under someone else's message, and other members never see it. The answering route
 * (GET /api/agents/:id/answering, owner only) is answered by the test, with the exact shape the
 * live server sends ({agent_id, can, by, auto_reply, runtime_connected}, and `scripted` since a
 * CC agent's scripted runtime stopped counting as one that answers).
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

async function account(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `${name}-${randomUUID().slice(0, 6)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  return page;
}

async function personId(page: Page, roomId: string) {
  const res = await page.request.get(`/api/rooms/${roomId}/members`, { headers });
  const members = (await res.json()).members as Array<{ id: string; own: boolean; kind?: string }>;
  return members.find((m) => m.own && m.kind === 'person')!.id;
}

async function say(page: Page, roomId: string, text: string, agentId?: string) {
  const posted = await page.request.post(`/api/rooms/${roomId}/messages`, {
    headers,
    data: {
      text,
      idempotency_key: randomUUID(),
      agent_id: agentId ?? (await personId(page, roomId)),
    },
  });
  expect(posted.status(), await posted.text()).toBe(201);
}

const canAnswer = (id: string) => ({
  agent_id: id,
  can: true,
  by: 'runtime',
  auto_reply: 'none',
  runtime_connected: true,
});
const cannotAnswer = (id: string, autoReply: 'none' | 'off' | 'paused' = 'none') => ({
  agent_id: id,
  can: false,
  by: null,
  auto_reply: autoReply,
  runtime_connected: false,
});

const NONE_LINE = (name: string) =>
  `${name} can’t reply here yet. To have ${name} answer @mentions, set up Auto-reply (it replies with an AI model you choose) or connect an AI app to ${name}. You can turn either off again at any time.`;

/** Answers the answering route for this page and records which agents were asked about. */
async function answering(page: Page, answer: (id: string) => unknown): Promise<string[]> {
  const asked: string[] = [];
  await page.route('**/api/agents/*/answering', (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]!);
    asked.push(id);
    return route.fulfill({ json: answer(id) });
  });
  return asked;
}

test('your @mention of your own agent that can’t answer says why under it; nobody else sees it', async ({
  browser,
}) => {
  // The owner: "Lion" hosts the room; "Scout" is the owner's second agent in it. The owner is in
  // the room as a person from its creation.
  const owner = await account(browser, 'owner');
  const lion = await owner.request.post('/api/agents', {
    headers,
    data: { name: 'Lion', capability: 'research', mode: 'hosted' },
  });
  expect(lion.ok()).toBe(true);
  const lionId = (await lion.json()).agent.id as string;
  const room = await owner.request.post('/api/rooms', {
    headers,
    data: { agent_id: lionId, name: 'Pride', idempotency_key: randomUUID() },
  });
  expect(room.status()).toBe(201);
  const roomId = (await room.json()).room.id as string;
  const mint = async () =>
    (await (await owner.request.post(`/api/rooms/${roomId}/link`, { headers, data: {} })).json())
      .link as string;
  const scout = await owner.request.post(`/api/rooms/${roomId}/join`, {
    headers,
    data: {
      token: new URL(await mint()).hash.slice(1),
      create: { name: 'Scout' },
      idempotency_key: randomUUID(),
    },
  });
  expect(scout.ok(), await scout.text()).toBe(true);
  const scoutId = (await scout.json()).agent_id as string;

  // Bea joins as herself and brings her own agent, "Rex".
  const bea = await account(browser, 'bea');
  const joined = await bea.request.post('/api/rooms/join', {
    headers,
    data: { link: await mint(), name: 'Bea', idempotency_key: randomUUID() },
  });
  expect(joined.ok(), await joined.text()).toBe(true);
  const rex = await bea.request.post(`/api/rooms/${roomId}/join`, {
    headers,
    data: {
      token: new URL(await mint()).hash.slice(1),
      create: { name: 'Rex' },
      idempotency_key: randomUUID(),
    },
  });
  expect(rex.ok(), await rex.text()).toBe(true);
  const rexId = (await rex.json()).agent_id as string;

  // The owner, as themselves: Lion (can't answer), Scout (can), Bea's Rex. Bea mentions Lion.
  await say(owner, roomId, '@Lion please summarize the thread');
  await say(owner, roomId, '@Scout check the numbers');
  await say(owner, roomId, '@Rex what is your view?');
  await say(bea, roomId, 'Question for @Lion from me');

  // The owner's view: Lion can't answer; Scout can; anything else would say "can't" if asked.
  const asked = await answering(owner, (id) => (id === scoutId ? canAnswer(id) : cannotAnswer(id)));
  await owner.goto(`/rooms/${roomId}`);
  const messages = owner.getByTestId('room-message');
  const lionAsk = messages.filter({ hasText: 'please summarize the thread' });
  const hint = lionAsk.getByTestId('mention-cant-answer');
  await expect(hint).toHaveText(
    `${NONE_LINE('Lion')}Set up Auto-reply·Connect an AI appOnly you see this.`,
  );
  await expect(hint.getByRole('link', { name: 'Set up Auto-reply', exact: true })).toBeVisible();
  await expect(hint.getByRole('link', { name: 'Connect an AI app', exact: true })).toHaveAttribute(
    'href',
    '/#connect',
  );
  // One line in the whole room: none under Scout (it can answer), Rex (not yours) or Bea's.
  await expect(owner.getByTestId('mention-cant-answer')).toHaveCount(1);
  for (const text of ['check the numbers', 'what is your view?', 'Question for'])
    await expect(messages.filter({ hasText: text }).getByTestId('mention-cant-answer')).toHaveCount(
      0,
    );
  // Only the owner's own mentioned agents were asked about; never Bea's Rex.
  expect(new Set(asked)).toEqual(new Set([lionId, scoutId]));

  // Mentioning Lion again from the composer: the line moves under the newest mention.
  const box = owner.getByRole('textbox', { name: 'Message' });
  await box.fill('@Lion are you there?');
  await box.press('Enter');
  const again = messages.filter({ hasText: 'are you there?' });
  await expect(again.getByTestId('mention-cant-answer')).toContainText(NONE_LINE('Lion'));
  await expect(owner.getByTestId('mention-cant-answer')).toHaveCount(1);
  await expect(hint).toHaveCount(0);

  // Bea's view: no line anywhere, and her console never asks about anyone's agent.
  const beaAsked = await answering(bea, (id) => cannotAnswer(id));
  await bea.goto(`/rooms/${roomId}`);
  const beaMessages = bea.getByTestId('room-message');
  await expect(beaMessages.filter({ hasText: 'are you there?' })).toBeVisible();
  await expect(bea.getByTestId('mention-cant-answer')).toHaveCount(0);
  expect(beaAsked).toEqual([]);

  // The action opens Lion's Auto-reply screen in My agents.
  await again.getByRole('link', { name: 'Set up Auto-reply', exact: true }).click();
  await expect(owner).toHaveURL(/\/$/);
  const pane = owner.getByRole('complementary', { name: 'Lion details' });
  await expect(pane.getByRole('heading', { name: 'Auto-reply' }).first()).toBeVisible();
});

test('a paused Auto-reply says so; once your agent can answer, the line goes', async ({
  browser,
}) => {
  const owner = await account(browser, 'paused');
  const lion = await owner.request.post('/api/agents', {
    headers,
    data: { name: 'Lion', capability: 'research', mode: 'hosted' },
  });
  const lionId = (await lion.json()).agent.id as string;
  const room = await owner.request.post('/api/rooms', {
    headers,
    data: { agent_id: lionId, name: 'Pause room', idempotency_key: randomUUID() },
  });
  const roomId = (await room.json()).room.id as string;
  await say(owner, roomId, 'Hey @Lion, a quick question');

  let lionCan = false;
  await answering(owner, (id) => (lionCan ? canAnswer(id) : cannotAnswer(id, 'paused')));
  // Why it is paused comes from its Auto-reply settings (GET /api/agents/:id/responder): the
  // quota is used up, and its fix is Resume (src/responder/copy.ts pauseCopy).
  const settingsAsked: string[] = [];
  await owner.route('**/api/agents/*/responder', (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]!);
    settingsAsked.push(id);
    return route.fulfill({
      json: {
        agent_id: id,
        enabled: true,
        status: 'paused',
        pause_reason: 'quota',
        paused_until: null,
        provider: 'openai',
        model: 'gpt-test',
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
      },
    });
  });
  await owner.goto(`/rooms/${roomId}`);
  const hint = owner.getByTestId('mention-cant-answer');
  await expect(hint).toHaveText(
    'Lion’s Auto-reply is paused: your OpenAI quota is used up. Resume it to have Lion answer @mentions again.ResumeOnly you see this.',
  );
  await expect(hint.getByRole('link', { name: 'Resume', exact: true })).toHaveAttribute(
    'href',
    `/agents#agent=${lionId}:autoreply`,
  );
  expect(settingsAsked).toContain(lionId);
  // Lion can answer now (a runtime connected): the next read clears the line.
  lionCan = true;
  await owner.reload();
  await expect(
    owner.getByTestId('room-message').filter({ hasText: 'a quick question' }),
  ).toBeVisible();
  await expect(hint).toHaveCount(0);
});

test('Auto-reply off: the line says so, and Connect an AI app opens Connect your AI', async ({
  browser,
}) => {
  const owner = await account(browser, 'off');
  const lion = await owner.request.post('/api/agents', {
    headers,
    data: { name: 'Lion', capability: 'research', mode: 'hosted' },
  });
  const lionId = (await lion.json()).agent.id as string;
  const room = await owner.request.post('/api/rooms', {
    headers,
    data: { agent_id: lionId, name: 'Off room', idempotency_key: randomUUID() },
  });
  const roomId = (await room.json()).room.id as string;
  await say(owner, roomId, '@Lion one thing');

  let lionOff = true;
  await answering(owner, (id) => cannotAnswer(id, lionOff ? 'off' : 'none'));
  await owner.goto(`/rooms/${roomId}`);
  const hint = owner.getByTestId('mention-cant-answer');
  await expect(hint).toHaveText(
    'Lion can’t reply here because its Auto-reply is off. Turn it on to have Lion answer @mentions; you can switch it off again at any time.Turn on Auto-replyOnly you see this.',
  );
  await expect(hint.getByRole('link', { name: 'Turn on Auto-reply', exact: true })).toHaveAttribute(
    'href',
    `/agents#agent=${lionId}:autoreply`,
  );

  // No Auto-reply at all: both fixes; Connect an AI app opens the console's Connect your AI.
  lionOff = false;
  await owner.reload();
  await hint.getByRole('link', { name: 'Connect an AI app', exact: true }).click();
  await expect(owner.getByRole('heading', { name: 'Connect AI', exact: true })).toBeVisible();
});

/*
 * Regression (live, 11 Oct): a group room "Test" hosted by the owner's own agent "Lion"; the
 * owner, as a person, wrote "hey @Lion" and no line showed. The members, the message and the
 * answer below are exactly what production sent (member id = agent id, no agent_id field; the
 * message has mentions_you and no mentions list). The page was not in view when it loaded (a
 * background tab): the room still loaded its messages, but the answer was only ever read while
 * visible, so it was never read and the line never came. It is read at once now, and nothing
 * is ever asked about without an id (production also showed GET /api/agents/undefined/answering).
 */
test('live shapes: "hey @Lion" by the owner as a person shows the line, even in a background tab', async ({
  browser,
}) => {
  const LION = '2c9b7605-2823-4842-826e-9e109362c529';
  const ME = '89e9fc6a-df13-5757-88f5-bc2298a2d9e9';
  const owner = await account(browser, 'Basetester');
  const lion = await owner.request.post('/api/agents', {
    headers,
    data: { name: 'Lion', capability: 'research', mode: 'hosted' },
  });
  const room = await owner.request.post('/api/rooms', {
    headers,
    data: { agent_id: (await lion.json()).agent.id, name: 'Test', idempotency_key: randomUUID() },
  });
  const roomId = (await room.json()).room.id as string;
  await say(owner, roomId, 'hey @Lion');

  await owner.route(`**/api/rooms/${roomId}/members*`, (route) =>
    route.fulfill({
      json: {
        room_id: roomId,
        members: [
          {
            id: LION,
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
            id: ME,
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
        ],
      },
    }),
  );
  // The room's own page of messages, its one message replaced by production's, field for field.
  await owner.route(`**/api/rooms/${roomId}/messages?*`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const page = await response.json();
    page.messages = page.messages.map((message: { id: string; seq: number }) => ({
      id: message.id,
      seq: message.seq,
      origin: 'external',
      sender: 'Basetester',
      sender_agent_id: ME,
      sender_owner_label: 'Account a611f94b',
      own: true,
      text: 'hey @Lion',
      parts: [{ text: 'hey @Lion', type: 'text' }],
      created_at: '2026-10-11T06:03:08.247Z',
      format: 'markdown',
      sender_kind: 'person',
      auto_reply: null,
      mentions_you: true,
    }));
    return route.fulfill({ response, json: page });
  });
  const asked: string[] = [];
  await owner.route('**/api/agents/*/answering', (route) => {
    asked.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      json: {
        agent_id: LION,
        can: false,
        by: null,
        auto_reply: 'none',
        runtime_connected: false,
      },
    });
  });
  // A background tab: the page is hidden, and nothing tells it it became visible.
  await owner.addInitScript(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { get: () => true });
  });
  await owner.goto(`/rooms/${roomId}`);

  const mine = owner.getByTestId('room-message').filter({ hasText: 'hey @Lion' });
  await expect(mine).toBeVisible();
  await expect(mine.getByTestId('mention-cant-answer')).toHaveText(
    `${NONE_LINE('Lion')}Set up Auto-reply·Connect an AI appOnly you see this.`,
  );
  await expect(mine.getByRole('link', { name: 'Set up Auto-reply', exact: true })).toHaveAttribute(
    'href',
    `/agents#agent=${LION}:autoreply`,
  );
  // Only Lion was asked about, by its id; never an undefined one.
  expect(new Set(asked)).toEqual(new Set([`/api/agents/${LION}/answering`]));
});

/*
 * Regression (live, 11 Oct, later): Lion is a CC agent (hosted, scripted, no AI model; New room
 * made it). Once its scripted runtime's heartbeat was fresh the route answered can:true
 * by:'runtime', so no line came under "hey @Lion", and Lion never replied: that runtime doesn't
 * answer in conversation. The route now answers this exact shape for it (connected, scripted, can't
 * answer): the line shows. With Auto-reply on it answers, and the line goes.
 */
test('a CC agent whose scripted runtime is connected still gets the line; Auto-reply on clears it', async ({
  browser,
}) => {
  const owner = await account(browser, 'scripted');
  const lion = await owner.request.post('/api/agents', {
    headers,
    data: { name: 'Lion', capability: 'research', mode: 'hosted' },
  });
  const lionAgent = (await lion.json()).agent as { id: string; mode: string; isDemo: boolean };
  expect({ mode: lionAgent.mode, isDemo: lionAgent.isDemo }).toEqual({
    mode: 'hosted',
    isDemo: true,
  });
  const lionId = lionAgent.id;
  const room = await owner.request.post('/api/rooms', {
    headers,
    data: { agent_id: lionId, name: 'Scripted room', idempotency_key: randomUUID() },
  });
  const roomId = (await room.json()).room.id as string;
  await say(owner, roomId, 'hey @Lion');

  let autoReplyOn = false;
  const asked = await answering(owner, (id) => ({
    agent_id: id,
    can: autoReplyOn,
    by: autoReplyOn ? 'auto_reply' : null,
    auto_reply: autoReplyOn ? 'on' : 'none',
    runtime_connected: true,
    scripted: true,
  }));
  await owner.goto(`/rooms/${roomId}`);
  const mine = owner.getByTestId('room-message').filter({ hasText: 'hey @Lion' });
  await expect(mine).toBeVisible();
  await expect(mine.getByTestId('mention-cant-answer')).toHaveText(
    `${NONE_LINE('Lion')}Set up Auto-reply·Connect an AI appOnly you see this.`,
  );
  await expect(mine.getByRole('link', { name: 'Set up Auto-reply', exact: true })).toHaveAttribute(
    'href',
    `/agents#agent=${lionId}:autoreply`,
  );
  expect(new Set(asked)).toEqual(new Set([lionId]));

  autoReplyOn = true;
  await owner.reload();
  await expect(mine).toBeVisible();
  await expect(owner.getByTestId('mention-cant-answer')).toHaveCount(0);
});
