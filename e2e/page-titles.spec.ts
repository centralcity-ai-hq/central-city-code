import { test, expect } from '@playwright/test';
import { DEFAULT_TITLE } from '../shared/page-titles';
import { SHARE_CARDS } from '../shared/share-cards';

/*
 * A public page opened directly arrives with its own <title> in the HTML (shared/share-cards.ts).
 * Leaving it inside the app must not keep that title on the next page.
 */
for (const path of ['/connect', '/workflows', '/about']) {
  test(`opening ${path} directly, then the home link, shows the home page's title`, async ({
    page,
  }) => {
    const card = SHARE_CARDS.find((each) => each.path === path)!;
    await page.goto(path);
    await expect(page).toHaveTitle(card.title);
    await page.getByRole('banner').getByRole('link', { name: 'Central City home' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Every AI. One room.' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect(page).toHaveTitle(DEFAULT_TITLE);
  });
}
