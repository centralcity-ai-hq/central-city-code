import {
  test,
  expect,
  type APIResponse,
  type Browser,
  type BrowserContext,
} from '@playwright/test';

/*
 * Smart Rooms v2 is the only rooms design (src/rooms/roomsV2.ts): data-rooms="v2" on the rooms app
 * root for everyone; an old ?rooms=v1 link or a stored opt-out no longer switches back.
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
      data: { name: `Preview-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
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
      data: { agent_id: agentId, name: 'Preview room', idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(room.status(), await why(room)).toBe(201);
  return { context, room: (await room.json()).room as { id: string } };
}

test('rooms v2 is the only design: ?rooms=v1 and a stored opt-out do not switch back', async ({
  browser,
}) => {
  const { context, room } = await roomHost(browser);
  const page = await context.newPage();
  const app = page.locator('.rm-app');
  const heading = page.getByRole('heading', { level: 1, name: 'Preview room' });

  // The v2 tokens apply: the calmer grey canvas and a white header.
  await page.goto(`/rooms/${room.id}`);
  await expect(heading).toBeVisible();
  await expect(app).toHaveAttribute('data-rooms', 'v2');
  await expect(app).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  // Workspace v3: the top bar is no bar; its pill and chips float on the canvas as white cards.
  await expect(page.locator('.rm-room-head')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.rm3-pill')).toHaveCSS('background-color', 'rgb(255, 255, 255)');

  // An old ?rooms=v1 link: still v2, and the parameter leaves the address.
  await page.goto(`/rooms/${room.id}?rooms=v1`);
  await expect(heading).toBeVisible();
  await expect(app).toHaveAttribute('data-rooms', 'v2');
  await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}$`));

  // A browser that opted out earlier: still v2, Tasks sheet included.
  await page.evaluate(() => localStorage.setItem('cc-rooms-v2', 'v1'));
  await page.reload();
  await expect(heading).toBeVisible();
  await expect(app).toHaveAttribute('data-rooms', 'v2');
  await page.getByRole('button', { name: /^Tasks/ }).click();
  await expect(page.getByRole('complementary', { name: 'Tasks' })).toHaveClass(/rm-v2-tasks/);
});
