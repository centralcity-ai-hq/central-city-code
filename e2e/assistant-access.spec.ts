import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { e2eOrigin } from './port';

test('owner grants assistant agent creation, downloads config and revokes it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#signin');
  // #signin opens in Sign in mode, or in Sign up mode on a server with no account yet (this spec
  // run on its own). The Sign up tab works in both, so the spec does not depend on test order.
  await expect(page.getByLabel('Account name')).toBeVisible();
  const signUp = page.getByRole('tab', { name: 'Sign up', exact: true });
  await signUp.click();
  await expect(signUp).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeVisible();
  await page.getByLabel('Account name').fill(`Assistant-${randomUUID().slice(0, 8)}`);
  await page.getByLabel('Password', { exact: true }).fill(`Synthetic-${randomUUID()}`);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  // A new account lands on the workspace overview, the Network map.
  await expect(page.getByRole('heading', { name: 'Network map', level: 1 })).toBeVisible();
  // Settings opens on Connected apps; creating access for a local AI is under its local bridge.
  await page.goto('/settings');
  const preview = page.locator('.assistant-preview');
  await expect(preview.getByRole('heading', { name: 'Connected apps', exact: true })).toBeVisible();
  await preview.locator('summary').filter({ hasText: 'Advanced: local bridge' }).click();
  await expect(page.getByRole('button', { name: 'Create access', exact: true })).toBeDisabled();
  await expect(page.getByLabel('See your workspace', { exact: false })).toBeChecked();
  await expect(page.getByLabel('Create agents', { exact: false })).not.toBeChecked();
  await page.getByLabel('Connection name').fill('Browser Assistant');
  await page.getByLabel('Create agents', { exact: false }).check();
  await page.getByLabel('I allow these actions', { exact: false }).check();
  await page.getByRole('button', { name: 'Create access', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download private connection file' }).click();
  const downloaded = await pending;
  const config = JSON.parse(await readFile((await downloaded.path())!, 'utf8')) as {
    baseUrl: string;
    token: string;
  };
  expect(config.baseUrl).toBe(e2eOrigin());
  expect(typeof config.token).toBe('string');
  const args = {
    name: 'Prompt-created Scout',
    description: 'Created through delegated assistant access.',
    capability: 'research',
    mode: 'external',
    idempotencyKey: 'browser-create-scout',
  };
  const response = await page.request.post('/api/assistant/tools/city_create_agent', {
    headers: { Authorization: `Bearer ${config.token}`, 'X-City-Request': '1' },
    data: args,
  });
  expect(response.status()).toBe(200);
  const created = await response.json();
  expect(created.agent.name).toBe(args.name);
  expect(created.runtimeSetupRequired).toBe(true);
  expect(created.token).toBeUndefined();
  await page.getByRole('button', { name: 'I saved it — dismiss' }).click();
  // A reload stays on Connected apps, and the secret is gone.
  await page.reload();
  await expect(preview.getByRole('heading', { name: 'Connected apps', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download private connection file' })).toHaveCount(
    0,
  );
  await expect(page.getByText('Browser Assistant', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Remove access for Browser Assistant', exact: true })
    .click();
  const confirm = page.getByRole('dialog', { name: 'Remove app access?', exact: true });
  await confirm.getByRole('button', { name: 'Remove access', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByText('Removed', { exact: true })).toBeVisible();
  const denied = await page.request.post('/api/assistant/tools/city_workspace', {
    headers: { Authorization: `Bearer ${config.token}`, 'X-City-Request': '1' },
    data: {},
  });
  expect(denied.status()).toBe(401);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/assistant-access-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
