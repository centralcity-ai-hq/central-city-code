import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

/*
 * The Analytics page's chain switch (All | Base | Arc): shown only while the API answers with
 * `chains` (Arc on, CITY_ARC=1); All is the default and sends no chain, Base and Arc send
 * `chain=base|arc`. Arc off (no `chains`), the switch is not there. The API is mocked with the
 * answer shape of the dashboard tests (tests/fixtures/dashboard-arc-off-golden.json).
 */
const golden = JSON.parse(
  readFileSync(new URL('../tests/fixtures/dashboard-arc-off-golden.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const sample = JSON.parse(golden['/?range=24h']!) as Record<string, unknown> & {
  kpis: Record<string, unknown>;
};

async function mock(page: Page, arcOn: boolean) {
  const asked: string[] = [];
  await page.route('**/api/public/dashboard?*', (route) => {
    const url = new URL(route.request().url());
    const chain = url.searchParams.get('chain') ?? 'all';
    asked.push(chain);
    const calls = chain === 'arc' ? 2 : chain === 'base' ? 5 : 7;
    const body = {
      ...sample,
      range: url.searchParams.get('range'),
      kpis: { ...sample.kpis, calls },
      ...(arcOn ? { chains: ['base', 'arc'] } : {}),
    };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  return asked;
}

test('analytics: the chain switch opens on All and narrows to Base or Arc', async ({ page }) => {
  const asked = await mock(page, true);
  await page.goto('/analytics');
  const chain = page.getByRole('group', { name: 'Chain' });
  await expect(chain).toBeVisible();
  await expect(chain.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.ccd-kpis').getByText('Active agents', { exact: true })).toBeVisible();
  await chain.getByRole('button', { name: 'Arc' }).click();
  await expect(chain.getByRole('button', { name: 'Arc' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => asked.includes('arc')).toBe(true);
  await expect(
    page.locator('.ccd-kpis').getByText('Active Arc agents', { exact: true }),
  ).toBeVisible();
  await chain.getByRole('button', { name: 'Base' }).click();
  await expect.poll(() => asked.includes('base')).toBe(true);
  // The time switch stays next to it and still works.
  await page
    .getByRole('group', { name: 'Time window' })
    .getByRole('button', { name: '7 d' })
    .click();
  await expect(chain.getByRole('button', { name: 'Base' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('analytics: Arc off, no chain switch and no chain in any request', async ({ page }) => {
  const asked = await mock(page, false);
  await page.goto('/analytics');
  await expect(page.getByRole('group', { name: 'Time window' })).toBeVisible();
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  await expect(page.getByRole('group', { name: 'Chain' })).toHaveCount(0);
  await expect(
    page.locator('.ccd-kpis').getByText('Active Base agents', { exact: true }),
  ).toBeVisible();
  expect(asked.every((c) => c === 'all')).toBe(true);
});

test('analytics: the chain switch fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mock(page, true);
  await page.goto('/analytics');
  await expect(page.getByRole('group', { name: 'Chain' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
