import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  parseAbi,
  recoverTypedDataAddress,
  type Hex,
} from 'viem';
import { type UserOperation } from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';
import { agentWalletRecipe, deriveAddressLocal } from '../server/base/chain/derive.js';
import { accountIndexFor } from '../server/base/wallet/service.js';
import { ApiError } from '../src/api.js';
import { BASE_MAINNET, BASE_NETWORKS, BASE_SEPOLIA } from '../shared/base/chains.js';
import { PAY_PATHS, PAY_RECIPIENT_TTL_MS } from '../shared/base/pay.js';
import { SPONSOR_DATA_BYTES, SPONSOR_PAYMASTERS } from '../shared/base/paymasters.js';
import { rateCall, rateRegistryOf } from '../shared/base/rate.js';
import {
  LIMIT_PERIOD_SECONDS,
  LIMIT_PERMISSION_END,
  berlinDayStart,
  onchainAllowance,
  permissionToJson,
  revokeCall,
  spendPermissionHash,
} from '../shared/base/spend-limits.js';
import type { SpendPermission } from '../shared/base/types.js';
import { chainWords, walletChain, WALLET_SPONSORS } from '../shared/base/wallet-chains.js';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network.js';
import {
  ownerOperationHash,
  userOperationToRpc,
  withdrawalCall,
  type OwnerCallEncoding,
} from '../shared/base/withdraw.js';
import {
  ARC_MAINNET,
  ARC_NETWORKS,
  ARC_TESTNET,
  ARC_USDC,
  chainNetwork,
} from '../shared/chains.js';
import { allowAgentPay, agentPayFailure, type AgentPayView } from '../src/base/wallet/agentPay.js';
import { chainRefusal, NOT_ON_ARC_YET, OTHER_CHAIN } from '../src/base/wallet/api.js';
import { deploysOwnWallet } from '../src/base/wallet/withdraw.js';
import { expectedWallet, isOwnWallet } from '../src/base/wallet/derive.js';
import {
  checkLimit,
  checkRevoke,
  LimitCheckError,
  pinSpender,
  readSpenderPin,
} from '../src/base/wallet/limits.js';
import {
  checkRecipient,
  confirmOnBase,
  lookupRecipient,
  NOT_A_RECIPIENT,
  ONLY_AGENTS,
  ownerOnBase,
  PAY_BASE_RPC,
  recipientProblem,
  RecipientError,
} from '../src/base/wallet/pay.js';
import {
  checkRateOperation,
  confirmRateTargetOnBase,
  lookupRateTarget,
  NOT_A_BASE_ID,
  NOT_ON_BASE,
  NOT_SAME_AGENT,
  rateLookup,
  RateTargetError,
  RatingCheckError,
  TYPE_BOTH,
} from '../src/base/wallet/rate.js';
import { raterOf } from '../src/agents/v4/rateScreenModel.js';
import {
  GIVEN_FINAL,
  GIVEN_ON_BASE,
  GIVEN_ON_ITS_WAY,
  givenName,
  givenStatus,
} from '../src/agents/v4/ratingsGivenModel.js';
import { CONTENT_SECURITY_POLICY } from '../server/security-headers.js';
import {
  checkedIntent,
  checkOperation,
  checkSigningWindow,
  decodedAmount,
  SIGNING_WINDOW_EXPIRED,
  walletAccountIndex,
  WithdrawalCheckError,
  type SigningRequest,
} from '../src/base/wallet/withdraw.js';

/*
 * The browser's signing checks for an agent on Arc: the chain comes from the wallet view, must be
 * listed in the build (shared/base/wallet-chains.ts), and every address it is checked against comes
 * from that list. Real hashes and real signatures; nothing is sent anywhere.
 */

const OWNER = getAddress(`0x${'7e'.repeat(20)}`);
const AGENT = '11111111-1111-4111-8111-111111111111';
const WALLET = expectedWallet(OWNER, AGENT);
const TO = getAddress(`0x${'44'.repeat(20)}`);
const SPENDER = getAddress(`0x${'3c'.repeat(20)}`);
const BASE_ENTRY_POINT = walletChain(WALLET_CHAIN_ID)!.owner.entryPoint;
const TESTNET = walletChain(ARC_TESTNET)!;
const ARC_PAYMASTER = WALLET_SPONSORS[ARC_TESTNET]![0]!;
// Read back on chain 31 Oct 2026 (docs/arc/MAINNET_DEPLOY.md).
const ARC_MAINNET_PAYMASTER = '0x271BFB75cA5741875F1C69Bf478252133896FAdA';
const ARC_MAINNET_MANAGER = '0xf85210B21cC50302F477BA56686d2019dC9b67Ad';
const BASE_PAYMASTER = SPONSOR_PAYMASTERS[BASE_MAINNET]![0]!;

function sponsorData(paymaster: string): Hex {
  const data = `0x${paymaster.slice(2)}${'00'.repeat(51)}${'00'.repeat(58)}${'ab'.repeat(65)}`;
  if (data.length !== 2 + SPONSOR_DATA_BYTES * 2) throw new Error('sponsor data length');
  return data as Hex;
}

const walletAbi = parseAbi(['function execute(address target, uint256 value, bytes data)']);
const executed = (call: OwnerCallEncoding): Hex =>
  encodeFunctionData({
    abi: walletAbi,
    functionName: 'execute',
    args: [call.target, call.value, call.data],
  });

function operation(call: OwnerCallEncoding, paymaster: string): UserOperation<'0.6'> {
  return {
    sender: WALLET,
    nonce: 7n,
    initCode: '0x',
    callData: executed(call),
    callGasLimit: 100_000n,
    verificationGasLimit: 100_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    paymasterAndData: sponsorData(paymaster),
    signature: '0x',
  };
}

/** A withdrawal of 1 USDC as a server would prepare it on `chainId`, hashed for `hashChainId`. */
function withdrawal(chainId: number, options: { hashChainId?: number; paymaster?: string } = {}) {
  const chain = walletChain(chainId)!;
  const op = operation(
    withdrawalCall('USDC', TO, 1_000_000n, chain.owner),
    options.paymaster ??
      (chainId === WALLET_CHAIN_ID ? WALLET_SPONSORS[WALLET_CHAIN_ID]![0]! : ARC_PAYMASTER),
  );
  const hashed = walletChain(options.hashChainId ?? chainId)!;
  return {
    op,
    input: {
      userOperation: userOperationToRpc(op),
      userOpHash: ownerOperationHash(op, hashed.owner),
      entryPoint: chain.owner.entryPoint as string,
      chainId,
      wallet: WALLET,
      owner: OWNER,
      agentId: AGENT,
      expected: { kind: 'withdraw', token: 'USDC', amount: '1000000', to: TO } as const,
    },
  };
}

test('the list: Base’s network and the two Arc networks, with Arc’s own addresses', () => {
  assert.equal(walletChain(WALLET_CHAIN_ID)?.name, 'Base');
  assert.equal(walletChain(ARC_MAINNET)?.name, 'Arc');
  assert.equal(walletChain(ARC_TESTNET)?.name, 'Arc Testnet');
  assert.equal(walletChain(ARC_MAINNET)?.testnet, false);
  assert.equal(walletChain(ARC_TESTNET)?.testnet, true);
  assert.equal(TESTNET.owner.usdc, ARC_USDC);
  assert.equal(TESTNET.owner.entryPoint, ARC_NETWORKS[ARC_TESTNET].contracts.entryPointV06);
  assert.equal(TESTNET.owner.nativeWithdrawals, false);
  // Base Sepolia is not this build's network; nor is anything else.
  for (const chainId of [BASE_SEPOLIA, 1, 0, 5043, '5042', null, undefined])
    assert.equal(walletChain(chainId), null, String(chainId));
});

test('an Arc operation checks with Arc’s chain id, and its hash is Arc’s', () => {
  const { input } = withdrawal(ARC_TESTNET);
  const hash = checkOperation({ ...input, agentChainId: ARC_TESTNET });
  assert.equal(hash, input.userOpHash);
  const base = withdrawal(WALLET_CHAIN_ID);
  assert.notEqual(base.input.userOpHash, hash);
});

test('a hash for the other chain is refused, both ways', () => {
  // A Base agent; an operation or a hash for Arc.
  const toArc = withdrawal(ARC_TESTNET);
  assert.throws(
    () => checkOperation(toArc.input),
    (error: unknown) =>
      error instanceof WithdrawalCheckError &&
      error.message === 'This operation is for another network.',
  );
  assert.throws(
    () => checkOperation({ ...toArc.input, agentChainId: WALLET_CHAIN_ID }),
    /another network/,
  );
  const baseAskingArcHash = withdrawal(WALLET_CHAIN_ID, { hashChainId: ARC_TESTNET });
  assert.throws(() => checkOperation(baseAskingArcHash.input), /doesn’t match its hash/);
  // An Arc agent; an operation or a hash for Base.
  const toBase = withdrawal(WALLET_CHAIN_ID);
  assert.throws(
    () => checkOperation({ ...toBase.input, agentChainId: ARC_TESTNET }),
    /another network/,
  );
  const arcAskingBaseHash = withdrawal(ARC_TESTNET, { hashChainId: WALLET_CHAIN_ID });
  assert.throws(
    () => checkOperation({ ...arcAskingBaseHash.input, agentChainId: ARC_TESTNET }),
    /doesn’t match its hash/,
  );
});

test('Arc’s USDC is the only USDC on Arc, and Base’s the only one on Base', () => {
  const { input } = withdrawal(WALLET_CHAIN_ID);
  // Base's USDC transfer, on Arc: its target is just some contract there.
  const op = operation(
    withdrawalCall('USDC', TO, 1_000_000n, walletChain(WALLET_CHAIN_ID)!.owner),
    ARC_PAYMASTER,
  );
  assert.throws(
    () =>
      checkOperation({
        ...input,
        chainId: ARC_TESTNET,
        agentChainId: ARC_TESTNET,
        entryPoint: TESTNET.owner.entryPoint,
        userOperation: userOperationToRpc(op),
        userOpHash: ownerOperationHash(op, TESTNET.owner),
      }),
    /something other than a transfer/,
  );
});

test('a plain send on Arc moves gas USDC, so it is no withdrawal', () => {
  const op = operation({ target: TO, value: 1n, data: '0x' }, ARC_PAYMASTER);
  const { input } = withdrawal(ARC_TESTNET);
  assert.throws(
    () =>
      checkOperation({
        ...input,
        agentChainId: ARC_TESTNET,
        userOperation: userOperationToRpc(op),
        userOpHash: ownerOperationHash(op, TESTNET.owner),
      }),
    /something other than a transfer/,
  );
});

test('an unlisted chain is refused, even when the view and the operation agree', () => {
  const { input } = withdrawal(ARC_TESTNET);
  for (const chainId of [1, 5043, BASE_SEPOLIA])
    assert.throws(
      () => checkOperation({ ...input, chainId, agentChainId: chainId }),
      (error: unknown) => error instanceof WithdrawalCheckError,
      String(chainId),
    );
});

test('the EntryPoint is the chain’s own; the server’s is never taken', () => {
  const { input } = withdrawal(ARC_TESTNET);
  assert.throws(
    () =>
      checkOperation({
        ...input,
        agentChainId: ARC_TESTNET,
        entryPoint: getAddress(`0x${'12'.repeat(20)}`),
      }),
    /another EntryPoint/,
  );
});

test('sponsor: Arc testnet’s pinned one only; a server-named or Base’s paymaster is refused', () => {
  const unknown = getAddress(`0x${'ee'.repeat(20)}`);
  for (const paymaster of [unknown, BASE_PAYMASTER]) {
    const { input } = withdrawal(ARC_TESTNET, { paymaster });
    assert.throws(
      () => checkOperation({ ...input, agentChainId: ARC_TESTNET }),
      /isn’t covered by the approved sponsor/,
      paymaster,
    );
  }
  // And the signing window asks the same list.
  const { input } = withdrawal(ARC_TESTNET, { paymaster: unknown });
  assert.throws(
    () =>
      checkSigningWindow({
        lanes: true,
        chainId: ARC_TESTNET,
        expiresAt: Date.now() + 60_000,
        userOperation: input.userOperation,
      }),
    new RegExp(SIGNING_WINDOW_EXPIRED),
  );
});

test('the pinned list: Arc mainnet pins its own paymaster only, testnet stays out, Base unchanged', () => {
  assert.equal(SPONSOR_PAYMASTERS[ARC_TESTNET], undefined);
  assert.deepEqual(SPONSOR_PAYMASTERS[ARC_MAINNET], [ARC_MAINNET_PAYMASTER]);
  assert.deepEqual(WALLET_SPONSORS[ARC_MAINNET], [ARC_MAINNET_PAYMASTER]);
  assert.deepEqual(WALLET_SPONSORS[BASE_MAINNET], SPONSOR_PAYMASTERS[BASE_MAINNET]);
  assert.ok(!SPONSOR_PAYMASTERS[BASE_MAINNET]!.includes(ARC_MAINNET_PAYMASTER as never));
});

test('Arc mainnet: the recorded manager and only its pinned sponsor; an unlisted chain is refused', () => {
  assert.equal(walletChain(ARC_MAINNET)?.manager, ARC_MAINNET_MANAGER);
  assert.notEqual(walletChain(ARC_MAINNET)?.limit, null);
  const { input } = withdrawal(ARC_TESTNET);
  const asMainnet = { ...input, chainId: ARC_MAINNET, agentChainId: ARC_MAINNET };
  // The testnet paymaster is not mainnet's pinned sponsor: refused, nothing signed.
  assert.throws(
    () => checkOperation(asMainnet),
    (error: unknown) => error instanceof WithdrawalCheckError,
  );
  // A sponsor passed in by the server is never accepted in place of the pinned one.
  assert.throws(
    () => checkOperation({ ...asMainnet, sponsors: { [ARC_MAINNET]: [ARC_PAYMASTER] } }),
    (error: unknown) => error instanceof WithdrawalCheckError,
  );
  assert.throws(
    () => checkOperation({ ...input, chainId: 1, agentChainId: 1 }),
    (error: unknown) => error instanceof WithdrawalCheckError,
  );
});

test('derivation: Arc testnet and mainnet give Base’s wallet, the server’s too; an unlisted chain none', () => {
  assert.equal(expectedWallet(OWNER, AGENT, ARC_TESTNET), WALLET);
  assert.equal(isOwnWallet(WALLET, OWNER, AGENT, ARC_TESTNET), true);
  assert.equal(walletAccountIndex(AGENT), accountIndexFor(AGENT));
  const network = chainNetwork(ARC_TESTNET, { CITY_ARC: '1' })!;
  assert.equal(
    deriveAddressLocal(agentWalletRecipe(network, OWNER, accountIndexFor(AGENT))),
    WALLET,
  );
  // Mainnet's recorded manager and factory are the canonical ones: the same address.
  assert.equal(expectedWallet(OWNER, AGENT, ARC_MAINNET), WALLET);
  assert.equal(isOwnWallet(WALLET, OWNER, AGENT, ARC_MAINNET), true);
  assert.throws(() => expectedWallet(OWNER, AGENT, 1));
  assert.equal(isOwnWallet(WALLET, OWNER, AGENT, 1), false);
});

test('an Arc deploy is the same recipe at Arc’s factory; another factory is refused', () => {
  const factoryAbi = parseAbi(['function createAccount(bytes[] owners, uint256 nonce)']);
  const word = (address: string) => `0x${'00'.repeat(12)}${address.slice(2).toLowerCase()}` as Hex;
  const args = [[word(OWNER), word(TESTNET.manager!)], walletAccountIndex(AGENT)] as const;
  const data = encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args });
  const init = `${TESTNET.factory}${data.slice(2)}` as Hex;
  assert.equal(deploysOwnWallet(init, OWNER, AGENT, ARC_TESTNET), true);
  assert.equal(deploysOwnWallet(init, OWNER, AGENT, ARC_MAINNET), true);
  assert.equal(deploysOwnWallet(init, OWNER, AGENT, 1), false);
  const other = `0x${'12'.repeat(20)}${data.slice(2)}` as Hex;
  assert.equal(deploysOwnWallet(other, OWNER, AGENT, ARC_TESTNET), false);
});

test('the confirm screen’s values name Arc, from the operation and the build', () => {
  const { input } = withdrawal(ARC_TESTNET);
  const summary = {
    kind: 'withdraw',
    token: 'USDC',
    amount: { raw: '1000000', decimals: 6, display: '1' },
    from: WALLET,
    to: TO,
    network: 'Arc Testnet',
    testnet: true,
    deploysWallet: false,
  };
  const request = { ...input, summary } as unknown as SigningRequest;
  const intent = checkedIntent(request, WALLET);
  assert.equal(intent.network, 'Arc Testnet');
  assert.equal(intent.testnet, true);
  assert.throws(
    () => checkedIntent({ ...request, summary: { ...summary, network: 'Base' } } as never, WALLET),
    /summary doesn’t match/,
  );
  assert.equal(decodedAmount(input.userOperation, WALLET, ARC_TESTNET), 1_000_000n);
  assert.equal(decodedAmount(input.userOperation, WALLET), null);
});

/* ---------- limits ---------- */

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const CAP = '20000000';
const limitChain = TESTNET.limit!;

function permission(overrides: Partial<SpendPermission> = {}): SpendPermission {
  return {
    account: WALLET,
    spender: SPENDER,
    token: getAddress(ARC_USDC),
    allowance: onchainAllowance(BigInt(CAP), 'half'),
    period: LIMIT_PERIOD_SECONDS.day,
    start: berlinDayStart(NOW),
    end: LIMIT_PERMISSION_END,
    salt: 5n,
    extraData: '0x',
    ...overrides,
  };
}

const limitInput = (p: SpendPermission, chainId: number, hash: Hex) => ({
  prepared: {
    chainId,
    permission: permissionToJson(p),
    permissionHash: hash,
    onchainModel: 'half' as const,
  },
  wallet: WALLET,
  owner: OWNER,
  agentId: AGENT,
  spender: SPENDER,
  capRaw: CAP,
  period: 'day' as const,
  now: NOW,
});

test('an Arc limit is hashed and signed for Arc', async () => {
  const p = permission();
  const hash = spendPermissionHash(limitChain, p);
  const checked = checkLimit({ ...limitInput(p, ARC_TESTNET, hash), agentChainId: ARC_TESTNET });
  assert.equal(checked.chainId, ARC_TESTNET);
  assert.equal(checked.hash, hash);
  assert.equal(checked.typedData.domain.chainId, ARC_TESTNET);
  const key = privateKeyToAccount(`0x${'11'.repeat(32)}`);
  const signature = await key.signTypedData(checked.typedData);
  assert.equal(await recoverTypedDataAddress({ ...checked.typedData, signature }), key.address);
});

test('a limit for the other chain is refused, both ways; an unlisted one too', () => {
  const p = permission();
  const arcHash = spendPermissionHash(limitChain, p);
  assert.throws(() => checkLimit(limitInput(p, ARC_TESTNET, arcHash)), /another network/);
  const basePermission = permission({ token: walletChain(WALLET_CHAIN_ID)!.owner.usdc });
  const baseHash = spendPermissionHash(WALLET_CHAIN_ID as never, basePermission);
  assert.throws(
    () =>
      checkLimit({
        ...limitInput(basePermission, WALLET_CHAIN_ID, baseHash),
        agentChainId: ARC_TESTNET,
      }),
    /another network/,
  );
  // The right chain with the other chain's hash.
  assert.throws(
    () => checkLimit({ ...limitInput(p, ARC_TESTNET, baseHash), agentChainId: ARC_TESTNET }),
    /doesn’t match its hash/,
  );
  // Base's USDC in an Arc limit.
  const wrongToken = permission({ token: walletChain(WALLET_CHAIN_ID)!.owner.usdc });
  assert.throws(
    () =>
      checkLimit({
        ...limitInput(wrongToken, ARC_TESTNET, spendPermissionHash(limitChain, wrongToken)),
        agentChainId: ARC_TESTNET,
      }),
    /different token/,
  );
  assert.throws(
    () => checkLimit({ ...limitInput(p, 1, arcHash), agentChainId: 1 }),
    (error: unknown) => error instanceof LimitCheckError,
  );
  // Mainnet with the testnet's hash: the hash binds the chain.
  assert.throws(
    () => checkLimit({ ...limitInput(p, ARC_MAINNET, arcHash), agentChainId: ARC_MAINNET }),
    (error: unknown) =>
      error instanceof LimitCheckError && /doesn’t match its hash/.test(error.message),
  );
});

function revokeRequest(paymaster: string = ARC_PAYMASTER, chainId: number = ARC_TESTNET) {
  const p = permission();
  const op = operation(revokeCall(limitChain, p), paymaster);
  return {
    permissionHash: spendPermissionHash(limitChain, p),
    allowanceRaw: p.allowance.toString(),
    request: {
      permissionId: 'p1',
      chainId,
      entryPoint: TESTNET.owner.entryPoint,
      userOperation: userOperationToRpc(op),
      userOpHash: ownerOperationHash(op, TESTNET.owner),
    },
  };
}

const revokeInput = (made: ReturnType<typeof revokeRequest>) => ({
  request: made.request,
  wallet: WALLET,
  owner: OWNER,
  agentId: AGENT,
  limit: {
    permissionId: 'p1',
    permissionHash: made.permissionHash,
    allowanceRaw: made.allowanceRaw,
    periodSeconds: LIMIT_PERIOD_SECONDS.day,
  },
});

test('an Arc revoke checks on Arc; the other chain and a server-named sponsor are refused', () => {
  const made = revokeRequest();
  assert.equal(
    checkRevoke({ ...revokeInput(made), agentChainId: ARC_TESTNET }),
    made.request.userOpHash,
  );
  assert.throws(() => checkRevoke(revokeInput(made)), /another network/);
  assert.throws(
    () =>
      checkRevoke({
        ...revokeInput(revokeRequest(getAddress(`0x${'ee'.repeat(20)}`))),
        agentChainId: ARC_TESTNET,
      }),
    /approved sponsor/,
  );
});

test('the spending key is kept per chain; Base’s key name is unchanged', () => {
  const store = new Map<string, string>();
  const previous = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  try {
    pinSpender(WALLET, SPENDER);
    assert.deepEqual([...store.keys()], [`cc-spender:${WALLET_CHAIN_ID}:${WALLET.toLowerCase()}`]);
    assert.equal(readSpenderPin(WALLET, ARC_TESTNET), null);
    const other = getAddress(`0x${'3d'.repeat(20)}`);
    pinSpender(WALLET, other, ARC_TESTNET);
    assert.equal(readSpenderPin(WALLET, ARC_TESTNET), other);
    assert.equal(readSpenderPin(WALLET), SPENDER);
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = previous;
  }
});

/* ---------- ratings ---------- */

function rating(registry = rateRegistryOf(ARC_TESTNET)!, chainId: number = ARC_TESTNET) {
  const chain = walletChain(chainId)!;
  const op = operation(rateCall(42n, 5, registry), ARC_PAYMASTER);
  return {
    withdrawalId: 'r1',
    chainId,
    entryPoint: chain.owner.entryPoint,
    userOperation: userOperationToRpc(op),
    userOpHash: ownerOperationHash(op, chain.owner),
    expiresAt: NOW + 60_000,
    state: 'awaiting_signature',
    summary: {
      kind: 'rate',
      registry,
      agentId: '42',
      value: '100',
      tag1: 'starred',
      stars: 5,
      from: WALLET,
      network: chain.name,
      testnet: chain.testnet,
      sponsored: true,
      fee: { paidBy: 'sponsor' },
      deploysWallet: false,
    },
  } as never;
}

const rateInput = (request: never) => ({
  request,
  wallet: WALLET,
  owner: OWNER,
  agentId: AGENT,
  expected: { baseId: '42', stars: 5 as const },
});

test('an Arc rating calls Arc’s registry; Base’s registry on Arc is refused', () => {
  const request = rating();
  assert.equal(
    checkRateOperation({ ...rateInput(request), agentChainId: ARC_TESTNET }),
    (request as { userOpHash: Hex }).userOpHash,
  );
  // Arc testnet's registry isn't Base's: a rating of Base's registry is another call.
  assert.notEqual(rateRegistryOf(ARC_TESTNET), rateRegistryOf(WALLET_CHAIN_ID));
  assert.throws(
    () =>
      checkRateOperation({
        ...rateInput(rating(rateRegistryOf(WALLET_CHAIN_ID)!)),
        agentChainId: ARC_TESTNET,
      }),
    (error: unknown) =>
      error instanceof RatingCheckError && /something other than this rating/.test(error.message),
  );
  // A Base agent asked to sign the Arc rating, and an unlisted chain.
  assert.throws(() => checkRateOperation(rateInput(request)), /another network/);
  assert.throws(
    () => checkRateOperation({ ...rateInput(request), agentChainId: 1 }),
    /another network/,
  );
});

/* ---------- this browser's own read of the agent's chain ---------- */

const TESTNET_RPC = 'https://rpc.testnet.arc.io';
const TESTNET_REGISTRY = ARC_NETWORKS[ARC_TESTNET].contracts.identityRegistry;
const BASE_RPC = 'https://mainnet.base.org';
const BASE_REGISTRY = BASE_NETWORKS[BASE_MAINNET].contracts.identityRegistry!;
const tokenUriAbi = parseAbi(['function tokenURI(uint256) view returns (string)']);
const TARGET = {
  agent: { agentId: 'a', name: '', baseId: '42', short: 'Ab3dE9' },
} as never;
const passportResult = (short: string) =>
  encodeFunctionResult({
    abi: tokenUriAbi,
    functionName: 'tokenURI',
    result: `https://centralcity.ai/a/${short}`,
  });
const ownerResult = (wallet: string) => `0x${'00'.repeat(12)}${wallet.slice(2).toLowerCase()}`;

/** A node answering as `nodeChainId`, recording each request's URL, method and `to`. */
function node(nodeChainId: number, call: string) {
  const asked: { url: string; method: string; to?: string }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body)) as {
      method: string;
      params: { to?: string }[];
    };
    asked.push({ url, method, ...(params[0]?.to ? { to: params[0].to } : {}) });
    const result =
      method === 'eth_chainId'
        ? `0x${nodeChainId.toString(16)}`
        : method === 'eth_blockNumber'
          ? '0x10'
          : call;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  }) as unknown as typeof fetch;
  return { asked, fetcher };
}

const arcRecipient = (overrides: Record<string, unknown> = {}) =>
  ({
    kind: 'central_city_agent',
    verification: 'point_in_time',
    chainId: ARC_TESTNET,
    registry: TESTNET_REGISTRY,
    baseId: '42',
    short: 'Ab3dE9',
    name: 'Harbor',
    wallet: TO,
    lookupId: 'l1',
    verified: { block: 16, blockHash: `0x${'ab'.repeat(32)}`, at: NOW },
    expiresAt: NOW + PAY_RECIPIENT_TTL_MS,
    ...overrides,
  }) as never;

test('the list holds each chain’s public endpoint and identity registry', () => {
  assert.equal(walletChain(BASE_MAINNET)?.publicRpc, BASE_RPC);
  assert.equal(walletChain(BASE_MAINNET)?.publicRpc, PAY_BASE_RPC);
  assert.equal(walletChain(BASE_MAINNET)?.identityRegistry, BASE_REGISTRY);
  assert.equal(walletChain(ARC_TESTNET)?.publicRpc, TESTNET_RPC);
  assert.equal(walletChain(ARC_TESTNET)?.identityRegistry, TESTNET_REGISTRY);
  assert.equal(walletChain(ARC_MAINNET)?.publicRpc, 'https://rpc.mainnet.arc.io');
});

test('an Arc read goes to Arc’s endpoint and registry only, its chain id asked first', async () => {
  const rate = node(ARC_TESTNET, passportResult('Ab3dE9'));
  assert.equal(
    await confirmRateTargetOnBase(TARGET, { chainId: ARC_TESTNET, fetch: rate.fetcher }),
    16,
  );
  const pay = node(ARC_TESTNET, ownerResult(TO));
  assert.equal(
    await confirmOnBase(
      // Even were an answer to name another registry, the read asks the list's.
      { ...(arcRecipient() as object), registry: BASE_REGISTRY } as never,
      { chainId: ARC_TESTNET, fetch: pay.fetcher },
    ),
    16,
  );
  for (const { asked } of [rate, pay]) {
    assert.deepEqual(
      asked.map((one) => one.method),
      ['eth_chainId', 'eth_blockNumber', 'eth_call'],
    );
    assert.ok(asked.every((one) => one.url === TESTNET_RPC));
    assert.equal(asked[2]?.to, TESTNET_REGISTRY);
  }
});

test('Base’s read goes to Base’s endpoint and registry only, with Base’s two calls', async () => {
  for (const chainId of [undefined, BASE_MAINNET]) {
    const rate = node(BASE_MAINNET, passportResult('Ab3dE9'));
    await confirmRateTargetOnBase(TARGET, { chainId, fetch: rate.fetcher });
    const pay = node(BASE_MAINNET, ownerResult(TO));
    await confirmOnBase(
      { ...(arcRecipient() as object), chainId: BASE_MAINNET, registry: BASE_REGISTRY } as never,
      { chainId, fetch: pay.fetcher },
    );
    for (const { asked } of [rate, pay]) {
      assert.deepEqual(
        asked.map((one) => one.method),
        ['eth_blockNumber', 'eth_call'],
      );
      assert.ok(asked.every((one) => one.url === BASE_RPC));
      assert.equal(asked[1]?.to, BASE_REGISTRY);
    }
  }
});

test('a node on another chain, or not saying, is refused before anything else is read', async () => {
  for (const nodeChain of [BASE_MAINNET, ARC_MAINNET, 1]) {
    const rate = node(nodeChain, passportResult('Ab3dE9'));
    await assert.rejects(
      confirmRateTargetOnBase(TARGET, { chainId: ARC_TESTNET, fetch: rate.fetcher }),
      (error: unknown) =>
        error instanceof RateTargetError && error.message.includes('isn’t Arc Testnet'),
    );
    assert.equal(rate.asked.length, 1);
    const pay = node(nodeChain, ownerResult(TO));
    await assert.rejects(
      confirmOnBase(arcRecipient(), { chainId: ARC_TESTNET, fetch: pay.fetcher }),
      (error: unknown) =>
        error instanceof RecipientError && error.message.includes('isn’t Arc Testnet'),
    );
    assert.equal(pay.asked.length, 1);
  }
  for (const answer of [
    { result: 5042002 },
    { result: 'nope' },
    { error: { message: 'revert' } },
  ]) {
    const silent = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, ...answer }),
      )) as unknown as typeof fetch;
    await assert.rejects(
      confirmOnBase(arcRecipient(), { chainId: ARC_TESTNET, fetch: silent }),
      /isn’t Arc Testnet/,
    );
  }
});

test('a wrong answer on Arc signs nothing, in Arc’s words', async () => {
  await assert.rejects(
    confirmOnBase(arcRecipient(), {
      chainId: ARC_TESTNET,
      fetch: node(ARC_TESTNET, ownerResult(SPENDER)).fetcher,
    }),
    (error: unknown) =>
      error instanceof RecipientError &&
      error.message ===
        'This agent’s wallet on Arc Testnet changed since it was checked. Nothing was signed.',
  );
  await assert.rejects(
    confirmRateTargetOnBase(TARGET, {
      chainId: ARC_TESTNET,
      fetch: node(ARC_TESTNET, passportResult('Zz9zZ9')).fetcher,
    }),
    (error: unknown) =>
      error instanceof RateTargetError &&
      error.message ===
        'Arc Testnet doesn’t show this passport at that Arc ID, so it can’t be rated. Nothing was signed.',
  );
  await assert.rejects(
    confirmOnBase(arcRecipient(), {
      chainId: ARC_TESTNET,
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
    }),
    /Couldn’t check on Arc Testnet\. Nothing was signed/,
  );
});

test('Arc mainnet fails closed when its node can’t be read; an unlisted chain: nothing read or asked', async () => {
  const quiet = (async () => {
    throw new Error('not read');
  }) as unknown as typeof fetch;
  const fetched: string[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    fetched.push(url);
    throw new Error('not asked');
  }) as unknown as typeof fetch;
  try {
    await assert.rejects(
      confirmRateTargetOnBase(TARGET, { chainId: ARC_MAINNET, fetch: quiet }),
      /Couldn’t check on Arc\. Nothing was signed/,
    );
    await assert.rejects(
      confirmOnBase(arcRecipient({ chainId: ARC_MAINNET }), { chainId: ARC_MAINNET, fetch: quiet }),
      /Couldn’t check on Arc\. Nothing was signed/,
    );
    await assert.rejects(
      confirmOnBase(arcRecipient(), { chainId: 1, fetch: quiet }),
      /network isn’t supported/,
    );
    assert.deepEqual(fetched, []);
  } finally {
    globalThis.fetch = previous;
  }
});

test('the recipient is checked against Arc’s list; a Base answer on Arc is refused, and back', () => {
  const byId = [{ kind: 'baseId', baseId: '42' }] as never;
  assert.equal(checkRecipient(arcRecipient(), byId, NOW, ARC_TESTNET).wallet, TO);
  for (const wrong of [
    { chainId: BASE_MAINNET },
    { chainId: ARC_MAINNET },
    { registry: BASE_REGISTRY },
  ])
    assert.throws(
      () => checkRecipient(arcRecipient(wrong), byId, NOW, ARC_TESTNET),
      /isn’t registered on this wallet’s network/,
    );
  // An Arc answer for a Base agent, as before.
  assert.throws(() => checkRecipient(arcRecipient(), byId, NOW), /this wallet’s network/);
  // And a read for one chain of a recipient on another.
  return assert.rejects(
    ownerOnBase(arcRecipient({ chainId: BASE_MAINNET }), {
      chainId: ARC_TESTNET,
      fetch: node(ARC_TESTNET, ownerResult(TO)).fetcher,
    }),
    /isn’t registered on this wallet’s network/,
  );
});

test('the lookup asks the server for the agent’s chain on Arc; never on Base', async () => {
  const urls: string[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify(arcRecipient({ expiresAt: Date.now() + 1, verified: {} })), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  try {
    await assert.rejects(lookupRecipient('12345', ARC_TESTNET), RecipientError);
    await assert.rejects(lookupRecipient('12345', BASE_MAINNET), RecipientError);
    await assert.rejects(lookupRecipient('12345'), RecipientError);
  } finally {
    globalThis.fetch = previous;
  }
  assert.equal(urls[0], `${PAY_PATHS.recipient}?q=12345&chain=${ARC_TESTNET}`);
  assert.equal(urls[1], `${PAY_PATHS.recipient}?q=12345`);
  assert.equal(urls[2], `${PAY_PATHS.recipient}?q=12345`);
});

test('the Content-Security-Policy gains exactly the two Arc hosts, in both copies', () => {
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    headers: { headers: { key: string; value: string }[] }[];
  };
  const edge = vercel.headers
    .flatMap((rule) => rule.headers)
    .filter((header) => header.key === 'Content-Security-Policy');
  assert.ok(edge.length > 0);
  const hosts = (policy: string) =>
    policy
      .split('; ')
      .find((part) => part.startsWith('connect-src '))!
      .split(' ')
      .slice(1);
  const expected = [
    "'self'",
    'https://mainnet.base.org',
    'https://rpc.mainnet.arc.io',
    'https://rpc.testnet.arc.io',
    'https://vercel.com/api/blob/',
  ];
  assert.deepEqual(hosts(CONTENT_SECURITY_POLICY), expected);
  for (const header of edge) assert.deepEqual(hosts(header.value), expected);
  // Nothing else in the header moved.
  assert.equal(
    CONTENT_SECURITY_POLICY.replace(' https://rpc.mainnet.arc.io https://rpc.testnet.arc.io', ''),
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://mainnet.base.org https://vercel.com/api/blob/; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
});

test('the words: Arc on Arc, Base’s untouched on Base', () => {
  const arc = chainWords(ARC_TESTNET);
  assert.equal(arc.on, 'Arc Testnet');
  assert.equal(chainWords(ARC_MAINNET).on, 'Arc');
  for (const text of [
    ONLY_AGENTS,
    NOT_A_RECIPIENT,
    NOT_ON_BASE,
    TYPE_BOTH,
    NOT_A_BASE_ID,
    NOT_SAME_AGENT,
    GIVEN_FINAL,
    GIVEN_ON_BASE,
    GIVEN_ON_ITS_WAY,
  ]) {
    for (const chainId of [undefined, BASE_MAINNET, BASE_SEPOLIA, 1, null])
      assert.equal(chainWords(chainId).say(text), text);
    assert.doesNotMatch(arc.say(text), /\bBase\b|15 minutes/, text);
  }
  assert.equal(givenStatus({ state: 'final' }, ARC_TESTNET).line, 'Rated ✓ · on Arc Testnet');
  assert.equal(givenStatus({ state: 'final' }).line, GIVEN_FINAL);
  assert.equal(givenName({ name: '', short: '', baseId: '7' }, ARC_TESTNET), 'Arc ID 7');
  assert.equal(givenName({ name: '', short: '', baseId: '7' }), 'Base ID 7');
  assert.equal(recipientProblem('not one', BASE_MAINNET), NOT_A_RECIPIENT);
  assert.doesNotMatch(recipientProblem('not one', ARC_TESTNET)!, /\bBase\b/);
  assert.throws(() => rateLookup({ baseId: '', passport: '' }, ARC_TESTNET), /Arc ID/);
  assert.throws(() => rateLookup({ baseId: '', passport: '' }), /Base ID/);
});

test('a rater on Arc rates from its Arc registration, per network; Base stays as it is', () => {
  const row = (chainId: number) =>
    ({
      chainId,
      state: 'confirmed',
      stage: 'confirmed',
      finality: 'final',
      erc8004AgentId: '42',
      agentUri: 'https://centralcity.ai/a/Ab3dE9',
    }) as never;
  const rater = { baseId: '42', passport: 'Ab3dE9' };
  assert.deepEqual(raterOf([row(ARC_TESTNET)], ARC_TESTNET), rater);
  assert.equal(raterOf([row(BASE_MAINNET)], ARC_TESTNET), null);
  assert.equal(raterOf([row(ARC_TESTNET)]), null);
  assert.equal(raterOf([row(ARC_TESTNET)], BASE_MAINNET), null);
  assert.deepEqual(raterOf([row(BASE_MAINNET)], BASE_MAINNET), rater);
  assert.deepEqual(raterOf([row(BASE_MAINNET)]), rater);
  assert.deepEqual(raterOf([row(ARC_MAINNET)], ARC_MAINNET), rater);
  assert.equal(raterOf([row(ARC_TESTNET)], ARC_MAINNET), null);
  assert.equal(raterOf([row(ARC_MAINNET)], ARC_TESTNET), null);
});

/* ---------- agent-pay consent ---------- */

function consentView(chainId: number, token: string): AgentPayView {
  return {
    chainId,
    token: 'USDC',
    scope: {
      recipients: 'central-city-agents',
      token: 'USDC',
      withinLimit: {
        permissionHash: `0x${'aa'.repeat(32)}`,
        period: 'day',
        capRaw: CAP,
        capDisplay: '20',
      },
    },
    consent: null,
    mayPay: false,
    signing: { wallet: WALLET, token, owner: OWNER },
    confirmRecipients: 'central-city-agents',
    reconfirmAddsFeedServices: false,
  };
}

test('the consent signs only a listed chain, with that chain’s USDC', async () => {
  const signed: { domain: { chainId: number } }[] = [];
  const signer = (async (typedData: { domain: { chainId: number } }) => {
    signed.push(typedData);
    throw new Error('stop before sending');
  }) as never;
  // A listed chain reaches the signer with its own id.
  await assert.rejects(
    allowAgentPay(AGENT, consentView(ARC_TESTNET, ARC_USDC), signer),
    /stop before sending/,
  );
  assert.equal(signed[0]?.domain.chainId, ARC_TESTNET);
  // An unlisted chain and another token never do.
  signed.length = 0;
  await assert.rejects(allowAgentPay(AGENT, consentView(1, ARC_USDC), signer), /isn’t supported/);
  await assert.rejects(
    allowAgentPay(AGENT, consentView(BASE_SEPOLIA, ARC_USDC), signer),
    /isn’t supported/,
  );
  await assert.rejects(
    allowAgentPay(AGENT, consentView(ARC_TESTNET, `0x${'12'.repeat(20)}`), signer),
    /different token/,
  );
  await assert.rejects(
    allowAgentPay(
      AGENT,
      consentView(ARC_TESTNET, walletChain(WALLET_CHAIN_ID)!.owner.usdc),
      signer,
    ),
    /different token/,
  );
  assert.equal(signed.length, 0);
});

/* ---------- calm lines ---------- */

test('not_on_arc_yet and other_chain read calmly; other errors are left alone', () => {
  const refused = (status: number, code: string) => {
    const error = new ApiError('server words', status);
    error.code = code;
    return error;
  };
  assert.equal(chainRefusal(refused(409, 'not_on_arc_yet')), NOT_ON_ARC_YET);
  assert.equal(chainRefusal(refused(409, 'other_chain')), OTHER_CHAIN);
  assert.equal(chainRefusal(refused(409, 'operation_pending')), null);
  assert.equal(chainRefusal(new Error('other_chain')), null);
  assert.equal(agentPayFailure(refused(409, 'not_on_arc_yet')), NOT_ON_ARC_YET);
});

test('Base stays as it was: same hash, same wallet, same entry point', () => {
  const { op, input } = withdrawal(WALLET_CHAIN_ID);
  assert.equal(input.userOpHash, ownerOperationHash(op));
  assert.equal(checkOperation(input), input.userOpHash);
  assert.equal(checkOperation({ ...input, agentChainId: WALLET_CHAIN_ID }), input.userOpHash);
  assert.equal(expectedWallet(OWNER, AGENT, WALLET_CHAIN_ID), WALLET);
  assert.equal(input.entryPoint, BASE_ENTRY_POINT);
});
