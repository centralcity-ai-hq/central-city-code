import { test, expect, type Page } from '@playwright/test';
import { openAdvancedGroup, openSettingsSection } from './settings-nav';
import { openAddAgentDialog } from './my-agents-open';

/*
 * No machine text on screens people see (docs/COPY_GLOSSARY.md: "no machine text in the UI").
 * Every public page, the console views and dialogs, and the rooms screens are checked for tool
 * names (city_*), raw JSON ("{" or "}") and "idempotency". Only /docs/api, the developer
 * reference, may show them. Text inside a closed "Details" or "Raw data" disclosure is not on
 * screen, so it does not count.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };
const MACHINE_TEXT = /city_[a-z]|[{}]|idempoten/i;

async function expectPlain(page: Page, where: string) {
  // Let lazy screens and live data settle before reading what is on screen.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const text = await page.evaluate(() => document.body.innerText);
  const hit = MACHINE_TEXT.exec(text);
  expect(
    hit,
    `${where} shows machine text: …${hit ? text.slice(Math.max(0, hit.index - 60), hit.index + 60) : ''}…`,
  ).toBeNull();
}

async function register(page: Page, name: string) {
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: { name, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
}

test('public pages show no tool names, JSON or idempotency', async ({ page, browser }) => {
  // /api/public/stats is sent with stale-while-revalidate, and the ticker, Downtown and the verify
  // page all read it. From the browser cache Chromium then starts a background revalidation that
  // never reports "finished", so each one pins a connection: networkidle and later loads stall
  // (lazy pages sat on "Opening Central City") until the test timed out. A route turns off the
  // HTTP cache for this page (Playwright), so every read is a plain request that completes.
  await page.route('**/api/public/stats', (route) => route.continue());
  // Not the first account, so the landing page shows its normal state.
  const setup = await browser.newContext();
  await setup.request.post('/api/auth/register', {
    headers,
    data: { name: `plain-first-${crypto.randomUUID().slice(0, 6)}`, password: PASSWORD },
  });
  await setup.close();
  for (const path of [
    '/',
    '/#signin',
    '/#create',
    '/signin',
    '/#connect',
    '/invite',
    '/workflows',
    '/downtown',
    '/downtown/verify',
    '/docs',
    '/docs/start',
    '/docs/rooms',
    '/no-such-page',
  ]) {
    await page.goto(path);
    await expect(page.locator('h1').first()).toBeVisible();
    await expectPlain(page, path);
  }
  // The Connect page, on the Codex tab.
  await page.goto('/connect');
  await page.getByRole('tab', { name: 'Codex' }).click();
  await expectPlain(page, 'Connect page, Codex');
  // A failed sign-in explains itself in words.
  await page.goto('/signin');
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome back.' })).toBeVisible();
  await page.getByLabel('Account name').fill('nobody-here');
  await page.getByLabel('Password', { exact: true }).fill('not-the-password-123');
  await page.locator('form').getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expectPlain(page, 'failed sign-in');
});

test('the console, its dialogs and the rooms show no tool names, JSON or idempotency', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await register(page, `plain-${crypto.randomUUID().slice(0, 8)}`);
  expect((await page.request.post('/api/demo/start', { headers, data: {} })).status()).toBe(200);
  // Some work that came back, so the exchange dialog shows a real result.
  await page.goto('/');
  let snapshot: any;
  await expect
    .poll(async () => {
      snapshot = await (await page.request.get('/api/snapshot')).json();
      return [snapshot.stats.reachable, snapshot.connections.length];
    })
    .toEqual([3, 2]);
  const route = snapshot.connections[0];
  const job = await page.request.post('/api/jobs', {
    headers,
    data: {
      requesterId: route.fromAgentId,
      providerId: route.toAgentId,
      input: 'Project: River Library\nSource: https://example.com/river',
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(job.status()).toBe(201);

  // The workspace opens on Rooms; the overview (the Network map) is under Advanced workspace.
  await page.reload();
  const advanced = async (name: string) => {
    await (await openAdvancedGroup(page)).getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  };
  await advanced('Network map');
  await expectPlain(page, 'Network map');
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  const myAgents = nav.getByRole('button', { name: /^My agents/ });
  // My agents' Exchanges button opens the ledger.
  const exchanges = async () => {
    await myAgents.click();
    await page.getByRole('main').getByRole('button', { name: 'Exchanges', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Exchanges.' })).toBeVisible();
  };
  for (const view of ['Connect AI', 'My agents', 'Messages']) {
    await nav.getByRole('button', { name: new RegExp(`^${view}`) }).click();
    await expectPlain(page, view);
  }
  await exchanges();
  await expectPlain(page, 'Exchanges');
  for (const view of ['Research & review', 'Agent permissions']) {
    await advanced(view);
    await expectPlain(page, view);
  }
  // The exchange, with the agent's result shown as readable fields.
  await exchanges();
  await expect(page.getByText('Result ready').first()).toBeVisible({ timeout: 20_000 });
  await page.locator('.exchange-row').first().click();
  const exchange = page.getByRole('dialog');
  await expect(exchange.getByRole('heading', { name: 'Result' })).toBeVisible();
  await expect(exchange.getByText('Raw data')).toBeVisible();
  await expectPlain(page, 'exchange dialog');
  await page.keyboard.press('Escape');
  // An agent's pane with its ⋯ menu, and the Add agent dialog.
  await myAgents.click();
  await page
    .getByRole('main')
    .getByRole('button', { name: /^More for / })
    .first()
    .click();
  await expect(page.getByRole('main').getByRole('menu')).toBeVisible();
  await expectPlain(page, 'agent pane');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Add an agent' }).first().click();
  await expectPlain(page, 'Add an agent');
  await page.keyboard.press('Escape');
  await openAddAgentDialog(page);
  await expectPlain(page, 'Add agent dialog');
  await page.getByRole('button', { name: 'Connect your own' }).click();
  await expectPlain(page, 'Add agent dialog, your own');
  await page.keyboard.press('Escape');
  // Account → Settings, Data & export (where export lives); the section rail leads to the others.
  await openSettingsSection(page, 'Data & export');
  await expect(page.getByRole('region', { name: 'Data & export', exact: true })).toBeVisible();
  await expectPlain(page, 'Data & export');
  const rail = page.getByRole('navigation', { name: 'Settings sections', exact: true });
  for (const section of ['Connected apps', 'Activity log', 'Account']) {
    await rail.getByRole('button', { name: section, exact: true }).click();
    await expect(rail.getByRole('button', { name: section, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectPlain(page, section);
  }

  // Rooms: a room with a message, its Invite sheet and the Members panel.
  const room = await (
    await page.request.post('/api/rooms', {
      headers,
      data: {
        agent_id: route.fromAgentId,
        name: 'Plain room',
        idempotency_key: crypto.randomUUID(),
      },
    })
  ).json();
  await page.request.post(`/api/rooms/${room.room.id}/messages`, {
    headers,
    data: { text: 'Hello, everyone.', idempotency_key: crypto.randomUUID() },
  });
  await page.goto(`/rooms/${room.room.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Plain room' })).toBeVisible();
  await expectPlain(page, 'room');
  await page.getByRole('button', { name: 'Invite', exact: true }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Invite a person' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.rm-code')).toBeVisible();
  // The sheet holds the link only in the clipboard copy; the short code resolves to the /j
  // link without a second mint (a fresh mint right after the sheet's own can hit the host's
  // link rate limit).
  const code = (await sheet.locator('.rm-code').textContent())!.trim();
  const resolved = await (await page.request.get(`/j/${code}?format=json`)).json();
  const link = resolved.join_url as string;
  await expectPlain(page, 'Invite sheet');
  await sheet.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: /^Members/ }).click();
  await expectPlain(page, 'Members panel');

  // Someone else opens the invite: the /j page and the join screen, signed out and signed in.
  const guest = await browser.newContext();
  const other = await guest.newPage();
  await other.goto(new URL(link).pathname);
  await expectPlain(other, 'invite link page');
  await other.getByRole('link', { name: /Join/ }).first().click();
  await expect(other.getByRole('heading', { level: 1 })).toBeVisible();
  await expectPlain(other, 'join screen, signed out');
  await register(other, `plain-guest-${crypto.randomUUID().slice(0, 6)}`);
  await other.goto(new URL(link).pathname);
  await other.getByRole('link', { name: /Join/ }).first().click();
  await expect(other.getByRole('heading', { name: 'Join the room' })).toBeVisible();
  await expectPlain(other, 'join screen, signed in');
  await guest.close();
});
