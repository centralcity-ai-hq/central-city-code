import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  formatUnits,
  getAddress,
  parseAbi,
  recoverAddress,
  verifyTypedData,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { UserOperation } from 'viem/account-abstraction';
import type { Agent, Snapshot } from '../shared/types';
import type { SpendPermission } from '../shared/base/types';
import { PAY_RECIPIENT_TTL_MS } from '../shared/base/pay';
import { encodeRateCall, rateRegistryOf, type Stars } from '../shared/base/rate';
import {
  berlinDayStart,
  calendarPeriod,
  LIMIT_PERIOD_SECONDS,
  LIMIT_PERMISSION_END,
  onchainAllowance,
  permissionFromJson,
  permissionToJson,
  revokeCall,
  smartWalletMessageTypedData,
  spendPermissionHash,
  type LimitPeriod,
} from '../shared/base/spend-limits';
import { BASE_MAINNET } from '../shared/base/chains';
import { walletChain, WALLET_SPONSORS } from '../shared/base/wallet-chains';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network';
import { ownerOperationHash, userOperationToRpc, withdrawalCall } from '../shared/base/withdraw';
import { ARC_NETWORKS, ARC_TESTNET, ARC_USDC } from '../shared/chains';
import { sealKey } from '../src/base/vault/crypto';
import { expectedWallet } from '../src/base/wallet/derive';

/*
 * The wallet's Withdraw, Spending limit, Pay and Rate for an agent on Arc Testnet, in a real browser.
 * The routes are fixtures in the shapes of server/base/wallet and server/base/pay, with real Arc
 * operations, hashes and typed data; Arc's public endpoint is a fixture too. The owner key is a real
 * locked key; the fixture checks each signature against Arc's own hash. Nothing reaches any chain.
 */

const headers = { 'X-City-Request': '1' };
const password = 'Local-test-only-passphrase-2026';
const NOW = Date.now();
const CHAIN = walletChain(ARC_TESTNET)!;
const NETWORK = ARC_NETWORKS[ARC_TESTNET];
const NAME = 'Arc Testnet';
const EXPLORER = 'https://explorer.testnet.arc.io';
const TX = `0x${'ee'.repeat(32)}`;
const TO = getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc');
const SPENDER = getAddress(`0x${'3c'.repeat(20)}`);
const HARBOR = { agentId: 'agent-harbor', baseId: '12345', short: 'Ab3dE9', name: 'Harbor' };
const RATER = { baseId: '98840', short: 'Wm4tRk' };
const LIMIT_ID = '0f3c2b1a-9e8d-4c7b-8a6f-5e4d3c2b1a09';
const OWNER_KEY = `0x${'4c'.repeat(32)}` as Hex;
const OWNER = privateKeyToAccount(OWNER_KEY).address;
const walletAbi = parseAbi(['function execute(address target, uint256 value, bytes data)']);
const tokenUriAbi = parseAbi(['function tokenURI(uint256 tokenId) view returns (string)']);
/** Arc testnet's pinned sponsor (shared/base/wallet-chains.ts), in the paymaster data's layout. */
const SPONSOR_DATA = `0x${WALLET_SPONSORS[ARC_TESTNET]![0]!.slice(2)}${Math.floor(
  (NOW + 600_000) / 1000,
)
  .toString(16)
  .padStart(12, '0')}${'00'.repeat(103)}${'ab'.repeat(65)}` as Hex;

const scout: Agent = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Research scout',
  visibility: 'public',
  description: 'Synthetic fixture',
  capability: 'research',
  mode: 'external',
  isDemo: false,
  status: 'online',
  lastSeenAt: new Date(NOW - 60_000).toISOString(),
  createdAt: new Date(NOW - 86_400_000).toISOString(),
  revokedAt: null,
};
const WALLET = expectedWallet(OWNER, scout.id, ARC_TESTNET);

const amount = (raw: bigint, decimals: number, display: string) => ({
  raw: raw.toString(),
  decimals,
  display,
});
const NO_FEE = { paidBy: 'sponsor', token: 'USDC', max: amount(0n, 6, '0') };

function operation(callData: Hex): UserOperation<'0.6'> {
  return {
    sender: WALLET,
    nonce: 4n,
    initCode: '0x',
    callData,
    callGasLimit: 120_000n,
    verificationGasLimit: 300_000n,
    preVerificationGas: 60_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    paymasterAndData: SPONSOR_DATA,
    signature: '0x',
  };
}
const executeOf = (call: { target: `0x${string}`; value: bigint; data: Hex }) =>
  encodeFunctionData({
    abi: walletAbi,
    functionName: 'execute',
    args: [call.target, call.value, call.data],
  });

type Refusal = { status: number; code: string; error: string };
type Route = Parameters<Parameters<Page['route']>[1]>[0];

/** One person's vault and one agent's wallet on Arc Testnet, as the routes answer. */
async function arcServer(page: Page) {
  const envelope = await sealKey(OWNER_KEY, password, { N: 2 ** 17 });
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Arc-${randomUUID().slice(0, 8)}`, password },
  });
  expect(registered.status()).toBe(201);
  const person = (
    (await (await page.request.get('/api/session')).json()) as { operator: { id: string } }
  ).operator.id;
  const baseline = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;

  const state = {
    /** What eth_chainId answers: a node that isn't Arc Testnet is refused. */
    nodeChain: `0x${ARC_TESTNET.toString(16)}`,
    /** The chain id an operation or limit is prepared for (another than the agent's is refused). */
    preparedChain: ARC_TESTNET as number,
    /** Every action answers this (not_on_arc_yet, other_chain). */
    refusal: null as Refusal | null,
    walletDown: false,
    rpc: [] as Array<{ method: string; to?: string }>,
    /** Every request this page made to another host than this server. */
    outside: [] as string[],
    lookups: [] as string[],
    signatures: [] as Array<{ path: string; signer: string }>,
    limitSignatures: [] as boolean[],
    hashes: {} as Record<string, Hex>,
    prepared: null as SpendPermission | null,
    limit: null as null | {
      permission: SpendPermission;
      capRaw: string;
      period: LimitPeriod;
      state: 'signed' | 'approved' | 'revoke_pending';
      revoke: null | { state: string; userOpHash: Hex; txHash: null; expiresAt: number | null };
    },
    incoming: [] as unknown[],
    agentPayments: [] as unknown[],
    /** The scout's registration on Arc Testnet: final, with a passport, so it may rate. */
    identity: {
      chainId: ARC_TESTNET,
      state: 'confirmed',
      stage: 'confirmed',
      erc8004AgentId: RATER.baseId,
      agentUri: `https://centralcity.ai/a/${RATER.short}`,
      finality: 'final',
    } as Record<string, unknown> | null,
    /** The registration read answers this status instead. */
    registrationStatus: 200,
    /** The agent has no wallet yet. */
    noWallet: false,
    /** What /api/public/arc/rated answers: 200 while the server has Arc on. */
    arcRated: 404,
    passportReads: [] as string[],
  };

  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1')
      state.outside.push(url.origin);
  });
  const refused = (route: Route) => {
    const { status, code, error } = state.refusal!;
    return route.fulfill({ status, json: { error, code } });
  };

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
    state.noWallet
      ? route.fulfill({ json: { wallet: null } })
      : state.walletDown
        ? route.fulfill({
            status: 503,
            json: {
              error: `${NAME} could not be read.`,
              code: 'chain_unavailable',
              details: { chainId: ARC_TESTNET },
            },
          })
        : route.fulfill({
            json: {
              chainId: ARC_TESTNET,
              network: NAME,
              testnet: true,
              gasAsset: 'USDC',
              address: WALLET,
              ownerAddress: OWNER,
              spenderAddress: SPENDER,
              deployed: true,
              fundingLocked: false,
              usdc: amount(25_000_000n, 6, '25'),
              eth: amount(0n, 18, '0'),
              readAtBlock: 18_402_113,
              readAt: Date.now(),
              stale: false,
              explorerUrl: `${EXPLORER}/address/${WALLET}`,
            },
          }),
  );
  await page.route('**/api/base/agents/*/wallet/history*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Not found.' } }),
  );
  await page.route('**/api/base/pay/incoming*', (route) =>
    route.fulfill({
      json: { payments: state.incoming, cursor: 'c1', hasMore: false },
    }),
  );
  await page.route('**/api/base/agents/*/wallet/agent-payments', (route) =>
    route.fulfill({ json: { payments: state.agentPayments } }),
  );
  await page.route('**/api/base/agents/*/registration', (route) =>
    state.registrationStatus === 200
      ? route.fulfill({ json: { identities: state.identity ? [state.identity] : [] } })
      : route.fulfill({ status: state.registrationStatus, json: { error: 'Try again.' } }),
  );
  await page.route('**/api/public/arc/rated**', (route) =>
    route.fulfill({
      status: state.arcRated,
      json: state.arcRated === 200 ? { agents: [] } : {},
    }),
  );
  await page.route(/\/api\/public\/(arc|base)\/agents\/\d+$/, (route) => {
    state.passportReads.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 404, json: { error: 'Not found.' } });
  });

  // Arc's public endpoint, as this browser reads it: who it is, the head, then the call at it.
  await page.route(`${NETWORK.publicRpcUrl}/**`, (route) => {
    const call = route.request().postDataJSON() as {
      id: number;
      method: string;
      params: Array<{ to?: string; data?: Hex }>;
    };
    state.rpc.push({ method: call.method, to: call.params?.[0]?.to });
    const answer = (result: unknown) =>
      route.fulfill({ json: { jsonrpc: '2.0', id: call.id, result } });
    if (call.method === 'eth_chainId') return answer(state.nodeChain);
    if (call.method === 'eth_blockNumber') return answer('0x3203b10');
    const data = call.params[0]!.data!;
    // ownerOf(Base ID): Pay. tokenURI(Base ID): Rate.
    if (data.startsWith('0x6352211e'))
      return answer(`0x${'0'.repeat(24)}${TO.slice(2).toLowerCase()}`);
    decodeFunctionData({ abi: tokenUriAbi, data });
    return answer(
      encodeFunctionResult({
        abi: tokenUriAbi,
        functionName: 'tokenURI',
        result: `https://centralcity.ai/a/${HARBOR.short}`,
      }),
    );
  });
  // Base's endpoint must never be asked on these flows; if it is, the test says so.
  await page.route('https://mainnet.base.org/**', (route) => route.abort('failed'));

  /** One operation prepared: signed over Arc's hash unless the fixture says another chain. */
  const prepared = (id: string, op: UserOperation<'0.6'>, extra: Record<string, unknown>) => {
    const hash = ownerOperationHash(op, CHAIN.owner);
    state.hashes[id] = hash;
    return {
      withdrawalId: id,
      state: 'awaiting_signature',
      userOperation: userOperationToRpc(op),
      userOpHash: hash,
      entryPoint: CHAIN.owner.entryPoint,
      chainId: state.preparedChain,
      expiresAt: NOW + 600_000,
      ...extra,
    };
  };
  const summaryOf = (raw: bigint, to: string) => ({
    kind: 'withdraw',
    token: 'USDC',
    amount: amount(raw, 6, formatUnits(raw, 6)),
    from: WALLET,
    to,
    network: NAME,
    testnet: true,
    sponsored: true,
    fee: NO_FEE,
    deploysWallet: false,
    toIsContract: false,
  });
  const viewOf = (id: string, withdrawalState: string, to: string = TO) => ({
    withdrawalId: id,
    state: withdrawalState,
    safe: withdrawalState === 'final',
    token: 'USDC',
    amount: amount(12_500_000n, 6, '12.5'),
    from: WALLET,
    to,
    network: NAME,
    chainId: ARC_TESTNET,
    userOpHash: state.hashes[id],
    sponsored: true,
    fee: NO_FEE,
    txHash: withdrawalState === 'submitted' ? null : TX,
    blockNumber: withdrawalState === 'submitted' ? null : 52_441_300,
    errorCode: null,
    explorerUrl: withdrawalState === 'submitted' ? null : `${EXPLORER}/tx/${TX}`,
    expiresAt: null,
    cancel: null,
    createdAt: NOW,
    updatedAt: Date.now(),
  });

  await page.route('**/api/base/agents/*/wallet/withdrawals**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST' && url.pathname.endsWith('/withdrawals')) {
      if (state.refusal) return refused(route);
      const body = route.request().postDataJSON() as { amount: string; to: string };
      const raw = BigInt(body.amount);
      const call = withdrawalCall('USDC', getAddress(body.to), raw, CHAIN.owner);
      return route.fulfill({
        status: 201,
        json: prepared('w-1', operation(executeOf(call)), {
          summary: summaryOf(raw, getAddress(body.to)),
        }),
      });
    }
    if (url.searchParams.get('open') === '1')
      return route.fulfill({ status: 404, json: { error: 'Not found.' } });
    const id = decodeURIComponent(url.pathname.split('/withdrawals/')[1]!.split('/')[0]!);
    const to = id.startsWith('w-rate') ? rateRegistryOf(ARC_TESTNET)! : TO;
    if (route.request().method() === 'POST' && url.pathname.endsWith('/signature')) {
      const { signature } = route.request().postDataJSON() as { signature: Hex };
      state.signatures.push({
        path: url.pathname,
        signer: await recoverAddress({ hash: state.hashes[id]!, signature }),
      });
      return route.fulfill({ status: 202, json: viewOf(id, 'included', to) });
    }
    return route.fulfill({ json: viewOf(id, 'final', to) });
  });

  // Pay: the lookup on the agent's chain, then the payment answered as a withdrawal.
  await page.route('**/api/base/pay/recipient?*', (route) => {
    state.lookups.push(route.request().url());
    if (state.refusal) return refused(route);
    return route.fulfill({ json: recipient() });
  });
  const recipient = () => {
    const at = Date.now();
    return {
      kind: 'central_city_agent',
      baseId: HARBOR.baseId,
      short: HARBOR.short,
      name: HARBOR.name,
      wallet: TO,
      registry: NETWORK.contracts.identityRegistry,
      chainId: ARC_TESTNET,
      verification: 'point_in_time',
      lookupId: `lk_${at}`,
      verified: { block: 52_441_231, blockHash: `0x${'aa'.repeat(32)}`, at },
      expiresAt: at + PAY_RECIPIENT_TTL_MS,
    };
  };
  await page.route('**/api/base/agents/*/wallet/payments', (route) => {
    if (state.refusal) return refused(route);
    const body = route.request().postDataJSON() as { amount: string; note: string | null };
    const raw = BigInt(body.amount);
    const call = withdrawalCall('USDC', TO, raw, CHAIN.owner);
    return route.fulfill({
      status: 201,
      json: prepared('w-pay-1', operation(executeOf(call)), {
        summary: summaryOf(raw, TO),
        payment: { paymentId: 'p-1', recipient: recipient(), note: body.note },
      }),
    });
  });

  // Rate: the lookup, then the rating answered as a withdrawal is.
  await page.route('**/api/base/agents/*/wallet/ratings/lookup', (route) => {
    if (state.refusal) return refused(route);
    const body = route.request().postDataJSON() as { baseId: string; passport: string };
    return route.fulfill({
      json: {
        lookupId: `lk_${body.baseId}_1`,
        agent: {
          agentId: HARBOR.agentId,
          name: HARBOR.name,
          baseId: body.baseId,
          short: body.passport,
        },
        checkedAtBlock: 52_441_231,
        expiresAt: Date.now() + 300_000,
      },
    });
  });
  await page.route('**/api/base/agents/*/wallet/ratings', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ratings: [] } });
    if (state.refusal) return refused(route);
    const body = route.request().postDataJSON() as { stars: Stars };
    const registry = rateRegistryOf(ARC_TESTNET)!;
    const op = operation(encodeRateCall(BigInt(HARBOR.baseId), body.stars, registry));
    return route.fulfill({
      status: 201,
      json: prepared('w-rate-1', op, {
        summary: {
          kind: 'rate',
          registry,
          agentId: HARBOR.baseId,
          value: String(body.stars * 20),
          tag1: 'starred',
          stars: body.stars,
          from: WALLET,
          network: NAME,
          testnet: true,
          sponsored: true,
          fee: NO_FEE,
          deploysWallet: false,
        },
      }),
    });
  });

  // Spending limits on Arc: real permissions and hashes over Arc's manager and USDC.
  const display = (raw: bigint) => formatUnits(raw, 6);
  const limitChain = CHAIN.limit!;
  const summary = (limit: NonNullable<typeof state.limit>) => ({
    permissionId: LIMIT_ID,
    token: 'USDC',
    capRaw: limit.capRaw,
    capDisplay: display(BigInt(limit.capRaw)),
    onchainModel: 'half',
    allowanceRaw: limit.permission.allowance.toString(),
    allowanceDisplay: display(limit.permission.allowance),
    boundaryBurstRaw: (limit.permission.allowance * 2n).toString(),
    period: limit.period,
    periodSeconds: limit.permission.period,
    permissionHash: spendPermissionHash(limitChain, limit.permission),
    state: limit.state,
    createdAt: NOW,
  });
  const limitsView = () => {
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000);
    const limits = state.limit ? [state.limit] : [];
    return {
      chainId: ARC_TESTNET,
      network: NAME,
      testnet: true,
      onchainModel: 'half',
      stale: false,
      readAtBlock: 18_402_120,
      readAt: nowMs,
      limits: limits.map((limit) => {
        const p = limit.permission;
        const window = calendarPeriod(limit.period, nowMs);
        return {
          ...summary(limit),
          onchain: {
            start: p.start,
            end: p.end,
            currentPeriodStart: p.start,
            currentPeriodEnd: p.start + p.period,
            spentRaw: '0',
            leftRaw: p.allowance.toString(),
            readAtBlock: 18_402_120,
            blockTime: now,
            phase: 'active',
            approved: limit.state === 'approved',
            revoked: false,
          },
          calendar: {
            periodStart: window.start,
            periodEnd: window.end,
            spentRaw: '0',
            leftRaw: limit.capRaw,
            timeZone: 'Europe/Berlin',
          },
          revoke: limit.revoke,
        };
      }),
    };
  };
  await page.route('**/api/base/agents/*/wallet/limits**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET') return route.fulfill({ json: limitsView() });
    if (state.refusal) return refused(route);
    if (path.endsWith('/limits/prepare')) {
      const body = route.request().postDataJSON() as { capRaw: string; period: LimitPeriod };
      const cap = BigInt(body.capRaw);
      const permission: SpendPermission = {
        account: WALLET,
        spender: SPENDER,
        token: ARC_USDC,
        allowance: onchainAllowance(cap, 'half'),
        period: LIMIT_PERIOD_SECONDS[body.period],
        start: berlinDayStart(Date.now()),
        end: LIMIT_PERMISSION_END,
        salt: BigInt(`0x${randomBytes(32).toString('hex')}`),
        extraData: '0x',
      };
      state.prepared = permission;
      const hash = spendPermissionHash(limitChain, permission);
      return route.fulfill({
        json: {
          chainId: state.preparedChain,
          token: 'USDC',
          capRaw: body.capRaw,
          capDisplay: display(cap),
          onchainModel: 'half',
          allowanceRaw: permission.allowance.toString(),
          allowanceDisplay: display(permission.allowance),
          boundaryBurstRaw: (permission.allowance * 2n).toString(),
          period: body.period,
          periodSeconds: permission.period,
          permission: permissionToJson(permission),
          permissionHash: hash,
          typedData: smartWalletMessageTypedData(ARC_TESTNET, WALLET, hash),
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
      const permission = permissionFromJson(body.permission)!;
      const hash = spendPermissionHash(limitChain, permission);
      // Signed by the owner key over the wallet's wrapper on Arc, not on any other chain.
      state.limitSignatures.push(
        await verifyTypedData({
          address: OWNER,
          ...smartWalletMessageTypedData(ARC_TESTNET, WALLET, hash),
          signature: body.signature,
        }),
      );
      state.limit = {
        permission,
        capRaw: body.capRaw,
        period: body.period,
        state: 'signed',
        revoke: null,
      };
      return route.fulfill({
        status: 201,
        json: { ...summary(state.limit), start: permission.start, end: permission.end },
      });
    }
    const limit = state.limit!;
    if (path.endsWith('/revoke')) {
      const call = revokeCall(limitChain, limit.permission);
      const op = operation(executeOf(call));
      const hash = ownerOperationHash(op, CHAIN.owner);
      state.hashes.revoke = hash;
      limit.state = 'revoke_pending';
      limit.revoke = {
        state: 'awaiting_signature',
        userOpHash: hash,
        txHash: null,
        expiresAt: Date.now() + 600_000,
      };
      return route.fulfill({
        json: {
          permissionId: LIMIT_ID,
          state: 'revoke_pending',
          revokeState: 'awaiting_signature',
          chainId: state.preparedChain,
          entryPoint: CHAIN.owner.entryPoint,
          userOperation: userOperationToRpc(op),
          userOpHash: hash,
          expiresAt: Date.now() + 600_000,
          summary: {
            action: 'revoke_limit',
            wallet: WALLET,
            contract: CHAIN.manager,
            permissionHash: spendPermissionHash(limitChain, limit.permission),
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
      state.signatures.push({
        path,
        signer: await recoverAddress({ hash: state.hashes.revoke!, signature }),
      });
      limit.revoke = {
        state: 'submitted',
        userOpHash: state.hashes.revoke!,
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
  return state;
}

type Server = Awaited<ReturnType<typeof arcServer>>;

async function openAgent(page: Page) {
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
  return page.getByRole('complementary', { name: 'Research scout details' });
}

async function openWallet(page: Page) {
  const panel = await openAgent(page);
  await panel.locator('[data-k="row-wallet"]').click();
  await expect(panel.locator('.w4-hero')).toBeVisible();
  return panel;
}

/** The agent's registration screen, from its home's row; `chain` is what that row and title say. */
async function openRegistration(page: Page, chain = NAME) {
  const panel = await openAgent(page);
  await panel.locator('[data-k="row-base"]').getByRole('button').first().click();
  const screen = panel.getByRole('region', { name: `Research scout · ${chain}`, exact: true });
  await expect(screen.getByRole('heading', { name: chain, exact: true })).toBeVisible();
  return screen;
}

async function openScreen(page: Page, button: string, heading: string) {
  const panel = await openWallet(page);
  await panel.getByRole('button', { name: button, exact: true }).click();
  await expect(panel.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  return panel;
}

const openLimits = async (page: Page) => {
  const panel = await openWallet(page);
  await panel.locator('[data-k="row-limit"]').click();
  await expect(panel.getByRole('heading', { name: 'Spending limit' })).toBeVisible();
  return panel;
};

/** Nothing on the screen says Base, Basescan or ETH to someone on Arc. */
async function saysOnlyArc(panel: Locator) {
  await expect(panel).not.toContainText(/\bBase\b|Basescan|basescan|\bETH\b/);
}

/** No request left for Base's endpoint; every chain read went to Arc's, none anywhere else. */
function readOnlyArc(server: Server) {
  expect([...new Set(server.outside)].filter((one) => one !== NETWORK.publicRpcUrl)).toEqual([]);
}

const fillWithdrawal = async (panel: Locator) => {
  await panel.getByLabel('Amount in USDC').fill('12.50');
  await panel.getByLabel(`To address on ${NAME}`).fill(TO.toLowerCase());
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
};
const fillPayment = async (panel: Locator) => {
  await panel.getByRole('textbox', { name: /^To\b/ }).fill(HARBOR.baseId);
  await expect(panel.getByRole('group', { name: 'Recipient' })).toBeVisible();
  await panel.getByLabel('Amount in USDC').fill('12.50');
  await panel.getByRole('button', { name: 'Review payment', exact: true }).click();
};
const findHarbor = async (panel: Locator) => {
  await panel.getByLabel('Arc ID', { exact: true }).fill(HARBOR.baseId);
  await panel.getByLabel('Passport number', { exact: true }).fill(HARBOR.short);
};

test('the wallet on Arc: its lists name Arc IDs and link to Arc’s explorer; no ETH', async ({
  page,
}) => {
  const server = await arcServer(page);
  const tx = `${EXPLORER}/tx/${TX}`;
  server.incoming = [
    {
      paymentId: 'in-1',
      withdrawalId: 'w-in-1',
      state: 'final',
      from: { name: 'Lighthouse', baseId: '777', short: 'Qz7pLm', wallet: TO },
      to: { agentId: scout.id, name: scout.name, baseId: '98840', short: 'Wm4tRk', wallet: WALLET },
      token: 'USDC',
      amount: amount(2_500_000n, 6, '2.5'),
      note: null,
      text: '',
      txHash: TX,
      explorerUrl: tx,
      createdAt: NOW,
      updatedAt: NOW,
      finalAt: NOW,
    },
  ];
  server.agentPayments = [
    {
      paymentId: 'out-1',
      by: 'agent',
      state: 'final',
      to: { agentId: 'a2', name: 'Harbor', baseId: HARBOR.baseId, short: HARBOR.short, wallet: TO },
      token: 'USDC',
      amount: amount(1_000_000n, 6, '1'),
      txHash: TX,
      explorerUrl: tx,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  const panel = await openWallet(page);
  await expect(panel.locator('.w4-net')).toHaveText(NAME);
  const incoming = panel.getByLabel('Payments to Research scout', { exact: true });
  await expect(incoming).toContainText('Arc ID 777');
  await expect(incoming.getByRole('link', { name: 'Arc’s explorer' })).toHaveAttribute('href', tx);
  const outgoing = panel.getByLabel('Payments from Research scout', { exact: true });
  await expect(outgoing).toContainText(`Arc ID ${HARBOR.baseId}`);
  await expect(outgoing.getByRole('link', { name: 'Arc’s explorer' })).toHaveAttribute('href', tx);
  await saysOnlyArc(panel);
  readOnlyArc(server);
});

const IDENTITY = {
  chainId: ARC_TESTNET,
  erc8004AgentId: null,
  agentUri: `https://centralcity.ai/a/${RATER.short}`,
};

test('registering on Arc: named Arc, on its home row and its screen', async ({ page }) => {
  const server = await arcServer(page);
  server.identity = { ...IDENTITY, state: 'submitted', stage: 'registering', startedAt: NOW };
  const home = await openAgent(page);
  // The row is named for the standard (#898); its screen names the chain.
  await expect(home.locator('[data-k="row-base"]')).toContainText('ERC-8004');
  await expect(home.locator('[data-k="row-base"]')).toContainText('Registering');
  await expect(home.locator('[data-k="row-base"]')).not.toContainText(/\bBase\b/);
  const screen = await openRegistration(page);
  await expect(screen.getByText(`Registering on ${NAME}`, { exact: true })).toBeVisible();
  await saysOnlyArc(screen);
});

test('taking longer on Arc: Arc is the one that is busy', async ({ page }) => {
  const server = await arcServer(page);
  server.identity = {
    ...IDENTITY,
    state: 'submitted',
    stage: 'registering',
    startedAt: Date.now() - 120_000,
  };
  const screen = await openRegistration(page);
  await expect(screen.getByText(`${NAME} is busy. It continues by itself.`)).toBeVisible();
  await saysOnlyArc(screen);
});

test('re-checking on Arc: named Arc', async ({ page }) => {
  const server = await arcServer(page);
  server.identity = { ...IDENTITY, state: 'submitted', stage: 'rechecking' };
  const screen = await openRegistration(page);
  await expect(screen.getByText(`Re-checking on ${NAME}`, { exact: true })).toBeVisible();
  await saysOnlyArc(screen);
});

test('finalizing on Arc: an Arc ID, and not Base’s 15–30 minutes', async ({ page }) => {
  const server = await arcServer(page);
  server.identity = {
    ...IDENTITY,
    state: 'submitted',
    stage: 'finalizing',
    provisionalAgentId: RATER.baseId,
    idSeenAt: NOW,
  };
  const home = await openAgent(page);
  await expect(home.locator('.v4b-sub')).toHaveText(`Finalizing on ${NAME} · usually a moment`);
  const screen = await openRegistration(page);
  await expect(screen.getByText('Arc ID', { exact: true })).toBeVisible();
  await expect(screen.locator('.v4b-sub')).toContainText(
    `Finalizing on ${NAME} · usually a moment`,
  );
  await screen.getByRole('button', { name: 'More', exact: true }).click();
  await expect(screen.locator('.v4b-more')).toContainText(
    `Live now. ${NAME} finalizes in a moment.`,
  );
  await saysOnlyArc(screen);
  await expect(screen).not.toContainText(/15–30/);
});

test('final on Arc: Arc ID, Arc’s explorer, and the passport read on Arc only', async ({
  page,
}) => {
  const server = await arcServer(page);
  server.identity = { ...server.identity, txHash: TX };
  const screen = await openRegistration(page);
  await expect(screen.getByText('Arc ID', { exact: true })).toBeVisible();
  await expect(screen.getByRole('link', { name: /Arc’s explorer/ })).toHaveAttribute(
    'href',
    `${EXPLORER}/tx/${TX}`,
  );
  await saysOnlyArc(screen);
  // The same number on Base is another agent: its score must never show here.
  await expect.poll(() => server.passportReads.length).toBeGreaterThan(0);
  expect([...new Set(server.passportReads)]).toEqual([`/api/public/arc/agents/${RATER.baseId}`]);
});

test('Arc chosen on the start: the offer names Arc before anything is registered', async ({
  page,
}) => {
  const server = await arcServer(page);
  server.identity = null;
  server.arcRated = 200;
  const panel = await openAgent(page);
  await panel.locator('[data-k="row-base"]').getByRole('button').first().click();
  const before = panel.getByRole('region', { name: 'Research scout · Base or Arc', exact: true });
  await before.getByRole('radio', { name: /^Arc/ }).check();
  await before.getByRole('button', { name: 'Continue', exact: true }).click();
  const screen = panel.getByRole('region', { name: 'Research scout · Arc', exact: true });
  await expect(screen.getByText('Give Research scout an Arc identity')).toBeVisible();
  await expect(screen.getByText('Its own ID and wallet on Arc. Free.')).toBeVisible();
  await saysOnlyArc(screen);
});

for (const [arcRated, line] of [
  [200, 'The registration status couldn’t be loaded.'],
  [404, 'The Base registration status couldn’t be loaded.'],
] as const) {
  test(`status not read, chain not known, ${arcRated === 200 ? 'Arc on: no chain named' : 'Arc off: as it was'}`, async ({
    page,
  }) => {
    const server = await arcServer(page);
    server.registrationStatus = 500;
    server.arcRated = arcRated;
    const panel = await openAgent(page);
    await panel.locator('[data-k="row-base"]').getByRole('button').first().click();
    await expect(panel.getByRole('alert')).toHaveText(line);
  });
}

for (const [arcRated, line] of [
  // Arc on and no chain known: the chain is asked before a wallet is made (#905).
  [
    200,
    'Your wallet key is ready. Choose where Research scout registers: its wallet is made there.',
  ],
  [
    404,
    `Your wallet key is ready. Create Research scout’s wallet ${
      WALLET_CHAIN_ID === BASE_MAINNET ? 'on Base' : 'on the test network'
    }.`,
  ],
] as const) {
  test(`create a wallet, chain not known, ${arcRated === 200 ? 'Arc on: no chain named' : 'Arc off: as it was'}`, async ({
    page,
  }) => {
    const server = await arcServer(page);
    server.noWallet = true;
    server.identity = null;
    server.arcRated = arcRated;
    const panel = await openAgent(page);
    await panel.locator('[data-k="row-wallet"]').click();
    await expect(panel.locator('.w4-lead')).toHaveText(line);
  });
}

test('Arc not answering: the wallet says which chain, calmly', async ({ page }) => {
  const server = await arcServer(page);
  server.walletDown = true;
  await page.goto('/?workspace=v2&theme=light#connect');
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
  const row = panel.locator('[data-k="row-wallet"]');
  await expect(row).toContainText(`${NAME} isn’t answering`);
  await row.click();
  await expect(panel).toContainText(
    `${NAME} isn’t answering right now, so the balance can’t be read.`,
  );
  await saysOnlyArc(panel);
});

test('withdraw on Arc: USDC only, named Arc, signed over Arc’s hash, Arc’s explorer at the end', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const server = await arcServer(page);
  const panel = await openScreen(page, 'Withdraw', 'Withdraw');
  await expect(panel.getByRole('radiogroup', { name: 'Token' })).toHaveCount(0);
  await expect(panel).toContainText(`to an address of yours on ${NAME}.`);
  await expect(panel).toContainText(`Only an address on ${NAME}.`);
  await saysOnlyArc(panel);

  await fillWithdrawal(panel);
  await expect(panel.getByRole('heading', { name: 'Check and sign' })).toBeVisible();
  await expect(panel).toContainText(`${NAME} · test network, no real money`);
  await expect(panel).toContainText('12.50 USDC');
  await saysOnlyArc(panel);

  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Sign and send', exact: true }).click();
  await expect(panel.locator('.w4-sent-head')).toHaveText('Withdrawn ✓', { timeout: 20_000 });
  await expect(panel.getByRole('link', { name: 'View on Arc’s explorer' })).toHaveAttribute(
    'href',
    `${EXPLORER}/tx/${TX}`,
  );
  await saysOnlyArc(panel);
  expect(server.signatures).toEqual([expect.objectContaining({ signer: OWNER })]);
  readOnlyArc(server);
});

test('withdraw: an operation for another chain than the agent’s signs nothing', async ({
  page,
}) => {
  const server = await arcServer(page);
  server.preparedChain = 8453;
  const panel = await openScreen(page, 'Withdraw', 'Withdraw');
  await fillWithdrawal(panel);
  await expect(panel.getByRole('alert')).toContainText('Not signed:');
  await expect(panel.getByRole('alert')).not.toContainText('Base');
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  expect(server.signatures).toHaveLength(0);
});

test('a limit on Arc: named Arc throughout, signed over Arc’s typed data, and revoked', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const server = await arcServer(page);
  const panel = await openLimits(page);
  await expect(panel.locator('[data-k="limit-lead"]')).toContainText(`${NAME} holds it`);
  await saysOnlyArc(panel);
  await panel.getByLabel('Limit in USDC').fill('20');
  await panel.getByRole('radio', { name: 'A day' }).click();
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Check and sign' })).toBeVisible();
  await expect(panel.locator('[data-k="enforced"]')).toHaveText(
    `${NAME} enforces 10.00 USDC per ${NAME} day, so even around midnight Research scout stays within 20.00.`,
  );
  await expect(panel).toContainText(`${NAME} days start at 00:00 Berlin time (`);
  await expect(panel).toContainText(`${NAME} · test network, no real money.`);
  await saysOnlyArc(panel);

  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Sign', exact: true }).click();
  const card = panel.locator('[data-k="limit-card"]');
  await expect(card.locator('.w4-state')).toHaveText(
    `Signed · waiting for its first use on ${NAME}.`,
    {
      timeout: 20_000,
    },
  );
  await expect(panel.locator('[data-k="base-period"]')).toContainText(`This ${NAME} day`);
  await saysOnlyArc(panel);
  expect(server.limitSignatures).toEqual([true]);

  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(card.locator('.w4-state')).toHaveText(
    `Revoking… Research scout’s spends are blocked now; the revoke is on its way to ${NAME}.`,
    { timeout: 20_000 },
  );
  await saysOnlyArc(panel);
  expect(server.signatures).toEqual([expect.objectContaining({ signer: OWNER })]);
  readOnlyArc(server);
});

test('a limit for another chain than the agent’s signs nothing', async ({ page }) => {
  const server = await arcServer(page);
  server.preparedChain = 8453;
  const panel = await openLimits(page);
  await panel.getByLabel('Limit in USDC').fill('20');
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Not signed:');
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  expect(server.limitSignatures).toHaveLength(0);
});

test('pay on Arc: looked up and read on Arc, signed over Arc’s hash; Base is never asked', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const server = await arcServer(page);
  const panel = await openScreen(page, 'Pay', 'Pay');
  await saysOnlyArc(panel);
  await fillPayment(panel);
  await expect(panel.getByRole('heading', { name: 'Check and pay' })).toBeVisible();
  await expect(panel).toContainText(`to Harbor · Arc ID ${HARBOR.baseId}`);
  await saysOnlyArc(panel);
  expect(server.lookups[0]).toContain(`chain=${ARC_TESTNET}`);

  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Pay 12.50 USDC', exact: true }).click();
  await expect(panel.locator('.w4-sent-head')).toHaveText('Paid ✓', { timeout: 20_000 });
  await expect(panel.getByRole('link', { name: 'View on Arc’s explorer' })).toHaveAttribute(
    'href',
    `${EXPLORER}/tx/${TX}`,
  );
  await saysOnlyArc(panel);
  expect(server.signatures).toEqual([expect.objectContaining({ signer: OWNER })]);
  // Every read at Arc's endpoint; the owner read in Arc's registry, after the node said who it is.
  expect(server.rpc[0]!.method).toBe('eth_chainId');
  const owners = server.rpc.filter((call) => call.method === 'eth_call');
  expect(owners.length).toBeGreaterThanOrEqual(2);
  for (const call of owners) expect(call.to).toBe(NETWORK.contracts.identityRegistry);
  readOnlyArc(server);
});

test('pay: a node that says it is another chain is refused; nothing is read from it', async ({
  page,
}) => {
  const server = await arcServer(page);
  server.nodeChain = '0x2105';
  const panel = await openScreen(page, 'Pay', 'Pay');
  // This browser's own read comes with the review, before the password is ever asked.
  await fillPayment(panel);
  await expect(panel.getByRole('alert')).toHaveText(`That node isn’t ${NAME}. Nothing was signed.`);
  await expect(panel.getByLabel('Wallet password')).toHaveCount(0);
  expect(server.rpc.map((call) => call.method)).not.toContain('eth_call');
  expect(server.signatures).toHaveLength(0);
  readOnlyArc(server);
});

test('rate on Arc: read on Arc, signed over Arc’s hash, Arc’s registry; Base is never asked', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const server = await arcServer(page);
  const panel = await openScreen(page, 'Rate', 'Rate an agent');
  await expect(panel).toContainText(`Rate another Central City agent on ${NAME}`);
  await saysOnlyArc(panel);
  await findHarbor(panel);
  const card = panel.getByRole('group', { name: 'Agent to rate' });
  await expect(card).toContainText(`Arc ID ${HARBOR.baseId}`);
  await expect(card).toContainText(`✓ Passport read from ${NAME}`);
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Rate Harbor', exact: true })).toBeVisible();
  await expect(panel).toContainText(`Public on ${NAME} and stays there.`);
  await saysOnlyArc(panel);

  await panel.locator('.w4-pick-star').nth(3).click();
  await panel.getByLabel('Wallet password').fill(password);
  await panel.getByRole('button', { name: 'Rate Harbor', exact: true }).click();
  await expect(panel.getByRole('link', { name: 'View on Arc’s explorer' })).toHaveAttribute(
    'href',
    `${EXPLORER}/tx/${TX}`,
    { timeout: 20_000 },
  );
  await saysOnlyArc(panel);
  expect(server.signatures).toEqual([expect.objectContaining({ signer: OWNER })]);
  expect(server.rpc[0]!.method).toBe('eth_chainId');
  for (const call of server.rpc.filter((one) => one.method === 'eth_call'))
    expect(call.to).toBe(NETWORK.contracts.identityRegistry);
  readOnlyArc(server);
});

test('rate: a node that says it is another chain is refused; nothing is read from it', async ({
  page,
}) => {
  const server = await arcServer(page);
  server.nodeChain = '0x2105';
  const panel = await openScreen(page, 'Rate', 'Rate an agent');
  await findHarbor(panel);
  await expect(panel.getByRole('alert')).toHaveText(`That node isn’t ${NAME}. Nothing was signed.`);
  await expect(panel.getByRole('group', { name: 'Agent to rate' })).toHaveCount(0);
  expect(server.rpc.map((call) => call.method)).not.toContain('eth_call');
  readOnlyArc(server);
});

const NOT_ON_ARC: Refusal = {
  status: 409,
  code: 'not_on_arc_yet',
  error: 'server wording that must not show',
};
const OTHER_CHAIN: Refusal = {
  status: 409,
  code: 'other_chain',
  error: 'server wording that must not show',
};
const CALM = [
  [NOT_ON_ARC, 'Not available on Arc yet.'],
  [OTHER_CHAIN, 'This agent is on another chain, so this isn’t available for it.'],
] as const;

for (const [refusal, line] of CALM) {
  test(`${refusal.code} reads calmly on Withdraw, Spending limit, Pay and Rate`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const server = await arcServer(page);
    server.refusal = refusal;

    let panel = await openScreen(page, 'Withdraw', 'Withdraw');
    await fillWithdrawal(panel);
    await expect(panel.getByRole('alert')).toHaveText(line);

    panel = await openLimits(page);
    await panel.getByLabel('Limit in USDC').fill('20');
    await panel.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(panel.getByRole('alert')).toHaveText(line);

    panel = await openScreen(page, 'Pay', 'Pay');
    await panel.getByRole('textbox', { name: /^To\b/ }).fill(HARBOR.baseId);
    await expect(panel.getByRole('alert')).toHaveText(line);

    panel = await openScreen(page, 'Rate', 'Rate an agent');
    await findHarbor(panel);
    await expect(panel.getByRole('alert')).toHaveText(line);
    expect(server.signatures).toHaveLength(0);
  });
}
