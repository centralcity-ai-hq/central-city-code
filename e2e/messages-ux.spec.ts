import { test, expect as baseExpect, type APIRequestContext, type Page } from '@playwright/test';

// Polls also run every 10 s; a poll already in flight can absorb one pollNow().
const expect = baseExpect.configure({ timeout: 15_000 });

/**
 * Chat behaviour people expect of any modern chat app: open at the newest message, load
 * older history on scroll, and never reload the thread or the composer when a message arrives.
 * Messages shows the inbox first; each test opens the conversation from it.
 */
const headers = { 'X-City-Request': '1' };

type Agents = Record<'Atlas' | 'Relay' | 'Sentinel', string>;

async function workspace(page: Page): Promise<Agents> {
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: {
      name: `Chat UX ${crypto.randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(created.status()).toBe(201);
  await page.request.post('/api/demo/start', { headers, data: {} });
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const id = (name: string) =>
    snapshot.agents.find((agent: { name: string }) => agent.name === name).id as string;
  return { Atlas: id('Atlas'), Relay: id('Relay'), Sentinel: id('Sentinel') };
}

async function send(
  request: APIRequestContext,
  from: string,
  to: string,
  text: string,
  context?: string,
) {
  const response = await request.post(`/api/agents/${from}/messages`, {
    headers,
    data: {
      to_agent_id: to,
      text,
      ...(context ? { context_id: context } : {}),
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).message as { id: string; context_id: string };
}

/** Seeds `count` messages into one room, alternating two senders to stay within send budgets. */
async function seedRoom(page: Page, agents: Agents, count: number, prefix = 'UX') {
  const room = `ux-${crypto.randomUUID().slice(0, 8)}`;
  for (let i = 0; i < count; i++) {
    const [from, to] = i % 2 ? [agents.Relay, agents.Sentinel] : [agents.Atlas, agents.Relay];
    await send(page.request, from, to, `${prefix} ${i}`, room);
  }
  return room;
}

const conversationList = (page: Page) =>
  page.getByRole('navigation', { name: 'Conversations', exact: true });

/** Opens Messages, then the newest conversation (the thread replaces the inbox). */
async function openMessages(page: Page) {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: /^Messages/ })
    .click();
  await conversationList(page).getByRole('button').first().click();
}

/** Back to the inbox from the open thread. */
const backToInbox = (page: Page) => page.getByRole('button', { name: 'Back to inbox' }).click();

/** Makes every poll run now (the page polls on visibilitychange) instead of waiting 10 s. */
const pollNow = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

const scroller = (page: Page) => page.getByTestId('thread-scroll');
const thread = (page: Page) => page.getByRole('list', { name: 'Thread messages' });
const message = (page: Page, text: string) => thread(page).getByText(text, { exact: true });

/** Whether an element lies fully inside the thread's scroll viewport. */
async function inViewport(page: Page, text: string) {
  return message(page, text).evaluate((element) => {
    const box = element.getBoundingClientRect();
    const view = element.closest('[data-testid="thread-scroll"]')!.getBoundingClientRect();
    return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
  });
}
const atBottom = (page: Page) =>
  scroller(page).evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 4,
  );

test('opens a long thread at the newest message with only the latest page loaded', async ({
  page,
}) => {
  const agents = await workspace(page);
  await seedRoom(page, agents, 60);
  await openMessages(page);
  await expect(message(page, 'UX 59')).toBeVisible();
  // The newest page only: 50 of 60, the oldest ten wait for a scroll up.
  await expect(page.getByTestId('message')).toHaveCount(50);
  await expect(message(page, 'UX 9')).toHaveCount(0);
  await expect.poll(() => inViewport(page, 'UX 59')).toBe(true);
  await expect.poll(() => atBottom(page)).toBe(true);
});

test('scrolling up loads older messages and keeps the reading position', async ({ page }) => {
  const agents = await workspace(page);
  await seedRoom(page, agents, 70);
  await openMessages(page);
  await expect(message(page, 'UX 69')).toBeVisible();
  await expect(page.getByTestId('message')).toHaveCount(50);
  const firstBefore = message(page, 'UX 20');
  await scroller(page).evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.getByTestId('message')).toHaveCount(70);
  await expect(message(page, 'UX 0')).toBeAttached();
  // The message that was at the top stays on screen: the view did not jump to the oldest page.
  await expect.poll(() => inViewport(page, 'UX 20')).toBe(true);
  await expect(firstBefore).toBeVisible();
  // Everything is loaded: no further "Load earlier messages".
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
});

test('the draft survives incoming messages and a conversation list re-sort', async ({ page }) => {
  const agents = await workspace(page);
  // An older second conversation; the room is newest, so it is the first row.
  await send(page.request, agents.Atlas, agents.Relay, 'Other chat');
  const room = await seedRoom(page, agents, 12, 'Room');
  await openMessages(page);
  const conversations = conversationList(page);
  await expect(message(page, 'Room 11')).toBeVisible();
  const composer = page.getByRole('form', { name: 'Reply', exact: true });
  const box = composer.getByLabel('Message text');
  await box.fill('Half-written reply');
  const sendAs = await composer.getByLabel('Send as').inputValue();

  // Someone else writes in this room, then in the other chat (which moves to the top), then here.
  await send(page.request, agents.Atlas, agents.Relay, 'Incoming while typing', room);
  await pollNow(page);
  await expect(message(page, 'Incoming while typing')).toBeVisible();
  await expect(box).toHaveValue('Half-written reply');
  await send(page.request, agents.Atlas, agents.Relay, 'Other chat moves up');
  await pollNow(page);
  await expect(box).toHaveValue('Half-written reply');
  // The inbox re-sorts: the other chat moves up, the open chat stays marked.
  await backToInbox(page);
  await expect(conversations.getByRole('button')).toHaveCount(2);
  await expect(conversations.getByRole('button').first()).toContainText('Other chat moves up');
  await expect(conversations.locator('[aria-current="true"]')).toHaveCount(1);
  await conversations.locator('[aria-current="true"]').click();
  await expect(message(page, 'Incoming while typing')).toBeVisible();
  await expect(box).toHaveValue('Half-written reply');
  await send(page.request, agents.Relay, agents.Sentinel, 'Room again', room);
  await pollNow(page);
  await expect(message(page, 'Room again')).toBeVisible();
  await backToInbox(page);
  await expect(conversations.getByRole('button').first()).toContainText('Room again');

  // Still the same chat, the same draft, and the same sender (a new message did not switch it).
  await expect(conversations.locator('[aria-current="true"]')).toContainText('Room again');
  await conversations.locator('[aria-current="true"]').click();
  await expect(message(page, 'Room again')).toBeVisible();
  await expect(box).toHaveValue('Half-written reply');
  await expect(composer.getByLabel('Send as')).toHaveValue(sendAs);
});

test('an incoming message does not remount the thread or the composer', async ({ page }) => {
  const agents = await workspace(page);
  const room = await seedRoom(page, agents, 12, 'Room');
  await openMessages(page);
  await expect(message(page, 'Room 11')).toBeVisible();
  const composer = page.getByRole('form', { name: 'Reply', exact: true });
  const box = composer.getByLabel('Message text');
  await box.click();
  await box.pressSequentially('Typing right now');
  // Tag the live DOM nodes and watch for any loading state: a remount would lose the tags.
  await page.evaluate(() => {
    const tag = (element: Element | null) => {
      if (element) (element as unknown as { marker: string }).marker = 'original';
    };
    tag(document.querySelector('textarea[aria-label="Message text"]'));
    tag(document.querySelector('ol[aria-label="Thread messages"]'));
    tag(document.querySelector('[data-testid="message"]'));
    const flags = ((window as unknown as { uxFlags: { loading: number } }).uxFlags = {
      loading: 0,
    });
    new MutationObserver(() => {
      if (document.body.textContent?.includes('Loading messages')) flags.loading++;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await box.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 6));

  for (const text of ['First incoming', 'Second incoming']) {
    await send(page.request, agents.Atlas, agents.Relay, text, room);
    await pollNow(page);
    await expect(message(page, text)).toBeVisible();
  }
  const state = await page.evaluate(() => {
    const tagged = (selector: string) =>
      (document.querySelector(selector) as unknown as { marker?: string } | null)?.marker ===
      'original';
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message text"]',
    )!;
    return {
      composer: tagged('textarea[aria-label="Message text"]'),
      list: tagged('ol[aria-label="Thread messages"]'),
      firstMessage: tagged('[data-testid="message"]'),
      focused: document.activeElement === textarea,
      caret: textarea.selectionStart,
      value: textarea.value,
      loadingShown: (window as unknown as { uxFlags: { loading: number } }).uxFlags.loading,
    };
  });
  expect(state).toEqual({
    composer: true,
    list: true,
    firstMessage: true,
    focused: true,
    caret: 6,
    value: 'Typing right now',
    loadingShown: 0,
  });

  // Sending keeps focus in the box and scrolls to the sent message.
  await box.press('End');
  await composer.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(message(page, 'Typing right now')).toBeVisible();
  await expect(box).toHaveValue('');
  await expect.poll(() => inViewport(page, 'Typing right now')).toBe(true);
});

test('new messages follow at the bottom, and show "New messages" when scrolled up', async ({
  page,
}) => {
  const agents = await workspace(page);
  const room = await seedRoom(page, agents, 30);
  await openMessages(page);
  await expect(message(page, 'UX 29')).toBeVisible();
  await expect.poll(() => atBottom(page)).toBe(true);
  const jump = page.getByRole('button', { name: 'New messages' });

  // At the bottom: the view follows the new message, no indicator.
  await send(page.request, agents.Atlas, agents.Relay, 'Arrives at bottom', room);
  await pollNow(page);
  await expect(message(page, 'Arrives at bottom')).toBeVisible();
  await expect.poll(() => inViewport(page, 'Arrives at bottom')).toBe(true);
  await expect(jump).toHaveCount(0);

  // Scrolled up: no jump; the indicator appears instead.
  await scroller(page).evaluate((element) => {
    element.scrollTop = 200;
  });
  await page.waitForTimeout(100);
  await send(page.request, agents.Atlas, agents.Relay, 'Arrives while reading', room);
  await pollNow(page);
  await expect(message(page, 'Arrives while reading')).toBeAttached();
  await expect(jump).toBeVisible();
  expect(await scroller(page).evaluate((element) => element.scrollTop)).toBe(200);
  expect(await inViewport(page, 'Arrives while reading')).toBe(false);

  await jump.click();
  await expect.poll(() => inViewport(page, 'Arrives while reading')).toBe(true);
  await expect(jump).toHaveCount(0);
});
