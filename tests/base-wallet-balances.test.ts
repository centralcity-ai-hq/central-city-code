import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  multicall3Abi,
  parseAbi,
  type Hex,
} from 'viem';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_WALLET_VAULT_SQL,
} from '../server/base/schema.js';
import { registerBaseWalletRoutes, walletReaders } from '../server/base/wallet/routes.js';
import { balanceCache, ChainUnavailableError } from '../server/base/wallet/balance-cache.js';
import {
  baseBalanceReader,
  reservationBalanceOf,
  type BalanceReader,
} from '../server/base/chain/balances.js';
import { MULTICALL3, NATIVE_ETH, type Address } from '../shared/base/chains.js';
import {
  OTHER_EXPECTED,
  WALLET_EXPECTED,
  WALLET_NET,
  WALLET_ON,
} from './wallet-network-fixture.js';

/** The wallet network (shared/base/wallet-network.ts): Base Sepolia or Base. */
const NETWORK = WALLET_NET;
const USDC = NETWORK.tokens.USDC.address;
const AGENT = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const WALLET = getAddress(`0x${'1'.repeat(40)}`);
const OWNER = getAddress(`0x${'2'.repeat(40)}`);
const NOW = 1_760_000_000_000;

const erc20 = parseAbi(['function balanceOf(address owner) view returns (uint256)']);
const probe = parseAbi(['function entryPoint() view returns (address)']);

type Mode =
  | 'ok'
  | 'http500'
  | 'rpcInternal'
  | 'rpcReverted'
  | 'malformed'
  | 'badEntry'
  | 'longEntry'
  | 'failedEntry'
  | 'shortList';
const FAILURES: Mode[] = [
  'http500',
  'rpcInternal',
  'rpcReverted',
  'malformed',
  'badEntry',
  'longEntry',
  'failedEntry',
  'shortList',
];

/** A local JSON-RPC stand-in for the wallet network (no network): head, balances via aggregate3. */
async function mockWalletNode(t: { after: (fn: () => Promise<unknown>) => void }) {
  const state = {
    chain: WALLET_EXPECTED.chainHex,
    block: 900,
    usdc: 2_500_000n,
    eth: 10n ** 15n,
    deployed: false,
    mode: 'ok' as Mode,
    delayMs: 0,
    calls: [] as Array<{ method: string; params: unknown[] }>,
  };
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const call = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
      state.calls.push(call);
      const send = (body: unknown, status = 200) =>
        setTimeout(() => {
          response.statusCode = status;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(body));
        }, state.delayMs);
      const result = (value: unknown) => send({ jsonrpc: '2.0', id: call.id, result: value });
      const error = (code: number, message: string, data?: string) =>
        send({ jsonrpc: '2.0', id: call.id, error: { code, message, ...(data ? { data } : {}) } });
      if (call.method === 'eth_chainId') return result(state.chain);
      if (call.method === 'eth_blockNumber') return result(`0x${state.block.toString(16)}`);
      if (call.method !== 'eth_call') return error(-32601, 'method not found');
      if (state.mode === 'http500') return send({ error: 'upstream down' }, 500);
      if (state.mode === 'rpcInternal') return error(-32603, 'internal error');
      if (state.mode === 'rpcReverted') return error(3, 'execution reverted', '0x');
      if (state.mode === 'malformed') return result('0x1234');
      const [tx] = call.params as [{ to: string; data: Hex }];
      assert.equal(getAddress(tx.to), MULTICALL3);
      const { args } = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
      const inner = args[0] as ReadonlyArray<{
        target: string;
        allowFailure: boolean;
        callData: Hex;
      }>;
      const answers = inner.map((item) => {
        const target = getAddress(item.target);
        if (target === USDC) {
          assert.equal(item.allowFailure, false);
          const { args: owner } = decodeFunctionData({ abi: erc20, data: item.callData });
          assert.equal(owner[0], WALLET);
          if (state.mode === 'badEntry') return { success: true, returnData: '0x12' as Hex };
          if (state.mode === 'failedEntry') return { success: false, returnData: '0x' as Hex };
          const word = encodeFunctionResult({
            abi: erc20,
            functionName: 'balanceOf',
            result: state.usdc,
          });
          return {
            success: true,
            returnData: (state.mode === 'longEntry' ? `${word}${'00'.repeat(32)}` : word) as Hex,
          };
        }
        if (target === MULTICALL3) {
          assert.equal(item.allowFailure, false);
          const decoded = decodeFunctionData({ abi: multicall3Abi, data: item.callData });
          assert.equal(decoded.functionName, 'getEthBalance');
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: multicall3Abi,
              functionName: 'getEthBalance',
              result: state.eth,
            }),
          };
        }
        assert.equal(target, WALLET);
        assert.equal(item.allowFailure, true);
        decodeFunctionData({ abi: probe, data: item.callData });
        // No code: the call runs nothing and succeeds empty. Code: the wallet answers.
        return state.deployed
          ? {
              success: true,
              returnData: encodeFunctionResult({
                abi: probe,
                functionName: 'entryPoint',
                result: NETWORK.contracts.entryPointV06,
              }),
            }
          : { success: true, returnData: '0x' as Hex };
      });
      return result(
        encodeFunctionResult({
          abi: multicall3Abi,
          functionName: 'aggregate3',
          result: state.mode === 'shortList' ? answers.slice(0, 2) : answers,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const ethCalls = () => state.calls.filter((call) => call.method === 'eth_call');
  return { state, ethCalls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function routes(
  t: { after: (fn: () => Promise<unknown>) => void },
  balances: BalanceReader | undefined,
) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('person-1','owner');
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);
    INSERT INTO agent_manifests VALUES ('${AGENT}', 'person-1', 1, '{}');`);
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(BASE_WALLET_VAULT_SQL);
  await pg.query(
    `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key, kdf_params,
       cipher_params, version, backup_confirmed_at, created_at, updated_at)
     VALUES ('person-1', $1, decode(repeat('ab', 48), 'hex'), '{}', '{}', 1, 5, 1, 1)`,
    [OWNER],
  );
  await pg.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       owner_account_id, spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w1', $1, 'person-1', $5, $2, $3, 'person-1', $4, 'v1:k', '{}', 'derived', 1, 1)`,
    [AGENT, WALLET, OWNER, `0x${'3'.repeat(40)}`, WALLET_EXPECTED.chainId],
  );
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const clock = { now: NOW };
  const app = Fastify();
  t.after(() => app.close());
  registerBaseWalletRoutes(app, {
    db,
    env: { CITY_BASE_WALLET: '1' },
    currentPerson: async () => ({ id: 'person-1' }),
    currentWorkspace: async () => ({ id: 'person-1' }),
    runtime: async () => {
      throw new Error('not used');
    },
    balances,
    now: () => clock.now,
  });
  const get = () =>
    app.inject({ url: `/api/base/agents/${AGENT}/wallet`, headers: { 'x-test': '1' } });
  return { get, clock };
}

test('one aggregate3 call at one block reads USDC, ETH and whether the wallet has code', async (t) => {
  // The USDC of the wallet network, as listed (chains.ts).
  assert.equal(USDC, WALLET_EXPECTED.usdc);
  const base = await mockWalletNode(t);
  const reader = baseBalanceReader(base.url, NETWORK);
  assert.deepEqual(await reader.balances(WALLET), {
    usdc: 2_500_000n,
    eth: 10n ** 15n,
    deployed: false,
    blockNumber: 900n,
  });
  assert.equal(base.ethCalls().length, 1);
  // Pinned to the block the head reported, never 'latest'.
  assert.equal(base.ethCalls()[0].params[1], '0x384');

  base.state.deployed = true;
  base.state.block = 901;
  base.state.usdc = 0n;
  assert.deepEqual(await reader.balances(WALLET.toLowerCase() as Address), {
    usdc: 0n,
    eth: 10n ** 15n,
    deployed: true,
    blockNumber: 901n,
  });
  // The network is checked once per reader.
  assert.equal(base.state.calls.filter((call) => call.method === 'eth_chainId').length, 1);

  // Another network's endpoint is never read as the wallet network.
  base.state.chain = OTHER_EXPECTED.chainHex;
  await assert.rejects(baseBalanceReader(base.url, NETWORK).balances(WALLET), /expected network/);
});

test('every transport, RPC or decoding failure rejects the read; nothing reads as zero', async (t) => {
  const base = await mockWalletNode(t);
  const reader = baseBalanceReader(base.url, NETWORK);
  for (const mode of FAILURES) {
    base.state.mode = mode;
    await assert.rejects(reader.balances(WALLET), Error, mode);
  }
  // A silent endpoint times out and rejects too.
  base.state.mode = 'ok';
  base.state.delayMs = 400;
  await assert.rejects(
    baseBalanceReader(base.url, NETWORK, 100).balances(WALLET),
    /timed out|took too long/i,
  );
});

test('the wallet read is cached ~10 s per wallet; parallel requests get the same read', async (t) => {
  const base = await mockWalletNode(t);
  const { get, clock } = await routes(t, baseBalanceReader(base.url, NETWORK));
  base.state.delayMs = 150;
  const all = await Promise.all(Array.from({ length: 5 }, get));
  for (const res of all) {
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), {
      chainId: WALLET_EXPECTED.chainId,
      network: WALLET_EXPECTED.name,
      testnet: WALLET_EXPECTED.testnet,
      address: WALLET,
      ownerAddress: OWNER,
      spenderAddress: `0x${'3'.repeat(40)}`,
      deployed: false,
      fundingLocked: false,
      usdc: { raw: '2500000', decimals: 6, display: '2.5' },
      eth: { raw: '1000000000000000', decimals: 18, display: '0.001' },
      readAtBlock: 900,
      readAt: NOW,
      stale: false,
      explorerUrl: `${WALLET_EXPECTED.explorer}/address/${WALLET}`,
    });
  }
  assert.equal(base.ethCalls().length, 1);

  // Within the window: the same read, no new call.
  base.state.block = 905;
  base.state.usdc = 7_000_000n;
  clock.now += 9_999;
  const cached = (await get()).json();
  assert.deepEqual([cached.readAtBlock, cached.readAt, cached.usdc.raw], [900, NOW, '2500000']);
  assert.equal(base.ethCalls().length, 1);

  // After it: read again, at the new block.
  clock.now += 1;
  const fresh = (await get()).json();
  assert.deepEqual(
    [fresh.readAtBlock, fresh.readAt, fresh.usdc.raw, fresh.stale],
    [905, NOW + 10_000, '7000000', false],
  );
  assert.equal(base.ethCalls().length, 2);
});

test('a failed read serves the last good read as stale, with its true block and time', async (t) => {
  const base = await mockWalletNode(t);
  const { get, clock } = await routes(t, baseBalanceReader(base.url, NETWORK));
  const good = (await get()).json();
  assert.equal(good.stale, false);

  for (const mode of FAILURES) {
    base.state.mode = mode;
    base.state.block += 1;
    base.state.usdc = 0n;
    clock.now += 10_000;
    const before = base.ethCalls().length;
    const res = await get();
    assert.equal(res.statusCode, 200, mode);
    const body = res.json();
    assert.equal(body.stale, true, mode);
    assert.deepEqual(
      [body.readAtBlock, body.readAt, body.usdc, body.eth],
      [good.readAtBlock, good.readAt, good.usdc, good.eth],
      mode,
    );
    assert.equal(base.ethCalls().length, before + 1, mode);
    // Right after a failure the endpoint is not asked again for the same wallet.
    clock.now += 5_000;
    assert.equal((await get()).json().stale, true, mode);
    assert.equal(base.ethCalls().length, before + 1, mode);
  }

  // Base answers again: a fresh read with the new values.
  base.state.mode = 'ok';
  clock.now += 10_000;
  const back = (await get()).json();
  assert.deepEqual(
    [back.stale, back.readAtBlock, back.readAt, back.usdc.raw],
    [false, base.state.block, clock.now, '0'],
  );
});

test('without any good read a failure is 503 chain_unavailable, never zero balances', async (t) => {
  const base = await mockWalletNode(t);
  const { get, clock } = await routes(t, baseBalanceReader(base.url, NETWORK));
  for (const mode of FAILURES) {
    base.state.mode = mode;
    clock.now += 10_000;
    const before = base.ethCalls().length;
    const res = await get();
    assert.equal(res.statusCode, 503, mode);
    assert.deepEqual(res.json(), { error: 'Base could not be read.', code: 'chain_unavailable' });
    assert.equal(base.ethCalls().length, before + 1, mode);
  }
  // No endpoint of the wallet network configured at all.
  const unconfigured = await routes(t, undefined);
  const res = await unconfigured.get();
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, 'chain_unavailable');
});

test('concurrent reads of one wallet share one read of Base, success or failure', async () => {
  let calls = 0;
  let settle!: (ok: boolean) => void;
  const reader: BalanceReader = {
    balances: async () => {
      calls += 1;
      const ok = await new Promise<boolean>((resolve) => (settle = resolve));
      if (!ok) throw new Error('down');
      return { usdc: 5n, eth: 6n, deployed: true, blockNumber: 7n };
    },
  };
  let now = 0;
  const cache = balanceCache(reader, { now: () => now });
  const lower = WALLET.toLowerCase() as Address;
  const reads = Promise.all([cache.read(WALLET), cache.read(lower), cache.read(WALLET)]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  settle(true);
  for (const read of await reads)
    assert.deepEqual(read, {
      balances: { usdc: 5n, eth: 6n, deployed: true, blockNumber: 7n },
      readAt: 0,
      stale: false,
    });

  now = 10_000;
  const failing = Promise.all([cache.read(WALLET), cache.read(WALLET)]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  settle(false);
  for (const read of await failing) assert.deepEqual([read.stale, read.readAt], [true, 0]);
});

test('the cache keeps no entry beyond its bound and never invents a read', async () => {
  let n = 0;
  const reader: BalanceReader = {
    balances: async () => {
      n += 1;
      return { usdc: BigInt(n), eth: 0n, deployed: false, blockNumber: BigInt(n) };
    },
  };
  let now = 0;
  const cache = balanceCache(reader, { now: () => now, maxEntries: 2 });
  const a = `0x${'a'.repeat(40)}` as Address;
  const b = `0x${'b'.repeat(40)}` as Address;
  const c = `0x${'c'.repeat(40)}` as Address;
  assert.equal((await cache.read(a)).balances.usdc, 1n);
  assert.equal((await cache.read(b)).balances.usdc, 2n);
  assert.equal((await cache.read(c)).balances.usdc, 3n);
  // `a` was evicted to make room: it is read again, not served from memory.
  assert.equal((await cache.read(a)).balances.usdc, 4n);
  now += 1;
  assert.equal((await cache.read(a)).balances.usdc, 4n);

  const failing = balanceCache({ balances: async () => Promise.reject(new Error('down')) });
  await assert.rejects(failing.read(a), ChainUnavailableError);
});

test('reservations read one allowlisted token from a fresh read at its block', async (t) => {
  const base = await mockWalletNode(t);
  const balanceOf = reservationBalanceOf(baseBalanceReader(base.url, NETWORK), NETWORK);
  assert.deepEqual(await balanceOf(WALLET, USDC), { balance: 2_500_000n, blockNumber: 900n });
  base.state.block = 901;
  assert.deepEqual(await balanceOf(WALLET, NATIVE_ETH), { balance: 10n ** 15n, blockNumber: 901n });
  assert.equal(base.ethCalls().length, 2);
  await assert.rejects(balanceOf(WALLET, `0x${'9'.repeat(40)}` as Address), /not allowlisted/);
  assert.equal(base.ethCalls().length, 2);
  base.state.mode = 'http500';
  await assert.rejects(balanceOf(WALLET, USDC));
});

test('the wallet readers (balances, spend permissions, ownerOf): the wallet network endpoint, and on Base only with its gate open', async (t) => {
  // Building the readers reads nothing; the reads themselves go to the local mock.
  const base = await mockWalletNode(t);
  const endpoint = { [WALLET_EXPECTED.endpointEnv]: base.url };
  assert.equal(WALLET_NET.bundlerEnv, WALLET_EXPECTED.endpointEnv);
  assert.deepEqual(walletReaders({}), {});
  assert.deepEqual(walletReaders({ ...WALLET_ON, [OTHER_EXPECTED.endpointEnv]: base.url }), {});
  const open = walletReaders({ ...WALLET_ON, ...endpoint });
  assert.equal(open.payChain?.chainId, WALLET_EXPECTED.chainId);
  assert.equal(open.payChain?.registry, WALLET_EXPECTED.registry);
  assert.equal(typeof open.permissions?.read, 'function');
  assert.equal((await open.balances!.balances(WALLET)).usdc, 2_500_000n);
  // Without CITY_BASE_MAINNET=1: Base Sepolia has no gate; Base reads nothing at all.
  const ungated = walletReaders({ CITY_BASE_WALLET: '1', ...endpoint });
  if (WALLET_EXPECTED.testnet) assert.equal(ungated.payChain?.chainId, WALLET_EXPECTED.chainId);
  else assert.deepEqual(ungated, {});
});
