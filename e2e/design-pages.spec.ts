import { test, expect } from '@playwright/test';

/*
 * Design v8 PR5: Sign in, Invite your AI and the trust pages (ops brand/design-v8). Layout only;
 * the flows and the legal text are covered by first-run, signup-landing and trust specs.
 */

const TRUST = [
  '/about',
  '/contact',
  '/support',
  '/security',
  '/status',
  '/privacy',
  '/privacy-choices',
  '/terms',
  '/acceptable-use',
  '/dpa',
  '/imprint',
];

test('sign in: product statement beside the card; the tabs switch between sign in and sign up', async ({
  page,
}) => {
  await page.goto('/signin');
  await expect(page.getByText('Independent intelligence. Common ground.')).toHaveCount(0);
  const tabs = page.getByRole('tablist', { name: 'Account' });
  // A brand-new installation opens on sign up; start from sign in.
  await tabs.getByRole('tab', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome back.' })).toBeVisible();
  await expect(tabs.getByRole('tab', { name: 'Sign in' })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Create your account.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Terms of Service' }).first()).toHaveAttribute(
    'href',
    '/terms',
  );
  await tabs.getByRole('tab', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome back.' })).toBeVisible();
  // Side by side on a wide screen: the product video on the left, the form on the right.
  const media = (await page.locator('.auth-v8-media').boundingBox())!;
  const card = (await page.locator('.auth-v8-card').boundingBox())!;
  expect(card.x).toBeGreaterThan(media.x + media.width - 1);
  await expect(page.locator('.auth-v8-media video')).toHaveAttribute('preload', 'none');
});

test('invite: steps card with one primary action, and the apps that work with it', async ({
  page,
}) => {
  await page.goto('/invite');
  await expect(page.getByRole('heading', { level: 1, name: 'Invite your AI' })).toBeVisible();
  await expect(page.locator('main .button.primary')).toHaveCount(1);
  await expect(page.locator('.invite-v8-steps li')).toHaveCount(3);
  await expect(page.locator('.invite-v8-app h3')).toHaveText([
    'ChatGPT',
    'Claude',
    'Cursor & VS Code',
  ]);
});

test('trust pages: v8 head with an eyebrow above the title', async ({ page }) => {
  for (const path of TRUST) {
    await page.goto(path);
    const head = page.locator('.trust-head');
    await expect(head.locator('.trust-eyebrow'), path).toBeVisible();
    await expect(head.getByRole('heading', { level: 1 }), path).toBeVisible();
  }
});

for (const scheme of ['light', 'dark'] as const)
  test(`${scheme}: sign in, invite and the trust pages fit 360 px`, async ({ page }) => {
    await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
    await page.setViewportSize({ width: 360, height: 780 });
    for (const path of ['/signin', '/invite', ...TRUST]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first(), path).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${scheme} ${path}`,
      ).toBe(true);
    }
    // On a phone only the form shows; the video steps aside.
    await page.goto('/signin');
    await expect(page.locator('.auth-v8-card')).toBeVisible();
    await expect(page.locator('.auth-v8-media')).toBeHidden();
  });
