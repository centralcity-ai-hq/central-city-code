import { test, expect, type Page } from '@playwright/test';

/*
 * Motion and touch on a phone (src/shell/motion.css, the motion tokens in tokens.css, and
 * src/shell/pageNavigation.ts): the menu, sections and footer accordions come and go with
 * motion, page changes keep the page on screen instead of reloading, and
 * prefers-reduced-motion turns all of it off.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/**
 * Opens a page and waits for the app to take over from the prerendered copy (#root loses
 * aria-busy): before that, controls are the static copy's and toggle natively.
 */
async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('#root')).not.toHaveAttribute('aria-busy');
}

/** The animations running on an element (CSS animations and transitions), by name. */
const running = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) =>
      element
        .getAnimations()
        .map((motion) =>
          motion instanceof CSSAnimation
            ? motion.animationName
            : motion instanceof CSSTransition
              ? motion.transitionProperty
              : 'script',
        ),
    );

test('the phone menu slides in, and stays a moment to fade out when closed', async ({ page }) => {
  await open(page, '/');
  const header = page.getByRole('banner');
  const button = header.locator('.cc-header-menu-button');
  await expect(button).toBeVisible();
  // Records what the menu does as it happens (timing-proof on a slow machine).
  await page.evaluate(() => {
    const seen: { entrance?: string[]; closing?: boolean; inert?: boolean; removed?: boolean } = {};
    (window as unknown as { menuSeen: typeof seen }).menuSeen = seen;
    let menu: Element | null = null;
    new MutationObserver(() => {
      const now = document.querySelector('.cc-header-menu');
      if (now && !menu) {
        menu = now;
        seen.entrance = now
          .getAnimations()
          .map((motion) => (motion instanceof CSSAnimation ? motion.animationName : ''));
      }
      if (menu && menu.getAttribute('data-state') === 'closing' && !seen.closing) {
        seen.closing = true;
        seen.inert = (menu as HTMLElement).inert;
      }
      if (menu && !now) seen.removed = true;
    }).observe(document.body, { childList: true, subtree: true, attributes: true });
  });
  await button.tap();
  const menu = page.locator('.cc-header-menu');
  await expect(menu).toBeVisible();
  // No grey flash on tap; the controls skip the double-tap zoom wait.
  const touch = await button.evaluate((element) => ({
    highlight: getComputedStyle(element).getPropertyValue('-webkit-tap-highlight-color'),
    action: getComputedStyle(element).touchAction,
  }));
  expect(touch).toEqual({ highlight: 'rgba(0, 0, 0, 0)', action: 'manipulation' });

  await header.getByRole('button', { name: 'Close menu' }).tap();
  // The button answers at once; the menu leaves with its exit, inert meanwhile, then unmounts.
  await expect(header.getByRole('button', { name: 'Open menu' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(menu).toHaveCount(0);
  const seen = await page.evaluate(() => (window as unknown as { menuSeen: object }).menuSeen);
  expect(seen).toEqual({
    entrance: ['cc-fade-in', 'cc-glide-down'],
    closing: true,
    inert: true,
    removed: true,
  });
});

test('a menu section eases open and shut; closed, its links are hidden', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('button', { name: 'Open menu' }).tap();
  const menu = page.getByRole('navigation', { name: 'Menu' });
  const section = menu.getByRole('button', { name: 'Product', exact: true });
  const panel = page.locator(`[id="${await section.getAttribute('aria-controls')}"]`);
  await expect(panel).toBeHidden();
  // Records the transitions the panel runs (timing-proof on a slow machine).
  await panel.evaluate((element) => {
    const seen: string[] = [];
    (window as unknown as { panelRuns: string[] }).panelRuns = seen;
    element.addEventListener('transitionrun', (event) => {
      if (event.target === element) seen.push((event as TransitionEvent).propertyName);
    });
  });
  await section.tap();
  await expect(section).toHaveAttribute('aria-expanded', 'true');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { panelRuns: string[] }).panelRuns))
    .toContain('grid-template-rows');
  await expect(panel.getByRole('link').first()).toBeVisible();
  await section.tap();
  await expect(section).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toBeHidden();
  await expect(panel.getByRole('link').first()).toBeHidden();
});

test('a footer accordion animates its height and closes after its exit', async ({ page }) => {
  await open(page, '/');
  const footer = page.getByRole('contentinfo');
  const details = footer.locator('details').last();
  await details.locator('summary').scrollIntoViewIfNeeded();
  // Records the height animations the accordion starts (timing-proof on a slow machine).
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { animated: string[] }).animated = seen;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<typeof animate>) {
      seen.push(this.tagName.toLowerCase());
      return animate.apply(this, args);
    };
  });
  await details.locator('summary').tap();
  await expect(details).toHaveAttribute('open', '');
  expect(await page.evaluate(() => (window as unknown as { animated: string[] }).animated)).toEqual(
    ['nav'],
  );
  await expect(footer.getByRole('link', { name: 'Imprint' })).toBeVisible();
  await details.locator('summary').tap();
  // Still open while it eases shut, then closed.
  await expect(details).not.toHaveAttribute('open');
  await expect(footer.getByRole('link', { name: 'Imprint' })).toBeHidden();
});

test('a link to another public page changes it in place: no reload, no splash', async ({
  page,
}) => {
  await page.goto('/docs');
  await expect(page.locator('main#main-content h1')).toBeVisible();
  // The prerendered copy's busy markers go once the app is on, and never come back.
  const root = page.locator('#root');
  await expect(root).not.toHaveAttribute('aria-busy');
  await expect(root).not.toHaveAttribute('aria-disabled');
  const docsTitle = await page.title();
  // Read down the page, then go on to the open source page through its link.
  await page.evaluate(() => {
    (window as unknown as { sameDocument: boolean }).sameDocument = true;
    window.scrollTo(0, 600);
  });
  await page.waitForFunction(() => window.scrollY >= 600);
  const splash = page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const observer = new MutationObserver(() => {
          if (document.querySelector('.boot-screen')) resolve(true);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => resolve(false), 2500);
      }),
  );
  await page.locator('footer a[href="/downtown"]').first().dispatchEvent('click');
  await expect(page).toHaveURL(/\/downtown$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Downtown' })).toBeVisible();
  expect(await splash).toBe(false);
  expect(await page.evaluate(() => 'sameDocument' in window)).toBe(true);
  await expect(root).not.toHaveAttribute('aria-busy');
  await expect(root).not.toHaveAttribute('aria-disabled');
  // Its own title, and the canonical link follows the address.
  await expect(page).not.toHaveTitle(docsTitle);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/downtown$/);
  // The new page starts at its top, with focus on its content.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.locator('main#main-content')).toBeFocused();
  // Back returns to the same place on the docs page.
  await page.goBack();
  await expect(page).toHaveURL(/\/docs$/);
  await expect(page.locator('main#main-content h1')).toHaveText('Docs');
  await page.waitForFunction(() => Math.abs(window.scrollY - 600) <= 1);
  await expect(page).toHaveTitle(docsTitle);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/docs$/);
  expect(await page.evaluate(() => 'sameDocument' in window)).toBe(true);
});

test('prefers-reduced-motion turns the motion off', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '/');
  const header = page.getByRole('banner');
  await header.getByRole('button', { name: 'Open menu' }).tap();
  const menu = page.locator('.cc-header-menu');
  await expect(menu).toBeVisible();
  expect(await running(page, '.cc-header-menu')).toEqual([]);
  // Sections open and close without a transition.
  const section = page
    .getByRole('navigation', { name: 'Menu' })
    .getByRole('button', { name: 'Product', exact: true });
  const panel = `[id="${await section.getAttribute('aria-controls')}"]`;
  const durations = await page
    .locator(panel)
    .evaluate((element) =>
      getComputedStyle(element).transitionDuration.split(', ').map(parseFloat),
    );
  expect(Math.max(...durations)).toBeLessThan(0.001);
  await section.tap();
  expect(await running(page, panel)).toEqual([]);
  // The menu closes at once, with no exit.
  await header.getByRole('button', { name: 'Close menu' }).tap();
  expect(await menu.count()).toBe(0);
  // The footer accordion toggles natively.
  const details = page.getByRole('contentinfo').locator('details').last();
  await details.locator('summary').scrollIntoViewIfNeeded();
  await details.locator('summary').tap();
  await expect(details).toHaveAttribute('open', '');
  expect(await running(page, 'footer details:last-of-type > nav')).toEqual([]);
  // The splash screen shows without its delayed fade, and buttons do not scale on press.
  const css = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'boot-screen';
    document.body.append(probe);
    const animation = getComputedStyle(probe).animationName;
    probe.remove();
    return {
      animation,
      press: getComputedStyle(document.documentElement).getPropertyValue('--motion-duration-fast'),
    };
  });
  expect(css.animation).toBe('none');
  expect(css.press).toMatch(/^0m?s$/);
});
