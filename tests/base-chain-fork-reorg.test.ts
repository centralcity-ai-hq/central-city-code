import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  TransactionReceiptNotFoundError,
  type Hex,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
} from '../server/base/schema.js';
import { BASE_SEPOLIA, baseNetwork } from '../shared/base/chains.js';
import { deriveAddress, spenderAccountRecipe } from '../server/base/chain/derive.js';
import { identityRegistryAbi } from '../server/base/chain/identity-chain.js';
import { createIdentityChainPort } from '../server/base/chain/identity-port.js';
import {
  createKeystore,
  parseKeks,
  parseKeyRef,
  type StoredSpenderKey,
} from '../server/base/chain/keystore.js';
import { localBundler } from '../server/base/chain/local-bundler.js';
import { createWalletChainPort } from '../server/base/chain/port.js';
import { pgChainOperationStore, pgSpenderKeyStore } from '../server/base/chain/stores.js';
import {
  keystoreSigner,
  refreshFinality,
  submitOperation,
  type BundlerReceipt,
  type ChainOperationStore,
  type StoredOperation,
} from '../server/base/chain/submit.js';
import { startAtLowBaseFee } from './anvil-fees.js';

// Real reorgs on an Anvil fork of Base Sepolia, not scripted ones: an operation really lands in
// block N, the fork is rolled back (evm_revert) and another block is mined at height N, so the
// node itself no longer has the transaction and holds a different block at that height. Throwaway
// keys and fork-only test ETH:
//   anvil --fork-url https://sepolia.base.org --port 8546 ; CITY_BASE_ANVIL_URL=http://127.0.0.1:8546
// Every subtest rolls the fork back to where it started, so the other fork tests never see it.
const ANVIL_URL = process.env.CITY_BASE_ANVIL_URL;

function memoryOps(): ChainOperationStore & { rows: Map<string, StoredOperation> } {
  const rows = new Map<string, StoredOperation>();
  return {
    rows,
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
    async transition(key, from, patch, expect) {
      const row = rows.get(key);
      if (!row || !from.includes(row.status)) return null;
      if (
        expect &&
        (row.txHash !== expect.txHash ||
          row.blockNumber !== expect.blockNumber ||
          row.errorCode !== expect.errorCode)
      )
        return null;
      return this.update(key, patch);
    },
  };
}

function forkClient() {
  const chain = {
    id: BASE_SEPOLIA,
    name: 'anvil-fork',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [ANVIL_URL!] } },
  } as const;
  return { chain, client: createPublicClient({ chain, transport: http(ANVIL_URL) }) };
}

const rpc = <T>(client: PublicClient, method: string, params: unknown[] = []): Promise<T> =>
  client.request({ method: method as never, params: params as never }) as Promise<T>;

const setBalance = (client: PublicClient, address: string, eth: string) =>
  rpc(client, 'anvil_setBalance', [address, `0x${parseEther(eth).toString(16)}`]);

const mine = async (client: PublicClient, blocks: number) => {
  for (let i = 0; i < blocks; i++) await rpc(client, 'evm_mine');
};

/** Snapshot now; the fork is rolled back to it when the test ends (also when it fails). */
async function restoreOnEnd(t: { after(fn: () => unknown): void }, client: PublicClient) {
  const start = await client.getBlock({ blockTag: 'latest' });
  const snapshot = await rpc<Hex>(client, 'evm_snapshot');
  // A cleanup that did not happen must fail loudly, never leave the fork changed for later suites.
  t.after(async () => {
    assert.equal(await rpc<boolean>(client, 'evm_revert', [snapshot]), true, 'fork restored');
    const end = await client.getBlock({ blockTag: 'latest' });
    assert.equal(end.number, start.number, 'head number restored');
    assert.equal(end.hash, start.hash, 'head hash restored');
  });
}

/**
 * A real same-height reorg: rolls the fork back to `snapshot` (taken before the transaction was
 * sent), then mines a different block at the transaction's height (a later timestamp, without the
 * transaction). Returns the replaced and the new hash of that block.
 */
async function reorgAway(
  client: PublicClient,
  snapshot: Hex,
  tx: { txHash: Hex; blockNumber: bigint },
): Promise<{ h1: Hex; h2: Hex }> {
  const replaced = await client.getBlock({ blockNumber: tx.blockNumber });
  assert.equal(await rpc<boolean>(client, 'evm_revert', [snapshot]), true);
  assert.equal(await client.getBlockNumber({ cacheTime: 0 }), tx.blockNumber - 1n);
  await rpc(client, 'evm_setNextBlockTimestamp', [`0x${(replaced.timestamp + 7n).toString(16)}`]);
  await rpc(client, 'evm_mine');
  const replacement = await client.getBlock({ blockNumber: tx.blockNumber });
  assert.notEqual(replacement.hash, replaced.hash, 'another block at the same height');
  assert.ok(
    !replacement.transactions.some((hash) => hash.toLowerCase() === tx.txHash.toLowerCase()),
    'the new block does not carry the transaction',
  );
  await assert.rejects(
    client.getTransactionReceipt({ hash: tx.txHash }),
    (e: unknown) => e instanceof TransactionReceiptNotFoundError,
    'the node has no receipt for the reorged transaction',
  );
  return { h1: replaced.hash!, h2: replacement.hash! };
}

test('real reorgs on the Anvil fork', { skip: !ANVIL_URL, concurrency: false }, async (t) => {
  await t.test(
    'finality: a stale bundler receipt for a reorged-away block never settles; it ends RECEIPT_GONE',
    async (t) => {
      const network = baseNetwork(BASE_SEPOLIA)!; // 3 confirmations on Sepolia
      const { chain, client } = forkClient();
      await restoreOnEnd(t, client);
      await startAtLowBaseFee(client);

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
      const sender = await deriveAddress(client, recipe);
      await setBalance(client, sender, '1'); // no paymaster locally: the account prefunds its gas
      const bundlerKey = privateKeyToAccount(generatePrivateKey());
      await setBalance(client, bundlerKey.address, '1');
      const wallet = createWalletClient({ account: bundlerKey, chain, transport: http(ANVIL_URL) });
      const bundler = localBundler({ client, wallet, entryPoint: network.contracts.entryPointV06 });
      const opSigner = keystoreSigner(client, keystore, keyRef, signer);
      const store = memoryOps();
      const deps = { network, client, store, bundler, signer: opSigner };
      const recipient = privateKeyToAccount(generatePrivateKey()).address;
      const key = 'test:reorg:transfer';

      // The operation really lands in block N with hash H1.
      const beforeSend = await rpc<Hex>(client, 'evm_snapshot');
      await submitOperation(deps, {
        idempotencyKey: key,
        intentHash: `0x${'61'.repeat(32)}`,
        kind: 'transfer',
        account: { address: sender, recipe },
        calls: [{ target: recipient, value: parseEther('0.001'), data: '0x' }],
      });
      const included = (await refreshFinality(deps, key))!;
      assert.equal(included.status, 'included');
      assert.equal(await client.getBalance({ address: recipient }), parseEther('0.001'));
      const stale: BundlerReceipt = (await bundler.receipt(included.userOpHash))!;
      assert.equal(stale.txHash, included.txHash);
      assert.equal(stale.blockNumber.toString(10), included.blockNumber);
      // The same included row, read by a node that asks the real bundler (store copy below).
      const viaChain = memoryOps();
      await viaChain.insert(included);

      const { h1, h2 } = await reorgAway(client, beforeSend, stale);
      t.diagnostic(`block ${stale.blockNumber}: H1 ${h1} replaced by H2 ${h2}`);
      assert.equal(await client.getBalance({ address: recipient }), 0n, 'the transfer is gone');

      // A bundler that keeps answering the old receipt (same transaction, same block number).
      const staleDeps = { ...deps, bundler: { ...bundler, receipt: async () => stale } };
      // Not deep yet: stays included, nothing concluded.
      const shallow = (await refreshFinality(staleDeps, key))!;
      assert.equal(shallow.status, 'included');
      assert.equal(shallow.txHash, stale.txHash);

      // Deep enough (head − 3 ≥ N): the chain has no receipt, so it is reorged, never final.
      await mine(client, network.confirmations);
      const head = await client.getBlockNumber({ cacheTime: 0 });
      assert.ok(head - BigInt(network.confirmations) >= stale.blockNumber, 'N is settled depth');
      const settled = (await refreshFinality(staleDeps, key))!;
      assert.equal(settled.status, 'reorged');
      assert.equal(settled.errorCode, 'RECEIPT_GONE');
      t.diagnostic(`stale bundler: ${settled.status}/${settled.errorCode}`);
      // Asking again with the stale receipt never turns it final.
      assert.notEqual((await refreshFinality(staleDeps, key))!.status, 'final');

      // The real local bundler (which re-checks the node) gives no receipt; the on-chain search
      // from the submitted block to the head finds no event either: reorged, RECEIPT_GONE.
      const searched = (await refreshFinality({ ...deps, store: viaChain }, key))!;
      assert.equal(searched.status, 'reorged');
      assert.equal(searched.errorCode, 'RECEIPT_GONE');
      t.diagnostic(`real bundler + log search: ${searched.status}/${searched.errorCode}`);
    },
  );

  await t.test(
    'mint evidence: a mint reorged away is never reported minted, before or after it is deep',
    async (t) => {
      const network = baseNetwork(BASE_SEPOLIA)!;
      const { chain, client } = forkClient();
      await restoreOnEnd(t, client);
      await startAtLowBaseFee(client);

      const pg = await PGlite.create('memory://');
      t.after(() => pg.close());
      await pg.exec(
        "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
      );
      await pg.exec(BASE_MIGRATION_SQL);
      await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
      await pg.exec(BASE_SHARED_ADDITIONS_SQL);
      await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
      const db: Database = {
        query: (sql, params) => pg.query(sql, params) as never,
        exec: (sql) => pg.exec(sql),
        transaction: (action) => pg.transaction((tx) => action(tx as never)),
        close: () => pg.close(),
      };
      const keyStore = pgSpenderKeyStore(db);
      const keystore = createKeystore({
        store: keyStore,
        keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
      });
      const { spender, keyRef } = await createWalletChainPort({ keystore }).createSpender(
        BASE_SEPOLIA,
      );
      await pg.query(
        `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
           spender_address, spender_key_ref, derivation, state, created_at, updated_at)
         VALUES ('w-1','agent-r','ws-1',84532,$1,$1,$2,$3,'{}','derived',0,0)`,
        [`0x${'d'.repeat(40)}`, spender, keyRef],
      );
      await setBalance(client, spender, '1');
      const bundlerKey = privateKeyToAccount(generatePrivateKey());
      await setBalance(client, bundlerKey.address, '1');
      const real = localBundler({
        client,
        wallet: createWalletClient({ account: bundlerKey, chain, transport: http(ANVIL_URL) }),
        entryPoint: network.contracts.entryPointV06,
      });
      // While set, the bundler keeps answering this receipt, as a stale one would after a reorg.
      let staleReceipt: BundlerReceipt | null = null;
      const operations = pgChainOperationStore(db);
      const port = createIdentityChainPort({
        network,
        client,
        db,
        operations,
        bundler: { ...real, receipt: async (hash) => staleReceipt ?? real.receipt(hash) },
        keystore,
        signerOf: async (ref) => (await keyStore.get(parseKeyRef(ref).keyId))!.signerAddress,
      });
      const registry = network.contracts.identityRegistry!;
      const uri = `https://centralcity.ai/a/${randomBytes(3).toString('hex')}`;
      const key = 'identity:register:84532:reorg';
      const ask = { operationKey: key, chainId: BASE_SEPOLIA, uri } as const;

      // The registration really mints in block N with hash H1.
      const beforeSend = await rpc<Hex>(client, 'evm_snapshot');
      const sent = await port.register({
        chainId: BASE_SEPOLIA,
        spenderKeyRef: keyRef,
        spender,
        uri,
        operationKey: key,
      });
      assert.equal(sent.status, 'submitted');
      const minted = await port.mintEvidence(ask);
      assert.equal(minted.kind, 'minted');
      if (minted.kind !== 'minted') return;
      assert.equal(minted.status, 'included');
      const oldId = BigInt(minted.id);
      const stored = (await operations.get(key))!;
      staleReceipt = await real.receipt(stored.userOpHash);
      assert.equal(staleReceipt!.txHash, minted.txHash);

      const { h1, h2 } = await reorgAway(client, beforeSend, {
        txHash: minted.txHash,
        blockNumber: BigInt(minted.blockNumber),
      });
      assert.equal(h1, minted.blockHash, 'the evidence named the replaced block');
      t.diagnostic(`block ${minted.blockNumber}: H1 ${h1} replaced by H2 ${h2}, id ${oldId}`);
      // The identity no longer exists on the canonical chain.
      await assert.rejects(
        client.readContract({
          address: registry,
          abi: identityRegistryAbi,
          functionName: 'ownerOf',
          args: [oldId],
        }),
      );

      // Not deep yet, the bundler still answers the old receipt: pending, the node lacks it.
      assert.deepEqual(await port.mintEvidence(ask), {
        kind: 'pending',
        reason: 'RECEIPT_MISSING',
      });
      assert.equal((await operations.get(key))!.status, 'included');

      // Deep enough: the stored operation is reorged (RECEIPT_GONE); still only pending.
      await mine(client, network.confirmations);
      assert.deepEqual(await port.mintEvidence(ask), { kind: 'pending' });
      const gone = (await operations.get(key))!;
      assert.equal(gone.status, 'reorged');
      assert.equal(gone.errorCode, 'RECEIPT_GONE');
      t.diagnostic(`stored operation: ${gone.status}/${gone.errorCode}`);

      // Once the bundler stops answering the stale receipt, still never the old id.
      staleReceipt = null;
      const later = await port.mintEvidence(ask);
      assert.equal(later.kind, 'pending', JSON.stringify(later));
      t.diagnostic(`after the stale receipt stops: ${later.kind}`);
    },
  );
});
