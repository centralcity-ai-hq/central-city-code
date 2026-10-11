import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData, getAddress, parseAbi, recoverTypedDataAddress, type Hex } from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BASE_MAINNET, BASE_NETWORKS, BASE_SEPOLIA } from '../shared/base/chains.js';
import {
  LIMIT_PERIOD_SECONDS,
  LIMIT_PERMISSION_END,
  nextBerlinMidnight,
  onchainAllowance,
  permissionToJson,
  revokeCall,
  smartWalletMessageTypedData,
  spendPermissionHash,
  type LimitPeriod,
  type OnchainCapModel,
} from '../shared/base/spend-limits.js';
import type { SpendPermission } from '../shared/base/types.js';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network.js';
import { SPONSOR_DATA_BYTES } from '../shared/base/paymasters.js';

/** A sponsor these tests allow on the wallet network (nothing is pinned there for real). */
const SPONSOR = getAddress(`0x${'99'.repeat(20)}`);
const SPONSORS = { [WALLET_CHAIN_ID]: [SPONSOR] };
/** A verifying paymaster's data: 129 bytes of fields (token at [51:71]) + a 65-byte signature. */
function sponsorData(paymaster: string = SPONSOR, token = '00'.repeat(20)): Hex {
  const data = `0x${paymaster.slice(2)}${'00'.repeat(31)}${token}${'00'.repeat(58)}${'ab'.repeat(65)}`;
  if (data.length !== 2 + SPONSOR_DATA_BYTES * 2) throw new Error('sponsor data length');
  return data as Hex;
}
import {
  ownerOperationHash,
  userOperationToRpc,
  withdrawalCall,
  type OwnerCallEncoding,
} from '../shared/base/withdraw.js';
import {
  capFromText,
  checkLimit,
  checkRevoke,
  LimitCheckError,
  limitText,
  pinSpender,
  readSpenderPin,
  signLimit,
  signRevoke,
  SpenderPinError,
  usdcText,
} from '../src/base/wallet/limits.js';
import { sealKey } from '../src/base/vault/crypto.js';
import { walletAccountIndex, WithdrawalLockedError } from '../src/base/wallet/withdraw.js';
import { expectedWallet } from '../src/base/wallet/derive.js';

/*
 * The browser's checks before the owner signs a spending limit or its revoke
 * (src/base/wallet/limits.ts): real permissions, EIP-712 hashes and UserOperation hashes
 * (shared/base/spend-limits.ts), then every way a prepared one could differ from the limit shown.
 */

const NETWORK = BASE_NETWORKS[WALLET_CHAIN_ID];
/** The other of the two wallet networks. */
const OTHER_CHAIN = WALLET_CHAIN_ID === BASE_MAINNET ? BASE_SEPOLIA : BASE_MAINNET;
const USDC = getAddress(NETWORK.tokens.USDC.address);
/** The owner key and agent the wallet belongs to; the wallet is the one they derive (derive.ts). */
const OWNER = getAddress(`0x${'7e'.repeat(20)}`);
const AGENT = '11111111-1111-4111-8111-111111111111';
const WALLET = expectedWallet(OWNER, AGENT);
const OTHER_WALLET = getAddress(`0x${'6b'.repeat(20)}`);
const SPENDER = getAddress(`0x${'3c'.repeat(20)}`);
// Saturday 10 Oct 2026, 14:00 in Berlin (CEST); the next Berlin midnight is Sunday 00:00.
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const MIDNIGHT = Date.UTC(2026, 9, 10, 22, 0, 0) / 1000;
const CAP = '20000000';

function permission(
  overrides: Partial<SpendPermission> = {},
  model: OnchainCapModel = 'half',
  period: LimitPeriod = 'day',
): SpendPermission {
  return {
    account: WALLET,
    spender: SPENDER,
    token: USDC,
    allowance: onchainAllowance(BigInt(CAP), model),
    period: LIMIT_PERIOD_SECONDS[period],
    start: MIDNIGHT,
    end: LIMIT_PERMISSION_END,
    salt: 0x1234_5678_9abc_def0_1234_5678_9abc_def0n,
    extraData: '0x',
    ...overrides,
  };
}

/** The prepare answer for a permission, its hash computed as the server does. */
const prepared = (p: SpendPermission, model: OnchainCapModel = 'half') => ({
  chainId: WALLET_CHAIN_ID as number,
  permission: permissionToJson(p),
  permissionHash: spendPermissionHash(WALLET_CHAIN_ID, p),
  onchainModel: model,
});

const refused = (run: () => unknown, message: RegExp) =>
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof LimitCheckError, String(error));
    assert.match((error as Error).message, message);
    return true;
  });

test('the exact limit passes (half, the product owner’s model), and the owner signs the wallet’s wrapper of its hash', async () => {
  for (const model of ['half'] as const) {
    const p = permission({}, model);
    const checked = checkLimit({
      prepared: prepared(p, model),
      wallet: WALLET.toLowerCase(),
      owner: OWNER,
      agentId: AGENT,
      spender: SPENDER,
      capRaw: CAP,
      period: 'day',
      now: NOW,
    });
    const hash = spendPermissionHash(WALLET_CHAIN_ID, p);
    assert.equal(checked.hash, hash);
    assert.equal(checked.allowance, model === 'half' ? 10_000_000n : 20_000_000n);
    assert.equal(checked.start, MIDNIGHT);
    assert.deepEqual(checked.typedData, smartWalletMessageTypedData(WALLET_CHAIN_ID, WALLET, hash));
    // Real signing: the signature recovers to the owner over exactly that typed data.
    const owner = privateKeyToAccount(generatePrivateKey());
    const signature = await owner.signTypedData(checked.typedData);
    assert.equal(
      await recoverTypedDataAddress({
        ...smartWalletMessageTypedData(WALLET_CHAIN_ID, WALLET, hash),
        signature,
      }),
      owner.address,
    );
  }
  // A week and a month: the fixed Base lengths.
  for (const period of ['week', 'month'] as const) {
    const p = permission({}, 'half', period);
    checkLimit({
      prepared: prepared(p),
      wallet: WALLET,
      owner: OWNER,
      agentId: AGENT,
      spender: SPENDER,
      capRaw: CAP,
      period,
      now: NOW,
    });
  }
  // Prepared seconds before midnight, the server may already see the midnight after.
  const late = permission({ start: MIDNIGHT + 86_400 });
  checkLimit({
    prepared: prepared(late),
    wallet: WALLET,
    owner: OWNER,
    agentId: AGENT,
    spender: SPENDER,
    capRaw: CAP,
    period: 'day',
    now: MIDNIGHT * 1000 - 30_000,
  });
  assert.equal(nextBerlinMidnight(MIDNIGHT * 1000), MIDNIGHT + 86_400);
});

test('anything other than that limit is refused before signing', () => {
  const check =
    (
      p: SpendPermission,
      options: Partial<{
        model: OnchainCapModel;
        cap: string;
        period: LimitPeriod;
        now: number;
        hash: Hex;
        chainId: number;
        spender: string | null;
      }> = {},
    ) =>
    () =>
      checkLimit({
        prepared: {
          ...prepared(p, options.model ?? 'half'),
          ...(options.hash ? { permissionHash: options.hash } : {}),
          ...(options.chainId ? { chainId: options.chainId } : {}),
        },
        wallet: WALLET,
        owner: OWNER,
        agentId: AGENT,
        spender: options?.spender === undefined ? SPENDER : options.spender,
        capRaw: options.cap ?? CAP,
        period: options.period ?? 'day',
        now: options.now ?? NOW,
      });

  // Another wallet's limit, another token.
  refused(check(permission({ account: OTHER_WALLET })), /this agent’s wallet/);
  refused(check(permission({ token: NETWORK.tokens.ETH.address })), /different token/);
  refused(
    // The USDC of the other network (whichever the wallet network is, Base Sepolia or Base).
    check(permission({ token: getAddress(BASE_NETWORKS[OTHER_CHAIN].tokens.USDC.address) })),
    /different token/,
  );
  // The full cap as the allowance while the model is half (the burst around a reset doubles it).
  refused(check(permission({ allowance: 20_000_000n })), /different amount/);
  // A cap other than the one typed, or one unit more than half of it.
  refused(check(permission(), { cap: '30000000' }), /different amount/);
  refused(check(permission({ allowance: 10_000_001n })), /different amount/);
  // The full model is not this page's (the product owner: half), even with its own exact allowance.
  refused(
    check(permission({ allowance: 20_000_000n }, 'full'), { model: 'full' }),
    /different on-chain cap/,
  );
  // Another spender than the agent's spending key, with the hash recomputed for it: the owner
  // would let that key spend. And no spending key known at all.
  const stranger = getAddress(`0x${'99'.repeat(20)}`);
  refused(check(permission({ spender: stranger })), /different key spend/);
  refused(check(permission(), { spender: null }), /which key the agent spends with/);
  refused(check(permission(), { spender: '0x1234' }), /which key the agent spends with/);
  // Another period than chosen, or a length that isn't one of Base's fixed ones.
  refused(check(permission(), { period: 'week' }), /different period/);
  refused(check(permission({ period: 3_600 })), /different period/);
  // A start in the past, an hour early, a day late; an end of its own.
  refused(check(permission({ start: MIDNIGHT - 86_400 })), /in the past/);
  refused(check(permission({ start: MIDNIGHT - 3_600 })), /next midnight/);
  refused(check(permission({ start: MIDNIGHT + 86_400 })), /next midnight/);
  refused(check(permission({ end: MIDNIGHT + 30 * 86_400 })), /end of its own/);
  refused(check(permission({ extraData: '0x01' })), /extra data/);
  // A hash that isn't this permission's (the owner would sign something else).
  refused(
    check(permission(), { hash: spendPermissionHash(WALLET_CHAIN_ID, permission({ salt: 1n })) }),
    /match its hash/,
  );
  // Another network or an unknown model. The other Base network: this page is out of date.
  refused(
    check(permission(), {
      chainId: WALLET_CHAIN_ID === BASE_SEPOLIA ? BASE_MAINNET : BASE_SEPOLIA,
    }),
    /^This page is out of date\. Reload it and try again\.$/,
  );
  refused(check(permission(), { chainId: 1 }), /another network/);
  refused(check(permission(), { model: 'double' as OnchainCapModel }), /different on-chain cap/);
  // A malformed permission: a number where a decimal string belongs, a missing or extra field.
  const json = permissionToJson(permission());
  for (const bad of [
    { ...json, allowance: 10_000_000 },
    { ...json, salt: undefined },
    { ...json, owner: WALLET },
    null,
    'permission',
  ])
    refused(
      () =>
        checkLimit({
          prepared: { ...prepared(permission()), permission: bad as never },
          wallet: WALLET,
          owner: OWNER,
          agentId: AGENT,
          spender: SPENDER,
          capRaw: CAP,
          period: 'day',
          now: NOW,
        }),
      /well formed/,
    );
});

const walletAbi = parseAbi(['function execute(address target, uint256 value, bytes data)']);
const execute = (call: OwnerCallEncoding) =>
  encodeFunctionData({
    abi: walletAbi,
    functionName: 'execute',
    args: [call.target, call.value, call.data],
  });

function operation(callData: Hex, overrides: Partial<UserOperation<'0.6'>> = {}) {
  return {
    sender: WALLET,
    nonce: 9n,
    initCode: '0x',
    callData,
    callGasLimit: 120_000n,
    verificationGasLimit: 300_000n,
    preVerificationGas: 60_000n,
    maxFeePerGas: 2_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    paymasterAndData: sponsorData(),
    signature: '0x',
    ...overrides,
  } as UserOperation<'0.6'>;
}

const LIMIT_ID = '0f3c2b1a-9e8d-4c7b-8a6f-5e4d3c2b1a09';
const shown = permission();
const limit = {
  permissionId: LIMIT_ID,
  permissionHash: spendPermissionHash(WALLET_CHAIN_ID, shown),
  allowanceRaw: shown.allowance.toString(10),
  periodSeconds: shown.period,
};
const revokeRequest = (op: UserOperation<'0.6'>, overrides: { hash?: Hex; id?: string } = {}) => ({
  permissionId: overrides.id ?? LIMIT_ID,
  chainId: WALLET_CHAIN_ID as number,
  entryPoint: NETWORK.contracts.entryPointV06,
  userOperation: userOperationToRpc(op),
  userOpHash: overrides.hash ?? ownerOperationHash(op),
});

test('a revoke is the wallet’s own revoke of exactly the limit shown, with the fee covered', () => {
  const op = operation(execute(revokeCall(WALLET_CHAIN_ID, shown)));
  assert.equal(
    checkRevoke({
      request: revokeRequest(op),
      wallet: WALLET,
      owner: OWNER,
      agentId: AGENT,
      limit,
      sponsors: SPONSORS,
    }),
    ownerOperationHash(op),
  );

  const refusedRevoke = (request: ReturnType<typeof revokeRequest>, message: RegExp) =>
    refused(
      () =>
        checkRevoke({
          request,
          wallet: WALLET,
          owner: OWNER,
          agentId: AGENT,
          limit,
          sponsors: SPONSORS,
        }),
      message,
    );
  // Another call: a USDC transfer out, or the revoke of another limit.
  refusedRevoke(
    revokeRequest(operation(execute(withdrawalCall('USDC', SPENDER, 1_000_000n)))),
    /other than revoking/,
  );
  refusedRevoke(
    revokeRequest(operation(execute(revokeCall(WALLET_CHAIN_ID, permission({ salt: 7n }))))),
    /different limit/,
  );
  // The revoke with trailing bytes riding along.
  refusedRevoke(revokeRequest(operation(`${op.callData}00` as Hex)), /other than revoking/);
  // No (or no valid) paymaster: the wallet would pay the network fee.
  refusedRevoke(revokeRequest({ ...op, paymasterAndData: '0x' }), /approved sponsor/);
  refusedRevoke(revokeRequest({ ...op, paymasterAndData: '0xabcdef' }), /approved sponsor/);
  // A token in the sponsor's data could charge the wallet.
  refusedRevoke(
    revokeRequest({ ...op, paymasterAndData: sponsorData(SPONSOR, `${'00'.repeat(19)}01`) }),
    /approved sponsor/,
  );
  // A hash that isn't this operation's.
  refusedRevoke(revokeRequest(op, { hash: `0x${'11'.repeat(32)}` }), /match its hash/);
  // From another wallet; for another limit id than the one shown; malformed.
  refusedRevoke(revokeRequest({ ...op, sender: OTHER_WALLET }), /this agent’s wallet/);
  refusedRevoke(revokeRequest(op, { id: 'another-limit' }), /limit shown/);
  refusedRevoke(
    { ...revokeRequest(op), userOperation: { ...userOperationToRpc(op), nonce: '0x09' as Hex } },
    /well formed/,
  );
  refused(
    () =>
      checkRevoke({
        request: { ...revokeRequest(op), entryPoint: NETWORK.contracts.entryPointV07 },
        wallet: WALLET,
        owner: OWNER,
        agentId: AGENT,
        limit,
      }),
    /another EntryPoint/,
  );
});

test('a revoke that also deploys the wallet: only our exact owners and index', () => {
  const ATTACKER = getAddress(`0x${'12'.repeat(20)}`);
  const { smartWalletFactory: factory, spendPermissionManager: SPM } = NETWORK.contracts;
  const factoryAbi = parseAbi(['function createAccount(bytes[] owners, uint256 nonce)']);
  const word = (address: string) => `0x${'00'.repeat(12)}${address.slice(2).toLowerCase()}` as Hex;
  const initCode = (owners: string[], index = walletAccountIndex(AGENT)) =>
    `${factory}${encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [owners.map(word), index] }).slice(2)}` as Hex;
  const deploying = (code: Hex) =>
    revokeRequest(operation(execute(revokeCall(WALLET_CHAIN_ID, shown)), { initCode: code }));
  const check = (request: ReturnType<typeof revokeRequest>, owner: string, agentId: string) =>
    checkRevoke({ request, wallet: WALLET, owner, agentId, limit, sponsors: SPONSORS });
  assert.ok(check(deploying(initCode([OWNER, SPM])), OWNER, AGENT));
  // Without the owner or the agent the wallet itself can't be derived: refused before anything.
  refused(
    () => check(deploying(initCode([OWNER, SPM])), '', AGENT),
    /isn’t the wallet your wallet key/,
  );
  refused(
    () => check(deploying(initCode([OWNER, SPM])), OWNER, ''),
    /isn’t the wallet your wallet key/,
  );
  for (const [request, owner, agentId] of [
    [deploying(initCode([OWNER, SPM, ATTACKER])), OWNER, AGENT],
    [deploying(initCode([OWNER, ATTACKER])), OWNER, AGENT],
    [deploying(initCode([SPM, OWNER])), OWNER, AGENT],
    [deploying(initCode([OWNER, SPM], 0n)), OWNER, AGENT],
  ] as const)
    refused(() => check(request, owner, agentId), /with other owners/);
});

test('amounts and the cap the owner types', () => {
  assert.equal(usdcText('20000000'), '20.00');
  assert.equal(usdcText(10_005_000n), '10.005');
  assert.equal(usdcText('500000'), '0.50');
  assert.equal(limitText({ capRaw: CAP, period: 'week' }), '20.00 USDC a week');
  assert.equal(capFromText('20'), '20000000');
  assert.equal(capFromText(' 20.5 '), '20500000');
  assert.equal(capFromText('0,01'), '10000');
  for (const bad of ['', '0', '0.00', '20.001', '-5', '1e3', 'twenty', '.5'])
    assert.equal(capFromText(bad), null, bad);
});

test('signing a limit or a revoke: only with the key that owns the wallet', async () => {
  const key = `0x${'42'.repeat(32)}` as Hex;
  const owner = privateKeyToAccount(key).address;
  const password = 'Local-test-only-passphrase-2026';
  const envelope = await sealKey(key, password, { N: 2 ** 17 });
  const posts: Array<{ url: string; body: { signature: Hex } }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith('/api/base/vault'))
      return Response.json({
        accountId: 'acct-1',
        exists: true,
        ownerAddress: owner,
        ...envelope,
        version: 1,
        backupConfirmedAt: 1,
        challenge: { nonce: `0x${'ab'.repeat(32)}`, expiresAt: Date.now() + 300_000 },
      });
    posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return Response.json({ permissionId: LIMIT_ID, state: 'signed' }, { status: 201 });
  }) as typeof fetch;
  try {
    const p = permission();
    const checked = checkLimit({
      prepared: prepared(p),
      wallet: WALLET,
      owner: OWNER,
      agentId: AGENT,
      spender: SPENDER,
      capRaw: CAP,
      period: 'day',
      now: NOW,
    });
    const elsewhere = getAddress(`0x${'51'.repeat(20)}`);
    const notOwner = (error: unknown) =>
      error instanceof LimitCheckError && /isn’t this wallet’s owner/.test(error.message);
    // The owner key: the wallet's wrapper of the limit's hash, sent once.
    await signLimit('agent-1', checked, password, () => true, owner);
    assert.equal(posts.length, 1);
    assert.equal(
      await recoverTypedDataAddress({ ...checked.typedData, signature: posts[0]!.body.signature }),
      owner,
    );
    // Another reported owner (an identity wallet): nothing signed or sent, limit or revoke.
    posts.length = 0;
    await assert.rejects(
      signLimit('agent-1', checked, password, () => true, elsewhere),
      notOwner,
    );
    const hash = `0x${'33'.repeat(32)}` as Hex;
    await assert.rejects(
      signRevoke('agent-1', LIMIT_ID, hash, password, () => true, elsewhere),
      notOwner,
    );
    // Locked: nothing signed or sent.
    await assert.rejects(
      signRevoke('agent-1', LIMIT_ID, hash, password, () => false, owner),
      WithdrawalLockedError,
    );
    assert.equal(posts.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('the confirmed spending key is kept and read back before sending, or nothing is sent', async () => {
  const globals = globalThis as { localStorage?: unknown };
  const before = globals.localStorage;
  const store = new Map<string, string>();
  const working = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  try {
    globals.localStorage = working;
    pinSpender(WALLET, SPENDER.toLowerCase());
    assert.equal(readSpenderPin(WALLET), SPENDER);
    // Full, blocked, dropping or missing storage: refused, never silent.
    for (const broken of [
      {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        },
        removeItem: () => {},
      },
      { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      undefined,
    ]) {
      globals.localStorage = broken;
      assert.throws(() => pinSpender(WALLET, SPENDER), SpenderPinError);
    }
  } finally {
    globals.localStorage = before;
  }
  // signLimit runs it after signing and before the POST: when it throws, nothing is sent.
  const key = `0x${'42'.repeat(32)}` as Hex;
  const owner = privateKeyToAccount(key).address;
  const password = 'Local-test-only-passphrase-2026';
  const envelope = await sealKey(key, password, { N: 2 ** 17 });
  let posts = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).endsWith('/api/base/vault'))
      return Response.json({
        accountId: 'acct-1',
        exists: true,
        ownerAddress: owner,
        ...envelope,
        version: 1,
        backupConfirmedAt: 1,
        challenge: { nonce: `0x${'ab'.repeat(32)}`, expiresAt: Date.now() + 300_000 },
      });
    posts += 1;
    return Response.json({ permissionId: LIMIT_ID, state: 'signed' }, { status: 201 });
  }) as typeof fetch;
  try {
    const checked = checkLimit({
      prepared: prepared(permission()),
      wallet: WALLET,
      owner: OWNER,
      agentId: AGENT,
      spender: SPENDER,
      capRaw: CAP,
      period: 'day',
      now: NOW,
    });
    await assert.rejects(
      signLimit(
        'agent-1',
        checked,
        password,
        () => true,
        owner,
        () => {
          throw new SpenderPinError();
        },
      ),
      SpenderPinError,
    );
    assert.equal(posts, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("a limit or a revoke for a wallet the owner key doesn't make is refused", () => {
  // The server says the agent's wallet is OTHER_WALLET and prepares a perfect limit for it.
  const other = permission({ account: OTHER_WALLET });
  refused(
    () =>
      checkLimit({
        prepared: prepared(other),
        wallet: OTHER_WALLET,
        owner: OWNER,
        agentId: AGENT,
        spender: SPENDER,
        capRaw: CAP,
        period: 'day',
        now: NOW,
      }),
    /isn’t the wallet your wallet key makes/,
  );
  const op = operation(execute(revokeCall(WALLET_CHAIN_ID, other)), { sender: OTHER_WALLET });
  refused(
    () =>
      checkRevoke({
        request: revokeRequest(op),
        wallet: OTHER_WALLET,
        owner: OWNER,
        agentId: AGENT,
        limit: { ...limit, permissionHash: spendPermissionHash(WALLET_CHAIN_ID, other) },
        sponsors: SPONSORS,
      }),
    /isn’t the wallet your wallet key makes/,
  );
});
