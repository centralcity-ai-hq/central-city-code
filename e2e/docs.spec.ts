import { test, expect, type Page } from '@playwright/test';

/* The docs site: /docs and its pages. */
const PAGES = [
  { path: '/docs', h1: 'Docs' },
  { path: '/docs/start', h1: 'Connect your AI' },
  { path: '/docs/rooms', h1: 'Rooms' },
  { path: '/docs/room-management', h1: 'Room management' },
  { path: '/docs/coding', h1: 'Coding in rooms' },
  { path: '/docs/api', h1: 'API and SDK' },
];

for (const { path, h1 } of PAGES)
  test(`${path} renders, links the other pages, and fits 360 px`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Docs' });
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    // The site header marks Docs (in the Developers menu) as the current page.
    const developers = page.getByRole('banner').getByRole('button', { name: 'Developers' });
    await developers.click();
    await expect(
      page.getByRole('banner').getByRole('link', { name: 'Docs', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await developers.click();
    for (const title of ['Overview', 'Connect your AI', 'Rooms', 'API and SDK'])
      await expect(nav.getByRole('link', { name: title, exact: true })).toBeVisible();
    // Drafting notes never reach the site.
    const text = await page.locator('main').innerText();
    for (const marker of [
      'TODO',
      'Source:',
      'sdk-kit',
      'central-city/src',
      'central-city/docs',
      'central-city/protocol',
    ])
      expect(text, marker).not.toContain(marker);
    await page.setViewportSize({ width: 360, height: 780 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });

test('not-yet-live features are marked, and the facts match main', async ({ page }) => {
  await page.goto('/docs/rooms');
  const main = page.locator('main');
  // Room tasks are live in the room (the Tasks panel); nothing on this page is marked coming soon.
  await expect(main.getByText('Coming soon')).toHaveCount(0);
  await expect(main.locator('#tasks + p')).toContainText('Open Tasks in the room’s top bar');
  await expect(main.getByRole('link', { name: 'Room tasks', exact: true })).toHaveAttribute(
    'href',
    '/docs/room-tasks.md',
  );
  await expect(main).toContainText('Up to 16,384 characters per message.');
  // People's docs name no tools; the developer page does.
  await expect(main).not.toContainText('city_');
  // 100 members per room by default, people and AIs together.
  await expect(main).toContainText('Up to 100 members per room, people and AIs together');
  await expect(main).not.toContainText('20 members per room');
  await page.goto('/docs/start');
  await expect(page.locator('main')).toContainText('ends after 90 days without use');
  await expect(page.locator('main').getByText('Coming soon')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('city_');
  await page.goto('/docs/api');
  await expect(page.locator('main')).toContainText('city_room_leave');
  await expect(page.locator('main')).toContainText(
    'A message part holds up to 16,384 characters, and a message up to 32 KB in total.',
  );
  await expect(page.locator('main')).toContainText(
    'npm install github:centralcity-ai-hq/sdk-ts#v0.1.0-alpha.5',
  );
  await expect(page.locator('main')).toContainText('--ignore-scripts');
  await expect(page.locator('main')).toContainText('never paste them into a room');
  await expect(page.locator('main')).not.toContainText('npm install @centralcity/sdk');
});

test('the v8 sidebar: categories, section links that land on real headings, search', async ({
  page,
}) => {
  await page.goto('/docs/rooms');
  const nav = page.getByRole('navigation', { name: 'Docs' });
  for (const group of ['Getting started', 'Rooms', 'Developer reference', 'Trust'])
    await expect(nav.getByRole('group', { name: group })).toBeVisible();
  await expect(nav.locator('[aria-current="page"]')).toHaveText('Rooms');
  // Workflows (its own public page) is listed with the Rooms pages.
  await expect(
    nav.getByRole('group', { name: 'Rooms' }).getByRole('link', { name: 'Workflows', exact: true }),
  ).toHaveAttribute('href', '/workflows');
  // Every section link points at a heading that exists on its page.
  const hrefs = await nav
    .locator('a[href*="#"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')!));
  expect(hrefs.length).toBeGreaterThan(10);
  for (const href of hrefs) {
    const [path, id] = href.split('#');
    await page.goto(path!);
    await expect(page.locator(`main h2[id="${id}"]`), href).toHaveCount(1);
  }
  // Search filters the links; "/" focuses it.
  await page.goto('/docs');
  const search = page.getByRole('searchbox', { name: 'Search the docs' });
  await expect(page.getByRole('heading', { level: 1, name: 'Docs' })).toBeVisible();
  // The heading is in the prerendered copy at once; "/" works once the client has mounted.
  await expect(page.locator('#root')).not.toHaveAttribute('aria-busy');
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await search.fill('mention');
  await expect(nav.getByRole('link')).toHaveText(['Mentions']);
  await search.fill('zzz');
  await expect(nav).toContainText('Nothing matches');
  // People's pages name no tools, not even in the sidebar.
  await search.fill('');
  await expect(nav).not.toContainText('city_');
});

/* Room management and Coding in rooms: HTML pages rendered from the Markdown for AIs. */
const GUIDES = [
  {
    path: '/docs/room-management',
    label: 'Room management',
    facts: ['city_room_update', 'city_room_remove', 'confirm_name', 'room_deleted'],
  },
  {
    path: '/docs/coding',
    label: 'Coding in rooms',
    facts: ['city_room_propose', 'city_room_apply', 'support@centralcity.ai'],
  },
];

for (const { path, label, facts } of GUIDES)
  test(`the Rooms group opens ${label} as a docs page; the Markdown stays for AIs`, async ({
    page,
    request,
  }) => {
    await openLive(page, '/docs/rooms');
    const rooms = page
      .getByRole('navigation', { name: 'Docs' })
      .getByRole('group', { name: 'Rooms' });
    const link = rooms.getByRole('link', { name: label, exact: true });
    await expect(link).toHaveAttribute('href', path);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
    await expect(page).toHaveTitle(`${label} · Central City Docs`);
    const main = page.locator('main');
    await expect(
      page.getByRole('navigation', { name: 'Docs' }).locator('[aria-current="page"]'),
    ).toHaveText(label);
    for (const fact of facts) await expect(main, fact).toContainText(fact);
    // Sections have ids, tables are tables, and the AI index line of the .md is left out.
    expect(await main.locator('h2[id]').count()).toBeGreaterThan(3);
    await expect(main.locator('.docs-table table').first()).toBeVisible();
    await expect(main).not.toContainText('More docs:');
    // The quiet link to the same text as Markdown.
    const markdown = main.getByRole('link', { name: 'View as Markdown' });
    await expect(markdown).toHaveAttribute('href', `${path}.md`);
    const doc = await request.get(`${path}.md`);
    expect(doc.ok()).toBe(true);
    expect(doc.headers()['content-type']).toContain('text/markdown');
    const text = await doc.text();
    expect(text).toContain(`# ${label}`);
    for (const fact of facts) expect(text, fact).toContain(fact);
    // Every section of the .md is a heading on the page.
    const sections = [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]!.replace(/`/g, ''));
    await expect(main.locator('h2:not(.docs-help h2)')).toHaveText(sections);
  });

test('Coding in rooms keeps its availability and publishes no GitHub app link', async ({
  page,
}) => {
  await page.goto('/docs/coding');
  const main = page.locator('main');
  await expect(main).toContainText('Availability: approved accounts (contact support)');
  expect(await main.innerHTML()).not.toMatch(/github\.com\/apps\//);
});

for (const width of [360, 390])
  for (const scheme of ['light', 'dark'] as const)
    test(`the guides fit ${width} px in ${scheme}: tables scroll in their box`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
      for (const { path, label } of GUIDES) {
        await openLive(page, path);
        await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        const dark = (await luminance(page, '.docs-layout')) < 0.3;
        expect(dark, path).toBe(scheme === 'dark');
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          path,
        ).toBe(true);
        // Every table stays inside the screen; a wide one (the error table) scrolls sideways in
        // its own box instead of widening the page.
        const boxes = await page.locator('.docs-table').evaluateAll((elements) =>
          elements.map((element) => ({
            scrolls: element.scrollWidth > element.clientWidth,
            right: element.getBoundingClientRect().right,
          })),
        );
        expect(boxes.length, path).toBeGreaterThan(0);
        for (const box of boxes) expect(box.right, path).toBeLessThanOrEqual(width);
        if (path === '/docs/room-management') expect(boxes.some((box) => box.scrolls)).toBe(true);
      }
    });

/**
 * Opens a docs page and waits for the app to take over from the prerendered copy (#root loses
 * aria-busy). Until then the page is the static copy, which the app replaces: a measurement can
 * land on an element that is about to leave the page.
 */
async function openLive(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('#root')).not.toHaveAttribute('aria-busy');
}
/** Waits for the cross-fade of an in-place page change (View Transitions) to end. */
async function crossFadeDone(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        try {
          return !document.documentElement.matches(':active-view-transition');
        } catch {
          return true; // No View Transitions: no cross-fade.
        }
      }),
    )
    .toBe(true);
}
/** The luminance (0 to 1) of an element's background colour. */
const luminance = (page: Page, selector: string) =>
  page.locator(selector).evaluate((element) => {
    const [r, g, b] = getComputedStyle(element)
      .backgroundColor.match(/\d+/g)!
      .slice(0, 3)
      .map(Number);
    return (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255;
  });

/** The sidebar's box in the viewport, and the document scroll once a smooth scroll has settled. */
async function sidebarBox(page: Page) {
  // Whole pixels: the last scroll step at the end of a page can be a fraction of a pixel.
  return page.locator('.docs-sidebar').evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    };
  });
}
async function settledScroll(page: Page) {
  let last = -1;
  await expect
    .poll(async () => {
      const now = await page.evaluate(() => scrollY);
      const settled = now === last;
      last = now;
      return settled;
    })
    .toBe(true);
  return last;
}
/** Layout shifts (not scrolling) recorded from now on; read with window.__docsShifts. */
async function watchLayoutShifts(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Let pending frames paint first; their shifts are reported late and belong to earlier steps.
    for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame);
    const start = performance.now();
    const shifts: number[] = [];
    (window as unknown as { __docsShifts: number[] }).__docsShifts = shifts;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (entry.startTime >= start) shifts.push((entry as unknown as { value: number }).value);
    }).observe({ type: 'layout-shift' });
  });
}
const layoutShifts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __docsShifts: number[] }).__docsShifts);

test('1440 px: a topic click scrolls only the reading column; the sidebar stays put', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLive(page, '/docs/rooms');
  await expect(page.getByRole('heading', { level: 1, name: 'Rooms' })).toBeVisible();
  await watchLayoutShifts(page);
  const nav = page.getByRole('navigation', { name: 'Docs' });
  const before = await sidebarBox(page);
  // Topics near the end of the page used to push the sticky sidebar up under the header.
  for (const [topic, id] of [
    ['Limits', 'limits'],
    ['Text from others', 'trust'],
    ['Members', 'members'],
    ['Room tasks', 'tasks'],
  ] as const) {
    await nav.getByRole('link', { name: topic, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/docs/rooms#${id}$`));
    await settledScroll(page);
    await expect(page.locator(`main h2[id="${id}"]`)).toBeInViewport();
    expect(await sidebarBox(page), topic).toEqual(before);
    // The search at the top of the sidebar is still in view.
    await expect(page.getByRole('searchbox', { name: 'Search the docs' })).toBeInViewport();
  }
  // Only the reading column moved: the page itself scrolled, the sidebar did not.
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  expect(await layoutShifts(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // At the very end of the page, the sidebar is still where it was.
  await page.evaluate(() =>
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }),
  );
  expect(await sidebarBox(page)).toEqual(before);
});

test('390 px: the mobile row of pages keeps working and nothing shifts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLive(page, '/docs/start');
  await expect(page.getByRole('heading', { level: 1, name: 'Connect your AI' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Docs' });
  const before = await sidebarBox(page);
  // A page in the row: the next page opens at the top with the row in the same place.
  await nav.getByRole('link', { name: 'Rooms', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Rooms' })).toBeInViewport();
  await crossFadeDone(page);
  expect(await sidebarBox(page)).toEqual(before);
  await expect(nav.locator('[aria-current="page"]')).toHaveText('Rooms');
  // A section found by search: its heading scrolls into view; the row itself doesn't move on
  // the page (it scrolls away with the text, as before) and nothing shifts.
  // (Typing grows the row with the matching sections; the watch starts after that.)
  await page.getByRole('searchbox', { name: 'Search the docs' }).fill('limits');
  await expect(nav.getByRole('link')).toHaveText(['Limits']);
  await watchLayoutShifts(page);
  const typed = await sidebarBox(page);
  await nav.getByRole('link', { name: 'Limits', exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/rooms#limits$/);
  const scrolled = await settledScroll(page);
  await expect(page.locator('main h2[id="limits"]')).toBeInViewport();
  const after = await sidebarBox(page);
  expect({ ...after, y: after.y + Math.round(scrolled) }).toEqual(typed);
  expect(await layoutShifts(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const { path, title } of [
  { path: '/docs/coding', title: 'Coding in rooms' },
  { path: '/docs/api', title: 'API and SDK' },
])
  test(`360 px: the row of pages shows the current page (${title})`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(path);
    const nav = page.getByRole('navigation', { name: 'Docs' });
    const current = nav.locator('[aria-current="page"]');
    await expect(current).toHaveText(title);
    // Fully inside the row, clear of the fade at its trailing edge (40 px, less rounding).
    await expect
      .poll(async () => {
        // Null while the prerendered copy is swapped for the live page: poll again.
        const row = await nav.boundingBox();
        const link = await current.boundingBox();
        if (!row || !link) return false;
        return link.x >= row.x && link.x + link.width <= row.x + row.width - 38;
      })
      .toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

test('the docs index for AIs is served at /docs/index.md and /docs.md', async ({ request }) => {
  for (const path of ['/docs/index.md', '/docs.md']) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()['content-type']).toContain('text/markdown');
    const text = await response.text();
    expect(text).toMatch(/^# Central City docs/);
    expect(text).toContain('/docs/room-management.md');
  }
});

test('dark mode uses dark surfaces', async ({ page }) => {
  await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), 'dark');
  await openLive(page, '/docs/start');
  expect(await luminance(page, '.docs-layout')).toBeLessThan(0.3);
});

test('dark mode: the prerendered page is dark before the app runs (no light flash)', async ({
  page,
}) => {
  await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), 'dark');
  // Hold the app's script: what shows meanwhile is the prerendered copy, as on a slow phone.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
    await held;
    await route.continue();
  });
  // (The held module script also holds DOMContentLoaded and load.)
  await page.goto('/docs/start', { waitUntil: 'commit' });
  await expect(page.locator('#root .docs-layout')).toBeAttached();
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].every(
      (link) => link.sheet,
    ),
  );
  await expect(page.locator('#root')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await luminance(page, '.docs-layout')).toBeLessThan(0.3);
  // (The live page's dark surfaces are the test above.)
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  release();
});

test('code blocks copy exactly their text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/docs/api');
  const block = page.locator('.docs-code').filter({ hasText: 'npm install github:' });
  await block.getByRole('button', { name: /Copy/ }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'npm install github:centralcity-ai-hq/sdk-ts#v0.1.0-alpha.5',
  );
});

/** Screenshots for a UX review: DOCS_SHOTS_DIR=<dir>. */
for (const [w, h] of [
  [1440, 900],
  [768, 1024],
  [360, 780],
] as const)
  for (const scheme of ['light', 'dark'] as const)
    test(`screenshot ${w} ${scheme}`, async ({ page }) => {
      const dir = process.env.DOCS_SHOTS_DIR;
      test.skip(!dir, 'Set DOCS_SHOTS_DIR to write screenshots.');
      await page.setViewportSize({ width: w, height: h });
      await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
      for (const { path } of PAGES) {
        await page.goto(path);
        await page.getByRole('heading', { level: 1 }).waitFor();
        const name = path === '/docs' ? 'index' : path.split('/').pop();
        await page.screenshot({ path: `${dir}/docs-${name}-${w}-${scheme}.png`, fullPage: true });
      }
    });
