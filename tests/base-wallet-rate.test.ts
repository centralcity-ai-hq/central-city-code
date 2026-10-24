import assert from 'node:assert/strict';
import { AGENT_ROWS_SQL } from '../server/agent-rows/schema.js';
import { WORKSPACE_AGENT_PATH_SQL } from '../server/agent-rows/agent-lookup-schema.js';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import {
  concat,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  keccak256,
  numberToHex,
  parseAbi,
  parseAbiItem,
  recoverAddress,
  toFunctionSelector,
  toHex,
  TransactionReceiptNotFoundError,
  zeroAddress,
  zeroHash,
  type Hex,
  type PublicClient,
} from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Database } from '../server/database.js';
import {
  BASE_IDENTITY_PROVISIONAL_SQL,
  BASE_IDENTITY_HANDOVER_BACKOFF_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_TABLES,
  BASE_SPONSOR_EXPOSURE_SQL,
  BASE_WALLET_WITHDRAWALS_SAFE_SQL,
  BASE_WALLET_LANES_SQL,
  BASE_WALLET_LIMITS_SQL,
  BASE_WALLET_ONE_UNSIGNED_SQL,
  BASE_WALLET_PAYMENTS_SQL,
  BASE_WALLET_RATINGS_SQL,
  BASE_WALLET_VAULT_SQL,
  BASE_WALLET_WITHDRAWALS_SQL,
  baseShortIdsMigration,
  baseWalletRatingsMigration,
  registerBaseMigration,
} from '../server/base/schema.js';
import { listMigrations } from '../server/migrations.js';
import { registerBaseWalletRoutes } from '../server/base/wallet/routes.js';
import { accountIndexFor } from '../server/base/wallet/service.js';
import type { ChainRuntime } from '../server/base/identity/routes.js';
import type { BalanceReader } from '../server/base/chain/balances.js';
import { agentWalletRecipe, deriveAddressLocal } from '../server/base/chain/derive.js';
import {
  createOwnerOperationsPort,
  OWNER_NONCE_KEY,
  type OwnerOperationsPort,
} from '../server/base/chain/owner-ops.js';
import { walletSignature } from '../server/base/chain/permissions.js';
import { rpcBundler } from '../server/base/chain/rpc-bundler.js';
import { pgChainOperationStore } from '../server/base/chain/stores.js';
import type { PayChainReader } from '../server/base/pay/chain.js';
import {
  RATE_DAILY_MAX,
  RATE_DAILY_MAX_SETTING,
  RATE_SETTING,
  rateDailyMax,
} from '../server/base/rate/service.js';
import { RATE_PATHS, RATE_RATES, RATE_STATUS_PATH } from '../server/base/rate/routes.js';
import { RATING_AMOUNT, TX_EXPLORER } from '../server/base/wallet/withdrawals.js';
import { type Address } from '../shared/base/chains.js';
import {
  decodeRateCall,
  encodeRateCall,
  giveFeedbackAbi,
  RATE_PATHS as SHARED_RATE_PATHS,
  RATE_REGISTRY,
  rateCall,
  starsValue,
  type RateLookup,
} from '../shared/base/rate.js';
import { laneKey, laneNonce } from '../shared/base/lanes.js';
import { AGENT_URI_ORIGIN } from '../shared/base/on-base.js';
import { PAY_RECIPIENT_TTL_MS } from '../shared/base/pay.js';
import { sponsoredWithoutCharge } from '../shared/base/paymasters.js';
import { calendarPeriod } from '../shared/base/spend-limits.js';
import {
  decodeOwnerCall,
  ownerOperationHash,
  userOperationFromRpc,
  userOperationToRpc,
  withdrawalCall,
  WITHDRAWAL_SIGNATURE_TTL_MS,
  type RpcUserOperation,
} from '../shared/base/withdraw.js';
import {
  checkRateOperation,
  checkRateTarget,
  checkRatingWindow,
  RatingCheckError,
  RatingWindowError,
  type RateSigningRequest,
} from '../src/base/wallet/rate.js';
import { SIGNING_CLOCK_SKEW_MS } from '../src/base/wallet/withdraw.js';
import { WALLET_EXPECTED, WALLET_NET } from './wallet-network-fixture.js';

/**
 * Operation Rating R1 (server) without any network: the wallet routes (withdrawals, Pay, Rate) and
 * the owner-operations port with its durable chain path run for real on PGlite, with a synthetic
 * sponsor allowlist; Base is a fake node, the bundler/paymaster a local JSON-RPC stand-in, the
 * balance and ownerOf readers in-memory. The owner keys are throwaway local accounts; all else is
 * synthetic. The rating call is shared/base/rate.ts, and every prepared rating is checked with the
 * browser's own checkRateOperation (src/base/wallet/rate.ts) before it is signed here.
 */
const NETWORK = WALLET_NET;
const CHAIN_ID = WALLET_EXPECTED.chainId;
const REGISTRY = WALLET_EXPECTED.registry;
/** The Reputation Registry proxy on Base, as checked on Base (the literal, not the constant). */
const REPUTATION_PROXY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const ENTRY_POINT = NETWORK.contracts.entryPointV06;
const PAYMASTER = getAddress(`0x${'7a'.repeat(20)}`);
const SPENDER = getAddress(`0x${'3c'.repeat(20)}`);
/** 11 Oct 2026, 10:00 Berlin. */
const NOW = Date.UTC(2026, 9, 11, 8, 0, 0);
const json = { 'content-type': 'application/json' };
const USDC = NETWORK.tokens.USDC.address;
const SEQ_MASK = 2n ** 64n - 1n;
/** How far behind the head Base's finalized tag is on the fake node. */
const SETTLE_DEPTH = 3n;
const RATE_ON = { CITY_BASE_WALLET: '1', [RATE_SETTING]: '1' };

// Agents (synthetic ids): A rates; A2 is person-1's other agent; B, C belong to person-2.
const AGENT_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const AGENT_A2 = '0a0a0a0a-0000-4000-8000-0000000000a2';
const AGENT_A3 = '0a0a0a0a-0000-4000-8000-0000000000a3';
const AGENT_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const AGENT_C = '0c0c0c0c-0000-4000-8000-00000000000c';
const AGENT_D = '0d0d0d0d-0000-4000-8000-00000000000d';
const OWNER_2 = privateKeyToAccount(generatePrivateKey());
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
const vaultWallet = (agentId: string) =>
  deriveAddressLocal(agentWalletRecipe(NETWORK, OWNER_2.address, accountIndexFor(agentId)));
const WALLET_B = vaultWallet(AGENT_B);
const WALLET_C = vaultWallet(AGENT_C);
const WALLET_D = vaultWallet(AGENT_D);
const OUTSIDE = getAddress(`0x${'5e'.repeat(20)}`);

const key = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const hash32 = (label: string) => keccak256(toHex(label));

/** Base as the rate service reads it: ownerOf of several Base IDs at the head block. */
function fakeBase() {
  const state = {
    head: 1000n,
    owners: new Map<string, Address>(),
    down: false,
    reads: [] as string[][],
    /** Runs inside every read (after the lookup was resolved and the cap counted). */
    duringRead: null as null | (() => Promise<void>),
    /** Another branch: the same heights carry other hashes (a block was dropped). */
    fork: 0,
  };
  const at = () => ({
    block: state.head,
    blockHash: hash32(`block-${state.head}${state.fork ? `-fork-${state.fork}` : ''}`),
  });
  const reader: PayChainReader = {
    registry: REGISTRY,
    chainId: CHAIN_ID,
    async ownerOf(baseId) {
      if (state.down) throw new Error('node unreachable');
      return { ...at(), owner: state.owners.get(baseId) ?? null };
    },
    async ownersOf(baseIds) {
      state.reads.push([...baseIds]);
      if (state.down) throw new Error('node unreachable');
      const during = state.duringRead;
      state.duringRead = null;
      await during?.();
      return { ...at(), owners: baseIds.map((id) => state.owners.get(id) ?? null) };
    },
  };
  return { state, reader };
}

const SPONSORS = { [CHAIN_ID]: [PAYMASTER] };
/** A verifying paymaster's answer: validUntil (seconds, 0 = unbounded), validAfter 0, then n. */
function sponsorData(n: number, validUntil = 0): Hex {
  return concat([
    PAYMASTER,
    numberToHex(validUntil, { size: 6 }),
    numberToHex(0, { size: 6 }),
    numberToHex(n, { size: 16 }),
    '0x000000',
    zeroAddress,
    zeroAddress,
    numberToHex(0, { size: 32 }),
    numberToHex(0, { size: 6 }),
    `0x${'ab'.repeat(65)}`,
  ]);
}

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

/**
 * The owner-operations port as production builds it (owner-ops.ts over the durable chain path, the
 * JSON-RPC bundler, the synthetic sponsor allowlist), on a fake node and a local bundler/paymaster
 * stand-in that checks the nonce, deployment and the owner's signature like the wallet.
 */
function fakeOperations(db: Database, now: () => number, owners: Map<string, Address[]>) {
  const state = {
    head: 1000n,
    sponsor: true,
    /** The validUntil (seconds) the paymaster signs: by default exactly the signing deadline. */
    sponsorValidUntil: () => Math.floor((now() + WITHDRAWAL_SIGNATURE_TTL_MS) / 1000),
    /** How far behind the head Base's safe tag is (before final). */
    safeDepth: SETTLE_DEPTH,
    paymasterCalls: 0,
    prepares: [] as Array<{ ownerFunded: boolean; to: string }>,
    code: new Set<string>([ENTRY_POINT.toLowerCase(), USDC.toLowerCase()]),
    nonces: new Map<string, bigint>(),
    pool: new Map<string, UserOperation<'0.6'>>(),
    landed: new Map<
      string,
      { txHash: Hex; blockNumber: bigint; sender: Address; nonce: bigint; success: boolean }
    >(),
    sends: [] as Hex[],
  };
  /** Each nonce lane its own sequence: the shared lane (0) by sender, others by sender and key. */
  const laneOf = (sender: string, key: bigint) =>
    key === 0n ? sender.toLowerCase() : `${sender.toLowerCase()}:${key}`;
  const blockHash = (n: bigint) => keccak256(toHex(`node-block-${n}`));
  const client = {
    getCode: async ({ address }: { address: string }) =>
      state.code.has(address.toLowerCase()) ? '0x6080' : undefined,
    readContract: async (call: { functionName: string; args: [string, bigint] }) => {
      assert.equal(call.functionName, 'getNonce');
      const [sender, laneKey] = call.args;
      return (laneKey << 64n) | (state.nonces.get(laneOf(sender, laneKey)) ?? 0n);
    },
    getBlockNumber: async () => state.head,
    getBlock: async (args: { blockNumber?: bigint; blockTag?: string } = {}) => {
      if (args.blockNumber !== undefined)
        return { number: args.blockNumber, hash: blockHash(args.blockNumber) };
      if (args.blockTag === 'finalized')
        return { number: state.head - SETTLE_DEPTH, hash: blockHash(state.head - SETTLE_DEPTH) };
      if (args.blockTag === 'safe')
        return {
          number: state.head - state.safeDepth,
          hash: blockHash(state.head - state.safeDepth),
        };
      return { number: state.head, hash: blockHash(state.head), baseFeePerGas: 500_000n };
    },
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
        blockHash: blockHash(hit.blockNumber),
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
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 2_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    }),
  } as unknown as PublicClient;

  async function bundle(method: string, params: unknown[]): Promise<unknown> {
    if (method === 'pm_getPaymasterStubData') {
      if (!state.sponsor) throw new Error('sponsorship policy rejected the operation');
      return { paymasterAndData: sponsorData(0, state.sponsorValidUntil()) };
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
      return {
        paymasterAndData: sponsorData(state.paymasterCalls, state.sponsorValidUntil()),
      };
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
    if ((op.nonce & SEQ_MASK) !== (state.nonces.get(laneOf(sender, op.nonce >> 64n)) ?? 0n))
      throw new Error('AA25 invalid account nonce');
    const deployed = state.code.has(sender);
    if ((op.initCode !== '0x') === deployed) throw new Error('AA10/AA20 deployment mismatch');
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
    maxCostWeiCap: 10n ** 18n,
    sponsors: SPONSORS,
    now,
  });
  const port: OwnerOperationsPort = {
    ...real,
    chainId: real.chainId,
    entryPoint: real.entryPoint,
    prepare(input) {
      state.prepares.push({ ownerFunded: input.ownerFunded === true, to: input.calls[0].target });
      return real.prepare(input);
    },
  };

  function include(userOpHash: string) {
    const op = state.pool.get(userOpHash);
    assert.ok(op, 'the operation was sent');
    state.head += 1n;
    const sender = op.sender.toLowerCase();
    state.nonces.set(laneOf(sender, op.nonce >> 64n), (op.nonce & SEQ_MASK) + 1n);
    if (op.initCode && op.initCode !== '0x') state.code.add(sender);
    state.landed.set(userOpHash, {
      txHash: keccak256(concat([userOpHash as Hex, '0x01'])),
      blockNumber: state.head,
      sender: getAddress(op.sender),
      nonce: op.nonce,
      success: true,
    });
    state.pool.delete(userOpHash);
  }
  /** The operation lands ('included'), then gets its confirmations ('final'). */
  const land = (userOpHash: string, status: 'included' | 'final') => {
    if (!state.landed.has(userOpHash)) include(userOpHash);
    if (status === 'final') state.head += SETTLE_DEPTH;
  };
  const mine = (n: number) => {
    state.head += BigInt(n);
  };
  return { state, port, land, mine };
}

interface Options {
  env?: Record<string, string | undefined>;
  noChain?: boolean;
  /** The schema as it was before migration 94 (the test applies it later). */
  before94?: boolean;
}

async function setup(t: { after: (fn: () => Promise<unknown>) => void }, options: Options = {}) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('person-1','owner'), ('person-2','owner'), ('person-3','owner');
    CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL);
    INSERT INTO workspaces VALUES ('person-1', '{"agents": []}'), ('person-2', '{"agents": []}');
    INSERT INTO operators VALUES ('ai-ws-1', 'ai');
    INSERT INTO workspaces VALUES ('ai-ws-1', '{"agents": []}');
    CREATE TABLE operator_links (human_operator_id text NOT NULL, ai_operator_id text NOT NULL, role text);
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);`);
  for (const sql of [
    BASE_MIGRATION_SQL,
    BASE_PAYMENTS_MIGRATION_SQL,
    baseShortIdsMigration.sql,
    BASE_SHARED_ADDITIONS_SQL,
    BASE_IDENTITY_PROVISIONAL_SQL,
    BASE_IDENTITY_HANDOVER_BACKOFF_SQL,
    BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
    BASE_WALLET_VAULT_SQL,
    BASE_WALLET_WITHDRAWALS_SQL,
    BASE_WALLET_PAYMENTS_SQL,
    // Spending-limit revokes (90) and the safe-head gate 2 (93), as every withdrawal suite.
    BASE_WALLET_LIMITS_SQL,
    BASE_WALLET_ONE_UNSIGNED_SQL,
    ...(options.before94 ? [] : [BASE_WALLET_RATINGS_SQL]),
    // Pay without waiting (95): before ratings when they come later, so both orders apply.
    BASE_WALLET_LANES_SQL,
    // The recipient's safe notice (96), then the sponsor's exposure in flight (97).
    BASE_WALLET_WITHDRAWALS_SAFE_SQL,
    BASE_SPONSOR_EXPOSURE_SQL,
    // workspace_agent() (245, then 254), which the public name reads the agent through.
    AGENT_ROWS_SQL,
    WORKSPACE_AGENT_PATH_SQL,
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
  const ops = fakeOperations(db, () => clock.now, signers);
  const owner = privateKeyToAccount(generatePrivateKey());
  await pg.query(
    `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key, kdf_params,
       cipher_params, version, backup_confirmed_at, created_at, updated_at)
     VALUES ('person-1', $1, decode($2, 'hex'), '{}', '{}', 1, $3, 1, 1),
            ('person-2', $4, decode($2, 'hex'), '{}', '{}', 1, $3, 1, 1)`,
    [owner.address, '5a'.repeat(48), NOW - 1_000, OWNER_2.address],
  );
  // person-1's agents: owner-vault wallets on the wallet network, as W1 creates them.
  const wallets: Record<string, Address> = {};
  for (const agentId of [AGENT_A, AGENT_A2, AGENT_A3]) {
    const recipe = agentWalletRecipe(NETWORK, owner.address, accountIndexFor(agentId));
    wallets[agentId] = deriveAddressLocal(recipe);
    signers.set(wallets[agentId].toLowerCase(), recipe.owners);
    await wallet(db, {
      agentId,
      workspace: 'person-1',
      address: wallets[agentId],
      ownerAddress: owner.address,
      ownerAccount: 'person-1',
      derivation: derivationOf(owner.address, agentId),
    });
  }
  for (const agentId of [AGENT_B, AGENT_C, AGENT_D])
    signers.set(vaultWallet(agentId).toLowerCase(), [OWNER_2.address]);
  await manifest(db, AGENT_A, 'person-1', 'Harbor');
  await manifest(db, AGENT_A2, 'person-1', 'Harbor Two');
  await manifest(db, AGENT_A3, 'person-1', 'Harbor Three');
  const balances: BalanceReader = {
    balances: async () => ({
      usdc: 5_000_000n,
      eth: 10n ** 15n,
      deployed: true,
      blockNumber: base.state.head,
    }),
  };
  const runtime: ChainRuntime = {
    walletPort: {} as ChainRuntime['walletPort'],
    identityPort: {} as ChainRuntime['identityPort'],
    ownerOperations: ops.port,
  };
  const limits: string[] = [];
  const app = Fastify();
  t.after(() => app.close());
  registerBaseWalletRoutes(app, {
    db,
    env: options.env ?? RATE_ON,
    currentPerson: async (request) => {
      const who = request.headers['x-test-person'];
      return typeof who === 'string' ? { id: who } : null;
    },
    currentWorkspace: async (request) => ({ id: request.headers['x-test-person'] as string }),
    runtime: async () => runtime,
    balances,
    payChain: options.noChain ? undefined : base.reader,
    limit: async (bucket, max, windowMs) => {
      limits.push(`${bucket}/${max}/${windowMs}`);
    },
    now: () => clock.now,
  });
  return { app, pg, db, clock, base, ops, owner, wallets, limits };
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
    ownerAddress: string;
    ownerAccount: string | null;
    derivation: unknown;
  },
) {
  await db.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at, owner_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'v1:00000000-0000-4000-8000-000000000000', $8, 'derived',
       1, 1, $9)`,
    [
      `wallet-${w.agentId}`,
      w.agentId,
      w.workspace,
      CHAIN_ID,
      w.address,
      w.ownerAddress,
      SPENDER,
      JSON.stringify(w.derivation),
      w.ownerAccount,
    ],
  );
}

/** A registration as the identity service leaves it (confirmed, final, on Base, unless said). */
async function register(
  f: Fixture,
  r: {
    agentId: string;
    baseId: string;
    short: string;
    /** A new person-2 vault wallet at this address (else the agent's existing wallet). */
    wallet?: Address;
    workspace?: string;
    name?: string;
    state?: 'confirmed' | 'submitted';
    /** The wallet's owner account; null: a wallet from before the vault. */
    ownerAccount?: string | null;
    onChain?: boolean;
  },
) {
  const workspace = r.workspace ?? 'person-2';
  if (r.wallet) {
    await wallet(f.db, {
      agentId: r.agentId,
      workspace,
      address: r.wallet,
      ownerAddress: OWNER_2.address,
      ownerAccount: r.ownerAccount === undefined ? workspace : r.ownerAccount,
      derivation: derivationOf(OWNER_2.address, r.agentId),
    });
    await manifest(f.db, r.agentId, workspace, r.name ?? `Agent ${r.baseId}`);
  }
  const address = r.wallet ?? f.wallets[r.agentId];
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
      CHAIN_ID,
      workspace,
      REGISTRY,
      confirmed ? r.baseId : null,
      `${AGENT_URI_ORIGIN}/a/${r.short}`,
      address,
      confirmed ? 'confirmed' : 'submitted',
      `identity:transfer:${CHAIN_ID}:${r.agentId}~${r.baseId}`,
      `identity:register:${CHAIN_ID}:${r.agentId}`,
      r.baseId,
      confirmed ? 'final' : 'safe',
    ],
  );
  if (r.onChain !== false) f.base.state.owners.set(r.baseId, getAddress(address));
}

/** The rater: person-1's agent A (Harbor), Base ID 700, passport CC-Harbr1. */
const harbor = (f: Fixture) =>
  register(f, { agentId: AGENT_A, baseId: '700', short: 'Harbr1', workspace: 'person-1' });
/** The rated: person-2's agent B (Juno), Base ID 501, passport CC-Juno01. */
const juno = (f: Fixture) =>
  register(f, { agentId: AGENT_B, baseId: '501', short: 'Juno01', wallet: WALLET_B, name: 'Juno' });
const both = async (f: Fixture) => {
  await harbor(f);
  await juno(f);
};

const as = (person?: string) => ({ ...json, ...(person ? { 'x-test-person': person } : {}) });
const path = (template: string, agent: string) => template.replace(':agentId', agent);

/** The typed values that name Juno (person-2's agent B) and Harbor (person-1's agent A). */
const JUNO: RateLookup = { baseId: '501', passport: 'Juno01' };
const HARBOR: RateLookup = { baseId: '700', passport: 'Harbr1' };

/** POST …/ratings/lookup with exactly this body (a RateLookup, or anything else to refuse). */
const lookup = (f: Fixture, body: unknown, opts: { person?: string; agent?: string } = {}) =>
  f.app.inject({
    method: 'POST',
    url: path(RATE_PATHS.lookup, opts.agent ?? AGENT_A),
    headers: as(opts.person ?? 'person-1'),
    payload: JSON.stringify(body),
  });

async function lookedUp(f: Fixture, typed: RateLookup = JUNO, agent = AGENT_A): Promise<string> {
  const res = await lookup(f, typed, { agent });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().lookupId as string;
}

const status = (f: Fixture, opts: { person?: string; agent?: string } = {}) =>
  f.app.inject({
    url: path(RATE_STATUS_PATH, opts.agent ?? AGENT_A),
    headers: as(opts.person ?? 'person-1'),
  });

/** The browser's check of a prepared rating (src/base/wallet/rate.ts), with person-1's key. */
const browserCheck = (
  f: Fixture,
  request: Created,
  expected: { baseId: string; stars: 1 | 2 | 3 | 4 | 5 },
  agentId = AGENT_A,
) =>
  checkRateOperation({
    request: request as unknown as RateSigningRequest,
    wallet: f.wallets[agentId],
    owner: f.owner.address,
    agentId,
    expected,
    raterBaseId: '700',
    sponsors: SPONSORS,
    // With lanes on, the lane the browser derives from the rating's own id (as WalletRateScreen).
    lane: (request as unknown as RateSigningRequest).lanes
      ? { withdrawalId: (request as unknown as RateSigningRequest).withdrawalId }
      : undefined,
  });
async function rate(
  f: Fixture,
  payload: Record<string, unknown>,
  opts: { person?: string; agent?: string } = {},
) {
  const body =
    'to' in payload
      ? payload
      : { ...payload, to: { lookupId: await lookedUp(f, JUNO, opts.agent ?? AGENT_A) } };
  return f.app.inject({
    method: 'POST',
    url: path(RATE_PATHS.ratings, opts.agent ?? AGENT_A),
    headers: as(opts.person ?? 'person-1'),
    payload: JSON.stringify(body),
  });
}

const rateBody = (n: number, stars: unknown = 4) => ({ idempotencyKey: key(n), stars });

interface Created {
  withdrawalId: string;
  state: string;
  userOperation: RpcUserOperation;
  userOpHash: Hex;
  entryPoint: string;
  chainId: number;
  expiresAt: number;
  summary: Record<string, unknown>;
}

async function rated(f: Fixture, n: number, stars = 4): Promise<Created> {
  const res = await rate(f, rateBody(n, stars));
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as Created;
}

const withdrawalPath = (id: string, agent = AGENT_A) =>
  `/api/base/agents/${agent}/wallet/withdrawals/${id}`;

async function sign(f: Fixture, body: { withdrawalId: string; userOpHash: Hex }) {
  return f.app.inject({
    method: 'POST',
    url: `${withdrawalPath(body.withdrawalId)}/signature`,
    headers: as('person-1'),
    payload: JSON.stringify({ signature: await f.owner.sign({ hash: body.userOpHash }) }),
  });
}

const read = (f: Fixture, id: string) =>
  f.app.inject({ url: withdrawalPath(id), headers: as('person-1') });

const withdraw = (f: Fixture, n: number) =>
  f.app.inject({
    method: 'POST',
    url: `/api/base/agents/${AGENT_A}/wallet/withdrawals`,
    headers: as('person-1'),
    payload: JSON.stringify({
      idempotencyKey: key(n),
      token: 'USDC',
      amount: '1000000',
      to: OUTSIDE,
    }),
  });

/** The sponsor's most expensive gas for an operation as prepared (EntryPoint v0.6, a paymaster). */
const sponsorBound = (op: RpcUserOperation) => {
  const parsed = userOperationFromRpc(op);
  return (
    (parsed.callGasLimit + parsed.verificationGasLimit * 3n + parsed.preVerificationGas) *
    parsed.maxFeePerGas
  );
};

async function rows(f: Fixture, table: string) {
  return (await f.pg.query<Record<string, unknown>>(`SELECT * FROM ${table}`)).rows;
}

const ratingRows = async (f: Fixture) =>
  (await rows(f, 'base_wallet_withdrawals')).filter((row) => row.kind === 'rate');

/** Ratings made directly in the table (each in its own unsigned, expired state). */
async function seedRatings(f: Fixture, count: number, createdAt: number, from = 1) {
  await f.pg.query(
    `INSERT INTO base_wallet_withdrawals (withdrawal_id, wallet_id, owner_account_id, chain_id,
       kind, rated_agent_id, rated_base_id, rating_value, idempotency_key, request_hash, state,
       nonce, user_operation, user_op_hash, expires_at, created_at, updated_at)
     SELECT 'seed-' || n, $1, 'person-1', $2, 'rate', $3, 501, 80, 'seed-key-' || n, $4,
       'expired', 0, '{}', $4, $5, $5, $5
     FROM generate_series($6::int, $7::int) n`,
    [
      `wallet-${AGENT_A}`,
      CHAIN_ID,
      AGENT_B,
      `0x${'ab'.repeat(32)}`,
      createdAt,
      from,
      from + count - 1,
    ],
  );
}

// --- the call -----------------------------------------------------------------------------------

const executeAbi = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
]);
const feedbackAbi = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
]);
const execute = (target: Address, value: bigint, data: Hex) =>
  encodeFunctionData({ abi: executeAbi, functionName: 'execute', args: [target, value, data] });
const feedback = (
  args: Partial<{
    id: bigint;
    value: bigint;
    decimals: number;
    tag1: string;
    tag2: string;
    endpoint: string;
    uri: string;
    hash: Hex;
  }> = {},
) =>
  encodeFunctionData({
    abi: feedbackAbi,
    functionName: 'giveFeedback',
    args: [
      args.id ?? 501n,
      args.value ?? 80n,
      args.decimals ?? 0,
      args.tag1 ?? 'starred',
      args.tag2 ?? '',
      args.endpoint ?? '',
      args.uri ?? '',
      args.hash ?? zeroHash,
    ],
  });

test('the rating call: the shared one, on the pinned registry proxy, exact fields only', () => {
  assert.equal(RATE_REGISTRY, REPUTATION_PROXY);
  assert.equal(toFunctionSelector(giveFeedbackAbi[0]), '0x3c036a7e');
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((stars) => starsValue(stars as 1 | 2 | 3 | 4 | 5)),
    [20n, 40n, 60n, 80n, 100n],
  );
  // The server and the browser share one routes table.
  assert.deepEqual(RATE_PATHS, SHARED_RATE_PATHS);
  const call = rateCall(501n, 4);
  assert.equal(call.target, REPUTATION_PROXY);
  assert.equal(call.value, 0n);
  assert.equal(call.data.slice(0, 10), '0x3c036a7e');
  assert.equal(call.data, feedback());
  const good = execute(REPUTATION_PROXY, 0n, feedback());
  assert.equal(encodeRateCall(501n, 4), good);
  const someWallet = getAddress(`0x${'11'.repeat(20)}`);
  assert.deepEqual(decodeRateCall(good, someWallet), { agentId: 501n, stars: 4 });
  // A rating is never a transfer.
  assert.equal(decodeOwnerCall(good, someWallet), null);
  for (const [label, data] of [
    ['another target', execute(USDC, 0n, feedback())],
    ['ETH sent along', execute(REPUTATION_PROXY, 1n, feedback())],
    ['value 50', execute(REPUTATION_PROXY, 0n, feedback({ value: 50n }))],
    ['value 0', execute(REPUTATION_PROXY, 0n, feedback({ value: 0n }))],
    ['value -20', execute(REPUTATION_PROXY, 0n, feedback({ value: -20n }))],
    ['Base ID 0', execute(REPUTATION_PROXY, 0n, feedback({ id: 0n }))],
    ['decimals 1', execute(REPUTATION_PROXY, 0n, feedback({ decimals: 1 }))],
    ['tag1', execute(REPUTATION_PROXY, 0n, feedback({ tag1: 'Starred' }))],
    ['tag2', execute(REPUTATION_PROXY, 0n, feedback({ tag2: 'x' }))],
    ['endpoint', execute(REPUTATION_PROXY, 0n, feedback({ endpoint: 'https://x' }))],
    ['feedbackURI', execute(REPUTATION_PROXY, 0n, feedback({ uri: 'ipfs://x' }))],
    ['feedbackHash', execute(REPUTATION_PROXY, 0n, feedback({ hash: hash32('x') }))],
    ['trailing bytes inside', execute(REPUTATION_PROXY, 0n, `${feedback()}00` as Hex)],
    ['trailing bytes outside', `${good}00` as Hex],
    [
      'a batch',
      encodeFunctionData({
        abi: executeAbi,
        functionName: 'executeBatch',
        args: [[{ target: REPUTATION_PROXY, value: 0n, data: feedback() }]],
      }),
    ],
    ['a transfer', execute(USDC, 0n, withdrawalCall('USDC', OUTSIDE, 1n).data)],
    ['revokeFeedback', execute(REPUTATION_PROXY, 0n, '0x4ab3ca99' as Hex)],
  ] as const)
    assert.equal(decodeRateCall(data, someWallet), null, label);
  assert.throws(() => rateCall(0n, 4));
});

// --- gate and lookup ------------------------------------------------------------------------------

test('off by default: without CITY_BASE_RATE (or without wallets) every rating route is 404', async (t) => {
  for (const env of [{ CITY_BASE_WALLET: '1' }, { [RATE_SETTING]: '1' }, {}]) {
    const f = await setup(t, { env });
    await both(f);
    const res = await lookup(f, JUNO);
    assert.equal(res.statusCode, 404, JSON.stringify(env));
    assert.deepEqual(res.json(), { error: 'Not found.' });
    const created = await rate(f, { ...rateBody(1), to: { lookupId: `rl_${'a'.repeat(32)}` } });
    assert.equal(created.statusCode, 404);
    assert.deepEqual(created.json(), { error: 'Not found.' });
    const off = await status(f);
    assert.equal(off.statusCode, 404);
    assert.deepEqual(off.json(), { error: 'Not found.' });
    assert.equal(f.base.state.reads.length, 0);
    assert.equal(f.ops.state.prepares.length, 0);
  }
});

test('status: {enabled: true} for the rater agent’s owner while ratings are on, 404 otherwise', async (t) => {
  const f = await setup(t);
  const on = await status(f);
  assert.equal(on.statusCode, 200, on.body);
  assert.deepEqual(on.json(), { enabled: true });
  // Owner-only, as every wallet route: another person, nobody, or not an agent of theirs.
  assert.equal((await status(f, { person: 'person-2' })).statusCode, 404);
  assert.equal((await status(f, { person: 'person-3' })).statusCode, 404);
  assert.equal((await status(f, { person: '' })).statusCode, 401);
  assert.equal((await status(f, { agent: AGENT_B })).statusCode, 404);
  assert.equal((await status(f, { agent: 'not-a-uuid' })).statusCode, 404);
  // It reads nothing on Base and prepares nothing.
  assert.equal(f.base.state.reads.length, 0);
  assert.equal(f.ops.state.prepares.length, 0);
});

test('lookup: the Base ID and the passport both name the agent, both owners read at one block', async (t) => {
  const f = await setup(t);
  await both(f);
  const res = await lookup(f, JUNO);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  // Exactly shared/base/rate.ts RateTarget.
  assert.deepEqual(Object.keys(body).sort(), ['agent', 'checkedAtBlock', 'expiresAt', 'lookupId']);
  assert.match(body.lookupId, /^rl_[0-9A-Za-z_-]{32}$/);
  assert.deepEqual(body.agent, { agentId: AGENT_B, name: 'Juno', baseId: '501', short: 'Juno01' });
  assert.equal(body.checkedAtBlock, 1000);
  assert.equal(body.expiresAt, NOW + PAY_RECIPIENT_TTL_MS);
  // The browser's own check of the answer accepts it for what was typed, for rater A.
  assert.deepEqual(checkRateTarget(body, JUNO, NOW, AGENT_A), body);
  // One read per lookup, both Base IDs in it (the rated agent's first).
  assert.deepEqual(f.base.state.reads.at(-1), ['501', '700']);
  // The same lookup at the same block answers the same id; a new block a new one.
  const one = body.lookupId;
  assert.equal((await lookup(f, JUNO)).json().lookupId, one);
  f.base.state.head += 1n;
  assert.notEqual((await lookup(f, JUNO)).json().lookupId, one);
  assert.deepEqual(f.limits.slice(0, 1), [`rate-lookup:person-1/30/60000`]);
  assert.deepEqual(RATE_RATES.lookup, { prefix: 'rate-lookup', max: 30, windowMs: 60_000 });
  assert.equal(f.ops.state.prepares.length, 0, 'a lookup prepares nothing');
  const [stored] = await rows(f, 'base_rate_lookups');
  assert.equal(stored.short_id, 'Juno01');
  assert.equal(stored.rater_agent_id, AGENT_A);
});

test('lookup body: both values, exactly as typed; no link, no "CC-", no free text, no address', async (t) => {
  const f = await setup(t);
  await both(f);
  const refused = async (body: unknown, code: string) => {
    const res = await lookup(f, body);
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)}: ${res.body}`);
    assert.equal(res.json().code, code, JSON.stringify(body));
  };
  // The shape: both fields, strings, nothing else (the old free-text target is gone).
  for (const body of [
    {},
    { baseId: '501' },
    { passport: 'Juno01' },
    { target: '501' },
    { ...JUNO, target: '501' },
    { ...JUNO, agentId: AGENT_B },
    { baseId: 501, passport: 'Juno01' },
    { baseId: '501', passport: null },
    [JUNO],
    'Juno01',
  ])
    await refused(body, 'invalid_body');
  // The Base ID: a decimal above 0, no leading zero, no sign or space, within uint256.
  for (const baseId of ['', '0', '0501', '+501', ' 501', '501 ', '5e2', '0x1f5', 'abc', WALLET_B])
    await refused({ baseId, passport: 'Juno01' }, 'invalid_query');
  await refused({ baseId: (2n ** 256n).toString(10), passport: 'Juno01' }, 'invalid_query');
  // The passport: the 6 characters only, never a link, the "CC-" form or anything longer.
  for (const passport of [
    '',
    'CC-Juno01',
    'centralcity.ai/a/Juno01',
    'https://centralcity.ai/a/Juno01',
    'Juno0',
    'Juno011',
    ' Juno01',
    'Juno-1',
    WALLET_B,
  ])
    await refused({ baseId: '501', passport }, 'invalid_query');
  assert.equal(f.base.state.reads.length, 0, 'nothing was read on Base');
  assert.equal((await rows(f, 'base_rate_lookups')).length, 0, 'nothing was issued');
  // The largest Base ID is well formed (and names no agent here).
  const max = await lookup(f, { baseId: (2n ** 256n - 1n).toString(10), passport: 'Juno01' });
  assert.equal(max.json().code, 'lookup_mismatch', max.body);
});

test('lookup_mismatch: the Base ID and the passport do not name the same Central City agent', async (t) => {
  const f = await setup(t);
  await both(f);
  await register(f, { agentId: AGENT_C, baseId: '502', short: 'Cora01', wallet: WALLET_C });
  const mismatched = async (typed: RateLookup) => {
    const res = await lookup(f, typed);
    assert.equal(res.statusCode, 422, `${JSON.stringify(typed)}: ${res.body}`);
    assert.equal(res.json().code, 'lookup_mismatch', JSON.stringify(typed));
  };
  // Two real agents, crossed.
  await mismatched({ baseId: '501', passport: 'Cora01' });
  await mismatched({ baseId: '502', passport: 'Juno01' });
  // One right, the other no agent's: a passport nobody has, a Base ID that is an outsider's.
  await mismatched({ baseId: '501', passport: 'Zzzzz9' });
  f.base.state.owners.set('999', OUTSIDE);
  await mismatched({ baseId: '999', passport: 'Juno01' });
  // Passport numbers are case-sensitive: juno01 is not Juno01.
  await mismatched({ baseId: '501', passport: 'juno01' });
  await mismatched({ baseId: '501', passport: 'JUNO01' });
  // The rater's own passport with another agent's Base ID.
  await mismatched({ baseId: '501', passport: HARBOR.passport });
  assert.equal(f.base.state.reads.length, 0, 'Base is not read for a mismatch');
  assert.equal((await rows(f, 'base_rate_lookups')).length, 0, 'nothing was issued');
  // Each right pair is found.
  assert.equal((await lookup(f, { baseId: '502', passport: 'Cora01' })).statusCode, 200);
  assert.equal((await lookup(f, JUNO)).statusCode, 200);
});

test('not_rateable: no final Base ID, no passport, a passport not naming it, not on Base', async (t) => {
  const f = await setup(t);
  await both(f);
  const refused = async (typed: RateLookup, status: number, code: string) => {
    const res = await lookup(f, typed);
    assert.equal(res.statusCode, status, `${JSON.stringify(typed)}: ${res.body}`);
    assert.equal(res.json().code, code, JSON.stringify(typed));
  };
  // Neither value names a Central City agent (an outsider's Base ID, nobody's passport).
  f.base.state.owners.set('999', OUTSIDE);
  await refused({ baseId: '999', passport: 'Zzzzz9' }, 422, 'not_rateable');
  // No passport: an agent with a final Base ID but no short id.
  await register(f, { agentId: AGENT_C, baseId: '502', short: 'Cora01', wallet: WALLET_C });
  await f.db.query('DELETE FROM base_short_ids WHERE agent_id = $1', [AGENT_C]);
  await refused({ baseId: '502', passport: 'Cora01' }, 422, 'not_rateable');
  // A Base ID not final yet (registration still provisional).
  await register(f, {
    agentId: AGENT_D,
    baseId: '503',
    short: 'Dora01',
    wallet: WALLET_D,
    state: 'submitted',
  });
  const dora = { baseId: '503', passport: 'Dora01' };
  await refused(dora, 422, 'not_rateable');
  // Confirmed, but its mint was never seen on Base.
  await f.db.query(
    `UPDATE base_identities SET state = 'confirmed', erc8004_agent_id = 503, mint_seen_at = NULL
     WHERE agent_id = $1`,
    [AGENT_D],
  );
  await refused(dora, 422, 'not_rateable');
  // The registration's passport is not the agent's (it names another short id).
  await f.db.query(
    `UPDATE base_identities SET mint_seen_at = 1, agent_card_uri = $2 WHERE agent_id = $1`,
    [AGENT_D, `${AGENT_URI_ORIGIN}/a/Other1`],
  );
  await refused(dora, 422, 'not_rateable');
  // Once its passport names it, the same agent can be rated.
  await f.db.query('UPDATE base_identities SET agent_card_uri = $2 WHERE agent_id = $1', [
    AGENT_D,
    `${AGENT_URI_ORIGIN}/a/Dora01`,
  ]);
  const named = await lookup(f, dora);
  assert.equal(named.statusCode, 200, named.body);
  await f.db.query('DELETE FROM base_rate_lookups');
  // The Base ID is held by another address on Base right now.
  f.base.state.owners.set('501', OUTSIDE);
  await refused(JUNO, 422, 'not_rateable');
  f.base.state.owners.set('501', WALLET_B);
  // Base cannot be read: never guessed.
  f.base.state.down = true;
  await refused(JUNO, 503, 'chain_unavailable');
  f.base.state.down = false;
  assert.equal((await rows(f, 'base_rate_lookups')).length, 0, 'nothing was issued');
});

test('lookup refusals: the rater itself, the same person, an ineligible rater, someone else', async (t) => {
  const f = await setup(t);
  await both(f);
  const refused = async (
    typed: RateLookup,
    status: number,
    code: string | null,
    opts: { person?: string; agent?: string } = {},
  ) => {
    const res = await lookup(f, typed, opts);
    assert.equal(res.statusCode, status, `${JSON.stringify(typed)}: ${res.body}`);
    assert.equal(res.json().code, code ?? undefined, JSON.stringify(typed));
  };
  // Itself.
  await refused(HARBOR, 409, 'same_person');
  // Another agent of the same person (its wallet's owner account is the person's).
  await register(f, { agentId: AGENT_A2, baseId: '701', short: 'Harbr2', workspace: 'person-1' });
  const harbor2 = { baseId: '701', passport: 'Harbr2' };
  await refused(harbor2, 409, 'same_person');
  // One registered in the person's workspace before wallets existed (no owner account): theirs.
  await f.db.query('UPDATE base_wallets SET owner_account_id = NULL WHERE agent_id = $1', [
    AGENT_A2,
  ]);
  await refused(harbor2, 409, 'same_person');
  // One in an AI workspace this person co-owns, with no owner account (an outside key): theirs too.
  await f.db.query("INSERT INTO operator_links VALUES ('person-1', 'ai-ws-1', 'co-owner')");
  const MINE_AGENT = '0d0d0d0d-0000-4000-8000-00000000000d';
  const MINE = vaultWallet(MINE_AGENT);
  await register(f, {
    agentId: MINE_AGENT,
    baseId: '900',
    short: 'Mine01',
    wallet: MINE,
    workspace: 'ai-ws-1',
    ownerAccount: null,
  });
  await refused({ baseId: '900', passport: 'Mine01' }, 409, 'same_person');
  // The rater must be one of the person's agents (its wallet's owner account): 404 otherwise.
  await refused(JUNO, 404, 'not_found', { person: 'person-2' });
  await refused(JUNO, 404, 'not_found', { person: 'person-3' });
  await refused(JUNO, 401, null, { person: '' });
  // A rater without a Central City passport: person-1's A3 has a wallet but no registration.
  await refused(JUNO, 409, 'rater_not_eligible', { agent: AGENT_A3 });
  // A rater whose own Base ID is not held by its wallet on Base right now.
  f.base.state.owners.set('700', OUTSIDE);
  await refused(JUNO, 409, 'rater_not_eligible');
  f.base.state.owners.set('700', f.wallets[AGENT_A]);
  // A rater whose backup is not confirmed (its wallet is not ready).
  await f.db.query(
    "UPDATE base_owner_vaults SET backup_confirmed_at = NULL WHERE operator_id = 'person-1'",
  );
  await refused(JUNO, 409, 'rater_not_eligible');
  await f.db.query(
    "UPDATE base_owner_vaults SET backup_confirmed_at = 1 WHERE operator_id = 'person-1'",
  );
  // A rater whose passport was taken away (its registration no longer names it).
  await f.db.query('DELETE FROM base_short_ids WHERE agent_id = $1', [AGENT_A]);
  await refused(JUNO, 409, 'rater_not_eligible');
  await f.db.query('INSERT INTO base_short_ids VALUES ($1, $2, 1)', ['Harbr1', AGENT_A]);
  assert.equal((await lookup(f, JUNO)).statusCode, 200);
});

// --- create -----------------------------------------------------------------------------------

test('create: one sponsored giveFeedback from the rater wallet, exact calldata, no money', async (t) => {
  const f = await setup(t);
  await both(f);
  const lookupId = await lookedUp(f);
  const res = await rate(f, { ...rateBody(1, 3), to: { lookupId } });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as Created;
  const walletA = f.wallets[AGENT_A];
  assert.equal(body.state, 'awaiting_signature');
  assert.equal(body.entryPoint, ENTRY_POINT);
  assert.equal(body.chainId, CHAIN_ID);
  assert.equal(body.expiresAt, NOW + 10 * 60_000);
  assert.deepEqual(body.summary, {
    kind: 'rate',
    registry: REPUTATION_PROXY,
    agentId: '501',
    value: '60',
    tag1: 'starred',
    stars: 3,
    from: walletA,
    network: WALLET_EXPECTED.name,
    testnet: WALLET_EXPECTED.testnet,
    sponsored: true,
    fee: { paidBy: 'sponsor', token: 'ETH', max: { raw: '0', decimals: 18, display: '0' } },
    deploysWallet: true,
  });
  // The browser's own check (src/base/wallet/rate.ts) passes it, field by field, and hands back
  // the hash to sign; with other stars, another agent or the rater's own Base ID it signs nothing.
  assert.equal(browserCheck(f, body, { baseId: '501', stars: 3 }), body.userOpHash);
  assert.throws(() => browserCheck(f, body, { baseId: '501', stars: 4 }), RatingCheckError);
  assert.throws(() => browserCheck(f, body, { baseId: '502', stars: 3 }), RatingCheckError);
  assert.throws(
    () =>
      checkRateOperation({
        request: body as unknown as RateSigningRequest,
        wallet: walletA,
        owner: f.owner.address,
        agentId: AGENT_A,
        expected: { baseId: '501', stars: 3 },
        raterBaseId: '501',
        sponsors: SPONSORS,
      }),
    RatingCheckError,
  );
  // What is signed: from the rater's own derived wallet, hashing to the userOpHash.
  const op = userOperationFromRpc(body.userOperation);
  assert.deepEqual(decodeRateCall(op.callData, walletA), { agentId: 501n, stars: 3 });
  assert.equal(op.sender, walletA);
  assert.equal(ownerOperationHash(op), body.userOpHash);
  // Sponsored by the pinned paymaster at no charge to the wallet.
  assert.ok(sponsoredWithoutCharge(CHAIN_ID, op.paymasterAndData!, SPONSORS));
  // Exactly one execute to the registry proxy, no ETH, giveFeedback with the fixed fields.
  const outer = decodeFunctionData({ abi: executeAbi, data: op.callData });
  assert.equal(outer.functionName, 'execute');
  const [target, value, data] = outer.args as [Address, bigint, Hex];
  assert.equal(getAddress(target), REPUTATION_PROXY);
  assert.equal(value, 0n);
  assert.equal(data.slice(0, 10), '0x3c036a7e');
  const inner = decodeFunctionData({ abi: feedbackAbi, data });
  assert.deepEqual(inner.args, [501n, 60n, 0, 'starred', '', '', '', zeroHash]);
  // Nothing trails: the bytes are exactly that call's encoding.
  assert.equal(op.callData, execute(REPUTATION_PROXY, 0n, feedback({ value: 60n })));
  assert.equal(decodeOwnerCall(op.callData, walletA), null);
  assert.deepEqual(f.ops.state.prepares, [{ ownerFunded: false, to: REPUTATION_PROXY }]);
  // The row: kind rate, no token, amount, destination or hold.
  const [row] = await ratingRows(f);
  assert.equal(row.kind, 'rate');
  assert.equal(row.token, null);
  assert.equal(row.amount_raw, null);
  assert.equal(row.destination, null);
  assert.equal(row.reservation_id, null);
  assert.equal(row.fee_reservation_id, null);
  assert.equal(row.rated_agent_id, AGENT_B);
  assert.equal(String(row.rated_base_id), '501');
  assert.equal(row.rating_value, 60);
  assert.equal(row.sponsored, true);
  assert.equal((await rows(f, 'base_wallet_reservations')).length, 0, 'no hold');
  assert.equal((await rows(f, 'base_wallet_payments')).length, 0);
  const audit = await f.pg.query<{ kind: string; detail: Record<string, unknown> }>(
    'SELECT kind, detail FROM base_audit_events ORDER BY event_id',
  );
  assert.deepEqual(
    audit.rows.map((r) => r.kind),
    ['rating_created'],
  );
  assert.equal(audit.rows[0].detail.ratedBaseId, '501');
  assert.equal(audit.rows[0].detail.value, 60);
  assert.ok(f.limits.includes('rate-create:person-1/20/60000'));
  // Each number of stars is its value.
  for (const [n, stars] of [
    [2, 1],
    [3, 5],
  ] as const) {
    await f.app.inject({
      method: 'POST',
      url: `${withdrawalPath(body.withdrawalId)}/cancel`,
      headers: as('person-1'),
      payload: '{}',
    });
    const next = await rated(f, n, stars);
    assert.equal(next.summary.value, String(stars * 20));
    assert.equal(next.summary.stars, stars);
    assert.equal(browserCheck(f, next, { baseId: '501', stars }), next.userOpHash);
    body.withdrawalId = next.withdrawalId;
  }
});

test('create refusals: stars, body, lookup expired or not this person and rater, sponsor', async (t) => {
  const f = await setup(t);
  await both(f);
  const lookupId = await lookedUp(f);
  const refused = async (
    payload: Record<string, unknown>,
    status: number,
    code: string,
    opts: { person?: string; agent?: string } = {},
  ) => {
    const res = await rate(f, payload, opts);
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, JSON.stringify(payload));
  };
  for (const stars of [0, 6, 2.5, -1, '3', null, true])
    await refused({ idempotencyKey: key(1), stars, to: { lookupId } }, 400, 'invalid_stars');
  await refused({ idempotencyKey: key(1), to: { lookupId } }, 400, 'invalid_stars');
  await refused({ ...rateBody(1), to: { lookupId }, value: 100 }, 400, 'invalid_body');
  await refused({ ...rateBody(1), to: { lookupId, baseId: '501' } }, 400, 'invalid_body');
  await refused({ ...rateBody(1), to: { lookupId: 'pl_' + 'a'.repeat(32) } }, 400, 'invalid_body');
  await refused({ stars: 3, to: { lookupId } }, 400, 'invalid_body');
  // A lookup nobody issued.
  await refused(
    { ...rateBody(1), to: { lookupId: `rl_${'a'.repeat(32)}` } },
    409,
    'lookup_expired',
  );
  // Another person's lookup (person-2 rating with its own registered agent C).
  await register(f, { agentId: AGENT_C, baseId: '502', short: 'Cora01', wallet: WALLET_C });
  await refused({ ...rateBody(2), to: { lookupId } }, 409, 'lookup_expired', {
    person: 'person-2',
    agent: AGENT_C,
  });
  // The same person, another rater agent: a lookup is for the rater it was looked up for.
  await register(f, { agentId: AGENT_A2, baseId: '701', short: 'Harbr2', workspace: 'person-1' });
  await refused({ ...rateBody(3), to: { lookupId } }, 409, 'lookup_expired', { agent: AGENT_A2 });
  // Not the rater's owner: 404 as for withdrawals.
  const other = await f.app.inject({
    method: 'POST',
    url: path(RATE_PATHS.ratings, AGENT_A),
    headers: as('person-2'),
    payload: JSON.stringify({ ...rateBody(4), to: { lookupId } }),
  });
  assert.equal(other.statusCode, 404);
  // Expired.
  f.clock.now += PAY_RECIPIENT_TTL_MS + 1;
  await refused({ ...rateBody(5), to: { lookupId } }, 409, 'lookup_expired');
  // No sponsor: nothing prepared or stored (never the owner-funded fallback), even with it on.
  const g = await setup(t, { env: { ...RATE_ON, CITY_BASE_WALLET_UNSPONSORED_FALLBACK: '1' } });
  await both(g);
  g.ops.state.sponsor = false;
  const unsponsored = await rate(g, rateBody(1));
  assert.equal(unsponsored.statusCode, 503, unsponsored.body);
  assert.equal(unsponsored.json().code, 'sponsorship_unavailable');
  assert.ok(g.ops.state.prepares.every((p) => !p.ownerFunded));
  assert.equal((await ratingRows(g)).length, 0);
  assert.equal((await ratingRows(f)).length, 0);
});

test('create re-checks both agents on Base right before preparing; anything else is refused', async (t) => {
  const f = await setup(t);
  await both(f);
  const attempt = async (n: number, change: () => Promise<void> | void, code: string) => {
    const lookupId = await lookedUp(f);
    await change();
    const res = await rate(f, { ...rateBody(n), to: { lookupId } });
    assert.equal(res.json().code, code, res.body);
  };
  // The rated agent's Base ID moved to another wallet on Base.
  await attempt(1, () => void f.base.state.owners.set('501', OUTSIDE), 'lookup_changed');
  f.base.state.owners.set('501', WALLET_B);
  // The rater's own Base ID is no longer its wallet's.
  await attempt(2, () => void f.base.state.owners.set('700', OUTSIDE), 'rater_not_eligible');
  f.base.state.owners.set('700', f.wallets[AGENT_A]);
  // The block the lookup was read at was dropped (same height, another hash).
  await attempt(3, () => void (f.base.state.fork = 1), 'lookup_changed');
  f.base.state.fork = 0;
  // The rated agent's passport changed meanwhile (its Base ID still the same agent's).
  await attempt(
    31,
    async () => {
      await f.db.query("UPDATE base_short_ids SET short_id = 'Juno02' WHERE agent_id = $1", [
        AGENT_B,
      ]);
      await f.db.query('UPDATE base_identities SET agent_card_uri = $2 WHERE agent_id = $1', [
        AGENT_B,
        `${AGENT_URI_ORIGIN}/a/Juno02`,
      ]);
    },
    'lookup_changed',
  );
  await f.db.query("UPDATE base_short_ids SET short_id = 'Juno01' WHERE agent_id = $1", [AGENT_B]);
  await f.db.query('UPDATE base_identities SET agent_card_uri = $2 WHERE agent_id = $1', [
    AGENT_B,
    `${AGENT_URI_ORIGIN}/a/Juno01`,
  ]);
  // The check ends after the lookup expired.
  await attempt(
    4,
    () => {
      f.base.state.duringRead = async () => {
        f.clock.now += PAY_RECIPIENT_TTL_MS + 1;
      };
    },
    'lookup_expired',
  );
  f.clock.now = NOW + 60 * 60_000;
  // The rated agent became the person's own (its wallet now belongs to their account).
  await attempt(
    5,
    async () => {
      await f.db.query(
        "UPDATE base_wallets SET owner_account_id = 'person-1' WHERE agent_id = $1",
        [AGENT_B],
      );
    },
    'same_person',
  );
  await f.db.query("UPDATE base_wallets SET owner_account_id = 'person-2' WHERE agent_id = $1", [
    AGENT_B,
  ]);
  // Base cannot be read right now.
  await attempt(6, () => void (f.base.state.down = true), 'chain_unavailable');
  f.base.state.down = false;
  assert.equal((await ratingRows(f)).length, 0, 'nothing stored');
  assert.equal(f.ops.state.prepares.length, 0, 'nothing prepared');
  assert.equal((await rated(f, 7)).state, 'awaiting_signature');
});

test('cap: 100 ratings per account per Berlin day; the 101st is refused, yesterday does not count', async (t) => {
  const f = await setup(t);
  await both(f);
  assert.equal(RATE_DAILY_MAX, 100);
  const day = calendarPeriod('day', NOW);
  // Yesterday's ratings (Berlin time) do not count.
  await seedRatings(f, 50, day.start * 1000 - 1, 1000);
  // 99 today: the 100th goes through.
  await seedRatings(f, 99, day.start * 1000);
  const hundredth = await rated(f, 1);
  assert.equal(hundredth.state, 'awaiting_signature');
  // Discarded, it still counts (every rating the account created).
  const discarded = await f.app.inject({
    method: 'POST',
    url: `${withdrawalPath(hundredth.withdrawalId)}/cancel`,
    headers: as('person-1'),
    payload: '{}',
  });
  assert.equal(discarded.json().state, 'expired');
  const prepares = f.ops.state.prepares.length;
  const refused = await rate(f, rateBody(2));
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal(refused.json().code, 'rating_limit');
  assert.equal(refused.json().max, 100);
  assert.equal(f.ops.state.prepares.length, prepares, 'nothing prepared for the 101st');
  // From any of the person's agents.
  await register(f, { agentId: AGENT_A2, baseId: '701', short: 'Harbr2', workspace: 'person-1' });
  const fromA2 = await rate(f, rateBody(3), { agent: AGENT_A2 });
  assert.equal(fromA2.json().code, 'rating_limit');
  // Another person is not affected.
  await register(f, { agentId: AGENT_C, baseId: '502', short: 'Cora01', wallet: WALLET_C });
  // (person-2 rating person-1's Harbor)
  const lookupC = await lookup(f, HARBOR, { person: 'person-2', agent: AGENT_C });
  assert.equal(lookupC.statusCode, 200, lookupC.body);
  const fromC = await rate(
    f,
    { ...rateBody(4), to: { lookupId: lookupC.json().lookupId } },
    { person: 'person-2', agent: AGENT_C },
  );
  assert.equal(fromC.statusCode, 201, fromC.body);
  // The next Berlin day starts again.
  f.clock.now = day.end * 1000;
  assert.equal((await rated(f, 5)).state, 'awaiting_signature');
});

test('cap: CITY_BASE_RATE_DAILY_MAX sets another daily cap, read per request; anything else is 100', () => {
  assert.equal(rateDailyMax({}), RATE_DAILY_MAX);
  for (const raw of ['', '0', '-5', '1.5', '01', 'abc', ' 200', '1e3', '1234567890'])
    assert.equal(rateDailyMax({ [RATE_DAILY_MAX_SETTING]: raw }), RATE_DAILY_MAX, raw);
  assert.equal(rateDailyMax({ [RATE_DAILY_MAX_SETTING]: '1' }), 1);
  assert.equal(rateDailyMax({ [RATE_DAILY_MAX_SETTING]: '10000' }), 10_000);
  assert.equal(rateDailyMax({ [RATE_DAILY_MAX_SETTING]: '999999999' }), 999_999_999);
});

test('cap: with CITY_BASE_RATE_DAILY_MAX the 101st goes through and the cap is the setting', async (t) => {
  const env: Record<string, string | undefined> = { ...RATE_ON, [RATE_DAILY_MAX_SETTING]: '102' };
  const f = await setup(t, { env });
  await both(f);
  const day = calendarPeriod('day', NOW);
  await seedRatings(f, 101, day.start * 1000);
  const last = await rated(f, 1);
  assert.equal(last.state, 'awaiting_signature', 'the 102nd');
  // Discarded, so the wallet has no open operation; it still counts.
  const discarded = await f.app.inject({
    method: 'POST',
    url: `${withdrawalPath(last.withdrawalId)}/cancel`,
    headers: as('person-1'),
    payload: '{}',
  });
  assert.equal(discarded.json().state, 'expired');
  const refused = await rate(f, rateBody(3));
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal(refused.json().code, 'rating_limit');
  assert.equal(refused.json().max, 102);
  // Also under details, where the client's ApiError reads it.
  assert.deepEqual(refused.json().details, { max: 102 });
  // Read per request: back to the default without the setting.
  delete env[RATE_DAILY_MAX_SETTING];
  const unset = await rate(f, rateBody(4));
  assert.equal(unset.json().max, 100);
});

test('cap: counted again when the rating is stored, so a rating made meanwhile is never the 101st', async (t) => {
  const f = await setup(t);
  await both(f);
  const day = calendarPeriod('day', NOW);
  await seedRatings(f, 99, day.start * 1000);
  const lookupId = await lookedUp(f);
  // After the first count passed (99), another rating of the account is stored.
  f.base.state.duringRead = async () => {
    await seedRatings(f, 1, NOW, 500);
  };
  const res = await rate(f, { ...rateBody(1), to: { lookupId } });
  assert.equal(res.statusCode, 429, res.body);
  assert.equal(res.json().code, 'rating_limit');
  assert.equal((await ratingRows(f)).length, 100, 'the 101st was not stored');
  const audit = await f.pg.query("SELECT 1 FROM base_audit_events WHERE kind = 'rating_created'");
  assert.equal(audit.rows.length, 0);
});

test('idempotency: same key and body, the same rating; another body or kind is refused', async (t) => {
  const f = await setup(t);
  await both(f);
  const lookupId = await lookedUp(f);
  const first = await rate(f, { ...rateBody(1, 4), to: { lookupId } });
  assert.equal(first.statusCode, 201);
  const again = await rate(f, { ...rateBody(1, 4), to: { lookupId } });
  assert.equal(again.statusCode, 201);
  assert.deepEqual(again.json(), first.json());
  assert.equal(f.ops.state.prepares.length, 1, 'prepared once');
  // A replay is a read: also after the lookup expired, and without reading Base.
  f.clock.now += PAY_RECIPIENT_TTL_MS + 1;
  const reads = f.base.state.reads.length;
  const late = await rate(f, { ...rateBody(1, 4), to: { lookupId } });
  assert.equal(late.json().withdrawalId, first.json().withdrawalId);
  assert.equal(f.base.state.reads.length, reads);
  // The same key with other stars, another lookup or another rater agent.
  const conflict = await rate(f, { ...rateBody(1, 5), to: { lookupId } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, 'idempotency_conflict');
  // A rating's key never replays as a withdrawal, nor a withdrawal's as a rating.
  const asWithdrawal = await withdraw(f, 1);
  assert.equal(asWithdrawal.json().code, 'idempotency_conflict');
  const g = await setup(t);
  await both(g);
  assert.equal((await withdraw(g, 7)).statusCode, 201);
  const asRating = await rate(g, rateBody(7));
  assert.equal(asRating.json().code, 'idempotency_conflict');
  assert.equal((await ratingRows(g)).length, 0);
});

// --- gate 2, signing, status ------------------------------------------------------------------

test('gate 2: a rating waits for an unfinished withdrawal of the wallet, and the other way round', async (t) => {
  const f = await setup(t);
  await both(f);
  // A withdrawal awaiting its signature blocks a rating.
  const w = (await withdraw(f, 50)).json() as Created;
  const blocked = await rate(f, rateBody(1));
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().code, 'operation_pending');
  assert.equal(blocked.json().withdrawalId, w.withdrawalId);
  // Signed and in a block, not yet final: still blocks (one unfinished operation per wallet).
  assert.equal((await sign(f, w)).statusCode, 202);
  f.ops.land(w.userOpHash, 'included');
  assert.equal((await read(f, w.withdrawalId)).json().state, 'included');
  assert.equal((await rate(f, rateBody(2))).json().code, 'operation_pending');
  // Final: the rating starts, at the next nonce, and no longer deploys the wallet.
  f.ops.mine(Number(SETTLE_DEPTH));
  assert.equal((await read(f, w.withdrawalId)).json().state, 'final');
  const r = await rated(f, 3);
  assert.equal(BigInt(r.userOperation.nonce), BigInt(w.userOperation.nonce) + 1n);
  assert.equal(r.summary.deploysWallet, false);
  assert.equal(browserCheck(f, r, { baseId: '501', stars: 4 }), r.userOpHash);
  // An unsigned rating blocks a withdrawal and a payment from the same wallet.
  const w2 = await withdraw(f, 51);
  assert.equal(w2.statusCode, 409);
  assert.equal(w2.json().code, 'operation_pending');
  assert.equal(w2.json().withdrawalId, r.withdrawalId);
  const payLookup = await f.app.inject({
    url: '/api/base/pay/recipient?q=501',
    headers: as('person-1'),
  });
  const payment = await f.app.inject({
    method: 'POST',
    url: `/api/base/agents/${AGENT_A}/wallet/payments`,
    headers: as('person-1'),
    payload: JSON.stringify({
      idempotencyKey: key(52),
      amount: '1000000',
      to: { lookupId: payLookup.json().lookupId },
    }),
  });
  assert.equal(payment.json().code, 'operation_pending', payment.body);
  // Signed and included: still blocks; final: the withdrawal goes ahead.
  assert.equal((await sign(f, r)).statusCode, 202);
  f.ops.land(r.userOpHash, 'included');
  assert.equal((await read(f, r.withdrawalId)).json().state, 'included');
  assert.equal((await withdraw(f, 53)).json().code, 'operation_pending');
  f.ops.mine(Number(SETTLE_DEPTH));
  assert.equal((await read(f, r.withdrawalId)).json().state, 'final');
  const w3 = await withdraw(f, 54);
  assert.equal(w3.statusCode, 201, w3.body);
  assert.equal(BigInt(w3.json().userOperation.nonce), BigInt(r.userOperation.nonce) + 1n);
});

test('ratings switched off: a rating prepared before is never signed; read and cancel stay', async (t) => {
  const env: Record<string, string | undefined> = { ...RATE_ON };
  const f = await setup(t, { env });
  await both(f);
  const r = await rated(f, 1, 4);
  env[RATE_SETTING] = '0';
  const res = await sign(f, { withdrawalId: r.withdrawalId, userOpHash: r.userOpHash });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(f.ops.state.sends.length, 0, 'nothing was sent');
  assert.equal((await read(f, r.withdrawalId)).statusCode, 200);
});

test('signature: accepted for exactly the prepared rating; a tampered operation is refused', async (t) => {
  const f = await setup(t);
  await both(f);
  const r = await rated(f, 1, 3);
  // A signature over another operation (5 stars instead of 3) recovers to no owner of this one.
  const op = userOperationFromRpc(r.userOperation);
  const five = { ...op, callData: execute(REPUTATION_PROXY, 0n, feedback({ value: 100n })) };
  const wrong = await f.app.inject({
    method: 'POST',
    url: `${withdrawalPath(r.withdrawalId)}/signature`,
    headers: as('person-1'),
    payload: JSON.stringify({ signature: await f.owner.sign({ hash: ownerOperationHash(five) }) }),
  });
  assert.equal(wrong.statusCode, 422);
  assert.equal(wrong.json().code, 'signature_mismatch');
  // The stored operation tampered with (another rating, or a transfer) and re-hashed: whatever the
  // owner signs for it, it is never accepted or sent.
  const original = await f.pg.query<{ user_operation: unknown; user_op_hash: string }>(
    'SELECT user_operation, user_op_hash FROM base_wallet_withdrawals WHERE withdrawal_id = $1',
    [r.withdrawalId],
  );
  const transfer = {
    ...op,
    callData: execute(USDC, 0n, withdrawalCall('USDC', OUTSIDE, 1_000_000n).data),
  };
  for (const tampered of [five, transfer]) {
    const hash = ownerOperationHash(tampered).toLowerCase() as Hex;
    await f.pg.query(
      `UPDATE base_wallet_withdrawals SET user_operation = $2, user_op_hash = $3
       WHERE withdrawal_id = $1`,
      [r.withdrawalId, JSON.stringify(userOperationToRpc(tampered)), hash],
    );
    const res = await sign(f, { withdrawalId: r.withdrawalId, userOpHash: hash });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().code, 'operation_mismatch');
  }
  assert.equal(f.ops.state.sends.length, 0, 'nothing was sent');
  // A withdrawal row is never signed with a rating's calldata either.
  await f.pg.query(
    `UPDATE base_wallet_withdrawals SET user_operation = $2, user_op_hash = $3
     WHERE withdrawal_id = $1`,
    [
      r.withdrawalId,
      JSON.stringify(original.rows[0].user_operation),
      original.rows[0].user_op_hash,
    ],
  );
  await f.app.inject({
    method: 'POST',
    url: `${withdrawalPath(r.withdrawalId)}/cancel`,
    headers: as('person-1'),
    payload: '{}',
  });
  const w = (await withdraw(f, 9)).json() as Created;
  const rating = { ...userOperationFromRpc(w.userOperation), callData: op.callData };
  const ratingHash = ownerOperationHash(rating).toLowerCase() as Hex;
  await f.pg.query(
    `UPDATE base_wallet_withdrawals SET user_operation = $2, user_op_hash = $3
     WHERE withdrawal_id = $1`,
    [w.withdrawalId, JSON.stringify(userOperationToRpc(rating)), ratingHash],
  );
  const swapped = await sign(f, { withdrawalId: w.withdrawalId, userOpHash: ratingHash });
  assert.equal(swapped.json().code, 'operation_mismatch');
  const signed = await f.pg.query(
    'SELECT 1 FROM base_wallet_withdrawals WHERE owner_signature IS NOT NULL',
  );
  assert.equal(signed.rows.length, 0);
});

test('the view: signed, sent, included, final through the withdrawal routes; no money, no hold', async (t) => {
  const f = await setup(t);
  await both(f);
  const r = await rated(f, 1, 5);
  const unsigned = (await read(f, r.withdrawalId)).json();
  assert.equal(unsigned.kind, 'rate');
  // Enough to say "rated Juno 5 stars"; display only.
  assert.deepEqual(unsigned.rating, {
    kind: 'rate',
    registry: REPUTATION_PROXY,
    agentId: '501',
    value: '100',
    tag1: 'starred',
    stars: 5,
    ratedAgentId: AGENT_B,
    name: 'Juno',
  });
  // A Pay screen that reads every operation as a transfer never breaks on it: a zero amount, no
  // token, to the registry it calls.
  assert.deepEqual(unsigned.amount, { raw: '0', decimals: 6, display: '0' });
  assert.deepEqual(unsigned.amount, RATING_AMOUNT);
  assert.equal(unsigned.token, null);
  assert.equal(unsigned.to, REPUTATION_PROXY);
  assert.equal(unsigned.from, f.wallets[AGENT_A]);
  assert.equal(unsigned.state, 'awaiting_signature');
  assert.equal(unsigned.sponsored, true);
  assert.equal(unsigned.fee.paidBy, 'sponsor');
  const sent = await sign(f, r);
  assert.equal(sent.statusCode, 202, sent.body);
  assert.equal(sent.json().state, 'submitted');
  assert.deepEqual(sent.json().amount, RATING_AMOUNT);
  assert.deepEqual(f.ops.state.sends, [r.userOpHash]);
  // Its chain operation is a rating, bound to this row.
  const [chainOp] = (await rows(f, 'base_chain_ops')).filter((row) => row.kind === 'rate');
  assert.equal(chainOp.idempotency_key, `base-wallet:rate:${r.withdrawalId}`);
  f.ops.land(r.userOpHash, 'included');
  const included = (await read(f, r.withdrawalId)).json();
  assert.equal(included.state, 'included');
  assert.match(included.explorerUrl, /\/tx\/0x[0-9a-f]{64}$/);
  f.ops.mine(Number(SETTLE_DEPTH));
  const final = (await read(f, r.withdrawalId)).json();
  assert.equal(final.state, 'final');
  assert.deepEqual(final.amount, RATING_AMOUNT);
  assert.equal(final.token, null);
  assert.equal(final.rating.name, 'Juno');
  // The name is the card's public name now: '' once it is not public, the rating unchanged.
  await f.db.query(
    `UPDATE agent_manifests SET manifest = jsonb_set(manifest, '{spec,visibility}', '"private"')
     WHERE agent_id = $1`,
    [AGENT_B],
  );
  const hidden = (await read(f, r.withdrawalId)).json();
  assert.equal(hidden.rating.name, '');
  assert.equal(hidden.rating.stars, 5);
  assert.equal((await rows(f, 'base_wallet_reservations')).length, 0, 'no hold, none released');
  const audit = await f.pg.query<{ kind: string }>(
    'SELECT kind FROM base_audit_events ORDER BY event_id',
  );
  assert.deepEqual(
    audit.rows.map((row) => row.kind),
    ['rating_created', 'rating_signed', 'rating_submitted', 'rating_final'],
  );
  // A withdrawal's answer is as it always was (plus safe, from the safe-head gate 2): no kind, no
  // rating.
  const w = (await withdraw(f, 2)).json() as Created;
  const view = (await read(f, w.withdrawalId)).json();
  assert.deepEqual(Object.keys(view), [
    'withdrawalId',
    'state',
    'token',
    'amount',
    'from',
    'to',
    'network',
    'chainId',
    'userOpHash',
    'sponsored',
    'fee',
    'txHash',
    'blockNumber',
    'safe',
    'errorCode',
    'explorerUrl',
    'expiresAt',
    'cancel',
    'createdAt',
    'updatedAt',
  ]);
  assert.equal(view.token, 'USDC');
  assert.equal(view.to, OUTSIDE);
  assert.equal(view.amount.raw, '1000000');
});

test('a rating from before the sponsor ledger is backfilled by migration 97 and released when final', async (t) => {
  const f = await setup(t);
  await both(f);
  const r = await rated(f, 1, 5);
  assert.equal((await sign(f, r)).statusCode, 202);
  await f.pg.query('DELETE FROM base_sponsor_exposure');
  await f.pg.exec(BASE_SPONSOR_EXPOSURE_SQL);
  // Its own cost and its cancel headroom.
  const all = await rows(f, 'base_sponsor_exposure');
  assert.equal(all.length, 2);
  const held = all.filter((row) => String(row.holder).startsWith('withdrawal:'));
  assert.equal(held[0].holder, `withdrawal:${r.withdrawalId}`);
  assert.equal(BigInt(held[0].amount as string), sponsorBound(r.userOperation));
  f.ops.land(r.userOpHash, 'final');
  assert.equal((await read(f, r.withdrawalId)).json().state, 'final');
  assert.deepEqual(
    (await rows(f, 'base_sponsor_exposure')).map((row) => row.state),
    ['released', 'released'],
  );
});

test('cancel: an unsigned rating is discarded; a signed one gets a sponsored no-op or nothing', async (t) => {
  const f = await setup(t, { env: { ...RATE_ON, CITY_BASE_WALLET_UNSPONSORED_FALLBACK: '1' } });
  await both(f);
  const cancel = (id: string) =>
    f.app.inject({
      method: 'POST',
      url: `${withdrawalPath(id)}/cancel`,
      headers: as('person-1'),
      payload: '{}',
    });
  const first = await rated(f, 1);
  const discarded = (await cancel(first.withdrawalId)).json();
  assert.equal(discarded.state, 'expired');
  const second = await rated(f, 2);
  assert.equal((await sign(f, second)).statusCode, 202);
  // Without a sponsor the cancel is refused, never paid from the wallet (fallback setting on).
  f.ops.state.sponsor = false;
  const refused = await cancel(second.withdrawalId);
  assert.equal(refused.statusCode, 503);
  assert.equal(refused.json().code, 'sponsorship_unavailable');
  f.ops.state.sponsor = true;
  const asked = (await cancel(second.withdrawalId)).json();
  assert.equal(asked.state, 'cancel_pending');
  assert.equal(asked.cancel.sponsored, true);
  assert.ok(f.ops.state.prepares.every((p) => !p.ownerFunded));
  const audit = await f.pg.query<{ kind: string }>(
    "SELECT kind FROM base_audit_events WHERE kind LIKE 'withdrawal%'",
  );
  assert.equal(audit.rows.length, 0, 'a rating writes only rating_ events');
});

// --- pay without waiting: a rating in its own nonce lane (CITY_BASE_LANES=1) --------------------

const RATE_LANES_ON = { ...RATE_ON, CITY_BASE_LANES: '1' };

/** Lanes on (settings mutable, read per request), the rater's wallet already deployed. */
async function lanesSetup(
  t: { after: (fn: () => Promise<unknown>) => void },
  env: Record<string, string | undefined> = {},
) {
  const settings: Record<string, string | undefined> = { ...RATE_LANES_ON, ...env };
  const f = await setup(t, { env: settings });
  f.ops.state.code.add(f.wallets[AGENT_A].toLowerCase());
  await both(f);
  return { ...f, settings };
}

/** A payment of 1 USDC from agent A to Juno (Base ID 501), unsigned. */
async function pay(f: Fixture, n: number) {
  const recipient = await f.app.inject({
    url: '/api/base/pay/recipient?q=501',
    headers: as('person-1'),
  });
  return f.app.inject({
    method: 'POST',
    url: `/api/base/agents/${AGENT_A}/wallet/payments`,
    headers: as('person-1'),
    payload: JSON.stringify({
      idempotencyKey: key(n),
      amount: '1000000',
      to: { lookupId: recipient.json().lookupId },
    }),
  });
}

async function exposureOf(f: Fixture, withdrawalId: string) {
  return (await rows(f, 'base_sponsor_exposure'))
    .filter((row) => row.withdrawal_id === withdrawalId)
    .map((row) => ({ holder: String(row.holder).split(':')[0], state: row.state }))
    .sort((a, b) => a.holder.localeCompare(b.holder));
}

const heldExposure = async (f: Fixture) =>
  (await rows(f, 'base_sponsor_exposure'))
    .filter((row) => row.state === 'held')
    .reduce((sum, row) => sum + BigInt(row.amount as string), 0n);

test('lanes off: a rating still waits for an open payment (operation_pending), no lane, no flag', async (t) => {
  const f = await setup(t);
  f.ops.state.code.add(f.wallets[AGENT_A].toLowerCase());
  await both(f);
  const p = await pay(f, 60);
  assert.equal(p.statusCode, 201, p.body);
  const blocked = await rate(f, rateBody(1));
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().code, 'operation_pending');
  assert.equal(blocked.json().withdrawalId, p.json().withdrawalId);
  // The payment discarded: the rating goes on the shared lane, as before.
  const discarded = await f.app.inject({
    method: 'POST',
    url: `${withdrawalPath(p.json().withdrawalId)}/cancel`,
    headers: as('person-1'),
    payload: '{}',
  });
  assert.equal(discarded.json().state, 'expired');
  const r = await rated(f, 2);
  assert.equal('lanes' in r, false);
  assert.equal(BigInt(r.userOperation.nonce), OWNER_NONCE_KEY << 64n, 'the owner lane');
  const [row] = await ratingRows(f);
  assert.equal(row.lane_key, null);
  assert.equal('lanes' in (await read(f, r.withdrawalId)).json(), false);
});

test('lanes: a rating right after a payment, each in its own lane, neither waits for the other', async (t) => {
  const f = await lanesSetup(t);
  const p = await pay(f, 60);
  assert.equal(p.statusCode, 201, p.body);
  assert.equal(p.json().lanes, true);
  const res = await rate(f, rateBody(1, 5));
  assert.equal(res.statusCode, 201, res.body);
  const r = res.json() as Created & { lanes?: true };
  assert.equal(r.lanes, true);
  const op = userOperationFromRpc(r.userOperation);
  assert.equal(op.nonce, laneNonce(r.withdrawalId), 'the nonce the browser derives');
  assert.equal(op.initCode, '0x');
  assert.notEqual(op.nonce >> 64n, BigInt(p.json().userOperation.nonce) >> 64n);
  // Still exactly the rating, as the browser checks it.
  assert.equal(browserCheck(f, r, { baseId: '501', stars: 5 }), r.userOpHash);
  const [row] = await ratingRows(f);
  assert.equal(BigInt(row.lane_key as string), laneKey(r.withdrawalId));
  assert.equal(BigInt(row.nonce as string), laneNonce(r.withdrawalId));
  const created = await f.pg.query<{ detail: { laneKey?: string } }>(
    "SELECT detail FROM base_audit_events WHERE kind = 'rating_created'",
  );
  assert.equal(created.rows[0].detail.laneKey, laneKey(r.withdrawalId).toString(10));
  // Signed and sent while the payment is still unsigned; it lands on its own.
  const sent = await sign(f, r);
  assert.equal(sent.statusCode, 202, sent.body);
  assert.equal(sent.json().lanes, true);
  f.ops.land(r.userOpHash, 'final');
  const final = (await read(f, r.withdrawalId)).json();
  assert.equal(final.state, 'final');
  assert.equal(final.lanes, true);
  // The payment's own lane is untouched: it still signs and goes.
  const paySent = await f.app.inject({
    method: 'POST',
    url: `${withdrawalPath(p.json().withdrawalId)}/signature`,
    headers: as('person-1'),
    payload: JSON.stringify({ signature: await f.owner.sign({ hash: p.json().userOpHash }) }),
  });
  assert.equal(paySent.statusCode, 202, paySent.body);
  // A second rating while the payment is on its way: its own lane again.
  const again = await rated(f, 2);
  assert.equal(BigInt(again.userOperation.nonce), laneNonce(again.withdrawalId));
});

test('lanes: a rating counts toward the open cap (409 too_many_open), and so do the others', async (t) => {
  const f = await lanesSetup(t, { CITY_BASE_LANES_CAP: '2' });
  assert.equal((await pay(f, 60)).statusCode, 201);
  await rated(f, 1);
  const third = await rate(f, rateBody(2));
  assert.equal(third.statusCode, 409);
  assert.equal(third.json().code, 'too_many_open');
  assert.deepEqual(third.json().details, { max: 2, open: 2 });
  // The rating holds a slot a payment would need too.
  assert.equal((await pay(f, 61)).json().code, 'too_many_open');
  assert.equal((await ratingRows(f)).length, 1, 'nothing stored for the refused one');
});

test('lanes: a rating reserves the sponsor exposure (cost and cancel headroom), released on final or expiry', async (t) => {
  const f = await lanesSetup(t);
  const r = await rated(f, 1);
  assert.deepEqual(await exposureOf(f, r.withdrawalId), [
    { holder: 'headroom', state: 'held' },
    { holder: 'withdrawal', state: 'held' },
  ]);
  const cost = (await rows(f, 'base_sponsor_exposure')).find(
    (row) => row.holder === `withdrawal:${r.withdrawalId}`,
  );
  assert.equal(BigInt(cost!.amount as string), sponsorBound(r.userOperation));
  assert.equal((await sign(f, r)).statusCode, 202);
  f.ops.land(r.userOpHash, 'final');
  assert.equal((await read(f, r.withdrawalId)).json().state, 'final');
  assert.deepEqual(await exposureOf(f, r.withdrawalId), [
    { holder: 'headroom', state: 'released' },
    { holder: 'withdrawal', state: 'released' },
  ]);
  // Unsigned past its time: expired, its exposure released.
  const late = await rated(f, 2);
  f.clock.now += WITHDRAWAL_SIGNATURE_TTL_MS + 1;
  assert.equal((await read(f, late.withdrawalId)).json().state, 'expired');
  assert.deepEqual(await exposureOf(f, late.withdrawalId), [
    { holder: 'headroom', state: 'released' },
    { holder: 'withdrawal', state: 'released' },
  ]);
  assert.equal(await heldExposure(f), 0n);
});

test('lanes: at the sponsor cap a rating is 409 sponsor_busy and nothing is stored', async (t) => {
  const f = await lanesSetup(t);
  const first = await rated(f, 1);
  const one = await heldExposure(f);
  assert.ok(one > 0n);
  // Room for exactly one rating per wallet: the second waits for the first.
  f.settings.CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET = one.toString(10);
  const busy = await rate(f, rateBody(2));
  assert.equal(busy.statusCode, 409, busy.body);
  assert.equal(busy.json().code, 'sponsor_busy');
  assert.deepEqual(busy.json().details, { retryAfterSeconds: 60 });
  assert.equal((await ratingRows(f)).length, 1);
  assert.equal(await heldExposure(f), one);
  // The first one final: room again.
  assert.equal((await sign(f, first)).statusCode, 202);
  f.ops.land(first.userOpHash, 'final');
  assert.equal((await read(f, first.withdrawalId)).json().state, 'final');
  assert.equal((await rate(f, rateBody(3))).statusCode, 201);
});

test('lanes: a rating pauses with the wallet’s sponsor revert budget spent (409 sponsor_paused)', async (t) => {
  const f = await lanesSetup(t, { CITY_BASE_LANES_REVERT_BUDGET: '2' });
  const a = await rated(f, 1);
  const b = await rated(f, 2);
  // Prepared before the budget was spent: never signed while it is.
  const c = await rated(f, 3);
  // Two sponsored ratings revert on Base.
  for (const r of [a, b]) {
    assert.equal((await sign(f, r)).statusCode, 202);
    f.ops.land(r.userOpHash, 'included');
    f.ops.state.landed.get(r.userOpHash)!.success = false;
    assert.equal((await read(f, r.withdrawalId)).json().errorCode, 'reverted');
  }
  const paused = await rate(f, rateBody(4));
  assert.equal(paused.statusCode, 409, paused.body);
  assert.equal(paused.json().code, 'sponsor_paused');
  const unsigned = await sign(f, c);
  assert.equal(unsigned.statusCode, 409, unsigned.body);
  assert.equal(unsigned.json().code, 'sponsor_paused');
  assert.deepEqual(f.ops.state.sends, [a.userOpHash, b.userOpHash], 'nothing sent for it');
});

// --- migration ----------------------------------------------------------------------------------

/** The validUntil (ms) a prepared operation's paymaster signed (shared/base/paymasters.ts). */
const sponsoredUntil = (op: RpcUserOperation) =>
  Number(BigInt(`0x${op.paymasterAndData.slice(42, 54)}`)) * 1000;

test('lanes: a rating’s sponsorship must end within its one fixed signing deadline, or nothing is prepared', async (t) => {
  const f = await lanesSetup(t);
  const deadline = f.clock.now + WITHDRAWAL_SIGNATURE_TTL_MS;
  // A paymaster that signs past the deadline (or unbounded): refused at prepare, nothing stored.
  for (const until of [Math.floor(deadline / 1000) + 1, 0]) {
    f.ops.state.sponsorValidUntil = () => until;
    const refused = await rate(f, rateBody(1));
    assert.equal(refused.statusCode, 503, refused.body);
    assert.equal(refused.json().code, 'sponsorship_unavailable');
    assert.equal((await ratingRows(f)).length, 0);
    assert.equal(await heldExposure(f), 0n);
  }
  // Exactly at the deadline: prepared, and the rating can be signed until exactly then.
  f.ops.state.sponsorValidUntil = () => Math.floor(deadline / 1000);
  const r = await rated(f, 2);
  assert.equal(r.expiresAt, deadline);
  assert.ok(sponsoredUntil(r.userOperation) <= r.expiresAt);
  const [row] = await ratingRows(f);
  assert.equal(Number(row.expires_at), deadline);
  assert.doesNotThrow(() =>
    checkRatingWindow(r as unknown as RateSigningRequest, f.clock.now, SPONSORS),
  );
  assert.equal(browserCheck(f, r, { baseId: '501', stars: 4 }), r.userOpHash);
  assert.equal((await sign(f, r)).statusCode, 202);
});

test('lanes off: a rating keeps its paymaster window unchecked, as a withdrawal does', async (t) => {
  const f = await setup(t);
  f.ops.state.code.add(f.wallets[AGENT_A].toLowerCase());
  await both(f);
  f.ops.state.sponsorValidUntil = () => 0;
  const r = await rated(f, 1);
  assert.equal(r.expiresAt, f.clock.now + WITHDRAWAL_SIGNATURE_TTL_MS);
  assert.equal((await sign(f, r)).statusCode, 202);
});

test('lanes: a rating can be signed only until its sponsorship ends; then it expires and frees its slot', async (t) => {
  const f = await lanesSetup(t, { CITY_BASE_LANES_CAP: '1' });
  // The paymaster's window ends a minute in, well before the 10-minute signing deadline.
  f.ops.state.sponsorValidUntil = () => Math.floor((f.clock.now + 60_000) / 1000);
  const r = await rated(f, 1);
  assert.equal(r.expiresAt, sponsoredUntil(r.userOperation));
  assert.ok(r.expiresAt < f.clock.now + WITHDRAWAL_SIGNATURE_TTL_MS);
  const [stored] = await ratingRows(f);
  assert.equal(Number(stored.expires_at), r.expiresAt);
  assert.ok((await heldExposure(f)) > 0n);
  const full = await rate(f, rateBody(2));
  assert.equal(full.statusCode, 409, full.body);
  assert.equal(full.json().code, 'too_many_open');
  f.clock.now = r.expiresAt;
  // The browser tolerates a device clock up to SIGNING_CLOCK_SKEW_MS fast, so at the end of the
  // window it leaves the call to the server; beyond that it refuses itself (checkRatingWindow,
  // before signing and before sending) ...
  assert.doesNotThrow(() =>
    checkRatingWindow(r as unknown as RateSigningRequest, f.clock.now, SPONSORS),
  );
  assert.throws(
    () =>
      checkRatingWindow(
        r as unknown as RateSigningRequest,
        f.clock.now + SIGNING_CLOCK_SKEW_MS,
        SPONSORS,
      ),
    (error: unknown) => error instanceof RatingWindowError,
  );
  // ... and the server, whose clock is the authority, has expired it: nothing stored or sent,
  // its exposure released.
  const refused = await sign(f, r);
  assert.equal(refused.statusCode, 410, refused.body);
  assert.equal(refused.json().code, 'expired');
  const [row] = await ratingRows(f);
  assert.equal(row.state, 'expired');
  assert.equal(row.owner_signature, null);
  assert.equal(f.ops.state.sends.length, 0);
  assert.equal(await heldExposure(f), 0n);
  // Its slot is free: the next rating (a new key) is prepared afresh and signs.
  f.ops.state.sponsorValidUntil = () =>
    Math.floor((f.clock.now + WITHDRAWAL_SIGNATURE_TTL_MS) / 1000);
  const next = await rated(f, 3);
  assert.notEqual(next.withdrawalId, r.withdrawalId);
  assert.equal((await sign(f, next)).statusCode, 202);
});

test('lanes: a rating whose sponsorship ends during signing is 409 sponsorship_expired, nothing stored or sent', async (t) => {
  const f = await lanesSetup(t);
  f.ops.state.sponsorValidUntil = () => Math.floor((f.clock.now + 60_000) / 1000);
  const r = await rated(f, 1);
  const held = await heldExposure(f);
  // The first check passes; the sponsorship has ended by the second, inside the transaction.
  const valid = f.ops.port.sponsorshipValid!.bind(f.ops.port);
  let checks = 0;
  f.ops.port.sponsorshipValid = (data, deadline) => {
    const result = valid(data, deadline);
    if (++checks === 1) f.clock.now = r.expiresAt;
    return result;
  };
  const refused = await sign(f, r);
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, 'sponsorship_expired');
  assert.equal(checks, 2);
  const [row] = await ratingRows(f);
  assert.equal(row.owner_signature, null);
  assert.equal(row.signed_at, null);
  assert.equal(f.ops.state.sends.length, 0);
  assert.equal(await heldExposure(f), held);
  const events = await f.pg.query<{ kind: string }>(
    "SELECT kind FROM base_audit_events WHERE kind = 'rating_signed'",
  );
  assert.equal(events.rows.length, 0);
});

test('lanes: a signed rating past its sponsorship is never expired or freed', async (t) => {
  const f = await lanesSetup(t);
  f.ops.state.sponsorValidUntil = () => Math.floor((f.clock.now + 60_000) / 1000);
  const r = await rated(f, 1);
  assert.equal((await sign(f, r)).statusCode, 202);
  const held = await heldExposure(f);
  f.clock.now = r.expiresAt + 5 * 60_000;
  const view = (await read(f, r.withdrawalId)).json();
  assert.equal(view.state, 'submitted');
  assert.equal(await heldExposure(f), held);
  f.ops.land(r.userOpHash, 'final');
  assert.equal((await read(f, r.withdrawalId)).json().state, 'final');
});

test('lanes: a signed rating’s cancel is sponsored within its own fixed deadline, or not prepared', async (t) => {
  const f = await lanesSetup(t);
  const r = await rated(f, 1);
  assert.equal((await sign(f, r)).statusCode, 202);
  const cancel = () =>
    f.app.inject({
      method: 'POST',
      url: `${withdrawalPath(r.withdrawalId)}/cancel`,
      headers: as('person-1'),
      payload: '{}',
    });
  f.clock.now += 5_000;
  const cancelDeadline = f.clock.now + WITHDRAWAL_SIGNATURE_TTL_MS;
  f.ops.state.sponsorValidUntil = () => Math.floor(cancelDeadline / 1000) + 1;
  const refused = await cancel();
  assert.equal(refused.statusCode, 503, refused.body);
  assert.equal(refused.json().code, 'sponsorship_unavailable');
  // A paymaster window shorter than the deadline: the cancel can be signed only until it ends.
  const shorter = Math.floor((f.clock.now + 90_000) / 1000);
  f.ops.state.sponsorValidUntil = () => shorter;
  const short = await cancel();
  assert.equal(short.statusCode, 200, short.body);
  assert.equal(short.json().cancel.expiresAt, shorter * 1000);
  // Lapsed unsigned, the signed rating is untouched and a new cancel can be asked.
  f.clock.now = shorter * 1000;
  assert.equal((await read(f, r.withdrawalId)).json().state, 'submitted');
  f.clock.now += 1_000;
  const laterDeadline = f.clock.now + WITHDRAWAL_SIGNATURE_TTL_MS;
  f.ops.state.sponsorValidUntil = () => Math.floor(laterDeadline / 1000);
  const asked = await cancel();
  assert.equal(asked.statusCode, 200, asked.body);
  assert.equal(asked.json().state, 'cancel_pending');
  assert.equal(asked.json().cancel.sponsored, true);
  assert.equal(asked.json().cancel.expiresAt, Math.floor(laterDeadline / 1000) * 1000);
  assert.ok(sponsoredUntil(asked.json().cancel.userOperation) <= laterDeadline);
});

test('migration 94 on an existing database: withdrawals stay as they were and keep working', async (t) => {
  registerBaseMigration();
  const versions = listMigrations().map((m) => m.version);
  assert.ok(versions.includes(94));
  assert.ok(versions.indexOf(94) > versions.indexOf(92));
  assert.equal(baseWalletRatingsMigration.name, 'base_wallet_ratings');
  assert.ok(BASE_TABLES.includes('base_rate_lookups'));
  assert.doesNotMatch(BASE_WALLET_RATINGS_SQL, /DROP (TABLE|COLUMN)|DELETE FROM|TRUNCATE/i);

  const f = await setup(t, { before94: true });
  await both(f);
  // A withdrawal from before 94, still awaiting its signature.
  const op = (await f.ops.port.prepare({
    wallet: f.wallets[AGENT_A],
    recipe: agentWalletRecipe(NETWORK, f.owner.address, accountIndexFor(AGENT_A)),
    calls: [withdrawalCall('USDC', OUTSIDE, 1_000_000n)],
  }))!;
  const old = 'aaaaaaaa-0000-4000-8000-000000000001';
  await f.pg.query(
    `INSERT INTO base_wallet_withdrawals (withdrawal_id, wallet_id, owner_account_id, chain_id,
       token, amount_raw, destination, idempotency_key, request_hash, state, nonce,
       user_operation, user_op_hash, expires_at, created_at, updated_at)
     VALUES ($1, $2, 'person-1', $3, 'USDC', 1000000, $4, $5, $6, 'awaiting_signature', $7, $8,
       $9, $10, $11, $11)`,
    [
      old,
      `wallet-${AGENT_A}`,
      CHAIN_ID,
      OUTSIDE,
      key(1),
      `0x${'cd'.repeat(32)}`,
      op.operation.nonce.toString(10),
      JSON.stringify(userOperationToRpc(op.operation)),
      op.userOpHash.toLowerCase(),
      NOW + 60_000,
      NOW,
    ],
  );
  await f.pg.exec(BASE_WALLET_RATINGS_SQL);
  // Applied twice is a no-op.
  await f.pg.exec(BASE_WALLET_RATINGS_SQL);
  const [row] = await rows(f, 'base_wallet_withdrawals');
  assert.equal(row.kind, 'withdraw');
  assert.equal(row.rated_agent_id, null);
  // It reads exactly as a withdrawal, and is still the wallet's open operation.
  const view = (await read(f, old)).json();
  assert.equal(view.kind, undefined);
  assert.equal(view.token, 'USDC');
  assert.equal(view.amount.raw, '1000000');
  assert.equal((await rate(f, rateBody(2))).json().code, 'operation_pending');
  // Signed as it was prepared, it goes out.
  const signed = await sign(f, { withdrawalId: old, userOpHash: op.userOpHash });
  assert.equal(signed.statusCode, 202, signed.body);
  assert.equal(signed.json().state, 'submitted');
  // The database refuses a withdrawal without its token, amount or destination, and a rating with
  // any of them, with a hold, unsponsored, or with another value.
  const insert = (id: string, fields: Record<string, unknown>) => {
    const values = {
      withdrawal_id: id,
      wallet_id: `wallet-${AGENT_A2}`,
      owner_account_id: 'person-1',
      chain_id: CHAIN_ID,
      idempotency_key: id,
      request_hash: `0x${'ab'.repeat(32)}`,
      state: 'expired',
      nonce: 0,
      user_operation: '{}',
      user_op_hash: `0x${'ab'.repeat(32)}`,
      expires_at: 1,
      created_at: 1,
      updated_at: 1,
      ...fields,
    };
    const columns = Object.keys(values);
    return f.pg.query(
      `INSERT INTO base_wallet_withdrawals (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(values),
    );
  };
  const withdrawal = { token: 'USDC', amount_raw: 1, destination: OUTSIDE };
  const rating = { kind: 'rate', rated_agent_id: AGENT_B, rated_base_id: 501, rating_value: 80 };
  await assert.rejects(insert('x1', { token: 'USDC', amount_raw: 1 }));
  await assert.rejects(insert('x2', { ...withdrawal, rating_value: 80 }));
  await assert.rejects(insert('x3', { ...rating, token: 'USDC' }));
  await assert.rejects(insert('x4', { ...rating, destination: OUTSIDE }));
  await assert.rejects(insert('x5', { ...rating, rating_value: 50 }));
  await assert.rejects(insert('x6', { ...rating, sponsored: false, max_fee_wei: 1 }));
  await assert.rejects(insert('x7', { ...rating, rated_agent_id: null }));
  await assert.rejects(insert('x8', { ...withdrawal, kind: 'other' }));
  await assert.rejects(insert('x9', { ...withdrawal, amount_raw: 0 }));
  await insert('ok-1', withdrawal);
  await insert('ok-2', rating);
  // Chain operations take the new kind.
  await f.pg.query(
    `INSERT INTO base_chain_ops (op_id, idempotency_key, intent_hash, kind, chain_id, status,
       created_at, updated_at) VALUES ('o-1', 'k-1', 'x', 'rate', $1, 'queued', 1, 1)`,
    [CHAIN_ID],
  );
  await assert.rejects(
    f.pg.query(
      `INSERT INTO base_chain_ops (op_id, idempotency_key, intent_hash, kind, chain_id, status,
         created_at, updated_at) VALUES ('o-2', 'k-2', 'x', 'giveFeedback', $1, 'queued', 1, 1)`,
      [CHAIN_ID],
    ),
  );
});

// --- ratings given (GET …/wallet/ratings) ------------------------------------------------------

const given = (f: Fixture, opts: { person?: string; agent?: string } = {}) =>
  f.app.inject({
    url: path(RATE_PATHS.ratings, opts.agent ?? AGENT_A),
    headers: as(opts.person ?? 'person-1'),
  });

/** A rating row made directly in the table: signed (final) unless said otherwise. */
async function seedGiven(
  f: Fixture,
  r: {
    id: string;
    createdAt: number;
    state?: 'final' | 'awaiting_signature' | 'expired';
    expiresAt?: number;
    wallet?: string;
    owner?: string;
    ratedAgent?: string;
    baseId?: number;
    value?: number;
  },
) {
  const state = r.state ?? 'final';
  const signed = state === 'final';
  await f.pg.query(
    `INSERT INTO base_wallet_withdrawals (withdrawal_id, wallet_id, owner_account_id, chain_id,
       kind, rated_agent_id, rated_base_id, rating_value, idempotency_key, request_hash, state,
       nonce, user_operation, user_op_hash, expires_at, owner_signature, chain_op_key, signed_at,
       tx_hash, block_number, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'rate', $5, $6, $7, 'given-key-' || $1, $8, $9, 0, '{}', $8, $10,
       $11, $12, $13, $14, $15, $16, $16)`,
    [
      r.id,
      r.wallet ?? `wallet-${AGENT_A}`,
      r.owner ?? 'person-1',
      CHAIN_ID,
      r.ratedAgent ?? AGENT_B,
      r.baseId ?? 501,
      r.value ?? 80,
      `0x${'ab'.repeat(32)}`,
      state,
      r.expiresAt ?? r.createdAt + 600_000,
      signed ? Buffer.from('cd'.repeat(65), 'hex') : null,
      signed ? `given-op-${r.id}` : null,
      signed ? r.createdAt + 1 : null,
      signed ? `0x${'ef'.repeat(32)}` : null,
      signed ? 1234 : null,
      r.createdAt,
    ],
  );
}

test('ratings given: off (without CITY_BASE_RATE or wallets) the list is 404 too', async (t) => {
  for (const env of [{ CITY_BASE_WALLET: '1' }, { [RATE_SETTING]: '1' }, {}]) {
    const f = await setup(t, { env });
    await both(f);
    await seedGiven(f, { id: 'given-1', createdAt: NOW - 1_000 });
    const res = await given(f);
    assert.equal(res.statusCode, 404, JSON.stringify(env));
    assert.deepEqual(res.json(), { error: 'Not found.' });
  }
});

test('ratings given: the owner sees what the agent’s wallet rated, as stored; nobody else', async (t) => {
  const f = await setup(t);
  await both(f);
  const empty = await given(f);
  assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(empty.json(), { ratings: [] });

  const r = await rated(f, 1, 5);
  const unsigned = (await given(f)).json().ratings;
  assert.equal(unsigned.length, 1);
  const [first] = unsigned;
  // Exactly these fields: the withdrawal view computes no `safe`, so there is none.
  assert.deepEqual(first, {
    withdrawalId: r.withdrawalId,
    ratedAgentId: AGENT_B,
    name: 'Juno',
    baseId: '501',
    short: 'Juno01',
    stars: 5,
    state: 'awaiting_signature',
    txHash: null,
    blockNumber: null,
    explorerUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

  assert.equal((await sign(f, r)).statusCode, 202);
  f.ops.land(r.userOpHash, 'included');
  const reads = f.base.state.reads.length;
  const prepares = f.ops.state.prepares.length;
  const head = f.ops.state.head;
  // As stored: the list reads nothing on Base, so it still says submitted until the rating is
  // read on the withdrawal route (which follows it on Base).
  assert.equal((await given(f)).json().ratings[0].state, 'submitted');
  assert.equal(f.base.state.reads.length, reads);
  assert.equal(f.ops.state.prepares.length, prepares);
  assert.equal(f.ops.state.head, head);
  assert.equal((await read(f, r.withdrawalId)).json().state, 'included');
  const included = (await given(f)).json().ratings[0];
  assert.equal(included.state, 'included');
  assert.match(included.txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(typeof included.blockNumber, 'number');
  assert.equal(included.explorerUrl, (await read(f, r.withdrawalId)).json().explorerUrl);
  assert.equal(included.explorerUrl.endsWith(`/tx/${included.txHash}`), true);
  f.ops.mine(Number(SETTLE_DEPTH));
  assert.equal((await read(f, r.withdrawalId)).json().state, 'final');
  assert.equal((await given(f)).json().ratings[0].state, 'final');

  // The name is the card's public name now: '' once it is not public.
  await f.db.query(
    `UPDATE agent_manifests SET manifest = jsonb_set(manifest, '{spec,visibility}', '"private"')
     WHERE agent_id = $1`,
    [AGENT_B],
  );
  const hidden = (await given(f)).json().ratings[0];
  assert.equal(hidden.name, '');
  assert.equal(hidden.short, 'Juno01');
  assert.equal(hidden.stars, 5);

  // Owner-only, as every rating route: another person, nobody, or not an agent of theirs.
  assert.equal((await given(f, { person: 'person-2' })).statusCode, 404);
  assert.deepEqual((await given(f, { person: 'person-2' })).json(), {
    error: 'Not found.',
    code: 'not_found',
  });
  assert.equal((await given(f, { person: 'person-3' })).statusCode, 404);
  assert.equal((await given(f, { person: '' })).statusCode, 401);
  assert.equal((await given(f, { agent: AGENT_B })).statusCode, 404);
  assert.equal((await given(f, { agent: 'not-a-uuid' })).statusCode, 404);
  // The person's other agent: its own wallet rated nothing.
  assert.deepEqual((await given(f, { agent: AGENT_A2 })).json(), { ratings: [] });
});

test('ratings given: newest first, at most 50, never one that was never signed in time', async (t) => {
  const f = await setup(t);
  await both(f);
  await register(f, {
    agentId: AGENT_C,
    baseId: '502',
    short: 'Mira02',
    wallet: WALLET_C,
    name: 'Mira',
  });
  // 55 final ratings, one a second apart (Juno and Mira by turns, every number of stars).
  for (let n = 1; n <= 55; n++)
    await seedGiven(f, {
      id: `given-${String(n).padStart(2, '0')}`,
      createdAt: NOW - 100_000 + n * 1_000,
      ratedAgent: n % 2 ? AGENT_B : AGENT_C,
      baseId: n % 2 ? 501 : 502,
      value: ((n % 5) + 1) * 20,
    });
  // Newer, but never signed: expired, or still awaiting its signature past its time.
  await seedRatings(f, 3, NOW - 10_000);
  await seedGiven(f, {
    id: 'given-stale',
    createdAt: NOW - 5_000,
    state: 'awaiting_signature',
    expiresAt: NOW - 1,
  });
  // Another wallet of the person, and this wallet under another owner account: not listed.
  await seedGiven(f, { id: 'given-a2', createdAt: NOW - 2_000, wallet: `wallet-${AGENT_A2}` });
  await seedGiven(f, { id: 'given-other', createdAt: NOW - 2_000, owner: 'person-3' });

  let list = (await given(f)).json().ratings as Array<Record<string, unknown>>;
  assert.equal(list.length, 50);
  assert.deepEqual(
    list.map((rating) => rating.withdrawalId),
    Array.from({ length: 50 }, (_, i) => `given-${String(55 - i).padStart(2, '0')}`),
  );
  assert.deepEqual(list.slice(0, 2), [
    {
      withdrawalId: 'given-55',
      ratedAgentId: AGENT_B,
      name: 'Juno',
      baseId: '501',
      short: 'Juno01',
      stars: 1,
      state: 'final',
      txHash: `0x${'ef'.repeat(32)}`,
      blockNumber: 1234,
      explorerUrl: `${TX_EXPLORER}0x${'ef'.repeat(32)}`,
      createdAt: NOW - 45_000,
      updatedAt: NOW - 45_000,
    },
    {
      withdrawalId: 'given-54',
      ratedAgentId: AGENT_C,
      name: 'Mira',
      baseId: '502',
      short: 'Mira02',
      stars: 5,
      state: 'final',
      txHash: `0x${'ef'.repeat(32)}`,
      blockNumber: 1234,
      explorerUrl: `${TX_EXPLORER}0x${'ef'.repeat(32)}`,
      createdAt: NOW - 46_000,
      updatedAt: NOW - 46_000,
    },
  ]);
  assert.ok(list.every((rating) => !String(rating.withdrawalId).startsWith('seed-')));

  // The stale one settles as expired (as the next read of it would); then one still awaiting its
  // signature, within its time: listed, as the newest.
  await f.pg.query(
    `UPDATE base_wallet_withdrawals SET state = 'expired' WHERE withdrawal_id = 'given-stale'`,
  );
  assert.equal((await given(f)).json().ratings[0].withdrawalId, 'given-55');
  await seedGiven(f, {
    id: 'given-open',
    createdAt: NOW - 1_000,
    state: 'awaiting_signature',
    expiresAt: NOW + 60_000,
  });
  list = (await given(f)).json().ratings;
  assert.equal(list.length, 50);
  assert.equal(list[0].withdrawalId, 'given-open');
  assert.equal(list[0].state, 'awaiting_signature');
  assert.equal(list[1].withdrawalId, 'given-55');
  // Past its time it is gone from the list, even before anything marks it expired.
  f.clock.now = NOW + 60_001;
  list = (await given(f)).json().ratings;
  assert.equal(list[0].withdrawalId, 'given-55');
});
