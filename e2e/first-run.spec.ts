import { test, expect, type Page } from '@playwright/test';

/*
 * The first run (REDESIGN §3 and §7 P2; DESIGN_SYSTEM §3.2), from the first-run audit of 28 Sep:
 * Invite your AI → sign in → the person's room with its invite link, and the AI's first message.
 * Steps are counted as the person's own actions (clicks and form submits).
 */
const PASSWORD = 'Local-test-only-passphrase-2026';

async function fillSignUp(page: Page, name: string) {
  const createOne = page.getByRole('button', { name: 'Create an account', exact: true });
  const createWorkspace = page.getByRole('button', { name: 'Create account', exact: true });
  await expect(createOne.or(createWorkspace)).toBeVisible();
  if (await createOne.isVisible()) await createOne.click();
  await page.getByLabel(/^(Account|Operator) name$/).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await createWorkspace.click();
}

test('signed out: Invite your AI → /connect → /invite → sign in → my room with its link, and the first message', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // A second installation account first, so this run is not the setup run.
  await page.request.post('/api/auth/register', {
    headers: { 'x-city-request': '1' },
    data: { name: `fr-owner-${crypto.randomUUID().slice(0, 6)}`, password: PASSWORD },
  });
  await context.clearCookies();

  await page.goto('/');
  const started = Date.now();
  // Step 1: Invite your AI opens the Connect page (connect your AI app first), whose own
  // Invite your AI leads to the invite step.
  await page.locator('#hero-invite').click();
  await expect(page).toHaveURL(/\/connect$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Connect your AI' })).toBeVisible();
  await page.locator('main').getByRole('link', { name: 'Invite your AI' }).click();
  await expect(page).toHaveURL(/\/invite$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Invite your AI' })).toBeVisible();
  await expect(page.getByText('Sign in, copy one link, and paste it into your AI.')).toBeVisible();
  // One primary action; the no-account path is a quiet link to the Connect page.
  await expect(page.locator('main .button.primary')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Try without an account' })).toHaveAttribute(
    'href',
    '/#connect',
  );
  // Step 2: Sign in to get your link (the sign-in page remembers where to return).
  await page.getByRole('link', { name: 'Sign in to get your link' }).click();
  await expect(page).toHaveURL(/\/signin\?next=%2Finvite$/);
  // Step 3: create the account.
  await fillSignUp(page, `fr-${crypto.randomUUID().slice(0, 8)}`);
  // The room is prepared: "My first room", hosted by the person's agent.
  await expect(page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'My first room' })).toBeVisible();
  // Step 4: the room opens with its Invite sheet: copy the link.
  const sheet = page.getByRole('dialog', { name: 'Invite a person' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Copy invite link' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/\/j\/[A-Za-z0-9_-]+$/);
  const link = copied.slice(copied.lastIndexOf(' ') + 1);
  const toLink = Date.now() - started;

  // The AI arrives: another account joins with the link and posts; the host sees it live.
  const roomId = page.url().split('/rooms/')[1]!;
  const ai = await context.browser()!.newContext();
  const headers = { 'x-city-request': '1' };
  const aiPage = await ai.newPage();
  expect(
    (
      await aiPage.request.post('/api/auth/register', {
        headers,
        data: { name: `fr-ai-${crypto.randomUUID().slice(0, 6)}`, password: PASSWORD },
      })
    ).status(),
  ).toBe(201);
  const invited = Date.now();
  expect(
    (
      await aiPage.request.post(`/api/rooms/${roomId}/join`, {
        headers,
        data: { link, create: { name: 'Guest AI' }, idempotency_key: crypto.randomUUID() },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await aiPage.request.post(`/api/rooms/${roomId}/messages`, {
        headers,
        data: { text: 'Hello, I joined.', idempotency_key: crypto.randomUUID() },
      })
    ).ok(),
  ).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Hello, I joined.')).toBeVisible({ timeout: 15_000 });
  const firstMessage = Date.now() - invited;
  // Someone else is in the room now: the "Who should join?" card steps aside.
  await expect(page.getByRole('region', { name: 'Who should join?' })).toHaveCount(0);
  await ai.close();
  test.info().annotations.push(
    {
      type: 'steps to link',
      description: '4 (Invite your AI, Sign in to get your link, Create, Copy)',
    },
    { type: 'time to link (automated)', description: `${toLink} ms` },
    { type: 'time to first message after the AI posts', description: `${firstMessage} ms` },
  );
  expect(firstMessage).toBeLessThan(15_000);
  expect(errors).toEqual([]);
});

test('signed in: /invite asks before creating a first room, then opens it for inviting', async ({
  page,
}) => {
  const headers = { 'x-city-request': '1' };
  expect(
    (
      await page.request.post('/api/auth/register', {
        headers,
        data: { name: `fr-in-${crypto.randomUUID().slice(0, 6)}`, password: PASSWORD },
      })
    ).status(),
  ).toBe(201);
  // A link to /invite (from any site) never creates anything by itself.
  await page.goto('/invite');
  const create = page.getByRole('button', { name: 'Create my first room' });
  await expect(create).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  expect((await (await page.request.get('/api/rooms')).json()).rooms).toEqual([]);
  expect((await (await page.request.get('/api/snapshot')).json()).agents).toEqual([]);
  // One click creates it and opens it with its Invite sheet.
  await create.click();
  await expect(page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'My first room' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Invite a person' })).toBeVisible();
  // With a room, /rooms#invite opens it again directly: no second room.
  const first = page.url();
  await page.goto('/rooms#invite');
  await expect(page).toHaveURL(first);
  expect((await (await page.request.get('/api/rooms')).json()).rooms).toHaveLength(1);
});

test('at 360 px the room list is reachable without an open room (no dead end)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const headers = { 'x-city-request': '1' };
  expect(
    (
      await page.request.post('/api/auth/register', {
        headers,
        data: { name: `fr-m-${crypto.randomUUID().slice(0, 6)}`, password: PASSWORD },
      })
    ).status(),
  ).toBe(201);
  await page.goto('/rooms');
  // No rooms yet: /rooms is the overview with its empty state, never a dead end.
  await expect(page.getByRole('heading', { level: 1, name: 'Your rooms' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No rooms yet' })).toBeVisible();
  // On a phone the room list page itself offers New room and Join a room.
  const overview = page.getByRole('region', { name: 'Your rooms' });
  await expect(overview.getByRole('button', { name: 'New room' })).toBeInViewport();
  await expect(overview.getByRole('button', { name: 'Join a room' })).toBeInViewport();
  // The workspace shell owns the only menu button; its drawer leads to Rooms from anywhere.
  await expect(page.getByRole('button', { name: 'Open menu' })).toHaveCount(0);
  const open = page.getByRole('button', { name: 'Open navigation', exact: true });
  await expect(open).toBeVisible();
  await open.click();
  const workspace = page.getByRole('navigation', { name: 'Workspace' });
  const roomsEntry = workspace.getByRole('button', { name: 'Rooms', exact: true });
  await expect(roomsEntry).toBeInViewport();
  await expect(roomsEntry).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(workspace).not.toBeInViewport();
  await expect(open).toBeFocused();
  // Desktop shows the workspace navigation with the room list under Rooms: no drawer button.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/rooms');
  await expect(page.getByRole('heading', { level: 1, name: 'Your rooms' })).toBeVisible();
  const drawer = page.getByRole('navigation', { name: 'Rooms' });
  await expect(drawer).toBeInViewport();
  await expect(roomsEntry).toBeVisible();
  await expect(roomsEntry).toHaveAttribute('aria-current', 'page');
  await expect(drawer.getByRole('button', { name: 'New room' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Join a room' })).toBeVisible();
});
