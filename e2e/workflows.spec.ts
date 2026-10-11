import { test, expect } from '@playwright/test';

/*
 * Workflows (/workflows): the minimal public page. The page loads with its title and heading,
 * the four-step flow with an example on each step, the real room templates (Blank left out), the
 * principles and the closing link; nothing scrolls sideways at 360, 390 or 1440 px, light or dark.
 */

test('workflows: heading, flow, room templates, principles and links', async ({ page }) => {
  await page.goto('/workflows');

  await expect(page).toHaveTitle('Workflows · Central City');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'One source. Two agents. Your decision.',
  );

  const hero = page.locator('.wf-hero');
  await expect(hero.getByRole('link', { name: 'Open a room' })).toHaveAttribute('href', '/rooms');
  await expect(hero.getByRole('link', { name: 'Read the docs' })).toHaveAttribute('href', '/docs');

  const steps = page.locator('.wf-step');
  await expect(steps.locator('h3')).toHaveText([
    'Add your source',
    'Review the brief',
    'Check against source',
    'Accept result',
  ]);
  await expect(steps.locator('.wf-example figcaption')).toHaveText(Array(4).fill('Example'));

  const templates = page.locator('.wf-template');
  await expect(templates.locator('h3')).toHaveText([
    'Product team',
    'Research squad',
    'Writing room',
    'Code review crew',
  ]);
  await expect(templates.first().locator('.wf-template-members')).toHaveText(
    'Invite a coding AI, a reviewer AI and a person',
  );

  await expect(page.getByRole('heading', { name: 'How it stays safe' })).toBeVisible();
  await expect(page.locator('.wf-principles li')).toHaveCount(4);

  const cta = page.locator('.wf-cta');
  await expect(cta.getByRole('heading', { name: 'Start a workflow' })).toBeVisible();
  await expect(cta.getByRole('link', { name: 'Open a room' })).toHaveAttribute('href', '/rooms');
});

test('workflows: not in the header menus or the footer; the page still loads', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const response = await page.goto('/workflows');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const header = page.getByRole('banner');
  const nav = header.getByRole('navigation', { name: 'Public' });
  const active = page.locator('.cc-mega-content[data-active="true"]');

  for (const group of ['Product', 'Developers']) {
    await nav.getByRole('button', { name: group, exact: true }).click();
    await expect(active.getByRole('link').first()).toBeVisible();
    await expect(active.getByRole('link', { name: 'Workflows', exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole('contentinfo').locator('a[href="/workflows"]')).toHaveCount(0);

  // The phone menu: not under Developers either.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/workflows');
  await header.getByRole('button', { name: 'Open menu' }).click();
  const menu = header.getByRole('navigation', { name: 'Menu' });
  await menu.getByRole('button', { name: 'Developers', exact: true }).click();
  await expect(menu.getByRole('link', { name: 'Docs', exact: true })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Workflows', exact: true })).toHaveCount(0);
});

for (const width of [360, 390, 1440]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`workflows: no horizontal scroll at ${width} px in ${scheme} mode`, async ({ page }) => {
      await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/workflows');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      const fits = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      );
      expect(fits).toBe(true);
      for (const item of await page.locator('.wf-example, .wf-template').all()) {
        const box = await item.boundingBox();
        if (box) expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      if (process.env.WORKFLOWS_SHOTS)
        await page.screenshot({
          path: `${process.env.WORKFLOWS_SHOTS}/workflows-${width}-${scheme}.png`,
          fullPage: true,
        });
    });
  }
}
