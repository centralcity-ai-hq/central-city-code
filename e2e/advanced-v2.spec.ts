import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { workspaceTarget } from './workspace-density';
import { openAdvancedGroup } from './settings-nav';

/*
 * Workspace v2 Advanced views (?workspace=v2): Research & review, Agent permissions and Network
 * map in the Rooms v2 look. Each page is titled with its menu label, keeps its data and actions,
 * shows loading, empty and error states to assistive technology, keeps 44 px targets and fits
 * phones in light and dark. Screenshots go to the test output, or to ADV2_SHOTS when set (local
 * review only, never committed).
 */

const headers = { 'X-City-Request': '1' };
const PAGES = [
  { label: 'Research & review', view: 'collaborations' },
  { label: 'Agent permissions', view: 'connections' },
  { label: 'Network map', view: 'network' },
] as const;

async function register(page: Page, demo: boolean) {
  const response = await page.request.post('/api/auth/register', {
    headers,
    data: {
      name: `Advanced-v2-${randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(response.status()).toBe(201);
  if (demo) {
    const started = await page.request.post('/api/demo/start', { headers, data: {} });
    expect(started.ok()).toBe(true);
    // The example agents come online on the server's next worker tick (up to a second later);
    // until then a new collaboration is refused with "All three agents must be reachable."
    await expect
      .poll(async () => (await (await page.request.get('/api/snapshot')).json()).stats.reachable)
      .toBe(3);
  }
}

async function open(page: Page, label: string) {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) {
    await menu.click();
    await expect(page.locator('.sidebar.open')).toBeVisible();
  }
  const advanced = await openAdvancedGroup(page);
  await advanced.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: label, exact: true })).toBeVisible();
}

async function shot(page: Page, name: string) {
  const dir = process.env.ADV2_SHOTS;
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

async function expectFits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

/** Every visible control on the page body is at least 44 px tall (at 90% on wider screens). */
async function expectTargets(page: Page) {
  const target = workspaceTarget(page.viewportSize()!.width);
  const small = await page.evaluate(
    (target) =>
      [...document.querySelectorAll<HTMLElement>('main.adv2 button, main.adv2 select')]
        .filter((element) => element.offsetParent !== null)
        .map((element) => ({
          text: element.textContent?.trim() || element.getAttribute('aria-label') || '',
          // Two decimals: a transformed node (Network map) can measure 43.99997 for 44 px.
          height: Math.round(element.getBoundingClientRect().height * 100) / 100,
        }))
        .filter((item) => item.height < target),
    target,
  );
  expect(small).toEqual([]);
}

for (const width of [1440, 390]) {
  test(`advanced pages: header, cards, targets and fit at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width > 600 ? 1000 : 844 });
    await register(page, true);
    await page.goto('/?workspace=v2#connect');
    for (const { label, view } of PAGES) {
      await open(page, label);
      const main = page.locator('main.adv2');
      await expect(main).toHaveAttribute('data-adv2-view', view);
      await expect(page).toHaveTitle(`${label} · Central City`);
      // The calm canvas: the h1 with no "Central City / …" breadcrumb label above it.
      await expect(main.locator('.page-kicker')).toHaveCount(0);
      await expect(main.getByRole('heading', { level: 1, name: label, exact: true })).toBeVisible();
      await expectFits(page);
      await expectTargets(page);
      await shot(page, `${view}-${width}-light`);
    }
    // Network map: the agent map with its real counts in the card header.
    await expect(page.getByRole('heading', { name: 'Agent map', exact: true })).toBeVisible();
    await expect(page.locator('.nm-meta')).toContainText(' agents · ');
    await expect(page.locator('.nm-online')).toContainText(' online');
    await expect(page.getByRole('group', { name: /^Agent map: 3 agents/ })).toBeVisible();
    // Agents, activity and connecting your AI live on their own pages, not on the map.
    const main = page.locator('main.adv2');
    for (const name of ['Your agents', 'Recent activity', 'Bring your AI in.'])
      await expect(main.getByRole('heading', { name, exact: true })).toHaveCount(0);
    await expect(main.getByText('Next step', { exact: true })).toHaveCount(0);
    await expect(main.locator('.activity-panel, .lower-layout, .next-step-panel')).toHaveCount(0);
    // The map takes the full content width.
    const [map, heading] = await Promise.all([
      main.locator('.nm').boundingBox(),
      main.locator('.page-heading').boundingBox(),
    ]);
    expect(Math.abs((map?.width ?? 0) - (heading?.width ?? 0))).toBeLessThanOrEqual(1);
  });
}

test('research & review: four steps, source beside brief and check, owner decides', async ({
  page,
}) => {
  await register(page, true);
  await page.goto('/?workspace=v2#connect');
  await open(page, 'Research & review');
  await page.getByRole('button', { name: 'New collaboration', exact: true }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: 'Use sample source', exact: true }).click();
  await page.getByRole('button', { name: 'Start brief', exact: true }).click();
  // The brief is drafted by the server; under a loaded CI runner that took over 15 s (#684).
  await expect(page.getByRole('button', { name: 'Send to checker', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const track = page.getByRole('list', { name: 'Collaboration progress' });
  await expect(track.locator('[aria-current="step"]')).toContainText('Review brief');
  const review = page.getByRole('region', { name: 'Collaboration review' });
  const cards = review.locator('.adv2-review-grid > .workflow-result');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('River Library');
  // Side by side at 1440 px: the three cards share one row.
  const tops = await cards.evaluateAll((items) =>
    items.map((item) => Math.round(item.getBoundingClientRect().top)),
  );
  expect(new Set(tops).size).toBe(1);
  await shot(page, 'collaborations-review-1440-light');
  await page.getByRole('button', { name: 'Send to checker', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Accept collaboration', exact: true })).toBeVisible(
    { timeout: 15_000 },
  );
  await expect(track.locator('[aria-current="step"]')).toContainText('Accept result');
  await page.getByRole('button', { name: 'Accept collaboration', exact: true }).click();
  await expect(
    page.getByText('You accepted this collaboration. Its source and both results are kept.'),
  ).toBeVisible();
  await expect(track.locator('[aria-current="step"]')).toHaveCount(0);
  await expect(track.locator('.adv2-step-done')).toHaveCount(4);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectFits(page);
  await expectTargets(page);
  await shot(page, 'collaborations-review-390-light');
});

test('advanced pages announce empty, loading and error states', async ({ page }) => {
  await register(page, false);
  await page.goto('/?workspace=v2#connect');
  await open(page, 'Network map');
  await expect(page.getByRole('status').filter({ hasText: 'No agents yet.' })).toBeVisible();
  await open(page, 'Agent permissions');
  await expect(page.getByRole('status').filter({ hasText: 'Connect two agents' })).toBeVisible();
  await open(page, 'Research & review');
  await expect(
    page.getByRole('status').filter({ hasText: 'Your first shared result' }),
  ).toBeVisible();
  await shot(page, 'collaborations-empty-1440-light');

  // Loading: the console announces it while the first snapshot is on its way.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/snapshot', async (route) => {
    await held;
    await route.fallback();
  });
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Loading your agents…' })).toBeVisible();
  await shot(page, 'collaborations-loading-1440-light');
  release();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Research & review', exact: true }),
  ).toBeVisible();
  await page.unroute('**/api/snapshot');

  // Error: a failed snapshot read is an alert.
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 503, json: { error: 'Workspace temporarily unavailable.' } }),
  );
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Workspace temporarily unavailable.');
  await shot(page, 'collaborations-error-1440-light');
});

for (const width of [360, 390]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`advanced pages fit ${width} px in ${scheme} mode`, async ({ page }) => {
      await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
      await page.setViewportSize({ width, height: 844 });
      await register(page, true);
      await page.goto('/?workspace=v2#connect');
      for (const { label, view } of PAGES) {
        await open(page, label);
        await expectFits(page);
        if (width === 390) await shot(page, `${view}-${width}-${scheme}`);
      }
    });
  }
}
