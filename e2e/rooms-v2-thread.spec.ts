import {
  test,
  expect,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { workspaceTarget } from './workspace-density';

/*
 * Smart Rooms v2 (preview) thread: soft bubbles with a sender row and the AI badge, and the
 * "New since HH:MM · N updates" divider above the first unread message. The divider follows this
 * device's read mark (the one the room list's unread badge uses); it goes once the room was read
 * and left, or after the viewer's next post. No horizontal scroll at 360 and 390 px, light and
 * dark. With RV2_SHOTS_DIR set, the last test saves screenshots of the v2 room there.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };
// Two accounts, a room and a read pass per test: more than the default 45 s on a busy machine.
test.describe.configure({ timeout: 90_000 });

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

async function account(browser: Browser, label: string, agentName: string, theme?: 'dark') {
  const context = await browser.newContext();
  opened.push(context);
  if (theme)
    await context.addInitScript((value) => {
      try {
        window.localStorage.setItem('cc-theme', value);
      } catch {
        // Storage blocked: the page stays light.
      }
    }, theme);
  const name = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const created = await patient(() =>
    context.request.post('/api/auth/register', { headers, data: { name, password: PASSWORD } }),
  );
  expect(created.status(), await why(created)).toBe(201);
  const agent = await patient(() =>
    context.request.post('/api/agents', {
      headers,
      data: { name: agentName, capability: 'research', mode: 'external' },
    }),
  );
  expect(agent.ok(), await why(agent)).toBeTruthy();
  return {
    context,
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
  const key = crypto.randomUUID();
  const res = await patient(() =>
    member.request.post(`/api/rooms/${target.slug}/join`, {
      headers,
      data: { token: target.token, agent_id: member.agentId, idempotency_key: key },
    }),
  );
  expect(res.status(), await why(res)).toBe(200);
}

async function post(author: Account, target: Room, text: string) {
  const key = crypto.randomUUID();
  const res = await patient(() =>
    author.request.post(`/api/rooms/${target.id}/messages`, {
      headers,
      data: { text, idempotency_key: key },
    }),
  );
  expect(res.status(), await why(res)).toBe(201);
  return (await res.json()).message.seq as number;
}

const divider = (page: Page) => page.getByTestId('room-new-since');
const roomList = (page: Page) =>
  page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Rooms', exact: true });
const entry = (page: Page, name: string) =>
  page.getByRole('list', { name: 'All rooms' }).getByRole('link').filter({ hasText: name });

/** A host with the v2 preview on, a guest AI in the room, and the room read once by the host. */
async function readRoom(browser: Browser, name: string, theme?: 'dark') {
  const host = await account(browser, 'Thread-host', 'Host agent', theme);
  const guest = await account(browser, 'Thread-guest', 'Scout');
  const target = await room(host, name);
  await join(guest, target);
  await post(host, target, 'Welcome, this is where we work.');
  await host.page.goto('/rooms?rooms=v2');
  await expect(host.page.locator('.rm-app[data-rooms="v2"]')).toBeVisible();
  await entry(host.page, name).click();
  await expect(host.page.getByText('Welcome, this is where we work.')).toBeVisible();
  // No unread messages yet: no divider.
  await expect(divider(host.page)).toHaveCount(0);
  await roomList(host.page).click();
  return { host, guest, target };
}

test('the New since divider sits above the first unread message and goes once read', async ({
  browser,
}) => {
  const { host, guest, target } = await readRoom(browser, 'Divider room');
  await post(guest, target, 'First update while you were away');
  await post(guest, target, 'Second update while you were away');

  const page = host.page;
  await entry(page, 'Divider room').click();
  await expect(page.getByText('Second update while you were away')).toBeVisible();
  await expect(divider(page)).toHaveCount(1);
  await expect(divider(page).locator('.rm-unread-pill')).toHaveText(
    /^New since \d{1,2}:\d{2}.* · 2 updates$/,
  );
  await expect(divider(page).getByRole('separator')).toHaveAttribute(
    'aria-label',
    /New since .* · 2 updates/,
  );
  // Directly above the first unread message, after the last message already seen.
  const next = divider(page).locator('xpath=following-sibling::li[1]');
  await expect(next).toContainText('First update while you were away');
  const previous = divider(page).locator('xpath=preceding-sibling::li[1]');
  await expect(previous).toContainText('Welcome, this is where we work.');
  // A row in the list, never pinned or floating.
  expect(await divider(page).evaluate((element) => getComputedStyle(element).position)).toBe(
    'static',
  );
  // The summary slot holds only the collapsed "Catch me up" button.
  await expect(divider(page).locator('[data-slot="new-since-summary"]')).toHaveText('Catch me up');

  // Others' messages: a soft bubble under a sender row with the AI badge and the time.
  const message = page
    .getByTestId('room-message')
    .filter({ hasText: 'First update while you were away' });
  await expect(message.locator('.rm-byline .rm-agent-label')).toContainText('AI');
  await expect(message).toHaveClass(/(^|\s)ai(\s|$)/);
  await expect(message.locator('.rm-byline time')).toBeVisible();
  const bubble = await message
    .locator('.rm-bubble')
    .evaluate((element) => getComputedStyle(element).borderTopRightRadius);
  expect(parseFloat(bubble)).toBeGreaterThanOrEqual(12);

  // Read to the bottom, leave and come back: the divider is gone.
  await page.getByTestId('room-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await roomList(page).click();
  await entry(page, 'Divider room').click();
  await expect(page.getByText('Second update while you were away')).toBeVisible();
  await expect(divider(page)).toHaveCount(0);
});

test('the New since divider goes after your next post', async ({ browser }) => {
  const { host, guest, target } = await readRoom(browser, 'Reply room');
  await post(guest, target, 'Something new for the host');
  const page = host.page;
  await entry(page, 'Reply room').click();
  await expect(divider(page)).toContainText('1 update');
  await page.getByLabel('Message', { exact: true }).fill('Thanks, on it');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await expect(page.getByText('Thanks, on it', { exact: true })).toBeVisible();
  await expect(divider(page)).toHaveCount(0);
});

/* Elric's catch-up in the divider. The catch-up route is mocked: no model call, nothing billed. */
const catchUpRoute = '**/api/rooms/*/catch-up';
const catchUpBody = (extra: Record<string, unknown> = {}) => ({
  room_id: 'mocked',
  from_seq: 0,
  to_seq: 0,
  truncated: false,
  sections: [],
  nothing_important: true,
  cached: false,
  ...extra,
});
const catchUpCard = (page: Page) => page.getByTestId('room-catch-up');
const catchUpOpen = (page: Page) => page.getByRole('button', { name: 'Catch me up' });

test('Catch me up: collapsed, then loading, then the summary with clickable citations', async ({
  browser,
}) => {
  const { host, guest, target } = await readRoom(browser, 'Catch-up room');
  const first = await post(guest, target, 'We picked the blue palette');
  await post(guest, target, 'Who owns the launch post?');
  const page = host.page;
  const requests: Record<string, unknown>[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(catchUpRoute, async (route) => {
    requests.push(route.request().postDataJSON() as Record<string, unknown>);
    await held;
    await route.fulfill({
      json: catchUpBody({
        nothing_important: false,
        sections: [
          {
            kind: 'decisions',
            title: 'Decisions',
            bullets: [{ text: 'Blue palette <b>chosen</b>', seqs: [first] }],
          },
          {
            kind: 'tasks',
            title: 'Tasks that moved',
            bullets: [
              { text: 'Launch post moved', seqs: [first], task_number: 1 },
              { text: 'An old task moved', seqs: [first], task_number: 999 },
            ],
          },
        ],
      }),
    });
  });
  await entry(page, 'Catch-up room').click();
  await expect(divider(page)).toHaveCount(1);
  // Collapsed: nothing is fetched until the button is clicked.
  await expect(catchUpOpen(page)).toBeVisible();
  const size = await catchUpOpen(page).boundingBox();
  expect(size!.height).toBeGreaterThanOrEqual(workspaceTarget(page.viewportSize()!.width));
  expect(requests).toHaveLength(0);
  await catchUpOpen(page).click();
  await expect(catchUpCard(page)).toHaveAttribute('data-state', 'loading');
  await expect(catchUpCard(page).locator('.rm-catchup-thinking')).toBeVisible();
  expect(requests).toHaveLength(1);
  // after_seq is this device's read mark: the last message the host had seen.
  expect(requests[0]!.after_seq).toBe(first - 1);
  release();
  await expect(catchUpCard(page)).toHaveAttribute('data-state', 'ready');
  await expect(catchUpCard(page).getByRole('heading', { name: 'Decisions' })).toBeVisible();
  // Plain text: the markup shows as typed, never as HTML.
  await expect(catchUpCard(page)).toContainText('Blue palette <b>chosen</b>');
  await expect(catchUpCard(page).locator('b')).toHaveCount(0);
  // A cited seq goes to that message.
  await catchUpCard(page)
    .getByRole('button', { name: `Go to message ${first}` })
    .first()
    .click();
  await expect(
    page.getByTestId('room-message').filter({ hasText: 'We picked the blue palette' }),
  ).toBeFocused();
  // A task number opens the Tasks panel.
  await catchUpCard(page).getByRole('button', { name: 'Open task T1' }).click();
  await expect(page.getByRole('complementary', { name: 'Tasks' })).toBeVisible();
  // A task outside the loaded list is never a dead click: the panel says it is not loaded.
  await catchUpCard(page).getByRole('button', { name: 'Open task T999' }).click();
  await expect(page.getByTestId('tasks-missing')).toContainText('T999');
});

test('Catch me up: off says why, paused hides it, 429 says when, a limit shows the notice, an error offers a retry', async ({
  browser,
}) => {
  const { host, guest, target } = await readRoom(browser, 'Catch-up states');
  const page = host.page;
  const reply: { next: (route: Route) => Promise<void> } = { next: (route) => route.abort() };
  await page.route(catchUpRoute, (route) => reply.next(route));

  // Off: the host's Elric is off for this room: one quiet line says why, no button.
  await post(guest, target, 'An update while Elric is off');
  reply.next = (route) =>
    route.fulfill({ status: 409, json: { error: 'Off.', code: 'elric_catch_up_off' } });
  await entry(page, 'Catch-up states').click();
  await catchUpOpen(page).click();
  await expect(catchUpOpen(page)).toHaveCount(0);
  await expect(catchUpCard(page)).toHaveCount(0);
  await expect(page.getByTestId('room-catch-up-unavailable')).toHaveText(
    'Catch-up needs Elric in this room.',
  );
  await expect(divider(page)).toHaveCount(1);
  await page.getByTestId('room-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await roomList(page).click();

  // Elric off for everyone (the kill switch): nothing at all.
  await post(guest, target, 'An update while Elric is paused');
  reply.next = (route) =>
    route.fulfill({ status: 409, json: { error: 'Off.', code: 'elric_catch_up_paused' } });
  await entry(page, 'Catch-up states').click();
  await catchUpOpen(page).click();
  await expect(catchUpOpen(page)).toHaveCount(0);
  await expect(catchUpCard(page)).toHaveCount(0);
  await expect(page.getByTestId('room-catch-up-unavailable')).toHaveCount(0);
  await page.getByTestId('room-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await roomList(page).click();

  // Rate limited: the limit line with when to try again.
  await post(guest, target, 'An update too soon');
  reply.next = (route) =>
    route.fulfill({
      status: 429,
      headers: { 'Retry-After': '30' },
      json: { error: 'Too many requests. Try again later.' },
    });
  await entry(page, 'Catch-up states').click();
  await catchUpOpen(page).click();
  await expect(catchUpCard(page)).toHaveAttribute('data-state', 'limited');
  await expect(catchUpCard(page)).toContainText(
    'Too many catch-ups just now. Try again in 30 seconds.',
  );
  await page.getByTestId('room-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await roomList(page).click();

  // A used-up allowance: the reset notice.
  await post(guest, target, 'An update over the limit');
  const notice = 'Summaries used up for today. Resets at 00:00 UTC.';
  reply.next = (route) =>
    route.fulfill({
      json: catchUpBody({ nothing_important: false, incomplete: 'limit', notice }),
    });
  await entry(page, 'Catch-up states').click();
  await catchUpOpen(page).click();
  await expect(catchUpCard(page)).toContainText(notice);
  await page.getByTestId('room-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await roomList(page).click();

  // An error: a plain retry; then nothing important is one quiet line.
  await post(guest, target, 'An update while the server fails');
  reply.next = (route) => route.fulfill({ status: 500, json: { error: 'Failed.' } });
  await entry(page, 'Catch-up states').click();
  await catchUpOpen(page).click();
  await expect(catchUpCard(page)).toHaveAttribute('data-state', 'error');
  reply.next = (route) => route.fulfill({ json: catchUpBody() });
  await catchUpCard(page).getByRole('button', { name: 'Try again' }).click();
  await expect(catchUpCard(page).locator('.rm-catchup-quiet')).toHaveText(
    'Nothing important while you were away.',
  );
});

const LONG =
  'A longer update so the bubble wraps across several lines: the header fix landed, the ' +
  'phone layout keeps every action in view, and https://example.com/a/very/long/path/that/' +
  'should/wrap/inside/the/bubble/instead/of/pushing/the/page/sideways stays a link. ' +
  'Supercalifragilisticexpialidocious_identifiers_without_spaces_must_wrap_too.';
const CODE =
  'Here is the check:\n\n```ts\nconst overflow = document.documentElement.scrollWidth > window.innerWidth; // never true on a phone\n```';

for (const theme of ['light', 'dark'] as const)
  for (const width of [360, 390])
    test(`no horizontal scroll at ${width} px (${theme})`, async ({ browser }) => {
      const { host, guest, target } = await readRoom(
        browser,
        `Narrow ${width} ${theme}`,
        theme === 'dark' ? 'dark' : undefined,
      );
      await post(guest, target, LONG);
      await post(guest, target, CODE);
      const page = host.page;
      await page.setViewportSize({ width, height: 800 });
      await entry(page, `Narrow ${width} ${theme}`).click();
      await expect(page.locator('.md-code')).toBeVisible();
      await expect(divider(page)).toBeVisible();
      if (theme === 'dark')
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      else await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
      const widths = await page.evaluate(() => {
        const scroll = document.querySelector<HTMLElement>('[data-testid="room-scroll"]')!;
        return {
          page: document.documentElement.scrollWidth,
          view: document.documentElement.clientWidth,
          list: scroll.scrollWidth,
          listView: scroll.clientWidth,
        };
      });
      expect(widths.page).toBeLessThanOrEqual(widths.view);
      expect(widths.list).toBeLessThanOrEqual(widths.listView);
    });

test('screenshots of the v2 room', async ({ browser }) => {
  const dir = process.env.RV2_SHOTS_DIR;
  test.skip(!dir, 'set RV2_SHOTS_DIR to save screenshots');
  test.setTimeout(120_000);
  mkdirSync(dir!, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    const { host, guest, target } = await readRoom(
      browser,
      `Design review ${theme}`,
      theme === 'dark' ? 'dark' : undefined,
    );
    await post(guest, target, 'Ran the suite at 360 and 390 px: no horizontal scrollbar.');
    await post(guest, target, LONG);
    await post(guest, target, CODE);
    const page = host.page;
    await entry(page, `Design review ${theme}`).click();
    await expect(page.locator('.md-code')).toBeVisible();
    await expect(divider(page)).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: joinPath(dir!, `room-v2-${width}-${theme}.png`) });
    }
  }
});
