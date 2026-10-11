import {
  test,
  expect,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

/*
 * The Rooms list rows never cut their content: an unread badge with two or three digits sits
 * fully inside its row (not halved by the row edge, a divider or the next row), and a long room
 * name keeps a full, unclipped line of text with an ellipsis only at the end. Checked at desktop
 * width and in the phone drawer.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };
const LONG_NAME = 'Quarterly planning for the research guild with every partner team and region';

async function patient(call: () => Promise<APIResponse>): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const response = await call();
    if (response.status() !== 429 || attempt >= 6) return response;
    const wait = Number(response.headers()['retry-after'] ?? '5');
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(wait, 1), 20) * 1000));
  }
}
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
  expect(created.status()).toBe(201);
  const agent = await patient(() =>
    context.request.post('/api/agents', {
      headers,
      data: { name: `${label} agent`, capability: 'research', mode: 'external' },
    }),
  );
  expect(agent.ok()).toBeTruthy();
  return {
    context,
    request: context.request,
    agentId: (await agent.json()).agent.id as string,
  };
}
type Account = Awaited<ReturnType<typeof account>>;

async function room(host: Account, name: string, topic?: string) {
  const res = await patient(() =>
    host.request.post('/api/rooms', {
      headers,
      data: { agent_id: host.agentId, name, topic, idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(res.status()).toBe(201);
  const body = await res.json();
  return {
    id: body.room.id as string,
    slug: body.room.slug as string,
    token: (body.link.link as string).split('#')[1]!,
  };
}

/**
 * The badge sits fully inside its row and the row inside the room list, vertically centred, with
 * nothing painted over it and no clipping ancestor cutting it (soft, so one run checks both widths).
 */
async function expectBadgeFits(list: Locator, row: Locator, badge: Locator) {
  await expect(badge).toBeVisible();
  const listBox = (await list.boundingBox())!;
  const rowBox = (await row.boundingBox())!;
  const badgeBox = (await badge.boundingBox())!;
  expect
    .soft(rowBox.x + rowBox.width, 'row inside the list')
    .toBeLessThanOrEqual(listBox.x + listBox.width + 0.5);
  expect.soft(badgeBox.y).toBeGreaterThanOrEqual(rowBox.y - 0.5);
  expect.soft(badgeBox.y + badgeBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 0.5);
  expect.soft(badgeBox.x).toBeGreaterThanOrEqual(rowBox.x - 0.5);
  expect.soft(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
  const rowMid = rowBox.y + rowBox.height / 2;
  const badgeMid = badgeBox.y + badgeBox.height / 2;
  expect.soft(Math.abs(rowMid - badgeMid), 'badge vertically centred').toBeLessThanOrEqual(1.5);
  const covered = await badge.evaluate((node) => {
    const box = node.getBoundingClientRect();
    // A pill's corners are outside its rounded shape (hit testing follows the radius), so the
    // probes run along its middle: both rounded ends, the centre, and the top and bottom edges.
    const inset = 1.5;
    const midX = box.left + box.width / 2;
    const midY = box.top + box.height / 2;
    const points: [number, number][] = [
      [box.left + box.height / 2, midY],
      [box.right - box.height / 2, midY],
      [midX, midY],
      [midX, box.top + inset],
      [midX, box.bottom - inset],
    ];
    const hidden = points.filter(([x, y]) => {
      const top = document.elementFromPoint(x, y);
      return !top || !(top === node || node.contains(top));
    }).length;
    let clipped = false;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const outer = parent.getBoundingClientRect();
      if (
        box.top < outer.top - 0.5 ||
        box.bottom > outer.bottom + 0.5 ||
        box.left < outer.left - 0.5 ||
        box.right > outer.right + 0.5
      )
        clipped = true;
    }
    return { hidden, clipped, text: node.scrollWidth <= node.clientWidth + 1 };
  });
  expect.soft(covered, 'badge not covered or clipped').toEqual({
    hidden: 0,
    clipped: false,
    text: true,
  });
}

/**
 * A room name shows whole lines only (at most two, never a line cut vertically), inside its row.
 * A name that fits shows completely (scrollHeight within clientHeight); a longer one ends in an
 * ellipsis after the second line.
 */
async function expectNameReadable(name: Locator, fits: boolean) {
  const metrics = await name.evaluate((node) => {
    const style = getComputedStyle(node);
    const row = node.parentElement!.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return {
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      lineHeight: parseFloat(style.lineHeight),
      clamp: style.getPropertyValue('-webkit-line-clamp'),
      insideRow: box.top >= row.top - 0.5 && box.bottom <= row.bottom + 0.5,
    };
  });
  const lines = metrics.clientHeight / metrics.lineHeight;
  expect.soft(metrics.insideRow, 'name inside its row').toBe(true);
  expect.soft(lines, 'at least one whole line').toBeGreaterThanOrEqual(0.95);
  expect.soft(lines, 'at most two lines').toBeLessThanOrEqual(2.05);
  expect.soft(Math.abs(lines - Math.round(lines)), 'no partly cut line').toBeLessThanOrEqual(0.1);
  if (fits) expect.soft(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1);
  else {
    expect.soft(metrics.clamp, 'long names end in an ellipsis').toBe('2');
    expect.soft(Math.round(lines), 'a long name uses both lines').toBe(2);
  }
}

/**
 * A sidebar room name (WORKSPACE_V3.md §3) is one whole line inside its row: a name that fits
 * shows completely, a longer one ends in an ellipsis.
 */
async function expectOneLine(name: Locator, fits: boolean) {
  const metrics = await name.evaluate((node) => {
    const style = getComputedStyle(node);
    const row = node.parentElement!.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return {
      overflowing: node.scrollWidth > node.clientWidth + 1,
      ellipsis: style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap',
      cut: node.scrollHeight > node.clientHeight + 1,
      insideRow: box.top >= row.top - 0.5 && box.bottom <= row.bottom + 0.5,
    };
  });
  expect.soft(metrics.insideRow, 'name inside its row').toBe(true);
  expect.soft(metrics.cut, 'no line cut vertically').toBe(false);
  expect.soft(metrics.ellipsis, 'one line ending in an ellipsis').toBe(true);
  expect
    .soft(metrics.overflowing, fits ? 'a short name shows whole' : 'a long name is cut')
    .toBe(!fits);
}

async function shot(page: Page, file: string) {
  const dir = process.env.SIDEBAR_SHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${file}` });
}

test('room list rows keep the unread badge and room names whole', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await account(browser, 'Fit-host');
  const guest = await account(browser, 'Fit-guest');
  const busy = await room(host, LONG_NAME, 'Plans, owners and dates for the next quarter');
  const quiet = await room(host, 'Design review');

  const joined = await patient(() =>
    guest.request.post(`/api/rooms/${busy.slug}/join`, {
      headers,
      data: { token: busy.token, agent_id: guest.agentId, idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(joined.status()).toBe(200);
  for (let index = 1; index <= 65; index++) {
    const posted = await patient(() =>
      guest.request.post(`/api/rooms/${busy.id}/messages`, {
        headers,
        data: { text: `Update ${index}`, idempotency_key: crypto.randomUUID() },
      }),
    );
    expect(posted.status()).toBe(201);
  }

  const page = await host.context.newPage();

  // Desktop: the sidebar's Hosting group, with another room open.
  await page.goto(`/rooms/${quiet.id}`);
  const sidebar = page.locator('.sidebar').getByRole('navigation', { name: 'Rooms' });
  await expect(sidebar.getByRole('link')).toHaveCount(2);
  const row = sidebar.getByRole('link', { name: LONG_NAME });
  const badge = row.locator('.rm-room-item-badge');
  await expect(badge).toHaveText('65');
  await expect(badge).toHaveAttribute('aria-label', '65 unread');
  await shot(page, 'sidebar-1440.png');
  await expectBadgeFits(sidebar.locator('#groupHosting .ws-room-rows'), row, badge);
  await expectOneLine(row.locator('.rm-room-item-name'), false);
  await expectOneLine(
    sidebar.getByRole('link', { name: 'Design review' }).locator('.rm-room-item-name'),
    true,
  );

  // Phone: the room list page (the sidebar is off-canvas there).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/rooms');
  const overview = page.getByRole('list', { name: 'All rooms' });
  const entry = overview.getByRole('link').filter({ hasText: LONG_NAME });
  const entryBadge = entry.locator('.rm-room-item-badge');
  await expect(entryBadge).toHaveText('65');
  await shot(page, 'rooms-390.png');
  await expectBadgeFits(overview, entry, entryBadge);
  await expectNameReadable(entry.locator('.rm-overview-room-name'), true);
});
