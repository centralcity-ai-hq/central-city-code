import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  parseAbi,
  toHex,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Hex,
  type PublicClient,
} from 'viem';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
} from '../server/base/schema.js';
import { BASE_MAINNET, baseNetwork } from '../shared/base/chains.js';
import { createPaymentChain } from '../server/base/chain/payment-chain.js';
import { createReservationLedger } from '../server/base/chain/reservations.js';
import { pgChainOperationStore } from '../server/base/chain/stores.js';
import {
  nonceLaneFor,
  refreshFinality,
  type Bundler,
  type ChainOperationStore,
  type StoredOperation,
} from '../server/base/chain/submit.js';

/*
 * An agent payment signs on its own nonce lane, nonceLaneFor(operationKey); nothing
 * else is ever signed on that lane. So "the lane's nonce moved" means THIS operation landed.
 *
 * The simulated Base mainnet below is consistent: the payment landed in block 1500 (its
 * transaction receipt carries its UserOperationEvent, the lane nonce reads 1 from block 1500 on,
 * also at the finalized block 1800, and every block hash is canonical). The only fault is the one
 * the finding names: the eth_getLogs backend that answers the search has indexed logs only up to
 * block 1400 and answers an empty page (not an error) for anything past that. The bundler has
 * pruned the receipt (eth_getUserOperationReceipt → null).
 *
 * Safe behaviour asserted here: on a lane only this operation can use, "nonce consumed, no event
 * found" must not become a terminal 'failed', and the payment's hold must not be released (the
 * payment moved the USDC; a released hold + a 'failed' status invites a second, real payment).
 * The control tests show the same simulated chain with a caught-up log backend settles the
 * payment as 'final' and consumes the hold, i.e. the fixture is honest.
 */

// The network object only (no endpoint): nothing here reaches a real node.
const network = baseNetwork(BASE_MAINNET, { CITY_BASE_MAINNET: '1' })!;
const ENTRY_POINT = network.contracts.entryPointV06;
const USDC = network.tokens.USDC.address;

const KEY = 'payment:m03-0001';
const LANE = nonceLaneFor(KEY);
const NONCE = LANE << 64n; // sequence 0 in the payment's own lane
const SPENDER = getAddress(`0x${'3c'.repeat(20)}`);
const SIGNER = getAddress(`0x${'2d'.repeat(20)}`);
const AGENT_WALLET = getAddress(`0x${'4b'.repeat(20)}`);
const OWNER = getAddress(`0x${'5a'.repeat(20)}`);
const RECIPIENT = getAddress(`0x${'6e'.repeat(20)}`);
const INTENT = keccak256(toHex('m03-intent-0001'));
const OP_HASH = `0x${'aa'.repeat(32)}` as Hex;
const TX = `0x${'cc'.repeat(32)}` as Hex;

const SUBMITTED = 1000n; // head when the operation was stored
const LANDED = 1500n; // the block the operation actually landed in
const FINALIZED = 1800n; // Base's 'finalized' tag
const HEAD = 2000n;

const blockHash = (n: bigint) => keccak256(toHex(`block-${n}`));
const userOperationEvent = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);

const signedOperation = JSON.stringify({
  sender: SPENDER,
  nonce: NONCE.toString(10),
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

/** The payment's operation as stored before broadcast, accepted by the bundler. */
const submitted = (): StoredOperation => ({
  idempotencyKey: KEY,
  intentHash: INTENT,
  chainId: BASE_MAINNET,
  kind: 'transfer',
  sender: SPENDER,
  signer: SIGNER,
  nonce: NONCE.toString(10),
  userOpHash: OP_HASH,
  signedOperation,
  status: 'submitted',
  txHash: null,
  blockNumber: null,
  gasUsed: null,
  feeWei: null,
  maxCostWei: '0',
  submittedBlock: SUBMITTED.toString(10),
  errorCode: null,
});

/**
 * Base mainnet where the payment landed in LANDED. `logsIndexedTo`: the highest block the
 * answering eth_getLogs backend has indexed; past it, it answers an empty page (the fault).
 */
function chain(opts: { logsIndexedTo: bigint }) {
  const seqAt = (block: bigint) => (block >= LANDED ? 1n : 0n);
  const nonceReads: Array<bigint | 'latest'> = [];
  const logRanges: Array<[bigint, bigint]> = [];
  const client = {
    getBlockNumber: async () => HEAD,
    getBlock: async (args: { blockNumber?: bigint; blockTag?: string } = {}) => {
      if (args.blockNumber !== undefined) {
        assert.ok(args.blockNumber <= HEAD, 'no block above the head');
        return { number: args.blockNumber, hash: blockHash(args.blockNumber) };
      }
      if (args.blockTag === 'finalized') return { number: FINALIZED, hash: blockHash(FINALIZED) };
      return { number: HEAD, hash: blockHash(HEAD) };
    },
    readContract: async (call: {
      address: string;
      functionName: string;
      args: [string, bigint];
      blockNumber?: bigint;
    }) => {
      assert.equal(getAddress(call.address), getAddress(ENTRY_POINT));
      assert.equal(call.functionName, 'getNonce');
      assert.equal(getAddress(call.args[0]), SPENDER);
      assert.equal(call.args[1], LANE, 'only the payment’s own lane is read');
      nonceReads.push(call.blockNumber ?? 'latest');
      return (LANE << 64n) | seqAt(call.blockNumber ?? HEAD);
    },
    getLogs: async (query: { args: { userOpHash: Hex }; fromBlock: bigint; toBlock: bigint }) => {
      logRanges.push([query.fromBlock, query.toBlock]);
      const covers = query.fromBlock <= LANDED && LANDED <= query.toBlock;
      // A backend behind LANDED answers an empty page for the range, not an error.
      if (!covers || query.args.userOpHash !== OP_HASH || LANDED > opts.logsIndexedTo) return [];
      return [
        {
          args: {
            userOpHash: OP_HASH,
            sender: SPENDER,
            paymaster: zeroAddress,
            nonce: NONCE,
            success: true,
            actualGasCost: 1_000n,
            actualGasUsed: 100n,
          },
          transactionHash: TX,
          blockNumber: LANDED,
        },
      ];
    },
    // The node holds the payment's transaction receipt in LANDED (canonical block).
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (hash !== TX) throw new TransactionReceiptNotFoundError({ hash });
      return {
        transactionHash: TX,
        blockNumber: LANDED,
        blockHash: blockHash(LANDED),
        status: 'success',
        logs: [
          {
            address: ENTRY_POINT,
            topics: encodeEventTopics({
              abi: userOperationEvent,
              eventName: 'UserOperationEvent',
              args: { userOpHash: OP_HASH, sender: SPENDER, paymaster: zeroAddress },
            }),
            data: encodeAbiParameters(
              [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
              [NONCE, true, 1_000n, 100n],
            ),
            logIndex: 0,
          },
        ],
      };
    },
  } as unknown as PublicClient;
  return { client, nonceReads, logRanges };
}

/** The bundler pruned the receipt (null); nothing may be resent: the nonce already moved. */
const prunedBundler: Bundler = {
  prepare: async (op) => op,
  send: async () => {
    throw new Error('must not resend: the lane nonce already moved');
  },
  receipt: async () => null,
};

function memoryOps(rows: StoredOperation[]): ChainOperationStore & {
  rows: Map<string, StoredOperation>;
} {
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

const submitDeps = (client: PublicClient, store: ChainOperationStore) => ({
  network,
  client,
  store,
  bundler: prunedBundler,
  signer: {
    address: SIGNER,
    signUserOperation: async (): Promise<Hex> => {
      throw new Error('never signs');
    },
  },
});

/** PGlite with the payment tables, the agent wallet, a held 'payment' reservation and the op. */
async function paymentFixture(t: { after: (fn: () => Promise<unknown>) => void }) {
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
  await pg.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w-1','a-1','ws-1',$1,$2,$3,$4,'v1:k','{}','deployed',0,0)`,
    [BASE_MAINNET, AGENT_WALLET, OWNER, SPENDER],
  );
  // 1 USDC held for the payment before it was signed.
  await pg.query(
    `INSERT INTO base_wallet_reservations (reservation_id, wallet_id, chain_id, token, amount,
       holder_kind, holder_ref, intent_hash, state, created_at, updated_at)
     VALUES ('r-1','w-1',$1,$2,1000000,'payment',$3,$4,'held',1000,1000)`,
    [BASE_MAINNET, USDC, KEY, INTENT],
  );
  const operations = pgChainOperationStore(db);
  await operations.insert(submitted());
  const reservation = async () =>
    (
      await pg.query<{ state: string }>(
        "SELECT state FROM base_wallet_reservations WHERE reservation_id = 'r-1'",
      )
    ).rows[0].state;
  const payments = (client: PublicClient) =>
    createPaymentChain({
      network,
      client,
      db,
      operations,
      bundler: prunedBundler,
      keystore: {} as never,
      signerOf: async () => SIGNER,
      ledger: createReservationLedger({
        chainId: BASE_MAINNET,
        balanceOf: async () => ({ balance: 5_000_000n, blockNumber: HEAD }),
      }),
    });
  return { operations, reservation, payments };
}

const intent = {
  workspaceId: 'ws-1',
  chainId: BASE_MAINNET,
  source: { agentId: 'a-1' },
  to: RECIPIENT,
  token: USDC,
  amount: '1000000',
  intentHash: INTENT,
  operationKey: KEY,
};

// --- controls: the simulated chain is consistent (the payment landed) ---------------------------

test('with a caught-up log backend the landed payment settles final', async () => {
  const store = memoryOps([submitted()]);
  const { client } = chain({ logsIndexedTo: HEAD });
  const row = await refreshFinality(submitDeps(client, store), KEY);
  assert.equal(row?.status, 'final');
  assert.equal(row?.txHash, TX);
  assert.equal(row?.blockNumber, LANDED.toString(10));
});

test('payment-chain status consumes the hold of the landed payment', async (t) => {
  const f = await paymentFixture(t);
  const { client } = chain({ logsIndexedTo: HEAD });
  const receipt = await f.payments(client).status(intent);
  assert.equal(receipt?.status, 'final');
  assert.equal(await f.reservation(), 'consumed');
});

// --- the finding: a lagging log backend turns the landed payment into 'failed' -------------------

test('payment-chain status must keep the hold of a landed payment (no release on a missed log)', async (t) => {
  const f = await paymentFixture(t);
  const { client } = chain({ logsIndexedTo: LANDED - 100n });
  const receipt = await f.payments(client).status(intent);
  const stored = await f.operations.get(KEY);
  const hold = await f.reservation();
  assert.equal(
    hold,
    'held',
    `the 1 USDC hold of a landed payment was ${hold}; status() answered ` +
      `${receipt?.status}/${receipt?.errorCode}, op stored as ${stored?.status}/${stored?.errorCode}`,
  );
  assert.notEqual(
    receipt?.status,
    'failed',
    `city_pay_status would report ${receipt?.status}/${receipt?.errorCode} for a payment that moved the USDC`,
  );
});

test('the recovery cron must keep the hold of a landed payment (no release on a missed log)', async (t) => {
  const f = await paymentFixture(t);
  const { client } = chain({ logsIndexedTo: LANDED - 100n });
  // The reservation was created at 1000 ms; recovery runs after its 10-minute grace.
  const result = await f.payments(client).recover({ now: 1000 + 11 * 60 * 1000 });
  assert.equal(result.checked, 1);
  const stored = await f.operations.get(KEY);
  const hold = await f.reservation();
  assert.equal(
    hold,
    'held',
    `the recovery cron left the hold ${hold} for a payment that landed ` +
      `(op stored as ${stored?.status}/${stored?.errorCode}, settled=${result.settled})`,
  );
  assert.notEqual(stored?.status, 'failed', `stored as ${stored?.status}/${stored?.errorCode}`);
});
