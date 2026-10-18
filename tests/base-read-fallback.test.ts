import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  multicall3Abi,
  type Hex,
} from 'viem';
import { BASE_MAINNET, BASE_NETWORKS, BASE_SEPOLIA, MULTICALL3 } from '../shared/base/chains.js';
import { PUBLIC_BASE_RPC } from '../shared/base/on-base.js';
import { baseBalanceReader } from '../server/base/chain/balances.js';
import { identityRegistryAbi } from '../server/base/chain/identity-chain.js';
import {
  baseReadTransport,
  baseReadUrls,
  mayFallBack,
  READ_FALLBACK_SETTING,
} from '../server/base/chain/read-transport.js';
import { rpcBundler } from '../server/base/chain/rpc-bundler.js';
import { CDP_RETRY } from '../server/base/chain/rpc-budget.js';
import { payChainReader } from '../server/base/pay/chain.js';

const NETWORK = BASE_NETWORKS[BASE_MAINNET];
const CHAIN_HEX = '0x2105';
const WALLET = getAddress(`0x${'1'.repeat(40)}`);
const OWNER = getAddress(`0x${'4'.repeat(40)}`);
const HEAD = 0x500n;
const blockHash = (n: bigint, tag = 'a'): Hex =>
  `0x${tag.repeat(48)}${n.toString(16).padStart(16, '0')}`;

type Call = { id: number; method: string; params: unknown[] };
type Answer =
  { result: unknown } | { error: { code: number; message: string } } | { status: number };

/** A JSON-RPC stand-in: `answer` decides; every request is recorded. */
async function node(
  t: { after: (fn: () => Promise<unknown>) => void },
  answer: (call: Call) => Answer,
) {
  const calls: Call[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const call = JSON.parse(raw) as Call;
      calls.push(call);
      const out = answer(call);
      response.setHeader('content-type', 'application/json');
      if ('status' in out) {
        response.statusCode = out.status;
        return response.end(JSON.stringify({ error: 'rate limited' }));
      }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...out }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    methods: () => calls.map((c) => c.method),
  };
}

const RATE_LIMITED: Answer = { status: 429 };

/** A healthy Base node: head, blocks, and aggregate3 answers for balances and ownerOf. */
function healthy(tag = 'a', chain = CHAIN_HEX) {
  return (call: Call): Answer => {
    switch (call.method) {
      case 'eth_chainId':
        return { result: chain };
      case 'eth_blockNumber':
        return { result: `0x${HEAD.toString(16)}` };
      case 'eth_getBlockByNumber': {
        const at = call.params[0] as string;
        const n = at.startsWith('0x') ? BigInt(at) : HEAD;
        return {
          result: {
            number: `0x${n.toString(16)}`,
            hash: blockHash(n, tag),
            parentHash: blockHash(n - 1n, tag),
            timestamp: '0x1',
            baseFeePerGas: '0x1',
            transactions: [],
          },
        };
      }
      case 'eth_call': {
        const [tx] = call.params as [{ to: string; data: Hex }];
        assert.equal(getAddress(tx.to), MULTICALL3);
        const { args } = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
        const inner = args[0] as ReadonlyArray<{ target: string; callData: Hex }>;
        return {
          result: encodeFunctionResult({
            abi: multicall3Abi,
            functionName: 'aggregate3',
            result: inner.map((item) => {
              if (getAddress(item.target) === NETWORK.contracts.identityRegistry)
                return {
                  success: true,
                  returnData: encodeFunctionResult({
                    abi: identityRegistryAbi,
                    functionName: 'ownerOf',
                    result: OWNER,
                  }),
                };
              // Balances: USDC and ETH one word each; the code probe empty (not deployed).
              if (getAddress(item.target) === WALLET)
                return { success: true, returnData: '0x' as Hex };
              return { success: true, returnData: `0x${'0'.repeat(63)}7` as Hex };
            }),
          }),
        };
      }
      case 'eth_gasPrice':
        return { result: '0x3b9aca00' };
      case 'eth_maxPriorityFeePerGas':
        return { result: '0x5f5e100' };
      default:
        return { error: { code: -32601, message: 'method not found' } };
    }
  };
}

test('one setting names the second read endpoint; hosted defaults to the public RPC', () => {
  const env = { [READ_FALLBACK_SETTING]: 'https://second.example.test' };
  assert.deepEqual(baseReadUrls('https://cdp.example.test', env, BASE_MAINNET), [
    'https://cdp.example.test',
    'https://second.example.test',
  ]);
  assert.deepEqual(baseReadUrls('https://cdp.example.test', {}, BASE_MAINNET, { hosted: true }), [
    'https://cdp.example.test',
    PUBLIC_BASE_RPC,
  ]);
  assert.deepEqual(baseReadUrls('https://cdp.example.test', {}, BASE_SEPOLIA, { hosted: true }), [
    'https://cdp.example.test',
    'https://sepolia.base.org',
  ]);
  // Locally (not hosted) without the setting: the configured endpoint alone.
  assert.deepEqual(baseReadUrls('https://cdp.example.test', {}, BASE_MAINNET), [
    'https://cdp.example.test',
  ]);
  // Never the same URL twice; nothing without a configured endpoint.
  assert.deepEqual(baseReadUrls(PUBLIC_BASE_RPC, {}, BASE_MAINNET, { hosted: true }), [
    PUBLIC_BASE_RPC,
  ]);
  assert.deepEqual(baseReadUrls(undefined, env, BASE_MAINNET, { hosted: true }), []);
});

test('(a) a wallet balance is read from the second endpoint while the first answers 429', async (t) => {
  const first = await node(t, () => RATE_LIMITED);
  const second = await node(t, healthy());
  const reader = baseBalanceReader([first.url, second.url], NETWORK);
  const read = await reader.balances(WALLET);
  assert.equal(read.usdc, 7n);
  assert.equal(read.eth, 7n);
  assert.equal(read.deployed, false);
  assert.equal(read.blockNumber, HEAD);
  assert.ok(first.methods().includes('eth_call'), 'the first endpoint is always asked first');
  // (d) The call stays pinned to the head number it read, on the second endpoint too.
  const call = second.calls.find((c) => c.method === 'eth_call')!;
  assert.equal(call.params[1], `0x${HEAD.toString(16)}`);
});

test('(a) a rating lookup (ownerOf at one block) is read from the second endpoint on 429', async (t) => {
  const first = await node(t, () => RATE_LIMITED);
  const second = await node(t, healthy('b'));
  const reader = payChainReader([first.url, second.url], NETWORK, 3_000, async () => {});
  const read = await reader.ownersOf!(['501', '502']);
  assert.deepEqual(read, { block: HEAD, blockHash: blockHash(HEAD, 'b'), owners: [OWNER, OWNER] });
  // (d) Pinned to the hash of the block it read, canonical only.
  const call = second.calls.find((c) => c.method === 'eth_call')!;
  assert.deepEqual(call.params[1], { blockHash: blockHash(HEAD, 'b'), requireCanonical: true });
});

test('(d) a head from the first endpoint pins the call that the second endpoint answers', async (t) => {
  // The first endpoint serves the head but is rate limited on the call itself.
  const firstHealthy = healthy('c');
  const first = await node(t, (call) =>
    call.method === 'eth_call' ? RATE_LIMITED : firstHealthy(call),
  );
  const second = await node(t, healthy('c'));
  const reader = payChainReader([first.url, second.url], NETWORK, 3_000, async () => {});
  const read = await reader.ownerOf('501');
  assert.equal(read.blockHash, blockHash(HEAD, 'c'));
  assert.deepEqual(
    second.methods().filter((m) => m !== 'eth_chainId'),
    ['eth_call'],
  );
  const call = second.calls.find((c) => c.method === 'eth_call')!;
  assert.deepEqual(call.params[1], { blockHash: blockHash(HEAD, 'c'), requireCanonical: true });
});

test('(d) a node that does not hold the pinned block fails the read; it never answers another', async (t) => {
  const firstHealthy = healthy('d');
  const first = await node(t, (call) =>
    call.method === 'eth_call' ? RATE_LIMITED : firstHealthy(call),
  );
  // The second node is on another view: its call at our hash fails (EIP-1898 requireCanonical).
  const second = await node(t, (call) =>
    call.method === 'eth_call'
      ? { error: { code: -32000, message: 'header not found' } }
      : healthy('e')(call),
  );
  const reader = payChainReader([first.url, second.url], NETWORK, 3_000, async () => {});
  await assert.rejects(reader.ownerOf('501'));
});

test('(c) a revert on the first endpoint is never asked of the second', async (t) => {
  const firstHealthy = healthy();
  const first = await node(t, (call) =>
    call.method === 'eth_call'
      ? { error: { code: 3, message: 'execution reverted' } }
      : firstHealthy(call),
  );
  const second = await node(t, healthy());
  await assert.rejects(baseBalanceReader([first.url, second.url], NETWORK).balances(WALLET));
  assert.ok(!second.methods().includes('eth_call'));
  // The same for a pinned ownerOf read (all of its attempts on the first endpoint).
  await assert.rejects(
    payChainReader([first.url, second.url], NETWORK, 3_000, async () => {}).ownerOf('501'),
  );
  assert.ok(!second.methods().includes('eth_call'));
  // And a revert inside -32000 ("execution reverted: ..."), as some nodes answer it.
  const other = await node(t, (call) =>
    call.method === 'eth_call'
      ? { error: { code: -32000, message: 'execution reverted: ERC721NonexistentToken' } }
      : firstHealthy(call),
  );
  const spare = await node(t, healthy());
  await assert.rejects(baseBalanceReader([other.url, spare.url], NETWORK).balances(WALLET));
  assert.ok(!spare.methods().includes('eth_call'));
});

test('(b) the bundler and the paymaster use the first endpoint only, never the second', async (t) => {
  const firstHealthy = healthy();
  const first = await node(t, (call) => {
    if (call.method.startsWith('pm_') || call.method.includes('UserOperation')) return RATE_LIMITED;
    if (call.method === 'eth_maxPriorityFeePerGas') return { result: '0x1' };
    return firstHealthy(call);
  });
  const second = await node(t, healthy());
  const client = createPublicClient({
    transport: baseReadTransport([first.url, second.url], {
      chainId: NETWORK.chainId,
      retry: { retryCount: 0 },
    }),
  });
  const bundler = rpcBundler({
    url: first.url,
    entryPoint: NETWORK.contracts.entryPointV06,
    chainId: NETWORK.chainId,
    client: client as never,
    maxFeePerGasCap: 10n ** 12n,
    stubSignature: `0x${'ff'.repeat(65)}`,
  });
  const op = {
    sender: WALLET,
    nonce: 0n,
    initCode: '0x' as Hex,
    callData: '0x' as Hex,
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    paymasterAndData: '0x' as Hex,
    signature: '0x' as Hex,
  };
  await assert.rejects(bundler.prepare(op));
  await assert.rejects(bundler.prepare(op, { sponsor: false }));
  await assert.rejects(bundler.send(op));
  await assert.rejects(bundler.receipt(blockHash(1n)));
  assert.ok(first.methods().includes('pm_getPaymasterStubData'));
  assert.ok(first.methods().includes('eth_estimateUserOperationGas'));
  assert.ok(first.methods().includes('eth_sendUserOperation'));
  assert.ok(first.methods().includes('eth_getUserOperationReceipt'));
  const asked = second.methods();
  assert.ok(
    !asked.some((m) => m.startsWith('pm_') || m.includes('UserOperation')),
    `the second endpoint saw ${asked.join(', ')}`,
  );
});

test('(b) writes, estimates and unpinned reads never reach the second endpoint', async (t) => {
  const first = await node(t, () => RATE_LIMITED);
  const second = await node(t, healthy());
  const transport = baseReadTransport([first.url, second.url], {
    chainId: NETWORK.chainId,
    retry: { retryCount: 0 },
  })({});
  const never = [
    { method: 'eth_sendUserOperation', params: [{}, NETWORK.contracts.entryPointV06] },
    { method: 'eth_estimateUserOperationGas', params: [{}, NETWORK.contracts.entryPointV06] },
    { method: 'eth_getUserOperationReceipt', params: [blockHash(1n)] },
    { method: 'eth_getUserOperationByHash', params: [blockHash(1n)] },
    {
      method: 'pm_getPaymasterStubData',
      params: [{}, NETWORK.contracts.entryPointV06, '0x2105', {}],
    },
    { method: 'pm_getPaymasterData', params: [{}, NETWORK.contracts.entryPointV06, '0x2105', {}] },
    { method: 'eth_sendRawTransaction', params: ['0x00'] },
    { method: 'eth_estimateGas', params: [{ to: WALLET }] },
    // Unpinned state: a nonce or code that feeds an operation is the configured node's.
    { method: 'eth_call', params: [{ to: WALLET, data: '0x' }, 'latest'] },
    { method: 'eth_call', params: [{ to: WALLET, data: '0x' }, 'pending'] },
    { method: 'eth_getCode', params: [WALLET, 'latest'] },
    { method: 'eth_getTransactionCount', params: [WALLET, 'latest'] },
    // A state override stays home too, even pinned.
    { method: 'eth_call', params: [{ to: WALLET, data: '0x' }, '0x1', {}] },
    // The bare head number, unless the caller opted in.
    { method: 'eth_blockNumber', params: [] },
    // Open-ended log ranges.
    { method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: 'latest' }] },
  ];
  for (const request of never) {
    assert.equal(
      mayFallBack(request),
      false,
      `${request.method} ${JSON.stringify(request.params)}`,
    );
    await assert.rejects(transport.request(request as never), request.method);
  }
  assert.deepEqual(second.calls, []);
  // The ones that may: pinned reads, blocks, receipts, closed log ranges, the chain id, fee quotes.
  for (const request of [
    { method: 'eth_chainId' },
    { method: 'eth_gasPrice', params: [] },
    { method: 'eth_maxPriorityFeePerGas', params: [] },
    { method: 'eth_getBlockByNumber', params: ['finalized', false] },
    { method: 'eth_getBlockByHash', params: [blockHash(1n), false] },
    { method: 'eth_call', params: [{ to: WALLET, data: '0x' }, '0x10'] },
    { method: 'eth_call', params: [{ to: WALLET, data: '0x' }, { blockHash: blockHash(1n) }] },
    { method: 'eth_getTransactionReceipt', params: [blockHash(1n)] },
    { method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x9' }] },
  ])
    assert.equal(mayFallBack(request), true, request.method);
  assert.equal(mayFallBack({ method: 'eth_blockNumber' }, { headNumberMayFallBack: true }), true);
});

test('(a) fee quotes refused by the rate limit (-32002) are answered by the second endpoint', async (t) => {
  // The rate limit as CDP answers it: a JSON-RPC error, not an HTTP 429.
  const first = await node(t, () => ({ error: { code: -32002, message: 'rate limited' } }));
  const second = await node(t, healthy());
  const transport = baseReadTransport([first.url, second.url], {
    chainId: NETWORK.chainId,
    retry: { retryCount: 0 },
  })({});
  assert.equal(await transport.request({ method: 'eth_gasPrice' } as never), '0x3b9aca00');
  assert.equal(
    await transport.request({ method: 'eth_maxPriorityFeePerGas' } as never),
    '0x5f5e100',
  );
  assert.ok(second.calls.some((call) => call.method === 'eth_gasPrice'));
});

test('the second endpoint proves presence, never absence', async (t) => {
  const first = await node(t, () => RATE_LIMITED);
  let receipt: unknown = null;
  let logs: unknown[] = [];
  const second = await node(t, (call) => {
    if (call.method === 'eth_chainId') return { result: CHAIN_HEX };
    if (call.method === 'eth_getTransactionReceipt') return { result: receipt };
    if (call.method === 'eth_getLogs') return { result: logs };
    if (call.method === 'eth_getBlockByNumber') return { result: null };
    return { error: { code: -32601, message: 'no' } };
  });
  const transport = baseReadTransport([first.url, second.url], { chainId: NETWORK.chainId })({});
  const ask = (method: string, params: unknown[]) => transport.request({ method, params } as never);
  // Null receipt, empty log page, missing block: the first endpoint's failure stands.
  await assert.rejects(ask('eth_getTransactionReceipt', [blockHash(1n)]));
  await assert.rejects(ask('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x9' }]));
  await assert.rejects(ask('eth_getBlockByNumber', ['0x9', false]));
  // A receipt or a log that exists is an answer.
  receipt = { transactionHash: blockHash(1n), blockNumber: '0x9' };
  logs = [{ blockNumber: '0x9' }];
  assert.deepEqual(await ask('eth_getTransactionReceipt', [blockHash(1n)]), receipt);
  assert.deepEqual(await ask('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x9' }]), logs);
});

test('a second endpoint for another network is never used', async (t) => {
  const first = await node(t, () => RATE_LIMITED);
  const sepolia = await node(t, healthy('a', '0x14a34'));
  await assert.rejects(baseBalanceReader([first.url, sepolia.url], NETWORK).balances(WALLET));
  await assert.rejects(baseBalanceReader([first.url, sepolia.url], NETWORK).balances(WALLET));
  assert.deepEqual([...new Set(sepolia.methods())], ['eth_chainId']);
});

test('with one endpoint, the configured retry applies as before; with two, a read moves on at once', async (t) => {
  const first = await node(t, () => RATE_LIMITED);
  const alone = createPublicClient({
    transport: baseReadTransport(first.url, {
      chainId: NETWORK.chainId,
      retry: { ...CDP_RETRY, retryDelay: 1 },
    }),
  });
  await assert.rejects(alone.getBlockNumber({ cacheTime: 0 }));
  assert.equal(first.calls.length, 2, 'one retry, as the CDP transport');
  first.calls.length = 0;
  const second = await node(t, healthy());
  const both = createPublicClient({
    transport: baseReadTransport([first.url, second.url], {
      chainId: NETWORK.chainId,
      retry: { ...CDP_RETRY, retryDelay: 1 },
    }),
  });
  const block = await both.getBlock({ blockTag: 'safe' });
  assert.equal(block.number, HEAD);
  assert.equal(first.calls.length, 1, 'no retry on the first endpoint before the second answers');
});

test('(a)(d) the runtime reads a passport at the finalized block from the second endpoint', async (t) => {
  const { createChainRuntime } = await import('../server/base/chain/runtime.js');
  const { randomBytes } = await import('node:crypto');
  const FINAL = 0x4f0n;
  const first = await node(t, () => RATE_LIMITED);
  const second = await node(t, (call) => {
    if (call.method === 'eth_chainId') return { result: CHAIN_HEX };
    if (call.method === 'eth_getBlockByNumber') {
      assert.ok(call.params[0] === 'finalized' || call.params[0] === `0x${FINAL.toString(16)}`);
      return healthy('f')({ ...call, params: [`0x${FINAL.toString(16)}`, false] });
    }
    if (call.method === 'eth_call') {
      // Pinned to the finalized block's number, as the port asked the first endpoint.
      assert.equal(call.params[1], `0x${FINAL.toString(16)}`);
      const { functionName } = decodeFunctionData({
        abi: identityRegistryAbi,
        data: (call.params[0] as { data: Hex }).data,
      });
      return {
        result:
          functionName === 'ownerOf'
            ? encodeFunctionResult({ abi: identityRegistryAbi, functionName, result: OWNER })
            : encodeFunctionResult({
                abi: identityRegistryAbi,
                functionName: 'tokenURI',
                result: 'https://centralcity.ai/a/abc123',
              }),
      };
    }
    return { error: { code: -32601, message: 'no' } };
  });
  const runtime = createChainRuntime({
    db: { query: async () => ({ rows: [] }) } as never,
    env: {
      CITY_BASE_MAINNET: '1',
      CITY_BASE_CDP_RPC_URL: first.url,
      [READ_FALLBACK_SETTING]: second.url,
      CITY_BASE_SPENDER_KEK: `v1:${randomBytes(32).toString('base64')}`,
      CITY_BASE_MAX_FEE_PER_GAS_WEI: '1000000000',
      CITY_BASE_IDENTITY_FEE_CAP_WEI: '50000000000000',
      CITY_BASE_WALLET_FEE_CAP_WEI: '20000000000000',
    },
    chainId: BASE_MAINNET,
  });
  const snapshot = await runtime.identityPort.identityAt!({
    chainId: BASE_MAINNET,
    id: 501n,
    blockTag: 'finalized',
  });
  assert.deepEqual(snapshot, {
    owner: OWNER,
    tokenUri: 'https://centralcity.ai/a/abc123',
    blockNumber: FINAL.toString(10),
    blockHash: blockHash(FINAL, 'f'),
  });
  // Every read was asked of the CDP endpoint first.
  assert.ok(first.methods().includes('eth_getBlockByNumber'));
  assert.ok(first.methods().includes('eth_call'));
});
