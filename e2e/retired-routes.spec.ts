import { test, expect } from '@playwright/test';

/*
 * Retired client paths move for good (shared/routes.ts CLIENT_REDIRECTS): /how → the landing's
 * "How it works" section, /answers → the docs. Both 301 with a Location, the same in vercel.json
 * and the local server, and neither ever shows "Page not found".
 */
test('/how and /answers redirect (301) to real pages', async ({ page, request }) => {
  for (const [from, location] of [
    ['/how', '/#how'],
    ['/answers', '/docs'],
  ] as const) {
    const response = await request.get(from, { maxRedirects: 0 });
    expect(response.status(), from).toBe(301);
    expect(response.headers()['location'], from).toBe(location);
  }

  await page.goto('/how');
  const how = new URL(page.url());
  expect(`${how.pathname}${how.hash}`).toBe('/#how');
  await expect(page.locator('section#how')).toBeVisible();
  await expect(page.getByText('This page doesn’t exist.')).toHaveCount(0);

  await page.goto('/answers');
  expect(new URL(page.url()).pathname).toBe('/docs');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.getByText('This page doesn’t exist.')).toHaveCount(0);
});
