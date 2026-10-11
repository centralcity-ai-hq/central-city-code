import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import { BASE_MAINNET, BASE_NETWORKS } from '../shared/base/chains.js';
import { sponsoredWithoutCharge, SPONSOR_DATA_BYTES } from '../shared/base/paymasters.js';
import {
  noopCall,
  ownerOperationHash,
  userOperationToRpc,
  withdrawalCall,
  WITHDRAWAL_CHAIN_ID,
  WITHDRAWAL_ENTRY_POINT,
  type OwnerCallEncoding,
} from '../shared/base/withdraw.js';
import {
  addressOrNull,
  checkedIntent,
  checkOperation,
  decodedAmount,
  readAnchor,
  saveAnchor,
  signAndSend,
  walletAccountIndex,
  WithdrawalAnchorError,
  WithdrawalCheckError,
  WithdrawalLockedError,
  type SigningRequest,
} from '../src/base/wallet/withdraw.js';
import { accountIndexFor } from '../server/base/wallet/service.js';
import { agentWalletRecipe, deriveAddressLocal } from '../server/base/chain/derive.js';
import { expectedWallet, isOwnWallet } from '../src/base/wallet/derive.js';
import { recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sealKey } from '../src/base/vault/crypto.js';

/*
 * The browser's check before the owner signs a withdrawal (src/base/wallet/withdraw.ts): real
 * operations and hashes (shared/base/withdraw.ts), then every way a prepared operation could differ
 * from what the owner asked for.
 */

/** The owner key and agent the wallet belongs to; the wallet is the one they derive (derive.ts). */
const OWNER = getAddress(`0x${'7e'.repeat(20)}`);
const AGENT = '11111111-1111-4111-8111-111111111111';
const WALLET = expectedWallet(OWNER, AGENT);
const OTHER_WALLET = getAddress(`0x${'6b'.repeat(20)}`);
const TO = getAddress(`0x${'3c'.repeat(20)}`);
const ELSEWHERE = getAddress(`0x${'4d'.repeat(20)}`);
const USDC = BASE_NETWORKS[WITHDRAWAL_CHAIN_ID].tokens.USDC.address;
/** A sponsor these tests allow on the wallet network (nothing is pinned there for real). */
const SPONSOR = getAddress(`0x${'99'.repeat(20)}`);
const SPONSORS = { [WITHDRAWAL_CHAIN_ID]: [SPONSOR] };
/** A verifying paymaster's data: 129 bytes of fields (token at [51:71]) + a 65-byte signature. */
function sponsorData(paymaster: string = SPONSOR, token = '00'.repeat(20)): Hex {
  const fields = `${paymaster.slice(2)}${'00'.repeat(31)}${token}${'00'.repeat(58)}`;
  return `0x${fields}${'ab'.repeat(65)}` as Hex;
}
const walletAbi = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
]);

function operation(callData: Hex, sender = WALLET): UserOperation<'0.6'> {
  return {
    sender,
    nonce: 7n,
    initCode: '0x',
    callData,
    callGasLimit: 120_000n,
    verificationGasLimit: 300_000n,
    preVerificationGas: 60_000n,
    maxFeePerGas: 2_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    paymasterAndData: sponsorData(),
    signature: '0x',
  };
}
const execute = (call: OwnerCallEncoding) =>
  encodeFunctionData({
    abi: walletAbi,
    functionName: 'execute',
    args: [call.target, call.value, call.data],
  });

function request(
  op: UserOperation<'0.6'>,
  overrides: Partial<{ hash: Hex; chainId: number; entryPoint: string }> = {},
) {
  return {
    userOperation: userOperationToRpc(op),
    userOpHash: overrides.hash ?? ownerOperationHash(op),
    entryPoint: overrides.entryPoint ?? WITHDRAWAL_ENTRY_POINT,
    chainId: overrides.chainId ?? WITHDRAWAL_CHAIN_ID,
    wallet: WALLET,
    owner: OWNER,
    agentId: AGENT,
    sponsors: SPONSORS,
  };
}
const asked = { kind: 'withdraw' as const, token: 'USDC' as const, amount: '12500000', to: TO };

test('the exact withdrawal the owner asked for passes, and its hash is what gets signed', () => {
  const op = operation(execute(withdrawalCall('USDC', TO, 12_500_000n)));
  assert.equal(checkOperation({ ...request(op), expected: asked }), ownerOperationHash(op));
  // 'max': the server picks the amount; the screen shows the decoded one.
  assert.equal(
    checkOperation({ ...request(op), expected: { ...asked, amount: 'max' } }),
    ownerOperationHash(op),
  );
  assert.equal(decodedAmount(userOperationToRpc(op), WALLET), 12_500_000n);
  // ETH: a plain send of that many wei.
  const eth = operation(execute(withdrawalCall('ETH', TO, 10n ** 15n)));
  checkOperation({
    ...request(eth),
    expected: { kind: 'withdraw', token: 'ETH', amount: (10n ** 15n).toString(), to: TO },
  });
});

test('anything other than that withdrawal is refused before signing', () => {
  const good = operation(execute(withdrawalCall('USDC', TO, 12_500_000n)));
  const refused = (input: Parameters<typeof checkOperation>[0], message: RegExp) =>
    assert.throws(
      () => checkOperation(input),
      (error: unknown) => {
        assert.ok(error instanceof WithdrawalCheckError);
        assert.match((error as Error).message, message);
        return true;
      },
    );
  // Another destination, amount or token than typed.
  refused(
    {
      ...request(operation(execute(withdrawalCall('USDC', ELSEWHERE, 12_500_000n)))),
      expected: asked,
    },
    /different address/,
  );
  refused(
    { ...request(operation(execute(withdrawalCall('USDC', TO, 12_500_001n)))), expected: asked },
    /different amount/,
  );
  refused(
    { ...request(operation(execute(withdrawalCall('ETH', TO, 12_500_000n)))), expected: asked },
    /different token/,
  );
  // Not from this wallet; a hash that isn't the operation's; another network or EntryPoint.
  refused(
    { ...request(operation(good.callData, OTHER_WALLET)), expected: asked },
    /this agent’s wallet/,
  );
  refused(
    { ...request(good, { hash: `0x${'11'.repeat(32)}` }), expected: asked },
    /match its hash/,
  );
  // The other Base network: the server was deployed after this page loaded, so reload.
  refused(
    { ...request(good, { chainId: 8453 === WITHDRAWAL_CHAIN_ID ? 84532 : 8453 }), expected: asked },
    /^This page is out of date\. Reload it and try again\.$/,
  );
  refused({ ...request(good, { chainId: 1 }), expected: asked }, /another network/);
  refused(
    { ...request(good, { entryPoint: `0x${'22'.repeat(20)}` }), expected: asked },
    /another EntryPoint/,
  );
  // A batch, an approval, or trailing bytes riding along.
  const batch = encodeFunctionData({
    abi: walletAbi,
    functionName: 'executeBatch',
    args: [
      [withdrawalCall('USDC', TO, 12_500_000n)].map((c) => ({
        target: c.target,
        value: c.value,
        data: c.data,
      })),
    ],
  });
  refused({ ...request(operation(batch)), expected: asked }, /other than a transfer/);
  const approve = encodeFunctionData({
    abi: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']),
    functionName: 'approve',
    args: [TO, 12_500_000n],
  });
  refused(
    { ...request(operation(execute({ target: USDC, value: 0n, data: approve }))), expected: asked },
    /other than a transfer/,
  );
  refused(
    { ...request(operation(`${good.callData}00` as Hex)), expected: asked },
    /other than a transfer/,
  );
  // No paymaster: the wallet would pay the fee (fees are covered), whatever the summary says.
  refused({ ...request({ ...good, paymasterAndData: '0x' }), expected: asked }, /approved sponsor/);
  // A token in the sponsor's data could charge the wallet; another paymaster isn't allowed.
  refused(
    {
      ...request({ ...good, paymasterAndData: sponsorData(SPONSOR, `${'00'.repeat(19)}01`) }),
      expected: asked,
    },
    /approved sponsor/,
  );
  refused(
    { ...request({ ...good, paymasterAndData: sponsorData(ELSEWHERE) }), expected: asked },
    /approved sponsor/,
  );
  // Without a list, only what is pinned counts: nothing on the test network, so nothing is signed.
  if (WITHDRAWAL_CHAIN_ID !== 8453)
    refused({ ...request(good), sponsors: undefined, expected: asked }, /approved sponsor/);
  // A malformed operation.
  refused(
    {
      ...request(good),
      userOperation: { ...request(good).userOperation, nonce: '0x07' as Hex },
      expected: asked,
    },
    /well formed/,
  );
});

test('a cancel is only ever the wallet’s own no-op, at the nonce of the withdrawal it cancels', () => {
  const withdrawal = operation(execute(withdrawalCall('USDC', TO, 12_500_000n)));
  const original = {
    userOperation: userOperationToRpc(withdrawal),
    userOpHash: ownerOperationHash(withdrawal),
  };
  const noop = operation(execute(noopCall(WALLET)));
  assert.equal(
    checkOperation({ ...request(noop), expected: { kind: 'noop', original } }),
    ownerOperationHash(noop),
  );
  const refused = (input: Parameters<typeof checkOperation>[0], message: RegExp) =>
    assert.throws(
      () => checkOperation(input),
      (error: unknown) => {
        assert.ok(error instanceof WithdrawalCheckError);
        assert.match((error as Error).message, message);
        return true;
      },
    );
  // A transfer offered as the cancel.
  const transfer = operation(execute(withdrawalCall('USDC', TO, 1n)));
  refused({ ...request(transfer), expected: { kind: 'noop', original } }, /cancel you asked for/);
  // A no-op at another nonce, its hash recomputed so it matches itself: it would cancel nothing.
  const elsewhere = { ...noop, nonce: noop.nonce + 1n };
  refused({ ...request(elsewhere), expected: { kind: 'noop', original } }, /withdrawal’s nonce/);
  // The withdrawal named isn't the one signed (hash), isn't this wallet's, or isn't a withdrawal.
  refused(
    {
      ...request(noop),
      expected: { kind: 'noop', original: { ...original, userOpHash: `0x${'11'.repeat(32)}` } },
    },
    /doesn’t match its hash/,
  );
  const foreign = operation(execute(withdrawalCall('USDC', TO, 12_500_000n)), OTHER_WALLET);
  refused(
    {
      ...request(noop),
      expected: {
        kind: 'noop',
        original: {
          userOperation: userOperationToRpc(foreign),
          userOpHash: ownerOperationHash(foreign),
        },
      },
    },
    /isn’t from this agent’s wallet/,
  );
  const noopOriginal = {
    userOperation: userOperationToRpc(noop),
    userOpHash: ownerOperationHash(noop),
  };
  refused(
    { ...request(noop), expected: { kind: 'noop', original: noopOriginal } },
    /no withdrawal to cancel/,
  );
  // The withdrawal check never accepts a no-op either.
  assert.throws(() => checkOperation({ ...request(noop), expected: asked }), WithdrawalCheckError);
});

test('fees covered: only an allowed sponsor in its exact layout, with no token to charge', () => {
  assert.equal(sponsorData().length, 2 + SPONSOR_DATA_BYTES * 2);
  const pinned = sponsorData('0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c');
  assert.equal(sponsoredWithoutCharge(8453, pinned), true, 'the pinned mainnet sponsor');
  assert.equal(sponsoredWithoutCharge(8453, pinned.toLowerCase()), true);
  assert.equal(
    sponsoredWithoutCharge(8453, sponsorData()),
    false,
    'another paymaster fails closed',
  );
  const token = sponsorData('0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c', `${'00'.repeat(19)}01`);
  assert.equal(sponsoredWithoutCharge(8453, token), false, 'a token: it could charge the wallet');
  assert.equal(sponsoredWithoutCharge(8453, `${pinned}00`), false, 'not its exact layout');
  assert.equal(sponsoredWithoutCharge(8453, pinned.slice(0, -2)), false);
  assert.equal(sponsoredWithoutCharge(8453, '0x'), false, 'none: the wallet would pay');
  // Nothing is pinned on the test network: there it fails closed unless a list is passed.
  assert.equal(sponsoredWithoutCharge(84532, sponsorData()), false);
  assert.equal(
    sponsoredWithoutCharge(84532, sponsorData(), SPONSORS),
    WITHDRAWAL_CHAIN_ID === 84532,
  );
});

test('a typed address is taken only when it is one (EIP-55 checked when mixed case)', () => {
  assert.equal(addressOrNull(` ${TO.toLowerCase()} `), TO);
  assert.equal(addressOrNull(TO), TO);
  // One letter's case flipped: the checksum no longer holds.
  const at = TO.slice(2).search(/[a-fA-F]/) + 2;
  const flipped =
    TO.slice(0, at) +
    (TO[at] === TO[at].toLowerCase() ? TO[at].toUpperCase() : TO[at].toLowerCase()) +
    TO.slice(at + 1);
  assert.equal(addressOrNull(flipped), null);
  assert.equal(addressOrNull('0x123'), null);
  assert.equal(addressOrNull('centralcity.ai/a/R6IsTd'), null);
});

test('a first operation that also deploys the wallet: the pinned factory, our exact owners and index', () => {
  const ATTACKER = getAddress(`0x${'12'.repeat(20)}`);
  const { smartWalletFactory: factory, spendPermissionManager: SPM } =
    BASE_NETWORKS[WITHDRAWAL_CHAIN_ID].contracts;
  const factoryAbi = parseAbi(['function createAccount(bytes[] owners, uint256 nonce)']);
  const word = (address: string) => `0x${'00'.repeat(12)}${address.slice(2).toLowerCase()}` as Hex;
  const initCode = (by: string, owners: string[], index = walletAccountIndex(AGENT)) =>
    `${by}${encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [owners.map(word), index] }).slice(2)}` as Hex;
  const deploying = (code: Hex) => {
    const op = { ...operation(execute(withdrawalCall('USDC', TO, 12_500_000n))), initCode: code };
    return request(op);
  };
  // Exactly how our wallets are made: [owner key, SpendPermissionManager] at the agent's index.
  const good = deploying(initCode(factory!, [OWNER, SPM]));
  assert.ok(checkOperation({ ...good, owner: OWNER, agentId: AGENT, expected: asked }));
  const refused = (input: Parameters<typeof checkOperation>[0]) =>
    assert.throws(() => checkOperation(input), /with other owners/);
  // Nothing to compare with: no owner, no agent (the wallet can't be derived either).
  assert.throws(
    () => checkOperation({ ...good, owner: '', expected: asked }),
    /isn’t the wallet your wallet key makes/,
  );
  assert.throws(
    () => checkOperation({ ...good, agentId: '', expected: asked }),
    /isn’t the wallet your wallet key makes/,
  );
  const by = (code: Hex) => ({ ...deploying(code), owner: OWNER, agentId: AGENT, expected: asked });
  // Another factory.
  refused(by(initCode(getAddress(`0x${'ee'.repeat(20)}`), [OWNER, SPM])));
  // An owner added, swapped in, left out, or the order changed: each would let another key move
  // the money (a valid hash and the right sender don't show that).
  refused(by(initCode(factory!, [OWNER, SPM, ATTACKER])));
  refused(by(initCode(factory!, [OWNER, ATTACKER])));
  refused(by(initCode(factory!, [ATTACKER, SPM])));
  refused(by(initCode(factory!, [OWNER])));
  refused(by(initCode(factory!, [SPM, OWNER])));
  // Another account index (another agent's, or any other).
  refused(by(initCode(factory!, [OWNER, SPM], walletAccountIndex('another-agent'))));
  refused(by(initCode(factory!, [OWNER, SPM], 0n)));
  // Not a createAccount call.
  refused(by(`${factory}deadbeef` as Hex));
});

test('the account index is the server’s: SHA-256 over the prefix and the agent id', () => {
  for (const agentId of ['11111111-1111-4111-8111-111111111111', 'a', 'é-agent'])
    assert.equal(walletAccountIndex(agentId), accountIndexFor(agentId));
});

test('the confirm screen shows the checked operation; a summary that differs signs nothing', () => {
  const op = operation(execute(withdrawalCall('USDC', TO, 12_500_000n)));
  const mainnet = WITHDRAWAL_CHAIN_ID === BASE_MAINNET;
  const summary = {
    kind: 'withdraw' as const,
    token: 'USDC' as 'USDC' | 'ETH',
    amount: { raw: '12500000', decimals: 6, display: '12.5' },
    from: WALLET,
    to: TO,
    network: mainnet ? 'Base' : 'Base Sepolia',
    testnet: !mainnet,
    sponsored: true,
    fee: {
      paidBy: 'sponsor' as const,
      token: 'ETH' as const,
      max: { raw: '0', decimals: 18, display: '0' },
    },
    deploysWallet: false,
    toIsContract: false,
  };
  const prepared = (changes: Partial<typeof summary> = {}) =>
    ({
      withdrawalId: 'w-1',
      state: 'awaiting_signature',
      userOperation: userOperationToRpc(op),
      userOpHash: ownerOperationHash(op),
      entryPoint: WITHDRAWAL_ENTRY_POINT,
      chainId: WITHDRAWAL_CHAIN_ID,
      expiresAt: 0,
      summary: { ...summary, ...changes },
    }) as SigningRequest;
  assert.deepEqual(checkedIntent(prepared(), WALLET), {
    token: 'USDC',
    amount: 12_500_000n,
    from: WALLET,
    to: TO,
    network: summary.network,
    testnet: summary.testnet,
    deploysWallet: false,
  });
  // Only the summary changed (the operation is the same, checked one): still nothing is signed.
  for (const changes of [
    { to: ELSEWHERE },
    { from: OTHER_WALLET },
    { token: 'ETH' as const },
    { amount: { raw: '1', decimals: 6, display: '0.000001' } },
    { network: mainnet ? 'Base Sepolia' : 'Base' },
    { testnet: mainnet },
    { deploysWallet: true },
  ])
    assert.throws(
      () => checkedIntent(prepared(changes), WALLET),
      /summary doesn’t match the operation/,
      JSON.stringify(changes),
    );
});

test('the anchor is kept and read back, or nothing is sent', () => {
  const anchor = {
    withdrawalId: 'w-1',
    userOperation: userOperationToRpc(operation(execute(withdrawalCall('USDC', TO, 1n)))),
    userOpHash: `0x${'22'.repeat(32)}` as Hex,
  };
  const globals = globalThis as { localStorage?: unknown };
  const before = globals.localStorage;
  try {
    // Storage that works: kept, and read back the same.
    const store = new Map<string, string>();
    globals.localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    saveAnchor('agent-1', anchor);
    assert.equal(readAnchor('agent-1')?.withdrawalId, 'w-1');
    // Full or blocked storage, or one that drops what it was given: refused, never silent.
    globals.localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      },
      removeItem: () => {},
    };
    assert.throws(() => saveAnchor('agent-1', anchor), WithdrawalAnchorError);
    globals.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    assert.throws(() => saveAnchor('agent-1', anchor), WithdrawalAnchorError);
    globals.localStorage = undefined;
    assert.throws(() => saveAnchor('agent-1', anchor), WithdrawalAnchorError);
  } finally {
    globals.localStorage = before;
  }
});

test('signing: only with the key that owns the wallet, and never once the page locked', async () => {
  const key = `0x${'42'.repeat(32)}` as Hex;
  const owner = privateKeyToAccount(key).address;
  const password = 'Local-test-only-passphrase-2026';
  const envelope = await sealKey(key, password, { N: 2 ** 17 });
  const hash = `0x${'33'.repeat(32)}` as Hex;
  const path = '/api/base/agents/a/wallet/withdrawals/w-1/signature';
  const calls: Array<{ method: string; url: string; body?: { signature: Hex } }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? 'GET', url: String(url), body });
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
    return Response.json({ withdrawalId: 'w-1', state: 'submitted' }, { status: 202 });
  }) as typeof fetch;
  try {
    const posts = () => calls.filter((call) => call.method === 'POST');
    // The owner key the wallet reports: signed over the raw hash and sent once.
    await signAndSend(
      path,
      hash,
      password,
      () => true,
      () => {},
      owner,
    );
    assert.equal(posts().length, 1);
    assert.equal(await recoverAddress({ hash, signature: posts()[0]!.body!.signature }), owner);
    // A wallet another key owns (an identity wallet): nothing signed, nothing sent.
    calls.length = 0;
    await assert.rejects(
      signAndSend(
        path,
        hash,
        password,
        () => true,
        () => {},
        getAddress(`0x${'51'.repeat(20)}`),
      ),
      (error: unknown) =>
        error instanceof WithdrawalCheckError && /isn’t this wallet’s owner/.test(error.message),
    );
    assert.equal(posts().length, 0);
    // Locked before the unlock: the vault isn't even read.
    calls.length = 0;
    await assert.rejects(
      signAndSend(
        path,
        hash,
        password,
        () => false,
        () => {},
        owner,
      ),
      WithdrawalLockedError,
    );
    assert.equal(calls.length, 0);
    // Locked during the unlock: nothing is signed or sent, and nothing kept.
    calls.length = 0;
    let checks = 0;
    let kept = false;
    await assert.rejects(
      signAndSend(
        path,
        hash,
        password,
        () => checks++ < 1,
        () => (kept = true),
        owner,
      ),
      WithdrawalLockedError,
    );
    assert.equal(posts().length, 0);
    assert.equal(kept, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('the wallet is derived here: [owner key, SpendPermissionManager] at the agent index, as the server', () => {
  const network = BASE_NETWORKS[WITHDRAWAL_CHAIN_ID];
  for (const [owner, agent] of [
    [OWNER, AGENT],
    [getAddress(`0x${'01'.repeat(20)}`), 'a'],
    [privateKeyToAccount(`0x${'42'.repeat(32)}`).address, '0a0a0a0a-0000-4000-8000-00000000000a'],
  ] as const)
    assert.equal(
      expectedWallet(owner, agent),
      deriveAddressLocal(agentWalletRecipe(network, owner, accountIndexFor(agent))),
      `${owner} ${agent}`,
    );
  assert.equal(isOwnWallet(WALLET.toLowerCase(), OWNER, AGENT), true);
  assert.equal(isOwnWallet(WALLET, OWNER, 'another-agent'), false);
  assert.equal(isOwnWallet(WALLET, OTHER_WALLET, AGENT), false);
  assert.equal(isOwnWallet('0x1234', OWNER, AGENT), false);
});

test('a substituted wallet is refused even when the operation is its own, hash and all', () => {
  // The server says the agent's wallet is OTHER_WALLET and prepares a perfect operation from it.
  const op = operation(execute(withdrawalCall('USDC', TO, 12_500_000n)), OTHER_WALLET);
  assert.throws(
    () => checkOperation({ ...request(op), wallet: OTHER_WALLET, expected: asked }),
    (error: unknown) =>
      error instanceof WithdrawalCheckError &&
      error.message === 'This isn’t the wallet your wallet key makes for this agent.',
  );
});
