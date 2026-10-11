import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/*
 * The chat history against the REAL conversations API (GET/POST/PATCH/DELETE
 * /api/elric/conversations) on the fake-Google e2e server (CITY_ELRIC_MOCK=1), no mocks: a new
 * chat keeps the first, is titled by its first message, then by a short generated title after
 * Elric's first reply (the mock model sentence-cases the message), can be renamed and
 * deleted, and switching shows each conversation's own messages.
 */
const port = Number(process.env.E2E_GOOGLE_PORT);
const fakePort = Number(process.env.E2E_GOOGLE_FAKE_PORT);
const base = `http://127.0.0.1:${port}`;
const headers = { 'x-city-request': '1' };

test('chat history on the real API: new chat, title, answer, switch, rename, delete', async ({
  page,
}) => {
  const subject = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:${fakePort}/authorize${new URL(route.request().url()).search}&e2e_subject=${subject}`,
      },
    }),
  );
  const created = await page.request.post(`${base}/api/auth/register`, {
    headers,
    data: { name: `Host ${randomUUID().slice(0, 8)}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(created.status()).toBe(201);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Google account linked.' }),
  ).toBeVisible();
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  await page.goto(`${base}/elric`);
  await page.getByRole('button', { name: 'Start chatting' }).click();
  const input = page.getByLabel('Message Elric');
  await expect(input).toBeVisible();
  const side = page.getByRole('navigation', { name: 'Chats' });
  const chats = side.locator('.elx-side-chat');
  // An empty chat is not listed until its first message.
  await expect(chats).toHaveCount(0);

  // The first chat: a message, Elric answers, the chat gets its short title (no reload).
  await input.fill('which phone is better, iPhone 12 or 16?');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('elric-reply').last()).toBeVisible({ timeout: 15_000 });
  await expect(chats.first()).toHaveText('Which phone is better, iPhone 12 or 16?', {
    timeout: 15_000,
  });

  // A new chat keeps the first one.
  // Only a fresh composer: the chat is stored with its first message, never empty.
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByTestId('elric-reply')).toHaveCount(0);
  await expect(chats).toHaveCount(1);
  await input.fill('second topic here');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('elric-reply').last()).toBeVisible({ timeout: 15_000 });
  await expect(chats).toHaveCount(2);
  await expect(chats.first()).toHaveAttribute('aria-current', 'page');
  await expect(chats.first()).toHaveText('Second topic here', { timeout: 15_000 });

  // Switching shows each conversation's own messages.
  await chats.filter({ hasText: 'Which phone is better, iPhone 12 or 16?' }).click();
  await expect(page.locator('.elx-bubble')).toHaveText(['which phone is better, iPhone 12 or 16?']);

  // Rename, then delete the other one.
  await side
    .getByRole('button', { name: 'More for Which phone is better, iPhone 12 or 16?', exact: true })
    .click();
  await side.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename chat' });
  await rename.getByLabel('Chat name').fill('Renamed topic');
  await rename.getByRole('button', { name: 'Save name' }).click();
  await expect(chats.filter({ hasText: 'Renamed topic' })).toHaveCount(1);
  await side.getByRole('button', { name: 'More for Second topic here', exact: true }).click();
  await side.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete this chat?' });
  await expect(confirm).toContainText('This can’t be undone.');
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(chats).toHaveText(['Renamed topic']);
  const list = await (
    await page.request.get(`${base}/api/elric/conversations`, { headers })
  ).json();
  expect(list.conversations.map((c: { title: string }) => c.title)).toEqual(['Renamed topic']);

  // Deleting the open (and only) chat leaves a fresh composer, not a stored empty "New chat".
  await chats.first().click();
  await side.getByRole('button', { name: 'More for Renamed topic', exact: true }).click();
  await side.getByRole('menuitem', { name: 'Delete' }).click();
  await page
    .getByRole('alertdialog', { name: 'Delete this chat?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(chats).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const empty = await (
    await page.request.get(`${base}/api/elric/conversations`, { headers })
  ).json();
  expect(empty.conversations).toEqual([]);
  await page.reload();
  await expect(page.getByLabel('Message Elric')).toBeVisible();
  await expect(side.locator('.elx-side-chat')).toHaveCount(0);
});

test('a titled chat ("hi") deletes from the room settings too, no 409', async ({ page }) => {
  const subject = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:${fakePort}/authorize${new URL(route.request().url()).search}&e2e_subject=${subject}`,
      },
    }),
  );
  const created = await page.request.post(`${base}/api/auth/register`, {
    headers,
    data: { name: `Host ${randomUUID().slice(0, 8)}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(created.status()).toBe(201);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Google account linked.' }),
  ).toBeVisible();
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.goto(`${base}/elric`);
  await page.getByRole('button', { name: 'Start chatting' }).click();
  await page.getByLabel('Message Elric').fill('hi');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('elric-reply').last()).toBeVisible({ timeout: 15_000 });
  const side = page.getByRole('navigation', { name: 'Chats' });
  await expect(side.locator('.elx-side-chat').first()).not.toHaveText('New chat', {
    timeout: 15_000,
  });
  const [chat] = (
    await (await page.request.get(`${base}/api/elric/conversations`, { headers })).json()
  ).conversations as Array<{ id: string; title: string }>;
  // The request the room settings send for this room (it lists among the rooms by its title).
  const deleted = await page.request.delete(`${base}/api/rooms/${chat!.id}`, {
    headers,
    data: { confirm_name: chat!.title },
  });
  expect(deleted.status(), await deleted.text()).toBe(200);
  const left = await (
    await page.request.get(`${base}/api/elric/conversations`, { headers })
  ).json();
  expect(left.conversations).toEqual([]);
});
