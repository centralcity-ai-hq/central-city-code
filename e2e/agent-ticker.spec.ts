import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { builtTicker, landingWithTicker, PRERENDERED_TICKER } from './landing-html';

const TICKER = '[data-agent-ticker]';
const SENTENCE = /^\d[\d,]* AI agents? ha(?:s|ve) joined Central City$/;

/**
 * Serves /api/public/stats from a queue of totals (last one repeats) and counts the requests, with
 * "/" as built without a count (e2e/landing-html.ts), so only the mocked numbers ever show.
 */
/** The y of the section under the hero, waiting out the moment its box is null while the
 * prerendered copy is swapped for the live page. */
async function howY(page: Page) {
  let y = 0;
  await expect
    .poll(async () => {
      const box = await page.locator('#how').boundingBox();
      if (box) y = box.y;
      return box !== null;
    })
    .toBe(true);
  return y;
}

async function mockStats(page: Page, totals: number[]) {
  await landingWithTicker(page);
  const state = { calls: 0 };
  let at = Date.parse('2026-09-27T12:00:00.000Z');
  await page.route('**/api/public/stats', (route) => {
    const total = totals[Math.min(state.calls, totals.length - 1)]!;
    state.calls++;
    at += 15_000;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ai_agents_total: total, updated_at: new Date(at).toISOString() }),
    });
  });
  return state;
}

// A fresh installation shows setup copy instead of the ticker; make sure an account exists.
test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/auth/register', {
    headers: { 'x-city-request': '1' },
    data: { name: `Ticker setup ${Date.now()}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(res.status()).toBe(201);
});

interface TickerFrame {
  /** The animated digits. */
  n: string;
  /** The sentence screen readers read in place, and the live region's text. */
  read: string;
  live: string;
  /** Layout: the digits' and the pill's width, and the next section's top. */
  nWidth: number;
  pillWidth: number;
  howTop: number;
}

/** Records every state of the ticker's digits (one entry per change) from the first paint. */
async function recordTicker(page: Page) {
  await page.addInitScript(() => {
    const frames: unknown[] = [];
    (window as unknown as { __ticker: unknown[] }).__ticker = frames;
    const record = () => {
      const n = document.querySelector('[data-agent-ticker] .cc-agent-ticker-n');
      if (!n) return;
      const last = frames[frames.length - 1] as { n: string } | undefined;
      if (last?.n === n.textContent) return;
      frames.push({
        n: n.textContent,
        read: document.querySelector('[data-agent-ticker] .cc-agent-ticker-pill > .visually-hidden')
          ?.textContent,
        live: document.querySelector('[data-agent-ticker] [aria-live]')?.textContent,
        nWidth: n.getBoundingClientRect().width,
        pillWidth: document.querySelector('.cc-agent-ticker-pill')!.getBoundingClientRect().width,
        howTop: document.getElementById('how')!.getBoundingClientRect().top + scrollY,
      });
    };
    new MutationObserver(record).observe(document, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { __ticker: TickerFrame[] }).__ticker.slice());
}

const digits = (frames: TickerFrame[]) => frames.map((frame) => Number(frame.n.replace(/,/g, '')));

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (value ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('the landing shows the live count of AI agents from the real endpoint', async ({ page }) => {
  // An owner connects one external agent, so the count is at least 1.
  const name = `Ticker ${Date.now()}`;
  const registered = await page.request.post('/api/auth/register', {
    headers: { 'x-city-request': '1' },
    data: { name, password: 'Local-test-only-passphrase-2026' },
  });
  expect(registered.status()).toBe(201);
  const agent = await page.request.post('/api/agents', {
    headers: { 'x-city-request': '1' },
    data: { name: 'Ticker AI', description: 'e2e', capability: 'research', mode: 'external' },
  });
  expect(agent.ok()).toBeTruthy();
  await page.context().clearCookies();

  const stats = await page.request.get('/api/public/stats');
  expect(stats.ok()).toBeTruthy();
  expect(stats.headers()['cache-control']).toContain('s-maxage=15');
  const body = await stats.json();
  // The agent count, and the optional Base agents number (server/stats/base-agents.ts).
  expect(
    Object.keys(body)
      .filter((key) => key !== 'base_agents')
      .sort(),
  ).toEqual(['ai_agents_total', 'updated_at']);
  expect(body.ai_agents_total).toBeGreaterThanOrEqual(1);

  await page.goto('/');
  const hero = page.getByRole('region', { name: 'Every AI. One room.' });
  const ticker = hero.locator(TICKER);
  await expect(ticker).toHaveAttribute('data-ready', 'true');
  await expect(ticker.locator('[aria-hidden="true"]')).toHaveText(SENTENCE);
  // Screen readers get the whole sentence once, not the animated digits.
  await expect(ticker.locator('.visually-hidden').first()).toHaveText(SENTENCE);
  await expect(ticker.locator('[aria-live="polite"]')).toHaveCount(1);
  // The ticker is not an action: besides its "Verify here", the hero keeps its two links.
  await expect(hero.getByRole('link').filter({ hasNotText: 'Verify here' })).toHaveText([
    'Sign up',
    'Explore open source',
  ]);
  // No buttons in the copy (the video's own Pause control lives in its frame).
  await expect(hero.locator('.cc-lp-hero-copy').getByRole('button')).toHaveCount(0);
  // (The hero video's own Pause button is allowed: it lives in the media frame, not the copy.)
  await expect(ticker.getByRole('link', { name: 'Verify here' })).toHaveAttribute(
    'href',
    '/downtown/verify',
  );
  // The v8 pill: a live dot and the label, all inside the one hidden-from-AT sentence.
  await expect(ticker.locator('.cc-agent-ticker-pill')).toBeVisible();
  await expect(ticker.locator('[aria-hidden="true"] .cc-agent-ticker-dot')).toHaveCount(1);
  await expect(ticker.locator('.cc-agent-ticker-label')).toHaveText(
    /AI agents? ha(?:s|ve) joined Central City$/,
  );
});

test('the ticker reserves its line (no layout shift) and counts up once on change', async ({
  page,
}) => {
  const frames = await recordTicker(page);
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => (release = resolveGate));
  let calls = 0;
  await landingWithTicker(page);
  await page.route('**/api/public/stats', async (route) => {
    calls++;
    if (calls === 1) await gate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ai_agents_total: calls === 1 ? 12 : 14,
        updated_at: new Date(Date.UTC(2026, 8, 27, 12, 0, calls)).toISOString(),
      }),
    });
  });
  await page.clock.install();
  await page.goto('/');
  const ticker = page.locator(TICKER);
  await expect(ticker).toHaveAttribute('data-ready', 'false');
  const before = await howY(page);
  release();
  await expect(ticker.locator('[aria-hidden="true"]')).toHaveText(
    '12 AI agents have joined Central City',
  );
  expect(await howY(page)).toBe(before);
  // The next poll 15 s later brings 14: the number counts up and settles; nothing loops.
  const settled = (await frames()).length;
  await page.clock.runFor(15_000);
  await page.clock.runFor(1_000);
  await expect(ticker.locator('[aria-hidden="true"]')).toHaveText(
    '14 AI agents have joined Central City',
  );
  expect(await howY(page)).toBe(before);
  // The update ticked on from 12; it never went back to 0.
  const update = digits((await frames()).slice(settled));
  expect(update.length).toBeGreaterThan(0);
  expect(Math.min(...update)).toBeGreaterThanOrEqual(12);
  expect(update.at(-1)).toBe(14);
});

test('polling pauses while the tab is hidden and resumes when it is visible', async ({ page }) => {
  await page.clock.install();
  const stats = await mockStats(page, [10, 11, 12]);
  await page.goto('/');
  await expect(page.locator(TICKER)).toHaveAttribute('data-ready', 'true');
  expect(stats.calls).toBe(1);
  await page.clock.runFor(15_000);
  await expect.poll(() => stats.calls).toBe(2);
  await setHidden(page, true);
  await page.clock.runFor(120_000);
  expect(stats.calls).toBe(2);
  await setHidden(page, false);
  await expect.poll(() => stats.calls).toBe(3);
  await expect(page.locator(`${TICKER} [aria-hidden="true"]`)).toHaveText(
    '12 AI agents have joined Central City',
  );
});

test('with reduced motion the number changes without counting', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await mockStats(page, [1, 2500]);
  await page.goto('/');
  const digits = page.locator(`${TICKER} .cc-agent-ticker-n`);
  await expect(page.locator(`${TICKER} [aria-hidden="true"]`)).toHaveText(
    '1 AI agent has joined Central City',
  );
  await page.clock.runFor(15_000);
  // No intermediate values: the next frame already shows the final number.
  await expect(digits).toHaveText('2,500');
  // The live dot stays still too.
  await expect(page.locator(`${TICKER} .cc-agent-ticker-dot`)).toHaveCSS('animation-name', 'none');
});

test('the count is requested at startup, before the session answers, and fills its reserved slot', async ({
  page,
}) => {
  let releaseSession!: () => void;
  const sessionGate = new Promise<void>((resolveGate) => (releaseSession = resolveGate));
  let sessionAnswered = false;
  await page.route('**/api/session', async (route) => {
    await sessionGate;
    const response = await route.fetch();
    sessionAnswered = true;
    await route.fulfill({ response });
  });
  await landingWithTicker(page);
  let statsBeforeSession: boolean | null = null;
  await page.route('**/api/public/stats', (route) => {
    statsBeforeSession ??= !sessionAnswered;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ai_agents_total: 30_120, updated_at: '2026-10-03T08:00:00.000Z' }),
    });
  });
  const statsRequest = page.waitForRequest('**/api/public/stats');
  await page.goto('/');
  // The entry chunk asks for the number while the session check is still open.
  await statsRequest;
  expect(statsBeforeSession).toBe(true);
  releaseSession();
  const ticker = page.locator(TICKER);
  // The landing renders with the number already answered: no second request, no empty wait.
  await expect(ticker).toHaveAttribute('data-source', 'live');
  await expect(ticker.locator('[aria-hidden="true"]')).toHaveText(
    '30,120 AI agents have joined Central City',
  );
  // The pill sits inside the line's reserved height.
  const line = (await ticker.boundingBox())!;
  const pill = (await ticker.locator('.cc-agent-ticker-pill').boundingBox())!;
  expect(pill.height).toBeLessThanOrEqual(line.height);
  // The browser keeps the last number it saw for the next visit.
  const stored = await page.evaluate(() => localStorage.getItem('cc-agent-count'));
  expect(JSON.parse(stored!)).toEqual({
    total: 30_120,
    at: Date.parse('2026-10-03T08:00:00.000Z'),
  });
});

test('a returning visitor counts up to the last number at once, then on to the live one, with no layout shift', async ({
  page,
}) => {
  const frames = await recordTicker(page);
  await page.addInitScript(() =>
    localStorage.setItem(
      'cc-agent-count',
      JSON.stringify({ total: 29_000, at: Date.parse('2026-10-02T08:00:00.000Z') }),
    ),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => (release = resolveGate));
  await landingWithTicker(page);
  await page.route('**/api/public/stats', async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ai_agents_total: 30_500, updated_at: '2026-10-03T08:00:00.000Z' }),
    });
  });
  await page.goto('/');
  const ticker = page.locator(TICKER);
  await expect(ticker).toHaveAttribute('data-source', 'stored');
  await expect(ticker.locator('[aria-hidden="true"]')).toHaveText(
    '29,000 AI agents have joined Central City',
  );
  const before = await howY(page);
  release();
  await expect(ticker).toHaveAttribute('data-source', 'live');
  await expect(ticker.locator('[aria-hidden="true"]')).toHaveText(
    '30,500 AI agents have joined Central City',
  );
  expect(await howY(page)).toBe(before);
  // One count from 0 per page view: the live number continued from 29,000, never from 0 again.
  const values = digits(await frames());
  expect(values.filter((value) => value === 0)).toHaveLength(1);
  const after = values.slice(values.indexOf(29_000));
  expect(after).toEqual([...after].sort((a, b) => a - b));
});

test('on load the number counts up from 0 to the live number in about 1.8 s, once', async ({
  page,
}) => {
  const frames = await recordTicker(page);
  await mockStats(page, [110_981]);
  const started = Date.now();
  await page.goto('/');
  const ticker = page.locator(TICKER);
  await expect(ticker.locator('.cc-agent-ticker-n')).toHaveText('110,981');
  const values = digits(await frames());
  // It starts at 0, only rises, passes through many values and ends on the final number.
  expect(values[0]).toBe(0);
  // Never below 0, not even on the first frame (a frame can be stamped before the count began).
  expect(Math.min(...values)).toBe(0);
  expect(values).toEqual([...values].sort((a, b) => a - b));
  expect(values.length).toBeGreaterThan(10);
  expect(values.at(-1)).toBe(110_981);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
  // Screen readers only ever get the final value: the read-out sentence never shows an
  // intermediate number, and nothing is announced.
  for (const frame of await frames()) {
    expect(frame.read).toBe('110,981 AI agents have joined Central City');
    expect(frame.live).toBe('');
  }
  // It stays put: no second count.
  await page.waitForTimeout(500);
  expect((await frames()).length).toBe(values.length);
});

test('the count-up causes no layout shift', async ({ page }) => {
  const frames = await recordTicker(page);
  await mockStats(page, [110_981]);
  await page.goto('/');
  await expect(page.locator(`${TICKER} .cc-agent-ticker-n`)).toHaveText('110,981');
  const all = await frames();
  expect(all.length).toBeGreaterThan(10);
  // From "0" to "110,981" the digits keep the final number's width, so the pill and the section
  // below never move.
  for (const key of ['nWidth', 'pillWidth', 'howTop'] as const)
    expect(new Set(all.map((frame) => frame[key])), key).toEqual(new Set([all[0]![key]]));
  await expect(page.locator(`${TICKER} .cc-agent-ticker-n`)).toHaveCSS(
    'font-variant-numeric',
    'tabular-nums',
  );
});

test('with reduced motion the final number shows at once, with no count from 0', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const frames = await recordTicker(page);
  await mockStats(page, [110_981]);
  await page.goto('/');
  await expect(page.locator(`${TICKER} .cc-agent-ticker-n`)).toHaveText('110,981');
  await page.waitForTimeout(300);
  expect(digits(await frames())).toEqual([110_981]);
});

test('the prerendered home page has the count the build read, else its empty line (never a 0)', async ({
  browser,
  request,
  baseURL,
}) => {
  // The build reads the count once (scripts/prerender/agent-count.ts): production's number for a
  // plain `pnpm build`, CC_BUILD_AGENT_COUNT when set, none when the endpoint failed.
  const html = await (await request.get('/')).text();
  const ticker = PRERENDERED_TICKER.exec(html)?.[0];
  expect(ticker, 'the ticker is in the prerendered HTML').toBeTruthy();
  expect(html).not.toMatch(/\b0 AI agents/);
  const fixed = Number(process.env.CC_BUILD_AGENT_COUNT ?? NaN);
  const built = /data-build-count="(\d+)"/.exec(ticker!);
  if (Number.isSafeInteger(fixed) && fixed > 0)
    expect(built?.[1], 'built with CC_BUILD_AGENT_COUNT').toBe(String(fixed));
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const noJs = await context.newPage();
  await noJs.goto('/');
  const line = noJs.locator(TICKER);
  if (built) {
    // A real number as of the build, in the same markup the app renders.
    const total = Number(built[1]);
    expect(total).toBeGreaterThanOrEqual(1);
    const at = /data-build-at="([^"]+)"/.exec(ticker!)![1]!;
    expect(new Date(at).toISOString()).toBe(at);
    expect(ticker).toBe(builtTicker(total, at));
    // Without JavaScript the line shows it.
    await expect(line).toHaveAttribute('data-ready', 'true');
    await expect(line.locator('[aria-hidden="true"]')).toHaveText(
      `${total.toLocaleString('en-US')} ${total === 1 ? 'AI agent has' : 'AI agents have'} joined Central City`,
    );
    await expect(line.locator('.cc-agent-ticker-pill')).toBeVisible();
  } else {
    // No count at build time: the empty, reserved line, exactly as before.
    expect(ticker).toContain('data-ready="false"');
    expect(ticker).not.toMatch(/\d/);
    await expect(line).toHaveAttribute('data-ready', 'false');
    await expect(line.locator('.cc-agent-ticker-n')).toHaveCount(0);
  }
  await expect(noJs.getByRole('heading', { level: 1 })).toBeVisible();
  await context.close();
});

test('built without a count, the page still renders: an empty line without JavaScript, the live number with it', async ({
  browser,
  page,
  baseURL,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  await landingWithTicker(context);
  const noJs = await context.newPage();
  await noJs.goto('/');
  await expect(noJs.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(noJs.locator(TICKER)).toHaveAttribute('data-ready', 'false');
  await expect(noJs.locator(`${TICKER} .cc-agent-ticker-n`)).toHaveCount(0);
  await context.close();
  await mockStats(page, [42]);
  await page.goto('/');
  await expect(page.locator(`${TICKER} [aria-hidden="true"]`)).toHaveText(
    '42 AI agents have joined Central City',
  );
});

test("without JavaScript the build's count is visible, with its sentence and Verify here", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  await landingWithTicker(context, builtTicker(114_251, '2026-10-05T12:00:00.000Z'));
  const noJs = await context.newPage();
  await noJs.goto('/');
  const line = noJs.locator(TICKER);
  await expect(line).toHaveAttribute('data-ready', 'true');
  await expect(line.locator('[aria-hidden="true"]')).toHaveText(
    '114,251 AI agents have joined Central City',
  );
  await expect(line.locator('.visually-hidden').first()).toHaveText(
    '114,251 AI agents have joined Central City',
  );
  await expect(line.locator('.cc-agent-ticker-pill')).toBeVisible();
  await expect(line).toHaveCSS('opacity', '1');
  await expect(line.getByRole('link', { name: 'Verify here' })).toBeVisible();
  await context.close();
});

test("with the build's count in the HTML, the app counts in from 0 like the other counts: never shows the number first, no shift, then on to the live number", async ({
  page,
}) => {
  const frames = await recordTicker(page);
  await landingWithTicker(page, builtTicker(29_000, '2026-10-02T08:00:00.000Z'));
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => (release = resolveGate));
  await page.route('**/api/public/stats', async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ai_agents_total: 30_500, updated_at: '2026-10-03T08:00:00.000Z' }),
    });
  });
  await page.goto('/');
  const ticker = page.locator(TICKER);
  // The app has mounted over the static copy; the boot-time marker that hid the prerendered digits
  // is gone, and the count from 0 ends on the build's number.
  await expect(page.locator('#root')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('html')).not.toHaveAttribute('data-count-in', '1');
  await expect(ticker).toHaveAttribute('data-source', 'build');
  await expect(ticker.locator('.cc-agent-ticker-n')).toHaveText('29,000');
  const before = await howY(page);
  release();
  await expect(ticker).toHaveAttribute('data-source', 'live');
  await expect(ticker.locator('.cc-agent-ticker-n')).toHaveText('30,500');
  expect(await howY(page)).toBe(before);
  // Counted in from 0 (the static copy's 29,000 is in the DOM but hidden until the app mounts), then
  // only ever up, ending on the live one.
  const values = digits(await frames());
  const from = values.findIndex((v) => v < 29_000 / 2);
  expect(from).toBeGreaterThanOrEqual(0);
  const counted = values.slice(from);
  expect(counted.length).toBeGreaterThan(3);
  expect(counted).toEqual([...counted].sort((a, b) => a - b));
  expect(counted.at(-1)).toBe(30_500);
});

test("with reduced motion the build's number stays until the live one replaces it", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const frames = await recordTicker(page);
  await landingWithTicker(page, builtTicker(29_000, '2026-10-02T08:00:00.000Z'));
  await page.route('**/api/public/stats', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ai_agents_total: 30_500, updated_at: '2026-10-03T08:00:00.000Z' }),
    }),
  );
  await page.goto('/');
  await expect(page.locator(TICKER)).toHaveAttribute('data-source', 'live');
  await expect(page.locator(`${TICKER} .cc-agent-ticker-n`)).toHaveText('30,500');
  await page.waitForTimeout(300);
  // No intermediate values: the build's number, then the live one.
  expect(digits(await frames()).every((value) => value === 29_000 || value === 30_500)).toBe(true);
});

test('blocked browser storage is ignored: the ticker still fills', async ({ page }) => {
  // Storage that throws on every access (blocked site data): the ticker still fills.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
  });
  await mockStats(page, [77]);
  await page.goto('/');
  await expect(page.locator(`${TICKER} [aria-hidden="true"]`)).toHaveText(
    '77 AI agents have joined Central City',
  );
  await expect(page.locator(TICKER)).toHaveAttribute('data-source', 'live');
});

/**
 * Screenshots for a UX review: run with
 * TICKER_SHOTS_DIR=<dir>. The number is mocked at 12 so the shots are stable.
 */
for (const width of [1440, 768, 360])
  for (const scheme of ['light', 'dark'] as const)
    test(`screenshot ${width} ${scheme}`, async ({ page }) => {
      const dir = process.env.TICKER_SHOTS_DIR;
      test.skip(!dir, 'Set TICKER_SHOTS_DIR to write screenshots.');
      await page.setViewportSize({ width, height: width === 360 ? 780 : 900 });
      await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
      await mockStats(page, [12]);
      await page.goto('/');
      await expect(page.locator(TICKER)).toHaveAttribute('data-ready', 'true');
      // Let the count from 0 finish, so the shot shows the final number.
      await expect(page.locator(`${TICKER} .cc-agent-ticker-n`)).toHaveText('12');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await mkdir(resolve(dir!), { recursive: true });
      await page.screenshot({ path: resolve(dir!, `ticker-${width}-${scheme}.png`) });
    });
