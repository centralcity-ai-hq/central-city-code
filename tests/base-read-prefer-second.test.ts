import assert from 'node:assert/strict';
import test from 'node:test';
import {
  baseReadTransport,
  PREFERRED_SECOND_TIMEOUT_MS,
  SECOND_BACKOFF_MS,
  STALE_TAGGED_HEAD_MS,
  type ReadTransportOptions,
} from '../server/base/chain/read-transport.js';

/*
 * read-transport.ts `preferSecond` (the identity port's reads, fee quotes and head hints): the
 * second endpoint is asked FIRST for what it may answer, and only a presence it proves is taken
 * from it. An absence, a revert, a failure or another chain there is asked of the configured
 * endpoint, and everything it may not answer never reaches it. Synthetic endpoints behind `fetch`.
 */

const FIRST = 'https://first.test/rpc/test-token-0001';
const SECOND = 'https://second.test/rpc';
const BLOCK = {
  number: '0x10',
  hash: `0x${'ab'.repeat(32)}`,
  parentHash: `0x${'aa'.repeat(32)}`,
  timestamp: '0x1',
  transactions: [],
};

type Answer =
  | { result: unknown }
  | { error: { code: number; message: string } }
  | { status: number }
  | { hang: true };

function endpoints(
  t: { after: (fn: () => void) => void },
  answers: { first: (method: string) => Answer; second: (method: string) => Answer },
  options: Partial<ReadTransportOptions> = {},
) {
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
    const url = String(input);
    const which = url === FIRST ? 'first' : url === SECOND ? 'second' : null;
    if (!which) throw new Error('no other host');
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    asked.push(`${which} ${body.method}`);
    const out = answers[which](body.method);
    if ('hang' in out)
      // A node that never answers: only the caller's timeout ends the request.
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        ),
      );
    if ('status' in out) return new Response('{}', { status: out.status });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...out }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  const transport = baseReadTransport([FIRST, SECOND], {
    chainId: 8453,
    preferSecond: true,
    ...options,
  })({});
  const request = (method: string, params: unknown[] = []) =>
    transport.request({ method, params } as never);
  return { asked, request };
}

const chainId = (method: string): Answer | null =>
  method === 'eth_chainId' ? { result: '0x2105' } : null;

test('a presence the second endpoint proves is taken from it; the configured one is not asked', async (t) => {
  const { asked, request } = endpoints(t, {
    first: () => ({ result: 'first' }),
    second: (m) => chainId(m) ?? { result: m === 'eth_getBlockByNumber' ? BLOCK : '0xbeef' },
  });
  assert.deepEqual(await request('eth_getBlockByNumber', ['0x10', false]), BLOCK);
  assert.equal(
    await request('eth_call', [{ to: `0x${'1'.repeat(40)}`, data: '0x' }, '0x10']),
    '0xbeef',
  );
  assert.equal(await request('eth_maxPriorityFeePerGas'), '0xbeef');
  assert.deepEqual(asked, [
    'second eth_chainId',
    'second eth_getBlockByNumber',
    'second eth_call',
    'second eth_maxPriorityFeePerGas',
  ]);
});

test('absence, a revert or a failure there: the configured endpoint answers', async (t) => {
  for (const [name, second] of [
    ['null receipt', { result: null }],
    ['revert', { error: { code: 3, message: 'execution reverted' } }],
    ['rate limited', { status: 429 }],
  ] as Array<[string, Answer]>) {
    const { asked, request } = endpoints(t, {
      first: () => ({ result: 'from-first' }),
      second: (m) => chainId(m) ?? second,
    });
    assert.equal(
      await request('eth_getTransactionReceipt', [`0x${'cc'.repeat(32)}`]),
      'from-first',
      name,
    );
    assert.deepEqual(asked.at(-1), 'first eth_getTransactionReceipt', name);
  }
  // An empty log page is absence too.
  const { asked, request } = endpoints(t, {
    first: () => ({ result: ['log'] }),
    second: (m) => chainId(m) ?? { result: [] },
  });
  assert.deepEqual(await request('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2' }]), ['log']);
  assert.deepEqual(asked, ['second eth_chainId', 'second eth_getLogs', 'first eth_getLogs']);
});

test('what the second endpoint may not answer never reaches it', async (t) => {
  const { asked, request } = endpoints(t, {
    first: () => ({ result: '0x1' }),
    second: () => ({ result: '0x2' }),
  });
  await request('eth_call', [{ to: `0x${'1'.repeat(40)}`, data: '0x' }, 'latest']);
  await request('eth_getCode', [`0x${'1'.repeat(40)}`, 'latest']);
  await request('eth_getTransactionCount', [`0x${'1'.repeat(40)}`, 'pending']);
  await request('eth_blockNumber');
  await request('eth_estimateGas', [{}]);
  assert.ok(
    asked.every((call) => call.startsWith('first ')),
    asked.join(', '),
  );
});

test('a second endpoint on another chain is never used', async (t) => {
  const { asked, request } = endpoints(t, {
    first: () => ({ result: BLOCK }),
    second: (m) =>
      m === 'eth_chainId' ? { result: '0x1' } : { result: { ...BLOCK, hash: '0x00' } },
  });
  assert.deepEqual(await request('eth_getBlockByNumber', ['0x10', false]), BLOCK);
  assert.deepEqual(asked, ['second eth_chainId', 'first eth_getBlockByNumber']);
});

const RECEIPT: [string, unknown[]] = ['eth_getTransactionReceipt', [`0x${'cc'.repeat(32)}`]];

test('a second endpoint that hangs: the configured one answers within the short timeout, then it is skipped', async (t) => {
  for (const hangs of ['every request', 'the read only'] as const) {
    const { asked, request } = endpoints(t, {
      first: () => ({ result: 'from-first' }),
      second: (m) => (hangs === 'the read only' ? (chainId(m) ?? { hang: true }) : { hang: true }),
    });
    let started = Date.now();
    assert.equal(await request(...RECEIPT), 'from-first', hangs);
    const waited = Date.now() - started;
    assert.ok(waited >= PREFERRED_SECOND_TIMEOUT_MS - 100, `${hangs}: waited ${waited} ms`);
    assert.ok(waited < 3_500, `${hangs}: waited ${waited} ms (viem's default is 10 s)`);
    // Skipped for a while: the next read goes straight to the configured endpoint.
    started = Date.now();
    assert.equal(await request(...RECEIPT), 'from-first', hangs);
    assert.ok(Date.now() - started < 1_000, hangs);
    assert.deepEqual(asked.slice(-1), ['first eth_getTransactionReceipt'], hangs);
    assert.equal(
      asked.filter((call) => call.startsWith('second ')).length,
      hangs === 'every request' ? 1 : 2,
    );
  }
});

test('a failed chain-id check is kept for a while, then asked again', async (t) => {
  let clock = 1_000_000;
  let secondUp = false;
  const { asked, request } = endpoints(
    t,
    {
      first: () => ({ result: 'from-first' }),
      second: (m) => (secondUp ? (chainId(m) ?? { result: 'from-second' }) : { status: 503 }),
    },
    { now: () => clock },
  );
  assert.equal(await request(...RECEIPT), 'from-first');
  secondUp = true;
  clock += SECOND_BACKOFF_MS - 1;
  assert.equal(await request(...RECEIPT), 'from-first');
  assert.deepEqual(asked, [
    'second eth_chainId',
    'first eth_getTransactionReceipt',
    'first eth_getTransactionReceipt',
  ]);
  clock += 2;
  assert.equal(await request(...RECEIPT), 'from-second');
});

test('a safe or finalized head too old from the second endpoint: the configured one answers', async (t) => {
  const NOW = 1_800_000_000_000;
  const at = (ageMs: number) => ({
    ...BLOCK,
    timestamp: `0x${Math.floor((NOW - ageMs) / 1000).toString(16)}`,
  });
  const FIRST_BLOCK = { ...BLOCK, number: '0x20' };
  for (const [tag, ageMs, fromSecond] of [
    ['finalized', 20 * 60_000, true],
    ['finalized', STALE_TAGGED_HEAD_MS.finalized + 60_000, false],
    ['safe', 2 * 60_000, true],
    ['safe', STALE_TAGGED_HEAD_MS.safe + 60_000, false],
  ] as const) {
    const { request } = endpoints(
      t,
      {
        first: () => ({ result: FIRST_BLOCK }),
        second: (m) => chainId(m) ?? { result: at(ageMs) },
      },
      { now: () => NOW },
    );
    assert.deepEqual(
      await request('eth_getBlockByNumber', [tag, false]),
      fromSecond ? at(ageMs) : FIRST_BLOCK,
      `${tag} ${ageMs / 60_000} min old`,
    );
  }
  // A block by number carries no freshness claim: it is taken whatever its age.
  const { request } = endpoints(t, {
    first: () => ({ result: FIRST_BLOCK }),
    second: (m) => chainId(m) ?? { result: BLOCK },
  });
  assert.deepEqual(await request('eth_getBlockByNumber', ['0x10', false]), BLOCK);
});

test('payments and owner operations quote fees on the configured endpoint first', async (t) => {
  const { randomBytes } = await import('node:crypto');
  const { createChainRuntime } = await import('../server/base/chain/runtime.js');
  const { agentWalletRecipe, deriveAddressLocal } = await import('../server/base/chain/derive.js');
  const { BASE_MAINNET, baseNetwork } = await import('../shared/base/chains.js');
  const { CDP_URL, FALLBACK_URL, fakeBaseNode } = await import('./base-fake-rpc-node.js');
  const env = {
    CITY_BASE_MAINNET: '1',
    CITY_BASE_CDP_RPC_URL: CDP_URL,
    CITY_BASE_READ_FALLBACK_RPC_URL: FALLBACK_URL,
    CITY_BASE_SPENDER_KEK: `v1:${randomBytes(32).toString('base64')}`,
    CITY_BASE_MAX_FEE_PER_GAS_WEI: '1000000000',
    CITY_BASE_IDENTITY_FEE_CAP_WEI: '1000000000000000',
    CITY_BASE_WALLET_FEE_CAP_WEI: '1000000000000000',
  };
  const network = baseNetwork(BASE_MAINNET, env)!;
  const node = fakeBaseNode({
    entryPoint: network.contracts.entryPointV06,
    registry: network.contracts.identityRegistry!,
    chainId: BASE_MAINNET,
    now: () => Date.now(),
    startAt: Date.now(),
  });
  const real = globalThis.fetch;
  globalThis.fetch = node.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  const runtime = createChainRuntime({
    db: { query: async () => ({ rows: [] }) } as never,
    env,
    chainId: BASE_MAINNET,
    walletChainId: BASE_MAINNET,
  });
  const recipe = agentWalletRecipe(network, `0x${'a'.repeat(40)}`, 0n);
  // Only the fee quote matters here; the rest of the preparation may fail against the fake node.
  await runtime
    .ownerOperations!.prepare({
      wallet: deriveAddressLocal(recipe),
      recipe,
      calls: [{ target: `0x${'2'.repeat(40)}`, value: 0n, data: '0x' }],
    })
    .catch(() => null);
  const quotes = node.calls.filter((call) => call.method === 'eth_maxPriorityFeePerGas');
  assert.ok(quotes.length > 0, 'the fee was quoted');
  assert.deepEqual(new Set(quotes.map((call) => call.endpoint)), new Set(['cdp']));
});
