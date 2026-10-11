import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { encodeFunctionData, getAddress, parseAbi, recoverAddress, type Hex } from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import type { Agent, Snapshot } from '../shared/types';
import {
  noopCall,
  ownerOperationHash,
  userOperationToRpc,
  withdrawalCall,
  WITHDRAWAL_CHAIN_ID,
  WITHDRAWAL_ENTRY_POINT,
  type OwnerCallEncoding,
} from '../shared/base/withdraw';
import { laneNonce } from '../shared/base/lanes';
import { sealKey } from '../src/base/vault/crypto';
import { expectedWallet } from '../src/base/wallet/derive';
import { privateKeyToAccount } from 'viem/accounts';
import { BASE_MAINNET } from '../shared/base/chains';
import { SPONSOR_PAYMASTERS } from '../shared/base/paymasters';

/*
 * Withdraw from an agent's wallet (Operation Base Wallet W2). The withdrawal routes are fixtures in
 * the shapes of server/base/wallet/withdrawals.ts, with real operations and hashes; the owner key is
 * a real locked key the browser unlocks, and the fixture checks every signature recovers to it.
 */

const headers = { 'X-City-Request': '1' };
const password = 'Local-test-only-passphrase-2026';
const NOW = Date.now();
const TO = getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc');
const ELSEWHERE = getAddress(`0x${'4d'.repeat(20)}`);
const walletAbi = parseAbi(['function execute(address target, uint256 value, bytes data)']);
/** The pinned sponsor's data (shared/base/paymasters.ts layout: no token, 65-byte signature). */
const SPONSOR_DATA = `0x${SPONSOR_PAYMASTERS[BASE_MAINNET]![0]!.slice(2)}${Math.floor(
  (NOW + 600_000) / 1000,
)
  .toString(16)
  .padStart(12, '0')}${'00'.repeat(103)}${'ab'.repeat(65)}` as Hex;
/** Nothing can be signed where no sponsor is pinned (Base Sepolia today): those tests wait for Base. */
const SIGNABLE = (SPONSOR_PAYMASTERS[WITHDRAWAL_CHAIN_ID] ?? []).length > 0;
const NOT_YET =
  'No sponsor is pinned on the wallet network yet; this runs once wallets are on Base.';

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
/** A wallet that isn't the one the owner key makes for the agent. */
const SUBSTITUTED = getAddress(`0x${'9e'.repeat(20)}`);

const amount = (raw: bigint, decimals: number, display: string) => ({
  raw: raw.toString(),
  decimals,
  display,
});

function operation(call: OwnerCallEncoding, nonce: bigint, sender = WALLET): UserOperation<'0.6'> {
  return {
    sender,
    nonce,
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
}

async function withdrawServer(page: Page) {
  const owner = { privateKey: OWNER_KEY, address: OWNER };
  const envelope = await sealKey(owner.privateKey, password, { N: 2 ** 17 });
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Withdraw-${randomUUID().slice(0, 8)}`, password },
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
    /** The wallet reports another owner key than the vault's (an agent's identity wallet). */
    otherOwner: false,
    /** The wallet route (and every operation) names a wallet the owner key doesn't make. */
    substituted: false,
  };
  /**
   * The wallet the routes answer: a substituted address; with another owner, that owner's own
   * derived wallet (consistent, so only the unlocked key can tell); else the owner key's wallet.
   */
  const walletAnswered = () =>
    control.substituted
      ? SUBSTITUTED
      : control.otherOwner
        ? expectedWallet(ELSEWHERE, scout.id)
        : WALLET;
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
        chainId: WITHDRAWAL_CHAIN_ID,
        network: WITHDRAWAL_CHAIN_ID === 8453 ? 'Base' : 'Base Sepolia',
        testnet: WITHDRAWAL_CHAIN_ID !== 8453,
        address: walletAnswered(),
        ownerAddress: control.otherOwner ? ELSEWHERE : owner.address,
        deployed: true,
        fundingLocked: false,
        usdc: amount(25_000_000n, 6, '25'),
        eth: amount(1_200_000_000_000_000n, 18, '0.0012'),
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
    /** The fixture prepares a different destination than asked. */
    tamper: false,
    /** The summary names this address while the operation sends where asked. */
    summaryTo: null as string | null,
    /** The next signature is taken, but its answer never arrives. */
    loseAnswer: false,
    /** One withdrawal (signed elsewhere) is on its way: creating another is refused. */
    pending: false,
    /**
     * Reads report these in turn, then the last one: a state, `:safe` / `:unsafe` for the server's
     * `safe` (none: an older server's answer), or '404'. Each withdrawal takes a copy.
     */
    progress: ['submitted', 'included', 'final'] as string[],
    /** Each withdrawal prepared, by id: its hash, what is read for it, and whether it was signed. */
    ops: {} as Record<
      string,
      {
        hash: Hex;
        progress: string[];
        signed: boolean;
        /** Lanes: its operation, amount and order, and its own cancel once asked. */
        op?: UserOperation<'0.6'>;
        amount?: bigint;
        createdAt?: number;
        cancel?: { op: UserOperation<'0.6'>; hash: Hex; signed: boolean };
      }
    >,
    /** Lanes (CITY_BASE_LANES=1): each withdrawal in its own nonce lane, and the open list. */
    lanes: false,
    /** Lanes: what each next withdrawal is read as, in turn (else `progress`). */
    progressQueue: [] as string[][],
    /** Reads of the open list, and of single withdrawals. */
    openReads: 0,
    reads: 0,
    /** Unsigned withdrawals the browser discarded. */
    discarded: [] as string[],
    /** Each create's idempotency key and amount, in order. */
    asked: [] as Array<{ idempotencyKey: string; amount: string }>,
    /** The body each idempotency key was first used with (another body is refused, as on the server). */
    keys: new Map<string, string>(),
    signatures: [] as Array<{ path: string; signer: string }>,
    creates: 0,
    hash: '0x' as Hex,
    cancelHash: '0x' as Hex,
    cancelAsked: false,
    cancelSigned: false,
    /** Every cancel asked (POST …/cancel), signed or not. */
    cancelPosts: 0,
    /** The next signatures are taken, but answered with these statuses (a broken answer). */
    signatureFails: [] as number[],
  };
  /** A withdrawal as the routes report it; `entry` as in `progress`, `posted` for a POST answer. */
  const view = (id: string, entry: string, posted = false) => {
    const [withdrawalState, safe] = entry.split(':') as [string, string | undefined];
    // The GET read's `safe`: final, or as the entry says; a POST answer's only when final.
    const safeField = posted
      ? { safe: withdrawalState === 'final' }
      : withdrawalState === 'final'
        ? { safe: true }
        : safe
          ? { safe: safe === 'safe' }
          : {};
    return { ...answer(id, withdrawalState), ...safeField };
  };
  const answer = (id: string, withdrawalState: string) => ({
    withdrawalId: id,
    state: withdrawalState,
    token: 'USDC',
    amount: amount(state.ops[id]?.amount ?? 12_500_000n, 6, '12.5'),
    from: WALLET,
    to: TO,
    network: WITHDRAWAL_CHAIN_ID === 8453 ? 'Base' : 'Base Sepolia',
    chainId: WITHDRAWAL_CHAIN_ID,
    userOpHash: state.ops[id]?.hash ?? state.hash,
    sponsored: true,
    fee: { paidBy: 'sponsor', token: 'ETH', max: amount(0n, 18, '0') },
    txHash: withdrawalState === 'submitted' ? null : `0x${'ee'.repeat(32)}`,
    blockNumber: withdrawalState === 'submitted' ? null : 18_402_200,
    errorCode: null,
    explorerUrl:
      withdrawalState === 'submitted'
        ? null
        : `https://sepolia.basescan.org/tx/0x${'ee'.repeat(32)}`,
    expiresAt: null,
    cancel: state.lanes
      ? laneCancel(id)
      : state.cancelAsked
        ? {
            state: state.cancelSigned ? 'submitted' : 'awaiting_signature',
            userOpHash: state.cancelHash,
            userOperation: state.cancelSigned
              ? null
              : userOperationToRpc(operation(noopCall(WALLET), 7n)),
            entryPoint: WITHDRAWAL_ENTRY_POINT,
            expiresAt: NOW + 600_000,
            sponsored: true,
            fee: { paidBy: 'sponsor', token: 'ETH', max: amount(0n, 18, '0') },
            txHash: null,
            explorerUrl: null,
          }
        : null,
    createdAt: state.ops[id]?.createdAt ?? NOW,
    updatedAt: Date.now(),
  });
  /** Lanes: a withdrawal's own cancel, once asked. */
  const laneCancel = (id: string) => {
    const cancel = state.ops[id]?.cancel;
    if (!cancel) return null;
    return {
      state: cancel.signed ? 'submitted' : 'awaiting_signature',
      userOpHash: cancel.hash,
      userOperation: cancel.signed ? null : userOperationToRpc(cancel.op),
      entryPoint: WITHDRAWAL_ENTRY_POINT,
      expiresAt: NOW + 600_000,
      sponsored: true,
      fee: { paidBy: 'sponsor', token: 'ETH', max: amount(0n, 18, '0') },
      txHash: null,
      explorerUrl: null,
    };
  };
  /** The next state a withdrawal is read in (the last one stays). */
  const advance = (op: (typeof state.ops)[string]) =>
    op.progress.length > 1 ? op.progress.shift()! : op.progress[0]!;
  const OPEN = ['awaiting_signature', 'submitted', 'included', 'cancel_pending'];
  await page.route('**/api/base/agents/*/wallet/withdrawals**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    // Lanes: the wallet's open operations, newest first, in one read.
    if (
      method === 'GET' &&
      url.pathname.endsWith('/withdrawals') &&
      url.searchParams.get('open') === '1'
    ) {
      // Only while lanes are on, as on the server; otherwise as if the route weren't there.
      if (!state.lanes) return route.fulfill({ status: 404, json: { error: 'Not found.' } });
      state.openReads += 1;
      const withdrawals = Object.keys(state.ops)
        .map((id) => ({
          id,
          entry: state.ops[id]!.signed ? advance(state.ops[id]!) : 'awaiting_signature',
        }))
        .filter(({ entry }) => OPEN.includes(entry.split(':')[0]!))
        .reverse()
        .map(({ id, entry }) => view(id, entry));
      return route.fulfill({ json: { withdrawals } });
    }
    if (method === 'POST' && url.pathname.endsWith('/withdrawals')) {
      state.creates += 1;
      if (state.pending)
        return route.fulfill({
          status: 409,
          json: {
            error: 'One withdrawal is already on its way.',
            code: 'operation_pending',
            details: { withdrawalId: 'w-elsewhere' },
          },
        });
      const body = route.request().postDataJSON() as {
        token: 'USDC';
        amount: string;
        to: string;
        idempotencyKey: string;
      };
      const { idempotencyKey, ...asked } = body;
      state.asked.push({ idempotencyKey, amount: body.amount });
      const first = state.keys.get(idempotencyKey);
      if (first !== undefined && first !== JSON.stringify(asked))
        return route.fulfill({
          status: 409,
          json: {
            error: 'This idempotencyKey was used for another withdrawal.',
            code: 'idempotency_conflict',
          },
        });
      state.keys.set(idempotencyKey, JSON.stringify(asked));
      const id = `w-${Object.keys(state.ops).length + 1}`;
      // With lanes, in the withdrawal's own nonce lane; else the wallet's next sequential nonce.
      const op = operation(
        withdrawalCall('USDC', state.tamper ? ELSEWHERE : getAddress(body.to), BigInt(body.amount)),
        state.lanes ? laneNonce(id) : 7n + BigInt(Object.keys(state.ops).length),
        walletAnswered(),
      );
      state.hash = ownerOperationHash(op);
      state.ops[id] = {
        hash: state.hash,
        progress: [...((state.lanes && state.progressQueue.shift()) || state.progress)],
        signed: false,
        op,
        amount: BigInt(body.amount),
        createdAt: Date.now(),
      };
      return route.fulfill({
        status: 201,
        json: {
          withdrawalId: id,
          state: 'awaiting_signature',
          userOperation: userOperationToRpc(op),
          userOpHash: state.hash,
          entryPoint: WITHDRAWAL_ENTRY_POINT,
          chainId: WITHDRAWAL_CHAIN_ID,
          expiresAt: NOW + 600_000,
          summary: {
            kind: 'withdraw',
            token: 'USDC',
            amount: amount(BigInt(body.amount), 6, '12.5'),
            from: walletAnswered(),
            to: state.summaryTo ?? getAddress(body.to),
            network: WITHDRAWAL_CHAIN_ID === 8453 ? 'Base' : 'Base Sepolia',
            testnet: WITHDRAWAL_CHAIN_ID !== 8453,
            sponsored: true,
            fee: { paidBy: 'sponsor', token: 'ETH', max: amount(0n, 18, '0') },
            deploysWallet: false,
            toIsContract: false,
          },
          ...(state.lanes ? { lanes: true } : {}),
        },
      });
    }
    const id = decodeURIComponent(url.pathname.split('/withdrawals/')[1]!.split('/')[0]!);
    const op = state.ops[id];
    if (!op)
      return route.fulfill({ status: 404, json: { error: 'Not found.', code: 'not_found' } });
    if (method === 'POST' && url.pathname.endsWith('/cancel')) state.cancelPosts += 1;
    // Lanes: a signed withdrawal's cancel is the no-op at exactly its nonce, signed on its own.
    if (state.lanes && method === 'POST' && url.pathname.endsWith('/cancel') && op.signed) {
      const noop = operation(noopCall(WALLET), op.op!.nonce);
      op.cancel = { op: noop, hash: ownerOperationHash(noop), signed: false };
      return route.fulfill({ json: view(id, 'submitted', true) });
    }
    if (state.lanes && method === 'POST' && url.pathname.endsWith('/cancel/signature')) {
      const { signature } = route.request().postDataJSON() as { signature: Hex };
      state.signatures.push({
        path: url.pathname,
        signer: await recoverAddress({ hash: op.cancel!.hash, signature }),
      });
      op.cancel!.signed = true;
      op.progress = ['cancel_pending', 'cancelled'];
      return route.fulfill({ status: 202, json: view(id, 'cancel_pending', true) });
    }
    if (method === 'POST' && url.pathname.endsWith('/cancel')) {
      // Never signed: discarded, as on the server.
      if (!op.signed) {
        state.discarded.push(id);
        op.progress = ['expired'];
        return route.fulfill({ json: view(id, 'expired', true) });
      }
      state.cancelAsked = true;
      state.cancelHash = ownerOperationHash(operation(noopCall(WALLET), 7n));
      return route.fulfill({ json: view(id, 'submitted', true) });
    }
    if (method === 'POST' && url.pathname.endsWith('/signature')) {
      const { signature } = route.request().postDataJSON() as { signature: Hex };
      const cancel = url.pathname.endsWith('/cancel/signature');
      const signer = await recoverAddress({
        hash: cancel ? state.cancelHash : op.hash,
        signature,
      });
      state.signatures.push({ path: url.pathname, signer });
      if (cancel) state.cancelSigned = true;
      else op.signed = true;
      if (state.loseAnswer) {
        state.loseAnswer = false;
        return route.abort('failed');
      }
      const fail = cancel ? undefined : state.signatureFails.shift();
      if (fail) return route.fulfill({ status: fail, body: 'Upstream answer lost.' });
      return route.fulfill({
        status: 202,
        json: view(id, cancel ? 'cancel_pending' : op.progress[0]!, true),
      });
    }
    // GET: the next state, then stay on the last one.
    state.reads += 1;
    const next = state.cancelSigned ? 'cancel_pending' : advance(op);
    if (next === '404')
      return route.fulfill({ status: 404, json: { error: 'Not found.', code: 'not_found' } });
    return route.fulfill({ json: view(id, next) });
  });
  return state;
}

async function openWithdraw(page: Page) {
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
    .getByRole('list', { name: 'Agents', exact: true })
    .getByRole('button', { name: /^Research scout, / })
    .click();
  const panel = page.getByRole('complementary', { name: 'Research scout details' });
  await panel.locator('[data-k="row-wallet"]').click();
  await panel.getByRole('button', { name: 'Withdraw', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Withdraw' })).toBeVisible();
  await shot(page, 'withdraw-form');
  return panel;
}

async function shot(page: Page, name: string) {
  const dir = process.env.MY_AGENTS_SHOTS;
  if (!dir) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/${name}.png` });
}

async function fillForm(panel: ReturnType<Page['getByRole']>, to = TO.toLowerCase()) {
  await panel.getByLabel('Amount in USDC').fill('12.50');
  await panel.getByLabel('To address on Base').fill(to);
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
}

test('withdraw: checked in the browser, signed with the owner key, then the steps on Base', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await withdrawServer(page);
  const panel = await openWithdraw(page);
  // A typo in the address is caught before anything is prepared.
  await panel.getByLabel('Amount in USDC').fill('12.50');
  await panel.getByLabel('To address on Base').fill('0x3c44');
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('isn’t a valid address');
  expect(server.creates).toBe(0);

  await fillForm(panel);
  await expect(panel.getByRole('heading', { name: 'Check and sign' })).toBeVisible();
  await expect(panel).toContainText('12.50 USDC');
  await expect(panel).toContainText(TO);
  await expect(panel).toContainText('Covered by Central City');
  if (WITHDRAWAL_CHAIN_ID !== 8453)
    await expect(panel).toContainText('test network, no real money');
  await expect(panel.locator('[data-k="checked"]')).toContainText('Checked in this browser');
  await expect(panel.getByText('Withdrawals can’t be undone.')).toBeVisible();
  await shot(page, 'withdraw-review');

  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Sign and send', exact: true }).click();
  const steps = panel.getByRole('list', { name: 'Withdrawal status' });
  await expect(steps.locator('li[data-done]')).toHaveCount(4, { timeout: 20_000 });
  await expect(steps).toContainText('In block 18,402,200');
  // Final, and it reads done.
  await expect(panel.locator('.w4-sent-head')).toHaveText('Withdrawn ✓');
  await expect(panel.getByRole('link', { name: 'View on Basescan' })).toBeVisible();
  await shot(page, 'withdraw-final');
  // One signature, by the owner key, over the hash the browser recomputed.
  expect(server.signatures).toHaveLength(1);
  expect(server.signatures[0]!.signer).toBe(server.owner);
  // The password is gone from the page.
  await expect(panel.locator('input[type="password"]')).toHaveCount(0);
});

test("a wallet the owner key doesn't make for this agent signs nothing", async ({ page }) => {
  const server = await withdrawServer(page);
  server.control.substituted = true;
  // The Wallet screen already refuses to show it; Withdraw opened from its own link checks again.
  await page.goto(`/agents?workspace=v2&theme=light#agent=${scout.id}:wallet-withdraw`);
  const panel = page.getByRole('complementary', { name: 'Research scout details' });
  await expect(panel.getByRole('heading', { name: 'Withdraw' })).toBeVisible();
  await fillForm(panel);
  await expect(panel.getByRole('alert')).toHaveText(
    'Not signed: This isn’t the wallet your wallet key makes for this agent.',
  );
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  expect(server.signatures).toHaveLength(0);
});

test('an operation that sends elsewhere is refused, and the password is never asked', async ({
  page,
}) => {
  const server = await withdrawServer(page);
  server.tamper = true;
  const panel = await openWithdraw(page);
  await fillForm(panel);
  // Refused before the password is asked (on Base: the other destination; where no sponsor is
  // pinned yet, already the fee).
  await expect(panel.getByRole('alert')).toHaveText(
    SIGNABLE
      ? 'Not signed: The operation sends to a different address.'
      : /^Not signed: The network fee isn’t covered by the approved sponsor/,
  );
  await expect(panel.getByRole('heading', { name: 'Withdraw' })).toBeVisible();
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  expect(server.signatures).toHaveLength(0);
});

test('a wrong password signs nothing; a withdrawal not in a block yet can be cancelled', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await withdrawServer(page);
  server.progress = ['submitted'];
  const panel = await openWithdraw(page);
  await fillForm(panel);
  await panel.getByLabel('Wallet password').fill('Not-the-right-passphrase-1');
  await panel.getByRole('button', { name: 'Sign and send', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible({ timeout: 15_000 });
  expect(server.signatures).toHaveLength(0);
  // A failed signing leaves no password on the page.
  await expect(panel.getByLabel('Wallet password')).toHaveValue('');

  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Sign and send', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Cancel this withdrawal' })).toBeVisible({
    timeout: 15_000,
  });
  // The password field shows only once the owner chooses to cancel.
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Cancel this withdrawal' }).click();
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Sign the cancel' }).click();
  await expect(panel.getByRole('status')).toContainText('Cancelling', { timeout: 15_000 });
  expect(server.signatures.map((entry) => entry.signer)).toEqual([server.owner, server.owner]);
  expect(server.signatures[1]!.path).toMatch(/\/cancel\/signature$/);
});

test('the page hidden while a cancel is asked: the late answer signs nothing', async ({ page }) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await withdrawServer(page);
  server.progress = ['submitted'];
  const panel = await openWithdraw(page);
  await fillForm(panel);
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Sign and send', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Cancel this withdrawal' })).toBeVisible({
    timeout: 15_000,
  });
  // The server's answer to "cancel" is held until the page has been hidden (the password lock).
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let asked = false;
  await page.route(/\/withdrawals\/[^/]+\/cancel$/, async (route) => {
    asked = true;
    await held;
    await route.fallback();
  });
  await panel.getByRole('button', { name: 'Cancel this withdrawal' }).click();
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Sign the cancel' }).click();
  await expect.poll(() => asked, { timeout: 10_000 }).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  release();
  // The cancel's no-op arrived after the lock: nothing signed, nothing sent.
  await expect.poll(() => server.cancelAsked, { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(1_500);
  expect(server.signatures).toHaveLength(1);
  expect(server.signatures.some((entry) => /\/cancel\/signature$/.test(entry.path))).toBe(false);
});

test('where no sponsor is pinned, nothing is signed: the fee could fall on the wallet', async ({
  page,
}) => {
  test.skip(SIGNABLE, 'A sponsor is pinned on this network.');
  const server = await withdrawServer(page);
  const panel = await openWithdraw(page);
  await fillForm(panel);
  await expect(panel.getByRole('alert')).toHaveText(
    'Not signed: The network fee isn’t covered by the approved sponsor; the wallet could be charged.',
  );
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  expect(server.creates).toBe(1);
  expect(server.signatures).toHaveLength(0);
});

test('hidden while the signature is being made: it is dropped, nothing is sent', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await withdrawServer(page);
  const panel = await openWithdraw(page);
  await fillForm(panel);
  await panel.getByLabel('Wallet password').fill(password);
  let release = () => {};
  server.control.vaultHold = new Promise<void>((resolve) => (release = resolve));
  await panel.getByRole('button', { name: 'Sign and send', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Signing…' })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // The password is gone at once; when the unlock answers, nothing is sent.
  await expect(panel.getByLabel('Wallet password')).toHaveValue('');
  server.control.vaultHold = null;
  release();
  await expect(panel.getByRole('alert')).toContainText('nothing was sent', { timeout: 20_000 });
  expect(server.signatures).toHaveLength(0);
});

test('after a reload the screen returns to the withdrawal on its way; its cancel stays bound', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await withdrawServer(page);
  server.progress = ['submitted'];
  let panel = await openWithdraw(page);
  await fillForm(panel);
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Sign and send', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Cancel this withdrawal' })).toBeVisible({
    timeout: 20_000,
  });
  // A reload: Withdraw opens on the same withdrawal, not on a new form.
  panel = await openWithdraw(page);
  await expect(panel.getByRole('button', { name: 'Cancel this withdrawal' })).toBeVisible();
  // The password field shows only once the owner chooses to cancel.
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Cancel this withdrawal' }).click();
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Sign the cancel' }).click();
  await expect(panel.getByRole('status')).toContainText('Cancelling', { timeout: 15_000 });
  expect(server.signatures.map((entry) => entry.signer)).toEqual([server.owner, server.owner]);
});

test('the confirm screen shows the checked operation: a summary naming another address signs nothing', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  const server = await withdrawServer(page);
  // The operation sends where asked; only the server's summary says elsewhere.
  server.summaryTo = ELSEWHERE;
  const panel = await openWithdraw(page);
  await fillForm(panel);
  await expect(panel.getByRole('alert')).toHaveText(
    'Not signed: The server’s summary doesn’t match the operation.',
  );
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  await expect(panel).not.toContainText(ELSEWHERE);
  expect(server.signatures).toHaveLength(0);
});

test('a signature whose answer is lost stays anchored: reopening returns to that withdrawal', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await withdrawServer(page);
  server.progress = ['submitted'];
  server.loseAnswer = true;
  let panel = await openWithdraw(page);
  await fillForm(panel);
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Sign and send', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByLabel('Wallet password')).toHaveValue('');
  expect(server.signatures).toHaveLength(1);
  // The anchor was kept before the signature left: Withdraw reopens on it, its cancel bound.
  panel = await openWithdraw(page);
  await expect(panel.getByRole('list', { name: 'Withdrawal status' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Cancel this withdrawal' })).toBeVisible();
});

test('a withdrawal signed in another browser: this one neither replaces nor cancels it', async ({
  page,
}) => {
  const server = await withdrawServer(page);
  server.pending = true;
  const panel = await openWithdraw(page);
  await fillForm(panel);
  await expect(panel.getByRole('alert')).toHaveText(
    'One withdrawal is still on its way. Wait for it, or cancel it in the browser that signed it.',
  );
  await expect(panel.getByRole('button', { name: 'Cancel this withdrawal' })).toHaveCount(0);
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  expect(server.signatures).toHaveLength(0);
});

test('a browser that can’t keep the withdrawal’s record sends nothing', async ({ page }) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await withdrawServer(page);
  const panel = await openWithdraw(page);
  await fillForm(panel);
  await panel.getByLabel('Wallet password').fill(password);
  // Site storage full from here on: the anchor can't be kept.
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    };
  });
  await panel.getByRole('button', { name: 'Sign and send', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('so nothing was sent', { timeout: 20_000 });
  await expect(panel.getByLabel('Wallet password')).toHaveValue('');
  expect(server.signatures).toHaveLength(0);
});

test('a wallet another key owns: the unlocked key signs nothing', async ({ page }) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await withdrawServer(page);
  server.control.otherOwner = true;
  // The Wallet screen refuses it (not the vault's key); Withdraw from its own link checks again.
  await page.goto(`/agents?workspace=v2&theme=light#agent=${scout.id}:wallet-withdraw`);
  const panel = page.getByRole('complementary', { name: 'Research scout details' });
  await expect(panel.getByRole('heading', { name: 'Withdraw' })).toBeVisible();
  await fillForm(panel);
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Sign and send', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText(
    'Not signed: Your wallet key isn’t this wallet’s owner, so nothing was signed.',
    { timeout: 20_000 },
  );
  await expect(panel.getByLabel('Wallet password')).toHaveValue('');
  expect(server.signatures).toHaveLength(0);
});

/** The anchor this browser keeps for the scout's wallet (src/base/wallet/withdraw.ts). */
const anchorOf = (page: Page) =>
  page.evaluate(
    (id) =>
      JSON.parse(localStorage.getItem(`cc-withdrawal:${id}`) ?? 'null') as {
        withdrawalId: string;
      } | null,
    scout.id,
  );

async function withdrawNow(panel: ReturnType<Page['getByRole']>) {
  await fillForm(panel);
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Sign and send', exact: true }).click();
}

const reopen = async (page: Page) => {
  // A real new page load: going to the URL the app already shows only changes the hash, so the
  // screen would not open again and the old one would carry on polling (a CI flake).
  await page.goto('about:blank');
  await page.goto(`/agents?workspace=v2&theme=light#agent=${scout.id}:wallet-withdraw`);
  const panel = page.getByRole('complementary', { name: 'Research scout details' });
  await expect(panel.getByRole('heading', { name: 'Withdraw' })).toBeVisible();
  return panel;
};

test('settled at Base’s safe head: “Sent · awaiting finality”, a new withdrawal, done only at final', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(90_000);
  const server = await withdrawServer(page);
  server.progress = ['submitted', 'included:safe'];
  let panel = await openWithdraw(page);
  await withdrawNow(panel);
  const head = panel.locator('.w4-sent-head');
  await expect(head).toHaveText('Sent · awaiting finality', { timeout: 20_000 });
  await expect(panel).toContainText('Final in about 15 minutes.');
  await expect(panel.getByRole('list', { name: 'Withdrawal status' })).toHaveCount(0);
  await expect(panel).not.toContainText('Withdrawn');
  await expect(panel.getByRole('button', { name: /^Cancel/ })).toHaveCount(0);
  expect(await anchorOf(page)).toBeNull();
  await shot(page, 'withdraw-sent-safe');

  await panel.getByRole('button', { name: 'New withdrawal', exact: true }).click();
  await expect(panel.getByLabel('Amount in USDC')).toHaveValue('');
  await expect(panel.getByLabel('To address on Base')).toHaveValue('');
  const line = panel.getByRole('list', { name: 'Sent from this wallet' });
  await expect(line).toHaveText('12.50 USDC to 0x3C44…93BC · Sent · awaiting finality');

  // A reload: the form, never that withdrawal reopened as on its way.
  panel = await reopen(page);
  await expect(panel.getByLabel('To address on Base')).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Withdrawal status' })).toHaveCount(0);
  await expect(line).toContainText('Sent · awaiting finality');

  server.ops['w-1']!.progress = ['final'];
  await expect(line).toHaveText('12.50 USDC to 0x3C44…93BC · Withdrawn ✓', { timeout: 20_000 });
});

test('a withdrawal in a block without safe (an older server): the screen is as it was', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await withdrawServer(page);
  server.progress = ['submitted', 'included'];
  const panel = await openWithdraw(page);
  await withdrawNow(panel);
  const steps = panel.getByRole('list', { name: 'Withdrawal status' });
  await expect(steps.locator('li[data-done]')).toHaveCount(3, { timeout: 20_000 });
  await expect(steps.locator('li:not([data-done])')).toHaveText('Final');
  await expect(panel.locator('.w4-sent-head')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'New withdrawal' })).toHaveCount(0);
  expect((await anchorOf(page))?.withdrawalId).toBe('w-1');
});

test('a withdrawal safe, then not: what the server says now, never a stale “Sent”', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await withdrawServer(page);
  server.progress = ['included:safe', 'included:unsafe'];
  const panel = await openWithdraw(page);
  await withdrawNow(panel);
  await expect(panel.locator('.w4-sent-head')).toHaveText('Sent · awaiting finality', {
    timeout: 20_000,
  });
  const steps = panel.getByRole('list', { name: 'Withdrawal status' });
  await expect(steps).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator('.w4-sent-head')).toHaveCount(0);
  await expect(panel).not.toContainText('awaiting finality');
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('Back, then a changed amount: the unsigned withdrawal is discarded, the next has a new key', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  const server = await withdrawServer(page);
  const panel = await openWithdraw(page);
  await fillForm(panel);
  await expect(panel.getByRole('heading', { name: 'Check and sign' })).toBeVisible();
  await panel.getByRole('button', { name: 'Back', exact: true }).click();
  await panel.getByLabel('Amount in USDC').fill('10');
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Check and sign' })).toBeVisible();
  await expect(panel).toContainText('10.00 USDC');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect(server.discarded).toEqual(['w-1']);
  expect(server.asked.map((each) => each.amount)).toEqual(['12500000', '10000000']);
  expect(server.asked[1]!.idempotencyKey).not.toBe(server.asked[0]!.idempotencyKey);
});

test('a withdrawal the server no longer knows: its anchor goes and the form says so', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await withdrawServer(page);
  server.progress = ['submitted'];
  let panel = await openWithdraw(page);
  await withdrawNow(panel);
  await expect(panel.getByRole('button', { name: 'Cancel this withdrawal' })).toBeVisible({
    timeout: 20_000,
  });
  server.ops['w-1']!.progress = ['404'];
  panel = await reopen(page);
  await expect(panel.getByRole('status')).toHaveText(
    'The withdrawal signed here earlier can’t be found any more, so it isn’t shown.',
  );
  await expect(panel.getByLabel('To address on Base')).toBeVisible();
  expect(await anchorOf(page)).toBeNull();
});

test('reopened on a withdrawal already final: an empty form and a quiet “Withdrawn ✓”', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const server = await withdrawServer(page);
  await openWithdraw(page);
  const op = operation(withdrawalCall('USDC', TO, 12_500_000n), 3n);
  const hash = ownerOperationHash(op);
  server.ops['w-earlier'] = { hash, progress: ['final'], signed: true };
  await page.evaluate(([id, value]) => localStorage.setItem(`cc-withdrawal:${id}`, value), [
    scout.id,
    JSON.stringify({
      withdrawalId: 'w-earlier',
      userOperation: userOperationToRpc(op),
      userOpHash: hash,
    }),
  ] as const);
  const panel = await reopen(page);
  await expect(panel.getByLabel('Amount in USDC')).toHaveValue('', { timeout: 20_000 });
  await expect(panel.getByLabel('To address on Base')).toHaveValue('');
  await expect(panel.getByRole('list', { name: 'Sent from this wallet' })).toHaveText(
    '12.50 USDC to 0x3C44…93BC · Withdrawn ✓',
    { timeout: 20_000 },
  );
  await expect(panel.getByRole('list', { name: 'Withdrawal status' })).toHaveCount(0);
  await expect(panel.locator('.w4-sent-head')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'New withdrawal' })).toHaveCount(0);
  expect(await anchorOf(page)).toBeNull();
});

/* ---------- lanes (CITY_BASE_LANES=1): withdraw without waiting ---------- */

async function withdrawAmount(panel: ReturnType<Page['getByRole']>, usdc: string) {
  await panel.getByLabel('Amount in USDC').fill(usdc);
  await panel.getByLabel('To address on Base').fill(TO.toLowerCase());
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Sign and send', exact: true }).click();
}

/** Back on an empty form, right after signing: nothing waits for the withdrawal. */
async function expectEmptyForm(panel: ReturnType<Page['getByRole']>) {
  await expect(panel.getByRole('heading', { name: 'Withdraw' })).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByLabel('Amount in USDC')).toHaveValue('');
  await expect(panel.getByLabel('To address on Base')).toHaveValue('');
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  await expect(panel.getByRole('list', { name: 'Withdrawal status' })).toHaveCount(0);
}

const historyLine = (panel: ReturnType<Page['getByRole']>, id: string) =>
  panel.getByRole('list', { name: 'History' }).locator(`li[data-id="${id}"] [data-k="line"]`);

/** Every text each History line showed, in order (to see each move on by itself). */
async function watchHistory(page: Page) {
  await page.evaluate(() => {
    const seen: Record<string, string[]> = {};
    (window as unknown as { seenLines: typeof seen }).seenLines = seen;
    const record = () => {
      for (const line of document.querySelectorAll('li[data-id] [data-k="line"]')) {
        const id = line.closest('li')!.getAttribute('data-id')!;
        const text = line.textContent ?? '';
        const list = (seen[id] ??= []);
        if (list[list.length - 1] !== text) list.push(text);
      }
    };
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}
const seenLines = (page: Page) =>
  page.evaluate(() => (window as unknown as { seenLines: Record<string, string[]> }).seenLines);
/** The last text a History line showed (it may have left the list since). */
const lastSeen = async (page: Page, id: string) => (await seenLines(page))[id]?.at(-1) ?? null;

test('lanes: three withdrawals in a row without waiting, one cancelled while the others go on', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(150_000);
  const server = await withdrawServer(page);
  server.lanes = true;
  server.progressQueue = [
    ['submitted', 'included:safe', 'included:safe', 'final'],
    ['submitted'],
    ['submitted', 'submitted', 'included:safe', 'final'],
  ];
  let panel = await openWithdraw(page);
  await watchHistory(page);
  for (const [at, usdc] of ['1', '2', '3'].entries()) {
    await withdrawAmount(panel, usdc);
    await expectEmptyForm(panel);
    const lines = panel.getByRole('list', { name: 'History' }).locator('li');
    await expect(lines).toHaveCount(at + 1);
    await expect(lines.first()).toHaveAttribute('data-id', `w-${at + 1}`);
    // Below the form: the form comes first, the rows under it.
    const form = await panel.getByLabel('To address on Base').boundingBox();
    const row = await lines.first().boundingBox();
    expect(row!.y).toBeGreaterThan(form!.y);
  }
  expect(new Set(server.asked.map((each) => each.idempotencyKey)).size).toBe(3);
  expect(await anchorOf(page)).toBeNull();
  await shot(page, 'withdraw-lanes-three');

  // Cancel the second, from its line; the password only once cancel is picked.
  const second = panel.getByRole('list', { name: 'History' }).locator('li[data-id="w-2"]');
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  await second.getByRole('button', { name: 'Cancel 2.00 USDC to 0x3C44…93BC' }).click();
  await second.getByLabel('Wallet password').fill(password);
  await second.getByRole('button', { name: 'Sign the cancel' }).click();
  await expect
    .poll(() => lastSeen(page, 'w-2'), { timeout: 30_000 })
    .toBe('2.00 USDC to 0x3C44…93BC · Cancelled');
  expect(server.signatures).toHaveLength(4);
  expect(server.signatures[3]!.path).toMatch(/w-2\/cancel\/signature$/);
  expect(server.signatures[3]!.signer).toBe(server.owner);
  expect(server.ops['w-2']!.cancel!.op.nonce).toBe(server.ops['w-2']!.op!.nonce);
  // The others went on by themselves.
  await expect
    .poll(() => lastSeen(page, 'w-1'), { timeout: 30_000 })
    .toBe('1.00 USDC to 0x3C44…93BC · Withdrawn ✓');
  await expect
    .poll(() => lastSeen(page, 'w-3'), { timeout: 30_000 })
    .toBe('3.00 USDC to 0x3C44…93BC · Withdrawn ✓');
  // Each moved on by itself through the status screens' words.
  const seen = await seenLines(page);
  expect(seen['w-3']).toContain('3.00 USDC to 0x3C44…93BC · Sent · awaiting finality');
  // Once final, each row leaves for the wallet's own history: the list empties by itself.
  await expect(panel.getByRole('list', { name: 'History' })).toHaveCount(0, { timeout: 40_000 });
  await expect(panel.getByLabel('To address on Base')).toHaveValue('');

  // Reopened: nothing open is left, so the form, with no History lines held over.
  panel = await reopen(page);
  await expect(panel.getByLabel('To address on Base')).toBeVisible();
  await expect(panel.getByRole('list', { name: 'History' })).toHaveCount(0);
});

for (const status of [502, 500])
  test(`lanes: a signature taken but answered ${status}: the withdrawal stays tracked, nothing cancelled or made again`, async ({
    page,
  }) => {
    test.skip(!SIGNABLE, NOT_YET);
    test.setTimeout(120_000);
    const server = await withdrawServer(page);
    server.lanes = true;
    server.progressQueue = [
      ['submitted', 'submitted', 'submitted', 'submitted', 'included:safe', 'final'],
    ];
    server.signatureFails = [status];
    const panel = await openWithdraw(page);
    await watchHistory(page);
    await withdrawAmount(panel, '1');
    await expectEmptyForm(panel);
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(
      panel.getByRole('button', { name: 'Cancel 1.00 USDC to 0x3C44…93BC' }),
    ).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => lastSeen(page, 'w-1'), { timeout: 60_000 })
      .toBe('1.00 USDC to 0x3C44…93BC · Withdrawn ✓');
    expect(server.creates).toBe(1);
    expect(server.cancelPosts).toBe(0);
    expect(server.discarded).toEqual([]);
    expect(server.signatures).toHaveLength(1);
    expect(await anchorOf(page)).toBeNull();
  });

test('lanes: reopened while on their way, the lines come from the server’s open list', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(90_000);
  const server = await withdrawServer(page);
  server.lanes = true;
  server.progressQueue = [['submitted'], ['submitted']];
  let panel = await openWithdraw(page);
  await withdrawAmount(panel, '1');
  await expectEmptyForm(panel);
  await withdrawAmount(panel, '2');
  await expectEmptyForm(panel);
  panel = await reopen(page);
  await expect(panel.getByLabel('To address on Base')).toBeVisible();
  await expect(historyLine(panel, 'w-1')).toHaveText('1.00 USDC to 0x3C44…93BC · On its way');
  await expect(historyLine(panel, 'w-2')).toHaveText('2.00 USDC to 0x3C44…93BC · On its way');
  // Signed here: each can still be cancelled from its line, after the reload.
  await expect(panel.getByRole('button', { name: /^Cancel \d/ })).toHaveCount(2);
  const reads = server.reads;
  await page.waitForTimeout(7_000);
  expect(server.reads).toBe(reads);
});

test('lanes: the cap from the server and funds held are refused in plain words', async ({
  page,
}) => {
  const server = await withdrawServer(page);
  server.lanes = true;
  let refusal: { code: string; details?: unknown } | null = null;
  await page.route('**/api/base/agents/*/wallet/withdrawals', (route) =>
    refusal && route.request().method() === 'POST'
      ? route.fulfill({
          status: 409,
          json: { error: 'Refused.', code: refusal.code, details: refusal.details },
        })
      : route.fallback(),
  );
  const panel = await openWithdraw(page);
  refusal = { code: 'too_many_open', details: { max: 100 } };
  await fillForm(panel);
  await expect(panel.getByRole('alert')).toHaveText(
    '100 payments and withdrawals are still on their way. Wait for one to finish.',
  );
  refusal = { code: 'funds_held', details: { open: 4 } };
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText(
    'Not enough USDC while 4 payments and withdrawals are still on their way.',
  );
  refusal = { code: 'sponsor_busy', details: { retryAfterSeconds: 60 } };
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText('Busy right now. Try again in a minute.');
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  expect(server.signatures).toHaveLength(0);
});
