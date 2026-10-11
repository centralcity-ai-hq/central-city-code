import { test, expect, type Locator, type Page } from '@playwright/test';

async function openMessages(page: Page) {
  const created = await page.request.post('/api/auth/register', {
    headers: { 'X-City-Request': '1' },
    data: {
      name: `Message reliability ${crypto.randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(created.status()).toBe(201);
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: /^Messages/ })
    .click();
}

/** Opens the (only) conversation: the thread replaces the inbox. */
async function openChat(page: Page) {
  await page
    .getByRole('navigation', { name: 'Conversations', exact: true })
    .getByRole('button')
    .first()
    .click();
}

/** The Messages read error: a titled alert whose body is the plain describeError copy. */
async function expectReadError(scope: Locator | Page, body: string, timeout?: number) {
  const alert = scope.getByRole('alert');
  await expect(
    alert.getByRole('heading', { name: "Messages couldn't be loaded", exact: true }),
  ).toBeVisible({ timeout });
  await expect(alert.locator('p')).toHaveText(body);
}

test('failed conversation read replaces loading and retry recovers to empty state', async ({
  page,
}) => {
  let fail = true;
  await page.route('**/api/messages/conversations', (route) =>
    route.fulfill({
      status: fail ? 400 : 200,
      json: fail ? { error: 'Request fields are invalid.' } : { conversations: [] },
    }),
  );
  await openMessages(page);
  const messages = page.getByRole('region', { name: 'Messages', exact: true });
  // Plain copy from describeError (src/ui/errors.ts); server text is never shown.
  await expectReadError(messages, "Something in this form isn't right. Check it and try again.");
  await expect(messages.getByText('Loading conversations…')).toHaveCount(0);
  fail = false;
  await messages.getByRole('button', { name: 'Retry loading', exact: true }).click();
  await expect(messages.getByText('No private messages yet')).toBeVisible();
  await expect(messages.getByRole('alert')).toHaveCount(0);
  // No connected agents: guidance, not a composer that can't send.
  await expect(messages.getByRole('link', { name: 'Message someone from a room' })).toBeVisible();
  await expect(messages.getByRole('button', { name: 'Write the first message' })).toHaveCount(0);
});

test('a failed read recovers on the next automatic poll without Retry', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/messages/conversations', (route) => {
    requests++;
    return route.fulfill(
      requests === 1
        ? { status: 503, json: { error: 'Messages are briefly unavailable.' } }
        : { json: { conversations: [] } },
    );
  });
  await openMessages(page);
  const messages = page.getByRole('region', { name: 'Messages', exact: true });
  await expectReadError(messages, "We couldn't reach Central City. Try again.");
  // No click: the 10-second poll alone must clear the error and show the real state.
  await expect(messages.getByText('No private messages yet')).toBeVisible({ timeout: 15_000 });
  await expect(messages.getByRole('alert')).toHaveCount(0);
  expect(requests).toBeGreaterThanOrEqual(2);
});

test('stalled read times out without starting overlapping requests and can retry', async ({
  page,
}) => {
  let requests = 0;
  await page.route('**/api/messages/conversations', async (route) => {
    requests++;
    if (requests > 1) await route.fulfill({ json: { conversations: [] } });
    // First request intentionally never answers; the client must bound it.
  });
  await openMessages(page);
  const messages = page.getByRole('region', { name: 'Messages', exact: true });
  await expect(messages.getByText('Loading conversations…')).toBeVisible();
  await expectReadError(messages, 'This is taking too long. Try again.', 18_000);
  expect(requests).toBe(1);
  await expect(messages.getByText('Loading conversations…')).toHaveCount(0);
  await messages.getByRole('button', { name: 'Retry loading', exact: true }).click();
  await expect(messages.getByText('No private messages yet')).toBeVisible();
});

test('non-JSON errors stay readable', async ({ page }) => {
  await page.route('**/api/messages/conversations', (route) =>
    route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Gateway unavailable</h1>' }),
  );
  await openMessages(page);
  await expectReadError(page, "We couldn't reach Central City. Try again.");
  await expect(page.getByText('Loading conversations…')).toHaveCount(0);
});

test('transient thread failures preserve history and composer; authorization loss clears them', async ({
  page,
}) => {
  await openMessages(page);
  const headers = { 'X-City-Request': '1' };
  await page.request.post('/api/demo/start', { headers, data: {} });
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const from = snapshot.agents.find((a: { name: string }) => a.name === 'Atlas');
  const to = snapshot.agents.find((a: { name: string }) => a.name === 'Relay');
  await page.request.post(`/api/agents/${from.id}/messages`, {
    headers,
    data: {
      to_agent_id: to.id,
      text: 'Previously readable message',
      idempotency_key: crypto.randomUUID(),
    },
  });
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: /^Messages/ })
    .click();
  await openChat(page);
  await expect(page.getByRole('list', { name: 'Thread messages' })).toContainText(
    'Previously readable message',
  );
  let status = 503;
  await page.route('**/api/messages/conversations/*', (route) =>
    route.fulfill({
      status,
      json: { error: status === 503 ? 'Temporarily unavailable' : 'Access denied' },
    }),
  );
  await expect(page.getByRole('alert')).toHaveText("We couldn't reach Central City. Try again.", {
    timeout: 15000,
  });
  await expect(page.getByRole('list', { name: 'Thread messages' })).toContainText(
    'Previously readable message',
  );
  await expect(page.getByRole('form', { name: 'Reply', exact: true })).toBeVisible();
  status = 403;
  await expect(page.getByRole('alert')).toHaveText("You don't have access to this.", {
    timeout: 15000,
  });
  await expect(page.getByRole('list', { name: 'Thread messages' })).not.toContainText(
    'Previously readable message',
  );
  await expect(page.getByRole('form', { name: 'Reply', exact: true })).toHaveCount(0);
});

test('send queues a new read after a pending pre-send poll', async ({ page }) => {
  await openMessages(page);
  const headers = { 'X-City-Request': '1' };
  await page.request.post('/api/demo/start', { headers, data: {} });
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const from = snapshot.agents.find((a: { name: string }) => a.name === 'Atlas');
  const to = snapshot.agents.find((a: { name: string }) => a.name === 'Relay');
  const seeded = await (
    await page.request.post(`/api/agents/${from.id}/messages`, {
      headers,
      data: {
        to_agent_id: to.id,
        text: 'Before pending read',
        idempotency_key: crypto.randomUUID(),
      },
    })
  ).json();
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: /^Messages/ })
    .click();
  await openChat(page);
  await expect(page.getByRole('list', { name: 'Thread messages' })).toContainText(
    'Before pending read',
  );
  const stale = await (
    await page.request.get(`/api/messages/conversations/${seeded.message.context_id}?limit=100`)
  ).json();
  let release: (() => Promise<void>) | undefined;
  let reads = 0;
  await page.route('**/api/messages/conversations/*', async (route) => {
    reads++;
    if (reads === 1) release = () => route.fulfill({ json: stale });
    else await route.continue();
  });
  await expect.poll(() => Boolean(release), { timeout: 15000 }).toBe(true);
  const composer = page.getByRole('form', { name: 'Reply', exact: true });
  await composer.getByLabel('Message text').fill('After pending read');
  const sent = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/agents/${from.id}/messages`) &&
      response.request().method() === 'POST',
  );
  await composer.getByRole('button', { name: 'Send message', exact: true }).click();
  expect((await sent).status()).toBe(201);
  await release!();
  // The sent message already shows (it is added from the send's answer), so the text alone does
  // not prove the new read: wait for the read the send queued behind the pending one, then check
  // that the stale pending answer did not take the message away.
  await expect.poll(() => reads, { timeout: 3000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('list', { name: 'Thread messages' })).toContainText(
    'After pending read',
    { timeout: 3000 },
  );
});
