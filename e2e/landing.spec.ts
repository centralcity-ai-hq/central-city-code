import { test, expect, type Locator, type Page } from '@playwright/test';
import { signedOutSession } from './landing-html';
import { gotoMounted } from './mounted';

/** A bounding box, waiting out the moment it is null while the prerendered copy is swapped for the live page. */
async function box(locator: Locator) {
  let found: Awaited<ReturnType<Locator['boundingBox']>> = null;
  await expect.poll(async () => (found = await locator.boundingBox()) !== null).toBe(true);
  return found!;
}

/*
 * The v10 landing (src/Landing.tsx): the hero with its live numbers, "Listed on", the sections
 * Rooms, Passports and Always on with their videos, and "Connect your AI in 30 seconds."
 * e2e/home-v10.spec.ts covers the live numbers, "Listed on" and the section order in detail.
 */

const HEADLINE = 'Every AI. One room.';
/** The link previews' description (index.html). */
const DESCRIPTION = 'Central City is where the world’s AI agents meet.';
const SUBLINE =
  'Claude, ChatGPT, Gemini and your own agents work together in shared rooms, carry a passport on Base and pay each other for services in USDC.';

// An installation with an owner, so the hero shows its live numbers (not the setup copy).
test.beforeEach(async ({ page }) => {
  await signedOutSession(page);
});

const hero = (page: Page) => page.getByRole('region', { name: HEADLINE });

test('landing hero: one headline, Sign up and Explore open source, and its calls to action route', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await gotoMounted(page, '/');
  await expect(page).toHaveTitle(`Central City · ${HEADLINE}`);
  // Link previews carry the page's description (index.html).
  for (const selector of [
    'meta[name="description"]',
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
  ])
    await expect(page.locator(selector)).toHaveAttribute('content', DESCRIPTION);
  for (const selector of ['meta[property="og:title"]', 'meta[name="twitter:title"]'])
    await expect(page.locator(selector)).toHaveAttribute('content', `Central City · ${HEADLINE}`);

  await expect(hero(page).getByRole('heading', { level: 1, name: HEADLINE })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(hero(page).getByText('Open protocol for AI agents', { exact: true })).toBeVisible();
  await expect(hero(page).locator('.cc-landing-sub')).toHaveText(SUBLINE);

  // One filled button in the hero, plus one secondary; the live numbers' "Verify on Base" is the
  // only other link.
  await expect(hero(page).locator('.button.primary')).toHaveCount(1);
  await expect(hero(page).getByRole('link', { name: 'Verify on Base' })).toHaveAttribute(
    'href',
    '/explorer/calls',
  );
  const actions = hero(page).getByRole('link').filter({ hasNotText: 'Verify on Base' });
  await expect(actions).toHaveText(['Sign up', 'Explore open source']);
  await expect(hero(page).getByRole('link', { name: 'Sign up' })).toHaveAttribute(
    'href',
    '/#create',
  );
  await expect(hero(page).getByRole('link', { name: 'Explore open source' })).toHaveAttribute(
    'href',
    '/downtown',
  );

  // Retired concepts stay off the landing (DESIGN_SYSTEM §4.2). "exchange" is back by product
  // decision (the 29 Sep sub-line); "Downtown" is retired (the page is "Open source"). The demo
  // room may still mention test "districts", so only "Downtown" is banned for it.
  const text = (await page.locator('main').innerText()).toLowerCase();
  for (const word of ['circle', 'route', 'operator', 'downtown'])
    expect(text, word).not.toContain(word);
  await expect(page.getByRole('heading', { name: 'Answers', exact: true })).toHaveCount(0);

  // Sign up opens the create-account form.
  await hero(page).getByRole('link', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Create your account.' })).toBeVisible();
  await expect(page.getByLabel('Account name')).toBeVisible();

  // Explore open source opens the open source page.
  await gotoMounted(page, '/');
  await hero(page).getByRole('link', { name: 'Explore open source' }).click();
  await expect(page).toHaveURL(/\/downtown$/);

  // The header's Sign in still opens the sign-in form.
  await gotoMounted(page, '/');
  await page.getByRole('banner').getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Account name')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Your room never sleeps: its video on the left, copy and Meet Elric on the right; Invite your AI opens Connect', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoMounted(page, '/');
  const section = page.getByRole('region', { name: 'Your room never sleeps.' });
  await expect(section).toHaveAttribute('id', 'how');
  await expect(section.getByText(/Time zones don’t matter here\./)).toBeVisible();
  await expect(section.getByRole('link', { name: 'Meet Elric' })).toHaveAttribute('href', '/elric');
  const media = await box(section.locator('.cc-feat-media'));
  const copy = await box(section.locator('.cc-feat-copy'));
  expect(media.x + media.width).toBeLessThanOrEqual(copy.x + 1);
  const video = section.locator('video');
  await expect(video).toHaveAttribute('preload', 'none');
  await section.scrollIntoViewIfNeeded();
  await expect(video).toHaveAttribute('src', '/brand/hero/central-city-night.mp4');
  // No cards and no arrows in the copy.
  await expect(page.locator('.cc-lp-card')).toHaveCount(0);
  expect(await section.innerText()).not.toContain('→');

  const cta = page.getByRole('region', { name: 'Connect your AI in 30 seconds.' });
  await expect(cta.getByRole('link', { name: 'Read the docs' })).toHaveAttribute('href', '/docs');
  // Invite your AI opens the Connect page while signed out (the product owner, 12 Oct).
  await cta.getByRole('link', { name: 'Invite your AI' }).click();
  await expect(page).toHaveURL(/\/connect$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Connect your AI' })).toBeVisible();
});

test('Every agent deserves a passport: copy and Explore agents on Base on the left, its video on the right', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoMounted(page, '/');
  const section = page.getByRole('region', { name: 'Every agent deserves a passport.' });
  await expect(section).toHaveAttribute('id', 'passport');
  await expect(section.getByText(/Give your agent its own identity on Base\./)).toBeVisible();
  await expect(section.getByRole('link', { name: 'Explore agents on Base' })).toHaveAttribute(
    'href',
    '/explorer/base',
  );
  const copy = await box(section.locator('.cc-feat-copy'));
  const media = await box(section.locator('.cc-feat-media'));
  expect(copy.x + copy.width).toBeLessThanOrEqual(media.x + 1);
  const video = section.locator('video');
  await expect(video).toHaveAttribute('preload', 'none');
  await expect(video).toHaveAttribute('poster', '/brand/hero/central-city-passport-poster.jpg');
  await section.scrollIntoViewIfNeeded();
  await expect(video).toHaveAttribute('src', '/brand/hero/central-city-passport.mp4');
  expect(await section.innerText()).not.toContain('→');
  // After "Every AI at the same table.", before "Your room never sleeps." and the call to action.
  const order = await page
    .locator('main section[aria-labelledby]')
    .evaluateAll((all) => all.map((el) => el.getAttribute('aria-labelledby')));
  expect(order.indexOf('passport-title')).toBe(order.indexOf('room-title') + 1);
  expect(order.indexOf('how-title')).toBe(order.indexOf('passport-title') + 1);
  expect(order.indexOf('cta-title')).toBe(order.indexOf('how-title') + 1);
});

test('landing fits 360 px: the two actions fill the column and are tall enough to tap', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await gotoMounted(page, '/');
  const actions = hero(page).locator('.hero-actions .button');
  await expect(actions).toHaveText(['Sign up', 'Explore open source']);
  const first = await box(actions.first());
  const last = await box(actions.last());
  // Inside the 16 px gutters, together spanning the column (one row or one each).
  expect(first.x).toBeGreaterThanOrEqual(15.5);
  expect(last.x + last.width).toBeLessThanOrEqual(360 - 15.5);
  expect(last.x + last.width - first.x).toBeGreaterThanOrEqual(360 - 2 * 20 - 1);
  for (const action of [first, last]) expect(action.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Rooms: the product video loops muted left of its copy, and can be paused', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoMounted(page, '/');
  // The hero itself has no video in v10.
  await expect(hero(page).locator('video')).toHaveCount(0);
  const section = page.getByRole('region', { name: 'Every AI at the same table.' });
  await expect(section).toHaveAttribute('id', 'room');
  const frame = section.locator('.cc-lp-hero-frame');
  const video = frame.locator('video');
  await expect(video).toHaveAttribute('preload', 'none');
  await expect(video).toHaveAttribute('poster', '/brand/hero/central-city-hero-poster.jpg');
  await section.scrollIntoViewIfNeeded();
  await expect(video).toHaveAttribute('src', '/brand/hero/central-city-hero.mp4');
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted && v.loop)).toBe(true);
  // Visitors can stop the loop (WCAG 2.2.2).
  await frame.getByRole('button', { name: 'Pause video' }).click();
  await expect(frame.getByRole('button', { name: 'Play video' })).toBeVisible();
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  const media = await box(section.locator('.cc-feat-media'));
  const copy = await box(section.locator('.cc-feat-copy'));
  expect(media.x + media.width).toBeLessThanOrEqual(copy.x + 1);
  await expect(section.getByRole('link', { name: 'Invite your AI' })).toHaveAttribute(
    'href',
    '/connect',
  );
  // No old room picture.
  await expect(page.getByText('Example room')).toHaveCount(0);
});

test('section videos: phones download nothing, reduced motion keeps the posters', async ({
  page,
}) => {
  const fetched: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('.mp4')) fetched.push(request.url());
  });
  const videos = page.locator('main video');
  const scrollThrough = async () => {
    await expect(videos).toHaveCount(3);
    for (const video of await videos.all()) await video.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoMounted(page, '/');
  await scrollThrough();
  expect(fetched).toEqual([]);
  for (const video of await videos.all()) {
    await expect(video).not.toHaveAttribute('src', /./);
    await expect(video).toHaveAttribute('poster', /\.jpg$/);
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoMounted(page, '/');
  await scrollThrough();
  expect(fetched).toEqual([]);
  await expect(page.locator('main').getByRole('button', { name: /video/ })).toHaveCount(0);
});

test('landing follows the theme: the device setting by default, then the header toggle', async ({
  page,
}) => {
  // With no theme chosen the device setting applies: light here, dark from the header toggle.
  await page.emulateMedia({ colorScheme: 'light' });
  await gotoMounted(page, '/');
  const landing = page.locator('main.cc-lp');
  const nodeFill = () =>
    landing.evaluate((element) =>
      getComputedStyle(element).getPropertyValue('--lp-net-node-fill').trim().toLowerCase(),
    );
  const cardBackground = () =>
    page
      .locator('.cc-lp-hero-frame')
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
  await expect.poll(nodeFill).toMatch(/^#fff(fff)?$/);
  const lightCard = await cardBackground();

  await page.getByRole('banner').getByRole('button', { name: 'Use dark theme' }).click();
  await expect.poll(nodeFill).toBe('#0d131f');
  expect(await cardBackground()).not.toBe(lightCard);

  await page.getByRole('banner').getByRole('button', { name: 'Use light theme' }).click();
  await expect.poll(nodeFill).toMatch(/^#fff(fff)?$/);
  expect(await cardBackground()).toBe(lightCard);
});

/*
 * The v8 token names (mockups/v8/styles.css), as the design-system update will define them.
 * The landing reads these first and falls back to today's tokens, so its text must meet
 * WCAG AA with either set (shell.spec.ts checks today's tokens on every public page).
 */
const V8_TOKENS = {
  light: {
    '--bg-page': '#ffffff',
    '--bg-surface': '#f8f9fa',
    '--bg-surface-elevated': '#ffffff',
    '--border': '#e4e4e7',
    '--text-primary': '#09090b',
    '--text-secondary': '#52525b',
    '--text-muted': '#8e8e93',
    '--accent': '#0066ff',
    '--accent-text': '#0055d6',
    '--accent-subtle': 'rgba(0, 102, 255, 0.06)',
    '--accent-contrast': '#ffffff',
    '--status-live': '#10b981',
    '--room-bubble': '#f4f6f8',
  },
  dark: {
    '--bg-page': '#09090b',
    '--bg-surface': '#121214',
    '--bg-surface-elevated': '#18181b',
    '--border': '#27272a',
    '--text-primary': '#fafafa',
    '--text-secondary': '#a1a1aa',
    '--text-muted': '#71717a',
    '--accent': '#3b82f6',
    '--accent-text': '#93c5fd',
    '--accent-subtle': 'rgba(59, 130, 246, 0.14)',
    '--accent-contrast': '#ffffff',
    '--status-live': '#34d399',
    '--room-bubble': '#161619',
  },
};

/** Visible text in <main> (outside the room picture) under WCAG AA (4.5:1, 3:1 for large text), with a 0.1 margin. */
function lowContrastInMain(page: Page) {
  return page.evaluate(() => {
    const paint = document.createElement('canvas').getContext('2d')!;
    const rgba = (color: string) => {
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = color;
      paint.fillRect(0, 0, 1, 1);
      return [...paint.getImageData(0, 0, 1, 1).data];
    };
    const luminance = ([r, g, b]: number[]) =>
      [r!, g!, b!]
        .map((value) => value / 255)
        .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    const background = (element: Element | null): number[] => {
      for (; element; element = element.parentElement) {
        const value = rgba(getComputedStyle(element).backgroundColor);
        if (value[3]! > 200) return value;
      }
      return rgba(getComputedStyle(document.body).backgroundColor);
    };
    const low: string[] = [];
    let count = 0;
    const walker = document.createTreeWalker(document.querySelector('main')!, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const element = walker.currentNode.parentElement!;
      if (!walker.currentNode.textContent!.trim()) continue;
      if (!element.checkVisibility({ opacityProperty: true })) continue;
      const style = getComputedStyle(element);
      const [a, b] = [luminance(rgba(style.color)), luminance(background(element))];
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const large =
        parseFloat(style.fontSize) >= 24 ||
        (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      count++;
      // The room picture is an image of the room page (role img), drawn with that page's colours.
      if (ratio < (large ? 3.1 : 4.6))
        low.push(
          `${element.className}: ${walker.currentNode.textContent!.trim().slice(0, 30)} (${ratio.toFixed(2)})`,
        );
    }
    return { count, low };
  });
}

for (const scheme of ['light', 'dark'] as const)
  test(`landing text meets contrast with the v8 tokens too (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
    await gotoMounted(page, '/');
    await expect(page.locator('main video')).toHaveCount(3);
    await page.evaluate(
      ({ scheme, tokens }) => {
        const style = document.createElement('style');
        style.textContent = `:root, :root[data-theme] { ${Object.entries(tokens)
          .map(([name, value]) => `${name}: ${value};`)
          .join(' ')} }`;
        document.head.append(style);
        document.documentElement.dataset.theme = scheme;
      },
      { scheme, tokens: V8_TOKENS[scheme] },
    );
    const result = await lowContrastInMain(page);
    // The page's own text (the videos carry none): hero, sections 2 and 3, call to action.
    expect(result.count).toBeGreaterThan(10);
    expect(result.low).toEqual([]);
  });

test('the header keeps its menus off the logo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoMounted(page, '/');
  await expect(page.locator('.cc-header-nav button').first()).toBeVisible();
  await expect(page.locator('.cc-header .lockup').first()).toBeVisible();
  let lockup = await page.locator('.cc-header .lockup').first().boundingBox();
  let menus = await page.locator('.cc-header-nav button').first().boundingBox();
  // Both are measured once the header has finished its first layout.
  await expect
    .poll(async () => {
      lockup = await page.locator('.cc-header .lockup').first().boundingBox();
      menus = await page.locator('.cc-header-nav button').first().boundingBox();
      return Boolean(lockup && menus);
    })
    .toBe(true);
  expect(menus!.x - (lockup!.x + lockup!.width)).toBeGreaterThanOrEqual(24);
});
