import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import pgDriver from 'pg';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import {
  concat,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  keccak256,
  numberToHex,
  parseAbi,
  parseAbiItem,
  recoverAddress,
  toHex,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Hex,
  type PublicClient,
} from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Database } from '../server/database.js';
import { postgresDatabase } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
  BASE_WALLET_PAYMENTS_SQL,
  BASE_WALLET_VAULT_SQL,
  BASE_WALLET_WITHDRAWALS_SQL,
  BASE_WALLET_RATINGS_SQL,
  BASE_SPONSOR_EXPOSURE_SQL,
  BASE_TABLES,
  BASE_WALLET_WITHDRAWALS_SAFE_SQL,
  BASE_WALLET_LANES_SQL,
  BASE_WALLET_LIMITS_SQL,
  BASE_WALLET_ONE_UNSIGNED_SQL,
  baseWalletWithdrawalsMigration,
  registerBaseMigration,
} from '../server/base/schema.js';
import { listMigrations } from '../server/migrations.js';
import { registerBaseWalletRoutes } from '../server/base/wallet/routes.js';
import {
  registerWithdrawalRoutes,
  RETRYABLE_CODES,
} from '../server/base/wallet/withdraw-routes.js';
import { accountIndexFor } from '../server/base/wallet/service.js';
import type { ChainRuntime } from '../server/base/identity/routes.js';
import type { BalanceReader } from '../server/base/chain/balances.js';
import {
  agentWalletRecipe,
  createAccountCall,
  deriveAddressLocal,
} from '../server/base/chain/derive.js';
import { walletSignature } from '../server/base/chain/permissions.js';
import { rpcBundler } from '../server/base/chain/rpc-bundler.js';
import { withLiveReads } from '../server/base/chain/rpc-budget.js';
import { pgChainOperationStore } from '../server/base/chain/stores.js';
import {
  createOwnerOperationsPort,
  OWNER_NONCE_KEY,
  OwnerOperationError,
} from '../server/base/chain/owner-ops.js';
import { maxCostWei, ownerOperationSignature } from '../server/base/chain/submit.js';
import {
  BASE_MAINNET,
  BASE_NETWORKS,
  BASE_SEPOLIA,
  NATIVE_ETH,
  type Address,
} from '../shared/base/chains.js';
import {
  SPONSOR_DATA_BYTES,
  SPONSOR_PAYMASTERS,
  SPONSOR_SEND_MARGIN_MS,
  sponsoredWithoutCharge,
} from '../shared/base/paymasters.js';
import {
  decodeOwnerCall,
  noopCall,
  ownerOperationHash,
  userOperationFromRpc,
  userOperationToRpc,
  withdrawalCall,
  WITHDRAWAL_SIGNATURE_TTL_MS,
  type RpcUserOperation,
} from '../shared/base/withdraw.js';
import { laneKey, laneNonce } from '../shared/base/lanes.js';
import {
  createWithdrawalService,
  lanesCap,
  lanesEnabled,
  lanesRevertBudget,
  sponsorBudget,
  sponsorBudgetWarnings,
  type WithdrawalService,
} from '../server/base/wallet/withdrawals.js';
import { OTHER_EXPECTED, WALLET_EXPECTED, WALLET_NET } from './wallet-network-fixture.js';

/**
 * Owner withdrawals (Operation Base Wallet W2) end to end, without any network: the routes, the
 * service and the chain module's durable path run for real on PGlite; Base is a fake node, and the
 * bundler/paymaster is a local JSON-RPC stand-in that checks every operation as the wallet would
 * (nonce, deployment, the owner's signature over the raw userOpHash inside the SignatureWrapper).
 * The owner key is a throwaway local account; all other values are synthetic.
 */
/** The wallet network (shared/base/wallet-network.ts): Base Sepolia or Base. */
const NETWORK = WALLET_NET;
const ENTRY_POINT = NETWORK.contracts.entryPointV06;
const USDC = NETWORK.tokens.USDC.address;
const SPM = NETWORK.contracts.spendPermissionManager;
const PAYMASTER = getAddress(`0x${'7a'.repeat(20)}`);
/**
 * The synthetic allowlist the port gets here, on the wallet network, in place of the pinned one
 * (production pins one paymaster on Base and none on Base Sepolia).
 */
const SPONSORS = { [WALLET_EXPECTED.chainId]: [PAYMASTER] };
type SponsorAnswer = 'pinned' | 'token' | 'foreign' | 'short';
/**
 * paymasterAndData in the pinned verifying paymaster's layout (shared/base/paymasters.ts): 129
 * bytes of fields and a 65-byte signature; n makes each answer unique, as a real validity window.
 */
function sponsorData(
  answer: SponsorAnswer,
  n: number,
  paymaster: Address = PAYMASTER,
  validUntil = 0,
): Hex {
  const data = concat([
    answer === 'foreign' ? getAddress(`0x${'7b'.repeat(20)}`) : paymaster,
    numberToHex(validUntil, { size: 6 }),
    numberToHex(0, { size: 6 }),
    numberToHex(n, { size: 16 }),
    '0x000000',
    answer === 'token' ? USDC : zeroAddress,
    zeroAddress,
    numberToHex(0, { size: 32 }),
    numberToHex(0, { size: 6 }),
    `0x${'ab'.repeat(65)}`,
  ]);
  return answer === 'short' ? (data.slice(0, -2) as Hex) : data;
}
const SPENDER = getAddress(`0x${'3c'.repeat(20)}`);
const AGENT = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const AI_AGENT = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const NOW = 1_760_000_000_000;
const DEST = getAddress(`0x${'5e'.repeat(20)}`);
const SEQ_MASK = 2n ** 64n - 1n;
/**
 * How far behind the head a block is final on the fake node, on either network: Base Sepolia's
 * confirmations, and the block the fake answers for Base's 'finalized' tag.
 */
const SETTLE_DEPTH = 3n;
/** The mock bundler's gas answer: unsponsored, an operation can cost (100k + 200k + 50k) gas. */
const UNSPONSORED_GAS = 350_000n;
/** The cost cap the port gets unless a test sets one: Base never runs owner operations without. */
const FEE_BUDGET = 10n ** 18n;
const executeAbi = parseAbi(['function execute(address target, uint256 value, bytes data)']);
const transferAbi = parseAbi(['function transfer(address to, uint256 amount)']);
const nonceAbi = parseAbi([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
]);
const KDF = { alg: 'scrypt', N: 2 ** 17, r: 8, p: 1, salt: `0x${'ab'.repeat(16)}` };
const CIPHER = { alg: 'AES-256-GCM', iv: `0x${'cd'.repeat(12)}` };
const json = { 'content-type': 'application/json' };

/** The owner-funded fallback on: exactly '1'. Every other test runs with it off (the default). */
const FALLBACK_ON = { CITY_BASE_WALLET: '1', CITY_BASE_WALLET_UNSPONSORED_FALLBACK: '1' };

const key = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const userOperationEvent = parseAbiItem(
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
);
const wrapperAbi = [
  {
    type: 'tuple',
    components: [
      { name: 'ownerIndex', type: 'uint8' },
      { name: 'signatureData', type: 'bytes' },
    ],
  },
] as const;

interface Landed {
  txHash: Hex;
  blockNumber: bigint;
  success: boolean;
  sender: Address;
  nonce: bigint;
}

/** A fake wallet-network node plus a JSON-RPC bundler/paymaster that validates like the wallet. */
function fakeBase() {
  const state = {
    head: 1000n,
    fees: { maxFeePerGas: 2_000_000n, maxPriorityFeePerGas: 1_000_000n, baseFee: 500_000n },
    sponsor: true,
    nodeDown: false,
    /** How far behind the head Base's safe tag is (Base batches reach L1 before they are final). */
    safeDepth: SETTLE_DEPTH,
    /** The safe tag alone cannot be read. */
    safeDown: false,
    /** Transactions whose receipt now names another block hash than the canonical one (a reorg). */
    reorged: new Set<string>(),
    /**
     * A bundler that names another operation's landing for an operation (userOpHash → the one
     * whose receipt it answers with): a stale or wrong receipt.
     */
    receiptLie: new Map<string, string>(),
    /** Transactions the node now reads as reverted with no events (re-mined at the same height). */
    txFailed: new Set<string>(),
    /** A node that answers getNonce on another lane than the one asked for. */
    nonceKeyLie: null as bigint | null,
    /** The safe tag names a block of another branch (a node between two forks). */
    safeOrphan: false,
    /** eth_call never answers (a hung node). */
    callHang: false,
    /** Base debits the wallet when an operation lands (off: the balance never moves). */
    debit: false,
    /**
     * Holds every balance read until this many requests are reading (two creates racing past
     * their checks before either stores anything); null: no waiting.
     */
    barrier: null as null | (() => Promise<void>),
    bundlerDown: false,
    /** The paymaster alone cannot be reached (its calls fail in transport). */
    paymasterDown: false,
    /** The paymaster answers, with empty paymasterAndData (sponsors nothing). */
    paymasterEmpty: false,
    /** What a paymaster that answers puts in paymasterAndData (sponsorData). */
    paymasterAnswer: 'pinned' as SponsorAnswer,
    /** The paymaster that answer names: the synthetic one unless a test sets another. */
    paymaster: PAYMASTER as Address,
    sponsorValidUntil: () => 0,
    code: new Set<string>([USDC.toLowerCase(), ENTRY_POINT.toLowerCase()]),
    owners: new Map<string, Address[]>(),
    balances: new Map<string, { usdc: bigint; eth: bigint }>(),
    lanes: new Map<string, Array<{ block: bigint; next: bigint }>>(),
    pool: new Map<string, UserOperation<'0.6'>>(),
    landed: new Map<string, Landed>(),
    /** The operation each landed hash carried, so a dropped block can put it back in the pool. */
    mined: new Map<string, UserOperation<'0.6'>>(),
    sends: [] as Array<{ hash: Hex; op: UserOperation<'0.6'> }>,
    rejected: [] as string[],
    paymasterCalls: 0,
    /** Block times in seconds by number (none: the node gives no timestamp, so nothing is concluded from time). */
    blockTime: null as null | ((n: bigint) => bigint),
  };
  const lane = (sender: string, laneKey: bigint) => `${sender.toLowerCase()}:${laneKey}`;
  const seqAt = (sender: string, laneKey: bigint, block?: bigint) => {
    let next = 0n;
    for (const entry of state.lanes.get(lane(sender, laneKey)) ?? [])
      if (block === undefined || entry.block <= block) next = entry.next;
    return next;
  };
  const blockHash = (n: bigint) => keccak256(toHex(`block-${n}`));
  const down = () => {
    if (state.nodeDown) throw new Error('node unreachable');
  };

  /** Puts a pooled operation into the next block; others at its nonce can never land. */
  function include(userOpHash: Hex, success = true) {
    const op = state.pool.get(userOpHash);
    assert.ok(op, 'the operation was sent');
    state.head += 1n;
    const laneKey = op.nonce >> 64n;
    assert.equal(op.nonce & SEQ_MASK, seqAt(op.sender, laneKey));
    const history = state.lanes.get(lane(op.sender, laneKey)) ?? [];
    history.push({ block: state.head, next: (op.nonce & SEQ_MASK) + 1n });
    state.lanes.set(lane(op.sender, laneKey), history);
    if (op.initCode && op.initCode !== '0x') state.code.add(op.sender.toLowerCase());
    if (state.debit && success) {
      const held = state.balances.get(op.sender.toLowerCase())!;
      const call = decodeFunctionData({ abi: executeAbi, data: op.callData });
      if (call.functionName === 'execute') {
        const [target, value, data] = call.args;
        if (target.toLowerCase() === USDC.toLowerCase())
          held.usdc -= decodeFunctionData({ abi: transferAbi, data }).args[1];
        else held.eth -= value;
      }
    }
    state.mined.set(userOpHash, op);
    state.landed.set(userOpHash, {
      txHash: keccak256(concat([userOpHash, '0x01'])),
      blockNumber: state.head,
      success,
      sender: getAddress(op.sender),
      nonce: op.nonce,
    });
    for (const [hash, other] of state.pool)
      if (other.sender.toLowerCase() === op.sender.toLowerCase() && other.nonce === op.nonce)
        state.pool.delete(hash);
  }

  /** Base drops the block that carried this operation: it is back in the pool, its nonce unused. */
  function uninclude(userOpHash: Hex) {
    const hit = state.landed.get(userOpHash);
    const op = state.mined.get(userOpHash);
    assert.ok(hit && op, 'the operation landed');
    state.landed.delete(userOpHash);
    const key = lane(op.sender, op.nonce >> 64n);
    state.lanes.set(
      key,
      (state.lanes.get(key) ?? []).filter((entry) => entry.block !== hit.blockNumber),
    );
    state.pool.set(userOpHash, op);
  }

  const client = {
    getCode: async ({ address }: { address: string }) => {
      down();
      return state.code.has(address.toLowerCase()) ? '0x6080' : undefined;
    },
    readContract: async (call: {
      address: string;
      functionName: string;
      args: [string, bigint];
      blockNumber?: bigint;
    }) => {
      down();
      assert.equal(getAddress(call.address), ENTRY_POINT);
      assert.equal(call.functionName, 'getNonce');
      const [sender, laneKey] = call.args;
      return ((state.nonceKeyLie ?? laneKey) << 64n) | seqAt(sender, laneKey, call.blockNumber);
    },
    getBlockNumber: async () => {
      down();
      return state.head;
    },
    getBlock: async (args: { blockNumber?: bigint; blockTag?: string } = {}) => {
      down();
      if (args.blockNumber !== undefined)
        return {
          number: args.blockNumber,
          hash: blockHash(args.blockNumber),
          ...(state.blockTime ? { timestamp: state.blockTime(args.blockNumber) } : {}),
        };
      // Base reads finality from these tags (Base Sepolia counts confirmations instead).
      if (args.blockTag === 'finalized') {
        const settled = state.head - SETTLE_DEPTH;
        return { number: settled, hash: blockHash(settled) };
      }
      if (args.blockTag === 'safe') {
        if (state.safeDown) throw new Error('safe tag unreadable');
        const safe = state.head - state.safeDepth;
        return {
          number: safe,
          hash: state.safeOrphan ? keccak256(toHex(`orphan-safe-${safe}`)) : blockHash(safe),
        };
      }
      return { number: state.head, hash: blockHash(state.head), baseFeePerGas: state.fees.baseFee };
    },
    getLogs: async (query: { args: { userOpHash: Hex }; fromBlock: bigint; toBlock: bigint }) => {
      down();
      const hit = state.landed.get(query.args.userOpHash);
      if (!hit || hit.blockNumber < query.fromBlock || hit.blockNumber > query.toBlock) return [];
      return [
        {
          args: {
            userOpHash: query.args.userOpHash,
            sender: hit.sender,
            paymaster: PAYMASTER,
            nonce: hit.nonce,
            success: hit.success,
            actualGasCost: 1_000n,
            actualGasUsed: 100n,
          },
          transactionHash: hit.txHash,
          blockNumber: hit.blockNumber,
        },
      ];
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      down();
      const found = [...state.landed.entries()].find(([, hit]) => hit.txHash === hash);
      if (!found) throw new TransactionReceiptNotFoundError({ hash });
      const [userOpHash, hit] = found as [Hex, Landed];
      return {
        transactionHash: hit.txHash,
        blockNumber: hit.blockNumber,
        blockHash: state.reorged.has(hit.txHash)
          ? keccak256(toHex(`orphan-${hit.blockNumber}`))
          : blockHash(hit.blockNumber),
        status: state.txFailed.has(hit.txHash) ? 'reverted' : 'success',
        logs: state.txFailed.has(hit.txHash)
          ? []
          : [
              {
                address: ENTRY_POINT,
                topics: encodeEventTopics({
                  abi: [userOperationEvent],
                  eventName: 'UserOperationEvent',
                  args: { userOpHash, sender: hit.sender, paymaster: PAYMASTER },
                }),
                data: encodeAbiParameters(
                  [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
                  [hit.nonce, hit.success, 1_000n, 100n],
                ),
              },
            ],
      };
    },
    /** eth_call at a block hash (EIP-1898): only getNonce, only at a canonical block. */
    request: async ({ method, params }: { method: string; params: unknown[] }) => {
      down();
      if (method !== 'eth_call') throw new Error(`no ${method}`);
      if (state.callHang) await new Promise(() => {});
      const [call, at] = params as [{ to: string; data: Hex }, { blockHash: Hex }];
      assert.equal(getAddress(call.to), ENTRY_POINT);
      let block: bigint | null = null;
      for (let n = state.head; n >= 0n && block === null; n--)
        if (blockHash(n) === at.blockHash) block = n;
      if (block === null) throw new Error('header not found');
      const { args } = decodeFunctionData({ abi: nonceAbi, data: call.data });
      const [sender, laneKey] = args;
      return encodeFunctionResult({
        abi: nonceAbi,
        functionName: 'getNonce',
        result: ((state.nonceKeyLie ?? laneKey) << 64n) | seqAt(sender, laneKey, block),
      });
    },
    estimateFeesPerGas: async () => {
      down();
      return {
        maxFeePerGas: state.fees.maxFeePerGas,
        maxPriorityFeePerGas: state.fees.maxPriorityFeePerGas,
      };
    },
  } as unknown as PublicClient;

  async function bundle(method: string, params: unknown[]): Promise<unknown> {
    if (method === 'pm_getPaymasterStubData') {
      if (!state.sponsor) throw new Error('sponsorship policy rejected the operation');
      return { paymasterAndData: concat([PAYMASTER, '0x00']) };
    }
    if (method === 'eth_estimateUserOperationGas')
      return {
        callGasLimit: '0x186a0',
        verificationGasLimit: '0x30d40',
        preVerificationGas: '0xc350',
      };
    if (method === 'pm_getPaymasterData') {
      state.paymasterCalls++;
      if (!state.sponsor) throw new Error('sponsorship policy rejected the operation');
      if (state.paymasterEmpty) return { paymasterAndData: '0x' };
      return {
        paymasterAndData: sponsorData(
          state.paymasterAnswer,
          state.paymasterCalls,
          state.paymaster,
          state.sponsorValidUntil(),
        ),
      };
    }
    if (method === 'eth_getUserOperationReceipt') {
      const asked = params[0] as string;
      const hit = state.landed.get(state.receiptLie.get(asked) ?? asked);
      if (!hit) return null;
      return {
        success: hit.success,
        actualGasCost: '0x3e8',
        actualGasUsed: '0x64',
        receipt: { transactionHash: hit.txHash, blockNumber: numberToHex(hit.blockNumber) },
      };
    }
    if (method !== 'eth_sendUserOperation') throw new Error(`no ${method}`);
    const op = userOperationFromRpc(params[0]);
    const hash = ownerOperationHash(op);
    if (state.landed.has(hash) || state.pool.has(hash)) throw new Error('already known');
    const sender = op.sender.toLowerCase();
    const reject = (reason: string) => {
      state.rejected.push(reason);
      throw new Error(reason);
    };
    if ((op.nonce & SEQ_MASK) !== seqAt(sender, op.nonce >> 64n))
      reject('AA25 invalid account nonce');
    const deployed = state.code.has(sender);
    if (op.initCode !== '0x' && deployed) reject('AA10 sender already constructed');
    if (op.initCode === '0x' && !deployed) reject('AA20 account not deployed');
    // The wallet: SignatureWrapper{ownerIndex, signatureData}, ecrecover over the RAW hash.
    const [wrapper] = decodeAbiParameters(wrapperAbi, op.signature);
    const v = Number.parseInt(wrapper.signatureData.slice(-2), 16);
    if (wrapper.signatureData.length !== 132 || (v !== 27 && v !== 28))
      reject('AA24 signature error');
    const signer = await recoverAddress({ hash, signature: wrapper.signatureData });
    if (state.owners.get(sender)?.[wrapper.ownerIndex] !== signer) reject('AA24 signature error');
    // Unsponsored: the wallet prefunds its gas at validation, on top of any value it sends.
    if (op.paymasterAndData === '0x') {
      const call = decodeFunctionData({ abi: executeAbi, data: op.callData });
      const value = call.functionName === 'execute' ? call.args[1] : 0n;
      if ((state.balances.get(sender)?.eth ?? 0n) < maxCostWei(op) + value)
        reject('AA21 prefund not paid');
    }
    // A same-nonce replacement must outbid what it replaces by more than 10%.
    for (const other of state.pool.values())
      if (
        other.sender.toLowerCase() === sender &&
        other.nonce === op.nonce &&
        (op.maxFeePerGas * 10n <= other.maxFeePerGas * 11n ||
          op.maxPriorityFeePerGas * 10n <= other.maxPriorityFeePerGas * 11n)
      )
        reject('replacement underpriced');
    state.pool.set(hash, op);
    state.sends.push({ hash, op });
    return hash;
  }

  const fetchImpl = (async (_url: string, init: RequestInit) => {
    if (state.bundlerDown) throw new TypeError('fetch failed');
    const { id, method, params } = JSON.parse(String(init.body));
    if (state.paymasterDown && String(method).startsWith('pm_'))
      throw new TypeError('fetch failed');
    try {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id, result: await bundle(method, params) }),
      );
    } catch (error) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32500, message: (error as Error).message },
        }),
      );
    }
  }) as typeof fetch;

  return {
    state,
    client,
    fetch: fetchImpl,
    include,
    uninclude,
    mine: (blocks: number) => {
      state.head += BigInt(blocks);
    },
  };
}

interface Options {
  env?: Record<string, string | undefined>;
  backup?: boolean;
  maxFeePerGasCap?: bigint;
  maxCostWeiCap?: bigint;
  /** The port without any cost cap (refused on Base). */
  unbounded?: boolean;
  noOwnerOperations?: boolean;
  /** Vercel Cron's secret: the withdrawals sweep route exists only with it. */
  cronSecret?: string;
  /** How long one safe-head proof may take (the port's default otherwise). */
  proofTimeoutMs?: number;
  limit?: (key: string, max: number, windowMs: number) => Promise<void>;
  /** The client the owner operations port reads through (the chain's own by default). */
  portClient?: (client: PublicClient) => PublicClient;
}

async function setup(t: { after: (fn: () => Promise<unknown>) => void }, options: Options = {}) {
  const pg = await fixtureDatabase(t);
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('person-1','owner'), ('person-2','owner'), ('ai-1','ai');
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);
    INSERT INTO agent_manifests VALUES ('${AGENT}', 'person-1', 1, '{}'), ('${AI_AGENT}', 'ai-1', 1, '{}');`);
  for (const sql of [
    BASE_MIGRATION_SQL,
    BASE_PAYMENTS_MIGRATION_SQL,
    BASE_SHARED_ADDITIONS_SQL,
    BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
    BASE_WALLET_VAULT_SQL,
    BASE_WALLET_WITHDRAWALS_SQL,
    // Spending-limit revokes (90): a live one that deploys the wallet holds the deployment.
    BASE_WALLET_LIMITS_SQL,
    // The wallet routes serve Pay too: a payment is marked final with its withdrawal (91).
    BASE_WALLET_PAYMENTS_SQL,
    // Ratings share the table (94): a withdrawal is kind 'withdraw', nothing else changes for it.
    BASE_WALLET_RATINGS_SQL,
    // One unlanded owner operation per wallet (93): an included one is decided by the safe head.
    BASE_WALLET_ONE_UNSIGNED_SQL,
    // Pay without waiting: an operation's own nonce lane, unique per wallet (95).
    BASE_WALLET_LANES_SQL,
    // The recipient's safe notice (96), then the sponsor's exposure in flight (97).
    BASE_WALLET_WITHDRAWALS_SAFE_SQL,
    BASE_SPONSOR_EXPOSURE_SQL,
  ])
    await pg.exec(sql);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const clock = { now: NOW };
  const chain = fakeBase();
  chain.state.sponsorValidUntil = () =>
    Math.floor((clock.now + WITHDRAWAL_SIGNATURE_TTL_MS) / 1000);
  const owner = privateKeyToAccount(generatePrivateKey());
  await pg.query(
    `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key, kdf_params,
       cipher_params, version, backup_confirmed_at, created_at, updated_at)
     VALUES ('person-1', $1, decode($2, 'hex'), $3, $4, 1, $5, 1, 1)`,
    [
      owner.address,
      '5a'.repeat(48),
      JSON.stringify(KDF),
      JSON.stringify(CIPHER),
      options.backup === false ? null : NOW - 1_000,
    ],
  );
  const wallets: Record<string, Address> = {};
  for (const [agentId, workspace] of [
    [AGENT, 'person-1'],
    [AI_AGENT, 'ai-1'],
  ]) {
    const recipe = agentWalletRecipe(NETWORK, owner.address, accountIndexFor(agentId));
    const address = deriveAddressLocal(recipe);
    wallets[agentId] = address;
    chain.state.owners.set(address.toLowerCase(), recipe.owners);
    chain.state.balances.set(address.toLowerCase(), { usdc: 5_000_000n, eth: 10n ** 15n });
    await pg.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address,
         owner_address, spender_address, spender_key_ref, derivation, state, created_at,
         updated_at, owner_account_id)
       VALUES ($1, $2, $3, $8, $4, $5, $6, 'v1:00000000-0000-4000-8000-000000000000', $7,
         'derived', 1, 1, 'person-1')`,
      [
        `wallet-${agentId.slice(0, 4)}`,
        agentId,
        workspace,
        address,
        owner.address,
        SPENDER,
        JSON.stringify({
          version: 1,
          owners: recipe.owners,
          factory: recipe.factory,
          implementationVersion: 'test-impl-0001',
          accountIndex: recipe.index.toString(10),
        }),
        WALLET_EXPECTED.chainId,
      ],
    );
  }
  const bundler = rpcBundler({
    url: 'https://bundler.test/rpc/test-key-0001',
    entryPoint: ENTRY_POINT,
    chainId: WALLET_EXPECTED.chainId,
    client: chain.client,
    maxFeePerGasCap: options.maxFeePerGasCap ?? 10n ** 12n,
    stubSignature: walletSignature(`0x${'ff'.repeat(64)}1c`, { ownerIndex: 0 }),
    fetch: chain.fetch,
  });
  const port = createOwnerOperationsPort({
    network: NETWORK,
    client: options.portClient ? options.portClient(chain.client) : chain.client,
    store: pgChainOperationStore(db, () => clock.now),
    bundler,
    maxCostWeiCap: options.unbounded ? undefined : (options.maxCostWeiCap ?? FEE_BUDGET),
    sponsors: SPONSORS,
    proofTimeoutMs: options.proofTimeoutMs,
    now: () => clock.now,
  });
  const runtimeCalls: number[] = [];
  const runtime: ChainRuntime = {
    walletPort: {} as ChainRuntime['walletPort'],
    identityPort: {} as ChainRuntime['identityPort'],
    ...(options.noOwnerOperations ? {} : { ownerOperations: port }),
  };
  const balances: BalanceReader = {
    balances: async (address) => {
      if (chain.state.nodeDown) throw new Error('node unreachable');
      await chain.state.barrier?.();
      const held = chain.state.balances.get(address.toLowerCase()) ?? { usdc: 0n, eth: 0n };
      return {
        ...held,
        deployed: chain.state.code.has(address.toLowerCase()),
        blockNumber: chain.state.head,
      };
    },
  };
  const app = Fastify();
  t.after(() => app.close());
  registerBaseWalletRoutes(app, {
    db,
    env: options.env ?? { CITY_BASE_WALLET: '1' },
    currentPerson: async (request) => {
      const who = request.headers['x-test-person'];
      return typeof who === 'string' ? { id: who } : null;
    },
    currentWorkspace: async (request) => {
      const who = request.headers['x-test-person'] as string;
      const selected = request.headers['x-city-workspace'];
      return { id: typeof selected === 'string' ? selected : who };
    },
    runtime: async (chainId) => {
      runtimeCalls.push(chainId);
      return runtime;
    },
    balances,
    limit: options.limit,
    cronSecret: options.cronSecret,
    now: () => clock.now,
  });
  return { app, pg, db, chain, owner, clock, wallets, port, runtime, runtimeCalls, balances };
}

async function fixtureDatabase(t: {
  after: (fn: () => Promise<unknown>) => void;
}): Promise<Database> {
  if (process.env.CITY_WALLET_POSTGRES_RACES !== '1') {
    const memory = await PGlite.create('memory://');
    t.after(() => memory.close());
    return {
      query: (sql, params) => memory.query(sql, params) as never,
      exec: (sql) => memory.exec(sql),
      transaction: (action) => memory.transaction((tx) => action(tx as never)),
      close: () => memory.close(),
    };
  }
  // Never fall back to DATABASE_URL: this mode may create/drop only an isolated test database.
  const url = process.env.CITY_TEST_POSTGRES_URL;
  assert.ok(url, 'CITY_TEST_POSTGRES_URL is required for real wallet race tests');
  const name = `city_wallet_race_${randomBytes(6).toString('hex')}`;
  const admin = new pgDriver.Pool({ connectionString: url, max: 1 });
  let pool: pgDriver.Pool | undefined;
  let created = false;
  t.after(async () => {
    try {
      await pool?.end();
      if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE DATABASE ${name}`);
  created = true;
  const isolated = new URL(url);
  isolated.pathname = `/${name}`;
  pool = new pgDriver.Pool({
    connectionString: isolated.toString(),
    max: 6,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    lock_timeout: 10000,
  });
  pool.on('error', () => {});
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    const a = await first.query('SELECT pg_backend_pid() AS pid');
    const b = await second.query('SELECT pg_backend_pid() AS pid');
    assert.notEqual(a.rows[0].pid, b.rows[0].pid);
  } finally {
    first.release();
    second.release();
  }
  return postgresDatabase(pool);
}

type Fixture = Awaited<ReturnType<typeof setup>>;

const as = (person?: string, workspace?: string) => ({
  ...json,
  ...(person ? { 'x-test-person': person } : {}),
  ...(workspace ? { 'x-city-workspace': workspace } : {}),
});
const url = (agent = AGENT) => `/api/base/agents/${agent}/wallet/withdrawals`;

function create(
  f: Fixture,
  payload: Record<string, unknown>,
  opts: { person?: string; workspace?: string; agent?: string } = {},
) {
  return f.app.inject({
    method: 'POST',
    url: url(opts.agent),
    headers: as(opts.person ?? 'person-1', opts.workspace),
    payload: JSON.stringify(payload),
  });
}

const usdc = (n: number, overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: key(n),
  token: 'USDC',
  amount: '1500000',
  to: DEST,
  ...overrides,
});

function post(f: Fixture, path: string, payload: unknown, person = 'person-1', agent = AGENT) {
  return f.app.inject({
    method: 'POST',
    url: `${url(agent)}/${path}`,
    headers: as(person),
    payload: JSON.stringify(payload),
  });
}

const read = (f: Fixture, id: string, person = 'person-1', agent = AGENT) =>
  f.app.inject({ url: `${url(agent)}/${id}`, headers: as(person) });

/** The owner key signs the RAW hash, as the browser vault does. */
const rawSign = (signer: PrivateKeyAccount, hash: Hex) => signer.sign({ hash });

async function created(f: Fixture, n: number, overrides: Record<string, unknown> = {}) {
  const res = await create(f, usdc(n, overrides));
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as {
    withdrawalId: string;
    state: string;
    userOperation: RpcUserOperation;
    userOpHash: Hex;
    entryPoint: string;
    chainId: number;
    expiresAt: number;
    summary: Record<string, unknown>;
  };
}

async function signedWithdrawal(f: Fixture, n: number) {
  const body = await created(f, n);
  const res = await post(f, `${body.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, body.userOpHash),
  });
  assert.equal(res.statusCode, 202, res.body);
  return body;
}

async function reservations(f: Fixture) {
  const { rows } = await f.pg.query<{ holder_kind: string; state: string; amount: string }>(
    'SELECT holder_kind, state, amount::text AS amount FROM base_wallet_reservations ORDER BY created_at',
  );
  return rows;
}

async function auditKinds(f: Fixture) {
  const { rows } = await f.pg.query<{ kind: string; detail: unknown }>(
    "SELECT kind, detail FROM base_audit_events WHERE kind LIKE 'withdrawal%' ORDER BY event_id",
  );
  return rows;
}

test('migration 89 is registered after 88, wallet networks only, one open operation per wallet', async (t) => {
  registerBaseMigration();
  const versions = listMigrations().map((m) => m.version);
  assert.ok(versions.includes(89));
  assert.ok(versions.indexOf(89) > versions.indexOf(88));
  assert.equal(baseWalletWithdrawalsMigration.name, 'base_wallet_withdrawals');
  assert.doesNotMatch(BASE_WALLET_WITHDRAWALS_SQL, /DROP (TABLE|COLUMN)|DELETE FROM|TRUNCATE/i);

  const f = await setup(t);
  const insert = (id: string, chainId: number, state: string, idem: string) =>
    f.pg.query(
      `INSERT INTO base_wallet_withdrawals (withdrawal_id, wallet_id, owner_account_id, chain_id,
         token, amount_raw, destination, idempotency_key, request_hash, state, nonce,
         user_operation, user_op_hash, expires_at, created_at, updated_at)
       VALUES ($1, $2, 'person-1', $3, 'USDC', 1, $4, $5, $6, $7, 0, '{}', $6, 1, 1, 1)`,
      [id, `wallet-${AGENT.slice(0, 4)}`, chainId, DEST, idem, `0x${'ab'.repeat(32)}`, state],
    );
  // Only the wallet networks (Base Sepolia or Base, whichever wallet-network.ts names).
  const chainId = WALLET_EXPECTED.chainId;
  await assert.rejects(insert('w-other', 1, 'awaiting_signature', 'k0'));
  await assert.rejects(insert('w-anvil', 31337, 'awaiting_signature', 'k0'));
  await insert('w-1', chainId, 'awaiting_signature', 'k1');
  // A second open owner operation on the same wallet is refused by the database itself.
  await assert.rejects(insert('w-2', chainId, 'awaiting_signature', 'k2'));
  // Signed states need a signature; unsigned ones may not carry one.
  await assert.rejects(insert('w-3', chainId, 'final', 'k3'));
  // Reservations take the new holder kind; chain operations the new kinds.
  await f.pg.query(
    `INSERT INTO base_wallet_reservations (reservation_id, wallet_id, chain_id, token, amount,
       holder_kind, holder_ref, intent_hash, state, created_at, updated_at)
     VALUES ('r-1', $1, $3, $2, 1, 'withdrawal', 'w-1', 'x', 'held', 1, 1)`,
    [`wallet-${AGENT.slice(0, 4)}`, USDC.toLowerCase(), chainId],
  );
  await f.pg.query(
    `INSERT INTO base_chain_ops (op_id, idempotency_key, intent_hash, kind, chain_id, status,
       created_at, updated_at) VALUES ('o-1', 'k-1', 'x', 'withdraw_cancel', $1, 'queued', 1, 1)`,
    [chainId],
  );
});

test('with the flag off every withdrawal route is 404', async (t) => {
  const f = await setup(t, { env: {} });
  const id = key(9);
  assert.equal((await create(f, usdc(1))).statusCode, 404);
  assert.equal((await read(f, id)).statusCode, 404);
  for (const path of [`${id}/signature`, `${id}/cancel`, `${id}/cancel/signature`])
    assert.equal((await post(f, path, {})).statusCode, 404, path);
  assert.equal(f.runtimeCalls.length, 0);
});

test('a USDC withdrawal: prepared unsigned, signed over the raw hash, sent, included, final', async (t) => {
  const f = await setup(t);
  const wallet = f.wallets[AGENT];
  const body = await created(f, 1);
  assert.equal(body.state, 'awaiting_signature');
  assert.equal(body.chainId, WALLET_EXPECTED.chainId);
  assert.equal(body.entryPoint, ENTRY_POINT);
  assert.equal(body.expiresAt, NOW + WITHDRAWAL_SIGNATURE_TTL_MS);
  assert.deepEqual(body.summary, {
    kind: 'withdraw',
    token: 'USDC',
    amount: { raw: '1500000', decimals: 6, display: '1.5' },
    from: wallet,
    to: DEST,
    network: WALLET_EXPECTED.name,
    testnet: WALLET_EXPECTED.testnet,
    sponsored: true,
    deploysWallet: true,
    toIsContract: false,
    fee: { paidBy: 'sponsor', token: 'ETH', max: { raw: '0', decimals: 18, display: '0' } },
  });
  // What the browser does before signing: recompute the hash, decode the one call.
  const op = userOperationFromRpc(body.userOperation);
  assert.equal(ownerOperationHash(op), body.userOpHash);
  assert.deepEqual(decodeOwnerCall(op.callData, wallet), {
    kind: 'withdraw',
    token: 'USDC',
    to: DEST,
    amount: 1_500_000n,
  });
  assert.equal(getAddress(op.sender), wallet);
  assert.equal(op.signature, '0x');
  assert.equal(op.nonce, OWNER_NONCE_KEY << 64n, 'the owner lane, first nonce');
  assert.ok(
    (op.paymasterAndData ?? '0x').toLowerCase().startsWith(PAYMASTER.toLowerCase()),
    'sponsored',
  );
  // Undeployed: the operation deploys the wallet from its stored recipe.
  const recipe = agentWalletRecipe(NETWORK, f.owner.address, accountIndexFor(AGENT));
  assert.equal(
    (op.initCode ?? '0x').toLowerCase(),
    concat([recipe.factory, encodeFunctionData(createAccountCall(recipe))]).toLowerCase(),
  );
  assert.deepEqual(await reservations(f), [
    { holder_kind: 'withdrawal', state: 'held', amount: '1500000' },
  ]);
  assert.equal(f.chain.state.sends.length, 0, 'nothing is sent before the owner signs');

  // v as 0/1 is accepted and normalized to 27/28 inside the wallet's SignatureWrapper.
  const signature = await rawSign(f.owner, body.userOpHash);
  const parityForm = `${signature.slice(0, 130)}${signature.endsWith('1b') ? '00' : '01'}` as Hex;
  const signed = await post(f, `${body.withdrawalId}/signature`, { signature: parityForm });
  assert.equal(signed.statusCode, 202, signed.body);
  assert.equal(signed.json().state, 'submitted');
  assert.equal(signed.json().expiresAt, null, 'a signed withdrawal never expires');
  assert.equal(f.chain.state.sends.length, 1);
  assert.equal(f.chain.state.sends[0].hash, body.userOpHash, 'exactly the operation shown');
  const [wrapper] = decodeAbiParameters(wrapperAbi, f.chain.state.sends[0].op.signature);
  assert.equal(wrapper.ownerIndex, 0);
  const ops = await f.pg.query<{ kind: string; status: string; user_op_hash: string }>(
    'SELECT kind, status, user_op_hash FROM base_chain_ops',
  );
  assert.deepEqual(ops.rows, [
    { kind: 'withdraw', status: 'submitted', user_op_hash: body.userOpHash },
  ]);

  f.chain.include(body.userOpHash);
  const included = (await read(f, body.withdrawalId)).json();
  assert.equal(included.state, 'included');
  assert.match(included.txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(included.blockNumber, 1001);
  assert.equal(included.explorerUrl, `${WALLET_EXPECTED.explorer}/tx/${included.txHash}`);
  f.chain.mine(3);
  const final = (await read(f, body.withdrawalId)).json();
  assert.equal(final.state, 'final');
  assert.equal(final.errorCode, null);
  assert.deepEqual(await reservations(f), [
    { holder_kind: 'withdrawal', state: 'consumed', amount: '1500000' },
  ]);

  // Sending the same signature again changes nothing.
  const again = await post(f, `${body.withdrawalId}/signature`, { signature });
  assert.equal(again.statusCode, 202);
  assert.equal(again.json().state, 'final');
  assert.equal(f.chain.state.sends.length, 1);

  const events = await auditKinds(f);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['withdrawal_created', 'withdrawal_signed', 'withdrawal_submitted', 'withdrawal_final'],
  );
  const text = JSON.stringify(events);
  assert.ok(!text.includes(signature.slice(2, 40)), 'no signature in the audit trail');
});

test('a signed withdrawal whose operation was stored but never claimed for its first send is sent by the next read', async (t) => {
  const f = await setup(t);
  const body = await signedWithdrawal(f, 1);
  // A stop between the chain module's store and its queued → submitted claim: stored, never sent.
  f.chain.state.pool.clear();
  f.chain.state.sends.length = 0;
  await f.pg.query(`UPDATE base_chain_ops SET status = 'queued' WHERE user_op_hash = $1`, [
    body.userOpHash,
  ]);

  // The next read (the owner's, or the sweep's) sends exactly the stored operation, once.
  assert.equal((await read(f, body.withdrawalId)).json().state, 'submitted');
  assert.equal(f.chain.state.sends.length, 1);
  assert.equal(f.chain.state.sends[0].hash, body.userOpHash);
  assert.equal((await read(f, body.withdrawalId)).json().state, 'submitted');
  assert.equal(f.chain.state.sends.length, 1, 'claimed once: a second read does not send again');

  f.chain.include(body.userOpHash);
  f.chain.mine(3);
  assert.equal((await read(f, body.withdrawalId)).json().state, 'final');
  assert.deepEqual(await reservations(f), [
    { holder_kind: 'withdrawal', state: 'consumed', amount: '1500000' },
  ]);
});

test('a signed operation that can never land fails as not sent once Base settles past its sponsorship', async (t) => {
  const f = await setup(t);
  const body = await created(f, 1);
  assert.notEqual(userOperationFromRpc(body.userOperation).initCode, '0x');
  // Another operation (an agent payment's approve) deployed the wallet meanwhile: this one's
  // initCode can never pass validation again, so every send is refused.
  f.chain.state.code.add(f.wallets[AGENT].toLowerCase());
  const signed = await post(f, `${body.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, body.userOpHash),
  });
  assert.equal(signed.statusCode, 202, signed.body);
  assert.deepEqual(f.chain.state.rejected, ['AA10 sender already constructed']);
  const validUntil = BigInt(f.chain.state.sponsorValidUntil());

  // Base has not settled a block past validUntil yet: it may still be on its way, nothing concluded.
  f.chain.state.blockTime = () => validUntil;
  f.chain.mine(5);
  assert.equal((await read(f, body.withdrawalId)).json().state, 'submitted');
  // Without a block time nothing is concluded from time either.
  f.chain.state.blockTime = null;
  assert.equal((await read(f, body.withdrawalId)).json().state, 'submitted');

  // A settled block past validUntil with the nonce still unused: it never landed and never can.
  f.chain.state.blockTime = () => validUntil + 1n;
  const failed = (await read(f, body.withdrawalId)).json();
  assert.equal(failed.state, 'failed');
  assert.equal(failed.errorCode, 'not_sent');
  assert.deepEqual(await reservations(f), [
    { holder_kind: 'withdrawal', state: 'released', amount: '1500000' },
  ]);
});

test('a sponsored operation that landed is never retired by its lapsed sponsorship', async (t) => {
  const f = await setup(t);
  const body = await signedWithdrawal(f, 1);
  f.chain.include(body.userOpHash);
  f.chain.state.blockTime = () => BigInt(f.chain.state.sponsorValidUntil()) + 1_000n;
  f.chain.mine(3);
  assert.equal((await read(f, body.withdrawalId)).json().state, 'final');
  assert.deepEqual(await reservations(f), [
    { holder_kind: 'withdrawal', state: 'consumed', amount: '1500000' },
  ]);
});

test('the next withdrawal of a deployed wallet has no initCode and the next owner nonce', async (t) => {
  const f = await setup(t);
  const first = await signedWithdrawal(f, 1);
  f.chain.include(first.userOpHash);
  f.chain.mine(3);
  assert.equal((await read(f, first.withdrawalId)).json().state, 'final');
  const second = await created(f, 2, { amount: '1000' });
  const op = userOperationFromRpc(second.userOperation);
  assert.equal(op.initCode, '0x');
  assert.equal(op.nonce, (OWNER_NONCE_KEY << 64n) | 1n);
  assert.equal(second.summary.deploysWallet, false);
});

test('amounts: base units only, max = balance at one block minus holds, never more', async (t) => {
  const f = await setup(t);
  for (const amount of ['0', '01', '1.5', '-1', '', '0x10', 5, null, `1${'0'.repeat(78)}`]) {
    const res = await create(f, usdc(1, { token: 'ETH', amount }));
    assert.equal(res.statusCode, 400, String(amount));
    assert.equal(res.json().code, 'invalid_amount');
  }
  // Another holder (an agent payment) has 0.0004 ETH held on this wallet.
  await f.pg.query(
    `INSERT INTO base_wallet_reservations (reservation_id, wallet_id, chain_id, token, amount,
       holder_kind, holder_ref, intent_hash, state, created_at, updated_at)
     VALUES ('r-pay', $1, $3, $2, 400000000000000, 'payment', 'pay-1', 'x', 'held', 1, 1)`,
    [`wallet-${AGENT.slice(0, 4)}`, NATIVE_ETH.toLowerCase(), WALLET_EXPECTED.chainId],
  );
  const over = await create(f, usdc(2, { token: 'ETH', amount: '600000000000001' }));
  assert.equal(over.statusCode, 409);
  assert.equal(over.json().code, 'insufficient_balance');
  assert.equal(over.json().available.raw, '600000000000000');

  const max = await created(f, 3, { token: 'ETH', amount: 'max' });
  assert.deepEqual(max.summary.amount, {
    raw: '600000000000000',
    decimals: 18,
    display: '0.0006',
  });
  assert.deepEqual(
    decodeOwnerCall(userOperationFromRpc(max.userOperation).callData, f.wallets[AGENT]),
    { kind: 'withdraw', token: 'ETH', to: DEST, amount: 600_000_000_000_000n },
  );
  // The same key with the same body ('max') is the same withdrawal.
  const replay = await create(f, usdc(3, { token: 'ETH', amount: 'max' }));
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.json().withdrawalId, max.withdrawalId);
});

test('an empty wallet has nothing to withdraw', async (t) => {
  const f = await setup(t);
  f.chain.state.balances.set(f.wallets[AGENT].toLowerCase(), { usdc: 0n, eth: 0n });
  const res = await create(f, usdc(1, { amount: 'max' }));
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'insufficient_balance');
  assert.equal(f.chain.state.paymasterCalls, 0);
});

test('destinations: lost or looping addresses are refused, checksums enforced, contracts allowed', async (t) => {
  const f = await setup(t);
  const wallet = f.wallets[AGENT];
  const refused = [
    zeroAddress,
    NATIVE_ETH,
    wallet,
    SPENDER,
    SPM,
    NETWORK.contracts.smartWalletFactory,
    ENTRY_POINT,
    NETWORK.contracts.entryPointV07,
    USDC,
  ];
  for (const [i, to] of refused.entries())
    for (const token of ['USDC', 'ETH']) {
      const res = await create(f, usdc(10 + i, { token, to }));
      assert.equal(res.statusCode, 409, `${token} to ${to}`);
      assert.equal(res.json().code, 'destination_not_allowed');
    }
  // A mixed-case address with a wrong checksum, and things that are not addresses.
  const badChecksum = `0x${DEST.slice(2, 41)}${DEST[41] === 'e' ? 'E' : 'e'}`;
  const flipped = DEST.replace(/[a-f]/, (c) => c.toUpperCase());
  for (const to of [flipped, badChecksum, '0x1234', 'vitalik.eth', 42])
    if (to !== DEST) {
      const res = await create(f, usdc(30, { to }));
      assert.equal(res.statusCode, 400, String(to));
      assert.equal(res.json().code, 'invalid_address');
    }
  // All lower case carries no checksum to check: accepted and answered checksummed.
  const lower = await created(f, 31, { to: DEST.toLowerCase() });
  assert.equal(lower.summary.to, DEST);
  // An unsigned withdrawal can be dropped: the wallet is free for the next one.
  const dropped = await post(f, `${lower.withdrawalId}/cancel`, {});
  assert.equal(dropped.statusCode, 200, dropped.body);
  assert.equal(dropped.json().state, 'expired');
  assert.equal(dropped.json().errorCode, 'discarded');
  // A contract (another smart wallet) is allowed; the screen gets told it is one.
  const contract = getAddress(`0x${'c0'.repeat(20)}`);
  f.chain.state.code.add(contract.toLowerCase());
  const toContract = await created(f, 32, { to: contract });
  assert.equal(toContract.summary.toIsContract, true);
});

test('no withdrawal until the backup key is confirmed', async (t) => {
  const f = await setup(t, { backup: false });
  const res = await create(f, usdc(1));
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'backup_required');
  assert.equal(f.chain.state.paymasterCalls, 0);
  await f.pg.query(
    "UPDATE base_owner_vaults SET backup_confirmed_at = 1 WHERE operator_id = 'person-1'",
  );
  assert.equal((await create(f, usdc(1))).statusCode, 201);
});

test('idempotency: the same key and body give the same withdrawal; another body is refused', async (t) => {
  const f = await setup(t);
  const first = await created(f, 1);
  const prepares = f.chain.state.paymasterCalls;
  const again = await created(f, 1);
  assert.deepEqual(again, first);
  assert.equal(f.chain.state.paymasterCalls, prepares, 'nothing prepared again');
  for (const change of [
    { amount: '1' },
    { to: getAddress(`0x${'5f'.repeat(20)}`) },
    { token: 'ETH' },
  ]) {
    const res = await create(f, usdc(1, change));
    assert.equal(res.statusCode, 409, JSON.stringify(change));
    assert.equal(res.json().code, 'idempotency_conflict');
  }
  // The same key on another of the owner's wallets is another body too.
  const other = await create(f, usdc(1), { agent: AI_AGENT });
  assert.equal(other.statusCode, 409);
  assert.equal(other.json().code, 'idempotency_conflict');
  // Signed, the same key answers with the current state.
  await post(f, `${first.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, first.userOpHash),
  });
  const later = await created(f, 1);
  assert.equal(later.withdrawalId, first.withdrawalId);
  assert.equal(later.state, 'submitted');
  assert.equal((await f.pg.query('SELECT 1 FROM base_wallet_withdrawals')).rows.length, 1);
});

test('the same key twice at once: both get the one withdrawal', async (t) => {
  const f = await setup(t);
  const [a, b] = await Promise.all([create(f, usdc(1)), create(f, usdc(1))]);
  assert.equal(a.statusCode, 201, a.body);
  assert.equal(b.statusCode, 201, b.body);
  assert.equal(a.json().withdrawalId, b.json().withdrawalId);
  assert.equal((await f.pg.query('SELECT 1 FROM base_wallet_withdrawals')).rows.length, 1);
  assert.deepEqual(await reservations(f), [
    { holder_kind: 'withdrawal', state: 'held', amount: '1500000' },
  ]);
});

test('one unfinished owner operation per wallet; concurrent creates: exactly one wins', async (t) => {
  const f = await setup(t);
  const [a, b] = await Promise.all([create(f, usdc(1)), create(f, usdc(2, { amount: '7' }))]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [201, 409]);
  const winner = a.statusCode === 201 ? a.json() : b.json();
  const loser = a.statusCode === 201 ? b.json() : a.json();
  assert.equal(loser.code, 'operation_pending');
  assert.equal(loser.withdrawalId, winner.withdrawalId);
  // Signed and not final, it still blocks; final, the wallet is free again.
  await post(f, `${winner.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, winner.userOpHash),
  });
  assert.equal((await create(f, usdc(3))).json().code, 'operation_pending');
  f.chain.include(winner.userOpHash);
  assert.equal((await create(f, usdc(4))).json().code, 'operation_pending');
  f.chain.mine(3);
  assert.equal((await read(f, winner.withdrawalId)).json().state, 'final');
  assert.equal((await create(f, usdc(5, { amount: '1000' }))).statusCode, 201);
  // Another wallet of the same owner is independent.
  assert.equal((await create(f, usdc(6), { agent: AI_AGENT })).statusCode, 201);
});

test('settled at Base’s safe head, an operation no longer blocks the next; its amount stays held until final', async (t) => {
  const f = await setup(t);
  f.chain.state.safeDepth = 1n;
  const first = await signedWithdrawal(f, 1);
  f.chain.include(first.userOpHash);
  // In a block, not yet safe: still the wallet's open operation, and not shown as safe.
  const included = (await read(f, first.withdrawalId)).json();
  assert.equal(included.state, 'included');
  assert.equal(included.safe, false);
  const early = (await create(f, usdc(2))).json();
  assert.equal(early.code, 'operation_pending');
  assert.equal(early.withdrawalId, first.withdrawalId);
  f.chain.mine(1);
  // Base can't tell (the safe tag fails): it still blocks, never guessed.
  f.chain.state.safeDown = true;
  assert.equal((await create(f, usdc(3))).json().code, 'operation_pending');
  assert.equal((await read(f, first.withdrawalId)).json().safe, false);
  f.chain.state.safeDown = false;
  // The receipt no longer matches the canonical block (a reorg): it still blocks.
  const txHash = included.txHash as string;
  f.chain.state.reorged.add(txHash);
  assert.equal((await create(f, usdc(4))).json().code, 'operation_pending');
  f.chain.state.reorged.delete(txHash);
  // Proven settled at the safe head (canonical block, nonce used), not final: the next one starts.
  const settled = (await read(f, first.withdrawalId)).json();
  assert.equal(settled.state, 'included', 'safe is not final');
  assert.equal(settled.safe, true);
  const next = await created(f, 5);
  assert.equal(BigInt(next.userOperation.nonce), BigInt(first.userOperation.nonce) + 1n);
  // The first one's amount is still held next to the new one until it is final.
  const held = (await reservations(f)).filter((row) => row.state === 'held');
  assert.equal(held.length, 2, JSON.stringify(held));
  // Only one unlanded operation at a time: a third waits for the second to land.
  assert.equal((await create(f, usdc(6))).json().code, 'operation_pending');
  f.chain.mine(3);
  const final = (await read(f, first.withdrawalId)).json();
  assert.equal(final.state, 'final');
  assert.equal(final.safe, true);
});

test('a reverted operation settled at the safe head lets the next one start but is never shown as safe', async (t) => {
  const f = await setup(t);
  f.chain.state.safeDepth = 1n;
  const first = await signedWithdrawal(f, 1);
  f.chain.include(first.userOpHash, false);
  f.chain.mine(1);
  const reverted = (await read(f, first.withdrawalId)).json();
  assert.equal(reverted.state, 'included');
  assert.equal(reverted.errorCode, 'reverted');
  assert.equal(reverted.safe, false, 'a revert sent nothing');
  // Its nonce is used for good: the next one may start; the first one's hold stays until final.
  const next = await created(f, 2);
  assert.equal(BigInt(next.userOperation.nonce), BigInt(first.userOperation.nonce) + 1n);
});

test('a block dropped after the next operation started: the first is on its way again, both stay held, no third starts', async (t) => {
  const f = await setup(t);
  f.chain.state.safeDepth = 1n;
  const first = await signedWithdrawal(f, 1);
  f.chain.include(first.userOpHash);
  f.chain.mine(1);
  assert.equal((await read(f, first.withdrawalId)).json().safe, true);
  const second = await created(f, 2);
  // Base drops the block that carried the first one (deeper than its safe head said).
  f.chain.uninclude(first.userOpHash);
  const back = await read(f, first.withdrawalId);
  assert.equal(back.statusCode, 200, back.body);
  assert.equal(back.json().state, 'submitted');
  assert.equal(back.json().safe, false);
  assert.equal((await read(f, second.withdrawalId)).json().state, 'awaiting_signature');
  // Both amounts stay held; nothing else starts while either is unlanded.
  const held = (await reservations(f)).filter((row) => row.state === 'held');
  assert.equal(held.length, 2, JSON.stringify(held));
  const third = (await create(f, usdc(3))).json();
  assert.equal(third.code, 'operation_pending');
  // The first lands again and is final; the second is still there to sign, at the next nonce.
  f.chain.include(first.userOpHash);
  f.chain.mine(3);
  assert.equal((await read(f, first.withdrawalId)).json().state, 'final');
  const signed = await post(f, `${second.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, second.userOpHash),
  });
  assert.equal(signed.statusCode, 202, signed.body);
  assert.equal(signed.json().state, 'submitted');
  assert.equal(BigInt(second.userOperation.nonce), BigInt(first.userOperation.nonce) + 1n);
  f.chain.include(second.userOpHash);
  assert.equal((await read(f, second.withdrawalId)).json().state, 'included');
});

test('the safe-head proof is the operation’s own: a cancel’s transaction named for it is never safe and never admits the next', async (t) => {
  const f = await setup(t);
  f.chain.state.safeDepth = 1n;
  const body = await signedWithdrawal(f, 1);
  const asked = (await post(f, `${body.withdrawalId}/cancel`, {})).json();
  const cancelHash = asked.cancel.userOpHash as Hex;
  const signedCancel = await post(f, `${body.withdrawalId}/cancel/signature`, {
    signature: await rawSign(f.owner, cancelHash),
  });
  assert.equal(signedCancel.statusCode, 202, signedCancel.body);
  f.chain.include(cancelHash);
  // A bundler answers the no-op's landing for the original (a stale or wrong receipt).
  f.chain.state.receiptLie.set(body.userOpHash, cancelHash);
  f.chain.mine(1);
  const cancelLanded = f.chain.state.landed.get(cancelHash)!;
  const lied = (await read(f, body.withdrawalId)).json();
  assert.equal(lied.state, 'included');
  assert.equal(lied.txHash, cancelLanded.txHash);
  assert.equal(lied.safe, false, 'the no-op’s receipt proves nothing about the original');
  const next = (await create(f, usdc(2))).json();
  assert.equal(next.code, 'operation_pending');
  assert.equal(next.withdrawalId, body.withdrawalId);

  // The proof itself: the same receipt proves the no-op, at its own hash, nonce and outcome only.
  const proof = {
    sender: f.wallets[AGENT],
    nonce: BigInt(body.userOperation.nonce),
    txHash: cancelLanded.txHash,
    blockNumber: cancelLanded.blockNumber,
    success: true,
  };
  const settledAtSafe = f.port.settledAtSafe!;
  assert.equal(await settledAtSafe({ ...proof, userOpHash: cancelHash }), true);
  assert.equal(await settledAtSafe({ ...proof, userOpHash: body.userOpHash }), false);
  assert.equal(await settledAtSafe({ ...proof, userOpHash: cancelHash, success: false }), false);
  assert.equal(
    await settledAtSafe({ ...proof, userOpHash: cancelHash, nonce: proof.nonce + 1n }),
    false,
  );
  assert.equal(
    await settledAtSafe({ ...proof, userOpHash: cancelHash, blockNumber: proof.blockNumber + 1n }),
    false,
  );
  // A node answering the nonce of another lane proves nothing.
  f.chain.state.nonceKeyLie = OWNER_NONCE_KEY + 1n;
  assert.equal(await settledAtSafe({ ...proof, userOpHash: cancelHash }), false);
  f.chain.state.nonceKeyLie = null;
  // Base can't tell: null, never a guess.
  f.chain.state.nodeDown = true;
  assert.equal(await settledAtSafe({ ...proof, userOpHash: cancelHash }), null);
});

test('the safe-head proof fails closed: a transaction re-mined as reverted at the same height, or a nonce on another lane, is not safe', async (t) => {
  const f = await setup(t);
  f.chain.state.safeDepth = 1n;
  const first = await signedWithdrawal(f, 1);
  f.chain.include(first.userOpHash);
  f.chain.mine(1);
  const tx = f.chain.state.landed.get(first.userOpHash)!.txHash;
  f.chain.state.txFailed.add(tx);
  assert.equal((await read(f, first.withdrawalId)).json().safe, false);
  assert.equal((await create(f, usdc(2))).json().code, 'operation_pending');
  f.chain.state.txFailed.delete(tx);
  f.chain.state.nonceKeyLie = OWNER_NONCE_KEY + 1n;
  assert.equal((await read(f, first.withdrawalId)).json().safe, false);
  assert.equal((await create(f, usdc(3))).json().code, 'operation_pending');
  f.chain.state.nonceKeyLie = null;
  assert.equal((await read(f, first.withdrawalId)).json().safe, true);
  assert.equal((await create(f, usdc(4))).statusCode, 201);
});

test('an operation settled at the safe head and then final releases its hold at the next create, with no read in between', async (t) => {
  const f = await setup(t);
  f.chain.state.safeDepth = 1n;
  const first = await signedWithdrawal(f, 1);
  f.chain.include(first.userOpHash);
  f.chain.mine(1);
  assert.equal((await read(f, first.withdrawalId)).json().safe, true);
  // Final now, and nobody read it.
  f.chain.mine(3);
  const next = await created(f, 2, { amount: 'max' });
  assert.equal((next.summary.amount as { raw: string }).raw, '5000000', 'nothing held any more');
  const { rows } = await f.pg.query<{ state: string }>(
    'SELECT state FROM base_wallet_withdrawals WHERE withdrawal_id = $1',
    [first.withdrawalId],
  );
  assert.equal(rows[0].state, 'final');
  assert.deepEqual(
    (await reservations(f)).map((row) => row.state),
    ['consumed', 'held'],
  );
});

test('only the wallet owner: co-owners, strangers and other principals get nothing', async (t) => {
  const f = await setup(t);
  // ai-1 is co-owned; person-1 set the wallet up, so person-2 sees it but cannot withdraw.
  const coOwner = await create(f, usdc(1), {
    person: 'person-2',
    workspace: 'ai-1',
    agent: AI_AGENT,
  });
  assert.equal(coOwner.statusCode, 404);
  assert.equal((await create(f, usdc(2), { person: 'person-2' })).statusCode, 404);
  assert.equal((await create(f, usdc(3), { person: 'ai-1' })).statusCode, 404);
  const anonymous = await f.app.inject({
    method: 'POST',
    url: url(),
    headers: json,
    payload: '{}',
  });
  assert.equal(anonymous.statusCode, 401);
  const bearer = await f.app.inject({
    method: 'POST',
    url: url(),
    headers: { ...json, authorization: 'Bearer ccw_test-token-0001' },
    payload: '{}',
  });
  assert.equal(bearer.statusCode, 404);
  // The owner, with or without the AI workspace selected.
  const mine = await created(f, 4);
  const viaWorkspace = await create(f, usdc(5), { workspace: 'ai-1', agent: AI_AGENT });
  assert.equal(viaWorkspace.statusCode, 201, viaWorkspace.body);
  // Someone else's withdrawal: not readable, not signable, not cancellable.
  assert.equal((await read(f, mine.withdrawalId, 'person-2')).statusCode, 404);
  const foreignSig = await post(
    f,
    `${mine.withdrawalId}/signature`,
    { signature: await rawSign(f.owner, mine.userOpHash) },
    'person-2',
  );
  assert.equal(foreignSig.statusCode, 404);
  assert.equal((await post(f, `${mine.withdrawalId}/cancel`, {}, 'person-2')).statusCode, 404);
  // A withdrawal id under another agent's path is not found either.
  assert.equal((await read(f, mine.withdrawalId, 'person-1', AI_AGENT)).statusCode, 404);
  assert.equal((await read(f, 'not-a-uuid')).statusCode, 404);
});

test('a removed or transferred agent stays withdrawable by the wallet owner (gate 3)', async (t) => {
  const f = await setup(t);
  await f.pg.query('DELETE FROM agent_manifests WHERE agent_id = $1', [AGENT]);
  const removed = await signedWithdrawal(f, 1);
  f.chain.include(removed.userOpHash);
  f.chain.mine(3);
  assert.equal((await read(f, removed.withdrawalId)).json().state, 'final');
  // Transferred to someone else: still the owner's money, and only the owner's.
  await f.pg.query("INSERT INTO agent_manifests VALUES ($1, 'person-2', 2, '{}')", [AGENT]);
  await f.pg.query("UPDATE base_wallets SET operator_id = 'person-2', state = 'frozen'");
  assert.equal((await create(f, usdc(2, { amount: '1000' }))).statusCode, 201);
  assert.equal((await create(f, usdc(3), { person: 'person-2' })).statusCode, 404);
});

test('the network is pinned: no chain id from the body, only the wallet-network wallet is used', async (t) => {
  const f = await setup(t);
  for (const extra of [
    { chainId: OTHER_EXPECTED.chainId },
    { chainId: WALLET_EXPECTED.chainId },
    { from: f.wallets[AGENT] },
  ]) {
    const res = await create(f, usdc(1, extra));
    assert.equal(res.statusCode, 400, JSON.stringify(extra));
    assert.equal(res.json().code, 'invalid_body');
  }
  // A wallet of the same agent on the other network is never touched.
  await f.pg.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at, owner_account_id)
     VALUES ('wallet-other', $1, 'person-1', $5, $2, $3, $4, 'v1:k', '{}', 'derived', 1, 1, 'person-1')`,
    [AGENT, getAddress(`0x${'4d'.repeat(20)}`), f.owner.address, SPENDER, OTHER_EXPECTED.chainId],
  );
  const body = await created(f, 2);
  assert.equal(body.summary.from, f.wallets[AGENT]);
  assert.equal(body.chainId, WALLET_EXPECTED.chainId);
  assert.deepEqual([...new Set(f.runtimeCalls)], [WALLET_EXPECTED.chainId]);
});

test('signatures: only the owner key over the raw hash; prefixed or foreign ones are refused', async (t) => {
  const f = await setup(t);
  const body = await created(f, 1);
  const sign = (signature: unknown) => post(f, `${body.withdrawalId}/signature`, { signature });
  for (const malformed of ['0x1234', `0x${'00'.repeat(64)}`, 7, null]) {
    const res = await sign(malformed);
    assert.equal(res.statusCode, 400, String(malformed));
    assert.equal(res.json().code, 'invalid_signature');
  }
  const extra = await post(f, `${body.withdrawalId}/signature`, { signature: '0x', chainId: 1 });
  assert.equal(extra.statusCode, 400);
  // personal_sign of the hash (EIP-191 prefix): the wallet would recover someone else.
  const prefixed = await sign(await f.owner.signMessage({ message: { raw: body.userOpHash } }));
  assert.equal(prefixed.statusCode, 422);
  assert.equal(prefixed.json().code, 'signature_mismatch');
  const stranger = privateKeyToAccount(generatePrivateKey());
  const foreign = await sign(await rawSign(stranger, body.userOpHash));
  assert.equal(foreign.statusCode, 422);
  // The owner key over another hash.
  const otherHash = await sign(await rawSign(f.owner, keccak256('0x01')));
  assert.equal(otherHash.statusCode, 422);
  assert.equal(f.chain.state.sends.length, 0);
  assert.equal((await read(f, body.withdrawalId)).json().state, 'awaiting_signature');

  const ok = await sign(await rawSign(f.owner, body.userOpHash));
  assert.equal(ok.statusCode, 202, ok.body);
  // Signed already: a wrong signature is still refused and changes nothing.
  assert.equal((await sign(await rawSign(stranger, body.userOpHash))).statusCode, 422);
  assert.equal(f.chain.state.sends.length, 1);
  assert.deepEqual(f.chain.state.rejected, []);
});

test('expired only while unsigned: unsigned ones lapse and free the wallet; signed ones stay live', async (t) => {
  const f = await setup(t);
  const body = await created(f, 1);
  f.clock.now += WITHDRAWAL_SIGNATURE_TTL_MS;
  const lapsed = (await read(f, body.withdrawalId)).json();
  assert.equal(lapsed.state, 'expired');
  assert.equal(lapsed.expiresAt, null);
  const late = await post(f, `${body.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, body.userOpHash),
  });
  assert.equal(late.statusCode, 410);
  assert.equal(late.json().code, 'expired');
  assert.equal(f.chain.state.sends.length, 0);
  assert.deepEqual(await reservations(f), [
    { holder_kind: 'withdrawal', state: 'released', amount: '1500000' },
  ]);

  // A lapsed one does not block the wallet, even before anyone read it.
  const second = await created(f, 2);
  f.clock.now += WITHDRAWAL_SIGNATURE_TTL_MS + 1;
  const third = await created(f, 3);
  assert.equal((await read(f, second.withdrawalId)).json().state, 'expired');
  // The new one reuses the same nonce: only one of them could ever land.
  assert.equal(
    userOperationFromRpc(third.userOperation).nonce,
    userOperationFromRpc(second.userOperation).nonce,
  );
  await post(f, `${third.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, third.userOpHash),
  });
  f.clock.now += 7 * 24 * 3600_000;
  const week = (await read(f, third.withdrawalId)).json();
  assert.equal(week.state, 'submitted', 'a signed operation is live until its nonce is used');
  const resend = await post(f, `${third.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, third.userOpHash),
  });
  assert.equal(resend.statusCode, 202);
  const kinds = (await auditKinds(f)).map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === 'withdrawal_expired').length, 2);
});

test('cancel race: the original wins, so the withdrawal follows it', async (t) => {
  const f = await setup(t);
  const body = await signedWithdrawal(f, 1);
  const asked = await post(f, `${body.withdrawalId}/cancel`, {});
  assert.equal(asked.statusCode, 200, asked.body);
  const view = asked.json();
  assert.equal(view.state, 'cancel_pending');
  assert.equal(view.cancel.state, 'awaiting_signature');
  const noop = userOperationFromRpc(view.cancel.userOperation);
  const original = userOperationFromRpc(body.userOperation);
  assert.equal(ownerOperationHash(noop), view.cancel.userOpHash);
  assert.deepEqual(decodeOwnerCall(noop.callData, f.wallets[AGENT]), { kind: 'noop' });
  assert.equal(noop.nonce, original.nonce, 'the same nonce');
  assert.equal(noop.initCode, original.initCode, 'still undeployed: deploys too');
  assert.ok(noop.maxFeePerGas * 10n > original.maxFeePerGas * 11n, 'outbids the original');
  // Asking again returns the same no-op.
  const same = (await post(f, `${body.withdrawalId}/cancel`, {})).json();
  assert.equal(same.cancel.userOpHash, view.cancel.userOpHash);
  // A signature over the original is not one over the cancel.
  const wrong = await post(f, `${body.withdrawalId}/cancel/signature`, {
    signature: await rawSign(f.owner, body.userOpHash),
  });
  assert.equal(wrong.statusCode, 422);
  const signedCancel = await post(f, `${body.withdrawalId}/cancel/signature`, {
    signature: await rawSign(f.owner, view.cancel.userOpHash),
  });
  assert.equal(signedCancel.statusCode, 202, signedCancel.body);
  assert.equal(signedCancel.json().state, 'cancel_pending');
  assert.equal(f.chain.state.sends.length, 2);

  // The original lands first: the no-op can never land, the withdrawal is the original's.
  f.chain.include(body.userOpHash);
  const included = (await read(f, body.withdrawalId)).json();
  assert.equal(included.state, 'included');
  f.chain.mine(3);
  const final = (await read(f, body.withdrawalId)).json();
  assert.equal(final.state, 'final');
  assert.equal(final.cancel.state, 'failed');
  assert.deepEqual(await reservations(f), [
    { holder_kind: 'withdrawal', state: 'consumed', amount: '1500000' },
  ]);
  const kinds = (await auditKinds(f)).map((e) => e.kind);
  assert.ok(kinds.includes('withdrawal_final'));
  assert.ok(!kinds.includes('withdrawal_cancelled'));
});

test('cancel: the no-op wins, and only once it is final does the withdrawal say cancelled', async (t) => {
  const f = await setup(t);
  const body = await signedWithdrawal(f, 1);
  const view = (await post(f, `${body.withdrawalId}/cancel`, {})).json();
  assert.equal(
    (
      await post(f, `${body.withdrawalId}/cancel/signature`, {
        signature: await rawSign(f.owner, view.cancel.userOpHash),
      })
    ).statusCode,
    202,
  );
  f.chain.include(view.cancel.userOpHash);
  const landed = (await read(f, body.withdrawalId)).json();
  assert.equal(landed.state, 'cancel_pending', 'not cancelled before the no-op is final');
  assert.equal(landed.cancel.state, 'included');
  f.chain.mine(2);
  assert.equal((await read(f, body.withdrawalId)).json().state, 'cancel_pending');
  f.chain.mine(1);
  const done = (await read(f, body.withdrawalId)).json();
  assert.equal(done.state, 'cancelled');
  assert.equal(done.cancel.state, 'final');
  assert.match(done.cancel.txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(done.txHash, null, 'the withdrawal itself never landed');
  assert.deepEqual(await reservations(f), [
    { holder_kind: 'withdrawal', state: 'released', amount: '1500000' },
  ]);
  const ops = await f.pg.query<{ kind: string; status: string; error_code: string | null }>(
    'SELECT kind, status, error_code FROM base_chain_ops ORDER BY kind',
  );
  assert.deepEqual(ops.rows, [
    { kind: 'withdraw', status: 'failed', error_code: 'NONCE_CONSUMED' },
    { kind: 'withdraw_cancel', status: 'final', error_code: null },
  ]);
  assert.deepEqual(
    (await auditKinds(f)).map((e) => e.kind),
    [
      'withdrawal_created',
      'withdrawal_signed',
      'withdrawal_submitted',
      'withdrawal_cancel_requested',
      'withdrawal_cancel_signed',
      'withdrawal_cancel_submitted',
      'withdrawal_cancelled',
    ],
  );
  // The wallet is free again, and the next nonce is the one after the no-op.
  const next = await created(f, 2, { amount: '1000' });
  assert.equal(userOperationFromRpc(next.userOperation).nonce, (OWNER_NONCE_KEY << 64n) | 1n);
});

test('cancel race: a read that began before the cancel was signed never decides from its older row', async (t) => {
  const f = await setup(t);
  const body = await signedWithdrawal(f, 1);
  const view = (await post(f, `${body.withdrawalId}/cancel`, {})).json();
  // A read starts while the cancel is still unsigned and is held inside its first chain refresh.
  const port = f.port;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inRefresh = new Promise<void>((resolve) => (entered = resolve));
  let held = false;
  f.runtime.ownerOperations = {
    ...port,
    refresh: async (key) => {
      if (!held) {
        held = true;
        entered();
        await gate;
      }
      return port.refresh(key);
    },
  };
  const stale = read(f, body.withdrawalId);
  await inRefresh;
  // Meanwhile the owner signs the cancel and the no-op lands, final: the original's nonce is used.
  assert.equal(
    (
      await post(f, `${body.withdrawalId}/cancel/signature`, {
        signature: await rawSign(f.owner, view.cancel.userOpHash),
      })
    ).statusCode,
    202,
  );
  f.chain.include(view.cancel.userOpHash);
  f.chain.mine(3);
  // The held read resumes and sees the original NONCE_CONSUMED. Its row has no cancel signature,
  // so on its own it would decide 'failed' and release the holds: the write must not apply.
  release();
  const resumed = (await stale).json();
  assert.notEqual(resumed.state, 'failed', 'never failed from the older row');
  const done = (await read(f, body.withdrawalId)).json();
  assert.equal(done.state, 'cancelled');
  assert.equal(done.cancel.state, 'final');
  assert.deepEqual(await reservations(f), [
    { holder_kind: 'withdrawal', state: 'released', amount: '1500000' },
  ]);
  const kinds = (await auditKinds(f)).map((e) => e.kind);
  assert.ok(!kinds.includes('withdrawal_failed'), kinds.join(', '));
  assert.equal(kinds.filter((kind) => kind === 'withdrawal_cancelled').length, 1);
});

test('cancel: an unsigned cancel lapses back to the live withdrawal; included ones cannot be cancelled', async (t) => {
  const f = await setup(t);
  const body = await signedWithdrawal(f, 1);
  const first = (await post(f, `${body.withdrawalId}/cancel`, {})).json();
  f.clock.now += WITHDRAWAL_SIGNATURE_TTL_MS;
  const lapsed = (await read(f, body.withdrawalId)).json();
  assert.equal(lapsed.state, 'submitted');
  assert.equal(lapsed.cancel.state, 'expired');
  assert.equal(lapsed.cancel.userOperation, null);
  const late = await post(f, `${body.withdrawalId}/cancel/signature`, {
    signature: await rawSign(f.owner, first.cancel.userOpHash),
  });
  assert.equal(late.statusCode, 410);
  // A new cancel replaces the lapsed one.
  const second = (await post(f, `${body.withdrawalId}/cancel`, {})).json();
  assert.equal(second.state, 'cancel_pending');
  assert.notEqual(second.cancel.userOpHash, first.cancel.userOpHash);
  // The original lands before the cancel is signed: too late to cancel.
  f.chain.include(body.userOpHash);
  const tooLate = await post(f, `${body.withdrawalId}/cancel`, {});
  assert.equal(tooLate.statusCode, 409);
  assert.equal(tooLate.json().code, 'not_cancellable');
  assert.equal(tooLate.json().state, 'included');
  assert.equal(
    (await post(f, `${body.withdrawalId}/cancel`, { force: true })).statusCode,
    400,
    'a cancel takes no settings',
  );
});

test('a reverted withdrawal fails once final; its hold counts only until reads pass its block', async (t) => {
  const f = await setup(t);
  const body = await signedWithdrawal(f, 1);
  f.chain.include(body.userOpHash, false);
  const reverted = (await read(f, body.withdrawalId)).json();
  assert.equal(reverted.state, 'included');
  assert.equal(reverted.errorCode, 'reverted');
  f.chain.mine(3);
  const failed = (await read(f, body.withdrawalId)).json();
  assert.equal(failed.state, 'failed');
  assert.equal(failed.errorCode, 'reverted');
  // It landed (and, unsponsored, would have paid gas): consumed, so a read from before its block
  // still counts it; a read at or after that block sees the real balance and nothing is held.
  assert.deepEqual(await reservations(f), [
    { holder_kind: 'withdrawal', state: 'consumed', amount: '1500000' },
  ]);
  const next = await created(f, 2, { amount: 'max' });
  assert.deepEqual((next.summary.amount as { raw: string }).raw, '5000000');
});

test('fee cap: above it nothing is prepared, held or stored (503 fee_cap)', async (t) => {
  const capped = await setup(t, { maxFeePerGasCap: 1_000_000n });
  const res = await create(capped, usdc(1));
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, 'fee_cap');
  assert.equal(capped.chain.state.paymasterCalls, 0);
  assert.equal((await capped.pg.query('SELECT 1 FROM base_wallet_withdrawals')).rows.length, 0);
  assert.deepEqual(await reservations(capped), []);

  const costly = await setup(t, { maxCostWeiCap: 1_000n });
  const bound = await create(costly, usdc(1));
  assert.equal(bound.statusCode, 503);
  assert.equal(bound.json().code, 'fee_cap');
  assert.deepEqual(await reservations(costly), []);
  // Fees fall back under the cap: the same key now goes through.
  capped.chain.state.fees = { maxFeePerGas: 900_000n, maxPriorityFeePerGas: 100_000n, baseFee: 1n };
  assert.equal((await create(capped, usdc(1))).statusCode, 201);
});

test('fallback on, sponsor refused: an owner-funded withdrawal paid from the wallet ETH, fee in the summary', async (t) => {
  const f = await setup(t, { env: FALLBACK_ON });
  f.chain.state.sponsor = false;
  const body = await created(f, 1);
  const op = userOperationFromRpc(body.userOperation);
  assert.equal(op.paymasterAndData, '0x', 'no paymaster');
  const fee = UNSPONSORED_GAS * op.maxFeePerGas;
  assert.equal(maxCostWei(op), fee);
  assert.equal(body.summary.sponsored, false);
  assert.deepEqual(body.summary.fee, {
    paidBy: 'wallet',
    token: 'ETH',
    max: { raw: fee.toString(10), decimals: 18, display: '0.0000007' },
  });
  // The USDC and, separately, the most the gas can cost are both held.
  assert.deepEqual(await reservations(f), [
    { holder_kind: 'withdrawal', state: 'held', amount: '1500000' },
    { holder_kind: 'withdrawal', state: 'held', amount: fee.toString(10) },
  ]);
  const signed = await post(f, `${body.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, body.userOpHash),
  });
  assert.equal(signed.statusCode, 202, signed.body);
  assert.equal(signed.json().sponsored, false);
  assert.equal(f.chain.state.sends.length, 1, 'the wallet could prefund it');
  assert.deepEqual(f.chain.state.rejected, []);
  f.chain.include(body.userOpHash);
  f.chain.mine(3);
  const final = (await read(f, body.withdrawalId)).json();
  assert.equal(final.state, 'final');
  assert.equal(final.fee.paidBy, 'wallet');
  assert.deepEqual(
    (await reservations(f)).map((r) => r.state),
    ['consumed', 'consumed'],
  );
});

test('fallback on, sponsor refused, too little ETH for the gas: 409 fee_unfunded, nothing held', async (t) => {
  const f = await setup(t, { env: FALLBACK_ON });
  f.chain.state.sponsor = false;
  const fee = UNSPONSORED_GAS * 2_000_000n;
  f.chain.state.balances.set(f.wallets[AGENT].toLowerCase(), { usdc: 5_000_000n, eth: fee - 1n });
  const usdcOut = await create(f, usdc(1));
  assert.equal(usdcOut.statusCode, 409, usdcOut.body);
  assert.equal(usdcOut.json().code, 'fee_unfunded');
  assert.equal(usdcOut.json().fee.raw, fee.toString(10));
  assert.equal(usdcOut.json().needed.raw, fee.toString(10));
  assert.equal(usdcOut.json().available.raw, (fee - 1n).toString(10));
  // An ETH amount that fits but leaves too little for its gas: refused, never shrunk.
  f.chain.state.balances.set(f.wallets[AGENT].toLowerCase(), { usdc: 0n, eth: 10n ** 15n });
  const ethOut = await create(f, usdc(2, { token: 'ETH', amount: '999999999999999' }));
  assert.equal(ethOut.statusCode, 409);
  assert.equal(ethOut.json().code, 'fee_unfunded');
  assert.equal(ethOut.json().needed.raw, (999_999_999_999_999n + fee).toString(10));
  assert.equal((await f.pg.query('SELECT 1 FROM base_wallet_withdrawals')).rows.length, 0);
  assert.deepEqual(await reservations(f), []);
  assert.equal(f.chain.state.sends.length, 0);
  // 'max' ETH unsponsored is what is left after the gas, and holds exactly the balance.
  const max = await created(f, 3, { token: 'ETH', amount: 'max' });
  assert.equal(max.summary.sponsored, false);
  assert.deepEqual(max.summary.amount, {
    raw: (10n ** 15n - fee).toString(10),
    decimals: 18,
    display: '0.0009993',
  });
  assert.deepEqual(await reservations(f), [
    { holder_kind: 'withdrawal', state: 'held', amount: (10n ** 15n).toString(10) },
  ]);
});

test('fallback on, sponsor refused: the fee caps hold on the owner-funded path too', async (t) => {
  const costly = await setup(t, { env: FALLBACK_ON, maxCostWeiCap: 1_000n });
  costly.chain.state.sponsor = false;
  const bound = await create(costly, usdc(1));
  assert.equal(bound.statusCode, 503);
  assert.equal(bound.json().code, 'fee_cap');
  const capped = await setup(t, { env: FALLBACK_ON, maxFeePerGasCap: 1_000_000n });
  capped.chain.state.sponsor = false;
  const fees = await create(capped, usdc(1));
  assert.equal(fees.statusCode, 503);
  assert.equal(fees.json().code, 'fee_cap');
  for (const f of [costly, capped]) {
    assert.equal((await f.pg.query('SELECT 1 FROM base_wallet_withdrawals')).rows.length, 0);
    assert.deepEqual(await reservations(f), []);
  }
});

test('fallback on, cancel without a sponsor: the no-op is paid from the wallet ETH, or refused unfunded', async (t) => {
  const f = await setup(t, { env: FALLBACK_ON });
  // A USDC withdrawal, signed while sponsored; then the paymaster stops sponsoring.
  const body = await signedWithdrawal(f, 1);
  f.chain.state.sponsor = false;
  f.chain.state.balances.set(f.wallets[AGENT].toLowerCase(), { usdc: 5_000_000n, eth: 0n });
  const broke = await post(f, `${body.withdrawalId}/cancel`, {});
  assert.equal(broke.statusCode, 409, broke.body);
  assert.equal(broke.json().code, 'fee_unfunded');
  assert.equal((await read(f, body.withdrawalId)).json().state, 'submitted');
  f.chain.state.balances.set(f.wallets[AGENT].toLowerCase(), { usdc: 5_000_000n, eth: 10n ** 15n });
  const view = (await post(f, `${body.withdrawalId}/cancel`, {})).json();
  assert.equal(view.state, 'cancel_pending');
  assert.equal(view.cancel.sponsored, false);
  const noop = userOperationFromRpc(view.cancel.userOperation);
  assert.equal(noop.paymasterAndData, '0x');
  assert.equal(view.cancel.fee.max.raw, maxCostWei(noop).toString(10));
  assert.equal(view.sponsored, true, 'the withdrawal itself stays sponsored');
  const signed = await post(f, `${body.withdrawalId}/cancel/signature`, {
    signature: await rawSign(f.owner, view.cancel.userOpHash),
  });
  assert.equal(signed.statusCode, 202, signed.body);
  assert.deepEqual(f.chain.state.rejected, []);
  f.chain.include(view.cancel.userOpHash);
  f.chain.mine(3);
  assert.equal((await read(f, body.withdrawalId)).json().state, 'cancelled');
  // The no-op's gas was held from the moment it was asked for, and is spent now.
  const holds = await f.pg.query<{ state: string; amount: string }>(
    "SELECT state, amount::text AS amount FROM base_wallet_reservations WHERE holder_ref LIKE '%:cancel:%'",
  );
  assert.deepEqual(holds.rows, [{ state: 'consumed', amount: view.cancel.fee.max.raw }]);
});

test('fees covered by default: refused, unreachable, empty or charging sponsorship fails closed (503)', async (t) => {
  const f = await setup(t);
  const cases: Array<[string, () => void]> = [
    ['refused', () => (f.chain.state.sponsor = false)],
    ['paymaster unreachable', () => (f.chain.state.paymasterDown = true)],
    ['empty paymaster data', () => (f.chain.state.paymasterEmpty = true)],
    ['whole endpoint unreachable', () => (f.chain.state.bundlerDown = true)],
    ['a paymaster not on the allowlist', () => (f.chain.state.paymasterAnswer = 'foreign')],
    ['a token to charge the wallet in', () => (f.chain.state.paymasterAnswer = 'token')],
    ['malformed paymaster data', () => (f.chain.state.paymasterAnswer = 'short')],
  ];
  for (const [n, [name, breakIt]] of cases.entries()) {
    Object.assign(f.chain.state, {
      sponsor: true,
      paymasterDown: false,
      paymasterEmpty: false,
      paymasterAnswer: 'pinned',
      bundlerDown: false,
    });
    breakIt();
    for (const payload of [usdc(n + 1), usdc(n + 11, { token: 'ETH', amount: 'max' })]) {
      const res = await create(f, payload);
      assert.equal(res.statusCode, 503, `${name}: ${res.body}`);
      const answer = res.json();
      assert.equal(answer.code, 'sponsorship_unavailable', name);
      assert.equal(answer.userOperation, undefined, 'nothing to sign');
      assert.equal(answer.userOpHash, undefined);
      assert.equal(answer.withdrawalId, undefined);
      assert.ok(!res.body.includes('test-key-0001'), 'the bundler URL never leaks');
    }
  }
  // Nothing stored (signable or otherwise), nothing held, nothing sent; the wallet stays free.
  assert.equal((await f.pg.query('SELECT 1 FROM base_wallet_withdrawals')).rows.length, 0);
  assert.deepEqual(await reservations(f), []);
  assert.equal(f.chain.state.sends.length, 0);
  assert.deepEqual(
    (await auditKinds(f)).map((e) => e.kind),
    [],
  );
  // Only the exact value '1' turns the owner-funded fallback on.
  for (const value of ['0', 'true', 'yes', ' 1', '1 ', 'on', '']) {
    const g = await setup(t, {
      env: { CITY_BASE_WALLET: '1', CITY_BASE_WALLET_UNSPONSORED_FALLBACK: value },
    });
    g.chain.state.sponsor = false;
    const res = await create(g, usdc(1));
    assert.equal(res.statusCode, 503, JSON.stringify(value));
    assert.equal(res.json().code, 'sponsorship_unavailable');
    assert.equal((await g.pg.query('SELECT 1 FROM base_wallet_withdrawals')).rows.length, 0);
    assert.deepEqual(await reservations(g), []);
  }
  // Sponsorship back: the same key now prepares a covered withdrawal.
  Object.assign(f.chain.state, { sponsor: true, bundlerDown: false, paymasterAnswer: 'pinned' });
  const covered = await created(f, 1);
  assert.equal(covered.summary.sponsored, true);
  assert.deepEqual(covered.summary.fee, {
    paidBy: 'sponsor',
    token: 'ETH',
    max: { raw: '0', decimals: 18, display: '0' },
  });
});

test('fees covered by default: a cancel without sponsorship fails closed, the withdrawal stays live', async (t) => {
  const f = await setup(t);
  const body = await signedWithdrawal(f, 1);
  for (const breakIt of [
    () => (f.chain.state.sponsor = false),
    () => (f.chain.state.paymasterDown = true),
    () => (f.chain.state.paymasterEmpty = true),
  ]) {
    Object.assign(f.chain.state, { sponsor: true, paymasterDown: false, paymasterEmpty: false });
    breakIt();
    const res = await post(f, `${body.withdrawalId}/cancel`, {});
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().code, 'sponsorship_unavailable');
    assert.equal(res.json().userOperation, undefined);
  }
  const view = (await read(f, body.withdrawalId)).json();
  assert.equal(view.state, 'submitted');
  assert.equal(view.cancel, null, 'no cancel stored to sign');
  assert.equal(f.chain.state.sends.length, 1, 'only the withdrawal itself');
});

test('no node or no owner-operation runtime: 503 chain_unavailable', async (t) => {
  const f = await setup(t);
  f.chain.state.nodeDown = true;
  const down = await create(f, usdc(2));
  assert.equal(down.statusCode, 503);
  assert.equal(down.json().code, 'chain_unavailable');
  assert.equal((await f.pg.query('SELECT 1 FROM base_wallet_withdrawals')).rows.length, 0);

  const bare = await setup(t, { noOwnerOperations: true });
  const res = await create(bare, usdc(1));
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, 'chain_unavailable');
});

test('a port without a cost cap: on Base 503 chain_unavailable and nothing held or stored; Base Sepolia runs', async (t) => {
  const f = await setup(t, { unbounded: true });
  const res = await create(f, usdc(1));
  if (WALLET_EXPECTED.testnet) {
    assert.equal(res.statusCode, 201, res.body);
    return;
  }
  assert.equal(res.statusCode, 503, res.body);
  assert.equal(res.json().code, 'chain_unavailable');
  assert.equal(f.chain.state.paymasterCalls, 0, 'nothing was even estimated');
  assert.deepEqual(await reservations(f), []);
  assert.equal((await f.pg.query('SELECT 1 FROM base_wallet_withdrawals')).rows.length, 0);
});

test('on Base an owner operation needs a fee budget: without one nothing is prepared or sent', async (t) => {
  const f = await setup(t);
  const wallet = f.wallets[AGENT];
  const calls = [withdrawalCall('USDC', DEST, 5n)];
  const portOn = (chainId: typeof BASE_MAINNET | typeof BASE_SEPOLIA, maxCostWeiCap?: bigint) =>
    createOwnerOperationsPort({
      network: BASE_NETWORKS[chainId],
      client: f.chain.client,
      store: pgChainOperationStore(f.db, () => f.clock.now),
      bundler: rpcBundler({
        url: 'https://bundler.test/rpc/test-key-0001',
        entryPoint: BASE_NETWORKS[chainId].contracts.entryPointV06,
        chainId,
        client: f.chain.client,
        maxFeePerGasCap: 10n ** 12n,
        stubSignature: walletSignature(`0x${'ff'.repeat(64)}1c`, { ownerIndex: 0 }),
        fetch: f.chain.fetch,
      }),
      maxCostWeiCap,
      sponsors: { [chainId]: [PAYMASTER] },
    });
  const recipeOn = (chainId: typeof BASE_MAINNET | typeof BASE_SEPOLIA) =>
    agentWalletRecipe(BASE_NETWORKS[chainId], f.owner.address, accountIndexFor(AGENT));
  const budgetRequired = (e: unknown) =>
    e instanceof OwnerOperationError && e.code === 'FEE_BUDGET_REQUIRED';

  const unbounded = portOn(BASE_MAINNET);
  await assert.rejects(
    unbounded.prepare({ wallet, recipe: recipeOn(BASE_MAINNET), calls }),
    budgetRequired,
  );
  assert.equal(f.chain.state.paymasterCalls, 0, 'nothing was even estimated');
  // An operation prepared within a budget is still never sent by a port without one.
  const prepared = await portOn(BASE_MAINNET, FEE_BUDGET).prepare({
    wallet,
    recipe: recipeOn(BASE_MAINNET),
    calls,
  });
  await assert.rejects(
    unbounded.submit({
      idempotencyKey: 'test:withdraw:unbounded',
      intentHash: `0x${'22'.repeat(32)}` as Hex,
      kind: 'withdraw',
      wallet,
      recipe: recipeOn(BASE_MAINNET),
      calls,
      operation: prepared.operation,
      userOpHash: prepared.userOpHash,
      owner: f.owner.address,
      ownerIndex: 0,
      signature: await rawSign(f.owner, prepared.userOpHash),
    }),
    budgetRequired,
  );
  assert.equal(f.chain.state.sends.length, 0);
  assert.equal((await f.pg.query('SELECT 1 FROM base_chain_ops')).rows.length, 0);
  // Base Sepolia may run without one.
  const onSepolia = await portOn(BASE_SEPOLIA).prepare({
    wallet,
    recipe: recipeOn(BASE_SEPOLIA),
    calls,
  });
  assert.equal(onSepolia.sponsored, true);
});

test('a signature stored while Base is unreachable is sent by the next read, exactly as signed', async (t) => {
  const f = await setup(t);
  const body = await created(f, 1);
  f.chain.state.nodeDown = true;
  const signed = await post(f, `${body.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, body.userOpHash),
  });
  assert.equal(signed.statusCode, 202, signed.body);
  assert.equal(signed.json().state, 'submitted');
  assert.equal((await f.pg.query('SELECT 1 FROM base_chain_ops')).rows.length, 0);
  assert.equal(f.chain.state.sends.length, 0);
  // Still down: the read keeps what is stored.
  assert.equal((await read(f, body.withdrawalId)).json().state, 'submitted');
  f.chain.state.nodeDown = false;
  assert.equal((await read(f, body.withdrawalId)).json().state, 'submitted');
  assert.equal(f.chain.state.sends.length, 1);
  assert.equal(f.chain.state.sends[0].hash, body.userOpHash);
  f.chain.include(body.userOpHash);
  f.chain.mine(3);
  assert.equal((await read(f, body.withdrawalId)).json().state, 'final');
  assert.equal((await auditKinds(f)).filter((e) => e.kind === 'withdrawal_submitted').length, 1);
});

test('the owner-operation port: a fixed sponsorship deadline refuses unbounded validity', async (t) => {
  const f = await setup(t);
  f.chain.state.sponsorValidUntil = () => 0;
  const input = {
    wallet: f.wallets[AGENT],
    recipe: agentWalletRecipe(NETWORK, f.owner.address, accountIndexFor(AGENT)),
    calls: [withdrawalCall('USDC', DEST, 5n)],
    sponsorshipDeadline: f.clock.now + WITHDRAWAL_SIGNATURE_TTL_MS,
  };
  await assert.rejects(
    f.port.prepare(input),
    (error: unknown) =>
      error instanceof OwnerOperationError && error.code === 'SPONSORSHIP_UNAVAILABLE',
  );
  f.chain.state.sponsorValidUntil = () => Math.floor(input.sponsorshipDeadline / 1000) + 1;
  await assert.rejects(
    f.port.prepare(input),
    (error: unknown) =>
      error instanceof OwnerOperationError && error.code === 'SPONSORSHIP_UNAVAILABLE',
  );
  f.chain.state.sponsorValidUntil = () => Math.floor(input.sponsorshipDeadline / 1000);
  assert.equal((await f.port.prepare(input)).sponsored, true);
});

test('the owner-operation port: never falls back by itself; a foreign signature or changed operation is never stored', async (t) => {
  const f = await setup(t);
  const wallet = f.wallets[AGENT];
  const recipe = agentWalletRecipe(NETWORK, f.owner.address, accountIndexFor(AGENT));
  const calls = [withdrawalCall('USDC', DEST, 5n)];
  f.chain.state.sponsor = false;
  await assert.rejects(
    f.port.prepare({ wallet, recipe, calls }),
    (e: unknown) => e instanceof OwnerOperationError && e.code === 'SPONSORSHIP_UNAVAILABLE',
  );
  f.chain.state.sponsor = true;
  f.chain.state.paymasterEmpty = true;
  await assert.rejects(
    f.port.prepare({ wallet, recipe, calls }),
    (e: unknown) => e instanceof OwnerOperationError && e.code === 'SPONSORSHIP_UNAVAILABLE',
  );
  f.chain.state.paymasterEmpty = false;
  const prepared = await f.port.prepare({ wallet, recipe, calls });
  assert.equal(prepared.sponsored, true);
  const base = {
    idempotencyKey: 'test:withdraw:1',
    intentHash: `0x${'11'.repeat(32)}` as Hex,
    kind: 'withdraw' as const,
    wallet,
    recipe,
    calls,
    operation: prepared.operation,
    userOpHash: prepared.userOpHash,
    owner: f.owner.address,
    ownerIndex: 0,
    signature: await rawSign(f.owner, prepared.userOpHash),
  };
  const stranger = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(
    f.port.submit({ ...base, signature: await rawSign(stranger, prepared.userOpHash) }),
    (e: unknown) => e instanceof OwnerOperationError && e.code === 'SIGNATURE_MISMATCH',
  );
  // The calls no longer match what was prepared (and signed).
  await assert.rejects(
    f.port.submit({ ...base, calls: [withdrawalCall('USDC', DEST, 6n)] }),
    (e: unknown) => e instanceof OwnerOperationError && e.code === 'UNAVAILABLE',
  );
  // An operation whose paymaster could charge the wallet is never stored or sent, whatever it says.
  for (const answer of ['token', 'foreign', 'short'] as const)
    await assert.rejects(
      f.port.submit({
        ...base,
        operation: { ...prepared.operation, paymasterAndData: sponsorData(answer, 1) },
      }),
      (e: unknown) => e instanceof OwnerOperationError && e.code === 'SPONSORSHIP_UNAVAILABLE',
      answer,
    );
  // A recipe that does not derive this wallet is refused before anything else.
  await assert.rejects(
    f.port.prepare({ wallet: f.wallets[AI_AGENT], recipe, calls: [noopCall(wallet)] }),
    (e: unknown) => e instanceof OwnerOperationError && e.code === 'WALLET_MISMATCH',
  );
  assert.equal((await f.pg.query('SELECT 1 FROM base_chain_ops')).rows.length, 0);
  assert.equal(f.chain.state.sends.length, 0);
  const stored = await f.port.submit(base);
  assert.equal(stored.status, 'submitted');
  assert.equal(stored.signer, f.owner.address);
});

test('shared: owner calls decode strictly; operations round-trip; signatures wrap with v 27/28', async () => {
  const wallet = getAddress(`0x${'1a'.repeat(20)}`);
  const execute = (target: Address, value: bigint, data: Hex) =>
    encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'execute',
          inputs: [
            { name: 'target', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
          ],
          outputs: [],
          stateMutability: 'payable',
        },
      ],
      args: [target, value, data],
    });
  const transfer = withdrawalCall('USDC', DEST, 9n);
  assert.deepEqual(decodeOwnerCall(execute(transfer.target, 0n, transfer.data), wallet), {
    kind: 'withdraw',
    token: 'USDC',
    to: DEST,
    amount: 9n,
  });
  assert.deepEqual(decodeOwnerCall(execute(DEST, 3n, '0x'), wallet), {
    kind: 'withdraw',
    token: 'ETH',
    to: DEST,
    amount: 3n,
  });
  assert.deepEqual(decodeOwnerCall(execute(wallet, 0n, '0x'), wallet), { kind: 'noop' });
  for (const callData of [
    execute(transfer.target, 1n, transfer.data), // value riding on a token call
    execute(transfer.target, 0n, concat([transfer.data, '0x00'])), // trailing bytes
    concat([execute(DEST, 3n, '0x'), '0x00']),
    execute(DEST, 0n, '0x'), // nothing sent
    execute(DEST, 3n, '0xabcdef01'), // a call, not a send
    execute(wallet, 1n, '0x'),
    execute(transfer.target, 0n, withdrawalCall('USDC', DEST, 0n).data),
    '0x12345678' as Hex,
  ])
    assert.equal(decodeOwnerCall(callData, wallet), null, callData);

  const op: UserOperation<'0.6'> = {
    sender: wallet,
    nonce: (OWNER_NONCE_KEY << 64n) | 2n,
    initCode: '0x',
    callData: execute(DEST, 3n, '0x'),
    callGasLimit: 1n,
    verificationGasLimit: 2n,
    preVerificationGas: 3n,
    maxFeePerGas: 4n,
    maxPriorityFeePerGas: 4n,
    paymasterAndData: PAYMASTER.toLowerCase() as Hex,
    signature: '0x',
  };
  assert.deepEqual(userOperationFromRpc(userOperationToRpc(op)), op);
  assert.throws(() => userOperationFromRpc({ ...userOperationToRpc(op), extra: '0x' }));
  assert.throws(() => userOperationFromRpc({ ...userOperationToRpc(op), nonce: '0x01' }));
  assert.throws(() => userOperationFromRpc({ ...userOperationToRpc(op), nonce: 2 }));

  const signer = privateKeyToAccount(generatePrivateKey());
  const signature = await signer.sign({ hash: ownerOperationHash(op) });
  const parity = `${signature.slice(0, 130)}${signature.endsWith('1b') ? '00' : '01'}` as Hex;
  assert.equal(ownerOperationSignature(parity, 0), ownerOperationSignature(signature, 0));
  const [wrapped] = decodeAbiParameters(wrapperAbi, ownerOperationSignature(parity, 0));
  assert.equal(wrapped.signatureData, signature);
  assert.throws(() => ownerOperationSignature('0x1234', 0));
});

test('sponsors: the pinned mainnet paymaster with no token, exact layout; Sepolia and anything else fail closed', () => {
  const pinned = SPONSOR_PAYMASTERS[BASE_MAINNET][0];
  assert.equal(pinned, '0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c');
  // Operation Paymaster: our own instance, the same contract, is the only other one pinned.
  assert.deepEqual(SPONSOR_PAYMASTERS[BASE_MAINNET], [
    '0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c',
    '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105',
  ]);
  assert.equal(
    sponsoredWithoutCharge(
      BASE_MAINNET,
      `0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105${sponsorData('pinned', 7).slice(42)}`,
    ),
    true,
  );
  assert.equal(SPONSOR_PAYMASTERS[BASE_SEPOLIA], undefined, 'nothing pinned on Sepolia');
  const onMainnet = (data: Hex) => `${pinned}${data.slice(42)}`;
  const covered = onMainnet(sponsorData('pinned', 7));
  assert.equal((covered.length - 2) / 2, SPONSOR_DATA_BYTES);
  assert.equal(sponsoredWithoutCharge(BASE_MAINNET, covered), true);
  assert.equal(sponsoredWithoutCharge(BASE_MAINNET, covered.toLowerCase()), true);
  // The same data on Sepolia (nothing pinned) or another chain: no.
  assert.equal(sponsoredWithoutCharge(BASE_SEPOLIA, covered), false);
  assert.equal(sponsoredWithoutCharge(1, covered), false);
  // A token to charge the wallet in, another paymaster, a wrong length, none: no.
  for (const data of [
    onMainnet(sponsorData('token', 7)),
    sponsorData('pinned', 7),
    onMainnet(sponsorData('short', 7)),
    `${covered}00`,
    pinned,
    '0x',
    'not hex',
    undefined,
  ])
    assert.equal(sponsoredWithoutCharge(BASE_MAINNET, data), false, String(data));
  // Tests pass their own list; it replaces the pinned one.
  const synthetic = { [BASE_SEPOLIA]: [PAYMASTER] };
  assert.equal(sponsoredWithoutCharge(BASE_SEPOLIA, sponsorData('pinned', 7), synthetic), true);
  assert.equal(sponsoredWithoutCharge(BASE_MAINNET, covered, synthetic), false);
});

test('the port with the production allowlist: the pinned paymaster charging nothing sponsors on Base; nothing on Base Sepolia', async (t) => {
  const f = await setup(t);
  const pinned = SPONSOR_PAYMASTERS[BASE_MAINNET][0];
  const wallet = f.wallets[AGENT];
  const calls = [withdrawalCall('USDC', DEST, 5n)];
  // The paymaster answers as the pinned one does: its address, the exact layout, no token.
  f.chain.state.paymaster = pinned;
  const portOn = (chainId: typeof BASE_MAINNET | typeof BASE_SEPOLIA) =>
    createOwnerOperationsPort({
      network: BASE_NETWORKS[chainId],
      client: f.chain.client,
      store: pgChainOperationStore(f.db, () => f.clock.now),
      bundler: rpcBundler({
        url: 'https://bundler.test/rpc/test-key-0001',
        entryPoint: BASE_NETWORKS[chainId].contracts.entryPointV06,
        chainId,
        client: f.chain.client,
        maxFeePerGasCap: 10n ** 12n,
        stubSignature: walletSignature(`0x${'ff'.repeat(64)}1c`, { ownerIndex: 0 }),
        fetch: f.chain.fetch,
      }),
      maxCostWeiCap: 10n ** 18n,
      // No `sponsors`: shared/base/paymasters.ts as production uses it.
    });
  // The factory and EntryPoint are the same on both networks, so is the wallet's recipe.
  const recipeOn = (chainId: typeof BASE_MAINNET | typeof BASE_SEPOLIA) =>
    agentWalletRecipe(BASE_NETWORKS[chainId], f.owner.address, accountIndexFor(AGENT));

  const onBase = await portOn(BASE_MAINNET).prepare({
    wallet,
    recipe: recipeOn(BASE_MAINNET),
    calls,
  });
  assert.equal(onBase.sponsored, true);
  assert.equal(getAddress((onBase.operation.paymasterAndData ?? '0x').slice(0, 42)), pinned);
  // Set to charge the wallet a token: no sponsorship, nothing prepared.
  f.chain.state.paymasterAnswer = 'token';
  await assert.rejects(
    portOn(BASE_MAINNET).prepare({ wallet, recipe: recipeOn(BASE_MAINNET), calls }),
    (e: unknown) => e instanceof OwnerOperationError && e.code === 'SPONSORSHIP_UNAVAILABLE',
  );
  // Nothing is pinned on Base Sepolia: the same answer fails closed there.
  f.chain.state.paymasterAnswer = 'pinned';
  await assert.rejects(
    portOn(BASE_SEPOLIA).prepare({ wallet, recipe: recipeOn(BASE_SEPOLIA), calls }),
    (e: unknown) => e instanceof OwnerOperationError && e.code === 'SPONSORSHIP_UNAVAILABLE',
  );
  assert.equal(f.chain.state.sends.length, 0, 'prepare never sends');
});

test('the owner-funded path is reachable from withdrawals only (no other caller, no other setting reader)', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  async function files(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await files(path)));
      else if (/\.tsx?$/.test(entry.name)) out.push(path.replace(/\\/g, '/'));
    }
    return out;
  }
  const rules: Array<[RegExp, string[]]> = [
    // Asking the port for an owner-funded operation.
    [/\bownerFunded\b/, ['server/base/chain/owner-ops.ts', 'server/base/wallet/withdrawals.ts']],
    // The setting, and the switch that reads it.
    [
      /CITY_BASE_WALLET_UNSPONSORED_FALLBACK|unsponsoredFallbackEnabled|UNSPONSORED_FALLBACK_SETTING/,
      ['server/base/wallet/withdrawals.ts', 'server/base/wallet/routes.ts'],
    ],
    // An unsponsored prepare below the port (prepareOperation / the bundler).
    [/\bsponsor\s*:\s*false\b/, []],
  ];
  for (const root of ['server', 'shared', 'api', 'src'])
    for (const file of await files(root).catch(() => [] as string[])) {
      const text = await readFile(file, 'utf8');
      for (const [pattern, allowed] of rules)
        if (pattern.test(text))
          assert.ok(allowed.includes(file), `${file} must not use ${pattern}`);
    }
});

test('contract: the browser (src/base/wallet/withdraw.ts) checks what the service prepares, shows its intent and binds the cancel', async (t) => {
  const { checkOperation, checkedIntent, WithdrawalCheckError } =
    await import('../src/base/wallet/withdraw.js');
  const f = await setup(t);
  const wallet = f.wallets[AGENT];
  const body = await created(f, 1);
  const input = {
    userOperation: body.userOperation,
    userOpHash: body.userOpHash,
    entryPoint: body.entryPoint,
    chainId: body.chainId,
    wallet,
    owner: f.owner.address,
    agentId: AGENT,
    sponsors: SPONSORS,
  };
  const asked = { kind: 'withdraw' as const, token: 'USDC' as const, amount: '1500000', to: DEST };
  // The exact withdrawal (also as 'max'), and the review shows the operation's own values.
  const hash = checkOperation({ ...input, expected: asked });
  assert.equal(hash, body.userOpHash);
  assert.equal(checkOperation({ ...input, expected: { ...asked, amount: 'max' } }), hash);
  const intent = checkedIntent(body as never, wallet);
  assert.equal(intent.to, DEST);
  assert.equal(intent.amount, 1_500_000n);
  assert.equal(intent.token, 'USDC');
  // Anything else than what was asked, or another wallet: nothing is signed.
  for (const expected of [
    { ...asked, amount: '1500001' },
    { ...asked, token: 'ETH' as const },
    { ...asked, to: getAddress(`0x${'6f'.repeat(20)}`) },
  ])
    assert.throws(() => checkOperation({ ...input, expected }), WithdrawalCheckError);
  assert.throws(
    () => checkOperation({ ...input, wallet: getAddress(`0x${'6f'.repeat(20)}`), expected: asked }),
    WithdrawalCheckError,
  );
  // Signed as the browser does (raw hash, owner key), accepted by the service.
  const signed = await post(f, `${body.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, hash),
  });
  assert.equal(signed.statusCode, 202, signed.body);
  // The cancel the service prepares is the wallet's own no-op at the withdrawal's nonce.
  const askedCancel = await post(f, `${body.withdrawalId}/cancel`, {});
  assert.equal(askedCancel.statusCode, 200, askedCancel.body);
  const view = askedCancel.json();
  const cancelHash = checkOperation({
    userOperation: view.cancel.userOperation,
    userOpHash: view.cancel.userOpHash,
    entryPoint: view.cancel.entryPoint,
    chainId: view.chainId,
    wallet,
    owner: f.owner.address,
    agentId: AGENT,
    sponsors: SPONSORS,
    expected: {
      kind: 'noop',
      original: { userOperation: body.userOperation, userOpHash: body.userOpHash },
    },
  });
  assert.equal(cancelHash, view.cancel.userOpHash);
  const signedCancel = await post(f, `${body.withdrawalId}/cancel/signature`, {
    signature: await rawSign(f.owner, cancelHash),
  });
  assert.equal(signedCancel.statusCode, 202, signedCancel.body);
});

// --- pay without waiting: each operation in its own nonce lane (CITY_BASE_LANES=1) -------------

const LANES_ON = { CITY_BASE_WALLET: '1', CITY_BASE_LANES: '1' };

/** Lanes on, the wallet already deployed (so no operation deploys it) unless said otherwise. */
async function lanesSetup(
  t: { after: (fn: () => Promise<unknown>) => void },
  env: Record<string, string | undefined> = {},
  deployed = true,
) {
  const settings: Record<string, string | undefined> = { ...LANES_ON, ...env };
  const f = await setup(t, { env: settings });
  if (deployed) f.chain.state.code.add(f.wallets[AGENT].toLowerCase());
  return { ...f, settings };
}

/** A barrier for `count` callers: each waits until all have arrived. */
function barrier(count: number) {
  let arrived = 0;
  let open = () => {};
  const all = new Promise<void>((resolve) => (open = resolve));
  return async () => {
    arrived += 1;
    if (arrived >= count) open();
    await all;
  };
}

const openList = (f: Fixture, person = 'person-1', agent = AGENT, query = '?open=1') =>
  f.app.inject({ url: `${url(agent)}${query}`, headers: as(person) });

async function heldRows(f: Fixture) {
  return (await reservations(f)).filter((row) => row.state === 'held');
}

async function signIt(f: Fixture, body: { withdrawalId: string; userOpHash: Hex }) {
  const res = await post(f, `${body.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, body.userOpHash),
  });
  assert.equal(res.statusCode, 202, res.body);
  return res.json();
}

test('lanes: past its sponsorship an unsigned operation expires and is freed; a signed one keeps its holds', async (t) => {
  const f = await lanesSetup(t);
  f.chain.state.sponsorValidUntil = () => Math.floor((f.clock.now + 60_000) / 1000);
  const unsigned = await created(f, 1, { amount: '1000000' });
  // Signable only while sponsored: expires_at is the paymaster's validUntil, not the 10 minutes.
  assert.equal(unsigned.expiresAt, Math.floor((f.clock.now + 60_000) / 1000) * 1000);
  const signed = await created(f, 2, { amount: '1000000' });
  await signIt(f, signed);
  const asked = (await post(f, `${signed.withdrawalId}/cancel`, {})).json();
  assert.ok(asked.cancel?.userOpHash);
  assert.ok(asked.cancel.expiresAt <= f.clock.now + 60_000);
  f.clock.now += 61_000;
  const refused = await post(f, `${unsigned.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, unsigned.userOpHash),
  });
  assert.equal(refused.statusCode, 410, refused.body);
  assert.equal(refused.json().code, 'expired', refused.body);
  const cancelRefused = await post(f, `${signed.withdrawalId}/cancel/signature`, {
    signature: await rawSign(f.owner, asked.cancel.userOpHash),
  });
  assert.equal(cancelRefused.statusCode, 410, cancelRefused.body);
  assert.equal(cancelRefused.json().code, 'expired', cancelRefused.body);
  // The unsigned one freed its hold; the signed one keeps its own, past its validUntil too.
  assert.equal((await heldRows(f)).length, 1);
  assert.equal((await read(f, unsigned.withdrawalId)).json().state, 'expired');
  assert.equal((await read(f, signed.withdrawalId)).json().state, 'submitted');
  assert.ok((await heldExposure(f)) > 0n, 'the signed one still holds the sponsor exposure');
  assert.equal((await read(f, signed.withdrawalId)).json().state, 'submitted');
  const stored = await f.pg.query<{ owner_signature: unknown; cancel_signature: unknown }>(
    'SELECT owner_signature, cancel_signature FROM base_wallet_withdrawals WHERE withdrawal_id = $1',
    [signed.withdrawalId],
  );
  assert.ok(stored.rows[0].owner_signature);
  assert.equal(stored.rows[0].cancel_signature, null);
});

test('lanes: an unsigned operation past its sponsorship frees its open slot and exposure at once', async (t) => {
  const f = await lanesSetup(t, { CITY_BASE_LANES_CAP: '1' });
  f.chain.state.sponsorValidUntil = () => Math.floor((f.clock.now + 90_000) / 1000);
  const first = await created(f, 1, { amount: '1000000' });
  assert.equal(first.expiresAt, Math.floor((f.clock.now + 90_000) / 1000) * 1000);
  assert.ok(first.expiresAt < f.clock.now + WITHDRAWAL_SIGNATURE_TTL_MS);
  const held = await heldExposure(f);
  assert.ok(held > 0n);
  const full = await create(f, usdc(2, { amount: '1000000' }));
  assert.equal(full.statusCode, 409, full.body);
  assert.equal(full.json().code, 'too_many_open');
  // At its validUntil (not 10 minutes later) the slot and the exposure are free again.
  f.clock.now = first.expiresAt;
  const next = await create(f, usdc(3, { amount: '1000000' }));
  assert.equal(next.statusCode, 201, next.body);
  assert.equal((await read(f, first.withdrawalId)).json().state, 'expired');
  assert.equal(await heldExposure(f), held, 'only the new one is held');
});

test('lanes: the sign-time check passes until the send margin before validUntil and fails from it', async (t) => {
  const f = await lanesSetup(t);
  f.chain.state.sponsorValidUntil = () => Math.floor((f.clock.now + 60_000) / 1000);
  const body = await created(f, 1, { amount: '1000000' });
  // The stored deadline is validUntil itself: validUntil <= deadline holds (equal allowed).
  const data = body.userOperation.paymasterAndData;
  assert.equal(f.port.sponsorshipValid!(data, body.expiresAt), true);
  f.clock.now = body.expiresAt - 1;
  assert.equal(f.port.sponsorshipValid!(data, body.expiresAt), true);
  f.clock.now = body.expiresAt;
  assert.equal(f.port.sponsorshipValid!(data, body.expiresAt), false);
  // A bundler refuses an operation whose sponsorship ends within seconds: never taken that close.
  f.clock.now = body.expiresAt - SPONSOR_SEND_MARGIN_MS;
  const late = await post(f, `${body.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, body.userOpHash),
  });
  assert.equal(late.statusCode, 409, late.body);
  assert.equal(late.json().code, 'sponsorship_expired');
  f.clock.now = body.expiresAt - SPONSOR_SEND_MARGIN_MS - 1;
  await signIt(f, body);
});

test('lanes off: expires_at stays the fixed 10 minutes, whatever the paymaster signs', async (t) => {
  const f = await setup(t);
  f.chain.state.sponsorValidUntil = () => Math.floor((f.clock.now + 60_000) / 1000);
  const body = await created(f, 1, { amount: '1000000' });
  assert.equal(body.expiresAt, f.clock.now + WITHDRAWAL_SIGNATURE_TTL_MS);
});

test('lanes off: a signature after the sponsorship ended is refused and nothing is stored or sent', async (t) => {
  const f = await setup(t);
  f.chain.state.sponsorValidUntil = () => Math.floor((f.clock.now + 60_000) / 1000);
  const body = await created(f, 1, { amount: '1000000' });
  // Still inside the 10-minute signing deadline, but past the paymaster's validUntil.
  f.clock.now += 61_000;
  const refused = await post(f, `${body.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, body.userOpHash),
  });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, 'sponsorship_expired');
  const stored = await f.pg.query<{ state: string; signed: boolean }>(
    'SELECT state, owner_signature IS NOT NULL AS signed FROM base_wallet_withdrawals',
  );
  assert.deepEqual(stored.rows, [{ state: 'awaiting_signature', signed: false }]);
  assert.equal(f.chain.state.sends.length, 0);
  assert.equal((await f.pg.query('SELECT 1 FROM base_chain_ops')).rows.length, 0);
});

test('lanes: sponsorship expiring after the initial check is refused before signature acceptance', async (t) => {
  const f = await lanesSetup(t);
  f.chain.state.sponsorValidUntil = () => Math.floor((f.clock.now + 60_000) / 1000);
  const body = await created(f, 1, { amount: '1000000' });
  const valid = f.port.sponsorshipValid!.bind(f.port);
  let checks = 0;
  f.port.sponsorshipValid = (data, deadline) => {
    const result = valid(data, deadline);
    if (++checks === 1) f.clock.now += 61_000;
    return result;
  };
  const refused = await post(f, `${body.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, body.userOpHash),
  });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, 'sponsorship_expired', refused.body);
  assert.equal(checks, 2);
  const stored = await f.pg.query<{ owner_signature: unknown }>(
    'SELECT owner_signature FROM base_wallet_withdrawals WHERE withdrawal_id = $1',
    [body.withdrawalId],
  );
  assert.equal(stored.rows[0].owner_signature, null);
});

test('lanes: legacy unsigned sponsorship without a bounded validity window cannot be signed', async (t) => {
  const f = await lanesSetup(t);
  const body = await created(f, 1, { amount: '1000000' });
  const operation = { ...body.userOperation, paymasterAndData: sponsorData('pinned', 1) };
  const hash = ownerOperationHash(userOperationFromRpc(operation));
  await f.pg.query(
    'UPDATE base_wallet_withdrawals SET user_operation = $2, user_op_hash = $3 WHERE withdrawal_id = $1',
    [body.withdrawalId, JSON.stringify(operation), hash],
  );
  const refused = await post(f, `${body.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, hash),
  });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, 'sponsorship_expired', refused.body);
  const stored = await f.pg.query<{ owner_signature: unknown }>(
    'SELECT owner_signature FROM base_wallet_withdrawals WHERE withdrawal_id = $1',
    [body.withdrawalId],
  );
  assert.equal(stored.rows[0].owner_signature, null);
});

test('lanes: settings are off unless exactly 1; the cap is 1 to 1000, default 100', () => {
  assert.equal(lanesEnabled({}), false);
  assert.equal(lanesEnabled({ CITY_BASE_LANES: 'true' }), false);
  assert.equal(lanesEnabled({ CITY_BASE_LANES: '1' }), true);
  assert.equal(lanesCap({}), 100);
  assert.equal(lanesCap({ CITY_BASE_LANES_CAP: '7' }), 7);
  for (const bad of ['0', '-1', '1001', '1e2', 'x', ''])
    assert.equal(lanesCap({ CITY_BASE_LANES_CAP: bad }), 100, bad);
  assert.equal(lanesRevertBudget({}), 3);
  assert.equal(lanesRevertBudget({ CITY_BASE_LANES_REVERT_BUDGET: '5' }), 5);
  assert.equal(lanesRevertBudget({ CITY_BASE_LANES_REVERT_BUDGET: '0' }), 3);
});

test('lanes off: no lane, no lanes flag, the owner lane and one operation at a time, as before', async (t) => {
  const f = await setup(t);
  const body = await created(f, 1);
  assert.equal('lanes' in body, false);
  assert.equal(BigInt(body.userOperation.nonce), OWNER_NONCE_KEY << 64n);
  const { rows } = await f.pg.query<{ lane_key: string | null }>(
    'SELECT lane_key::text AS lane_key FROM base_wallet_withdrawals',
  );
  assert.deepEqual(rows, [{ lane_key: null }]);
  assert.equal('lanes' in (await read(f, body.withdrawalId)).json(), false);
  assert.equal((await create(f, usdc(2))).json().code, 'operation_pending');
});

test('lanes: each operation in its own lane at laneNonce(id), several unsigned at once, landing in any order', async (t) => {
  const f = await lanesSetup(t);
  const bodies = [];
  for (const n of [1, 2, 3]) bodies.push(await created(f, n, { amount: '1000000' }));
  const keys = new Set<bigint>();
  for (const body of bodies) {
    const op = userOperationFromRpc(body.userOperation);
    assert.equal((body as { lanes?: boolean }).lanes, true);
    assert.equal(op.nonce, laneNonce(body.withdrawalId), 'the nonce the browser derives');
    assert.equal(op.nonce >> 64n, laneKey(body.withdrawalId));
    assert.ok(op.nonce >> 64n !== 0n && op.nonce >> 64n !== 8453n);
    assert.equal(ownerOperationHash(op), body.userOpHash);
    assert.equal(op.initCode, '0x');
    keys.add(op.nonce >> 64n);
  }
  assert.equal(keys.size, 3, 'three lanes');
  const { rows } = await f.pg.query<{ withdrawal_id: string; lane_key: string; nonce: string }>(
    'SELECT withdrawal_id, lane_key::text AS lane_key, nonce::text AS nonce FROM base_wallet_withdrawals',
  );
  for (const row of rows) {
    assert.equal(BigInt(row.lane_key), laneKey(row.withdrawal_id));
    assert.equal(BigInt(row.nonce), laneNonce(row.withdrawal_id));
  }
  assert.equal((await heldRows(f)).length, 3);
  // Signed in any order, each lands on its own; none waits for another.
  const [a, b, c] = bodies;
  for (const body of [c, a, b]) assert.equal((await signIt(f, body)).lanes, true);
  f.chain.include(b.userOpHash);
  f.chain.include(c.userOpHash);
  f.chain.include(a.userOpHash);
  f.chain.mine(3);
  for (const body of bodies) {
    const view = (await read(f, body.withdrawalId)).json();
    assert.equal(view.state, 'final');
    assert.equal(view.lanes, true);
  }
  assert.deepEqual(
    (await reservations(f)).map((row) => row.state),
    ['consumed', 'consumed', 'consumed'],
  );
});

test('lanes: two creates competing for the last balance at once, one wins, the other is 409 funds_held', async (t) => {
  const f = await lanesSetup(t);
  // Both pass every check made before the wallet's lock, then race for the last balance.
  f.chain.state.barrier = barrier(2);
  const [a, b] = await Promise.all([
    create(f, usdc(1, { amount: '3000000' })),
    create(f, usdc(2, { amount: '3000000' })),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [201, 409]);
  f.chain.state.barrier = null;
  const loser = (a.statusCode === 409 ? a : b).json();
  assert.equal(loser.code, 'funds_held');
  assert.equal(loser.open, 1);
  assert.deepEqual(loser.details, {
    open: 1,
    available: { raw: '2000000', decimals: 6, display: '2' },
  });
  assert.equal(loser.available.raw, '2000000');
  assert.equal((await heldRows(f)).length, 1);
  assert.equal(
    (await f.pg.query('SELECT 1 FROM base_wallet_withdrawals')).rows.length,
    1,
    'nothing stored for the loser',
  );
  // What is left still goes, without waiting.
  assert.equal((await create(f, usdc(3, { amount: '2000000' }))).statusCode, 201);
});

test('lanes: two creates for the last open slot at once, one wins, the other is 409 too_many_open; legacy operations count', async (t) => {
  const f = await lanesSetup(t, { CITY_BASE_LANES_CAP: '3' });
  // One from before lanes, on the owner lane, signed and on its way.
  f.settings.CITY_BASE_LANES = '0';
  const legacy = await created(f, 1, { amount: '100' });
  await signIt(f, legacy);
  f.settings.CITY_BASE_LANES = '1';
  await created(f, 2, { amount: '100' });
  f.chain.state.barrier = barrier(2);
  const [a, b] = await Promise.all([
    create(f, usdc(3, { amount: '100' })),
    create(f, usdc(4, { amount: '100' })),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [201, 409]);
  f.chain.state.barrier = null;
  const loser = (a.statusCode === 409 ? a : b).json();
  assert.equal(loser.code, 'too_many_open');
  assert.equal(loser.max, 3);
  assert.equal(loser.open, 3);
  assert.deepEqual(loser.details, { max: 3, open: 3 });
  // The legacy one lands and is final: brought up to date at the next create, a slot is free.
  f.chain.include(legacy.userOpHash);
  f.chain.mine(3);
  assert.equal((await create(f, usdc(5, { amount: '100' }))).statusCode, 201);
  assert.equal((await create(f, usdc(6, { amount: '100' }))).json().code, 'too_many_open');
});

test('lanes: an external balance decrease between creates is 409 funds_held with how many are on their way', async (t) => {
  const f = await lanesSetup(t);
  await created(f, 1, { amount: '2000000' });
  // The owner spends outside the app: 5 USDC becomes 3.
  f.chain.state.balances.set(f.wallets[AGENT].toLowerCase(), { usdc: 3_000_000n, eth: 10n ** 15n });
  const refused = (await create(f, usdc(2, { amount: '2000000' }))).json();
  assert.equal(refused.code, 'funds_held');
  assert.equal(refused.open, 1);
  assert.equal(refused.available.raw, '1000000');
  assert.match(refused.error, /1 payment is still on its way/);
  // More than the wallet holds at all: plainly not enough.
  assert.equal(
    (await create(f, usdc(3, { amount: '4000000' }))).json().code,
    'insufficient_balance',
  );
  assert.equal((await create(f, usdc(4, { amount: '1000000' }))).statusCode, 201);
  assert.equal((await heldRows(f)).length, 2);
});

test('lanes: duplicate retries get the same operation, lane and nonce, also at once', async (t) => {
  const f = await lanesSetup(t);
  const [a, b] = await Promise.all([create(f, usdc(1)), create(f, usdc(1))]);
  assert.equal(a.statusCode, 201, a.body);
  assert.equal(b.statusCode, 201, b.body);
  assert.equal(a.json().withdrawalId, b.json().withdrawalId);
  assert.equal(a.json().userOperation.nonce, b.json().userOperation.nonce);
  const again = (await create(f, usdc(1))).json();
  assert.equal(again.withdrawalId, a.json().withdrawalId);
  assert.equal(again.userOpHash, a.json().userOpHash);
  assert.equal(again.lanes, true);
  assert.equal((await f.pg.query('SELECT 1 FROM base_wallet_withdrawals')).rows.length, 1);
  assert.equal((await heldRows(f)).length, 1);
  assert.equal((await create(f, usdc(1, { amount: '7' }))).json().code, 'idempotency_conflict');
});

test('lanes: a lane already used, here or on Base, is refused and never reused; the database refuses 0, 8453 and a second use', async (t) => {
  const f = await lanesSetup(t);
  const ids = [key(901), key(902), key(903)];
  let next = 0;
  const service = createWithdrawalService({
    db: f.db,
    operations: async () => f.port,
    balances: f.balances,
    lanes: () => true,
    newId: () => ids[next],
    now: () => f.clock.now,
  });
  const walletId = `wallet-${AGENT.slice(0, 4)}`;
  const body = (n: number) => usdc(n, { amount: '1000' });
  const insert = (id: string, lane: bigint | null, nonce: bigint, state = 'expired') =>
    f.pg.query(
      `INSERT INTO base_wallet_withdrawals (withdrawal_id, wallet_id, owner_account_id, chain_id,
         token, amount_raw, destination, idempotency_key, request_hash, state, nonce,
         user_operation, user_op_hash, expires_at, created_at, updated_at, lane_key)
       VALUES ($1, $2, 'person-1', $3, 'USDC', 1, $4, $1, $5, $6, $7, '{}', $5, 1, 1, 1, $8)`,
      [
        id,
        walletId,
        WALLET_EXPECTED.chainId,
        DEST,
        `0x${'ab'.repeat(32)}`,
        state,
        nonce.toString(10),
        lane === null ? null : lane.toString(10),
      ],
    );
  // Another operation of this wallet already has the lane the new id derives.
  await insert(key(801), laneKey(ids[0]), laneNonce(ids[0]));
  await assert.rejects(service.create('person-1', AGENT, body(1)), { code: 'lane_collision' });
  // Base already saw that lane used (its nonce moved): refused before anything is held.
  next = 1;
  f.chain.state.lanes.set(`${f.wallets[AGENT].toLowerCase()}:${laneKey(ids[1])}`, [
    { block: f.chain.state.head, next: 1n },
  ]);
  await assert.rejects(service.create('person-1', AGENT, body(2)), { code: 'lane_collision' });
  assert.equal((await reservations(f)).length, 0, 'nothing held');
  assert.equal((await f.pg.query('SELECT 1 FROM base_wallet_withdrawals')).rows.length, 1);
  // A fresh lane goes.
  next = 2;
  const ok = await service.create('person-1', AGENT, body(3));
  assert.equal(BigInt(ok.userOperation.nonce), laneNonce(ids[2]));
  // The database itself: one operation per (chain, wallet, lane); never 0 or 8453; the nonce
  // always in the stored lane.
  await assert.rejects(insert(key(802), laneKey(ids[2]), laneNonce(ids[2])));
  await assert.rejects(insert(key(803), 0n, 0n));
  await assert.rejects(insert(key(804), 8453n, 8453n << 64n));
  await assert.rejects(insert(key(805), 2n ** 192n, 2n ** 256n - 1n));
  await assert.rejects(insert(key(806), laneKey(key(806)), laneNonce(key(807))));
  await insert(key(808), laneKey(key(808)), laneNonce(key(808)) | 5n);
  // Unlanded ones keep one unsigned per wallet; laned ones may wait unsigned side by side.
  await insert(key(809), laneKey(key(809)), laneNonce(key(809)), 'awaiting_signature');
  await insert(key(810), null, OWNER_NONCE_KEY << 64n, 'awaiting_signature');
  await assert.rejects(insert(key(811), null, OWNER_NONCE_KEY << 64n, 'awaiting_signature'));
});

test('lanes: the first deployment, one deploying operation at a time; the next waits until the wallet exists', async (t) => {
  const f = await lanesSetup(t, {}, false);
  f.chain.state.barrier = barrier(2);
  const [a, b] = await Promise.all([
    create(f, usdc(1, { amount: '1000' })),
    create(f, usdc(2, { amount: '1000' })),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [201, 409]);
  f.chain.state.barrier = null;
  const first = (a.statusCode === 201 ? a : b).json();
  const loser = (a.statusCode === 201 ? b : a).json();
  assert.equal(loser.code, 'operation_pending');
  assert.equal(loser.withdrawalId, first.withdrawalId);
  assert.equal(first.summary.deploysWallet, true);
  // Signed and on its way, it still holds the deployment.
  await signIt(f, first);
  assert.equal((await create(f, usdc(3, { amount: '1000' }))).json().code, 'operation_pending');
  f.chain.include(first.userOpHash);
  // The wallet exists: the next one has no initCode, in its own lane, and the first is untouched.
  const next = await created(f, 4, { amount: '1000' });
  assert.equal(next.userOperation.initCode, '0x');
  assert.equal(next.summary.deploysWallet, false);
  assert.equal(BigInt(next.userOperation.nonce), laneNonce(next.withdrawalId));
  const { rows } = await f.pg.query<{ user_op_hash: string }>(
    'SELECT user_op_hash FROM base_wallet_withdrawals WHERE withdrawal_id = $1',
    [first.withdrawalId],
  );
  assert.equal(rows[0].user_op_hash, first.userOpHash, 'a signed operation is never changed');
  await signIt(f, next);
  f.chain.include(next.userOpHash);
  assert.equal((await read(f, next.withdrawalId)).json().state, 'included');
});

test('lanes: a cancel is the no-op at exactly the original full nonce, in its lane; the other lanes go on', async (t) => {
  const f = await lanesSetup(t);
  const a = await created(f, 1, { amount: '1000000' });
  const b = await created(f, 2, { amount: '1000000' });
  await signIt(f, a);
  await signIt(f, b);
  const asked = (await post(f, `${a.withdrawalId}/cancel`, {})).json();
  assert.equal(asked.lanes, true);
  const noop = userOperationFromRpc(asked.cancel.userOperation);
  assert.equal(noop.nonce, BigInt(a.userOperation.nonce), 'the same full nonce');
  assert.equal(noop.nonce >> 64n, laneKey(a.withdrawalId), 'the original’s lane');
  assert.deepEqual(decodeOwnerCall(noop.callData, f.wallets[AGENT]), { kind: 'noop' });
  const signed = await post(f, `${a.withdrawalId}/cancel/signature`, {
    signature: await rawSign(f.owner, asked.cancel.userOpHash),
  });
  assert.equal(signed.statusCode, 202, signed.body);
  f.chain.include(asked.cancel.userOpHash);
  f.chain.include(b.userOpHash);
  // The original can never land now (its nonce is used); the other lane is unaffected.
  assert.ok(![...f.chain.state.pool.keys()].includes(a.userOpHash));
  f.chain.mine(3);
  assert.equal((await read(f, a.withdrawalId)).json().state, 'cancelled');
  assert.equal((await read(f, b.withdrawalId)).json().state, 'final');
  assert.deepEqual(
    (await reservations(f)).map((row) => row.state),
    ['released', 'consumed'],
  );
});

test('lanes: Base drops the block of one lane while another goes on; only that one goes back, its hold kept', async (t) => {
  const f = await lanesSetup(t);
  f.chain.state.safeDepth = 1n;
  const a = await created(f, 1, { amount: '1000000' });
  const b = await created(f, 2, { amount: '1000000' });
  await signIt(f, a);
  await signIt(f, b);
  f.chain.include(a.userOpHash);
  f.chain.include(b.userOpHash);
  f.chain.mine(1);
  assert.equal((await read(f, a.withdrawalId)).json().safe, true);
  assert.equal((await read(f, b.withdrawalId)).json().safe, true);
  f.chain.uninclude(a.userOpHash);
  const back = (await read(f, a.withdrawalId)).json();
  assert.equal(back.state, 'submitted');
  assert.equal(back.safe, false);
  const other = (await read(f, b.withdrawalId)).json();
  assert.equal(other.state, 'included');
  assert.equal(other.safe, true);
  assert.equal((await heldRows(f)).length, 2);
  // Others still start meanwhile.
  assert.equal((await create(f, usdc(3, { amount: '1000' }))).statusCode, 201);
  f.chain.mine(3);
  assert.equal((await read(f, b.withdrawalId)).json().state, 'final');
  assert.equal((await read(f, a.withdrawalId)).json().state, 'submitted');
  f.chain.include(a.userOpHash);
  f.chain.mine(3);
  assert.equal((await read(f, a.withdrawalId)).json().state, 'final');
});

test('lanes: turned off again, laned operations still sign, reconcile and settle; new ones wait until none is unfinished', async (t) => {
  const f = await lanesSetup(t);
  const a = await created(f, 1, { amount: '1000000' });
  const b = await created(f, 2, { amount: '1000000' });
  await signIt(f, a);
  f.settings.CITY_BASE_LANES = '0';
  const waiting = (await create(f, usdc(3))).json();
  assert.equal(waiting.code, 'operation_pending');
  // The unsigned laned one can still be signed and goes out in its own lane.
  const signedB = await signIt(f, b);
  assert.equal(signedB.lanes, true);
  f.chain.include(a.userOpHash);
  f.chain.include(b.userOpHash);
  f.chain.state.safeDepth = 1n;
  f.chain.mine(1);
  // Settled at the safe head is not enough for a laned one with lanes off: wait until final.
  assert.equal((await read(f, a.withdrawalId)).json().safe, true);
  assert.equal((await create(f, usdc(4))).json().code, 'operation_pending');
  f.chain.mine(3);
  assert.equal((await read(f, a.withdrawalId)).json().state, 'final');
  assert.equal((await read(f, b.withdrawalId)).json().state, 'final');
  const sequential = await created(f, 5);
  assert.equal('lanes' in sequential, false);
  assert.equal(BigInt(sequential.userOperation.nonce), OWNER_NONCE_KEY << 64n);
  assert.equal((await create(f, usdc(6))).json().code, 'operation_pending');
});

test('lanes: after a restart a fresh service reconciles the open laned operations', async (t) => {
  const f = await lanesSetup(t);
  const a = await created(f, 1, { amount: '1000000' });
  f.clock.now += 1_000;
  const b = await created(f, 2, { amount: '1000000' });
  // Signed while the bundler can't be reached: stored, not sent (a crash or an outage).
  f.chain.state.bundlerDown = true;
  await signIt(f, a);
  await signIt(f, b);
  assert.equal(f.chain.state.sends.length, 0);
  f.chain.state.bundlerDown = false;
  const fresh = createWithdrawalService({
    db: f.db,
    operations: async () => f.port,
    balances: f.balances,
    lanes: () => true,
    now: () => f.clock.now,
  });
  const listed = await fresh.open('person-1', AGENT);
  assert.deepEqual(
    listed.withdrawals.map((view) => view.withdrawalId),
    [b.withdrawalId, a.withdrawalId],
  );
  // Both were sent exactly as signed, each in its own lane.
  assert.deepEqual(
    f.chain.state.sends.map((send) => send.hash).sort(),
    [a.userOpHash, b.userOpHash].sort(),
  );
  f.chain.include(b.userOpHash);
  f.chain.include(a.userOpHash);
  f.chain.mine(3);
  assert.deepEqual((await fresh.open('person-1', AGENT)).withdrawals, []);
  assert.equal((await fresh.read('person-1', AGENT, a.withdrawalId)).state, 'final');
  assert.deepEqual(
    (await reservations(f)).map((row) => row.state),
    ['consumed', 'consumed'],
  );
});

test('lanes: GET ?open=1 lists the unfinished ones newest first, as GET :id reads them; only the owner', async (t) => {
  const f = await lanesSetup(t);
  f.chain.state.safeDepth = 1n;
  const done = await created(f, 1, { amount: '1000' });
  f.clock.now += 1_000;
  const unsigned = await created(f, 2, { amount: '1000' });
  f.clock.now += 1_000;
  const discarded = await created(f, 3, { amount: '1000' });
  f.clock.now += 1_000;
  const landed = await created(f, 4, { amount: '1000' });
  await signIt(f, done);
  await signIt(f, landed);
  assert.equal((await post(f, `${discarded.withdrawalId}/cancel`, {})).json().state, 'expired');
  f.chain.include(done.userOpHash);
  f.chain.mine(3);
  f.chain.include(landed.userOpHash);
  f.chain.mine(1);
  const res = await openList(f);
  assert.equal(res.statusCode, 200, res.body);
  const list = res.json().withdrawals as Array<Record<string, unknown>>;
  assert.deepEqual(
    list.map((view) => view.withdrawalId),
    [landed.withdrawalId, unsigned.withdrawalId],
  );
  const one = (await read(f, landed.withdrawalId)).json();
  assert.deepEqual(list[0], { ...one, userOperation: landed.userOperation });
  assert.equal(list[0].safe, true);
  assert.equal(list[0].lanes, true);
  assert.equal(list[1].state, 'awaiting_signature');
  assert.deepEqual(list[1].userOperation, unsigned.userOperation);
  // Only the wallet owner; another agent's list never shows this wallet's operations.
  assert.equal((await openList(f, 'person-2')).statusCode, 404);
  assert.equal((await openList(f, 'ai-1')).statusCode, 404);
  const coOwner = await f.app.inject({
    url: `${url(AI_AGENT)}?open=1`,
    headers: as('person-2', 'ai-1'),
  });
  assert.equal(coOwner.statusCode, 404);
  const anonymous = await f.app.inject({ url: `${url()}?open=1`, headers: json });
  assert.equal(anonymous.statusCode, 401);
  const otherAgent = await openList(f, 'person-1', AI_AGENT);
  assert.equal(otherAgent.statusCode, 200);
  assert.deepEqual(otherAgent.json().withdrawals, []);
  // No other listing.
  assert.equal((await openList(f, 'person-1', AGENT, '')).statusCode, 404);
  assert.equal((await openList(f, 'person-1', AGENT, '?open=true')).statusCode, 404);
});

test('lanes: drained outside the app between create and sign, the operation is refused (409 funds_moved), nothing sent, its hold kept', async (t) => {
  const f = await lanesSetup(t);
  const a = await created(f, 1, { amount: '2000000' });
  f.clock.now += 1_000;
  const b = await created(f, 2, { amount: '2000000' });
  // The owner moves 2 USDC out of the wallet elsewhere: 3 left, 4 held.
  f.chain.state.balances.set(f.wallets[AGENT].toLowerCase(), { usdc: 3_000_000n, eth: 10n ** 15n });
  const refused = await post(f, `${a.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, a.userOpHash),
  });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, 'funds_moved');
  assert.equal(refused.json().available.raw, '1000000');
  assert.equal(f.chain.state.sends.length, 0, 'nothing broadcast');
  assert.equal((await read(f, a.withdrawalId)).json().state, 'awaiting_signature');
  assert.equal((await heldRows(f)).length, 2, 'its hold stays');
  // The other one is discarded: what is left covers the first again.
  assert.equal((await post(f, `${b.withdrawalId}/cancel`, {})).json().state, 'expired');
  await signIt(f, a);
  assert.equal(f.chain.state.sends.length, 1);
});

test('lanes: sponsored reverts keep the time Base first showed them; the owner’s own withdrawals never pause', async (t) => {
  const f = await lanesSetup(t);
  const bodies = [];
  for (const n of [1, 2, 3]) {
    const body = await created(f, n, { amount: '1000' });
    await signIt(f, body);
    f.chain.include(body.userOpHash, false);
    bodies.push(body);
  }
  const first = f.clock.now;
  for (const body of bodies)
    assert.equal((await read(f, body.withdrawalId)).json().errorCode, 'reverted');
  // Failed for good an hour later: the revert time stays the first one.
  f.clock.now += 60 * 60_000;
  f.chain.mine(3);
  for (const body of bodies)
    assert.equal((await read(f, body.withdrawalId)).json().state, 'failed');
  const { rows } = await f.pg.query<{ reverted_at: string }>(
    'SELECT reverted_at::text AS reverted_at FROM base_wallet_withdrawals',
  );
  assert.deepEqual(
    rows.map((row) => Number(row.reverted_at)),
    [first, first, first],
  );
  // Three sponsored reverts: a plain withdrawal by the owner still goes (payments pause, Pay tests).
  assert.equal((await create(f, usdc(4, { amount: '1000' }))).statusCode, 201);
});

test('an operation settled at the safe head whose debit the balance read already shows is not counted twice (lanes off)', async (t) => {
  const f = await setup(t);
  f.chain.state.safeDepth = 1n;
  f.chain.state.debit = true;
  const first = await signedWithdrawal(f, 1);
  f.chain.include(first.userOpHash);
  // In a block but not proven at the safe head yet: its hold still counts.
  assert.equal((await create(f, usdc(2, { amount: '3000000' }))).json().code, 'operation_pending');
  f.chain.mine(1);
  // Base shows 3.5 USDC now; the 1.5 is still held until final but no longer subtracted again.
  const next = await created(f, 3, { amount: 'max' });
  assert.equal((next.summary.amount as { raw: string }).raw, '3500000');
  assert.equal((await heldRows(f)).length, 2, 'the first one’s hold stays until final');
});

test('lanes: signing is checked against what Base shows, without counting a settled debit twice', async (t) => {
  const f = await lanesSetup(t);
  f.chain.state.safeDepth = 1n;
  f.chain.state.debit = true;
  const a = await created(f, 1, { amount: '1500000' });
  f.clock.now += 1_000;
  const b = await created(f, 2, { amount: '3000000' });
  await signIt(f, a);
  f.chain.include(a.userOpHash);
  // A is in a block but not proven at the safe head: its hold and the debit both count.
  const early = await post(f, `${b.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, b.userOpHash),
  });
  assert.equal(early.json().code, 'funds_moved');
  assert.deepEqual(early.json().details, {
    token: 'USDC',
    available: { raw: '2000000', decimals: 6, display: '2' },
    needed: { raw: '3000000', decimals: 6, display: '3' },
  });
  // Settled at the safe head for its own receipt: Base's 3.5 covers B's 3.
  f.chain.mine(1);
  const signed = await signIt(f, b);
  assert.equal(signed.state, 'submitted');
});

test('the safe-head proof is one chain view: a safe tag of another branch is no proof, and a hung node answers null in time', async (t) => {
  const f = await setup(t, { proofTimeoutMs: 50 });
  f.chain.state.safeDepth = 1n;
  const first = await signedWithdrawal(f, 1);
  f.chain.include(first.userOpHash);
  f.chain.mine(1);
  f.chain.state.safeOrphan = true;
  assert.equal((await read(f, first.withdrawalId)).json().safe, false);
  assert.equal((await create(f, usdc(2))).json().code, 'operation_pending');
  const landed = f.chain.state.landed.get(first.userOpHash)!;
  const proof = {
    sender: f.wallets[AGENT],
    nonce: BigInt(first.userOperation.nonce),
    userOpHash: first.userOpHash,
    txHash: landed.txHash,
    blockNumber: landed.blockNumber,
    success: true,
  };
  assert.equal(await f.port.settledAtSafe!(proof), null);
  f.chain.state.safeOrphan = false;
  assert.equal(await f.port.settledAtSafe!(proof), true);
  f.chain.state.callHang = true;
  const started = Date.now();
  assert.equal(await f.port.settledAtSafe!(proof), null);
  assert.ok(Date.now() - started < 2_000, 'answers within its timeout');
  f.chain.state.callHang = false;
});

test('the safe-head proof reads the safe head live: a shared head higher than the chain now (rolled back) never releases a hold', async (t) => {
  // The shared (cached) view still says the head itself is safe; the chain now says it is not.
  const stale = (client: PublicClient) =>
    ({
      ...client,
      getBlock: async (args: { blockNumber?: bigint; blockTag?: string } = {}) =>
        args.blockTag === 'safe'
          ? client.getBlock({ blockTag: 'latest' })
          : client.getBlock(args as never),
    }) as PublicClient;
  const run = async (portClient: (client: PublicClient) => PublicClient) => {
    const f = await setup(t, { portClient });
    f.chain.state.safeDepth = 5n;
    const first = await signedWithdrawal(f, 1);
    f.chain.include(first.userOpHash);
    f.chain.mine(1);
    const landed = f.chain.state.landed.get(first.userOpHash)!;
    const proof = {
      sender: f.wallets[AGENT],
      nonce: BigInt(first.userOperation.nonce),
      userOpHash: first.userOpHash,
      txHash: landed.txHash,
      blockNumber: landed.blockNumber,
      success: true,
    };
    const answer = await f.port.settledAtSafe!(proof);
    return { answer, next: (await create(f, usdc(2))).json().code };
  };
  // The runtime's client: the shared view with its live twin. The proof reads the twin: not safe.
  const live = await run((client) => withLiveReads(stale(client), client));
  assert.equal(live.answer, false);
  assert.equal(live.next, 'operation_pending', 'the hold stays');
  // Read through the shared view, the same proof would have released it: why it reads live.
  assert.equal((await run(stale)).answer, true);
});

test('lanes off: a sent operation that is final by now is brought up to date before the next is admitted', async (t) => {
  const f = await setup(t);
  const first = await signedWithdrawal(f, 1);
  f.chain.include(first.userOpHash);
  f.chain.mine(3);
  // Nobody read it since it was sent: the next create brings it up to date first.
  assert.equal((await create(f, usdc(2))).statusCode, 201);
  assert.equal((await read(f, first.withdrawalId)).json().state, 'final');
});

test('POST answers report safe exactly as GET does', async (t) => {
  const f = await setup(t);
  f.chain.state.safeDepth = 1n;
  const first = await signedWithdrawal(f, 1);
  f.chain.include(first.userOpHash);
  f.chain.mine(1);
  const again = await post(f, `${first.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, first.userOpHash),
  });
  assert.equal(again.statusCode, 202, again.body);
  assert.equal(again.json().state, 'included');
  assert.equal(again.json().safe, true);
  assert.deepEqual(again.json(), (await read(f, first.withdrawalId)).json());
  const cancel = await post(f, `${first.withdrawalId}/cancel`, {});
  assert.equal(cancel.json().code, 'not_cancellable');
});

test('lanes: twenty stuck operations never starve a newer one; it settles and its hold ends within two creates', async (t) => {
  const f = await lanesSetup(t);
  for (let n = 1; n <= 20; n++) {
    await signIt(f, await created(f, n, { amount: '1000' }));
    f.clock.now += 1_000;
  }
  const newer = await created(f, 21, { amount: '1000' });
  await signIt(f, newer);
  f.chain.include(newer.userOpHash);
  f.chain.mine(3);
  const stateOf = async () =>
    (
      await f.pg.query<{ state: string }>(
        'SELECT state FROM base_wallet_withdrawals WHERE withdrawal_id = $1',
        [newer.withdrawalId],
      )
    ).rows[0].state;
  for (const n of [22, 23]) {
    if ((await stateOf()) === 'final') break;
    f.clock.now += 1_000;
    assert.equal((await create(f, usdc(n, { amount: '1000' }))).statusCode, 201);
  }
  assert.equal(await stateOf(), 'final');
  const { rows } = await f.pg.query<{ state: string }>(
    `SELECT r.state FROM base_wallet_reservations r
     JOIN base_wallet_withdrawals w ON w.reservation_id = r.reservation_id
     WHERE w.withdrawal_id = $1`,
    [newer.withdrawalId],
  );
  assert.equal(rows[0].state, 'consumed');
});

test('lanes: a live spending-limit revoke that deploys the wallet holds the deployment too', async (t) => {
  const f = await lanesSetup(t, {}, false);
  await f.pg.query(
    `INSERT INTO base_spend_permissions (permission_id, wallet_id, chain_id, permission, signature,
       state, created_at, updated_at, revoke_operation, revoke_expires_at)
     VALUES ('perm-1', $1, $2, '{}', $3, 'revoke_pending', 1, 1, $4, $5)`,
    [
      `wallet-${AGENT.slice(0, 4)}`,
      WALLET_EXPECTED.chainId,
      Buffer.alloc(65, 1),
      JSON.stringify({ initCode: '0x1234' }),
      NOW + 60_000,
    ],
  );
  const refused = (await create(f, usdc(1, { amount: '1000' }))).json();
  assert.equal(refused.code, 'operation_pending');
  assert.equal(refused.permissionId, 'perm-1');
  // Once that revoke can no longer be signed, the deployment is free again.
  f.clock.now += 120_000;
  assert.equal((await create(f, usdc(2, { amount: '1000' }))).statusCode, 201);
});

test('the open list exists only with lanes on, rate limited per person; otherwise the path answers as before', async (t) => {
  const calls: string[] = [];
  const f = await lanesSetup(t, {});
  const limited = await setup(t, {
    env: LANES_ON,
    limit: async (key, max, windowMs) => {
      calls.push(`${key}|${max}|${windowMs}`);
    },
  });
  assert.equal((await openList(limited)).statusCode, 200);
  assert.deepEqual(calls, ['wallet-open:person-1|30|60000']);
  // A bare GET answers exactly as a path with no route.
  const bare = await openList(f, 'person-1', AGENT, '');
  const none = await f.app.inject({ url: `${url()}-none`, headers: as('person-1') });
  assert.equal(bare.statusCode, 404);
  assert.deepEqual(Object.keys(bare.json()).sort(), Object.keys(none.json()).sort());
  assert.equal(bare.json().error, none.json().error);
  assert.equal(bare.json().message, `Route GET:${url()} not found`);
  // Lanes off: no open list either.
  f.settings.CITY_BASE_LANES = '0';
  const off = await openList(f);
  assert.equal(off.statusCode, 404);
  assert.equal(off.json().message, `Route GET:${url()}?open=1 not found`);
});

test('fallback on, an owner-funded cancel’s gas is held until the cancel ends', async (t) => {
  const f = await setup(t, { env: FALLBACK_ON });
  const body = await signedWithdrawal(f, 1);
  f.chain.state.sponsor = false;
  const cancelHolds = async () =>
    (
      await f.pg.query<{ state: string; amount: string; token: string }>(
        `SELECT state, amount::text AS amount, token FROM base_wallet_reservations
         WHERE holder_ref LIKE '%:cancel:%' ORDER BY created_at, reservation_id`,
      )
    ).rows;
  const first = (await post(f, `${body.withdrawalId}/cancel`, {})).json();
  assert.equal(first.cancel.sponsored, false);
  assert.deepEqual(await cancelHolds(), [
    { state: 'held', amount: first.cancel.fee.max.raw, token: NATIVE_ETH.toLowerCase() },
  ]);
  // Not signed in time: the cancel lapses and its gas is no longer held.
  f.clock.now += WITHDRAWAL_SIGNATURE_TTL_MS + 1;
  assert.equal((await read(f, body.withdrawalId)).json().state, 'submitted');
  assert.deepEqual(
    (await cancelHolds()).map((row) => row.state),
    ['released'],
  );
  // Asked again and signed; the original lands first, so the no-op is never charged.
  const again = (await post(f, `${body.withdrawalId}/cancel`, {})).json();
  assert.deepEqual(
    (await cancelHolds()).map((row) => row.state),
    ['released', 'held'],
  );
  const signed = await post(f, `${body.withdrawalId}/cancel/signature`, {
    signature: await rawSign(f.owner, again.cancel.userOpHash),
  });
  assert.equal(signed.statusCode, 202, signed.body);
  f.chain.include(body.userOpHash);
  f.chain.mine(3);
  assert.equal((await read(f, body.withdrawalId)).json().state, 'final');
  assert.deepEqual(
    (await cancelHolds()).map((row) => row.state),
    ['released', 'released'],
  );
});

// --- the sponsor's exposure in flight ------------------------------------------------------------

async function exposures(f: Fixture) {
  const { rows } = await f.pg.query<{ holder: string; amount: string; state: string }>(
    `SELECT holder, amount::text AS amount, state FROM base_sponsor_exposure
     ORDER BY created_at, holder DESC`,
  );
  return rows.map((row) => ({
    kind: row.holder.split(':')[0],
    amount: BigInt(row.amount),
    state: row.state,
  }));
}

/** What the sponsor holds right now (held rows only). */
async function heldExposure(f: Fixture) {
  const { rows } = await f.pg.query<{ total: string | null }>(
    "SELECT sum(amount)::text AS total FROM base_sponsor_exposure WHERE state = 'held'",
  );
  return BigInt(rows[0]?.total ?? '0');
}

/** The sponsor's most expensive gas for an operation as prepared (what the fee cap bounds). */
const costOf = (body: { userOperation: RpcUserOperation }) =>
  maxCostWei(userOperationFromRpc(body.userOperation));

/** Its cancel headroom without a fee cap: its own gas at the fees a replacement must offer. */
const roomOf = (body: { userOperation: RpcUserOperation }) => {
  const op = userOperationFromRpc(body.userOperation);
  const fee = op.maxFeePerGas + op.maxFeePerGas / 10n + 1n;
  return (op.callGasLimit + op.verificationGasLimit * 3n + op.preVerificationGas) * fee;
};

/** What one sponsored operation reserves: its own cost and its cancel headroom. */
const perOp = (body: { userOperation: RpcUserOperation }) => costOf(body) + roomOf(body);

/** One sponsored operation's reservation, learned on a throwaway fixture. */
async function probePerOp(t: { after: (fn: () => Promise<unknown>) => void }) {
  const probe = await setup(t);
  return perOp(await created(probe, 1, { amount: '1000' }));
}

test('sponsor exposure: absolute defaults of 0.1 ETH per wallet and 3 ETH in total; explicit settings win', () => {
  const defaults = { perWallet: 10n ** 17n, total: 3n * 10n ** 18n };
  assert.deepEqual(sponsorBudget({}), { ...defaults, feeCap: null });
  // The fee cap no longer scales them: it is only a cancel's headroom.
  assert.deepEqual(sponsorBudget({ CITY_BASE_WALLET_FEE_CAP_WEI: '1000' }), {
    ...defaults,
    feeCap: 1000n,
  });
  assert.deepEqual(
    sponsorBudget({
      CITY_BASE_WALLET_FEE_CAP_WEI: '1000',
      CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET: '5',
      CITY_BASE_SPONSOR_INFLIGHT_WEI_TOTAL: '7',
    }),
    { perWallet: 5n, total: 7n, feeCap: 1000n },
  );
  for (const bad of ['x', '0', '-1', '1.5'])
    assert.deepEqual(
      sponsorBudget({
        CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET: bad,
        CITY_BASE_SPONSOR_INFLIGHT_WEI_TOTAL: bad,
      }),
      { ...defaults, feeCap: null },
      bad,
    );
});

test('sponsor exposure: each sponsored operation reserves its cost and a cancel headroom; a cancel adds nothing; released on final, failed and expiry; uncertain stays', async (t) => {
  const f = await setup(t);
  const discarded = await created(f, 1);
  assert.deepEqual(await exposures(f), [
    { kind: 'withdrawal', amount: costOf(discarded), state: 'held' },
    { kind: 'headroom', amount: roomOf(discarded), state: 'held' },
  ]);
  await post(f, `${discarded.withdrawalId}/cancel`, {});
  assert.deepEqual(
    (await exposures(f)).map((row) => row.state),
    ['released', 'released'],
  );
  f.clock.now += 1_000;
  const sent = await signedWithdrawal(f, 2);
  f.clock.now += 1_000;
  // A sponsored cancel fits its operation's headroom: nothing more is reserved.
  const asked = (await post(f, `${sent.withdrawalId}/cancel`, {})).json();
  assert.equal(asked.cancel.sponsored, true);
  const noop = maxCostWei(userOperationFromRpc(asked.cancel.userOperation));
  assert.ok(noop - costOf(sent) <= roomOf(sent), 'the cancel fits its headroom');
  assert.equal((await exposures(f)).length, 4);
  // It lapses: the operation's reservation stays as it was.
  f.clock.now += WITHDRAWAL_SIGNATURE_TTL_MS + 1;
  assert.equal((await read(f, sent.withdrawalId)).json().state, 'submitted');
  assert.deepEqual(
    (await exposures(f)).slice(2).map((row) => row.state),
    ['held', 'held'],
  );
  // In a block but not final, or Base unreachable: it stays reserved.
  f.chain.include(sent.userOpHash);
  assert.equal((await read(f, sent.withdrawalId)).json().state, 'included');
  f.chain.state.nodeDown = true;
  await read(f, sent.withdrawalId);
  f.chain.state.nodeDown = false;
  assert.equal((await exposures(f))[2].state, 'held');
  f.chain.mine(3);
  assert.equal((await read(f, sent.withdrawalId)).json().state, 'final');
  assert.deepEqual(
    (await exposures(f)).slice(2).map((row) => row.state),
    ['released', 'released'],
  );
  // Reverted, failed once final: released then.
  f.clock.now += 1_000;
  const reverted = await signedWithdrawal(f, 3);
  f.chain.include(reverted.userOpHash, false);
  await read(f, reverted.withdrawalId);
  assert.equal((await exposures(f))[4].state, 'held');
  f.chain.mine(3);
  assert.equal((await read(f, reverted.withdrawalId)).json().state, 'failed');
  assert.deepEqual(
    (await exposures(f)).slice(4).map((row) => row.state),
    ['released', 'released'],
  );
});

test('sponsor exposure: per wallet, concurrent creates admit exactly as many as fit (409 sponsor_busy with retryAfterSeconds)', async (t) => {
  const one = await probePerOp(t);
  const f = await lanesSetup(t, {
    CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET: (one * 3n).toString(10),
  });
  f.chain.state.barrier = barrier(5);
  const answers = await Promise.all(
    [1, 2, 3, 4, 5].map((n) => create(f, usdc(n, { amount: '1000' }))),
  );
  f.chain.state.barrier = null;
  assert.deepEqual(answers.map((res) => res.statusCode).sort(), [201, 201, 201, 409, 409]);
  for (const res of answers.filter((one) => one.statusCode === 409)) {
    assert.equal(res.json().code, 'sponsor_busy');
    assert.deepEqual(res.json().details, { retryAfterSeconds: 60 });
  }
  assert.equal(await heldExposure(f), one * 3n);
});

test('sponsor exposure: cancel races another wallet admission without exceeding the total cap', async (t) => {
  const one = await probePerOp(t);
  const f = await lanesSetup(t, {
    CITY_BASE_SPONSOR_INFLIGHT_WEI_TOTAL: one.toString(10),
  });
  const original = await created(f, 1, { amount: '1000' });
  await signIt(f, original);
  const [cancel, admission] = await Promise.all([
    post(f, `${original.withdrawalId}/cancel`, {}),
    create(f, usdc(2, { amount: '1000' }), { agent: AI_AGENT }),
  ]);
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(admission.statusCode, 409, admission.body);
  assert.equal(admission.json().code, 'sponsor_busy');
  assert.equal(await heldExposure(f), one);
  const [signed, retry] = await Promise.all([
    post(f, `${original.withdrawalId}/cancel/signature`, {
      signature: await rawSign(f.owner, cancel.json().cancel.userOpHash),
    }),
    create(f, usdc(3, { amount: '1000' }), { agent: AI_AGENT }),
  ]);
  assert.equal(signed.statusCode, 202, signed.body);
  assert.equal(retry.statusCode, 409, retry.body);
  assert.equal(retry.json().code, 'sponsor_busy');
  assert.equal(await heldExposure(f), one);
});

test('sponsor exposure: the caps are hard ceilings, cancels included, in every interleaving tried', async (t) => {
  const one = await probePerOp(t);
  const cap = one * 2n;
  const f = await lanesSetup(t, {
    CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET: cap.toString(10),
    CITY_BASE_SPONSOR_INFLIGHT_WEI_TOTAL: (cap + one).toString(10),
  });
  const within = async () => {
    const held = await heldExposure(f);
    assert.ok(held <= cap + one, `${held} within the total cap`);
  };
  f.chain.state.barrier = barrier(4);
  const answers = await Promise.all(
    [1, 2, 3, 4].map((n) => create(f, usdc(n, { amount: '1000' }))),
  );
  f.chain.state.barrier = null;
  const admitted = answers.filter((res) => res.statusCode === 201).map((res) => res.json());
  assert.equal(admitted.length, 2);
  await within();
  // Both signed and cancelled, the cancels signed: never a wei more.
  for (const body of admitted) {
    await signIt(f, body);
    const asked = await post(f, `${body.withdrawalId}/cancel`, {});
    assert.equal(asked.statusCode, 200, asked.body);
    await within();
    const signed = await post(f, `${body.withdrawalId}/cancel/signature`, {
      signature: await rawSign(f.owner, asked.json().cancel.userOpHash),
    });
    assert.equal(signed.statusCode, 202, signed.body);
    await within();
  }
  // Another wallet takes what the total leaves, and no more.
  const other = await create(f, usdc(5, { amount: '1000' }), { agent: AI_AGENT });
  assert.equal(other.statusCode, 201, other.body);
  assert.equal((await create(f, usdc(6, { amount: '1000' }))).json().code, 'sponsor_busy');
  await within();
});

test('sponsor exposure: a cancel that would cost more than its headroom is refused, or owner-funded where that is allowed', async (t) => {
  for (const env of [{ CITY_BASE_WALLET: '1' }, FALLBACK_ON]) {
    const f = await setup(t, { env });
    const body = await signedWithdrawal(f, 1);
    // Fees jump far above what the headroom was set aside for.
    f.chain.state.fees.maxFeePerGas *= 20n;
    f.chain.state.fees.maxPriorityFeePerGas *= 20n;
    const before = await heldExposure(f);
    const asked = await post(f, `${body.withdrawalId}/cancel`, {});
    if (env === FALLBACK_ON) {
      assert.equal(asked.statusCode, 200, asked.body);
      assert.equal(asked.json().cancel.sponsored, false, 'the wallet pays its own cancel');
    } else {
      assert.equal(asked.statusCode, 409, asked.body);
      assert.equal(asked.json().code, 'cancel_over_headroom');
      assert.equal((await read(f, body.withdrawalId)).json().state, 'submitted');
    }
    assert.equal(await heldExposure(f), before, 'the sponsor reserves nothing more');
  }
});

test('sponsor exposure: the total cap refuses a second wallet while the first holds all of it (409 sponsor_busy)', async (t) => {
  const one = await probePerOp(t);
  const f = await setup(t, {
    env: { CITY_BASE_WALLET: '1', CITY_BASE_SPONSOR_INFLIGHT_WEI_TOTAL: one.toString(10) },
  });
  const a = await created(f, 1, { amount: '1000' });
  const busy = await create(f, usdc(2, { amount: '1000' }), { agent: AI_AGENT });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().code, 'sponsor_busy');
  assert.deepEqual(busy.json().details, { retryAfterSeconds: 60 });
  assert.equal((await f.pg.query('SELECT 1 FROM base_wallet_withdrawals')).rows.length, 1);
  await post(f, `${a.withdrawalId}/signature`, { signature: await rawSign(f.owner, a.userOpHash) });
  f.chain.include(a.userOpHash);
  f.chain.mine(3);
  assert.equal((await read(f, a.withdrawalId)).json().state, 'final');
  assert.equal((await create(f, usdc(3, { amount: '1000' }), { agent: AI_AGENT })).statusCode, 201);
});

test('sponsor exposure: turning lanes off keeps what laned operations reserved until they end', async (t) => {
  const f = await lanesSetup(t);
  const a = await created(f, 1, { amount: '1000' });
  const b = await created(f, 2, { amount: '1000' });
  await signIt(f, a);
  f.settings.CITY_BASE_LANES = '0';
  assert.equal((await create(f, usdc(3))).json().code, 'operation_pending');
  assert.equal(await heldExposure(f), perOp(a) + perOp(b));
  await post(f, `${b.withdrawalId}/cancel`, {});
  f.chain.include(a.userOpHash);
  f.chain.mine(3);
  assert.equal((await read(f, a.withdrawalId)).json().state, 'final');
  assert.equal(await heldExposure(f), 0n);
});

test('sponsor exposure: an unsigned operation abandoned past its time never blocks another wallet', async (t) => {
  const one = await probePerOp(t);
  const f = await setup(t, {
    env: { CITY_BASE_WALLET: '1', CITY_BASE_SPONSOR_INFLIGHT_WEI_TOTAL: one.toString(10) },
  });
  await created(f, 1, { amount: '1000' });
  f.clock.now += WITHDRAWAL_SIGNATURE_TTL_MS + 60 * 60_000;
  const other = await create(f, usdc(2, { amount: '1000' }), { agent: AI_AGENT });
  assert.equal(other.statusCode, 201, other.body);
});

test('sponsor exposure: an operation final on Base that nobody reads is released by the sweep, and frees the cap', async (t) => {
  const one = await probePerOp(t);
  const secret = randomUUID();
  const f = await setup(t, {
    env: { CITY_BASE_WALLET: '1', CITY_BASE_SPONSOR_INFLIGHT_WEI_TOTAL: one.toString(10) },
    cronSecret: secret,
  });
  const a = await signedWithdrawal(f, 1);
  f.chain.include(a.userOpHash);
  f.chain.mine(3);
  const busy = await create(f, usdc(2, { amount: '1000' }), { agent: AI_AGENT });
  assert.equal(busy.json().code, 'sponsor_busy');
  assert.deepEqual(busy.json().details, { retryAfterSeconds: 60 });
  const sweep = (authorization?: string) =>
    f.app.inject({
      url: '/api/cron/base-wallet-sweep',
      headers: authorization ? { authorization } : {},
    });
  assert.equal((await sweep()).statusCode, 404);
  assert.equal((await sweep(`Bearer ${randomUUID()}`)).statusCode, 404);
  const swept = await sweep(`Bearer ${secret}`);
  assert.equal(swept.statusCode, 200, swept.body);
  assert.equal(swept.json().advanced, 1);
  assert.equal(await heldExposure(f), 0n);
  const now = await create(f, usdc(3, { amount: '1000' }), { agent: AI_AGENT });
  assert.equal(now.statusCode, 201, now.body);
});

test('sponsor exposure: the sweep stops starting reads after its time budget', async (t) => {
  const f = await setup(t);
  const a = await signedWithdrawal(f, 1);
  f.chain.include(a.userOpHash);
  f.chain.mine(3);
  const service = createWithdrawalService({
    db: f.db,
    operations: async () => f.port,
    balances: f.balances,
    now: () => f.clock.now,
  });
  assert.deepEqual(await service.sweep(0), { expired: 0, advanced: 0 });
  assert.equal((await service.sweep()).advanced, 1);
});

test('sponsor exposure: a cancel with the cap full is admitted within its headroom; an operation over a cap by itself gets no retry hint', async (t) => {
  const one = await probePerOp(t);
  const f = await setup(t, {
    env: { CITY_BASE_WALLET: '1', CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET: one.toString(10) },
  });
  const a = await signedWithdrawal(f, 1);
  const asked = await post(f, `${a.withdrawalId}/cancel`, {});
  assert.equal(asked.statusCode, 200, asked.body);
  assert.equal(await heldExposure(f), one, 'nothing beyond the cap');
  const signed = await post(f, `${a.withdrawalId}/cancel/signature`, {
    signature: await rawSign(f.owner, asked.json().cancel.userOpHash),
  });
  assert.equal(signed.statusCode, 202, signed.body);
  const tiny = await setup(t, {
    env: { CITY_BASE_WALLET: '1', CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET: '1' },
  });
  const never = await create(tiny, usdc(1, { amount: '1000' }));
  assert.equal(never.json().code, 'sponsor_busy');
  assert.deepEqual(never.json().details, {});
});

test('sponsor exposure: one advisory lock, taken first; no table lock anywhere', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../server/base/wallet/withdrawals.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /LOCK TABLE/i);
  assert.match(source, /pg_advisory_xact_lock/);
  // Every transaction that writes the exposure or settles it starts with the lock.
  const transactions = source.split('db.transaction(async (tx) => {').slice(1);
  for (const body of transactions) {
    const head = body.slice(0, 400);
    if (/Exposure|settleHolds|FOR UPDATE/.test(body.slice(0, 3000)))
      assert.match(head, /^(\s*\/\/[^\n]*\n)*\s*await exposureLock\(tx\);/, head.slice(0, 160));
  }
});

test('lock waits the database broke off answer 503 retry: deadlock, serialization, lock not available, statement timeout', async (t) => {
  assert.deepEqual([...RETRYABLE_CODES].sort(), ['40001', '40P01', '55P03', '57014']);
  for (const code of RETRYABLE_CODES) {
    const app = Fastify();
    t.after(() => app.close());
    registerWithdrawalRoutes(app, {
      enabled: () => true,
      lanes: () => false,
      person: async () => ({ ok: true, accountId: 'person-1' }),
      service: {
        read: async () => {
          throw Object.assign(new Error('broken off'), { code });
        },
      } as unknown as WithdrawalService,
    });
    const res = await app.inject({ url: `${url()}/${key(1)}` });
    assert.equal(res.statusCode, 503, code);
    assert.equal(res.json().code, 'retry');
  }
});

test('sponsor exposure: migration 97 backfills open sponsored operations with their cancel headroom; they count and are released', async (t) => {
  const f = await lanesSetup(t);
  const unsigned = await created(f, 1, { amount: '1000' });
  f.clock.now += 1_000;
  const reverted = await created(f, 2, { amount: '1000' });
  await signIt(f, reverted);
  f.clock.now += 1_000;
  const cancelled = await created(f, 3, { amount: '1000' });
  await signIt(f, cancelled);
  const asked = (await post(f, `${cancelled.withdrawalId}/cancel`, {})).json();
  await post(f, `${cancelled.withdrawalId}/cancel/signature`, {
    signature: await rawSign(f.owner, asked.cancel.userOpHash),
  });
  f.clock.now += 1_000;
  const landed = await created(f, 4, { amount: '1000' });
  await signIt(f, landed);
  f.chain.include(landed.userOpHash);
  await read(f, landed.withdrawalId);
  // As if they were made before 97: no exposure at all. Then 97 runs (twice: idempotent).
  await f.pg.query('DELETE FROM base_sponsor_exposure');
  await f.pg.exec(BASE_SPONSOR_EXPOSURE_SQL);
  await f.pg.exec(BASE_SPONSOR_EXPOSURE_SQL);
  const { rows } = await f.pg.query<{ holder: string; amount: string }>(
    'SELECT holder, amount::text AS amount FROM base_sponsor_exposure',
  );
  const byHolder = new Map(rows.map((row) => [row.holder, BigInt(row.amount)]));
  assert.equal(rows.length, 8, JSON.stringify(rows));
  for (const body of [unsigned, reverted, cancelled, landed]) {
    assert.equal(byHolder.get(`withdrawal:${body.withdrawalId}`), costOf(body));
    assert.equal(byHolder.get(`headroom:${body.withdrawalId}`), roomOf(body));
  }
  const counted = rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  f.settings.CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET = counted.toString(10);
  assert.equal((await create(f, usdc(5, { amount: '1000' }))).json().code, 'sponsor_busy');
  await post(f, `${unsigned.withdrawalId}/cancel`, {});
  f.chain.include(reverted.userOpHash, false);
  f.chain.include(asked.cancel.userOpHash);
  f.chain.mine(3);
  assert.equal((await read(f, reverted.withdrawalId)).json().state, 'failed');
  assert.equal((await read(f, cancelled.withdrawalId)).json().state, 'cancelled');
  assert.equal((await read(f, landed.withdrawalId)).json().state, 'final');
  assert.equal(await heldExposure(f), 0n);
});

test('sponsor exposure: an operation from before the ledger is reserved (with its headroom) when signed, or not signed over a cap; a legacy cancel is topped up', async (t) => {
  const f = await lanesSetup(t);
  const forget = (id: string) =>
    f.pg.query('DELETE FROM base_sponsor_exposure WHERE withdrawal_id = $1', [id]);
  const e = await created(f, 1, { amount: '1000' });
  await forget(e.withdrawalId);
  await signIt(f, e);
  assert.equal(await heldExposure(f), perOp(e));
  f.clock.now += 1_000;
  const g = await created(f, 2, { amount: '1000' });
  await forget(g.withdrawalId);
  f.settings.CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET = perOp(e).toString(10);
  const refused = await post(f, `${g.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, g.userOpHash),
  });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, 'sponsor_busy');
  assert.equal((await read(f, g.withdrawalId)).json().state, 'awaiting_signature');
  assert.equal(f.chain.state.sends.length, 1, 'nothing more sent');
  // A cancel asked for before its headroom existed: topped up at its signature, under the caps.
  delete f.settings.CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET;
  const asked = (await post(f, `${e.withdrawalId}/cancel`, {})).json();
  await f.pg.query("DELETE FROM base_sponsor_exposure WHERE holder LIKE 'headroom:%'");
  const signedCancel = await post(f, `${e.withdrawalId}/cancel/signature`, {
    signature: await rawSign(f.owner, asked.cancel.userOpHash),
  });
  assert.equal(signedCancel.statusCode, 202, signedCancel.body);
  const noop = maxCostWei(userOperationFromRpc(asked.cancel.userOperation));
  const { rows } = await f.pg.query<{ amount: string }>(
    "SELECT amount::text AS amount FROM base_sponsor_exposure WHERE holder LIKE 'headroom:%' AND state = 'held'",
  );
  assert.deepEqual(
    rows.map((row) => BigInt(row.amount)),
    [noop - costOf(e)],
  );
});

test('sponsor exposure: startup warnings for settings that fall back or leave the caps off', () => {
  assert.deepEqual(sponsorBudgetWarnings({}), []);
  assert.match(
    sponsorBudgetWarnings({ CITY_BASE_SPONSOR_INFLIGHT_WEI_TOTAL: '0' })[0],
    /default \(3 ETH\)/,
  );
  assert.match(
    sponsorBudgetWarnings({ CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET: 'x' })[0],
    /default \(0\.1 ETH\)/,
  );
  assert.match(sponsorBudgetWarnings({ CITY_BASE_WALLET_FEE_CAP_WEI: '0' })[0], /estimated/);
});

test('sponsor exposure: cost and headroom are checked together against a cap that is not a multiple of them, per wallet and in total', async (t) => {
  const probe = await setup(t);
  const body = await created(probe, 1, { amount: '1000' });
  // The review's numbers: this node's operation costs 1.5e12 wei and its headroom 1.65e12 + 750000.
  assert.equal(costOf(body), 1_500_000_000_000n);
  assert.equal(roomOf(body), 1_650_000_750_000n);
  const together = costOf(body) + roomOf(body);
  for (const setting of [
    'CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET',
    'CITY_BASE_SPONSOR_INFLIGHT_WEI_TOTAL',
  ]) {
    // Each part fits the cap alone; together they do not: refused, nothing reserved or stored.
    const short = await setup(t, {
      env: { CITY_BASE_WALLET: '1', [setting]: roomOf(body).toString(10) },
    });
    const refused = await create(short, usdc(1, { amount: '1000' }));
    assert.equal(refused.statusCode, 409, `${setting}: ${refused.body}`);
    assert.equal(refused.json().code, 'sponsor_busy');
    assert.equal(await heldExposure(short), 0n);
    assert.equal((await short.pg.query('SELECT 1 FROM base_wallet_withdrawals')).rows.length, 0);
    // Exactly cost plus headroom: admitted, and the cap is then exactly full.
    const exact = await setup(t, {
      env: { CITY_BASE_WALLET: '1', [setting]: together.toString(10) },
    });
    const admitted = await create(exact, usdc(1, { amount: '1000' }));
    assert.equal(admitted.statusCode, 201, `${setting}: ${admitted.body}`);
    assert.equal(await heldExposure(exact), together);
    // One wei short of that: refused.
    const oneShort = await setup(t, {
      env: { CITY_BASE_WALLET: '1', [setting]: (together - 1n).toString(10) },
    });
    assert.equal(
      (await create(oneShort, usdc(1, { amount: '1000' }))).json().code,
      'sponsor_busy',
      setting,
    );
  }
});

test('migration 97 is registered after 96 and its table is one the backup recognizes (never exported)', () => {
  registerBaseMigration();
  const versions = listMigrations().map((m) => m.version);
  for (const version of [93, 94, 95, 96, 97, 98])
    assert.ok(versions.includes(version), `${version}`);
  assert.ok(versions.indexOf(97) > versions.indexOf(96));
  assert.ok(BASE_TABLES.includes('base_sponsor_exposure'));
});

test('migration 99 only adds the ratings-by-Base-ID index, after 98', () => {
  registerBaseMigration();
  const migrations = listMigrations();
  const versions = migrations.map((m) => m.version);
  assert.ok(versions.indexOf(99) > versions.indexOf(98));
  const sql = migrations.find((m) => m.version === 99)!.sql;
  assert.match(sql, /CREATE INDEX IF NOT EXISTS base_wallet_withdrawals_rated/);
  assert.match(sql, /\(chain_id, rated_base_id\) WHERE kind = 'rate'/);
  // An index only: nothing altered, dropped or written.
  assert.doesNotMatch(sql, /\b(ALTER|DROP|INSERT|UPDATE|DELETE)\b/i);
});

/** Counts the safe-head proofs the service asks Base for (owner-ops.ts settledAtSafe). */
function countProofs(f: Fixture) {
  const prove = f.port.settledAtSafe!;
  const counter = { proofs: 0 };
  f.port.settledAtSafe = async (input) => {
    counter.proofs++;
    return prove(input);
  };
  return counter;
}

const safeAt = async (f: Fixture, id: string) =>
  (
    await f.pg.query<{ safe_at: string | null }>(
      'SELECT safe_at::text AS safe_at FROM base_wallet_withdrawals WHERE withdrawal_id = $1',
      [id],
    )
  ).rows[0].safe_at;

test('a safe-head proof is made once and stored: later GET :id reads answer from it without asking Base', async (t) => {
  const f = await setup(t);
  f.chain.state.safeDepth = 1n;
  const first = await signedWithdrawal(f, 1);
  f.chain.include(first.userOpHash);
  f.chain.mine(1);
  const count = countProofs(f);
  const proven = (await read(f, first.withdrawalId)).json();
  assert.equal(proven.state, 'included');
  assert.equal(proven.safe, true);
  assert.equal(count.proofs, 1);
  assert.notEqual(await safeAt(f, first.withdrawalId), null, 'stored with the proof');
  // Every later read: safe from the stored proof, no proof asked of Base.
  for (let i = 0; i < 3; i++) {
    const again = (await read(f, first.withdrawalId)).json();
    assert.equal(again.safe, true);
    assert.deepEqual(again, proven);
  }
  assert.equal(count.proofs, 1, 'GET :id reuses the stored proof');
  // Not final: a stored safe proof never makes it final.
  assert.equal((await read(f, first.withdrawalId)).json().state, 'included');
  // A decision about money (the next operation's admission, the holds a balance read leaves out)
  // still proves live: a stored proof never frees a nonce or an amount.
  await created(f, 2);
  assert.equal(count.proofs, 2, 'admission proved again, live');
});

test('a stored safe proof is cleared when Base drops the block, and the next read proves again', async (t) => {
  const f = await setup(t);
  f.chain.state.safeDepth = 1n;
  const first = await signedWithdrawal(f, 1);
  f.chain.include(first.userOpHash);
  f.chain.mine(1);
  const count = countProofs(f);
  assert.equal((await read(f, first.withdrawalId)).json().safe, true);
  assert.notEqual(await safeAt(f, first.withdrawalId), null);
  // Base drops the block (the receipt is gone): back on its way, never safe, the proof cleared.
  f.chain.uninclude(first.userOpHash);
  const back = (await read(f, first.withdrawalId)).json();
  assert.equal(back.state, 'submitted');
  assert.equal(back.safe, false);
  assert.equal(await safeAt(f, first.withdrawalId), null, 'cleared by the row (migration 96)');
  // It lands again in a new block: in it, but not at the safe head yet, so not safe.
  f.chain.include(first.userOpHash);
  const relanded = (await read(f, first.withdrawalId)).json();
  assert.equal(relanded.state, 'included');
  assert.notEqual(relanded.blockNumber, null);
  assert.equal(relanded.safe, false);
  const before = count.proofs;
  assert.ok(before >= 2, 'the new receipt was proven live, not answered from the old proof');
  // Safe again for the new receipt: proven once more and stored for it.
  f.chain.mine(1);
  const safeAgain = (await read(f, first.withdrawalId)).json();
  assert.equal(safeAgain.safe, true);
  assert.equal(count.proofs, before + 1);
  assert.notEqual(await safeAt(f, first.withdrawalId), null);
  assert.equal((await read(f, first.withdrawalId)).json().safe, true);
  assert.equal(count.proofs, before + 1, 'and reused');
});

test('a stored safe proof is cleared when the receipt moves to another block between two reads', async (t) => {
  const f = await setup(t);
  f.chain.state.safeDepth = 1n;
  const first = await signedWithdrawal(f, 1);
  f.chain.include(first.userOpHash);
  f.chain.mine(1);
  const count = countProofs(f);
  const proven = (await read(f, first.withdrawalId)).json();
  assert.equal(proven.safe, true);
  // Dropped and re-mined in a later block before anyone read it: the row takes the new receipt.
  f.chain.uninclude(first.userOpHash);
  f.chain.mine(1);
  f.chain.include(first.userOpHash);
  const moved = (await read(f, first.withdrawalId)).json();
  assert.equal(moved.state, 'included');
  assert.notEqual(moved.blockNumber, proven.blockNumber);
  assert.equal(moved.safe, false, 'the old proof is never carried over to the new block');
  assert.equal(await safeAt(f, first.withdrawalId), null);
  assert.equal(count.proofs, 2);
});

test('the stored proof is written only by a display read, never for a reverted operation', async (t) => {
  const f = await setup(t);
  f.chain.state.safeDepth = 1n;
  const first = await signedWithdrawal(f, 1);
  f.chain.include(first.userOpHash, false);
  f.chain.mine(1);
  const count = countProofs(f);
  const reverted = (await read(f, first.withdrawalId)).json();
  assert.equal(reverted.errorCode, 'reverted');
  assert.equal(reverted.safe, false);
  assert.equal(count.proofs, 0, 'a revert is never shown safe, so it is not proven for a read');
  assert.equal(await safeAt(f, first.withdrawalId), null);
  // Admission still proves it live (its nonce is used for good) and stores nothing.
  await created(f, 2);
  assert.equal(count.proofs, 1);
  assert.equal(await safeAt(f, first.withdrawalId), null);
});

test('lanes: GET ?open=1 answers a stored safe proof without asking Base, and proves only the rest', async (t) => {
  const f = await lanesSetup(t);
  f.chain.state.safeDepth = 1n;
  const a = await created(f, 1, { amount: '1000' });
  f.clock.now += 1_000;
  const b = await created(f, 2, { amount: '1000' });
  await signIt(f, a);
  await signIt(f, b);
  f.chain.include(a.userOpHash);
  f.chain.include(b.userOpHash);
  f.chain.mine(1);
  const count = countProofs(f);
  const safeOf = async () =>
    Object.fromEntries(
      (
        (await openList(f)).json().withdrawals as Array<{ withdrawalId: string; safe: boolean }>
      ).map((view) => [view.withdrawalId, view.safe]),
    );
  assert.deepEqual(await safeOf(), { [a.withdrawalId]: true, [b.withdrawalId]: true });
  assert.equal(count.proofs, 2, 'one proof per included operation, stored');
  for (let i = 0; i < 3; i++)
    assert.deepEqual(await safeOf(), { [a.withdrawalId]: true, [b.withdrawalId]: true });
  assert.equal((await read(f, a.withdrawalId)).json().safe, true);
  assert.equal(count.proofs, 2, 'every later list and read answers from the stored proofs');
  // One of them loses its block: only that one goes back and is proven again once it lands.
  f.chain.uninclude(b.userOpHash);
  assert.deepEqual(await safeOf(), { [a.withdrawalId]: true, [b.withdrawalId]: false });
  assert.equal(count.proofs, 2);
  assert.equal(await safeAt(f, b.withdrawalId), null);
  assert.notEqual(await safeAt(f, a.withdrawalId), null);
});

test('a withdrawal read is rate limited per person before Base is read', async (t) => {
  const calls: string[] = [];
  let refuse = false;
  const f = await setup(t, {
    limit: async (key, max, windowMs) => {
      calls.push(`${key}|${max}|${windowMs}`);
      if (refuse) throw Object.assign(new Error('Too many requests.'), { statusCode: 429 });
    },
  });
  const body = await created(f, 1);
  calls.length = 0;
  const ok = await read(f, body.withdrawalId);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(calls, ['wallet-read:person-1|120|60000']);
  refuse = true;
  const limited = await read(f, body.withdrawalId);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().withdrawalId, undefined);
});
