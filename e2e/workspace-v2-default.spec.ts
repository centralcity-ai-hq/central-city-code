import { test, expect, type Page } from '@playwright/test';

/*
 * Workspace v2 is the only workspace design (src/shell/workspaceV2.ts): an old ?workspace=v1 link
 * or a stored opt-out no longer switches back. The console views with their own address
 * (/settings, /settings/<section>, /agents, /messages) open directly instead of showing
 * "Page not found".
 */
const PASSWORD = 'Local-test-only-passphrase-2026';

async function register(page: Page) {
  const registered = await page.request.post('/api/auth/register', {
    headers: { 'x-city-request': '1' },
    data: { name: `default-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
}

const shell = (page: Page) => page.locator('.app-shell');
const notFound = (page: Page) =>
  page.getByRole('heading', { name: 'This page doesn’t exist.', exact: true });

test('the workspace is always v2: ?workspace=v1 and a stored opt-out do not switch back', async ({
  page,
}) => {
  await register(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/rooms$/);
  await expect(shell(page)).toHaveAttribute('data-workspace', 'v2');

  // An old ?workspace=v1 link: still v2, and the parameter leaves the address.
  await page.goto('/?workspace=v1');
  await expect(page).toHaveURL(/\/rooms$/);
  await expect(shell(page)).toHaveAttribute('data-workspace', 'v2');

  // A browser that opted out earlier: still v2, Messages included.
  await page.evaluate(() => localStorage.setItem('cc-workspace-v2', 'v1'));
  await page.reload();
  await expect(shell(page)).toHaveAttribute('data-workspace', 'v2');
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: /^Messages/ })
    .click();
  await expect(shell(page)).toHaveAttribute('data-workspace', 'v2');
});

test('/settings, its sections and /agents open their views when visited directly', async ({
  page,
}) => {
  await register(page);
  const rail = page.getByRole('navigation', { name: 'Settings sections' });
  for (const [path, section] of [
    ['/settings', 'Connected apps'],
    ['/settings/connected-apps', 'Connected apps'],
    ['/settings/data', 'Data & export'],
    ['/settings/activity', 'Activity log'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(rail.locator('[aria-current="page"]')).toHaveText(section);
    await expect(notFound(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  }
  await page.goto('/agents');
  await expect(
    page.getByRole('heading', { name: 'My agents', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/settings/unknown');
  await expect(notFound(page)).toBeVisible();
});

test('/messages opens Messages when visited directly and after a reload', async ({ page }) => {
  await register(page);
  const messages = page.getByRole('heading', { name: 'Messages', exact: true });
  const response = await page.goto('/messages');
  expect(response?.status()).toBe(200);
  await expect(messages).toBeVisible();
  await expect(notFound(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await page.reload();
  await expect(messages).toBeVisible();
  await expect(notFound(page)).toHaveCount(0);
  // Reloading the address itself opens it again.
  await page.goto('/messages');
  await expect(messages).toBeVisible();
});

test('signed out, /settings asks to sign in and then opens Settings', async ({ page }) => {
  const name = `signin-${crypto.randomUUID().slice(0, 8)}`;
  const created = await page.request.post('/api/auth/register', {
    headers: { 'x-city-request': '1' },
    data: { name, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  await page.context().clearCookies();
  await page.goto('/settings/data');
  await expect(notFound(page)).toHaveCount(0);
  await page.getByLabel('Account name').fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Settings sections' }).locator('[aria-current="page"]'),
  ).toHaveText('Data & export');
});
