import { test, expect, type Page } from '@playwright/test';

/*
 * Sign in with Google, link and unlink, against a mocked Google (e2e/google-server.ts; docs/
 * GOOGLE_SIGNIN.md). The app runs on its own e2e server with the feature on; the browser's trip
 * to accounts.google.com is rerouted to the fake consent page, which redirects back with a code.
 */
const port = Number(process.env.E2E_GOOGLE_PORT);
const fakePort = Number(process.env.E2E_GOOGLE_FAKE_PORT);
const base = `http://127.0.0.1:${port}`;

/** Reroutes Google to the fake consent page; `subject` picks its own synthetic Google account. */
async function mockGoogle(page: Page, subject?: string) {
  await page.route('https://accounts.google.com/**', (route) => {
    const search = new URLSearchParams(new URL(route.request().url()).search);
    if (subject) search.set('e2e_subject', subject);
    return route.fulfill({
      status: 302,
      headers: { location: `http://127.0.0.1:${fakePort}/authorize?${search}` },
    });
  });
}
async function register(page: Page) {
  const response = await page.request.post(`${base}/api/auth/register`, {
    headers: { 'x-city-request': '1' },
    data: { name: `Google ${Date.now()}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(response.status()).toBe(201);
}

test('link a Google account, sign in with it, and unlink it', async ({ page }) => {
  await mockGoogle(page);
  await register(page);

  // Account: link.
  await page.goto(`${base}/settings/account`);
  await expect(page.getByRole('heading', { name: 'Google account' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(`${base}/settings/account`);
  // While the profile and the link still load, their loading lines are statuses too.
  await expect(page.getByRole('status').filter({ hasText: 'Google account linked.' })).toHaveText(
    'Google account linked.',
  );
  await expect(
    page
      .getByRole('region', { name: 'Account' })
      .getByText('Linked to synthetic.person@example.com'),
  ).toBeVisible();

  // The date of birth for Elric (18 or over).
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // Signed out, "Continue with Google" on sign-in signs in the linked account.
  const out = await page.request.post(`${base}/api/auth/logout`, {
    headers: { 'x-city-request': '1' },
    data: {},
  });
  expect(out.ok()).toBeTruthy();
  await page.goto(`${base}/signin`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  const session = await (await page.request.get(`${base}/api/session`)).json();
  expect(session.operator).not.toBeNull();

  // Unlink: the account no longer signs in with Google.
  await page.goto(`${base}/settings/account`);
  // Unlink asks first: it also deletes the date of birth saved for Elric.
  await page.getByRole('button', { name: 'Unlink Google' }).click();
  await page
    .getByRole('dialog', { name: 'Unlink Google?' })
    .getByRole('button', { name: 'Unlink Google' })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Google account unlinked.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await page.request.post(`${base}/api/auth/logout`, {
    headers: { 'x-city-request': '1' },
    data: {},
  });
  await page.goto(`${base}/signin`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(`${base}/signin`);
  // Unlinked within 30 days: no new account for that Google account yet.
  await expect(page.getByRole('alert')).toContainText('unlinked from another Central City account');
});

test('sign up with Google: name and Terms first; Back never skips them', async ({ page }) => {
  // A Google account of its own (the default one is linked and unlinked above).
  await mockGoogle(page, `2${Date.now()}`);
  await page.goto(`${base}/#create`);
  await expect(page.getByRole('heading', { name: 'Create your account.' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(`${base}/settings/account`);
  const gate = page.getByRole('heading', { name: 'Finish creating your account' });
  await expect(gate).toBeVisible();

  // Back, or going to the app directly, lands on the same screen; the API refuses too.
  await page.goBack();
  await expect(gate).toBeVisible();
  await page.goto(`${base}/rooms`);
  await expect(gate).toBeVisible();
  const refused = await page.request.get(`${base}/api/rooms`);
  expect(refused.status()).toBe(403);
  expect((await refused.json()).code).toBe('onboarding_required');

  // Name and acceptance: then the app opens.
  await page.getByLabel('Account name').fill(`Googler ${Date.now()}`);
  const accept = page.getByRole('button', { name: 'Continue' });
  await expect(accept).toBeDisabled();
  // The newsletter opt-in is offered, unticked, with no email field (the Google address is used).
  await expect(
    page.getByRole('checkbox', { name: 'Subscribe to the Central City newsletter' }),
  ).not.toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Email' })).toHaveCount(0);
  await page.getByRole('checkbox', { name: /I accept the Terms/ }).check();
  await accept.click();
  await expect(gate).toHaveCount(0);
  // A new account meets Elric once, after the Terms; skipping goes on to the app.
  await expect(
    page.getByRole('heading', { name: 'Meet Elric, your AI assistant in Central City' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page).toHaveURL(/\/rooms/);
  expect((await page.request.get(`${base}/api/rooms`)).status()).toBe(200);
});

test('Meet Elric after sign-up shows the AI notice and opens the Elric chat, once', async ({
  page,
}) => {
  await mockGoogle(page, `3${Date.now()}`);
  await page.goto(`${base}/#create`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  // The sign-up form has an "Account name" field too: wait for the onboarding screen first, or
  // the name can go into the form that is being left and the onboarding name stays empty.
  await expect(page).toHaveURL(`${base}/settings/account`);
  await expect(page.getByRole('heading', { name: 'Finish creating your account' })).toBeVisible();
  await page.getByLabel('Account name').fill(`Meeter ${Date.now()}`);
  await page.getByRole('checkbox', { name: /I accept the Terms/ }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  const meet = page.getByRole('heading', {
    name: 'Meet Elric, your AI assistant in Central City',
  });
  await expect(meet).toBeVisible();
  await expect(page.getByText('Elric is the native AI assistant of Central City.')).toBeVisible();
  await page.getByRole('link', { name: 'Meet Elric' }).click();
  await expect(page).toHaveURL(`${base}/elric`);
  // Once only: signed out and back in with the same Google account, the app opens directly.
  const out = await page.request.post(`${base}/api/auth/logout`, {
    headers: { 'x-city-request': '1' },
    data: {},
  });
  expect(out.ok()).toBeTruthy();
  await page.goto(`${base}/signin`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await expect(meet).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Finish creating your account' })).toHaveCount(0);
});

test('without the flag, sign-in shows no Google button', async ({ page }) => {
  // The main e2e server runs with Sign in with Google off (the default).
  await page.goto('/signin');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
});
