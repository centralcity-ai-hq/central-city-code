import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import { encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arcChainIdsMigrations } from '../server/base/arc-chain-ids-schema.js';
import { agentWalletRecipe, deriveAddressLocal } from '../server/base/chain/derive.js';
import {
  OwnerRevokeError,
  ownerRevokePortFromEnv,
  type OwnerRevokePort,
} from '../server/base/chain/owner-revoke.js';
import type { PermissionReader } from '../server/base/chain/permission-reader.js';
import { ownerTypedData } from '../server/base/chain/permissions.js';
import { ChainRuntimeError } from '../server/base/chain/runtime.js';
import type { Bundler, StoredOperation } from '../server/base/chain/submit.js';
import type { ChainRuntime } from '../server/base/identity/routes.js';
import {
  BASE_AGENT_PAY_CONSENT_RECIPIENTS_SQL,
  BASE_AGENT_PAY_CONSENTS_SQL,
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_WALLET_LIMITS_SQL,
  BASE_WALLET_VAULT_SQL,
} from '../server/base/schema.js';
import {
  AgentPayConsentError,
  assertAgentPayConsent,
} from '../server/base/wallet/agent-pay-consent.js';
import { agentPayConsentSignatureMigration } from '../server/base/wallet/agent-pay-consent-schema.js';
import {
  arcPermissionReader,
  followsAgentChain,
  registerBaseWalletRoutes,
  WALLET_CHAIN_ID,
} from '../server/base/wallet/routes.js';
import { accountIndexFor } from '../server/base/wallet/service.js';
import type { Database } from '../server/database.js';
import { FEED_PAY_FEE_SQL } from '../server/feed/pay/fee-schema.js';
import { FEED_PAY_SQL } from '../server/feed/pay/schema.js';
import { agentPayConsentTypedData } from '../shared/base/agent-pay-consent.js';
import {
  allowedToken,
  BASE_NETWORKS,
  NATIVE_ETH,
  type Address,
  type BaseChainId,
} from '../shared/base/chains.js';
import {
  checkRevokeOperation,
  permissionFromJson,
  revokeCall,
  smartWalletMessageTypedData,
  spendPermissionHash,
  type SpendPermissionJson,
} from '../shared/base/spend-limits.js';
import {
  ARC_MAINNET,
  ARC_TESTNET,
  ARC_USDC,
  chainNetwork,
  type ChainId,
  type ChainNetwork,
} from '../shared/chains.js';

/*
 * Spending limits and the agent-pay consent per chain: an Arc agent's limit is Arc's in every part
 * (manager, USDC, chain id, reader, operations), a signature for the other chain never counts, and
 * Base is what it was. Everything chain-side is a fake here: no RPC, nothing sent.
 */

const BASE_NET = BASE_NETWORKS[WALLET_CHAIN_ID as BaseChainId];
const BASE_SPM = BASE_NET.contracts.spendPermissionManager;
const BASE_AGENT = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const ARC_AGENT = '1a2b3c4d-5b4a-4321-8fed-cba987654321';
const SPENDER = getAddress(`0x${'3'.repeat(40)}`);
const ARC_SPM = BASE_NET.contracts.spendPermissionManager;
const ARC_PAYMASTER = getAddress(`0x${'a1'.repeat(20)}`);
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const CAP = { capRaw: '20000000', period: 'day' };

const ARC_OFF = { CITY_BASE_WALLET: '1', CITY_FEED_PAY: '0' };
const ARC_ON = {
  ...ARC_OFF,
  CITY_ARC: '1',
  CITY_ARC_CHAIN_ID: String(ARC_TESTNET),
};
/** The hardest case, and what mainnet will be: Arc's manager at Base's very address. */
const ARC_SAME_MANAGER = { ...ARC_ON, CITY_ARC_SPEND_PERMISSION_MANAGER: BASE_SPM };

const networkOf = (env: Record<string, string>) => chainNetwork(ARC_TESTNET, env) as ChainNetwork;

function fakeReader() {
  const state = { reads: 0, revoked: new Set<string>() };
  const reader: PermissionReader = {
    async read(permissions) {
      state.reads += 1;
      return {
        blockNumber: 77n,
        blockTimestamp: NOW / 1000,
        permissions: permissions.map((p) => ({
          approved: false,
          revoked: state.revoked.has(p.salt.toString(10)),
          phase: 'active' as const,
          current: { start: p.start, end: p.start + p.period, spend: 0n },
        })),
      };
    },
    deployed: async () => false,
  };
  return { state, reader };
}

const executeAbi = parseAbi(['function execute(address target, uint256 value, bytes data)']);

function fakeOperations(network: Pick<ChainNetwork, 'chainId' | 'contracts'>) {
  const ops = {
    built: 0,
    prepared: [] as Array<Parameters<OwnerRevokePort['prepare']>[0]>,
    submitted: [] as Array<Parameters<OwnerRevokePort['submit']>[0]>,
  };
  const entryPoint = network.contracts.entryPointV06;
  const hashOf = (chainId: number, operation: UserOperation<'0.6'>) =>
    getUserOperationHash({
      chainId,
      entryPointAddress: entryPoint,
      entryPointVersion: '0.6',
      userOperation: operation,
    });
  const port: OwnerRevokePort = {
    chainId: network.chainId,
    entryPoint,
    async prepare(input) {
      ops.prepared.push(input);
      const [call] = input.calls;
      const operation: UserOperation<'0.6'> = {
        sender: input.wallet,
        nonce: 1n,
        initCode: '0x',
        callData: encodeFunctionData({
          abi: executeAbi,
          functionName: 'execute',
          args: [call.target, call.value, call.data],
        }),
        callGasLimit: 100_000n,
        verificationGasLimit: 200_000n,
        preVerificationGas: 50_000n,
        maxFeePerGas: 25_000_000_000n,
        maxPriorityFeePerGas: 1_000n,
        paymasterAndData: `0x${'7a'.repeat(20)}${'00'.repeat(109)}${'ab'.repeat(65)}`,
        signature: '0x',
      };
      return {
        operation,
        userOpHash: hashOf(network.chainId, operation),
        maxCostWei: 1n,
        deployed: true,
      };
    },
    async submit(input) {
      ops.submitted.push(input);
      return {
        idempotencyKey: input.idempotencyKey,
        intentHash: input.intentHash,
        chainId: network.chainId,
        kind: 'userop',
        sender: input.wallet,
        signer: input.owner,
        nonce: '1',
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
      } as StoredOperation;
    },
    refresh: async () => null,
  };
  return { ops, port, hashOf };
}

async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  env: Record<string, string> = ARC_ON,
) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('person-1','owner'), ('person-2','owner');
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);
    INSERT INTO agent_manifests VALUES ('${BASE_AGENT}', 'person-1', 1, '{}'),
      ('${ARC_AGENT}', 'person-1', 1, '{}');`);
  for (const sql of [
    BASE_MIGRATION_SQL,
    BASE_PAYMENTS_MIGRATION_SQL,
    BASE_WALLET_VAULT_SQL,
    BASE_WALLET_LIMITS_SQL,
    FEED_PAY_SQL,
    FEED_PAY_FEE_SQL,
    BASE_AGENT_PAY_CONSENTS_SQL,
    BASE_AGENT_PAY_CONSENT_RECIPIENTS_SQL,
    agentPayConsentSignatureMigration.sql,
  ])
    await pg.exec(sql);
  // The real CHECK migrations of the two tables that have one here; base_spend_permissions and
  // base_chain_ops name no chains.
  for (const table of ['base_wallets ', 'base_agent_pay_consents '])
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
  await pg.query(
    `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key, kdf_params,
       cipher_params, version, backup_confirmed_at, created_at, updated_at)
     VALUES ('person-1', $1, decode(repeat('ab', 48), 'hex'), '{}', '{}', 1, 1, 1, 1)`,
    [owner.address],
  );
  const addresses: Record<string, Address> = {};
  const wallet = async (id: string, agent: string, chainId: number, network: ChainNetwork) => {
    const recipe = agentWalletRecipe(network, owner.address, accountIndexFor(agent));
    addresses[agent] = deriveAddressLocal(recipe);
    await pg.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at,
         owner_account_id)
       VALUES ($1,$2,'person-1',$3,$4,$5,$6,'v1:k',$7,'derived',0,0,'person-1')`,
      [
        id,
        agent,
        chainId,
        addresses[agent],
        owner.address,
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
  // With Arc off its row still exists: made while Arc was on.
  const arc = networkOf(env.CITY_ARC === '1' ? env : ARC_ON);
  await wallet('w-base', BASE_AGENT, WALLET_CHAIN_ID, BASE_NET);
  await wallet('w-arc', ARC_AGENT, ARC_TESTNET, arc);

  const baseReads = fakeReader();
  const arcReads = fakeReader();
  const baseOps = fakeOperations(BASE_NET);
  const arcOps = fakeOperations(arc);
  const asked = { arcReaders: [] as number[], arcOperations: [] as number[] };
  const app = Fastify();
  t.after(() => app.close());
  registerBaseWalletRoutes(app, {
    db,
    env,
    log: () => {},
    currentPerson: async (request) => ({
      id: (request.headers['x-test-person'] as string | undefined) ?? 'person-1',
    }),
    currentWorkspace: async (request) => ({
      id: (request.headers['x-test-person'] as string | undefined) ?? 'person-1',
    }),
    runtime: async () => ({}) as ChainRuntime,
    permissions: baseReads.reader,
    limitOperations: async () => baseOps.port,
    arcPermissions: (chainId) => {
      asked.arcReaders.push(chainId);
      return arcReads.reader;
    },
    arcLimitOperations: async (chainId: ChainId) => {
      asked.arcOperations.push(chainId);
      return arcOps.port;
    },
    now: () => NOW,
  });
  const url = (agent: string, path = 'limits') => `/api/base/agents/${agent}/wallet/${path}`;
  const post = (agent: string, path: string, body: unknown, person = 'person-1') =>
    app.inject({
      method: 'POST',
      url: url(agent, path),
      headers: { 'x-test-person': person },
      payload: body as object,
    });
  const prepare = async (agent: string) => {
    const res = await post(agent, 'limits/prepare', CAP);
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  return {
    pg,
    db,
    queries,
    app,
    owner,
    addresses,
    arc,
    baseReads,
    arcReads,
    baseOps,
    arcOps,
    asked,
    url,
    post,
    prepare,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

const permissionOf = (prepared: { permission: SpendPermissionJson }) => {
  const permission = permissionFromJson(prepared.permission);
  assert.ok(permission);
  return permission;
};

/** Stores a prepared limit with the owner's signature over exactly what prepare returned. */
async function storeLimit(f: Fixture, agent: string) {
  const prepared = await f.prepare(agent);
  const res = await f.post(agent, 'limits', {
    permission: prepared.permission,
    capRaw: prepared.capRaw,
    period: prepared.period,
    signature: await f.owner.signTypedData(prepared.typedData),
  });
  assert.equal(res.statusCode, 201, res.body);
  return { prepared, created: res.json() };
}

test('Arc off: nothing new is asked, an Arc row is no limit wallet, and Arc is never touched', async (t) => {
  const f = await setup(t, ARC_OFF);
  f.queries.length = 0;
  const prepared = await f.prepare(BASE_AGENT);
  assert.equal(prepared.chainId, WALLET_CHAIN_ID);
  assert.equal(prepared.permission.token, BASE_NET.tokens.USDC.address);
  assert.equal(
    prepared.permissionHash,
    spendPermissionHash(WALLET_CHAIN_ID as BaseChainId, permissionOf(prepared)),
  );
  assert.deepEqual(
    prepared.typedData,
    JSON.parse(
      JSON.stringify(
        ownerTypedData(WALLET_CHAIN_ID, prepared.permission.account, prepared.permissionHash),
      ),
    ),
  );
  assert.equal(f.queries.filter((sql) => /chain_id IN \(\$2, \$3\)/.test(sql)).length, 0);
  assert.equal((await f.app.inject({ url: f.url(ARC_AGENT) })).statusCode, 404);
  const consent = await f.app.inject({ url: f.url(ARC_AGENT, 'agent-pay') });
  assert.equal(consent.statusCode, 404);
  assert.equal(f.queries.filter((sql) => /chain_id IN \(\$2, \$3\)/.test(sql)).length, 0);
  assert.deepEqual(f.asked, { arcReaders: [], arcOperations: [] });
});

test('a Base chain id and its network object name the same limit', async (t) => {
  const f = await setup(t, ARC_OFF);
  const permission = permissionOf(await f.prepare(BASE_AGENT));
  const chainId = WALLET_CHAIN_ID as BaseChainId;
  assert.equal(spendPermissionHash(chainId, permission), spendPermissionHash(BASE_NET, permission));
  assert.deepEqual(revokeCall(chainId, permission), revokeCall(BASE_NET, permission));
});

test("an Arc agent's limit is prepared with Arc's manager, USDC and chain id, and read through Arc", async (t) => {
  const f = await setup(t);
  const prepared = await f.prepare(ARC_AGENT);
  assert.equal(prepared.chainId, ARC_TESTNET);
  assert.equal(prepared.permission.token, ARC_USDC);
  assert.equal(prepared.permission.account, f.addresses[ARC_AGENT]);
  // 6 decimals: the same display as Base's, not 18.
  assert.equal(prepared.capDisplay, '20');
  assert.equal(prepared.allowanceDisplay, '10');
  const permission = permissionOf(prepared);
  assert.equal(prepared.permissionHash, spendPermissionHash(f.arc, permission));
  assert.notEqual(prepared.permissionHash, spendPermissionHash(BASE_NET, permission));
  assert.equal(prepared.typedData.domain.chainId, ARC_TESTNET);
  assert.equal(prepared.typedData.domain.verifyingContract, f.addresses[ARC_AGENT]);
  assert.equal(prepared.typedData.message.hash, prepared.permissionHash);

  const res = await f.post(ARC_AGENT, 'limits', {
    permission: prepared.permission,
    capRaw: prepared.capRaw,
    period: prepared.period,
    signature: await f.owner.signTypedData(prepared.typedData),
  });
  assert.equal(res.statusCode, 201, res.body);
  const { rows } = await f.pg.query<{ chain_id: number; token: string; wallet_id: string }>(
    'SELECT chain_id, token, wallet_id FROM base_spend_permissions',
  );
  assert.deepEqual(rows, [
    { chain_id: ARC_TESTNET, token: ARC_USDC.toLowerCase(), wallet_id: 'w-arc' },
  ]);
  const audit = await f.pg.query<{ detail: { chainId: number } }>(
    `SELECT detail FROM base_audit_events WHERE kind = 'limit_signed'`,
  );
  assert.equal(audit.rows[0].detail.chainId, ARC_TESTNET);

  const before = f.baseReads.state.reads;
  const view = (await f.app.inject({ url: f.url(ARC_AGENT) })).json();
  assert.equal(view.chainId, ARC_TESTNET);
  assert.equal(view.network, 'Arc Testnet');
  assert.equal(view.testnet, true);
  assert.equal(view.stale, false);
  assert.equal(view.limits[0].capDisplay, '20');
  assert.equal(view.limits[0].onchain.leftRaw, '10000000');
  assert.ok(f.arcReads.state.reads > 0);
  assert.equal(f.baseReads.state.reads, before);
  assert.deepEqual(f.baseOps.ops.prepared, []);
  // One reader per chain, built once.
  assert.deepEqual(f.asked.arcReaders, [ARC_TESTNET]);
});

test('Arc: no reader yet is stale, never zeros and never Base; it is asked again', async (t) => {
  const f = await setup(t);
  const { created } = await storeLimit(f, ARC_AGENT);
  assert.ok(created.permissionId);
  const pgRows = await f.pg.query('SELECT 1 FROM base_spend_permissions');
  assert.equal(pgRows.rows.length, 1);
  const app = Fastify();
  t.after(() => app.close());
  const asked: number[] = [];
  const base = fakeReader();
  registerBaseWalletRoutes(app, {
    db: f.db,
    env: ARC_ON,
    log: () => {},
    currentPerson: async () => ({ id: 'person-1' }),
    currentWorkspace: async () => ({ id: 'person-1' }),
    runtime: async () => ({}) as ChainRuntime,
    permissions: base.reader,
    arcPermissions: (chainId) => {
      asked.push(chainId);
      return undefined;
    },
    now: () => NOW,
  });
  for (let i = 0; i < 2; i += 1) {
    const view = (await app.inject({ url: f.url(ARC_AGENT) })).json();
    assert.equal(view.stale, true);
    assert.equal(view.limits[0].onchain, null);
  }
  assert.deepEqual(asked, [ARC_TESTNET, ARC_TESTNET]);
  assert.equal(base.state.reads, 0);
  // No Arc operations configured: 503 naming Arc, nothing from Base.
  const revoke = await app.inject({
    method: 'POST',
    url: f.url(ARC_AGENT, `limits/${created.permissionId}/revoke`),
    payload: {},
  });
  assert.equal(revoke.statusCode, 503);
  assert.deepEqual(revoke.json(), {
    error: 'Arc Testnet is not available right now.',
    code: 'network_unavailable',
  });
});

for (const [name, env] of [
  ["Arc's own manager", ARC_ON],
  ["Arc's manager at Base's address", ARC_SAME_MANAGER],
] as const) {
  test(`a limit signed for Base is refused on Arc (${name})`, async (t) => {
    const f = await setup(t, env);
    const prepared = await f.prepare(ARC_AGENT);
    const permission = permissionOf(prepared);
    const wallet = f.addresses[ARC_AGENT];
    const baseId = WALLET_CHAIN_ID as number;
    const send = async (typedData: Parameters<typeof f.owner.signTypedData>[0]) =>
      f.post(ARC_AGENT, 'limits', {
        permission: prepared.permission,
        capRaw: prepared.capRaw,
        period: prepared.period,
        signature: await f.owner.signTypedData(typedData),
      });
    const baseHash = spendPermissionHash(BASE_NET, permission);
    // Every way the owner's real key could have signed this very limit for Base.
    for (const typedData of [
      smartWalletMessageTypedData(baseId, wallet, baseHash),
      smartWalletMessageTypedData(baseId, wallet, prepared.permissionHash),
      smartWalletMessageTypedData(ARC_TESTNET, wallet, baseHash),
    ]) {
      const res = await send(typedData);
      assert.equal(res.statusCode, 422, res.body);
      assert.equal(res.json().code, 'signature_mismatch');
    }
    const none = await f.pg.query('SELECT 1 FROM base_spend_permissions');
    assert.equal(none.rows.length, 0);
    // The same key over Arc's own domain is what's accepted.
    assert.equal((await send(prepared.typedData)).statusCode, 201);
  });
}

test('a limit signed for Arc is refused on Base, and a permission of one chain on the other', async (t) => {
  const f = await setup(t, ARC_SAME_MANAGER);
  const prepared = await f.prepare(BASE_AGENT);
  const permission = permissionOf(prepared);
  const wallet = f.addresses[BASE_AGENT];
  const arcHash = spendPermissionHash(f.arc, permission);
  assert.notEqual(arcHash, prepared.permissionHash);
  const send = async (agent: string, signed: typeof prepared, typedData: never) =>
    f.post(agent, 'limits', {
      permission: signed.permission,
      capRaw: signed.capRaw,
      period: signed.period,
      signature: await f.owner.signTypedData(typedData),
    });
  for (const typedData of [
    smartWalletMessageTypedData(ARC_TESTNET, wallet, arcHash),
    smartWalletMessageTypedData(ARC_TESTNET, wallet, prepared.permissionHash),
    smartWalletMessageTypedData(WALLET_CHAIN_ID, wallet, arcHash),
  ]) {
    const res = await send(BASE_AGENT, prepared, typedData as never);
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(res.json().code, 'signature_mismatch');
  }
  // A whole limit prepared for Base, sent to the Arc agent, is not what Arc would build.
  const across = await send(ARC_AGENT, prepared, prepared.typedData as never);
  assert.equal(across.statusCode, 422);
  assert.equal(across.json().code, 'permission_mismatch');
  const arcPrepared = await f.prepare(ARC_AGENT);
  const back = await send(BASE_AGENT, arcPrepared, arcPrepared.typedData as never);
  assert.equal(back.statusCode, 422);
  assert.equal(back.json().code, 'permission_mismatch');
});

test('native gas is refused on Arc: no token field, and a permission naming it is not stored', async (t) => {
  const f = await setup(t);
  assert.equal(f.arc.tokens.ETH, undefined);
  assert.equal(allowedToken(f.arc, NATIVE_ETH), null);
  const named = await f.post(ARC_AGENT, 'limits/prepare', { ...CAP, token: NATIVE_ETH });
  assert.equal(named.statusCode, 400);
  assert.equal(named.json().code, 'invalid_limit');
  const prepared = await f.prepare(ARC_AGENT);
  const permission = { ...permissionOf(prepared), token: NATIVE_ETH as Address };
  const hash = spendPermissionHash(f.arc, permission);
  const res = await f.post(ARC_AGENT, 'limits', {
    permission: { ...prepared.permission, token: NATIVE_ETH },
    capRaw: prepared.capRaw,
    period: prepared.period,
    // Properly signed by the owner: the token alone is what's wrong.
    signature: await f.owner.signTypedData(
      smartWalletMessageTypedData(ARC_TESTNET, permission.account, hash),
    ),
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, 'permission_mismatch');
  assert.equal((await f.pg.query('SELECT 1 FROM base_spend_permissions')).rows.length, 0);
});

test("Arc: a revoke calls Arc's manager, on Arc's port, and needs the owner's signature for Arc", async (t) => {
  const f = await setup(t);
  const { prepared, created } = await storeLimit(f, ARC_AGENT);
  const permission = permissionOf(prepared);
  const path = `limits/${created.permissionId}/revoke`;
  const res = await f.post(ARC_AGENT, path, {});
  assert.equal(res.statusCode, 200, res.body);
  const request = res.json();
  assert.equal(request.chainId, ARC_TESTNET);
  assert.equal(request.summary.contract, ARC_SPM);
  assert.equal(f.arcOps.ops.prepared[0].calls[0].target, ARC_SPM);
  assert.deepEqual(f.baseOps.ops.prepared, []);
  assert.equal(f.asked.arcOperations[0], ARC_TESTNET);
  const wallet = f.addresses[ARC_AGENT];
  assert.equal(
    checkRevokeOperation(f.arc, request.userOperation, { wallet, permission }),
    request.userOpHash,
  );
  // The manager has the same address on both chains, so the call reads the same: what the owner
  // signs still differs, because the operation's hash names the chain.
  assert.notEqual(
    checkRevokeOperation(WALLET_CHAIN_ID as BaseChainId, request.userOperation, {
      wallet,
      permission,
    }),
    request.userOpHash,
  );
  // This very operation hashed for Base: the owner's real key, the wrong chain.
  const forBase = f.arcOps.hashOf(WALLET_CHAIN_ID, {
    sender: wallet,
    nonce: BigInt(request.userOperation.nonce),
    initCode: request.userOperation.initCode,
    callData: request.userOperation.callData,
    callGasLimit: BigInt(request.userOperation.callGasLimit),
    verificationGasLimit: BigInt(request.userOperation.verificationGasLimit),
    preVerificationGas: BigInt(request.userOperation.preVerificationGas),
    maxFeePerGas: BigInt(request.userOperation.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(request.userOperation.maxPriorityFeePerGas),
    paymasterAndData: request.userOperation.paymasterAndData,
    signature: '0x',
  });
  assert.notEqual(forBase, request.userOpHash);
  const wrong = await f.post(ARC_AGENT, `${path}/signature`, {
    signature: await f.owner.sign({ hash: forBase }),
  });
  assert.equal(wrong.statusCode, 422);
  assert.equal(wrong.json().code, 'signature_mismatch');
  assert.equal(f.arcOps.ops.submitted.length, 0);

  const signed = await f.post(ARC_AGENT, `${path}/signature`, {
    signature: await f.owner.sign({ hash: request.userOpHash as Hex }),
  });
  assert.equal(signed.statusCode, 202, signed.body);
  const [submitted] = f.arcOps.ops.submitted;
  assert.equal(submitted.calls[0].target, ARC_SPM);
  assert.deepEqual(f.baseOps.ops.submitted, []);

  // Revoked only once Arc shows it, read through Arc.
  f.arcReads.state.revoked.add(permission.salt.toString(10));
  const view = (await f.app.inject({ url: f.url(ARC_AGENT) })).json();
  assert.equal(view.limits[0].state, 'revoked');
  const { rows } = await f.pg.query<{ state: string; revoked_block: string }>(
    'SELECT state, revoked_block FROM base_spend_permissions',
  );
  assert.equal(rows[0].state, 'revoked');
  assert.equal(Number(rows[0].revoked_block), 77);
});

test('Arc on: a Base agent is what it was, on Base only', async (t) => {
  const on = await setup(t);
  const off = await setup(t, ARC_OFF);
  const shape = (body: Record<string, unknown>) => Object.keys(body);
  const withArc = await on.prepare(BASE_AGENT);
  const without = await off.prepare(BASE_AGENT);
  assert.deepEqual(shape(withArc), shape(without));
  assert.equal(withArc.chainId, without.chainId);
  assert.equal(withArc.permission.token, without.permission.token);
  assert.equal(withArc.permissionHash, spendPermissionHash(BASE_NET, permissionOf(withArc)));
  const { created } = await storeLimit(on, BASE_AGENT);
  const view = (await on.app.inject({ url: on.url(BASE_AGENT) })).json();
  assert.equal(view.chainId, WALLET_CHAIN_ID);
  assert.ok(on.baseReads.state.reads > 0);
  const revoke = await on.post(BASE_AGENT, `limits/${created.permissionId}/revoke`, {});
  assert.equal(revoke.statusCode, 200, revoke.body);
  assert.equal(revoke.json().summary.contract, BASE_SPM);
  assert.equal(on.baseOps.ops.prepared[0].calls[0].target, BASE_SPM);
  assert.deepEqual(on.asked, { arcReaders: [], arcOperations: [] });
  assert.equal(on.arcReads.state.reads, 0);
  const consent = await on.app.inject({ url: on.url(BASE_AGENT, 'agent-pay') });
  assert.equal(consent.json().chainId, WALLET_CHAIN_ID);
  assert.equal(consent.json().signing.token, BASE_NET.tokens.USDC.address);
});

test('what follows the chain is named one by one; ratings need the operations of Arc', async (t) => {
  const f = await setup(t);
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
    // Without Arc's pay chain and owner operations in this fixture, ratings have nothing to run on.
    assert.equal(res.statusCode, 409, path);
    assert.equal(res.json().code, 'not_on_arc_yet', path);
  }
  const prefix = '/api/base/agents/:agentId/wallet';
  for (const lifted of [
    'limits',
    'limits/prepare',
    'limits/:permissionId/revoke',
    'limits/:permissionId/revoke/signature',
    'agent-pay',
    'withdrawals',
    'withdrawals/:withdrawalId',
    'withdrawals/:withdrawalId/signature',
    'withdrawals/:withdrawalId/cancel',
    'withdrawals/:withdrawalId/cancel/signature',
    'payments',
    'agent-payments',
  ])
    assert.equal(followsAgentChain(`${prefix}/${lifted}`), true, lifted);
  for (const refused of [
    'limits-other',
    'withdrawals-other',
    'payments/other',
    'agent-payments/other',
    'ratings',
    'ratings/status',
  ])
    assert.equal(followsAgentChain(`${prefix}/${refused}`), false, refused);
});

test("someone else asking for an Arc agent's limit or consent gets 404, with a well-formed request", async (t) => {
  const f = await setup(t);
  const { prepared, created } = await storeLimit(f, ARC_AGENT);
  const as = { 'x-test-person': 'person-2' };
  const answers = [
    await f.app.inject({ url: f.url(ARC_AGENT), headers: as }),
    await f.post(ARC_AGENT, 'limits/prepare', CAP, 'person-2'),
    await f.post(
      ARC_AGENT,
      'limits',
      {
        permission: prepared.permission,
        capRaw: prepared.capRaw,
        period: prepared.period,
        signature: await f.owner.signTypedData(prepared.typedData),
      },
      'person-2',
    ),
    await f.post(ARC_AGENT, `limits/${created.permissionId}/revoke`, {}, 'person-2'),
    await f.app.inject({ url: f.url(ARC_AGENT, 'agent-pay'), headers: as }),
    await f.app.inject({ method: 'DELETE', url: f.url(ARC_AGENT, 'agent-pay'), headers: as }),
  ];
  for (const answer of answers) {
    // As a Base agent's answer: nothing here says which chain the agent is on.
    assert.equal(answer.statusCode, 404, answer.body);
    assert.deepEqual(answer.json(), { error: 'Not found.', code: 'not_found' });
  }
});

test('Arc mainnet stays refused while Arc is off (CITY_ARC unset): limits and consent, nothing read', async (t) => {
  const f = await setup(t);
  await f.pg.query('UPDATE base_wallets SET chain_id = $1 WHERE wallet_id = $2', [
    ARC_MAINNET,
    'w-arc',
  ]);
  const app = Fastify();
  t.after(() => app.close());
  const asked: number[] = [];
  const env = { ...ARC_ON, CITY_ARC: '', CITY_ARC_CHAIN_ID: String(ARC_MAINNET) };
  registerBaseWalletRoutes(app, {
    db: f.db,
    env,
    log: () => {},
    currentPerson: async () => ({ id: 'person-1' }),
    currentWorkspace: async () => ({ id: 'person-1' }),
    runtime: async () => ({}) as ChainRuntime,
    arcPermissions: (chainId) => {
      asked.push(chainId);
      return undefined;
    },
    now: () => NOW,
  });
  for (const path of ['limits', 'agent-pay']) {
    const res = await app.inject({ url: f.url(ARC_AGENT, path) });
    // Arc off: the agent's chain isn't served at all, as for any Arc agent then.
    assert.equal(res.statusCode, 404, path);
    assert.equal(res.json().code, 'not_found', path);
  }
  assert.deepEqual(asked, []);
});

/** The owner's signed consent body; `chainId` is the chain it's signed for. */
async function consentBody(
  f: Fixture,
  input: { chainId: number; wallet: Address; token: string; hash: string; recipients?: string },
) {
  const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`;
  const issuedAt = NOW;
  const recipients = input.recipients ?? 'central-city-agents';
  const signature = await f.owner.signTypedData(
    agentPayConsentTypedData({
      chainId: input.chainId,
      wallet: input.wallet,
      token: input.token,
      permissionHash: input.hash,
      recipients,
      nonce,
      issuedAt,
    }),
  );
  return {
    permissionHash: input.hash,
    ...(input.recipients ? { recipients } : {}),
    signature,
    nonce,
    issuedAt,
  };
}

test('consent on Arc: bound to Arc, signed for Arc; one signed for Base is refused', async (t) => {
  const f = await setup(t);
  const { prepared } = await storeLimit(f, ARC_AGENT);
  const put = (body: unknown) =>
    f.app.inject({ method: 'PUT', url: f.url(ARC_AGENT, 'agent-pay'), payload: body as object });
  const wallet = f.addresses[ARC_AGENT];
  const hash = prepared.permissionHash;

  const seen = (await f.app.inject({ url: f.url(ARC_AGENT, 'agent-pay') })).json();
  assert.equal(seen.chainId, ARC_TESTNET);
  assert.equal(seen.signing.token, ARC_USDC);
  assert.equal(seen.signing.wallet, wallet);
  assert.equal(seen.scope.withinLimit.capDisplay, '20');
  assert.equal(seen.mayPay, false);

  // The owner's real key, the same message, but Base's chain id in the domain.
  const forBase = await put(
    await consentBody(f, { chainId: WALLET_CHAIN_ID, wallet, token: ARC_USDC, hash }),
  );
  assert.equal(forBase.statusCode, 422, forBase.body);
  assert.equal(forBase.json().code, 'signature_mismatch');
  // Signed for Arc, naming Base's USDC.
  const baseToken = await put(
    await consentBody(f, {
      chainId: ARC_TESTNET,
      wallet,
      token: BASE_NET.tokens.USDC.address,
      hash,
    }),
  );
  assert.equal(baseToken.json().code, 'signature_mismatch');

  const given = await put(
    await consentBody(f, { chainId: ARC_TESTNET, wallet, token: ARC_USDC, hash }),
  );
  assert.equal(given.statusCode, 200, given.body);
  assert.equal(given.json().mayPay, true);
  const { rows } = await f.pg.query<{ chain_id: number; token: string; wallet_id: string }>(
    'SELECT chain_id, token, wallet_id FROM base_agent_pay_consents',
  );
  assert.deepEqual(rows, [
    { chain_id: ARC_TESTNET, token: ARC_USDC.toLowerCase(), wallet_id: 'w-arc' },
  ]);

  // The check agent payments run: only for this chain.
  const { rows: limits } = await f.pg.query<{ permission_id: string }>(
    'SELECT permission_id FROM base_spend_permissions',
  );
  const check = (chainId: number) =>
    assertAgentPayConsent(f.db, {
      chainId,
      walletId: 'w-arc',
      token: ARC_USDC,
      permissionId: limits[0].permission_id,
      permissionHash: hash,
      recipient: 'central-city-agent',
    });
  await check(ARC_TESTNET);
  await assert.rejects(check(WALLET_CHAIN_ID), AgentPayConsentError);

  const gone = await f.app.inject({ method: 'DELETE', url: f.url(ARC_AGENT, 'agent-pay') });
  assert.equal(gone.statusCode, 200);
  assert.equal(gone.json().mayPay, false);
  await assert.rejects(check(ARC_TESTNET), AgentPayConsentError);
});

test('consent offers Feed services on Arc too, with Feed pay on, and on Base as before', async (t) => {
  const f = await setup(t, { ...ARC_ON, CITY_FEED_PAY: '1' });
  await storeLimit(f, ARC_AGENT);
  const seen = (await f.app.inject({ url: f.url(ARC_AGENT, 'agent-pay') })).json();
  assert.equal(seen.confirmRecipients, 'central-city-agents-and-feed-services');
  const onBase = (await f.app.inject({ url: f.url(BASE_AGENT, 'agent-pay') })).json();
  assert.equal(onBase.confirmRecipients, 'central-city-agents-and-feed-services');
});

const COMPLETE_ARC = {
  ...ARC_ON,
  CITY_ARC_RPC_URL: 'https://arc.invalid/rpc',
  CITY_ARC_MAX_FEE_PER_GAS_WEI: '100000000000',
  CITY_ARC_PAYMASTER: ARC_PAYMASTER,
};
const fakeBundler = {} as Bundler;
const refusedFor = (setting: string) => (error: unknown) =>
  error instanceof ChainRuntimeError && error.setting === setting;

test("the revoke port on Arc reads Arc's settings only, and takes no bundler from its RPC", () => {
  const db = {} as Database;
  const port = ownerRevokePortFromEnv(db, COMPLETE_ARC, ARC_TESTNET, { bundler: fakeBundler });
  assert.equal(port.chainId, ARC_TESTNET);
  assert.throws(
    () => ownerRevokePortFromEnv(db, COMPLETE_ARC, ARC_TESTNET),
    refusedFor('CITY_ARC_PAYMASTER'),
  );
  // Base's values are no stand-ins.
  const baseOnly = {
    ...ARC_ON,
    CITY_BASE_CDP_SEPOLIA_RPC_URL: 'https://base.invalid/key',
    CITY_BASE_CDP_RPC_URL: 'https://base.invalid/key',
    CITY_BASE_MAX_FEE_PER_GAS_WEI: '100000000000',
    CITY_ARC_RPC_URL: '',
  };
  assert.throws(
    () => ownerRevokePortFromEnv(db, baseOnly, ARC_TESTNET, { bundler: fakeBundler }),
    refusedFor('CITY_ARC_RPC_URL'),
  );
  assert.throws(
    () =>
      ownerRevokePortFromEnv(
        db,
        {
          ...COMPLETE_ARC,
          CITY_ARC_MAX_FEE_PER_GAS_WEI: '',
          CITY_BASE_MAX_FEE_PER_GAS_WEI: '100000000000',
        },
        ARC_TESTNET,
        { bundler: fakeBundler },
      ),
    refusedFor('CITY_ARC_MAX_FEE_PER_GAS_WEI'),
  );
  // A cap under Arc's fee floor would have every transaction dropped.
  assert.throws(
    () =>
      ownerRevokePortFromEnv(
        db,
        { ...COMPLETE_ARC, CITY_ARC_MAX_FEE_PER_GAS_WEI: '1000' },
        ARC_TESTNET,
        { bundler: fakeBundler },
      ),
    refusedFor('CITY_ARC_MAX_FEE_PER_GAS_WEI'),
  );
  assert.throws(
    () =>
      ownerRevokePortFromEnv(
        db,
        { ...COMPLETE_ARC, CITY_ARC_WALLET_FEE_CAP_WEI: '1.5', CITY_BASE_WALLET_FEE_CAP_WEI: '9' },
        ARC_TESTNET,
        { bundler: fakeBundler },
      ),
    refusedFor('CITY_ARC_WALLET_FEE_CAP_WEI'),
  );
  // Mainnet: off while Arc is off; on, a real-money chain takes no port without its fee cap.
  assert.throws(
    () =>
      ownerRevokePortFromEnv(db, { ...COMPLETE_ARC, CITY_ARC: '' }, ARC_MAINNET, {
        bundler: fakeBundler,
      }),
    refusedFor('network'),
  );
  assert.throws(
    () => ownerRevokePortFromEnv(db, COMPLETE_ARC, ARC_MAINNET, { bundler: fakeBundler }),
    refusedFor('CITY_ARC_WALLET_FEE_CAP_WEI'),
  );
  assert.throws(
    () =>
      ownerRevokePortFromEnv(db, { ...COMPLETE_ARC, CITY_ARC: '' }, ARC_TESTNET, {
        bundler: fakeBundler,
      }),
    refusedFor('network'),
  );
});

test("the revoke port on Arc takes Arc's configured sponsor and no other", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const network = networkOf(ARC_ON);
  const recipe = agentWalletRecipe(network, owner.address, 7n);
  const paymasterData = (paymaster: string) =>
    `0x${paymaster.slice(2)}${'00'.repeat(109)}${'ab'.repeat(65)}` as Hex;
  const submit = (paymaster: string) =>
    ownerRevokePortFromEnv({} as Database, COMPLETE_ARC, ARC_TESTNET, {
      bundler: fakeBundler,
    }).submit({
      idempotencyKey: 'k',
      intentHash: `0x${'1'.repeat(64)}`,
      wallet: deriveAddressLocal(recipe),
      recipe,
      calls: [],
      operation: {
        sender: deriveAddressLocal(recipe),
        nonce: 1n,
        initCode: '0x',
        callData: '0x',
        callGasLimit: 1n,
        verificationGasLimit: 1n,
        preVerificationGas: 1n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        paymasterAndData: paymasterData(paymaster),
        signature: '0x',
      },
      // A hash that isn't this operation's: it stops right after the sponsor check, before any read.
      userOpHash: `0x${'2'.repeat(64)}`,
      owner: owner.address,
      signature: `0x${'3'.repeat(130)}`,
    });
  const code = (error: unknown) => (error as OwnerRevokeError).code;
  await assert.rejects(submit(`0x${'7a'.repeat(20)}`), (e) => code(e) === 'NOT_SPONSORED');
  // Base's pinned sponsor isn't Arc's.
  await assert.rejects(
    submit('0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c'),
    (e) => code(e) === 'NOT_SPONSORED',
  );
  await assert.rejects(submit(ARC_PAYMASTER), (e) => code(e) === 'SIGNATURE_MISMATCH');
});

async function rpcNode(
  t: { after: (fn: () => Promise<unknown>) => void },
  answer: () => { status: number; result?: string },
) {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      calls.push(method);
      const { status, result } = answer();
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('arcPermissionReader: Arc only, with its endpoint; a node on another chain is refused', async (t) => {
  const url = 'https://arc.example';
  const withUrl = { ...ARC_ON, CITY_ARC_RPC_URL: url };
  assert.equal(arcPermissionReader(WALLET_CHAIN_ID, withUrl), undefined);
  assert.equal(arcPermissionReader(ARC_TESTNET, { ...withUrl, CITY_ARC: '' }), undefined);
  assert.equal(arcPermissionReader(ARC_TESTNET, ARC_ON), undefined);
  assert.equal(
    arcPermissionReader(ARC_TESTNET, { ...ARC_ON, CITY_BASE_CDP_RPC_URL: url }),
    undefined,
  );
  assert.equal(arcPermissionReader(ARC_MAINNET, { ...withUrl, CITY_ARC: '' }), undefined);
  assert.equal(arcPermissionReader(ARC_MAINNET, ARC_ON), undefined);
  assert.equal(arcPermissionReader(1, withUrl), undefined);
  // Mainnet's manager is recorded in the code: on, with its endpoint, it reads.
  assert.ok(arcPermissionReader(ARC_MAINNET, withUrl));
  assert.ok(arcPermissionReader(ARC_TESTNET, withUrl));
  const wrong = await rpcNode(t, () => ({ status: 200, result: '0x2105' }));
  const down = await rpcNode(t, () => ({ status: 500 }));
  const baseFallback = await rpcNode(t, () => ({ status: 200, result: '0x2105' }));
  const wallet = getAddress(`0x${'1'.repeat(40)}`);
  const onWrong = arcPermissionReader(ARC_TESTNET, {
    ...ARC_ON,
    CITY_ARC_RPC_URL: wrong.url,
  }) as PermissionReader;
  await assert.rejects(onWrong.deployed(wallet), /expected network/);
  const onDown = arcPermissionReader(ARC_TESTNET, {
    ...ARC_ON,
    CITY_ARC_RPC_URL: down.url,
    CITY_BASE_READ_FALLBACK_RPC_URL: baseFallback.url,
  }) as PermissionReader;
  await assert.rejects(onDown.deployed(wallet));
  assert.ok(down.calls.length > 0);
  assert.deepEqual(baseFallback.calls, []);
});
