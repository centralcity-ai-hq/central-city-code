import { test, expect, type Locator, type Page } from '@playwright/test';
import { gotoMounted } from './mounted';
import { NAV_GROUPS } from '../src/shell/links';

/*
 * The app shell (design system v8; src/shell/tokens.css and src/shell/shell.css): tokens, the
 * one font, the public header and footer, the signed-in header and the 404 page.
 */

/**
 * Waits until a public page has really rendered: its own main content and the footer are
 * visible, the boot screen is gone and the web font has loaded. Measuring earlier can catch
 * the boot screen (two text nodes), which is what made the contrast test flaky in CI.
 */
async function pageSettled(page: Page) {
  await expect(page.locator('.boot-screen')).toHaveCount(0);
  await expect(page.locator('main#main-content h1')).toBeVisible();
  await expect(page.getByRole('contentinfo')).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Serves index.html for SPA paths the local server does not list yet (Vercel rewrites them). */
async function serveSpa(page: Page, pattern: RegExp) {
  await page.route(pattern, async (route) => {
    const response = await route.fetch({
      url: new URL('/app.html', route.request().url()).toString(),
    });
    await route.fulfill({ response });
  });
}

/** Waits for running CSS transitions, so colours are measured at rest rather than mid-fade. */
async function settleTransitions(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/** Every visible text node with its colour against the nearest opaque background (WCAG 2.x). */
async function lowContrast(page: Page, root = 'body') {
  await settleTransitions(page);
  return page.evaluate((root) => {
    const canvas = document.createElement('canvas').getContext('2d')!;
    const rgba = (color: string) => {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);
      return [...canvas.getImageData(0, 0, 1, 1).data];
    };
    const luminance = ([r, g, b]: number[]) =>
      [r, g, b]
        .map((value) => value / 255)
        .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const background = (element: Element | null): number[] => {
      for (; element; element = element.parentElement) {
        const value = rgba(getComputedStyle(element).backgroundColor);
        if (value[3] > 200) return value;
      }
      return rgba(getComputedStyle(document.body).backgroundColor);
    };
    // Where a failing pair sits, so a report names the element, not just its text.
    const where = (element: Element) => {
      const parts: string[] = [];
      for (
        let node: Element | null = element;
        node && node !== document.body;
        node = node.parentElement
      ) {
        parts.unshift(
          node.tagName.toLowerCase() + [...node.classList].map((name) => `.${name}`).join(''),
        );
        if (parts.length === 3) break;
      }
      return parts.join(' > ');
    };
    const results: {
      text: string;
      where: string;
      colors: string;
      ratio: number;
      minimum: number;
    }[] = [];
    const walker = document.createTreeWalker(document.querySelector(root)!, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const element = node.parentElement!;
      const style = getComputedStyle(element);
      if (!node.textContent!.trim() || !element.checkVisibility({ opacityProperty: true }))
        continue;
      const [foreground, back] = [rgba(style.color), background(element)];
      const [a, b] = [luminance(foreground), luminance(back)];
      const large =
        parseFloat(style.fontSize) >= 24 ||
        (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      results.push({
        text: node.textContent!.trim().slice(0, 40),
        where: where(element),
        colors: `rgb(${foreground.slice(0, 3)}) on rgb(${back.slice(0, 3)})`,
        ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100,
        // WCAG AA is 4.5 (3 for large text); require a 0.1 margin so rendering differences
        // between browsers and platforms cannot tip a pair under the line.
        minimum: large ? 3.1 : 4.6,
      });
    }
    return { count: results.length, low: results.filter((item) => item.ratio < item.minimum) };
  }, root);
}

const tokens = (page: Page) =>
  page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string) => style.getPropertyValue(name).trim();
    const hex = (v: string) => v.replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, '#$1$1$2$2$3$3');
    return {
      canvas: hex(read('--canvas')),
      text: hex(read('--text')),
      link: hex(read('--link')),
      mention: hex(read('--mention')),
      primaryHover: hex(read('--primary-hover')),
      radiusS: read('--radius-s'),
      radiusL: read('--radius-l'),
      target: read('--target'),
      pageMax: read('--page-max'),
      // Durations in ms, whatever unit the minifier writes (240ms or .24s).
      dur3: Math.round(parseFloat(read('--dur-3')) * (read('--dur-3').endsWith('ms') ? 1 : 1000)),
      body: getComputedStyle(document.body).backgroundColor,
    };
  });

test('tokens follow the spec in light and dark, and the theme attribute wins', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await gotoMounted(page, '/');
  expect(await tokens(page)).toEqual({
    canvas: '#ffffff',
    text: '#09090b',
    link: '#0066ff',
    mention: '#0066ff',
    primaryHover: '#0052cc',
    radiusS: '6px',
    radiusL: '12px',
    target: '44px',
    pageMax: '1200px',
    dur3: 200,
    body: 'rgb(255, 255, 255)',
  });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  expect(await tokens(page)).toMatchObject({
    canvas: '#09090b',
    text: '#fafafa',
    link: '#98b0ff',
    mention: '#98b0ff',
    primaryHover: '#3a6af7',
    body: 'rgb(9, 9, 11)',
  });
  // An explicit choice overrides the system preference both ways.
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  expect((await tokens(page)).canvas).toBe('#ffffff');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  expect((await tokens(page)).canvas).toBe('#09090b');
  // Reduced motion zeroes durations.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect((await tokens(page)).dur3).toBe(0);
});

test('one font file: Inter latin, hashed, preloaded, and no Space Grotesk', async ({ page }) => {
  const fonts: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fonts.push(new URL(request.url()).pathname);
  });
  await gotoMounted(page, '/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const preload = page.locator('link[rel="preload"][as="font"]');
  await expect(preload).toHaveCount(1);
  // A content-hashed build URL, so it can be cached as immutable (DESIGN_SYSTEM §1.2).
  const href = (await preload.getAttribute('href'))!;
  expect(href).toMatch(/^\/assets\/inter-latin-wght-normal-[A-Za-z0-9_-]{6,}\.woff2$/);
  await expect(preload).toHaveAttribute('crossorigin', '');
  // The preloaded URL is the one the stylesheet uses: exactly one font request.
  expect([...new Set(fonts)]).toEqual([href]);
  expect(
    await page.evaluate(() => document.fonts.check('600 48px "Inter Variable"', 'Central')),
  ).toBe(true);
  const families = await page.evaluate(() =>
    [...document.querySelectorAll('h1, p, a, button')].map(
      (element) => getComputedStyle(element).fontFamily,
    ),
  );
  expect(families.every((family) => family.startsWith('"Inter Variable"'))).toBe(true);
  const css = await page.evaluate(() =>
    [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
      .join('\n'),
  );
  expect(css).not.toMatch(/Space Grotesk/i);
  // The sign-in and connect pages use the same single file.
  await page.goto('/#connect');
  await page.evaluate(() => document.fonts.ready);
  expect([...new Set(fonts)]).toEqual([href]);
});

const GROUP_LABELS = NAV_GROUPS.map((group) => group.label);

/** The open panel's content for a trigger (the panel is one region; each group has its own). */
const contentOf = async (page: Page, trigger: Locator) =>
  page.locator(`[id="${await trigger.getAttribute('aria-controls')}"]`);

test('public header: logo, four plain menus, Sign in, one primary action and the theme toggle', async ({
  page,
}) => {
  await gotoMounted(page, '/');
  const header = page.getByRole('banner');
  await expect(header.getByRole('link', { name: 'Central City home' })).toHaveAttribute(
    'href',
    '/',
  );
  const nav = header.getByRole('navigation', { name: 'Public' });
  expect(GROUP_LABELS).toEqual(['Product', 'Developers', 'Open Source', 'Company']);
  await expect(nav.getByRole('button')).toHaveText(GROUP_LABELS);
  for (const trigger of await nav.getByRole('button').all()) {
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Plain text: no chevron or other icon.
    await expect(trigger.locator('svg')).toHaveCount(0);
  }
  // "Downtown" (/downtown) is an Open Source menu item, never a top-level menu.
  await expect(nav.getByRole('button', { name: 'Downtown' })).toHaveCount(0);
  // Nothing is listed twice across the menus.
  const hrefs = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href));
  expect(new Set(hrefs).size).toBe(hrefs.length);
  // Balanced: logo and the menus on the left, Sign in and Invite your AI on the right.
  const left = (await nav.boundingBox())!;
  const right = (await header.locator('.cc-header-actions').boundingBox())!;
  expect(left.x + left.width).toBeLessThan(right.x);
  await expect(header.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute(
    'href',
    '/#signin',
  );
  const invite = header.getByRole('link', { name: 'Invite your AI' });
  // Signed out it opens the Connect page (connect your AI app first).
  await expect(invite).toHaveAttribute('href', '/connect');
  await expect(header.locator('.cc-header-invite')).toHaveCount(1);
  await expect(header.getByRole('button', { name: /Use (dark|light) theme/ })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Open menu' })).toBeHidden();
  // Transparent at the top; once scrolled, a grey layer behind the header (blurred page under it).
  const background = () =>
    page
      .locator('header.cc-header')
      .evaluate((element) => getComputedStyle(element, '::after').backgroundColor);
  expect(await background()).toBe('rgba(0, 0, 0, 0)');
  await page.mouse.wheel(0, 400);
  await expect.poll(background).toBe('rgb(255, 255, 255)');
});

test('public header: every menu link is a plain link; GitHub opens in a new tab', async ({
  page,
}) => {
  // The links, not the motion, are under test here.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await gotoMounted(page, '/');
  const nav = page.getByRole('banner').getByRole('navigation', { name: 'Public' });
  const seen = new Set<string>();
  for (const group of NAV_GROUPS) {
    const trigger = nav.getByRole('button', { name: group.label, exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const content = await contentOf(page, trigger);
    await expect(content).toHaveAttribute('data-active', 'true');
    await expect(content).toBeVisible();
    await expect(nav.locator('[aria-expanded="true"]')).toHaveCount(1);
    const links = content.getByRole('link');
    await expect(links).toHaveCount(group.items.length);
    // Plain text links: no chips, badges or icons (GitHub shows only ↗); one short line under
    // the name only where the item has a description (Product › Elric, Base Agents).
    await expect(content.locator('svg, img')).toHaveCount(0);
    await expect(content.locator('.cc-nav-description')).toHaveCount(
      group.items.filter((item) => item.description).length,
    );
    for (const section of new Set(group.items.map((item) => item.section).filter(Boolean)))
      await expect(content.getByRole('list', { name: section })).toBeVisible();
    for (const [index, item] of group.items.entries()) {
      const link = links.nth(index);
      await expect(link).toHaveAttribute('href', item.href);
      if (item.external) {
        expect(item.href).toMatch(/^https:\/\/github\.com\/centralcity-ai-hq\//);
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', /noopener/);
        await expect(link).toHaveAccessibleName(`${item.label} (opens in a new tab)`);
        await expect(link.locator('.cc-nav-external')).toHaveText('↗');
      } else {
        await expect(link).not.toHaveAttribute('target', /.*/);
        if (item.description) {
          // The name stays the name; the line under it describes the link.
          await expect(link).toHaveAccessibleName(`${item.label} ${item.description}`);
          await expect(link).toHaveAccessibleDescription(item.description);
          await expect(link).toHaveText(`${item.label}${item.description}`);
        } else {
          await expect(link).toHaveAccessibleName(item.label);
          await expect(link).toHaveText(item.label);
        }
        seen.add(item.href.split('#')[0]!);
      }
      expect(Math.round((await link.boundingBox())!.height), item.label).toBeGreaterThanOrEqual(44);
    }
  }
  // Every same-site link is a live page (no 404); hash routes resolve to /.
  for (const path of seen) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(200);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

/** What each same-site header target must show: its h1 (and the anchor, when it has one). */
const TARGET_HEADINGS: Record<string, string | RegExp> = {
  // The sign-in page (on a fresh install without accounts it offers the first account).
  '/#signin': /^(Welcome back\.|Create your account\.)$/,
  '/connect': 'Connect your AI',
  '/use-cases': 'Put your AIs to work together',
  // Elric signed out: Elric's own chat screen with its sign-in sheet (W2).
  '/elric': 'Elric',
  '/docs': 'Docs',
  '/status': 'Status',
  '/downtown': 'Downtown',
  '/downtown/verify': 'Verify the agent count',
  '/explorer': 'Agent Explorer',
  // Product › Base Agents: the Agent Explorer's On Base view.
  '/explorer/base': 'Agent Explorer',
  '/about': 'About Central City',
  '/contact': 'Contact',
  '/security': 'Security',
  '/privacy': 'Privacy Policy',
};
test('public header: every same-site target shows its expected page, and its anchor exists', async ({
  page,
}) => {
  const targets = NAV_GROUPS.flatMap((group) => group.items).filter((item) => !item.external);
  // The e2e server runs without CITY_ELRIC; Elric on answers a visitor 401 (off would be 404).
  await page.route('**/api/elric', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Sign in."}' }),
  );
  // Every same-site target has an expected heading (a new link needs one here).
  expect(targets.map((item) => item.href).sort()).toEqual(Object.keys(TARGET_HEADINGS).sort());
  for (const { href } of targets) {
    // A fresh load each time (a hash-only change would not re-route).
    await page.goto('about:blank');
    await page.goto(href);
    const heading = page.getByRole('heading', { level: 1 }).first();
    await expect(heading, href).toHaveText(TARGET_HEADINGS[href]!);
    const id = new URL(href, page.url()).hash.slice(1);
    if (id && !['connect', 'signin'].includes(id))
      await expect(page.locator(`[id="${id}"]`), href).toHaveCount(1);
  }
});

test('public header: the panel spans the width, blurs the page and follows the pointer', async ({
  page,
}) => {
  await gotoMounted(page, '/');
  const nav = page.getByRole('banner').getByRole('navigation', { name: 'Public' });
  const product = nav.getByRole('button', { name: 'Product' });
  const developers = nav.getByRole('button', { name: 'Developers' });
  const company = nav.getByRole('button', { name: 'Company' });
  const panel = page.locator('.cc-mega');
  const backdrop = page.locator('.cc-mega-backdrop');
  // Hover opens it: full width, under the header, the page behind blurred.
  await product.hover();
  await expect(product).toHaveAttribute('aria-expanded', 'true');
  await expect(await contentOf(page, product)).toBeVisible();
  await expect(backdrop).toBeVisible();
  // The measured motion: the page blurs 16 px under a 12 % dim that fades in 200 ms; the panel
  // is a solid surface (no backdrop blur: it would be invisible and cost a long frame) that fades
  // and drops 4 px in 200 ms (cubic-bezier(0.4, 0,
  // 0.2, 1)) and glides its height between groups in 260 ms (cubic-bezier(0.16, 1, 0.3, 1)).
  const styleOf = (locator: Locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        property: style.transitionProperty,
        duration: style.transitionDuration,
        timing: style.transitionTimingFunction,
        backdrop: style.backdropFilter,
        background: style.backgroundColor,
        willChange: style.willChange,
      };
    });
  const backdropStyle = await styleOf(backdrop);
  expect(backdropStyle.backdrop).toBe('blur(16px)');
  expect(backdropStyle.background).toBe('rgba(0, 0, 0, 0.12)');
  expect(backdropStyle.property).toContain('opacity');
  expect(backdropStyle.duration).toContain('0.2s');
  expect(backdropStyle.timing).toContain('cubic-bezier(0.4, 0, 0.2, 1)');
  const panelStyle = await styleOf(panel);
  expect(panelStyle.backdrop).toBe('none');
  expect(panelStyle.background).toMatch(/^rgb\(/); // opaque: rgb(), not rgba()
  expect(panelStyle.property).toMatch(/opacity.*transform.*height/);
  expect(panelStyle.duration).toMatch(/^0\.2s, 0\.2s, 0\.26s/);
  expect(panelStyle.timing).toMatch(
    /^cubic-bezier\(0\.4, 0, 0\.2, 1\), cubic-bezier\(0\.4, 0, 0\.2, 1\), cubic-bezier\(0\.16, 1, 0\.3, 1\)/,
  );
  expect(panelStyle.willChange).toContain('transform');
  // From here on the pointer behaviour is under test, not the animation: no motion, so every
  // measurement is of a settled state.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Full width, directly under the header (inside its bottom border).
  await expect
    .poll(async () => (await panel.boundingBox())!.width)
    .toBe(await page.evaluate(() => document.documentElement.clientWidth));
  const headerBox = (await page.locator('header.cc-header').boundingBox())!;
  expect(
    Math.abs((await panel.boundingBox())!.y - (headerBox.y + headerBox.height)),
  ).toBeLessThanOrEqual(1);
  // One persistent panel: its height follows the active group's content.
  const settledHeight = async () => {
    let last = -1;
    await expect
      .poll(async () => {
        const now = Math.round((await panel.boundingBox())!.height);
        const same = now === last;
        last = now;
        return same;
      })
      .toBe(true);
    return last;
  };
  const productHeight = await settledHeight();
  await developers.hover();
  await expect(developers).toHaveAttribute('aria-expanded', 'true');
  await expect(product).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toHaveAttribute('data-open', 'true');
  await expect(await contentOf(page, developers)).toBeVisible();
  await expect(await contentOf(page, product)).toBeHidden();
  const developersHeight = await settledHeight();
  // Product (with Elric's description line) and Developers differ in height.
  expect(developersHeight).not.toBe(productHeight);
  expect(developersHeight).toBe(
    Math.round(
      await (
        await contentOf(page, developers)
      ).evaluate((element) => (element as HTMLElement).offsetHeight),
    ),
  );
  // Resting on another trigger switches to it; the panel never closes in between.
  await company.hover();
  await expect(company).toHaveAttribute('aria-expanded', 'true');
  await expect(panel).toHaveAttribute('data-open', 'true');
  // A click on the trigger its hover opened keeps it open, however slow (it never toggles it
  // shut; Enter and Space toggle).
  await page.waitForTimeout(800);
  await company.click();
  await expect(company).toHaveAttribute('aria-expanded', 'true');
  // A diagonal move from a trigger down into the panel never closes it.
  await developers.hover();
  const trigger = (await developers.boundingBox())!;
  const firstLink = (await contentOf(page, developers)).getByRole('link').first();
  const link = (await firstLink.boundingBox())!;
  await page.mouse.move(trigger.x + trigger.width / 2, trigger.y + trigger.height / 2);
  await page.mouse.move(link.x + 10, link.y + link.height / 2, { steps: 12 });
  await page.waitForTimeout(400);
  // It never closes on the way (the triggers span the header's height, and closing waits).
  await expect(panel).toHaveAttribute('data-open', 'true');
  // Leaving header and panel closes it shortly after; the blur fades out.
  await page.mouse.move(700, 800);
  await expect(developers).toHaveAttribute('aria-expanded', 'false');
  await expect(backdrop).toBeHidden();
  // A click on the blurred page closes it too.
  await product.click();
  await expect(product).toHaveAttribute('aria-expanded', 'true');
  await page.mouse.click(700, 800);
  await expect(product).toHaveAttribute('aria-expanded', 'false');
});

test('public header: a diagonal across another trigger into the panel keeps the group', async ({
  page,
}) => {
  // The page's clock is controlled, so the 100 ms hover intent does not depend on how fast the
  // machine moves the mouse.
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await gotoMounted(page, '/');
  const nav = page.getByRole('banner').getByRole('navigation', { name: 'Public' });
  const developers = nav.getByRole('button', { name: 'Developers' });
  const openSource = nav.getByRole('button', { name: 'Open Source' });
  await expect(developers).toBeVisible();
  // From here, time moves only when the test says so.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  await openSource.hover();
  await page.clock.runFor(150);
  await expect(openSource).toHaveAttribute('aria-expanded', 'true');
  const from = (await openSource.boundingBox())!;
  const via = (await developers.boundingBox())!;
  const first = (await contentOf(page, openSource)).getByRole('link').first();
  const to = (await first.boundingBox())!;
  // Down-left across Developers (no time passes on it) and into Open Source's first link.
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.move(via.x + via.width / 2, via.y + via.height - 4, { steps: 2 });
  await page.clock.runFor(50);
  await page.mouse.move(to.x + 8, to.y + to.height / 2, { steps: 2 });
  await page.clock.runFor(300);
  await expect(openSource).toHaveAttribute('aria-expanded', 'true');
  await expect(developers).toHaveAttribute('aria-expanded', 'false');
  await expect(first).toBeVisible();
  // Resting on Developers past the 100 ms intent does switch.
  await developers.hover();
  await page.clock.runFor(150);
  await expect(developers).toHaveAttribute('aria-expanded', 'true');
  await expect(openSource).toHaveAttribute('aria-expanded', 'false');
});

test('public header: a menu opened from the keyboard stays open under a resting mouse', async ({
  page,
}) => {
  await gotoMounted(page, '/');
  const developers = page
    .getByRole('banner')
    .getByRole('navigation', { name: 'Public' })
    .getByRole('button', { name: 'Developers' });
  // The mouse rests over the page, where the blurred backdrop will appear.
  await page.mouse.move(700, 600);
  await developers.focus();
  await page.keyboard.press('Enter');
  await expect(developers).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(600);
  await expect(developers).toHaveAttribute('aria-expanded', 'true');
  // Real movement over the page closes it (shortly after).
  await page.mouse.move(720, 640, { steps: 4 });
  await expect(developers).toHaveAttribute('aria-expanded', 'false');
});

test('public header: hover intent: passing over a trigger does not open the panel', async ({
  page,
}) => {
  await gotoMounted(page, '/');
  const nav = page.getByRole('banner').getByRole('navigation', { name: 'Public' });
  const developers = nav.getByRole('button', { name: 'Developers' });
  const box = (await developers.boundingBox())!;
  // Sweep across the triggers quickly (well under the 100 ms intent delay) and off the header.
  await page.mouse.move(box.x - 150, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width + 300, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(box.x + box.width + 300, 600);
  await page.waitForTimeout(300);
  await expect(nav.locator('[aria-expanded="true"]')).toHaveCount(0);
  await expect(page.locator('.cc-mega')).not.toHaveAttribute('data-open', /.*/);
  // Resting on a trigger opens it.
  await developers.hover();
  await expect(developers).toHaveAttribute('aria-expanded', 'true');
});

test('public header: the panel does not animate with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await gotoMounted(page, '/');
  const product = page
    .getByRole('banner')
    .getByRole('navigation', { name: 'Public' })
    .getByRole('button', { name: 'Product' });
  await product.click();
  await expect(await contentOf(page, product)).toBeVisible();
  // No transition (the global reduced-motion rule may leave a near-zero duration).
  for (const selector of [
    '.cc-mega',
    '.cc-mega-backdrop',
    '.cc-mega-content[data-active]',
    'header.cc-header',
  ]) {
    const durations = await page
      .locator(selector)
      .evaluate((element) => getComputedStyle(element).transitionDuration);
    for (const duration of durations.split(','))
      expect(parseFloat(duration), `${selector}: ${durations}`).toBeLessThanOrEqual(0.01);
  }
  // No transform either: the panel and its content are simply there.
  for (const selector of ['.cc-mega', '.cc-mega-content[data-active]'])
    expect(
      await page.locator(selector).evaluate((element) => getComputedStyle(element).transform),
      selector,
    ).toBe('none');
});

test('public header at 390 px: the menu still lists every link if its chunk fails to load', async ({
  page,
}) => {
  await page.route(/\/assets\/PhoneMenu-[^/]*\.js$/, (route) => route.abort());
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoMounted(page, '/');
  const header = page.getByRole('banner');
  await header.getByRole('button', { name: 'Open menu' }).click();
  const menu = header.getByRole('navigation', { name: 'Menu' });
  const items = NAV_GROUPS.flatMap((group) => group.items);
  await expect(menu.getByRole('link')).toHaveCount(items.length + 1);
  for (const item of items)
    await expect(
      menu.getByRole('link', {
        name: item.external
          ? `${item.label} (opens in a new tab)`
          : item.description
            ? `${item.label} ${item.description}`
            : item.label,
        exact: true,
      }),
    ).toHaveAttribute('href', item.href);
  await expect(menu.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  // Like the real menu: focus moves into it on open, and Escape closes it with focus back on the
  // menu button.
  await expect(menu.getByRole('link').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Open menu' })).toBeFocused();
  // The page stays: no error screen, no reload.
  await expect(page.getByRole('heading', { level: 1, name: 'Every AI. One room.' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('public header: signed out shows Sign in; signed in shows Open app, and Workspace opens the app', async ({
  page,
}) => {
  const sessions: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/session') sessions.push(request.url());
  });
  // Signed out.
  await page.goto('/docs');
  const header = page.getByRole('banner');
  const nav = header.getByRole('navigation', { name: 'Public' });
  await expect(header.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute(
    'href',
    '/#signin',
  );
  await expect(header.getByRole('link', { name: 'Open app' })).toHaveCount(0);
  await nav.getByRole('button', { name: 'Product' }).click();
  await expect(header.getByRole('link', { name: 'Workspace', exact: true })).toHaveAttribute(
    'href',
    '/#signin',
  );
  // The header reads the session once per page load and never polls (the app shell makes its
  // own read on the same load, so at most two, and no more later).
  await page.waitForTimeout(500);
  const firstLoad = sessions.length;
  expect(firstLoad).toBeGreaterThanOrEqual(1);
  expect(firstLoad).toBeLessThanOrEqual(2);
  await page.waitForTimeout(2000);
  expect(sessions).toHaveLength(firstLoad);

  // Signed in (a throwaway account on the test server).
  const created = await page.request.post('/api/auth/register', {
    headers: { 'x-city-request': '1' },
    data: {
      name: `Header-${crypto.randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(created.status()).toBe(201);
  await page.goto('/docs');
  await expect(header.getByRole('link', { name: 'Open app' })).toHaveAttribute('href', '/rooms');
  await expect(header.getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
  await nav.getByRole('button', { name: 'Product' }).click();
  await expect(header.getByRole('link', { name: 'Workspace', exact: true })).toHaveAttribute(
    'href',
    '/rooms',
  );
  await header.getByRole('link', { name: 'Open app' }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await expect(page.getByRole('navigation', { name: 'Rooms' })).toBeVisible();
  // The phone menu shows the same.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/downtown');
  await header.getByRole('button', { name: 'Open menu' }).click();
  const menu = header.getByRole('navigation', { name: 'Menu' });
  await expect(menu.getByRole('link', { name: 'Open app' })).toHaveAttribute('href', '/rooms');
  await menu.getByRole('button', { name: 'Product' }).click();
  await expect(menu.getByRole('link', { name: 'Workspace', exact: true })).toHaveAttribute(
    'href',
    '/rooms',
  );
});

test('public header menus work with the keyboard', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await gotoMounted(page, '/');
  const nav = page.getByRole('banner').getByRole('navigation', { name: 'Public' });
  const product = nav.getByRole('button', { name: 'Product' });
  const developers = nav.getByRole('button', { name: 'Developers' });
  await product.focus();
  // Enter opens; Tab enters its links and moves through them; Shift+Tab from the first link
  // returns to the trigger.
  await page.keyboard.press('Enter');
  await expect(product).toHaveAttribute('aria-expanded', 'true');
  const productLinks = (await contentOf(page, product)).getByRole('link');
  await page.keyboard.press('Tab');
  await expect(productLinks.first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(product).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(productLinks.first()).toBeFocused();
  for (let index = 1; index < (await productLinks.count()); index++)
    await page.keyboard.press('Tab');
  await expect(productLinks.last()).toBeFocused();
  // Tab past the last link moves on to the next trigger and closes the panel.
  await page.keyboard.press('Tab');
  await expect(developers).toBeFocused();
  await expect(product).toHaveAttribute('aria-expanded', 'false');
  // ArrowDown opens a menu on its first link; Escape closes it and returns focus to its trigger.
  await page.keyboard.press('ArrowDown');
  await expect(developers).toHaveAttribute('aria-expanded', 'true');
  const developerLinks = (await contentOf(page, developers)).getByRole('link');
  await expect(developerLinks.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(developers).toHaveAttribute('aria-expanded', 'false');
  await expect(developers).toBeFocused();
  await expect(developerLinks.first()).toBeHidden();
  // Shift+Tab moves back between triggers; Space toggles.
  await page.keyboard.press('Shift+Tab');
  await expect(product).toBeFocused();
  await page.keyboard.press('Space');
  await expect(product).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Space');
  await expect(product).toHaveAttribute('aria-expanded', 'false');
  // Choosing a same-site link closes the panel and navigates.
  await nav.getByRole('button', { name: 'Open Source' }).click();
  await page.getByRole('banner').getByRole('link', { name: 'Downtown', exact: true }).click();
  await expect(page).toHaveURL(/\/downtown$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Downtown' })).toBeVisible();
  await expect(page).toHaveTitle('Downtown · Central City');
  const openSource = page
    .getByRole('banner')
    .getByRole('navigation', { name: 'Public' })
    .getByRole('button', { name: 'Open Source' });
  await expect(openSource).toHaveAttribute('aria-expanded', 'false');
  // The current page's link is marked inside its group.
  await openSource.click();
  await expect(
    page.getByRole('banner').getByRole('link', { name: 'Downtown', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  // Marked for assistive technology only: it looks like the other links in its menu.
  const color = (name: string) =>
    page
      .getByRole('banner')
      .getByRole('link', { name, exact: true })
      .evaluate((link) => getComputedStyle(link).color);
  expect(await color('Downtown')).toBe(await color('Verify'));
});

test('public header at 390 px: a full-screen menu with the four groups as sections', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoMounted(page, '/');
  const header = page.getByRole('banner');
  const invite = header.getByRole('link', { name: 'Invite your AI' });
  expect(await invite.innerText()).toBe('Invite AI');
  await expect(header.getByRole('navigation', { name: 'Public' })).toBeHidden();
  const box = await page.locator('.cc-header-inner').boundingBox();
  expect(box!.height).toBeLessThanOrEqual(64);
  const menuButton = header.getByRole('button', { name: 'Open menu' });
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await menuButton.click();
  const menu = header.getByRole('navigation', { name: 'Menu' });
  // Full screen: from under the header to the bottom of the viewport (once its entrance ends).
  await page
    .locator('.cc-header-menu')
    .evaluate((element) => Promise.all(element.getAnimations().map((motion) => motion.finished)));
  const sheet = (await page.locator('.cc-header-menu').boundingBox())!;
  expect(Math.round(sheet.y + sheet.height)).toBe(844);
  expect(Math.round(sheet.width)).toBe(390);
  // The same four groups, collapsed, then Sign in; the theme below.
  const groups = menu.locator('.cc-menu-group-button');
  await expect(groups).toHaveText(GROUP_LABELS);
  for (const group of await groups.all())
    await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(groups.first()).toBeFocused();
  await expect(menu.getByRole('link')).toHaveText(['Sign in']);
  await expect(header.getByRole('button', { name: /Use (dark|light) theme/ })).toBeVisible();
  await expect(groups.filter({ hasText: 'Downtown' })).toHaveCount(0);
  // Each section opens on its own links, with the same hrefs and new-tab rules as the wide menus.
  for (const group of NAV_GROUPS) {
    const button = menu.getByRole('button', { name: group.label, exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator(`[id="${await button.getAttribute('aria-controls')}"]`);
    const links = panel.getByRole('link');
    await expect(links).toHaveCount(group.items.length);
    for (const [index, item] of group.items.entries()) {
      await expect(links.nth(index)).toHaveAttribute('href', item.href);
      if (item.external) {
        await expect(links.nth(index)).toHaveAttribute('target', '_blank');
        await expect(links.nth(index)).toHaveAttribute('rel', /noopener/);
      }
    }
    await button.click();
    await expect(panel).toBeHidden();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Collapse animations change which controls are visible. Measure one DOM snapshot instead
  // of retaining nth() locators whose indices shift while the sections settle.
  await expect
    .poll(() =>
      header.locator('a:visible, button:visible').evaluateAll((controls) =>
        controls
          .map((control) => ({
            label: control.textContent?.trim(),
            height: control.getBoundingClientRect().height,
          }))
          .filter((control) => control.height < 44),
      ),
    )
    .toEqual([]);
  // Escape closes the menu and returns focus to its button. Under CI load the first key press
  // can land while the sections still settle, so it is retried until the menu is gone.
  await expect(async () => {
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0, { timeout: 1_000 });
  }).toPass();
  await expect(header.getByRole('button', { name: 'Open menu' })).toBeFocused();
  // Choosing a link closes the menu.
  await header.getByRole('button', { name: 'Open menu' }).click();
  await menu.getByRole('button', { name: 'Open Source' }).click();
  await menu.getByRole('link', { name: 'Downtown', exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(page).toHaveURL(/\/downtown$/);
});

test('footer bottom row has 44 px targets; the font licence lives on the open source page', async ({
  page,
}) => {
  await serveSpa(page, /\/downtown\/?$/);
  await gotoMounted(page, '/');
  const footer = page.getByRole('contentinfo');
  await expect(footer.getByRole('link', { name: /font licen/i })).toHaveCount(0);
  const bottom = footer.locator('.cc-footer-bottom a');
  await expect(bottom).toHaveCount(6);
  // Socials at the start of the bottom row: X and the public GitHub repository.
  await expect(footer.getByRole('link', { name: 'Central City on X' })).toHaveAttribute(
    'href',
    'https://x.com/centralcityai',
  );
  await expect(footer.getByRole('link', { name: 'Central City on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/centralcity-ai-hq/central-city-code',
  );
  for (const link of await bottom.all())
    expect((await link.boundingBox())!.height, await link.innerText()).toBeGreaterThanOrEqual(44);
  await page.goto('/downtown');
  const licence = page.getByRole('link', { name: 'SIL Open Font License' });
  await expect(licence).toHaveAttribute('href', '/licenses/inter-OFL.txt');
  expect((await page.request.get('/licenses/inter-OFL.txt')).status()).toBe(200);
});

test('landing hero at 1440 px: centred on the page, copy centred in the left half, video right', async ({
  page,
}) => {
  await gotoMounted(page, '/');
  const hero = page.getByRole('region', { name: 'Every AI. One room.' });
  const box = (await hero.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - 1440 / 2)).toBeLessThanOrEqual(2);
  // Two equal columns (claude.com's hero): the copy fills the left one, the video the right.
  const copy = (await hero.locator('.cc-lp-hero-copy').boundingBox())!;
  const media = (await hero.locator('.cc-lp-hero-media').boundingBox())!;
  expect(Math.abs(copy.width - media.width)).toBeLessThanOrEqual(2);
  expect(copy.x + copy.width).toBeLessThanOrEqual(media.x);
  // The actions row is centred in the copy column: equal space left and right of its buttons.
  const first = (await hero.locator('.hero-actions > *').first().boundingBox())!;
  const last = (await hero.locator('.hero-actions > *').last().boundingBox())!;
  const left = first.x - copy.x;
  const right = copy.x + copy.width - (last.x + last.width);
  expect(left).toBeGreaterThan(24);
  expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
  await expect(hero.locator('.cc-lp-hero-copy')).toHaveCSS('text-align', 'center');
});

test('unknown paths show the 404 page in the public shell', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await serveSpa(page, /\/no-such-page$/);
  await page.goto('/no-such-page');
  await expect(
    page.getByRole('heading', { level: 1, name: 'This page doesn’t exist.' }),
  ).toBeVisible();
  await expect(page).toHaveTitle('Page not found · Central City');
  await expect(page.getByText('The link may be old or mistyped.')).toBeVisible();
  // Paths the SPA serves are never a 404: room pages and the client routes.
  for (const path of ['/r/launch-plan', '/downtown', '/connect']) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(200);
  }
  await expect(page.getByRole('banner')).toHaveCount(1);
  await expect(page.getByRole('contentinfo')).toHaveCount(1);
  await expect(page.locator('main .button.primary')).toHaveCount(1);
  for (const path of ['/r/launch-plan', '/connect']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }), path).not.toHaveText(
      'This page doesn’t exist.',
    );
  }
  await page.goto('/no-such-page');
  await page.getByRole('link', { name: 'Go home' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Every AI. One room.' })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`public pages meet text contrast in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    // Store the choice too, so the checked theme does not depend on the device setting.
    await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
    await serveSpa(page, /\/(downtown|no-such-page)\/?$/);
    for (const path of ['/', '/#signin', '/#connect', '/downtown', '/workflows', '/no-such-page']) {
      await page.goto(path);
      await pageSettled(page);
      const result = await lowContrast(page);
      expect(result.count, path).toBeGreaterThan(8);
      expect(result.low, path).toEqual([]);
    }
  });
}

test('the landing page downloads no console code (route-level code splitting)', async ({
  page,
}) => {
  const scripts: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname);
  });
  await gotoMounted(page, '/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const names = scripts.map((path) =>
    path.replace(/^\/assets\//, '').replace(/-[A-Za-z0-9_-]{8}\.js$/, ''),
  );
  expect(names).toContain('vendor');
  expect(names).toContain('Landing');
  for (const console of ['App', 'Connect', 'Downtown', 'components'])
    expect(names, console).not.toContain(console);
  // Signing in then loads the console chunk on demand.
  await page.getByRole('banner').getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Account name')).toBeVisible();
  expect(scripts.some((path) => /\/assets\/App-[^/]+\.js$/.test(path))).toBe(true);
});

test('a chunk that fails to load reloads up to three times, then shows the error state', async ({
  page,
}) => {
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });
  await page.route(/\/assets\/Landing-[^/]+\.js$/, (route) => route.abort());
  await gotoMounted(page, '/');
  const alert = page.getByRole('alert');
  // The reloads wait 0, 1 and 3 s (src/shell/ErrorBoundary.tsx, RELOAD_DELAYS_MS).
  await expect(alert.getByRole('heading', { name: 'Something went wrong.' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(alert.getByText('We couldn’t load this page. Try again in a moment.')).toBeVisible();
  expect(navigations).toBe(4); // the first load plus three automatic reloads
  await alert.getByText('Details').click();
  await expect(alert.getByText('chunk_load_failed')).toBeVisible();
  // Once the chunk is reachable again, "Reload" recovers.
  await page.unroute(/\/assets\/Landing-[^/]+\.js$/);
  await alert.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Every AI. One room.' })).toBeVisible();
});

test('a chunk a deploy removed reloads the page once, keeping the query and hash', async ({
  page,
}) => {
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });
  // The old build's chunk is gone (404) for the first page only; the reload gets the new one.
  await page.route(/\/assets\/Landing-[^/]+\.js$/, (route) =>
    navigations <= 1 ? route.fulfill({ status: 404, body: 'Not found' }) : route.continue(),
  );
  const preloadErrors: string[] = [];
  await page.exposeFunction('notePreloadError', (message: string) => {
    preloadErrors.push(message);
  });
  await page.addInitScript(() =>
    window.addEventListener('vite:preloadError', (event) =>
      (window as unknown as { notePreloadError: (m: string) => void }).notePreloadError(
        String((event as Event & { payload?: unknown }).payload),
      ),
    ),
  );
  await gotoMounted(page, '/?from=deploy#how');
  await expect(page.getByRole('heading', { level: 1, name: 'Every AI. One room.' })).toBeVisible();
  expect(preloadErrors.length).toBeGreaterThan(0);
  expect(navigations).toBe(2); // the first load plus exactly one automatic reload
  const url = new URL(page.url());
  expect(url.search).toBe('?from=deploy');
  expect(url.hash).toBe('#how');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('on the landing page the header button steps back while the hero button is visible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await gotoMounted(page, '/');
  const header = page.getByRole('banner').getByRole('link', { name: 'Invite your AI' });
  await expect(header).toHaveClass(/\bsecondary\b/);
  // It swaps in one step: a fading background under an instantly switched text colour showed dark
  // text on blue for a moment (below AA).
  expect(
    await header.evaluate((el) =>
      getComputedStyle(el)
        .transitionDuration.split(',')
        .every((d) => parseFloat(d) === 0),
    ),
  ).toBe(true);
  // v8 intentionally has a filled hero 'Sign up' and a filled CTA 'Invite your AI' (the v8 landing).
  // Allow up to two filled primary buttons on the landing page while the header button steps back.
  const filledButtons = await page.locator('.button.primary:visible').count();
  expect(filledButtons).toBeGreaterThanOrEqual(1);
  expect(filledButtons).toBeLessThanOrEqual(2);
  await page.locator('#how').scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 2000);
  await expect(header).toHaveClass(/\bprimary\b/);
  // Other pages have no hero button, so the header's is primary.
  await page.goto('/#connect');
  await expect(page.getByRole('banner').getByRole('link', { name: 'Invite your AI' })).toHaveClass(
    /\bprimary\b/,
  );
});

test('Developers has no Open source section; the code on GitHub is under Open Source', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/status');
  const nav = page.getByRole('banner').getByRole('navigation', { name: 'Public' });
  await nav.getByRole('button', { name: 'Developers', exact: true }).click();
  const developers = page.locator('.cc-mega-content[data-active="true"]');
  await expect(developers.locator('.cc-mega-section .cc-mega-label')).toHaveCount(0);
  await expect(developers.getByRole('link', { name: /on GitHub/ })).toHaveCount(0);
  await nav.getByRole('button', { name: 'Open Source', exact: true }).click();
  const openSource = page.locator('.cc-mega-content[data-active="true"]');
  // The repositories are listed on /downtown, so the menu does not link the code repository too.
  await expect(openSource.getByRole('link', { name: /^Central City on GitHub/ })).toHaveCount(0);
  await expect(openSource.getByRole('link', { name: 'Downtown', exact: true })).toHaveAttribute(
    'href',
    '/downtown',
  );
});

test('a prerendered page shows its text at once and its menus work once the app is on', async ({
  page,
}) => {
  // Hold the page's chunk back, so the prerendered copy stays on screen for a while.
  await page.route(/\/assets\/Trust-[^/]*\.js$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/status');
  await expect(page.getByRole('heading', { level: 1, name: 'Status' })).toBeVisible();
  // Until the app is on, the copy's controls are marked disabled, so nobody acts on a dead one.
  await expect(page.locator('#root')).toHaveAttribute('aria-disabled', 'true');
  const nav = page.getByRole('banner').getByRole('navigation', { name: 'Public' });
  await nav.getByRole('button', { name: 'Open Source', exact: true }).click();
  await expect(page.locator('#root')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#root')).not.toHaveAttribute('aria-busy', 'true');
  await expect(
    page.locator('.cc-mega-content[data-active="true"]').getByRole('link', {
      name: 'Downtown',
      exact: true,
    }),
  ).toHaveAttribute('href', '/downtown');
  await expect(page.getByText('Opening Central City')).toHaveCount(0);
});

test('scrolled header: solid, so page text never shows through it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/docs/api');
  await page.mouse.wheel(0, 1600);
  const header = page.locator('header.cc-header');
  await expect(header).toHaveClass(/is-scrolled/);
  // Let the background transition finish before reading the computed style.
  await page.waitForTimeout(600);
  const style = await header.evaluate((el) => {
    const s = getComputedStyle(el, '::after');
    return {
      bg: s.backgroundColor,
      blur: s.backdropFilter || s.getPropertyValue('-webkit-backdrop-filter'),
    };
  });
  expect(style.blur).toContain('blur(');
  const [r, g, b, a = 1] = style.bg.match(/[\d.]+/g)!.map(Number);
  expect(a).toBe(1);
  expect([r, g, b]).toEqual([255, 255, 255]);
});

test('an open menu panel is solid white, the page below it is dimmed and blurred', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/docs/api');
  await page.mouse.wheel(0, 1600);
  const nav = page.getByRole('banner').getByRole('navigation', { name: 'Public' });
  await nav.getByRole('button', { name: 'Product', exact: true }).click();
  const panel = page.locator('.cc-mega');
  await expect(panel).toBeVisible();
  await page.waitForTimeout(400);
  const bg = await panel.evaluate((el) => getComputedStyle(el).backgroundColor);
  const [r, g, b, a = 1] = bg.match(/[\d.]+/g)!.map(Number);
  expect(a).toBe(1);
  expect([r, g, b]).toEqual([255, 255, 255]);
  const veil = await page
    .locator('.cc-mega-backdrop')
    .evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(veil).toContain('blur(16px)');
});

test('signed out, /connect and /invite open in place from a link, without reloading the page', async ({
  page,
}) => {
  await gotoMounted(page, '/');
  let loads = 0;
  page.on('load', () => loads++);
  for (const [path, heading] of [
    ['/connect', 'Connect your AI'],
    ['/invite', 'Invite your AI'],
  ] as const) {
    await page.evaluate((href) => {
      const link = document.createElement('a');
      link.href = href;
      document.body.append(link);
      link.click();
      link.remove();
    }, path);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  }
  expect(loads).toBe(0);
});
