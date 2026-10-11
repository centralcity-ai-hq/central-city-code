import {
  test,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

/*
 * Smart Rooms v2 Tasks sheet (src/rooms/TasksPanel.tsx with ?rooms=v2, TasksV2.tsx): the filter
 * row shows real counts and filters, fits phone widths without page scroll, every card shows one
 * status, and an AI claimer carries the AI badge.
 * Set RV2_SHOTS=<dir> to also save screenshots at 1440 and 390, light and dark.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

async function patient(call: () => Promise<APIResponse>): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const response = await call();
    if (response.status() !== 429 || attempt >= 6) return response;
    const wait = Number(response.headers()['retry-after'] ?? '5');
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(wait, 1), 20) * 1000));
  }
}
const why = async (response: APIResponse) =>
  `${response.status()} ${(await response.text()).slice(0, 300)}`;

const opened: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((context) => context.close()));
});

async function account(browser: Browser, label: string) {
  const context = await browser.newContext();
  opened.push(context);
  const created = await patient(() =>
    context.request.post('/api/auth/register', {
      headers,
      data: { name: `${label}-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
    }),
  );
  expect(created.status(), await why(created)).toBe(201);
  return { context, request: context.request };
}

async function post(request: APIRequestContext, url: string, data: Record<string, unknown>) {
  const response = await patient(() => request.post(url, { headers, data }));
  expect(response.ok(), await why(response)).toBeTruthy();
  return response.json();
}

const TITLES = [
  'Draft the launch post',
  'Check the pricing page copy',
  'Collect feedback from the beta group',
  'Fix the signup email typo',
  'Write release notes for October',
  'Review the onboarding checklist before the next cohort starts on Monday morning',
  'Translate the FAQ into Spanish',
  'Plan the next community call',
];

/**
 * A host's room with eight tasks; Scout (another account's AI agent) claimed some of them:
 * Open 3 (T1, T5, T8), Claimed 2 (T2, T6), In review 1 (T3), Done 2 (T4, T7).
 */
async function seededRoom(browser: Browser) {
  const host = await account(browser, 'rv2-host');
  const agent = await post(host.request, '/api/agents', {
    name: 'Host agent',
    capability: 'research',
    mode: 'external',
  });
  const hostAgent = agent.agent.id as string;
  const { room } = (await post(host.request, '/api/rooms', {
    agent_id: hostAgent,
    name: 'Launch plan',
    idempotency_key: crypto.randomUUID(),
  })) as { room: { id: string } };
  const link = await post(host.request, `/api/rooms/${room.id}/link`, {});
  const token = new URL(link.link as string).hash.slice(1);
  const member = await account(browser, 'rv2-member');
  await post(member.request, `/api/rooms/${room.id}/join`, {
    token,
    create: { name: 'Scout' },
    idempotency_key: crypto.randomUUID(),
  });

  const ids: string[] = [];
  for (const title of TITLES) {
    const { task } = await post(host.request, `/api/rooms/${room.id}/tasks`, {
      agent_id: hostAgent,
      title,
      idempotency_key: crypto.randomUUID(),
    });
    ids.push(task.id as string);
  }
  const base = `/api/rooms/${room.id}/tasks`;
  const claim = async (index: number) =>
    (await post(member.request, `${base}/${ids[index]}/claim`, {
      idempotency_key: crypto.randomUUID(),
    })) as { claim_token: string };
  const handIn = async (index: number) => {
    const { claim_token } = await claim(index);
    await post(member.request, `${base}/${ids[index]}/result`, {
      claim_token,
      evidence: { kind: 'proposal', ref: `https://example.com/t${index + 1}`, revision: 'r1' },
    });
  };
  await claim(1);
  await claim(5);
  await handIn(2);
  await handIn(3);
  await handIn(6);
  await post(host.request, `${base}/${ids[3]}/update`, { decision: 'approve' });
  await post(host.request, `${base}/${ids[6]}/update`, { decision: 'approve' });
  for (const body of ['Two numbers look off.', 'Fixed in the draft.']) {
    await post(member.request, `${base}/${ids[1]}/comments`, {
      body,
      idempotency_key: crypto.randomUUID(),
    });
  }
  return { host, room };
}

async function openTasks(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Launch plan' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: /^Tasks/ }).click();
  const panel = page.getByRole('complementary', { name: 'Tasks' });
  await expect(panel).toBeVisible();
  return panel;
}

test('v2 tasks: real filter counts, filtering, one status per card, AI badge, detail view', async ({
  browser,
}) => {
  const { host, room } = await seededRoom(browser);
  const page = await host.context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const panel = await openTasks(page, room.id);
  await expect(page.locator('.rm-app')).toHaveAttribute('data-rooms', 'v2');

  const filters = panel.getByRole('group', { name: 'Filter tasks' });
  const chip = (name: string) => filters.getByRole('button', { name, exact: true });
  for (const label of ['All (8)', 'Open (3)', 'Claimed (2)', 'In review (1)', 'Done (2)'])
    await expect(chip(label)).toBeVisible();
  await expect(chip('All (8)')).toHaveAttribute('aria-pressed', 'true');
  // At 1440 the chips stay on one line that scrolls inside the sheet and fades at its edge.
  const desktopRow = await filters.evaluate((el) => ({
    overflow: el.scrollWidth > el.clientWidth,
    tops: new Set([...el.children].map((item) => (item as HTMLElement).offsetTop)).size,
    fade: el.getAttribute('data-fade'),
  }));
  expect(desktopRow.tops).toBe(1);
  if (desktopRow.overflow) expect(desktopRow.fade).toBe('end');

  const cards = panel.getByTestId('task-card');
  await expect(cards).toHaveCount(8);
  // Exactly one status per card, never two.
  for (let index = 0; index < 8; index++)
    await expect(cards.nth(index).getByTestId('task-status')).toHaveCount(1);

  await chip('Open (3)').click();
  await expect(chip('Open (3)')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip('All (8)')).toHaveAttribute('aria-pressed', 'false');
  await expect(cards).toHaveCount(3);
  for (let index = 0; index < 3; index++)
    await expect(cards.nth(index).getByTestId('task-status')).toHaveText('Open');

  // Keyboard: Tab reaches the chips and Enter picks one.
  await chip('Open (3)').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(chip('In review (1)')).toHaveAttribute('aria-pressed', 'true');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('T3');
  await expect(cards.first().getByTestId('task-status')).toHaveText('In review');

  await chip('Done (2)').click();
  await expect(cards).toHaveCount(2);
  for (let index = 0; index < 2; index++)
    await expect(cards.nth(index).getByTestId('task-status')).toHaveText('Done');

  // The AI claimer: avatar, name and the AI badge; the comment count on the right.
  await chip('Claimed (2)').click();
  await expect(cards).toHaveCount(2);
  const claimed = cards.filter({ hasText: 'Check the pricing page copy' });
  await expect(claimed).toContainText('T2');
  await expect(claimed.getByTestId('task-claimer')).toContainText('Scout');
  await expect(claimed.getByTestId('task-ai-badge')).toHaveText('AI');
  await expect(claimed).toContainText('2 comments');

  // Detail view: same behaviour as v1 (comments open, status line), then back to the list.
  await claimed.click();
  await expect(
    panel.getByRole('heading', { name: 'T2: Check the pricing page copy' }),
  ).toBeVisible();
  await expect(panel.getByTestId('task-status')).toHaveCount(1);
  await expect(panel.getByTestId('task-status')).toHaveText('Claimed');
  await expect(panel.getByText('Two numbers look off.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Ask for review' })).toBeVisible();
  await panel.getByRole('button', { name: 'All tasks' }).click();
  await expect(chip('Claimed (2)')).toHaveAttribute('aria-pressed', 'true');
  await expect(cards).toHaveCount(2);

  // An open task offers no "Ask for review".
  await chip('Open (3)').click();
  await cards.filter({ hasText: 'Draft the launch post' }).click();
  await expect(panel.getByRole('heading', { name: 'T1: Draft the launch post' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Ask for review' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const width of [360, 390]) {
  test(`v2 tasks: the filter row fits ${width}px with no horizontal page scroll`, async ({
    browser,
  }) => {
    const { host, room } = await seededRoom(browser);
    const page = await host.context.newPage();
    await page.setViewportSize({ width, height: 812 });
    const panel = await openTasks(page, room.id);
    const filters = panel.getByRole('group', { name: 'Filter tasks' });
    await expect(filters).toBeVisible();

    const page_ = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(page_.scroll, 'the page scrolls sideways').toBeLessThanOrEqual(page_.client);
    const sheet = await panel.evaluate((el) => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
    }));
    expect(sheet.scroll, 'the sheet scrolls sideways').toBeLessThanOrEqual(sheet.client);

    const box = (await filters.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    // On a phone the chips wrap onto two rows: none is cut off, nothing scrolls sideways.
    const row = await filters.evaluate((el) => ({
      overflow: el.scrollWidth > el.clientWidth,
      tops: new Set([...el.children].map((chip) => (chip as HTMLElement).offsetTop)).size,
    }));
    expect(row.overflow).toBe(false);
    expect(row.tops).toBeLessThanOrEqual(2);
    for (const chip of await filters.getByRole('button').all()) {
      const chipBox = (await chip.boundingBox())!;
      expect(chipBox.x).toBeGreaterThanOrEqual(0);
      expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(width);
    }
    const done = filters.getByRole('button', { name: 'Done (2)' });
    await done.focus();
    await page.keyboard.press('Enter');
    await expect(done).toHaveAttribute('aria-pressed', 'true');
    await expect(done).toBeInViewport();
    await expect(panel.getByTestId('task-card')).toHaveCount(2);
    const after = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(after).toBeLessThanOrEqual(width);
  });
}

test('v3 tasks at 390: every control on the card, the detail and the form is 44px tall', async ({
  browser,
}) => {
  const { host, room } = await seededRoom(browser);
  const page = await host.context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await openTasks(page, room.id);
  const tall = async (locator: ReturnType<Page['locator']>, what: string) => {
    for (const item of await locator.all())
      expect((await item.boundingBox())!.height, what).toBeGreaterThanOrEqual(44);
  };
  const card = panel.getByTestId('task-card').filter({ hasText: 'Check the pricing page copy' });
  // The title's hit area is the whole card; the buttons on the card are 44px themselves.
  await expect(card.getByTestId('task-pin')).toHaveCount(1);
  await tall(
    card.locator('.rm-v3-task-pin, .rm-v3-task-actions button'),
    'card buttons (Pin, Comments, Ask for a review)',
  );
  expect((await card.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await tall(panel.getByRole('group', { name: 'Filter tasks' }).getByRole('button'), 'tabs');
  await card.getByRole('button', { name: 'Ask for a review' }).click();
  await expect(panel.getByRole('form', { name: 'Ask for a review' })).toBeVisible();
  await tall(panel.getByRole('button', { name: 'All tasks' }), 'All tasks');
  await tall(panel.locator('.rm-task').getByRole('button'), 'detail buttons');
  await panel.getByRole('button', { name: 'All tasks' }).click();
  await panel.getByRole('button', { name: 'New task' }).click();
  await tall(panel.locator('.rm-task-form').getByRole('button'), 'New task form buttons');
});

test('screenshots at 1440 and 390, light and dark', async ({ browser }) => {
  const dir = process.env.RV2_SHOTS;
  test.skip(!dir, 'set RV2_SHOTS to save screenshots');
  test.setTimeout(120_000);
  const { host, room } = await seededRoom(browser);
  const page = await host.context.newPage();
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript((value) => localStorage.setItem('cc-theme', value), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const panel = await openTasks(page, room.id);
      await expect(panel.getByTestId('task-card')).toHaveCount(8);
      await page.screenshot({ path: `${dir}/tasks-sheet-${width}-${theme}.png` });
      await panel.getByTestId('task-card').filter({ hasText: 'Check the pricing page' }).click();
      await expect(panel.getByText('Two numbers look off.')).toBeVisible();
      await page.screenshot({ path: `${dir}/task-detail-${width}-${theme}.png` });
    }
  }
});
