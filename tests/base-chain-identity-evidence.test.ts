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
import {
  BASE_MAINNET,
  BASE_SEPOLIA,
  baseNetwork,
  type Address,
  type BaseNetwork,
} from '../shared/base/chains.js';
import { identityRegistryAbi, registeredIds } from '../server/base/chain/identity-chain.js';
import {
  attemptOf,
  createIdentityChainPort,
  firstAttemptKey,
  identityNonceLane,
  IdentityPortError,
  registerIntentHash,
} from '../server/base/chain/identity-port.js';
import {
  abandonBeforeBroadcast,
  type Bundler,
  type BundlerReceipt,
  type ChainOperationStore,
  type StoredOperation,
} from '../server/base/chain/submit.js';

// Mint evidence and finality of the identity port against a simulated chain (no network): the
// receipt, its logs, the block hashes and the registry reads are all scripted per test.

const mainnet = baseNetwork(BASE_MAINNET, { CITY_BASE_MAINNET: '1' })!;
const registry = mainnet.contracts.identityRegistry!;
const entryPoint = mainnet.contracts.entryPointV06;
const SENDER = '0x1111111111111111111111111111111111111111' as Address;
const OTHER_HOLDER = '0x4444444444444444444444444444444444444444' as Address;
const URI = 'https://centralcity.ai/a/abc123';
const OP_HASH = `0x${'aa'.repeat(32)}` as Hex;
const OTHER_OP = `0x${'ab'.repeat(32)}` as Hex;
const TX = `0x${'cc'.repeat(32)}` as Hex;
const BLOCK = 1000n;
const BLOCK_HASH = `0x${'bb'.repeat(32)}` as Hex;
const KEY = 'identity:register:8453:agent-1';

const entryPointEvents = parseAbi([
  'event BeforeExecution()',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);

type RawLog = { address: Address; topics: Hex[]; data: Hex };

const beforeExecution = (): RawLog => ({
  address: entryPoint,
  topics: encodeEventTopics({ abi: entryPointEvents, eventName: 'BeforeExecution' }) as Hex[],
  data: '0x',
});
const operationEvent = (userOpHash: Hex, success = true, sender: Address = SENDER): RawLog => ({
  address: entryPoint,
  topics: encodeEventTopics({
    abi: entryPointEvents,
    eventName: 'UserOperationEvent',
    args: { userOpHash, sender, paymaster: zeroAddress },
  }) as Hex[],
  data: encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
    [5n, success, 1n, 1n],
  ),
});
const mint = (id: bigint, to: Address = SENDER, address: Address = registry): RawLog => ({
  address,
  topics: encodeEventTopics({
    abi: identityRegistryAbi,
    eventName: 'Transfer',
    args: { from: zeroAddress, to, tokenId: id },
  }) as Hex[],
  data: '0x',
});
/** One handleOps bundle holding only our operation, which minted `id`. */
const ourBundle = (id = 9n) => [beforeExecution(), mint(id), operationEvent(OP_HASH)];

interface Scripted {
  /** The latest block; an Error makes every read of it fail. */
  head?: bigint | Error;
  /** Tag blocks; an Error makes that read fail. */
  finalized?: bigint | Error;
  safe?: bigint | Error;
  /** The receipt of TX, or an Error when the node has none. */
  receipt?: { blockNumber: bigint; blockHash: Hex; logs: RawLog[] } | Error;
  /** The hash of the block at BLOCK now (defaults to the receipt's block hash). */
  canonicalHash?: Hex;
  tokenUri?: (id: bigint, blockNumber: bigint | undefined) => string;
  owner?: Address;
  /** The account's next nonce on the lane, now (latest) or at a block. */
  nonce?: (blockNumber: bigint | undefined) => bigint;
  /**
   * What an on-chain search for our operation's UserOperationEvent finds: true for the event of
   * our landed operation, an Error for a search that fails. Nothing is found by default.
   */
  onChain?: boolean | Error;
}

function scriptedChain(s: Scripted) {
  const reads: { functionName: string; blockNumber: bigint | undefined }[] = [];
  const receipt = s.receipt ?? { blockNumber: BLOCK, blockHash: BLOCK_HASH, logs: ourBundle() };
  const tag = (value: bigint | Error | undefined) => {
    if (value instanceof Error) throw value;
    return { number: value ?? 0n, hash: `0x${'01'.repeat(32)}` };
  };
  const head = () => {
    if (s.head instanceof Error) throw s.head;
    return s.head ?? BLOCK + 20n;
  };
  const client = {
    getBlockNumber: async () => head(),
    getBlock: async (args: { blockTag?: string; blockNumber?: bigint } = {}) => {
      if (args.blockTag === 'finalized') return tag(s.finalized);
      if (args.blockTag === 'safe') return tag(s.safe);
      if (args.blockNumber !== undefined)
        return {
          number: args.blockNumber,
          hash: s.canonicalHash ?? (receipt instanceof Error ? BLOCK_HASH : receipt.blockHash),
        };
      return { number: head(), hash: `0x${'02'.repeat(32)}` };
    },
    getTransactionReceipt: async () => {
      if (receipt instanceof Error) throw receipt;
      return {
        transactionHash: TX,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        status: 'success',
        logs: receipt.logs.map((log, logIndex) => ({
          ...log,
          logIndex,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          transactionHash: TX,
        })),
      };
    },
    readContract: async (args: { functionName: string; args: [bigint]; blockNumber?: bigint }) => {
      reads.push({ functionName: args.functionName, blockNumber: args.blockNumber });
      if (args.functionName === 'tokenURI')
        return (s.tokenUri ?? (() => URI))(args.args[0], args.blockNumber);
      if (args.functionName === 'ownerOf') return s.owner ?? SENDER;
      if (args.functionName === 'getNonce') return (s.nonce ?? (() => 5n))(args.blockNumber);
      throw new Error(`unexpected read ${args.functionName}`);
    },
    getLogs: async (args: { args?: { userOpHash?: Hex } }) => {
      if (s.onChain instanceof Error) throw s.onChain;
      if (!s.onChain || args.args?.userOpHash !== OP_HASH) return [];
      return [
        {
          args: { userOpHash: OP_HASH, success: true, actualGasUsed: 1n, actualGasCost: 1n },
          transactionHash: TX,
          blockNumber: BLOCK,
        },
      ];
    },
  } as unknown as PublicClient;
  return { client, reads };
}

function memoryOps(rows: StoredOperation[] = []) {
  const map = new Map(rows.map((r) => [r.idempotencyKey, { ...r }]));
  let inserts = 0;
  const store: ChainOperationStore = {
    async get(key) {
      return map.has(key) ? { ...map.get(key)! } : null;
    },
    async insert(row) {
      inserts++;
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
  return { store, map, inserts: () => inserts };
}

/** A bundler that knows only our operation's receipt (or none), and counts what it is sent. */
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
const landed = (success = true): BundlerReceipt => ({
  success,
  txHash: TX,
  blockNumber: BLOCK,
  actualGasUsed: 1n,
  actualGasCost: 1n,
});

const signedOperation = JSON.stringify({
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
  signature: '0x5151',
});
const registration = (overrides: Partial<StoredOperation> = {}): StoredOperation => ({
  idempotencyKey: KEY,
  intentHash: registerIntentHash(BASE_MAINNET, SENDER, URI),
  chainId: BASE_MAINNET,
  kind: 'register',
  sender: SENDER,
  signer: '0x2222222222222222222222222222222222222222',
  nonce: '5',
  userOpHash: OP_HASH,
  signedOperation,
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

function portOn(
  client: PublicClient,
  store: ChainOperationStore,
  bundler: Bundler,
  network: BaseNetwork = mainnet,
) {
  return createIdentityChainPort({
    network,
    client,
    db: {} as never,
    operations: store,
    bundler,
    keystore: {} as never,
    signerOf: async () => {
      throw new Error('mint evidence never needs a signer');
    },
  });
}
const ask = { operationKey: KEY, chainId: BASE_MAINNET, uri: URI } as const;

test('mint evidence: a canonical receipt with one mint inside this operation proves the id', async () => {
  const { client, reads } = scriptedChain({ finalized: BLOCK + 5n, safe: BLOCK + 8n });
  const { store, inserts } = memoryOps([registration()]);
  const { bundler, sent } = scriptedBundler(landed());
  const evidence = await portOn(client, store, bundler).mintEvidence(ask);
  assert.deepEqual(evidence, {
    kind: 'minted',
    opKey: KEY,
    status: 'final',
    finality: 'final',
    txHash: TX,
    blockNumber: '1000',
    blockHash: BLOCK_HASH,
    id: '9',
    registry,
    tokenUri: URI,
    owner: SENDER,
  });
  // tokenURI is read at the receipt block, the holder at the latest block.
  assert.deepEqual(
    reads.filter((r) => r.functionName !== 'getNonce'),
    [
      { functionName: 'tokenURI', blockNumber: BLOCK },
      { functionName: 'ownerOf', blockNumber: undefined },
    ],
  );
  assert.equal(inserts(), 0, 'nothing stored, nothing fenced');
  assert.deepEqual(sent, [], 'nothing sent');
});

test('finality on mainnet: safe is its own signal and never makes an operation final', async () => {
  // Finalized is still below the block, the safe head is past it.
  const { client } = scriptedChain({
    finalized: BLOCK - 1n,
    safe: BLOCK + 2n,
    owner: OTHER_HOLDER,
  });
  const { store, map } = memoryOps([registration({ status: 'included' })]);
  const { bundler } = scriptedBundler(landed());
  const port = portOn(client, store, bundler);
  const evidence = await port.mintEvidence(ask);
  assert.equal(evidence.kind, 'minted');
  if (evidence.kind !== 'minted') return;
  assert.equal(evidence.status, 'included');
  assert.equal(evidence.finality, 'safe');
  assert.equal(evidence.owner, OTHER_HOLDER, 'the current holder, read at the latest block');
  assert.equal(map.get(KEY)!.status, 'included', 'safe never writes final');

  // The port's operation view carries the block and the same finality.
  const op = await port.register({
    operationKey: KEY,
    chainId: BASE_MAINNET,
    spenderKeyRef: 'unused',
    spender: SENDER,
    uri: URI,
  });
  assert.equal(op.status, 'included');
  assert.equal(op.blockNumber, '1000');
  assert.equal(op.finality, 'safe');

  // The safe head below the block, or a node that cannot answer: only included.
  for (const safe of [BLOCK - 1n, new Error('safe tag unsupported')]) {
    const below = scriptedChain({ finalized: BLOCK - 1n, safe });
    const again = await portOn(below.client, store, bundler).mintEvidence(ask);
    assert.equal(again.kind === 'minted' && again.finality, 'included');
  }

  // Once the finalized block reaches it, the operation is final (and so is its finality).
  const final = scriptedChain({ finalized: BLOCK, safe: BLOCK + 2n });
  const settled = await portOn(final.client, store, bundler).mintEvidence(ask);
  assert.equal(settled.kind === 'minted' && settled.status, 'final');
  assert.equal(settled.kind === 'minted' && settled.finality, 'final');
});

test('finality elsewhere: shallow is included, unlanded has none, the settled depth is final', async () => {
  const sepolia = baseNetwork(BASE_SEPOLIA)!;
  const key = 'identity:register:84532:agent-1';
  const row = registration({
    idempotencyKey: key,
    chainId: BASE_SEPOLIA,
    intentHash: registerIntentHash(BASE_SEPOLIA, SENDER, URI),
    status: 'included',
  });
  const input = {
    operationKey: key,
    chainId: BASE_SEPOLIA,
    spenderKeyRef: 'unused',
    spender: SENDER,
    uri: URI,
  } as const;
  const { store } = memoryOps([
    row,
    registration({ ...row, idempotencyKey: `${key}:q`, status: 'queued' }),
  ]);
  const { bundler } = scriptedBundler(landed());
  // Head one block past it: not yet three confirmations deep.
  const shallow = scriptedChain({ head: BLOCK + 1n });
  const op = await portOn(shallow.client, store, bundler, sepolia).register(input);
  assert.deepEqual(
    { status: op.status, blockNumber: op.blockNumber, finality: op.finality },
    { status: 'included', blockNumber: '1000', finality: 'included' },
  );
  const queued = await portOn(shallow.client, store, bundler, sepolia).register({
    ...input,
    operationKey: `${key}:q`,
  });
  assert.deepEqual(
    { status: queued.status, blockNumber: queued.blockNumber, finality: queued.finality },
    { status: 'queued', blockNumber: null, finality: null },
  );
  // Deep enough: final, as before (the settled depth is unchanged).
  const deep = scriptedChain({ head: BLOCK + 3n });
  const settled = await portOn(deep.client, store, bundler, sepolia).register(input);
  assert.deepEqual(
    { status: settled.status, finality: settled.finality },
    { status: 'final', finality: 'final' },
  );
});

test('finality elsewhere: an included operation at the settled depth is safe while not final yet', async () => {
  const sepolia = baseNetwork(BASE_SEPOLIA)!;
  const key = 'identity:register:84532:agent-1';
  const { store, map } = memoryOps([
    registration({
      idempotencyKey: key,
      chainId: BASE_SEPOLIA,
      intentHash: registerIntentHash(BASE_SEPOLIA, SENDER, URI),
      status: 'included',
    }),
  ]);
  // Ten blocks deep (three confirmations needed), but the receipt cannot be read again right now
  // (the bundler pruned it and the log search fails), so the row stays included, not final.
  const { client } = scriptedChain({
    head: BLOCK + 10n,
    onChain: new Error('getLogs failed'),
    receipt: {
      blockNumber: BLOCK,
      blockHash: BLOCK_HASH,
      logs: [
        beforeExecution(),
        mint(9n, SENDER, sepolia.contracts.identityRegistry!),
        operationEvent(OP_HASH),
      ],
    },
  });
  const port = portOn(client, store, scriptedBundler(null).bundler, sepolia);
  const op = await port.register({
    operationKey: key,
    chainId: BASE_SEPOLIA,
    spenderKeyRef: 'unused',
    spender: SENDER,
    uri: URI,
  });
  assert.deepEqual(
    { status: op.status, blockNumber: op.blockNumber, finality: op.finality },
    { status: 'included', blockNumber: '1000', finality: 'safe' },
  );
  const evidence = await port.mintEvidence({ operationKey: key, chainId: BASE_SEPOLIA, uri: URI });
  assert.equal(evidence.kind, 'minted');
  assert.equal(evidence.kind === 'minted' && evidence.status, 'included');
  assert.equal(evidence.kind === 'minted' && evidence.finality, 'safe');
  assert.equal(map.get(key)!.status, 'included', 'safe never writes final');
});

test('mint evidence: a block replaced at the same height is not proof', async () => {
  const { client } = scriptedChain({
    finalized: BLOCK + 5n,
    canonicalHash: `0x${'ee'.repeat(32)}`,
  });
  const { store } = memoryOps([registration()]);
  const evidence = await portOn(client, store, scriptedBundler(landed()).bundler).mintEvidence(ask);
  assert.deepEqual(evidence, { kind: 'pending', reason: 'NOT_CANONICAL' });
});

test('mint evidence: a missing receipt or a failing read is pending, never an error', async () => {
  const { store } = memoryOps([registration()]);
  const { bundler } = scriptedBundler(landed());
  const missing = scriptedChain({ receipt: new Error('receipt not found') });
  assert.deepEqual(await portOn(missing.client, store, bundler).mintEvidence(ask), {
    kind: 'pending',
    reason: 'RECEIPT_MISSING',
  });
  const flaky = scriptedChain({
    tokenUri: () => {
      throw new Error('rpc down');
    },
  });
  assert.deepEqual(await portOn(flaky.client, store, bundler).mintEvidence(ask), {
    kind: 'pending',
    reason: 'UNAVAILABLE',
  });
  // A receipt now in another block than the recorded one waits for the row to catch up.
  const moved = scriptedChain({
    receipt: { blockNumber: BLOCK + 1n, blockHash: BLOCK_HASH, logs: ourBundle() },
  });
  assert.deepEqual(await portOn(moved.client, store, bundler).mintEvidence(ask), {
    kind: 'pending',
    reason: 'BLOCK_MOVED',
  });
});

test('mint evidence: only a mint inside this operation execution counts', async () => {
  const { store } = memoryOps([registration()]);
  const { bundler } = scriptedBundler(landed());
  // Only id 9 has our URI; any other id picked would fail the URI check.
  const tokenUri = (id: bigint) => (id === 9n ? URI : `https://centralcity.ai/a/other${id}`);
  const evidenceFor = (logs: RawLog[]) =>
    portOn(
      scriptedChain({ receipt: { blockNumber: BLOCK, blockHash: BLOCK_HASH, logs }, tokenUri })
        .client,
      store,
      bundler,
    ).mintEvidence(ask);

  // A bundle with mints to the same sender in the validation phase, in the operation before ours
  // and in the one after ours, and a Transfer-shaped log from another contract inside ours.
  const crowded = await evidenceFor([
    mint(6n),
    beforeExecution(),
    mint(7n),
    operationEvent(OTHER_OP),
    mint(8n, SENDER, OTHER_HOLDER),
    mint(9n),
    mint(4n, OTHER_HOLDER),
    operationEvent(OP_HASH),
    mint(10n),
    operationEvent(`0x${'ac'.repeat(32)}`),
  ]);
  assert.equal(crowded.kind === 'minted' && crowded.id, '9');

  // Two mints to the sender inside our own range: not exactly one, so no proof.
  assert.deepEqual(
    await evidenceFor([beforeExecution(), mint(9n), mint(11n), operationEvent(OP_HASH)]),
    { kind: 'pending', reason: 'NO_UNIQUE_MINT' },
  );
  // The only mint belongs to the operation before ours.
  assert.deepEqual(
    await evidenceFor([
      beforeExecution(),
      mint(9n),
      operationEvent(OTHER_OP),
      operationEvent(OP_HASH),
    ]),
    { kind: 'pending', reason: 'NO_UNIQUE_MINT' },
  );
  // The EntryPoint reports our operation as failed, or does not report it at all.
  assert.deepEqual(
    await evidenceFor([beforeExecution(), mint(9n), operationEvent(OP_HASH, false)]),
    { kind: 'pending', reason: 'OPERATION_FAILED' },
  );
  assert.deepEqual(await evidenceFor([beforeExecution(), mint(9n), operationEvent(OTHER_OP)]), {
    kind: 'pending',
    reason: 'NO_OPERATION_EVENT',
  });
});

test('mint evidence: tokenURI at the receipt block must be the uri asked for', async () => {
  const { store } = memoryOps([registration()]);
  const { bundler } = scriptedBundler(landed());
  // The URI was another one when it was minted, ours only later: not a mint of ours.
  const later = scriptedChain({
    tokenUri: (_id, blockNumber) =>
      blockNumber === BLOCK ? 'https://centralcity.ai/a/zzz999' : URI,
  });
  assert.deepEqual(await portOn(later.client, store, bundler).mintEvidence(ask), {
    kind: 'pending',
    reason: 'URI_MISMATCH',
  });
  // Ours at the receipt block and changed later by the holder: still our mint.
  const changed = scriptedChain({
    tokenUri: (_id, blockNumber) =>
      blockNumber === BLOCK ? URI : 'https://centralcity.ai/a/new001',
  });
  const evidence = await portOn(changed.client, store, bundler).mintEvidence(ask);
  assert.equal(evidence.kind === 'minted' && evidence.tokenUri, URI);
});

test('mint evidence: the stored state decides none, pending, reverted and failed', async () => {
  const { client } = scriptedChain({ finalized: BLOCK - 5n, safe: BLOCK - 5n });
  const evidenceOf = async (row: StoredOperation | null, receipt: BundlerReceipt | null = null) => {
    const ops = memoryOps(row ? [row] : []);
    const { bundler, sent } = scriptedBundler(receipt);
    const evidence = await portOn(client, ops.store, bundler).mintEvidence(ask);
    return { evidence, sent, inserts: ops.inserts(), row: ops.map.get(KEY) };
  };
  const none = await evidenceOf(null);
  assert.deepEqual(none.evidence, { kind: 'none' });
  assert.equal(none.inserts, 0, 'an absent key is never fenced');
  assert.equal(none.row, undefined);

  const unsent = { txHash: null, blockNumber: null } as const;
  for (const status of ['queued', 'submitted', 'unknown', 'reconciling', 'reorged'] as const) {
    const result = await evidenceOf(registration({ ...unsent, status }));
    assert.deepEqual(result.evidence, { kind: 'pending' }, status);
    assert.equal(result.inserts, 0);
    // Reconciling may rebroadcast exactly the stored operation, never a new one.
    for (const signature of result.sent) assert.equal(signature, '0x5151');
  }
  assert.deepEqual(
    (
      await evidenceOf(
        registration({ status: 'included', errorCode: 'USEROP_REVERTED' }),
        landed(false),
      )
    ).evidence,
    { kind: 'reverted' },
  );
  assert.deepEqual(
    (await evidenceOf(registration({ status: 'failed', errorCode: 'USEROP_REVERTED' }))).evidence,
    { kind: 'failed' },
  );
  // A never-broadcast tombstone is a failure too.
  const fenced = memoryOps();
  await abandonBeforeBroadcast(fenced.store, {
    idempotencyKey: KEY,
    intentHash: registerIntentHash(BASE_MAINNET, SENDER, URI),
    chainId: BASE_MAINNET,
    kind: 'register',
  });
  assert.deepEqual(
    await portOn(client, fenced.store, scriptedBundler().bundler).mintEvidence(ask),
    { kind: 'failed' },
  );
});

test('mint evidence: an attempt whose nonce the landed first attempt used reports its mint', async () => {
  const retryKey = `${KEY}:1`;
  const { client } = scriptedChain({ finalized: BLOCK + 5n, nonce: () => 6n });
  const { store, inserts } = memoryOps([
    registration(),
    registration({
      idempotencyKey: retryKey,
      userOpHash: `0x${'dd'.repeat(32)}`,
      status: 'reconciling',
      errorCode: 'NONCE_CONSUMED',
      txHash: null,
      blockNumber: null,
    }),
  ]);
  const evidence = await portOn(client, store, scriptedBundler(landed()).bundler).mintEvidence({
    ...ask,
    operationKey: retryKey,
  });
  assert.equal(evidence.kind, 'minted');
  assert.equal(evidence.kind === 'minted' && evidence.opKey, KEY, 'the attempt that landed');
  assert.equal(evidence.kind === 'minted' && evidence.id, '9');
  assert.equal(inserts(), 0);
});

test('mint evidence: a consumed attempt whose landed sibling cannot be checked right now is pending, never failed', async () => {
  const retryKey = `${KEY}:1`;
  // Attempt 0 landed on nonce 5, but its row still says submitted and the bundler pruned its
  // receipt; attempt 1, signed on the same nonce, already failed with NONCE_CONSUMED.
  const rows = () => [
    registration({ status: 'submitted', txHash: null, blockNumber: null }),
    registration({
      idempotencyKey: retryKey,
      userOpHash: `0x${'dd'.repeat(32)}`,
      status: 'failed',
      errorCode: 'NONCE_CONSUMED',
      txHash: null,
      blockNumber: null,
    }),
  ];
  const evidenceOn = (chain: Scripted, store: ChainOperationStore) =>
    portOn(
      scriptedChain({ finalized: BLOCK + 5n, nonce: () => 6n, ...chain }).client,
      store,
      scriptedBundler(null).bundler,
    ).mintEvidence({ ...ask, operationKey: retryKey });

  // The head cannot be read while attempt 0 is reconciled, so its refresh throws.
  const hiccup = memoryOps(rows());
  assert.deepEqual(await evidenceOn({ head: new Error('rpc down'), onChain: true }, hiccup.store), {
    kind: 'pending',
  });
  assert.equal(hiccup.map.get(KEY)!.status, 'submitted', 'nothing concluded from a failed read');

  // The log search for attempt 0's event cannot finish: attempt 0 is left reconciling.
  const search = memoryOps(rows());
  assert.deepEqual(await evidenceOn({ onChain: new Error('getLogs failed') }, search.store), {
    kind: 'pending',
  });
  assert.equal(search.map.get(KEY)!.status, 'reconciling');

  // Once the node answers, the same rows prove attempt 0's mint.
  for (const { store, map } of [hiccup, search]) {
    const evidence = await evidenceOn({ onChain: true }, store);
    assert.equal(evidence.kind === 'minted' && evidence.opKey, KEY);
    assert.equal(evidence.kind === 'minted' && evidence.id, '9');
    assert.equal(map.get(retryKey)!.status, 'failed');
  }
});

test('mint evidence: a consumed attempt fails only once every attempt on its nonce settled without landing', async () => {
  const retryKey = `${KEY}:1`;
  const retry = registration({
    idempotencyKey: retryKey,
    userOpHash: `0x${'dd'.repeat(32)}`,
    status: 'failed',
    errorCode: 'NONCE_CONSUMED',
    txHash: null,
    blockNumber: null,
  });
  const evidenceWith = (first: StoredOperation, finalized: bigint) => {
    // The chain holds attempt 0's reverted operation, as the bundler reports it.
    const { client } = scriptedChain({
      finalized,
      nonce: () => 6n,
      receipt: {
        blockNumber: BLOCK,
        blockHash: BLOCK_HASH,
        logs: [beforeExecution(), operationEvent(OP_HASH, false)],
      },
    });
    const { store } = memoryOps([first, retry]);
    return portOn(client, store, scriptedBundler(landed(false)).bundler).mintEvidence({
      ...ask,
      operationKey: retryKey,
    });
  };
  // Attempt 0 used the nonce and reverted: pending while that revert is not final (a reorg could
  // still change it), failed once it is.
  const reverted = registration({ status: 'included', errorCode: 'USEROP_REVERTED' });
  assert.deepEqual(await evidenceWith(reverted, BLOCK - 5n), { kind: 'pending' });
  assert.deepEqual(await evidenceWith(reverted, BLOCK + 5n), { kind: 'failed' });
  assert.deepEqual(
    await evidenceWith(registration({ status: 'failed', errorCode: 'USEROP_REVERTED' }), BLOCK),
    { kind: 'failed' },
  );
});

test('mint evidence: a reconciliation that fails on an RPC hiccup is pending, never an error', async () => {
  // The nonce moved past the stored one, so reconciling reads the head, and that read fails.
  const { client } = scriptedChain({
    finalized: BLOCK + 5n,
    nonce: () => 6n,
    head: new Error('rpc down'),
  });
  const { store, map } = memoryOps([
    registration({ status: 'submitted', txHash: null, blockNumber: null }),
  ]);
  assert.deepEqual(await portOn(client, store, scriptedBundler(null).bundler).mintEvidence(ask), {
    kind: 'pending',
  });
  assert.equal(map.get(KEY)!.status, 'submitted');
});

test('identity port: a key stored for another network is refused and its row never written', async () => {
  const sepolia = baseNetwork(BASE_SEPOLIA)!;
  // A mainnet registration, included. A Sepolia node finds no event for it, so reconciling it
  // there would write RECEIPT_GONE onto the healthy mainnet row.
  const mainnetRow = registration({ status: 'included' });
  const { store, map } = memoryOps([mainnetRow]);
  const port = portOn(scriptedChain({}).client, store, scriptedBundler(null).bundler, sepolia);
  const wrongNetwork = (error: unknown) =>
    error instanceof IdentityPortError && error.code === 'WRONG_NETWORK';
  const step = {
    operationKey: KEY,
    chainId: BASE_SEPOLIA,
    spenderKeyRef: 'unused',
    spender: SENDER,
  } as const;
  await assert.rejects(port.mintEvidence({ ...ask, chainId: BASE_SEPOLIA }), wrongNetwork);
  await assert.rejects(port.register({ ...step, uri: URI }), wrongNetwork);
  await assert.rejects(port.transfer({ ...step, id: 9n, to: OTHER_HOLDER }), wrongNetwork);
  await assert.rejects(
    port.registeredId({ idempotencyKey: KEY, status: 'included', txHash: TX }, BASE_SEPOLIA, URI),
    wrongNetwork,
  );
  assert.deepEqual(map.get(KEY), mainnetRow, 'the mainnet row is untouched');
});

test('identity keys: a hand-over key keeps ~<id> inside its base key', () => {
  const agent = '6f1c2a4e-1b2c-4d5e-8f90-123456789abc';
  const first = `identity:transfer:8453:${agent}~42`;
  assert.equal(attemptOf(first), 0);
  assert.equal(attemptOf(`${first}:1`), 1);
  assert.equal(attemptOf(`${first}:12`), 12);
  assert.equal(attemptOf(`${first}:0`), null, 'attempt numbers start at 1');
  assert.equal(attemptOf(`${first}:1:2`), null);
  assert.equal(firstAttemptKey(first), first);
  assert.equal(firstAttemptKey(`${first}:3`), first);
  assert.equal(identityNonceLane(`${first}:3`), identityNonceLane(first), 'one lane per step');
  assert.notEqual(
    identityNonceLane(`identity:transfer:8453:${agent}~43`),
    identityNonceLane(first),
    'another identity is another step',
  );
});

test('registeredIds reads tokenURI at the receipt block', async () => {
  const { client, reads } = scriptedChain({
    receipt: { blockNumber: BLOCK, blockHash: BLOCK_HASH, logs: [mint(9n)] },
    // The holder changed the URI after the mint: only the read at the block still matches.
    tokenUri: (_id, blockNumber) =>
      blockNumber === BLOCK ? URI : 'https://centralcity.ai/a/new001',
  });
  const ids = await registeredIds(client, { network: mainnet }, registration(), [URI]);
  assert.equal(ids.get(URI), 9n);
  assert.deepEqual(reads, [{ functionName: 'tokenURI', blockNumber: BLOCK }]);
});
