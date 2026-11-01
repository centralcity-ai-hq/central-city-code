import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  pad,
  toHex,
  type Hex,
  type PublicClient,
} from 'viem';
import type { Database } from '../server/database.js';
import {
  PROTOCOL_FEE_SCAN_PATH,
  protocolFeeChainFromEnv,
  protocolFeeChainId,
  protocolFeeChainIdFromEnv,
  protocolFeeConfigFromEnv,
  protocolFeeRpcUrl,
  protocolFeesEnabled,
  protocolReservedPayees,
  protocolRouter2FromEnv,
  protocolRouter3FromEnv,
  protocolTreasuryFor,
  registerProtocolFeeCron,
  viemFeeChain,
} from '../server/protocol/fees/cron.js';
import { feeRouter2Live } from '../server/feed/pay/router2.js';
import { feeRouter3Live, router3AddressFromEnv } from '../server/feed/pay/router3.js';
import { CDP_RETRY } from '../server/base/chain/rpc-budget.js';
import { PROTOCOL_BASE_MAINNET } from '../shared/protocol.js';
import {
  FEE_EVENTS_ABI,
  feeOnChain,
  isLogLimitError,
  PROTOCOL_FEE_LEDGER_SQL,
  scanFees,
  splitLogs,
  type ChainLog,
  type FeeChain,
} from '../server/protocol/fees/ledger.js';
import { bloomReads } from './fee-chain-bloom.js';

const SECRET = 'x'.repeat(32);
const TREASURY = '0x00000000000000000000000000000000000007e5' as Hex;
const ROUTER = '0x0000000000000000000000000000000000000040' as Hex;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Hex;
const PAYER = '0x00000000000000000000000000000000000000a1' as Hex;
const env = {
  CITY_PROTOCOL_FEES: '1',
  CITY_PROTOCOL_CHAIN_ID: '84532',
  CITY_PROTOCOL_TREASURY: TREASURY,
  CITY_PROTOCOL_ROUTER: ROUTER,
  CITY_PROTOCOL_START_BLOCK: '100',
};

test('config: complete env only; zero or bad addresses and unknown chains refused', () => {
  const ok = protocolFeeConfigFromEnv(env);
  assert.equal(ok?.chainId, 84532);
  assert.equal(ok?.usdc, USDC);
  assert.equal(ok?.startBlock, 100n);
  assert.equal(ok?.escrow, null);
  const withOperator = protocolFeeConfigFromEnv({
    ...env,
    CITY_PROTOCOL_ESCROW_OPERATOR: '0x00000000000000000000000000000000000000Bb',
  });
  assert.equal(withOperator?.escrow?.address, '0xf96815976523E00e65Be8f34cA5e64b4f41EB19c');
  for (const bad of [
    { CITY_PROTOCOL_TREASURY: '0x0000000000000000000000000000000000000000' },
    { CITY_PROTOCOL_ROUTER: 'nope' },
    { CITY_PROTOCOL_START_BLOCK: '' },
    { CITY_PROTOCOL_START_BLOCK: '-1' },
    { CITY_PROTOCOL_ESCROW_OPERATOR: 'nope' },
  ])
    assert.equal(protocolFeeConfigFromEnv({ ...env, ...bad }), null, JSON.stringify(bad));
});

test('live by default: an empty environment is Base mainnet with the router, treasury and start block fixed in code', () => {
  assert.equal(protocolFeesEnabled({}), true);
  for (const value of ['1', 'true', 'off', '', ' 0'])
    assert.equal(protocolFeesEnabled({ CITY_PROTOCOL_FEES: value }), true, value);
  assert.equal(protocolFeesEnabled({ CITY_PROTOCOL_FEES: '0' }), false, 'the emergency off');
  assert.deepEqual(protocolFeeConfigFromEnv({}), {
    chainId: 8453,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    treasury: '0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9',
    router: '0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B',
    addedRouters: [
      { address: '0xb1945a2aF160e84E34F7C0FB0E4dD94fd4c0AF0D', fromBlock: 52767258n },
      { address: '0xE807A76385EC3d76D17aB955091C12329d0A1403', fromBlock: 52804453n },
    ],
    escrow: null,
    startBlock: 52603696n,
  });
  assert.equal(protocolFeeChainId({}), 8453, 'the public metrics answer for Base mainnet');
  assert.equal(protocolFeeChainId({ CITY_PROTOCOL_FEES: '0' }), null);
  assert.equal(protocolTreasuryFor({}, 8453), PROTOCOL_BASE_MAINNET.treasury.toLowerCase());
  // The code's addresses are valid checksummed addresses.
  for (const value of [
    PROTOCOL_BASE_MAINNET.usdc,
    PROTOCOL_BASE_MAINNET.feeRouter,
    PROTOCOL_BASE_MAINNET.treasury,
    PROTOCOL_BASE_MAINNET.sanctionsOracle,
  ])
    assert.equal(getAddress(value), value);
});

test('on Base mainnet the environment cannot move the fee: router, treasury and start block settings are ignored and logged once', () => {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const moved = {
    CITY_PROTOCOL_CHAIN_ID: '8453',
    CITY_PROTOCOL_ROUTER: '0x0000000000000000000000000000000000000a41',
    CITY_PROTOCOL_TREASURY: '0x0000000000000000000000000000000000000a7e',
    CITY_PROTOCOL_START_BLOCK: '7',
  };
  const config = protocolFeeConfigFromEnv(moved, { log });
  assert.equal(config?.router, PROTOCOL_BASE_MAINNET.feeRouter);
  assert.equal(config?.treasury, PROTOCOL_BASE_MAINNET.treasury);
  assert.equal(config?.startBlock, PROTOCOL_BASE_MAINNET.feeRouterDeployBlock);
  assert.equal(protocolTreasuryFor(moved, 8453), PROTOCOL_BASE_MAINNET.treasury.toLowerCase());
  protocolFeeConfigFromEnv(moved, { log });
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    ['CITY_PROTOCOL_ROUTER', 'CITY_PROTOCOL_TREASURY', 'CITY_PROTOCOL_START_BLOCK'].map(
      (setting) => ({ event: 'protocol.setting_ignored', setting, chainId: 8453 }),
    ),
    'once per setting, by name only',
  );
  assert.ok(!lines.join('').includes('a41') && !lines.join('').includes('a7e'));
  // The same values as the code log nothing.
  const same: string[] = [];
  protocolFeeConfigFromEnv(
    {
      CITY_PROTOCOL_ROUTER: PROTOCOL_BASE_MAINNET.feeRouter.toLowerCase(),
      CITY_PROTOCOL_TREASURY: PROTOCOL_BASE_MAINNET.treasury,
      CITY_PROTOCOL_START_BLOCK: '52603696',
    },
    { log: (line) => same.push(line) },
  );
  assert.deepEqual(same, []);
  // A malformed optional escrow operator leaves out the escrow path, never the fee.
  const bad = protocolFeeConfigFromEnv({ CITY_PROTOCOL_ESCROW_OPERATOR: 'nope' }, { log });
  assert.equal(bad?.router, PROTOCOL_BASE_MAINNET.feeRouter);
  assert.equal(bad?.escrow, null);
});

test('on Base mainnet routers 2 and 3 are fixed in code: their address and start block settings are ignored and logged once; the switches still apply', () => {
  const pinned2 = {
    address: PROTOCOL_BASE_MAINNET.feeRouter2,
    fromBlock: PROTOCOL_BASE_MAINNET.feeRouter2DeployBlock,
  };
  const pinned3 = {
    address: PROTOCOL_BASE_MAINNET.feeRouter3,
    fromBlock: PROTOCOL_BASE_MAINNET.feeRouter3DeployBlock,
  };
  assert.equal(PROTOCOL_BASE_MAINNET.feeRouter2, '0xb1945a2aF160e84E34F7C0FB0E4dD94fd4c0AF0D');
  assert.equal(PROTOCOL_BASE_MAINNET.feeRouter2DeployBlock, 52767258n);
  assert.equal(PROTOCOL_BASE_MAINNET.feeRouter3, '0xE807A76385EC3d76D17aB955091C12329d0A1403');
  assert.equal(PROTOCOL_BASE_MAINNET.feeRouter3DeployBlock, 52804453n);
  for (const value of [PROTOCOL_BASE_MAINNET.feeRouter2, PROTOCOL_BASE_MAINNET.feeRouter3])
    assert.equal(getAddress(value), value);

  // Unset: both are read from code (removing the setting never drops a router pinned on calls).
  assert.deepEqual(protocolRouter2FromEnv({}), [pinned2]);
  assert.deepEqual(protocolRouter3FromEnv({}), [pinned3]);
  assert.equal(router3AddressFromEnv({}), PROTOCOL_BASE_MAINNET.feeRouter3);
  assert.deepEqual(protocolFeeConfigFromEnv({})?.addedRouters, [pinned2, pinned3]);

  // Moved: ignored, logged once per setting, by name only.
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const moved = {
    CITY_PROTOCOL_CHAIN_ID: '8453',
    CITY_PROTOCOL_FEE_ROUTER2: '0x0000000000000000000000000000000000000b42',
    CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK: '7',
    CITY_PROTOCOL_FEE_ROUTER3: '0x0000000000000000000000000000000000000b43',
    CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK: '8',
  };
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(protocolRouter2FromEnv(moved, { log }), [pinned2]);
    assert.deepEqual(protocolRouter3FromEnv(moved, { log }), [pinned3]);
  }
  assert.equal(router3AddressFromEnv(moved), PROTOCOL_BASE_MAINNET.feeRouter3);
  assert.deepEqual(protocolFeeConfigFromEnv(moved, { log })?.addedRouters, [pinned2, pinned3]);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      'CITY_PROTOCOL_FEE_ROUTER2',
      'CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK',
      'CITY_PROTOCOL_FEE_ROUTER3',
      'CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK',
    ].map((setting) => ({ event: 'protocol.setting_ignored', setting, chainId: 8453 })),
  );
  assert.ok(!lines.join('').includes('b42') && !lines.join('').includes('b43'));
  // The same values as the code (any case) log nothing.
  const same: string[] = [];
  protocolRouter3FromEnv(
    {
      CITY_PROTOCOL_FEE_ROUTER3: PROTOCOL_BASE_MAINNET.feeRouter3.toLowerCase(),
      CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK: '52804453',
    },
    { log: (line) => same.push(line) },
  );
  assert.deepEqual(same, []);

  // The switches still decide new payments, on the pinned addresses.
  assert.equal(feeRouter2Live({}), false);
  assert.equal(feeRouter3Live({}), false);
  assert.equal(feeRouter2Live({ CITY_PROTOCOL_FEE_ROUTER2_ENABLED: '1' }), true);
  assert.equal(feeRouter3Live({ CITY_PROTOCOL_FEE_ROUTER3_ENABLED: '1' }), true);
  assert.equal(
    feeRouter3Live({ CITY_PROTOCOL_FEE_ROUTER3_ENABLED: '1', CITY_PROTOCOL_FEES: '0' }),
    false,
  );

  // A test network still reads both from the environment.
  assert.deepEqual(protocolRouter3FromEnv({ CITY_PROTOCOL_CHAIN_ID: '84532' }), []);
  assert.deepEqual(
    protocolRouter3FromEnv({
      CITY_PROTOCOL_CHAIN_ID: '84532',
      CITY_PROTOCOL_FEE_ROUTER3: '0x0000000000000000000000000000000000000B43',
      CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK: '8',
    }),
    [{ address: getAddress('0x0000000000000000000000000000000000000b43'), fromBlock: 8n }],
  );
});

test('the scan reads CITY_PROTOCOL_RPC_URL, else the wallet network RPC; never http, never a guess', () => {
  const own = 'https://rpc.protocol.example/base';
  const wallet = 'https://rpc.wallet.example/base';
  assert.equal(protocolFeeRpcUrl({}, 8453), null);
  assert.equal(protocolFeeRpcUrl({ CITY_BASE_CDP_RPC_URL: wallet }, 8453), wallet);
  assert.equal(
    protocolFeeRpcUrl({ CITY_BASE_CDP_RPC_URL: wallet, CITY_PROTOCOL_RPC_URL: own }, 8453),
    own,
  );
  assert.equal(
    protocolFeeRpcUrl({ CITY_BASE_CDP_RPC_URL: 'http://rpc.wallet.example' }, 8453),
    null,
  );
  // Another network's wallet RPC is never used for Base mainnet.
  assert.equal(protocolFeeRpcUrl({ CITY_BASE_CDP_SEPOLIA_RPC_URL: wallet }, 8453), null);
  assert.equal(protocolFeeRpcUrl({}, 1), null);
});

async function setup(t: test.TestContext, overrides: Record<string, string | undefined> = {}) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(PROTOCOL_FEE_LEDGER_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const tx = keccak256(toHex('tx1'));
  const block = keccak256(toHex('b150'));
  const logs: ChainLog[] = [
    {
      address: ROUTER,
      topics: encodeEventTopics({
        abi: FEE_EVENTS_ABI,
        eventName: 'FeeCharged',
        args: {
          payer: PAYER,
          payee: '0x00000000000000000000000000000000000005e1' as Hex,
          ref: keccak256(toHex('r')),
        },
      }) as Hex[],
      data: encodeAbiParameters(
        [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }],
        [0, 90_000n, 9_000n],
      ),
      transactionHash: tx,
      logIndex: 1,
      blockNumber: 150n,
      blockHash: block,
    },
    {
      address: USDC,
      topics: encodeEventTopics({
        abi: FEE_EVENTS_ABI,
        eventName: 'Transfer',
        args: { from: PAYER, to: TREASURY },
      }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint256' }], [9_000n]),
      transactionHash: tx,
      logIndex: 0,
      blockNumber: 150n,
      blockHash: block,
    },
  ];
  const state = { failing: false };
  const chain: FeeChain = {
    latestBlock: async () => {
      if (state.failing) throw new Error('read failed at https://rpc.secret.example/key');
      return 200n;
    },
    finalizedBlock: async () => 160n,
    block: async (n) => ({
      timestamp: 1_791_936_000n + n,
      hash: n === 150n ? block : keccak256(toHex(`b${n}`)),
    }),
    ...bloomReads(
      () => logs,
      (n) => (n === 150n ? block : keccak256(toHex(`b${n}`))),
    ),
    getLogs: async ({ address, fromBlock, toBlock }) =>
      logs.filter(
        (l) =>
          l.address.toLowerCase() === address.toLowerCase() &&
          l.blockNumber >= fromBlock &&
          l.blockNumber <= toBlock,
      ),
  };
  const app = Fastify();
  const lines: string[] = [];
  registerProtocolFeeCron(app, {
    db,
    cronSecret: SECRET,
    env: { ...env, ...overrides },
    chainFor: (id) => (id === 84532 ? chain : null),
    log: (line) => lines.push(line),
  });
  t.after(() => app.close());
  return { app, db, lines, state };
}

const auth = { authorization: `Bearer ${SECRET}` };

test('fails closed: wrong secret, flag off or incomplete config answer 404', async (t) => {
  const plain = await setup(t);
  assert.equal((await plain.app.inject({ url: PROTOCOL_FEE_SCAN_PATH })).statusCode, 404);
  assert.equal(
    (
      await plain.app.inject({
        url: PROTOCOL_FEE_SCAN_PATH,
        headers: { authorization: 'Bearer x' },
      })
    ).statusCode,
    404,
  );
  const off = await setup(t, { CITY_PROTOCOL_FEES: '0' });
  assert.equal(
    (await off.app.inject({ url: PROTOCOL_FEE_SCAN_PATH, headers: auth })).statusCode,
    404,
  );
  const noRouter = await setup(t, { CITY_PROTOCOL_ROUTER: undefined });
  assert.equal(
    (await noRouter.app.inject({ url: PROTOCOL_FEE_SCAN_PATH, headers: auth })).statusCode,
    404,
  );
});

test('on and configured but nothing to read the chain with, or a failed run: 503 unavailable, no crash, no URL logged', async (t) => {
  // Base mainnet (the code's configuration) without an RPC for it.
  const mainnet = await setup(t, { CITY_PROTOCOL_CHAIN_ID: undefined });
  const none = await mainnet.app.inject({ url: PROTOCOL_FEE_SCAN_PATH, headers: auth });
  assert.equal(none.statusCode, 503);
  assert.deepEqual(none.json(), { error: 'unavailable', reason: 'no_rpc' });
  assert.equal(none.headers['cache-control'], 'no-store');
  // The chain read fails: 503, one line with the error's kind only.
  const failing = await setup(t);
  failing.state.failing = true;
  const res = await failing.app.inject({ url: PROTOCOL_FEE_SCAN_PATH, headers: auth });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { error: 'unavailable', reason: 'scan_failed' });
  assert.deepEqual(
    failing.lines.map((line) => JSON.parse(line)),
    [{ event: 'protocol.fee_scan_failed', error: 'Error' }],
  );
  assert.ok(!failing.lines.join('').includes('secret'));
  // It reads again on the next run.
  failing.state.failing = false;
  assert.equal(
    (await failing.app.inject({ url: PROTOCOL_FEE_SCAN_PATH, headers: auth })).statusCode,
    200,
  );
});

test('an authorized run scans, records the fee and logs one line with counts only', async (t) => {
  const { app, db, lines } = await setup(t);
  const res = await app.inject({ url: PROTOCOL_FEE_SCAN_PATH, headers: auth });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { from: '100', to: '200', written: 1, removed: 0, busy: false });
  assert.equal(
    await feeOnChain(db, {
      chainId: 84532,
      emitter: ROUTER,
      payer: PAYER,
      payee: '0x00000000000000000000000000000000000005e1',
      ref: keccak256(toHex('r')),
      kind: 0,
      gross: 90_000n,
      fee: 9_000n,
    }),
    true,
  );
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(PAYER.toLowerCase()));
});

test('the viem adapter sends the topic filter to the node: USDC eth_getLogs asks only for Transfer to the treasury', async (t) => {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(PROTOCOL_FEE_LEDGER_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const sent: { method: string; params: unknown[] }[] = [];
  const client = {
    getBlockNumber: async () => 150n,
    getBlock: async (args: { blockTag?: string; blockNumber?: bigint }) => ({
      number: args.blockTag === 'finalized' ? 120n : (args.blockNumber ?? 0n),
      timestamp: 1_791_936_000n,
      hash: keccak256(toHex(`b${args.blockNumber ?? 0n}`)),
    }),
    request: async (req: { method: string; params: unknown[] }) => {
      sent.push(req);
      return [];
    },
  } as unknown as PublicClient;
  const config = protocolFeeConfigFromEnv(env)!;
  await scanFees(db, viemFeeChain(client), config);
  const calls = sent.filter((r) => r.method === 'eth_getLogs');
  assert.ok(calls.length >= 2);
  const usdcCalls = calls.filter(
    (r) => (r.params[0] as { address: string }).address.toLowerCase() === USDC.toLowerCase(),
  );
  assert.ok(usdcCalls.length > 0, 'USDC is queried');
  for (const r of usdcCalls) {
    const p = r.params[0] as { topics?: (string | null)[]; fromBlock: string; toBlock: string };
    assert.deepEqual(p.topics, [
      keccak256(toHex('Transfer(address,address,uint256)')),
      null,
      pad(TREASURY, { size: 32 }),
    ]);
    assert.match(p.fromBlock, /^0x[0-9a-f]+$/);
  }
  const routerCall = calls.find(
    (r) => (r.params[0] as { address: string }).address.toLowerCase() === ROUTER.toLowerCase(),
  );
  assert.ok(routerCall);
  assert.equal((routerCall!.params[0] as { topics?: unknown }).topics, undefined);
});

test('the viem adapter reads a block from its receipts (eth_getBlockReceipts), every log of every receipt', async () => {
  const sent: { method: string; params: unknown[] }[] = [];
  const log = (i: number) => ({
    address: ROUTER,
    topics: [keccak256(toHex('x'))],
    data: '0x',
    transactionHash: keccak256(toHex(`tx${i}`)),
    logIndex: toHex(i),
    blockNumber: toHex(300),
    blockHash: keccak256(toHex('b300')),
  });
  let answer: unknown = [{ logs: [log(0), log(1)] }, { logs: [] }, { logs: [log(2)] }];
  const client = {
    request: async (req: { method: string; params: unknown[] }) => {
      sent.push(req);
      return answer;
    },
  } as unknown as PublicClient;
  const chain = viemFeeChain(client);
  const logs = await chain.blockLogs!(300n);
  assert.deepEqual(sent, [{ method: 'eth_getBlockReceipts', params: ['0x12c'] }]);
  assert.deepEqual(
    logs.map((l) => [l.logIndex, l.blockNumber]),
    [
      [0, 300n],
      [1, 300n],
      [2, 300n],
    ],
  );
  answer = null;
  await assert.rejects(chain.blockLogs!(300n));
});

test('the production scan client keeps the receipts fallback: blockLogs goes to eth_getBlockReceipts through the configured RPC', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const methods: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    methods.push(body.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [{ logs: [] }] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const chain = protocolFeeChainFromEnv({
    CITY_PROTOCOL_RPC_URL: 'https://rpc.fees-receipts.invalid',
  })(84532);
  assert.ok(chain?.blockLogs, 'the wrapper exposes blockLogs');
  assert.deepEqual(await chain.blockLogs(300n), []);
  assert.deepEqual(methods, ['eth_getBlockReceipts']);
});

test('CCA-107: the production scan client reads headers (logsBloom) and a block by its hash for every fee source', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const sent: { method: string; params: unknown[] }[] = [];
  const bloom = `0x${'0'.repeat(511)}1`;
  const hashOf300 = keccak256(toHex('b300'));
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    sent.push({ method: body.method, params: body.params });
    const result =
      body.method === 'eth_getBlockByNumber'
        ? { number: '0x12c', hash: hashOf300, logsBloom: bloom, timestamp: '0x1' }
        : [];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const chain = protocolFeeChainFromEnv({
    CITY_PROTOCOL_RPC_URL: 'https://rpc.fees-bloom.invalid',
  })(84532)!;
  assert.deepEqual(await chain.header(300n), { hash: hashOf300, logsBloom: bloom });
  assert.deepEqual(await chain.logsAtHash(hashOf300, [ROUTER, USDC]), []);
  assert.equal(sent[0]!.method, 'eth_getBlockByNumber');
  assert.equal(sent[0]!.params[0], '0x12c');
  assert.deepEqual(sent[1], {
    method: 'eth_getLogs',
    params: [{ blockHash: hashOf300, address: [ROUTER, USDC] }],
  });
});

test('only a size refusal is read from receipts; a rate limit or timeout is not', () => {
  for (const sized of [
    new Error('query returned more than 10000 results'),
    Object.assign(new Error('Log response size exceeded.'), { code: -32005 }),
    new Error('too many logs in the range'),
  ])
    assert.equal(isLogLimitError(sized), true, sized.message);
  for (const other of [
    Object.assign(new Error('rate limit exceeded'), { code: 429 }),
    Object.assign(new Error('request rate exceeded'), { code: -32005 }),
    Object.assign(new Error('limit exceeded'), { code: -32005 }),
    Object.assign(new Error('query returned more than 10000 results'), { code: 429 }),
    new Error('HTTP request failed. Status: 429'),
    new Error('The request took too long to respond.'),
    new Error('request timed out'),
    new Error('fetch failed'),
  ])
    assert.equal(isLogLimitError(other), false, other.message);
});

test('a still-refused smallest range: receipts only for a size refusal, never for throttling or a timeout', async () => {
  const source = { address: ROUTER as Hex };
  for (const [error, expectReceipts] of [
    [new Error('query returned more than 10000 results'), true],
    [Object.assign(new Error('rate limit exceeded'), { code: 429 }), false],
    [Object.assign(new Error('request rate exceeded'), { code: -32005 }), false],
    [new Error('request timed out'), false],
  ] as const) {
    let receipts = 0;
    const chain = {
      latestBlock: async () => 100n,
      finalizedBlock: async () => 100n,
      block: async () => ({ hash: '0x' as Hex, timestamp: 0n }),
      getLogs: async () => {
        throw error;
      },
      blockLogs: async () => (receipts++, []),
    } as unknown as FeeChain;
    const read = splitLogs(chain, source, 10n, 12n, { range: null, receiptBlocks: 0 });
    if (expectReceipts) assert.deepEqual(await read, []);
    else await assert.rejects(read);
    assert.equal(receipts > 0, expectReceipts, error.message);
  }
});

test('the public x402 sender is a reserved payee too, with or without a fee config', () => {
  const sender = '0x023f489781C18F45730cFD0357ecdc064A68BAC5';
  for (const env of [
    { CITY_X402_PUBLIC_SETTLE_ADDRESS: sender },
    { CITY_X402_PUBLIC_SETTLE_ADDRESS: sender, CITY_PROTOCOL_FEES: '0' },
  ])
    assert.ok(protocolReservedPayees(env).has(sender.toLowerCase()), JSON.stringify(env));
  assert.ok(
    !protocolReservedPayees({ CITY_X402_PUBLIC_SETTLE_ADDRESS: 'nonsense' }).has('nonsense'),
  );
});

test('the scan client retries a throttled RPC with the shared CDP policy, not the default of three', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('Too Many Requests', { status: 429 });
  }) as typeof fetch;
  const chain = protocolFeeChainFromEnv({
    CITY_PROTOCOL_RPC_URL: 'https://rpc.fees-retry.invalid',
  })(84532);
  assert.ok(chain);
  await assert.rejects(chain.latestBlock());
  assert.equal(CDP_RETRY.retryCount, 1);
  assert.equal(calls, 1 + CDP_RETRY.retryCount);
});

test('an unusable CITY_PROTOCOL_CHAIN_ID never turns the fee off: logged, Base mainnet applies (CCA-137)', () => {
  const mainnet = protocolFeeConfigFromEnv({});
  assert.ok(mainnet);
  for (const raw of ['base', '8453,', '1', 'mainnet', '845320', '8453.0', '0x2105']) {
    const lines: string[] = [];
    const config = protocolFeeConfigFromEnv(
      { CITY_PROTOCOL_CHAIN_ID: raw },
      { log: (line) => lines.push(line) },
    );
    assert.deepEqual(config, mainnet, raw);
    assert.equal(
      protocolFeeChainIdFromEnv({ CITY_PROTOCOL_CHAIN_ID: raw }, () => {}),
      8453,
      raw,
    );
    for (const line of lines)
      assert.deepEqual(JSON.parse(line), {
        event: 'protocol.setting_invalid',
        setting: 'CITY_PROTOCOL_CHAIN_ID',
      });
  }
  // The two networks it may name, and unset or empty (Base mainnet).
  assert.equal(protocolFeeChainIdFromEnv({ CITY_PROTOCOL_CHAIN_ID: ' 84532 ' }), 84532);
  assert.equal(protocolFeeChainIdFromEnv({ CITY_PROTOCOL_CHAIN_ID: '8453' }), 8453);
  assert.equal(protocolFeeChainIdFromEnv({ CITY_PROTOCOL_CHAIN_ID: '' }), 8453);
  assert.equal(protocolFeeChainIdFromEnv({}), 8453);
});
