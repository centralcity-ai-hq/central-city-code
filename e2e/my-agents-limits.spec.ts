import { expect, test, type Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  parseAbi,
  recoverAddress,
  verifyTypedData,
  type Hex,
} from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import type { Agent, Snapshot } from '../shared/types';
import type { SpendPermission } from '../shared/base/types';
import { BASE_NETWORKS } from '../shared/base/chains';
import {
  berlinDayStart,
  calendarPeriod,
  LIMIT_PERIOD_SECONDS,
  LIMIT_PERMISSION_END,
  nextBerlinMidnight,
  onchainAllowance,
  permissionFromJson,
  permissionToJson,
  revokeCall,
  smartWalletMessageTypedData,
  spendPermissionHash,
  type LimitPeriod,
  type OnchainCapModel,
} from '../shared/base/spend-limits';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network';
import { BASE_MAINNET } from '../shared/base/chains';
import { SPONSOR_PAYMASTERS } from '../shared/base/paymasters';

/** The pinned sponsor's data (shared/base/paymasters.ts layout: no token, 65-byte signature). */
const SPONSOR_DATA =
  `0x${SPONSOR_PAYMASTERS[BASE_MAINNET]![0]!.slice(2)}${'00'.repeat(109)}${'ab'.repeat(65)}` as Hex;
/** Nothing can be signed where no sponsor is pinned (Base Sepolia today): the revoke waits for Base. */
const SIGNABLE = (SPONSOR_PAYMASTERS[WALLET_CHAIN_ID] ?? []).length > 0;
import { ownerOperationHash, userOperationToRpc } from '../shared/base/withdraw';
import { sealKey } from '../src/base/vault/crypto';
import { expectedWallet } from '../src/base/wallet/derive';
import { privateKeyToAccount } from 'viem/accounts';

/*
 * An agent's spending limit (Operation Base Wallet W3). The limit routes are fixtures in the
 * shapes of server/base/wallet/limits.ts, with real spend permissions, EIP-712 hashes and
 * UserOperation hashes; the owner key is a real locked key the browser unlocks, and the fixture
 * verifies every signature against the owner address (the limit with verifyTypedData over the
 * wallet's CoinbaseSmartWalletMessage, the revoke by recovering the raw userOpHash).
 * MY_AGENTS_SHOTS=<dir> saves screenshots there.
 */

const headers = { 'X-City-Request': '1' };
const password = 'Local-test-only-passphrase-2026';
const NOW = Date.now();
const NETWORK = BASE_NETWORKS[WALLET_CHAIN_ID];
const SPENDER = getAddress(`0x${'3c'.repeat(20)}`);
const USDC = getAddress(NETWORK.tokens.USDC.address);
const LIMIT_ID = '0f3c2b1a-9e8d-4c7b-8a6f-5e4d3c2b1a09';
const walletAbi = parseAbi(['function execute(address target, uint256 value, bytes data)']);

const scout: Agent = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Research scout',
  description: 'Synthetic fixture',
  capability: 'research',
  mode: 'external',
  isDemo: false,
  status: 'online',
  lastSeenAt: new Date(NOW - 60_000).toISOString(),
  createdAt: new Date(NOW - 86_400_000).toISOString(),
  revokedAt: null,
};

/** A fixed synthetic owner key, so the agent's wallet is the one it makes (src/base/wallet/derive.ts). */
const OWNER_KEY = `0x${'4c'.repeat(32)}` as Hex;
const OWNER = privateKeyToAccount(OWNER_KEY).address;
const WALLET = expectedWallet(OWNER, scout.id);

const amount = (raw: bigint, decimals: number, display: string) => ({
  raw: raw.toString(),
  decimals,
  display,
});

interface FixtureLimit {
  permission: SpendPermission;
  capRaw: string;
  period: LimitPeriod;
  model: OnchainCapModel;
  state: 'signed' | 'approved' | 'revoke_pending' | 'revoked';
  revoke: null | {
    state: string;
    userOpHash: Hex;
    txHash: null;
    expiresAt: number | null;
  };
}

async function limitsServer(page: Page) {
  const owner = { privateKey: OWNER_KEY, address: OWNER };
  const envelope = await sealKey(owner.privateKey, password, { N: 2 ** 17 });
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Limits-${randomUUID().slice(0, 8)}`, password },
  });
  expect(registered.status()).toBe(201);
  // The vault is the signed-in person's own: its accountId is their session's person id.
  const person = (
    (await (await page.request.get('/api/session')).json()) as { operator: { id: string } }
  ).operator.id;
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
  /** While set, every read of the vault waits for it (an unlock that hangs). */
  const control = {
    vaultHold: null as Promise<void> | null,
    /** The agent's spending key as the wallet route reports it; null: not reported. */
    spender: SPENDER as string | null,
  };
  await page.route('**/api/base/vault', async (route) => {
    if (control.vaultHold) await control.vaultHold;
    return route.fulfill({
      json: {
        accountId: person,
        exists: true,
        ownerAddress: owner.address,
        ...envelope,
        version: 1,
        backupConfirmedAt: NOW,
        challenge: { nonce: `0x${'ab'.repeat(32)}`, expiresAt: NOW + 300_000 },
      },
    });
  });
  await page.route('**/api/base/agents/*/wallet', (route) =>
    route.fulfill({
      json: {
        chainId: WALLET_CHAIN_ID,
        network: NETWORK.name,
        testnet: WALLET_CHAIN_ID !== 8453,
        address: WALLET,
        ownerAddress: owner.address,
        spenderAddress: control.spender,
        deployed: false,
        fundingLocked: false,
        usdc: amount(25_000_000n, 6, '25'),
        eth: amount(0n, 18, '0'),
        readAtBlock: 18_402_113,
        readAt: Date.now(),
        stale: false,
        explorerUrl: null,
      },
    }),
  );
  await page.route('**/api/base/agents/*/wallet/history*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Not found.' } }),
  );

  const state = {
    control,
    owner: owner.address,
    /** The model the server prepares new limits with. */
    model: 'half' as OnchainCapModel,
    /** The fixture prepares the full cap as the allowance, whatever the model. */
    tamper: false,
    /** The prepared permission lets this key spend (its hash recomputed for it). */
    preparedSpender: SPENDER as string,
    prepares: 0,
    prepared: null as SpendPermission | null,
    limit: null as FixtureLimit | null,
    /** Base couldn't be read: the view is stale and every limit's onchain is null. */
    stale: false,
    /** The server has no limit routes (404), like a server without W3. */
    off: false,
    calendarSpentRaw: '0',
    onchainSpentRaw: '0',
    revokeHash: '0x' as Hex,
    signatures: [] as Array<{ kind: 'limit' | 'revoke'; valid: boolean; signer?: string }>,
  };

  const display = (raw: bigint) => formatUnits(raw, 6);
  const summary = (limit: FixtureLimit) => ({
    permissionId: LIMIT_ID,
    token: 'USDC',
    capRaw: limit.capRaw,
    capDisplay: display(BigInt(limit.capRaw)),
    onchainModel: limit.model,
    allowanceRaw: limit.permission.allowance.toString(),
    allowanceDisplay: display(limit.permission.allowance),
    boundaryBurstRaw: (limit.permission.allowance * 2n).toString(),
    period: limit.period,
    periodSeconds: limit.permission.period,
    permissionHash: spendPermissionHash(WALLET_CHAIN_ID, limit.permission),
    state: limit.state,
    createdAt: NOW,
  });
  const view = () => {
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000);
    const limits = state.limit ? [state.limit] : [];
    return {
      chainId: WALLET_CHAIN_ID,
      network: NETWORK.name,
      testnet: WALLET_CHAIN_ID !== 8453,
      onchainModel: state.model,
      stale: limits.length > 0 && state.stale,
      readAtBlock: state.stale ? null : 18_402_120,
      readAt: state.stale ? null : nowMs,
      limits: limits.map((limit) => {
        const p = limit.permission;
        const active = now >= p.start;
        const periodStart = active
          ? p.start + Math.floor((now - p.start) / p.period) * p.period
          : 0;
        const spent = active ? BigInt(state.onchainSpentRaw) : 0n;
        const window = calendarPeriod(limit.period, nowMs);
        const cap = BigInt(limit.capRaw);
        const calendarSpent = BigInt(state.calendarSpentRaw);
        const usable = limit.state === 'signed' || limit.state === 'approved';
        return {
          ...summary(limit),
          onchain: state.stale
            ? null
            : {
                start: p.start,
                end: p.end,
                currentPeriodStart: active ? periodStart : null,
                currentPeriodEnd: active ? periodStart + p.period : null,
                spentRaw: spent.toString(),
                leftRaw: (active && p.allowance > spent ? p.allowance - spent : 0n).toString(),
                readAtBlock: 18_402_120,
                blockTime: now,
                phase: active ? 'active' : 'before_start',
                approved: limit.state === 'approved',
                revoked: false,
              },
          calendar: {
            periodStart: window.start,
            periodEnd: window.end,
            spentRaw: calendarSpent.toString(),
            leftRaw: (usable && cap > calendarSpent ? cap - calendarSpent : 0n).toString(),
            timeZone: 'Europe/Berlin',
          },
          revoke: limit.revoke,
        };
      }),
    };
  };
  const revokeOperation = (limit: FixtureLimit): UserOperation<'0.6'> => {
    const call = revokeCall(WALLET_CHAIN_ID, limit.permission);
    return {
      sender: WALLET,
      nonce: 3n,
      initCode: '0x',
      callData: encodeFunctionData({
        abi: walletAbi,
        functionName: 'execute',
        args: [call.target, call.value, call.data],
      }),
      callGasLimit: 120_000n,
      verificationGasLimit: 300_000n,
      preVerificationGas: 60_000n,
      maxFeePerGas: 2_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      paymasterAndData: SPONSOR_DATA,
      signature: '0x',
    };
  };

  await page.route('**/api/base/agents/*/wallet/limits**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (state.off) return route.fulfill({ status: 404, json: { error: 'Unknown API route' } });
    if (method === 'GET') return route.fulfill({ json: view() });
    if (path.endsWith('/limits/prepare')) {
      state.prepares += 1;
      const body = route.request().postDataJSON() as { capRaw: string; period: LimitPeriod };
      const cap = BigInt(body.capRaw);
      const permission: SpendPermission = {
        account: WALLET,
        spender: getAddress(state.preparedSpender),
        token: USDC,
        allowance: state.tamper ? cap : onchainAllowance(cap, state.model),
        period: LIMIT_PERIOD_SECONDS[body.period],
        // 00:00 Berlin today, as the server prepares it: the limit works at once.
        start: berlinDayStart(Date.now()),
        end: LIMIT_PERMISSION_END,
        salt: BigInt(`0x${randomBytes(32).toString('hex')}`),
        extraData: '0x',
      };
      state.prepared = permission;
      const hash = spendPermissionHash(WALLET_CHAIN_ID, permission);
      return route.fulfill({
        json: {
          chainId: WALLET_CHAIN_ID,
          token: 'USDC',
          capRaw: body.capRaw,
          capDisplay: display(cap),
          onchainModel: state.model,
          allowanceRaw: permission.allowance.toString(),
          allowanceDisplay: display(permission.allowance),
          boundaryBurstRaw: (permission.allowance * 2n).toString(),
          period: body.period,
          periodSeconds: permission.period,
          permission: permissionToJson(permission),
          permissionHash: hash,
          typedData: smartWalletMessageTypedData(WALLET_CHAIN_ID, WALLET, hash),
          expiresAt: Date.now() + 600_000,
        },
      });
    }
    if (path.endsWith('/limits')) {
      const body = route.request().postDataJSON() as {
        permission: unknown;
        capRaw: string;
        period: LimitPeriod;
        signature: Hex;
      };
      const permission = permissionFromJson(body.permission);
      const prepared = state.prepared;
      const hash = permission ? spendPermissionHash(WALLET_CHAIN_ID, permission) : null;
      // Exactly the prepared permission, signed by the owner key over the wallet's wrapper.
      const valid =
        !!permission &&
        !!prepared &&
        hash === spendPermissionHash(WALLET_CHAIN_ID, prepared) &&
        (await verifyTypedData({
          address: state.owner,
          ...smartWalletMessageTypedData(WALLET_CHAIN_ID, WALLET, hash!),
          signature: body.signature,
        }));
      state.signatures.push({ kind: 'limit', valid });
      if (!valid || !permission)
        return route.fulfill({
          status: 422,
          json: {
            error: 'Not signed by the owner key of this wallet.',
            code: 'signature_mismatch',
          },
        });
      state.limit = {
        permission,
        capRaw: body.capRaw,
        period: body.period,
        model: state.model,
        state: 'signed',
        revoke: null,
      };
      return route.fulfill({
        status: 201,
        json: { ...summary(state.limit), start: permission.start, end: permission.end },
      });
    }
    const limit = state.limit;
    if (!limit) return route.fulfill({ status: 404, json: { error: 'Not found.' } });
    if (path.endsWith('/revoke')) {
      // The agent is blocked at once; the owner operation comes back to sign.
      limit.state = 'revoke_pending';
      const op = revokeOperation(limit);
      state.revokeHash = ownerOperationHash(op);
      limit.revoke = {
        state: 'awaiting_signature',
        userOpHash: state.revokeHash,
        txHash: null,
        expiresAt: Date.now() + 600_000,
      };
      return route.fulfill({
        json: {
          permissionId: LIMIT_ID,
          state: 'revoke_pending',
          revokeState: 'awaiting_signature',
          chainId: WALLET_CHAIN_ID,
          entryPoint: NETWORK.contracts.entryPointV06,
          userOperation: userOperationToRpc(op),
          userOpHash: state.revokeHash,
          expiresAt: Date.now() + 600_000,
          summary: {
            action: 'revoke_limit',
            wallet: WALLET,
            contract: NETWORK.contracts.spendPermissionManager,
            permissionHash: spendPermissionHash(WALLET_CHAIN_ID, limit.permission),
            token: 'USDC',
            capRaw: limit.capRaw,
            allowanceRaw: limit.permission.allowance.toString(),
            period: limit.period,
            deploysWallet: false,
          },
        },
      });
    }
    if (path.endsWith('/revoke/signature')) {
      const { signature } = route.request().postDataJSON() as { signature: Hex };
      const signer = await recoverAddress({ hash: state.revokeHash, signature });
      state.signatures.push({ kind: 'revoke', valid: signer === state.owner, signer });
      limit.revoke = {
        state: 'submitted',
        userOpHash: state.revokeHash,
        txHash: null,
        expiresAt: null,
      };
      return route.fulfill({
        status: 202,
        json: { permissionId: LIMIT_ID, state: 'revoke_pending', revoke: limit.revoke },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'Not found.' } });
  });

  /** A limit already in force: 20 USDC a day under the half model, started three days ago. */
  const seed = (overrides: Partial<FixtureLimit> = {}) => {
    const model = overrides.model ?? 'half';
    state.limit = {
      permission: {
        account: WALLET,
        spender: SPENDER,
        token: USDC,
        allowance: onchainAllowance(20_000_000n, model),
        period: LIMIT_PERIOD_SECONDS.day,
        start: nextBerlinMidnight(Date.now()) - 3 * 86_400,
        end: LIMIT_PERMISSION_END,
        salt: 42n,
        extraData: '0x',
      },
      capRaw: '20000000',
      period: 'day',
      model,
      state: 'approved',
      revoke: null,
      ...overrides,
    };
    state.calendarSpentRaw = '6000000';
    state.onchainSpentRaw = '4000000';
  };
  return Object.assign(state, { seed });
}

async function openWallet(page: Page, theme = 'light') {
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
  await panel.locator('[data-k="row-wallet"]').click();
  await expect(panel.getByRole('heading', { name: 'Wallet' })).toBeVisible();
  return panel;
}

async function openLimits(page: Page, theme = 'light') {
  const panel = await openWallet(page, theme);
  await panel.locator('[data-k="row-limit"]').click();
  await expect(panel.getByRole('heading', { name: 'Spending limit' })).toBeVisible();
  return panel;
}

async function shot(page: Page, name: string) {
  const dir = process.env.MY_AGENTS_SHOTS;
  if (!dir) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/limits-${name}.png` });
}

async function toReview(panel: ReturnType<Page['getByRole']>, cap = '20', period = 'A day') {
  await panel.getByLabel('Limit in USDC').fill(cap);
  await panel.getByRole('radio', { name: period }).click();
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
}

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('set a limit: checked in the browser, signed by the owner key over the wallet’s typed data', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const server = await limitsServer(page);
  const wallet = await openWallet(page);
  await expect(wallet.locator('[data-k="row-limit"]')).toContainText('None');
  await wallet.locator('[data-k="row-limit"]').click();
  const panel = wallet;
  await expect(panel.getByText('Set the most Research scout may spend')).toBeVisible();

  // Three decimals are caught before anything is prepared.
  await toReview(panel, '20.001');
  await expect(panel.getByRole('alert')).toContainText('up to 2 decimals');
  expect(server.prepares).toBe(0);

  await toReview(panel, '20');
  await expect(panel.getByRole('heading', { name: 'Check and sign' })).toBeVisible();
  await expect(panel).toContainText('Your limit: 20.00 USDC a day');
  await expect(panel.locator('[data-k="enforced"]')).toHaveText(
    'Base enforces 10.00 USDC per Base day, so even around midnight Research scout stays within 20.00.',
  );
  await expect(panel).toContainText('Base days start at 00:00 Berlin time (');
  await expect(panel.locator('[data-k="works-now"]')).toHaveText(
    'Research scout can use it as soon as you sign.',
  );
  await expect(panel).toContainText('Central City’s counter resets at midnight (Berlin time).');
  if (WALLET_CHAIN_ID !== 8453) await expect(panel).toContainText('test network, no real money');
  await expect(panel.locator('[data-k="checked"]')).toHaveText(
    'Checked in this browser: the limit you sign is exactly this.',
  );
  await shot(page, 'review-1440-light');
  // No key confirmed in this browser yet: the review says to check it.
  await expect(panel.locator('[data-k="spender"]')).toContainText(SPENDER);
  await expect(panel.locator('[data-k="spender"]')).toContainText('First limit in this browser');
  await expect(panel.locator('[data-k="spender-changed"]')).toHaveCount(0);

  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Sign', exact: true }).click();
  const card = panel.locator('[data-k="limit-card"]');
  await expect(card).toContainText('20.00 USDC a day', { timeout: 20_000 });
  await expect(card.locator('.w4-state')).toHaveText('Signed · waiting for its first use on Base.');
  // It works at once: Base's first day is today, with its whole allowance left.
  const base = panel.locator('[data-k="base-period"]');
  await expect(base).toContainText('This Base day');
  await expect(base).toContainText('0.00 spent · 10.00 left');
  await expect(base).not.toContainText('Base starts counting');
  await expect(panel.locator('[data-k="calendar"]')).toContainText(
    'Used today: 0.00 of 20.00 · resets at midnight (Berlin time)',
  );
  // One signature, by the owner key, over the wallet's wrapper of exactly the prepared permission.
  expect(server.signatures).toEqual([{ kind: 'limit', valid: true }]);
  expect(server.prepared!.start).toBe(berlinDayStart(Date.now()));
  await expect(panel.getByLabel('Wallet password')).toHaveValue('');
});

test('the spending key the owner confirmed here: a changed one needs an explicit confirmation', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const server = await limitsServer(page);
  const before = getAddress(`0x${'77'.repeat(20)}`);
  // This browser confirmed another key before; the server now answers SPENDER in both places.
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    `cc-spender:${WALLET_CHAIN_ID}:${WALLET.toLowerCase()}`,
    before,
  ] as const);
  const panel = await openLimits(page);
  await toReview(panel);
  const changed = panel.locator('[data-k="spender-changed"]');
  await expect(changed).toContainText('The spending key changed since you confirmed it here.');
  await expect(changed).toContainText(before);
  await expect(changed).toContainText(SPENDER);
  await shot(page, 'review-spender-changed');
  await panel.getByLabel('Wallet password').fill(password);
  const sign = panel.getByRole('button', { name: 'Sign', exact: true });
  await expect(sign).toBeDisabled();
  await changed.getByLabel('I confirm the new spending key').check();
  await expect(sign).toBeEnabled();
  await sign.click();
  await expect(panel.locator('[data-k="limit-card"]')).toContainText('20.00 USDC a day', {
    timeout: 20_000,
  });
  expect(server.signatures).toEqual([{ kind: 'limit', valid: true }]);
  // From now on this browser holds the new key.
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      `cc-spender:${WALLET_CHAIN_ID}:${WALLET.toLowerCase()}`,
    ),
  ).toBe(SPENDER);
});

test('the confirmed key is kept before sending: a lost answer keeps it, full storage sends nothing', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const server = await limitsServer(page);
  const pinKey = `cc-spender:${WALLET_CHAIN_ID}:${WALLET.toLowerCase()}`;
  // Full site storage at signing: no signature reaches the server.
  let panel = await openLimits(page);
  await toReview(panel);
  await panel.getByLabel('Wallet password').fill(password);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    };
  });
  await panel.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('so nothing was sent', { timeout: 20_000 });
  expect(server.signatures).toHaveLength(0);
  // A signature whose answer is lost: the key the owner confirmed is already kept.
  await page.reload();
  await page.route('**/api/base/agents/*/wallet/limits', (route) =>
    route.request().method() === 'POST' ? route.abort('failed') : route.fallback(),
  );
  panel = await openLimits(page);
  await toReview(panel);
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate((key) => localStorage.getItem(key), pinKey)).toBe(SPENDER);
});

test('a full-model limit is refused: on Base it is half the cap (the product owner’s decision)', async ({
  page,
}) => {
  const server = await limitsServer(page);
  server.model = 'full';
  const panel = await openLimits(page);
  await toReview(panel, '20', 'A week');
  await expect(panel.getByRole('alert')).toHaveText(
    'Not signed: The limit uses a different on-chain cap than this page allows.',
  );
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  expect(server.signatures).toHaveLength(0);
});

test('a limit that lets another key spend, or with no spending key known, is refused', async ({
  page,
}) => {
  const server = await limitsServer(page);
  // Another spender, with the permission's hash recomputed for it.
  server.preparedSpender = getAddress(`0x${'99'.repeat(20)}`);
  let panel = await openLimits(page);
  await toReview(panel);
  await expect(panel.getByRole('alert')).toHaveText(
    'Not signed: The limit lets a different key spend than this agent’s.',
  );
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  // The wallet route doesn't say which key the agent spends with.
  server.preparedSpender = SPENDER;
  server.control.spender = null;
  panel = await openLimits(page);
  await toReview(panel);
  await expect(panel.getByRole('alert')).toHaveText(
    'Not signed: This page can’t tell which key the agent spends with.',
  );
  expect(server.signatures).toHaveLength(0);
});

test('a tampered allowance is refused, and the password is never asked', async ({ page }) => {
  const server = await limitsServer(page);
  server.tamper = true;
  const panel = await openLimits(page);
  await toReview(panel);
  await expect(panel.getByRole('alert')).toHaveText(
    'Not signed: Base would allow a different amount than your limit.',
  );
  await expect(panel.getByRole('heading', { name: 'Spending limit' })).toBeVisible();
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  expect(server.prepares).toBe(1);
  expect(server.signatures).toHaveLength(0);
});

test('a limit in force: the calendar count with its bar, Base’s period, the state', async ({
  page,
}) => {
  const server = await limitsServer(page);
  server.seed();
  const wallet = await openWallet(page);
  await expect(wallet.locator('[data-k="row-limit"]')).toContainText('20.00 USDC a day');
  await shot(page, 'wallet-row-1440-light');
  await wallet.locator('[data-k="row-limit"]').click();
  const panel = wallet;
  const card = panel.locator('[data-k="limit-card"]');
  await expect(card).toContainText('20.00 USDC a day');
  await expect(card).toContainText(
    'Base enforces 10.00 USDC per Base day, so even around midnight Research scout stays within 20.00.',
  );
  await expect(card.locator('.w4-state')).toHaveText('Approved on Base.');
  const calendar = panel.locator('[data-k="calendar"]');
  await expect(calendar).toContainText(
    'Used today: 6.00 of 20.00 · resets at midnight (Berlin time)',
  );
  await expect(calendar.getByRole('meter')).toHaveAttribute('aria-valuenow', '30');
  const base = panel.locator('[data-k="base-period"]');
  await expect(base).toContainText('This Base day');
  await expect(base).toContainText('4.00 spent · 6.00 left');
  await expect(base).toContainText('block 18,402,120');
  await expect(panel.getByRole('button', { name: 'Revoke', exact: true })).toBeVisible();
  await shot(page, 'card-1440-light');
});

test('a limit signed before 14 Oct 2026 starts at the next midnight: the card says when', async ({
  page,
}) => {
  const server = await limitsServer(page);
  server.seed({ state: 'signed' });
  server.limit!.permission = { ...server.limit!.permission, start: nextBerlinMidnight(Date.now()) };
  server.onchainSpentRaw = '0';
  server.calendarSpentRaw = '0';
  const panel = await openLimits(page);
  // Before its first Base day: when Base starts counting, never zeros invented for it.
  const base = panel.locator('[data-k="base-period"]');
  await expect(base).toContainText('Base starts counting');
  await expect(base).not.toContainText('spent ·');
});

test('Base can’t be read: it says so and shows no numbers for Base', async ({ page }) => {
  const server = await limitsServer(page);
  server.seed();
  server.stale = true;
  const panel = await openLimits(page);
  await expect(panel.locator('[data-k="base-unread"]')).toContainText(
    'Couldn’t read Base just now.',
  );
  await expect(panel.locator('[data-k="base-period"]')).toHaveCount(0);
  await expect(panel).not.toContainText('spent ·');
  // Central City's own count still shows.
  await expect(panel.locator('[data-k="calendar"]')).toContainText('Used today: 6.00 of 20.00');
  // Base answers again: Try again reads it.
  server.stale = false;
  await panel.getByRole('button', { name: 'Try again' }).click();
  await expect(panel.locator('[data-k="base-period"]')).toContainText('4.00 spent · 6.00 left');
});

test('revoke: blocked at once, checked, signed with the owner key, then Revoking…', async ({
  page,
}) => {
  test.skip(
    !SIGNABLE,
    'No sponsor is pinned on the wallet network yet; this runs once wallets are on Base.',
  );
  test.setTimeout(60_000);
  const server = await limitsServer(page);
  server.seed();
  const panel = await openLimits(page);
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Revoke', exact: true }).click();
  const status = panel.locator('[data-k="limit-card"] .w4-state');
  await expect(status).toHaveText(
    'Revoking… Research scout’s spends are blocked now; the revoke is on its way to Base.',
    { timeout: 20_000 },
  );
  // One raw-hash signature, by the owner key, over the operation the browser recomputed.
  expect(server.signatures).toEqual([{ kind: 'revoke', valid: true, signer: server.owner }]);
  await expect(panel.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0);
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
});

test('a server without limits: the wallet shows no Spending limit row, never Coming soon', async ({
  page,
}) => {
  const server = await limitsServer(page);
  server.off = true;
  const wallet = await openWallet(page);
  await expect(wallet.getByRole('button', { name: 'Add funds' })).toBeVisible();
  await expect(wallet.getByText('Spending limit', { exact: true })).toHaveCount(0);
  await expect(wallet.getByText('Coming soon', { exact: true })).toHaveCount(0);
  await expect(wallet.locator('[data-k="row-limit"]')).toHaveCount(0);
});

for (const screen of ['review', 'card'] as const)
  test(`the ${screen} at 390 px (dark): no sideways scroll`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const server = await limitsServer(page);
    if (screen === 'card') server.seed();
    const panel = await openLimits(page, 'dark');
    if (screen === 'review') {
      await toReview(panel, '20');
      await expect(panel).toContainText('Your limit: 20.00 USDC a day');
      await panel.getByLabel('Wallet password').scrollIntoViewIfNeeded();
    } else {
      await expect(panel.locator('[data-k="calendar"]')).toContainText('Used today: 6.00 of 20.00');
    }
    expect(await noSidewaysScroll(page)).toBe(true);
    await shot(page, `${screen}-390-dark`);
  });

test('where no sponsor is pinned, a revoke signs nothing (its fee could fall on the wallet)', async ({
  page,
}) => {
  test.skip(SIGNABLE, 'A sponsor is pinned on this network.');
  const server = await limitsServer(page);
  server.seed();
  const panel = await openLimits(page);
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('approved sponsor', { timeout: 20_000 });
  expect(server.signatures).toEqual([]);
});

test('hidden while the limit is being signed: the signature is dropped, nothing is sent', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const server = await limitsServer(page);
  const panel = await openWallet(page);
  await panel.locator('[data-k="row-limit"]').click();
  await toReview(panel, '20');
  await panel.getByLabel('Wallet password').fill(password);
  let release = () => {};
  server.control.vaultHold = new Promise<void>((resolve) => (release = resolve));
  await panel.getByRole('button', { name: 'Sign', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(panel.getByLabel('Wallet password')).toHaveValue('');
  server.control.vaultHold = null;
  release();
  await expect(panel.getByRole('alert')).toContainText('nothing was sent', { timeout: 20_000 });
  expect(server.signatures).toEqual([]);
});
