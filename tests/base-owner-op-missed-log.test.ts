import assert from 'node:assert/strict';
import test from 'node:test';
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
import { BASE_MAINNET, baseNetwork } from '../shared/base/chains.js';
import { laneKey } from '../shared/base/lanes.js';
import { createOwnerOperationsPort } from '../server/base/chain/owner-ops.js';
import type { Bundler, ChainOperationStore, StoredOperation } from '../server/base/chain/submit.js';

/*
 * CCA-108: a laned owner operation (a withdrawal, a Base Pay payment, a rating) runs on its own
 * nonce lane, laneKey(withdrawalId); only it and its cancel (the no-op at the same nonce) are ever
 * signed there. The simulated Base mainnet is consistent: the withdrawal landed in block 1500 (its
 * receipt carries its UserOperationEvent, the lane nonce reads 1 from 1500 on, also at the
 * finalized block 1800). The only fault: the eth_getLogs backend has indexed logs only to 1400 and
 * answers an empty page past it, and the bundler pruned the receipt.
 *
 * Safe behaviour: with no cancel recorded as landed at that nonce, "nonce consumed, no event
 * found" never becomes 'failed' (the withdrawal service would release the holds of a withdrawal
 * that moved the funds). With the cancel recorded as landed, the original is replaced: failed.
 */

const network = baseNetwork(BASE_MAINNET, { CITY_BASE_MAINNET: '1' })!;
const ENTRY_POINT = network.contracts.entryPointV06;

const WITHDRAWAL = 'wd-cca108-0001';
const LANE = laneKey(WITHDRAWAL);
const NONCE = LANE << 64n;
const KEY = `withdraw:${WITHDRAWAL}`;
const CANCEL_KEY = `withdraw_cancel:${WITHDRAWAL}`;
const WALLET = getAddress(`0x${'4b'.repeat(20)}`);
const OWNER = getAddress(`0x${'5a'.repeat(20)}`);
const OP_HASH = `0x${'aa'.repeat(32)}` as Hex;
const CANCEL_HASH = `0x${'ab'.repeat(32)}` as Hex;
const TX = `0x${'cc'.repeat(32)}` as Hex;

const SUBMITTED = 1000n;
const LANDED = 1500n;
const FINALIZED = 1800n;
const HEAD = 2000n;

const blockHash = (n: bigint) => keccak256(toHex(`block-${n}`));
const userOperationEvent = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);

const signed = JSON.stringify({
  sender: WALLET,
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

const op = (patch: Partial<StoredOperation> = {}): StoredOperation => ({
  idempotencyKey: KEY,
  intentHash: keccak256(toHex('cca108-intent')),
  chainId: BASE_MAINNET,
  kind: 'withdraw',
  sender: WALLET,
  signer: OWNER,
  nonce: NONCE.toString(10),
  userOpHash: OP_HASH,
  signedOperation: signed,
  status: 'submitted',
  txHash: null,
  blockNumber: null,
  gasUsed: null,
  feeWei: null,
  maxCostWei: '0',
  submittedBlock: SUBMITTED.toString(10),
  errorCode: null,
  ...patch,
});

function chain(opts: { logsIndexedTo: bigint }): PublicClient {
  const seqAt = (block: bigint) => (block >= LANDED ? 1n : 0n);
  return {
    getBlockNumber: async () => HEAD,
    getBlock: async (args: { blockNumber?: bigint; blockTag?: string } = {}) => {
      if (args.blockNumber !== undefined)
        return { number: args.blockNumber, hash: blockHash(args.blockNumber) };
      if (args.blockTag === 'finalized') return { number: FINALIZED, hash: blockHash(FINALIZED) };
      return { number: HEAD, hash: blockHash(HEAD) };
    },
    readContract: async (call: {
      functionName: string;
      args: [string, bigint];
      blockNumber?: bigint;
    }) => {
      assert.equal(call.functionName, 'getNonce');
      assert.equal(call.args[1], LANE, 'only the withdrawal’s own lane is read');
      return (LANE << 64n) | seqAt(call.blockNumber ?? HEAD);
    },
    getLogs: async (query: { args: { userOpHash: Hex }; fromBlock: bigint; toBlock: bigint }) => {
      const covers = query.fromBlock <= LANDED && LANDED <= query.toBlock;
      if (!covers || query.args.userOpHash !== OP_HASH || LANDED > opts.logsIndexedTo) return [];
      return [
        {
          args: {
            userOpHash: OP_HASH,
            sender: WALLET,
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
              args: { userOpHash: OP_HASH, sender: WALLET, paymaster: zeroAddress },
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
}

const prunedBundler: Bundler = {
  prepare: async (o) => o,
  send: async () => {
    throw new Error('must not resend: the lane nonce already moved');
  },
  receipt: async () => null,
};

function memoryOps(rows: StoredOperation[]): ChainOperationStore {
  const map = new Map(rows.map((r) => [r.idempotencyKey, { ...r }]));
  return {
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

const portOf = (client: PublicClient, store: ChainOperationStore) =>
  createOwnerOperationsPort({ network, client, store, bundler: prunedBundler });

/** Refreshes a few times, as polls of the withdrawal would. */
async function poll(port: ReturnType<typeof portOf>, lane: { key: bigint; peers: string[] }) {
  let row: StoredOperation | null = null;
  for (let i = 0; i < 4; i += 1) row = await port.refresh(KEY, lane);
  return row;
}

test('control: with a caught-up log backend the landed withdrawal settles final', async () => {
  const store = memoryOps([op()]);
  const row = await poll(portOf(chain({ logsIndexedTo: HEAD }), store), {
    key: LANE,
    peers: [CANCEL_KEY],
  });
  assert.equal(row?.status, 'final');
  assert.equal(row?.txHash, TX);
});

test('a landed laned withdrawal is never failed after a missed log search (CCA-108)', async () => {
  const store = memoryOps([op()]);
  const row = await poll(portOf(chain({ logsIndexedTo: LANDED - 100n }), store), {
    key: LANE,
    peers: [CANCEL_KEY],
  });
  assert.notEqual(
    row?.status,
    'failed',
    `a withdrawal that moved the funds was stored ${row?.status}/${row?.errorCode}`,
  );
  // An unsigned or unsent cancel on the lane proves nothing either.
  const withCancel = memoryOps([
    op(),
    op({ idempotencyKey: CANCEL_KEY, kind: 'withdraw_cancel', userOpHash: CANCEL_HASH }),
  ]);
  const again = await poll(portOf(chain({ logsIndexedTo: LANDED - 100n }), withCancel), {
    key: LANE,
    peers: [CANCEL_KEY],
  });
  assert.notEqual(again?.status, 'failed');
});

test('with its cancel recorded as landed at that nonce the original is replaced (failed)', async () => {
  const store = memoryOps([
    op(),
    op({
      idempotencyKey: CANCEL_KEY,
      kind: 'withdraw_cancel',
      userOpHash: CANCEL_HASH,
      status: 'final',
      txHash: TX,
      blockNumber: LANDED.toString(10),
    }),
  ]);
  const row = await poll(portOf(chain({ logsIndexedTo: LANDED - 100n }), store), {
    key: LANE,
    peers: [CANCEL_KEY],
  });
  assert.equal(row?.status, 'failed');
  assert.equal(row?.errorCode, 'NONCE_CONSUMED');
});
