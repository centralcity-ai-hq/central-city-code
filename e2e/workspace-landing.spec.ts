import { test, expect } from '@playwright/test';

test('workspace preview lands in Rooms and preserves explicit console and room entries', async ({
  page,
}) => {
  const registered = await page.request.post('/api/auth/register', {
    headers: { 'x-city-request': '1' },
    data: {
      name: `landing-${crypto.randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(registered.status()).toBe(201);
  await page.goto('/?workspace=v2');
  await expect(page).toHaveURL(/\/rooms$/);
  await page.reload();
  await expect(page).toHaveURL(/\/rooms$/);
  // An old ?workspace=v1 link no longer opts out: it lands in Rooms too.
  await page.goto('/?workspace=v1');
  await expect(page).toHaveURL(/\/rooms$/);
  await page.goto('/?workspace=v2#connect');
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page).not.toHaveURL(/\/rooms$/);
  await page.goto('/?next=%2Fr%2Ftest-room');
  await expect(page).toHaveURL(/\/r\/test-room$/);
  await page.goto('/settings/account');
  await expect(page).toHaveURL(/\/settings\/account$/);
});

test('preview does not redirect a signed-out visitor', async ({ page }) => {
  await page.goto('/?workspace=v2');
  await expect(page.locator('#hero-invite')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('preview workspace navigation returns to the console instead of repeating default landing', async ({
  page,
}) => {
  const registered = await page.request.post('/api/auth/register', {
    headers: { 'x-city-request': '1' },
    data: {
      name: `entry-${crypto.randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(registered.status()).toBe(201);
  await page.goto('/?workspace=v2');
  await expect(page).toHaveURL(/\/rooms$/);
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: 'My agents', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'My agents', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('consumed console fragments do not redirect on subsequent history events', async ({
  page,
}) => {
  const registered = await page.request.post('/api/auth/register', {
    headers: { 'x-city-request': '1' },
    data: {
      name: `hash-${crypto.randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(registered.status()).toBe(201);
  await page.goto('/?workspace=v2#connect');
  await expect(page.getByRole('heading', { name: 'Connect AI', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  await expect(page.getByRole('heading', { name: 'Connect AI', exact: true })).toBeVisible();
  const token = `ccclaim_${'a'.repeat(43)}`;
  await page.goto(`/?workspace=v2#claim=${token}`);
  await expect(page.getByLabel('Claim agents your AI created')).toHaveValue(token);
  await expect(page).toHaveURL(/\/$/);
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  await expect(page.getByRole('heading', { name: 'My agents', exact: true })).toBeVisible();
});
