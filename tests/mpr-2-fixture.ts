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
import {
  createSponsorOperators,
  installSponsorOperators,
  sponsorOperatorOwners,
} from '../server/base/chain/sponsor-operators.js';
import type { ChainRuntime } from '../server/base/identity/routes.js';
import type { BalanceReader } from '../server/base/chain/balances.js';
import {
  agentWalletRecipe,
  createAccountCall,
  deriveAddressLocal,
} from '../server/base/chain/derive.js';
import { walletSignature } from '../server/base/chain/permissions.js';
import { rpcBundler } from '../server/base/chain/rpc-bundler.js';
import { ownSendMarginS, VALIDITY_MARGIN_S } from '../server/base/chain/direct-bundler.js';
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
  MULTICALL3,
  NATIVE_ETH,
  type Address,
} from '../shared/base/chains.js';
import { PROTOCOL_BASE_MAINNET, reservedPayees } from '../shared/protocol.js';
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
  UNSIGNED_EXPOSURE_PER_ACCOUNT_WEI,
  UNSIGNED_OPEN_PER_ACCOUNT,
  WITHDRAWAL_MIN_RAW,
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
    /**
     * The paymaster whose bundler stops sending VALIDITY_MARGIN_S before validUntil (our own,
     * direct-bundler.ts); null: the bundler has no margin of its own (as CDP's).
     */
    ownPaymaster: null as Address | null,
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
  bundler.sendMarginS = (data) => ownSendMarginS(chain.state.ownPaymaster, data);
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

// Path-2 review fixture: a verbatim copy of the helpers of tests/base-wallet-withdraw.test.ts
// (that file exports nothing), exported for the mpr-2-* tests.
export {
  setup,
  create,
  created,
  signedWithdrawal,
  post,
  read,
  rawSign,
  reservations,
  auditKinds,
  usdc,
  key,
  url,
  as,
  sponsorData,
  AGENT,
  DEST,
  NOW,
  PAYMASTER,
  SPONSORS,
  FEE_BUDGET,
  NETWORK,
  SETTLE_DEPTH,
};
export type { Fixture, Options };
