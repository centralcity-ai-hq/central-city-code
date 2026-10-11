import { test, expect as baseExpect, type Page } from '@playwright/test';

/*
 * Member status in the room's Members panel (docs/MEMBER_STATUS.md): a dot plus a text label,
 * in light and dark. The server derives the status; this checks what the host sees.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';

async function signUp(page: Page, name: string) {
  const createOne = page.getByRole('button', { name: 'Create an account', exact: true });
  const createWorkspace = page.getByRole('button', { name: 'Create account', exact: true });
  await expect(createOne.or(createWorkspace)).toBeVisible();
  if (await createOne.isVisible()) await createOne.click();
  await expect(createWorkspace).toBeVisible();
  await page.getByLabel(/^(Account|Operator) name$/).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await createWorkspace.click();
}

test('Members panel shows each member status as a dot and a label, light and dark', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#signin');
  await signUp(page, `Status-${crypto.randomUUID().slice(0, 8)}`);
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toHaveCount(0);
  await page.goto('/rooms');
  await page.getByRole('button', { name: 'New room' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New room' });
  await dialog.getByLabel('Room name').fill('Status room');
  await dialog.getByLabel("Your AI's name").fill('Host agent');
  await dialog.getByRole('button', { name: 'Create room' }).click();
  await expect(page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);

  await page.getByRole('button', { name: /^Members of / }).click();
  const panel = page.getByRole('complementary', { name: 'Members' });
  const row = panel.getByRole('listitem').filter({ hasText: 'Host agent' });
  // Just joined: active now (the same rule as the header badge). The label is text, so the status is not colour only.
  const status = row.getByTestId('member-activity');
  await expect(status).toHaveText(/^Active now\b/);
  await expect(status).toHaveAttribute('data-status', 'active');
  await expect(status).toHaveAttribute('title', /^Last active /); // host sees the time
  const dot = status.locator('.rm-v2-member-dot');
  await expect(dot).toHaveAttribute('aria-hidden', 'true');
  const light = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);

  await page.evaluate(() => {
    localStorage.setItem('cc-theme', 'dark');
    document.documentElement.dataset.theme = 'dark';
  });
  await expect(status).toHaveText(/^Active now\b/);
  const dark = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(light).not.toBe('rgba(0, 0, 0, 0)');
  expect(dark).not.toBe(light);
  expect(errors).toEqual([]);
});
