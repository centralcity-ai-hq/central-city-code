import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
  type Hex,
} from 'viem';
import { createPublicClient, http } from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import {
  checkSponsorship,
  GAS_CEILINGS,
  PAUSED_FLOWS,
  PolicyRefusal,
  type PolicyAddresses,
  type SponsorFlow,
} from '../server/base/chain/own-paymaster-policy.js';
import { encodeAccountCalls } from '../server/base/chain/submit.js';
import { noopCall, withdrawalCall } from '../shared/base/withdraw.js';
import { rateCall } from '../shared/base/rate.js';
import { revokeCall } from '../shared/base/spend-limits.js';
import { feeCalls, payCalls } from '../server/protocol/fees/fee-call.js';
import { BASE_MAINNET, BASE_NETWORKS } from '../shared/base/chains.js';

// Operation Paymaster's sponsorship policy (server/base/chain/own-paymaster-policy.ts): the real
// call builders of every flow pass; anything else is refused before a signature exists.

const net = BASE_NETWORKS[BASE_MAINNET];
const USDC = net.tokens.USDC.address;
const ROUTER1 = '0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B' as const;
const ROUTER2 = '0xb1945A2Af160E84E34F7c0fB0E4DD94FD4c0aF0D' as const;
const ADDRESSES: PolicyAddresses = {
  usdc: USDC,
  spendPermissionManager: net.contracts.spendPermissionManager,
  identityRegistry: net.contracts.identityRegistry!,
  reputationRegistry: net.contracts.reputationRegistry,
  smartWalletFactory: net.contracts.smartWalletFactory,
  feeRouters: [ROUTER1, ROUTER2],
};
const WALLET = '0x1111111111111111111111111111111111111111' as const;
const SPENDER = '0x2222222222222222222222222222222222222222' as const;
const OWNER = '0x3333333333333333333333333333333333333333' as const;
const SELLER = '0x4444444444444444444444444444444444444444' as const;
const client = createPublicClient({ transport: http('http://127.0.0.1:1') });

type Call = { target: `0x${string}`; value: bigint; data: Hex };
const opOf = async (
  sender: `0x${string}`,
  calls: Call[],
  extra: Partial<UserOperation<'0.6'>> = {},
) =>
  ({
    sender,
    nonce: 0n,
    initCode: '0x',
    callData: await encodeAccountCalls(client, calls),
    callGasLimit: 200_000n,
    verificationGasLimit: 150_000n,
    preVerificationGas: 60_000n,
    maxFeePerGas: 20_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    paymasterAndData: '0x',
    signature: '0x',
    ...extra,
  }) as UserOperation<'0.6'>;
const ok = (op: UserOperation<'0.6'>, flow: SponsorFlow) =>
  checkSponsorship(op, flow, { addresses: ADDRESSES, expect: { sender: op.sender } });
const refused = (op: UserOperation<'0.6'>, flow: SponsorFlow, reason: PolicyRefusal['reason']) =>
  assert.throws(
    () => ok(op, flow),
    (e: unknown) => e instanceof PolicyRefusal && e.reason === reason,
    `${flow} must be refused with ${reason}`,
  );

const permission = (overrides: Record<string, unknown> = {}) => ({
  account: WALLET,
  spender: SPENDER,
  token: USDC,
  allowance: 1_000_000n,
  period: 86_400,
  start: 0,
  end: 2 ** 40,
  salt: 1n,
  extraData: '0x' as Hex,
  ...overrides,
});
const spmAbi = parseAbi([
  'struct SpendPermission { address account; address spender; address token; uint160 allowance; uint48 period; uint48 start; uint48 end; uint256 salt; bytes extraData; }',
  'function approveWithSignature(SpendPermission spendPermission, bytes signature)',
  'function spend(SpendPermission spendPermission, uint160 value)',
]);
const spm = (fn: 'approveWithSignature' | 'spend', p = permission()): Call => ({
  target: ADDRESSES.spendPermissionManager,
  value: 0n,
  data:
    fn === 'spend'
      ? encodeFunctionData({ abi: spmAbi, functionName: 'spend', args: [p as never, 5n] })
      : encodeFunctionData({
          abi: spmAbi,
          functionName: 'approveWithSignature',
          args: [p as never, '0x1234'],
        }),
});
const identityAbi = parseAbi([
  'function register(string tokenURI)',
  'function transferFrom(address from, address to, uint256 tokenId)',
]);
const usdcAbi = parseAbi([
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
]);

test('exit: USDC and ETH withdrawals, cancel and revoke (the real builders) pass', async () => {
  ok(await opOf(WALLET, [withdrawalCall('USDC', OWNER, 5_000_000n)]), 'exit');
  ok(await opOf(WALLET, [withdrawalCall('ETH', OWNER, 10n ** 15n)]), 'exit');
  ok(await opOf(WALLET, [noopCall(WALLET)]), 'exit');
  ok(await opOf(WALLET, [revokeCall(BASE_MAINNET, permission() as never)]), 'exit');
});

test("exit: refused recipients, other wallets' permissions and batches", async () => {
  for (const to of [ADDRESSES.spendPermissionManager, ADDRESSES.smartWalletFactory, USDC, WALLET])
    refused(await opOf(WALLET, [withdrawalCall('USDC', to, 1n)]), 'exit', 'recipient');
  refused(await opOf(WALLET, [withdrawalCall('ETH', USDC, 1n)]), 'exit', 'recipient');
  refused(
    await opOf(WALLET, [revokeCall(BASE_MAINNET, permission({ account: SELLER }) as never)]),
    'exit',
    'recipient',
  );
  // Two calls (executeBatch) are never an owner operation.
  refused(
    await opOf(WALLET, [withdrawalCall('USDC', OWNER, 1n), noopCall(WALLET)]),
    'exit',
    'unknown_call',
  );
  // USDC approve/other functions are not exits.
  refused(
    await opOf(WALLET, [
      {
        target: USDC,
        value: 0n,
        data: encodeFunctionData({ abi: usdcAbi, functionName: 'approve', args: [OWNER, 1n] }),
      },
    ]),
    'exit',
    'unknown_call',
  );
});

test('a paused flow is refused whatever the call; ratings are not paused by default', async () => {
  assert.equal(PAUSED_FLOWS.size, 0);
  // The real rating passes by default.
  checkSponsorship(await opOf(WALLET, [rateCall(42n, 5)]), 'rate', {
    addresses: ADDRESSES,
    expect: { sender: WALLET },
  });
  // Paused again (config), it is refused whatever the call.
  const op = await opOf(WALLET, [rateCall(42n, 5)]);
  assert.throws(
    () =>
      checkSponsorship(op, 'rate', {
        addresses: ADDRESSES,
        expect: { sender: WALLET },
        paused: new Set(['rate']),
      }),
    /paused/,
  );
  // ...and a giveFeedback can't hide inside another flow.
  refused(await opOf(WALLET, [rateCall(42n, 5)]), 'exit', 'unknown_call');
  refused(await opOf(SPENDER, [spm('spend'), rateCall(42n, 5)]), 'feedPay', 'unknown_call');
});

test('registration: register and the hand-over from the spender pass; others are refused', async () => {
  const register: Call = {
    target: ADDRESSES.identityRegistry,
    value: 0n,
    data: encodeFunctionData({
      abi: identityAbi,
      functionName: 'register',
      args: ['https://centralcity.ai/a/AbC123'],
    }),
  };
  const handOver = (from: `0x${string}`): Call => ({
    target: ADDRESSES.identityRegistry,
    value: 0n,
    data: encodeFunctionData({
      abi: identityAbi,
      functionName: 'transferFrom',
      args: [from, WALLET, 7n],
    }),
  });
  ok(await opOf(SPENDER, [register]), 'registration');
  ok(await opOf(SPENDER, [handOver(SPENDER)]), 'registration');
  refused(await opOf(SPENDER, [handOver(SELLER)]), 'registration', 'recipient');
  refused(await opOf(SPENDER, [withdrawalCall('USDC', OWNER, 1n)]), 'registration', 'unknown_call');
});

test('feedPay / agentPay: the real fee and pay calls pass; routers and spenders are pinned', async () => {
  const fee = feeCalls({
    usdc: USDC,
    router: ROUTER1,
    payee: SELLER,
    quote: { gross: 50_000n, fee: 5_000n, total: 55_000n },
    paymentIntentId: 'pi_1',
  }).map((c) => ({ target: c.to, value: c.value, data: c.data }));
  const included = payCalls({
    usdc: USDC,
    router: ROUTER2,
    payee: SELLER,
    quote: { gross: 90_000n, fee: 9_000n, net: 81_000n },
    paymentIntentId: 'pi_2',
  }).map((c) => ({ target: c.to, value: c.value, data: c.data }));
  ok(await opOf(SPENDER, [spm('approveWithSignature'), spm('spend'), ...fee]), 'feedPay');
  ok(await opOf(SPENDER, [spm('spend'), ...included]), 'feedPay');
  ok(
    await opOf(SPENDER, [
      spm('spend'),
      {
        target: USDC,
        value: 0n,
        data: encodeFunctionData({ abi: usdcAbi, functionName: 'transfer', args: [SELLER, 5n] }),
      },
    ]),
    'agentPay',
  );
  // A router not pinned, an approve to a stranger, a permission for another spender or token.
  refused(
    await opOf(SPENDER, [{ target: SELLER, value: 0n, data: fee[1]!.data }]),
    'feedPay',
    'unknown_call',
  );
  refused(
    await opOf(SPENDER, [
      {
        target: USDC,
        value: 0n,
        data: encodeFunctionData({ abi: usdcAbi, functionName: 'approve', args: [SELLER, 1n] }),
      },
    ]),
    'feedPay',
    'recipient',
  );
  refused(
    await opOf(SPENDER, [spm('spend', permission({ spender: SELLER }))]),
    'feedPay',
    'recipient',
  );
  refused(
    await opOf(SPENDER, [spm('spend', permission({ token: SELLER }))]),
    'agentPay',
    'recipient',
  );
  refused(await opOf(SPENDER, fee), 'agentPay', 'recipient');
});

test('value, trailing bytes, foreign factory and gas ceilings are refused', async () => {
  refused(await opOf(SPENDER, [{ ...spm('spend'), value: 1n }]), 'feedPay', 'value');
  const good = await opOf(SPENDER, [spm('spend')]);
  refused({ ...good, callData: `${good.callData}00` as Hex }, 'feedPay', 'malformed');
  refused(
    await opOf(SPENDER, [{ ...spm('spend'), data: `${spm('spend').data}ab` as Hex }]),
    'feedPay',
    'unknown_call',
  );
  refused({ ...good, callData: '0xdeadbeef' }, 'feedPay', 'malformed');
  refused({ ...good, initCode: `${SELLER}3ffba36f` as Hex }, 'feedPay', 'factory');
  for (const field of [
    'callGasLimit',
    'preVerificationGas',
    'maxFeePerGas',
    'maxPriorityFeePerGas',
    'verificationGasLimit',
  ] as const)
    refused(
      { ...good, [field]: (GAS_CEILINGS as unknown as Record<string, bigint>)[field]! + 1n },
      'feedPay',
      'gas_ceiling',
    );
  refused({ ...good, maxPriorityFeePerGas: good.maxFeePerGas + 1n }, 'feedPay', 'gas_ceiling');
});

test('S3/A13: an operation for another sender than the caller prepared is refused', async () => {
  const op = await opOf(WALLET, [withdrawalCall('USDC', OWNER, 1n)]);
  assert.throws(
    () => checkSponsorship(op, 'exit', { addresses: ADDRESSES, expect: { sender: SPENDER } }),
    (e: unknown) => e instanceof PolicyRefusal && e.reason === 'sender',
  );
});

test('S4: zero-amount exits and payments, and a value-less "ETH transfer" to another address, are refused', async () => {
  refused(await opOf(WALLET, [withdrawalCall('USDC', OWNER, 0n)]), 'exit', 'value');
  refused(await opOf(WALLET, [{ target: OWNER, value: 0n, data: '0x' }]), 'exit', 'value');
  refused(await opOf(WALLET, [withdrawalCall('USDC', SELLER, 0n)]), 'ownerPay', 'value');
  ok(await opOf(WALLET, [withdrawalCall('USDC', SELLER, 1n)]), 'ownerPay');
});

test('S6: an ERC-6492-wrapped approval deploys only through the pinned factory', async () => {
  const sixFourNine = (factory: `0x${string}`, calldata: Hex) =>
    (encodeAbiParameters(parseAbiParameters('address, bytes, bytes'), [
      factory,
      calldata,
      '0x1234',
    ]) + '6492649264926492649264926492649264926492649264926492649264926492') as Hex;
  const createAccount = encodeFunctionData({
    abi: parseAbi(['function createAccount(bytes[] owners, uint256 nonce)']),
    functionName: 'createAccount',
    args: [['0x0000000000000000000000003333333333333333333333333333333333333333'], 0n],
  });
  const approve = (signature: Hex): Call => ({
    target: ADDRESSES.spendPermissionManager,
    value: 0n,
    data: encodeFunctionData({
      abi: spmAbi,
      functionName: 'approveWithSignature',
      args: [permission() as never, signature],
    }),
  });
  ok(
    await opOf(SPENDER, [
      approve(sixFourNine(ADDRESSES.smartWalletFactory, createAccount)),
      spm('spend'),
    ]),
    'feedPay',
  );
  refused(await opOf(SPENDER, [approve(sixFourNine(SELLER, createAccount))]), 'feedPay', 'factory');
  refused(
    await opOf(SPENDER, [approve(sixFourNine(ADDRESSES.smartWalletFactory, '0xdeadbeef'))]),
    'feedPay',
    'factory',
  );
});

test('S8: nested ratings via self-calls, dirty padding, a valid factory with bad calldata, exact ceilings', async () => {
  // A spender batch calling its own wallet (which could re-enter execute) is not an allowed call.
  const selfExecute: Call = {
    target: SPENDER,
    value: 0n,
    data: await encodeAccountCalls(client, [rateCall(42n, 5)]),
  };
  refused(await opOf(SPENDER, [spm('spend'), selfExecute]), 'feedPay', 'unknown_call');
  refused(await opOf(SPENDER, [selfExecute]), 'registration', 'unknown_call');
  // Dirty padding in an address word (non-canonical): refused by the re-encode check.
  const transfer = encodeFunctionData({
    abi: usdcAbi,
    functionName: 'transfer',
    args: [OWNER, 5n],
  });
  const dirty = (transfer.slice(0, 10) + 'ff' + transfer.slice(12)) as Hex;
  refused(await opOf(WALLET, [{ target: USDC, value: 0n, data: dirty }]), 'exit', 'unknown_call');
  // The pinned factory with calldata that is not createAccount.
  const good = await opOf(SPENDER, [spm('spend')]);
  refused(
    { ...good, initCode: `${ADDRESSES.smartWalletFactory}deadbeef` as Hex },
    'feedPay',
    'factory',
  );
  // Exactly at every ceiling passes (the ceilings are inclusive).
  ok(
    {
      ...good,
      callGasLimit: GAS_CEILINGS.callGasLimit,
      verificationGasLimit: GAS_CEILINGS.verificationGasLimit,
      preVerificationGas: GAS_CEILINGS.preVerificationGas,
      maxFeePerGas: GAS_CEILINGS.maxFeePerGas,
      maxPriorityFeePerGas: GAS_CEILINGS.maxPriorityFeePerGas,
    },
    'feedPay',
  );
});
