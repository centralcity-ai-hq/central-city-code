import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicClient } from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import {
  BundlerError,
  bundlerFees,
  rpcBundler,
  SponsorError,
  type RpcBundlerOptions,
} from '../server/base/chain/rpc-bundler.js';

const ENTRY_POINT = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
const SECRET_URL = 'https://bundler.example/rpc/v1/base-sepolia/SECRETKEY123';

const op: UserOperation<'0.6'> = {
  sender: '0x1111111111111111111111111111111111111111',
  nonce: 5n,
  initCode: '0x',
  callData: '0xabcd',
  callGasLimit: 0n,
  verificationGasLimit: 0n,
  preVerificationGas: 0n,
  maxFeePerGas: 0n,
  maxPriorityFeePerGas: 0n,
  paymasterAndData: '0x',
  signature: '0x',
};

function fakeRpc(handlers: Record<string, (params: unknown[]) => unknown>) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init.body));
    calls.push({ method, params });
    const handler = handlers[method];
    if (!handler)
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id, error: { message: `no ${method}` } }),
      );
    try {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: handler(params) }));
    } catch (error) {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id, error: { message: (error as Error).message } }),
      );
    }
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const client = (maxFeePerGas: bigint, baseFeePerGas = 0n, maxPriorityFeePerGas = 1_000n) =>
  ({
    estimateFeesPerGas: async () => ({ maxFeePerGas, maxPriorityFeePerGas }),
    getBlock: async () => ({ baseFeePerGas }),
  }) as unknown as PublicClient;

const options = (fetchImpl: typeof fetch, fee = 10_000_000n): RpcBundlerOptions => ({
  url: SECRET_URL,
  entryPoint: ENTRY_POINT,
  chainId: 84532,
  client: client(fee),
  maxFeePerGasCap: 50_000_000n,
  stubSignature: '0x1234' as const,
  fetch: fetchImpl,
});

test('prepare: stub paymaster data → gas estimate → final paymaster data, hex-encoded v0.6 fields', async () => {
  const rpc = fakeRpc({
    pm_getPaymasterStubData: () => ({ paymasterAndData: '0xaa' }),
    eth_estimateUserOperationGas: () => ({
      callGasLimit: '0x10',
      verificationGasLimit: '0x20',
      preVerificationGas: '0x30',
    }),
    pm_getPaymasterData: () => ({ paymasterAndData: '0xbbcc' }),
  });
  const prepared = await rpcBundler(options(rpc.fetchImpl)).prepare(op);
  assert.deepEqual(
    rpc.calls.map((c) => c.method),
    ['pm_getPaymasterStubData', 'eth_estimateUserOperationGas', 'pm_getPaymasterData'],
  );
  assert.deepEqual(rpc.calls[0].params.slice(1), [ENTRY_POINT, '0x14a34', {}]);
  const sent = rpc.calls[1].params[0] as Record<string, string>;
  assert.equal(sent.nonce, '0x5');
  assert.equal(sent.paymasterAndData, '0xaa');
  assert.equal(sent.signature, '0x1234', 'gas is estimated with the stub signature');
  assert.equal(prepared.callGasLimit, 16n);
  assert.equal(prepared.verificationGasLimit, 32n);
  assert.equal(prepared.preVerificationGas, 48n);
  assert.equal(prepared.maxFeePerGas, 10_000_000n);
  assert.equal(prepared.paymasterAndData, '0xbbcc');
  assert.equal(prepared.signature, '0x', 'the real signature is added after prepare');
});

test('fee guard: above the cap nothing is prepared or sent', async () => {
  const rpc = fakeRpc({});
  await assert.rejects(
    rpcBundler(options(rpc.fetchImpl, 60_000_000n)).prepare(op),
    (e: unknown) => e instanceof BundlerError && e.code === 'FEE_CAP_EXCEEDED',
  );
  assert.equal(rpc.calls.length, 0);
});

test('fee floor: fees set on the operation are minimums (a replacement outbids), still capped', async () => {
  const rpc = fakeRpc({
    pm_getPaymasterStubData: () => ({ paymasterAndData: '0xaa' }),
    eth_estimateUserOperationGas: () => ({
      callGasLimit: '0x10',
      verificationGasLimit: '0x20',
      preVerificationGas: '0x30',
    }),
    pm_getPaymasterData: () => ({ paymasterAndData: '0xbbcc' }),
  });
  const floor = { ...op, maxFeePerGas: 22_000_001n, maxPriorityFeePerGas: 1_100_001n };
  const raised = await rpcBundler(options(rpc.fetchImpl)).prepare(floor);
  assert.equal(raised.maxFeePerGas, 22_000_001n);
  assert.equal(raised.maxPriorityFeePerGas, 1_100_001n);
  assert.equal((rpc.calls[1].params[0] as Record<string, string>).maxFeePerGas, '0x14fb181');
  // Below the estimate a floor changes nothing.
  const low = await rpcBundler(options(rpc.fetchImpl)).prepare({ ...op, maxFeePerGas: 1n });
  assert.equal(low.maxFeePerGas, 10_000_000n);
  assert.equal(low.maxPriorityFeePerGas, 1_000n);
  // A floor above the cap is refused like any fee above it.
  const capped = fakeRpc({});
  await assert.rejects(
    rpcBundler(options(capped.fetchImpl)).prepare({ ...op, maxFeePerGas: 50_000_001n }),
    (e: unknown) => e instanceof BundlerError && e.code === 'FEE_CAP_EXCEEDED',
  );
  assert.equal(capped.calls.length, 0);
});

test('sponsorship: a refusing paymaster is a SponsorError; unsponsored asks no paymaster', async () => {
  const refusing = fakeRpc({
    pm_getPaymasterStubData: () => {
      throw new Error('policy rejected');
    },
  });
  await assert.rejects(
    rpcBundler(options(refusing.fetchImpl)).prepare(op),
    (e: unknown) =>
      e instanceof SponsorError && e instanceof BundlerError && e.code === 'RPC_ERROR',
  );
  const unsponsored = fakeRpc({
    eth_estimateUserOperationGas: () => ({
      callGasLimit: '0x10',
      verificationGasLimit: '0x20',
      preVerificationGas: '0x30',
    }),
  });
  const prepared = await rpcBundler(options(unsponsored.fetchImpl)).prepare(op, {
    sponsor: false,
  });
  assert.deepEqual(
    unsponsored.calls.map((c) => c.method),
    ['eth_estimateUserOperationGas'],
  );
  assert.equal((unsponsored.calls[0].params[0] as Record<string, string>).paymasterAndData, '0x');
  assert.equal(prepared.paymasterAndData, '0x');
  assert.equal(prepared.callGasLimit, 16n);
  // The estimation itself failing is not a sponsorship problem.
  const down = fakeRpc({});
  await assert.rejects(
    rpcBundler(options(down.fetchImpl)).prepare(op, { sponsor: false }),
    (e: unknown) => e instanceof BundlerError && !(e instanceof SponsorError),
  );
  // The fee cap holds unsponsored too, before anything is asked.
  const capped = fakeRpc({});
  await assert.rejects(
    rpcBundler(options(capped.fetchImpl, 60_000_000n)).prepare(op, { sponsor: false }),
    (e: unknown) => e instanceof BundlerError && e.code === 'FEE_CAP_EXCEEDED',
  );
  assert.equal(capped.calls.length, 0);
});

test('send: an operation the bundler already knows is success, other errors are not', async () => {
  const known = fakeRpc({
    eth_sendUserOperation: () => {
      throw new Error('already known');
    },
  });
  // Already known: success with the locally computed hash, never a placeholder.
  const hash = await rpcBundler(options(known.fetchImpl)).send(op);
  assert.match(hash, /^0x[0-9a-f]{64}$/);

  // AA25 does not prove this op is known (another op may have used the nonce): its own code.
  const nonceUsed = fakeRpc({
    eth_sendUserOperation: () => {
      throw new Error('AA25 invalid account nonce');
    },
  });
  await assert.rejects(
    rpcBundler(options(nonceUsed.fetchImpl)).send(op),
    (e: unknown) => e instanceof BundlerError && e.code === 'NONCE_CONSUMED',
  );
  // A bare 'duplicate' is not proof either.
  const duplicate = fakeRpc({
    eth_sendUserOperation: () => {
      throw new Error('duplicate');
    },
  });
  await assert.rejects(
    rpcBundler(options(duplicate.fetchImpl)).send(op),
    (e: unknown) => e instanceof BundlerError && e.code === 'RPC_ERROR',
  );
  const failing = fakeRpc({
    eth_sendUserOperation: () => {
      throw new Error("AA21 didn't pay prefund");
    },
  });
  await assert.rejects(rpcBundler(options(failing.fetchImpl)).send(op), /AA21/);
});

test('receipt: null until included, then mapped; malformed responses refused', async () => {
  let included = false;
  const rpc = fakeRpc({
    eth_getUserOperationReceipt: () =>
      included
        ? {
            success: true,
            actualGasCost: '0x64',
            actualGasUsed: '0x32',
            receipt: { transactionHash: `0x${'ab'.repeat(32)}`, blockNumber: '0x10' },
          }
        : null,
  });
  const bundler = rpcBundler(options(rpc.fetchImpl));
  assert.equal(await bundler.receipt(`0x${'01'.repeat(32)}`), null);
  included = true;
  assert.deepEqual(await bundler.receipt(`0x${'01'.repeat(32)}`), {
    success: true,
    txHash: `0x${'ab'.repeat(32)}`,
    blockNumber: 16n,
    actualGasUsed: 50n,
    actualGasCost: 100n,
  });
  const bad = fakeRpc({ eth_getUserOperationReceipt: () => ({ success: 'yes' }) });
  await assert.rejects(rpcBundler(options(bad.fetchImpl)).receipt('0x01'), /invalid receipt/);
});

test('the endpoint URL (it contains the key) never appears in errors', async () => {
  const down = (async () => {
    throw new Error(`connect ECONNREFUSED ${SECRET_URL}`);
  }) as typeof fetch;
  const http500 = (async () => new Response('oops', { status: 500 })) as typeof fetch;
  for (const fetchImpl of [down, http500]) {
    const error = await rpcBundler(options(fetchImpl))
      .receipt('0x01')
      .catch((e: Error) => e);
    assert.ok(error instanceof BundlerError);
    assert.equal(String(error.message).includes('SECRETKEY123'), false);
    assert.equal(String(error.stack).includes('SECRETKEY123'), false);
  }
});

test('a bundler error that echoes the URL, key or payload is never repeated (E2)', async () => {
  const echo = fakeRpc({
    eth_sendUserOperation: () => {
      throw new Error(
        `AA33 reverted calling ${SECRET_URL} with {"sender":"0xpayload"} SECRETKEY123`,
      );
    },
    eth_getUserOperationReceipt: () => {
      throw new Error(`upstream ${SECRET_URL} said no`);
    },
  });
  const bundler = rpcBundler(options(echo.fetchImpl));
  for (const call of [() => bundler.send(op), () => bundler.receipt('0x01')]) {
    const error = await call().catch((e: Error) => e);
    assert.ok(error instanceof BundlerError);
    assert.equal(error.code, 'RPC_ERROR');
    for (const leak of ['SECRETKEY123', 'bundler.example', '0xpayload'])
      for (const text of [String(error.message), String(error.stack), JSON.stringify(error)])
        assert.equal(text.includes(leak), false, `${leak} leaked`);
  }
  // The EntryPoint code alone is kept, so failures stay diagnosable.
  await assert.rejects(bundler.send(op), /AA33/);
});

test('fees: twice the base fee plus tip clears a bundler minimum a plain estimate misses (#435)', async () => {
  // The live case: base fee 5,253,191 and tip 1,000,000 → the plain estimate (base × 1.2 + tip) was
  // 7,303,829 and the bundler required at least 7,660,000. Twice the base fee plus tip clears it.
  const fees = await bundlerFees(client(7_303_829n, 5_253_191n, 1_000_000n));
  assert.equal(fees.maxPriorityFeePerGas, 1_000_000n);
  assert.equal(fees.maxFeePerGas, 5_253_191n * 2n + 1_000_000n);
  assert.ok(fees.maxFeePerGas >= 7_660_000n);
  // Never below the plain estimate.
  assert.equal((await bundlerFees(client(9_000_000n, 1_000n, 1_000n))).maxFeePerGas, 9_000_000n);
});
