import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, encodeFunctionData, getAddress, http, parseAbi } from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import {
  checkSponsorship,
  PolicyRefusal,
  type PolicyAddresses,
  type SponsorFlow,
} from '../server/base/chain/own-paymaster-policy.js';
import { encodeAccountCalls } from '../server/base/chain/submit.js';
import { BASE_MAINNET, BASE_NETWORKS } from '../shared/base/chains.js';
import { withdrawalCall } from '../shared/base/withdraw.js';
import { isReservedPayee, PROTOCOL_BASE_MAINNET, reservedPayees } from '../shared/protocol.js';
import { create, setup, usdc } from './mpr-2-fixture.js';

/**
 * Path 2 review (sponsored withdrawals), finding "CCA-142 fix incomplete: the pinned sanctions
 * oracle is still an accepted withdrawal destination".
 *
 * CCA-142's remediation listed "the sanctions oracle" among the pinned contracts to refuse.
 * REFUSED_DESTINATIONS (server/base/wallet/withdrawals.ts) takes reservedPayees(), but
 * reservedPayees() (shared/protocol.ts) left out PROTOCOL_BASE_MAINNET.sanctionsOracle. The oracle
 * (a sanctions list contract) has no function that moves a token, so USDC or ETH sent there is
 * lost for good, and the platform sponsors the gas for it.
 *
 * Fixed behaviour: 409 destination_not_allowed, as for the fee routers and the registries; the
 * oracle is a reserved payee (no payment may name it either), and our own paymaster's policy
 * refuses an exit or owner payment to it.
 *
 * Before the fix these tests FAIL (the withdrawal is prepared and sponsored, 201).
 */

const ORACLE = getAddress(PROTOCOL_BASE_MAINNET.sanctionsOracle);

test('mpr-2: a withdrawal to the pinned sanctions oracle is refused', async (t) => {
  const f = await setup(t);
  for (const [i, token] of (['USDC', 'ETH'] as const).entries()) {
    const res = await create(
      f,
      usdc(70 + i, { token, to: ORACLE, amount: token === 'USDC' ? '1500000' : '100000000000000' }),
    );
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().code, 'destination_not_allowed');
  }
  // Lowercase, too.
  const lower = await create(f, usdc(72, { to: ORACLE.toLowerCase() }));
  assert.notEqual(lower.statusCode, 201, lower.body);
});

test('mpr-2: the sanctions oracle is a reserved payee', () => {
  assert.ok(reservedPayees().has(ORACLE.toLowerCase()));
  assert.equal(isReservedPayee(ORACLE), true);
  // A configured test network's extra reserved addresses do not drop it.
  assert.ok(reservedPayees([`0x${'12'.repeat(20)}`]).has(ORACLE.toLowerCase()));
});

const net = BASE_NETWORKS[BASE_MAINNET];
const ADDRESSES: PolicyAddresses = {
  usdc: net.tokens.USDC.address,
  spendPermissionManager: net.contracts.spendPermissionManager,
  identityRegistry: net.contracts.identityRegistry!,
  reputationRegistry: net.contracts.reputationRegistry,
  smartWalletFactory: net.contracts.smartWalletFactory,
  feeRouters: [PROTOCOL_BASE_MAINNET.feeRouter, PROTOCOL_BASE_MAINNET.feeRouter2],
};
const WALLET = '0x1111111111111111111111111111111111111111' as const;
const client = createPublicClient({ transport: http('http://127.0.0.1:1') });
type Call = { target: `0x${string}`; value: bigint; data: `0x${string}` };
const opOf = async (calls: Call[]) =>
  ({
    sender: WALLET,
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
  }) as UserOperation<'0.6'>;
const refused = (op: UserOperation<'0.6'>, flow: SponsorFlow) =>
  assert.throws(
    () => checkSponsorship(op, flow, { addresses: ADDRESSES, expect: { sender: WALLET } }),
    (e: unknown) => e instanceof PolicyRefusal && e.reason === 'recipient',
  );

test("mpr-2: our own paymaster's policy never sponsors an exit or owner payment to the oracle", async () => {
  refused(await opOf([withdrawalCall('USDC', ORACLE, 1n)]), 'exit');
  refused(await opOf([withdrawalCall('ETH', ORACLE, 1n)]), 'exit');
  const transfer = encodeFunctionData({
    abi: parseAbi(['function transfer(address to, uint256 amount)']),
    functionName: 'transfer',
    args: [ORACLE, 1n],
  });
  refused(await opOf([{ target: ADDRESSES.usdc, value: 0n, data: transfer }]), 'ownerPay');
  // Another destination still passes (the refusal is the oracle's alone).
  const other = getAddress(`0x${'5e'.repeat(20)}`);
  checkSponsorship(await opOf([withdrawalCall('USDC', other, 1n)]), 'exit', {
    addresses: ADDRESSES,
    expect: { sender: WALLET },
  });
});
