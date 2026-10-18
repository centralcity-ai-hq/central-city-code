import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { lowContrast } from './contrast';
import { degraded, MANAGE_CODE, mockFeed, sampleServices } from './feed-fixtures';
import { FEED_HOSTED_SOURCE } from '../shared/feed';
import { e2eOrigin } from './port';
import { openAccountMenu } from './settings-nav';

/*
 * The Feed in the signed-in workspace (src/feed/Feed.tsx; the Feed mockup of 13 Oct). Every Feed
 * route is mocked (e2e/feed-fixtures.ts): Offered serves real x402 Bazaar records, Searched for
 * a few made-up requests. The session, the workspace and its agents are the real test server,
 * which runs with CITY_FEED=0, so the specs never reach a real Feed route; links out are never
 * followed.
 */

const LABEL = 'External service · listed by x402 Bazaar · not a Central City agent';
/** Arrow characters and arrow-like quotes: none anywhere in the Feed. */
const ARROWS = /[\u2190-\u21ff\u2794-\u27bf\u2900-\u297f\u2b00-\u2bff\u00ab\u00bb\u2039\u203a]/;
/** The app's avatar palette (src/shell/avatarColor.ts), as computed colours. */
const PALETTE = [
  '#dc2626',
  '#15803d',
  '#6d28d9',
  '#475569',
  '#4d7c0f',
  '#1e3a8a',
  '#881337',
  '#a16207',
  '#0369a1',
  '#be185d',
  '#92400e',
  '#0e7490',
  '#701a75',
  '#c2410c',
  '#0f766e',
  '#c026d3',
].map((hex) => `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`);
const MACHINE_TEXT = /city_[a-z]|[{}]|idempoten/i;
const headers = { 'x-city-request': '1' };
const PASSWORD = 'Local-test-only-passphrase-2026';

async function signIn(page: Page) {
  const name = `Feed ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: { name, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  return name;
}

async function addAgent(page: Page, name: string) {
  const response = await page.request.post('/api/agents', {
    headers,
    data: { name, description: 'Posts requests', capability: 'research', mode: 'external' },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { agent: { id: string; name: string } }).agent;
}

async function plainText(page: Page, root = 'main') {
  const text = await page.locator(root).evaluate((main) => (main as HTMLElement).innerText);
  const hit = MACHINE_TEXT.exec(text);
  expect(hit ? text.slice(Math.max(0, hit.index - 60), hit.index + 60) : null).toBeNull();
  expect(ARROWS.exec(text)?.[0] ?? null).toBeNull();
}

/** Records every Feed list read the page makes, with its cache mode (call before page.goto). */
async function spyFeedReads(page: Page) {
  await page.addInitScript(() => {
    const spy = window as unknown as { __feedReads: Array<[string, string | null]> };
    spy.__feedReads = [];
    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/public/feed/')) spy.__feedReads.push([url, init?.cache ?? null]);
      return original(input, init);
    };
  });
}

const feedReads = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __feedReads: Array<[string, string | null]> }).__feedReads,
  );

/** The cache mode of the last first-page read of `path` (no cursor). */
async function lastFirstPageCache(page: Page, path: string) {
  const reads = (await feedReads(page)).filter(
    ([url]) => new URL(url, 'http://x').pathname === path && !url.includes('cursor='),
  );
  return reads.at(-1)?.[1] ?? null;
}

async function openFeed(page: Page, path = '/feed') {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Workspace', exact: true });
const feedEntry = (page: Page) => sidebar(page).getByRole('button', { name: 'Feed', exact: true });
const cards = (page: Page) => page.getByRole('list', { name: 'Services' }).locator('> li');
const requestCards = (page: Page) => page.getByRole('list', { name: 'Requests' }).locator('> li');
/** The detail drawer (a modal dialog named by its heading). */
const drawer = (page: Page) => page.getByRole('dialog');
const countLine = (page: Page) => page.locator('#fd-list-h');
const views = (page: Page) => page.getByRole('navigation', { name: 'Feed views' });
const notFound = (page: Page) =>
  page.getByRole('heading', { level: 1, name: 'This page doesn’t exist.' });
/** The validation and failure summaries at the top of the form (they take focus). */
const summaryOf = (form: ReturnType<Page['getByRole']>) => form.locator('.fd-errsum');
/** The Feed's own code, as the build splits it out (src/Root.tsx loadFeed). */
const FEED_CHUNK = /\/assets\/Feed-[^/]*\.js$/;

/** Chooses a value in a Feed pill menu (Price or Sort): opens it and clicks the option. */
async function pickPill(page: Page, id: 'fd-max' | 'fd-sort' | 'fd-tag', value: string) {
  await page.locator(`#${id}`).click();
  await page.locator(`#${id}-list [role="option"][data-value="${value}"]`).click();
}

test('with the Feed off, the sidebar has no Feed entry and every Feed address is the 404', async ({
  page,
}) => {
  await signIn(page);
  await mockFeed(page, { on: false });
  const chunks: string[] = [];
  page.on('request', (request) => {
    if (FEED_CHUNK.test(new URL(request.url()).pathname)) chunks.push(request.url());
  });
  const asked = page.waitForResponse('**/api/public/feed');
  await page.goto('/rooms');
  expect((await asked).status()).toBe(404);
  await expect(sidebar(page).getByRole('button', { name: 'My agents' })).toBeVisible();
  await expect(feedEntry(page)).toHaveCount(0);
  // On a phone too: the ordinary 404, outside the workspace, and the Feed is never named.
  for (const width of [1440, 375])
    for (const path of [
      '/feed',
      '/feed/requests',
      '/feed/requests/req_aaaaaaaaaaaaaaaaaaa2',
      '/feed/requests/req_aaaaaaaaaaaaaaaaaaa2/manage',
      '/feed/services/svc_abcdefghijklmnopqrst',
    ]) {
      await page.setViewportSize({ width, height: 812 });
      await page.goto(path);
      await expect(notFound(page)).toBeVisible();
      await expect(page.locator('.app-shell')).toHaveCount(0);
      await expect(page.getByText('Feed', { exact: true })).toHaveCount(0);
      await expect(feedEntry(page)).toHaveCount(0);
    }
  // The Feed's code is never fetched while it is off.
  expect(chunks).toEqual([]);
});

test('with the Feed on, the sidebar lists it after My agents and it opens inside the workspace', async ({
  page,
}) => {
  await signIn(page);
  await mockFeed(page);
  await page.goto('/rooms');
  await expect(feedEntry(page)).toBeVisible();
  const names = await sidebar(page)
    .getByRole('button')
    .evaluateAll((buttons) =>
      buttons.map((button) => button.querySelector('.ws-nav-label')?.textContent ?? ''),
    );
  const at = names.indexOf('Feed');
  expect(names.slice(at - 1, at + 2)).toEqual(['My agents', 'Feed', 'Connect AI']);
  // The entry's icon is the sidebar's: 18 px at a 1.9 stroke.
  const icon = feedEntry(page).locator('svg');
  await expect(icon).toHaveAttribute('width', '18');
  await expect(icon).toHaveAttribute('stroke-width', '1.9');
  const shell = await page.locator('.app-shell').elementHandle();
  await feedEntry(page).click();
  await expect(page).toHaveURL(/\/feed$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
  await expect(feedEntry(page)).toHaveAttribute('aria-current', 'page');
  // The same shell: only the page area changed.
  expect(await shell!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(page).toHaveTitle('Feed · Central City');
  // Inside the app shell, at the workspace's 90% density; no public header or footer.
  await expect(page.locator('.app-shell main#main-content.fd-page')).toBeVisible();
  const density = await page
    .locator('.fd-page')
    .evaluate((main) => getComputedStyle(main).getPropertyValue('--ws-px').trim());
  expect(parseFloat(density)).toBe(0.9);
  await expect(page.getByRole('navigation', { name: 'Public' })).toHaveCount(0);
  // Back to Rooms and forward again keep the shell.
  await sidebar(page).getByRole('button', { name: 'Rooms', exact: true }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
});

test('under the lede, "How the Feed works" opens the public guide at /docs/feed', async ({
  page,
}) => {
  await signIn(page);
  await mockFeed(page);
  await openFeed(page);
  const head = page.locator('.fd-head');
  const howTo = head.getByRole('link', { name: 'How the Feed works', exact: true });
  await expect(howTo).toBeVisible();
  await expect(howTo).toHaveAttribute('href', '/docs/feed');
  // Below the lede, as its own line; plain words, no arrow.
  const lede = await head.locator('.fd-lede').boundingBox();
  const link = await howTo.boundingBox();
  expect(link!.y).toBeGreaterThanOrEqual(lede!.y + lede!.height - 1);
  expect(ARROWS.exec(await head.innerText())?.[0] ?? null).toBeNull();
  await howTo.click();
  await expect(page).toHaveURL(/\/docs\/feed$/);
  await expect(page.getByRole('heading', { level: 1, name: 'How the Feed works' })).toBeVisible();
  for (const name of ['Offered', 'Use a service', 'Post a request', 'For AIs and developers'])
    await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  const article = await page.locator('article.docs-article').innerText();
  expect(article).toContain('External listings are not Central City agents.');
  // No "AIs can't post", no held request that shows later; a no-account post is unverified.
  const flat = article.replace(/\s+/g, ' ');
  expect(flat).toContain('Requests posted without an account are marked unverified.');
  expect(flat).toContain("Some requests are held for review and aren't listed.");
  expect(flat).toContain('A request still in review after 7 days is deleted.');
  expect(flat).toContain("Posting through the API isn't documented yet.");
  expect(flat).not.toMatch(/can't post|before they show|don't show yet|until it is checked/);
  expect(ARROWS.exec(article)?.[0] ?? null).toBeNull();
});

/** The paid service calls chip in the head (src/PaidCallsTicker.tsx PaidCallsChip). */
const paidChip = (page: Page) => page.locator('.fd-head [data-paid-calls-ticker]');

test('the live chip sits right of the title, with no link; none without the counts', async ({
  page,
}) => {
  await signIn(page);
  await mockFeed(page, { paidCalls: 1_284, baseAgents: 31_452 });
  await openFeed(page);
  const chip = paidChip(page);
  await expect(chip.locator('.fd-base-n')).toHaveText('31,452');
  await expect(chip.locator('.fd-paid-n')).toHaveText('1,284');
  await expect(chip.locator('.fd-paid-label')).toHaveText('paid service calls');
  await expect(chip.locator('.fd-base-label')).toHaveText('Base agents');
  await expect(chip.locator('.fd-paid-sep')).toHaveText('·');
  // Wide enough here for the whole wording.
  await expect(chip.locator('.fd-paid-long')).toBeVisible();
  await expect(chip.locator('.visually-hidden').first()).toHaveText(
    '31,452 Base agents and 1,284 paid service calls on Central City',
  );
  await expect(chip.getByRole('link')).toHaveCount(0);
  // On the title's row, at its right end; 28 workspace pixels tall.
  const head = (await page.locator('.fd-head').boundingBox())!;
  const title = (await page.getByRole('heading', { level: 1, name: 'Feed' }).boundingBox())!;
  const box = (await chip.boundingBox())!;
  expect(Math.abs(box.y + box.height / 2 - (title.y + title.height / 2))).toBeLessThan(3);
  expect(Math.abs(box.x + box.width - (head.x + head.width))).toBeLessThan(1.5);
  expect(box.height).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeLessThanOrEqual(29);
  await expect(chip.locator('.fd-paid-n')).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await expect(chip.locator('.fd-paid-core')).toHaveCSS('animation-name', 'fd-paid-live');
  // "How the Feed works" stays its own line under the lede; no arrow anywhere in the head.
  const lede = (await page.locator('.fd-lede').boundingBox())!;
  const howTo = (await page.locator('.fd-howto').boundingBox())!;
  expect(howTo.y).toBeGreaterThanOrEqual(lede.y + lede.height - 1);
  expect(ARROWS.exec(await page.locator('.fd-head').innerText())?.[0] ?? null).toBeNull();
  // Without the field (switched off, or no count yet), nothing in the head changes.
  await page.unrouteAll();
  await mockFeed(page);
  await openFeed(page);
  await expect(cards(page).first()).toBeVisible();
  await expect(paidChip(page)).toHaveCount(0);
});

test('the paid service calls chip shows on the public Feed too', async ({ page }) => {
  await mockFeed(page, { paidCalls: 1, baseAgents: 1 });
  await page.goto('/feed');
  await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  const chip = paidChip(page);
  await expect(chip.locator('.fd-paid-n')).toHaveText('1');
  await expect(chip.locator('.fd-paid-label')).toHaveText('paid service call');
  await expect(chip.locator('.fd-base-label')).toHaveText('Base agent');
  const title = (await page.getByRole('heading', { level: 1, name: 'Feed' }).boundingBox())!;
  const box = (await chip.boundingBox())!;
  expect(Math.abs(box.y + box.height / 2 - (title.y + title.height / 2))).toBeLessThan(3);
});

for (const theme of ['light', 'dark'] as const)
  test(`the paid service calls chip at 375 px (${theme}): its own line under the lede, no sideways scroll`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: theme });
    await signIn(page);
    await mockFeed(page, { paidCalls: 1_284_093, baseAgents: 31_452 });
    await openFeed(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const chip = paidChip(page);
    await expect(chip.locator('.fd-paid-n')).toHaveText('1,284,093');
    // The narrow column's short form, on one line.
    await expect(chip.locator('.fd-base-n')).toHaveText('31,452');
    await expect(chip.locator('.fd-paid-long')).toBeHidden();
    // One line, 28 workspace pixels tall.
    expect((await chip.boundingBox())!.height).toBeLessThanOrEqual(29);
    const lede = (await page.locator('.fd-lede').boundingBox())!;
    const box = (await chip.boundingBox())!;
    const howTo = (await page.locator('.fd-howto').boundingBox())!;
    // Under the lede, above "How the Feed works", at the column's left edge.
    expect(box.y).toBeGreaterThanOrEqual(lede.y + lede.height - 1);
    expect(howTo.y).toBeGreaterThanOrEqual(box.y + box.height - 1);
    expect(Math.abs(box.x - lede.x)).toBeLessThan(1.5);
    expect(box.x + box.width).toBeLessThanOrEqual(375 - 15.5);
    expect(
      await page.evaluate(() => {
        const main = document.querySelector('main')!;
        return (
          document.documentElement.scrollWidth <= window.innerWidth &&
          main.scrollWidth <= main.clientWidth
        );
      }),
    ).toBe(true);
    expect((await lowContrast(page, '.fd-head')).low).toEqual([]);
    if (process.env.SHOTS)
      await page.screenshot({ path: `${process.env.SHOTS}/feed-paid-375-${theme}.png` });
  });

for (const width of [375, 390, 1280])
  test(`the paid service calls chip at ${width} px moves nothing below it when it appears`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    await mockFeed(page);
    // The stats answer is held back, then released: the chip's place is kept meanwhile.
    await page.unroute('**/api/public/stats');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/public/stats', async (route) => {
      await gate;
      await route.fulfill({
        json: {
          ai_agents_total: 1,
          updated_at: new Date().toISOString(),
          base_agents: { total: 31_452, as_of: new Date().toISOString() },
          paid_calls: {
            total: 1_284,
            as_of: new Date().toISOString(),
            recent_ms: [],
            recent_complete: true,
          },
        },
      });
    });
    await page.goto('/feed');
    await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
    await expect(page.locator('.fd-head [data-paid-calls-pending]')).toHaveCount(1);
    const before = (await page.locator('.fd-howto').boundingBox())!;
    release();
    await expect(paidChip(page).locator('.fd-paid-n')).toHaveText('1,284');
    await expect(page.locator('.fd-head [data-paid-calls-pending]')).toHaveCount(0);
    const after = (await page.locator('.fd-howto').boundingBox())!;
    expect(after.y).toBe(before.y);
  });

test('signed out: the 404 while the Feed is off, else a read-only Feed whose actions ask for sign-in', async ({
  page,
}) => {
  const name = await signIn(page);
  await page.context().clearCookies();
  await mockFeed(page, { on: false });
  await page.goto('/feed');
  await expect(notFound(page)).toBeVisible();
  await page.unrouteAll();
  const fake = await mockFeed(page);
  // A build with the Feed on (CITY_FEED=1) names the Feed in the first HTML of /feed, for link
  // previews; a build with it off serves the plain app shell there (the same file as /rooms), so
  // nothing a crawler reads names a page that may be the 404. The Feed sets its tab title itself.
  const first = await (await page.request.get('/feed')).text();
  const shell = await (await page.request.get('/rooms')).text();
  if (first === shell) {
    expect(first).not.toContain('Feed · Central City');
  } else {
    expect(first).toContain('<title>Feed · Central City</title>');
    expect(first).toContain('<meta property="og:title" content="Feed · Central City"');
  }
  // Offered, read-only, between the public header and footer: no sign-in wall, no workspace.
  await page.goto('/feed');
  await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
  await expect(cards(page).first()).toBeVisible();
  await expect(page.getByLabel('Account name')).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await expect(page.locator('.cc-header')).toBeVisible();
  await expect(page).toHaveTitle('Feed · Central City');
  await expect(page.getByRole('button', { name: 'Post a request' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in to post' })).toBeVisible();
  await plainText(page);
  // A service opens with everything it says; nothing in it needs an account.
  await cards(page).first().getByRole('button').click();
  await expect(drawer(page).getByRole('button', { name: 'Copy service address' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  // The bar sticks under the public header while the window scrolls.
  await page.evaluate(() => window.scrollTo(0, 1200));
  const header = (await page.locator('.cc-header').boundingBox())!;
  const bar = (await page.locator('.fd-toolbar').boundingBox())!;
  expect(Math.abs(bar.y - (header.y + header.height))).toBeLessThanOrEqual(1);
  await page.evaluate(() => window.scrollTo(0, 0));
  // Searched for: requests can be read and opened; every action is "Sign in to …".
  await page.goto('/feed/requests');
  await expect(requestCards(page)).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Sign in to post' })).toBeVisible();
  await requestCards(page).first().getByRole('button').click();
  const details = drawer(page);
  await expect(details).toContainText('supplier invoices as PDFs');
  await expect(details.getByRole('button', { name: 'Respond', exact: true })).toHaveCount(0);
  await expect(details.getByRole('button', { name: 'Report', exact: true })).toHaveCount(0);
  await expect(details.getByRole('button', { name: /^Copy link/ })).toBeVisible();
  await plainText(page, '[role="dialog"]');
  // With a reply handle, Report asks for sign-in too.
  await expect(details.getByRole('button', { name: 'Sign in to report' })).toBeVisible();
  await details.getByRole('button', { name: 'Sign in to respond' }).click();
  // Sign-in at the same address, naming the action; Back returns to the request as it was.
  await expect(
    page.getByText('Sign in to respond to this request.', { exact: true }),
  ).toBeVisible();
  // The card takes focus (the button that asked is gone), as a page change gives it.
  await expect(page.locator('#main-content')).toBeFocused();
  await expect(page).toHaveURL(/\/feed\/requests\/req_aaaaaaaaaaaaaaaaaaa2$/);
  await expect(page).toHaveTitle('Feed · Central City');
  expect(ARROWS.exec(await page.locator('.auth-v8-card').innerText())?.[0] ?? null).toBeNull();
  await page.goBack();
  await expect(drawer(page).getByRole('button', { name: 'Sign in to respond' })).toBeVisible();
  await drawer(page).getByRole('button', { name: 'Sign in to respond' }).click();
  await page.getByLabel('Account name').fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
  // Signed in, the Feed opens in the workspace at the same address, with the actions.
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page).toHaveURL(/\/feed\/requests\/req_aaaaaaaaaaaaaaaaaaa2$/);
  await expect(page.getByRole('button', { name: 'Respond', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Sign in to/ })).toHaveCount(0);
  // One Close returns to the list: the sign-in's own entry is gone, not left as a copy of the
  // drawer that Close would land on.
  await drawer(page)
    .locator('.fd-d-foot')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/feed\/requests$/);
  await expect(requestCards(page)).toHaveCount(3);
  // Back is not dead either: Forward reopens the drawer, one Back closes it again.
  await page.goForward();
  await expect(drawer(page)).toBeVisible();
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/feed\/requests$/);
  // Nothing was posted, reported or closed on the way.
  expect(fake.posts).toEqual([]);
  expect(fake.reports).toEqual([]);
  expect(fake.closes).toEqual([]);
  // Post a request asks for sign-in too, with its own words.
  await page.context().clearCookies();
  await page.goto('/feed/requests');
  await page.getByRole('button', { name: 'Sign in to post' }).click();
  await expect(
    page.getByText('Sign in or create a free account to post your request.', { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/feed\/requests$/);
  await expect(page.locator('#main-content')).toBeFocused();
  // Back returns to the list as it was, still read-only.
  await page.goBack();
  await expect(page.getByLabel('Account name')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in to post' })).toBeVisible();
  await expect(page).toHaveURL(/\/feed\/requests$/);
});

test('Offered: calm cards with the credit, never Pay, Rate, a picture or an arrow', async ({
  page,
}) => {
  await signIn(page);
  const fake = await mockFeed(page);
  await openFeed(page);
  await expect(page.getByText('Services that agents offer on Base')).toBeVisible();
  await expect(views(page).getByRole('link', { name: /^Offered\W+13 services/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // 13 listed by the sample, minus the risky gift-card one and one of Otto AI's three
  // (two per host per page).
  await expect(cards(page)).toHaveCount(11);
  await expect(countLine(page)).toHaveText('13 services · showing 11');
  // One status question for the whole page: the startup's, which the page and sidebar reuse.
  expect(fake.statusReads).toBe(1);
  await expect(
    views(page).getByRole('link', { name: /^Searched for\W+3 open requests/ }),
  ).toHaveAttribute('href', '/feed/requests');
  await expect(page.locator('.fd-fresh')).toContainText(
    'Updated 12 min ago · Listed by x402 Bazaar',
  );
  await expect(page.locator('.fd-strip')).toContainText(
    'External services listed by x402 Bazaar, not Central City agents.',
  );

  // Every card: the small credit, one button (the card itself), no link, no description.
  for (const card of await cards(page).all()) {
    await expect(card.locator('.fd-xb')).toHaveText('Listed by x402 Bazaar, external service');
    await expect(card.getByRole('button')).toHaveCount(1);
    await expect(card.getByRole('link')).toHaveCount(0);
  }
  const exa = cards(page).filter({ hasText: 'api.exa.ai' });
  await expect(exa.getByRole('heading', { level: 3 })).toHaveText('Exa');
  await expect(exa).toContainText('$0.007');
  await expect(exa).toContainText('5,214 uses');
  await expect(exa).not.toContainText('query');
  await expect(exa).not.toContainText('Search the web');
  const main = page.getByRole('main');
  await expect(main.getByRole('button', { name: /^(Pay|Rate)\b/ })).toHaveCount(0);
  await expect(main.getByRole('link', { name: /^(Pay|Rate)\b/ })).toHaveCount(0);
  await expect(main.locator('img')).toHaveCount(0);
  await expect(cards(page).filter({ hasText: /passport/i })).toHaveCount(0);
  // The avatar palette with white initials, as in My agents; never Central City blue.
  const [background, color] = await exa
    .locator('.fd-av')
    .evaluate((avatar) => [
      getComputedStyle(avatar).backgroundColor,
      getComputedStyle(avatar).color,
    ]);
  expect(PALETTE).toContain(background);
  expect(color).toBe('rgb(255, 255, 255)');
  // Different services in one list never share a colour (the same site keeps one).
  const colours = await cards(page)
    .locator('.fd-av')
    .evaluateAll((avatars) =>
      avatars.map((avatar) => [
        avatar.closest('li')!.querySelector('.fd-meta')!.textContent,
        getComputedStyle(avatar).backgroundColor,
      ]),
    );
  const bySite = new Map(colours.map(([site, colour]) => [site, colour]));
  expect(new Set(bySite.values()).size).toBe(bySite.size);
  // The risky money listing (gift cards) is never drawn, even when an answer carries it.
  await expect(main.getByText('Bitrefill')).toHaveCount(0);
  // One host's repeated title gets its address's last part.
  await expect(main.getByRole('heading', { level: 3, name: /^Otto AI · / })).toHaveCount(2);
  // "All services from this site", in the details, filters the list to it.
  await cards(page).filter({ hasText: 'Otto AI' }).first().getByRole('button').click();
  await expect(drawer(page)).toContainText('1 more from this site');
  await expect(drawer(page)).not.toContainText('not shown in the list');
  await page.locator('details.fd-service-tech:not([open]) > summary').click();
  await drawer(page).getByRole('button', { name: 'All services from this site' }).click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/feed\?host=x402\.ottoai\.services$/);
  await expect(cards(page)).toHaveCount(3);
  await expect(page.locator('.fd-active')).toContainText('Filtered by from x402.ottoai.services');
  await expect(countLine(page)).toHaveText('3 services match');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(cards(page)).toHaveCount(11);
  await plainText(page);

  // Cards | List: one line per service, and the choice stays for Searched for.
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByRole('button', { name: 'List', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(cards(page)).toHaveCount(11);
  await expect(
    page.locator('.fd-rows .fd-row.svc').filter({ hasText: 'api.exa.ai' }),
  ).toContainText('5,214 uses');
  await views(page)
    .getByRole('link', { name: /^Searched for/ })
    .click();
  await expect(page.locator('.fd-rows .fd-row.req')).toHaveCount(3);
  await page.getByRole('button', { name: 'Cards', exact: true }).click();
  await expect(page.locator('.fd-rows .fd-row.req')).toHaveCount(0);
});

test('a Central City listing is credited to Central City on its card, in its details and in the strip', async ({
  page,
}) => {
  await signIn(page);
  const services = sampleServices();
  const hosted = {
    ...services[0],
    source: {
      ...services[0].source,
      name: FEED_HOSTED_SOURCE.name,
      credit: FEED_HOSTED_SOURCE.credit,
      url: FEED_HOSTED_SOURCE.url,
    },
  };
  await mockFeed(page, { services: [hosted, ...services.slice(1)] });
  await openFeed(page);
  await expect(page.locator('.fd-strip')).toContainText(
    'Services listed by x402 Bazaar (external, not Central City agents) and by Central City agents (fee included).',
  );
  const card = cards(page).filter({ hasText: hosted.title }).first();
  await expect(card.locator('.fd-xb')).toHaveText(
    'Listed on Central City, sold by a Central City AI agent',
  );
  // The Bazaar rows keep their credit.
  await expect(
    cards(page).filter({ hasNotText: hosted.title }).first().locator('.fd-xb'),
  ).toHaveText('Listed by x402 Bazaar, external service');
  await card.getByRole('button').click();
  await expect(page.getByRole('dialog')).toContainText('Listed on Central City');
});

test('a card opens its details in a drawer; Escape, Close and the scrim give focus back', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: e2eOrigin() });
  await signIn(page);
  await mockFeed(page);
  await openFeed(page);
  const exa = cards(page).filter({ hasText: 'api.exa.ai' });
  // The whole card is the target: a click on its site line opens it.
  await exa.click({ position: { x: 160, y: 60 } });
  const details = drawer(page);
  await expect(details).toBeVisible();
  await expect(details).toHaveAccessibleName('Exa');
  await expect(details.getByRole('heading', { level: 2, name: 'Exa' })).toBeFocused();
  const technical = details.locator('details.fd-service-tech');
  await expect(technical).not.toHaveAttribute('open', /.*/);
  await expect(details.getByText('External · x402 Bazaar', { exact: true })).toBeVisible();
  await expect(details.locator('.fd-service-stats > div')).toHaveCount(3);
  await technical.locator(':scope > summary').click();
  await expect(details).toContainText(LABEL);
  await expect(details).toContainText('POST https://api.exa.ai/search');
  await expect(details).toContainText('Fixed price per call, in USDC on Base mainnet');
  await expect(details).toContainText('5,214 paid calls by 93 payers in 30 days');
  await expect(details).toContainText('Reported by x402 Bazaar, not measured by Central City');
  await expect(details).toContainText(/Takes query/);
  await expect(details).toContainText('0x6d6E…9192');
  // Paid to: the short address with the full one as its tooltip, and no Copy: sending USDC to it
  // directly buys no call.
  const paidTo = details.locator('dd').filter({ hasText: '0x6d6E…9192' });
  await expect(paidTo.locator('code')).toHaveAttribute('title', /^0x6d6E[0-9a-fA-F]{32}9192$/);
  await expect(paidTo.getByRole('button')).toHaveCount(0);
  await expect(paidTo).toContainText('Sending USDC to it directly does not pay for a call.');
  // How to use it, as information, above Limitations.
  const how = details.getByRole('region', { name: 'How to use it' });
  await expect(how).toContainText('an x402 client and its own Base USDC wallet');
  await expect(how).toContainText('Central City can’t pay it for your agents yet.');
  // The next step first: Copy service address is the primary button.
  const copyAddress = details.getByRole('button', { name: 'Copy service address' });
  await expect(copyAddress).toHaveCount(1);
  await expect(copyAddress).toHaveClass(/\bprimary\b/);
  // Open service is gone (a browser can't call a POST service): with Feed pay off for this
  // person (the test server has no pay routes), the drawer is today's without it, and without
  // any pay action.
  await expect(details.getByRole('link', { name: /^Open service/ })).toHaveCount(0);
  await expect(details.locator('a[href="https://api.exa.ai/search"]')).toHaveCount(0);
  await expect(details).not.toContainText('Payment Required');
  await expect(details.getByRole('button', { name: 'Use with my agent' })).toHaveCount(0);
  await expect(details.getByRole('link', { name: /endpoint|Open site/i })).toHaveCount(0);
  await expect(details.locator('a[href="https://api.exa.ai/"]')).toHaveCount(0);
  await expect(details.getByRole('button', { name: /^Copy link/ })).toBeVisible();
  await copyAddress.click();
  await expect(copyAddress).toHaveAttribute('data-done', 'true');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'https://api.exa.ai/search',
  );
  await expect(details.getByRole('button', { name: /^(Pay|Rate)\b/ })).toHaveCount(0);
  // Raw provider data waits under a closed disclosure.
  const raw = details.locator('details.fd-raw');
  await expect(raw).not.toHaveAttribute('open', /.*/);
  await plainText(page, '.fd-drawer');
  await raw.locator('summary').click();
  await expect(raw.locator('pre').first()).toContainText('"query": "example search query"');
  // The rest of the workspace waits behind it.
  const inert = () =>
    page.locator('main#main-content').evaluate((main) => main.closest('[inert]') !== null);
  expect(await inert()).toBe(true);
  // A click on its text keeps focus in the dialog: Escape still closes it.
  await details.getByText(LABEL).click();
  await expect(details).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await expect(exa.getByRole('button')).toBeFocused();
  expect(await inert()).toBe(false);
  // From the keyboard: Enter and Space open it; Close and the scrim shut it.
  await page.keyboard.press('Enter');
  await expect(drawer(page)).toBeVisible();
  await drawer(page).getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(exa.getByRole('button')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(drawer(page)).toBeVisible();
  await page.locator('.fd-scrim').click({ position: { x: 20, y: 20 } });
  await expect(drawer(page)).toHaveCount(0);

  // A saved link opens the same details as a page.
  await page.goto(`/feed/services/${sampleServices()[0]!.id}`);
  await expect(page.getByRole('heading', { level: 2, name: 'Exa' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText(LABEL);
  await expect(page).toHaveTitle('Exa · Feed · Central City');
  // Offered is the section, not the page shown.
  await expect(views(page).getByRole('link', { name: /^Offered/ })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await page.locator('details.fd-service-tech:not([open]) > summary').click();
  await page.getByRole('button', { name: 'All services from this site' }).click();
  await expect(page).toHaveURL(/\/feed\?host=api\.exa\.ai$/);
  await page.goto(`/feed/services/${sampleServices()[0]!.id}`);
  await page.getByRole('link', { name: 'Back to Offered' }).click();
  await expect(page).toHaveURL(/\/feed$/);
  await expect(cards(page)).toHaveCount(11);

  await page.goto('/feed/services/svc_aaaaaaaaaaaaaaaaaaaa');
  await expect(page.getByText('This service isn’t listed')).toBeVisible();
});

test('a service’s details have its own address: Back closes them and the list stays as it was', async ({
  page,
}) => {
  await signIn(page);
  const fake = await mockFeed(page);
  const exa = sampleServices()[0]!;
  // As on a phone: from Rooms to the Feed, a list sorted by price.
  await page.goto('/rooms');
  await feedEntry(page).click();
  await expect(cards(page)).toHaveCount(11);
  await pickPill(page, 'fd-sort', 'cheapest');
  await expect(page).toHaveURL(/\/feed\?sort=cheapest$/);
  await expect(cards(page)).toHaveCount(11);
  const order = await cards(page).locator('.fd-meta').allTextContents();
  const reads = fake.serviceReads.length;

  const card = cards(page).filter({ hasText: 'api.exa.ai' });
  await card.getByRole('button').click();
  await expect(drawer(page)).toHaveAccessibleName('Exa');
  // The address is the service's own (the one Copy link gives); the list waits behind, unread.
  await expect(page).toHaveURL(new RegExp(`/feed/services/${exa.id}$`));
  await expect(page).toHaveTitle('Exa · Feed · Central City');
  await expect(cards(page)).toHaveCount(11);
  expect(fake.serviceReads.length).toBe(reads);
  await expect(views(page).getByRole('link', { name: /^Offered/ })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Back closes the drawer and stays in the Feed, on the same list, with focus on the card.
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/feed\?sort=cheapest$/);
  await expect(card.getByRole('button')).toBeFocused();
  await expect(page).toHaveTitle('Feed · Central City');
  expect(await cards(page).locator('.fd-meta').allTextContents()).toEqual(order);
  expect(fake.serviceReads.length).toBe(reads);
  // Forward opens it again.
  await page.goForward();
  await expect(drawer(page)).toHaveAccessibleName('Exa');
  await expect(page).toHaveURL(new RegExp(`/feed/services/${exa.id}$`));

  // Close and Escape step back too, once each: the next Back leaves the Feed for Rooms.
  await drawer(page).getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/feed\?sort=cheapest$/);
  await card.getByRole('button').click();
  await expect(page).toHaveURL(new RegExp(`/feed/services/${exa.id}$`));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/feed\?sort=cheapest$/);
  await expect(cards(page)).toHaveCount(11);
  await page.goBack();
  await expect(page).toHaveURL(/\/rooms$/);
  await page.goForward();
  await expect(cards(page)).toHaveCount(11);

  // A reload keeps the drawer over its list.
  await card.getByRole('button').click();
  await page.reload();
  await expect(drawer(page)).toHaveAccessibleName('Exa');
  await expect(page).toHaveURL(new RegExp(`/feed/services/${exa.id}$`));
  await expect(page.locator('#fd-sort')).toHaveAttribute('data-value', 'cheapest');
  // A list that no longer holds it after a reload: the service's own page shows instead.
  await page.unrouteAll();
  await mockFeed(page, { services: sampleServices().slice(1) });
  await page.reload();
  await expect(page.getByText('This service isn’t listed')).toBeVisible();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/feed/services/${exa.id}$`));
});

test('All services from this site: every one of them, without the search', async ({ page }) => {
  await signIn(page);
  await mockFeed(page);
  await openFeed(page, '/feed?q=whois');
  await expect(cards(page)).toHaveCount(1);
  await cards(page).first().getByRole('button').click();
  await expect(drawer(page)).toContainText('2 more from this site');
  await page.locator('details.fd-service-tech:not([open]) > summary').click();
  await drawer(page).getByRole('button', { name: 'All services from this site' }).click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/feed\?host=x402\.ottoai\.services$/);
  await expect(cards(page)).toHaveCount(3);
  await expect(page.locator('.fd-active')).toHaveText(/^Filtered by from x402\.ottoai\.services/);
  await expect(page.getByRole('searchbox', { name: 'Search services' })).toHaveValue('');
  await expect(countLine(page)).toBeFocused();
  // Back returns to the search it came from.
  await page.goBack();
  await expect(page).toHaveURL(/\/feed\?q=whois$/);
  await expect(cards(page)).toHaveCount(1);

  // In one site's own list, its details don't speak of more not shown (Load more has them).
  await openFeed(page, '/feed?q=whois&host=x402.ottoai.services');
  await expect(cards(page)).toHaveCount(1);
  await cards(page).first().getByRole('button').click();
  await expect(drawer(page)).toContainText('x402.ottoai.services');
  await expect(drawer(page)).not.toContainText('more from this site');
  await drawer(page).locator('.fd-service-tech > summary').click();
  await expect(
    drawer(page).getByRole('button', { name: 'All services from this site' }),
  ).toBeVisible();
});

test('filters go into the address; an empty result names them and broadens nothing', async ({
  page,
}) => {
  const fake = await mockFeed(page);
  await signIn(page);
  await openFeed(page);
  await pickPill(page, 'fd-max', '0.001');
  await expect(page).toHaveURL(/\/feed\?max_price=0\.001$/);
  await expect(cards(page)).toHaveCount(2);
  expect(fake.serviceReads.at(-1)?.searchParams.get('max_price')).toBe('0.001');
  await pickPill(page, 'fd-max', '');
  await expect(cards(page)).toHaveCount(11);

  await pickPill(page, 'fd-sort', 'cheapest');
  await expect(page).toHaveURL(/\/feed\?sort=cheapest$/);
  await expect(cards(page).first()).toContainText('$0.001');
  // Relevance needs words.
  await page.locator('#fd-sort').click();
  await expect(page.locator('#fd-sort-list [data-value="relevance"]')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('#fd-sort-list')).toHaveCount(0);

  // Typing searches once it pauses; Enter at once.
  const search = page.getByRole('searchbox', { name: 'Search services' });
  await search.fill('search tweets');
  await expect(page).toHaveURL(/\/feed\?q=search\+tweets&sort=cheapest$/);
  await search.fill('weather on mars');
  await search.press('Enter');
  await expect(page).toHaveURL(/\/feed\?q=weather\+on\+mars&sort=cheapest$/);
  await expect(page.getByText('No service matches “weather on mars”')).toBeVisible();
  // Nothing was asked without the words: the empty answer stays empty.
  expect(fake.serviceReads.at(-1)?.searchParams.get('q')).toBe('weather on mars');
  await page.getByRole('button', { name: 'Post it as a request' }).click();
  await expect(page).toHaveURL(/\/feed\/requests$/);
  await expect(page.getByLabel('What do you need?')).toHaveValue('Weather on mars');
  await expect(page.getByLabel(/^Details/)).toBeFocused();
});

test('Load more adds the next page; a stale cursor starts again from the top', async ({ page }) => {
  await signIn(page);
  await spyFeedReads(page);
  const fake = await mockFeed(page, { pageSize: 4, staleCursorOnce: true });
  await openFeed(page);
  await expect(cards(page)).toHaveCount(4);
  // An ordinary read may come from the browser's cache.
  expect(await lastFirstPageCache(page, '/api/public/feed/services')).toBeNull();
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByText('The list was refreshed while you read it')).toBeVisible();
  await expect(cards(page)).toHaveCount(4);
  // Page 1 again, past the browser's cache (the list may be kept for a minute), and focus on the
  // list's heading (the Load more that was pressed went away meanwhile).
  expect(await lastFirstPageCache(page, '/api/public/feed/services')).toBe('no-store');
  // ...and past the edge, which no-store doesn't reach: a throwaway parameter (api-4).
  const firstPages = fake.serviceReads.filter((url) => !url.searchParams.has('cursor'));
  expect(firstPages[0]!.searchParams.has('fresh')).toBe(false);
  expect(firstPages.at(-1)!.searchParams.get('fresh')).toMatch(/^\d+$/);
  await expect(countLine(page)).toBeFocused();
  await page.getByRole('button', { name: 'Load more' }).click();
  // Page 2 carries the risky gift-card listing, which is never drawn: 4 + 3.
  await expect(cards(page)).toHaveCount(7);
  // The pages line up again: the note about the refresh is gone (client-11).
  await expect(page.getByText('The list was refreshed while you read it')).toHaveCount(0);
  // Reading goes on at the first new card.
  await expect(cards(page).nth(4).getByRole('button')).toBeFocused();
});

test('a delayed source says so; before the first read the Feed says it can’t list anything', async ({
  page,
}) => {
  await signIn(page);
  await mockFeed(page, { freshness: degraded() });
  await openFeed(page);
  const banner = page.getByRole('status').filter({ hasText: 'Source refresh delayed' }).first();
  await expect(banner).toContainText('x402 Bazaar hasn’t answered since');
  await expect(banner).toContainText('(2 days ago). Prices and paid calls may have changed');
  await expect(page.locator('.fd-fresh')).toContainText('Source refresh delayed · last refreshed');
  await expect(cards(page)).toHaveCount(11);

  await page.unrouteAll();
  await spyFeedReads(page);
  await mockFeed(page, {
    servicesFailure: { status: 503, code: 'source_unavailable' },
    servicesFailureTimes: 1,
  });
  await openFeed(page);
  const alert = page.getByRole('alert').filter({ hasText: 'The Feed couldn’t be loaded' });
  await expect(alert).toContainText('x402 Bazaar hasn’t been read yet');
  await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  // Try again reads past the browser's cache, and focus goes to the list's heading.
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(cards(page)).toHaveCount(11);
  expect(await lastFirstPageCache(page, '/api/public/feed/services')).toBe('no-store');
  await expect(countLine(page)).toBeFocused();
});

test('a search whose typing pause ends while a drawer is open waits for it to close', async ({
  page,
}) => {
  await signIn(page);
  await mockFeed(page);
  await openFeed(page, '/feed/requests');
  await expect(requestCards(page)).toHaveCount(3);
  await page.getByRole('searchbox', { name: 'Search requests' }).pressSequentially('invoices');
  // A card clicked within the pause: the drawer keeps its own entry and address.
  await requestCards(page).first().getByRole('button').click();
  await expect(drawer(page)).toBeVisible();
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(/\/feed\/requests\/req_aaaaaaaaaaaaaaaaaaa2$/);
  await expect(drawer(page)).toBeVisible();
  // One Close leaves it, and the search then applies to the list.
  await drawer(page)
    .locator('.fd-d-foot')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/feed\/requests\?q=invoices$/);
});

test('a filter chosen while typing pauses is kept when the search applies', async ({ page }) => {
  await signIn(page);
  const fake = await mockFeed(page);
  await openFeed(page);
  const search = page.getByRole('searchbox', { name: 'Search services' });
  await search.pressSequentially('pdf');
  // Within the pause: a price is chosen; the search that applies after it keeps it.
  await pickPill(page, 'fd-max', '0.05');
  await expect(page).toHaveURL(/\/feed\?q=pdf&max_price=0\.05$/);
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(/\/feed\?q=pdf&max_price=0\.05$/);
  expect(fake.serviceReads.at(-1)?.searchParams.get('max_price')).toBe('0.05');

  await page.goto('/feed/requests');
  const requests = page.getByRole('searchbox', { name: 'Search requests' });
  await requests.pressSequentially('pdf');
  await pickPill(page, 'fd-tag', 'pdf');
  await expect(page).toHaveURL(/\/feed\/requests\?q=pdf&tag=pdf$/);
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(/\/feed\/requests\?q=pdf&tag=pdf$/);
});

test('filters from the address bar: plain text, and a tag the contract can’t read is dropped', async ({
  page,
}) => {
  await signIn(page);
  const fake = await mockFeed(page);
  await openFeed(page, `/feed/requests?q=${encodeURIComponent('pdf\u202E\u200B')}&tag=-bad-`);
  await expect(page.getByRole('searchbox', { name: 'Search requests' })).toHaveValue('pdf');
  await expect(requestCards(page).first()).toBeVisible();
  const read = fake.requestReads.at(-1)!;
  expect(read.searchParams.get('q')).toBe('pdf');
  expect(read.searchParams.has('tag')).toBe(false);
  await expect(page.locator('#fd-tag')).toHaveAttribute('data-value', '');
});

test('Searched for: poster, title, budget and time left; Respond, in the details, leads to a room', async ({
  page,
}) => {
  await signIn(page);
  await mockFeed(page);
  await openFeed(page);
  await views(page)
    .getByRole('link', { name: /^Searched for/ })
    .click();
  await expect(page).toHaveURL(/\/feed\/requests$/);
  await expect(page).toHaveTitle('Searched for · Feed · Central City');
  await expect(requestCards(page)).toHaveCount(3);
  await expect(countLine(page)).toHaveText('3 open requests');
  const [invoices, alerts, italian] = [0, 1, 2].map((index) => requestCards(page).nth(index));
  await expect(invoices!.getByRole('heading', { level: 3 })).toHaveText(
    'Summarise 40 PDF invoices into one table',
  );
  // A card: the poster, the title, and two chips; nothing else.
  await expect(invoices!.locator('.fd-chip')).toHaveText([
    'Budget $25.00',
    // Whole days, as the details count them (just under 5 days).
    'Time left: 4 days',
  ]);
  await expect(invoices!).toContainText('Anonymous');
  await expect(invoices!).not.toContainText('supplier invoices as PDFs');
  await expect(invoices!.getByRole('button')).toHaveCount(1);
  await expect(alerts!.locator('.fd-chip')).toHaveText(['Open budget', 'No deadline']);
  await expect(alerts!).toContainText('Mara');
  await expect(italian!).toContainText('Ledger Scout');
  // Signed-out posters are marked "Unverified", agents "Agent", an account neither.
  await expect(invoices!.locator('.fd-who')).toHaveText('Unverified');
  await expect(alerts!.locator('.fd-who')).toHaveText('Unverified');
  await expect(italian!.locator('.fd-who')).toHaveText('Agent');
  // Budgets in cents. Posted by an agent (signed in), it is answered with an invitation to a room
  // even without a reply handle (Feed Respond): no "No reply handle" chip, and Respond in the
  // details. A request posted signed out without one can't be answered (tests/feed-ui.test.ts B6
  // and U2, tests/feed-respond-ui.test.ts).
  await expect(italian!.locator('.fd-chip')).toHaveText(['Budget $7.50', 'No deadline']);
  await italian!.getByRole('button').click();
  await expect(drawer(page)).toContainText(
    'Respond invites the poster to one of your rooms. You agree on the work there.',
  );
  await expect(drawer(page)).not.toContainText('can’t be reached');
  await expect(drawer(page).getByRole('button', { name: 'Respond' })).toBeVisible();
  await expect(drawer(page).getByRole('button', { name: 'Report' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  // A tag shows only requests with it.
  await pickPill(page, 'fd-tag', 'pdf');
  await expect(page).toHaveURL(/\/feed\/requests\?tag=pdf$/);
  await expect(requestCards(page)).toHaveCount(1);
  // The details: budget, deadline, what they need, the handle as unverified text.
  await requestCards(page).first().getByRole('button').click();
  const details = drawer(page);
  await expect(details.getByRole('heading', { level: 2 })).toBeFocused();
  // Its own address over the list, and the tab names it.
  await expect(page).toHaveURL(/\/feed\/requests\/req_aaaaaaaaaaaaaaaaaaa2$/);
  await expect(page).toHaveTitle('Summarise 40 PDF invoices into one table · Feed · Central City');
  await expect(details).toContainText('$25.00');
  await expect(details).toContainText('in total, in USDC');
  await expect(details).toContainText(/By [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}/);
  await expect(details).toContainText('4 days left');
  await expect(details).toContainText('Anonymous · No account · 2 h ago');
  await expect(details).toContainText('supplier invoices as PDFs');
  await expect(details.getByRole('button', { name: /^Copy link/ })).toBeVisible();
  // Respond: the handle as text, unverified, and the way into a room.
  await details.getByRole('button', { name: 'Respond' }).click();
  const respond = details.getByRole('region', { name: 'Reach the poster' });
  await expect(respond).toContainText('Base address');
  await expect(respond).toContainText('0x1111111111111111111111111111111111111111');
  await expect(respond).toContainText('unverified, given by the poster');
  await expect(respond.locator('a[href^="0x"], a[href^="https://example"]')).toHaveCount(0);
  // A Base address reaches only a Central City agent, by its passport (looked up in the Agent
  // Explorer, the name its page and the Feed guide use).
  await expect(respond).toContainText(
    'If this is a Central City agent’s wallet, look it up in the Agent Explorer',
  );
  await expect(respond).toContainText(
    'and invite that agent to your room by its passport. Other Base addresses can’t receive messages.',
  );
  await expect(respond.getByRole('link', { name: /^Agent Explorer/ })).toHaveAttribute(
    'href',
    '/explorer/base',
  );
  await expect(respond).not.toContainText('Send the poster the room link');
  await plainText(page, '.fd-drawer');
  await details.getByRole('button', { name: 'Back' }).click();
  await expect(details.getByRole('button', { name: 'Respond' })).toBeVisible();
  // Escape closes it and returns to the card.
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await expect(requestCards(page).first().getByRole('button')).toBeFocused();
  // A link handle: send the room link, which lasts a day.
  await pickPill(page, 'fd-tag', '');
  await expect(requestCards(page)).toHaveCount(3);
  await requestCards(page).nth(1).getByRole('button').click();
  await drawer(page).getByRole('button', { name: 'Respond' }).click();
  await expect(drawer(page)).toContainText('Send the poster the room link by their reply handle.');
  await expect(drawer(page)).toContainText(
    'Room links expire after 24 hours. Make a new one if the poster answers later.',
  );
  await page.keyboard.press('Escape');
  // "Start a room" opens New room filled in with the request; the person still creates it.
  await requestCards(page).first().getByRole('button').click();
  await drawer(page).getByRole('button', { name: 'Respond' }).click();
  await drawer(page).getByRole('link', { name: 'Start a room' }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await expect(sidebar(page)).toBeVisible();
  const sheet = page.getByRole('dialog', { name: 'New room' });
  await expect(sheet.getByLabel('Room name')).toHaveValue(
    'Summarise 40 PDF invoices into one table',
  );
  const topic = `Feed request: Summarise 40 PDF invoices into one table · ${new URL(page.url()).origin}/feed/requests/req_aaaaaaaaaaaaaaaaaaa2`;
  await expect(sheet.getByLabel('Topic')).toHaveValue(topic);
  await sheet.getByLabel("Your AI's name").fill('Scout');
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/rooms' && response.request().method() === 'POST',
  );
  await sheet.getByRole('button', { name: 'Create room' }).click();
  const answer = await created;
  expect(answer.request().postDataJSON()).toMatchObject({
    name: 'Summarise 40 PDF invoices into one table',
    topic,
  });
  expect(((await answer.json()) as { room: { topic: string } }).room.topic).toBe(topic);
  await expect(page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);
  // Back to the request's drawer, then Back again closes it: the list stays as it was.
  await page.goBack();
  await page.goBack();
  await expect(drawer(page)).toBeVisible();
  await expect(page).toHaveURL(/\/feed\/requests\/req_aaaaaaaaaaaaaaaaaaa2$/);
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/feed\/requests$/);
  await expect(requestCards(page)).toHaveCount(3);

  // One request's own page, and one that is gone.
  await page.goto('/feed/requests/req_bbbbbbbbbbbbbbbbbbb3');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Daily Base gas price alert' }),
  ).toBeVisible();
  await expect(page).toHaveTitle('Daily Base gas price alert · Feed · Central City');
  await page.goto('/feed/requests/req_zzzzzzzzzzzzzzzzzzzz');
  await expect(page.getByText('This request isn’t listed')).toBeVisible();
});

test('posting as yourself: checks first, then the private link once, then closing it', async ({
  page,
}) => {
  const fake = await mockFeed(page);
  const name = await signIn(page);
  await openFeed(page, '/feed/requests');
  await page.getByRole('button', { name: 'Post a request' }).click();
  const form = page.getByRole('form', { name: 'Post a request' });
  await expect(form.getByLabel('What do you need?')).toBeFocused();
  await expect(form).toContainText('Everything here is public.');
  await expect(form.getByLabel('Post as')).toHaveValue('');
  // The server posts an account without its name (postedBy.displayName null): the form says so.
  await expect(form.getByLabel('Post as').locator('option').first()).toHaveText(
    'Me (no name shown)',
  );
  await expect(form.getByLabel('Post as')).toHaveAccessibleDescription(
    'Posted from your account without your name. An agent posts under its own name.',
  );
  await expect(form).not.toContainText(name);
  await expect(form).toContainText('Posted from your account.');
  // Signed in, the account's caps apply (not the signed-out ones).
  await expect(form).toContainText('Up to 30 requests an hour and 100 a day.');
  await form.getByRole('button', { name: 'Post request' }).click();
  const summary = summaryOf(form);
  await expect(summary).toContainText('Check 2 fields');
  await expect(summary).toBeFocused();
  await expect(summary).toContainText('What do you need? Add a title of at least 5 characters.');
  await expect(summary).toContainText('Details: Say in a few words what you need.');
  await expect(form.getByLabel('What do you need?')).toHaveAttribute('aria-invalid', 'true');
  expect(fake.posts).toHaveLength(0);
  // Following a summary link and typing a fix, key by key: focus stays in the field.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(form.getByLabel('What do you need?')).toBeFocused();
  await page.keyboard.type('Check');
  await expect(form.getByLabel('What do you need?')).toHaveValue('Check');
  await expect(form.getByLabel('What do you need?')).toBeFocused();
  await expect(summary).toContainText('Check one field');

  await form.getByLabel('What do you need?').fill('Check 200 links on our docs site');
  await form.getByLabel(/^Details/).fill('Report every broken link with the page it is on.');
  await form.getByLabel(/^Budget/).fill('12.5');
  // Tags are split on commas only: "link checking" is one tag.
  await form.getByLabel(/^Tags/).fill('link checking, docs');
  await form.getByLabel(/^Reply handle/).fill('ada@example.com');
  await form.getByRole('button', { name: 'Post request' }).click();
  await expect(summaryOf(form)).toContainText(
    'Reply handle: Use a Base address (0x and 40 characters) or a link that starts with https://.',
  );
  await expect(summaryOf(form)).toBeFocused();
  // A Central City link is refused before sending, with the reason.
  await form.getByLabel(/^Reply handle/).fill('https://centralcity.ai/r/launch-room');
  await form.getByRole('button', { name: 'Post request' }).click();
  await expect(summaryOf(form)).toContainText(
    'Reply handle: Only Central City result and agent links can be a reply handle. Use a Base address or another https page.',
  );
  expect(fake.posts).toHaveLength(0);
  await form.getByLabel(/^Reply handle/).fill('https://example.com/ada');
  await form.getByRole('button', { name: 'Post request' }).click();

  const done = page.getByRole('region', { name: 'Your request is live' });
  await expect(done.getByRole('heading', { name: 'Your request is live' })).toBeFocused();
  await expect(done).toContainText('“Check 200 links on our docs site” is in Searched for now');
  await expect(done.locator('code')).toHaveText(
    new RegExp(`/feed/requests/req_ddddddddddddddddddd5/manage#${MANAGE_CODE}$`),
  );
  await expect(done).toContainText('Shown once.');
  expect(fake.posts).toHaveLength(1);
  const sent = fake.posts[0]!;
  expect(sent).toMatchObject({
    title: 'Check 200 links on our docs site',
    budgetUsdc: '12.5',
    capabilities: ['link-checking', 'docs'],
    reply: 'https://example.com/ada',
    agentId: null,
  });
  expect(sent.idempotencyKey.length).toBeGreaterThanOrEqual(8);
  // A person never fills the hidden field, and the server names the poster.
  expect('website' in sent).toBe(false);
  expect('displayName' in sent).toBe(false);
  expect(fake.postHeaders[0]!['x-city-request']).toBe('1');
  // The new request is at the top as yours, and the count follows.
  const mine = requestCards(page).first();
  await expect(mine).toContainText('Check 200 links on our docs site');
  await expect(mine).toContainText('Yours');
  await expect(mine.locator('.fd-chip').first()).toHaveText('Budget $12.50');
  // An account's request names its kind, never "Anonymous" and never the sign-in name.
  await expect(mine.locator('.fd-rp')).toContainText('Central City account');
  await expect(mine).not.toContainText('Anonymous');
  await expect(mine).not.toContainText(name);
  await expect(views(page).getByRole('link', { name: /^Searched for\W+4/ })).toBeVisible();
  await plainText(page);
  // Its details: Copy link and Close request, never Respond or Report.
  await mine.getByRole('button').click();
  await expect(drawer(page).locator('.fd-d-sub')).toHaveText(
    /^Central City account · (just now|1 min ago)$/,
  );
  await expect(drawer(page).getByRole('button', { name: 'Respond' })).toHaveCount(0);
  await expect(drawer(page).getByRole('button', { name: 'Report' })).toHaveCount(0);
  await drawer(page).getByRole('button', { name: 'Close request' }).click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/feed\/requests$/);
  await expect(requestCards(page)).toHaveCount(3);
  await expect(countLine(page)).toBeFocused();
  await expect(views(page).getByRole('link', { name: /^Searched for\W+3/ })).toBeVisible();
  expect(fake.closes).toEqual([
    { id: 'req_ddddddddddddddddddd5', body: { manageToken: MANAGE_CODE } },
  ]);
});

/** Opens the form and fills the two fields every request needs. */
async function startRequest(page: Page, title: string, details: string) {
  await page.getByRole('button', { name: 'Post a request' }).click();
  const form = page.getByRole('form', { name: 'Post a request' });
  await form.getByLabel('What do you need?').fill(title);
  await form.getByLabel(/^Details/).fill(details);
  return form;
}

test('refused posts: the server’s own sentence, and the cap on open requests', async ({ page }) => {
  await signIn(page);
  const sentence = 'This request is already on the Feed.';
  await mockFeed(page, {
    postFailure: { status: 400, code: 'invalid_request', error: sentence },
  });
  await openFeed(page, '/feed/requests');
  const form = await startRequest(page, 'Check 200 links on our docs', 'Every broken one.');
  await form.getByRole('button', { name: 'Post request' }).click();
  await expect(summaryOf(form)).toBeFocused();
  await expect(summaryOf(form)).toContainText("Something in this form isn't right.");
  await expect(summaryOf(form)).toContainText(sentence);
  await plainText(page);

  // Text that reads like code never shows: the plain words instead.
  await page.unrouteAll();
  await mockFeed(page, {
    postFailure: {
      status: 400,
      code: 'invalid_request',
      error: 'Send {title, description, idempotencyKey} and optionally capabilities.',
    },
  });
  await openFeed(page, '/feed/requests');
  const again = await startRequest(page, 'Check 200 links on our docs', 'Every broken one.');
  await again.getByRole('button', { name: 'Post request' }).click();
  await expect(summaryOf(again)).toContainText('Check it and try again.');
  await plainText(page);

  // A 429 without Retry-After is the cap on open requests.
  await page.unrouteAll();
  await mockFeed(page, {
    postFailure: {
      status: 429,
      error: 'At most 5 open requests at a time. Close one, or wait until one expires.',
    },
  });
  await openFeed(page, '/feed/requests');
  const capped = await startRequest(page, 'Weekly summary of Base news', 'Five bullet points.');
  await capped.getByRole('button', { name: 'Post request' }).click();
  await expect(summaryOf(capped)).toBeFocused();
  await expect(summaryOf(capped)).toHaveText('You have too many open requests.Close one first.');
});

test('a lost answer is sent again with the same key; edited text gets a new key', async ({
  page,
}) => {
  await signIn(page);
  const fake = await mockFeed(page, { lostPosts: 2 });
  await openFeed(page, '/feed/requests');
  const form = await startRequest(page, 'Check 200 links on our docs', 'Every broken one.');
  await form.getByRole('button', { name: 'Post request' }).click();
  await expect(summaryOf(form)).toContainText("We couldn't reach Central City.");
  await form.getByRole('button', { name: 'Post request' }).click();
  await expect.poll(() => fake.posts.length).toBe(2);
  // The same request, so the same key: a lost answer is never posted twice.
  expect(fake.posts[1]!.idempotencyKey).toBe(fake.posts[0]!.idempotencyKey);
  await form.getByLabel(/^Details/).fill('Every broken one, with the page it is on.');
  await form.getByRole('button', { name: 'Post request' }).click();
  await expect(page.getByRole('heading', { name: 'Your request is live' })).toBeFocused();
  expect(fake.posts).toHaveLength(3);
  // Edited text is a new request: a new key (the old one is refused for other text, for good).
  expect(fake.posts[2]!.idempotencyKey).not.toBe(fake.posts[0]!.idempotencyKey);
});

test('a session that ended mid-page is named: the request was not posted from the account', async ({
  page,
}) => {
  await signIn(page);
  await mockFeed(page, { sessionLapsed: true });
  await openFeed(page, '/feed/requests');
  const form = await startRequest(page, 'Check 200 links on our docs', 'Every broken one.');
  await expect(form).toContainText('Posted from your account.');
  await form.getByRole('button', { name: 'Post request' }).click();
  const done = page.getByRole('region', { name: 'Your request is live' });
  await expect(done).toContainText('You were signed out, so it wasn’t posted from your account');
  await expect(done).toContainText('Only your private link can close it.');
  await expect(done.locator('code')).toContainText(`manage#${MANAGE_CODE}`);
});

test('a request closed already counts as closed: it leaves Yours and the count', async ({
  page,
}) => {
  await signIn(page);
  const fake = await mockFeed(page, { closedElsewhere: true });
  await openFeed(page, '/feed/requests');
  const form = await startRequest(page, 'Check 200 links on our docs', 'Every broken one.');
  await form.getByRole('button', { name: 'Post request' }).click();
  await page.getByRole('button', { name: 'See your request' }).click();
  await expect(views(page).getByRole('link', { name: /^Searched for\W+4/ })).toBeVisible();
  await requestCards(page).first().getByRole('button').click();
  await drawer(page).getByRole('button', { name: 'Close request' }).click();
  await expect(drawer(page)).toHaveCount(0);
  expect(fake.closes).toHaveLength(1);
  await expect(page.getByText('Yours', { exact: true })).toHaveCount(0);
  await expect(requestCards(page)).toHaveCount(3);
  await expect(views(page).getByRole('link', { name: /^Searched for\W+3/ })).toBeVisible();
  await expect(countLine(page)).toBeFocused();
});

test('signing out forgets the private close tokens and Yours', async ({ page }) => {
  const name = await signIn(page);
  await mockFeed(page);
  await openFeed(page, '/feed/requests');
  const form = await startRequest(page, 'Check 200 links on our docs', 'Every broken one.');
  await form.getByRole('button', { name: 'Post request' }).click();
  await page.getByRole('button', { name: 'See your request' }).click();
  await expect(requestCards(page).first()).toContainText('Yours');
  // Sign out and back in within this page load (no reload, which would forget anyway).
  await openAccountMenu(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Account name').fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await feedEntry(page).click();
  await views(page)
    .getByRole('link', { name: /^Searched for/ })
    .click();
  await expect(requestCards(page).first()).toBeVisible();
  await expect(page.getByText('Yours', { exact: true })).toHaveCount(0);
  // The request is still listed, as anyone's: no Close request in its details.
  await requestCards(page).first().getByRole('button').click();
  await expect(drawer(page).getByRole('button', { name: 'Close request' })).toHaveCount(0);
});

test('posting as one of your agents: the agent is named, never typed in', async ({ page }) => {
  await signIn(page);
  const agent = await addAgent(page, 'Ledger Helper');
  const fake = await mockFeed(page, { agentNames: { [agent.id]: agent.name } });
  await openFeed(page, '/feed/requests');
  // A tag filter is on: the new request doesn't match it.
  await pickPill(page, 'fd-tag', 'pdf');
  await expect(page).toHaveURL(/\/feed\/requests\?tag=pdf$/);
  await page.getByRole('button', { name: 'Post a request' }).click();
  const form = page.getByRole('form', { name: 'Post a request' });
  await expect(
    form.getByLabel('Post as').locator('option', { hasText: 'Ledger Helper' }),
  ).toHaveCount(1);
  await form.getByLabel('Post as').selectOption({ label: 'Ledger Helper' });
  await expect(form).toContainText('Posted as Ledger Helper, your agent.');
  await form.getByLabel('What do you need?').fill('Weekly gas price summary');
  await form.getByLabel(/^Details/).fill('Every Monday, the cheapest hour on Base last week.');
  await form.getByRole('button', { name: 'Post request' }).click();
  await expect(page.getByRole('heading', { name: 'Your request is live' })).toBeVisible();
  expect(fake.posts[0]!.agentId).toBe(agent.id);
  // "See your request" clears the filter and waits for the list before it moves focus there.
  await page.getByRole('button', { name: 'See your request' }).click();
  await expect(page).toHaveURL(/\/feed\/requests$/);
  const mine = requestCards(page).first();
  await expect(mine.getByRole('button')).toBeFocused();
  await expect(mine).toContainText('Ledger Helper');
  await mine.getByRole('button').click();
  await expect(drawer(page)).toContainText(
    'Ledger Helper · Central City AI agent · name not verified',
  );
});

test('a held request is in review and not listed; too many posts says when to try again', async ({
  page,
}) => {
  await signIn(page);
  await mockFeed(page, { holdPosts: true });
  await openFeed(page, '/feed/requests');
  await page.getByRole('button', { name: 'Post a request' }).click();
  const form = page.getByRole('form', { name: 'Post a request' });
  await form.getByLabel('What do you need?').fill('Buy 50 prepaid cards for our team');
  await form.getByLabel(/^Details/).fill('Any shop is fine.');
  await form.getByRole('button', { name: 'Post request' }).click();
  const review = page.getByRole('region', { name: 'Your request is in review' });
  await expect(review).toContainText(
    'is in review and isn’t listed in Searched for. A request still in review after 7 days is deleted.',
  );
  await expect(review).not.toContainText('once we have looked');
  await expect(review.locator('code')).toContainText(`manage#${MANAGE_CODE}`);
  await expect(review.getByRole('button', { name: 'See your request' })).toHaveCount(0);
  await expect(requestCards(page)).toHaveCount(3);
  await expect(page.getByText('Yours', { exact: true })).toHaveCount(0);
  await expect(views(page).getByRole('link', { name: /^Searched for\W+3/ })).toBeVisible();

  await page.unrouteAll();
  const fake = await mockFeed(page, {
    postFailure: { status: 429, code: 'rate_limited', retryAfterSeconds: 1200 },
  });
  await openFeed(page, '/feed/requests');
  await page.getByRole('button', { name: 'Post a request' }).click();
  const again = page.getByRole('form', { name: 'Post a request' });
  await again.getByLabel('What do you need?').fill('Weekly summary of Base news');
  await again.getByLabel(/^Details/).fill('Five bullet points every Monday.');
  await again.getByRole('button', { name: 'Post request' }).click();
  const alert = summaryOf(again);
  await expect(alert).toBeFocused();
  await expect(alert).toContainText(
    'Too many requests were posted from your account or network recently.',
  );
  await expect(alert).toContainText('Try again in about 20 minutes.');
  expect(fake.posts).toHaveLength(1);
});

test('Report: a reason, then thanks', async ({ page }) => {
  await signIn(page);
  const fake = await mockFeed(page);
  await openFeed(page, '/feed/requests');
  await requestCards(page).nth(1).getByRole('button').click();
  await drawer(page).getByRole('button', { name: 'Report' }).click();
  const form = page.getByRole('form', { name: 'Report this request' });
  await expect(drawer(page).getByRole('heading', { name: 'Report this request' })).toBeFocused();
  await form.getByRole('button', { name: 'Send report' }).click();
  await expect(form.getByRole('alert')).toHaveText('Pick a reason.');
  await expect(form.getByRole('radio', { name: 'Spam' })).toBeFocused();
  await expect(form.getByRole('radio', { name: 'Spam' })).toHaveAttribute('aria-invalid', 'true');
  await form.getByRole('radio', { name: 'Spam' }).check();
  await form.getByLabel(/^Note for our team/).fill('Posted five times today.');
  await expect(form).toContainText('24/280');
  // What a report does, and no promise of a review (no review queue is live yet).
  await expect(form).toContainText(
    'Enough reports hide it from the lists. The poster isn’t told who reported it.',
  );
  await expect(form).not.toContainText('until we check');
  await form.getByRole('button', { name: 'Send report' }).click();
  const thanks = drawer(page)
    .getByRole('status')
    .filter({ hasText: 'Thanks, your report was sent.' });
  await expect(thanks).not.toContainText('take a look');
  await expect(thanks).toContainText(
    'Enough reports hide it from the lists. The poster isn’t told who reported it.',
  );
  await expect(thanks).not.toContainText('until we check');
  await expect(thanks).toBeVisible();
  // The thanks takes focus: the button that sent the report is gone.
  await expect(thanks).toBeFocused();
  expect(fake.reports).toEqual([
    { id: 'req_bbbbbbbbbbbbbbbbbbb3', body: { reason: 'spam', note: 'Posted five times today.' } },
  ]);
});

test('the private link closes the request; its token leaves the address bar at once', async ({
  page,
}) => {
  await signIn(page);
  const fake = await mockFeed(page);
  await openFeed(page, `/feed/requests/req_ccccccccccccccccccc4/manage#${MANAGE_CODE}`);
  await expect(page).toHaveURL(/\/feed\/requests\/req_ccccccccccccccccccc4\/manage$/);
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  const panel = page.getByRole('region', { name: 'Close your request' });
  await expect(panel).toContainText('Translate a product page into Italian');
  await expect(panel.getByRole('button', { name: /^Respond/ })).toHaveCount(0);
  // The poster's page: no words for responders.
  await expect(panel).not.toContainText(/Respond shows|reached yet/);
  await panel.getByRole('button', { name: 'Close the request' }).click();
  const closed = page.getByRole('region', { name: 'Request closed' });
  await expect(closed).toContainText(
    '“Translate a product page into Italian” no longer shows in the Feed.',
  );
  await expect(closed.getByRole('heading', { name: 'Request closed' })).toBeFocused();
  expect(fake.closes).toEqual([
    { id: 'req_ccccccccccccccccccc4', body: { manageToken: MANAGE_CODE } },
  ]);

  // A wrong token is refused in plain words.
  await page.goto('/feed/requests/req_aaaaaaaaaaaaaaaaaaa2/manage#ccf_wrong-token-0000000000');
  await page.getByRole('button', { name: 'Close the request' }).click();
  await expect(page.getByRole('alert')).toContainText("This link can't close the request.");
});

test('signed out, the private link closes the request with no sign-in; its code leaves the address bar', async ({
  page,
}) => {
  const fake = await mockFeed(page);
  await page.goto(`/feed/requests/req_aaaaaaaaaaaaaaaaaaa2/manage#${MANAGE_CODE}`);
  const panel = page.getByRole('region', { name: 'Close your request' });
  await expect(panel).toContainText('Summarise 40 PDF invoices into one table');
  // No sign-in first: the public pages' header, the Feed's heading, never the workspace.
  await expect(page.getByLabel('Account name')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await expect(page).toHaveTitle('Close your request · Feed · Central City');
  // Gone from the address bar (and so from history).
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  await expect(page).toHaveURL(/\/feed\/requests\/req_aaaaaaaaaaaaaaaaaaa2\/manage$/);
  await expect(panel).not.toContainText('This link has no private code.');
  await plainText(page);
  // The page's column lines up with the public header's (24 px inside it), and fits a phone.
  const inner = (await page.locator('.cc-header-inner').boundingBox())!;
  const heading = (await page.getByRole('heading', { level: 1, name: 'Feed' }).boundingBox())!;
  expect(Math.abs(heading.x - (inner.x + 24))).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel.getByRole('button', { name: 'Close the request' }).click();
  await expect(page.getByRole('heading', { name: 'Request closed' })).toBeFocused();
  expect(fake.closes).toEqual([
    { id: 'req_aaaaaaaaaaaaaaaaaaa2', body: { manageToken: MANAGE_CODE } },
  ]);
  // The footer stays at the bottom of the window under the short "Request closed" card.
  const footer = (await page.locator('footer.cc-footer').boundingBox())!;
  expect(footer.y + footer.height).toBeGreaterThanOrEqual(1000 - 1);
});

test('signed out, a close link without its code (a reload) asks to sign in, then the account closes it', async ({
  page,
}) => {
  const name = await signIn(page);
  await page.context().clearCookies();
  const fake = await mockFeed(page, { postedByAccount: ['req_bbbbbbbbbbbbbbbbbbb3'] });
  await page.goto(`/feed/requests/req_bbbbbbbbbbbbbbbbbbb3/manage#${MANAGE_CODE}`);
  const panel = page.getByRole('region', { name: 'Close your request' });
  await expect(panel).toContainText('Daily Base gas price alert');
  // The code left the address bar, so a reload (or the address copied from it) has none: no page
  // offers a close that can't work, sign-in comes first at the same address.
  await page.reload();
  await expect(page.getByText('Sign in to close your request.', { exact: true })).toBeVisible();
  await expect(page).toHaveTitle('Feed · Central City');
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(/\/feed\/requests\/req_bbbbbbbbbbbbbbbbbbb3\/manage$/);
  await page.getByLabel('Account name').fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
  // Signed in, the same page in the workspace: the account that posted the request closes it.
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(panel).toContainText('Daily Base gas price alert');
  await expect(panel).toContainText(
    'This link has no private code. If you posted the request from this account, you can still close it here.',
  );
  expect(fake.closes).toEqual([]);
  await panel.getByRole('button', { name: 'Close the request' }).click();
  await expect(page.getByRole('heading', { name: 'Request closed' })).toBeFocused();
  expect(fake.closes).toEqual([{ id: 'req_bbbbbbbbbbbbbbbbbbb3', body: {} }]);
});

test('signed in, a Feed that can’t be loaded stays in the workspace with a way back to Rooms', async ({
  page,
}) => {
  await signIn(page);
  await mockFeed(page);
  let answer = 500;
  let asked = 0;
  await page.route('**/api/public/feed', (route) => {
    asked += 1;
    return route.fulfill({
      status: answer,
      json: { error: answer === 429 ? 'Slow down.' : 'Down.' },
    });
  });
  await page.goto('/feed/requests');
  const down = (text: string) => page.getByRole('alert').filter({ hasText: text });
  // The status is asked three times (FEED_GATE_RETRY_MS) before the page says so.
  await expect(
    down('The Feed couldn’t be loaded. The rest of Central City works as usual.'),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.app-shell main#main-content')).toBeVisible();
  await expect(sidebar(page)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
  await plainText(page);
  // Too many tries says so after one ask (no retries at an address told to wait), and Try again
  // keeps the workspace while it asks.
  const shell = await page.locator('.app-shell').elementHandle();
  answer = 429;
  asked = 0;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(down('Too many tries. Try again in a minute.')).toBeVisible();
  expect(asked).toBe(1);
  expect(await shell!.evaluate((element) => element.isConnected)).toBe(true);
  await page.getByRole('link', { name: 'Go to your rooms' }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await expect(sidebar(page).getByRole('button', { name: 'Rooms', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(await shell!.evaluate((element) => element.isConnected)).toBe(true);
});

test('a request’s drawer has its own address: Back closes it; opened anew, it is the request’s page', async ({
  page,
}) => {
  await signIn(page);
  const fake = await mockFeed(page);
  await openFeed(page, '/feed/requests');
  await expect(requestCards(page)).toHaveCount(3);
  const reads = fake.requestReads.length;
  await requestCards(page).nth(1).getByRole('button').click();
  await expect(page).toHaveURL(/\/feed\/requests\/req_bbbbbbbbbbbbbbbbbbb3$/);
  await expect(drawer(page)).toBeVisible();
  // Back (a phone's too) closes the drawer and stays in the Feed; the list isn't read again.
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/feed\/requests$/);
  await expect(requestCards(page).nth(1).getByRole('button')).toBeFocused();
  await page.goForward();
  await expect(drawer(page)).toBeVisible();
  expect(fake.requestReads.length).toBe(reads);
  // A tag in the details links to the requests with it.
  await drawer(page)
    .getByRole('link', { name: /^alerts/ })
    .click();
  await expect(page).toHaveURL(/\/feed\/requests\?tag=alerts$/);
  await expect(drawer(page)).toHaveCount(0);
  await expect(requestCards(page)).toHaveCount(1);
  await expect(countLine(page)).toBeFocused();
  // Back returns to it, and a reload keeps it over the list.
  await page.goBack();
  await expect(drawer(page)).toBeVisible();
  await page.reload();
  await expect(drawer(page).getByRole('heading', { level: 2 })).toHaveText(
    'Daily Base gas price alert',
  );
  await page.keyboard.press('Escape');
  await expect(requestCards(page)).toHaveCount(3);
  // A request's address opened anew is its own page. It can't tell the request is yours after a
  // reload: it links to the page that closes it by the account signed in.
  await page.goto('/feed/requests/req_ccccccccccccccccccc4');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Translate a product page into Italian' }),
  ).toBeVisible();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Back to Searched for' })).toBeVisible();
  await page.getByRole('link', { name: /^Manage/ }).click();
  await expect(page).toHaveURL(/\/feed\/requests\/req_ccccccccccccccccccc4\/manage$/);
  await expect(page.getByRole('region', { name: 'Close your request' })).toBeVisible();
});

test('the Searched for count follows the list: a whole, unfiltered list counts itself', async ({
  page,
}) => {
  await signIn(page);
  // Every status read lags the list by one request (the two are cached apart).
  await mockFeed(page, { laggingStatusReads: 100 });
  await openFeed(page, '/feed/requests');
  await expect(requestCards(page)).toHaveCount(3);
  await expect(countLine(page)).toHaveText('3 open requests');
  await expect(views(page).getByRole('link', { name: /^Searched for\W+3/ })).toBeVisible();
  // The count stays when the list is filtered, and on Offered.
  await pickPill(page, 'fd-tag', 'pdf');
  await expect(countLine(page)).toHaveText('1 of 3 open requests');
  await views(page)
    .getByRole('link', { name: /^Offered/ })
    .click();
  await expect(cards(page)).toHaveCount(11);
  await expect(views(page).getByRole('link', { name: /^Searched for\W+3/ })).toBeVisible();
});

test('a filtered list reads the status again once the one it has is older than 10 s', async ({
  page,
}) => {
  await page.clock.install();
  await signIn(page);
  const fake = await mockFeed(page, { laggingStatusReads: 1 });
  await openFeed(page, '/feed/requests?tag=pdf');
  await expect(requestCards(page)).toHaveCount(1);
  await expect(countLine(page)).toHaveText('1 of 2 open requests');
  const asked = fake.statusReads;
  await page.clock.fastForward(11_000);
  await pickPill(page, 'fd-tag', 'invoices');
  await expect(countLine(page)).toHaveText('1 of 3 open requests');
  await expect(views(page).getByRole('link', { name: /^Searched for\W+3/ })).toBeVisible();
  expect(fake.statusReads).toBe(asked + 1);
});

test('keyboard: the view switch moves with the arrow keys, Enter and Back', async ({ page }) => {
  await signIn(page);
  await mockFeed(page);
  await openFeed(page);
  const offered = views(page).getByRole('link', { name: /^Offered/ });
  const wanted = views(page).getByRole('link', { name: /^Searched for/ });
  await offered.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/\/feed\/requests$/);
  await expect(wanted).toBeFocused();
  await expect(wanted).toHaveAttribute('aria-current', 'page');
  await expect(requestCards(page)).toHaveCount(3);
  await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL(/\/feed$/);
  await expect(offered).toBeFocused();
  await expect(offered).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Tab');
  await expect(wanted).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/feed\/requests$/);
  await expect(wanted).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(offered).toHaveAttribute('aria-current', 'page');
  await expect(cards(page)).toHaveCount(11);
});

for (const theme of ['light', 'dark'] as const)
  test(`the Feed at 375 px (${theme}): one column, no sideways scroll, readable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: theme });
    await signIn(page);
    await mockFeed(page);
    await openFeed(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(cards(page)).toHaveCount(11);
    const fits = () =>
      page.evaluate(() => {
        const main = document.querySelector('main')!;
        return (
          document.documentElement.scrollWidth <= window.innerWidth &&
          main.scrollWidth <= main.clientWidth
        );
      });
    expect(await fits()).toBe(true);
    const [first, second] = await Promise.all([
      cards(page).nth(0).boundingBox(),
      cards(page).nth(1).boundingBox(),
    ]);
    expect(second!.y).toBeGreaterThan(first!.y + first!.height - 1);
    // Phone targets stay 44 px.
    // Phone targets stay 44 px.
    for (const control of [
      page.locator('.fd-search'),
      page.locator('.fd-sel').first(),
      page.locator('.fd-seg'),
    ])
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    // The page's own heading names it: the top row shows only the menu button.
    await expect(page.locator('.cc-app-header-title')).not.toContainText('Feed');
    // A card that takes focus while it sits behind the sticky bar scrolls out from under it.
    const third = cards(page).nth(2);
    await third.evaluate((card) => {
      const main = document.getElementById('main-content')!;
      const top = card.getBoundingClientRect().top - main.getBoundingClientRect().top;
      main.scrollBy(0, top - 10);
    });
    await third.getByRole('button').focus();
    const bar = await page.locator('.fd-tb-row1').boundingBox();
    const focused = await third.boundingBox();
    expect(focused!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height);
    await page.locator('main#main-content').evaluate((main) => main.scrollTo(0, 0));
    // Price, uses and the credit stay on one line.
    const foot = await cards(page).first().locator('.fd-cf').boundingBox();
    expect(foot!.height).toBeLessThan(30);
    expect((await lowContrast(page)).low).toEqual([]);
    if (process.env.SHOTS)
      await page.screenshot({ path: `${process.env.SHOTS}/feed-375-${theme}.png`, fullPage: true });

    // The details are a full sheet, with 44 px buttons.
    await cards(page).first().getByRole('button').click();
    const sheet = await page.locator('.fd-drawer').boundingBox();
    expect(sheet!.width).toBeGreaterThanOrEqual(374);
    for (const control of [
      drawer(page).getByRole('button', { name: 'Copy service address' }),
      drawer(page).getByRole('button', { name: /^Copy link/ }),
      drawer(page).getByRole('button', { name: 'Close', exact: true }).first(),
    ])
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    expect(await fits()).toBe(true);
    expect((await lowContrast(page, '.fd-drawer')).low).toEqual([]);
    await page.keyboard.press('Escape');

    await page.goto('/feed/requests');
    // Respond's "Start a room" is a 44 px target too.
    await requestCards(page).first().getByRole('button').click();
    await drawer(page).getByRole('button', { name: 'Respond' }).click();
    const start = await page.getByRole('link', { name: 'Start a room' }).boundingBox();
    expect(start!.height).toBeGreaterThanOrEqual(43.5);
    expect((await lowContrast(page, '.fd-drawer')).low).toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Post a request' }).click();
    await expect(page.getByRole('form', { name: 'Post a request' })).toBeVisible();
    const post = await page.getByRole('button', { name: 'Post request' }).boundingBox();
    expect(post!.height).toBeGreaterThanOrEqual(43.5);
    expect(await fits()).toBe(true);
    expect((await lowContrast(page)).low).toEqual([]);
    if (process.env.SHOTS)
      await page.screenshot({
        path: `${process.env.SHOTS}/feed-requests-375-${theme}.png`,
        fullPage: true,
      });
    // Posted from the foot of the form: "Your request is live" shows below the sticky bar.
    const form = page.getByRole('form', { name: 'Post a request' });
    await form.getByLabel('What do you need?').fill('Proofread a 12-page grant proposal');
    await form.getByLabel(/^Details/).fill('Plain English, with tracked changes.');
    await form.getByRole('button', { name: 'Post request' }).click();
    const live = page.getByRole('heading', { name: 'Your request is live' });
    await expect(live).toBeFocused();
    const stuck = await page.locator('.fd-tb-row1').boundingBox();
    const shown = await live.boundingBox();
    expect(shown!.y).toBeGreaterThanOrEqual(stuck!.y + stuck!.height);
  });

test('the Feed at 1440 px in both themes, for the record', async ({ page }) => {
  test.skip(!process.env.SHOTS, 'screenshots only');
  await signIn(page);
  await mockFeed(page);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await openFeed(page);
    await expect(cards(page)).toHaveCount(11);
    await page.screenshot({ path: `${process.env.SHOTS}/feed-1440-${theme}.png` });
    await cards(page).first().getByRole('button').click();
    await page.screenshot({ path: `${process.env.SHOTS}/feed-1440-details-${theme}.png` });
    await page.goto('/feed/requests');
    await expect(requestCards(page)).toHaveCount(3);
    await page.getByRole('button', { name: 'Post a request' }).click();
    await page.screenshot({ path: `${process.env.SHOTS}/feed-requests-1440-${theme}.png` });
  }
});

test('dark theme smoke: the Feed is readable', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await signIn(page);
  await mockFeed(page, { freshness: degraded() });
  await openFeed(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(cards(page)).toHaveCount(11);
  expect((await lowContrast(page)).low).toEqual([]);
  await cards(page).first().getByRole('button').click();
  await expect(drawer(page)).toBeVisible();
  expect((await lowContrast(page, '.fd-drawer')).low).toEqual([]);
  await page.goto('/feed/requests');
  await expect(requestCards(page)).toHaveCount(3);
  expect((await lowContrast(page)).low).toEqual([]);
  await requestCards(page).first().getByRole('button').click();
  await drawer(page).getByRole('button', { name: 'Respond' }).click();
  await expect(drawer(page).getByRole('link', { name: 'Start a room' })).toBeVisible();
  expect((await lowContrast(page, '.fd-drawer')).low).toEqual([]);
});

// -------------------------------------------------------------------------------------------
// Round 2 of the client audit (13 Oct)

test('client-1: a status read that never answers ends in Try again, which opens the Feed', async ({
  page,
}) => {
  await signIn(page);
  const fake = await mockFeed(page, { stalledStatusReads: 1 });
  await page.goto('/feed');
  await expect(
    page.getByRole('alert').filter({ hasText: 'The Feed couldn’t be loaded.' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Opening Central City')).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
  await expect(cards(page).first()).toBeVisible();
  expect(fake.statusReads).toBeGreaterThanOrEqual(2);
});

test('client-1: a list read that never answers shows Try again instead of Reading… forever', async ({
  page,
}) => {
  await signIn(page);
  await mockFeed(page, { stalledServiceReads: 1 });
  await openFeed(page);
  await expect(countLine(page)).toHaveText('Reading…');
  const banner = page.getByRole('alert').filter({ hasText: 'The list couldn’t be loaded' });
  await expect(banner).toContainText('Central City is taking too long to answer.', {
    timeout: 15_000,
  });
  await banner.getByRole('button', { name: 'Try again' }).click();
  await expect(cards(page)).toHaveCount(11);
});

test('client-2: after a short status failure the sidebar asks again and the Feed entry comes back', async ({
  page,
}) => {
  await signIn(page);
  const fake = await mockFeed(page, { failedStatusReads: 3 });
  await page.goto('/rooms');
  await expect(sidebar(page)).toBeVisible();
  await expect.poll(() => fake.statusReads, { timeout: 15_000 }).toBe(3);
  await expect(feedEntry(page)).toHaveCount(0);
  // Coming back to the window asks again (and so does a 30 s timer, and coming back online).
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(feedEntry(page)).toBeVisible();
});

test('ui-7, client-10, ui-4: a bad price is Any; a search keeps the site; empty-state buttons keep focus', async ({
  page,
}) => {
  await signIn(page);
  await mockFeed(page);
  // ui-7: an unreadable max_price is no filter: Any, and the list loads.
  await openFeed(page, '/feed?max_price=abc');
  await expect(cards(page)).toHaveCount(11);
  await expect(page.locator('#fd-max')).toHaveAttribute('data-value', '');
  await expect(page.locator('.fd-active')).toHaveCount(0);
  await expect(page.getByText('up to $abc')).toHaveCount(0);
  // client-10, ui-3: a search within one site's services keeps the site.
  await openFeed(page, '/feed?host=x402.ottoai.services');
  const search = page.getByRole('searchbox', { name: 'Search services' });
  await search.fill('whois');
  await search.press('Enter');
  await expect(page).toHaveURL(/\/feed\?q=whois&host=x402\.ottoai\.services$/);
  await expect(page.locator('.fd-active')).toContainText('from x402.ottoai.services');
  // ui-4: an empty state's button goes away with it; focus goes where the list continues.
  await openFeed(page, '/feed?q=zzqxjvbnm');
  await page.getByRole('button', { name: 'Clear search', exact: true }).last().click();
  await expect(page.locator('#fd-q')).toBeFocused();
  await openFeed(page, '/feed?max_price=0.0001');
  await page.getByRole('button', { name: 'Remove the price limit' }).click();
  await expect(cards(page)).toHaveCount(11);
  await expect(countLine(page)).toBeFocused();
  await openFeed(page, '/feed/requests?q=zzzqqq');
  await page.getByRole('button', { name: 'Clear filters' }).last().click();
  await expect(requestCards(page)).toHaveCount(3);
  await expect(page.locator('#fd-rq')).toBeFocused();
});

test('ui-2: the sticky bar meets the top of the page; nothing scrolls through a strip above it', async ({
  page,
}) => {
  await signIn(page);
  await mockFeed(page);
  await openFeed(page);
  await expect(cards(page)).toHaveCount(11);
  for (const size of [
    { width: 1280, height: 600 },
    { width: 375, height: 600 },
  ]) {
    await page.setViewportSize(size);
    const gap = await page.evaluate(() => {
      const main = document.getElementById('main-content')!;
      main.scrollTo(0, 1600);
      const toolbar = main.querySelector<HTMLElement>('.fd-toolbar')!;
      const stuck =
        getComputedStyle(toolbar).display === 'contents'
          ? main.querySelector<HTMLElement>('.fd-tb-row1')!
          : toolbar;
      return stuck.getBoundingClientRect().top - main.getBoundingClientRect().top;
    });
    expect(Math.abs(gap)).toBeLessThanOrEqual(1);
  }
});

test('ui-8, ui-10: the drawer links to Manage; closing there lowers the Searched for count', async ({
  page,
}) => {
  await signIn(page);
  const fake = await mockFeed(page, { postedByAccount: ['req_aaaaaaaaaaaaaaaaaaa2'] });
  await openFeed(page, '/feed/requests');
  await expect(views(page).getByRole('link', { name: /^Searched for\W+3/ })).toBeVisible();
  await requestCards(page).first().getByRole('button').click();
  // ui-10: after a reload nothing marks it yours; the drawer still leads to the page that closes it.
  await drawer(page).getByRole('link', { name: 'Manage this request' }).click();
  await expect(page).toHaveURL(/\/feed\/requests\/req_aaaaaaaaaaaaaaaaaaa2\/manage$/);
  const panel = page.getByRole('region', { name: 'Close your request' });
  // The poster's page has no words for responders.
  await expect(panel).not.toContainText('Respond shows how to reach the poster');
  await panel.getByRole('button', { name: 'Close the request' }).click();
  await expect(page.getByRole('heading', { name: 'Request closed' })).toBeFocused();
  expect(fake.closes).toEqual([{ id: 'req_aaaaaaaaaaaaaaaaaaa2', body: {} }]);
  // ui-8: the switch counts it out at once.
  await expect(views(page).getByRole('link', { name: /^Searched for\W+2/ })).toBeVisible();
});

for (const theme of ['light', 'dark'] as const)
  for (const width of [375, 1440])
    test(`Feed filter focus has one ring (${theme}, ${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await mockFeed(page);
      await signIn(page);
      await openFeed(page);
      // Keyboard focus remains visible, but a wrapper and its child must not both draw it.
      await page.keyboard.press('Tab');
      const control = page.locator('#fd-sort');
      await control.focus();
      const rings = await control.evaluate((element) => {
        let count = 0;
        for (
          let node: Element | null = element;
          node && !node.classList.contains('fd-toolbar');
          node = node.parentElement
        ) {
          const style = getComputedStyle(node);
          if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) count++;
        }
        return count;
      });
      expect(rings).toBe(1);
      if (process.env.SHOTS)
        await page.screenshot({ path: `${process.env.SHOTS}/feed-filter-${theme}-${width}.png` });
    });

test('Feed pill menus are select-only comboboxes: arrows move the announced option, a long list scrolls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 500 });
  await mockFeed(page);
  await signIn(page);
  await openFeed(page);
  const price = page.getByRole('combobox', { name: 'Price:' });
  await expect(price).toHaveAttribute('aria-haspopup', 'listbox');
  await price.focus();
  await page.keyboard.press('ArrowDown');
  await expect(price).toHaveAttribute('aria-expanded', 'true');
  await expect(price).toHaveAttribute('aria-controls', 'fd-max-list');
  await expect(price).toHaveAttribute('aria-activedescendant', 'fd-max-opt-0');
  await page.keyboard.press('ArrowDown');
  await expect(price).toHaveAttribute('aria-activedescendant', 'fd-max-opt-1');
  await page.keyboard.press('End');
  const last = await page.locator('#fd-max-list [role="option"]').count();
  await expect(price).toHaveAttribute('aria-activedescendant', `fd-max-opt-${last - 1}`);
  // The list is bounded and scrolls; the active option is inside its visible part.
  const fits = await page.evaluate(
    (id) => {
      const list = document.getElementById('fd-max-list')!;
      const option = document.getElementById(id)!.getBoundingClientRect();
      const box = list.getBoundingClientRect();
      return {
        bounded: getComputedStyle(list).overflowY === 'auto',
        visible: option.top >= box.top - 1 && option.bottom <= box.bottom + 1,
      };
    },
    `fd-max-opt-${last - 1}`,
  );
  expect(fits).toEqual({ bounded: true, visible: true });
  await page.keyboard.press('Escape');
  await expect(price).toHaveAttribute('aria-expanded', 'false');
  await expect(price).not.toHaveAttribute('aria-activedescendant', /./);
});
