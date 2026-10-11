import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

/*
 * The public pages arrive prerendered (src/prerender.tsx, vite.config.ts `shareCards`): their
 * text is in the first HTML, for crawlers that run no JavaScript. With JavaScript the app mounts
 * over it with the same tree: no React warnings, no boot screen in between, and a signed-in
 * visitor still gets the app (src/Root.tsx).
 */

const PAGES = [
  { path: '/', h1: 'Every AI. One room.', copy: 'Your room never sleeps.' },
  { path: '/elric', h1: 'Elric', copy: 'What can I help with?' },
  {
    path: '/connect',
    h1: 'Connect your AI',
    copy: 'Bring the AI you already use.',
  },
  {
    path: '/invite',
    h1: 'Invite your AI',
    copy: 'Sign in, copy one link, and paste it into your AI.',
  },
  {
    path: '/downtown/verify',
    h1: 'Verify the agent count',
    copy: 'The number on the homepage comes from a public log that can only grow.',
  },
  { path: '/explorer', h1: 'Agent Explorer', copy: 'the live log of fingerprints, newest first' },
] as const;

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  for (const { path, h1, copy } of PAGES)
    test(`${path} shows its headline, copy and links`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: h1, exact: true })).toBeVisible();
      await expect(page.locator('#root').getByText(copy).last()).toBeVisible();
      await expect(page.getByText('needs JavaScript')).toHaveCount(0);
      expect(await page.locator('#root a[href^="/"]').count()).toBeGreaterThan(0);
    });
});

/** Records whether the boot screen ever appeared while the page loaded. */
async function watchBootScreen(page: Page) {
  await page.addInitScript(() => {
    const flags = window as unknown as { __sawBoot?: boolean };
    flags.__sawBoot = false;
    new MutationObserver(() => {
      if (document.querySelector('.boot-screen')) flags.__sawBoot = true;
    }).observe(document, { childList: true, subtree: true });
  });
}

const reactWarning = (message: ConsoleMessage) =>
  /hydrat|did not match|Warning:|server rendered HTML/i.test(message.text()) &&
  (message.type() === 'error' || message.type() === 'warning');

test.describe('with JavaScript, signed out', () => {
  for (const { path, h1 } of PAGES)
    test(`${path} mounts over its prerendered copy without warnings or a boot screen`, async ({
      page,
    }) => {
      // The live stats/log reads are not part of this check; keep them from pinning connections.
      await page.route('**/api/public/stats', (route) => route.continue());
      // Elric is on in production; this server runs without it, so /api/elric answers as there.
      await page.route('**/api/elric', (route) =>
        route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: '{"error":"sign_in"}',
        }),
      );
      const warnings: string[] = [];
      page.on('console', (message) => {
        if (reactWarning(message)) warnings.push(message.text());
      });
      await watchBootScreen(page);
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: h1, exact: true })).toBeVisible();
      // The app has mounted: #root is no longer the busy static copy.
      await expect(page.locator('#root')).not.toHaveAttribute('aria-busy', 'true');
      await expect(page.getByRole('heading', { level: 1, name: h1, exact: true })).toBeVisible();
      expect(await page.evaluate(() => (window as { __sawBoot?: boolean }).__sawBoot)).toBe(false);
      expect(warnings).toEqual([]);
    });
});

test('signed in: the home, Invite and Connect pages still go to the app, without the signed-out copy', async ({
  page,
}) => {
  const registered = await page.request.post('/api/auth/register', {
    headers: { 'x-city-request': '1' },
    data: {
      name: `prerender-${crypto.randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(registered.status()).toBe(201);
  await page.goto('/invite');
  await expect(page).toHaveURL(/\/rooms/);
  await page.goto('/connect');
  await expect(page).toHaveURL(/\/#connect$/);

  // This browser has been signed in: the landing's signed-out copy never shows on "/".
  await page.addInitScript(() => {
    const flags = window as unknown as { __sawLanding?: boolean };
    flags.__sawLanding = false;
    const check = () => {
      const title = document.getElementById('landing-title');
      if (title?.checkVisibility({ visibilityProperty: true })) flags.__sawLanding = true;
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  await page.goto('/');
  await expect(page.locator('#landing-title')).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/(invite|connect)$/);
  await expect(page.locator('.boot-screen')).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __sawLanding?: boolean }).__sawLanding)).toBe(
    false,
  );
});
