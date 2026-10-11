import {
  test,
  expect as baseExpect,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test';
import { ELRIC_AI_NOTICE, ELRIC_ROOM_HINT } from '../shared/elric-copy';

/*
 * The room's Elric switch for a host who still needs a step (no Google link, or no date of
 * birth): the switch is usable (focusable, clickable, never a hover-only tooltip) and opens a
 * small popover with that step. Once the step is done it is the one-click switch again. A member
 * who isn't the host keeps the disabled, host-only switch. GET /api/elric and Elric's own add
 * calls are mocked (the main e2e server runs without CITY_ELRIC); rooms and accounts are real.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'X-City-Request': '1' };
const ELRIC_ID = 'elric-agent-1';

const opened: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((context) => context.close()));
});

async function patient(call: () => Promise<APIResponse>): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const response = await call();
    if (response.status() !== 429 || attempt >= 6) return response;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function account(
  browser: Browser,
  label: string,
  viewport?: { width: number; height: number },
) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  opened.push(context);
  const name = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const created = await patient(() =>
    context.request.post('/api/auth/register', { headers, data: { name, password: PASSWORD } }),
  );
  expect(created.status()).toBe(201);
  const page = await context.newPage();
  return { name, context, page };
}
type Account = Awaited<ReturnType<typeof account>>;

async function hostRoom(owner: Account, name: string) {
  const desk = await patient(() =>
    owner.context.request.post('/api/agents', {
      headers,
      data: { name: 'Host agent', capability: 'research', mode: 'hosted' },
    }),
  );
  expect(desk.status()).toBe(201);
  const agentId = (await desk.json()).agent.id as string;
  const response = await patient(() =>
    owner.context.request.post('/api/rooms', {
      headers,
      data: { agent_id: agentId, name, idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(response.status()).toBe(201);
  const room = (await response.json()).room as { id: string; slug: string };
  const minted = await owner.context.request.post(`/api/rooms/${room.id}/link`, {
    headers,
    data: {},
  });
  expect(minted.status()).toBe(200);
  return { ...room, link: (await minted.json()).link as string };
}

const fulfill = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * Mocks GET/POST /api/elric (status and creation), the age check, and Elric joining or leaving
 * this room (the members list then shows Elric). Returns the state the page changed.
 */
async function mockElric(
  page: Page,
  roomId: string,
  status: Record<string, unknown>,
  opts: { ages?: Array<{ status: number; body: unknown }> } = {},
) {
  const state = { joined: false, ages: [] as unknown[], joins: 0 };
  await page.route('**/api/elric', (route) => {
    if (route.request().method() === 'POST')
      return fulfill(route, { agent_id: ELRIC_ID, created: true }, 201);
    return fulfill(route, {
      agent_id: null,
      status: null,
      host_may_invoke: false,
      usage: {
        allowance: { short: 20, summary: 4, tool: 5 },
        used: { short: 0, summary: 0, tool: 0 },
        resets_at: '2026-10-04T00:00:00Z',
      },
      limit_notices: [],
      ...status,
    });
  });
  const answers = [...(opts.ages ?? [])];
  await page.route('**/api/elric/age', (route) => {
    state.ages.push(route.request().postDataJSON());
    const next = answers.shift() ?? { status: 200, body: { age_check: 'over_18' } };
    return fulfill(route, next.body, next.status);
  });
  await page.route(`**/api/rooms/${roomId}/join`, (route) => {
    state.joined = true;
    state.joins += 1;
    return fulfill(route, { room: { id: roomId, slug: 'room', name: 'Room' } });
  });
  await page.route(`**/api/rooms/${roomId}/members/${ELRIC_ID}/remove`, (route) => {
    state.joined = false;
    return fulfill(route, {});
  });
  await page.route(`**/api/rooms/${roomId}/members`, async (route) => {
    let json: { members: unknown[] };
    try {
      json = await (await route.fetch()).json();
    } catch {
      await route.continue().catch(() => {});
      return;
    }
    if (state.joined)
      json.members.push({
        id: ELRIC_ID,
        name: 'Elric',
        role: 'member',
        owner_label: 'Central City',
        own: false,
        joined_at: new Date().toISOString(),
        kind: 'agent',
        status: 'active',
        auto_reply: { provider: 'elric' },
      });
    await route.fulfill({ json });
  });
  return state;
}

test('no Google link: the header and Members switches open a Link Google popover', async ({
  browser,
}) => {
  const host = await account(browser, 'Setup-Google');
  const room = await hostRoom(host, 'Setup Google Room');
  await mockElric(host.page, room.id, { eligible: false, eligibility_reason: 'unverified' });
  const { page } = host;
  await page.goto(`/rooms/${room.id}`);

  const toggle = page.locator('.rm-room-head').getByRole('switch', { name: 'Elric' });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).not.toHaveAttribute('title', /.*/);
  await expect(toggle).toHaveAccessibleDescription('Needs a linked Google account.');

  // Keyboard: Enter opens it, focus moves in, Tab stays inside, Escape closes and returns focus.
  await toggle.focus();
  await page.keyboard.press('Enter');
  const popover = page.getByRole('dialog', { name: 'Link Google to use Elric' });
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('Elric needs a linked Google account and is for adults 18+.');
  const link = popover.getByRole('link', { name: 'Link Google' });
  await expect(link).toHaveAttribute('href', '/settings/account');
  await expect(link).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(popover.getByRole('button', { name: 'Not now' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(link).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  // A click works too (a phone has no hover); Not now closes it.
  await toggle.click();
  await expect(popover).toBeVisible();
  await popover.getByRole('button', { name: 'Not now' }).click();
  await expect(popover).toHaveCount(0);

  // The Members panel switch does the same.
  await page.getByRole('button', { name: /^Members of / }).click();
  const panel = page.getByRole('complementary', { name: 'Members' });
  const row = panel.getByRole('switch', { name: 'Elric in this room' });
  await expect(row).toBeEnabled();
  await row.click();
  await expect(panel.getByRole('dialog', { name: 'Link Google to use Elric' })).toBeVisible();
  // A click outside closes it.
  await page.locator('.rm-room-head').click({ position: { x: 4, y: 4 } });
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('no date of birth: the date in the popover adds Elric, then the switch is one click', async ({
  browser,
}) => {
  const host = await account(browser, 'Setup-Dob');
  const room = await hostRoom(host, 'Setup Dob Room');
  const state = await mockElric(
    host.page,
    room.id,
    { eligible: false, eligibility_reason: 'age_unknown' },
    {
      ages: [
        {
          status: 400,
          body: { error: 'Enter a valid date.', code: 'invalid_date_of_birth' },
        },
      ],
    },
  );
  const { page } = host;
  await page.goto(`/rooms/${room.id}`);
  // The header keeps "+ Add Elric" for a first add (it asks the date of birth once).
  await expect(
    page.locator('.rm-room-head').getByRole('button', { name: 'Add Elric' }),
  ).toBeVisible();

  await page.getByRole('button', { name: /^Members of / }).click();
  const panel = page.getByRole('complementary', { name: 'Members' });
  const toggle = panel.getByRole('switch', { name: 'Elric in this room' });
  await expect(toggle).toHaveAccessibleDescription('Needs your date of birth.');
  await toggle.click();
  const popover = page.getByRole('dialog', { name: 'Confirm your age' });
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('Elric is for adults 18+. Enter your date of birth once.');
  await expect(popover).toContainText(ELRIC_AI_NOTICE);
  const field = popover.getByLabel('Date of birth');
  await expect(field).toBeFocused();

  // The server's validation answers in place.
  await field.fill('1990-05-17');
  await popover.getByRole('button', { name: 'Continue' }).click();
  await expect(popover.getByRole('alert')).toHaveText('Please enter a valid date of birth.');
  await expect(field).toHaveAttribute('aria-invalid', 'true');

  await popover.getByRole('button', { name: 'Continue' }).click();
  await expect(popover).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(state.ages).toEqual([{ date_of_birth: '1990-05-17' }, { date_of_birth: '1990-05-17' }]);
  // The AI notice shows in the room as before (the Elric hint above the composer).
  await expect(page.getByText(ELRIC_ROOM_HINT).first()).toBeVisible();

  // From here the switch is one click each way, with no popover.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.ages).toHaveLength(2);
});

test('an eligible host: the header switch adds Elric in one click, no popover', async ({
  browser,
}) => {
  const host = await account(browser, 'Setup-Eligible');
  const room = await hostRoom(host, 'Setup Eligible Room');
  const state = await mockElric(host.page, room.id, {
    agent_id: ELRIC_ID,
    status: 'active',
    eligible: true,
    over_18: true,
  });
  const { page } = host;
  await page.goto(`/rooms/${room.id}`);
  const toggle = page.locator('.rm-room-head').getByRole('switch', { name: 'Elric' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).not.toHaveAttribute('aria-describedby', /.*/);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The switch flips optimistically; the join request lands just after.
  await expect.poll(() => state.joins).toBe(1);
});

test('a member who is not the host keeps the host-only switch, even without Google', async ({
  browser,
}) => {
  const host = await account(browser, 'Setup-Host');
  const room = await hostRoom(host, 'Setup Member Room');
  const guest = await account(browser, 'Setup-Guest');
  await mockElric(guest.page, room.id, { eligible: false, eligibility_reason: 'unverified' });
  await guest.page.goto(room.link);
  await guest.page.getByRole('button', { name: 'Join room' }).click();
  await expect(guest.page.getByRole('button', { name: /^Members of / })).toBeVisible();
  await expect(guest.page.locator('.rm-room-head').getByRole('switch')).toHaveCount(0);
  await guest.page.getByRole('button', { name: /^Members of / }).click();
  const toggle = guest.page
    .getByRole('complementary', { name: 'Members' })
    .getByRole('switch', { name: 'Elric in this room' });
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('title', 'Only the room’s host can add or remove Elric.');
  await expect(guest.page.getByRole('dialog')).toHaveCount(0);
});

test('390 px: the popover fits the screen with no sideways scroll', async ({ browser }) => {
  const host = await account(browser, 'Setup-Phone', { width: 390, height: 844 });
  const room = await hostRoom(host, 'Setup Phone Room');
  await mockElric(host.page, room.id, { eligible: false, eligibility_reason: 'unverified' });
  const { page } = host;
  await page.goto(`/rooms/${room.id}`);
  const toggle = page.locator('.rm-room-head').getByRole('switch', { name: 'Elric' });
  await toggle.click();
  const popover = page.getByRole('dialog', { name: 'Link Google to use Elric' });
  await expect(popover).toBeVisible();
  const box = (await popover.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(16 - 0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(390 - 16 + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
