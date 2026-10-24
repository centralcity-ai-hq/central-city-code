import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import type { Database } from '../server/database.js';
import { BASE_MAINNET, BASE_SEPOLIA, type BaseChainId } from '../shared/base/chains.js';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network.js';
import {
  ChainRuntimeError,
  chainRuntimes,
  createChainRuntime,
  walletFeeCap,
} from '../server/base/chain/runtime.js';
import { ownerRevokePortFromEnv } from '../server/base/chain/owner-revoke.js';
import { OTHER_CHAIN_ID } from './wallet-network-fixture.js';

const db = { query: async () => ({ rows: [] }) } as unknown as Database;
// A secret-looking endpoint: it must never appear in any error.
const SECRET_URL = `https://api.example.test/rpc/v1/base/${randomBytes(12).toString('hex')}`;
const kek = `v1:${randomBytes(32).toString('base64')}`;
const mainnetEnv = {
  CITY_BASE_MAINNET: '1',
  CITY_BASE_CDP_RPC_URL: SECRET_URL,
  CITY_BASE_SPENDER_KEK: kek,
  CITY_BASE_MAX_FEE_PER_GAS_WEI: '1000000000',
  CITY_BASE_IDENTITY_FEE_CAP_WEI: '50000000000000',
  CITY_BASE_WALLET_FEE_CAP_WEI: '20000000000000',
};
const sepoliaEnv = {
  CITY_BASE_CDP_SEPOLIA_RPC_URL: SECRET_URL,
  CITY_BASE_SPENDER_KEK: kek,
  CITY_BASE_MAX_FEE_PER_GAS_WEI: '1000000000',
};
/** A complete configuration of a network's runtime. */
const envFor = (chainId: BaseChainId): Record<string, string | undefined> =>
  chainId === BASE_MAINNET ? { ...mainnetEnv } : { ...sepoliaEnv };

const refusedFor = (setting: string) => (e: unknown) =>
  e instanceof ChainRuntimeError &&
  e.setting === setting &&
  !e.message.includes(SECRET_URL) &&
  !e.message.includes(kek);

test('a complete mainnet configuration builds the wallet and identity ports', () => {
  const runtime = createChainRuntime({ db, env: mainnetEnv, chainId: BASE_MAINNET });
  assert.equal(typeof runtime.walletPort.deriveSmartAccount, 'function');
  assert.equal(typeof runtime.identityPort.register, 'function');
});

test('owner operations exist on the wallet network only, never on the other one', () => {
  const wallet = createChainRuntime({
    db,
    env: envFor(WALLET_CHAIN_ID),
    chainId: WALLET_CHAIN_ID,
  });
  assert.equal(wallet.ownerOperations?.chainId, WALLET_CHAIN_ID);
  const other = createChainRuntime({ db, env: envFor(OTHER_CHAIN_ID), chainId: OTHER_CHAIN_ID });
  assert.equal(typeof other.identityPort.register, 'function');
  assert.equal(other.ownerOperations, undefined);
});

test('every missing or malformed setting refuses with its name only, never a value', () => {
  for (const name of [
    'CITY_BASE_CDP_RPC_URL',
    'CITY_BASE_SPENDER_KEK',
    'CITY_BASE_MAX_FEE_PER_GAS_WEI',
    'CITY_BASE_IDENTITY_FEE_CAP_WEI',
  ]) {
    const env = { ...mainnetEnv, [name]: '' };
    assert.throws(
      () => createChainRuntime({ db, env, chainId: BASE_MAINNET }),
      refusedFor(name),
      name,
    );
  }
  assert.throws(
    () =>
      createChainRuntime({
        db,
        env: { ...mainnetEnv, CITY_BASE_SPENDER_KEK: 'not-a-key' },
        chainId: BASE_MAINNET,
      }),
    refusedFor('CITY_BASE_SPENDER_KEK'),
  );
  for (const bad of ['0', '-1', '1.5', 'abc'])
    assert.throws(
      () =>
        createChainRuntime({
          db,
          env: { ...mainnetEnv, CITY_BASE_MAX_FEE_PER_GAS_WEI: bad },
          chainId: BASE_MAINNET,
        }),
      refusedFor('CITY_BASE_MAX_FEE_PER_GAS_WEI'),
    );
});

test('mainnet is refused while its gate is closed, and needs a fee budget when open', () => {
  assert.throws(
    () =>
      createChainRuntime({
        db,
        env: { ...mainnetEnv, CITY_BASE_MAINNET: '' },
        chainId: BASE_MAINNET,
      }),
    refusedFor('network'),
  );
  // Sepolia may run without a per-operation budget; mainnet never does.
  const sepolia = createChainRuntime({ db, env: sepoliaEnv, chainId: BASE_SEPOLIA });
  assert.equal(typeof sepolia.identityPort.transfer, 'function');
});

test('owner operations on mainnet need their own fee budget; without it only they are off', () => {
  // Built for each network as if it were the wallet network.
  const on = (chainId: BaseChainId, env: Record<string, string | undefined>) =>
    createChainRuntime({ db, env, chainId, walletChainId: chainId });
  // Base: CITY_BASE_WALLET_FEE_CAP_WEI is required. Missing or malformed, no owner operation
  // exists, and the runtime registrations share (identity, wallet derivation) still starts.
  for (const value of [undefined, '', ' ', '0', '-1', '1.5', 'abc', '1e18']) {
    const runtime = on(BASE_MAINNET, { ...mainnetEnv, CITY_BASE_WALLET_FEE_CAP_WEI: value });
    assert.equal(runtime.ownerOperations, undefined, String(value));
    assert.equal(typeof runtime.identityPort.register, 'function', String(value));
    assert.equal(typeof runtime.walletPort.deriveSmartAccount, 'function', String(value));
  }
  assert.equal(on(BASE_MAINNET, mainnetEnv).ownerOperations?.chainId, BASE_MAINNET);
  // Base Sepolia may run without one; a malformed one is refused there too.
  assert.equal(on(BASE_SEPOLIA, sepoliaEnv).ownerOperations?.chainId, BASE_SEPOLIA);
  for (const value of ['0', '-1', '1.5', 'abc'])
    assert.equal(
      on(BASE_SEPOLIA, { ...sepoliaEnv, CITY_BASE_WALLET_FEE_CAP_WEI: value }).ownerOperations,
      undefined,
      value,
    );
  assert.deepEqual(walletFeeCap({ CITY_BASE_WALLET_FEE_CAP_WEI: ' 7 ' }, BASE_MAINNET), {
    cap: 7n,
  });
  assert.equal(walletFeeCap({}, BASE_MAINNET), null);
  assert.deepEqual(walletFeeCap({}, BASE_SEPOLIA), { cap: undefined });
  // The wallet network of this build follows the same rule.
  const { CITY_BASE_WALLET_FEE_CAP_WEI: _cap, ...uncapped } = envFor(WALLET_CHAIN_ID);
  assert.equal(
    createChainRuntime({ db, env: uncapped, chainId: WALLET_CHAIN_ID }).ownerOperations?.chainId,
    WALLET_CHAIN_ID === BASE_MAINNET ? undefined : WALLET_CHAIN_ID,
  );
});

test("W3's revoke port follows the same fee-cap rule as the wallet's other owner operations", () => {
  // Base: CITY_BASE_WALLET_FEE_CAP_WEI is required; missing or malformed refuses with its name.
  for (const value of [undefined, '', ' ', '0', '-1', '1.5', 'abc'])
    assert.throws(
      () =>
        ownerRevokePortFromEnv(
          db,
          { ...mainnetEnv, CITY_BASE_WALLET_FEE_CAP_WEI: value },
          BASE_MAINNET,
        ),
      refusedFor('CITY_BASE_WALLET_FEE_CAP_WEI'),
      String(value),
    );
  assert.equal(ownerRevokePortFromEnv(db, mainnetEnv, BASE_MAINNET).chainId, BASE_MAINNET);
  assert.throws(
    () => ownerRevokePortFromEnv(db, { ...mainnetEnv, CITY_BASE_MAINNET: '' }, BASE_MAINNET),
    refusedFor('network'),
  );
  // Base Sepolia may run without one; a malformed one refuses there too.
  assert.equal(ownerRevokePortFromEnv(db, sepoliaEnv, BASE_SEPOLIA).chainId, BASE_SEPOLIA);
  assert.throws(
    () =>
      ownerRevokePortFromEnv(
        db,
        { ...sepoliaEnv, CITY_BASE_WALLET_FEE_CAP_WEI: '1.5' },
        BASE_SEPOLIA,
      ),
    refusedFor('CITY_BASE_WALLET_FEE_CAP_WEI'),
  );
});

test('runtimes are built once per network; a configuration error is not cached', async () => {
  const env: Record<string, string | undefined> = { ...mainnetEnv, CITY_BASE_SPENDER_KEK: '' };
  const runtime = chainRuntimes(db, env);
  await assert.rejects(runtime(BASE_MAINNET), refusedFor('CITY_BASE_SPENDER_KEK'));
  env.CITY_BASE_SPENDER_KEK = kek;
  const first = await runtime(BASE_MAINNET);
  assert.equal(await runtime(BASE_MAINNET), first);
});

test('our bundler wiring per configuration (today: drain, new work on CDP)', async () => {
  const PAYMASTER = '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105';
  // Nothing of ours configured: no upkeep at all.
  assert.equal(
    createChainRuntime({ db, env: mainnetEnv, chainId: BASE_MAINNET }).ownBundlerUpkeep,
    undefined,
  );
  // Production today: prepare + address, CITY_BASE_BUNDLER unset -> a DRAIN with nothing open.
  // Building it touches no keys and no keystore (the db stub answers every query with no rows).
  const today = createChainRuntime({
    db,
    env: {
      ...mainnetEnv,
      CITY_BASE_OWN_PAYMASTER: 'prepare',
      CITY_BASE_PAYMASTER_ADDRESS: PAYMASTER,
    },
    chainId: BASE_MAINNET,
  });
  assert.equal(today.ownBundlerUpkeep?.mode, 'drain');
  assert.equal(await today.ownBundlerUpkeep?.open(), 0);
  assert.equal(await today.ownBundlerUpkeep?.maintain(), 0);
  assert.equal(typeof today.identityPort.register, 'function');
  // Switched on: direct.
  const on = createChainRuntime({
    db,
    env: {
      ...mainnetEnv,
      CITY_BASE_OWN_PAYMASTER: 'on',
      CITY_BASE_PAYMASTER_ADDRESS: PAYMASTER,
      CITY_BASE_BUNDLER: 'direct',
    },
    chainId: BASE_MAINNET,
  });
  assert.equal(on.ownBundlerUpkeep?.mode, 'direct');
  // Direct asked without 'on': CDP for new work, ours drains (never an outage).
  const invalid = createChainRuntime({
    db,
    env: {
      ...mainnetEnv,
      CITY_BASE_OWN_PAYMASTER: 'prepare',
      CITY_BASE_PAYMASTER_ADDRESS: PAYMASTER,
      CITY_BASE_BUNDLER: 'direct',
    },
    chainId: BASE_MAINNET,
  });
  assert.equal(invalid.ownBundlerUpkeep?.mode, 'drain');
});

test('production config today - a real owner operation is prepared through CDP end to end', async (t) => {
  const { BASE_NETWORKS } = await import('../shared/base/chains.js');
  const { deriveAddressLocal, spenderAccountRecipe } =
    await import('../server/base/chain/derive.js');
  const network = BASE_NETWORKS[BASE_MAINNET];
  const sponsor = `0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c${'0'.repeat(174 * 2)}`;
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as
      { id: number; method: string } | { id: number; method: string }[];
    const one = (call: { id: number; method: string }) => {
      asked.push(call.method);
      const result =
        call.method === 'eth_chainId'
          ? '0x2105'
          : call.method === 'eth_getCode'
            ? '0x'
            : call.method === 'eth_call'
              ? `0x${'0'.repeat(64)}`
              : call.method === 'eth_getBlockByNumber'
                ? {
                    number: '0x64',
                    hash: `0x${'1'.repeat(64)}`,
                    baseFeePerGas: '0x1',
                    timestamp: '0x1',
                    transactions: [],
                  }
                : call.method === 'eth_maxPriorityFeePerGas'
                  ? '0x1'
                  : call.method === 'pm_getPaymasterStubData' ||
                      call.method === 'pm_getPaymasterData'
                    ? { paymasterAndData: sponsor }
                    : call.method === 'eth_estimateUserOperationGas'
                      ? {
                          callGasLimit: '0x1',
                          verificationGasLimit: '0x1',
                          preVerificationGas: '0x1',
                        }
                      : null;
      return { jsonrpc: '2.0', id: call.id, result };
    };
    const answer = Array.isArray(body) ? body.map(one) : one(body);
    return new Response(JSON.stringify(answer), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const queries: string[] = [];
  const watchedDb = {
    query: async (sql: string) => (queries.push(sql), { rows: [] }),
  } as unknown as Database;
  const runtime = createChainRuntime({
    db: watchedDb,
    env: {
      ...mainnetEnv,
      CITY_BASE_OWN_PAYMASTER: 'prepare',
      CITY_BASE_PAYMASTER_ADDRESS: '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105',
    },
    chainId: BASE_MAINNET,
  });
  assert.equal(runtime.ownBundlerUpkeep?.mode, 'drain');
  const recipe = spenderAccountRecipe(network, '0x1111111111111111111111111111111111111111');
  const prepared = await runtime.ownerOperations!.prepare({
    wallet: deriveAddressLocal(recipe),
    recipe,
    calls: [{ target: '0x2222222222222222222222222222222222222222', value: 1n, data: '0x' }],
    sponsorFlow: 'exit',
  });
  // CDP's paymaster and gas estimate were asked; the prepared op carries CDP's sponsorship.
  for (const method of [
    'pm_getPaymasterStubData',
    'eth_estimateUserOperationGas',
    'pm_getPaymasterData',
  ])
    assert.ok(asked.includes(method), `${method} asked of CDP`);
  assert.ok(
    prepared.operation.paymasterAndData?.startsWith('0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c'),
  );
  // Ours was never built for it: no keys, no own tables, nothing of ours prepared or signed.
  assert.ok(
    queries.every((sql) => !/own_paymaster/.test(sql)),
    'no own_paymaster query while preparing with CDP',
  );
});
