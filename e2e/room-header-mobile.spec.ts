import {
  test,
  expect,
  type APIResponse,
  type Browser,
  type BrowserContext,
} from '@playwright/test';

/*
 * The room header on mobile viewports (360 px and 390 px):
 * - No horizontal overflow: header.scrollWidth <= header.clientWidth.
 * - The More actions button is fully inside the viewport.
 * - Search, Members and Invite move into the More menu and stay reachable there.
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
      data: { name: `Header-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
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
      data: { agent_id: agentId, name: 'Mobile room', idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(room.status(), await why(room)).toBe(201);
  const roomData = (await room.json()).room as { id: string };
  return { context, room: roomData };
}

for (const width of [360, 390]) {
  test(`room header fits ${width}px phone viewport without horizontal overflow`, async ({
    browser,
  }) => {
    const { context, room } = await roomHost(browser);
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/rooms/${room.id}`);

    await expect(page.getByRole('heading', { level: 1, name: 'Mobile room' })).toBeVisible();

    const header = page.locator('.rm-room-head');
    await expect(header).toBeVisible();

    // Verify header.scrollWidth <= header.clientWidth (no horizontal overflow)
    const metrics = await header.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(
      metrics.scrollWidth,
      `Header scrollWidth (${metrics.scrollWidth}px) exceeds clientWidth (${metrics.clientWidth}px) at ${width}px`,
    ).toBeLessThanOrEqual(metrics.clientWidth);

    // Verify More button is fully inside the viewport
    const moreBtn = page.getByRole('button', { name: 'More room actions' });
    await expect(moreBtn).toBeVisible();

    const moreBox = (await moreBtn.boundingBox())!;
    expect(
      moreBox.x,
      `More button x (${moreBox.x}) should be inside viewport`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      moreBox.x + moreBox.width,
      `More button right edge (${moreBox.x + moreBox.width}px) should be <= viewport width (${width}px)`,
    ).toBeLessThanOrEqual(width);

    // The row wraps instead of folding: the room pill (it opens Members), Search and Invite stay
    // in the top bar, fully visible, 44 px, after More in reading order.
    const invite = header.getByRole('button', { name: 'Invite', exact: true });
    await expect(invite).toBeVisible();
    const inviteBox = (await invite.boundingBox())!;
    expect(inviteBox.x + inviteBox.width).toBeLessThanOrEqual(width);
    expect(inviteBox.width).toBeGreaterThanOrEqual(44);
    expect(inviteBox.height).toBeGreaterThanOrEqual(44);
    for (const name of [/^Members of /, 'Search this room']) {
      const button = header.getByRole('button', { name });
      await expect(button).toBeVisible();
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }

    // The More menu lists the room actions; Members (the pill), Search and Invite are not there.
    await moreBtn.click();
    const menu = page.getByRole('menu', { name: 'More room actions' });
    await expect(menu.getByRole('menuitem', { name: 'Room settings' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Connect AI' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^Members/ })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Invite' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Search messages' })).toHaveCount(0);
  });
}

for (const width of [360, 390]) {
  test(`${width}px: with the Elric switch and a two-digit task count, nothing in the header overlaps`, async ({
    browser,
  }) => {
    const { context, room } = await roomHost(browser);
    const page = await context.newPage();
    // Elric on for this account (as in production), so the host's header shows its switch.
    await page.route('**/api/elric', (route) =>
      route.fulfill({
        json: { agent_id: null, eligible: true, eligibility_reason: null, over_18: true },
      }),
    );
    const agents = await (await context.request.get('/api/snapshot')).json();
    const agentId = (agents.agents as { id: string }[])[0]!.id;
    for (let index = 0; index < 12; index++) {
      const created = await patient(() =>
        context.request.post(`/api/rooms/${room.id}/tasks`, {
          headers,
          data: {
            agent_id: agentId,
            title: `Task ${index + 1}`,
            idempotency_key: crypto.randomUUID(),
          },
        }),
      );
      expect(created.ok(), await why(created)).toBeTruthy();
    }
    await page.setViewportSize({ width, height: 844 });
    const tasksLoaded = page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/api/rooms/${room.id}/tasks`,
    );
    await page.goto(`/rooms/${room.id}`);
    await tasksLoaded;
    await expect(page.locator('.rm-room-head .rm-head-elric')).toBeVisible();
    const header = page.locator('.rm-room-head');
    await expect(header.locator('.rm-head-elric')).toBeVisible();
    await expect(header.getByRole('button', { name: 'Invite', exact: true })).toBeVisible();
    // Tasks stays in the row with its count (the row wraps rather than folding).
    await expect(header.getByRole('button', { name: 'Tasks, 12 to do' })).toBeVisible();
    await expect(header.getByTestId('tasks-button').locator('.rm-count')).toHaveText('12');
    // The pill and every chip: inside the viewport, and no two of them overlap (in either axis).
    const boxes = await header.evaluate((element) =>
      [
        ...element.querySelectorAll<HTMLElement>(
          '.rm-menu, .rm3-pill, .rm-head-actions > *:not(.rm-switch-toast)',
        ),
      ]
        .filter((item) => item.getClientRects().length && getComputedStyle(item).display !== 'none')
        .map((item) => {
          const box = item.getBoundingClientRect();
          return {
            name: item.getAttribute('aria-label') ?? item.textContent,
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
          };
        }),
    );
    expect(boxes.length).toBeGreaterThanOrEqual(6);
    for (const [index, box] of boxes.entries()) {
      expect(box.left, `${box.name} starts inside the viewport`).toBeGreaterThanOrEqual(0);
      expect(box.right, `${box.name} ends inside the viewport`).toBeLessThanOrEqual(width);
      for (const other of boxes.slice(index + 1)) {
        const apart =
          other.left >= box.right - 0.5 ||
          other.right <= box.left + 0.5 ||
          other.top >= box.bottom - 0.5 ||
          other.bottom <= box.top + 0.5;
        expect(apart, `${other.name} overlaps ${box.name}`).toBe(true);
      }
    }
    // Connect AI is in the More menu; the workspace drawer leads back to the rooms.
    await page.getByRole('button', { name: 'More room actions' }).click();
    await page.getByRole('menuitem', { name: 'Connect AI' }).click();
    await expect(page.getByRole('dialog', { name: /Connect/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Workspace' })
      .getByRole('button', { name: 'Rooms', exact: true })
      .click();
    await expect(page).toHaveURL(/\/rooms$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Your rooms' })).toBeVisible();
  });
}
