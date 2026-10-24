import { test, expect, type Page } from '@playwright/test';
import { LISTINGS } from '../src/landing/ListedOn';
import { lowContrast } from './contrast';
import {
  builtAgents,
  builtBase,
  EMPTY_AGENTS,
  EMPTY_BASE,
  landingWithAgents,
  PRERENDERED_AGENTS,
  PRERENDERED_BASE,
  signedOutSession,
} from './landing-html';

/*
 * The homepage, design v10 (src/Landing.tsx): the hero with its live numbers
 * (src/landing/LiveNumbers.tsx), "Listed on" (src/landing/ListedOn.tsx), the dot field
 * (src/landing/DotField.tsx) and the four sections. GET /api/public/stats is mocked where the
 * numbers matter, "/" is served with a known agents cell (e2e/landing-html.ts) and GET
 * /api/session answers for an installation that has an owner, so the live numbers render (a fresh
 * installation shows its setup copy instead).
 */

const NUMBERS = '[data-live-numbers]';
const STATS = ['value', 'paid', 'base', 'agents'] as const;
type Stat = (typeof STATS)[number];
const BASE_TIME = Date.parse('2026-10-19T12:00:00.000Z');

interface Answer {
  /** ai_agents_total (default 512,846). */
  agents?: number;
  /** base_agents.total (default 31,452); null leaves the field out. */
  base?: number | null;
  /** paid_calls.total (default 1,284); null leaves the field out. */
  paid?: number | null;
  /** paid_calls.value_settled_raw, USDC base units (default $1,284,093.50); null leaves it out. */
  valueRaw?: string | null;
  /** An error status instead of an answer. */
  status?: number;
  /** The `rates` field (growth per second), when set. */
  rates?: Record<string, number>;
}

function statsBody(answer: Answer, asOf: string) {
  const paid = answer.paid === undefined ? 1_284 : answer.paid;
  const valueRaw = answer.valueRaw === undefined ? '1284093500000' : answer.valueRaw;
  const base = answer.base === undefined ? 31_452 : answer.base;
  return {
    ai_agents_total: answer.agents ?? 512_846,
    updated_at: asOf,
    ...(base === null ? {} : { base_agents: { total: base, as_of: asOf } }),
    ...(answer.rates ? { rates: answer.rates } : {}),
    ...(paid === null
      ? {}
      : {
          paid_calls: {
            total: paid,
            as_of: asOf,
            recent_ms: [],
            recent_complete: true,
            ...(valueRaw === null ? {} : { value_settled_raw: valueRaw }),
          },
        }),
  };
}

/**
 * Serves /api/public/stats from a queue of answers (the last one repeats) and counts the
 * requests; `gate` holds the first answer until it resolves.
 */
async function mockStats(page: Page, answers: Answer[], gate?: Promise<void>) {
  const state = { calls: 0 };
  await page.route('**/api/public/stats', async (route) => {
    const answer = answers[Math.min(state.calls, answers.length - 1)]!;
    state.calls++;
    if (state.calls === 1 && gate) await gate;
    if (answer.status)
      return route.fulfill({ status: answer.status, contentType: 'application/json', body: '{}' });
    const asOf = new Date(BASE_TIME + state.calls * 15_000).toISOString();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(statsBody(answer, asOf)),
    });
  });
  return state;
}

/** "/" with the agents cell as built (default: the dash), a signed-out session, and the stats. */
async function home(
  page: Page,
  answers: Answer[] = [{}],
  options: {
    build?: { total: number; at: string };
    buildBase?: { total: number; at: string };
    gate?: Promise<void>;
  } = {},
) {
  await signedOutSession(page);
  await landingWithAgents(page, options.build ?? null, options.buildBase ?? null);
  return mockStats(page, answers, options.gate);
}

/** A promise and its release. */
function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

const cell = (page: Page, stat: Stat) => page.locator(`${NUMBERS} [data-stat="${stat}"] dd`);

interface Frame {
  value: string;
  paid: string;
  base: string;
  agents: string;
  sentence: string;
  /** Layout: the top of "Listed on" (page coordinates) and the grid's height. */
  listedTop: number;
  gridHeight: number;
}

/** Records every state of the four numbers (one entry per change) from the first paint. */
async function recordNumbers(page: Page) {
  await page.addInitScript(() => {
    const frames: unknown[] = [];
    (window as unknown as { __numbers: unknown[] }).__numbers = frames;
    const record = () => {
      const root = document.querySelector('[data-live-numbers]');
      const listed = document.querySelector('.cc-listed');
      if (!root || !listed) return;
      const text = (stat: string) =>
        root.querySelector(`[data-stat="${stat}"] dd`)?.textContent ?? '';
      const frame = {
        value: text('value'),
        paid: text('paid'),
        base: text('base'),
        agents: text('agents'),
        sentence: root.querySelector('p.visually-hidden')?.textContent ?? '',
        listedTop: listed.getBoundingClientRect().top + scrollY,
        gridHeight: root.querySelector('.cc-kgrid')!.getBoundingClientRect().height,
      };
      const last = frames[frames.length - 1] as typeof frame | undefined;
      if (
        last &&
        (['value', 'paid', 'base', 'agents', 'sentence'] as const).every(
          (key) => last[key] === frame[key],
        )
      )
        return;
      frames.push(frame);
    };
    new MutationObserver(record).observe(document, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  return () => page.evaluate(() => (window as unknown as { __numbers: Frame[] }).__numbers.slice());
}

/** A cell's number (null for the dash). */
const numberOf = (text: string) => {
  const digits = text.replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
};
const series = (frames: Frame[], stat: Stat) =>
  frames.map((frame) => numberOf(frame[stat])).filter((value): value is number => value !== null);

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

/** The layout this spec compares: "Listed on"'s top and every cell's box. */
async function layout(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => ({
    listedTop: document.querySelector('.cc-listed')!.getBoundingClientRect().top + scrollY,
    cells: [...document.querySelectorAll('[data-live-numbers] .cc-kc')].map((element) => {
      const box = element.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height];
    }),
  }));
}

const FULL_SENTENCE =
  'Live on Central City: $1,284,093 total value settled, 1,284 paid service calls, 31,452 Central City base agents, 512,846 AI agents joined.';

test('the stats endpoint answers its public fields, and the landing shows its real agent count', async ({
  page,
}) => {
  // An owner connects one external agent, so the count is at least 1.
  const registered = await page.request.post('/api/auth/register', {
    headers: { 'x-city-request': '1' },
    data: { name: `Home v10 ${Date.now()}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(registered.status()).toBe(201);
  const agent = await page.request.post('/api/agents', {
    headers: { 'x-city-request': '1' },
    data: { name: 'Home AI', description: 'e2e', capability: 'research', mode: 'external' },
  });
  expect(agent.ok()).toBeTruthy();
  await page.context().clearCookies();

  const stats = await page.request.get('/api/public/stats');
  expect(stats.ok()).toBeTruthy();
  expect(stats.headers()['cache-control']).toContain('s-maxage=15');
  const body = await stats.json();
  // The agent count, and the optional Base agents, paid calls and growth rates fields.
  expect(
    Object.keys(body)
      .filter((key) => key !== 'base_agents' && key !== 'paid_calls' && key !== 'rates')
      .sort(),
  ).toEqual(['ai_agents_total', 'updated_at']);
  expect(body.ai_agents_total).toBeGreaterThanOrEqual(1);

  // "/" exactly as built: the live answer replaces whatever number the build had.
  await page.goto('/');
  await expect(cell(page, 'agents')).toHaveText(body.ai_agents_total.toLocaleString('en-US'));
  await expect(page.locator(`${NUMBERS} p.visually-hidden`)).toContainText(
    `${body.ai_agents_total.toLocaleString('en-US')} AI agents joined`,
  );
});

test('before the answer every number is a dash in a cell of its final size; nothing moves when they arrive', async ({
  page,
}) => {
  const frames = await recordNumbers(page);
  const gate = held();
  await home(page, [{}], { gate: gate.promise });
  await page.goto('/');
  const hero = page.getByRole('region', { name: 'Every AI. One room.' });
  const numbers = hero.locator(NUMBERS);
  await expect(numbers).toBeVisible();
  // Before the server answers nothing is called live.
  await expect(numbers.locator('.cc-kl')).toHaveText('Central City');
  await expect(numbers.locator('.cc-kl')).toHaveAttribute('data-fresh', 'saved');
  await expect(numbers.locator('.cc-live')).toHaveCount(0);
  await expect(numbers.getByRole('link', { name: 'Verify on Base' })).toHaveAttribute(
    'href',
    '/explorer/calls',
  );
  // The grid is read once, as one sentence, by screen readers.
  await expect(numbers.locator('dl.cc-kgrid')).toHaveAttribute('aria-hidden', 'true');
  await expect(numbers.locator('.cc-kc')).toHaveCount(4);
  await expect(numbers.locator('.cc-kc dt')).toHaveText([
    'Total value settled (x402)',
    'Paid service calls',
    'Central City base agents',
    'AI agents joined',
  ]);
  await expect(cell(page, 'value')).toHaveText('$–USDC');
  for (const stat of ['paid', 'base', 'agents'] as const)
    await expect(cell(page, stat)).toHaveText('–');
  await expect(numbers.locator('p.visually-hidden')).toHaveText('Numbers of Central City.');
  await expect(page.locator('#root')).not.toHaveAttribute('aria-busy', 'true');
  const before = await layout(page);
  gate.release();
  await expect(cell(page, 'value')).toHaveText('$1,284,093USDC');
  await expect(cell(page, 'paid')).toHaveText('1,284');
  await expect(cell(page, 'base')).toHaveText('31,452');
  await expect(cell(page, 'agents')).toHaveText('512,846');
  await expect(numbers.locator('p.visually-hidden')).toHaveText(FULL_SENTENCE);
  await expect(numbers.locator('.cc-kl')).toHaveText('Central City, live');
  await expect(numbers.locator('.cc-live')).toHaveCount(1);
  expect(await layout(page)).toEqual(before);
  // No frame of the count-up moved anything either.
  const counted = (await frames()).filter((frame) => numberOf(frame.paid) !== null);
  expect(counted.length).toBeGreaterThan(1);
  for (const frame of counted) {
    expect(frame.listedTop).toBe(before.listedTop);
    expect(frame.gridHeight).toBe(counted[0]!.gridHeight);
  }
  await expect(cell(page, 'paid')).toHaveCSS('font-variant-numeric', 'tabular-nums');
});

test('with growth rates the numbers keep counting from the first second, never past the answer', async ({
  page,
}) => {
  await page.clock.install();
  // 0.2 paid calls, 1 Base agent and 3 AI agents a second: the count starts 30 s behind.
  await home(page, [
    { rates: { paid_calls: 0.2, base_agents: 1, ai_agents: 3, value_settled_raw: 200_000 } },
  ]);
  await page.goto('/');
  // Time the count from the answer's arrival (the request itself is not on the fake clock).
  await expect(page.locator(`${NUMBERS} .cc-kl`)).toHaveAttribute('data-fresh', 'live');
  await page.clock.runFor(1_500);
  const at = async () => ({
    paid: numberOf(await cell(page, 'paid').innerText())!,
    base: numberOf(await cell(page, 'base').innerText())!,
    agents: numberOf(await cell(page, 'agents').innerText())!,
  });
  const a = await at();
  // Right after the fast count: behind the answer by about 30 s of growth.
  expect(a.base).toBeGreaterThanOrEqual(31_452 - 30);
  expect(a.base).toBeLessThan(31_452);
  expect(a.agents).toBeLessThan(512_846);
  await page.clock.runFor(5_000);
  const b = await at();
  // Moving at once, at the real rate, and never past the answered numbers.
  expect(b.base).toBeGreaterThan(a.base);
  expect(b.agents).toBeGreaterThan(a.agents);
  expect(b.base).toBeLessThanOrEqual(31_452);
  await page.clock.runFor(9_000);
  const c = await at();
  expect(c.base).toBeGreaterThan(b.base);
  expect(c.paid).toBeLessThanOrEqual(1_284);
});

test('on the first answer the numbers count up (about 1.3 s); a later answer counts on live across the next 30 s', async ({
  page,
}) => {
  const frames = await recordNumbers(page);
  await page.clock.install();
  const stats = await home(page, [{}, { paid: 1_290, base: 31_460, agents: 512_900 }]);
  const started = Date.now();
  await page.goto('/');
  await expect(cell(page, 'paid')).toHaveText('1,284');
  await expect(cell(page, 'value')).toHaveText('$1,284,093USDC');
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  const first = await frames();
  for (const stat of ['value', 'paid', 'base'] as const) {
    const values = series(first, stat);
    // From 0, only up, through many values, to the real number.
    expect(values[0], stat).toBeLessThan(values.at(-1)! / 2);
    expect(values, stat).toEqual([...values].sort((a, b) => a - b));
    expect(values.length, stat).toBeGreaterThan(5);
  }
  expect(series(first, 'paid').at(-1)).toBe(1_284);
  // Screen readers only ever get the real numbers, never an intermediate one.
  for (const frame of first)
    expect(['Numbers of Central City.', FULL_SENTENCE]).toContain(frame.sentence);
  // It stays put: no second count.
  const settled = first.length;
  await page.clock.runFor(2_000);
  expect((await frames()).length).toBe(settled);
  // The next poll, 15 s on: each number counts on from where it is, steadily, through values in
  // between, reaching the new number two polls (30 s) later; it never goes down.
  await page.clock.runFor(13_000);
  await expect.poll(() => stats.calls).toBe(2);
  await page.clock.runFor(12_000);
  const mid = numberOf(await cell(page, 'agents').innerText())!;
  expect(mid).toBeGreaterThan(512_846);
  expect(mid).toBeLessThan(512_900);
  await page.clock.runFor(20_000);
  await expect(cell(page, 'paid')).toHaveText('1,290');
  await expect(cell(page, 'agents')).toHaveText('512,900');
  const later = (await frames()).slice(settled);
  for (const [stat, from, to] of [
    ['paid', 1_284, 1_290],
    ['base', 31_452, 31_460],
    ['agents', 512_846, 512_900],
  ] as const) {
    const values = series(later, stat);
    expect(values, stat).toEqual([...values].sort((a, b) => a - b));
    expect(values[0], stat).toBeGreaterThanOrEqual(from);
    expect(values.at(-1), stat).toBe(to);
  }
  expect(series(later, 'agents').length).toBeGreaterThan(5);
});

test('with reduced motion the numbers show at once, with no count-up, and the live dot stays still', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const frames = await recordNumbers(page);
  await home(page);
  await page.goto('/');
  await expect(cell(page, 'paid')).toHaveText('1,284');
  await page.waitForTimeout(500);
  const all = await frames();
  expect(series(all, 'paid')).toEqual([1_284]);
  expect(series(all, 'value')).toEqual([1_284_093]);
  expect(series(all, 'base')).toEqual([31_452]);
  expect(series(all, 'agents')).toEqual([512_846]);
  await expect(page.locator(`${NUMBERS} .cc-live`)).toHaveCSS('animation-name', 'none');
});

test('the numbers are requested at startup, before the session answers, with one request', async ({
  page,
}) => {
  const session = held();
  let sessionAnswered = false;
  await page.route('**/api/session', async (route) => {
    await session.promise;
    sessionAnswered = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ operator: null, setupRequired: false }),
    });
  });
  await landingWithAgents(page);
  let statsBeforeSession: boolean | null = null;
  const stats = { calls: 0 };
  await page.route('**/api/public/stats', (route) => {
    stats.calls++;
    statsBeforeSession ??= !sessionAnswered;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(statsBody({}, '2026-10-19T12:00:00.000Z')),
    });
  });
  const request = page.waitForRequest('**/api/public/stats');
  await page.goto('/');
  // The entry chunk asks for the numbers while the session check is still open.
  await request;
  expect(statsBeforeSession).toBe(true);
  session.release();
  await expect(cell(page, 'paid')).toHaveText('1,284');
  expect(stats.calls).toBe(1);
  // The browser keeps the last agent count it saw for the next visit.
  const stored = await page.evaluate(() => localStorage.getItem('cc-agent-count'));
  expect(JSON.parse(stored!)).toEqual({
    total: 512_846,
    at: Date.parse('2026-10-19T12:00:00.000Z'),
  });
});

test('polling pauses while the tab is hidden and resumes when it is visible', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  const stats = await home(page, [{ paid: 10 }, { paid: 11 }, { paid: 12 }]);
  await page.goto('/');
  await expect(cell(page, 'paid')).toHaveText('10');
  expect(stats.calls).toBe(1);
  await page.clock.runFor(15_000);
  await expect.poll(() => stats.calls).toBe(2);
  await expect(cell(page, 'paid')).toHaveText('11');
  await setHidden(page, true);
  await page.clock.runFor(120_000);
  expect(stats.calls).toBe(2);
  await setHidden(page, false);
  await expect.poll(() => stats.calls).toBe(3);
  await expect(cell(page, 'paid')).toHaveText('12');
});

test('a failed first load is retried after 1 s and the numbers still fill', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  const stats = await home(page, [{ status: 503 }, {}]);
  await page.goto('/');
  await expect.poll(() => stats.calls).toBe(1);
  await expect(page.locator('#root')).not.toHaveAttribute('aria-busy', 'true');
  await expect(cell(page, 'paid')).toHaveText('–');
  await page.clock.runFor(1_100);
  await expect.poll(() => stats.calls).toBe(2);
  await expect(cell(page, 'paid')).toHaveText('1,284');
  await expect(cell(page, 'value')).toHaveText('$1,284,093USDC');
  await expect(cell(page, 'base')).toHaveText('31,452');
  await expect(cell(page, 'agents')).toHaveText('512,846');
});

test('with animation frames paused (in-app browser, power saving), the numbers still show after 1 s', async ({
  page,
}) => {
  // No animation frame ever runs: the count-up cannot draw.
  await page.addInitScript(() => {
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => undefined;
  });
  await home(page, [{}]);
  await page.goto('/');
  await expect(cell(page, 'paid')).toHaveText('1,284', { timeout: 5_000 });
  await expect(cell(page, 'value')).toHaveText('$1,284,093USDC');
  await expect(cell(page, 'base')).toHaveText('31,452');
  await expect(cell(page, 'agents')).toHaveText('512,846');
});

test('a failed poll keeps the numbers but drops live; the next answer brings it back', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  const stats = await home(page, [{}, { status: 503 }, {}]);
  await page.goto('/');
  const label = page.locator(`${NUMBERS} .cc-kl`);
  await expect(label).toHaveText('Central City, live');
  await page.clock.runFor(15_000);
  await expect.poll(() => stats.calls).toBe(2);
  await expect(label).toHaveText('Central City');
  await expect(label).toHaveAttribute('data-fresh', 'saved');
  await expect(page.locator(`${NUMBERS} .cc-live`)).toHaveCount(0);
  await expect(cell(page, 'paid')).toHaveText('1,284');
  await expect(page.locator(`${NUMBERS} p.visually-hidden`)).toContainText(
    'Central City, last known:',
  );
  // After a failed poll the next one comes on the regular tick.
  await page.clock.runFor(15_000);
  await expect.poll(() => stats.calls).toBe(3);
  await expect(label).toHaveText('Central City, live');
});

test('a missing field leaves only its own cell a dash; a later poll without it keeps the number; a real zero replaces it', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  const stats = await home(page, [
    { paid: null },
    { base: null, valueRaw: null },
    { paid: 0, valueRaw: '0', base: 0 },
  ]);
  await page.goto('/');
  // No paid_calls field: no paid calls and no value; the others show.
  await expect(cell(page, 'base')).toHaveText('31,452');
  await expect(cell(page, 'agents')).toHaveText('512,846');
  await expect(cell(page, 'paid')).toHaveText('–');
  await expect(cell(page, 'value')).toHaveText('$–USDC');
  await expect(page.locator(`${NUMBERS} p.visually-hidden`)).toHaveText(
    'Live on Central City: 31,452 Central City base agents, 512,846 AI agents joined.',
  );
  // Next poll: paid calls without their value, and no Base agents: that number stays.
  await page.clock.runFor(15_000);
  await expect.poll(() => stats.calls).toBe(2);
  await expect(cell(page, 'paid')).toHaveText('1,284');
  await expect(cell(page, 'value')).toHaveText('$–USDC');
  await expect(cell(page, 'base')).toHaveText('31,452');
  // Then validated zeros (a correction to zero): they replace the positive numbers.
  await page.clock.runFor(15_000);
  await expect.poll(() => stats.calls).toBe(3);
  await page.clock.runFor(500);
  await expect(cell(page, 'paid')).toHaveText('0');
  await expect(cell(page, 'base')).toHaveText('0');
  await expect(cell(page, 'value')).toHaveText('$0USDC');
  await expect(cell(page, 'agents')).toHaveText('512,846');
});

test("the prerendered home page has the build's agent and Base agents numbers, else a dash; no money number is baked, never a 0", async ({
  browser,
  request,
  baseURL,
}) => {
  // The build reads the count once (scripts/prerender/agent-count.ts): production's number for a
  // plain `pnpm build`, CC_BUILD_AGENT_COUNT when set, none when the endpoint failed.
  const html = await (await request.get('/')).text();
  const agents = PRERENDERED_AGENTS.exec(html)?.[0];
  expect(agents, 'the agents cell is in the prerendered HTML').toBeTruthy();
  for (const stat of ['value', 'paid'])
    expect(html).toContain(`<div class="cc-kc" data-stat="${stat}"><dt>`);
  // The paid service calls and the value settled are never baked (money numbers).
  expect(html).toMatch(
    /data-stat="value"><dt>Total value settled \(x402\)<\/dt><dd><span class="cc-cur">\$<\/span>–<span class="cc-unit">USDC<\/span><\/dd>/,
  );
  expect(html).toMatch(/data-stat="paid"><dt>Paid service calls<\/dt><dd>–<\/dd>/);
  // The Base agents number: the build's (from 1 up, dated), else a dash.
  const base = PRERENDERED_BASE.exec(html)?.[0];
  expect(base, 'the Base agents cell is in the prerendered HTML').toBeTruthy();
  const builtB = /data-build-base="(\d+)" data-build-base-at="([^"]+)"/.exec(base!);
  if (builtB) {
    expect(Number(builtB[1])).toBeGreaterThanOrEqual(1);
    expect(new Date(builtB[2]!).toISOString()).toBe(builtB[2]);
    expect(base).toBe(builtBase(Number(builtB[1]), builtB[2]!));
  } else expect(base).toBe(EMPTY_BASE);
  expect(html).not.toMatch(/<dd>0<\/dd>/);
  const fixed = Number(process.env.CC_BUILD_AGENT_COUNT ?? NaN);
  const built = /data-build-count="(\d+)"/.exec(agents!);
  if (Number.isSafeInteger(fixed) && fixed > 0)
    expect(built?.[1], 'built with CC_BUILD_AGENT_COUNT').toBe(String(fixed));
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const noJs = await context.newPage();
  await noJs.goto('/');
  if (built) {
    const total = Number(built[1]);
    expect(total).toBeGreaterThanOrEqual(1);
    const at = /data-build-at="([^"]+)"/.exec(agents!)![1]!;
    expect(new Date(at).toISOString()).toBe(at);
    // The same markup the app renders (e2e/landing-html.ts stays in step with it).
    expect(agents).toBe(builtAgents(total, at));
    await expect(cell(noJs, 'agents')).toHaveText(total.toLocaleString('en-US'));
  } else {
    expect(agents).toBe(EMPTY_AGENTS);
    await expect(cell(noJs, 'agents')).toHaveText('–');
  }
  await expect(cell(noJs, 'paid')).toHaveText('–');
  await expect(noJs.getByRole('heading', { level: 1 })).toHaveText('Every AI. One room.');
  await context.close();
});

test("without JavaScript the build's agent count is visible, with its sentence", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  await landingWithAgents(context, { total: 114_251, at: '2026-10-05T12:00:00.000Z' });
  const noJs = await context.newPage();
  await noJs.goto('/');
  const agents = noJs.locator(`${NUMBERS} [data-stat="agents"]`);
  await expect(agents).toHaveAttribute('data-build-count', '114251');
  await expect(agents.locator('dd')).toHaveText('114,251');
  await expect(agents.locator('dd')).toBeVisible();
  await expect(agents).toHaveCSS('opacity', '1');
  await expect(noJs.locator(`${NUMBERS} p.visually-hidden`)).toHaveText(
    'Central City, last known: 114,251 AI agents joined.',
  );
  await expect(noJs.getByRole('link', { name: 'Verify on Base' })).toBeVisible();
  await context.close();
});

test("with the build's count in the HTML the app starts from it, never shows less, then the live number", async ({
  page,
}) => {
  const frames = await recordNumbers(page);
  const gate = held();
  await home(page, [{ agents: 30_500 }], {
    build: { total: 29_000, at: '2026-10-02T08:00:00.000Z' },
    gate: gate.promise,
  });
  await page.goto('/');
  await expect(page.locator('#root')).not.toHaveAttribute('aria-busy', 'true');
  await expect(cell(page, 'agents')).toHaveText('29,000');
  await expect(cell(page, 'paid')).toHaveText('–');
  gate.release();
  await expect(cell(page, 'agents')).toHaveText('30,500');
  await expect(cell(page, 'paid')).toHaveText('1,284');
  const values = series(await frames(), 'agents');
  expect(Math.min(...values)).toBe(29_000);
  expect(values).toEqual([...values].sort((a, b) => a - b));
  expect(values.at(-1)).toBe(30_500);
});

test('a returning visitor sees the last agent count this browser saw until the answer', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() =>
    localStorage.setItem(
      'cc-agent-count',
      JSON.stringify({ total: 29_000, at: Date.parse('2026-10-02T08:00:00.000Z') }),
    ),
  );
  const gate = held();
  await home(page, [{ agents: 30_500 }], { gate: gate.promise });
  await page.goto('/');
  await expect(cell(page, 'agents')).toHaveText('29,000');
  gate.release();
  await expect(cell(page, 'agents')).toHaveText('30,500');
});

test('a returning visitor sees every number this browser last saw, not live, until the answer', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const at = Date.parse('2026-10-02T08:00:00.000Z');
  await page.addInitScript((at) => {
    localStorage.setItem('cc-agent-count', JSON.stringify({ total: 29_000, at }));
    localStorage.setItem(
      'cc-live-numbers',
      JSON.stringify({
        paid: { total: 1_200, at },
        base: { total: 31_000, at },
        value: { raw: '1200000000000', at },
      }),
    );
  }, at);
  const gate = held();
  await home(page, [{ paid: null, base: null }, {}], { gate: gate.promise });
  await page.goto('/');
  await expect(cell(page, 'value')).toHaveText('$1,200,000USDC');
  await expect(cell(page, 'paid')).toHaveText('1,200');
  await expect(cell(page, 'base')).toHaveText('31,000');
  await expect(cell(page, 'agents')).toHaveText('29,000');
  await expect(page.locator(`${NUMBERS} [data-fresh]`)).toHaveAttribute('data-fresh', 'saved');
  // The first answer leaves out the paid calls and the Base agents: they keep the stored ones.
  gate.release();
  await expect(cell(page, 'agents')).toHaveText('512,846');
  await expect(page.locator(`${NUMBERS} [data-fresh]`)).toHaveAttribute('data-fresh', 'live');
  await expect(cell(page, 'paid')).toHaveText('1,200');
  await expect(cell(page, 'base')).toHaveText('31,000');
  await expect(cell(page, 'value')).toHaveText('$1,200,000USDC');
});

test('every answer is kept for the next visit; a field it leaves out keeps the stored one', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  const stats = await home(page, [{}, { paid: null, base: 31_460 }]);
  await page.goto('/');
  await expect(cell(page, 'paid')).toHaveText('1,284');
  const read = async () =>
    JSON.parse((await page.evaluate(() => localStorage.getItem('cc-live-numbers')))!);
  expect(await read()).toEqual({
    paid: { total: 1_284, at: BASE_TIME + 15_000 },
    base: { total: 31_452, at: BASE_TIME + 15_000 },
    value: { raw: '1284093500000', at: BASE_TIME + 15_000 },
  });
  await page.clock.runFor(15_000);
  await expect.poll(() => stats.calls).toBe(2);
  await expect(cell(page, 'base')).toHaveText('31,460');
  expect(await read()).toEqual({
    paid: { total: 1_284, at: BASE_TIME + 15_000 },
    base: { total: 31_460, at: BASE_TIME + 30_000 },
    value: { raw: '1284093500000', at: BASE_TIME + 15_000 },
  });
});

test("a first-time visitor sees the build's Base agents number before the answer", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const gate = held();
  await home(page, [{}], {
    build: { total: 29_000, at: '2026-10-02T08:00:00.000Z' },
    buildBase: { total: 31_000, at: '2026-10-02T08:00:00.000Z' },
    gate: gate.promise,
  });
  await page.goto('/');
  await expect(cell(page, 'base')).toHaveText('31,000');
  await expect(cell(page, 'agents')).toHaveText('29,000');
  await expect(cell(page, 'paid')).toHaveText('–');
  gate.release();
  await expect(cell(page, 'base')).toHaveText('31,452');
  await expect(cell(page, 'paid')).toHaveText('1,284');
});

test('an answer without a number is read again after 2 s, then 4 s, never blanking a known one', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  const stats = await home(page, [{}, { paid: null }, { paid: null }, { paid: null }, {}]);
  await page.goto('/');
  await expect(cell(page, 'paid')).toHaveText('1,284');
  expect(stats.calls).toBe(1);
  // A full answer: the normal poll.
  await page.clock.runFor(15_000);
  await expect.poll(() => stats.calls).toBe(2);
  // No paid_calls: the number stays, and it is read again after 2 s, then 4 s.
  await expect(cell(page, 'paid')).toHaveText('1,284');
  await expect(cell(page, 'value')).toHaveText('$1,284,093USDC');
  await page.clock.runFor(2_000);
  await expect.poll(() => stats.calls).toBe(3);
  await page.clock.runFor(4_000);
  await expect.poll(() => stats.calls).toBe(4);
  // Then the normal poll again (bounded), and the full answer.
  await page.clock.runFor(10_000);
  expect(stats.calls).toBe(4);
  await page.clock.runFor(5_000);
  await expect.poll(() => stats.calls).toBe(5);
  await expect(cell(page, 'paid')).toHaveText('1,284');
});

test('blocked browser storage is ignored: the numbers still fill', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
  });
  await home(page, [{ agents: 77 }]);
  await page.goto('/');
  await expect(cell(page, 'agents')).toHaveText('77');
  await expect(cell(page, 'paid')).toHaveText('1,284');
});

for (const width of [375, 390])
  test(`at ${width} px the numbers sit in a 2x2 grid, fit without truncation, move nothing and never scroll sideways`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    const gate = held();
    await home(
      page,
      // Ten times today's numbers or more (the value cell holds up to $999,999 on a phone).
      [{ agents: 12_345_678, base: 1_234_567, paid: 12_345_678, valueRaw: '123456000000' }],
      { gate: gate.promise },
    );
    await page.goto('/');
    await expect(cell(page, 'paid')).toHaveText('–');
    await expect(page.locator('#root')).not.toHaveAttribute('aria-busy', 'true');
    const before = await layout(page);
    gate.release();
    await expect(cell(page, 'paid')).toHaveText('12,345,678');
    await expect(cell(page, 'value')).toHaveText('$123,456USDC');
    await expect(cell(page, 'agents')).toHaveText('12,345,678');
    expect(await layout(page)).toEqual(before);
    // Two columns, two rows.
    const [value, paid, base, agents] = before.cells as [number, number, number, number][];
    expect(Math.abs(value![1] - paid![1])).toBeLessThanOrEqual(1);
    expect(Math.abs(base![1] - agents![1])).toBeLessThanOrEqual(1);
    expect(base![1]).toBeGreaterThan(value![1]);
    expect(Math.abs(value![0] - base![0])).toBeLessThanOrEqual(1);
    expect(paid![0]).toBeGreaterThan(value![0]);
    // Every number fits its cell (no ellipsis) inside the page.
    for (const stat of STATS) {
      const fits = await cell(page, stat).evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      );
      expect(fits, stat).toBe(true);
    }
    for (const [x, , w] of before.cells as [number, number, number, number][]) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(width + 0.5);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

for (const theme of ['light', 'dark'] as const)
  for (const width of [375, 1440])
    test(`the live numbers and Listed on are readable at ${width} px (${theme})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await home(page);
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(cell(page, 'paid')).toHaveText('1,284');
      for (const root of [NUMBERS, '.cc-listed']) {
        const result = await lowContrast(page, root);
        expect(result.count, root).toBeGreaterThan(3);
        expect(result.low, root).toEqual([]);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });

test('Listed on: every listing once for assistive technology, with its link; the copy is hidden and out of the tab order', async ({
  page,
}) => {
  await home(page);
  await page.goto('/');
  const listed = page.getByRole('region', { name: 'Listed on' });
  await expect(listed).toBeVisible();
  // Only the first set is in the accessibility tree.
  const links = listed.getByRole('link');
  await expect(links).toHaveText(LISTINGS.map((listing) => listing.name));
  for (const listing of LISTINGS) {
    const link = listed.getByRole('link', { name: listing.name, exact: true });
    await expect(link, listing.name).toHaveCount(1);
    await expect(link).toHaveAttribute('href', listing.href);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
  }
  // Smithery verifies the server through this homepage link.
  await expect(listed.getByRole('link', { name: 'Smithery', exact: true })).toHaveAttribute(
    'href',
    'https://smithery.ai/servers/centralcity/central-city',
  );
  // The endless strip draws the set twice; the second is hidden and never focused.
  const sets = listed.locator('.cc-mq-track > .cc-lo-set');
  await expect(sets).toHaveCount(2);
  await expect(sets.first()).not.toHaveAttribute('aria-hidden', /./);
  await expect(sets.nth(1)).toHaveAttribute('aria-hidden', 'true');
  const copies = sets.nth(1).locator('a.cc-lo');
  await expect(copies).toHaveCount(LISTINGS.length);
  for (const copy of await copies.all()) await expect(copy).toHaveAttribute('tabindex', '-1');
  await expect(sets.first().locator('a.cc-lo[tabindex]')).toHaveCount(0);
  // Never "partner" wording.
  expect((await listed.innerText()).toLowerCase()).not.toContain('partner');
});

test('Listed on: keyboard focus stops the strip and brings each focused listing into view', async ({
  page,
}) => {
  await home(page);
  await page.goto('/');
  const strip = page.locator('.cc-mq');
  await expect(page.locator('.cc-kl')).toHaveAttribute('data-fresh', 'live');
  const first = page.locator('.cc-lo-set:not([aria-hidden]) .cc-lo').first();
  await first.focus();
  await expect(page.locator('.cc-mq-track')).toHaveCSS('animation-name', 'none');
  for (let i = 0; i < LISTINGS.length; i++) {
    const focused = page.locator('.cc-lo:focus');
    await expect(focused).toHaveText(LISTINGS[i]!.name);
    // The strip may scroll smoothly; wait until the focused listing is fully inside it.
    await expect
      .poll(
        async () => {
          const box = (await focused.boundingBox())!;
          const frame = (await strip.boundingBox())!;
          return box.x >= frame.x - 1 && box.x + box.width <= frame.x + frame.width + 1;
        },
        { message: LISTINGS[i]!.name },
      )
      .toBe(true);
    if (i < LISTINGS.length - 1) await page.keyboard.press('Tab');
  }
});

for (const width of [768, 901, 1001, 1280])
  test(`a seven-digit total value fits its cell at ${width} px`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 900 });
    await home(page, [{ valueRaw: '9999999000000' }]);
    await page.goto('/');
    await expect(cell(page, 'value')).toContainText('9,999,999');
    for (const stat of STATS)
      expect(await cell(page, stat).evaluate((e) => e.scrollWidth <= e.clientWidth + 1), stat).toBe(
        true,
      );
  });

test('Listed on with reduced motion on a 375 px phone: the wrapped names stay below the numbers', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await home(page);
  await page.goto('/');
  const numbers = (await page.locator(NUMBERS).boundingBox())!;
  const listed = (await page.locator('.cc-listed').boundingBox())!;
  expect(listed.y).toBeGreaterThanOrEqual(numbers.y + numbers.height - 1);
  for (const item of LISTINGS) {
    const box = (await page
      .locator('.cc-lo-set:not([aria-hidden]) .cc-lo', { hasText: item.name })
      .boundingBox())!;
    expect(box.y, item.name).toBeGreaterThanOrEqual(listed.y - 1);
    expect(box.y + box.height, item.name).toBeLessThanOrEqual(listed.y + listed.height + 1);
  }
});

test('Listed on stands still with reduced motion; the dot field is decoration only', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await home(page);
  await page.goto('/');
  await expect(page.locator('.cc-mq-track')).toHaveCSS('animation-name', 'none');
  // Still, the strip wraps one set so every listing is in view; the copy is not drawn.
  await expect(page.locator('.cc-lo-set[aria-hidden="true"]')).toBeHidden();
  const strip = await page.locator('.cc-mq').boundingBox();
  for (const item of LISTINGS) {
    const link = page.locator('.cc-lo-set:not([aria-hidden]) .cc-lo', { hasText: item.name });
    await expect(link).toBeVisible();
    const box = (await link.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(strip!.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(strip!.x + strip!.width + 1);
  }
  const field = page.locator('main .cc-field');
  await expect(field).toHaveCount(1);
  await expect(field).toHaveAttribute('aria-hidden', 'true');
  await expect(field.locator('canvas')).toHaveCount(1);
  expect((await field.innerText()).trim()).toBe('');
  await expect(field.locator('a, button, [tabindex]')).toHaveCount(0);
});

test('the sections come in order, each with its links; Invite your AI opens Connect', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await home(page);
  await page.goto('/');
  await expect(page.locator('#root')).not.toHaveAttribute('aria-busy', 'true');
  const main = page.locator('main.cc-v10');
  const order = await main
    .locator(':scope > section, :scope > .cc-field')
    .evaluateAll((all) =>
      all.map(
        (element) =>
          element.getAttribute('aria-labelledby') ??
          element.getAttribute('aria-label') ??
          element.className,
      ),
    );
  expect(order).toEqual([
    'landing-title',
    'Listed on',
    'cc-field',
    'room-title',
    'passport-title',
    'how-title',
    'cta-title',
  ]);

  const hero = page.getByRole('region', { name: 'Every AI. One room.' });
  await expect(hero.locator('.cc-kick')).toHaveText('Open protocol for AI agents');
  await expect(hero.getByRole('heading', { level: 1 })).toHaveText('Every AI. One room.');
  await expect(hero.locator('h1 .cc-room')).toHaveText('One room.');
  await expect(hero.locator('.cc-landing-sub')).toHaveText(
    'Claude, ChatGPT, Gemini and your own agents work together in shared rooms, carry a passport on Base and pay each other for services in USDC.',
  );
  const actions = hero.locator('.hero-actions').getByRole('link');
  await expect(actions).toHaveText(['Sign up', 'Explore open source']);
  await expect(actions.first()).toHaveAttribute('href', '/#create');
  await expect(actions.last()).toHaveAttribute('href', '/downtown');

  const sections: Array<[string, string, string, string]> = [
    ['room', 'Every AI at the same table.', 'Invite your AI', '/connect'],
    ['passport', 'Every agent deserves a passport.', 'Explore agents on Base', '/explorer/base'],
    ['how', 'Your room never sleeps.', 'Meet Elric', '/elric'],
  ];
  for (const [id, title, link, href] of sections) {
    const section = page.getByRole('region', { name: title });
    await expect(section, title).toHaveAttribute('id', id);
    await expect(section.getByRole('link', { name: link })).toHaveAttribute('href', href);
    await expect(section.locator('video')).toHaveCount(1);
  }

  const connect = page.getByRole('region', { name: 'Connect your AI in 30 seconds.' });
  await expect(connect.locator('#hero-invite')).toHaveText('Invite your AI');
  await expect(connect.locator('#hero-invite')).toHaveAttribute('href', '/connect');
  await expect(connect.getByRole('link', { name: 'Read the docs' })).toHaveAttribute(
    'href',
    '/docs',
  );
  await expect(connect.locator('ul.cc-clients > li b')).toHaveText([
    'Claude',
    'ChatGPT',
    'Cursor',
    'Gemini CLI',
    'DeepSeek',
    'Kimi',
  ]);
  // No arrows in the copy.
  expect(await main.innerText()).not.toMatch(/[→↗›]/);

  await connect.locator('#hero-invite').click();
  await expect(page).toHaveURL(/\/connect$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Connect your AI' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a fresh installation shows its setup copy instead of the live numbers', async ({ page }) => {
  await page.route('**/api/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ operator: null, setupRequired: true }),
    }),
  );
  await page.goto('/');
  await expect(page.locator('#root')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.getByText('This installation has no workspace yet.')).toBeVisible();
  await expect(page.locator(NUMBERS)).toHaveCount(0);
});
