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
} from '../shared/base/withdraw';
import { BASE_MAINNET, BASE_NETWORKS } from '../shared/base/chains';
import { SPONSOR_PAYMASTERS } from '../shared/base/paymasters';
import { parseRecipient, PAY_RECIPIENT_TTL_MS, type PayIncoming } from '../shared/base/pay';
import { laneNonce } from '../shared/base/lanes';
import { sealKey } from '../src/base/vault/crypto';
import { expectedWallet, walletAccountIndex } from '../src/base/wallet/derive';
import type { PayIncomingRow } from '../src/base/wallet/pay';
import { privateKeyToAccount } from 'viem/accounts';

/*
 * Pay another Central City agent (Operation Base Pay P1). The pay and withdrawal routes are
 * fixtures in the shapes of server/base/pay and server/base/wallet/withdrawals.ts, with real
 * operations and hashes; Base's public endpoint is a fixture too, for the browser's own read of
 * ownerOf(Base ID). The owner key is a real locked key; the fixture checks each signature.
 */

const headers = { 'X-City-Request': '1' };
const password = 'Local-test-only-passphrase-2026';
const NOW = Date.now();
const MAINNET = WITHDRAWAL_CHAIN_ID === BASE_MAINNET;
const NETWORK_NAME = MAINNET ? 'Base' : 'Base Sepolia';
const ELSEWHERE = getAddress(`0x${'4d'.repeat(20)}`);
const STRANGER = getAddress(`0x${'6e'.repeat(20)}`);
const REGISTRY = BASE_NETWORKS[WITHDRAWAL_CHAIN_ID].contracts.identityRegistry!;
const HARBOR = {
  baseId: '12345',
  short: 'Ab3dE9',
  name: 'Harbor',
  wallet: getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'),
};
const PASSPORT = `https://centralcity.ai/a/${HARBOR.short}`;
const CHECKED_AT_BLOCK = 52_441_231;
const walletAbi = parseAbi(['function execute(address target, uint256 value, bytes data)']);
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

/** A fixed synthetic owner key; the scout's wallet is the one it makes, as in production. */
const OWNER_KEY = `0x${'4c'.repeat(32)}` as Hex;
const OWNER = privateKeyToAccount(OWNER_KEY).address;
const WALLET = expectedWallet(OWNER, scout.id);
/** A deployed wallet the server could name instead: no owner key makes it for the scout. */
const SUBSTITUTED = getAddress(`0x${'9e'.repeat(20)}`);

const amount = (raw: bigint, decimals: number, display: string) => ({
  raw: raw.toString(),
  decimals,
  display,
});

/** The pinned factory setting the scout's wallet up: its owner key and the manager, its index. */
const CONTRACTS = BASE_NETWORKS[WITHDRAWAL_CHAIN_ID].contracts;
const SETUP = `${CONTRACTS.smartWalletFactory}${encodeFunctionData({
  abi: parseAbi(['function createAccount(bytes[] owners, uint256 nonce)']),
  functionName: 'createAccount',
  args: [
    [OWNER, CONTRACTS.spendPermissionManager!].map(
      (address) => `0x${'00'.repeat(12)}${address.slice(2).toLowerCase()}` as Hex,
    ),
    walletAccountIndex(scout.id),
  ],
}).slice(2)}` as Hex;

function operation(
  to: string,
  value: bigint,
  sender: string = WALLET,
  nonce = 4n,
  initCode: Hex = '0x',
): UserOperation<'0.6'> {
  const call = withdrawalCall('USDC', getAddress(to), value);
  return {
    sender: getAddress(sender),
    nonce,
    initCode,
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

function recipientAnswer(baseId = HARBOR.baseId) {
  const at = Date.now();
  return {
    kind: 'central_city_agent',
    baseId,
    short: HARBOR.short,
    name: HARBOR.name,
    wallet: HARBOR.wallet,
    registry: REGISTRY,
    chainId: WITHDRAWAL_CHAIN_ID,
    verification: 'point_in_time',
    lookupId: `lk_${baseId}_${at}`,
    verified: { block: CHECKED_AT_BLOCK, blockHash: `0x${'aa'.repeat(32)}`, at },
    expiresAt: at + PAY_RECIPIENT_TTL_MS,
  };
}

async function payServer(page: Page) {
  const owner = { privateKey: OWNER_KEY, address: OWNER };
  const envelope = await sealKey(owner.privateKey, password, { N: 2 ** 17 });
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Pay-${randomUUID().slice(0, 8)}`, password },
  });
  expect(registered.status()).toBe(201);
  // The vault is the signed-in person's own: its accountId is their session's person id.
  const person = (
    (await (await page.request.get('/api/session')).json()) as { operator: { id: string } }
  ).operator.id;
  const baseline = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  // On the context, so a second tab sees the same server.
  const routes = page.context();
  await routes.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
  await routes.route('**/api/snapshot', (route) =>
    route.fulfill({ json: { ...baseline, agents: [scout] } }),
  );
  await routes.route('**/api/agents/*/answering', (route) =>
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
  await routes.route('**/api/base/vault', (route) =>
    route.fulfill({
      json: {
        accountId: person,
        exists: true,
        ownerAddress: owner.address,
        ...envelope,
        version: 1,
        backupConfirmedAt: NOW,
        challenge: { nonce: `0x${'ab'.repeat(32)}`, expiresAt: NOW + 300_000 },
      },
    }),
  );
  await routes.route('**/api/base/agents/*/wallet', (route) =>
    route.fulfill({
      json: {
        chainId: WITHDRAWAL_CHAIN_ID,
        network: NETWORK_NAME,
        testnet: !MAINNET,
        address: walletAnswered(),
        ownerAddress: state.otherOwner ? STRANGER : owner.address,
        deployed: !state.setup,
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
  await routes.route('**/api/base/agents/*/wallet/history*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Not found.' } }),
  );
  const state = {
    owner: owner.address,
    /** The recipient lookup answers another agent than the one typed. */
    answerOther: false,
    /** The recipient can't receive yet (an agent registered before wallets). */
    notReady: false,
    /** The prepared operation pays another wallet than the recipient's. */
    tamper: false,
    /** The wallet reports another owner key than the vault's (an agent's identity wallet). */
    otherOwner: false,
    /** The wallet route (and the payment) names a wallet the owner key doesn't make. */
    substituted: false,
    /** Base (read by the browser) says this wallet holds the Base ID; null: Base doesn't answer. */
    baseOwner: HARBOR.wallet as string | null,
    baseReads: 0,
    lookups: [] as string[],
    payments: [] as Array<Record<string, unknown>>,
    signatures: [] as Array<{ path: string; signer: string }>,
    hash: '0x' as Hex,
    /**
     * What the GET read reports, in turn, then the last one: a state, `:safe` / `:unsafe` for the
     * server's `safe` (none: an older server's answer), or '404'. Each payment takes a copy.
     */
    progress: ['submitted', 'included', 'final'] as string[],
    /** Each payment prepared, by id: its hash, what is read for it, and whether it was signed. */
    ops: {} as Record<
      string,
      {
        hash: Hex;
        progress: string[];
        signed: boolean;
        /** Its operation, amount and order, and its cancel once asked. */
        op?: UserOperation<'0.6'>;
        amount?: bigint;
        createdAt?: number;
        cancel?: { op: UserOperation<'0.6'>; hash: Hex; signed: boolean };
      }
    >,
    /** Lanes (CITY_BASE_LANES=1): each payment in its own nonce lane, and the open list. */
    lanes: false,
    /** Lanes: what each next payment is read as, in turn (else `progress`). */
    progressQueue: [] as string[][],
    /** The next create is refused with this (too_many_open, funds_held). */
    refuse: null as null | { code: string; error: string; details?: unknown },
    /** The wallet isn't on Base yet: every operation also sets it up. */
    setup: false,
    /** Reads of the open list, and of single operations. */
    openReads: 0,
    reads: 0,
    /** Lanes: this many more operations on their way, signed elsewhere, in the open list. */
    elsewhere: 0,
    /** Unsigned payments the browser discarded. */
    discarded: [] as string[],
    /** Every cancel asked (POST …/cancel), signed or not. */
    cancelPosts: 0,
    /** The next payment signatures are taken, but answered with these statuses (a broken answer). */
    signatureFails: [] as number[],
    /** The next payment signatures are NOT taken, and answered with these statuses. */
    signatureNotTaken: [] as number[],
    /** The body each idempotency key was first used with (another body is refused, as on the server). */
    keys: new Map<string, string>(),
    /** The change log the incoming route pages through, oldest first (a later version wins). */
    incoming: [] as PayIncomingRow[],
    incomingReads: 0,
  };

  await routes.route('**/api/base/pay/recipient?*', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    state.lookups.push(q);
    const reading = parseRecipient(q)[0];
    if (state.notReady)
      return route.fulfill({
        status: 409,
        json: { error: 'This agent can’t receive payments yet.', code: 'recipient_not_ready' },
      });
    if (reading?.kind === 'address' && getAddress(reading.address) === WALLET)
      return route.fulfill({ json: { ...recipientAnswer(), wallet: WALLET } });
    if (reading?.kind === 'address' && getAddress(reading.address) !== HARBOR.wallet)
      return route.fulfill({
        status: 422,
        json: {
          error: 'This is not a Central City agent. Use Withdraw for other addresses.',
          code: 'not_central_city_agent',
        },
      });
    if (
      (reading?.kind === 'baseId' && reading.baseId === HARBOR.baseId) ||
      (reading?.kind === 'short' && reading.short === HARBOR.short) ||
      reading?.kind === 'address'
    )
      return route.fulfill({ json: recipientAnswer(state.answerOther ? '12346' : HARBOR.baseId) });
    return route.fulfill({
      status: 404,
      json: { error: 'No Central City agent on Base with that Base ID.', code: 'not_found' },
    });
  });

  // As the server pages it: ?after=<cursor>&limit=<n>, oldest change first, never skipping one.
  await routes.route('**/api/base/pay/incoming*', (route) => {
    state.incomingReads += 1;
    const query = new URL(route.request().url()).searchParams;
    const after = query.get('after');
    const from = after ? Number(after.slice(1)) : 0;
    const limit = Number(query.get('limit') ?? 50);
    const payments = state.incoming.slice(from, from + limit);
    const end = from + payments.length;
    return route.fulfill({
      json: {
        payments,
        cursor: end > 0 ? `c${end}` : after,
        hasMore: end < state.incoming.length,
      },
    });
  });

  // Base's public endpoint, as this browser reads it: the head, then ownerOf at it.
  await routes.route('https://mainnet.base.org/**', async (route) => {
    const call = route.request().postDataJSON() as { id: number; method: string };
    if (state.baseOwner === null) return route.abort('failed');
    if (call.method === 'eth_blockNumber')
      return route.fulfill({ json: { jsonrpc: '2.0', id: call.id, result: '0x3203b10' } });
    state.baseReads += 1;
    return route.fulfill({
      json: {
        jsonrpc: '2.0',
        id: call.id,
        result: `0x${'0'.repeat(24)}${state.baseOwner.slice(2).toLowerCase()}`,
      },
    });
  });

  /**
   * The wallet the routes answer: a substituted address; with another owner, that owner's own
   * derived wallet (consistent, so only the unlocked key can tell); else the owner key's wallet.
   */
  function walletAnswered() {
    return state.substituted
      ? SUBSTITUTED
      : state.otherOwner
        ? expectedWallet(STRANGER, scout.id)
        : WALLET;
  }

  /** A payment as the routes report it; `entry` as in `progress`, `posted` for a POST answer. */
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
    from: walletAnswered(),
    to: HARBOR.wallet,
    network: NETWORK_NAME,
    chainId: WITHDRAWAL_CHAIN_ID,
    userOpHash: state.ops[id]?.hash ?? state.hash,
    sponsored: true,
    fee: { paidBy: 'sponsor', token: 'ETH', max: amount(0n, 18, '0') },
    txHash: withdrawalState === 'submitted' ? null : `0x${'ee'.repeat(32)}`,
    blockNumber: withdrawalState === 'submitted' ? null : 52_441_300,
    errorCode: null,
    explorerUrl:
      withdrawalState === 'submitted' ? null : `https://basescan.org/tx/0x${'ee'.repeat(32)}`,
    expiresAt: null,
    cancel: cancelOf(id),
    createdAt: state.ops[id]?.createdAt ?? NOW,
    updatedAt: Date.now(),
  });
  /** A payment's cancel as the routes report it, once asked. */
  const cancelOf = (id: string) => {
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

  await routes.route('**/api/base/agents/*/wallet/payments', (route) => {
    const body = route.request().postDataJSON() as {
      to: { lookupId: string };
      amount: string;
      note: string | null;
      idempotencyKey: string;
    };
    state.payments.push(body);
    const { idempotencyKey, ...asked } = body;
    const first = state.keys.get(idempotencyKey);
    if (first !== undefined && first !== JSON.stringify(asked))
      return route.fulfill({
        status: 409,
        json: {
          error: 'This idempotencyKey was used for another withdrawal.',
          code: 'idempotency_conflict',
        },
      });
    if (state.refuse) {
      const { code, error, details } = state.refuse;
      state.refuse = null;
      return route.fulfill({ status: 409, json: { error, code, details } });
    }
    state.keys.set(idempotencyKey, JSON.stringify(asked));
    const id = `w-pay-${Object.keys(state.ops).length + 1}`;
    // The server pays the wallet its lookup answered (Harbor's); with lanes, in the payment's own
    // nonce lane (shared/base/lanes.ts), else at the wallet's next sequential nonce.
    const op = operation(
      state.tamper ? ELSEWHERE : HARBOR.wallet,
      BigInt(body.amount),
      walletAnswered(),
      state.lanes ? laneNonce(id) : 4n + BigInt(Object.keys(state.ops).length),
      state.setup ? SETUP : '0x',
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
          to: HARBOR.wallet,
          network: NETWORK_NAME,
          testnet: !MAINNET,
          sponsored: true,
          fee: { paidBy: 'sponsor', token: 'ETH', max: amount(0n, 18, '0') },
          deploysWallet: state.setup,
          toIsContract: false,
        },
        payment: { paymentId: 'p-1', recipient: recipientAnswer(), note: body.note },
        ...(state.lanes ? { lanes: true } : {}),
      },
    });
  });

  /** The next state an operation is read in (the last one stays). */
  const advance = (op: (typeof state.ops)[string]) =>
    op.progress.length > 1 ? op.progress.shift()! : op.progress[0]!;
  const OPEN = ['awaiting_signature', 'submitted', 'included', 'cancel_pending'];

  // Lanes: the wallet's open operations, newest first, in one read (?open=1).
  await routes.route(
    (url) => url.pathname.endsWith('/wallet/withdrawals') && url.searchParams.get('open') === '1',
    (route) => {
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
      for (let at = 1; at <= state.elsewhere; at += 1)
        withdrawals.push(view(`w-elsewhere-${at}`, 'submitted'));
      return route.fulfill({ json: { withdrawals } });
    },
  );

  await routes.route('**/api/base/agents/*/wallet/withdrawals/**', async (route) => {
    const url = new URL(route.request().url());
    const id = decodeURIComponent(url.pathname.split('/withdrawals/')[1]!.split('/')[0]!);
    const op = state.ops[id];
    if (!op)
      return route.fulfill({ status: 404, json: { error: 'Not found.', code: 'not_found' } });
    const method = route.request().method();
    if (method === 'POST' && url.pathname.endsWith('/cancel')) state.cancelPosts += 1;
    // A signed payment's cancel: the wallet's no-op at exactly the payment's nonce.
    if (method === 'POST' && url.pathname.endsWith('/cancel') && op.signed) {
      const noop = {
        ...op.op!,
        callData: encodeFunctionData({
          abi: walletAbi,
          functionName: 'execute',
          args: [noopCall(walletAnswered()).target, 0n, '0x'],
        }),
      };
      op.cancel = { op: noop, hash: ownerOperationHash(noop), signed: false };
      return route.fulfill({ json: view(id, 'submitted', true) });
    }
    if (method === 'POST' && url.pathname.endsWith('/cancel/signature')) {
      const { signature } = route.request().postDataJSON() as { signature: Hex };
      state.signatures.push({
        path: url.pathname,
        signer: await recoverAddress({ hash: op.cancel!.hash, signature }),
      });
      op.cancel!.signed = true;
      op.progress = ['cancel_pending', 'cancelled'];
      return route.fulfill({ status: 202, json: view(id, 'cancel_pending', true) });
    }
    if (route.request().method() === 'POST' && url.pathname.endsWith('/signature')) {
      const notTaken = state.signatureNotTaken.shift();
      if (notTaken) return route.fulfill({ status: notTaken, body: 'Upstream answer lost.' });
      const { signature } = route.request().postDataJSON() as { signature: Hex };
      state.signatures.push({
        path: url.pathname,
        signer: await recoverAddress({ hash: op.hash, signature }),
      });
      op.signed = true;
      const fail = state.signatureFails.shift();
      if (fail) return route.fulfill({ status: fail, body: 'Upstream answer lost.' });
      return route.fulfill({ status: 202, json: view(id, op.progress[0]!, true) });
    }
    // Never signed: a cancel discards it, as on the server.
    if (route.request().method() === 'POST' && url.pathname.endsWith('/cancel') && !op.signed) {
      state.discarded.push(id);
      op.progress = ['expired'];
      return route.fulfill({ json: view(id, 'expired', true) });
    }
    state.reads += 1;
    // Prepared and never signed (nor discarded): still awaiting its signature, as on the server.
    if (state.lanes && !op.signed && !state.discarded.includes(id))
      return route.fulfill({ json: view(id, 'awaiting_signature') });
    const next = advance(op);
    if (next === '404')
      return route.fulfill({ status: 404, json: { error: 'Not found.', code: 'not_found' } });
    return route.fulfill({ json: view(id, next) });
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
  return panel;
}

async function openPay(page: Page) {
  const panel = await openWallet(page);
  await panel.getByRole('button', { name: 'Pay', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Pay', exact: true })).toBeVisible();
  return panel;
}

/** Pay from its own link, without the Wallet screen in front of it. */
async function openPayByLink(page: Page) {
  // A real new page load: when the app already shows this URL, going to it only changes the hash
  // and the screen would not open again (what this browser stored meanwhile would go unread).
  await page.goto('about:blank');
  await page.goto(`/agents?workspace=v2&theme=light#agent=${scout.id}:wallet-pay`);
  const panel = page.getByRole('complementary', { name: 'Research scout details' });
  await expect(panel.getByRole('heading', { name: 'Pay', exact: true })).toBeVisible();
  return panel;
}

async function shot(page: Page, name: string) {
  const dir = process.env.MY_AGENTS_SHOTS;
  if (!dir) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/${name}.png` });
}

async function fillPayment(panel: ReturnType<Page['getByRole']>, to = HARBOR.baseId) {
  await panel.getByRole('textbox', { name: /^To\b/ }).fill(to);
  await expect(panel.getByRole('group', { name: 'Recipient' })).toBeVisible();
  await panel.getByLabel('Amount in USDC').fill('12.50');
  await panel.getByLabel(/^Note/).fill('For the shared dataset');
  await panel.getByRole('button', { name: 'Review payment', exact: true }).click();
}

test('Pay finds the recipient by Base ID or passport, checked on Base; anything else is refused', async ({
  page,
}) => {
  const server = await payServer(page);
  const panel = await openPay(page);
  const to = panel.getByRole('textbox', { name: /^To\b/ });
  const review = panel.getByRole('button', { name: 'Review payment', exact: true });

  // A name decides nothing: it isn't looked up at all.
  await to.fill('Meridian');
  await expect(panel.getByRole('alert')).toHaveText(
    'Type a Base ID, a passport link (centralcity.ai/a/…) or a passport number (CC-…).',
  );
  // No Central City agent with that Base ID; another address (Withdraw is the way there); the
  // agent's own wallet.
  await to.fill('41207');
  await expect(panel.getByRole('alert')).toHaveText(
    'No Central City agent on Base with that Base ID.',
  );
  await to.fill(STRANGER.toLowerCase());
  await expect(panel.getByRole('alert')).toContainText('isn’t a Central City agent');
  await expect(panel.getByRole('button', { name: 'Withdraw instead' })).toBeVisible();
  await to.fill(WALLET.toLowerCase());
  await expect(panel.getByRole('alert')).toHaveText('That’s Research scout’s own wallet.');
  expect(server.lookups).not.toContain('Meridian');

  // The passport link: the agent, its Base ID and wallet, and what the check on Base says.
  await to.fill(PASSPORT);
  const card = panel.getByRole('group', { name: 'Recipient' });
  await expect(card).toContainText('Verified on Base');
  await expect(card).toContainText('Harbor');
  await expect(card).toContainText(HARBOR.baseId);
  await expect(card).toContainText('block 52,441,231');
  await expect(card).toContainText('not when the payment lands');
  await expect(card).toContainText('The Base ID decides, not the name.');

  // More than the wallet holds can't be reviewed; an amount it holds can.
  await panel.getByLabel('Amount in USDC').fill('30');
  await expect(panel.getByText('More than Research scout has. 25 USDC available.')).toBeVisible();
  await expect(review).toBeDisabled();
  await panel.getByLabel('Amount in USDC').fill('12.50');
  await expect(panel).toContainText('Harbor receives');
  await expect(panel).toContainText('12.50 USDC');
  await expect(review).toBeEnabled();
  await shot(page, 'pay-form');

  // Change clears the recipient.
  await card.getByRole('button', { name: 'Change' }).click();
  await expect(to).toHaveValue('');
  await expect(card).toHaveCount(0);
  await expect(review).toBeDisabled();
});

test('an agent that can’t receive yet, and less than 0.01 USDC, are refused before anything is prepared', async ({
  page,
}) => {
  const server = await payServer(page);
  server.notReady = true;
  const panel = await openPay(page);
  const to = panel.getByRole('textbox', { name: /^To\b/ });
  await to.fill(HARBOR.baseId);
  await expect(panel.getByRole('alert')).toHaveText('This agent can’t receive payments yet.');
  await expect(panel.getByRole('group', { name: 'Recipient' })).toHaveCount(0);
  server.notReady = false;
  await to.fill(PASSPORT);
  await expect(panel.getByRole('group', { name: 'Recipient' })).toBeVisible();
  await panel.getByLabel('Amount in USDC').fill('0.001');
  await panel.getByRole('button', { name: 'Review payment', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText('The smallest payment is 0.01 USDC.');
  expect(server.payments).toHaveLength(0);
});

test('an answer for another agent than the one typed is refused', async ({ page }) => {
  const server = await payServer(page);
  server.answerOther = true;
  const panel = await openPay(page);
  await panel.getByRole('textbox', { name: /^To\b/ }).fill(HARBOR.baseId);
  await expect(panel.getByRole('alert')).toHaveText(
    'The answer isn’t the agent that was typed. Try again.',
  );
  await expect(panel.getByRole('group', { name: 'Recipient' })).toHaveCount(0);
});

test('the payment names the lookup the owner saw; where no sponsor is pinned nothing is signed', async ({
  page,
}) => {
  test.skip(SIGNABLE, 'A sponsor is pinned on this network.');
  const server = await payServer(page);
  const panel = await openPay(page);
  await fillPayment(panel, `CC-${HARBOR.short}`);
  await expect(panel.getByRole('alert')).toHaveText(
    'Not signed: The network fee isn’t covered by the approved sponsor; the wallet could be charged.',
  );
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  expect(server.signatures).toHaveLength(0);
  // Exactly what was shown: the Base ID, its wallet and the check on Base, with its expiry.
  expect(server.payments).toHaveLength(1);
  const sent = server.payments[0] as {
    to: Record<string, unknown>;
    amount: string;
    note: string;
    idempotencyKey: string;
  };
  // Only the lookup the owner saw, by its id: the server keeps what it answered under it.
  expect(sent.to).toEqual({ lookupId: expect.stringMatching(/^lk_12345_\d+$/) });
  expect(sent.amount).toBe('12500000');
  expect(sent.note).toBe('For the shared dataset');
  expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
});

test('pay: checked in the browser and on Base twice, signed with the owner key, then the receipt', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await payServer(page);
  const panel = await openPay(page);
  await fillPayment(panel);
  await expect(panel.getByRole('heading', { name: 'Check and pay' })).toBeVisible();
  await expect(panel).toContainText('to Harbor · Base ID 12345');
  await expect(panel).toContainText(HARBOR.wallet);
  await expect(panel).toContainText('Covered by Central City');
  const checks = panel.getByRole('list', { name: 'Checked in this browser' });
  await expect(checks).toContainText('One USDC transfer of 12.50');
  await expect(checks).toContainText('belongs to that wallet at block 52,443,920');
  await expect(panel.getByText('Payments can’t be undone.')).toBeVisible();
  await expect(panel).toContainText('Not signed: the note “For the shared dataset”');
  expect(server.baseReads).toBe(1);
  await shot(page, 'pay-review');

  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Pay 12.50 USDC', exact: true }).click();
  const steps = panel.getByRole('list', { name: 'Payment status' });
  await expect(steps.locator('li[data-done]')).toHaveCount(4, { timeout: 20_000 });
  const receipt = panel.getByRole('group', { name: 'Receipt' }).or(panel.getByLabel('Receipt'));
  // Final: paid, by name; never before.
  await expect(panel.locator('.w4-sent-head')).toHaveText('Paid ✓');
  await expect(panel).toContainText('12.50 USDC to Harbor');
  await expect(receipt).toContainText('Harbor · Base ID 12345');
  await expect(receipt).toContainText('“For the shared dataset”');
  await shot(page, 'pay-final');
  // Base was read once more right before signing; one signature, by the owner key.
  expect(server.baseReads).toBe(2);
  expect(server.signatures).toHaveLength(1);
  expect(server.signatures[0]!.signer).toBe(server.owner);
  await expect(panel.locator('input[type="password"]')).toHaveCount(0);
});

test('reopened while on its way, Pay still names the payment and its recipient', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await payServer(page);
  server.progress = ['submitted', 'included'];
  let panel = await openPay(page);
  await fillPayment(panel);
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Pay 12.50 USDC', exact: true }).click();
  await expect(panel.getByRole('list', { name: 'Payment status' })).toBeVisible({
    timeout: 20_000,
  });
  // A reload: Pay reopens on the payment on its way, by name, never as a withdrawal.
  panel = await openPayByLink(page);
  await expect(panel.getByRole('list', { name: 'Payment status' })).toBeVisible();
  await expect(panel).toContainText('12.50 USDC to Harbor');
  await expect(panel).toContainText('The payment carries on');
  await expect(panel).not.toContainText('withdrawal');
});

test('the Base ID moved to another wallet right before signing: nothing is signed', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await payServer(page);
  const panel = await openPay(page);
  await fillPayment(panel);
  await expect(panel.getByRole('heading', { name: 'Check and pay' })).toBeVisible();
  server.baseOwner = ELSEWHERE;
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Pay 12.50 USDC', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText(
    'This agent’s wallet on Base changed since it was checked. Nothing was signed.',
  );
  await expect(panel.getByLabel('Wallet password')).toHaveValue('');
  expect(server.signatures).toHaveLength(0);
});

test('a wallet another key owns (an identity wallet): the unlocked key signs nothing', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await payServer(page);
  server.otherOwner = true;
  // The Wallet screen refuses it (not the vault's key); Pay opened from its own link checks again.
  const panel = await openPayByLink(page);
  await fillPayment(panel);
  await expect(panel.getByRole('heading', { name: 'Check and pay' })).toBeVisible();
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Pay 12.50 USDC', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText(
    'Not signed: Your wallet key isn’t this wallet’s owner, so nothing was signed.',
  );
  await expect(panel.getByLabel('Wallet password')).toHaveValue('');
  expect(server.signatures).toHaveLength(0);
});

test('a paying wallet the owner key doesn’t make for this agent signs nothing', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  const server = await payServer(page);
  server.substituted = true;
  // A perfect payment of its own, from a wallet the server substituted.
  const panel = await openPayByLink(page);
  await fillPayment(panel);
  await expect(panel.getByRole('alert')).toHaveText(
    'Not signed: This isn’t the wallet your wallet key makes for this agent.',
  );
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  expect(server.signatures).toHaveLength(0);
});

test('an operation that pays another wallet, or Base not answering, signs nothing', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  const server = await payServer(page);
  server.tamper = true;
  const panel = await openPay(page);
  await fillPayment(panel);
  await expect(panel.getByRole('alert')).toHaveText(
    'Not signed: The operation sends to a different address.',
  );
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);

  server.tamper = false;
  server.baseOwner = null;
  await panel.getByRole('button', { name: 'Review payment', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText(
    'Couldn’t check on Base. Nothing was signed. Try again in a moment.',
  );
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  expect(server.signatures).toHaveLength(0);
});

/** A payment to the scout as the incoming route answers it. */
const incomingPayment = (
  state: PayIncoming['state'],
  id: string,
  minutesAgo: number,
): PayIncoming => ({
  paymentId: id,
  withdrawalId: `w-${id}`,
  state,
  from: { name: 'Compass', baseId: '98121', short: 'Cq7mPa', wallet: ELSEWHERE },
  to: {
    agentId: scout.id,
    name: scout.name,
    baseId: '98840',
    short: 'Wm4tRk',
    wallet: WALLET,
  },
  token: 'USDC',
  amount: amount(2_500_000n, 6, '2.5'),
  note: state === 'failed' ? 'Refund to 0xabc' : state === 'final' ? 'Chart pack' : null,
  text: '',
  txHash: state === 'final' ? `0x${'ee'.repeat(32)}` : null,
  explorerUrl: state === 'final' ? `https://basescan.org/tx/0x${'ee'.repeat(32)}` : null,
  sentAt: NOW - minutesAgo * 60_000,
  updatedAt: NOW - minutesAgo * 60_000,
  finalAt: state === 'final' ? NOW - minutesAgo * 60_000 : null,
  safe: state === 'final',
});

test('payments to this agent: paid only once final; on its way and failed say so', async ({
  page,
}) => {
  const server = await payServer(page);
  const payment = incomingPayment;
  server.incoming = [
    payment('final', 'p-final', 30),
    payment('included', 'p-on-way', 2),
    payment('failed', 'p-failed', 60),
    // Another agent's payment never shows here.
    { ...payment('final', 'p-other', 1), to: { ...payment('final', 'x', 1).to, agentId: 'x' } },
  ];
  const panel = await openWallet(page);
  const list = panel.getByLabel('Payments to Research scout');
  await expect(list.locator('.ap4-row')).toHaveCount(3);
  await expect(list.locator('[data-state="final"]')).toContainText('Compass paid Research scout');
  await expect(list.locator('[data-state="final"]')).toContainText('+2.5');
  await expect(list.locator('[data-state="final"]')).toContainText('“Chart pack”');
  await expect(list.locator('[data-state="included"]')).toContainText(
    'Compass is sending Research scout',
  );
  await expect(list.locator('[data-state="included"]')).toContainText('not paid until final');
  await expect(list.locator('[data-state="included"]')).not.toContainText('+');
  await expect(list.locator('[data-state="failed"]')).toContainText(
    'Compass’s payment didn’t go through',
  );
  // A note only shows once the payment is final.
  await expect(list.locator('[data-state="failed"]')).not.toContainText('Refund');
  await shot(page, 'pay-incoming');
});

test('the open wallet sees a new payment and a payment turning final, and reads nothing while hidden', async ({
  page,
}) => {
  const server = await payServer(page);
  await page.clock.install();
  server.incoming = [incomingPayment('included', 'p-1', 3)];
  const panel = await openWallet(page);
  const list = panel.getByLabel('Payments to Research scout');
  await expect(list.locator('[data-state="included"]')).toContainText('is sending Research scout');
  // While the wallet stays open: p-1 lands and a new payment is sent.
  server.incoming.push(
    { ...incomingPayment('final', 'p-1', 0), updatedAt: Date.now() },
    { ...incomingPayment('included', 'p-2', 0), updatedAt: Date.now() + 1 },
  );
  await page.clock.fastForward(21_000);
  await expect(list.locator('.ap4-row')).toHaveCount(2);
  await expect(list.locator('[data-state="final"]')).toContainText('Compass paid Research scout');
  await expect(list.locator('[data-state="included"]')).toContainText('is sending Research scout');
  // Hidden: no reads, however long. Shown again: read at once.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const reads = server.incomingReads;
  server.incoming.push({ ...incomingPayment('final', 'p-2', 0), updatedAt: Date.now() + 2 });
  await page.clock.fastForward(120_000);
  expect(server.incomingReads).toBe(reads);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(1_000);
  await expect(list.locator('[data-state="final"]')).toHaveCount(2);
  expect(server.incomingReads).toBeGreaterThan(reads);
});

test('payments to this agent at Base’s safe head: received, awaiting finality; final only at final', async ({
  page,
}) => {
  const server = await payServer(page);
  const payment = incomingPayment;
  server.incoming = [
    { ...payment('included', 'p-safe', 2), safe: true },
    // An older server (no `safe`) and a block not yet safe: exactly as before.
    payment('included', 'p-older', 3),
    { ...payment('included', 'p-unsafe', 4), safe: false },
    { ...payment('final', 'p-final', 30), safe: true },
  ];
  const panel = await openWallet(page);
  const list = panel.getByLabel('Payments to Research scout');
  await expect(list.locator('.ap4-row')).toHaveCount(4);

  const received = list.locator('[data-phase="received"]');
  await expect(received).toHaveCount(1);
  await expect(received).toHaveAttribute('data-state', 'included');
  await expect(received).toContainText('Compass sent Research scout');
  await expect(received).toContainText('Received · awaiting finality');
  await expect(received).toContainText('Final in about 15 minutes.');
  // Not the grey "on its way", and no paid, final or ✓ before final.
  await expect(received).not.toContainText('not paid until final');
  await expect(received).not.toContainText('✓');
  await expect(received).not.toContainText('+');
  await expect(received.locator('.w4-amt')).not.toHaveClass(/w4-off/);

  const onItsWay = list.locator('[data-state="included"][data-phase="on_its_way"]');
  await expect(onItsWay).toHaveCount(2);
  for (const row of await onItsWay.all()) {
    await expect(row).toContainText('Compass is sending Research scout');
    await expect(row).toContainText('not paid until final');
    await expect(row).not.toContainText('Received');
    await expect(row).not.toContainText('Final in about');
    await expect(row.locator('.w4-amt')).toHaveClass(/w4-off/);
  }

  const final = list.locator('[data-state="final"]');
  await expect(final).toContainText('Received ✓');
  await expect(final).toContainText('Compass paid Research scout');
  await expect(final).toContainText('+2.5');
  await expect(final).not.toContainText('awaiting finality');
  await shot(page, 'pay-incoming-received');
});

test('received at the safe head, then not safe on the next read: shown as the server says now', async ({
  page,
}) => {
  const server = await payServer(page);
  await page.clock.install();
  server.incoming = [{ ...incomingPayment('included', 'p-1', 3), safe: true }];
  const panel = await openWallet(page);
  const list = panel.getByLabel('Payments to Research scout');
  await expect(list.locator('[data-phase="received"]')).toContainText(
    'Received · awaiting finality',
  );
  // The next read: the same payment, still included, no longer safe.
  server.incoming.push({
    ...incomingPayment('included', 'p-1', 0),
    safe: false,
    updatedAt: Date.now(),
  });
  await page.clock.fastForward(21_000);
  await expect(list.locator('.ap4-row')).toHaveCount(1);
  const row = list.locator('.ap4-row');
  await expect(row).toHaveAttribute('data-phase', 'on_its_way');
  await expect(row).toContainText('Compass is sending Research scout');
  await expect(row).toContainText('not paid until final');
  await expect(row).not.toContainText('Received');
  await expect(row).not.toContainText('Final in about');
  // Never turned into a failure on its own.
  await expect(list.locator('[data-state="failed"]')).toHaveCount(0);
  await expect(row).not.toContainText('didn’t go through');
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
const releasedOf = (page: Page) =>
  page.evaluate(
    (id) =>
      (
        JSON.parse(localStorage.getItem(`cc-withdrawal-released:${id}`) ?? '[]') as Array<{
          withdrawalId: string;
        }>
      ).map((entry) => entry.withdrawalId),
    scout.id,
  );

async function payNow(panel: ReturnType<Page['getByRole']>) {
  await fillPayment(panel);
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Pay 12.50 USDC', exact: true }).click();
}

test('settled at Base’s safe head: “Sent · awaiting finality”, a new payment, and paid only at final', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(90_000);
  const server = await payServer(page);
  server.progress = ['submitted', 'included:safe'];
  let panel = await openPay(page);
  await payNow(panel);
  const head = panel.locator('.w4-sent-head');
  await expect(head).toHaveText('Sent · awaiting finality', { timeout: 20_000 });
  await expect(panel).toContainText('Final in about 15 minutes.');
  await expect(panel).toContainText('12.50 USDC to Harbor');
  // Not the pending Final step, nothing paid yet, and no cancel once it is in a block.
  await expect(panel.getByRole('list', { name: 'Payment status' })).toHaveCount(0);
  await expect(panel).not.toContainText('Paid');
  await expect(panel.getByRole('button', { name: /^Cancel/ })).toHaveCount(0);
  // Released: the wallet may start its next payment.
  expect(await anchorOf(page)).toBeNull();
  expect(await releasedOf(page)).toEqual(['w-pay-1']);
  await shot(page, 'pay-sent-safe');

  await panel.getByRole('button', { name: 'New payment', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: /^To\b/ })).toHaveValue('');
  await expect(panel.getByLabel('Amount in USDC')).toHaveValue('');
  await expect(panel.getByLabel(/^Note/)).toHaveValue('');
  await expect(panel.getByRole('group', { name: 'Recipient' })).toHaveCount(0);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  const line = panel.getByRole('list', { name: 'Sent from this wallet' });
  await expect(line).toHaveText('12.50 USDC to Harbor · Sent · awaiting finality');

  // A reload: the form, never that payment reopened as on its way.
  panel = await openPayByLink(page);
  await expect(panel.getByRole('textbox', { name: /^To\b/ })).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Payment status' })).toHaveCount(0);
  await expect(line).toHaveText('12.50 USDC to Harbor · Sent · awaiting finality');

  // The next payment goes out with its own key.
  server.progress = ['submitted'];
  await payNow(panel);
  await expect(panel.getByRole('button', { name: 'Cancel this payment' })).toBeVisible({
    timeout: 20_000,
  });
  expect(server.payments).toHaveLength(2);
  expect(server.payments[1]!.idempotencyKey).not.toBe(server.payments[0]!.idempotencyKey);

  // Final: the quiet line says paid, and its record goes.
  server.ops['w-pay-1']!.progress = ['final'];
  await expect(line).toHaveText('12.50 USDC to Harbor · Paid ✓', { timeout: 20_000 });
  expect(await releasedOf(page)).toEqual([]);
  expect((await anchorOf(page))?.withdrawalId).toBe('w-pay-2');
});

test('in a block without safe (an older server): the screen is as it was', async ({ page }) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await payServer(page);
  server.progress = ['submitted', 'included'];
  const panel = await openPay(page);
  await payNow(panel);
  const steps = panel.getByRole('list', { name: 'Payment status' });
  await expect(steps.locator('li[data-done]')).toHaveCount(3, { timeout: 20_000 });
  await expect(steps.locator('li:not([data-done])')).toHaveText('Final');
  await expect(panel).toContainText('The payment carries on');
  await expect(panel.locator('.w4-sent-head')).toHaveCount(0);
  await expect(panel).not.toContainText('awaiting finality');
  await expect(panel.getByRole('button', { name: 'New payment' })).toHaveCount(0);
  expect((await anchorOf(page))?.withdrawalId).toBe('w-pay-1');
  expect(await releasedOf(page)).toEqual([]);
});

test('safe, then a read that is no longer safe: what the server says now, never a stale “Sent”', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await payServer(page);
  server.progress = ['included:safe', 'included:unsafe'];
  const panel = await openPay(page);
  await payNow(panel);
  await expect(panel.locator('.w4-sent-head')).toHaveText('Sent · awaiting finality', {
    timeout: 20_000,
  });
  // The next read (slower once safe): back to the steps, in a block, not final; no failure.
  const steps = panel.getByRole('list', { name: 'Payment status' });
  await expect(steps).toBeVisible({ timeout: 20_000 });
  await expect(steps.locator('li[data-done]')).toHaveCount(3);
  await expect(panel.locator('.w4-sent-head')).toHaveCount(0);
  await expect(panel).not.toContainText('awaiting finality');
  await expect(panel).not.toContainText('Paid');
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('Back, then a changed amount: the unsigned payment is discarded and the next has a new key', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await payServer(page);
  const panel = await openPay(page);
  await fillPayment(panel);
  await expect(panel.getByRole('heading', { name: 'Check and pay' })).toBeVisible();
  await panel.getByRole('button', { name: 'Back', exact: true }).click();
  await panel.getByLabel('Amount in USDC').fill('10');
  await panel.getByRole('button', { name: 'Review payment', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Check and pay' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Pay 10.00 USDC', exact: true })).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect(server.discarded).toEqual(['w-pay-1']);
  expect(server.payments.map((each) => each.amount)).toEqual(['12500000', '10000000']);
  expect(server.payments[1]!.idempotencyKey).not.toBe(server.payments[0]!.idempotencyKey);
});

test('a payment the server no longer knows: its anchor goes and the form says so', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await payServer(page);
  server.progress = ['submitted'];
  let panel = await openPay(page);
  await payNow(panel);
  await expect(panel.getByRole('button', { name: 'Cancel this payment' })).toBeVisible({
    timeout: 20_000,
  });
  server.ops['w-pay-1']!.progress = ['404'];
  panel = await openPayByLink(page);
  await expect(panel.getByRole('status')).toHaveText(
    'The payment signed here earlier can’t be found any more, so it isn’t shown.',
  );
  await expect(panel.getByRole('textbox', { name: /^To\b/ })).toBeVisible();
  expect(await anchorOf(page)).toBeNull();
});

test('an older payment turning final in another tab never clears the newer one’s anchor', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(90_000);
  const server = await payServer(page);
  server.progress = ['submitted', 'included:safe'];
  const first = await openPay(page);
  await payNow(first);
  await expect(first.locator('.w4-sent-head')).toHaveText('Sent · awaiting finality', {
    timeout: 20_000,
  });
  // The first tab stays on the first payment; a second tab pays again.
  const other = await page.context().newPage();
  server.progress = ['submitted'];
  let second = await openPayByLink(other);
  await payNow(second);
  await expect(second.getByRole('button', { name: 'Cancel this payment' })).toBeVisible({
    timeout: 20_000,
  });
  expect((await anchorOf(other))?.withdrawalId).toBe('w-pay-2');
  // The first payment turns final where it is still open.
  server.ops['w-pay-1']!.progress = ['final'];
  await expect(first.locator('.w4-sent-head')).toHaveText('Paid ✓', { timeout: 20_000 });
  await expect(first).toContainText('12.50 USDC to Harbor');
  expect((await anchorOf(page))?.withdrawalId).toBe('w-pay-2');
  // The second tab still returns to its payment on its way.
  second = await openPayByLink(other);
  await expect(second.getByRole('button', { name: 'Cancel this payment' })).toBeVisible();
  await other.close();
});

test('Withdraw shows an anchored payment as a payment, never as a withdrawal', async ({ page }) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await payServer(page);
  server.progress = ['submitted'];
  const panel = await openPay(page);
  await payNow(panel);
  await expect(panel.getByRole('button', { name: 'Cancel this payment' })).toBeVisible({
    timeout: 20_000,
  });
  await page.goto(`/agents?workspace=v2&theme=light#agent=${scout.id}:wallet-withdraw`);
  const withdraw = page.getByRole('complementary', { name: 'Research scout details' });
  await expect(withdraw.getByRole('list', { name: 'Payment status' })).toBeVisible();
  await expect(withdraw).toContainText('12.50 USDC to Harbor');
  await expect(withdraw.getByRole('button', { name: 'Cancel this payment' })).toBeVisible();
  await expect(withdraw.getByRole('list', { name: 'Withdrawal status' })).toHaveCount(0);
});

/**
 * A payment this browser signed earlier, as its anchor kept it: with `names`, who was paid; without,
 * as before its names were kept (then nothing on Pay may call it a withdrawal). The server reads
 * `progress` for it, as for any payment.
 */
async function anchorEarlier(
  page: Page,
  server: Awaited<ReturnType<typeof payServer>>,
  progress: string[],
  names: boolean,
) {
  const op = operation(HARBOR.wallet, 12_500_000n, WALLET, 3n);
  const hash = ownerOperationHash(op);
  server.ops['w-earlier'] = { hash, progress, signed: true };
  const anchor = {
    withdrawalId: 'w-earlier',
    userOperation: userOperationToRpc(op),
    userOpHash: hash,
    ...(names
      ? {
          payment: {
            name: HARBOR.name,
            short: HARBOR.short,
            baseId: HARBOR.baseId,
            note: null,
          },
        }
      : {}),
  };
  await page.evaluate(([id, value]) => localStorage.setItem(`cc-withdrawal:${id}`, value), [
    scout.id,
    JSON.stringify(anchor),
  ] as const);
}

for (const names of [false, true])
  test(`reopened on a payment already final (${names ? 'with' : 'without'} its names): an empty form and a quiet “Paid ✓”`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const server = await payServer(page);
    await openPay(page);
    await anchorEarlier(page, server, ['final'], names);
    const panel = await openPayByLink(page);
    // Not held on the payment: the form, empty.
    await expect(panel.getByRole('textbox', { name: /^To\b/ })).toHaveValue('', {
      timeout: 20_000,
    });
    await expect(panel.getByLabel('Amount in USDC')).toHaveValue('');
    await expect(panel.getByLabel(/^Note/)).toHaveValue('');
    const line = panel.getByRole('list', { name: 'Sent from this wallet' });
    await expect(line).toHaveText(`12.50 USDC to ${names ? 'Harbor' : '0x3C44…93BC'} · Paid ✓`, {
      timeout: 20_000,
    });
    await expect(panel.getByRole('list', { name: 'Payment status' })).toHaveCount(0);
    await expect(panel.locator('.w4-sent-head')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'New payment' })).toHaveCount(0);
    await expect(panel).not.toContainText('Withdrawn');
    await expect(panel).not.toContainText(/withdrawal/i);
    await shot(page, `pay-reopened-final-${names ? 'named' : 'unnamed'}`);
    // Released, and its record goes once its line was seen: reopened again, nothing of it is left.
    expect(await anchorOf(page)).toBeNull();
    await expect.poll(() => releasedOf(page)).toEqual([]);
    // Opened again from the Wallet screen (a new page load, never the same screen kept open).
    const again = await openPay(page);
    await expect(again.getByRole('textbox', { name: /^To\b/ })).toBeVisible();
    await expect(again.getByRole('list', { name: 'Sent from this wallet' })).toHaveCount(0);
  });

test('reopened on a payment without its names still in a block: its status, as a payment', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const server = await payServer(page);
  await openPay(page);
  await anchorEarlier(page, server, ['included'], false);
  const panel = await openPayByLink(page);
  // On its way: the screen stays on it, as before.
  const steps = panel.getByRole('list', { name: 'Payment status' });
  await expect(steps.locator('li[data-done]')).toHaveCount(3, { timeout: 20_000 });
  await expect(panel).toContainText('12.50 USDC to 0x3C44…93BC');
  await expect(panel).toContainText('The payment carries on');
  await expect(panel.getByRole('textbox', { name: /^To\b/ })).toHaveCount(0);
  expect((await anchorOf(page))?.withdrawalId).toBe('w-earlier');
  // Final while open: paid, never withdrawn.
  server.ops['w-earlier']!.progress = ['final'];
  await expect(panel.locator('.w4-sent-head')).toHaveText('Paid ✓', { timeout: 20_000 });
  await expect(panel).not.toContainText('Withdrawn');
  await expect(panel).not.toContainText(/withdrawal/i);
  expect(await anchorOf(page)).toBeNull();
});

/* ---------- lanes (CITY_BASE_LANES=1): pay without waiting ---------- */

async function payAmount(panel: ReturnType<Page['getByRole']>, usdc: string) {
  await panel.getByRole('textbox', { name: /^To\b/ }).fill(HARBOR.baseId);
  await expect(panel.getByRole('group', { name: 'Recipient' })).toBeVisible();
  await panel.getByLabel('Amount in USDC').fill(usdc);
  await panel.getByRole('button', { name: 'Review payment', exact: true }).click();
  await panel.getByLabel('Wallet password').fill(password);
  await panel
    .getByRole('button', { name: `Pay ${Number(usdc).toFixed(2)} USDC`, exact: true })
    .click();
}

/** Back on an empty form, right after signing: nothing waits for the payment. */
async function expectEmptyForm(panel: ReturnType<Page['getByRole']>) {
  await expect(panel.getByRole('heading', { name: 'Pay', exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(panel.getByRole('textbox', { name: /^To\b/ })).toHaveValue('');
  await expect(panel.getByLabel('Amount in USDC')).toHaveValue('');
  await expect(panel.getByLabel(/^Note/)).toHaveValue('');
  await expect(panel.getByRole('group', { name: 'Recipient' })).toHaveCount(0);
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  await expect(panel.getByRole('list', { name: 'Payment status' })).toHaveCount(0);
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

test('lanes: three payments in a row without waiting; each History line moves on to Paid ✓ by itself', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(150_000);
  const server = await payServer(page);
  server.lanes = true;
  server.progressQueue = [
    ['submitted', 'submitted', 'included:safe', 'included:safe', 'final'],
    ['submitted', 'included:safe', 'final'],
    ['submitted', 'submitted', 'submitted', 'included:safe', 'included:safe', 'final'],
  ];
  const panel = await openPay(page);
  await watchHistory(page);
  for (const [at, usdc] of ['1', '2', '3'].entries()) {
    await payAmount(panel, usdc);
    await expectEmptyForm(panel);
    // Its line is at the top of History at once.
    const lines = panel.getByRole('list', { name: 'History' }).locator('li');
    await expect(lines).toHaveCount(at + 1);
    await expect(lines.first()).toHaveAttribute('data-id', `w-pay-${at + 1}`);
    await expect(lines.first().locator('[data-k="line"]')).toContainText(
      `${Number(usdc).toFixed(2)} USDC to Harbor`,
    );
    // Below the form: the form comes first, the rows under it.
    const form = await panel.getByLabel('Amount in USDC').boundingBox();
    const row = await lines.first().boundingBox();
    expect(row!.y).toBeGreaterThan(form!.y);
  }
  await shot(page, 'pay-lanes-three');
  // Each its own key, its own lane, one signature by the owner key; no single anchor.
  expect(new Set(server.payments.map((each) => each.idempotencyKey)).size).toBe(3);
  expect(server.signatures.map((each) => each.signer)).toEqual([
    server.owner,
    server.owner,
    server.owner,
  ]);
  expect(await anchorOf(page)).toBeNull();
  for (const [id, usdc] of [
    ['w-pay-1', '1.00'],
    ['w-pay-2', '2.00'],
    ['w-pay-3', '3.00'],
  ])
    await expect
      .poll(() => lastSeen(page, id!), { timeout: 60_000 })
      .toBe(`${usdc} USDC to Harbor · Paid ✓`);
  const seen = await seenLines(page);
  for (const [id, usdc] of [
    ['w-pay-1', '1.00'],
    ['w-pay-2', '2.00'],
    ['w-pay-3', '3.00'],
  ]) {
    const steps = seen[id!]!.map((text) => text.replace(`${usdc} USDC to Harbor · `, ''));
    expect(steps[0]).toBe('On its way');
    expect(steps).toContain('Sent · awaiting finality');
    expect(steps[steps.length - 1]).toBe('Paid ✓');
    // Paid only once final, never before.
    expect(steps.indexOf('Paid ✓')).toBe(steps.length - 1);
  }
  await shot(page, 'pay-lanes-paid');
  // Once final, each row leaves for the wallet's own history: the list empties by itself.
  await expect(panel.getByRole('list', { name: 'History' })).toHaveCount(0, { timeout: 40_000 });
  await expectEmptyForm(panel);
  // Done: the records go, and nothing is read any more.
  await expect
    .poll(() => page.evaluate((id) => localStorage.getItem(`cc-withdrawal-lanes:${id}`), scout.id))
    .toBeNull();
  const reads = server.openReads + server.reads;
  await page.waitForTimeout(4_000);
  expect(server.openReads + server.reads).toBe(reads);
});

test('lanes: the cap and funds held by what is on its way are refused in plain words', async ({
  page,
}) => {
  const server = await payServer(page);
  server.lanes = true;
  const panel = await openPay(page);
  server.refuse = {
    code: 'too_many_open',
    error: 'Too many operations are open.',
    details: { max: 100 },
  };
  await fillPayment(panel);
  await expect(panel.getByRole('alert')).toHaveText(
    '100 payments are still on their way. Wait for one to finish.',
  );
  server.refuse = { code: 'too_many_open', error: 'Too many operations are open.' };
  await panel.getByRole('button', { name: 'Review payment', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText(
    '100 payments are still on their way. Wait for one to finish.',
  );
  server.refuse = { code: 'funds_held', error: 'Funds are held.', details: { open: 3 } };
  await panel.getByRole('button', { name: 'Review payment', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText(
    'Not enough USDC while 3 payments are still on their way.',
  );
  server.refuse = { code: 'funds_held', error: 'Funds are held.' };
  await panel.getByRole('button', { name: 'Review payment', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText(
    'Not enough USDC while some payments are still on their way.',
  );
  server.refuse = {
    code: 'sponsor_busy',
    error: 'Many operations are on their way right now; try again in a minute.',
    details: { retryAfterSeconds: 60 },
  };
  await panel.getByRole('button', { name: 'Review payment', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText('Busy right now. Try again in a minute.');
  server.refuse = {
    code: 'sponsor_paused',
    error: 'Several operations from this wallet failed on Base; new ones pause for a while.',
    details: { reverted: 3 },
  };
  await panel.getByRole('button', { name: 'Review payment', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText(
    'Several payments from this wallet didn’t go through on Base, so new ones pause for a while.',
  );
  // The form keeps what was typed; nothing was signed.
  await expect(panel.getByLabel('Amount in USDC')).toHaveValue('12.50');
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  expect(server.signatures).toHaveLength(0);
});

test('lanes: one line is cancelled while the others carry on', async ({ page }) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(120_000);
  const server = await payServer(page);
  server.lanes = true;
  server.progressQueue = [['submitted'], ['submitted', 'included:safe', 'final']];
  const panel = await openPay(page);
  await watchHistory(page);
  await payAmount(panel, '1');
  await expectEmptyForm(panel);
  await payAmount(panel, '2');
  await expectEmptyForm(panel);
  const first = panel.getByRole('list', { name: 'History' }).locator('li[data-id="w-pay-1"]');
  // The password is asked only once the owner picks cancel, on that line.
  const cancel = first.getByRole('button', { name: 'Cancel 1.00 USDC to Harbor' });
  await expect(cancel).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  await cancel.click();
  await first.getByLabel('Wallet password').fill(password);
  await first.getByRole('button', { name: 'Sign the cancel' }).click();
  await expect(historyLine(panel, 'w-pay-1')).toHaveText(/^1\.00 USDC to Harbor · Cancel/, {
    timeout: 20_000,
  });
  await expect
    .poll(() => lastSeen(page, 'w-pay-1'), { timeout: 30_000 })
    .toBe('1.00 USDC to Harbor · Cancelled');
  // The other went on by itself.
  await expect
    .poll(() => lastSeen(page, 'w-pay-2'), { timeout: 30_000 })
    .toBe('2.00 USDC to Harbor · Paid ✓');
  // The cancel: at exactly the first payment's nonce, signed by the owner key.
  expect(server.signatures).toHaveLength(3);
  expect(server.signatures[2]!.path).toMatch(/w-pay-1\/cancel\/signature$/);
  expect(server.signatures[2]!.signer).toBe(server.owner);
  expect(server.ops['w-pay-1']!.cancel!.op.nonce).toBe(server.ops['w-pay-1']!.op!.nonce);
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
});

test('lanes: the page hidden while a cancel is asked: the late answer signs nothing', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(120_000);
  const server = await payServer(page);
  server.lanes = true;
  server.progressQueue = [['submitted']];
  const panel = await openPay(page);
  await payAmount(panel, '1');
  await expectEmptyForm(panel);
  // The server's answer to "cancel" is held until the page has been hidden (the password lock).
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let asked = false;
  await page.route(/\/withdrawals\/[^/]+\/cancel$/, async (route) => {
    asked = true;
    await held;
    await route.fallback();
  });
  const first = panel.getByRole('list', { name: 'History' }).locator('li[data-id="w-pay-1"]');
  const cancel = first.getByRole('button', { name: 'Cancel 1.00 USDC to Harbor' });
  await expect(cancel).toBeVisible({ timeout: 20_000 });
  await cancel.click();
  await first.getByLabel('Wallet password').fill(password);
  await first.getByRole('button', { name: 'Sign the cancel' }).click();
  await expect.poll(() => asked, { timeout: 10_000 }).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  release();
  // The cancel's no-op arrived after the lock: nothing signed, nothing sent.
  await expect
    .poll(() => server.ops['w-pay-1']!.cancel !== undefined, { timeout: 10_000 })
    .toBe(true);
  await page.waitForTimeout(1_500);
  expect(server.signatures).toHaveLength(1);
  expect(server.signatures.some((s) => /\/cancel\/signature$/.test(s.path))).toBe(false);
  expect(server.ops['w-pay-1']!.cancel!.signed).toBe(false);
});

for (const status of [502, 500])
  test(`lanes: a signature taken but answered ${status}: the payment stays tracked, nothing cancelled or made again`, async ({
    page,
  }) => {
    test.skip(!SIGNABLE, NOT_YET);
    test.setTimeout(120_000);
    const server = await payServer(page);
    server.lanes = true;
    server.progressQueue = [
      ['submitted', 'submitted', 'submitted', 'submitted', 'included:safe', 'final'],
    ];
    server.signatureFails = [status];
    const panel = await openPay(page);
    await watchHistory(page);
    await payAmount(panel, '1');
    // Read again, it was taken: an empty form, and the payment its row, cancellable from there.
    await expectEmptyForm(panel);
    await expect(panel.getByRole('alert')).toHaveCount(0);
    const cancel = panel.getByRole('button', { name: 'Cancel 1.00 USDC to Harbor' });
    await expect(cancel).toBeVisible({ timeout: 10_000 });
    expect(
      await page.evaluate((id) => localStorage.getItem(`cc-withdrawal-lanes:${id}`), scout.id),
    ).toContain('w-pay-1');
    // It moves on to paid like any other.
    await expect
      .poll(() => lastSeen(page, 'w-pay-1'), { timeout: 60_000 })
      .toBe('1.00 USDC to Harbor · Paid ✓');
    // Never cancelled, discarded or made again: one create, one signature, one key.
    expect(server.payments).toHaveLength(1);
    expect(server.cancelPosts).toBe(0);
    expect(server.discarded).toEqual([]);
    expect(server.signatures).toHaveLength(1);
    expect(await anchorOf(page)).toBeNull();
  });

test('lanes: a signature not taken and answered 503: the same payment again, never a new one', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(120_000);
  const server = await payServer(page);
  server.lanes = true;
  server.progressQueue = [['submitted', 'included:safe', 'final']];
  server.signatureNotTaken = [503];
  const panel = await openPay(page);
  await watchHistory(page);
  await payAmount(panel, '1');
  // Not known to be sent: still the review of this payment, saying so; nothing discarded.
  await expect(panel.getByRole('alert')).toHaveText(
    'Couldn’t confirm this payment was sent. Nothing new was made: Pay sends this same payment again, Back keeps it in History.',
    { timeout: 20_000 },
  );
  await expect(panel.getByRole('heading', { name: 'Check and pay' })).toBeVisible();
  expect(server.signatures).toHaveLength(0);
  expect(server.cancelPosts).toBe(0);
  // Pay again: the same payment, signed once, then back to an empty form.
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Pay 1.00 USDC', exact: true }).click();
  await expectEmptyForm(panel);
  await expect
    .poll(() => lastSeen(page, 'w-pay-1'), { timeout: 60_000 })
    .toBe('1.00 USDC to Harbor · Paid ✓');
  expect(server.payments).toHaveLength(1);
  expect(server.signatures).toHaveLength(1);
  expect(server.signatures[0]!.path).toMatch(/w-pay-1\/signature$/);
  expect(server.cancelPosts).toBe(0);
  expect(server.discarded).toEqual([]);
});

test('lanes: reopened, the open payments come from the server’s list, one read per tick', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(120_000);
  const server = await payServer(page);
  server.lanes = true;
  server.progressQueue = [['submitted'], ['submitted', 'included:safe']];
  let panel = await openPay(page);
  await payAmount(panel, '1');
  await expectEmptyForm(panel);
  await payAmount(panel, '2');
  await expectEmptyForm(panel);
  // A reload: the form, with what is on its way in History; never one payment held open.
  panel = await openPayByLink(page);
  await expect(panel.getByRole('textbox', { name: /^To\b/ })).toBeVisible();
  await expect(historyLine(panel, 'w-pay-1')).toHaveText('1.00 USDC to Harbor · On its way');
  await expect(historyLine(panel, 'w-pay-2')).toHaveText(
    '2.00 USDC to Harbor · Sent · awaiting finality',
    { timeout: 20_000 },
  );
  // In a block: its Basescan link; not yet in one: none.
  await expect(
    panel.getByRole('link', { name: 'View 2.00 USDC to Harbor on Basescan' }),
  ).toHaveAttribute('href', `https://basescan.org/tx/0x${'ee'.repeat(32)}`);
  await expect(
    panel.getByRole('link', { name: 'View 1.00 USDC to Harbor on Basescan' }),
  ).toHaveCount(0);
  await expect(panel.getByRole('list', { name: 'Payment status' })).toHaveCount(0);
  expect(await anchorOf(page)).toBeNull();
  // Without this browser's records, the lines still come from the server (and, not signed here,
  // can't be cancelled from here).
  await page.evaluate((id) => localStorage.removeItem(`cc-withdrawal-lanes:${id}`), scout.id);
  panel = await openPayByLink(page);
  const lines = panel.getByRole('list', { name: 'History' }).locator('li');
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toHaveAttribute('data-id', 'w-pay-2');
  await expect(lines.nth(1).locator('[data-k="line"]')).toContainText('1.00 USDC to');
  await expect(panel.getByRole('button', { name: /^Cancel/ })).toHaveCount(0);
  // While they stay open: one list read per tick, never a read per line.
  const reads = server.reads;
  const listed = server.openReads;
  await page.waitForTimeout(7_000);
  expect(server.openReads).toBeGreaterThan(listed);
  expect(server.reads).toBe(reads);
});

test('lanes: while one payment sets the wallet up, the next isn’t signed', async ({ page }) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(90_000);
  const server = await payServer(page);
  server.lanes = true;
  server.setup = true;
  server.progress = ['submitted'];
  const panel = await openPay(page);
  await payAmount(panel, '1');
  await expectEmptyForm(panel);
  await fillPayment(panel);
  await expect(panel.getByRole('alert')).toHaveText(
    'Wait a moment: your wallet is being set up on Base.',
  );
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  expect(server.signatures).toHaveLength(1);
  // Prepared but never signed: discarded.
  expect(server.discarded).toEqual(['w-pay-2']);
});

test('lanes absent: one payment at a time as before, and no open list is read', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(60_000);
  const server = await payServer(page);
  server.progress = ['submitted'];
  const panel = await openPay(page);
  await payNow(panel);
  await expect(panel.getByRole('button', { name: 'Cancel this payment' })).toBeVisible({
    timeout: 20_000,
  });
  expect((await anchorOf(page))?.withdrawalId).toBe('w-pay-1');
  await expect(panel.getByRole('list', { name: 'History' })).toHaveCount(0);
  await page.waitForTimeout(4_000);
  expect(server.openReads).toBe(0);
  expect(
    await page.evaluate((id) => localStorage.getItem(`cc-wallet-lanes:${id}`), scout.id),
  ).toBeNull();
});

test('lanes: many on their way: the newest 20 lines, the rest counted, one read per tick', async ({
  page,
}) => {
  test.skip(!SIGNABLE, NOT_YET);
  test.setTimeout(90_000);
  const server = await payServer(page);
  server.lanes = true;
  server.progress = ['submitted'];
  const panel = await openPay(page);
  await payAmount(panel, '1');
  await expectEmptyForm(panel);
  // 24 more signed elsewhere: 25 open in all.
  server.elsewhere = 24;
  const lines = panel.getByRole('list', { name: 'History' }).locator('li');
  await expect(lines).toHaveCount(20, { timeout: 20_000 });
  await expect(lines.first()).toHaveAttribute('data-id', 'w-pay-1');
  await expect(panel.locator('[data-k="more"]')).toHaveText('and 5 more on their way');
  const reads = server.reads;
  const listed = server.openReads;
  await page.waitForTimeout(7_000);
  expect(server.openReads - listed).toBeGreaterThanOrEqual(1);
  expect(server.openReads - listed).toBeLessThanOrEqual(3);
  expect(server.reads).toBe(reads);
});
