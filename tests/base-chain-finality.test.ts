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
import {
  abandonBeforeBroadcast,
  refreshFinality,
  SEARCH_PAGES_PER_REFRESH,
  type Bundler,
  type BundlerReceipt,
  type ChainOperationStore,
  type StoredOperation,
} from '../server/base/chain/submit.js';
import { MAX_LOG_RANGE_BLOCKS } from '../server/base/chain/rpc-budget.js';
import { BundlerError } from '../server/base/chain/rpc-bundler.js';

const network = baseNetwork(BASE_SEPOLIA)!;

function memoryOps(
  rows: StoredOperation[] = [],
): ChainOperationStore & { rows: Map<string, StoredOperation> } {
  const map = new Map(rows.map((r) => [r.idempotencyKey, { ...r }]));
  return {
    rows: map,
    async get(key) {
      return map.has(key) ? { ...map.get(key)! } : null;
    },
    async insert(row) {
      if (!map.has(row.idempotencyKey)) map.set(row.idempotencyKey, { ...row });
      return { ...map.get(row.idempotencyKey)! };
    },
    async update(key, patch) {
      map.set(key, { ...map.get(key)!, ...patch });
      return { ...map.get(key)! };
    },
    async transition(key, from, patch) {
      const row = map.get(key);
      if (!row || !from.includes(row.status)) return null;
      return this.update(key, patch);
    },
  };
}

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
const consumed = (overrides: Partial<StoredOperation> = {}): StoredOperation => ({
  idempotencyKey: 'op:1',
  intentHash: `0x${'11'.repeat(32)}`,
  chainId: BASE_SEPOLIA,
  kind: 'transfer',
  sender: '0x1111111111111111111111111111111111111111',
  signer: '0x2222222222222222222222222222222222222222',
  nonce: '5',
  userOpHash: OP_HASH,
  signedOperation: signed,
  status: 'reconciling',
  txHash: null,
  blockNumber: null,
  gasUsed: null,
  feeWei: null,
  maxCostWei: '0',
  submittedBlock: '1000',
  errorCode: 'NONCE_CONSUMED',
  ...overrides,
});

const noReceipts: Bundler = {
  prepare: async (op) => op,
  send: async () => {
    throw new Error('must not send');
  },
  receipt: async () => null,
};

const OP_HASH = `0x${'aa'.repeat(32)}` as Hex;
const TX = `0x${'cc'.repeat(32)}` as Hex;
const BLOCK_HASH = `0x${'bb'.repeat(32)}` as Hex;
const userOperationEvent = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);

/** What the node holds for TX: its receipt (block, hash, our operation's outcome), or an Error. */
type TxOnChain =
  | {
      blockNumber: bigint;
      blockHash?: Hex;
      success?: boolean;
      /** What the node answers as the receipt's transaction, sender and nonce (default: ours). */
      transactionHash?: Hex;
      sender?: Hex;
      nonce?: bigint;
    }
  | Error;

/** A simulated chain: head, nonce now and at a given block, the logs and the receipt of TX. */
function chain(opts: {
  head: bigint;
  nonceLatest: bigint;
  nonceAt: (block: bigint) => bigint;
  logs?: (range: { fromBlock: bigint; toBlock: bigint }) => unknown[];
  /** The receipt of TX; by default the node has none. */
  tx?: TxOnChain;
  /** The hash of the canonical block at a height, or an Error when that read fails. */
  canonical?: Hex | Error;
}) {
  return {
    getBlockNumber: async () => opts.head,
    getBlock: async (args: { blockNumber?: bigint } = {}) => {
      if (args.blockNumber === undefined) return { number: opts.head - 3n };
      if (opts.canonical instanceof Error) throw opts.canonical;
      return { number: args.blockNumber, hash: opts.canonical ?? BLOCK_HASH };
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (opts.tx instanceof Error) throw opts.tx;
      if (!opts.tx || hash !== TX) throw new TransactionReceiptNotFoundError({ hash });
      return {
        transactionHash: opts.tx.transactionHash ?? TX,
        blockNumber: opts.tx.blockNumber,
        blockHash: opts.tx.blockHash ?? BLOCK_HASH,
        status: 'success',
        logs: [
          {
            address: network.contracts.entryPointV06,
            topics: encodeEventTopics({
              abi: userOperationEvent,
              eventName: 'UserOperationEvent',
              args: {
                userOpHash: OP_HASH,
                sender: opts.tx.sender ?? '0x1111111111111111111111111111111111111111',
                paymaster: zeroAddress,
              },
            }),
            data: encodeAbiParameters(
              [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
              [opts.tx.nonce ?? 5n, opts.tx.success ?? true, 1n, 1n],
            ),
            logIndex: 0,
          },
        ],
      };
    },
    readContract: async (args: { blockNumber?: bigint }) =>
      args.blockNumber === undefined ? opts.nonceLatest : opts.nonceAt(args.blockNumber),
    getLogs: async (range: { fromBlock: bigint; toBlock: bigint }) =>
      opts.logs ? opts.logs(range) : [],
  } as unknown as PublicClient;
}

const deps = (client: PublicClient, store: ChainOperationStore, bundler = noReceipts) => ({
  network,
  client,
  store,
  bundler,
  signer: {
    address: '0x2222222222222222222222222222222222222222' as const,
    signUserOperation: async (): Promise<Hex> => '0x',
  },
});

test('nonce consumed + complete settled absence → failed', async () => {
  const store = memoryOps([consumed()]);
  const row = await refreshFinality(
    deps(chain({ head: 2000n, nonceLatest: 6n, nonceAt: () => 6n }), store),
    'op:1',
  );
  assert.equal(row?.status, 'failed');
});

test('a failing log lookup never concludes absence (stays reconciling)', async () => {
  const store = memoryOps([consumed()]);
  const client = chain({
    head: 2000n,
    nonceLatest: 6n,
    nonceAt: () => 6n,
    logs: () => {
      throw new Error('rpc down');
    },
  });
  assert.equal((await refreshFinality(deps(client, store), 'op:1'))?.status, 'reconciling');
});

test('the on-chain search pages at most 1,000 blocks per getLogs call and covers every block', async () => {
  const store = memoryOps([consumed({ submittedBlock: '10' })]);
  const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  const client = chain({
    head: 3_000n,
    nonceLatest: 6n,
    nonceAt: () => 6n,
    logs: (range) => {
      ranges.push(range);
      // As the endpoint answers a wider range: refused (and the whole lookup is then unknown).
      if (range.toBlock - range.fromBlock + 1n > MAX_LOG_RANGE_BLOCKS)
        throw new Error('block range too large');
      return [];
    },
  });
  assert.equal((await refreshFinality(deps(client, store), 'op:1'))?.status, 'failed');
  assert.ok(ranges.length > 1, 'paged');
  assert.equal(ranges[0].fromBlock, 10n);
  for (const [i, range] of ranges.entries()) {
    assert.ok(range.toBlock - range.fromBlock + 1n <= MAX_LOG_RANGE_BLOCKS);
    // Each search starts again at the submission block; within one, pages follow without a gap.
    if (i > 0 && range.fromBlock !== 10n)
      assert.equal(range.fromBlock, ranges[i - 1].toBlock + 1n, 'no gap, no overlap');
  }
});

/** memoryOps plus the search cursor, as the Postgres store keeps it (never moved back). */
function cursorOps(rows: StoredOperation[]) {
  const store = memoryOps(rows);
  const writes: Array<string | null> = [];
  return Object.assign(store, {
    writes,
    async recordSearched(key: string, block: string | null) {
      writes.push(block);
      const row = store.rows.get(key)!;
      const kept = row.searchedBlock ? BigInt(row.searchedBlock) : null;
      const next =
        block === null ? null : kept !== null && kept > BigInt(block) ? kept : BigInt(block);
      store.rows.set(key, { ...row, searchedBlock: next === null ? null : next.toString(10) });
    },
  });
}

test('one refresh asks for at most SEARCH_PAGES_PER_REFRESH getLogs pages, however old the op', async () => {
  // A day and more of Base blocks since submission: before, every refresh paged all of it.
  const store = cursorOps([consumed({ submittedBlock: '10' })]);
  const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  let calls = 0;
  const client = chain({
    head: 50_000n,
    nonceLatest: 6n,
    nonceAt: () => 6n,
    logs: (range) => {
      calls++;
      ranges.push(range);
      return [];
    },
  });
  const settled = 50_000n - 3n;
  const pages = Number((settled - 10n) / MAX_LOG_RANGE_BLOCKS) + 1;
  const refreshes = Math.ceil(pages / SEARCH_PAGES_PER_REFRESH);
  for (let i = 1; i < refreshes; i++) {
    const before = calls;
    const row = await refreshFinality(deps(client, store), 'op:1');
    assert.ok(calls - before <= SEARCH_PAGES_PER_REFRESH, `refresh ${i}: ${calls - before} calls`);
    assert.equal(calls - before, SEARCH_PAGES_PER_REFRESH);
    // Nothing concluded from a search that has not covered every block yet.
    assert.equal(row?.status, 'reconciling', `refresh ${i}`);
    assert.equal(
      store.rows.get('op:1')!.searchedBlock,
      (10n + BigInt(i * SEARCH_PAGES_PER_REFRESH) * MAX_LOG_RANGE_BLOCKS - 1n).toString(10),
      'the cursor moves on by the pages searched',
    );
  }
  // The last refresh covers the rest and only then concludes; the cursor is cleared.
  const before = calls;
  assert.equal((await refreshFinality(deps(client, store), 'op:1'))?.status, 'failed');
  assert.ok(calls - before <= SEARCH_PAGES_PER_REFRESH);
  assert.equal(calls, pages, 'every page asked for exactly once over all refreshes');
  assert.equal(store.rows.get('op:1')!.searchedBlock, null);
  // Every block from the submission to the settled head, without a gap or an overlap.
  assert.equal(ranges[0].fromBlock, 10n);
  assert.equal(ranges.at(-1)!.toBlock, settled);
  for (let i = 1; i < ranges.length; i++)
    assert.equal(ranges[i].fromBlock, ranges[i - 1].toBlock + 1n, 'no gap, no overlap');
});

test('a resumed search still finds an event far past the first refresh, and clears the cursor', async () => {
  const store = cursorOps([consumed({ submittedBlock: '10' })]);
  let calls = 0;
  const client = chain({
    head: 50_000n,
    nonceLatest: 6n,
    nonceAt: () => 6n,
    tx: { blockNumber: 7_500n },
    logs: ({ fromBlock, toBlock }) => {
      calls++;
      return fromBlock <= 7_500n && 7_500n <= toBlock
        ? [
            {
              args: { success: true, actualGasUsed: 1n, actualGasCost: 2n },
              transactionHash: TX,
              blockNumber: 7_500n,
            },
          ]
        : [];
    },
  });
  assert.equal((await refreshFinality(deps(client, store), 'op:1'))?.status, 'reconciling');
  assert.equal((await refreshFinality(deps(client, store), 'op:1'))?.status, 'reconciling');
  const row = await refreshFinality(deps(client, store), 'op:1');
  assert.equal(row?.status, 'final');
  assert.equal(row?.blockNumber, '7500');
  assert.equal(calls, 8, 'pages 1-8 (block 7,500 is in page 8), each asked once');
  assert.equal(store.rows.get('op:1')!.searchedBlock, null);
});

test('without a stored cursor every refresh stays within the page budget and concludes nothing', async () => {
  const store = memoryOps([consumed({ submittedBlock: '10' })]);
  let calls = 0;
  const client = chain({
    head: 50_000n,
    nonceLatest: 6n,
    nonceAt: () => 6n,
    logs: () => {
      calls++;
      return [];
    },
  });
  for (let i = 0; i < 3; i++) {
    const before = calls;
    assert.equal((await refreshFinality(deps(client, store), 'op:1'))?.status, 'reconciling');
    assert.equal(calls - before, SEARCH_PAGES_PER_REFRESH);
  }
});

test('without a known submission block, absence is never concluded', async () => {
  const store = memoryOps([consumed({ submittedBlock: null })]);
  const row = await refreshFinality(
    deps(chain({ head: 2000n, nonceLatest: 6n, nonceAt: () => 6n }), store),
    'op:1',
  );
  assert.equal(row?.status, 'reconciling');
});

test('nonce consumption not yet settled (could still reorg) → stays reconciling', async () => {
  const store = memoryOps([consumed()]);
  // Consumed at the head, but at the settled block the nonce is still ours.
  const row = await refreshFinality(
    deps(chain({ head: 2000n, nonceLatest: 6n, nonceAt: () => 5n }), store),
    'op:1',
  );
  assert.equal(row?.status, 'reconciling');
});

test('our event found anywhere since submission → recorded and, once settled, final; never failed', async () => {
  const store = memoryOps([consumed({ submittedBlock: '10' })]);
  const client = chain({
    head: 50_000n,
    nonceLatest: 6n,
    nonceAt: () => 6n,
    tx: { blockNumber: 12n },
    // An old success (first page, far beyond a one-day window) must still be found.
    logs: ({ fromBlock, toBlock }) =>
      fromBlock <= 12n && 12n <= toBlock
        ? [
            {
              args: { success: true, actualGasUsed: 1n, actualGasCost: 2n },
              transactionHash: `0x${'cc'.repeat(32)}`,
              blockNumber: 12n,
            },
          ]
        : [],
  });
  const row = await refreshFinality(deps(client, store), 'op:1');
  // Found at block 12, far below the settled block (head − 3), so it is final at once.
  assert.equal(row?.status, 'final');
  assert.equal(row?.blockNumber, '12');
});

test('a node whose head is below the recorded block never marks the receipt gone', async () => {
  const included = consumed({
    status: 'included',
    errorCode: null,
    txHash: `0x${'cc'.repeat(32)}`,
    blockNumber: '2005',
    submittedBlock: '1990',
  });
  const store = memoryOps([included]);
  // A lagging RPC (head 2000) has neither the receipt nor the event of block 2005 yet.
  for (const head of [2000n, 2004n]) {
    const row = await refreshFinality(
      deps(chain({ head, nonceLatest: 6n, nonceAt: () => 6n }), store),
      'op:1',
    );
    assert.equal(row?.status, 'included', `head ${head}`);
    assert.equal(row?.errorCode, null);
    assert.equal(row?.blockNumber, '2005');
  }
  // A node at the recorded block that still finds nothing: the receipt is gone (reorged).
  const gone = await refreshFinality(
    deps(chain({ head: 2005n, nonceLatest: 6n, nonceAt: () => 6n }), store),
    'op:1',
  );
  assert.equal(gone?.status, 'reorged');
  assert.equal(gone?.errorCode, 'RECEIPT_GONE');
});

test('a head that cannot be read never marks the receipt gone', async () => {
  const store = memoryOps([
    consumed({
      status: 'included',
      errorCode: null,
      txHash: `0x${'cc'.repeat(32)}`,
      blockNumber: '1500',
    }),
  ]);
  let headReads = 0;
  const client = {
    ...chain({ head: 2000n, nonceLatest: 6n, nonceAt: () => 6n }),
    // The settled block is read first and works; the head read for the receipt search fails.
    getBlockNumber: async () => {
      if (++headReads > 1) throw new Error('rpc down');
      return 2000n;
    },
  } as unknown as PublicClient;
  const row = await refreshFinality(deps(client, store), 'op:1');
  assert.equal(row?.status, 'included');
});

/** A deep inclusion (block 1500, settled is 1997) the bundler still reports unchanged. */
const deepIncluded = () =>
  memoryOps([consumed({ status: 'included', errorCode: null, txHash: TX, blockNumber: '1500' })]);
const bundlerSays = (receipt: BundlerReceipt): Bundler => ({
  ...noReceipts,
  receipt: async (hash) => (hash === OP_HASH ? receipt : null),
});
const stale = bundlerSays({
  success: true,
  txHash: TX,
  blockNumber: 1500n,
  actualGasUsed: 1n,
  actualGasCost: 2n,
});
const settleOn = (
  store: ChainOperationStore,
  chainOpts: { tx?: TxOnChain; canonical?: Hex | Error },
) =>
  refreshFinality(
    deps(chain({ head: 2000n, nonceLatest: 6n, nonceAt: () => 6n, ...chainOpts }), store, stale),
    'op:1',
  );

test('a deep receipt the chain confirms in the canonical block → final', async () => {
  const row = await settleOn(deepIncluded(), { tx: { blockNumber: 1500n } });
  assert.equal(row?.status, 'final');
  assert.equal(row?.blockNumber, '1500');
});

test('a stale bundler receipt after a same-height reorg is never final', async () => {
  // Same transaction, same height, but another block is canonical there now.
  const reorged = await settleOn(deepIncluded(), {
    tx: { blockNumber: 1500n },
    canonical: `0x${'dd'.repeat(32)}`,
  });
  assert.equal(reorged?.status, 'reorged');
  assert.equal(reorged?.errorCode, 'RECEIPT_GONE');
  // The node's receipt sits in a non-canonical block of that height.
  const sideBlock = await settleOn(deepIncluded(), {
    tx: { blockNumber: 1500n, blockHash: `0x${'ee'.repeat(32)}` },
  });
  assert.equal(sideBlock?.status, 'reorged');
  // The chain's receipt is at another height than the one the bundler reports.
  const moved = await settleOn(deepIncluded(), { tx: { blockNumber: 1501n } });
  assert.equal(moved?.status, 'reorged');
  // The chain's outcome for our operation contradicts the bundler's.
  const contradicted = await settleOn(deepIncluded(), {
    tx: { blockNumber: 1500n, success: false },
  });
  assert.equal(contradicted?.status, 'reorged');
});

test('a node answer for another transaction, sender or nonce is never final', async () => {
  // The node answers with a receipt for a different transaction than the one asked for.
  const otherTx = await settleOn(deepIncluded(), {
    tx: { blockNumber: 1500n, transactionHash: `0x${'ab'.repeat(32)}` },
  });
  assert.equal(otherTx?.status, 'reorged');
  // Our userOpHash, but emitted for another sender or another nonce than the stored operation.
  const otherSender = await settleOn(deepIncluded(), {
    tx: { blockNumber: 1500n, sender: '0x3333333333333333333333333333333333333333' },
  });
  assert.equal(otherSender?.status, 'reorged');
  const otherNonce = await settleOn(deepIncluded(), { tx: { blockNumber: 1500n, nonce: 6n } });
  assert.equal(otherNonce?.status, 'reorged');
});

test('a deep receipt the chain does not have is never final', async () => {
  const row = await settleOn(deepIncluded(), {});
  assert.equal(row?.status, 'reorged');
  assert.equal(row?.errorCode, 'RECEIPT_GONE');
});

test('a failed chain read during the canonical check leaves the operation included', async () => {
  for (const chainOpts of [
    { tx: new Error('rpc down') },
    { tx: { blockNumber: 1500n }, canonical: new Error('rpc down') },
  ]) {
    const store = deepIncluded();
    const row = await settleOn(store, chainOpts);
    assert.equal(row?.status, 'included');
    assert.equal(row?.errorCode, null);
    assert.equal(row?.blockNumber, '1500');
    // Nothing was lost: a later refresh with a healthy node settles it.
    assert.equal((await settleOn(store, { tx: { blockNumber: 1500n } }))?.status, 'final');
  }
});

test('a tombstone fences the key: a later operation for it is refused, nothing is overwritten', async () => {
  const store = memoryOps();
  const first = await abandonBeforeBroadcast(store, {
    idempotencyKey: 'op:2',
    intentHash: `0x${'22'.repeat(32)}`,
    chainId: BASE_SEPOLIA,
    kind: 'transfer',
  });
  assert.equal(first.abandoned, true);
  // A real operation that lost the race to the tombstone sees the tombstone, not its own row.
  const late = await store.insert(
    consumed({ idempotencyKey: 'op:2', status: 'queued', errorCode: null }),
  );
  assert.equal(late.errorCode, 'ABANDONED_BEFORE_BROADCAST');
  // And a tombstone never wins over a real stored operation.
  const store2 = memoryOps([
    consumed({ idempotencyKey: 'op:3', status: 'submitted', errorCode: null }),
  ]);
  assert.equal(
    (
      await abandonBeforeBroadcast(store2, {
        idempotencyKey: 'op:3',
        intentHash: `0x${'33'.repeat(32)}`,
        chainId: BASE_SEPOLIA,
        kind: 'transfer',
      })
    ).abandoned,
    false,
  );
  // Terminal rows never change again.
  assert.equal(
    (
      await refreshFinality(
        deps(chain({ head: 1n, nonceLatest: 0n, nonceAt: () => 0n }), store),
        'op:2',
      )
    )?.status,
    'failed',
  );
});

test('a receipt lookup the bundler cannot answer now is logged (hash and code, never the message) and changes nothing', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'info', (line: string) => lines.push(line));
  const unavailable: Bundler = {
    ...noReceipts,
    receipt: async () => {
      throw new BundlerError(
        'RPC_UNAVAILABLE',
        'https://endpoint.example/v1/SECRET-KEY not reachable',
      );
    },
  };
  const row = await refreshFinality(
    deps(
      chain({ head: 2000n, nonceLatest: 6n, nonceAt: () => 6n, tx: { blockNumber: 1500n } }),
      deepIncluded(),
      unavailable,
    ),
    'op:1',
  );
  assert.equal(row?.status, 'included');
  const logged = lines
    .map((line) => JSON.parse(line))
    .find((e) => e.event === 'chain.receipt_unknown');
  assert.equal(logged?.userOpHash, OP_HASH);
  assert.equal(logged?.code, 'RPC_UNAVAILABLE');
  assert.ok(!lines.join('\n').includes('SECRET-KEY'), 'the error message is never logged');
});

test('a receipt-lookup log never copies an unknown error name or a free-form code', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'info', (line: string) => lines.push(line));
  const odd: Bundler = {
    ...noReceipts,
    receipt: async () => {
      throw Object.assign(new Error('x'), {
        name: 'https://endpoint.example/SECRET-NAME',
        code: 'key=SECRET-CODE',
      });
    },
  };
  await refreshFinality(
    deps(
      chain({ head: 2000n, nonceLatest: 6n, nonceAt: () => 6n, tx: { blockNumber: 1500n } }),
      deepIncluded(),
      odd,
    ),
    'op:1',
  );
  const all = lines.join('\n');
  assert.ok(!all.includes('SECRET'), 'neither name nor code is copied');
  const logged = lines
    .map((line) => JSON.parse(line))
    .find((e) => String(e.event).startsWith('chain.receipt_'));
  assert.equal(logged?.name, 'other');
  assert.equal(logged?.code, null);
});
