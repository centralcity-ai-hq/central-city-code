import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, http, HttpRequestError, RpcRequestError } from 'viem';
import { BundlerError } from '../server/base/chain/rpc-bundler.js';
import {
  countingFetch,
  countRpc,
  resetRpcCounts,
  RPC_COUNT_WINDOW_MS,
  rpcOutcome,
} from '../server/base/chain/rpc-count.js';

const URL_WITH_KEY = 'https://api.developer.coinbase.com/rpc/v1/base/not-a-real-credential';

test('rpcOutcome: an HTTP 429, a JSON-RPC rate-limit answer, a busy bundler, anything else', () => {
  const http429 = new HttpRequestError({
    url: URL_WITH_KEY,
    status: 429,
    details: 'Too Many Requests',
  });
  assert.equal(rpcOutcome(http429), 'http429');
  assert.equal(rpcOutcome(new Error('wrapped', { cause: http429 })), 'http429');
  const limited = new RpcRequestError({
    url: URL_WITH_KEY,
    body: {},
    error: { code: -32005, message: 'limit exceeded' },
  });
  assert.equal(rpcOutcome(limited), 'busy');
  assert.equal(rpcOutcome(new BundlerError('RPC_ERROR', 'x', 'busy', -32005)), 'busy');
  // A paymaster policy refusal is a real answer, never "busy".
  const policy = new RpcRequestError({
    url: URL_WITH_KEY,
    body: {},
    error: { code: -32005, message: 'max spend limit exceeded for policy' },
  });
  assert.equal(rpcOutcome(policy), 'failed');
  assert.equal(rpcOutcome(new Error('execution reverted')), 'failed');
});

test('one line a minute, counts only, never the URL', () => {
  const lines: string[] = [];
  resetRpcCounts((line) => lines.push(line));
  const t0 = 1_000_000;
  countRpc('read:configured', 'ok', t0);
  countRpc('read:configured', 'http429', t0 + 1);
  countRpc('bundler:configured', 'busy', t0 + 2);
  countRpc('read:second', 'failed', t0 + 3);
  assert.equal(lines.length, 0, 'nothing before the minute is over');
  countRpc('read:configured', 'ok', t0 + RPC_COUNT_WINDOW_MS);
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]!) as { event: string; windowSeconds: number; counts: unknown };
  assert.equal(line.event, 'base.rpc.count');
  assert.equal(line.windowSeconds, 60);
  assert.deepEqual(line.counts, {
    'bundler:configured': { requests: 1, http429: 0, busy: 1, failed: 0 },
    'read:configured': { requests: 2, http429: 1, busy: 0, failed: 0 },
    'read:second': { requests: 1, http429: 0, busy: 0, failed: 1 },
  });
  // The request that closed the window opens the next one.
  countRpc('read:configured', 'ok', t0 + 2 * RPC_COUNT_WINDOW_MS);
  assert.deepEqual(JSON.parse(lines[1]!).counts, {
    'read:configured': { requests: 1, http429: 0, busy: 0, failed: 0 },
  });
  assert.ok(!lines.join('\n').includes('coinbase'));
  resetRpcCounts();
});

test('countingFetch counts every HTTP attempt (retries too) and changes no answer', async () => {
  const lines: string[] = [];
  resetRpcCounts((line) => lines.push(line));
  const answers = [
    new Response('rate limited', { status: 429 }),
    new Response('{"jsonrpc":"2.0","id":1,"result":"0x10"}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '39' },
    }),
  ];
  // Then a rate-limit answer inside an HTTP 200, every time it is asked.
  const busy = () =>
    new Response(
      '{"jsonrpc":"2.0","id":2,"error":{"code":-32005,"message":"rate limit exceeded"}}',
      {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '81' },
      },
    );
  const seen: string[] = [];
  const fetchFn = countingFetch('fees:configured', async (input) => {
    seen.push(String(input));
    return answers.shift() ?? busy();
  });
  const client = createPublicClient({
    transport: http(URL_WITH_KEY, { fetchFn, retryCount: 1, retryDelay: 1 }),
  });
  assert.equal(await client.getBlockNumber({ cacheTime: 0 }), 16n, 'the retry after a 429 answers');
  await assert.rejects(client.getChainId());
  assert.equal(seen.length, 4, 'viem asks a rate-limit answer once more (retryCount 1)');
  countRpc('flush', 'ok', Date.now() + RPC_COUNT_WINDOW_MS + 1_000);
  const counts = JSON.parse(lines.at(-1)!).counts as Record<string, unknown>;
  assert.deepEqual(counts['fees:configured'], { requests: 4, http429: 1, busy: 2, failed: 0 });
  assert.ok(!lines.join('\n').includes('not-a-real-credential'));
  resetRpcCounts();
});
