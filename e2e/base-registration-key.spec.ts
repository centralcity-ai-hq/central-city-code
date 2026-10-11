import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Agent, Snapshot } from '../shared/types';
import { sealKey } from '../src/base/vault/crypto';
import { expectedWallet } from '../src/base/wallet/derive';
import { NO_AGENT_DIALOG, openAgentDialog } from './my-agents-open';

/*
 * Registering an agent on Base with the person's own wallet key (decision A, one wallet), on the
 * agent's Base screen in My agents v4 (docs/design/base-register-pay-rooms-mockup.html). With the
 * wallet routes on, there is no address field: the key is set up, backed up and held in this
 * browser first, and the request carries only the wallet this browser derived from it. With the
 * routes off, the address field stays as before (e2e/base-registration.spec.ts). Synthetic
 * fixtures through page.route; nothing reaches a chain.
 */

const headers = { 'X-City-Request': '1' };
const password = 'Local-test-only-passphrase-2026';
const at = '2026-10-11T08:00:00.000Z';
/** The person's wallet key (synthetic, fixed) and another one the server could name instead. */
const OWNER_PRIVATE = `0x${'4c'.repeat(32)}` as Hex;
const OWNER = privateKeyToAccount(OWNER_PRIVATE).address;
const OTHER_OWNER = `0x${'5e'.repeat(20)}`;
const agentUri = 'https://centralcity.ai/a/Kq7Tz2';

const compass: Agent = {
  id: '77777777-7777-4777-8777-777777777777',
  name: 'Compass',
  description: 'Synthetic fixture',
  capability: 'research',
  mode: 'hosted',
  isDemo: false,
  status: 'online',
  lastSeenAt: at,
  createdAt: at,
  revokedAt: null,
  visibility: 'public',
};
const WALLET = expectedWallet(OWNER, compass.id);

type VaultMode = 'off' | 'none' | 'backup' | 'ready';

async function server(page: Page, vaultMode: VaultMode) {
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Base-key-${randomUUID().slice(0, 8)}`, password },
  });
  expect(registered.status()).toBe(201);
  const person = (
    (await (await page.request.get('/api/session')).json()) as { operator: { id: string } }
  ).operator.id;
  const envelope = await sealKey(OWNER_PRIVATE, password, { N: 2 ** 17 });
  const baseline = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ json: { ...baseline, agents: [compass] } }),
  );
  await page.route('**/api/rooms', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { rooms: [] } }) : route.fallback(),
  );
  await page.route('**/api/v2/connections/requests**', (route) =>
    route.fulfill({ json: { incoming: [], outgoing: [], next_before: null } }),
  );
  await page.route('**/api/agents/*/totals', (route) =>
    route.fulfill({ json: { tasks_done: 0, messages_sent: 0 } }),
  );
  const state = {
    vault: vaultMode,
    /** The vault names this account instead of the signed-in person's. */
    accountOverride: null as string | null,
    /** The registration answers this wallet instead of the derived one. */
    answerWallet: WALLET as string,
    sent: [] as Record<string, unknown>[],
    registered: false,
    /** While set, every vault read waits for it (the key's state stays unknown meanwhile). */
    vaultHold: null as Promise<void> | null,
    /** Where this browser keeps the key it held for the person (src/base/vault/keyPin.ts). */
    pinKey: `cc-wallet-key:${person}`,
  };
  await page.route('**/api/base/vault', async (route) => {
    if (state.vaultHold) await state.vaultHold;
    if (state.vault === 'off') return route.fulfill({ status: 404, json: { error: 'Not found.' } });
    const exists = state.vault !== 'none';
    return route.fulfill({
      json: {
        accountId: state.accountOverride ?? person,
        exists,
        ownerAddress: exists ? OWNER : null,
        ...(exists ? envelope : { encryptedKey: null, kdf: null, cipher: null }),
        version: exists ? 1 : null,
        backupConfirmedAt: state.vault === 'ready' ? Date.now() : null,
        challenge: { nonce: `0x${'ab'.repeat(32)}`, expiresAt: Date.now() + 300_000 },
      },
    });
  });
  const identity = () =>
    state.registered
      ? {
          state: 'confirmed',
          stage: 'confirmed',
          erc8004AgentId: '20482',
          provisionalAgentId: '20482',
          finality: 'final',
          pollAfterMs: null,
          mintTxHash: `0x${'a1'.repeat(32)}`,
          txHash: `0x${'f0'.repeat(32)}`,
          agentUri,
        }
      : null;
  const wallet = () => ({ address: state.answerWallet, ownerAddress: OWNER, state: 'derived' });
  // The agent has no money wallet yet (Wallet opens on the key's setup).
  await page.route('**/api/base/agents/*/wallet', (route) =>
    state.vault === 'off'
      ? route.fulfill({ status: 404, json: { error: 'Not found.' } })
      : route.fulfill({ json: { wallet: null } }),
  );
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({
      json: {
        identities: state.registered ? [{ chainId: 8453, wallet: wallet(), ...identity() }] : [],
      },
    }),
  );
  await page.route('**/api/base/agents/*/register', (route) => {
    state.sent.push(route.request().postDataJSON() as Record<string, unknown>);
    state.registered = state.answerWallet === WALLET;
    return route.fulfill({
      json: {
        wallet: wallet(),
        identity: identity() ?? { state: 'submitted', stage: 'registering' },
      },
    });
  });
  return state;
}

async function openBaseScreen(page: Page) {
  await page.goto('/?workspace=v2&theme=light#connect');
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: /^My agents/ })
    .first()
    .click();
  const region = page.getByRole('region', { name: 'Agents', exact: true });
  await region.getByRole('button', { name: /^Compass, / }).click();
  const pane = page.getByRole('complementary', { name: 'Compass details' });
  await pane.getByRole('button', { name: /^Base/ }).click();
  return { pane, screen: pane.getByRole('region', { name: 'Compass · Base', exact: true }) };
}

test('wallets on: no address field; one unlock, then the request carries only the derived wallet', async ({
  page,
}) => {
  const state = await server(page, 'ready');
  const { screen } = await openBaseScreen(page);
  await expect(screen.locator('[data-k="key-unlock"]')).toBeVisible();
  await expect(screen.getByLabel('Your wallet address')).toHaveCount(0);
  // A wrong password opens nothing and sends nothing.
  await screen.getByLabel('Wallet password').fill('Not-the-password-2026');
  await screen.getByRole('button', { name: 'Unlock and register', exact: true }).click();
  await expect(screen.getByRole('alert')).toHaveText('That password doesn’t open your wallet key.');
  expect(state.sent).toHaveLength(0);
  // Unlocked: it registers at once, with the wallet derived here and nothing else.
  await screen.getByLabel('Wallet password').fill(password);
  await screen.getByRole('button', { name: 'Unlock and register', exact: true }).click();
  await expect(screen.locator('[data-k="derived"]')).toContainText(
    'Checked in this browser: this is the wallet your own key makes for Compass.',
  );
  expect(state.sent).toEqual([{ expectedWallet: WALLET }]);
  await expect(screen).toContainText('Your wallet key');
});

test('a key held here: “Controlled by your wallet key”, and one click registers', async ({
  page,
}) => {
  const state = await server(page, 'ready');
  let { screen } = await openBaseScreen(page);
  await screen.getByLabel('Wallet password').fill(password);
  await screen.getByRole('button', { name: 'Unlock and register', exact: true }).click();
  await expect(screen.locator('[data-k="derived"]')).toBeVisible();
  // Another visit in this browser: the key is held, so no unlock; one click registers.
  state.registered = false;
  state.sent = [];
  ({ screen } = await openBaseScreen(page));
  const ready = screen.locator('[data-k="key-ready"]');
  await expect(ready).toContainText('Your wallet key');
  await expect(ready).toContainText('Holds its Base ID and its money');
  await screen.getByRole('button', { name: 'Register Compass on Base', exact: true }).click();
  await expect(screen.locator('[data-k="derived"]')).toBeVisible();
  expect(state.sent).toEqual([{ expectedWallet: WALLET }]);
});

test('no wallet key yet, or its backup not confirmed: set it up first, nothing is sent', async ({
  page,
}) => {
  const state = await server(page, 'none');
  let { pane, screen } = await openBaseScreen(page);
  await expect(screen.locator('[data-k="key-setup"]')).toContainText(
    'First, set up your wallet key.',
  );
  await screen.getByRole('button', { name: 'Set up your wallet key', exact: true }).click();
  await expect(pane.getByRole('heading', { name: 'Your wallet key' })).toBeVisible();
  state.vault = 'backup';
  ({ pane, screen } = await openBaseScreen(page));
  await expect(screen.locator('[data-k="key-backup"]')).toContainText(
    'Confirm your backup key first.',
  );
  await expect(
    screen.getByRole('button', { name: 'Finish the backup', exact: true }),
  ).toBeVisible();
  expect(state.sent).toHaveLength(0);
});

test('an answer naming another wallet, or a vault for another account: nothing is shown as registered', async ({
  page,
}) => {
  const state = await server(page, 'ready');
  state.answerWallet = OTHER_OWNER;
  let { screen } = await openBaseScreen(page);
  await screen.getByLabel('Wallet password').fill(password);
  await screen.getByRole('button', { name: 'Unlock and register', exact: true }).click();
  await expect(screen.getByRole('alert')).toContainText('isn’t the one your key makes');
  await expect(screen.locator('[data-k="derived"]')).toHaveCount(0);
  // The vault names another account: refused before anything is offered.
  state.accountOverride = 'acct-2';
  ({ screen } = await openBaseScreen(page));
  await expect(screen.getByRole('alert')).toContainText('isn’t your account’s');
  await expect(screen.getByRole('button', { name: /Register|Unlock/ })).toHaveCount(0);
});

test('wallets off: the address field stays exactly as before', async ({ page }) => {
  const state = await server(page, 'off');
  const { screen } = await openBaseScreen(page);
  await expect(screen.getByLabel('Your wallet address')).toBeVisible();
  await expect(screen.locator('[data-k^="key-"]')).toHaveCount(0);
  await screen.getByLabel('Your wallet address').fill(OTHER_OWNER);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => state.sent.length).toBe(1);
  expect(state.sent[0]).toEqual({ ownerAddress: OTHER_OWNER });
});

test('the classic Base panel never asks for an address with wallets on: it points to the Base screen', async ({
  page,
}) => {
  test.skip(true, NO_AGENT_DIALOG);
  const state = await server(page, 'ready');
  await page.goto('/?workspace=v2&theme=light#connect');
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: /^My agents/ })
    .first()
    .click();
  await openAgentDialog(page, 'Compass');
  const dialog = page.getByRole('dialog', { name: 'Compass', exact: true });
  await dialog.getByRole('tab', { name: 'Base', exact: true }).click();
  const panel = dialog.getByRole('tabpanel', { name: 'Base' });
  await expect(panel.locator('[data-k="key-elsewhere"]')).toContainText(
    'Compass registers with your wallet key on its Base screen',
  );
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  expect(state.sent).toHaveLength(0);
});

test('a registered agent’s wallet address shows only against the key held here, as on Add funds', async ({
  page,
}) => {
  const state = await server(page, 'ready');
  state.registered = true;
  // Never held in this browser: no address and nothing to copy for the agent's wallet.
  let { screen } = await openBaseScreen(page);
  const walletRow = () => screen.locator('.v4b-row').filter({ hasText: 'Compass’s wallet' });
  await expect(walletRow()).toContainText('Shown once your key is unlocked here');
  await expect(walletRow().getByRole('button')).toHaveCount(0);
  await expect(screen).not.toContainText(WALLET.slice(2, 8));
  // Held here: the exact wallet the key makes is shown, with its copy.
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [
    state.pinKey,
    OWNER,
  ] as const);
  ({ screen } = await openBaseScreen(page));
  await expect(walletRow()).toContainText(WALLET.slice(0, 6));
  await expect(walletRow().getByRole('button')).toHaveCount(1);
  // The server reports another wallet: not shown, whatever it says.
  state.answerWallet = OTHER_OWNER;
  ({ screen } = await openBaseScreen(page));
  await expect(walletRow()).toContainText('Not the wallet your key makes');
  await expect(screen).not.toContainText(OTHER_OWNER.slice(2, 8));
});

test('while the key’s state is still unknown, the agent’s wallet address isn’t shown', async ({
  page,
}) => {
  const state = await server(page, 'ready');
  state.registered = true;
  // The registration answers at once; the vault read hangs until released.
  let release = () => {};
  state.vaultHold = new Promise<void>((resolve) => (release = resolve));
  const { screen } = await openBaseScreen(page);
  await expect(screen.getByText('20482')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(screen).not.toContainText(WALLET.slice(2, 8));
  await expect(screen.locator('.v4b-row').filter({ hasText: 'Compass’s wallet' })).toHaveCount(0);
  // Known now (key not held here): still no address, with the reason.
  state.vaultHold = null;
  release();
  await expect(screen.locator('.v4b-row').filter({ hasText: 'Compass’s wallet' })).toContainText(
    'Shown once your key is unlocked here',
  );
  await expect(screen).not.toContainText(WALLET.slice(2, 8));
});

test('until it is known whether wallets are on, the classic panel offers nothing to click', async ({
  page,
}) => {
  test.skip(true, NO_AGENT_DIALOG);
  const state = await server(page, 'off');
  let release = () => {};
  state.vaultHold = new Promise<void>((resolve) => (release = resolve));
  await page.goto('/?workspace=v2&theme=light#connect');
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: /^My agents/ })
    .first()
    .click();
  await openAgentDialog(page, 'Compass');
  const dialog = page.getByRole('dialog', { name: 'Compass', exact: true });
  await dialog.getByRole('tab', { name: 'Base', exact: true }).click();
  const panel = dialog.getByRole('tabpanel', { name: 'Base' });
  await expect(panel.getByRole('status')).toHaveText('Loading…');
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  // Known now (wallets off): the address field, and its Continue registers.
  state.vaultHold = null;
  release();
  await panel.getByRole('textbox').fill(OTHER_OWNER);
  await panel.getByRole('button', { name: /Make it a Base agent|Continue/ }).click();
  await expect.poll(() => state.sent.length).toBe(1);
  expect(state.sent[0]).toEqual({ ownerAddress: OTHER_OWNER });
});
