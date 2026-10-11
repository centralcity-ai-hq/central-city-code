import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createPublicClient, createWalletClient, http, parseEther, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BASE_SEPOLIA, NATIVE_ETH, baseNetwork } from '../shared/base/chains.js';
import {
  agentWalletRecipe,
  deriveAddress,
  deriveAddressLocal,
  spenderAccountRecipe,
} from '../server/base/chain/derive.js';
import {
  BatchChainError,
  createBatchChain,
  fenceUnsentBatch,
} from '../server/base/chain/fleet-batch-chain.js';
import { createKeystore, parseKeks, type StoredSpenderKey } from '../server/base/chain/keystore.js';
import { localBundler } from '../server/base/chain/local-bundler.js';
import {
  nonRenewing,
  ownerTypedData,
  permissionHash,
  walletSignature,
} from '../server/base/chain/permissions.js';
import {
  abandonBeforeBroadcast,
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

// The real SpendPermissionManager on an Anvil fork of Base Sepolia (throwaway keys, fork-only ETH):
//   anvil --fork-url https://sepolia.base.org --port 8546 ; CITY_BASE_ANVIL_URL=http://127.0.0.1:8546
const ANVIL_URL = process.env.CITY_BASE_ANVIL_URL;

test(
  'fleet batch: one UserOp pays every agent wallet from the treasury, once',
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

    // Treasury: the owner's wallet [owner, SPM]; its spender from the keystore.
    const keyRows = new Map<string, StoredSpenderKey>();
    const keystore = createKeystore({
      store: {
        insert: async (row) => void keyRows.set(row.keyId, row),
        get: async (id) => keyRows.get(id) ?? null,
      },
      keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
    });
    const { signer, keyRef } = await keystore.createSpenderKey();
    const spender = await deriveAddress(client, spenderAccountRecipe(network, signer));
    const owner = privateKeyToAccount(generatePrivateKey());
    const treasuryRecipe = agentWalletRecipe(network, owner.address, 99n);
    const treasury = deriveAddressLocal(treasuryRecipe);
    await setBalance(treasury, '1');
    await setBalance(spender, '1'); // no paymaster on the fork: the spender prefunds its gas

    const now = Number((await client.getBlock()).timestamp);
    const permission = nonRenewing({
      account: treasury,
      spender,
      token: NATIVE_ETH,
      allowance: parseEther('0.1'),
      start: now - 10,
      end: now + 86_400,
      salt: 7n,
      extraData: '0x',
    });
    const permissionSignature = walletSignature(
      await owner.signTypedData(
        ownerTypedData(BASE_SEPOLIA, treasury, await permissionHash(client, network, permission)),
      ),
      { ownerIndex: 0, undeployedRecipe: treasuryRecipe },
    );

    const bundlerKey = privateKeyToAccount(generatePrivateKey());
    await setBalance(bundlerKey.address, '1');
    const bundler = localBundler({
      client,
      wallet: createWalletClient({ account: bundlerKey, chain, transport: http(ANVIL_URL) }),
      entryPoint: network.contracts.entryPointV06,
    });
    let sends = 0;
    const operations = memoryOps();
    const deps = {
      network,
      client,
      operations,
      bundler: { ...bundler, send: async (op: never) => (sends++, bundler.send(op)) },
      keystore,
      signerOf: async () => signer,
    };
    const batches = createBatchChain(deps);
    const agents = [1n, 2n, 3n].map((i) =>
      deriveAddressLocal(
        agentWalletRecipe(network, privateKeyToAccount(generatePrivateKey()).address, i),
      ),
    );
    const batch = (n: number, overrides = {}) => ({
      operationKey: `fleet:job-1:${n}`,
      intentHash: `0x${String(n).padStart(2, '0').repeat(32)}` as Hex,
      treasury: { wallet: treasury, spender, spenderKeyRef: keyRef },
      permission,
      permissionSignature,
      token: NATIVE_ETH,
      transfers: agents.map((to) => ({ to, amount: parseEther('0.01') })),
      beforeBroadcast: async () => {},
      ...overrides,
    });

    // Batch 0: approve (deploys the treasury) + spend + 3 transfers, in one UserOp. The fleet
    // module is handed the final cost bound before anything is signed or sent.
    const reserved: bigint[] = [];
    const first = await batches.submitBatchTransfer(
      batch(0, {
        reserveCost: async (bound: bigint) => {
          assert.equal(sends, 0, 'reserved before sending');
          reserved.push(bound);
        },
      }),
    );
    assert.equal(reserved.length, 1);
    assert.ok(reserved[0] > 0n);
    assert.equal(first.maxCostWei, reserved[0].toString());
    assert.equal(first.status, 'submitted');
    assert.equal(sends, 1);
    for (const a of agents)
      assert.equal(await client.getBalance({ address: a }), parseEther('0.01'));
    // Retry: reconciled, never sent again.
    await batches.submitBatchTransfer(batch(0));
    assert.equal(sends, 1);
    await mine(3);
    assert.equal(
      (
        await refreshFinality(
          {
            network,
            client,
            store: operations,
            bundler: deps.bundler,
            signer: { address: signer, signUserOperation: async () => '0x' },
          },
          'fleet:job-1:0',
        )
      )?.status,
      'final',
    );

    // Batch 1: the permission is on-chain now, so no approve; the period's spend adds up.
    await batches.submitBatchTransfer(batch(1, { permissionSignature: null }));
    assert.equal(sends, 2);
    for (const a of agents)
      assert.equal(await client.getBalance({ address: a }), parseEther('0.02'));

    // Refused before anything is signed or stored.
    const refused = async (overrides: object, code: string) => {
      await assert.rejects(
        batches.submitBatchTransfer(batch(9, overrides)),
        (e: unknown) => e instanceof BatchChainError && e.code === code,
      );
      assert.equal(await operations.get('fleet:job-1:9'), null);
    };
    await refused({ transfers: [{ to: agents[0], amount: parseEther('0.2') }] }, 'OVER_ALLOWANCE');
    await refused({ transfers: [] }, 'INVALID_BATCH');
    await refused(
      {
        transfers: [
          { to: agents[0], amount: 1n },
          { to: agents[0], amount: 1n },
        ],
      },
      'INVALID_BATCH',
    );
    await refused({ token: network.tokens.USDC.address }, 'NO_PERMISSION');
    await refused(
      { treasury: { wallet: treasury, spender: agents[0], spenderKeyRef: keyRef } },
      'NO_PERMISSION',
    );
    assert.equal(sends, 2);

    // The fee reservation fails (cap reached): refused before signing; nothing stored or sent.
    await assert.rejects(
      batches.submitBatchTransfer(
        batch(4, {
          permissionSignature: null,
          reserveCost: async () => {
            throw new Error('fee budget exhausted');
          },
        }),
      ),
      /fee budget exhausted/,
    );
    assert.equal(await operations.get('fleet:job-1:4'), null);
    assert.equal(sends, 2);

    // Recovery versus a delayed submit: the submit is paused inside reserveCost (after the hold,
    // before its durable insert). Recovery fences the key with a tombstone, so releasing the holds is
    // safe; when the submit resumes it finds the tombstone and never sends.
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    let inHook!: () => void;
    const reached = new Promise<void>((resolve) => (inHook = resolve));
    const delayed = batches.submitBatchTransfer(
      batch(5, {
        permissionSignature: null,
        reserveCost: async () => {
          inHook();
          await paused;
        },
      }),
    );
    await reached;
    assert.equal(await operations.get('fleet:job-1:5'), null, 'no op row yet');
    const fence = await fenceUnsentBatch(operations, {
      operationKey: 'fleet:job-1:5',
      intentHash: batch(5).intentHash,
      chainId: BASE_SEPOLIA,
    });
    assert.equal(fence.fenced, true);
    resume();
    const late = await delayed;
    assert.equal(late.status, 'failed');
    assert.equal(late.errorCode, 'ABANDONED_BEFORE_BROADCAST');
    assert.equal(sends, 2, 'the delayed submit never sends');
    // A batch that was really stored first can never be fenced, so nothing may be released.
    assert.equal(
      (
        await fenceUnsentBatch(operations, {
          operationKey: 'fleet:job-1:0',
          intentHash: batch(0).intentHash,
          chainId: BASE_SEPOLIA,
        })
      ).fenced,
      false,
    );

    // The fleet module's authority check refuses right before the first broadcast: never sent.
    const stopped = await batches.submitBatchTransfer(
      batch(3, {
        permissionSignature: null,
        beforeBroadcast: async () => {
          throw new Error('run expired');
        },
      }),
    );
    assert.equal(stopped.status, 'failed');
    assert.equal(stopped.errorCode, 'REFUSED_BEFORE_BROADCAST');
    assert.equal(sends, 2);
  },
);

test('fleet batch: mainnet needs a fee budget', async () => {
  const mainnet = baseNetwork(8453, { CITY_BASE_MAINNET: '1' })!;
  const batches = createBatchChain({
    network: mainnet,
    operations: { get: async () => null },
  } as never);
  await assert.rejects(
    batches.submitBatchTransfer({ operationKey: 'k' } as never),
    (e: unknown) => e instanceof BatchChainError && e.code === 'FEE_BUDGET_REQUIRED',
  );
});

test('fence: a matching tombstone fences (idempotently); a mismatched one never does', async () => {
  const operations = memoryOps();
  const key = 'fleet:job-9:0';
  const intentHash = `0x${'aa'.repeat(32)}` as Hex;
  const fence = (overrides = {}) =>
    fenceUnsentBatch(operations, {
      operationKey: key,
      intentHash,
      chainId: BASE_SEPOLIA,
      ...overrides,
    });
  assert.equal((await fence()).fenced, true);
  assert.equal((await fence()).fenced, true, 'repeating the fence is idempotent');
  assert.equal((await fence({ intentHash: `0x${'bb'.repeat(32)}` })).fenced, false);
  assert.equal((await fence({ chainId: 8453 })).fenced, false);
  // A tombstone written for another kind of operation under the same key does not fence a batch.
  const other = memoryOps();
  await abandonBeforeBroadcast(other, {
    idempotencyKey: key,
    intentHash,
    chainId: BASE_SEPOLIA,
    kind: 'transfer',
  });
  assert.equal(
    (await fenceUnsentBatch(other, { operationKey: key, intentHash, chainId: BASE_SEPOLIA }))
      .fenced,
    false,
  );
});

test('fleet batch: a stored row for another intent, network or kind is refused, unread', async () => {
  const network = baseNetwork(BASE_SEPOLIA)!;
  const key = 'fleet:job-7:0';
  const intentHash = `0x${'aa'.repeat(32)}` as Hex;
  const noChain = new Proxy(
    {},
    {
      get() {
        throw new Error('no receipt lookup expected');
      },
    },
  );
  const refused = async (row: { intentHash: Hex; chainId: number; kind: 'batch' | 'transfer' }) => {
    const operations = memoryOps();
    await abandonBeforeBroadcast(operations, { idempotencyKey: key, ...row });
    const batches = createBatchChain({ network, client: noChain, operations } as never);
    await assert.rejects(
      batches.submitBatchTransfer({ operationKey: key, intentHash } as never),
      (e: unknown) => e instanceof BatchChainError && e.code === 'IDEMPOTENCY_CONFLICT',
    );
  };
  await refused({ intentHash: `0x${'bb'.repeat(32)}`, chainId: BASE_SEPOLIA, kind: 'batch' });
  await refused({ intentHash, chainId: 8453, kind: 'batch' });
  await refused({ intentHash, chainId: BASE_SEPOLIA, kind: 'transfer' });
});
