import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';

/*
 * Peer review on the Tasks panel (src/rooms/PeerReview.tsx, docs/ROOM_TASKS.md "Peer review"),
 * in the task's detail view (click its card). The host asks a third member to check a task with a
 * short checklist (desktop); the reviewer ticks the list, comments and asks for changes (phone);
 * the host sees the verdict on the task and still accepts it (advisory only).
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

async function account(browser: Browser, label: string) {
  const context = await browser.newContext();
  const name = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const created = await context.request.post('/api/auth/register', {
    headers,
    data: { name, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  return { context, request: context.request, page: await context.newPage() };
}

async function join(
  browser: Browser,
  host: Awaited<ReturnType<typeof account>>,
  roomId: string,
  label: string,
  agentName: string,
) {
  const minted = await host.request.post(`/api/rooms/${roomId}/link`, { headers, data: {} });
  const token = new URL((await minted.json()).link as string).hash.slice(1);
  const member = await account(browser, label);
  const joined = await member.request.post(`/api/rooms/${roomId}/join`, {
    headers,
    data: { token, create: { name: agentName }, idempotency_key: crypto.randomUUID() },
  });
  expect(joined.ok(), await joined.text()).toBeTruthy();
  return member;
}

async function setup(browser: Browser) {
  const host = await account(browser, 'review-host');
  const agent = await host.request.post('/api/agents', {
    headers,
    data: { name: 'Host agent', description: 'e2e', capability: 'research', mode: 'external' },
  });
  const hostAgent = (await agent.json()).agent.id as string;
  const created = await host.request.post('/api/rooms', {
    headers,
    data: { agent_id: hostAgent, name: 'Launch plan', idempotency_key: crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  const room = (await created.json()).room as { id: string };
  const member = await join(browser, host, room.id, 'review-member', 'Scout');
  const reviewer = await join(browser, host, room.id, 'review-checker', 'Checker');
  const task = await host.request.post(`/api/rooms/${room.id}/tasks`, {
    headers,
    data: { title: 'Draft the launch post', idempotency_key: crypto.randomUUID() },
  });
  const taskId = (await task.json()).task.id as string;
  const claim = await member.request.post(`/api/rooms/${room.id}/tasks/${taskId}/claim`, {
    headers,
    data: { idempotency_key: crypto.randomUUID() },
  });
  const { claim_token } = await claim.json();
  const result = await member.request.post(`/api/rooms/${room.id}/tasks/${taskId}/result`, {
    headers,
    data: {
      claim_token,
      evidence: { kind: 'proposal', ref: 'https://example.com/d1', revision: 'r1' },
    },
  });
  expect(result.ok(), await result.text()).toBeTruthy();
  return { host, member, reviewer, room };
}

async function openTasks(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Launch plan' })).toBeVisible();
  await page.getByRole('button', { name: /^Tasks/ }).click();
  const panel = page.getByRole('complementary', { name: 'Tasks' });
  await expect(panel).toBeVisible();
  return panel;
}

/** Opens a task's detail view from its card; the panel then shows only that task. */
async function openTask(panel: Locator, number: number, title: string) {
  await panel.getByTestId('task-card').filter({ hasText: title }).click();
  await expect(panel.getByRole('heading', { name: `T${number}: ${title}` })).toBeVisible();
}

test('peer review: the host asks (desktop), the reviewer answers (phone), the host still decides', async ({
  browser,
}) => {
  const { host, reviewer, room } = await setup(browser);
  const errors: string[] = [];
  host.page.on('pageerror', (error) => errors.push(error.message));
  reviewer.page.on('pageerror', (error) => errors.push(error.message));

  const panel = await openTasks(host.page, room.id);
  await openTask(panel, 1, 'Draft the launch post');
  await panel.getByRole('button', { name: 'Ask for review' }).click();
  const form = panel.getByRole('form', { name: 'Ask for a review' });
  await form.getByLabel('Reviewer').selectOption({ label: 'Checker' });
  await form.getByLabel(/Checklist/).fill('Plain words\nUnder 200 words');
  await form.getByRole('button', { name: 'Ask for review' }).click();
  await expect(panel).toContainText('Review requested');
  await expect(panel).toContainText('waiting for Checker');
  await expect(panel.getByTestId('task-status')).toHaveText('In review · review asked');

  // The reviewer on a phone.
  await reviewer.page.setViewportSize({ width: 360, height: 780 });
  const mine = await openTasks(reviewer.page, room.id);
  await openTask(mine, 1, 'Draft the launch post');
  const review = mine.getByRole('form', { name: 'Your review' });
  await expect(review).toBeVisible();
  await review.getByLabel('Plain words').check();
  await review.getByLabel('Comment (optional)').fill('Too long: cut the second paragraph.');
  await review.getByRole('button', { name: 'Request changes' }).click();
  await expect(mine).toContainText('Peer review: changes requested');
  await expect(mine).toContainText('Too long: cut the second paragraph.');
  await expect(mine.getByRole('form', { name: 'Your review' })).toHaveCount(0);
  const box = (await mine.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(360 + 0.5);
  expect(
    await mine.evaluate(
      (element) =>
        [...element.querySelectorAll('*')].filter(
          (child) => child.getBoundingClientRect().right > innerWidth + 0.5,
        ).length,
    ),
  ).toBe(0);

  // The host sees the verdict and still accepts (peer review is advisory).
  await host.page.reload();
  const again = await openTasks(host.page, room.id);
  await openTask(again, 1, 'Draft the launch post');
  await expect(again).toContainText('Peer review: changes requested');
  await again.getByRole('button', { name: 'Accept' }).click();
  await expect(again.getByTestId('task-status')).toHaveText('Done');
  await expect(again).toContainText('The host accepted the result.');
  expect(errors).toEqual([]);
});

test('Ask for review never offers an invite guest (the server refuses guests as reviewers)', async ({
  browser,
}) => {
  const { host, room } = await setup(browser);
  // Checker joined through an invite link without an account, as the server reports it.
  await host.page.route(`**/api/rooms/${room.id}/members*`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    for (const member of body.members as { name: string; guest?: boolean }[])
      if (member.name === 'Checker') member.guest = true;
    await route.fulfill({ response, json: body });
  });
  const panel = await openTasks(host.page, room.id);
  await openTask(panel, 1, 'Draft the launch post');
  await panel.getByRole('button', { name: 'Ask for review' }).click();
  const form = panel.getByRole('form', { name: 'Ask for a review' });
  // The members list loads on its own (here through the route above): wait for it, not a snapshot.
  const reviewer = form.getByLabel('Reviewer');
  await expect(reviewer.locator('option', { hasText: 'Host agent' })).toHaveCount(1);
  await expect(reviewer.locator('option', { hasText: 'Checker' })).toHaveCount(0);
  // A list that arrives late still leaves a valid pick, so the request can be sent.
  await expect(reviewer).not.toHaveValue('');
  await expect(form.getByRole('button', { name: 'Ask for review' })).toBeEnabled();
});

test('Ask for review appears only once a member claims the task', async ({ browser }) => {
  const { host, member, room } = await setup(browser);
  const task = await host.request.post(`/api/rooms/${room.id}/tasks`, {
    headers,
    data: { title: 'Nobody has this yet', idempotency_key: crypto.randomUUID() },
  });
  const taskId = (await task.json()).task.id as string;
  const panel = await openTasks(host.page, room.id);
  await openTask(panel, 2, 'Nobody has this yet');
  await expect(panel.getByTestId('task-status')).toHaveText('Open');
  await expect(panel.getByRole('button', { name: 'Ask for review' })).toHaveCount(0);

  const claim = await member.request.post(`/api/rooms/${room.id}/tasks/${taskId}/claim`, {
    headers,
    data: { idempotency_key: crypto.randomUUID() },
  });
  expect(claim.ok(), await claim.text()).toBeTruthy();
  const claimed = await openTasks(host.page, room.id);
  await openTask(claimed, 2, 'Nobody has this yet');
  await expect(claimed.getByTestId('task-status')).toHaveText('Claimed');
  await expect(claimed).toContainText('Scout is working on it');
  await expect(claimed.getByRole('button', { name: 'Ask for review' })).toBeVisible();
});
