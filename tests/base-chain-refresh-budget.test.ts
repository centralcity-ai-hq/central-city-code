import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hex, PublicClient } from 'viem';
import { BASE_SEPOLIA, baseNetwork, type Address } from '../shared/base/chains.js';
import { BundlerError, bundlerRejection, rpcBundler } from '../server/base/chain/rpc-bundler.js';
import {
  receiptLookupNotNow,
  REBROADCAST_MIN_MS,
  refreshFinality,
  submitOperation,
  type Bundler,
  type BundlerReceipt,
  type ChainOperationStore,
  type StoredOperation,
} from '../server/base/chain/submit.js';

/*
 * The CDP endpoint's call budget in reconcile/refreshFinality (submit.ts): a receipt lookup the
 * endpoint cannot answer right now ends the refresh with the stored row and no further call, and a
 * stored operation still waiting for its block is resent at most once per REBROADCAST_MIN_MS.
 * Every chain read, bundler call and store write is counted; all values are synthetic.
 */

const network = baseNetwork(BASE_SEPOLIA)!;
const OP_HASH = `0x${'aa'.repeat(32)}` as Hex;
const TX = `0x${'cc'.repeat(32)}` as Hex;
const T0 = 1_760_000_000_000;

const signed = JSON.stringify({
  sender: '0x1111111111111111111111111111111111111111',
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
  sender: '0x1111111111111111111111111111111111111111',
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
  updatedAt: T0,
  ...overrides,
});

/** A store that stamps updatedAt with the test clock on every write, as the Postgres one does. */
function memoryOps(row: StoredOperation, clock: () => number) {
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
      rows.set(key, { ...rows.get(key)!, ...patch, updatedAt: clock() });
      return { ...rows.get(key)! };
    },
    async transition(key, from, patch) {
      const current = rows.get(key);
      if (!current || !from.includes(current.status)) return null;
      return this.update(key, patch);
    },
    async claimSend(key, status, seenUpdatedAt, at) {
      const current = rows.get(key);
      if (!current || current.status !== status || current.updatedAt !== seenUpdatedAt) return null;
      writes++;
      rows.set(key, { ...current, updatedAt: Math.max(at, seenUpdatedAt + 1) });
      return { ...rows.get(key)! };
    },
  };
  return { store, row: () => ({ ...rows.get(row.idempotencyKey)! }), writes: () => writes };
}

/** A node that counts every read; its nonce for our lane is `nonce` (5 = still ours). */
function countingChain(opts: { head?: bigint; nonce?: bigint } = {}) {
  const calls: string[] = [];
  const client = {
    getBlockNumber: async () => (calls.push('blockNumber'), opts.head ?? 2000n),
    getBlock: async (args: { blockNumber?: bigint; blockTag?: string } = {}) => {
      calls.push(`getBlock:${args.blockTag ?? args.blockNumber ?? 'latest'}`);
      return { number: (opts.head ?? 2000n) - 3n, hash: `0x${'bb'.repeat(32)}` };
    },
    readContract: async () => (calls.push('getNonce'), opts.nonce ?? 5n),
    getLogs: async () => (calls.push('getLogs'), []),
    getTransactionReceipt: async () => {
      calls.push('getTransactionReceipt');
      throw new Error('not expected');
    },
  } as unknown as PublicClient;
  return { client, calls };
}

/** A bundler whose receipt lookup answers `receipt` (or throws it), counting every call. */
function countingBundler(receipt: () => Promise<BundlerReceipt | null>) {
  const calls: string[] = [];
  const bundler: Bundler = {
    prepare: async (op) => op,
    send: async () => (calls.push('send'), OP_HASH),
    receipt: async () => (calls.push('receipt'), receipt()),
  };
  return { bundler, calls };
}

const deps = (
  client: PublicClient,
  store: ChainOperationStore,
  bundler: Bundler,
  now: () => number,
) => ({
  network,
  client,
  store,
  bundler,
  now,
  signer: {
    address: '0x2222222222222222222222222222222222222222' as Address,
    signUserOperation: async (): Promise<Hex> => '0x',
  },
});

/** What the endpoint answers while it throttles, as each layer reports it. */
const NOT_NOW: Array<[string, () => Error]> = [
  ['rpc-bundler HTTP 429', () => new BundlerError('RPC_UNAVAILABLE', 'eth_x: HTTP 429.')],
  ['rpc-bundler unreachable', () => new BundlerError('RPC_UNAVAILABLE', 'eth_x: not reachable.')],
  [
    'JSON-RPC limit exceeded',
    () => bundlerRejection('eth_getUserOperationReceipt', { code: -32005, message: 'slow down' }),
  ],
  ['HTTP status 503', () => Object.assign(new Error('upstream'), { status: 503 })],
  ['timeout', () => Object.assign(new Error('took too long'), { name: 'TimeoutError' })],
];

test('a receipt lookup the endpoint cannot answer: the stored row, no other call, no write', async () => {
  const included = {
    status: 'included' as const,
    txHash: TX,
    blockNumber: '1500',
    gasUsed: '1',
    feeWei: '2',
  };
  const shapes: Array<Partial<StoredOperation>> = [
    {},
    { status: 'unknown', errorCode: 'BROADCAST_AMBIGUOUS', updatedAt: T0 - REBROADCAST_MIN_MS },
    { status: 'reorged', errorCode: 'RECEIPT_GONE' },
    { status: 'reconciling', errorCode: 'NONCE_CONSUMED' },
    included,
    { ...included, errorCode: 'USEROP_REVERTED' },
  ];
  for (const [name, error] of NOT_NOW)
    for (const shape of shapes) {
      const where = `${name} / ${shape.status ?? 'submitted'}`;
      const before = stored(shape);
      const ops = memoryOps(before, () => T0);
      const node = countingChain({ nonce: 6n });
      const bundler = countingBundler(async () => {
        throw error();
      });
      const row = await refreshFinality(
        deps(node.client, ops.store, bundler.bundler, () => T0),
        'op:1',
      );
      assert.deepEqual(row, before, where);
      assert.deepEqual(ops.row(), before, where);
      assert.equal(ops.writes(), 0, `${where}: nothing written`);
      assert.deepEqual(bundler.calls, ['receipt'], `${where}: no send`);
      assert.deepEqual(node.calls, [], `${where}: no nonce, head, log or block read`);
    }
});

test('the same holds for a retried submit of a stored key (reconcile)', async () => {
  const before = stored({ updatedAt: T0 - 10 * REBROADCAST_MIN_MS });
  const ops = memoryOps(before, () => T0);
  const node = countingChain();
  const bundler = countingBundler(async () => {
    throw new BundlerError('RPC_UNAVAILABLE', 'eth_x: HTTP 429.');
  });
  const row = await submitOperation(
    deps(node.client, ops.store, bundler.bundler, () => T0),
    {
      idempotencyKey: 'op:1',
      intentHash: before.intentHash,
      kind: 'transfer',
      account: { address: before.sender, recipe: undefined as never },
      calls: [{ target: before.sender, value: 0n, data: '0x' }],
    },
  );
  assert.deepEqual(row, before);
  assert.deepEqual(bundler.calls, ['receipt']);
  assert.deepEqual(node.calls, []);
});

test('the endpoint answering 429 over HTTP is classified "not now" end to end', async () => {
  const bundler = rpcBundler({
    url: 'https://bundler.invalid/key',
    entryPoint: network.contracts.entryPointV06,
    chainId: BASE_SEPOLIA,
    client: {} as PublicClient,
    maxFeePerGasCap: 1n,
    stubSignature: '0x',
    fetch: async () => new Response('Too Many Requests', { status: 429 }),
  });
  const error = await bundler.receipt(OP_HASH).then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof BundlerError);
  assert.equal(receiptLookupNotNow(error), true);
  assert.equal(String((error as Error).message).includes('bundler.invalid'), false, 'no URL');
});

test('only a definitive answer goes on: no receipt reads the nonce and resends; a malformed one too', async () => {
  // Definitively no receipt (null): as before, the nonce is read and the operation resent.
  const ops = memoryOps(stored({ updatedAt: T0 - REBROADCAST_MIN_MS }), () => T0);
  const node = countingChain();
  const none = countingBundler(async () => null);
  const row = await refreshFinality(
    deps(node.client, ops.store, none.bundler, () => T0),
    'op:1',
  );
  assert.equal(row?.status, 'submitted');
  assert.deepEqual(none.calls, ['receipt', 'send']);
  assert.ok(node.calls.includes('getNonce'));
  // Not a "not now" (an answer the bundler got wrong): unchanged from before, the chain is asked.
  assert.equal(receiptLookupNotNow(new BundlerError('BAD_RESPONSE', 'invalid receipt')), false);
  assert.equal(
    receiptLookupNotNow(bundlerRejection('eth_x', { code: -32602, message: 'bad' })),
    false,
  );
  const odd = memoryOps(stored({ updatedAt: T0 - REBROADCAST_MIN_MS }), () => T0);
  const oddNode = countingChain();
  const malformed = countingBundler(async () => {
    throw new BundlerError('BAD_RESPONSE', 'invalid receipt');
  });
  await refreshFinality(
    deps(oddNode.client, odd.store, malformed.bundler, () => T0),
    'op:1',
  );
  assert.ok(oddNode.calls.includes('getNonce'));
  assert.deepEqual(malformed.calls, ['receipt', 'send']);
});

test('a submitted operation not yet in a block is resent at most once per REBROADCAST_MIN_MS', async () => {
  let now = T0;
  // Sent (claimed) at T0.
  const ops = memoryOps(stored({ updatedAt: T0 }), () => now);
  const node = countingChain();
  const bundler = countingBundler(async () => null);
  const refresh = () =>
    refreshFinality(
      deps(node.client, ops.store, bundler.bundler, () => now),
      'op:1',
    );
  const sends = () => bundler.calls.filter((call) => call === 'send').length;
  // A reader polling every 2.5 s for the whole window: no resend, the row as stored.
  for (; now < T0 + REBROADCAST_MIN_MS; now += 2_500) {
    const row = await refresh();
    assert.equal(row?.status, 'submitted');
    assert.equal(row?.updatedAt, T0);
  }
  assert.equal(sends(), 0);
  assert.equal(ops.writes(), 0);
  // The window is over: one resend, stamped; the next window starts there.
  now = T0 + REBROADCAST_MIN_MS;
  await refresh();
  assert.equal(sends(), 1);
  assert.equal(ops.row().updatedAt, now);
  for (let i = 0; i < 10; i++) {
    now += 2_500;
    await refresh();
  }
  assert.equal(sends(), 1, 'still one within the second window');
  now = T0 + 2 * REBROADCAST_MIN_MS;
  await refresh();
  assert.equal(sends(), 2);
  // The nonce is still read on every poll: a landing the bundler has not indexed is never missed.
  assert.ok(node.calls.filter((call) => call === 'getNonce').length > 20);
});

test('the throttle never holds back what it must not: a landing, a consumed nonce, a dropped block, an older store', async () => {
  // In a block meanwhile: recorded at once, within the window.
  const landed = memoryOps(stored({ updatedAt: T0 }), () => T0);
  const receipt = countingBundler(async () => ({
    success: true,
    txHash: TX,
    blockNumber: 1999n,
    actualGasUsed: 1n,
    actualGasCost: 2n,
  }));
  const row = await refreshFinality(
    deps(countingChain().client, landed.store, receipt.bundler, () => T0 + 1),
    'op:1',
  );
  assert.equal(row?.status, 'included');
  // The nonce moved on (here at every block, and no event of ours anywhere): decided as before,
  // within the window, never sent.
  const consumed = memoryOps(stored({ updatedAt: T0 }), () => T0);
  const noResend = countingBundler(async () => null);
  const moved = await refreshFinality(
    deps(countingChain({ nonce: 6n }).client, consumed.store, noResend.bundler, () => T0 + 1),
    'op:1',
  );
  assert.equal(moved?.status, 'failed');
  assert.deepEqual(noResend.calls, ['receipt']);
  assert.equal(moved?.errorCode, 'NONCE_CONSUMED');
  // A dropped block ('reorged', just written): resent at once.
  const dropped = memoryOps(
    stored({ status: 'reorged', errorCode: 'RECEIPT_GONE', updatedAt: T0 }),
    () => T0,
  );
  const resend = countingBundler(async () => null);
  const again = await refreshFinality(
    deps(countingChain().client, dropped.store, resend.bundler, () => T0 + 1),
    'op:1',
  );
  assert.equal(again?.status, 'submitted');
  assert.deepEqual(resend.calls, ['receipt', 'send']);
  // A store that keeps no write time: never held back.
  const untimed = memoryOps(stored({ updatedAt: undefined }), () => T0);
  const plain = countingBundler(async () => null);
  await refreshFinality(
    deps(countingChain().client, untimed.store, plain.bundler, () => T0),
    'op:1',
  );
  assert.deepEqual(plain.calls, ['receipt', 'send']);
  // A send that failed ('unknown': the bundler may not have it) is retried on the next poll.
  const failed = memoryOps(
    stored({ status: 'unknown', errorCode: 'BROADCAST_AMBIGUOUS', updatedAt: T0 }),
    () => T0,
  );
  const retry = countingBundler(async () => null);
  const sent = await refreshFinality(
    deps(countingChain().client, failed.store, retry.bundler, () => T0 + 1),
    'op:1',
  );
  assert.deepEqual(retry.calls, ['receipt', 'send']);
  assert.equal(sent?.status, 'submitted');
});

test('two readers racing on the same stored updated_at send once (in-memory store)', async () => {
  const at = T0 + REBROADCAST_MIN_MS;
  const ops = memoryOps(stored({ updatedAt: T0 }), () => at);
  // Both lookups wait for each other: both readers hold the same snapshot before either sends.
  let waiting = 0;
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  const sends: string[] = [];
  const bundler: Bundler = {
    prepare: async (op) => op,
    send: async () => (sends.push('send'), OP_HASH),
    receipt: async () => {
      if (++waiting >= 2) open();
      await gate;
      return null;
    },
  };
  const rows = await Promise.all([
    refreshFinality(
      deps(countingChain().client, ops.store, bundler, () => at),
      'op:1',
    ),
    refreshFinality(
      deps(countingChain().client, ops.store, bundler, () => at),
      'op:1',
    ),
  ]);
  assert.equal(sends.length, 1, 'one eth_sendUserOperation');
  for (const row of rows) assert.equal(row?.status, 'submitted');
  assert.equal(ops.row().updatedAt, at);
});

test('a clock behind a submitted row never resends until it passes updated_at + the window', async () => {
  // Claimed by another instance whose clock runs a minute ahead of this reader's.
  const ahead = T0 + 60_000;
  const ops = memoryOps(stored({ updatedAt: ahead }), () => T0);
  const bundler = countingBundler(async () => null);
  const sends = () => bundler.calls.filter((call) => call === 'send').length;
  const poll = (now: number) =>
    refreshFinality(
      deps(countingChain().client, ops.store, bundler.bundler, () => now),
      'op:1',
    );
  // Two sequential fresh reads at a fixed time behind the stored timestamp: nothing sent, nothing
  // written, the row as stored.
  for (let i = 0; i < 2; i++) {
    const row = await poll(T0);
    assert.equal(row?.status, 'submitted');
    assert.equal(row?.updatedAt, ahead);
  }
  // Still behind updated_at + the window: nothing.
  await poll(ahead + REBROADCAST_MIN_MS - 1);
  assert.equal(sends(), 0);
  assert.equal(ops.writes(), 0);
  // Its clock passes updated_at + the window: exactly one send, then the next window.
  await poll(ahead + REBROADCAST_MIN_MS);
  assert.equal(sends(), 1);
  await poll(ahead + REBROADCAST_MIN_MS);
  await poll(ahead + REBROADCAST_MIN_MS + 1_000);
  assert.equal(sends(), 1);
});
