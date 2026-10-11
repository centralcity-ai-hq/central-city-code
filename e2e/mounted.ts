import { expect, type Page } from '@playwright/test';

/**
 * Opens `path` and waits until the app has mounted over the page's prerendered copy
 * (src/prerender.tsx): until then its buttons and fields are static and do nothing.
 */
export async function gotoMounted(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('#root[aria-busy], #root [data-prerendered]')).toHaveCount(0);
}
