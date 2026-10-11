import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/*
 * The Elric dashboard inside the workspace preview (?workspace=v2), on the fake-Google e2e
 * server with Elric on the mock model (e2e/google-server.ts). The dashboard is embedded beside
 * the workspace navigation: its chat list never covers the navigation, the window never
 * scrolls, and on phones the Chats button stays reachable under the workspace top bar. A first
 * visit without Elric asks for no chat (no 404 in the console). Synthetic data only.
 */
const port = Number(process.env.E2E_GOOGLE_PORT);
const fakePort = Number(process.env.E2E_GOOGLE_FAKE_PORT);
const base = `http://127.0.0.1:${port}`;
const headers = { 'x-city-request': '1' };

async function register(page: Page) {
  const created = await page.request.post(`${base}/api/auth/register`, {
    headers,
    data: {
      name: `Embedded ${randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(created.status()).toBe(201);
}

async function ownerWithElric(page: Page) {
  const subject = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:${fakePort}/authorize${new URL(route.request().url()).search}&e2e_subject=${subject}`,
      },
    }),
  );
  await register(page);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Google account linked.' }),
  ).toBeVisible();
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  const added = await page.request.post(`${base}/api/elric`, { headers, data: {} });
  expect(added.status(), await added.text()).toBeLessThan(300);
}

/** Whether the element on top at the centre of the first `selector` match is it (or inside it). */
async function onTop(page: Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return Boolean(hit && element.contains(hit));
    });
}

test('a first visit without Elric asks for no chat', async ({ page }) => {
  const missing: string[] = [];
  page.on('response', (response) => {
    if (response.status() === 404 && new URL(response.url()).pathname.startsWith('/api/elric'))
      missing.push(response.url());
  });
  await register(page);
  await page.goto(`${base}/elric`);
  await expect(page.getByRole('heading', { name: 'Meet Elric' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Link Google' })).toBeVisible();
  expect(missing).toEqual([]);
});

test('embedded in the workspace preview, the chat list sits beside the navigation', async ({
  page,
}) => {
  await ownerWithElric(page);
  await page.goto(`${base}/elric?workspace=v2`);
  const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
  await expect(nav.getByRole('button', { name: 'Elric', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // The chats column, and New chat in Elric's own top bar.
  await expect(page.getByRole('navigation', { name: 'Chats', exact: true })).toBeVisible();
  await expect(page.locator('.elx-header').getByRole('button', { name: 'New chat' })).toBeVisible();
  // The workspace navigation is not covered, and the chat list starts where it ends.
  expect(await onTop(page, '.wv2-navigation nav[aria-label="Workspace"] .nav-item')).toBe(true);
  const sidebar = (await page.locator('aside.sidebar').boundingBox())!;
  const list = (await page.locator('.elx-side').boundingBox())!;
  expect(list.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width - 1);
  // Elric's own header (its name opens the about sheet) is visible under the top bar.
  expect(await onTop(page, '.elx-name')).toBe(true);
  // Writing a message keeps the page itself still: only the thread scrolls.
  const box = page.getByLabel('Message Elric');
  await box.fill('Hello from the workspace');
  await box.press('Enter');
  await expect(page.locator('.elx-thread')).toContainText('Hello from the workspace');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await onTop(page, '.elx-composer textarea')).toBe(true);
});

test('on a phone, the Chats button stays reachable under the workspace top bar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ownerWithElric(page);
  await page.goto(`${base}/elric?workspace=v2`);
  const chats = page.getByRole('button', { name: 'Chats', exact: true });
  await expect(chats).toBeVisible();
  expect(await onTop(page, '.elx-side-toggle')).toBe(true);
  await chats.click();
  await expect(page.locator('.elx-side .elx3-side-note').first()).toBeVisible();
  // The drawer slides in (200 ms): hit-test once it has arrived, not mid-slide.
  await expect(page.getByRole('navigation', { name: 'Chats', exact: true })).toHaveCSS(
    'transform',
    'none',
  );
  expect(await onTop(page, '.elx-side .elx3-side-note')).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
