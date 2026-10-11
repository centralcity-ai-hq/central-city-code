import {
  test,
  expect,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

/*
 * Room unread counts (audits room-a-live FINDINGS, "Unread count plan", plan A): a badge counts
 * only messages from others after this device's read mark. Your own posts and system lines
 * ("The host closed the room.", task lines) never count. Opening a room never reorders the list.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

/**
 * The test server allows each address 600 API requests a minute across the whole suite (all
 * specs share 127.0.0.1), so setup calls wait out a 429 (Retry-After) like rooms.spec.ts does,
 * instead of failing on earlier specs' traffic.
 */
async function patient(call: () => Promise<APIResponse>): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const response = await call();
    if (response.status() !== 429 || attempt >= 6) return response;
    const wait = Number(response.headers()['retry-after'] ?? '5');
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(wait, 1), 20) * 1000));
  }
}
/** Status and body in the assertion message, so a CI failure says why. */
const why = async (response: APIResponse) =>
  `${response.status()} ${(await response.text()).slice(0, 300)}`;
/** Every context a test opens is closed after it: no page keeps polling into later specs. */
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
  const agent = await patient(() =>
    context.request.post('/api/agents', {
      headers,
      data: { name: `${label} agent`, capability: 'research', mode: 'external' },
    }),
  );
  expect(agent.ok(), await why(agent)).toBeTruthy();
  return {
    request: context.request,
    agentId: (await agent.json()).agent.id as string,
    page: await context.newPage(),
  };
}
type Account = Awaited<ReturnType<typeof account>>;

async function room(host: Account, name: string) {
  const res = await patient(() =>
    host.request.post('/api/rooms', {
      headers,
      data: { agent_id: host.agentId, name, idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(res.status(), await why(res)).toBe(201);
  const body = await res.json();
  return {
    id: body.room.id as string,
    slug: body.room.slug as string,
    token: (body.link.link as string).split('#')[1]!,
  };
}
type Room = Awaited<ReturnType<typeof room>>;

async function join(member: Account, target: Room) {
  const key = crypto.randomUUID(); // one key, so a retried join never joins twice
  const res = await patient(() =>
    member.request.post(`/api/rooms/${target.slug}/join`, {
      headers,
      data: { token: target.token, agent_id: member.agentId, idempotency_key: key },
    }),
  );
  expect(res.status(), await why(res)).toBe(200);
}

async function post(author: Account, target: Room, text: string) {
  const key = crypto.randomUUID(); // one key, so a retried post never posts twice
  const res = await patient(() =>
    author.request.post(`/api/rooms/${target.id}/messages`, {
      headers,
      data: { text, idempotency_key: key },
    }),
  );
  expect(res.status(), await why(res)).toBe(201);
}

const overview = (page: Page) => page.getByRole('list', { name: 'All rooms' });
const entry = (page: Page, name: string) =>
  overview(page).getByRole('link').filter({ hasText: name });
const badge = (page: Page, name: string) => entry(page, name).locator('.rm-room-item-badge');
const order = (page: Page) => overview(page).locator('.rm-overview-room-name').allTextContents();

test('unread counts skip your own posts and system lines', async ({ browser }) => {
  const host = await account(browser, 'Unread-host');
  const guest = await account(browser, 'Unread-guest');
  const open = await room(host, 'Unread open');
  const closing = await room(host, 'Unread closing');
  await join(guest, open);
  await join(guest, closing);

  // The host writes 2 messages and a task (a system line); the guest writes 1.
  await post(host, open, 'Host line one');
  await post(host, open, 'Host line two');
  const taskKey = crypto.randomUUID();
  const task = await patient(() =>
    host.request.post(`/api/rooms/${open.id}/tasks`, {
      headers,
      data: { title: 'Unread check task', idempotency_key: taskKey },
    }),
  );
  expect(task.status(), await why(task)).toBe(201);
  await post(guest, open, 'Guest line');
  // A closed room: one message from the host, then "The host closed the room."
  await post(host, closing, 'Before closing');
  const closed = await patient(() =>
    host.request.post(`/api/rooms/${closing.id}/close`, { headers, data: {} }),
  );
  expect(closed.ok(), await why(closed)).toBeTruthy();

  // The host: only the guest's line (not 2 own posts, not the task line).
  await host.page.goto('/rooms');
  await expect(badge(host.page, 'Unread open')).toHaveText('1');
  await expect(badge(host.page, 'Unread open')).toHaveAttribute('aria-label', '1 unread');
  await expect(badge(host.page, 'Unread closing')).toHaveCount(0);

  // The guest: the host's 2 posts (not the task line, not their own line); in the closed room
  // the host's one message, not the closing line.
  await guest.page.goto('/rooms');
  await expect(badge(guest.page, 'Unread open')).toHaveText('2');
  await expect(badge(guest.page, 'Unread closing')).toHaveText('1');

  // Opening the room marks it read on this device; posting keeps it read.
  await entry(guest.page, 'Unread open').click();
  await expect(guest.page.getByText('Host line two', { exact: true })).toBeVisible();
  await guest.page.getByLabel('Message', { exact: true }).fill('Reply from the console');
  await guest.page.getByLabel('Message', { exact: true }).press('Enter');
  await expect(guest.page.getByText('Reply from the console', { exact: true })).toBeVisible();
  await guest.page.goto('/rooms');
  await expect(badge(guest.page, 'Unread closing')).toHaveText('1');
  await expect(badge(guest.page, 'Unread open')).toHaveCount(0);
});

test('opening a room leaves the room order unchanged', async ({ browser }) => {
  const host = await account(browser, 'Order-host');
  const guest = await account(browser, 'Order-guest');
  const first = await room(host, 'Order first');
  await room(host, 'Order second');
  await room(host, 'Order third');
  await join(guest, first);
  await post(guest, first, 'Activity in the oldest room');

  const page = host.page;
  await page.goto('/rooms');
  await expect(badge(page, 'Order first')).toHaveText('1');
  const before = await order(page);
  // Latest activity first: the oldest room has the newest message.
  expect(before).toEqual(['Order first', 'Order third', 'Order second']);

  await entry(page, 'Order first').click();
  await expect(page.getByText('Activity in the oldest room', { exact: true })).toBeVisible();
  // Back to the room list after at least one rooms-list poll (read marks changed meanwhile).
  await page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/rooms' && response.ok(),
    { timeout: 15_000 },
  );
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Rooms', exact: true })
    .click();
  await expect(badge(page, 'Order first')).toHaveCount(0);
  expect(await order(page)).toEqual(before);
});

test('a failing unread lookup backs off instead of retrying in a loop', async ({ browser }) => {
  const host = await account(browser, 'Backoff-host');
  const guest = await account(browser, 'Backoff-guest');
  const target = await room(host, 'Backoff room');
  await join(guest, target);
  await post(guest, target, 'Unread for the host');

  const page = host.page;
  let reads = 0;
  await page.route(`**/api/rooms/${target.id}/messages?*`, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    reads++;
    return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/rooms');
  await expect(entry(page, 'Backoff room')).toBeVisible();
  await expect.poll(() => reads).toBeGreaterThan(0);
  // Over 10 s (one or two rooms-list polls) a 5 s backoff allows a retry or two, never a loop.
  await page.waitForTimeout(10_000);
  expect(reads).toBeLessThanOrEqual(3);
  // The app stays usable: the rooms list still answers.
  await expect(badge(page, 'Backoff room')).toHaveCount(0);
  expect((await page.request.get('/api/rooms', { headers })).status()).toBe(200);
});
