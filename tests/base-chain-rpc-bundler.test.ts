import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpRequestError, LimitExceededRpcError, type PublicClient } from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import {
  BundlerError,
  bundlerFees,
  bundlerRateLimited,
  bundlerRejection,
  BUNDLER_429_WAITS_MS,
  providerRateLimit,
  retryAfterHeaderMs,
  retryAfterMs,
  rpcBundler,
  SponsorError,
  type RpcBundlerOptions,
} from '../server/base/chain/rpc-bundler.js';
import { transientChainError } from '../server/base/chain/transient.js';

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

/** An endpoint that answers HTTP 200 with a JSON-RPC error body for every call. */
const rpcErrorFetch = (error: { code: number; message: string }) =>
  (async (_url: string, init: RequestInit) => {
    const { id } = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, error }));
  }) as typeof fetch;

test('a rate limit or busy answer inside an HTTP 200 is classified busy (transient), and no other', async () => {
  const busy = [
    { code: -32002, message: 'resource unavailable' },
    { code: -32005, message: 'limit exceeded' },
    { code: 429, message: 'Too Many Requests' },
    { code: -32603, message: 'request rate limited, try later' },
  ];
  for (const error of busy) {
    // Paymaster first (a SponsorError keeps the classification and the code), then the bundler.
    const sponsored = await rpcBundler(options(rpcErrorFetch(error)))
      .prepare(op)
      .catch((e: unknown) => e);
    assert.ok(sponsored instanceof SponsorError, `code ${error.code}`);
    assert.equal(sponsored.rejection, 'busy', `code ${error.code}`);
    assert.equal(sponsored.rpcCode, error.code);
    assert.equal(transientChainError(sponsored), true, `code ${error.code} is transient`);
    const unsponsored = await rpcBundler(options(rpcErrorFetch(error)))
      .prepare(op, { sponsor: false })
      .catch((e: unknown) => e);
    assert.ok(unsponsored instanceof BundlerError && !(unsponsored instanceof SponsorError));
    assert.equal(unsponsored.rejection, 'busy');
    assert.equal(transientChainError(unsponsored), true);
    assert.ok(!unsponsored.message.includes(error.message), 'upstream text is never kept');
  }
  const real = [
    { code: -32603, message: 'internal error' },
    { code: -32602, message: 'invalid params: rate field' },
    { code: -32500, message: 'AA21 didnt pay prefund' },
  ];
  for (const error of real) {
    const rejected = bundlerRejection('eth_estimateUserOperationGas', error);
    assert.equal(rejected.rejection, 'other', `code ${error.code}`);
    assert.equal(transientChainError(rejected), false, `code ${error.code} is a real error`);
  }
  // Text alone, without a code, is never read as busy (the text is not ours to trust).
  assert.equal(bundlerRejection('m', { message: 'rate limit' }).rejection, 'other');
});

test('only a rate limit is busy: spending policies, gas limits, denials and bare limits are real errors', () => {
  const real = [
    // A paymaster refusing its spending policy: asking again never helps.
    { code: -32603, message: 'max spend limit exceeded for policy' },
    { code: -32603, message: 'gas limit exceeded' },
    { code: -32002, message: 'request denied' },
    // -32603 without clear rate-limit text, and bare "limit exceeded"/"capacity" text.
    { code: -32603, message: 'limit exceeded' },
    { code: -32603, message: 'over capacity' },
    { code: -32603, message: 'internal error' },
    { code: -32002, message: 'something went wrong' },
    // A -32005 that names a spending policy is that policy, not a rate.
    { code: -32005, message: 'max spend limit exceeded for policy' },
  ];
  for (const error of real) {
    const rejected = bundlerRejection('pm_getPaymasterData', error);
    assert.equal(rejected.rejection, 'other', `${error.code} ${error.message}`);
    assert.equal(transientChainError(new SponsorError(rejected)), false, error.message);
    // A node error viem raised with that code and text is not transient either.
    assert.equal(
      transientChainError({ code: error.code, details: error.message, message: 'RPC error' }),
      false,
      `node ${error.code} ${error.message}`,
    );
  }
  const busy = [
    { code: -32603, message: 'rate limit exceeded' },
    { code: -32603, message: 'Too Many Requests' },
    { code: -32002, message: 'resource temporarily unavailable' },
    { code: -32002, message: 'rate limited' },
    { code: -32005, message: 'limit exceeded' },
    { code: 429, message: 'slow down' },
  ];
  for (const error of busy) {
    const rejected = bundlerRejection('pm_getPaymasterData', error);
    assert.equal(rejected.rejection, 'busy', `${error.code} ${error.message}`);
    assert.equal(transientChainError(rejected), true, error.message);
  }
});

test('an HTTP 429 is asked again after short waits; a lasting one still fails, other errors at once', async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  // Two rate-limited answers, then the receipt: one call, no error.
  let limited = 2;
  let asked = 0;
  const flaky = (async (_url: string, init: RequestInit) => {
    asked++;
    const { id } = JSON.parse(String(init.body));
    if (limited-- > 0) return new Response('slow down', { status: 429 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: null }));
  }) as typeof fetch;
  assert.equal(
    await rpcBundler({ ...options(flaky), sleep, rateLimitWaitsMs: BUNDLER_429_WAITS_MS }).receipt(
      '0x01',
    ),
    null,
  );
  assert.equal(asked, 3);
  assert.deepEqual(waits, [500, 1_500]);

  // Always 429: four tries in all, then the same RPC_UNAVAILABLE as before.
  waits.length = 0;
  asked = 0;
  const always = (async () => {
    asked++;
    return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
  }) as typeof fetch;
  const error = await rpcBundler({
    ...options(always),
    sleep,
    rateLimitWaitsMs: BUNDLER_429_WAITS_MS,
  })
    .receipt('0x01')
    .catch((e: Error) => e);
  assert.ok(error instanceof BundlerError);
  assert.equal(asked, 4);
  assert.deepEqual(waits, [1_000, 1_000, 1_000]);

  // A 500 is not retried.
  asked = 0;
  const http500 = (async () => {
    asked++;
    return new Response('oops', { status: 500 });
  }) as typeof fetch;
  await rpcBundler({ ...options(http500), sleep, rateLimitWaitsMs: BUNDLER_429_WAITS_MS })
    .receipt('0x01')
    .catch(() => null);
  assert.equal(asked, 1);
});

test('Retry-After: short delays are kept, a longer one stops the retries, never an earlier try', () => {
  const now = Date.parse('2026-10-15T19:00:00Z');
  assert.equal(retryAfterMs('2', 500, now), 2_000);
  assert.equal(retryAfterMs('0', 500, now), 0);
  assert.equal(retryAfterMs('60', 500, now), null);
  assert.equal(retryAfterMs('Thu, 15 Oct 2026 19:00:02 GMT', 500, now), 2_000);
  assert.equal(retryAfterMs('Thu, 15 Oct 2026 19:01:00 GMT', 500, now), null);
  assert.equal(retryAfterMs('soon', 500, now), 500);
  assert.equal(retryAfterMs(null, 1_500, now), 1_500);
});

test('a longer Retry-After ends the retries at once with the usual transient failure', async () => {
  let asked = 0;
  const waits: number[] = [];
  const long = (async () => {
    asked++;
    return new Response('slow down', { status: 429, headers: { 'retry-after': '60' } });
  }) as typeof fetch;
  const error = await rpcBundler({
    ...options(long),
    rateLimitWaitsMs: BUNDLER_429_WAITS_MS,
    sleep: async (ms) => {
      waits.push(ms);
    },
  })
    .receipt('0x01')
    .catch((e: Error) => e);
  assert.ok(error instanceof BundlerError);
  assert.equal(error.code, 'RPC_UNAVAILABLE');
  assert.equal(asked, 1);
  assert.deepEqual(waits, []);
});

test('send: a 429 then success resends the identical operation (same signature, nonce, params)', async () => {
  const bodies: string[] = [];
  let limited = 2;
  const flaky = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(JSON.stringify({ method: body.method, params: body.params }));
    if (limited-- > 0) return new Response('slow down', { status: 429 });
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' + 'ab'.repeat(32) }),
    );
  }) as typeof fetch;
  const signed = { ...op, signature: '0x' + 'cd'.repeat(65), nonce: 7n } as typeof op;
  const hash = await rpcBundler({
    ...options(flaky),
    rateLimitWaitsMs: BUNDLER_429_WAITS_MS,
    sleep: async () => {},
  }).send(signed);
  assert.equal(hash, '0x' + 'ab'.repeat(32));
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies).size, 1);
  assert.ok(bodies[0]!.includes('eth_sendUserOperation'));
});

test('send: a lasting 429 makes four tries and then fails transient (no timeout retry)', async () => {
  let asked = 0;
  const always = (async () => {
    asked++;
    return new Response('slow down', { status: 429 });
  }) as typeof fetch;
  const error = await rpcBundler({
    ...options(always),
    rateLimitWaitsMs: BUNDLER_429_WAITS_MS,
    sleep: async () => {},
  })
    .send(op)
    .catch((e: Error) => e);
  assert.ok(error instanceof BundlerError);
  assert.equal(asked, 4);
  // A network failure (timeout) is never retried here.
  asked = 0;
  const down = (async () => {
    asked++;
    throw new Error('timeout');
  }) as typeof fetch;
  await rpcBundler({
    ...options(down),
    rateLimitWaitsMs: BUNDLER_429_WAITS_MS,
    sleep: async () => {},
  })
    .send(op)
    .catch(() => null);
  assert.equal(asked, 1);
});

test('without rateLimitWaitsMs a 429 fails at once (bulk work is never multiplied)', async () => {
  let asked = 0;
  const limited = (async () => {
    asked++;
    return new Response('slow down', { status: 429 });
  }) as typeof fetch;
  await rpcBundler(options(limited))
    .receipt('0x01')
    .catch(() => null);
  assert.equal(asked, 1);
});

test('a non-OK answer carries its HTTP status and the Retry-After as data (seconds or a date)', async () => {
  const now = Date.parse('2026-10-15T19:00:00Z');
  assert.equal(retryAfterHeaderMs('120', now), 120_000);
  assert.equal(retryAfterHeaderMs('Thu, 15 Oct 2026 19:02:00 GMT', now), 120_000);
  assert.equal(retryAfterHeaderMs('Thu, 15 Oct 2026 18:59:00 GMT', now), 0);
  assert.equal(retryAfterHeaderMs('soon', now), null);
  assert.equal(retryAfterHeaderMs(null, now), null);

  const answering = (status: number, headers: Record<string, string> = {}) =>
    (async () => new Response('slow down', { status, headers })) as typeof fetch;
  // Without waits of its own (or past them), a 429 is thrown with its status and Retry-After.
  const receipt = await rpcBundler(options(answering(429, { 'retry-after': '120' })))
    .receipt('0x01')
    .catch((e: Error) => e);
  assert.ok(receipt instanceof BundlerError);
  assert.equal(receipt.code, 'RPC_UNAVAILABLE');
  assert.equal(receipt.httpStatus, 429);
  assert.equal(receipt.retryAfterMs, 120_000);
  assert.equal(bundlerRateLimited(receipt), true);
  assert.doesNotMatch(receipt.message, /SECRETKEY123/);

  // The paymaster's 429 is a SponsorError with the same data.
  const sponsor = await rpcBundler(options(answering(429)))
    .prepare(op)
    .catch((e: Error) => e);
  assert.ok(sponsor instanceof SponsorError);
  assert.equal(sponsor.httpStatus, 429);
  assert.equal(sponsor.retryAfterMs, null, 'no Retry-After: null, never a guess');
  assert.equal(bundlerRateLimited(sponsor), true);

  // A 500 carries its status but is no rate limit.
  const failed = await rpcBundler(options(answering(500, { 'retry-after': '5' })))
    .receipt('0x01')
    .catch((e: Error) => e);
  assert.ok(failed instanceof BundlerError);
  assert.equal(failed.httpStatus, 500);
  assert.equal(failed.retryAfterMs, 5_000);
  assert.equal(bundlerRateLimited(failed), false);
});

test('only a 429 or a busy answer is a rate limit: policy, allowlist, funds and the rest are not', () => {
  const busy = bundlerRejection('pm_getPaymasterStubData', {
    code: -32005,
    message: 'limit exceeded',
  });
  assert.equal(busy.rejection, 'busy');
  assert.equal(bundlerRateLimited(busy), true);
  assert.equal(bundlerRateLimited(new SponsorError(busy)), true);
  for (const error of [
    bundlerRejection('pm_getPaymasterStubData', {
      code: -32002,
      message: 'max spend limit exceeded for policy',
    }),
    bundlerRejection('pm_getPaymasterData', {
      code: -32603,
      message: 'not in allowlist: 0x12345678',
    }),
    bundlerRejection('eth_estimateUserOperationGas', {
      code: -32500,
      message: "AA21 didn't pay prefund",
    }),
    new BundlerError('RPC_UNAVAILABLE', 'eth_sendUserOperation: bundler not reachable.'),
    new BundlerError('FEE_CAP_EXCEEDED', 'Network fees are above the configured cap.'),
    new SponsorError(new Error('anything')),
    new Error('HTTP 429: rate limited'),
  ])
    assert.equal(bundlerRateLimited(error), false, error.message);
});

test('busy -32002 and -32005 answers are rate limits for bundlerRateLimited', () => {
  for (const answer of [
    { code: -32002, message: 'resource unavailable' },
    { code: -32002, message: 'rate limited' },
    { code: -32005, message: 'limit exceeded' },
  ]) {
    const error = bundlerRejection('eth_estimateUserOperationGas', answer);
    assert.equal(bundlerRateLimited(error), true, answer.message);
    assert.equal(bundlerRateLimited(new SponsorError(error)), true, answer.message);
  }
});

test('providerRateLimit: a bundler 429 or busy answer, or a node read refused for its rate', () => {
  const bundler429 = new SponsorError(
    new BundlerError(
      'RPC_UNAVAILABLE',
      'pm_getPaymasterStubData: HTTP 429.',
      undefined,
      undefined,
      429,
      7_000,
    ),
  );
  assert.deepEqual(providerRateLimit(bundler429), { retryAfterMs: 7_000 });
  assert.deepEqual(
    providerRateLimit(
      bundlerRejection('pm_getPaymasterStubData', {
        code: -32002,
        message: 'resource unavailable',
      }),
    ),
    { retryAfterMs: null },
  );
  // viem's contract read (the operation's nonce) wrapping the endpoint's HTTP 429.
  const http = new HttpRequestError({
    status: 429,
    url: SECRET_URL,
    headers: new Headers({ 'retry-after': '20' }),
  });
  const read = Object.assign(new Error('getNonce failed'), { cause: http });
  assert.deepEqual(providerRateLimit(read), { retryAfterMs: 20_000 });
  assert.deepEqual(providerRateLimit(new HttpRequestError({ status: 429, url: SECRET_URL })), {
    retryAfterMs: null,
  });
  // A JSON-RPC rate-limit answer of the node.
  assert.deepEqual(providerRateLimit(new LimitExceededRpcError(new Error('limit exceeded'))), {
    retryAfterMs: null,
  });
  for (const error of [
    new HttpRequestError({ status: 500, url: SECRET_URL }),
    bundlerRejection('pm_getPaymasterStubData', {
      code: -32002,
      message: 'max spend limit exceeded for policy',
    }),
    // A bundler's own non-rate refusal is not overruled by anything it wraps.
    Object.assign(
      new BundlerError('RPC_ERROR', 'eth_estimateUserOperationGas: rejected.', 'other'),
      {
        cause: new HttpRequestError({ status: 429, url: SECRET_URL }),
      },
    ),
    new BundlerError('FEE_CAP_EXCEEDED', 'Network fees are above the configured cap.'),
    new Error('HTTP 429: rate limited'),
    new Error('timeout'),
  ])
    assert.equal(providerRateLimit(error), null, error.message);
});
