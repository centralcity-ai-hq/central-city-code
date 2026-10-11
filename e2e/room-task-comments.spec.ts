import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';

/*
 * Task comments in the room's Tasks panel (src/rooms/TaskComments.tsx, docs/ROOM_TASKS.md
 * "Comments"): open a task's detail view (its thread starts open), write a comment, see it,
 * delete it. The comment never appears in the room's main conversation. Desktop (light) and a
 * 390 px phone (dark).
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

async function hostRoomWithTask(browser: Browser) {
  const context = await browser.newContext();
  const created = await context.request.post('/api/auth/register', {
    headers,
    data: { name: `cmt-host-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  const agent = await context.request.post('/api/agents', {
    headers,
    data: { name: 'Host agent', description: 'e2e', capability: 'research', mode: 'external' },
  });
  const room = await context.request.post('/api/rooms', {
    headers,
    data: {
      agent_id: (await agent.json()).agent.id,
      name: 'Comment desk',
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(room.status()).toBe(201);
  const roomId = (await room.json()).room.id as string;
  const task = await context.request.post(`/api/rooms/${roomId}/tasks`, {
    headers,
    data: { title: 'Pick a launch date', idempotency_key: crypto.randomUUID() },
  });
  expect(task.status()).toBe(201);
  return { context, page: await context.newPage(), roomId };
}

/** Opens the Tasks panel, then the task's detail view from its card. */
async function openTask(page: Page, roomId: string): Promise<Locator> {
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Comment desk' })).toBeVisible();
  await page.getByRole('button', { name: /^Tasks/ }).click();
  const panel = page.getByRole('complementary', { name: 'Tasks' });
  await panel.getByTestId('task-card').filter({ hasText: 'Pick a launch date' }).click();
  await expect(panel.getByRole('heading', { name: 'T1: Pick a launch date' })).toBeVisible();
  return panel;
}

for (const viewport of [
  { name: 'desktop, light', width: 1440, height: 1000, scheme: 'light' as const },
  { name: '390 px, dark', width: 390, height: 844, scheme: 'dark' as const },
])
  test(`a member comments on a task, sees it and deletes it (${viewport.name})`, async ({
    browser,
  }) => {
    const { context, page, roomId } = await hostRoomWithTask(browser);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.emulateMedia({ colorScheme: viewport.scheme });
    const panel = await openTask(page, roomId);

    // In the detail view the thread starts open; the toggle still hides and shows it.
    const thread = panel.getByRole('region', { name: 'Comments on T1' });
    await expect(thread.getByText('No comments yet.')).toBeVisible();
    const hide = panel.getByRole('button', { name: 'Hide comments' });
    await expect(hide).toHaveAttribute('aria-expanded', 'true');
    await hide.click();
    const show = panel.getByRole('button', { name: 'Comments', exact: true });
    await expect(show).toHaveAttribute('aria-expanded', 'false');
    await expect(thread).toHaveCount(0);
    await show.click();
    await expect(panel.getByRole('button', { name: 'Hide comments' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(thread.getByText('No comments yet.')).toBeVisible();

    const box = thread.getByLabel('Comment on T1');
    await box.fill('Friday works.\n<b>Not</b> Monday.');
    await thread.getByRole('button', { name: 'Comment', exact: true }).click();
    const comment = thread.getByRole('listitem').filter({ hasText: 'Friday works.' });
    // Written without an agent: from the host as themselves (their own person, A1).
    await expect(comment).toContainText('(you)');
    // Plain text: the markup shows as typed and makes no element.
    await expect(comment.getByText('<b>Not</b> Monday.', { exact: false })).toBeVisible();
    expect(await comment.locator('b').count()).toBe(0);
    await expect(box).toHaveValue('');
    await expect(panel.getByRole('button', { name: /Hide comments/ })).toContainText('1');

    // Not in the room's main conversation.
    const conversation = await (
      await context.request.get(`/api/rooms/${roomId}/messages?since=0`)
    ).json();
    expect(JSON.stringify(conversation)).not.toContain('Friday works.');

    // Nothing wider than the viewport.
    expect(
      await panel.evaluate(
        (element) =>
          [...element.querySelectorAll('*')].filter(
            (child) => child.getBoundingClientRect().right > innerWidth + 0.5,
          ).length,
      ),
    ).toBe(0);

    await comment.getByRole('button', { name: /^Delete comment by / }).click();
    await comment.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(thread.getByText('No comments yet.')).toBeVisible();

    const stored = await (await context.request.get(`/api/rooms/${roomId}/tasks`)).json();
    expect(stored.tasks[0].comment_count).toBe(0);

    // Back to the list.
    await panel.getByRole('button', { name: 'All tasks' }).click();
    await expect(panel.getByTestId('task-card')).toHaveCount(1);
    expect(errors).toEqual([]);
    await context.close();
  });

test('an open thread shows a comment another member wrote meanwhile (no reload)', async ({
  browser,
}) => {
  const { context, page, roomId } = await hostRoomWithTask(browser);
  const panel = await openTask(page, roomId);
  const thread = panel.getByRole('region', { name: 'Comments on T1' });
  await expect(thread.getByText('No comments yet.')).toBeVisible();

  // Another member joins and comments over the API while the host's thread stays open.
  const minted = await context.request.post(`/api/rooms/${roomId}/link`, { headers, data: {} });
  const token = new URL((await minted.json()).link as string).hash.slice(1);
  const other = await browser.newContext();
  const registered = await other.request.post('/api/auth/register', {
    headers,
    data: { name: `cmt-member-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  const joined = await other.request.post(`/api/rooms/${roomId}/join`, {
    headers,
    data: { token, create: { name: 'Scout' }, idempotency_key: crypto.randomUUID() },
  });
  expect(joined.ok(), await joined.text()).toBeTruthy();
  const tasks = await other.request.get(`/api/rooms/${roomId}/tasks`, { headers });
  const taskId = ((await tasks.json()).tasks as { id: string }[])[0].id;
  const posted = await other.request.post(`/api/rooms/${roomId}/tasks/${taskId}/comments`, {
    headers,
    data: { body: 'Thursday is better.', idempotency_key: crypto.randomUUID() },
  });
  expect(posted.ok(), await posted.text()).toBeTruthy();

  // The panel's periodic refresh (10 s) brings the new count; the open list follows it.
  await expect(panel.getByRole('button', { name: /Hide comments/ })).toContainText('1', {
    timeout: 20_000,
  });
  await expect(
    thread.getByRole('listitem').filter({ hasText: 'Thursday is better.' }),
  ).toBeVisible();
  await expect(thread.getByText('No comments yet.')).toHaveCount(0);
  await other.close();
  await context.close();
});
