import { test, expect, type Page } from '@playwright/test';

/*
 * Signing in never shows error copy on the way to the signed-in page (reported on 29 Sep:
 * "an error message for one second, before the website properly loaded").
 *
 * Every error text that is ever attached to the page is recorded by a MutationObserver installed
 * before the app starts, so a message that shows for a single frame still fails the test.
 * The deploy case: the lazy Rooms/console chunk of the old build answers 404, the page reloads
 * once (src/shell/ErrorBoundary.tsx) and must show the loading state, not "Something went wrong.",
 * while it does.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const ERROR_TEXT =
  /something went wrong|couldn.t|could not|unable to|taking too long|session has ended|try again|error/i;

async function recordErrorText(page: Page) {
  await page.addInitScript((source) => {
    const pattern = new RegExp(source, 'i');
    // Kept in sessionStorage too, so what showed before a reload is still readable after it.
    const key = 'e2e.errorText';
    const seen: string[] = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    (window as unknown as { __errorText: string[] }).__errorText = seen;
    const record = (text: string) => {
      seen.push(text);
      sessionStorage.setItem(key, JSON.stringify(seen));
    };
    const scan = () => {
      const alerts = [...document.querySelectorAll('[role="alert"], .form-error, .cc-state')];
      for (const element of alerts) {
        const text = element.textContent?.trim();
        if (text) record(`${location.pathname}: ${text}`);
      }
      const main = document.querySelector('main')?.textContent ?? '';
      const match = pattern.exec(main);
      if (match) record(`${location.pathname}: …${match[0]}…`);
    };
    new MutationObserver(scan).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }, ERROR_TEXT.source);
}

const errorText = (page: Page) =>
  page.evaluate(() => (window as unknown as { __errorText?: string[] }).__errorText ?? []);

async function account(page: Page) {
  const name = `sig-${crypto.randomUUID().slice(0, 8)}`;
  // A first account, so the sign-in page is not the installation's setup run.
  const created = await page.request.post('/api/auth/register', {
    headers: { 'x-city-request': '1' },
    data: { name, password: PASSWORD },
  });
  expect(created.ok()).toBe(true);
  await page.context().clearCookies();
  return name;
}

async function signIn(page: Page, name: string) {
  await page.getByLabel('Account name').fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('sign up → Overview shows no error text on the way', async ({ page }) => {
  await account(page); // not the setup run
  await recordErrorText(page);
  await page.goto('/signin');
  await page.getByRole('tab', { name: 'Sign up' }).click();
  await page.getByLabel('Account name').fill(`sig-${crypto.randomUUID().slice(0, 8)}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    // The Overview is the Network map in the workspace.
    page.getByRole('heading', { level: 1, name: 'Network map' }),
  ).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState('networkidle');
  expect(await errorText(page)).toEqual([]);
});

for (const start of ['/signin', '/#signin']) {
  test(`sign in from ${start} → Rooms shows no error text on the way`, async ({ page }) => {
    const name = await account(page);
    await recordErrorText(page);
    await page.goto(start);
    await signIn(page, name);
    await expect(page).toHaveURL(/\/rooms$/);
    await expect(page.getByRole('heading', { name: 'No rooms yet' })).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForLoadState('networkidle');
    expect(await errorText(page)).toEqual([]);
  });
}

/*
 * Right after a deploy. `misses` is how many page loads after signing in still miss the chunk:
 * 1 = the old page's lazy chunk is gone; 2 = the first reload also misses, as while the
 * production alias moves between builds (logs, 29 Sep 11:29 UTC: four deploys in two minutes).
 */
for (const misses of [1, 2]) {
  test(`sign in right after a deploy (${misses} missing chunk load${misses > 1 ? 's' : ''}): loading, never an error`, async ({
    page,
  }) => {
    const name = await account(page);
    await recordErrorText(page);
    await page.goto('/signin');
    await expect(page.getByLabel('Account name')).toBeVisible();
    let loads = 0; // page loads since signing in
    page.on('request', (request) => {
      // A document request of the main frame is a reload (pushState navigations make none).
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loads += 1;
    });
    // The chunks made to fail, per page load. With Smart Rooms v2 the rooms page asks for both
    // App and RoomsShell in one load, so a load misses one or both of them.
    const missedPerLoad = new Map<number, Set<string>>();
    await page.route(/\/assets\/(RoomsShell|App)-[^/]+\.js$/, async (route) => {
      if (loads >= misses) return route.continue();
      const chunk = /\/assets\/(RoomsShell|App)-/.exec(route.request().url())![1];
      const missed = missedPerLoad.get(loads) ?? new Set<string>();
      missed.add(chunk);
      missedPerLoad.set(loads, missed);
      return route.fulfill({ status: 404, contentType: 'text/html', body: 'Not found' });
    });
    await signIn(page, name);
    await expect(page).toHaveURL(/\/rooms$/);
    await expect(
      page.getByRole('heading', { name: /No rooms yet|Something went wrong/ }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState('networkidle');
    // Includes everything shown before each reload (the record lives in sessionStorage).
    expect(await errorText(page)).toEqual([]);
    await expect(page.getByRole('heading', { name: 'No rooms yet' })).toBeVisible();
    // Exactly the first `misses` loads missed a chunk, each at most App and RoomsShell once.
    expect([...missedPerLoad.keys()]).toEqual([...Array(misses).keys()]);
    for (const missed of missedPerLoad.values()) {
      expect(missed.size).toBeGreaterThanOrEqual(1);
      expect(missed.size).toBeLessThanOrEqual(2);
    }
    expect(loads).toBe(misses);
  });
}

test('a chunk that stays missing ends in the error page after three reloads, not a reload loop', async ({
  page,
}) => {
  const name = await account(page);
  await page.goto('/signin');
  let loads = 0;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loads += 1;
  });
  await page.route(/\/assets\/(RoomsShell|App)-[^/]+\.js$/, (route) =>
    route.fulfill({ status: 404, contentType: 'text/html', body: 'Not found' }),
  );
  await signIn(page, name);
  await expect(page.getByRole('heading', { level: 1, name: 'Something went wrong.' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
  await page.waitForTimeout(1500);
  expect(loads).toBe(3);
});
