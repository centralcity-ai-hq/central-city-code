import { expect, test, type Page } from '@playwright/test';

/*
 * The Agent Explorer's On Base view (/explorer/base; docs/design/on-base-mockup.html). The list
 * route is mocked: its shape is src/verify/onBaseData.ts. Base's endpoint is refused here, so a
 * Verify reports that Base wasn't reached and marks nothing as passed.
 */
const now = Date.now();
const list = (overrides: Record<string, unknown> = {}) => ({
  rows: [
    {
      baseId: '99412',
      name: 'Harbor',
      colour: '#2563eb',
      owner: '0x4B1c00000000000000000000000000000009e03',
      short: 'Hb7Qx2',
      mintTx: '0x' + 'a1'.repeat(32),
      status: 'finalizing',
      finalizingSince: now - 6 * 60_000,
    },
    {
      baseId: '99268',
      name: 'Pinako',
      colour: '#0f766e',
      owner: '0xD5224E3CD710AC7c069e66A2dFf29C387D162F03',
      short: 'R6IsTd',
      mintTx: '0xde16037751e4f71bce4c6bd261b41a81ce4258543fbd8e109d38d60518cbc1a8',
      status: 'final',
    },
  ],
  totals: {
    onBase: 1284,
    new24h: 37,
    finalizingNow: 1,
    ratedAgents: 412,
    readAtBlock: 52431207,
    readAt: now,
    servedAt: now,
  },
  registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  nextBefore: null,
  ...overrides,
});

async function mockList(page: Page, body: (url: URL) => unknown, status = 200) {
  await page.route('**/api/public/base/agents*', (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({ status, json: body(url) });
  });
  await page.route('**/api/public/stats', (route) =>
    route.fulfill({ json: { ai_agents_total: 805272 } }),
  );
  // A server without the directory: the registry page as before (e2e/directory.spec.ts has it).
  await page.route('**/api/public/directory*', (route) =>
    route.fulfill({ status: 404, json: { code: 'not_found' } }),
  );
  // Base's endpoint doesn't answer this browser: tests never read the real chain.
  await page.route('https://mainnet.base.org/**', (route) => route.abort());
}

test('On Base: the switch, the five numbers, Basescan and the newest-first list', async ({
  page,
}) => {
  await mockList(page, () => list());
  await page.goto('/explorer/base');
  await expect(page.getByRole('heading', { level: 1, name: 'Agent Explorer' })).toBeVisible();
  const views = page.getByRole('navigation', { name: 'Explorer views' });
  await expect(views.getByRole('link', { name: /On Base · 1,284/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(views.getByRole('link', { name: /All agents · 805,272/ })).toHaveAttribute(
    'href',
    '/explorer',
  );
  await expect(page.getByText('Owners are read from Base')).toBeVisible();
  const stats = page.locator('.ll-stats');
  for (const text of ['1,284', '37', '1', '412', '52,431,207'])
    await expect(stats).toContainText(text);
  // Rated agents: title, number and one short line, beside Finalizing now.
  const cards = stats.locator(':scope > div');
  await expect(cards).toHaveCount(5);
  await expect(cards.nth(3).locator('dt')).toHaveText('Rated agents');
  await expect(cards.nth(3).locator('dd').first()).toHaveText('412');
  await expect(cards.nth(3).locator('.ob-stat-sub')).toHaveText('final on Base');
  // One row on a wide screen.
  const tops = await cards.evaluateAll((all) =>
    all.map((card) => card.getBoundingClientRect().top),
  );
  expect(new Set(tops).size).toBe(1);
  const basescan = page.getByRole('link', { name: /See the registry on Basescan/ });
  await expect(basescan).toHaveAttribute(
    'href',
    'https://basescan.org/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  );
  // Plain words: no arrow after the link.
  await expect(basescan).toHaveText('See the registry on Basescan');
  await expect(basescan.locator('svg')).toHaveCount(0);
  await expect(
    page.getByText("Central City registers each agent on Base from that agent's own account."),
  ).toBeVisible();
  const rows = page.locator('.ob-item');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('99412');
  await expect(rows.nth(0)).toContainText('Finalizing');
  await expect(rows.nth(0)).toContainText('6 min · usually 15–30');
  await expect(rows.nth(1)).toContainText('Pinako');
  await expect(rows.nth(1)).toContainText('0xD522…2F03');
  await expect(rows.nth(1)).toContainText('Final');
});

test('Rated agents rises with the live re-read; without a count it keeps the last one', async ({
  page,
}) => {
  await page.clock.install();
  let rated: number | null | undefined = 412;
  await mockList(page, () => {
    const body = list();
    if (rated === undefined) delete (body.totals as Record<string, unknown>).ratedAgents;
    else body.totals.ratedAgents = rated as number;
    return body;
  });
  await page.goto('/explorer/base');
  const card = page.locator('.ll-stats > div').nth(3);
  await expect(card.locator('dd').first()).toHaveText('412');
  // The list is read again while the tab is visible: the number follows.
  rated = 413;
  await page.clock.runFor(31_000);
  await expect(card.locator('dd').first()).toHaveText('413');
  // Not counted (null), or an older server without the number: the last known one, never a
  // dash, 0 or NaN.
  rated = null;
  await page.clock.runFor(31_000);
  await expect(card.locator('dd').first()).toHaveText('413');
  rated = undefined;
  await page.clock.runFor(31_000);
  await expect(card.locator('dd').first()).toHaveText('413');
  // A browser that never saw a count keeps the skeleton.
  const fresh = await page.context().browser()!.newPage();
  await mockList(fresh, () => {
    const body = list();
    delete (body.totals as Record<string, unknown>).ratedAgents;
    return body;
  });
  await fresh.goto('/explorer/base');
  const unknown = fresh.locator('.ll-stats > div').nth(3);
  await expect(fresh.locator('.ll-stats > div').first().locator('dd').first()).not.toHaveText('');
  await expect(unknown.locator('.ob-sk')).toHaveCount(1);
  await expect(unknown).not.toContainText('—');
  await fresh.close();
});

test('Verify opens under the row and claims nothing when Base is not reached', async ({ page }) => {
  await mockList(page, () => list());
  await page.goto('/explorer/base');
  await page.getByRole('button', { name: 'Verify Base ID 99268' }).click();
  const panel = page.getByRole('region', { name: 'Verify Base ID 99268' });
  await expect(panel).toContainText("Couldn't reach Base from your browser");
  await expect(panel).toContainText('nothing is marked as passed');
  await expect(panel.locator('.ob-tick')).toHaveCount(0);
  await page.getByRole('button', { name: 'Hide Base ID 99268' }).click();
  await expect(panel).toHaveCount(0);
});

test('rows without a score show none, and Verify under a row checks no score', async ({ page }) => {
  await page.route(/\/assets\/onBaseVerify-[\w-]+\.js$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: `export async function verify(row, options) {
        window.__claim = options?.score ?? null;
        return { kind: 'unreachable' };
      }`,
    }),
  );
  await mockList(page, () => list());
  await page.goto('/explorer/base');
  await expect(page.locator('.ob-item')).toHaveCount(2);
  await expect(page.locator('.ob-table')).not.toContainText('Central City agents');
  await page.getByRole('button', { name: 'Verify Base ID 99268' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __claim?: unknown }).__claim))
    .toBeNull();
  await expect(page.getByRole('region', { name: 'Verify Base ID 99268' })).not.toContainText(
    'Score:',
  );
});

test('a scored row shows the Central City score under its name, worded as on the passport', async ({
  page,
}) => {
  await mockList(page, () => {
    const body = list();
    body.rows[1] = { ...body.rows[1]!, score: { average: '4.6', raters: 12 } } as never;
    body.rows[0] = { ...body.rows[0]!, score: null } as never;
    return body;
  });
  await page.goto('/explorer/base');
  const rows = page.locator('.ob-item');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1).locator('.ob-agent .ob-city')).toHaveText(
    '4.6 ★ from 12 Central City agents',
  );
  await expect(rows.nth(1).locator('.ob-agent b')).toHaveText('Pinako');
  // Without a score, nothing: no "no ratings" line.
  await expect(rows.nth(0).locator('.ob-city')).toHaveCount(0);
});

test('an agent whose card is gone shows "No public card", no letter', async ({ page }) => {
  await mockList(page, () => {
    const body = list();
    body.rows[1] = { ...body.rows[1]!, name: '' };
    return body;
  });
  await page.goto('/explorer/base');
  const row = page.locator('.ob-item').nth(1);
  await expect(row.locator('.ob-agent b')).toHaveText('No public card');
  await expect(row.locator('.ob-av')).toHaveText('');
});

test('a search with no match says so; Clear search brings the list back', async ({ page }) => {
  await mockList(page, (url) => (url.searchParams.get('q') ? list({ rows: [] }) : list()));
  await page.goto('/explorer/base');
  await page.getByLabel('Search agents on Base').fill('0x3333');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText('No registered agent matches “0x3333”')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.locator('.ob-item')).toHaveCount(2);
});

test('a healthy list stays live: no false outage after minutes, the block keeps moving', async ({
  page,
}) => {
  await page.clock.install();
  // The server keeps reading Base: each answer is fresh, a few blocks further on.
  const t0 = Date.now();
  let reads = 0;
  await mockList(page, () => {
    reads++;
    return list({
      totals: {
        onBase: 1284,
        new24h: 37,
        finalizingNow: 1,
        readAtBlock: 52431207 + reads * 15,
        readAt: t0 + (reads - 1) * 30_000,
        servedAt: t0 + (reads - 1) * 30_000 + 400,
      },
    });
  });
  await page.goto('/explorer/base');
  await expect(page.locator('.ll-stats')).toContainText('52,431,222');
  await page.clock.runFor(95_000);
  await expect.poll(() => reads).toBeGreaterThanOrEqual(4);
  await expect(page.getByText("Base isn't answering right now")).toHaveCount(0);
  await expect(page.locator('.ll-stats')).not.toContainText('52,431,222');
});

test("an old read says Base isn't answering; a failed load keeps the last numbers and tries again", async ({
  page,
}) => {
  await mockList(page, () =>
    list({
      totals: {
        onBase: 1284,
        new24h: 37,
        finalizingNow: 1,
        readAtBlock: 52431170,
        readAt: now - 5 * 60_000,
        servedAt: now,
      },
    }),
  );
  await page.goto('/explorer/base');
  await expect(page.getByText("Base isn't answering right now")).toBeVisible();
  await expect(page.getByText('52,431,170')).toHaveCount(2);

  // The same browser (its storage) with the list failing: the last numbers stay, marked not live.
  const other = await page.context().newPage();
  let failed = 0;
  await mockList(
    other,
    () => {
      failed += 1;
      return { error: 'unavailable' };
    },
    503,
  );
  await other.goto('/explorer/base');
  await expect(other.getByRole('alert')).toContainText("The list couldn't be loaded");
  await expect(other.getByRole('button', { name: 'Try again' })).toBeVisible();
  const stats = other.locator('.ll-stats');
  await expect(stats).toHaveAttribute('data-fresh', 'saved');
  await expect(stats.locator('> div').nth(0).locator('dd').first()).toHaveText('1,284');
  await expect(stats.locator('> div').nth(1).locator('dd').first()).toHaveText('37');
  await expect(stats.locator('> div').nth(4).locator('dd').first()).toHaveText('52,431,170');
  await expect(stats).not.toContainText('—');
  // It reads again by itself (1 s, then 2 s ...).
  await expect.poll(() => failed, { timeout: 8_000 }).toBeGreaterThanOrEqual(3);
});

test('a list read that never answers gives up after 15 s and tries again; the rows say loading', async ({
  page,
}) => {
  await page.clock.install({ time: now });
  let reads = 0;
  let answer = false;
  await mockList(page, () => list());
  await page.route('**/api/public/base/agents*', async (route) => {
    reads += 1;
    if (answer) return route.fallback();
    // Never answers (a cold, stuck read).
    await new Promise(() => undefined);
  });
  await page.goto('/explorer/base');
  await expect.poll(() => reads).toBe(1);
  await expect(page.locator('.ob-table')).toHaveAttribute('data-rows', 'loading');
  await expect(page.locator('.ob-head')).toContainText('Loading agents…');
  await page.clock.runFor(15_000);
  await expect(page.getByRole('alert')).toContainText("The list couldn't be loaded");
  // Read again after 1 s; this time it answers.
  answer = true;
  await page.clock.runFor(1_100);
  await expect.poll(() => reads).toBe(2);
  await expect(page.locator('.ob-table')).toHaveAttribute('data-rows', 'ready');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.ll-stats')).toHaveAttribute('data-fresh', 'live');
});

test('before the server has read Base, the block says so and nothing claims an outage', async ({
  page,
}) => {
  await mockList(page, () =>
    list({
      rows: [],
      totals: {
        onBase: 0,
        new24h: 0,
        finalizingNow: 0,
        readAtBlock: null,
        readAt: null,
        servedAt: now,
      },
    }),
  );
  await page.goto('/explorer/base');
  const block = page.locator('.ll-stats > div').filter({ hasText: 'Read from Base block' });
  // No block known yet: the skeleton stays, never a dash.
  await expect(block.locator('.ob-sk')).toHaveCount(1);
  await expect(block).not.toContainText('—');
  await expect(block).toContainText('not read yet');
  await expect(page.getByText("Base isn't answering right now")).toHaveCount(0);
});

test("a viewer's clock running fast never makes up an outage", async ({ page }) => {
  // The device is 2 minutes ahead; the server read Base 1 s before it answered.
  await page.clock.install({ time: now + 2 * 60_000 });
  await mockList(page, () => list());
  await page.goto('/explorer/base');
  await expect(page.locator('.ob-item')).toHaveCount(2);
  await expect(page.getByText("Base isn't answering right now")).toHaveCount(0);
});

test('All agents shows the same switch with On Base beside it', async ({ page }) => {
  await mockList(page, () => list());
  await page.goto('/explorer');
  const views = page.getByRole('navigation', { name: 'Explorer views' });
  await expect(views.getByRole('link', { name: /^All agents/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(views.getByRole('link', { name: /On Base · 1,284/ })).toHaveAttribute(
    'href',
    '/explorer/base',
  );
});

for (const theme of ['light', 'dark'] as const)
  test(`On Base at 390 px (${theme}): rows stack, no sideways scroll`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    await mockList(page, () => list());
    await page.goto('/explorer/base');
    await expect(page.locator('.ob-item')).toHaveCount(2);
    // Five numbers, two per row; the block's card fills the last row. All inside the screen.
    const cards = page.locator('.ll-stats > div');
    await expect(cards.nth(3)).toContainText('Rated agents');
    const boxes = await cards.evaluateAll((all) =>
      all.map((card) => {
        const box = card.getBoundingClientRect();
        return { top: Math.round(box.top), left: box.left, right: box.right };
      }),
    );
    expect(boxes.map((box) => box.top)).toEqual([
      boxes[0].top,
      boxes[0].top,
      boxes[2].top,
      boxes[2].top,
      boxes[4].top,
    ]);
    expect(boxes[2].top).toBeGreaterThan(boxes[0].top);
    expect(boxes[4].top).toBeGreaterThan(boxes[2].top);
    expect(boxes[4].left).toBe(boxes[0].left);
    expect(boxes[4].right).toBe(boxes[1].right);
    for (const box of boxes) expect(box.right).toBeLessThanOrEqual(390);
    // Each card's short line stays on one line, so the cards of a row keep one height.
    const subs = await page.locator('.ll-stats .ob-stat-sub').evaluateAll((all) =>
      all.map((sub) => {
        const style = getComputedStyle(sub);
        return { height: sub.getBoundingClientRect().height, line: parseFloat(style.lineHeight) };
      }),
    );
    for (const sub of subs) expect(sub.height).toBeLessThan(sub.line * 1.5);
    await page.getByRole('button', { name: 'Verify Base ID 99268' }).click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (process.env.SHOTS)
      await page.screenshot({
        path: `${process.env.SHOTS}/onbase-build-390-${theme}.png`,
        fullPage: true,
      });
  });

test('an open Verify checks again when a re-read changes the row; no old result stays', async ({
  page,
}) => {
  await page.clock.install();
  // Verify's Base reads, replaced by one that counts its runs and answers "unreachable".
  await page.route(/\/assets\/onBaseVerify-[\w-]+\.js$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: `export async function verify(row) {
        window.__checked = [...(window.__checked ?? []), row.owner];
        return { kind: 'unreachable' };
      }`,
    }),
  );
  let reads = 0;
  await mockList(page, () => {
    reads += 1;
    const body = list();
    if (reads > 1)
      body.rows[1] = { ...body.rows[1]!, owner: '0x69eA9b7512C8EF4F3A3eEe5Ec6bD6D812071BC78' };
    const t = Date.now();
    return { ...body, totals: { ...body.totals, readAt: t, servedAt: t } };
  });
  await page.goto('/explorer/base');
  await page.getByRole('button', { name: 'Verify Base ID 99268' }).click();
  const checked = () =>
    page.evaluate(() => (window as unknown as { __checked?: string[] }).__checked ?? []);
  await expect.poll(checked).toEqual(['0xD5224E3CD710AC7c069e66A2dFf29C387D162F03']);

  await page.clock.runFor(31_000);
  await expect(page.locator('.ob-item').nth(1)).toContainText('0x69eA…BC78');
  await expect
    .poll(checked)
    .toEqual([
      '0xD5224E3CD710AC7c069e66A2dFf29C387D162F03',
      '0x69eA9b7512C8EF4F3A3eEe5Ec6bD6D812071BC78',
    ]);
  await expect(page.getByRole('region', { name: 'Verify Base ID 99268' })).toBeVisible();
});

for (const total of [0, 1284])
  test(`Explorer Base count uses stats without waiting for the directory (${total})`, async ({
    page,
  }) => {
    await mockList(page, () => list());
    let directoryReads = 0;
    let statsReads = 0;
    await page.route('**/api/public/base/agents*', async (route) => {
      directoryReads++;
      await route.abort();
    });
    await page.route('**/api/public/stats', (route) => {
      statsReads++;
      return route.fulfill({
        json: {
          ai_agents_total: 805272,
          updated_at: new Date().toISOString(),
          base_agents: { total, as_of: new Date().toISOString() },
        },
      });
    });
    await page.goto('/explorer');
    const views = page.getByRole('navigation', { name: 'Explorer views' });
    await expect(
      views.getByRole('link', { name: `On Base · ${total.toLocaleString('en-US')}`, exact: true }),
    ).toBeVisible();
    expect(directoryReads).toBe(0);
    // One for checkpoint verification, one shared by the two switch hooks.
    expect(statsReads).toBe(2);
  });
