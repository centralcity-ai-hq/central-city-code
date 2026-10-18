import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { numberToHex, type Hex } from 'viem';
import type { Database } from '../server/database.js';
import { BASE_MAINNET, baseNetwork } from '../shared/base/chains.js';
import {
  ChainRuntimeError,
  FEED_PAY_BUNDLER_COUNT_KEY,
  FEED_PAY_CDP_SETTING,
  createChainRuntime,
  feedPayCdpUrl,
  feedPayEndpoint,
} from '../server/base/chain/runtime.js';
import { countRpc, resetRpcCounts } from '../server/base/chain/rpc-count.js';

/*
 * Feed pay's own CDP endpoint (CITY_FEED_PAY_CDP_RPC_URL): set, the Feed pay port's reads and
 * bundler and Feed pay's screening reads go to it while identity and wallet operations keep the
 * shared endpoint; unset, nothing changes; not https, only Feed pay is refused. Placeholder hosts
 * only, behind a stubbed fetch: nothing leaves the process.
 */

const db = { query: async () => ({ rows: [] }) } as unknown as Database;
const SHARED_URL = 'https://shared-cdp.example.test/rpc';
const FEED_PAY_URL = 'https://feed-pay.example.test/rpc';
const ADDRESS = `0x${'1'.repeat(40)}` as const;
const baseEnv: Record<string, string | undefined> = {
  CITY_BASE_MAINNET: '1',
  CITY_BASE_CDP_RPC_URL: SHARED_URL,
  CITY_BASE_SPENDER_KEK: `v1:${randomBytes(32).toString('base64')}`,
  CITY_BASE_MAX_FEE_PER_GAS_WEI: '1000000000',
  CITY_BASE_IDENTITY_FEE_CAP_WEI: '50000000000000',
  CITY_BASE_WALLET_FEE_CAP_WEI: '20000000000000',
};

interface Hit {
  host: string;
  method: string;
}

/** A fake Base node behind `fetch` at every host: records each JSON-RPC call by host. */
function stubNode(t: TestContext): Hit[] {
  const hits: Hit[] = [];
  const block = {
    number: '0x64',
    hash: `0x${'ab'.repeat(32)}`,
    parentHash: `0x${'cd'.repeat(32)}`,
    timestamp: numberToHex(Math.floor(Date.now() / 1000)),
    baseFeePerGas: '0x1',
    gasLimit: '0x1',
    gasUsed: '0x0',
    transactions: [],
    logsBloom: `0x${'0'.repeat(512)}`,
    miner: `0x${'0'.repeat(40)}`,
    difficulty: '0x0',
    extraData: '0x',
    nonce: '0x0000000000000000',
    sha3Uncles: `0x${'0'.repeat(64)}`,
    stateRoot: `0x${'0'.repeat(64)}`,
    receiptsRoot: `0x${'0'.repeat(64)}`,
    transactionsRoot: `0x${'0'.repeat(64)}`,
    size: '0x1',
    uncles: [],
    mixHash: `0x${'0'.repeat(64)}`,
  };
  const answers: Record<string, unknown> = {
    eth_chainId: numberToHex(BASE_MAINNET),
    eth_blockNumber: '0x64',
    eth_getBlockByNumber: block,
    eth_getCode: '0x',
    eth_getUserOperationReceipt: null,
  };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = new URL(String(input instanceof Request ? input.url : input)).host;
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    hits.push({ host, method: body.method });
    const result =
      body.method in answers
        ? { jsonrpc: '2.0', id: body.id, result: answers[body.method] }
        : { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'not here' } };
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return hits;
}

const hostsOf = (hits: Hit[]) => new Set(hits.map((h) => h.host));
const FEED_HOST = new URL(FEED_PAY_URL).host;
const SHARED_HOST = new URL(SHARED_URL).host;

const runtimeWith = (env: Record<string, string | undefined>) =>
  createChainRuntime({ db, env, chainId: BASE_MAINNET, walletChainId: BASE_MAINNET });

test('the setting: unset, an https URL, or refused (never echoing the value)', () => {
  assert.deepEqual(feedPayCdpUrl({}), { url: undefined });
  assert.deepEqual(feedPayCdpUrl({ [FEED_PAY_CDP_SETTING]: '  ' }), { url: undefined });
  assert.deepEqual(feedPayCdpUrl({ [FEED_PAY_CDP_SETTING]: ` ${FEED_PAY_URL} ` }), {
    url: FEED_PAY_URL,
  });
  for (const bad of [
    'http://feed-pay.example.test/rpc',
    'ftp://feed-pay.example.test',
    'wss://feed-pay.example.test',
    'feed-pay.example.test/rpc',
    'not a url',
  ])
    assert.equal(feedPayCdpUrl({ [FEED_PAY_CDP_SETTING]: bad }), null, bad);
});

test('set: the Feed pay port and its screening reads use it; identity and wallet keep the shared one', async (t) => {
  const hits = stubNode(t);
  const runtime = runtimeWith({ ...baseEnv, [FEED_PAY_CDP_SETTING]: FEED_PAY_URL });
  const feedPay = runtime.feedPay!();

  hits.length = 0;
  assert.equal(await feedPay.headBlock(), 100n);
  assert.equal(await feedPay.isDeployed(ADDRESS), false);
  await feedPay.usdcBalance(ADDRESS).catch(() => null);
  await runtime.feedPayReadClient!().getBlockNumber({ cacheTime: 0 });
  assert.deepEqual([...hostsOf(hits)], [FEED_HOST]);

  hits.length = 0;
  await runtime.identityPort.settledHeads!(BASE_MAINNET);
  assert.equal(await runtime.ownerOperations!.isContract(ADDRESS), false);
  await runtime.readClient!.getBlockNumber({ cacheTime: 0 });
  assert.ok(hits.length > 0);
  assert.deepEqual([...hostsOf(hits)], [SHARED_HOST]);
  assert.notEqual(runtime.feedPayReadClient!(), runtime.readClient);
});

test("set: Feed pay's bundler posts to its own endpoint, counted under its own key", async (t) => {
  const hits = stubNode(t);
  const lines: string[] = [];
  resetRpcCounts((line) => lines.push(line));
  const network = baseNetwork(BASE_MAINNET, baseEnv)!;
  const parts = feedPayEndpoint({
    url: FEED_PAY_URL,
    env: baseEnv,
    network,
    maxFeePerGasCap: 1_000_000_000n,
  });
  assert.equal(await parts.bundler.receipt(`0x${'ee'.repeat(32)}` as Hex), null);
  await parts.client.getBlockNumber({ cacheTime: 0 });
  assert.deepEqual(hits, [
    { host: FEED_HOST, method: 'eth_getUserOperationReceipt' },
    { host: FEED_HOST, method: 'eth_blockNumber' },
  ]);
  // The next window's first count writes the last one: Feed pay's own keys, never a URL.
  countRpc('flush', 'ok', Date.now() + 120_000);
  const line = lines.at(-1) ?? '';
  const counts = (JSON.parse(line) as { counts: Record<string, { requests: number }> }).counts;
  assert.equal(counts[FEED_PAY_BUNDLER_COUNT_KEY]?.requests, 1);
  assert.equal(counts['feedpay:configured']?.requests, 1);
  assert.equal(counts['bundler:configured'], undefined);
  assert.ok(!line.includes('example.test'));
  resetRpcCounts((l) => console.log(l));
});

test('unset: Feed pay reads the shared endpoint exactly as before', async (t) => {
  const hits = stubNode(t);
  const runtime = runtimeWith(baseEnv);
  const feedPay = runtime.feedPay!();
  hits.length = 0;
  assert.equal(await feedPay.headBlock(), 100n);
  assert.equal(await feedPay.isDeployed(ADDRESS), false);
  assert.deepEqual([...hostsOf(hits)], [SHARED_HOST]);
  assert.equal(runtime.feedPayReadClient!(), runtime.readClient);
});

test('not https: only Feed pay is refused, by the setting name alone', async (t) => {
  const hits = stubNode(t);
  const value = 'http://feed-pay.example.test/rpc';
  const runtime = runtimeWith({ ...baseEnv, [FEED_PAY_CDP_SETTING]: value });
  const refused = (e: unknown) =>
    e instanceof ChainRuntimeError &&
    e.setting === FEED_PAY_CDP_SETTING &&
    !e.message.includes(value) &&
    !e.message.includes('example.test');
  assert.throws(() => runtime.feedPay!(), refused);
  assert.throws(() => runtime.feedPayReadClient!(), refused);
  // Identity and wallet operations still run on the shared endpoint.
  hits.length = 0;
  await runtime.identityPort.settledHeads!(BASE_MAINNET);
  assert.equal(await runtime.ownerOperations!.isContract(ADDRESS), false);
  assert.deepEqual([...hostsOf(hits)], [SHARED_HOST]);
});
