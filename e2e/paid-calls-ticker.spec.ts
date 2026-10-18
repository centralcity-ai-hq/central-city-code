import { test, expect, type Page } from '@playwright/test';
import { lowContrast } from './contrast';
import { EMPTY_TICKER, PREBUILT_PAID_LINE, PRERENDERED_TICKER } from './landing-html';

/*
 * The live line on the homepage (src/PaidCallsTicker.tsx), under the agent count: the Base agents
 * and the paid service calls. GET /api/public/stats is mocked (its optional `base_agents` and
 * `paid_calls` fields, server/stats/base-agents.ts and server/stats/paid-calls.ts) and
 * "/" is served with both counts' lines as a known build would have them (e2e/landing-html.ts), so
 * the specs behave the same whatever the build read.
 */

const PAID = '[data-paid-calls-ticker]';
const ARROWS = /[\u2190-\u21ff\u2794-\u27bf\u2900-\u297f\u2b00-\u2bff\u00ab\u00bb\u2039\u203a]/;
/** The reserved, empty line a build that saw the count writes (never a number). */
const RESERVED_LINE =
  '<p class="cc-agent-ticker cc-paid-ticker" data-paid-calls-ticker="true" data-paid-calls="1" data-ready="false"></p>';

/** Serves "/" as built, with the agent line empty and the paid line reserved or not. */
async function landing(page: Page, options: { reserved?: boolean } = {}) {
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replace(PREBUILT_PAID_LINE, '');
      if (!PRERENDERED_TICKER.test(html)) throw new Error('landing: no ticker in "/"');
      await route.fulfill({
        response,
        body: html.replace(
          PRERENDERED_TICKER,
          () => EMPTY_TICKER + (options.reserved ? RESERVED_LINE : ''),
        ),
      });
    },
  );
}

interface Answer {
  /** The paid calls total; null leaves the field out. */
  total: number | null;
  /** The Base agents number (default 31,452); null leaves the field out. */
  baseAgents?: number | null;
  /** Its as_of, ms after the base time (default: the answer's as_of). */
  baseAsOf?: number;
  /** as_of, ms after the base time. */
  asOf?: number;
  recentMs?: number[];
  recentComplete?: boolean;
  /** The edge's Age header, seconds; undefined sends none. */
  age?: number;
  /** An error status instead of an answer. */
  status?: number;
}

const BASE = Date.parse('2026-10-15T14:00:00.000Z');

/** Serves /api/public/stats from a queue of answers (the last one repeats); counts requests. */
async function mockStats(page: Page, answers: Answer[]) {
  const state = { calls: 0 };
  await page.route('**/api/public/stats', (route) => {
    const answer = answers[Math.min(state.calls, answers.length - 1)]!;
    state.calls++;
    if (answer.status)
      return route.fulfill({ status: answer.status, contentType: 'application/json', body: '{}' });
    const asOf = new Date(BASE + (answer.asOf ?? state.calls * 15_000)).toISOString();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: answer.age === undefined ? {} : { age: String(answer.age) },
      body: JSON.stringify({
        ai_agents_total: 512_846,
        updated_at: asOf,
        ...(answer.baseAgents === null
          ? {}
          : {
              base_agents: {
                total: answer.baseAgents ?? 31_452,
                as_of:
                  answer.baseAsOf === undefined
                    ? asOf
                    : new Date(BASE + answer.baseAsOf).toISOString(),
              },
            }),
        ...(answer.total === null
          ? {}
          : {
              paid_calls: {
                total: answer.total,
                as_of: asOf,
                recent_ms: answer.recentMs ?? [],
                recent_complete: answer.recentComplete ?? true,
              },
            }),
      }),
    });
  });
  return state;
}

/** Records every value the paid number shows (its settled value), from the first paint. */
async function recordPaid(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __paid: string[] }).__paid = seen;
    new MutationObserver(() => {
      const n = document.querySelector('[data-paid-calls-ticker] .cc-paid-n');
      const value = n?.getAttribute('data-final') ?? null;
      if (value !== null && seen[seen.length - 1] !== value) seen.push(value);
    }).observe(document, { childList: true, subtree: true, attributes: true });
  });
  return () => page.evaluate(() => (window as unknown as { __paid: string[] }).__paid.slice());
}

/** Records each roll (how many digit columns moved) and each ring of the dot, as they start. */
async function recordMotion(page: Page) {
  await page.addInitScript(() => {
    const motion = { rolls: [] as number[], rings: 0 };
    (window as unknown as { __motion: typeof motion }).__motion = motion;
    const rings = new WeakSet<Element>();
    let rolling = 0;
    new MutationObserver(() => {
      const columns = document.querySelectorAll('[data-paid-calls-ticker] .cc-paid-roll').length;
      if (columns && columns !== rolling) motion.rolls.push(columns);
      rolling = columns;
      for (const ring of document.querySelectorAll('[data-paid-calls-ticker] .cc-paid-ring'))
        if (!rings.has(ring)) {
          rings.add(ring);
          motion.rings++;
        }
    }).observe(document, { childList: true, subtree: true });
  });
  return () =>
    page.evaluate(
      () => (window as unknown as { __motion: { rolls: number[]; rings: number } }).__motion,
    );
}

/** The y of the section under the hero (null while the prerendered copy is swapped). */
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

// A fresh installation shows setup copy instead of the counts; make sure an account exists.
test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/auth/register', {
    headers: { 'x-city-request': '1' },
    data: { name: `Paid ticker ${Date.now()}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(res.status()).toBe(201);
});

test('the real number shows under the agent count, with Verify here and a sentence for screen readers', async ({
  page,
}) => {
  const values = await recordPaid(page);
  await landing(page);
  await mockStats(page, [{ total: 1_284 }]);
  await page.goto('/');
  const hero = page.getByRole('region', { name: 'Every AI. One room.' });
  const paid = hero.locator(PAID);
  await expect(paid).toHaveAttribute('data-ready', 'true');
  await expect(paid.locator('[aria-hidden="true"]')).toHaveText(
    '31,452 Base agents · 1,284 paid service calls',
  );
  // The count-in only moves the digits: the number it ends on is the real one from the start.
  expect(await values()).toEqual(['1,284']);
  // Screen readers get the whole sentence once, not the digits.
  await expect(paid.locator('.cc-agent-ticker-pill > .visually-hidden')).toHaveText(
    '31,452 Base agents and 1,284 paid service calls on Central City',
  );
  await expect(paid.locator('[aria-live="polite"]')).toHaveCount(1);
  const how = paid.getByRole('link', { name: 'Verify here' });
  await expect(how).toHaveAttribute('href', '/explorer/calls');
  // Under the agent pill, in the same column, 8 px apart.
  const agent = (await hero.locator('[data-agent-ticker] .cc-agent-ticker-pill').boundingBox())!;
  const pill = (await paid.locator('.cc-agent-ticker-pill').boundingBox())!;
  expect(pill.y).toBeGreaterThan(agent.y + agent.height - 1);
  expect(Math.abs(pill.x + pill.width / 2 - (agent.x + agent.width / 2))).toBeLessThan(1.5);
  // Minimal text, no arrows, nothing about who paid or how much; "Base agents" is the only agent
  // word.
  const text = await paid.innerText();
  expect(ARROWS.exec(text)?.[0] ?? null).toBeNull();
  expect(text).not.toMatch(/USDC|\$|today/i);
  expect(text).toContain('Base agents');
  expect(text.replace(/\bBase agents?\b/g, '')).not.toMatch(/agent/i);
  // The same pill look: mono digits, tabular, the live dot breathing.
  await expect(paid.locator('.cc-paid-n')).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await expect(paid.locator('.cc-agent-ticker-dot')).toHaveCSS('animation-name', 'cc-lp-live');
  await expect(paid).toHaveAttribute('data-stale', 'false');
  // "Verify here" opens the Agent Explorer's Service calls view.
  await expect(how).toHaveAttribute('href', '/explorer/calls');
});

test('both numbers count up from 0 together over about 1.8 s, like the agent count, and keep their width', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const seen: { base: string; paid: string; t: number }[] = [];
    (window as unknown as { __count: typeof seen }).__count = seen;
    new MutationObserver(() => {
      const line = document.querySelector('[data-paid-calls-ticker] [aria-hidden="true"]');
      const base = line?.querySelector('.cc-base-n')?.textContent ?? '';
      const paid = line?.querySelector('.cc-paid-n')?.textContent ?? '';
      const last = seen[seen.length - 1];
      if (base && paid && (!last || last.base !== base || last.paid !== paid))
        seen.push({ base, paid, t: performance.now() });
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await landing(page);
  await mockStats(page, [{ total: 1_284 }]);
  await page.goto('/');
  const paid = page.locator(PAID);
  await expect(paid.locator('[aria-hidden="true"]')).toHaveText(
    '31,452 Base agents · 1,284 paid service calls',
  );
  const seen = await page.evaluate(
    () => (window as unknown as { __count: { base: string; paid: string; t: number }[] }).__count,
  );
  const n = (text: string) => Number(text.replace(/[^0-9]/g, ''));
  // It starts low, only ever rises, and ends on the real numbers.
  expect(seen.length).toBeGreaterThan(5);
  expect(n(seen[0].base)).toBeLessThan(31_452 / 2);
  expect(n(seen[0].paid)).toBeLessThan(1_284 / 2);
  for (let i = 1; i < seen.length; i++) {
    expect(n(seen[i].base)).toBeGreaterThanOrEqual(n(seen[i - 1].base));
    expect(n(seen[i].paid)).toBeGreaterThanOrEqual(n(seen[i - 1].paid));
  }
  const last = seen[seen.length - 1];
  expect([last.base, last.paid]).toEqual(['31,452', '1,284']);
  // About as long as the agent count's count-in (1.8 s).
  expect(last.t - seen[0].t).toBeGreaterThan(1_200);
  expect(last.t - seen[0].t).toBeLessThan(2_600);
  // Screen readers get the real sentence the whole time.
  await expect(paid.locator('.cc-agent-ticker-pill > .visually-hidden')).toHaveText(
    '31,452 Base agents and 1,284 paid service calls on Central City',
  );
});

test('with reduced motion both numbers appear at once, with no count-in', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __base: string[] }).__base = seen;
    new MutationObserver(() => {
      const text = document.querySelector('[data-paid-calls-ticker] .cc-base-n')?.textContent;
      if (text && seen[seen.length - 1] !== text) seen.push(text);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await landing(page);
  await mockStats(page, [{ total: 1_284 }]);
  await page.goto('/');
  await expect(page.locator(PAID).locator('.cc-paid-n')).toHaveText('1,284');
  expect(await page.evaluate(() => (window as unknown as { __base: string[] }).__base)).toEqual([
    '31,452',
  ]);
});

test('a total of exactly 1 reads in the singular', async ({ page }) => {
  await landing(page);
  await mockStats(page, [{ total: 1, baseAgents: 1 }]);
  await page.goto('/');
  await expect(page.locator(`${PAID} [aria-hidden="true"]`)).toHaveText(
    '1 Base agent · 1 paid service call',
  );
});

test('each part hides on its own: Base agents alone, paid calls alone', async ({ page }) => {
  await landing(page);
  await mockStats(page, [{ total: null, baseAgents: 31_452 }]);
  await page.goto('/');
  const paid = page.locator(PAID);
  await expect(paid.locator('[aria-hidden="true"]')).toHaveText('31,452 Base agents');
  await expect(paid.locator('.cc-paid-n')).toHaveCount(0);
  await expect(paid.locator('.cc-paid-sep')).toHaveCount(0);
  await expect(paid.locator('.cc-agent-ticker-pill > .visually-hidden')).toHaveText(
    '31,452 Base agents on Central City',
  );
  await expect(paid.getByRole('link', { name: 'Verify here' })).toBeVisible();
  await page.unroute('**/api/public/stats');
  await mockStats(page, [{ total: 1_284, baseAgents: null }]);
  await page.goto('/');
  await expect(paid.locator('[aria-hidden="true"]')).toHaveText('1,284 paid service calls');
  await expect(paid.locator('.cc-base-n')).toHaveCount(0);
  await page.unroute('**/api/public/stats');
  await mockStats(page, [{ total: 1_284, baseAgents: 0 }]);
  await page.goto('/');
  await expect(paid.locator('[aria-hidden="true"]')).toHaveText('1,284 paid service calls');
});

test('the Base agents number changes on each poll, never between; an older copy is ignored', async ({
  page,
}) => {
  await page.clock.install();
  await landing(page);
  const stats = await mockStats(page, [
    { total: 1_284, baseAgents: 31_452, asOf: 15_000 },
    { total: 1_284, baseAgents: 31_460, asOf: 30_000 },
    // Another edge's older copy: the number never steps back.
    { total: 1_284, baseAgents: 31_400, asOf: 45_000, baseAsOf: 20_000 },
  ]);
  await page.goto('/');
  const base = page.locator(`${PAID} .cc-base-n`);
  // Past the count-in from 0 (COUNT_IN_MS), then no ticks between polls.
  await page.clock.runFor(2_000);
  await expect(base).toHaveText('31,452');
  await page.clock.runFor(11_000);
  await expect(base).toHaveText('31,452');
  await page.clock.runFor(2_000);
  await expect.poll(() => stats.calls).toBe(2);
  await expect(base).toHaveText('31,460');
  await page.clock.runFor(15_000);
  await expect.poll(() => stats.calls).toBe(3);
  await page.clock.runFor(500);
  await expect(base).toHaveText('31,460');
  // No roll on the Base agents number.
  await expect(page.locator(`${PAID} .cc-base-n .cc-paid-roll`)).toHaveCount(0);
});

test('hidden when the field is absent, the total is 0 or the first load fails; the agent count still shows', async ({
  page,
}) => {
  await landing(page, { reserved: true });
  for (const answer of [
    { total: null, baseAgents: null },
    { total: 0, baseAgents: 0 },
    { total: null, status: 503 },
  ] as Answer[]) {
    await page.unroute('**/api/public/stats');
    const stats = await mockStats(page, [answer]);
    await page.goto('/');
    // A failing endpoint is retried quickly (1 s, then 2 s) before the line gives up.
    await expect.poll(() => stats.calls).toBeGreaterThan(answer.status ? 2 : 0);
    // The reserved line closes once the answer says there is nothing to show.
    await expect(page.locator(PAID)).toHaveCount(0);
    if (!answer.status)
      await expect(page.locator('[data-agent-ticker]')).toHaveAttribute('data-ready', 'true');
  }
});

test('a failed first load is retried after 1 s: the reserved line fills, not 15 s later', async ({
  page,
}) => {
  await page.clock.install();
  await landing(page, { reserved: true });
  const stats = await mockStats(page, [{ total: null, status: 503 }, { total: 1_284 }]);
  await page.goto('/');
  await expect.poll(() => stats.calls).toBe(1);
  // The reserved line stays while the retry is due.
  await expect(page.locator(PAID)).toHaveAttribute('data-ready', 'false');
  await page.clock.runFor(1_100);
  await expect.poll(() => stats.calls).toBe(2);
  await expect(page.locator(`${PAID} .cc-base-n`)).toHaveText(/\d/);
  await expect(page.locator(PAID)).toHaveAttribute('data-ready', 'true');
});

test('a first load cut off while the page was hidden loads again as soon as it shows', async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    (window as unknown as { setHidden: (value: boolean) => void }).setHidden = (value) => {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  await landing(page, { reserved: true });
  // The first answer is held until the page has been hidden, so that load is cut off.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  await page.route('**/api/public/stats', async (route) => {
    calls++;
    if (calls === 1) await held;
    const asOf = new Date(BASE + calls * 15_000).toISOString();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ai_agents_total: 512_846,
        updated_at: asOf,
        base_agents: { total: 31_452, as_of: asOf },
        paid_calls: { total: 1_284, as_of: asOf, recent_ms: [], recent_complete: true },
      }),
    });
  });
  await page.goto('/');
  await expect.poll(() => calls).toBe(1);
  // The app's ticker has mounted (and subscribed) over the prerendered line before the page hides.
  await page.waitForFunction(() => {
    const line = document.querySelector('[data-paid-calls-ticker]');
    return Boolean(line && Object.keys(line).some((key) => key.startsWith('__reactFiber')));
  });
  await page.evaluate(() =>
    (window as unknown as { setHidden: (v: boolean) => void }).setHidden(true),
  );
  release();
  await page.evaluate(() =>
    (window as unknown as { setHidden: (v: boolean) => void }).setHidden(false),
  );
  // Shown again well inside the 15 s poll: it loads at once.
  await expect.poll(() => calls).toBe(2);
  await expect(page.locator(`${PAID} .cc-base-n`)).toHaveText(/\d/);
});

test('one request per poll feeds both counts; older copies are ignored and a lower total shows at once', async ({
  page,
}) => {
  await page.clock.install();
  const values = await recordPaid(page);
  await landing(page);
  const stats = await mockStats(page, [
    { total: 1_284, asOf: 60_000 },
    // Another edge's older copy: ignored, the number never steps back.
    { total: 1_280, asOf: 30_000 },
    // A newer copy with a lower total is a repair: shown at once.
    { total: 1_279, asOf: 90_000 },
  ]);
  await page.goto('/');
  const digits = page.locator(`${PAID} .cc-paid-n`);
  await expect(digits).toHaveText('1,284');
  await expect(page.locator('[data-agent-ticker]')).toHaveAttribute('data-ready', 'true');
  expect(stats.calls).toBe(1);
  await page.clock.runFor(15_000);
  await expect.poll(() => stats.calls).toBe(2);
  await page.clock.runFor(1_000);
  await expect(digits).toHaveText('1,284');
  await page.clock.runFor(15_000);
  await expect.poll(() => stats.calls).toBe(3);
  await expect(digits).toHaveText('1,279');
  expect(await values()).toEqual(['1,284', '1,279']);
});

test('the dot turns grey and still when the copy is more than five minutes old', async ({
  page,
}) => {
  await page.clock.install();
  await landing(page);
  // Served by the edge 400 s after it was made.
  await mockStats(page, [{ total: 42, age: 400 }]);
  await page.goto('/');
  const paid = page.locator(PAID);
  await expect(paid).toHaveAttribute('data-stale', 'true');
  const dot = paid.locator('.cc-agent-ticker-dot');
  await expect(dot).toHaveCSS('animation-name', 'none');
  await expect(dot).toHaveCSS('box-shadow', 'none');
  // The agent pill is unchanged.
  await expect(page.locator('[data-agent-ticker] .cc-agent-ticker-dot')).toHaveCSS(
    'animation-name',
    'cc-lp-live',
  );
  // A fresh copy (no Age header counts as 0) makes it live again.
  await page.unroute('**/api/public/stats');
  await mockStats(page, [
    { total: 43, asOf: 120_000 },
    { total: 43, status: 503 },
  ]);
  await page.clock.runFor(15_000);
  await expect(paid.locator('.cc-paid-n')).toHaveText('43');
  await expect(paid).toHaveAttribute('data-stale', 'false');
  await expect(dot).toHaveCSS('animation-name', 'cc-lp-live');
  // Then no fresh copy arrives (the endpoint fails): five minutes later the dot greys.
  await page.clock.runFor(280_000);
  await expect(paid).toHaveAttribute('data-stale', 'false');
  await page.clock.runFor(21_000);
  await expect(paid).toHaveAttribute('data-stale', 'true');
  await expect(paid.locator('.cc-paid-n')).toHaveText('43');
});

test('with reduced motion the number changes in place and the dot stays still', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  const values = await recordPaid(page);
  await landing(page);
  await mockStats(page, [
    { total: 9, asOf: 15_000 },
    { total: 2_500, asOf: 30_000 },
  ]);
  await page.goto('/');
  const paid = page.locator(PAID);
  await expect(paid.locator('.cc-paid-n')).toHaveText('9');
  await expect(paid.locator('.cc-agent-ticker-dot')).toHaveCSS('animation-name', 'none');
  await page.clock.runFor(15_000);
  await expect(paid.locator('.cc-paid-n')).toHaveText('2,500');
  expect(await values()).toEqual(['9', '2,500']);
});

test('two payments 10 s apart show as two separate +1s, each 45 s after its block, digits rolling', async ({
  page,
}) => {
  await page.clock.install();
  const values = await recordPaid(page);
  const motion = await recordMotion(page);
  await landing(page);
  // One copy, made when the payments were 5 s and 15 s old. Later polls fail, so the page replays
  // this one copy (a later copy would be stamped by the fake clock, not by the edge's Age).
  const answers: Answer[] = [
    { total: 100, asOf: 0, recentMs: [5_000, 15_000], age: 0 },
    { total: null, status: 503 },
  ];
  await mockStats(page, answers);
  await page.goto('/');
  const paid = page.locator(PAID);
  const digits = paid.locator('.cc-paid-n');
  // The total as it stood 45 s ago: the two payments are not due yet.
  await expect(digits).toHaveAttribute('data-final', '98');
  // The older one is due 30 s after the copy was made, the newer one 10 s later (the clock also
  // moves on its own while the page works, hence the margins).
  await page.clock.runFor(25_000);
  await expect(digits).toHaveAttribute('data-final', '98');
  await page.clock.runFor(6_000);
  await expect(digits).toHaveAttribute('data-final', '99');
  // Only the changed digit rolled (one column), and the dot rang once; then the plain digits.
  await expect.poll(async () => (await motion()).rolls).toEqual([1]);
  expect((await motion()).rings).toBe(1);
  await expect(digits).toHaveText('99');
  await expect(digits.locator('.cc-paid-roll')).toHaveCount(0);
  await page.clock.runFor(4_000);
  await expect(digits).toHaveAttribute('data-final', '99');
  await page.clock.runFor(6_000);
  await expect(digits).toHaveAttribute('data-final', '100');
  await expect(digits).toHaveText('100');
  // Two separate +1s, never a count from 0, never back; 99 to 100 rolls its three digits.
  expect(await values()).toEqual(['98', '99', '100']);
  expect(await motion()).toEqual({ rolls: [1, 3], rings: 2 });
  // The width never changed while it rolled: tabular digits in their reserved width.
  await expect(digits).toHaveCSS('font-variant-numeric', 'tabular-nums');
});

test('three payments in one Base block show as three separate +1s, each with its own roll and ring', async ({
  page,
}) => {
  await page.clock.install();
  const values = await recordPaid(page);
  const motion = await recordMotion(page);
  await landing(page);
  await mockStats(page, [
    { total: 100, asOf: 0, recentMs: [10_000, 10_000, 10_000], age: 0 },
    { total: null, status: 503 },
  ]);
  await page.goto('/');
  const digits = page.locator(`${PAID} .cc-paid-n`);
  await expect(digits).toHaveAttribute('data-final', '97');
  // Due 35 s after the copy was made, then 400 ms apart.
  await page.clock.runFor(36_500);
  await expect(digits).toHaveAttribute('data-final', '100');
  expect(await values()).toEqual(['97', '98', '99', '100']);
  expect((await motion()).rings).toBe(3);
});

test('with reduced motion a payment changes the number in place: no roll, no ring', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  const motion = await recordMotion(page);
  await landing(page);
  await mockStats(page, [{ total: 10, asOf: 0, recentMs: [40_000], age: 0 }]);
  await page.goto('/');
  const digits = page.locator(`${PAID} .cc-paid-n`);
  await expect(digits).toHaveAttribute('data-final', '9');
  await page.clock.runFor(6_000);
  await expect(digits).toHaveAttribute('data-final', '10');
  await expect(digits).toHaveText('10');
  expect(await motion()).toEqual({ rolls: [], rings: 0 });
});

test('a build that saw the count reserves the line: the pill fills it with no layout shift', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await landing(page, { reserved: true });
  await page.route('**/api/public/stats', async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ai_agents_total: 12,
        updated_at: new Date(BASE).toISOString(),
        base_agents: { total: 31_452, as_of: new Date(BASE).toISOString() },
        paid_calls: {
          total: 77,
          as_of: new Date(BASE).toISOString(),
          recent_ms: [],
          recent_complete: true,
        },
      }),
    });
  });
  await page.goto('/');
  const paid = page.locator(PAID);
  await expect(paid).toHaveAttribute('data-ready', 'false');
  await expect(paid).toHaveAttribute('data-paid-calls', '1');
  const before = await howY(page);
  release();
  await expect(paid.locator('.cc-paid-n')).toHaveText('77');
  expect(await howY(page)).toBe(before);
});

for (const width of [375, 390])
  test(`at ${width} px the Base agents and a paid total of 10 million or more fit the two reserved lines: nothing below moves`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await landing(page, { reserved: true });
    await page.route('**/api/public/stats', async (route) => {
      await gate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ai_agents_total: 512_846,
          updated_at: new Date(BASE).toISOString(),
          base_agents: { total: 1_234_567, as_of: new Date(BASE).toISOString() },
          paid_calls: {
            total: 12_345_678,
            as_of: new Date(BASE).toISOString(),
            recent_ms: [],
            recent_complete: true,
          },
        }),
      });
    });
    await page.goto('/');
    const paid = page.locator(PAID);
    await expect(paid).toHaveAttribute('data-ready', 'false');
    const before = await howY(page);
    release();
    await expect(paid.locator('.cc-paid-n')).toHaveText('12,345,678');
    expect(await howY(page)).toBe(before);
    const pill = (await paid.locator('.cc-agent-ticker-pill').boundingBox())!;
    expect(pill.height).toBeLessThanOrEqual(62);
    expect(pill.x).toBeGreaterThanOrEqual(15.5);
    expect(pill.x + pill.width).toBeLessThanOrEqual(width - 15.5);
    // Stacked: the Base agents on the first line, "paid calls" and "Verify here" on the second.
    const base = (await paid.locator('.cc-base-n').boundingBox())!;
    const digits = (await paid.locator('.cc-paid-n').boundingBox())!;
    expect(digits.y).toBeGreaterThan(base.y + base.height - 1);
    // "paid calls" here, without "service".
    await expect(paid.locator('.cc-paid-long')).toBeHidden();
    await expect(paid.locator('.cc-base-n')).toHaveText('1,234,567');
    // The sentence and "Verify here" on two lines at most.
    const link = (await paid.getByRole('link', { name: 'Verify here' }).boundingBox())!;
    expect(link.y + link.height).toBeLessThanOrEqual(pill.y + pill.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

for (const theme of ['light', 'dark'] as const)
  test(`at 375 px (${theme}): both pills fit with the 16 px margin, no sideways scroll, readable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: theme });
    await landing(page);
    await mockStats(page, [{ total: 1_284_093 }]);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const paid = page.locator(PAID);
    await expect(paid.locator('.cc-paid-n')).toHaveText('1,284,093');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    for (const pill of [
      page.locator('[data-agent-ticker] .cc-agent-ticker-pill'),
      paid.locator('.cc-agent-ticker-pill'),
    ]) {
      const box = (await pill.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(15.5);
      expect(box.x + box.width).toBeLessThanOrEqual(375 - 15.5);
    }
    // Each line reserves two lines' height on phones, as the agent pill does.
    const line = (await paid.boundingBox())!;
    expect(line.height).toBeGreaterThanOrEqual(61.5);
    expect((await lowContrast(page, PAID)).low).toEqual([]);
    if (process.env.SHOTS)
      await page.screenshot({ path: `${process.env.SHOTS}/paid-ticker-375-${theme}.png` });
  });
