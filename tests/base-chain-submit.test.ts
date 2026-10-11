import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createPublicClient, createWalletClient, http, parseEther, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BASE_SEPOLIA, baseNetwork } from '../shared/base/chains.js';
import { deriveAddress, spenderAccountRecipe } from '../server/base/chain/derive.js';
import { createKeystore, parseKeks, type StoredSpenderKey } from '../server/base/chain/keystore.js';
import { localBundler } from '../server/base/chain/local-bundler.js';
import {
  keystoreSigner,
  refreshFinality,
  submitOperation,
  SubmitError,
  type Bundler,
  type ChainOperationStore,
  type StoredOperation,
} from '../server/base/chain/submit.js';
import { startAtLowBaseFee } from './anvil-fees.js';

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

// Throwaway keys and Anvil-only test ETH on a local fork of Base Sepolia:
//   anvil --fork-url https://sepolia.base.org --port 8546 ; CITY_BASE_ANVIL_URL=http://127.0.0.1:8546
const ANVIL_URL = process.env.CITY_BASE_ANVIL_URL;

test(
  'UserOps: stored before broadcast, retried without double sends, conflicts refused',
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

    // Spender key in the keystore; its smart account sends the operations.
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
    await setBalance(sender, '1'); // no paymaster locally: the account prefunds its own gas

    const bundlerKey = privateKeyToAccount(generatePrivateKey());
    await setBalance(bundlerKey.address, '1');
    const wallet = createWalletClient({ account: bundlerKey, chain, transport: http(ANVIL_URL) });
    const bundler = localBundler({ client, wallet, entryPoint: network.contracts.entryPointV06 });
    let sends = 0;
    const counting: Bundler = { ...bundler, send: async (op) => (sends++, bundler.send(op)) };

    const store = memoryOps();
    const deps = {
      network,
      client,
      store,
      bundler: counting,
      signer: keystoreSigner(client, keystore, keyRef, signer),
    };
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const input = {
      idempotencyKey: 'test:transfer:1',
      intentHash: `0x${'11'.repeat(32)}` as Hex,
      kind: 'transfer' as const,
      account: { address: sender, recipe },
      calls: [{ target: recipient, value: parseEther('0.001'), data: '0x' as Hex }],
    };

    // First submit: deploys the account (initCode) and transfers, in one UserOp.
    const first = await submitOperation(deps, input);
    assert.equal(first.status, 'submitted');
    assert.ok(BigInt(first.maxCostWei) > 0n);
    assert.equal(sends, 1);
    assert.equal(await client.getBalance({ address: recipient }), parseEther('0.001'));
    assert.notEqual(await client.getCode({ address: sender }), undefined);

    // Retry with the same key: reconciles, never sends again, never pays twice.
    const again = await submitOperation(deps, input);
    // The charged fee never exceeds the bound fixed before broadcast.
    assert.ok(
      BigInt(again.feeWei!) <= BigInt(again.maxCostWei),
      `fee ${again.feeWei} > bound ${again.maxCostWei}`,
    );
    assert.equal(again.userOpHash, first.userOpHash);
    assert.equal(again.status, 'included');
    assert.equal(sends, 1);
    assert.equal(await client.getBalance({ address: recipient }), parseEther('0.001'));

    // Fee budget: a cap below the bound refuses before signing; nothing is stored or sent.
    const sendsBefore = sends;
    await assert.rejects(
      submitOperation(deps, {
        ...input,
        idempotencyKey: 'test:transfer:capped',
        intentHash: `0x${'44'.repeat(32)}`,
        maxCostWeiCap: 1n,
      }),
      (e: unknown) => e instanceof SubmitError && e.code === 'COST_CAP_EXCEEDED',
    );
    assert.equal(sends, sendsBefore);
    assert.equal(store.rows.has('test:transfer:capped'), false);

    // Same key, different intent: refused.
    await assert.rejects(
      submitOperation(deps, { ...input, intentHash: `0x${'22'.repeat(32)}` }),
      (e: unknown) => e instanceof SubmitError && e.code === 'IDEMPOTENCY_CONFLICT',
    );

    // Crash after store, before send: the next call rebroadcasts the exact stored operation once.
    const crashing: Bundler = {
      ...counting,
      send: async () => {
        throw new Error('process died');
      },
    };
    const crashed = await submitOperation(
      { ...deps, bundler: crashing },
      { ...input, idempotencyKey: 'test:transfer:2', intentHash: `0x${'33'.repeat(32)}` },
    );
    assert.equal(crashed.status, 'unknown');
    assert.equal(await client.getBalance({ address: recipient }), parseEther('0.001'));
    const recovered = await submitOperation(deps, {
      ...input,
      idempotencyKey: 'test:transfer:2',
      intentHash: `0x${'33'.repeat(32)}`,
    });
    assert.equal(
      recovered.userOpHash,
      crashed.userOpHash,
      'same stored operation, not a rebuilt one',
    );
    assert.equal(await client.getBalance({ address: recipient }), parseEther('0.002'));

    // Finality after the configured confirmations (3 on Sepolia).
    for (let i = 0; i < 3; i++)
      await client.request({ method: 'evm_mine' as never, params: [] as never });
    assert.equal((await refreshFinality(deps, 'test:transfer:1'))?.status, 'final');

    // Race: worker A has stored its operation and is still inside the authority check; worker B
    // retries the same key and runs finality meanwhile. Stored is not authorized: B must not send.
    const gated = (decide: Promise<void>) => ({
      ...input,
      idempotencyKey: 'test:race:1',
      intentHash: `0x${'44'.repeat(32)}` as Hex,
      beforeBroadcast: () => decide,
    });
    let refuse!: () => void;
    const refusal = new Promise<void>((_, reject) => (refuse = () => reject(new Error('frozen'))));
    const sendsBeforeRace = sends;
    const workerA = submitOperation(deps, gated(refusal));
    // Let A store its row first.
    while (!store.rows.has('test:race:1')) await new Promise((r) => setTimeout(r, 10));
    const workerB = await submitOperation(deps, {
      ...gated(new Promise(() => {})),
      beforeBroadcast: undefined,
    });
    assert.equal(workerB.status, 'queued');
    assert.equal((await refreshFinality(deps, 'test:race:1'))?.status, 'queued');
    assert.equal(sends, sendsBeforeRace, 'nothing sent while A is still being checked');
    refuse();
    const refused = await workerA;
    assert.equal(refused.status, 'failed');
    assert.equal(refused.errorCode, 'REFUSED_BEFORE_BROADCAST');
    assert.equal(sends, sendsBeforeRace, 'a refused operation is never sent');

    // Same race, but A passes the check: exactly one broadcast, and B never sends a second time.
    let allow!: () => void;
    const approval = new Promise<void>((resolve) => (allow = resolve));
    const passing = {
      ...gated(approval),
      idempotencyKey: 'test:race:2',
      intentHash: `0x${'55'.repeat(32)}` as Hex,
    };
    const workerA2 = submitOperation(deps, passing);
    while (!store.rows.has('test:race:2')) await new Promise((r) => setTimeout(r, 10));
    assert.equal(
      (await submitOperation(deps, { ...passing, beforeBroadcast: undefined })).status,
      'queued',
    );
    allow();
    assert.equal((await workerA2).status, 'submitted');
    await submitOperation(deps, { ...passing, beforeBroadcast: undefined });
    assert.equal(sends, sendsBeforeRace + 1);
  },
);

test('a slow rebroadcast or receipt result never overwrites a newer settled row', async () => {
  const network = baseNetwork(BASE_SEPOLIA)!;
  const signedOp = {
    sender: `0x${'5'.repeat(40)}`,
    nonce: '3',
    initCode: '0x',
    callData: '0x',
    callGasLimit: '1',
    verificationGasLimit: '1',
    preVerificationGas: '1',
    maxFeePerGas: '1',
    maxPriorityFeePerGas: '1',
    paymasterAndData: '0x',
    signature: '0x99',
  };
  const row = (key: string, status: StoredOperation['status']): StoredOperation => ({
    idempotencyKey: key,
    intentHash: `0x${'11'.repeat(32)}`,
    chainId: BASE_SEPOLIA,
    kind: 'transfer',
    sender: signedOp.sender as Hex,
    signer: `0x${'6'.repeat(40)}`,
    nonce: '3',
    userOpHash: `0x${'aa'.repeat(32)}`,
    signedOperation: JSON.stringify(signedOp),
    status,
    txHash: null,
    blockNumber: null,
    gasUsed: null,
    feeWei: null,
    maxCostWei: '1',
    submittedBlock: '1',
    errorCode: null,
  });
  // The nonce has not moved, so reconcile rebroadcasts; head far above any receipt.
  const client = {
    readContract: async () => 3n,
    getBlockNumber: async () => 100n,
    getBlock: async () => ({ number: 90n }),
  } as never;
  const signer = { address: `0x${'6'.repeat(40)}`, signUserOperation: async () => '0x' } as never;

  // (1) The rebroadcast is slow; meanwhile another worker settles the row as final.
  const store = memoryOps();
  await store.insert(row('k:1', 'unknown'));
  let finish!: () => void;
  const slowSend = new Promise<void>((resolve) => (finish = resolve));
  const bundler = {
    receipt: async () => null,
    send: async () => {
      await slowSend;
      return `0x${'aa'.repeat(32)}` as Hex;
    },
  } as unknown as Bundler;
  const pending = refreshFinality({ network, client, store, bundler, signer }, 'k:1');
  await new Promise((r) => setTimeout(r, 20));
  await store.update('k:1', { status: 'final', txHash: `0x${'bb'.repeat(32)}`, blockNumber: '50' });
  finish();
  assert.equal((await pending)?.status, 'final');
  assert.equal(store.rows.get('k:1')!.status, 'final', 'the newer final row stays final');

  // (2) A receipt lookup is slow; meanwhile the row was settled as failed (nonce consumed).
  await store.insert(row('k:2', 'submitted'));
  let deliver!: () => void;
  const slowReceipt = new Promise<void>((resolve) => (deliver = resolve));
  const late = {
    receipt: async () => {
      await slowReceipt;
      return {
        txHash: `0x${'cc'.repeat(32)}`,
        blockNumber: 60n,
        actualGasUsed: 1n,
        actualGasCost: 1n,
        success: true,
      };
    },
    send: async () => `0x${'aa'.repeat(32)}`,
  } as unknown as Bundler;
  const racing = refreshFinality({ network, client, store, bundler: late, signer }, 'k:2');
  await new Promise((r) => setTimeout(r, 20));
  await store.update('k:2', { status: 'failed', errorCode: 'NONCE_CONSUMED' });
  deliver();
  await racing;
  assert.equal(store.rows.get('k:2')!.status, 'failed', 'a late receipt never revives it');
});

test('finality decided on one receipt never lands on a newer re-inclusion', async () => {
  const network = baseNetwork(BASE_SEPOLIA)!;
  const r1 = { txHash: `0x${'d1'.repeat(32)}` as Hex, blockNumber: 50n };
  const r2 = { txHash: `0x${'d2'.repeat(32)}` as Hex, blockNumber: 60n };
  const store = memoryOps();
  await store.insert({
    idempotencyKey: 'k:r',
    intentHash: `0x${'11'.repeat(32)}`,
    chainId: BASE_SEPOLIA,
    kind: 'transfer',
    sender: `0x${'5'.repeat(40)}`,
    signer: `0x${'6'.repeat(40)}`,
    nonce: '3',
    userOpHash: `0x${'aa'.repeat(32)}`,
    signedOperation: '{}',
    status: 'included',
    txHash: r1.txHash,
    blockNumber: '50',
    gasUsed: '1',
    feeWei: '1',
    maxCostWei: '1',
    submittedBlock: '1',
    errorCode: null,
  });
  const client = {
    readContract: async () => 4n,
    getBlockNumber: async () => 100n,
    getBlock: async () => ({ number: 90n }),
  } as never;
  const signer = { address: `0x${'6'.repeat(40)}`, signUserOperation: async () => '0x' } as never;
  // Worker A: the first receipt read sees R1; the finality read pauses, then still answers R1.
  let calls = 0;
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => (resume = resolve));
  let reachedFinalityRead!: () => void;
  const atFinalityRead = new Promise<void>((resolve) => (reachedFinalityRead = resolve));
  const bundler = {
    receipt: async () => {
      calls++;
      if (calls === 2) {
        reachedFinalityRead();
        await paused;
      }
      return { ...r1, actualGasUsed: 1n, actualGasCost: 1n, success: true };
    },
    send: async () => `0x${'aa'.repeat(32)}`,
  } as unknown as Bundler;
  const workerA = refreshFinality({ network, client, store, bundler, signer }, 'k:r');
  await atFinalityRead;
  // Worker B records a re-inclusion R2 (still included) while A is paused.
  await store.update('k:r', { txHash: r2.txHash, blockNumber: '60' });
  resume();
  await workerA;
  const row = store.rows.get('k:r')!;
  assert.equal(row.status, 'included', 'not stamped final from the old receipt');
  assert.equal(row.txHash, r2.txHash, 'the newer receipt is kept');
});
