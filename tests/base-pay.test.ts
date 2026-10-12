import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import {
  concat,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  keccak256,
  multicall3Abi,
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
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Database } from '../server/database.js';
import { createApp } from '../server/app.js';
import {
  BASE_IDENTITY_PROVISIONAL_SQL,
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_TABLES,
  BASE_SPONSOR_EXPOSURE_SQL,
  BASE_WALLET_LANES_SQL,
  BASE_WALLET_LIMITS_SQL,
  BASE_WALLET_ONE_UNSIGNED_SQL,
  BASE_WALLET_PAYMENTS_SQL,
  BASE_WALLET_RATINGS_SQL,
  BASE_WALLET_VAULT_SQL,
  BASE_WALLET_WITHDRAWALS_SAFE_SQL,
  BASE_WALLET_WITHDRAWALS_SQL,
  baseShortIdsMigration,
  baseWalletPaymentsMigration,
  baseWalletWithdrawalsSafeMigration,
  registerBaseMigration,
} from '../server/base/schema.js';
import { listMigrations } from '../server/migrations.js';
import { laneNonce } from '../shared/base/lanes.js';
import {
  CLOCK_SLACK_MS,
  INCOMING_REFRESH_MAX,
  INCOMING_SAFE_MAX,
  payStateOf,
} from '../server/base/pay/service.js';
import { createPayStore } from '../server/base/pay/store.js';
import { createIncomingFeed } from '../src/base/wallet/pay.js';
import { registerBaseWalletRoutes } from '../server/base/wallet/routes.js';
import { accountIndexFor } from '../server/base/wallet/service.js';
import type { ChainRuntime } from '../server/base/identity/routes.js';
import type { BalanceReader } from '../server/base/chain/balances.js';
import { agentWalletRecipe, deriveAddressLocal } from '../server/base/chain/derive.js';
import { identityRegistryAbi } from '../server/base/chain/identity-chain.js';
import {
  createOwnerOperationsPort,
  type OwnerOperationsPort,
} from '../server/base/chain/owner-ops.js';
import { walletSignature } from '../server/base/chain/permissions.js';
import { rpcBundler } from '../server/base/chain/rpc-bundler.js';
import { pgChainOperationStore } from '../server/base/chain/stores.js';
import { payChainReader, type PayChainReader } from '../server/base/pay/chain.js';
import { BASE_MAINNET, BASE_NETWORKS, MULTICALL3, type Address } from '../shared/base/chains.js';
import { AGENT_URI_ORIGIN } from '../shared/base/on-base.js';
import {
  PAY_MIN_AMOUNT,
  PAY_NOTE_MAX,
  PAY_PASSPORT_HOST,
  PAY_RECIPIENT_TTL_MS,
  parseRecipient,
} from '../shared/base/pay.js';
import { sponsoredWithoutCharge } from '../shared/base/paymasters.js';
import { SHORT_URI_ORIGIN } from '../shared/base/short-id.js';
import {
  ownerOperationHash,
  userOperationFromRpc,
  type RpcUserOperation,
} from '../shared/base/withdraw.js';
import {
  checkPayment as clientCheckPayment,
  checkRecipient as clientCheckRecipient,
  payTo as clientPayTo,
} from '../src/base/wallet/pay.js';
import { checkedIntent as clientCheckedIntent } from '../src/base/wallet/withdraw.js';
import { OTHER_EXPECTED, WALLET_EXPECTED, WALLET_NET } from './wallet-network-fixture.js';

/**
 * Operation Base Pay P1 (server) without any network: the wallet routes (W2 withdrawals + Pay) and
 * the owner-operations port with its durable chain path run for real on PGlite, with the synthetic
 * sponsor allowlist; Base is a fake node, the bundler/paymaster a local JSON-RPC stand-in, the
 * balance and ownerOf readers in-memory, and the real ownerOf reader is checked against a local
 * JSON-RPC mock on 127.0.0.1. The owner keys are throwaway local accounts; all else is synthetic.
 */
/** The wallet network (shared/base/wallet-network.ts): Base Sepolia or Base. */
const NETWORK = WALLET_NET;
const CHAIN_ID = WALLET_EXPECTED.chainId;
/** The canonical registry of the wallet network: the only one Pay resolves recipients in. */
const REGISTRY = WALLET_EXPECTED.registry;
/** The other network's registry: a registration there is never a recipient here. */
const OTHER_REGISTRY = OTHER_EXPECTED.registry;
const ENTRY_POINT = NETWORK.contracts.entryPointV06;
const PAYMASTER = getAddress(`0x${'7a'.repeat(20)}`);
const SPENDER = getAddress(`0x${'3c'.repeat(20)}`);
const NOW = 1_760_000_000_000;
const json = { 'content-type': 'application/json' };
const USDC = NETWORK.tokens.USDC.address;
const SEQ_MASK = 2n ** 64n - 1n;
/**
 * How far behind the head a block is final on the fake node, on either network: Base Sepolia's
 * confirmations, and the block the fake answers for Base's 'finalized' tag.
 */
const SETTLE_DEPTH = 3n;
/** How far behind the head Base's safe tag is: its batch is on L1 well before it is final. */
const SAFE_DEPTH = 1n;

// Agents (synthetic ids): A pays; A2 is the payer's other agent; B, C, D belong to person-2.
const AGENT_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const AGENT_A2 = '0a0a0a0a-0000-4000-8000-0000000000a2';
const AGENT_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const AGENT_C = '0c0c0c0c-0000-4000-8000-00000000000c';
const AGENT_D = '0d0d0d0d-0000-4000-8000-00000000000d';
/** person-2's vault owner key: a throwaway local account; its agents' wallets derive from it. */
const OWNER_2 = privateKeyToAccount(generatePrivateKey());
/** The stored recipe of a vault wallet (W1): [vault owner, SpendPermissionManager], agent index. */
const derivationOf = (owner: Address, agentId: string) => {
  const recipe = agentWalletRecipe(NETWORK, owner, accountIndexFor(agentId));
  return {
    version: 1,
    owners: recipe.owners,
    factory: recipe.factory,
    implementationVersion: 'test-impl-0001',
    accountIndex: recipe.index.toString(10),
  };
};
/** person-2's agents' vault wallets, as W1 derives them. */
const vaultWallet = (agentId: string) =>
  deriveAddressLocal(agentWalletRecipe(NETWORK, OWNER_2.address, accountIndexFor(agentId)));
const WALLET_B = vaultWallet(AGENT_B);
const WALLET_C = vaultWallet(AGENT_C);
const WALLET_D = vaultWallet(AGENT_D);
const OUTSIDE = getAddress(`0x${'5e'.repeat(20)}`);

const key = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const hash32 = (label: string) => keccak256(toHex(label));

/** Base as the pay service reads it: ownerOf per Base ID at the head block. */
function fakeBase() {
  const state = {
    head: 1000n,
    owners: new Map<string, Address>(),
    down: false,
    reads: [] as string[],
    log: [] as string[],
    /** Runs inside the next balance read (after the recipient was resolved, before its re-check). */
    duringBalances: null as null | (() => Promise<void>),
    /** Runs inside every ownerOf read (a slow read). */
    duringRead: null as null | (() => void),
    /** Another branch: the same heights carry other hashes (a block was dropped). */
    fork: 0,
  };
  const reader: PayChainReader = {
    registry: REGISTRY,
    chainId: CHAIN_ID,
    async ownerOf(baseId) {
      state.reads.push(baseId);
      state.log.push('ownerOf');
      if (state.down) throw new Error('node unreachable');
      state.duringRead?.();
      return {
        block: state.head,
        blockHash: hash32(`block-${state.head}${state.fork ? `-fork-${state.fork}` : ''}`),
        owner: state.owners.get(baseId) ?? null,
      };
    },
  };
  return { state, reader };
}

/**
 * The synthetic allowlist the port gets here, on the wallet network, in place of the pinned one
 * (production pins one paymaster on Base and none on Base Sepolia).
 */
const SPONSORS = { [CHAIN_ID]: [PAYMASTER] };
type SponsorAnswer = 'pinned' | 'token' | 'foreign' | 'short';
/**
 * paymasterAndData in the pinned verifying paymaster's layout (shared/base/paymasters.ts): 129
 * bytes of fields and a 65-byte signature; n makes each answer unique, as a real validity window.
 */
function sponsorData(answer: SponsorAnswer, n: number, at: number): Hex {
  const data = concat([
    answer === 'foreign' ? getAddress(`0x${'7b'.repeat(20)}`) : PAYMASTER,
    numberToHex(Math.floor((at + 60_000) / 1000), { size: 6 }),
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

const userOperationEvent = parseAbiItem(
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
);
const nonceAbi = parseAbi([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
]);
const wrapperAbi = [
  {
    type: 'tuple',
    components: [
      { name: 'ownerIndex', type: 'uint8' },
      { name: 'signatureData', type: 'bytes' },
    ],
  },
] as const;

/**
 * The owner-operations port as production builds it (chain/owner-ops.ts over the durable chain
 * path, the JSON-RPC bundler and the synthetic sponsor allowlist), on a fake wallet-network node and
 * a local bundler/paymaster stand-in that checks the nonce, deployment and the owner's signature
 * like the wallet. `prepares` records what the port was asked for.
 */
function fakeOperations(
  log: string[],
  db: Database,
  now: () => number,
  owners: Map<string, Address[]>,
) {
  const state = {
    head: 1000n,
    sponsor: true,
    /** What a paymaster that answers puts in paymasterAndData (sponsorData). */
    paymasterAnswer: 'pinned' as SponsorAnswer,
    paymasterCalls: 0,
    prepares: [] as Array<{ ownerFunded: boolean; to: string }>,
    code: new Set<string>([ENTRY_POINT.toLowerCase(), USDC.toLowerCase()]),
    /** Per sender and nonce key: the next sequence from each block on. */
    nonces: new Map<string, Array<{ block: bigint; next: bigint }>>(),
    pool: new Map<string, UserOperation<'0.6'>>(),
    landed: new Map<
      string,
      { txHash: Hex; blockNumber: bigint; sender: Address; nonce: bigint; success: boolean }
    >(),
    sends: [] as Hex[],
    /** How far behind the head Base's safe tag is now. */
    safeDepth: SAFE_DEPTH,
    /** The safe tag cannot be read. */
    safeDown: false,
    /** Transactions whose receipt now names another block hash than the canonical one. */
    reorged: new Set<string>(),
  };
  const blockHash = (n: bigint) => keccak256(toHex(`node-block-${n}`));
  const lane = (sender: string, key: bigint) => `${sender.toLowerCase()}:${key}`;
  /** The next sequence on a sender's lane, at a block (default: the head). */
  const seqAt = (sender: string, key: bigint, block?: bigint) => {
    let next = 0n;
    for (const entry of state.nonces.get(lane(sender, key)) ?? [])
      if (block === undefined || entry.block <= block) next = entry.next;
    return next;
  };
  const safeBlock = () => {
    if (state.safeDown) throw new Error('safe tag unreadable');
    const safe = state.head - state.safeDepth;
    return { number: safe, hash: blockHash(safe) };
  };
  const client = {
    getCode: async ({ address }: { address: string }) =>
      state.code.has(address.toLowerCase()) ? '0x6080' : undefined,
    readContract: async (call: {
      address: string;
      functionName: string;
      args: [string, bigint];
      blockNumber?: bigint;
    }) => {
      assert.equal(getAddress(call.address), ENTRY_POINT);
      assert.equal(call.functionName, 'getNonce');
      const [sender, laneKey] = call.args;
      return (laneKey << 64n) | seqAt(sender, laneKey, call.blockNumber);
    },
    getBlockNumber: async () => state.head,
    getBlock: async (args: { blockNumber?: bigint; blockTag?: string } = {}) =>
      args.blockNumber !== undefined
        ? { number: args.blockNumber, hash: blockHash(args.blockNumber) }
        : // Base reads finality from these tags (Base Sepolia counts confirmations instead).
          args.blockTag === 'finalized'
          ? { number: state.head - SETTLE_DEPTH, hash: blockHash(state.head - SETTLE_DEPTH) }
          : args.blockTag === 'safe'
            ? safeBlock()
            : { number: state.head, hash: blockHash(state.head), baseFeePerGas: 500_000n },
    getLogs: async (query: { args: { userOpHash: Hex }; fromBlock: bigint; toBlock: bigint }) => {
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
      const found = [...state.landed.entries()].find(([, hit]) => hit.txHash === hash);
      if (!found) throw new TransactionReceiptNotFoundError({ hash });
      const [userOpHash, hit] = found;
      return {
        transactionHash: hit.txHash,
        blockNumber: hit.blockNumber,
        blockHash: state.reorged.has(hit.txHash)
          ? keccak256(toHex(`other-block-${hit.blockNumber}`))
          : blockHash(hit.blockNumber),
        status: 'success',
        logs: [
          {
            address: ENTRY_POINT,
            topics: encodeEventTopics({
              abi: [userOperationEvent],
              eventName: 'UserOperationEvent',
              args: { userOpHash: userOpHash as Hex, sender: hit.sender, paymaster: PAYMASTER },
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
      if (method !== 'eth_call') throw new Error(`no ${method}`);
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
        result: (laneKey << 64n) | seqAt(sender, laneKey, block),
      });
    },
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 2_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    }),
  } as unknown as PublicClient;

  async function bundle(method: string, params: unknown[]): Promise<unknown> {
    log.push(`bundler:${method}`);
    if (method === 'pm_getPaymasterStubData') {
      if (!state.sponsor) throw new Error('sponsorship policy rejected the operation');
      return { paymasterAndData: sponsorData('pinned', 0, now()) };
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
      return { paymasterAndData: sponsorData(state.paymasterAnswer, state.paymasterCalls, now()) };
    }
    if (method === 'eth_getUserOperationReceipt') {
      const hit = state.landed.get(params[0] as string);
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
    if ((op.nonce & SEQ_MASK) !== seqAt(sender, op.nonce >> 64n))
      throw new Error('AA25 invalid account nonce');
    const deployed = state.code.has(sender);
    if ((op.initCode !== '0x') === deployed) throw new Error('AA10/AA20 deployment mismatch');
    // The wallet: SignatureWrapper{ownerIndex, signatureData}, ecrecover over the RAW hash.
    const [wrapper] = decodeAbiParameters(wrapperAbi, op.signature);
    const signer = await recoverAddress({ hash, signature: wrapper.signatureData });
    if (owners.get(sender)?.[wrapper.ownerIndex] !== signer)
      throw new Error('AA24 signature error');
    state.pool.set(hash, op);
    state.sends.push(hash);
    return hash;
  }

  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init.body));
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

  const bundler = rpcBundler({
    url: 'https://bundler.test/rpc/test-key-0001',
    entryPoint: ENTRY_POINT,
    chainId: CHAIN_ID,
    client,
    maxFeePerGasCap: 10n ** 12n,
    stubSignature: walletSignature(`0x${'ff'.repeat(64)}1c`, { ownerIndex: 0 }),
    fetch: fetchImpl,
  });
  const real = createOwnerOperationsPort({
    network: NETWORK,
    client,
    store: pgChainOperationStore(db, now),
    bundler,
    // A cost cap, as production requires on Base.
    maxCostWeiCap: 10n ** 18n,
    sponsors: SPONSORS,
    now,
  });
  // The real port; this only records what it was asked to prepare.
  const port: OwnerOperationsPort = {
    ...real,
    chainId: real.chainId,
    entryPoint: real.entryPoint,
    prepare(input) {
      log.push('prepare');
      state.prepares.push({ ownerFunded: input.ownerFunded === true, to: input.calls[0].target });
      return real.prepare(input);
    },
  };

  /** What each landed operation carried, so a dropped block can put it back in the pool. */
  const mined = new Map<string, UserOperation<'0.6'>>();
  /**
   * Puts a sent operation into the next block (reverted when success is false), or into the head
   * block itself (several operations in one block).
   */
  function include(userOpHash: string, success: boolean, sameBlock = false) {
    const op = state.pool.get(userOpHash);
    assert.ok(op, 'the operation was sent');
    mined.set(userOpHash, op);
    if (!sameBlock) state.head += 1n;
    const sender = op.sender.toLowerCase();
    const history = state.nonces.get(lane(sender, op.nonce >> 64n)) ?? [];
    history.push({ block: state.head, next: (op.nonce & SEQ_MASK) + 1n });
    state.nonces.set(lane(sender, op.nonce >> 64n), history);
    if (op.initCode && op.initCode !== '0x') state.code.add(sender);
    state.landed.set(userOpHash, {
      txHash: keccak256(concat([userOpHash as Hex, '0x01'])),
      blockNumber: state.head,
      sender: getAddress(op.sender),
      nonce: op.nonce,
      success,
    });
    state.pool.delete(userOpHash);
  }
  /** The operation lands ('included'), then gets its confirmations ('final'); it may revert. */
  const land = (userOpHash: string, status: 'included' | 'final', success = true) => {
    if (!state.landed.has(userOpHash)) include(userOpHash, success);
    if (status === 'final') state.head += SETTLE_DEPTH;
  };
  const txOf = (userOpHash: string) => state.landed.get(userOpHash)!.txHash;
  /** New empty blocks on top of the head. */
  const mine = (n: number) => {
    state.head += BigInt(n);
  };
  /** Base drops the block that carried it: the operation is back in the pool, its nonce unused. */
  function uninclude(userOpHash: string) {
    const hit = state.landed.get(userOpHash);
    const op = mined.get(userOpHash);
    assert.ok(hit && op, 'the operation landed');
    state.landed.delete(userOpHash);
    const key = lane(op.sender, op.nonce >> 64n);
    state.nonces.set(
      key,
      (state.nonces.get(key) ?? []).filter((entry) => entry.block !== hit.blockNumber),
    );
    state.pool.set(userOpHash, op);
  }
  return { state, port, land, include, mine, uninclude, txOf };
}

interface Options {
  env?: Record<string, string | undefined>;
  noChain?: boolean;
  limit?: (key: string, max: number, windowMs: number) => Promise<void>;
}

async function setup(t: { after: (fn: () => Promise<unknown>) => void }, options: Options = {}) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('person-1','owner'), ('person-2','owner'), ('person-3','owner'),
      ('ai-1','ai');
    CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL);
    INSERT INTO workspaces VALUES ('person-1', '{"agents": []}'), ('person-2', '{"agents": []}');
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);`);
  for (const sql of [
    BASE_MIGRATION_SQL,
    BASE_PAYMENTS_MIGRATION_SQL,
    baseShortIdsMigration.sql,
    BASE_SHARED_ADDITIONS_SQL,
    BASE_IDENTITY_PROVISIONAL_SQL,
    BASE_WALLET_VAULT_SQL,
    BASE_WALLET_WITHDRAWALS_SQL,
    // Spending-limit revokes (90): a live one that deploys the wallet holds the deployment.
    BASE_WALLET_LIMITS_SQL,
    BASE_WALLET_PAYMENTS_SQL,
    // Ratings share the withdrawals table (94); a payment's withdrawal is kind 'withdraw'.
    BASE_WALLET_RATINGS_SQL,
    // One unsigned owner operation per wallet; included ones are decided by the safe head (93).
    BASE_WALLET_ONE_UNSIGNED_SQL,
    // Pay without waiting: an operation's own nonce lane, unique per wallet (95).
    BASE_WALLET_LANES_SQL,
    // The recipient's safe notice (96).
    BASE_WALLET_WITHDRAWALS_SAFE_SQL,
    // The sponsor's exposure in flight (97; independent of 96).
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
  const base = fakeBase();
  const signers = new Map<string, Address[]>();
  const ops = fakeOperations(base.state.log, db, () => clock.now, signers);
  const owner = privateKeyToAccount(generatePrivateKey());
  await pg.query(
    `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key, kdf_params,
       cipher_params, version, backup_confirmed_at, created_at, updated_at)
     VALUES ('person-1', $1, decode($2, 'hex'), '{}', '{}', 1, $3, 1, 1),
            ('person-2', $4, decode($2, 'hex'), '{}', '{}', 1, $3, 1, 1)`,
    [owner.address, '5a'.repeat(48), NOW - 1_000, OWNER_2.address],
  );
  // The payer's agents: owner-vault wallets on the wallet network, as W1 creates them.
  const wallets: Record<string, Address> = {};
  for (const agentId of [AGENT_A, AGENT_A2]) {
    const recipe = agentWalletRecipe(NETWORK, owner.address, accountIndexFor(agentId));
    wallets[agentId] = deriveAddressLocal(recipe);
    signers.set(wallets[agentId].toLowerCase(), recipe.owners);
    await wallet(db, {
      agentId,
      workspace: 'person-1',
      address: wallets[agentId],
      ownerAddress: owner.address,
      ownerAccount: 'person-1',
      derivation: {
        version: 1,
        owners: recipe.owners,
        factory: recipe.factory,
        implementationVersion: 'test-impl-0001',
        accountIndex: recipe.index.toString(10),
      },
    });
  }
  await manifest(db, AGENT_A, 'person-1', 'Harbor');
  await manifest(db, AGENT_A2, 'person-1', 'Harbor Two');
  const balances: BalanceReader = {
    balances: async () => {
      base.state.log.push('balances');
      const during = base.state.duringBalances;
      base.state.duringBalances = null;
      await during?.();
      return { usdc: 5_000_000n, eth: 10n ** 15n, deployed: true, blockNumber: base.state.head };
    },
  };
  const runtime: ChainRuntime = {
    walletPort: {} as ChainRuntime['walletPort'],
    identityPort: {} as ChainRuntime['identityPort'],
    ownerOperations: ops.port,
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
    runtime: async () => runtime,
    balances,
    payChain: options.noChain ? undefined : base.reader,
    limit: options.limit,
    now: () => clock.now,
  });
  return { app, pg, db, clock, base, ops, owner, wallets };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function manifest(db: Database, agentId: string, workspace: string, name: string) {
  await db.query(`INSERT INTO agent_manifests VALUES ($1, $2, 1, $3)`, [
    agentId,
    workspace,
    JSON.stringify({ metadata: { displayName: name }, spec: { visibility: 'public' } }),
  ]);
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', (data->'agents') || $1::jsonb)
     WHERE operator_id = $2`,
    [JSON.stringify([{ id: agentId, revision: 1, revokedAt: null }]), workspace],
  );
}

async function wallet(
  db: Database,
  w: {
    agentId: string;
    workspace: string;
    address: string;
    chainId?: number;
    ownerAddress?: string;
    ownerAccount?: string | null;
    derivation?: unknown;
    walletId?: string;
  },
) {
  await db.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at, owner_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'v1:00000000-0000-4000-8000-000000000000', $8, 'derived',
       1, 1, $9)`,
    [
      w.walletId ?? `wallet-${w.agentId}-${w.chainId ?? CHAIN_ID}`,
      w.agentId,
      w.workspace,
      w.chainId ?? CHAIN_ID,
      w.address,
      w.ownerAddress ?? getAddress(`0x${'2e'.repeat(20)}`),
      SPENDER,
      JSON.stringify(w.derivation ?? {}),
      w.ownerAccount ?? null,
    ],
  );
}

/** A registration as the identity service leaves it (confirmed unless said otherwise). */
async function register(
  f: Fixture,
  r: {
    agentId: string;
    baseId: string;
    short: string;
    wallet?: string;
    workspace?: string;
    name?: string;
    chainId?: number;
    registry?: string;
    state?: 'confirmed' | 'submitted';
    newWallet?: boolean;
    onChain?: boolean;
    /** The wallet's owner vault account; null: a wallet from before the vault (identity only). */
    ownerAccount?: string | null;
  },
) {
  const chainId = r.chainId ?? CHAIN_ID;
  const workspace = r.workspace ?? 'person-2';
  if (r.newWallet !== false) {
    await wallet(f.db, {
      agentId: r.agentId,
      workspace,
      address: r.wallet!,
      chainId,
      ownerAccount: r.ownerAccount === undefined ? workspace : r.ownerAccount,
      // A vault wallet of person-2, as W1 creates it (ready when the address is the derived one).
      ownerAddress: OWNER_2.address,
      derivation: derivationOf(OWNER_2.address, r.agentId),
    });
    await manifest(f.db, r.agentId, workspace, r.name ?? `Agent ${r.baseId}`);
  }
  await f.db.query('INSERT INTO base_short_ids VALUES ($1, $2, 1)', [r.short, r.agentId]);
  const confirmed = (r.state ?? 'confirmed') === 'confirmed';
  await f.db.query(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
       erc8004_agent_id, agent_card_uri, owner_of_identity, state, op_id, updated_at,
       register_op_id, mint_op_id, provisional_agent_id, mint_seen_at, mint_finality,
       transfer_op_id, handover_id, handover_finality, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $10, $11, 1, 'final', $9, $11, $12, 1)`,
    [
      r.agentId,
      chainId,
      workspace,
      r.registry ?? (chainId === CHAIN_ID ? REGISTRY : OTHER_REGISTRY),
      confirmed ? r.baseId : null,
      `${AGENT_URI_ORIGIN}/a/${r.short}`,
      r.wallet ?? f.wallets[r.agentId],
      confirmed ? 'confirmed' : 'submitted',
      `identity:transfer:${chainId}:${r.agentId}~${r.baseId}`,
      `identity:register:${chainId}:${r.agentId}`,
      r.baseId,
      confirmed ? 'final' : 'safe',
    ],
  );
  if (r.onChain !== false && chainId === CHAIN_ID)
    f.base.state.owners.set(r.baseId, getAddress(r.wallet ?? f.wallets[r.agentId]));
}

/** Juno (person-2's agent B): Base ID 501, passport CC-Juno01. */
const juno = (f: Fixture) =>
  register(f, { agentId: AGENT_B, baseId: '501', short: 'Juno01', wallet: WALLET_B, name: 'Juno' });

const as = (person?: string, workspace?: string) => ({
  ...json,
  ...(person ? { 'x-test-person': person } : {}),
  ...(workspace ? { 'x-city-workspace': workspace } : {}),
});

const lookup = (f: Fixture, q: string, person = 'person-3') =>
  f.app.inject({
    url: `/api/base/pay/recipient?q=${encodeURIComponent(q)}`,
    headers: as(person),
  });

/** The lookupId of what `q` names, looked up by `person` (the payer, person-1, by default). */
async function lookedUp(f: Fixture, q = '501', person = 'person-1'): Promise<string> {
  const res = await lookup(f, q, person);
  assert.equal(res.statusCode, 200, res.body);
  return res.json().lookupId as string;
}

/** POST a payment; without a `to`, Juno as person-1 just looked it up. */
async function pay(
  f: Fixture,
  payload: Record<string, unknown>,
  opts: { person?: string; agent?: string } = {},
) {
  const body = 'to' in payload ? payload : { ...payload, to: { lookupId: await lookedUp(f) } };
  return f.app.inject({
    method: 'POST',
    url: `/api/base/agents/${opts.agent ?? AGENT_A}/wallet/payments`,
    headers: as(opts.person ?? 'person-1'),
    payload: JSON.stringify(body),
  });
}

const payBody = (n: number, overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: key(n),
  amount: '2500000',
  ...overrides,
});

/** The payer signs a prepared payment over its raw hash (the browser vault does this). */
async function sign(f: Fixture, body: { withdrawalId: string; userOpHash: Hex }, agent = AGENT_A) {
  const res = await f.app.inject({
    method: 'POST',
    url: `${withdrawalPath(body.withdrawalId, agent)}/signature`,
    headers: as('person-1'),
    payload: JSON.stringify({ signature: await f.owner.sign({ hash: body.userOpHash }) }),
  });
  assert.equal(res.statusCode, 202, res.body);
  return res;
}

const withdrawalPath = (id: string, agent = AGENT_A) =>
  `/api/base/agents/${agent}/wallet/withdrawals/${id}`;

const incoming = (f: Fixture, person: string, query = '') =>
  f.app.inject({ url: `/api/base/pay/incoming${query}`, headers: as(person) });

interface Notice {
  paymentId: string;
  state: string;
  text: string;
  note: string | null;
  finalAt: number | null;
  safe: boolean;
  from: { baseId: string | null };
  to: { wallet: string };
  amount: Record<string, unknown>;
}

/** The payments of one incoming page (the first, unless a query says otherwise). */
async function notices(f: Fixture, person: string, query = ''): Promise<Notice[]> {
  const res = await incoming(f, person, query);
  assert.equal(res.statusCode, 200, res.body);
  return res.json().payments as Notice[];
}

async function rows(f: Fixture, table: string) {
  return (await f.pg.query<Record<string, unknown>>(`SELECT * FROM ${table}`)).rows;
}

/** The sponsor's most expensive gas for an operation as prepared (EntryPoint v0.6, a paymaster). */
const sponsorBound = (op: RpcUserOperation) => {
  const parsed = userOperationFromRpc(op);
  return (
    (parsed.callGasLimit + parsed.verificationGasLimit * 3n + parsed.preVerificationGas) *
    parsed.maxFeePerGas
  );
};

interface Created {
  withdrawalId: string;
  state: string;
  userOperation: RpcUserOperation;
  userOpHash: Hex;
  chainId: number;
  summary: Record<string, unknown>;
  payment: {
    paymentId: string;
    note: string | null;
    recipient: Record<string, unknown> & {
      verified?: { block: number; blockHash: string; at: number };
    };
    lookupId: string | null;
    issued: { block: number; blockHash: string; expiresAt: number } | null;
  };
}

// --- parsing ----------------------------------------------------------------------------------

test('parsing: every accepted form, nothing else, and never a fetch', async (t) => {
  const fetchCalls: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: unknown[]) => {
    fetchCalls.push(args);
    throw new Error('no network in this test');
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const checksummed = getAddress(`0x${'ab'.repeat(20)}`);
  assert.deepEqual(parseRecipient('501'), [{ kind: 'baseId', baseId: '501' }]);
  assert.deepEqual(parseRecipient('  501\n'), [{ kind: 'baseId', baseId: '501' }]);
  assert.deepEqual(parseRecipient('0'), [{ kind: 'baseId', baseId: '0' }]);
  for (const link of [
    'https://centralcity.ai/a/Juno01',
    'centralcity.ai/a/Juno01',
    'HTTPS://CentralCity.AI/a/Juno01',
    '\thttps://centralcity.ai/a/Juno01 ',
    'Juno01',
    'CC-Juno01',
    ' CC-Juno01\n',
  ])
    assert.deepEqual(parseRecipient(link), [{ kind: 'short', short: 'Juno01' }], link);
  // CC-<short> is the short-id reading alone, never also a Base ID (unlike a bare all-digit short).
  assert.deepEqual(parseRecipient('CC-123456'), [{ kind: 'short', short: '123456' }]);
  assert.deepEqual(parseRecipient('CC-juno01'), [{ kind: 'short', short: 'juno01' }]);
  // A short id is case-sensitive: another case is another passport.
  assert.deepEqual(parseRecipient('juno01'), [{ kind: 'short', short: 'juno01' }]);
  // Six digits read both ways; a leading zero is never a canonical Base ID.
  assert.deepEqual(parseRecipient('123456'), [
    { kind: 'baseId', baseId: '123456' },
    { kind: 'short', short: '123456' },
  ]);
  assert.deepEqual(parseRecipient('012345'), [{ kind: 'short', short: '012345' }]);
  assert.deepEqual(parseRecipient(checksummed.toLowerCase()), [
    { kind: 'address', address: checksummed },
  ]);
  assert.deepEqual(parseRecipient(` ${checksummed} `), [{ kind: 'address', address: checksummed }]);
  const flipped = checksummed.replace(/[a-f]/, (c) => c.toUpperCase());
  for (const refused of [
    'https://evil.example/a/Juno01',
    'https://centralcity.ai.evil.example/a/Juno01',
    'https://www.centralcity.ai/a/Juno01',
    'https://user@centralcity.ai/a/Juno01',
    'https://centralcity.ai:443/a/Juno01',
    'http://centralcity.ai/a/Juno01',
    'ftp://centralcity.ai/a/Juno01',
    '//centralcity.ai/a/Juno01',
    'https://centralcity.ai/a/Juno01/',
    'https://centralcity.ai/a/Juno01?x=1',
    'https://centralcity.ai/a/Juno01#top',
    'https://centralcity.ai/A/Juno01',
    'https://centralcity.ai/agents/Juno01',
    'https://centralcity.ai/a/Juno0',
    'https://centralcity.ai/a/Juno012',
    'Juno 01',
    'Juno0',
    'Juno012',
    'CC-Juno0',
    'CC Juno01',
    'cc-Juno01',
    'Cc-Juno01',
    'CC-CC-Juno01',
    'CC-https://centralcity.ai/a/Juno01',
    'CC-501',
    'CC-Juno01x',
    'CC-Juno01/',
    '0501',
    '-1',
    '1e3',
    '#501',
    flipped,
    `0X${checksummed.slice(2)}`,
    checksummed.slice(0, 41),
    'vitalik.eth',
    '',
    '   ',
    'x'.repeat(200),
  ])
    assert.deepEqual(parseRecipient(refused), [], refused);
  assert.equal(PAY_PASSPORT_HOST, new URL(SHORT_URI_ORIGIN).host);

  // Through the route: an arbitrary link is refused before any lookup or read.
  const f = await setup(t);
  await juno(f);
  for (const q of ['https://evil.example/a/Juno01', 'https://centralcity.ai/a/Juno01/x']) {
    const res = await lookup(f, q);
    assert.equal(res.statusCode, 400, q);
    assert.equal(res.json().code, 'invalid_query');
  }
  const long = await lookup(f, `https://centralcity.ai/a/${'J'.repeat(200)}`);
  assert.equal(long.statusCode, 400);
  assert.equal(f.base.state.reads.length, 0, 'Base was never read');
  assert.equal(fetchCalls.length, 0, 'nothing was fetched');
});

// --- lookup -----------------------------------------------------------------------------------

test('lookup: each form names the same agent, verified at one block with evidence and expiry', async (t) => {
  const f = await setup(t);
  await juno(f);
  const expected = {
    kind: 'central_city_agent',
    baseId: '501',
    short: 'Juno01',
    name: 'Juno',
    wallet: WALLET_B,
    registry: REGISTRY,
    chainId: CHAIN_ID,
    verification: 'point_in_time',
    // One lookup per account, recipient and block: every form answers the same one.
    lookupId: (await lookup(f, '501')).json().lookupId,
    verified: { block: 1000, blockHash: hash32('block-1000'), at: NOW },
    expiresAt: NOW + PAY_RECIPIENT_TTL_MS,
  };
  assert.match(expected.lookupId, /^pl_[0-9A-Za-z_-]{32}$/);
  assert.equal(PAY_RECIPIENT_TTL_MS, 5 * 60_000);
  for (const q of [
    '501',
    ' 501 ',
    'https://centralcity.ai/a/Juno01',
    'centralcity.ai/a/Juno01',
    'HTTPS://CENTRALCITY.AI/a/Juno01',
    'Juno01',
    'CC-Juno01',
    WALLET_B,
    WALLET_B.toLowerCase(),
  ]) {
    const res = await lookup(f, q);
    assert.equal(res.statusCode, 200, `${q}: ${res.body}`);
    assert.deepEqual(res.json(), expected, q);
  }
  // Every answer is its own fresh read of Base, never a cached one.
  assert.equal(f.base.state.reads.length, 10);
  assert.ok(f.base.state.reads.every((id) => id === '501'));
  f.base.state.head = 1007n;
  f.clock.now += 1_000;
  const later = (await lookup(f, '501')).json();
  assert.deepEqual(later.verified, {
    block: 1007,
    blockHash: hash32('block-1007'),
    at: NOW + 1_000,
  });
  assert.equal(later.expiresAt, NOW + 1_000 + PAY_RECIPIENT_TTL_MS);
  assert.notEqual(later.lookupId, expected.lookupId, 'another block, another lookup');
  // The short id is case-sensitive; any signed-in person may look up, nobody signed out.
  assert.equal((await lookup(f, 'juno01')).statusCode, 404);
  assert.equal((await lookup(f, '501', 'person-1')).statusCode, 200);
  const anonymous = await f.app.inject({ url: '/api/base/pay/recipient?q=501', headers: json });
  assert.equal(anonymous.statusCode, 401);
  assert.equal((await lookup(f, '501', 'ai-1')).statusCode, 404);
  const extra = await f.app.inject({
    url: `/api/base/pay/recipient?q=501&chainId=${OTHER_EXPECTED.chainId}`,
    headers: as('person-1'),
  });
  assert.equal(extra.statusCode, 400);
});

test('lookup: only confirmed registrations of the wallet network canonical registry, held on Base', async (t) => {
  const f = await setup(t);
  await juno(f);
  // A registration still finalizing, one on the other network, one in the other network's registry:
  // none can be paid here.
  await register(f, {
    agentId: AGENT_C,
    baseId: '502',
    short: 'Final1',
    wallet: WALLET_C,
    state: 'submitted',
  });
  await register(f, {
    agentId: AGENT_D,
    baseId: '503',
    short: 'Else01',
    wallet: WALLET_D,
    chainId: OTHER_EXPECTED.chainId,
  });
  const other = '0e0e0e0e-0000-4000-8000-00000000000e';
  await register(f, {
    agentId: other,
    baseId: '504',
    short: 'Other1',
    wallet: getAddress(`0x${'e1'.repeat(20)}`),
    registry: OTHER_REGISTRY,
  });
  for (const q of ['502', 'Final1', '503', 'Else01', '504', 'Other1', '999']) {
    const res = await lookup(f, q);
    assert.equal(res.statusCode, 404, q);
    assert.equal(res.json().code, 'not_found');
  }
  // Base says someone else holds the id now: not verified, not payable.
  f.base.state.owners.set('501', OUTSIDE);
  const moved = await lookup(f, '501');
  assert.equal(moved.statusCode, 404);
  assert.match(moved.json().error, /not held by/);
  f.base.state.owners.delete('501');
  assert.equal((await lookup(f, '501')).statusCode, 404, 'ownerOf reverts: no owner');
  // Base unreachable: never "verified" without a fresh read.
  f.base.state.owners.set('501', WALLET_B);
  f.base.state.down = true;
  const down = await lookup(f, '501');
  assert.equal(down.statusCode, 503);
  assert.equal(down.json().code, 'chain_unavailable');
  assert.equal(down.json().verified, undefined);
});

test('lookup without a Base endpoint is 503 for an agent, never verified', async (t) => {
  const f = await setup(t, { noChain: true });
  await juno(f);
  const res = await lookup(f, 'CC-Juno01');
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, 'chain_unavailable');
});

test('a registration on Base mainnet, in its canonical registry, is a recipient exactly when Base is the wallet network', async (t) => {
  const f = await setup(t);
  const MAINNET_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
  // Base mainnet, its canonical registry, a ready vault wallet there, its passport link.
  await register(f, {
    agentId: AGENT_B,
    baseId: '424242',
    short: 'Live01',
    wallet: WALLET_B,
    name: 'Juno',
    chainId: BASE_MAINNET,
    registry: MAINNET_REGISTRY,
  });
  // Base (the local mock) says that wallet holds the Base ID.
  f.base.state.owners.set('424242', WALLET_B);
  const res = await lookup(f, 'CC-Live01', 'person-1');
  if (CHAIN_ID !== BASE_MAINNET) {
    // Another network's records never name a recipient here, and Base is not even read.
    assert.equal(res.statusCode, 404, res.body);
    assert.deepEqual(f.base.state.reads, []);
    return;
  }
  assert.equal(res.statusCode, 200, res.body);
  const looked = res.json();
  assert.deepEqual(
    { ...looked, lookupId: undefined },
    {
      kind: 'central_city_agent',
      baseId: '424242',
      short: 'Live01',
      name: 'Juno',
      wallet: WALLET_B,
      registry: MAINNET_REGISTRY,
      chainId: 8453,
      verification: 'point_in_time',
      lookupId: undefined,
      verified: { block: 1000, blockHash: hash32('block-1000'), at: NOW },
      expiresAt: NOW + PAY_RECIPIENT_TTL_MS,
    },
  );
  // And it is paid: checked on Base again, prepared for the owner to sign, on Base.
  const paid = await pay(f, payBody(1, { to: { lookupId: looked.lookupId } }));
  assert.equal(paid.statusCode, 201, paid.body);
  const body = paid.json() as Created;
  assert.equal(body.chainId, 8453);
  assert.equal(body.summary.to, WALLET_B);
  assert.equal(body.payment.recipient.registry, MAINNET_REGISTRY);
  assert.deepEqual(f.base.state.reads, ['424242', '424242']);
  const [stored] = await rows(f, 'base_wallet_payments');
  assert.equal(Number(stored.chain_id), 8453);
  assert.equal(stored.registry_address, MAINNET_REGISTRY);
});

test('CC-<short> is only an alias of <short>: byte-identical answers through the same path', async (t) => {
  const f = await setup(t);
  await juno(f);
  const forms = [
    'Juno01',
    'CC-Juno01',
    'https://centralcity.ai/a/Juno01',
    'centralcity.ai/a/Juno01',
  ];
  const bodies: string[] = [];
  for (const q of forms) {
    const res = await lookup(f, q);
    assert.equal(res.statusCode, 200, `${q}: ${res.body}`);
    bodies.push(res.body);
  }
  // Byte for byte the same answer: the same Base ID, wallet, block and evidence.
  for (const [i, body] of bodies.entries()) assert.equal(body, bodies[0], forms[i]);
  // One read each, of the same Base ID: the same records and the same check on Base.
  assert.deepEqual(f.base.state.reads, ['501', '501', '501', '501']);
  // The answer never says which form was typed, and carries no passport-number field of its own.
  assert.doesNotMatch(bodies[0], /CC-/);
  // The alias of an unknown or differently-cased short id is just as unknown.
  for (const q of ['CC-Nope01', 'CC-juno01']) {
    const res = await lookup(f, q);
    assert.equal(res.statusCode, 404, q);
    assert.equal(res.json().code, 'not_found');
  }
  // The same lookup, so a payment from the alias's answer is the very same payment as from the
  // short id's; the payer's own lookups through either form are one lookup too.
  assert.equal((await rows(f, 'base_pay_lookups')).length, 1);
  const viaAlias = await lookedUp(f, 'CC-Juno01');
  assert.equal(await lookedUp(f, 'Juno01'), viaAlias);
  const fromAlias = await pay(f, payBody(1, { to: { lookupId: viaAlias } }));
  assert.equal(fromAlias.statusCode, 201, fromAlias.body);
  const fromShort = await pay(f, payBody(1, { to: { lookupId: await lookedUp(f, 'Juno01') } }));
  assert.equal(fromShort.statusCode, 201, fromShort.body);
  assert.equal(fromShort.json().withdrawalId, fromAlias.json().withdrawalId);
  assert.equal((await rows(f, 'base_wallet_payments')).length, 1);
  // An all-digit short id: CC-<short> and the link are the one short reading, identical answers;
  // the bare form also reads as a Base ID, so with both registered it is ambiguous.
  await register(f, { agentId: AGENT_C, baseId: '123456', short: 'Cccc01', wallet: WALLET_C });
  await register(f, { agentId: AGENT_D, baseId: '777000', short: '123456', wallet: WALLET_D });
  const alias = await lookup(f, 'CC-123456');
  const link = await lookup(f, 'centralcity.ai/a/123456');
  assert.equal(alias.statusCode, 200);
  assert.equal(alias.body, link.body);
  assert.equal(alias.json().baseId, '777000');
  assert.equal((await lookup(f, '123456')).json().code, 'ambiguous_query');
});

test('six digits: a Base ID or a short id, answered only when exactly one is an agent', async (t) => {
  const f = await setup(t);
  await register(f, { agentId: AGENT_C, baseId: '123456', short: 'Cccc01', wallet: WALLET_C });
  const only = await lookup(f, '123456');
  assert.equal(only.statusCode, 200);
  assert.equal(only.json().baseId, '123456');
  await register(f, { agentId: AGENT_D, baseId: '777000', short: '123456', wallet: WALLET_D });
  const both = await lookup(f, '123456');
  assert.equal(both.statusCode, 400);
  assert.equal(both.json().code, 'ambiguous_query');
  // The passport link is never ambiguous.
  const link = await lookup(f, 'centralcity.ai/a/123456');
  assert.equal(link.json().baseId, '777000');
});

test('an address names a Central City agent only when exactly one agent wallet is it', async (t) => {
  const f = await setup(t, { env: { CITY_BASE_WALLET: '1' } });
  await juno(f);
  // Two wallet rows of one address in different letter case (the unique key is case-sensitive),
  // both registered: not unambiguous, so not a Central City agent.
  await register(f, { agentId: AGENT_C, baseId: '601', short: 'Twin01', wallet: WALLET_C });
  await register(f, {
    agentId: AGENT_D,
    baseId: '602',
    short: 'Twin02',
    wallet: WALLET_C.toLowerCase(),
  });
  const twin = await lookup(f, WALLET_C);
  assert.equal(twin.statusCode, 422);
  assert.equal(twin.json().code, 'not_central_city_agent');
  assert.match(twin.json().error, /Use Withdraw for other addresses/);
  // One agent's wallet whose Base ID moved elsewhere on Base: not that agent any more.
  f.base.state.owners.set('501', OUTSIDE);
  assert.equal((await lookup(f, WALLET_B)).json().code, 'not_central_city_agent');
  // An address of nothing we know.
  assert.equal((await lookup(f, OUTSIDE)).statusCode, 422);
});

test('any other address only with CITY_BASE_PAY_ANY_ADDRESS exactly 1: a warning kind', async (t) => {
  for (const value of [undefined, '', '0', 'true', 'yes', ' 1', '1 ']) {
    const f = await setup(t, { env: { CITY_BASE_WALLET: '1', CITY_BASE_PAY_ANY_ADDRESS: value } });
    const res = await lookup(f, OUTSIDE);
    assert.equal(res.statusCode, 422, String(value));
    assert.equal(res.json().code, 'not_central_city_agent');
  }
  const f = await setup(t, { env: { CITY_BASE_WALLET: '1', CITY_BASE_PAY_ANY_ADDRESS: '1' } });
  await juno(f);
  const res = await lookup(f, OUTSIDE.toLowerCase());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    kind: 'address',
    address: OUTSIDE,
    verification: 'none',
    warning: 'not_central_city_agent',
  });
  // An agent's wallet is still the agent, verified, with the setting on.
  assert.equal((await lookup(f, WALLET_B)).json().kind, 'central_city_agent');
});

// --- paying -----------------------------------------------------------------------------------

test('a payment: the lookup it names, re-checked right before prepare, signed, final, noticed', async (t) => {
  const f = await setup(t);
  await juno(f);
  await register(f, {
    agentId: AGENT_A,
    baseId: '777',
    short: 'Harb01',
    wallet: f.wallets[AGENT_A],
    workspace: 'person-1',
    newWallet: false,
  });
  const looked = (await lookup(f, 'CC-Juno01', 'person-1')).json();
  assert.match(looked.lookupId, /^pl_[0-9A-Za-z_-]{32}$/);
  f.base.state.log.length = 0;
  f.base.state.head = 1003n;
  f.clock.now += 2_000;
  const res = await pay(
    f,
    payBody(1, { to: { lookupId: looked.lookupId }, note: ' for the logo ' }),
  );
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as Created;
  // The withdrawal shape, to the lookup's wallet, USDC, sponsored.
  assert.equal(body.state, 'awaiting_signature');
  assert.equal(body.chainId, CHAIN_ID);
  assert.equal(body.summary.to, WALLET_B);
  assert.equal(body.summary.token, 'USDC');
  assert.deepEqual(body.summary.amount, { raw: '2500000', decimals: 6, display: '2.5' });
  assert.equal(body.summary.sponsored, true);
  // The recipient as the lookup shapes it, with the fresh check made for this payment.
  assert.deepEqual(body.payment.recipient, {
    kind: 'central_city_agent',
    baseId: '501',
    short: 'Juno01',
    name: 'Juno',
    wallet: WALLET_B,
    registry: REGISTRY,
    chainId: CHAIN_ID,
    verification: 'point_in_time',
    lookupId: looked.lookupId,
    verified: { block: 1003, blockHash: hash32('block-1003'), at: NOW + 2_000 },
    expiresAt: NOW + PAY_RECIPIENT_TTL_MS,
  });
  // What the person confirmed: the lookup, as the server issued and kept it.
  assert.equal(body.payment.lookupId, looked.lookupId);
  assert.deepEqual(body.payment.issued, {
    block: 1000,
    blockHash: hash32('block-1000'),
    expiresAt: NOW + PAY_RECIPIENT_TTL_MS,
  });
  assert.equal(body.payment.note, 'for the logo');
  // Base is read after every other check and right before the operation is prepared.
  assert.deepEqual(f.base.state.log.slice(0, 3), ['balances', 'ownerOf', 'prepare']);
  assert.ok(f.base.state.log.slice(3).every((step) => step.startsWith('bundler:')));
  assert.ok(f.base.state.log.includes('bundler:pm_getPaymasterData'), 'sponsored');
  assert.deepEqual(f.ops.state.prepares, [{ ownerFunded: false, to: NETWORK.tokens.USDC.address }]);
  const [stored] = await rows(f, 'base_wallet_payments');
  assert.equal(stored.withdrawal_id, body.withdrawalId);
  assert.equal(stored.payment_id, body.payment.paymentId);
  assert.equal(stored.sender_agent_id, AGENT_A);
  assert.equal(stored.recipient_kind, 'central_city_agent');
  assert.equal(stored.recipient_agent_id, AGENT_B);
  assert.equal(stored.recipient_address, WALLET_B);
  assert.equal(String(stored.recipient_base_id), '501');
  assert.equal(stored.lookup_id, looked.lookupId);
  assert.equal(String(stored.issued_block), '1000');
  assert.equal(stored.issued_block_hash, hash32('block-1000'));
  assert.equal(Number(stored.issued_expires_at), NOW + PAY_RECIPIENT_TTL_MS);
  assert.equal(String(stored.verified_block), '1003');
  assert.equal(stored.verified_block_hash, hash32('block-1003'));
  assert.equal(stored.final_at, null);
  // No column holds anything the browser sent back as evidence.
  assert.ok(!Object.keys(stored).some((column) => column.startsWith('confirmed_')));
  // Not signed yet: nothing was sent, so the recipient's owner sees nothing.
  assert.deepEqual(await notices(f, 'person-2'), []);

  // Signing, status and cancel are the withdrawal routes of its withdrawal id.
  const signed = await sign(f, body);
  assert.equal(signed.json().state, 'submitted');
  // Sent: the recipient's owner sees it at once, as pending, never as paid, without the note.
  const notice = {
    paymentId: body.payment.paymentId,
    withdrawalId: body.withdrawalId,
    from: { name: 'Harbor', baseId: '777', short: 'Harb01', wallet: f.wallets[AGENT_A] },
    to: { agentId: AGENT_B, name: 'Juno', baseId: '501', short: 'Juno01', wallet: WALLET_B },
    token: 'USDC',
    amount: { raw: '2500000', decimals: 6, display: '2.5' },
    sentAt: NOW + 2_000,
  };
  assert.deepEqual(await notices(f, 'person-2'), [
    {
      ...notice,
      state: 'pending',
      note: null,
      text: 'Harbor is sending Juno 2.5 USDC',
      txHash: null,
      explorerUrl: null,
      updatedAt: NOW + 2_000,
      finalAt: null,
      safe: false,
    },
  ]);
  f.ops.land(body.userOpHash, 'included');
  const included = await f.app.inject({
    url: withdrawalPath(body.withdrawalId),
    headers: as('person-1'),
  });
  assert.equal(included.json().state, 'included');
  assert.equal((await rows(f, 'base_wallet_payments'))[0].final_at, null);
  const txHash = f.ops.txOf(body.userOpHash);
  // In a block, not final: still on its way, still not "paid", still no note.
  assert.deepEqual(await notices(f, 'person-2'), [
    {
      ...notice,
      state: 'included',
      note: null,
      text: 'Harbor is sending Juno 2.5 USDC',
      txHash,
      explorerUrl: `${WALLET_EXPECTED.explorer}/tx/${txHash}`,
      updatedAt: NOW + 2_000,
      finalAt: null,
      safe: false,
    },
  ]);
  f.clock.now += 5_000;
  f.ops.land(body.userOpHash, 'final');
  const final = await f.app.inject({
    url: withdrawalPath(body.withdrawalId),
    headers: as('person-1'),
  });
  assert.equal(final.json().state, 'final');
  assert.equal(Number((await rows(f, 'base_wallet_payments'))[0].final_at), NOW + 7_000);

  // Final: only now "paid", with the note and its final time; nobody else sees it.
  const page = await incoming(f, 'person-2');
  assert.equal(page.statusCode, 200, page.body);
  assert.deepEqual(page.json().payments, [
    {
      ...notice,
      state: 'final',
      note: 'for the logo',
      text: 'Harbor paid Juno 2.5 USDC',
      txHash,
      explorerUrl: `${WALLET_EXPECTED.explorer}/tx/${txHash}`,
      updatedAt: NOW + 7_000,
      finalAt: NOW + 7_000,
      safe: true,
    },
  ]);
  assert.equal(page.json().hasMore, false);
  assert.deepEqual(await notices(f, 'person-2', `?after=${page.json().cursor}`), []);
  assert.deepEqual(await notices(f, 'person-1'), []);
  assert.deepEqual(await notices(f, 'person-3'), []);
  const audit = await f.pg.query<{ kind: string; agent_id: string; operator_id: string }>(
    "SELECT kind, agent_id, operator_id FROM base_audit_events WHERE kind LIKE 'payment%' ORDER BY event_id",
  );
  assert.deepEqual(audit.rows, [
    { kind: 'payment_created', agent_id: AGENT_A, operator_id: 'person-1' },
    { kind: 'payment_received', agent_id: AGENT_B, operator_id: 'person-2' },
  ]);
  // Read again, the withdrawal stays final and the notice is not recorded twice.
  await f.app.inject({ url: withdrawalPath(body.withdrawalId), headers: as('person-1') });
  assert.equal((await notices(f, 'person-2')).length, 1);
});

test('the notice does not wait for the payer: the recipient read brings a payment up to date', async (t) => {
  const f = await setup(t);
  await juno(f);
  const body = (await pay(f, payBody(1))).json() as Created;
  await sign(f, body);
  f.ops.land(body.userOpHash, 'final');
  // The payer never reads again; the recipient's owner does.
  const [notice] = await notices(f, 'person-2');
  assert.equal(notice.state, 'final');
  // The payer is not a registered agent: shown by its public name, without a passport.
  assert.equal(notice.text, 'Harbor paid Juno 2.5 USDC');
  assert.equal(notice.from.baseId, null);
  assert.equal(notice.note, null);
  for (const query of ['?after=abc', '?limit=0', '?limit=51', '?since=1', '?after=1.x']) {
    const res = await incoming(f, 'person-2', query);
    assert.equal(res.statusCode, 400, query);
    assert.equal(res.json().code, 'invalid_query');
  }
});

test('a payment that does not go through: failed, never "paid", never its note', async (t) => {
  const f = await setup(t);
  await juno(f);
  const body = (await pay(f, payBody(1, { note: 'for the logo' }))).json() as Created;
  await sign(f, body);
  // It lands reverted and the block becomes final: the USDC never moved.
  f.ops.land(body.userOpHash, 'final', false);
  f.clock.now += 1_000;
  const [notice] = await notices(f, 'person-2');
  assert.equal(notice.state, 'failed');
  assert.equal(notice.text, "Harbor's 2.5 USDC payment to Juno didn't go through");
  assert.equal(notice.finalAt, null);
  assert.equal(notice.note, null);
  assert.equal((await rows(f, 'base_wallet_payments'))[0].final_at, null);
  assert.doesNotMatch(notice.text, /\bpaid\b/);
});

test('included, then reverted: on its way while in a block, failed once that block is final', async (t) => {
  const f = await setup(t);
  await juno(f);
  const body = (await pay(f, payBody(1))).json() as Created;
  await sign(f, body);
  f.ops.land(body.userOpHash, 'included', false);
  const [inBlock] = await notices(f, 'person-2');
  assert.equal(inBlock.state, 'included');
  assert.doesNotMatch(inBlock.text, /\bpaid\b/);
  f.ops.land(body.userOpHash, 'final', false);
  const [settled] = await notices(f, 'person-2');
  assert.equal(settled.state, 'failed');
  assert.equal(settled.text, "Harbor's 2.5 USDC payment to Juno didn't go through");
  assert.equal(settled.finalAt, null);
});

test('incoming: safe once Base proves the payment settled at its safe head, as the payer reads it', async (t) => {
  const f = await setup(t);
  await juno(f);
  const body = (await pay(f, payBody(1, { note: 'for the logo' }))).json() as Created;
  await sign(f, body);
  // Sent, not in a block yet: not safe.
  assert.equal((await notices(f, 'person-2'))[0].safe, false);
  f.ops.land(body.userOpHash, 'included');
  // In a block, not yet at or below the safe head: not safe.
  const first = (await incoming(f, 'person-2')).json();
  const [inBlock] = first.payments as Notice[];
  assert.equal(inBlock.state, 'included');
  assert.equal(inBlock.safe, false);
  const cursor = first.cursor as string;
  f.ops.mine(1);
  // Base can't tell (the safe tag fails): not safe, never guessed, nothing new after the cursor.
  f.ops.state.safeDown = true;
  assert.deepEqual(await notices(f, 'person-2', `?after=${cursor}`), []);
  assert.equal((await notices(f, 'person-2'))[0].safe, false);
  f.ops.state.safeDown = false;
  // The receipt no longer matches the canonical block at its height (a reorg): not safe.
  const txHash = f.ops.txOf(body.userOpHash);
  f.ops.state.reorged.add(txHash);
  assert.deepEqual(await notices(f, 'person-2', `?after=${cursor}`), []);
  f.ops.state.reorged.delete(txHash);
  assert.equal((await rows(f, 'base_wallet_withdrawals'))[0].safe_at, null);
  // Proven settled at the safe head: a change of its own, so a reader that only reads on after
  // its cursor gets it again, safe, still on its way (not "paid", no note). Reading it proves;
  // it never sends or signs anything.
  const sends = f.ops.state.sends.length;
  const page = (await incoming(f, 'person-2', `?after=${cursor}`)).json();
  assert.equal(f.ops.state.sends.length, sends);
  const [settled] = page.payments as Notice[];
  assert.equal(settled.state, 'included');
  assert.equal(settled.safe, true);
  assert.equal(settled.note, null);
  assert.equal(settled.text, 'Harbor is sending Juno 2.5 USDC');
  assert.notEqual((await rows(f, 'base_wallet_withdrawals'))[0].safe_at, null);
  // Recorded: it stays safe on a read that can't reach the safe tag, and is not proven again.
  f.ops.state.safeDown = true;
  assert.equal((await notices(f, 'person-2'))[0].safe, true);
  f.ops.state.safeDown = false;
  // The same proof as the payer's own read of its withdrawal.
  const payer = (
    await f.app.inject({ url: withdrawalPath(body.withdrawalId), headers: as('person-1') })
  ).json();
  assert.equal(payer.state, 'included');
  assert.equal(payer.safe, true);
  // Recorded once: it does not come again until it changes.
  assert.deepEqual(await notices(f, 'person-2', `?after=${page.cursor}`), []);
  // Final comes again, safe whatever the safe tag answers now.
  f.ops.land(body.userOpHash, 'final');
  f.ops.state.safeDown = true;
  const [final] = await notices(f, 'person-2', `?after=${page.cursor}`);
  assert.equal(final.state, 'final');
  assert.equal(final.safe, true);
  assert.equal(final.note, 'for the logo');
});

test('incoming: a feed that keeps its cursor learns safe, then final', async (t) => {
  const f = await setup(t);
  await juno(f);
  const body = (await pay(f, payBody(1))).json() as Created;
  await sign(f, body);
  // The screen's own feed (src/base/wallet/pay.ts), reading through the real route.
  const asked: Array<string | null> = [];
  const feed = createIncomingFeed((async (cursor: string | null) => {
    asked.push(cursor);
    const res = await incoming(f, 'person-2', cursor ? `?after=${cursor}` : '');
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  }) as never);
  const seen = async () =>
    (await feed.refresh()).payments.map((p) => [p.state, p.safe] as [string, boolean]);
  f.ops.land(body.userOpHash, 'included');
  assert.deepEqual(await seen(), [['included', false]]);
  f.ops.mine(1);
  assert.deepEqual(await seen(), [['included', true]]);
  assert.ok(
    asked.slice(1).every((cursor) => cursor !== null),
    'never back to the first page',
  );
  f.ops.land(body.userOpHash, 'final');
  assert.deepEqual(await seen(), [['final', true]]);
});

test('incoming: a reverted payment is never safe, even settled at the safe head', async (t) => {
  const f = await setup(t);
  await juno(f);
  const body = (await pay(f, payBody(1))).json() as Created;
  await sign(f, body);
  // In a block, reverted: its nonce is used and its block is under the safe head, but no USDC
  // moved.
  f.ops.land(body.userOpHash, 'included', false);
  f.ops.mine(1);
  const [reverted] = await notices(f, 'person-2');
  assert.equal(reverted.state, 'included');
  assert.equal(reverted.safe, false);
  const payer = (
    await f.app.inject({ url: withdrawalPath(body.withdrawalId), headers: as('person-1') })
  ).json();
  assert.equal(payer.state, 'included');
  assert.equal(payer.errorCode, 'reverted');
  assert.equal(payer.safe, false);
  const [withdrawal] = await rows(f, 'base_wallet_withdrawals');
  assert.equal(withdrawal.safe_at, null);
  // Base does prove it settled (as a revert), which frees the wallet; that is not safe.
  const proof = {
    sender: getAddress(payer.from as string),
    nonce: BigInt(withdrawal.nonce as string),
    userOpHash: body.userOpHash,
    txHash: f.ops.txOf(body.userOpHash),
    blockNumber: BigInt(withdrawal.block_number as string),
  };
  assert.equal(await f.ops.port.settledAtSafe!({ ...proof, success: false }), true);
  assert.equal(await f.ops.port.settledAtSafe!({ ...proof, success: true }), false);
  // Recorded by hand, a reverted one still reads not safe.
  await f.pg.query(`UPDATE base_wallet_withdrawals SET safe_at = 1 WHERE withdrawal_id = $1`, [
    body.withdrawalId,
  ]);
  assert.equal((await notices(f, 'person-2'))[0].safe, false);
  f.ops.land(body.userOpHash, 'final', false);
  const [failed] = await notices(f, 'person-2');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.safe, false);
  assert.equal((await rows(f, 'base_wallet_withdrawals'))[0].safe_at, null, 'cleared');
});

test('incoming: a dropped block clears the recorded safe, and the payment comes again', async (t) => {
  const f = await setup(t);
  await juno(f);
  f.ops.state.safeDepth = 0n;
  const body = (await pay(f, payBody(1))).json() as Created;
  await sign(f, body);
  f.ops.land(body.userOpHash, 'included');
  const page = (await incoming(f, 'person-2')).json();
  assert.equal((page.payments as Notice[])[0].safe, true);
  const [before] = await rows(f, 'base_wallet_withdrawals');
  assert.notEqual(before.safe_at, null);
  // Base drops the block that carried it: on its way again, not safe, and the feed learns it.
  f.ops.uninclude(body.userOpHash);
  const [back] = await notices(f, 'person-2', `?after=${page.cursor}`);
  assert.ok(back, 'it comes again after the cursor');
  assert.notEqual(back.state, 'included');
  assert.equal(back.safe, false);
  const [after] = await rows(f, 'base_wallet_withdrawals');
  assert.equal(after.state, 'submitted');
  assert.equal(after.safe_at, null);
  // It lands again: proven again for the new block, and comes again, safe.
  const again = (await incoming(f, 'person-2')).json();
  f.ops.land(body.userOpHash, 'included');
  const [relanded] = await notices(f, 'person-2', `?after=${again.cursor}`);
  assert.equal(relanded.state, 'included');
  assert.equal(relanded.safe, true);
});

test('migration 96: safe_at is cleared when the receipt changes, and moves the payment', async (t) => {
  const f = await setup(t);
  await juno(f);
  f.ops.state.safeDepth = 0n;
  const body = (await pay(f, payBody(1))).json() as Created;
  await sign(f, body);
  f.ops.land(body.userOpHash, 'included');
  assert.equal((await notices(f, 'person-2'))[0].safe, true);
  const xid = async () => BigInt((await rows(f, 'base_wallet_payments'))[0].change_xid as string);
  const recorded = await xid();
  // Another block for it (a reorg re-included it), as the withdrawal records it.
  await f.pg.query(
    `UPDATE base_wallet_withdrawals SET block_number = block_number + 1 WHERE withdrawal_id = $1`,
    [body.withdrawalId],
  );
  assert.equal((await rows(f, 'base_wallet_withdrawals'))[0].safe_at, null);
  const cleared = await xid();
  assert.ok(cleared > recorded, 'moved');
  // Recording it moves it too; any other change of the withdrawal leaves it alone.
  await f.pg.query(`UPDATE base_wallet_withdrawals SET safe_at = 1 WHERE withdrawal_id = $1`, [
    body.withdrawalId,
  ]);
  const marked = await xid();
  assert.ok(marked > cleared, 'recording it moves it too');
  await f.pg.query(
    `UPDATE base_wallet_withdrawals SET updated_at = updated_at + 1 WHERE withdrawal_id = $1`,
    [body.withdrawalId],
  );
  assert.equal(Number((await rows(f, 'base_wallet_withdrawals'))[0].safe_at), 1);
  assert.equal(await xid(), marked);
  // Leaving inclusion (back to submitted) clears it, even when the same write names a time.
  await f.pg.query(
    `UPDATE base_wallet_withdrawals SET state = 'submitted', safe_at = 2 WHERE withdrawal_id = $1`,
    [body.withdrawalId],
  );
  assert.equal((await rows(f, 'base_wallet_withdrawals'))[0].safe_at, null);
  assert.ok((await xid()) > marked, 'moved');
  // Only ever while included or final.
  await assert.rejects(
    f.pg.query(`UPDATE base_wallet_withdrawals SET safe_at = 1 WHERE withdrawal_id = $1`, [
      body.withdrawalId,
    ]),
  );
});

test('incoming proves at most INCOMING_SAFE_MAX included payments per read, each once', async (t) => {
  const f = await setup(t);
  await juno(f);
  // The safe head is the head: in a block is settled at once, so each wallet may pay again.
  f.ops.state.safeDepth = 0n;
  const sent: Created[] = [];
  for (let n = 1; n <= INCOMING_SAFE_MAX + 1; n += 1) {
    const agent = n % 2 ? AGENT_A : AGENT_A2;
    // One after the other: the oldest payment is proven first.
    f.clock.now += 1;
    const body = (await pay(f, payBody(n, { amount: '10000' }), { agent })).json() as Created;
    await sign(f, body, agent);
    // All in the head block: none of them becomes final meanwhile.
    f.ops.include(body.userOpHash, true, true);
    const read = await f.app.inject({
      url: withdrawalPath(body.withdrawalId, agent),
      headers: as('person-1'),
    });
    assert.equal(read.json().state, 'included');
    sent.push(body);
  }
  // The payer's own reads proved each one and stored the proof (safe_at, reused by every later
  // read). Cleared here, as if no reader had proven them yet: what is measured is the
  // recipient's read alone.
  const stored = await f.pg.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM base_wallet_withdrawals WHERE safe_at IS NOT NULL',
  );
  assert.equal(stored.rows[0].n, INCOMING_SAFE_MAX + 1);
  await f.pg.query('UPDATE base_wallet_withdrawals SET safe_at = NULL');
  const proofs: string[] = [];
  const prove = f.ops.port.settledAtSafe!;
  f.ops.port.settledAtSafe = async (input) => {
    proofs.push(input.txHash);
    return prove(input);
  };
  const sends = f.ops.state.sends.length;
  const page = (await incoming(f, 'person-2')).json();
  assert.equal(f.ops.state.sends.length, sends, 'reading never sends');
  const payments = page.payments as Array<Notice & { withdrawalId: string }>;
  // The oldest INCOMING_SAFE_MAX proven (each moved after the one past the cap, a change of its
  // own); the one past the cap is not safe yet.
  const proven = sent.slice(0, INCOMING_SAFE_MAX).map((b) => b.withdrawalId);
  const rest = sent[INCOMING_SAFE_MAX].withdrawalId;
  assert.deepEqual(
    payments.map((p) => [p.withdrawalId, p.safe]),
    [[rest, false], ...payments.slice(1).map((p) => [p.withdrawalId, true])],
  );
  assert.deepEqual(
    payments
      .slice(1)
      .map((p) => p.withdrawalId)
      .sort(),
    [...proven].sort(),
  );
  assert.equal(proofs.length, INCOMING_SAFE_MAX);
  assert.equal(new Set(proofs).size, INCOMING_SAFE_MAX, 'each proven once');
  assert.equal(INCOMING_SAFE_MAX, 10);
  // The next read proves only the one left; those recorded are never proven again.
  proofs.length = 0;
  const next = (await notices(f, 'person-2', `?after=${page.cursor}`)) as Array<
    Notice & { withdrawalId: string }
  >;
  assert.deepEqual(
    next.map((p) => [p.withdrawalId, p.safe]),
    [[rest, true]],
  );
  assert.equal(proofs.length, 1);
  // Nothing left to prove: no proof at all.
  proofs.length = 0;
  assert.equal((await notices(f, 'person-2')).filter((p) => p.safe).length, sent.length);
  assert.equal(proofs.length, 0);
});

test('payment states: each withdrawal state shown distinctly, unsent ones never', () => {
  assert.equal(payStateOf('submitted'), 'pending');
  assert.equal(payStateOf('cancel_pending'), 'pending', 'the original may still land');
  assert.equal(payStateOf('included'), 'included');
  assert.equal(payStateOf('final'), 'final');
  assert.equal(payStateOf('failed'), 'failed');
  assert.equal(payStateOf('cancelled'), 'failed');
  // Never signed: nothing was sent.
  assert.equal(payStateOf('awaiting_signature'), null);
  assert.equal(payStateOf('expired'), null);
});

test('incoming pages oldest change first by a cursor: nothing skipped, a later change comes again', async (t) => {
  const f = await setup(t);
  await juno(f);
  const first = (await pay(f, payBody(1))).json() as Created;
  await sign(f, first);
  const second = (await pay(f, payBody(2), { agent: AGENT_A2 })).json() as Created;
  await sign(f, second, AGENT_A2);
  const page1 = (await incoming(f, 'person-2', '?limit=1')).json();
  assert.deepEqual(
    page1.payments.map((p: { paymentId: string }) => p.paymentId),
    [first.payment.paymentId],
  );
  assert.equal(page1.hasMore, true);
  assert.match(page1.cursor, /^[0-9]+\.[0-9a-f-]{36}$/);
  const page2 = (await incoming(f, 'person-2', `?limit=1&after=${page1.cursor}`)).json();
  assert.deepEqual(
    page2.payments.map((p: { paymentId: string }) => p.paymentId),
    [second.payment.paymentId],
  );
  assert.equal(page2.hasMore, false);
  const page3 = (await incoming(f, 'person-2', `?after=${page2.cursor}`)).json();
  assert.deepEqual(page3, { payments: [], cursor: page2.cursor, hasMore: false });
  // The first payment changes (final): it comes again after the cursor, with its new state.
  f.ops.land(first.userOpHash, 'final');
  const page4 = (await incoming(f, 'person-2', `?after=${page2.cursor}`)).json();
  assert.deepEqual(
    page4.payments.map((p: { paymentId: string; state: string }) => [p.paymentId, p.state]),
    [[first.payment.paymentId, 'final']],
  );
  // A change from a transaction newer than every one still running is held back until it settles
  // (here: an id no transaction has had yet), so a page never passes one that commits later.
  await f.pg.query(
    "UPDATE base_wallet_payments SET change_xid = '4000000000'::xid8 WHERE payment_id = $1",
    [second.payment.paymentId],
  );
  const held = (await incoming(f, 'person-2')).json();
  assert.deepEqual(
    held.payments.map((p: { paymentId: string }) => p.paymentId),
    [first.payment.paymentId],
  );
});

test('incoming refreshes the least recently checked payments first, so every one gets its turn', async (t) => {
  const f = await setup(t);
  await juno(f);
  const one = (await pay(f, payBody(1))).json() as Created;
  await sign(f, one);
  const two = (await pay(f, payBody(2), { agent: AGENT_A2 })).json() as Created;
  await sign(f, two, AGENT_A2);
  const store = createPayStore({ chainId: CHAIN_ID, registry: REGISTRY, network: NETWORK });
  const picked: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    f.clock.now += 1_000;
    picked.push(
      ...(await store.pendingIncoming(f.db, { accountId: 'person-2', limit: 1, at: f.clock.now })),
    );
  }
  assert.deepEqual(picked, [one.withdrawalId, two.withdrawalId, one.withdrawalId]);
  assert.ok(INCOMING_REFRESH_MAX >= 25);
  // The incoming read brings both up to date in one go.
  f.ops.land(one.userOpHash, 'final');
  f.ops.land(two.userOpHash, 'final');
  assert.deepEqual(
    (await notices(f, 'person-2')).map((p) => p.state),
    ['final', 'final'],
  );
});

test('incoming shows what the money did: the withdrawal amount and destination, never the record', async (t) => {
  const f = await setup(t);
  await juno(f);
  const body = (await pay(f, payBody(1))).json() as Created;
  await sign(f, body);
  // The payment record says otherwise: the withdrawal's own amount is shown.
  await f.pg.query(
    'UPDATE base_wallet_payments SET amount_raw = 99000000, recipient_address = $1',
    [OUTSIDE],
  );
  const [notice] = await notices(f, 'person-2');
  assert.deepEqual(notice.amount, { raw: '2500000', decimals: 6, display: '2.5' });
  assert.equal(notice.to.wallet, WALLET_B);
  // A withdrawal that went elsewhere is never shown as a payment to this wallet.
  await f.pg.query('UPDATE base_wallet_withdrawals SET destination = $1', [OUTSIDE]);
  assert.deepEqual(await notices(f, 'person-2'), []);
});

test('who sees a payment: the wallet owner accounts only, not the agent workspace or a new owner', async (t) => {
  const f = await setup(t);
  await juno(f);
  await f.pg.query("INSERT INTO workspaces VALUES ('person-3', '{\"agents\": []}')");
  const body = (await pay(f, payBody(1, { note: 'for the logo' }))).json() as Created;
  await sign(f, body);
  const seen = (person: string, workspace?: string) =>
    f.app
      .inject({ url: '/api/base/pay/incoming', headers: as(person, workspace) })
      .then((res) => res.json().payments as Notice[]);
  assert.deepEqual(
    (await seen('person-2')).map((p) => [p.paymentId, p.state]),
    [[body.payment.paymentId, 'pending']],
  );
  // Juno moves to person-3 (its manifest, its workspace and the wallet's workspace); the wallet's
  // owner account stays person-2, as W1 keeps it.
  await f.pg.query("UPDATE agent_manifests SET operator_id = 'person-3' WHERE agent_id = $1", [
    AGENT_B,
  ]);
  await f.pg.query("UPDATE base_wallets SET operator_id = 'person-3' WHERE agent_id = $1", [
    AGENT_B,
  ]);
  await f.pg.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', (data->'agents') || $1::jsonb)
     WHERE operator_id = 'person-3'`,
    [JSON.stringify([{ id: AGENT_B, revision: 1, revokedAt: null }])],
  );
  // The new owner of the agent sees nothing from before, whatever workspace is selected.
  assert.deepEqual(await seen('person-3'), []);
  assert.deepEqual(await seen('person-3', 'person-3'), []);
  assert.deepEqual(await seen('person-3', 'person-2'), []);
  // Removed: still the wallet owner's; the agent is shown by its passport once its card is gone.
  await f.pg.query('DELETE FROM agent_manifests WHERE agent_id = $1', [AGENT_B]);
  f.ops.land(body.userOpHash, 'final');
  const [after] = await seen('person-2');
  assert.equal(after.text, 'Harbor paid CC-Juno01 2.5 USDC');
  assert.equal(after.note, 'for the logo');
  assert.deepEqual(await seen('person-3'), []);
  // The paying side: the sender wallet's owner account only. Harbor moves to person-3 too; its
  // withdrawal stays person-1's to read, never person-3's.
  await f.pg.query("UPDATE agent_manifests SET operator_id = 'person-3' WHERE agent_id = $1", [
    AGENT_A,
  ]);
  await f.pg.query("UPDATE base_wallets SET operator_id = 'person-3' WHERE agent_id = $1", [
    AGENT_A,
  ]);
  const path = withdrawalPath(body.withdrawalId);
  assert.equal((await f.app.inject({ url: path, headers: as('person-1') })).statusCode, 200);
  assert.equal((await f.app.inject({ url: path, headers: as('person-3') })).statusCode, 404);
  assert.equal(
    (await f.app.inject({ url: path, headers: as('person-3', 'person-3') })).statusCode,
    404,
  );
  assert.deepEqual(await seen('person-1'), [], 'a payment sent is not an incoming one');
});

test('recipient changed between lookup and prepare: 409, nothing prepared, held or stored', async (t) => {
  const f = await setup(t, { env: { CITY_BASE_WALLET: '1', CITY_BASE_PAY_ANY_ADDRESS: '1' } });
  await juno(f);
  const lookupId = await lookedUp(f);
  const to = { lookupId };
  // The Base ID moved to another holder on Base after the lookup.
  f.base.state.owners.set('501', OUTSIDE);
  const moved = await pay(f, payBody(1, { to }));
  assert.equal(moved.statusCode, 409, moved.body);
  assert.equal(moved.json().code, 'recipient_changed');
  f.base.state.owners.set('501', WALLET_B);
  // The block the lookup was made at was dropped: the same height has another hash now.
  f.base.state.fork = 1;
  const dropped = await pay(f, payBody(2, { to }));
  assert.equal(dropped.statusCode, 409);
  assert.equal(dropped.json().code, 'recipient_changed');
  f.base.state.fork = 0;
  // Our record of the agent's wallet is another one now.
  await f.pg.query('UPDATE base_wallets SET address = $1 WHERE agent_id = $2', [WALLET_C, AGENT_B]);
  const rewired = await pay(f, payBody(3, { to }));
  assert.equal(rewired.statusCode, 409);
  assert.equal(rewired.json().code, 'recipient_changed');
  await f.pg.query('UPDATE base_wallets SET address = $1 WHERE agent_id = $2', [WALLET_B, AGENT_B]);
  // Shown as "not a Central City agent" (an address), and it is one now.
  const asAddress = await pay(f, payBody(4, { to: { address: WALLET_B } }));
  assert.equal(asAddress.statusCode, 409);
  assert.equal(asAddress.json().code, 'recipient_changed');
  // Our record changed between the request's start and the check right before prepare.
  f.base.state.duringBalances = async () => {
    await f.pg.query("UPDATE base_identities SET state = 'failed' WHERE agent_id = $1", [AGENT_B]);
  };
  const recorded = await pay(f, payBody(5, { to }));
  assert.equal(recorded.statusCode, 409);
  assert.equal(recorded.json().code, 'recipient_changed');
  assert.equal(f.ops.state.prepares.length, 0, 'nothing was prepared');
  assert.deepEqual(await rows(f, 'base_wallet_withdrawals'), []);
  assert.deepEqual(await rows(f, 'base_wallet_payments'), []);
  assert.deepEqual(await rows(f, 'base_wallet_reservations'), []);
  // Base unreachable at that moment: refused as unavailable, never paid unchecked.
  await f.pg.query("UPDATE base_identities SET state = 'confirmed' WHERE agent_id = $1", [AGENT_B]);
  f.base.state.down = true;
  const down = await pay(f, payBody(6, { to }));
  assert.equal(down.statusCode, 503);
  assert.equal(down.json().code, 'chain_unavailable');
  assert.equal(f.ops.state.prepares.length, 0);
});

test('lookups: the server keeps what it showed; only its account, until it expires, may pay with it', async (t) => {
  const f = await setup(t);
  await juno(f);
  const looked = (await lookup(f, 'Juno01', 'person-1')).json();
  const [row] = await rows(f, 'base_pay_lookups');
  assert.equal(row.lookup_id, looked.lookupId);
  assert.equal(row.account_id, 'person-1');
  assert.equal(Number(row.chain_id), CHAIN_ID);
  assert.equal(row.registry_address, REGISTRY);
  assert.equal(row.agent_id, AGENT_B);
  assert.equal(String(row.base_id), '501');
  assert.equal(row.short_id, 'Juno01');
  assert.equal(row.wallet, WALLET_B);
  assert.equal(String(row.block), '1000');
  assert.equal(row.block_hash, hash32('block-1000'));
  assert.equal(Number(row.issued_at), NOW);
  assert.equal(Number(row.expires_at), NOW + PAY_RECIPIENT_TTL_MS);
  assert.equal(Number(row.version), 1);
  // The same lookup at the same block answers the same id; another account gets its own.
  assert.equal((await lookup(f, '501', 'person-1')).json().lookupId, looked.lookupId);
  const theirs = (await lookup(f, '501', 'person-3')).json().lookupId;
  assert.notEqual(theirs, looked.lookupId);
  // Another account's lookup, an unknown one, an expired one: look the recipient up again.
  for (const [n, lookupId] of [
    [1, theirs],
    [2, `pl_${'A'.repeat(32)}`],
  ] as const) {
    const res = await pay(f, payBody(n, { to: { lookupId } }));
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().code, 'recipient_expired');
  }
  f.clock.now = looked.expiresAt + 1;
  const late = await pay(f, payBody(3, { to: { lookupId: looked.lookupId } }));
  assert.equal(late.statusCode, 409, late.body);
  assert.equal(late.json().code, 'recipient_expired');
  assert.equal(f.ops.state.prepares.length, 0);
  // Expired lookups (past the clock slack too) are deleted as new ones are issued.
  f.clock.now = looked.expiresAt + CLOCK_SLACK_MS + 1;
  f.base.state.head += 1n;
  const fresh = (await lookup(f, '501', 'person-1')).json().lookupId;
  assert.deepEqual(
    (await rows(f, 'base_pay_lookups')).map((r) => r.lookup_id),
    [fresh],
  );
});

test('point in time: expiring while the request runs or while Base is read is 409; fresh is paid', async (t) => {
  const f = await setup(t);
  await juno(f);
  // Expiring while the request runs: checked again right before the operation is prepared.
  const first = (await lookup(f, 'Juno01', 'person-1')).json();
  f.clock.now = first.expiresAt - 1;
  f.base.state.duringBalances = async () => {
    f.clock.now += 2;
  };
  const during = await pay(f, payBody(1, { to: { lookupId: first.lookupId } }));
  assert.equal(during.statusCode, 409, during.body);
  assert.equal(during.json().code, 'recipient_expired');
  // The fresh read of Base ends after the lookup expired: it confirms nothing that was shown.
  f.clock.now = NOW + 60 * 60_000;
  f.base.state.head += 1n;
  const second = (await lookup(f, 'Juno01', 'person-1')).json();
  f.clock.now = second.expiresAt - 1;
  f.base.state.duringRead = () => {
    f.clock.now += 5;
  };
  const slow = await pay(f, payBody(2, { to: { lookupId: second.lookupId } }));
  assert.equal(slow.statusCode, 409, slow.body);
  assert.equal(slow.json().code, 'recipient_expired');
  f.base.state.duringRead = null;
  assert.equal(f.ops.state.prepares.length, 0);
  assert.deepEqual(await rows(f, 'base_wallet_payments'), []);
  // Fresh and matching, up to its last millisecond: paid, both checks recorded.
  f.clock.now = NOW + 2 * 60 * 60_000;
  f.base.state.head += 1n;
  const third = (await lookup(f, 'Juno01', 'person-1')).json();
  assert.equal(third.verification, 'point_in_time');
  f.base.state.head += 2n;
  f.clock.now = third.expiresAt;
  const ok = await pay(f, payBody(3, { to: { lookupId: third.lookupId } }));
  assert.equal(ok.statusCode, 201, ok.body);
  const body = ok.json() as Created;
  assert.equal(body.payment.recipient.verification, 'point_in_time');
  assert.equal(body.payment.recipient.verified!.block, third.verified.block + 2);
  assert.deepEqual(body.payment.issued, {
    block: third.verified.block,
    blockHash: third.verified.blockHash,
    expiresAt: third.expiresAt,
  });
  // Nothing in either answer claims more than that moment.
  assert.doesNotMatch(JSON.stringify([third, body.payment]), /guarantee|at_execution|landed/i);
});

test('interim: a recipient whose wallet has no owner account is not payable yet (409), then is', async (t) => {
  // Any address allowed too: an agent's wallet is never paid around this rule as a plain address.
  const f = await setup(t, { env: { CITY_BASE_WALLET: '1', CITY_BASE_PAY_ANY_ADDRESS: '1' } });
  // Juno was registered on Base before wallets existed: its Base ID sits in its identity wallet,
  // owned by the address typed at registration, with no owner vault account.
  await register(f, {
    agentId: AGENT_B,
    baseId: '501',
    short: 'Juno01',
    wallet: WALLET_B,
    name: 'Juno',
    ownerAccount: null,
  });
  for (const q of ['501', 'Juno01', 'CC-Juno01', 'https://centralcity.ai/a/Juno01', WALLET_B]) {
    const res = await lookup(f, q);
    assert.equal(res.statusCode, 409, `${q}: ${res.body}`);
    assert.equal(res.json().code, 'recipient_not_ready');
    assert.equal(res.json().error, "This agent can't receive payments yet.");
    assert.equal(res.json().lookupId, undefined);
  }
  assert.equal(f.base.state.reads.length, 0, 'refused before any read of Base');
  assert.deepEqual(await rows(f, 'base_pay_lookups'), [], 'no lookup is issued');
  // Paying it by its address, even with any address allowed.
  const res = await pay(f, payBody(2, { to: { address: WALLET_B } }));
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, 'recipient_not_ready');
  // Its wallet joins person-2's vault: the same agent is payable.
  await f.pg.query("UPDATE base_wallets SET owner_account_id = 'person-2' WHERE agent_id = $1", [
    AGENT_B,
  ]);
  const lookupId = await lookedUp(f, 'CC-Juno01');
  const paid = await pay(f, payBody(3, { to: { lookupId } }));
  assert.equal(paid.statusCode, 201, paid.body);
  // Ready when looked up, not any more at the check right before prepare: refused there.
  f.base.state.duringBalances = async () => {
    await f.pg.query('UPDATE base_wallets SET owner_account_id = NULL WHERE agent_id = $1', [
      AGENT_B,
    ]);
  };
  const late = await pay(f, payBody(4, { to: { lookupId } }), { agent: AGENT_A2 });
  assert.equal(late.statusCode, 409, late.body);
  assert.equal(late.json().code, 'recipient_not_ready');
  assert.equal(f.ops.state.prepares.length, 1, 'only the payment to the ready wallet');
});

/** Each way a wallet is not ready (pay/store.ts walletReady), as a change and its undoing. */
function notReadyCases(f: Fixture, agentId: string, account: 'person-1' | 'person-2') {
  const other = getAddress(`0x${'9a'.repeat(20)}`);
  const set =
    (sql: string, ...params: unknown[]) =>
    () =>
      f.pg.query(sql, params).then(() => undefined);
  const recipe = (change: Record<string, unknown>) =>
    `UPDATE base_wallets SET derivation = derivation || '${JSON.stringify(change)}'::jsonb
     WHERE agent_id = '${agentId}'`;
  const vaultOwner = async () =>
    (
      await f.pg.query<{ owner_address: string }>(
        'SELECT owner_address FROM base_owner_vaults WHERE operator_id = $1',
        [account],
      )
    ).rows[0].owner_address;
  const ownersAre = async (owners: (vault: string) => string[]) =>
    set(recipe({ owners: owners(await vaultOwner()) }))();
  return [
    {
      name: 'its owner address is not the vault owner key',
      breakIt: set(
        'UPDATE base_wallets SET owner_address = $1 WHERE agent_id = $2',
        other,
        agentId,
      ),
      fix: set(
        `UPDATE base_wallets w SET owner_address = v.owner_address FROM base_owner_vaults v
         WHERE w.agent_id = $1 AND v.operator_id = $2`,
        agentId,
        account,
      ),
    },
    {
      name: 'its recipe is at another account index',
      breakIt: set(recipe({ accountIndex: '1' })),
      fix: set(recipe({ accountIndex: accountIndexFor(agentId).toString(10) })),
    },
    {
      name: 'its recipe has other owners',
      breakIt: () => ownersAre(() => [other, NETWORK.contracts.spendPermissionManager]),
      fix: () => ownersAre((vault) => [vault, NETWORK.contracts.spendPermissionManager]),
    },
    {
      name: 'its recipe has only the owner key (no SpendPermissionManager)',
      breakIt: () => ownersAre((vault) => [vault]),
      fix: () => ownersAre((vault) => [vault, NETWORK.contracts.spendPermissionManager]),
    },
    {
      name: 'its recipe is of another factory',
      breakIt: set(recipe({ factory: other })),
      fix: set(recipe({ factory: NETWORK.contracts.smartWalletFactory })),
    },
    {
      name: "the vault's backup is not confirmed",
      breakIt: set(
        'UPDATE base_owner_vaults SET backup_confirmed_at = NULL WHERE operator_id = $1',
        account,
      ),
      fix: set(
        'UPDATE base_owner_vaults SET backup_confirmed_at = 1 WHERE operator_id = $1',
        account,
      ),
    },
    {
      name: 'its owner account has no vault',
      breakIt: set(
        "UPDATE base_owner_vaults SET operator_id = 'person-3' WHERE operator_id = $1",
        account,
      ),
      fix: set(
        "UPDATE base_owner_vaults SET operator_id = $1 WHERE operator_id = 'person-3'",
        account,
      ),
    },
  ];
}

test('interim: every condition of a ready recipient wallet, refused at lookup and at pay', async (t) => {
  const f = await setup(t);
  await juno(f);
  let n = 0;
  for (const c of notReadyCases(f, AGENT_B, 'person-2')) {
    // Looked up while ready; the wallet stops being ready afterwards.
    const lookupId = await lookedUp(f);
    await c.breakIt();
    const looked = await lookup(f, 'CC-Juno01');
    assert.equal(looked.statusCode, 409, `lookup, ${c.name}: ${looked.body}`);
    assert.equal(looked.json().code, 'recipient_not_ready', c.name);
    // Refused at the check right before prepare.
    const paid = await pay(f, payBody(++n, { to: { lookupId } }));
    assert.equal(paid.statusCode, 409, `pay, ${c.name}: ${paid.body}`);
    assert.equal(paid.json().code, 'recipient_not_ready', c.name);
    await c.fix();
    assert.equal((await lookup(f, 'CC-Juno01')).statusCode, 200, `undone: ${c.name}`);
  }
  assert.equal(f.ops.state.prepares.length, 0, 'nothing prepared for a wallet not ready');
  // Ready again in every respect: payable.
  const ok = await pay(f, payBody(++n));
  assert.equal(ok.statusCode, 201, ok.body);
});

test('interim: a payer wallet with no owner account cannot pay (only an owner account pays)', async (t) => {
  const f = await setup(t);
  await juno(f);
  // person-1's agent registered before wallets existed: an identity wallet, no owner account.
  const OLD = '0a0a0a0a-0000-4000-8000-0000000000a3';
  await wallet(f.db, {
    agentId: OLD,
    workspace: 'person-1',
    address: getAddress(`0x${'a3'.repeat(20)}`),
    ownerAccount: null,
  });
  await manifest(f.db, OLD, 'person-1', 'Old Harbor');
  const lookupId = await lookedUp(f);
  const reads = f.base.state.reads.length;
  const res = await pay(f, payBody(1, { to: { lookupId } }), { agent: OLD });
  assert.equal(res.statusCode, 404, res.body);
  // Nor can it withdraw (W2 authorizes by the wallet's owner account).
  const withdrawal = await f.app.inject({
    method: 'POST',
    url: `/api/base/agents/${OLD}/wallet/withdrawals`,
    headers: as('person-1'),
    payload: JSON.stringify({ idempotencyKey: key(2), token: 'USDC', amount: '1000', to: OUTSIDE }),
  });
  assert.equal(withdrawal.statusCode, 404, withdrawal.body);
  assert.equal(f.base.state.reads.length, reads, 'Base not read for it');
  assert.equal(f.ops.state.prepares.length, 0);
});

test('interim: every condition of a ready payer wallet, refused when a payment starts', async (t) => {
  const f = await setup(t);
  await juno(f);
  const lookupId = await lookedUp(f);
  let n = 0;
  for (const c of notReadyCases(f, AGENT_A, 'person-1')) {
    await c.breakIt();
    const reads = f.base.state.reads.length;
    const res = await pay(f, payBody(++n, { to: { lookupId } }));
    assert.equal(res.statusCode, 409, `${c.name}: ${res.body}`);
    assert.equal(res.json().code, 'payer_not_ready', c.name);
    assert.equal(f.base.state.reads.length, reads, 'refused before the recipient is read');
    await c.fix();
  }
  assert.equal(f.ops.state.prepares.length, 0);
  const ok = await pay(f, payBody(++n, { to: { lookupId } }));
  assert.equal(ok.statusCode, 201, ok.body);
});

test('interim: the rule never stops a payment already sent from being read and tracked to final', async (t) => {
  const f = await setup(t);
  await juno(f);
  const to = { lookupId: await lookedUp(f) };
  const body = (await pay(f, payBody(1, { to, note: 'for the logo' }))).json() as Created;
  await sign(f, body);
  // Both wallets stop being ready after the payment was sent.
  await f.pg.query('UPDATE base_owner_vaults SET backup_confirmed_at = NULL');
  // The same request again is a read of the same payment, not a new one: answered.
  const replay = await pay(f, payBody(1, { to, note: 'for the logo' }));
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(replay.json().withdrawalId, body.withdrawalId);
  // Tracked to final, seen by the payer and by the recipient's owner.
  f.ops.land(body.userOpHash, 'final');
  const [notice] = await notices(f, 'person-2');
  assert.equal(notice.state, 'final');
  assert.equal(notice.text, 'Harbor paid Juno 2.5 USDC');
  const read = await f.app.inject({
    url: withdrawalPath(body.withdrawalId),
    headers: as('person-1'),
  });
  assert.equal(read.json().state, 'final');
  // A new payment is what the rule stops.
  const next = await pay(f, payBody(2, { to }));
  assert.equal(next.statusCode, 409);
  assert.equal(next.json().code, 'payer_not_ready');
});

test('not a Central City agent: 422 with the setting off; with it on, an address payment', async (t) => {
  const off = await setup(t);
  const refused = await pay(off, payBody(1, { to: { address: OUTSIDE } }));
  assert.equal(refused.statusCode, 422);
  assert.equal(refused.json().code, 'not_central_city_agent');
  assert.match(refused.json().error, /Use Withdraw for other addresses/);
  assert.equal(off.ops.state.prepares.length, 0);
  // Not a Base ID we know: nothing to look up, so nothing to pay.
  assert.equal((await lookup(off, '999', 'person-1')).statusCode, 404);
  assert.deepEqual(await rows(off, 'base_pay_lookups'), []);

  const on = await setup(t, { env: { CITY_BASE_WALLET: '1', CITY_BASE_PAY_ANY_ADDRESS: '1' } });
  const res = await pay(on, payBody(1, { to: { address: OUTSIDE.toLowerCase() } }));
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as Created;
  assert.deepEqual(body.payment.recipient, {
    kind: 'address',
    address: OUTSIDE,
    verification: 'none',
    warning: 'not_central_city_agent',
  });
  assert.equal(body.payment.lookupId, null);
  assert.equal(body.payment.issued, null);
  assert.equal(body.summary.to, OUTSIDE);
  assert.equal(on.base.state.reads.length, 0, 'no Base ID to verify');
  const [stored] = await rows(on, 'base_wallet_payments');
  assert.equal(stored.recipient_kind, 'address');
  assert.equal(stored.recipient_agent_id, null);
  assert.equal(stored.lookup_id, null);
  assert.equal(stored.verified_block, null);
  // Final: recorded, and no notice (no Central City agent to tell).
  await sign(on, body);
  on.ops.land(body.userOpHash, 'final');
  await on.app.inject({ url: withdrawalPath(body.withdrawalId), headers: as('person-1') });
  assert.notEqual((await rows(on, 'base_wallet_payments'))[0].final_at, null);
  assert.deepEqual(
    (await on.pg.query("SELECT 1 FROM base_audit_events WHERE kind = 'payment_received'")).rows,
    [],
  );
});

test('no paying yourself: the same wallet is 409; another of your own agents is fine', async (t) => {
  const f = await setup(t, { env: { CITY_BASE_WALLET: '1', CITY_BASE_PAY_ANY_ADDRESS: '1' } });
  await register(f, {
    agentId: AGENT_A,
    baseId: '777',
    short: 'Harb01',
    wallet: f.wallets[AGENT_A],
    workspace: 'person-1',
    newWallet: false,
  });
  await register(f, {
    agentId: AGENT_A2,
    baseId: '778',
    short: 'Harb02',
    wallet: f.wallets[AGENT_A2],
    workspace: 'person-1',
    newWallet: false,
  });
  for (const to of [
    { lookupId: await lookedUp(f, '777') },
    { address: f.wallets[AGENT_A] },
    { address: f.wallets[AGENT_A].toLowerCase() },
  ]) {
    const res = await pay(f, payBody(1, { to }));
    assert.equal(res.statusCode, 409, JSON.stringify(to));
    assert.equal(res.json().code, 'self_payment');
  }
  assert.equal(f.ops.state.prepares.length, 0);
  const other = await pay(f, payBody(2, { to: { lookupId: await lookedUp(f, '778') } }));
  assert.equal(other.statusCode, 201, other.body);
  assert.equal((other.json() as Created).summary.to, f.wallets[AGENT_A2]);
  // The table refuses a payment from a wallet to itself as well.
  const [row] = await rows(f, 'base_wallet_payments');
  await assert.rejects(
    f.pg.query(
      'UPDATE base_wallet_payments SET recipient_wallet_id = sender_wallet_id WHERE payment_id = $1',
      [row.payment_id],
    ),
  );
});

test('sponsorship only: a payment never uses the owner-funded fallback, even when it is on', async (t) => {
  const env = { CITY_BASE_WALLET: '1', CITY_BASE_WALLET_UNSPONSORED_FALLBACK: '1' };
  const f = await setup(t, { env });
  await juno(f);
  f.ops.state.sponsor = false;
  const res = await pay(f, payBody(1));
  assert.equal(res.statusCode, 503, res.body);
  assert.equal(res.json().code, 'sponsorship_unavailable');
  assert.deepEqual(
    f.ops.state.prepares.map((p) => p.ownerFunded),
    [false],
    'one sponsored attempt, never an owner-funded one',
  );
  assert.deepEqual(await rows(f, 'base_wallet_payments'), []);
  assert.deepEqual(await rows(f, 'base_wallet_reservations'), []);
  // A plain withdrawal with the same setting does fall back: the setting is on, Pay ignores it.
  const withdrawal = await f.app.inject({
    method: 'POST',
    url: `/api/base/agents/${AGENT_A}/wallet/withdrawals`,
    headers: as('person-1'),
    payload: JSON.stringify({
      idempotencyKey: key(2),
      token: 'USDC',
      amount: '1000',
      to: OUTSIDE,
    }),
  });
  assert.equal(withdrawal.statusCode, 201, withdrawal.body);
  assert.equal(withdrawal.json().summary.sponsored, false);
  assert.deepEqual(
    f.ops.state.prepares.map((p) => p.ownerFunded),
    [false, false, true],
  );
  // And no Pay file asks for an unsponsored operation or reads the fallback setting.
  const { readdir, readFile } = await import('node:fs/promises');
  for (const name of await readdir('server/base/pay')) {
    const text = await readFile(`server/base/pay/${name}`, 'utf8');
    assert.doesNotMatch(
      text,
      /ownerFunded|UNSPONSORED|unsponsoredFallback|sponsor\s*:\s*false/,
      name,
    );
  }
});

test('fees covered means the allowed paymaster charging nothing: anything else fails closed', async (t) => {
  // Even with the owner-funded fallback on: a payment is never paid from the wallet's ETH.
  const env = { CITY_BASE_WALLET: '1', CITY_BASE_WALLET_UNSPONSORED_FALLBACK: '1' };
  const f = await setup(t, { env });
  await juno(f);
  for (const [n, answer] of (['token', 'foreign', 'short'] as const).entries()) {
    f.ops.state.paymasterAnswer = answer;
    const res = await pay(f, payBody(n + 1));
    assert.equal(res.statusCode, 503, `${answer}: ${res.body}`);
    assert.equal(res.json().code, 'sponsorship_unavailable');
  }
  assert.ok(
    f.ops.state.prepares.every((p) => !p.ownerFunded),
    'never owner-funded',
  );
  assert.deepEqual(await rows(f, 'base_wallet_payments'), []);
  assert.deepEqual(await rows(f, 'base_wallet_withdrawals'), []);
  assert.deepEqual(await rows(f, 'base_wallet_reservations'), []);
  // The allowed paymaster in its exact layout, no token: the payment is prepared, sponsored.
  f.ops.state.paymasterAnswer = 'pinned';
  const res = await pay(f, payBody(9));
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as Created;
  assert.equal(body.summary.sponsored, true);
  assert.ok(
    sponsoredWithoutCharge(
      CHAIN_ID,
      userOperationFromRpc(body.userOperation).paymasterAndData,
      SPONSORS,
    ),
  );
});

test('a payment cancel never uses the owner-funded fallback, even when it is on', async (t) => {
  const env = { CITY_BASE_WALLET: '1', CITY_BASE_WALLET_UNSPONSORED_FALLBACK: '1' };
  const f = await setup(t, { env });
  await juno(f);
  const body = (await pay(f, payBody(1))).json() as Created;
  await sign(f, body);
  // A plain withdrawal from the other wallet, signed too.
  const withdrawal = await f.app.inject({
    method: 'POST',
    url: `/api/base/agents/${AGENT_A2}/wallet/withdrawals`,
    headers: as('person-1'),
    payload: JSON.stringify({ idempotencyKey: key(2), token: 'USDC', amount: '1000', to: OUTSIDE }),
  });
  assert.equal(withdrawal.statusCode, 201, withdrawal.body);
  await sign(f, withdrawal.json(), AGENT_A2);
  // No sponsor now: the payment's cancel fails closed; the withdrawal's falls back (setting on).
  f.ops.state.sponsor = false;
  f.ops.state.prepares.length = 0;
  const cancel = await f.app.inject({
    method: 'POST',
    url: `${withdrawalPath(body.withdrawalId)}/cancel`,
    headers: as('person-1'),
    payload: '{}',
  });
  assert.equal(cancel.statusCode, 503, cancel.body);
  assert.equal(cancel.json().code, 'sponsorship_unavailable');
  assert.deepEqual(
    f.ops.state.prepares.map((p) => p.ownerFunded),
    [false],
    'one sponsored attempt, never an owner-funded one',
  );
  const read = await f.app.inject({
    url: withdrawalPath(body.withdrawalId),
    headers: as('person-1'),
  });
  assert.equal(read.json().state, 'submitted', 'the payment stays live, nothing to sign');
  assert.equal(read.json().cancel, null);
  const other = await f.app.inject({
    method: 'POST',
    url: `${withdrawalPath(withdrawal.json().withdrawalId, AGENT_A2)}/cancel`,
    headers: as('person-1'),
    payload: '{}',
  });
  assert.equal(other.statusCode, 200, other.body);
  assert.equal(other.json().cancel.sponsored, false);
  assert.deepEqual(
    f.ops.state.prepares.map((p) => p.ownerFunded),
    [false, false, true],
  );
});

test('idempotency: the same key and body give the same payment; anything else is refused', async (t) => {
  const f = await setup(t);
  await juno(f);
  const to = { lookupId: await lookedUp(f) };
  const first = (await pay(f, payBody(1, { to, note: 'hi' }))).json() as Created;
  const reads = f.base.state.reads.length;
  const again = await pay(f, payBody(1, { to, note: 'hi' }));
  assert.equal(again.statusCode, 201);
  assert.deepEqual(again.json(), first);
  assert.equal(f.base.state.reads.length, reads, 'nothing verified again');
  assert.equal(f.ops.state.prepares.length, 1, 'nothing prepared again');
  // Another lookup of the same recipient (a newer block) is another request.
  f.base.state.head += 1n;
  const newer = { lookupId: await lookedUp(f) };
  f.base.state.head -= 1n;
  assert.notEqual(newer.lookupId, to.lookupId);
  for (const change of [
    { amount: '20000' },
    { note: 'hello' },
    { note: undefined },
    { to: newer },
    { to: { address: WALLET_B } },
  ]) {
    const res = await pay(f, payBody(1, { to, note: 'hi', ...change }));
    assert.equal(res.statusCode, 409, JSON.stringify(change));
    assert.equal(res.json().code, 'idempotency_conflict');
  }
  // The same key from the payer's other agent is another payment.
  const other = await pay(f, payBody(1, { to, note: 'hi' }), { agent: AGENT_A2 });
  assert.equal(other.statusCode, 409);
  // The binding changed since, the lookup even expired: the same request is the same payment.
  f.base.state.owners.set('501', OUTSIDE);
  f.clock.now += PAY_RECIPIENT_TTL_MS + 1;
  const late = await pay(f, payBody(1, { to, note: 'hi' }));
  assert.equal(late.json().withdrawalId, first.withdrawalId);
  f.clock.now -= PAY_RECIPIENT_TTL_MS + 1;
  // A key of a withdrawal is never a payment, and a payment's key never a withdrawal.
  const withdraw = (n: number) =>
    f.app.inject({
      method: 'POST',
      url: `/api/base/agents/${AGENT_A2}/wallet/withdrawals`,
      headers: as('person-1'),
      payload: JSON.stringify({
        idempotencyKey: key(n),
        token: 'USDC',
        amount: '1000',
        to: OUTSIDE,
      }),
    });
  assert.equal((await withdraw(5)).statusCode, 201);
  f.base.state.owners.set('501', WALLET_B);
  const crossed = await pay(f, payBody(5, { to }), { agent: AGENT_A2 });
  assert.equal(crossed.statusCode, 409);
  assert.equal(crossed.json().code, 'idempotency_conflict');
  const back = await withdraw(1);
  assert.equal(back.statusCode, 409);
  assert.equal(back.json().code, 'idempotency_conflict');
  assert.equal((await rows(f, 'base_wallet_payments')).length, 1);
});

test('the same key twice at once: both get the one payment', async (t) => {
  const f = await setup(t);
  await juno(f);
  const to = { lookupId: await lookedUp(f) };
  const [a, b] = await Promise.all([pay(f, payBody(1, { to })), pay(f, payBody(1, { to }))]);
  assert.equal(a.statusCode, 201, a.body);
  assert.equal(b.statusCode, 201, b.body);
  assert.equal(a.json().payment.paymentId, b.json().payment.paymentId);
  assert.equal((await rows(f, 'base_wallet_payments')).length, 1);
  assert.equal((await rows(f, 'base_wallet_withdrawals')).length, 1);
});

test('one unfinished owner operation per wallet: a payment waits for a withdrawal and back', async (t) => {
  const f = await setup(t);
  await juno(f);
  const first = (await pay(f, payBody(1))).json() as Created;
  const second = await pay(f, payBody(2, { amount: '10000' }));
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, 'operation_pending');
  assert.equal(second.json().withdrawalId, first.withdrawalId);
  const balance = await pay(f, payBody(3, { amount: '5000001' }), { agent: AGENT_A2 });
  assert.equal(balance.statusCode, 409);
  assert.equal(balance.json().code, 'insufficient_balance');
});

test('pay without waiting: payments and withdrawals share one hold and one cap, each in its own lane', async (t) => {
  const f = await setup(t, {
    env: { CITY_BASE_WALLET: '1', CITY_BASE_LANES: '1', CITY_BASE_LANES_CAP: '3' },
  });
  await juno(f);
  const withdraw = (n: number, amount: string) =>
    f.app.inject({
      method: 'POST',
      url: `/api/base/agents/${AGENT_A}/wallet/withdrawals`,
      headers: as('person-1'),
      payload: JSON.stringify({
        idempotencyKey: key(n),
        token: 'USDC',
        amount,
        to: getAddress(`0x${'5e'.repeat(20)}`),
      }),
    });
  // The wallet is not on Base yet: the first payment deploys it, and nothing else may meanwhile.
  const first = (await pay(f, payBody(1))).json() as Created & { lanes?: boolean };
  assert.equal(first.lanes, true);
  assert.equal(BigInt(first.userOperation.nonce), laneNonce(first.withdrawalId));
  assert.notEqual(first.userOperation.initCode, '0x');
  const deploying = await pay(f, payBody(2, { amount: '10000' }));
  assert.equal(deploying.json().code, 'operation_pending');
  assert.equal(deploying.json().withdrawalId, first.withdrawalId);
  await sign(f, first);
  f.ops.land(first.userOpHash, 'included');
  // On Base now: a withdrawal more than the payment leaves is refused, naming it.
  const over = await withdraw(9, '3000000');
  assert.equal(over.statusCode, 409);
  assert.equal(over.json().code, 'funds_held');
  assert.equal(over.json().open, 1);
  assert.deepEqual(over.json().details, {
    open: 1,
    available: { raw: '2500000', decimals: 6, display: '2.5' },
  });
  // What is left goes without waiting, in its own lane.
  const out = await withdraw(10, '2000000');
  assert.equal(out.statusCode, 201, out.body);
  assert.equal(out.json().lanes, true);
  assert.equal(out.json().userOperation.initCode, '0x');
  // A payment sees both holds: 0.5 USDC is left.
  const second = await pay(f, payBody(3));
  assert.equal(second.json().code, 'funds_held');
  assert.equal(second.json().open, 2);
  const third = (await pay(f, payBody(4, { amount: '500000' }))).json() as Created & {
    lanes?: boolean;
  };
  assert.equal(third.lanes, true);
  assert.notEqual(third.userOperation.nonce, first.userOperation.nonce);
  // The cap counts payments and withdrawals alike.
  const capped = await pay(f, payBody(5, { amount: '10000' }));
  assert.equal(capped.json().code, 'too_many_open');
  assert.equal(capped.json().max, 3);
  assert.equal(capped.json().open, 3);
  assert.equal((await withdraw(11, '1')).json().code, 'too_many_open');
  // The first payment is final: its slot frees at the next create, with no read in between. Its
  // amount still counts until a balance read is past its block (this node's balance never drops).
  f.ops.land(first.userOpHash, 'final');
  const fourth = await pay(f, payBody(6, { amount: '10000' }));
  assert.equal(fourth.json().code, 'funds_held', fourth.body);
  assert.equal(fourth.json().open, 2);
  const states = (await rows(f, 'base_wallet_reservations')).map((row) => row.state).sort();
  assert.deepEqual(states, ['consumed', 'held', 'held']);
});

test('pay without waiting: three sponsored reverts in 24 hours pause payments (409 sponsor_paused), at create and at sign', async (t) => {
  const f = await setup(t, { env: { CITY_BASE_WALLET: '1', CITY_BASE_LANES: '1' } });
  await juno(f);
  f.ops.state.code.add(f.wallets[AGENT_A].toLowerCase());
  const reverted: Created[] = [];
  for (const n of [1, 2, 3]) {
    const body = (await pay(f, payBody(n, { amount: '10000' }))).json() as Created;
    await sign(f, body);
    reverted.push(body);
  }
  // One more prepared before they revert, not signed yet.
  const waiting = (await pay(f, payBody(4, { amount: '10000' }))).json() as Created;
  for (const body of reverted) f.ops.land(body.userOpHash, 'included', false);
  for (const body of reverted) {
    const view = await f.app.inject({
      url: withdrawalPath(body.withdrawalId),
      headers: as('person-1'),
    });
    assert.equal(view.json().errorCode, 'reverted');
  }
  const atSign = await f.app.inject({
    method: 'POST',
    url: `${withdrawalPath(waiting.withdrawalId)}/signature`,
    headers: as('person-1'),
    payload: JSON.stringify({ signature: await f.owner.sign({ hash: waiting.userOpHash }) }),
  });
  assert.equal(atSign.statusCode, 409, atSign.body);
  assert.equal(atSign.json().code, 'sponsor_paused');
  assert.equal(f.ops.state.sends.length, 3, 'nothing more sent');
  const paused = await pay(f, payBody(5, { amount: '10000' }));
  assert.equal(paused.json().code, 'sponsor_paused');
  assert.equal(paused.json().details.reverted, 3);
  // The window passes: payments go again.
  f.clock.now = paused.json().retryAt + 1;
  const again = await pay(f, payBody(6, { amount: '10000' }));
  assert.equal(again.statusCode, 201, again.body);
});

test('pay: a payment from before the sponsor ledger is backfilled by migration 97 and released when final', async (t) => {
  const f = await setup(t);
  await juno(f);
  const body = (await pay(f, payBody(1))).json() as Created;
  await sign(f, body);
  // As if it was made before 97: no exposure. Then 97 runs.
  await f.pg.query('DELETE FROM base_sponsor_exposure');
  await f.pg.exec(BASE_SPONSOR_EXPOSURE_SQL);
  // Its own cost and its cancel headroom.
  const all = await rows(f, 'base_sponsor_exposure');
  assert.equal(all.length, 2);
  const held = all.filter((row) => String(row.holder).startsWith('withdrawal:'));
  assert.equal(held[0].holder, `withdrawal:${body.withdrawalId}`);
  assert.equal(BigInt(held[0].amount as string), sponsorBound(body.userOperation));
  assert.equal(held[0].state, 'held');
  f.ops.land(body.userOpHash, 'final');
  const read = await f.app.inject({
    url: withdrawalPath(body.withdrawalId),
    headers: as('person-1'),
  });
  assert.equal(read.json().state, 'final');
  assert.deepEqual(
    (await rows(f, 'base_sponsor_exposure')).map((row) => row.state),
    ['released', 'released'],
  );
});

test('owner only: co-owners, strangers, other principals and signed-out callers cannot pay', async (t) => {
  const f = await setup(t);
  await juno(f);
  const to = { lookupId: await lookedUp(f) };
  for (const person of ['person-2', 'person-3', 'ai-1']) {
    const res = await pay(f, payBody(1, { to }), { person });
    assert.equal(res.statusCode, 404, person);
  }
  const anonymous = await f.app.inject({
    method: 'POST',
    url: `/api/base/agents/${AGENT_A}/wallet/payments`,
    headers: json,
    payload: JSON.stringify(payBody(1, { to })),
  });
  assert.equal(anonymous.statusCode, 401);
  // An agent that is not the payer's (the recipient's own agent) is not found for the payer.
  assert.equal((await pay(f, payBody(2, { to }), { agent: AGENT_B })).statusCode, 404);
  assert.equal((await pay(f, payBody(3, { to }), { agent: 'not-a-uuid' })).statusCode, 404);
  // Someone else's payment: its withdrawal is not readable or signable by them.
  const mine = (await pay(f, payBody(4, { to }))).json() as Created;
  const foreign = await f.app.inject({
    url: withdrawalPath(mine.withdrawalId),
    headers: as('person-2'),
  });
  assert.equal(foreign.statusCode, 404);
  assert.equal(f.ops.state.prepares.length, 1);
});

test('rate limits: lookups, incoming reads and payments each have their own per-person bucket', async (t) => {
  const calls: Array<[string, number, number]> = [];
  const f = await setup(t, {
    limit: async (key, max, windowMs) => {
      calls.push([key, max, windowMs]);
    },
  });
  await juno(f);
  await lookup(f, '501', 'person-3');
  await incoming(f, 'person-2');
  await pay(f, payBody(1, { to: { lookupId: `pl_${'A'.repeat(32)}` } }));
  assert.deepEqual(calls, [
    ['pay-lookup:person-3', 30, 60_000],
    ['pay-incoming:person-2', 30, 60_000],
    ['pay-create:person-1', 20, 60_000],
  ]);
});

test('the body: amounts, notes, recipients and extra fields', async (t) => {
  const f = await setup(t);
  await juno(f);
  const to = { lookupId: await lookedUp(f) };
  const expect = async (payload: Record<string, unknown>, code: string) => {
    const res = await pay(f, 'to' in payload ? payload : { ...payload, to });
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)}: ${res.body}`);
    assert.equal(res.json().code, code, JSON.stringify(payload));
    return res;
  };
  for (const amount of ['0', '01', '1.5', '-1', '', 'max', 5, null, `1${'0'.repeat(78)}`])
    await expect(payBody(1, { amount }), 'invalid_amount');
  // At least 0.01 USDC.
  assert.equal(PAY_MIN_AMOUNT, 10_000n);
  for (const amount of ['1', '9999']) {
    const res = await expect(payBody(1, { amount }), 'amount_too_small');
    assert.deepEqual(res.json().min, { raw: '10000', decimals: 6, display: '0.01' });
  }
  for (const extra of [
    { token: 'ETH' },
    { chainId: OTHER_EXPECTED.chainId },
    { from: OUTSIDE },
    { verified: {} },
  ])
    await expect(payBody(1, extra), 'invalid_body');
  await expect({ to, amount: '20000' }, 'invalid_body');
  await expect(payBody(1, { idempotencyKey: 'not-a-uuid' }), 'invalid_body');
  for (const bad of [
    'CC-Juno01',
    { short: 'Juno01' },
    { baseId: '501' },
    { baseId: '501', wallet: WALLET_B },
    // What the browser saw is never taken from the browser: only the lookup it names.
    {
      baseId: '501',
      wallet: WALLET_B,
      verified: { block: 1000, blockHash: hash32('block-1000') },
      expiresAt: NOW + PAY_RECIPIENT_TTL_MS,
    },
    { ...to, baseId: '501' },
    { ...to, wallet: WALLET_B },
    { ...to, expiresAt: NOW + PAY_RECIPIENT_TTL_MS },
    { lookupId: 'x' },
    { lookupId: `pl_${'A'.repeat(31)}` },
    { lookupId: `pl_${'A'.repeat(31)}!` },
    { lookupId: 5 },
    {},
    null,
  ])
    await expect(payBody(1, { to: bad }), 'invalid_body');
  const flipped = WALLET_B.replace(/[a-f]/, (c) => c.toUpperCase());
  for (const address of [flipped, '0x1234'])
    await expect(payBody(1, { to: { address } }), 'invalid_address');
  // A note: at most 140 characters (code points), one line of plain text, display only. No
  // control or format character and no line or paragraph separator.
  const long = '\u{1F600}'.repeat(PAY_NOTE_MAX + 1);
  for (const note of [
    long,
    'a'.repeat(141),
    'two\nlines',
    'tab\there',
    'rtl‮evil',
    'line sep',
    'para sep',
    'arabic؜mark',
    'zero​width',
    'non‌joiner',
    'joi‍ner',
    'word⁠joiner',
    'byte﻿order',
    'soft­hyphen',
    7,
  ])
    await expect(payBody(1, { note }), 'invalid_note');
  const max = await pay(f, payBody(10, { to, note: '\u{1F600}'.repeat(PAY_NOTE_MAX) }));
  assert.equal(max.statusCode, 201, max.body);
  assert.equal([...(max.json() as Created).payment.note!].length, PAY_NOTE_MAX);
  const [stored] = await rows(f, 'base_wallet_payments');
  assert.equal([...(stored.note as string)].length, PAY_NOTE_MAX);
  assert.equal(f.ops.state.prepares.length, 1, 'only the valid payment was prepared');
});

test('a blank note is no note', async (t) => {
  const f = await setup(t);
  await juno(f);
  const res = await pay(f, payBody(1, { note: '   ' }));
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((res.json() as Created).payment.note, null);
});

test('with the flag off every pay route is 404', async (t) => {
  const f = await setup(t, { env: {} });
  await juno(f);
  assert.equal((await lookup(f, '501')).statusCode, 404);
  assert.equal(
    (await pay(f, payBody(1, { to: { lookupId: `pl_${'A'.repeat(32)}` } }))).statusCode,
    404,
  );
  assert.equal((await incoming(f, 'person-2')).statusCode, 404);
  assert.equal(f.base.state.reads.length, 0);
});

// --- schema -----------------------------------------------------------------------------------

test('migration 96: registered after 95, it only adds the safe notice', () => {
  registerBaseMigration();
  const versions = listMigrations().map((m) => m.version);
  assert.ok(versions.includes(96));
  assert.ok(versions.indexOf(96) > versions.indexOf(95));
  assert.equal(baseWalletWithdrawalsSafeMigration.name, 'base_wallet_withdrawals_safe');
  assert.equal(baseWalletWithdrawalsSafeMigration.sql, BASE_WALLET_WITHDRAWALS_SAFE_SQL);
  assert.doesNotMatch(
    BASE_WALLET_WITHDRAWALS_SAFE_SQL,
    /DROP (TABLE|COLUMN)|DELETE FROM|TRUNCATE/i,
  );
});

test('migration 91: registered after 89, its tables guard lookups and payment records', async (t) => {
  registerBaseMigration();
  const versions = listMigrations().map((m) => m.version);
  assert.ok(versions.includes(91));
  assert.ok(versions.indexOf(91) > versions.indexOf(89));
  assert.equal(baseWalletPaymentsMigration.name, 'base_wallet_payments');
  assert.ok(BASE_TABLES.includes('base_wallet_payments'));
  assert.ok(BASE_TABLES.includes('base_pay_lookups'));
  assert.doesNotMatch(BASE_WALLET_PAYMENTS_SQL, /DROP (TABLE|COLUMN)|DELETE FROM|TRUNCATE/i);

  const f = await setup(t);
  await juno(f);
  const created = (await pay(f, payBody(1))).json() as Created;
  const [row] = await rows(f, 'base_wallet_payments');
  const attempt = (changes: string) =>
    f.pg.query(`UPDATE base_wallet_payments SET ${changes} WHERE payment_id = $1`, [
      row.payment_id,
    ]);
  await assert.rejects(attempt(`note = '${'a'.repeat(141)}'`));
  await assert.rejects(attempt("note = ''"));
  await assert.rejects(attempt('verified_block = NULL'));
  await assert.rejects(attempt('lookup_id = NULL'));
  await assert.rejects(attempt("lookup_id = 'not-a-lookup'"));
  await assert.rejects(attempt('issued_block = NULL'));
  await assert.rejects(attempt('issued_expires_at = verified_at - 1'));
  await assert.rejects(attempt("issued_block_hash = '0x1234'"));
  await assert.rejects(attempt('amount_raw = 9999'));
  await assert.rejects(attempt("recipient_kind = 'address'"));
  await assert.rejects(attempt("token = 'ETH'"));
  await assert.rejects(attempt('chain_id = 31337'));
  await assert.rejects(attempt("withdrawal_id = 'no-such-withdrawal'"));
  // One payment per withdrawal.
  await assert.rejects(
    f.pg.query(
      `INSERT INTO base_wallet_payments (payment_id, withdrawal_id, chain_id, owner_account_id,
         sender_wallet_id, sender_agent_id, idempotency_key, request_hash, token, amount_raw,
         recipient_kind, recipient_address, recipient_agent_id, recipient_wallet_id,
         recipient_base_id, recipient_short_id, registry_address, lookup_id, issued_block,
         issued_block_hash, issued_expires_at, verified_block, verified_block_hash, verified_at,
         note, created_at)
       SELECT $1, withdrawal_id, chain_id, owner_account_id, sender_wallet_id, sender_agent_id,
         'other-key', request_hash, token, amount_raw, recipient_kind, recipient_address,
         recipient_agent_id, recipient_wallet_id, recipient_base_id, recipient_short_id,
         registry_address, lookup_id, issued_block, issued_block_hash, issued_expires_at,
         verified_block, verified_block_hash, verified_at, note, created_at
       FROM base_wallet_payments WHERE payment_id = $2`,
      [randomUUID(), row.payment_id],
    ),
  );
  assert.equal(row.withdrawal_id, created.withdrawalId);
  // A lookup: a random id of its own shape, an expiry after its issue, one format version.
  const [lookupRow] = await rows(f, 'base_pay_lookups');
  const lookupAttempt = (changes: string) =>
    f.pg.query(`UPDATE base_pay_lookups SET ${changes} WHERE lookup_id = $1`, [
      lookupRow.lookup_id,
    ]);
  await assert.rejects(lookupAttempt("lookup_id = 'pl_short'"));
  await assert.rejects(lookupAttempt('expires_at = issued_at'));
  await assert.rejects(lookupAttempt('version = 2'));
  await assert.rejects(lookupAttempt("block_hash = '0x12'"));
  // Every state change of a payment's withdrawal moves its change to that transaction.
  const before = (await rows(f, 'base_wallet_payments'))[0].change_xid;
  await sign(f, created);
  const after = (await rows(f, 'base_wallet_payments'))[0].change_xid;
  assert.ok(BigInt(String(after)) > BigInt(String(before)));
});

// --- the Base reader --------------------------------------------------------------------------

async function rpcMock(
  t: { after: (fn: () => Promise<unknown>) => void },
  network: { chainHex: string; registry: string } = WALLET_EXPECTED,
) {
  const state = {
    chain: network.chainHex,
    head: 1234n,
    owner: WALLET_B as string | null,
    mode: 'ok' as 'ok' | 'rpcError' | 'malformed',
    /** eth_call answers an error this many more times, then as `mode` says (a lagging node). */
    failCalls: 0,
    calls: [] as Array<{ method: string; params: unknown[] }>,
  };
  const blockHash = (n: bigint) => hash32(`rpc-block-${n}`);
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const call = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
      state.calls.push({ method: call.method, params: call.params });
      const send = (body: unknown) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(body));
      };
      const result = (value: unknown) => send({ jsonrpc: '2.0', id: call.id, result: value });
      if (call.method === 'eth_chainId') return result(state.chain);
      if (call.method === 'eth_getBlockByNumber') {
        assert.deepEqual(call.params, ['latest', false]);
        return result({
          number: `0x${state.head.toString(16)}`,
          hash: blockHash(state.head),
          parentHash: blockHash(state.head - 1n),
          timestamp: '0x1',
          transactions: [],
        });
      }
      if (call.method !== 'eth_call')
        return send({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'no' } });
      if (state.failCalls > 0) {
        state.failCalls -= 1;
        return {
          jsonrpc: '2.0',
          id: call.id,
          error: { code: -32000, message: 'header not found' },
        };
      }
      if (state.mode === 'rpcError')
        return send({ jsonrpc: '2.0', id: call.id, error: { code: -32603, message: 'internal' } });
      if (state.mode === 'malformed') return result('0x1234');
      const [tx, block] = call.params as [{ to: string; data: Hex }, unknown];
      // Exactly the block that was read: by its hash, canonical only.
      assert.deepEqual(block, { blockHash: blockHash(state.head), requireCanonical: true });
      assert.equal(getAddress(tx.to), MULTICALL3);
      const { args } = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
      const inner = args[0] as ReadonlyArray<{ target: string; callData: Hex }>;
      assert.equal(inner.length, 1);
      assert.equal(getAddress(inner[0].target), network.registry);
      const id = decodeFunctionData({ abi: identityRegistryAbi, data: inner[0].callData }).args[0];
      return result(
        encodeFunctionResult({
          abi: multicall3Abi,
          functionName: 'aggregate3',
          result: [
            state.owner
              ? {
                  success: true,
                  returnData: encodeFunctionResult({
                    abi: identityRegistryAbi,
                    functionName: 'ownerOf',
                    result: state.owner as Hex,
                  }),
                }
              : { success: false, returnData: `0x7e273289${String(id).padStart(64, '0')}` as Hex },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { state, blockHash, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('the Base reader: ownerOf at exactly the block it read, by number and hash', async (t) => {
  const rpc = await rpcMock(t);
  const reader = payChainReader(rpc.url, NETWORK, 3_000, async () => {});
  assert.equal(reader.registry, REGISTRY);
  assert.equal(reader.chainId, CHAIN_ID);
  assert.deepEqual(await reader.ownerOf('501'), {
    block: 1234n,
    blockHash: rpc.blockHash(1234n),
    owner: WALLET_B,
  });
  rpc.state.owner = null;
  assert.equal((await reader.ownerOf('501')).owner, null, 'ownerOf reverted: no such id');
  for (const mode of ['rpcError', 'malformed'] as const) {
    rpc.state.mode = mode;
    await assert.rejects(reader.ownerOf('501'), mode);
  }
  await assert.rejects(reader.ownerOf('0501'));
  assert.deepEqual(
    rpc.state.calls.map((c) => c.method).filter((m) => m === 'eth_chainId'),
    ['eth_chainId'],
    'the network is checked once',
  );
  // Another network never answers for the wallet network.
  const other = await rpcMock(t);
  other.state.chain = OTHER_EXPECTED.chainHex;
  await assert.rejects(payChainReader(other.url, NETWORK).ownerOf('501'));
  assert.ok(!other.state.calls.some((c) => c.method === 'eth_call'));
});

test('the Base reader tries a failed read again from a fresh head, at most 3 times; never a wrong network', async (t) => {
  const rpc = await rpcMock(t);
  const pauses: number[] = [];
  const reader = payChainReader(rpc.url, NETWORK, 3_000, async (ms) => void pauses.push(ms));
  const calls = () => rpc.state.calls.filter((c) => c.method === 'eth_call').length;
  // A node that hasn't seen the head yet answers the call with an error once: the next try reads.
  rpc.state.failCalls = 1;
  assert.equal((await reader.ownerOf('501')).owner, WALLET_B);
  assert.equal(calls(), 2);
  assert.deepEqual(pauses, [250]);
  // Twice failing still reads on the third try; a fresh head is read before each try.
  rpc.state.calls.length = 0;
  pauses.length = 0;
  rpc.state.failCalls = 2;
  assert.equal((await reader.ownerOf('501')).owner, WALLET_B);
  assert.equal(calls(), 3);
  assert.equal(rpc.state.calls.filter((c) => c.method === 'eth_getBlockByNumber').length, 3);
  assert.deepEqual(pauses, [250, 750]);
  // Failing every time: rejects after 3 tries, never "no owner".
  rpc.state.calls.length = 0;
  rpc.state.failCalls = 5;
  await assert.rejects(reader.ownerOf('501'));
  assert.equal(calls(), 3);
  rpc.state.failCalls = 0;
  // An invalid Base ID and another network are refused at once, never retried.
  rpc.state.calls.length = 0;
  await assert.rejects(reader.ownerOf('0501'));
  assert.equal(rpc.state.calls.length, 0);
  const other = await rpcMock(t);
  other.state.chain = OTHER_EXPECTED.chainHex;
  await assert.rejects(payChainReader(other.url, NETWORK, 3_000, async () => {}).ownerOf('501'));
  assert.equal(other.state.calls.filter((c) => c.method === 'eth_chainId').length, 1);
  assert.ok(!other.state.calls.some((c) => c.method === 'eth_call'));
});

test('the Base reader on Base: ownerOf in the canonical registry of Base mainnet, a local mock', async (t) => {
  // Where today's registrations live (chains.ts, the live registration flow).
  const mainnet = { chainHex: '0x2105', registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' };
  const rpc = await rpcMock(t, mainnet);
  const reader = payChainReader(rpc.url, BASE_NETWORKS[BASE_MAINNET]);
  assert.equal(reader.registry, mainnet.registry);
  assert.equal(reader.chainId, 8453);
  assert.deepEqual(await reader.ownerOf('424242'), {
    block: 1234n,
    blockHash: rpc.blockHash(1234n),
    owner: WALLET_B,
  });
  // A Base Sepolia endpoint never answers for Base.
  const sepolia = await rpcMock(t, mainnet);
  sepolia.state.chain = '0x14a34';
  await assert.rejects(payChainReader(sepolia.url, BASE_NETWORKS[BASE_MAINNET]).ownerOf('424242'));
  assert.ok(!sepolia.state.calls.some((c) => c.method === 'eth_call'));
});

// --- the app ----------------------------------------------------------------------------------

test('the app wires Pay behind CITY_BASE_WALLET and the request guard', async (t) => {
  const previous = process.env.CITY_BASE_WALLET;
  t.after(() => {
    if (previous === undefined) delete process.env.CITY_BASE_WALLET;
    else process.env.CITY_BASE_WALLET = previous;
  });
  const guarded = { 'content-type': 'application/json', 'x-city-request': '1' };
  for (const flag of [null, '1']) {
    if (flag === null) delete process.env.CITY_BASE_WALLET;
    else process.env.CITY_BASE_WALLET = flag;
    const app = await createApp({ dataDir: ':memory:', startWorkers: false });
    t.after(() => app.close());
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: guarded,
      payload: JSON.stringify({
        name: `Pay person ${flag}`,
        password: 'Synthetic pay owner password',
      }),
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const look = await app.inject({
      url: `/api/base/pay/recipient?q=${encodeURIComponent('https://evil.example/a/Juno01')}`,
      headers: { cookie },
    });
    const unknown = await app.inject({ url: '/api/base/pay/recipient?q=501', headers: { cookie } });
    const notices = await app.inject({ url: '/api/base/pay/incoming', headers: { cookie } });
    const payment = await app.inject({
      method: 'POST',
      url: `/api/base/agents/${randomUUID()}/wallet/payments`,
      headers: { ...guarded, cookie },
      payload: JSON.stringify(payBody(1)),
    });
    if (flag === null) {
      for (const res of [look, unknown, notices, payment]) assert.equal(res.statusCode, 404);
      continue;
    }
    assert.equal(look.statusCode, 400, look.body);
    assert.equal(look.json().code, 'invalid_query');
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().code, 'not_found');
    assert.deepEqual(notices.json(), { payments: [], cursor: null, hasMore: false });
    assert.equal(payment.statusCode, 404, 'not the wallet owner of an unknown agent');
    // Writes need the console's request guard.
    const unguarded = await app.inject({
      method: 'POST',
      url: `/api/base/agents/${randomUUID()}/wallet/payments`,
      headers: { 'content-type': 'application/json', cookie },
      payload: JSON.stringify(payBody(1)),
    });
    assert.equal(unguarded.statusCode, 403);
    // Payments have their own per-person bucket: 20 a minute (one went out above).
    const statuses: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/base/agents/${randomUUID()}/wallet/payments`,
        headers: { ...guarded, cookie },
        payload: JSON.stringify(payBody(1)),
      });
      statuses.push(res.statusCode);
    }
    assert.deepEqual(statuses, [...Array(19).fill(404), 429]);
    // Lookups and incoming reads are still answered: other buckets.
    assert.equal(
      (await app.inject({ url: '/api/base/pay/recipient?q=501', headers: { cookie } })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ url: '/api/base/pay/incoming', headers: { cookie } })).statusCode,
      200,
    );
  }
});

// The Pay screens' checks (src/base/wallet/pay.ts) on what this service really answers.
test("contract: the Pay screens' browser checks take the real lookup, payment and operation", async (t) => {
  const f = await setup(t);
  await juno(f);
  for (const q of ['501', 'CC-Juno01', `https://${PAY_PASSPORT_HOST}/a/Juno01`, 'Juno01']) {
    const answer = (await lookup(f, q)).json();
    const shown = clientCheckRecipient(answer, parseRecipient(q), f.clock.now);
    assert.equal(shown.wallet, WALLET_B, q);
  }
  // Looked up by the payer: a lookup is kept for the account that made it.
  const looked = (await lookup(f, 'CC-Juno01', 'person-1')).json();
  const shown = clientCheckRecipient(looked, parseRecipient('CC-Juno01'), f.clock.now);
  f.base.state.head = 1003n;
  f.clock.now += 2_000;
  const res = await pay(f, payBody(1, { to: clientPayTo(shown), note: 'for the logo' }));
  assert.equal(res.statusCode, 201, res.body);
  const request = res.json();
  const wallet = f.wallets[AGENT_A];
  const hash = clientCheckPayment({
    request,
    recipient: shown,
    amount: '2500000',
    wallet,
    owner: f.owner.address,
    agentId: AGENT_A,
    sponsors: SPONSORS,
  });
  assert.equal(hash, request.userOpHash);
  const intent = clientCheckedIntent(request, wallet);
  assert.equal(intent.to, WALLET_B);
  assert.equal(intent.amount, 2_500_000n);
});
