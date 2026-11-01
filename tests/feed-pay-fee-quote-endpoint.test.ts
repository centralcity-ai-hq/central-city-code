import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { keccak256, toHex, type Hex } from 'viem';
import { createApp } from '../server/app.js';
import { createChainRuntime } from '../server/base/chain/runtime.js';
import { createKeystore, parseKeks } from '../server/base/chain/keystore.js';
import { pgSpenderKeyStore } from '../server/base/chain/stores.js';
import { BASE_MAINNET, baseNetwork } from '../shared/base/chains.js';
import { CDP_URL, FALLBACK_URL, fakeBaseNode } from './base-fake-rpc-node.js';

/*
 * CCA-111 (residual): in the CDP bundler mode (the default and the rollback), Feed pay without
 * its own endpoint used the registrations' bundler, whose fee quotes ask the keyless second read
 * endpoint first. It now uses the wallet bundler, like payments and owner operations: fee quotes
 * on the configured endpoint first. Synthetic keys and a fake node; nothing leaves the process.
 */
test('CCA-111: Feed pay without its own endpoint quotes fees on the configured endpoint, never the second one first', async (t) => {
  const kek = `v1:${randomBytes(32).toString('base64')}`;
  const env = {
    CITY_BASE_MAINNET: '1',
    CITY_BASE_CDP_RPC_URL: CDP_URL,
    CITY_BASE_READ_FALLBACK_RPC_URL: FALLBACK_URL,
    CITY_BASE_SPENDER_KEK: kek,
    CITY_BASE_MAX_FEE_PER_GAS_WEI: '1000000000',
    CITY_BASE_IDENTITY_FEE_CAP_WEI: '1000000000000000',
    CITY_BASE_WALLET_FEE_CAP_WEI: '1000000000000000',
  };
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const db = app.city.db;
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
  const keystore = createKeystore({ store: pgSpenderKeyStore(db), keks: parseKeks(kek) });
  const { signer, keyRef } = await keystore.createSpenderKey();
  const runtime = createChainRuntime({
    db,
    env,
    chainId: BASE_MAINNET,
    walletChainId: BASE_MAINNET,
  });
  const feedPay = runtime.feedPay!();
  // Only the fee quote matters; the rest of the submission may fail against the fake node.
  await feedPay
    .chargeFee({
      key: `cca111-${randomUUID()}`,
      intentHash: keccak256(toHex('cca111')),
      wallet: {
        walletId: randomUUID(),
        address: `0x${'3'.repeat(40)}`,
        spender: signer,
        spenderKeyRef: keyRef,
      },
      calls: [{ to: `0x${'2'.repeat(40)}` as Hex, value: 0n, data: '0x' }],
      beforeBroadcast: async () => {},
    })
    .catch(() => null);
  const quotes = node.calls.filter((call) => call.method === 'eth_maxPriorityFeePerGas');
  assert.ok(quotes.length > 0, 'the fee was quoted');
  assert.deepEqual(new Set(quotes.map((call) => call.endpoint)), new Set(['cdp']));
});
