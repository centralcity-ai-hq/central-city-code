import { test, expect, type Page } from '@playwright/test';

const password = 'Local-test-only-passphrase-2026';
const protectedJson = { 'X-City-Request': '1' };

/** Registers its own isolated workspace (the e2e server raises the registration limit). */
async function signIn(page: Page) {
  const created = await page.request.post('/api/auth/register', {
    headers: protectedJson,
    data: { name: 'Browser-Messaging', password },
  });
  expect(created.status()).toBe(201);
  const demo = await page.request.post('/api/demo/start', { headers: protectedJson, data: {} });
  expect(demo.status()).toBe(200);
  // The workspace opens on Rooms; Messages is in its navigation.
  await page.goto('/');
  await expect(page).toHaveURL(/rooms$/);
}

test('owner sends as agent A to agent B and sees it in B’s messages', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page);
  await expect
    .poll(
      async () =>
        ((await (await page.request.get('/api/snapshot')).json()) as any).connections.length,
    )
    .toBe(2);

  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Messages', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Messages', exact: true, level: 1 }),
  ).toBeVisible();
  // New conversation never offers one of your agents writing to another of yours (that would be you
  // messaging yourself): with no shared room and no other owner's agent, it explains instead.
  await expect(page.getByRole('link', { name: 'Message someone from a room' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Write the first message' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'New conversation' })).toHaveCount(0);

  // The first demo agent writes to the second along their connection (the agent's own route).
  const snapshot = (await (await page.request.get('/api/snapshot')).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  const atlas = snapshot.agents.find((agent) => agent.name === 'Atlas')!.id;
  const relay = snapshot.agents.find((agent) => agent.name === 'Relay')!.id;
  const untrusted = 'Sync at 10:00?\n<img src=x onerror="window.__pwned=true">';
  const sentByAtlas = await page.request.post(`/api/agents/${atlas}/messages`, {
    headers: protectedJson,
    data: { to_agent_id: relay, text: untrusted, idempotency_key: crypto.randomUUID() },
  });
  expect(sentByAtlas.status()).toBe(201);
  await page
    .getByRole('navigation', { name: 'Conversations' })
    .getByRole('button', { name: /Atlas ⇄ Relay/ })
    .click({ timeout: 20_000 });

  const thread = page.getByRole('list', { name: 'Thread messages' });
  await expect(thread.getByTestId('message')).toHaveCount(1);
  await expect(thread).toContainText('Sync at 10:00?');
  await expect(thread).toContainText('<img src=x onerror="window.__pwned=true">');
  // The thread replaces the inbox; Back returns to it.
  await page.getByRole('button', { name: 'Back to inbox' }).click();
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toContainText(
    'Atlas ⇄ Relay',
  );
  // Both agents are yours: the recipient's inbox holds the message for the AI, but it is not
  // unread for you, so neither the navigation nor the inbox strip counts it.
  await expect(page.getByLabel('Agents with unread messages')).toHaveCount(0);
  await expect(page.getByLabel(/unread message/)).toHaveCount(0);

  // The recipient's own messages, from its pane in My agents (its Messages screen).
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'My agents', exact: true })
    .click();
  await page
    .getByRole('button', { name: /^Relay, / })
    .first()
    .click();
  const pane = page.getByRole('complementary', { name: 'Relay details' });
  await pane.getByRole('button', { name: /^Messages/ }).click();
  await expect(pane.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible();
  const withAtlas = pane.getByRole('button', { name: /^Atlas/ });
  await expect(withAtlas).toContainText('Sync at 10:00?');
  await page.screenshot({ path: 'test-results/agent-inbox.png', fullPage: true });

  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned),
  ).toBeUndefined();
  expect(errors).toEqual([]);
});
