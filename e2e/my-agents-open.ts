import type { Locator, Page } from '@playwright/test';

/**
 * Why the specs of the agent's full dialog (runs, auto-reply, inbox, credentials, the classic Base
 * panel) are skipped: My agents v4 has no way to open it since ⋯ → All settings left the agent
 * pane (everything in it is on the pane's own screens). The dialog's code stays until it is
 * removed; these specs go with it, or come back if it gets an entry again.
 */
export const NO_AGENT_DIALOG =
  'The full agent dialog has no entry point: ⋯ → All settings left the agent pane.';

/**
 * Opened the agent's full dialog through ⋯ → All settings. That item is gone, so this fails
 * loudly; every caller is skipped with NO_AGENT_DIALOG.
 */
export async function openAgentDialog(_page: Page, name: string, _scope?: Locator) {
  throw new Error(`${NO_AGENT_DIALOG} (asked for ${name})`);
}

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
