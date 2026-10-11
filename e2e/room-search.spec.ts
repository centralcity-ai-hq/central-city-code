import {
  test,
  expect,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

/*
 * Search inside a room: the header button opens the Search panel; results come newest first with
 * the matched words marked; a result outside the loaded page jumps into the thread and is shown;
 * no-results and filter states; on a phone the panel closes to show the message.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

/** Setup calls wait out a 429 (the suite shares one address's API budget). */
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

/** A host with a room of 56 messages: the first one (outside the newest page) holds the needle. */
async function roomWithHistory(browser: Browser) {
  const context = await browser.newContext();
  opened.push(context);
  const request = context.request;
  const name = `Search-${crypto.randomUUID().slice(0, 8)}`;
  const created = await patient(() =>
    request.post('/api/auth/register', { headers, data: { name, password: PASSWORD } }),
  );
  expect(created.status(), await why(created)).toBe(201);
  const agent = await patient(() =>
    request.post('/api/agents', {
      headers,
      data: { name: 'Search scout', capability: 'research', mode: 'external' },
    }),
  );
  expect(agent.ok(), await why(agent)).toBeTruthy();
  const agentId = (await agent.json()).agent.id as string;
  const room = await patient(() =>
    request.post('/api/rooms', {
      headers,
      data: { agent_id: agentId, name: 'Search room', idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(room.status(), await why(room)).toBe(201);
  const roomId = (await room.json()).room.id as string;
  const texts = [
    'The needle is in the archive drawer',
    ...Array.from({ length: 55 }, (_, i) => `Line ${i}`),
  ];
  for (const text of texts) {
    const key = crypto.randomUUID();
    const res = await patient(() =>
      request.post(`/api/rooms/${roomId}/messages`, {
        headers,
        data: { text, idempotency_key: key },
      }),
    );
    expect(res.status(), await why(res)).toBe(201);
  }
  return { context, roomId, name };
}

async function openSearch(page: Page) {
  await page.getByTestId('room-search-button').click();
  const panel = page.getByRole('complementary', { name: 'Search this room' });
  await expect(panel).toBeVisible();
  const box = panel.getByRole('searchbox', { name: 'Search messages' });
  await expect(box).toBeFocused();
  return { panel, box };
}

test('search finds an older message and jumps to it in the thread', async ({ browser }) => {
  const { context, roomId, name } = await roomWithHistory(browser);
  const page = await context.newPage();
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByTestId('room-message')).toHaveCount(50);
  const needle = page.getByTestId('room-message').filter({ hasText: 'The needle is in' });
  await expect(needle).toHaveCount(0);

  const { panel, box } = await openSearch(page);
  await expect(panel.getByRole('status')).toContainText('Type to search');
  await expect(panel.getByRole('status')).toContainText(
    'Find words in this room. Use "quotes" for a phrase.',
  );
  // No results.
  await box.fill('zebracorn');
  await expect(panel.getByTestId('room-search-empty')).toContainText('No messages found');
  // A hit, with the matched word marked.
  await box.fill('needle');
  const result = panel.getByTestId('room-search-result');
  await expect(result).toHaveCount(1);
  // Written without an agent: from the host as themselves (their own person, A1).
  await expect(result).toContainText(`${name} (you)`);
  await expect(result.locator('mark')).toHaveText('needle');
  // Keyboard: Tab from the search box reaches the result; Enter jumps.
  await result.focus();
  await page.keyboard.press('Enter');
  await expect(needle).toBeVisible();
  await expect(needle).toBeInViewport();
  await expect(needle).toHaveClass(/rm-found/);
  // The gap was filled: the thread runs from the needle to the newest message.
  await expect(page.getByTestId('room-message')).toHaveCount(56);

  // Filters: by sender (the only one who wrote "Line"), then a date range.
  await panel.getByText('Filters').click();
  await panel.getByLabel('From').selectOption({ label: `${name} (you)` });
  await box.fill('line');
  await expect(result.first()).toBeVisible();
  await expect(panel.getByRole('status')).toContainText('20+ results, newest first.');
  await panel.getByRole('button', { name: 'Show older results' }).click();
  await expect(result).toHaveCount(40);
  // A date range in the past finds nothing.
  await panel.getByLabel('Before').fill('2020-01-01');
  await expect(panel.getByTestId('room-search-empty')).toContainText('clear the filters');
  await panel.getByRole('button', { name: 'Clear filters' }).click();
  await expect(result.first()).toBeVisible();
  // Escape closes the panel and returns focus to the header button.
  await box.focus();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('room-search-button')).toBeFocused();
});

test('on a phone the panel closes to show the message', async ({ browser }) => {
  const { context, roomId } = await roomWithHistory(browser);
  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByTestId('room-message')).toHaveCount(50);
  // On a phone too, Search is the round chip in the room's top bar (§4.1).
  await page.locator('.rm-room-head').getByRole('button', { name: 'Search this room' }).click();
  const panel = page.getByRole('complementary', { name: 'Search this room' });
  const box = panel.getByRole('searchbox', { name: 'Search messages' });
  await expect(box).toBeFocused();
  // Touch targets stay 44px tall on a phone (the Filters toggle).
  const filters = panel.getByText('Filters', { exact: true });
  expect((await filters.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await box.fill('archive');
  await panel.getByTestId('room-search-result').click();
  await expect(panel).toHaveCount(0);
  const needle = page.getByTestId('room-message').filter({ hasText: 'The needle is in' });
  await expect(needle).toBeInViewport();
  // The page never scrolls sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('Search is the round chip in the top bar at 1280 px and at 360 px, never in More', async ({
  browser,
}) => {
  const { context, roomId } = await roomWithHistory(browser);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByTestId('room-search-button')).toBeVisible();
  const more = page.locator('.rm-room-head').getByRole('button', { name: 'More room actions' });
  await more.click();
  const menu = page.getByRole('menu', { name: 'More room actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Search messages' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 360, height: 780 });
  const search = page.getByTestId('room-search-button');
  await expect(search).toBeVisible();
  const box = (await search.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  await more.click();
  await expect(menu.getByRole('menuitem', { name: 'Search messages' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await search.click();
  await expect(search).toHaveAttribute('aria-expanded', 'true');
  const panel = page.getByRole('complementary', { name: 'Search this room' });
  await expect(panel).toBeVisible();
  await panel.getByRole('searchbox', { name: 'Search messages' }).fill('needle');
  await expect(panel.getByTestId('room-search-result')).toHaveCount(1);
});
