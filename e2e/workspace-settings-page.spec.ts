import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const headers = { 'X-City-Request': '1' };

async function register(page: Page) {
  const response = await page.request.post('/api/auth/register', {
    headers,
    data: {
      name: `Settings-page-${randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(response.status()).toBe(201);
}

/*
 * Settings (the account page) inside the workspace preview: the page fits below the title bar
 * without scrolling the window, and the Settings card does not touch the title bar. The
 * Settings v2 layout (.stv2-page scrolls inside the page area) keeps this true.
 */
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 360, height: 740 },
]) {
  test(`Settings in the workspace preview fits the window at ${viewport.width} px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await register(page);
    await page.goto('/settings/account?workspace=v2');
    const card = page.getByRole('region', { name: 'Account' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Google account');
    const layout = await page.evaluate(() => {
      const bar = document.querySelector('.cc-app-header');
      const settings = document.querySelector('.stv2')!;
      return {
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
        barBottom: bar!.getBoundingClientRect().bottom,
        cardTop: settings.getBoundingClientRect().top,
      };
    });
    expect(layout.scrollHeight).toBeLessThanOrEqual(layout.innerHeight);
    expect(layout.cardTop - layout.barBottom).toBeGreaterThanOrEqual(16);
  });
}
