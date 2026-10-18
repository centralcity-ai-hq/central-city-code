import { test, expect, type Page } from '@playwright/test';
import {
  checkpointHash,
  checkpointSigningInput,
  merkleRoot,
  sha256,
  toHex,
} from '../shared/count-log/index';

/*
 * /downtown/log, the Live log (count log explorer, Phase 1): entries newest first, paging, search
 * and a proof per entry, all from the public count-log routes. The log is served by page.route
 * (a synthetic tree, optionally signed with a key made here): taking the day's real checkpoint
 * would change what e2e/verify.spec.ts sees. The real routes are covered there and in
 * tests/count-log*.test.ts.
 */
const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/**
 * A synthetic log of `size` leaves with a matching checkpoint, signed when `signed`, or a v1
 * checkpoint as served now (hash, signature and link withheld) when `signed` is 'v1'.
 */
async function mockLog(
  page: Page,
  size: number,
  withdrawn: number[] = [],
  signed: boolean | 'v1' = false,
) {
  const leaves = await Promise.all(
    Array.from({ length: size }, (_, idx) => sha256(new TextEncoder().encode(`leaf-${idx}`))),
  );
  const hex = leaves.map(toHex);
  const body = {
    v: 2 as const,
    date: '2026-10-01',
    tree_size: size,
    withdrawn: withdrawn.length,
    root: toHex(await merkleRoot(leaves)),
    prev_hash: null,
    subcounts_commitment: 'ab'.repeat(32),
  };
  const hash = await checkpointHash(body);
  let signature: { kid: string; sig: string } | null = null;
  if (signed === true) {
    const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'Ed25519' },
        keys.privateKey,
        checkpointSigningInput(hash) as BufferSource,
      ),
    );
    signature = { kid: 'e2e-key', sig: Buffer.from(sig).toString('base64url') };
    const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
    await page.route('**/.well-known/jwks.json', (route) =>
      route.fulfill(json({ keys: [{ kid: 'e2e-key', kty: jwk.kty, crv: jwk.crv, x: jwk.x }] })),
    );
  }
  const checkpoint =
    signed === 'v1'
      ? {
          v: 1,
          date: body.date,
          tree_size: size,
          withdrawn: withdrawn.length,
          root: body.root,
          subcounts_withheld: true,
          signature_withheld: true,
          consistency: [],
        }
      : { ...body, hash, signature, consistency: [] };
  await page.route(
    (url) => url.pathname === '/api/public/count-log/checkpoints',
    (route) => route.fulfill(json({ checkpoints: [checkpoint] })),
  );
  await page.route('**/api/public/count-log/leaves?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const from = Number(query.get('from') ?? 0);
    const to = Math.min(Number(query.get('to') ?? from + 10_000), size);
    return route.fulfill(
      json({
        from,
        tree_size: size,
        leaves: hex.slice(from, to).map((leaf_hash, i) => ({
          idx: from + i,
          leaf_hash,
          day: '2026-09-30',
        })),
      }),
    );
  });
  await page.route('**/api/public/count-log/withdrawn*', (route) =>
    route.fulfill(
      json({ withdrawn: withdrawn.map((idx) => ({ idx, reason: 'abuse', day: '2026-10-01' })) }),
    ),
  );
  await page.route('**/api/public/stats', (route) =>
    route.fulfill(json({ ai_agents_total: 4321 })),
  );
  // No live feed unless a test serves one (registered later, so it takes precedence): the e2e
  // server's real feed would otherwise replace this synthetic log's numbers.
  await page.route('**/api/public/count-log/feed*', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found."}' }),
  );
  return hex;
}

test('the live log lists entries newest first and proves one in this browser', async ({ page }) => {
  await mockLog(page, 7, [], true);
  await page.goto('/downtown/log');
  await expect(page.getByRole('heading', { level: 1, name: 'Agent Explorer' })).toBeVisible();
  // One page name: the header says Agent Explorer, never "Live log".
  await expect(page.locator('.vf-head')).not.toContainText('Live log');
  const entries = page.getByTestId('ll-entry');
  // Newest first: the first row is the last entry, never #1.
  await expect(entries.first()).toContainText('#7');
  await expect(entries.last()).toContainText('#1');
  await expect(page.locator('.ll-stats')).toContainText('Next update');
  await expect(page.locator('.ll-stats')).toContainText('2026-10-01');

  await entries.first().getByRole('button', { name: 'Verify' }).click();
  const proof = entries.first().getByTestId('ll-proof');
  await expect(proof).toContainText('RFC 6962 leaf hash');
  await expect(proof).toContainText('signed ✓');
  await expect(proof.getByRole('link', { name: 'This entry (JSON)' })).toHaveAttribute(
    'href',
    '/api/public/count-log/leaves?from=6&to=7',
  );
  await expect(proof.getByRole('link', { name: /agentLeafHash/ })).toHaveAttribute(
    'href',
    /^https:\/\/github\.com\/centralcity-ai-hq\/central-city-code\/blob\/[0-9a-f]{40}\/shared\/count-log\/index\.ts#L\d+-L\d+$/,
  );
  await expect(
    proof.getByRole('link', { name: /Independent copies of the signed checkpoints/ }),
  ).toHaveAttribute(
    'href',
    'https://github.com/centralcity-ai-hq/transparency/tree/main/agent-count',
  );
  await expect(proof.getByLabel('curl commands', { exact: true })).toContainText(
    '/api/public/count-log/checkpoints/2026-10-01',
  );
  await proof.getByRole('button', { name: 'Check it’s in the signed checkpoint' }).click();
  await expect(proof.getByRole('status')).toContainText(
    '✓ Entry #7 is in the checkpoint of 2026-10-01',
  );
});

test('a withheld v1 checkpoint: no signature status, and the inclusion proof still checks', async ({
  page,
}) => {
  await mockLog(page, 5, [], 'v1');
  await page.goto('/downtown/log');
  const entries = page.getByTestId('ll-entry');
  await entries.first().getByRole('button', { name: 'Verify' }).click();
  const proof = entries.first().getByTestId('ll-proof');
  await expect(proof).toContainText(/: root [0-9a-f]{12}…[0-9a-f]{6}, chain append-only ✓\./);
  await expect(proof).not.toContainText(/withheld|\(v1\)|, previous checkpoint/);
  await expect(proof).not.toContainText(/signed ✓|not checkable|signature unknown/);
  await proof.getByRole('button', { name: 'Check it’s in the checkpoint' }).click();
  await expect(proof.getByRole('status')).toContainText(
    '✓ Entry #5 is in the checkpoint of 2026-10-01',
  );
  await expect(proof.getByRole('status')).not.toContainText(/signed|not confirmed/);
});

test('paging goes back in time, search jumps to an entry, withdrawn entries are marked', async ({
  page,
}) => {
  const hex = await mockLog(page, 120, [2]);
  await page.goto('/downtown/log');
  const entries = page.getByTestId('ll-entry');
  /** The row of one entry number (exact, so #3 is not #30). */
  const row = (n: number) =>
    entries.filter({ has: page.locator('.ll-seq', { hasText: new RegExp(`^#${n}$`) }) });
  await expect(entries).toHaveCount(50);
  await expect(entries.first()).toContainText('#120');
  await expect(entries.last()).toContainText('#71');
  await expect(page.locator('.ll-stats')).toContainText('4,321');

  await page.getByRole('button', { name: 'Load older entries' }).click();
  await expect(entries).toHaveCount(100);
  await expect(entries.last()).toContainText('#21');

  // By number: loads down to it and opens its proof.
  await page.getByPlaceholder('Fingerprint or #number').fill('#3');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(row(3).locator('.ll-status')).toHaveText('Withdrawn');
  await expect(row(3).getByTestId('ll-proof')).toBeVisible();
  await expect(row(120).locator('.ll-status')).toHaveText('Counted');

  // By fingerprint prefix.
  await page.getByPlaceholder('Fingerprint or #number').fill(hex[9]!.slice(0, 16));
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText('Entry #10.')).toBeVisible();
  await expect(row(10).getByTestId('ll-proof')).toBeVisible();

  // An unsigned checkpoint is never shown as confirmed.
  const proof = row(10).getByTestId('ll-proof');
  await proof.getByRole('button', { name: 'Check it’s in the signed checkpoint' }).click();
  await expect(proof.getByRole('status')).toContainText('so this is not confirmed');
  await expect(proof.getByRole('status')).not.toContainText('✓');

  await page.getByPlaceholder('Fingerprint or #number').fill('#999');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText('There is no entry #999 yet.')).toBeVisible();
});

test('the verify page has no entry list; /explorer and /downtown/log are the same page', async ({
  page,
}) => {
  await mockLog(page, 30);
  await page.goto('/downtown/verify');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Verify the agent count' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Log entries' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /See the live log/ })).toHaveCount(0);
  for (const path of ['/explorer', '/downtown/log']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: 'Agent Explorer' })).toBeVisible();
  }
});

test('390 px: stacked rows, no sideways scroll, light and dark', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockLog(page, 60);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/downtown/log');
    await expect(page.getByTestId('ll-entry')).toHaveCount(50);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    const verify = page.getByTestId('ll-entry').first().getByRole('button', { name: 'Verify' });
    const box = (await verify.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    // The proof panel wraps inside the page too (long fingerprints and commands).
    await verify.click();
    const proof = page.getByTestId('ll-proof');
    const panel = (await proof.boundingBox())!;
    expect(panel.x + panel.width).toBeLessThanOrEqual(390);
    const widest = await proof.evaluate((element) =>
      Math.max(
        ...Array.from(element.querySelectorAll('dd, p, li')).map(
          (child) => child.getBoundingClientRect().right,
        ),
      ),
    );
    expect(widest).toBeLessThanOrEqual(390);
  }
});

test('Phase 2 feed: new agents appear as pending, then flip in place to confirmed', async ({
  page,
}) => {
  await mockLog(page, 7, [], true);
  const minute = new Date(Date.now() - 2 * 60_000).toISOString().slice(0, 16) + 'Z';
  const fp = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
  let polls = 0;
  await page.route('**/api/public/count-log/feed*', (route) => {
    polls += 1;
    const later = polls > 1;
    return route.fulfill(
      json({
        entries: [
          ...(later ? [{ fingerprint: fp(3), minute, day: '2026-10-01', status: 'pending' }] : []),
          later
            ? {
                fingerprint: fp(2),
                minute,
                status: 'confirmed',
                idx: 6,
                checkpoint_date: '2026-10-01',
              }
            : { fingerprint: fp(2), minute, day: '2026-10-01', status: 'pending' },
          { fingerprint: fp(1), minute, day: '2026-10-01', status: 'removed' },
          { fingerprint: fp(4), day: '2026-09-30', status: 'removed' },
        ],
        next: null,
        latest_checkpoint: '2026-10-01',
        new_24h: later ? 3 : 2,
      }),
    );
  });
  await page.goto('/downtown/log');
  const feed = page.getByRole('region', { name: 'Latest agents' });
  await expect(feed).toContainText('Preview, not yet signed');
  // The stats bar shows the server's count of the last 24 h.
  await expect(page.locator('.ll-stats')).toContainText('New in the last 24 h');
  await expect(
    page.locator('.ll-stats div').filter({ hasText: 'New in the last 24 h' }),
  ).toContainText('2');
  const rows = feed.getByTestId('ll-feed-entry');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('Pending · confirmed at 12:00 CEST');
  await expect(rows.first()).toContainText('2 min ago');
  // The exact minute on hover, in UTC.
  await expect(rows.first().locator('.ll-day')).toHaveAttribute(
    'title',
    `${minute.slice(0, 10)} ${minute.slice(11, 16)} UTC`,
  );
  await expect(rows.nth(1)).toContainText('Removed, not counted');
  // Removed (withdrawn or never counted): no number, no Verify; without a minute, the day.
  await expect(rows.last()).toContainText('Removed, not counted');
  await expect(rows.last()).toContainText('2026-09-30');
  await expect(rows.last().getByRole('button', { name: 'Verify' })).toHaveCount(0);

  // The next poll (3 s): a newcomer slides in on top, the pending one flips in place.
  await expect(rows).toHaveCount(4, { timeout: 8_000 });
  await expect(rows.first()).toHaveAttribute('data-fresh', 'true');
  const flipped = rows.filter({ hasText: fp(2).slice(0, 12) });
  await expect(flipped).toContainText('In checkpoint 2026-10-01 · #7');
  // Verify jumps to that entry in the log, with its proof open.
  await flipped.getByRole('button', { name: 'Verify' }).click();
  const entry = page
    .getByTestId('ll-entry')
    .filter({ has: page.locator('.ll-seq', { hasText: /^#7$/ }) });
  await expect(entry.getByTestId('ll-proof')).toBeVisible();
});

test('without a feed on the server (404) the page stays as in Phase 1', async ({ page }) => {
  await mockLog(page, 3);
  await page.route('**/api/public/count-log/feed*', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found."}' }),
  );
  await page.goto('/downtown/log');
  await expect(page.getByTestId('ll-entry')).toHaveCount(3);
  await expect(page.getByRole('region', { name: 'Latest agents' })).toHaveCount(0);
});

test('a feed error (not 404) clears pending rows and says so; settled rows stay', async ({
  page,
}) => {
  await mockLog(page, 7, [], true);
  const minute = new Date(Date.now() - 60_000).toISOString().slice(0, 16) + 'Z';
  let fail = false;
  await page.route('**/api/public/count-log/feed*', (route) =>
    fail
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"x"}' })
      : route.fulfill(
          json({
            entries: [
              { fingerprint: 'aa'.repeat(32), minute, day: '2026-10-01', status: 'pending' },
              {
                fingerprint: 'bb'.repeat(32),
                minute,
                status: 'confirmed',
                idx: 6,
                checkpoint_date: '2026-10-01',
              },
            ],
            next: null,
            latest_checkpoint: '2026-10-01',
          }),
        ),
  );
  await page.goto('/downtown/log');
  const feed = page.getByRole('region', { name: 'Latest agents' });
  await expect(feed.getByTestId('ll-feed-entry')).toHaveCount(2);
  fail = true;
  await expect(
    feed.getByText('The live preview can’t be reached right now; trying again.'),
  ).toBeVisible({
    timeout: 8_000,
  });
  await expect(feed.getByTestId('ll-feed-entry')).toHaveCount(1);
  await expect(feed.getByTestId('ll-feed-entry')).toContainText('In checkpoint 2026-10-01 · #7');
  fail = false;
  await expect(feed.getByTestId('ll-feed-entry')).toHaveCount(2, { timeout: 8_000 });
  await expect(feed.getByRole('status')).toHaveCount(0);
});

test('Agent Explorer is in the Open Source menu and the footer', async ({ page }) => {
  await mockLog(page, 3);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const nav = page.getByRole('banner').getByRole('navigation', { name: 'Public' });
  await nav.getByRole('button', { name: 'Open Source', exact: true }).click();
  const entry = page.getByRole('link', { name: /^Agent Explorer/ }).first();
  await expect(entry).toHaveAttribute('href', '/explorer');
  await expect(entry).toContainText('Every AI agent on Central City, live');
  await expect(
    page.getByRole('contentinfo').getByRole('link', { name: 'Agent Explorer', exact: true }),
  ).toHaveAttribute('href', '/explorer');
  await entry.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Agent Explorer' })).toBeVisible();
  await expect(page.getByPlaceholder('Fingerprint or #number')).toBeVisible();
});

test('the main list is the live feed: live numbers, total now, new rows on top, confirmed in place', async ({
  page,
}) => {
  await mockLog(page, 5_420, [], true);
  const minute = new Date(Date.now() - 60_000).toISOString().slice(0, 16) + 'Z';
  const fp = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
  let polls = 0;
  let beforeRequests = 0;
  await page.route('**/api/public/count-log/feed*', (route) => {
    if (route.request().url().includes('before=')) beforeRequests += 1;
    polls += 1;
    const later = polls > 1;
    return route.fulfill(
      json({
        entries: [
          ...(later
            ? [{ fingerprint: fp(32), minute, day: '2026-10-01', status: 'pending', n: 5_431 }]
            : []),
          // n is the 0-based idx the next checkpoint assigns (server/count-log/pending.ts),
          // shown as #(n + 1).
          { fingerprint: fp(31), minute, day: '2026-10-01', status: 'pending', n: 5_430 },
          later
            ? {
                fingerprint: fp(30),
                minute,
                day: '2026-10-01',
                status: 'confirmed',
                idx: 5_419,
                checkpoint_date: '2026-10-01',
              }
            : { fingerprint: fp(30), minute, day: '2026-10-01', status: 'pending', n: 5_429 },
        ],
        next: null,
        latest_checkpoint: '2026-10-01',
        total_now: later ? 5_432 : 5_431,
        // Far more than the feed's pages: the exact server count, never "550+".
        new_24h: later ? 25_118 : 25_117,
      }),
    );
  });
  await page.goto('/downtown/log');
  const rows = page.getByRole('region', { name: 'Latest agents' }).getByTestId('ll-feed-entry');
  // Newest first; the top row is the live total, provisional while pending.
  await expect(rows.first().locator('.ll-seq')).toHaveText('#5,431');
  await expect(rows.first().locator('.ll-seq')).toHaveAttribute('data-provisional', 'true');
  const now = page.locator('.ll-stats div').filter({ hasText: 'AI agents now' });
  await expect(now).toContainText('5,431');
  const day = page.locator('.ll-stats div').filter({ hasText: 'New in the last 24 h' });
  await expect(day.locator('dd')).toHaveText('25,117');
  await expect(day.locator('dd')).not.toHaveAttribute('aria-busy', 'true');
  // The next poll: a newcomer on top, the total follows, a pending row is confirmed in place.
  await expect(rows.first().locator('.ll-seq')).toHaveText('#5,432', { timeout: 8_000 });
  await expect(now).toContainText('5,432');
  // It updates live with the same poll, exact (no "+"), and no older pages are read to count.
  await expect(day.locator('dd')).toHaveText('25,118');
  expect(beforeRequests).toBe(0);
  const confirmed = rows.filter({ hasText: fp(30).slice(0, 12) });
  await expect(confirmed).toContainText('In checkpoint 2026-10-01 · #5,420');
  await expect(confirmed.locator('.ll-seq')).toHaveText('#5,420');
  await expect(confirmed.locator('.ll-seq')).not.toHaveAttribute('data-provisional', 'true');
  // Search finds a pending agent in the live list by its provisional number.
  await page.getByPlaceholder('Fingerprint or #number').fill('#5,431');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText('Pending #5,431: confirmed at the next checkpoint.')).toBeVisible();
  // The signed checkpoint list stays below.
  await expect(page.getByRole('heading', { name: 'Signed log' })).toBeVisible();
});
