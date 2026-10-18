import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPublicClient } from 'viem';
import {
  CDP_RETRY,
  LATEST_TTL_MS,
  SETTLED_TTL_MS,
  blockTagCache,
  cachedHeadRequests,
  cdpTransport,
  liveReads,
  withLiveReads,
} from '../server/base/chain/rpc-budget.js';

type Args = { method: string; params?: unknown };

/** A fake node: counts calls per method+params; answers are resolved by hand when `manual`. */
function fakeNode(options: { manual?: boolean } = {}) {
  const calls: string[] = [];
  const pending: { resolve(v: unknown): void; reject(e: unknown): void }[] = [];
  let answer = 0;
  const request = async (args: Args) => {
    calls.push(`${args.method} ${JSON.stringify(args.params ?? [])}`);
    if (options.manual) return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    return { n: ++answer };
  };
  return { request, calls, pending };
}

const clock = () => {
  const c = { at: 1_000_000, now: () => c.at };
  return c;
};

const latest = { method: 'eth_getBlockByNumber', params: ['latest', false] };
const safe = { method: 'eth_getBlockByNumber', params: ['safe', false] };
const finalized = { method: 'eth_getBlockByNumber', params: ['finalized', false] };
const blockNumber = { method: 'eth_blockNumber' };

test('a head read is shared for its TTL, then asked again', async () => {
  const node = fakeNode();
  const c = clock();
  const request = cachedHeadRequests(node.request, { now: c.now });
  const first = await request(latest);
  c.at += LATEST_TTL_MS - 1;
  assert.equal(await request(latest), first);
  assert.equal(node.calls.length, 1);
  c.at += 1;
  assert.notEqual(await request(latest), first);
  assert.equal(node.calls.length, 2);

  const settled = await request(finalized);
  c.at += SETTLED_TTL_MS - 1;
  assert.equal(await request(finalized), settled);
  c.at += 1;
  assert.notEqual(await request(finalized), settled);
  assert.equal(node.calls.length, 4);
});

test('eth_blockNumber lives as long as latest; safe and finalized twice as long', async () => {
  const node = fakeNode();
  const c = clock();
  const request = cachedHeadRequests(node.request, { now: c.now });
  await request(blockNumber);
  await request(safe);
  c.at += LATEST_TTL_MS;
  await request(blockNumber);
  await request(safe);
  assert.deepEqual(
    node.calls.map((call) => call.split(' ')[0]),
    ['eth_blockNumber', 'eth_getBlockByNumber', 'eth_blockNumber'],
  );
});

test('the age of a shared head counts from the request start, latency included', async () => {
  const node = fakeNode({ manual: true });
  const c = clock();
  const request = cachedHeadRequests(node.request, { now: c.now });
  const first = request(latest);
  // The node takes 900 ms to answer: the answer is already up to 900 ms old when it arrives.
  c.at += 900;
  node.pending[0].resolve({ number: '0x10' });
  assert.deepEqual(await first, { number: '0x10' });
  c.at += LATEST_TTL_MS - 900 - 1;
  assert.deepEqual(await request(latest), { number: '0x10' }, 'still within 1 s of the start');
  assert.equal(node.calls.length, 1);
  c.at += 1;
  const again = request(latest);
  assert.equal(node.calls.length, 2, 'a full TTL after the START, asked again');
  node.pending[1].resolve({ number: '0x11' });
  assert.deepEqual(await again, { number: '0x11' });
});

test('a request still in flight past its TTL is not joined; a fresh one is sent', async () => {
  const node = fakeNode({ manual: true });
  const c = clock();
  const request = cachedHeadRequests(node.request, { now: c.now });
  const slow = request(finalized);
  c.at += SETTLED_TTL_MS;
  const fresh = request(finalized);
  assert.equal(node.calls.length, 2);
  node.pending[1].resolve({ number: '0x30' });
  node.pending[0].resolve({ number: '0x2f' });
  assert.deepEqual(await fresh, { number: '0x30' });
  assert.deepEqual(await slow, { number: '0x2f' });
  // The slow answer, arriving last, never replaces the newer entry.
  assert.deepEqual(await request(finalized), { number: '0x30' });
  assert.equal(node.calls.length, 2);
});

test('concurrent callers share one request in flight', async () => {
  const node = fakeNode({ manual: true });
  const request = cachedHeadRequests(node.request, { now: clock().now });
  const all = Promise.all([request(safe), request(safe), request(safe)]);
  await Promise.resolve();
  assert.equal(node.calls.length, 1);
  node.pending[0].resolve({ number: '0x10' });
  assert.deepEqual(await all, [{ number: '0x10' }, { number: '0x10' }, { number: '0x10' }]);
});

test('every tag, and the full-transactions flag, is cached on its own', async () => {
  const node = fakeNode();
  const request = cachedHeadRequests(node.request, { now: clock().now });
  for (const args of [
    latest,
    safe,
    finalized,
    blockNumber,
    { method: 'eth_getBlockByNumber', params: ['latest', true] },
  ])
    await request(args);
  assert.equal(node.calls.length, 5);
  await request(latest);
  await request(safe);
  await request(finalized);
  await request(blockNumber);
  assert.equal(node.calls.length, 5);
});

test('an error is never kept: every waiter sees it, the next caller asks again', async () => {
  const node = fakeNode({ manual: true });
  const request = cachedHeadRequests(node.request, { now: clock().now });
  const a = request(finalized);
  const b = request(finalized);
  node.pending[0].reject(new Error('429'));
  await assert.rejects(a, /429/);
  await assert.rejects(b, /429/);
  const c = request(finalized);
  assert.equal(node.calls.length, 2);
  node.pending[1].resolve({ number: '0x20' });
  assert.deepEqual(await c, { number: '0x20' });
});

test('blocks by number or hash, pending, and other methods always go to the node', async () => {
  const node = fakeNode();
  const request = cachedHeadRequests(node.request, { now: clock().now });
  const reads: Args[] = [
    { method: 'eth_getBlockByNumber', params: ['0x10', false] },
    { method: 'eth_getBlockByNumber', params: ['pending', false] },
    { method: 'eth_getBlockByNumber', params: ['earliest', false] },
    { method: 'eth_getBlockByHash', params: ['0xab', false] },
    { method: 'eth_call', params: [{ to: '0x1' }, 'latest'] },
    { method: 'eth_getTransactionReceipt', params: ['0xcd'] },
  ];
  for (const args of reads) {
    await request(args);
    await request(args);
  }
  assert.equal(node.calls.length, reads.length * 2);
});

test('a viem client on the cached transport shares getBlock, getBlockNumber and fee reads', async () => {
  let blockCalls = 0;
  let numberCalls = 0;
  const block = {
    number: '0x10',
    hash: `0x${'11'.repeat(32)}`,
    baseFeePerGas: '0x1',
    timestamp: '0x1',
    transactions: [],
  };
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { id: number; method: string };
    if (body.method === 'eth_getBlockByNumber') blockCalls++;
    if (body.method === 'eth_blockNumber') numberCalls++;
    const result =
      body.method === 'eth_blockNumber'
        ? '0x10'
        : body.method === 'eth_maxPriorityFeePerGas'
          ? '0x1'
          : block;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const url = 'https://node.example.test/rpc';
  const client = createPublicClient({
    chain: {
      id: 8453,
      name: 'Base',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [url] } },
    },
    transport: blockTagCache(cdpTransport(url, { fetchFn })),
  });
  // The prepare path: fee estimate and the latest block concurrently, twice.
  await Promise.all([client.estimateFeesPerGas(), client.getBlock()]);
  await Promise.all([client.estimateFeesPerGas(), client.getBlock()]);
  assert.equal(blockCalls, 1);
  await client.getBlock({ blockTag: 'safe' });
  await client.getBlock({ blockTag: 'safe' });
  assert.equal(blockCalls, 2);
  await client.getBlockNumber({ cacheTime: 0 });
  await client.getBlockNumber({ cacheTime: 0 });
  assert.equal(numberCalls, 1);
  await client.getBlock({ blockNumber: 16n });
  await client.getBlock({ blockNumber: 16n });
  assert.equal(blockCalls, 4);
});

test('the CDP transport retries once, after Retry-After, never three times', async () => {
  assert.deepEqual(CDP_RETRY, { retryCount: 1, retryDelay: 1000 });
  let attempts = 0;
  const fetchFn = (async () => {
    attempts++;
    return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } });
  }) as unknown as typeof fetch;
  const secret = `https://api.example.test/rpc/v1/base/${randomBytes(12).toString('hex')}`;
  const client = createPublicClient({ transport: cdpTransport(secret, { fetchFn }) });
  await assert.rejects(client.getBlockNumber({ cacheTime: 0 }));
  assert.equal(attempts, 2);
});

test('the runtime and the revoke port read through the read transport with the CDP retry', () => {
  for (const file of ['server/base/chain/runtime.ts', 'server/base/chain/owner-revoke.ts']) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\bhttp\(url/, file);
    assert.match(source, /baseReadTransport\(/, file);
    assert.match(source, /retry: CDP_RETRY/, file);
  }
  assert.match(
    readFileSync('server/base/chain/runtime.ts', 'utf8'),
    /blockTagCache\(transport\(\)\)/,
  );
});

test('liveReads returns the attached uncached twin, or the client itself', () => {
  const live = { name: 'live' };
  const cached = withLiveReads({ name: 'cached' }, live);
  assert.equal(liveReads(cached), live);
  assert.equal(liveReads({ ...cached }), live);
  const plain = { name: 'plain' };
  assert.equal(liveReads(plain), plain);
});
