import { getAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Agent, Snapshot } from '../shared/types';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network';
import { vaultProofTypedData, type VaultEnvelopeInput } from '../shared/base/vault';
import { openKey, sealKey } from '../src/base/vault/crypto';
import { expectedWallet } from '../src/base/wallet/derive';

/*
 * An agent's Wallet in My agents (docs/design/base-wallet-mockup.html; Operation Base Wallet W1,
 * test network). The wallet routes are synthetic fixtures served through page.route in the shapes
 * of server/base/wallet/routes.ts; the wallet key is made, locked and signed for real in the
 * browser (src/base/vault). MY_AGENTS_SHOTS=<dir> saves screenshots there.
 */

const headers = { 'X-City-Request': '1' };
const password = 'Local-test-only-passphrase-2026';
const at = '2026-10-10T12:00:00.000Z';
/** An identity wallet from before wallets, and the outside wallet that owns it (synthetic). */
const ELSEWHERE_WALLET = getAddress(`0x${'7c'.repeat(20)}`);
/** An address that isn't the wallet the owner's key makes for the agent. */
const SUBSTITUTED = getAddress(`0x${'9e'.repeat(20)}`);
const OUTSIDE_OWNER = getAddress(`0x${'51'.repeat(20)}`);
/** The person's wallet key when the vault is already set up (synthetic, fixed). */
const OWNER_KEY = `0x${'4c'.repeat(32)}` as Hex;
const OWNER = privateKeyToAccount(OWNER_KEY).address;
/** Another key the server could report as the owner, with its own correctly derived wallet. */
const OTHER_OWNER = getAddress(`0x${'5e'.repeat(20)}`);
const NOW = Date.now();

const scout: Agent = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Research scout',
  description: 'Synthetic fixture',
  capability: 'research',
  mode: 'external',
  isDemo: false,
  status: 'online',
  lastSeenAt: new Date(NOW - 60_000).toISOString(),
  createdAt: at,
  revokedAt: null,
};

const usdc = (value: number) => ({
  raw: String(Math.round(value * 1e6)),
  decimals: 6,
  display: String(value),
});

/** One USDC transfer log as the history reader sends it (blockHash, txHash and logIndex name it). */
const transfer = (
  at: number,
  block: number,
  kind: 'received' | 'spent' | 'withdrawn',
  amount: number,
  counterparty: string | null,
  tx = block,
  logIndex = 0,
) => ({
  at,
  block,
  blockHash: `0x${block.toString(16).padStart(64, 'b')}`,
  txHash: `0x${tx.toString(16).padStart(64, 'a')}`,
  logIndex,
  kind,
  amount: usdc(amount),
  counterparty,
});

/** The last 24 hours: read in full from a known opening balance of 8 USDC. */
const fullDay = (to: number) => ({
  window: { from: to - 86_400_000, to },
  headBlock: 18_402_113,
  readAt: to,
  startBalance: { usdc: usdc(8) },
  transfers: [
    transfer(to - 20 * 3_600_000, 18_360_000, 'spent', 3, null),
    transfer(to - 5.6 * 3_600_000, 18_397_402, 'received', 28.2, `0x${'3'.repeat(40)}`),
    transfer(to - 2.5 * 3_600_000, 18_399_000, 'withdrawn', 5, `0x${'9'.repeat(40)}`),
    transfer(to - 40 * 60_000, 18_401_000, 'spent', 3.2, null),
  ],
  scannedFrom: 18_300_000,
  complete: true,
});

/** The server side of one person's vault and one agent's wallet, as the routes answer. */
async function walletServer(page: Page, options: { off?: boolean; ready?: boolean } = {}) {
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Wallet-${randomUUID().slice(0, 8)}`, password },
  });
  expect(registered.status()).toBe(201);
  // The vault is the signed-in person's own: its accountId is their session's person id.
  const session = (await (await page.request.get('/api/session')).json()) as {
    operator: { id: string };
  };
  const person = session.operator.id;
  const envelope = options.ready ? await sealKey(OWNER_KEY, password, { N: 2 ** 17 }) : null;
  const baseline = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ json: { ...baseline, agents: [scout] } }),
  );
  await page.route('**/api/agents/*/answering', (route) =>
    route.fulfill({
      json: {
        agent_id: scout.id,
        can: true,
        by: 'runtime',
        auto_reply: 'none',
        runtime_connected: true,
      },
    }),
  );
  const state = {
    vault: options.ready
      ? {
          exists: true,
          ownerAddress: OWNER as string | null,
          encryptedKey: envelope!.encryptedKey as string | null,
          kdf: envelope!.kdf as unknown,
          cipher: envelope!.cipher as unknown,
          version: 1 as number | null,
          backupConfirmedAt: NOW as number | null,
        }
      : {
          exists: false,
          ownerAddress: null as string | null,
          encryptedKey: null as string | null,
          kdf: null as unknown,
          cipher: null as unknown,
          version: null as number | null,
          backupConfirmedAt: null as number | null,
        },
    wallet: options.ready,
    writes: [] as Array<{ url: string; body: Record<string, unknown> }>,
    /** Every GET of the vault (a refusal made in the page reads nothing). */
    reads: 0,
    /** Holds every GET of the vault this long (a slow unlock). */
    vaultDelayMs: 0,
    /** While set, every GET of the vault waits until it resolves (an unlock that hangs). */
    vaultHold: null as Promise<void> | null,
    /** The wallet read answers 503 chain_unavailable. */
    baseDown: false,
    history: fullDay as (to: number) => unknown,
    /** What the agent paid on its own (GET .../wallet/agent-payments), as the server lists it. */
    agentPayments: [] as unknown[],
    /** The wallet is on Base itself (chain 8453), not the test network: as this build's wallets. */
    mainnet: WALLET_CHAIN_ID === 8453,
    /** The agent was registered on Base before wallets: its Base ID is in a wallet another key owns. */
    elsewhere: false,
    /** The wallet route answers an address the owner's key doesn't make for this agent. */
    substituted: false,
    /** The vault and wallet both report this owner (and its own derived wallet) instead. */
    ownerOverride: null as string | null,
    /** The vault names this account instead of the signed-in person's. */
    accountOverride: null as string | null,
    /** A network tuple the server should never send (the screens must refuse it). */
    networkOverride: null as null | { chainId: number; network: string; testnet: boolean },
  };
  const reportedOwner = () => state.ownerOverride ?? state.vault.ownerAddress!;
  const off = (route: Parameters<Parameters<Page['route']>[1]>[0]) =>
    route.fulfill({ status: 404, json: { error: 'Not found.' } });
  await page.route('**/api/base/vault', async (route) => {
    if (options.off) return off(route);
    const method = route.request().method();
    if (method === 'GET' && state.vaultDelayMs)
      await new Promise((resolve) => setTimeout(resolve, state.vaultDelayMs));
    if (method === 'GET' && state.vaultHold) await state.vaultHold;
    if (method === 'GET') state.reads += 1;
    if (method === 'GET')
      return route.fulfill({
        json: {
          accountId: state.accountOverride ?? person,
          ...state.vault,
          ownerAddress: state.ownerOverride ?? state.vault.ownerAddress,
          challenge: {
            nonce: `0x${randomUUID().replace(/-/g, '').padEnd(64, '0')}`,
            expiresAt: NOW + 300_000,
          },
        },
      });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (method === 'PUT') {
      // A rewrap as the server checks it: the same owner, the next version, signed by that owner.
      const proof = body.proof as { nonce: Hex; signature: Hex };
      const signer = await recoverTypedDataAddress({
        ...vaultProofTypedData({
          accountId: person,
          ownerAddress: body.ownerAddress as Hex,
          envelope: body as unknown as VaultEnvelopeInput,
          version: body.version as number,
          purpose: 'rewrap',
          nonce: proof.nonce,
        }),
        signature: proof.signature,
      });
      if (getAddress(body.ownerAddress as string) !== getAddress(state.vault.ownerAddress!))
        return route.fulfill({
          status: 409,
          json: { error: 'A rewrap keeps the same owner key.', code: 'owner_mismatch' },
        });
      if (body.version !== (state.vault.version ?? 0) + 1)
        return route.fulfill({
          status: 409,
          json: { error: 'The vault changed; read it again.', code: 'version_conflict' },
        });
      if (signer !== getAddress(state.vault.ownerAddress!))
        return route.fulfill({
          status: 422,
          json: { error: 'Signature mismatch.', code: 'signature_mismatch' },
        });
      state.writes.push({ url: route.request().url(), body });
      state.vault = {
        ...state.vault,
        encryptedKey: body.encryptedKey as string,
        kdf: body.kdf,
        cipher: body.cipher,
        version: body.version as number,
      };
      return route.fulfill({ json: { accountId: person, ...state.vault } });
    }
    state.writes.push({ url: route.request().url(), body });
    state.vault = {
      exists: true,
      ownerAddress: body.ownerAddress as string,
      encryptedKey: body.encryptedKey as string,
      kdf: body.kdf,
      cipher: body.cipher,
      version: body.version as number,
      backupConfirmedAt: null,
    };
    return route.fulfill({ status: 201, json: { accountId: person, ...state.vault } });
  });
  await page.route('**/api/base/vault/backup-confirmed', (route) => {
    state.writes.push({ url: route.request().url(), body: route.request().postDataJSON() });
    state.vault.backupConfirmedAt = NOW;
    return route.fulfill({ json: { backupConfirmedAt: NOW } });
  });
  await page.route('**/api/base/agents/*/wallet', (route) => {
    if (options.off) return off(route);
    if (route.request().method() === 'POST') {
      state.wallet = true;
      return route.fulfill({
        json: { address: expectedWallet(state.vault.ownerAddress!, scout.id) },
      });
    }
    if (state.elsewhere)
      return route.fulfill({
        json: {
          kind: 'registered_elsewhere',
          address: ELSEWHERE_WALLET,
          ownerAddress: OUTSIDE_OWNER,
          chainId: WALLET_CHAIN_ID,
          network: WALLET_CHAIN_ID === 8453 ? 'Base' : 'Base Sepolia',
        },
      });
    if (!state.wallet) return route.fulfill({ json: { wallet: null } });
    if (state.baseDown)
      return route.fulfill({
        status: 503,
        json: { error: 'Base isn’t answering.', code: 'chain_unavailable' },
      });
    return route.fulfill({
      json: {
        chainId: state.mainnet ? 8453 : 84532,
        network: state.mainnet ? 'Base' : 'Base Sepolia',
        testnet: !state.mainnet,
        ...(state.networkOverride ?? {}),
        address: state.substituted ? SUBSTITUTED : expectedWallet(reportedOwner(), scout.id),
        ownerAddress: reportedOwner(),
        deployed: true,
        fundingLocked: false,
        usdc: usdc(25),
        eth: { raw: '1200000000000000', decimals: 18, display: '0.0012' },
        readAtBlock: 18_402_113,
        readAt: Date.now(),
        stale: false,
        explorerUrl: `https://sepolia.basescan.org/address/${expectedWallet(reportedOwner(), scout.id)}`,
      },
    });
  });
  await page.route('**/api/base/agents/*/wallet/history*', (route) => {
    if (options.off) return off(route);
    return route.fulfill({ json: state.history(Date.now()) });
  });
  await page.route('**/api/base/agents/*/wallet/agent-payments', (route) => {
    if (options.off) return off(route);
    return route.fulfill({ json: { payments: state.agentPayments } });
  });
  return Object.assign(state, {
    person,
    /** Where this browser keeps the key it held for this person (src/base/vault/keyPin.ts). */
    pinKey: `cc-wallet-key:${person}`,
    /** The agent's wallet: the one the vault's owner key makes for it (src/base/wallet/derive.ts). */
    walletAddress: () => expectedWallet(state.vault.ownerAddress!, scout.id),
  });
}

async function openPane(page: Page, theme = 'light') {
  await page.goto(`/?workspace=v2&theme=${theme}#connect`);
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: /^My agents/ })
    .first()
    .click();
  await page
    .getByRole('list', { name: 'Agents', exact: true })
    .getByRole('button', { name: /^Research scout, / })
    .click();
  const panel = page.getByRole('complementary', { name: 'Research scout details' });
  await expect(panel.getByRole('heading', { level: 2, name: 'Research scout' })).toBeVisible();
  return panel;
}

/** Add funds before this browser held the key: one unlock, then the address. */
async function unlockForAddress(add: Locator) {
  await expect(add.locator('[data-k="unlock-first"]')).toBeVisible();
  await add.getByLabel('Wallet password').fill(password);
  await add.getByRole('button', { name: 'Unlock and show address', exact: true }).click();
}

async function openAdd(page: Page) {
  await page.goto('/agents?workspace=v2#agent=' + scout.id + ':wallet-add');
  const add = page.getByRole('complementary', { name: 'Research scout details' });
  await expect(add.getByRole('heading', { name: 'Add funds' })).toBeVisible();
  return add;
}

async function shot(page: Page, name: string) {
  const dir = process.env.MY_AGENTS_SHOTS;
  // The odometer rolls and the 24-hour line draws itself in; shoot the settled screen.
  await page.waitForTimeout(1_600);
  await page.screenshot({
    path: dir ? `${dir}/wallet-${name}.png` : test.info().outputPath(`${name}.png`),
  });
}

test('set up the wallet key, save and check the backup key, then the wallet and Add funds', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const server = await walletServer(page);
  const panel = await openPane(page);
  const row = panel.locator('[data-k="row-wallet"]');
  await expect(row).toContainText('Set up');
  await row.click();

  // 1. The wallet key: a password, typed twice.
  await expect(panel.getByRole('heading', { name: 'Your wallet key' })).toBeVisible();
  await panel.getByLabel('Wallet password').fill('too short');
  await panel.getByLabel('Repeat the password').fill('too short');
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('at least 12 characters');
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByLabel('Repeat the password').fill(password);
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();

  // 2. The backup key: hidden until held, then 16 groups; Continue only once saved.
  await expect(panel.getByRole('heading', { name: 'Save your backup key' })).toBeVisible({
    timeout: 20_000,
  });
  const create = server.writes.find((write) => write.url.endsWith('/api/base/vault'))!;
  expect(Object.keys(create.body).sort()).toEqual(
    ['cipher', 'encryptedKey', 'kdf', 'ownerAddress', 'proof', 'version'].sort(),
  );
  expect(JSON.stringify(create.body)).not.toContain(password);
  const hold = panel.getByRole('button', { name: /Press and hold/ });
  const box = (await hold.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1_400);
  await page.mouse.up();
  await expect(panel.locator('[data-revealed="true"]')).toBeVisible({ timeout: 5_000 });
  await shot(page, 'backup-key');
  const groups = (
    await panel.locator('[data-revealed="true"] .wv-key-chars').allTextContents()
  ).map((group) => group.trim());
  expect(groups.every((group) => /^[0-9a-f]{4}$/.test(group))).toBe(true);
  expect(groups).toHaveLength(16);
  const next = panel.getByRole('button', { name: 'Continue', exact: true });
  await expect(next).toBeDisabled();
  await panel.getByLabel(/I saved the backup key/).check();
  await next.click();

  // 3. Two groups typed back.
  await expect(panel.getByRole('heading', { name: 'Check your backup key' })).toBeVisible();
  const labels = await panel.locator('label.w4-field span').allTextContents();
  for (const label of labels) {
    const index = Number(/Group (\d+)/.exec(label)![1]) - 1;
    // Exact: "Group 1" must not also find Group 10 to 16 (the two groups are picked at random).
    await panel.getByLabel(label, { exact: true }).fill(groups[index]!);
  }
  await panel.getByRole('button', { name: 'Finish', exact: true }).click();

  // 4. The wallet: balance from Base, the 24-hour line, the list.
  await expect(panel.getByRole('heading', { name: 'Wallet' })).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator('.w4-hero')).toContainText('USDC');
  await expect(panel.locator('.w4-hero .visually-hidden').first()).toHaveText('25.00');
  await expect(panel.locator('.w4-sub')).toContainText('block 18,402,113');
  await expect(panel.getByText('Last 24 hours', { exact: true })).toBeVisible();
  await expect(panel.locator('.w4-list .ap4-row')).toHaveCount(4);
  // Ratings given are listed on the Rate screen only, never on the Wallet itself.
  await expect(panel.getByText('Ratings given')).toHaveCount(0);
  expect(server.writes.some((write) => write.url.endsWith('/backup-confirmed'))).toBe(true);
  await shot(page, 'wallet');

  // 5. Add funds: the address, its QR, Base network only.
  await panel.getByRole('button', { name: 'Add funds', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Add funds' })).toBeVisible();
  await expect(panel.getByText(server.walletAddress())).toBeVisible();
  // The key was made in this browser: the address was checked against the key itself.
  await expect(panel.locator('[data-k="derived"]')).toHaveText(
    'Checked in this browser: this is the wallet your own key makes for Research scout.',
  );
  await expect(
    panel.getByRole('img', { name: new RegExp(server.walletAddress(), 'i') }),
  ).toBeVisible();
  await expect(panel.getByText('Base network only.')).toBeVisible();
  await shot(page, 'add-funds');
});

/** The page as hidden (another tab, a locked phone) or visible again. */
async function visibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

/** Set up the wallet key up to the backup key (not revealed yet). */
async function toBackupKey(page: Page, panel: ReturnType<Page['getByRole']>) {
  await panel.locator('[data-k="row-wallet"]').click();
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByLabel('Repeat the password').fill(password);
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Save your backup key' })).toBeVisible({
    timeout: 20_000,
  });
}

test('the backup key locks when the page is hidden, and an unlock that answers late never shows it', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const server = await walletServer(page);
  const panel = await openPane(page);
  await toBackupKey(page, panel);

  await visibility(page, 'hidden');
  await expect(panel.getByRole('heading', { name: 'Your wallet key' })).toBeVisible();
  await expect(panel.getByText(/The backup key is hidden again/)).toBeVisible();
  await expect(panel.locator('.wv-key')).toHaveCount(0);
  await visibility(page, 'visible');

  // A slow unlock, and the page is hidden before it answers: the key never comes back.
  await page.evaluate(() => {
    const seen = window as unknown as { sawKey: boolean };
    seen.sawKey = false;
    new MutationObserver(() => {
      if (document.querySelector('.wv-key')) seen.sawKey = true;
    }).observe(document.body, { subtree: true, childList: true });
  });
  // The late answer is dropped and the screen re-reads the wallet from the server (no key in it).
  const reread = () =>
    page.waitForRequest(
      (request) =>
        request.method() === 'GET' &&
        /\/api\/base\/agents\/[^/]+\/wallet$/.test(new URL(request.url()).pathname),
      { timeout: 30_000 },
    );
  server.vaultDelayMs = 2_500;
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Locking your key…' })).toBeVisible();
  let settled = reread();
  await visibility(page, 'hidden');
  server.vaultDelayMs = 0;
  await visibility(page, 'visible');
  await settled;
  await expect(panel.getByText(/The backup key is hidden again/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Unlock', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { sawKey: boolean }).sawKey)).toBe(false);

  // An unlock that hangs, and a lock meanwhile: the password goes at once, not when it answers.
  let release = () => {};
  server.vaultHold = new Promise<void>((resolve) => (release = resolve));
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Locking your key…' })).toBeVisible();
  settled = reread();
  await visibility(page, 'hidden');
  await expect(panel.getByLabel('Wallet password')).toHaveValue('');
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll('input[type="password"]')].some(
        (input) => (input as HTMLInputElement).value !== '',
      ),
    ),
  ).toBe(false);
  await visibility(page, 'visible');
  server.vaultHold = null;
  release();
  await settled;
  await expect(panel.getByText(/The backup key is hidden again/)).toBeVisible();
  await expect(panel.locator('.wv-key')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { sawKey: boolean }).sawKey)).toBe(false);

  // Unlocked again on purpose: the backup key is there to save.
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Save your backup key' })).toBeVisible({
    timeout: 20_000,
  });
});

test('left alone for 5 minutes, the check locks and forgets what was typed', async ({ page }) => {
  test.setTimeout(90_000);
  await walletServer(page);
  const panel = await openPane(page);
  await toBackupKey(page, panel);
  const hold = panel.getByRole('button', { name: /Press and hold/ });
  const box = (await hold.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1_400);
  await page.mouse.up();
  await panel.getByLabel(/I saved the backup key/).check();
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Check your backup key' })).toBeVisible();
  await panel.locator('label.w4-field input').first().fill('abcd');

  await page.clock.install();
  await page.clock.fastForward('05:01');
  await expect(panel.getByRole('heading', { name: 'Your wallet key' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(panel.getByText(/The backup key is hidden again/)).toBeVisible();
  await expect(panel.getByLabel(/^Group /)).toHaveCount(0);
  await expect(panel.getByLabel('Wallet password')).toHaveValue('');
});

test('an incomplete history: no line, no claim about 24 hours, the list since its first block', async ({
  page,
}) => {
  const server = await walletServer(page, { ready: true });
  const partial = (transfers: unknown[]) => (to: number) => ({
    ...fullDay(to),
    startBalance: null,
    complete: false,
    scannedFrom: 18_380_000,
    transfers,
  });
  const to = Date.now();
  server.history = partial([
    transfer(to - 2 * 3_600_000, 18_399_000, 'received', 4, `0x${'3'.repeat(40)}`),
  ]);
  let panel = await openPane(page);
  await panel.locator('[data-k="row-wallet"]').click();
  await expect(panel.locator('.w4-hero')).toContainText('USDC');
  await expect(panel.locator('.wv-line')).toHaveCount(0);
  await expect(panel.locator('.w4-hero')).toContainText(
    'Read from Base since block 18,380,000 only, so the last 24 hours aren’t complete yet.',
  );
  await expect(panel.getByText('Since block 18,380,000', { exact: true })).toBeVisible();
  await expect(panel.getByText('Last 24 hours', { exact: true })).toHaveCount(0);
  await expect(panel.locator('.w4-list .ap4-row')).toHaveCount(1);
  await expect(panel).not.toContainText('No transfers in the last 24 hours');

  server.history = partial([]);
  panel = await openPane(page);
  await panel.locator('[data-k="row-wallet"]').click();
  await expect(panel.getByText('No transfers seen since block 18,380,000.')).toBeVisible();
  await expect(panel).not.toContainText('No transfers in the last 24 hours');
  await expect(panel.locator('.wv-line')).toHaveCount(0);
});

test('a transfer to itself changes nothing; two logs of one transaction are two rows', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const server = await walletServer(page, { ready: true });
  server.history = (to) => ({
    ...fullDay(to),
    // 21 + 0 (to itself) + 1.5 + 2.5 = the 25 USDC Base holds now.
    startBalance: { usdc: usdc(21) },
    transfers: [
      transfer(to - 3 * 3_600_000, 18_398_000, 'spent', 2, server.walletAddress()),
      transfer(to - 3_600_000, 18_400_500, 'received', 1.5, `0x${'4'.repeat(40)}`, 77, 3),
      transfer(to - 3_600_000, 18_400_500, 'received', 2.5, `0x${'5'.repeat(40)}`, 77, 4),
    ],
  });
  const panel = await openPane(page);
  await panel.locator('[data-k="row-wallet"]').click();
  await expect(panel.locator('.wv-line')).toHaveCount(1);
  const rows = panel.locator('.w4-list .ap4-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('+2.50');
  await expect(rows.nth(1)).toContainText('+1.50');
  await expect(rows.nth(2)).toContainText('To itself');
  await expect(rows.nth(2).locator('.w4-amt')).toHaveText('2.00');
  expect(errors.filter((error) => /same key/i.test(error))).toEqual([]);
});

test('a payment the agent made on its own: "Paid Mischke" by the agent itself; the 24 hours unchanged', async ({
  page,
}) => {
  const server = await walletServer(page, { ready: true });
  const tx = `0x${'ab'.repeat(32)}`;
  // Synthetic rows in the shape of server/base/pay/agent-history.ts (Base Pay P2d).
  const paidByAgent = (
    paymentId: string,
    state: 'pending' | 'included' | 'final' | 'failed',
    amount: number,
    to: { agentId: string | null; name: string; baseId: string | null; short: string | null },
    txHash: string | null,
  ) => ({
    paymentId,
    by: 'agent',
    state,
    to: { ...to, wallet: getAddress(`0x${'2b'.repeat(20)}`) },
    token: 'USDC',
    amount: usdc(amount),
    txHash,
    explorerUrl: txHash ? `https://basescan.org/tx/${txHash}` : null,
    createdAt: NOW - 60_000,
    updatedAt: NOW,
  });
  server.agentPayments = [
    paidByAgent(
      'p-2',
      'pending',
      0.25,
      { agentId: null, name: '', baseId: null, short: null },
      null,
    ),
    paidByAgent(
      'p-1',
      'final',
      0.1,
      {
        agentId: '0b0b0b0b-0000-4000-8000-00000000000b',
        name: 'Mischke',
        baseId: '501',
        short: 'Misch1',
      },
      tx,
    ),
    // Anything not by the agent is never shown as one of its payments.
    {
      ...paidByAgent(
        'p-3',
        'final',
        9,
        { agentId: null, name: 'Owner', baseId: null, short: null },
        null,
      ),
      by: 'owner',
    },
  ];
  const panel = await openPane(page);
  await panel.locator('[data-k="row-wallet"]').click();
  const list = panel.getByLabel('Payments from Research scout', { exact: true });
  await expect(panel.getByText('Payments from Research scout', { exact: true })).toBeVisible();
  const rows = list.locator('.ap4-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-by', 'agent');
  await expect(rows.nth(0).locator('.ap4-k')).toContainText('Paying 0x2b2B…2B2B');
  await expect(rows.nth(0).locator('.w4-row-sub')).toContainText(
    'By Research scout itself · on its way, not paid until final',
  );
  await expect(rows.nth(0).locator('.w4-amt')).toHaveText('0.25');
  await expect(rows.nth(1).locator('.ap4-k')).toContainText('Paid Mischke');
  await expect(rows.nth(1).locator('.w4-row-sub')).toContainText(
    'By Research scout itself · Base ID 501 · ',
  );
  await expect(rows.nth(1).locator('.w4-amt')).toHaveText('−0.1');
  await expect(rows.nth(1).getByRole('link', { name: 'Basescan' })).toHaveAttribute(
    'href',
    `https://basescan.org/tx/${tx}`,
  );
  await expect(list).not.toContainText('Owner');
  // The 24 hours read from Base: as before, its own rows and labels.
  await expect(panel.getByText('Last 24 hours', { exact: true })).toBeVisible();
  const day = panel.locator('.w4-list').first().locator('.ap4-row');
  await expect(day).toHaveCount(4);
  await expect(day.nth(0)).toContainText('Spent by Research scout');
  await expect(day.nth(1)).toContainText('Withdrawn');
  await expect(day.nth(2)).toContainText('Received');
  await shot(page, 'paid-by-agent');

  // None (or wallets off): no section at all.
  server.agentPayments = [];
  const again = await openPane(page);
  await again.locator('[data-k="row-wallet"]').click();
  await expect(again.getByText('Last 24 hours', { exact: true })).toBeVisible();
  await expect(again.getByText('Payments from Research scout', { exact: true })).toHaveCount(0);
});

test('Base stops answering after a good read: the balance stays, marked as the last read', async ({
  page,
}) => {
  await page.clock.install();
  const server = await walletServer(page, { ready: true });
  const panel = await openPane(page);
  await panel.locator('[data-k="row-wallet"]').click();
  await expect(panel.locator('.w4-read')).toHaveText(/^Read from Base · block 18,402,113/);
  server.baseDown = true;
  await page.clock.fastForward(31_000);
  await expect(panel.locator('.w4-read')).toHaveText(/^Last read from Base · block 18,402,113/);
  await expect(panel.getByText('Base isn’t answering right now.')).toBeVisible();
  await expect(panel.locator('.w4-hero .visually-hidden').first()).toHaveText('25.00');
});

test('on Base itself the wallet says Base, never "Test network", and Add funds says it is real', async ({
  page,
}) => {
  test.skip(WALLET_CHAIN_ID !== 8453, 'This build’s wallets are on the test network.');
  const server = await walletServer(page, { ready: true });
  server.mainnet = true;
  const panel = await openPane(page);
  await panel.locator('[data-k="row-wallet"]').click();
  await expect(panel.locator('.w4-net')).toHaveText('Base');
  await expect(panel).not.toContainText('Test network');
  await panel.getByRole('button', { name: 'Add funds', exact: true }).click();
  await unlockForAddress(panel);
  await expect(
    panel.getByText('This is real USDC on Base. A payment can’t be undone.'),
  ).toBeVisible();
  await expect(panel).not.toContainText('Sepolia');
});

for (const tuple of [
  // A wallet on the other of the two networks than this build's.
  WALLET_CHAIN_ID === 8453
    ? { chainId: 84532, network: 'Base Sepolia', testnet: true }
    : { chainId: 8453, network: 'Base', testnet: false },
  { chainId: 1, network: 'Ethereum', testnet: false },
  { chainId: 8453, network: 'Base', testnet: true },
  { chainId: 84532, network: 'Base Sepolia', testnet: false },
])
  test(`an unknown network ${tuple.chainId}/${tuple.testnet}: no address, no QR, no copy`, async ({
    page,
  }) => {
    // The other Base network means the server was deployed after this page loaded: reload.
    const refusal =
      tuple.chainId !== WALLET_CHAIN_ID && (tuple.chainId === 8453 || tuple.chainId === 84532)
        ? 'This page is out of date. Reload it and try again.'
        : 'This wallet’s network isn’t supported here.';
    const server = await walletServer(page, { ready: true });
    server.networkOverride = tuple;
    const panel = await openPane(page);
    await panel.locator('[data-k="row-wallet"]').click();
    await expect(panel.getByText(refusal)).toBeVisible();
    await expect(panel.locator('.w4-hero')).toHaveCount(0);
    await expect(panel).not.toContainText(server.walletAddress().slice(2, 10));
    // Add funds, opened directly: the same refusal, nothing to send money to.
    await page.goto(`/agents?workspace=v2#agent=${scout.id}:wallet-add`);
    await expect(panel.getByRole('heading', { name: 'Add funds' })).toBeVisible();
    await expect(panel.getByText(refusal)).toBeVisible();
    await expect(panel.getByRole('img', { name: /QR code/ })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Copy' })).toHaveCount(0);
    await expect(panel).not.toContainText(server.walletAddress().slice(2, 10));
    await expect(panel).not.toContainText('real USDC');
  });

test('registered on Base before wallets: shown as held by your own wallet, never used here', async ({
  page,
}) => {
  const server = await walletServer(page);
  server.elsewhere = true;
  const panel = await openPane(page);
  const row = panel.locator('[data-k="row-wallet"]');
  await expect(row).toContainText('In your own wallet');
  await row.click();
  const card = panel.locator('[data-k="elsewhere"]');
  await expect(card).toContainText('Central City can’t use this wallet yet.');
  await expect(card).toContainText(ELSEWHERE_WALLET);
  await expect(card).toContainText(OUTSIDE_OWNER);
  await expect(card).toContainText('your wallet outside Central City');
  // Nothing to act on here: no balance, no Add funds, Withdraw, Pay or QR.
  for (const name of ['Add funds', 'Withdraw', 'Pay'])
    await expect(panel.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(panel.locator('canvas')).toHaveCount(0);
  await expect(panel).not.toContainText('USDC');
  await shot(page, 'wallet-elsewhere');
  // Nothing was created or written for it.
  expect(server.writes).toEqual([]);
});

test('an answer of another kind is never read as a wallet', async ({ page }) => {
  const server = await walletServer(page);
  server.elsewhere = true;
  await page.route('**/api/base/agents/*/wallet', (route) =>
    route.fulfill({ json: { kind: 'something_new', address: ELSEWHERE_WALLET, usdc: usdc(25) } }),
  );
  const panel = await openPane(page);
  // A read that can't be used is a failed read: the row stays (so the Wallet screen and its retry
  // open), but it shows no balance and no address.
  const row = panel.locator('[data-k="row-wallet"]');
  await expect(row).toContainText('Couldn’t load');
  await expect(row).not.toContainText('USDC');
  await expect(panel).not.toContainText(ELSEWHERE_WALLET);
  await expect(panel).not.toContainText('In your own wallet');
});

test('with the key ready and no wallet yet, Create names the network the wallet goes on', async ({
  page,
}) => {
  const server = await walletServer(page, { ready: true });
  server.wallet = false;
  const panel = await openPane(page);
  await panel.locator('[data-k="row-wallet"]').click();
  await expect(
    panel.getByRole('button', { name: /^Create Research scout’s wallet/ }),
  ).toBeVisible();
  await expect(panel).toContainText(
    WALLET_CHAIN_ID === 8453
      ? 'Create Research scout’s wallet on Base.'
      : 'Create Research scout’s wallet on the test network.',
  );
});

test("a wallet address the owner key doesn't make is never shown: no address, QR or copy", async ({
  page,
}) => {
  const server = await walletServer(page, { ready: true });
  server.substituted = true;
  const panel = await openPane(page);
  await panel.locator('[data-k="row-wallet"]').click();
  await expect(panel.getByRole('alert')).toContainText(
    'This isn’t the wallet your wallet key makes for this agent, so its address isn’t shown.',
  );
  await expect(panel).not.toContainText(SUBSTITUTED.slice(2, 10));
  await expect(panel.getByRole('button', { name: 'Copy' })).toHaveCount(0);
  // Add funds straight from its link: the same refusal, never a QR.
  await page.goto('/agents?workspace=v2#agent=' + scout.id + ':wallet-add');
  const add = page.getByRole('complementary', { name: 'Research scout details' });
  await expect(add.getByRole('alert')).toContainText('so its address isn’t shown');
  await expect(add.locator('canvas')).toHaveCount(0);
  await expect(add).not.toContainText(SUBSTITUTED.slice(2, 10));
});

test('a funding address only against a key held here: one unlock first, then the key itself', async ({
  page,
}) => {
  const server = await walletServer(page, { ready: true });
  const address = server.walletAddress();
  const panel = await openPane(page);
  await panel.locator('[data-k="row-wallet"]').click();
  await expect(panel.locator('.w4-hero')).toContainText('USDC');
  // Never held in this browser: the balance shows, the address doesn't.
  await expect(panel.locator('[data-k="address-locked"]')).toContainText(
    'Shown once your key is unlocked in this browser',
  );
  await expect(panel).not.toContainText(address.slice(2, 10));
  await expect(panel.getByRole('button', { name: 'Copy' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Add funds', exact: true }).click();
  await expect(panel.locator('[data-k="unlock-first"]')).toBeVisible();
  await expect(panel.locator('canvas')).toHaveCount(0);
  await expect(panel).not.toContainText(address.slice(2, 10));
  // A wrong password opens nothing and shows nothing.
  await panel.getByLabel('Wallet password').fill('Not-the-password-2026');
  await panel.getByRole('button', { name: 'Unlock and show address', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText('That password doesn’t open your wallet key.');
  await expect(panel.locator('canvas')).toHaveCount(0);
  // Unlocked here: checked against the key itself.
  await unlockForAddress(panel);
  await expect(panel.getByText(address)).toBeVisible();
  await expect(panel.locator('[data-k="derived"]')).toHaveText(
    'Checked in this browser: this is the wallet your own key makes for Research scout.',
  );
  // Held for this person across a reload.
  let add = await openAdd(page);
  await expect(add.getByText(address)).toBeVisible();
  // A key held here that differs from the one reported: the report alone never shows the address.
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [
    server.pinKey,
    OTHER_OWNER,
  ] as const);
  add = await openAdd(page);
  await expect(add.getByRole('alert')).toContainText('so its address isn’t shown');
  await expect(add).not.toContainText(address.slice(2, 10));
});

test('a substituted owner with its own correctly derived wallet: never offered, and the unlock refuses it', async ({
  page,
}) => {
  const server = await walletServer(page, { ready: true });
  // Every report agrees on another owner and the wallet that owner makes; nothing held here yet.
  server.ownerOverride = OTHER_OWNER;
  const substituted = expectedWallet(OTHER_OWNER, scout.id);
  const add = await openAdd(page);
  await expect(add.locator('[data-k="unlock-first"]')).toBeVisible();
  await expect(add).not.toContainText(substituted.slice(2, 10));
  // The person's own envelope opens to their own key, which isn't the owner reported.
  await add.getByLabel('Wallet password').fill(password);
  await add.getByRole('button', { name: 'Unlock and show address', exact: true }).click();
  await expect(add.getByRole('alert')).toHaveText('This wallet key belongs to another account.');
  await expect(add.locator('canvas')).toHaveCount(0);
  await expect(add).not.toContainText(substituted.slice(2, 10));
  expect(await page.evaluate((key) => localStorage.getItem(key), server.pinKey)).toBeNull();
});

test('storage that refuses the key: the address for this page after the unlock, asked again after a reload', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    const get = Storage.prototype.getItem;
    const refuse = (key: string) => {
      if (key.startsWith('cc-wallet-key:')) throw new DOMException('Blocked', 'SecurityError');
    };
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      refuse(String(key));
      return set.call(this, key, value);
    };
    Storage.prototype.getItem = function (this: Storage, key: string) {
      refuse(String(key));
      return get.call(this, key);
    };
  });
  const server = await walletServer(page, { ready: true });
  let add = await openAdd(page);
  await unlockForAddress(add);
  await expect(add.getByText(server.walletAddress())).toBeVisible();
  // Not kept: after a reload it's one unlock again, never the report alone.
  add = await openAdd(page);
  await expect(add.locator('[data-k="unlock-first"]')).toBeVisible();
  await expect(add).not.toContainText(server.walletAddress().slice(2, 10));
});

test('a vault naming another account: refused, even where that account has its key held here', async ({
  page,
}) => {
  const server = await walletServer(page, { ready: true });
  let add = await openAdd(page);
  await unlockForAddress(add);
  await expect(add.getByText(server.walletAddress())).toBeVisible();
  // The vault now names acct-2 with its own consistent owner and wallet, and this browser's
  // storage holds that owner under acct-2: the namespace is the session's person, not the vault's.
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [
    'cc-wallet-key:acct-2',
    OTHER_OWNER,
  ] as const);
  server.accountOverride = 'acct-2';
  server.ownerOverride = OTHER_OWNER;
  const substituted = expectedWallet(OTHER_OWNER, scout.id);
  add = await openAdd(page);
  await expect(add.getByRole('alert')).toContainText('so its address isn’t shown');
  await expect(add).not.toContainText(substituted.slice(2, 10));
  await expect(add.locator('canvas')).toHaveCount(0);
  const panel = await openPane(page);
  await panel.locator('[data-k="row-wallet"]').click();
  await expect(panel.getByRole('alert')).toContainText('so its address isn’t shown');
  await expect(panel).not.toContainText(substituted.slice(2, 10));
  // Even with no key held for this person at all: the vault isn't theirs, so no unlock is offered.
  await page.evaluate((key) => localStorage.removeItem(key), server.pinKey);
  add = await openAdd(page);
  await expect(add.getByRole('alert')).toContainText('so its address isn’t shown');
  await expect(add.locator('[data-k="unlock-first"]')).toHaveCount(0);
  await expect(add).not.toContainText(substituted.slice(2, 10));
});

test('a later read naming another address takes the address away', async ({ page }) => {
  await page.clock.install();
  const server = await walletServer(page, { ready: true });
  const add = await openAdd(page);
  await unlockForAddress(add);
  await expect(add.getByText(server.walletAddress())).toBeVisible();
  const panel = await openPane(page);
  await panel.locator('[data-k="row-wallet"]').click();
  await expect(panel.getByRole('button', { name: 'Copy' })).toBeVisible();
  // The 30-second re-read answers a substituted address: checked like the first read.
  server.substituted = true;
  await page.clock.fastForward(31_000);
  await expect(panel.getByRole('alert')).toContainText('so its address isn’t shown');
  await expect(panel).not.toContainText(SUBSTITUTED.slice(2, 10));
  await expect(panel.getByRole('button', { name: 'Copy' })).toHaveCount(0);
});

test('wallets off on this server: no Wallet row at all', async ({ page }) => {
  await walletServer(page, { off: true });
  const panel = await openPane(page);
  await expect(panel.getByRole('heading', { level: 2, name: 'Research scout' })).toBeVisible();
  await expect(panel.locator('[data-k="row-wallet"]')).toHaveCount(0);
});

for (const theme of ['light', 'dark'] as const)
  test(`the wallet at 390 px (${theme}): no sideways scroll`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await walletServer(page, { ready: true });
    const panel = await openPane(page, theme);
    await expect(panel.locator('[data-k="row-wallet"]')).toContainText('25.00 USDC');
    await panel.locator('[data-k="row-wallet"]').click();
    await expect(panel.locator('.w4-hero')).toContainText('USDC');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await shot(page, `390-${theme}`);
  });

/** The stored envelope (after a rewrap) as the test reads it back. */
const storedEnvelope = (server: Awaited<ReturnType<typeof walletServer>>) =>
  ({
    encryptedKey: server.vault.encryptedKey,
    kdf: server.vault.kdf,
    cipher: server.vault.cipher,
  }) as unknown as VaultEnvelopeInput;

/** The owner's backup key as written down: 16 groups of 4, with a 0x and dashes among the spaces. */
const WRITTEN_BACKUP = `0x ${OWNER_KEY.slice(2)
  .match(/.{4}/g)!
  .map((group, index) => (index === 8 ? `- ${group}` : group))
  .join(' ')}`;
/** A valid key that isn't the owner's: one group off, as a typo would make (synthetic). */
const TYPO_BACKUP = `${'4c'.repeat(30)}4d4c`;
const NEW_PASSWORD = 'Restored-local-test-passphrase-2026';

test('a forgotten password: restored with the backup key on Add funds, held here like an unlock', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const server = await walletServer(page, { ready: true });
  const address = server.walletAddress();
  const add = await openAdd(page);
  await expect(add.locator('[data-k="unlock-first"]')).toBeVisible();
  const forgot = add.getByRole('button', {
    name: 'Forgot your password? Restore with your backup key',
    exact: true,
  });
  await forgot.click();
  await expect(add.getByRole('heading', { name: 'Restore with your backup key' })).toBeVisible();
  const backup = add.getByLabel('Backup key');
  await expect(backup).toHaveAttribute('autocomplete', 'off');
  await expect(add.getByLabel('New wallet password')).toHaveAttribute('type', 'password');
  await expect(add.getByLabel('Repeat the new password')).toHaveAttribute('type', 'password');
  const restore = add.getByRole('button', { name: 'Restore', exact: true });
  await shot(page, 'restore');
  const reads = server.reads;

  // Refused in the page, before anything is read or sent: a wrong format, then two passwords.
  await backup.fill('7f3a 9c21');
  await add.getByLabel('New wallet password').fill(NEW_PASSWORD);
  await add.getByLabel('Repeat the new password').fill(NEW_PASSWORD);
  await restore.click();
  await expect(add.getByRole('alert')).toHaveText('A backup key has 64 characters; this has 8.');
  await backup.fill(WRITTEN_BACKUP);
  await add.getByLabel('Repeat the new password').fill(`${NEW_PASSWORD}!`);
  await restore.click();
  await expect(add.getByRole('alert')).toHaveText('The two passwords aren’t the same.');
  expect(server.reads).toBe(reads);
  expect(server.writes).toHaveLength(0);

  // Leaving the form empties it.
  await add.getByRole('button', { name: 'Add funds', exact: true }).click();
  await expect(add.locator('[data-k="unlock-first"]')).toBeVisible();
  await forgot.click();
  await expect(backup).toHaveValue('');
  await expect(add.getByLabel('New wallet password')).toHaveValue('');

  // A key that isn't this wallet's (a typo makes another valid key): refused, nothing written.
  await backup.fill(TYPO_BACKUP);
  await add.getByLabel('New wallet password').fill(NEW_PASSWORD);
  await add.getByLabel('Repeat the new password').fill(NEW_PASSWORD);
  await restore.click();
  await expect(add.getByRole('alert')).toHaveText(
    'This backup key doesn’t match your wallet. Check each group against your copy.',
  );
  expect(server.writes).toHaveLength(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), server.pinKey)).toBeNull();

  // The key as written down: restored, held here, and back on Add funds with the address.
  await backup.fill(WRITTEN_BACKUP);
  await restore.click();
  await expect(add.locator('[data-k="key-note"]')).toHaveText(
    'Restored. Your new password works from now on.',
    { timeout: 20_000 },
  );
  await expect(add.getByRole('heading', { name: 'Add funds' })).toBeVisible();
  await expect(add.getByText(address)).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), server.pinKey)).toBe(OWNER);
  // One rewrap of the same owner; neither the key nor the password ever left the page.
  expect(server.writes).toHaveLength(1);
  expect(server.writes[0]!.body.version).toBe(2);
  expect(server.writes[0]!.body.ownerAddress).toBe(OWNER);
  const sent = JSON.stringify(server.writes[0]!.body);
  expect(sent).not.toContain(OWNER_KEY.slice(2, 18));
  expect(sent).not.toContain(NEW_PASSWORD);
  expect(server.vault.backupConfirmedAt).toBe(NOW);
  // The new password opens the same key; the old one doesn't any more.
  expect(await openKey(storedEnvelope(server), NEW_PASSWORD, OWNER)).toBe(OWNER_KEY);
  await expect(openKey(storedEnvelope(server), password, OWNER)).rejects.toThrow(
    'That password doesn’t open your wallet key.',
  );
});

test('change the password from the wallet: a wrong current one is refused, then the new one works', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const server = await walletServer(page, { ready: true });
  const panel = await openPane(page);
  await panel.locator('[data-k="row-wallet"]').click();
  await expect(panel.locator('[data-k="address-locked"]')).toBeVisible();
  await panel.locator('[data-k="row-password"]').click();
  await expect(panel.getByRole('heading', { name: 'Change password' })).toBeVisible();
  const current = panel.getByLabel('Current password');
  await expect(current).toHaveAttribute('type', 'password');
  const change = panel.getByRole('button', { name: 'Change password', exact: true });

  // Two different new passwords: refused before anything is read or sent.
  const reads = server.reads;
  await current.fill(password);
  await panel.getByLabel(/^New password/).fill(NEW_PASSWORD);
  await panel.getByLabel('Repeat the new password').fill(`${NEW_PASSWORD}!`);
  await change.click();
  await expect(panel.getByRole('alert')).toHaveText('The two passwords aren’t the same.');
  expect(server.reads).toBe(reads);

  // A wrong current password opens nothing and writes nothing.
  await current.fill('Not-the-local-test-passphrase');
  await panel.getByLabel('Repeat the new password').fill(NEW_PASSWORD);
  await change.click();
  await expect(panel.getByRole('alert')).toHaveText('That password doesn’t open your wallet key.', {
    timeout: 20_000,
  });
  await expect(current).toHaveValue('');
  expect(server.writes).toHaveLength(0);

  await current.fill(password);
  await change.click();
  await expect(panel.locator('[data-k="key-note"]')).toHaveText('Password changed.', {
    timeout: 20_000,
  });
  await expect(panel.getByRole('heading', { name: 'Wallet' })).toBeVisible();
  // Held here as after an unlock: the address now shows against the key itself.
  await expect(panel.locator('[data-k="address-locked"]')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Copy' })).toBeVisible();
  await shot(page, 'password-changed');
  expect(await page.evaluate((key) => localStorage.getItem(key), server.pinKey)).toBe(OWNER);
  expect(server.writes).toHaveLength(1);
  expect(server.writes[0]!.body.version).toBe(2);
  expect(JSON.stringify(server.writes[0]!.body)).not.toContain(NEW_PASSWORD);
  expect(await openKey(storedEnvelope(server), NEW_PASSWORD, OWNER)).toBe(OWNER_KEY);

  // Reopened, the form is empty.
  await panel.locator('[data-k="row-password"]').click();
  await expect(current).toHaveValue('');
  await expect(panel.getByLabel(/^New password/)).toHaveValue('');
});
