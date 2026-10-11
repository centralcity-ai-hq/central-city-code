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
