import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';

/*
 * Optional task stages (src/rooms/TaskStages.tsx, docs/ROOM_TASKS.md "Stages"): the host edits the
 * room's stage list in Room settings; a task's detail view (click its card) shows the stage as a
 * small pill with a picker for the host and for the member whose AI holds the claim. Rooms
 * without stages show nothing new.
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

async function openSettings(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Launch plan' })).toBeVisible();
  await page.locator('.rm-room-head').getByRole('button', { name: 'More room actions' }).click();
  await page.getByRole('menuitem', { name: 'Room settings', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Room settings' });
  await expect(panel).toBeVisible();
  // The host's Task stages sit under the collapsed More settings (the minimal sheet, #630).
  await panel.getByText('More settings', { exact: true }).click();
  return panel;
}

async function addTask(request: Page['request'], roomId: string, title: string) {
  const created = await request.post(`/api/rooms/${roomId}/tasks`, {
    headers,
    data: { title, idempotency_key: crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  return (await created.json()).task.id as string;
}

test('without stages a task shows no stage pill or picker', async ({ browser }) => {
  const { host, room } = await roomWithMember(browser);
  await addTask(host.request, room.id, 'Plain task');
  const panel = await openTasks(host.page, room.id);
  await expect(
    panel.getByTestId('task-card').filter({ hasText: 'Plain task' }).getByTestId('task-status'),
  ).toHaveText('Open');
  await expect(panel.locator('.rm-stage-pill')).toHaveCount(0);
  await openTask(panel, 1, 'Plain task');
  await expect(panel.getByTestId('task-status')).toHaveText('Open');
  await expect(panel.locator('.rm-stage-pill')).toHaveCount(0);
  await expect(panel.getByRole('combobox')).toHaveCount(0);
});

test('the host sets stages in room settings; host and claimer move tasks; history keeps each move', async ({
  browser,
}) => {
  const { host, member, room } = await roomWithMember(browser);
  const errors: string[] = [];
  host.page.on('pageerror', (error) => errors.push(error.message));
  const first = await addTask(host.request, room.id, 'Write the spec');
  await addTask(host.request, room.id, 'Someone else’s task');

  const settings = await openSettings(host.page, room.id);
  const section = settings.getByRole('region', { name: 'Task stages' });
  await expect(section.getByText('No stages. Tasks show only their status.')).toBeVisible();
  for (const [index, name] of ['Building', 'Testing', 'Shipped'].entries()) {
    await section.getByRole('button', { name: 'Add stage' }).click();
    await section.getByLabel(`Stage ${index + 1}`, { exact: true }).fill(name);
  }
  await section.getByRole('button', { name: 'Update stages' }).click();
  await expect(section.getByRole('status').filter({ hasText: 'Stages updated' })).toBeVisible();
  expect(
    (await (await host.request.get(`/api/rooms/${room.id}/task-stages`)).json()).stages,
  ).toEqual(['Building', 'Testing', 'Shipped']);

  const panel = await openTasks(host.page, room.id);
  await openTask(panel, 1, 'Write the spec');
  const picker = panel.getByRole('combobox', { name: 'Stage for T1' });
  await expect(picker).toHaveValue('');
  await picker.selectOption('Building');
  await expect(picker).toHaveValue('Building');
  // The status is unchanged.
  await expect(panel.getByTestId('task-status')).toHaveText('Open');

  // The member's AI claims T1; the member may move it, but not T2.
  const claim = await member.request.post(`/api/rooms/${room.id}/tasks/${first}/claim`, {
    headers,
    data: { idempotency_key: crypto.randomUUID() },
  });
  expect(claim.ok()).toBeTruthy();
  const memberPanel = await openTasks(member.page, room.id);
  await openTask(memberPanel, 1, 'Write the spec');
  await expect(memberPanel.getByTestId('task-status')).toHaveText('Claimed');
  const mine = memberPanel.getByRole('combobox', { name: 'Stage for T1' });
  await expect(mine).toHaveValue('Building');
  await mine.selectOption('Testing');
  await expect(mine).toHaveValue('Testing');
  await memberPanel.getByRole('button', { name: 'All tasks' }).click();
  await openTask(memberPanel, 2, 'Someone else’s task');
  await expect(memberPanel.getByRole('combobox')).toHaveCount(0);

  const events = await (
    await host.request.get(`/api/rooms/${room.id}/tasks/${first}/events`)
  ).json();
  const moves = events.events.filter(
    (event: { action: string }) => event.action === 'stage_changed',
  );
  expect(moves.map((event: { details: unknown }) => event.details)).toEqual([
    { from: null, to: 'Building' },
    { from: 'Building', to: 'Testing' },
  ]);
  for (const event of moves) expect(Date.parse(event.created_at)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

for (const scheme of ['light', 'dark'] as const)
  test(`stages fit 360 px in settings and on a task (${scheme})`, async ({ browser }) => {
    const { host, room } = await roomWithMember(browser);
    const saved = await host.request.put(`/api/rooms/${room.id}/task-stages`, {
      headers,
      data: { stages: ["Spec'd", 'Building', 'Testing', 'Shipped'] },
    });
    expect(saved.ok()).toBeTruthy();
    const title = 'A long task title that has to wrap on a small phone screen without scrolling';
    const taskId = await addTask(host.request, room.id, title);
    const moved = await host.request.post(`/api/rooms/${room.id}/tasks/${taskId}/update`, {
      headers,
      data: { stage: 'Building' },
    });
    expect(moved.ok()).toBeTruthy();
    await host.page.setViewportSize({ width: 360, height: 780 });
    await host.page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
    const overflow = (panel: Locator) =>
      panel.evaluate(
        (element) =>
          [...element.querySelectorAll('*')].filter(
            (child) => child.getBoundingClientRect().right > innerWidth + 0.5,
          ).length,
      );
    const panel = await openTasks(host.page, room.id);
    await openTask(panel, 1, title);
    const picker = panel.getByRole('combobox', { name: 'Stage for T1' });
    await expect(picker).toHaveValue('Building');
    expect(await overflow(panel)).toBe(0);
    const pill = panel.locator('.rm-stage-pill');
    const colours = await pill.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      text: getComputedStyle(element).color,
    }));
    expect(colours.background).not.toBe(colours.text);
    await host.page.getByRole('button', { name: 'Close tasks' }).click();
    const settings = await openSettings(host.page, room.id);
    const section = settings.getByRole('region', { name: 'Task stages' });
    await expect(section.getByLabel('Stage 4', { exact: true })).toHaveValue('Shipped');
    expect(await overflow(settings)).toBe(0);
  });
