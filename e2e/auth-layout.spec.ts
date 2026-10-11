import { test, expect, type Page } from '@playwright/test';

/*
 * Layout requirement: the product statement beside (or, on a phone, below) the sign-in card
 * stays at exactly the same position in Sign in and Sign up. Both modes keep the same card
 * height (src/Auth.tsx, .auth-v8-swap and .is-ghost in src/auth.css).
 */

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 700 },
  { width: 360, height: 780 },
];

async function box(page: Page, selector: string) {
  return (await page.locator(selector).boundingBox())!;
}

for (const scheme of ['light', 'dark'] as const)
  for (const size of SIZES)
    test(`${scheme} ${size.width}px: the form does not move between sign in and sign up`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(size);
      await page.goto('/#signin');
      const tabs = page.getByRole('tablist', { name: 'Account' });
      await tabs.getByRole('tab', { name: 'Sign in' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Welcome back.' })).toBeVisible();
      const signIn = await box(page, '.auth-v8-card');
      const signInCard = await box(page, '.auth-v8-card');

      await tabs.getByRole('tab', { name: 'Sign up' }).click();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Create your account.' }),
      ).toBeVisible();
      const signUp = await box(page, '.auth-v8-card');
      expect(signUp.y).toBe(signIn.y);
      expect(signUp.x).toBe(signIn.x);
      expect((await box(page, '.auth-v8-card')).height).toBe(signInCard.height);

      // The hidden texts of the other mode are not announced and cannot be focused.
      await expect(page.getByText('Sign in to see your rooms and agents.')).toBeHidden();
      await tabs.getByRole('tab', { name: 'Sign in' }).click();
      await expect(page.getByText('By creating an account', { exact: false })).toBeHidden();
      await expect(
        page.locator('.auth-v8-card').getByRole('link', { name: 'Terms of Service' }),
      ).toHaveCount(0);
      expect((await box(page, '.auth-v8-card')).y).toBe(signIn.y);
    });
