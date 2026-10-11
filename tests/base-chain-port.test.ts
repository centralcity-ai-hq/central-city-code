import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createPublicClient, http, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BASE_MAINNET, BASE_SEPOLIA, baseNetwork } from '../shared/base/chains.js';
import {
  INIT_CODE_HASHES,
  agentWalletRecipe,
  deriveAddress,
  deriveAddressLocal,
  deriveAgentWallets,
  spenderAccountRecipe,
} from '../server/base/chain/derive.js';
import { createKeystore, parseKeks, type StoredSpenderKey } from '../server/base/chain/keystore.js';
import { createWalletChainPort } from '../server/base/chain/port.js';
import { startAtLowBaseFee } from './anvil-fees.js';

const network = baseNetwork(BASE_SEPOLIA)!;
const owner = '0x1111111111111111111111111111111111111111';

test('local derivation: deterministic, owner- and index-sensitive, unsupported factories refused', () => {
  const a = deriveAddressLocal(agentWalletRecipe(network, owner, 1n));
  assert.equal(a, deriveAddressLocal(agentWalletRecipe(network, owner, 1n)));
  assert.notEqual(a, deriveAddressLocal(agentWalletRecipe(network, owner, 2n)));
  assert.notEqual(
    a,
    deriveAddressLocal(
      agentWalletRecipe(network, '0x2222222222222222222222222222222222222222', 1n),
    ),
  );
  // Owner order is part of the address.
  const recipe = agentWalletRecipe(network, owner, 1n);
  assert.notEqual(a, deriveAddressLocal({ ...recipe, owners: [...recipe.owners].reverse() }));
  assert.throws(
    () => deriveAddressLocal({ ...recipe, factory: '0x3333333333333333333333333333333333333333' }),
    /init-code hash/,
  );
  assert.throws(() => deriveAddressLocal({ ...recipe, version: 2 }), /Unsupported/);
});

test('bulk derivation: explicit indexes, 10,000 wallets in memory, no duplicates', () => {
  const indexes = Array.from({ length: 10_000 }, (_, i) => BigInt(i) * 7919n + 1n);
  const started = performance.now();
  const wallets = deriveAgentWallets(network, owner, indexes);
  const ms = performance.now() - started;
  assert.equal(wallets.length, 10_000);
  assert.equal(new Set(wallets.map((w) => w.address)).size, 10_000);
  assert.equal(wallets[42].recipe.index, indexes[42]);
  assert.ok(ms < 20_000, `took ${ms} ms`);
});

test('wallet chain port: derives locally and creates spenders inside the keystore', async () => {
  const rows = new Map<string, StoredSpenderKey>();
  const keystore = createKeystore({
    store: {
      insert: async (row) => void rows.set(row.keyId, row),
      get: async (id) => rows.get(id) ?? null,
    },
    keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
  });
  const port = createWalletChainPort({ keystore });
  assert.match(port.implementationVersion, /^coinbase-smart-wallet-v1:0x/);

  const owners = [owner, network.contracts.spendPermissionManager] as const;
  assert.equal(
    await port.deriveSmartAccount(BASE_SEPOLIA, [...owners], 5n),
    deriveAddressLocal(agentWalletRecipe(network, owner, 5n)),
  );
  await assert.rejects(port.deriveSmartAccount(BASE_MAINNET, [...owners], 5n), /not available/);
  await assert.rejects(port.deriveSmartAccount(BASE_SEPOLIA, [], 5n), /owner/);

  const spender = await port.createSpender(BASE_SEPOLIA);
  assert.match(spender.keyRef, /^v1:/);
  const row = [...rows.values()][0];
  assert.equal(
    spender.spender,
    deriveAddressLocal(spenderAccountRecipe(network, row.signerAddress)),
  );
  assert.equal(JSON.stringify(spender).includes(row.signerAddress.slice(2).toLowerCase()), false);
});

// Cross-check against the deployed factory (read-only eth_calls) on a local fork of Base Sepolia:
//   anvil --fork-url https://sepolia.base.org --port 8546 ; CITY_BASE_ANVIL_URL=http://127.0.0.1:8546
const ANVIL_URL = process.env.CITY_BASE_ANVIL_URL;
test('local derivation matches the factory exactly', { skip: !ANVIL_URL }, async () => {
  const client = createPublicClient({ transport: http(ANVIL_URL) });
  await startAtLowBaseFee(client);
  const factoryAbi = parseAbi(['function initCodeHash() view returns (bytes32)']);
  assert.equal(
    await client.readContract({
      address: network.contracts.smartWalletFactory,
      abi: factoryAbi,
      functionName: 'initCodeHash',
    }),
    INIT_CODE_HASHES[network.contracts.smartWalletFactory],
  );
  for (const index of [0n, 1n, 2n ** 64n - 1n, 2n ** 255n + 12345n]) {
    const recipe = agentWalletRecipe(
      network,
      privateKeyToAccount(generatePrivateKey()).address,
      index,
    );
    assert.equal(deriveAddressLocal(recipe), await deriveAddress(client, recipe));
  }
});

test('commitSpender: committed with the wallet insert, or left as an orphan on rollback', async (t) => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { BASE_MIGRATION_SQL, BASE_PAYMENTS_MIGRATION_SQL } =
    await import('../server/base/schema.js');
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  const keyRows = new Map<string, StoredSpenderKey>();
  const insertRow = async (row: StoredSpenderKey) => {
    keyRows.set(row.keyId, row);
    await pg.query(
      `INSERT INTO base_spender_keys (key_id, kek_version, wrapped_dek, ciphertext, signer_address, committed_at, created_at)
       VALUES ($1,$2,$3,$4,$5,NULL,$6)`,
      [
        row.keyId,
        row.kekVersion,
        Buffer.from(row.wrappedDek),
        Buffer.from(row.ciphertext),
        row.signerAddress,
        row.createdAt,
      ],
    );
  };
  const keystore = createKeystore({
    store: { insert: insertRow, get: async (id) => keyRows.get(id) ?? null },
    keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
  });
  const port = createWalletChainPort({ keystore });
  const committed = await port.createSpender(BASE_SEPOLIA);
  const rolledBack = await port.createSpender(BASE_SEPOLIA);

  await pg.transaction((tx) => port.commitSpender(tx as never, committed.keyRef, 42));
  await pg
    .transaction(async (tx) => {
      await port.commitSpender(tx as never, rolledBack.keyRef, 43);
      throw new Error('wallet insert failed');
    })
    .catch(() => undefined);

  const state = (ref: string) =>
    pg
      .query<{ committed_at: string | null }>(
        'SELECT committed_at::text AS committed_at FROM base_spender_keys WHERE key_id = $1',
        [ref.split(':')[1]],
      )
      .then((r) => r.rows[0]?.committed_at);
  assert.equal(await state(committed.keyRef), '42');
  assert.equal(await state(rolledBack.keyRef), null);
  await assert.rejects(
    pg.transaction((tx) =>
      port.commitSpender(tx as never, 'v1:00000000-0000-0000-0000-000000000000'),
    ),
    /not found/,
  );
});
