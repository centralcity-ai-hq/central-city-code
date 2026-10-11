import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  parseAbi,
  recoverAddress,
  type Hex,
} from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import type { Agent, Snapshot } from '../shared/types';
import {
  ownerOperationHash,
  userOperationToRpc,
  WITHDRAWAL_CHAIN_ID,
  WITHDRAWAL_ENTRY_POINT,
} from '../shared/base/withdraw';
import { BASE_MAINNET } from '../shared/base/chains';
import { SPONSOR_PAYMASTERS } from '../shared/base/paymasters';
import { encodeRateCall, RATE_REGISTRY, type RatingGiven, type Stars } from '../shared/base/rate';
import { sealKey } from '../src/base/vault/crypto';
import { expectedWallet } from '../src/base/wallet/derive';
import { privateKeyToAccount } from 'viem/accounts';

/*
 * Rate another Central City agent on Base (Operation Rating R2). The ratings routes are fixtures
 * in the shapes of shared/base/rate.ts (the lookup, then the rating answered as a withdrawal is),
 * with real operations and hashes; the withdrawal routes report its way to Base. Base's public
 * endpoint is a fixture too, for the browser's own read of tokenURI(Base ID). The owner key is a
 * real locked key; the fixture checks each signature.
 */

const headers = { 'X-City-Request': '1' };
const password = 'Local-test-only-passphrase-2026';
const NOW = Date.now();
const MAINNET = WITHDRAWAL_CHAIN_ID === BASE_MAINNET;
const NETWORK_NAME = MAINNET ? 'Base' : 'Base Sepolia';
const HARBOR = { agentId: 'agent-harbor', baseId: '12345', short: 'Ab3dE9', name: 'Harbor' };
/** A second agent, for the owner who goes back and picks another one. */
const LIGHTHOUSE = {
  agentId: 'agent-lighthouse',
  baseId: '23456',
  short: 'Qz7pLm',
  name: 'Lighthouse',
};
/** An agent rated before (the product owner's first real rating). */
const MISCHKE = { agentId: 'agent-mischke', baseId: '34567', short: 'Mk5sXa', name: 'Mischke' };
const RATER = { baseId: '98840', short: 'Wm4tRk' };
const SPONSOR_DATA =
  `0x${SPONSOR_PAYMASTERS[BASE_MAINNET]![0]!.slice(2)}${'00'.repeat(109)}${'ab'.repeat(65)}` as Hex;
/** Nothing can be signed where no sponsor is pinned: those tests wait for wallets on Base. */
const SIGNABLE = (SPONSOR_PAYMASTERS[WITHDRAWAL_CHAIN_ID] ?? []).length > 0;
const NOT_YET = 'No sponsor is pinned on the wallet network yet.';
const tokenUriAbi = parseAbi(['function tokenURI(uint256 tokenId) view returns (string)']);

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

/** A fixed synthetic owner key; the scout's wallet is the one it makes, as in production. */
const OWNER_KEY = `0x${'4c'.repeat(32)}` as Hex;
const OWNER = privateKeyToAccount(OWNER_KEY).address;
const WALLET = expectedWallet(OWNER, scout.id);

const amount = (raw: bigint, decimals: number, display: string) => ({
  raw: raw.toString(),
  decimals,
  display,
});

function operation(baseId: string, stars: Stars): UserOperation<'0.6'> {
  return {
    sender: getAddress(WALLET),
    nonce: 5n,
    initCode: '0x',
    callData: encodeRateCall(BigInt(baseId), stars),
    callGasLimit: 120_000n,
    verificationGasLimit: 300_000n,
    preVerificationGas: 60_000n,
    maxFeePerGas: 2_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    paymasterAndData: SPONSOR_DATA,
    signature: '0x',
  };
}

type Refusal = { status: number; code?: string; error?: string; details?: unknown };

/** A response held back until the test releases it. */
function gate() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

async function rateServer(page: Page) {
  const envelope = await sealKey(OWNER_KEY, password, { N: 2 ** 17 });
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Rate-${randomUUID().slice(0, 8)}`, password },
  });
  expect(registered.status()).toBe(201);
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
  await page.route('**/api/base/vault', (route) =>
    route.fulfill({
      json: {
        accountId: person,
        exists: true,
        ownerAddress: OWNER,
        ...envelope,
        version: 1,
        backupConfirmedAt: NOW,
        challenge: { nonce: `0x${'ab'.repeat(32)}`, expiresAt: NOW + 300_000 },
      },
    }),
  );
  await page.route('**/api/base/agents/*/wallet', (route) =>
    route.fulfill({
      json: {
        chainId: WITHDRAWAL_CHAIN_ID,
        network: NETWORK_NAME,
        testnet: !MAINNET,
        address: WALLET,
        ownerAddress: OWNER,
        deployed: true,
        fundingLocked: false,
        usdc: amount(400_000n, 6, '0.4'),
        eth: amount(0n, 18, '0'),
        readAtBlock: 52_462_283,
        readAt: Date.now(),
        stale: false,
        explorerUrl: null,
      },
    }),
  );
  await page.route('**/api/base/agents/*/wallet/history*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Not found.' } }),
  );
  await page.route('**/api/base/pay/incoming*', (route) =>
    route.fulfill({ json: { payments: [], cursor: null, hasMore: false } }),
  );

  const state = {
    /** The scout's own registration: final with a passport, or not (yet). */
    rater: 'final' as 'final' | 'finalizing' | 'none',
    /** The ratings routes answer 404 (switched off). */
    off: false,
    lookupRefusal: null as Refusal | null,
    createRefusal: null as Refusal | null,
    /** The lookup answers another Base ID than the one typed. */
    answerOther: false,
    /** The prepared rating gives other stars, or rates another agent, than asked. */
    tamper: null as null | 'stars' | 'agent',
    /** The passport Base has at the Base ID; null: Base doesn't answer. */
    baseUri: `https://centralcity.ai/a/${HARBOR.short}` as string | null,
    baseReads: 0,
    lookups: [] as Array<Record<string, unknown>>,
    ratings: [] as Array<{ to: unknown; stars: number; idempotencyKey: string }>,
    signatures: [] as Array<{ path: string; signer: string }>,
    hash: '0x' as Hex,
    /** Each prepared rating's hash, by its withdrawalId. */
    hashes: {} as Record<string, Hex>,
    /** Holds the create answer (the prepared rating) while set; `answered` counts the answers. */
    holdCreate: null as Promise<void> | null,
    answered: 0,
    /** Holds Base's tokenURI answer for this Base ID while set; `heldBase` counts the held reads. */
    holdBase: null as { baseId: string; until: Promise<void> } | null,
    heldBase: 0,
    /** The signature route refuses with this while set (it was received: it's in `signatures`). */
    signRefusal: null as Refusal | null,
    /** Cancels asked (an unsigned rating discarded), by withdrawalId. */
    cancels: [] as string[],
    /** Holds the answer to a signature while set (it was received: it's in `signatures`). */
    holdSignature: null as Promise<void> | null,
    /** What the withdrawal route reports for the rating now. */
    now: { state: 'submitted', safe: false } as { state: string; safe?: boolean },
    /** What GET …/wallet/ratings lists (the ratings this wallet made), newest first. */
    given: [] as RatingGiven[],
    /** Reads of that list, and of each rating on the withdrawal route, by withdrawalId. */
    listReads: 0,
    withdrawalReads: [] as string[],
  };

  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({
      json: {
        identities:
          state.rater === 'none'
            ? []
            : [
                {
                  chainId: BASE_MAINNET,
                  state: state.rater === 'final' ? 'confirmed' : 'submitted',
                  stage: state.rater === 'final' ? 'confirmed' : 'finalizing',
                  erc8004AgentId: RATER.baseId,
                  agentUri: `https://centralcity.ai/a/${RATER.short}`,
                  finality: state.rater === 'final' ? 'final' : 'included',
                },
              ],
      },
    }),
  );

  // Base's public endpoint, as this browser reads it: the head, then tokenURI at it.
  await page.route('https://mainnet.base.org/**', async (route) => {
    const call = route.request().postDataJSON() as {
      id: number;
      method: string;
      params: Array<{ data?: Hex }>;
    };
    if (state.baseUri === null) return route.abort('failed');
    if (call.method === 'eth_blockNumber')
      return route.fulfill({ json: { jsonrpc: '2.0', id: call.id, result: '0x3203b10' } });
    state.baseReads += 1;
    const baseId = String(
      decodeFunctionData({ abi: tokenUriAbi, data: call.params[0]!.data! }).args[0],
    );
    const hold = state.holdBase;
    if (hold && hold.baseId === baseId) {
      state.heldBase += 1;
      await hold.until;
    }
    return route.fulfill({
      json: {
        jsonrpc: '2.0',
        id: call.id,
        result: encodeFunctionResult({
          abi: tokenUriAbi,
          functionName: 'tokenURI',
          result:
            baseId === LIGHTHOUSE.baseId
              ? `https://centralcity.ai/a/${LIGHTHOUSE.short}`
              : baseId === MISCHKE.baseId
                ? `https://centralcity.ai/a/${MISCHKE.short}`
                : state.baseUri,
        }),
      },
    });
  });

  const refuse = (route: Parameters<Parameters<Page['route']>[1]>[0], refusal: Refusal) =>
    route.fulfill({
      status: refusal.status,
      json: {
        error: refusal.error ?? 'Refused.',
        ...(refusal.code ? { code: refusal.code } : {}),
        ...(refusal.details ? { details: refusal.details } : {}),
      },
    });

  await page.route('**/api/base/agents/*/wallet/ratings/lookup', (route) => {
    const body = route.request().postDataJSON() as { baseId: string; passport: string };
    state.lookups.push(body);
    if (state.off) return refuse(route, { status: 404, error: 'Not found.' });
    if (state.lookupRefusal) return refuse(route, state.lookupRefusal);
    const agent = [LIGHTHOUSE, MISCHKE].find((one) => one.baseId === body.baseId) ?? HARBOR;
    return route.fulfill({
      json: {
        lookupId: `lk_${body.baseId}_${state.lookups.length}`,
        agent: {
          agentId: agent.agentId,
          name: agent.name,
          baseId: state.answerOther ? '12346' : body.baseId,
          short: body.passport,
        },
        checkedAtBlock: 52_441_231,
        expiresAt: Date.now() + 300_000,
      },
    });
  });

  await page.route('**/api/base/agents/*/wallet/ratings', async (route) => {
    // GET: the ratings this wallet made (shared/base/rate.ts RatingsGiven); 404 while off.
    if (route.request().method() === 'GET') {
      state.listReads += 1;
      if (state.off) return refuse(route, { status: 404, error: 'Not found.' });
      return route.fulfill({ json: { ratings: state.given } });
    }
    const body = route.request().postDataJSON() as {
      to: { lookupId: string };
      stars: Stars;
      idempotencyKey: string;
    };
    state.ratings.push(body);
    const withdrawalId = `w-rate-${state.ratings.length}`;
    const hold = state.holdCreate;
    if (hold) await hold;
    if (state.off) return refuse(route, { status: 404, error: 'Not found.' });
    if (state.createRefusal) return refuse(route, state.createRefusal);
    // The agent of the lookup the rating names (lk_<Base ID>_<n>).
    const looked = body.to.lookupId.split('_')[1]!;
    const baseId = state.tamper === 'agent' ? '12346' : looked;
    const stars = (
      state.tamper === 'stars' ? (body.stars === 5 ? 1 : body.stars + 1) : body.stars
    ) as Stars;
    const op = operation(baseId, stars);
    state.hash = ownerOperationHash(op);
    state.hashes[withdrawalId] = state.hash;
    state.answered += 1;
    return route.fulfill({
      status: 201,
      json: {
        withdrawalId,
        state: 'awaiting_signature',
        userOperation: userOperationToRpc(op),
        userOpHash: state.hash,
        entryPoint: WITHDRAWAL_ENTRY_POINT,
        chainId: WITHDRAWAL_CHAIN_ID,
        expiresAt: NOW + 600_000,
        // A consistent server: its summary says exactly the operation it prepared.
        summary: {
          kind: 'rate',
          registry: RATE_REGISTRY,
          agentId: baseId,
          value: String(stars * 20),
          tag1: 'starred',
          stars,
          from: WALLET,
          network: NETWORK_NAME,
          testnet: !MAINNET,
          sponsored: true,
          fee: { paidBy: 'sponsor', token: 'ETH', max: amount(0n, 18, '0') },
          deploysWallet: false,
        },
      },
    });
  });

  const view = (withdrawalId: string) => ({
    withdrawalId,
    state: state.now.state,
    ...(state.now.safe === undefined ? {} : { safe: state.now.safe }),
    token: 'ETH',
    amount: amount(0n, 18, '0'),
    from: WALLET,
    to: RATE_REGISTRY,
    network: NETWORK_NAME,
    chainId: WITHDRAWAL_CHAIN_ID,
    userOpHash: state.hashes[withdrawalId] ?? state.hash,
    sponsored: true,
    fee: { paidBy: 'sponsor', token: 'ETH', max: amount(0n, 18, '0') },
    txHash: state.now.state === 'submitted' ? null : `0x${'ee'.repeat(32)}`,
    blockNumber: state.now.state === 'submitted' ? null : 52_462_300,
    errorCode: null,
    explorerUrl:
      state.now.state === 'submitted' ? null : `https://basescan.org/tx/0x${'ee'.repeat(32)}`,
    expiresAt: null,
    cancel: null,
    createdAt: NOW,
    updatedAt: Date.now(),
  });

  await page.route('**/api/base/agents/*/wallet/withdrawals/**', async (route) => {
    const url = new URL(route.request().url());
    const withdrawalId = decodeURIComponent(url.pathname.split('/withdrawals/')[1]!.split('/')[0]!);
    if (route.request().method() === 'GET') state.withdrawalReads.push(withdrawalId);
    if (route.request().method() === 'POST' && url.pathname.endsWith('/signature')) {
      const { signature } = route.request().postDataJSON() as { signature: Hex };
      state.signatures.push({
        path: url.pathname,
        signer: await recoverAddress({
          hash: state.hashes[withdrawalId] ?? state.hash,
          signature,
        }),
      });
      const hold = state.holdSignature;
      if (hold) await hold;
      if (state.signRefusal) return refuse(route, state.signRefusal);
      return route.fulfill({ status: 202, json: view(withdrawalId) });
    }
    if (route.request().method() === 'POST' && url.pathname.endsWith('/cancel')) {
      state.cancels.push(withdrawalId);
      return route.fulfill({ json: { ...view(withdrawalId), state: 'expired' } });
    }
    return route.fulfill({ json: view(withdrawalId) });
  });
  return state;
}

async function openWallet(page: Page) {
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
  await expect(panel.getByRole('button', { name: 'Pay', exact: true })).toBeVisible();
  return panel;
}

async function openRate(page: Page) {
  const panel = await openWallet(page);
  await panel.getByRole('button', { name: 'Rate', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Rate an agent', exact: true })).toBeVisible();
  return panel;
}

type Panel = Awaited<ReturnType<typeof openWallet>>;

async function findHarbor(panel: Panel) {
  await panel.getByLabel('Base ID', { exact: true }).fill(HARBOR.baseId);
  await panel.getByLabel('Passport number', { exact: true }).fill(HARBOR.short);
  await expect(panel.getByRole('group', { name: 'Agent to rate' })).toBeVisible();
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Rate Harbor', exact: true })).toBeVisible();
}

async function rateHarbor(panel: Panel, stars = 4) {
  await panel
    .locator('.w4-pick-star')
    .nth(stars - 1)
    .click();
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Rate Harbor', exact: true }).click();
}

test('Rate shows only for a Central City agent on Base with a final Base ID and passport', async ({
  page,
}) => {
  const server = await rateServer(page);
  server.rater = 'finalizing';
  let panel = await openWallet(page);
  await expect(panel.getByRole('button', { name: 'Withdraw', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Rate', exact: true })).toHaveCount(0);

  server.rater = 'none';
  await page.reload();
  panel = await openWallet(page);
  await expect(panel.getByRole('button', { name: 'Rate', exact: true })).toHaveCount(0);

  server.rater = 'final';
  await page.reload();
  panel = await openWallet(page);
  await expect(panel.getByRole('button', { name: 'Rate', exact: true })).toBeVisible();
  // After Add funds, Withdraw and Pay.
  await expect(panel.locator('.ap4-actions').first().getByRole('button')).toHaveText([
    'Add funds',
    'Withdraw',
    'Pay',
    'Rate',
  ]);
});

test('both fields are required and checked for form before anything is looked up', async ({
  page,
}) => {
  const server = await rateServer(page);
  const panel = await openRate(page);
  const continueButton = panel.getByRole('button', { name: 'Continue', exact: true });
  await expect(panel).toContainText(
    'Rate another Central City agent on Base, from Research scout. Type its Base ID and its passport number: both must belong to the same Central City agent.',
  );
  await expect(panel).toContainText(
    'Both are on the agent’s passport. The passport number is the 6 characters after centralcity.ai/a/.',
  );
  const baseId = panel.getByLabel('Base ID', { exact: true });
  const passport = panel.getByLabel('Passport number', { exact: true });
  await expect(baseId).toHaveAttribute('aria-required', 'true');
  await expect(passport).toHaveAttribute('aria-required', 'true');

  await continueButton.click();
  await expect(panel.getByRole('alert')).toHaveText(
    'Type the agent’s Base ID and its passport number. Both are needed.',
  );
  await baseId.fill(HARBOR.baseId);
  await continueButton.click();
  await expect(panel.getByRole('alert')).toHaveText(
    'Type the agent’s Base ID and its passport number. Both are needed.',
  );
  await passport.fill(`centralcity.ai/a/${HARBOR.short}`);
  await continueButton.click();
  await expect(panel.getByRole('alert')).toHaveText(
    'A passport number is the 6 letters and digits after centralcity.ai/a/ (for example Ab3dE9).',
  );
  await passport.fill(HARBOR.short);
  await baseId.fill('012345');
  await continueButton.click();
  await expect(panel.getByRole('alert')).toHaveText(
    'A Base ID is a whole number above 0, digits only (for example 99515).',
  );
  expect(server.lookups).toHaveLength(0);
});

test('the agent found: both values match, read from Base; a mismatch is refused in one sentence', async ({
  page,
}) => {
  const server = await rateServer(page);
  const panel = await openRate(page);
  server.lookupRefusal = { status: 422, code: 'lookup_mismatch' };
  await panel.getByLabel('Base ID', { exact: true }).fill(HARBOR.baseId);
  await panel.getByLabel('Passport number', { exact: true }).fill(HARBOR.short);
  await expect(panel.getByRole('alert')).toHaveText(
    'This Base ID and passport number don’t belong to the same Central City agent. Check both on the agent’s passport.',
  );
  // An answer naming another Base ID than typed is refused the same way, by this browser.
  server.lookupRefusal = null;
  server.answerOther = true;
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText(
    'This Base ID and passport number don’t belong to the same Central City agent. Check both on the agent’s passport.',
  );
  server.answerOther = false;
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  const card = panel.getByRole('group', { name: 'Agent to rate' });
  await expect(card).toContainText('Harbor');
  await expect(card).toContainText('Base ID 12345 · Passport Ab3dE9');
  await expect(card).toContainText('✓ Base ID and passport match');
  await expect(card).toContainText('✓ Passport read from Base');
  expect(server.lookups.at(-1)).toEqual({ baseId: HARBOR.baseId, passport: HARBOR.short });
  expect(server.baseReads).toBeGreaterThan(0);

  // Base has another passport at that Base ID: refused, nothing to rate.
  server.baseUri = 'https://centralcity.ai/a/Zz9Yy8';
  await panel.getByLabel('Base ID', { exact: true }).fill('123450');
  await panel.getByLabel('Base ID', { exact: true }).fill(HARBOR.baseId);
  await expect(panel.getByRole('alert')).toHaveText(
    'Base doesn’t show this passport at that Base ID, so it can’t be rated. Nothing was signed.',
  );
  await expect(card).toHaveCount(0);
});

test('the stars are real radio buttons: click, arrow keys, and the words for each', async ({
  page,
}) => {
  await rateServer(page);
  const panel = await openRate(page);
  await findHarbor(panel);
  await expect(panel.getByRole('group', { name: 'Agent to rate' })).toContainText(
    'Base ID 12345 · Passport Ab3dE9 · from Research scout',
  );
  const group = panel.getByRole('radiogroup', { name: 'How was Harbor?' });
  await expect(group.getByRole('radio')).toHaveCount(5);
  await expect(panel).toContainText('Choose 1 to 5 stars.');
  const rate = panel.getByRole('button', { name: 'Rate Harbor', exact: true });
  await expect(rate).toBeDisabled();

  await panel.locator('.w4-pick-star').nth(2).click();
  await expect(group.getByRole('radio', { name: '3 stars' })).toBeChecked();
  await expect(panel).toContainText('3 of 5 · Good');
  await expect(panel.locator('.w4-pick .w4-star[data-on]')).toHaveCount(3);
  await page.keyboard.press('ArrowRight');
  await expect(group.getByRole('radio', { name: '4 stars' })).toBeChecked();
  await expect(group.getByRole('radio', { name: '4 stars' })).toBeFocused();
  await expect(panel).toContainText('4 of 5 · Very good');
  await page.keyboard.press('ArrowRight');
  await expect(panel).toContainText('5 of 5 · Excellent');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(group.getByRole('radio', { name: '1 star' })).toBeChecked();
  await expect(panel).toContainText('1 of 5 · Poor');
  await expect(panel.locator('.w4-pick .w4-star[data-on]')).toHaveCount(1);
  await panel.locator('.w4-pick-star').nth(1).click();
  await expect(panel).toContainText('2 of 5 · Fair');

  await expect(panel).toContainText(
    'Public on Base and stays there. Free: the fee is covered. One rating per agent counts, your latest.',
  );
  // Signing opens the wallet key with its password: without it, nothing can be rated.
  await expect(panel.getByLabel('Wallet password')).toBeVisible();
  await expect(rate).toBeDisabled();
  await panel.getByLabel('Wallet password').fill(password);
  await expect(rate).toBeEnabled();

  // Back to the agent's details, then on again: the stars stay.
  await panel.getByRole('button', { name: 'Rate an agent' }).click();
  await expect(panel.getByRole('heading', { name: 'Rate an agent', exact: true })).toBeVisible();
  await expect(panel.getByRole('group', { name: 'Agent to rate' })).toBeVisible();
});

test('a prepared rating with other stars or another agent signs nothing', async ({ page }) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await rateServer(page);
  const panel = await openRate(page);
  await findHarbor(panel);
  server.tamper = 'stars';
  await rateHarbor(panel, 4);
  await expect(panel.getByRole('alert')).toHaveText(
    'Not signed: The operation gives a different number of stars.',
  );
  await expect(panel.getByLabel('Wallet password')).toHaveValue('');
  server.tamper = 'agent';
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Rate Harbor', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText(
    'Not signed: The operation rates a different agent.',
  );
  expect(server.signatures).toHaveLength(0);
  // A retry of the same rating keeps its key; other stars get a new one.
  expect(server.ratings).toHaveLength(2);
  expect(server.ratings[1]!.idempotencyKey).toBe(server.ratings[0]!.idempotencyKey);
  server.tamper = null;
  await panel.locator('.w4-pick-star').nth(4).click();
  await panel.getByLabel('Wallet password').fill(password);
  server.createRefusal = { status: 429, code: 'rating_limit', details: { max: 100 } };
  await panel.getByRole('button', { name: 'Rate Harbor', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText(
    'You’ve rated 100 times today. Try again tomorrow.',
  );
  expect(server.ratings[2]!.stars).toBe(5);
  expect(server.ratings[2]!.idempotencyKey).not.toBe(server.ratings[0]!.idempotencyKey);
});

test('rate: checked, signed with the owner key, on its way, then rated at Base’s safe head, then final', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await rateServer(page);
  const panel = await openRate(page);
  await findHarbor(panel);
  const readsBefore = server.baseReads;
  await rateHarbor(panel, 4);

  const going = panel.getByRole('status').filter({ hasText: 'Rating… on its way to Base' });
  await expect(going).toBeVisible({ timeout: 20_000 });
  await expect(going).toContainText('for Harbor, from Research scout');
  await expect(going.getByRole('img', { name: '4 of 5 stars' })).toBeVisible();
  // In a block but not at the safe head yet: still on its way.
  server.now = { state: 'included', safe: false };
  await page.waitForTimeout(3_500);
  await expect(going).toBeVisible();

  server.now = { state: 'included', safe: true };
  // At the safe head: on Base, not yet ✓ (✓ only at final, as Pay and Ratings given).
  const done = panel.locator('.w4-rate-done');
  await expect(done).toContainText('On Base · final in about 15 minutes', { timeout: 10_000 });
  await expect(done).not.toContainText('Rated ✓');
  await expect(done).toContainText('for Harbor');
  await expect(done.getByRole('link', { name: 'View on Basescan' })).toHaveAttribute(
    'href',
    /^https:\/\/basescan\.org\/tx\//,
  );
  await expect(panel).toContainText('Rating Harbor again replaces this one.');

  server.now = { state: 'final' };
  await expect(done).toContainText('Rated ✓ · on Base', { timeout: 10_000 });
  await expect(done).not.toContainText('final in about 15 minutes');

  // Exactly one rating, of the lookup the owner saw, signed once by the owner key, with Base read
  // once more right before signing. No cancel is offered for a rating.
  expect(server.ratings).toHaveLength(1);
  expect(server.ratings[0]).toEqual({
    to: { lookupId: expect.stringMatching(/^lk_12345_\d+$/) },
    stars: 4,
    idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  expect(server.baseReads).toBe(readsBefore + 1);
  expect(server.signatures).toEqual([
    { path: `/api/base/agents/${scout.id}/wallet/withdrawals/w-rate-1/signature`, signer: OWNER },
  ]);
  await expect(panel.getByRole('button', { name: /cancel/i })).toHaveCount(0);
  await expect(panel.locator('input[type="password"]')).toHaveCount(0);

  // Rate another agent starts over, empty.
  await panel.getByRole('button', { name: 'Rate another agent', exact: true }).click();
  await expect(panel.getByLabel('Base ID', { exact: true })).toHaveValue('');
  await expect(panel.getByLabel('Passport number', { exact: true })).toHaveValue('');
});

for (const delayed of ['the prepared rating', 'the Base check before signing'] as const) {
  test(`Back while ${delayed} is delayed: the abandoned rating is never signed, the next one goes`, async ({
    page,
  }) => {
    test.skip(!SIGNABLE, NOT_YET);
    test.setTimeout(60_000);
    const server = await rateServer(page);
    const panel = await openRate(page);
    await findHarbor(panel);

    // Harbor, 4 stars, submitted; its answer (or Base's) is held back.
    const late = gate();
    if (delayed === 'the prepared rating') server.holdCreate = late.held;
    else server.holdBase = { baseId: HARBOR.baseId, until: late.held };
    await rateHarbor(panel, 4);
    await expect(panel.getByRole('button', { name: 'Signing…', exact: true })).toBeVisible();
    if (delayed === 'the prepared rating') await expect.poll(() => server.ratings.length).toBe(1);
    else await expect.poll(() => server.heldBase).toBe(1);

    // Back before the signature is sent, and another agent.
    const back = panel.getByRole('button', { name: 'Rate an agent', exact: true });
    await expect(back).toBeEnabled();
    await back.click();
    await expect(panel.getByRole('heading', { name: 'Rate an agent', exact: true })).toBeVisible();
    await panel.getByLabel('Base ID', { exact: true }).fill(LIGHTHOUSE.baseId);
    await panel.getByLabel('Passport number', { exact: true }).fill(LIGHTHOUSE.short);
    await expect(panel.getByRole('group', { name: 'Agent to rate' })).toContainText('Lighthouse');
    await panel.getByRole('button', { name: 'Continue', exact: true }).click();
    const onLighthouse = panel.getByRole('heading', { name: 'Rate Lighthouse', exact: true });
    await expect(onLighthouse).toBeVisible();
    await expect(panel.getByLabel('Wallet password')).toHaveValue('');

    // The held answer arrives: the abandoned rating signs nothing and changes nothing on screen.
    server.holdCreate = null;
    server.holdBase = null;
    const readsBefore = server.baseReads;
    late.release();
    if (delayed === 'the prepared rating') await expect.poll(() => server.answered).toBe(1);
    // Long enough for the old password to unlock the key and sign, were it still used.
    await page.waitForTimeout(3_000);
    expect(server.signatures).toEqual([]);
    // It stopped at once: no second Base check for Harbor after its answer came.
    if (delayed === 'the prepared rating') expect(server.baseReads).toBe(readsBefore);
    await expect(onLighthouse).toBeVisible();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    // Ready for the new rating, with no password yet.
    const rateLighthouse = panel.getByRole('button', { name: 'Rate Lighthouse', exact: true });
    await expect(rateLighthouse).toBeDisabled();

    // The new rating goes as any other: Lighthouse, 2 stars, a new key, its own signature. While
    // that signature is on its way to the server, Back waits.
    const sent = gate();
    server.holdSignature = sent.held;
    await panel.locator('.w4-pick-star').nth(1).click();
    await panel.getByLabel('Wallet password').fill(password);
    await rateLighthouse.click();
    await expect.poll(() => server.signatures.length, { timeout: 20_000 }).toBe(1);
    await expect(back).toBeDisabled();
    server.holdSignature = null;
    sent.release();
    const going = panel.getByRole('status').filter({ hasText: 'Rating… on its way to Base' });
    await expect(going).toBeVisible({ timeout: 20_000 });
    await expect(going).toContainText('for Lighthouse, from Research scout');
    await expect(going.getByRole('img', { name: '2 of 5 stars' })).toBeVisible();

    // Both were prepared by the server; only the second was ever signed.
    expect(server.ratings).toHaveLength(2);
    expect(server.ratings[0]).toMatchObject({
      to: { lookupId: expect.stringMatching(/^lk_12345_\d+$/) },
      stars: 4,
    });
    expect(server.ratings[1]).toMatchObject({
      to: { lookupId: expect.stringMatching(/^lk_23456_\d+$/) },
      stars: 2,
    });
    expect(server.ratings[1]!.idempotencyKey).not.toBe(server.ratings[0]!.idempotencyKey);
    await page.waitForTimeout(1_000);
    expect(server.signatures).toEqual([
      { path: `/api/base/agents/${scout.id}/wallet/withdrawals/w-rate-2/signature`, signer: OWNER },
    ]);
  });
}

test('each refusal from the server reads as its own plain sentence', async ({ page }) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await rateServer(page);
  const panel = await openRate(page);
  const baseId = panel.getByLabel('Base ID', { exact: true });
  const passport = panel.getByLabel('Passport number', { exact: true });
  const continueButton = panel.getByRole('button', { name: 'Continue', exact: true });
  await baseId.fill(HARBOR.baseId);
  await passport.fill(HARBOR.short);
  await expect(panel.getByRole('group', { name: 'Agent to rate' })).toBeVisible();

  for (const [refusal, sentence] of [
    [{ status: 422, code: 'not_rateable' }, 'Only Central City agents on Base can be rated.'],
    [{ status: 403, code: 'same_person' }, 'Research scout can’t rate your own agents.'],
    [
      { status: 422, code: 'lookup_mismatch' },
      'This Base ID and passport number don’t belong to the same Central City agent. Check both on the agent’s passport.',
    ],
  ] as const) {
    server.lookupRefusal = refusal;
    await passport.fill('Ab3dE8');
    await passport.fill(HARBOR.short);
    await expect(panel.getByRole('alert')).toHaveText(sentence);
  }
  server.lookupRefusal = null;
  await continueButton.click();
  await expect(panel.getByRole('group', { name: 'Agent to rate' })).toBeVisible();
  await continueButton.click();

  for (const [refusal, sentence] of [
    [
      { status: 429, code: 'rating_limit', details: { max: 10000 } },
      'You’ve rated 10,000 times today. Try again tomorrow.',
    ],
    [
      { status: 409, code: 'operation_pending' },
      'A payment or rating from this wallet is still on its way. Try again in a minute.',
    ],
  ] as const) {
    server.createRefusal = refusal;
    await rateHarbor(panel, 3);
    await expect(panel.getByRole('alert')).toHaveText(sentence);
  }
  // The agent's details changed since the lookup: back to them, to check again.
  for (const code of ['lookup_expired', 'lookup_changed']) {
    server.createRefusal = { status: 409, code };
    await rateHarbor(panel, 3);
    await expect(panel.getByRole('heading', { name: 'Rate an agent', exact: true })).toBeVisible();
    await expect(panel.getByRole('alert')).toHaveText(
      'This agent’s details changed. Check them again.',
    );
    server.createRefusal = null;
    await continueButton.click();
    await expect(panel.getByRole('group', { name: 'Agent to rate' })).toBeVisible();
    await continueButton.click();
    await expect(panel.getByRole('heading', { name: 'Rate Harbor', exact: true })).toBeVisible();
  }
  expect(server.signatures).toHaveLength(0);
});

test('a signature refused before it was taken drops the rating: discarded, never sent again, a new key next', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await rateServer(page);
  const panel = await openRate(page);
  await findHarbor(panel);
  const keys = () => server.ratings.map((rating) => rating.idempotencyKey);

  for (const [refusal, sentence] of [
    [
      { status: 410, code: 'expired' },
      'This rating waited too long to be signed. Nothing was sent. Rate again.',
    ],
    [
      { status: 409, code: 'sponsorship_expired' },
      'The network fee sponsorship for this rating ran out before it was signed. Nothing was sent. Rate again.',
    ],
  ] as const) {
    server.signRefusal = refusal;
    const before = server.ratings.length;
    await rateHarbor(panel, 4);
    await expect(panel.getByRole('alert')).toHaveText(sentence, { timeout: 20_000 });
    // Signed once, refused, and discarded on the server: nothing is sent again by itself.
    const id = `w-rate-${before + 1}`;
    await expect.poll(() => server.cancels).toContain(id);
    await page.waitForTimeout(1_000);
    expect(server.ratings).toHaveLength(before + 1);
    expect(server.signatures.filter((s) => s.path.endsWith(`/${id}/signature`))).toHaveLength(1);
  }
  // Each try was its own rating under its own key: the expired one was never replayed.
  expect(new Set(keys()).size).toBe(keys().length);

  // Unclear (a 5xx): the signature may have been taken, so nothing is discarded and the same key
  // asks again (the server answers the same rating).
  server.signRefusal = { status: 503, code: 'chain_unavailable' };
  await rateHarbor(panel, 4);
  await expect(panel.getByRole('alert')).toBeVisible({ timeout: 20_000 });
  const unclear = server.ratings.length;
  expect(server.cancels).not.toContain(`w-rate-${unclear}`);

  // The next one goes as any other.
  server.signRefusal = null;
  await rateHarbor(panel, 4);
  await expect(
    panel.getByRole('status').filter({ hasText: 'Rating… on its way to Base' }),
  ).toBeVisible({ timeout: 20_000 });
  expect(server.ratings).toHaveLength(unclear + 1);
  expect(server.ratings[unclear]!.idempotencyKey).toBe(server.ratings[unclear - 1]!.idempotencyKey);
  expect(server.cancels).toEqual(['w-rate-1', 'w-rate-2']);
});

test('ratings switched off (404): Rate says so, and the Wallet stops offering it', async ({
  page,
}) => {
  const server = await rateServer(page);
  server.off = true;
  const panel = await openRate(page);
  await panel.getByLabel('Base ID', { exact: true }).fill(HARBOR.baseId);
  await panel.getByLabel('Passport number', { exact: true }).fill(HARBOR.short);
  await expect(panel.getByText('Rating agents isn’t switched on here yet.')).toBeVisible();
  await panel.getByRole('button', { name: 'Wallet', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Pay', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Rate', exact: true })).toHaveCount(0);
});

/* ---------- Ratings given: the agents rated so far, on the Rate screen ---------- */

const TX = `0x${'ee'.repeat(32)}`;
const JUNO = { agentId: 'agent-juno', baseId: '45678', short: 'Jn6tYb', name: '' };
const MIRA = { agentId: 'agent-mira', baseId: '56789', short: 'Mr7uZc', name: 'Mira' };

/** A rating this wallet made, as GET …/wallet/ratings lists it. */
function given(
  agent: { agentId: string; baseId: string; short: string; name: string },
  over: { withdrawalId: string; stars: Stars; state: RatingGiven['state']; createdAt?: number },
): RatingGiven {
  const landed = !['awaiting_signature', 'submitted'].includes(over.state);
  const createdAt = over.createdAt ?? NOW - 60_000;
  return {
    withdrawalId: over.withdrawalId,
    ratedAgentId: agent.agentId,
    name: agent.name,
    baseId: agent.baseId,
    short: agent.short,
    stars: over.stars,
    state: over.state,
    txHash: landed ? TX : null,
    blockNumber: landed ? 52_462_300 : null,
    explorerUrl: landed ? `https://basescan.org/tx/${TX}` : null,
    createdAt,
    updatedAt: createdAt,
  };
}

const DATE = /[A-Z][a-z]{2} \d{1,2}$/;

test('Ratings given: on the Rate screen under Continue, the latest per agent and where it stands', async ({
  page,
}) => {
  const server = await rateServer(page);
  server.given = [
    given(MISCHKE, { withdrawalId: 'w-given-6', stars: 5, state: 'final', createdAt: NOW - 1_000 }),
    given(HARBOR, { withdrawalId: 'w-given-5', stars: 4, state: 'included' }),
    given(LIGHTHOUSE, { withdrawalId: 'w-given-4', stars: 3, state: 'submitted' }),
    given(JUNO, { withdrawalId: 'w-given-3', stars: 2, state: 'awaiting_signature' }),
    given(MIRA, { withdrawalId: 'w-given-2', stars: 1, state: 'failed' }),
    // Mischke rated before, 2 stars: the latest rating replaces it, so it isn't shown.
    given(MISCHKE, {
      withdrawalId: 'w-given-1',
      stars: 2,
      state: 'final',
      createdAt: NOW - 90_000,
    }),
  ];
  // The Wallet itself lists none of it.
  const panel = await openWallet(page);
  await expect(panel.getByRole('button', { name: 'Rate', exact: true })).toBeVisible();
  await expect(panel.getByText('Ratings given')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Rate', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Rate an agent', exact: true })).toBeVisible();

  const list = panel.getByRole('list', { name: 'Ratings given' });
  const rows = list.getByRole('listitem');
  await expect(rows).toHaveCount(5);
  await expect(panel.getByText('Ratings given', { exact: true })).toBeVisible();
  // Directly under Continue.
  const below = (await panel.getByText('Ratings given', { exact: true }).boundingBox())!;
  const button = (await panel
    .getByRole('button', { name: 'Continue', exact: true })
    .boundingBox())!;
  expect(below.y).toBeGreaterThan(button.y + button.height);

  const expected = [
    ['Rated Mischke', '5 of 5 stars', 'Rated ✓ · on Base · ', true],
    ['Rated Harbor', '4 of 5 stars', 'On Base · final in about 15 minutes · ', true],
    ['Rated Lighthouse', '3 of 5 stars', 'On its way to Base · ', false],
    // No public name: its passport number.
    [`Rated CC-${JUNO.short}`, '2 of 5 stars', 'On its way to Base · ', false],
    ['Rated Mira', '1 of 5 stars', 'Didn’t go through · ', true],
  ] as const;
  for (const [i, [who, stars, line, link]] of expected.entries()) {
    const row = rows.nth(i);
    await expect(row.locator('.w4-given-name')).toHaveText(who);
    await expect(row.getByRole('img', { name: stars, exact: true })).toBeVisible();
    await expect(row.locator('.w4-row-sub')).toHaveText(new RegExp(`^${line}`));
    await expect(row.locator('.w4-row-sub')).toHaveText(DATE);
    const basescan = row.getByRole('link', { name: /on Basescan$/ });
    if (link) {
      await expect(basescan).toHaveText('Basescan');
      await expect(basescan).toHaveAttribute('href', `https://basescan.org/tx/${TX}`);
    } else await expect(basescan).toHaveCount(0);
  }
  // Mischke's five stars, blue: every star filled.
  await expect(rows.nth(0).locator('.w4-star[data-on]')).toHaveCount(5);
  await expect(list.getByRole('img', { name: '2 of 5 stars', exact: true })).toHaveCount(1);
  await expect(panel.getByText('Your latest rating counts.', { exact: true })).toHaveCount(1);
});

test('Ratings given: one on its way is followed on Base and read again every 15 s until final', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const server = await rateServer(page);
  server.given = [given(MISCHKE, { withdrawalId: 'w-given-1', stars: 5, state: 'submitted' })];
  const panel = await openRate(page);
  const row = panel.getByRole('list', { name: 'Ratings given' }).getByRole('listitem');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.w4-row-sub')).toHaveText(/^On its way to Base · /);
  const reads = server.listReads;

  // In a block: on Base, final not claimed yet.
  server.given = [given(MISCHKE, { withdrawalId: 'w-given-1', stars: 5, state: 'included' })];
  await expect(row.locator('.w4-row-sub')).toHaveText(/^On Base · final in about 15 minutes · /, {
    timeout: 20_000,
  });
  expect(server.listReads).toBe(reads + 1);
  // Before listing again, the rating on its way was read on the withdrawal route (followed on Base).
  expect(server.withdrawalReads).toEqual(['w-given-1']);

  server.given = [given(MISCHKE, { withdrawalId: 'w-given-1', stars: 5, state: 'final' })];
  await expect(row.locator('.w4-row-sub')).toHaveText(/^Rated ✓ · on Base · /, {
    timeout: 20_000,
  });
  // Final: nothing more is read.
  const done = server.listReads;
  await page.waitForTimeout(16_000);
  expect(server.listReads).toBe(done);
  expect(server.withdrawalReads).toEqual(['w-given-1', 'w-given-1']);
});

test('Ratings given: tapping a rated agent fills in its Base ID and passport number to rate again', async ({
  page,
}) => {
  const server = await rateServer(page);
  server.given = [given(MISCHKE, { withdrawalId: 'w-given-1', stars: 5, state: 'final' })];
  const panel = await openRate(page);
  const baseId = panel.getByLabel('Base ID', { exact: true });
  const passport = panel.getByLabel('Passport number', { exact: true });
  await expect(baseId).toHaveValue('');
  await panel.getByRole('button', { name: /^Rated Mischke/ }).click();
  await expect(baseId).toHaveValue(MISCHKE.baseId);
  await expect(passport).toHaveValue(MISCHKE.short);
  // Looked up and read from Base as if typed.
  const card = panel.getByRole('group', { name: 'Agent to rate' });
  await expect(card).toContainText('Mischke');
  await expect(card).toContainText(`Base ID ${MISCHKE.baseId} · Passport ${MISCHKE.short}`);
  expect(server.lookups.at(-1)).toEqual({ baseId: MISCHKE.baseId, passport: MISCHKE.short });
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Rate Mischke', exact: true })).toBeVisible();
});

test('Ratings given: nothing shows while there are none, or while ratings are off', async ({
  page,
}) => {
  const server = await rateServer(page);
  let panel = await openRate(page);
  await expect.poll(() => server.listReads).toBeGreaterThan(0);
  await expect(panel.getByText('Ratings given')).toHaveCount(0);
  await expect(panel.getByText('Your latest rating counts.')).toHaveCount(0);

  server.given = [given(MISCHKE, { withdrawalId: 'w-given-1', stars: 5, state: 'final' })];
  server.off = true;
  const before = server.listReads;
  await page.reload();
  panel = await openRate(page);
  await expect.poll(() => server.listReads).toBeGreaterThan(before);
  await expect(panel.getByText('Ratings given')).toHaveCount(0);
  await expect(panel.getByText('Your latest rating counts.')).toHaveCount(0);
});
