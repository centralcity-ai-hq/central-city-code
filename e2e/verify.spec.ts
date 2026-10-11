import { test, expect, type Page } from '@playwright/test';
import {
  agentLeafHash,
  checkpointHash,
  checkpointSigningInput,
  merkleRoot,
  sha256,
  toHex,
} from '../shared/count-log/index';
import { landingWithTicker } from './landing-html';

/*
 * /downtown/verify (verifiable agent count, T2): every check runs in the browser with
 * shared/count-log. One real checkpoint is taken through the cron endpoint (CRON_SECRET is set for
 * the e2e server in playwright.config.ts); tampering and the empty state are served by page.route.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const CRON = { authorization: 'Bearer e2e-count-log-cron-secret' };

/** The result line for one of the signed-in owner's agents (each agent is checked on its own). */
const agentResult = (mine: ReturnType<Page['getByRole']>, name: string) =>
  mine.getByRole('listitem').filter({ hasText: name }).getByRole('status');

async function signUpWithAgent(page: Page, agentName: string) {
  const headers = { 'x-city-request': '1' };
  expect(
    (
      await page.request.post('/api/auth/register', {
        headers,
        data: { name: `vf-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
      })
    ).status(),
  ).toBe(201);
  const agent = await page.request.post('/api/agents', {
    headers,
    data: { name: agentName, description: 'e2e', capability: 'research', mode: 'external' },
  });
  expect(agent.ok()).toBeTruthy();
  return (await agent.json()).agent.id as string;
}

test('the verify page checks the real log in the browser, and an owner checks their agent', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signUpWithAgent(page, 'Verified Agent');
  const cron = await page.request.get('/api/cron/count-checkpoint', { headers: CRON });
  expect(cron.ok(), await cron.text()).toBeTruthy();

  await page.goto('/downtown/verify');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Verify the agent count' }),
  ).toBeVisible();
  const number = page.getByRole('region', { name: 'The number' });
  await expect(number.locator('.vf-figure')).toContainText(
    /AI agents? in the checkpoint of \d{4}-\d{2}-\d{2}/,
  );
  await expect(
    number.getByText(/form one unbroken chain|The first daily checkpoint verifies/),
  ).toBeVisible();
  await expect(
    number.getByText('Every checkpoint is signed with Central City’s published key.'),
  ).toBeVisible();
  // No breakdown block: no per-kind rows and no footnote about them.
  await expect(number.locator('.vf-sub')).toHaveCount(0);
  await expect(number).not.toContainText(
    /In a person’s account|In an AI-owned workspace|Unclaimed \(created without an account\)|Of all these, revoked since|Withdrawn from the count|Unclaimed agents can be created/,
  );
  // Recount every public entry (recomputes the root) in the browser.
  await number.getByRole('button', { name: /^Recount/ }).click();
  await expect(number.getByText(/(match|matches) the published checkpoint exactly/)).toBeVisible();
  // History: chain and signature per day.
  await expect(page.getByRole('region', { name: 'Checkpoints' })).toContainText(
    'linked ✓ · signed ✓',
  );

  // Check my agent (the session from sign-up): every own agent is checked in the browser.
  const mine = page.getByRole('region', { name: 'Check my agent' });
  await expect(agentResult(mine, 'Verified Agent')).toContainText(
    /✓ Included as #\d+ in the checkpoint of/,
  );

  // An agent created after the checkpoint is pending until the next one.
  const late = await page.request.post('/api/agents', {
    headers: { 'x-city-request': '1' },
    data: { name: 'Late Agent', description: 'e2e', capability: 'research', mode: 'external' },
  });
  expect(late.ok()).toBeTruthy();
  await page.reload();
  await expect(agentResult(mine, 'Late Agent')).toContainText('Not in a checkpoint yet');
  expect(errors).toEqual([]);
});

test('a tampered history is shown as failing, not hidden', async ({ page }) => {
  await page.goto('/downtown/verify'); // establish the origin for the fetch below
  const real = await (await page.request.get('/api/public/count-log/checkpoints')).json();
  test.skip(!real.checkpoints.length, 'needs the checkpoint from the first test');
  const forged = real.checkpoints.map((cp: { tree_size: number }) => ({
    ...cp,
    tree_size: cp.tree_size + 5,
  }));
  await page.route('**/api/public/count-log/checkpoints', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ checkpoints: forged }),
    }),
  );
  await page.reload();
  const number = page.getByRole('region', { name: 'The number' });
  await expect(
    number.getByText(/Problems found: .*hash does not match the checkpoint/),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Checkpoints' })).toContainText(
    'hash does not match',
  );
});

test('an owner never sees ✓ for a checkpoint whose signature is not confirmed; demo agents are "not counted"', async ({
  page,
}) => {
  const headers = { 'x-city-request': '1' };
  await signUpWithAgent(page, 'Careful Agent');
  expect((await page.request.post('/api/demo/start', { headers, data: {} })).ok()).toBeTruthy();
  await page.request.get('/api/cron/count-checkpoint', { headers: CRON });
  // The key is not published: signatures can't be confirmed, so no ✓ for the owner either.
  await page.route('**/.well-known/jwks.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"keys":[]}' }),
  );
  await page.goto('/downtown/verify');
  const mine = page.getByRole('region', { name: 'Check my agent' });
  // An agent created before today's checkpoint may already be in it, or pending; either way no ✓.
  await expect(agentResult(mine, 'Careful Agent')).not.toBeEmpty();
  await expect(agentResult(mine, 'Careful Agent')).not.toContainText('✓');
  // The console demo's samples are never counted, and the page says so.
  await expect(agentResult(mine, 'Atlas')).toContainText('Not counted (CC agents)');
});

test('the owner list does not load the console snapshot; a checkpoint found only on refetch is "not yet checked"', async ({
  page,
}) => {
  const snapshots: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/snapshot') snapshots.push(request.url());
  });
  const agentId = await signUpWithAgent(page, 'Refetch Agent');
  // A valid one-leaf log for this agent, published only in the "fresh" list (the edge-cached
  // list the page loads first does not have it yet).
  const salt = new Uint8Array(32).fill(9);
  const leaf = await agentLeafHash(agentId, salt, '2099-01-01');
  const body = {
    v: 2 as const,
    date: '2099-01-01',
    tree_size: 1,
    withdrawn: 0,
    root: toHex(await merkleRoot([leaf])),
    prev_hash: null,
    subcounts_commitment: 'ab'.repeat(32),
  };
  const checkpoint = {
    ...body,
    hash: await checkpointHash(body),
    signature: null,
    consistency: [],
  };
  await page.route(
    (url) => url.pathname === '/api/public/count-log/checkpoints',
    (route, request) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checkpoints: new URL(request.url()).searchParams.has('after') ? [checkpoint] : [],
        }),
      }),
  );
  await page.route(`**/api/agents/${agentId}/count-proof`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        pending: false,
        proof: {
          idx: 0,
          salt: toHex(salt),
          created_day: '2099-01-01',
          checkpoint_date: '2099-01-01',
          tree_size: 1,
          audit_path: [],
        },
      }),
    }),
  );
  await page.goto('/downtown/verify');
  const mine = page.getByRole('region', { name: 'Check my agent' });
  const result = mine.getByRole('listitem').first().getByRole('status');
  await expect(result).toContainText('not yet checked');
  await expect(result).not.toContainText('✓');
  expect(snapshots).toEqual([]);
});

test('the verify page fits 360 px in light and dark (design v8 cards)', async ({ page }) => {
  await page.request.get('/api/cron/count-checkpoint', { headers: CRON });
  const real = await (await page.request.get('/api/public/count-log/checkpoints')).json();
  test.skip(!real.checkpoints.length, 'needs a checkpoint');
  await page.setViewportSize({ width: 360, height: 780 });
  for (const scheme of ['light', 'dark'] as const) {
    await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
    await page.goto('/downtown/verify');
    await expect(
      page.getByRole('region', { name: 'The number' }).locator('.vf-figure'),
    ).toBeVisible();
    // A big log makes the recount label long (CI's shared server has many agents): it must wrap.
    await page
      .locator('.vf-leaves .button')
      .evaluate((button) => (button.textContent = 'Recount all 1,234,567 entries in your browser'));
    // Nothing wider than the page (the table scrolls inside its own box).
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll('.vf-card, .vf-card *')]
        .filter((element) => !element.closest('.vf-table'))
        .filter((element) => element.getBoundingClientRect().right > innerWidth + 0.5)
        .map((element) => element.className || element.tagName),
    );
    expect(wide, scheme).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

test('a failed recompute offers to try again', async ({ page }) => {
  await page.goto('/downtown/verify');
  const real = await (await page.request.get('/api/public/count-log/checkpoints')).json();
  test.skip(!real.checkpoints.length, 'needs a checkpoint');
  await page.route('**/api/public/count-log/leaves**', (route) => route.abort());
  await page.reload();
  const number = page.getByRole('region', { name: 'The number' });
  await number.getByRole('button', { name: /^Recount/ }).click();
  await expect(number.getByText('The entries could not be downloaded.')).toBeVisible();
  await page.unroute('**/api/public/count-log/leaves**');
  await number.getByRole('button', { name: /Try again: Recount/ }).click();
  await expect(number.getByText(/(match|matches) the published checkpoint exactly/)).toBeVisible();
});

test('before the first checkpoint the page still shows everything useful', async ({ page }) => {
  await page.route('**/api/public/count-log/checkpoints', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"checkpoints":[]}' }),
  );
  await page.route('**/api/public/count-log/leaves**', (route) =>
    route.fulfill({ json: { from: 0, tree_size: 0, leaves: [] } }),
  );
  await page.route('**/api/public/stats', (route) =>
    route.fulfill({ json: { ai_agents_total: 90, updated_at: new Date().toISOString() } }),
  );
  await page.goto('/downtown/verify');
  const number = page.getByRole('region', { name: 'The number' });
  // The live count leads; the first-checkpoint note is a small status line.
  await expect(number.locator('.vf-figure')).toContainText('90 AI agents have joined Central City');
  await expect(number.getByRole('status')).toContainText(
    'The public log starts with the first daily checkpoint at 12:00 CEST. Until then, the live number (90) comes from the server',
  );
  await expect(page.getByRole('region', { name: 'Checkpoints' })).toHaveCount(0);
  // Everything that exists now: what is counted and the owner check (the entries themselves are
  // on the Agent Explorer, /explorer). The "data, and checking it yourself" box is gone.
  await expect(page.getByRole('region', { name: 'Log entries' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'What is counted' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Check my agent' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'The data, and checking it yourself' }),
  ).toHaveCount(0);
});

test('"Verify here" on the homepage ticker leads to the page; signed out, the owner check asks to sign in', async ({
  page,
  context,
}) => {
  await signUpWithAgent(page, 'Ticker Agent');
  await context.clearCookies();
  await page.goto('/');
  const verify = page.locator('[data-agent-ticker]').getByRole('link', { name: 'Verify here' });
  await expect(verify).toHaveAttribute('href', '/downtown/verify');
  await verify.click();
  await expect(page).toHaveURL(/\/downtown\/verify$/);
  await expect(
    page.getByRole('region', { name: 'Check my agent' }).getByRole('link', { name: 'Sign in' }),
  ).toBeVisible();
});

test('at 360 px the ticker with "Verify here" reserves its two lines (no layout shift)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await signUpWithAgent(page, 'Shift Agent');
  await page.context().clearCookies();
  // "/" as built without a count (e2e/landing-html.ts), so the client fills the reserved line.
  await landingWithTicker(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/public/stats', async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ai_agents_total: 1234, updated_at: new Date().toISOString() }),
    });
  });
  await page.goto('/');
  await expect(page.locator('[data-agent-ticker]')).toHaveAttribute('data-ready', 'false');
  const before = (await page.locator('#how').boundingBox())!.y;
  release();
  await expect(
    page.locator('[data-agent-ticker]').getByRole('link', { name: 'Verify here' }),
  ).toBeVisible();
  expect((await page.locator('#how').boundingBox())!.y).toBe(before);
});

/** Screenshots for a UX review: VERIFY_SHOTS_DIR=<dir>. */
for (const [w, h] of [
  [1440, 900],
  [768, 1024],
  [360, 780],
] as const)
  for (const scheme of ['light', 'dark'] as const)
    test(`screenshot ${w} ${scheme}`, async ({ page }) => {
      const dir = process.env.VERIFY_SHOTS_DIR;
      test.skip(!dir, 'Set VERIFY_SHOTS_DIR to write screenshots.');
      await page.setViewportSize({ width: w, height: h });
      await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
      await signUpWithAgent(page, 'Screenshot Agent');
      await page.request.get('/api/cron/count-checkpoint', { headers: CRON });
      await page.goto('/downtown/verify');
      await expect(
        page.getByText(/form one unbroken chain|The first daily checkpoint verifies/),
      ).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `${dir}/verify-${w}-${scheme}.png`, fullPage: true });
      if (w !== 768) {
        await page.context().clearCookies();
        await page.goto('/');
        await expect(page.locator('[data-agent-ticker][data-ready="true"]')).toBeVisible();
        await page.waitForTimeout(400); // the one-time fade-in
        await page.screenshot({ path: `${dir}/ticker-verify-${w}-${scheme}.png` });
      }
    });

test('signed out: Sign in comes back to this page, which then checks your agents', async ({
  page,
  context,
}) => {
  const name = `vf-return-${crypto.randomUUID().slice(0, 8)}`;
  const headers = { 'x-city-request': '1' };
  expect(
    (
      await page.request.post('/api/auth/register', { headers, data: { name, password: PASSWORD } })
    ).status(),
  ).toBe(201);
  await page.request.post('/api/agents', {
    headers,
    data: { name: 'Return Agent', description: 'e2e', capability: 'research', mode: 'external' },
  });
  await context.clearCookies();
  await page.goto('/downtown/verify');
  const mine = page.getByRole('region', { name: 'Check my agent' });
  await mine.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/signin\?next=%2Fdowntown%2Fverify$/);
  await page.getByLabel('Account name').fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.locator('form').getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/downtown\/verify$/);
  await expect(agentResult(mine, 'Return Agent')).not.toBeEmpty();
  await expect(mine.getByRole('link', { name: 'Sign in' })).toHaveCount(0);
});

test('signed out: anyone checks an entry by its fingerprint or number', async ({
  page,
  context,
}) => {
  await signUpWithAgent(page, 'Public Agent');
  await page.request.get('/api/cron/count-checkpoint', { headers: CRON });
  const leaves = await (await page.request.get('/api/public/count-log/leaves?from=0&to=5')).json();
  test.skip(!leaves.tree_size, 'needs a checkpoint');
  await context.clearCookies();
  await page.goto('/downtown/verify');
  const mine = page.getByRole('region', { name: 'Check my agent' });
  const entry = mine.getByLabel('Check an entry, no sign-in needed');
  await entry.fill(leaves.leaves[0].leaf_hash);
  await mine.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(mine.getByRole('status')).toContainText(
    /✓ Entry #1 is in the checkpoint of|Entry #1 is in the checkpoint of/,
  );
  await entry.fill('#999999');
  await mine.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(mine.getByRole('status')).toContainText('No entry #999999');
});

test('a mixed v1/v2 log: withheld v1 entries show no signature status, never "signed ✓"', async ({
  page,
}) => {
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey;
  const signHash = async (hash: string) => ({
    kid: 'e2e-mixed',
    sig: Buffer.from(
      await crypto.subtle.sign(
        { name: 'Ed25519' },
        keys.privateKey,
        checkpointSigningInput(hash) as BufferSource,
      ),
    ).toString('base64url'),
  });
  const leaf = await sha256(new TextEncoder().encode('mixed-leaf'));
  // Day 1 (v1, as served now: split, hash, signature and link withheld).
  const v1 = {
    v: 1,
    date: '2026-09-30',
    tree_size: 0,
    withdrawn: 0,
    root: toHex(await merkleRoot([])),
    subcounts_withheld: true,
    signature_withheld: true,
    consistency: [],
  };
  // Day 2 (v2): a commitment instead of the split; it starts a new chain (no previous hash).
  const body = {
    v: 2 as const,
    date: '2026-10-05',
    tree_size: 1,
    withdrawn: 0,
    root: toHex(await merkleRoot([leaf])),
    prev_hash: null,
    subcounts_commitment: 'ef'.repeat(32),
  };
  const hash = await checkpointHash(body);
  const v2 = { ...body, hash, signature: await signHash(hash), consistency: [] };
  let served: unknown[] = [v1, v2];
  await page.route('**/.well-known/jwks.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ keys: [{ ...jwk, kid: 'e2e-mixed' }] }),
    }),
  );
  await page.route(
    (url) => url.pathname === '/api/public/count-log/checkpoints',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ checkpoints: served }),
      }),
  );
  await page.goto('/downtown/verify');
  const number = page.getByRole('region', { name: 'The number' });
  await expect(number.getByText(/form one unbroken chain/)).toBeVisible();
  await expect(number).not.toContainText('Problems found');
  await expect(number).toContainText('Verified checkpoint');
  await expect(number.locator('.vf-badge')).toHaveAttribute('data-ok', 'true');
  await expect(number).toContainText(
    'Every checkpoint from 2026-10-05 on is signed with Central City’s published key.',
  );
  await expect(page.locator('main')).not.toContainText(/not checkable|withheld/i);
  await expect(number.locator('.vf-bad')).toHaveCount(0);
  const history = page.getByRole('region', { name: 'Checkpoints' });
  const v1Row = history.getByRole('row').filter({ hasText: '2026-09-30' });
  // The v1 row shows what is checkable (append-only) and no signature status at all.
  await expect(v1Row.getByRole('cell').last()).toHaveText('append-only ✓');
  await expect(v1Row).not.toContainText('signed');
  await expect(history.getByRole('row').filter({ hasText: '2026-10-05' })).toContainText(
    'linked ✓ · signed ✓',
  );

  // Before the first v2 checkpoint: verified on what is checkable, with no signature line, no
  // warning and never "signed".
  served = [v1];
  await page.reload();
  await expect(number).toContainText('Verified checkpoint');
  await expect(number.locator('.vf-badge')).toHaveAttribute('data-ok', 'true');
  await expect(number.getByText(/first daily checkpoint verifies/)).toBeVisible();
  await expect(number.locator('.vf-marks li')).toHaveCount(1);
  await expect(number.locator('.vf-bad')).toHaveCount(0);
  await expect(number).not.toContainText(/signed|not checkable/i);

  // A v1 entry after the last v1 day is a problem.
  served = [v1, { ...v1, date: '2026-10-06' }];
  await page.reload();
  await expect(number).toContainText('Problems found');
  await expect(number).toContainText('a v1 checkpoint after 2026-10-04');
});
