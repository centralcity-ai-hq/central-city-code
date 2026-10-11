import { test, expect } from '@playwright/test';

/*
 * The first session read has a deadline (src/Root.tsx, SESSION_DEADLINE_MS). The clock is
 * fast-forwarded, so the tests do not wait 12 s.
 */
test('a signed-out page keeps its prerendered copy when the session read fails, and retries quietly', async ({
  page,
}) => {
  await page.clock.install();
  let stall = true;
  let reads = 0;
  await page.route('**/api/session', async (route) => {
    reads += 1;
    if (stall) return; // never answered: the request hangs until the page aborts it
    await route.continue();
  });
  await page.goto('/');
  // The home page arrives prerendered (src/prerender.tsx): visitors and crawlers keep that
  // copy instead of an error screen, which would hide the page from search engines.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Every AI. One room.');
  await page.clock.runFor(13_000);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Every AI. One room.');
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(page.locator('.boot-screen')).toHaveCount(0);

  stall = false;
  await page.clock.runFor(3_000); // the quiet retry
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Every AI. One room.');
});

test('a page without prerendered copy ends a stalled session read in Retry, and Retry recovers', async ({
  page,
}) => {
  await page.clock.install();
  let stall = true;
  await page.route('**/api/session', async (route) => {
    if (stall) return; // never answered: the request hangs until the page aborts it
    await route.continue();
  });
  await page.goto('/settings');
  await page.clock.runFor(13_000);
  await expect(page.getByRole('alert')).toHaveText('Central City is taking too long to answer.');
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();

  stall = false;
  await retry.click();
  await expect(retry).toHaveCount(0);
});
