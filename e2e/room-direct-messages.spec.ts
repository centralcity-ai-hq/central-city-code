import { test, expect as baseExpect, type Browser, type Page } from '@playwright/test';

/*
 * "Message privately" from a room (docs/MESSAGING.md "Private messages from a room"): Dana joins
 * a room as a person, taps the host's AI in the Members panel and writes privately; the AI's
 * owner sees the private thread in Messages and answers as that AI; nothing reaches the room
 * feed. Dana's side runs at phone width. Synthetic accounts only.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';

async function signUpAt(page: Page, name: string) {
  const createOne = page.getByRole('button', { name: 'Create an account', exact: true });
  const createAccount = page.getByRole('button', { name: 'Create account', exact: true });
  await expect(createOne.or(createAccount)).toBeVisible();
  if (await createOne.isVisible()) await createOne.click();
  await expect(createAccount).toBeVisible();
  await page.getByLabel(/^(Account|Operator) name$/).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await createAccount.click();
  await expect(createAccount).toHaveCount(0);
}

async function account(
  browser: Browser,
  label: string,
  viewport?: { width: number; height: number },
) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#signin');
  await signUpAt(page, `${label}-${crypto.randomUUID().slice(0, 6)}`);
  return { context, page, errors };
}

test('a person messages a room member privately and its owner answers as that AI', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  await host.page.goto('/rooms');
  await host.page.getByRole('button', { name: 'New room' }).first().click();
  const dialog = host.page.getByRole('dialog', { name: 'New room' });
  await dialog.getByLabel('Room name').fill('Planning room');
  await dialog.getByLabel("Your AI's name").fill('Host agent');
  await dialog.getByRole('button', { name: 'Create room' }).click();
  await expect(host.page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);
  const roomRef = host.page.url().split('/').pop()!;
  await host.page.getByRole('button', { name: 'Invite', exact: true }).first().click();
  const sheet = host.page.getByRole('dialog', { name: 'Invite a person' });
  const code = (await sheet.locator('.rm-code').textContent())!.trim();
  await sheet.getByText('Room access').click();
  await expect(sheet.getByRole('checkbox', { name: 'Private messages' })).toBeChecked();
  await sheet.getByRole('button', { name: 'Close' }).first().click();
  // The host's AI says something in the room, so it has a byline Dana can act on (as the AI:
  // the host writes as themselves by default since A1).
  await host.page.locator('.rm3-postas select').selectOption({ label: 'Host agent' });
  const hostBox = host.page.getByLabel('Message', { exact: true });
  await hostBox.fill('Welcome to the planning room');
  await hostBox.press('Enter');

  // Dana joins, then continues on a phone.
  const dana = await account(browser, 'Dana');
  await dana.page.goto('/rooms');
  await dana.page.getByRole('button', { name: 'Join a room' }).first().click();
  const join = dana.page.getByRole('dialog', { name: 'Join a room' });
  await join.getByLabel('Invite link or code').fill(code);
  await join.getByRole('button', { name: 'Use a different name' }).click();
  await join.getByLabel('Your name in the room').fill('Dana');
  await join.getByRole('button', { name: 'Join room' }).click();
  await expect(dana.page.getByRole('heading', { name: 'Planning room', level: 1 })).toBeVisible();
  await dana.page.setViewportSize({ width: 390, height: 844 });

  // On the message author: the icon action.
  const welcome = dana.page
    .getByTestId('room-message')
    .filter({ hasText: 'Welcome to the planning room' });
  await expect(welcome.getByRole('link', { name: 'Message Host agent privately' })).toBeVisible();

  // In the Members panel: "Message privately" on the host's AI, never on Dana herself. On a
  // phone too the room pill opens Members.
  await dana.page
    .locator('.rm-room-head')
    .getByRole('button', { name: /^Members of / })
    .click();
  const panel = dana.page.getByRole('complementary', { name: 'Members' });
  // The host's AI and the host as themselves (their own person, A1).
  await expect(panel.getByRole('link', { name: /privately/ })).toHaveCount(2);
  const people = panel.getByRole('list', { name: 'People' }).getByRole('listitem');
  const danaRow = people.filter({ hasText: 'Dana' });
  await expect(danaRow).toBeVisible();
  await expect(danaRow.getByRole('link', { name: /privately/ })).toHaveCount(0);
  await panel
    .getByRole('list', { name: 'AIs', exact: true })
    .getByRole('link', { name: 'Message Host agent privately' })
    .click();

  // The console's Messages, on the pair's private thread.
  const head = dana.page.locator('.msg-v2-head');
  await expect(head.getByRole('heading', { name: 'Host agent', exact: true })).toBeVisible();
  await expect(head).toContainText('From #Planning room');
  const compose = dana.page.getByRole('form', { name: 'Private message' });
  await compose.getByLabel('Message privately').fill('Hi, can we talk about the budget?');
  await compose.getByRole('button', { name: 'Send privately' }).click();
  const thread = dana.page.getByRole('list', { name: 'Thread messages' });
  await expect(thread).toContainText('Hi, can we talk about the budget?');
  // Phone-friendly: no horizontal scroll.
  const overflow = await dana.page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  // The AI's owner sees it in Messages and answers as the AI.
  await host.page.goto('/');
  await host.page.getByRole('button', { name: /^Messages\b/ }).click();
  await host.page
    .getByRole('navigation', { name: 'Conversations' })
    .getByRole('button', { name: /^Dana\b.*From #Planning room/ })
    .click();
  const hostThread = host.page.getByRole('list', { name: 'Thread messages' });
  await expect(hostThread).toContainText('Hi, can we talk about the budget?');
  const reply = host.page.getByRole('form', { name: 'Private message' });
  await expect(reply).toContainText('Writing as Host agent');
  await reply.getByLabel('Message privately').fill('Sure, Dana. Tomorrow at 10?');
  await reply.getByRole('button', { name: 'Send privately' }).click();
  await expect(hostThread).toContainText('Sure, Dana. Tomorrow at 10?');

  // Dana sees the answer in the same thread (one thread per pair), on the next refresh.
  await expect(thread).toContainText('Sure, Dana. Tomorrow at 10?', { timeout: 25_000 });

  // Nothing reached the room feed.
  const feed = await host.page.request.get(`/api/rooms/${roomRef}/messages?limit=100`);
  expect(feed.ok()).toBe(true);
  const feedText = await feed.text();
  expect(feedText).toContain('Welcome to the planning room');
  expect(feedText).not.toContain('budget');

  expect(host.errors).toEqual([]);
  expect(dana.errors).toEqual([]);
  await host.context.close();
  await dana.context.close();
});
