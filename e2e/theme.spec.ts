import { test, expect, type Page } from '@playwright/test';

/*
 * Theme: with no choice stored ("System") the site follows the device's light/dark setting,
 * before the first paint and live when the setting changes. A choice from the theme toggle is
 * remembered (localStorage 'cc-theme') across reloads and wins over the device setting. A URL
 * query parameter (?theme=dark|light) applies to that page view only and is never stored.
 */

const LIGHT_BODY = 'rgb(255, 255, 255)';
const DARK_BODY = 'rgb(9, 9, 11)';

const bodyBackground = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

async function toggle(page: Page, name: 'Use dark theme' | 'Use light theme', width: number) {
  // Under 900 px the theme toggle lives in the header menu.
  if (width < 900) await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name }).click();
}

for (const width of [1440, 375]) {
  test.describe(`at ${width} px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: width < 900 ? 812 : 900 });
      await page.emulateMedia({ colorScheme: 'light' });
    });

    test('with no stored choice a dark device renders dark, and follows live changes', async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(await bodyBackground(page)).toBe(DARK_BODY);
      expect(await page.evaluate(() => localStorage.getItem('cc-theme'))).toBeNull();
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0c1426');
      await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute('content', 'dark');

      // The device switches to light while the page is open.
      await page.emulateMedia({ colorScheme: 'light' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect.poll(() => bodyBackground(page)).toBe(LIGHT_BODY);
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#ffffff');
      expect(await page.evaluate(() => localStorage.getItem('cc-theme'))).toBeNull();
    });

    test('the theme is right before the app runs (no flash on the prerendered page)', async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      // Block the app's module scripts: only the boot script in <head> sets the theme.
      await page.route(/\/assets\/.*\.js$/, (route) =>
        route.request().url().includes('theme-boot') ? route.continue() : route.abort(),
      );
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    });

    test('a stored light choice stays light on a dark device', async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('cc-theme', 'light'));
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      expect(await bodyBackground(page)).toBe(LIGHT_BODY);
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#ffffff');

      // A live device change does not override the choice.
      await page.emulateMedia({ colorScheme: 'light' });
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    });

    test('the toggle switches to dark and the choice survives a reload', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await toggle(page, 'Use dark theme', width);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect.poll(() => bodyBackground(page)).toBe(DARK_BODY);
      expect(await page.evaluate(() => localStorage.getItem('cc-theme'))).toBe('dark');

      await page.reload();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(await bodyBackground(page)).toBe(DARK_BODY);

      // And back to light, also remembered.
      await toggle(page, 'Use light theme', width);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await page.reload();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      expect(await bodyBackground(page)).toBe(LIGHT_BODY);
    });

    test('?theme=dark applies to the view but does not change the saved choice', async ({
      page,
    }) => {
      await page.goto('/?theme=dark');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(await bodyBackground(page)).toBe(DARK_BODY);
      expect(await page.evaluate(() => localStorage.getItem('cc-theme'))).toBeNull();

      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      expect(await bodyBackground(page)).toBe(LIGHT_BODY);
      expect(await page.evaluate(() => localStorage.getItem('cc-theme'))).toBeNull();

      await toggle(page, 'Use dark theme', width);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect.poll(() => bodyBackground(page)).toBe(DARK_BODY);
      expect(await page.evaluate(() => localStorage.getItem('cc-theme'))).toBe('dark');

      await page.reload();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(await bodyBackground(page)).toBe(DARK_BODY);
    });

    if (width === 375) {
      test('a theme toggle mounted after navigation preserves active dark theme state', async ({
        page,
      }) => {
        await page.goto('/?theme=dark');
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

        await page.evaluate(() => history.replaceState(null, '', '/'));

        await page.getByRole('button', { name: 'Open menu' }).click();
        const toggleBtn = page.getByRole('button', { name: 'Use light theme' });
        await expect(toggleBtn).toBeVisible();
      });
    }
  });
}
