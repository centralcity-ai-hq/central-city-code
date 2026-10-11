import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/*
 * Opening Elric from the workspace navigation (?workspace=v2) is one calm step: the page never
 * reloads, the navigation stays mounted, and within ~100 ms of the click Elric's page is there
 * (its skeleton, which matches the dashboard's frame, or the chat itself): no blank frame, no
 * boot screen, no setup screen for an account that has Elric, and nothing shifts (CLS < 0.02).
 * Rooms and back to Elric are the same, at 1440 and 390 pixels. The fake-Google e2e server runs
 * Elric on the mock model (e2e/google-server.ts); every API answer is delayed a little, like a
 * real network, so the in-between frames are seen. Synthetic data only.
 */
const port = Number(process.env.E2E_GOOGLE_PORT);
const fakePort = Number(process.env.E2E_GOOGLE_FAKE_PORT);
const base = `http://127.0.0.1:${port}`;
const headers = { 'x-city-request': '1' };

async function ownerWithElric(page: Page) {
  const subject = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:${fakePort}/authorize${new URL(route.request().url()).search}&e2e_subject=${subject}`,
      },
    }),
  );
  const created = await page.request.post(`${base}/api/auth/register`, {
    headers,
    data: {
      name: `Smooth ${randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(created.status()).toBe(201);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Google account linked.' }),
  ).toBeVisible();
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  const added = await page.request.post(`${base}/api/elric`, { headers, data: {} });
  expect(added.status(), await added.text()).toBeLessThan(300);
}

type Frame = { t: number; state: string };
type Recording = {
  marker: number;
  frames: Frame[];
  shift: number;
  /** When the last click happened, on the same clock as the frames. */
  clickedAt: number | null;
};

/**
 * Marks the page and its navigation, then records every frame's state, the time of the next
 * click and any layout shift (CLS: the layout-shift values not caused by input, summed).
 *
 * One recorder at a time: starting one stops the previous one (its frame loop and observer), so
 * earlier recordings don't keep reading the page every frame while the next page draws. Each
 * frame's time is read first, before the state checks below force a layout and read the page's
 * text: the time is when that frame began, not when this test's own reads finished.
 */
async function record(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    (w.__ccStop as (() => void) | undefined)?.();
    w.__ccMarker ??= Math.random();
    const nav = document.querySelector('.wv2-navigation') as (Element & { __cc?: true }) | null;
    if (nav) nav.__cc = true;
    const frames: { t: number; state: string }[] = [];
    let shift = 0;
    let stopped = false;
    const start = performance.now();
    w.__ccFrames = frames;
    w.__ccShift = () => shift;
    // Settles with the first frame that shows Elric's page (its skeleton or the chat).
    let drawn = () => {};
    w.__ccElricDrawn = new Promise<void>((resolve) => (drawn = resolve));
    w.__ccClickedAt = null;
    // When the page handles the click, on the same clock as the frames.
    const click = () => {
      w.__ccClickedAt = Math.round(performance.now() - start);
    };
    document.addEventListener('click', click, { capture: true });
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[])
        if (!entry.hadRecentInput) shift += entry.value;
    });
    observer.observe({ type: 'layout-shift' });
    w.__ccStop = () => {
      stopped = true;
      observer.disconnect();
      document.removeEventListener('click', click, { capture: true });
    };
    const frame = () => {
      if (stopped) return;
      const t = Math.round(performance.now() - start);
      const current = document.querySelector('.wv2-navigation') as
        (Element & { __cc?: true }) | null;
      const state = [
        current ? (current.__cc ? 'nav' : 'nav-remounted') : 'no-nav',
        current && current.getBoundingClientRect().width === 0 ? 'nav-hidden' : '',
        document.body.innerText.trim() ? '' : 'blank',
        // The page area (src/shell/PageArea.tsx) is never empty: the old page stays until the new
        // one draws.
        (document.querySelector('#workspace-page-content') as HTMLElement | null)?.innerText.trim()
          ? ''
          : 'area-blank',
        document.querySelector('.boot-screen') ? 'boot' : '',
        document.querySelector('.elx-setup') ? 'setup' : '',
        document.querySelector('[data-testid="elric-skeleton"]') ? 'skeleton' : '',
        document.querySelector('.elx [aria-label="Message Elric"]') ? 'chat' : '',
        window.location.pathname,
      ]
        .filter(Boolean)
        .join(' ');
      if (frames.at(-1)?.state !== state) frames.push({ t, state });
      if (/ (skeleton|chat) /.test(state)) drawn();
      if (t < 6000) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

async function recording(page: Page): Promise<Recording> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      marker: w.__ccMarker as number,
      frames: w.__ccFrames as Frame[],
      shift: (w.__ccShift as () => number)(),
      clickedAt: w.__ccClickedAt as number | null,
    };
  });
}

/**
 * Waits until the main thread has a free moment (or 1 s has passed), so the click below is not
 * queued behind work left from the step before it (the phone drawer opening and the read-ahead it
 * starts, the page's own first renders). That work is not Elric opening, but it landed inside the
 * measured click-to-first-frame window on busy CI runners.
 */
async function quiet(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        typeof window.requestIdleCallback === 'function'
          ? window.requestIdleCallback(() => resolve(), { timeout: 1000 })
          : setTimeout(resolve, 0),
      ),
  );
}

const viewports = [
  { width: 1440, height: 1000, phone: false },
  { width: 390, height: 844, phone: true },
];

for (const viewport of viewports) {
  test.describe(`at ${viewport.width}px`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('Elric opens from the workspace navigation without a reload, a flash or a shift', async ({
      page,
    }) => {
      await ownerWithElric(page);
      await page.goto(`${base}/rooms?workspace=v2`);
      const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
      // On a phone the navigation is a drawer behind the menu button.
      const openNavigation = async () => {
        if (viewport.phone) await page.getByRole('button', { name: 'Open navigation' }).click();
      };
      // (On a phone the closed drawer is hidden from the accessibility tree.)
      await expect(page.locator('.wv2-navigation [aria-current="page"]')).toHaveText('Rooms');
      // A real network's latency, so the frames between click and chat are seen. From a click on
      // Elric until its page is on screen no answer arrives at all (held), so a page that waited
      // on the network on the way would never draw.
      let held: Promise<void> | null = null;
      await page.route('**/api/**', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        while (held) await held;
        await route.continue();
      });
      let loads = 0;
      page.on('load', () => loads++);
      await record(page);
      const { marker } = await recording(page);

      /** Opens a page from the navigation and checks every frame until it has settled. */
      const open = async (label: 'Elric' | 'Rooms', done: () => Promise<void>) => {
        await record(page);
        await quiet(page);
        let deliver = () => {};
        if (label === 'Elric') held = new Promise<void>((resolve) => (deliver = resolve));
        try {
          await nav.getByRole('button', { name: label, exact: true }).click();
          if (label === 'Elric')
            await page.evaluate(
              () =>
                new Promise<void>((resolve, reject) => {
                  const w = window as unknown as Record<string, unknown>;
                  void (w.__ccElricDrawn as Promise<void>).then(resolve);
                  setTimeout(
                    () => reject(new Error("Elric's page did not draw while the API was held")),
                    5000,
                  );
                }),
            );
        } finally {
          held = null;
          deliver();
        }
        await done();
        await page.waitForTimeout(400);
        const result = await recording(page);
        const trail = JSON.stringify(result.frames);
        // The same document (no full page load) and the same navigation element throughout.
        expect(result.marker, trail).toBe(marker);
        for (const { state } of result.frames) {
          expect(state, trail).toMatch(/^nav /);
          expect(state, trail).not.toMatch(/blank|boot|setup/);
          if (!viewport.phone) expect(state, trail).not.toMatch(/nav-hidden/);
        }
        expect(result.shift, trail).toBeLessThan(0.02);
        return result;
      };

      /** Per Elric open: from the page handling the click to its first frame of Elric's page. */
      const firstFrames: { ms: number; trail: string }[] = [];
      const openElric = async () => {
        await openNavigation();
        const result = await open('Elric', async () => {
          await expect(page.getByLabel('Message Elric')).toBeVisible();
        });
        const trail = JSON.stringify(result.frames);
        // Once Elric's page draws, only its frame and then the chat. (Rooms may stay for a frame
        // while the address changes; the page area is never empty, checked above.)
        const first = result.frames.findIndex((frame) => /skeleton|chat/.test(frame.state));
        expect(first, trail).toBeGreaterThan(-1);
        const onElric = result.frames.slice(first);
        for (const { state } of onElric) expect(state, trail).toMatch(/(skeleton|chat) \/elric$/);
        expect(result.clickedAt, trail).not.toBeNull();
        firstFrames.push({ ms: onElric[0].t - (result.clickedAt ?? 0), trail });
        expect(result.frames.at(-1)?.state).toMatch(/^nav (nav-hidden )?chat \/elric$/);
      };

      await openElric();
      // Ready to type on a desktop (never on a phone: it would open the keyboard).
      if (!viewport.phone) await expect(page.getByLabel('Message Elric')).toBeFocused();

      // Elric -> Rooms -> Elric: the same calm steps.
      await openNavigation();
      const rooms = await open('Rooms', async () => {
        await expect(page).toHaveURL(/\/rooms/);
        await expect(page.getByLabel('Message Elric')).toHaveCount(0);
      });
      expect(rooms.frames.at(-1)?.state).toMatch(/^nav (nav-hidden )?\/rooms$/);
      await openElric();

      // Something of Elric's page within ~100 ms of the click (its skeleton or the chat): from the
      // page handling the click to the start of the first frame that shows Elric's page. It drew
      // with every API answer held (open), so no network wait is on the way; what is left is
      // main-thread work, which a busy runner (other jobs and test processes on the machine)
      // stretches at random. Noise only ever adds time, so the budget holds for the faster of the
      // two opens (each a full Rooms -> Elric change); more work on the path slows both. Neither
      // may take 3x the budget (a CPU slowed 8x stretched single opens to 2.3x).
      const all = JSON.stringify(firstFrames);
      for (const { ms, trail } of firstFrames) expect(ms, trail).toBeLessThanOrEqual(300);
      expect(Math.min(...firstFrames.map(({ ms }) => ms)), all).toBeLessThanOrEqual(100);

      // Back to Rooms through history: the same document and navigation, no flash, no shift.
      await record(page);
      await page.goBack();
      await expect(page).toHaveURL(/\/rooms/);
      await page.waitForTimeout(400);
      const back = await recording(page);
      const trail = JSON.stringify(back.frames);
      expect(back.marker).toBe(marker);
      for (const { state } of back.frames) {
        expect(state, trail).toMatch(/^nav /);
        expect(state, trail).not.toMatch(/blank|boot|setup/);
      }
      expect(back.shift, trail).toBeLessThan(0.02);
      expect(loads).toBe(0);
    });
  });
}

test('with reduced motion, the page appears without the fade', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ownerWithElric(page);
  await page.goto(`${base}/rooms?workspace=v2`);
  const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
  await nav.getByRole('button', { name: 'Elric', exact: true }).click();
  await expect(page.getByLabel('Message Elric')).toBeVisible();
  const animation = await page
    .locator('.elx-main > .elx-column')
    .evaluate((element) => getComputedStyle(element).animationName);
  expect(animation).toBe('none');
  // The page area's entrance (src/shell/PageArea.tsx) does not run either.
  const running = await page
    .locator('#workspace-page-content')
    .evaluate((element) => element.getAnimations().length);
  expect(running).toBe(0);
});

test('only the page area settles in, with opacity and a few pixels of rise', async ({ page }) => {
  await ownerWithElric(page);
  await page.goto(`${base}/rooms?workspace=v2`);
  const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
  const area = page.locator('#workspace-page-content');
  // Watch the page area for the entrance as the page changes.
  await area.evaluate((element) => {
    const w = window as unknown as Record<string, unknown>;
    const seen: { duration: number; props: string[] }[] = [];
    w.__ccEntrances = seen;
    const original = element.animate.bind(element);
    element.animate = (keyframes, options) => {
      const animation = original(keyframes, options);
      const effect = animation.effect as KeyframeEffect;
      seen.push({
        duration: Number(effect.getTiming().duration),
        props: effect
          .getKeyframes()
          .flatMap((frame) =>
            Object.keys(frame).filter(
              (key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key),
            ),
          ),
      });
      return animation;
    };
  });
  await nav.getByRole('button', { name: 'Elric', exact: true }).click();
  await expect(page.getByLabel('Message Elric')).toBeVisible();
  await expect(area).toHaveAttribute('data-page', 'Elric');
  const entrances = await page.evaluate(
    () =>
      (window as unknown as Record<string, unknown>).__ccEntrances as {
        duration: number;
        props: string[];
      }[],
  );
  expect(entrances).toHaveLength(1);
  expect(entrances[0].duration).toBeGreaterThanOrEqual(150);
  expect(entrances[0].duration).toBeLessThanOrEqual(200);
  expect([...new Set(entrances[0].props)].sort()).toEqual(['opacity', 'transform']);
  // The navigation itself never animates.
  const navAnimations = await page
    .locator('.wv2-navigation')
    .evaluate((element) => element.getAnimations({ subtree: false }).length);
  expect(navAnimations).toBe(0);
});
