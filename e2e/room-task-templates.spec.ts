import { test, expect, type Browser, type Locator } from '@playwright/test';

/*
 * Task templates in the room's New task form (src/rooms/TasksPanel.tsx, docs/ROOM_TASKS.md
 * "Templates"): template chips are names only; picking one never fills the title or details
 * (no description line), and the task is stored with its template; a task's details render as
 * safe Markdown in its detail view (click its card). Desktop and a 390 px phone.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

async function hostRoom(browser: Browser) {
  const context = await browser.newContext();
  const created = await context.request.post('/api/auth/register', {
    headers,
    data: { name: `tpl-host-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
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
      name: 'Template desk',
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(room.status()).toBe(201);
  return { context, page: await context.newPage(), roomId: (await room.json()).room.id as string };
}

/** Opens a task's detail view from its card; the panel then shows only that task. */
async function openTask(panel: Locator, number: number, title: string) {
  await panel.getByTestId('task-card').filter({ hasText: title }).click();
  await expect(panel.getByRole('heading', { name: `T${number}: ${title}` })).toBeVisible();
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: '390 px', width: 390, height: 844 },
])
  test(`the host creates a task from a template (${viewport.name})`, async ({ browser }) => {
    const { context, page, roomId } = await hostRoom(browser);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Template desk' })).toBeVisible();
    await page.getByRole('button', { name: /^Tasks/ }).click();
    const panel = page.getByRole('complementary', { name: 'Tasks' });
    await panel.getByRole('button', { name: 'New task' }).click();

    const picker = panel.getByRole('group', { name: 'Start from' });
    await expect(picker.getByRole('radio', { name: 'Blank' })).toBeChecked();
    for (const name of ['Code review', 'Bug triage', 'Research question', 'Launch checklist'])
      await expect(picker.getByRole('radio', { name })).toBeVisible();

    const title = panel.getByLabel('Task', { exact: true });
    const details = panel.getByLabel('Details (optional)');
    await expect(details).toHaveAttribute('placeholder', 'Add details (optional)');
    // Every template: checked, title and details stay empty, and no description text appears.
    for (const name of [
      'Code review',
      'Bug triage',
      'Research question',
      'Writing draft',
      'Launch checklist',
      'Test plan',
    ]) {
      await picker.getByText(name, { exact: true }).click();
      await expect(picker.getByRole('radio', { name })).toBeChecked();
      await expect(title).toHaveValue('');
      await expect(details).toHaveValue('');
    }
    await expect(picker.locator('p')).toHaveCount(0);
    await expect(panel.getByText(/edit them freely|acceptance criteria/i)).toHaveCount(0);

    // A typed title survives switching template.
    await title.fill('Code review: checkout page');
    await picker.getByText('Code review', { exact: true }).click();
    await expect(title).toHaveValue('Code review: checkout page');
    await expect(details).toHaveValue('');
    await page.screenshot({ path: `shots/task-templates-${viewport.width}.png` });

    // The form fits the phone: nothing wider than the viewport. The filter row may scroll
    // sideways inside the sheet by design, so chips clipped by a scrolling ancestor do not count.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
    expect(
      await panel.evaluate((element) =>
        [...element.querySelectorAll('*')]
          .filter((child) => child.getBoundingClientRect().right > innerWidth + 0.5)
          .filter((child) => {
            for (let up = child.parentElement; up && up !== element; up = up.parentElement)
              if (['auto', 'scroll', 'hidden'].includes(getComputedStyle(up).overflowX))
                return false;
            return true;
          })
          .map((child) => child.className),
      ),
    ).toEqual([]);

    await panel.getByRole('button', { name: 'Add task' }).click();
    const card = panel.getByTestId('task-card').filter({ hasText: 'Code review: checkout page' });
    await expect(card).toContainText('T1');
    await expect(card.getByTestId('task-status')).toHaveText('Open');
    await openTask(panel, 1, 'Code review: checkout page');

    // The template is recorded; the server did not fill in the template's body.
    const stored = await (await context.request.get(`/api/rooms/${roomId}/tasks`)).json();
    expect(stored.tasks[0].template).toEqual({ id: 'code-review', version: '1.0.0' });
    expect(stored.tasks[0].body).toBe('');
    expect(errors).toEqual([]);
    await context.close();
  });

test('task details render as safe Markdown: no raw HTML, safe links only', async ({ browser }) => {
  const { context, page, roomId } = await hostRoom(browser);
  const created = await context.request.post(`/api/rooms/${roomId}/tasks`, {
    headers,
    data: {
      title: 'Markdown details',
      body: [
        '## Problem',
        'Ship **today**, see [the docs](https://centralcity.ai/docs).',
        '<b>raw</b> <img src=x onerror="window.__xss=1">',
        '[bad](javascript:window.__xss=2)',
      ].join('\n'),
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  await page.goto(`/rooms/${roomId}`);
  await page.getByRole('button', { name: /^Tasks/ }).click();
  const panel = page.getByRole('complementary', { name: 'Tasks' });
  await openTask(panel, 1, 'Markdown details');
  const body = panel.getByTestId('task-body');
  await expect(body.getByRole('heading', { name: 'Problem' })).toBeVisible();
  await expect(body.locator('strong')).toHaveText('today');
  const docs = body.getByRole('link', { name: 'the docs' });
  await expect(docs).toHaveAttribute('href', 'https://centralcity.ai/docs');
  await expect(docs).toHaveAttribute('rel', 'noopener nofollow ugc noreferrer');
  // Raw HTML stays literal text, and a javascript: link keeps its text without a link.
  await expect(body).toContainText('<img src=x onerror="window.__xss=1">');
  await expect(body.locator('img, b, script')).toHaveCount(0);
  await expect(body.getByRole('link', { name: 'bad' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
  await context.close();
});
