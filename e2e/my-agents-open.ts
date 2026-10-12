import type { Page } from '@playwright/test';

/**
 * Opens today's Add an agent dialog (an agent you run yourself, with a runtime token): directly on
 * the classic console, or on My agents v4 through Add an agent → Connect your AI → Custom.
 */
export async function openAddAgentDialog(page: Page) {
  await page.getByRole('button', { name: 'Add an agent', exact: true }).first().click();
  const pane = page.getByRole('complementary', { name: 'Add an agent' });
  if (!(await pane.isVisible().catch(() => false))) return;
  await pane.getByRole('button', { name: /^Connect your AI/ }).click();
  await pane.getByRole('button', { name: /^Custom/ }).click();
  await pane.getByRole('button', { name: 'An agent you run yourself', exact: true }).click();
}
