import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import {
  createReceiveStore,
  RECEIVE_RECONCILE_SQL,
  RECEIVE_SQL,
} from '../server/base/payments/receive-store.js';
import { createReceiveRuntime } from '../server/base/payments/receive-runtime.js';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseAbi,
  type Abi,
  type TransactionReceipt,
} from 'viem';
import {
  receivePaymentProven,
  readReceiveEvidence,
  type ReceiveEvidence,
} from '../server/base/payments/receive-evidence.js';

test('receive evidence requires final canonical receipt and exact authorization/token binding', async (t) => {
  const binding = {
    workspaceId: 'one',
    resource: 'resource',
    chainId: 84532,
    token: `0x${'1'.repeat(40)}`,
    payer: `0x${'2'.repeat(40)}`,
    recipient: `0x${'3'.repeat(40)}`,
    nonce: `0x${'ab'.repeat(32)}`,
    amount: '10',
  };
  const hash = `0x${'cd'.repeat(32)}` as const;
  const blockHash = `0x${'ef'.repeat(32)}` as const;
  const abi = parseAbi([
    'event Transfer(address indexed from,address indexed to,uint256 value)',
    'event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)',
  ]);
  const common = {
    address: binding.token,
    transactionHash: hash,
    blockHash,
    blockNumber: 10n,
    removed: false,
  };
  const logs = [
    {
      ...common,
      topics: encodeEventTopics({
        abi,
        eventName: 'Transfer',
        args: { from: binding.payer as `0x${string}`, to: binding.recipient as `0x${string}` },
      }),
      data: encodeAbiParameters([{ type: 'uint256' }], [10n]),
    },
    {
      ...common,
      topics: encodeEventTopics({
        abi,
        eventName: 'AuthorizationUsed',
        args: { authorizer: binding.payer as `0x${string}`, nonce: binding.nonce as `0x${string}` },
      }),
      data: '0x',
    },
  ];
  const receipt = {
    to: binding.token,
    transactionHash: hash,
    blockHash,
    blockNumber: 10n,
    status: 'success',
    logs,
  } as unknown as TransactionReceipt;
  const evidence: ReceiveEvidence = {
    chainId: 84532,
    transaction: hash,
    receipt,
    canonicalBlockHash: blockHash,
    finalizedBlock: 10n,
    directCall: {
      hash,
      to: binding.token as `0x${string}`,
      blockHash,
      blockNumber: 10n,
      value: 0n,
      input: encodeFunctionData({
        abi: parseAbi([
          'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)',
        ]),
        functionName: 'transferWithAuthorization',
        args: [
          binding.payer as `0x${string}`,
          binding.recipient as `0x${string}`,
          10n,
          0n,
          100n,
          binding.nonce as `0x${string}`,
          '0x1234',
        ],
      }),
    },
  };
  assert.equal(receivePaymentProven(binding, evidence), true);
  const reads: string[] = [];
  const client = {
    getChainId: async () => 84532,
    getTransactionReceipt: async () => {
      reads.push('receipt');
      return receipt;
    },
    getTransaction: async () => {
      reads.push('transaction');
      return evidence.directCall;
    },
    getBlock: async (args: { blockTag?: string }) => {
      reads.push(args.blockTag ?? 'canonical');
      return { number: 10n, hash: blockHash };
    },
  } as unknown as Parameters<typeof readReceiveEvidence>[0];
  assert.deepEqual(await readReceiveEvidence(client, hash), evidence);
  assert.deepEqual(reads, ['receipt', 'transaction', 'finalized', 'canonical']);
  assert.equal(
    await readReceiveEvidence(
      {
        ...client,
        getBlock: async () => {
          throw new Error('private RPC detail');
        },
      } as typeof client,
      hash,
    ),
    null,
  );

  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators(id text PRIMARY KEY); INSERT INTO operators VALUES ('one');",
  );
  await pg.exec(RECEIVE_SQL);
  await pg.exec(RECEIVE_RECONCILE_SQL);
  const db = {
    query: (sql: string, params: unknown[]) => pg.query(sql, params),
    transaction: (action: (tx: unknown) => unknown) => pg.transaction(action as never),
  } as unknown as Database;
  const store = createReceiveStore(db);
  const claim = await store.claim(binding);
  assert.equal(
    await store.markPaid(binding, claim.receiptId, evidence),
    false,
    'tx must be pinned first',
  );
  assert.equal(await store.reconcile('one', claim.receiptId, hash), true);
  assert.equal(
    await store.markPaid(binding, claim.receiptId, { ...evidence, finalizedBlock: 9n }),
    false,
  );
  assert.equal(
    await store.markPaid({ ...binding, resource: 'another' }, claim.receiptId, evidence),
    false,
  );
  assert.equal(
    await store.markPaid({ ...binding, workspaceId: 'another' }, claim.receiptId, evidence),
    false,
  );
  assert.equal(await store.markPaid(binding, claim.receiptId, evidence), true);
  assert.equal(
    await store.markPaid(binding, claim.receiptId, evidence),
    true,
    'same payment replay is stable',
  );
  assert.equal((await store.claim(binding)).state, 'paid');
  assert.equal((await store.claim(binding)).acquired, false);
  assert.equal(
    await store.reconcile('one', claim.receiptId, blockHash),
    false,
    'paid never regresses',
  );
  await t.test(
    'runtime serializes settlement and resumes durable uncertainty without delivery',
    async () => {
      const next = { ...binding, nonce: `0x${'12'.repeat(32)}` };
      let settlements = 0;
      let deliveries = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const dependencies = {
        store,
        evidence: async () => evidence,
        deliver: async () => {
          deliveries++;
          return 'resource';
        },
      };
      const run = createReceiveRuntime(dependencies);
      const settle = async () => {
        settlements++;
        started();
        await gate;
        return { kind: 'settled' as const, transaction: hash };
      };
      const first = run(next, settle);
      await entered;
      assert.equal((await run(next, settle)).kind, 'pending');
      release();
      assert.equal((await first).kind, 'pending', 'wrong nonce proof cannot deliver');
      assert.equal((await createReceiveRuntime(dependencies)(next, settle)).kind, 'pending');
      assert.equal(settlements, 1);
      assert.equal(deliveries, 0);
      assert.equal((await store.claim(next)).transaction, hash);
      const uncertain = { ...next, nonce: `0x${'34'.repeat(32)}` };
      await run(uncertain, async () => {
        settlements++;
        throw new Error('private provider details');
      });
      await run(uncertain, settle);
      assert.equal(settlements, 2, 'unknown outcome is never resubmitted');
      assert.equal((await store.claim(uncertain)).state, 'reconciling');
      assert.equal((await run(uncertain, settle, true)).kind, 'pending');
      assert.equal(settlements, 2, 'no transaction recovery never settles');
      for (const change of [
        { workspaceId: 'another' },
        { resource: 'another' },
        { recipient: binding.payer },
        { amount: '11' },
      ]) {
        await assert.rejects(store.find({ ...binding, ...change }), /RECEIVE_BINDING_CONFLICT/);
        await assert.rejects(
          run({ ...binding, ...change }, settle, true),
          /RECEIVE_BINDING_CONFLICT/,
        );
      }
      const missing = { ...binding, nonce: `0x${'56'.repeat(32)}` };
      assert.equal(await store.find(missing), null);
      await assert.rejects(run(missing, settle, true), /RECEIVE_CLAIM_NOT_FOUND/);
      assert.equal(await store.find(missing), null, 'reconciliation must never insert');
      assert.equal(settlements, 2);
      assert.equal(
        (await run(next, settle, true)).kind,
        'pending',
        'stored tx with false proof stays pending',
      );
      assert.equal((await run(binding, settle)).kind, 'paid', 'proven durable claim can deliver');
      assert.equal(settlements, 2);
      assert.equal(deliveries, 1);
    },
  );
  const directAbi = parseAbi([
    'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)',
  ]);
  const directArgs = [
    binding.payer as `0x${string}`,
    binding.recipient as `0x${string}`,
    10n,
    0n,
    100n,
    binding.nonce as `0x${string}`,
    '0x1234',
  ] as const;
  for (const functionName of ['transferWithAuthorization', 'receiveWithAuthorization'] as const) {
    for (const signatureType of ['bytes signature', 'uint8 v,bytes32 r,bytes32 s']) {
      const variant: Abi = parseAbi([
        `function ${functionName}(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,${signatureType})`,
      ]);
      const input = encodeFunctionData({
        abi: variant,
        functionName,
        args: [
          ...directArgs.slice(0, 6),
          ...(signatureType === 'bytes signature' ? ['0x1234'] : [27, hash, blockHash]),
        ],
      });
      assert.equal(
        receivePaymentProven(binding, {
          ...evidence,
          directCall: { ...evidence.directCall!, input },
        }),
        true,
        `${functionName} ${signatureType}`,
      );
    }
  }
  for (const change of [
    { removed: true },
    { blockHash: hash },
    { blockNumber: 9n },
    { transactionHash: blockHash },
    { address: binding.payer as `0x${string}` },
  ])
    assert.equal(
      receivePaymentProven(binding, {
        ...evidence,
        receipt: { ...receipt, logs: receipt.logs.map((log) => ({ ...log, ...change })) },
      }),
      false,
      'unrelated or removed logs are not payment evidence',
    );
  for (const args of [
    [binding.recipient, ...directArgs.slice(1)],
    [directArgs[0], binding.payer, ...directArgs.slice(2)],
    [directArgs[0], directArgs[1], 11n, ...directArgs.slice(3)],
    [...directArgs.slice(0, 5), hash, directArgs[6]],
  ]) {
    const input = encodeFunctionData({
      abi: directAbi,
      functionName: 'transferWithAuthorization',
      args: args as unknown as typeof directArgs,
    });
    assert.equal(
      receivePaymentProven(binding, {
        ...evidence,
        directCall: { ...evidence.directCall!, input },
      }),
      false,
      'matching events must not override mismatched calldata',
    );
  }
  for (const change of [
    { receipt: null },
    { transaction: blockHash },
    { finalizedBlock: 9n },
    { finalizedBlock: null },
    { canonicalBlockHash: hash },
    { chainId: 8453 },
    { directCall: null },
  ])
    assert.equal(receivePaymentProven(binding, { ...evidence, ...change }), false);
  for (const change of [{ transactionHash: blockHash }, { to: null }, { blockHash: hash }])
    assert.equal(
      receivePaymentProven(binding, { ...evidence, receipt: { ...receipt, ...change } }),
      false,
    );
  for (const change of [
    { to: binding.payer as `0x${string}` },
    { to: null },
    { input: '0x1234' as const },
    {
      input: encodeFunctionData({
        abi: parseAbi(['function transfer(address to,uint256 value)']),
        functionName: 'transfer',
        args: [binding.recipient as `0x${string}`, 10n],
      }),
    },
    { value: 1n },
    { hash: blockHash },
    { blockHash: hash },
    { blockNumber: null },
    { blockNumber: 11n },
  ])
    assert.equal(
      receivePaymentProven(binding, {
        ...evidence,
        directCall: { ...evidence.directCall!, ...change },
      }),
      false,
    );
  // A router emitting both desired events is not proof of this authorization's transfer.
  assert.equal(
    receivePaymentProven(binding, {
      ...evidence,
      receipt: { ...receipt, to: binding.payer as `0x${string}` },
    }),
    false,
  );
  for (const change of [
    { amount: '11' },
    { nonce: hash },
    { recipient: binding.payer },
    { token: binding.payer },
  ])
    assert.equal(receivePaymentProven({ ...binding, ...change }, evidence), false);
  assert.equal(
    receivePaymentProven(binding, { ...evidence, receipt: { ...receipt, status: 'reverted' } }),
    false,
  );
  assert.equal(
    receivePaymentProven(binding, {
      ...evidence,
      receipt: { ...receipt, logs: receipt.logs.slice(0, 1) },
    }),
    false,
  );
  assert.equal(
    receivePaymentProven(binding, {
      ...evidence,
      receipt: { ...receipt, logs: [...receipt.logs, ...receipt.logs] },
    }),
    false,
  );
});
