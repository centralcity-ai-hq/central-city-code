import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/*
 * ⋯ "Delete chat" in the owner's private chat with its own agent, against the real routes (no
 * mocks): POST /api/rooms/private-agent opens the chat, DELETE /api/rooms/:room with
 * {confirm_name} deletes it, and the next open is a new, empty chat. The item is not offered in
 * a group room, in an Elric chat (on the fake-Google server, CITY_ELRIC_MOCK=1) or to anyone else.
 */

const headers = { 'x-city-request': '1' };
const password = 'Local-test-only-passphrase-2026';
const AGENT = 'Research scout';

async function register(request: APIRequestContext, label: string, base = '') {
  const created = await request.post(`${base}/api/auth/register`, {
    headers,
    data: { name: `${label}-${randomUUID().slice(0, 8)}`, password },
  });
  expect(created.status(), await created.text()).toBe(201);
}

async function createAgent(request: APIRequestContext, name: string) {
  const res = await request.post('/api/agents', {
    headers,
    data: { name, description: 'Synthetic fixture', capability: 'research', mode: 'external' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).agent.id as string;
}

async function openPrivateChat(request: APIRequestContext, agentId: string) {
  const res = await request.post('/api/rooms/private-agent', {
    headers,
    data: { agent_id: agentId },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as { room_id: string; created: boolean; latest_seq: number };
}

/** Opens the room's ⋯ menu and returns it. */
async function moreMenu(page: Page) {
  await page.getByRole('button', { name: 'More room actions' }).first().click();
  const menu = page.getByRole('menu', { name: 'More room actions' });
  await expect(menu).toBeVisible();
  return menu;
}

/** From the agent's pane in My agents: "Message <agent>" opens its private chat's page. */
async function messageAgent(page: Page, agentId: string) {
  await page.goto(`/agents#agent=${encodeURIComponent(agentId)}`);
  const panel = page.getByRole('complementary', { name: `${AGENT} details` });
  await panel.getByRole('button', { name: `Message ${AGENT}`, exact: true }).click();
  await expect(page).toHaveURL(/\/rooms\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1, name: AGENT })).toBeVisible();
  return new URL(page.url()).pathname.split('/').pop()!;
}

test('Delete chat is offered in the private chat with your agent, not in a group room or to others', async ({
  page,
  browser,
}) => {
  await register(page.request, 'Chat-owner');
  const agentId = await createAgent(page.request, AGENT);
  const group = await page.request.post('/api/rooms', {
    headers,
    data: { agent_id: agentId, name: 'Group desk', idempotency_key: randomUUID() },
  });
  expect(group.status(), await group.text()).toBe(201);
  const groupId = (await group.json()).room.id as string;

  // The owner's private chat: the item is there, in the danger colour.
  const roomId = await messageAgent(page, agentId);
  let menu = await moreMenu(page);
  const item = menu.getByRole('menuitem', { name: 'Delete chat', exact: true });
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute('data-danger', 'true');
  await page.keyboard.press('Escape');

  // A group room the same owner hosts: its own End or delete room, no Delete chat.
  await page.goto(`/rooms/${groupId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Group desk' })).toBeVisible();
  menu = await moreMenu(page);
  await expect(menu.getByRole('menuitem', { name: 'End or delete room' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Delete chat' })).toHaveCount(0);

  // Another account never sees the chat, so it has nothing to delete either.
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    await register(other.request, 'Someone-else');
    await other.goto(`/rooms/${roomId}`);
    await expect(other.getByRole('heading', { level: 1, name: AGENT })).toHaveCount(0);
    await expect(other.getByRole('menuitem', { name: 'Delete chat' })).toHaveCount(0);
    await expect(other.getByText(`Delete this chat with ${AGENT}?`)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('Cancel keeps the chat; Delete chat deletes it for good, and the next open is a new, empty chat', async ({
  page,
}) => {
  await register(page.request, 'Chat-deleter');
  const agentId = await createAgent(page.request, AGENT);
  const roomId = await messageAgent(page, agentId);
  const composer = page.getByLabel('Message', { exact: true });
  await composer.fill('Something private');
  await composer.press('Enter');
  await expect(page.getByText('Something private')).toBeVisible();

  // Cancel: the confirm goes, focus returns to ⋯, nothing was sent.
  const deletes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'DELETE' && request.url().includes('/api/rooms/'))
      deletes.push(request.url());
  });
  await (await moreMenu(page)).getByRole('menuitem', { name: 'Delete chat' }).click();
  const confirm = page.getByTestId('delete-chat');
  await expect(confirm).toContainText(
    `Delete this chat with ${AGENT}? Its messages are deleted for good.`,
  );
  await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More room actions' }).first()).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/rooms/${roomId}$`));
  await expect(page.getByText('Something private')).toBeVisible();
  expect(deletes).toEqual([]);

  // A failed delete says so in plain words and keeps the confirm for another try.
  await page.route(`**/api/rooms/${roomId}`, (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({ status: 503, json: { error: 'Unavailable.' } })
      : route.fallback(),
  );
  await (await moreMenu(page)).getByRole('menuitem', { name: 'Delete chat' }).click();
  await confirm.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await expect(confirm.getByRole('alert')).toHaveText("Couldn't delete the chat. Try again.");
  await expect(page).toHaveURL(new RegExp(`/rooms/${roomId}$`));
  await page.unroute(`**/api/rooms/${roomId}`);

  // Confirm: deleted on the server, back on the agent's page with a short note.
  await confirm.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('Chat deleted.');
  await expect(page).not.toHaveURL(/\/rooms\//);
  const panel = page.getByRole('complementary', { name: `${AGENT} details` });
  await expect(panel.getByRole('heading', { level: 2, name: AGENT })).toBeVisible();
  expect(deletes.at(-1)).toContain(`/api/rooms/${roomId}`);
  const gone = await page.request.get(`/api/rooms/${roomId}/messages`, { headers });
  expect(gone.status()).toBe(410);

  // "Message <agent>" again opens a new chat with nothing in it.
  await panel.getByRole('button', { name: `Message ${AGENT}`, exact: true }).click();
  await expect(page).toHaveURL(/\/rooms\/[^/]+$/);
  const next = new URL(page.url()).pathname.split('/').pop()!;
  expect(next).not.toBe(roomId);
  await expect(page.locator('.rm-empty')).toContainText(`Only you and ${AGENT} are in this chat.`);
  await expect(page.getByText('Something private')).toHaveCount(0);
  const again = await openPrivateChat(page.request, agentId);
  expect(again).toMatchObject({ room_id: next, created: false, latest_seq: 0 });
});

test('the server releases the chat: the next open answers created with a new, empty room', async ({
  page,
}) => {
  await register(page.request, 'Chat-reopen');
  const agentId = await createAgent(page.request, AGENT);
  const first = await openPrivateChat(page.request, agentId);
  await page.goto(`/rooms/${first.room_id}`);
  await expect(page.getByRole('heading', { level: 1, name: AGENT })).toBeVisible();
  await (await moreMenu(page)).getByRole('menuitem', { name: 'Delete chat' }).click();
  await page
    .getByTestId('delete-chat')
    .getByRole('button', { name: 'Delete chat', exact: true })
    .click();
  await expect(page.locator('.toast')).toContainText('Chat deleted.');
  const second = await openPrivateChat(page.request, agentId);
  expect(second.created).toBe(true);
  expect(second.room_id).not.toBe(first.room_id);
  expect(second.latest_seq).toBe(0);
});

test('an Elric chat has no Delete chat in its room menu', async ({ page }) => {
  const base = `http://127.0.0.1:${Number(process.env.E2E_GOOGLE_PORT)}`;
  const fakePort = Number(process.env.E2E_GOOGLE_FAKE_PORT);
  const subject = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:${fakePort}/authorize${new URL(route.request().url()).search}&e2e_subject=${subject}`,
      },
    }),
  );
  await register(page.request, 'Elric-owner', base);
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
  const [chat] = (
    await (await page.request.get(`${base}/api/elric/conversations`, { headers })).json()
  ).conversations as Array<{ id: string; title: string }>;
  // The Elric chat lists among the rooms by its title; its page has no Delete chat.
  await page.goto(`${base}/rooms/${chat!.id}`);
  await expect(page.getByRole('heading', { level: 1, name: chat!.title })).toBeVisible();
  const menu = await moreMenu(page);
  await expect(menu.getByRole('menuitem').first()).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Delete chat' })).toHaveCount(0);
});
