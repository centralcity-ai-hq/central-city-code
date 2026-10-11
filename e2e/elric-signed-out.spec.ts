import { test, expect, type Page, type Route } from '@playwright/test';
import { gotoMounted } from './mounted';
import { openAccountMenu } from './settings-nav';

/*
 * /elric for a signed-out visitor (W2, the approved mockup v2) and the inline first step for a
 * signed-in person without Elric. The e2e server runs without CITY_ELRIC, so /api/elric* is
 * served by page.route with the server's shapes: GET /api/elric answers 401 to a visitor when
 * Elric is on (404 when it is off). Sign-in itself is real.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const CHAT = 'c4a1e2f0-1b2c-4d3e-8f90-0a1b2c3d4e5f';
const headers = { 'x-city-request': '1' };
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * Elric on; `under18` makes the age check refuse, `reason` is the signed-in account's
 * eligibility reason, `ready` means the account already has Elric. Returns what the page asked.
 */
async function mockElricOn(
  page: Page,
  opts: { under18?: boolean; reason?: 'unverified' | 'age_unknown'; ready?: boolean } = {},
) {
  const state = {
    signedIn: false,
    created: opts.ready === true,
    ages: [] as unknown[],
    posts: [] as string[],
  };
  page.on('response', (response) => {
    if (/\/api\/auth\/(register|login)$/.test(response.url()) && response.ok())
      state.signedIn = true;
  });
  await page.route('**/api/auth/google', (route) => json(route, { enabled: true, linked: null }));
  await page.route('**/api/elric', (route) => {
    if (!state.signedIn) return json(route, { error: 'Sign in to continue.' }, 401);
    if (route.request().method() === 'POST') {
      state.created = true;
      return json(route, { agent_id: 'elric-agent', created: true }, 201);
    }
    return json(route, {
      agent_id: state.created ? 'elric-agent' : null,
      status: state.created ? 'active' : null,
      eligible: state.created,
      eligibility_reason: state.created ? null : (opts.reason ?? 'age_unknown'),
      usage: {
        used: { short: 0, summary: 0, tool: 0 },
        allowance: { short: 20, summary: 4, tool: 5 },
        resets_at: '2026-10-02T00:00:00.000Z',
      },
    });
  });
  await page.route('**/api/elric/age', (route) => {
    state.ages.push(route.request().postDataJSON());
    return opts.under18
      ? json(route, { error: 'Elric is available from age 18.', code: 'elric_age_under_18' }, 403)
      : json(route, { age_check: 'over_18' });
  });
  await page.route('**/api/elric/chat*', (route) =>
    state.created
      ? json(route, {
          room_id: CHAT,
          slug: 'elric-chat',
          person_member_id: 'p-1',
          status: 'active',
          latest_seq: 0,
          waking: false,
          pending_count: 0,
        })
      : json(route, { error: 'You have no Elric.', code: 'elric_not_found' }, 404),
  );
  await page.route(`**/api/rooms/${CHAT}/messages*`, (route) => {
    if (route.request().method() === 'POST') {
      state.posts.push(String(route.request().postDataJSON()?.text ?? ''));
      return json(route, { error: 'Not in this test.' }, 500);
    }
    return json(route, {
      room: { id: CHAT, slug: 'elric-chat', name: 'Elric', role: 'host', latest_seq: 0 },
      messages: [],
      latest_seq: 0,
      visible_from_seq: 0,
      next_since: 0,
      has_more: false,
    });
  });
  await page.route('**/api/elric/pending', (route) => json(route, { pending: [] }));
  return state;
}

test('signed out: Send turns into Continue with Google with one quiet line, no card', async ({
  page,
}) => {
  await mockElricOn(page);
  const starts: unknown[] = [];
  await page.route('**/api/auth/google/start', (route) => {
    starts.push(route.request().postDataJSON());
    return json(route, { url: '/elric?google=test' });
  });
  await gotoMounted(page, '/elric');
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
  await expect(page.locator('.elx-out-card')).toHaveCount(4);
  const header = page.locator('.elx-out-header');
  await expect(header.getByRole('button', { name: 'Log in' })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Sign up for free' })).toBeVisible();
  await expect(header.locator('.elx-tag')).toHaveText('AI');

  const composer = page.locator('.elx-out-composer');
  const box = page.getByLabel('Message Elric');
  const hint = page.getByTestId('elric-signin-hint');
  await expect(hint).toHaveAttribute('aria-live', 'polite');
  await expect(hint).toBeEmpty();
  // Typing alone changes nothing; Send with text turns the button into the sign-in step.
  await box.pressSequentially('Hi Elric');
  await expect(composer.getByRole('button', { name: 'Send' })).toBeVisible();
  await box.press('Enter');
  const google = composer.getByRole('button', { name: 'Continue with Google' });
  await expect(google).toBeVisible();
  await expect(google).toBeFocused();
  await expect(composer.getByRole('button', { name: 'Send' })).toHaveCount(0);
  await expect(hint).toHaveText('Elric needs a Google account (18+). Not now');
  await expect(page).toHaveURL(/\/elric$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region')).toHaveCount(0);
  await expect(box).toHaveValue('Hi Elric');
  // The draft stays in this tab only; nothing went to the server.
  expect(await page.evaluate(() => sessionStorage.getItem('cc_elric_pending_draft'))).toBe(
    'Hi Elric',
  );
  expect(starts).toEqual([]);

  // Clicking back into the text restores Send (the kept copy stays until sent or Not now).
  await box.click();
  await expect(composer.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(hint).toBeEmpty();

  // Not now: Send is back, the text stays in the box, the kept copy is cleared.
  await box.press('Enter');
  await expect(google).toBeVisible();
  await hint.getByRole('button', { name: 'Not now' }).click();
  await expect(composer.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(hint).toBeEmpty();
  await expect(box).toHaveValue('Hi Elric');
  await expect(box).toBeFocused();
  expect(await page.evaluate(() => sessionStorage.getItem('cc_elric_pending_draft'))).toBeNull();

  // Pressing the pill starts the existing Google sign-in.
  await box.press('Enter');
  await google.click();
  await expect.poll(() => starts).toEqual([{ intent: 'signin', next: '/elric' }]);
});

test('signed out: a suggestion fills the composer and Send without text does nothing', async ({
  page,
}) => {
  await mockElricOn(page);
  await gotoMounted(page, '/elric');
  const composer = page.locator('.elx-out-composer');
  await composer.getByRole('button', { name: 'Send' }).click();
  await expect(composer.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
  await page.locator('.elx-out-card').first().click();
  await expect(page.getByLabel('Message Elric')).toHaveValue('Invite ChatGPT to a room');
  await expect(page.getByTestId('elric-signin-hint')).toBeEmpty();
  await expect(page.locator('body')).not.toContainText(/gemma|haiku|claude|anthropic|gpt-/i);
});

test('signed out with Elric off on the server: not found', async ({ page }) => {
  await gotoMounted(page, '/elric');
  await expect(page.getByText('This page doesn’t exist.')).toBeVisible();
});

test('the typed message is back in the composer after signing in with Google, not sent', async ({
  page,
}) => {
  const state = await mockElricOn(page, { ready: true });
  const starts: unknown[] = [];
  // The Google round trip, mocked: the start signs this browser in for real and comes back.
  await page.route('**/api/auth/google/start', async (route) => {
    starts.push(route.request().postDataJSON());
    const created = await page.request.post('/api/auth/register', {
      headers,
      data: { name: `Elric-g-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
    });
    expect(created.status()).toBe(201);
    state.signedIn = true;
    return json(route, { url: '/elric' });
  });
  await gotoMounted(page, '/elric');
  await page.getByLabel('Message Elric').fill('What can you do in my rooms?');
  await page.getByRole('button', { name: 'Send' }).click();
  await page
    .locator('.elx-out-composer')
    .getByRole('button', { name: 'Continue with Google' })
    .click();
  await expect.poll(() => starts).toEqual([{ intent: 'signin', next: '/elric' }]);

  // Signed in, back on /elric: the chat with the message waiting in the composer.
  await expect(page).toHaveURL(/\/elric$/);
  const box = page.locator('.elx-dock').getByLabel('Message Elric');
  await expect(box).toHaveValue('What can you do in my rooms?');
  await expect(box).toBeFocused();
  await page.waitForTimeout(500);
  expect(state.posts).toEqual([]);
});

test('signed in without a Google link: why, Link Google and fixed examples, no model call', async ({
  page,
}) => {
  await mockElricOn(page, { reason: 'unverified' });
  const calls: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/'))
      calls.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await gotoMounted(page, '/elric');
  await page.locator('.elx-out-header').getByRole('button', { name: 'Sign up for free' }).click();
  await page.getByLabel('Account name').fill(`Elric-nog-${crypto.randomUUID().slice(0, 8)}`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  // The first-visit card (Workspace v3): Meet Elric, then two steps; the age waits for Google.
  await expect(page.getByRole('heading', { name: 'Meet Elric' })).toBeVisible();
  await expect(page.getByText('Elric needs a verified Google account.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm age' })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Link Google' })).toHaveAttribute(
    'href',
    '/settings/account',
  );
  await expect(page.getByLabel('Date of birth')).toHaveCount(0);
  // Just the card, centred: no example panels under it.
  await expect(page.getByTestId('elric-example')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/gemma|haiku|claude|anthropic|gpt-/i);
  // Only the sign-up itself was sent: no message, no Elric, no model request.
  await page.waitForTimeout(500);
  expect(calls.filter((call) => !/^POST \/api\/auth\//.test(call))).toEqual([]);
});

test('sign up, then confirm your age once, then the chat', async ({ page }) => {
  const state = await mockElricOn(page);
  await gotoMounted(page, '/elric');
  await page.locator('.elx-out-header').getByRole('button', { name: 'Sign up for free' }).click();
  await expect(page.getByRole('heading', { name: 'Create your account.' })).toBeVisible();
  await page.getByLabel('Account name').fill(`Elric-new-${crypto.randomUUID().slice(0, 8)}`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  // Back on /elric, signed in: the first-visit card and the age step (a sheet).
  await expect(page).toHaveURL(/\/elric$/);
  await expect(page.getByRole('heading', { name: 'Meet Elric' })).toBeVisible();
  await expect(page.getByText('Elric is for adults. Asked once.')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm age' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm your age' })).toBeVisible();
  await page.getByLabel('Date of birth').fill('1990-05-17');
  await page.getByRole('button', { name: 'Confirm your age' }).click();
  await expect(page.getByLabel('Message Elric')).toBeVisible();
  await expect(page.getByTestId('elric-example')).toHaveCount(0);
  expect(state.ages).toEqual([{ date_of_birth: '1990-05-17' }]);
  expect(state.created).toBe(true);
});

test('under 18: the server refuses and the page says so plainly', async ({ page }) => {
  await mockElricOn(page, { under18: true });
  await gotoMounted(page, '/elric');
  await page.locator('.elx-out-header').getByRole('button', { name: 'Sign up for free' }).click();
  await page.getByLabel('Account name').fill(`Elric-young-${crypto.randomUUID().slice(0, 8)}`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'Confirm age' }).click();
  await page.getByLabel('Date of birth').fill('2012-05-17');
  await page.getByRole('button', { name: 'Confirm your age' }).click();
  await expect(page.getByRole('heading', { name: 'Elric is for adults' })).toBeVisible();
  await expect(page.getByText('Elric is available from age 18.')).toBeVisible();
  await expect(page.getByLabel('Date of birth')).toHaveCount(0);
  await expect(page.getByTestId('elric-example')).toHaveCount(0);
});

test('390 px: one row header, the pill fits inside the composer, no sideways scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockElricOn(page);
  await gotoMounted(page, '/elric');
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
  expect((await page.locator('.elx-out-header').boundingBox())!.height).toBeLessThanOrEqual(57);
  await page.getByLabel('Message Elric').fill('Hello');
  await page.getByLabel('Message Elric').press('Enter');
  const composer = (await page.locator('.elx-out-composer').boundingBox())!;
  const pill = page
    .locator('.elx-out-composer')
    .getByRole('button', { name: 'Continue with Google' });
  await expect(pill).toBeVisible();
  await expect(page.getByTestId('elric-signin-hint')).toContainText(
    'Elric needs a Google account (18+).',
  );
  // After the width transition the pill sits inside the composer, and the composer in the gutter.
  await page.waitForTimeout(300);
  const box = (await pill.boundingBox())!;
  expect(composer.x).toBeGreaterThanOrEqual(16);
  expect(box.x + box.width).toBeLessThanOrEqual(composer.x + composer.width + 0.5);
  expect(composer.x + composer.width).toBeLessThanOrEqual(390 - 16 + 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('signing out forgets a kept message: the next person starts with an empty composer', async ({
  page,
}) => {
  const state = await mockElricOn(page, { ready: true });
  const register = async (label: string) => {
    const created = await page.request.post('/api/auth/register', {
      headers,
      data: { name: `${label}-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
    });
    expect(created.status()).toBe(201);
    state.signedIn = true;
  };
  await gotoMounted(page, '/elric');
  await page.getByLabel('Message Elric').fill('A private question');
  await page.getByLabel('Message Elric').press('Enter');
  await expect(
    page.locator('.elx-out-composer').getByRole('button', { name: 'Continue with Google' }),
  ).toBeVisible();
  const kept = () => page.evaluate(() => sessionStorage.getItem('cc_elric_pending_draft'));
  expect(await kept()).toBe('A private question');

  // Someone signs in in this tab, then signs out.
  await register('Elric-first');
  await page.goto('/');
  // Sign out sits in the workspace sidebar's account menu.
  await openAccountMenu(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect.poll(kept).toBeNull();
  state.signedIn = false;

  // The next person in the same tab: the composer is empty.
  await register('Elric-next');
  await gotoMounted(page, '/elric');
  const box = page.locator('.elx-dock').getByLabel('Message Elric');
  await expect(box).toBeVisible();
  await expect(box).toHaveValue('');
});

test('a crawler that may not fetch /api/elric still gets the Elric page, not a 404', async ({
  page,
}) => {
  // robots.txt once kept Googlebot from /api/elric; the page then rendered "This page doesn't
  // exist" and Google rejected /elric. Only an explicit 404 from the API means Elric is off.
  await page.route('**/api/elric', (route) => route.abort('blockedbyclient'));
  await gotoMounted(page, '/elric');
  await expect(page).toHaveTitle(/Elric/);
  await expect(page.getByText('This page doesn’t exist.')).toHaveCount(0);
});
