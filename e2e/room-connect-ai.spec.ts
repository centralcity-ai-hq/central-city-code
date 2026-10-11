import {
  test,
  expect,
  type APIResponse,
  type Browser,
  type BrowserContext,
} from '@playwright/test';

/*
 * "Connect AI" in the room's More menu: ONE click opens the Connect AI sheet, on the desktop
 * bar and on a 390 px phone. The sheet's code loads lazily; a click that only started the
 * download looked like it did nothing (the Suspense fallback draws nothing, so a second click
 * seemed to be the one that worked). The chunk now warms while the room is idle and again when
 * the menu opens, so the click finds it ready. The specs below also wait for that chunk request.
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

async function roomHost(browser: Browser) {
  const context = await browser.newContext();
  opened.push(context);
  const request = context.request;
  const created = await patient(() =>
    request.post('/api/auth/register', {
      headers,
      data: { name: `Connect-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
    }),
  );
  expect(created.status(), await why(created)).toBe(201);
  const agent = await patient(() =>
    request.post('/api/agents', {
      headers,
      data: { name: 'Host agent', capability: 'research', mode: 'external' },
    }),
  );
  expect(agent.ok(), await why(agent)).toBeTruthy();
  const agentId = (await agent.json()).agent.id as string;
  const room = await patient(() =>
    request.post('/api/rooms', {
      headers,
      data: { agent_id: agentId, name: 'Connect room', idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(room.status(), await why(room)).toBe(201);
  const roomData = (await room.json()).room as { id: string };
  return { context, room: roomData };
}

// The sheet is one lazy chunk; its file carries the module's name (Vite's default naming).
const sheetChunk = /ConnectAiSheet-[^/]*\.js/;

test('desktop: one click on Connect AI in the More menu opens the Connect AI sheet', async ({
  browser,
}) => {
  const { context, room } = await roomHost(browser);
  const page = await context.newPage();
  // The warm fires once the room is idle, at the latest when the menu opens: before the click.
  const warmed = page.waitForRequest(sheetChunk);
  await page.goto(`/rooms/${room.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Connect room' })).toBeVisible();

  await page.getByRole('button', { name: 'More room actions' }).click();
  await warmed;
  const menu = page.getByRole('menu', { name: 'More room actions' });
  await menu.getByRole('menuitem', { name: 'Connect AI' }).click();

  // One click: the dialog is there, and the menu gave way to it.
  await expect(page.getByRole('dialog', { name: 'Connect your AI' })).toBeVisible();
  await expect(menu).toHaveCount(0);
});

test('390px: one click on Connect AI in the More menu opens the Connect AI sheet', async ({
  browser,
}) => {
  const { context, room } = await roomHost(browser);
  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const warmed = page.waitForRequest(sheetChunk);
  await page.goto(`/rooms/${room.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Connect room' })).toBeVisible();

  await page.getByRole('button', { name: 'More room actions' }).click();
  await warmed;
  const menu = page.getByRole('menu', { name: 'More room actions' });
  await menu.getByRole('menuitem', { name: 'Connect AI' }).click();

  await expect(page.getByRole('dialog', { name: 'Connect your AI' })).toBeVisible();
  await expect(menu).toHaveCount(0);
});
