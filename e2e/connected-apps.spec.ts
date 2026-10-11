import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AssistantGrant } from '../shared/assistant';
import { e2eOrigin } from './port';
import { openSettingsSection } from './settings-nav';
import { workspaceTarget } from './workspace-density';

const headers = { 'X-City-Request': '1' };

async function register(page: Page) {
  const response = await page.request.post('/api/auth/register', {
    headers,
    data: {
      name: `Connected-apps-${randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(response.status()).toBe(201);
}

async function openConnectedApps(page: Page, theme = 'light') {
  // An explicit console view (not Rooms, the default home). Not Connect AI: its Connected group
  // reads the same grants, and these tests count those requests.
  await page.goto(`/?workspace=v2&theme=${theme}#network`);
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  const account = page.getByRole('button', { name: /^Account: / });
  if (await account.count()) {
    await openSettingsSection(page, 'Connected apps');
  } else {
    await page.getByRole('button', { name: 'AI connections', exact: true }).click();
  }
  const preview = page.locator('.assistant-preview');
  await expect(preview.getByRole('heading', { name: 'Connected apps', exact: true })).toBeVisible();
  return preview;
}

function grant(overrides: Partial<AssistantGrant> = {}): AssistantGrant {
  const now = Date.now();
  return {
    id: 'test-grant-0001',
    label: 'Research app',
    scopes: ['workspace:read', 'messages:read'],
    createdAt: new Date(now - 86_400_000).toISOString(),
    expiresAt: new Date(now + 7 * 86_400_000).toISOString(),
    renewal: 'fixed',
    endsAtLatest: null,
    lastUsedAt: new Date(now - 60_000).toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

test('preview preserves consent, one-time download and real revocation without changing agent connections', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await register(page);
  const demo = await page.request.post('/api/demo/start', { headers, data: {} });
  expect(demo.status()).toBe(200);
  const before = await (await page.request.get('/api/snapshot')).json();
  expect(before.connections).toHaveLength(2);

  let preview = await openConnectedApps(page);
  await expect(preview.getByText('No apps connected yet.')).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Connect AI', exact: true })).toHaveCount(1);
  await expect(preview.getByRole('heading', { name: 'App access', exact: true })).toBeVisible();
  const advanced = preview.locator('details');
  await expect(advanced).not.toHaveAttribute('open', '');
  await expect(preview.getByLabel('Connection name')).toBeHidden();
  await advanced.locator('summary').click();
  await expect(advanced.locator('summary')).toHaveText('Advanced: local bridge');
  await expect(preview.getByRole('button', { name: 'Create access', exact: true })).toBeDisabled();
  await expect(preview.getByLabel('See your workspace', { exact: false })).toBeChecked();
  await expect(preview.getByLabel('See your workspace', { exact: false })).toBeDisabled();
  await expect(preview.getByLabel('Create agents', { exact: false })).not.toBeChecked();
  await preview.getByLabel('Connection name').fill('Preview desktop app');
  await preview.getByLabel('Create agents', { exact: false }).check();
  await preview.getByLabel('I allow these actions', { exact: false }).check();
  await preview.getByRole('button', { name: 'Create access', exact: true }).click();
  const download = page.waitForEvent('download');
  await preview.getByRole('button', { name: 'Download private connection file' }).click();
  const downloaded = await download;
  const config = JSON.parse(await readFile((await downloaded.path())!, 'utf8')) as {
    baseUrl: string;
    token: string;
  };
  expect(config.baseUrl).toBe(e2eOrigin());
  expect(typeof config.token).toBe('string');
  const assistantHeaders = { ...headers, Authorization: `Bearer ${config.token}` };
  const usable = await page.request.post('/api/assistant/tools/city_workspace', {
    headers: assistantHeaders,
    data: {},
  });
  expect(usable.status()).toBe(200);
  await advanced.locator('summary').click();
  await advanced.locator('summary').click();
  await expect(
    preview.getByRole('button', { name: 'Download private connection file' }),
  ).toBeVisible();

  // Leaving the page discards the secret, while the grant and its observed use remain.
  preview = await openConnectedApps(page);
  await preview.locator('details summary').click();
  await expect(
    preview.getByRole('button', { name: 'Download private connection file' }),
  ).toHaveCount(0);
  const row = preview.locator('.assistant-grants li').filter({ hasText: 'Preview desktop app' });
  await expect(row).toContainText('Create agents');
  await expect(row).toContainText('Last used');
  const opener = row.getByRole('button', { name: 'Remove access for Preview desktop app' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Remove app access?', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(opener).toBeFocused();
  const stillUsable = await page.request.post('/api/assistant/tools/city_workspace', {
    headers: assistantHeaders,
    data: {},
  });
  expect(stillUsable.status()).toBe(200);
  await opener.click();
  await dialog.getByRole('button', { name: 'Remove access', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByText('Removed', { exact: true })).toBeVisible();
  await expect(opener).toBeDisabled();
  await expect(preview.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused();
  const denied = await page.request.post('/api/assistant/tools/city_workspace', {
    headers: assistantHeaders,
    data: {},
  });
  expect(denied.status()).toBe(401);
  const after = await (await page.request.get('/api/snapshot')).json();
  expect(after.connections).toEqual(before.connections);
  expect(errors).toEqual([]);
});

test('initial loading and failure stay distinct from empty, retry recovers and Connect AI opens existing setup', async ({
  page,
}) => {
  await register(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route('**/api/assistant-access', async (route) => {
    requests += 1;
    if (requests === 1) {
      await pending;
      await route.fulfill({ status: 503, json: { error: 'Apps could not be loaded. Try again.' } });
    } else {
      await route.fulfill({ json: { grants: [] } });
    }
  });
  const preview = await openConnectedApps(page);
  await expect(preview.getByRole('status')).toContainText('Loading connected apps…');
  await expect(preview.getByText('No apps connected yet.')).toHaveCount(0);
  release();
  await expect(preview.getByRole('alert')).toContainText('Apps could not be loaded. Try again.');
  await expect(preview.getByText('No apps connected yet.')).toHaveCount(0);
  await preview.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(preview.getByText('No apps connected yet.')).toBeVisible();
  await expect(preview.getByRole('alert')).toHaveCount(0);
  expect(requests).toBe(2);
  const connect = preview.getByRole('button', { name: 'Connect AI', exact: true });
  await expect(connect).toHaveCount(1);
  await connect.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Connect AI', exact: true })).toBeVisible();
});

test('refresh preserves listed permissions and grant lifetime details while a failed request is retried', async ({
  page,
}) => {
  await register(page);
  const now = Date.now();
  const grants = [
    grant(),
    grant({
      id: 'test-grant-0002',
      label: 'Rolling app',
      renewal: 'rolling',
      expiresAt: new Date(now + 90 * 86_400_000).toISOString(),
      endsAtLatest: new Date(now + 300 * 86_400_000).toISOString(),
      lastUsedAt: null,
    }),
    grant({
      id: 'test-grant-0003',
      label: 'Expired app',
      expiresAt: new Date(now - 1_000).toISOString(),
    }),
    grant({
      id: 'test-grant-0004',
      label: 'Removed app',
      revokedAt: new Date(now - 1_000).toISOString(),
    }),
  ];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route('**/api/assistant-access', async (route) => {
    requests += 1;
    if (requests === 2) {
      await pending;
      await route.fulfill({ status: 503, json: { error: 'Refresh failed. Try again.' } });
    } else {
      await route.fulfill({ json: { grants } });
    }
  });
  const preview = await openConnectedApps(page);
  const rows = preview.locator('.assistant-grants li');
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: 'Research app' })).toContainText('See your workspace');
  await expect(rows.filter({ hasText: 'Research app' })).toContainText('Read agent messages');
  await expect(rows.filter({ hasText: 'Research app' })).toContainText('Last used');
  await expect(rows.filter({ hasText: 'Rolling app' })).toContainText('Until you disconnect');
  await expect(rows.filter({ hasText: 'Rolling app' })).toContainText('90 days');
  await expect(rows.filter({ hasText: 'Rolling app' })).toContainText('at the latest on');
  await expect(rows.filter({ hasText: 'Rolling app' })).toContainText('Not used yet');
  await expect(
    rows.filter({ hasText: 'Expired app' }).getByText('Ended', { exact: true }),
  ).toBeVisible();
  await expect(rows.filter({ hasText: 'Removed app' }).getByRole('button')).toBeDisabled();
  await preview.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(preview.getByRole('status')).toContainText('Refreshing connected apps…');
  await expect(rows).toHaveCount(4);
  release();
  await expect(preview.getByRole('alert')).toContainText('Refresh failed. Try again.');
  await expect(rows).toHaveCount(4);
  await preview.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(preview.getByRole('alert')).toHaveCount(0);
  await expect(rows).toHaveCount(4);
  expect(requests).toBe(3);
});

test('revoke confirmation traps focus, Escape cancels, and an inline failure can be retried once', async ({
  page,
}) => {
  await register(page);
  const item = grant();
  await page.route('**/api/assistant-access', (route) =>
    route.fulfill({ json: { grants: [item] } }),
  );
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deletes = 0;
  await page.route(`**/api/assistant-access/${item.id}`, async (route) => {
    expect(route.request().method()).toBe('DELETE');
    deletes += 1;
    if (deletes === 1) {
      await pending;
      await route.fulfill({
        status: 503,
        json: { error: 'Access could not be removed. Try again.' },
      });
    } else {
      await route.fulfill({ json: { ok: true } });
    }
  });
  const preview = await openConnectedApps(page);
  const opener = preview.getByRole('button', {
    name: 'Remove access for Research app',
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Remove app access?', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog).toContainText('Research app');
  await expect(
    dialog.getByRole('button', { name: 'Remove access', exact: true }),
  ).not.toBeFocused();
  for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    expect(
      await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))),
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(deletes).toBe(0);
  await opener.click();
  await dialog.getByRole('button', { name: 'Remove access', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Remove access', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('status')).toHaveText('Removing access…');
  await expect.poll(() => deletes).toBe(1);
  for (const key of ['Tab', 'Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    expect(
      await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))),
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  expect(deletes).toBe(1);
  release();
  await expect(dialog.getByRole('alert')).toContainText('Access could not be removed. Try again.');
  await expect(
    preview.locator('.assistant-grants li').getByText('Connected', { exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Remove access', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeDisabled();
  await expect(preview.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused();
  expect(deletes).toBe(2);
});

{
  test('an earlier revoke notice clears when a later revoke fails', async ({ page }) => {
    await register(page);
    const first = grant({ label: 'First app' });
    const second = grant({ id: 'test-grant-0002', label: 'Second app' });
    await page.route('**/api/assistant-access', (route) =>
      route.fulfill({ json: { grants: [first, second] } }),
    );
    const deleted: string[] = [];
    await page.route('**/api/assistant-access/*', async (route) => {
      expect(route.request().method()).toBe('DELETE');
      const id = route.request().url().split('/').at(-1)!;
      deleted.push(id);
      await route.fulfill(
        id === first.id
          ? { json: { ok: true } }
          : { status: 503, json: { error: 'Access could not be removed. Try again.' } },
      );
    });
    await openConnectedApps(page);
    const layout = page.locator('.assistant-layout');
    const dialog = page.getByRole('dialog', { name: 'Remove app access?', exact: true });
    await layout.getByRole('button', { name: 'Remove access for First app', exact: true }).click();
    await dialog.getByRole('button', { name: 'Remove access', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const notice = layout
      .getByRole('status')
      .filter({ hasText: 'First app no longer has access.' });
    await expect(notice).toBeVisible();
    await layout.getByRole('button', { name: 'Remove access for Second app', exact: true }).click();
    await dialog.getByRole('button', { name: 'Remove access', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Access could not be removed. Try again.');
    await expect(notice).toHaveCount(0);
    const rows = layout.locator('.assistant-grants li');
    await expect(
      rows.filter({ hasText: 'First app' }).getByText('Removed', { exact: true }),
    ).toBeVisible();
    await expect(
      rows.filter({ hasText: 'Second app' }).getByText('Connected', { exact: true }),
    ).toBeVisible();
    expect(deleted).toEqual([first.id, second.id]);
  });
}

for (const theme of ['light', 'dark']) {
  for (const width of [360, 390, 1440]) {
    test(`connected apps and confirmation fit at ${width}px in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 360 ? 780 : 900 });
      await register(page);
      const item = grant({
        label: 'An app with a long descriptive name for checking narrow screens',
        scopes: ['workspace:read', 'agents:create', 'messages:read', 'connections:approve'],
      });
      await page.route('**/api/assistant-access', (route) =>
        route.fulfill({ json: { grants: [item] } }),
      );
      const preview = await openConnectedApps(page, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const controls = [
        preview.getByRole('button', { name: 'Connect AI', exact: true }),
        preview.getByRole('button', { name: 'Refresh', exact: true }),
        preview.getByRole('button', { name: `Remove access for ${item.label}`, exact: true }),
        preview.locator('details summary'),
      ];
      for (const control of controls) {
        await expect(control).toBeVisible();
        const bounds = (await control.boundingBox())!;
        expect(bounds.width).toBeGreaterThanOrEqual(workspaceTarget(width));
        expect(bounds.height).toBeGreaterThanOrEqual(workspaceTarget(width));
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('connected-apps.png'), fullPage: true });
      await controls[2]!.click();
      const dialog = page.getByRole('dialog', { name: 'Remove app access?', exact: true });
      await expect(dialog).toBeVisible();
      const bounds = (await dialog.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: 'Remove access', exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('remove-app-access.png'), fullPage: true });
      await page.keyboard.press('Escape');
      await expect(controls[2]!).toBeFocused();
      await preview.locator('details summary').focus();
      await page.keyboard.press('Enter');
      await expect(preview.getByLabel('Connection name')).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
  }
}
