import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbi,
  zeroAddress,
  type Hex,
  type PublicClient,
} from 'viem';
import type { Database } from '../server/database.js';
import {
  BASE_IDENTITY_PROVISIONAL_SQL,
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  baseShortIdsMigration,
} from '../server/base/schema.js';
import {
  createIdentityService,
  handoverKey,
  registerKey,
  type IdentityEvent,
} from '../server/base/identity/service.js';
import { identityRegistryAbi } from '../server/base/chain/identity-chain.js';
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
import { BASE_MAINNET, baseNetwork, type Address } from '../shared/base/chains.js';
import { shortAgentUri } from '../shared/base/short-id.js';

// The REAL chain port (createIdentityChainPort) wired into the REAL identity service, against a
// simulated chain (no network, no keys): the register operation is already stored in the port's
// operation store as INCLUDED, and the service proves its mint only through the port's
// mintEvidence. Helpers are the minimum copied from base-chain-identity-evidence.test.ts.

const env = { CITY_BASE_MAINNET: '1' };
const mainnet = baseNetwork(BASE_MAINNET, env)!;
const registry = mainnet.contracts.identityRegistry!;
const entryPoint = mainnet.contracts.entryPointV06;
const AGENT = 'a1';
/** The agent's spender account: it sent the register operation and the mint went to it. */
const SPENDER = '0x1111111111111111111111111111111111111111' as Address;
/** The agent's own wallet (the hand-over destination). */
const WALLET = '0x5555555555555555555555555555555555555555' as Address;
const SHORT = 'abc123';
const URI = shortAgentUri(SHORT);
const OP_HASH = `0x${'aa'.repeat(32)}` as Hex;
const TX = `0x${'cc'.repeat(32)}` as Hex;
const BLOCK = 1000n;
const BLOCK_HASH = `0x${'bb'.repeat(32)}` as Hex;
const MINTED = 99029n;
const KEY = registerKey(AGENT, BASE_MAINNET);

const entryPointEvents = parseAbi([
  'event BeforeExecution()',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);
type RawLog = { address: Address; topics: Hex[]; data: Hex };

/** One handleOps bundle holding only our operation, which minted exactly one id to the spender. */
const ourBundle = (id: bigint): RawLog[] => [
  {
    address: entryPoint,
    topics: encodeEventTopics({ abi: entryPointEvents, eventName: 'BeforeExecution' }) as Hex[],
    data: '0x',
  },
  {
    address: registry,
    topics: encodeEventTopics({
      abi: identityRegistryAbi,
      eventName: 'Transfer',
      args: { from: zeroAddress, to: SPENDER, tokenId: id },
    }) as Hex[],
    data: '0x',
  },
  {
    address: entryPoint,
    topics: encodeEventTopics({
      abi: entryPointEvents,
      eventName: 'UserOperationEvent',
      args: { userOpHash: OP_HASH, sender: SPENDER, paymaster: zeroAddress },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
      [5n, true, 1n, 1n],
    ),
  },
];

/** The hand-over's operation (handoverKey(X)) and where its receipt landed. */
const HANDOVER_OP_HASH = `0x${'ab'.repeat(32)}` as Hex;
const HANDOVER_TX = `0x${'cd'.repeat(32)}` as Hex;
const HANDOVER_NONCE = 7n;
interface HandoverScript {
  /** The block the hand-over's receipt names, and that receipt's block hash. */
  block: bigint;
  receiptHash: Hex;
  /** The canonical hash at `block` when it is not BLOCK (BLOCK always reads as the mint's). */
  canonicalHash?: Hex;
  /** The node fails to read the hand-over's receipt. */
  readError?: boolean;
  /**
   * The hand-over executed (success=true, the id moved to the agent's wallet) and is final;
   * otherwise its UserOperation reverted and the revert is final.
   */
  executed?: boolean;
}

/** The finalized block and the registry as read pinned to it (the port's identityAt). */
interface FinalizedScript {
  number: bigint;
  hash: Hex;
  /** The hash the node serves when the same height is read again after the registry reads. */
  hashAfter?: Hex;
  /** ownerOf(X) at the finalized block (default: the agent's wallet). */
  owner?: Address;
  /** tokenURI(X) at the finalized block (default: the agent's URI). */
  tokenUri?: string;
  /** Registry reads pinned to the finalized block fail (a node error, not a revert). */
  readError?: boolean;
}

/**
 * The hand-over's bundle: its UserOperation either moved X from the spender to the agent's wallet
 * (success=true), or ran and reverted (success=false) and nothing moved.
 */
const handoverBundle = (executed: boolean): RawLog[] => [
  {
    address: entryPoint,
    topics: encodeEventTopics({ abi: entryPointEvents, eventName: 'BeforeExecution' }) as Hex[],
    data: '0x',
  },
  ...(executed
    ? [
        {
          address: registry,
          topics: encodeEventTopics({
            abi: identityRegistryAbi,
            eventName: 'Transfer',
            args: { from: SPENDER, to: WALLET, tokenId: MINTED },
          }) as Hex[],
          data: '0x' as Hex,
        },
      ]
    : []),
  {
    address: entryPoint,
    topics: encodeEventTopics({
      abi: entryPointEvents,
      eventName: 'UserOperationEvent',
      args: { userOpHash: HANDOVER_OP_HASH, sender: SPENDER, paymaster: zeroAddress },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
      [HANDOVER_NONCE, executed, 1n, 1n],
    ),
  },
];

/**
 * The simulated chain: one receipt for TX (and, when scripted, one for the hand-over), tag
 * blocks, the block hash at each height and registry reads.
 */
function scriptedChain(s: {
  canonicalHash?: Hex;
  handover?: HandoverScript;
  finalized?: FinalizedScript;
}) {
  const reads: { functionName: string; blockNumber: bigint | undefined }[] = [];
  const mintReceipt = () => ({
    transactionHash: TX,
    blockNumber: BLOCK,
    blockHash: BLOCK_HASH,
    status: 'success',
    logs: ourBundle(MINTED).map((log, logIndex) => ({
      ...log,
      logIndex,
      blockNumber: BLOCK,
      blockHash: BLOCK_HASH,
      transactionHash: TX,
    })),
  });
  const client = {
    getBlockNumber: async () => BLOCK + 20n,
    getBlock: async (args: { blockTag?: string; blockNumber?: bigint } = {}) => {
      // By default included, below the safe head and not finalized: the mint is provisional.
      if (args.blockTag === 'finalized')
        return s.finalized
          ? { number: s.finalized.number, hash: s.finalized.hash }
          : { number: BLOCK - 5n, hash: `0x${'01'.repeat(32)}` };
      // The finalized height read again (identityAt's same-block check after its reads).
      if (s.finalized && args.blockNumber === s.finalized.number)
        return { number: args.blockNumber, hash: s.finalized.hashAfter ?? s.finalized.hash };
      if (args.blockTag === 'safe') return { number: BLOCK - 1n, hash: `0x${'01'.repeat(32)}` };
      if (
        args.blockNumber !== undefined &&
        s.handover?.canonicalHash &&
        args.blockNumber === s.handover.block &&
        args.blockNumber !== BLOCK
      )
        return { number: args.blockNumber, hash: s.handover.canonicalHash };
      if (args.blockNumber !== undefined)
        return { number: args.blockNumber, hash: s.canonicalHash ?? BLOCK_HASH };
      return { number: BLOCK + 20n, hash: `0x${'02'.repeat(32)}` };
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const h = s.handover;
      if (h && hash === HANDOVER_TX) {
        if (h.readError) throw new Error('node unavailable');
        return {
          transactionHash: HANDOVER_TX,
          blockNumber: h.block,
          blockHash: h.receiptHash,
          // The bundle transaction succeeded (the UserOperation inside it may have reverted).
          status: 'success',
          logs: handoverBundle(h.executed === true).map((log, logIndex) => ({
            ...log,
            logIndex,
            blockNumber: h.block,
            blockHash: h.receiptHash,
            transactionHash: HANDOVER_TX,
          })),
        };
      }
      return mintReceipt();
    },
    readContract: async (args: { functionName: string; args: [bigint]; blockNumber?: bigint }) => {
      reads.push({ functionName: args.functionName, blockNumber: args.blockNumber });
      const f = s.finalized;
      if (f && args.blockNumber === f.number) {
        if (f.readError) throw new Error('node unavailable');
        if (args.functionName === 'tokenURI') return f.tokenUri ?? URI;
        if (args.functionName === 'ownerOf') return f.owner ?? WALLET;
      }
      if (args.functionName === 'tokenURI') return URI;
      // At the latest block X is held by the wallet once the hand-over executed.
      if (args.functionName === 'ownerOf') return s.handover?.executed ? WALLET : SPENDER;
      if (args.functionName === 'getNonce') return 5n;
      throw new Error(`unexpected read ${args.functionName}`);
    },
    getLogs: async () => [],
    getCode: async () => {
      throw new Error('nothing is built or signed in these scenarios');
    },
  } as unknown as PublicClient;
  return { client, reads };
}

function memoryOps(rows: StoredOperation[]) {
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

/** A bundler that knows only our operation's receipt, and records anything sent or prepared. */
function scriptedBundler() {
  const sent: string[] = [];
  const receipt: BundlerReceipt = {
    success: true,
    txHash: TX,
    blockNumber: BLOCK,
    actualGasUsed: 1n,
    actualGasCost: 1n,
  };
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

/** The register operation as the port stored it when the service's register op was submitted. */
const registration = (status: 'included' | 'final' = 'included'): StoredOperation => ({
  idempotencyKey: KEY,
  intentHash: registerIntentHash(BASE_MAINNET, SPENDER, URI),
  chainId: BASE_MAINNET,
  kind: 'register',
  sender: SPENDER,
  signer: '0x2222222222222222222222222222222222222222',
  nonce: '5',
  userOpHash: OP_HASH,
  signedOperation: JSON.stringify({
    sender: SPENDER,
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
  }),
  status,
  txHash: TX,
  blockNumber: BLOCK.toString(10),
  gasUsed: '1',
  feeWei: '1',
  maxCostWei: '1',
  submittedBlock: (BLOCK - 10n).toString(10),
  errorCode: null,
});

/**
 * The first hand-over of MINTED (handoverKey(X)) as the port stored it: it landed at `block` and
 * either executed and is final, or its UserOperation reverted (the id was not minted there yet)
 * and the revert is final.
 */
const storedHandover = (block: bigint, executed = false): StoredOperation => ({
  idempotencyKey: handoverKey(AGENT, BASE_MAINNET, MINTED),
  intentHash: transferIntentHash(BASE_MAINNET, SPENDER, MINTED, WALLET),
  chainId: BASE_MAINNET,
  kind: 'transfer',
  sender: SPENDER,
  signer: '0x2222222222222222222222222222222222222222',
  nonce: HANDOVER_NONCE.toString(10),
  userOpHash: HANDOVER_OP_HASH,
  signedOperation: JSON.stringify({
    sender: SPENDER,
    nonce: HANDOVER_NONCE.toString(10),
    initCode: '0x',
    callData: '0x',
    callGasLimit: '1',
    verificationGasLimit: '1',
    preVerificationGas: '1',
    maxFeePerGas: '1',
    maxPriorityFeePerGas: '1',
    paymasterAndData: '0x',
    signature: '0x5252',
  }),
  status: executed ? 'final' : 'failed',
  txHash: HANDOVER_TX,
  blockNumber: block.toString(10),
  gasUsed: '1',
  feeWei: '1',
  maxCostWei: '1',
  submittedBlock: (block - 3n).toString(10),
  errorCode: executed ? null : 'USEROP_REVERTED',
});

/**
 * A PGlite DB with the migrations the identity service needs, the agent's wallet and short id,
 * optionally the identity row with the register operation already pinned as the mint evidence,
 * and the real port on the simulated chain with the stored registration.
 */
async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  options: {
    pinned: boolean;
    canonicalHash?: Hex;
    /** The register operation is final (the mint's id is the final id). */
    registerFinal?: boolean;
    /**
     * A first hand-over of MINTED was bound while the mint was provisional and stored as scripted
     * here. Reverted: the mint was then re-included at BLOCK. Executed: the mint stayed at BLOCK.
     */
    handover?: HandoverScript;
    /** The finalized block and the registry reads pinned to it. */
    finalized?: FinalizedScript;
  },
) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(baseShortIdsMigration.sql);
  await pg.exec(BASE_IDENTITY_PROVISIONAL_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  await db.query(
    `INSERT INTO base_wallets VALUES ('w1',$1,'ws',$2,$3,'0x${'2'.repeat(40)}',$4,'v1:k','{}',
      'derived',1,1)`,
    [AGENT, BASE_MAINNET, WALLET, SPENDER],
  );
  await db.query('INSERT INTO base_short_ids VALUES ($1, $2, 1)', [SHORT, AGENT]);
  if (options.pinned)
    // Right after the service's register stage fenced the included operation: the mint is pinned
    // on the register key, nothing verified yet.
    await db.query(
      `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
         agent_card_uri, owner_of_identity, state, op_id, tx_hash, updated_at, started_at,
         register_op_id, mint_op_id)
       VALUES ($1, $2, 'ws', $3, $4, $5, 'submitted', $6, $7, 1000, 1000, $6, $6)`,
      [AGENT, BASE_MAINNET, registry, URI, SPENDER, KEY, TX],
    );
  if (options.handover?.executed)
    // After an earlier advance: the mint was verified (provisional) at BLOCK and the hand-over of
    // X is bound and was sent under handoverKey(X).
    await db.query(
      `UPDATE base_identities SET op_id = $2, transfer_op_id = $2, handover_id = $3::numeric,
         provisional_agent_id = $3::numeric, mint_tx_hash = $4, mint_block = $5::bigint,
         mint_block_hash = $6, mint_finality = 'included', mint_seen_at = 1100, evidence_rev = 3
       WHERE agent_id = $1`,
      [
        AGENT,
        handoverKey(AGENT, BASE_MAINNET, MINTED),
        MINTED.toString(10),
        TX,
        BLOCK.toString(10),
        BLOCK_HASH,
      ],
    );
  else if (options.handover)
    // The earlier provisional binding: the mint was first seen in another block (since reorged
    // out, so it is lost), and the hand-over of that id is bound and was sent under handoverKey(X).
    await db.query(
      `UPDATE base_identities SET op_id = $2, transfer_op_id = $2, handover_id = $3::numeric,
         provisional_agent_id = $3::numeric, mint_tx_hash = $4, mint_block = $5::bigint,
         mint_block_hash = $6, mint_finality = 'included', mint_seen_at = 1100,
         mint_lost_at = 1500, evidence_rev = 3
       WHERE agent_id = $1`,
      [
        AGENT,
        handoverKey(AGENT, BASE_MAINNET, MINTED),
        MINTED.toString(10),
        `0x${'c0'.repeat(32)}`,
        (BLOCK - 8n).toString(10),
        `0x${'b0'.repeat(32)}`,
      ],
    );

  const { client, reads } = scriptedChain({
    canonicalHash: options.canonicalHash,
    handover: options.handover,
    finalized: options.finalized,
  });
  const ops = memoryOps([
    registration(options.registerFinal ? 'final' : 'included'),
    ...(options.handover
      ? [storedHandover(options.handover.block, options.handover.executed === true)]
      : []),
  ]);
  const { bundler, sent } = scriptedBundler();
  const signerAsked: string[] = [];
  const keystoreUsed: string[] = [];
  const port = createIdentityChainPort({
    network: mainnet,
    client,
    db,
    operations: ops.store,
    bundler,
    keystore: {
      withSigner: async (ref) => {
        keystoreUsed.push(ref);
        throw new Error('no keys in this test');
      },
    },
    // Asked only when the port is about to build and sign a NEW operation (here: the hand-over).
    signerOf: async (ref) => {
      signerAsked.push(ref);
      throw new Error('no keys in this test');
    },
  });
  // Every call into the real port, by method and key (the port itself is not changed).
  const calls: string[] = [];
  /** What the real port's transfer() reported (its describe() of the stored operation). */
  const transfers: Awaited<ReturnType<typeof port.transfer>>[] = [];
  /** Every identityAt call into the real port: its input and its snapshot or error code. */
  const identityAts: {
    input: Parameters<typeof port.identityAt>[0];
    result?: Awaited<ReturnType<typeof port.identityAt>>;
    error?: string;
  }[] = [];
  const traced = {
    register: (input: Parameters<typeof port.register>[0]) => {
      calls.push(`register ${input.operationKey}`);
      return port.register(input);
    },
    registeredId: port.registeredId,
    transfer: async (input: Parameters<typeof port.transfer>[0]) => {
      calls.push(`transfer ${input.operationKey}`);
      const reported = await port.transfer(input);
      transfers.push(reported);
      return reported;
    },
    mintEvidence: (input: Parameters<typeof port.mintEvidence>[0]) => {
      calls.push(`mintEvidence ${input.operationKey}`);
      return port.mintEvidence(input);
    },
    identityAt: async (input: Parameters<typeof port.identityAt>[0]) => {
      calls.push(`identityAt ${input.id} ${input.blockTag}`);
      try {
        const result = await port.identityAt(input);
        identityAts.push({ input, result });
        return result;
      } catch (error) {
        identityAts.push({ input, error: (error as { code?: string }).code ?? 'error' });
        throw error;
      }
    },
  };
  const logs: IdentityEvent[] = [];
  const svc = createIdentityService({
    db,
    chain: traced,
    env,
    now: () => 2_000_000,
    log: (event) => logs.push(event),
  });
  const row = async () =>
    (
      await db.query<{
        state: string;
        mint_op_id: string | null;
        provisional_agent_id: string | null;
        mint_tx_hash: string | null;
        mint_block: string | null;
        mint_block_hash: string | null;
        mint_finality: string | null;
        mint_lost_at: string | null;
        transfer_op_id: string | null;
        handover_id: string | null;
        handover_tx_hash: string | null;
        erc8004_agent_id: string | null;
        op_id: string | null;
        owner_of_identity: string | null;
        handover_block: string | null;
        handover_block_hash: string | null;
        handover_finality: string | null;
        destination_mismatch: string | null;
      }>(
        `SELECT state, mint_op_id, provisional_agent_id::text AS provisional_agent_id,
           mint_tx_hash, mint_block::text AS mint_block, mint_block_hash, mint_finality,
           mint_lost_at::text AS mint_lost_at, transfer_op_id, handover_id::text AS handover_id,
           handover_tx_hash, erc8004_agent_id::text AS erc8004_agent_id, op_id,
           owner_of_identity, handover_block::text AS handover_block, handover_block_hash,
           handover_finality, destination_mismatch
         FROM base_identities WHERE agent_id = $1`,
        [AGENT],
      )
    ).rows[0];
  return {
    svc,
    row,
    ops,
    sent,
    reads,
    calls,
    logs,
    signerAsked,
    keystoreUsed,
    transfers,
    identityAts,
  };
}

test('wiring: the real port proves an included mint and the service binds it as provisional', async (t) => {
  const ctx = await setup(t, { pinned: true });
  const view = await ctx.svc.advance(AGENT, BASE_MAINNET);

  assert.equal(view.state, 'submitted');
  assert.equal(view.provisionalAgentId, MINTED.toString(10));
  assert.equal(view.erc8004AgentId, null, 'an included mint is never the final id');
  assert.ok(view.stage === 'handing_over' || view.stage === 'finalizing', view.stage);
  assert.equal(view.mintTxHash, TX);

  // The evidence came from the real port: the stored registration under the register key, its
  // receipt, tokenURI at the receipt block and the holder at the latest block.
  assert.equal(ctx.calls[0], `mintEvidence ${KEY}`);
  assert.ok(!ctx.calls.some((call) => call.startsWith('register')), 'register() never called');
  const registryReads = ctx.reads.filter((r) => r.functionName !== 'getNonce');
  assert.deepEqual(registryReads, [
    { functionName: 'tokenURI', blockNumber: BLOCK },
    { functionName: 'ownerOf', blockNumber: undefined },
  ]);
  const r = await ctx.row();
  assert.equal(r.mint_op_id, KEY);
  assert.equal(r.provisional_agent_id, MINTED.toString(10));
  assert.equal(r.mint_tx_hash, TX);
  assert.equal(r.mint_block, BLOCK.toString(10));
  assert.equal(r.mint_block_hash, BLOCK_HASH, 'bound by the receipt block hash');
  assert.equal(r.mint_finality, 'included', 'below the safe head: neither safe nor final');
  assert.equal(r.mint_lost_at, null);
  assert.ok(ctx.logs.some((e) => e.event === 'identity.provisional_bound' && e.txHash === TX));

  // No register signing: the store holds only the stored registration, still included.
  assert.equal(ctx.ops.inserts(), 0);
  assert.equal(ctx.ops.map.get(KEY)!.status, 'included');
  assert.ok(![...ctx.ops.map.keys()].some((key) => key !== KEY && key.includes(':register:')));
  assert.deepEqual(ctx.sent, [], 'nothing sent or rebroadcast');

  // The hand-over is bound (write-ahead) to the key that encodes the provisional id. The real
  // port's transfer() has nothing stored under it, so it would sign a new operation: it stops at
  // the signer lookup (no keys here), the service records the refusal and retries the same key.
  const hand = handoverKey(AGENT, BASE_MAINNET, MINTED);
  assert.equal(r.transfer_op_id, hand);
  assert.equal(r.handover_id, MINTED.toString(10));
  assert.equal(r.handover_tx_hash, null);
  assert.equal(view.stage, 'handing_over');
  assert.deepEqual(ctx.calls, [`mintEvidence ${KEY}`, `transfer ${hand}`]);
  assert.deepEqual(ctx.signerAsked, ['v1:k']);
  assert.deepEqual(ctx.keystoreUsed, [], 'no key was ever used');
  assert.ok(ctx.logs.some((e) => e.event === 'identity.handover_refused'));
  assert.equal(ctx.ops.map.has(hand), false, 'no hand-over stored');
  assert.deepEqual([...ctx.ops.map.keys()], [KEY]);
});

test('wiring: from a fresh row, register() through the real port only reconciles the stored operation', async (t) => {
  const ctx = await setup(t, { pinned: false });
  const view = await ctx.svc.advance(AGENT, BASE_MAINNET);

  assert.equal(view.provisionalAgentId, MINTED.toString(10));
  assert.equal(view.erc8004AgentId, null);
  assert.equal(view.stage, 'handing_over');
  // register() found the operation stored under the key and reported it included (no signer was
  // asked for it); the service fenced it and proved the mint through mintEvidence.
  assert.deepEqual(ctx.calls.slice(0, 2), [`register ${KEY}`, `mintEvidence ${KEY}`]);
  assert.equal((await ctx.row()).mint_op_id, KEY);
  assert.equal(ctx.ops.inserts(), 0);
  assert.equal(ctx.ops.map.get(KEY)!.status, 'included');
  assert.deepEqual([...ctx.ops.map.keys()], [KEY]);
  assert.deepEqual(ctx.sent, []);
  // The only signer lookup is the stopped hand-over (see the first test).
  assert.deepEqual(ctx.signerAsked, ['v1:k']);
  assert.deepEqual(ctx.keystoreUsed, []);
});

test('wiring: a receipt whose block was replaced at the same height is pending, nothing bound or signed', async (t) => {
  const ctx = await setup(t, { pinned: true, canonicalHash: `0x${'ee'.repeat(32)}` });
  const view = await ctx.svc.advance(AGENT, BASE_MAINNET);

  assert.equal(view.state, 'submitted');
  assert.equal(view.provisionalAgentId, null);
  assert.equal(view.erc8004AgentId, null);
  assert.equal(view.stage, 'registering', 'never verified, so still registering');
  // The real port read the receipt and found the block at that height is another one.
  assert.deepEqual(ctx.calls, [`mintEvidence ${KEY}`]);
  const r = await ctx.row();
  assert.equal(r.mint_op_id, KEY, 'the mint stays pinned on the register key');
  assert.equal(r.provisional_agent_id, null);
  assert.equal(r.mint_block_hash, null);
  assert.notEqual(r.mint_lost_at, null, 'the ambiguity clock started');
  assert.equal(r.transfer_op_id, null, 'no hand-over bound');
  assert.ok(!ctx.logs.some((e) => e.event === 'identity.provisional_bound'));

  // Nothing signed or sent, nothing new stored.
  assert.deepEqual(ctx.signerAsked, []);
  assert.deepEqual(ctx.keystoreUsed, []);
  assert.deepEqual(ctx.sent, []);
  assert.equal(ctx.ops.inserts(), 0);
  assert.deepEqual([...ctx.ops.map.keys()], [KEY]);
});

// A hand-over bound while the mint was provisional executed (and reverted: the id did not exist
// there) before the re-included mint, and its revert is final. The real port's describe() must
// report it reverted with the canonical block hash (canonicalOutcome agrees: the bundle succeeded
// and holds exactly one UserOperationEvent for it, its sender and nonce, success=false), so the
// service replaces it exactly once: handoverKey(X, 1), never a third key, nothing re-signed
// under handoverKey(X).
for (const variant of [
  { name: 'in the block before the mint', block: BLOCK - 1n, hash: `0x${'b1'.repeat(32)}` as Hex },
  { name: 'earlier in the mint block (same canonical hash)', block: BLOCK, hash: BLOCK_HASH },
]) {
  test(`wiring: a finalized USEROP_REVERTED hand-over executed before the re-included mint gets exactly one automatic replacement (${variant.name})`, async (t) => {
    const ctx = await setup(t, {
      pinned: true,
      registerFinal: true,
      handover: { block: variant.block, receiptHash: variant.hash, canonicalHash: variant.hash },
    });
    const first = handoverKey(AGENT, BASE_MAINNET, MINTED);
    const replacement = handoverKey(AGENT, BASE_MAINNET, MINTED, 1);
    const before = structuredClone(ctx.ops.map.get(first)!);

    const view = await ctx.svc.advance(AGENT, BASE_MAINNET);
    assert.equal(view.state, 'submitted');
    assert.equal(view.erc8004AgentId, MINTED.toString(10), 'the re-included mint is final');
    let r = await ctx.row();
    assert.equal(r.erc8004_agent_id, MINTED.toString(10));
    assert.equal(r.mint_block, BLOCK.toString(10));
    assert.equal(r.mint_block_hash, BLOCK_HASH);
    assert.equal(r.mint_finality, 'final');

    // The real port reconciled the stored hand-over only and described it from the chain.
    assert.deepEqual(ctx.calls, [`mintEvidence ${KEY}`, `transfer ${first}`]);
    assert.equal(ctx.transfers.length, 1);
    const described = ctx.transfers[0];
    assert.equal(described.idempotencyKey, first);
    assert.equal(described.status, 'failed');
    assert.equal(described.reverted, true);
    assert.equal(described.blockNumber, variant.block.toString(10));
    assert.equal(
      described.blockHash,
      variant.hash,
      'the canonical block hash, read from the chain',
    );
    assert.equal(described.finality, 'final');

    // Decision: exactly one replacement, bound write-ahead on the final id.
    assert.equal(r.transfer_op_id, replacement);
    assert.equal(r.op_id, replacement);
    assert.equal(r.handover_id, MINTED.toString(10));
    assert.equal(r.handover_tx_hash, null);
    assert.ok(!ctx.logs.some((e) => e.event === 'identity.handover_block_conflict'));

    // Further advances only try to send the bound replacement: the real port has nothing stored
    // under it, so it stops at the signer lookup (no keys here); the key never moves on.
    for (let i = 0; i < 2; i++) {
      const again = await ctx.svc.advance(AGENT, BASE_MAINNET);
      assert.equal(again.state, 'submitted');
      r = await ctx.row();
      assert.equal(r.transfer_op_id, replacement, 'never a third key');
    }
    assert.deepEqual(ctx.calls.slice(2), [`transfer ${replacement}`, `transfer ${replacement}`]);
    assert.ok(ctx.calls.every((c) => !c.includes(':2') && !c.startsWith('register')));
    assert.deepEqual(ctx.signerAsked, ['v1:k', 'v1:k'], 'only the signer lookup was attempted');
    assert.deepEqual(ctx.keystoreUsed, [], 'no key was ever used');
    assert.equal(
      ctx.logs.filter((e) => e.event === 'identity.handover_refused').length,
      2,
      'the replacement is refused before signing, never replaced again',
    );

    // Nothing re-signed or stored: handoverKey(X) is untouched, no replacement row exists.
    assert.deepEqual(ctx.ops.map.get(first), before);
    assert.equal(ctx.ops.map.has(replacement), false);
    assert.deepEqual([...ctx.ops.map.keys()].sort(), [first, KEY].sort());
    assert.equal(ctx.ops.inserts(), 0);
    assert.deepEqual(ctx.sent, [], 'nothing sent or rebroadcast');
  });
}

// Same height as the mint, but the hand-over's block hash is unknown: the port's describe()
// returns blockHash null (the receipt read fails, or the canonical block at that height is
// another one than the receipt names). Equal numbers are no evidence of order: the service holds
// (identity.handover_block_conflict) and never binds a replacement.
for (const variant of [
  { name: 'receipt read error', script: { readError: true } },
  { name: 'non-canonical receipt block', script: { receiptHash: `0x${'ee'.repeat(32)}` as Hex } },
]) {
  test(`wiring: same height, hand-over block hash unknown: held, never replaced (${variant.name})`, async (t) => {
    const ctx = await setup(t, {
      pinned: true,
      registerFinal: true,
      handover: { block: BLOCK, receiptHash: BLOCK_HASH, ...variant.script },
    });
    const first = handoverKey(AGENT, BASE_MAINNET, MINTED);
    const before = structuredClone(ctx.ops.map.get(first)!);

    for (let i = 0; i < 3; i++) {
      const view = await ctx.svc.advance(AGENT, BASE_MAINNET);
      assert.equal(view.state, 'submitted', 'held, never failed');
      assert.equal(view.erc8004AgentId, MINTED.toString(10));
      const r = await ctx.row();
      assert.equal(r.transfer_op_id, first, 'never replaced');
      assert.equal(r.handover_id, MINTED.toString(10));
      assert.equal(r.handover_tx_hash, null);
    }
    const r = await ctx.row();
    assert.equal(r.mint_block, BLOCK.toString(10));
    assert.equal(r.mint_block_hash, BLOCK_HASH, 'the mint itself is proven in the canonical block');

    // The real port described the reverted hand-over at the mint's height without a hash.
    assert.equal(ctx.transfers.length, 3);
    for (const described of ctx.transfers) {
      assert.equal(described.idempotencyKey, first);
      assert.equal(described.status, 'failed');
      assert.equal(described.reverted, true);
      assert.equal(described.blockNumber, BLOCK.toString(10));
      assert.equal(described.blockHash, null);
    }
    assert.equal(
      ctx.logs.filter(
        (e) => e.event === 'identity.handover_block_conflict' && e.code === 'block_hash_mismatch',
      ).length,
      3,
    );
    assert.ok(!ctx.logs.some((e) => e.event === 'identity.handover_refused'));

    // Only the stored hand-over was reconciled: no replacement key, no signer lookup, no keys.
    assert.ok(ctx.calls.every((c) => c === `mintEvidence ${KEY}` || c === `transfer ${first}`));
    assert.ok(!ctx.calls.some((c) => c.includes(`${first}:`)));
    assert.deepEqual(ctx.signerAsked, []);
    assert.deepEqual(ctx.keystoreUsed, []);
    assert.deepEqual(ctx.ops.map.get(first), before);
    assert.deepEqual([...ctx.ops.map.keys()].sort(), [first, KEY].sort());
    assert.equal(ctx.ops.inserts(), 0);
    assert.deepEqual(ctx.sent, []);
  });
}

// The confirmed path through the real port: the register operation and the bound hand-over are
// both final and canonical in the port's store (nothing is signed), and the destination check
// reads the registry at the FINALIZED block through the real identityAt.
const HANDOVER_BLOCK = BLOCK + 2n;
const HANDOVER_HASH = `0x${'b2'.repeat(32)}` as Hex;
const FINALIZED = BLOCK + 10n;
const FINALIZED_HASH = `0x${'fa'.repeat(32)}` as Hex;
const OTHER = '0x9999999999999999999999999999999999999999' as Address;

async function finalHandover(
  t: { after: (fn: () => Promise<unknown>) => void },
  finalized: Partial<FinalizedScript> = {},
) {
  return setup(t, {
    pinned: true,
    registerFinal: true,
    handover: {
      block: HANDOVER_BLOCK,
      receiptHash: HANDOVER_HASH,
      canonicalHash: HANDOVER_HASH,
      executed: true,
    },
    finalized: { number: FINALIZED, hash: FINALIZED_HASH, ...finalized },
  });
}

/** What every final-hand-over case shares, whatever the destination check said. */
function assertFinalHandoverReconciled(ctx: Awaited<ReturnType<typeof finalHandover>>) {
  const hand = handoverKey(AGENT, BASE_MAINNET, MINTED);
  for (const described of ctx.transfers) {
    assert.equal(described.idempotencyKey, hand);
    assert.equal(described.status, 'final');
    assert.equal(described.reverted, false);
    assert.equal(described.blockNumber, HANDOVER_BLOCK.toString(10));
    assert.equal(described.blockHash, HANDOVER_HASH);
    assert.equal(described.finality, 'final');
  }
  // identityAt is only ever asked for the final id at the finalized block.
  assert.ok(ctx.identityAts.length > 0);
  for (const call of ctx.identityAts)
    assert.deepEqual(call.input, { chainId: BASE_MAINNET, id: MINTED, blockTag: 'finalized' });
  // The registry was read pinned to the finalized block: owner first, then the URI.
  const pinned = ctx.reads.filter((r) => r.blockNumber === FINALIZED);
  assert.ok(pinned.length > 0);
  assert.ok(pinned.every((r) => r.functionName === 'ownerOf' || r.functionName === 'tokenURI'));
  // Nothing signed, sent or stored: only the stored operations were reconciled.
  assert.deepEqual(ctx.signerAsked, []);
  assert.deepEqual(ctx.keystoreUsed, []);
  assert.deepEqual(ctx.sent, []);
  assert.equal(ctx.ops.inserts(), 0);
  assert.deepEqual([...ctx.ops.map.keys()].sort(), [hand, KEY].sort());
  assert.equal(ctx.ops.map.get(hand)!.status, 'final');
  assert.equal(ctx.ops.map.get(KEY)!.status, 'final');
  assert.ok(!ctx.calls.some((c) => c.startsWith('register') || c.includes(`${hand}:`)));
}

test('wiring: a final successful hand-over is confirmed through the real identityAt', async (t) => {
  const ctx = await finalHandover(t);
  const hand = handoverKey(AGENT, BASE_MAINNET, MINTED);
  const view = await ctx.svc.advance(AGENT, BASE_MAINNET);

  assert.equal(view.state, 'confirmed');
  assert.equal(view.erc8004AgentId, MINTED.toString(10));
  assert.deepEqual(ctx.calls, [
    `mintEvidence ${KEY}`,
    `transfer ${hand}`,
    `identityAt ${MINTED} finalized`,
  ]);
  assert.deepEqual(ctx.identityAts, [
    {
      input: { chainId: BASE_MAINNET, id: MINTED, blockTag: 'finalized' },
      result: {
        owner: WALLET,
        tokenUri: URI,
        blockNumber: FINALIZED.toString(10),
        blockHash: FINALIZED_HASH,
      },
    },
  ]);
  assert.deepEqual(
    ctx.reads.filter((r) => r.blockNumber === FINALIZED),
    [
      { functionName: 'ownerOf', blockNumber: FINALIZED },
      { functionName: 'tokenURI', blockNumber: FINALIZED },
    ],
  );
  const r = await ctx.row();
  assert.equal(r.state, 'confirmed');
  assert.equal(r.erc8004_agent_id, MINTED.toString(10));
  assert.equal(r.owner_of_identity, WALLET);
  assert.equal(r.transfer_op_id, hand);
  assert.equal(r.op_id, hand);
  assert.equal(r.handover_id, MINTED.toString(10));
  assert.equal(r.handover_tx_hash, HANDOVER_TX);
  assert.equal(r.handover_block, HANDOVER_BLOCK.toString(10));
  assert.equal(r.handover_block_hash, HANDOVER_HASH);
  assert.equal(r.handover_finality, 'final');
  assert.equal(r.destination_mismatch, null);
  assert.equal(r.mint_finality, 'final');
  assert.ok(!ctx.logs.some((e) => e.event.startsWith('identity.destination_')));
  assertFinalHandoverReconciled(ctx);

  // Confirmed is terminal: a later advance asks the port nothing more.
  const calls = ctx.calls.length;
  assert.equal((await ctx.svc.advance(AGENT, BASE_MAINNET)).state, 'confirmed');
  assert.equal(ctx.calls.length, calls);
});

for (const variant of [
  {
    name: 'finalized ownerOf is another address',
    finalized: { owner: OTHER },
    event: 'identity.destination_mismatch',
    code: 'owner_mismatch',
    recheck: 'owner_mismatch',
  },
  {
    name: 'finalized tokenURI is another URI',
    finalized: { tokenUri: shortAgentUri('zzz999') },
    event: 'identity.destination_mismatch',
    code: 'uri_mismatch',
    recheck: 'uri_mismatch',
  },
  {
    name: 'identityAt unavailable (a registry read fails)',
    finalized: { readError: true },
    event: 'identity.destination_unavailable',
    code: 'UNAVAILABLE',
    recheck: null,
  },
  {
    name: 'the finalized block hash changes between reads',
    finalized: { hashAfter: `0x${'fb'.repeat(32)}` as Hex },
    event: 'identity.destination_unavailable',
    code: 'BLOCK_CHANGED',
    recheck: null,
  },
]) {
  test(`wiring: a final hand-over stays submitted when the real identityAt does not prove the destination (${variant.name})`, async (t) => {
    const ctx = await finalHandover(t, variant.finalized);
    const hand = handoverKey(AGENT, BASE_MAINNET, MINTED);

    for (let i = 0; i < 2; i++) {
      const view = await ctx.svc.advance(AGENT, BASE_MAINNET);
      assert.equal(view.state, 'submitted', 'not confirmed, not failed');
      assert.equal(view.erc8004AgentId, MINTED.toString(10), 'the id itself is final');
    }
    const r = await ctx.row();
    assert.equal(r.state, 'submitted');
    assert.equal(r.erc8004_agent_id, MINTED.toString(10));
    assert.equal(r.owner_of_identity, SPENDER, 'the owner is never moved to the wallet');
    assert.equal(r.transfer_op_id, hand, 'the hand-over is never replaced');
    assert.equal(r.handover_tx_hash, HANDOVER_TX, 'the landed hand-over is recorded');
    assert.equal(r.handover_finality, 'final');
    assert.equal(r.destination_mismatch, variant.recheck);

    // Each advance asked the real identityAt once and got the scripted refusal.
    assert.equal(ctx.identityAts.length, 2);
    for (const call of ctx.identityAts) {
      if (variant.recheck === null) {
        assert.equal(call.error, variant.code);
        assert.equal(call.result, undefined);
      } else {
        assert.equal(call.result?.blockNumber, FINALIZED.toString(10));
        assert.equal(call.result?.blockHash, FINALIZED_HASH);
      }
    }
    assert.equal(
      ctx.logs.filter((e) => e.event === variant.event && e.code === variant.code).length,
      2,
    );
    assert.ok(!ctx.logs.some((e) => e.event === 'identity.handover_refused'));
    assertFinalHandoverReconciled(ctx);
  });
}
