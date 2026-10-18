import { test, expect, type Page } from '@playwright/test';

/*
 * The newsletter opt-in on the password Sign up form (src/Auth.tsx, docs/EMAIL.md): unticked by
 * default; ticking it shows a required Email field without changing the card height; after
 * sign-up, Settings > Account shows the pending subscription.
 */

const PASSWORD = 'Local-test-only-passphrase-2026';
const LABEL = 'Subscribe to the Central City newsletter';
const HINT = "We'll email you a link to confirm.";

const cardHeight = async (page: Page) =>
  (await page.locator('.auth-v8-card').boundingBox())!.height;

test('the opt-in reveals a required email field and settings show the pending subscription', async ({
  page,
}) => {
  await page.goto('/#create');
  const tabs = page.getByRole('tablist', { name: 'Account' });
  await tabs.getByRole('tab', { name: 'Sign in' }).click();
  const signInHeight = await cardHeight(page);
  await tabs.getByRole('tab', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Create your account.' })).toBeVisible();

  const box = page.getByRole('checkbox', { name: LABEL });
  const email = page.getByRole('textbox', { name: 'Email' });
  await expect(box).not.toBeChecked();
  await expect(email).toBeHidden();
  expect(await cardHeight(page)).toBe(signInHeight);
  // Collapsed: no empty space is reserved for the field.
  expect((await page.locator('.auth-v8-reveal').boundingBox())!.height).toBe(0);

  // Ticked: the field appears (same card height), required, with the email keyboard and autofill.
  await box.check();
  await expect(email).toBeVisible();
  await expect(email).toHaveAttribute('type', 'email');
  await expect(email).toHaveAttribute('autocomplete', 'email');
  expect(await email.evaluate((input: HTMLInputElement) => input.required)).toBe(true);
  await expect(page.getByText(HINT)).toBeVisible();
  // Ticking (a user action) grows the card to fit the field; nothing was reserved before.
  await expect.poll(() => cardHeight(page)).toBeGreaterThan(signInHeight);
  await expect(email).not.toBeFocused();

  // Unticked: the field is gone again.
  await box.uncheck();
  await expect(email).toBeHidden();
  await expect(page.locator('.auth-v8-reveal')).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(() => cardHeight(page)).toBe(signInHeight);

  // Ticked with no address: the browser keeps the form from submitting.
  const name = `Letter-${crypto.randomUUID().slice(0, 6)}`;
  await page.getByLabel('Account name').fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await box.check();
  const create = page.getByRole('button', { name: 'Create account', exact: true });
  await create.click();
  expect(await email.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
  await expect(create).toBeVisible();

  await email.fill('letter.person@example.com');
  await expect(page.getByText(HINT)).toBeVisible();
  await create.click();
  await expect(create).toHaveCount(0);

  await page.goto('/settings/account');
  const account = page.getByRole('region', { name: 'Account', exact: true });
  await expect(account.getByRole('heading', { name: 'Newsletter' })).toBeVisible();
  await expect(account.getByTestId('newsletter-status')).toHaveText('Waiting for confirmation');
  await expect(account.getByText('letter.person@example.com')).toBeVisible();

  // Unsubscribe in one click; subscribing again asks for an address (password account).
  await account.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(account.getByTestId('newsletter-status')).toHaveText('Not subscribed');
  await expect(account.getByRole('textbox', { name: 'Email' })).toBeVisible();
});

test('without the tick, sign-up sends no address', async ({ page }) => {
  await page.goto('/#create');
  await expect(page.getByRole('heading', { level: 1, name: 'Create your account.' })).toBeVisible();
  const sent = page.waitForRequest('**/api/auth/register');
  await page.getByLabel('Account name').fill(`Plain-${crypto.randomUUID().slice(0, 6)}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  expect(Object.keys((await sent).postDataJSON()).sort()).toEqual(['name', 'password']);
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toHaveCount(0);
  await page.goto('/settings/account');
  await expect(page.getByTestId('newsletter-status')).toHaveText('Not subscribed');
});

test('the email field expands smoothly, without moving anything outside the card', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#create');
  await expect(page.getByRole('heading', { level: 1, name: 'Create your account.' })).toBeVisible();
  // Page coordinates (a Playwright click may scroll the page; that is not a layout shift).
  const pageY = (selector: string) =>
    page.evaluate(
      (target) => document.querySelector(target)!.getBoundingClientRect().y + window.scrollY,
      selector,
    );
  // The header is sticky: it must stay put in the viewport.
  const header = async () => (await page.locator('header').first().boundingBox())!;
  const cardTop = () => pageY('.auth-v8-card');
  const before = { header: await header(), top: await cardTop() };
  // The card's height at fixed points of the expand: the transitions are paused and seeked, so
  // the result does not depend on which frames a busy machine happens to render.
  // Clicked and paused in the same task, so no frame of the expand can pass before the pause.
  const heights = await page.evaluate(async () => {
    const card = document.querySelector('.auth-v8-card')!;
    (document.querySelector('.auth-v8-newsletter input[type=checkbox]') as HTMLElement).click();
    const animations = document.getAnimations();
    for (const animation of animations) animation.pause();
    const out: number[] = [];
    for (const time of [0, 20, 60, 120, 240]) {
      for (const animation of animations) animation.currentTime = time;
      await new Promise(requestAnimationFrame);
      out.push(card.getBoundingClientRect().height);
    }
    for (const animation of animations) animation.finish();
    return out;
  });
  for (let index = 1; index < heights.length; index += 1)
    expect(heights[index]!).toBeGreaterThanOrEqual(heights[index - 1]! - 0.01);
  const growth = heights.at(-1)! - heights[0]!;
  expect(growth).toBeGreaterThan(40);
  // Not one jump: part-way through the expand the card is visibly between its two heights.
  const between = heights.filter(
    (height) => height > heights[0]! + growth * 0.1 && height < heights[0]! + growth * 0.9,
  );
  expect(between.length).toBeGreaterThanOrEqual(1);
  // Six frames of the expand, 40 ms apart (the transitions paused at those times).
  await page.getByRole('checkbox', { name: LABEL }).uncheck();
  await page.waitForTimeout(400);
  await page.getByRole('checkbox', { name: LABEL }).check();
  for (let frame = 0; frame < 6; frame += 1) {
    await page.evaluate((time) => {
      for (const animation of document.getAnimations()) {
        animation.pause();
        animation.currentTime = time;
      }
    }, frame * 40);
    await page
      .locator('.auth-v8-card')
      .screenshot({ path: testInfo.outputPath(`anim-${frame}.png`) });
  }
  await page.evaluate(() => document.getAnimations().forEach((animation) => animation.finish()));
  expect(await header()).toEqual(before.header);
  expect(Math.abs((await cardTop()) - before.top)).toBeLessThanOrEqual(1);
});

test('reduced motion: the field appears at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#create');
  const reveal = page.locator('.auth-v8-reveal');
  await page.getByRole('checkbox', { name: LABEL }).check();
  expect(await reveal.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
    '0s',
  );
});

test('a failed newsletter read offers Try again, which loads the setting', async ({ page }) => {
  await page.goto('/#create');
  await expect(page.getByRole('heading', { level: 1, name: 'Create your account.' })).toBeVisible();
  await page.getByLabel('Account name').fill(`Retry-${crypto.randomUUID().slice(0, 6)}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toHaveCount(0);
  // The first read fails (a server error); the next one goes through.
  let failed = false;
  await page.route('**/api/account/newsletter', async (route) => {
    if (failed || route.request().method() !== 'GET') return route.fallback();
    failed = true;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Synthetic newsletter read failure' }),
    });
  });
  await page.goto('/settings/account');
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  await expect(page.getByTestId('newsletter-status')).toHaveCount(0);
  await retry.click();
  await expect(page.getByTestId('newsletter-status')).toHaveText('Not subscribed');
  await expect(retry).toHaveCount(0);
});
