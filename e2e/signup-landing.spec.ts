import { test, expect as baseExpect, type Browser, type Page } from '@playwright/test';

/*
 * Where a new account lands: the console Overview, not a chat room, unless
 * it came with a purpose (an explicit room in `next`, /invite, a pending join or #claim=). Plain
 * sign-ins of existing accounts keep landing on Rooms.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'X-City-Request': '1' };
// The Overview's heading in the workspace.
const OVERVIEW = 'Network map';

const uniqueName = (label: string) => `${label}-${crypto.randomUUID().slice(0, 6)}`;

async function fillAndCreate(page: Page, name: string) {
  const createOne = page.getByRole('button', { name: 'Create an account', exact: true });
  const createAccount = page.getByRole('button', { name: 'Create account', exact: true });
  await expect(createOne.or(createAccount)).toBeVisible();
  if (await createOne.isVisible()) await createOne.click();
  await page.getByLabel('Account name').fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await createAccount.click();
  await expect(createAccount).toHaveCount(0);
}

/** A host with a room and a fresh room link, set up over the API. */
async function hostRoom(browser: Browser) {
  const context = await browser.newContext();
  const request = context.request;
  const registered = await request.post('/api/auth/register', {
    headers,
    data: { name: uniqueName('Host'), password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  const agent = await request.post('/api/agents', {
    headers,
    data: { name: 'Host agent', capability: 'research', mode: 'hosted' },
  });
  expect(agent.status()).toBe(201);
  const created = await request.post('/api/rooms', {
    headers,
    data: {
      agent_id: (await agent.json()).agent.id,
      name: 'Launch plan',
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const room = (await created.json()).room as { id: string; slug: string };
  const minted = await request.post(`/api/rooms/${room.id}/link`, { headers, data: {} });
  expect(minted.status()).toBe(200);
  const token = new URL((await minted.json()).link as string).hash.slice(1);
  await context.close();
  return { ...room, token };
}

test('a new account from #create lands on the Overview, not a room', async ({ page }) => {
  await page.goto('/#create');
  await fillAndCreate(page, uniqueName('New'));
  await expect(page.getByRole('heading', { name: OVERVIEW })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).hash).toBe('');
});

test('a new account from /signin without a purpose lands on the Overview', async ({ page }) => {
  await page.goto('/signin');
  await fillAndCreate(page, uniqueName('Plain'));
  await expect(page.getByRole('heading', { name: OVERVIEW })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
});

test('a new account that came to join a room (next=/r/<code>) lands in that room', async ({
  browser,
}) => {
  const room = await hostRoom(browser);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/r/${room.slug}#${room.token}`);
  await page.getByRole('button', { name: 'Sign in to join' }).click();
  await expect(page).toHaveURL(`/signin?next=${encodeURIComponent(`/r/${room.slug}`)}`);
  await fillAndCreate(page, uniqueName('Guest'));
  await expect(page.getByRole('heading', { name: 'Join the room' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/r/${room.slug}`);
  await expect(page.getByRole('heading', { name: OVERVIEW })).toHaveCount(0);
  await context.close();
});

test('a new account with a pending join but no next still lands in that room', async ({
  browser,
}) => {
  const room = await hostRoom(browser);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/r/${room.slug}#${room.token}`);
  await expect(page.getByRole('button', { name: 'Sign in to join' })).toBeVisible();
  // Leaves the room page for the plain sign-up form; the pending join stays in this tab.
  await page.goto('/#create');
  await fillAndCreate(page, uniqueName('Pending'));
  await expect(page.getByRole('heading', { name: 'Join the room' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/r/${room.slug}`);
  await context.close();
});

test('a plain sign-in of an existing account still lands on Rooms', async ({ browser }) => {
  const context = await browser.newContext();
  const name = uniqueName('Existing');
  const registered = await context.request.post('/api/auth/register', {
    headers,
    data: { name, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  await context.clearCookies();
  const page = await context.newPage();
  await page.goto('/#signin');
  await page.getByLabel('Account name').fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await context.close();
});
