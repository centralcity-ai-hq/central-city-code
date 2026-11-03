import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import { encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { AGENT_ROWS_SQL } from '../server/agent-rows/schema.js';
import { WORKSPACE_AGENT_PATH_SQL } from '../server/agent-rows/agent-lookup-schema.js';
import { AGENT_PUBLIC_CARDS_SQL } from '../server/agent-rows/public-cards-schema.js';
import { arcChainIdsMigrations } from '../server/base/arc-chain-ids-schema.js';
import { arcRuntimeEnv } from '../server/base/chain/arc-env.js';
import type { BalanceReader } from '../server/base/chain/balances.js';
import { chainParams } from '../server/base/chain/chain-params.js';
import { agentWalletRecipe, deriveAddressLocal } from '../server/base/chain/derive.js';
import { registerOwnBundlerMaintainRoute } from '../server/base/chain/direct-bundler.js';
import {
  OWNER_NONCE_KEY,
  OwnerOperationError,
  type OwnerOperationsPort,
} from '../server/base/chain/owner-ops.js';
import { createChainRuntime } from '../server/base/chain/runtime.js';
import type { StoredOperation } from '../server/base/chain/submit.js';
import type { ChainRuntime } from '../server/base/identity/routes.js';
import type { PayChainReader } from '../server/base/pay/chain.js';
import {
  BASE_IDENTITY_HANDOVER_BACKOFF_SQL,
  BASE_IDENTITY_PROVISIONAL_SQL,
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
  BASE_SHARED_ADDITIONS_SQL,
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
} from '../server/base/schema.js';
import { registerBaseWalletRoutes, WALLET_CHAIN_ID } from '../server/base/wallet/routes.js';
import { accountIndexFor } from '../server/base/wallet/service.js';
import {
  sponsorBudget,
  SPONSOR_INFLIGHT_TOTAL_DEFAULT_WEI,
  SPONSOR_INFLIGHT_WALLET_DEFAULT_WEI,
  txExplorerOf,
  TX_EXPLORER,
  UNSIGNED_EXPOSURE_PER_ACCOUNT_WEI,
  WALLET_SWEEP_PATH,
  WITHDRAWAL_MIN_RAW,
} from '../server/base/wallet/withdrawals.js';
import type { Database } from '../server/database.js';
import { FEED_PAY_FEE_SQL } from '../server/feed/pay/fee-schema.js';
import { FEED_PAY_SQL } from '../server/feed/pay/schema.js';
import { PROTOCOL_SCREENING_SQL } from '../server/protocol/screening/schema.js';
import type { ScreeningProvider } from '../server/protocol/screening/gate.js';
import { sanctionsOracleFor } from '../server/protocol/screening/sanctions-oracle.js';
import {
  BASE_NETWORKS,
  NATIVE_ETH,
  type Address,
  type BaseChainId,
} from '../shared/base/chains.js';
import { REPLAYABLE_NONCE_KEY, usableLaneKey } from '../shared/base/lanes.js';
import { AGENT_URI_ORIGIN } from '../shared/base/on-base.js';
import {
  decodeOwnerCall,
  ownerOperationHash,
  withdrawalCall,
  WITHDRAWAL_CHAIN,
  type OwnerOperationChain,
} from '../shared/base/withdraw.js';
import {
  ARC_MAINNET,
  ARC_NETWORKS,
  ARC_TESTNET,
  ARC_USDC,
  chainNetwork,
  type ChainNetwork,
} from '../shared/chains.js';
import { protocolArcRouter3Address } from '../server/protocol/fees/cron.js';
import {
  PROTOCOL_BASE_MAINNET,
  SFP_SPONSOR_BASE_MAINNET,
  type ProtocolDeployment,
} from '../shared/protocol.js';

/*
 * Withdrawals and payments per chain: an Arc agent's are Arc's in every part (USDC, chain id, port,
 * screening, explorer, gas numbers), a signature for the other chain never counts, each sweep keeps
 * to its own chain's rows, and Base is what it was. Everything chain-side is a fake: no RPC, no
 * transaction anywhere.
 */

const BASE_NET = BASE_NETWORKS[WALLET_CHAIN_ID as BaseChainId];
const ARC_ON_ENV = { CITY_ARC: '1', CITY_ARC_CHAIN_ID: String(ARC_TESTNET) };
const ARC_NET = chainNetwork(ARC_TESTNET, ARC_ON_ENV) as ChainNetwork;
const ARC_CHAIN: OwnerOperationChain = {
  chainId: ARC_TESTNET,
  entryPoint: ARC_NET.contracts.entryPointV06,
  usdc: ARC_USDC,
  nativeWithdrawals: false,
};

const BASE_AGENT = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const ARC_AGENT = '1a2b3c4d-5b4a-4321-8fed-cba987654321';
const ARC_PEER = '2a2b3c4d-5b4a-4321-8fed-cba987654321';
const BASE_PEER = '3a2b3c4d-5b4a-4321-8fed-cba987654321';
const SPENDER = getAddress(`0x${'3'.repeat(40)}`);
const DEST = getAddress(`0x${'d7'.repeat(20)}`);
const ARC_PAYMASTER = getAddress(`0x${'a1'.repeat(20)}`);
const ARC_ROUTER = getAddress(`0x${'a3'.repeat(20)}`);
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const USDC_GAS = 10n ** 18n;
const CRON = 'a-cron-secret-long-enough';

const ARC_OFF = { CITY_BASE_WALLET: '1', CITY_FEED_PAY: '0' };
const ARC_ON = { ...ARC_OFF, ...ARC_ON_ENV };

const executeAbi = parseAbi(['function execute(address target, uint256 value, bytes data)']);

/** A sponsorship in the pinned layout, valid far past NOW and charging no token. */
const SPONSORED = `0x${'7a'.repeat(20)}${Math.floor(NOW / 1000 + 86_400)
  .toString(16)
  .padStart(12, '0')}${'00'.repeat(6)}${'00'.repeat(97)}${'ab'.repeat(65)}` as Hex;

const key = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

/** One chain's owner operations: what it was asked, nothing sent anywhere. */
function fakePort(network: Pick<ChainNetwork, 'chainId' | 'contracts'>) {
  const state = {
    prepared: [] as Array<Parameters<OwnerOperationsPort['prepare']>[0]>,
    submitted: [] as Array<Parameters<OwnerOperationsPort['submit']>[0]>,
    stored: new Map<string, StoredOperation>(),
    refreshes: 0,
    released: [] as string[],
    sponsorUnavailable: false,
    maxCostWei: 1_000n,
    /** While set, a refresh waits for this: a chain that doesn't answer. */
    stall: null as Promise<void> | null,
  };
  const entryPoint = network.contracts.entryPointV06;
  const port: OwnerOperationsPort = {
    chainId: network.chainId,
    entryPoint,
    sendMarginMs: () => 0,
    sponsorshipValid: () => true,
    async prepare(input) {
      state.prepared.push(input);
      if (state.sponsorUnavailable && input.ownerFunded !== true)
        throw new OwnerOperationError('SPONSORSHIP_UNAVAILABLE', 'No sponsor.');
      const [call] = input.calls;
      const operation: UserOperation<'0.6'> = {
        sender: input.wallet,
        nonce: input.pinnedNonce ?? (input.nonceKey ?? OWNER_NONCE_KEY) << 64n,
        initCode: '0x',
        callData: encodeFunctionData({
          abi: executeAbi,
          functionName: 'execute',
          args: [call.target, call.value, call.data],
        }),
        callGasLimit: 100_000n,
        verificationGasLimit: 200_000n,
        preVerificationGas: 50_000n,
        // Each chain's real price: about 25 gwei of USDC on Arc, a fraction of a gwei on Base.
        maxFeePerGas: network.chainId === WALLET_CHAIN_ID ? 6_000_000n : 25_000_000_000n,
        maxPriorityFeePerGas: 1_000n,
        paymasterAndData: input.ownerFunded === true ? '0x' : SPONSORED,
        signature: '0x',
      };
      return {
        operation,
        userOpHash: getUserOperationHash({
          chainId: network.chainId,
          entryPointAddress: entryPoint,
          entryPointVersion: '0.6',
          userOperation: operation,
        }),
        sponsored: input.ownerFunded !== true,
        maxCostWei: state.maxCostWei,
        deployed: true,
      };
    },
    release: async (hash) => {
      state.released.push(hash);
    },
    isContract: async () => false,
    settledAtSafe: async () => false,
    async submit(input) {
      state.submitted.push(input);
      const stored = {
        idempotencyKey: input.idempotencyKey,
        intentHash: input.intentHash,
        chainId: network.chainId,
        kind: input.kind,
        sender: input.wallet,
        signer: input.owner,
        nonce: input.operation.nonce.toString(10),
        userOpHash: input.userOpHash,
        signedOperation: '{}',
        status: 'submitted',
        txHash: null,
        blockNumber: null,
        gasUsed: null,
        feeWei: null,
        maxCostWei: '1',
        submittedBlock: '1',
        errorCode: null,
      } as unknown as StoredOperation;
      state.stored.set(input.idempotencyKey, stored);
      return stored;
    },
    async refresh(idempotencyKey) {
      state.refreshes += 1;
      if (state.stall) await state.stall;
      return state.stored.get(idempotencyKey) ?? null;
    },
  };
  /** Everything it holds goes final in a block. */
  const finish = (n: number) => {
    for (const op of state.stored.values())
      Object.assign(op, { status: 'final', txHash: key(n), blockNumber: String(n) });
  };
  return { state, port, finish };
}

const clearProvider = () => {
  const asked: Array<{ chainId: number; addresses: string[] }> = [];
  const listed = new Set<string>();
  const control = { fail: false };
  const provider: ScreeningProvider = {
    ref: 'test-provider',
    supports: () => true,
    async check({ chainId, addresses }) {
      asked.push({ chainId, addresses });
      if (control.fail) throw new Error('The oracle is down.');
      return {
        listed: Object.fromEntries(addresses.map((a) => [a, listed.has(a.toLowerCase())])),
        observedAt: NOW,
      };
    },
  };
  return { provider, asked, listed, control };
};

interface Options {
  env?: Record<string, string | undefined>;
  /** Arc's runtime throws, as with a setting missing. */
  arcRuntimeBroken?: boolean;
  /** Arc's server keys, as its runtime reads them from the key rows. */
  arcKeys?: string[];
  arcKeysBroken?: boolean;
  /** The deployments fixed in code. */
  deploymentFor?: (chainId: number) => ProtocolDeployment | null;
  noProvider?: boolean;
  /** Both wallets at one address (recipe unchanged): the hardest case for a signature. */
  sameAddress?: boolean;
  cronSecret?: string;
}

async function setup(t: { after: (fn: () => Promise<unknown>) => void }, options: Options = {}) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('person-1','owner'), ('person-2','owner');
    CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL);
    INSERT INTO workspaces VALUES ('person-1', '{"agents": []}'), ('person-2', '{"agents": []}');
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);
    INSERT INTO agent_manifests VALUES ('${BASE_AGENT}', 'person-1', 1, '{}'),
      ('${ARC_AGENT}', 'person-1', 1, '{}'), ('${ARC_PEER}', 'person-2', 1, '{}'),
      ('${BASE_PEER}', 'person-2', 1, '{}');`);
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
    BASE_WALLET_LIMITS_SQL,
    BASE_WALLET_PAYMENTS_SQL,
    BASE_WALLET_RATINGS_SQL,
    BASE_WALLET_ONE_UNSIGNED_SQL,
    BASE_WALLET_LANES_SQL,
    BASE_WALLET_WITHDRAWALS_SAFE_SQL,
    BASE_SPONSOR_EXPOSURE_SQL,
    AGENT_ROWS_SQL,
    WORKSPACE_AGENT_PATH_SQL,
    AGENT_PUBLIC_CARDS_SQL,
    FEED_PAY_SQL,
    FEED_PAY_FEE_SQL,
    PROTOCOL_SCREENING_SQL,
  ])
    await pg.exec(sql);
  // The real CHECK migrations of the tables that name their chains here: no new one is needed.
  for (const table of [
    'base_wallets ',
    'base_wallet_withdrawals ',
    'base_pay_lookups ',
    'base_wallet_payments ',
  ])
    await pg.exec(
      (arcChainIdsMigrations.find((each) => each.sql.includes(table)) as { sql: string }).sql,
    );
  const queries: string[] = [];
  const db: Database = {
    query: (sql, params) => {
      queries.push(sql);
      return pg.query(sql, params) as never;
    },
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const owner = privateKeyToAccount(generatePrivateKey());
  const owner2 = privateKeyToAccount(generatePrivateKey());
  await pg.query(
    `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key, kdf_params,
       cipher_params, version, backup_confirmed_at, created_at, updated_at)
     VALUES ('person-1', $1, decode(repeat('ab', 48), 'hex'), '{}', '{}', 1, 1, 1, 1),
       ('person-2', $2, decode(repeat('ab', 48), 'hex'), '{}', '{}', 1, 1, 1, 1)`,
    [owner.address, owner2.address],
  );
  const addresses: Record<string, Address> = {};
  const wallet = async (
    id: string,
    agent: string,
    chainId: number,
    network: ChainNetwork,
    who: { account: string; owner: Address; address?: Address },
  ) => {
    const recipe = agentWalletRecipe(network, who.owner, accountIndexFor(agent));
    addresses[agent] = who.address ?? deriveAddressLocal(recipe);
    await pg.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at,
         owner_account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'v1:k',$8,'derived',0,0,$3)`,
      [
        id,
        agent,
        who.account,
        chainId,
        addresses[agent],
        who.owner,
        SPENDER,
        JSON.stringify({
          version: 1,
          owners: recipe.owners,
          factory: recipe.factory,
          implementationVersion: 'test',
          accountIndex: recipe.index.toString(10),
        }),
      ],
    );
  };
  const me = { account: 'person-1', owner: owner.address };
  const them = { account: 'person-2', owner: owner2.address };
  await wallet('w-base', BASE_AGENT, WALLET_CHAIN_ID, BASE_NET, me);
  await wallet('w-arc', ARC_AGENT, ARC_TESTNET, ARC_NET, {
    ...me,
    ...(options.sameAddress ? { address: addresses[BASE_AGENT] } : {}),
  });
  await wallet('w-arc-peer', ARC_PEER, ARC_TESTNET, ARC_NET, them);
  await wallet('w-base-peer', BASE_PEER, WALLET_CHAIN_ID, BASE_NET, them);

  const basePort = fakePort(BASE_NET);
  const arcPort = fakePort(ARC_NET);
  const asked = {
    runtimes: [] as number[],
    arcBalances: [] as number[],
    arcChains: [] as number[],
    arcProviders: [] as number[],
    baseBalances: 0,
    arcReads: 0,
  };
  const screening = clearProvider();
  const balanceOf = (onRead: () => void): BalanceReader => ({
    balances: async () => {
      onRead();
      return { usdc: 5_000_000n, eth: 10n ** 15n, deployed: true, blockNumber: 100n };
    },
  });
  const owners = {
    base: new Map<string, Address>(),
    arc: new Map<string, Address>(),
  };
  const ownerReader = (
    chainId: number,
    registry: Address,
    held: Map<string, Address>,
  ): PayChainReader => ({
    chainId,
    registry,
    ownerOf: async (baseId) => ({
      block: 100n,
      blockHash: key(100),
      owner: held.get(baseId) ?? null,
    }),
  });
  const env = options.env ?? ARC_ON;
  const app = Fastify();
  t.after(() => app.close());
  const logs: string[] = [];
  registerBaseWalletRoutes(app, {
    db,
    env,
    log: (line) => logs.push(line),
    currentPerson: async (request) => ({
      id: (request.headers['x-test-person'] as string | undefined) ?? 'person-1',
    }),
    currentWorkspace: async (request) => ({
      id: (request.headers['x-test-person'] as string | undefined) ?? 'person-1',
    }),
    runtime: async (chainId) => {
      asked.runtimes.push(chainId);
      if (chainId === WALLET_CHAIN_ID)
        return { ownerOperations: basePort.port } as unknown as ChainRuntime;
      if (options.arcRuntimeBroken) throw new Error('A setting is missing.');
      return {
        arcOwnerOperations: () => arcPort.port,
        protocolKeyAddresses: async () => {
          if (options.arcKeysBroken) throw new Error('A key row cannot be read.');
          return options.arcKeys ?? [];
        },
      } as unknown as ChainRuntime;
    },
    ...(options.deploymentFor ? { protocolDeploymentFor: options.deploymentFor } : {}),
    balances: balanceOf(() => {
      asked.baseBalances += 1;
    }),
    arcBalances: (chainId) => {
      asked.arcBalances.push(chainId);
      return balanceOf(() => {
        asked.arcReads += 1;
      });
    },
    payChain: ownerReader(
      WALLET_CHAIN_ID,
      BASE_NET.contracts.identityRegistry as Address,
      owners.base,
    ),
    arcPayChain: (chainId) => {
      asked.arcChains.push(chainId);
      return ownerReader(chainId, ARC_NET.contracts.identityRegistry as Address, owners.arc);
    },
    arcScreeningProvider: (chainId) => {
      asked.arcProviders.push(chainId);
      return options.noProvider ? null : screening.provider;
    },
    cronSecret: options.cronSecret,
    now: () => NOW,
  });
  const url = (agent: string, path: string) => `/api/base/agents/${agent}/wallet/${path}`;
  const post = (agent: string, path: string, body: unknown, person = 'person-1') =>
    app.inject({
      method: 'POST',
      url: url(agent, path),
      headers: { 'x-test-person': person },
      payload: body as object,
    });
  let keys = 0;
  const withdraw = (agent: string, body: Record<string, unknown> = {}, person = 'person-1') =>
    post(
      agent,
      'withdrawals',
      {
        idempotencyKey: `00000000-0000-4000-8000-${String(++keys).padStart(12, '0')}`,
        token: 'USDC',
        amount: '100000',
        to: DEST,
        ...body,
      },
      person,
    );
  return {
    pg,
    db,
    queries,
    app,
    owner,
    owner2,
    addresses,
    basePort,
    arcPort,
    asked,
    screening,
    owners,
    logs,
    url,
    post,
    withdraw,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

const sign = (f: Fixture, hash: Hex) => f.owner.sign({ hash });

async function created(f: Fixture, agent: string) {
  const res = await f.withdraw(agent);
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

const rowState = async (f: Fixture, id: string) =>
  (
    await f.pg.query<{ state: string }>(
      'SELECT state FROM base_wallet_withdrawals WHERE withdrawal_id = $1',
      [id],
    )
  ).rows[0].state;

test('Base gets its numbers from one place, unchanged', () => {
  const ops = chainParams(WALLET_CHAIN_ID).ownerOps;
  assert.equal(SPONSOR_INFLIGHT_WALLET_DEFAULT_WEI, 100_000_000_000_000_000n);
  assert.equal(SPONSOR_INFLIGHT_TOTAL_DEFAULT_WEI, 3_000_000_000_000_000_000n);
  assert.equal(UNSIGNED_EXPOSURE_PER_ACCOUNT_WEI, 20_000_000_000_000_000n);
  assert.deepEqual(WITHDRAWAL_MIN_RAW, { USDC: 10_000n, ETH: 10_000_000_000_000n });
  assert.equal(ops.exposureLockKey, '7161117711238328179');
  assert.equal(TX_EXPLORER, 'https://basescan.org/tx/');
  assert.equal(txExplorerOf(WALLET_CHAIN_ID), TX_EXPLORER);
  assert.equal(txExplorerOf(ARC_TESTNET), `${ARC_NETWORKS[ARC_TESTNET].explorerUrl}/tx/`);
  assert.equal(txExplorerOf(ARC_MAINNET), `${ARC_NETWORKS[ARC_MAINNET].explorerUrl}/tx/`);
  assert.deepEqual(sponsorBudget({}), {
    perWallet: 100_000_000_000_000_000n,
    total: 3_000_000_000_000_000_000n,
    feeCap: null,
  });
  assert.deepEqual(
    sponsorBudget({
      CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET: '5',
      CITY_BASE_SPONSOR_INFLIGHT_WEI_TOTAL: '6',
      CITY_BASE_WALLET_FEE_CAP_WEI: '7',
    }),
    { perWallet: 5n, total: 6n, feeCap: 7n },
  );
});

test("Arc's budgets are in USDC of gas: Base's settings and ETH numbers never reach them", () => {
  const baseSettings = {
    CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET: '5',
    CITY_BASE_SPONSOR_INFLIGHT_WEI_TOTAL: '6',
    CITY_BASE_WALLET_FEE_CAP_WEI: '7',
  };
  assert.deepEqual(sponsorBudget(arcRuntimeEnv({ ...ARC_ON, ...baseSettings }), ARC_TESTNET), {
    perWallet: 5n * USDC_GAS,
    total: 50n * USDC_GAS,
    feeCap: null,
  });
  assert.deepEqual(
    sponsorBudget(
      arcRuntimeEnv({
        ...ARC_ON,
        CITY_ARC_SPONSOR_INFLIGHT_WEI_PER_WALLET: '8',
        CITY_ARC_SPONSOR_INFLIGHT_WEI_TOTAL: '9',
        CITY_ARC_WALLET_FEE_CAP_WEI: '10',
      }),
      ARC_TESTNET,
    ),
    { perWallet: 8n, total: 9n, feeCap: 10n },
  );
  const arc = chainParams(ARC_TESTNET).ownerOps;
  assert.equal(arc.withdrawalMinUsdcRaw, 50_000n);
  assert.equal(arc.withdrawalMinNativeWei, null);
  assert.equal(arc.unsignedPerAccountWei, 4n * USDC_GAS);
  assert.notEqual(arc.exposureLockKey, chainParams(WALLET_CHAIN_ID).ownerOps.exposureLockKey);
});

test('Arc off: nothing of Arc is built or asked, and an Arc row is no withdrawal wallet', async (t) => {
  const f = await setup(t, { env: ARC_OFF });
  const res = await created(f, BASE_AGENT);
  assert.equal(res.chainId, WALLET_CHAIN_ID);
  assert.equal(res.summary.fee.token, 'ETH');
  f.queries.length = 0;
  const arc = await f.withdraw(ARC_AGENT);
  assert.equal(arc.statusCode, 404, arc.body);
  assert.equal(f.queries.filter((sql) => /chain_id IN \(\$2, \$3\)/.test(sql)).length, 0);
  assert.deepEqual(f.asked.arcBalances, []);
  assert.deepEqual(f.asked.arcChains, []);
  assert.deepEqual(f.asked.arcProviders, []);
  assert.equal(f.asked.runtimes.includes(ARC_TESTNET), false);
  assert.deepEqual(f.screening.asked, []);
  assert.equal(f.arcPort.state.prepared.length, 0);
  // ?chain= is an unknown parameter again: the answer it always was.
  for (const path of [
    `/api/base/pay/recipient?q=501&chain=${ARC_TESTNET}`,
    `/api/base/pay/incoming?chain=${ARC_TESTNET}`,
  ]) {
    const refused = await f.app.inject({ url: path });
    assert.equal(refused.statusCode, 400, path);
    assert.equal(refused.json().code, 'invalid_query');
  }
});

test('Arc off: the sweep only ever reads Base, and leaves an Arc row alone', async (t) => {
  const f = await setup(t, { env: ARC_OFF, cronSecret: CRON });
  const base = await created(f, BASE_AGENT);
  await f.pg.query(
    `INSERT INTO base_wallet_withdrawals (withdrawal_id, wallet_id, owner_account_id, chain_id,
       token, amount_raw, destination, idempotency_key, request_hash, state, nonce, user_operation,
       user_op_hash, expires_at, created_at, updated_at, sponsored, max_fee_wei)
     SELECT '11111111-1111-4111-8111-111111111111', 'w-arc', owner_account_id, $1, token,
       amount_raw, destination, '11111111-1111-4111-8111-111111111112', request_hash,
       'awaiting_signature', nonce, user_operation, $2, 1, 1, 1, sponsored, max_fee_wei
     FROM base_wallet_withdrawals WHERE withdrawal_id = $3`,
    [ARC_TESTNET, key(9), base.withdrawalId],
  );
  const sweep = await f.app.inject({
    url: WALLET_SWEEP_PATH,
    headers: { authorization: `Bearer ${CRON}` },
  });
  assert.equal(sweep.statusCode, 200, sweep.body);
  assert.deepEqual(sweep.json(), { expired: 0, advanced: 0 });
  assert.equal(await rowState(f, '11111111-1111-4111-8111-111111111111'), 'awaiting_signature');
  assert.equal(f.asked.runtimes.includes(ARC_TESTNET), false);
});

test('Arc on: a Base agent is what it was, on Base only', async (t) => {
  const off = await setup(t, { env: ARC_OFF });
  const on = await setup(t);
  const a = await created(off, BASE_AGENT);
  const b = await created(on, BASE_AGENT);
  // Everything but the ids, the keys and what the random owner makes differ.
  const shape = (req: typeof a) => ({
    state: req.state,
    entryPoint: req.entryPoint,
    chainId: req.chainId,
    summary: { ...req.summary, from: undefined },
    target: decodeOwnerCall(req.userOperation.callData, req.summary.from),
  });
  assert.deepEqual(shape(b), shape(a));
  assert.equal(b.chainId, WALLET_CHAIN_ID);
  assert.equal(b.summary.network, BASE_NET.name);
  assert.equal(b.summary.fee.token, 'ETH');
  assert.equal(b.summary.fee.max.decimals, 18);
  // ETH stays a Base token, not screened, on Base's port and reader.
  const eth = await on.withdraw(BASE_AGENT, { token: 'ETH', amount: '100000000000000' });
  assert.notEqual(eth.json().code, 'invalid_body', eth.body);
  assert.deepEqual(on.screening.asked, []);
  assert.equal(on.arcPort.state.prepared.length, 0);
  assert.equal(on.asked.arcReads, 0);
  assert.equal(on.asked.runtimes.includes(ARC_TESTNET), false);
  assert.equal(on.basePort.state.prepared[0].calls[0].target, BASE_NET.tokens.USDC.address);
  const hash = b.userOpHash as Hex;
  const signed = await on.post(BASE_AGENT, `withdrawals/${b.withdrawalId}/signature`, {
    signature: await sign(on, hash),
  });
  assert.equal(signed.statusCode, 202, signed.body);
  assert.equal(on.basePort.state.submitted.length, 1);
  on.basePort.finish(7);
  const read = await on.app.inject({ url: on.url(BASE_AGENT, `withdrawals/${b.withdrawalId}`) });
  assert.equal(read.json().state, 'final');
  assert.equal(read.json().explorerUrl, `https://basescan.org/tx/${key(7)}`);
});

test("an Arc withdrawal is Arc's in every part", async (t) => {
  const f = await setup(t);
  const req = await created(f, ARC_AGENT);
  assert.equal(req.chainId, ARC_TESTNET);
  assert.equal(req.entryPoint, ARC_NET.contracts.entryPointV06);
  assert.equal(req.summary.network, ARC_NET.name);
  assert.equal(req.summary.testnet, true);
  assert.equal(req.summary.token, 'USDC');
  assert.deepEqual(req.summary.amount, { raw: '100000', decimals: 6, display: '0.1' });
  // Gas shown is USDC, at USDC's decimals, and the sponsor's.
  assert.deepEqual(req.summary.fee, {
    paidBy: 'sponsor',
    token: 'USDC',
    max: { raw: '0', decimals: 6, display: '0' },
  });
  const [input] = f.arcPort.state.prepared;
  assert.equal(input.calls[0].target, ARC_USDC);
  assert.equal(input.nonceKey, undefined);
  assert.equal(f.basePort.state.prepared.length, 0);
  assert.deepEqual(decodeOwnerCall(req.userOperation.callData, req.summary.from, ARC_CHAIN), {
    kind: 'withdraw',
    token: 'USDC',
    to: DEST,
    amount: 100_000n,
  });
  const row = await f.pg.query<{ chain_id: number; token: string; sum: string }>(
    `SELECT r.chain_id, r.token, r.amount::text AS sum FROM base_wallet_reservations r
     WHERE r.holder_ref = $1`,
    [req.withdrawalId],
  );
  assert.equal(row.rows[0].chain_id, ARC_TESTNET);
  assert.equal(row.rows[0].token.toLowerCase(), ARC_USDC.toLowerCase());
  const exposure = await f.pg.query<{ chain_id: number }>(
    'SELECT chain_id FROM base_sponsor_exposure WHERE withdrawal_id = $1',
    [req.withdrawalId],
  );
  assert.deepEqual([...new Set(exposure.rows.map((one) => one.chain_id))], [ARC_TESTNET]);

  const signed = await f.post(ARC_AGENT, `withdrawals/${req.withdrawalId}/signature`, {
    signature: await sign(f, req.userOpHash),
  });
  assert.equal(signed.statusCode, 202, signed.body);
  assert.equal(f.arcPort.state.submitted.length, 1);
  assert.equal(f.basePort.state.submitted.length, 0);
  f.arcPort.finish(9);
  const read = await f.app.inject({ url: f.url(ARC_AGENT, `withdrawals/${req.withdrawalId}`) });
  assert.equal(read.json().state, 'final');
  assert.equal(read.json().chainId, ARC_TESTNET);
  assert.equal(read.json().explorerUrl, `${ARC_NETWORKS[ARC_TESTNET].explorerUrl}/tx/${key(9)}`);
});

test('native gas is never a withdrawal on Arc: refused, never encoded, never decoded', async (t) => {
  const f = await setup(t);
  for (const body of [{ token: 'ETH' }, { token: 'ETH', amount: 'max' }]) {
    const res = await f.withdraw(ARC_AGENT, body);
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().code, 'invalid_body');
    assert.match(res.json().error, /only USDC/);
  }
  assert.equal(f.arcPort.state.prepared.length, 0);
  assert.equal(f.asked.arcReads, 0);
  assert.throws(() => withdrawalCall('ETH', DEST, 1n, ARC_CHAIN), /USDC only/);
  const send = encodeFunctionData({
    abi: executeAbi,
    functionName: 'execute',
    args: [DEST, 1n, '0x'],
  });
  const wallet = f.addresses[ARC_AGENT];
  assert.equal(decodeOwnerCall(send, wallet, ARC_CHAIN), null);
  assert.deepEqual(decodeOwnerCall(send, wallet), {
    kind: 'withdraw',
    token: 'ETH',
    to: DEST,
    amount: 1n,
  });
  // Each chain's USDC is a transfer on that chain only.
  const onBase = withdrawalCall('USDC', DEST, 5n);
  const onArc = withdrawalCall('USDC', DEST, 5n, ARC_CHAIN);
  const asCall = (call: typeof onBase) =>
    encodeFunctionData({
      abi: executeAbi,
      functionName: 'execute',
      args: [call.target, call.value, call.data],
    });
  assert.equal(decodeOwnerCall(asCall(onBase), wallet, ARC_CHAIN), null);
  assert.equal(decodeOwnerCall(asCall(onArc), wallet), null);
});

test("Arc's smallest withdrawal is its own, in USDC", async (t) => {
  const f = await setup(t);
  const small = await f.withdraw(ARC_AGENT, { amount: '10000' });
  assert.equal(small.statusCode, 400, small.body);
  assert.equal(small.json().code, 'amount_too_small');
  assert.deepEqual(small.json().min, { raw: '50000', decimals: 6, display: '0.05' });
  assert.equal(f.arcPort.state.prepared.length, 0);
  assert.equal((await f.withdraw(BASE_AGENT, { amount: '10000' })).statusCode, 201);
});

test("a gas cost that is nothing on Arc isn't read as ETH by the sponsor's caps", async (t) => {
  const f = await setup(t);
  // 0.5 USDC of gas: as a number of ETH it would be far over Base's 0.02 unsigned cap.
  f.arcPort.state.maxCostWei = USDC_GAS / 2n;
  await created(f, ARC_AGENT);
  // Over Arc's own 4 USDC per account it is refused.
  const other = await setup(t);
  other.arcPort.state.maxCostWei = 5n * USDC_GAS;
  const over = await other.withdraw(ARC_AGENT);
  assert.equal(over.statusCode, 409, over.body);
  assert.equal(over.json().code, 'sponsor_busy');
});

test('sponsored or nothing on Arc, whatever the fallback setting says, cancels too', async (t) => {
  const f = await setup(t, {
    env: { ...ARC_ON, CITY_BASE_WALLET_UNSPONSORED_FALLBACK: '1', CITY_BASE_LANES: '1' },
  });
  f.arcPort.state.sponsorUnavailable = true;
  const res = await f.withdraw(ARC_AGENT);
  assert.equal(res.statusCode, 503, res.body);
  assert.equal(res.json().code, 'sponsorship_unavailable');
  assert.equal(
    f.arcPort.state.prepared.some((input) => input.ownerFunded),
    false,
  );
  f.arcPort.state.sponsorUnavailable = false;
  const req = await created(f, ARC_AGENT);
  // Base's lanes setting doesn't reach Arc either.
  assert.equal(req.lanes, undefined);
  assert.equal(f.arcPort.state.prepared.at(-1)?.nonceKey, undefined);
  await f.post(ARC_AGENT, `withdrawals/${req.withdrawalId}/signature`, {
    signature: await sign(f, req.userOpHash),
  });
  f.arcPort.state.sponsorUnavailable = true;
  const cancel = await f.post(ARC_AGENT, `withdrawals/${req.withdrawalId}/cancel`, {});
  assert.equal(cancel.statusCode, 503, cancel.body);
  assert.equal(cancel.json().code, 'sponsorship_unavailable');
  assert.equal(
    f.arcPort.state.prepared.some((input) => input.ownerFunded),
    false,
  );
  f.arcPort.state.sponsorUnavailable = false;
  const asked = await f.post(ARC_AGENT, `withdrawals/${req.withdrawalId}/cancel`, {});
  assert.equal(asked.statusCode, 200, asked.body);
  assert.equal(asked.json().cancel.fee.token, 'USDC');
  assert.equal(asked.json().cancel.entryPoint, ARC_NET.contracts.entryPointV06);
});

test("REFUSED on Arc: its contracts, its USDC, this deployment's own, and Base's", async (t) => {
  const f = await setup(t, {
    env: { ...ARC_ON, CITY_ARC_PAYMASTER: ARC_PAYMASTER, CITY_ARC_FEE_ROUTER3: ARC_ROUTER },
  });
  const arc = ARC_NETWORKS[ARC_TESTNET];
  const refused = [
    ARC_USDC,
    ...Object.values(arc.contracts).filter((address): address is Address => address !== null),
    ARC_PAYMASTER,
    ARC_ROUTER,
    PROTOCOL_BASE_MAINNET.feeRouter3,
    BASE_NET.tokens.USDC.address,
    NATIVE_ETH,
    f.addresses[ARC_AGENT],
    SPENDER,
  ];
  for (const to of refused) {
    const res = await f.withdraw(ARC_AGENT, { to: to.toLowerCase() });
    assert.equal(res.statusCode, 409, `${to} ${res.body}`);
    assert.equal(res.json().code, 'destination_not_allowed', to);
  }
  assert.equal(f.arcPort.state.prepared.length, 0);
});

test('REFUSED on Arc: router 3 of a deployment fixed in code, with no setting, as the ledger reads it', async (t) => {
  const deployed = getAddress(`0x${'a8'.repeat(20)}`);
  const deploymentFor = (chainId: number) =>
    chainId === ARC_TESTNET ? { ...PROTOCOL_BASE_MAINNET, chainId, feeRouter3: deployed } : null;
  const f = await setup(t, { env: ARC_ON, deploymentFor });
  const res = await f.withdraw(ARC_AGENT, { to: deployed.toLowerCase() });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, 'destination_not_allowed');
  assert.equal(f.arcPort.state.prepared.length, 0);
  // The same address the ledger reads, and another destination still goes.
  assert.equal(
    protocolArcRouter3Address(
      { ...ARC_ON, CITY_ARC_FEE_ROUTER3: ARC_ROUTER },
      ARC_TESTNET,
      deploymentFor,
    ),
    deployed,
  );
  assert.equal((await f.withdraw(ARC_AGENT)).statusCode, 201);
});

test('REFUSED on Arc: its facilitator, paymaster signer and submitters, whatever the letter case', async (t) => {
  const keys = ['c1', 'c2', 'c3'].map((byte) => `0x${byte.repeat(20)}`);
  const f = await setup(t, { arcKeys: keys });
  for (const key of keys) {
    const res = await f.withdraw(ARC_AGENT, { to: getAddress(key) });
    assert.equal(res.statusCode, 409, `${key} ${res.body}`);
    assert.equal(res.json().code, 'destination_not_allowed', key);
  }
  assert.equal(f.arcPort.state.prepared.length, 0);
  assert.equal((await f.withdraw(ARC_AGENT)).statusCode, 201);
  // Base's own withdrawals don't ask: Base's fake runtime has no key addresses at all.
  const onBase = await f.withdraw(BASE_AGENT, { to: getAddress(keys[0]!) });
  assert.equal(onBase.statusCode, 201, onBase.body);
});

test("Arc's server keys that can't be read refuse the withdrawal: nothing is prepared", async (t) => {
  const f = await setup(t, { arcKeysBroken: true });
  const res = await f.withdraw(ARC_AGENT);
  assert.equal(res.statusCode, 503, res.body);
  assert.equal(res.json().code, 'chain_unavailable');
  assert.equal(f.arcPort.state.prepared.length, 0);
});

for (const [name, from, to] of [
  ['Base on Arc', 'base', 'arc'],
  ['Arc on Base', 'arc', 'base'],
] as const)
  test(`a signature for ${name} is refused: same wallet, same EntryPoint, same operation`, async (t) => {
    const f = await setup(t, { sameAddress: true });
    assert.equal(f.addresses[BASE_AGENT], f.addresses[ARC_AGENT]);
    // The contracts the signature could be replayed through sit at one address on both chains.
    assert.equal(BASE_NET.contracts.entryPointV06, ARC_NET.contracts.entryPointV06);
    assert.equal(
      BASE_NET.contracts.spendPermissionManager,
      ARC_NET.contracts.spendPermissionManager,
    );
    const agents = { base: BASE_AGENT, arc: ARC_AGENT };
    const chains = { base: WITHDRAWAL_CHAIN, arc: ARC_CHAIN };
    const req = await created(f, agents[to]);
    // Its own operation, signed exactly as the other chain would hash it.
    const { userOperationFromRpc } = await import('../shared/base/withdraw.js');
    const op = userOperationFromRpc(req.userOperation);
    const other = ownerOperationHash(op, chains[from]);
    assert.notEqual(other, req.userOpHash);
    assert.equal(ownerOperationHash(op, chains[to]), req.userOpHash);
    const refused = await f.post(agents[to], `withdrawals/${req.withdrawalId}/signature`, {
      signature: await sign(f, other),
    });
    assert.equal(refused.statusCode, 422, refused.body);
    assert.equal(refused.json().code, 'signature_mismatch');
    assert.equal(await rowState(f, req.withdrawalId), 'awaiting_signature');
    // A row made to carry the other chain's hash doesn't pass either: the operation is hashed again.
    await f.pg.query(
      'UPDATE base_wallet_withdrawals SET user_op_hash = $2 WHERE withdrawal_id = $1',
      [req.withdrawalId, other],
    );
    const forged = await f.post(agents[to], `withdrawals/${req.withdrawalId}/signature`, {
      signature: await sign(f, other),
    });
    assert.equal(forged.statusCode, 409, forged.body);
    assert.equal(forged.json().code, 'operation_mismatch');
    assert.equal(await rowState(f, req.withdrawalId), 'awaiting_signature');
    assert.equal(f.basePort.state.submitted.length, 0);
    assert.equal(f.arcPort.state.submitted.length, 0);
  });

test('a withdrawal of one chain is not found through an agent on the other, and keys stay apart', async (t) => {
  const f = await setup(t);
  const shared = { idempotencyKey: '22222222-2222-4222-8222-222222222222' };
  const first = await f.withdraw(BASE_AGENT, shared);
  assert.equal(first.statusCode, 201, first.body);
  const onBase = first.json();
  // One idempotency key can't name a withdrawal on both.
  const reused = await f.withdraw(ARC_AGENT, shared);
  assert.equal(reused.statusCode, 409, reused.body);
  assert.equal(reused.json().code, 'idempotency_conflict');
  assert.equal(f.arcPort.state.prepared.length, 0);
  const onArc = await created(f, ARC_AGENT);
  const asArc = await f.app.inject({
    url: f.url(ARC_AGENT, `withdrawals/${onBase.withdrawalId}`),
  });
  assert.equal(asArc.statusCode, 404, asArc.body);
  const asBase = await f.app.inject({
    url: f.url(BASE_AGENT, `withdrawals/${onArc.withdrawalId}`),
  });
  assert.equal(asBase.statusCode, 404, asBase.body);
});

test('someone else gets 404 for an Arc agent; ratings are not refused as not on Arc', async (t) => {
  const f = await setup(t);
  const stranger = await f.withdraw(ARC_AGENT, {}, 'person-2');
  assert.equal(stranger.statusCode, 404, stranger.body);
  assert.equal(f.arcPort.state.prepared.length, 0);
  for (const [method, path] of [
    ['GET', 'ratings/status'],
    ['POST', 'ratings/lookup'],
    ['GET', 'ratings'],
    ['POST', 'ratings'],
  ] as const) {
    const res = await f.app.inject({
      method,
      url: f.url(ARC_AGENT, path),
      ...(method === 'POST' ? { payload: {} } : {}),
    });
    // Ratings follow the agent's chain now: whatever the answer, it isn't this refusal.
    assert.notEqual(res.json().code, 'not_on_arc_yet', path);
  }
});

test('Arc mainnet stays refused while Arc is off (CITY_ARC unset): withdrawals, payments, history', async (t) => {
  const pg = await setup(t, {
    env: { ...ARC_OFF, CITY_ARC: '', CITY_ARC_CHAIN_ID: String(ARC_MAINNET) },
  });
  await pg.pg.query(`UPDATE base_wallets SET chain_id = $1 WHERE wallet_id = 'w-arc'`, [
    ARC_MAINNET,
  ]);
  for (const [method, path] of [
    ['POST', 'withdrawals'],
    ['POST', 'payments'],
    ['GET', 'agent-payments'],
  ] as const) {
    const res = await pg.app.inject({
      method,
      url: pg.url(ARC_AGENT, path),
      ...(method === 'POST' ? { payload: {} } : {}),
    });
    // Arc off: the agent's chain isn't served at all, as for any Arc agent then.
    assert.equal(res.statusCode, 404, path);
    assert.equal(res.json().error, 'Not found.', path);
  }
  assert.deepEqual(pg.asked.arcBalances, []);
  assert.equal(pg.arcPort.state.prepared.length, 0);
  // And no Arc lookup while Arc is off.
  const lookup = await pg.app.inject({ url: `/api/base/pay/recipient?q=501&chain=${ARC_MAINNET}` });
  assert.equal(lookup.statusCode, 400, lookup.body);
});

test('screening on Arc: both addresses, before anything is prepared and again at the signature', async (t) => {
  const f = await setup(t);
  const req = await created(f, ARC_AGENT);
  assert.deepEqual(
    f.asked.arcProviders.every((id) => id === ARC_TESTNET),
    true,
  );
  assert.equal(f.screening.asked[0].chainId, ARC_TESTNET);
  assert.deepEqual(
    [...f.screening.asked[0].addresses].sort(),
    [DEST.toLowerCase(), f.addresses[ARC_AGENT].toLowerCase()].sort(),
  );
  // A new decision at the signature, listed by then: not signed, not sent.
  await f.pg.query('DELETE FROM protocol_screening_decisions');
  f.screening.listed.add(DEST.toLowerCase());
  const signed = await f.post(ARC_AGENT, `withdrawals/${req.withdrawalId}/signature`, {
    signature: await sign(f, req.userOpHash),
  });
  assert.equal(signed.statusCode, 409, signed.body);
  assert.equal(signed.json().code, 'screening_blocked');
  assert.equal(f.arcPort.state.submitted.length, 0);
  assert.equal(await rowState(f, req.withdrawalId), 'awaiting_signature');
  // Listed from the start: nothing prepared.
  const prepared = f.arcPort.state.prepared.length;
  const blocked = await f.withdraw(ARC_AGENT, { amount: '200000' });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(f.arcPort.state.prepared.length, prepared);
});

test('screening fails closed on Arc: an outage, no provider, and the emergency off do not clear', async (t) => {
  const down = await setup(t);
  down.screening.control.fail = true;
  const res = await down.withdraw(ARC_AGENT);
  assert.equal(res.statusCode, 503, res.body);
  assert.equal(res.json().code, 'screening_unavailable');
  assert.equal(down.arcPort.state.prepared.length, 0);
  // Ops hear it once in the window, however many refusals; the line names no address.
  await down.withdraw(ARC_AGENT);
  const outages = down.logs.filter((line) => line.includes('withdrawal.screening_unavailable'));
  assert.equal(outages.length, 1, down.logs.join('\n'));
  assert.equal(JSON.parse(outages[0]!).level, 'ALERT');
  assert.doesNotMatch(outages[0]!, /0x[0-9a-fA-F]{40}/);
  // And the ops webhook's alert, which names withdrawals and the chain.
  const heard = down.logs.filter((line) => line.includes('"feed_pay_alert"'));
  assert.equal(heard.length, 1, down.logs.join('\n'));
  assert.match(heard[0]!, new RegExp(`withdrawals_chain_${ARC_TESTNET}:`));

  const none = await setup(t, { noProvider: true });
  const refused = await none.withdraw(ARC_AGENT);
  assert.equal(refused.statusCode, 503, refused.body);
  assert.equal(refused.json().code, 'screening_unavailable');
  assert.equal(none.arcPort.state.prepared.length, 0);

  const off = await setup(t, { env: { ...ARC_ON, CITY_PROTOCOL_SCREENING: '0' } });
  off.screening.listed.add(DEST.toLowerCase());
  const still = await off.withdraw(ARC_AGENT);
  assert.equal(still.statusCode, 409, still.body);
  assert.equal(still.json().code, 'screening_blocked');
});

test("sanctionsOracleFor on Arc asks Base's oracle through the given client, and refuses if it can't", async () => {
  const reads: Array<{ address: string }> = [];
  const provider = sanctionsOracleFor(
    {},
    ARC_TESTNET,
    async () =>
      ({
        readContract: async (call: { address: string }) => {
          reads.push(call);
          return false;
        },
      }) as never,
  );
  assert.ok(provider);
  const answer = await provider.check({
    chainId: ARC_TESTNET,
    addresses: [DEST.toLowerCase()],
    signal: new AbortController().signal,
  });
  assert.equal(answer.listed[DEST.toLowerCase()], false);
  assert.equal(reads[0].address, PROTOCOL_BASE_MAINNET.sanctionsOracle);
  const broken = sanctionsOracleFor({}, ARC_TESTNET, async () => {
    throw new Error('Base is not configured.');
  });
  await assert.rejects(
    broken!.check({
      chainId: ARC_TESTNET,
      addresses: [DEST.toLowerCase()],
      signal: new AbortController().signal,
    }),
  );
});

const insertLapsed = (f: Fixture, id: string, walletId: string, chainId: number, from: string) =>
  f.pg.query(
    `INSERT INTO base_wallet_withdrawals (withdrawal_id, wallet_id, owner_account_id, chain_id,
       token, amount_raw, destination, idempotency_key, request_hash, state, nonce, user_operation,
       user_op_hash, expires_at, created_at, updated_at, sponsored, max_fee_wei)
     SELECT $1, $2, owner_account_id, $3, token, amount_raw, destination, $1, request_hash,
       'awaiting_signature', nonce, user_operation, $4, 1, 1, 1, sponsored, max_fee_wei
     FROM base_wallet_withdrawals WHERE withdrawal_id = $5`,
    [id, walletId, chainId, key(chainId), from],
  );

test('the sweep runs each chain with its own service, and only its own rows', async (t) => {
  const f = await setup(t, { cronSecret: CRON });
  const onBase = await created(f, BASE_AGENT);
  const onArc = await created(f, ARC_AGENT);
  for (const [agent, req] of [
    [BASE_AGENT, onBase],
    [ARC_AGENT, onArc],
  ] as const) {
    const signed = await f.post(agent, `withdrawals/${req.withdrawalId}/signature`, {
      signature: await sign(f, req.userOpHash),
    });
    assert.equal(signed.statusCode, 202, signed.body);
  }
  f.basePort.finish(5);
  f.arcPort.finish(6);
  const before = { base: f.basePort.state.refreshes, arc: f.arcPort.state.refreshes };
  const res = await f.app.inject({
    url: WALLET_SWEEP_PATH,
    headers: { authorization: `Bearer ${CRON}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { expired: 0, advanced: 2 });
  assert.equal(await rowState(f, onBase.withdrawalId), 'final');
  assert.equal(await rowState(f, onArc.withdrawalId), 'final');
  assert.ok(f.basePort.state.refreshes > before.base);
  assert.ok(f.arcPort.state.refreshes > before.arc);
  const tx = await f.pg.query<{ withdrawal_id: string; tx_hash: string }>(
    'SELECT withdrawal_id, tx_hash FROM base_wallet_withdrawals WHERE withdrawal_id = ANY($1)',
    [[onBase.withdrawalId, onArc.withdrawalId]],
  );
  const byId = Object.fromEntries(tx.rows.map((row) => [row.withdrawal_id, row.tx_hash]));
  assert.equal(byId[onBase.withdrawalId], key(5));
  assert.equal(byId[onArc.withdrawalId], key(6));
});

test("the sweep doesn't touch or wait for Base if Arc's runtime can't be built", async (t) => {
  const f = await setup(t, { cronSecret: CRON, arcRuntimeBroken: true });
  const onBase = await created(f, BASE_AGENT);
  const signed = await f.post(BASE_AGENT, `withdrawals/${onBase.withdrawalId}/signature`, {
    signature: await sign(f, onBase.userOpHash),
  });
  assert.equal(signed.statusCode, 202, signed.body);
  f.basePort.finish(5);
  // An Arc row signed before its runtime broke: left as it is, and no Base port ever sees it.
  await f.pg.query(
    `INSERT INTO base_wallet_withdrawals (withdrawal_id, wallet_id, owner_account_id, chain_id,
       token, amount_raw, destination, idempotency_key, request_hash, state, nonce, user_operation,
       user_op_hash, expires_at, owner_signature, chain_op_key, signed_at, created_at, updated_at,
       sponsored, max_fee_wei)
     SELECT '33333333-3333-4333-8333-333333333333', 'w-arc', owner_account_id, $1, token, amount_raw,
       destination, '33333333-3333-4333-8333-333333333334', request_hash, 'submitted', nonce,
       user_operation, $2, 1, owner_signature, 'base-wallet:withdraw:arc-row', 1, 1, 1, sponsored,
       max_fee_wei
     FROM base_wallet_withdrawals WHERE withdrawal_id = $3`,
    [ARC_TESTNET, key(8), onBase.withdrawalId],
  );
  const keysBefore = [...f.basePort.state.stored.keys()];
  const res = await f.app.inject({
    url: WALLET_SWEEP_PATH,
    headers: { authorization: `Bearer ${CRON}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await rowState(f, onBase.withdrawalId), 'final');
  assert.equal(await rowState(f, '33333333-3333-4333-8333-333333333333'), 'submitted');
  assert.deepEqual([...f.basePort.state.stored.keys()], keysBefore);
  assert.ok(f.asked.runtimes.includes(ARC_TESTNET));
});

test("Base's sweep finishes while Arc's chain doesn't answer", async (t) => {
  const f = await setup(t, { cronSecret: CRON });
  const onBase = await created(f, BASE_AGENT);
  const onArc = await created(f, ARC_AGENT);
  for (const [agent, req] of [
    [BASE_AGENT, onBase],
    [ARC_AGENT, onArc],
  ] as const)
    await f.post(agent, `withdrawals/${req.withdrawalId}/signature`, {
      signature: await sign(f, req.userOpHash),
    });
  f.basePort.finish(5);
  let release = () => {};
  f.arcPort.state.stall = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = f.app.inject({
    url: WALLET_SWEEP_PATH,
    headers: { authorization: `Bearer ${CRON}` },
  });
  // Base's row goes final while Arc's read is still waiting.
  for (let i = 0; i < 200 && (await rowState(f, onBase.withdrawalId)) !== 'final'; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await rowState(f, onBase.withdrawalId), 'final');
  assert.equal(await rowState(f, onArc.withdrawalId), 'submitted');
  release();
  assert.equal((await running).statusCode, 200);
});

test('expiring unsigned operations keeps to the chain of each sweep', async (t) => {
  const f = await setup(t, { cronSecret: CRON });
  const first = await created(f, BASE_AGENT);
  await insertLapsed(
    f,
    '44444444-4444-4444-8444-444444444444',
    'w-arc',
    ARC_TESTNET,
    first.withdrawalId,
  );
  const res = await f.app.inject({
    url: WALLET_SWEEP_PATH,
    headers: { authorization: `Bearer ${CRON}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { expired: 1, advanced: 0 });
  assert.equal(await rowState(f, '44444444-4444-4444-8444-444444444444'), 'expired');
  // Base's own unsigned one, still in its time, is untouched.
  assert.equal(await rowState(f, first.withdrawalId), 'awaiting_signature');
});

test("REPLAYABLE_NONCE_KEY is the wallet's own constant: no owner operation can name it, on any chain", () => {
  assert.equal(REPLAYABLE_NONCE_KEY, 8453n);
  assert.equal(usableLaneKey(8453n), false);
  assert.notEqual(OWNER_NONCE_KEY, 8453n);
});

test('an agent with a row on both chains follows its live Arc identity, its own row each time', async (t) => {
  const f = await setup(t);
  // A failed Arc registration leaves it on Base, whatever row it has.
  await f.pg.query(`UPDATE base_wallets SET agent_id = $1 WHERE wallet_id = 'w-arc-peer'`, [
    BASE_AGENT,
  ]);
  await f.pg.query(
    `UPDATE base_wallets SET owner_account_id = 'person-1', operator_id = 'person-1',
       owner_address = $1 WHERE wallet_id = 'w-arc-peer'`,
    [f.owner.address],
  );
  const req = await created(f, BASE_AGENT);
  assert.equal(req.chainId, WALLET_CHAIN_ID);
  assert.equal(f.arcPort.state.prepared.length, 0);
});

/** Registers `agent` as a confirmed agent on a chain: what the records and the reader will say. */
async function register(
  f: Fixture,
  input: { agent: string; baseId: string; short: string; chainId: number; registry: Address },
) {
  const workspace = 'person-2';
  await f.pg.query(`UPDATE agent_manifests SET manifest = $1 WHERE agent_id = $2`, [
    JSON.stringify({ metadata: { displayName: input.short } }),
    input.agent,
  ]);
  await f.pg.query('INSERT INTO base_short_ids VALUES ($1, $2, 1)', [input.short, input.agent]);
  await f.pg.query(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
       erc8004_agent_id, agent_card_uri, owner_of_identity, state, op_id, updated_at,
       register_op_id, mint_op_id, provisional_agent_id, mint_seen_at, mint_finality,
       transfer_op_id, handover_id, handover_finality, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', $8, 1, $9, $9, $5, 1, 'final', $8, $5, 'final',
       1)`,
    [
      input.agent,
      input.chainId,
      workspace,
      input.registry,
      input.baseId,
      `${AGENT_URI_ORIGIN}/a/${input.short}`,
      f.addresses[input.agent],
      `identity:transfer:${input.chainId}:${input.agent}~${input.baseId}`,
      `identity:register:${input.chainId}:${input.agent}`,
    ],
  );
  (input.chainId === WALLET_CHAIN_ID ? f.owners.base : f.owners.arc).set(
    input.baseId,
    f.addresses[input.agent],
  );
}

const registerBoth = async (f: Fixture) => {
  await register(f, {
    agent: BASE_PEER,
    baseId: '501',
    short: 'Basepr',
    chainId: WALLET_CHAIN_ID,
    registry: BASE_NET.contracts.identityRegistry as Address,
  });
  await register(f, {
    agent: ARC_PEER,
    baseId: '777',
    short: 'Arcpee',
    chainId: ARC_TESTNET,
    registry: ARC_NET.contracts.identityRegistry as Address,
  });
};

const pay = (f: Fixture, agent: string, lookupId: string, id = 1) =>
  f.post(agent, 'payments', {
    idempotencyKey: `55555555-5555-4555-8555-${String(id).padStart(12, '0')}`,
    to: { lookupId },
    amount: '100000',
  });

test('a payment on Arc is an Arc withdrawal to an Arc agent', async (t) => {
  const f = await setup(t);
  await registerBoth(f);
  const lookup = await f.app.inject({
    url: `/api/base/pay/recipient?q=777&chain=${ARC_TESTNET}`,
  });
  assert.equal(lookup.statusCode, 200, lookup.body);
  assert.equal(lookup.json().chainId, ARC_TESTNET);
  assert.equal(lookup.json().registry, ARC_NET.contracts.identityRegistry);
  const res = await pay(f, ARC_AGENT, lookup.json().lookupId);
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.equal(body.chainId, ARC_TESTNET);
  assert.equal(body.summary.fee.token, 'USDC');
  assert.equal(body.payment.recipient.chainId, ARC_TESTNET);
  assert.equal(f.arcPort.state.prepared[0].sponsorFlow, 'ownerPay');
  assert.equal(f.arcPort.state.prepared[0].calls[0].target, ARC_USDC);
  assert.equal(f.basePort.state.prepared.length, 0);
  assert.ok(f.screening.asked.length > 0);
  const stored = await f.pg.query<{ chain_id: number }>(
    'SELECT chain_id FROM base_wallet_payments WHERE withdrawal_id = $1',
    [body.withdrawalId],
  );
  assert.equal(stored.rows[0].chain_id, ARC_TESTNET);

  const signed = await f.post(ARC_AGENT, `withdrawals/${body.withdrawalId}/signature`, {
    signature: await sign(f, body.userOpHash),
  });
  assert.equal(signed.statusCode, 202, signed.body);
  f.arcPort.finish(11);
  const read = await f.app.inject({ url: f.url(ARC_AGENT, `withdrawals/${body.withdrawalId}`) });
  assert.equal(read.json().state, 'final');
  // The recipient reads it per chain, with Arc's explorer; Base's list doesn't carry it.
  const asPeer = { 'x-test-person': 'person-2' };
  const incoming = await f.app.inject({
    url: `/api/base/pay/incoming?chain=${ARC_TESTNET}`,
    headers: asPeer,
  });
  assert.equal(incoming.statusCode, 200, incoming.body);
  assert.equal(incoming.json().payments.length, 1);
  assert.equal(
    incoming.json().payments[0].explorerUrl,
    `${ARC_NETWORKS[ARC_TESTNET].explorerUrl}/tx/${key(11)}`,
  );
  const onBase = await f.app.inject({ url: '/api/base/pay/incoming', headers: asPeer });
  assert.deepEqual(onBase.json().payments, []);
});

test('nothing pays across chains: a lookup of one chain is unknown on the other, both ways', async (t) => {
  const f = await setup(t);
  await registerBoth(f);
  const onBase = await f.app.inject({ url: '/api/base/pay/recipient?q=501' });
  assert.equal(onBase.statusCode, 200, onBase.body);
  assert.equal(onBase.json().chainId, WALLET_CHAIN_ID);
  const crossToArc = await pay(f, ARC_AGENT, onBase.json().lookupId, 1);
  assert.equal(crossToArc.statusCode, 409, crossToArc.body);
  assert.equal(crossToArc.json().code, 'recipient_expired');
  const onArc = await f.app.inject({ url: `/api/base/pay/recipient?q=777&chain=${ARC_TESTNET}` });
  const crossToBase = await pay(f, BASE_AGENT, onArc.json().lookupId, 2);
  assert.equal(crossToBase.statusCode, 409, crossToBase.body);
  assert.equal(crossToBase.json().code, 'recipient_expired');
  assert.equal(f.arcPort.state.prepared.length, 0);
  assert.equal(f.basePort.state.prepared.length, 0);
  // An agent of the other chain isn't found at all, and a plain address isn't paid on Arc.
  const notThere = await f.app.inject({
    url: `/api/base/pay/recipient?q=501&chain=${ARC_TESTNET}`,
  });
  assert.equal(notThere.statusCode, 404, notThere.body);
  assert.match(notThere.json().error, /Arc/);
  const anyAddress = await f.post(ARC_AGENT, 'payments', {
    idempotencyKey: '55555555-5555-4555-8555-000000000003',
    to: { address: DEST },
    amount: '100000',
  });
  assert.equal(anyAddress.statusCode, 422, anyAddress.body);
  // Base's lookup with another chain in the query is refused, not answered as Base.
  const unknown = await f.app.inject({ url: '/api/base/pay/recipient?q=501&chain=999' });
  assert.equal(unknown.statusCode, 400, unknown.body);
});

test("Arc's payment history is its own wallet's, and its owner's only", async (t) => {
  const f = await setup(t);
  const empty = await f.app.inject({ url: f.url(ARC_AGENT, 'agent-payments') });
  assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(empty.json(), { payments: [] });
  const stranger = await f.app.inject({
    url: f.url(ARC_AGENT, 'agent-payments'),
    headers: { 'x-test-person': 'person-2' },
  });
  assert.equal(stranger.statusCode, 404, stranger.body);
  const base = await f.app.inject({ url: f.url(BASE_AGENT, 'agent-payments') });
  assert.equal(base.statusCode, 200, base.body);
});

test("Arc's runtime builds its own owner operations on its fee cap and its paymaster only", () => {
  const db = {} as never;
  const env = {
    ...ARC_ON_ENV,
    CITY_ARC_RPC_URL: 'https://arc.invalid/rpc',
    CITY_BASE_SPENDER_KEK: `v1:${Buffer.alloc(32, 7).toString('base64')}`,
    CITY_ARC_MAX_FEE_PER_GAS_WEI: '100000000000',
    CITY_ARC_PAYMASTER: ARC_PAYMASTER,
    CITY_ARC_OWN_PAYMASTER: 'on',
    CITY_ARC_WALLET_FEE_CAP_WEI: '40000000000000000',
  };
  const runtime = createChainRuntime({ db, env, chainId: ARC_TESTNET });
  // Base's slot stays empty: nothing written for Base's wallet network picks Arc's port up.
  assert.equal(runtime.ownerOperations, undefined);
  const port = runtime.arcOwnerOperations!();
  assert.equal(port.chainId, ARC_TESTNET);
  assert.equal(port.entryPoint, ARC_NET.contracts.entryPointV06);
  assert.equal(runtime.arcOwnerOperations!(), port);
  assert.equal(port.sponsorshipValid?.('0x', 1), false);
  // A malformed cap is no cap: nothing is built.
  const broken = createChainRuntime({
    db,
    env: { ...env, CITY_ARC_WALLET_FEE_CAP_WEI: 'lots' },
    chainId: ARC_TESTNET,
  });
  assert.throws(() => broken.arcOwnerOperations!(), /CITY_ARC_WALLET_FEE_CAP_WEI/);
});

test("Arc's only hold is its USDC: native gas is held nowhere", async (t) => {
  const f = await setup(t);
  const req = await created(f, ARC_AGENT);
  const holds = await f.pg.query<{ token: string }>(
    'SELECT token FROM base_wallet_reservations WHERE holder_ref = $1',
    [req.withdrawalId],
  );
  assert.deepEqual(
    holds.rows.map((row) => row.token.toLowerCase()),
    [ARC_USDC.toLowerCase()],
  );
});

test('Arc: the first-buy sponsor is an allowed destination even though it is one of our keys (owner decision 2 Nov 2026)', async (t) => {
  const f = await setup(t, {
    env: { ...ARC_ON, CITY_ARC_PAYMASTER: ARC_PAYMASTER, CITY_ARC_FEE_ROUTER3: ARC_ROUTER },
  });
  const res = await f.withdraw(ARC_AGENT, { to: SFP_SPONSOR_BASE_MAINNET.toLowerCase() });
  assert.notEqual(res.json().code, 'destination_not_allowed', res.body);
});
