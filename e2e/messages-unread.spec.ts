import { test, expect as baseExpect, type APIRequestContext, type Browser } from '@playwright/test';

/*
 * Unread in Messages counts only messages you RECEIVED from someone else and have not read yet:
 * a message one of your own agents sent to another of yours is never unread (neither on the
 * Messages count in the navigation nor in the inbox); a message from another account shows 1
 * until you open the thread. Synthetic accounts only.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

async function account(browser: Browser, label: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const created = await context.request.post('/api/auth/register', {
    headers,
    data: { name: `${label}-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, request: context.request, errors };
}

async function post(request: APIRequestContext, url: string, data: Record<string, unknown>) {
  const response = await request.post(url, { headers, data });
  expect(response.ok(), `${url}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json();
}

const unreadTotal = async (request: APIRequestContext) =>
  (
    (await (await request.get('/api/messages/summary')).json()) as {
      inboxes: { unread: number }[];
    }
  ).inboxes.reduce((sum, inbox) => sum + inbox.unread, 0);

test('only received messages are unread, and opening the thread reads them', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  // The owner has two agents; Scout hosts a room and writes to Relay along their connection.
  const owner = await account(browser, 'unread-owner');
  const agent = async (name: string) =>
    (await post(owner.request, '/api/agents', { name, capability: 'research', mode: 'external' }))
      .agent.id as string;
  const scout = await agent('Scout');
  const relay = await agent('Relay');
  await post(owner.request, '/api/connections', { fromAgentId: scout, toAgentId: relay });
  await post(owner.request, `/api/agents/${scout}/messages`, {
    to_agent_id: relay,
    text: 'Internal sync note',
    idempotency_key: crypto.randomUUID(),
  });
  const { room } = (await post(owner.request, '/api/rooms', {
    agent_id: scout,
    name: 'Planning room',
    idempotency_key: crypto.randomUUID(),
  })) as { room: { id: string } };
  const { link } = (await post(owner.request, `/api/rooms/${room.id}/link`, {})) as {
    link: string;
  };

  // Relay holds an unacknowledged message, but it came from Scout: nothing is unread.
  expect(await unreadTotal(owner.request)).toBe(0);
  const page = owner.page;
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
  const messages = nav.getByRole('button', { name: /^Messages/ });
  await messages.click();
  const list = page.getByRole('navigation', { name: 'Conversations' });
  await expect(list.getByRole('button', { name: /Relay/ })).toBeVisible({ timeout: 25_000 });
  await expect(list.getByRole('button', { name: /unread/ })).toHaveCount(0);
  await expect(page.getByLabel('Agents with unread messages')).toHaveCount(0);
  await expect(messages.locator('.nav-count')).toHaveCount(0);

  // Dana, another account, joins as a person and writes to Scout privately.
  const dana = await account(browser, 'unread-dana');
  await post(dana.request, '/api/rooms/join', {
    link,
    name: 'Dana',
    idempotency_key: crypto.randomUUID(),
  });
  const opened = (await post(dana.request, `/api/rooms/${room.id}/direct`, { to: scout })) as {
    self: { id: string };
  };
  await post(dana.request, `/api/rooms/${room.id}/direct/messages`, {
    from: opened.self.id,
    to: scout,
    text: 'Can we talk about the budget?',
    idempotency_key: crypto.randomUUID(),
  });
  expect(await unreadTotal(owner.request)).toBe(1);

  // One unread: on Messages in the navigation and on Dana's chat, until the thread is opened.
  await expect(messages).toHaveAccessibleDescription('1 unread message', { timeout: 25_000 });
  const danaRow = list.getByRole('button', { name: /^Dana\b/ });
  await expect(danaRow).toHaveAccessibleName(/1 unread/, { timeout: 25_000 });
  await danaRow.click();
  await expect(page.getByRole('list', { name: 'Thread messages' })).toContainText(
    'Can we talk about the budget?',
  );
  await expect(messages.locator('.nav-count')).toHaveCount(0);
  expect(await unreadTotal(owner.request)).toBe(0);
  await page.getByRole('button', { name: 'Back to inbox' }).click();
  await expect(list.getByRole('button', { name: /unread/ })).toHaveCount(0);

  expect(owner.errors).toEqual([]);
  await owner.context.close();
  await dana.context.close();
});
