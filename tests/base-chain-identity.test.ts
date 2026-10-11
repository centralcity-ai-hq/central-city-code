import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createPublicClient, createWalletClient, http, parseEther, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BASE_SEPOLIA, baseNetwork } from '../shared/base/chains.js';
import {
  agentWalletRecipe,
  deriveAddress,
  deriveAddressLocal,
  spenderAccountRecipe,
} from '../server/base/chain/derive.js';
import {
  identityRegistryAbi,
  IdentityChainError,
  registerIdentities,
  registeredIds,
  transferIdentities,
} from '../server/base/chain/identity-chain.js';
import { createKeystore, parseKeks, type StoredSpenderKey } from '../server/base/chain/keystore.js';
import { localBundler } from '../server/base/chain/local-bundler.js';
import {
  keystoreSigner,
  refreshFinality,
  type ChainOperationStore,
  type StoredOperation,
} from '../server/base/chain/submit.js';
import { startAtLowBaseFee } from './anvil-fees.js';

function memoryOps(): ChainOperationStore {
  const rows = new Map<string, StoredOperation>();
  return {
    async get(key) {
      return rows.has(key) ? { ...rows.get(key)! } : null;
    },
    async insert(row) {
      if (!rows.has(row.idempotencyKey)) rows.set(row.idempotencyKey, { ...row });
      return { ...rows.get(row.idempotencyKey)! };
    },
    async update(key, patch) {
      rows.set(key, { ...rows.get(key)!, ...patch });
      return { ...rows.get(key)! };
    },
    async transition(key, from, patch) {
      const row = rows.get(key);
      if (!row || !from.includes(row.status)) return null;
      return this.update(key, patch);
    },
  };
}

// The real ERC-8004 registry on an Anvil fork of Base Sepolia (throwaway keys, fork-only ETH):
//   anvil --fork-url https://sepolia.base.org --port 8546 ; CITY_BASE_ANVIL_URL=http://127.0.0.1:8546
const ANVIL_URL = process.env.CITY_BASE_ANVIL_URL;

test(
  'identities: one op registers a batch, one op hands each to its undeployed agent wallet',
  { skip: !ANVIL_URL },
  async () => {
    const network = baseNetwork(BASE_SEPOLIA)!;
    const chain = {
      id: BASE_SEPOLIA,
      name: 'anvil-fork',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [ANVIL_URL!] } },
    } as const;
    const client = createPublicClient({ chain, transport: http(ANVIL_URL) });
    await startAtLowBaseFee(client);
    const setBalance = (address: string, eth: string) =>
      client.request({
        method: 'anvil_setBalance' as never,
        params: [address, `0x${parseEther(eth).toString(16)}`] as never,
      });
    const mine = async (n: number) => {
      for (let i = 0; i < n; i++)
        await client.request({ method: 'evm_mine' as never, params: [] as never });
    };

    const keyRows = new Map<string, StoredSpenderKey>();
    const keystore = createKeystore({
      store: {
        insert: async (row) => void keyRows.set(row.keyId, row),
        get: async (id) => keyRows.get(id) ?? null,
      },
      keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
    });
    const { signer, keyRef } = await keystore.createSpenderKey();
    const recipe = spenderAccountRecipe(network, signer);
    const spender = { address: await deriveAddress(client, recipe), recipe };
    await setBalance(spender.address, '1');
    const bundlerKey = privateKeyToAccount(generatePrivateKey());
    await setBalance(bundlerKey.address, '1');
    const bundler = localBundler({
      client,
      wallet: createWalletClient({ account: bundlerKey, chain, transport: http(ANVIL_URL) }),
      entryPoint: network.contracts.entryPointV06,
    });
    let sends = 0;
    const deps = {
      network,
      client,
      store: memoryOps(),
      bundler: { ...bundler, send: async (op: never) => (sends++, bundler.send(op)) },
      signer: keystoreSigner(client, keystore, keyRef, signer),
    };
    const allow = async () => {};

    // Three agents: short URIs, and each agent's counterfactual wallet [owner, SPM].
    const tag = randomBytes(3).toString('hex').slice(0, 5);
    const uris = [0, 1, 2].map((n) => `https://centralcity.ai/a/${tag}${n}`);
    const owner = privateKeyToAccount(generatePrivateKey()).address;
    const wallets = [1n, 2n, 3n].map((i) =>
      deriveAddressLocal(agentWalletRecipe(network, owner, i)),
    );

    const registration = {
      operationKey: `register:${tag}`,
      intentHash: `0x${'aa'.repeat(32)}` as Hex,
      spender,
      uris,
      beforeBroadcast: allow,
    };
    const registered = await registerIdentities(deps, registration);
    assert.equal(registered.status, 'submitted');
    assert.equal(sends, 1);
    // Retry: never registers twice.
    const again = await registerIdentities(deps, registration);
    assert.equal(again.userOpHash, registered.userOpHash);
    assert.equal(sends, 1);

    await mine(3);
    const settled = (await refreshFinality(deps, registration.operationKey))!;
    assert.equal(settled.status, 'final');
    const ids = await registeredIds(client, deps, settled, uris);
    assert.equal(ids.size, 3);
    for (const id of ids.values()) {
      const holder = await client.readContract({
        address: network.contracts.identityRegistry!,
        abi: identityRegistryAbi,
        functionName: 'ownerOf',
        args: [id],
      });
      assert.equal(holder, spender.address);
    }

    // Hand each identity to its agent's wallet, in one operation; the wallets stay undeployed.
    const transfers = uris.map((uri, n) => ({ id: ids.get(uri)!, to: wallets[n] }));
    const handover = {
      operationKey: `transfer:${tag}`,
      intentHash: `0x${'bb'.repeat(32)}` as Hex,
      spender,
      transfers,
      beforeBroadcast: allow,
    };
    assert.equal((await transferIdentities(deps, handover)).status, 'submitted');
    assert.equal(sends, 2);
    await mine(3);
    assert.equal((await refreshFinality(deps, handover.operationKey))?.status, 'final');
    for (const { id, to } of transfers) {
      const holder = await client.readContract({
        address: network.contracts.identityRegistry!,
        abi: identityRegistryAbi,
        functionName: 'ownerOf',
        args: [id],
      });
      assert.equal(holder, to);
      assert.equal(await client.getCode({ address: to }), undefined, 'wallet stays undeployed');
    }
    // A retry of the stored transfer is reconciled, not refused and not resent.
    await transferIdentities(deps, handover);
    assert.equal(sends, 2);
    // A new transfer of identities the spender no longer holds is refused before anything is stored.
    await assert.rejects(
      transferIdentities(deps, { ...handover, operationKey: `transfer:${tag}:again` }),
      (e: unknown) => e instanceof IdentityChainError && e.code === 'IDENTITY_NOT_HELD',
    );
    assert.equal(sends, 2);
  },
);

test('identity batches are validated before anything is signed', async () => {
  const network = baseNetwork(BASE_SEPOLIA)!;
  const deps = { network } as never;
  const base = {
    operationKey: 'k',
    intentHash: `0x${'aa'.repeat(32)}` as Hex,
    spender: { address: '0x1111111111111111111111111111111111111111', recipe: {} },
  } as never;
  const bad = (uris: string[]) =>
    assert.rejects(
      registerIdentities(deps, { ...(base as object), uris } as never),
      (e: unknown) => e instanceof IdentityChainError && e.code === 'INVALID_BATCH',
    );
  await bad([]);
  await bad(['https://centralcity.ai/a/abc123', 'https://centralcity.ai/a/abc123']);
  await bad(['http://centralcity.ai/a/abc123']);
  await bad([`https://centralcity.ai/a/${'x'.repeat(20)}`]);
  await bad(Array.from({ length: 51 }, (_, n) => `https://centralcity.ai/a/${n}`));
  const mainnet = { network: baseNetwork(8453, { CITY_BASE_MAINNET: '1' })! } as never;
  await assert.rejects(
    registerIdentities(mainnet, {
      ...(base as object),
      uris: ['https://centralcity.ai/a/abc123'],
    } as never),
    (e: unknown) => e instanceof IdentityChainError && e.code === 'FEE_BUDGET_REQUIRED',
  );
});
