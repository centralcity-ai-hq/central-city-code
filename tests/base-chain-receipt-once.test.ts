import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbi,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Hex,
  type PublicClient,
} from 'viem';
import { BASE_SEPOLIA, baseNetwork } from '../shared/base/chains.js';
import { BundlerError } from '../server/base/chain/rpc-bundler.js';
import {
  refreshFinality,
  type Bundler,
  type BundlerReceipt,
  type ChainOperationStore,
  type StoredOperation,
} from '../server/base/chain/submit.js';

/*
 * One refresh (refreshFinality: the owner wallet's withdrawals, identity, payments, revocations)
 * asks the bundler for an operation's receipt at most once: reconcile and the finality check decide
 * on that same answer, never on a second eth_getUserOperationReceipt. Nothing is kept beyond the
 * refresh. Every bundler and chain call is counted; all values are synthetic.
 */

const network = baseNetwork(BASE_SEPOLIA)!;
const OP_HASH = `0x${'aa'.repeat(32)}` as Hex;
const TX = `0x${'cc'.repeat(32)}` as Hex;
const BLOCK_HASH = `0x${'bb'.repeat(32)}` as Hex;
const SENDER = '0x1111111111111111111111111111111111111111';
const userOperationEvent = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);

const signed = JSON.stringify({
  sender: SENDER,
  nonce: '5',
  initCode: '0x',
  callData: '0x',
  callGasLimit: '1',
  verificationGasLimit: '1',
  preVerificationGas: '1',
  maxFeePerGas: '1',
  maxPriorityFeePerGas: '1',
  paymasterAndData: '0x',
  signature: '0x',
});

const stored = (overrides: Partial<StoredOperation> = {}): StoredOperation => ({
  idempotencyKey: 'op:1',
  intentHash: `0x${'11'.repeat(32)}`,
  chainId: BASE_SEPOLIA,
  kind: 'transfer',
  sender: SENDER,
  signer: '0x2222222222222222222222222222222222222222',
  nonce: '5',
  userOpHash: OP_HASH,
  signedOperation: signed,
  status: 'submitted',
  txHash: null,
  blockNumber: null,
  gasUsed: null,
  feeWei: null,
  maxCostWei: '0',
  submittedBlock: '1000',
  errorCode: null,
  ...overrides,
});

const deepIncluded = (overrides: Partial<StoredOperation> = {}) =>
  stored({
    status: 'included',
    txHash: TX,
    blockNumber: '1500',
    gasUsed: '1',
    feeWei: '2',
    ...overrides,
  });

function memoryOps(row: StoredOperation) {
  const rows = new Map([[row.idempotencyKey, { ...row }]]);
  let writes = 0;
  const store: ChainOperationStore = {
    async get(key) {
      return rows.has(key) ? { ...rows.get(key)! } : null;
    },
    async insert(next) {
      if (!rows.has(next.idempotencyKey)) rows.set(next.idempotencyKey, { ...next });
      return { ...rows.get(next.idempotencyKey)! };
    },
    async update(key, patch) {
      writes++;
      rows.set(key, { ...rows.get(key)!, ...patch });
      return { ...rows.get(key)! };
    },
    async transition(key, from, patch) {
      const current = rows.get(key);
      if (!current || !from.includes(current.status)) return null;
      return this.update(key, patch);
    },
  };
  return { store, writes: () => writes };
}

/**
 * A bundler counting every call. Its receipt answers come from `answers` in order (the last one
 * repeats): a second lookup in the same refresh would see a different answer than the first.
 */
function countingBundler(...answers: Array<BundlerReceipt | null | Error>) {
  const calls: string[] = [];
  let i = 0;
  const bundler: Bundler = {
    prepare: async (op) => op,
    send: async () => (calls.push('send'), OP_HASH),
    receipt: async () => {
      calls.push('receipt');
      const answer = answers[Math.min(i++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { bundler, calls, receipts: () => calls.filter((c) => c === 'receipt').length };
}

const receiptAt = (blockNumber: bigint, success = true): BundlerReceipt => ({
  success,
  txHash: TX,
  blockNumber,
  actualGasUsed: 1n,
  actualGasCost: 2n,
});

/** A node (head 2000, settled 1997) counting every read; TX sits in `txBlock` when given. */
function countingChain(
  opts: { head?: bigint; nonce?: bigint; txBlock?: bigint; logBlock?: bigint } = {},
) {
  const head = opts.head ?? 2000n;
  const calls: string[] = [];
  const client = {
    getBlockNumber: async () => (calls.push('blockNumber'), head),
    getBlock: async (args: { blockNumber?: bigint; blockTag?: string } = {}) => {
      calls.push(`getBlock:${args.blockTag ?? args.blockNumber ?? 'latest'}`);
      if (args.blockNumber === undefined) return { number: head - 3n, hash: BLOCK_HASH };
      return { number: args.blockNumber, hash: BLOCK_HASH };
    },
    readContract: async () => (calls.push('getNonce'), opts.nonce ?? 5n),
    getLogs: async (range: { fromBlock: bigint; toBlock: bigint }) => {
      calls.push('getLogs');
      const at = opts.logBlock;
      return at !== undefined && range.fromBlock <= at && at <= range.toBlock
        ? [
            {
              args: { success: true, actualGasUsed: 1n, actualGasCost: 2n },
              transactionHash: TX,
              blockNumber: at,
            },
          ]
        : [];
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      calls.push('getTransactionReceipt');
      if (opts.txBlock === undefined || hash !== TX)
        throw new TransactionReceiptNotFoundError({ hash });
      return {
        transactionHash: TX,
        blockNumber: opts.txBlock,
        blockHash: BLOCK_HASH,
        status: 'success',
        logs: [
          {
            address: network.contracts.entryPointV06,
            topics: encodeEventTopics({
              abi: userOperationEvent,
              eventName: 'UserOperationEvent',
              args: { userOpHash: OP_HASH, sender: SENDER, paymaster: zeroAddress },
            }),
            data: encodeAbiParameters(
              [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
              [5n, true, 1n, 1n],
            ),
            logIndex: 0,
          },
        ],
      };
    },
  } as unknown as PublicClient;
  return { client, calls };
}

const refresh = (client: PublicClient, store: ChainOperationStore, bundler: Bundler) =>
  refreshFinality(
    {
      network,
      client,
      store,
      bundler,
      signer: {
        address: '0x2222222222222222222222222222222222222222' as const,
        signUserOperation: async (): Promise<Hex> => '0x',
      },
    },
    'op:1',
  );

test('an included operation: one receipt lookup per poll (was two), decided as before', async () => {
  // Not deep yet (block 1999, settled 1997): stays included.
  const shallow = memoryOps(deepIncluded({ blockNumber: '1999' }));
  const waits = countingBundler(receiptAt(1999n));
  const row = await refresh(countingChain().client, shallow.store, waits.bundler);
  assert.equal(row?.status, 'included');
  assert.deepEqual(waits.calls, ['receipt']);
  // Deep and confirmed by the chain in the canonical block: final, still one lookup. A second
  // lookup would have answered "no receipt" here.
  const deep = memoryOps(deepIncluded());
  const once = countingBundler(receiptAt(1500n), null);
  const final = await refresh(countingChain({ txBlock: 1500n }).client, deep.store, once.bundler);
  assert.equal(final?.status, 'final');
  assert.deepEqual(once.calls, ['receipt']);
  // The receipt says reverted, the chain's event says success: they disagree, reorged as before.
  const reverted = memoryOps(deepIncluded({ errorCode: 'USEROP_REVERTED' }));
  const revert = countingBundler(receiptAt(1500n, false));
  const out = await refresh(
    countingChain({ txBlock: 1500n }).client,
    reverted.store,
    revert.bundler,
  );
  assert.equal(out?.status, 'reorged');
  assert.deepEqual(revert.calls, ['receipt']);
  // A re-inclusion in another block: recorded, the depth count restarts; one lookup.
  const moved = memoryOps(deepIncluded());
  const elsewhere = countingBundler(receiptAt(1999n));
  const again = await refresh(countingChain().client, moved.store, elsewhere.bundler);
  assert.equal(again?.status, 'included');
  assert.equal(again?.blockNumber, '1999');
  assert.deepEqual(elsewhere.calls, ['receipt']);
});

test('a submitted operation the bundler has a receipt for: recorded and settled on one lookup', async () => {
  const ops = memoryOps(stored());
  const once = countingBundler(receiptAt(1500n), null);
  const row = await refresh(countingChain({ txBlock: 1500n }).client, ops.store, once.bundler);
  // Recorded by reconcile and, deep and canonical, final in the same poll on that same receipt.
  assert.equal(row?.status, 'final');
  assert.equal(row?.blockNumber, '1500');
  assert.deepEqual(once.calls, ['receipt']);
  // Not deep yet: included, one lookup.
  const fresh = memoryOps(stored());
  const shallow = countingBundler(receiptAt(1999n));
  const included = await refresh(countingChain().client, fresh.store, shallow.bundler);
  assert.equal(included?.status, 'included');
  assert.deepEqual(shallow.calls, ['receipt']);
});

test('no receipt (definitive null): the same decisions as before, on one lookup', async () => {
  // Included, the bundler has none and a node at the recorded block finds nothing: reorged.
  const gone = memoryOps(deepIncluded());
  const none = countingBundler(null, receiptAt(1500n));
  const row = await refresh(countingChain().client, gone.store, none.bundler);
  assert.equal(row?.status, 'reorged');
  assert.equal(row?.errorCode, 'RECEIPT_GONE');
  assert.deepEqual(none.calls, ['receipt']);
  // A lagging node (head below the recorded block): never declared gone.
  const lag = memoryOps(deepIncluded({ blockNumber: '2005' }));
  const lagNone = countingBundler(null);
  const kept = await refresh(countingChain().client, lag.store, lagNone.bundler);
  assert.equal(kept?.status, 'included');
  assert.equal(lag.writes(), 0);
  assert.deepEqual(lagNone.calls, ['receipt']);
  // Included, the bundler has none but the chain has our event: read on-chain, final.
  const onChain = memoryOps(deepIncluded());
  const searchNone = countingBundler(null);
  const found = await refresh(
    countingChain({ txBlock: 1500n, logBlock: 1500n }).client,
    onChain.store,
    searchNone.bundler,
  );
  assert.equal(found?.status, 'final');
  assert.deepEqual(searchNone.calls, ['receipt']);
  // Submitted, nonce moved on and our event on-chain: recorded from the search, then final.
  const landed = memoryOps(stored());
  const landedNone = countingBundler(null, receiptAt(1999n));
  const settled = await refresh(
    countingChain({ nonce: 6n, txBlock: 1500n, logBlock: 1500n }).client,
    landed.store,
    landedNone.bundler,
  );
  assert.equal(settled?.status, 'final');
  assert.deepEqual(landedNone.calls, ['receipt']);
  // Submitted, still ours and not in a block: resent (a row without updated_at is never held).
  const waiting = memoryOps(stored());
  const resend = countingBundler(null);
  const sent = await refresh(countingChain().client, waiting.store, resend.bundler);
  assert.equal(sent?.status, 'submitted');
  assert.deepEqual(resend.calls, ['receipt', 'send']);
});

test('a receipt lookup the endpoint cannot answer: the stored row, no further call', async () => {
  for (const before of [stored(), deepIncluded()]) {
    const ops = memoryOps(before);
    const node = countingChain({ txBlock: 1500n });
    const busy = countingBundler(
      new BundlerError('RPC_UNAVAILABLE', 'eth_x: HTTP 429.'),
      receiptAt(1500n),
    );
    const row = await refresh(node.client, ops.store, busy.bundler);
    assert.deepEqual(row, before, before.status);
    assert.equal(ops.writes(), 0);
    assert.deepEqual(busy.calls, ['receipt'], before.status);
    assert.deepEqual(node.calls, [], before.status);
  }
});

test('nothing is kept between polls: every poll asks again', async () => {
  const ops = memoryOps(deepIncluded({ blockNumber: '1999' }));
  const bundler = countingBundler(receiptAt(1999n));
  for (let i = 0; i < 3; i++) await refresh(countingChain().client, ops.store, bundler.bundler);
  assert.equal(bundler.receipts(), 3);
});
