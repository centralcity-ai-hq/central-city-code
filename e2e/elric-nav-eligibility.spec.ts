import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/*
 * The console's "Elric" entry follows the account's eligibility (GET /api/elric). A password-only
 * account (no Google link, no date of birth) goes to /elric's Link Google step in one click and
 * never sees the activity view; under 18 sees no entry. The password-only case runs on the
 * fake-Google server (CITY_ELRIC on, nothing mocked); the other two mock GET /api/elric.
 */
const port = Number(process.env.E2E_GOOGLE_PORT);
const elricBase = `http://127.0.0.1:${port}`;
const headers = { 'x-city-request': '1' };
const PASSWORD = 'Local-test-only-passphrase-2026';

async function register(page: Page, base = '') {
  const created = await page.request.post(`${base}/api/auth/register`, {
    headers,
    data: { name: `Nav ${randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
}

function elricNav(page: Page) {
  // Exact: the pending-approvals badge must never change the entry's accessible name.
  return page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Elric', exact: true });
}

const LEDE = 'What your Elric did, and what it may do.';

/** Records, from the first byte of every page load, whether the activity heading ever rendered. */
function watchActivityHeading(page: Page) {
  return page.addInitScript((lede) => {
    const seen = () => {
      if (document.documentElement?.textContent?.includes(lede))
        (window as unknown as { __ledeSeen: boolean }).__ledeSeen = true;
    };
    (window as unknown as { __ledeSeen: boolean }).__ledeSeen = false;
    new MutationObserver(seen).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }, LEDE);
}

async function expectActivityHeadingNeverShown(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { __ledeSeen: boolean }).__ledeSeen)).toBe(
    false,
  );
}

function mockStatus(page: Page, status: Record<string, unknown>) {
  return page.route('**/api/elric', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        host_may_invoke: false,
        usage: {
          day: '2026-10-02',
          used: { short: 0, summary: 0, tool: 0 },
          allowance: { short: 20, summary: 4, tool: 5 },
          resets_at: '2026-10-03T00:00:00.000Z',
        },
        limit_notices: [],
        ...status,
      }),
    }),
  );
}

test('password-only account: one click on Elric lands on the Link Google step', async ({
  page,
}) => {
  await watchActivityHeading(page);
  await register(page, elricBase);
  await page.goto(`${elricBase}/`);
  await elricNav(page).click();
  await expect(page).toHaveURL(`${elricBase}/elric`);
  await expect(page.getByRole('heading', { name: 'Meet Elric' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Link Google' })).toHaveAttribute(
    'href',
    '/settings/account',
  );
  await expect(page.getByLabel('Date of birth')).toHaveCount(0);
  await expectActivityHeadingNeverShown(page);
  // The Elric settings address (/#elric) leads to the same step, never through the activity view.
  await page.goto(`${elricBase}/#elric`);
  await expect(page).toHaveURL(`${elricBase}/elric`);
  await expect(page.getByRole('heading', { name: 'Meet Elric' })).toBeVisible();
  await expectActivityHeadingNeverShown(page);
});

test('no date of birth yet: /#elric goes to the date of birth step, never the activity', async ({
  page,
}) => {
  await watchActivityHeading(page);
  await mockStatus(page, {
    agent_id: null,
    status: null,
    eligible: false,
    eligibility_reason: 'age_unknown',
  });
  // Elric on (the fake-Google server), so /elric's own calls answer; only the status is mocked.
  await register(page, elricBase);
  await page.goto(`${elricBase}/#elric`);
  await expect(page).toHaveURL(`${elricBase}/elric`);
  // The first-visit card: Google is linked (a green check), the age step is next.
  await expect(page.getByRole('heading', { name: 'Meet Elric' })).toBeVisible();
  await expect(page.locator('.elx3-step').first()).toContainText('Linked');
  await page.getByRole('button', { name: 'Confirm age' }).click();
  await expect(page.getByLabel('Date of birth')).toBeVisible();
  await expectActivityHeadingNeverShown(page);
});

test('under 18: /#elric falls back to the overview', async ({ page }) => {
  await watchActivityHeading(page);
  await mockStatus(page, {
    agent_id: null,
    status: null,
    eligible: false,
    eligibility_reason: 'age_under_18',
  });
  await register(page);
  await page.goto('/#elric');
  await expect(page.getByRole('heading', { name: 'Network map', level: 1 })).toBeVisible();
  await expect(elricNav(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await expectActivityHeadingNeverShown(page);
});

test('eligible account: Elric opens its page, and its activity and settings in the console', async ({
  page,
}) => {
  await mockStatus(page, {
    agent_id: 'elric-agent',
    status: 'active',
    eligible: true,
    eligibility_reason: null,
  });
  await page.route('**/api/elric/turns?*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ turns: [], next_cursor: null }),
    }),
  );
  await page.route('**/api/elric/pending', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ pending: [] }) }),
  );
  await register(page);
  await page.goto('/');
  // The workspace's Elric entry opens Elric's own page.
  await elricNav(page).click();
  await expect(page).toHaveURL(/\/elric$/);
  await expect(elricNav(page)).toHaveAttribute('aria-current', 'page');
  // Manage Elric's Activity link (/#elric) opens the activity and settings in the console.
  await page.getByRole('button', { name: 'Manage Elric' }).click();
  await page
    .getByRole('dialog', { name: 'Manage Elric' })
    .getByRole('link', { name: 'Activity' })
    .click();
  await expect(page.getByText(LEDE)).toBeVisible();
  await expect(page).toHaveURL(/^http:\/\/[^/]+\/$/);
});

test('under 18: no Elric entry in the console', async ({ page }) => {
  await mockStatus(page, {
    agent_id: null,
    status: null,
    eligible: false,
    eligibility_reason: 'age_under_18',
  });
  await register(page);
  await page.goto('/');
  await expect(
    page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: /^My agents/ }),
  ).toBeVisible();
  await expect(elricNav(page)).toHaveCount(0);
});

test('the Elric entry badges its pending approvals on the sidebar’s own read cycle', async ({
  page,
}) => {
  await mockStatus(page, {
    agent_id: 'elric-agent',
    status: 'active',
    eligible: true,
    eligibility_reason: null,
  });
  let pending: Array<{ id: string }> = [{ id: 'p1' }, { id: 'p2' }];
  await page.route('**/api/elric/pending', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ pending }) });
  });
  await register(page);
  await page.goto('/');
  const elric = elricNav(page);
  const badge = elric.locator('.wv2-pending');
  await expect(badge).toHaveText('2');
  // The name stays "Elric" with the badge on; the count's words are the button's description.
  await expect(elric).toHaveAccessibleName('Elric');
  await expect(elric).toHaveAccessibleDescription('2 actions waiting for you');
  // The same filled accent circle as the My agents requests pill (WORKSPACE_V3.md §3).
  await expect(badge).toHaveCSS('background-color', 'rgb(37, 99, 235)');
  await expect(badge).toHaveCSS('color', 'rgb(255, 255, 255)');
  // The count follows the next read (a reload reads at once): none pending, no badge.
  pending = [];
  await page.goto('/');
  await expect(elricNav(page)).toBeVisible();
  await expect(elricNav(page).locator('.wv2-pending')).toHaveCount(0);
});

test('an account without the Elric entry never reads the pending approvals', async ({ page }) => {
  await mockStatus(page, {
    agent_id: null,
    status: null,
    eligible: false,
    eligibility_reason: 'age_under_18',
  });
  let reads = 0;
  await page.route('**/api/elric/pending', async (route) => {
    reads += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ pending: [] }) });
  });
  await page.route('**/api/v2/connections/requests', (route) =>
    route.fulfill({ json: { incoming: [{ status: 'pending' }], outgoing: [] } }),
  );
  await register(page);
  await page.goto('/');
  // The sidebar's cycle ran (the requests badge loaded), Elric's count was never read.
  await expect(
    page.getByRole('button', { name: 'My agents', exact: true }),
  ).toHaveAccessibleDescription('1 pending connection request');
  await expect(elricNav(page)).toHaveCount(0);
  expect(reads).toBe(0);
});
