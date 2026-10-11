import { test, expect as baseExpect, type Page } from '@playwright/test';
import type { Snapshot } from '../shared/types';

/*
 * The host "New room" creates when the person has no agent yet is a CC agent with a private
 * profile, like one made with "Create a CC agent" in My agents: its pane offers Base ("Not yet",
 * never "Not available") and the Base routes find it. Real server, synthetic account. The test
 * server runs with wallets off, so the Wallet row itself is covered by
 * tests/rooms-new-room-host-profile.test.ts.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';

async function signUp(page: Page, name: string) {
  const createOne = page.getByRole('button', { name: 'Create an account', exact: true });
  const createAccount = page.getByRole('button', { name: 'Create account', exact: true });
  await expect(createOne.or(createAccount)).toBeVisible();
  if (await createOne.isVisible()) await createOne.click();
  await expect(createAccount).toBeVisible();
  await page.getByLabel(/^(Account|Operator) name$/).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await createAccount.click();
  await expect(createAccount).toHaveCount(0);
}

test('the host New room creates has Base like any new agent, and stays private', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#signin');
  await signUp(page, `Host-profile-${crypto.randomUUID().slice(0, 8)}`);
  await page.goto('/rooms');
  await page.getByRole('button', { name: 'New room' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New room' });
  await dialog.getByLabel('Room name').fill('Lantern room');
  await dialog.getByLabel("Your AI's name").fill('Lantern host');
  await dialog.getByRole('button', { name: 'Create room' }).click();
  await expect(page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);

  // The host has a profile, private until the owner makes it public.
  const snapshot = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  const host = snapshot.agents.find((agent) => agent.name === 'Lantern host')!;
  expect(host).toMatchObject({ mode: 'hosted', isDemo: true, visibility: 'private', revision: 1 });
  expect((await page.request.get(`/api/base/agents/${host.id}/registration`)).status()).toBe(200);

  // My agents: its pane's Base row reads "Not yet", as for an agent made in My agents.
  await page.goto('/?workspace=v2&theme=light#connect');
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: /^My agents/ })
    .first()
    .click();
  await page
    .getByRole('region', { name: 'Agents', exact: true })
    .getByRole('button', { name: /^Lantern host, / })
    .click();
  const pane = page.getByRole('complementary', { name: 'Lantern host details' });
  await expect(pane).toContainText('CC agent');
  const base = pane.getByRole('button', { name: /^Base/ });
  await expect(base).toContainText('Not yet');
  await expect(base).not.toContainText('Not available');
  expect(errors).toEqual([]);
});
