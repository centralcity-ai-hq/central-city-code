import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbi,
  zeroAddress,
  type Hex,
  type PublicClient,
} from 'viem';
import { BASE_MAINNET, baseNetwork, type Address } from '../shared/base/chains.js';
import {
  createIdentityChainPort,
  registerIntentHash,
  transferIntentHash,
} from '../server/base/chain/identity-port.js';
import type {
  Bundler,
  BundlerReceipt,
  ChainOperationStore,
  StoredOperation,
} from '../server/base/chain/submit.js';
import type { IdentityOp } from '../server/base/identity/service.js';

// The identity port's operation view (B2a): every register and transfer op it returns carries the
// canonical block hash read from the chain and whether the UserOperation reverted. Simulated chain
// (no network): the receipt, its logs, the canonical block at its height and the tag blocks are
// scripted.

const mainnet = baseNetwork(BASE_MAINNET, { CITY_BASE_MAINNET: '1' })!;
const SENDER = '0x1111111111111111111111111111111111111111' as Address;
const HOLDER = '0x4444444444444444444444444444444444444444' as Address;
const URI = 'https://centralcity.ai/a/abc123';
const OP_HASH = `0x${'aa'.repeat(32)}` as Hex;
const TX = `0x${'cc'.repeat(32)}` as Hex;
const OTHER_TX = `0x${'cd'.repeat(32)}` as Hex;
const BLOCK = 1000n;
const BLOCK_HASH = `0x${'bb'.repeat(32)}` as Hex;
const REPLACED_HASH = `0x${'be'.repeat(32)}` as Hex;
const OTHER_OP = `0x${'ab'.repeat(32)}` as Hex;
const OTHER_SENDER = '0x5555555555555555555555555555555555555555' as Address;
const KEY = 'identity:register:8453:agent-1';

const entryPointEvents = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);

type RawLog = { address: Address; topics: Hex[]; data: Hex };

/** The EntryPoint's UserOperationEvent (stored operation: OP_HASH from SENDER with nonce 5). */
const operationEvent = (
  e: { userOpHash?: Hex; sender?: Address; nonce?: bigint; success?: boolean; from?: Address } = {},
): RawLog => ({
  address: e.from ?? mainnet.contracts.entryPointV06,
  topics: encodeEventTopics({
    abi: entryPointEvents,
    eventName: 'UserOperationEvent',
    args: {
      userOpHash: e.userOpHash ?? OP_HASH,
      sender: e.sender ?? SENDER,
      paymaster: zeroAddress,
    },
  }) as Hex[],
  data: encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
    [e.nonce ?? 5n, e.success ?? true, 1n, 1n],
  ),
});

interface ScriptedReceipt {
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  /** The bundle transaction's own status (default success). */
  status?: 'success' | 'reverted';
  /** Its logs (default: our operation's event, executed). */
  logs?: RawLog[];
}
const TRANSFER_KEY = 'identity:transfer:8453:agent-1~9';

interface Scripted {
  /** The receipt the node returns for any hash; an Error makes the read fail. */
  receipt?: ScriptedReceipt | Error;
  /** The canonical block's hash at any height now; an Error makes the read fail. */
  canonicalHash?: Hex | Error;
  finalized?: bigint;
  safe?: bigint;
}

/** A scripted node that records every read it serves. */
function scriptedChain(s: Scripted = {}) {
  const calls: string[] = [];
  const receipt: ScriptedReceipt | Error = s.receipt ?? {
    transactionHash: TX,
    blockNumber: BLOCK,
    blockHash: BLOCK_HASH,
  };
  const client = {
    getBlockNumber: async () => {
      calls.push('getBlockNumber');
      return BLOCK + 20n;
    },
    getBlock: async (args: { blockTag?: string; blockNumber?: bigint } = {}) => {
      if (args.blockNumber !== undefined) {
        calls.push(`getBlock:${args.blockNumber}`);
        if (s.canonicalHash instanceof Error) throw s.canonicalHash;
        return { number: args.blockNumber, hash: s.canonicalHash ?? BLOCK_HASH };
      }
      calls.push(`getBlock:${args.blockTag}`);
      const number = args.blockTag === 'safe' ? (s.safe ?? 0n) : (s.finalized ?? 0n);
      return { number, hash: `0x${'01'.repeat(32)}` };
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      calls.push(`getTransactionReceipt:${hash}`);
      if (receipt instanceof Error) throw receipt;
      return {
        status: 'success',
        logs: [operationEvent()],
        ...receipt,
      };
    },
    readContract: async (args: { functionName: string }) => {
      calls.push(`readContract:${args.functionName}`);
      throw new Error(`unexpected read ${args.functionName}`);
    },
    getLogs: async () => {
      calls.push('getLogs');
      return [];
    },
  } as unknown as PublicClient;
  return { client, calls };
}

function memoryOps(rows: StoredOperation[]) {
  const map = new Map(rows.map((r) => [r.idempotencyKey, { ...r }]));
  let writes = 0;
  const store: ChainOperationStore = {
    async get(key) {
      return map.has(key) ? { ...map.get(key)! } : null;
    },
    async insert(row) {
      writes++;
      if (!map.has(row.idempotencyKey)) map.set(row.idempotencyKey, { ...row });
      return { ...map.get(row.idempotencyKey)! };
    },
    async update(key, patch) {
      writes++;
      map.set(key, { ...map.get(key)!, ...patch });
      return { ...map.get(key)! };
    },
    async transition(key, from, patch) {
      const row = map.get(key);
      if (!row || !from.includes(row.status)) return null;
      return this.update(key, patch);
    },
  };
  return { store, writes: () => writes };
}

function scriptedBundler(receipt: BundlerReceipt | null = null) {
  const sent: string[] = [];
  const bundler: Bundler = {
    prepare: async () => {
      throw new Error('never prepares');
    },
    send: async (op) => {
      sent.push(op.signature);
      return OP_HASH;
    },
    receipt: async (hash) => (hash === OP_HASH ? receipt : null),
  };
  return { bundler, sent };
}

const stored = (overrides: Partial<StoredOperation> = {}): StoredOperation => ({
  idempotencyKey: KEY,
  intentHash: registerIntentHash(BASE_MAINNET, SENDER, URI),
  chainId: BASE_MAINNET,
  kind: 'register',
  sender: SENDER,
  signer: '0x2222222222222222222222222222222222222222',
  nonce: '5',
  userOpHash: OP_HASH,
  signedOperation: '{"signature":"0x5151"}',
  status: 'final',
  txHash: TX,
  blockNumber: BLOCK.toString(10),
  gasUsed: '1',
  feeWei: '1',
  maxCostWei: '1',
  submittedBlock: (BLOCK - 10n).toString(10),
  errorCode: null,
  ...overrides,
});

function portOn(client: PublicClient, store: ChainOperationStore, bundler: Bundler) {
  return createIdentityChainPort({
    network: mainnet,
    client,
    db: {} as never,
    operations: store,
    bundler,
    keystore: {} as never,
    signerOf: async () => {
      throw new Error('describing a stored operation never needs a signer');
    },
  });
}

/** Asks the port for the register step stored under KEY (it is only reconciled and described). */
const registerAgain = (client: PublicClient, store: ChainOperationStore, bundler: Bundler) =>
  portOn(client, store, bundler).register({
    operationKey: KEY,
    chainId: BASE_MAINNET,
    spenderKeyRef: 'unused',
    spender: SENDER,
    uri: URI,
  });

const evidence = (op: { status: string; blockHash: string | null; reverted: boolean }) => ({
  status: op.status,
  blockHash: op.blockHash,
  reverted: op.reverted,
});

test('describe: an included op carries the canonical block hash read from the chain', async () => {
  const { client, calls } = scriptedChain();
  const { store, writes } = memoryOps([stored()]);
  const { bundler, sent } = scriptedBundler();
  const op = await registerAgain(client, store, bundler);
  assert.deepEqual(evidence(op), { status: 'final', blockHash: BLOCK_HASH, reverted: false });
  assert.equal(op.blockNumber, '1000');
  // The receipt of the stored transaction first, the canonical block at that height last.
  assert.deepEqual(
    calls.filter((c) => c.startsWith('getTransactionReceipt') || c === `getBlock:${BLOCK}`),
    [`getTransactionReceipt:${TX}`, `getBlock:${BLOCK}`],
  );
  assert.equal(writes(), 0, 'describe never writes');
  assert.deepEqual(sent, [], 'describe never sends');

  // The fields fit the identity service's optional IdentityOp fields.
  const asServiceOp: IdentityOp = op;
  assert.equal(asServiceOp.blockHash, BLOCK_HASH);
  assert.equal(asServiceOp.reverted, false);
});

test('describe: a transfer op carries the same evidence', async () => {
  const { client } = scriptedChain();
  const { store } = memoryOps([
    stored({
      idempotencyKey: TRANSFER_KEY,
      kind: 'transfer',
      intentHash: transferIntentHash(BASE_MAINNET, SENDER, 9n, HOLDER),
    }),
  ]);
  const { bundler } = scriptedBundler();
  const op = await portOn(client, store, bundler).transfer({
    operationKey: TRANSFER_KEY,
    chainId: BASE_MAINNET,
    spenderKeyRef: 'unused',
    spender: SENDER,
    id: 9n,
    to: HOLDER,
  });
  assert.deepEqual(evidence(op), { status: 'final', blockHash: BLOCK_HASH, reverted: false });
});

/** The canonical bundle tx in which our operation ran and reverted (handleOps itself succeeded). */
const revertedReceipt: ScriptedReceipt = {
  transactionHash: TX,
  blockNumber: BLOCK,
  blockHash: BLOCK_HASH,
  logs: [operationEvent({ success: false })],
};

test('describe: a reverted inclusion is reverted, with its block hash', async () => {
  // Reverted and not final yet: the stored inclusion is reported as reconciling.
  {
    const { client } = scriptedChain({ finalized: BLOCK - 1n, receipt: revertedReceipt });
    const { store } = memoryOps([stored({ status: 'included', errorCode: 'USEROP_REVERTED' })]);
    const reverted: BundlerReceipt = {
      success: false,
      txHash: TX,
      blockNumber: BLOCK,
      actualGasUsed: 1n,
      actualGasCost: 1n,
    };
    const { bundler, sent } = scriptedBundler(reverted);
    const op = await registerAgain(client, store, bundler);
    assert.deepEqual(evidence(op), {
      status: 'reconciling',
      blockHash: BLOCK_HASH,
      reverted: true,
    });
    assert.equal(op.blockNumber, '1000');
    assert.deepEqual(sent, []);
  }
  // A revert made final.
  {
    const { client } = scriptedChain({ receipt: revertedReceipt });
    const { store } = memoryOps([stored({ status: 'failed', errorCode: 'USEROP_REVERTED' })]);
    const { bundler } = scriptedBundler();
    const op = await registerAgain(client, store, bundler);
    assert.deepEqual(evidence(op), { status: 'failed', blockHash: BLOCK_HASH, reverted: true });
    assert.equal(op.finality, 'final');
  }
});

test('describe: a block replaced at the same height gives no block hash', async () => {
  // The node still serves the receipt in the old block, but the canonical block at that height is
  // another one: the operation is not in the canonical chain, and its hash is never reported.
  const { client } = scriptedChain({ canonicalHash: REPLACED_HASH });
  const { store } = memoryOps([stored()]);
  const { bundler } = scriptedBundler();
  const op = await registerAgain(client, store, bundler);
  assert.deepEqual(evidence(op), { status: 'final', blockHash: null, reverted: false });
  assert.equal(op.blockNumber, '1000', 'the stored block is still reported');
});

test('describe: a receipt for another transaction or block gives no block hash', async () => {
  for (const receipt of [
    { transactionHash: OTHER_TX, blockNumber: BLOCK, blockHash: BLOCK_HASH },
    { transactionHash: TX, blockNumber: BLOCK + 1n, blockHash: BLOCK_HASH },
  ]) {
    const { client, calls } = scriptedChain({ receipt });
    const { store } = memoryOps([stored()]);
    const { bundler } = scriptedBundler();
    const op = await registerAgain(client, store, bundler);
    assert.deepEqual(evidence(op), { status: 'final', blockHash: null, reverted: false });
    assert.ok(!calls.includes(`getBlock:${BLOCK}`), 'no canonical read once the receipt differs');
  }
});

test('describe: a failing read gives no block hash and never throws', async () => {
  for (const s of [
    { receipt: new Error('rpc down') },
    { canonicalHash: new Error('rpc down') },
  ] satisfies Scripted[]) {
    const { client } = scriptedChain(s);
    const { store, writes } = memoryOps([stored()]);
    const { bundler } = scriptedBundler();
    const op = await registerAgain(client, store, bundler);
    assert.deepEqual(evidence(op), { status: 'final', blockHash: null, reverted: false });
    assert.equal(writes(), 0);
  }
});

test('describe: an op that has not landed has no block hash and reads nothing for it', async () => {
  // Never broadcast and settled: nothing at all is read from the chain.
  {
    const { client, calls } = scriptedChain();
    const { store } = memoryOps([
      stored({
        status: 'failed',
        errorCode: 'ABANDONED_BEFORE_BROADCAST',
        txHash: null,
        blockNumber: null,
      }),
    ]);
    const { bundler } = scriptedBundler();
    const op = await registerAgain(client, store, bundler);
    assert.deepEqual(evidence(op), { status: 'failed', blockHash: null, reverted: false });
    assert.equal(op.blockNumber, null);
    assert.deepEqual(calls, [], 'no RPC call');
  }
  // Stored, not broadcast yet: no receipt or block read for the view.
  {
    const { client, calls } = scriptedChain();
    const { store } = memoryOps([stored({ status: 'queued', txHash: null, blockNumber: null })]);
    const { bundler } = scriptedBundler();
    const op = await registerAgain(client, store, bundler);
    assert.deepEqual(evidence(op), { status: 'queued', blockHash: null, reverted: false });
    assert.ok(
      !calls.some((c) => c.startsWith('getTransactionReceipt') || c === `getBlock:${BLOCK}`),
      `no receipt or block read: ${calls.join(', ')}`,
    );
  }
});

/** Describes the stored row against a scripted canonical receipt at the stored height. */
async function describedWith(receipt: ScriptedReceipt, row: Partial<StoredOperation> = {}) {
  const { client, calls } = scriptedChain({ receipt });
  const { store, writes } = memoryOps([stored(row)]);
  const { bundler, sent } = scriptedBundler();
  const op = await registerAgain(client, store, bundler);
  assert.equal(writes(), 0, 'describe never writes');
  assert.deepEqual(sent, [], 'describe never sends');
  return { op, calls };
}

const atBlock = (over: Partial<ScriptedReceipt>): ScriptedReceipt => ({
  transactionHash: TX,
  blockNumber: BLOCK,
  blockHash: BLOCK_HASH,
  ...over,
});

test('describe: the canonical tx at that height reverted -> no block hash', async () => {
  // The same bundle tx re-included in a replacement block N, where handleOps itself reverted: our
  // operation never ran in the canonical chain, whatever the bundler said before the reorg.
  const { op, calls } = await describedWith(atBlock({ status: 'reverted', logs: [] }));
  assert.deepEqual(evidence(op), { status: 'final', blockHash: null, reverted: false });
  assert.ok(!calls.includes(`getBlock:${BLOCK}`), 'no canonical read once the receipt differs');
});

test('describe: the canonical tx holds no event for this operation -> no block hash', async () => {
  for (const logs of [
    [],
    // Another operation's event only (a stale or wrong bundler receipt naming a real tx).
    [operationEvent({ userOpHash: OTHER_OP })],
    // Our hash, but from a contract that is not the EntryPoint.
    [operationEvent({ from: OTHER_SENDER })],
    // Our hash, but another sender or another nonce.
    [operationEvent({ sender: OTHER_SENDER })],
    [operationEvent({ nonce: 6n })],
    // Two events for our hash: not exactly one.
    [operationEvent(), operationEvent()],
  ]) {
    const { op } = await describedWith(atBlock({ logs }));
    assert.deepEqual(evidence(op), { status: 'final', blockHash: null, reverted: false });
  }
});

test('describe: an event whose outcome disagrees with the stored one -> no block hash', async () => {
  // Stored as executed, but in the canonical block the operation reverted.
  {
    const { op } = await describedWith(atBlock({ logs: [operationEvent({ success: false })] }));
    assert.deepEqual(evidence(op), { status: 'final', blockHash: null, reverted: false });
  }
  // Stored as a final revert, but in the canonical block the operation executed.
  {
    const { op } = await describedWith(atBlock({ logs: [operationEvent({ success: true })] }), {
      status: 'failed',
      errorCode: 'USEROP_REVERTED',
    });
    assert.deepEqual(evidence(op), { status: 'failed', blockHash: null, reverted: true });
  }
});

test('describe: other operations in the same bundle do not hide ours', async () => {
  const { op } = await describedWith(
    atBlock({ logs: [operationEvent({ userOpHash: OTHER_OP }), operationEvent()] }),
  );
  assert.deepEqual(evidence(op), { status: 'final', blockHash: BLOCK_HASH, reverted: false });
});
