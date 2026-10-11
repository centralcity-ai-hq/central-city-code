import { expect, type Page } from '@playwright/test';

export type SettingsRailItem = 'Connected apps' | 'Data & export' | 'Activity log' | 'Account';

/**
 * Opens the account menu (the account card at the bottom of the sidebar, behind the ☰ chip on
 * phones) and returns its navigation.
 */
export async function openAccountMenu(page: Page) {
  const account = page.getByRole('button', { name: /^Account: / });
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  const drawerOpen = async () => (await page.locator('.sidebar.open').count()) > 0;
  // The shell first (a slow first render on a busy machine): before it, neither the account card
  // nor the phone's menu button is there, and deciding about the drawer then would be a guess.
  await expect(account.or(menu).first()).toBeVisible({ timeout: 15_000 });
  if (!(await account.isVisible()) && (await menu.isVisible()) && !(await drawerOpen()))
    await menu.click();
  await expect(account).toBeVisible();
  if ((await account.getAttribute('aria-expanded')) !== 'true') await account.click();
  const nav = page.getByRole('navigation', { name: 'Account', exact: true });
  await expect(nav).toBeVisible();
  return nav;
}

/**
 * Reaches a Settings section the way a person does: Account → Settings, then the section rail.
 * If Settings is already open, only the rail is used.
 */
export async function openSettingsSection(page: Page, name: SettingsRailItem) {
  const rail = page.getByRole('navigation', { name: 'Settings sections', exact: true });
  if (!(await rail.isVisible())) {
    const account = await openAccountMenu(page);
    await account.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(rail.getByRole('button', { name: 'Account', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  }
  const item = rail.getByRole('button', { name, exact: true });
  // Settings may still be settling after the route change; retry until the section is current.
  await expect(async () => {
    if ((await item.getAttribute('aria-current')) !== 'page') await item.click();
    await expect(item).toHaveAttribute('aria-current', 'page', { timeout: 1_000 });
  }).toPass();
}

/**
 * Returns the sidebar's ADVANCED group (Research & review, Agent permissions, Network map),
 * opening the phone drawer and expanding the group when needed.
 */
export async function openAdvancedGroup(page: Page) {
  const nav = page.getByRole('navigation', { name: 'Advanced', exact: true });
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  const group = page.getByRole('button', { name: 'Advanced', exact: true });
  const drawerOpen = async () => (await page.locator('.sidebar.open').count()) > 0;
  if (!(await group.isVisible()) && (await menu.isVisible()) && !(await drawerOpen()))
    await menu.click();
  await expect(group).toBeVisible();
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  await expect(nav).toBeVisible();
  return nav;
}

/** The workspace switcher, which sits in the account menu. */
export async function workspaceSwitcher(page: Page) {
  await openAccountMenu(page);
  return page.getByRole('combobox', { name: 'Switch workspace', exact: true });
}
