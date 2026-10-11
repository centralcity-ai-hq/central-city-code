import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';

/*
 * The room's Tasks panel (src/rooms/TasksPanel.tsx, TasksV2.tsx) over the console REST routes
 * (#163, docs/ROOM_TASKS.md). The host adds a task and reviews what a member hands in: Accept,
 * Send back, Cancel, in the task's detail view (click its card). Members see every task, without
 * the host's actions. Only each task's current state is shown.
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

/** A host with a room and a member (another account's agent) who joined it. */
async function roomWithMember(browser: Browser) {
  const host = await account(browser, 'task-host');
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
  const minted = await host.request.post(`/api/rooms/${room.id}/link`, { headers, data: {} });
  const token = new URL((await minted.json()).link as string).hash.slice(1);
  const member = await account(browser, 'task-member');
  const joined = await member.request.post(`/api/rooms/${room.id}/join`, {
    headers,
    data: { token, create: { name: 'Scout' }, idempotency_key: crypto.randomUUID() },
  });
  expect(joined.ok(), await joined.text()).toBeTruthy();
  return { host, member, room };
}

/** The member takes a task and hands in a result (what their AI does over MCP). */
async function claimAndHandIn(
  member: { request: Page['request'] },
  roomId: string,
  taskId: string,
  ref: string,
) {
  const claim = await member.request.post(`/api/rooms/${roomId}/tasks/${taskId}/claim`, {
    headers,
    data: { idempotency_key: crypto.randomUUID() },
  });
  expect(claim.ok(), await claim.text()).toBeTruthy();
  const { claim_token } = await claim.json();
  const result = await member.request.post(`/api/rooms/${roomId}/tasks/${taskId}/result`, {
    headers,
    data: { claim_token, evidence: { kind: 'proposal', ref, revision: 'r1' } },
  });
  expect(result.ok(), await result.text()).toBeTruthy();
}

async function openTasks(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Launch plan' })).toBeVisible();
  await page.getByRole('button', { name: /^Tasks/ }).click();
  const panel = page.getByRole('complementary', { name: 'Tasks' });
  await expect(panel).toBeVisible();
  return panel;
}

const taskCard = (panel: Locator, title: string) =>
  panel.getByTestId('task-card').filter({ hasText: title });

/** Opens a task's detail view from its card; the panel then shows only that task. */
async function openTask(panel: Locator, number: number, title: string) {
  await taskCard(panel, title).click();
  await expect(panel.getByRole('heading', { name: `T${number}: ${title}` })).toBeVisible();
}

test('the host adds a task, a member hands it in, the host sends it back and then accepts it', async ({
  browser,
}) => {
  const { host, member, room } = await roomWithMember(browser);
  const errors: string[] = [];
  host.page.on('pageerror', (error) => errors.push(error.message));
  const panel = await openTasks(host.page, room.id);
  await expect(panel.getByText('No tasks yet. Add the first one.')).toBeVisible();

  await panel.getByRole('button', { name: 'New task' }).click();
  await panel.getByLabel('Task', { exact: true }).fill('Draft the launch post');
  await panel.getByLabel('Details (optional)').fill('Two paragraphs, plain words.');
  await panel.getByRole('button', { name: 'Add task' }).click();
  const card = taskCard(panel, 'Draft the launch post');
  await expect(card).toContainText('T1');
  await expect(card.getByTestId('task-status')).toHaveText('Open');
  await expect(host.page.getByRole('button', { name: 'Tasks, 1 to do' })).toBeVisible();
  await openTask(panel, 1, 'Draft the launch post');
  await expect(panel.getByTestId('task-status')).toHaveText('Open');
  await expect(panel).toContainText('Two paragraphs, plain words.');
  await expect(panel).toContainText('Waiting for a member to take it.');

  // The member's AI takes it and hands in a result.
  const tasks = await (await host.request.get(`/api/rooms/${room.id}/tasks`)).json();
  const taskId = tasks.tasks[0].id as string;
  await claimAndHandIn(member, room.id, taskId, 'https://example.com/draft-1');
  await host.page.reload();
  const again = await openTasks(host.page, room.id);
  await expect(taskCard(again, 'Draft the launch post').getByTestId('task-status')).toHaveText(
    'In review',
  );
  await openTask(again, 1, 'Draft the launch post');
  await expect(again.getByTestId('task-status')).toHaveText('In review');
  await expect(again).toContainText('Handed in. Accept it, or send it back for another try.');
  await expect(again).toContainText('Result: https://example.com/draft-1');

  // Send back: the task is open again (its current state only; no history lines here).
  await again.getByRole('button', { name: 'Send back' }).click();
  await expect(again.getByTestId('task-status')).toHaveText('Open');
  await expect(again).toContainText('Waiting for a member to take it.');
  await expect(again.getByRole('button', { name: 'Accept' })).toHaveCount(0);

  await claimAndHandIn(member, room.id, taskId, 'https://example.com/draft-2');
  await host.page.reload();
  const final = await openTasks(host.page, room.id);
  await openTask(final, 1, 'Draft the launch post');
  await expect(final).toContainText('Result: https://example.com/draft-2');
  await final.getByRole('button', { name: 'Accept' }).click();
  await expect(final.getByTestId('task-status')).toHaveText('Done');
  await expect(final).toContainText('The host accepted the result.');
  await expect(final.getByRole('button', { name: 'Cancel task' })).toHaveCount(0);
  await expect(final.getByRole('button', { name: /^(Accept|Send back)$/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the host cancels a task; members see every task and its state, without host actions', async ({
  browser,
}) => {
  const { host, member, room } = await roomWithMember(browser);
  for (const title of ['Collect sources', 'Check the numbers'])
    expect(
      (
        await host.request.post(`/api/rooms/${room.id}/tasks`, {
          headers,
          data: { title, idempotency_key: crypto.randomUUID() },
        })
      ).status(),
    ).toBe(201);
  const hostPanel = await openTasks(host.page, room.id);
  await openTask(hostPanel, 2, 'Check the numbers');
  await hostPanel.getByRole('button', { name: 'Cancel task' }).click();
  await expect(hostPanel).toContainText('Cancel T2? Members can no longer work on it.');
  await hostPanel.getByRole('button', { name: 'Cancel task' }).click();
  await expect(hostPanel.getByTestId('task-status')).toHaveText('Cancelled');
  await expect(hostPanel).toContainText('The host cancelled this task.');
  await expect(hostPanel.getByRole('button', { name: 'Cancel task' })).toHaveCount(0);

  const list = await (await member.request.get(`/api/rooms/${room.id}/tasks`)).json();
  const collect = list.tasks.find((task: { title: string }) => task.title === 'Collect sources');
  const claim = await member.request.post(`/api/rooms/${room.id}/tasks/${collect.id}/claim`, {
    headers,
    data: { idempotency_key: crypto.randomUUID() },
  });
  expect(claim.ok()).toBeTruthy();

  const panel = await openTasks(member.page, room.id);
  await expect(panel.getByRole('button', { name: 'New task' })).toHaveCount(1);
  await expect(panel.getByTestId('task-card')).toHaveCount(2);
  const collecting = taskCard(panel, 'Collect sources');
  await expect(collecting.getByTestId('task-status')).toHaveText('Claimed');
  await expect(collecting.getByTestId('task-claimer')).toContainText('Scout');
  await expect(taskCard(panel, 'Check the numbers').getByTestId('task-status')).toHaveText(
    'Cancelled',
  );
  // Plain words only.
  expect(await panel.innerText()).not.toMatch(/city_|[{}]|idempoten|claim_token|in_review/i);

  await openTask(panel, 1, 'Collect sources');
  await expect(panel).toContainText('Scout is working on it');
  await expect(panel.getByRole('button', { name: /Accept|Send back|Cancel task/ })).toHaveCount(0);
  expect(await panel.innerText()).not.toMatch(/city_|[{}]|idempoten|claim_token|in_review/i);
  await panel.getByRole('button', { name: 'All tasks' }).click();
  await openTask(panel, 2, 'Check the numbers');
  await expect(panel.getByTestId('task-status')).toHaveText('Cancelled');
  await expect(panel).toContainText('The host cancelled this task.');
  await expect(panel.getByRole('button', { name: /Accept|Send back|Cancel task/ })).toHaveCount(0);
});

const overflowing = (panel: Locator) =>
  panel.evaluate(
    (element) =>
      [...element.querySelectorAll('*')].filter(
        (child) => child.getBoundingClientRect().right > innerWidth + 0.5,
      ).length,
  );

for (const scheme of ['light', 'dark'] as const)
  test(`the Tasks panel fits 360 px (${scheme})`, async ({ browser }) => {
    const { host, room } = await roomWithMember(browser);
    const title = 'A long task title that has to wrap on a small phone screen without scrolling';
    await host.request.post(`/api/rooms/${room.id}/tasks`, {
      headers,
      data: { title, idempotency_key: crypto.randomUUID() },
    });
    await host.page.setViewportSize({ width: 360, height: 780 });
    await host.page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
    const panel = await openTasks(host.page, room.id);
    await expect(panel.getByTestId('task-card')).toHaveCount(1);
    const box = (await panel.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(360 + 0.5);
    expect(await overflowing(panel)).toBe(0);
    // Text and panel follow the theme (no hard-coded colours).
    const colours = await panel.evaluate((element) => ({
      panel: getComputedStyle(element).backgroundColor,
      text: getComputedStyle(element.querySelector('.rm-v2-card-title')!).color,
    }));
    expect(colours.panel).not.toBe(colours.text);

    // The detail view fits too.
    await openTask(panel, 1, title);
    expect(await overflowing(panel)).toBe(0);
    expect(
      await host.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);
  });
