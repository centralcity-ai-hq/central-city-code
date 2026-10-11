import { test, expect, type Page } from '@playwright/test';

/*
 * The site footer (src/shell/links.ts): the header's four groups (Product, Developers, Open
 * Source, Company), then Help & legal and the company line. Every same-site link must resolve
 * (no 404), GitHub links open in a new tab, the columns become closed accordions at 360 px, and no
 * page scrolls sideways on a phone.
 */

const GITHUB = 'https://github.com/centralcity-ai-hq';
/** [name, href, GitHub?] per column. */
const COLUMNS: [string, [string, string, boolean?][]][] = [
  [
    'Product',
    [
      ['Elric', '/elric'],
      ['Workspace', '/#signin'],
      ['Connect AI', '/connect'],
      ['Base Agents', '/explorer/base'],
      ['Use cases', '/use-cases'],
    ],
  ],
  [
    'Developers',
    [
      ['Docs', '/docs'],
      ['Changelog', `${GITHUB}/central-city-code/blob/main/CHANGELOG.md`, true],
      ['Status', '/status'],
    ],
  ],
  [
    'Open Source',
    [
      ['Agent Explorer', '/explorer'],
      ['Elric on GitHub', `${GITHUB}/central-city-code/tree/main/server/elric`, true],
      ['Downtown', '/downtown'],
      ['Verify', '/downtown/verify'],
    ],
  ],
  [
    'Company',
    [
      ['About', '/about'],
      ['Contact', '/contact'],
      ['Security', '/security'],
      ['Privacy', '/privacy'],
    ],
  ],
  [
    'Help & legal',
    [
      ['Support', '/support'],
      ['Terms of service', '/terms'],
      ['Privacy choices', '/privacy-choices'],
      ['Acceptable use', '/acceptable-use'],
      ['Data processing addendum', '/dpa'],
      ['Imprint', '/imprint'],
    ],
  ],
];

const NOT_FOUND = 'This page doesn’t exist.';

async function footerHrefs(page: Page) {
  await expect(page.getByRole('contentinfo').locator('.cc-footer-legal')).toBeAttached();
  return [
    ...new Set(
      await page
        .getByRole('contentinfo')
        .locator('a[href]')
        .evaluateAll((links) => links.map((link) => link.getAttribute('href')!)),
    ),
  ];
}

test('the footer mirrors the header groups, then Help & legal, in order', async ({ page }) => {
  await page.goto('/');
  const footer = page.getByRole('contentinfo');
  await expect(footer.locator('.cc-footer-column h2')).toHaveText(COLUMNS.map(([title]) => title));
  for (const [title, links] of COLUMNS) {
    const column = footer.getByRole('navigation', { name: title });
    await expect(column.getByRole('link')).toHaveCount(links.length);
    for (const [index, [name, href, external]] of links.entries()) {
      const link = column.getByRole('link').nth(index);
      await expect(link).toHaveAttribute('href', href);
      if (external) {
        await expect(link).toHaveAccessibleName(`${name} (opens in a new tab)`);
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', /noopener/);
      } else {
        await expect(link).toHaveAccessibleName(name);
        await expect(link).not.toHaveAttribute('target', /.*/);
      }
    }
  }
  await expect(footer.locator('.cc-footer-legal')).toHaveText(
    '© 2026 La Cavina S.R.L. · Torino, Italy',
  );
  // No registration numbers or street address in the footer.
  await expect(footer).not.toContainText(/08302720019|REA|Via Cavour|DAO/);
});

test('every footer link resolves: no 404, and anchors exist', async ({ page }) => {
  // Product › Elric: the e2e server runs without CITY_ELRIC; Elric on answers a visitor 401.
  await page.route('**/api/elric', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Sign in."}' }),
  );
  await page.goto('/');
  const hrefs = await footerHrefs(page);
  expect(hrefs.length).toBeGreaterThanOrEqual(20);
  for (const href of hrefs) {
    const url = new URL(href, page.url());
    // GitHub links are checked by name and attributes above; the rest are same-site pages.
    if (url.origin === 'https://github.com') {
      expect(href, href).toMatch(/^https:\/\/github\.com\/centralcity-ai-hq\//);
      continue;
    }
    // The X profile (footer socials) is the one other outside link.
    if (url.origin === 'https://x.com') {
      expect(href, href).toBe('https://x.com/centralcityai');
      continue;
    }
    expect(url.origin, href).toBe(new URL(page.url()).origin);
    if (/\.(json|md|txt)$/.test(url.pathname)) {
      expect((await page.request.get(url.toString())).status(), href).toBe(200);
      continue;
    }
    // The server answers 200 (a 404 path gets a real 404), and the page renders.
    expect((await page.request.get(url.origin + url.pathname)).status(), href).toBe(200);
    await page.goto(url.toString());
    const heading = page.getByRole('heading', { level: 1 }).first();
    await expect(heading, href).toBeVisible();
    await expect(heading, href).not.toHaveText(NOT_FOUND);
    const id = url.hash.slice(1);
    if (id && !['connect', 'signin', 'signup'].includes(id))
      await expect(page.locator(`[id="${id}"]`), href).toHaveCount(1);
  }
});

test('at 360 px the columns are closed accordions and nothing scrolls sideways', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  // The app has taken over from the prerendered copy (its accordions animate and keep state).
  await expect(page.locator('#root')).not.toHaveAttribute('aria-busy');
  const footer = page.getByRole('contentinfo');
  const groups = footer.locator('details');
  await expect(groups).toHaveCount(5);
  for (const group of await groups.all()) await expect(group).not.toHaveAttribute('open');
  await expect(footer.getByRole('link', { name: 'Imprint' })).toBeHidden();
  await footer.getByText('Help & legal', { exact: true }).click();
  await expect(footer.getByRole('link', { name: 'Imprint' })).toBeVisible();
  for (const group of await groups.all()) await group.locator('summary').click();
  // Help & legal was open, so that click closed it: its closing eases out first.
  await expect(footer.locator('details[data-closing]')).toHaveCount(0);
  await expect(footer.locator('details:not([open])')).toHaveCount(1);
  await expect(footer.locator('.cc-footer-legal')).toBeVisible();
  // Every footer link is a 44 px target.
  for (const link of await footer.locator('a:visible').all())
    expect((await link.boundingBox())!.height, await link.innerText()).toBeGreaterThanOrEqual(44);
  const paths = [
    '/',
    // The Agent Explorer's On Base view (Base Agents) has the site header but no site footer.
    ...(await footerHrefs(page)).filter(
      (href) => !/\.(json|md)$/.test(href) && href.startsWith('/') && href !== '/explorer/base',
    ),
  ];
  for (const path of paths) {
    await page.goto(path);
    await expect(page.getByRole('contentinfo')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      path,
    ).toBe(true);
  }
});

test('the footer follows the dark theme', async ({ page }) => {
  await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), 'dark');
  await page.goto('/imprint');
  const footer = page.getByRole('contentinfo');
  await expect(footer).toBeVisible();
  const colors = await footer.evaluate((element) => {
    const text = getComputedStyle(element.querySelector('.cc-footer-legal')!).color;
    const background = getComputedStyle(document.body).backgroundColor;
    return { text, background };
  });
  const luminance = (rgb: string) => {
    const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  expect(luminance(colors.background)).toBeLessThan(80);
  expect(luminance(colors.text)).toBeGreaterThan(160);
});
