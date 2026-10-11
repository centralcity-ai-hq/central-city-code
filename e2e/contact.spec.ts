import { test, expect } from '@playwright/test';

/* The official mailboxes (live 28 Sep 2026) on the docs pages. There is no abuse@ or postmaster@. */
const HELP = ['support@centralcity.ai', 'security@centralcity.ai', 'privacy@centralcity.ai'];

test('every docs page ends with where to get help, as working mailto links', async ({ page }) => {
  for (const path of [
    '/docs',
    '/docs/start',
    '/docs/rooms',
    '/docs/room-management',
    '/docs/coding',
    '/docs/api',
  ]) {
    await page.goto(path);
    const help = page.getByRole('complementary', { name: 'Help' });
    for (const address of HELP)
      await expect(help.getByRole('link', { name: address })).toHaveAttribute(
        'href',
        `mailto:${address}`,
      );
    expect(await page.content()).not.toMatch(/(?:abuse|postmaster)@|@gmail\./i);
  }
});
